# gajae-mobile 작업 규칙

여러 에이전트 세션이 이 저장소를 동시에 만집니다. 같은 체크아웃에서 직접 커밋하면 한쪽 배포가 다른 쪽 변경을 빠뜨릴 수 있으므로 아래 흐름을 지킵니다.

## 변경 흐름: 이슈 → 워크트리 브랜치 → `dev` PR → 출시 PR

기본 브랜치는 `dev`입니다. 모든 작업은 최신 `origin/dev`에서 시작하고 `dev`로 합칩니다. `main`은 출시된 상태만 담습니다(GitHub Pages, 데모 호스트, 스토어 빌드가 `main`에서 나갑니다).

1. **이슈부터 엽니다.** `gh issue create`로 무엇을 왜 바꾸는지 적고, 아래 **착수 게이트**를 통과한 뒤에만 구현을 시작합니다.
2. **자기 워크트리에서 작업합니다.** 메인 체크아웃에서 직접 편집·커밋하지 않습니다.
   ```sh
   git fetch origin 'refs/heads/dev:refs/remotes/origin/dev'
   git worktree add ../gajae-mobile-wt/<이슈번호>-<짧은이름> -b issue/<이슈번호>-<짧은이름> origin/dev
   ```
3. **PR로 합칩니다.** 아래 **제출 게이트**를 통과한 뒤 `gh pr create --base dev`, 본문에 `Closes #<이슈번호>`(PR 템플릿을 채웁니다). 필수 체크(`bridge`, `ios`, `build`)가 통과한 뒤 `gh pr merge --squash --delete-branch`로 합칩니다. `dev`·`main`에 직접 push하지 않습니다.
4. **충돌은 리베이스로 풉니다.** 합치기 전에 `git fetch origin 'refs/heads/dev:refs/remotes/origin/dev' && git rebase origin/dev`, 테스트 재실행, `git push --force-with-lease`(자기 PR 브랜치에만).
5. **출시는 `dev` → `main` PR로 합니다.** 출시할 `dev`를 대상으로 `gh pr create --base main --head dev`를 열고 **merge commit**(`gh pr merge --merge`)으로 합칩니다. squash하면 `dev`와 `main` 이력이 갈라집니다.
6. **배포는 합쳐진 `main` 최신 커밋에서만 합니다.** 브리지 재시작과 OTA 서명(`tools/release-ota.sh <ci run id>`) 같은 배포는 PR 브랜치가 아니라 합친 뒤의 커밋으로 하며, 배포한 커밋 해시를 이슈·PR에 남깁니다. 그래야 다른 세션의 변경이 빠지지 않습니다.
7. 끝나면 `git worktree remove`로 워크트리를 정리합니다.

## 착수 게이트 — 검증됨 · 구현 가능 · 충돌 없음

사람이든 봇이든 세 가지를 이 순서로 확인하고, 첫 실패에서 멈춥니다. 결과는 이슈에 남기고 사람이 수락·보류·거절합니다. 자세한 기준은 [CONTRIBUTING.md](CONTRIBUTING.md).

1. **검증됨.** 현행 `dev` head(`git ls-remote origin refs/heads/dev`)에서 문제가 살아 있습니다. 버그는 **처음 설치한 사용자와 같은 깨끗한 상태**에서 재현합니다. 시도마다 새 `HOME`·`TMPDIR`(브리지: 페어링·키 없음), 새 Gradle 사용자 홈, 새로 만든 에뮬레이터(`-wipe-data`)를 쓰고, 그 커밋의 잠금 파일대로 받은 의존성만 쓰며, 재현 중에는 외부망을 쓰지 않습니다. 이슈에 실패 커밋이 적혀 있으면 그 커밋도 봅니다. 다른 검증자가 같은 커밋에서 결론을 반박해 보고 동의해야 확정합니다. 이전 상태가 있어야만 나는 것은 그 상태를 적고 보류합니다. 이미 고쳐졌으면 착수하지 않고 고친 커밋·PR을 알린 뒤 이슈를 닫습니다. iOS UI처럼 샌드박스에서 볼 수 없는 것은 관리자가 실제 기기에서 확인한 기록이 재현을 대신합니다. 기능은 `accepted` 라벨(관리자 수락)이 있어야 합니다. `git fetch origin dev`는 `origin/dev`를 갱신하지 않으므로 쓰지 않습니다.
2. **구현 가능.** 결함 하나(또는 수락된 기능 하나)를 기존 계약을 되살리는 최소 변경으로 고칩니다. 새 설정·임계치·정책, 저장 필드 추가, 사용자에게 보이는 의미 변경, 정답이 둘 이상인 문제는 **제품 결정**이므로 코드를 쓰지 않고 이슈에서 먼저 정합니다. 새 제품 표면, 피해자 없는 진단, 취향 리팩터, 전환 가드 테스트 없는 공유 의미 변경(브리지 프로토콜, E2EE 봉투, 위젯 캐시 계약)은 별도 결정 없이 하지 않습니다.
3. **충돌 없음.** 증상으로 `gh issue list --search … --state all`, `gh pr list --search … --state all`을 돌리고, 고칠 파일 목록을 열린 PR들의 파일(`gh api repos/yazzang-homelab/gajae-mobile/pulls/<n>/files`)과 대조합니다. 같은 파일을 만지는 열린 PR이 있으면 제목이 달라도 충돌입니다. 한 사람·한 봇이 동시에 진행하는 이슈는 하나입니다.

## 제출 게이트 — PR을 열기 직전

1. 명시 refspec으로 `dev`를 받아 리베이스하고, 리베이스된 head에서 검증을 다시 돌립니다.
2. diff가 착수 때 정한 파일 범위 안에 있습니다. 범위 밖 발견은 별도 이슈로 빼고 PR에는 한 줄만 적습니다. 리뷰 blocker를 막으려 새 메커니즘이 필요하면 수정이 틀린 것이고, 리뷰 두 번 뒤에도 blocker가 남으면 멈추고 사람에게 넘깁니다.
3. 실제로 돌린 명령과 결과를 PR에 적습니다. 테스트는 관찰 가능한 동작을 확인합니다(자리표시·동어반복 테스트 금지).
4. 선점 조회(위 3번)를 한 번 더 돌리고 쿼리와 결과를 PR에 적습니다.
5. 작성자가 아닌 독립 리뷰(리뷰어 에이전트 또는 사람)가 PR 본문에 exact head에 묶인 verdict 한 줄을 남깁니다. head가 바뀌면 무효입니다. `merge-approved`만 머지할 수 있고, 에이전트 리뷰는 조언이며 머지는 그 head에 대한 사람 승인으로 합니다.
   ```
   gajae.pr-review-verdict.v1 <merge-approved|merge-blocked|needs-human> sha256:<exact-head-sha> reviewer:<critic|architect|human> evidence:<확인한 것>
   ```

커밋 메시지는 conventional-commit 제목 + 왜를 적는 짧은 본문 + 해당하는 트레일러(`Tested:`, `Not-tested:`, `Scope-risk:`, `Closes #N`)입니다.

## 저장소 봇

관리자가 돌리는 이슈·PR 봇이 위 게이트를 적용합니다. 봇이 혼자 하는 일은 분류·라벨, 착수 게이트 점검(외부망·자격 증명 없는 격리 샌드박스에서 깨끗한 상태 재현과 교차검증 포함), `main` 대상 PR을 `dev`로 돌리기, 승인된 이슈를 자기 워크트리에서 구현·검증·독립 리뷰하는 것까지입니다. 착수, PR 열기, 코멘트, 닫기, 남의 PR 머지, 출시는 관리자가 텔레그램에서 승인해야 하고, 승인은 보여 준 이슈 내용·head 커밋에만 유효합니다. 응답이 없으면 아무것도 하지 않습니다. 봇이 다루지 않게 하려면 이슈에 `bot:skip` 라벨을 붙입니다.

## 검증

- 브리지: `cd bridge && bun test && bun x tsc --noEmit -p .`
- Android: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
- iOS: `cd ios/Core && swift test`(Swift 6 툴체인이 있으면 Linux에서도 실행됩니다). 앱은 CI(`ci` 워크플로, macOS)나 Xcode Cloud로 확인합니다.
