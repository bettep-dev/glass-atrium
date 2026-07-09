/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
// In-script Stage-2 verify-team form corpus variant: a real {qa-code-reviewer, dev-nestjs}
// verify pair gates a same-type dev-nestjs implementation (greedy-earliest dual-role binding).
log('plan-ref: clauded-docs/7 — verified implementation plan');
log('[SIZE-EST] bundles=2 tool_uses~=25 — implement + its new tests');
await agent('glass-atrium-intel-planner', { goal: 'author the implementation plan' });
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement per the verified plan' });
