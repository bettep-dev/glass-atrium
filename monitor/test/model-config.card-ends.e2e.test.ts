// E2E chromium check for the Models & budgets screen (screens/model-config.jsx): the model card and the
// caps + tiers stack end together, which a node render cannot measure.
//
// Runner: npx tsx --test test/model-config.card-ends.e2e.test.ts
// Prereqs (unmet → RED, no skip guard): `npm run build:jsx`, installed chromium, CDN network.
// App: stripped Fastify serving the config below; every other /api read answers empty.

import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");
const MODEL = "claude-opus-5-5";

function getModelRow(domain: string, files?: string[]) {
  return {
    domain,
    desired: MODEL,
    actual: MODEL,
    drift: false,
    apply_mode: domain === "model.daemon_cycle_worker" ? "next-cycle" : "next-spawn",
    editable: true,
    pricing_known: true,
    ...(files ? { files: files.map((file) => ({ file, model: MODEL })) } : {}),
  };
}

// the shipped roster: seven model tiers, two caps, four call tiers, one saved cap among them
const CONFIG = {
  domains: [
    getModelRow("model.dev", ["glass-atrium-dev-front.md", "glass-atrium-dev-react.md"]),
    getModelRow("model.research"),
    getModelRow("model.meta"),
    getModelRow("model.wiki"),
    getModelRow("model.review", ["glass-atrium-qa-code-reviewer.md", "glass-atrium-qa-debugger.md"]),
    getModelRow("model.docs", ["glass-atrium-intel-reporter.md", "glass-atrium-intel-planner.md"]),
    getModelRow("model.daemon_cycle_worker"),
  ],
  budgets: ["budget.worker_max_usd", "budget.pre_verify_max_usd"].map((domain) => ({
    domain,
    desired: "10.00",
    actual: "10.00",
    drift: false,
    apply_mode: "next-cycle",
  })),
  tiers: [
    "tier.worker_effort",
    "tier.pre_verify_effort",
    "tier.worker_max_output_tokens",
    "tier.pre_verify_max_output_tokens",
  ].map((domain) => ({ domain, desired: null, actual: null, file_error: null, drift: false, apply_mode: "next-cycle" })),
  known_models: [MODEL],
  daemon_config_sync: "ok",
};

// side-by-side widths only — below 1280 the row stacks and has no shared end edge
for (const width of [1440, 1920]) {
  test(`the model card and the caps + tiers stack end within one row of each other at ${width}px`, async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
    app.get("/api/model-config", async () => CONFIG);
    app.get("/api/*", async () => ({ rows: [] }));
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${serverUrl}/#model-config`, { waitUntil: "load" });
      await page.waitForSelector(".split-row .split-col table tbody tr td input", { timeout: 30_000 });
      const ends = await page.evaluate(() => {
        const row = document.querySelector(".split-row")!;
        const lead = row.children[0].querySelector(".card")!.getBoundingClientRect();
        const stack = [...row.children[1].querySelectorAll(".card")].map((card) => card.getBoundingClientRect());
        return {
          rowPx: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")),
          isSideBySide: stack.every((box) => box.left >= lead.right),
          leadBottom: lead.bottom,
          stackBottom: Math.max(...stack.map((box) => box.bottom)),
        };
      });

      assert.ok(ends.rowPx > 0, "the row-height token resolves");
      assert.ok(ends.isSideBySide, `${width}px: the stack sits beside the model card`);
      const gap = Math.abs(ends.leadBottom - ends.stackBottom);
      assert.ok(gap <= ends.rowPx, `${width}px: ends ${gap}px apart, more than one ${ends.rowPx}px row`);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}
