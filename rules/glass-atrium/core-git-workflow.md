# Git Workflow Rules (Cross-Cutting Concern)

Applies to all agents.

## Commits

- **Message format**: `- [x] <English imperative description>`
  - Bodies are English as well (public OSS repository, no Korean subjects).
  - A Conventional Commits prefix (`feat:`, `fix:`) is optional; when used it follows the checkbox: `- [x] feat: <description>`.
- Commit only after the tests pass, so every commit is a working base for whoever builds on it (see `scoped/shared-testing.md`)
- `--no-verify` / `--no-gpg-sign` are forbidden in normal flow: they skip the pre-commit hooks and signing that vet every commit (`hooks/block-no-verify.sh` blocks them)
  - Agent execution context without configured signing key → configure SSH/GPG key or set `git config commit.gpgsign false` explicitly (silent `--no-verify` bypass remains forbidden)
- Stage changed files by explicit path — `git add .` / `git add -A` are forbidden: they sweep in unrelated files and other tracks' work

### Concurrent worktree

- Mechanisms that defeat file-set partitioning, which the rules below answer:
  - **Shared index** — a worktree has exactly one index, shared by every process in it: a plain `git commit` commits every path another track already `git add`-ed, and `git commit -a` also sweeps unstaged edits to tracked files.
  - **Whole-tree regeneration** (manifest, lockfile, index file) reads the tree, not the index.
- Index mutation is **any command that writes the index or moves HEAD** — `add`, `rm`, `mv`, `reset`, `restore`, `checkout`, `stash`, `commit`, `merge`, `rebase`, `cherry-pick`, `apply --index`.
  - The list gives examples of the class, not the class itself; if unsure, treat a command as index mutation.
- **Delegation-side half (binds the agent, not only the composer)**: every delegation into a worktree must state one of these contracts in the prompt:
  - `worktree <path> — INDEX OWNER: commit your own work`
  - `worktree <path> — SHARED: do NOT mutate the index (see the class above); checkpoint to ~/.claude-personal/projects/<home-encoded>/memory/progress-*.md instead`
  - Placed in a worktree alongside other concurrent tracks by a delegation that states no contract → treat it as SHARED (the contract above) and ask rather than committing.
  - The token is INDEX OWNER, not SOLE OWNER: it grants sole index mutation, not sole presence.
  - An agent-body obligation to commit incrementally is conditional on holding INDEX OWNER.
  - An agent-body obligation to run a whole-tree regeneration is conditional on the regeneration barrier, which neither token grants — a delegation that wants one states the exclusive-tree grant explicitly.
- **Index-owner rule** (answers the shared index): at most one index-mutating agent per worktree at a time.
  - A second index-mutating agent enters only through its own worktree.
  - Where no second worktree is available the two tracks run sequentially — file-disjointness alone does not make a shared index safe.
- **Regeneration barrier** (answers whole-tree regeneration): a regeneration is a barrier, not an index operation.
  - Run it only when no other agent is writing anywhere in that tree.
  - Commit its output before releasing the tree.

### Worktree occupancy

- **Entry precondition**: an index owner inherits whatever the last occupant left staged.
  - Before mutating the index in a worktree, confirm `git diff --cached --quiet` passes.
  - A non-empty index belongs to a predecessor — a track killed at its budget cap between `git add` and commit leaves exactly this state.
  - Do not commit it or build on it; report it and have the predecessor's owner resolve it.
- **Who commits**: an agent commits its own work, in a worktree where it is the index owner.
  - The orchestrator does not author a commit of another agent's changes (`skills/glass-atrium-ops-orchestrator-role.md` → `## Orchestrator Identity` — execution is forbidden).
  - An integration **merge** of an already-committed branch under the Merge-authorization rule (`## Pull Requests` below) is a different act and is unaffected; `skills/glass-atrium-ops-orchestrator.md` → `**Commit strategy**` describes that merge.
- **Read-only** means **mutates no index and modifies no tracked path** in the worktree.
  - Read-only tracks may share a worktree freely.

### Subject and Body

- A blank line separates subject and body — git tooling (`log`, `shortlog`, `rebase`) parses on this boundary.
- **Body is optional** — write one only when the "why" of the change is not self-evident from the subject and diff; the diff already shows what changed.
- **Issue / ticket references**: a footer block after a blank line, as `Refs: #123` or `Refs: PROJ-123`.

## AI Commit Attribution

- AI agent-generated commits use dedicated trailers, not `Co-Authored-By`, which is reserved for human collaborators:
  - `Coding-Agent: Claude Code` (or other agent name)
  - `Model: <model-id>` — the actual model that ran (tracks settings.json `model`), never a hardcoded version string
- Multi-stage agents (different models per stage) declare each stage in the `Model:` trailer: `Model: plan=<plan-model-id>, edit=<edit-model-id>`.
- Human collaborator + AI together → both `Co-Authored-By` (human) and `Coding-Agent:` (AI).

## Branches

- **Naming**: features `feature/<feature-name>` · bugs `fix/<issue-name>`
- **Merging**: direct push to main is forbidden
  - Merging goes through a PR, where review and CI run.

## Pull Requests

- **Title**: under 70 characters
- **Body**: includes Summary + Test Plan
- Diffs exceeding 400 lines → split for review
- **Merge authorization**: the orchestrator may execute `gh pr ready <n>` + `gh pr merge <n> --merge` for a cycle's PRs once the user has explicitly approved merging that cycle.
  - Approval is per-cycle and per-PR-set — never standing; silence or a past cycle's approval does not carry over.
  - **Preconditions** (all of the following):
    - All CI checks green — a failed check stops the merge.
    - No `--admin` / branch-protection bypass of any kind.
    - Merge-commit method (`--merge`) unless the user asks otherwise.

## Dangerous Commands

| Command | Rule |
|---------|------|
| `reset --hard` / `checkout .` / `restore .` / `clean -f` / `push --force` | Hook-blocked for agents (`hooks/enforce-commit-guard.sh`) — on user confirmation, the user runs it |
| `rebase -i` / `add -i` | Not used — the agent shell cannot drive interactive mode |

- Honest backing: the guard matches fixed spellings; a spelling outside them passes it, and the rule still binds that spelling. Examples that pass:
  - a git global option before the subcommand — `git -C <path> …`, `git -c <k=v> …`
  - a bare `clean -f` or `clean -df`
  - `checkout -- .` and `restore -- .`
  - a `+<refspec>` push

## Rationalization Rejection (Git)

| Excuse | Rebuttal |
|--------|----------|
| "It's just a small fix, I'll push directly to main" | Small fixes cause the largest outages · every change goes through a PR regardless of size |
| "I'll squash the commits later" | "Later" = merge conflicts + lost context · write clean commits from the start |
| "Tests are passing locally, no need to wait for CI" | Local env ≠ CI env · CI catches dependency + configuration issues local runs miss |
