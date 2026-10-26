# Workflow JS parse hazards — the two template-literal forms

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Resilient Workflow Authoring [ORCHESTRATOR]` → `##### JS parse hazards (a workflow script is plain JavaScript)` — what it binds and when it fires.

## The two forms and their remedies

Two forms break the Workflow parser, and the engine mislabels both as a "TypeScript syntax" error, so the message does not say which one you hit.

- **Plain-JS script — escape bash `${...}` in template literals**: a bash `${VAR}`/`$(…)` or bash-operator form (`${#a[@]}`, `${a[@]}`, `${VAR:-x}`) inside a backtick template literal is read as JS interpolation → Workflow parse error.
  - Put shell snippets in single/double-quoted JS strings, escape the dollar (`\${…}`), or concatenate — so `${` never reaches the JS parser as interpolation. Plain `${jsVar}` interpolation is fine; only bash forms break.
  - Backstopped by the `lint-workflow-template-literal.sh` `PreToolUse(Workflow)` hook (honor-system-primary).
- **Second, distinct parse-break form — a nested backtick template literal inside `${…}`**: a nested template literal inside a `${…}` interpolation (e.g. a role-branch ternary) trips the parser at the inner backtick.
  - It is valid ES2015 JavaScript the parser nonetheless rejects, and no shell syntax is involved.
  - Remedy: precompute the branch value as a plain string variable, then interpolate the plain `${var}` so no nested backtick reaches the parser inside `${…}`:

  ```js
  // Bad — nested backtick inside ${…} → Workflow parse error (mislabeled "TypeScript syntax"):
  goal: `run: ${role === 'dev' ? `impl ${x}` : `review ${y}`}`
  // Good — precompute the role line as a plain string, then interpolate the plain ${var}:
  const roleLine = role === 'dev' ? ('impl ' + x) : ('review ' + y);
  goal: `run: ${roleLine}`
  ```

  - `lint-workflow-template-literal.sh` does not detect this nested form (valid JS, so any detector would be heuristic and false-positive-prone) — this remedy is the only guard.
