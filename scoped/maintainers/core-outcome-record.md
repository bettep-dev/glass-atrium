# Maintainer note — `rules/glass-atrium/core-outcome-record.md`

Recorder and grader reference for that Tier-1 rule file: what `hooks/track-outcome.sh` records for each emit shape, and what the grader and the daemon compute for the columns a writer never fills. Nothing here binds an emitting agent — the rule file carries the writer's duties and reaches every agent on the host channel; this note reaches none. Read it before editing the recorder, the grader or the rule file; do not inject it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the rule file carries no stub heading for this note, yet cites it at two prose sites (`## Linkage`). That departs from "Every other citation goes"; the open call is under `## Outstanding`.

## Recorder behaviour

### Record storage

- **Writer**: `hooks/_pg_outcome_dualwrite.py` writes `core.outcomes`; its `body_md` column carries the full markdown body, which the renderer CLI re-synthesizes to frontmatter.
- **Record-side names**: the record stores the template's `files` as `files_modified`, and `cid` both as `cid` and as `correlation_id`; `metric_type` shares the 9-type task_type value set.
- **`concerns`**: `track-outcome.sh` copies the value into the record's `## Concerns` section, reads that section back when a `done_with_concerns` row has no `concerns:` line, and clamps the stored value to 800 chars.
  - An absent `concerns` is stored as an empty array.
- **`revision_count`**: a missing or non-integer value falls back to 0.
  - The hook's prior+1 cross-outcome accumulation is stubbed to 0 until a project-keyed PG restoration lands.
  - Why: DB-only tracking has no cwd/project key, so a same-task_type prior lookup would miscount another project's correction.
- **task_type agreement**: the rule file's `### Role → Allowed task_types` table is the single authority that `guess_task_type`, the grader's unknown-case branch and the dual-write `_norm_task_type` helper MUST agree on — divergence is a defect.

### Recorder parse outcomes

What `track-outcome.sh` records for each emit shape.

| Emit shape | Recorded as |
|------------|-------------|
| multi-line block closed by `[/COMPLETION]` | writer-parsed row |
| block opened, closing sentinel missing | `parse_tier=2`, `truncated_completion` — writer-parsed, fields kept; attribution degrades to a truncation signal |
| inline single-line with ≥1 core field | `parse_tier=1` via the inline tolerance tier — fields preserved |
| no core field, or no block after ≥1 tool_use | synthesized: `done_with_concerns` / `confidence=low` / `metric_pass=false`, guessed `task_type` |
| schema-mode run, `completion_block` present and parseable in the terminal StructuredOutput input | writer-emitted, attribution `structuredoutput-completion` — a healthy row |
| schema-mode run whose terminal StructuredOutput was consumed, `completion_block` unusable | `structuredoutput-derived` synthesis: `result=done`, NOT `done_with_concerns` |

- `structuredoutput-derived`: still `confidence=low` / `metric_pass=false` / lesson-absent, writer-unverified.
- **Inline single-line emit (not sanctioned) — what the recorder does with one**: the one-line form (`[COMPLETION] result: done | task_type: … | metric_pass: …` — pipe/middot-delimited, no newline after the tag, no closing sentinel) misses the multi-line tiers.
  - Those tiers anchor on the `[COMPLETION]\n` boundary.
  - A tolerance tier tried only after they miss recovers it: a line-anchored regex plus a guard requiring ≥1 of {result, task_type, metric_pass, confidence, summary}, with complete-block semantics.
- **Unparseable emit → synthesized**: e.g. prose merely mentioning `[COMPLETION]` with a stray delimiter. `task_type` is keyword-guessed (reduced accuracy); the attribution is `completion-synthesized` or `budget-truncation`.

## Grader- and daemon-populated fields

The columns the rule file's template marks "writer does not fill": `grader_verdict`, `downgrade_origin`, `confidence_observed`.

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

## `style_ref` review flag

- **Omission parser**: `hooks/lib/style-ref-consts.sh` → `style_ref_compute_review_flag`; its task_type allowlist is the single SoT for the production hook and its Bats test.
- **Mandatory graduation** is a separate future cycle requiring user approval, gated by `styleRefGradeBadgeI` in `monitor/public/src/screens/improvement.jsx`: emission ≥ 50% and the uncorroborated share of the adjudicated subset < 10% across the DEV agents.
  - Adjudicated = corroborated + uncorroborated, never eligible — an eligible denominator could be passed by widening the blind spot.
  - Publish corroborated / uncorroborated / unverifiable as three counts, not one derived rate that reads as an honesty verdict.

## Linkage

- Each fact lives once. The rule file keeps the writer-facing half: each field's template line and `### Field Input Guide` row, the `metric_pass` no-overwrite clause, and the `## Automatic Verification Criteria` rows. This note keeps the rest.

| Reader or citer | Reads | Keep in step with |
|---|---|---|
| rule file → `## Completion Report Output Obligation` → Multi-line form | pointer to `### Recorder parse outcomes` | that heading |
| rule file → `## Automatic Verification Criteria` → Grader disagreement fires narrowly | pointer to `### Grader verdict` | that heading |
| `hooks/test/emit-discipline-doc-consistency.bats` → its two `EMITTER` tests | this file's emitter-marker count and both names, against the grader source | the emitter bullet under `### Grader verdict` |
| `hooks/lib/code-based-grader.sh` → header comments | pointers to `### Grader verdict` (Outputs stanza, Input-surface invariant) | the Input-surface invariant bullet |
| `hooks/test/code-based-grader.bats` → header comment | pointer to `### Grader verdict` | that heading |
| `hooks/inject-scope-rules.sh` → `build_emit_format_block` | a shell literal restating the inline-salvage and unparseable rows | `### Recorder parse outcomes` and rule file → **Spawn-injected copy** — manual |
| `hooks/test/track-outcome-completion-block-select.bats` → its `KNOWN_FIELDS` test | the first fence after rule file `## Completion Report Output Obligation`, up to the next `## ` | the template fence, kept first in that H2 |
| `agents/` bodies, `hooks/inject-session-context.sh`, `orchestrator-role.md`, the ops skills | rule-file headings and leads by name | the names listed below |

- The emitter-marker literal appears in this file inside the emitter bullet under `### Grader verdict` and nowhere else. The suite counts every occurrence in the file, so quoting the literal anywhere else here breaks the count.
- Renaming `### Recorder parse outcomes` or `### Grader verdict` dangles a pointer in a Tier-1 file.
- **The emit-format copy**: no test or hook compares it with the rule file; `hooks/test/inject-scope-rules-nodrop.bats` pins only the needle `REQUIRED by the outcome recorder`.
  - The hook's header comment above `build_emit_format_block` says the rule file "carries the reciprocal pointer" — that is **Spawn-injected copy**; dropping that bullet falsifies the comment.
- **Rule-file names cited from outside** — never rename one: `## Core` → **Lesson-free read** · `### Role → Allowed task_types` · `## Completion Report Output Obligation` · `### Emit Boundary` → Channel asymmetry · **Correction-emission rule** · `### Field Input Guide` → `metric_pass`.
  - `#### Self-assessment fields` stays under `### Field Input Guide`: frozen `agents/` bodies and the ops skill cite the path Field Input Guide → `metric_pass`.
  - The correction, content and role-scoped field rules sit in sibling `###` sections under `## Field Reference`, keeping each H2 and H3 inside the shape caps; the Field Input Guide opening line names them.

## Restructure + diet pass — dispositions

- Moved here, as reader-inert recorder or editor detail: the `_pg_outcome_dualwrite.py` / `body_md` storage line, **Record-side names**, the task_type agreement line, the `concerns` section read-back, the `revision_count` stub's why and restoration, the `style_ref` parser path and **Mandatory graduation**, the `structuredoutput-completion` healthy row, the nodrop needle note.
- Dropped as redundant with a Tier-1 site reaching the same reader: "the engine consumes only the StructuredOutput call" (`GLASS_ATRIUM_GLOBAL_RULES.md` → **Schema-mode caveat**) and the closing-turn pointer to `### Turn Budget & Graceful Exit`.
- Dropped as dup-in:
  - the task_type-set allowlist line — the Role section states it;
  - "Filling it never changes `result`" — ``### Whose outcome `result` describes`` states it;
  - the stray-`directive_hint` line — merged into the trip-set line;
  - four Field Input Guide cell qualifiers the template comments already carry: integer · `-1`/`0`/`+1` · only with `evaluative_signal: -1` · QA review only.
- Two other Field Input Guide cell qualifiers left the rule file, not as template dups:
  - `concerns` "absent is an empty array" — recorder storage behaviour, now under `### Record storage` → **`concerns`**.
  - `confidence_observed` "empty is valid, not a `review_flag` trigger" — implied by the closed trigger table in rule file → `## Automatic Verification Criteria`, which carries no `confidence_observed` row.
- The Result-selection `done` cell's caveat list became a note under the table, to fit the cell cap.
- The **Correction-emission rule** lead lost "judged SEMANTICALLY in ANY language" to a sub-bullet, to fit the bullet cap; its bolded label is unchanged.
- Prompt-audit pass on the restructure:
  - **Omission** names the parser's scope — `feature` · `bug-fix` · `refactor` rows from agents that receive `scope-dev.md` — because the parser pointer that carried that scope moved here.
  - "a schema-mode run never ends on prose" dropped: `GLASS_ATRIUM_GLOBAL_RULES.md` → `#### Emit-before-cap` states it to the same reader.
  - The retired `.md` sub-bullet now states the current rule instead of its retirement; the template's `style_ref` comment points at `### Role-scoped fields` → `style_ref`.

## Outstanding

- The two rule-file prose pointers depart from "Every other citation goes". Dropping them leaves the schema-mode fallback and the grader-disagreement row with no route to their detail; keeping them sends Tier-1 readers into a maintainer note. Open — the rule file's owner decides.
- Monitor comments not retargeted — each still resolves to a `### Field Input Guide` row in the rule file, while the semantics it cites live here:
  - `monitor/prisma/schema.prisma` → the doc comments above `enum GraderVerdict` and `enum DowngradeOrigin`;
  - `monitor/src/server/routes/outcomes.ts` → the comment above `BY_DESIGN_UNVERIFIED_TASK_TYPES`.
