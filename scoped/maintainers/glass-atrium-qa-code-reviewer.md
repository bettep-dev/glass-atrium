# Maintainer note — agents/glass-atrium-qa-code-reviewer.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/test/emit-discipline-doc-consistency.bats` | `print-block-then-emit`, case-insensitive; its first hit above the `^## Review Summary` line | keep the marker in the FINAL STEP channel bullet, above the template |
| `autoagent/reviewer-catch-rate.sh` → `extract_findings` | finding entries opening with `[MUST FIX]` / `[SHOULD FIX]` / `[CONSIDER]` | the severity tags are the scorer's entry opener |
| `hooks/_pg_outcome_dualwrite.py` | the `qa_score` value, stored as text of at most 64 chars | the `#### Template field notes` shapes fit that bound |
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | turn-budget meter sizing |
| `autoagent/lib/editable_merge.py` | EDITABLE region count, local vs release | a count change routes the merge to the manual structural-change ceremony |

## Body text other files use

- **Deep (4-pass)** — `skills/glass-atrium-ops-orchestrator.md` → **Orchestrator-forced Deep-review override** and the `hooks/enforce-verification-gate.sh` advisory ask for it by name; `### Review Depth Scaling` defines it for the reviewer.
  - `hooks/test/enforce-verification-gate-scope.bats` pins the hook phrase as `DEEP_PHRASE`.
- `### Stage-2 plan-verification spawn` and the `#### Template field notes` pointers into `scoped/scope-qa.md` — recorded in `scoped/maintainers/scope-qa.md`.
  - `scoped/scope-qa.md` → `### Non-waiver (binding on YOU, not on the delegation)` relies on **In-flight budget**.
  - `scoped/scope-qa.md` → `## D8 Visual Decision Sub-Pass (HTML Primary Deliverables) [QA]` relies on the skip list in `#### Template field notes`.
- `### Testing Checks` → `scoped/maintainers/shared-testing.md`.
- `### Naming Checks` and **Naming edge cases** → `scoped/maintainers/shared-naming.md`.
- The `### 7-Perspective Checklist` Performance row → `scoped/maintainers/shared-performance.md`, by filename.
- `### Anti-Pattern Flags` → **Residue** is the rule label in the catch-rate data `autoagent/reviewer-catch-rate/findings.tsv` and fixture `denial-reply.md`.

## Canonicals the body states no copy of

- host: `core-outcome-record.md` → Result-selection criterion and Role → Allowed task_types (`review`) · `GLASS_ATRIUM_GLOBAL_RULES.md` → Verified References (anchor by symbol).
- slot 1: the emit-format block; `BUDGET_ANALYSIS_AGENTS` (read bounding); `WIKI_UNTRUSTED_AGENTS` (raw-store data clause).
- part slots: the `rules.scope` and `rules.shared` files of the reviewer's `agent-registry.json` row, whole.

## Decisions worth keeping

- Read-only stays a body rule while Bash is granted: Bash runs checks, and reviewer independence is why this role stays a separate subagent.
- The Read instructions for `scoped/shared-performance.md` and the `skills/` references stay: the reviewer's registry row does not carry those files.
- The no-`completion_block` fallback stays in the body: neither `core-outcome-record.md` nor the emit-format block states it.
