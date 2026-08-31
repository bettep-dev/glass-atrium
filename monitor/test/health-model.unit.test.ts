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

// 카드 facts 집계 — KPI 가 세던 것과 같은 셈을 카드에서 직접 냄.
// 버킷 이름은 KPI 의 것을 그대로 씀: 재는 사실이 같으므로 이름까지 바꾸면 무엇이
// 이사했는지가 아니라 무엇이 사라졌는지로 읽힘.
interface CardTally {
  ok: number;
  degraded: number;
  info: number;
  stale: number;
  ready: number;
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
  resolveCardFacts: (
    def: unknown,
    states: HealthStates,
  ) => { status: string; tone?: string; isStale?: boolean };
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

// 세 버킷이 아는 tone 어휘 — KPI fold 의 else 가지가 'info = info + neutral' 이라고
// 명시 귀속을 적어 두었던 그 목록임. 밖의 값은 조용히 info 로 떨어지므로 어휘를 직접 잼.
const BUCKET_TONES = new Set(["ok", "warn", "crit", "info", "neutral"]);

// 카드 facts 집계 — KPI 접기 전에는 모델의 집계 fold 가 같은 셈을 냈음. 그 fold 는 카드
// facts 위의 얇은 층이었으므로 사실은 카드에 그대로 남았고, 아래 절들이 그것을 직접 잼.
//
// 옛 계기가 함께 내던 분할 불변식(ok + degraded + info === 분모)은 여기 다시 적지 않음:
// 이 함수가 분모와 버킷을 같은 루프에서 세므로 그 등식은 어떤 코드 변경으로도 깨지지
// 않는 항진명제가 됨 — 붉어질 수 없는 단언은 초록으로 안심만 시킴. 그 등식이 실제로
// 지키던 것(ready 카드가 반드시 어느 버킷 하나에 귀속됨)은 tone 어휘 단언이 대신 잼.
function tallyCardFacts(states: HealthStates): CardTally {
  const tally: CardTally = { ok: 0, degraded: 0, info: 0, stale: 0, ready: 0 };
  for (const def of HealthModel.HEALTH_CARD_DEFS) {
    const facts = HealthModel.resolveCardFacts(def, states);
    if (facts.status !== "ready") continue;

    assert.ok(
      BUCKET_TONES.has(String(facts.tone)),
      `a ready card carried tone "${facts.tone}", which no bucket claims — an unknown tone lands in info by default and reads as a healthy-enough card`,
    );

    tally.ready += 1;
    if (facts.tone === "ok") tally.ok += 1;
    else if (facts.tone === "warn" || facts.tone === "crit") tally.degraded += 1;
    else tally.info += 1;
    if (facts.isStale) tally.stale += 1;
  }

  return tally;
}

test("all sources healthy: every one of the 7 cards resolves, browser probe included", () => {
  const tally = tallyCardFacts(allHealthyStates());
  assert.strictEqual(tally.ready, HealthModel.HEALTH_CARD_DEFS.length);
  assert.strictEqual(tally.ok, HealthModel.HEALTH_CARD_DEFS.length);
  assert.strictEqual(tally.degraded, 0);
  assert.strictEqual(tally.info, 0);
});

test("browser probe failed: the card still resolves AND lands in the degraded bucket", () => {
  const tally = tallyCardFacts(
    allHealthyStates({ pgState: ready({ status: "ok", db: "open", browser: "failed" }) }),
  );
  assert.strictEqual(tally.ready, 7);
  assert.strictEqual(tally.degraded, 1);
});

test("browser unprobed: info bucket, never ok or degraded", () => {
  const tally = tallyCardFacts(allHealthyStates({ pgState: ready({ status: "ok", db: "open" }) }));
  assert.strictEqual(tally.info, 1);
  assert.strictEqual(tally.ok, 6);
});

test("pg not ready: pg + browser cards stop resolving", () => {
  const tally = tallyCardFacts(allHealthyStates({ pgState: LOADING }));
  assert.strictEqual(tally.ready, 5);
});

test("hook config not ready: the hook card stops resolving", () => {
  const tally = tallyCardFacts(allHealthyStates({ hookState: LOADING }));
  assert.strictEqual(tally.ready, 6);
});

test("bucket attribution: missing daemon row → info; quota_exceeded → degraded (warn re-tone)", () => {
  // quota_exceeded 는 warn 톤으로 재분류 → degraded 버킷. missing 행만 info 유지.
  const tally = tallyCardFacts(
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
  assert.strictEqual(tally.ready, 7);
  assert.strictEqual(tally.info, 1);
  assert.strictEqual(tally.degraded, 1);
});

test("stale daemon (server verdict): degraded bucket + counted as stale", () => {
  const tally = tallyCardFacts(
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
  assert.strictEqual(tally.degraded, 1);
  assert.strictEqual(tally.stale, 1);
});

test("hook failures: unretried 24h failure → crit; retried-only → warn (F08)", () => {
  const crit = tallyCardFacts(
    allHealthyStates({ hookFailState: ready({ count_24h: 2, unretried_count_24h: 1 }) }),
  );
  assert.strictEqual(crit.degraded, 1);

  const warn = tallyCardFacts(
    allHealthyStates({ hookFailState: ready({ count_24h: 2, unretried_count_24h: 0 }) }),
  );
  assert.strictEqual(warn.degraded, 1);
  assert.strictEqual(warn.ok, 6);
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

// KPI 가 '—' 로 내던 '아직 안 옴' 은 이제 행이 냄 — 판정이 없는 데몬 행은 tone 없이 '—' 를
// 실음. 그 사실은 화면 계기가 재야 하므로 AC-B2-6f(merged-surface e2e)로 옮겼고,
// 여기서는 카드가 애초에 ready 로 서지 않는다는 그 앞단만 남김.
test("daemonState not ready: the daemon cards do not resolve, so nothing counts them", () => {
  const tally = tallyCardFacts(allHealthyStates({ daemonState: LOADING }));
  assert.strictEqual(
    tally.ready,
    3,
    "only the pg, browser and hook cards can stand without a daemon response",
  );
  assert.strictEqual(tally.ok, 3, "a card that never resolved must not be counted as healthy");
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

// T14 는 분모가 정의 목록을 따른다는 사실이었음. 그 분모는 표의 행 수였다가 표가 걷히며
// (ADR-20) 노드 상세 패널의 부품 항목 수가 됐고, 그 사실은 AC-B2-4b(merged-surface e2e —
// '항목이 명부를 따르고 빈 명부는 항목을 남기지 않음')가 화면에서 직접 잼.
// 여기 있던 splice 기구는 그 계기를 두 번 세우던 자리라 함께 접음.
