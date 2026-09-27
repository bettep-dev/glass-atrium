# Delegation-size discipline (per-delegation, distinct from runtime concurrency)

- **Where it sits**: under `rules/glass-atrium/orchestrator-role.md` → `### Spawn Budget`, beside the runtime concurrency ceilings (`#### Depth and concurrency ceilings`) it is distinct from.
- **Pointer site**: `#### Delegation-size discipline` in that file — the SoT for the sizing duties of both modes, when they fire, the split triggers with the measured truncation band, and COUNTER-CAVEAT.

## DEV-mode token

- **`[SIZE-EST]` self-attestation token (sibling to `[ENTRY-CLASS]`)**: the DEV-mode form.
  - Format `[SIZE-EST] bundles=N tool_uses~=N — <1-line reason>`: `bundles` = how many PRIMARY categories THIS delegation packs · `tool_uses~=N` = the orchestrator's rough pre-spawn tool_use estimate.
  - Placement: `rules/glass-atrium/orchestrator-role.md` → `### Context Handoff Size` → Attestation-token placement. On the manual path `enforce-verification-gate.sh` reads it from `.tool_input.prompt`.
  - **Honesty framing** — why the pointer rounds a borderline count UP: under-estimating `bundles`/`tool_uses` is the DANGEROUS error, masking an oversized delegation past the split discipline; over-estimating is the SAFE error.
  - **Scope of this contract — existence/self-attestation only**: the token records the orchestrator's own estimate, and the gates check its PRESENCE, never its correctness — the same existence-only boundary as `[ENTRY-CLASS]`.
  - Enforcement, both paths — manual: `enforce-verification-gate.sh`, guarded by `hook_is_subagent` so it fires on orchestrator-origin spawns only · ultracode: `enforce-workflow-verify-stage.sh`, DEV-gated, raw-scanning the script. Both BLOCK a DEV spawn missing the token.

## Analysis-mode token

- **`[SIZE-EST]` analysis mode (schema-mode NON-DEV analysis/research/audit spawn — the INPUT-side right-sizing complement)**:
  - Which spawns: the analysis spawns named at `rules/glass-atrium/orchestrator-role.md` → `#### Delegation-size discipline` → **Standing obligation**.
  - Why: such a spawn has no `files × 4.5` edit analog — it spends its budget on reads and reasoning, so a broad read + `effort:high` + a 3-4-field schema starves the emit step (the non-emit failure class).
    - Non-emission rate, dated figures and re-derivation recipe: `skills/glass-atrium-ops-orchestrator.md` → Completion-channel non-emission (MEASUREMENT SoT).
  - Format `[SIZE-EST] reads~=N fields=N effort=<medium|high> scope=<allowlist|bounded> — <1-line reason>`: `reads~=N` = the pre-spawn read/tool-use estimate · `fields` = the output schema's required-field count · `effort` = the chosen reasoning tier · `scope` = an explicit file/dir READ allowlist, never a repo sweep.
  - Read-scope anchor (the read analog of `files × 4.5`): a simple fact-find ~3-10 reads · a direct comparison ~10-15 reads per source.
  - **Reserve-then-check (gate BEFORE work begins)**: the input budget the read allowlist is sized to is `input_budget = context_window − reserved_output`.
  - **Output-field cap**: 2-3 fields.
  - **Effort matched to depth**: default `medium` for broad reads, `high` ONLY for narrow-scope deep reasoning.
  - Honesty and backing as in DEV mode, `reads~`/`fields` included: presence is checked, correctness never.
  - Gate: `enforce-workflow-verify-stage.sh` fires an ADVISORY nudge (never exit 2, fail-open) on a schema-mode non-DEV analysis spawn missing this token — unlike the DEV-mode exit-2 block.

## Notes on the pointer-site items

- **One-agent-budget sizing — why**: an over-packed delegation truncates — the sub-agent runs out of budget mid-work and emits no `[COMPLETION]`. The cause is per-delegation SIZE, not the number of workflow stages.
- **DEV-mode split shape**: order each kept implementation+tests unit tests-first; peel off run-full-suite / report-consolidation.
  - Worked (≈ figures illustrative): 4-category request → A = implement + its new tests (≈25 tool_uses) → orchestrator cheap-verify → B = full-suite + report (≈15) — each ≤2 bundles and under the HARD SECONDARY ceiling; do NOT split B finer (COUNTER-CAVEAT).
- **HARD SECONDARY — why (anti-gaming)**: it closes the single-giant-implement-bundle hole that the bundle count alone leaves open.
- **COUNTER-CAVEAT — cost**: a split into 1-line tasks re-tokenizes system prompt + tool schemas + handoff on every spawn, so over-fragmentation inflates TOTAL session cost.
- **Subagent-side runtime complement**: this orchestrator-side split is the primary guard, and it is honor-system; the subagent's own turn meter and tool-use advisory only make its threshold visible.
- **Per-file tool_use measurement (feeds the `[SIZE-EST]` estimate in `## DEV-mode token`)**: one file edit+verify+commit unit costs ~4-5 tool_uses measured.
  - The `files × 4.5` anchor built on it is a floor, calibrated UP, never down.
  - Its split line sits clear of the truncation band, with headroom for the reserved `[COMPLETION]`/emit tail.
