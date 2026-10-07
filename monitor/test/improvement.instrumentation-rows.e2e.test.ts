// E2E chromium check for the Learning screen's instrumentation view (screens/improvement-instrumentation.jsx):
// every stretched row is sized by its content, not by empty space, which a node render cannot measure.
//
// Runner: npx tsx --test test/improvement.instrumentation-rows.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the suggestion payload below; every other /api read answers empty.

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { chromium, type Page } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
// design.md §1: a stretched row is valid only when its shorter column's natural body is ≥ 75% of the taller one's
const STRETCH_FLOOR = 0.75;

// the shipped measurement roster: four agents with add-only patches, four confidence lanes, a code-checked cohort
const SUGGESTIONS = {
  proposals: [],
  prose_only_add_summary: {
    window_days: 30,
    agents: [
      { agent: "glass-atrium-dev-db", count: 3 },
      { agent: "glass-atrium-dev-nestjs", count: 9 },
      { agent: "glass-atrium-dev-shell", count: 7 },
      { agent: "glass-atrium-meta-prompt-engineer", count: 3 },
    ],
    total: 22,
    truncation_caveat:
      "Floor, not a total — the verdict is derived from the stored diff, which is truncated before classification, so a longer patch whose removals fall past the cut is still classified prose-only-add.",
  },
  tier_breakdown_30d: {
    window_days: 30,
    code_based_pass_30d: 10689,
    code_based_fail_30d: 769,
    pre_3tier_baseline_count: 0,
  },
  confidence_distribution: {
    window_days: 30,
    buckets: [
      { promotion_tier: "candidate", proposal_count: 15, confidence_observed_avg: 0.8089 },
      { promotion_tier: "instruction-edit", proposal_count: 16, confidence_observed_avg: 0.8571 },
      { promotion_tier: "mention", proposal_count: 1, confidence_observed_avg: 0.6667 },
      { promotion_tier: "unassigned", proposal_count: 6, confidence_observed_avg: null },
    ],
    overall_confidence_observed_avg: 0.8286,
  },
};

// a roster well past the S slot's five rows — the stacked column must stay bounded whatever the data
const LONG_ROSTER_SUGGESTIONS = {
  ...SUGGESTIONS,
  prose_only_add_summary: {
    ...SUGGESTIONS.prose_only_add_summary,
    agents: Array.from({ length: 14 }, (_, index) => ({ agent: `glass-atrium-agent-${index + 1}`, count: 14 - index })),
    total: 105,
  },
};

const ROSTERS = [
  { name: "four add-only agents", suggestions: SUGGESTIONS },
  { name: "fourteen add-only agents", suggestions: LONG_ROSTER_SUGGESTIONS },
];

interface RowReading {
  cards: string;
  bodies: number[];
}

// stripped app serving a suggestion payload, switched to the instrumentation view
async function withInstrumentationPage(width: number, check: (page: Page) => Promise<void>, suggestions: object = SUGGESTIONS) {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement", async () => suggestions);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Instrumentation", exact: true }).click();
    await page.getByRole("heading", { name: "Add-only patches" }).waitFor({ timeout: 30_000 });
    await page.getByRole("heading", { name: "Results by check status" }).waitFor({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await check(page);
  } finally {
    await browser.close();
    await app.close();
  }
}

// Unstretches each equal row, reads every column's natural body (column height minus its card headers), restores it.
function readStretchedRows(page: Page): Promise<RowReading[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#improvement-instrumentation .split-row--equal")].map((row) => {
      row.style.alignItems = "start";
      const columns = [...row.children] as HTMLElement[];
      const bodies = columns.map((column) => {
        const heads = [...column.querySelectorAll<HTMLElement>(".card-head")];
        const headHeight = heads.reduce((sum, head) => sum + head.getBoundingClientRect().height, 0);
        return column.getBoundingClientRect().height - headHeight;
      });
      row.style.alignItems = "";
      const cards = [...row.querySelectorAll<HTMLElement>(".card-title")].map((title) => title.textContent).join(" | ");
      return { cards, bodies };
    }),
  );
}

// xl and up lay peers side by side; 1440 and 1920 are the two shipped desktop widths
for (const width of [1440, 1920]) {
  for (const roster of ROSTERS) {
    test(`every stretched instrumentation row keeps its shorter body at 75% or more with ${roster.name} at ${width}px`, async () => {
      await withInstrumentationPage(
        width,
        async (page) => {
          const rows = await readStretchedRows(page);

          assert.ok(rows.length >= 2, "the view stretches its gauge rows");
          for (const row of rows) {
            const ratio = Math.min(...row.bodies) / Math.max(...row.bodies);
            assert.ok(ratio >= STRETCH_FLOOR, `${width}px: [${row.cards}] is ${(ratio * 100).toFixed(1)}% filled`);
          }
        },
        roster.suggestions,
      );
    });
  }
}

// 1280 is the narrowest width where the check-status card sits in a half column
for (const width of [1280, 1440, 1920]) {
  test(`every check-status tile label reads on one line at ${width}px`, async () => {
    await withInstrumentationPage(width, async (page) => {
      const labels = await page.evaluate(() => {
        const title = [...document.querySelectorAll<HTMLElement>("#improvement-instrumentation .card-title")].find(
          (heading) => heading.textContent === "Results by check status",
        )!;
        return [...title.closest(".card")!.querySelectorAll<HTMLElement>(".grid > div .flex > span:last-child")].map((span) => ({
          text: span.textContent ?? "",
          lineCount: Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(span).lineHeight)),
        }));
      });

      assert.equal(labels.length, 4, "the card shows its four tiles");
      for (const label of labels) {
        assert.equal(label.lineCount, 1, `${width}px: "${label.text}" wraps onto ${label.lineCount} lines`);
      }
    });
  });
}
