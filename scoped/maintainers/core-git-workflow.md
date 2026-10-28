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
- Code that cites the rule file — reword the cited rule and these go stale:
  - `hooks/block-no-verify.sh` names `core-git-workflow.md -> Commits` in its block message.
  - `hooks/validate-large-diff.sh` takes its `LARGE_DIFF_THRESHOLD=400` from the 400-line split rule, so that number stays unless the hook changes with it.
  - `hooks/advisory-worktree-writer-lock.sh` cites the SHARED contract's `memory/progress-*.md` checkpoint path as a sanctioned write.
  - `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_DIFF_PATTERNS` names a git-workflow rule-prose line as a residual fire of the force-push rows. No line in the rule file carries `git push`, so the comment names no current line; correct it when that file is next edited.
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
- Canonical + mirror:
  - `CONTRIBUTING.md` → `## Commits, branches, and PRs` restates the subject format, `--no-verify` ban, branch naming and PR contract for human contributors; **Message format** stays byte-identical because that mirror copies its literal.
    - Its commit-body guidance (optional, blank-line separated, explains why) has no counterpart in the rule file, which states only that bodies are English.
    - Drift, reported: the mirror says never use `--no-verify`, the rule says "in normal flow".
  - `.github/PULL_REQUEST_TEMPLATE.md` restates the 400-line split as a checklist item.

## Why kept items stay

- **Who commits**, both sub-bullets:
  - The orchestrator commit ban lives only here: `## Orchestrator Identity` names no commit, and no other corpus site bans it.
  - The merge carve-out is the sole link to `skills/glass-atrium-ops-orchestrator.md` → **Commit strategy** (the post-Wave integration merge); without it that merge collides with the **Who commits** lead.
- "Bodies are English as well (public OSS repository, no Korean subjects)": byte-identical, because cutting it widens the rule.
  - Flag: it overlaps `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language`, which lets a user request a non-English deliverable; this sentence admits no such exception.
- "(see `scoped/shared-testing.md`)" under `## Commits`: `scoped/maintainers/shared-testing.md` records the commit rule's which-tests-when half as deferred there.
- "(silent `--no-verify` bypass remains forbidden)": the parent ban binds "in normal flow", and a missing signing key reads as abnormal flow, so the parenthetical keeps the ban alive there. `hooks/block-no-verify.sh` gives the same remedy in its block message.

## Illustrations

No agent needs these in order to act; the rule each one illustrates stays in the rule file.

- **Whole-tree regeneration** example: `scripts/generate-manifest.sh` takes its file list from `git ls-files` but its hashes from the working tree, so a run beside another track's uncommitted edits writes hashes that match no commit.
- **Read-only** rationale: both halves are required — a reviewer fixing a typo modifies a tracked path, and a reviewer running `git stash` to peek at a clean tree destroys the owner's staged work without modifying one.
