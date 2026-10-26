# 아키텍처와 프로토콜

## 1. 구성 요소와 책임

| 구성 | 맡는 일 | 맡지 않는 일 |
|---|---|---|
| gjc (`gjc --mode=acp`) | 모델 호출, 도구 실행, 세션 저장(`~/.gjc/agent/sessions`), 구독 인증 | 네트워크 노출, 기기 인증 |
| 브리지 (`bridge/`) | 기기 페어링·인증, 암호화 채널, ACP 프로세스 하나를 여러 기기·세션에 다중화, 첨부 업로드, 저장된 세션 목록 | 모델·도구 실행 |
| 앱 (`ios/`, `android/`) | 페어링, 세션 목록, 대화 표시, 승인 응답, 설정 변경 | 실행·저장(기기에는 키와 호스트 목록만) |

브리지는 ACP(Agent Client Protocol) 클라이언트이면서 앱 쪽 서버입니다. ACP 표준에 없는 기능(대기열 조회, 추론 강도 즉시 변경, 서비스 등급 등)은 gjc 확장 `_gjc/sdk/query`·`_gjc/sdk/control`을 허용 목록(`src/hub.ts`의 `SDK_QUERIES`/`SDK_CONTROLS`)으로 제한해 씁니다.

## 2. 페어링

1. 호스트에서 `gjcm-bridge pair`를 실행하면 페어링 코드를 만들고 아래 오퍼를 QR과 링크로 보여 줍니다.
2. 링크 형식은 `gjcm://pair?o=<base64url(JSON)>`입니다.

```json
{ "v": 1, "hostId": "…", "name": "호스트 이름", "hostKey": "<X25519 공개키 base64url>",
  "endpoints": ["ws://100.x.y.z:7787/ws", "ws://host.ts.net:7787/ws"],
  "pairingId": "…", "secret": "<32바이트 base64url>", "exp": "ISO-8601" }
```

- `hostKey`가 오퍼에 들어 있으므로 앱은 첫 연결부터 호스트를 인증합니다(중간자 차단).
- 코드는 기본 10분, 1회용입니다(`--ttl-min`). `--reusable`은 데모 호스트 전용이며 여러 기기가 같은 코드를 씁니다.
- 앱은 `endpoints`를 순서대로 시도하고, 마지막으로 성공한 주소를 다음 연결 때 맨 앞에 둡니다.
- 기기 해제는 `gjcm-bridge revoke <id>`이며, 해당 기기의 다음 프레임에서 연결이 닫힙니다(`4403 device_revoked`).

## 3. 암호화 채널 `gjcm-e2ee-v1`

정본 구현은 `bridge/src/crypto.ts`이고, Swift(`ios/Core/Sources/GjcMobileCore/E2EE.swift`)와 Kotlin(`android/.../core/E2EE.kt`)이 같은 동작을 합니다. 세 구현 모두 `fixtures/e2ee-vector.json`을 바이트 단위로 재현하는 테스트를 가지고 있습니다.

### 핸드셰이크 (평문 1왕복)

| 방향 | 메시지 |
|---|---|
| 앱 → 브리지 | `{t:"hello", v:1, deviceKey: D_pub, eph: Ec_pub, nonce: Nc, name, pairing?: {id, proof}}` |
| 브리지 → 앱 | `{t:"welcome", eph: Es_pub, nonce: Ns, …}` 또는 `{t:"error", code, message}` |

- `D`는 기기의 장기 X25519 키(키체인·Keystore 보관), `H`는 호스트 장기 키, `Ec`·`Es`는 연결마다 새로 만드는 임시 키입니다.
- 첫 페어링 때는 `proof = HMAC-SHA256(secret, "gjcm-pair-v1" ‖ D_pub ‖ Ec_pub)`를 보냅니다. 비밀값 자체는 전송하지 않습니다.
- 오류 코드: `pairing_invalid`(코드 무효·사용됨·만료), `unknown_device`(페어링되지 않은 기기).

### 키 유도

```
ikm  = DH(Es, Ec) ‖ DH(H, Ec) ‖ DH(H, D)
keys = HKDF-SHA256(ikm, salt = Nc ‖ Ns, info = "gjcm-e2ee-v1" ‖ D_pub ‖ H_pub ‖ Ec_pub ‖ Es_pub, 64바이트)
       [0,32) 앱→브리지, [32,64) 브리지→앱
```

`H`를 가진 브리지와 `D`를 가진 기기만 같은 키를 얻으므로, 양쪽이 처음 복호화에 성공한 프레임이 곧 키 확인이 됩니다. 임시 키를 섞으므로 연결마다 키가 달라집니다(전방 안전성).

### 프레임

```
8바이트 big-endian 카운터 ‖ AES-256-GCM 암호문 ‖ 16바이트 태그
GCM nonce = 0x00000000 ‖ 카운터,  AAD = "gjcm1"
```

카운터는 방향별로 0에서 시작해 엄격히 증가해야 하며, 재전송이나 순서 뒤바뀜은 거부합니다.

### RPC 봉투 (암호문 안의 JSON)

| 종류 | 형식 |
|---|---|
| 요청 | `{id: number, m: "session.prompt", p: {...}}` |
| 응답 | `{id, r: 결과}` 또는 `{id, e: {code, message, data?}}` |
| 이벤트 | `{ev: "session.update", p: {...}}` |

메서드와 이벤트 목록, 오류 코드는 [`bridge/README.md`](../bridge/README.md#rpc)에 있습니다. 메시지 최대 크기는 32MB입니다.

## 4. 세션 흐름

1. `session.new{cwd}` → gjc ACP `session/new`. 실측 약 12초가 걸려 앱은 첫 메시지와 함께 생성합니다.
2. `session.prompt`는 수락 즉시 응답하고 진행 상황은 `session.update` 이벤트로 흘러옵니다. 턴 종료는 브리지가 붙이는 `x_gjcm_turn_end`로 알립니다.
3. 작업 중 메시지는 `turn.steer`(다음 모델 단계에 주입) 또는 `turn.follow_up`(턴 종료 후 전송)으로 보냅니다.
4. **끼어들기**(`session.interrupt`): 대기열 조회 → `session/cancel` → 남은 지시 제거 → 같은 텍스트로 새 `session/prompt`. 실측 응답 196ms.
   - 취소보다 턴이 먼저 단계 경계에 닿으면 gjc가 그 지시를 스스로 모델에 넘깁니다. 그 경우 취소 뒤 사용자 메시지로 나타난 지시는 다시 보내지 않습니다. 실측(2026-10-26, TUI 턴)에서 같은 지시가 두 번 전달되던 문제를 막습니다.
   - 앱의 '전달 대기' 표시와 끼어들기 버튼은 `session.status.queued`(gjc 대기열, 1초마다)를 따릅니다. 그래서 TUI에서 넣은 steer도 보입니다. 도구 실행 중의 steer는 gjc가 도구를 백그라운드로 접고 곧바로 전달하므로(실측 약 4초) 대기열에 잠깐만 머뭅니다.
   - 터미널에서 시작한 턴은 앱에서 끼어들 수 없습니다. gjc는 턴을 시작한 연결에만 중단을 허용합니다. 실측: `session/cancel` 무효, `turn.abort`는 `no_active_turn`, terminal 모드는 `terminal_no_effect`, operator 모드는 Broker 경로 전용입니다. 그래서 브리지는 이런 턴을 바로 거절하고(-32004 `host_turn`), 지시는 대기열에 남아 턴의 다음 단계에서 전달됩니다.
5. 연결이 끊겼다가 돌아오면 앱은 열려 있던 세션을 `session.open{afterSeq}`로 다시 열어 놓친 업데이트만 받습니다.
6. 터미널(TUI)에서 진행 중인 턴도 실시간으로 보입니다. 사용자가 입력한 지시, 도구 호출(bash 등)과 그 출력, 답변이 `session.update`로 흘러옵니다. gjc 로컬 패치 `0005-acp-mirror-terminal-turns.patch`가 이를 추가합니다.
   - 세션 호스트는 턴 내용을 그 턴을 보낸 연결과 관찰자(observer) 연결에만 보냅니다. 패치 전 ACP는 둘 다 아니어서 앱에는 working/idle만 보였습니다.
   - ACP를 관찰자로 만들면 안 됩니다. 분리된 세션 호스트는 관찰자만 붙어 있으면 스스로 종료하므로 앱이 연 세션이 사라집니다. 그래서 패치는 별도 능력 `turn_stream_mirror_v1`을 추가합니다.
   - 호스트 쪽 코드가 필요하므로 패치보다 먼저 시작된 터미널 세션은 그 gjc를 다시 시작해야 보입니다. 실측(2026-10-25): 패치 적용 시 사용자 입력 0.9초, 도구 호출·출력·답변이 실시간 도착. 미적용 대조군은 `session_info_update`만 도착.
7. 추론은 `agent_thought_chunk`로 와서 "추론" 블록으로 보입니다. Anthropic 요약 추론과 OpenAI Responses 추론 요약은 `thinking_delta`가 아니라 `reasoning_summary_*` 이벤트로 오는데, 상류 ACP 매퍼는 이를 버려 앱에 추론이 한 줄도 오지 않았습니다(실측 2026-10-26, opus-5-5 medium: `agent_message_chunk` 56개, `agent_thought_chunk` 0개). gjc 로컬 패치 `0006-acp-reasoning-summary-thoughts.patch`가 요약 델타를 추론 청크로 보내고, 델타 없이 끝에만 오는 요약은 한 번만 보냅니다.

## 5. 설계 결정과 근거

| 결정 | 근거 (실측) |
|---|---|
| 앱 계층 E2EE + `ws://` 허용 | 호스트가 인증서 없는 LAN·Tailscale IP에 있으므로 TLS를 강제할 수 없습니다. 암호화를 앱 계층에 두면 경로(ws·wss·Funnel)와 무관하게 같은 보장이 성립합니다. |
| 추론 강도 변경은 SDK `thinking.set` | gjc `session/set_config_option`은 모델 카탈로그(약 1,080개)를 세 번 다시 만들어 4.1초가 걸렸고, `thinking.set`은 13~24ms였습니다. 모델 변경은 선택지가 모델에 따라 바뀌므로 느린 경로를 유지합니다. |
| 끼어들기를 브리지에서 조립 | gjc `turn.abort`는 ACP에서 `uncertain_after_send`를 내고 약 80초 멈췄고, `turn.abort_and_prompt`는 출력이 없었으며, 단순 취소는 대기 지시를 잃었습니다. |
| 세션 목록은 저장된 트랜스크립트에서 생성 | ACP `session/list`는 저장된 859개 중 837개가 빠져 있었습니다. |
| **iOS는 Swift 유지, Android는 Kotlin으로 별도 구현** | 아래 표 참고 |

### Swift 유지 vs 공통 코드 재작성 (2026-10-23 결정)

| 선택 | 결과 |
|---|---|
| Swift 유지 + Kotlin 별도 (채택) | iOS 검증 상태를 그대로 유지합니다. 프로토콜 호환은 공용 테스트 벡터가 고정합니다. 대가는 화면 기능을 두 번 작성하는 것입니다. |
| Kotlin Multiplatform으로 코어 공유 | 공유할 코어가 Kotlin 기준 약 1,090줄에 불과합니다. 이 호스트는 Swift를 빌드할 수 없어 iOS 쪽 검증이 CI로만 가능해지고, 화면(SwiftUI 3,136줄)은 여전히 따로 작성해야 합니다. |
| Compose Multiplatform·Flutter로 전체 재작성 | 검증된 iOS 앱을 버리고 두 스토어 심사를 처음부터 다시 받아야 하며 iOS 사용감이 떨어집니다. |

양쪽 화면 기능이 손으로 맞추기 어려울 만큼 빠르게 늘어나면 Compose Multiplatform을 다시 검토합니다.

## 6. 검증 수단

| 대상 | 방법 |
|---|---|
| 브리지 | `cd bridge && bun test` (가짜 ACP 에이전트, 데모 에이전트 포함), 실제 gjc 대상 `test/e2e-gjc.test.ts` |
| iOS 코어 | `swift test` (CI macos-15): 테스트 벡터, 트랜스크립트, 실제 브리지 대상 라이브 테스트 |
| Android 코어 | `./gradlew :app:testDebugUnitTest`: 테스트 벡터, 오퍼 파싱, 메모리 내 브리지 대상 클라이언트, 트랜스크립트 |
| 화면 | iOS는 실기기, Android는 에뮬레이터와 데모 호스트로 확인 |
