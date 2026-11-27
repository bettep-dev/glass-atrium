# Workflow JS parse hazards — the two template-literal forms

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Resilient Workflow Authoring [ORCHESTRATOR]` → `##### JS parse hazards (a workflow script is plain JavaScript)` — what it binds and when it fires.

## The two forms and their remedies

- The engine mislabels both forms as a "TypeScript syntax" error, so the message does not say which one you hit.
- **Plain-JS script — escape bash `${...}` in template literals**: a bash `${VAR}`/`$(…)` or bash-operator form (`${#a[@]}`, `${a[@]}`, `${VAR:-x}`) inside a backtick template literal is read as JS interpolation → Workflow parse error.
  - Put shell snippets in single/double-quoted JS strings, escape the dollar (`\${…}`), or concatenate.
  - Plain `${jsVar}` interpolation is fine; only bash forms break.
  - Backstopped by the `lint-workflow-template-literal.sh` `PreToolUse(Workflow)` hook for the operator forms only; the remedy is the primary guard.
- **Second, distinct parse-break form — a nested backtick template literal inside `${…}`**: it trips the parser at the inner backtick (e.g. a role-branch ternary).
  - It is valid ES2015 JavaScript the parser nonetheless rejects.
  - Remedy: precompute the branch value as a plain string variable, then interpolate it:

  ```js
  // Bad — nested backtick inside ${…}:
  goal: `run: ${role === 'dev' ? `impl ${x}` : `review ${y}`}`
  // Good — precomputed plain string:
  const roleLine = role === 'dev' ? ('impl ' + x) : ('review ' + y);
  goal: `run: ${roleLine}`
  ```

  - `lint-workflow-template-literal.sh` does not detect this nested form — this remedy is the only guard.
