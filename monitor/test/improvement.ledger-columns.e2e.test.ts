// E2E chromium check for the Learning screen's pattern ledger (screens/improvement.jsx): where each
// section sits inside its stretched column, which a node render cannot measure — plus the page's
// other measured geometry: the tab row's gap to the first card and the awaiting list's ring room.
//
// Runner: npx tsx --test test/improvement.ledger-columns.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the payloads below; every other /api read answers empty.

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const COLUMNS = "#improvement-pattern-ledger .i-ledger-cols > .split-col";
// the columns pair up side by side from 1280px
const SIDE_BY_SIDE_WIDTH = 1440;
// sub-pixel rounding of the stretched grid track
const EDGE_TOLERANCE_PX = 1;

function getPatterns(count: number, isInert: boolean) {
  return Array.from({ length: count }, (_, i) => ({
    id: (isInert ? 500 : 100) + i,
    pattern_signature: `${isInert ? "inert" : "live"} signature ${i + 1}`,
    frequency: 10 - (i % 5),
    agent: "glass-atrium-dev-react",
    status: "identified",
    discovered_date: "2026-09-28",
    intake_skipped: isInert,
  }));
}

function getHeldBuckets(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    cause: `cause-${i + 1}`,
    label: `Held cause ${i + 1}`,
    count: 2,
    agents: 1,
    hint: "remedy text",
  }));
}

function getLearningLog(live: number, inert: number, held: number) {
  return {
    patterns: [...getPatterns(live, false), ...getPatterns(inert, true)],
    status_distribution: [{ status: "rejected", count: 1 }],
    total_patterns: live + inert,
    loop_suppression_state: {
      parked: getHeldBuckets(held),
      parked_patterns: [],
      per_cycle: [],
      per_cycle_window_days: 7,
      per_cycle_window_cycles: 3,
      pending_total: 0,
      pending_unpromptable: 0,
    },
  };
}

interface ColumnReading {
  sections: string[];
  topGap: number;
  sectionGaps: number[];
  rowGap: number;
  bottomGap: number;
}

// every ledger column: its sections by the first word of their head, the gap above the first section, between sections and below the last
async function getColumnReadings(learningLog: unknown): Promise<ColumnReading[]> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement/learning-log", async () => learningLog);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: SIDE_BY_SIDE_WIDTH, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.waitForSelector(COLUMNS, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate((selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((column) => {
        const box = column.getBoundingClientRect();
        const sections = [...column.children].map((section) => section.getBoundingClientRect());
        return {
          sections: [...column.children].map((section) => (section.textContent ?? "").trim().split(/\s/)[0]!),
          topGap: sections[0]!.top - box.top,
          sectionGaps: sections.slice(1).map((section, i) => section.top - sections[i]!.bottom),
          rowGap: parseFloat(getComputedStyle(column).rowGap) || 0,
          bottomGap: box.bottom - sections[sections.length - 1]!.bottom,
        };
      }), COLUMNS);
  } finally {
    await browser.close();
    await app.close();
  }
}

// held leads the first column, live then inert the second · the named column is the shorter one:
// every section follows the one above it at the column's gap and the free space stays below the last
const rows = [
  {
    name: "the held section alone in the first column stays at its top beside a long live list",
    learningLog: getLearningLog(10, 1, 1),
    column: 0,
    sections: ["Held"],
  },
  {
    name: "inert follows the live list in the second column beside a taller held table",
    learningLog: getLearningLog(1, 1, 6),
    column: 1,
    sections: ["Live", "Inert"],
  },
];

for (const row of rows) {
  test(`${row.name} at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
    const columns = await getColumnReadings(row.learningLog);
    assert.equal(columns.length, 2, "the ledger pairs its held rows with its candidates");
    const reading = columns[row.column]!;
    assert.deepEqual(reading.sections, row.sections, "the column holds the intended sections, in order");

    assert.ok(reading.topGap <= EDGE_TOLERANCE_PX, `the first section starts ${Math.round(reading.topGap)}px below the column top`);
    for (const [i, gap] of reading.sectionGaps.entries()) {
      assert.ok(Math.abs(gap - reading.rowGap) <= EDGE_TOLERANCE_PX, `section ${i + 2} starts ${Math.round(gap)}px under the one above it, not ${reading.rowGap}px`);
    }
    assert.ok(reading.bottomGap > EDGE_TOLERANCE_PX, "the free space stays under the last section");
  });
}

// On the opened inert list, labels and agents of different lengths still put every agent and every date on one column edge
test(`inert rows line their agent and date up in columns whatever the pattern and agent lengths, at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const shapes = [
    ["short", "glass-atrium-dev-db"],
    ["a much longer inert signature that keeps on going past the others", "glass-atrium-qa-code-reviewer"],
    ["mid-length inert signature", "glass-atrium-dev-react"],
  ];
  const learningLog = getLearningLog(10, 0, 0);
  learningLog.patterns.push(
    ...shapes.map(([signature, agent], i) => ({
      id: 900 + i,
      pattern_signature: signature,
      frequency: 1,
      agent,
      status: "identified",
      discovered_date: `2026-09-${String(20 + i).padStart(2, "0")}`,
      intake_skipped: true,
    })),
  );

  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement/learning-log", async () => learningLog);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: SIDE_BY_SIDE_WIDTH, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.waitForSelector("#improvement-pattern-ledger details", { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // the disclosure whose summary names the inert rows, opened, then its row list
    const rows = await page.evaluate(() => {
      const fold = [...document.querySelectorAll<HTMLDetailsElement>("#improvement-pattern-ledger details")]
        .find((el) => (el.querySelector("summary")?.textContent ?? "").includes("Inert ·"))!;
      fold.open = true;
      return [...fold.querySelector("ul")!.children].map((item) => {
        const [name, agent, date] = [...item.children].map((cell) => cell.getBoundingClientRect());
        return { nameRight: name!.right, agentLeft: agent!.left, dateLeft: date!.left, height: item.getBoundingClientRect().height };
      });
    });

    assert.equal(rows.length, shapes.length, "every inert row renders");
    for (const row of rows) {
      assert.ok(Math.abs(row.agentLeft - rows[0]!.agentLeft) <= 0.5, `agent column starts at ${row.agentLeft}, not ${rows[0]!.agentLeft}`);
      assert.ok(Math.abs(row.dateLeft - rows[0]!.dateLeft) <= 0.5, `date column starts at ${row.dateLeft}, not ${rows[0]!.dateLeft}`);
      assert.ok(row.nameRight <= row.agentLeft, "a long pattern name ellipsizes before the agent column");
      assert.ok(Math.abs(row.height - rows[0]!.height) <= 0.5, "every row keeps one line");
    }
  } finally {
    await browser.close();
    await app.close();
  }
});

// the recurrence table nests inside the ledger → its body rows take the 32 compact step
const RECURRENCE_ROW_PX = 32;

test(`the recurrence table's body rows sit on the ${RECURRENCE_ROW_PX} compact step at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const learningLog = getLearningLog(3, 0, 0);
  learningLog.loop_suppression_state.per_cycle = [
    { cause: "no-diff", label: "No diff produced", agents: 3, cycles: 2, count: 9, hint: "remedy text" },
    { cause: "rate-limit", label: "Rate limited", agents: 1, cycles: 1, count: 2, hint: "remedy text" },
  ] as never[];

  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement/learning-log", async () => learningLog);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: SIDE_BY_SIDE_WIDTH, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.waitForSelector("#improvement-pattern-ledger table", { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // the ledger table headed by "Cause" — found by its head, not by the class the fix added
    const heights = await page.evaluate(() => {
      const table = [...document.querySelectorAll("#improvement-pattern-ledger table")]
        .find((el) => el.querySelector("thead th")?.textContent?.trim() === "Cause");
      return table ? [...table.querySelectorAll("tbody > tr")].map((tr) => tr.getBoundingClientRect().height) : [];
    });

    assert.equal(heights.length, 2, "every recurrence row renders");
    for (const height of heights) assert.ok(Math.abs(height - RECURRENCE_ROW_PX) < 0.5, `row ${height}px`);
  } finally {
    await browser.close();
    await app.close();
  }
});

// one empty-line form across the screen: every "nothing here" line starts on its card's inline edge, inside a ledger section or not
test(`every empty line on the Learning screen starts on its card's inline edge at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement/learning-log", async () => getLearningLog(0, 0, 0));
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: SIDE_BY_SIDE_WIDTH, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.waitForSelector("#improvement-pattern-ledger .placeholder", { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".card .placeholder")]
        .filter((el) => /^(No |Not enough)/.test((el.textContent ?? "").trim()))
        .map((el) => {
          const card = el.closest<HTMLElement>(".card")!;
          const cardPad = parseFloat(getComputedStyle(card).getPropertyValue("--card-pad"));
          const textLeft = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft);
          return { text: (el.textContent ?? "").trim(), inset: textLeft - card.getBoundingClientRect().left, cardPad };
        }),
    );

    assert.ok(lines.length >= 3, `the empty board, ledger and loop cards each print a line (${lines.length})`);
    for (const line of lines) {
      assert.ok(Math.abs(line.inset - line.cardPad) <= EDGE_TOLERANCE_PX, `"${line.text}" starts ${line.inset}px in, not ${line.cardPad}px`);
    }
  } finally {
    await browser.close();
    await app.close();
  }
});

type Routes = Record<string, unknown>;

// the Learning screen on the payloads given, measured once the ready selector paints
async function getPageReading<T>(routes: Routes, readySelector: string, measure: () => T): Promise<T> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  for (const [url, payload] of Object.entries(routes)) app.get(url, async () => payload);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: SIDE_BY_SIDE_WIDTH, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.waitForSelector(readySelector, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(measure);
  } finally {
    await browser.close();
    await app.close();
  }
}

test(`the view tab row ends one --space-4 step above the first card at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const reading = await getPageReading({}, '[role="tablist"][aria-label="Learning view"]', () => {
    const row = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Learning view"]')!.getBoundingClientRect();
    const card = [...document.querySelectorAll<HTMLElement>(".card")].find((el) => el.getBoundingClientRect().top >= row.bottom)!;
    const probe = document.body.appendChild(Object.assign(document.createElement("div"), { style: "height: var(--space-4)" }));
    return { gap: card.getBoundingClientRect().top - row.bottom, step: probe.getBoundingClientRect().height };
  });

  assert.ok(reading.step > 0, "the --space-4 token resolves");
  assert.ok(Math.abs(reading.gap - reading.step) <= EDGE_TOLERANCE_PX, `the first card starts ${reading.gap}px under the tab row, not ${reading.step}px`);
});

test(`held table body cells set their text at the --fs-control step at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const routes = { "/api/improvement/learning-log": getLearningLog(1, 0, 2) };
  const reading = await getPageReading(routes, "#improvement-pattern-ledger table", () => {
    // the ledger table headed by a Held column — found by its head, not by the class the fix added
    const table = [...document.querySelectorAll("#improvement-pattern-ledger table")]
      .find((el) => [...el.querySelectorAll("th")].some((th) => th.textContent?.trim() === "Held"));
    const probe = document.body.appendChild(Object.assign(document.createElement("div"), { style: "font-size: var(--fs-control)" }));
    return {
      sizes: table ? [...table.querySelectorAll("tbody td")].map((td) => getComputedStyle(td).fontSize) : [],
      step: getComputedStyle(probe).fontSize,
    };
  });

  assert.ok(reading.sizes.length > 0, "the held table renders its rows");
  for (const size of reading.sizes) assert.equal(size, reading.step, "a held cell sits at the house table's body step");
});

test(`a held cause's name opens its rows under it, inside its table row, at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const learningLog = getLearningLog(1, 0, 2);
  learningLog.loop_suppression_state.parked_patterns = [
    { id: 701, pattern_signature: "held signature", agent: "glass-atrium-dev-react", discovered_date: "2026-09-20", cause: "cause-2" },
  ] as never[];
  const reading = await getPageReading({ "/api/improvement/learning-log": learningLog }, "#improvement-pattern-ledger table button[aria-expanded]", () => {
    const toggle = [...document.querySelectorAll<HTMLButtonElement>("#improvement-pattern-ledger table button[aria-expanded]")]
      .find((el) => el.textContent?.trim() === "Held cause 2")!;
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "")!;
    const isShownBefore = list.getBoundingClientRect().height > 0;
    toggle.click();
    return new Promise<{ isShownBefore: boolean; isShownAfter: boolean; expanded: string | null; text: string; isUnderCause: boolean }>((done) =>
      requestAnimationFrame(() => {
        const row = toggle.closest("tr")!;
        done({
          isShownBefore,
          isShownAfter: list.getBoundingClientRect().height > 0,
          expanded: toggle.getAttribute("aria-expanded"),
          text: list.textContent ?? "",
          isUnderCause: row.contains(list) && list.getBoundingClientRect().top >= toggle.getBoundingClientRect().bottom,
        });
      }),
    );
  });

  assert.equal(reading.isShownBefore, false, "a cause's rows start folded");
  assert.equal(reading.isShownAfter, true, "the name opens them");
  assert.equal(reading.expanded, "true");
  assert.match(reading.text, /Held signature/);
  assert.ok(reading.isUnderCause, "the rows open under their cause, in its row");
});

// one lead track (glyph slot, then chevron) → names in both groups and an opened row list share one start
test(`held cause names and their opened rows start on one column in both groups at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const learningLog = getLearningLog(1, 0, 1);
  learningLog.loop_suppression_state.parked.push({ cause: "non-promptable", label: "Non-promptable signal", count: 3, agents: 1, hint: "remedy text" });
  learningLog.loop_suppression_state.parked_patterns = [
    { id: 702, pattern_signature: "set aside signature", agent: "glass-atrium-dev-react", discovered_date: "2026-09-20", cause: "non-promptable" },
  ] as never[];
  const reading = await getPageReading({ "/api/improvement/learning-log": learningLog }, "#improvement-pattern-ledger table button[aria-expanded]", () => {
    const toggles = [...document.querySelectorAll<HTMLButtonElement>("#improvement-pattern-ledger table button[aria-expanded]")];
    const setAside = toggles.find((el) => el.textContent?.trim() === "Non-promptable signal")!;
    setAside.click();
    return new Promise<{ names: number[]; listStart: number }>((done) =>
      requestAnimationFrame(() => {
        const item = document.getElementById(setAside.getAttribute("aria-controls") ?? "")!.querySelector("li > span")!;
        done({ names: toggles.map((toggle) => toggle.querySelector("span:last-child")!.getBoundingClientRect().left), listStart: item.getBoundingClientRect().left });
      }),
    );
  });

  assert.equal(reading.names.length, 2, "one cause in each group");
  assert.ok(Math.abs(reading.names[0] - reading.names[1]) <= EDGE_TOLERANCE_PX, `names start at ${reading.names.join(" and ")}`);
  assert.ok(Math.abs(reading.listStart - reading.names[1]) <= EDGE_TOLERANCE_PX, `the opened rows start at ${reading.listStart}, the name at ${reading.names[1]}`);
});

// Live is the nested house table: each title a group row on its column's start edge, each row opening its drawer by click or by Enter
test(`a live row opens its pattern drawer by click and by Enter, under a title row on its column's start, at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement/learning-log", async () => getLearningLog(2, 0, 1));
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: SIDE_BY_SIDE_WIDTH, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    const rows = page.locator("#improvement-pattern-ledger tbody tr[data-roving-row]");
    await rows.first().waitFor({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const titleInsets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#improvement-pattern-ledger tbody th[role='heading']")]
        .filter((cell) => cell.closest("table")?.querySelector("tr[data-roving-row]"))
        .map((cell) => cell.getBoundingClientRect().left + parseFloat(getComputedStyle(cell).paddingLeft) - cell.closest(".split-col")!.getBoundingClientRect().left),
    );
    const drawer = page.locator(".detail-overlay");

    await rows.nth(0).click();
    await drawer.waitFor({ timeout: 5_000 });
    const clicked = await drawer.textContent();
    await page.getByRole("button", { name: "Close details" }).click();
    await drawer.waitFor({ state: "detached", timeout: 5_000 });
    await rows.nth(1).focus();
    await page.keyboard.press("Enter");
    await drawer.waitFor({ timeout: 5_000 });
    const entered = await drawer.textContent();

    assert.equal(titleInsets.length, 2, "each live title is its own group row");
    for (const inset of titleInsets) assert.ok(Math.abs(inset) <= EDGE_TOLERANCE_PX, `a live title starts ${inset}px off its column's start`);
    assert.match(clicked ?? "", /live signature 1\b/i, "a click opens the clicked row's pattern");
    assert.match(entered ?? "", /live signature 2\b/i, "Enter opens the focused row's pattern");
  } finally {
    await browser.close();
    await app.close();
  }
});
