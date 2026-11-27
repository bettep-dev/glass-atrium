# Maintainer note — `scoped/shared-destructive-path-suite-safety.md`

Maintainer-facing material for that rule file. Nothing here binds a running agent; the rule file carries the procedure.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- `scoped/shared-destructive-path-suite-safety.md` has no such stub heading and therefore carries no pointer to this note.

## Loading and membership

- Task-conditional, never standing: the procedure binds a Glass Atrium install's own suites, so standing delivery inside `scoped/shared-testing.md` would charge every DEV and reviewer spawn, in every project, for a condition few turns meet.
- The rule file's `## Destructive-Path Suite Safety (live-postgres reach)` → **Condition** line is its trigger; the `when` string of `_LIVE_PG_SUITE_CONDITION` in `scripts/agent_lifecycle/registry_ops.py` matches it — keep the two in step.
- Membership sits on the `agent-registry.json` `rules.conditional` entries — every DEV row, as the DEV scope default, plus glass-atrium-qa-code-reviewer, hand-added — and in `rules/glass-atrium/core-compliance-matrix.md` (its Tier-3 row and Compliance Matrix row).
  - The Tier-3 row's `subset` tokens: `scoped/maintainers/core-compliance-matrix.md` → **Tier-3 subset tokens**.
  - glass-atrium-qa-debugger is left out, so the reviewer's entry is a hand-add: `registry_ops.py` → the comment above `RULE_FILES`.
  - glass-atrium-meta-prompt-engineer is left out: it holds no Bash, so it never runs a suite.
- Inbound pointer: `skills/glass-atrium-ops-orchestrator-role.md` → `## Document-Driven Workflow` step 6 → **Live-suite instrument**, for the session that runs the live suite before a PR.
  - Its phrase "pointer only, the procedure is single-sited there" is why the whole procedure stays in the rule file: moving any part out would put content out from under that pointer.
  - `scoped/maintainers/orchestrator-role.md` records the same coupling, so reword both or neither.
- **Heading stability**: `## Destructive-Path Suite Safety (live-postgres reach)` is named verbatim by this note only; the step-6 pointer and `scoped/maintainers/orchestrator-role.md` cite the file by path.
  - The procedure cites its own Step 4 questions and **Mechanism binding** by name.

## Provenance

- **Same-shell rule, probed rather than inferred, both halves**: a function defined in one bats body is absent from the next (`declare -F` finds nothing), and one defined in `setup` reaches both bodies.
- **Step 5 collision list, measured**: each entry was reproduced by a run under the whole-invocation escape; add a suite only on a reproduced run.
  - `GA_PG_SOCKET`: `test/run-step-fail-return.bats` with only an off-/tmp `GA_PG_SOCKET` exported failed its `drive_db` rows, and passed with the name unset.
    - `drive_db` strips the name and the suite's off-/tmp export row pins that, so the collision reproduces there only with the strip removed.
  - `psql`: `hooks/test/ephemeral-pg-locale.bats` failed its rows asserting on `psql` output under record-only `psql` and `lsof` stubs, and passed without them; a `createdb` stub changed nothing.
  - Not named because measured clean: `test/ga-db-sql-binding.bats`.
  - Not named although they collide: a whole-tree run under the escape also failed rows in `hooks/test/agent-tracker.bats`, `hooks/test/cost-tracker-dualwrite.bats` and `hooks/test/ephemeral-pg-recorder-schema.bats`, each of which passes without the escape.
    - Why not named: their failures are attributed to the empty `psql` stub output by inference from rows that read `psql` output, with no per-suite stub comparison like the locale entry's `createdb` run.
    - Whether Step 5 names them is the rule owner's decision.
- **Kept on purpose**: the never-`GA_DB_NAME` clause — the guard's FATAL text offers `GA_DB_NAME`, but `lib/ga-db.sh` → `_require_db_setup_ready` tests only `PG_SOCKET`.
- **Naming**: Step 5's escape is not the per-suite Live-DB seal (`test/lib/bats-db-seal.bash`); name it by Step 5's own wording, never as "the seal".

## What reads the rule file mechanically

- Nothing reads its body.
- The couplings:
  - the path spelling, in `agent-registry.json` `rules.conditional` entries and in the closed vocabulary `RULE_FILES` of `scripts/agent_lifecycle/registry_ops.py`, derived from `SCOPE_CONDITIONAL_RULES`;
  - the manifest hash;
  - the basename-to-matrix-row check in `hooks/validate-compliance-matrix.sh`.
- `scripts/test/test_agent_lifecycle_overhaul.py` pins the DEV default's conditional file list.
- Renaming the file is a corpus edit, not a rule edit: grep the basename.
- `hooks/lib/inject_chunk.py` → `build_conditional_stanza` renders the path and the `when` string into part 01 of each holder's spawn injection, never the body.
