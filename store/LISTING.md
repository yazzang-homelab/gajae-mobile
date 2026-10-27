# 스토어 등록 정보 (1.0.0)

App Store Connect와 Play Console에 그대로 붙여 넣는 값입니다. 앱 UI는 한국어 전용이므로 기본 언어는 한국어로 두고, 영어·중국어 설명에는 그 사실을 밝힙니다.

## 공통

| 항목 | 값 |
|---|---|
| 앱 이름 | 가재코드 |
| 번들 ID / 패키지 | `dev.gajae.gjcmobile` |
| 버전 | 1.0.0 (빌드 번호는 CI `run_number` + `000`) |
| 카테고리 | 개발자 도구 (App Store) / 도구 (Play) |
| 가격 | 무료, 광고·인앱 결제 없음 |
| 지원 URL | https://yazzang-homelab.github.io/gajae-mobile/ |
| 개인정보처리방침 URL | https://yazzang-homelab.github.io/gajae-mobile/privacy.html |
| 마케팅 URL | https://github.com/yazzang-homelab/gajae-mobile |
| 저작권 | © 2026 yazzang-homelab |

## 문구

### 한국어 (기본)

- 부제(30자): 내 컴퓨터의 코딩 에이전트를 휴대폰으로
- 홍보 문구: 에이전트가 묻고, 휴대폰이 답합니다. 명령 승인, 진행 중인 턴에 끼어들기, 응답을 기다리는 세션을 알려주는 홈·잠금화면 위젯.
- 키워드: 가재코드,gjc,코딩 에이전트,AI,원격,승인,터미널,개발자,위젯,종단간 암호화
- 설명:

```
가재코드 모바일은 내 컴퓨터에서 돌아가는 코딩 에이전트 가재코드(gjc)를 휴대폰에서 다루는 앱입니다.

• 휴대폰에서 승인: 에이전트가 명령을 실행하려 하면 알림이 오고, 허용하거나 거부합니다.
• 끼어들기와 중단: 진행 중인 턴에 지시를 넣거나, 다음 지시를 예약하거나, 멈춥니다.
• 홈·잠금화면 위젯: 내 답을 기다리는 세션과 작업 중인 세션을 보여주고, 누르면 그 세션이 바로 열립니다. 질문이나 명령 내용은 위젯에 표시하지 않습니다.
• 세션·모델·모드: 저장된 세션을 이어가고 검색하며, 모델·추론 강도·권한 모드를 바꿉니다.
• 사진·파일 첨부, 스트리밍 답변, 계획과 도구 실행 결과 보기.

에이전트와 세션, 모델 로그인 정보는 컴퓨터를 떠나지 않습니다. 휴대폰과 컴퓨터 사이는 종단 간 암호화(X25519, AES-256-GCM)되며, 개발자는 어떤 데이터도 수집하지 않습니다.

사용하려면 컴퓨터에 가재코드와 오픈소스 브리지(gjcm-bridge)를 설치하고 QR 코드로 페어링합니다. 컴퓨터가 없으면 첫 화면의 "컴퓨터 없이 데모로 체험"으로 정해진 응답만 돌려주는 데모 호스트에 연결해 둘러볼 수 있습니다.

소스 코드: https://github.com/yazzang-homelab/gajae-mobile (AGPL-3.0)
```

### English

- Subtitle (30 chars): Coding agent, on your phone
- Promotional text: Your agent asks. Your phone answers. Approve commands, steer running turns, and see waiting sessions on your home and lock screen.
- Keywords: gajae,gjc,coding agent,AI,remote,approve,terminal,developer,widget,e2ee
- Description:

```
Gajae Code mobile is a companion app for Gajae Code (gjc), the coding agent that runs on your own computer.

• Approve from your phone: when the agent wants to run a command you get a notification and allow or reject it.
• Steer and interrupt: send an instruction into a running turn, queue the next one, or stop it.
• Home and lock-screen widget: see which sessions are waiting for you or working, and open the waiting one in one tap. Question and command text never appear on the widget.
• Sessions, models, modes: resume and search saved sessions, switch model, reasoning effort and permission mode.
• Photo and file attachments, streamed answers, plans and tool results.

The agent, its sessions and your model logins never leave your computer. Phone and computer talk end-to-end encrypted (X25519, AES-256-GCM), and the developer collects no data.

To use it, install Gajae Code and the open-source bridge (gjcm-bridge) on your computer and pair with a QR code. No computer? Tap "컴퓨터 없이 데모로 체험" (try the demo) on the first screen to connect to a scripted demo host.

The app interface is in Korean.
Source code: https://github.com/yazzang-homelab/gajae-mobile (AGPL-3.0)
```

### 简体中文

- 副标题：把电脑上的编程智能体装进手机
- 推广文本：智能体提问，手机作答。批准命令、介入正在运行的回合，并在主屏幕和锁屏上查看等待中的会话。
- 关键词：gajae,gjc,编程智能体,AI,远程,批准,终端,开发者,小组件,端到端加密
- 描述：

```
Gajae Code mobile 是 Gajae Code（gjc）的伴侣应用。Gajae Code 是运行在你自己电脑上的编程智能体。

• 在手机上批准：智能体要执行命令时会通知你，你可以允许或拒绝。
• 介入与中断：向正在运行的回合插入指令、排队下一条指令，或直接停止。
• 主屏幕与锁屏小组件：查看哪些会话在等你、哪些正在运行，轻点即可打开等待中的会话。小组件不会显示问题或命令内容。
• 会话、模型、模式：继续并搜索已保存的会话，切换模型、推理强度和权限模式。
• 图片与文件附件、流式回答、计划与工具执行结果。

智能体、会话和模型登录信息都不会离开你的电脑。手机与电脑之间端到端加密（X25519、AES-256-GCM），开发者不收集任何数据。

使用前请在电脑上安装 Gajae Code 和开源桥接器（gjcm-bridge），然后扫码配对。没有电脑？在首页点击"컴퓨터 없이 데모로 체험"（试用演示），连接只返回脚本化回复的演示主机。

应用界面为韩文。
源代码：https://github.com/yazzang-homelab/gajae-mobile（AGPL-3.0）
```

## 심사 메모 (App Review / Play 앱 액세스 권한)

```
This app is a remote control for a coding agent that runs on the user's own computer; it has no accounts and no login.
To review without a computer, tap "컴퓨터 없이 데모로 체험" (Try the demo without a computer) on the first screen. It pairs with our public demo host, which returns scripted replies and executes nothing.
Suggested flow: send any message (e.g. "Run the test suite and fix any failures"); the demo asks for approval to run a command; tap "Allow once" or "Reject". Add the "가재코드 상태" widget from the Home Screen to see sessions waiting for an answer; tapping it opens that session.
The app uses only standard cryptography (X25519, AES-GCM) to protect the user's own data in transit (ITSAppUsesNonExemptEncryption = NO).
```

데모 호스트가 살아 있어야 합니다: 심사 제출 전에 `curl -s <GJCM_DEMO_OFFER_URL>`이 `{"url":…}`을 돌려주는지 확인합니다.

## 등급·설문

| 항목 | 답 |
|---|---|
| App Store 연령 등급 | 모든 항목 "없음" → 4+ |
| Play 콘텐츠 등급 (IARC) | 유틸리티·생산성, 폭력·성·약물·도박·사용자 간 상호작용 없음 |
| 앱 개인정보 (App Store) | 데이터를 수집하지 않음 |
| 데이터 보안 (Play) | 수집·공유하는 데이터 없음. 전송 중 암호화됨: 예. 삭제 요청: 해당 없음(수집 안 함) |
| 광고 | 없음 |
| 대상 연령 (Play) | 18세 이상 |
| 수출 규정 (암호화) | 표준 암호화만 사용, 면제 (`ITSAppUsesNonExemptEncryption: false`) |

## 스크린샷

| 위치 | 파일 | 규격 |
|---|---|---|
| App Store 6.9" iPhone | `store/ios/6.9-1.png` … `6.9-5.png` (승인 알림·카드, 위젯, 답변, 딥링크 승인 카드, 빈 화면) | 1320×2868 |
| Play 휴대폰 | `store/android/approve.png`, `answer.png`, `widget.png`, `home.png` | 1080×2400 |
| Play 그래픽 이미지 | `store/android/feature-graphic.png` | 1024×500 |
| Play 앱 아이콘 | `store/android/icon-512.png` | 512×512 |

iOS 스크린샷은 `ios-footage` 워크플로(`device: iPhone 16 Pro Max`)가 데모 호스트로 실제 앱을 돌리며 찍은 것입니다. 화면이 바뀌면 그 워크플로를 다시 돌려 교체합니다.

## 업로드 순서

1. **App Store:** App Store Connect에서 신규 앱(이름 가재코드, 기본 언어 한국어, 번들 ID `dev.gajae.gjcmobile`, SKU `gjcmobile`)을 만든 뒤 `appstore` 워크플로를 `upload=true`로 실행 → TestFlight 처리 → 위 정보 입력 → 심사 제출.
2. **Google Play:** Play Console에서 앱을 만들고 Play 앱 서명을 켠 뒤, `android` 워크플로를 수동 실행해 받은 `app-release.aab`를 첫 번째로 내부 테스트 트랙에 업로드 → 위 정보 입력 → 프로덕션 제출. (개인 개발자 계정은 프로덕션 전에 비공개 테스트 12명·14일 조건이 있습니다.)
