# /btw 사이드 대화 가이드

`/btw`는 본 대화를 멈추거나 오염시키지 않고 잠깐 물어보는 기능입니다. 화면 가운데에 말풍선이 떠서 별도 대화가 진행되며, 그 내용은 세션 기록에 남지 않습니다.

## 사용법

| 동작 | iOS | Android |
|---|---|---|
| 열기 | 입력창에 `/btw 질문` 입력(입력 즉시 말풍선으로 넘어감) 또는 `/` 명령 목록에서 `btw` 선택 | 입력창에 `/btw 질문` 입력 또는 우측 상단 ⋮ → `/btw 잠깐 묻기` |
| 질문 보내기 | 말풍선 안 보내기 버튼 | 말풍선 안 보내기 버튼 |
| 이어서 묻기 | 답변 뒤 말풍선 입력창에 다시 입력 | 동일 |
| 닫기 | 우측 상단 ✕ | ✕, 바깥 영역 탭, 뒤로 가기 |
| 포크 | `포크` 버튼 | `포크` 버튼 |

- 본 작업이 진행 중일 때도 쓸 수 있습니다. 진행 중인 턴은 멈추지 않으며, 사이드 답변은 그 시점까지 화면에 보이는 대화만 참고합니다(실측 약 1초).
- 닫으면 사이드 대화는 사라집니다. 호스트도 기억하지 않습니다.
- **포크**는 현재 세션을 복제한 새 세션(`… (포크)`)을 열고, 지금까지의 사이드 질문·답변을 그 세션 입력창에 초안으로 넣습니다. 내용을 고쳐 보내면 그 세션에서 본격적으로 이어갈 수 있습니다. 세션 복제는 세션 크기에 따라 10초 남짓 걸립니다.

## 제한

- 질문 1건은 16KB까지입니다.
- 첨부 파일·사진은 보낼 수 없습니다. 첨부가 있는 상태에서 `/btw `를 입력하면 일반 메시지로 취급합니다.
- 사이드 답변은 도구를 쓰지 않습니다(파일 읽기·명령 실행 없음). 대화에 이미 나온 내용으로만 답합니다.
- 답변이 30초 동안 끊기거나 전체 120초를 넘으면 실패로 표시되며, 실패한 질문은 다음 질문의 문맥에서 빠집니다.

## 동작 원리

```
앱 말풍선 ──sdk.control "turn.btw" {question, exchanges}──▶ 브리지 ──_gjc/sdk/control──▶ gjc 세션 호스트
                                                                                   └ runEphemeralTurn(purpose: btw)
                     ◀────────────────────── {replyText} ──────────────────────────
```

- ACP 프롬프트로 `/btw`를 보내면 gjc가 일반 프롬프트로 처리해 기록에 남기므로 쓰지 않습니다. 대신 SDK 제어 연산 `turn.btw`를 씁니다.
- `turn.btw`는 이를 지원하는 gjc 빌드가 필요합니다.
- `turn.btw` 지원 이전에 시작된 gjc가 띄운 세션(예: 며칠째 켜 둔 터미널 TUI)은 `turn.btw`를 모릅니다. gjc는 `unknown_operation`으로 답하고, 브리지는 이를 「이 세션을 띄운 gjc가 아직 turn.btw을(를) 모릅니다. 터미널의 gjc를 다시 시작하면(종료 후 gjc --resume) 쓸 수 있습니다.」(`host_outdated`)로 바꿔 앱에 전달합니다.
- 호스트는 상태를 갖지 않습니다. 앱이 답변을 받은 이전 질문·답변 쌍을 `exchanges`로 매번 다시 보내므로 이어서 묻기가 가능합니다.
- 본 턴이 진행 중이면 마지막 사용자 요청에 답이 아직 없습니다. 그대로 두면 사이드 모델이 본 작업을 대신 수행하려 하므로, gjc가 `(The main session is still working on this request.)` 자리표시 답변을 붙여 문맥을 닫습니다.

## 코드 위치

| 영역 | 파일 |
|---|---|
| 브리지 허용 목록 | `bridge/src/hub.ts` `SDK_CONTROLS` |
| 데모 호스트 응답 | `bridge/demo/demo-agent.ts` `turn.btw` |
| 실제 gjc e2e | `bridge/test/e2e-btw.test.ts` (`GJCM_E2E=1`) |
| iOS 상태·요청 조립 | `ios/Core/Sources/GjcMobileCore/BtwConversation.swift` |
| iOS 말풍선 | `ios/App/BtwBubbleView.swift`, `ChatModel.swift` `askBtw`/`forkBtw` |
| Android 상태·요청 조립 | `android/.../core/BtwConversation.kt` |
| Android 말풍선 | `android/.../ui/BtwBubble.kt`, `ChatModel.kt` `askBtw`/`launchForkBtw` |
