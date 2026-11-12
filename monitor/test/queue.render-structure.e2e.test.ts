// E2E chromium harness for the Queue page (screens/queue.jsx): the page's real bundle on mockup v5's fixture data,
// the frame-independent facts every page stream keeps, and the named-state captures the owner compares to the mockup.
//
// Runner: npx tsx --test test/queue.render-structure.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network (React and the fonts).
// Captures: QUEUE_SHOTS_DIR (absolute) names the folder; unset → a fresh mktemp folder, its path printed as a diagnostic.
// App: stripped Fastify serving test/lib/queue-render-fixtures.ts; a queue read with no fixture route answers 404 and is recorded.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import type { OwnerItemView } from "../src/server/queue/owner-views.js";
import { ownerOrdersQuerySchema, type OwnerOrdersQuery } from "../src/server/queue/schemas.js";
import {
  FIXTURE_CLI_PATH, FIXTURE_IMAGES, FIXTURE_NOW, FIXTURE_SESSION_IDS, getNotReceivedFixture, getRestFixture, type QueueFixture,
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
 * One named page state: `nn` and `name` follow the mockup's capture names (`<width>x<height>-<nn>-<name>.png`).
 * `setUp` drives the page as it is built today → each page stream rewrites the steps its change moves.
 */
interface QueueState {
  nn: string;
  name: string;
  getFixture?: () => QueueFixture;
  setUp?: (page: Page) => Promise<void>;
}

const QUEUE_STATES: QueueState[] = [
  { nn: "01", name: "rest" },
  {
    nn: "02", name: "decision-picked",
    setUp: async (page) => {
      await page.locator("#queue-row-103").click();
      await page.locator("#queue-option-103-R2").check();
      await page.locator("#queue-text-103").fill("R2로 가되, 비교 평가 결과는 다음 보고에 붙여 주세요.");
    },
  },
  { nn: "03", name: "report", setUp: (page) => selectRow(page, 101) },
  {
    nn: "04", name: "rail-ticked",
    setUp: async (page) => {
      await page.getByLabel("Order to gersona").check();
      await page.getByLabel("Order to yoaida").check();
      await page.getByLabel("Order to yoaida").scrollIntoViewIfNeeded();
    },
  },
  { nn: "09", name: "not-received", getFixture: getNotReceivedFixture, setUp: (page) => selectRow(page, 210) },
  { nn: "18", name: "answered-not-yet", setUp: (page) => selectRow(page, 108) },
];

// Markup written by a session: rendered as text, it shows these literals; parsed as HTML, it adds probe elements.
const MARKUP_TITLE = "보고 <b data-markup-probe>굵게</b> 끝";
const MARKUP_BODY = "- 본문 <img data-markup-probe src=\"/markup-probe.png\" onerror=\"window.__markupRan = true\">";

interface Harness {
  app: FastifyInstance;
  url: string;
  browser: Browser;
  fixture: QueueFixture;
  /** Queue reads no fixture route answered, as "METHOD /path". */
  missedReads: string[];
}

async function openHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const harness: Harness = { app, url: "", browser: await chromium.launch({ headless: true }), fixture: getRestFixture(), missedReads: [] };
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

// the owner reads, the count and the image serve route, each answering in the server's response shape
function registerFixtureRoutes(app: FastifyInstance, harness: Harness): void {
  app.get<{ Querystring: { after?: string } }>("/api/queue/owner/items", async (request) => ({
    items: request.query.after === undefined ? harness.fixture.items : [], nextCursor: null, cliPath: FIXTURE_CLI_PATH,
  }));
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
  // an upload is stored as the first fixture image under the owner's label → its thumbnail loads from the serve route above
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.post<{ Querystring: { name: string } }>("/api/queue/owner/images", async (request, reply) => {
    const [first] = FIXTURE_IMAGES.values();
    return reply.code(201).send({ ...first?.view, name: request.query.name, bytes: (request.body as Buffer).length });
  });
  app.get("/api/queue/count", async () => ({
    awaiting: harness.fixture.items.filter((item) => item.status === "open").length,
    deviations: harness.fixture.items.filter((item) => item.deviation !== null).length,
    oldestAgeSeconds: null,
  }));
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

/** A fresh page on the pinned clock, opened on #queue once the fixture's text and the web fonts are in. */
async function openQueuePage(harness: Harness, viewport: { width: number; height: number }, readyText: string): Promise<Page> {
  const page = await harness.browser.newPage({ viewport });
  // tsx keeps function names through an injected __name helper → the evaluated fact readers need it on the page
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`${harness.url}/#queue`, { waitUntil: "load" });
  await page.getByText(readyText).first().waitFor({ timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

function selectRow(page: Page, id: number): Promise<void> {
  return page.locator(`#queue-row-${id}`).click();
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

/** Every state at every desktop width, each on a fresh page, as `<dir>/<width>x<height>-<nn>-<name>.png`. */
async function captureQueueStates(harness: Harness, dir: string): Promise<void> {
  for (const viewport of VIEWPORTS) {
    for (const state of QUEUE_STATES) await captureQueueState(harness, dir, viewport, state);
  }
}

async function captureQueueState(harness: Harness, dir: string, viewport: Viewport, state: QueueState): Promise<void> {
  harness.fixture = state.getFixture?.() ?? getRestFixture();
  const page = await openQueuePage(harness, viewport, getRestReadyText());
  try {
    await state.setUp?.(page);
    await page.screenshot({ path: join(dir, getShotName(viewport, state)) });
  } finally {
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

function getRestReadyText(): string {
  return getRestFixture().items[0]!.title;
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
    await page.getByRole("button", { name: "New order", exact: true }).click();
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

  test("an order's images are 96 squares in its bubble, an added one is a 56 thumbnail in a 104 box, and the viewer fits one in the window and steps", async () => {
    harness.fixture = getRestFixture();
    const page = await openQueuePage(harness, VIEWPORTS[0], getRestReadyText());
    await page.getByRole("button", { name: "New order", exact: true }).click();
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
    const stepped = await page.locator(".queue-viewer figcaption").textContent();
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

    await captureQueueStates(harness, dir);

    for (const viewport of VIEWPORTS) {
      for (const state of QUEUE_STATES) {
        const name = getShotName(viewport, state);
        assert.deepEqual(await getPngSize(join(dir, name)), { width: viewport.width, height: viewport.height }, name);
      }
    }
  });
});
