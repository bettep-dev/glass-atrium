# Contributing to Glass Atrium

Thanks for contributing. This document covers local setup, the test suites,
and the commit/PR contract. Keep changes small and focused — one concern per PR.

## Language policy

**All contributions must be in English**: code comments, commit messages, PR
titles and bodies, and documentation. Some internal rule files predate this
policy and reference Korean comment defaults for the maintainer's own agent
tooling (`scoped/shared-comment-logging.md`); for anything contributed to this
repository, English wins.

## Development setup

macOS is the primary platform (the installer and launchd integration target
it). Linux works for most of the bats suites — CI runs them on `ubuntu-latest`
with the same hermetic sandboxes.

Shell/test tooling:

```sh
brew install bats-core jq shellcheck
```

The monitor additionally needs:

- **Node 24** (pinned in `monitor/.nvmrc`)
- **A local PostgreSQL (14+)** with peer authentication, listening on the
  `/tmp` Unix socket (the `host=/tmp` contract baked into
  `monitor/.env.example`). No passwords — peer auth only.

Bootstrap the monitor in one step (runs `npm ci`, renders `monitor/.env`,
creates the main + shadow databases, runs `prisma generate` and
`prisma migrate deploy`; idempotent):

```sh
cd monitor && bash scripts/oss-db-setup.sh
```

## Running the test suites

Bats suites (hermetic — they stub `psql`/`launchctl`/`claude` etc., so they
need neither Postgres nor launchd):

```sh
bats test/            # installer + release-gate suites
bats hooks/test/      # hook suites
bats scripts/test/    # operational-script suites
```

AutoAgent Python suites (pure stdlib, no third-party deps):

```sh
python3 -m unittest discover -s autoagent/test -p 'test_*.py' -v
```

Monitor typecheck + tests (live DB + Playwright chromium; run
`oss-db-setup.sh` first, see above):

```sh
npm --prefix monitor run typecheck
npm --prefix monitor test
```

Typecheck without a database is possible: `prisma generate` never connects,
but Prisma's config resolves `env()` eagerly, so export dummy `DATABASE_URL`
and `SHADOW_DATABASE_URL` values first (see the `gate-typecheck` job in
`.github/workflows/ci.yml` for the exact shape).

## Before you push

- `./scripts/generate-manifest.sh` — regenerate `manifest.json` if you touched
  any bundled file (agents/, autoagent/, rules/, scripts/, skills/, hooks/,
  scoped/, monitor/ …). The manifest is CI-gated: a stale one fails the
  `glass-atrium doctor` integrity check.
- `scripts/pii-scan.sh --worktree-only` — must pass.
- `shellcheck` any shell files you touched.
- Run the bats suites covering the directories you changed.

## Commits, branches, and PRs

The source of truth is `rules/glass-atrium/core-git-workflow.md`. The short
version:

- **Subject format**: `- [x] <English imperative description>`
  (e.g. `- [x] Fix manifest check on empty worktree`).
- **Body**: optional; when present, separated from the subject by a blank
  line, explaining *why* rather than restating the diff.
- **Never** use `--no-verify` or `--no-gpg-sign`.
- **Branch naming**: `feature/<feature-name>` for features,
  `fix/<issue-name>` for bugs. No direct pushes to `main` — everything goes
  through a PR.
- **PR contract**: title under 70 characters; body includes a **Summary** and
  a **Test Plan** section.

## A note on `agents/*.md`

The agent instruction files under `agents/` are partly machine-evolved: a
background self-improvement loop patches them from accumulated outcome
records. PRs touching these files are welcome, but please explain the intent
in the PR body so the maintainer can reconcile your change with the live
evolution stream.
