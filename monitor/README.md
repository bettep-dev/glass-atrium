# claude-monitor — Atrium Monitor

## Overview

Real-time monitoring dashboard for the Claude Code agent system. A single-process
app: Fastify 5 backend + React 18 UMD frontend (esbuild precompile, no bundler) on
top of the PostgreSQL `glass_atrium` DB single sink. It tracks cost/tokens, agent
activity, Outcome Records, the learning/self-improvement loop, system health, the
wiki knowledge store, managed Claude documents, and the system architecture
diagrams in one place.

## Screens (10)

The `NAV` registry in `public/src/app.jsx` is the single SoT — `id` is the hash
routing key, `label` the displayed (English UI) name.

| # | id | Label | Data source |
|---|------|------|------------|
| 01 | `dashboard` | Dashboard | `core.outcomes`, `core.cost_events`, `core.agent_events` aggregates |
| 02 | `cost` | Cost & usage | `core.cost_events` (per-model, per-agent breakdown) |
| 03 | `model-config` | Models & budgets | `monitor.model_config` (per-domain model assignments + per-call USD budget caps, `/api/model-config` GET/PUT) |
| 04 | `agents` | Agents | `core.agent_events`, `agent-registry.json` join |
| 05 | `outcomes` | Task results | `core.outcomes` (result/metric_pass/confidence) + markdown body explorer |
| 06 | `improvement` | Learning | `core.learning_log`, `core.correction_signals`, `core.autoagent_*` consolidated join (`/api/improvement`) |
| 07 | `health` | System health | `monitor.*` + per-component health probes (`/api/health-detail`) |
| 08 | `wiki` | Wiki | `wiki.notes`, `wiki.dirty_flag`, `core.daemon_runs`, `core.daemon_run_payload` (read-only, `/api/wiki`) |
| 09 | `architecture` | System map | `src/server/architecture/diagrams-source.ts` (Mermaid SoT) + flow-extractor + live overlay |
| 10 | `clauded-docs` | Documents | `monitor.documents` (clauded-docs CRUD + doc_status + groups + 4-format viewer) |

> Learning + self-improvement are consolidated into the single `improvement`
> screen. The former alerts screen was removed along with the alert subsystem.

## Tech Stack

### Backend

- **Runtime**: Node.js 24 LTS (`.nvmrc` = `24`, `engines.node` = `>=24.0.0 <25.0.0`)
- **Web framework**: Fastify `^5.8.5` (`@fastify/static` `^9.1.3` for SPA static serving)
- **ORM**: Prisma `^7.8.0` (driver-adapter mode — `@prisma/adapter-pg` `^7.8.0` + `pg` `^8.20.0`)
- **Logger**: Fastify built-in Pino (transport configured in `logger.ts`)
- **PDF/sanitize dependencies**: `playwright` (headless PDF export) · `isomorphic-dompurify` (HTML sanitize) · `node-html-parser` (structure validation) · `js-yaml` (architecture YAML parsing)
- **Dev**: `tsx watch` (HMR) / production: `tsc` build, then `node dist/server/main.js`

### Database

- **PostgreSQL 14+** — migrations use PG 14 features only; the operating SoT is PG 14.19 (see Migration Notes below)
- **Authentication**: Unix-socket peer auth — `listen_addresses=''` (TCP disabled by policy)
- **Schema split**: `core` (operational data) · `wiki` (knowledge base + FTS) · `monitor` (monitoring metadata) — **21 models** total (`prisma/schema.prisma` `model` declarations: core 15 · monitor 4 · wiki 2)

#### Migration Notes (PostgreSQL version)

- **Actual running version**: PostgreSQL **14.19** (Homebrew install) — "PostgreSQL 14" in this README is the SoT
- **Migration set**: a squashed OSS baseline migration followed by incremental
  migrations (see `prisma/migrations/`) — the directory, not a hardcoded count,
  is the SoT
- **Never edit applied migrations**: Prisma migration-immutability contract —
  changing the SQL/comments of an applied migration causes a checksum mismatch,
  `prisma migrate status` drift detection, and `prisma migrate deploy` failure on
  new environments
- **Authoring rule for new migrations**: do NOT state the runtime PG version in
  migration comments. Record only the **minimum PG version** the SQL feature
  requires (e.g., "PostgreSQL 9.6+ for `ALTER TYPE ADD VALUE IF NOT EXISTS`").
  The runtime version's single authority is this README

### Frontend (no bundler · esbuild precompile)

- **React 18.3.1 UMD** (`react` / `react-dom` UMD CDN)
- **JSX transpile**: `npm run build:jsx` pre-compiles `public/src/*.jsx` with **esbuild** to IIFE-format (`--format=iife`, `--jsx=transform`) `public/dist/*.js`. In-browser Babel-standalone transpilation is retired (see the `public/index.html` comment)
- **Load-order dependency**: `tweaks-panel → ui → screens/* → app` (window-globals) — guaranteed by the `<script src="dist/...">` order in `index.html`
- **Tailwind CDN (JIT)** + in-house token CSS (`public/styles/tokens.css`, `base.css`) — the clauded-docs viewer depends on runtime className scanning, so do NOT replace this with a PostCSS build
- **Charts**: Recharts 2.15.4 UMD (with the `prop-types` UMD peer dep)
- **Architecture diagrams**: Mermaid 11 CDN (`mermaid.render()` to SVG, `startOnLoad:false`) + svg-pan-zoom 3.6.2 (wheel zoom + drag pan)
- **Document-viewer extras**: highlight.js 11 (agent-only YAML/JSON syntax highlight) · marked 13 (Outcome markdown parser) · DOMPurify 3 (sanitizer)
- **Fonts**: Pretendard + JetBrains Mono CDN

## Directory Layout

```
monitor/
├── prisma/                     # PostgreSQL schema + migrations
│   ├── schema.prisma           # 3 schemas (core/wiki/monitor), 21 models
│   └── migrations/             # squashed OSS baseline + incremental migrations
├── src/server/                 # Fastify backend
│   ├── main.ts                 # entry point (port via ATRIUM_MONITOR_PORT, default 16145, 127.0.0.1)
│   ├── db.ts                   # Prisma client + driver adapter
│   ├── logger.ts               # Pino config
│   ├── routes/                 # API routes
│   │   ├── index.ts            # route barrel — registerRoutes (12 registrations)
│   │   ├── health.ts / health-detail.ts
│   │   ├── dashboard.ts
│   │   ├── architecture.ts     # architecture screen (Mermaid source delivery)
│   │   ├── cost.ts
│   │   ├── agents.ts
│   │   ├── outcomes.ts
│   │   ├── wiki.ts             # wiki screen (read-only PG sources)
│   │   ├── clauded-docs.ts     # managed-docs CRUD + doc_status + groups
│   │   ├── telemetry.ts        # skill/agent activation telemetry INSERT
│   │   └── improvement.ts      # learning + self-improvement single join view
│   ├── clauded-docs/           # document body storage + pre-emit validation
│   │   ├── html-validator.ts   # multi-stage pre-emit gate
│   │   ├── d8-thresholds.json  # numeric thresholds single SoT
│   │   ├── sanitize.ts         # DOMPurify HTML sanitize
│   │   ├── storage.ts          # HTML primary FS storage
│   │   ├── pdf-export.ts       # Playwright headless PDF
│   │   └── search-sql.ts / indexable-text.ts
│   ├── architecture/           # architecture screen backend
│   │   ├── diagrams-source.ts  # Mermaid diagram SoT
│   │   ├── parser.ts           # SystemFlowGraph parser
│   │   ├── flow-extractor.ts
│   │   └── live-overlay.ts
│   ├── agents/                 # agent-registry join helpers
│   ├── middleware/             # Fastify middleware
│   └── types/                  # per-screen response types
└── public/                     # frontend (no bundler)
    ├── index.html              # CDN script tags + dist/* load order
    ├── dist/                   # esbuild output (build:jsx) — *.js IIFE
    ├── styles/                 # tokens.css + base.css
    └── src/
        ├── app.jsx             # NAV registry + screen dispatcher
        ├── ui.jsx              # shared UI helpers
        ├── tweaks-panel.jsx    # theme/density tweaks panel
        ├── data/               # pricing.js (TOKEN_RATES static catalog)
        └── screens/            # 10 screens (dashboard/cost/model-config/agents/outcomes/improvement/health/wiki/architecture/clauded-docs)
```

## Running

### Prerequisites

1. Node.js 24 (`nvm use` picks up `.nvmrc` automatically)
2. A running PostgreSQL **14+** instance with Unix-socket peer auth (current OS
   user = DB superuser) — the `glass_atrium` DB is created by the fresh-install step
   below

> The Glass Atrium installer (`glass-atrium`) bootstraps the database
> automatically on a fresh machine by delegating to `scripts/oss-db-setup.sh`
> (it skips the step when the `glass_atrium` DB already exists). The procedures below
> are the monitor-local equivalents for running them by hand — see
> `docs/INSTALL.md` at the repo root for the full walkthrough.

### Fresh install (OSS · unattended/non-interactive)

The canonical clean-environment path. Uses `prisma migrate deploy` (NOT
`migrate dev`): deploy is non-interactive and needs no shadow DB, whereas
`db:migrate` (= `prisma migrate dev`) requires a shadow DB plus interactive
prompts — unsuitable for fresh installs. The setup script still pre-creates
the shadow DB so `db:migrate` works later without a manual `CREATE DATABASE`.

**Scripted (recommended)** — idempotent + loud-fail, run from the monitor root:

```bash
bash scripts/oss-db-setup.sh    # createdb (main+shadow) → render .env → npm ci → generate → migrate deploy
```

**Manual steps (equivalent to the script)**:

```bash
createdb -h /tmp glass_atrium         # create the glass_atrium DB (Unix-socket peer auth) — first time only
createdb -h /tmp glass_atrium_shadow  # prisma migrate dev shadow DB — first time only
cp .env.example .env            # then render the placeholders by hand (user-qualified URLs + HOME path, see below)
npm ci                          # lockfile-pinned install
npm run db:generate             # Prisma client
npm run db:deploy               # apply migrations (prisma migrate deploy — non-interactive)
```

> **No seed required**: the empty schema is functional by itself (0 required
> seed rows). Do not look for a seed step — an unconfigured `prisma db seed`
> is normal.

### Dev server

```bash
npm run dev                     # tsx watch — http://127.0.0.1:16145
```

> Use `npm run db:migrate` (`prisma migrate dev`) only for local schema changes
> during development — that path requires `SHADOW_DATABASE_URL` (see
> `.env.example`). Fresh installs use the `db:deploy` path above.

### Production build

```bash
npm run build                   # tsc + build:assets (json copy) + build:client (esbuild jsx)
npm start                       # node dist/server/main.js
```

### Prisma tooling

```bash
npm run db:status               # migration status
npm run db:studio               # Prisma Studio (GUI)
npm run typecheck               # tsc --noEmit
```

## Environment Variables (`.env`)

| Variable | Required | Description |
|------|------|------|
| `DATABASE_URL` | required | PostgreSQL Unix-socket URI, user-qualified peer-auth form: `postgresql://<os-user>@localhost/glass_atrium?host=/tmp`. The user segment must be present — with an empty user, Prisma's schema engine connects as a built-in default user (not the OS peer user) and `migrate deploy` fails with `P1010`. `oss-db-setup.sh` renders this form automatically |
| `SHADOW_DATABASE_URL` | required only for `db:migrate` | `prisma migrate dev` shadow DB · avoids false drift on the raw-SQL tsvector GENERATED columns + GIN/trgm indexes · a separate DB on the same PG instance (`postgresql://<os-user>@localhost/glass_atrium_shadow?host=/tmp`, created idempotently by `oss-db-setup.sh` — manual one-time: `CREATE DATABASE glass_atrium_shadow OWNER <os-user>`) |
| `ATRIUM_MONITOR_PORT` | optional | listen port (default `16145`) — rendered from `config.toml` `[ports].monitor` by `scripts/render-monitor-env.sh` |
| `CLAUDED_DOCS_HTML_ROOT` | optional | HTML-primary FS root override for new POST/PUT documents · absolute path or `~/`-prefixed · unset default = `~/.claude/monitor/data/documents/` (monitor-internal) |
| `CLAUDED_DOCS_MD_ROOT` | optional | MD companion / legacy `.md` scan root (**read-only** — new rows never write here) · unset = disabled (no legacy MD scan) · set only on environments that still have legacy `.md` artifacts |
| `CLAUDED_DOCS_ROOT` | optional (deprecated alias) | legacy alias resolved to `CLAUDED_DOCS_MD_ROOT` · logs one deprecation warning per process · new environments use `CLAUDED_DOCS_MD_ROOT` |

See `.env.example` for placeholder details.

> **HTML_ROOT vs MD_ROOT** — new documents (`POST`/`PUT /api/clauded-docs`) are
> written only under `CLAUDED_DOCS_HTML_ROOT` (default
> `~/.claude/monitor/data/documents/`). That path is monitor-internal and
> independent of any external note-app path. `CLAUDED_DOCS_MD_ROOT` exists only
> for read-only scanning of residual legacy `.md` artifacts and legacy-row
> `md_copy_path` validation; leave it unset unless you need legacy MD exposure.

## Managed-Document (clauded-docs) Emit Pipeline

HTML-primary document bodies must pass the multi-stage
`validateHtmlStructure` gate (`src/server/clauded-docs/html-validator.ts`)
before `POST /api/clauded-docs` ingestion. Stages run in order; the first
failure returns a single error code.

| Stage | code | Checks |
|------|------|----------|
| 1 structure | `html_structure_invalid` | doctype · charset · html root · body · head title · semantic landmark · heading — 7-field structure |
| 2 residue | `placeholder_residue` | unsubstituted `{{…}}` placeholders |
| 3 comparison tables | `d8_p2_violation` | column cap exceeded on `<th>`-bearing comparison tables |
| 4 style | `d8_style_violation` | inline-color-literal + light-default-body style lint |

- **Numeric thresholds single SoT**: `src/server/clauded-docs/d8-thresholds.json`
  (`comparisonTable.maxColumns` · `contrast.textMinRatio`/`uiMinRatio` ·
  `typography.maxLevels`) — loaded once at module init via `JSON.parse`; never
  hardcode thresholds in prose
- **Build copy**: `npm run build:assets` copies `d8-thresholds.json` to
  `dist/server/clauded-docs/` so the `import.meta.url`-based resolve works in
  both dev and prod
- After the gate passes, `storage.ts` stores the single HTML-primary file and
  INSERTs the `monitor.documents` row (`md_copy_path` = NULL)

## Data Integrity Policy (PG-only Single Sink)

- Every outcome record / cost event / agent event / learning-log entry / wiki
  dirty flag converges on the single PostgreSQL `core.*` sink
- Legacy file sinks (e.g., the transcript-based cost-tracker.sh approach) are retired
- Ingestion pipelines INSERT into PG directly from outside this package
  (`~/.glass-atrium/hooks`, `~/.glass-atrium/scripts`)

## Security

- **Never commit `.env`** — `.gitignore` registers `.env`, `.env.*` (with `.env.example` allowed)
- **PG auth** = local Unix-socket peer auth, no TCP (`listen_addresses=''`)
- **LLM-generated SQL/shell** → human review required (OWASP LLM05 Improper Output Handling)
- **API keys / tokens** → injected via `.env` env vars only; never exposed in code/logs/git (OWASP LLM02, LLM07)

## Contributing / Commit Conventions

- Conventional Commits — `type(scope): summary`
- Korean commit messages are accepted (project history is Korean-first)
- Never commit `.env` or secret material — the secret scanner must pass before push
- No direct pushes to main — every change merges through an MR/PR

## License

[MIT](../LICENSE) — see the repository root.
