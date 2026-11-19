// Route classes for the remote listener: the security reviewer's table, keyed by method and Fastify route path.
// Data, not logic → a class changes only with a new reviewer sign-off (the test recomputes the latest sign-off digest).

import { createHash } from "node:crypto";

/**
 * page = reachable from a registered device · agent = local sessions, hooks, scripts · remote-admin = Mac page only ·
 * remote-pre-auth = remote listener, no registered device · remote-device = remote listener, acts on the caller or reduces access ·
 * remote-cli = loopback only, the glass-atrium CLI (fixed header, no browser header), reduce-only.
 */
export type RouteClass = "page" | "agent" | "remote-admin" | "remote-pre-auth" | "remote-device" | "remote-cli";

export interface ReviewedRoute {
  readonly route: string;
  readonly cls: RouteClass;
  readonly reason: string;
}

export interface RouteClassSignoff {
  readonly reviewer: string;
  readonly stream: string;
  /** the reviewer's verdict CIDs this sign-off records */
  readonly cids: readonly string[];
  /** leading REVIEWED_ROUTES rows this sign-off covers */
  readonly rowCount: number;
  /** SHA-256 over the `route cls` lines of those rows, in order (getRouteClassDigest). */
  readonly sha256: string;
  /** first CID of the later sign-off that re-signed these rows → history only, even where its digest still matches the live table */
  readonly supersededBy?: string;
}

// the whole-table re-sign: class changes inside the first 94 rows broke every earlier digest
const RESIGN_CID = "2026-11-15T0140_lan-signin-routes_c18e";
// the devices row's reason re-signed in place (devices-row-resign-verdict.md): path, class and order kept → same digest
const DEVICES_RESIGN_CID = "2026-11-16T2200_lan-close_2f8b";
// row 109 appended (deploy65-route-rows-verdict.md) → the 108-row digest still verifies as its prefix
const PENDING_COUNT_CID = "2026-11-16T2025_deploy65-prep_a9e3";
// seven queue-owner rows' reasons re-signed in place (owner-rows-verdict.md): route, class and order kept → same digest
const OWNER_ROWS_CID = "2026-11-16T2215_owner-rows-verdict_e6b0";
// rows 110-115 appended (route-rows-verdict.md) → the 109-row digest still verifies as its prefix
const ONBOARDING_CID = "2026-11-17T0850_onboarding-build_3f9a";
// the access, setup and certificate reasons re-signed in place (route-rows-resign-verdict.md): route, class and order kept → same digest
const CLOSE_CID = "2026-11-19T0700_onboarding-close_8e2d";
// the on, trust, network-read and single html-export reasons re-signed in place (route-rows-sign-last-verdict.md): route, class and order kept → same digest
const SIGN_LAST_CID = "2026-11-19T0945_onboarding-close2_5b7c";
// the sign-in.js reason re-signed in place for its fragment read (steps-review-items.json → A10, A11): route, class and order kept → same digest
const FRAGMENT_READ_CID = "2026-11-19T1520_steps-finish_d9a2";

/** Append-only history; the last entry covers the whole live table and is the one the test checks. */
export const ROUTE_CLASS_SIGNOFFS: readonly RouteClassSignoff[] = [
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // verdict recorded in the lan-access follow-up folder → first-route-classification-verdict.md (sec-guard, build run wf_d4bb334b-c07)
    // its rows that no later verdict names → carried unchanged, same class, by every later entry, the live one included
    cids: ["2026-11-14T1420_lan-build_c5b9"],
    rowCount: 94,
    sha256: "b76036b059ce1c7e0e5f860d94c8afcc678e1b98b8212d21854a7a72d24179fc",
    supersededBy: RESIGN_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S3",
    cids: ["2026-11-14T1640_lan-route-classes_a93f"],
    rowCount: 102,
    sha256: "3d234a90e3476fabcf110784cedbfbc535753e1bde142da98578bc95dbcfc61a",
    supersededBy: RESIGN_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S3",
    cids: ["2026-11-14T2145_lan-cli-channel_5f0c"],
    rowCount: 105,
    sha256: "7801ce43f3335b0f6fe0aad59b39425b951fe49ad60116cb601f5dc66ccc9e32",
    supersededBy: RESIGN_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S6",
    // sign-in rows 106-108 and the unread rows (signin), the document writes (writes), the read rows (reads, reads-b, reads-c),
    // rows 95-105 carried unchanged (route-classes, cli-channel), rows 1-94 no later verdict names carried from the first entry
    cids: [
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 108,
    sha256: "781679bf68d4da01f2dc28118715f374e40e11bf6c856ee3b2b2409f672b36f8",
    supersededBy: DEVICES_RESIGN_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S6",
    // every row of the entry before it carried unchanged; the GET /api/remote/devices reason re-signed
    cids: [
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 108,
    sha256: "781679bf68d4da01f2dc28118715f374e40e11bf6c856ee3b2b2409f672b36f8",
    supersededBy: PENDING_COUNT_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S6",
    // every row of the entry before it carried unchanged; POST /api/queue/pending/count appended, the POST /api/queue/pending reason re-signed
    cids: [
      PENDING_COUNT_CID,
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 109,
    sha256: "e3287f49fab0043a549327d6f83955c559bbcb8a5d4636b6c264c1705ee1ba0a",
    supersededBy: OWNER_ROWS_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S6",
    // every row of the entry before it carried unchanged; seven queue-owner reasons re-signed
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C1 resume spawn argv-only, the registry row the sole source of session id, cwd and config dir → no item or answer text in the resume payload, argv or child env
    // C2 a mutation refused (503 audit_unavailable) when its audit intent cannot be written; no pruning of remote audit rows for these routes before the queue provenance columns land
    // C3 these reads disclose absolute local paths and answer text to a registered device → accepted (queue items 145, 186), stated in the reasons
    cids: [
      OWNER_ROWS_CID,
      PENDING_COUNT_CID,
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 109,
    sha256: "e3287f49fab0043a549327d6f83955c559bbcb8a5d4636b6c264c1705ee1ba0a",
    supersededBy: ONBOARDING_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S4",
    // every row of the entry before it carried unchanged; the Mac page's access, setup and certificate rows 110-115 appended;
    // the registration and devices GET reasons re-signed, the devices DELETE and revoke-all rows re-signed byte-identical
    // its conditions C1-C8 → stated as they now stand on the entry after it
    cids: [
      ONBOARDING_CID,
      OWNER_ROWS_CID,
      PENDING_COUNT_CID,
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 115,
    sha256: "7d37fe46bdd516c51cc2a9c1e0083619ff326af0e69e7c322d90fc0addade351",
    supersededBy: CLOSE_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S7",
    // every row of the entry before it carried unchanged; the on, off, trust, setup and certificate reasons re-signed,
    // the network read and devices GET reasons re-signed byte-identical
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C1 met: scripts/remote-access-set.sh → main (on and off the act alone, trust the three identity fields), set_trust (trusted list only); lib/ga-remote.sh → ga_remote_create_ca (an existing CA kept), ga_remote_set_config (temp file then rename), ga_remote_main (no dispatch or help entry); controller.ts → turnOff; network.ts → isTrustedNetwork, getNetworkIdentity, getNetworkLink; gate.ts → admitDevice, recordEvent, getRoutePayload; app.ts → Host hook, registerRequestGuards, one registerRemoteAdminRoutes call
    // C2 open: the page's confirm (focus on Cancel, router address shown) unread; the page to call the network read only when a confirm opens
    // C3 open: remote-access.jsx → PAGE_HEADERS_RA on its one fetch helper; every Mac page call going through that helper unconfirmed
    // C4 open: sign-in rows 106-108 re-read when their files change: sign-in.html (meta CSP byte-identical, links only /sign-in.css and /sign-in.js, no new URL-carrying element, inline script or handler, words naming no feature, device, count or Mac name), sign-in.js (the form's script only, no new request target, server text set as text, no query or fragment read, no stored code), sign-in.css when changed (no url() or @import), the fixed three-file list; a failure needs a new line
    // C5 met: admin-routes.ts → getWithin bounds the off's request row, revoke and close; a persist that did not write → start.ts → setDeviceOff; residual: RemoteAccessSwitch.#apply awaits the old listener's close and the open unbounded inside the act queue → an off queued behind a widening act waits on them
    // C6 met: admin-routes.ts → getCertificate refuses anything but exactly one CA certificate and serves it re-encoded (PEM_CERTIFICATE)
    // C7 met: set_trust takes the shown network in fixed argv positions, format-checked (is_network_identity), exits 10 writing nothing on a differing read → start.ts → runAccessStep, ACCESS_STEP_OUTCOME
    // C8 met for the on's request row and a thrown act's error outcome row (admin-routes.ts → WIDENING_REQUEST_PAYLOAD, widenAccess); open: the page's words for a timed-out on (write_failed) to say the state is unknown until restart
    cids: [
      CLOSE_CID,
      ONBOARDING_CID,
      OWNER_ROWS_CID,
      PENDING_COUNT_CID,
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 115,
    sha256: "7d37fe46bdd516c51cc2a9c1e0083619ff326af0e69e7c322d90fc0addade351",
    supersededBy: SIGN_LAST_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S7",
    // every row of the entry before it carried unchanged; the on, trust, network read and single html-export reasons re-signed
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C1 met: start.ts → runAccessStep fixed binary, fixed argv, no request value; scripts/remote-access-set.sh carried from the entry before
    // C2 met: remote-access.jsx → onWiden the one caller of readConfirmNetworkRA (a confirm opening); a first read lands only on a page with no confirm, a re-read only in its own act's; Turn off and Remove all held while a read runs; ConfirmRA focuses Cancel at mount, WidenConfirmRA keyed on the confirm value → a re-read's network remounts it; onWiden's guard while a check runs and the key read and met (2026-11-19T1305_sign-unconditional_2a9e)
    // C3 met: remote-access.jsx → requestRA the one fetch, PAGE_HEADERS_RA, no body; every Mac page call through it, the certificate a blob, never a plain link
    // C4 met: sign-in.html meta policy (default-src none; script, style, connect, form-action self; base-uri none), no inline script or style, no-referrer; sign-in.js one same-origin JSON POST to /api/remote/register, text through textContent only, fixed redirect to /; sign-in.css no url() or import; rows 106-108 signed for these facts only; frame-deny headers reach the page: response-headers.ts → FRAME_DENY_HEADERS applied in app.ts → registerSurface and remote/gate.ts → setRemoteHeaders (the remote root's onSend), the three files served by exact routes on that root (routes.ts → registerSignInFiles), read and met (2026-11-19T1305_sign-unconditional_2a9e)
    // C5 met: start.ts → RemoteAccessSwitch.#apply bounds the old listener's close and the new one's open through getWithin (5 s), #openWithin closes a late listener
    // C6 met: admin-routes.ts → getCertificate refuses anything but exactly one CA certificate, serves it re-encoded
    // C7 met: set_trust takes the shown network in fixed argv positions, format-checked, writes nothing on a differing read
    // C8 met: admin-routes.ts → widenAccess request row and a thrown act's error outcome row; page words (remote-access.jsx → getWidenErrorTextRA): act_failed, write_failed, env_not_rendered → state unknown, start_failed → applies at the next restart; after either the confirm closes and the page rereads, the words kept until a later act completes; read and met (2026-11-19T1305_sign-unconditional_2a9e)
    // confirm binding: start.ts → getConfirmFacts one-use value over 16 random bytes, #takeShown deletes before the freshness test; admin-routes.ts → runWideningAct one string header only
    // access marker: lib/ga-remote.sh → ga_remote_enable writes config first, then _ga_remote_set_access_on by temp file and rename
    cids: [
      SIGN_LAST_CID,
      CLOSE_CID,
      ONBOARDING_CID,
      OWNER_ROWS_CID,
      PENDING_COUNT_CID,
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 115,
    sha256: "7d37fe46bdd516c51cc2a9c1e0083619ff326af0e69e7c322d90fc0addade351",
    supersededBy: FRAGMENT_READ_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S7",
    // every row of the entry before it carried unchanged; the sign-in.js reason re-signed
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C1-C3 and C5-C8 carried from the entry before
    // C4 open: sign-in.js fragment read (2026-11-19T1520_steps-finish_d9a2) — one routine, at load and on a fragment change; the address replaced by the fixed page path before the value is tested, valid or not; the value kept only on an exact match of the code's length and alphabet (registration-code.ts → REGISTRATION_CODE), otherwise dropped silently; set as the code field's value only; no storage, cookie, title, log or history state; one same-origin JSON POST to /api/remote/register, sent by the form's submit alone; code field cleared on a code refusal; text through textContent only, fixed redirect to /; sign-in.html and sign-in.css byte-unchanged, their rows carried; met only once the built file is read
    cids: [
      FRAGMENT_READ_CID,
      SIGN_LAST_CID,
      CLOSE_CID,
      ONBOARDING_CID,
      OWNER_ROWS_CID,
      PENDING_COUNT_CID,
      DEVICES_RESIGN_CID,
      RESIGN_CID,
      "2026-11-15T0215_lan-unread-writes_a2f7",
      "2026-11-15T0216_lan-unread-reads_d90b",
      "2026-11-15T0240_lan-unread-reads-b_3fa6",
      "2026-11-15T0241_lan-unread-reads-c_7b29",
      "2026-11-14T1640_lan-route-classes_a93f",
      "2026-11-14T2145_lan-cli-channel_5f0c",
    ],
    rowCount: 115,
    sha256: "7d37fe46bdd516c51cc2a9c1e0083619ff326af0e69e7c322d90fc0addade351",
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
  { route: "GET /api/dashboard/update-status", cls: "page", reason: "page calls it; handler read: no caller input; returns versions, verdict and a fixed reason string; outbound check to the GitHub release API at most once per 15-minute cache window, a failed check cached too, never on a source tree" },
  { route: "POST /api/dashboard/update", cls: "page", reason: "page function, high-impact (self-update) kept page by owner decision; handler read: body must be mode=apply, no request value reaches the command or plist, single-active guard" },
  { route: "GET /api/dashboard/update-job", cls: "page", reason: "page calls it; handler read: latest update_job row only" },
  { route: "GET /api/architecture/live", cls: "page", reason: "page calls it; handler read: no caller input; five fixed database aggregates, six fixed hook files scanned once per process for a marker, rule-doc existence checks; returns install-relative doc names only" },
  { route: "GET /api/architecture/diagrams", cls: "page", reason: "page calls it; handler read: no caller input; static in-module diagrams assembled once per process; doc_path is a repo-relative constant" },
  { route: "GET /api/agents/success-rate", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, aggregate rows capped at 10000, database only" },
  { route: "GET /api/agents/revision-distribution", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, at most five buckets per registry agent" },
  { route: "GET /api/agents/review-flag-timeseries", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, one row per day of the window" },
  { route: "GET /api/agents/review-flag-by-agent", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, one aggregate row per registry agent" },
  { route: "GET /api/agents/failure-patterns", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, top 50 agents; returns up to five recorded concern texts per agent" },
  { route: "GET /api/agents/lifecycle-stats", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, one aggregate row per registry agent type" },
  { route: "GET /api/agents/summary", cls: "page", reason: "page calls it (agent docs too, over loopback); handler read: days 1-90, order from a fixed set, limit 1-50; three aggregates plus the registry file and per-agent breaker files at fixed paths; no local path returned" },
  { route: "GET /api/agents/latency", cls: "page", reason: "page calls it; handler read: days integer 1-30, one percentile aggregate per registry agent type" },
  { route: "GET /api/agents/failure-reasons", cls: "page", reason: "page calls it; handler read: agent bound as a parameter (1-64 chars), days 1-90, result fail or blocked; returns category counts only, no concern or hint text" },
  { route: "GET /api/agents/budget-overages", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, one aggregate row per agent type" },
  { route: "DELETE /api/agents/:name", cls: "page", reason: "page function, high-impact (agent delete) kept page by owner decision; handler read: name and typed confirm regex-gated, preview/commit modes, argv to the lifecycle CLI" },
  { route: "GET /api/cost/by-model", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, all other values bound, aggregate rows only" },
  { route: "GET /api/cost/cache-hit", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, one row per day of the window" },
  { route: "GET /api/cost/session-distribution", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, top 200 sessions by cost, returns session ids" },
  { route: "GET /api/cost/parse-errors", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, one row per day of the window" },
  { route: "GET /api/cost/turn-stats", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90, three aggregate queries" },
  { route: "GET /api/cost/kpi", cls: "page", reason: "page calls it; handler read: no caller input, one aggregate query scoped by the server-side agent registry" },
  { route: "GET /api/clauded-docs/search", cls: "page", reason: "page calls it; handler and SQL builder read: q trimmed to 500 chars and bound everywhere, limit 1-100, rows and count only; returns title, author, status and a body snippet, never the body path" },
  { route: "GET /api/clauded-docs/groups", cls: "page", reason: "page calls it; handler read: read-only group listing, parameters bound and clamped" },
  { route: "POST /api/clauded-docs/group", cls: "page", reason: "page calls it; handler read: member_ids validated as distinct positive integers (2+), bound statements set folder_id only, no file touched, reversible by ungroup" },
  { route: "POST /api/clauded-docs/ungroup", cls: "page", reason: "page calls it; handler read: member_ids validated, existence checked before the bound update, lone remaining member auto-ungrouped, no file touched" },
  { route: "PATCH /api/clauded-docs/group/:rootId/reorder", cls: "page", reason: "page calls it; handler read: integer rootId, ordered_ids must equal the group's member set, one bound update of display_order only" },
  { route: "PATCH /api/clauded-docs/:id/move-group", cls: "agent", reason: "no call site in public/, so not a page function; handler body unread" },
  { route: "POST /api/clauded-docs/html-export", cls: "page", reason: "page calls it; handler read: at most 50 integer ids, bound query, stored path checked against the docs root, sequential Chromium render into a zip" },
  { route: "GET /api/clauded-docs", cls: "page", reason: "page calls it (hooks too, over loopback); handler read: read-only listing, filters bound and clamped; rows carry the absolute body path" },
  { route: "POST /api/clauded-docs", cls: "agent", reason: "no page call site — only local agent sessions create documents; handler read: writes a body file and a row, HTML sanitized first" },
  { route: "GET /api/clauded-docs/:id/html-export", cls: "page", reason: "page calls it; handler read: the document sandbox policy set before anything else, so every answer carries it, not-modified and refusals included; id parsed, a refused id → 400; stored path checked against the docs root; ETag before the Chromium render; answered as an attachment with nosniff, the saved name built from the title's slug (a-z, 0-9, hyphen, Hangul, CJK only) through the shared attachment builder" },
  { route: "GET /api/clauded-docs/:id", cls: "page", reason: "page calls it (hooks too, over loopback); handler read: stored path checked against the docs root, agent-authored body returned inside a JSON envelope with a sandbox CSP header" },
  { route: "PUT /api/clauded-docs/:id", cls: "page", reason: "page function (local agents call it too, over loopback); handler read: body validated before any write, expected_hash compare-and-set, HTML sanitized, body path is the stored one or a server-built slug of the stored title, checked against the docs root; own body limit, see notes" },
  { route: "DELETE /api/clauded-docs/:id", cls: "page", reason: "page function, high-impact (hard delete of the row and its body file, not recoverable) kept page by owner decision; handler read: integer id, one bound delete, stored path checked against the docs root before the unlink" },
  { route: "GET /api/outcomes/search", cls: "page", reason: "page calls it (agent docs too, over loopback); handler and helpers read: every filter bound, sort from three fixed tokens, days 7/30/90/all, limit 1-200; returns summary, lesson cut to 200 chars, five concerns and five file paths per row" },
  { route: "GET /api/outcomes/cross-analysis", cls: "page", reason: "page calls it; handler and helpers read: same bound filters as search, counts only; nine queries per request, twelve with prior_window, each a sequential scan under a text filter — acceptable at the present table size, see notes" },
  { route: "GET /api/outcomes/heatmap", cls: "page", reason: "page calls it; handler read: days digits-only within 1-90, result from four fixed values, one aggregate query, counts only" },
  { route: "GET /api/outcomes/attribution-daily", cls: "page", reason: "page calls it; handler read: days must equal 7, 30 or 90 and is bound, at most three aggregate queries, counts and agent names only" },
  { route: "GET /api/outcomes/channel-liveness", cls: "page", reason: "page calls it (doctor CLI too, over loopback); handler read: days must equal 7, 30 or 90 and is bound, one aggregate query, channel names, counts and fixed thresholds" },
  { route: "PATCH /api/outcomes/close-by-cid", cls: "agent", reason: "called only by the outcome-recording hook, no page call site; handler read: closes every open row sharing a caller-named cid" },
  { route: "GET /api/outcomes/:id", cls: "page", reason: "page calls it; handler read: id bound as a bigint parameter, one row; returns body, lesson, correction hint and recorded file paths" },
  { route: "PATCH /api/outcomes/:id/close", cls: "page", reason: "page calls it; handler read: integer id, no body, one parameterized idempotent update" },
  { route: "POST /api/telemetry/activation", cls: "agent", reason: "called only by the telemetry hook, no page call site; handler read: validated parameterized insert, unaudited" },
  { route: "GET /api/telemetry/activations", cls: "page", reason: "page calls it; handler read: read-only list, parameters bound and range-checked" },
  { route: "GET /api/improvement", cls: "page", reason: "page calls it; handler and helpers read: unknown keys refused, limit 1-200, window 1-180 days, tier allowlisted, agent bound; returns proposal rationale, verify notes and target file name — no diff column is selected; eleven queries per request" },
  { route: "GET /api/improvement/stats", cls: "page", reason: "page calls it; handler read: no caller input, seven aggregate queries behind a 30-second process cache, counts only" },
  { route: "GET /api/improvement/learning-log", cls: "page", reason: "page calls it; handler read: limit 1-200 is the only input, eleven read-only queries; returns pattern signatures and transition reasons" },
  { route: "GET /api/improvement/loop-events", cls: "page", reason: "page calls it; handler read: limit 1-200 is the only input, three read-only queries; returns agent names, results and change counts" },
  { route: "GET /api/improvement/corpus-audits", cls: "page", reason: "page calls it; handler read: limit 1-200 is the only input, two read-only queries; returns corpus size and gate counts per cycle" },
  { route: "GET /api/improvement/correction-signals", cls: "page", reason: "page calls it; handler read: limit 1-200 is the only input, two read-only queries; returns match flags, task type and revision delta — no hint text" },
  { route: "POST /api/improvement/:id/approve", cls: "page", reason: "page function, high-impact (applies a proposal to a live agent body) kept page by owner decision; handler read: integer id only, fixed argv to the apply script" },
  { route: "POST /api/improvement/:id/reject", cls: "page", reason: "page calls it; handler read: integer id, one parameterized status update" },
  { route: "POST /api/improvement/:id/restore", cls: "agent", reason: "no call site in public/ although the owner's decision names restore as a page act; handler read: integer id, server-derived cycle id, argv to the update script — re-sign when the page calls it" },
  { route: "GET /api/wiki/summary", cls: "page", reason: "page calls it; handler read: no caller input, fixed aggregates over the daemon-run and note tables, no file or process access" },
  { route: "GET /api/wiki/cycles", cls: "page", reason: "page calls it; handler read: days checked against a fixed set of four before it reaches the interval, at most 90 daily rows, database only" },
  { route: "GET /api/wiki/index-metrics", cls: "page", reason: "page calls it; handler read: no caller input, three bounded database reads, no file or process access" },
  { route: "GET /api/wiki/backlog", cls: "page", reason: "page calls it; handler read: no caller input, newest 90 payload rows read and the newest one's dedup and dead-link slices returned as stored" },
  { route: "GET /api/model-config", cls: "page", reason: "page calls it; handler read: model ids, budget caps and tier values from the DB, daemon-config.json and agent model lines — no credential read" },
  { route: "PUT /api/model-config", cls: "page", reason: "page function, high-impact (model-config write) kept page by owner decision; handler read: validate-all-first against fixed keys, then rewrites daemon-config.json and agent model pins" },
  { route: "GET /api/queue/count", cls: "page", reason: "page calls it; route read: item counts only (behind the queue Host allowlist, see notes)" },
  { route: "POST /api/queue/sessions/register", cls: "agent", reason: "no page call site; called by scripts/lib/queue-session.sh only; no credential, registers whatever session and config directory the body names; work function not opened" },
  { route: "POST /api/queue/sessions/deregister", cls: "agent", reason: "no page call site; called by scripts/lib/queue-session.sh only; no credential, acts on whatever session id the body names; work function not opened" },
  { route: "POST /api/queue/items", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; a remote caller could post items to the owner as any session; work function not opened" },
  { route: "GET /api/queue/items/:id", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh and hooks/queue-turn-end-check.sh; returns the owner's answer to whoever names the session id; work function not opened" },
  { route: "POST /api/queue/pending", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; work function read: claims up to 20 of the named session's answered items per call, a wait poll refused unless the session is live for its pid; a remote caller could claim another session's answered items" },
  { route: "POST /api/queue/items/:id/ack", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; no credential beyond a named session id; work function not opened" },
  { route: "POST /api/queue/items/:id/withdraw", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; no credential beyond a named session id; work function not opened" },
  { route: "GET /api/queue/owner/items", cls: "page", reason: "page calls it; handler read: profile, session id, cursor and limit 1-200 validated and bound; returns each open item's title, body, options, the owner's answer text, image views and resume records, its session's absolute working and config directories and permission hint, plus the installed CLI path" },
  { route: "GET /api/queue/owner/items/:id", cls: "agent", reason: "no call site anywhere, so not a page function; route read: read-only owner view — flip to page if the page starts calling it" },
  { route: "GET /api/queue/owner/resumes", cls: "page", reason: "page calls it; handler read: limit 1-50 is the only input; returns the newest resume deliveries with attempt, result, abort reason and background id, each item's id and title, the session's profile label and directory tail" },
  { route: "GET /api/queue/owner/orders", cls: "page", reason: "page calls it; route read: read-only order history, query schema-validated" },
  { route: "POST /api/queue/owner/items/:id/answer", cls: "page", reason: "page function, high-impact kept page by owner decision: the answer counts as the owner's word, approvals included, and for an ended session the sweep starts a local claude process to deliver it; handlers read: option code R1-R9 and one of the item's own, free text only where the item allows it, at most 20000 chars, bound writes only; the resumed process takes its session id, directory and config directory from the registry row and a fixed text naming item and message ids, never the answer; page-origin stamp required and recorded" },
  { route: "POST /api/queue/owner/items/:id/reply", cls: "page", reason: "page function, high-impact kept page by owner decision: the reply counts as the owner's word and for an ended session the sweep starts a local claude process to deliver it; handlers read: open report that allows a reply, text at most 20000 chars, up to 8 image ids of unused uploads from the last day, bound writes only; no value reaches the resume command, directory, environment or text; page-origin stamp required and recorded" },
  { route: "GET /api/queue/owner/sessions", cls: "page", reason: "page calls it; handler read: optional profile filter bound, at most 200 rows; returns full session ids, names, profile labels, absolute working directories, state and exit reason, waiting flag, item counts and the resume marker time" },
  { route: "POST /api/queue/owner/messages/send", cls: "page", reason: "page function, high-impact kept page by owner decision: one owner message per target, up to 20 registered sessions, and for each ended target the sweep starts a local claude process to deliver it; handlers read: session ids must be UUIDs of registered rows not replaced, text at most 20000 chars, up to 8 image ids of unused uploads from the last day, bound writes only; no value reaches the resume command, directory, environment or text; page-origin stamp required and recorded" },
  { route: "POST /api/queue/owner/images", cls: "page", reason: "page function, high-impact (file write) kept page by owner decision; route and store read: type and size from the bytes alone (PNG, JPEG, WebP, GIF), 10 MiB route cap, server-made UUID file name in the queue image folder, caller name stored as a label only" },
  { route: "GET /api/queue/owner/images/:id", cls: "page", reason: "page calls it; route read: serves image bytes with nosniff, same-origin resource policy and a sandbox CSP" },
  { route: "POST /api/queue/owner/items/:id/later", cls: "page", reason: "page calls it; route read: item status transition, empty body schema" },
  { route: "POST /api/queue/owner/items/:id/seen", cls: "page", reason: "page calls it; route read: item status transition, empty body schema" },
  { route: "POST /api/queue/owner/items/:id/resend", cls: "page", reason: "page function, high-impact kept page by owner decision: re-queues one delivery and, for an ended session, lets the sweep start a local claude process again; handler read: empty body, only an unacked or expired item or a resume-pending one whose attempt is used, refused while the session's earlier resume has not registered; no caller text" },
  { route: "POST /api/remote/registration", cls: "remote-admin", reason: "loopback only; Sec-Fetch-Site exactly same-origin, the fixed page header only the page's own script sets, empty body, open-rate limit; audit row before the code, no row → no code; code in this response body only, no-store" },
  { route: "GET /api/remote/devices", cls: "remote-admin", reason: "loopback only; same Sec-Fetch-Site and page-header rule although a GET; devices: id, label, created, last seen only, nothing else; no-store" },
  { route: "DELETE /api/remote/devices/:id", cls: "remote-admin", reason: "loopback only; same rule, decimal id, no body; remote.revoke after the revoke, audit failure never blocks it; one device_not_found" },
  { route: "POST /api/remote/devices/revoke-all", cls: "remote-admin", reason: "loopback only; same rule, empty body; remote.revoke with the count only" },
  { route: "POST /api/remote/register", cls: "remote-pre-auth", reason: "remote only; remote Host, pre-auth limit, page-origin signal, 3/min/address and 10/min total before body parse, 1 KiB strict schema; one opaque refusal" },
  { route: "GET /api/remote/session", cls: "remote-device", reason: "remote only; the caller's CSRF value, id and label only; fetch metadata, when present, same-origin; no-store" },
  { route: "POST /api/remote/logout", cls: "remote-device", reason: "remote only; page origin + CSRF, empty body; revokes the gate's admitted device only; one Set-Cookie expiring it" },
  { route: "POST /api/remote/off", cls: "remote-device", reason: "remote only; page origin + CSRF, empty body; revokes every device, caller included, and closes the listener even on a failed revoke or audit" },
  { route: "GET /api/remote/cli/devices", cls: "remote-cli", reason: "loopback only; fixed CLI header, no fetch metadata, Origin, Referer or Cookie, loopback Host and socket, rate limit, no-store; remote.devices_listed as the CLI; id, label, created, last seen only" },
  { route: "DELETE /api/remote/cli/devices/:id", cls: "remote-cli", reason: "loopback only; same gate, decimal id, no body; the page's revoke act (sockets closed) audited as the CLI; one device_not_found" },
  { route: "POST /api/remote/cli/devices/revoke-all", cls: "remote-cli", reason: "loopback only; same gate, empty body; the page's revoke-all act audited as the CLI; the count only" },
  { route: "GET /sign-in.html", cls: "remote-pre-auth", reason: "remote only; exact route from a fixed three-file list, GET and its HEAD; Host and failed-session block first, pre-auth limit on every hit; frame denial, HSTS, nosniff, no-cache; meta CSP as written, links only /sign-in.css and /sign-in.js" },
  { route: "GET /sign-in.js", cls: "remote-pre-auth", reason: "remote only; exact route from a fixed three-file list, GET and its HEAD; Host and failed-session block first, pre-auth limit on every hit; frame denial, HSTS, nosniff, no-cache; the sign-in form's script, names no feature; reads one thing from the address, the fragment's one fixed key: the fragment is removed at once by replacing the history entry, the value kept only when it is exactly the code's length and alphabet, set as the code field's value and nowhere else, never stored, logged or sent except in the register POST body the person's press sends; no query read, no auto-submit" },
  { route: "GET /sign-in.css", cls: "remote-pre-auth", reason: "remote only; exact route from a fixed three-file list, GET and its HEAD; Host and failed-session block first, pre-auth limit on every hit; frame denial, HSTS, nosniff, no-cache; self-contained, the shared stylesheets stay behind registration" },
  { route: "POST /api/queue/pending/count", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh (listen step, run by hooks/queue-listener.sh) only; handler read: strict session id and pid body, refused unless the named session is live for that pid, returns the count and first 200 ids of that session's answered items, claims nothing, marks the session waiting in memory for 10 s; no credential beyond a named session id and pid" },
  { route: "POST /api/remote/access/on", cls: "remote-admin", reason: "loopback only; Mac page gate: root Host allowlist, Sec-Fetch-Site exactly same-origin, the fixed page header only the page's own script sets, empty body; 5/min shared with trust, refused 409 while any access act runs; remote.access_requested row before any step, naming that a trust of the network shown may follow, no row → no step; refused unless the confirm value in the x-glass-atrium-confirm header names a read no more than 120 s old, unused, that showed the network read at the act; one read per act; fixed-argv write step, no request value, then this process reopens the listener from the settings the step rendered, the old listener's close and the new one's open each waiting at most 5 s, a failed or timed-out apply answers start_failed and reopens nothing until restart; trusts only the network shown, only when not yet trusted, re-matched before that step; the trust step takes the shown network in fixed argv positions, format-checked, reads the network itself and writes nothing when it differs; outcome rows carry outcome and trusted count only, an act that throws still gets its error outcome row; page-origin stamp recorded, not a check" },
  { route: "POST /api/remote/access/off", cls: "remote-admin", reason: "loopback only; same Mac page gate, empty body; reduce-only, its own path, never the device's POST /api/remote/off; 10/min own budget, queued behind an act in flight, never refused for one; request row tried first, its failure never stops the off; persists off through the fixed-argv step, revokes every device through the shared revoke-all act (sockets closed), closes the listener, each step running when another fails or stalls: the request row, the revoke and the close each wait at most 5 s, the persist its own step timeout, a timed-out step counted as failed; a persist that did not write also writes the device-off marker, so a restart stays off; remote.access_disabled with the count and the failed steps; a failed step → 500 naming it" },
  { route: "POST /api/remote/access/trust", cls: "remote-admin", reason: "loopback only; same Mac page gate, empty body; limit and single-flight shared with on; remote.access_requested row before any step, no row → no step; refused unless the confirm value in the x-glass-atrium-confirm header names a read no more than 120 s old, unused, that showed the network read at the act; one read per act; fixed-argv write step takes the shown network in fixed argv positions, format-checked, no request value, reads the network itself and writes nothing when it differs; changes the trusted list only, never enabled, never the access-state file; reopens the listener only when access is already on and no device off holds, its close and open each waiting at most 5 s; already trusted → 409, nothing written; remote.network_trusted with outcome and trusted count only, an act that throws still gets its error outcome row" },
  { route: "GET /api/remote/access/network", cls: "remote-admin", reason: "loopback only; same Mac page gate although a GET, and its HEAD; 20/min; no caller input; runs the fixed network reads; returns the router address the server read, the link kind (wifi, wired, unknown), whether this network is trusted and a one-use confirm value, no hardware address, no interface; the one response that carries a gateway address, for the confirm only; keeps the identity it read under that value in process memory, an entry past 120 s never honoured and dropped at the next read → an on or trust carrying that value acts on that network or refuses; no audit row; no-store" },
  { route: "GET /api/remote/setup", cls: "remote-admin", reason: "loopback only; same Mac page gate although a GET, and its HEAD; 60/min, overlapping reads share one run of the network commands; no caller input; field by field: on in effect (on in config and no device off), off by a device, listen reason of that effective state, router read or not, this network trusted or not, trusted count, answering or not, the .local name, the interface address, the remote port, the device limit, the CA fingerprint (SHA-256 over the encoded certificate the download serves); no gateway or hardware address, no key path; writes nothing; no-store" },
  { route: "GET /api/remote/certificate", cls: "remote-admin", reason: "loopback only; same Mac page gate although a GET, and its HEAD; 10/min; no caller input; one constant file, the public CA certificate in the fixed data dir, no other file read; 404 when missing, holding a private key marker, or anything but exactly one CA certificate; served re-encoded from the parsed certificate, the same certificate the fingerprint covers, as an attachment with a fixed name and type; no-store" },
];

/** `METHOD /path` keys the remote gate answers without a registered device → only rows the reviewer classed remote-pre-auth. */
export const REMOTE_PRE_AUTH_ROUTES: ReadonlySet<string> = new Set(
  REVIEWED_ROUTES.filter((entry) => entry.cls === "remote-pre-auth").map((entry) => entry.route),
);

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
