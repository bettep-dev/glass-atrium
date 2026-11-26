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
// peers, relay, relay-signal and redact appended after row 109 of its own 113-row table, six reasons re-signed in place (route-rows-verdict.md)
// → here those four rows sit after row 115, so its 113-row digest is not a prefix of this table
const RELAY_ROWS_CID = "2026-11-17T1135_queue-mcp-2_e5f8";
// the access, setup and certificate reasons re-signed in place (route-rows-resign-verdict.md): route, class and order kept → same digest
const CLOSE_CID = "2026-11-19T0700_onboarding-close_8e2d";
// the on, trust, network-read and single html-export reasons re-signed in place (route-rows-sign-last-verdict.md): route, class and order kept → same digest
const SIGN_LAST_CID = "2026-11-19T0945_onboarding-close2_5b7c";
// the last re-sign's confirm, frame-deny and page-words points read and met (sign-unconditional verdict): no row changed
const UNCONDITIONAL_CID = "2026-11-19T1305_sign-unconditional_2a9e";
// the relay rows appended after row 115, the relay-signal and redact reasons re-signed as they stand (merged-table-verdict.md)
const MERGE_CID = "2026-11-19T1325_deploy69-prep_a6e3";
// the sign-in.js reason re-signed in place for its fragment read (steps-review-items.json → A10, A11): route, class and order kept → same digest
const FRAGMENT_READ_CID = "2026-11-19T1520_steps-finish_d9a2";
// the built sign-in.js read for the fragment read (c4-built-read verdict), read and met: no row changed
const BUILT_READ_CID = "2026-11-19T1640_steps-close_a1c7";
// the merged 119-row table signed with the fragment-read sign-in.js reason (merged-signoffs-verdict.md): no row changed
const FULL_TABLE_CID = "2026-11-19T1755_deploy70-prep_f1a8";
// the orders reason re-signed in place for the item thread (history-route-verdict.md): route, class and order kept → same digest
const ITEM_THREAD_CID = "2026-11-19T2050_queue-tidy_d81b";
// the owner-list and orders reasons re-signed in place for the relay row (relay-row-verdict.md): route, class and order kept → same digest
// same string as ITEM_THREAD_CID → the item-thread entry's supersededBy reads as its own first CID
const RELAY_ROW_CID = "2026-11-19T2050_queue-tidy_d81b";
// the changed sign-in.css re-read and the relay row's page rendering read on the merged tree (merged-signoffs-verdict.md): no row changed
const MERGED_TREE_CID = "2026-11-20T0000_deploy71-prep_c47e";
// the model-config GET and PUT reasons re-signed in place and PUT /api/model-config/agents appended as row 120 (route-sign-verdict.md) → the 119-row digest still verifies as its prefix
const MODELS_SERVER_CID = "2026-11-20T1030_models-server_9c2e";
// PUT /api/model-config/agents re-classed agent → page in place, its reason re-signed, once the Models screen calls it (route-page-sign-verdict.md): route and order kept
const MODELS_SCREEN_CID = "2026-11-20T1255_models-screen2_7e41";
// the answer and image-upload reasons re-signed in place for images on a decision's answer (answer-routes-sign-verdict.md): route, class and order kept → same digest
const ANSWER_IMAGES_CID = "2026-11-23T1845_queue-batch2-server_6e0b";
// the GET /api/queue/items/:id reason re-signed in place for its absolute image paths (image-path-rows-verdict.md): route, class and order kept → same digest
const IMAGE_PATH_ROWS_CID = "2026-11-23T2100_queue-batch2-page_4a7c";
// GET /api/queue/owner/relays/signal removed with its route and the orders reason re-signed for its Done-part callers (route-class-verdict.md) → the 120-row digest is history
const SIGNAL_REMOVAL_CID = "2026-11-25T1530_qb3-server_5e2a";
// the scan-approval register, consume and owner-read rows appended after row 119 (route-class-verdict.md, parts A and B) → the 119-row digest still verifies as its prefix
const SCAN_APPROVAL_CID = "2026-11-26T1135_sa-verdict-a_1c7e";
const SCAN_APPROVAL_B_CID = "2026-11-26T1135_sa-verdict-b_9a02";

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
    stream: "S6",
    // every row of the entry before it carried unchanged, C1-C3 included; peers, relay, relay-signal and redact appended; six queue reasons re-signed
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // R1 the session-only guard counts Origin, Referer, any Sec-Fetch header and Cookie; a refused peers or relay request runs no handler query, no scan, stores no relay row
    // R2 the signal and redact rows are page on the plan's word that the Queue page calls both → no remote access for a build without those call sites; a dropped one is re-classed agent
    // R3 the redaction audit row names the relay id; an accepted relay's audit row holds no relay text; after a redaction the text is in no table
    // R4 the updated_at a redaction bumps is read by no delivery deadline, lapse clock or sweep rule for a relay
    // R5 the page shows relay text and the self-declared name as text only, never markup, and labels the name self-declared
    cids: [
      RELAY_ROWS_CID,
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
    rowCount: 113,
    sha256: "795839947a232258b4eef1ddda2792ab252f8b300c7e63ba416af17b849924c4",
    supersededBy: MERGE_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S4",
    // every row of the owner-rows entry carried unchanged; the Mac page's access, setup and certificate rows 110-115 appended;
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
    supersededBy: MERGE_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S7",
    // rows 1-115 carried from the entry before it: route, class and order unchanged (its digest verifies as this table's prefix);
    // rows 116-119 the relay entry's rows 110-113, same classes (agent, agent, page, page)
    // reasons: 74, 75, 82, 83, 85, 94, 116 and 117 the relay verdict's signed texts; 118 and 119 re-signed as they stand
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // owner-rows C1-C3 carried
    // C1-C8 of the entry before it met: C2, C4 and C8 read and met by the unconditional verdict; C4's frame-deny header use re-read: app.ts → registerSurface, remote/gate.ts → setRemoteHeaders; the page files not re-read in this table
    // R1 counting met: request-guards.ts → hasBrowserSignal (Origin, Referer, Cookie, any sec-fetch- header); wiring on the tests' word, not read by the reviewer:
    // routes/queue.ts → refuseBrowserRequest, the route onRequest of peers and relay; on buildApp for both, a loopback Origin on another port → 403, no handler query, scan or relay row;
    // header-less JSON passes, a same-origin form → 415, a foreign Origin → 403; source: queue MCP security verdicts 2026-11-16T2215_queue-mcp-sec_7a4c and 2026-11-16T2330_queue-mcp-sec-delta_1e9d (condition 8)
    // R2 met for call sites: queue.jsx → useRelaySignalQ, putRelayRedactionQ
    // R3, R4, R5 carried, not re-read
    // session-route callers send JSON: the ops library, the JSON-RPC adapter and the CLI post through queue-ops.sh → queue_call_monitor → queue_send, JSON content type with every body
    // reachability (remote/gate.ts → admitDevice): peers and relay never reachable remotely (401 without a device, 403 route_not_available with one);
    // the relay signal and redact reachable by a registered device behind page origin, the CSRF header, the mutation limit and the audit intent row
    cids: [
      MERGE_CID,
      UNCONDITIONAL_CID,
      SIGN_LAST_CID,
      RELAY_ROWS_CID,
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
    rowCount: 119,
    sha256: "2cc9a6d9344907ac72b66d563d028258452a6c2b9a857ed00893d131a3dbc8a6",
    supersededBy: FRAGMENT_READ_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S7",
    // every row of the entry before it carried unchanged; the sign-in.js reason re-signed
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C1-C3 and C5-C8 carried from the entry before
    // C4 met: sign-in.js fragment read, built file read (2026-11-19T1640_steps-close_a1c7) — sign-in.js → readFragment the one address read, location.hash only, at load and on hashchange; history.replaceState(null, "", FRAGMENT.PAGE_PATH) before the value is tested, valid or not; isCode keeps exactly CODE.LENGTH symbols of CODE.ALPHABET after the fixed "#code=", no decoding (equal to registration-code.ts → REGISTRATION_CODE as read, bound by remote-sign-in.e2e), otherwise dropped silently; set as fields.code.value only; no storage, cookie, title, log, timer or history state; send the one same-origin JSON POST to REGISTER_URL, from the form's submit alone, an empty code or name stopped before it; register clears the code field on REFUSALS.registration_refused; showLead writes one of two fixed LEAD texts, every text through textContent, fixed redirect to /; remote-access.jsx → CodeViewRA gives QrCodeRA the address + SIGN_IN_RA + code only while a code is open; routes.ts → register and gate.ts → recordEvent pass actor, action kind, result, method, route and the new device's id only, no log line or audit row takes the body; sign-in.html and sign-in.css byte-unchanged (diff relayed, sign-in.html read), their rows carried; residual: the test rows read, not run by the reviewer; the audit writer's own file and the listener's logger options unread; a change to any of the three sign-in files needs a new read
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
    supersededBy: FULL_TABLE_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S7",
    // rows 1-115: route, class and order as the fragment-read entry signed them (its 115-row digest verifies as this table's prefix);
    // rows 116-119 as the merge entry signed them (agent, agent, page, page)
    // reasons: row 107 the fragment-read verdict's A10 text; every other reason as the merge entry states it
    // the fragment-read entry's "entry before it" is the SIGN_LAST_CID entry, a 115-row table → it never covered rows 116-119 or R1-R5, which come from the merge entry
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // owner-rows C1-C3 carried
    // C1-C3 and C5-C8 met, carried from the SIGN_LAST_CID entry and the unconditional verdict
    // C4 met as the fragment-read entry's line states it, replacing the merge entry's C4 (sign-in.js signed for one POST, textContent and the fixed redirect only);
    // residual: the test rows read, not run, their run's output not shown to the reviewer; the audit writer's own file and the listener's logger options unread;
    // what a phone browser or scanner keeps of a scanned address unverified on a device; the built file read in the branch worktree, in the merged tree only searched;
    // a change to any of the three sign-in files needs a new read
    // R1 counting met, carried: request-guards.ts → hasBrowserSignal (Origin, Referer, Cookie, any sec-fetch- header); wiring seen by search: routes/queue.ts → refuseBrowserRequest
    // calls hasBrowserSignal on the request headers and passes a request without one, SESSION_ONLY_ROUTE_OPTIONS sets it as the route onRequest;
    // on the tests' word, not read by the reviewer: POST /api/queue/peers and POST /api/queue/relay registered with SESSION_ONLY_ROUTE_OPTIONS, the 403 reply itself,
    // a loopback Origin on another port → 403 with no handler query, scan or relay row, header-less JSON passes, a same-origin form → 415, a foreign Origin → 403
    // R2 met for call sites: queue.jsx → useRelaySignalQ, putRelayRedactionQ
    // R3, R4, R5 carried, not re-read
    // session-route callers send JSON on the developer's check, not read by the reviewer: the ops library, the JSON-RPC adapter and the CLI post through
    // queue-ops.sh → queue_call_monitor → queue_send, JSON content type with every body
    // reachability (remote/gate.ts → admitDevice), carried, not re-read: peers and relay never reachable remotely (401 without a device, 403 route_not_available with one);
    // the relay signal and redact reachable by a registered device behind page origin, the CSRF header, the mutation limit and the audit intent row
    cids: [
      FULL_TABLE_CID,
      FRAGMENT_READ_CID,
      BUILT_READ_CID,
      MERGE_CID,
      UNCONDITIONAL_CID,
      SIGN_LAST_CID,
      RELAY_ROWS_CID,
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
    rowCount: 119,
    sha256: "2cc9a6d9344907ac72b66d563d028258452a6c2b9a857ed00893d131a3dbc8a6",
    supersededBy: ITEM_THREAD_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // every row of the entry before it carried unchanged, its conditions included; the GET /api/queue/owner/orders reason re-signed for the item thread
    // the order and relay clauses carried from the earlier sign-offs, except the sender directory tail, read in owner-views.ts → toRelaySender
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C1 the item thread keeps owner-views.ts → NOT_PROBE_ITEM_FILTER
    // C2 schemas.ts → ORDER_PAGE_LIMIT.MAX stays at most 100; no decision or report write sets a send id (only owner-sessions.ts → createMessages and relay.ts make one)
    // C3 the item thread returns the view built by owner-views.ts → toView, shared with the owner list → a field added for this thread only needs a new sign-off
    // C4 the route writes nothing
    cids: [
      ITEM_THREAD_CID,
      FULL_TABLE_CID,
      FRAGMENT_READ_CID,
      BUILT_READ_CID,
      MERGE_CID,
      UNCONDITIONAL_CID,
      SIGN_LAST_CID,
      RELAY_ROWS_CID,
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
    rowCount: 119,
    sha256: "2cc9a6d9344907ac72b66d563d028258452a6c2b9a857ed00893d131a3dbc8a6",
    supersededBy: RELAY_ROW_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // every row of the entry before it carried unchanged in route, class and order; C1-C4 of the item-thread entry carried
    // the GET /api/queue/owner/items reason re-signed for the relay row; the GET /api/queue/owner/orders reason re-signed for the probe filter on every thread (narrowing only)
    // read at this sign-off: owner-views.ts → getOwnerItems, toView, getRelayFacts, toRelaySender, toSessionView, getOrderCopyRows; relay.ts whole; registry.ts → TERMINAL
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // Q1 getOwnerItems keeps relayRedactedAt: null and session: { isProbe: false }
    // Q2 the list returns the view built by toView, shared with the relay thread, and that view carries no transcript path → a relay field added for the list only needs a new sign-off
    // Q3 the orders route stays class page and its relay thread keeps returning every relay to a non-probe recipient in every state → narrowing it voids the "nothing the thread does not return" clause
    // Q4 open, not read: the page script's open-list rendering of a relay row (peer-written text, self-declared name) against R5 (text only, never markup, name labelled self-declared)
    // carried, not re-read: the route handler and query schema (limit 1-200, the installed CLI path), remote/gate.ts (same reader for both page rows), commits f18c790e, 54c7aacf, 25bc6c2e and the builder's before-state claim
    cids: [
      RELAY_ROW_CID,
      ITEM_THREAD_CID,
      FULL_TABLE_CID,
      FRAGMENT_READ_CID,
      BUILT_READ_CID,
      MERGE_CID,
      UNCONDITIONAL_CID,
      SIGN_LAST_CID,
      RELAY_ROWS_CID,
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
    rowCount: 119,
    sha256: "2cc9a6d9344907ac72b66d563d028258452a6c2b9a857ed00893d131a3dbc8a6",
    supersededBy: MERGED_TREE_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // every row of the entry before it carried unchanged in route, class, order and reason; its conditions carried, Q1-Q3 included
    // conditions of this sign-off — a change that breaks one needs a new sign-off:
    // C4 re-read for sign-in.css as changed, read whole in the merged tree: against the live source one declaration added, `.section-label` → `margin: 0`;
    // no url(), @import, @font-face, image or content value, fonts by family name only; display flex or inline-flex only;
    // no visibility, position, transform, clip, overflow, order, z-index, pointer-events or text-indent rule; the one opacity 0.5 on a disabled or aria-disabled `.btn`;
    // `.sign-in-status` a reserved line, `.is-error` changes colour only; the added declaration matches the Connection warning heading alone, below the form
    // → the code field, the device-name field and the refusal line neither hidden nor moved;
    // sign-in.html and sign-in.js read whole in the merged tree, as the FULL_TABLE_CID entry's C4 line states them; their byte-equality to the live source
    // (equal blob ids at 5b6f52ea and ad902e57, merge-record.md) not shown to the reviewer; a change to any of the three sign-in files needs a new read
    // Q4 met at integration/deploy-71, as read in monitor/public/src/screens/queue.jsx: the relay row (name column and its tooltip, title cell when the name column is left out, aria-label),
    // the sheet head (LetterheadQ), the sheet title and the From line (RelayWhoQ) all name the sender through getSenderLabelQ:
    // a self-given name reads `<name> (self-named)`, an unnamed sender reads its id prefix unmarked;
    // the sheet's text is one text node through OrderBubbleQ isPlain with nothing parsed; queue.jsx contains no innerHTML or dangerouslySetInnerHTML;
    // a redacted relay shows the redaction line and never its stored title; read-only: no test run, commits 236888b2 and a7d0925a not checked
    // residual, not blocking: the sheet's "What <name> wrote" and "<name>'s message" sentences and RelayHopLineQ use the bare name from getSenderNameQ
    cids: [
      MERGED_TREE_CID,
      RELAY_ROW_CID,
      ITEM_THREAD_CID,
      FULL_TABLE_CID,
      FRAGMENT_READ_CID,
      BUILT_READ_CID,
      MERGE_CID,
      UNCONDITIONAL_CID,
      SIGN_LAST_CID,
      RELAY_ROWS_CID,
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
    rowCount: 119,
    sha256: "2cc9a6d9344907ac72b66d563d028258452a6c2b9a857ed00893d131a3dbc8a6",
    supersededBy: MODELS_SERVER_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S4",
    // every earlier row carried unchanged; the GET and PUT /api/model-config reasons re-signed in place (route, class and order kept, so the earlier digest still verifies as a prefix);
    // PUT /api/model-config/agents appended, class agent: the reviewer's limit on that row (page only once the Models screen calls it) applied — no call site in public/ at this sign-off
    // conditions of this sign-off — a later change that breaks one needs a new sign-off:
    // M1 a request name only selects an entry of the server's own folder list, only a listed file name reaches a path, and the realpath is re-checked directly inside the agents folder at write time
    // M2 the model is 'inherit' or an exact pricing-roster member and an empty roster refuses
    // M3 the body schema stays strict at both levels, the write changes one model line with the before/after comparison and the re-read before the rename, two model lines refuse,
    // a pin differing from the one the page showed is left
    // M4 the route stays in AWAITED_INTENT_ROUTES and the remote gate keeps its awaited intent, no row means the handler never runs, and the row target carries names, cut pins, status and the signal, never the body
    // M5 the route keeps its own window limit and page-origin hook and the remote gate keeps page origin plus CSRF and the device mutation limit ahead of it
    // M6 the daemon-apply lock refusal, the name cap and the in-flight refusal stay
    // M7 PUT /api/model-config writes no agent file and no other route writes an agent model line
    // M8 the GET returns no path and no body text, the description stays cut and the pin stays cut to the id pattern
    cids: [MODELS_SERVER_CID],
    rowCount: 120,
    sha256: "38fd87db9eea6512dbedfc059638dfa49224b5632aa0fd6214b77b8a18a7547f",
    supersededBy: MODELS_SCREEN_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S4",
    // every earlier row carried unchanged in route, class and order, so the 119-row digest still verifies as a prefix;
    // row 120 PUT /api/model-config/agents re-classed agent → page with its reason re-signed, on the page call site read in public/src/screens/model-config.jsx
    // (putAgentPinsMC, getAgentApplyBodyMC, Apply press only); the call goes through the remote page's fetch wrapper (ui.jsx → installRemoteFetch), which sets the CSRF header on every same-origin mutation, as for the Save PUT
    // 'kept page by owner decision' carried by reference to the signed 'PUT /api/model-config' and 'POST /api/improvement/:id/approve' rows — the owner's words not read by the reviewer
    // M1-M8 of the entry before it carried unchanged; added conditions — a later change that breaks one needs a new sign-off:
    // M9 the page sends the Apply only on an explicit press, with exactly model plus agents[name, expected_pin], never from a load, an effect or a timer
    // M10 the screen renders file names, role lines, pins and reasons from the GET and the PUT answer as text only
    // M11 the limit and the in-flight refusal stay shared by both listeners
    // accepted residuals: R1 the daemon-apply lock is tested once as the apply starts, not per file;
    // R2 each agent's old and new pin reaches the audit row only on the close, which is best-effort, so a failed close leaves an intent row naming no file
    cids: [MODELS_SCREEN_CID],
    rowCount: 120,
    sha256: "d1fd15c26c6a43165056170d9c596c7bd6ec930f1b2b60340bdd484469829db4",
    supersededBy: ANSWER_IMAGES_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // every earlier row carried unchanged in route, class and order, so the 120-row digest of the entry before it still verifies;
    // the POST /api/queue/owner/items/:id/answer and POST /api/queue/owner/images reasons re-signed in place;
    // the GET /api/queue/owner/items and GET /api/queue/owner/orders reasons carried verbatim, their image-view clauses covering a decision answer's images;
    // the POST /api/queue/pending reason carried as signed: its work function (getClaimViews over claimPendingItems) returns item and message ids and source facts only,
    // no image id or path — a linked image's absolute path reaches a session through GET /api/queue/items/:id (getItemOrThrow → getSessionImageViews)
    // conditions of this sign-off — a later change that breaks one needs a new sign-off:
    // Q1 the answer's images are taken only where free text is allowed and with a code or text, at most 8 unique UUIDs of unused uploads from the last day,
    // claimed in one transaction with the answer; a failed claim or lost race records and links nothing
    // Q2 no image id, path or byte reaches the resume command, directory, environment or text
    // Q3 the delivery statement for images is composed only in scripts/lib/queue-ops.sh queue_get_provenance, gated on the attachment count alone and never on text,
    // and reached by CLI get, CLI claim and MCP claim alike (atrium-queue-mcp.sh call_claim → queue_claim_items → queue_claim_each → queue_claim_item → queue_get_item → queue_print_item_result → queue_get_provenance)
    // Q4 the clause 'what this approval covers is fixed by the item's text and the chosen option alone' stays on the approval branch only,
    // and the reference-material clause stands on every answer branch that carries images
    // Q5 C-approval-line unchanged: the approval sentence keeps its fixed line whatever the tray does
    // Q6 the upload pixel bound is checked before any write
    // Q7 the owner list and the orders thread return image views, never absolute paths
    // Q8 the image GET keeps nosniff, same-origin resource policy and the sandbox CSP
    // open until the page is built: the composer tray on an approval-class decision under the same rule as any decision, and the answered sheet showing the same images the session received
    cids: [ANSWER_IMAGES_CID],
    rowCount: 120,
    sha256: "d1fd15c26c6a43165056170d9c596c7bd6ec930f1b2b60340bdd484469829db4",
    supersededBy: IMAGE_PATH_ROWS_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S2",
    // every earlier row carried unchanged in route, class and order, so the 120-row digest of the entry before it still verifies;
    // the GET /api/queue/items/:id reason re-signed in place on its work function, read here (getItemOrThrow → getSessionImageViews), naming the absolute image paths, an answer's images among them;
    // the POST /api/queue/pending reason carried as signed, since its claim view selects item id, kind and sender only
    // Q1-Q8 of the entry before it carried unchanged; added conditions — a later change that breaks one needs a new sign-off:
    // G1 getItemOrThrow keeps the session id in its lookup and answers another session's item the same as a missing one
    // G2 the pending claim view carries no image id, path or byte
    // G3 every image path is built through the one builder that checks it stays inside the image folder
    cids: [IMAGE_PATH_ROWS_CID],
    rowCount: 120,
    sha256: "d1fd15c26c6a43165056170d9c596c7bd6ec930f1b2b60340bdd484469829db4",
    supersededBy: SIGNAL_REMOVAL_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S5",
    // row 118 GET /api/queue/owner/relays/signal removed with its route, not re-classed (R2 needs a live route to re-class); every other row carried unchanged in route, class and order, so the 115-row ACCESS_TABLE prefix still verifies and the 119-row MERGED_TABLE becomes history
    // the GET /api/queue/owner/orders reason re-signed for its Done-part callers (kind item and kind relay), its fields unchanged; Q1-Q8 and G1-G3 carried unchanged; R2 carried for the redact row only
    // conditions of this sign-off — a later change that breaks one needs a new sign-off:
    // S-a met: the signal route removed, no page source calls it, and C20 (the 24-hour signal) retired with it
    // S-b met: the orders reason names its three threads (kind order, and kind item with the profile filter and kind relay for the one Queue list's Done part)
    // S-c met: RELAY_NO_LOGIN_Q drawn in RelayBlockQ and RefusedSheetQ
    // R2 met for the redact row's call site: queue.jsx → putRelayRedactionQ, sent from useRelayRedactionQ's confirm, asked by RelayFootQ's Redact text on the relay sheet; a dropped call site re-classes the row agent
    // the redact row's own reason read: it names no caller beyond the page function, so it stands as signed
    cids: [SIGNAL_REMOVAL_CID],
    rowCount: 119,
    sha256: "a67d39760625054c89ca4100a4e50e016dc7794ddb5d9ecc97d28e27afc68719",
    supersededBy: SCAN_APPROVAL_CID,
  },
  {
    reviewer: "glass-atrium-sec-guard",
    stream: "S5",
    // every earlier row carried unchanged in route, class and order, so the 119-row digest of the entry before it still verifies;
    // rows 120-122 appended: POST /api/queue/scan-approvals and POST /api/queue/scan-approvals/consume class agent, GET /api/queue/owner/items/:id/scan-approval class page (queue item 480)
    // reasons written as the two reads gave them: rows 120-121 with their corrected last clauses (part A 1-2), row 122 (part B 1), the POST /api/queue/items secret-approval clause (part B 2),
    // the POST /api/queue/owner/items/:id/answer residual sentence appended (part A 4); the owner-list, orders and session item-post rows signed as written (part A 3)
    // one character differs from the verdict: row 122's colon after "a real secret" is written as a dash, since the secret-scan hook's SEC-013 rule refuses that colon
    // conditions of this sign-off — a later change that breaks one needs a new sign-off:
    // A1 both session routes refuse a browser signal 403 before the body is parsed and stay off the remote listener (class agent → 403 route_not_available)
    // A2 a captured line reaches no database row, log, item, URL or error reply; logs carry the request id only
    // A3 consume is POST only, reads nothing from the query string, and removes the approved request in the same synchronous step it passes
    // A4 the register schema bounds each line at the store's byte limit, so an oversized line is refused before the store
    // B1 the owner read keeps cache-control private, no-store on every reply and the page holds its reply in the sheet's state only, with no service worker
    // B2 a secret-approval post links only a pending request of the posting session with no item yet, and the item's title, body and options are server text
    // open, not blocking (part B 5): a local process can fill the 64-request machine cap for the 24 h pending life; the hook then refuses, failing closed
    cids: [SCAN_APPROVAL_CID, SCAN_APPROVAL_B_CID],
    rowCount: 122,
    sha256: "b5ddf7d330dc063e9a379869de99f0c2558e063c45a0b4517a55fa64052039dd",
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
  { route: "GET /api/model-config", cls: "page", reason: "page calls it; handler read: no caller input; the daemon model, budget caps and tier values from the DB and daemon-config.json (a rejected tier value returned as stored), the pricing roster's model ids, and each top-level agent file's name, file name, one description line cut to 52 characters, model pin cut to the id pattern and registry mark; a file not readable as an agent listed by file name with a reason — no path, no body text, no credential read" },
  { route: "PUT /api/model-config", cls: "page", reason: "page function, high-impact (model-config write) kept page by owner decision; handler read: validate-all-first against the fixed daemon model, budget and tier keys, any other key refused (model id by pattern, not by roster); one DB transaction, then daemon-config.json re-rendered; no agent file written" },
  { route: "GET /api/queue/count", cls: "page", reason: "page calls it (nav badge and Queue page); route read: no caller input, item counts only (behind the queue Host allowlist, see notes); count function not opened at this sign-off — the build notes state relays and probe sessions' items are left out of the counts and the oldest age" },
  { route: "POST /api/queue/sessions/register", cls: "agent", reason: "no page call site; called by the session-start hook and the queue CLI (call sites as the build notes list them, not re-read); route read: the body is either a full register, which registers whatever session and config directory it names, or a name-only update sent to the name writer when it carries no cwd; no credential beyond a named session id, plus a pid on the name-only shape; body schema and both work functions not opened" },
  { route: "POST /api/queue/sessions/deregister", cls: "agent", reason: "no page call site; called by scripts/lib/queue-session.sh only; no credential, acts on whatever session id the body names; work function not opened" },
  { route: "POST /api/queue/items", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; a remote caller could post items to the owner as any session; work function not opened; a secret-approval post is a strict body of session id and request id only, any other field refused 400; it links only a request held in the store that belongs to the posting session (another session's request answers 404 as a missing one), is still pending (409 otherwise), and has no item yet (409, backed by the UNIQUE secret_request_id column), checked under the session lock in the item's transaction; the item's title, body and options are fixed server text, never caller text, so the item carries no line or hash" },
  { route: "GET /api/queue/items/:id", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh and hooks/queue-turn-end-check.sh; work function read (getItemOrThrow): returns one item only when it belongs to the named session, another session's item answering the same as a missing one; returns the owner's answer, option code and free text, and every image linked to the item, an answer's images among them, as an image view carrying its absolute file path inside the queue image folder; stamps a relay's first fetch; no credential beyond a named session id" },
  { route: "POST /api/queue/pending", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; work function read: claims up to 20 of the named session's answered items per call, a wait poll refused unless the session is live for its pid; a remote caller could claim another session's answered items" },
  { route: "POST /api/queue/items/:id/ack", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; no credential beyond a named session id; work function not opened" },
  { route: "POST /api/queue/items/:id/withdraw", cls: "agent", reason: "no page call site; called by scripts/atrium-queue.sh only; no credential beyond a named session id; work function not opened" },
  { route: "GET /api/queue/owner/items", cls: "page", reason: "page calls it; handler read: profile, session id, cursor and limit 1-200 validated and bound; returns each non-terminal item of a non-probe session - title, body, options, the owner's answer text, image views and resume records, its session's full id and 8-character id prefix, absolute working and config directories and permission hint, plus the installed CLI path; a relay copy is listed while it is neither terminal nor redacted, in the same view as the relay thread of GET /api/queue/owner/orders - its peer-written text, hop, parent relay id and send time, sender and parent-sender id prefix, profile label, self-declared name and directory tail, the recipient's first fetch time and the lapse time as stored, no deviation and no Resend; a redacted relay is never listed, so no marker and no redaction fact is returned here; no relay row and no relay field the relay thread does not return; a secret-approval decision adds its request's facts from the in-memory store — state (pending, approved or gone), line count and expiry time — never a line, a hash or the request id" },
  { route: "GET /api/queue/owner/items/:id", cls: "agent", reason: "page call site not shown to this sign-off, so not a page function; handler read: integer id and empty query schema; returns one item's full owner view in any state — the same fields as the owner list, relay text and relay facts included; writes nothing — page only by a new sign-off that names the page call site" },
  { route: "GET /api/queue/owner/resumes", cls: "page", reason: "page calls it; handler read: limit 1-50 is the only input; returns the newest resume deliveries with attempt, result, abort reason and background id, each item's id and title, the session's profile label and directory tail" },
  { route: "GET /api/queue/owner/orders", cls: "page", reason: "page calls it from three threads: the Orders thread (kind order) and the one Queue list's Done part (kind item with the profile filter, and kind relay, whose refusal records the list draws as refused rows); handler and schema read: strict query, every value bound (kind order, relay or item; 1-200 session ids; one profile label, item thread only; cursor; limit 1-100, default 30); kind order and relay return every copy of each paged send in every state, a copy to a probe session left out and a send whose every copy went to probe sessions left out whole as the full owner item view — title and body (an owner message, or for kind relay a peer-written relay text, the fixed marker once redacted), answer text, image views, resume records, the recipient session's full id, absolute working and config directories and permission hint; a relay adds hop, parent relay id and send time, sender and parent-sender id prefix, profile label, self-declared name and directory tail, fetch, redaction and lapse times; kind relay adds at most 100 refusal records per page (time, reason code, sender and recipient id prefixes, unresolved count, no text); kind item returns each decision and report in every state but open, withdrawn ones included, of any age, in the same view — title, body, options, the owner's answer code and text, how the answer was made, image views, resume records, the close time and the same session fields — one item per row (no decision or report write sets a send id), so at most 100 a page; a probe session's items left out of every thread; no refusal records there; no field the owner list does not return, but the list stops at delivered, seen and withdrawn and this thread does not; a secret-approval decision adds its request's facts from the in-memory store — state (pending, approved or gone), line count and expiry time — never a line, a hash or the request id; writes nothing" },
  { route: "POST /api/queue/owner/items/:id/answer", cls: "page", reason: "page function, high-impact kept page by owner decision: the answer counts as the owner's word, approvals included, and for an ended session the sweep starts a local claude process to deliver it; handlers read: option code R1-R9 and one of the item's own, free text only where the item allows it, at most 20000 chars, up to 8 unique image ids of unused uploads from the last day taken only where free text is allowed and claimed in the answer's own transaction, so a failed claim or a lost open race records no answer and links no image, bound writes only; the resumed process takes its session id, directory and config directory from the registry row and a fixed text naming item and message ids, never the answer; page-origin stamp required and recorded; the page-origin check refuses a request with neither a same-origin Sec-Fetch-Site nor an allowlisted Origin header and is not a proof of the owner: a local non-browser process that sets either header itself is accepted and recorded with that signal, and for a secret-approval item that answer approves the capture (the disclosed residual, queue item 473; the plan's Honest backing)" },
  { route: "POST /api/queue/owner/items/:id/reply", cls: "page", reason: "page function, high-impact kept page by owner decision: the reply counts as the owner's word and for an ended session the sweep starts a local claude process to deliver it; handlers read: open report that allows a reply, text at most 20000 chars, up to 8 image ids of unused uploads from the last day, bound writes only; no value reaches the resume command, directory, environment or text; page-origin stamp required and recorded" },
  { route: "GET /api/queue/owner/sessions", cls: "page", reason: "page calls it; handler read: optional profile filter bound, at most 200 rows; returns full session ids, names, profile labels, absolute working directories, state and exit reason, waiting flag, item counts and the resume marker time" },
  { route: "POST /api/queue/owner/messages/send", cls: "page", reason: "page function, high-impact kept page by owner decision: one owner message per target, up to 20 registered sessions, and for each ended target the sweep starts a local claude process to deliver it; handlers read: session ids must be UUIDs of registered rows not replaced, text at most 20000 chars, up to 8 image ids of unused uploads from the last day, bound writes only; no value reaches the resume command, directory, environment or text; page-origin stamp required and recorded" },
  { route: "POST /api/queue/owner/images", cls: "page", reason: "page function, high-impact (file write) kept page by owner decision; route and store read: type and size from the bytes alone (PNG, JPEG, WebP, GIF), a header-declared side past 16,384 or area past 50,000,000 pixels refused 422 before any write, 10 MiB route cap, server-made UUID file name in the queue image folder, caller name stored as a label only" },
  { route: "GET /api/queue/owner/images/:id", cls: "page", reason: "page calls it; route read: serves image bytes with nosniff, same-origin resource policy and a sandbox CSP" },
  { route: "POST /api/queue/owner/items/:id/later", cls: "page", reason: "page calls it; route read: item status transition, empty body schema" },
  { route: "POST /api/queue/owner/items/:id/seen", cls: "page", reason: "page calls it; route read: item status transition, empty body schema" },
  { route: "POST /api/queue/owner/items/:id/resend", cls: "page", reason: "page function, high-impact kept page by owner decision: re-queues one delivery and, for an ended session, lets the sweep start a local claude process again; handler read: empty body, only an unacked or expired item or a resume-pending one whose attempt is used, refused while the session's earlier resume has not registered; a relay in any state is refused 409 and nothing is written, so a relay is never re-queued or resumed through this route; no caller text" },
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
  { route: "POST /api/queue/peers", cls: "agent", reason: "session route, never a page function: any request carrying a browser signal is refused 403 before the body is parsed (guard function not opened); called by the session ops library (sessions tool and CLI); handler read: session-id body, 404 for an unregistered caller; returns the live, listed sessions other than the caller — 8-character id prefix, shown name, profile label, directory tail, state and waiting flag, never a full id; writes nothing; no credential beyond a named session id, so a remote caller could list this Mac's sessions as any session" },
  { route: "POST /api/queue/relay", cls: "agent", reason: "session route, never a page function: any request carrying a browser signal is refused 403 before the body is parsed (guard function not opened); called by the session ops library (relay tool and CLI); handler read: sender must be a registered, live, non-probe session; recipients resolved by id prefix or shown name against the live listed peers only; envelope-token check, then the install's secret scanner on raw and normalized text before any lock; one transaction under a machine-wide lock: 10 copies per sender, 5 per pair and 30 per machine in a rolling hour, hop bound 3 over 24 hours, linked docs must exist, one relay item per recipient or none; each refusal recorded (awaited) with sender, resolved recipients, reason code and unresolved count, never text; replies with item ids and id prefixes only; body schema not opened; no credential beyond a named session id — a remote caller could put text before any live session as any session with no owner act" },
  { route: "POST /api/queue/owner/items/:id/redact", cls: "page", reason: "page function, high-impact (irreversible) kept page by owner decision: redaction is an owner route, never a session one; handler read: integer id and an empty body schema, so no request supplies replacement text; one bound update replaces a relay's title and body with the fixed server marker and stamps the time and the original body length; first wins (409 on a second call, nothing changed), every other kind refused 409; sender, recipient, send id, hop, parent, linked docs and delivery state untouched; the audit row carrying the page-origin signal is written in the same transaction, so no redaction stands without its record; page-origin stamp required" },
  { route: "PUT /api/model-config/agents", cls: "page", reason: "page function (Models screen, Apply to the ticked agents, sent on that press only), high-impact (writes the model line of agent files in the live install) kept page by owner decision; page call site read: one PUT whose body is the ticked agents' names, the pin the list showed for each, and one model from the roster or 'inherit'; file names, role lines, pins and refusal reasons rendered as text; handler read: strict body of agent names, the pin the page showed for each, and one model; a name selects an entry of the server's own folder list (top-level files of one name pattern, a file with no registry row included) and no request text reaches a path; a target resolving outside the agents folder refused; model is 'inherit' or a pricing-roster id, an empty roster refused; only the frontmatter model line set or removed, never another key or the body, checked on the re-read text and the file re-read before the rename, two model lines refused, a moved pin left as it stands; refused when the daemon-apply lock is present as the apply starts (tested once, not per file); names capped at the folder's count, 60 requests a minute and one apply in flight, both shared by the two listeners; audit intent row awaited before the handler, each agent's old and new pin recorded on the close (best-effort); page-origin stamp required and recorded" },
  { route: "POST /api/queue/scan-approvals", cls: "agent", reason: "session route, never a page function: any request carrying a browser signal (Origin, Referer, Cookie or a sec-fetch header) is refused 403 before the body is parsed (the relay route's guard); called by the secret-scan hook only; handler read: strict body of session id, absolute path, rule, agent id and type, and the captured lines each with its SHA-256, an unknown key answered without its name; the in-memory store refuses a rule other than SEC-013, more than 16 lines or 4096 bytes, a line holding an LF or a lone surrogate, a hash that is not its line's, and a session at 8 or the machine at 64 requests; the lines are held in process memory only, never the database, a log or an item; replies with the request id only, the same id for a repeat of a pending capture; logs the request id only; absent from the remote listener; no credential beyond a named session id — a local process without a browser signal could fill the request caps or register lines as any session; an approval is made only by an owner answer on the page-origin-checked answer route, which refuses a request with no page-origin header and an unregistered remote device, but a local process that sets a same-origin Origin or Sec-Fetch-Site header itself can answer as the owner and so approve its own capture (the disclosed residual, queue item 473)" },
  { route: "POST /api/queue/scan-approvals/consume", cls: "agent", reason: "session route, never a page function: any request carrying a browser signal (Origin, Referer, Cookie or a sec-fetch header) is refused 403 before the body is parsed (the relay route's guard); called by the secret-scan hook only; POST only, no GET route, nothing read from the query string; handler read: strict body of session id, absolute path, rule and line hashes, never a line, an unknown key answered without its name; passes only on an unexpired approved request of that session, path and rule whose hash set equals the one sent, removed from the store in the same synchronous step, so of two concurrent consumes one passes; replies with decision pass and the request id, or 409 with a fixed refusal code and decision refuse; logs the request id only; absent from the remote listener; no credential beyond a named session id — a local process holding the session id, path and approved hashes could spend an owner's approval; this route never creates one, but such a process could also forge the owner's answer that creates it (queue item 473)" },
  { route: "GET /api/queue/owner/items/:id/scan-approval", cls: "page", reason: "page class by owner decision (queue item 480: the registered phone may read and approve); page call site: the item sheet's scan read (queue.jsx readScanLinesQ via useScanReadQ), which fetches once when the sheet of a pending secret-approval item opens or the owner presses Retry, never at list load and never for an item that is expired, gone, answered or withdrawn; the reply is held only in that sheet's component state and dropped when the item stops being pending, when the sheet closes or changes item, and before every new read; it is never written to the list state, drafts, web storage, the URL or a log, and the page registers no service worker; handler read: integer id and empty query schema; for a secret-approval item whose request is pending, returns the server-computed display form of each captured line (text runs, invisible and look-alike code points as U+ marks, the value's cue, length and character classes, the line hash), the target path, the rule and the requesting agent type; 404 for an unknown item or one that is not a scan approval, 409 once the request is approved, declined, expired or used; cache-control private, no-store on every reply this handler sends, its 400s included; writes nothing; the one route that returns a captured line, which may be a real secret — reachable by the Mac page, by a registered phone by the owner's choice, and, as with the other owner reads, by any local process" },
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
