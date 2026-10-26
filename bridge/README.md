# gjcm-bridge

아이폰 앱(가재코드)과 호스트의 gjc를 잇는 브리지 데몬입니다. 호스트에서 `gjc --mode=acp` 프로세스 하나를 오래 유지하고, 페어링된 기기에 종단간 암호화(gjcm-e2ee-v1) WebSocket으로 다중화합니다. 에이전트 실행, 세션 저장, 구독 인증은 모두 호스트에 남고 폰은 원격 조작만 합니다.

## 실행

```bash
bun install
bun src/cli.ts serve --host 0.0.0.0 --port 7787 --cwd ~/work --gjc "gjc --mode=acp"
bun src/cli.ts pair        # 페어링 QR/URL(gjcm://pair?o=…) 출력
bun src/cli.ts devices     # 페어링된 기기 목록
bun src/cli.ts revoke <id> # 기기 해제
```

상시 운영은 `deploy/gjcm-bridge.service`(systemd)를 씁니다. 로그는 `logs/bridge.log`에 append합니다. 시스템 저널은 몇 시간 안에 회전돼 장애 원인이 사라지기 때문입니다. 프롬프트 본문은 로그에 남기지 않고, 5초 이상 걸린 RPC와 실패한 RPC만 기록합니다.

## 저장 위치

| 항목 | 위치 |
|---|---|
| gjc 세션 기록 | `~/.gjc/agent/sessions` (gjc 소유, 브리지는 읽기만 함) |
| 구독 OAuth | `~/.gjc/agent/auth.db` (호스트 밖으로 나가지 않음) |
| 브리지 상태 | `GJCM_HOME`(기본 `~/.gjc-mobile`): `host.json`, `devices.json`, `pairings.json`, `uploads/` |
| 폰 | 기기 키·호스트 목록은 iOS 키체인 |

## RPC

`model.roles`/`model.setRole`은 gjc `/model`의 역할별 모델(`modelRoles.default`, `task.agentModelOverrides.{executor,architect,planner,critic}`, 값은 `provider/model[:effort]`)을 다룹니다. 읽기는 `<agentDir>/config.yml`에서 하고(ACP에는 config 조회가 없습니다), 쓰기는 열린 세션을 통해 gjc `config.patch`로 해서 gjc가 직접 저장하게 합니다. gjc는 저장을 늦게 하므로 브리지는 config.yml에 반영될 때까지(최대 5초) 기다렸다가 답합니다. 모델 프로필이 켜져 있으면 쓰기를 거부합니다(gjc `/model`이 프로필 쪽에 쓰기 때문에 전역 쓰기는 가려집니다). 폰의 범용 `sdk.control`에는 `config.patch`를 열지 않습니다.

이벤트: `session.update`, `permission.request`, `permission.resolved`, `session.status{sessionId,running,tokensPerSecond?,queued}`(턴 시작·종료 때, 작업 중에는 1초마다. `queued`는 gjc `queue.messages.list`에서 읽은 대기 메시지 `[{id,text,mode:"steer"|"followUp"}]`로, TUI나 다른 폰이 넣은 steer도 포함하며 유휴일 때는 빈 배열입니다. 출력 속도는 gjc `session.stats`의 실제 출력 토큰(완료된 메시지 단위, 숨은 추론·도구 인자 포함)에 그 뒤 스트리밍된 텍스트 추정치를 더해 도구 실행 시간을 뺀 모델 시간으로 나눈 값입니다. 첫 메시지가 끝나기 전에는 0입니다).

`host.info`, `session.list{cwd,query,cursor}`, `session.new`, `session.open{sessionId,cwd,afterSeq}`, `session.close`, `session.prompt`, `session.interrupt{sessionId}`, `session.cancel`, `session.setConfig`, `session.setPermissionMode{sessionId,mode}`, `model.roles`, `model.setRole{sessionId,role,value}`, `session.fork`, `session.delete`, `sdk.query{sessionId,op,input}`, `sdk.control{sessionId,op,input,confirm}`, `permission.respond`, `permission.list`(모든 세션의 대기 중인 승인·질문 `{requests}`. 채팅을 열지 않은 연결과 위젯 갱신용), `upload.begin/chunk/commit`, `ping`.

`session.setConfig` for `thinking` goes through the SDK `thinking.set` (~20ms) instead of gjc's `session/set_config_option`, which rebuilds the ~1080-model catalog three times (~4.1s measured); the bridge then emits the `config_option_update` itself.

`session.interrupt` is the TUI's Esc with a steer waiting: it reads the steers from gjc's `queue.messages.list`, cancels the running turn (`session/cancel`), removes any steer the cancel left queued, and sends their text as the next `session/prompt`. A steer whose text appears as a user message after the cancel was already handed to the model at a step boundary the turn reached first, and is not sent again. A turn this bridge did not start (typed in the TUI) answers `-32004 host_turn` at once: gjc lets only the client that started a run abort it (`session/cancel` no effect, `turn.abort` `no_active_turn`, terminal mode `terminal_no_effect`, operator mode Broker-only; measured). It answers `{accepted, text}`, `-32005 no_pending_steer` when the model already took every steer, and `-32004` when the turn did not stop within 10s. gjc's own `turn.abort` (steer-on-interrupt) is not used: over ACP it answers `uncertain_after_send` and leaves the prompt pending for ~80s.

`session.setPermissionMode`는 앱 세션 메뉴의 「권한모드」 항목입니다(누를 때마다 `prompt` → `allow` → `deny` 순환). gjc SDK `permission_mode.set`으로 세션의 가드 도구(`bash`·`eval`·`delete`·`move`) 정책을 바꾸고, 모든 폰에 `x_gjcm_permission_mode{mode}` 업데이트를 보냅니다. 스냅샷에는 `permissionMode`가 들어갑니다. gjc는 ACP 연결(`session/new`·`session/load`)마다 `prompt`로 되돌리므로 브리지가 세션별 모드를 기억했다가 다시 불러올 때 재적용합니다(브리지 재시작 시에는 `prompt`). 모드를 바꿀 때 이미 대기 중인 승인 요청은 새 모드대로(`allow` → 한 번 허용, `deny` → 한 번 거부) 처리합니다. 추적을 위해 `permission_mode.set`은 범용 `sdk.control`에서 열지 않습니다.

`sdk.query`/`sdk.control`은 gjc `_gjc/sdk/query|control` 패스스루이며 `src/hub.ts`의 `SDK_QUERIES`/`SDK_CONTROLS` 허용 목록 밖의 op는 -32601로 거부합니다. `context.get` 응답의 `systemPrompt` 본문(~40KB)은 잘라내고 `systemPromptChars`만 보냅니다.

오류 코드: -32002 모르는 세션, -32003 실행 중, -32020 SDK op 실패(gjc 메시지 그대로), -32601 허용 안 됨, -32010..-32014 업로드.

## 세션 목록과 재개

- 목록은 ACP `session/list`가 아니라 gjc가 저장한 트랜스크립트(`sessions/<bucket>/<stamp>_<id>.jsonl` 헤더)에서 최신순으로 만듭니다. TUI `/resume`이 보여주는 목록과 같습니다. ACP `session/list`는 브로커 엔드포인트 색인을 오래된 순으로 주고, 실측 시 100행 중 78행에 저장 기록이 없었으며 저장된 859개 중 837개가 빠져 있었습니다.
- 재개(세션 호스트 기동)는 바쁜 호스트에서 약 36초 걸립니다. gjc 기본 준비 타임아웃 22초로는 실패하므로 서비스 파일에서 `GJC_ACP_SESSION_READINESS_TIMEOUT_MS=60000`을 줍니다.
- ACP 프로세스의 브로커 소켓이 장시간 운영 뒤 망가지면 `SDK request outcome is uncertain after the frame was sent`가 납니다. 실행 중인 턴과 대기 중인 권한 요청이 없을 때 브리지가 ACP 프로세스를 자동으로 재시작합니다.

## gjc 요구 사항

- `turn.btw` ACP 제어(BTW 사이드 질문, [BTW.ko.md](../docs/BTW.ko.md))를 지원하는 gjc 빌드가 필요합니다. 지원하지 않는 gjc는 `unknown_operation`으로 답하고, 브리지는 이를 `host_outdated`로 앱에 전달합니다.
- `GJC_ACP_SESSION_READINESS_TIMEOUT_MS`(허용 범위 4000–60000ms, 그 밖은 22000으로 되돌아감)는 이를 지원하는 gjc 빌드에서만 적용됩니다. 지원하지 않는 빌드에서는 콜드 재개가 22초에서 실패할 수 있습니다.

## 심사용 데모 호스트

`deploy/gjcm-demo.service`가 `demo/demo-agent.ts`(정해진 응답만 내는 ACP 대역, 명령 실행 없음)로 브리지를 하나 더 띄웁니다. 상태와 에이전트 디렉터리는 운영 브리지와 분리되고, 공개 HTTPS 경로(예: `https://demo.example.com/gjcm-demo`)로 노출합니다. `--demo-endpoint`를 주면 `GET /offer`가 그 주소용 30일 재사용 페어링 링크를, `GET /privacy`가 개인정보처리방침을 돌려줍니다. 앱의 "컴퓨터 없이 데모로 체험"은 빌드 때 `GJCM_DEMO_OFFER_URL`로 준 이 `/offer` 주소를 쓰며, 비어 있으면 버튼이 숨겨집니다.

## 테스트

```bash
bun test                    # 가짜 ACP 에이전트로 브리지 전체
GJCM_E2E=1 GJCM_E2E_GJC="gjc --mode=acp" GJC_ACP_SESSION_READINESS_TIMEOUT_MS=60000 bun test test/e2e-gjc.test.ts
bunx tsc --noEmit -p .
```
