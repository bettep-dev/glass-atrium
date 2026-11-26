# Third-Party Licenses — Dependency License Audit

Glass Atrium is licensed under the [MIT License](LICENSE). This document records the
license of every production dependency and its compatibility verdict against MIT
distribution (roadmap task T51). Audit date: 2026-11-26.

## Verdict

**0 incompatible licenses · 0 unknown licenses** across all installed production
dependencies (Node.js and Python). Recorded as `unverified` because no local source holds
them: the 9 unmet optional placeholders' licenses and the autoagent `js-yaml` version.

Two weak-copyleft dependencies are flagged and resolved as **compatible — not vendored**:

| Dependency | License | Why compatible |
|------------|---------|----------------|
| `psycopg` (Python) | LGPL-3.0-only | Runtime prerequisite installed by the end user via pip; never bundled into any distribution artifact. MIT source imports it through Python's standard import mechanism and the library remains user-replaceable, so LGPL copyleft does not propagate to this repository. |
| `psycopg2` (Python) | LGPL with exceptions | Same rationale as `psycopg`. |

**Standing obligation**: if a future distribution channel ever bundles these libraries
(frozen binary, tarball vendoring site-packages), LGPL conveyance terms apply to that
artifact and this verdict must be re-evaluated.

## Scope and Method

- **Manifests audited**: `monitor/package.json` (versions pinned by the tracked
  `monitor/package-lock.json`), `autoagent/package.json` (lockfile untracked — versions
  read from the installed tree; none is installed in the repository checkout), and
  Python third-party imports enumerated across every tracked `*.py` file plus the
  tracked root `requirements.txt` and the CI-only `requirements-dev.txt` (no
  `pyproject.toml` exists in the repo).
- **License sources**: installed `node_modules/*/package.json` `license` fields; bundled
  LICENSE texts where the field is absent; npm registry metadata (`npm view`) for unmet
  optional placeholders, where available offline; Python `importlib.metadata` for
  installed distributions.
- The tracked lock's 387 non-dev `packages` entries match the installed tree's paths,
  versions and `license` fields one-for-one.
- No tracked JavaScript outside `monitor/` and `autoagent/` imports third-party modules,
  so the two `package.json` files plus the Python import scan cover the full production
  surface.
- `devDependencies` are build-time tools, not part of the distributed runtime; they are
  recorded separately below for completeness.

## monitor — Direct Production Dependencies (14)

| Package | Version | License | MIT-compatible |
|---------|---------|---------|----------------|
| `@fastify/cookie` | 11.1.5 | MIT | yes |
| `@fastify/static` | 10.1.11 | MIT | yes |
| `@prisma/adapter-pg` | 7.8.0 | Apache-2.0 | yes |
| `@prisma/client` | 7.8.0 | Apache-2.0 | yes |
| `archiver` | 8.0.0 | MIT | yes |
| `dotenv` | 17.4.2 | BSD-2-Clause | yes |
| `fastify` | 5.12.8 | MIT | yes |
| `isomorphic-dompurify` | 3.12.0 | MIT | yes |
| `js-yaml` | 4.1.1 | MIT | yes |
| `mermaid` | 11.15.0 | MIT | yes |
| `node-html-parser` | 7.1.0 | MIT | yes |
| `pg` | 8.20.0 | MIT | yes |
| `playwright` | 1.65.0 | Apache-2.0 | yes |
| `zod` | 4.6.7 | MIT | yes |

## monitor — Full Production Dependency Tree

`npm ls --omit=dev --all` resolves **396 tree entries** = **387 installed packages**
+ 9 unmet optional placeholders (never installed, never distributed — listed below).
The 387 install paths hold 386 distinct `name@version` (`@prisma/get-platform@7.8.0`
is installed at two paths); the counts below are per distinct `name@version`.

| License | Count | Verdict |
|---------|-------|---------|
| MIT | 262 | permissive — compatible |
| ISC | 48 | permissive — compatible |
| Apache-2.0 | 37 | permissive — compatible |
| BSD-3-Clause | 13 | permissive — compatible |
| BSD-2-Clause | 10 | permissive — compatible |
| BlueOak-1.0.0 | 7 | permissive — compatible |
| Unlicense | 2 | public-domain equivalent — compatible |
| MIT-0 | 2 | permissive — compatible |
| MIT (license field absent, resolved from bundled LICENSE text) | 2 | permissive — compatible |
| CC0-1.0 | 1 | public-domain dedication — compatible |
| MPL-2.0 OR Apache-2.0 (dual) | 1 | Apache-2.0 elected — compatible |
| Python-2.0 | 1 | permissive — compatible |

Named entries outside the MIT/ISC/Apache-2.0 buckets:

- **BSD-3-Clause**: `d3-array@2.12.1`, `d3-ease@3.0.1`, `d3-path@1.0.9`,
  `d3-sankey@0.12.3`, `d3-shape@1.3.7`, `deepmerge-ts@7.1.5`, `fast-uri@3.1.9`,
  `ieee754@1.2.1`, `light-my-request@6.6.0`, `rw@1.3.3`, `secure-json-parse@4.1.0`,
  `source-map-js@1.2.1`, `tough-cookie@6.0.1`
- **BSD-2-Clause**: `css-select@5.2.2`, `css-what@6.2.2`, `domelementtype@2.3.0`,
  `domhandler@5.0.3`, `domutils@3.2.2`, `dotenv@17.4.2`, `entities@4.5.0`,
  `entities@8.0.0`, `nth-check@2.1.1`, `webidl-conversions@8.0.1`
- **BlueOak-1.0.0**: `@isaacs/nonrecursive-glob-match@1.1.0`, `glob@14.0.6`,
  `lru-cache@11.3.5`, `minimatch@10.2.5`, `minimatch@11.0.8`, `minipass@7.1.3`,
  `path-scurry@3.0.0`
- **Unlicense**: `postgres@3.4.7`, `robust-predicates@3.0.3`
- **MIT-0**: `@csstools/color-helpers@6.0.2`, `@csstools/css-syntax-patches-for-csstree@1.1.3`
- **CC0-1.0**: `mdn-data@2.27.1`
- **Dual-licensed**: `dompurify@3.4.2` (MPL-2.0 OR Apache-2.0) — **Apache-2.0 elected**
- **Python-2.0**: `argparse@2.0.1` (permissive PSF-style license)
- **License field absent in package.json, resolved from bundled LICENSE text (both MIT)**:
  `seq-queue@0.0.5` (MIT text, Netease/pomelo), `khroma@2.1.0` (MIT text)

Unmet **optional/peer-optional placeholders** — listed by `npm ls` but not installed and
not distributed; excluded from the verdict. License **unverified** for all 9: no installed
copy, the lock carries no entry, and the offline npm cache holds no registry metadata —
`magicast`, `@types/react-dom`, `better-sqlite3`, `canvas`, `@noble/hashes`,
`react-native-b4a`, `bare-buffer`, `bare-abort-controller`, `pg-native`.

## autoagent — Node.js Dependencies

| Package | Version | License | Kind | MIT-compatible |
|---------|---------|---------|------|----------------|
| `js-yaml` | unverified (declared `^4.1.0`; no installed tree) | MIT (read from `js-yaml@4.1.1` in the monitor tree) | direct | yes |
| `argparse` | unverified (no installed tree) | Python-2.0 (read from `argparse@2.0.1` in the monitor tree) | transitive (js-yaml) | yes |

## Python Runtime Dependencies (no manifest file)

The repository ships no Python package manifest — these are **install prerequisites**
the end user provides (system `python3` + pip). They are imported at runtime, never
vendored into the repository or any distribution artifact.

| Distribution | Audited version | License | Flag | Verdict |
|--------------|-----------------|---------|------|---------|
| `psycopg` (v3) | 3.3.4 | LGPL-3.0-only (`License-Expression` metadata) | weak copyleft | compatible — not vendored (see Verdict) |
| `psycopg2` (installed provider: `psycopg2-binary`) | 2.9.12 | LGPL with exceptions | weak copyleft | compatible — not vendored (see Verdict) |
| `PyYAML` | 6.0.3 | MIT | — | yes |

Import sites (tracked files):

- `psycopg` (v3) — 10 production files: `hooks/_pg_dual_write.py`,
  `hooks/_pg_learning_dualwrite.py`, `hooks/_pg_outcome_dualwrite.py`,
  `hooks/_pg_outcome_read.py`, `hooks/backfill-cost-events.py`,
  `hooks/cost-summary.py`, `hooks/learning-aggregator.py`,
  `scripts/_pg_archive_rotate.py`, `scripts/_pg_dual_write_daemon.py`,
  `scripts/autoagent-status-backfill.py` — plus 8 test files: 5 under
  `autoagent/test/` (`_pg_seal.py`, `test_aa_harness.py`,
  `test_corpus_audit_pg_sink.py`, `test_coverage_read_contract.py`, `test_pg_seal.py`),
  `hooks/test/lib/pg-sandbox-recorder/usercustomize.py`,
  `hooks/test/test_learning_pattern_discharge.py` and
  `scripts/test/test_pg_dual_write_trial_ledger.py`; each imports the real driver
  when installed, and several fall back to a stub when it is absent.
  `scripts/test/test_pg_dual_write_compose_apply_status.py` is deliberately NOT
  a site, though its name suggests otherwise: it writes its own `psycopg`
  stand-in package into a tmp dir and injects it via `PYTHONPATH`, so the real
  driver is never imported (recorded here so a later recount does not re-add it)
- `psycopg2` — 1 production file: `hooks/_pg-write.py`
- `yaml` (PyYAML) — 1 production file: `hooks/learning-aggregator.py`
- autoagent production Python (`autoagent/*.py`, `autoagent/lib/*.py`) imports only
  the standard library and repo-local modules.

All other imports across the tracked `*.py` files are Python standard library or
repo-local modules — with two exceptions, both outside the distributed runtime surface.
The first is **test-only**: `pytest` (MIT), imported by the `scripts/test` pytest suites
and pinned in the CI-only `requirements-dev.txt`, which the end-user bootstrap never
installs (its python-libs step targets the `GA_PYTHON_IMPORTS` set in `lib/ga-deps.sh`,
for which `requirements.txt` is the matching declaration set). The second is **build-time-only**:
`docs/assets/bulldog-braille-gen.py`
imports `Pillow` (PIL) to pre-render the TUI bulldog art. It is never bundled, installed, or
run at runtime — the launcher ships only its pre-generated `docs/assets/bulldog-braille.txt`
output and WHOLESALE-loads that text — so Pillow stays outside the distributed / runtime
third-party surface audited above (no runtime-dependency table or license-bucket entry). The
generator's build-time reference input `docs/assets/bulldog-reference.webp` is a byte-identical
copy (sha256 verified) of the already-tracked project-owned brand artwork
`docs/assets/banner.webp`, retained under the generator's expected input filename and excluded
from the runtime bundle.

## monitor — devDependencies (build-time only, not distributed)

| Package | Version | License |
|---------|---------|---------|
| `@mermaid-js/layout-elk` | 0.2.3 | MIT |
| `@types/archiver` | 7.0.0 | MIT |
| `@types/js-yaml` | 4.0.9 | MIT |
| `@types/node` | 24.12.2 | MIT |
| `@types/pg` | 8.20.0 | MIT |
| `esbuild` | 0.28.1 | MIT |
| `marked` | 16.4.2 | MIT |
| `prisma` | 7.8.0 | Apache-2.0 |
| `qrcode-generator` | 2.0.4 | MIT |
| `tsx` | 4.21.0 | MIT |
| `typescript` | 6.0.3 | Apache-2.0 |

Browser bundles vendored under `monitor/public/assets/vendor/` carry their own notices in
that directory's `THIRD-PARTY-NOTICES.md`.

Note: `prisma` (the CLI) also appears inside the production tree as a dependency of
`@prisma/client@7.8.0`; its subtree (including `mysql2`, `seq-queue`) is already counted
in the full-tree aggregate above.

## Out-of-Tree Runtime Artifacts

- `playwright`'s postinstall downloads a Chromium build onto the end user's machine at
  install time — fetched by the user, not distributed by this repository (Chromium:
  BSD-3-Clause plus its own bundled third-party licenses).
- Prisma engine binaries are likewise downloaded by the `prisma` tooling (Apache-2.0).

## Regeneration

```sh
# Node production tree license listing (from monitor/ or autoagent/)
npm ls --omit=dev --all --json   # tree membership
# license per package: node_modules/<pkg>/package.json "license" field
# (fall back to the bundled LICENSE text when the field is absent)

# Python third-party import enumeration (repo root)
git ls-files '*.py' | xargs grep -hE '^[[:space:]]*(import|from)[[:space:]]' \
  | awk '{print $2}' | cut -d. -f1 | sort -u
python3 -c "from importlib.metadata import metadata; m = metadata('psycopg'); \
print(m.get('Version'), m.get('License-Expression'))"
```
