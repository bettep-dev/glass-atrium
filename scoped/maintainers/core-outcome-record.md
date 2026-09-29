# Maintainer note — `rules/glass-atrium/core-outcome-record.md`

Recorder and grader reference for that Tier-1 rule file: what `hooks/track-outcome.sh` records for each emit shape, and what the grader and the daemon compute for the columns a writer never fills. Nothing here binds an emitting agent — the rule file carries the writer's duties and reaches every agent on the host channel; this note reaches none. Read it before editing the recorder, the grader or the rule file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading for this note, yet cites it at two prose sites (`## Linkage`). That departs from "Every other citation goes"; the open call is under `## Outstanding`.

## Recorder behaviour

### Recorder parse outcomes

What `track-outcome.sh` records for each emit shape.

| Emit shape | Recorded as |
|------------|-------------|
| multi-line block closed by `[/COMPLETION]` | writer-parsed row |
| block opened, closing sentinel missing | `parse_tier=2`, `truncated_completion` — writer-parsed, fields kept; attribution degrades to a truncation signal |
| inline single-line with ≥1 core field | `parse_tier=1` via the inline tolerance tier — fields preserved |
| no core field, or no block after ≥1 tool_use | synthesized: `done_with_concerns` / `confidence=low` / `metric_pass=false`, guessed `task_type` |
| schema-mode run whose terminal StructuredOutput was consumed, `completion_block` unusable | `structuredoutput-derived` synthesis: `result=done`, NOT `done_with_concerns` |

- `structuredoutput-derived`: still `confidence=low` / `metric_pass=false` / lesson-absent, writer-unverified.
- **Inline single-line emit (not sanctioned) — what the recorder does with one**: the one-line form (`[COMPLETION] result: done | task_type: … | metric_pass: …` — pipe/middot-delimited, no newline after the tag, no closing sentinel) misses the multi-line tiers.
  - Those tiers anchor on the `[COMPLETION]\n` boundary.
  - A tolerance tier tried only after they miss recovers it: a line-anchored regex plus a guard requiring ≥1 of {result, task_type, metric_pass, confidence, summary}, with complete-block semantics.
- **Unparseable emit → synthesized**: e.g. prose merely mentioning `[COMPLETION]` with a stray delimiter. `task_type` is keyword-guessed (reduced accuracy); the attribution is `completion-synthesized` or `budget-truncation`.

## Grader- and daemon-populated fields

The columns the rule file's template marks writer-does-NOT-fill: `grader_verdict`, `downgrade_origin`, `confidence_observed`.

### Grader verdict

- **Grader tier**: the Code-Based deterministic grader covers author-side outcomes only; infra attribution failures are out of scope.
  - Model-Based (LLM-as-Judge) and Human-Based (`done_with_concerns` escalation) layers stack on top via `track-outcome.sh`.
- **`grader_verdict`**: a deterministic 3-state signal computed by `track-outcome.sh`, in a SEPARATE column from `metric_pass`.
- **Input-surface invariant**: the grader reads ONLY the `[COMPLETION]` block text, its `files:` paths and the emitting session's OWN Write/Edit history.
  - `hooks/lib/code-based-grader.sh` mirrors this surface; the two MUST NOT drift.
  - That history corroborates AUTHORSHIP of paths the block already declares; it is never deliverable evidence by itself.
  - The off-surface deliverable is invisible to it — a plan or research doc lives in `monitor.ClaudedDoc`, a diff or test file in the repo.
  - So a verdict keys ONLY on block-resident structured signal, and ABSENCE of an off-surface artifact is NOT failure evidence.
- **Structured fields only**: gate every check on a structured field; magic-phrase prose is FORBIDDEN as a pass/fail signal.

| task_type | Grader behavior |
|-----------|-----------------|
| `bug-fix` | an EXISTING test/spec file path in `files:` → `verified_pass`; absent → `unverified`, NOT fail |
| `feature` | a test/spec file path in `files:` → `verified_pass`; absent or empty `files:` → `unverified`, NOT fail |
| `refactor` | `unverified` by default — no block-resident structured signal exists for "behavior preserved" |
| `plan` / `research` | `unverified` by task_type alone — markers (`## Open Questions`, `Sources:`, cited URLs) live in the doc |
| `review` / `diagnosis` / `doc` / `cleanup` | explicit skip → `unverified` — no test artifact expected |

- `refactor`: free text such as `existing tests pass` / `no behavioral change` is NOT a valid signal (Gaming-the-Judge avoidance).
- **`verified_fail` has two emitters**, each marked at its site in `hooks/lib/code-based-grader.sh`: `VERIFIED_FAIL_EMITTER: LLM09 zero-evidence guard` · `VERIFIED_FAIL_EMITTER: total transcript-authorship contradiction`.
  - Machine-checked: `hooks/test/emit-discipline-doc-consistency.bats` (its two `EMITTER` tests) matches this file's marker count and both names to the grader source — never reword, drop or add a mention without the same edit there.
- **LLM09 misinformation guard**: `result=done` + `metric_pass=true` + ZERO deliverable evidence of any kind (no `files:`, no sources, no block body) → `grader_verdict=verified_fail` + `review_flag=true`, still advisory.
  - The mere absence of a document heading is not zero evidence.

### Transcript write cross-check

- **Transcript write cross-check (code types only)**: the `files:` paths of a promotable `bug-fix`/`feature` row are compared against the session's own Write/Edit history.

| Cross-check outcome | Verdict |
|---------------------|---------|
| TOTAL mismatch — every path-shaped entry absent from a NON-EMPTY history, zero matched | `verified_fail` — the fabrication signal |
| PARTIAL mismatch — ≥1 unmatched WITH ≥1 matched | promotion withheld → `unverified` |
| EMPTY write history | withheld → `unverified` |
| unverifiable OR unwired scan | withheld → `unverified` |
| ARTIFACT-ONLY — every path-shaped entry is a recognized tool-generated artifact | withheld → `unverified`, never a promotion |

- PARTIAL: a tool-generated sibling (manifest / migration / snapshot) is a collector blind spot, not demonstrated absence.
- EMPTY: an empty history cannot DEMONSTRATE absence — Write/Edit is blind to Bash-authored writes.
- **Neither matched nor unmatched**: non-path-shaped prose entries, and recognized tool-generated artifacts — a CLOSED set: basename exactly `manifest.json`, or a path under the live install root `$HOME/.glass-atrium/`.
  - Those artifacts are written through a regeneration script or the sanctioned updater seam, invisible to the Write/Edit collector — so such an entry rescues no contradiction and blocks no otherwise-verified row.

### Grader and daemon provenance

- **`downgrade_origin`**: how the graded outcome arose, recorded beside `grader_verdict`.

| `downgrade_origin` | Means |
|--------------------|-------|
| `writer_true_downgraded` | writer claimed `metric_pass=true`; the grader returned `verified_fail`/`unverified` |
| `writer_false` | writer self-reported `metric_pass=false` — an honest negative |
| `synthesized` | assembled by the SubagentStop transcript-synthesis backstop — no writer-emitted block |

- **`confidence_observed`**: a Beta-Binomial posterior mean (float `0.0`-`1.0`) the daemon computes from the empirical tuple `revision_count` + `result` + `evaluative_signal`.
  - It corrects the systematically inflated writer `confidence` enum and is NOT the same field.
  - Backing: its storage column is the `core.autoagent_proposals` per-pattern aggregate; the parser only recognizes the field passively and does not persist it yet, so an absent value is silently ignored.

## Linkage

- Each fact lives once. The rule file keeps the writer-facing half: each field's template line and `### Field Input Guide` row, the `metric_pass` no-overwrite clause, and the `## Automatic Verification Criteria` rows. This note keeps the rest.

| Reader or citer | Reads | Keep in step with |
|---|---|---|
| rule file → `## Completion Report Output Obligation` → Multi-line form | pointer to `### Recorder parse outcomes` | that heading |
| rule file → `## Automatic Verification Criteria` → Grader disagreement fires narrowly | pointer to `### Grader verdict` | that heading |
| `hooks/test/emit-discipline-doc-consistency.bats` → its two `EMITTER` tests | this file's emitter-marker count and both names, against the grader source | the emitter bullet under `### Grader verdict` |
| `hooks/lib/code-based-grader.sh` → header comments | pointers to `### Grader verdict` (Outputs stanza, Input-surface invariant) | the Input-surface invariant bullet |
| `hooks/test/code-based-grader.bats` → header comment | pointer to `### Grader verdict` | that heading |
| `hooks/inject-scope-rules.sh` → `build_emit_format_block` | a shell literal restating the inline-salvage and unparseable rows | `### Recorder parse outcomes` — manual, unenforced |

- The emitter-marker literal appears in this file inside the emitter bullet under `### Grader verdict` and nowhere else. The suite counts every occurrence in the file, so quoting the literal anywhere else here breaks the count.
- Renaming `### Recorder parse outcomes` or `### Grader verdict` dangles a pointer in a Tier-1 file.

## Outstanding

- The two rule-file prose pointers depart from "Every other citation goes". Dropping them leaves the schema-mode fallback and the grader-disagreement row with no route to their detail; keeping them sends Tier-1 readers into a maintainer note. Open — the rule file's owner decides.
- Monitor comments not retargeted — each still resolves to a `### Field Input Guide` row in the rule file, while the semantics it cites live here:
  - `monitor/prisma/schema.prisma` → the doc comments above `enum GraderVerdict` and `enum DowngradeOrigin`;
  - `monitor/src/server/routes/outcomes.ts` → the comment above `BY_DESIGN_UNVERIFIED_TASK_TYPES`.
