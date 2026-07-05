# Git Workflow Rules (Cross-Cutting Concern)

Applies to all agents.

## Commits

- **Message format**: `- [x] <English imperative description>`
- All tests MUST pass before committing (see shared-testing.md)
- `--no-verify` / `--no-gpg-sign` are **STRICTLY FORBIDDEN** in normal flow
  - Agent execution context without configured signing key → configure SSH/GPG key OR set `git config commit.gpgsign false` explicitly (silent `--no-verify` bypass remains forbidden)
- Stage only changed files via `git add` — `git add .` / `git add -A` are FORBIDDEN

### Subject Line

- **Compression target, not a hard cap**: aim for ~50 characters as a recommended target (GitHub UI truncation point, `git log --oneline` ergonomics). The author's job is to find the most compressed phrasing that conveys the change's purpose — counting characters is the wrong frame.
- **Language & tone (English)**: write subjects in English imperative mood (`Add login button`, not `Added login button`); Korean subjects are no longer used — this is a public OSS repository. Bodies are English as well.
- **Conventional Commits prefix** (`feat:`, `fix:`, etc.): optional. When used, place after the checkbox: `- [x] feat: <description>`.

### Subject and Body

- **Blank line REQUIRED** between subject and body whenever a body exists — git tooling (`log`, `shortlog`, `rebase`) parses on this boundary.
- **Body is optional** — write one only when the "why" of the change is not self-evident from the subject and diff.
- **Issue / ticket references**: place in a footer block separated from the body by a blank line, formatted as `Refs: #123` or `Refs: YOAIDA-926`.

### Body Content

- **Why over what**: the diff already shows what changed; the body explains why the change was needed. Implementation detail (how) belongs in the code, not the message.
- **Inverted-pyramid ordering**: lead with the most important "why" sentence; supporting context follows.
- **Meaning-unit wrapping**: break lines at clause / sentence / list-item boundaries. Identifiers (function names, file paths, hooks, tokens) MUST NEVER be split across lines. No fixed character cap — the author chooses break points that preserve readability. Short clauses (≤ ~10 words) stay on one line.
- **Conciseness**: every sentence MUST add information not already conveyed by the subject or a prior body sentence. No formal greetings, no exaggerated adjectives (`very important`, `really cleanly`).
- **Bullet form by default**: body content MUST be written as bullets; prose paragraphs are admitted ONLY when the change is a single causal narrative whose steps cannot decompose into 3+ independent bullets without breaking the chain. Meaning-unit wrapping still applies inside each bullet, and Conciseness still requires every bullet (and every prose sentence under the admission) to add new information.

### Anti-patterns

- **Chained single-line subjects**: stacking unrelated changes onto one subject via `—`, `·`, or `:` connectors.
- **Diff-restating body**: rephrasing what the diff already shows (`Changed X to Y` when the diff makes that visible).
- **Subject-body redundancy**: subject and body conveying the same fact in different words.
- **Non-imperative subjects**: `Added login button`, `Adding login button` — use imperative mood (`Add login button`) instead.

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

- **Title** MUST be under 70 characters · **body** MUST include Summary + Test Plan
- Diffs exceeding 400 lines → split for review
- **`.html` primary deliverables**: storage model (single HTML in monitor-internal root, no MD companion) per `scope-report.md` / `scope-planning.md` Output Format Routing Emission contract. Git-only PR conclusions:
  - **PR semantic diff target** = the plan MD body + monitor code changes.
  - **Monitor-internal root** (`$CLAUDED_DOCS_HTML_ROOT`) git-excluded via `monitor/.gitignore` `data/*` — outside PR review scope.

## Dangerous Commands

- `reset --hard` / `checkout .` / `clean -f` → permitted **ONLY after user confirmation**
- `rebase -i` / `add -i` → **interactive mode is FORBIDDEN** (not supported)
- AI agent `git push --force` without explicit user approval → FORBIDDEN (force-push rule applies even more strictly to autonomous agents)

> See the central **Rationalization Rejection Table** in [[GLASS_ATRIUM_GLOBAL_RULES#Rationalization Rejection Table (Central)]]
