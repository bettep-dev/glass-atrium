# Maintainer note — `skills/glass-atrium-ops-orchestrator.md`

Maintainer-facing material for that skill reference. Nothing here binds the orchestrator; the skill file carries the duties.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the skill file carries no stub heading and no prose pointer to this note.
  - The one editor-addressed HTML comment, atop `### Architecture Patterns [ORCHESTRATOR]`, is the carve-out above: suites extract that H3's fences and grep its rule phrases, and the comment names this note.

## `## Core Process` — held cap and relocations

### Held cap exception — `## Core Process`

- This H2 stays over the 8 KB H2 cap because it contains the held `### Architecture Patterns [ORCHESTRATOR]`, itself over 8 KB.
- Every other H3 under it is held to the 3 KB H3 cap, read as 3,000 B (UTF-8, heading to the next H3); re-measure the H2 once that H3's pins retire.

### Held cap exception — `### Architecture Patterns [ORCHESTRATOR]`

- This H3 stays over the 3 KB H3 cap.
- Each block below is held in place by the pin its row names.
- Move a block only once its pin is retired or repointed in the same pass.

| Block (under this H3) | Pin that holds it in place |
|---|---|
| `#### Resilient Workflow Authoring [ORCHESTRATOR]` and its `#####` children | frozen `agents/` citations at this level · `schema-cap-authority-single-site.bats` |
| `##### Absolute schema-cap rules` | the rule phrases `orchestrator-skill-schema-example.bats` greps in this file |
| `##### Copyable helper (robustAgent)` | its `js` fence, replayed by `workflow-gate-completion-channel.bats` |
| `##### Stage gates` | revision caps cited by `references/review-rounds.md` · `scoped/maintainers/orchestrator-role.md` |
| `###### Copyable skeletons — 2-phase (verify → implement) and its 3-phase variant` | `###### Machine-checked skeletons` suites · the gate hook header's promotion condition |
| `##### Entry-class token placement (ultracode — DEV workflow)` | its declaration fence, read by the same suites |

#### Relocated — `#### Analysis-Track Right-Sizing (input-side) [ORCHESTRATOR]`

- The heading stays in the skill as a three-bullet pointer; its body and `AnalysisSchema` fence live in `skills/glass-atrium-ops-delegation-contracts/references/delegation-size-discipline.md` → `## Analysis-Track Right-Sizing (input-side)`.
- Pins that read the moved fence from the reference, so a further move repoints them in the same pass:
  - `hooks/test/orchestrator-skill-schema-example.bats` → `EXEMPLAR` (D1–D3, AC13).
  - `hooks/test/workflow-gate-completion-channel.bats` → `ANALYSIS_REF` (both skeleton floors).
- Citers of the moved section:
  - `references/delegation-prompt.md` → `## Resource Budget` (the floor bullet) · `## Read-Extent Discipline` → **Scope of this duty**.
  - the skill's **Print-block-then-emit** bullet (via the kept heading).
  - `hooks/enforce-workflow-verify-stage.sh` → `PROMOTION CONDITION` — both sentences name the reference beside the skill; verbatim pin: `enforce-workflow-verify-stage.bats` → `schema-cap(promotion)`.

### Relocated — Agent selection and delegation-prompt detail

- Each heading stays in the skill as a pointer stating its duty; bodies live in `skills/glass-atrium-ops-delegation-contracts/references/`:
  - `agent-selection.md` ← `#### Selection procedure` · the `#### Ordering caveat` heading · `#### Compound Task Examples` · `#### Routing-Decision Record (observability convention)` · `#### Routing Verification (LLM-as-Judge)`.
  - `delegation-prompt.md` ← `#### Resource Budget` · `#### Prompt-content aids` · `#### Read-Extent Discipline [ORCHESTRATOR]` · `#### Delegation Information-Hiding [ORCHESTRATOR]`.
- External citer: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Routing output: team schema, size, and correlation ID` → **Example**.
- No test, hook message or `agents/` file reads the moved text.

## `## Orchestrator On-Demand Mechanisms` — linkage and held cap

- The group is split across these H2s so each H2 without a held H3 stays within the 8 KB cap:
  - `## Orchestrator On-Demand Mechanisms` — the ceremony and `### Reply Form Contract (main-session user-facing replies)`.
  - `## Workflow-Tool Execution (On-Demand)` — `### Ultracode / Workflow-tool Mode` alone.
  - `## Approval Protocols (On-Demand)` — `### Scope-Expansion Approval Protocol` and `### Self-Improvement User-Approval Trigger`.
  - Every citer names an H3, never one of these H2s; the first H2's lead names each of them and the two `## Managed Document …` sections.
- Reached from `skills/glass-atrium-ops-orchestrator-role.md` through `> Detail:` pointers, except `### Self-Improvement User-Approval Trigger`, which Tier-1 `core-learning-log.md` → Instruction Improvement Approval Tier points at.
  - `autoagent/daemon_cycle.py` also cites that heading by name (frozen; keep it byte-identical).
- `### Reply Form Contract (main-session user-facing replies)` is the canonical; `GLASS_ATRIUM_GLOBAL_RULES.md` → AI-Generated Anti-Pattern Prohibition holds its one pointer.
  - Single-siting is checked only at PR review (diff inspection).

### Held cap exception — `### Ultracode / Workflow-tool Mode`

- This H3 stays over the 3 KB H3 cap, and so its own H2, `## Workflow-Tool Execution (On-Demand)`, stays over the 8 KB H2 cap.
- Every other H3 of the group is held to 3,000 B; re-measure with `wc -c` after any edit there.
- Each block is held in place by a citer that cannot be repointed without a frozen or hook edit:

| Block (under this H3) | Pin that holds it in place |
|---|---|
| the H3 itself · `#### Engine-vs-orchestrator layering` | `agents/GLASS_ATRIUM_GLOBAL_RULES.md` ("Layering detail") |
| **Persist-intent research stage (explicit side-effect exception)** | `agents/glass-atrium-intel-researcher.md` |
| `#### Workflow pre-flight (run before EVERY Workflow call)` item numbers | `core-outcome-record.md` (item 8) · `scoped/maintainers/scope-dev.md` and the role file (item 1) |
| pre-flight item 8 text (343 B, over the 300 B bullet cap) | kept byte-identical by delegation as a hook-quoted literal |
| `#### Completion-channel non-emission …` heading, population and recipe | `hooks/enforce-workflow-verify-stage.sh` messages name the section and say it carries both |

### Completion-channel measurement — editor duties

- `#### Completion-channel non-emission …` (in the skill) is the measurement SoT for the non-emission share: change its shape there first, then propagate; never fork the wording.
- `hooks/enforce-workflow-verify-stage.sh` quotes the shape at the sites below, each naming the sub-section as SoT; a new quoting site joins this list:
  - the header's fifth-advisory-pass block;
  - `print_completion_channel_advisory` (property-absent);
  - `print_completion_schema_absent_advisory` (schema-absent).
- Machine-checked: `hooks/test/workflow-gate-completion-channel.bats` asserts the shape phrase in that hook's stderr, so a shape change edits that suite in the same pass.
- Why the SoT sits in the skill: a hook message is a fixed nudge, whereas the re-derivation recipe needs a home that is re-read and re-run.
- The schema-absent silencer (c), the wrapper case, comes from the shared roster predicate; the schema-absent acceptance criterion covers direct-spawn firing only, not (c).
- The cross-module-schema false positive is not a fail-open — the two read oppositely, so never relabel it.

### Other editor facts from that H2

- Both facts sit under the skill's `## Approval Protocols (On-Demand)`.
- `### Scope-Expansion Approval Protocol`: promotion of the token check to an exit-2 block is structurally blocked, not deferred — a prompt scan cannot tell an expansion intent from a mention of one.
  - Re-opening it needs a new pre-tool intent signal, not more coverage data.
- `#### Automation Boundary`: `scripts/llm-preflight.sh` is not dead code — `autoagent/autoagents-eval.sh` sources it for its `llm_preflight 10.00` call, a manually invoked eval path CI does not run.

### Relocated — ceremony steps and completion-signal detail

- `skills/glass-atrium-ops-delegation-contracts/references/agent-lifecycle-ceremony.md` ← the ceremony's CLI refusal list and these H4s, now `##` headings there:
  - `#### The 6 steps, each building on the previous` · `#### EXTEND path (step 3-alt — the DEFAULT branch)` · `#### Failure recovery (exit code → action)`.
  - The ceremony H3 keeps the trigger and standing conditions.
- `skills/glass-atrium-ops-delegation-contracts/references/completion-signals.md` ← the evidence detail of `#### Completion signals`, which stays as the pointer site (cited by `scoped/orchestrator-core.md`, the role file and `references/automatic-parallelization.md`).
- `skills/glass-atrium-ops-delegation-contracts/references/plan-direction-verification.md` → `## Backstop detail` ← the manual-gate race and nested-origin detail from `#### Hook layer split under the engine`.
- No test, hook message or `agents/` file reads the moved text, and the moved ceremony headings have no citer but this note.

## `## Managed Document Completion (Direct Handling)` and `## Red Flags` — relocations

- `skills/glass-atrium-ops-delegation-contracts/references/managed-document-completion.md` ← Step 1's error cases and `sh` worked call; Step 2's decision table, row notes and honor-system residual.
  - Step 1 and Step 2 stay as pointer sites: `hooks/enforce-workflow-verify-stage.sh` and `hooks/enforce-verification-gate.sh` messages name the H2 and Step 1 as the stage write recipe; the role file and `scoped/orchestrator-core.md` cite Step 1 and Step 3.
- `skills/glass-atrium-ops-delegation-contracts/references/workflow-pre-submit-check.md` ← the `#### Pre-submit self-check …` check table and its per-check detail pointers.
  - The H4 stays under `## Red Flags`: earlier sections of the skill cite it there.
- `### Generic-subagent guard [LLM06/LLM01/LLM10]` and `## Red Flags` stay in place: `agents/GLASS_ATRIUM_GLOBAL_RULES.md` cites "Red Flags (Generic-subagent guard)" (frozen).
- No test reads the moved text: the suites that read this skill replay its `js` fences or grep phrases outside these sections, and the moved fence is `sh`.
