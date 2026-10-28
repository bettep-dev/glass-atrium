# Maintainer note — `rules/glass-atrium/core-git-workflow.md`

Corpus-maintenance companion to that Tier-1 rule file. The rule file reaches every agent on the host channel; this note reaches none. Read it before editing the rule file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading and no pointer to this note.

## Coupled readers

- No test reads the rule file's body text.
- Path readers — renaming the file is a multi-site edit:
  - `rules/glass-atrium/core-compliance-matrix.md` lists the path as a Tier-1 bullet and a matrix row; `hooks/validate-compliance-matrix.sh` pairs the two.
  - `scripts/fixtures/retired-seed.json` carries the retired `rules/core-git-workflow.md` path.
- Code comments that cite the rule file — reword the cited rule and these go stale:
  - `hooks/block-no-verify.sh` names `core-git-workflow.md -> Commits` in its block message.
  - `hooks/validate-large-diff.sh` cites the 400-line split rule.
  - `hooks/advisory-worktree-writer-lock.sh` cites the SHARED contract's `memory/progress-*.md` checkpoint path as a sanctioned write.
  - `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_DIFF_PATTERNS` names a git-workflow rule-prose line as a residual fire of the force-push rows. No line in the rule file carries `git push`, so the comment names no current line; `autoagent/` is frozen, so it is a flag, not an edit.
- Cited headings and leads — grep the corpus before renaming one:
  - `## Commits` → `### Concurrent worktree` and its leads **Shared index**, **Whole-tree regeneration**, **Index-owner rule**, **Regeneration barrier** — cited by:
    - `skills/glass-atrium-ops-orchestrator-role.md` guardrail (a)
    - `skills/glass-atrium-ops-orchestrator.md`
    - `skills/glass-atrium-ops-delegation-contracts/references/automatic-parallelization.md`
    - `scoped/maintainers/glass-atrium-dev-shell.md`
    - `scoped/maintainers/orchestrator-role.md`
  - `skills/glass-atrium-ops-delegation-contracts/references/automatic-parallelization.md` cites `### Concurrent worktree` for the delegation-side contract, which carries the INDEX OWNER permission and the no-contract default, so both stay under that heading.
  - `### Worktree occupancy` and its leads **Entry precondition**, **Who commits**, **Read-only**: `skills/glass-atrium-ops-delegation-contracts/references/automatic-parallelization.md` → **Agent-binding half of guardrail (a)** · `scoped/maintainers/glass-atrium-dev-shell.md` (**Who commits**).
    - The agent-binding pointers name both H3s (`Commits → **Concurrent worktree** · **Worktree occupancy**`):
      - `skills/glass-atrium-ops-orchestrator-role.md` guardrail (a)
      - `skills/glass-atrium-ops-orchestrator.md` ("the agent-binding worktree rules")
      - `scoped/maintainers/orchestrator-role.md` → `#### Automatic Parallelization`
    - A pointer to one heading stops at the next heading, so a pointer meant to carry **Who commits** names `### Worktree occupancy` or `## Commits`.
  - `## Pull Requests` → **Merge authorization**: `skills/glass-atrium-ops-delegation-contracts/references/live-deploy-gate.md`.
- Literals copied verbatim into delegation prompts: the two `worktree <path> — …` contract lines. Keep them byte-identical.
- Canonical + mirror: `CONTRIBUTING.md` → `## Commits, branches, and PRs` restates the subject format, body, `--no-verify` ban, branch naming and PR contract for human contributors.
  - Drift, reported: the mirror says never use `--no-verify`, the rule says "in normal flow".

## Moved out of the rule file

Illustrations no agent needs in order to act; the rule each one illustrates stays.

- **Whole-tree regeneration** example: `scripts/generate-manifest.sh` takes its file list from `git ls-files` but its hashes from the working tree, so a run beside another track's uncommitted edits writes hashes that match no commit.
- **Read-only** rationale: both halves are required — a reviewer fixing a typo modifies a tracked path, and a reviewer running `git stash` to peek at a clean tree destroys the owner's staged work without modifying one.

## Restructure + diet pass — dispositions

- Shape cap: `### Concurrent worktree` is split to clear the 3 KB H3 cap.
  - The split: **Entry precondition**, **Who commits** and **Read-only** moved byte-identical into the sibling `### Worktree occupancy`, directly below it.
  - Every lead an external site cites under `### Concurrent worktree` stays there, with both `worktree <path> — …` literals and the no-contract default.
  - The surviving rule text keeps its exact wording and capitals, because git text is a fragile operation.
  - The index-mutation bullet, the second-agent bullet and the non-empty-index bullet were split at their sentence boundaries (one line, one rule).
- Dropped from `### Concurrent worktree`:
  - "The rules below are cumulative …": a restatement, not a carrier of non-discharge. Each remaining rule binds unconditionally in its own text — the entry precondition applies to every index owner, the barrier requires no other writer anywhere in the tree, and NEITHER token grants the barrier.
  - "Neither staging discipline nor sequencing index mutators makes it safe …": restated the regeneration lead and the barrier's "no other agent is writing anywhere in that tree".
  - "Sequential succession is not isolation.": restated the entry-precondition lead.
- Kept on review: both **Who commits** sub-bullets, byte-identical.
  - The orchestrator commit ban lives only here: `## Orchestrator Identity` names no commit, and no other corpus site bans it.
  - The merge carve-out is the sole link to `skills/glass-atrium-ops-orchestrator.md` → **Commit strategy** (the post-Wave integration merge); without it that merge collides with the **Who commits** lead.
  - **Merge authorization** covers only `gh pr ready` / `gh pr merge` on a cycle's PRs, a different act.
  - Moving the ban into `rules/glass-atrium/orchestrator-role.md` is a cross-file move: it needs that file's startup budget and the frozen-pin check.
- `### Subject Line` → **Language & tone (English)** became **Imperative mood**, carrying the mood examples and the body-language sentence as a sub-bullet.
  - Single site: its "write subjects in English" clause restated **Message format** (`- [x] <English imperative description>`) — pair class redundant. **Message format** is the canonical and stays byte-identical, because `CONTRIBUTING.md` mirrors its literal.
- Kept on review: "Bodies are English as well (public OSS repository, no Korean subjects)", byte-identical — fragile rule wording; cutting it widens the rule.
  - Flag, not a cut: it overlaps `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language`, which lets a user request a non-English deliverable; this sentence admits no such exception.
- `### Anti-patterns` was dropped: its two bullets restated **Why over what** and **Conciseness**. No site cited the heading.
- `## Pull Requests`:
  - The `.html` primary-deliverable bullet was dropped (의미 상충).
    - Every deliverable body, MD included, is POSTed to the git-excluded monitor-internal root (`scoped/scope-report.md` → `### Emission contract`), so "the plan MD body" was never in a PR diff.
    - The rest restated what `.gitignore` already enforces.
  - "Direct push to main stays FORBIDDEN … force-push rules are unchanged" was dropped: it restated `## Branches` and `## Dangerous Commands`, which **Merge authorization** does not relax.
- Kept on review: "(see shared-testing.md)" under `## Commits` — `scoped/maintainers/shared-testing.md` records the commit rule's which-tests-when half as deferred there.
- Kept on review: "(silent `--no-verify` bypass remains forbidden)" under the `--no-verify` bullet.
  - The parent ban binds "in normal flow"; a missing signing key reads as abnormal flow, so the parenthetical keeps the ban alive there.
  - `hooks/block-no-verify.sh` gives the same remedy in its block message.
- `### Subject Line` → **Compression target, not a hard cap**: "as a recommended target" dropped; the lead already says the target is soft.
- Walked and kept as is, nothing failing a diet component: `### Subject and Body` · `### Body Content` · `## AI Commit Attribution` · `## Branches` · the rest of `## Pull Requests` · `## Dangerous Commands` (its honest-backing note stays) · `## Rationalization Rejection (Git)`.
