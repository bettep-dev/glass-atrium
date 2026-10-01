// The System map's page-level state copy: which failed reads earn the one page alert, how the
// caption's failure count lines up with the stamp's, when the stamp may name a read time, and
// what a drawer connection row names.
//
// Runner: npx tsx --test test/architecture.page-state.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCH_SRC = resolve(__dirname, "../public/src/screens/architecture.jsx");

interface RegionState {
  status: "loading" | "ready" | "error";
  data: unknown;
  error: string | null;
  busy: boolean;
}

interface HealthFreshness {
  at: string | null;
  regions: RegionState[];
  now: number;
}

interface PageFailure {
  sources: string[];
  error: string;
}

interface PartRow {
  name: string;
  tone: string | null;
}

interface Flow {
  id: string;
  from: string;
  to: string;
}

interface PageStateSandbox {
  window: {
    UI: {
      getFreshnessState: (input: { at: string | null; regions: RegionState[]; now: number }) => string;
    };
  };
  getPageReadEntriesAR: (
    diagState: RegionState,
    liveState: RegionState,
    healthStates: Record<string, RegionState>,
  ) => Array<{ source: string; state: RegionState }>;
  getPageFailureAR: (entries: Array<{ source: string; state: RegionState }>) => PageFailure | null;
  getHealthCaptionAR: (partRows: PartRow[], busy: boolean, errored: number) => string;
  getFreshnessInputAR: (
    healthAsOf: string | null,
    regions: RegionState[],
    hasMap: boolean,
  ) => { at: string | null; regions: RegionState[] };
  getFlowPeerLabelAR: (flow: Flow, direction: "in" | "out", nodeIndex: Map<string, { label: string }>) => string;
  getPartHealthGroupsAR: (partRows: HealthRow[]) => { attention: HealthRow[]; rest: HealthRow[]; unloaded: HealthRow[] };
  getAttentionEmptyAR: (partRows: HealthRow[], busy: boolean, freshness: HealthFreshness) => string;
  getPartStatusAR: (row: HealthRow & { statusLabel: string }, freshness: HealthFreshness) => { tone: string | null; text: string };
  getPartBoxAR: (row: HealthRow, nodeIndex: Map<string, { label: string }>) => { nodeId: string; label: string } | null;
  getPartCauseAR: (facts: Record<string, unknown>) => string | null;
  getPartScheduleAR: (row: ScheduleRow, formatRelative: (iso: string) => string) => string | null;
  getDrillDaemonAR: (partRows: DaemonPartRow[], unscopedId: string) => string | null;
  getRunSummaryAR: (runs: RunRow[]) => { text: string; failures: RunRow[] };
  getMapLegendItemsAR: () => Array<{ key: string; mark?: string; text?: string }>;
  getPageVerdictAR: (
    partRows: HealthRow[],
    caption: string,
    nodeIndex: Map<string, { label: string }>,
  ) => { tone: string; sentence: string; chips: Array<{ key: string; label: string; targetId: string }> };
}

interface DaemonPartRow {
  id: string;
  daemonName: string | null;
  tone: string | null;
  nodeIds: string[];
}

interface RunRow {
  key: string;
  verdict: string;
  reasons: Array<{ message: string }>;
}

interface HealthRow {
  id: string;
  name: string;
  tone: string | null;
  nodeIds: string[];
}

const sandbox = await buildScreenSandbox<PageStateSandbox>(ARCH_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const HELD: RegionState = { status: "ready", data: { ok: true }, error: null, busy: false };
const FAILED_OVER_HELD: RegionState = { ...HELD, error: "HTTP 502 Bad Gateway" };
const DOWN: RegionState = { status: "error", data: null, error: "HTTP 502 Bad Gateway", busy: false };
const DOWN_OTHER_CAUSE: RegionState = { status: "error", data: null, error: "HTTP 404 Not Found", busy: false };
const FIRST_READ: RegionState = { status: "loading", data: null, error: null, busy: true };

function getEntries(diag: RegionState, live: RegionState, health: RegionState): Array<{ source: string; state: RegionState }> {
  return sandbox.getPageReadEntriesAR(diag, live, {
    daemonState: health,
    hookState: health,
    pgState: health,
    hookFailState: health,
  });
}

test("every failed read reaches one page alert, and a clean or single cold failure leaves it to the region", () => {
  const rows: Array<{ name: string; entries: Array<{ source: string; state: RegionState }>; failedSources: number | null }> = [
    { name: "nothing failed", entries: getEntries(HELD, HELD, HELD), failedSources: null },
    { name: "a warm re-read failed over held data", entries: getEntries(FAILED_OVER_HELD, HELD, HELD), failedSources: 1 },
    { name: "every warm re-read failed", entries: getEntries(FAILED_OVER_HELD, FAILED_OVER_HELD, FAILED_OVER_HELD), failedSources: 6 },
    { name: "a total cold outage", entries: getEntries(DOWN, DOWN, DOWN), failedSources: 6 },
    { name: "one cold failure with nothing held", entries: getEntries(DOWN, HELD, HELD), failedSources: null },
    { name: "cold failures of different causes", entries: getEntries(DOWN, DOWN_OTHER_CAUSE, HELD), failedSources: null },
  ];

  for (const row of rows) {
    const failure = sandbox.getPageFailureAR(row.entries);
    const failedCount = row.entries.filter((entry) => entry.state.error != null).length;
    if (row.failedSources === null) {
      assert.strictEqual(failure, null, row.name);
      continue;
    }
    assert.ok(failure, row.name);
    assert.strictEqual(failure.sources.length, failedCount, row.name);
    assert.strictEqual(failure.sources.length, row.failedSources, row.name);
  }
});

test("the alert names each source mid-sentence, so only a proper noun keeps its capital", () => {
  const failure = sandbox.getPageFailureAR(getEntries(DOWN, DOWN, DOWN));

  assert.ok(failure);
  for (const source of failure.sources) {
    const isProperNoun = source === "PostgreSQL";
    assert.ok(isProperNoun || source === source.toLowerCase(), `"${source}" is capitalised mid-sentence`);
  }
});

test("the caption states one population — the part rows — once, leaving read failures to the stamp", () => {
  const tones = (...list: Array<string | null>): PartRow[] => list.map((tone, i) => ({ name: `part ${i}`, tone }));
  const rows: Array<{ name: string; parts: PartRow[]; errored: number }> = [
    { name: "some ok, the rest unreadable", parts: tones("ok", "ok", "ok", null, null, null, null), errored: 1 },
    { name: "some ok, the rest not verified", parts: tones("ok", "ok", null), errored: 0 },
    { name: "a part needs attention", parts: tones("ok", "crit", null), errored: 1 },
    { name: "every part ok", parts: tones("ok", "ok"), errored: 0 },
  ];

  for (const row of rows) {
    const caption = sandbox.getHealthCaptionAR(row.parts, false, row.errored);
    const denominators = [...caption.matchAll(/\bof (\d+)\b/g)].map((match) => Number(match[1]));
    assert.ok(denominators.length <= 1, `${row.name}: "${caption}" states ${denominators.length} populations`);
    for (const denominator of denominators) assert.strictEqual(denominator, row.parts.length, `${row.name}: "${caption}"`);
  }
});

test("every health store the stamp counts is also named by the page alert", () => {
  const stores = ["daemonState", "hookState", "pgState", "hookFailState"];
  const baseline = getEntries(HELD, HELD, HELD);

  for (const store of stores) {
    const health = Object.fromEntries(stores.map((key) => [key, key === store ? FAILED_OVER_HELD : HELD]));
    const entries = sandbox.getPageReadEntriesAR(HELD, HELD, health);
    const failure = sandbox.getPageFailureAR(entries);
    assert.strictEqual(entries.length, baseline.length, store);
    assert.ok(failure, `${store} failed over held data but raised no page alert`);
    assert.deepEqual([...failure.sources], [entries.find((entry) => entry.state === FAILED_OVER_HELD)?.source], store);
  }
});

test("the stamp names a read time only once the map itself has been read", () => {
  const rows: Array<{ name: string; asOf: string | null; regions: RegionState[]; hasMap: boolean; expected: string }> = [
    { name: "a health read landed before the map", asOf: READ_AT, regions: [FIRST_READ, HELD], hasMap: false, expected: "loading" },
    { name: "the map never read and nothing in flight", asOf: READ_AT, regions: [DOWN, HELD], hasMap: false, expected: "not-read" },
    { name: "the map read and every region settled", asOf: READ_AT, regions: [HELD, HELD], hasMap: true, expected: "fresh" },
  ];

  for (const row of rows) {
    const input = sandbox.getFreshnessInputAR(row.asOf, row.regions, row.hasMap);
    assert.strictEqual(sandbox.window.UI.getFreshnessState({ ...input, now: NOW }), row.expected, row.name);
  }
});

test("a drawer connection row names the other end of the edge, never the open node", () => {
  const nodeIndex = new Map([
    ["open", { label: "Open node" }],
    ["peer", { label: "Peer node" }],
  ]);
  const inbound: Flow = { id: "e1", from: "peer", to: "open" };
  const outbound: Flow = { id: "e2", from: "open", to: "peer" };

  assert.strictEqual(sandbox.getFlowPeerLabelAR(inbound, "in", nodeIndex), "Peer node");
  assert.strictEqual(sandbox.getFlowPeerLabelAR(outbound, "out", nodeIndex), "Peer node");
});

function healthRow(id: string, tone: string | null, nodeIds: string[] = []): HealthRow {
  return { id, name: `Part ${id}`, tone, nodeIds };
}

const MIXED_ROWS: HealthRow[] = [
  healthRow("a", "ok"),
  healthRow("b", "warn"),
  healthRow("c", null),
  healthRow("d", "crit"),
  healthRow("e", "info"),
  healthRow("f", "crit"),
];

test("the part health block holds every part once — flagged, answered and not-loaded parts each in their own group, worst first", () => {
  const { attention, rest, unloaded } = sandbox.getPartHealthGroupsAR(MIXED_ROWS);
  const rank = (tone: string | null) => ["crit", "warn", "info", "ok"].indexOf(tone ?? "");

  assert.deepStrictEqual([...attention, ...rest, ...unloaded].map((row) => row.id).sort(), MIXED_ROWS.map((row) => row.id).sort());
  assert.ok(attention.every((row) => row.tone === "crit" || row.tone === "warn"), "a non-flagged part sits in attention");
  assert.ok(rest.every((row) => row.tone === "info" || row.tone === "ok"), "a flagged or not-loaded part sits with the answered ones");
  assert.ok(unloaded.every((row) => row.tone === null), "an answered part sits in the not-loaded group");
  for (const group of [attention, rest])
    for (let i = 1; i < group.length; i++)
      assert.ok(rank(group[i - 1].tone) <= rank(group[i].tone), `${group[i - 1].id} before ${group[i].id} breaks worst-first`);
});

describe("the empty Needs attention column says why it is empty, and its all-clear reads Last known exactly when the part rows do", () => {
  const now = Date.parse("2026-01-10T12:00:00.000Z");
  const readAt = new Date(now - 60_000).toISOString();
  const held: RegionState = { status: "ready", data: { ok: true }, error: null, busy: false };
  // a warm error keeps its held data and status 'ready' — only the error field records the failed re-read
  const warmError: RegionState = { ...held, error: "HTTP 500" };
  const down: RegionState = { status: "error", data: null, error: "HTTP 500", busy: false };
  const judged = [healthRow("a", "ok"), healthRow("b", null)];
  const unjudged = [healthRow("a", null)];
  const rows = [
    { name: "a read in flight is still checking", partRows: judged, busy: true, at: readAt, regions: [down], expected: /^Checking/ },
    { name: "an all-clear under a warm-error re-read is last known", partRows: judged, busy: false, at: readAt, regions: [warmError, held], expected: /^Last known/ },
    { name: "an all-clear under a cold store failure is last known", partRows: judged, busy: false, at: readAt, regions: [down, held], expected: /^Last known/ },
    { name: "an all-clear older than the stale threshold is last known", partRows: judged, busy: false, at: new Date(now - 10 * 60_000).toISOString(), regions: [held], expected: /^Last known/ },
    { name: "an all-clear with every store freshly read is a plain all-clear", partRows: judged, busy: false, at: readAt, regions: [held, held], expected: /^No part needs attention$/ },
    { name: "no verdict and a failed read says the read failed", partRows: unjudged, busy: false, at: null, regions: [down, down], expected: /^Couldn't read part health$/ },
    { name: "no verdict and no failure says it is not read yet", partRows: unjudged, busy: false, at: null, regions: [held], expected: /^Part health not read yet$/ },
  ];
  for (const row of rows)
    test(row.name, () => {
      assert.match(sandbox.getAttentionEmptyAR(row.partRows, row.busy, { at: row.at, regions: row.regions, now }), row.expected);
    });

  test("the all-clear and an ok part row agree on Last known for every settled read", () => {
    const okRow = { ...healthRow("a", "ok"), statusLabel: "Healthy" };
    for (const row of rows.filter((candidate) => !candidate.busy && candidate.partRows === judged)) {
      const freshness = { at: row.at, regions: row.regions, now };
      const text = sandbox.getAttentionEmptyAR(judged, false, freshness);
      const rowText = sandbox.getPartStatusAR(okRow, freshness).text;
      assert.strictEqual(text.startsWith("Last known"), rowText.startsWith("Last known"), `${row.name}: "${text}" vs "${rowText}"`);
    }
  });
});

test("a part names the map box it is bound to, and an unbound part names none", () => {
  const nodeIndex = new Map([["canonical.cron", { label: "Scheduled background jobs" }]]);

  assert.deepStrictEqual({ ...sandbox.getPartBoxAR(healthRow("x", "crit", ["cron"]), nodeIndex) }, {
    nodeId: "canonical.cron",
    label: "Scheduled background jobs",
  });
  assert.strictEqual(sandbox.getPartBoxAR(healthRow("y", "crit", []), nodeIndex), null);
  assert.strictEqual(sandbox.getPartBoxAR(healthRow("z", "crit", ["gone"]), nodeIndex), null);
});

test("a part's cause line comes only from a fact that explains the state", () => {
  const rows = [
    { name: "an overdue daemon", facts: { isStale: true, daemon: {} }, cause: "Missed its expected run" },
    { name: "an unreachable database", facts: { pgOk: false }, cause: "Database not reachable" },
    { name: "unretried hook failures", facts: { unretried24h: 3 }, cause: "3 unretried failures in 24h" },
    { name: "a daemon whose last run errored", facts: { daemon: { effective_status: "error" } }, cause: "Its last run reported an error" },
    { name: "a healthy database", facts: { pgOk: true }, cause: null },
    { name: "no explaining fact", facts: {}, cause: null },
  ];
  for (const row of rows) assert.strictEqual(sandbox.getPartCauseAR(row.facts), row.cause, row.name);
});

interface ScheduleRow {
  tone: string | null;
  cadenceMinutes: number | null;
  nextRunAt: string | null;
}

describe("a down part says how often it runs and when it is due next, from the served cadence and next-run fields", () => {
  const formatRelative = (iso: string) => `at ${iso}`;
  const NEXT = "2026-01-10T12:15:00.000Z";
  const rows: Array<{ name: string; row: ScheduleRow; schedule: string | null }> = [
    { name: "a minute cadence with a next run", row: { tone: "crit", cadenceMinutes: 15, nextRunAt: NEXT }, schedule: `runs every 15 min · next run at ${NEXT}` },
    { name: "an hour cadence with no next run served", row: { tone: "warn", cadenceMinutes: 60, nextRunAt: null }, schedule: "runs hourly" },
    { name: "a multi-hour cadence", row: { tone: "crit", cadenceMinutes: 120, nextRunAt: null }, schedule: "runs every 2 h" },
    { name: "a daily cadence", row: { tone: "crit", cadenceMinutes: 1440, nextRunAt: NEXT }, schedule: `runs daily · next run at ${NEXT}` },
    { name: "a next run with no cadence served", row: { tone: "crit", cadenceMinutes: null, nextRunAt: NEXT }, schedule: `next run at ${NEXT}` },
    { name: "a healthy part", row: { tone: "ok", cadenceMinutes: 15, nextRunAt: NEXT }, schedule: null },
    { name: "a down part with neither field", row: { tone: "crit", cadenceMinutes: null, nextRunAt: null }, schedule: null },
  ];
  for (const { name, row, schedule } of rows)
    test(name, () => assert.strictEqual(sandbox.getPartScheduleAR(row, formatRelative), schedule));
});

test("the page verdict takes the worst part tone, with one chip per flagged part focusing its row", () => {
  const nodeIndex = new Map([["canonical.cron", { label: "Scheduled jobs" }]]);
  const rows = [
    { name: "a critical part outranks a warning", parts: [healthRow("a", "warn"), healthRow("b", "crit", ["cron"])], tone: "crit" },
    { name: "a warning alone", parts: [healthRow("a", "warn"), healthRow("b", "ok")], tone: "warn" },
    { name: "every part ok", parts: [healthRow("a", "ok"), healthRow("b", "ok")], tone: "ok" },
    { name: "nothing judged yet", parts: [healthRow("a", null), healthRow("b", "info")], tone: "neutral" },
  ];

  for (const row of rows) {
    const verdict = sandbox.getPageVerdictAR(row.parts, "caption", nodeIndex);
    const flagged = row.parts.filter((part) => part.tone === "crit" || part.tone === "warn");

    assert.strictEqual(verdict.tone, row.tone, row.name);
    assert.deepStrictEqual([...verdict.chips.map((chip) => chip.targetId)].sort(), flagged.map((part) => `arch-part-${part.id}`).sort(), row.name);
  }
  const [chip] = sandbox.getPageVerdictAR([healthRow("b", "crit", ["cron"])], "caption", nodeIndex).chips;
  assert.ok(chip.label.includes("Part b") && chip.label.includes("Scheduled jobs"), `chip "${chip.label}" pairs the part with its box`);
});

test("a drawer drills into its node's worst daemon part, and into the first one when none is flagged", () => {
  const part = (id: string, tone: string | null, daemonName: string | null = id): DaemonPartRow => ({ id, daemonName, tone, nodeIds: ["cron"] });
  const rows = [
    { name: "a critical part after a healthy one", parts: [part("a", "ok"), part("b", "crit")], drill: "b" },
    { name: "a warning before an unjudged part", parts: [part("a", null), part("b", "warn")], drill: "b" },
    { name: "every part healthy", parts: [part("a", "ok"), part("b", "ok")], drill: "a" },
    { name: "a flagged part with no daemon", parts: [part("a", "crit", null), part("b", "ok")], drill: "b" },
    { name: "no part bound to the node", parts: [{ ...part("a", "crit"), nodeIds: ["pg"] }], drill: null },
  ];
  for (const row of rows) assert.strictEqual(sandbox.getDrillDaemonAR(row.parts, "cron"), row.drill, row.name);
});

test("the run history counts clean runs and keeps every other run as a row", () => {
  const run = (key: string, verdict: string, reasons: string[] = []): RunRow => ({ key, verdict, reasons: reasons.map((message) => ({ message })) });
  const runs = [run("1", "ok"), run("2", "ok", ["haiku quota"]), run("3", "unknown"), run("4", "ok"), run("5", "fail")];
  const summary = sandbox.getRunSummaryAR(runs);

  assert.strictEqual(summary.text, "2/5 runs clean");
  assert.deepStrictEqual(summary.failures.map((row) => row.key), ["2", "3", "5"]);
  assert.strictEqual(sandbox.getRunSummaryAR([]).text, "0/0 runs clean");
});

test("the map legend explains the multi-part count on a box's corner glyph", () => {
  const count = sandbox.getMapLegendItemsAR().find((item) => item.mark?.endsWith("×N"));
  assert.ok(count, "a legend item shows the ×N glyph");
  assert.match(count.text ?? "", /N parts in this box/);
});
