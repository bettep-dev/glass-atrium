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
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
const MONITOR_ROOT = resolve(HERE, "..");
const PUBLIC_ROOT = resolve(MONITOR_ROOT, "public");

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

// P1-F1 AC2 의 대조 대상 — 관계 둘짜리 최소 ER. C4 처럼 화면을 읽지는 않지만, 뷰어와 내보내기가
// 같은 설정·같은 화면 기준 위에서 같은 폭으로 눕는지는 타입마다 따로 재야 확인된다.
const ER_SRC =
  "erDiagram\n" +
  '  OUTCOME_RECORD ||--o{ CORRECTION_SIGNAL : "produces on revision"\n' +
  '  OUTCOME_RECORD }o--|| AGENT_REGISTRY_ENTRY : "emitted by agent"';

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

  // The vendored bundle now arrives on the first window.ensureElkLayout() call, and the viewer's
  // render paths await that promise before mermaid.render. This harness calls mermaid.render
  // directly rather than through those components, so it has to reproduce their precondition —
  // without it the comparison below measures a dagre render against an ELK export and calls the
  // difference a parity failure. That the components DO await is pinned on their source in
  // test/mermaid-elk.vendor-pin.unit.test.ts, and that awaiting is what removes the fallback
  // warning is measured in test/mermaid-elk.loader.test.ts.
  const prepReady = await page.evaluate(async () => {
    const w = window as never as { ensureElkLayout?: () => Promise<void> };
    if (typeof w.ensureElkLayout !== "function") return false;
    await w.ensureElkLayout();
    return true;
  });
  assert.equal(
    prepReady,
    true,
    "the shipped page assigned no window.ensureElkLayout — index.html must load mermaid-elk-loader.js",
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

// ── AC-6 드라이버 버전을 읽는 시점 ────────────────────────────────────────────
// 이 모듈은 서버 부팅 경로에서 임포트된다(routes/clauded-docs.ts → registerRoutes → main.ts).
// 그래서 모듈 최상위에서 디스크를 읽으면 mermaid 패키지 하나가 사라졌을 때 첫 내보내기가 아니라
// 부팅이 죽고, launchd 는 그것을 재시작 루프로 갚는다 — 내보내기 전제 미충족을 치명적이지 않게
// 두는 main.ts 의 설계와 반대 방향이다. 그래서 판정은 두 다리를 한 번에 재야 한다: 임포트는 살아남고,
// 내보내기는 여전히 소리 내어 실패한다.
//
// 자식 프로세스인 이유: 해석은 모듈이 실려 있기 전에 깨져 있어야 하고, `import.meta.resolve` 는
// 등록된 resolve 훅이 답한다(node 24 에서 확인). 같은 프로세스 안에서는 그 순서를 만들 수 없다.
const EXPORT_MODULE_URL = pathToFileURL(
  resolve(MONITOR_ROOT, "src/server/clauded-docs/html-export.ts"),
).href;

/** 자식이 실행할 스크립트 — 훅을 등록하고, 임포트와 내보내기를 각각 표식으로 남긴다. */
const UNRESOLVABLE_MERMAID_PROBE = [
  'import { register } from "node:module";',
  'const hook =',
  '  "export function resolve(specifier, context, nextResolve) {" +',
  `  "  if (specifier === 'mermaid/package.json') {" +`,
  `  "    throw new Error('stubbed: mermaid package is unresolvable');" +`,
  '  "  }" +',
  '  "  return nextResolve(specifier, context);" +',
  '  "}";',
  'register("data:text/javascript," + encodeURIComponent(hook));',
  'let mod;',
  'try {',
  '  mod = await import(process.env.EXPORT_MODULE_URL);',
  '} catch (error) {',
  '  console.log(`IMPORT_THREW ${error?.message}`);',
  '  process.exit(0);',
  '}',
  'console.log("IMPORT_OK");',
  'try {',
  '  mod.stripCdnScriptsAndFonts("<!doctype html><html><head></head><body></body></html>");',
  '  console.log("EXPORT_RETURNED");',
  '} catch (error) {',
  '  console.log(`EXPORT_THREW ${error?.name} stage=${error?.stage}`);',
  '}',
].join("\n");

/** 표식만 돌려줌 — 자식의 stderr 는 tsx 잡음을 실을 수 있어 판정 대상이 아니다. */
async function runUnresolvableMermaidProbe(): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", UNRESOLVABLE_MERMAID_PROBE],
    { cwd: MONITOR_ROOT, env: { ...process.env, EXPORT_MODULE_URL } },
  );
  return stdout;
}

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

  test("AC-6 an unresolvable mermaid package fails the export, not the module import", async () => {
    const output = await runUnresolvableMermaidProbe();
    assert.match(
      output,
      /^IMPORT_OK$/m,
      `importing the export module read the mermaid package off disk, so a missing package takes the ` +
        `whole server down at boot instead of failing the first export: ${output}`,
    );
    assert.match(
      output,
      /^EXPORT_THREW HtmlExportError stage=mermaid$/m,
      `the export did not fail loudly once the version was unreadable: ${output}`,
    );
  });
});

// ── AC-5 C4 행 기준 ──────────────────────────────────────────────────────────
// C4 는 행 줄바꿈 한계를 `screen.availWidth` 에서 읽는 유일한 채택 타입이다. 그 값을 아무도
// 선언하지 않으면 두 경로가 각자 다른 기본값 위에서 같은 소스를 다른 행수로 눕히고, 그 차이는
// 폭 한 값으로 남는다 — 내보내기 화면폭을 480 으로 두면 2행 551px, 1280 으로 두면 1행 873px.
//
// 비교 대상이 위 index.html 하네스가 아닌 이유(측정): 엔진 차이는 이제 없다 — index.html 은
// 내보내기가 주입하는 것과 같은 11.15.0 을 고정한다. 남은 것은 문서의 `lang` 하나다. 그 하네스는
// `lang="en"`, 저장 본문과 내보내기는 `lang="ko"` 라 같은 화면 기준에서도 C4 가 899px 대 873px 로
// 갈린다(재서 확인). 서체는 원인이 아니다: 두 문서가 같은 서체 스택을 받고, 이 26px 은 `lang` 하나만
// 바꿔도 그대로 나타난다. px 대조를 거기에 걸면 재는 것은 행 기준이 아니라 문서 언어가 된다.
// 그래서 여기 비교 대상은 나머지 입력(고정 드라이버 · 벤더 ELK 로더 · 공유 설정 · 문서 lang)을
// 내보내기와 똑같이 맞춘 뷰어 렌더 경로다.

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
 * 타입을 인자로 받는 이유: 화면 기준을 읽는 것은 C4 뿐이어도, 두 경로가 같은 폭을 내는지는
 * 타입마다 따로 재야 한다(P1-F1 AC2 의 ER 다리).
 */
async function measureViewerDiagram(
  browser: Browser,
  id: string,
  source: string,
): Promise<{ width: number; availWidth: number }> {
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

    const measured = await page.evaluate(async (args: { id: string; source: string }) => {
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
      const { svg } = await w.mermaid.render(args.id, args.source);
      const host = document.createElement("div");
      host.innerHTML = svg;
      document.body.appendChild(host);
      return {
        width: Number(host.querySelector("svg")?.getAttribute("width") ?? Number.NaN),
        availWidth: window.screen.availWidth,
      };
    }, { id, source });

    assert.ok(
      Number.isFinite(measured.width) && measured.width > 0,
      `뷰어 하네스가 ${id} 를 그리지 못함 — width ${String(measured.width)}`,
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
    const viewer = await measureViewerDiagram(browser, "parity-c4", C4_SRC);

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

  // P1-F1 AC2 — 지금까지 이 폭 일치는 픽스처 주석에 손으로 적힌 수(454.92)로만 남아 있었다.
  // 주석은 다음 판올림에서 조용히 틀려지지만 단언은 붉어진다.
  test("AC-5 export and viewer draw the erDiagram fixture at the same width", async () => {
    const exported = await renderSelfContainedHtml(getStoredBody("er", ER_SRC), "html");
    const exportWidth = getExportedSvgWidth(exported, "ER 내보내기");
    const viewer = await measureViewerDiagram(browser, "parity-er", ER_SRC);

    assert.ok(
      Math.abs(exportWidth - viewer.width) <= 1,
      `ER 폭이 갈림 — 내보내기 ${exportWidth}px · 뷰어 ${viewer.width}px ` +
        `(선언 화면폭 ${EXPORT_SCREEN.width}). 같은 소스가 두 경로에서 다르게 눕었다는 뜻이다.`,
    );
  });
});
