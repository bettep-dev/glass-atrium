// Shared harness of the Queue page e2e files (screens/queue.jsx): a stripped Fastify serving test/lib/queue-render-fixtures.ts
// to a real chromium, the named states the mockup captures, and the page fact readers.
// One harness per test file → the runner spreads the files' browser work over its parallel lanes.

import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Locator, Page, Route } from "playwright";
import { chromium } from "playwright";

import { RELAY_REDACTION_MARKER } from "../../src/server/queue/owner-items.js";
import type { OwnerItemView } from "../../src/server/queue/owner-views.js";
import { messageBodySchema, ownerOrdersQuerySchema, ownerSessionsQuerySchema, type OwnerOrdersQuery } from "../../src/server/queue/schemas.js";
import {
  buildSentCopies, DONE_IDS, EDGE_FIXTURE_IMAGES, EDGE_IDS, EDGE_LONG_SESSION_NAME, FIXTURE_CLI_PATH, FIXTURE_IMAGES, FIXTURE_NOW,
  FIXTURE_ORDER_TEXT, getAnswerNotReceivedFixture, getArrivalFixture, getDoneFixture, getDoneOnlyFixture, getEdgeFixture, getManyDoneFixture, getEmptyFixture, getNameColumnFixture, getOffViewFixture,
  getNoneListeningFixture, getNotListeningEdgeFixture, getNotListeningFixture, getNotReceivedFixture, getOneListFixture, getOneReceivedFixture, getProseFixture, getHiddenSessionsFixture, getRailFixture, getRelayRecordFixture, getRelayRowFixture, getRestFixture, getStoppedFixture, getUnreachableFixture,
  FORWARDED_RELAY, NOT_LISTENING_IDS, RELAY_ROW_IDS, type QueueFixture,
} from "./queue-render-fixtures.js";
import { deleteTempDirectory } from "./remove-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS_PREFIX = "queue-shots-";
const PUBLIC_ROOT = resolve(HERE, "..", "..", "public");
const QUEUE_API_PREFIX = "/api/queue/";
const REMOTE_API_PREFIX = "/api/remote/";
const SHELL_PAYLOADS_PATH = resolve(HERE, "..", "fixtures", "app-shell-data-payloads.json");
export const READY_TIMEOUT_MS = 30_000;

/** The owner's desktop sizes the captures are compared at (spec 44063 §18.4). */
export const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1728, height: 1117 },
  { width: 1920, height: 1080 },
] as const;
/** @property isMobile - a phone with touch: the Queue route lays out at the device width under 640, every other width and route at 1280, scaled */
export interface Viewport {
  width: number;
  height: number;
  isMobile?: boolean;
}

// §18.4's sizes beyond the desktop widths: the owner's window, the minimum and the wide display
export const OWNER_WINDOW: Viewport = { width: 1568, height: 759 };
export const MIN_WINDOW: Viewport = { width: 1280, height: 800 };
const WIDE_WINDOW: Viewport = { width: 2560, height: 1440 };

/**
 * One named page state: `nn` and `name` follow the mockup's capture names (`<width>x<height>-<nn>-<name>.png`, spec §18.4).
 * `setUp` drives the page to the state and waits on what the state shows → a step the page no longer takes fails the capture.
 * @property viewports - the sizes §18.4 marks for the state; unset → the desktop widths
 * @property isClockDriven - the page's timers run on the test's clock, for the 15 s re-read
 * @property isFirstLoad - captured before the first item read answers, without the setUp
 */
export interface QueueState {
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
export const ORDER_TO = ["harbor", "meadow"];

const DESK_STATES: QueueState[] = [
  { nn: "01", name: "rest", viewports: [...VIEWPORTS, OWNER_WINDOW, MIN_WINDOW] },
  { nn: "02", name: "decision-picked", setUp: (page) => pickWithNote(page) },
  // §18.5 reads the panes with a report open at 1280 too → the minimum beside §18.4's sizes
  { nn: "03", name: "report", viewports: [...VIEWPORTS, OWNER_WINDOW, MIN_WINDOW], setUp: (page) => selectRow(page, 101) },
  {
    nn: "04", name: "rail-ticked",
    setUp: async (page) => {
      await tickSessions(page, ORDER_TO);
      await page.getByLabel("Select meadow").scrollIntoViewIfNeeded();
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
      await tickOrdersTo(page, ["harbor"]);
      await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
      await tickSessions(page, ["meadow"]);
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
      await page.locator('[role="status"]', { hasText: "Order sent to meadow" }).first().waitFor({ state: "attached" });
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
  { nn: "21c", name: "empty-thread", getFixture: getEmptyFixture, setUp: (page) => tickOrdersTo(page, ["quartz"]) },
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
  { nn: "25g", name: "focus-rail-box", setUp: (page) => focusByKeyboard(page, page.getByLabel("Select harbor")) },
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
  { nn: "29", name: "rail-ticked", closeUp: ".queue-sessions", setUp: (page) => tickSessions(page, ["harbor"]) },
  // §18.4 29's live and ended rows on one rail: a ticked live row and the ended rows under the open Ended band
  {
    nn: "29", name: "rail-ended-open", closeUp: ".queue-sessions",
    setUp: async (page) => {
      await tickSessions(page, ["harbor"]);
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

export const CLOSE_UP_STATES: CloseUpState[] = [...BUTTON_STATES, ...PARTS, ...NOT_LISTENING_PARTS];

// spec §18.4 35 (Next turn stream only) at 1280, 1440 and 1920: each Next turn surface in one frame with its Not yet
// twin — the rail's two rows, the list's roll-ups, the mixed order's recipients, the composer with a listening and a not-listening tick, the two
// answered sheets — then a list row with both badges, the five-or-more roll-up, the composer's other ticks, no session listening, the approval note
const TWIN_VIEWPORTS = [MIN_WINDOW, VIEWPORTS[0], VIEWPORTS[2]] as const;
const TWIN_STATES: QueueState[] = [
  { nn: "35a", name: "not-listening-desk", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => showNotListeningDesk(page) },
  { nn: "35b", name: "not-listening-composer", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => tickOrdersTo(page, ["harbor", "nightly"]) },
  { nn: "35c", name: "not-listening-sheet", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => selectRow(page, NOT_LISTENING_IDS.answeredDecision) },
  { nn: "35d", name: "listening-sheet", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => selectRow(page, 108) },
  { nn: "35e", name: "two-badge-row", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningEdgeFixture, setUp: (page) => page.locator(`#queue-row-${NOT_LISTENING_IDS.twoBadgeOrder}`).scrollIntoViewIfNeeded() },
  { nn: "35f", name: "roll-up-not-listening", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningEdgeFixture, setUp: (page) => page.locator(`#queue-order-${NOT_LISTENING_IDS.rollUpOrder}`).scrollIntoViewIfNeeded() },
  { nn: "35g", name: "composer-one-not-listening", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => tickOrdersTo(page, ["nightly"]) },
  { nn: "35h", name: "composer-not-listening-first", viewports: TWIN_VIEWPORTS, getFixture: getNotListeningFixture, setUp: (page) => tickOrdersTo(page, ["lumen", "nightly"]) },
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
export const ANSWER_STATES: QueueState[] = [
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

export const QUEUE_STATES: QueueState[] = [...DESK_STATES, ...ORDER_STATES, ...REFUSAL_STATES, ...LOOK_STATES, ...TWIN_STATES, ...RELAY_STATES, ...RAIL_STATES, ...DONE_STATES, ...RELAY_ROW_STATES, ...ANSWER_STATES, ...TEXT_STATES, ...COLUMN_STATES];

// Markup written by a session: rendered as text, it shows these literals; parsed as HTML, it adds probe elements.
export const MARKUP_TITLE = "보고 <b data-markup-probe>굵게</b> 끝";
export const MARKUP_BODY = "- 본문 <img data-markup-probe src=\"/markup-probe.png\" onerror=\"window.__markupRan = true\">";

/** A write route a state makes refuse: its status and the server's refusal body. */
/** @property ids - the items it answers for; unset → every one */
interface Refusal {
  status: number;
  body: { error: string; reason?: string };
  ids?: number[];
}
type WriteRoute = "send" | "action" | "upload" | "redact";

export interface Harness {
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

export async function openHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const harness: Harness = {
    app, url: "", browser: await chromium.launch({ headless: true }), fixture: getRestFixture(), missedReads: [], refusals: new Map(), heldRead: null, heldDesk: null, heldAct: null, isListDown: false, moreCursor: null, uploads: 0, scanReadIds: [], responseByUrl: new Map(),
  };
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  registerFixtureRoutes(app, harness);
  await registerRemoteRoutes(app);
  app.all("/api/*", async (request, reply) => {
    if (!request.url.startsWith(QUEUE_API_PREFIX)) return { rows: [] };
    harness.missedReads.push(`${request.method} ${request.url}`);
    return reply.code(404).send({ error: "no_fixture_route" });
  });
  await app.ready();
  harness.url = await app.listen({ host: "127.0.0.1", port: 0 });
  return harness;
}

export async function closeHarness(harness: Harness | undefined): Promise<void> {
  await harness?.browser?.close();
  await harness?.app?.close();
}

// the Mac server's setup and devices replies, shared with app-shell.csp.e2e → the Remote access screen throws on `{ rows: [] }` and unmounts the shell
async function registerRemoteRoutes(app: FastifyInstance): Promise<void> {
  const payloads: Record<string, unknown> = JSON.parse(await readFile(SHELL_PAYLOADS_PATH, "utf8"));
  for (const [path, payload] of Object.entries(payloads)) {
    if (path.startsWith(REMOTE_API_PREFIX)) app.get(path, async () => payload);
  }
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
export async function openQueuePage(harness: Harness, viewport: Viewport, readyText: string, isClockDriven = false, scale = 1): Promise<Page> {
  const page = await openShellPage(harness, viewport, "queue", isClockDriven, scale);
  await page.getByText(readyText).first().waitFor({ timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

/**
 * A fresh page on the pinned clock, loaded at `#<hash>` (any route of the shell); a phone viewport gets touch too.
 * @param hash - the route and its query, without the leading `#`
 */
export async function openShellPage(harness: Harness, viewport: Viewport, hash: string, isClockDriven = false, scale = 1): Promise<Page> {
  const { isMobile = false, ...size } = viewport;
  const page = await createPage(harness, { viewport: size, deviceScaleFactor: scale, isMobile, hasTouch: isMobile });
  // tsx keeps function names through an injected __name helper → the evaluated fact readers need it on the page
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await (isClockDriven ? page.clock.install({ time: FIXTURE_NOW }) : page.clock.setFixedTime(FIXTURE_NOW));
  await page.goto(`${harness.url}/#${hash}`, { waitUntil: "load" });
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

export const PARTLY_REDACTED_LINE = "✕ 1 of 2 copies was not redacted. Redact text again.";

// Redact text in the foot of the hop-1 relay's sheet (two copies, both ended → a Done row) → its confirmation over the sheet
export async function askRedaction(page: Page): Promise<void> {
  await selectRow(page, FORWARDED_RELAY[0]!.id);
  await page.locator(".queue-sheet .card-foot .queue-note").getByRole("button", { name: "Redact text" }).click();
  await page.getByRole("dialog", { name: "Redact this relay's text?" }).waitFor();
}

export function confirmRedaction(page: Page): Promise<void> {
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
export function refuseOneRedaction(harness: Harness): void {
  harness.refusals.set("redact", { status: 503, body: { error: "database_unavailable" }, ids: [FORWARDED_RELAY[1]!.id] });
}

export function selectRow(page: Page, id: number): Promise<void> {
  return page.locator(`#queue-row-${id}`).click();
}

// a prose fixture item's sheet, once it shows the item's title, scrolled until the end of `selector` is in view
export async function showSheetEnd(page: Page, id: number, selector: string): Promise<void> {
  await selectProseRow(page, id);
  await page.locator(selector).last().evaluate((node) => node.scrollIntoView({ block: "end" }));
}

export async function selectProseRow(page: Page, id: number): Promise<void> {
  const title = getProseFixture().items.find((item) => item.id === id)?.title ?? "";
  await selectRow(page, id);
  await page.locator(".queue-sheet-title", { hasText: title }).waitFor();
}

export const ORDER_BOX_ID = "queue-order-text";

export async function pickWithNote(page: Page): Promise<void> {
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
export async function waitForDoneBands(page: Page): Promise<void> {
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
export async function showMoreDone(page: Page): Promise<void> {
  await waitForDoneBands(page);
  const loaded = await page.locator(".queue-row--done").count();
  await page.getByRole("button", { name: "Show more" }).click();
  await page.waitForFunction((count) => document.querySelectorAll(".queue-row--done").length > count, loaded);
  await page.locator(".queue-row--done").last().scrollIntoViewIfNeeded();
}

// relay copy `id` sent under a name its sender gave itself
export function getSelfNamedFixture(fixture: QueueFixture, id: number, selfDeclaredName: string): QueueFixture {
  return { ...fixture, items: fixture.items.map((item) => (item.id === id && item.relay !== null ? { ...item, relay: { ...item.relay, sender: { ...item.relay.sender, selfDeclaredName } } } : item)) };
}

// every decision and report from the named session under the name its start directory gives, as for a session that registered none
export function getStartDirectoryFixture(fixture: QueueFixture, name: string): QueueFixture {
  return { ...fixture, items: fixture.items.map((item) => (item.kind !== "relay" && item.session.name === name ? { ...item, session: { ...item.session, isNameRegistered: false } } : item)) };
}

export async function tickSessions(page: Page, names: string[]): Promise<void> {
  for (const name of names) await page.getByLabel(`Select ${name}`).check();
}

// Orders is on screen at rest → ticking is all it takes to address it and scope its thread
export async function tickOrdersTo(page: Page, names: string[]): Promise<void> {
  await tickSessions(page, names);
  await page.locator(".queue-thread").waitFor();
  await waitForImages(page);
}

// harbor and the edge fixture's ended portfolio, ticked once the Ended band is open
async function tickEndedOrdersTo(page: Page): Promise<void> {
  await openEndedBand(page);
  await tickOrdersTo(page, ["harbor", "portfolio"]);
}

// the Ended band opened → its rows on the rail
export async function openEndedBand(page: Page): Promise<void> {
  await page.locator(".queue-rail-band .disclosure").click();
  await page.locator('.queue-rail-band .disclosure[aria-expanded="true"]').waitFor();
}

// a capture taken before the bubbles' images decode shows empty squares
export async function waitForImages(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll("img")].every((img) => img.complete));
}

export function getImageFile(index: number): { name: string; mimeType: string; buffer: Buffer } {
  const image = [...FIXTURE_IMAGES.values()][index % FIXTURE_IMAGES.size]!;
  return { name: `queue-0${(index % FIXTURE_IMAGES.size) + 1}.${image.view.type}`, mimeType: image.mime, buffer: image.bytes };
}

export async function setFiles(page: Page, fieldId: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  await page.locator(`#${fieldId}-files`).setInputFiles(files);
}

export async function addOrderFiles(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  await tickOrdersTo(page, ["harbor"]);
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

// the 15 s re-read finds a report meadow posted since the first read
export async function arriveItem(page: Page, harness: Harness, rest = getRestFixture()): Promise<void> {
  harness.fixture = getArrivalFixture(rest);
  await page.clock.fastForward(15_000);
  await page.locator(".nav-item", { hasText: "Queue" }).locator(".nav-count").filter({ hasText: "8" }).waitFor({ timeout: READY_TIMEOUT_MS });
}

// the edge state's long list, scrolled to its top → the report arriving at the end of its band lands past the visible part
export async function arriveOffView(page: Page, harness: Harness): Promise<void> {
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

export async function showAnswerImages(page: Page, id: number): Promise<void> {
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
  await tickOrdersTo(page, ["harbor"]);
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
export async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press("Tab");
  await target.focus();
}

/**
 * Desk column widths per viewport (spec 44063 §3.2): main = viewport − 268, two gaps of 16; the rail per step;
 * the middle pane the page — 66ch of the desk's text + two 32 gutters, measured in the page — or, below a 1505 window,
 * what Orders' minimum leaves: 272 under the 1440 step, which gives the 1280 rail and list row 16 and 32 more, else 320; Orders the rest.
 */
export const DESK_WIDTHS = [
  { viewport: { width: 1280, height: 800 }, rail: 224, middle: 484 },
  { viewport: VIEWPORTS[0], rail: 232, middle: 588 },
  { viewport: { width: 1568, height: 759 }, rail: 232, middle: "page" },
  { viewport: VIEWPORTS[1], rail: 248, middle: "page" },
  { viewport: VIEWPORTS[2], rail: 248, middle: "page" },
  { viewport: { width: 2240, height: 1260 }, rail: 264, middle: "page" },
  { viewport: { width: 2560, height: 1440 }, rail: 280, middle: "page" },
] as const;
export const SHELL_INLINE = 268;
export const ORDERS = { MIN: { BELOW_1440: 272, FROM_1440: 320 }, COLUMN_MAX: 720 };

interface DeskFacts {
  isScrolled: boolean;
  rail: number[] | null;
  list: number[] | null;
  sheet: number[] | null;
  orders: number[] | null;
  page: number;
}

// each pane's painted box as [x, width]; a pane not rendered → null. `page`: 66ch of the desk's own text + two 32 gutters
export async function getDeskFacts(page: Page): Promise<DeskFacts> {
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
export async function getListFacts(page: Page): Promise<ListFacts> {
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
export async function getSheetFacts(page: Page): Promise<SheetFacts> {
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

export function getHeadHeights(page: Page, cards: string[]): Promise<number[]> {
  return page.evaluate((selectors) => selectors.map((selector) => Math.round(document.querySelector(`${selector} > .card-head`)?.getBoundingClientRect().height ?? -1)), cards);
}

// the right end of the header's control cluster, the header's last painted box
export function getHeadEnd(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(document.querySelector(".page-head-cluster")?.getBoundingClientRect().right ?? -1));
}

interface ComposerFacts {
  box: number;
  buttons: number[];
  type: { text: string; button: string };
}

export async function getComposerFacts(page: Page, root: string): Promise<ComposerFacts> {
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
export function getButtonFacts(): ButtonFacts {
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
export async function getSettledLook(button: Locator): Promise<{ fill: string; edge: string; label: string }> {
  return button.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, edge: style.borderTopColor, label: style.color };
  });
}

// spec §12.5 rest looks: the edge by rank, a quiet label dim, a disabled one on the line edge with a faint label at full strength
export function getRankLook(tokens: ButtonFacts["tokens"], button: ButtonFacts["buttons"][number]): ButtonLook {
  const edge = { primary: tokens.ink, secondary: tokens.controlEdge, quiet: tokens.controlEdge, disabled: tokens.line }[button.rank];
  const label = { quiet: tokens.dim, disabled: tokens.faint }[button.rank as "quiet" | "disabled"] ?? button.look.label;
  return { edgeWidth: "1px", edge, label, opacity: "1" };
}

interface IconLook { name: string; title: string; size: number[]; text: string; isEdgeless: boolean; fill: string; glyph: string; isDrawn: boolean; isDisabled: boolean }

// every painted glyph-only button of the Queue screen, its image viewer's bar included; colour transitions settled first → the state's own colours
export async function getIconLooks(): Promise<IconLook[]> {
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
export function getTokenPaint({ property, value }: { property: "background-color" | "color"; value: string }): string {
  const probe = document.createElement("div");
  probe.style.setProperty(property, value);
  document.body.append(probe);
  const paint = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return paint;
}

// the two fills under the pointer, in token order: `--tint-select` hovered, `--tint-fill` held
export async function getTintFills(page: Page): Promise<string[]> {
  return Promise.all(["--tint-select", "--tint-fill"].map((token) => page.evaluate(getTokenPaint, { property: "background-color" as const, value: `var(${token})` })));
}

// the keyboard ring as painted: whether :focus-visible holds, the outline's colour, style and width, its offset
export async function getFocusRing(target: Locator): Promise<{ isVisible: boolean; outline: string; offset: string }> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { isVisible: element.matches(":focus-visible"), outline: `${style.outlineColor} ${style.outlineStyle} ${style.outlineWidth}`, offset: style.outlineOffset };
  });
}

// the `--focus-ring` triplet in computed-colour form (`r, g, b`)
export async function getRingToken(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim().split(/\s+/).join(", "));
}

export async function openEdgePage(harness: Harness, viewport: { width: number; height: number } = VIEWPORTS[0]): Promise<Page> {
  harness.fixture = getEdgeFixture();
  return openQueuePage(harness, viewport, getRestReadyText(harness.fixture));
}

// no tick → every order in the thread, its images decoded
// an entry of the thread brought into view by a text it shows
export async function showThreadText(page: Page, text: string): Promise<void> {
  const shown = page.locator(".queue-thread").getByText(text);
  await shown.waitFor();
  await shown.scrollIntoViewIfNeeded();
}

export async function waitForAllOrders(page: Page): Promise<void> {
  await page.locator(".queue-order").first().waitFor();
  await waitForImages(page);
}

/**
 * Every state at each of its sizes, each on a fresh page, as `<dir>/<width>x<height>-<nn>-<name>.png`.
 * @returns one line per capture whose setUp failed, so one broken state does not hide the others
 */
export async function captureQueueStates(harness: Harness, dir: string): Promise<string[]> {
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
export async function readQueueState<T>(harness: Harness, viewport: Viewport, state: QueueState, read: (page: Page) => Promise<T>): Promise<T> {
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
export async function getLongSentences(page: Page, fixture: QueueFixture): Promise<string[]> {
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
export async function captureCloseUp(harness: Harness, dir: string, state: CloseUpState): Promise<{ width: number; height: number }> {
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

export function getStateViewports(state: QueueState): readonly Viewport[] {
  return state.viewports ?? VIEWPORTS;
}

export function getShotName(viewport: Viewport, state: QueueState): string {
  return `${viewport.width}x${viewport.height}-${state.nn}-${state.name}.png`;
}

export async function getShotsDir(t: TestContext): Promise<string> {
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
export function getRailColumnFacts() {
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
export async function getPngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// the first item's title, or the empty list's line → the list read has answered
export function getRestReadyText(fixture = getRestFixture()): string {
  return fixture.items[0]?.title ?? fixture.done?.[0]?.title ?? "Nothing is waiting for you";
}
