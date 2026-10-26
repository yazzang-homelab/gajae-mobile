# 빌드와 배포

## 1. 워크플로 한눈에 보기

| 워크플로 | 트리거 | 하는 일 | 산출물 |
|---|---|---|---|
| `ci.yml` | 모든 브랜치 푸시 | 브리지 `tsc`·`bun test`, iOS `swift test`, 시뮬레이터 빌드, 서명 안 된 기기 빌드 | `gjc-mobile-unsigned-device` |
| `android.yml` | 모든 브랜치 푸시 | 단위 테스트, 디버그 APK | `gjc-mobile-debug-apk` |
| `android.yml` (릴리스 단계) | `playstore` 브랜치 푸시 또는 수동 실행 | 업로드 키로 서명된 AAB·APK, 서명 지문 출력 | `gjc-mobile-release` |
| `appstore.yml` | `appstore` 브랜치 푸시 또는 수동 실행 | App Store 서명 아카이브·내보내기, `upload=true`면 App Store Connect 업로드 | ipa, xcodebuild 로그 |
| Xcode Cloud | App Store Connect에서 설정(3절) | iOS 빌드·아카이브, TestFlight 업로드 | TestFlight 빌드 |

## 2. 버전 번호

| 대상 | 버전 이름 | 빌드 번호 |
|---|---|---|
| iOS OTA | `MARKETING_VERSION` (`ios/project.yml`) | `ci.yml`의 `run_number` |
| App Store | 같음 | `appstore.yml`의 `run_number` + `000` |
| Xcode Cloud | 같음 | Xcode Cloud가 매기는 `CI_BUILD_NUMBER`(App Store Connect의 Xcode Cloud 설정에서 다음 번호를 지정. 이미 올린 빌드보다 크게) |
| Google Play | `-PversionName` (기본 `0.1.0`) | `android.yml`의 `run_number` + `000` |

스토어 빌드 번호에 `000`을 붙이는 이유는 OTA로 설치한 빌드보다 항상 커서 충돌하지 않게 하기 위해서입니다.

## 3. iOS

### OTA (개발 기기 직접 설치)

```bash
export GJCM_SIGNING_DIR=...   # wda.key, cert.pem이 있는 디렉터리
export GJCM_ASC_KEY_ID=... GJCM_ASC_KEY_PATH=... GJCM_ASC_ISSUER=... GJCM_CERT_ID=...
export GJCM_OTA_SITE=...      # HTTPS 서버가 게시하는 디렉터리(icon-57.png, icon-512.png 필요)
export GJCM_OTA_BASE=...      # 위 디렉터리의 공개 HTTPS URL
tools/release-ota.sh [ci-run-id]   # 생략하면 최근 성공한 ci 실행
```

모든 변수는 기본값이 없으며 비어 있으면 스크립트가 중단됩니다.

1. `ci.yml`의 서명 안 된 기기 빌드를 내려받습니다.
2. 개발 인증서와 프로파일 두 개(앱, 위젯 확장)로 앱과 위젯 확장을 다시 서명합니다. 프로파일은 `tools/asc_profile.py`가 App Store Connect API로 받고, 서명은 zsign으로 합니다. 서명 자료는 `GJCM_SIGNING_DIR`에 둡니다. zsign은 `-m`을 여러 번 받는 버전이어야 합니다.
3. `GJCM_OTA_SITE`에 `GjcMobile.ipa`·`manifest.plist`·`build.json`을 씁니다.

위젯은 App Group `group.dev.gajae.gjcmobile`을 씁니다. App Store Connect API로는 App Group을 만들거나 App ID에 지정할 수 없으므로 처음 한 번은 developer.apple.com > Identifiers에서 직접 합니다: App Group을 만들고, App ID `dev.gajae.gjcmobile`과 `dev.gajae.gjcmobile.widget`(없으면 `asc_profile.py`가 먼저 등록) 각각 App Groups > Configure에서 그 그룹을 고릅니다. 프로파일에 그룹이 없으면 `asc_profile.py`가 이 절차를 출력하고 멈춥니다.

설치 주소는 `GJCM_OTA_BASE`입니다. 개발 서명이라 Apple 개발자 계정에 등록된 iPhone에만 설치됩니다.

### Xcode Cloud와 TestFlight

GitHub Actions의 macOS 러너가 결제/지출 한도로 멈출 수 있어(2026-10-26), iOS 빌드와 TestFlight 업로드는 Apple Developer 멤버십에 포함된 Xcode Cloud(월 25시간)로 합니다. iPhone 테스트 배포는 OTA 대신 TestFlight 내부 테스트를 씁니다. 기기 등록이 필요 없고 심사도 없습니다.

- 프로젝트는 XcodeGen으로 만들고 `.xcodeproj`를 커밋하지 않습니다. `ios/ci_scripts/ci_post_clone.sh`가 클론 직후 `xcodegen generate`를 실행하고, `ios/Core/Package.resolved`의 핀을 프로젝트에 넣어 패키지를 해석합니다. Xcode Cloud는 자동 패키지 해석을 끈 채 빌드하므로 이 단계가 없으면 빌드가 실패합니다.
- 서명은 Xcode Cloud의 자동 서명입니다. 팀은 `project.yml`의 `DEVELOPMENT_TEAM`(`6Z6SXY7BTZ`)입니다.

처음 한 번은 Mac의 Xcode가 필요합니다(Xcode Cloud 제품 생성과 GitHub 저장소 접근 허용은 App Store Connect 웹이나 API로 할 수 없습니다). 절차와 워크플로 설정(`PR`: 풀 리퀘스트 빌드, `TestFlight`: `main` 아카이브 → TestFlight 내부 테스트)은 [XCODE-CLOUD.ko.md](XCODE-CLOUD.ko.md)에 있습니다.

### App Store

- 서명은 App Store Connect API 키를 쓰는 자동 클라우드 서명(`-allowProvisioningUpdates`)입니다. 저장소에 `.p12`를 두지 않습니다.
- 서명 검증만: `appstore` 브랜치에 푸시합니다(`git push origin HEAD:appstore`).
- 업로드: 기본 브랜치에서 `gh workflow run appstore.yml -f upload=true`를 실행합니다. App Store Connect에 앱 레코드가 있어야 성공합니다.
- 팀 `6Z6SXY7BTZ`, 번들 ID `dev.gajae.gjcmobile`.

| 시크릿 | 내용 |
|---|---|
| `ASC_API_KEY_BASE64` | App Store Connect API 키(`AuthKey_<키 ID>.p8`)의 base64 |
| `ASC_KEY_ID` | API 키 ID |
| `ASC_ISSUER_ID` | API 발급자 ID |

심사용 데모 호스트 주소는 하드코딩하지 않고 저장소 변수 `GJCM_DEMO_OFFER_URL`(`vars.GJCM_DEMO_OFFER_URL`)로 빌드에 넣습니다. Android는 gradle이 같은 이름의 환경 변수를 읽습니다. 비어 있으면 앱이 "데모로 체험" 버튼을 숨깁니다.

## 4. Android

### 로컬 빌드

```bash
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

`local.properties`(`sdk.dir=/opt/android-sdk`)는 git에 넣지 않습니다. JDK 21, Gradle 8.11.1(wrapper), AGP 8.7.3을 씁니다.

### 서명된 릴리스

```bash
git push origin HEAD:playstore              # 또는
gh workflow run android.yml --ref <브랜치>
```

산출물 `gjc-mobile-release`에 `app-release.aab`(Play 업로드용)와 `app-release.apk`(직접 설치용)가 들어 있습니다.

### 업로드 키

| 시크릿 | 내용 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 업로드 키스토어(PKCS12)의 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | 키스토어 비밀번호 |
| `ANDROID_KEY_ALIAS` | 키 별칭 |

Play 앱 서명을 켜면 이 키는 업로드 전용입니다. 분실하면 Play Console에서 업로드 키 재설정을 요청할 수 있지만, 그동안 업데이트를 올릴 수 없으므로 키스토어 사본을 안전한 곳에 반드시 보존합니다. 저장소에는 넣지 않습니다.

## 5. 주의 사항

- Gradle wrapper jar는 공식 배포본이어야 합니다. 데비안 `gradle`로 만든 jar는 `gradle/actions/setup-gradle`의 검증에서 실패합니다(2026-10-23). 다시 만들 때는 `./gradlew wrapper --gradle-version 8.11.1`을 두 번 실행합니다.
- `android.yml`에 `paths` 필터를 두지 않습니다. 새 브랜치 푸시에서는 필터가 기본 브랜치 기준으로 계산돼 `playstore` 푸시가 릴리스 단계를 건너뛰었습니다.
- 브리지 코드를 바꾼 뒤에는 브리지를 재시작해 반영합니다(예시 유닛은 `deploy/`).
