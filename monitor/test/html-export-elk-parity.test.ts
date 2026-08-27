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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { type HTMLElement, parse as parseHtml } from "node-html-parser";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import { resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
import {
  ELK_LOADER_PATH,
  EXPORT_SCREEN,
  HtmlExportError,
  loadExportAsset,
  MERMAID_CONFIG_PATH,
  renderSelfContainedHtml,
} from "../src/server/clauded-docs/html-export.js";
import { getMermaidThemeValue } from "./lib/mermaid-config-source.js";
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

// C4 만이 폭을 화면에서 읽는다 — mermaid 11 의 C4 렌더러는 행 줄바꿈 한계를
// `screen.availWidth` 에서 가져오므로(c4Diagram-*.mjs), 화면 기준이 다른 두 경로는
// 같은 소스를 다른 행수로 눕힌다. 나머지 타입은 이 상수를 읽지 않는다.
const C4_SRC =
  "C4Context\n" +
  "  title System map document export boundary\n" +
  '  Person(operator, "Monitor operator", "Reads exported documents offline")\n' +
  '  System(monitor, "Monitor service", "Serves stored documents and diagrams")\n' +
  '  Rel(operator, monitor, "reads exported documents")';

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
  // 화면 기준을 명시 — 아래 AC-5 의 비교 대상은 아니지만, 하네스가 기준을 선언하지 않으면
  // 그 값은 Playwright 기본값이 되어 어느 문서에도 적히지 않은 수가 배치를 정한다.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    screen: { ...EXPORT_SCREEN },
  });
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

    // 설정 SoT 에서 직접 읽은 값 — 색을 테스트에 적어두면 그 사본이 드리프트한다.
    const nodeFill = getMermaidThemeValue("mainBkg");
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

// ── AC-5 C4 행 기준 ──────────────────────────────────────────────────────────
// C4 는 행 줄바꿈 한계를 `screen.availWidth` 에서 읽는 유일한 채택 타입이다. 그 값을 아무도
// 선언하지 않으면 두 경로가 각자 다른 기본값 위에서 같은 소스를 다른 행수로 눕히고, 그 차이는
// 폭 한 값으로 남는다 — 내보내기 화면폭을 480 으로 두면 2행 551px, 1280 으로 두면 1행 873px.
//
// 비교 대상이 위 index.html 하네스가 아닌 이유(측정): 그 하네스는 mermaid 를 CDN 의
// `mermaid@11`(현재 11.17.2)에서 받고 문서가 `lang="en"` 이라, 같은 화면 기준에서도 832px 로
// 떨어진다(고정 11.15.0 · `lang="ko"` 인 내보내기는 873px). px 대조를 거기에 걸면 재는 것은
// 행 기준이 아니라 빌드·서체 드리프트가 된다. 그래서 여기 비교 대상은 나머지 입력(고정 드라이버 ·
// 벤더 ELK 로더 · 공유 설정 · 문서 lang)을 내보내기와 똑같이 맞춘 뷰어 렌더 경로다.

/** 내보내기가 주입하는 것과 같은 세 자산 — 같은 파일에서 읽어야 대조에 화면 기준만 남는다. */
async function loadDriverAssets(): Promise<{ mermaid: string; elk: string; config: string }> {
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  return {
    mermaid: await loadExportAsset(
      resolve(dirname(pkgPath), "dist", "mermaid.min.js"),
      "mermaid driver bundle",
    ),
    elk: await loadExportAsset(ELK_LOADER_PATH, "elk layout loader"),
    config: await loadExportAsset(MERMAID_CONFIG_PATH, "mermaid config"),
  };
}

/** 저장 본문과 같은 문서 껍데기 — lang 이 갈리면 서체 대체가 갈려 C4 텍스트 폭이 움직인다. */
const VIEWER_SHELL =
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>c4</title></head>' +
  "<body><main></main></body></html>";

/** 산출물의 <svg> 폭 속성. useMaxWidth 가 꺼져 있어 이 값이 곧 고유폭이다. */
function getExportedSvgWidth(html: string, context: string): number {
  const svg = getExportedRoot(html).querySelector("svg");
  assert.ok(svg !== null, `${context}: <svg> 가 없어 폭 대조가 공허함`);
  const raw = svg.getAttribute("width");
  const width = Number(raw);
  assert.ok(Number.isFinite(width) && width > 0, `${context}: 쓸 수 있는 width 속성이 없음 — ${String(raw)}`);
  return width;
}

/**
 * 뷰어 렌더 경로에서 같은 소스를 그린 폭. 뷰포트는 일부러 좁게 둔다 — 폭이 뷰포트가 아니라
 * 선언된 화면에서 나온다는 것이 요점이고, 뷰포트 480/1280 이 같은 값을 내는 것은 재서 확인했다.
 */
async function measureViewerC4(browser: Browser): Promise<{ width: number; availWidth: number }> {
  const assets = await loadDriverAssets();
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    screen: { ...EXPORT_SCREEN },
  });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setContent(VIEWER_SHELL, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: assets.mermaid });
    await page.addScriptTag({ content: assets.elk });
    await page.addScriptTag({ content: assets.config });

    const measured = await page.evaluate(async (source: string) => {
      const w = window as never as {
        mermaid: {
          initialize(config: unknown): void;
          registerLayoutLoaders(loaders: unknown): void;
          render(id: string, text: string): Promise<{ svg: string }>;
        };
        mermaidLayoutElk?: { default?: unknown };
        MERMAID_CONFIG: unknown;
      };
      // index.html 과 같은 순서 — 등록이 initialize 보다 먼저.
      w.mermaid.registerLayoutLoaders(w.mermaidLayoutElk?.default ?? []);
      w.mermaid.initialize(w.MERMAID_CONFIG);
      const { svg } = await w.mermaid.render("parity-c4", source);
      const host = document.createElement("div");
      host.innerHTML = svg;
      document.body.appendChild(host);
      return {
        width: Number(host.querySelector("svg")?.getAttribute("width") ?? Number.NaN),
        availWidth: window.screen.availWidth,
      };
    }, C4_SRC);

    assert.ok(
      Number.isFinite(measured.width) && measured.width > 0,
      `뷰어 하네스가 C4 를 그리지 못함 — width ${String(measured.width)}`,
    );
    return measured;
  } finally {
    await page.close();
    await context.close();
  }
}

describe("the C4 row basis is declared, not inherited", () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser.close();
    await resetBrowserForTests();
  });

  test("AC-5 export and viewer draw the C4 fixture at the same width under one declared screen", async () => {
    const exported = await renderSelfContainedHtml(getStoredBody("c4", C4_SRC), "html");
    const exportWidth = getExportedSvgWidth(exported, "C4 내보내기");
    const viewer = await measureViewerC4(browser);

    // 하네스가 화면 옵션을 잃으면 뷰포트 폭이 그 자리를 대신해 대조가 조용히 다른 것을 잰다.
    assert.equal(
      viewer.availWidth,
      EXPORT_SCREEN.width,
      "뷰어 하네스에 선언한 화면폭이 페이지에 닿지 않음 — 대조가 다른 기준 위에 서 있음",
    );
    assert.ok(
      Math.abs(exportWidth - viewer.width) <= 1,
      `C4 폭이 갈림 — 내보내기 ${exportWidth}px · 뷰어 ${viewer.width}px ` +
        `(선언 화면폭 ${EXPORT_SCREEN.width}). 두 경로가 서로 다른 행수로 눕혔다는 뜻이다.`,
    );
  });
});
