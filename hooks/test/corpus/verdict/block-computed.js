/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
impl-computed: glass-atrium-dev-node
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: the declared computed type has no data-literal presence anywhere, so
// the presence check that stands in for a spawn position finds nothing.
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — single implementation bundle');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement per the verified plan' });
