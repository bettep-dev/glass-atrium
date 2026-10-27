# Maintainer note — `agents/GLASS_ATRIUM_GLOBAL_RULES.md`

Corpus-maintenance companion to the Tier-1 system charter. Nothing here is delivered to an agent.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-read file — maintainer-facing, never a duty.
  - **Sibling wording**: the other companions attach "never injected" to that clause; the observation under "Applied here" below extends it to this file.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the charter carries a single HTML editor comment at its head naming this note.
  - **The host project-instructions channel did not deliver it**: a spawned subagent's received copy of the live charter opened at `# Agent Global Rules`, while the live file carries the five-line comment above that heading.
    - Observed on glass-atrium-meta-prompt-engineer and glass-atrium-qa-code-reviewer spawns, last on 2026-09-30.
  - Re-check after a host update: read a spawned subagent's received project instructions and look for the comment.

## Status in the corpus

- Tier-1, and it ARRIVES: the charter reaches every agent — main session and subagent alike — on the host project-instructions channel, which is unceilinged (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)`), so a duty homed here is a duty an agent actually holds.
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

- **A renamed, deleted, demoted or indented heading fails the suite.** The test filters `_split_heading_blocks` on `startswith` the needle and asserts exactly one block, so any of these goes red.
- **The `[ALL]` suffix is free, the rest of the heading is not**: the test's needle is the prefix `### Turn Budget & Graceful Exit`, used by `find` for the offset and by `startswith` for the block, so the suffix may change while no word before it may.
- **Never write that heading literal anywhere ABOVE its own position**: the test resolves the offset with a first-occurrence find, so a second copy higher up reports the wrong offset.
- **The test reads the tracked repo copy** (`_TRACKED_GLOBAL_RULES` → `agents/GLASS_ATRIUM_GLOBAL_RULES.md`, patched in as `daemon_cycle.GLOBAL_RULES_FILE`), so a branch run measures the branch.
  - CI runs it only on the Python leg, which a markdown-only change skips: run `python3 -m unittest autoagent.test.test_pre_verify_section_excerpt` locally after a charter edit.
- **Headroom — stated qualitatively, never as a number here**: the heading opens far past the 6,000-character floor, so the slack is ample rather than tight.
  - Why no pair is written: a measured offset/total drifts on the very next edit above the heading — measure the file yourself when a cut above the heading is actually planned.
- **What spends that slack**: only deletion above the heading moves it earlier, toward the floor. Added text moves it later, away from the floor, so growth above the heading is never the risk.
- `RULE_EXCERPT_CHAR_CAP` is 120,000 and a file at or under the cap is returned verbatim, so this file cannot reach the TRUNCATED / OVERSIZED path.

## Why kept items stay

- **Inclusion test**: a rule belongs in the charter only if it applies to every agent regardless of scope, model, or task type.
- **`### Output Language`**: `hooks/inject-session-context.sh` restates it in three heredoc lines and cites "the response-language rule" by name — re-verify the hook text on any edit here.
- **Two keep-original leads**: `Literal data` covers one class and `Names and identifiers keep their original form` the other, so a citer naming only Literal data lands on the narrower half.
  - `agents/glass-atrium-meta-agent.md` → "the canonical's Literal data clause" is such a citer: repair it when that body is next touched — cite `### Output Language`, or name both leads.
- **`## Context Engineering Principle [ALL]` and its "80K+" drift line**: kept for `hooks/advisory-context-budget.sh` (table below).
- **Headings kept because a file outside the charter cites them**:
  - `### Handoff Context` — `skills/glass-atrium-ops-orchestrator-role.md`.
  - `#### Work-unit checkpoint dimension` — `agents/glass-atrium-meta-prompt-engineer.md`, dev-shell and dev-python notes.
  - `## Position Bias Mitigation [ALL]` — planner and reporter bodies, the orchestrator skill.
  - `## 3-Tier Boundary [ALL]` and `### Temporary Files [ALL]` — agent notes.
- **Turn Budget `Exempt` bullet**: `hooks/inject-scope-rules.sh` skips the meter for the verdict-only agent and cites this bullet as the reason.
- **`## Learning Log & Correction Signal [ALL]`**: `core-learning-log.md` → Write-Gate omits the auto-path ban because the charter states it.
- **`## Rationalization Rejection [ALL]`**: the charter names the five domain home files, and `scoped/maintainers/shared-testing.md` cites it.

## Thinking Budget Policy — measured precedence

- The default-tier claim was measured for a parent tier at or above settings `effortLevel`.
- Workflow spawn: the `agent()` option beats the frontmatter key and the parent tier; a key beats a higher parent tier.
- Manual, unnamed `Agent` call: the frontmatter key beats the parent tier in both directions.
- Manual, named `Agent` call: a key did not lower a higher parent tier.
- Unmeasured: whether a key alone raises a spawn above a lower parent tier — on a workflow spawn with no `agent()` option, or on a named call.

## Coupled tests and other readers

| Reader | Reads | Consequence of a careless edit |
|---|---|---|
| `autoagent/test/test_pre_verify_section_excerpt.py` | tracked charter, heading offset + whole-block extraction | red on a 6000-char breach or a rename; CI skips it on a markdown-only change |
| `hooks/test/schema-cap-authority-single-site.bats` | live charter, 3 clauses present + 2 cap tokens absent | red on reword or on re-prescribing a cap |
| `hooks/test/emit-discipline-doc-consistency.bats` | live charter + inject hook + reviewer body | red if the marker phrase leaves any of the three |
| `scripts/test/deploy-coverage-partition.bats` | deploy partition | pins that the EDITABLE merge loop skips this basename |
| `hooks/test/enforce-foreground-harness.bats` + `-branch.bats` | basename allowlist | the charter basename is a Harness Path Protection BASENAME exception; renaming the file breaks both |
| `autoagent/daemon_cycle.py` | `GLOBAL_RULES_FILE`, sensitive-path regex, C2 prompt slot | path-keyed: a move breaks the Tier-2 safety trigger and the C2 excerpt |
| `scripts/lib/apply-spine.sh` | basename literal | classifies the charter as a non-agent file |
| `scripts/lib/path-guard.sh` → `ga_guard_path` | nothing of the charter — one-way: `File Deletion Policy` restates its refusal set | a guard-only refusal change splits the two sets, and no test compares them — change both in one edit |
| `scripts/audit-rm.sh` | `File Deletion Policy`, over the repo's in-scope shell files only | other code, other repos and agent-run commands are honor-system |
| `hooks/advisory-context-budget.sh` + its bats | heading `Context Engineering` and "80k+" in the advisory text | the advisory points at text that is gone |
| `manifest.json` | two rows, one hash | regeneration required after any content edit |

Prose citations INTO charter anchors — grep each before renaming its target:

- **Spawn and budget**: `## Sub-Agent Spawn Policy` · `### Turn Budget & Graceful Exit` · `Emit-before-cap` · `Thinking Budget Policy`
- **Absolute Rules**: `## Absolute Rules [ALL]` · `Absolute Rules → Output Language` · `Absolute Rules → the response-language rule` · `Anchor by symbol`
- **Continuity and files**: `Cross-Session Continuity (progress.md) [ALL]` and its `[CONTINUITY]` header activation contract · `File Deletion Policy`
- **Conduct**: `## System Prompt Protection` · `AI-Generated Anti-Pattern Prohibition` · `Philosophy (ETHOS)` · `Rationalization Rejection`
- **Precedence**: `### Precedence Resolution`, cited by:
  - rule prose: `scoped/scope-meta.md` · `scoped/scope-planning.md` · the `rules/glass-atrium/core-compliance-matrix.md` → `## Precedence Resolution` stub;
  - skill: `skills/glass-atrium-ops-orchestrator.md`, two sites;
  - maintainer notes: `scoped/maintainers/scope-meta.md` · `scoped/maintainers/scope-planning.md` · `scoped/maintainers/scope-security.md`.

## Outstanding

- **Open, owner elsewhere — two code comments still say every `rules/glass-atrium/` member already arrives on the host project-instructions channel**: untrue for the two path-scoped members.
  - Their delivery: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)` → **Path-scoped delivery**.
  - `hooks/lib/inject_chunk.py` → `get_membership` → the comment reading "already arrive on the host".
  - `scripts/agent_lifecycle/scaffold.py` → module docstring → "it arrives on the host".
  - Owner: the next lane whose `[SCOPE]` holds `hooks/lib/inject_chunk.py` / `scripts/agent_lifecycle/scaffold.py` — reword both so they exclude the path-scoped members.
  - Not taken here: both are code files, which this note does not own.
- Do NOT add this note to `GA_ROSTER_PATHS` (`lib/ga-symlink.sh`) or `spine_get_roster_paths` (`scripts/lib/apply-spine.sh`) — companions fall to the plain byte-swap deploy consumer, as the already-tracked ones do. `lib/ga-env.sh` needs no edit either: `SYMLINK_EXCLUDE_PREFIXES` already carries the parent `scoped/` prefix.
