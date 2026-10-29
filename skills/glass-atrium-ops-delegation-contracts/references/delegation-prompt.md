# Delegation prompt content (orchestrator only)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### Delegation/Communication Rules [ORCHESTRATOR]`, which states each duty and when it fires.
- This file holds the detail behind those pointers.

## Resource Budget

Every delegation prompt MUST declare these fields, so a sub-agent never exhausts its tool chain before emitting a synthesis:

| Field | Meaning | Default |
|-------|---------|---------|
| `tool_budget` | Max total tool uses; hitting the ceiling → stop + emit status | per role, table below |
| `output_cap` | Final-output shape | the decision-relevant result inline; bulk to a file returned by path (File-handoff, below) |
| `reserved_output` | Emit tail reserved before work starts | Reserve-then-check (below) |
| `scope_cap` | Explicit item/file count — no expansion without re-delegation | explicit item count |
| `tool_preference` | Default extraction tool selection | HTML ≥ 10KB: WebFetch with a narrow prompt (Bash-holding agents: defuddle-first) · structured/API < 8KB: WebFetch |
| `spawn_budget` | Max sub-agent invocations per Wave; hitting the ceiling → stop + escalate to user | per role, table below |

| Role | `tool_budget` | `spawn_budget` (per-wave soft budget) |
|---|---|---|
| glass-atrium-intel-researcher | ~15 | ~3 |
| glass-atrium-intel-planner | ~12 | ~2 |
| glass-atrium-qa-code-reviewer | ~14 | ~1 |
| DEV | the `[SIZE-EST]` `tool_uses~=` estimate for the same delegation | — |

- **`output_cap` File-handoff**: `skills/glass-atrium-ops-orchestrator.md` → `#### Resilient Workflow Authoring [ORCHESTRATOR]` → File-handoff.
- **DEV `tool_budget`** — where its estimate is bounded and formatted:
  - Split thresholds: `skills/glass-atrium-ops-orchestrator-role.md` → `#### Delegation-size discipline` → **Split triggers** (HARD SECONDARY · Empirical tool_use calibration).
  - Token format and per-file calibration: `references/delegation-size-discipline.md`.
- **`reserved_output`**: apply **Reserve-then-check** from `references/delegation-size-discipline.md` → **`[SIZE-EST]` analysis mode** — gate the read scope against `input_budget` before work, never after.
- **`spawn_budget`** bounds invocations only; concurrency is bounded by the engine's runtime self-cap (`skills/glass-atrium-ops-orchestrator-role.md` → `### Spawn Budget`).
- Hitting `tool_budget` before completion → the graceful exit in `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`, carrying partial findings; never a silent exit.
- These defaults are a **floor to size against, not advisory-only prose**: `references/delegation-size-discipline.md` → `## Analysis-Track Right-Sizing (input-side)` encodes them into the analysis skeleton by construction.

## Prompt-content aids

Both aids help the sub-agent self-anchor; neither is hook-enforced.

- **TASK_TYPE delegation hint (optional)**: when task_type is ambiguous, the orchestrator MAY add one line to the delegation prompt:
  - `TASK_TYPE: <planning|document|implementation|analysis|research|review|debug>`
  - Optional because the planner, reporter and DEV descriptions already carry prompt-level rules for it.
- **Domain keywords (optional)**: pair the task description with the target agent's matching `domains` terms from `agent-registry.json` (e.g., "Modify user auth logic — nestjs, jwt, passport").
  - They anchor the sub-agent's reading of the task and are never routing keys — the spawn's typed `agentType` already fixes the agent.

## Read-Extent Discipline

A read allowlist bounds *which* artifacts a delegation may open; it says nothing about *how much* of each.
Both halves belong in every delegation prompt — a two-entry allowlist of large artifacts passes a no-sweep rule and still charges the whole document to every member of the fan-out.

- **Scope of this duty**: every delegation that instructs a read — not only the schema-mode analysis spawns `## Analysis-Track Right-Sizing (input-side)` sizes (`references/delegation-size-discipline.md`).
- **Bounds the context consulted, never the artifact under work** — extent governs the supporting documents a role opens to do its job; the artifact it is reviewing, debugging, or rewriting is read at whatever depth the role's own body mandates.
  - **Artifact case** — where a role body mandates a full read of what it works on (`glass-atrium-qa-code-reviewer` "Read changed files in full"), that body governs and this duty does not reach it: changed files are the artifact under review.
  - **Context case — a role body can override the extent duty on context too, stated rather than implied**: `glass-atrium-qa-debugger` "Read related code in full" reaches supporting context, the half this duty otherwise bounds, and it still governs.
    - The override reaches only the context class that body names, for the work that body describes.
    - Every other entry in the same read scope still carries an extent, and the override never widens into the clause the **No open-ended latitude clause** bullet forbids.
  - Why both overrides are stated: skill files sit outside `core-compliance-matrix.md`, so the tier order in `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` adjudicates no skill-versus-agent-body conflict.

### Authoring rules

- **Name the extent beside every path** — each entry in a delegation's read scope states the portion the role needs (the section, the heading, the extracted atom), never the bare path alone.
- **Read the passage, not the document containing it** — where the unit of work is an atom already extracted into a scratch file, that file is the read scope; its source file is a pointer to consult on a specific question, never a reading assignment.
- **Bind only the clauses that bind the role** — an authority document read "in full first" charges every role the whole text while most of it governs neither; cite the clauses the role must honor, and let it fetch the rest by name when a question actually arises.
- **No open-ended latitude clause** — "if you need its surroundings" / "read more if helpful" is always taken, and taken once per member. State the fallback as a condition with a named target (`on an unresolved cross-reference, read <named section>`), or omit it.
- **Multiply by the fan-out before authoring** — a read that looks prudent in one prompt is paid N members × M roles; that product, not the single prompt, decides whether the extent is affordable.
- **Draft self-check — the tell is that it sounds prudent**: "read the contract in full first" reads as diligence, which is why it survives authoring and why no sweep rule catches it.
  - Ask of your own draft: is a role being sent to the whole of something when its work is a part of it? A read instruction that would be praised for thoroughness is the one to re-read.

### Backing

- Honor-system authoring discipline — every rule in this `## Read-Extent Discipline` section is unbacked.
  - The gates do read prompt prose: `enforce-verification-gate.sh` matches a plan reference (`references_plan`) and parses `[SCOPE] files=` membership (`scope_decl_files`), counting paths against `DEEP_REVIEW_FILE_THRESHOLD` and prefixes against `DEEP_REVIEW_SENSITIVE_PREFIXES`.
  - Extent — how much of a named path an instruction opens — is in no gate's input.

## Delegation Information-Hiding

- A DEV (or any implementation) sub-agent receives the verified plan, not the raw user-request transcript.
  - The plan part it receives: its work stream (direction + the files it touches) · acceptance criteria where the plan or the delegation states them · scoped files · binding constraints.
  - The orchestrator translates intent into a plan; the DEV executes it.

Rules:

- **Constraints MUST be preserved into the plan** — every constraint the original request carries (behavior-changing → advisory-first, minimal diff, SQL parameterization, file-ownership bounds, etc.) is forwarded into the delegation.
  - Why: a DEV cannot honor a constraint it never received.
- **Hide the ambiguity, not the requirements** — the plan is the disambiguated, constraint-complete contract: what to build plus the binding constraints.
  - Why: a raw request carries off-task detail and unresolved ambiguity the DEV would re-interpret, possibly wrongly.
- Complements `skills/glass-atrium-ops-orchestrator-role.md` → `### Context Handoff Size`: that rule caps size (summary only, no raw history); this rule fixes the shape (plan, not request).
