// E2E chromium harness for the Queue page (screens/queue.jsx): the page's real bundle on mockup v5's fixture data,
// the frame-independent facts every page stream keeps, and the named-state captures the owner compares to the mockup.
//
// Runner: npx tsx --test test/queue.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Captures: QUEUE_SHOTS_DIR (absolute) names the folder; unset → a fresh mktemp folder, its path printed as a diagnostic.
// App: stripped Fastify serving test/lib/queue-render-fixtures.ts; a queue read with no fixture route answers 404 and is recorded.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Locator, Page } from "playwright";
import { chromium } from "playwright";

import type { OwnerItemView } from "../src/server/queue/owner-views.js";
import { messageBodySchema, ownerOrdersQuerySchema, type OwnerOrdersQuery } from "../src/server/queue/schemas.js";
import {
  buildSentCopies, EDGE_FIXTURE_IMAGES, EDGE_IDS, EDGE_LONG_SESSION_NAME, EDGE_LONG_TITLE, EDGE_SESSION_IDS, FIXTURE_CLI_PATH, FIXTURE_IMAGES, FIXTURE_NOW,
  FIXTURE_ORDER_TEXT, FIXTURE_SESSION_IDS, getAnswerNotReceivedFixture, getArrivalFixture, getEdgeFixture, getEmptyFixture, getNotReceivedFixture,
  getOneReceivedFixture, getOrderFirstFixture, getRestFixture, getStoppedFixture, getUnreachableFixture, type QueueFixture,
} from "./lib/queue-render-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const QUEUE_API_PREFIX = "/api/queue/";
const READY_TIMEOUT_MS = 30_000;

/** The owner's desktop sizes the captures are compared at (spec 44063 §18.4). */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1728, height: 1117 },
  { width: 1920, height: 1080 },
] as const;
interface Viewport {
  width: number;
  height: number;
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
  { nn: "21b", name: "empty-queue", getFixture: getEmptyFixture },
  { nn: "24", name: "first-load", isFirstLoad: true },
  { nn: "26", name: "not-reachable", getFixture: getUnreachableFixture },
  // the edge fixture holds §14.4's stress content: the 200-character title, nine options, the long session name, 99+, eight images
  { nn: "27a", name: "stress-desk", getFixture: getEdgeFixture, setUp: (page) => waitForAllOrders(page) },
  { nn: "27b", name: "stress-long-title", getFixture: getEdgeFixture, setUp: (page) => selectRow(page, EDGE_IDS.longTitle) },
  { nn: "27c", name: "stress-nine-options", getFixture: getEdgeFixture, setUp: (page) => selectRow(page, EDGE_IDS.nineOptions) },
  { nn: "27d", name: "stress-seven-sessions", getFixture: getEdgeFixture, setUp: (page) => showThreadText(page, "7 sessions · 5 received · 1 not yet") },
  { nn: "27e", name: "stress-long-order", getFixture: getEdgeFixture, setUp: (page) => showThreadText(page, "Show all 31 lines") },
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
  { nn: "23", name: "light-01", setUp: (page) => setLightTheme(page) },
  {
    nn: "23", name: "light-05",
    setUp: async (page) => {
      await tickOrdersTo(page, ORDER_TO);
      await selectRow(page, 103);
      await setLightTheme(page);
    },
  },
  {
    nn: "23", name: "light-07",
    setUp: async (page) => {
      await sendOrderWithImages(page);
      await setLightTheme(page);
    },
  },
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
    { rank: "quiet", closeUp: SHEET_FOOT, target: `${SHEET_FOOT} .btn.ghost` },
    { rank: "primary", closeUp: SHEET_FOOT, target: `${SHEET_FOOT} .btn.primary` },
  ].flatMap(getRankCloseUps),
  {
    nn: "29", name: "buttons-rest-head-light", closeUp: SHEET_HEAD,
    setUp: async (page) => {
      await selectRow(page, 103);
      await setLightTheme(page);
    },
  },
  {
    nn: "29", name: "buttons-rest-foot-light", closeUp: SHEET_FOOT,
    setUp: async (page) => {
      await selectRow(page, 103);
      await setLightTheme(page);
    },
  },
];

// spec §18.4 29: one rank's button hovered, held and focused (by keyboard → its ring paints) on the open decision 103
function getRankCloseUps({ rank, closeUp, target }: { rank: string; closeUp: string; target: string }): CloseUpState[] {
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
      await act(page);
    },
  }));
}

// spec §18.4 29's other close-ups, each in both themes
const PARTS: CloseUpState[] = [
  { nn: "29", name: "rail-ticked", closeUp: ".queue-sessions", setUp: (page) => tickSessions(page, ["gersona"]) },
  // §18.4 29's live and ended rows on one rail: a ticked live row and the ended rows under the open Ended band
  {
    nn: "29", name: "rail-ended-open", closeUp: ".queue-sessions",
    setUp: async (page) => {
      await tickSessions(page, ["gersona"]);
      await page.locator(".queue-rail-band .disclosure").click();
      await page.locator('.queue-rail-band .disclosure[aria-expanded="true"]').waitFor();
    },
  },
  { nn: "29", name: "list-band-rows", closeUp: ".queue-list > .card-body" },
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

const CLOSE_UP_STATES: CloseUpState[] = [...BUTTON_STATES, ...PARTS.flatMap((state) => [state, getLightCloseUp(state)])];

function getLightCloseUp(state: CloseUpState): CloseUpState {
  return {
    ...state,
    name: `${state.name}-light`,
    setUp: async (page, harness) => {
      await state.setUp?.(page, harness);
      await setLightTheme(page);
    },
  };
}

const QUEUE_STATES: QueueState[] = [...DESK_STATES, ...ORDER_STATES, ...REFUSAL_STATES, ...LOOK_STATES];

// Markup written by a session: rendered as text, it shows these literals; parsed as HTML, it adds probe elements.
const MARKUP_TITLE = "보고 <b data-markup-probe>굵게</b> 끝";
const MARKUP_BODY = "- 본문 <img data-markup-probe src=\"/markup-probe.png\" onerror=\"window.__markupRan = true\">";

/** A write route a state makes refuse: its status and the server's refusal body. */
interface Refusal {
  status: number;
  body: { error: string; reason?: string };
}
type WriteRoute = "send" | "action" | "upload";

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
}

async function openHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const harness: Harness = {
    app, url: "", browser: await chromium.launch({ headless: true }), fixture: getRestFixture(), missedReads: [], refusals: new Map(), heldRead: null, heldDesk: null, heldAct: null, isListDown: false, moreCursor: null, uploads: 0,
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
  app.get<{ Params: { id: string } }>("/api/queue/owner/items/:id", async (request, reply) => {
    const item = harness.fixture.items.find((candidate) => String(candidate.id) === request.params.id);
    return item ?? reply.code(404).send({ error: "unknown_item" });
  });
  app.get("/api/queue/owner/sessions", async () => {
    await harness.heldDesk;
    return { sessions: harness.fixture.sessions, hasMore: false };
  });
  app.get("/api/queue/owner/resumes", async () => ({ resumes: harness.fixture.resumes }));
  app.get("/api/queue/owner/orders", async (request) => {
    await harness.heldDesk;
    return getOrderPage(harness.fixture.orders, ownerOrdersQuerySchema.parse(request.query));
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
function getOrderPage(copies: OwnerItemView[], query: OwnerOrdersQuery): { items: OwnerItemView[]; nextCursor: string | null } {
  const { sessionIds, before, limit } = query;
  const orders = getFixtureOrders(copies)
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
async function openQueuePage(harness: Harness, viewport: { width: number; height: number }, readyText: string, isClockDriven = false, scale = 1): Promise<Page> {
  const page = await harness.browser.newPage({ viewport, deviceScaleFactor: scale });
  // tsx keeps function names through an injected __name helper → the evaluated fact readers need it on the page
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await (isClockDriven ? page.clock.install({ time: FIXTURE_NOW }) : page.clock.setFixedTime(FIXTURE_NOW));
  await page.goto(`${harness.url}/#queue`, { waitUntil: "load" });
  await page.getByText(readyText).first().waitFor({ timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

function selectRow(page: Page, id: number): Promise<void> {
  return page.locator(`#queue-row-${id}`).click();
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

async function tickSessions(page: Page, names: string[]): Promise<void> {
  for (const name of names) await page.getByLabel(`Select ${name}`).check();
}

// Orders is on screen at rest → ticking is all it takes to address it and scope its thread
async function tickOrdersTo(page: Page, names: string[]): Promise<void> {
  await tickSessions(page, names);
  await page.locator(".queue-thread").waitFor();
  await waitForImages(page);
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
async function arriveItem(page: Page, harness: Harness): Promise<void> {
  harness.fixture = getArrivalFixture();
  await page.clock.fastForward(15_000);
  await page.locator(".nav-item", { hasText: "Queue" }).locator(".nav-count").filter({ hasText: "8" }).waitFor({ timeout: READY_TIMEOUT_MS });
}

// the edge state's long list, scrolled to its top → the report arriving at the end of its band lands past the visible part
async function arriveOffView(page: Page, harness: Harness): Promise<void> {
  harness.fixture = getArrivalFixture(getEdgeFixture());
  await page.clock.fastForward(15_000);
  await page.locator(".queue-status-new", { hasText: "1 new below" }).waitFor({ timeout: READY_TIMEOUT_MS });
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

async function setLightTheme(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

// a key press first → the browser treats the focus as keyboard focus and paints its ring
async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press("Tab");
  await target.focus();
}

/**
 * Desk column widths per viewport (spec 44063 §3.2): main = viewport − 268, two gaps of 16; the rail per step;
 * the middle pane the page — 66ch of the desk's text + two 32 gutters, measured in the page — or, below a 1505 window,
 * what Orders' 320 leaves; Orders the rest.
 */
const DESK_WIDTHS = [
  { viewport: { width: 1280, height: 800 }, rail: 208, middle: 452 },
  { viewport: VIEWPORTS[0], rail: 232, middle: 588 },
  { viewport: { width: 1568, height: 759 }, rail: 232, middle: "page" },
  { viewport: VIEWPORTS[1], rail: 248, middle: "page" },
  { viewport: VIEWPORTS[2], rail: 248, middle: "page" },
  { viewport: { width: 2240, height: 1260 }, rail: 264, middle: "page" },
  { viewport: { width: 2560, height: 1440 }, rail: 280, middle: "page" },
] as const;
const SHELL_INLINE = 268;
const ORDERS_MIN = 320;
const ORDERS_COLUMN_MAX = 720;

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
    const first = rect(".queue-sheet-head > .btn");
    const last = rect(".queue-steps > .btn:last-child");
    return {
      text: [style(".queue-sheet .prose-text").fontSize, style(".queue-sheet .prose-text").lineHeight, String(text.getBoundingClientRect().width <= 590)],
      title: [style(".queue-sheet-title").fontSize, style(".queue-sheet-title").lineHeight],
      isFootInView: foot !== undefined && foot.bottom <= window.innerHeight && foot.height > 0,
      starts: [...new Set([".queue-sheet-head > .btn", ".queue-date-line", ".queue-sheet-title", ".queue-sheet .prose-text", ".queue-sheet .queue-compose-box", ".queue-sheet .queue-note"].map((selector) => Math.round(rect(selector).left)))],
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

// every painted glyph-only button of the Queue screen, its image viewer's bar included
function getIconLooks(): IconLook[] {
  return [...document.querySelectorAll(".queue-screen .btn.icon")]
    .filter((element) => element.getClientRects().length > 0)
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

// the colour var(--tint-select) computes to on this page → compared with a held icon button's fill
function getTintSelect(): string {
  const probe = document.createElement("div");
  probe.style.background = "var(--tint-select)";
  document.body.append(probe);
  const fill = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return fill;
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
  harness.fixture = state.getFixture?.() ?? getRestFixture();
  harness.refusals.clear();
  if (state.isFirstLoad === true) return captureFirstLoad(harness, dir, viewport, state);
  const page = await openQueuePage(harness, viewport, getRestReadyText(harness.fixture), state.isClockDriven);
  try {
    await state.setUp?.(page, harness);
    // an entry transition still running → a half-faded surface; disabled → each capture shows the state's end frame
    await page.screenshot({ path: join(dir, getShotName(viewport, state)), animations: "disabled" });
  } finally {
    harness.isListDown = false;
    await page.close();
  }
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
async function captureFirstLoad(harness: Harness, dir: string, viewport: Viewport, state: QueueState): Promise<void> {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  harness.heldRead = held;
  harness.heldDesk = held;
  const page = await harness.browser.newPage({ viewport });
  try {
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.goto(`${harness.url}/#queue`, { waitUntil: "load" });
    await page.locator(".queue-screen").waitFor({ timeout: READY_TIMEOUT_MS });
    for (const text of ["Loading sessions…", "Loading the queue…", "Loading orders…"]) await page.getByText(text).waitFor({ timeout: READY_TIMEOUT_MS });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({ path: join(dir, getShotName(viewport, state)) });
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

async function getShotsDir(): Promise<string> {
  const named = process.env.QUEUE_SHOTS_DIR;
  if (named === undefined || named === "") return mkdtemp(join(tmpdir(), "queue-shots-"));
  if (!isAbsolute(named)) throw new Error(`QUEUE_SHOTS_DIR must be an absolute path, got "${named}"`);
  await mkdir(named, { recursive: true });
  return named;
}

// PNG IHDR: width and height as big-endian words at bytes 16 and 20
async function getPngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// the first item's title, or the empty list's line → the list read has answered
function getRestReadyText(fixture = getRestFixture()): string {
  return fixture.items[0]?.title ?? "Nothing is waiting for you";
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
      assert.ok(orders >= ORDERS_MIN, `${size}: Orders ${orders} keeps its minimum`);
      assert.deepEqual([rest.isScrolled, rest.rail?.[1], rest.list?.[1], rest.sheet, rest.orders?.[1]], [false, row.rail, middle, null, orders], `${size} at rest`);
      assert.deepEqual(opened, { ...rest, list: null, sheet: rest.list }, `${size} with a row opened`);
    }
  });

  test("the sheet's text is 15/24 within 66ch, its title 20/28, rows 68 or 88, bands 32 on the page ground, and its foot in view", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const list = await getListFacts(page);
    await selectRow(page, 101);
    const sheet = await getSheetFacts(page);
    await page.close();
    // a two-line title needs a narrower list than this desk's; the 88 row is the 200-character title's test
    assert.deepEqual({ isRowHeight: list.rowHeights.length > 0 && list.rowHeights.every((height) => height === 68 || height === 88), bands: list.bands }, { isRowHeight: true, bands: ["32 true"] }, String(list.rowHeights));
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
    await selectRow(page, 108);
    const first = await head();
    await page.keyboard.press("j");
    const second = await head();
    await page.keyboard.press("k");
    const back = await head();
    await page.close();

    assert.equal(firstRow, "queue-row-109", "the list's first row is an order");
    assert.deepEqual(first, { hash: "#queue?item=108", position: "1 of 2", disabled: [true, false], tag: "Answer" });
    assert.deepEqual(second, { hash: "#queue?item=160", position: "2 of 2", disabled: [false, true], tag: "Answer" });
    assert.equal(back.hash, "#queue?item=108");
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
  test("list rows are 68 or 88 high at every desk width, 2560 included", async () => {
    harness.fixture = getRestFixture();
    const heights = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const { rowHeights } = await getListFacts(page);
      await page.close();
      heights.push({ width: viewport.width, isRowHeight: rowHeights.length > 0 && rowHeights.every((height) => height === 68 || height === 88), rowHeights });
    }

    assert.deepEqual(heights.filter((row) => !row.isRowHeight), []);
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

  test("rail rows are 68; Orders is rendered at rest beside the list, and an opened row hides the list alone", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-order").first().waitFor();
    const shown = () => page.evaluate(() => [".queue-list", ".queue-sheet", ".queue-orders"].map((selector) => (document.querySelector(selector)?.getClientRects().length ?? 0) > 0));
    const rest = await shown();
    const railRows = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-rail-row")].map((row) => Math.round(row.getBoundingClientRect().height)))]);
    await selectRow(page, 103);
    const opened = await shown();
    await page.close();

    assert.deepEqual(railRows, [68]);
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
      columns.push({ width: viewport.width, starts: facts.starts, ends: facts.ends, column: 16 + Math.min(facts.inner - 32, 720) });
    }

    assert.ok(columns.some(({ column }) => column === 16 + ORDERS_COLUMN_MAX), "a desk width wide enough for the 720 cap");
    assert.deepEqual(columns, columns.map(({ width, column }) => ({ width, starts: [16], ends: [column], column })));
  });

  // spec §9.1: one control per row — the row is its box's label
  test("a rail row holds one interactive element, its checkbox, and no button; a press on its name ticks it and a second unticks it", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const row = page.locator(`[data-session="${FIXTURE_SESSION_IDS.atrium}"]`);
    const controls = await row.evaluate((element) => [...element.querySelectorAll("button, input, a, [tabindex]")].map((control) => `${control.tagName}:${control.getAttribute("type")}`));
    await row.locator(".queue-rail-name").click();
    const ticked = await page.getByLabel("Select atrium").isChecked();
    await row.locator(".queue-rail-line").click();
    const unticked = await page.getByLabel("Select atrium").isChecked();
    await page.close();

    assert.deepEqual({ controls, ticked, unticked }, { controls: ["INPUT:checkbox"], ticked: true, unticked: false });
  });

  // spec §9.1, §14.4: a department reads left to right — its box, whether it is live, its name, and the count that waits at the row's end
  test("in a rail row the box stands left of the state mark, the mark left of the name and the count at the row's end; the All sessions label, the Ended label and every name start at one x; a live mark is ok, any other a faint ring, and no line 2 holds a mark", async (t) => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-rail-band .disclosure").click();
    await page.locator('.queue-rail-band .disclosure[aria-expanded="true"]').waitFor();
    const facts = await page.evaluate(() => {
      const paint = (token: string) => {
        const probe = document.body.appendChild(Object.assign(document.createElement("div"), { style: `color: rgb(var(${token}))` }));
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const [ok, faint] = [paint("--ok"), paint("--faint")];
      const rows = [...document.querySelectorAll<HTMLElement>(".queue-rail-row")];
      const rect = (row: Element, selector: string) => row.querySelector(selector)?.getBoundingClientRect();
      // where each label's text is painted, not its box → a label centred inside a column-wide box is caught
      const getTextLeft = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return Math.round(range.getBoundingClientRect().left);
      };
      const starts = [".queue-rail-all", ".queue-rail-band .disclosure > span:last-child", ".queue-rail-name-text"].flatMap((selector) => [...document.querySelectorAll(selector)].map(getTextLeft));
      return {
        outOfOrder: rows.filter((row) => {
          const [box, mark, name] = [rect(row, ".queue-rail-box"), rect(row, ".queue-rail-mark"), rect(row, ".queue-rail-name-text")];
          return !(mark && name && (!box || box.right <= mark.left) && mark.right <= name.left);
        }).map((row) => row.dataset.session),
        countGaps: [...new Set(rows.flatMap((row) => {
          const count = rect(row, ".queue-rail-count");
          return count ? [Math.round(row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight) - count.right)] : [];
        }))],
        starts: new Set(starts).size,
        ringsAndDots: rows.map((row) => {
          const mark = getComputedStyle(row.querySelector(".queue-rail-mark") as Element);
          const isLive = (row.querySelector(".queue-rail-line")?.textContent ?? "").startsWith("Live");
          return isLive ? mark.backgroundColor === ok : mark.borderTopColor === faint && mark.backgroundColor === "rgba(0, 0, 0, 0)";
        }),
        lineMarks: rows.filter((row) => /[●○]/.test(row.querySelector(".queue-rail-line")?.textContent ?? "")).length,
        kinds: new Set(rows.map((row) => (row.querySelector(".queue-rail-line")?.textContent ?? "").startsWith("Live"))).size,
        heights: rows.map((row) => `${row.querySelector(".queue-rail-line")?.textContent}: ${Math.round(row.getBoundingClientRect().height)}`),
      };
    });
    await page.close();
    t.diagnostic(`rail row heights at 1440 with Ended open: ${facts.heights.join(" | ")}`);

    assert.equal(facts.kinds, 2, "live and not-live rows are both on the rail");
    assert.deepEqual(
      { outOfOrder: facts.outOfOrder, countGaps: facts.countGaps, starts: facts.starts, marks: facts.ringsAndDots.every(Boolean), lineMarks: facts.lineMarks },
      { outOfOrder: [], countGaps: [0], starts: 1, marks: true, lineMarks: 0 },
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
    harness.fixture = getEdgeFixture();
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

  test("a badge is 20 high in every fill", async () => {
    harness.fixture = getNotReceivedFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(harness.fixture));
    const fills = await page.evaluate(() => [...new Set([...document.querySelectorAll(".pill--solid, .pill--tag, .pill--warn")]
      .filter((pill) => pill.getClientRects().length > 0)
      .map((pill) => `${/pill--(solid|tag|warn)/.exec(pill.className)?.[1]} ${Math.round(pill.getBoundingClientRect().height)}`))].sort());
    await page.close();

    assert.deepEqual(fills, ["solid 20", "tag 20", "warn 20"]);
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
    const focused = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { isVisible: element.matches(":focus-visible"), outline: `${style.outlineColor} ${style.outlineStyle} ${style.outlineWidth}`, offset: style.outlineOffset };
    });
    const look = await getSettledLook(button);
    const ringToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim().split(/\s+/).join(", "));
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
      assert.deepEqual([...byName.keys()].sort(), ["Add images", "Back to the list", "Close", "Keyboard shortcuts", "Next image", "Next item", "Previous image", "Previous item", "Try again"]);
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

  test("an icon button hovered takes the sunken fill and an ink glyph, held the selection tint, and by keyboard the ring, never an edge", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 103);
    const button = page.getByRole("button", { name: "Next item" });
    const read = async () => {
      const look = await getSettledLook(button);
      const isEdgeless = await button.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth) === 0 || getComputedStyle(element).borderTopColor === "rgba(0, 0, 0, 0)");
      return { fill: look.fill, glyph: look.label, isEdgeless };
    };
    const tokens = await page.evaluate(getButtonFacts).then((facts) => facts.tokens);
    const tint = await page.evaluate(getTintSelect);
    await button.hover();
    const hovered = await read();
    await page.mouse.down();
    const held = await read();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    const back = page.getByRole("button", { name: "Back to the list" });
    await focusByKeyboard(page, back);
    const focused = await back.evaluate((element) => {
      const style = getComputedStyle(element);
      return { isVisible: element.matches(":focus-visible"), outline: `${style.outlineColor} ${style.outlineStyle} ${style.outlineWidth}`, offset: style.outlineOffset };
    });
    const ringToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim().split(/\s+/).join(", "));
    await page.close();

    assert.deepEqual({ hovered, held, focused }, {
      hovered: { fill: tokens.sunken, glyph: tokens.ink, isEdgeless: true },
      held: { fill: tint, glyph: tokens.ink, isEdgeless: true },
      focused: { isVisible: true, outline: `rgb(${ringToken}) solid 2px`, offset: "2px" },
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

  // spec §3.2 / §4.5: the button stands beside its box wherever the box keeps 220 px there, and under it below that
  test("the Orders send button stands beside its box exactly where the box keeps 220 px beside it, under it at 1440 and beside it from 1728, with nothing ticked", async () => {
    harness.fixture = getRestFixture();
    const rows: Array<{ width: number; label: string | null | undefined; isBeside: boolean; isRoom: boolean; room: number }> = [];
    for (const { viewport } of DESK_WIDTHS) {
      const page = await openQueuePage(harness, viewport, getRestReadyText());
      const facts = await page.evaluate(() => {
        const rect = (selector: string) => (document.querySelector(`.queue-orders ${selector}`) as HTMLElement).getBoundingClientRect();
        const [row, box, buttons] = [rect(".queue-compose-row"), rect(".queue-compose-box"), rect(".queue-compose-buttons")];
        const gap = parseFloat(getComputedStyle(document.querySelector(".queue-orders .queue-compose-row") as Element).columnGap);
        return { label: document.querySelector(".queue-orders .queue-compose-buttons .btn")?.textContent, isBeside: buttons.top < box.bottom, room: row.width - gap - buttons.width };
      });
      await page.close();
      rows.push({ width: viewport.width, label: facts.label, isBeside: facts.isBeside, isRoom: facts.room >= 220, room: Math.round(facts.room) });
    }
    const at = (width: number) => rows.find((row) => row.width === width)?.isBeside;

    assert.deepEqual(rows.filter((row) => row.label !== "Send order" || row.isBeside !== row.isRoom), [], JSON.stringify(rows));
    assert.deepEqual([at(1440), at(1728), at(2240), at(2560)], [false, true, true, true]);
  });

  // spec §4.5 / §12.5: Add images is a glyph inside the one bordered field → no edge of its own, at rest, hovered or held;
  // held under the pointer it takes the selection tint, never the ghost's hover fill
  test("Add images draws no edge of its own inside the order box, at rest or under the pointer, and takes the selection tint while held", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const add = page.locator(".queue-orders .queue-compose-add");
    // the button's colour transition settled first → the look the state ends on, never a mid-fade blend
    const getLook = () => add.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
      const style = getComputedStyle(element);
      const alpha = style.borderTopColor.startsWith("rgba") ? Number(style.borderTopColor.split(",").at(-1)?.replace(")", "")) : 1;
      const tint = document.createElement("div");
      tint.style.background = "var(--tint-select)";
      element.parentElement?.append(tint);
      const isTinted = style.backgroundColor === getComputedStyle(tint).backgroundColor;
      tint.remove();
      return { isEdgeless: parseFloat(style.borderTopWidth) === 0 || alpha === 0, isTinted };
    });
    const rest = await getLook();
    await add.hover();
    const hovered = await getLook();
    await page.mouse.down();
    const held = await getLook();
    await page.close();

    assert.deepEqual({ rest, hovered, held }, {
      rest: { isEdgeless: true, isTinted: false },
      hovered: { isEdgeless: true, isTinted: false },
      held: { isEdgeless: true, isTinted: true },
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

  // spec §9.8 → Upload failed, §12.5: the note takes the wrap; Try again stays a whole 32 px square beside it
  test("a failed upload's Try again is a 32 px icon button beside a wrapping note", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    harness.refusals.set("upload", { status: 500, body: { error: "server" } });
    try {
      await addOrderFiles(page, [{ ...getImageFile(0), name: "a-screenshot-named-long-enough-to-wrap-the-note.png" }]);
      await page.locator(".queue-thumb-failed").first().waitFor();
      const facts = await page.getByRole("button", { name: "Try again" }).evaluate((button) => {
        const box = button.getBoundingClientRect();
        const note = (button.previousElementSibling as HTMLElement).getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(button.previousElementSibling as HTMLElement).lineHeight);
        return { id: button.id, size: [Math.round(box.width), Math.round(box.height)], isBeside: box.left >= note.right, isNoteWrapped: note.height > lineHeight * 1.5 };
      });
      assert.deepEqual(facts, { id: `${ORDER_BOX_ID}-retry`, size: [32, 32], isBeside: true, isNoteWrapped: true });
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

  // spec 44063 §14.4's edge cases: what the page shows for each, beside the rest state
  describe("on the edge-case fixtures", () => {
    test("a 9-option decision lists its nine options in the author's order with none picked, and its row reads 9 options", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.nineOptions);
      const shown = await page.evaluate((id) => ({
        codes: [...document.querySelectorAll(".queue-sheet .queue-option-head .text-dim")].map((code) => code.textContent),
        picked: [...document.querySelectorAll<HTMLInputElement>(".queue-sheet .ctl-radio")].filter((radio) => radio.checked).length,
        hasCount: document.querySelector(`#queue-row-${id} .queue-row-facts`)?.textContent?.includes("9 options") === true,
      }), EDGE_IDS.nineOptions);
      await page.close();

      assert.deepEqual(shown, { codes: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"], picked: 0, hasCount: true });
    });

    test("an approval-class decision carries the Approval tag on its row and its date line, and its note says to confirm in the terminal", async () => {
      const page = await openEdgePage(harness);
      await selectRow(page, EDGE_IDS.approval);
      const shown = await page.evaluate((id) => ({
        row: [...document.querySelectorAll(`#queue-row-${id} .queue-row-facts .pill--tag`)].map((badge) => badge.textContent),
        letterhead: [...document.querySelectorAll(".queue-sheet > .card-head .pill--tag, .queue-date-line .pill--tag")].map((badge) => badge.textContent),
        note: document.querySelector(".queue-sheet .queue-note-text")?.textContent ?? "",
      }), EDGE_IDS.approval);
      await page.close();

      assert.deepEqual({ row: shown.row, letterhead: shown.letterhead }, { row: ["Approval"], letterhead: ["Decision", "Approval"] });
      assert.match(shown.note, /Approval: after you answer here, confirm once more in aidl's terminal\./);
    });

    test("a 200-character title takes two lines on its 88 row with the whole title in its tooltip, and wraps in full at 20/28 on the sheet", async () => {
      const page = await openEdgePage(harness, DESK_WIDTHS[0].viewport);
      // the row is measured before its press: an opened row puts the list away
      const row = await page.evaluate((id) => {
        const element = document.querySelector(`#queue-row-${id}`) as HTMLElement;
        return [Math.round(element.getBoundingClientRect().height), element.querySelector(".queue-row-title")?.getAttribute("title")];
      }, EDGE_IDS.longTitle);
      await selectRow(page, EDGE_IDS.longTitle);
      const sheet = await page.evaluate(() => {
        const title = document.querySelector(".queue-sheet-title") as HTMLElement;
        const style = getComputedStyle(title);
        return [title.textContent, title.scrollHeight <= title.clientHeight, `${style.fontSize}/${style.lineHeight}`];
      });
      await page.close();

      assert.deepEqual({ row, sheet }, { row: [88, EDGE_LONG_TITLE], sheet: [EDGE_LONG_TITLE, true, "20px/28px"] });
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

    test("a 100-character session name stays on one cut line, its rail row 68 high and inside the rail", async () => {
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

      assert.deepEqual(shown, { text: EDGE_LONG_SESSION_NAME, height: 68, isCut: true, isInsideRail: true });
    });

    // spec §4.2, §14.4: the name column is 104 at every width a list stands in; the 12 gap puts every title 116 further in.
    // The edge fixture's 100-character session is only one recipient of a seven-session order, whose row reads `7 sessions` → one open item is sent from it here
    test("with nothing ticked every list row leads with its session name in a 104 box at one x, every title and meta line at one x 116 further in, and a 100-character name cut inside its box, at 1280 and 1568", async () => {
      const edge = getEdgeFixture();
      const longSession = edge.items.find((item) => item.session.id === EDGE_SESSION_IDS.longName)?.session;
      const sent = edge.items.find((item) => item.status === "open");
      assert.ok(longSession && sent, "the edge fixture holds the long-named session and an open item");
      const fixture = { ...edge, items: edge.items.map((item) => (item.id === sent.id ? { ...item, session: longSession } : item)) };
      const shown = [];
      for (const viewport of [MIN_WINDOW, { width: 1568, height: 759 }]) {
        harness.fixture = fixture;
        const page = await openQueuePage(harness, viewport, getRestReadyText(fixture));
        const facts = await page.evaluate((longName) => {
          const rows = [...document.querySelectorAll(".queue-row")];
          const box = (row: Element, selector: string) => (row.querySelector(selector) as HTMLElement).getBoundingClientRect();
          const long = [...document.querySelectorAll<HTMLElement>(".queue-row-name")].find((name) => name.title === longName);
          const longBox = long?.closest(".queue-row-who")?.getBoundingClientRect();
          return {
            isNameFirst: rows.length > 0 && rows.every((row) => row.firstElementChild?.matches(".queue-row-who")),
            widths: [...new Set(rows.map((row) => Math.round(box(row, ".queue-row-who").width)))],
            nameStarts: new Set(rows.map((row) => Math.round(box(row, ".queue-row-who").left))).size,
            titleOffsets: [...new Set(rows.flatMap((row) => [".queue-row-title", ".queue-row-meta"].map((selector) => Math.round(box(row, selector).left - box(row, ".queue-row-who").left))))],
            isLongCut: long !== undefined && longBox !== undefined && getComputedStyle(long).textOverflow === "ellipsis" && long.scrollWidth > long.clientWidth && long.getBoundingClientRect().right <= longBox.right + 0.5,
          };
        }, EDGE_LONG_SESSION_NAME);
        await page.close();
        shown.push({ width: viewport.width, ...facts });
      }

      assert.deepEqual(shown, shown.map(({ width }) => ({ width, isNameFirst: true, widths: [104], nameStarts: 1, titleOffsets: [116], isLongCut: true })));
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

    // spec §9.3 `Five recipients or more`: one roll-up line, the chevron right before its counts; the amber badge may take its own line
    for (const viewport of [VIEWPORTS[0], MIN_WINDOW]) {
      test(`at ${viewport.width} the roll-up's counts stay on one line with the chevron right before them`, async () => {
        const page = await openEdgePage(harness, viewport);
        await showThreadText(page, "7 sessions · 5 received · 1 not yet");
        const shown = await page.evaluate(() => {
          const summary = document.querySelector(".queue-roll-up > summary") as HTMLElement;
          const chevron = summary.querySelector(".disclosure-chevron") as Element;
          const counts = [...summary.querySelectorAll("span")].find((span) => span.textContent === "7 sessions · 5 received · 1 not yet") as HTMLElement;
          const gap = parseFloat(getComputedStyle(summary).columnGap) || 0;
          const chevronBox = chevron.getBoundingClientRect();
          const countsBox = counts.getBoundingClientRect();
          return {
            isOneLine: counts.getClientRects().length === 1 && countsBox.height < 2 * parseFloat(getComputedStyle(counts).lineHeight),
            isChevronBeside: countsBox.left - chevronBox.right <= gap + 1 && chevronBox.top < countsBox.bottom && chevronBox.bottom > countsBox.top,
          };
        });
        await page.close();

        assert.deepEqual(shown, { isOneLine: true, isChevronBeside: true });
      });
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

    test("an order with eight images reads Order · 8 images on its row and shows eight 96 squares in its bubble, each named n of 8", async () => {
      const page = await openEdgePage(harness);
      const row = await page.evaluate((id) => document.querySelector(`#queue-row-${id} .queue-row-facts`)?.textContent ?? "", EDGE_IDS.eightImages);
      await waitForAllOrders(page);
      const images = await page.evaluate(() => {
        const entry = [...document.querySelectorAll("article.queue-order")].find((order) => order.querySelectorAll(".queue-bubble-image").length > 3);
        return [...(entry?.querySelectorAll(".queue-bubble-image") ?? [])].map((button) => {
          const box = button.getBoundingClientRect();
          return `${Math.round(box.width)}x${Math.round(box.height)} ${button.getAttribute("aria-label")}`;
        });
      });
      await page.close();

      assert.match(row, /Order · 8 images/);
      assert.deepEqual(images, Array.from({ length: 8 }, (_, index) => `96x96 Open image ${index + 1} of 8: queue-edge-0${index + 1}.webp`));
    });

    // the narrowest list, at the minimum window: the meta line's dim text yields to `2 of 3 received` and its `⚠ 1 not received`, never the warning
    test("a list row keeps every badge of its facts whole, and the last fact text yields first to the column, ending in an ellipsis, at 1280", async () => {
      const page = await openEdgePage(harness, MIN_WINDOW);
      const rows = await page.evaluate(() => [...document.querySelectorAll(".queue-row-facts")].map((facts) => {
        const box = facts.getBoundingClientRect();
        const badges = [...facts.querySelectorAll(".pill")].map((badge) => ({
          text: badge.textContent,
          isWhole: badge.getBoundingClientRect().right <= box.right + 0.5 && badge.scrollWidth <= badge.clientWidth,
        }));
        // a fact's laid-out text against the nearest box that clips it, whichever span holds the fact
        const texts = [...facts.querySelectorAll("span")].filter((span) => span.textContent && !span.closest(".pill, [aria-hidden]") && ![...span.children].some((child) => !child.matches("[aria-hidden]")));
        const getClip = (span: Element) => {
          for (let node: Element | null = span; node && node !== facts.parentElement; node = node.parentElement) if (getComputedStyle(node).overflowX === "hidden") return node;
          return facts;
        };
        const getExtent = (span: Element) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          return range.getBoundingClientRect();
        };
        const cut = texts.filter((span) => getExtent(span).right > getClip(span).getBoundingClientRect().right + 0.5);
        const last = texts.at(-1);
        const isEarlyCut = last !== undefined && getClip(last).getBoundingClientRect().right > getExtent(last).left + 0.5 && cut.some((span) => span !== last);
        return { text: facts.textContent, badges, isEarlyCut, cutWithoutEllipsis: cut.filter((span) => getComputedStyle(getClip(span)).textOverflow !== "ellipsis").length };
      }));
      await page.close();

      assert.ok(rows.some((row) => row.badges.some((badge) => badge.text?.includes("not received")) && /received/.test(row.text?.replace(/⚠.*$/, "") ?? "")), "a row carries a count and its warning");
      assert.deepEqual(rows.flatMap((row) => row.badges.filter((badge) => !badge.isWhole).map((badge) => `${row.text}: ${badge.text}`)), [], "every badge whole");
      assert.deepEqual(rows.filter((row) => row.cutWithoutEllipsis > 0).map((row) => row.text), [], "a cut fact text ends in an ellipsis");
      assert.deepEqual(rows.filter((row) => row.isEarlyCut).map((row) => row.text), [], "an earlier fact text is cut only once the last one has yielded all its room");
    });
  });

  test("each named state is captured at every size §18.4 marks for it as a viewport-sized PNG named for the mockup", async (t) => {
    const dir = await getShotsDir();
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
    const dir = await getShotsDir();
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
