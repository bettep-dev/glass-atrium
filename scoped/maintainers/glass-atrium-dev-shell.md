# Maintainer note — agents/glass-atrium-dev-shell.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Budget-sizing bullets — why they are not a mirror

`hooks/test/inject-scope-rules-nodrop.bats` holds its own `BUDGET_DEV_CARRIERS` literal naming this agent and asserts that the DEV budget injection block is ABSENT for it: it is a carrier, excluded from the injected roster because the body carries the rule instead. The suite asserts no body prose.

- The intake-sizing bullet under `### Budget sizing` is consequently this agent's ONLY copy of the sizing rule — `scoped/shared-turn-budget.md` reaches no DEV agent at spawn — so deleting it as a duplicate deletes the rule while reddening nothing.
- The checkpoint and halt bullets beside it are a reference: the checkpoint itself is `GLASS_ATRIUM_GLOBAL_RULES.md` → Work-unit checkpoint dimension (host-delivered), and they keep only its delta: measure remaining budget at each checkpoint, and halt below 20%.
- The one-line guard blockquote in the body is scoped to the intake-sizing bullet and states the no-mirror fact on its own; it does not cite this note, per the companion-citation convention above.

The same suite sizes the injected turn-budget meter from the real frontmatter `maxTurns` and counts those bytes into a pinned worst-case DEV assembly total, so `maxTurns` is machine-read, not a free knob.

## Destructive-literal convention — kept in the body deliberately

The blockquote under the role line is maintainer-facing by audience, so the companion convention would move it here. It stays in the body because it protects the patchability of the file it sits in:

- The updater's sensitive-diff check scans ADDED lines of any patch to this body and cannot tell a rule forbidding a destructive command from a patch running it.
- On a match the merge planner refuses the file, while the cycle still reports success.
- Whoever patches this body must see the constraint at the point of editing. That includes the daemon's own editor, which reads the file and not this directory.
- Moving it out would leave the guard true and unread.

Its operative content, restated once here so the decision is auditable: every destructive command named in that body is written in words (verb plus flags), never as an invocation, and reflowing a line counts as adding it, so a literal form is never restored for tidiness.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/test/inject-scope-rules-nodrop.bats` | frontmatter `maxTurns`; its own `BUDGET_DEV_CARRIERS` literal names this agent | see above |
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | meter sizing |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) + fence-line count | blocked for every caller (LLM06); several suites additionally use a fake-HOME copy of this filename as a fixture, which is unaffected by repo-tree edits |
| the updater's sensitive-diff check | ADDED lines of any patch to this body | destructive-literal convention above |

## Decisions worth keeping

- **Naming subordination**: the `Match existing style` bullet under Work Rules points at `scoped/scope-dev.md` → Project Convention Probe, which carries the mirrored axes and subordinates identifier naming to the naming canon.
  - The bullet keeps only the shell naming delta: the `snake_case` function casing stated in the Functions bullet.
  - It sits INSIDE an editable region, so a live install with local edits resolves that region through a merge.
- The index-mutation class, both worktree contracts and the regeneration barrier are defined in Tier-1 `rules/glass-atrium/core-git-workflow.md` → Commits → **Concurrent worktree**, which reaches this agent on the host channel. Do not copy them into the body.
  - The body still keys its `### Concurrent-worktree contract` table on the delegation's worktree-contract line: only that line says which contract holds for a given run.
  - The body's barrier note under that heading restates the canonical's **Whole-tree regeneration** and **Regeneration barrier**, so it is a removable mirror (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)` → **Standing consequence**).
    - Removing it also removes the table's "(see the barrier note below)".
- **Early-exit pipe readers — the premise in its Why**: the race is keyed on the writer's write count, not on output past the pipe capacity.
  - Mechanism: bash line-buffers builtin stdout (one write per line) and an external stdio writer writes once per buffer, so a multi-line builtin value races an early reader at any size.
  - The same premise sits in the `hooks/lib/pipe-drain.sh` header and the `scripts/audit-pipe-drain.sh` header Why — canonical + mirror: keep the three in step and report drift.
  - The Backing line lists what `scripts/audit-pipe-drain.sh` models (`is_early_reader`, `READER_HELPERS`, `EXCLUDED_PREFIX`); edit it whenever the auditor's model changes.
  - The rule's own reach stays `hooks/`, the auditor's scope; the sibling **Interrupted builtin writes** bullet is the one that binds every shell file.
- **Interrupted builtin writes — the decided keeps**:
  - Reach is every shell file: the fault needs only errexit and an un-waited child, and the `lib/ga-env.sh` logger (`log`, `die`) is an instance outside `hooks/`.
  - The "In a hook" sub-bullet withholds the lead's "or its shell owns no un-waited child" alternative on a hook's block path: a child inherited through `exec` or an external sender delivers SIGCHLD to a shell that starts none, the case the self-written block-write hardening covers.
    - The Condition's source list is what an author checks that alternative against, so it names both sources; keep it in step with the lead.
  - No write-size threshold in the body: the size at which status-ignore alone loses or misroutes a message is platform-dependent, so the body says only "can lose a long message".
  - Retry is not a sanctioned form: a held small write flushes later and double-prints, and a large one is lost whatever the retry does.
  - The verdict-pipe writer-side clause is the condition behind not converting the hooks' `drain_after` verdict pipes to in-shell matches: a pipeline-child writer receives SIGCHLD from its own children, or from an external sender that could kill the hook outright anyway.
    - A writer side that starts a child it does not wait on reopens that decision; a waited `$( )` does not.
  - The bullet names no hook that owns an un-waited child: several block-path hooks read through `< <( )` (the `hooks/hook-utils.sh` field idiom), so a list would go stale; the rule is stated on the condition instead.
  - Key Patterns **Subshell scope** (`done < <(cmd)`) composes with it rather than conflicting: that loop owns an un-waited child, so a later verdict or exit write in the same shell takes the bullet's write form.

## What moved out of the body

| Cut | Canonical that reaches this agent | Kept delta |
|---|---|---|
| Work Rules **Search first** | `scoped/shared-search-first.md` → Principles (`rules.shared`) | none |
| Work Rules **Logging** + **Comments** | `scoped/shared-comment-logging.md` (`rules.shared`) · `core-security.md` → Secret Management (host) | "error messages → stderr", moved into Work Rules **Functions** — neither canonical states it |
| Hook Script Specifics "0 default" and "<1s typical" | `GLASS_ATRIUM_GLOBAL_RULES.md` → Hook Operation Policy (host) | 2 blocking · document any non-zero · `timeout` wrapper |
| Concurrent-worktree lead "treat as SHARED and ask" | `core-git-workflow.md` → Commits → Concurrent worktree (host) | the contract table and the barrier note |
| Red Flags "use `mv ~/.Trash/`" | `GLASS_ATRIUM_GLOBAL_RULES.md` → File Deletion Policy (host) | the disambiguation against the recursive-force guardrail |
| Success Criteria emit-mode table and notes | `core-outcome-record.md` → Completion Report Output Obligation (host) + slot-1 emit-format block | one pointer line + the no-`completion_block` fallback sub-bullet, which neither canonical states |
| In-file repeats: Key Patterns "Every expansion quoted", the `grep -c` guardrail's output example | the unquoted-`$var` guardrail · Key Patterns `grep -c` zero-match trap | none |

## Daemon-evolved `## Work Rules` lines — all dropped

Neither daemon-evolved line below is integrated: both repeat `### Budget sizing`, which stays the single copy the carrier note above protects.

| Quote | Class | Reason |
|---|---|---|
| "**MANDATORY AT INTAKE**: Size task via `tool_uses ~= files × 4.5 + 5 per Bats run`" | duplicates | `### Budget sizing` already sizes at intake and declines above ~30; its added ">50% maxTurns" gate is covered by the 80% turn meter |
| "**Task size gate**: Verify pre-acceptance size-est (`files × 4.5 + Bats runs`)" | duplicates | a second copy of the row above and of `### Budget sizing` |
