// Synthesized verdict fixture: a reporter spawn whose deliverable Target is a hardcoded local path
// with no routing instruction anywhere. The doc-routing pass runs before any DEV consideration.
await agent('glass-atrium-intel-reporter', {
  goal: 'write the findings report',
  target: 'Target file: ~/reports/findings.md',
});
