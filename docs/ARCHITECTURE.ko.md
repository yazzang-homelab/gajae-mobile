# 아키텍처와 프로토콜

## 1. 구성 요소와 책임

| 구성 | 맡는 일 | 맡지 않는 일 |
|---|---|---|
| gjc (`gjc --mode=acp`) | 모델 호출, 도구 실행, 세션 저장(`~/.gjc/agent/sessions`), 구독 인증 | 네트워크 노출, 기기 인증 |
| 브리지 (`bridge/`) | 기기 페어링·인증, 암호화 채널, ACP 프로세스 하나를 여러 기기·세션에 다중화, 첨부 업로드, 저장된 세션 목록 | 모델·도구 실행 |
| 앱 (`ios/`, `android/`) | 페어링, 세션 목록, 대화 표시, 승인 응답, 설정 변경 | 실행·저장(기기에는 키와 호스트 목록만) |

브리지는 ACP(Agent Client Protocol) 클라이언트이면서 앱 쪽 서버입니다. ACP 표준에 없는 기능(대기열 조회, 추론 강도 즉시 변경, 서비스 등급 등)은 gjc 확장 `_gjc/sdk/query`·`_gjc/sdk/control`을 허용 목록(`src/hub.ts`의 `SDK_QUERIES`/`SDK_CONTROLS`)으로 제한해 씁니다.

## 2. 페어링

1. 호스트에서 `gjcm-bridge pair`를 실행하면 페어링을 하나 만들고, 사람이 입력하는 **기기 코드**(2.1)와 아래 오퍼의 QR·링크를 함께 보여 줍니다. 코드와 QR은 같은 페어링이라 어느 쪽으로든 한 번 페어링하면 둘 다 소멸합니다.
2. 링크 형식은 `gjcm://pair?o=<base64url(JSON)>`입니다.

```json
{ "v": 1, "hostId": "…", "name": "호스트 이름", "hostKey": "<X25519 공개키 base64url>",
  "endpoints": ["ws://100.x.y.z:7787/ws", "ws://host.ts.net:7787/ws"],
  "pairingId": "…", "secret": "<32바이트 base64url>", "exp": "ISO-8601" }
```

- `hostKey`가 오퍼에 들어 있으므로 앱은 첫 연결부터 호스트를 인증합니다(중간자 차단).
- 페어링은 기본 15분, 1회용입니다(`--ttl-min`). `--reusable`은 데모 호스트 전용이며 여러 기기가 같은 QR을 씁니다(기기 코드는 만들지 않습니다).
- 앱은 `endpoints`를 순서대로 시도하고, 마지막으로 성공한 주소를 다음 연결 때 맨 앞에 둡니다.
- 기기 해제는 `gjcm-bridge revoke <id>`이며, 그 기기와 오가는 다음 프레임 전에 연결이 닫힙니다(`4403 device_revoked`). 해제 뒤에는 그 기기로 어떤 이벤트도 나가지 않습니다. 아무것도 오가지 않는 연결은 다음 전송 때까지 열려 있을 수 있습니다.

### 2.1 기기 코드 `gjcm-code-v1` (#128)

QR을 찍지 않고 9~14자 코드를 입력해 페어링합니다. 만남 서버 없이 코드가 브리지 주소를 직접 담습니다.

**형식.** 알파벳 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`(0·O·1·I 없음), 5비트/자, 4자 묶음으로 표시합니다(`K7M2-9QXD-HP`).

```
type(4) ‖ addr ‖ [port(16)] ‖ secret(20) ‖ check(k ≥ 4)
type 상위 1비트 = 포트 명시(없으면 7787), 하위 3비트 = 대역
  001 Tailscale 100.64/10 (22비트)  010 10/8 (24)  011 172.16/12 (20)  100 192.168/16 (16)  나머지 예약
check = SHA-256("gjcm-code-v1" ‖ m ‖ 앞 m비트)의 상위 k비트 (오타 검출용, 공개 함수)
```

길이는 기본 포트일 때 10·11·10·9자, 포트 명시일 때 14·14·13·12자입니다. 포트 0과 포트를 명시한 7787(더 짧은 정규 코드가 있음)은 비트와 check가 맞아도 `code_format`으로 거부합니다. `ws://<위 대역 IPv4>[:포트]/ws`만 담을 수 있고, wss·도메인·IPv6 주소이면 `pair`는 이유를 한 줄로 알리고 QR만 보여 줍니다. 코드 주소는 엔드포인트 중 앞에서부터 첫 번째로 담을 수 있는 주소이고, `--code-lan`은 Tailscale 대역을 건너뜁니다.

**PAKE.** `CPACE-X25519-SHA512`([draft-irtf-cfrg-cpace-21](https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt) 고정). PRS = 정규화한 코드(대문자, 하이픈 없음), CI = `"gjcm-code-v1"`, 앱 = initiator, 브리지 = responder, AD는 비웁니다. 20비트 비밀이라도 오프라인 대입이 불가능하고, 온라인 시도는 코드당 5회로 묶입니다.

| 방향 | 메시지 (`/ws`의 첫 텍스트 프레임이 `pake`이면 이 흐름) |
|---|---|
| 앱 → 브리지 | `{t:"pake", v:1, sid: 16바이트, ya: Ya}` |
| 브리지 → 앱 | `{t:"pake.reply", yb: Yb, left}` (시도 1회를 이 시점에 차감) |
| 앱 → 브리지 | `{t:"pake.confirm", ta: Ta}` |
| 브리지 → 앱 | `{t:"pake.ok", tb: Tb, box}` 후 닫음 — Ta를 검증한 뒤에만 보냄 |

```
ISK     = SHA-512(lv_cat("CPace255_ISK", sid, K) ‖ lv_cat(Ya, "") ‖ lv_cat(Yb, ""))
mac_key = SHA-512("CPaceMac" ‖ sid ‖ ISK);  Ta/Tb = HMAC-SHA512(mac_key, lv_cat(Y, ""))
kSeal   = HKDF-SHA256(ISK, salt "", info "gjcm-code-v1 seal", 32)
box     = AES-256-GCM(kSeal, nonce 0×12, AAD "gjcm-code-v1", 오퍼 JSON)
```

- `pake.ok` 때 브리지는 코드를 지우고 그 페어링의 `secret`을 새 값으로 바꾼 뒤, 바뀐 secret이 든 오퍼를 봉인합니다. 그래서 코드를 쓰면 화면의 QR은 곧바로 `pairing_invalid`가 되고, QR을 먼저 쓰면 코드는 `code_expired`가 됩니다.
- 앱은 Tb를 확인하고 box를 연 뒤 키 변경 확인(KEY_CHANGED)을 거쳐 기존 hello(`pairing.proof`)로 등록합니다. 앱은 오퍼의 `exp`를 폰 시계로 검사하지 않습니다.
- 브리지는 연결마다 새 yb를 뽑고(같은 sid·Ya를 다시 보내도 ISK가 달라짐), kSeal로는 한 번만 봉인합니다. 그래서 고정 nonce가 반복되지 않습니다.
- 활성 코드는 호스트당 하나입니다. 코드를 만든 새 `pair`는 이전 코드를 없앱니다(이전 QR은 유지). 코드를 만들지 못하고 QR만 보여 준 `pair`는 이전 코드를 그대로 둡니다. 동시에 진행하는 코드 세션은 브리지당 하나입니다.
- 브리지는 활성 코드 하나만 알기 때문에, 새 `pair`로 대체된 이전 코드를 입력하면 `code_expired`가 아니라 `code_wrong`이 나가고 활성 코드의 시도 1회가 줄어듭니다. 세션 전에 둘을 구별하려면 코드 식별자를 보내야 하는데, 그러면 비밀 비트가 샙니다. `code_expired`는 세션 시작 때 활성 코드가 없거나 만료된 경우, 그리고 세션 도중 코드가 쓰이거나 새 `pair`로 바뀐 경우(`pake.confirm` 때 다시 확인)에 나갑니다.
- 오류 코드: `code_expired`(활성 코드 없음·만료·사용됨·세션 중 교체), `code_wrong`+`left`, `code_locked`(5회 소진, 코드 폐기), `code_busy`(다른 세션 진행 중), `bad_pake`(형식 오류). 0.1.5 브리지는 `pake`에 `bad_hello`로 답하고, 앱은 이것을 "브리지 업데이트 필요"로 안내합니다.
- 상태: `pairings.json`의 행에 `code: {prs, attemptsLeft, offer}`가 붙습니다. `pair`와 `serve`는 `pairings.lock`(O_EXCL, 10초 넘은 잠금은 정리)으로 쓰기를 직렬화하고, 1초 안에 잠금을 못 잡으면 `code_busy`/`pairing_busy` 또는 CLI 오류로 끝냅니다.
- 잠금 파일에는 잡은 프로세스의 토큰이 들어가고, 해제와 오래된 잠금 정리는 자기가 확인한 잠금만 지웁니다(정리는 `rename`으로 옮긴 뒤 내용을 확인).
- 로그는 `pake start left=n`, `pake wrong left=n`, `pake locked`, `pake expired`, `pake ok`, `pake busy`(다른 세션 진행 중), `pake busy (pairings locked)`만 남기고 코드·ISK·secret은 남기지 않습니다.
- 정본은 `bridge/src/{cpace.ts,device-code.ts,code-pairing.ts}`이고, 시험 벡터는 `fixtures/cpace-vector.json`입니다(초안 B.1.1~B.1.5·B.1.10, 독립 Python 구현 `bridge/test/cpace_ref.py`와 대조한 의사 난수(고정 스트림)·경계 벡터, 코드 인코딩, 전체 거래). 다시 만들 때는 `bun test/gen-cpace-vector.ts`이고, 입력이 고정돼 있어 같은 파일이 다시 나옵니다.

## 3. 암호화 채널 `gjcm-e2ee-v1`

정본 구현은 `bridge/src/crypto.ts`이고, Swift(`ios/Core/Sources/GjcMobileCore/E2EE.swift`)와 Kotlin(`android/.../core/E2EE.kt`)이 같은 동작을 합니다. 세 구현 모두 `fixtures/e2ee-vector.json`을 바이트 단위로 재현하는 테스트를 가지고 있습니다.

### 핸드셰이크 (평문 1왕복)

| 방향 | 메시지 |
|---|---|
| 앱 → 브리지 | `{t:"hello", v:1, deviceKey: D_pub, eph: Ec_pub, nonce: Nc, name, pairing?: {id, proof}}` |
| 브리지 → 앱 | `{t:"welcome", eph: Es_pub, nonce: Ns, …}` 또는 `{t:"error", code, message}` |

- `D`는 기기의 장기 X25519 키(키체인·Keystore 보관), `H`는 호스트 장기 키, `Ec`·`Es`는 연결마다 새로 만드는 임시 키입니다.
- 첫 페어링 때는 `proof = HMAC-SHA256(secret, "gjcm-pair-v1" ‖ D_pub ‖ Ec_pub)`를 보냅니다. 비밀값 자체는 전송하지 않습니다.
- 오류 코드: `pairing_invalid`(코드 무효·사용됨·만료), `unknown_device`(페어링되지 않은 기기), `pairing_busy`(pairings.json 잠금을 1초 안에 못 잡음).

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

메서드와 이벤트 목록, 오류 코드는 [`bridge/README.md`](../bridge/README.md#rpc)에 있습니다. 메시지 최대 크기는 32MiB입니다(iOS 앱의 `maximumMessageSize`도 같습니다). 브리지는 이보다 큰 프레임을 보내지 않습니다. 넘는 응답은 `-32030 response_too_large` 오류로 바꾸고, 넘는 이벤트는 건너뜁니다. 앱은 한도를 넘는 프레임을 받으면 연결을 끊기 때문입니다. 세션 재생 버퍼는 실제로 보내는 바이트(UTF-8)로 세어 24MiB까지만 둡니다. 예전에는 UTF-16 길이로 48MB까지 두어서, 한글이 많은 세션은 `session.open` 응답이 32MiB를 넘을 수 있었습니다. pve1에서 끊김이 반복되던 세션은 20분 뒤 실측 응답이 28.2MB(UTF-8)로 한도 아래였으므로, 끊긴 순간에 한도를 넘었는지는 확인하지 못했습니다. 브리지는 연결이 끊길 때 `disconnected device=… code=… reason=…`을 남겨 다음 원인을 가릴 수 있게 합니다.

## 4. 세션 흐름

1. `session.new{cwd}` → gjc ACP `session/new`. 0.19.3 실측 중간값 6.2초(4.7~13.8초, 45회)이고 대부분은 세션 호스트 기동입니다. 그래서 앱은 첫 메시지와 함께 생성합니다. 브리지를 `--tmux-session`으로 띄우면 tmux 창의 TUI가 새 세션을 시작하고 폰은 그 TUI에 붙습니다. 그 세션에서 폰이 보낸 턴의 도구 승인은 gjc 세션 CLI의 승인 채널로 폰에 오고(터미널에서 친 턴의 도구는 브리지가 바로 허용), 브리지는 gjc ACP를 다시 띄울 때마다 그 창들에 스스로 다시 붙어 채널을 지켜봅니다(2026-11-09 실측 lab 5.3~7.4초, pve3·pve1 14~18초, [브리지 README](../bridge/README.md#새-세션을-tmux-창으로-열기-옵트인)).
2. `session.prompt`는 수락 즉시 `{accepted: true, turnId}`로 응답하고 진행 상황은 `session.update` 이벤트로 흘러옵니다. 턴 종료는 브리지가 붙이는 `x_gjcm_turn_end`로 알리며, 폰이 시작한 턴의 끝에는 같은 `turnId`가 붙습니다.
3. 작업 중 메시지는 `turn.steer`(다음 모델 단계에 주입) 또는 `turn.follow_up`(턴 종료 후 전송)으로 보냅니다.
4. **끼어들기**(`session.interrupt`): 대기열 조회 → `session/cancel` → 남은 지시 제거 → 같은 텍스트로 새 `session/prompt`. 실측 응답 196ms.
   - 취소보다 턴이 먼저 단계 경계에 닿으면 gjc가 그 지시를 스스로 모델에 넘깁니다. 그 경우 취소 뒤 사용자 메시지로 나타난 지시는 다시 보내지 않습니다. 실측(2026-10-26, TUI 턴)에서 같은 지시가 두 번 전달되던 문제를 막습니다.
   - 앱의 '전달 대기' 표시와 끼어들기 버튼은 `session.status.queued`(gjc 대기열, 1초마다)를 따릅니다. 그래서 TUI에서 넣은 steer도 보입니다. 도구 실행 중의 steer는 gjc가 도구를 백그라운드로 접고 곧바로 전달하므로(실측 약 4초) 대기열에 잠깐만 머뭅니다.
   - 터미널에서 시작한 턴은 앱에서 끼어들 수 없습니다. gjc는 턴을 시작한 연결에만 중단을 허용합니다. 실측: `session/cancel` 무효, `turn.abort`는 `no_active_turn`, terminal 모드는 `terminal_no_effect`, operator 모드는 Broker 경로 전용입니다. 그래서 브리지는 이런 턴을 바로 거절하고(-32004 `host_turn`), 지시는 대기열에 남아 턴의 다음 단계에서 전달됩니다.
   - 터미널 턴 중에 폰이 보낸 메시지(사진 포함)는 gjc가 받자마자 사용자 메시지로 되돌려 보냅니다. 하지만 실제로는 대기열에서 기다리다가 턴의 다음 단계(도구가 끝날 때)에 모델로 갑니다. 브리지는 이 되돌림을 붙잡아 두었다가 대기열에서 빠지면 대화에 넣습니다(사진만·파일 첨부·follow-up 뒤 메시지 포함). 그래서 기다리는 동안에는 '전달 대기'에만 보이고, 말풍선은 TUI처럼 전달된 자리에 나옵니다. 도구가 끝나는 경계에서는 바로 확인하고, 답이 흘러나오는 중의 경계는 0.3초 안에 확인하므로 답 앞부분 몇 글자 뒤에 나올 수 있습니다. 취소로 지워졌거나 실패한 메시지는 대화에 넣지 않습니다. 실측(2026-11-07, 0.19.3): 20초 대기 뒤 도구 완료 0.1초 후 말풍선.
   - **중단**(`session.cancel`)도 같습니다. 터미널이 호스트하는 세션(`primaryControlSurface` `cli`)에서 터미널에서 친 턴과 그 턴 뒤에 이어진 폰 메시지의 턴은 바로 거절하고(-32004 `host_turn`, 「터미널에서 Esc로 멈추세요」) 앱은 그 안내를 보여 줍니다. 앱이 붙잡고 있던 사진 메시지는 입력창으로 되돌리지 않고 계속 붙잡았다가 턴이 끝나면 보냅니다. 실측(2026-11-08, 0.19.3): 예전처럼 `session/cancel`을 보내면 턴은 멈추지 않고 대기 중인 폰 사진 메시지만 지워졌습니다.
   - 쉬는 TUI 세션에서 폰 메시지를 보내자마자 멈추면 gjc는 그 프롬프트를 실행하기 전에 취소하고, `session/prompt`를 `cancelled`가 아닌 오류(`Prompt preflight was cancelled before execution.`)로 끝냅니다. 그 메시지는 대화 기록에 남지 않습니다. 브리지는 이 경우를 `stopReason: "cancelled"`, `undelivered: true`로 끝냅니다. 앱은 자기가 받은 `turnId`와 같은 턴 끝일 때만(다른 폰이 보낸 메시지는 아님) 글과 사진을 입력창으로 돌려놓습니다. 그 턴 끝을 실시간으로 놓쳤으면 다시 열 때 받은 스냅샷에서 찾고, 스냅샷에도 없이 턴이 끝나 있으면 돌려놓지 않습니다. 대화에 이미 그려진 그 메시지의 말풍선은 지우지 않습니다. 실측(2026-11-08, 0.19.3·0.20.0): 사진 프롬프트 직후(0ms) 중단은 오류였고 기록에 메시지가 없었습니다. 800ms 뒤 중단은 `cancelled`였고 기록에 남았습니다.
   - 터미널 Esc 뒤 gjc ACP가 폰 메시지의 `session/prompt`에 끝내 답하지 않으면(2026-11-08 pve3, 폰이 1시간 넘게 작업 중) 브리지가 `context.get`(`isStreaming`·대기열)과 마지막 `gjcPhase`(압축·재시도 중이 아님)로 호스트가 쉬는지 보고 ACP 연결을 닫았다 다시 불러와 그 턴을 끝냅니다(중단 때 바로, 아니면 15초 간격 두 번 연속 쉬고 그 사이 업데이트가 없을 때). TUI 호스트는 그대로입니다. close가 5초 안에 그 프롬프트를 끝내지 않으면 브리지가 직접 `cancelled`로 끝냅니다. gjc ACP가 스스로 호스트하는 세션은 예전처럼 `session/cancel`로 멈춥니다.
5. 연결이 끊겼다가 돌아오면 앱은 열려 있던 세션을 `session.open{afterSeq}`로 다시 열어 놓친 업데이트만 받습니다. 붙은 지 10초 안에 끊긴 연결은 실패한 접속으로 봅니다. 그래서 1초부터 30초까지 두 배씩 기다렸다가 다시 붙습니다. 오래 유지되다 끊긴 연결만 곧바로 다시 붙습니다. 실측(2026-11-08, pve1): 붙자마자 끊기는 연결에 앱이 곧바로 다시 붙어서, 0.55초 간격으로 32번 다시 붙었습니다.
6. 터미널(TUI)에서 진행 중인 턴도 실시간으로 보입니다. 사용자가 입력한 지시, 도구 호출(bash 등)과 그 출력, 답변이 `session.update`로 흘러옵니다. gjc 0.19.3부터 공식 빌드에 들어 있습니다(상류 [gajae-code#7286](https://github.com/Yeachan-Heo/gajae-code/pull/7286)). 이전에 쓰던 로컬 패치 `0005-acp-mirror-terminal-turns.patch`는 2026-11-05에 폐기했습니다.
   - 세션 호스트는 원래 턴 내용을 그 턴을 보낸 연결과 관찰자(observer) 연결에만 보냈습니다. ACP는 둘 다 아니어서 0.19.3 이전 gjc에서는 앱에 working/idle만 보입니다.
   - ACP를 관찰자로 만들면 안 됩니다. 분리된 세션 호스트는 관찰자만 붙어 있으면 스스로 종료하므로 앱이 연 세션이 사라집니다. 상류 수정도 관찰자로 만들지 않고 턴 스트림만 보냅니다.
   - 호스트 쪽 코드가 필요하므로 0.19.3 이전 gjc로 시작된 터미널 세션은 그 gjc를 다시 시작해야 보입니다. 실측(2026-11-04, 공식 0.19.3, 패치 없음): TUI 턴의 bash `tool_call`과 진행·완료, ask, 답변, idle이 실시간 도착.
   - 터미널 턴의 ask는 브리지가 대화 기록(transcript)에서 찾아 읽기 전용 행으로 보여 줍니다. 세션 호스트가 `ask.requests.list`를 지원하면(상류 [gajae-code#7611](https://github.com/Yeachan-Heo/gajae-code/pull/7611), 0.19.3 다음 릴리스) 그 질문을 권한 카드로도 띄우고, 폰의 선택을 `ask.answer`로 보냅니다. gjc가 헤드리스 세션의 ask를 ACP 클라이언트에 넘기는 방식(`createSdkPermissionAskAnswerSource`)과 같습니다: 선택형 질문만, 자유 입력("Other")은 빼고, 다중 선택은 한 번에 하나씩 토글한 뒤 '완료' 같은 컨트롤로 끝냅니다. 카드를 닫으면 터미널에 맡기고, 터미널이 먼저 답하면 카드를 내립니다. 권한 모드(allow/deny)는 ask에 답하지 않습니다. 0.19.3 호스트는 이 조회가 `unknown_operation`이라 읽기 전용 행만 남습니다. 실측(2026-11-07, 상류 dev 소스 TUI + 브리지): 질문이 TUI에 뜬 뒤 0.3초 안에 카드가 왔고, 폰에서 고른 답이 TUI 질문에 들어가 모델이 이어서 답했습니다.
7. 추론은 `agent_thought_chunk`로 와서 "추론" 블록으로 보입니다. Anthropic 요약 추론과 OpenAI Responses 추론 요약은 `thinking_delta`가 아니라 `reasoning_summary_*` 이벤트로 옵니다.
   - 공식 0.19.3의 ACP 매퍼는 이를 버리므로 앱에 추론이 오지 않습니다. 근거는 코드입니다(아래 #7557은 v0.19.3 태그에 없음). 실측은 0.19.3 이전의 0.19.0 dev에서 한 것입니다(2026-10-26, opus-5-5 medium: `agent_message_chunk` 56개, `agent_thought_chunk` 0개).
   - 상류 [gajae-code#7557](https://github.com/Yeachan-Heo/gajae-code/pull/7557)이 dev에 들어가 0.19.3 다음 릴리스부터 요약 델타가 추론 청크로 옵니다.
   - 델타 없이 끝에만 오는 요약은 #7557 범위 밖입니다. 로컬 패치 `0006-acp-reasoning-summary-thoughts.patch`가 이것을 한 번만 보내고, 빈 요약의 구분자("\n\n")를 버립니다. 2026-11-05에 #7557 위로 다시 만들었습니다.
   - 실측(2026-11-05, dev + 패치 0006): `oci-opencodex/gpt-5.6-sol`에서 추론 청크 2개. opencodex 뒤의 opus-5-5는 요약 본문을 비워 보내므로 0개가 정상입니다.

## 5. 설계 결정과 근거

| 결정 | 근거 (실측) |
|---|---|
| 앱 계층 E2EE + `ws://` 허용 | 호스트가 인증서 없는 LAN·Tailscale IP에 있으므로 TLS를 강제할 수 없습니다. 암호화를 앱 계층에 두면 경로(ws·wss·Funnel)와 무관하게 같은 보장이 성립합니다. |
| 추론 강도 변경은 SDK `thinking.set` | gjc `session/set_config_option`은 모델 카탈로그(약 1,080개)를 세 번 다시 만들어 4.1초가 걸렸고, `thinking.set`은 13~24ms였습니다. 모델 변경은 선택지가 모델에 따라 바뀌므로 느린 경로를 유지합니다. |
| 끼어들기를 브리지에서 조립 | gjc `turn.abort`는 ACP에서 `uncertain_after_send`를 내고 약 80초 멈췄고, `turn.abort_and_prompt`는 출력이 없었으며, 단순 취소는 대기 지시를 잃었습니다. |
| 세션 목록은 저장된 트랜스크립트에서 생성 | ACP `session/list`는 브로커 색인(30일 보존)에서 나오므로 저장된 대화가 많이 빠집니다. 실측: 859개 중 837개, 0.19.3에서는 214개 중 181개. |
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
