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

Monitor typecheck + tests (Playwright chromium; run `oss-db-setup.sh` first,
see above). The suite refuses to run against the live database, so point
`MONITOR_TEST_DATABASE_URL` at a test-only one — create it once, migrate it,
then reuse it:

```sh
createdb -h /tmp glass_atrium_test
DATABASE_URL="postgresql://$(id -un)@localhost/glass_atrium_test?host=/tmp" \
  npm --prefix monitor exec prisma migrate deploy

npm --prefix monitor run typecheck
MONITOR_TEST_DATABASE_URL="postgresql://$(id -un)@localhost/glass_atrium_test?host=/tmp" \
  npm --prefix monitor test
```

The refusal compares the two connection strings by resolved identity, not by
text, so re-spelling the live URL (`127.0.0.1` for `localhost`, a different
socket path for the same socket, an extra query parameter) does not get past it.

Typecheck without a database is possible: `prisma generate` never connects,
but Prisma's config resolves `env()` eagerly, so export dummy `DATABASE_URL`
and `SHADOW_DATABASE_URL` values first (see the `gate-typecheck` job in
`.github/workflows/ci.yml` for the exact shape).

## Testing changes against a live install

The bats suites are hermetic, so a hook or script change can pass them all and
still misbehave on a real install. The updater has a seam for exercising your
own tree against one: it can take a local source directory instead of a
published release.

**This is not an install or deploy mechanism.** A normal `glass-atrium update`
downloads the latest GitHub Release bundle and verifies every changed file
against the published manifest (`scripts/update.sh`, `update_fetch_release`).
The two variables below make it skip the network entirely and use your tree
verbatim — which bypasses the whole release-integrity story. Use it to validate
your changes on your own machine before merge. Never use it to install Glass
Atrium, and never use it to ship.

Both variables must be set; either alone is ignored:

- `ATRIUM_UPDATE_SRC_DIR` — the source tree to apply.
- `ATRIUM_UPDATE_SRC_MANIFEST` — the manifest to verify it against.

Regenerate the manifest first. The seam copies your manifest in verbatim, so a
stale one propagates: staging re-hashes each changed file and compares it to
`hashes[path]`, then aborts with `hash mismatch staging <path>` and leaves the
install untouched.

```sh
# the checkout (or git worktree) holding your change
SRC=~/src/glass-atrium
cd "$SRC" && ./scripts/generate-manifest.sh

ATRIUM_UPDATE_SRC_DIR="$SRC" \
ATRIUM_UPDATE_SRC_MANIFEST="$SRC/manifest.json" \
  glass-atrium update
```

The apply runs to completion with no prompt in front of it, so there is no step
between running that command and your install changing. Read the diff you are
about to deploy from git, and re-read `ATRIUM_UPDATE_SRC_DIR` before you press
return.

Then check that it worked:

- **Exit code.** 0 means applied. The named exit codes in the
  `scripts/update.sh` header identify which step failed
  and what to re-run — several of them mean the files landed but a post-apply
  step did not.
- **`glass-atrium doctor`**, via the *live* launcher on your `PATH`. Do not run
  the checkout's `./glass-atrium doctor`: the launcher anchors `GA_ROOT` to its
  own resolved location, so the repo copy inspects the repo tree and reports the
  manifest entries it checks as `FAIL : manifest entry mis-linked` — the
  symlinks under `~/.claude` point at the install, not at your checkout. That is
  an artifact of which launcher you ran, not a finding.

Two effects of an apply that are easy to miss:

- **Your harness config can be rewritten.** A post-apply step reconciles the
  hook bindings by running `glass-atrium wire-hooks`, which edits
  `~/.claude/settings.json`. It merges rather than replaces (bindings outside the
  Atrium hooks directories are preserved) and backs the file up once, immediately
  before its first write, to `settings.json.ga-backup.<YYYYmmdd-HHMMSS>`. A run
  with nothing to wire writes nothing and takes no backup.
- **Agent files do not simply overwrite.** Files under `agents/` are excluded
  from the deterministic file sync and go through the editable-region three-way
  merge in `autoagent/lib/editable_merge.py`, which keeps locally-evolved regions
  (see *A note on `agents/*.md`* below). So an agent-file change may correctly
  report `resolves with no net change (regions kept local) — no write` instead of
  landing, and a region-count mismatch or a merge conflict is reported and
  skipped rather than applied.

### Repairing a conflict-declined agent body

A `CONFLICT (merge-conflict)` decline is the tripwire working, not a fault: the
merged candidate carried literal conflict markers and a marker-bearing body is
corruption, so the local copy is kept and nothing is written. The decline is
recorded, one line per declined file, in `update-declines/conflict-declines.log`
beside the `agents-bak` rollback store — read it when a deploy transcript has
already scrolled past.

`agent_lifecycle` is not the repair route. Its six subcommands (`add`, `extend`,
`delete`, `orphan-scan`, `sync-inject`, `sync-gate-roster`) express no in-region
reconcile, and `extend` is additive-only — it halts on exactly the value mutation
a conflicted region requires. The pair below is the repair that works:

1. **Capture a pre-change image of both the live body and its base-store entry.**
   Required, not optional: steps 2 and 3 are hand edits to two files that must
   agree, and without the images the result can be neither verified nor reversed.
2. **Edit the live body** under `agents/` to resolve the conflicted region by
   hand, taking the vendor lines the release brought.
3. **Sync the base store** entry (`<state>/base-agents/<name>.md`) to the release
   body the conflict was reported against, so the next same-release run diffs
   against the anchor you actually resolved to rather than the stale one.
4. **Replay the resolver against the captured images.** The verdict transitions
   from `merge-conflict` to a no-op, and that transition is what proves closure —
   a green suite afterwards does not, since it cannot distinguish a resolved
   region from an untouched one.

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
