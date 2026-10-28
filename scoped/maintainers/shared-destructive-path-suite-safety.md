# Maintainer note — `scoped/shared-destructive-path-suite-safety.md`

Maintainer-facing material for that rule file. Nothing here binds a running agent; the rule file carries the procedure.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- `scoped/shared-destructive-path-suite-safety.md` has no such stub heading and therefore carries no pointer to this note.

## Loading and membership

- Task-conditional, never standing: the procedure binds a Glass Atrium install's own suites, so standing delivery inside `scoped/shared-testing.md` would spend about 8 KB of every DEV and reviewer spawn, in every project, on a condition few turns meet.
- The rule file's `## Destructive-Path Suite Safety (live-postgres reach)` → **Condition** line is its trigger. The `when` string `_LIVE_PG_SUITE_CONDITION` in `scripts/agent_lifecycle/registry_ops.py` is phrased to match it; keep the two in step.
- Membership sits on the `agent-registry.json` `rules.conditional` entries — every DEV row, as the DEV scope default, plus glass-atrium-qa-code-reviewer, hand-added — and in `rules/glass-atrium/core-compliance-matrix.md` (its Tier-3 row and Compliance Matrix row).
  - The Tier-3 row's tokens carry `subset`, so the orphan scan never reads the file as standing `rules.shared` membership.
  - glass-atrium-qa-debugger is left out: the QA scope default would reach it, which is why the reviewer's entry is a per-agent hand-add.
  - glass-atrium-meta-prompt-engineer is left out: it holds no Bash, so it never runs a suite, and its row keeps an empty `conditional` list.
- Inbound pointer: `skills/glass-atrium-ops-orchestrator-role.md` → `## Document-Driven Workflow` step 6 → **Live-suite instrument**, for the session that runs the live suite before a PR.
  - Its phrase "pointer only, the procedure is single-sited there" is the reason the whole procedure stays in this one file: moving any part elsewhere would put content out from under that pointer, which names the file.
  - `scoped/maintainers/orchestrator-role.md` records the same coupling, so reword both or neither.
- **Heading stability**: `## Destructive-Path Suite Safety (live-postgres reach)` is named verbatim by this note only.
  - The step-6 pointer and `scoped/maintainers/orchestrator-role.md` cite the file by path.
  - Its step headings are cited inside the procedure itself (the Step 4 questions, Mechanism binding).
- Shape: the H2 sits just under the 8 KB shape-cap guide.

## Provenance

- **Same-shell rule, probed rather than inferred, both halves**: a two-body bats file whose first body defines a function and whose second asserts `declare -F` does not find it — the second body passes, so nothing leaked; and a file defining the same name in `setup` instead — both bodies see it.
- **Step 5 collision list, measured**: each entry was reproduced by a run under the whole-invocation escape; add a suite only on a reproduced run.
  - `GA_PG_SOCKET`: `test/run-step-fail-return.bats` with only an off-/tmp `GA_PG_SOCKET` exported failed its `drive_db` rows, and passed every row with the name unset.
  - `psql`: `hooks/test/ephemeral-pg-locale.bats` failed its two rows asserting on `psql` output under record-only `psql` and `lsof` stubs, and passed all four without them; a `createdb` stub changed nothing.
  - Not named because measured clean: `test/ga-db-sql-binding.bats`.
  - Not named although they collide: a whole-tree run under the escape also failed rows in `hooks/test/agent-tracker.bats`, `hooks/test/cost-tracker-dualwrite.bats` and `hooks/test/ephemeral-pg-recorder-schema.bats`, each of which passes unsealed.
    - Why not named: their failures are attributed to the empty `psql` stub output by inference from rows that read `psql` output, with no per-suite stub comparison like the locale entry's `createdb` run.
    - Whether Step 5 names them is the rule owner's decision.
- **Kept on purpose**: the never-`GA_DB_NAME` clause — the guard's FATAL text offers `GA_DB_NAME`, but `lib/ga-db.sh` → `_require_db_setup_ready` tests only `PG_SOCKET`.
- **Naming**: Step 5's escape is not the per-suite Live-DB seal (`test/lib/bats-db-seal.bash`); name it by Step 5's own wording, never as "the seal".

## What reads the rule file mechanically

- Nothing reads its body. The couplings are the path spelling, the manifest hash, and the basename-to-matrix-row check in `hooks/validate-compliance-matrix.sh`.
  - The path spelling sits in `agent-registry.json` `rules.conditional` entries and in the closed vocabulary `RULE_FILES` of `scripts/agent_lifecycle/registry_ops.py`, derived from `SCOPE_CONDITIONAL_RULES`.
  - `scripts/test/test_agent_lifecycle_overhaul.py` pins the DEV default's conditional file list.
  - Renaming the file is therefore an edit of the registry rows, `_LIVE_PG_SUITE_CONDITION`, that pin, both matrix rows and the step-6 pointer — not a rule edit.
- `hooks/lib/inject_chunk.py` → `build_conditional_stanza` renders the path and the `when` string into part 01 of each holder's spawn injection, never the body.
