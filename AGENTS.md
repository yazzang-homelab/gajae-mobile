# gajae-mobile 작업 규칙

여러 에이전트 세션이 이 저장소를 동시에 만집니다. 같은 체크아웃에서 직접 커밋하면 한쪽 배포가 다른 쪽 변경을 빠뜨릴 수 있으므로 아래 흐름을 지킵니다.

## 변경 흐름: 이슈 → 워크트리 브랜치 → PR

1. **이슈부터 엽니다.** `gh issue create`로 무엇을 왜 바꾸는지 적습니다. 같은 영역의 열린 이슈·PR이 있으면(`gh issue list`, `gh pr list`) 그 작업과 겹치지 않게 조율합니다.
2. **자기 워크트리에서 작업합니다.** 메인 체크아웃에서 직접 편집·커밋하지 않습니다.
   ```sh
   git fetch origin
   git worktree add ../gajae-mobile-wt/<이슈번호>-<짧은이름> -b issue/<이슈번호>-<짧은이름> origin/main
   ```
3. **PR로 합칩니다.** `gh pr create --base main`, 본문에 `Closes #<이슈번호>`. CI(`ci`, `android`)가 통과한 뒤 `gh pr merge --squash --delete-branch`로 합칩니다. `main`에 직접 push하지 않습니다.
4. **충돌은 리베이스로 풉니다.** 합치기 전에 `git fetch origin && git rebase origin/main`, 테스트 재실행, `git push --force-with-lease`(자기 PR 브랜치에만).
5. **배포는 합쳐진 `main` 최신 커밋에서만 합니다.** 브리지 재시작과 OTA 서명(`tools/release-ota.sh <ci run id>`) 같은 배포는 PR 브랜치가 아니라 합친 뒤의 커밋으로 하며, 배포한 커밋 해시를 이슈·PR에 남깁니다. 그래야 다른 세션의 변경이 빠지지 않습니다.
6. 끝나면 `git worktree remove`로 워크트리를 정리합니다.

## 검증

- 브리지: `cd bridge && bun test && bun x tsc --noEmit -p .`
- Android: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
- iOS: `cd ios/Core && swift test`(Swift 6 툴체인이 있으면 Linux에서도 실행됩니다). 앱은 CI(`ci` 워크플로, macOS)나 Xcode Cloud로 확인합니다.
