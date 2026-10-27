# Xcode Cloud 처음 연결하기 (Mac에서 한 번)

iOS 빌드와 TestFlight 업로드를 Xcode Cloud로 옮기기 위한 최초 설정입니다. Xcode Cloud 제품 생성과 GitHub 저장소 연결은 Xcode에서만 할 수 있어서 Mac이 한 번 필요합니다. 그다음부터는 Mac 없이 돌아가고, 워크플로 수정은 App Store Connect 웹에서 할 수 있습니다.

저장소 쪽 준비(`ios/ci_scripts/ci_post_clone.sh`, `project.yml`의 팀)는 이미 `main`에 들어 있습니다.

## 0. 준비물

| 항목 | 조건 |
|---|---|
| macOS | Xcode 16 이상이 돌아가는 버전(macOS 14.5+). 프로젝트가 Swift 6.0을 씁니다. |
| Xcode | 16 이상. App Store 또는 developer.apple.com에서 설치 후 한 번 실행해 추가 구성요소 설치. |
| Apple ID | 팀 `6Z6SXY7BTZ`의 Account Holder 또는 Admin(App Manager 이상). Xcode Cloud 제품을 만들 권한이 필요합니다. |
| GitHub | `yazzang-homelab` 조직에 GitHub App을 설치할 권한(조직 Owner). |
| 도구 | Homebrew, `xcodegen` |

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install xcodegen git
```

**VM에서 할 때:** Xcode의 Apple ID 로그인(설정 → Accounts)이 되는지 먼저 확인하세요. macOS VM은 기기 식별 정보(시리얼·보드 ID) 때문에 iCloud나 Apple ID 로그인이 막히는 경우가 있습니다. 로그인이 안 되면 이후 단계를 진행할 수 없으니 그 화면의 오류 문구를 그대로 알려 주세요.

## 1. 저장소 받기와 프로젝트 생성

```sh
git clone https://github.com/yazzang-homelab/gajae-mobile.git
cd gajae-mobile
cd ios
xcodegen generate
open GjcMobile.xcodeproj
```

Xcode가 패키지(swift-crypto, swift-asn1)를 받는 동안 기다립니다. 이 단계에서 로컬 빌드는 하지 않아도 됩니다.

## 2. Apple ID 연결

Xcode → Settings(⌘,) → Accounts → `+` → Apple ID. 로그인 후 팀 목록에 `6Z6SXY7BTZ`가 보이는지 확인합니다.

프로젝트 설정에서 타깃 `GjcMobile` → Signing & Capabilities의 Team이 그 팀으로 잡혀 있어야 합니다(`project.yml`에 지정돼 있음).

## 3. Xcode Cloud 시작

1. Integrate 메뉴 → **Create Workflow…** (또는 왼쪽 Report navigator(⌘9) → **Cloud** 탭 → **Get Started**).
2. 제품: `GjcMobile` 앱을 고릅니다.
   - App Store Connect에 `dev.gajae.gjcmobile` 앱 레코드가 없으면 마법사가 만들어 줍니다. 이름은 **가재코드**, 기본 언어 한국어, SKU는 `gjcmobile`. 마법사에서 안 되면 App Store Connect 웹(앱 → `+` → 신규 앱)에서 만들고 다시 시도합니다.
3. 워크플로 편집 화면이 나오면 4절 표대로 첫 워크플로를 `TestFlight`로 만듭니다.
4. **Grant Access to Your Source Code**: 브라우저로 App Store Connect가 열립니다.
   - GitHub를 고르고 `yazzang-homelab` 조직에 **Xcode Cloud** GitHub App을 설치합니다. 저장소는 `gajae-mobile`만 선택해도 됩니다.
   - swift-crypto, swift-asn1은 공개 저장소라 추가 권한이 필요 없습니다. 추가 저장소 접근을 묻는 화면이 나오면 그대로 진행합니다.
5. Xcode로 돌아와 **Complete**. 첫 빌드를 바로 시작하자고 하면 5절대로 브랜치를 고릅니다.

## 4. 워크플로 설정

워크플로는 Xcode(Report navigator → Cloud → 워크플로 우클릭 → Edit Workflow) 또는 App Store Connect 웹(앱 → Xcode Cloud → Manage Workflows)에서 고칩니다.

### `TestFlight` (배포용)

| 항목 | 값 |
|---|---|
| General | 이름 `TestFlight`, Repository and Project or Workspace: `ios/GjcMobile.xcodeproj` |
| Environment | Xcode: Latest Release, macOS: Latest Release, Clean: 켬 |
| Start Conditions | Branch Changes → Branch `main`. Auto-cancel Builds 켬 |
| Actions | **Archive – iOS**, Scheme `GjcMobile`, Deployment Preparation: **TestFlight and App Store** |
| Environment Variables | `GJCM_DEMO_OFFER_URL`: 심사용 데모 호스트의 `/offer` URL. `ci_post_clone.sh`가 빌드에 넣으며, 비우면 앱이 "데모로 체험" 버튼을 숨깁니다 |
| Post-Actions | **TestFlight Internal Testing** → 그룹 `내부`(6절에서 만든 그룹) |

### `PR` (검증용)

| 항목 | 값 |
|---|---|
| General | 이름 `PR`, 같은 프로젝트 |
| Start Conditions | Pull Request Changes → Source: Any Branch, Target: `dev` |
| Actions | **Build – iOS**, Scheme `GjcMobile`, Platform: Any iOS Simulator Device |
| Post-Actions | 없음 |

`ios/Core`의 단위 테스트(`swift test`)는 앱 스킴에 들어 있지 않아 Xcode Cloud에서 돌지 않습니다. Linux에서 `cd ios/Core && swift test`로 확인합니다.

## 5. 첫 빌드

Report navigator → Cloud → `TestFlight` 워크플로 우클릭 → **Start Build…** → 브랜치 `main`.

App Store Connect 웹 → 앱 → Xcode Cloud → Settings → **Build Number**에서 다음 빌드 번호를 정할 수 있습니다. 같은 버전(0.1.0)으로 이미 올린 빌드가 있으면 그보다 크게(예: `100000`) 잡습니다. 처음이면 그대로 둡니다.

빌드 로그에서 확인할 것:

1. `ci_post_clone.sh` 단계에 `xcodegen generate` → `Resolve Package Graph` 출력이 있고 성공.
2. Archive 성공 → TestFlight 업로드 → App Store Connect 처리(10~30분).

## 6. TestFlight 내부 테스트

1. App Store Connect → 앱 → TestFlight → 내부 테스트 → `+`로 그룹 `내부` 생성, 본인 Apple ID 추가. 자동 배포 켬.
2. iPhone에 TestFlight 앱 설치 → 초대 메일 또는 TestFlight 앱에서 가재코드 설치.
3. 수출 규정 질문은 나오지 않습니다(`ITSAppUsesNonExemptEncryption: false`).

내부 테스트는 심사가 없고 기기 등록도 필요 없습니다.

## 7. 실패할 때

| 증상 | 원인과 조치 |
|---|---|
| `a resolved file is required when automatic dependency resolution is disabled` | `ci_post_clone.sh`가 안 돌았습니다. 빌드한 브랜치에 `ios/ci_scripts/ci_post_clone.sh`가 있는지, 실행 권한(100755)이 있는지 확인합니다. 스크립트는 프로젝트(`ios/`)와 같은 폴더의 `ci_scripts`에 있어야 합니다. |
| `xcodegen: command not found` / brew 실패 | Xcode Cloud의 Homebrew 일시 장애입니다. 다시 빌드합니다. |
| `Could not find … GjcMobile.xcodeproj` (클론 직후) | 워크플로의 프로젝트 경로가 `ios/GjcMobile.xcodeproj`인지 확인합니다. |
| 서명 오류(`No profiles`, `No Account for Team`) | 워크플로를 만든 Apple ID 권한과 `project.yml`의 `DEVELOPMENT_TEAM`(`6Z6SXY7BTZ`)을 확인합니다. Xcode Cloud가 배포 인증서와 프로파일을 자동으로 만듭니다. |
| 업로드 후 `Invalid Binary`·`ITMS-` 메일 | 메일 본문을 그대로 이슈 #28에 붙여 주세요. |

막히면 Xcode Cloud 빌드 로그(빌드 → Logs → 실패한 단계 → 전체 로그 다운로드)를 이슈 #28에 올려 주세요. 그 로그를 보고 저장소 쪽을 고칩니다.
