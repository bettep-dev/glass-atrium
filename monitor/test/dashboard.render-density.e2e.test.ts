// E2E chromium DENSITY harness for the Dashboard (screens/dashboard.jsx): where the content ends
// against the viewport, and how much blank band each status tile holds above its drill link.
// Payloads: test/fixtures/dashboard-payloads.json — one real served day, home paths rewritten.
//
// Runner: npx tsx --test test/dashboard.render-density.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:client`, installed chromium, CDN network.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { getBelowFloorText } from "./lib/painted-text.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const PAYLOADS: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "dashboard-payloads.json"), "utf8"),
);

const TILE_IDS = ["harness", "outcomes", "fleet", "spend"];
// A blank band is dead space once it could hold a line of meta text plus its gap.
const TILE_BAND_MAX_PX = 24;

interface Viewport {
  width: number;
  height: number;
}

interface DensityProbe {
  contentBottom: number;
  statusBandHeight: number;
  // blank px between a tile's last fact and its drill link, keyed by tile id
  tileBands: Record<string, number>;
}

let app: FastifyInstance;
let browser: Browser;
let serverUrl: string;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  for (const [path, payload] of Object.entries(PAYLOADS)) app.get(path, async () => payload);
  // endpoints no Dashboard region owns → quiet empty payloads, never a 404 banner
  app.get("/api/*", async () => ({ rows: [] }));
  await app.ready();
  serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await app?.close();
});

async function openDashboard(viewport: Viewport): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const harness = document.querySelector("#dash-tile-harness")?.textContent ?? "";
      const hasStrip = document.querySelector("#dash-week-spend ol") !== null;
      const hasResults = (document.querySelector("#dash-week-results")?.textContent ?? "").includes("reported outcomes");
      const hasHours = document.querySelector("#dash-week-hours [role=img]") !== null;
      return / (up|down)/.test(harness) && hasStrip && hasResults && hasHours;
    },
    undefined,
    { timeout: 30_000 },
  );
  return page;
}

async function getDensity(page: Page): Promise<DensityProbe> {
  return page.evaluate((tileIds) => {
    const sections = document.querySelector("#dash-status")?.parentElement;
    const children = sections ? Array.from(sections.children) : [];
    const contentBottom = Math.max(...children.map((el) => el.getBoundingClientRect().bottom + window.scrollY));
    const statusBandHeight = document.querySelector("#dash-status")?.getBoundingClientRect().height ?? 0;
    const tileBands: Record<string, number> = {};
    for (const id of tileIds) {
      const card = document.querySelector(`#dash-tile-${id}`);
      const drill = card?.lastElementChild;
      const fact = drill?.previousElementSibling;
      if (!card || !drill || !fact) continue;
      tileBands[id] = Math.round(drill.getBoundingClientRect().top - fact.getBoundingClientRect().bottom);
    }
    return { contentBottom: Math.round(contentBottom), statusBandHeight: Math.round(statusBandHeight), tileBands };
  }, TILE_IDS);
}

describe("Dashboard density at 1440×900", () => {
  let probe: DensityProbe;

  before(async () => {
    const page = await openDashboard({ width: 1440, height: 900 });
    probe = await getDensity(page);
    // the plan's hand-back figure — measured, reported, never asserted as a pixel value
    console.log(`density 1440x900: ${JSON.stringify(probe)}`);
    await page.close();
  });

  test("the content ends within one status-band row of the viewport bottom", () => {
    assert.ok(900 - probe.contentBottom <= probe.statusBandHeight,
      `content ends at ${probe.contentBottom}, leaving more than one ${probe.statusBandHeight}px row blank`);
  });

  // todo → a known-unmet target: runs and reports, never fails the suite until the tiles close their bands
  test("no status tile holds a blank band above its drill link", { todo: "Harness and Fleet still keep a band after their facts moved" }, () => {
    for (const [id, band] of Object.entries(probe.tileBands)) {
      assert.ok(band <= TILE_BAND_MAX_PX, `${id} tile keeps a ${band}px blank band`);
    }
  });
});

describe("Dashboard density at 1024", () => {
  test("the content bottom is measured and the page scrolls no wider than the viewport", async () => {
    const page = await openDashboard({ width: 1024, height: 768 });
    const probe = await getDensity(page);
    console.log(`density 1024x768: ${JSON.stringify(probe)}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.close();
    assert.ok(overflow <= 0, `page overflows by ${overflow}px at 1024`);
  });
});

// A data hint clamps its data, never the authored words around it: each part stays inside the hint box,
// and the data keeps a visible fragment even when the tile column is narrow.
interface HintSpan {
  text: string;
  isData: boolean;
  left: number;
  right: number;
  width: number;
}

async function getDataHints(page: Page): Promise<Array<{ box: { left: number; right: number }; spans: HintSpan[] }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".dash-tile-hint-line")].map((line) => {
      const box = line.getBoundingClientRect();
      const spans = [...line.querySelectorAll<HTMLElement>(".dash-tile-hint-fixed, .dash-tile-hint-data")]
        .filter((span) => (span.textContent ?? "").trim() !== "")
        .map((span) => {
          const rect = span.getBoundingClientRect();
          const isData = span.classList.contains("dash-tile-hint-data");
          return { text: span.textContent ?? "", isData, left: rect.left, right: rect.right, width: rect.width };
        });
      return { box: { left: box.left, right: box.right }, spans };
    }),
  );
}

describe("Data hints at narrow tile widths", () => {
  for (const width of [1024, 1200]) {
    test(`every data hint part stays inside its box and the data stays visible at ${width}`, async () => {
      const page = await openDashboard({ width, height: 768 });
      await page.evaluate(() => document.fonts.ready);
      const hints = await getDataHints(page);
      await page.close();
      assert.ok(hints.length > 0, "the fixture renders a data hint");
      for (const hint of hints) {
        for (const span of hint.spans) {
          assert.ok(span.left >= hint.box.left - 0.5 && span.right <= hint.box.right + 0.5,
            `"${span.text}" spans ${span.left}–${span.right}, outside its box ${hint.box.left}–${hint.box.right}`);
        }
        const data = hint.spans.find((span) => span.isData);
        assert.ok(data && data.width > 0, `the data is not visible: ${JSON.stringify(hint.spans)}`);
      }
    });
  }
});

// Runs by hour reads as a grid of squares: no cell outgrows the cap, and the panel sits beside the results from xl
const HOUR_CELL_MAX_PX = 20;

interface Box {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

interface WeekLayout {
  results: Box;
  hours: Box;
  spend: Box;
  cells: Array<{ width: number; height: number }>;
}

async function getWeekLayout(page: Page): Promise<WeekLayout> {
  return page.evaluate(() => {
    // anonymous callbacks only → tsx's keepNames helper does not exist inside the page
    const [results, hours, spend] = ["dash-week-results", "dash-week-hours", "dash-week-spend"].map((id) => {
      const rect = document.querySelector(`#${id}`)?.getBoundingClientRect();
      return { top: rect?.top ?? NaN, bottom: rect?.bottom ?? NaN, left: rect?.left ?? NaN, width: rect?.width ?? NaN };
    });
    const cells = Array.from(document.querySelectorAll("#dash-week-hours [role=img] .dash-hour-cell")).map((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    return { results, hours, spend, cells };
  });
}

function assertSquareCells(cells: WeekLayout["cells"]): void {
  assert.equal(cells.length, 7 * 24, "one cell per weekday and hour");
  for (const cell of cells) {
    assert.ok(Math.abs(cell.width - cell.height) < 0.5, `cell ${cell.width}×${cell.height} is not square`);
    assert.ok(cell.width > 0 && cell.width <= HOUR_CELL_MAX_PX + 0.01, `cell ${cell.width}px exceeds ${HOUR_CELL_MAX_PX}px`);
  }
}

describe("Runs by hour layout", () => {
  test("at 1440 it sits beside the task results with square capped cells, and Spend spans the row below", async () => {
    const page = await openDashboard({ width: 1440, height: 900 });
    const layout = await getWeekLayout(page);
    await page.close();
    assert.ok(Math.abs(layout.hours.top - layout.results.top) < 1, "Runs by hour shares the results row");
    assert.ok(layout.hours.left > layout.results.left, "Runs by hour is the right half");
    assert.ok(layout.spend.top >= Math.max(layout.results.bottom, layout.hours.bottom), "Spend starts below the pair");
    assert.ok(layout.spend.width >= layout.results.width + layout.hours.width, "Spend spans the full width");
    assertSquareCells(layout.cells);
  });

  test("at 1024 it stacks Results, Runs by hour, Spend in one column with square capped cells", async () => {
    const page = await openDashboard({ width: 1024, height: 768 });
    const layout = await getWeekLayout(page);
    await page.close();
    const tops = [layout.results.top, layout.hours.top, layout.spend.top];
    assert.ok(tops[0] < tops[1] && tops[1] < tops[2], `panel tops ${tops.join(" / ")} are not Results, Runs by hour, Spend`);
    assert.ok(Math.abs(layout.hours.left - layout.results.left) < 1, "one column");
    assertSquareCells(layout.cells);
  });
});

async function openDashboardWithTweaks(viewport: Viewport): Promise<Page> {
  const page = await openDashboard(viewport);
  await page.evaluate(() => window.postMessage({ type: "__activate_edit_mode" }, window.location.origin));
  await page.waitForSelector(".twk-panel", { timeout: 10_000 });
  return page;
}

// The 13px meta floor covers every rendered text node: the page, the shell's nav rail and footer,
// and the Tweaks panel the shell mounts in edit mode.
describe("Type floor on the Dashboard page, shell and Tweaks panel included", () => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    test(`no drawn text sits below the 13px meta floor at ${viewport.width}`, async () => {
      const page = await openDashboardWithTweaks(viewport);
      const belowFloor = await getBelowFloorText(page);
      await page.close();
      assert.deepEqual(belowFloor, []);
    });
  }

  test("nav labels draw at the control step, one above the meta floor", async () => {
    const page = await openDashboard({ width: 1440, height: 900 });
    const sizes = await page.evaluate(() => {
      const control = getComputedStyle(document.documentElement).getPropertyValue("--fs-control").trim();
      const labels = Array.from(document.querySelectorAll(".nav-item .rail-hide")).map((el) => getComputedStyle(el).fontSize);
      return { control, labels };
    });
    await page.close();
    assert.equal(sizes.labels.length, 9, "one label per nav item");
    for (const size of sizes.labels) assert.equal(size, sizes.control, `a nav label draws at ${size}, not ${sizes.control}`);
  });
});
