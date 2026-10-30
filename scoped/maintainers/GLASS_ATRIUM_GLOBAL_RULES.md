# Maintainer note — `agents/GLASS_ATRIUM_GLOBAL_RULES.md`

Corpus-maintenance companion to the Tier-1 system charter. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-read file — maintainer-facing, never a duty.
  - The other companions add "never injected"; here that holds only as the observation under "Applied here".
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the charter carries a single HTML editor comment at its head naming this note.
  - **The host project-instructions channel did not deliver it**: a spawned subagent's received charter opened at `# Agent Global Rules`, while the live file carries the comment above that heading.
    - Last observed 2026-10-30, on a glass-atrium-dev-shell spawn.
  - Re-check after a host update: read a spawned subagent's received project instructions and look for the comment.

## Status in the corpus

- Tier-1, and it arrives: the charter reaches every agent — main session and subagent alike — on the unceilinged host project-instructions channel, so a duty homed here is a duty an agent actually holds.
  - Delivery detail: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`.
- The file lives at `agents/` and is reached from `rules/glass-atrium/` through a symlink (git mode 120000 on the rules side, 100644 on the agents side).
  - The charter must stay at `agents/`; the symlink target is pinned by `scripts/test/update-symlink-mode-row.bats`, the manifest `modes` key, and the census `symlink_drift` check.
- It is excluded from the agent EDITABLE-region merge: `lib/ga-symlink.sh` → `is_merge_claimed_path` returns "no" for this basename, so the charter byte-swaps on update rather than merging.
  - So no EDITABLE-region count constraint applies, and no `<!-- EDITABLE -->` markers belong in it.
- The manifest carries two rows with the same content hash — one for the `agents/` path, one for the `rules/glass-atrium/` symlink — so any content edit invalidates both and requires a manifest regeneration.

## Machine-read shapes (moved out of the charter body)

The charter's head comment names the class of shape; what binds is below.

| Shape | Asserted by |
|---|---|
| Heading position | `autoagent/test/test_pre_verify_section_excerpt.py` |
| Schema-cap pointer clauses | `hooks/test/schema-cap-authority-single-site.bats` (C3/C4/C5, S1) |
| Schema-cap token absence | same suite (C1/C2) |
| Emit marker phrase | `hooks/test/emit-discipline-doc-consistency.bats` (S1) |

- **Heading position**: the heading `### Turn Budget & Graceful Exit [ALL]` must open past character 6000.
  - The daemon excerpts it as one whole heading block for the pre-verify prompt.
- **Schema-cap pointer clauses**: three clauses present verbatim, plus the path `skills/glass-atrium-ops-orchestrator.md` and the section name `Resilient Workflow Authoring`.
  - The clauses: `Schema-cap authority is single-sited` · `read them there before authoring any workflow output schema` · `this charter prescribes no cap of its own`.
- **Schema-cap token absence**: the charter must carry no schema size-cap key name and not the old "cap every field" prescription.
  - State any cap rule in the skill, never here.
  - Do not paste a cap token into this note either.
- **Emit marker phrase**: the hyphenated phrase `print-block-then-emit` present, grepped case-insensitively.
  - The same phrase must also be present in `hooks/inject-scope-rules.sh` and `agents/glass-atrium-qa-code-reviewer.md`.

Heading-position suite detail:

- **A renamed, deleted, demoted or indented heading fails the suite.** The test filters `_split_heading_blocks` on `startswith` the needle and asserts exactly one block, so any of these goes red.
- **The `[ALL]` suffix is free, the rest of the heading is not**: the test's needle is the prefix `### Turn Budget & Graceful Exit`, used by `find` for the offset and by `startswith` for the block, so the suffix may change while no word before it may.
- **Never write that heading literal anywhere above its own position**: the test resolves the offset with a first-occurrence find, so a second copy higher up reports the wrong offset.
- **The test reads the tracked repo copy** (`_TRACKED_GLOBAL_RULES` → `agents/GLASS_ATRIUM_GLOBAL_RULES.md`, patched in as `daemon_cycle.GLOBAL_RULES_FILE`), so a branch run measures the branch.
  - CI runs it only on the Python leg, which a markdown-only change skips: run `python3 -m unittest autoagent.test.test_pre_verify_section_excerpt` locally after a charter edit.
- **Headroom is ample**: the heading opens far past the 6,000-character floor, and only deletion above it moves it toward that floor — added text moves it away.
  - Never record a measured offset here — it drifts on the next edit above the heading; measure the file yourself when a cut above the heading is planned.
- `RULE_EXCERPT_CHAR_CAP` is 120,000 and a file at or under the cap is returned verbatim, so this file cannot reach the TRUNCATED / OVERSIZED path.

## Why kept items stay

- **Inclusion test**: a rule belongs in the charter only if it applies to every agent regardless of scope, model, or task type.
- **`### Output Language`**: `hooks/inject-session-context.sh` restates it in its "Reply language" heredoc lines and cites "the response-language rule" by name — re-verify the hook text on any edit to that section.
- **Two keep-original leads**: `Literal data` covers one class and `Names and identifiers keep their original form` the other, so a citer naming only Literal data lands on the narrower half.
  - `agents/glass-atrium-meta-agent.md` → "the canonical's Literal data clause" is such a citer: repair it when that body is next touched — cite `### Output Language`, or name both leads.
- **`## Context Engineering Principle [ALL]` and its "80K+" drift line**: kept for `hooks/advisory-context-budget.sh` (table below).
- **Headings kept because a file outside the charter cites them**:
  - `### Handoff Context` — `skills/glass-atrium-ops-orchestrator-role.md`.
  - `#### Work-unit checkpoint dimension` — `agents/glass-atrium-meta-prompt-engineer.md`, dev-shell, dev-python and dev-react notes.
  - `## Position Bias Mitigation [ALL]` — planner and reporter bodies, the orchestrator skill, the scope-dev note.
  - `## 3-Tier Boundary [ALL]` and `### Temporary Files [ALL]` — agent notes.
- **Turn Budget `Exempt` bullet**: `hooks/inject-scope-rules.sh` skips the meter for the verdict-only agent and cites this bullet as the reason.
- **`## Learning Log & Correction Signal [ALL]`**: `core-learning-log.md` → Write-Gate omits the auto-path ban because the charter states it.
- **`## Rationalization Rejection [ALL]`**: the charter names the five domain home files, and `scoped/maintainers/shared-testing.md` cites it.

## Thinking Budget Policy — measured precedence

- The charter's **Default tier** claim was measured for a parent tier at or above settings `effortLevel`.
- Measured beyond the table's wording:
  - workflow spawn with no `agent()` option: a frontmatter key beats a higher parent tier;
  - manual, unnamed `Agent` call: the key beats the parent tier in both directions.
- Unmeasured: whether a key alone raises a spawn above a lower parent tier — on a workflow spawn with no `agent()` option, or on a named call.

## Coupled tests and other readers

Beyond the suites in `## Machine-read shapes (moved out of the charter body)`:

| Reader | Reads | Consequence of a careless edit |
|---|---|---|
| `scripts/test/deploy-coverage-partition.bats` | deploy partition | pins that the EDITABLE merge loop skips this basename |
| `hooks/test/enforce-foreground-harness.bats` + `-branch.bats` | basename allowlist | a Harness Path Protection BASENAME exception; renaming the file breaks both |
| `autoagent/daemon_cycle.py` | `GLOBAL_RULES_FILE`, sensitive-path regex, C2 prompt slot | path-keyed: a move breaks the Tier-2 safety trigger and the C2 excerpt |
| `scripts/lib/apply-spine.sh` | basename literal | classifies the charter as a non-agent file |
| `scripts/lib/path-guard.sh` → `ga_guard_path` | nothing — one-way: `File Deletion Policy` restates its refusal set | a guard-only change splits the two sets, and no test compares them — change both in one edit |
| `scripts/audit-rm.sh` | `File Deletion Policy`, over the repo's in-scope shell files only | other code, other repos and agent-run commands are honor-system |
| `hooks/advisory-context-budget.sh` + its bats | heading `Context Engineering` and "80k+" in the advisory text | the advisory points at text that is gone |

Prose citations into charter anchors — grep each before renaming its target:

- **Spawn and budget**: `## Sub-Agent Spawn Policy` · `### Turn Budget & Graceful Exit` · `Emit-before-cap` · `Thinking Budget Policy`
- **Absolute Rules**: `## Absolute Rules [ALL]` · `Absolute Rules → Output Language` · `Absolute Rules → the response-language rule` · `Anchor by symbol`
- **Continuity and files**: `Cross-Session Continuity (progress.md) [ALL]` and its `[CONTINUITY]` header activation contract · `File Deletion Policy`
- **Conduct**: `## System Prompt Protection` · `AI-Generated Anti-Pattern Prohibition` · `Philosophy (ETHOS)` · `Rationalization Rejection`
- **Precedence**: `### Precedence Resolution`, cited by:
  - rule prose: `scoped/scope-meta.md` · `scoped/scope-planning.md` · the `rules/glass-atrium/core-compliance-matrix.md` → `## Precedence Resolution` stub;
  - skill references: `skills/glass-atrium-ops-delegation-contracts/references/delegation-prompt.md` · `skills/glass-atrium-ops-delegation-contracts/references/architecture-patterns.md`;
  - maintainer notes: `scoped/maintainers/scope-meta.md` · `scoped/maintainers/scope-planning.md` · `scoped/maintainers/scope-security.md`.

## Outstanding

- **Open, owner elsewhere — code comments still say every `rules/glass-atrium/` member already arrives on the host project-instructions channel**: untrue for the two path-scoped members.
  - Their delivery: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)` → **Path-scoped delivery**.
  - `hooks/lib/inject_chunk.py` → `get_membership` → the comment reading "already arrive on the host".
  - `scripts/agent_lifecycle/scaffold.py` → module docstring → "it arrives on the host".
  - `hooks/test/inject-scope-chunker.bats` → the test comment reading "already arrives on the host project-instructions channel".
  - Owner: the next lane whose `[SCOPE]` holds these files — reword each so it excludes the path-scoped members.
  - Not taken here: all are code files, which this note does not own.
- Do not add this note to `GA_ROSTER_PATHS` (`lib/ga-symlink.sh`) or `spine_get_roster_paths` (`scripts/lib/apply-spine.sh`).
  - Companions fall to the plain byte-swap deploy consumer, as the already-tracked ones do.
  - `lib/ga-env.sh` needs no edit either: `SYMLINK_EXCLUDE_PREFIXES` already carries the parent `scoped/` prefix.
