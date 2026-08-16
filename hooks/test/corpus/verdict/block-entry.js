/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: a well-formed declaration and a real verify pair, but neither a
// plan reference nor a simple-task classification, so the work never entered the document flow.
log('[SIZE-EST] bundles=1 tool_uses~=10 — single implementation bundle');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement per the verified plan' });
