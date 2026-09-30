// Unit tests for the client-side pure logic in public/src/screens/dashboard.jsx
// (deriveUpdateView — the UpdateBadge state machine, 5 kinds: hidden | available |
// updating | current | failed). The server update contract is covered by
// dashboard.update.route.test.ts; this brings the BROWSER half of the Update button
// under regression coverage — a drift in the precedence (actionError → optimistic
// 'working' phase → job poll → availability → hidden), the stale in-progress
// degrade-to-failed, or the completed→current sticky (no age gate, no revert to a
// stale update-available) would otherwise ship undetected.
//
// Runner: npx tsx --test test/dashboard.client.unit.test.ts
//
// Sandbox harness (esbuild + node:vm over the real shipped dashboard.jsx): client-sandbox.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

interface UpdateView {
  kind: string;
}
interface DeriveArgs {
  availabilityStatus: string;
  availabilityData: unknown;
  job: unknown;
  phase: string;
  actionError: unknown;
  now: number;
  staleMs: number;
}
interface DashHelpers {
  deriveUpdateView: (args: DeriveArgs) => UpdateView;
  getJobVersion: (job: unknown) => string | null;
  mutationErrorMessage: (status: number, data: unknown) => string;
}

const dash = await buildScreenSandbox<DashHelpers>(DASH_SRC);
assert.strictEqual(typeof dash.deriveUpdateView, "function", "deriveUpdateView must be reachable");
assert.strictEqual(typeof dash.getJobVersion, "function", "getJobVersion must be reachable");
assert.strictEqual(typeof dash.mutationErrorMessage, "function", "mutationErrorMessage must be reachable");

const NOW = 1_700_000_000_000;
const STALE_MS = 30 * 60 * 1000;

// Convenience builder — the deriveUpdateView arg bag with sensible idle defaults.
function derive(overrides: Partial<DeriveArgs>): UpdateView {
  return dash.deriveUpdateView({
    availabilityStatus: "ready",
    availabilityData: { status: "current" },
    job: null,
    phase: "idle",
    actionError: null,
    now: NOW,
    staleMs: STALE_MS,
    ...overrides,
  });
}

const jobAt = (status: string, heartbeatMsAgo: number, extra: Record<string, unknown> = {}) => ({
  id: 42,
  status,
  target_version: "v1.2.3",
  started_at: new Date(NOW - heartbeatMsAgo).toISOString(),
  heartbeat_at: new Date(NOW - heartbeatMsAgo).toISOString(),
  failure_reason: null,
  ...extra,
});

// --- top precedence: actionError, then optimistic 'working' phase ---

test("actionError → failed (overrides 'working' phase and a completed job)", () => {
  assert.strictEqual(
    derive({ actionError: { message: "boom" }, phase: "working", job: jobAt("completed", 0) }).kind,
    "failed",
  );
});

test("phase 'working' → updating (optimistic, overrides a completed job poll)", () => {
  assert.strictEqual(derive({ phase: "working", job: jobAt("completed", 0) }).kind, "updating");
});

// --- job poll consumption ---

test("job completed → current (sticky — no age gate, current even past staleMs)", () => {
  assert.strictEqual(derive({ job: jobAt("completed", STALE_MS + 1) }).kind, "current");
  // Only a DISAGREEING pair separates the two precedence readings.
  // Every other case here leaves availability at its 'current' default, where both readings agree.
  assert.strictEqual(
    derive({
      job: jobAt("completed", STALE_MS + 1),
      availabilityData: { status: "update-available" },
    }).kind,
    "current",
    "a completed job lost to an availability verdict still reading 'update-available' — the badge " +
      "reverts to Update the moment the update it just finished lands, and stays there until the " +
      "next availability poll catches up",
  );
});

test("job failed → failed", () => {
  assert.strictEqual(derive({ job: jobAt("failed", 0, { failure_reason: "x" }) }).kind, "failed");
});

test("job in-progress with fresh heartbeat → updating", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", 5_000) }).kind, "updating");
});

test("job in-progress with stale heartbeat (age > staleMs) → failed (stalled degrade)", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", STALE_MS + 1) }).kind, "failed");
});

test("job in-progress with unparseable heartbeat → failed (Infinity age, never a stuck spinner)", () => {
  assert.strictEqual(derive({ job: jobAt("in-progress", 0, { heartbeat_at: "not-a-date" }) }).kind, "failed");
});

// --- availability consumption (no job) ---

test("no job + ready + update-available → available", () => {
  assert.strictEqual(derive({ job: null, availabilityData: { status: "update-available" } }).kind, "available");
});

test("no job + ready + current → current (resting)", () => {
  assert.strictEqual(derive({ job: null, availabilityData: { status: "current" } }).kind, "current");
});

test("no job + ready + non-actionable verdict → hidden (signal-free)", () => {
  for (const status of ["unknown", "source-dev", "error"]) {
    assert.strictEqual(derive({ job: null, availabilityData: { status } }).kind, "hidden", `verdict ${status}`);
  }
});

test("availability not ready (loading) + no job → hidden", () => {
  assert.strictEqual(derive({ availabilityStatus: "loading", availabilityData: null }).kind, "hidden");
});

test("availability ready but null data + no job → hidden", () => {
  assert.strictEqual(derive({ availabilityStatus: "ready", availabilityData: null }).kind, "hidden");
});

// --- precedence: job wins over availability ---

test("in-progress job (fresh) takes precedence over update-available availability → updating", () => {
  assert.strictEqual(
    derive({ job: jobAt("in-progress", 5_000), availabilityData: { status: "update-available" } }).kind,
    "updating",
  );
});

// --- job version label (getJobVersion) ---
// The apply route reserves the row with the literal 'pending' placeholder and the decoupled
// job overwrites it, so every apply is briefly polled back carrying it. Rendered as a version
// it reads as a release named 'pending'; null instead makes the caller drop to its version-less
// label. Mirrors routes/dashboard.ts PENDING_TARGET_VERSION.

test("getJobVersion returns a real release version unchanged", () => {
  assert.strictEqual(dash.getJobVersion(jobAt("in-progress", 0)), "v1.2.3");
});

test("getJobVersion maps the reservation placeholder to null (never rendered as a version)", () => {
  assert.strictEqual(dash.getJobVersion(jobAt("in-progress", 0, { target_version: "pending" })), null);
  assert.strictEqual(dash.getJobVersion(jobAt("completed", 0, { target_version: "pending" })), null);
});

test("getJobVersion maps an absent job or empty version to null", () => {
  assert.strictEqual(dash.getJobVersion(null), null);
  assert.strictEqual(dash.getJobVersion(jobAt("in-progress", 0, { target_version: "" })), null);
});

// --- mutation error taxonomy (mutationErrorMessage) ---
// Mirrors types/dashboard.ts UpdateMutationErrorBody. A code the server no longer emits must
// NOT keep a bespoke sentence here — it falls through to the server-supplied reason.

test("mutationErrorMessage maps the codes the route still emits", () => {
  assert.strictEqual(
    dash.mutationErrorMessage(409, { error: "single_active", reason: "x" }),
    "Another update is already in progress.",
  );
  assert.strictEqual(
    dash.mutationErrorMessage(500, { error: "enqueue_failed", reason: "x" }),
    "Couldn't start the update job.",
  );
  assert.strictEqual(
    dash.mutationErrorMessage(503, { error: "claude_unresolved", reason: "x" }),
    "The updater couldn't find the tool it needs on this host.",
  );
});

test("mutationErrorMessage has no branch for the retired preview_failed code", () => {
  assert.strictEqual(dash.mutationErrorMessage(500, { error: "preview_failed", reason: "boom" }), "boom");
  assert.strictEqual(dash.mutationErrorMessage(500, { error: "preview_failed" }), "Request failed (HTTP 500).");
});

// --- The week row: 7-day Spend strip + this week's task results ---

interface WeekRowHelpers {
  buildResultPanel: (data: unknown) => {
    rows: Array<{ result: string; count: number }>; writerTotal: number; span: string; agents: Array<{ agent: string; count: number }>;
  };
  buildHourGrid: (data: unknown) => {
    rows: Array<{ day: string; counts: number[]; fold: string | null }>; total: number; span: string;
    peak: { day: string; hour: number; count: number; fold: string | null };
  };
  describeHourGrid: (grid: unknown) => string;
  getPanelView: (state: unknown) => string;
  buildSpendStrip: (points: unknown) => { bars: Array<{ date: string; cost: number; isPartial: boolean }>; span: string | null };
  window: { UI: { resolveOutcomeRate: (data: unknown) => { breakage: number }; getWriterTotal: (data: unknown) => number } };
}
const week = dash as unknown as WeekRowHelpers;

test("the results panel counts follow the tile's writer-emitted rule and name their window", () => {
  const data = {
    total: 120, reconstructed_total: 20,
    by_result: [
      { result: "done", count: 80, reconstructed_count: 15 },
      { result: "fail", count: 25, reconstructed_count: 5 },
      { result: "blocked", count: 10, reconstructed_count: 0 },
      { result: "done_with_concerns", count: 5, reconstructed_count: 0 },
    ],
    prior_window: { period_start: "2026-09-16", period_end: "2026-09-23", total: 0, reconstructed_total: 0, by_result: [] },
  };
  const panel = week.buildResultPanel(data);
  const countOf = (result: string) => panel.rows.find((row) => row.result === result)?.count ?? 0;
  assert.equal(countOf("fail") + countOf("blocked"), week.window.UI.resolveOutcomeRate(data).breakage, "the panel's breakage is the tile's");
  assert.equal(panel.rows.reduce((sum, row) => sum + row.count, 0), week.window.UI.getWriterTotal(data), "rows add up to the tile's denominator");
  assert.match(panel.span, /09-23 – today/);
});

test("the results panel ranks agents by the tile's failed-or-blocked writer count", () => {
  const byAgentResult = [
    { agent: "a", result: "fail", count: 6, reconstructed_count: 2 },
    { agent: "a", result: "blocked", count: 1, reconstructed_count: 0 },
    { agent: "b", result: "fail", count: 9, reconstructed_count: 0 },
    { agent: "b", result: "done", count: 50, reconstructed_count: 0 },
    { agent: "c", result: "done_with_concerns", count: 30, reconstructed_count: 0 },
    { agent: "d", result: "blocked", count: 3, reconstructed_count: 3 },
    { agent: "e", result: "blocked", count: 1, reconstructed_count: 0 },
    { agent: "f", result: "fail", count: 1, reconstructed_count: 0 },
  ];
  const panel = week.buildResultPanel({ total: 0, reconstructed_total: 0, by_result: [], by_agent_result: byAgentResult });
  assert.deepEqual(JSON.parse(JSON.stringify(panel.agents)), [{ agent: "b", count: 9 }, { agent: "a", count: 5 }, { agent: "e", count: 1 }],
    "writer-only fail + blocked, worst first, ties by name, done and reconstructed-only rows out, top 3");
});

test("the hour grid keeps every cell, ends on the server's today and names the server's date count", () => {
  const data = Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, hour) => dow * 100 + hour));
  const sum = data.flat().reduce((a, b) => a + b, 0);
  const meta = { period_start: "2026-09-22", bucket_dates: { first: "2026-09-23", last: "2026-09-30", count: 8 }, total_count: sum };
  const grid = week.buildHourGrid({ data, meta });
  assert.equal(grid.rows[grid.rows.length - 1].day, "Wed", "2026-09-30 is a Wednesday");
  assert.equal(grid.rows[0].day, "Thu");
  assert.equal(grid.total, sum, "rotation neither drops nor duplicates a cell");
  assert.deepEqual([...(grid.rows.find((row) => row.day === "Mon")?.counts ?? [])], data[1], "a row keeps its own weekday's hours");
  assert.deepEqual({ ...grid.peak }, { day: "Sat", fold: null, hour: 23, count: 623 });
  assert.equal(grid.span, "09-23 – today, 8 calendar dates");
});

test("every weekday row that sums two of the server's bucket dates names both, and no other row is marked", () => {
  const data = Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, hour) => (dow === 3 && hour === 14 ? 90 : 1)));
  const rows = [
    { name: "8 dates, the window opens on today's weekday", first: "2026-09-23", last: "2026-09-30", count: 8,
      folds: { Wed: "09-23 + today" } },
    { name: "9 dates, early morning while the UTC anchor is a day behind", first: "2026-09-22", last: "2026-09-30", count: 9,
      folds: { Tue: "09-22 + 09-29", Wed: "09-23 + today" } },
    { name: "8 dates across a month end", first: "2026-09-24", last: "2026-10-01", count: 8,
      folds: { Thu: "09-24 + today" } },
  ];

  for (const row of rows) {
    const meta = { period_start: row.first, bucket_dates: { first: row.first, last: row.last, count: row.count } };
    const grid = week.buildHourGrid({ data, meta });
    const marked = Object.fromEntries(grid.rows.filter((r) => r.fold !== null).map((r) => [r.day, r.fold]));
    assert.deepEqual(marked, row.folds, `${row.name}: marked rows`);
    assert.equal(grid.rows[grid.rows.length - 1].fold, row.folds[grid.rows[grid.rows.length - 1].day as keyof typeof row.folds],
      `${row.name}: today's row is shown last`);
    assert.equal(grid.span, `${row.first.slice(5)} – today, ${row.count} calendar dates`, `${row.name}: span`);
  }
  const meta = { bucket_dates: { first: "2026-09-23", last: "2026-09-30", count: 8 } };
  assert.match(week.describeHourGrid(week.buildHourGrid({ data, meta })), /Wed \(09-23 \+ today\) 14:00 with 90 runs/,
    "the peak on the summed row names both dates");
});

test("a week panel whose refresh failed over held data reads last known, not fresh", () => {
  const rows: Array<[string, unknown, string]> = [
    ["first load", { data: null, error: null }, "loading"],
    ["cold failure", { data: null, error: "HTTP 500" }, "error"],
    ["fresh data", { data: {}, error: null }, "ready"],
    ["held data, failed refresh", { data: {}, error: "HTTP 500" }, "held"],
  ];
  for (const [name, state, view] of rows) assert.equal(week.getPanelView(state), view, name);
});

test("the Spend strip marks only the series' last point partial, since the route always ends it on its bucket-timezone today", () => {
  const rows = [
    { name: "a full week", days: ["24", "25", "26", "27", "28", "29", "30"], span: "09-24 – today" },
    { name: "a one-day series", days: ["30"], span: "09-30 – today" },
  ];
  for (const row of rows) {
    const strip = week.buildSpendStrip(row.days.map((day) => ({ date: `2026-09-${day}`, cost_usd: 10, session_count: 1 })));
    assert.deepEqual(strip.bars.map((bar) => bar.isPartial), row.days.map((_, i) => i === row.days.length - 1), row.name);
    assert.equal(strip.span, row.span, row.name);
  }
  const empty = week.buildSpendStrip([]);
  assert.equal(empty.bars.length, 0, "an empty series has no bars");
  assert.equal(empty.span, null, "an empty series has no today");
});

