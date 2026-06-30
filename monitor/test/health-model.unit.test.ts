// Unit tests for public/src/data/health-model.js (F02) — the health KPI
// denominator must equal the rendered (ready) card count, with the invariant
// okCount + degradedCount + infoCount === totalCount across state permutations.
// Runner: npx tsx --test test/health-model.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

// health-model.js reads window.UI at call time — stub must exist BEFORE import.
const DAEMON_TONE: Record<string, string> = {
  ok: "ok",
  partial: "warn",
  error: "crit",
  missing: "crit",
  stale: "crit",
  quota_exceeded: "neutral",
};

interface StubWindow {
  UI: {
    daemonStatusTone: (status: string) => string;
    daemonStatusLabel: (status: string) => string;
  };
  HealthModel?: HealthModelApi;
}

interface FetchState {
  status: "loading" | "ready" | "error";
  data: unknown;
  error: string | null;
}

interface HealthStates {
  daemonState: FetchState;
  pgState: FetchState;
  hookState: FetchState;
  hookFailState: FetchState;
}

interface OverviewKpis {
  okCount: number | string;
  degradedCount: number | string;
  infoCount: number | string;
  staleCount: number | string;
  totalCount: number | string;
}

interface HealthModelApi {
  HEALTH_CARD_DEFS: ReadonlyArray<{ id: string; kind: string; daemonName?: string }>;
  resolveCardFacts: (def: unknown, states: HealthStates) => { status: string; tone?: string };
  computeOverviewKpis: (states: HealthStates) => OverviewKpis;
}

const stubWindow: StubWindow = {
  UI: {
    daemonStatusTone: (status) => DAEMON_TONE[status] ?? "info",
    daemonStatusLabel: (status) => status ?? "—",
  },
};
(globalThis as { window?: StubWindow }).window = stubWindow;

await import("../public/src/data/health-model.js");
const HealthModel = stubWindow.HealthModel;
assert.ok(HealthModel, "health-model.js must register window.HealthModel");

function ready(data: unknown): FetchState {
  return { status: "ready", data, error: null };
}
const LOADING: FetchState = { status: "loading", data: null, error: null };

function daemonRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    daemon_name: name,
    last_status: "ok",
    staleness_minutes: 60,
    is_stale: false,
    ...overrides,
  };
}

function allHealthyStates(overrides: Partial<HealthStates> = {}): HealthStates {
  return {
    daemonState: ready({
      daemons: [
        daemonRow("autoagent"),
        daemonRow("wiki"),
        daemonRow("daily-restart-autoagent"),
        daemonRow("daily-restart-wiki"),
      ],
    }),
    pgState: ready({ status: "ok", db: "open", browser: "ok" }),
    hookState: ready({ events: [{ groups: [{ hooks: ["h1"] }] }] }),
    hookFailState: ready({ count_24h: 0, unretried_count_24h: 0 }),
    ...overrides,
  };
}

// F02 core assertion — denominator == ready card count, buckets partition it exactly.
function assertKpiInvariant(states: HealthStates): OverviewKpis {
  const kpis = HealthModel.computeOverviewKpis(states);
  const readyCardCount = HealthModel.HEALTH_CARD_DEFS.filter(
    (def) => HealthModel.resolveCardFacts(def, states).status === "ready",
  ).length;
  assert.strictEqual(
    Number(kpis.okCount) + Number(kpis.degradedCount) + Number(kpis.infoCount),
    kpis.totalCount,
    "ok + degraded + info must equal totalCount",
  );
  assert.strictEqual(kpis.totalCount, readyCardCount, "KPI denominator must equal ready card count");
  return kpis;
}

test("all sources healthy: denominator covers all 7 cards incl. browser probe", () => {
  const kpis = assertKpiInvariant(allHealthyStates());
  assert.strictEqual(kpis.totalCount, HealthModel.HEALTH_CARD_DEFS.length);
  assert.strictEqual(kpis.okCount, HealthModel.HEALTH_CARD_DEFS.length);
  assert.strictEqual(kpis.degradedCount, 0);
  assert.strictEqual(kpis.infoCount, 0);
});

test("browser probe failed: counted in denominator AND degraded bucket", () => {
  const kpis = assertKpiInvariant(
    allHealthyStates({ pgState: ready({ status: "ok", db: "open", browser: "failed" }) }),
  );
  assert.strictEqual(kpis.totalCount, 7);
  assert.strictEqual(kpis.degradedCount, 1);
});

test("browser unprobed: info bucket, never ok or degraded", () => {
  const kpis = assertKpiInvariant(
    allHealthyStates({ pgState: ready({ status: "ok", db: "open" }) }),
  );
  assert.strictEqual(kpis.infoCount, 1);
  assert.strictEqual(kpis.okCount, 6);
});

test("pg not ready: pg + browser cards drop out of the denominator", () => {
  const kpis = assertKpiInvariant(allHealthyStates({ pgState: LOADING }));
  assert.strictEqual(kpis.totalCount, 5);
});

test("hook config not ready: hook card drops out of the denominator", () => {
  const kpis = assertKpiInvariant(allHealthyStates({ hookState: LOADING }));
  assert.strictEqual(kpis.totalCount, 6);
});

test("info attribution: missing daemon row + quota_exceeded land in info bucket", () => {
  const kpis = assertKpiInvariant(
    allHealthyStates({
      daemonState: ready({
        daemons: [
          daemonRow("autoagent", { last_status: "quota_exceeded" }),
          daemonRow("wiki"),
          daemonRow("daily-restart-autoagent"),
          // daily-restart-wiki row absent → card tone 'info' ('No data')
        ],
      }),
    }),
  );
  assert.strictEqual(kpis.totalCount, 7);
  assert.strictEqual(kpis.infoCount, 2);
  assert.strictEqual(kpis.degradedCount, 0);
});

test("stale daemon (threshold exceeded): degraded bucket + staleCount", () => {
  const kpis = assertKpiInvariant(
    allHealthyStates({
      daemonState: ready({
        daemons: [
          // 36h threshold (2160min) exceeded — stale wins over last_status='ok'.
          daemonRow("autoagent", { staleness_minutes: 3000 }),
          daemonRow("wiki"),
          daemonRow("daily-restart-autoagent"),
          daemonRow("daily-restart-wiki"),
        ],
      }),
    }),
  );
  assert.strictEqual(kpis.degradedCount, 1);
  assert.strictEqual(kpis.staleCount, 1);
});

test("hook failures: unretried 24h failure → crit; retried-only → warn (F08)", () => {
  const crit = assertKpiInvariant(
    allHealthyStates({ hookFailState: ready({ count_24h: 2, unretried_count_24h: 1 }) }),
  );
  assert.strictEqual(crit.degradedCount, 1);

  const warn = assertKpiInvariant(
    allHealthyStates({ hookFailState: ready({ count_24h: 2, unretried_count_24h: 0 }) }),
  );
  assert.strictEqual(warn.degradedCount, 1);
  assert.strictEqual(warn.okCount, 6);
});

test("daemonState not ready: KPI renders '—' sentinels, never fabricated zeros", () => {
  const kpis = HealthModel.computeOverviewKpis(allHealthyStates({ daemonState: LOADING }));
  assert.strictEqual(kpis.okCount, "—");
  assert.strictEqual(kpis.totalCount, "—");
});
