// E2E chromium check for the Learning screen's instrumentation view (screens/improvement-instrumentation.jsx):
// every stretched row is sized by its content, not by empty space, which a node render cannot measure.
//
// Runner: npx tsx --test test/improvement.instrumentation-rows.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the suggestion payload and region payloads below; every other /api read answers empty.

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

// synthetic payload in the shipped shape: four agents with add-only patches, four confidence lanes, a code-checked cohort
const SUGGESTIONS = {
  proposals: [],
  prose_only_add_summary: {
    window_days: 30,
    agents: [
      { agent: "glass-atrium-agent-a", count: 4 },
      { agent: "glass-atrium-agent-b", count: 8 },
      { agent: "glass-atrium-agent-c", count: 6 },
      { agent: "glass-atrium-agent-d", count: 2 },
    ],
    total: 20,
    truncation_caveat:
      "Floor, not a total — the verdict is derived from the stored diff, which is truncated before classification, so a longer patch whose removals fall past the cut is still classified prose-only-add.",
  },
  tier_breakdown_30d: {
    window_days: 30,
    code_based_pass_30d: 12406,
    code_based_fail_30d: 538,
    pre_3tier_baseline_count: 0,
  },
  confidence_distribution: {
    window_days: 30,
    buckets: [
      { promotion_tier: "candidate", proposal_count: 12, confidence_observed_avg: 0.75 },
      { promotion_tier: "instruction-edit", proposal_count: 18, confidence_observed_avg: 0.8889 },
      { promotion_tier: "mention", proposal_count: 2, confidence_observed_avg: 0.5 },
      { promotion_tier: "unassigned", proposal_count: 5, confidence_observed_avg: null },
    ],
    overall_confidence_observed_avg: 0.8125,
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

// the instrumentation payload plus a style-check cohort, so both mixed cards (stat row + table) render their table
const MIXED_CARD_SUGGESTIONS = {
  ...SUGGESTIONS,
  style_ref_summary: {
    overall_emission_rate: 0.6,
    overall_uncorroborated_rate: 0.05,
    overall_corroborated_count: 19,
    overall_uncorroborated_count: 1,
    overall_unverifiable_count: 4,
    overall_greenfield_count: 2,
    agents: [
      { agent: "glass-atrium-agent-a", emission_count: 12, emission_total: 20, emission_rate: 0.6, corroborated_count: 11, uncorroborated_count: 1, unverifiable_count: 3, eligible_count: 12 },
      { agent: "glass-atrium-agent-b", emission_count: 12, emission_total: 20, emission_rate: 0.6, corroborated_count: 8, uncorroborated_count: 0, unverifiable_count: 1, eligible_count: 8 },
    ],
  },
};

// a corpus audit and correction signals, so the upper gauge row holds data on both sides and stretches
const FILLED_REGIONS: Record<string, object> = {
  "/api/improvement/corpus-audits": {
    total_audits: 12,
    audits: [
      { cycle_date: "2026-11-20", word_count: 41250, trend_delta: 120, file_count: 38, token_estimate: 53600, seeded_threshold: 60000,
        gate_pass_count: 9, gate_trip_count: 1, gate_total_count: 10, compliance_rate: 0.9, override_rate: 0.1, trend_alert: false, absolute_alert: false },
      { cycle_date: "2026-11-19", word_count: 41130, trend_delta: 85, file_count: 38, token_estimate: 53450, seeded_threshold: 60000,
        gate_pass_count: 8, gate_trip_count: 2, gate_total_count: 10, compliance_rate: 0.8, override_rate: 0.2, trend_alert: false, absolute_alert: false },
    ],
  },
  "/api/improvement/correction-signals": {
    total_signals: 128,
    latest_event_ts: "2026-11-20T05:00:00Z",
    agreement: { total: 128, agreement_count: 120, both_matched: 70, stage1_only: 5, stage2_only: 3, neither_matched: 50 },
    revision_delta_sum: 4,
    revision_delta_max: 2,
  },
};

// every region known and empty: no audit, no signal, no flagged row, no add-only patch, no task result, no suggestion
const EMPTY_SUGGESTIONS = {
  proposals: [],
  prose_only_add_summary: { window_days: 30, agents: [], total: 0 },
  tier_breakdown_30d: { window_days: 30, code_based_pass_30d: 0, code_based_fail_30d: 0, pre_3tier_baseline_count: 0 },
  confidence_distribution: { window_days: 30, buckets: [], overall_confidence_observed_avg: null },
  style_ref_summary: { overall_emission_rate: null, overall_uncorroborated_rate: null, agents: [] },
};
const EMPTY_CARD_COUNT = 6;

interface RowReading {
  cards: string;
  bodies: number[];
}

// stripped app serving a suggestion payload, switched to the instrumentation view
async function withInstrumentationPage(
  width: number,
  check: (page: Page) => Promise<void>,
  suggestions: object = SUGGESTIONS,
  regions: Record<string, object> = FILLED_REGIONS,
) {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  app.get("/api/improvement", async () => suggestions);
  for (const [path, payload] of Object.entries(regions)) app.get(path, async () => payload);
  app.get("/api/*", async () => ({ rows: [] }));
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${serverUrl}/#improvement`, { waitUntil: "load" });
    await page.getByRole("tab", { name: "Instrumentation", exact: true }).click();
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
  test(`every check-status stat label reads on one line at ${width}px`, async () => {
    await withInstrumentationPage(width, async (page) => {
      const labels = await page.evaluate(() => {
        const title = [...document.querySelectorAll<HTMLElement>("#improvement-instrumentation .card-title")].find(
          (heading) => heading.textContent === "Results by check status",
        )!;
        return [...title.closest(".card")!.querySelectorAll<HTMLElement>(".stat-row .stat-label")].map((span) => ({
          text: span.textContent ?? "",
          lineCount: Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(span).lineHeight)),
        }));
      });

      assert.equal(labels.length, 4, "the card shows its four stats");
      for (const label of labels) {
        assert.equal(label.lineCount, 1, `${width}px: "${label.text}" wraps onto ${label.lineCount} lines`);
      }
    });
  });
}

// design-spec §1 one inline column per side: a card's head, stat row and table header open on one column, its last cell closes on the other
// 1024 = narrowest card, where a double inset or a wrap shows first; 1440 + 1920 = the shipped desktop widths
for (const width of [1024, 1440, 1920]) {
  test(`each mixed instrumentation card keeps its stat row and table on the card head's inline column at ${width}px`, async () => {
    await withInstrumentationPage(width, async (page) => {
      const cards = await page.evaluate(() =>
        ["Suggestion confidence", "Style-check rate"].map((name) => {
          const title = [...document.querySelectorAll<HTMLElement>("#improvement-instrumentation .card-title")].find(
            (heading) => heading.textContent === name,
          );
          const card = title?.closest(".card");
          const table = card?.querySelector("table");
          if (!card || !table) return { name, columns: null };
          const cardBox = card.getBoundingClientRect();
          const border = parseFloat(getComputedStyle(card).borderLeftWidth);
          const innerLeft = cardBox.left + border;
          const innerRight = cardBox.right - parseFloat(getComputedStyle(card).borderRightWidth);
          // content edge = box edge inset by its own padding, measured from the card's inner edge
          const [head, statRow, header] = [card.querySelector(".card-head")!, card.querySelector(".stat-row")!, table.querySelector("thead th")!].map(
            (el) => Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft) - innerLeft),
          );
          const [headEnd, lastCell] = [card.querySelector(".card-head")!, table.querySelector("tbody tr td:last-child")!].map(
            (el) => Math.round(innerRight - el.getBoundingClientRect().right + parseFloat(getComputedStyle(el).paddingRight)),
          );
          return { name, columns: { start: { head, statRow, header }, end: { head: headEnd, lastCell } } };
        }),
      );

      for (const { name, columns } of cards) {
        assert.ok(columns, `${width}px: "${name}" renders a table in its card`);
        const { start, end } = columns;
        assert.deepEqual([start.statRow, start.header], [start.head, start.head], `${width}px: "${name}" opens on one column — ${JSON.stringify(start)}`);
        assert.equal(end.lastCell, end.head, `${width}px: "${name}" closes on one column — ${JSON.stringify(end)}`);
      }
    }, MIXED_CARD_SUGGESTIONS);
  });
}

// a bar marks a position; the stat beside it already states the number (60.0%), so no 0.60 rides the bar
test("each mixed instrumentation card's bars state no number of their own", async () => {
  await withInstrumentationPage(1440, async (page) => {
    const cards = await page.evaluate(() =>
      ["Suggestion confidence", "Style-check rate"].map((name) => {
        const card = [...document.querySelectorAll<HTMLElement>("#improvement-instrumentation .card-title")]
          .find((heading) => heading.textContent === name)?.closest(".card");
        const bars = card ? [...card.querySelectorAll('[role="img"][aria-label]')]
          .filter((bar) => /^(Average measured confidence|Reported rate|Uncorroborated share)/.test(bar.getAttribute("aria-label") ?? "")) : [];
        const walker = card ? document.createTreeWalker(card, NodeFilter.SHOW_TEXT) : null;
        const barForms: string[] = [];
        for (let node = walker?.nextNode(); node; node = walker?.nextNode()) {
          const text = node.textContent?.trim() ?? "";
          if (/^\d\.\d\d$/.test(text)) barForms.push(text);
        }
        return { name, barCount: bars.length, barForms };
      }),
    );

    for (const { name, barCount, barForms } of cards) {
      assert.ok(barCount > 0, `"${name}" draws its bars`);
      assert.deepEqual(barForms, [], `"${name}" holds a bar's second number form`);
    }
  }, MIXED_CARD_SUGGESTIONS);
});

interface EmptyCardReading {
  title: string;
  lineLeft: number;
  titleLeft: number;
  height: number;
  expectedHeight: number;
  lineCount: number;
}

// each empty card: its title and line edges, its height against head + pad + one line + pad, the line's line count
function readEmptyCards(page: Page): Promise<{ cards: EmptyCardReading[]; stretchedEmptyCount: number }> {
  return page.evaluate(() => {
    const root = document.querySelector("#improvement-instrumentation")!;
    const cards = [...root.querySelectorAll<HTMLElement>(".card")].filter((card) => card.querySelector(".placeholder"));
    return {
      stretchedEmptyCount: root.querySelectorAll(".split-row--equal .placeholder").length,
      cards: cards.map((card) => {
        const line = card.querySelector<HTMLElement>(".placeholder > div")!;
        const lineBox = line.getBoundingClientRect();
        const cardStyle = getComputedStyle(card);
        const pad = parseFloat(cardStyle.getPropertyValue("--card-pad"));
        const borders = parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth);
        const head = card.querySelector<HTMLElement>(".card-head")!.getBoundingClientRect().height;
        return {
          title: card.querySelector(".card-title")?.textContent ?? "",
          lineLeft: lineBox.left,
          titleLeft: card.querySelector<HTMLElement>(".card-title")!.getBoundingClientRect().left,
          height: card.getBoundingClientRect().height,
          expectedHeight: borders + head + pad + lineBox.height + pad,
          lineCount: Math.round(lineBox.height / parseFloat(getComputedStyle(line).lineHeight)),
        };
      }),
    };
  });
}

// spec 44084 §2.2 Empty: an empty card is its head and one line on the title's column, and no row stretches it
for (const width of [1440, 1920]) {
  test(`every empty instrumentation card is its head and one line on the title's column, never stretched, at ${width}px`, async () => {
    await withInstrumentationPage(width, async (page) => {
      const { cards, stretchedEmptyCount } = await readEmptyCards(page);

      assert.equal(cards.length, EMPTY_CARD_COUNT, `${width}px: every gauge with nothing to show renders its empty line`);
      assert.equal(stretchedEmptyCount, 0, `${width}px: a stretched row holds an empty card`);
      for (const card of cards) {
        assert.ok(Math.abs(card.lineLeft - card.titleLeft) <= 1, `${width}px: "${card.title}" line opens at ${card.lineLeft}, title at ${card.titleLeft}`);
        assert.ok(Math.abs(card.height - card.expectedHeight) <= 1, `${width}px: "${card.title}" is ${card.height} tall, head and one line make ${card.expectedHeight}`);
      }
    }, EMPTY_SUGGESTIONS, {});
  });
}

// 1280 is the narrowest width where the empty cards sit in half columns
test("every empty instrumentation line reads on one line at 1280px", async () => {
  await withInstrumentationPage(1280, async (page) => {
    const { cards } = await readEmptyCards(page);

    assert.equal(cards.length, EMPTY_CARD_COUNT, "every gauge with nothing to show renders its empty line");
    for (const card of cards) assert.equal(card.lineCount, 1, `"${card.title}" wraps onto ${card.lineCount} lines`);
  }, EMPTY_SUGGESTIONS, {});
});
