// E2E chromium harness for the Queue page (screens/queue.jsx): the page's real bundle on mockup v5's fixture data,
// the frame-independent facts every page stream keeps, and the named-state captures the owner compares to the mockup.
//
// Runner: npx tsx --test test/queue.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Captures: QUEUE_SHOTS_DIR (absolute) names a folder that keeps them; unset → a fresh mktemp folder, removed when its test ends.
// App: stripped Fastify serving test/lib/queue-render-fixtures.ts; a queue read with no fixture route answers 404 and is recorded.

import test, { after, before, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Locator, Page, Route } from "playwright";
import { chromium } from "playwright";

import { RELAY_REDACTION_MARKER } from "../src/server/queue/owner-items.js";
import type { OwnerItemView } from "../src/server/queue/owner-views.js";
import { messageBodySchema, ownerOrdersQuerySchema, ownerSessionsQuerySchema, type OwnerOrdersQuery } from "../src/server/queue/schemas.js";
import {
  buildSentCopies, DONE_IDS, EDGE_FIXTURE_IMAGES, EDGE_IDS, EDGE_LONG_SESSION_NAME, EDGE_LONG_TITLE, EDGE_SESSION_IDS, FIXTURE_CLI_PATH, FIXTURE_IMAGES, FIXTURE_NOW,
  FIXTURE_ORDER_TEXT, FIXTURE_SESSION_IDS, getAnswerNotReceivedFixture, getArrivalFixture, getDoneFixture, getDoneOnlyFixture, getDoneRelaysFixture, getEdgeFixture, getManyDoneFixture, getEmptyFixture, getNameColumnFixture, getOffViewFixture,
  getNoneListeningFixture, getNotListeningEdgeFixture, getNotListeningFixture, getNotReceivedFixture, getOneListFixture, getOneReceivedFixture, getOrderFirstFixture, getProseFixture, getHiddenSessionsFixture, getRailFixture, getRelayListFixture, getRelayRecordFixture, getRelayRowFixture, getRestFixture, getStoppedFixture, getUnreachableFixture,
  FORWARDED_RELAY, NOT_LISTENING_IDS, RELAY_ROW_IDS, NOT_LISTENING_SESSION_IDS, type QueueFixture,
  getScanApprovalFixture, SCAN_GONE_FACTS, SCAN_IDS, SCAN_MARK_POINTS,
} from "./lib/queue-render-fixtures.js";
import { deleteTempDirectory } from "./lib/remove-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS_PREFIX = "queue-shots-";
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const QUEUE_API_PREFIX = "/api/queue/";
const READY_TIMEOUT_MS = 30_000;

/** The owner's desktop sizes the captures are compared at (spec 44063 §18.4). */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1728, height: 1117 },
  { width: 1920, height: 1080 },
] as const;
/** @property isMobile - a phone: the page lays out at its declared width (index.html → meta viewport) and is scaled to the screen */
interface Viewport {
  width: number;
  height: number;
  isMobile?: boolean;
}

// §18.4's sizes beyond the desktop widths: the owner's window, the minimum and the wide display
const OWNER_WINDOW: Viewport = { width: 1568, height: 759 };
const MIN_WINDOW: Viewport = { width: 1280, height: 800 };
const WIDE_WINDOW: Viewport = { width: 2560, height: 1440 };

/**
 * One named page state: `nn` and `name` follow the mockup's capture names (`<width>x<height>-<nn>-<name>.png`, spec §18.4).
 * `setUp` drives the page to the state and waits on what the state shows → a step the page no longer takes fails the capture.
 * @property viewports - the sizes §18.4 marks for the state; unset → the desktop widths
 * @property isClockDriven - the page's timers run on the test's clock, for the 15 s re-read
 * @property isFirstLoad - captured before the first item read answers, without the setUp
 */
interface QueueState {
  nn: string;
  name: string;
  viewports?: readonly Viewport[];
  getFixture?: () => QueueFixture;
  setUp?: (page: Page, harness: Harness) => Promise<void>;
  isClockDriven?: boolean;
  isFirstLoad?: boolean;
}

/** A close-up (spec §18.4 29): the element `closeUp` at device scale 2, after `setUp`. */
interface CloseUpState extends QueueState {
  closeUp: string;
}

const NOTE_TEXT = "R2로 가되, 비교 평가 결과는 다음 보고에 붙여 주세요.";
const REPLY_TEXT = "README 안내까지 끝나면 PR 병합 단계로 넘어가 주세요.";
const ORDER_TO = ["gersona", "yoaida"];

const DESK_STATES: QueueState[] = [
  { nn: "01", name: "rest", viewports: [...VIEWPORTS, OWNER_WINDOW, MIN_WINDOW] },
  { nn: "02", name: "decision-picked", setUp: (page) => pickWithNote(page) },
  // §18.5 reads the panes with a report open at 1280 too → the minimum beside §18.4's sizes
  { nn: "03", name: "report", viewports: [...VIEWPORTS, OWNER_WINDOW, MIN_WINDOW], setUp: (page) => selectRow(page, 101) },
  {
    nn: "04", name: "rail-ticked",
    setUp: async (page) => {
      await tickSessions(page, ORDER_TO);
      await page.getByLabel("Select yoaida").scrollIntoViewIfNeeded();
    },
  },
  { nn: "11a", name: "back-before", setUp: (page) => scrollList(page) },
  {
    nn: "11b", name: "back-after",
    setUp: async (page) => {
      await scrollList(page);
      await page.locator(".queue-row").nth(3).click();
      await page.getByRole("button", { name: "Back to the list" }).click();
    },
  },
  { nn: "17", name: "in-delivery-row", setUp: (page) => selectRow(page, 109) },
  { nn: "18", name: "answered-not-yet", setUp: (page) => selectRow(page, 108) },
  { nn: "18b", name: "answered-not-received", getFixture: getAnswerNotReceivedFixture, setUp: (page) => selectRow(page, 108) },
  { nn: "19", name: "master-box", setUp: (page) => page.getByLabel("Select all live sessions").check() },
  {
    nn: "19b", name: "master-box-cleared",
    setUp: async (page) => {
      await page.getByLabel("Select all live sessions").check();
      await page.getByLabel("Select all live sessions").click();
    },
  },
  { nn: "20", name: "arrival-on-desk", isClockDriven: true, setUp: (page, harness) => arriveItem(page, harness) },
  // §4.4: past the visible part, the status line is the arrival's only sign → `1 new below` + Show, on the short windows where it lands there
  { nn: "20b", name: "arrival-off-view", viewports: [VIEWPORTS[0], OWNER_WINDOW], getFixture: getOffViewFixture, isClockDriven: true, setUp: (page, harness) => arriveOffView(page, harness) },
  { nn: "21b", name: "empty-queue", getFixture: getEmptyFixture },
  { nn: "24", name: "first-load", isFirstLoad: true },
  { nn: "26", name: "not-reachable", getFixture: getUnreachableFixture },
  // the edge fixture holds §14.4's stress content: the 200-character title, nine options, the long session name, 99+, eight images
  { nn: "27a", name: "stress-desk", getFixture: getEdgeFixture, setUp: (page) => waitForAllOrders(page) },
  { nn: "27b", name: "stress-long-title", getFixture: getEdgeFixture, setUp: (page) => selectRow(page, EDGE_IDS.longTitle) },
  { nn: "27c", name: "stress-nine-options", getFixture: getEdgeFixture, setUp: (page) => selectRow(page, EDGE_IDS.nineOptions) },
  { nn: "27d", name: "stress-seven-sessions", getFixture: getEdgeFixture, setUp: (page) => showThreadText(page, "7 sessions · 5 received · 1 not yet") },
  { nn: "27e", name: "stress-long-order", getFixture: getEdgeFixture, setUp: (page) => showThreadText(page, "Show all 31 lines") },
  // the 100-character session ticked: its name cut inside the send button beside a box that keeps its 220
  { nn: "27f", name: "stress-long-send", viewports: [VIEWPORTS[1]], getFixture: getEdgeFixture, setUp: (page) => tickOrdersTo(page, [EDGE_LONG_SESSION_NAME]) },
  // an ended session among two ticked (portfolio sits in the folded Ended band): the resume tail has no room beside the 220 box,
  // so it drops whole and the button hugs `Send to 2 sessions`, the box taking the rest
  { nn: "27g", name: "stress-ended-send", viewports: [VIEWPORTS[1]], getFixture: getEdgeFixture, setUp: (page) => tickEndedOrdersTo(page) },
  // the same two ticked on the wider pane: the button's room holds the resume tail, shown whole
  { nn: "27h", name: "stress-ended-send-whole", viewports: [VIEWPORTS[2]], getFixture: getEdgeFixture, setUp: (page) => tickEndedOrdersTo(page) },
  { nn: "28a", name: "wide-list", viewports: [WIDE_WINDOW] },
  { nn: "28b", name: "wide-report", viewports: [WIDE_WINDOW], setUp: (page) => selectRow(page, 101) },
];

const ORDER_STATES: QueueState[] = [
  {
    nn: "05", name: "two-composers", viewports: [...VIEWPORTS, OWNER_WINDOW, MIN_WINDOW],
    setUp: async (page) => {
      await tickOrdersTo(page, ORDER_TO);
      await selectRow(page, 103);
    },
  },
  { nn: "06", name: "order-with-images", setUp: (page) => typeOrderWithImages(page) },
  { nn: "07", name: "just-sent", viewports: [...VIEWPORTS, OWNER_WINDOW], setUp: (page) => sendOrderWithImages(page) },
  { nn: "08", name: "one-received", getFixture: getOneReceivedFixture, setUp: (page) => tickOrdersTo(page, ORDER_TO) },
  { nn: "09", name: "not-received", getFixture: getNotReceivedFixture, setUp: (page) => selectRow(page, 210) },
  {
    nn: "09b", name: "after-resend", getFixture: getNotReceivedFixture,
    setUp: async (page) => {
      await selectRow(page, 210);
      await page.locator(".queue-orders").getByRole("button", { name: "Resend" }).first().click();
      await page.locator(".queue-orders").getByText("Not received").waitFor({ state: "detached" });
    },
  },
  {
    nn: "10", name: "arrival-on-sheet", isClockDriven: true,
    setUp: async (page, harness) => {
      await selectRow(page, 101);
      await arriveItem(page, harness);
    },
  },
  {
    nn: "12", name: "recipients-changed",
    setUp: async (page) => {
      await tickOrdersTo(page, ["gersona"]);
      await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
      await tickSessions(page, ["yoaida"]);
      await page.locator(".queue-orders").getByText("Recipients changed").waitFor();
    },
  },
  {
    nn: "13", name: "image-viewer",
    setUp: async (page) => {
      await tickOrdersTo(page, ["atrium"]);
      await page.locator(".queue-bubble-image").nth(1).click();
      await page.locator(".queue-viewer img").waitFor();
    },
  },
  { nn: "14a", name: "refused-count", setUp: (page) => addOrderFiles(page, Array.from({ length: 9 }, (_, index) => getImageFile(index))) },
  { nn: "14b", name: "refused-type", setUp: (page) => addOrderFiles(page, [{ name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n") }]) },
  { nn: "14c", name: "refused-size", setUp: (page) => addOrderFiles(page, [{ ...getImageFile(0), name: "large.png", buffer: Buffer.concat([getImageFile(0).buffer, Buffer.alloc(11 * 1024 * 1024)]) }]) },
  {
    nn: "14d", name: "upload-failed",
    setUp: async (page, harness) => {
      harness.refusals.set("upload", { status: 500, body: { error: "server" } });
      await addOrderFiles(page, [getImageFile(0)]);
      await page.locator(".queue-thumb-failed").first().waitFor();
    },
  },
  { nn: "14e", name: "file-hanging", setUp: (page) => hangFileOverComposer(page) },
  { nn: "15", name: "report-order-image", setUp: (page) => typeReportOrder(page) },
  {
    nn: "15b", name: "report-order-sent",
    setUp: async (page) => {
      await typeReportOrder(page);
      await page.locator(".queue-sheet").getByRole("button", { name: "Send order" }).click();
      // the next item takes the sheet and the list is put away → the line is read from the pane's status region
      await page.locator('[role="status"]', { hasText: "Order sent to yoaida" }).first().waitFor({ state: "attached" });
    },
  },
  { nn: "16", name: "atrium-ticked", setUp: (page) => tickOrdersTo(page, ["atrium"]) },
  {
    nn: "16b", name: "send-no-tick",
    setUp: async (page) => {
      await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
      await page.locator(".queue-orders").getByRole("button", { name: "Send order" }).click();
      await page.locator(".queue-orders").getByText("Tick at least one session").waitFor();
    },
  },
  { nn: "21c", name: "empty-thread", getFixture: getEmptyFixture, setUp: (page) => tickOrdersTo(page, ["aidl"]) },
];

const REFUSAL_STATES: QueueState[] = [
  {
    nn: "22", name: "send-answer-empty",
    setUp: async (page) => {
      await selectRow(page, 103);
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
    },
  },
  {
    nn: "22b", name: "refused-409",
    setUp: async (page, harness) => {
      harness.refusals.set("action", { status: 409, body: { error: "conflict" } });
      await selectRow(page, 103);
      await page.locator("#queue-option-103-R2").check();
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      await page.locator(".queue-sheet").getByText("Refused: the item changed state").waitFor();
    },
  },
  {
    nn: "22c", name: "check-failed", isClockDriven: true,
    setUp: async (page, harness) => {
      harness.isListDown = true;
      await page.clock.fastForward(15_000);
      await page.locator(".page-head [role=status]", { hasText: "Not updated" }).waitFor();
    },
  },
  {
    nn: "22d", name: "order-refused",
    setUp: async (page, harness) => {
      harness.refusals.set("send", { status: 400, body: { error: "invalid_body", reason: "One of the sessions has ended. Untick it and send again." } });
      await typeOrderWithImages(page);
      await page.locator(".queue-orders").getByRole("button", { name: /^Send to 2 sessions/ }).click();
      await page.locator(".queue-orders").getByText("One of the sessions has ended").waitFor();
    },
  },
];

const LOOK_STATES: QueueState[] = [
  { nn: "25a", name: "focus-master-box", setUp: (page) => focusByKeyboard(page, page.getByLabel("Select all live sessions")) },
  { nn: "25g", name: "focus-rail-box", setUp: (page) => focusByKeyboard(page, page.getByLabel("Select gersona")) },
  {
    nn: "25h", name: "focus-back",
    setUp: async (page) => {
      await selectRow(page, 103);
      await focusByKeyboard(page, page.getByRole("button", { name: "Back to the list" }));
    },
  },
  {
    nn: "25i", name: "focus-thumb-remove",
    setUp: async (page) => {
      await typeOrderWithImages(page);
      await focusByKeyboard(page, page.locator(".queue-orders .queue-thumb-remove").first());
    },
  },
  {
    nn: "25b", name: "focus-row",
    setUp: async (page) => {
      await focusByKeyboard(page, page.locator(".queue-row").first());
      await page.keyboard.press("j");
      await page.locator(".queue-row:focus-visible").waitFor();
    },
  },
  {
    nn: "25c", name: "focus-option",
    setUp: async (page) => {
      await page.locator(".queue-row").first().click();
      await page.keyboard.press("Enter");
    },
  },
  { nn: "25d", name: "focus-quiet", setUp: (page) => page.getByRole("button", { name: /^Automatic resumes/ }).focus() },
  { nn: "25f", name: "key-list", setUp: (page) => page.getByRole("button", { name: /Keyboard shortcuts/ }).click() },
];

// spec §12.5 close-ups: on an open decision the head holds icon buttons (back, Previous disabled, Next); the foot the primary and the quiet later
const SHEET_HEAD = ".queue-sheet-head";
const SHEET_FOOT = ".queue-sheet .card-foot";
const NEXT_ITEM = ".queue-sheet-head [aria-label='Next item']";
const BUTTON_STATES: CloseUpState[] = [
  { nn: "29", name: "buttons-rest-head", closeUp: SHEET_HEAD, setUp: (page) => selectRow(page, 103) },
  { nn: "29", name: "buttons-rest-foot", closeUp: SHEET_FOOT, setUp: (page) => selectRow(page, 103) },
  ...[
    { rank: "icon", closeUp: SHEET_HEAD, target: NEXT_ITEM },
    { rank: "quiet", closeUp: SHEET_FOOT, target: `${SHEET_FOOT} .queue-note > .btn.ghost` },
    // Send answer takes the ink only once an option is picked (spec §9.8 → On an answer)
    { rank: "primary", closeUp: SHEET_FOOT, target: `${SHEET_FOOT} .btn.primary`, isPicked: true },
  ].flatMap(getRankCloseUps),
];

// spec §18.4 29: one rank's button hovered, held and focused (by keyboard → its ring paints) on the open decision 103
function getRankCloseUps({ rank, closeUp, target, isPicked = false }: { rank: string; closeUp: string; target: string; isPicked?: boolean }): CloseUpState[] {
  const steps: Array<[string, (page: Page) => Promise<void>]> = [
    ["hover", (page) => page.locator(target).hover()],
    ["held", async (page) => {
      await page.locator(target).hover();
      await page.mouse.down();
    }],
    ["focus", (page) => focusByKeyboard(page, page.locator(target))],
  ];
  return steps.map(([look, act]) => ({
    nn: "29", name: `buttons-${look}-${rank}`, closeUp,
    setUp: async (page) => {
      await selectRow(page, 103);
      if (isPicked) await page.locator("#queue-option-103-R2").check();
      await act(page);
    },
  }));
}

// spec §18.4 29's other close-ups
const PARTS: CloseUpState[] = [
  { nn: "29", name: "rail-ticked", closeUp: ".queue-sessions", setUp: (page) => tickSessions(page, ["gersona"]) },
  // §18.4 29's live and ended rows on one rail: a ticked live row and the ended rows under the open Ended band
  {
    nn: "29", name: "rail-ended-open", closeUp: ".queue-sessions",
    setUp: async (page) => {
      await tickSessions(page, ["gersona"]);
      await openEndedBand(page);
    },
  },
  // a row that takes no message (Replaced, under the open Ended band): its box column stands empty, the state mark and name on the others' columns
  {
    nn: "29", name: "rail-not-selectable", closeUp: ".queue-sessions", getFixture: getStoppedFixture,
    setUp: async (page) => {
      await openEndedBand(page);
      await page.locator(".queue-rail-row", { hasText: "Replaced" }).waitFor();
    },
  },
  { nn: "29", name: "list-band-rows", closeUp: ".queue-list > .card-body" },
  // the list's 104 name column holding a 100-character name, cut, and a name the session did not register, start directory under it
  { nn: "29", name: "list-name-column", closeUp: ".queue-list > .card-body", getFixture: getNameColumnFixture },
  { nn: "29", name: "sheet-report", closeUp: ".queue-sheet", setUp: (page) => selectRow(page, 101) },
  { nn: "29", name: "option-recommended", closeUp: ".queue-sheet .queue-option:has-text('Recommended')", setUp: (page) => selectRow(page, 103) },
  { nn: "29", name: "composer-sheet", closeUp: ".queue-sheet .queue-composer", setUp: (page) => selectRow(page, 101) },
  { nn: "29", name: "composer-orders", closeUp: ".queue-orders .queue-composer", setUp: (page) => selectRow(page, 101) },
  { nn: "29", name: "order-images", closeUp: "article.queue-order:has(.queue-bubble-image)", setUp: (page) => waitForAllOrders(page) },
  {
    nn: "29", name: "order-three-receipts", closeUp: "article.queue-order:has(.queue-recipient ~ .queue-recipient ~ .queue-recipient)", getFixture: getEdgeFixture,
    setUp: (page) => waitForAllOrders(page),
  },
];

// the pause glyph beside the Not yet tag at device scale 2: the solid two bars, read at a glance
const NOT_LISTENING_PARTS: CloseUpState[] = [
  {
    nn: "35", name: "not-listening-pair", closeUp: `#queue-order-${NOT_LISTENING_IDS.mixedOrder}`, getFixture: getNotListeningFixture,
    setUp: (page) => page.locator(`#queue-order-${NOT_LISTENING_IDS.mixedOrder}`).scrollIntoViewIfNeeded(),
  },
];

const CLOSE_UP_STATES: CloseUpState[] = [...BUTTON_STATES, ...PARTS, ...NOT_LISTENING_PARTS];

// spec §18.4 35 (Next turn stream only) at 1280, 1440 and 1920: each Next turn surface in one frame with its Not yet
// twin — the rail's two rows, the list's roll-ups, the mixed order's recipients, the composer with a listening and a not-listening tick, the two
// answered sheets — then a list row with both badges, the five-or-more roll-up, the composer's other ticks, no session listening, the approval note
const TWIN_VIEWPORTS = [MIN_WINDOW, VIEWPORTS[0], VIEWPORTS[2]] as const;
const TWIN_STATES: QueueState[] = [
  { nn: "35a", name: "not-listening-desk", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => showNotListeningDesk(page) },
  { nn: "35b", name: "not-listening-composer", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => tickOrdersTo(page, ["gersona", "nightly"]) },
  { nn: "35c", name: "not-listening-sheet", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => selectRow(page, NOT_LISTENING_IDS.answeredDecision) },
  { nn: "35d", name: "listening-sheet", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => selectRow(page, 108) },
  { nn: "35e", name: "two-badge-row", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningEdgeFixture, setUp: (page) => page.locator(`#queue-row-${NOT_LISTENING_IDS.twoBadgeOrder}`).scrollIntoViewIfNeeded() },
  { nn: "35f", name: "roll-up-not-listening", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningEdgeFixture, setUp: (page) => page.locator(`#queue-order-${NOT_LISTENING_IDS.rollUpOrder}`).scrollIntoViewIfNeeded() },
  { nn: "35g", name: "composer-one-not-listening", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => tickOrdersTo(page, ["nightly"]) },
  { nn: "35h", name: "composer-not-listening-first", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => tickOrdersTo(page, ["sixmon", "nightly"]) },
  { nn: "35i", name: "none-listening", viewports: TWIN_VIEWPORTS, getFixture: getNoneListeningFixture, setUp: (page) => showNotListeningDesk(page) },
  { nn: "36", name: "approval-note", viewports: TWIN_VIEWPORTS, getFixture: getEdgeFixture, setUp: (page) => selectRow(page, EDGE_IDS.approval) },
];

// spec §18.4 32–34: the rail foot with relays on record, the redaction on a relay's sheet asked, done, refused, cut off by an outage
// and partly done, and the rail with hidden sessions in the data
const RELAY_STATES: QueueState[] = [
  { nn: "32", name: "relay-foot-rest", viewports: [VIEWPORTS[0]], getFixture: getRelayRecordFixture },
  { nn: "33b", name: "redact-confirm", viewports: [VIEWPORTS[0]], getFixture: getRelayRecordFixture, setUp: (page) => askRedaction(page) },
  {
    nn: "33c", name: "redact-partly", viewports: [VIEWPORTS[0]], getFixture: getRelayRecordFixture,
    setUp: async (page, harness) => {
      refuseOneRedaction(harness);
      await askRedaction(page);
      await confirmRedaction(page);
      await page.getByText(PARTLY_REDACTED_LINE).waitFor();
    },
  },
  {
    nn: "33e", name: "redact-done", viewports: [VIEWPORTS[0]], getFixture: getRelayRecordFixture,
    setUp: async (page) => {
      await askRedaction(page);
      await confirmRedaction(page);
      await page.locator(".queue-sheet .card-foot", { hasText: "Text redacted." }).waitFor();
    },
  },
  {
    nn: "33f", name: "redact-refused", viewports: [VIEWPORTS[0]], getFixture: getRelayRecordFixture,
    setUp: (page, harness) => refuseRedaction(page, harness, { status: 409, body: { error: "wrong_kind" } }, "✕ Refused: HTTP 409 wrong_kind."),
  },
  {
    nn: "33g", name: "redact-outage", viewports: [VIEWPORTS[0]], getFixture: getRelayRecordFixture,
    setUp: (page, harness) => refuseRedaction(page, harness, { status: 503, body: { error: "database_unavailable" } }, null),
  },
  { nn: "34", name: "rail-hidden-sessions", viewports: [VIEWPORTS[0]], getFixture: getHiddenSessionsFixture },
];

// spec §9.1: every rail state on one page, the Ended band open, at the minimum, the 1440 step and the owner's window
const RAIL_STATES: QueueState[] = [
  { nn: "37", name: "rail-states", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getRailFixture, setUp: (page) => openEndedBand(page) },
];

// spec §4.6 (One list) at the three list widths: the open bands with the Done bands under them — at rest, scrolled to the done part,
// after Show more, with nothing open and with a session ticked — and an answered decision's read-only sheet
const DONE_STATES: QueueState[] = [
  { nn: "38", name: "one-list", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getDoneFixture, setUp: (page) => waitForDoneBands(page) },
  { nn: "38c", name: "one-list-done-part", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getDoneFixture, setUp: (page) => scrollToDonePart(page) },
  { nn: "38d", name: "one-list-more", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getManyDoneFixture, setUp: (page) => showMoreDone(page) },
  { nn: "38e", name: "one-list-none-open", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getDoneOnlyFixture, setUp: (page) => waitForDoneBands(page) },
  {
    nn: "38f", name: "one-list-ticked", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getDoneFixture,
    setUp: async (page) => {
      await tickSessions(page, ["atrium"]);
      await page.waitForFunction(() => document.querySelectorAll(".queue-row--done").length === 1);
    },
  },
  {
    nn: "38b", name: "done-sheet", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getDoneFixture,
    setUp: async (page) => {
      await selectRow(page, DONE_IDS.answered);
      await page.locator(".queue-sheet .card-foot", { hasText: "Answer R1 ·" }).waitFor();
    },
  },
];

// spec §4.2, §9.9: relays on their way under In delivery at the three list widths, and a relay to several on its read-only sheet
const RELAY_ROW_STATES: QueueState[] = [
  { nn: "39", name: "relay-rows", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getRelayRowFixture, setUp: (page) => page.locator(`#queue-row-${RELAY_ROW_IDS.several}`).scrollIntoViewIfNeeded() },
  {
    nn: "39b", name: "relay-sheet", viewports: [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW], getFixture: getRelayRowFixture,
    setUp: async (page) => {
      await selectRow(page, RELAY_ROW_IDS.several);
      await page.locator(".queue-sheet .card-foot", { hasText: "Read-only." }).waitFor();
    },
  },
];

// spec §6, §7, §9.8 → On an answer, at the three list widths: each sheet whose foot or answer the answer's images reach
const LIST_WIDTHS = [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW] as const;
const ANSWER_STATES: QueueState[] = [
  { nn: "40a", name: "decision-sheet", viewports: LIST_WIDTHS, setUp: (page) => selectRow(page, 103) },
  { nn: "40b", name: "approval-sheet", viewports: LIST_WIDTHS, getFixture: getEdgeFixture, setUp: (page) => selectRow(page, EDGE_IDS.approval) },
  { nn: "40c", name: "report-sheet", viewports: LIST_WIDTHS, setUp: (page) => selectRow(page, 101) },
  {
    nn: "40d", name: "handled-decision-sheet", viewports: LIST_WIDTHS, getFixture: getDoneFixture,
    setUp: async (page) => {
      await selectRow(page, DONE_IDS.answered);
      await page.locator(".queue-sheet .card-foot", { hasText: "Answer R1 ·" }).waitFor();
    },
  },
  {
    nn: "40e", name: "relay-sheet", viewports: LIST_WIDTHS, getFixture: getRelayRowFixture,
    setUp: async (page) => {
      await selectRow(page, RELAY_ROW_IDS.several);
      await page.locator(".queue-sheet .card-foot", { hasText: "Read-only." }).waitFor();
    },
  },
  { nn: "40f", name: "approval-images", viewports: LIST_WIDTHS, getFixture: getEdgeFixture, setUp: (page) => addApprovalFiles(page) },
  {
    nn: "40g", name: "approval-upload-failed", viewports: LIST_WIDTHS, getFixture: getEdgeFixture,
    setUp: async (page, harness) => {
      harness.refusals.set("upload", { status: 500, body: { error: "server" } });
      await addApprovalFiles(page);
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
    },
  },
  { nn: "40h", name: "answered-images", viewports: LIST_WIDTHS, setUp: (page) => showAnswerImages(page, 108) },
  { nn: "40i", name: "approval-files-refused", viewports: LIST_WIDTHS, getFixture: getEdgeFixture, setUp: (page) => addRefusedApprovalFiles(page) },
];

// spec §5 → Where it renders, at the three list widths: a report in Markdown with its fence folded, an open decision's fence whole, a relay as sent
const TEXT_STATES: QueueState[] = [
  { nn: "41a", name: "report-markdown", viewports: LIST_WIDTHS, getFixture: getProseFixture, setUp: (page) => selectRow(page, 101) },
  { nn: "41b", name: "report-fence-folded", viewports: LIST_WIDTHS, getFixture: getProseFixture, setUp: (page) => showSheetEnd(page, 101, ".queue-sheet .prose-fold") },
  { nn: "41c", name: "decision-fence-whole", viewports: LIST_WIDTHS, getFixture: getProseFixture, setUp: (page) => showSheetEnd(page, 103, ".queue-sheet .prose-pre") },
  {
    nn: "41d", name: "relay-as-sent", viewports: LIST_WIDTHS, getFixture: getProseFixture,
    setUp: async (page) => {
      await selectRow(page, RELAY_ROW_IDS.one);
      await page.locator(".queue-sheet .card-foot", { hasText: "Read-only." }).waitFor();
    },
  },
];

// spec §4.2 → Column rule at the three list widths: the one list with every band kind — the tagless Reports, Decisions, In delivery with
// relays and the answered decision's two images, the Done bands — at its top, its In delivery band and its Done part
const COLUMN_STATES: QueueState[] = [
  { nn: "42", name: "one-list-columns", viewports: LIST_WIDTHS, getFixture: getOneListFixture, setUp: (page) => waitForDoneBands(page) },
  {
    nn: "42b", name: "one-list-columns-delivery", viewports: LIST_WIDTHS, getFixture: getOneListFixture,
    setUp: async (page) => {
      await waitForDoneBands(page);
      await scrollToBand(page, '[aria-labelledby="queue-band-inDelivery"]');
    },
  },
  { nn: "42c", name: "one-list-columns-done", viewports: LIST_WIDTHS, getFixture: getOneListFixture, setUp: (page) => scrollToDonePart(page) },
];

const QUEUE_STATES: QueueState[] = [...DESK_STATES, ...ORDER_STATES, ...REFUSAL_STATES, ...LOOK_STATES, ...TWIN_STATES, ...RELAY_STATES, ...RAIL_STATES, ...DONE_STATES, ...RELAY_ROW_STATES, ...ANSWER_STATES, ...TEXT_STATES, ...COLUMN_STATES];

// Markup written by a session: rendered as text, it shows these literals; parsed as HTML, it adds probe elements.
const MARKUP_TITLE = "보고 <b data-markup-probe>굵게</b> 끝";
const MARKUP_BODY = "- 본문 <img data-markup-probe src=\"/markup-probe.png\" onerror=\"window.__markupRan = true\">";

/** A write route a state makes refuse: its status and the server's refusal body. */
/** @property ids - the items it answers for; unset → every one */
interface Refusal {
  status: number;
  body: { error: string; reason?: string };
  ids?: number[];
}
type WriteRoute = "send" | "action" | "upload" | "redact";

interface Harness {
  app: FastifyInstance;
  url: string;
  browser: Browser;
  fixture: QueueFixture;
  /** Queue reads no fixture route answered, as "METHOD /path". */
  missedReads: string[];
  /** Write routes answering a refusal instead of taking the write; cleared before each state. */
  refusals: Map<WriteRoute, Refusal>;
  /** Set → the item list read waits on it, so the page's first-load placeholders hold. */
  heldRead: Promise<void> | null;
  /** Set → the session and order reads wait on it too, so the desk's first load holds all three placeholders. */
  heldDesk: Promise<void> | null;
  heldAct: Promise<void> | null;
  /** True → the item list read answers the server's outage, so the page's check fails. */
  isListDown: boolean;
  /** Set → the first page of the item list offers this cursor, so the list foot shows Show more. */
  moreCursor: string | null;
  uploads: number;
  /** The item ids the owner read of captured lines was asked for, in order. */
  scanReadIds: number[];
  /** Each CDN response (index.html's scripts, the web fonts) as first fetched, replayed to every later page. */
  responseByUrl: Map<string, Promise<CachedResponse>>;
}

interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

async function openHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const harness: Harness = {
    app, url: "", browser: await chromium.launch({ headless: true }), fixture: getRestFixture(), missedReads: [], refusals: new Map(), heldRead: null, heldDesk: null, heldAct: null, isListDown: false, moreCursor: null, uploads: 0, scanReadIds: [], responseByUrl: new Map(),
  };
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  registerFixtureRoutes(app, harness);
  app.all("/api/*", async (request, reply) => {
    if (!request.url.startsWith(QUEUE_API_PREFIX)) return { rows: [] };
    harness.missedReads.push(`${request.method} ${request.url}`);
    return reply.code(404).send({ error: "no_fixture_route" });
  });
  await app.ready();
  harness.url = await app.listen({ host: "127.0.0.1", port: 0 });
  return harness;
}

async function closeHarness(harness: Harness | undefined): Promise<void> {
  await harness?.browser?.close();
  await harness?.app?.close();
}

// the owner reads, the count and the image routes, each answering in the server's response shape
function registerFixtureRoutes(app: FastifyInstance, harness: Harness): void {
  app.get<{ Querystring: { after?: string } }>("/api/queue/owner/items", async (request, reply) => {
    await harness.heldRead;
    if (harness.isListDown) return reply.code(503).send({ error: "database_unavailable" });
    const isFirstPage = request.query.after === undefined;
    return { items: isFirstPage ? harness.fixture.items : [], nextCursor: isFirstPage ? harness.moreCursor : null, cliPath: FIXTURE_CLI_PATH };
  });
  // the server's read: hidden rows only when asked for (owner-sessions.ts → getOwnerSessions)
  app.get("/api/queue/owner/sessions", async (request) => {
    await harness.heldDesk;
    const { includeHidden } = ownerSessionsQuerySchema.parse(request.query);
    return { sessions: harness.fixture.sessions.filter((row) => includeHidden || !row.isHidden), hasMore: false };
  });
  app.get("/api/queue/owner/resumes", async () => ({ resumes: harness.fixture.resumes }));
  // the owner read of captured lines (queue-owner.ts): private, no-store on every reply; no waiting request → 409 secret_request_gone
  app.get<{ Params: { id: string } }>("/api/queue/owner/items/:id/scan-approval", async (request, reply) => {
    const id = Number(request.params.id);
    harness.scanReadIds.push(id);
    const read = harness.fixture.scanReads?.[id];
    reply.headers({ "cache-control": "private, no-store" });
    return read === undefined ? reply.code(409).send({ error: "secret_request_gone" }) : read;
  });
  app.get("/api/queue/owner/orders", async (request) => {
    await harness.heldDesk;
    const query = ownerOrdersQuerySchema.parse(request.query);
    const { relays } = harness.fixture;
    if (query.kind === "item") return getOrderPage(getAccountItems(harness.fixture.done ?? [], query.profile), query, getFixtureDoneRows);
    return query.kind === "relay"
      ? { ...getOrderPage(relays.items, query), refusals: relays.refusals, isRefusalListCut: relays.isRefusalListCut === true }
      : getOrderPage(harness.fixture.orders, query);
  });
  app.get<{ Params: { id: string } }>("/api/queue/owner/images/:id", async (request, reply) => {
    const image = FIXTURE_IMAGES.get(request.params.id) ?? EDGE_FIXTURE_IMAGES.get(request.params.id);
    if (image === undefined) return reply.code(404).send({ error: "unknown_image" });
    return reply.headers({ "content-type": image.mime, "x-content-type-options": "nosniff" }).send(image.bytes);
  });
  // an upload is stored as the next fixture image under the owner's label → its thumbnail loads from the serve route above
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.post<{ Querystring: { name: string } }>("/api/queue/owner/images", async (request, reply) => {
    const refusal = harness.refusals.get("upload");
    if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
    const image = [...FIXTURE_IMAGES.values()][harness.uploads++ % FIXTURE_IMAGES.size];
    return reply.code(201).send({ ...image?.view, name: request.query.name, bytes: (request.body as Buffer).length });
  });
  registerWriteRoutes(app, harness);
  app.get("/api/queue/count", async () => ({
    awaiting: harness.fixture.items.filter((item) => item.status === "open").length,
    deviations: harness.fixture.items.filter((item) => item.deviation !== null).length,
    oldestAgeSeconds: null,
  }));
}

/**
 * The owner's writes on the fixture: a send adds one copy per recipient, awaiting receipt, to the list and the history read;
 * an answer or reply leaves the item answered, a read (`seen`) drops it, a resend clears the not-received state in the list and the thread. A set refusal answers instead.
 */
function registerWriteRoutes(app: FastifyInstance, harness: Harness): void {
  // a redaction stores the marker with its time and the text's length on one copy; a set refusal answers for the copies it names
  app.post<{ Params: { id: string } }>("/api/queue/owner/items/:id/redact", async (request, reply) => {
    const id = Number(request.params.id);
    const refusal = harness.refusals.get("redact");
    if (refusal !== undefined && (refusal.ids?.includes(id) ?? true)) return reply.code(refusal.status).send(refusal.body);
    const redact = (item: OwnerItemView): OwnerItemView => (item.id !== id || item.relay === null ? item : {
      ...item, title: RELAY_REDACTION_MARKER, body: RELAY_REDACTION_MARKER, relay: { ...item.relay, redaction: { at: new Date(FIXTURE_NOW).toISOString(), length: item.body.length } },
    });
    harness.fixture = { ...harness.fixture, relays: { ...harness.fixture.relays, items: harness.fixture.relays.items.map(redact) } };
    return { ok: true };
  });
  app.post("/api/queue/owner/messages/send", async (request, reply) => {
    const refusal = harness.refusals.get("send");
    if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
    const { sessionIds, text, attachmentIds = [] } = messageBodySchema.parse(request.body);
    const images = attachmentIds.flatMap((id) => FIXTURE_IMAGES.get(id)?.view ?? []);
    const firstId = Math.max(...harness.fixture.items.map((item) => item.id), ...harness.fixture.orders.map((item) => item.id)) + 1;
    const copies = buildSentCopies(firstId, { sendId: randomUUID(), sessionIds, text, images });
    harness.fixture = { ...harness.fixture, items: [...harness.fixture.items, ...copies], orders: [...harness.fixture.orders, ...copies] };
    return reply.code(201).send({ items: copies });
  });
  app.post<{ Params: { id: string; action: string } }>("/api/queue/owner/items/:id/:action", async (request, reply) => {
    const refusal = harness.refusals.get("action");
    if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
    await harness.heldAct;
    const id = Number(request.params.id);
    const act = (item: OwnerItemView) => (item.id === id ? getActedItem(item, request.params.action) : [item]);
    const orders = request.params.action === "resend" ? harness.fixture.orders.flatMap(act) : harness.fixture.orders;
    harness.fixture = { ...harness.fixture, items: harness.fixture.items.flatMap(act), orders };
    return reply.send({ ok: true });
  });
}

function getActedItem(item: OwnerItemView, action: string): OwnerItemView[] {
  if (action === "seen") return [];
  if (action === "resend") return [{ ...item, status: "answered", deviation: null, canResend: false }];
  if (action === "answer" || action === "reply") return [{ ...item, status: "answered", answeredAt: new Date(FIXTURE_NOW).toISOString() }];
  return [item];
}

/** `id` = its lowest copy id → the cursor's tie-break, as on the server. */
interface FixtureOrder {
  at: bigint;
  id: bigint;
  copies: OwnerItemView[];
}

/**
 * The history read's observable contract (owner-views.ts → getOwnerOrders), modelled on the fixture copies:
 * newest order first, paged by order, every copy of an order any ticked session received, cursor `<µs>:<first id>`.
 */
function getOrderPage(copies: OwnerItemView[], query: OwnerOrdersQuery, getRows = getFixtureOrders): { items: OwnerItemView[]; nextCursor: string | null } {
  const { sessionIds, before, limit } = query;
  const orders = getRows(copies)
    .filter((order) => sessionIds === undefined || order.copies.some((copy) => sessionIds.includes(copy.session.id)))
    .filter((order) => before === undefined || isOrderBefore(order, before));
  const page = orders.slice(0, limit);
  const last = page.at(-1);
  return { items: page.flatMap((order) => order.copies), nextCursor: orders.length > limit && last ? `${last.at}:${last.id}` : null };
}

// fold key: the send id, else equal answer time and text; an order's time is its newest copy's, its id its lowest
function getFixtureOrders(copies: OwnerItemView[]): FixtureOrder[] {
  const byKey = new Map<string, OwnerItemView[]>();
  for (const copy of copies) {
    const key = copy.sendId ?? `${copy.answeredAt}|${copy.body}`;
    byKey.set(key, [...(byKey.get(key) ?? []), copy]);
  }
  return [...byKey.values()]
    .map((group) => group.sort((left, right) => left.id - right.id))
    .map((group) => ({ at: getMaxMicros(group), id: BigInt(group[0]!.id), copies: group }))
    .sort((left, right) => (isOrderBefore(left, right) ? 1 : -1));
}

// the done read (kind item): one item a row, newest end first, the account filtering per item
function getFixtureDoneRows(items: OwnerItemView[]): FixtureOrder[] {
  return items
    .map((item) => ({ at: BigInt(Date.parse(item.closedAt ?? "")) * 1000n, id: BigInt(item.id), copies: [item] }))
    .sort((left, right) => (isOrderBefore(left, right) ? 1 : -1));
}

function getAccountItems(items: OwnerItemView[], profile: string | undefined): OwnerItemView[] {
  return profile === undefined ? items : items.filter((item) => item.session.profileLabel === profile);
}

function getMaxMicros(group: OwnerItemView[]): bigint {
  return group.map((copy) => BigInt(Date.parse(copy.answeredAt ?? "")) * 1000n).reduce((max, at) => (at > max ? at : max));
}

function isOrderBefore(order: { at: bigint; id: bigint }, bound: { at: bigint; id: bigint }): boolean {
  return order.at < bound.at || (order.at === bound.at && order.id < bound.id);
}

/**
 * A fresh page on the pinned clock, opened on #queue once the fixture's text and the web fonts are in.
 * @param isClockDriven - the page's timers run on the test's clock (`page.clock.fastForward`), time still flowing from the pinned start
 * @param scale - the device scale factor, 2 for a close-up
 */
async function openQueuePage(harness: Harness, viewport: Viewport, readyText: string, isClockDriven = false, scale = 1): Promise<Page> {
  const { isMobile = false, ...size } = viewport;
  const page = await createPage(harness, { viewport: size, deviceScaleFactor: scale, isMobile, hasTouch: isMobile });
  // tsx keeps function names through an injected __name helper → the evaluated fact readers need it on the page
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await (isClockDriven ? page.clock.install({ time: FIXTURE_NOW }) : page.clock.setFixedTime(FIXTURE_NOW));
  await page.goto(`${harness.url}/#queue`, { waitUntil: "load" });
  await page.getByText(readyText).first().waitFor({ timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

/**
 * A fresh page whose CDN reads replay the harness's first fetch of each URL.
 * Each page is its own browser context with an empty HTTP cache → unreplayed, every one of the file's pages re-downloads
 * index.html's scripts and the web fonts, and the file outgrows the CI job's time.
 */
async function createPage(harness: Harness, options: Parameters<Browser["newPage"]>[0]): Promise<Page> {
  const page = await harness.browser.newPage(options);
  await page.route(/^https:\/\//, async (route) => {
    const url = route.request().url();
    const response = harness.responseByUrl.get(url) ?? getResponse(route, harness.responseByUrl);
    try {
      await route.fulfill(await response);
    } catch (error) {
      // a page closed while its read is in flight → nothing left to answer
      if (!page.isClosed()) throw error;
    }
  });
  return page;
}

// a failed fetch leaves no entry → the next page fetches the URL again
function getResponse(route: Route, responseByUrl: Map<string, Promise<CachedResponse>>): Promise<CachedResponse> {
  const url = route.request().url();
  const response = route.fetch().then(async (fetched) => ({ status: fetched.status(), headers: fetched.headers(), body: await fetched.body() }));
  responseByUrl.set(url, response);
  response.catch(() => responseByUrl.delete(url));
  return response;
}

const PARTLY_REDACTED_LINE = "✕ 1 of 2 copies was not redacted. Redact text again.";

// Redact text in the foot of the hop-1 relay's sheet (two copies, both ended → a Done row) → its confirmation over the sheet
async function askRedaction(page: Page): Promise<void> {
  await selectRow(page, FORWARDED_RELAY[0]!.id);
  await page.locator(".queue-sheet .card-foot .queue-note").getByRole("button", { name: "Redact text" }).click();
  await page.getByRole("dialog", { name: "Redact this relay's text?" }).waitFor();
}

function confirmRedaction(page: Page): Promise<void> {
  return page.getByRole("dialog", { name: "Redact this relay's text?" }).getByRole("button", { name: "Redact text" }).click();
}

// every copy refused → the dialog keeps the error slot's line: the given words, or (null) whatever outage step the page draws
async function refuseRedaction(page: Page, harness: Harness, refusal: { status: number; body: { error: string } }, line: string | null): Promise<void> {
  harness.refusals.set("redact", refusal);
  await askRedaction(page);
  await confirmRedaction(page);
  const slot = page.getByRole("dialog", { name: "Redact this relay's text?" }).locator(".queue-relay-error");
  await (line === null ? slot.locator("span.text-crit").waitFor() : slot.getByText(line).waitFor());
}

// the hop-1 relay's lapsed copy refused → one of two copies left
function refuseOneRedaction(harness: Harness): void {
  harness.refusals.set("redact", { status: 503, body: { error: "database_unavailable" }, ids: [FORWARDED_RELAY[1]!.id] });
}

function selectRow(page: Page, id: number): Promise<void> {
  return page.locator(`#queue-row-${id}`).click();
}

// a prose fixture item's sheet, once it shows the item's title, scrolled until the end of `selector` is in view
async function showSheetEnd(page: Page, id: number, selector: string): Promise<void> {
  await selectProseRow(page, id);
  await page.locator(selector).last().evaluate((node) => node.scrollIntoView({ block: "end" }));
}

async function selectProseRow(page: Page, id: number): Promise<void> {
  const title = getProseFixture().items.find((item) => item.id === id)?.title ?? "";
  await selectRow(page, id);
  await page.locator(".queue-sheet-title", { hasText: title }).waitFor();
}

const ORDER_BOX_ID = "queue-order-text";

async function pickWithNote(page: Page): Promise<void> {
  await selectRow(page, 103);
  await page.locator("#queue-option-103-R2").check();
  await page.locator("#queue-text-103").fill(NOTE_TEXT);
}

async function scrollList(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.querySelector(".queue-list > .card-body") as HTMLElement).scrollTop = 60;
  });
}

// the one list's done part (spec §4.6): its first Done band drawn under the open ones
async function waitForDoneBands(page: Page): Promise<void> {
  await page.locator(".queue-band", { hasText: "Done" }).first().waitFor();
}

// the list body scrolled so the first Done band stands at its top
async function scrollToDonePart(page: Page): Promise<void> {
  await waitForDoneBands(page);
  await scrollToBand(page, '[aria-label^="Done"]');
}

// the list body scrolled so the first band matching `band` (a group attribute selector) stands at its top
async function scrollToBand(page: Page, band: string): Promise<void> {
  await page.evaluate((selector) => {
    const body = document.querySelector(".queue-list > .card-body") as HTMLElement;
    const group = document.querySelector(`.queue-listbox [role="group"]${selector}`) as HTMLElement;
    body.scrollTop = group.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  }, band);
}

// Show more at the list's end pressed once, settled when the next done page has joined the list
async function showMoreDone(page: Page): Promise<void> {
  await waitForDoneBands(page);
  const loaded = await page.locator(".queue-row--done").count();
  await page.getByRole("button", { name: "Show more" }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".queue-row--done").length > count, loaded);
  await page.locator(".queue-row--done").last().scrollIntoViewIfNeeded();
}

// relay copy `id` sent under a name its sender gave itself
function getSelfNamedFixture(fixture: QueueFixture, id: number, selfDeclaredName: string): QueueFixture {
  return { ...fixture, items: fixture.items.map((item) => (item.id === id && item.relay !== null ? { ...item, relay: { ...item.relay, sender: { ...item.relay.sender, selfDeclaredName } } } : item)) };
}

async function tickSessions(page: Page, names: string[]): Promise<void> {
  for (const name of names) await page.getByLabel(`Select ${name}`).check();
}

// Orders is on screen at rest → ticking is all it takes to address it and scope its thread
async function tickOrdersTo(page: Page, names: string[]): Promise<void> {
  await tickSessions(page, names);
  await page.locator(".queue-thread").waitFor();
  await waitForImages(page);
}

// gersona and the edge fixture's ended portfolio, ticked once the Ended band is open
async function tickEndedOrdersTo(page: Page): Promise<void> {
  await openEndedBand(page);
  await tickOrdersTo(page, ["gersona", "portfolio"]);
}

// the Ended band opened → its rows on the rail
async function openEndedBand(page: Page): Promise<void> {
  await page.locator(".queue-rail-band .disclosure").click();
  await page.locator('.queue-rail-band .disclosure[aria-expanded="true"]').waitFor();
}

// a capture taken before the bubbles' images decode shows empty squares
async function waitForImages(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll("img")].every((img) => img.complete));
}

function getImageFile(index: number): { name: string; mimeType: string; buffer: Buffer } {
  const image = [...FIXTURE_IMAGES.values()][index % FIXTURE_IMAGES.size]!;
  return { name: `queue-0${(index % FIXTURE_IMAGES.size) + 1}.${image.view.type}`, mimeType: image.mime, buffer: image.bytes };
}

async function setFiles(page: Page, fieldId: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  await page.locator(`#${fieldId}-files`).setInputFiles(files);
}

async function addOrderFiles(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  await tickOrdersTo(page, ["gersona"]);
  await setFiles(page, ORDER_BOX_ID, files);
}

async function typeOrderWithImages(page: Page): Promise<void> {
  await tickOrdersTo(page, ORDER_TO);
  await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
  await setFiles(page, ORDER_BOX_ID, [0, 1, 2].map(getImageFile));
  await page.locator(".queue-thumb:not(.is-busy) img").nth(2).waitFor();
  await waitForImages(page);
}

async function sendOrderWithImages(page: Page): Promise<void> {
  await typeOrderWithImages(page);
  await page.locator(".queue-orders").getByRole("button", { name: /^Send to 2 sessions/ }).click();
  await page.locator(".queue-order", { hasText: FIXTURE_ORDER_TEXT }).waitFor();
  await waitForImages(page);
}

// the 15 s re-read finds a report yoaida posted since the first read
async function arriveItem(page: Page, harness: Harness, rest = getRestFixture()): Promise<void> {
  harness.fixture = getArrivalFixture(rest);
  await page.clock.fastForward(15_000);
  await page.locator(".nav-item", { hasText: "Queue" }).locator(".nav-count").filter({ hasText: "8" }).waitFor({ timeout: READY_TIMEOUT_MS });
}

// the edge state's long list, scrolled to its top → the report arriving at the end of its band lands past the visible part
async function arriveOffView(page: Page, harness: Harness): Promise<void> {
  harness.fixture = getArrivalFixture(getOffViewFixture());
  await page.clock.fastForward(15_000);
  await page.locator(".queue-status-new", { hasText: "1 new below" }).waitFor({ timeout: READY_TIMEOUT_MS });
}

// two images on the approval's tray, settled → stored, or failed under an upload refusal
async function addApprovalFiles(page: Page): Promise<void> {
  await selectRow(page, EDGE_IDS.approval);
  await setFiles(page, `queue-text-${EDGE_IDS.approval}`, [0, 1].map(getImageFile));
  await page.locator(".queue-sheet .queue-thumb:not(.is-busy)").nth(1).waitFor();
  await waitForImages(page);
}

// spec §9.8 → several at once, on an answer: two files of a refused type and a ninth image → the two-sentence refusal on the tray line
async function addRefusedApprovalFiles(page: Page): Promise<void> {
  const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n") });
  await selectRow(page, EDGE_IDS.approval);
  await setFiles(page, `queue-text-${EDGE_IDS.approval}`, [...Array.from({ length: 9 }, (_, index) => getImageFile(index)), pdf("plan.pdf"), pdf("notes.pdf")]);
  await page.locator(".queue-sheet .queue-thumb:not(.is-busy)").nth(7).waitFor();
  await page.locator(".queue-sheet", { hasText: "3 files were not added" }).waitFor();
  await waitForImages(page);
}

async function showAnswerImages(page: Page, id: number): Promise<void> {
  await selectRow(page, id);
  await page.locator(".queue-sheet .queue-bubble-image img").nth(1).waitFor();
  await waitForImages(page);
}

async function typeReportOrder(page: Page): Promise<void> {
  await selectRow(page, 101);
  await page.locator("#queue-reply-101").fill(REPLY_TEXT);
  await setFiles(page, "queue-reply-101", [getImageFile(0)]);
  await page.locator(".queue-sheet .queue-thumb:not(.is-busy) img").waitFor();
  await waitForImages(page);
}

// a file dragged over the order box, not yet dropped → the box's drop state
async function hangFileOverComposer(page: Page): Promise<void> {
  await tickOrdersTo(page, ["gersona"]);
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["png"], "queue-01.png", { type: "image/png" }));
    return data;
  });
  await page.dispatchEvent(`#${ORDER_BOX_ID}`, "dragover", { dataTransfer: transfer });
  await page.locator(".queue-compose-box.is-drop").waitFor();
}

// the list's In delivery rows and the mixed order's entry in view together
async function showNotListeningDesk(page: Page): Promise<void> {
  await page.locator(`#queue-row-${NOT_LISTENING_IDS.deafOrder}`).scrollIntoViewIfNeeded();
  await page.locator(`#queue-order-${NOT_LISTENING_IDS.mixedOrder}`).scrollIntoViewIfNeeded();
}

// a key press first → the browser treats the focus as keyboard focus and paints its ring
async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press("Tab");
  await target.focus();
}

/**
 * Desk column widths per viewport (spec 44063 §3.2): main = viewport − 268, two gaps of 16; the rail per step;
 * the middle pane the page — 66ch of the desk's text + two 32 gutters, measured in the page — or, below a 1505 window,
 * what Orders' minimum leaves: 272 under the 1440 step, which gives the 1280 rail and list row 16 and 32 more, else 320; Orders the rest.
 */
const DESK_WIDTHS = [
  { viewport: { width: 1280, height: 800 }, rail: 224, middle: 484 },
  { viewport: VIEWPORTS[0], rail: 232, middle: 588 },
  { viewport: { width: 1568, height: 759 }, rail: 232, middle: "page" },
  { viewport: VIEWPORTS[1], rail: 248, middle: "page" },
  { viewport: VIEWPORTS[2], rail: 248, middle: "page" },
  { viewport: { width: 2240, height: 1260 }, rail: 264, middle: "page" },
  { viewport: { width: 2560, height: 1440 }, rail: 280, middle: "page" },
] as const;
const SHELL_INLINE = 268;
const ORDERS = { MIN: { BELOW_1440: 272, FROM_1440: 320 }, COLUMN_MAX: 720 };

interface DeskFacts {
  isScrolled: boolean;
  rail: number[] | null;
  list: number[] | null;
  sheet: number[] | null;
  orders: number[] | null;
  page: number;
}

// each pane's painted box as [x, width]; a pane not rendered → null. `page`: 66ch of the desk's own text + two 32 gutters
async function getDeskFacts(page: Page): Promise<DeskFacts> {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      return [Math.round(rect.left), Math.round(rect.width)];
    };
    const desk = document.querySelector(".queue-desk") as HTMLElement;
    const probe = desk.appendChild(Object.assign(document.createElement("span"), { style: "position: absolute; width: calc(66ch + 64px)" }));
    const measure = probe.getBoundingClientRect().width;
    probe.remove();
    const scrollers = [document.scrollingElement, document.querySelector("main")].filter((node): node is Element => node !== null);
    return { isScrolled: scrollers.some((node) => node.scrollHeight > node.clientHeight), rail: box(".queue-sessions"), list: box(".queue-list"), sheet: box(".queue-sheet"), orders: box(".queue-orders"), page: Math.round(measure) };
  });
}

interface ListFacts {
  rowHeights: number[];
  bands: string[];
}

// painted row and band facts of spec §14.4, read on the list before a row is opened — an opened row puts the list away
async function getListFacts(page: Page): Promise<ListFacts> {
  return page.evaluate(() => {
    const probe = document.body.appendChild(Object.assign(document.createElement("div"), { style: "background: rgb(var(--surface))" }));
    const ground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      rowHeights: [...new Set([...document.querySelectorAll(".queue-row")].map((row) => Math.round(row.getBoundingClientRect().height)))].sort(),
      bands: [...new Set([...document.querySelectorAll(".queue-band")].map((band) => `${Math.round(band.getBoundingClientRect().height)} ${getComputedStyle(band).backgroundColor === ground}`))],
    };
  });
}

interface SheetFacts {
  text: string[];
  title: string[];
  isFootInView: boolean;
  starts: number[];
  ends: number[];
  gutters: number[];
}

// painted type and page-column facts of spec §14.4, read on an opened sheet
async function getSheetFacts(page: Page): Promise<SheetFacts> {
  return page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
    const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
    const text = document.querySelector(".queue-sheet .prose-text") as HTMLElement;
    const foot = document.querySelector(".queue-sheet > .card-foot")?.getBoundingClientRect();
    // the gutters from the card's inner edges, inside its 1 px border
    const sheet = document.querySelector(".queue-sheet") as HTMLElement;
    const card = sheet.getBoundingClientRect();
    const edge = { left: sheet.clientLeft, right: sheet.offsetWidth - sheet.clientWidth - sheet.clientLeft };
    const first = rect(".queue-sheet-head > :first-child");
    const last = rect(".queue-steps > .btn:last-child");
    return {
      text: [style(".queue-sheet .prose-text").fontSize, style(".queue-sheet .prose-text").lineHeight, String(text.getBoundingClientRect().width <= 590)],
      title: [style(".queue-sheet-title").fontSize, style(".queue-sheet-title").lineHeight],
      isFootInView: foot !== undefined && foot.bottom <= window.innerHeight && foot.height > 0,
      starts: [...new Set([".queue-sheet-head > :first-child", ".queue-date-line", ".queue-sheet-title", ".queue-sheet .prose-text", ".queue-sheet .queue-compose-box", ".queue-sheet .queue-note"].map((selector) => Math.round(rect(selector).left)))],
      ends: [...new Set([".queue-steps > .btn:last-child", ".queue-date-line > :last-child", ".queue-sheet .queue-note"].map((selector) => Math.round(rect(selector).right)))],
      gutters: [Math.round(first.left - card.left - edge.left), Math.round(card.right - edge.right - last.right)],
    };
  });
}

function getHeadHeights(page: Page, cards: string[]): Promise<number[]> {
  return page.evaluate((selectors) => selectors.map((selector) => Math.round(document.querySelector(`${selector} > .card-head`)?.getBoundingClientRect().height ?? -1)), cards);
}

// the right end of the header's control cluster, the header's last painted box
function getHeadEnd(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(document.querySelector(".page-head-cluster")?.getBoundingClientRect().right ?? -1));
}

interface ComposerFacts {
  box: number;
  buttons: number[];
  type: { text: string; button: string };
}

async function getComposerFacts(page: Page, root: string): Promise<ComposerFacts> {
  return page.evaluate((scope) => {
    const height = (element: Element) => Math.round(element.getBoundingClientRect().height);
    const type = (selector: string) => {
      const style = getComputedStyle(document.querySelector(`${scope} ${selector}`) as Element);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight].join(" / ");
    };
    return {
      box: height(document.querySelector(`${scope} .queue-compose-box`) as Element),
      buttons: [...new Set([...document.querySelectorAll(`${scope} .queue-compose-buttons .btn`)].map(height))],
      type: { text: type(".queue-compose-text"), button: type(".queue-compose-buttons .btn") },
    };
  }, root);
}

type ButtonRank = "primary" | "secondary" | "quiet" | "disabled";
interface ButtonLook { edgeWidth: string; edge: string; label: string; opacity: string }
interface ButtonFacts {
  tokens: Record<"controlEdge" | "ink" | "dim" | "faint" | "line" | "sunken", string>;
  buttons: Array<{ name: string; rank: ButtonRank; look: ButtonLook }>;
}

// every painted button of the Queue screen but a drawer's own close, with its rank read from its class and state
function getButtonFacts(): ButtonFacts {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => `rgb(${root.getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
  const tokens = { controlEdge: token("--control-edge"), ink: token("--ink"), dim: token("--dim"), faint: token("--faint"), line: token("--line"), sunken: token("--sunken") };
  const getRank = (element: Element): ButtonRank => {
    if ((element as HTMLButtonElement).disabled || (element.getAttribute("aria-disabled") === "true" && element.getAttribute("aria-busy") !== "true")) return "disabled";
    if (element.classList.contains("primary")) return "primary";
    return element.classList.contains("ghost") ? "quiet" : "secondary";
  };
  // a glyph-only button has its own §12.5 row (no edge) → the icon tests, never a word rank here
  const buttons = [...document.querySelectorAll(".queue-screen .btn")]
    .filter((element) => element.getClientRects().length > 0 && !element.closest(".detail-head") && !element.matches(".icon"))
    .map((element) => {
      const style = getComputedStyle(element);
      return {
        name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(),
        rank: getRank(element),
        look: { edgeWidth: style.borderTopWidth, edge: style.borderTopColor, label: style.color, opacity: style.opacity },
      };
    });
  return { tokens, buttons };
}

// the 0.12 s colour transition settles first → the state's own colours, never a mid-step
async function getSettledLook(button: Locator): Promise<{ fill: string; edge: string; label: string }> {
  return button.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, edge: style.borderTopColor, label: style.color };
  });
}

// spec §12.5 rest looks: the edge by rank, a quiet label dim, a disabled one on the line edge with a faint label at full strength
function getRankLook(tokens: ButtonFacts["tokens"], button: ButtonFacts["buttons"][number]): ButtonLook {
  const edge = { primary: tokens.ink, secondary: tokens.controlEdge, quiet: tokens.controlEdge, disabled: tokens.line }[button.rank];
  const label = { quiet: tokens.dim, disabled: tokens.faint }[button.rank as "quiet" | "disabled"] ?? button.look.label;
  return { edgeWidth: "1px", edge, label, opacity: "1" };
}

interface IconLook { name: string; title: string; size: number[]; text: string; isEdgeless: boolean; fill: string; glyph: string; isDrawn: boolean; isDisabled: boolean }

// every painted glyph-only button of the Queue screen, its image viewer's bar included; colour transitions settled first → the state's own colours
async function getIconLooks(): Promise<IconLook[]> {
  const buttons = [...document.querySelectorAll(".queue-screen .btn.icon")].filter((element) => element.getClientRects().length > 0);
  await Promise.all(buttons.flatMap((element) => element.getAnimations().map((animation) => animation.finished)));
  return buttons
    .map((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const svg = element.querySelector("svg");
      return {
        name: element.getAttribute("aria-label") ?? "",
        title: element.getAttribute("title") ?? "",
        size: [Math.round(box.width), Math.round(box.height)],
        text: (element.textContent ?? "").trim(),
        isEdgeless: parseFloat(style.borderTopWidth) === 0 || style.borderTopColor === "rgba(0, 0, 0, 0)",
        fill: style.backgroundColor,
        glyph: style.color,
        // an unknown Lucide name draws an empty svg with no error → a drawn glyph has child shapes
        isDrawn: svg !== null && svg.childElementCount > 0,
        isDisabled: (element as HTMLButtonElement).disabled,
      };
    });
}

// the colour a token computes to on this page through one property → `background-color` for a fill (`var(--tint-select)`), `color` for a triplet (`rgb(var(--ok))`)
function getTokenPaint({ property, value }: { property: "background-color" | "color"; value: string }): string {
  const probe = document.createElement("div");
  probe.style.setProperty(property, value);
  document.body.append(probe);
  const paint = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return paint;
}

// the two fills under the pointer, in token order: `--tint-select` hovered, `--tint-fill` held
async function getTintFills(page: Page): Promise<string[]> {
  return Promise.all(["--tint-select", "--tint-fill"].map((token) => page.evaluate(getTokenPaint, { property: "background-color" as const, value: `var(${token})` })));
}

// the keyboard ring as painted: whether :focus-visible holds, the outline's colour, style and width, its offset
async function getFocusRing(target: Locator): Promise<{ isVisible: boolean; outline: string; offset: string }> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { isVisible: element.matches(":focus-visible"), outline: `${style.outlineColor} ${style.outlineStyle} ${style.outlineWidth}`, offset: style.outlineOffset };
  });
}

// the `--focus-ring` triplet in computed-colour form (`r, g, b`)
async function getRingToken(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim().split(/\s+/).join(", "));
}

async function openEdgePage(harness: Harness, viewport: { width: number; height: number } = VIEWPORTS[0]): Promise<Page> {
  harness.fixture = getEdgeFixture();
  return openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
}

// no tick → every order in the thread, its images decoded
// an entry of the thread brought into view by a text it shows
async function showThreadText(page: Page, text: string): Promise<void> {
  const shown = page.locator(".queue-thread").getByText(text);
  await shown.waitFor();
  await shown.scrollIntoViewIfNeeded();
}

async function waitForAllOrders(page: Page): Promise<void> {
  await page.locator(".queue-order").first().waitFor();
  await waitForImages(page);
}

/**
 * Every state at each of its sizes, each on a fresh page, as `<dir>/<width>x<height>-<nn>-<name>.png`.
 * @returns one line per capture whose setUp failed, so one broken state does not hide the others
 */
async function captureQueueStates(harness: Harness, dir: string): Promise<string[]> {
  const failures: string[] = [];
  for (const state of QUEUE_STATES) {
    for (const viewport of getStateViewports(state)) {
      await captureQueueState(harness, dir, viewport, state).catch((error: unknown) => {
        failures.push(`${getShotName(viewport, state)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      });
    }
  }
  return failures;
}

async function captureQueueState(harness: Harness, dir: string, viewport: Viewport, state: QueueState): Promise<void> {
  const path = join(dir, getShotName(viewport, state));
  // an entry transition still running → a half-faded surface; disabled → each capture shows the state's end frame
  await readQueueState(harness, viewport, state, (page) => page.screenshot(state.isFirstLoad === true ? { path } : { path, animations: "disabled" }));
}

/** Drives a page to the named state on its fixture, reads it with `read`, and closes it. */
async function readQueueState<T>(harness: Harness, viewport: Viewport, state: QueueState, read: (page: Page) => Promise<T>): Promise<T> {
  harness.fixture = state.getFixture?.() ?? getRestFixture();
  harness.refusals.clear();
  if (state.isFirstLoad === true) return readFirstLoad(harness, viewport, read);
  const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture), state.isClockDriven);
  try {
    await state.setUp?.(page, harness);
    return await read(page);
  } finally {
    harness.isListDown = false;
    await page.close();
  }
}

// a sentence the page shows holds at most 12 words (spec §12.6) — a command or id counts as one, a lone mark (`·`, `/`, `+`) as none
const SENTENCE_WORDS_MAX = 12;

/**
 * The page's own sentences over 12 words in a named state: every line it shows, a session's prose left out, each
 * multi-word string of the fixture (session-written) and each command or id (`code`) folded to one word.
 */
async function getLongSentences(page: Page, fixture: QueueFixture): Promise<string[]> {
  // a code span and a <time> are one value each, whatever spaces their text holds
  const [shown, prose, codes] = await page.evaluate(() => ["body", ".prose-text", "code, time"].map((selector) => [...document.querySelectorAll<HTMLElement>(selector)]
    .flatMap((node) => node.innerText.split("\n")).map((line) => line.trim()).filter((line) => line !== "")));
  const lines = shown!.filter((line) => !prose!.includes(line));
  const folded = [...new Set([...getFixtureStrings(fixture).filter((text) => /\s/.test(text.trim())), ...codes!])].sort((a, b) => b.length - a.length);
  return lines
    .map((line) => folded.reduce((text, one) => text.split(one).join(" ‹text› "), line))
    .flatMap((line) => line.split(/(?<=[.?!])\s+/))
    // spec §12.7 counts a hop line's `Hop N` lead as its own part
    .flatMap((sentence) => sentence.split(/(?<=^Hop \d+) · /))
    .filter((sentence) => sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}‹]/u.test(word)).length > SENTENCE_WORDS_MAX);
}

function getFixtureStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(getFixtureStrings);
}

/** @returns the element's box in CSS pixels, read in the frame the close-up shows */
async function captureCloseUp(harness: Harness, dir: string, state: CloseUpState): Promise<{ width: number; height: number }> {
  harness.fixture = state.getFixture?.() ?? getRestFixture();
  const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), false, 2);
  try {
    await state.setUp?.(page, harness);
    const element = page.locator(state.closeUp).first();
    await element.screenshot({ path: join(dir, getShotName(VIEWPORTS[0], state)), animations: "disabled" });
    // the whole CSS pixels the box touches → what the screenshot clip covers, a fractional edge included
    return await element.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { width: Math.ceil(rect.right) - Math.floor(rect.left), height: Math.ceil(rect.bottom) - Math.floor(rect.top) };
    });
  } finally {
    await page.close();
  }
}

// the item, session and order reads held open → the three cards' placeholders (spec §10, desk first load), captured once drawn
async function readFirstLoad<T>(harness: Harness, viewport: Viewport, read: (page: Page) => Promise<T>): Promise<T> {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  harness.heldRead = held;
  harness.heldDesk = held;
  const page = await createPage(harness, { viewport });
  try {
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.goto(`${harness.url}/#queue`, { waitUntil: "load" });
    await page.locator(".queue-screen").waitFor({ timeout: READY_TIMEOUT_MS });
    for (const text of ["Loading sessions…", "Loading the queue…", "Loading orders…"]) await page.getByText(text).waitFor({ timeout: READY_TIMEOUT_MS });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return await read(page);
  } finally {
    release();
    harness.heldRead = null;
    harness.heldDesk = null;
    await page.close();
  }
}

function getStateViewports(state: QueueState): readonly Viewport[] {
  return state.viewports ?? VIEWPORTS;
}

function getShotName(viewport: Viewport, state: QueueState): string {
  return `${viewport.width}x${viewport.height}-${state.nn}-${state.name}.png`;
}

async function getShotsDir(t: TestContext): Promise<string> {
  const named = process.env.QUEUE_SHOTS_DIR;
  if (named === undefined || named === "") {
    const dir = await mkdtemp(join(tmpdir(), SHOTS_PREFIX));
    t.after(() => deleteTempDirectory(dir, SHOTS_PREFIX));
    return dir;
  }
  if (!isAbsolute(named)) throw new Error(`QUEUE_SHOTS_DIR must be an absolute path, got "${named}"`);
  await mkdir(named, { recursive: true });
  return named;
}

// in the page: each rail line's resolved columns from its content start, and every slot that falls outside its own column
function getRailColumnFacts() {
  const SLOTS = [".queue-rail-box", ".queue-rail-mark", ".queue-rail-name, .queue-rail-all, .disclosure > span:last-child", ".queue-rail-tag", ".queue-rail-count"];
  const lines = [...document.querySelectorAll<HTMLElement>(".queue-sessions .queue-rail-band, .queue-sessions .queue-rail-row")];
  const getColumns = (line: HTMLElement) => {
    const style = getComputedStyle(line);
    const gap = parseFloat(style.columnGap);
    let x = line.getBoundingClientRect().left + parseFloat(style.paddingLeft);
    return style.gridTemplateColumns.split(" ").map((track) => {
      const column = { left: x, right: x + parseFloat(track) };
      x = column.right + gap;
      return column;
    });
  };
  const slots = { tag: 0, count: 0 };
  const misplaced = lines.flatMap((line) => {
    const columns = getColumns(line);
    return SLOTS.flatMap((selector, index) => [...line.querySelectorAll(`:scope > :is(${selector}), :scope > .disclosure > :is(${selector})`)].flatMap((slot) => {
      if (index === 3) slots.tag += 1;
      if (index === 4) slots.count += 1;
      const box = slot.getBoundingClientRect();
      const column = columns[index] as { left: number; right: number };
      return box.left >= column.left - 0.5 && box.right <= column.right + 0.5 ? [] : [`${line.dataset.session ?? line.textContent}: ${selector}`];
    }));
  });
  const getHeights = (selector: string) => [...new Set(lines.filter((line) => line.matches(selector)).map((line) => Math.round(line.getBoundingClientRect().height)))];
  return {
    lines: lines.length,
    starts: new Set(lines.map((line) => getColumns(line).map((column) => Math.round(column.left)).join(","))).size,
    tracks: [...new Set(lines.map((line) => getComputedStyle(line).gridTemplateColumns))].map((tracks) => tracks.split(" ").map((track) => Math.round(parseFloat(track)))),
    misplaced, slots, rows: getHeights(".queue-rail-row"), bands: getHeights(".queue-rail-band"),
    isAllWhole: [...document.querySelectorAll(".queue-rail-all")].every((label) => label.scrollWidth <= label.clientWidth),
  };
}

// PNG IHDR: width and height as big-endian words at bytes 16 and 20
async function getPngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// the first item's title, or the empty list's line → the list read has answered
function getRestReadyText(fixture = getRestFixture()): string {
  return fixture.items[0]?.title ?? fixture.done?.[0]?.title ?? "Nothing is waiting for you";
}

describe("queue page on the mockup fixtures", () => {
  let harness: Harness;

  before(async () => {
    harness = await openHarness();
  });

  after(() => closeHarness(harness));

  test("every queue read the page makes at rest is answered by a fixture route", async () => {
    harness.fixture = getRestFixture();
    harness.missedReads.length = 0;
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.close();

    assert.deepEqual(harness.missedReads, []);
  });

  test("text a session wrote renders as text: its markup shows literally and adds no element", async () => {
    const rest = getRestFixture();
    const [report] = rest.items;
    harness.fixture = { ...rest, items: [{ ...report!, title: MARKUP_TITLE, body: MARKUP_BODY }] };
    const page = await openQueuePage(harness, VIEWPORTS[0], MARKUP_TITLE);
    await selectRow(page, report!.id);
    const found = await page.evaluate(() => ({
      probes: document.querySelectorAll("[data-markup-probe]").length,
      hasRun: (window as unknown as { __markupRan?: boolean }).__markupRan === true,
      hasBodyText: document.body.innerText.includes("<img data-markup-probe"),
    }));
    await page.close();

    assert.deepEqual(found, { probes: 0, hasRun: false, hasBodyText: true });
  });

  // spec §5 → Where it renders: a fence over 20 lines folds on a report, never on an open decision (C-no-fold-on-decisions)
  test("a report's 30-line fence folds under Show all 30 lines; an open approval-class decision's shows every line", async () => {
    harness.fixture = getProseFixture();
    const read = async (id: number) => {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
      await showSheetEnd(page, id, ".queue-sheet .prose-pre");
      const found = await page.evaluate(() => ({
        folds: [...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-fold summary")].map((summary) => summary.innerText.trim()),
        lines: [...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-pre")].map((pre) => pre.innerText.split("\n").length),
      }));
      await page.close();
      return found;
    };
    const report = await read(101);
    const decision = await read(103);

    assert.deepEqual({ report, decision }, { report: { folds: ["Show all 30 lines"], lines: [20] }, decision: { folds: [], lines: [30] } });
  });

  // spec §5 → As sent, §9.9: the sender's Markdown is its own characters, and the label says so before the text starts (C-relay-as-sent)
  test("a relay holding every block form is one pre-wrap text node on its sheet, in the sheet's 15 / 24 type, under the shown-as-sent cue", async () => {
    harness.fixture = getProseFixture();
    const relay = harness.fixture.items.find((item) => item.id === RELAY_ROW_IDS.one);
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await selectRow(page, RELAY_ROW_IDS.one);
    await page.locator(".queue-sheet .card-foot", { hasText: "Read-only." }).waitFor();
    const found = await page.evaluate(() => {
      const texts = [...document.querySelectorAll<HTMLElement>(".queue-sheet .prose-text--as-sent")];
      const style = getComputedStyle(texts[0] as HTMLElement);
      return {
        count: texts.length, nodes: [...(texts[0]?.childNodes ?? [])].map((node) => node.nodeName), text: texts[0]?.textContent,
        type: [style.whiteSpace, style.fontSize, style.lineHeight, texts[0]?.dir],
        parsed: document.querySelectorAll(".queue-sheet-body :is(h4, h5, table, blockquote, hr, pre, ul, ol, img)").length,
        label: [...document.querySelectorAll<HTMLElement>(".queue-sheet-body p")].find((line) => line.innerText.startsWith("What "))?.innerText,
      };
    });
    await page.close();

    assert.deepEqual(found, {
      count: 1, nodes: ["#text"], text: relay?.body, type: ["pre-wrap", "15px", "24px", "auto"], parsed: 0, label: "What aidl (self-named) wrote · shown as sent",
    });
  });

  // spec §5 → One container (C-names-and-mimicry): the page's own parts never sit in, or dress as, the text a session wrote
  test("the Options legend, the Recommended badge, the approval line and Your answer stand outside the prose container and take no prose class", async () => {
    harness.fixture = getProseFixture();
    const read = async (id: number, parts: string[]) => {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
      await selectProseRow(page, id);
      const found = await page.evaluate((names) => names.map((name) => {
        const part = name === "Approval" ? document.querySelector(".queue-sheet .queue-approval-line")
          : [...document.querySelectorAll(".queue-sheet *")].filter((node) => node.textContent?.trim() === name).at(-1);
        const classes = part ? [part, ...part.querySelectorAll("*")].flatMap((node) => [...node.classList]) : [];
        return { name, isFound: part !== undefined && part !== null, isInProse: part?.closest(".prose-text") != null, proseClasses: classes.filter((name) => name.startsWith("prose-")) };
      }), parts);
      await page.close();
      return found;
    };
    const decision = await read(103, ["Options", "Recommended", "Approval"]);
    const answered = await read(108, ["Your answer"]);

    assert.deepEqual([...decision, ...answered], ["Options", "Recommended", "Approval", "Your answer"].map((name) => ({ name, isFound: true, isInProse: false, proseClasses: [] })));
  });

  // layout §6 → Gone: a relay is a row and its sheet → no route serves the relay signal or a single item, so a read of either is a missed read
  test("no element reads Relay history, and the page reads neither the relay signal nor a single item at rest, on its tick or on a relay's sheet", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.missedReads.length = 0;
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), true);
    await page.clock.fastForward(15_000);
    await selectRow(page, FORWARDED_RELAY[0]!.id);
    await page.locator(".queue-sheet .card-foot .queue-note").waitFor();
    const named = await page.getByText(/Relay history/).count();
    await page.close();

    assert.deepEqual({ named, missedReads: harness.missedReads }, { named: 0, missedReads: [] });
  });

  // layout §6 → Gone: the rail foot holds one button, Automatic resumes
  test("the rail foot holds one button, Automatic resumes, its label on one line inside the foot at every window width, with relays on record", async () => {
    harness.fixture = getRelayRecordFixture();
    const found = [];
    for (const viewport of [MIN_WINDOW, ...VIEWPORTS]) {
      const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
      const buttons = await page.locator(".queue-sessions > .card-foot").evaluate((foot) => {
        const end = foot.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(foot).paddingRight);
        return [...foot.querySelectorAll("button")].map((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          // each text box's vertical centre; a glyph and a word on one line sit within a few pixels of each other
          const centres = [...range.getClientRects()].map((rect) => rect.top + rect.height / 2).sort((a, b) => a - b);
          const lines = centres.filter((centre, index) => index === 0 || centre - centres[index - 1]! > 6).length;
          return { label: button.textContent?.trim(), lines, isInside: button.getBoundingClientRect().right <= end + 0.5 };
        });
      });
      await page.close();
      found.push({ width: viewport.width, buttons });
    }

    assert.deepEqual(found, [MIN_WINDOW, ...VIEWPORTS].map(({ width }) => ({
      width,
      buttons: [{ label: "Automatic resumes 2", lines: 1, isInside: true }],
    })));
  });

  // layout §2 → Who: a To line is one line ending in its whole outcome; the place gives way first, its full text in its title
  test("every To line on a relay sheet, on its way, Done or refused, is one line at 1280, 1440 and 1568, its state and outcome whole at its end and a cut place whole in its title", async () => {
    harness.fixture = getRelayListFixture();
    const sheets = [
      { row: `#queue-row-${RELAY_ROW_IDS.several}`, title: "to 3 sessions" },
      { row: `#queue-row-${FORWARDED_RELAY[0]!.id}`, title: "to 2 sessions" },
      { row: '.queue-row[aria-label^="Refused relay"]', title: "Refused relay from" },
    ];
    const found = [];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
      // an open sheet takes the list's place at 1280 → each sheet from a fresh page
      for (const sheet of sheets) {
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await waitForDoneBands(page);
        await page.locator(sheet.row).click();
        await page.locator(".queue-sheet-title", { hasText: sheet.title }).waitFor();
        const lines = await page.locator(".queue-sheet .queue-relay-to").evaluateAll((tos) => tos.map((to) => {
          const lineHeight = Number.parseFloat(getComputedStyle(to).lineHeight);
          const place = to.querySelector<HTMLElement>(".queue-relay-place");
          // the line's last part: the recipient's state and its outcome, or a refused end's id
          const end = to.lastElementChild as HTMLElement;
          return {
            isOneLine: to.getBoundingClientRect().height <= lineHeight + 0.5,
            isEndWhole: end.scrollWidth <= end.getBoundingClientRect().width + 0.5 && end.getBoundingClientRect().right <= to.getBoundingClientRect().right + 0.5,
            isPlaceTitled: place === null || place.scrollWidth <= place.clientWidth + 0.5 || place.title === place.textContent,
          };
        }));
        await page.close();
        found.push({ width: viewport.width, title: sheet.title, lines });
      }
    }

    const counts = new Map([["to 3 sessions", 3], ["to 2 sessions", 2], ["Refused relay from", 1]]);
    assert.deepEqual(found, [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW].flatMap(({ width }) => sheets.map(({ title }) => ({
      width, title, lines: Array.from({ length: counts.get(title)! }, () => ({ isOneLine: true, isEndWhole: true, isPlaceTitled: true })),
    }))));
  });

  // layout §6 → Order: In delivery reads newest first by its age key, a relay's send, the redacted relay from the relay read among them
  test("In delivery runs newest first by each row's age, the redacted relay from the relay read in its time's place", async () => {
    harness.fixture = getRelayListFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await waitForDoneBands(page);
    const rows = await page.locator('.queue-listbox [role="group"]', { has: page.locator(".queue-band", { hasText: "In delivery" }) })
      .evaluate((band) => [...band.querySelectorAll(".queue-row")].map((row) => ({
        at: row.querySelector(".queue-row-age")?.getAttribute("title") ?? "",
        isRedacted: row.querySelector(".queue-row-title")?.textContent?.includes("Text redacted") === true,
      })));
    await page.close();

    const ats = rows.map((row) => row.at);
    assert.deepEqual(ats, [...ats].sort().reverse());
    assert.deepEqual([rows.length > 2, rows.filter((row) => row.isRedacted).length], [true, 1]);
  });

  // layout §1 → Reads and Show more: Show more keeps one place at the list's end, a refusal cut's one short line after it
  test("Show more keeps its place and one line at the list's end beside a refusal cut's one short line, at 1280, 1440 and 1568", async () => {
    const found = [];
    for (const isRefusalListCut of [false, true]) {
      harness.fixture = getRelayListFixture(isRefusalListCut);
      for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
        const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
        await waitForDoneBands(page);
        const end = await page.locator(".queue-list-end").evaluate((line) => {
          const button = line.querySelector("button") as HTMLElement;
          return {
            text: line.textContent,
            height: Math.round(line.getBoundingClientRect().height),
            inset: Math.round(button.getBoundingClientRect().left - line.getBoundingClientRect().left),
            buttonHeight: Math.round(button.getBoundingClientRect().height),
          };
        });
        await page.close();
        found.push({ width: viewport.width, ...end });
      }
    }

    const widths = [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW].map(({ width }) => width);
    assert.deepEqual(found, ["Show more", "Show more⚠ Refusals before Nov 13 12:00 not listed."].flatMap((text) => widths.map((width) => ({ width, text, height: 44, inset: 16, buttonHeight: 32 }))));
  });

  test("Redact text in a relay sheet's foot asks over the sheet, centred on its column, with the focus on Cancel; one copy refused keeps the dialog with its count line and the sheet its text and button", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.refusals.clear();
    refuseOneRedaction(harness);
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await askRedaction(page);
    // the dialog is the sheet's own act → centred on the sheet's column, not on the viewport
    const asked = await page.evaluate(() => {
      const getCentre = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return Math.round(box.left + box.width / 2);
      };
      return { focused: document.activeElement?.textContent, offCentre: getCentre('[role="dialog"]') - getCentre(".queue-sheet") };
    });
    await confirmRedaction(page);
    await page.getByText(PARTLY_REDACTED_LINE).waitFor();
    const sheet = page.locator(".queue-sheet");
    const kept = { button: await sheet.locator(".card-foot .queue-note").getByRole("button", { name: "Redact text" }).count(), text: (await sheet.locator(".prose-text--as-sent").innerText()).includes("파트너 연동") };
    await page.close();
    harness.refusals.clear();

    assert.deepEqual({ ...asked, kept }, { focused: "Cancel", offCentre: 0, kept: { button: 1, text: true } });
  });

  test("a redaction done closes the dialog, puts the redaction line in the text's place and Text redacted on the foot, the focus on the sheet's title, and the row's title reads Text redacted", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.refusals.clear();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await askRedaction(page);
    await confirmRedaction(page);
    await page.locator(".queue-sheet .card-foot", { hasText: "Text redacted." }).waitFor();
    await page.getByRole("dialog", { name: "Redact this relay's text?" }).waitFor({ state: "detached" });
    const found = await page.evaluate(() => ({
      focused: document.activeElement?.tagName === "H3" ? document.activeElement.textContent : null,
      foot: (document.querySelector<HTMLElement>(".queue-sheet .card-foot")?.innerText ?? "").trim(),
      texts: document.querySelectorAll(".queue-sheet .prose-text--as-sent").length,
      line: [...document.querySelectorAll<HTMLElement>(".queue-sheet-body p")].some((line) => /^Text redacted \S+ \S+ KST · it was [\d,]+ characters long$/.test(line.innerText)),
      marker: document.querySelector(".queue-sheet")?.textContent?.includes("relay text redacted by the owner") ?? true,
    }));
    await page.getByRole("button", { name: /^Back to the list/ }).click();
    const title = await page.locator(`#queue-row-${FORWARDED_RELAY[0]!.id} .queue-row-title`).innerText();
    await page.close();

    assert.deepEqual(
      { ...found, title: title.replace(/\s+/g, " ").trim() },
      { focused: "Message from aidl (self-named) to 2 sessions", foot: "✓ Text redacted.", texts: 0, line: true, marker: false, title: "→ 2 sessions Text redacted" },
    );
  });

  test("the redaction dialog draws its body at the body size and Cancel then Redact text at the foot's end", async () => {
    harness.fixture = getRelayRecordFixture();
    harness.refusals.clear();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await askRedaction(page);
    const found = await page.getByRole("dialog", { name: "Redact this relay's text?" }).evaluate((surface) => {
      const foot = surface.querySelector(".detail-foot");
      const buttons = [...(foot?.querySelectorAll("button") ?? [])];
      const footEnd = foot === null ? 0 : foot.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(foot).paddingRight);
      const body = surface.querySelector(".detail-body p");
      return {
        buttons: buttons.map((button) => button.textContent),
        // the panel is centred on a fractional x → the button edge snaps within a pixel of the foot's content end
        isAtEnd: Math.abs(footEnd - (buttons.at(-1)?.getBoundingClientRect().right ?? 0)) < 1,
        bodySize: body === null ? "" : getComputedStyle(body).fontSize,
      };
    });
    await page.close();

    assert.deepEqual(found, { buttons: ["Cancel", "Redact text"], isAtEnd: true, bodySize: "15px" });
  });

  test("the history read pages by order and returns every copy of an order one ticked session received", async () => {
    harness.fixture = getRestFixture();
    const first = await harness.app.inject({ url: `/api/queue/owner/orders?sessionIds=${FIXTURE_SESSION_IDS.aidl}&limit=1` });
    const all = await harness.app.inject({ url: "/api/queue/owner/orders?limit=2" });
    const { nextCursor } = all.json<{ nextCursor: string }>();
    const rest = await harness.app.inject({ url: `/api/queue/owner/orders?limit=30&before=${nextCursor}` });
    const getSendIds = (body: { items: Array<{ sendId: string }> }) => [...new Set(body.items.map((item) => item.sendId))];

    assert.deepEqual(first.json<{ items: Array<{ session: { name: string } }> }>().items.map((item) => item.session.name), ["gersona", "aidl"], "both recipients of the order to aidl");
    const pages = [...getSendIds(all.json()), ...getSendIds(rest.json())];
    assert.equal(new Set(pages).size, pages.length, "no order on two pages");
    assert.equal(pages.length, new Set(getRestFixture().orders.map((order) => order.sendId)).size, "every order on some page");
  });

  test("the desk fills the window with no page scroll, the rail, the middle pane and Orders sized per width step, and an opened row's sheet takes the list's box", async () => {
    harness.fixture = getRestFixture();
    for (const row of DESK_WIDTHS) {
      const page = await openQueuePage(harness, row.viewport, getRestReadyText());
      const rest = await getDeskFacts(page);
      await selectRow(page, 101);
      const opened = await getDeskFacts(page);
      await page.close();
      const size = `${row.viewport.width}x${row.viewport.height}`;
      const middle = row.middle === "page" ? rest.page : row.middle;
      const orders = row.viewport.width - SHELL_INLINE - row.rail - middle - 32;
      assert.ok(orders >= (row.viewport.width < 1440 ? ORDERS.MIN.BELOW_1440 : ORDERS.MIN.FROM_1440), `${size}: Orders ${orders} keeps its minimum`);
      assert.deepEqual([rest.isScrolled, rest.rail?.[1], rest.list?.[1], rest.sheet, rest.orders?.[1]], [false, row.rail, middle, null, orders], `${size} at rest`);
      assert.deepEqual(opened, { ...rest, list: null, sheet: rest.list }, `${size} with a row opened`);
    }
  });

  test("the sheet's text is 15/24 within 66ch, its title 20/28, rows 44, bands 32 on the page ground, and its foot in view", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const list = await getListFacts(page);
    await selectRow(page, 101);
    const sheet = await getSheetFacts(page);
    await page.close();
    assert.deepEqual({ isRowHeight: list.rowHeights.length > 0 && list.rowHeights.every((height) => height === 44), bands: list.bands }, { isRowHeight: true, bands: ["32 true"] }, String(list.rowHeights));
    assert.deepEqual({ text: sheet.text, title: sheet.title, isFootInView: sheet.isFootInView }, { text: ["15px", "24px", "true"], title: ["20px", "28px"], isFootInView: true });
  });

  // spec §3.2: one page column for head, body and foot, the pane's constant 32 inset on both sides at every width
  test("the sheet's head, date line, title, text, box and note start at one x and end at one x, on gutters of 32, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const columns = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      await selectRow(page, 101);
      const { starts, ends, gutters } = await getSheetFacts(page);
      await page.close();
      columns.push({ width: viewport.width, starts: starts.length, ends: ends.length, gutters });
    }

    assert.deepEqual(columns, columns.map(({ width }) => ({ width, starts: 1, ends: 1, gutters: [32, 32] })));
  });

  // spec §4.3 / §14.4: the stepping counts the rows that open on a sheet; an order's row is never on the sheet
  test("the sheet's head says n of m, previous is off on the first sheet row, J steps over an order's row with item= following, and K comes back", async () => {
    harness.fixture = getOrderFirstFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    const head = () => page.evaluate(() => ({
      hash: window.location.hash,
      position: document.querySelector(".queue-steps > .tabular-nums")?.textContent,
      disabled: [...document.querySelectorAll<HTMLButtonElement>(".queue-steps > .btn")].map((button) => button.disabled),
      tag: document.querySelector(".queue-sheet-head .pill--tag")?.textContent,
    }));
    const firstRow = await page.locator(".queue-row").first().getAttribute("id");
    await selectRow(page, 160);
    const first = await head();
    await page.keyboard.press("j");
    const second = await head();
    await page.keyboard.press("k");
    const back = await head();
    await page.close();

    assert.equal(firstRow, "queue-row-109", "the list's first row is an order");
    assert.deepEqual(first, { hash: "#queue?item=160", position: "1 of 2", disabled: [true, false], tag: "Answer" });
    assert.deepEqual(second, { hash: "#queue?item=108", position: "2 of 2", disabled: [false, true], tag: "Answer" });
    assert.equal(back.hash, "#queue?item=160");
  });

  // spec §7, §9.8 → On an answer → Afterwards: the images the session received, the thread's 96 squares under Your answer
  test("an answered decision's row names its images, and its sheet shows them as 96 thumbnails under Your answer that open the viewer", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    const row = await page.locator("#queue-row-108").getAttribute("aria-label");
    await showAnswerImages(page, 108);
    const thumbs = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-sheet .queue-bubble-image")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label"), size: [Math.round(rect.width), Math.round(rect.height)] };
    }));
    await page.locator(".queue-sheet .queue-bubble-image").nth(1).click();
    const viewer = (await page.locator(".queue-viewer").innerText()).replace(/\s+/g, " ");
    await page.close();

    assert.match(row ?? "", /2 images/);
    assert.deepEqual(thumbs, [{ label: "Open image 1 of 2: queue-01.webp", size: [96, 96] }, { label: "Open image 2 of 2: queue-02.webp", size: [96, 96] }]);
    assert.match(viewer, /queue-02\.webp · .* · 2 of 2/);
  });

  // spec §3.3 / §14.4: the list keeps its place while a report is read
  test("Back to the list shows the list at the scroll it had, the row just read focused and current, and the hash without item", async () => {
    const page = await openEdgePage(harness);
    const top = await page.evaluate(() => {
      const body = document.querySelector(".queue-list > .card-body") as HTMLElement;
      body.scrollTop = 240;
      return body.scrollTop;
    });
    const row = page.locator(".queue-row").nth(6);
    const id = await row.getAttribute("id");
    await row.click();
    await page.getByRole("button", { name: "Back to the list" }).click();
    const back = await page.evaluate(() => ({
      top: (document.querySelector(".queue-list > .card-body") as HTMLElement).scrollTop,
      focus: document.activeElement?.id,
      current: [...document.querySelectorAll('[role="option"][aria-selected="true"]')].map((option) => option.id),
      hash: window.location.hash,
      isSheet: document.querySelector(".queue-sheet") !== null,
    }));
    await page.close();

    assert.ok(top > 0, "the edge list scrolls");
    assert.deepEqual(back, { top, focus: id, current: [id], hash: "#queue", isSheet: false });
  });

  // spec §3.2 / §4.2: the list shares the fixed middle pane → never wide enough for another row form
  test("list rows are 44 high at every desk width, 2560 included", async () => {
    harness.fixture = getRestFixture();
    const heights = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const { rowHeights } = await getListFacts(page);
      await page.close();
      heights.push({ width: viewport.width, isRowHeight: rowHeights.length > 0 && rowHeights.every((height) => height === 44), rowHeights });
    }

    assert.deepEqual(heights.filter((row) => !row.isRowHeight), []);
  });

  // one sender reads as one name on every row; a self-declared name's mark stands whole beside it, outside the cut, its words in the tooltips;
  // the fixture's longest name, nine letters, self-named on relay 421 → name and mark still whole in the name column, every title on one x
  test("a sender's name paints the same on its decision, refused and relay rows at 1280, 1440 and 1568, and only a self-named relay row adds the whole self mark, a nine-letter name whole beside it and every title on one x", async () => {
    harness.fixture = getSelfNamedFixture(getRelayListFixture(true), RELAY_ROW_IDS.one, "portfolio");
    const shown = [];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
      const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
      await waitForDoneBands(page);
      const rows = await page.evaluate(() => [...document.querySelectorAll(".queue-row")].flatMap((row) => {
        const name = row.querySelector<HTMLElement>(".queue-row-name");
        if (name === null) return [];
        const mark = row.querySelector<HTMLElement>(".queue-row-mark");
        const who = row.querySelector(".queue-row-who")!.getBoundingClientRect();
        const isWhole = (cell: HTMLElement) => cell.scrollWidth <= cell.clientWidth && cell.getBoundingClientRect().right <= who.right + 0.5;
        return [{
          name: name.textContent, painted: isWhole(name) ? name.textContent : "cut", isSelfNamed: name.title.endsWith(" (self-named)"),
          mark: mark && { text: mark.textContent, tip: mark.title, isHidden: mark.getAttribute("aria-hidden") === "true", isWhole: isWhole(mark) && !name.contains(mark) },
          label: [" to ", ": "].some((end) => row.getAttribute("aria-label")?.includes(`from ${name.title}${end}`)),
          titleAt: Math.round(row.querySelector(".queue-row-title")!.getBoundingClientRect().left),
        }];
      }));
      await page.close();
      shown.push({ width: viewport.width, rows });
    }

    const byName = shown.flatMap(({ width, rows }) => [...new Set(rows.map((row) => row.name))].map((name) => ({ width, name, painted: [...new Set(rows.filter((row) => row.name === name).map((row) => row.painted))] })));
    assert.ok(shown.every(({ rows }) => rows.some((row) => row.name === "portfolio" && row.isSelfNamed) && rows.some((row) => !row.isSelfNamed)), "each width paints the self-named nine-letter name and recorded names");
    assert.deepEqual(shown.map(({ width, rows }) => ({ width, titleAts: new Set(rows.map((row) => row.titleAt)).size })), shown.map(({ width }) => ({ width, titleAts: 1 })), "every title on one x");
    assert.deepEqual(byName.filter(({ painted }) => painted.length > 1 || painted[0] === "cut"), [], "a sender's name paints whole and alike on every row");
    assert.deepEqual(
      shown.flatMap(({ width, rows }) => rows.map((row) => ({ width, mark: row.mark, label: row.label }))),
      shown.flatMap(({ width, rows }) => rows.map((row) => ({ width, mark: row.isSelfNamed ? { text: "self", tip: "self-named", isHidden: true, isWhole: true } : null, label: true }))),
    );
  });

  // spec §4.2: who, then what — the session name in one fixed column at the row's start, the title and its meta line to its right
  test("with exactly one session ticked no row paints a name, and every title starts where the band labels start", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickSessions(page, ["gersona"]);
    const facts = await page.evaluate(() => {
      const band = document.querySelector(".queue-listbox .queue-band") as HTMLElement;
      const labelStart = Math.round(band.getBoundingClientRect().left + parseFloat(getComputedStyle(band).paddingLeft));
      const titles = [...document.querySelectorAll(".queue-row-title")].map((title) => Math.round(title.getBoundingClientRect().left));
      return { names: document.querySelectorAll(".queue-row-who").length, titleStarts: [...new Set(titles)], labelStart, rows: titles.length };
    });
    await page.close();

    assert.ok(facts.rows > 0, "the ticked session has rows");
    assert.deepEqual({ names: facts.names, titleStarts: facts.titleStarts }, { names: 0, titleStarts: [facts.labelStart] });
  });

  // one session ticked → the sender rides the title cell; a long name the peer gave itself is cut there, never the page's mark beside it
  test("with one session ticked a relay's title cell at 1280 cuts a long self-declared sender name and keeps its self mark whole before the recipient", async () => {
    harness.fixture = getSelfNamedFixture(getRelayRowFixture(), RELAY_ROW_IDS.one, EDGE_LONG_SESSION_NAME);
    const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
    await tickSessions(page, ["yoaida"]);
    await page.locator(".queue-row-title .queue-row-mark").first().waitFor();
    const cell = await page.evaluate((named) => {
      const name = [...document.querySelectorAll<HTMLElement>(".queue-row-title .queue-row-name")].find((one) => one.title === named)!;
      const title = name.closest(".queue-row-title")!.getBoundingClientRect();
      const mark = name.parentElement!.querySelector<HTMLElement>(".queue-row-mark")!;
      const [nameBox, markBox] = [name.getBoundingClientRect(), mark.getBoundingClientRect()];
      const ends = name.closest(".queue-row-title")!.querySelector<HTMLElement>(".queue-row-ends")!;
      return {
        isNameCut: getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
        mark: { text: mark.textContent, isOutsideName: !name.contains(mark), isWhole: mark.scrollWidth <= mark.clientWidth && markBox.left >= nameBox.right - 0.5 && markBox.right <= title.right + 0.5 },
        ends: { text: ends.textContent?.startsWith("→ yoaida "), isAfterMark: ends.getBoundingClientRect().left >= markBox.right && ends.getBoundingClientRect().width > 0 },
        label: name.closest(".queue-row")!.getAttribute("aria-label")?.startsWith(`Relay from ${named} to yoaida: `),
      };
    }, `${EDGE_LONG_SESSION_NAME} (self-named)`);
    await page.close();

    assert.deepEqual(cell, { isNameCut: true, mark: { text: "self", isOutsideName: true, isWhole: true }, ends: { text: true, isAfterMark: true }, label: true });
  });

  // spec §11: the desk's keys on the real page, and the inset ring on the rows the cards clip
  test("J / K move the focus on the list, Enter opens the sheet, J steps it, a digit picks, Esc returns to the row, N puts the caret in Orders and Esc gives the focus back to the middle pane", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const active = () => page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return { id: element.id, tag: element.tagName, inSheet: Boolean(element.closest(".queue-sheet")), offset: getComputedStyle(element).outlineOffset, cls: element.className };
    });
    const rowIds = await page.evaluate(() => [...document.querySelectorAll(".queue-row")].map((row) => row.id));
    await page.focus(`#${rowIds[0]}`);
    await page.keyboard.press("j");
    const stepped = { ...(await active()), isSheet: await page.locator(".queue-sheet").count() };
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    const entered = { ...(await active()), hash: await page.evaluate(() => window.location.hash) };
    await page.keyboard.press("2");
    const picked = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".queue-sheet input[type=radio]")].findIndex((radio) => radio.checked));
    await page.keyboard.press("j");
    const next = await page.evaluate(() => [window.location.hash, (document.activeElement as HTMLElement).className]);
    await page.keyboard.press("Escape");
    const back = await active();
    await page.focus(".queue-rail-row .ctl-checkbox");
    const rail = await page.evaluate(() => {
      const row = (document.activeElement as HTMLElement).closest(".queue-rail-row") as HTMLElement;
      return { offset: getComputedStyle(row).outlineOffset, style: getComputedStyle(row).outlineStyle };
    });
    await page.keyboard.press("n");
    const box = await active();
    await page.focus(".queue-order");
    await page.keyboard.press("Escape");
    const returned = await active();
    await page.close();

    assert.deepEqual([stepped.id, stepped.isSheet], [rowIds[1], 0], "J focuses the next row and opens nothing");
    assert.deepEqual([entered.inSheet, entered.cls, entered.hash], [true, "card-body", `#queue?item=${rowIds[0]!.slice("queue-row-".length)}`], "Enter opens the row's sheet, the focus on its body");
    assert.equal(picked, 1, "2 picks the second option");
    assert.deepEqual(next, [`#queue?item=${rowIds[1]!.slice("queue-row-".length)}`, "card-body"], "J on the sheet opens the next item, the focus on its body");
    assert.deepEqual([back.id, back.offset], [rowIds[1], "-2px"], "Esc gives the focus back to the row just read, its ring inset");
    assert.deepEqual([rail.style, rail.offset], ["solid", "-2px"], "a focused rail box rings its row, inset");
    assert.equal(box.id, "queue-order-text", "N puts the caret in the order box");
    assert.deepEqual([returned.id, returned.offset], [rowIds[1], "-2px"], "Esc in Orders gives the focus back to the middle pane: the list's current row");
  });

  test("rail rows are 44; Orders is rendered at rest beside the list, and an opened row hides the list alone", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-order").first().waitFor();
    const shown = () => page.evaluate(() => [".queue-list", ".queue-sheet", ".queue-orders"].map((selector) => (document.querySelector(selector)?.getClientRects().length ?? 0) > 0));
    const rest = await shown();
    const railRows = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-rail-row")].map((row) => Math.round(row.getBoundingClientRect().height)))]);
    await selectRow(page, 103);
    const opened = await shown();
    await page.close();

    assert.deepEqual(railRows, [44]);
    assert.deepEqual({ rest, opened }, { rest: [true, false, true], opened: [false, true, true] });
  });

  // spec §3.2: one content column from the card's 16 start inset, the whole pane up to 720, the free width at the far end beyond it
  test("Orders' title, day labels, box and note start 16 in, on one column that is the pane less its two 16 insets and never wider than 720, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const columns = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      await waitForAllOrders(page);
      const facts = await page.evaluate(() => {
        // offsets from the card's inner edge, inside its 1 px border
        const element = document.querySelector(".queue-orders-card") as HTMLElement;
        const start = element.getBoundingClientRect().left + element.clientLeft;
        const offset = (x: number) => Math.round(x - start);
        const rects = (selector: string) => [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect());
        const orders = rects(".queue-order");
        return {
          inner: element.clientWidth,
          starts: [...new Set([".queue-orders-card > .card-head .card-title", ".queue-day", ".queue-orders .queue-compose-box", ".queue-orders .queue-note"].flatMap((selector) => rects(selector).map((rect) => offset(rect.left))))],
          ends: [...new Set([".queue-orders-card > .card-head > .card-head-text", ".queue-orders .queue-compose-row", ".queue-orders .queue-note"].flatMap((selector) => rects(selector).map((rect) => offset(rect.right))).concat(offset(orders[orders.length - 1]!.right)))],
        };
      });
      await page.close();
      columns.push({ width: viewport.width, starts: facts.starts, ends: facts.ends, column: 16 + Math.min(facts.inner - 32, ORDERS.COLUMN_MAX) });
    }

    assert.ok(columns.some(({ column }) => column === 16 + ORDERS.COLUMN_MAX), "a desk width wide enough for the 720 cap");
    assert.deepEqual(columns, columns.map(({ width, column }) => ({ width, starts: [16], ends: [column], column })));
  });

  // spec §9.1: one control per row — the row is its box's label
  test("a rail row holds one interactive element, its checkbox, and no button; a press on its name ticks it and a press on its state mark unticks it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const row = page.locator(`[data-session="${FIXTURE_SESSION_IDS.atrium}"]`);
    const controls = await row.evaluate((element) => [...element.querySelectorAll("button, input, a, [tabindex]")].map((control) => `${control.tagName}:${control.getAttribute("type")}`));
    await row.locator(".queue-rail-name").click();
    const ticked = await page.getByLabel("Select atrium").isChecked();
    await row.locator(".queue-rail-mark").click();
    const unticked = await page.getByLabel("Select atrium").isChecked();
    await page.close();

    assert.deepEqual({ controls, ticked, unticked }, { controls: ["INPUT:checkbox"], ticked: true, unticked: false });
  });

  // spec §9.1, §14.3: a department reads left to right on one set of columns — box · state mark · name · tag · count — both bands on them too
  test("every rail row and both bands share the box, mark, name, tag and count columns at 1280, 1440 and 1568, each slot inside its column, All sessions whole, rows one 44 line and bands 32", async (t) => {
    harness.fixture = getRailFixture();
    const shown = [];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0], OWNER_WINDOW]) {
      const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
      await openEndedBand(page);
      shown.push({ width: viewport.width, ...(await page.evaluate(getRailColumnFacts)) });
      await page.close();
    }

    t.diagnostic(`name column: ${shown.map((at) => `${at.width} → ${at.tracks[0]?.[2]}`).join(" | ")}`);
    assert.deepEqual(shown.map((at) => at.width), [1280, 1440, 1568]);
    for (const at of shown) {
      // the name column takes the rest of the rail (spec §9.1) → its width is the step's, never under the 1280 step's
      assert.deepEqual(
        { starts: at.starts, tracks: at.tracks.map(([box, mark, , tag, count]) => [box, mark, tag, count]), misplaced: at.misplaced, isAllWhole: at.isAllWhole, rows: at.rows, bands: at.bands },
        { starts: 1, tracks: [[24, 8, 16, 36]], misplaced: [], isAllWhole: true, rows: [44], bands: [32] },
        `at ${at.width}`,
      );
      assert.ok((at.tracks[0]?.[2] ?? 0) >= 56, `at ${at.width}: name column ${at.tracks[0]?.[2]}`);
      assert.ok(at.slots.tag > 0 && at.slots.count > 0 && at.lines >= 6, `at ${at.width}: ${JSON.stringify(at.slots)}`);
    }
  });

  // spec §9.1, §14.3: the state mark by shape and colour, the count spec 44084's atom, never solid; no row paints the word Live
  test("a live rail mark is the ok dot and any other a faint ring; every rail count is the tag-fill count atom; no rail row paints Live", async () => {
    harness.fixture = getRailFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    await openEndedBand(page);
    const paints = await Promise.all(["--ok", "--faint"].map((token) => page.evaluate(getTokenPaint, { property: "color" as const, value: `rgb(var(${token}))` })));
    const facts = await page.evaluate(([ok, faint]) => {
      const rows = [...document.querySelectorAll<HTMLElement>(".queue-rail-row")];
      // painted text only: what a screen reader alone hears stays out
      const getPainted = (row: Element) => [...row.querySelectorAll("*")].filter((node) => !node.closest(".sr-only") && node.children.length === 0).map((node) => node.textContent).join(" ");
      return {
        marks: rows.map((row) => {
          const mark = getComputedStyle(row.querySelector(".queue-rail-mark") as Element);
          const isLive = /^(Live|Next turn)/.test(row.title);
          return isLive ? mark.backgroundColor === ok : mark.borderTopColor === faint && mark.backgroundColor === "rgba(0, 0, 0, 0)";
        }),
        kinds: new Set(rows.map((row) => row.querySelector(".queue-rail-mark")?.classList.contains("is-live"))).size,
        counts: [...document.querySelectorAll(".queue-sessions .queue-rail-count .pill")].map((pill) => pill.className),
        solid: document.querySelectorAll(".queue-sessions .pill--solid").length,
        live: rows.filter((row) => /\bLive\b/.test(getPainted(row))).map((row) => row.dataset.session),
      };
    }, paints);
    await page.close();

    assert.equal(facts.kinds, 2, "live and not-live rows are both on the rail");
    assert.ok(facts.counts.length > 0);
    assert.deepEqual(
      { marks: facts.marks.every(Boolean), counts: facts.counts.filter((name) => !/\bpill--tag\b/.test(name) || !/\bpill--num\b/.test(name)), solid: facts.solid, live: facts.live },
      { marks: true, counts: [], solid: 0, live: [] },
    );
  });

  // spec §4.3, §14.4: opening a report changes no tick → the composer's address holds across a press, a step, an order row and the way back
  test("pressing a row, stepping, pressing an order row and Back to the list leave every rail box as it was, and the Orders label line and send button unchanged", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickSessions(page, ORDER_TO);
    const read = () => page.evaluate(() => ({
      boxes: [...document.querySelectorAll<HTMLInputElement>(".queue-sessions .ctl-checkbox")].map((box) => `${box.getAttribute("aria-label")}=${box.checked}`),
      label: document.querySelector(".queue-orders .field-label")?.textContent,
      send: [...document.querySelectorAll(".queue-orders .queue-compose-buttons .btn")].map((button) => button.textContent),
    }));
    const before = await read();
    await selectRow(page, 103);
    const opened = await read();
    await page.keyboard.press("j");
    const stepped = await read();
    await page.getByRole("button", { name: "Back to the list" }).click();
    const back = await read();
    await selectRow(page, 109);
    const order = await read();
    await page.close();

    assert.deepEqual(before.boxes.filter((box) => box.endsWith("=true")), ["Select gersona=true", "Select yoaida=true"]);
    assert.equal(before.label, "New order to gersona, yoaida");
    assert.deepEqual({ opened, stepped, back, order }, { opened: before, stepped: before, back: before, order: before });
  });

  // spec §9.1, §14.4 (the fixture: gersona and yoaida ticked while atrium has a report; an order to gersona and the unticked aidl)
  test("with sessions ticked, the list holds their items alone, the thread their orders, the list head and the composer label name exactly them, and the hash holds them in to=", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickOrdersTo(page, ORDER_TO);
    await page.locator(".queue-order", { hasText: "aidl" }).first().waitFor();
    const shown = await page.evaluate(() => ({
      rowIds: [...document.querySelectorAll(".queue-row")].map((row) => Number(row.id.slice("queue-row-".length))),
      recipients: [...document.querySelectorAll(".queue-order")].map((entry) => [...entry.querySelectorAll(".queue-recipient-name")].map((name) => name.textContent)),
      head: document.querySelector(".queue-list > .card-head .card-title")?.textContent,
      label: document.querySelector(".queue-orders .field-label")?.textContent,
      hash: window.location.hash,
    }));
    await page.close();

    const sessionOf = (id: number) => harness.fixture.items.find((item) => item.id === id)?.session.name;
    assert.ok(shown.rowIds.length > 0 && shown.rowIds.every((id) => ORDER_TO.includes(sessionOf(id) ?? "")), JSON.stringify(shown.rowIds.map(sessionOf)));
    assert.ok(shown.recipients.every((names) => names.some((name) => ORDER_TO.includes(name ?? ""))), JSON.stringify(shown.recipients));
    assert.ok(shown.recipients.some((names) => names.includes("gersona") && names.includes("aidl")), "an order to a ticked and an unticked session is one entry with both");
    assert.deepEqual([shown.head, shown.label, shown.hash], ["gersona, yoaida", "New order to gersona, yoaida", `#queue?to=${FIXTURE_SESSION_IDS.gersona}%2C${FIXTURE_SESSION_IDS.yoaida}`]);
  });

  // spec §9.2: nothing ticked → everything shown, no one addressed: a send press makes no request
  test("with nothing ticked the list and the thread hold every session's, and a send press makes no request, says what is missing and focuses the rail's first box", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await waitForAllOrders(page);
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
    await page.locator(".queue-orders").getByRole("button", { name: "Send order" }).click();
    await page.locator(".queue-orders").getByText("Tick at least one session in the rail.").waitFor();
    const shown = await page.evaluate(() => ({
      rows: document.querySelectorAll(".queue-row").length,
      entries: document.querySelectorAll(".queue-order").length,
      label: document.querySelector(".queue-orders .field-label")?.textContent,
      alert: document.querySelector('.queue-orders [role="alert"]')?.textContent,
      focus: (document.activeElement as HTMLElement).getAttribute("aria-label"),
      first: document.querySelector(".queue-sessions .ctl-checkbox")?.getAttribute("aria-label"),
    }));
    await page.close();

    assert.deepEqual(posts, []);
    assert.deepEqual([shown.rows, shown.entries], [9, 4], "every item row (one per order) and every order");
    assert.equal(shown.label, "New order · no session ticked");
    assert.match(shown.alert ?? "", /Tick at least one session in the rail\./);
    assert.equal(shown.focus, shown.first);
  });

  // spec §9.1 → All sessions: one press from any selection is back at rest; "order everyone" is a second, deliberate press
  test("the master box ticks every live box from nothing ticked, and from one box ticked unticks them all", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const checked = () => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".queue-rail-row .ctl-checkbox")].filter((box) => box.checked).map((box) => box.getAttribute("aria-label")));
    const master = page.getByLabel("Select all live sessions");
    await master.click();
    const all = { boxes: await checked(), send: await page.locator(".queue-orders .queue-compose-buttons .btn").textContent() };
    await master.click();
    const cleared = await checked();
    await tickSessions(page, ["aidl"]);
    await master.click();
    const fromOne = await checked();
    await page.close();

    assert.deepEqual(all, { boxes: ["Select gersona", "Select atrium", "Select aidl", "Select yoaida"], send: "Send to 4 sessions" });
    assert.deepEqual({ cleared, fromOne }, { cleared: [], fromOne: [] });
  });

  // spec §9.2: the draft is what the owner wrote, the ticks who gets it
  test("an order typed with one image survives a tick, an untick of every box and a reload, and the tick's Recipients changed note is said once", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await tickSessions(page, ["gersona"]);
    await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
    await addOrderFiles(page, [getImageFile(0)]);
    await waitForImages(page);
    const draft = () => page.evaluate((id) => [(document.getElementById(id) as HTMLTextAreaElement).value, document.querySelectorAll(".queue-orders .queue-thumb").length], ORDER_BOX_ID);
    const note = () => page.locator(".queue-orders .queue-note-text").textContent();
    await tickSessions(page, ["yoaida"]);
    // the note follows the tick's render → wait on it, and read what stands should it never come
    const changed = await page.locator(".queue-orders .queue-note-text", { hasText: "Recipients changed" }).textContent({ timeout: 3_000 }).catch(() => note());
    const ticked = { draft: await draft(), note: changed };
    await page.locator(`#${ORDER_BOX_ID}`).press("End");
    await page.locator(`#${ORDER_BOX_ID}`).pressSequentially(" ");
    const typed = await note();
    await page.getByLabel("Select all live sessions").click();
    const untickedAll = { draft: await draft(), label: await page.locator(".queue-orders .field-label").textContent() };
    await page.reload({ waitUntil: "load" });
    await page.getByText(getRestReadyText()).first().waitFor({ timeout: READY_TIMEOUT_MS });
    const reloaded = await draft();
    await page.close();

    assert.deepEqual(ticked, { draft: [FIXTURE_ORDER_TEXT, 1], note: "ℹ Recipients changed: now gersona and yoaida." });
    assert.doesNotMatch(typed ?? "", /Recipients changed/);
    assert.deepEqual(untickedAll, { draft: [`${FIXTURE_ORDER_TEXT} `, 1], label: "New order · no session ticked" });
    assert.deepEqual(reloaded, [`${FIXTURE_ORDER_TEXT} `, 1]);
  });

  // spec §4.5 → Cmd / Ctrl + Enter sends from the pane the focus is in and from no other
  test("with a decision open and an order typed, each pane holds one primary button, and Cmd+Enter posts only from the pane holding the focus", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const posts: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await tickSessions(page, ["gersona"]);
    await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
    await pickWithNote(page);
    const primaries = await page.evaluate(() => [".queue-sheet", ".queue-orders"].map((pane) => document.querySelectorAll(`${pane} .btn.primary`).length));
    await page.locator(`#${ORDER_BOX_ID}`).press("ControlOrMeta+Enter");
    await page.getByText("Order sent to gersona").first().waitFor({ state: "attached" });
    const fromOrders = [...posts];
    await page.locator("#queue-text-103").press("ControlOrMeta+Enter");
    await page.getByText("Answer sent to gersona").first().waitFor({ state: "attached" });
    await page.close();

    assert.deepEqual(primaries, [1, 1]);
    assert.deepEqual(fromOrders, ["/api/queue/owner/messages/send"]);
    assert.deepEqual(posts.slice(fromOrders.length), ["/api/queue/owner/items/103/answer"]);
  });

  // spec §9.1 → In the address, §10: a tick on a session that stops taking orders is dropped and said
  test("a ticked session that stops taking orders is unticked on the page's next read, and the status line says so", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await tickSessions(page, ["yoaida"]);
      harness.fixture = getStoppedFixture();
      await page.clock.fastForward(16_000);
      await page.getByText("yoaida no longer takes orders and was unticked.").waitFor({ state: "attached" });
      const shown = await page.evaluate(() => ({
        box: document.querySelector('[aria-label="Select yoaida"]') !== null,
        label: document.querySelector(".queue-orders .field-label")?.textContent,
        hash: window.location.hash,
      }));
      assert.deepEqual(shown, { box: false, label: "New order · no session ticked", hash: "#queue" });
    } finally {
      await page.close();
    }
  });

  // spec §10: the thread's empty state is text on the Orders column, never indented off it
  test("the empty thread's line starts on the Orders column, where the Orders title starts", async () => {
    harness.fixture = getEmptyFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(getEmptyFixture()));
    await tickOrdersTo(page, ["aidl"]);
    await page.getByText("No orders to aidl yet").waitFor();
    const lefts = await page.evaluate(() => [".queue-orders-card > .card-head .card-title", ".queue-thread > .placeholder > div"]
      .map((selector) => Math.round((document.querySelector(selector) as HTMLElement).getBoundingClientRect().left)));
    await page.close();

    assert.equal(lefts[1], lefts[0]);
  });

  // spec §18.4 row 20: the arrival reaches the row, the rail and the nav on the same tick, and moves nothing the owner holds
  test("the page's own 15 s read raises an arrival's session's and the nav's counts and paints New on no row; an open sheet stays and the way back counts it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await selectRow(page, 101);
      harness.fixture = getArrivalFixture();
      await page.clock.fastForward(15_000);
      await page.locator("#queue-row-150").waitFor({ state: "attached", timeout: READY_TIMEOUT_MS });
      const rail = page.locator(`[data-session="${FIXTURE_SESSION_IDS.yoaida}"] .queue-rail-count .pill`);
      await assert.doesNotReject(rail.filter({ hasText: /^2$/ }).waitFor({ timeout: READY_TIMEOUT_MS }), "yoaida's rail count reads 2");
      await assert.doesNotReject(page.locator(".nav-item", { hasText: "Queue" }).locator(".nav-count").filter({ hasText: "8" }).waitFor({ timeout: READY_TIMEOUT_MS }), "the nav count reads 8");
      const back = page.getByRole("button", { name: "Back to the list, 1 new in the list" });
      assert.deepEqual([await back.count(), await page.evaluate(() => window.location.hash)], [1, "#queue?item=101"], "the sheet unmoved, the arrival counted on the way back");
      await back.click();
      await page.locator("#queue-row-150").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      assert.deepEqual(await page.locator('[role="option"] .pill').filter({ hasText: /^New$/ }).count(), 0, "no row paints New");
      assert.deepEqual(await page.locator('[role="option"][aria-selected="true"]').evaluateAll((rows) => rows.map((row) => row.id)), ["queue-row-101"]);
    } finally {
      await page.close();
    }
  });

  // spec §4.3: the count belongs to the way back → bound to the arrow by proximity, never read as part of the letterhead after it
  test("the arrival count on an open sheet stands at least twice as near the back arrow's glyph as the kind tag after it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await selectRow(page, 101);
      await arriveItem(page, harness);
      await page.getByRole("button", { name: "Back to the list, 1 new in the list" }).waitFor();
      const gaps = await page.evaluate(() => {
        const head = document.querySelector(".queue-sheet-head") as HTMLElement;
        const box = (selector: string) => (head.querySelector(selector) as Element).getBoundingClientRect();
        const [glyph, count, tag] = [box("button svg"), box("[aria-hidden='true'] .pill"), box(".queue-letter .pill")];
        return { afterArrow: Math.round(count.left - glyph.right), beforeTag: Math.round(tag.left - count.right) };
      });

      assert.ok(gaps.afterArrow > 0 && gaps.beforeTag >= 2 * gaps.afterArrow, JSON.stringify(gaps));
    } finally {
      await page.close();
    }
  });

  // spec §4.4: an arrival is tracked until its row has been in the shown list's visible part — not only until it is focused
  test("an arrival whose row has shown in the list is no longer counted on the way back of the next sheet", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      await selectRow(page, 101);
      await arriveItem(page, harness);
      await page.getByRole("button", { name: "Back to the list, 1 new in the list" }).click();
      await page.locator("#queue-row-150").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      await selectRow(page, 101);

      assert.deepEqual(await page.locator(".queue-sheet-head button").first().getAttribute("aria-label"), "Back to the list");
    } finally {
      await page.close();
    }
  });

  // spec §4.4: past the visible part the status line names the arrival's side, and its Show brings the row into view with the focus
  test("an arrival below the list's visible part is said as 1 new below with Show, and Show puts its row in view, focused, and ends the note", async () => {
    harness.fixture = getOffViewFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), true);
    try {
      await arriveOffView(page, harness);
      const said = await page.locator(".queue-status-line").innerText();
      await page.getByRole("button", { name: "Show the new item below" }).click();
      await page.locator(".queue-status-new").waitFor({ state: "detached" });
      const row = await page.evaluate(() => {
        const [body, box] = [".queue-list > .card-body", "#queue-row-150"].map((selector) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect());
        return { isFocused: document.activeElement?.id === "queue-row-150", isInView: box!.top >= body!.top && box!.bottom <= body!.bottom };
      });

      assert.match(said.replace(/\s+/g, " "), /1 new below Show$/);
      assert.deepEqual(row, { isFocused: true, isInView: true });
    } finally {
      await page.close();
    }
  });

  test("an order's images are 96 squares in its bubble, an added one is a 56 thumbnail in a 104 box, and the viewer spans the window, fits one in it and steps", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-bubble-image img").first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".queue-bubble-image img")].every((img) => (img as HTMLImageElement).complete));
    const bubble = await page.evaluate(() => [...document.querySelectorAll(".queue-bubble-image")].map((button) => {
      const box = button.getBoundingClientRect();
      return [Math.round(box.width), Math.round(box.height), ((button.querySelector("img") as HTMLImageElement).naturalWidth > 0)];
    }));
    await page.locator("#queue-order-text-files").setInputFiles({ name: "shot-1.png", mimeType: "image/png", buffer: [...FIXTURE_IMAGES.values()][0]?.bytes ?? Buffer.alloc(0) });
    await page.locator(".queue-thumb:not(.is-busy) img").waitFor();
    const composer = await page.evaluate(() => ({
      thumb: [".queue-thumb"].map((selector) => { const box = (document.querySelector(selector) as HTMLElement).getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; })[0],
      box: Math.round((document.querySelector(".queue-orders .queue-compose-box") as HTMLElement).getBoundingClientRect().height),
      count: document.querySelector(".queue-thumbs-count")?.textContent,
    }));
    await page.locator(".queue-bubble-image").first().click();
    await page.locator(".queue-viewer img").waitFor();
    const fit = await page.evaluate(() => {
      const panel = (document.querySelector(".queue-viewer") as HTMLElement).getBoundingClientRect();
      const img = (document.querySelector(".queue-viewer img") as HTMLElement).getBoundingClientRect();
      return {
        panel: [Math.round(panel.left), Math.round(panel.width)],
        window: [0, window.innerWidth],
        isImageInside: img.top >= 0 && img.left >= 0 && img.bottom <= window.innerHeight && img.right <= window.innerWidth,
      };
    });
    await page.keyboard.press("ArrowRight");
    const stepped = await page.locator(".queue-viewer-name").textContent();
    await page.keyboard.press("Escape");
    const after = await page.evaluate(() => ({ isViewerOpen: document.querySelector(".queue-viewer") !== null, isModeOpen: document.querySelector(".queue-orders") !== null, focus: document.activeElement?.getAttribute("aria-label") }));
    await page.close();

    assert.ok(bubble.length > 0 && bubble.every(([width, height, isLoaded]) => width === 96 && height === 96 && isLoaded), JSON.stringify(bubble));
    assert.deepEqual({ thumb: composer.thumb, box: composer.box }, { thumb: [56, 56], box: 104 });
    assert.match(composer.count ?? "", /^1 image · \d+ KB$/);
    assert.deepEqual(fit.panel, fit.window, "the viewer panel spans the window width");
    assert.equal(fit.isImageInside, true);
    assert.match(stepped ?? "", / · 2 of \d+$/);
    assert.deepEqual({ isViewerOpen: after.isViewerOpen, isModeOpen: after.isModeOpen }, { isViewerOpen: false, isModeOpen: true });
    assert.match(after.focus ?? "", /^Open image 1 of \d+: /);
  });

  test("every pane head is 48 high, in both middle-pane states, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const heads = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const list = await getHeadHeights(page, [".queue-sessions", ".queue-list", ".queue-orders-card"]);
      await selectRow(page, 101);
      const sheet = await getHeadHeights(page, [".queue-sessions", ".queue-sheet", ".queue-orders-card"]);
      await page.close();
      heads.push({ width: viewport.width, list, sheet });
    }

    assert.deepEqual(heads, heads.map(({ width }) => ({ width, list: [48, 48, 48], sheet: [48, 48, 48] })));
  });

  // spec §4.1: a scope title wider than the pane gives way on the head's one line → the list's head and first band stay level with Orders'
  test("the list head stays one 48 line under a scope title wider than the pane: the title cut with its whole text in the tooltip, the waiting count whole and the keys button inside the head, at every desk width", async () => {
    harness.fixture = getEdgeFixture();
    const heads = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openEdgePage(harness, viewport);
      await tickSessions(page, [EDGE_LONG_SESSION_NAME]);
      const heights = await getHeadHeights(page, [".queue-list", ".queue-orders-card"]);
      const facts = await page.evaluate(() => {
        const head = document.querySelector(".queue-list > .card-head") as HTMLElement;
        const title = head.querySelector(".card-title") as HTMLElement;
        const sub = head.querySelector(".card-sub") as HTMLElement;
        const keys = head.querySelector("button") as HTMLElement;
        return {
          isTitleCut: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === "ellipsis",
          tooltip: (title.querySelector("[title]") as HTMLElement | null)?.title ?? title.title,
          sub: sub.textContent,
          isSubWhole: sub.clientWidth > 0 && sub.scrollWidth <= sub.clientWidth,
          isKeysInHead: keys.getBoundingClientRect().right <= head.getBoundingClientRect().right,
        };
      });
      await page.close();
      heads.push({ width: viewport.width, heights, ...facts });
    }

    assert.deepEqual(heads, heads.map(({ width, sub }) => ({
      width, heights: [48, 48], isTitleCut: true, tooltip: EDGE_LONG_SESSION_NAME, sub: /^\d+ waiting$/.test(sub ?? "") ? sub : "N waiting", isSubWhole: true, isKeysInHead: true,
    })));
  });

  // the page's one solid = an open sheet's arrival count → a sheet open and a report arrived; the warn = the not-received order's tag
  test("a badge is 20 high in every fill", async () => {
    harness.fixture = getNotReceivedFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture), true);
    try {
      await selectRow(page, 101);
      await arriveItem(page, harness, getNotReceivedFixture());
      await page.getByRole("button", { name: "Back to the list, 1 new in the list" }).waitFor();
      const fills = await page.evaluate(() => [...new Set([...document.querySelectorAll(".pill--solid, .pill--tag, .pill--warn")]
        .filter((pill) => pill.getClientRects().length > 0)
        .map((pill) => `${/pill--(solid|tag|warn)/.exec(pill.className)?.[1]} ${Math.round(pill.getBoundingClientRect().height)}`))].sort());

      assert.deepEqual(fills, ["solid 20", "tag 20", "warn 20"]);
    } finally {
      await page.close();
    }
  });

  test("the page header ends at the same x as on the Documents page, at every desk width", async () => {
    harness.fixture = getRestFixture();
    const ends = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const queue = await getHeadEnd(page);
      await page.evaluate(() => { window.location.hash = "#clauded-docs"; });
      await page.locator(".page-head-title", { hasText: "Documents" }).waitFor({ timeout: READY_TIMEOUT_MS });
      const docs = await getHeadEnd(page);
      await page.close();
      ends.push({ width: viewport.width, queue, docs });
    }

    assert.deepEqual(ends, ends.map((row) => ({ ...row, queue: row.docs })));
  });

  // an answer held in flight → its composer's other button disabled; the not-received order's Resend → a secondary on the same desk
  test("every word button of the open decision's desk has a 1 px edge at rest in its rank's colour, a quiet label is dim, and a disabled one keeps a faint label at full strength on the line edge", async () => {
    harness.fixture = getNotReceivedFixture();
    let release = () => {};
    harness.heldAct = new Promise((resolve) => { release = resolve; });
    try {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
      await pickWithNote(page);
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      await page.locator(".queue-sheet [aria-busy='true']").waitFor();
      await page.mouse.move(0, 0);
      // the 0.12 s edge transition into the disabled look settled first → never a mid-step colour
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)).then(() => undefined));
      const facts = await page.evaluate(getButtonFacts);
      release();
      await page.close();

      const looks = facts.buttons.map((button) => ({ name: button.name, look: button.look }));
      const expected = facts.buttons.map((button) => ({ name: button.name, look: getRankLook(facts.tokens, button) }));
      assert.deepEqual(looks, expected);
      assert.deepEqual([...new Set(facts.buttons.map((button) => button.rank))].sort(), ["disabled", "primary", "quiet", "secondary"], "the open sheet shows every rank");
    } finally {
      release();
      harness.heldAct = null;
    }
  });

  test("a quiet word button hovered takes the sunken fill and an ink label, and held down an ink edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Answer later" });
    const read = () => getSettledLook(button);
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    await button.hover();
    const hovered = await read();
    await page.mouse.down();
    const held = await read();
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.close();

    assert.deepEqual([hovered.fill, hovered.label, held.edge], [tokens.sunken, tokens.ink, tokens.ink]);
  });

  test("a quiet button in progress keeps its rest look under the pointer: no fill, the control edge and a dim label", async () => {
    harness.fixture = getRestFixture();
    harness.moreCursor = "next-page";
    let release = () => {};
    try {
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
      const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
      harness.heldRead = new Promise((resolve) => { release = resolve; });
      await page.getByRole("button", { name: "Show more" }).click();
      const look = await getSettledLook(page.getByRole("button", { name: "Loading…" }));
      release();
      await page.close();

      assert.deepEqual(look, { fill: "rgba(0, 0, 0, 0)", edge: tokens.controlEdge, label: tokens.dim });
    } finally {
      release();
      harness.heldRead = null;
      harness.moreCursor = null;
    }
  });

  test("a word button reached by keyboard wears the focus ring outside its rest edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Answer later" });
    await focusByKeyboard(page, button);
    const focused = await getFocusRing(button);
    const look = await getSettledLook(button);
    const ringToken = await getRingToken(page);
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    await page.close();

    assert.deepEqual({ ...focused, edge: look.edge }, { isVisible: true, outline: `rgb(${ringToken}) solid 2px`, offset: "2px", edge: tokens.controlEdge });
  });

  // spec §12.5, §14.4: each icon button read where it is painted — the list head, the open sheet's head, a failed upload, the viewer's bar
  test("every icon button is a 32 square holding a drawn glyph, dim and with no edge or fill at rest, faint when disabled, named and with a tooltip; no button reads List", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    harness.refusals.set("upload", { status: 500, body: { error: "server" } });
    try {
      const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
      const atRest = await page.evaluate(getIconLooks);
      await page.locator(".queue-bubble-image img").first().waitFor();
      await page.locator(".queue-bubble-image").first().click();
      await page.locator(".queue-viewer img").waitFor();
      const inViewer = await page.evaluate(getIconLooks);
      await page.keyboard.press("Escape");
      await selectRow(page, 103);
      const onSheet = await page.evaluate(getIconLooks);
      await addOrderFiles(page, [getImageFile(0)]);
      await page.getByRole("button", { name: "Try again" }).waitFor();
      const onFailure = await page.evaluate(getIconLooks);
      const hasListText = await page.evaluate(() => [...document.querySelectorAll("button")].some((button) => /\bList\b/.test(button.textContent ?? "")));

      const byName = new Map([...atRest, ...onSheet, ...onFailure, ...inViewer].map((look) => [look.name, look]));
      assert.deepEqual([...byName.keys()].sort(), ["Add images", "Back to the list", "Close", "Keyboard shortcuts", "Next image", "Next item", "Previous image", "Previous item"]);
      const looks = [...byName.values()];
      const expected = looks.map((look) => ({
        ...look, size: [32, 32], text: "", isEdgeless: true, fill: "rgba(0, 0, 0, 0)", glyph: look.isDisabled ? tokens.faint : tokens.dim, isDrawn: true,
        title: look.title.startsWith(look.name) ? look.title : `${look.name} …`,
      }));
      assert.deepEqual(looks, expected);
      assert.ok(looks.some((look) => look.isDisabled), "a disabled icon button is read: Previous on the first sheet row");
      assert.equal(hasListText, false);
    } finally {
      harness.refusals.clear();
      await page.close();
    }
  });

  // the hover square is the pointer's only shape cue once the edge is gone → the selection tint a person can see, held one step stronger
  test("an icon button hovered takes the selection tint and an ink glyph, held the stronger tag fill, and by keyboard the ring, never an edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Next item" });
    const read = async () => {
      const look = (await page.evaluate(getIconLooks)).find((icon) => icon.name === "Next item");
      return { fill: look?.fill, glyph: look?.glyph, isEdgeless: look?.isEdgeless };
    };
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    const [tint, tintFill] = await getTintFills(page);
    await button.hover();
    const hovered = await read();
    await page.mouse.down();
    const held = await read();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    const back = page.getByRole("button", { name: "Back to the list" });
    await focusByKeyboard(page, back);
    const focused = await getFocusRing(back);
    const ringToken = await getRingToken(page);
    await page.close();

    assert.deepEqual({ hovered, held, focused }, {
      hovered: { fill: tint, glyph: tokens.ink, isEdgeless: true },
      held: { fill: tintFill, glyph: tokens.ink, isEdgeless: true },
      focused: { isVisible: true, outline: `rgb(${ringToken}) solid 2px`, offset: "2px" },
    });
  });

  // spec §12.5 Reach: the system drawer opened on the Queue screen keeps its own close button → the system ghost's sunken fill, never the Queue tints
  test("the Automatic resumes drawer's close button hovered and held takes the system ghost's sunken fill and ink glyph, and the Queue's icon buttons keep their tints", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    const [tint, tintFill] = await getTintFills(page);
    const readFill = async (button: Locator) => {
      const look = await getSettledLook(button);
      return { fill: look.fill, glyph: look.label };
    };
    await page.getByRole("button", { name: /^Automatic resumes/ }).click();
    const close = page.getByRole("dialog", { name: "Recent automatic resumes" }).getByRole("button", { name: "Close details" });
    await close.hover();
    const closeHovered = await readFill(close);
    await page.mouse.down();
    const closeHeld = await readFill(close);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Recent automatic resumes" }).waitFor({ state: "detached" });
    const keys = page.getByRole("button", { name: "Keyboard shortcuts" });
    await keys.hover();
    const keysHovered = await readFill(keys);
    await page.mouse.down();
    const keysHeld = await readFill(keys);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.close();

    assert.deepEqual({ closeHovered, closeHeld, keysHovered, keysHeld }, {
      closeHovered: { fill: tokens.sunken, glyph: tokens.ink },
      closeHeld: { fill: tokens.sunken, glyph: tokens.ink },
      keysHovered: { fill: tint, glyph: tokens.ink },
      keysHeld: { fill: tintFill, glyph: tokens.ink },
    });
  });

  test("the page header holds no button and one status line, Checks every 15s, and no Queue button is named New order, Clear or Refresh", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const head = await page.evaluate(() => ({
      line: [...document.querySelectorAll(".page-head [role=status]")].map((node) => node.textContent?.trim()),
      headButtons: document.querySelectorAll(".page-head button").length,
      named: [...document.querySelectorAll(".queue-screen button")].map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim())
        .filter((name) => /^(New order|Clear|Refresh)/.test(name)),
    }));
    await page.close();

    assert.deepEqual(head, { line: ["Checks every 15s"], headButtons: 0, named: [] });
  });

  test("a failed check over loaded rows turns the header line to Not updated with the next check's interval, and the first good check restores it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    const line = page.locator(".page-head [role=status]");
    try {
      const loaded = await page.locator(".queue-row").count();
      harness.isListDown = true;
      await page.clock.fastForward(15_000);
      await line.filter({ hasText: "Not updated" }).waitFor({ timeout: READY_TIMEOUT_MS });
      const failed = (await line.textContent())?.trim();
      const kept = await page.locator(".queue-row").count();
      harness.isListDown = false;
      await page.clock.fastForward(15_000);
      await line.filter({ hasText: /^Checks every 15s$/ }).waitFor({ timeout: READY_TIMEOUT_MS });

      assert.match(failed ?? "", /^⚠ Not updated · last read \d{2}:\d{2} · trying again every 15s$/);
      assert.deepEqual([kept, loaded > 0], [loaded, true], "the loaded rows stay on screen");
    } finally {
      harness.isListDown = false;
      await page.close();
    }
  });

  test("the report's composer and the Orders composer, on one screen, share a 40 box, 40 buttons and one computed type, the Orders button under its box", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 101);
    const report = await getComposerFacts(page, ".queue-sheet");
    const order = await getComposerFacts(page, ".queue-orders");
    const isUnder = await page.evaluate(() => (document.querySelector(".queue-orders .queue-compose-buttons .btn") as HTMLElement).getBoundingClientRect().top >= (document.querySelector(".queue-orders .queue-compose-box") as HTMLElement).getBoundingClientRect().bottom);
    await page.close();

    assert.deepEqual({ box: report.box, buttons: report.buttons }, { box: 40, buttons: [40] }, "the report's composer");
    assert.deepEqual(order, report, "the Orders composer against the report's");
    assert.equal(isUnder, true, "the Orders button falls under its box");
  });

  // spec §3.2 / §4.5 / §18.5: the pane's width decides the form — beside from a 420 pane, under below it — never the button's label,
  // so a tick that lengthens the label moves nothing
  test("the Orders send button stands beside its box from a 420 pane and under it below, the same with nothing ticked and with two sessions ticked", async () => {
    harness.fixture = getRestFixture();
    const rows: Array<{ width: number; ticked: number; label: string | null | undefined; isBeside: boolean; isWide: boolean }> = [];
    for (const { viewport } of DESK_WIDTHS) {
      for (const ticked of [[], ORDER_TO]) {
        const page = await openQueuePage(harness, viewport, getRestReadyText());
        await tickSessions(page, ticked);
        const facts = await page.evaluate(() => {
          const rect = (selector: string) => (document.querySelector(`.queue-orders ${selector}`) as HTMLElement).getBoundingClientRect();
          const pane = document.querySelector(".queue-orders-card") as HTMLElement;
          return { label: document.querySelector(".queue-orders .queue-compose-buttons .btn")?.textContent, isBeside: rect(".queue-compose-buttons").top < rect(".queue-compose-box").bottom, pane: pane.clientWidth };
        });
        await page.close();
        rows.push({ width: viewport.width, ticked: ticked.length, label: facts.label, isBeside: facts.isBeside, isWide: facts.pane >= 420 });
      }
    }
    const at = (width: number) => rows.filter((row) => row.width === width).map((row) => row.isBeside);

    assert.deepEqual(rows.filter((row) => row.isBeside !== row.isWide), [], JSON.stringify(rows));
    assert.deepEqual(new Set(rows.map((row) => `${row.ticked}:${row.label}`)), new Set(["0:Send order", "2:Send to 2 sessions"]));
    assert.deepEqual([at(1440), at(1568), at(1728), at(2560)], [[false, false], [false, false], [true, true], [true, true]]);
  });

  // spec §3.2 / §4.5: the label gives way, never the box — beside the button the box keeps its 220, under it the whole row;
  // a 100-character name is cut inside the button, the whole label in its title. 1605 and 1645 put the pane at about 420 and 460
  test("the Orders send label stays inside its row and leaves the box 220 beside it or the whole row under it, a 100-character name cut with the whole label in the title, from 1440 to 1920", async () => {
    const ticks = [
      { names: [EDGE_LONG_SESSION_NAME], label: `Send to ${EDGE_LONG_SESSION_NAME}`, isCut: true },
      { names: ["gersona", "portfolio"], label: "Send to 2 sessions · resumes 1 ended", isCut: false },
    ];
    const rows = [];
    for (const width of [1440, 1568, 1605, 1645, 1728, 1920]) {
      for (const tick of ticks) {
        const page = await openEdgePage(harness, { width, height: 900 });
        await openEndedBand(page);
        await tickSessions(page, tick.names);
        const facts = await page.evaluate(() => {
          const rect = (selector: string) => (document.querySelector(`.queue-orders ${selector}`) as HTMLElement).getBoundingClientRect();
          const [row, box, button] = [rect(".queue-compose-row"), rect(".queue-compose-box"), rect(".queue-compose-buttons .btn")];
          const send = document.querySelector(".queue-orders .queue-compose-buttons .btn") as HTMLElement;
          const name = document.querySelector(".queue-orders .queue-send-name") as HTMLElement | null;
          const isBeside = button.top < box.bottom;
          return {
            isWide: (document.querySelector(".queue-orders-card") as HTMLElement).clientWidth >= 420,
            isBeside,
            isBoxKept: isBeside ? box.width >= 220 : Math.abs(box.width - row.width) < 1,
            isInRow: button.left >= row.left - 0.5 && button.right <= row.right + 0.5,
            label: send.textContent,
            title: send.title,
            isCut: name !== null && getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
          };
        });
        await page.close();
        rows.push({ width, ...facts });
      }
    }

    const expected = rows.map(({ width, isWide }, index) => {
      const tick = ticks[index % ticks.length]!;
      return { width, isWide, isBeside: isWide, isBoxKept: true, isInRow: true, label: tick.label, title: tick.label, isCut: tick.isCut };
    });
    assert.deepEqual(new Set(rows.map((row) => row.isWide)), new Set([false, true]), "the sweep crosses the 420 pane");
    assert.deepEqual(rows, expected);
  });

  // a commit button never ends in a broken word nor in blank: the resume tail stays whole where the button's room (the row less
  // the 220 box beside it, the whole row under it) holds it beside the head and the name at its 3ch floor, and a dropped tail
  // leaves no width behind → the button ends where its shown label ends. portfolio is the edge fixture's ended session
  test("the Orders send button holds the label it shows: the resume tail whole where the button's room holds it beside the name at its floor, else dropped with no blank left, and the head whole, from 1440 to 1920", async () => {
    const ticks = [["portfolio"], ["gersona", "portfolio"]];
    const rows = [];
    for (const width of [1440, 1568, 1605, 1645, 1690, 1728, 1920]) {
      for (const names of ticks) {
        const page = await openEdgePage(harness, { width, height: 900 });
        await openEndedBand(page);
        await tickSessions(page, names);
        const facts = await page.evaluate(() => {
          const element = (selector: string) => document.querySelector(`.queue-orders ${selector}`) as HTMLElement;
          const [row, box, button, label] = [element(".queue-compose-row"), element(".queue-compose-box"), element(".queue-compose-buttons .btn"), element(".queue-send-label")];
          const [head, tail] = [label.firstElementChild as HTMLElement, label.querySelector(".queue-send-tail") as HTMLElement];
          const name = label.querySelector(".queue-send-name") as HTMLElement | null;
          const [rowBox, boxBox, buttonBox, labelBox] = [row, box, button, label].map((node) => node.getBoundingClientRect());
          const [headBox, tailBox, nameBox] = [head.getBoundingClientRect(), tail.getBoundingClientRect(), name?.getBoundingClientRect()];
          const floor = name === null ? 0 : parseFloat(getComputedStyle(name).minWidth);
          const style = getComputedStyle(button);
          const [padStart, padEnd, edgeStart, edgeEnd] = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].map(parseFloat);
          const room = rowBox.width - (buttonBox.top < boxBox.bottom ? 220 + parseFloat(getComputedStyle(row).columnGap) : 0);
          const isOnLine = tailBox.top < labelBox.bottom - 0.5 && tailBox.right <= labelBox.right + 0.5;
          const isWhole = isOnLine && tail.scrollWidth <= tail.clientWidth;
          const shownEnd = Math.max(headBox.right, nameBox?.right ?? 0, isWhole ? tailBox.right : 0);
          return {
            hasRoom: padStart + padEnd + edgeStart + edgeEnd + headBox.width + Math.min(name?.scrollWidth ?? 0, floor) + tailBox.width <= room + 0.5,
            tail: isWhole ? "whole" : isOnLine ? "cut" : "dropped",
            blankEnd: Math.round(buttonBox.right - edgeEnd - padEnd - shownEnd),
            isHeadWhole: headBox.right <= labelBox.right + 0.5,
          };
        });
        await page.close();
        rows.push({ width, names: names.join(","), ...facts });
      }
    }

    assert.deepEqual(new Set(rows.map((row) => row.hasRoom)), new Set([false, true]), "the sweep crosses the width where the tail fits");
    assert.deepEqual(rows, rows.map((row) => ({ ...row, tail: row.hasRoom ? "whole" : "dropped", blankEnd: 0, isHeadWhole: true })));
  });

  // spec §4.5 / §12.5: Add images is a glyph inside the one bordered field → no edge of its own, at rest, hovered or held;
  // under the pointer it takes the icon button's fills: the selection tint, held the stronger tag fill
  test("Add images draws no edge of its own inside the order box, at rest or under the pointer, and takes the selection tint hovered and the tag fill held", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const add = page.locator(".queue-orders .queue-compose-add");
    const [tint, tintFill] = await getTintFills(page);
    const tokenByFill = new Map([[tint, "--tint-select"], [tintFill, "--tint-fill"]]);
    // the button's colour transition settled first → the look the state ends on, never a mid-fade blend
    const getLook = async () => {
      const look = await add.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(element);
        const alpha = style.borderTopColor.startsWith("rgba") ? Number(style.borderTopColor.split(",").at(-1)?.replace(")", "")) : 1;
        return { isEdgeless: parseFloat(style.borderTopWidth) === 0 || alpha === 0, fill: style.backgroundColor };
      });
      return { ...look, fill: tokenByFill.get(look.fill) ?? null };
    };
    const rest = await getLook();
    await add.hover();
    const hovered = await getLook();
    await page.mouse.down();
    const held = await getLook();
    await page.close();

    assert.deepEqual({ rest, hovered, held }, {
      rest: { isEdgeless: true, fill: null },
      hovered: { isEdgeless: true, fill: "--tint-select" },
      held: { isEdgeless: true, fill: "--tint-fill" },
    });
  });

  // spec §9.2: a focused entry's ring stands clear of its time line and its Resend, and the thread's column does not clip it
  test("a focused thread entry's ring stands outside the entry, inside the thread", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await waitForAllOrders(page);
    const facts = await page.evaluate(() => {
      const entry = document.querySelector(".queue-order") as HTMLElement;
      entry.focus();
      const style = getComputedStyle(entry);
      const outset = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      const ring = entry.getBoundingClientRect();
      const log = (entry.closest(".queue-thread") as HTMLElement).getBoundingClientRect();
      return { isClear: parseFloat(style.outlineOffset) > 0, isInside: ring.left - outset >= log.left && ring.right + outset <= log.right };
    });
    await page.close();

    assert.deepEqual(facts, { isClear: true, isInside: true });
  });

  // spec §12.2: the thread's last bubble and what stands under it stay in view while the composer grows under a draft
  test("a thread at its end stays at its end when a longer draft grows the composer", async () => {
    const page = await openEdgePage(harness, { width: 1568, height: 759 });
    await waitForAllOrders(page);
    await page.locator(`#${ORDER_BOX_ID}`).fill("first line of the order\nsecond line\nthird line\nfourth line");
    const facts = await page.evaluate(() => new Promise<{ isShrunk: boolean; isAtEnd: boolean }>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const log = document.querySelector(".queue-thread") as HTMLElement;
        const composer = document.querySelector(".queue-orders .queue-composer") as HTMLElement;
        resolve({ isShrunk: composer.getBoundingClientRect().height > 174, isAtEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 2 });
      }));
    }));
    await page.close();

    assert.deepEqual(facts, { isShrunk: true, isAtEnd: true });
  });

  // spec §9.8 → Upload failed, §12.5: the note takes the wrap; Try again keeps its word, whole on one line beside it, on the quiet edge
  test("a failed upload's Try again is a quiet word button with its edge, on one line beside a wrapping note", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    harness.refusals.set("upload", { status: 500, body: { error: "server" } });
    try {
      await addOrderFiles(page, [{ ...getImageFile(0), name: "a-screenshot-named-long-enough-to-wrap-the-note.png" }]);
      await page.locator(".queue-thumb-failed").first().waitFor();
      const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
      const facts = await page.getByRole("button", { name: "Try again" }).evaluate((button) => {
        const [box, style] = [button.getBoundingClientRect(), getComputedStyle(button)];
        const note = (button.previousElementSibling as HTMLElement).getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(button.previousElementSibling as HTMLElement).lineHeight);
        return {
          id: button.id, text: button.textContent?.trim(), isOneLine: box.height < lineHeight * 2, edge: `${style.borderTopWidth} ${style.borderTopColor}`,
          isBeside: box.left >= note.right, isNoteWrapped: note.height > lineHeight * 1.5,
        };
      });
      assert.deepEqual(facts, { id: `${ORDER_BOX_ID}-retry`, text: "Try again", isOneLine: true, edge: `1px ${tokens.controlEdge}`, isBeside: true, isNoteWrapped: true });
    } finally {
      harness.refusals.clear();
      await page.close();
    }
  });

  test("the thread opens at its end, and its composer stays in view at every scroll position of the thread", async () => {
    const page = await openEdgePage(harness, { width: 1568, height: 759 });
    await waitForAllOrders(page);
    const facts = await page.evaluate(() => {
      const log = document.querySelector(".queue-thread") as HTMLElement;
      const composer = document.querySelector(".queue-orders .queue-composer") as HTMLElement;
      const end = log.scrollHeight - log.clientHeight;
      const isAtEnd = end - log.scrollTop < 2;
      const isComposerInView = [0, end / 2, end].map((top) => {
        log.scrollTop = top;
        const box = composer.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      });
      return { isOverflowing: end > 0, isAtEnd, isComposerInView };
    });
    await page.close();

    assert.deepEqual(facts, { isOverflowing: true, isAtEnd: true, isComposerInView: [true, true, true] });
  });

  test("an order bubble is no wider than 85% of the thread's column and no wider than 66ch of its own text", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await waitForAllOrders(page);
    const bubbles = await page.evaluate(() => {
      const log = document.querySelector(".queue-thread") as HTMLElement;
      const pad = getComputedStyle(log);
      const column = log.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      return [...document.querySelectorAll(".queue-bubble")].map((bubble) => {
        const text = bubble.querySelector(".prose-text") as HTMLElement;
        const probe = text.appendChild(Object.assign(document.createElement("span"), { style: "display: block; width: 66ch" }));
        const measure = probe.getBoundingClientRect().width;
        probe.remove();
        return { width: bubble.getBoundingClientRect().width, limit: Math.min(0.85 * column, measure) };
      });
    });
    await page.close();

    assert.ok(bubbles.length > 0 && bubbles.every(({ width, limit }) => width <= limit + 0.5), JSON.stringify(bubbles));
  });

  // spec 44063 §9.1–§9.4 and §14.4 (Next turn stream only): Next turn and Not yet side by side on every surface
  // spec §4.6, §14.3 (One list): the history read with kind item under the open bands, scoped on the server by the ticks; Done day bands; a read-only sheet
  describe("on the done fixtures", () => {
    const openDonePage = async (fixture = getDoneFixture(), hash = ""): Promise<{ page: Page; reads: URLSearchParams[] }> => {
      harness.fixture = fixture;
      const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
      const reads: URLSearchParams[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/queue/owner/orders" && url.searchParams.get("kind") === "item") reads.push(url.searchParams);
      });
      // the first reads after the listener → every done read is recorded; a hash → the page opens on it
      if (hash !== "") await page.evaluate((next) => { location.hash = next; }, hash);
      await page.reload({ waitUntil: "load" });
      await waitForDoneBands(page);
      return { page, reads };
    };
    // every band and row in list order: a band's text and count badges, a row's part (open or done), its tag and fact, its title's weight and colour
    const getListRows = (page: Page) => page.evaluate(() => ({
      hash: location.hash,
      bands: [...document.querySelectorAll(".queue-listbox .queue-band")].map((band) => [band.textContent, band.querySelectorAll(".pill").length]),
      rows: [...document.querySelectorAll(".queue-listbox .queue-row")].map((row) => [row.id, row.closest('[role="group"]')?.getAttribute("aria-label")?.startsWith("Done") === true]),
      done: [...document.querySelectorAll(".queue-row--done")].map((row) => [row.id, row.querySelector(".queue-row-tag")?.textContent, row.querySelector(".queue-row-fact")?.textContent]),
      looks: [...new Set([...document.querySelectorAll(".queue-row")].map((row) => {
        const title = getComputedStyle(row.querySelector(".queue-row-title") as Element);
        const band = getComputedStyle(row.closest('[role="group"]')?.querySelector(".queue-band") as Element);
        return `${row.classList.contains("queue-row--done")}:${title.fontWeight}:${title.color === band.color ? "dim" : "ink"}`;
      }))],
      bar: document.querySelector(".queue-list > .card-bar") !== null,
    }));

    test("the one list draws the open bands, then the done items newest end first under Done day bands with no count, each row dim 400 with how it ended in the tag column and its kind in the fact column; no bar with one account", async () => {
      const { page, reads } = await openDonePage();
      const shown = await getListRows(page);
      await page.close();

      const firstDone = shown.rows.findIndex(([, isDone]) => isDone);
      const firstDoneBand = shown.bands.findIndex(([text]) => String(text).startsWith("Done"));
      assert.ok(firstDone > 0 && firstDoneBand > 0, "open rows and bands on top");
      assert.deepEqual(shown.rows.slice(firstDone).filter(([, isDone]) => !isDone), [], "every open row above every done row");
      assert.deepEqual({ ...shown, rows: undefined, bands: shown.bands.slice(firstDoneBand), openBands: shown.bands.slice(0, firstDoneBand).every(([, counts]) => counts === 1) }, {
        hash: "#queue",
        bands: [["DoneToday", 0], ["DoneYesterday", 0], ["DoneNov 9", 0]],
        rows: undefined,
        openBands: true,
        done: [
          ["queue-row-801", "Answer R1", "Decision"], ["queue-row-802", "Read", "Report"],
          ["queue-row-803", "Withdrawn", "Decision"], ["queue-row-804", "Replied", "Report"], ["queue-row-805", "Answered", "Decision"],
        ],
        looks: ["false:600:ink", "true:400:dim"],
        bar: false,
      });
      assert.deepEqual(reads.map((query) => Object.fromEntries(query)), [{ limit: "30", kind: "item" }]);
    });

    // layout §1, §6 → Mark: a relay row's title leads with `→` and its recipient; a Done relay says how it ended in plain words with no badge,
    // among the day's decisions and reports by the time of its send; a relay on its way holds no element but its receipt counts
    test("Done and refused relays stand among the day's decisions and reports, titled from the arrow and the recipient, how they ended in plain words and no badge; the redacted relay on its way stands under In delivery", async () => {
      const { page } = await openDonePage(getDoneRelaysFixture());
      const shown = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-listbox [role='group']")].map((band) => ({
        band: band.getAttribute("aria-label") ?? band.querySelector(".queue-band")?.firstChild?.textContent,
        kinds: [...band.querySelectorAll(".queue-row")].map((row) => row.querySelector(".queue-row-fact")?.textContent),
        relays: [...band.querySelectorAll(".queue-row")].filter((row) => /^(Refused relay|Relay) from/.test(row.getAttribute("aria-label") ?? "")).map((row) => ({
          to: row.querySelector(".queue-row-title")?.textContent?.match(/^→ (\d+ sessions|\d+ unknown recipients?|\S+) /)?.[1] ?? null,
          tag: row.classList.contains("queue-row--done") ? row.querySelector(".queue-row-tag")?.textContent : "on its way",
          // a Done row's every pill · a row on its way, the pills outside its receipt counts
          pills: [...row.querySelectorAll(".pill")].filter((pill) => row.classList.contains("queue-row--done") || pill.closest(".queue-row-tag") === null).length,
        })),
      })));
      const redacted = await page.locator(".queue-row", { hasText: "Text redacted" }).evaluate((row) => [row.closest("[role='group']")?.querySelector(".queue-band")?.firstChild?.textContent, row.querySelector(".queue-row-title")?.textContent]);
      await page.close();

      // an open band's kinds are the open list's; a Done band's run newest last act first
      const bands = shown.filter((band) => band.relays.length > 0 || String(band.band).startsWith("Done"))
        .map(({ band, kinds, relays }) => (String(band).startsWith("Done") ? { band, kinds, relays } : { band, relays }));
      assert.deepEqual(bands, [
        { band: "In delivery", relays: [{ to: "atrium", tag: "on its way", pills: 0 }] },
        { band: "Done, Today", kinds: ["Decision", "Report", "Relay", "Relay"], relays: [{ to: "yoaida", tag: "Refused", pills: 0 }, { to: "2 sessions", tag: "1 lapsed", pills: 0 }] },
        { band: "Done, Yesterday", kinds: ["Decision", "Relay", "Report"], relays: [{ to: "gersona", tag: "Received", pills: 0 }] },
        { band: "Done, Nov 9", kinds: ["Decision"], relays: [] },
      ]);
      assert.deepEqual(redacted, ["In delivery", "→ atrium Text redacted"]);
    });

    test("ticking a session scopes the done read on the server, and both parts hold that session alone", async () => {
      const { page, reads } = await openDonePage();
      await tickSessions(page, ["atrium"]);
      await page.waitForFunction(() => document.querySelectorAll(".queue-row--done").length === 1);
      const shown = await getListRows(page);
      const names = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-row")].map((row) => row.getAttribute("aria-label")?.match(/ from (\S+):/)?.[1] ?? "atrium"))]);
      await page.close();

      assert.deepEqual([shown.done, names], [[["queue-row-802", "Read", "Report"]], ["atrium"]]);
      assert.deepEqual(reads.at(-1)?.get("sessionIds"), FIXTURE_SESSION_IDS.atrium);
    });

    test("with nothing open the Done bands start at the top and the head reads 0 waiting", async () => {
      const { page } = await openDonePage(getDoneOnlyFixture());
      const shown = await page.evaluate(() => ({
        first: document.querySelector(".queue-listbox .queue-band")?.textContent,
        isWaiting: document.querySelector(".queue-list")?.textContent?.includes("0 waiting"),
      }));
      await page.close();

      assert.deepEqual([shown.first, shown.isWaiting], ["DoneToday", true]);
    });

    test("Show more stands one 44 line after the last row inside the list's scroll, start-aligned, and reads the next done page", async () => {
      const { page, reads } = await openDonePage(getManyDoneFixture());
      const before = await page.evaluate(() => {
        const end = document.querySelector(".queue-list-end") as HTMLElement;
        const button = end.querySelector("button") as HTMLElement;
        const listbox = document.querySelector(".queue-listbox") as HTMLElement;
        return {
          parent: end.parentElement?.matches(".queue-list > .card-body"),
          height: Math.round(end.getBoundingClientRect().height),
          afterRows: Math.round(end.getBoundingClientRect().top - listbox.getBoundingClientRect().bottom),
          inset: Math.round(button.getBoundingClientRect().left - end.getBoundingClientRect().left),
          rows: document.querySelectorAll(".queue-row--done").length,
          isFootFree: document.querySelector(".queue-list > .card-foot")?.textContent?.includes("Show more") === false,
        };
      });
      await showMoreDone(page);
      const after = await page.evaluate(() => ({ rows: document.querySelectorAll(".queue-row--done").length, hasEnd: document.querySelector(".queue-list-end") !== null }));
      await page.close();

      assert.deepEqual(before, { parent: true, height: 44, afterRows: 0, inset: 16, rows: 30, isFootFree: true });
      assert.deepEqual(after, { rows: 40, hasEnd: false });
      assert.ok(reads.at(-1)?.has("before"), "the second read pages back by cursor");
    });

    test("Down from the last open row focuses the first done row and Up returns, one tab stop across the boundary", async () => {
      const { page } = await openDonePage();
      const ids = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".queue-listbox .queue-row")];
        const first = rows.findIndex((row) => row.classList.contains("queue-row--done"));
        return { last: rows[first - 1]?.id, first: rows[first]?.id, stops: rows.filter((row) => row.getAttribute("tabindex") === "0").length };
      });
      await page.locator(`#${ids.last}`).focus();
      await page.keyboard.press("ArrowDown");
      const down = await page.evaluate(() => document.activeElement?.id);
      await page.keyboard.press("ArrowUp");
      const up = await page.evaluate(() => document.activeElement?.id);
      await page.close();

      assert.deepEqual([down, up, ids.stops], [ids.first, ids.last, 1]);
    });

    test("an applied account draws the bar, and its Reset filters is quiet: no edge at rest, a faint fill on hover", async () => {
      const { page } = await openDonePage(getDoneFixture(), "#queue?profile=.claude-work");
      const reset = page.locator(".filter-bar-reset");
      // the button's colour transition settled first → the look read is the state's, not a frame of the fade
      const getLook = () => reset.evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
        return { edge: getComputedStyle(node).borderTopColor, fill: getComputedStyle(node).backgroundColor };
      });
      const rest = await getLook();
      await reset.hover();
      const hovered = await getLook();
      await page.close();
      const CLEAR = "rgba(0, 0, 0, 0)";
      assert.deepEqual([rest, hovered.edge, hovered.fill !== CLEAR], [{ edge: CLEAR, fill: CLEAR }, CLEAR, true]);
    });

    test("a done row opens its read-only sheet: the answer shown, no composer, its foot how and when it ended; J steps to the next done item", async () => {
      const { page } = await openDonePage();
      await selectRow(page, DONE_IDS.answered);
      const getSheet = () => page.evaluate(() => ({
        kind: document.querySelector(".queue-sheet-head .pill")?.textContent,
        foot: document.querySelector(".queue-sheet .card-foot")?.textContent,
        controls: document.querySelectorAll(".queue-sheet .card-foot :is(button, textarea, input)").length,
        hasAnswer: document.querySelector(".queue-sheet-body")?.textContent?.includes("Your answer"),
        position: document.querySelector(".queue-steps")?.textContent,
      }));
      await page.locator(".queue-sheet .card-foot", { hasText: "Answer R1 ·" }).waitFor();
      const answered = await getSheet();
      await page.keyboard.press("j");
      await page.locator(".queue-sheet .card-foot", { hasText: "Read ·" }).waitFor();
      const read = { ...(await getSheet()), hash: await page.evaluate(() => location.hash) };
      await page.close();

      const [at, of] = String(answered.position).split(" of ").map(Number);
      assert.deepEqual({ ...answered, position: undefined }, { kind: "Decision", foot: "Answer R1 · Nov 13 14:57", controls: 0, hasAnswer: true, position: undefined });
      assert.deepEqual(read, { kind: "Report", foot: "Read · Nov 13 14:00", controls: 0, hasAnswer: false, position: `${at! + 1} of ${of}`, hash: "#queue?item=802" });
      assert.ok(at! > 1, "the done rows step on from the open ones");
    });
  });

  describe("on the not-listening fixtures", () => {
    const SENTENCE = "Next turn — delivers at its next turn end or restart";
    const openNotListeningPage = (): Promise<Page> => {
      harness.fixture = getNotListeningFixture();
      return openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    };

    test("under one order a listening recipient holds the tag Not yet and a not-listening one the tag Next turn: the same fill, told apart by its glyph and words, its sentence only in the title", async () => {
      const page = await openNotListeningPage();
      await page.locator(`#queue-order-${NOT_LISTENING_IDS.mixedOrder}`).scrollIntoViewIfNeeded();
      const rows = await page.evaluate((id) => [...document.querySelectorAll(`#queue-order-${id} .queue-recipient`)].map((row) => {
        const badge = row.querySelector(".pill--tag") as HTMLElement;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        const painted: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(".sr-only")) painted.push(node.textContent ?? "");
        const glyph = badge.firstElementChild;
        const shapes = glyph?.tagName === "svg" ? [...glyph.children] : [];
        return {
          name: row.querySelector(".queue-recipient-name")?.textContent,
          word: [...badge.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""),
          isGlyphDrawn: glyph?.tagName === "svg" && glyph.childElementCount > 0,
          // solid in the badge's ink: every shape filled in the word's colour, none drawn as a hairline
          isGlyphSolid: shapes.length > 0 && shapes.every((shape) => getComputedStyle(shape).fill === getComputedStyle(badge).color && getComputedStyle(shape).stroke === "none"),
          title: badge.getAttribute("title"),
          background: getComputedStyle(badge).backgroundColor,
          isSentencePainted: painted.join("").includes("delivers at"),
        };
      }), NOT_LISTENING_IDS.mixedOrder);
      await page.close();

      assert.deepEqual(rows.map(({ background: _background, ...row }) => row), [
        { name: "gersona", word: "Not yet", isGlyphDrawn: false, isGlyphSolid: false, title: null, isSentencePainted: false },
        { name: "sixmon", word: "Next turn", isGlyphDrawn: true, isGlyphSolid: true, title: SENTENCE, isSentencePainted: false },
      ]);
      assert.equal(rows[0]?.background, rows[1]?.background, "one tag fill for both");
    });

    test("a live session that does not listen draws the bare pause mark in its tag column, named Next turn, its hover line the title and the box's description by keyboard; a listening one draws no tag", async () => {
      const page = await openNotListeningPage();
      const tagOf = (id: string) => page.locator(`.queue-rail-row[data-session="${id}"] .queue-rail-tag`);
      const mark = await tagOf(NOT_LISTENING_SESSION_IDS.nightly).getByRole("img", { name: "Next turn" }).evaluate((node) => ({
        glyph: node.querySelectorAll("svg rect").length, shell: getComputedStyle(node).borderTopWidth, width: Math.round(node.getBoundingClientRect().width),
      }));
      const listening = await tagOf(FIXTURE_SESSION_IDS.gersona).count();
      await page.keyboard.press("Tab");
      await page.getByLabel("Select nightly", { exact: true }).focus();
      const focused = await page.evaluate(() => {
        const box = document.activeElement as HTMLElement;
        const row = box.closest(".queue-rail-row") as HTMLElement;
        const description = (box.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        return { name: box.getAttribute("aria-label"), title: row.title.split("\n")[0], description, isRing: getComputedStyle(row).outlineStyle !== "none" };
      });
      await page.close();

      const HOVER = "Next turn: orders reach it then. Restart it to deliver now.";
      assert.deepEqual({ mark, listening }, { mark: { glyph: 2, shell: "0px", width: 12 }, listening: 0 });
      assert.deepEqual([focused.name, focused.title, focused.description.startsWith(HOVER), focused.isRing], ["Select nightly", HOVER, true, true], JSON.stringify(focused));
    });

    test("with a not-listening session ticked the composer's label paints the bare pause mark after its name and the note the sentence, and a send still posts the order", async () => {
      const page = await openNotListeningPage();
      await tickOrdersTo(page, ["nightly"]);
      const posts: string[] = [];
      page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
      const shown = await page.evaluate(() => ({
        tagged: [...document.querySelectorAll(".queue-orders .queue-order-to")].map((to) => [to.firstChild?.textContent, to.querySelector(".queue-state-mark.is-pause")?.getAttribute("title"), to.querySelectorAll(".pill").length]),
        note: [...document.querySelectorAll(".queue-orders .card-foot p")].map((line) => line.textContent).find((text) => text?.includes("next turn")),
      }));
      await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
      // armed before the click → a reply landing before the click resolves is still seen
      const sent = page.waitForResponse((response) => response.url().endsWith("/api/queue/owner/messages/send"));
      await page.locator(".queue-orders").getByRole("button", { name: /^Send to nightly/ }).click();
      await sent;
      await page.close();

      assert.deepEqual(shown, { tagged: [["nightly", "Next turn", 0]], note: "nightly gets this at its next turn. Restart it to deliver now." });
      assert.deepEqual(posts, ["/api/queue/owner/messages/send"]);
    });

    test("in the composer's label each ticked name stays on one line with its mark, and the comma between names follows the mark, at 1280 and 1440", async () => {
      const shown: Array<{ at: number; text: string; lines: number }> = [];
      for (const viewport of [MIN_WINDOW, VIEWPORTS[0]]) {
        for (const names of [["gersona", "nightly"], ["sixmon", "nightly"]]) {
          harness.fixture = getNotListeningFixture();
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await tickOrdersTo(page, names);
          const tos = await page.evaluate(() => [...document.querySelectorAll(".queue-orders .queue-order-to")].map((to) => {
            const range = document.createRange();
            range.selectNodeContents(to);
            // the mark and the name sit a few px apart on one line → a new line is a step of more than 10 in the boxes' middles
            const middles = [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => (rect.top + rect.bottom) / 2).sort((a, b) => a - b);
            const lines = 1 + middles.filter((middle, index) => index > 0 && middle - (middles[index - 1] ?? middle) > 10).length;
            const marks = [...to.querySelectorAll("[role=img]")].map((mark) => `[${mark.getAttribute("aria-label")}]`);
            return { text: `${to.firstChild?.textContent}${marks.map((mark) => ` ${mark}`).join("")}${to.textContent?.trim().endsWith(",") ? "," : ""}`, lines };
          }));
          await page.close();
          shown.push(...tos.map((to) => ({ at: viewport.width, ...to })));
        }
      }

      assert.deepEqual(shown.filter((to) => to.lines !== 1), [], "one line per name and its mark");
      assert.deepEqual(shown.filter((to) => to.at === MIN_WINDOW.width).map((to) => to.text).slice(2), ["sixmon [Next turn],", "nightly [Next turn]"]);
    });

    test("an order to two sessions that do not listen reads 0 of 2 and ⏸ 2 in its tag column; the ended session's resume copy reads Not yet; nothing of the state is amber", async () => {
      const page = await openNotListeningPage();
      const shown = await page.evaluate((ids) => {
        const textOf = (selector: string) => (document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
        const cellsOf = (id: number) => ({ fact: textOf(`#queue-row-${id} .queue-row-fact`), tags: [...document.querySelectorAll(`#queue-row-${id} .queue-row-tag .pill`)].map((tag) => tag.getAttribute("title")) });
        const amber = [ids.mixedOrder, ids.deafOrder, ids.resumeOrder].flatMap((id) => [...document.querySelectorAll(`#queue-row-${id} .pill--warn, #queue-order-${id} .pill--warn`)]);
        return {
          deaf: cellsOf(ids.deafOrder),
          mixed: cellsOf(ids.mixedOrder),
          resume: textOf(`#queue-order-${ids.resumeOrder} .queue-recipient .pill`),
          amber: amber.length,
        };
      }, { mixedOrder: NOT_LISTENING_IDS.mixedOrder, deafOrder: NOT_LISTENING_IDS.deafOrder, resumeOrder: NOT_LISTENING_IDS.resumeOrder });
      await page.close();

      assert.deepEqual([shown.deaf, shown.mixed], [{ fact: "0 of 2", tags: ["2 next turn"] }, { fact: "0 of 2", tags: ["1 next turn"] }]);
      assert.deepEqual([shown.resume, shown.amber], ["Not yet", 0]);
    });

    test("an answered decision whose session does not listen says so in its date line and under the answer, before the pull line; its listening twin reads Not yet and that its session picks it up", async () => {
      const page = await openNotListeningPage();
      const sheetOf = async (id: number) => {
        await selectRow(page, id);
        await page.locator(`.queue-sheet .queue-date-line`).waitFor();
        const shown = await page.evaluate(() => ({
          receipt: document.querySelector(".queue-sheet .queue-date-line .pill--tag")?.firstChild?.nodeName === "svg"
            ? `⏸ ${[...(document.querySelector(".queue-sheet .queue-date-line .pill--tag")?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("")}`
            : document.querySelector(".queue-sheet .queue-date-line .pill--tag")?.textContent,
          lines: [...document.querySelectorAll(".queue-sheet p.fs-meta")].map((line) => line.textContent ?? ""),
        }));
        await page.getByRole("button", { name: "Back to the list" }).click();
        return shown;
      };
      const deaf = await sheetOf(NOT_LISTENING_IDS.answeredDecision);
      const listening = await sheetOf(108);
      await page.close();

      const deafLine = deaf.lines.findIndex((line) => line === "sixmon gets this answer at its next turn. Restart it to deliver now.");
      const pullLine = deaf.lines.findIndex((line) => line.startsWith("Run in that session:"));
      assert.deepEqual([deaf.receipt, deafLine >= 0, pullLine > deafLine], ["⏸ Next turn", true, true], JSON.stringify(deaf));
      assert.deepEqual([listening.receipt, listening.lines.includes("The session is listening: it picks up this answer on its own.")], ["Not yet", true], JSON.stringify(listening));
    });
  });

  // spec 44063 §14.4's edge cases: what the page shows for each, beside the rest state
  // the owner judges the hook's own capture on the Mac and the phone: every line whole, every hidden character a whole tile
  describe("on the secret-approval fixtures", () => {
    const PHONE: Viewport = { width: 360, height: 740, isMobile: true };
    const openScanPage = async (viewport: Viewport) => {
      harness.fixture = getScanApprovalFixture();
      harness.scanReadIds.length = 0;
      return openQueuePage(harness, viewport, getScanApprovalFixture().items[0]!.title);
    };
    const openScanSheet = async (page: Page, id: number, ready: string) => {
      await selectRow(page, id);
      await page.locator(".queue-sheet").getByText(ready).first().waitFor();
    };
    const GONE_ANSWER = "Not approved: the request is gone. Nothing will pass.";
    // the server drops the request after the lines are read → R1 answers its 409 and the list then reads gone; the wait stays under the 15 s check
    const sendDroppedApproval = async (page: Page) => {
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      await page.locator(`#queue-option-${SCAN_IDS.one}-R1`).check();
      harness.refusals.set("action", { status: 409, body: { error: "secret_request_gone" } });
      harness.fixture = { ...harness.fixture, items: harness.fixture.items.map((item) => (item.id === SCAN_IDS.one ? { ...item, scanApproval: SCAN_GONE_FACTS } : item)) };
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      await page.locator(".queue-sheet").getByText("Gone: the monitor restarted.").waitFor({ timeout: 5_000 });
    };

    const SHEET_SIZES = [
      { name: "at 1280 wide", viewport: MIN_WINDOW },
      { name: "under phone emulation at the page's 1280 layout width", viewport: PHONE },
    ];
    for (const { name, viewport } of SHEET_SIZES) {
      test(`${name} the long line wraps whole, each mark a whole tile, and the sheet scrolls nothing sideways`, async () => {
        const page = await openScanPage(viewport);
        await openScanSheet(page, SCAN_IDS.long, "2 of 3 lines assign a literal value.");
        const shown = await page.evaluate((points) => {
          const plates = [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-plate")];
          const marks = [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-mark")];
          const texts = plates.flatMap((plate) => [...plate.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? ""));
          const body = document.querySelector<HTMLElement>(".queue-sheet > .card-body")!;
          const getRgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const getLuminance = (rgb: number[]) => {
            const [r, g, b] = rgb.map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          const getRatio = (one: string, two: string) => {
            const [high, low] = [getLuminance(getRgb(one)), getLuminance(getRgb(two))].sort((a, b) => b - a);
            return (high! + 0.05) / (low! + 0.05);
          };
          const tile = getComputedStyle(marks[0]!);
          return {
            plates: plates.length,
            isBodyScrolledSideways: body.scrollWidth > body.clientWidth,
            isEveryPlateWhole: plates.every((plate) => plate.scrollWidth === plate.clientWidth && plate.scrollHeight === plate.clientHeight),
            isEveryPlateUncut: plates.every((plate) => { const style = getComputedStyle(plate); return style.textOverflow !== "ellipsis" && style.maxHeight === "none" && style.overflowX !== "auto"; }),
            isLongWrapped: plates[1]!.getBoundingClientRect().height > 20 * parseFloat(getComputedStyle(plates[1]!).lineHeight),
            isEveryTileWhole: marks.every((mark) => mark.getClientRects().length === 1),
            labels: marks.map((mark) => mark.textContent),
            hasRawMark: texts.some((text) => points.some((point) => text.includes(String.fromCodePoint(point)))),
            contrast: { tileText: getRatio(tile.color, tile.backgroundColor) >= 4.5, tilePlate: getRatio(tile.backgroundColor, getComputedStyle(plates[1]!).backgroundColor) >= 3 },
          };
        }, [...SCAN_MARK_POINTS]);
        await page.close();

        const labels = [...SCAN_MARK_POINTS.map((point) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`), "U+0020"];
        assert.deepEqual(shown, {
          plates: 3, isBodyScrolledSideways: false, isEveryPlateWhole: true, isEveryPlateUncut: true, isLongWrapped: true,
          isEveryTileWhole: true, labels, hasRawMark: false, contrast: { tileText: true, tilePlate: true },
        });
      });
    }

    test("under phone emulation at the page's 1280 layout width the page scrolls nothing sideways", async () => {
      const page = await openScanPage(PHONE);
      await openScanSheet(page, SCAN_IDS.long, "2 of 3 lines assign a literal value.");
      const widths = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollWidth, layout: document.documentElement.clientWidth }));
      await page.close();

      assert.equal(widths.scroll, widths.layout, JSON.stringify(widths));
    });

    test("each line head keeps its columns at 1280: the length whole in 128 after a 12 gap, the line count never split", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.long, "2 of 3 lines assign a literal value.");
      const heads = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-sheet .scan-line-head")].map((head) => {
        const [, length, classes] = [...head.children] as HTMLElement[];
        const count = classes!.querySelector<HTMLElement>("span")!;
        const text = document.createRange();
        text.selectNodeContents(length!);
        return {
          columns: getComputedStyle(head).gridTemplateColumns.split(" ").slice(0, 2), gap: getComputedStyle(head).columnGap,
          isLengthWhole: length!.scrollWidth <= length!.clientWidth && text.getClientRects().length === 1,
          isCountWhole: count.getClientRects().length === 1,
        };
      }));
      await page.close();

      assert.deepEqual(heads, Array.from({ length: 3 }, () => ({ columns: ["112px", "128px"], gap: "12px", isLengthWhole: true, isCountWhole: true })));
    });

    test("a closed Approve is drawn closed: code, label and sides dim at 400, the radio disabled-looking with no hover, its reason line in ink", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.expired, "Expired: no answer within 24 hours.");
      const radio = page.locator(`#queue-option-${SCAN_IDS.expired}-R1`);
      const readLook = () => page.evaluate((id) => {
        const option = document.getElementById(id)!.closest<HTMLElement>(".queue-option")!;
        const style = (selector: string) => getComputedStyle(option.querySelector(selector)!);
        const tone = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
        const radioStyle = getComputedStyle(document.getElementById(id)!);
        return {
          code: style(".queue-option-head .text-dim").color === tone("--dim"),
          label: [style(".queue-option-head").color === tone("--dim"), style(".queue-option-head").fontWeight],
          sides: [...option.querySelectorAll(".queue-option-sides > span")].every((side) => getComputedStyle(side).color === tone("--dim")),
          reason: style(".queue-option-reason").color === tone("--ink"),
          radio: [radioStyle.opacity, radioStyle.cursor, radioStyle.borderColor, getComputedStyle(option).cursor, getComputedStyle(option).backgroundColor],
        };
      }, `queue-option-${SCAN_IDS.expired}-R1`);
      const rest = await readLook();
      await radio.hover();
      const hovered = await readLook();
      await page.close();

      assert.deepEqual({ ...rest, radio: rest.radio.slice(0, 2), option: rest.radio[3] }, { code: true, label: [true, "400"], sides: true, reason: true, radio: ["0.5", "default"], option: "default" });
      assert.deepEqual(hovered.radio, rest.radio, "hover changes nothing on a closed option");
    });

    test("the warning line sits 24 under the facts and 12 above the Options heading", async () => {
      const page = await openScanPage(MIN_WINDOW);
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      const gaps = await page.evaluate(() => {
        const facts = document.querySelector(".queue-sheet .scan-facts")!.getBoundingClientRect();
        const warning = document.querySelector(".queue-sheet .scan-warning")!.getBoundingClientRect();
        const legend = document.querySelector(".queue-sheet .queue-options > legend")!.getBoundingClientRect();
        return { facts: Math.round(warning.top - facts.bottom), options: Math.round(legend.top - warning.bottom) };
      });
      await page.close();

      assert.deepEqual(gaps, { facts: 24, options: 12 });
    });

    // [tag, fact] per row; a fact cell left out reads null
    const ENDED_TAG_ROWS = [
      {
        name: "at 1280, with the fact cell left out, an ended request's tag says Expired or Gone and a waiting one Approval", viewport: MIN_WINDOW,
        expected: { [SCAN_IDS.one]: ["Approval", null], [SCAN_IDS.expired]: ["Expired", null], [SCAN_IDS.gone]: ["Gone", null] },
      },
      {
        name: "at 1440, beside the fact cell, every request's tag says Approval and an ended one's fact Expired or Gone", viewport: VIEWPORTS[0],
        expected: { [SCAN_IDS.one]: ["Approval", "1 line"], [SCAN_IDS.expired]: ["Approval", "Expired"], [SCAN_IDS.gone]: ["Approval", "Gone"] },
      },
    ];
    for (const row of ENDED_TAG_ROWS) {
      test(row.name, async () => {
        const page = await openScanPage(row.viewport);
        const shown = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
          const item = document.getElementById(`queue-row-${id}`)!;
          const fact = item.querySelector<HTMLElement>(".queue-row-fact")!;
          return [id, [item.querySelector<HTMLElement>(".queue-row-tag")!.innerText.trim(), getComputedStyle(fact).display === "none" ? null : fact.innerText.trim()]];
        })), [SCAN_IDS.one, SCAN_IDS.expired, SCAN_IDS.gone]);
        await page.close();

        assert.deepEqual(shown, row.expected);
      });
    }

    test("Send answer on a request the server dropped re-reads at once: the Gone line, no plate or read fact, Approve closed and unpicked, the alert kept", async (t) => {
      t.after(() => harness.refusals.delete("action"));
      const page = await openScanPage(MIN_WINDOW);
      await sendDroppedApproval(page);
      const shown = await page.evaluate((id) => {
        const sheet = document.querySelector<HTMLElement>(".queue-sheet")!;
        const approve = document.getElementById(`queue-option-${id}-R1`) as HTMLInputElement;
        const send = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Send answer")!;
        return {
          plates: sheet.querySelectorAll(".scan-plate").length,
          facts: [...sheet.querySelectorAll(".scan-facts dt")].map((label) => label.textContent),
          approve: [approve.disabled, approve.checked],
          isSendInk: send.classList.contains("primary"),
          alerts: [...sheet.querySelectorAll("[role=alert]")].map((alert) => alert.textContent?.trim()),
        };
      }, SCAN_IDS.one);
      await page.close();

      assert.deepEqual(shown, { plates: 0, facts: [], approve: [true, false], isSendInk: false, alerts: [`✕ ${GONE_ANSWER}`] });
    });

    test("the captured lines are read only when a waiting item's sheet opens, and its row says only how many lines", async () => {
      const page = await openScanPage(MIN_WINDOW);
      const before = [...harness.scanReadIds];
      const row = await page.locator(`#queue-row-${SCAN_IDS.one}`).getAttribute("aria-label");
      await openScanSheet(page, SCAN_IDS.one, "The line assigns a literal value.");
      await page.close();

      assert.deepEqual({ before, after: harness.scanReadIds, isRowFactOnly: /, Approval, 1 line, posted /.test(row ?? "") && !/hello|world|U\+/.test(row ?? "") }, { before: [], after: [SCAN_IDS.one], isRowFactOnly: true });
    });

    test("the named states are captured: the list, each sheet state at 1280, the phone at 360 beside an ordinary decision", async (t) => {
      const dir = await getShotsDir(t);
      t.diagnostic(`secret-approval card: ${dir}`);
      const sheet = (id: number, ready: string) => (page: Page) => openScanSheet(page, id, ready);
      const showEnd = (id: number, ready: string, selector: string) => async (page: Page) => {
        await openScanSheet(page, id, ready);
        await page.locator(selector).evaluate((node) => node.scrollIntoView({ block: "end" }));
      };
      const shots: Array<{ name: string; viewport: Viewport; setUp?: (page: Page) => Promise<void> }> = [
        { name: "1280-list", viewport: MIN_WINDOW },
        { name: "1280-list-delivery", viewport: MIN_WINDOW, setUp: (page) => page.locator(`#queue-row-${SCAN_IDS.approved}`).scrollIntoViewIfNeeded() },
        { name: "1280-sheet-pending", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.one, "The line assigns a literal value.") },
        { name: "360-sheet-pending", viewport: PHONE, setUp: sheet(SCAN_IDS.one, "The line assigns a literal value.") },
        { name: "360-sheet-options-foot", viewport: PHONE, setUp: showEnd(SCAN_IDS.long, "2 of 3 lines assign a literal value.", ".queue-sheet .queue-options") },
        { name: "360-decision-sheet", viewport: PHONE, setUp: sheet(103, "Options") },
        {
          name: "1280-sheet-reading", viewport: MIN_WINDOW,
          setUp: async (page) => {
            await page.route("**/scan-approval", () => undefined);
            await openScanSheet(page, SCAN_IDS.one, "Reading the captured lines…");
          },
        },
        { name: "1280-sheet-read-failed", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.unread, "The captured lines could not be read.") },
        { name: "1280-sheet-marks-long-line", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.long, "2 of 3 lines assign a literal value.") },
        { name: "1280-sheet-long-line-tail", viewport: MIN_WINDOW, setUp: showEnd(SCAN_IDS.long, "2 of 3 lines assign a literal value.", ".queue-sheet .scan-plate >> nth=1") },
        { name: "1280-sheet-third-plate", viewport: MIN_WINDOW, setUp: showEnd(SCAN_IDS.long, "2 of 3 lines assign a literal value.", ".queue-sheet .scan-line >> nth=2") },
        { name: "360-sheet-marks-long-line", viewport: PHONE, setUp: sheet(SCAN_IDS.long, "2 of 3 lines assign a literal value.") },
        { name: "1280-sheet-approved", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.approved, "The line was dropped; its hash remains.") },
        { name: "1280-sheet-ended", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.ended, "Approval ended: used, expired or lost in a monitor restart.") },
        { name: "1280-sheet-declined", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.declined, "The line was dropped; nothing was written.") },
        { name: "1280-sheet-withdrawn", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.withdrawn, "The session withdrew the request. The line was dropped.") },
        { name: "1280-sheet-expired", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.expired, "Expired: no answer within 24 hours.") },
        { name: "1280-sheet-gone", viewport: MIN_WINDOW, setUp: sheet(SCAN_IDS.gone, "Gone: the monitor restarted.") },
        { name: "1280-sheet-conflict", viewport: MIN_WINDOW, setUp: sendDroppedApproval },
      ];
      t.after(() => harness.refusals.delete("action"));
      for (const shot of shots) {
        const page = await openScanPage(shot.viewport);
        await shot.setUp?.(page);
        await page.screenshot({ path: join(dir, `card-${shot.name}.png`), animations: "disabled" });
        await page.close();
      }
      const sizes = await Promise.all(shots.map((shot) => getPngSize(join(dir, `card-${shot.name}.png`))));
      assert.deepEqual(sizes, shots.map((shot) => ({ width: shot.viewport.width, height: shot.viewport.height })));
    });
  });

  describe("on the edge-case fixtures", () => {
    test("a 9-option decision lists its nine options in the author's order with none picked, and its row reads 9 options", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.nineOptions);
      const shown = await page.evaluate((id) => ({
        codes: [...document.querySelectorAll(".queue-sheet .queue-option-head .text-dim")].map((code) => code.textContent),
        picked: [...document.querySelectorAll<HTMLInputElement>(".queue-sheet .ctl-radio")].filter((radio) => radio.checked).length,
        hasCount: document.querySelector(`#queue-row-${id} .queue-row-fact`)?.textContent === "9 options",
      }), EDGE_IDS.nineOptions);
      await page.close();

      assert.deepEqual(shown, { codes: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"], picked: 0, hasCount: true });
    });

    test("an approval-class decision carries the Approval tag on its row and its date line, and its approval line says in ink after an info glyph that an approving answer approves the stated action once", async () => {
      const page = await openEdgePage(harness);
      // the space between `2 options` and the Approval tag on the date line
      const getGap = (selector: string) => page.evaluate((within) => {
        const facts = document.querySelector(within);
        const tag = facts?.querySelector(".pill--tag");
        const count = [...(facts?.querySelectorAll("span") ?? [])].find((span) => /^\d+ options$/.test(span.textContent ?? ""));
        return tag && count ? Math.round(tag.getBoundingClientRect().left - count.getBoundingClientRect().right) : null;
      }, selector);
      // the open sheet takes the list's box → the row is read first
      const row = await page.evaluate((id) => [...document.querySelectorAll(`#queue-row-${id} .queue-row-tag .pill--tag`)].map((badge) => badge.textContent), EDGE_IDS.approval);
      await selectRow(page, EDGE_IDS.approval);
      const dateGap = await getGap(".queue-sheet .queue-date-facts");
      const shown = await page.evaluate(() => ({
        letterhead: [...document.querySelectorAll(".queue-sheet > .card-head .pill--tag, .queue-date-line .pill--tag")].map((badge) => badge.textContent),
        note: document.querySelector(".queue-sheet .queue-approval-line")?.textContent ?? "",
        // the sentence's own colour against the ink and the glyph's against the info token
        tones: (() => {
          const line = document.querySelector(".queue-sheet .queue-approval-line") as HTMLElement;
          const getToken = (name: string) => `rgb(${getComputedStyle(line).getPropertyValue(name).trim().split(/\s+/).join(", ")})`;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let sentence: Node | null = walker.nextNode();
          while (sentence !== null && !sentence.textContent?.startsWith("Approval:")) sentence = walker.nextNode();
          return {
            text: sentence?.parentElement ? getComputedStyle(sentence.parentElement).color === getToken("--ink") : false,
            glyph: getComputedStyle(line.querySelector("[aria-hidden]") as Element).color === getToken("--info"),
          };
        })(),
      }));
      await page.close();

      assert.deepEqual({ row, letterhead: shown.letterhead }, { row: ["Approval"], letterhead: ["Decision", "Approval"] });
      assert.equal(dateGap, 6, "the date line keeps 6 between the count and the tag");
      assert.match(shown.note, /Approval: approving here approves the action once\. aidl does not ask again in its terminal\./);
      assert.deepEqual(shown.tones, { text: true, glyph: true }, "the sentence in ink, its glyph in info");
    });

    // spec §6 → Foot lines, §9.8 → On an answer: at the 1280 minimum eight images and a several-refused line leave the options their room
    test("at the 1280 minimum an approval with eight images and refused files keeps its thumbnails on one row, its tray line one line and both options in view", async () => {
      const state = ANSWER_STATES.find((one) => one.nn === "40i") as QueueState;
      const shown = await readQueueState(harness, MIN_WINDOW, state, (page) => page.evaluate(() => {
        const sheet = document.querySelector(".queue-sheet") as HTMLElement;
        const body = (sheet.querySelector(".card-body") as HTMLElement).getBoundingClientRect();
        return {
          thumbRows: new Set([...sheet.querySelectorAll(".queue-thumb")].map((thumb) => Math.round(thumb.getBoundingClientRect().top))).size,
          trayHeight: Math.round((sheet.querySelector(".queue-tray-line") as HTMLElement).getBoundingClientRect().height),
          optionsOutOfView: [...sheet.querySelectorAll(".queue-option")].filter((option) => option.getBoundingClientRect().bottom > body.bottom).length,
        };
      }));

      assert.deepEqual(shown, { thumbRows: 1, trayHeight: 20, optionsOutOfView: 0 });
    });

    // C-approval-line: a failed upload and a press with nothing picked land on their own lines, the approval line in view above them
    test("an approval-class decision keeps its approval line in view, one 20 line a sentence, through a failed upload on the tray line and a missing answer on the note line", async () => {
      const page = await openEdgePage(harness);
      harness.refusals.set("upload", { status: 500, body: { error: "server" } });
      await selectRow(page, EDGE_IDS.approval);
      await setFiles(page, `queue-text-${EDGE_IDS.approval}`, [getImageFile(0)]);
      await page.locator(".queue-sheet .queue-thumb-failed").waitFor();
      await page.locator(".queue-sheet").getByRole("button", { name: "Send answer" }).click();
      const shown = await page.evaluate(() => {
        const sheet = document.querySelector(".queue-sheet") as HTMLElement;
        const line = sheet.querySelector(".queue-approval-line") as HTMLElement;
        const rect = line.getBoundingClientRect();
        const text = (selector: string) => (sheet.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          isInView: rect.top >= 0 && rect.bottom <= window.innerHeight,
          height: Math.round(rect.height),
          tray: text(".queue-tray-line"),
          note: text(".queue-note-text"),
          description: sheet.querySelector(`#${CSS.escape(sheet.querySelector('[data-key="send"]')?.getAttribute("aria-describedby") ?? "")}`) === line,
        };
      });
      harness.refusals.clear();
      await page.close();

      assert.deepEqual(shown, {
        isInView: true, height: 40,
        tray: "✕ queue-01.webp could not be uploaded: the monitor answered 500.Try again",
        note: "✕ Pick an option or write an answer, then send.",
        description: true,
      });
    });

    test("a 200-character title takes one cut line on its 44 row with the whole title in its tooltip, and wraps in full at 20/28 on the sheet", async () => {
      const page = await openEdgePage(harness, DESK_WIDTHS[0].viewport);
      // the row is measured before its press: an opened row puts the list away
      const row = await page.evaluate((id) => {
        const element = document.querySelector(`#queue-row-${id}`) as HTMLElement;
        const title = element.querySelector(".queue-row-title") as HTMLElement;
        return [Math.round(element.getBoundingClientRect().height), title.getAttribute("title"), getComputedStyle(title).textOverflow === "ellipsis" && title.scrollWidth > title.clientWidth];
      }, EDGE_IDS.longTitle);
      await selectRow(page, EDGE_IDS.longTitle);
      const sheet = await page.evaluate(() => {
        const title = document.querySelector(".queue-sheet-title") as HTMLElement;
        const style = getComputedStyle(title);
        return [title.textContent, title.scrollHeight <= title.clientHeight, `${style.fontSize}/${style.lineHeight}`];
      });
      await page.close();

      assert.deepEqual({ row, sheet }, { row: [44, EDGE_LONG_TITLE, true], sheet: [EDGE_LONG_TITLE, true, "20px/28px"] });
    });

    test("a report whose text names its linked document links the id in its text and adds no Documents line", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.linkedReport);
      const shown = await page.evaluate(() => ({
        links: [...document.querySelectorAll(".queue-sheet-body .prose-link")].map((link) => `${link.textContent} ${link.getAttribute("href")}`),
        hasDocumentsLine: document.querySelector(".queue-sheet-body")?.textContent?.includes("Documents:") === true,
      }));
      await page.close();

      assert.deepEqual(shown, { links: ["44061 #clauded-docs?doc=44061"], hasDocumentsLine: false });
    });

    test("a declared document the text does not name gets a Documents line linking its id", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.declaredReport);
      const line = await page.evaluate(() => {
        const block = [...document.querySelectorAll(".queue-sheet-body .prose-text")].find((text) => text.textContent?.startsWith("Documents:"));
        return block === undefined ? null : [block.textContent, block.querySelector(".prose-link")?.getAttribute("href")];
      });
      await page.close();

      assert.deepEqual(line, ["Documents: 44071", "#clauded-docs?doc=44071"]);
    });

    test("two sessions with one name each show their 8-character id on the rail, and a session with its own name shows none", async () => {
      const page = await openEdgePage(harness);
      const names = await page.evaluate(() => [...document.querySelectorAll(".queue-rail-name-text")].map((name) => name.textContent));
      await page.close();

      assert.deepEqual(
        { atrium: names.filter((name) => name?.startsWith("atrium")), gersona: names.filter((name) => name?.startsWith("gersona")) },
        { atrium: [`atrium · ${FIXTURE_SESSION_IDS.atrium.slice(0, 8)}`, `atrium · ${EDGE_SESSION_IDS.twin.slice(0, 8)}`], gersona: ["gersona"] },
      );
    });

    test("an item from one of two sessions with one name shows that session's 8-character id after the name in its letterhead", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.declaredReport);
      const name = await page.evaluate(() => document.querySelector(".queue-letter [title]")?.textContent);
      await page.close();

      assert.equal(name, `atrium · ${EDGE_SESSION_IDS.twin.slice(0, 8)}`);
    });

    test("a 100-character session name stays on one cut line, its rail row 44 high and inside the rail", async () => {
      const page = await openEdgePage(harness);
      const shown = await page.evaluate((id) => {
        const row = document.querySelector(`.queue-rail-row[data-session="${id}"]`) as HTMLElement;
        const name = row.querySelector(".queue-rail-name-text") as HTMLElement;
        const rail = (document.querySelector(".queue-sessions") as HTMLElement).getBoundingClientRect();
        return {
          text: name.textContent,
          height: Math.round(row.getBoundingClientRect().height),
          isCut: getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
          isInsideRail: row.getBoundingClientRect().right <= rail.right,
        };
      }, EDGE_SESSION_IDS.longName);
      await page.close();

      assert.deepEqual(shown, { text: EDGE_LONG_SESSION_NAME, height: 44, isCut: true, isInsideRail: true });
    });

    // spec §4.2 → Column rule, §14.3: one 44 line — name 104 · title · tag 80 · fact 64 · age 32 · chevron 16, 8 between them and 12 on
    // either side of the title; a band draws the tag and the fact column only while one of its rows fills it, then on every row, an empty
    // cell keeping its width; a column a band leaves out gives the title its width (tag 88, fact 72); under 160 of title (1280, names shown,
    // tag drawn) the fact column is left out, so a drawn title never holds less than 160.
    // The edge fixture's 100-character session is one recipient of a seven-session order → the name fixture sends one open item from it;
    // the Done bands (spec §4.6), relays on their way (spec §9.9) and Done and refused relays beside decisions and reports (layout §6 → Shared x) follow the same rule
    test("with nothing ticked every list row, open, done, a relay on its way, a Done relay or a refused one, is one 44 line on its band's columns at 1280, 1440 and 1568: tag and fact drawn only in a band whose rows fill them, each drawn column at one x in every band, the title taking a left-out column's width, at least 160 of it at 1280, a 100-character name cut inside its 104", async () => {
      // each cell's x from the row's start and its width; a cell the band does not draw → `-`
      const getLayout = (width: number, cols: string) => {
        const isTagShown = cols.split(" ").includes("tag");
        const isFactShown = cols.split(" ").includes("fact") && !(isTagShown && width < 536);
        const trailing = [isTagShown ? 80 : 0, isFactShown ? 64 : 0, 32, 16];
        const drawn = trailing.filter((cell) => cell > 0);
        const title = width - 32 - 104 - drawn.reduce((sum, one) => sum + one) - 8 * (1 + drawn.length) - 8;
        let x = 16;
        return [[104, 12], [title, 12], ...trailing.map((cell) => [cell, cell === 0 ? 0 : 8])].map(([cell, after]) => {
          const at = cell === 0 ? "-" : `${x}+${cell}`;
          x += cell! + after!;
          return at;
        }).join(" ");
      };
      const shown = [];
      for (const { viewport } of DESK_WIDTHS.slice(0, 3)) {
        for (const [fixture, isDone] of [[getNameColumnFixture(), false], [getEdgeFixture(), false], [getDoneRelaysFixture(), true], [getRelayRowFixture(), false]] as const) {
          harness.fixture = fixture;
          const page = await openQueuePage(harness, viewport, getRestReadyText(fixture));
          if (isDone) await waitForDoneBands(page);
          const facts = await page.evaluate((longName) => {
            const rows = [...document.querySelectorAll(".queue-row")];
            const cells = [".queue-row-who", ".queue-row-title", ".queue-row-tag", ".queue-row-fact", ".queue-row-age", ".queue-row-chevron"];
            const getCells = (row: Element) => cells.map((selector) => {
              const box = row.querySelector(selector)?.getBoundingClientRect();
              return box !== undefined && box.width > 0 ? `${Math.round(box.left - row.getBoundingClientRect().left)}+${Math.round(box.width)}` : "-";
            }).join(" ");
            const long = [...document.querySelectorAll<HTMLElement>(".queue-row-name")].find((name) => name.title === longName);
            const longBox = long?.closest(".queue-row-who")?.getBoundingClientRect();
            return {
              rowWidths: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().width)))],
              bands: [...document.querySelectorAll<HTMLElement>(".queue-listbox [role='group']")]
                .map((band) => ({ cols: band.dataset.cols ?? "unset", layouts: [...new Set([...band.querySelectorAll(".queue-row")].map(getCells))] })),
              heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))],
              emptyTags: rows.filter((row) => row.querySelector(".queue-row-tag")?.childElementCount === 0).length,
              isLongCut: long === undefined || (longBox !== undefined && getComputedStyle(long).textOverflow === "ellipsis" && long.scrollWidth > long.clientWidth && long.getBoundingClientRect().right <= longBox.right + 0.5),
            };
          }, EDGE_LONG_SESSION_NAME);
          await page.close();
          shown.push({ width: viewport.width, isDone, ...facts });
        }
      }

      assert.ok(shown.every((one) => one.rowWidths.length === 1), "rows of one width");
      assert.ok(shown.some((one) => one.emptyTags > 0), "a drawn tag column keeps an empty cell's width");
      assert.deepEqual([...new Set(shown.flatMap((one) => one.bands.map((band) => band.cols)))].sort(), ["", "fact", "tag fact"], "bands that draw neither, the fact alone, and both");
      assert.deepEqual(
        shown.map(({ width, rowWidths, bands, heights, isLongCut }) => ({ width, bands, heights, isLongCut, pane: rowWidths[0] })),
        shown.map(({ width, rowWidths, bands }) => ({ width, bands: bands.map(({ cols }) => ({ cols, layouts: [getLayout(rowWidths[0]!, cols)] })), heights: [44], isLongCut: true, pane: rowWidths[0] })),
      );
      assert.deepEqual(shown.filter((one) => one.width < 1568).map((one) => one.rowWidths[0]), [482, 482, 482, 482, 586, 586, 586, 586], "the panes of DESK_WIDTHS, less the card's two 1 px borders");
      const titles1280 = shown.filter((one) => one.width === 1280).flatMap((one) => one.bands.map((band) => Number(band.layouts[0]?.split(" ")[1]?.split("+")[1])));
      assert.ok(titles1280.every((title) => title >= 160), `the 1280 title holds 160: ${titles1280}`);
    });

    // spec §9.3 / §18.4 27: the thread's recipient row holds the long name the rail holds — one cut line, the receipt and Resend whole beside it
    test("a 100-character session name stays on one cut line in its thread recipient row, its full name in the title, its receipt and Resend whole", async () => {
      const page = await openEdgePage(harness);
      await showThreadText(page, "7 sessions · 5 received · 1 not yet");
      const shown = await page.evaluate((longName) => {
        const name = [...document.querySelectorAll(".queue-recipient-name")].find((node) => node.textContent === longName) as HTMLElement;
        const row = name.closest(".queue-recipient") as HTMLElement;
        const thread = (row.closest(".queue-thread") as HTMLElement).getBoundingClientRect();
        const others = [...row.children].filter((child) => child !== name) as HTMLElement[];
        return {
          title: name.getAttribute("title"),
          isOneLine: name.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(name).lineHeight),
          isCut: getComputedStyle(name).textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth,
          areOthersWhole: others.length === 2 && others.every((child) => child.scrollWidth <= child.clientWidth && child.getClientRects().length === 1 && child.getBoundingClientRect().height < 40),
          isInsideThread: row.getBoundingClientRect().left >= thread.left && row.getBoundingClientRect().right <= thread.right,
        };
      }, EDGE_LONG_SESSION_NAME);
      await page.close();

      assert.deepEqual(shown, { title: EDGE_LONG_SESSION_NAME, isOneLine: true, isCut: true, areOthersWhole: true, isInsideThread: true });
    });

    // spec §9.3 Bubble: the clamp clips at the text's box → a numbered list's widest marker (two digits past 9) stays inside it
    test("a clamped order bubble's numbered list holds its widest marker inside the clipped text box", async () => {
      const page = await openEdgePage(harness, VIEWPORTS[2]);
      await showThreadText(page, "Show all 31 lines");
      const lists = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-bubble.is-clamped > .prose-text")].flatMap((prose) => {
        const clipLeft = prose.getBoundingClientRect().left + prose.clientLeft;
        return [...prose.querySelectorAll("ol")].map((list) => {
          const items = [...list.children] as HTMLElement[];
          const widest = `${list.start + items.length - 1}. `;
          const context = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
          const marker = getComputedStyle(items.at(-1) as Element, "::marker");
          context.font = `${marker.fontWeight} ${marker.fontSize} ${marker.fontFamily}`;
          return { widest, overhang: Math.round(clipLeft - ((items.at(-1) as HTMLElement).getBoundingClientRect().left - context.measureText(widest).width)) };
        });
      }));
      await page.close();

      assert.ok(lists.some((list) => list.widest.length > 3), `a clamped list numbers past 9: ${JSON.stringify(lists)}`);
      assert.deepEqual(lists.filter((list) => list.overhang > 0), [], JSON.stringify(lists));
    });

    // spec §9.3 Bubble: a long order shows 12 whole lines under its clamp, block gaps between paragraphs and list items included
    test("a 31-line order's clamped bubble shows 12 whole lines and no line cut through", async () => {
      const page = await openEdgePage(harness);
      await showThreadText(page, "Show all 31 lines");
      const shown = await page.evaluate(() => {
        const prose = document.querySelector(".queue-bubble.is-clamped > .prose-text") as HTMLElement;
        const bottom = prose.getBoundingClientRect().bottom;
        const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
        const lines: DOMRect[] = [];
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          lines.push(...[...range.getClientRects()].filter((rect) => rect.height > 0));
        }
        const tops = new Set(lines.filter((rect) => rect.bottom <= bottom + 0.5).map((rect) => Math.round(rect.top)));
        return { shown: tops.size, isAnyCut: lines.some((rect) => rect.top < bottom - 0.5 && rect.bottom > bottom + 0.5) };
      });
      await page.close();

      assert.deepEqual(shown, { shown: 12, isAnyCut: false });
    });

    // spec §9.3 `Five recipients or more`: one roll-up, the chevron right before its counts; the amber badge may take its own line.
    // Counts wider than the order's column wrap between their segments, each `n word` whole, every line flush with the column's end
    const rollUps = [
      { name: "seven sessions in three segments", getFixture: getEdgeFixture, counts: "7 sessions · 5 received · 1 not yet" },
      { name: "seven sessions in four segments", getFixture: getNotListeningEdgeFixture, counts: "7 sessions · 5 received · 1 not yet · 1 next turn" },
      { name: "twelve sessions in four segments", getFixture: getNotListeningEdgeFixture, counts: "12 sessions · 10 received · 1 not yet · 1 next turn" },
    ];
    for (const viewport of [MIN_WINDOW, VIEWPORTS[0]]) {
      for (const rollUp of rollUps) {
        test(`at ${viewport.width}, ${rollUp.name}: the roll-up's counts stay inside the order's column, breaking only between whole segments, end-aligned, the chevron right before the first`, async () => {
          harness.fixture = rollUp.getFixture();
          const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
          await showThreadText(page, rollUp.counts);
          const shown = await page.evaluate((text) => {
            const counts = [...document.querySelectorAll(".queue-roll-up > summary *")].find((node) => node.textContent?.replace(/\s+/g, " ").trim() === text) as HTMLElement;
            const column = (counts.closest(".queue-order") as HTMLElement).getBoundingClientRect();
            const box = counts.getBoundingClientRect();
            const chevron = (counts.closest("summary") as HTMLElement).querySelector(".disclosure-chevron")?.getBoundingClientRect();
            const segments: DOMRect[][] = [];
            const walker = document.createTreeWalker(counts, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              segments.push([...range.getClientRects()].filter((rect) => rect.width > 0));
            }
            const rects = segments.flat().sort((a, b) => a.top - b.top || a.left - b.left);
            const lines: DOMRect[][] = [];
            for (const rect of rects) {
              const line = lines.at(-1);
              if (line !== undefined && rect.top < line[0].bottom - 1) line.push(rect);
              else lines.push([rect]);
            }
            const first = [...(lines[0] ?? [])].sort((a, b) => a.left - b.left)[0];
            const gap = parseFloat(getComputedStyle(counts.closest("summary") as HTMLElement).columnGap) || 0;
            return {
              isInColumn: box.left >= column.left - 0.5 && box.right <= column.right + 0.5 && (chevron?.left ?? -1) >= column.left - 0.5,
              isEachSegmentWhole: segments.every((parts) => parts.length === 1),
              isEachLineEndAligned: lines.every((line) => Math.abs(Math.max(...line.map((rect) => rect.right)) - box.right) <= 1),
              isEachLineOneBaseline: lines.every((line) => line.every((rect) => Math.abs(rect.bottom - line[0].bottom) <= 0.5)),
              isChevronBeside: chevron !== undefined && first !== undefined && first.left - chevron.right >= 0 && first.left - chevron.right <= gap + 1 && chevron.top < first.bottom && chevron.bottom > first.top,
            };
          }, rollUp.counts);
          await page.close();

          assert.deepEqual(shown, { isInColumn: true, isEachSegmentWhole: true, isEachLineEndAligned: true, isEachLineOneBaseline: true, isChevronBeside: true });
        });
      }
    }

    test("a session with 128 items waiting shows 99+ in its 20 high count badge", async () => {
      const page = await openEdgePage(harness);
      const badge = await page.evaluate((id) => {
        const count = document.querySelector(`.queue-rail-row[data-session="${id}"] .queue-rail-count .pill`) as HTMLElement | null;
        return count === null ? null : [count.textContent, Math.round(count.getBoundingClientRect().height)];
      }, EDGE_SESSION_IDS.busy);
      await page.close();

      assert.deepEqual(badge, ["99+", 20]);
    });

    test("the thread holds order entries only, and an order to three sessions shows each recipient's one receipt and no other text", async () => {
      const page = await openEdgePage(harness);
      await waitForAllOrders(page);
      const shown = await page.evaluate(() => {
        const isOrdersOnly = [...document.querySelectorAll(".queue-day-group > *")].every((entry) => entry.matches(".queue-day, article.queue-order"));
        const entry = [...document.querySelectorAll("article.queue-order")].find((order) => order.querySelectorAll(".queue-recipient").length === 3);
        const recipients = [...(entry?.querySelectorAll(".queue-recipient") ?? [])].map((row) => {
          const copy = row.cloneNode(true) as HTMLElement;
          for (const button of copy.querySelectorAll("button")) button.remove();
          const name = row.querySelector(".queue-recipient-name")?.textContent ?? "";
          const receipts = copy.textContent?.match(/Received|Not yet|Not received/g) ?? [];
          const residue = (copy.textContent ?? "").replace(name, "").replace(/Received|Not yet|Not received/, "").replace(/[✓⚠·\s]|\d\d:\d\d/g, "");
          return { name, receipts, residue };
        });
        return { isOrdersOnly, recipients };
      });
      await page.close();

      assert.deepEqual(shown, {
        isOrdersOnly: true,
        recipients: [
          { name: "gersona", receipts: ["Received"], residue: "" },
          { name: "aidl", receipts: ["Not yet"], residue: "" },
          { name: "yoaida", receipts: ["Not received"], residue: "" },
        ],
      });
    });

    test("an order with eight images reads Order on its row, 8 images in the row's title, and shows eight 96 squares in its bubble, each named n of 8", async () => {
      const page = await openEdgePage(harness);
      const row = await page.evaluate((id) => [document.querySelector(`#queue-row-${id} .queue-row-fact`)?.textContent, document.querySelector(`#queue-row-${id}`)?.getAttribute("title")], EDGE_IDS.eightImages);
      await waitForAllOrders(page);
      const images = await page.evaluate(() => {
        const entry = [...document.querySelectorAll("article.queue-order")].find((order) => order.querySelectorAll(".queue-bubble-image").length > 3);
        return [...(entry?.querySelectorAll(".queue-bubble-image") ?? [])].map((button) => {
          const box = button.getBoundingClientRect();
          return `${Math.round(box.width)}x${Math.round(box.height)} ${button.getAttribute("aria-label")}`;
        });
      });
      await page.close();

      assert.deepEqual(row, ["Order", "Order · 8 images"]);
      assert.deepEqual(images, Array.from({ length: 8 }, (_, index) => `96x96 Open image ${index + 1} of 8: queue-edge-0${index + 1}.webp`));
    });

    // spec §4.2, §14.3: receipts in the tag column, worst first — `⚠ n` before `⏸ n` — each a count atom, both whole inside its 80
    test("a list row's receipt counts stand in its tag column, not received before next turn, both whole inside its 80, at 1280", async () => {
      harness.fixture = getNotListeningEdgeFixture();
      const page = await openQueuePage(harness, MIN_WINDOW, getRestReadyText(harness.fixture));
      const tags = await page.evaluate(() => [...document.querySelectorAll(".queue-row-tag")].filter((tag) => tag.childElementCount > 1).map((tag) => {
        const box = tag.getBoundingClientRect();
        const badges = [...tag.children];
        return {
          words: badges.map((badge) => (badge.getAttribute("title") ?? "").replace(/^\d+ /, "")),
          isCountAtom: badges.every((badge) => badge.matches(".pill--tag.pill--num")),
          isWhole: badges.every((badge) => badge.getBoundingClientRect().right <= box.right + 0.5 && badge.scrollWidth <= badge.clientWidth),
          width: Math.round(box.width),
        };
      }));
      await page.close();

      assert.ok(tags.length > 0, "a row counts both");
      assert.deepEqual(tags, tags.map(() => ({ words: ["not received", "next turn"], isCountAtom: true, isWhole: true, width: 80 })));
    });
  });

  test("every sentence the page shows in each named state is twelve words or fewer", async () => {
    const long: string[] = [];
    for (const state of [...QUEUE_STATES, ...CLOSE_UP_STATES]) {
      const viewport = getStateViewports(state)[0] as Viewport;
      const found = await readQueueState(harness, viewport, state, (page) => getLongSentences(page, harness.fixture));
      long.push(...found.map((sentence) => `${state.nn}-${state.name}: ${sentence}`));
    }

    assert.deepEqual(long, []);
  });

  test("each named state is captured at every size §18.4 marks for it as a viewport-sized PNG named for the mockup", async (t) => {
    const dir = await getShotsDir(t);
    t.diagnostic(`captures: ${dir}`);

    const failures = await captureQueueStates(harness, dir);

    assert.deepEqual(failures, []);
    for (const state of QUEUE_STATES) {
      for (const viewport of getStateViewports(state)) {
        const name = getShotName(viewport, state);
        assert.deepEqual(await getPngSize(join(dir, name)), { width: viewport.width, height: viewport.height }, name);
      }
    }
  });

  test("each close-up is captured at device scale 2: its PNG is twice its element's box", async (t) => {
    const dir = await getShotsDir(t);
    t.diagnostic(`close-ups: ${dir}`);
    const shots = [];
    for (const state of CLOSE_UP_STATES) {
      const box = await captureCloseUp(harness, dir, state);
      const name = getShotName(VIEWPORTS[0], state);
      shots.push({ name, png: await getPngSize(join(dir, name)), twice: { width: box.width * 2, height: box.height * 2 } });
    }

    assert.deepEqual(shots.map((shot) => ({ name: shot.name, png: shot.png })), shots.map((shot) => ({ name: shot.name, png: shot.twice })));
  });
});
