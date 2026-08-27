// P1-2 — what the HTML export actually draws, measured on its own output.
// Runner: npx tsx --test test/html-export-elk-parity.test.ts
//
// A layout claim is empty without a control: an unregistered layout still renders, on
// dagre, so "it exported" proves nothing. Four claims here, none covering another — the
// exported edges are orthogonal where the dagre control's are diagonal, the viewer draws
// the same graph from the same config, the vendored loader leaves no trace in the output,
// and a diagram whose layout is not registered fails loudly instead of shipping a silent
// dagre fallback.
//
// Prerequisites: an installed chromium for the export path, plus outbound network for the
// viewer harness (index.html loads mermaid from CDN). An unmet prerequisite fails RED in
// before().

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { type HTMLElement, parse as parseHtml } from "node-html-parser";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
import {
  HtmlExportError,
  MERMAID_CONFIG_PATH,
  loadExportAsset,
  renderSelfContainedHtml,
} from "../src/server/clauded-docs/html-export.js";
import {
  assertOrthogonalLinks,
  findDiagonalSegments,
  getRenderProbe,
  type RenderProbe,
} from "./lib/mermaid-elk-probe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

// 갈래가 있어야 두 레이아웃의 배치 차이가 좌표에 남는다.
const FLOWCHART_SRC = "flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A";

// 채택 7타입 중 flowchart 가 아닌 하나 — 전역 layout 이 다른 타입을 깨지 않는지가 요점.
const STATE_SRC = "stateDiagram-v2\n  Queued --> Running\n  Running --> Done";

// 렌더러가 엣지에 붙이는 클래스는 타입마다 다르다 — 한 판정기를 두 타입 위에 올리기 위한 합집합.
const EDGE_SELECTOR = "path.flowchart-link, path.transition";

/** ADR-2 한 줄 지시자 — 물리적 1줄 · JSON 인용 키. */
function getDirectedSource(layout: string, source: string): string {
  return `%%{init: {"layout": "${layout}"}}%%\n${source}`;
}

/** 저장된 문서 모양 그대로 — `<pre class="mermaid">` 하나, 동작하는 init 스크립트 없음. */
function getStoredBody(salt: string, source: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    `<head><meta charset="utf-8"><title>${salt}</title></head>` +
    `<body><main><pre class="mermaid">${source}</pre></main></body>` +
    "</html>"
  );
}

/** 기본 옵션에서 `<pre>` 안쪽은 원문 텍스트로 남아 렌더된 SVG 가 DOM 에 잡히지 않는다. */
function getExportedRoot(html: string): HTMLElement {
  return parseHtml(html, { blockTextElements: { script: true, style: true } });
}

function getExportedLinks(html: string, selector: string): string[] {
  return getExportedRoot(html)
    .querySelectorAll(selector)
    .map((node) => node.getAttribute("d") ?? "");
}

/** 설정 SoT 에서 직접 읽은 값 — 색을 테스트에 적어두면 그 사본이 드리프트한다. */
function getThemeValue(key: string): string {
  const windowStub: Record<string, unknown> = {};
  new Function("window", readFileSync(MERMAID_CONFIG_PATH, "utf8"))(windowStub);
  const config = windowStub.MERMAID_CONFIG as { themeVariables: Record<string, string> };
  const value = config.themeVariables[key];
  assert.ok(value, `the shared config must define themeVariables.${key}`);
  return value;
}

interface ViewerHarness {
  app: FastifyInstance;
  browser: Browser;
  page: Page;
}

/** index.html 을 배포된 그대로 띄운다 — 비교 대상은 뷰어의 실제 배선이어야 한다. */
async function openViewerHarness(): Promise<ViewerHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: PUBLIC_ROOT, prefix: "/", index: ["index.html"] });
  await app.ready();
  const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${serverUrl}/`, { waitUntil: "load" });

  const runtimeReady = await page
    .waitForFunction(() => Boolean((window as never as { mermaid?: unknown }).mermaid), null, {
      timeout: 30_000,
    })
    .then(
      () => true,
      () => false,
    );
  assert.equal(
    runtimeReady,
    true,
    "page-level network prerequisite unmet — the mermaid CDN runtime did not load",
  );
  return { app, browser, page };
}

describe("html export under the shared config", () => {
  let elkHtml: string;
  let dagreHtml: string;
  let stateHtml: string;
  let elkLinks: string[];
  let viewer: ViewerHarness;
  let viewerProbe: RenderProbe;

  before(async () => {
    elkHtml = await renderSelfContainedHtml(getStoredBody("elk", FLOWCHART_SRC), "html");
    dagreHtml = await renderSelfContainedHtml(
      getStoredBody("dagre", getDirectedSource("dagre", FLOWCHART_SRC)),
      "html",
    );
    stateHtml = await renderSelfContainedHtml(getStoredBody("state", STATE_SRC), "html");
    elkLinks = getExportedLinks(elkHtml, EDGE_SELECTOR);

    viewer = await openViewerHarness();
    viewerProbe = await getRenderProbe(viewer.page, "parity-flowchart", FLOWCHART_SRC);
  });

  after(async () => {
    await viewer?.browser?.close();
    await viewer?.app?.close();
    await resetBrowserForTests();
  });

  test("AC-1 the exported flowchart edges carry no cubic command", () => {
    assert.ok(elkLinks.length > 0, "the export produced no edge path — the verdict would be vacuous");
    assert.deepStrictEqual(
      elkLinks.filter((d) => d.includes("C")),
      [],
      "exported edges are cubic — the render fell back to a curve-drawing layout",
    );
  });

  test("AC-1 the exported flowchart edges are orthogonal under the ADR-3 verdict", () => {
    assertOrthogonalLinks(elkLinks, "flowchart export under the shared config");
  });

  test("AC-1 the dagre control draws the same source diagonally", () => {
    const control = getExportedLinks(dagreHtml, EDGE_SELECTOR);
    assert.notDeepStrictEqual(control, elkLinks, "the control matched the ELK export — the layout request never reached ELK");
    assert.ok(
      findDiagonalSegments(control, "dagre control export").length > 0,
      "the control has no diagonal segment — it cannot certify that the ELK verdict means anything",
    );
  });

  test("AC-1 a non-flowchart adopted type exports under the same verdict", () => {
    assert.ok(stateHtml.includes("<svg"), "the state diagram produced no <svg>");
    const links = getExportedLinks(stateHtml, EDGE_SELECTOR);
    assert.ok(links.length > 0, "the state diagram produced no edge path — the verdict would be vacuous");
    assert.deepStrictEqual(links.filter((d) => d.includes("C")), [], "state-diagram edges are cubic");
    assertOrthogonalLinks(links, "stateDiagram-v2 export under the shared config");
  });

  test("AC-2 the exported document carries no script, vendored or otherwise", () => {
    for (const [label, html] of [["flowchart", elkHtml], ["state", stateHtml]] as const) {
      assert.equal(getExportedRoot(html).querySelectorAll("script").length, 0, `${label}: <script> survived the strip pass`);
      assert.equal(html.includes("mermaidLayoutElk"), false, `${label}: the vendored loader survived the strip pass`);
    }
  });

  test("AC-3 the viewer draws the same graph from the same config", async () => {
    assert.equal(
      getExportedRoot(elkHtml).querySelectorAll("g.node").length,
      Object.keys(viewerProbe.nodes).length,
      "export and viewer disagree on node count",
    );
    assert.equal(elkLinks.length, viewerProbe.links.length, "export and viewer disagree on edge count");
    assertOrthogonalLinks(viewerProbe.links, "flowchart in the viewer");

    const nodeFill = getThemeValue("mainBkg");
    const viewerSvg = await viewer.page.evaluate(
      (id: string) => document.querySelector(id)?.innerHTML ?? "",
      "#probe-host-parity-flowchart",
    );
    assert.ok(elkHtml.includes(nodeFill), `export lost the shared node fill ${nodeFill}`);
    assert.ok(viewerSvg.includes(nodeFill), `viewer lost the shared node fill ${nodeFill}`);
  });
});

describe("html export loud-fail", () => {
  after(async () => {
    await resetBrowserForTests();
  });

  test("AC-4 a layout the page never registered fails the export instead of falling back", async () => {
    await assert.rejects(
      renderSelfContainedHtml(
        getStoredBody("unregistered", getDirectedSource("no-such-layout", FLOWCHART_SRC)),
        "html",
      ),
      (error: unknown) =>
        error instanceof HtmlExportError &&
        error.stage === "mermaid" &&
        /not registered/.test(error.message),
      "an unregistered layout exported silently on dagre",
    );
  });

  test("AC-4 a missing page asset fails the export instead of skipping the injection", async () => {
    await assert.rejects(
      loadExportAsset(resolve(PUBLIC_ROOT, "assets", "vendor", "absent.min.js"), "elk layout loader"),
      (error: unknown) => error instanceof HtmlExportError && error.stage === "mermaid",
    );
  });
});
