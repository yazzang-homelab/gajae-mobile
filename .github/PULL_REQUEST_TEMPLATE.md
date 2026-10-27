## What

<!-- 무엇을 바꿨나요. 파일 수, 소스·테스트 추가 줄을 나눠서 · What changed; files, source vs test lines -->

## Why

Closes #

## Testing

<!-- 실제로 돌린 명령과 결과 · Exact commands run and their results (AGENTS.md "검증") -->

## Preemption check

<!-- 선점 조회: 쿼리와 결과 · Queries and results: issue/PR search (--state all) and open PRs touching the same files -->

## Out of scope

<!-- 이번에 담지 않은 것, 따로 뺀 이슈, 남은 위험 · What is not included, split-off issues, remaining risk -->

## Review verdict

<!-- 작성자가 아닌 리뷰어가 exact head 에 묶어 남깁니다 · Written by an independent reviewer, bound to the exact head:
gajae.pr-review-verdict.v1 <merge-approved|merge-blocked|needs-human> sha256:<exact-head-sha> reviewer:<critic|architect|human> evidence:<…>
-->

---

- [ ] Target branch is `dev` (release PRs: `dev` → `main`, merge commit)
- [ ] Intake gate passed: verified on current `dev`, one minimal change, no conflicting open PR (CONTRIBUTING.md)
- [ ] Rebased on the current `dev` and re-verified on this head
- [ ] Bridge: `bun test && bun x tsc --noEmit -p .` / Android: `./gradlew :app:testDebugUnitTest` / iOS core: `swift test` — whichever applies
- [ ] No question/command text or transcript content leaves the E2EE channel (widgets, notifications, logs)
- [ ] The review verdict matches the exact head, not an earlier commit
