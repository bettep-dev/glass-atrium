# Delegation prompt content (orchestrator only)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### Delegation/Communication Rules [ORCHESTRATOR]`, which states each duty and when it fires.

## Resource Budget

- Field meanings and defaults for the fields the pointer site requires — they exist so a sub-agent never exhausts its tool chain before emitting a synthesis.

| Field | Meaning | Default |
|-------|---------|---------|
| `tool_budget` | Max total tool uses | per role, table below |
| `output_cap` | Final-output shape | the decision-relevant result inline; bulk to a file returned by path (File-handoff, below) |
| `reserved_output` | Emit tail reserved before work starts | Reserve-then-check (below) |
| `scope_cap` | Explicit item/file count — no expansion without re-delegation | none — each delegation states it |
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
- **`reserved_output`**: apply **Reserve-then-check** from `references/delegation-size-discipline.md` → **`[SIZE-EST]` analysis mode**.
- **`spawn_budget`** bounds invocations only; concurrency is bounded by the engine's runtime self-cap (`skills/glass-atrium-ops-orchestrator-role.md` → `### Spawn Budget`).
- Hitting `tool_budget` before completion → stop and take the graceful exit in `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Turn Budget & Graceful Exit`, carrying partial findings.
- These defaults are a **floor to size against, not advisory-only prose**: `references/delegation-size-discipline.md` → `## Analysis-Track Right-Sizing (input-side)` encodes them into the analysis skeleton by construction.

## Prompt-content aids

- Both aids help the sub-agent self-anchor; neither is hook-enforced.
- **TASK_TYPE delegation hint (optional)**: when task_type is ambiguous, the orchestrator MAY add one line to the delegation prompt:
  - `TASK_TYPE: <planning|document|implementation|analysis|research|review|debug>`
- **Domain keywords (optional)**: pair the task description with the target agent's matching `domains` terms from `agent-registry.json` (e.g., "Modify user auth logic — nestjs, jwt, passport").
  - Never routing keys — the spawn's typed `agentType` already fixes the agent.

## Read-Extent Discipline

- A read allowlist bounds *which* artifacts a delegation may open, never *how much* of each: a two-entry allowlist of large artifacts passes a no-sweep rule and still charges the whole document to every member of the fan-out.
- **Scope of this duty**: the pointer site's extent duty reaches beyond the schema-mode analysis spawns `## Analysis-Track Right-Sizing (input-side)` sizes (`references/delegation-size-discipline.md`).
- **Bounds the context consulted, never the artifact under work** — two role bodies settle its edges:
  - **Artifact case** — where a role body mandates a full read of what it works on (`glass-atrium-qa-code-reviewer` "Read each changed file in full"), that body governs and this duty does not reach it: changed files are the artifact under review.
  - **Context case** — a role body can override the extent duty on context too: `glass-atrium-qa-debugger` "Read related code in full" reaches supporting context and still governs.
    - The override reaches only the context class that body names, for the work that body describes.
    - Every other entry in the same read scope still carries an extent, and the override never widens into the clause the **No open-ended latitude clause** bullet forbids.
  - Why both overrides are stated: skill files sit outside `core-compliance-matrix.md`, so the tier order in `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Precedence Resolution` adjudicates no skill-versus-agent-body conflict.

### Authoring rules

- **Read the passage, not the document containing it** — where the unit of work is an atom already extracted into a scratch file, that file is the read scope; its source file is a pointer to consult on a specific question, never a reading assignment.
- **Bind only the clauses that bind the role** — an authority document read "in full first" charges every role the whole text while most of it governs neither; cite the clauses the role must honor, and let it fetch the rest by name when a question actually arises.
- **No open-ended latitude clause** — "if you need its surroundings" / "read more if helpful" is always taken, and taken once per member. State the fallback as a condition with a named target (`on an unresolved cross-reference, read <named section>`), or omit it.
- **Multiply by the fan-out before authoring** — a read that looks prudent in one prompt is paid N members × M roles; that product, not the single prompt, decides whether the extent is affordable.
- **Draft self-check — the tell is that it sounds prudent**: a read instruction that would be praised for thoroughness ("read the contract in full first") is the one to re-read.

### Backing

- Honor-system authoring discipline — every rule in this `## Read-Extent Discipline` section is unbacked.
  - The gates do read prompt prose — `enforce-verification-gate.sh` takes a plan reference (`references_plan`) and `[SCOPE] files=` membership (`scope_decl_files`) — but extent, how much of a named path an instruction opens, is in no gate's input.

## Delegation Information-Hiding

- The plan part the implementation sub-agent receives: its work stream (direction + the files it touches) · acceptance criteria where the plan or the delegation states them · scoped files · binding constraints.
- **Constraints MUST be preserved into the plan** — every constraint the original request carries (behavior-changing → advisory-first, minimal diff, SQL parameterization, file-ownership bounds, etc.) is forwarded into the delegation.
- **Hide the ambiguity, not the requirements** — the plan is the disambiguated contract.
  - Why: a raw request carries off-task detail and unresolved ambiguity the DEV would re-interpret, possibly wrongly.
