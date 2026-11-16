// E2E chromium DENSITY harness for the Dashboard (screens/dashboard.jsx): where the content ends
// against the viewport, and where the status card and its four stats sit.
// Payloads: test/fixtures/dashboard-payloads.json — one served day per Dashboard endpoint, synthetic values of served magnitudes.
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

const STAT_COUNT = 4;

interface Viewport {
  width: number;
  height: number;
}

interface DensityProbe {
  contentBottom: number;
  statusBandHeight: number;
}

// a describe that needs another payload sets it here for its own page and clears it after
const overrides: Record<string, unknown> = {};

let app: FastifyInstance;
let browser: Browser;
let serverUrl: string;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  for (const [path, payload] of Object.entries(PAYLOADS)) app.get(path, async () => overrides[path] ?? payload);
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
      const harness = document.querySelector("#dash-status .stat")?.textContent ?? "";
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
  return page.evaluate(() => {
    const sections = document.querySelector("#dash-status")?.parentElement;
    const children = sections ? Array.from(sections.children) : [];
    const contentBottom = Math.max(...children.map((el) => el.getBoundingClientRect().bottom + window.scrollY));
    const statusBandHeight = document.querySelector("#dash-status")?.getBoundingClientRect().height ?? 0;
    return { contentBottom: Math.round(contentBottom), statusBandHeight: Math.round(statusBandHeight) };
  });
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

// One card of four stats (spec 44084 §9): the stats share one line, the first screen keeps Spend per day,
// and every stacked card starts on one left edge.
interface StatusLayout {
  statTops: number[];
  spendTop: number;
  cardLefts: Record<string, number>;
}

async function getStatusLayout(page: Page): Promise<StatusLayout> {
  return page.evaluate(() => {
    const statTops = Array.from(document.querySelectorAll("#dash-status .stat")).map((el) => Math.round(el.getBoundingClientRect().top));
    const spendTop = document.querySelector("#dash-week-spend")?.getBoundingClientRect().top ?? NaN;
    const cardLefts: Record<string, number> = {};
    for (const id of ["dash-status", "dash-week-results", "dash-week-spend"]) {
      const card = document.querySelector(`#${id} .card`);
      if (card) cardLefts[id] = card.getBoundingClientRect().left;
    }
    return { statTops, spendTop, cardLefts };
  });
}

describe("The status card at 1440×900", () => {
  let layout: StatusLayout;

  before(async () => {
    const page = await openDashboard({ width: 1440, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    layout = await getStatusLayout(page);
    console.log(`status layout 1440x900: ${JSON.stringify(layout)}`);
    await page.close();
  });

  test("its four stats share one line", () => {
    assert.equal(layout.statTops.length, STAT_COUNT, "every stat renders");
    assert.equal(new Set(layout.statTops).size, 1, `stat tops ${layout.statTops.join(" / ")}`);
  });

  test("Spend per day starts on the first screen", () => {
    assert.ok(layout.spendTop < 900, `Spend per day starts at ${layout.spendTop}`);
  });

  test("the status card and the week cards start on one left edge", () => {
    const lefts = Object.values(layout.cardLefts);
    assert.equal(lefts.length, 3, JSON.stringify(layout.cardLefts));
    assert.ok(Math.max(...lefts) - Math.min(...lefts) < 0.5, JSON.stringify(layout.cardLefts));
  });
});

// The status card holds its settled height (design.md §3.3) through a first load, a held refresh and a lone failure:
// the cards below never move when a stat's read lands or fails
const STATUS_CARD_STATES: Array<{ name: string; open: () => Promise<Page> }> = [
  {
    name: "while its stats load",
    open: async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      // never answered → every stat stays on its placeholder (the shell's harness fold reads these too)
      await page.route(/\/api\/(cost\/kpi|agents\/summary|outcomes\/cross-analysis)/, () => {});
      await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
      await page.waitForFunction(() => document.querySelectorAll("#dash-status .stat-value [role=status]").length === 4, undefined, { timeout: 30_000 });
      return page;
    },
  },
  {
    name: "when two stats are held over failed refreshes on two causes, each with its own Retry",
    open: async () => {
      const page = await openDashboard({ width: 1440, height: 900 });
      await page.route(/\/api\/agents\/summary/, (route) => route.fulfill({ status: 500, json: {} }));
      await page.route(/\/api\/cost\/kpi/, (route) => route.fulfill({ status: 502, json: {} }));
      await page.getByRole("button", { name: "Refresh dashboard" }).click();
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("#dash-status .stat-context")).filter((el) => /^Last known/.test(el.textContent ?? "")).length >= 2,
        undefined,
        { timeout: 30_000 },
      );
      return page;
    },
  },
  {
    name: "when one stat failed alone and keeps its own Retry",
    open: async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.route(/\/api\/agents\/summary/, (route) => route.fulfill({ status: 500, json: {} }));
      await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
      await page.waitForFunction(() => (document.querySelector("#dash-status")?.textContent ?? "").includes("Couldn't load the fleet summary"), undefined, { timeout: 30_000 });
      return page;
    },
  },
];

async function getStatusCardHeight(page: Page): Promise<number> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => document.querySelector("#dash-status")?.getBoundingClientRect().height ?? NaN);
}

describe("The status card at 1440×900 keeps its settled height", () => {
  let settled: number;

  before(async () => {
    const page = await openDashboard({ width: 1440, height: 900 });
    try {
      settled = await getStatusCardHeight(page);
    } finally {
      await page.close();
    }
  });

  for (const state of STATUS_CARD_STATES) {
    test(state.name, async () => {
      const page = await state.open();
      try {
        const height = await getStatusCardHeight(page);
        console.log(`status card ${state.name} 1440x900: ${height} (settled ${settled})`);
        assert.ok(Math.abs(height - settled) < 0.5, `${height}px, settled ${settled}px`);
      } finally {
        await page.close();
      }
    });
  }
});

describe("The status card while its stats load at 1440×900", () => {
  test("a stat's loading placeholder reads at the regular weight, as the panel placeholder does", async () => {
    const page = await STATUS_CARD_STATES[0].open();
    try {
      const weights = await page.$$eval("#dash-status .stat-value [role=status]", (els) => els.map((el) => getComputedStyle(el).fontWeight));
      assert.deepEqual(weights, ["400", "400", "400", "400"]);
    } finally {
      await page.close();
    }
  });
});

// The alarm row (spec 44084 §3.2): a 32 first line between 8 paddings → one line 48, the card-head height;
// a detail line under the title adds 4 + 18.2 → about 70
const ALARM_ROW_PX = { ONE_LINE: 48, WITH_DETAIL: 70 };
// spend at 3× its 7-day average (a detail line) + an update ready to apply (no detail) → two warn rows
const ALARM_PAYLOADS: Record<string, unknown> = {
  "/api/cost/kpi": { ...(PAYLOADS["/api/cost/kpi"] as object), today_cost_usd: 30, window_7d_cost_usd: 70, burn_rate_3h_usd_per_hour: 0.1 },
  "/api/dashboard/update-status": { ...(PAYLOADS["/api/dashboard/update-status"] as object), status: "update-available", latest_version: "1.0.2" },
  "/api/dashboard/update-job": { status: "none" },
};

describe("Alarm rows at 1440×900", () => {
  let rows: Array<{ height: number; hasDetail: boolean }>;

  before(async () => {
    Object.assign(overrides, ALARM_PAYLOADS);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
      await page.waitForFunction(() => document.querySelectorAll(".dash-alarm-list .alarm-row").length === 2, undefined, { timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      // the hairline between rows is the list's, not the row's → border-box height less the bottom border
      rows = await page.$$eval(".dash-alarm-list .alarm-row", (els) => els.map((el) => ({
        height: el.getBoundingClientRect().height - parseFloat(getComputedStyle(el).borderBottomWidth),
        hasDetail: el.querySelector(".dash-alarm-detail") !== null,
      })));
      console.log(`alarm rows 1440x900: ${JSON.stringify(rows)}`);
    } finally {
      await page.close();
      for (const path of Object.keys(ALARM_PAYLOADS)) delete overrides[path];
    }
  });

  test("a row with a detail line is about 70 tall and a one-line row 48, the card-head height", () => {
    assert.deepEqual(rows.map((row) => row.hasDetail), [true, false], "the spend row carries a detail, the install row none");
    for (const row of rows) {
      const expected = row.hasDetail ? ALARM_ROW_PX.WITH_DETAIL : ALARM_ROW_PX.ONE_LINE;
      assert.ok(Math.abs(row.height - expected) < 1, `row ${row.height}px, expected ${expected}`);
    }
  });
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

describe("Runs by hour ramp", () => {
  test("a zero hour is an outlined empty cell and every run hour paints one of the four heat tokens at full opacity", async () => {
    const page = await openDashboard({ width: 1440, height: 900 });
    const paint = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const heats = ["--heat-1", "--heat-2", "--heat-3", "--heat-4"].map((token) => {
        probe.style.background = `var(${token})`;
        return getComputedStyle(probe).backgroundColor;
      });
      probe.remove();
      const cells = Array.from(document.querySelectorAll("#dash-week-hours [role=img] .dash-hour-cell")).map((el) => {
        const style = getComputedStyle(el);
        return { title: el.getAttribute("title") ?? "", background: style.backgroundColor, shadow: style.boxShadow, opacity: style.opacity };
      });
      const key = document.querySelector("#dash-week-hours .dash-hour-key")?.textContent ?? "";
      return { heats, cells, key };
    });
    await page.close();
    const peak = Math.max(...(PAYLOADS["/api/outcomes/heatmap"] as { data: number[][] }).data.flat());
    assert.match(paint.key, new RegExp(`^01${peak} runs per hour$`), "the key ends on the grid's peak");
    const isZero = (title: string) => / — 0 runs$/.test(title);
    const zeros = paint.cells.filter((cell) => isZero(cell.title));
    const filled = paint.cells.filter((cell) => !isZero(cell.title));
    assert.ok(zeros.length > 0 && filled.length > 0, "the fixture holds zero and run hours");
    for (const cell of zeros) {
      assert.equal(cell.background, "rgba(0, 0, 0, 0)", `${cell.title}: no fill`);
      assert.match(cell.shadow, /0px 0px 0px 1px inset$/, `${cell.title}: a 1px inset outline`);
    }
    for (const cell of filled) {
      assert.ok(paint.heats.includes(cell.background), `${cell.title}: ${cell.background} is not a heat token`);
      assert.equal(cell.opacity, "1", `${cell.title}: never quieted by opacity`);
    }
  });
});

async function openDashboardWithTweaks(viewport: Viewport): Promise<Page> {
  const page = await openDashboard(viewport);
  await page.evaluate(() => window.postMessage({ type: "__activate_edit_mode" }, window.location.origin));
  await page.waitForSelector(".twk-panel", { timeout: 10_000 });
  return page;
}

// The 13px meta floor covers every rendered text node: the page, the shell's nav rail,
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
      return { control, labels, itemCount: document.querySelectorAll(".nav-item").length };
    });
    await page.close();
    assert.ok(sizes.itemCount > 0, "the nav rendered its items");
    assert.equal(sizes.labels.length, sizes.itemCount, "one label per nav item");
    for (const size of sizes.labels) assert.equal(size, sizes.control, `a nav label draws at ${size}, not ${sizes.control}`);
  });
});

// At the icon rail a count must never cover its row's icon: two rows told apart only by the icon would read alike.
describe("Nav counts at the icon rail", () => {
  test("at 1024 every visible count leaves its icon whole and stays inside its row, and a two-count row keeps its crit count", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    const kpi = { ...(PAYLOADS["/api/dashboard/kpi"] as Record<string, unknown>), last_1h_fail_count: 3 };
    const live = PAYLOADS["/api/architecture/live"] as { daemons: Record<string, unknown>[] };
    const downLive = { ...live, daemons: live.daemons.map((d, i) => (i === 0 ? { ...d, effective_status: "error" } : d)) };
    await page.route("**/api/dashboard/kpi", (route) => route.fulfill({ json: kpi }));
    await page.route("**/api/architecture/live", (route) => route.fulfill({ json: downLive }));
    await page.goto(`${serverUrl}/#dashboard`, { waitUntil: "load" });
    await page.locator(".nav-item .nav-count").nth(1).waitFor({ state: "attached", timeout: 30_000 });
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".nav-item")).filter((item) => item.querySelector(".nav-count")).map((item) => {
        const icon = (item.querySelector("svg") as Element).getBoundingClientRect();
        const row = item.getBoundingClientRect();
        const visible = Array.from(item.querySelectorAll(".nav-count")).filter((c) => getComputedStyle(c).clip === "auto"); // the rail clips extra counts, it does not unbox them
        return {
          label: item.getAttribute("title"),
          counts: item.querySelectorAll(".nav-count").length,
          visibleText: visible.map((c) => (c.textContent ?? "").trim()),
          // overlap area of each visible count with the icon box — inline: a named helper here gains an esbuild __name the page lacks
          coveredPx: Math.round(visible.map((c) => c.getBoundingClientRect()).reduce((sum, r) => sum + Math.max(0, Math.min(r.right, icon.right) - Math.max(r.left, icon.left)) * Math.max(0, Math.min(r.bottom, icon.bottom) - Math.max(r.top, icon.top)), 0)),
          isInside: visible.every((c) => { const r = c.getBoundingClientRect(); return r.left >= row.left && r.right <= row.right && r.top >= row.top && r.bottom <= row.bottom; }),
        };
      });
    });
    await page.close();
    const map = rows.find((r) => r.label === "System map");
    assert.equal(map?.counts, 2, "precondition: System map carries a warn and a crit count");
    assert.match(map?.visibleText.join("|") ?? "", /^✕/, "the rail keeps the crit count");
    for (const row of rows) {
      assert.equal(row.visibleText.length, 1, `${row.label}: the rail shows one count`);
      assert.equal(row.coveredPx, 0, `${row.label}: the count covers ${row.coveredPx} px² of the icon`);
      assert.ok(row.isInside, `${row.label}: the count stays inside its row`);
    }
  });
});
