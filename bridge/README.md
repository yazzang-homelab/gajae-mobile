# gjcm-bridge

아이폰 앱(가재코드)과 호스트의 gjc를 잇는 브리지 데몬입니다. 호스트에서 `gjc --mode=acp` 프로세스 하나를 오래 유지하고, 페어링된 기기에 종단간 암호화(gjcm-e2ee-v1) WebSocket으로 다중화합니다. 에이전트 실행, 세션 저장, 구독 인증은 모두 호스트에 남고 폰은 원격 조작만 합니다.

## 실행

```bash
bunx gjcm-bridge serve --host 0.0.0.0 --port 7787 --cwd ~/work --gjc "gjc --mode=acp"
bunx gjcm-bridge pair        # 페어링 QR/URL(gjcm://pair?o=…) 출력
bunx gjcm-bridge devices     # 페어링된 기기 목록
bunx gjcm-bridge revoke <id> # 기기 해제
```

npm 패키지 `gjcm-bridge`이며 [Bun](https://bun.sh)으로만 실행됩니다(`npx`는 쓰지 않습니다). 새 버전은 `bunx gjcm-bridge@latest serve`로 받습니다. 저장소에서 직접 실행할 때는 이 디렉터리에서 `bun install` 뒤 `bunx gjcm-bridge` 대신 `bun src/cli.ts`를 씁니다.

배포: `package.json`의 `version`을 올려 `dev`에 합친 뒤 `bridge-v<버전>` 태그를 푸시하면 `bridge-npm` 워크플로가 테스트를 돌리고 npm에 올립니다(저장소 시크릿 `NPM_TOKEN` 필요).

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

`session.interrupt` is the TUI's Esc with a steer waiting: it reads the steers from gjc's `queue.messages.list`, cancels the running turn (`session/cancel`), removes any steer the cancel left queued, and sends their text as the next `session/prompt`. A steer whose text appears as a user message after the cancel was already handed to the model at a step boundary the turn reached first, and is not sent again. A turn this bridge did not start (typed in the TUI) answers `-32004 host_turn` at once: gjc lets only the client that started a run abort it (`session/cancel` no effect, `turn.abort` `no_active_turn`, terminal mode `terminal_no_effect`, operator mode Broker-only; measured). So does a phone prompt that went in during such a turn: gjc queues it as a steer of that turn, and `session/cancel` would leave the TUI turn running but purge the prompt ("Prompt submission failed.", attachments lost; measured 2026-11-06, gjc 0.19.3). It answers `-32004 host_turn` with its own message and reaches the model at the turn's next step; if the TUI turn ends without taking it and gjc runs it as a turn of its own, the refusal holds until that turn ends, since gjc reports no phase change for it. It answers `{accepted, text}`, `-32005 no_pending_steer` when the model already took every steer, and `-32004` when the turn did not stop within 10s. gjc's own `turn.abort` (steer-on-interrupt) is not used: over ACP it answers `uncertain_after_send` and leaves the prompt pending for ~80s.

터미널 턴 중에 들어간 `session.prompt`의 사용자 메시지(`user_message_chunk`)는 gjc가 대기열에서 모델로 넘길 때까지 브리지가 붙잡아 둡니다. gjc는 받자마자 되돌려 보내지만 실제 전달은 턴의 다음 단계입니다. 대기열(`queue.messages.list`)은 1초마다 읽고, 붙잡은 메시지가 있으면 도구가 끝날 때 바로, 답이 흘러나오는 동안에는 0.3초마다 더 읽습니다. 대기열에서는 gjc 0.19.3이 표시하는 텍스트로만 찾습니다(사진만이면 `[Image]`, 파일 링크는 `[Resource: 이름]` 등으로 이어 붙임, 앞에 follow-up이 있으면 `followUp`). 대기열에서 빠지거나 프롬프트가 성공하면 내보내고, 취소로 지워졌거나 프롬프트가 실패하면 버립니다. 그동안은 스냅샷에도 들어가지 않습니다.

`session.setPermissionMode`는 앱 세션 메뉴의 「권한모드」 항목입니다(누를 때마다 `prompt` → `allow` → `deny` 순환). gjc SDK `permission_mode.set`으로 세션의 가드 도구(`bash`·`eval`·`delete`·`move`) 정책을 바꾸고, 모든 폰에 `x_gjcm_permission_mode{mode}` 업데이트를 보냅니다. 스냅샷에는 `permissionMode`가 들어갑니다. gjc는 ACP 연결(`session/new`·`session/load`)마다 `prompt`로 되돌리므로 브리지가 세션별 모드를 기억했다가 다시 불러올 때 재적용합니다(브리지 재시작 시에는 `prompt`). 모드를 바꿀 때 이미 대기 중인 승인 요청은 새 모드대로(`allow` → 한 번 허용, `deny` → 한 번 거부) 처리합니다. 추적을 위해 `permission_mode.set`은 범용 `sdk.control`에서 열지 않습니다.

`sdk.query`/`sdk.control`은 gjc `_gjc/sdk/query|control` 패스스루이며(단, `turn.btw`는 브리지가 세션 호스트에 맞는 연산으로 바꿔 보냅니다. 아래 [gjc 요구 사항](#gjc-요구-사항) 참고) `src/hub.ts`의 `SDK_QUERIES`/`SDK_CONTROLS` 허용 목록 밖의 op는 -32601로 거부합니다. `context.get` 응답의 `systemPrompt` 본문(~40KB)은 잘라내고 `systemPromptChars`만 보냅니다.

오류 코드: -32002 모르는 세션, -32003 실행 중(끼어들기가 턴을 다시 시작하는 동안 들어온 프롬프트 포함), -32020 SDK op 실패(gjc 메시지 또는 브리지 진단: `host_outdated` 등), -32021 tmux 창에서 gjc가 준비되지 않음(아래 [새 세션을 tmux 창으로 열기](#새-세션을-tmux-창으로-열기-옵트인)), -32601 허용 안 됨, -32602 잘못된 요청(`prompt_too_large`: 메시지가 gjc 0.19.3의 프롬프트 한도 256KiB를 넘음. 앱은 1.0.3부터 사진을 합쳐 180KB 안으로, 글이 길면 그만큼 더 작게 다시 인코딩합니다), -32010..-32014 업로드.

## 세션 목록과 재개

- 목록은 ACP `session/list`가 아니라 gjc가 저장한 트랜스크립트(`sessions/<bucket>/<stamp>_<id>.jsonl` 헤더)에서 최신순으로 만듭니다. TUI `/resume`이 보여주는 목록과 같습니다. ACP `session/list`는 브로커 엔드포인트 색인(30일 보존)을 오래된 순으로 줍니다. 실측 시 100행 중 78행에 저장 기록이 없었고, 저장된 859개 중 837개(0.19.3에서는 214개 중 181개)가 빠져 있었습니다. ACP 프로세스가 재시작될 때마다 열 수 없는 빈 행이 하나씩 생기는 문제는 상류 [gajae-code#7558](https://github.com/Yeachan-Heo/gajae-code/pull/7558)로 0.19.3 다음 릴리스에서 고쳐집니다.
- 재개(세션 호스트 기동, `session/load`)는 0.19.3 격리 환경 콜드 실측 2.7초입니다. 이전에 바쁜 호스트에서 약 36초가 걸린 기록이 있고, 공식 gjc의 준비 타임아웃은 22초로 고정입니다.
- 최근 답변이 긴 세션(최근 이벤트 합계가 1 MiB 초과)은 0.19.3에서 `cursor_expired`로 재개가 실패합니다. 상류 [gajae-code#7564](https://github.com/Yeachan-Heo/gajae-code/pull/7564)가 dev에 들어가 0.19.3 다음 릴리스에서 고쳐집니다.
- ACP 프로세스의 브로커 소켓이 장시간 운영 뒤 망가지면 `SDK request outcome is uncertain after the frame was sent`가 납니다. 실행 중인 턴과 대기 중인 권한 요청이 없을 때 브리지가 ACP 프로세스를 자동으로 재시작합니다.

## 새 세션을 tmux 창으로 열기 (옵트인)

`serve --tmux-session gjcm`을 주면 앱의 "새 세션"이 tmux 세션 `gjcm`의 창 하나로 열립니다. 창에는 평소처럼 gjc TUI가 뜨고, 폰은 그 세션에 붙습니다. PC에서는 `tmux attach -t gjcm`(또는 접속 중인 tmux에서 prefix+`s`)으로 폰에서 시작한 작업을 그대로 이어 봅니다. 세션 이름을 `main`처럼 쓰고 있는 세션으로 주면 그 세션에 창이 생깁니다.

- **tmux 서버가 이미 떠 있을 때만** 이렇게 엽니다. 서버가 없으면 지금처럼 ACP로 열고 이유를 로그에 남깁니다(`tmux skipped (opening over ACP): …`). 브리지가 서버를 띄우면 그 서버가 브리지 systemd 유닛의 cgroup에 들어가 브리지를 재시작할 때 창이 전부 같이 죽기 때문입니다. 대상 세션(`gjcm`)이 없으면 첫 창과 함께 만듭니다. 브리지는 tmux의 기본 소켓(같은 사용자의 `/tmp/tmux-<uid>/default`)을 씁니다.
- 동작: ACP `session/new`로 세션을 만들고(gjc가 이때 기록 파일을 바로 씀니다) `session/close`로 놓아 준 뒤, `tmux new-window -d`로 `<--gjc에서 --mode=acp를 뺀 명령> --resume <id>`를 띄웁니다. 그 창의 프로세스가 `<cwd>/.gjc/state/sdk/<id>.json` endpoint를 쓰면 `session/load`로 붙습니다. TUI에서 새로 시작한 세션은 첫 답변 전까지 기록 파일이 없어 ACP `session/load`가 `Saved ACP session does not exist`로 실패하므로 이 순서를 씁니다(0.19.3 실측). gjc `--tmux`는 TTY가 있어야 하고 새 tmux 세션을 만들기 때문에 쓰지 않습니다.
- 30초 안에 endpoint가 없거나 창의 gjc가 바로 끝나면 만든 창을 지우고 앱에 -32021과 이유를 돌려줍니다.
- 실측(pve3, 공식 gjc 0.19.3, 2026-11-07, ACP가 떠 있는 상태): `session.new` 14.8~15.0초(ACP 경로 5.7~5.9초). 늘어난 시간은 창의 gjc 기동(endpoint까지 약 6.3초)과 다시 붙기입니다. 이 기능의 가치는 속도가 아니라 PC에서 이어 보기입니다.
- 이 세션은 TUI가 소유합니다. 같은 실측에서 확인한 차이:
  - 앱에서 보낸 턴은 TUI 화면에도 그대로 보입니다.
  - **ask는 터미널에서만 답할 수 있습니다.** gjc는 앱이 시작한 턴의 ask도 TUI에 띄우고 폰에는 답할 수 없는 `tool_call`만 보냅니다(`session/request_permission` 없음, `workflow.gates.list` 비어 있음). 브리지는 이 카드에 질문·선택지와 "터미널에서 답" 안내를 붙이고, 터미널에서 고른 답과 턴 끝은 폰에 옵니다. 이 안내는 브리지가 tmux 창으로 연 세션(본인이 연 창을 다시 열 때 알아봄)에만 붙습니다.
  - **도구 승인(bash 등)은 폰으로 옵니다.** TUI가 소유한 세션은 승인을 ACP로 묻지 않고, gjc 0.19.3은 외부 승인 채널(`permission.channel.set`)도 ACP에서 막습니다(`operation_prohibited`). 그래서 브리지는 세션을 열 때 공식 세션 CLI(`gjc sdk session raw control|query`, `src/sdk-cli.ts`)로 채널을 켭니다. 대기 중인 `tool_call`이 오면 `permission.requests.list`를 읽어 폰에 승인 카드(`permission.request`)를 띄우고, 폰의 답을 `permission.respond`로 돌려줍니다(카드를 닫으면 거부). 앱에서 시작한 턴과 터미널에서 친 턴 모두 적용되며, 그동안 TUI에는 스피너만 보입니다. 답하지 않은 요청은 gjc가 60초 뒤 거부하고 카드도 사라집니다. 앱의 권한모드 `allow`/`deny`는 그대로 우선합니다. CLI 호출 하나가 2~4초라 카드는 도구 호출 뒤 약 2초에 뜹니다. 채널을 켜지 못하면 로그(`permission channel not enabled for ...`)만 남기고 예전처럼 엽니다. 실측(pve3, 0.19.3, 2026-11-07): 앱 턴 bash는 폰 허용으로 실행, 터미널 턴 bash는 폰 거부로 "Tool call rejected by user". 브리지를 다시 시작해도 그 세션을 열 때 tmux 창(`--resume <id>`을 띄운 창의 gjc가 endpoint를 가짐)으로 알아보고 다시 켭니다.
  - 앱이 시작한 턴은 앱에서 멈출 수 있습니다(`session.cancel` 후 약 0.4초에 `cancelled`). 터미널에서 친 턴은 앱의 멈춤이 효과가 없습니다(상류 [gajae-code#7566](https://github.com/Yeachan-Heo/gajae-code/issues/7566)).
  - 앱에서 채팅을 닫거나 브리지를 멈춰도 tmux 창과 TUI는 남습니다. 창은 터미널에서 닫습니다.
- Windows 호스트와 tmux를 쓰지 않는 호스트에서는 이 옵션을 주지 않습니다.

## gjc 요구 사항

- BTW 사이드 질문([BTW.ko.md](../docs/BTW.ko.md))은 gjc 0.19.3 이상이 필요합니다. 브리지가 세션 호스트의 `runtime.capabilities`를 보고 로컬 패치 0004의 `turn.btw`가 있으면 그것을, 없으면 공식 `btw.ask`로 보냅니다. 0.19.3의 `btw.ask`는 이전 문답(`exchanges`)을 받아도 무시하므로 브리지가 질문 본문에 붙이고, `btwAskExchangesVersion` 1을 광고하는 호스트(상류 gajae-code#7583 포함 릴리스)에는 `exchanges`로 그대로 넘깁니다. 둘 다 없는 gjc에서는 `host_outdated`로 앱에 전달합니다.
- 터미널 턴의 ask에 폰에서 답하려면 세션 호스트가 `ask.requests.list`/`ask.answer`(상류 gajae-code#7611)를 지원해야 합니다. 0.19.3 다음 릴리스부터이며, 지원하면 선택형 질문이 권한 카드로 오고 고른 답이 터미널 질문에 들어갑니다. 0.19.3에서는 질문이 읽기 전용으로만 보이고 답은 터미널에서 합니다.
- `GJC_ACP_SESSION_READINESS_TIMEOUT_MS`(허용 범위 4000–60000ms, 그 밖은 22000으로 되돌아감)는 **공식 gjc(0.19.3과 dev 포함)가 읽지 않습니다.** 로컬 패치 `0002-acp-session-readiness-timeout-env.patch`를 넣은 빌드에서만 적용됩니다. 서비스 예시와 e2e 명령에 남아 있는 값은 그런 빌드를 위한 것이고, 공식 빌드에서는 아무 효과가 없습니다. 공식 빌드에서는 바쁜 호스트의 콜드 재개가 22초에서 실패할 수 있습니다.

## 외부망에서 접속하기

모든 요청은 앱과 브리지 사이에서 종단 간 암호화(X25519 + AES-256-GCM)되고, 등록된 기기만 받습니다. 그래도 브리지 포트를 인터넷에 열면 누구나 접속을 시도할 수 있으므로 아래 순서로 고릅니다.

1. **Tailscale(권장).** PC와 휴대폰에 Tailscale을 켜 두면 `pair`가 Tailscale 주소를 첫 번째 엔드포인트로 넣습니다. LTE/5G에서도 연결되고 공유기 포트를 열 필요가 없습니다.
2. **WSS 리버스 프록시.** 도메인과 TLS 인증서가 있으면 Caddy·nginx 같은 프록시가 `wss://<도메인>/ws`를 받아 `ws://127.0.0.1:7787/ws`로 넘기고, 브리지는 `--host 127.0.0.1`로 띄웁니다. 프록시에서 WebSocket Upgrade를 허용하고 연결 수·속도 제한을 겁니다. TLS는 E2EE를 대체하지 않고 전송 계층과 접속 메타데이터를 더 보호합니다.
3. **공유기 포트포워딩(DDNS).** 권장하지 않습니다. 써야 한다면 브리지 포트 하나만 그 PC로 넘기고, 브리지 앞에 연결 제한이 없다는 점(인증 전 접속은 15초 핸드셰이크 타임아웃만 있음)을 감안합니다.

페어링 QR에는 주소를 여러 개 넣을 수 있고 앱은 연결되는 주소를 씁니다: `gjcm-bridge pair --endpoint wss://<도메인>/ws --endpoint ws://<LAN IP>:7787/ws`. 외부에 연 브리지에서는 `pair --reusable`과 `serve --demo-endpoint`를 쓰지 않습니다(둘 다 여러 기기가 같은 코드로 페어링하는 심사용 데모 기능입니다). 페어링 코드는 기본 10분 동안 한 번만 쓸 수 있고, 잃어버린 기기는 `gjcm-bridge revoke <이름>`으로 끊습니다.

## 문제 해결

**모든 요청이 약 70초 뒤 `gjc ACP process exited`로 실패(Windows).** gjc 세션 인덱스 잠금 `%USERPROFILE%\.gjc\agent\sdk\sessions\index.jsonl.lock`이 남아 gjc가 시작하지 못하는 gjc 본체 문제입니다([gajae-code#6008](https://github.com/Yeachan-Heo/gajae-code/issues/6008), 수정 이후에도 재발 보고됨). 브리지 로그의 같은 줄 뒤에 gjc가 남긴 오류가 함께 찍힙니다. 브리지와 gjc(터미널 TUI 포함)를 모두 끈 뒤 그 `index.jsonl.lock` 디렉터리를 다른 이름으로 옮기거나 지우고 브리지를 다시 띄웁니다. 세션 기록은 `index.jsonl`과 세션 파일에 그대로 남습니다. gjc가 하나라도 실행 중일 때는 지우지 않습니다.

## 심사용 데모 호스트

`deploy/gjcm-demo.service`가 `demo/demo-agent.ts`(정해진 응답만 내는 ACP 대역, 명령 실행 없음)로 브리지를 하나 더 띄웁니다. 상태와 에이전트 디렉터리는 운영 브리지와 분리되고, 공개 HTTPS 경로(예: `https://demo.example.com/gjcm-demo`)로 노출합니다. `--demo-endpoint`를 주면 `GET /offer`가 그 주소용 30일 재사용 페어링 링크를, `GET /privacy`가 개인정보처리방침을 돌려줍니다. 앱의 "컴퓨터 없이 데모로 체험"은 빌드 때 `GJCM_DEMO_OFFER_URL`로 준 이 `/offer` 주소를 쓰며, 비어 있으면 버튼이 숨겨집니다.

## 테스트

```bash
bun test                    # 가짜 ACP 에이전트로 브리지 전체
GJCM_E2E=1 GJCM_E2E_GJC="gjc --mode=acp" GJC_ACP_SESSION_READINESS_TIMEOUT_MS=60000 bun test test/e2e-gjc.test.ts
bunx tsc --noEmit -p .
```
