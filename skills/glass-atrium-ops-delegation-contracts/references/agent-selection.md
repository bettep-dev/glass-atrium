# Agent selection (orchestrator only)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### Capability-Based Agent Selection [ORCHESTRATOR]`, which states each duty and when it fires.
- This file holds the detail behind those pointers.

## Selection procedure

Each step consumes the previous step's output — run them in order.

1. **Task Decomposition**: decompose the request into sub-tasks.
   - Compound shapes the pointer site's 2+-element rule covers: "do A and also B" / "find the cause and fix it" / "research and turn it into a report".
   - **Task Decomposition Questions**: Self-contained? · Boundary interface contract explicit? · Causal chain unsplit?
2. **Capability Consultation** (hints only, no forced match):
   - **`domains` array** (`~/.glass-atrium/agent-registry.json`): each agent's capability list, compared semantically against each sub-task.
   - **Agent description** (frontmatter): when needed, lazy-load the top 2-3 candidates' descriptions for precise judgment.
   - **Phase numbers**: `research(1) → analysis(2) → planning(3) → implementation(4) → review(5) → report/document(6)` — ordering only, never matching.
3. **Team Composition Decision**: sort the selected agents by phase number, ascending.
   - Independent tasks within the same phase MAY run in parallel (Fan-out).
4. **Execution**: run in sorted order, or in parallel within one phase.
   - A DEV agent with `dual_phase: true` takes phase 2 or 4 from the decomposition result: diagnosis-only → 2, includes implementation → 4.
     - Term SoT: `~/.glass-atrium/agent-registry.json` — top-level `dual_phase_definition` defines the flag, and the `phases` key holds the phase 1-6 map.
     - The flag says an agent has a plan-then-execute split; it never assigns the phase, which stays the per-task decomposition call.

## Ordering caveat (ultracode verify-gate)

- Phase sorting spawns a `dual_phase` DEV assigned phase-2 analysis ahead of a phase-5 reviewer; **Execution** above permits that order.
- Under ultracode a directly spawned pre-verify analysis DEV is truthfully a declared `impl:` spawn, and that — not spawn order alone — trips `block-order`: the gate working, not a false positive.
  - Verdict: `references/ultracode-declaration-contract.md` → Exit-2 verdicts → `block-order`.
- The fix is compositional: either route of `skills/glass-atrium-ops-orchestrator.md` → ``### Pre-verify Discovery `dev-*` order guard (ultracode)``.
  - The plain reorder the `block-order` exit-2 message (`hooks/enforce-workflow-verify-stage.sh`) also offers rarely applies, because the analysis has to come first.
- Why `impl-computed:` is wrong here: it is the key for indirectly spawned types, so declaring this direct spawn under it is a false declaration, whether or not the gate accepts it.

## Compound Task Examples

Representative cases where a compound team return outperforms single matching.

| User Request | `agents` | `order` | `reason` (gist) |
|--------------|----------|---------|-----------------|
| "Write a planning doc and also propose a design direction" | `[glass-atrium-intel-planner, glass-atrium-design-designer]` | `[3, 2]` → sorted `[designer, planner]`, or `parallel` | planning doc → planner (phase 3) · design direction → designer (phase 2); independent → parallelizable |
| "Find the cause of this login error and fix it" | `[glass-atrium-qa-debugger, glass-atrium-dev-react]` | `[2, 4]` sequential | debugger diagnoses → dev-react fixes the frontend login: a diagnosis → implementation pipeline |
| "Research the latest RAG techniques and turn it into a report" | `[glass-atrium-intel-researcher, glass-atrium-intel-reporter]` | `[1, 6]` sequential | researcher investigates → reporter synthesizes; "report" makes it compound |
| "Write or revise an agent prompt / rule / skill file" | `[glass-atrium-meta-prompt-engineer, glass-atrium-intel-reporter]` | `[4, 6]` sequential | author → prompt-audit → independent structure verdict (scope-meta.md → Prompt Deliverable Team Rule) |

## Routing-Decision Record

- The three routing safety layers are LLM self-judgment with no runtime trace, so a low-confidence mis-route cannot be detected after the fact.
- Record format, at the point of delegation:
  - `route: <selected agentType(s)> | confidence: <0.0-1.0> | rationale: <≤1 line, cite the matched domains/description>`
  - When confidence < 0.7, append the action taken: `halt+clarify` with the 2-3 candidates presented.
- **Honest backing**: a recommended self-logged audit trail, not a runtime gate.
  - No hook can force or verify a main-loop emission, so the record makes a route reviewable afterwards — it never makes routing "verified".

## Routing Verification (LLM-as-Judge)

Before emitting a delegation, self-check:

- Is `agents[].domains` matched to the sub-task semantically, not by keyword?
- Does the `reason` field cite specific `domains` entries or description passages?
- Is confidence ≥ 0.7? If not → clarification fallback (`scope-orchestrator.md` → `## LLM-led Routing` → **3-Layer Safety**).
- Does the candidate agent declare a `compatibility` field?
  - **Yes** → does its runtime precondition hold for this sub-task? If not → halt delegation per `skills/glass-atrium-ops-orchestrator-role.md` → `#### Decision-phase probes` → Compatibility Probe.
  - **No `compatibility` field** → the agent passes through (backwards-compatible default).
