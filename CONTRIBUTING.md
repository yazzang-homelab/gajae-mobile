# Contributing to gajae-mobile

This guide keeps work on `gajae-mobile` small, verified and conflict-free. It follows the rules of [Gajae Code](https://github.com/Yeachan-Heo/gajae-code/blob/dev/CONTRIBUTING.md) and adds two gates: an **intake gate** before work starts on an issue, and a **submission gate** before a pull request is opened. Agents working in this repository follow the same rules; see [AGENTS.md](AGENTS.md) for the agent-facing version.

## Branch policy

- Open pull requests against `dev`. `dev` is the default branch.
- `main` only receives release pull requests from `dev`, merged with a merge commit. A pull request against `main` from any other branch is retargeted to `dev`.
- Pages, the review demo host and store builds are published from `main`.

## Issues

Use the issue templates. A bug report needs the app and OS versions, the gjc version and the bridge commit, and steps to reproduce. Remove tokens, pairing codes and conversation content from logs. Problems in the agent itself belong in [Gajae Code](https://github.com/Yeachan-Heo/gajae-code/issues).

## Intake gate: before work starts

Nobody, human or bot, starts implementing an issue until all three checks pass, in this order. The first failure stops the check.

1. **Verified.** The problem is still present on the current `dev` head.
   - Read the head with `git ls-remote origin refs/heads/dev`.
   - Update with `git fetch origin 'refs/heads/dev:refs/remotes/origin/dev'`.
   - Do not use `git fetch origin dev`. It only updates `FETCH_HEAD` and leaves `origin/dev` stale.
   - For a bug, point at the file and line on that head where it happens, or reproduce it. If it was already fixed, close the issue with a pointer to the fix.
   - For a feature, verified means a maintainer has accepted the behaviour: the issue carries the `accepted` label.
2. **Implementable.** The change is one defect, or one accepted feature, with a minimal fix.
   - If the fix needs a product decision, it is a proposal, not a fix. Discuss it in the issue first and do not write code. Examples: a new setting, a new threshold or policy, a new stored field, a changed meaning of something the user sees, or two equally valid behaviours.
   - These are excluded without a separate decision:
     - new product surfaces;
     - diagnostics that help nobody;
     - refactors of taste;
     - changes to shared semantics (bridge protocol, E2EE envelope, widget cache contract) without a test for the failure case in the same PR.
3. **No conflict.** The work does not collide with anything already in flight.
   - Search issues and pull requests in every state for the symptom: `gh issue list --search … --state all` and `gh pr list --search … --state all`.
   - List the files you will touch. Compare them with the files of every open pull request (`gh api repos/yazzang-homelab/gajae-mobile/pulls/<n>/files`). Another open PR on the same files is a conflict even if its title is different.
   - Only one issue is in progress per person or bot at a time.

The result is recorded on the issue. A human accepts it, holds it or rejects it.

## Submission gate: before a pull request is opened

1. **Current base.** Fetch `dev` with the explicit refspec above and rebase onto it. Re-run the verification on the rebased head.
2. **One change, minimal.**
   - The diff stays inside the files named at intake. Out-of-scope findings become separate issues. The PR says one line about them and nothing more.
   - If a review finds a blocker that would need a new mechanism, the fix is wrong. Go back to a smaller fix or turn it into a proposal.
   - After two review rounds with blockers left, stop. It is a design question for a maintainer.
3. **Verification listed.**
   - The PR lists the exact commands that were run and their results. See the verification commands in [AGENTS.md](AGENTS.md).
   - Tests check observable behaviour. No placeholder or tautological tests.
4. **Preemption check again.** Run the searches and the same-files check from intake once more, right before opening. Put the queries and results in the PR.
5. **Review verdict bound to the head.** An independent review (a separate reviewer agent or a human, never the author) writes one line into the PR body:

   ```
   gajae.pr-review-verdict.v1 <merge-approved|merge-blocked|needs-human> sha256:<exact-head-sha> reviewer:<critic|architect|human> evidence:<what was checked>
   ```

   - The verdict is only valid for that head. A new commit or a rebase needs a new verdict.
   - Only `merge-approved` can be merged.
   - Agent reviews are advice. The human approval for the exact head is what allows the merge.

Merges to `dev` are squash merges after the required checks `bridge`, `ios` and `build` pass.

## Commit messages

Use a conventional-commit subject and a short body that explains why. Then add the trailers that apply, for example:

```
fix(widget): show "확인 필요" when the cache is older than 15 minutes

Tested: cd android && ./gradlew :app:testDebugUnitTest
Not-tested: iOS widget timeline on device
Scope-risk: narrow
Closes #12
```

## The repository bot

The maintainer runs an issue and pull-request bot that applies these gates.

**What it does on its own:**
- triages new issues and adds a type label;
- runs the intake checks;
- retargets pull requests opened against `main` to `dev`;
- implements an accepted issue in its own worktree from `origin/dev`;
- runs the submission checks and an independent review.

**What it never does on its own:**
- starts work on an issue;
- opens a pull request;
- posts a comment;
- closes an issue or pull request;
- merges a pull request from someone else;
- releases.

Each of those needs the maintainer's approval, and the approval is bound to the exact issue text or head commit it was shown. When the maintainer does not answer, nothing happens.

To keep the bot away from an issue, add the `bot:skip` label.
