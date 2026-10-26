# 가재코드 iOS 앱

Swift 6 · SwiftUI · iOS 17 이상 · iPhone 전용. 번들 ID `dev.gajae.gjcmobile`, 표시 이름 `가재코드`.

## 구조

| 위치 | 역할 |
|---|---|
| `project.yml` | XcodeGen 정의. Info.plist 값(URL 스킴 `gjcm`, ATS, 수출 규정, 데모 오퍼 URL)도 여기서 관리합니다. |
| `Core/` (Swift 패키지 `GjcMobileCore`) | UI와 무관한 프로토콜 코어. swift-crypto에 의존합니다. |
| `App/` | SwiftUI 앱 |
| `Widget/` | 위젯 확장 `GjcWidget`(`dev.gajae.gjcmobile.widget`): 홈 small·medium·large, 잠금화면 원형·직사각형·한 줄 |

### Core

| 파일 | 역할 |
|---|---|
| `E2EE.swift` | `gjcm-e2ee-v1` 키 유도와 프레임 암호 |
| `BridgeClient.swift` | URLSessionWebSocket, 핸드셰이크, RPC, 이벤트 스트림 |
| `Pairing.swift` | 오퍼 파싱, 페어링된 호스트 |
| `Models.swift`, `JSONValue.swift`, `Transcript.swift` | 모델, JSON, 대화 트랜스크립트 |
| `Attachments.swift` | 분할 업로드 |
| `SlashCommands.swift` | 슬래시 명령 해석 |
| `Insights.swift` | 컨텍스트·할 일·목표 등 인사이트 데이터 |
| `WidgetSnapshot.swift` | 위젯 스냅샷과 표시 규칙(Android `WidgetSnapshot.kt`와 같은 규칙) |

### App

| 파일 | 역할 |
|---|---|
| `AppModel.swift`, `HostConnection.swift`, `ChatModel.swift` | 호스트·연결·대화 상태 |
| `RootView.swift`, `SidebarView.swift`, `HostHomeView.swift` | 사이드바(호스트·세션), 새 채팅 화면 |
| `ChatView.swift`, `TranscriptViews.swift`, `InsightViews.swift` | 대화 화면 |
| `SelectableText.swift` | 대화 본문용 `UITextView`: 부분 선택·드래그·복사, 링크는 기본 브라우저(Safari)로 |
| `ModelSettingsView.swift` | 역할별 모델·추론 강도 |
| `PairingView.swift` | QR 스캔, 링크 붙여 넣기, 데모 체험(`DemoHost`) |
| `SecureStore.swift` | 키체인 |
| `WidgetStore.swift`, `WidgetRefresher.swift` | 위젯 스냅샷을 App Group에 기록, 백그라운드 갱신(`BGAppRefreshTask`) |
| `PrivacyInfo.xcprivacy` | 개인정보 매니페스트(추적 없음, 수집 없음, UserDefaults 사유 CA92.1) |

## 빌드와 테스트

이 호스트(Linux)에는 Swift 툴체인이 없으므로 iOS는 CI(macos-15)로만 빌드·테스트합니다.

```bash
cd ios/Core && swift test          # macOS에서
cd ios && xcodegen generate && open GjcMobile.xcodeproj
```

`swift test`의 `BridgeLiveTests`는 실제 브리지를 띄워 핸드셰이크와 RPC를 확인합니다. 배포는 [`docs/RELEASE.ko.md`](../docs/RELEASE.ko.md#3-ios)를 보십시오.

## ATS 예외

`NSAllowsArbitraryLoads`를 켭니다. 브리지는 인증서가 없는 LAN·Tailscale 주소에서 `ws://`로 동작하며, 전송 내용은 앱 계층에서 종단 간 암호화되므로 TLS가 추가로 보호하는 것이 없습니다. 심사 시 이 근거를 메모에 적습니다.
