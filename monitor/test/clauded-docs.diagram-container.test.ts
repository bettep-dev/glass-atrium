// 문서 본문 다이어그램의 폭 기제 시험 (AC-T22 (a)(b)).
// 실행: npx tsx --test test/clauded-docs.diagram-container.test.ts
//
// 폭의 1차 결정자는 컨테이너 CSS 가 아니라 mermaid 의 useMaxWidth 임 — 참이면
// 산출 <svg> 에 인라인 max-width 를 직접 찍어 컨테이너 규칙을 무력화함. 따라서
// 두 다리를 모두 실제 렌더 산출물에서 잼:
//   (a) 컨테이너보다 넓은 다이어그램에서 가로 스크롤이 생기고 잘리지 않음
//   (b) 산출 <svg> 에 폭을 묶는 인라인 max-width 가 남지 않음
//
// 두 경로는 init 을 공유하지 않으므로 각각 잼 — 뷰어는 public/index.html 의
// 인라인 init + clauded-docs.jsx 의 인라인 <style> 을 원문에서 뽑아 재구성하고,
// 내보내기는 renderSelfContainedHtml 을 그대로 돌림(DB 불요).
//
// 픽스처 집합은 diagram-types.json 의 채택 목록에서 파생됨 — flowchart 만 덮고
// 나머지 채택 타입이 깨진 채로 초록이 되는 것을 구조적으로 막음.
//
// 같은 이유로 축이 하나 더 있음 — 저장 본문의 포맷. 픽스처가 전부 html 본문(pre.mermaid 를
// 이미 실은 모양)이던 동안 md 본문의 ``` mermaid 펜스는 어느 시험도 지나지 않았고, 뷰어는
// 그 펜스를 코드 블록으로 그리면서 이 파일은 초록이었음. 두 포맷을 같은 표에서 돌려 그
// 구멍을 닫음 — 타입 하나가 한쪽 포맷에서만 깨지는 것도 여기서 붉어짐.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { marked } from "marked";
import { chromium, type Browser } from "playwright";

import { EXPORT_SCREEN, renderSelfContainedHtml } from "../src/server/clauded-docs/html-export.js";
import { resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
// 뷰어가 initialize 에 넘기는 설정 — 공유 SoT 파일을 그대로 평가해 걷어옴(사본 금지).
// index.html 이 이 전역을 넘긴다는 배선 자체는 mermaid-config.tokens.test.ts 소유.
import { evaluateMermaidConfig } from "./lib/mermaid-config-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const VENDOR_ELK_PATH = resolve(MONITOR_ROOT, "public/assets/vendor/mermaid-layout-elk-0.2.3.min.js");
const VIEWER_SCREEN_PATH = resolve(MONITOR_ROOT, "public/src/screens/clauded-docs.jsx");
const DECLARATION_PATH = resolve(MONITOR_ROOT, "src/server/clauded-docs/diagram-types.json");

// 좁은 뷰포트 — 아래 픽스처가 전부 컨테이너보다 넓어지도록 고른 폭.
const NARROW_VIEWPORT_WIDTH = 480;

interface DiagramTypesDeclaration {
  adopted: { type: string }[];
}

// 채택 타입별 픽스처 — 라벨을 길게 잡아 좁은 컨테이너를 반드시 넘기게 함.
const FIXTURES = new Map<string, string>([
  [
    "flowchart",
    "flowchart LR\n" +
      "  A[Orchestrator delegation gate decision] --> B[Reviewer verdict aggregation step]\n" +
      "  B --> C[Implementation entry with acceptance criteria]",
  ],
  [
    "sequenceDiagram",
    "sequenceDiagram\n" +
      "  participant Orchestrator as Orchestrator control plane\n" +
      "  participant Reviewer as Reviewer verdict producer\n" +
      "  Orchestrator->>Reviewer: request plan direction verification\n" +
      "  Reviewer-->>Orchestrator: pass with unmet item list",
  ],
  [
    "stateDiagram-v2",
    "stateDiagram-v2\n" +
      "  direction LR\n" +
      "  [*] --> AwaitingPlanDirectionVerification\n" +
      "  AwaitingPlanDirectionVerification --> ImplementationEntryGranted\n" +
      "  ImplementationEntryGranted --> ReconciliationBothDirections\n" +
      "  ReconciliationBothDirections --> [*]",
  ],
  [
    "erDiagram",
    // 두 관계짜리 원본은 ELK 아래에서 455px 로 떨어져 뷰어 컨테이너(382px)는 넘고 내보내기
    // 컨테이너(464px)는 못 넘었음 — 두 기준 사이에 낀 폭이라 한쪽 다리만 조용히 초록이 됨.
    // 관계를 넷으로 늘려 두 컨테이너 모두에서 확실히 넘기게 함.
    "erDiagram\n" +
      '  OUTCOME_RECORD ||--o{ CORRECTION_SIGNAL : "produces on revision"\n' +
      '  OUTCOME_RECORD }o--|| AGENT_REGISTRY_ENTRY : "emitted by agent"\n' +
      '  AGENT_REGISTRY_ENTRY ||--o{ DELEGATION_SCOPE_DECLARATION : "declares files and deliverable"\n' +
      '  CORRECTION_SIGNAL }o--|| DIRECTIVE_HINT_DISTILLATION : "distilled to one English line"',
  ],
  [
    "classDiagram",
    "classDiagram\n" +
      "  direction LR\n" +
      "  class OutcomeRecordWriter {\n" +
      "    +setTranscript(payload: CompletionPayload)\n" +
      "    +getCompletionBlock(): CompletionBlock\n" +
      "  }\n" +
      "  class CorrectionSignalAggregator {\n" +
      "    +putDirectiveHint(hint: DistilledLesson)\n" +
      "  }\n" +
      "  OutcomeRecordWriter --> CorrectionSignalAggregator : emits distilled lesson",
  ],
  [
    "gitGraph",
    // 730px 렌더 — 내보내기 컨테이너(464px) 대비 +266px · 뷰어 컨테이너(382px) 대비 +348px.
    "gitGraph\n" +
      '  commit id: "wave-one-integration-landed"\n' +
      "  branch feature/diagram-container-width\n" +
      '  commit id: "diagram-container-width-rules"\n' +
      '  commit id: "per-type-use-max-width-off"\n' +
      "  checkout main\n" +
      "  merge feature/diagram-container-width\n" +
      '  commit id: "integration-reconcile-both-directions"\n' +
      "  branch feature/gitgraph-fixture-margin\n" +
      '  commit id: "gitgraph-fixture-widened"\n' +
      '  commit id: "export-margin-measured"\n' +
      "  checkout main\n" +
      "  merge feature/gitgraph-fixture-margin\n" +
      '  commit id: "shared-config-read-through-one-helper"',
  ],
  [
    "C4",
    "C4Context\n" +
      "  title System map document export boundary\n" +
      '  Person(operator, "Monitor operator", "Reads exported documents offline")\n' +
      '  System(monitor, "Monitor service", "Serves stored documents and diagrams")\n' +
      '  Rel(operator, monitor, "reads exported documents")',
  ],
]);

const FIXTURE_TYPES = [...FIXTURES.keys()];

/** 한 mermaid 노드에서 잰 값 — (b) 는 svgStyleAttr, (a) 는 스크롤 세 값, AC-T23 은 boxWidth. */
interface NodeMeasurement {
  type: string;
  svgPresent: boolean;
  svgStyleAttr: string;
  overflowX: string;
  scrollWidth: number;
  clientWidth: number;
  boxWidth: number;
  boxLeft: number;
  // 스크롤 컨테이너의 padding-box 왼쪽 모서리 = 스크롤 원점. scrollLeft 는 음수가 될 수
  // 없으므로 이 지점보다 왼쪽에 놓인 내용은 어떤 스크롤로도 닿지 않음.
  originLeft: number;
}

/** 라벨과 뷰포트는 다리마다 다름 — 기본값은 AC-T22 의 채택 타입 전수 × 좁은 뷰포트. */
interface MeasureOptions {
  labels?: readonly string[];
  viewportWidth?: number;
  /** 스크롤 원점을 소유한 요소. 미지정이면 문서 자신의 원점(0). */
  originSelector?: string;
}

let browser: Browser;
let mermaidBundle: string;
let vendorElkBundle: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  // 뷰어와 같은 드라이버 — import.meta.resolve 로 로컬 번들을 씀(네트워크 불요).
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  mermaidBundle = await readFile(resolve(dirname(pkgPath), "dist", "mermaid.min.js"), "utf8");
  // 공유 설정이 layout:'elk' 를 요구하므로 로더도 뷰어와 같이 실려야 함 — 없으면 렌더가 throw 한다.
  vendorElkBundle = await readFile(VENDOR_ELK_PATH, "utf8");
});

after(async () => {
  await browser.close();
  await resetBrowserForTests();
});

/** clauded-docs.jsx 의 인라인 <style> 템플릿 리터럴 본문. */
function getViewerDocBodyCss(): string {
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  const open = jsx.indexOf("<style>{`");
  const close = jsx.indexOf("`}</style>", open);
  assert.ok(open !== -1 && close !== -1, "clauded-docs.jsx 의 인라인 <style> 블록을 찾지 못함");
  return jsx.slice(open + "<style>{`".length, close);
}

const TYPE_NODES = FIXTURE_TYPES.map(
  (type) => `<pre class="mermaid" data-type="${type}"></pre>`,
).join("");

/** 문서가 다이어그램을 실어 나르는 두 1차 포맷. */
const PRIMARY_FORMATS = ["html", "md"] as const;
type PrimaryFormat = (typeof PRIMARY_FORMATS)[number];

const FIXTURE_SOURCES = FIXTURE_TYPES.map((type) => FIXTURES.get(type) as string);

/** 위 표 하나에서 파생한 포맷별 저장 본문 — 두 포맷이 같은 다이어그램을 실음. */
function buildStoredBody(format: PrimaryFormat): string {
  if (format === "md") {
    return `${FIXTURE_SOURCES.map((source) => `\`\`\`mermaid\n${source}\n\`\`\``).join("\n\n")}\n`;
  }
  const blocks = FIXTURE_SOURCES.map((source) => `<pre class="mermaid">${source}</pre>`).join("");
  return (
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>diagram width</title>' +
    `</head><body><main>${blocks}</main></body></html>`
  );
}

/**
 * 뷰어의 md→html 클래스 주입기 — 사본이 아니라 clauded-docs.jsx 원문에서 잘라 씀
 * (같은 파일의 인라인 <style> 을 걷어오는 getViewerDocBodyCss 와 같은 기법).
 * 사본이면 배포된 뷰어가 깨진 동안에도 초록이 됨 — 그게 이 축이 막으려는 실패임.
 */
function convertMdToViewerNodes(mdBody: string): string {
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  const name = "injectMdTypographyClassesCD";
  const open = jsx.indexOf(`function ${name}(html) {`);
  assert.notEqual(open, -1, `clauded-docs.jsx 에서 ${name} 를 찾지 못함`);
  const close = jsx.indexOf("\n}\n", open);
  assert.notEqual(close, -1, `${name} 의 열 0 닫는 중괄호를 찾지 못함`);
  const inject = new Function(`${jsx.slice(open, close + 2)}\nreturn ${name};`)() as (
    html: string,
  ) => string;
  return inject(marked.parse(mdBody, { gfm: true, breaks: false }) as string);
}

/** 뷰어 하네스에 심을 포맷별 노드 — md 는 실제 변환을 거쳐야 컨테이너가 생김. */
function buildFormatNodes(format: PrimaryFormat): string {
  return format === "html" ? TYPE_NODES : convertMdToViewerNodes(buildStoredBody("md"));
}

/** 하네스 문서 껍데기 — 두 배치가 head 와 body 바깥을 같이 씀. */
function buildHarnessDocument(css: string, body: string, headExtra = ""): string {
  return (
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
    headExtra +
    `<style>${css}</style>` +
    "</head><body>" +
    body +
    "</body></html>"
  );
}

/** 뷰어 실제 DOM 계층(wrap > inner > isolation)을 그대로 세운 하네스 문서. */
function buildViewerHarness(css: string, nodes: string = TYPE_NODES): string {
  return buildHarnessDocument(
    css,
    '<div class="detail-fullscreen"><div class="doc-fs-body-wrap">' +
      '<div class="doc-fs-body-inner"><div class="doc-body-isolation">' +
      nodes +
      "</div></div></div></div>",
  );
}

/**
 * 전체화면 뷰어의 실제 계층 — 본문 wrap 이 .doc-fs-split 의 1번 컬럼이고 그 옆에 메타
 * 레일이 있음. 그래서 본문 컬럼은 뷰포트가 아니라 (뷰포트 − 레일) 안에서 중앙에 놓임.
 * buildViewerHarness 는 레일이 없어 두 중심이 우연히 겹치므로, 뷰포트 기준 breakout 의
 * 이탈이 그 하네스에서는 보이지 않음.
 *
 * body margin 0 은 앱 셸(Tailwind preflight)과 같은 전제 — 100vw 컨테이너가 8px 밀려
 * 가로 스크롤바를 만드는 하네스 고유 잡음을 없앰.
 */
function buildFullscreenHarness(css: string, nodes: string): string {
  return buildHarnessDocument(
    css,
    '<div class="detail-fullscreen"><div class="doc-fs-container"><div class="doc-fs-body">' +
      '<div class="doc-fs-split">' +
      '<div class="doc-fs-body-wrap"><div class="doc-fs-body-inner"><div class="doc-body-isolation">' +
      nodes +
      "</div></div></div>" +
      '<aside class="doc-fs-meta-side"></aside>' +
      "</div></div></div></div>",
    "<style>body{margin:0}</style>",
  );
}

/** 페이지 안의 pre.mermaid 를 ViewerBodyCD 와 같은 방식으로 렌더한 뒤 계측. */
async function measureRenderedNodes(
  html: string,
  config: Record<string, unknown> | null,
  sources: string[] | null,
  options: MeasureOptions = {},
): Promise<NodeMeasurement[]> {
  const labels = options.labels ?? FIXTURE_TYPES;
  const originSelector = options.originSelector ?? null;

  const context = await browser.newContext({
    viewport: { width: options.viewportWidth ?? NARROW_VIEWPORT_WIDTH, height: 900 },
    // 화면은 뷰포트와 따로 선언함 — C4 는 행 줄바꿈 한계를 `screen.availWidth` 에서 읽으므로
    // (mermaid 11 c4Diagram-*.mjs), 선언하지 않으면 이 하네스의 좁은 뷰포트가 그대로 화면폭이
    // 되어 내보내기와 다른 행수로 눕는다. 내보내기가 쓰는 그 상수를 그대로 씀 — 좁은 뷰포트는
    // 넘침 다리가 요구하는 값이라 그대로 두고, 화면 기준만 두 경로에서 같게 맞춘다.
    screen: { ...EXPORT_SCREEN },
  });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    if (config !== null && sources !== null) {
      await page.addScriptTag({ content: mermaidBundle });
      await page.addScriptTag({ content: vendorElkBundle });
      const renderError = await page.evaluate(async (args) => {
        const g = globalThis as unknown as {
          mermaid?: {
            initialize: (c: unknown) => void;
            registerLayoutLoaders: (loaders: unknown) => void;
            render: (id: string, src: string) => Promise<{ svg: string }>;
          };
          mermaidLayoutElk?: { default?: unknown };
          document: { querySelectorAll: (sel: string) => ArrayLike<{ innerHTML: string }> };
        };
        const mermaid = g.mermaid;
        if (mermaid === undefined) return "window.mermaid undefined";
        try {
          // index.html 과 같은 순서 — 등록이 initialize 보다 먼저.
          mermaid.registerLayoutLoaders(g.mermaidLayoutElk?.default ?? []);
          mermaid.initialize(args.config);
          const nodes = Array.from(g.document.querySelectorAll("pre.mermaid, .mermaid"));
          for (let i = 0; i < nodes.length; i += 1) {
            const { svg } = await mermaid.render(`cd-diagram-${i}`, args.sources[i] ?? "");
            nodes[i].innerHTML = svg;
          }
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : "render threw";
        }
      }, { config, sources });
      assert.equal(renderError, null, `뷰어 하네스 렌더 실패: ${renderError}`);
    }

    return await page.evaluate((args) => {
      // 콜백은 chromium 에서 돎 — tsconfig lib 이 ES2022(DOM 없음)라 브라우저 타입은 국소 선언으로 받음.
      type DiagramNode = {
        querySelector: (sel: string) => { getAttribute: (name: string) => string | null } | null;
        getBoundingClientRect: () => { width: number; left: number };
        scrollWidth: number;
        clientWidth: number;
      };
      const g = globalThis as unknown as {
        document: {
          querySelectorAll: (sel: string) => ArrayLike<DiagramNode>;
          querySelector: (sel: string) => DiagramNode | null;
        };
        getComputedStyle: (el: DiagramNode) => { overflowX: string; borderLeftWidth: string };
      };

      const originEl =
        args.originSelector === null ? null : g.document.querySelector(args.originSelector);
      const originLeft =
        originEl === null
          ? 0
          : originEl.getBoundingClientRect().left +
            (Number.parseFloat(g.getComputedStyle(originEl).borderLeftWidth) || 0);

      const nodes = Array.from(g.document.querySelectorAll("pre.mermaid, .mermaid"));
      return nodes.map((node, i) => {
        const svg = node.querySelector("svg");
        return {
          type: args.types[i] ?? `node-${i}`,
          svgPresent: svg !== null,
          svgStyleAttr: svg?.getAttribute("style") ?? "",
          overflowX: g.getComputedStyle(node).overflowX,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          boxWidth: node.getBoundingClientRect().width,
          boxLeft: node.getBoundingClientRect().left,
          originLeft,
        };
      });
    }, { types: labels as readonly string[], originSelector });
  } finally {
    await page.close();
    await context.close();
  }
}

/**
 * 내보내기 산출물을 1회만 만들어 재사용 — 두 다리가 같은 산출물을 봐야 하고
 * chromium 왕복이 비쌈. 본문은 Tailwind CDN 미참조(CDN 대기 경로 회피).
 */
const exportedHtmlCache = new Map<PrimaryFormat, Promise<string>>();

function getExportedHtml(format: PrimaryFormat): Promise<string> {
  const cached = exportedHtmlCache.get(format);
  if (cached !== undefined) return cached;

  const rendered = renderSelfContainedHtml(buildStoredBody(format), format);
  exportedHtmlCache.set(format, rendered);
  return rendered;
}

/**
 * 채택 타입 전수를 평가하고 실패를 모아 한 번에 단언함.
 *
 * 타입마다 assert 를 때리면 첫 실패에서 끊겨 뒤의 타입은 평가조차 되지 않음 — 한 타입이
 * 깨진 동안 나머지가 초록인지 빨강인지 아무도 모르는 상태가 됨. 판정기는 실패 사유
 * 문자열 배열(빈 배열 = 통과)을 돌려주고, 여기서 전부 이어붙여 한 번만 단언함.
 */
function assertEveryType(
  measurements: NodeMeasurement[],
  leg: string,
  check: (m: NodeMeasurement) => string[],
): void {
  const failures = measurements.flatMap(check);
  assert.deepEqual(
    failures,
    [],
    `${leg}: ${measurements.length} 타입 중 ${failures.length} 건 실패\n  - ` +
      failures.join("\n  - "),
  );
}

test("픽스처 집합이 diagram-types.json 의 채택 타입을 전부 덮음", () => {
  const declaration = JSON.parse(
    readFileSync(DECLARATION_PATH, "utf8"),
  ) as DiagramTypesDeclaration;
  assert.deepEqual(
    [...FIXTURE_TYPES].sort(),
    declaration.adopted.map((entry) => entry.type).sort(),
  );
});

for (const format of PRIMARY_FORMATS) {
  test(`AC-T22(b) 뷰어[${format}]: 채택 타입 전부의 산출 <svg> 에 인라인 max-width 가 없음`, async () => {
    const measurements = await measureRenderedNodes(
      buildViewerHarness(getViewerDocBodyCss(), buildFormatNodes(format)),
      evaluateMermaidConfig(),
      FIXTURE_SOURCES,
    );

    assert.equal(measurements.length, FIXTURE_TYPES.length);
    assertEveryType(measurements, `뷰어[${format}] 인라인 max-width`, (m) => {
      if (!m.svgPresent) return [`${m.type}: <svg> 가 렌더되지 않음`];
      if (/max-width/i.test(m.svgStyleAttr)) {
        return [`${m.type}: 인라인 max-width 가 남아 있음 — style="${m.svgStyleAttr}"`];
      }
      return [];
    });
  });

  test(`AC-T22(a) 뷰어[${format}]: 넓은 다이어그램이 가로 스크롤을 얻고 잘리지 않음`, async () => {
    const measurements = await measureRenderedNodes(
      buildViewerHarness(getViewerDocBodyCss(), buildFormatNodes(format)),
      evaluateMermaidConfig(),
      FIXTURE_SOURCES,
    );

    // 길이 단언이 여기에도 있어야 함 — 컨테이너가 0 개면 아래 판정기는 돌 것이 없어
    // 조용히 초록이 됨. md 축을 처음 켰을 때 이 다리만 그렇게 통과했음.
    assert.equal(measurements.length, FIXTURE_TYPES.length);
    assertEveryType(measurements, `뷰어[${format}] 가로 스크롤`, (m) => {
      const failures: string[] = [];
      if (m.overflowX !== "auto" && m.overflowX !== "scroll") {
        failures.push(
          `${m.type}: 다이어그램 컨테이너의 overflow-x 가 ${m.overflowX} — 스크롤 컨테이너가 아님`,
        );
      }
      if (!(m.scrollWidth > m.clientWidth)) {
        failures.push(
          `${m.type}: scrollWidth(${m.scrollWidth}) 가 clientWidth(${m.clientWidth}) 를 넘지 않음 — 축소되어 스크롤이 없음`,
        );
      }
      return failures;
    });
  });

  test(`AC-T22(b) 내보내기[${format}]: 산출 HTML 의 <svg> 전부에 인라인 max-width 가 없음`, async () => {
    const measurements = await measureRenderedNodes(await getExportedHtml(format), null, null);

    assert.equal(measurements.length, FIXTURE_TYPES.length);
    assertEveryType(measurements, `내보내기[${format}] 인라인 max-width`, (m) => {
      if (!m.svgPresent) return [`${m.type}: 내보내기 산출물에 <svg> 가 없음`];
      if (/max-width/i.test(m.svgStyleAttr)) {
        return [`${m.type}: 내보내기 <svg> 에 인라인 max-width 가 남아 있음 — style="${m.svgStyleAttr}"`];
      }
      return [];
    });
  });

  test(`AC-T22(a) 내보내기[${format}]: 산출 HTML 을 열면 가로 스크롤이 생기고 잘리지 않음`, async () => {
    const measurements = await measureRenderedNodes(await getExportedHtml(format), null, null);

    assert.equal(measurements.length, FIXTURE_TYPES.length);
    assertEveryType(measurements, `내보내기[${format}] 가로 스크롤`, (m) => {
      const failures: string[] = [];
      if (m.overflowX !== "auto" && m.overflowX !== "scroll") {
        failures.push(
          `${m.type}: 내보내기 컨테이너의 overflow-x 가 ${m.overflowX} — 스크롤 컨테이너가 아님`,
        );
      }
      if (!(m.scrollWidth > m.clientWidth)) {
        failures.push(
          `${m.type}: 내보내기 scrollWidth(${m.scrollWidth}) 가 clientWidth(${m.clientWidth}) 를 넘지 않음`,
        );
      }
      return failures;
    });
  });
}

// ── AC-T23 크기 프리셋 ───────────────────────────────────────────────────────
// 세 단계(본문폭 · 넓게 · 전폭)가 서로 구분되고, 같은 단계가 내보내기 산출물에서
// 같은 폭으로 재현되는지 잼. 뷰어에서만 맞고 산출물에서 어긋나면 실패임.
//
// 폭을 px 로 직접 대조할 수 있는 근거: 아래 뷰포트에서는 본문 컬럼의 1280px 상한이
// 양쪽 모두 이김 — 뷰어는 .doc-fs-body-inner(max-width: min(90%, 1280px)), 내보내기는
// 저장 본문이 자기 컬럼을 들고 다니므로 픽스처가 같은 규칙을 씀. 두 컬럼이 같은 값이면
// 컬럼 기준 프리셋(본문폭)도 뷰포트 기준 프리셋(넓게 · 전폭)도 같은 px 로 떨어짐.

// 컬럼(1280 상한)이 뷰포트보다 확실히 좁아 세 단계가 갈라지는 폭. 480 에서는 셋 다
// 뷰포트에 눌려 구분 자체가 사라짐.
const PRESET_VIEWPORT_WIDTH = 1800;

// 뷰어 .doc-fs-body-inner 와 같은 컬럼 규칙 — 내보내기 픽스처가 이것을 그대로 씀.
const DOC_COLUMN_CSS = "width:min(90%,1280px);margin-inline:auto";

// 뷰어 .doc-fs-body-wrap 과 같은 기준 상자 — 내보내기에는 메타 레일이 없어 body 가 그 자리를
// 맡음(html-export.ts 가 body 를 질의 컨테이너로 선언). 프리셋 폭이 기준 상자에서 나오므로,
// 두 경로의 기준 상자 내용 폭이 같을 때에만 같은 프리셋이 같은 px 로 떨어짐.
const DOC_CONTAINER_CSS = "padding:24px clamp(32px,4vw,72px) 32px";

// 나열 순서가 곧 폭의 오름차순임(본문폭 < 넓게 < 전폭).
const SIZE_PRESETS = ["doc-diagram-body", "doc-diagram-wide", "doc-diagram-full"] as const;

// 반올림 오차가 아니라 실제로 다른 단계임을 요구하는 하한.
const PRESET_MIN_DELTA = 8;

// 프리셋은 타입이 아니라 컨테이너에 걸리므로 한 타입으로 충분함.
const PRESET_SOURCE = FIXTURES.get("flowchart") as string;

const PRESET_NODES = SIZE_PRESETS.map(
  (preset) => `<pre class="mermaid ${preset}"></pre>`,
).join("");

// 프리셋 계측은 브라우저 왕복이라 다리마다 한 번만 돌리고 여러 test 가 나눠 씀.
const presetCache = new Map<string, Promise<NodeMeasurement[]>>();

function getPresetMeasurements(
  key: string,
  measure: () => Promise<NodeMeasurement[]>,
): Promise<NodeMeasurement[]> {
  let cached = presetCache.get(key);
  if (cached === undefined) {
    cached = measure();
    presetCache.set(key, cached);
  }
  return cached;
}

/** 뷰어 쪽 두 배치 — 세우는 하네스와 스크롤 원점만 다르고 나머지 계측 조건은 같음. */
function measurePresetsIn(
  key: string,
  buildHarness: (css: string, nodes: string) => string,
  originSelector?: string,
): Promise<NodeMeasurement[]> {
  return getPresetMeasurements(key, () =>
    measureRenderedNodes(
      buildHarness(getViewerDocBodyCss(), PRESET_NODES),
      evaluateMermaidConfig(),
      SIZE_PRESETS.map(() => PRESET_SOURCE),
      {
        labels: SIZE_PRESETS,
        viewportWidth: PRESET_VIEWPORT_WIDTH,
        originSelector,
      },
    ),
  );
}

function measureViewerPresets(): Promise<NodeMeasurement[]> {
  return measurePresetsIn("viewer", buildViewerHarness);
}

function measureExportPresets(): Promise<NodeMeasurement[]> {
  const nodes = SIZE_PRESETS.map(
    (preset) => `<pre class="mermaid ${preset}">${PRESET_SOURCE}</pre>`,
  ).join("");
  const body =
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>diagram size presets</title>' +
    `<style>body{${DOC_CONTAINER_CSS}}.doc-column{${DOC_COLUMN_CSS}}</style></head>` +
    `<body><main class="doc-column">${nodes}</main></body></html>`;

  return getPresetMeasurements("export", () =>
    renderSelfContainedHtml(body, "html").then((html) =>
      measureRenderedNodes(html, null, null, {
        labels: SIZE_PRESETS,
        viewportWidth: PRESET_VIEWPORT_WIDTH,
      }),
    ),
  );
}

/** 프리셋 이름 → 렌더 폭. 노드 순서가 아니라 이름으로 대조하기 위함. */
function getPresetWidths(measurements: NodeMeasurement[]): Map<string, number> {
  assert.equal(measurements.length, SIZE_PRESETS.length);
  for (const m of measurements) {
    assert.ok(m.svgPresent, `${m.type}: <svg> 가 렌더되지 않음`);
  }
  return new Map(measurements.map((m) => [m.type, m.boxWidth]));
}

function assertPresetLadder(widths: Map<string, number>, path: string): void {
  for (let i = 1; i < SIZE_PRESETS.length; i += 1) {
    const narrow = widths.get(SIZE_PRESETS[i - 1]) as number;
    const wide = widths.get(SIZE_PRESETS[i]) as number;
    assert.ok(
      wide - narrow >= PRESET_MIN_DELTA,
      `${path}: ${SIZE_PRESETS[i]}(${wide}px) 가 ${SIZE_PRESETS[i - 1]}(${narrow}px) 보다 ` +
        `${PRESET_MIN_DELTA}px 이상 넓지 않음 — 두 단계가 구분되지 않음`,
    );
  }
}

test("AC-T23 뷰어: 세 프리셋의 렌더 폭이 서로 구분됨", async () => {
  assertPresetLadder(getPresetWidths(await measureViewerPresets()), "뷰어");
});

test("AC-T23 내보내기: 세 프리셋의 렌더 폭이 서로 구분됨", async () => {
  assertPresetLadder(getPresetWidths(await measureExportPresets()), "내보내기");
});

test("AC-T23: 같은 프리셋이 내보내기 산출물에서 같은 폭으로 재현됨", async () => {
  const viewer = getPresetWidths(await measureViewerPresets());
  const exported = getPresetWidths(await measureExportPresets());

  // 사다리를 여기서 한 번 더 요구함 — 프리셋이 없어 세 폭이 컬럼 하나로 눌리면 대조는
  // 저절로 맞아 버림. 폭 일치만 묻는 단언은 그 붕괴 상태에서도 초록이라 아무것도 재지 못함.
  assertPresetLadder(viewer, "뷰어");
  assertPresetLadder(exported, "내보내기");

  for (const preset of SIZE_PRESETS) {
    assert.equal(
      exported.get(preset),
      viewer.get(preset),
      `${preset}: 내보내기 폭(${exported.get(preset)}px) 이 뷰어 폭(${viewer.get(preset)}px) 과 다름`,
    );
  }
});

// 전체화면 배치에서의 breakout 이탈 — 폭 사다리만 재면 놓치는 다리.
// 프리셋이 본문 컬럼 밖으로 나가는 것 자체는 의도이나, 스크롤 컨테이너의 원점보다
// 왼쪽으로 나간 부분은 어떤 스크롤로도 닿지 않아 그대로 소실됨.
function measureFullscreenPresets(): Promise<NodeMeasurement[]> {
  return measurePresetsIn("fullscreen", buildFullscreenHarness, ".doc-fs-body-wrap");
}

test("AC-T23 뷰어 전체화면: 프리셋이 스크롤 원점 왼쪽으로 새지 않음", async () => {
  const measurements = await measureFullscreenPresets();

  assert.equal(measurements.length, SIZE_PRESETS.length);
  for (const m of measurements) {
    assert.ok(m.svgPresent, `${m.type}: <svg> 가 렌더되지 않음`);
    assert.ok(
      m.boxLeft >= m.originLeft - 0.5,
      `${m.type}: 왼쪽 모서리 ${m.boxLeft}px 가 스크롤 원점 ${m.originLeft}px 보다 왼쪽 — ` +
        "스크롤로 닿을 수 없는 영역이라 그만큼 잘려 사라짐",
    );
  }
});

test("AC-T23 뷰어 전체화면: 세 프리셋의 렌더 폭이 서로 구분됨", async () => {
  // 위 단언만 두면 세 프리셋을 전부 본문폭으로 눌러도 초록임 — 사다리를 같은 배치에서 함께 요구함.
  assertPresetLadder(getPresetWidths(await measureFullscreenPresets()), "뷰어 전체화면");
});
