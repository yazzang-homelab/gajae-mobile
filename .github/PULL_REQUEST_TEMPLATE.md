## What

<!-- 무엇을 바꿨나요 · Brief description -->

## Why

Closes #

## Testing

<!-- 실행한 검증 · How it was tested (see AGENTS.md "검증") -->

---

- [ ] Target branch is `dev` (release PRs: `dev` → `main`, merge commit)
- [ ] Bridge: `bun test && bun x tsc --noEmit -p .` / Android: `./gradlew :app:testDebugUnitTest` / iOS core: `swift test` — whichever applies
- [ ] No question/command text or transcript content leaves the E2EE channel (widgets, notifications, logs)
