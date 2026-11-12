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
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import type { OwnerItemView } from "../src/server/queue/owner-views.js";
import { messageBodySchema, ownerOrdersQuerySchema, type OwnerOrdersQuery } from "../src/server/queue/schemas.js";
import {
  buildSentCopies, FIXTURE_CLI_PATH, FIXTURE_IMAGES, FIXTURE_NOW, FIXTURE_ORDER_TEXT, FIXTURE_SESSION_IDS, getAnswerNotReceivedFixture, getArrivalFixture,
  getEmptyFixture, getNotReceivedFixture, getOneReceivedFixture, getRestFixture, getUnreachableFixture, type QueueFixture,
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
type Viewport = (typeof VIEWPORTS)[number];

/**
 * One named page state: `nn` and `name` follow the mockup's capture names (`<width>x<height>-<nn>-<name>.png`, spec §18.4).
 * `setUp` drives the page to the state and waits on what the state shows → a step the page no longer takes fails the capture.
 * @property isClockDriven - the page's timers run on the test's clock, for the 15 s re-read
 * @property isFirstLoad - captured before the first item read answers, without the setUp
 */
interface QueueState {
  nn: string;
  name: string;
  getFixture?: () => QueueFixture;
  setUp?: (page: Page, harness: Harness) => Promise<void>;
  isClockDriven?: boolean;
  isFirstLoad?: boolean;
}

const NOTE_TEXT = "R2로 가되, 비교 평가 결과는 다음 보고에 붙여 주세요.";
const REPLY_TEXT = "README 안내까지 끝나면 PR 병합 단계로 넘어가 주세요.";
const ORDER_TO = ["gersona", "yoaida"];

const DESK_STATES: QueueState[] = [
  { nn: "01", name: "rest" },
  { nn: "02", name: "decision-picked", setUp: (page) => pickWithNote(page) },
  { nn: "03", name: "report", setUp: (page) => selectRow(page, 101) },
  {
    nn: "04", name: "rail-ticked",
    setUp: async (page) => {
      await tickSessions(page, ORDER_TO);
      await page.getByLabel("Order to yoaida").scrollIntoViewIfNeeded();
    },
  },
  { nn: "11a", name: "restore-before", setUp: (page) => scrollDesk(page) },
  {
    nn: "11b", name: "restore-after",
    setUp: async (page) => {
      await scrollDesk(page);
      await openOrders(page);
      await page.getByRole("button", { name: "Close" }).click();
      await page.locator(".queue-sheet").waitFor();
    },
  },
  { nn: "17", name: "in-delivery-row", setUp: (page) => selectRow(page, 109) },
  { nn: "18", name: "answered-not-yet", setUp: (page) => selectRow(page, 108) },
  { nn: "18b", name: "answered-not-received", getFixture: getAnswerNotReceivedFixture, setUp: (page) => selectRow(page, 108) },
  {
    nn: "19", name: "scope-and-tick",
    setUp: async (page) => {
      await page.locator(`[data-session="${FIXTURE_SESSION_IDS.gersona}"] .queue-rail-main`).click();
      await tickSessions(page, ["yoaida"]);
    },
  },
  { nn: "20", name: "arrival-on-desk", isClockDriven: true, setUp: (page, harness) => arriveItem(page, harness) },
  { nn: "21b", name: "empty-queue", getFixture: getEmptyFixture },
  { nn: "24", name: "first-load", isFirstLoad: true },
  { nn: "26", name: "not-reachable", getFixture: getUnreachableFixture },
];

const ORDER_STATES: QueueState[] = [
  { nn: "05", name: "new-order-mode", setUp: (page) => openOrdersTo(page, ORDER_TO) },
  { nn: "06", name: "order-with-images", setUp: (page) => typeOrderWithImages(page) },
  { nn: "07", name: "just-sent", setUp: (page) => sendOrderWithImages(page) },
  { nn: "08", name: "one-received", getFixture: getOneReceivedFixture, setUp: (page) => openOrdersTo(page, ORDER_TO) },
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
    nn: "10", name: "arrival-in-mode", isClockDriven: true,
    setUp: async (page, harness) => {
      await openOrdersTo(page, ORDER_TO);
      await arriveItem(page, harness);
    },
  },
  { nn: "12", name: "reply-from-report", setUp: (page) => orderFromReport(page) },
  {
    nn: "12b", name: "second-tick",
    setUp: async (page) => {
      await orderFromReport(page);
      await tickSessions(page, ["gersona"]);
    },
  },
  {
    nn: "13", name: "image-viewer",
    setUp: async (page) => {
      await openOrdersTo(page, ["atrium"]);
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
      await page.locator(".queue-status", { hasText: "Order sent to yoaida" }).waitFor();
    },
  },
  { nn: "16", name: "atrium-ticked", setUp: (page) => openOrdersTo(page, ["atrium"]) },
  {
    nn: "16b", name: "send-no-tick",
    setUp: async (page) => {
      await openOrders(page);
      await page.locator(`#${ORDER_BOX_ID}`).fill(FIXTURE_ORDER_TEXT);
      await page.locator(".queue-orders").getByRole("button", { name: "Send order" }).click();
      await page.locator(".queue-orders").getByText("Tick at least one session").waitFor();
    },
  },
  { nn: "21c", name: "empty-thread", getFixture: getEmptyFixture, setUp: (page) => openOrdersTo(page, ["aidl"]) },
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
      await openOrdersTo(page, ORDER_TO);
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
  {
    nn: "25b", name: "focus-row",
    setUp: async (page) => {
      await page.locator(".queue-row").first().click();
      await page.keyboard.press("j");
    },
  },
  {
    nn: "25c", name: "focus-option",
    setUp: async (page) => {
      await page.locator(".queue-row").first().click();
      await page.keyboard.press("Enter");
    },
  },
  {
    nn: "25e", name: "focus-close",
    setUp: async (page) => {
      await openOrdersTo(page, ORDER_TO);
      // a key press, not a programmatic focus → the browser draws the keyboard ring on Close
      await page.getByRole("button", { name: "Clear" }).focus();
      await page.keyboard.press("Shift+Tab");
    },
  },
  { nn: "25f", name: "key-list", setUp: (page) => page.getByRole("button", { name: /Keyboard shortcuts/ }).click() },
];

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
  uploads: number;
}

async function openHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const harness: Harness = {
    app, url: "", browser: await chromium.launch({ headless: true }), fixture: getRestFixture(), missedReads: [], refusals: new Map(), heldRead: null, uploads: 0,
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
  app.get<{ Querystring: { after?: string } }>("/api/queue/owner/items", async (request) => {
    await harness.heldRead;
    return { items: request.query.after === undefined ? harness.fixture.items : [], nextCursor: null, cliPath: FIXTURE_CLI_PATH };
  });
  app.get<{ Params: { id: string } }>("/api/queue/owner/items/:id", async (request, reply) => {
    const item = harness.fixture.items.find((candidate) => String(candidate.id) === request.params.id);
    return item ?? reply.code(404).send({ error: "unknown_item" });
  });
  app.get("/api/queue/owner/sessions", async () => ({ sessions: harness.fixture.sessions, hasMore: false }));
  app.get("/api/queue/owner/resumes", async () => ({ resumes: harness.fixture.resumes }));
  app.get("/api/queue/owner/orders", async (request) => getOrderPage(harness.fixture.orders, ownerOrdersQuerySchema.parse(request.query)));
  app.get<{ Params: { id: string } }>("/api/queue/owner/images/:id", async (request, reply) => {
    const image = FIXTURE_IMAGES.get(request.params.id);
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
 */
async function openQueuePage(harness: Harness, viewport: { width: number; height: number }, readyText: string, isClockDriven = false): Promise<Page> {
  const page = await harness.browser.newPage({ viewport });
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

async function scrollDesk(page: Page): Promise<void> {
  await pickWithNote(page);
  await page.evaluate(() => {
    for (const [selector, top] of [[".queue-list > .card-body", 60], [".queue-sheet > .card-body", 160]] as const) (document.querySelector(selector) as HTMLElement).scrollTop = top;
  });
}

async function tickSessions(page: Page, names: string[]): Promise<void> {
  for (const name of names) await page.getByLabel(`Order to ${name}`).check();
}

async function openOrders(page: Page): Promise<void> {
  await page.locator(".queue-sessions").getByRole("button", { name: "New order", exact: true }).click();
  await page.locator(`#${ORDER_BOX_ID}`).waitFor();
}

async function openOrdersTo(page: Page, names: string[]): Promise<void> {
  await tickSessions(page, names);
  await openOrders(page);
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
  await openOrdersTo(page, ["gersona"]);
  await setFiles(page, ORDER_BOX_ID, files);
}

async function typeOrderWithImages(page: Page): Promise<void> {
  await openOrdersTo(page, ORDER_TO);
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

// `O` on the atrium report carries its draft into the mode under a `Re:` line
async function orderFromReport(page: Page): Promise<void> {
  await selectRow(page, 102);
  await page.locator("#queue-reply-102").fill(REPLY_TEXT);
  await selectRow(page, 102);
  await page.keyboard.press("o");
  await page.locator(`#${ORDER_BOX_ID}`).waitFor();
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
  await openOrdersTo(page, ["gersona"]);
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

/** Desk column widths per viewport (spec 44063 §3.2): main = viewport − 268, the two gaps 16 each. */
const DESK_WIDTHS = [
  { viewport: { width: 1280, height: 800 }, rail: 208, list: 320, sheet: 452 },
  { viewport: VIEWPORTS[0], rail: 232, list: 360, sheet: 548 },
  { viewport: { width: 1568, height: 759 }, rail: 232, list: 383, sheet: 653 },
  { viewport: VIEWPORTS[1], rail: 248, list: 527, sheet: 653 },
  { viewport: VIEWPORTS[2], rail: 248, list: 719, sheet: 653 },
  { viewport: { width: 2560, height: 1440 }, rail: 280, list: 1327, sheet: 653 },
] as const;

interface DeskFacts {
  isScrolled: boolean;
  rail: number;
  list: number;
  sheet: number;
}

async function getDeskFacts(page: Page): Promise<DeskFacts> {
  return page.evaluate(() => {
    const width = (selector: string) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? -1);
    const scrollers = [document.scrollingElement, document.querySelector("main")].filter((node): node is Element => node !== null);
    return {
      isScrolled: scrollers.some((node) => node.scrollHeight > node.clientHeight),
      rail: width(".queue-sessions"), list: width(".queue-list"), sheet: width(".queue-sheet"),
    };
  });
}

interface SheetFacts {
  text: string[];
  title: string[];
  rowHeights: number[];
  bands: string[];
  isFootInView: boolean;
}

// painted type, row and band facts of spec §14.4, read on the report sheet
async function getSheetFacts(page: Page): Promise<SheetFacts> {
  return page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
    const text = document.querySelector(".queue-sheet .prose-text") as HTMLElement;
    const probe = document.body.appendChild(Object.assign(document.createElement("div"), { style: "background: rgb(var(--surface))" }));
    const ground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const foot = document.querySelector(".queue-sheet > .card-foot")?.getBoundingClientRect();
    return {
      text: [style(".queue-sheet .prose-text").fontSize, style(".queue-sheet .prose-text").lineHeight, String(text.getBoundingClientRect().width <= 590)],
      title: [style(".queue-sheet-title").fontSize, style(".queue-sheet-title").lineHeight],
      rowHeights: [...new Set([...document.querySelectorAll(".queue-row")].map((row) => Math.round(row.getBoundingClientRect().height)))].sort(),
      bands: [...new Set([...document.querySelectorAll(".queue-band")].map((band) => `${Math.round(band.getBoundingClientRect().height)} ${getComputedStyle(band).backgroundColor === ground}`))],
      isFootInView: foot !== undefined && foot.bottom <= window.innerHeight && foot.height > 0,
    };
  });
}

/**
 * Every state at every desktop width, each on a fresh page, as `<dir>/<width>x<height>-<nn>-<name>.png`.
 * @returns one line per capture whose setUp failed, so one broken state does not hide the others
 */
async function captureQueueStates(harness: Harness, dir: string): Promise<string[]> {
  const failures: string[] = [];
  for (const viewport of VIEWPORTS) {
    for (const state of QUEUE_STATES) {
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
    await page.close();
  }
}

// the item read held open → the page's placeholders, captured once the screen has drawn them
async function captureFirstLoad(harness: Harness, dir: string, viewport: Viewport, state: QueueState): Promise<void> {
  let release = () => {};
  harness.heldRead = new Promise((resolve) => { release = resolve; });
  const page = await harness.browser.newPage({ viewport });
  try {
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.goto(`${harness.url}/#queue`, { waitUntil: "load" });
    await page.locator(".queue-screen").waitFor({ timeout: READY_TIMEOUT_MS });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({ path: join(dir, getShotName(viewport, state)) });
  } finally {
    release();
    harness.heldRead = null;
    await page.close();
  }
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

  test("the desk fills the window with no page scroll, its rail, list and sheet sized per width step", async () => {
    harness.fixture = getRestFixture();
    for (const row of DESK_WIDTHS) {
      const page = await openQueuePage(harness, row.viewport, getRestReadyText());
      const facts = await getDeskFacts(page);
      await page.close();
      // 66ch is measured on the loaded font, the spec's widths are its arithmetic → within one pixel
      const near = (actual: number, expected: number) => (Math.abs(actual - expected) <= 1 ? expected : actual);
      const shown = { ...facts, rail: near(facts.rail, row.rail), list: near(facts.list, row.list), sheet: near(facts.sheet, row.sheet) };
      assert.deepEqual(shown, { isScrolled: false, rail: row.rail, list: row.list, sheet: row.sheet }, `${row.viewport.width}x${row.viewport.height}`);
    }
  });

  test("the sheet's text is 15/24 within 66ch, its title 20/28, rows 68 or 88, bands 32 on the page ground, and its foot in view", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await selectRow(page, 101);
    const facts = await getSheetFacts(page);
    await page.close();
    assert.deepEqual(facts, { text: ["15px", "24px", "true"], title: ["20px", "28px"], rowHeights: [68, 88], bands: ["32 true"], isFootInView: true });
  });

  test("list rows take their one-line form, 44 high, once the list is 880 wide", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, { width: 2560, height: 1440 }, getRestReadyText());
    const rowHeights = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-row")].map((row) => Math.round(row.getBoundingClientRect().height)))]);
    await page.close();

    assert.deepEqual(rowHeights, [44]);
  });

  // spec §11: the desk's keys on the real page, and the inset ring on the rows the cards clip
  test("J / K step the list, Enter goes into the sheet, a digit picks, Esc returns, N opens Orders and Esc gives the focus back", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    const active = () => page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return { id: element.id, tag: element.tagName, inSheet: Boolean(element.closest(".queue-sheet")), offset: getComputedStyle(element).outlineOffset, cls: element.className };
    });
    const rowIds = await page.evaluate(() => [...document.querySelectorAll(".queue-row")].map((row) => row.id));
    await page.locator(".queue-row").first().click();
    await page.keyboard.press("j");
    const stepped = await active();
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    const entered = await active();
    await page.keyboard.press("2");
    const picked = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".queue-sheet input[type=radio]")].findIndex((radio) => radio.checked));
    await page.keyboard.press("Escape");
    const back = await active();
    await page.focus(".queue-rail-row .queue-rail-main");
    const rail = await active();
    await page.keyboard.press("n");
    const box = await active();
    await page.focus(".queue-order");
    const entry = await active();
    await page.keyboard.press("Escape");
    const returned = await active();
    await page.close();

    assert.equal(stepped.id, rowIds[1], "J selects and focuses the next row");
    assert.deepEqual([entered.tag, entered.inSheet], ["INPUT", true], "Enter moves the focus into the decision's options");
    assert.equal(picked, 1, "2 picks the second option");
    assert.deepEqual([back.id, back.offset], [rowIds[0], "-2px"], "Esc gives the focus back to the selected row, its ring inset");
    assert.equal(rail.offset, "-2px", "a rail row's ring is inset");
    assert.equal(box.id, "queue-order-text", "N puts the caret in the order box");
    assert.equal(entry.offset, "-2px", "a thread entry's ring is inset");
    assert.deepEqual([returned.cls, returned.offset], [rail.cls, "-2px"], "Esc closes Orders and gives the focus back to the rail row that opened it");
  });

  test("rail rows are 68; the Orders mode hides the list and the sheet, keeps one 720 column, and gives both scroll positions back on Close", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[2], getRestReadyText());
    await selectRow(page, 101);
    const stored = await page.evaluate(() => [".queue-list > .card-body", ".queue-sheet > .card-body"].map((selector) => {
      const body = document.querySelector(selector) as HTMLElement;
      body.scrollTop = 40;
      return body.scrollTop;
    }));
    const railRows = await page.evaluate(() => [...new Set([...document.querySelectorAll(".queue-rail-row")].map((row) => Math.round(row.getBoundingClientRect().height)))]);
    await page.locator(".queue-sessions").getByRole("button", { name: "New order", exact: true }).click();
    await page.locator(".queue-order").first().waitFor();
    const mode = await page.evaluate(() => {
      const card = (document.querySelector(".queue-orders-card") as HTMLElement).getBoundingClientRect();
      const inset = (selector: string, side: "left" | "right") => {
        const box = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return Math.round(side === "left" ? box.left - card.left : card.right - box.right);
      };
      const orders = [...document.querySelectorAll(".queue-order")];
      return {
        isAwayShown: [".queue-list", ".queue-sheet"].some((selector) => (document.querySelector(selector) as HTMLElement).getClientRects().length > 0),
        column: Math.round(card.width - 2 * inset(".queue-orders-card > .card-head h2, .queue-orders-card > .card-head .card-title", "left")),
        insets: [inset(".queue-orders-card > .card-head .btn", "right"), Math.round(card.right - (orders[orders.length - 1] as HTMLElement).getBoundingClientRect().right)],
        pad: Math.round((card.width - 720) / 2),
      };
    });
    await page.getByRole("button", { name: "Close" }).click();
    const restored = await page.evaluate(() => [".queue-list > .card-body", ".queue-sheet > .card-body"].map((selector) => (document.querySelector(selector) as HTMLElement).scrollTop));
    await page.close();

    assert.deepEqual(railRows, [68]);
    assert.deepEqual({ isAwayShown: mode.isAwayShown, column: mode.column, insets: mode.insets }, { isAwayShown: false, column: 720, insets: [mode.pad, mode.pad] });
    assert.deepEqual(restored, stored);
  });

  // spec §18.4 row 20: the arrival reaches the row, the rail and the nav on the same tick, and moves nothing the owner holds
  test("the page's own 15 s read marks an arrival New and raises its session's and the nav's counts, the selection unmoved", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText(), true);
    try {
      const selected = () => page.locator('[role="option"][aria-selected="true"]').getAttribute("id");
      const before = await selected();
      harness.fixture = getArrivalFixture();
      await page.clock.fastForward(15_000);
      await page.locator("#queue-row-150").waitFor({ timeout: READY_TIMEOUT_MS });
      const rail = page.locator(`[data-session="${FIXTURE_SESSION_IDS.yoaida}"] .queue-rail-count .pill`);
      await assert.doesNotReject(rail.filter({ hasText: /^2$/ }).waitFor({ timeout: READY_TIMEOUT_MS }), "yoaida's rail count reads 2");
      await assert.doesNotReject(page.locator(".nav-item", { hasText: "Queue" }).locator(".nav-count").filter({ hasText: "8" }).waitFor({ timeout: READY_TIMEOUT_MS }), "the nav count reads 8");
      assert.deepEqual(await page.locator("#queue-row-150 .queue-row-who .pill--solid").allTextContents(), ["New"]);
      assert.equal(await selected(), before);
    } finally {
      await page.close();
    }
  });

  test("an order's images are 96 squares in its bubble, an added one is a 56 thumbnail in a 104 box, and the viewer fits one in the window and steps", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.locator(".queue-sessions").getByRole("button", { name: "New order", exact: true }).click();
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
      const img = (document.querySelector(".queue-viewer img") as HTMLElement).getBoundingClientRect();
      return img.top >= 0 && img.left >= 0 && img.bottom <= window.innerHeight && img.right <= window.innerWidth;
    });
    await page.keyboard.press("ArrowRight");
    const stepped = await page.locator(".queue-viewer-name").textContent();
    await page.keyboard.press("Escape");
    const after = await page.evaluate(() => ({ isViewerOpen: document.querySelector(".queue-viewer") !== null, isModeOpen: document.querySelector(".queue-orders") !== null, focus: document.activeElement?.getAttribute("aria-label") }));
    await page.close();

    assert.ok(bubble.length > 0 && bubble.every(([width, height, isLoaded]) => width === 96 && height === 96 && isLoaded), JSON.stringify(bubble));
    assert.deepEqual({ thumb: composer.thumb, box: composer.box }, { thumb: [56, 56], box: 104 });
    assert.match(composer.count ?? "", /^1 image · \d+ KB$/);
    assert.equal(fit, true);
    assert.match(stepped ?? "", / · 2 of \d+$/);
    assert.deepEqual({ isViewerOpen: after.isViewerOpen, isModeOpen: after.isModeOpen }, { isViewerOpen: false, isModeOpen: true });
    assert.match(after.focus ?? "", /^Open image 1 of \d+: /);
  });

  test("each named state is captured at every desktop width as a viewport-sized PNG named for the mockup", async (t) => {
    const dir = await getShotsDir();
    t.diagnostic(`captures: ${dir}`);

    const failures = await captureQueueStates(harness, dir);

    assert.deepEqual(failures, []);
    for (const viewport of VIEWPORTS) {
      for (const state of QUEUE_STATES) {
        const name = getShotName(viewport, state);
        assert.deepEqual(await getPngSize(join(dir, name)), { width: viewport.width, height: viewport.height }, name);
      }
    }
  });
});
