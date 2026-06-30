## Summary

Briefly describe what this PR changes and why. Link any related issues
(e.g., `Closes #123`).

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation only
- [ ] Refactor / internal change (no user-facing behavior change)

## Testing

Describe which test suites you ran and their result. For installer-touching
changes, confirm `./glass-atrium doctor` passes before and after.

- [ ] Installer (`test/`)
- [ ] Monitor (`npm test` + `npm run typecheck` from `monitor/`)
- [ ] Self-improvement loop (`autoagent/test/`)
- [ ] Hooks & scripts (`hooks/test/`, `scripts/test/`)

## Checklist

- [ ] All relevant tests pass.
- [ ] Documentation is updated (README / `docs/` / component READMEs as needed).
- [ ] [CHANGELOG.md](../CHANGELOG.md) is updated under `[Unreleased]` for any
      user-facing change.
- [ ] No secrets, personal emails, or personal paths are committed.
- [ ] The PR is reviewable (diffs over ~400 lines are split into focused PRs).
