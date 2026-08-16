/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: the declared implementation type has no spawn-position token — a
// phantom role, the one facet of the declaration that is falsifiable against the code.
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — single implementation bundle');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
