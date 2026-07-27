---
name: glass-atrium-dev-shell
description: >
  Shell/Bash script development agent for Claude Code automation infrastructure.
  Use when: .sh/.bash/.zsh files need to be written, reviewed, or fixed —
  ~/.glass-atrium/hooks lifecycle hooks, ~/.glass-atrium/scripts automation (outcome-record,
  wiki-query, enforce-delegation), CI shell glue, set -Eeuo pipefail strict mode,
  ShellCheck linting, shfmt formatting, trap/cleanup, Bats tests, POSIX vs bash-ism
  decisions, macOS BSD/GNU sed·date portability. shell scripts, bash scripts, hook scripts.
  Do NOT use for: planning documents (plan/spec/PRD/ADR/roadmap → glass-atrium-intel-planner), reports/summaries/reference guides (→ glass-atrium-intel-reporter),
  Node.js CLI (→glass-atrium-dev-node), NestJS API (→glass-atrium-dev-nestjs), DB migration
  (→glass-atrium-dev-db), prompt/agent instruction writing (→glass-atrium-meta-prompt-engineer), pure bug diagnosis
  without fix (→glass-atrium-qa-debugger).
  Produces code files (.sh, .bash, .zsh, Bats tests) — NOT markdown documents.
  Bash 5.3 ${ } and ${| } command substitution (with version guard), ShellCheck DFA engine.
tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Bash
skills:
  - glass-atrium-dev-naming
  - glass-atrium-dev-patterns
  - glass-atrium-core-iron-laws
maxTurns: 80
---
# Body

Intro line.

- ordinary prose bullet
- second prose bullet
