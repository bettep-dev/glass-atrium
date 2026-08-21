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

test("completed job is sticky over update-available availability → current (no revert to available)", () => {
  assert.strictEqual(
    derive({ job: jobAt("completed", STALE_MS + 1), availabilityData: { status: "update-available" } }).kind,
    "current",
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
