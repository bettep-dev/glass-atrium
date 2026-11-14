// Route classes for the remote listener: the security reviewer's table, keyed by method and Fastify route path.
// Data, not logic → a class changes only with a new reviewer sign-off (the test recomputes the sign-off digest).

import { createHash } from "node:crypto";

/**
 * page = reachable from a registered device · agent = local sessions, hooks, scripts · remote-admin = Mac page only ·
 * remote-pre-auth = remote listener, no registered device · remote-device = remote listener, acts on the caller or reduces access.
 */
export type RouteClass = "page" | "agent" | "remote-admin" | "remote-pre-auth" | "remote-device";

export interface ReviewedRoute {
  readonly route: string;
  readonly cls: RouteClass;
  readonly reason: string;
}

export interface RouteClassSignoff {
  readonly reviewer: string;
  readonly stream: string;
  readonly cid: string;
  /** leading REVIEWED_ROUTES rows this sign-off covers → a later sign-off appends rows, never edits signed ones */
  readonly rowCount: number;
  /** SHA-256 over the `route cls` lines of those rows, in order (getRouteClassDigest). */
  readonly sha256: string;
}

export const ROUTE_CLASS_SIGNOFFS: readonly RouteClassSignoff[] = [
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // delivery CID of the build that received the table; the reviewer's own verdict CID for these rows is unrecorded
    cid: "2026-11-14T1420_lan-build_c5b9",
    rowCount: 94,
    sha256: "b76036b059ce1c7e0e5f860d94c8afcc678e1b98b8212d21854a7a72d24179fc",
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S3",
    cid: "2026-11-14T1640_lan-route-classes_a93f",
    rowCount: 98,
    sha256: "f9fde5d98f1f33f74db6e2246425c05a42a90e8d87fed9f17aa51ff41f36d252",
  },
];

export const REVIEWED_ROUTES: readonly ReviewedRoute[] = [
  { route: "GET /*", cls: "page", reason: "app.ts read: static wildcard serves all of monitor/public (shell, bundles, sources); behind registration as a whole — sign-in assets need their own exact-path allowlist, not this wildcard" },
  { route: "GET /api/health", cls: "page", reason: "page boot fetch; handler read: DB probe, version, browser-launch state, timezone — discloses system state, so not pre-auth" },
  { route: "GET /api/health/daemons", cls: "page", reason: "page calls it; handler read: daemon_runs read plus an existence stat of the auth secrets file (never opened)" },
  { route: "GET /api/health/wiki-reports", cls: "page", reason: "page calls it; handler read: read-only daemon_runs query, days allowlisted" },
  { route: "GET /api/health/hook-chain", cls: "page", reason: "page calls it; handler read: returns only the hooks block of the Claude Code settings file (command strings) plus its absolute path — sensitive read, see notes" },
  { route: "GET /api/health/daemon-payload", cls: "page", reason: "page calls it; handler read: read-only payload rows, daemon allowlisted, limit clamped" },
  { route: "GET /api/health/hook-failures", cls: "page", reason: "page calls it; handler read: read-only hook_failures query, bounded" },
  { route: "GET /api/health/unpriced-models", cls: "page", reason: "page calls it; handler read: read-only cost_events query, bounded" },
  { route: "GET /api/health/document-integrity", cls: "agent", reason: "no page call site; handler read: maintenance probe whose limit=all re-reads and re-hashes the whole corpus — a cost lever with no page use" },
  { route: "GET /api/health/architecture-budget", cls: "agent", reason: "no call site anywhere, so not a page function; handler read: returns a constant, harmless — flip to page if the page starts calling it" },
  { route: "GET /api/dashboard/kpi", cls: "page", reason: "page calls it; handler read: read-only cost and outcome aggregates" },
  { route: "GET /api/dashboard/cost-timeseries", cls: "page", reason: "page calls it; handler read: read-only cost series, days allowlisted" },
  { route: "GET /api/dashboard/daemon-status", cls: "agent", reason: "no call site anywhere, so not a page function; handler read: read-only daemon rows — flip to page if the page starts calling it" },
  { route: "GET /api/dashboard/update-status", cls: "page", reason: "page calls it; handler read: local manifest plus a cached outbound release check (inner function not opened)" },
  { route: "POST /api/dashboard/update", cls: "page", reason: "page function, high-impact (self-update) kept page by owner decision; handler read: body must be mode=apply, no request value reaches the command or plist, single-active guard" },
  { route: "GET /api/dashboard/update-job", cls: "page", reason: "page calls it; handler read: latest update_job row only" },
  { route: "GET /api/architecture/live", cls: "page", reason: "page calls it; read-only per the list (DB overlay plus install descriptor files); handler not opened" },
  { route: "GET /api/architecture/diagrams", cls: "page", reason: "page calls it; read-only per the list (diagrams from in-repo source); handler not opened" },
  { route: "GET /api/agents/success-rate", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/revision-distribution", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/review-flag-timeseries", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/review-flag-by-agent", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/failure-patterns", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/lifecycle-stats", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/summary", cls: "page", reason: "page calls it (agent docs too, over loopback); read-only per the list incl. registry and circuit-breaker state files; handler not opened" },
  { route: "GET /api/agents/latency", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/agents/failure-reasons", cls: "page", reason: "page calls it; read-only per the list (returns outcome concern and hint text); handler not opened" },
  { route: "GET /api/agents/budget-overages", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "DELETE /api/agents/:name", cls: "agent", reason: "not read — the page calls it and the owner's decision keeps agent delete on the page; move to page once the handler is read" },
  { route: "GET /api/cost/by-model", cls: "page", reason: "page calls it; read-only cost aggregate per the list; handler not opened" },
  { route: "GET /api/cost/cache-hit", cls: "page", reason: "page calls it; read-only cost aggregate per the list; handler not opened" },
  { route: "GET /api/cost/session-distribution", cls: "page", reason: "page calls it; read-only per-session cost aggregate per the list; handler not opened" },
  { route: "GET /api/cost/parse-errors", cls: "page", reason: "page calls it; read-only cost aggregate per the list; handler not opened" },
  { route: "GET /api/cost/turn-stats", cls: "page", reason: "page calls it; read-only cost aggregate per the list; handler not opened" },
  { route: "GET /api/cost/kpi", cls: "page", reason: "page calls it; read-only cost aggregate per the list; handler not opened" },
  { route: "GET /api/clauded-docs/search", cls: "page", reason: "page calls it; read-only search returning body snippets per the list; handler and its SQL builder not opened" },
  { route: "GET /api/clauded-docs/groups", cls: "page", reason: "page calls it; handler read: read-only group listing, parameters bound and clamped" },
  { route: "POST /api/clauded-docs/group", cls: "agent", reason: "not read — page-called document-group write; move to page once the handler is read" },
  { route: "POST /api/clauded-docs/ungroup", cls: "agent", reason: "not read — page-called document-group write; move to page once the handler is read" },
  { route: "PATCH /api/clauded-docs/group/:rootId/reorder", cls: "agent", reason: "not read — page-called group-order write; move to page once the handler is read" },
  { route: "PATCH /api/clauded-docs/:id/move-group", cls: "agent", reason: "not read — and no call site anywhere, so not a page function either way" },
  { route: "POST /api/clauded-docs/html-export", cls: "agent", reason: "not read — page-called export that launches headless Chromium for up to 50 documents; move to page once the handler is read" },
  { route: "GET /api/clauded-docs", cls: "page", reason: "page calls it (hooks too, over loopback); handler read: read-only listing, filters bound and clamped; rows carry the absolute body path" },
  { route: "POST /api/clauded-docs", cls: "agent", reason: "no page call site — only local agent sessions create documents; handler read: writes a body file and a row, HTML sanitized first" },
  { route: "GET /api/clauded-docs/:id/html-export", cls: "agent", reason: "not read — page-called export that launches headless Chromium; move to page once the handler is read" },
  { route: "GET /api/clauded-docs/:id", cls: "page", reason: "page calls it (hooks too, over loopback); handler read: stored path checked against the docs root, agent-authored body returned inside a JSON envelope with a sandbox CSP header" },
  { route: "PUT /api/clauded-docs/:id", cls: "agent", reason: "not read — page-called document rewrite (local agents call it too); move to page once the handler is read" },
  { route: "DELETE /api/clauded-docs/:id", cls: "agent", reason: "not read — page-called document delete that unlinks the body file; move to page once the handler is read" },
  { route: "GET /api/outcomes/search", cls: "page", reason: "page calls it (agent docs too, over loopback); read-only per the list, returns lesson text; handler not opened" },
  { route: "GET /api/outcomes/cross-analysis", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/outcomes/heatmap", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/outcomes/attribution-daily", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/outcomes/channel-liveness", cls: "page", reason: "page calls it (doctor CLI too, over loopback); read-only per the list; handler not opened" },
  { route: "PATCH /api/outcomes/close-by-cid", cls: "agent", reason: "called only by the outcome-recording hook, no page call site; unaudited write; handler not read" },
  { route: "GET /api/outcomes/:id", cls: "page", reason: "page calls it; read-only per the list, returns one record with body and lesson; handler not opened" },
  { route: "PATCH /api/outcomes/:id/close", cls: "agent", reason: "not read — page-called unaudited write; move to page once the handler is read" },
  { route: "POST /api/telemetry/activation", cls: "agent", reason: "called only by the telemetry hook, no page call site; handler read: validated parameterized insert, unaudited" },
  { route: "GET /api/telemetry/activations", cls: "page", reason: "page calls it; handler read: read-only list, parameters bound and range-checked" },
  { route: "GET /api/improvement", cls: "page", reason: "page calls it; read-only per the list, returns proposals incl. proposed agent-body diffs — sensitive read, see notes; handler not opened" },
  { route: "GET /api/improvement/stats", cls: "page", reason: "page calls it; read-only aggregate per the list; handler not opened" },
  { route: "GET /api/improvement/learning-log", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/improvement/loop-events", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/improvement/corpus-audits", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/improvement/correction-signals", cls: "page", reason: "page calls it; read-only per the list, returns distilled correction hints; handler not opened" },
  { route: "POST /api/improvement/:id/approve", cls: "agent", reason: "not read — page-called act that runs the apply script and edits a live agent body; owner's decision keeps it on the page; move once the handler is read" },
  { route: "POST /api/improvement/:id/reject", cls: "agent", reason: "not read — page-called proposal status write; move to page once the handler is read" },
  { route: "POST /api/improvement/:id/restore", cls: "agent", reason: "not read — and the list shows no page call site although the owner's decision names restore as a page act; resolve before moving" },
  { route: "GET /api/wiki/summary", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/wiki/cycles", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/wiki/index-metrics", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/wiki/backlog", cls: "page", reason: "page calls it; read-only per the list; handler not opened" },
  { route: "GET /api/model-config", cls: "page", reason: "page calls it; handler read: model ids, budget caps and tier values from the DB, daemon-config.json and agent model lines — no credential read" },
  { route: "PUT /api/model-config", cls: "page", reason: "page function, high-impact (model-config write) kept page by owner decision; handler read: validate-all-first against fixed keys, then rewrites daemon-config.json and agent model pins" },
  { route: "GET /api/queue/count", cls: "page", reason: "page calls it; route read: item counts only (behind the queue Host allowlist, see notes)" },
  { route: "POST /api/queue/sessions/register", cls: "agent", reason: "session-side route for the local queue CLI; no credential, registers whatever session the body names; route read, work function not opened" },
  { route: "POST /api/queue/sessions/deregister", cls: "agent", reason: "session-side route for the local queue CLI; no credential, acts on whatever session id the body names; route read, work function not opened" },
  { route: "POST /api/queue/items", cls: "agent", reason: "session-side route for the local queue CLI; a remote caller could post items to the owner as any session; route read, work function not opened" },
  { route: "GET /api/queue/items/:id", cls: "agent", reason: "session-side read for the local CLI and hook; returns the owner's answer to whoever names the session id; route read, work function not opened" },
  { route: "POST /api/queue/pending", cls: "agent", reason: "session-side claim for the local CLI; a remote caller could claim another session's answered items; route read, work function not opened" },
  { route: "POST /api/queue/items/:id/ack", cls: "agent", reason: "session-side ack for the local CLI; no credential beyond a named session id; route read, work function not opened" },
  { route: "POST /api/queue/items/:id/withdraw", cls: "agent", reason: "session-side withdraw for the local CLI; no credential beyond a named session id; route read, work function not opened" },
  { route: "GET /api/queue/owner/items", cls: "page", reason: "page calls it; route read: owner item list plus the installed CLI path" },
  { route: "GET /api/queue/owner/items/:id", cls: "agent", reason: "no call site anywhere, so not a page function; route read: read-only owner view — flip to page if the page starts calling it" },
  { route: "GET /api/queue/owner/resumes", cls: "page", reason: "page calls it; route read: read-only recent resume deliveries, query schema-validated" },
  { route: "GET /api/queue/owner/orders", cls: "page", reason: "page calls it; route read: read-only order history, query schema-validated" },
  { route: "POST /api/queue/owner/items/:id/answer", cls: "page", reason: "page function, high-impact (owner answer reaches a local session) kept page by owner decision; route read: schema-validated, page-origin stamp required" },
  { route: "POST /api/queue/owner/items/:id/reply", cls: "page", reason: "page function, high-impact (owner reply or order reaches a local session) kept page by owner decision; route read: schema-validated, page-origin stamp required" },
  { route: "GET /api/queue/owner/sessions", cls: "page", reason: "page calls it; route read: read-only session list (names, working-directory tails, waiting state)" },
  { route: "POST /api/queue/owner/messages/send", cls: "page", reason: "page function, high-impact (owner message to up to 20 local sessions) kept page by owner decision; route read: schema-validated, page-origin stamp required" },
  { route: "POST /api/queue/owner/images", cls: "page", reason: "page function, high-impact (file write) kept page by owner decision; route read: raw body limited to image types and a byte cap; file-naming function not opened" },
  { route: "GET /api/queue/owner/images/:id", cls: "page", reason: "page calls it; route read: serves image bytes with nosniff, same-origin resource policy and a sandbox CSP" },
  { route: "POST /api/queue/owner/items/:id/later", cls: "page", reason: "page calls it; route read: item status transition, empty body schema" },
  { route: "POST /api/queue/owner/items/:id/seen", cls: "page", reason: "page calls it; route read: item status transition, empty body schema" },
  { route: "POST /api/queue/owner/items/:id/resend", cls: "page", reason: "page function, re-queues a delivery to a local session (same resume path as answer); route read: empty body schema" },
  { route: "POST /api/remote/registration", cls: "remote-admin", reason: "loopback only; Sec-Fetch-Site exactly same-origin, empty body, open-rate limit; audit row before the code, no row → no code; code in this response body only, no-store" },
  { route: "GET /api/remote/devices", cls: "remote-admin", reason: "loopback only; same Sec-Fetch-Site rule although a GET; returns id, label, created, last seen only" },
  { route: "DELETE /api/remote/devices/:id", cls: "remote-admin", reason: "loopback only; same rule, decimal id, no body; remote.revoke after the revoke, audit failure never blocks it; one device_not_found" },
  { route: "POST /api/remote/devices/revoke-all", cls: "remote-admin", reason: "loopback only; same rule, empty body; remote.revoke with the count only" },
];

const CLASS_BY_ROUTE: ReadonlyMap<string, RouteClass> = new Map(REVIEWED_ROUTES.map((entry) => [entry.route, entry.cls]));

/**
 * Class of a route by method and Fastify route path; HEAD takes its GET's class (Fastify exposes one per GET).
 * @returns null for an unclassified route → the remote listener denies it
 */
export function getRouteClass(method: string, routePath: string): RouteClass | null {
  const lookupMethod = method === "HEAD" ? "GET" : method;
  return CLASS_BY_ROUTE.get(`${lookupMethod} ${routePath}`) ?? null;
}

/** Digest the sign-off pins → a class edited without a new sign-off fails the route-class test. */
export function getRouteClassDigest(routes: readonly ReviewedRoute[]): string {
  return createHash("sha256")
    .update(routes.map((entry) => `${entry.route} ${entry.cls}`).join("\n"))
    .digest("hex");
}
