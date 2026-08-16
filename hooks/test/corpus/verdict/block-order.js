/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: the implementation spawn textually precedes every reviewer spawn, so
// the implementation is not gated by the verify stage.
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — single implementation bundle');
await agent('glass-atrium-dev-shell', { goal: 'implement before anyone verified anything' });
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
