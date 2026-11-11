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

`session.cancel`(앱의 「중단」)은 브리지가 시작한 턴만 gjc `session/cancel`로 멈춥니다. 터미널이 호스트하는 세션(`runtime.capabilities`의 `primaryControlSurface`가 `cli`)에서 터미널에서 친 턴과, 그 턴 중에 들어가 뒤에 이어진 폰 메시지의 턴은 `session/cancel`을 보내지 않고 바로 `-32004 host_turn`(「터미널에서 Esc로 멈추세요」)으로 거절합니다. 이때 그 세션의 대기 중인 승인 카드도 거부하지 않습니다(턴이 계속되므로). gjc 0.19.3 실측(2026-11-08): `session/cancel`은 두 턴 모두 멈추지 못했고, 폰 메시지가 아직 대기열에 있으면 사진째 지웠습니다("Prompt submission failed."). 거절하면 메시지는 대기열에 남아 사진과 함께 전달됩니다(실측 0.06초 거절, 이후 정상 전달). gjc ACP가 스스로 호스트하는 세션(`sdk`, 브리지가 만든 세션 등)은 예전처럼 `session/cancel`을 보냅니다. 호스트가 답하지 못하면 다른 턴 뒤에 들어간 폰 메시지의 턴만 거절하고(지워지지 않도록) 나머지는 `session/cancel`을 보냅니다.

그런 폰 턴은 터미널의 Esc 뒤 gjc ACP가 `session/prompt`에 끝내 답하지 않아 폰이 계속 작업 중으로 남은 적이 있습니다(2026-11-08 pve3, 1시간 넘게 `-32003`). 그래서 브리지는 호스트가 쉬는지 확인합니다. `context.get`의 `isStreaming`이 false이고 대기열이 비었고, 마지막 `gjcPhase`가 `compacting`·`retrying`이 아니어야 합니다(`isStreaming`은 압축과 재시도를 포함하지 않음). 쉬고 있으면 중단 때 바로, 중단이 없어도 15초 간격 두 번 연속 쉬고 그 사이 업데이트가 없으면, ACP 연결을 닫았다가(`session/close`, 기다리던 프롬프트가 `cancelled`로 끝남) 곧바로 다시 불러옵니다(`session/load`, 조용한 재생). TUI 호스트는 영향을 받지 않습니다(실측: 16ms에 끝남, 터미널 턴 계속, 1.2초에 다시 붙음, 다음 프롬프트 정상). gjc의 close는 자기가 활성으로 보는 프롬프트만 끝내므로, 5초 안에 답이 없거나 close가 실패하면 브리지가 그 턴을 `cancelled`로 끝내고 늦은 답은 무시합니다. 다시 불러오기가 실패해도 턴은 끝난 채로 두고, 폰의 다음 요청(-32002)이 세션을 다시 엽니다. 푸는 동안(실측 기준 약 1.3초, tmux 창 세션은 승인 채널을 다시 켜는 시간만큼 더) 들어온 `session.prompt`·`session.open`·`session.cancel`은 다시 불러오기를 기다립니다.

터미널 턴 중에 들어간 `session.prompt`의 사용자 메시지(`user_message_chunk`)는 gjc가 대기열에서 모델로 넘길 때까지 브리지가 붙잡아 둡니다. gjc는 받자마자 되돌려 보내지만 실제 전달은 턴의 다음 단계입니다. 대기열(`queue.messages.list`)은 1초마다 읽고, 붙잡은 메시지가 있으면 도구가 끝날 때 바로, 답이 흘러나오는 동안에는 0.3초마다 더 읽습니다. 대기열에서는 gjc 0.19.3이 표시하는 텍스트로만 찾습니다(사진만이면 `[Image]`, 파일 링크는 `[Resource: 이름]` 등으로 이어 붙임, 앞에 follow-up이 있으면 `followUp`). 대기열에서 빠지거나 프롬프트가 성공하면 내보내고, 취소로 지워졌거나 프롬프트가 실패하면 버립니다. 그동안은 스냅샷에도 들어가지 않습니다.

`session.setPermissionMode`는 앱 세션 메뉴의 「권한모드」 항목입니다(누를 때마다 `prompt` → `allow` → `deny` 순환). gjc SDK `permission_mode.set`으로 세션의 가드 도구(`bash`·`eval`·`delete`·`move`) 정책을 바꾸고, 모든 폰에 `x_gjcm_permission_mode{mode}` 업데이트를 보냅니다. 스냅샷에는 `permissionMode`가 들어갑니다. gjc는 ACP 연결(`session/new`·`session/load`)마다 `prompt`로 되돌리므로 브리지가 세션별 모드를 기억했다가 다시 불러올 때 재적용합니다(브리지 재시작 시에는 `prompt`). 모드를 바꿀 때 이미 대기 중인 승인 요청은 새 모드대로(`allow` → 한 번 허용, `deny` → 한 번 거부) 처리합니다. 추적을 위해 `permission_mode.set`은 범용 `sdk.control`에서 열지 않습니다.

`sdk.query`/`sdk.control`은 gjc `_gjc/sdk/query|control` 패스스루이며(단, `turn.btw`는 브리지가 세션 호스트에 맞는 연산으로 바꿔 보냅니다. 아래 [gjc 요구 사항](#gjc-요구-사항) 참고) `src/hub.ts`의 `SDK_QUERIES`/`SDK_CONTROLS` 허용 목록 밖의 op는 -32601로 거부합니다. `context.get` 응답의 `systemPrompt` 본문(~40KB)은 잘라내고 `systemPromptChars`만 보냅니다.

오류 코드: -32002 모르는 세션, -32003 실행 중(끼어들기가 턴을 다시 시작하는 동안 들어온 프롬프트 포함), -32004 멈출 수 없음(`host_turn`: 터미널에서 시작한 턴이나 그 뒤에 이어진 폰 턴의 끼어들기·중단. 끼어들기가 10초 안에 턴을 멈추지 못한 경우도 -32004), -32020 SDK op 실패(gjc 메시지 또는 브리지 진단: `host_outdated`, `approval_channel_unavailable` 등), -32021 tmux 창에서 gjc가 준비되지 않음(아래 [새 세션을 tmux 창으로 열기](#새-세션을-tmux-창으로-열기-옵트인)), -32601 허용 안 됨, -32602 잘못된 요청(`prompt_too_large`: 메시지가 gjc 0.19.3의 프롬프트 한도 256KiB를 넘음. 앱은 1.0.3부터 사진을 합쳐 180KB 안으로, 글이 길면 그만큼 더 작게 다시 인코딩합니다), -32010..-32014 업로드, -32030 응답이 프레임 한도 32MiB를 넘음(`response_too_large`, `bytes`·`limit`). 앱이 그런 프레임을 받으면 연결을 끊고 다시 붙으면서 같은 응답을 또 받으므로, 브리지는 보내지 않고 오류로 답합니다. 한도를 넘는 이벤트는 건너뜁니다.

## 세션 목록과 재개

- 목록은 ACP `session/list`가 아니라 gjc가 저장한 트랜스크립트(`sessions/<bucket>/<stamp>_<id>.jsonl` 헤더)에서 최신순으로 만듭니다. TUI `/resume`이 보여주는 목록과 같습니다. ACP `session/list`는 브로커 엔드포인트 색인(30일 보존)을 오래된 순으로 줍니다. 실측 시 100행 중 78행에 저장 기록이 없었고, 저장된 859개 중 837개(0.19.3에서는 214개 중 181개)가 빠져 있었습니다. ACP 프로세스가 재시작될 때마다 열 수 없는 빈 행이 하나씩 생기는 문제는 상류 [gajae-code#7558](https://github.com/Yeachan-Heo/gajae-code/pull/7558)로 0.19.3 다음 릴리스에서 고쳐집니다.
- 재개(세션 호스트 기동, `session/load`)는 0.19.3 격리 환경 콜드 실측 2.7초입니다. 이전에 바쁜 호스트에서 약 36초가 걸린 기록이 있고, 공식 gjc의 준비 타임아웃은 22초로 고정입니다.
- 최근 답변이 긴 세션(최근 이벤트 합계가 1 MiB 초과)은 0.19.3에서 `cursor_expired`로 재개가 실패합니다. 상류 [gajae-code#7564](https://github.com/Yeachan-Heo/gajae-code/pull/7564)가 dev에 들어가 0.19.3 다음 릴리스에서 고쳐집니다.
- ACP 프로세스의 브로커 소켓이 장시간 운영 뒤 망가지면 `SDK request outcome is uncertain after the frame was sent`가 납니다. 실행 중인 턴과 대기 중인 권한 요청이 없을 때 브리지가 ACP 프로세스를 자동으로 재시작합니다.

## 새 세션을 tmux 창으로 열기 (옵트인)

`serve --tmux-session gjcm`을 주면 앱의 "새 세션"이 tmux 세션 `gjcm`의 창 하나로 열립니다. 창에는 평소처럼 gjc TUI가 뜨고, 폰은 그 세션에 붙습니다. PC에서는 `tmux attach -t gjcm`(또는 접속 중인 tmux에서 prefix+`s`)으로 폰에서 시작한 작업을 그대로 이어 봅니다. 세션 이름을 `main`처럼 쓰고 있는 세션으로 주면 그 세션에 창이 생깁니다.

- **tmux 서버가 이미 떠 있을 때만** 이렇게 엽니다. 서버가 없으면 지금처럼 ACP로 열고 이유를 로그에 남깁니다(`tmux skipped (opening over ACP): …`). 브리지가 서버를 띄우면 그 서버가 브리지 systemd 유닛의 cgroup에 들어가 브리지를 재시작할 때 창이 전부 같이 죽기 때문입니다. 대상 세션(`gjcm`)이 없으면 첫 창과 함께 만듭니다. 브리지는 tmux의 기본 소켓(같은 사용자의 `/tmp/tmux-<uid>/default`)을 씁니다. 그래서 브리지와 사용자 셸의 `TMUX_TMPDIR`이 같아야 하고, systemd 유닛에 `PrivateTmp=yes`를 주면 브리지가 사용자의 tmux 서버를 보지 못해 ACP로 엽니다.
- 동작: `tmux new-window -d`로 `<--gjc에서 --mode=acp를 뺀 명령>`을 띄웁니다. 창의 gjc가 새 세션을 직접 시작하고, 그 프로세스(또는 그 자식)의 pid가 적힌 `<cwd>/.gjc/state/sdk/<id>.json` endpoint가 생기면 그 id로 ACP `session/load`를 보내 붙습니다. 같은 폴더에 다른 프로세스가 남긴 endpoint는 pid가 창 밖이거나 창을 만들기 전부터 있던 파일이라 고르지 않습니다(gjc는 endpoint를 임시 파일에 쓴 뒤 rename하므로 창의 gjc가 쓴 파일은 늘 새 파일입니다). gjc는 endpoint를 먼저 쓰고 그 뒤에 세션을 broker에 등록하며, 그 등록을 기다리지 않습니다(gjc 0.19.3·0.20.0 `session-runtime.ts`). 등록 전의 load는 `not_found`로 실패하므로 브리지는 창이 살아 있는 동안 15초까지 0.25초 간격으로 다시 보냅니다. 등록된 뒤에는 첫 답변 전이라 기록 파일이 없어도 load가 살아 있는 TUI에 붙습니다(2026-11-09 공식 0.19.3·0.20.0 실측). 첫 답변 전에 창을 닫으면 기록이 남지 않습니다. gjc `--tmux`는 TTY가 있어야 하고 새 tmux 세션을 만들기 때문에 쓰지 않습니다.
- 30초 안에 endpoint가 없거나, 창의 gjc가 바로 끝나거나, 15초 안에 load로 붙지 못하면 만든 창을 지우고 앱에 -32021과 이유(`data.code`: `tmux_ready_timeout`, `tmux_window_exited`, `tmux_attach_failed`, `tmux_failed`)를 돌려줍니다. endpoint를 기다리는 동안 브리지가 재시작되면 그 창에는 아직 세션 표시(`@gjcm_session`)가 없어 브리지가 다시 찾지 못합니다. 그 창은 터미널에서 닫습니다.
- 실측(2026-11-09, ACP가 떠 있는 상태, cwd `/root/tmp`, 요청부터 승인 채널 켜기까지 전체): lab 5.3~7.4초, pve3 14.0~15.3초, pve1 13.8~17.7초. 이전 방식(ACP `session/new`→`session/close`→창에서 `--resume`)은 gjc를 두 번 띄워 lab 8.3초, pve3 22~27초, pve1 43.7초였습니다. 남은 시간은 대부분 세 구간입니다.
  - 창의 gjc 기동(창 생성부터 endpoint까지): lab 3.6~3.8초, pve3 10~11초, pve1 7.7~8.3초.
  - load: pve3 약 2초, pve1 4.9~5.1초. endpoint가 생기고 15초 뒤에 보내면 pve3 1.5초, pve1 2.3초입니다.
  - 채널 켜기(세션 CLI 한 번): lab 1.6~2.6초, pve3 약 2초, pve1 1.8초.

  창의 gjc와 세션 CLI는 둘 다 `--gjc` 명령을 그대로 씁니다. 그래서 실행할 때마다 다른 일을 하는 래퍼(pve3·lab의 OCI 모델 동기화, 한 번에 최대 2초)가 두 번 더해집니다. 래퍼를 빼면 전체가 lab 3.3~3.6초, pve3 11.6~12.3초(endpoint까지 8.6~9.0초)입니다. 큰 작업 폴더도 gjc 기동을 늦춥니다. pve3에서 래퍼 없이 작은 저장소로 열면 전체 7.3~8.0초, endpoint까지 4.4초입니다.
- 이 세션은 TUI가 소유합니다. 같은 실측에서 확인한 차이:
  - 앱에서 보낸 턴은 TUI 화면에도 그대로 보입니다.
  - **ask는 터미널에서만 답할 수 있습니다.** gjc는 앱이 시작한 턴의 ask도 TUI에 띄우고 폰에는 답할 수 없는 `tool_call`만 보냅니다(`session/request_permission` 없음, `workflow.gates.list` 비어 있음). 브리지는 이 카드에 질문·선택지와 "터미널에서 답" 안내를 붙이고, 터미널에서 고른 답과 턴 끝은 폰에 옵니다. 이 안내는 브리지가 tmux 창으로 연 세션(본인이 연 창을 다시 열 때 알아봄)에만 붙습니다.
  - **도구 승인(bash 등)은 폰으로 옵니다.** TUI가 소유한 세션은 승인을 ACP로 묻지 않고, gjc 0.19.3은 외부 승인 채널(`permission.channel.set`)도 ACP에서 막습니다(`operation_prohibited`). 그래서 브리지는 세션을 열 때 공식 세션 CLI(`gjc sdk session raw control|query`, `src/sdk-cli.ts`)로 채널을 켭니다. 대기 중인 `tool_call`이 오면 `permission.requests.list`를 읽어 폰에 승인 카드(`permission.request`)를 띄우고, 폰의 답을 `permission.respond`로 돌려줍니다(카드를 닫으면 거부). 승인을 기다리는 동안 TUI에는 스피너만 보이고 터미널에서는 답할 수 없습니다. 그래서 **폰이 보낸 턴만 폰에 묻고, 터미널에서 친 턴의 도구는 브리지가 바로 허용합니다**(채널 없는 터미널의 gjc와 같은 동작). 폰 승인을 기다리게 두면 폰이 채팅을 보고 있지 않을 때 터미널 턴이 스피너만 돌다 60초 뒤 `Permission request cancelled`로 끝났습니다([#114](https://github.com/yazzang-homelab/gajae-mobile/issues/114), 2026-11-11 pve3, gjc 0.20.0 실측). gjc는 실행을 누가 시작했는지 알려 주지 않으므로 기준은 폰의 `session.prompt`가 진행 중인지입니다. 터미널 턴 뒤에 줄 선 폰 메시지가 있으면 그 턴의 도구도 폰에 묻습니다. 브리지가 폰 턴인지 알 수 없게 된 경우(폰 턴 도중 gjc ACP가 죽음, 폰 메시지 전송이 오류로 끝남, 브리지가 그 세션에 처음 붙을 때 호스트가 일하는 중)에는 TUI가 이어 가는 그 턴을 계속 폰에 묻고, 3초마다 호스트를 확인해 쉬고 있거나 폰이 새 메시지를 보내면 풉니다. 폰의 「끼어들기」·「다음에 보내기」(`turn.steer`·`turn.follow_up`)는 어느 턴에서 보냈든 기준을 바꾸지 않으므로, 터미널 턴에 얹힌 그 메시지 뒤의 도구는 묻지 않고 실행됩니다. 바로 허용도 세션 CLI 두 번(목록·응답)을 거치므로 터미널 턴의 도구마다 그만큼 늦게 시작합니다(같은 실측에서 호출당 4~5초). 답하지 않은 요청은 gjc가 60초 뒤 거부하고 카드도 사라집니다. 앱의 권한모드 `allow`/`deny`는 그대로 우선합니다. CLI 호출 하나가 2~4초라 카드는 도구 호출 뒤 약 2초에 뜹니다. 채널이 없으면 TUI는 묻지 않고 실행하므로(0.19.3 실측), 채널을 켜지 못한 세션은 로그(`permission channel not enabled for ...`)를 남기고 폰에 권한모드를 `allow`로 보이며, 폰에서 `prompt`로 바꾸려 하면 -32020 `approval_channel_unavailable`로 거절합니다. 세션을 다시 열 때마다 다시 켜 봅니다. 실측(pve3, 0.19.3, 2026-11-07): 앱 턴 bash는 폰 허용으로 실행, 터미널 턴 bash는 폰 거부로 "Tool call rejected by user".
  - **브리지가 지켜보지 않으면 터미널의 도구 호출은 60초 뒤 거부됩니다.** 채널은 TUI 호스트 메모리에 남고 그 승인은 폰만 할 수 있기 때문입니다. 그래서 브리지는 gjc ACP를 (다시) 띄울 때마다(브리지 시작, gjc 업데이트 뒤 재시작, 크래시) tmux 창들을 찾아(브리지가 연 창에 붙인 tmux 창 옵션 `@gjcm_session <id>`와, 그 창의 gjc가 가진 endpoint로 확인. 사용자가 같은 tmux 세션에 직접 띄운 `gjc --resume`은 건드리지 않음) 폰이 채팅을 열지 않아도 다시 붙고, 채널을 켜고, 이미 기다리던 요청을 다시 읽습니다(폰 턴이거나 폰 턴일 수 있으면 카드로 다시 띄우고, 터미널 턴이면 바로 허용). 이 다시 붙기의 기록 재생은(폰이 ACP 재시작 뒤 채팅을 다시 열어 일어나는 재적재도 같습니다) 열려 있는 다른 폰에 새 메시지로 보내지 않고, 그 사이 브리지가 직접 붙이는 턴 끝 같은 행은 그대로 보냅니다. 그래서 그 폰은 ACP가 없던 동안 터미널에서 일어난 일을 놓치므로, 브리지는 그 기기(다시 연결해도 같은 기기)의 다음 채팅 열기(앱 복귀·재연결·채팅 재진입)에 전체 기록을 줍니다. 다시 열기 전까지는 그 사이 내용이 화면에 비어 보입니다(앱에 밀어 넣는 재동기화 신호는 아직 없음). ACP가 죽어도 채널 카드는 거부하지 않고 내렸다가 다시 띄웁니다. 대기 중에 폰이 `allow`/`deny`로 바꾸면 먼저 그 요청에 답한 뒤 모드를 바꿉니다(gjc는 모드가 바뀌면 대기 요청을 취소함). 호스트가 채널을 잃었으면(같은 id로 TUI를 다시 띄움) 다음 읽기에서 다시 켭니다. 브리지가 꺼져 있는 동안에는 지켜볼 수 없으니, 터미널에서 도구를 쓰는 동안에는 브리지를 켜 둡니다.
  - 앱이 시작한 턴은 앱에서 멈출 수 있습니다(`session.cancel` 후 약 0.4초에 `cancelled`). 터미널에서 친 턴은 앱의 멈춤을 바로 거절하므로 터미널에서 Esc로 멈춥니다(gjc가 턴을 시작한 연결에만 중단을 허용, 상류 [gajae-code#7566](https://github.com/Yeachan-Heo/gajae-code/issues/7566)).
  - 앱에서 채팅을 닫거나 브리지를 멈춰도 tmux 창과 TUI는 남습니다. 창은 터미널에서 닫습니다. TUI가 소유한 동안에는 gjc가 앱의 세션 삭제를 거부합니다(`operation_prohibited`, gjc 코드 기준, 실측 안 함). 창을 닫은 뒤 삭제합니다.
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
