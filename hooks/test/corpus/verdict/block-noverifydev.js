/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
// Synthesized verdict fixture: a reviewer-only verify clause fails the Stage-2 DEV hard-gate.
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — single implementation bundle');
await agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' });
await agent('glass-atrium-dev-nestjs', { goal: 'implement per the verified plan' });
