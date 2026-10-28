// E2E chromium check for the Learning screen's pattern ledger (screens/improvement.jsx): where each
// section sits inside its stretched column, which a node render cannot measure.
//
// Runner: npx tsx --test test/improvement.ledger-columns.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the learning log below; every other /api read answers empty.

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
  sections: number;
  topGap: number;
  bottomGap: number;
}

// every ledger column: its section count, the gap above the first section and below the last
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
          sections: sections.length,
          topGap: sections[0]!.top - box.top,
          bottomGap: box.bottom - sections[sections.length - 1]!.bottom,
        };
      }), COLUMNS);
  } finally {
    await browser.close();
    await app.close();
  }
}

// the named column is the shorter one: a lone section keeps its free space below, a later section pins to the bottom
const rows = [
  {
    name: "a short live list alone in its column stays at the column top",
    learningLog: getLearningLog(1, 1, 2),
    column: 0,
    sections: 1,
    isBottomPinned: false,
  },
  {
    name: "an inert section alone beside a long live list stays at the column top",
    learningLog: getLearningLog(10, 1, 0),
    column: 1,
    sections: 1,
    isBottomPinned: false,
  },
  {
    name: "a two-section column beside a long live list starts at its top and ends on the shared bottom edge",
    learningLog: getLearningLog(10, 1, 1),
    column: 1,
    sections: 2,
    isBottomPinned: true,
  },
];

for (const row of rows) {
  test(`${row.name} at ${SIDE_BY_SIDE_WIDTH}px`, async () => {
    const columns = await getColumnReadings(row.learningLog);
    assert.equal(columns.length, 2, "the ledger pairs its live list with a side column");
    const reading = columns[row.column]!;
    assert.equal(reading.sections, row.sections, "the case renders the intended section count");

    assert.ok(reading.topGap <= EDGE_TOLERANCE_PX, `the first section starts ${Math.round(reading.topGap)}px below the column top`);
    assert.equal(
      reading.bottomGap <= EDGE_TOLERANCE_PX,
      row.isBottomPinned,
      `the last section ends ${Math.round(reading.bottomGap)}px above the column bottom`,
    );
  });
}

// On the inert list, pattern names and agents of different lengths still put every agent and every date on one column edge
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
    await page.waitForSelector(COLUMNS, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // the list right after the section head that names the inert rows — the innermost div opening with its label
    const rows = await page.evaluate(() => {
      const head = [...document.querySelectorAll<HTMLElement>("#improvement-pattern-ledger div")]
        .filter((el) => (el.textContent ?? "").startsWith("Inert —"))
        .at(-1)!;
      return [...head.nextElementSibling!.children].map((item) => {
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
