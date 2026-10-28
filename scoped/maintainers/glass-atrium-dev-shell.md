# Maintainer note — agents/glass-atrium-dev-shell.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/test/inject-scope-rules-nodrop.bats` | frontmatter `maxTurns`; its own `BUDGET_DEV_CARRIERS` literal | carrier status and meter bytes — `## Budget-sizing bullets` |
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | turn-budget meter sizing |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) and the fence-line count | edits to them blocked for every caller (LLM06) |
| `autoagent/daemon_cycle.py` → `match_sensitive_diff` | added lines of any patch to this body | `## Destructive-literal convention` |
| `scripts/audit-inert-assert.sh` header | cites `### Bats + test-run discipline` as its convention SoT | keep the heading text |

- Several harness-critical suites write a fake-HOME copy of this filename as a fixture; repo-tree edits do not affect them.
- `scoped/maintainers/shared-testing.md` also cites `### Bats + test-run discipline`, for the shared bash 3.2 errexit reason.

## Budget-sizing bullets — why they are not a mirror

- This agent is a budget carrier: excluded from the injected `AGENT-INJECT:BUDGET-DEV` roster because the body carries the rule.
  - `scripts/agent_lifecycle/inject_sync.py` → `_BUDGET_DAEMON_CARRIERS` names it; the nodrop suite asserts the injected block is absent for it.
- `scoped/shared-turn-budget.md` reaches no carrier at spawn, so `### Budget sizing` is the agent's only copy of the sizing rule.
  - Deleting it as a duplicate deletes the rule while reddening nothing: no suite asserts body prose.
- Both bullets state a judgment, not a formula: intake fit against one agent budget, and a stop once the remaining budget no longer covers the remaining work.
  - The injected block's multiplier, split threshold and halt share stay out of the body; the orchestrator-side `[SIZE-EST]` calibration is separate.
- A daemon-evolved line restating the intake rule as a `files × 4.5` formula duplicates `### Budget sizing`; do not integrate it.
- The checkpoint itself is `GLASS_ATRIUM_GLOBAL_RULES.md` → Work-unit checkpoint dimension (host-delivered), so the bullet carries no pointer.
- `maxTurns` is machine-read: the nodrop suite sizes the injected meter from it and counts those bytes into a pinned worst-case DEV assembly total.

## Destructive-literal convention — kept in the body deliberately

The blockquote under the role line is maintainer-facing by audience, yet it stays in the body because it protects the patchability of the file it sits in:

- The sensitive-diff check cannot tell a rule forbidding a destructive command from a patch running it.
- On a match the merge planner refuses the file while the cycle still reports success.
- Whoever patches this body must see the constraint at the point of editing — the daemon's own editor reads the file, not this directory.

## Facts stated per the tree

Check the tree before reverting any of these.

- `readlink -f`: `hooks/hook-utils.sh`, `hooks/cost-tracker.sh` and `scripts/progress-tracker.sh` call it, on macOS 12.3+; `hooks/lib/hook-utils.sh` avoids it by design.
- Hook wiring: `lib/ga-env.sh` → `EXPECTED_HOOK_BINDINGS` is the single SoT `wire_hooks`, `run_doctor`, `unwire_hooks` and `verify_clean` read, pinned by `test/hook-bindings-complete.bats` and `test/doctor-hook-bindings.bats`.
  - `settings.template.json` is a permissions template, not auto-applied, and lists only a few PreToolUse hooks — so the decommission bullet names it only for a hook it lists.
- Hook timeouts: stock macOS ships no `timeout` binary (`hooks/advisory-spawn-cost.sh` header); hooks bound each call per tool.
- `## Quality Gate (Mechanical)` flags `shfmt -i 2 -ci -bn` and `shellcheck --enable=all` match the tree's two-space indent and inline optional-check disables.
  - CI runs ShellCheck only as `shellcheck --include=SC2115` (`.github/workflows/ci.yml`); it never runs shfmt or `--enable=all`.
  - So the gate is the agent's own check, and the body's one-line why is what keeps the flags from reading as advisory.
- Fixed numbers in the body are a reader's contract (`maxTurns`) or domain fact: the Bash 3.2 / 4 / 5.3 gates, the 64 KiB pipe capacity and exit 141, macOS 11+ for `launchctl bootout`, macOS 12.3 for `readlink -f`.

## Overrides and deferrals

- `### Bats + test-run discipline` affected-paths-per-commit bullet is this agent's override of `scoped/shared-testing.md` → `## 3-Tier Test Hierarchy`, not a duplicate.
  - Reason: a full Bats run per incremental commit exhausts one agent budget.
- Concurrent worktree: the index-mutation class, both contracts, the regeneration barrier and **Who commits** live in `rules/glass-atrium/core-git-workflow.md` → `## Commits` → **Concurrent worktree** and `### Worktree occupancy` (host).
  - The body's `### Concurrent-worktree contract` table stays: only the delegation's contract line says which contract holds for a run.
  - The INDEX OWNER regeneration cell says only "hold the tree exclusively", which the canonical **Regeneration barrier** defines.
- Naming: `scoped/scope-dev.md` → `### Project Convention Probe` reaches this agent through `rules.scope`; the body keeps only the `snake_case` function casing.
- Red Flags and Prohibitions intros stay: `scoped/maintainers/glass-atrium-dev-node.md` and `glass-atrium-dev-android.md` name Guardrails as the owner and list only what has no Guardrails entry, citing this body as that shape.
- Canonicals the body states no copy of, each reaching the agent on its own channel:
  - host: File Deletion Policy · Temporary Files · Cross-Session Continuity · `core-security.md` Execution Security
  - host: `core-outcome-record.md` → `#### Self-assessment fields` and Completion Report Output Obligation
  - `rules.shared` / `rules.scope`: `shared-search-first.md` · `shared-comment-logging.md` · `shared-code-structure.md`
  - conditional: `scoped/shared-hook-capability-contract.md` (hook input, output and exit-code channels; `## Hook Operation Policy`)
  - The Success Criteria no-`completion_block` fallback stays: neither canonical states it.

## Early-exit pipe readers — the premise in its Why

- The race is keyed on the writer's write count, not on output past the pipe capacity.
  - Bash line-buffers builtin stdout (one write per line) and an external stdio writer writes once per buffer, so a multi-line builtin value races at any size.
- The same premise sits in the `hooks/lib/pipe-drain.sh` header and the `scripts/audit-pipe-drain.sh` header Why — canonical + mirror: keep the three in step and report drift.
- The auditor sub-bullet points at the auditor header for the modeled readers, so an auditor change needs no body edit.
  - "A wrapper the auditor does not know" means a helper missing from `READER_HELPERS`; edit the named examples if the auditor starts modeling one.
- The rule's reach stays `hooks/`, the auditor's scope; **Interrupted builtin writes** is the bullet that binds every shell file.

## Interrupted builtin writes — the decided keeps

- Reach is every shell file: the fault needs only errexit and an un-waited child; the `lib/ga-env.sh` logger (`log`, `die`) is an instance outside `hooks/`.
- The "In a hook" sub-bullet withholds the lead's "owns no un-waited child" alternative on a block path.
  - A child inherited through `exec`, or an external sender, delivers SIGCHLD to a shell that starts none.
  - The Condition's source list names both sources; keep it in step with the lead.
- No write-size threshold: where status-ignore alone loses or misroutes a message is platform-dependent, so the body says "can lose a long message".
- Retry is not a sanctioned form: a held small write flushes later and double-prints, and a large one is lost whatever the retry does.
- The verdict-pipe writer-side clause is why the hooks' `drain_after` verdict pipes are not converted to in-shell matches.
  - A writer side that starts a child it does not wait on reopens that decision; a waited `$( )` does not.
- Honor-system: no auditor models this class, unlike the pipe-reader rule.
- The bullet names no hook that owns an un-waited child: several block-path hooks read through `< <( )` (the `hooks/hook-utils.sh` field idiom), so a list would go stale.
  - A `while read …; done < <(cmd)` loop owns an un-waited child, so a later verdict or exit write in the same shell takes the bullet's write form.
