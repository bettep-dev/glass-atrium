// Unit tests for public/src/data/health-model.js (F02) — the health KPI
// denominator must equal the rendered (ready) card count, with the invariant
// okCount + degradedCount + infoCount === totalCount across state permutations.
// Runner: npx tsx --test test/health-model.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DAEMON_CRON_SCHEDULE,
  STALE_MULTIPLIER,
  expectedIntervalMinutes,
} from "../src/server/schedule-next-fire.js";

// health-model.js reads window.UI at call time — stub must exist BEFORE import.
// Mirrors ui.jsx DAEMON_STATUS_TONE (the SoT). missing→info per F#38 fix.
const DAEMON_TONE: Record<string, string> = {
  ok: "ok",
  partial: "warn",
  error: "crit",
  missing: "info",
  stale: "crit",
  quota_exceeded: "warn",
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

interface HealthCardDef {
  id: string;
  kind: string;
  daemonName?: string;
}

interface HealthModelApi {
  // Mutable on purpose, not a missed `readonly`: the T14 fixtures below splice the live
  // exported array and restore it — the module leaves it unfrozen for exactly that.
  HEALTH_CARD_DEFS: HealthCardDef[];
  resolveCardFacts: (def: unknown, states: HealthStates) => { status: string; tone?: string };
  computeOverviewKpis: (states: HealthStates) => OverviewKpis;
  resolveDaemonDisplayMeta: (d: unknown) => { tone: string; label: string };
}

const stubWindow: StubWindow = {
  UI: {
    daemonStatusTone: (status) => DAEMON_TONE[status] ?? "info",
    daemonStatusLabel: (status) => status ?? "—",
  },
};
// Double-cast is required, not laziness: with the DOM lib loaded `globalThis.window` is
// `Window & typeof globalThis`, which does not overlap this stub — and installing a
// non-Window stub is exactly the point, since the module under test is a browser
// module loaded in node.
(globalThis as unknown as { window?: StubWindow }).window = stubWindow;

await import("../public/src/data/health-model.js");
const registeredHealthModel = stubWindow.HealthModel;
assert.ok(registeredHealthModel, "health-model.js must register window.HealthModel");
// Re-bind to a non-optional handle: `assert.ok` narrows the value here, but that narrowing
// does not survive into the helper closures below, which are where the model is used.
const HealthModel: HealthModelApi = registeredHealthModel;

function ready(data: unknown): FetchState {
  return { status: "ready", data, error: null };
}
const LOADING: FetchState = { status: "loading", data: null, error: null };

// effective_status is the server verdict and the only field the model may read;
// staleness_minutes rides along so a re-derivation would be visible here.
function daemonRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    daemon_name: name,
    last_status: "ok",
    effective_status: "ok",
    staleness_minutes: 60,
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

test("bucket attribution: missing daemon row → info; quota_exceeded → degraded (warn re-tone)", () => {
  // quota_exceeded 는 warn 톤으로 재분류 → degraded 버킷. missing 행만 info 유지.
  const kpis = assertKpiInvariant(
    allHealthyStates({
      daemonState: ready({
        daemons: [
          daemonRow("autoagent", {
            last_status: "quota_exceeded",
            effective_status: "quota_exceeded",
          }),
          daemonRow("wiki"),
          daemonRow("daily-restart-autoagent"),
          // daily-restart-wiki row absent → card tone 'info' ('No data')
        ],
      }),
    }),
  );
  assert.strictEqual(kpis.totalCount, 7);
  assert.strictEqual(kpis.infoCount, 1);
  assert.strictEqual(kpis.degradedCount, 1);
});

test("stale daemon (server verdict): degraded bucket + staleCount", () => {
  const kpis = assertKpiInvariant(
    allHealthyStates({
      daemonState: ready({
        daemons: [
          // The server called it overdue — that verdict outranks last_status='ok'.
          daemonRow("autoagent", { effective_status: "stale", staleness_minutes: 3000 }),
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

test("stale verdict: display meta comes from the tone table, tone stays crit (Rule 4)", () => {
  const meta = HealthModel.resolveDaemonDisplayMeta(
    daemonRow("autoagent", { effective_status: "stale", staleness_minutes: 3000 }),
  );
  assert.strictEqual(meta.tone, "crit");
  assert.strictEqual(
    meta.label,
    "stale",
    "the stub returns the status it was handed — a local 'STALE' literal would not reach it",
  );
});

// --- AC-T3: the daemon verdict is the server's, not a client re-computation ---

test("AC-T3 source: no per-daemon threshold table, no staleness re-derivation", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../public/src/data/health-model.js", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(
    src,
    /DAEMON_STALE_THRESHOLD_MIN/,
    "a per-daemon threshold table is a second verdict rule competing with the server's",
  );
  assert.doesNotMatch(
    src,
    /staleness_minutes/,
    "reading the staleness figure at all is how the client starts judging again",
  );
});

test("AC-T3 verdict: effective_status decides, whatever staleness_minutes says", () => {
  // Past the deleted 2160-min (36h) table, but the server calls it fresh.
  const fresh = HealthModel.resolveDaemonDisplayMeta(
    daemonRow("autoagent", { staleness_minutes: 3000, effective_status: "ok" }),
  );
  assert.strictEqual(fresh.tone, "ok", "a client override would re-tone this to crit");
  // Inside that window, but the server escalated it (never-fired past a cadence window).
  const stale = HealthModel.resolveDaemonDisplayMeta(
    daemonRow("autoagent", { staleness_minutes: 60, effective_status: "stale" }),
  );
  assert.strictEqual(stale.tone, "crit", "the server verdict must survive a low staleness");
});

test("daemonState not ready: KPI renders '—' sentinels, never fabricated zeros", () => {
  const kpis = HealthModel.computeOverviewKpis(allHealthyStates({ daemonState: LOADING }));
  assert.strictEqual(kpis.okCount, "—");
  assert.strictEqual(kpis.totalCount, "—");
});

// --- AC-T4 (health half): the board follows the one server threshold and holds none of its own.
// The map half of the same move, and the screen-to-screen comparison, live in
// test/architecture.daemon-binding.test.ts.

const WIDER_MULTIPLIER = 2;
// A run overdue at the shipped multiplier and inside a wider one — the band where a second
// threshold gives itself away.
const BAND_MIN = Math.round(
  expectedIntervalMinutes(DAEMON_CRON_SCHEDULE.autoagent) *
    ((STALE_MULTIPLIER + WIDER_MULTIPLIER) / 2),
);

test("AC-T4 the server threshold moves, the row does not, and the card moves with the verdict", () => {
  const overdue = daemonRow("autoagent", {
    effective_status: "stale",
    staleness_minutes: BAND_MIN,
  });
  // Only the server threshold widened: same daemon, same last run, same staleness figure.
  const inside = { ...overdue, effective_status: "ok" };

  assert.strictEqual(HealthModel.resolveDaemonDisplayMeta(overdue).tone, "crit");
  assert.strictEqual(
    HealthModel.resolveDaemonDisplayMeta(inside).tone,
    "ok",
    "a threshold of its own would hold this at crit — the staleness figure never changed",
  );
});

// --- T14: the denominator follows the card definition list, not a copy of its length ------
// RED 확보 기구 — `HEALTH_CARD_DEFS` 는 동결되지 않은 채 참조로 내보내지므로 픽스처가 줄였다
// 복원할 수 있음. 모델이 목록 길이를 스냅샷/리터럴로 굳혔다면 아래 두 단언이 붉어짐.
// 기구 선례: architecture.live-badge.client.unit.test.ts (맵 몫의 같은 기구).

test("T14 shrinking the definition list shrinks the KPI denominator by the same count", () => {
  const defs = HealthModel.HEALTH_CARD_DEFS;
  const full = defs.length;
  const removed = defs.splice(1, 3);
  try {
    assert.strictEqual(removed.length, 3, "fixture precondition: three defs removed");
    const kpis = HealthModel.computeOverviewKpis(allHealthyStates());
    assert.strictEqual(
      kpis.totalCount,
      full - 3,
      "denominator must follow HEALTH_CARD_DEFS — a snapshot count would stay at the old total",
    );
    assert.strictEqual(
      kpis.totalCount,
      defs.length,
      "denominator must equal the live definition count, whatever that count currently is",
    );
    assert.strictEqual(
      Number(kpis.okCount) + Number(kpis.degradedCount) + Number(kpis.infoCount),
      kpis.totalCount,
      "the buckets must still partition the shrunken denominator exactly",
    );
  } finally {
    // 복원 — 뒤 테스트가 온전한 목록을 보게 함. splice 반환분을 원래 자리에 되꽂음.
    defs.splice(1, 0, ...removed);
    assert.strictEqual(defs.length, full, "definition list must be restored");
  }
});

test("T14 an empty definition list yields a 0 denominator, never a stale total", () => {
  const defs = HealthModel.HEALTH_CARD_DEFS;
  const backup = defs.slice();
  defs.splice(0, defs.length);
  try {
    const kpis = HealthModel.computeOverviewKpis(allHealthyStates());
    assert.strictEqual(kpis.totalCount, 0, "no definitions means no denominator, not a fake total");
    assert.strictEqual(kpis.okCount, 0);
    assert.strictEqual(kpis.degradedCount, 0);
    assert.strictEqual(kpis.infoCount, 0);
  } finally {
    defs.splice(0, 0, ...backup);
    assert.strictEqual(defs.length, backup.length, "definition list must be restored");
  }
});
