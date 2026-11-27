# Agent selection (orchestrator only)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### Capability-Based Agent Selection [ORCHESTRATOR]`, which states each duty and when it fires.

## Selection procedure

Each step consumes the previous step's output.

1. **Task Decomposition**: decompose the request into sub-tasks.
   - **Task Decomposition Questions**: Self-contained? · Boundary interface contract explicit? · Causal chain unsplit?
2. **Capability Consultation** (hints only, no forced match):
   - **`domains` array** (`~/.glass-atrium/agent-registry.json`): each agent's capability list, compared semantically against each sub-task.
   - **Agent description** (frontmatter): when needed, lazy-load the top 2-3 candidates' descriptions for precise judgment.
   - **Phase numbers**: `research(1) → analysis(2) → planning(3) → implementation(4) → review(5) → report/document(6)` — ordering only, never matching.
3. **Team Composition Decision**: sort the selected agents by phase number, ascending.
   - A DEV agent with `dual_phase: true` takes phase 2 or 4 from the decomposition result: diagnosis-only → 2, includes implementation → 4.
     - Term SoT: `~/.glass-atrium/agent-registry.json` → `dual_phase_definition` (the flag) · `phases` (the 1-6 map).
4. **Execution**: run in sorted order; independent tasks within the same phase MAY run in parallel (Fan-out).

## Ordering caveat (ultracode verify-gate)

- The phase sort permits spawning a `dual_phase` DEV assigned phase-2 analysis ahead of a phase-5 reviewer.
- Under ultracode a directly spawned pre-verify analysis DEV is truthfully a declared `impl:` spawn, and that — not spawn order alone — trips `block-order`: the gate working, not a false positive.
  - Verdict: `references/ultracode-declaration-contract.md` → Verdicts → `block-order`.
- Fix: either route of `skills/glass-atrium-ops-orchestrator.md` → ``### Pre-verify Discovery `dev-*` order guard (ultracode)``.
  - The plain reorder the `block-order` warning (`hooks/enforce-workflow-verify-stage.sh`) also offers rarely applies, because the analysis has to come first.
- Why `impl-computed:` is wrong here: it is the key for indirectly spawned types, so declaring this direct spawn under it is a false declaration, whether or not the gate accepts it.

## Compound Task Examples

Representative cases where a compound team return outperforms single matching.

| User Request | `agents` | `order` | `reason` (gist) |
|--------------|----------|---------|-----------------|
| "Write a planning doc and also propose a design direction" | `[glass-atrium-intel-planner, glass-atrium-design-designer]` | `[3, 2]` → sorted `[designer, planner]`, or `parallel` | planning doc → planner · design direction → designer; independent → parallelizable |
| "Find the cause of this login error and fix it" | `[glass-atrium-qa-debugger, glass-atrium-dev-react]` | `[2, 4]` sequential | debugger diagnoses → dev-react fixes the frontend login |
| "Research the latest RAG techniques and turn it into a report" | `[glass-atrium-intel-researcher, glass-atrium-intel-reporter]` | `[1, 6]` sequential | researcher investigates → reporter synthesizes; "report" makes it compound |
| "Write or revise an agent prompt / rule / skill file" | `[glass-atrium-meta-prompt-engineer, glass-atrium-intel-reporter]` | `[4, 6]` sequential | author → prompt-audit → independent structure verdict (scope-meta.md → Prompt Deliverable Team Rule) |

## Routing-Decision Record

- The routing safety layers are LLM self-judgment with no runtime trace, so a low-confidence mis-route cannot be detected after the fact.
- Record format:
  - `route: <selected agentType(s)> | confidence: <0.0-1.0> | rationale: <≤1 line, cite the matched domains/description>`
  - When confidence < 0.7, append the action taken: `halt+clarify` with the 2-3 candidates presented.
- **Honest backing**: no hook can force or verify a main-loop emission, so the record makes a route reviewable afterwards — it never makes routing "verified".

## Routing Verification (LLM-as-Judge)

- Is `agents[].domains` matched to the sub-task semantically, not by keyword?
- Does the `reason` field cite specific `domains` entries or description passages?
- Is confidence ≥ 0.7? If not → clarification fallback (`scope-orchestrator.md` → `## LLM-led Routing` → **3-Layer Safety**).
- Does a declared `compatibility` runtime precondition hold for this sub-task? If not → halt delegation per `skills/glass-atrium-ops-orchestrator-role.md` → `#### Decision-phase probes` → Compatibility Probe.
