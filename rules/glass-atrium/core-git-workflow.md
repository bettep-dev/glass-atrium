# Git Workflow Rules (Cross-Cutting Concern)

Applies to all agents.

## Commits

- **Message format**: `- [x] <English imperative description>`
- All tests MUST pass before committing (see shared-testing.md)
- `--no-verify` / `--no-gpg-sign` are **STRICTLY FORBIDDEN** in normal flow
  - Agent execution context without configured signing key → configure SSH/GPG key OR set `git config commit.gpgsign false` explicitly (silent `--no-verify` bypass remains forbidden)
- Stage only changed files via `git add` — `git add .` / `git add -A` are FORBIDDEN

### Concurrent worktree

- Mechanisms that defeat file-set partitioning, which the rules below answer:
  - **Shared index** — a worktree has exactly ONE index, shared by every process in it: a plain `git commit` commits every path another track already `git add`-ed, and `git commit -a` also sweeps unstaged edits to tracked files.
  - **Whole-tree regeneration** (manifest, lockfile, index file) reads the tree, not the index.
    - Example: `scripts/generate-manifest.sh` takes its file list from `git ls-files` but its hashes from the working tree, so a run beside another track's uncommitted edits writes hashes that match no commit.
- Index mutation is **any command that writes the index or moves HEAD** — `add`, `rm`, `mv`, `reset`, `restore`, `checkout`, `stash`, `commit`, `merge`, `rebase`, `cherry-pick`, `apply --index`. The list gives examples of the class, not the class itself; if unsure, treat a command as index mutation.
- The rules below are cumulative — each binds on its own, and satisfying one never discharges another.
- **Delegation-side half (binds the agent, not only the composer)**: every delegation into a worktree MUST state one of these contracts in the prompt:
  - `worktree <path> — INDEX OWNER: commit your own work`
  - `worktree <path> — SHARED: do NOT mutate the index (see the class above); checkpoint to ~/.claude-personal/projects/<home-encoded>/memory/progress-*.md instead`
  - Placed in a worktree alongside other concurrent tracks by a delegation that states no contract → treat it as SHARED (the contract above) and ask rather than committing.
  - The token is INDEX OWNER, not SOLE OWNER: it grants sole INDEX MUTATION, not sole presence.
  - An agent-body obligation to commit incrementally is conditional on holding INDEX OWNER.
  - An agent-body obligation to run a whole-tree regeneration is conditional on the regeneration barrier, which NEITHER token grants — a delegation that wants one states the exclusive-tree grant explicitly.
- **Index-owner rule** (answers the shared index): at most ONE index-mutating agent per worktree at a time.
  - A second index-mutating agent enters only through its own worktree. Where no second worktree is available the two tracks run **SEQUENTIALLY** — the parallel default yields rather than proceeding on file-disjointness alone.
- **Regeneration barrier** (answers whole-tree regeneration): a regeneration is a BARRIER, not an index operation.
  - Run it only when no other agent is writing anywhere in that tree, and commit its output before releasing the tree.
  - Neither staging discipline nor sequencing index mutators makes it safe: a regeneration reads files, not the index.
- **Entry precondition**: an index owner inherits whatever the last occupant left staged.
  - Before mutating the index in a worktree, confirm `git diff --cached --quiet` passes.
  - A non-empty index belongs to a predecessor — a track killed at its budget cap between `git add` and commit leaves exactly this state. Do not commit it or build on it; report it and have the predecessor's owner resolve it.
  - Sequential succession is not isolation.
- **Who commits**: an agent commits its OWN work, in a worktree where it is the index owner.
  - The orchestrator does not AUTHOR a commit of another agent's changes (`orchestrator-role.md` → `## Orchestrator Identity` — execution is forbidden).
  - An integration **merge** of an already-committed branch under the Merge-authorization rule (`## Pull Requests` below) is a different act and is unaffected; `skills/glass-atrium-ops-orchestrator.md` → `**Commit strategy**` describes that merge.
- **Read-only** means **mutates no index AND modifies no tracked path** in the worktree; read-only tracks may share a worktree freely.
  - Both halves are required: a reviewer fixing a typo modifies a tracked path, and a reviewer running `git stash` to peek at a clean tree destroys the owner's staged work without modifying one.

### Subject Line

- **Compression target, not a hard cap**: aim for ~50 characters as a recommended target (GitHub UI truncation point, `git log --oneline` ergonomics).
- **Language & tone (English)**: write subjects in English imperative mood — `Add login button`, not `Added login button` / `Adding login button`. Bodies are English as well (public OSS repository, no Korean subjects).
- **Conventional Commits prefix** (`feat:`, `fix:`, etc.): optional. When used, place after the checkbox: `- [x] feat: <description>`.

### Subject and Body

- **Blank line REQUIRED** between subject and body whenever a body exists — git tooling (`log`, `shortlog`, `rebase`) parses on this boundary.
- **Body is optional** — write one only when the "why" of the change is not self-evident from the subject and diff.
- **Issue / ticket references**: place in a footer block separated from the body by a blank line, formatted as `Refs: #123` or `Refs: PROJ-123`.

### Body Content

- **Why over what**: the diff already shows what changed; the body explains why the change was needed. Implementation detail (how) belongs in the code, not the message.
- **Inverted-pyramid ordering**: lead with the most important "why" sentence; supporting context follows.
- **Conciseness**: every sentence MUST add information not already conveyed by the subject or a prior body sentence. No formal greetings, no exaggerated adjectives (`very important`, `really cleanly`).
- **Body shape**: bullets suit a body carrying 3+ independent facts; prose suits one causal chain.

### Anti-patterns

- **Diff-restating body**: rephrasing what the diff already shows (`Changed X to Y` when the diff makes that visible).
- **Subject-body redundancy**: subject and body conveying the same fact in different words.

## AI Commit Attribution

- AI agent-generated commits MUST use dedicated trailers, not `Co-Authored-By` (which is reserved for human collaborators):
  - `Coding-Agent: Claude Code` (or other agent name)
  - `Model: <model-id>` — records the **actual model that ran** (tracks settings.json `model`); do NOT hardcode a fixed version string
- Multi-stage agents (different models per stage) → declare per-stage in `Model:` trailer:
  - Example: `Model: plan=<plan-model-id>, edit=<edit-model-id>` (each `<…>` = the actual model used for that stage)
- Human collaborator + AI together → use BOTH `Co-Authored-By` (human) AND `Coding-Agent:` (AI), do not conflate.

## Branches

- **Naming**: features `feature/<feature-name>` · bugs `fix/<issue-name>`
- **Merging**: direct push to main is FORBIDDEN · merging MUST go through a PR
- **Force push**: permitted ONLY when the user explicitly requests it

## Pull Requests

- **Title** MUST be under 70 characters
- **Body** MUST include Summary + Test Plan
- Diffs exceeding 400 lines → split for review
- **`.html` primary deliverables**: storage model (single HTML in monitor-internal root, no MD companion) per `scope-report.md` → Output Format Routing → Emission contract. Git-only conclusions for PR review:
  - **PR semantic diff target** = the plan MD body + monitor code changes.
  - **Monitor-internal root** (`$CLAUDED_DOCS_HTML_ROOT`) git-excluded via the repo-root `.gitignore` `monitor/data/*` entry (folded from the former `monitor/.gitignore` per its comment) — outside PR review scope.
- **Merge authorization**: the orchestrator MAY execute `gh pr ready <n>` + `gh pr merge <n> --merge` for a cycle's PRs ONCE the user has EXPLICITLY approved merging that cycle.
  - Approval is per-cycle and per-PR-set — never standing; silence or a past cycle's approval does NOT carry over.
  - **Preconditions** (all of the following):
    - ALL CI checks green — a failed check = absolute stop.
    - No `--admin` / branch-protection bypass of any kind.
    - Merge-commit method (`--merge`) unless the user asks otherwise.
  - Direct push to main stays FORBIDDEN (see Branches) and force-push rules are unchanged.

## Dangerous Commands

| Command | Rule |
|---------|------|
| `reset --hard` / `checkout .` / `clean -f` | Permitted **ONLY after user confirmation** |
| `rebase -i` / `add -i` | **Interactive mode is FORBIDDEN** (not supported) |
| `git push --force` by an AI agent, without explicit user approval | **FORBIDDEN** — the force-push rule applies even more strictly to autonomous agents |

## Rationalization Rejection (Git)

| Excuse | Rebuttal |
|--------|----------|
| "It's just a small fix, I'll push directly to main" | Small fixes cause the largest outages · every change goes through a PR regardless of size |
| "I'll squash the commits later" | "Later" = merge conflicts + lost context · write clean commits from the start |
| "Tests are passing locally, no need to wait for CI" | Local env ≠ CI env · CI catches dependency + configuration issues local runs miss |
