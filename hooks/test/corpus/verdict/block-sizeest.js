/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: everything else is in order and the entry signal is present, so the
// missing delegation-size self-attestation is the sole remaining cause.
log('plan-ref: clauded-docs/3634');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement per the verified plan' });
