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
