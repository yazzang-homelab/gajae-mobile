# 가재코드 Android 앱

Kotlin 2.0 · Jetpack Compose(Material 3) · minSdk 26(Android 8.0) · targetSdk 35. 애플리케이션 ID `dev.gajae.gjcmobile`.

iOS 앱과 같은 브리지에 같은 프로토콜(`gjcm-e2ee-v1`)로 붙습니다. 프로토콜은 [`docs/ARCHITECTURE.ko.md`](../docs/ARCHITECTURE.ko.md)를 보십시오.

## 구조

| 패키지 | 파일 | 역할 |
|---|---|---|
| `core` | `E2EE.kt` | X25519(Tink) + HKDF-SHA256 + AES-256-GCM 프레임 암호, 페어링 증명 |
| | `BridgeClient.kt` | OkHttp WebSocket, hello/welcome 핸드셰이크, 요청 id 기반 RPC, 이벤트 채널 |
| | `Pairing.kt` | `gjcm://pair` 오퍼 파싱, 페어링된 호스트와 기기 키 |
| | `Models.kt`, `Transcript.kt`, `Json.kt` | 세션·설정·권한 모델, `session.update`를 대화 행으로 바꾸는 트랜스크립트 |
| | `Attachments.kt` | 분할 업로드(`upload.begin/chunk/commit`, sha256)와 프롬프트 블록 |
| | `WidgetSnapshot.kt` | 위젯 스냅샷(호스트별 관측 시각, 세션 라벨·작업 중·대기 건수·종료 시각)과 표시 규칙(15분 지나면 "확인 필요") |
| `ui` | `AppModel.kt` | 호스트 목록, 페어링, 데모 오퍼 조회 |
| | `HostConnection.kt` | 호스트별 연결 유지(1초→30초 백오프), 이벤트 분배, 세션 목록 |
| | `ChatModel.kt` | 대화 상태, 전송·지시·끼어들기·중단·승인·설정 |
| | `RootScreen.kt`, `HostHome.kt`, `ChatScreen.kt`, `PairingScreen.kt` | 화면 |
| | `SecureStore.kt` | Android Keystore 기반 EncryptedSharedPreferences(기기 키, 호스트 목록) |
| `widget` | `GjcWidget.kt` | 홈 화면 위젯(Glance). 행을 누르면 그 세션으로(`gjcm://session`) |
| | `WidgetStore.kt` | 앱이 관측한 스냅샷 저장(`gjcm_widget` 환경설정). 질문·명령 본문은 넣지 않음 |
| | `WidgetRefreshWorker.kt` | 위젯이 있을 때 15분마다(WorkManager) 호스트에 짧게 접속해 목록과 대기(`permission.list`)를 읽음 |

`core`는 Android API를 쓰지 않으므로 JVM 단위 테스트로 바로 돌아갑니다.

## 빌드와 테스트

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

| 테스트 | 내용 |
|---|---|
| `E2EEVectorTest` | `fixtures/e2ee-vector.json` 재현: 키 유도, 프레임 봉인·개봉, 재전송 거부, 페어링 증명 |
| `PairingOfferTest` | 만료, 잘못된 스킴, 누락, 손상, 버전, 엔드포인트 순서 |
| `BridgeClientTest` | 메모리 내 브리지 대상: 요청·응답, 원격 오류, 이벤트, 페어링 성공·실패, 미등록 기기 |
| `TranscriptTest` | 스트리밍 청크, 추론, 도구 호출, 턴 종료 |
| `WidgetSnapshotTest` | 위젯 관측·표시 규칙: 대기 건수, 관측된 종료만 "실행 종료", 15분 지나면 "확인 필요", 질문 본문 미저장 |
| `InlineMarkdownTest` | 인라인 마크다운: `[라벨](url)`·맨 URL 링크, 비 http 대상·끝 문장부호 제외, 사용자 메시지는 링크만 |

서명된 릴리스와 배포는 [`docs/RELEASE.ko.md`](../docs/RELEASE.ko.md#4-android)를 보십시오.

## 에뮬레이터 확인 절차

```bash
export PATH=$ANDROID_SDK_ROOT/platform-tools:$PATH
adb start-server
systemd-run --unit=emu-a36 --collect -E HOME=$HOME $ANDROID_SDK_ROOT/emulator/emulator \
  -avd a36 -no-window -no-audio -no-snapshot -gpu off -memory 2048
adb wait-for-device; adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`nohup … &`로 띄운 에뮬레이터는 셸 세션이 끝날 때 같이 죽으므로 `systemd-run`을 씁니다. 데모 호스트로 확인한 뒤에는 데모 브리지의 `GJCM_HOME`을 지정해 `bun bridge/src/cli.ts revoke <id>`로 테스트 기기를 지웁니다.

## iOS 대비 포팅 상태

| 기능 | 상태 |
|---|---|
| 페어링(QR·링크·딥링크·데모), 호스트 목록 | 완료 |
| 세션 목록(작업 중 tok/s, 대기 중 경과 시간), 검색, 삭제 | 완료 |
| 스트리밍 대화, 추론 보기, 도구 호출, 계획, 승인 카드 | 완료 |
| 지시 끼워 넣기, 끼어들기, 중단 | 완료 |
| 모델·추론 강도·모드, 빠른 모드 | 완료 |
| 사진·파일 첨부 | 완료 |
| 슬래시 명령, 인사이트 패널, 세션 포크·이름 변경, 역할별 모델, 오프라인 캐시 | 미구현 |
