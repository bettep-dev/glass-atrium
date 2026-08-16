/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
sizing: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: an unknown key inside a well-formed sentinel pair is a decidable
// author error, so the gate blocks rather than fails open.
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — single implementation bundle');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement per the verified plan' });
