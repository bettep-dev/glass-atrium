# Maintainer note — `rules/glass-atrium/core-git-workflow.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent. Read it before editing the rule file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Coupled readers

- No test reads the rule file's body text.
- Renaming the file is a multi-site edit: grep the stem `git-workflow`, which also catches `scripts/audit-context.sh` → `rule_tier`.
  - `rules/glass-atrium/core-compliance-matrix.md` lists the path as a Tier-1 bullet and a matrix row; `hooks/validate-compliance-matrix.sh` pairs the two.
- Code that cites the rule file — reword the cited rule and these go stale:
  - `hooks/block-no-verify.sh` names `core-git-workflow.md -> Commits` in its block message and repeats the signing-key remedy.
  - `hooks/advisory-worktree-writer-lock.sh` cites the SHARED contract's `memory/progress-*.md` checkpoint path as a sanctioned write.
  - `autoagent/daemon_cycle.py` → `_SAFETY_SENSITIVE_DIFF_PATTERNS`: a comment names a git-workflow rule-prose line as a residual force-push fire.
    - No line in the rule file carries `git push`; correct the comment when `autoagent/daemon_cycle.py` is next edited.
- The 400-line split: `hooks/validate-large-diff.sh` → `LARGE_DIFF_THRESHOLD=400` and `.github/PULL_REQUEST_TEMPLATE.md` repeat the number, so it stays unless both change with it.
- Cited headings: `## Commits` · `### Concurrent worktree` · `### Worktree occupancy` · `## Pull Requests`.
- Cited leads: **Shared index** · **Whole-tree regeneration** · **Index-owner rule** · **Regeneration barrier** · **Entry precondition** · **Who commits** · **Read-only** · **Merge authorization**.
- Before renaming or moving one, grep the corpus for its bare name, case-insensitively, and edit every citer.
  - Why: `skills/glass-atrium-ops-delegation-contracts/references/automatic-parallelization.md` → **Honest backing** spells the leads in lower case.
- `skills/glass-atrium-ops-orchestrator-role.md` guardrail (a) cites `### Concurrent worktree` for the agent-binding rules; the delegation-side contract among them carries the INDEX OWNER permission and the no-contract default, so both stay under that heading.
- A pointer to one heading stops at the next heading: a pointer meant to carry **Who commits** names `### Worktree occupancy` or `## Commits`, and one meant to carry both H3s names both.
- Literals copied verbatim into delegation prompts: the two `worktree <path> — …` contract lines. Keep them byte-identical.
- Canonical + mirror: `CONTRIBUTING.md` → `## Commits, branches, and PRs` restates the subject format, `--no-verify` ban, branch naming and PR contract for human contributors.
  - **Message format** stays byte-identical because that mirror copies its literal.
  - Drift, reported: the mirror says never use `--no-verify`, the rule says "in normal flow".
  - Drift, reported: the mirror's commit-body guidance (optional, blank-line separated, explains why) has no counterpart in the rule file, which states only that bodies are English.

## Why kept items stay

- **Who commits**, all three sub-bullets:
  - The work-unit commit duty is the single home of committing at each green work-unit; `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `#### Work-unit checkpoint dimension` carries only a pointer to it.
  - The orchestrator commit ban lives only in the rule file: `## Orchestrator Identity` names no commit, and no other corpus site bans it.
  - The merge carve-out is the sole link to `skills/glass-atrium-ops-orchestrator.md` → **Commit strategy** (the post-Wave integration merge); without it that merge collides with the **Who commits** lead.
- "Bodies are English as well (public OSS repository, no Korean subjects)": byte-identical, because cutting it widens the rule.
  - Flag: it overlaps `agents/GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language`, which lets a user request a non-English deliverable; this sentence admits no such exception.
- The `scoped/shared-testing.md` → **Incremental commits** pointer in the `## Commits` tests-pass bullet: `scoped/maintainers/shared-testing.md` records the commit rule's which-tests-when half as deferred there, and the pointer keeps this Tier-1 line from reading as overriding that Tier-3 lead.
- "(silent `--no-verify` bypass remains forbidden)": the parent ban binds "in normal flow", and a missing signing key reads as abnormal flow, so the parenthetical keeps the ban alive there.
- **Regeneration barrier**: `scripts/generate-manifest.sh` takes its file list from `git ls-files` but its hashes from the working tree, so a run beside another track's uncommitted edits writes hashes that match no commit.
- **Read-only**, both halves: a reviewer fixing a typo modifies a tracked path, and a reviewer running `git stash` to peek at a clean tree destroys the owner's staged work without modifying one.
