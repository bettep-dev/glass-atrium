# Maintainer note — `agents/GLASS_ATRIUM_GLOBAL_RULES.md`

Corpus-maintenance companion to the Tier-1 system charter. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-read file — maintainer-facing, never a duty.
  - **Sibling wording**: the other companions attach "never injected" to that clause. This file is the exception, so the qualification lives here rather than in them.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the charter carries a single HTML editor comment at its head naming this note, in place of three in-body machine-checked paragraphs that were delivered to every agent while obliging none of them.
  - **The comment sits inside the delivered bytes.** The charter reaches every agent and subagent verbatim on the host project-instructions channel, so a comment in it is not maintainer-only the way a scope file's comment is.
  - **Whether that channel PRESERVES an HTML comment is UNVERIFIED.** No live project-instruction file carries one, so no observation settles it either way. Probe: once this comment is on the live install, read a spawned subagent's received project instructions and look for it.
  - **Kept on the half of the trade that does not turn on that answer**: five comment lines against those three paragraphs — the cheaper side whichever way the probe lands.

## Status in the corpus

- Tier-1, and it ARRIVES: the charter reaches every agent — main session and subagent alike — on the host project-instructions channel, which is unceilinged, so a duty homed here is a duty an agent actually holds.
  - Its arrival is measured, and so is Tier-2 and unconditional Tier-3 arrival through the part slots (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`); what sets Tier 1 apart is the channel, not the evidence.
- The file lives at `agents/` and is reached from `rules/glass-atrium/` through a symlink (git mode 120000 on the rules side, 100644 on the agents side). The charter must stay at `agents/`; the symlink target is pinned by `scripts/test/update-symlink-mode-row.bats`, the manifest `modes` key, and the census `symlink_drift` check.
- It is EXCLUDED from the agent EDITABLE-region merge: `lib/ga-symlink.sh` → `is_merge_claimed_path` returns "no" for this basename, so the charter byte-swaps on update rather than merging. `scripts/test/deploy-coverage-partition.bats` pins that the merge loop skips it. There is therefore no EDITABLE-region count constraint on this file, and no `<!-- EDITABLE -->` markers belong in it.
- The manifest carries TWO rows with the same content hash — one for the `agents/` path, one for the `rules/glass-atrium/` symlink — so any content edit invalidates both and requires a manifest regeneration.

## Machine-read shapes (moved out of the charter body)

The charter's head comment names the class of shape; what binds is below.

| Shape | Asserted by | What binds |
|---|---|---|
| Heading POSITION | `autoagent/test/test_pre_verify_section_excerpt.py` | The heading `### Turn Budget & Graceful Exit [ALL]` must open PAST character 6000. The daemon excerpts it as one whole heading block for the pre-verify prompt. |
| Schema-cap pointer clauses | `hooks/test/schema-cap-authority-single-site.bats` (C3/C4/C5, S1) | Three clauses present verbatim — `Schema-cap authority is single-sited` · `read them there before authoring any workflow output schema` · `this charter prescribes no cap of its own` — plus the path `skills/glass-atrium-ops-orchestrator.md` and the section name `Resilient Workflow Authoring`. |
| Schema-cap token ABSENCE | same suite (C1/C2) | The charter must carry NO schema size-cap key name and not the old "cap every field" prescription. State any cap rule in the skill, never here. Do not paste a cap token into this note either. |
| Emit marker phrase | `hooks/test/emit-discipline-doc-consistency.bats` (S1) | The hyphenated phrase `print-block-then-emit` present, grepped case-insensitively; the same phrase must also be present in `hooks/inject-scope-rules.sh` and `agents/glass-atrium-qa-code-reviewer.md`. |

- **A renamed heading is worse than a deleted one.** `text.find` returns -1, the test calls `skipTest`, and unittest scores a skip as green — so a rename goes quiet instead of red.
- **The `[ALL]` suffix is free, the rest of the heading is not**: the test's needle is the prefix `### Turn Budget & Graceful Exit`, used by `find` for the offset and by `startswith` for the block, so the suffix may change while no word before it may.
- **Never write that heading literal anywhere ABOVE its own position**: the test resolves the offset with a first-occurrence find, so a second copy higher up reports the wrong offset.
- **Keep it a line-start `###` heading**: the block lookup is a `next(...)` over `_split_heading_blocks` filtered on `startswith`, so a demoted or indented heading raises `StopIteration` — a test ERROR rather than a legible failure.
- **The test reads the LIVE install** (`daemon_cycle.GLOBAL_RULES_FILE` → `HOME/.claude/agents/GLASS_ATRIUM_GLOBAL_RULES.md`), never the repo tree — re-measure the deployed copy before a PR.
- **Headroom — stated qualitatively, never as a number here**: the heading opens far past the 6,000-character floor, so the slack is ample rather than tight.
  - Why no pair is written: a measured offset/total drifts on the very next edit above the heading — measure the file yourself when a cut above the heading is actually planned.
- **What spends that slack**: only deletion above the heading moves it earlier, toward the floor. Added text moves it later, away from the floor, so growth above the heading is never the risk.
- `RULE_EXCERPT_CHAR_CAP` is 120,000 and a file at or under the cap is returned verbatim, so this file cannot reach the TRUNCATED / OVERSIZED path.

## Restructure + diet pass (this wave)

Charter-specific instruction for the wave: restructure and diet, with **no rule removed**. Nothing below removes a duty.

- **Topic fix — four sections reparented.** `### Context Compression Strategies`, `### Parallel Tool Invocation`, `### Token Budget Allocation` and `### Handoff Context` sat under `## Cross-Session Continuity (progress.md)`, which is not their topic.
  - They now sit under `## Context Management [ALL]`, which was a one-line stub.
  - `### Turn Budget & Graceful Exit` and `### Session-Start Continuity Header` stay under Cross-Session Continuity, where the checkpoint-to-progress-file duty genuinely lands.
- **`## Absolute Rules [ALL]` gained three sub-headings** — `### Output Language`, `### Ambiguity`, `### Verified References`.
  - The short hard prohibitions (sensitive data, handoff payloads, log masking, Output Contract, Monitor address) stay as plain bullets above them.
  - No heading was renamed. Every external citation of the form "Absolute Rules → Output Language" still resolves, now to a heading rather than a bolded lead.
- **Reply-language duplication collapsed (dup-in).** The charter stated the reply-language rule twice: a top-level bullet with eight sub-bullets, and again inside the Output Language block.
  - One statement now leads `### Output Language`.
  - The phrase "the response-language rule" is retained inline because `hooks/inject-session-context.sh` cites it by that name twice.
- **`Literal data` split at its seam.** The bullet ran past the shape cap carrying two rules. It is now two siblings: `**Literal data**` keeps the class list with its FORBIDDEN clause, and `**Names and identifiers keep their original form**` carries proper nouns, project names, identifiers, API names and the report/plan prefixes.
  - The lead `**Literal data**` survives byte-identical, so every citation of it still resolves — but it now covers ONE of the two classes, and the split is what narrowed it.
  - **Both classes restated inline, so the narrowing strands neither reader**: `agents/glass-atrium-intel-reporter.md` → **Preservation exceptions** · `agents/glass-atrium-meta-prompt-engineer.md` → `## Body Language Policy`.
  - **Points at the clause without restating it, so it lands on the narrowed half**: `agents/glass-atrium-meta-agent.md` → "the canonical's Literal data clause". Repair when that body is next touched — cite `### Output Language` one level up, or name both leads.
  - Co-edited in the same pass: the reply-language sub-bullet that read "per Literal data below" now reads "per Names and identifiers below", the half it actually needs.
- **Machine-checked paragraphs moved here**, replaced by the one head comment: the Turn Budget position notice, the schema-cap suite notice, and the print-block-then-emit marker notice. Each described a test to a reader who is an agent, not an editor. The clauses the tests actually grep all stayed in the body.
- **Dropped as pointer-only stubs to delivered Tier-1 files**: `## Outcome Record [ALL]` (two blockquote pointers into `core-outcome-record.md`, including its Emit Boundary pointer) and `## Wiki Reference (Knowledge Utilization) [ALL]` (one pointer into `core-wiki-reference.md`).
  - Both targets are Tier-1 and arrive on the same host channel as the charter; every subagent also receives the compressed emit-format block from `hooks/inject-scope-rules.sh`. No corpus site cited either heading.
  - The `## Learning Log & Correction Signal [ALL]` heading was NOT dropped: it carries the memory-persistence rule, which is a duty rather than a pointer.
- **Dated and historical fragments dropped, claims kept**: "reversed from 4.8's adaptive/as-needed default", "accepted since 4.8", "128k max output unchanged", "Structured Outputs — now GA", and the "0/129 observed" count on the schema-mode caveat.
  - Each stated how a fact came to be, not what to do about it; the rule each tailed is unchanged.
  - The honest-backing note on daemon auto-clustering was KEPT (it tells the reader the prohibition has no runtime gate); the `learning-aggregator.py` filename went, as detail `core-learning-log.md` already carries.
- **Preamble merged**: the head "see bottom" sentence and the trailing per-scope-mapping blockquote were one pointer split across the file. They are now one line carrying both compliance-matrix anchors, so `rules/glass-atrium/core-compliance-matrix.md` → Headings stays true when it says the charter links to `## Scope Legend` and `## Compliance Matrix`.
- **Not touched**: `## Rationalization Rejection [ALL]` (the charter is the home that names the five domain files, and `scoped/maintainers/shared-testing.md` cites it), the 3-Tier table, and the ETHOS bullet list.

## Coupled tests and other readers

| Reader | Reads | Consequence of a careless edit |
|---|---|---|
| `autoagent/test/test_pre_verify_section_excerpt.py` | live charter, heading offset + whole-block extraction | red on a 6000-char breach; SILENT SKIP on a rename |
| `hooks/test/schema-cap-authority-single-site.bats` | live charter, 3 clauses present + 2 cap tokens absent | red on reword or on re-prescribing a cap |
| `hooks/test/emit-discipline-doc-consistency.bats` | live charter + inject hook + reviewer body | red if the marker phrase leaves any of the three |
| `scripts/test/deploy-coverage-partition.bats` | deploy partition | pins that the EDITABLE merge loop skips this basename |
| `hooks/test/enforce-foreground-harness.bats` + `-branch.bats` | basename allowlist | the charter basename is a background-write exception; renaming the file breaks both |
| `autoagent/daemon_cycle.py` | `GLOBAL_RULES_FILE`, sensitive-path regex, C2 prompt slot | path-keyed: a move breaks the Tier-2 safety trigger and the C2 excerpt |
| `scripts/lib/apply-spine.sh` | basename literal | classifies the charter as a non-agent file |
| `manifest.json` | two rows, one hash | regeneration required after any content edit |

Prose citations INTO charter anchors, all still resolving after this pass:

- `## Sub-Agent Spawn Policy` · `### Turn Budget & Graceful Exit` · `Emit-before-cap` · `Thinking Budget Policy`
- `## Absolute Rules [ALL]` · `Absolute Rules → Output Language` · `Absolute Rules → the response-language rule` · `Anchor by symbol`
- `Cross-Session Continuity (progress.md) [ALL]` and its `[CONTINUITY]` header activation contract · `File Deletion Policy`
- `## System Prompt Protection` · `AI-Generated Anti-Pattern Prohibition` · `Philosophy (ETHOS)` · `Rationalization Rejection`

## Outstanding

- **Open, owner elsewhere — the live-install read named under Machine-read shapes has no branch-side counterpart**: parametrizing the corpus path of `autoagent/test/test_pre_verify_section_excerpt.py` → `test_when_real_global_rules_read_then_turn_budget_section_is_whole` would make a repo-tree run meaningful for a branch.
  - Not taken here: that is a change to the test file, which this note does not own. Until someone takes it, the deployed-copy re-measure is a charter edit's only position coverage, and a branch copy has to be measured by hand.
- Do NOT add this note to `GA_ROSTER_PATHS` (`lib/ga-symlink.sh`) or `spine_get_roster_paths` (`scripts/lib/apply-spine.sh`) — companions fall to the plain byte-swap deploy consumer, as the already-tracked ones do. `lib/ga-env.sh` needs no edit either: `SYMLINK_EXCLUDE_PREFIXES` already carries the parent `scoped/` prefix.
- Checked, left alone: the charter cites `skills/glass-atrium-ops-orchestrator.md` → `### Resilient Workflow Authoring`, where the heading is a `####` carrying an `[ORCHESTRATOR]` suffix.
  - The name resolves and `rules/glass-atrium/orchestrator-role.md` writes the same form, so the level marker is a corpus-wide convention question rather than a charter defect to fix one file at a time.
