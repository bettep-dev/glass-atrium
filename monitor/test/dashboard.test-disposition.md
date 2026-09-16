# Dashboard test baseline and disposition

Baseline taken on `feature/mon-dashboard` at its cut from `feature/pa-epic` (9dc4628), before any
deletion. Plan: clauded-docs/39728, work stream 1; work stream 6 executes the dispositions below.

Runner for every row (both variables exported, see the plan's worktree contract):
`npx tsx --import ./test/lib/select-test-db.ts --test test/<file>`.

## Baseline — 11 files, 109 tests, 0 failing

| File | Subject | Tests | Disposition |
|---|---|---|---|
| `app.nav-badge.client.unit.test.ts` | `app.jsx` nav slot merge + ALL SYSTEMS footer | 13 | stays — extend for the stream-2 harness fold; never re-add drift cases |
| `dashboard-cost.kpi-membership-gate.route.test.ts` | `/api/dashboard/kpi` + `/api/cost/kpi` registry gate | 2 | stays unchanged — server-side, and tiles 3-4 keep both endpoints |
| `dashboard.client.unit.test.ts` | `deriveUpdateView` — the `UpdateBadge` state machine | 18 | stays green as written — it is the guard that stream 4 re-hosts `UpdateBadge` rather than rewriting it |
| `dashboard.cost-timeseries-tz.unit.test.ts` | `computeBucketTzToday` bounding `/api/dashboard/cost-timeseries` | 5 | stays in place, ownership moves to Cost & usage — the screen drops the trend fetch, the route does not change; any rename is out of this plan |
| `dashboard.daemon-status.test.ts` | `buildDaemonStatusItems` missing/stale synthesis | 4 | stays — the shell fold consumes this board |
| `dashboard.dwc-closure.client.unit.test.ts` | `getOpenCount` · `computeOutcomeHint` · `computeWorstRollup` | 10 | re-homes — the open-DWC and threshold cases follow the outcome-rate classifier to its shared export (stream 2); the `computeWorstRollup` cases retire with the worst-severity badge |
| `dashboard.route.test.ts` | `/api/dashboard/kpi` integration | 7 | stays unchanged |
| `dashboard.synthesized-exclusion.client.unit.test.ts` | `getWriterTotal` · `getWriterOpenCount` · hint · rollup | 9 | re-homes — writer-population cases follow the shared classifier; the `computeWorstRollup` facet retires with the badge |
| `dashboard.update-status.unit.test.ts` | update-availability resolver + its route | 25 | stays unchanged — server-side |
| `dashboard.update.route.test.ts` | `POST /api/dashboard/update` + update-job | 12 | stays unchanged — stream 4 must not reopen the apply flow |
| `ui.badge-registry.unit.test.ts` | `resolveBadge` tone/override/fallback in `ui.jsx` | 4 | stays — stream 2 adds to `ui.jsx` without changing the registry contract |

## Standing rules for stream 6

- Nothing in the table retires as a whole file; only the named `computeWorstRollup` cases retire, together with the badge they pin.
- A re-homed assertion is moved with its relationship intact — it is rewritten against the shared classifier's export, never duplicated on both sides.
- The two client sandbox suites run the screen SOURCE through `test/client-sandbox.ts` (esbuild, `bundle: false`, node:vm), so no `npm run build:jsx` is needed for them.
- That harness stubs `window.UI.*` and mirrors `LOW_N_MIN`. Moving the outcome-rate classifier or the low-n gate into a shared export (stream 2) means adding it to the stub in the same change, or every sandbox suite fails at module-top evaluation.
