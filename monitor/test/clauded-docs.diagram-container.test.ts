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

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { chromium, type Browser } from "playwright";

import { renderSelfContainedHtml } from "../src/server/clauded-docs/html-export.js";
import { resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const VIEWER_INDEX_PATH = resolve(MONITOR_ROOT, "public/index.html");
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
    "erDiagram\n" +
      '  OUTCOME_RECORD ||--o{ CORRECTION_SIGNAL : "produces on revision"\n' +
      '  OUTCOME_RECORD }o--|| AGENT_REGISTRY_ENTRY : "emitted by agent"',
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
    "gitGraph\n" +
      '  commit id: "wave-one-integration-landed"\n' +
      "  branch feature/diagram-container-width\n" +
      '  commit id: "diagram-container-width-rules"\n' +
      '  commit id: "per-type-use-max-width-off"\n' +
      "  checkout main\n" +
      "  merge feature/diagram-container-width\n" +
      '  commit id: "integration-reconcile-both-directions"',
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

/** 한 mermaid 노드에서 잰 값 — (b) 는 svgStyleAttr, (a) 는 스크롤 세 값. */
interface NodeMeasurement {
  type: string;
  svgPresent: boolean;
  svgStyleAttr: string;
  overflowX: string;
  scrollWidth: number;
  clientWidth: number;
}

let browser: Browser;
let mermaidBundle: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  // 뷰어와 같은 드라이버 — import.meta.resolve 로 로컬 번들을 씀(네트워크 불요).
  const pkgPath = fileURLToPath(import.meta.resolve("mermaid/package.json"));
  mermaidBundle = await readFile(resolve(dirname(pkgPath), "dist", "mermaid.min.js"), "utf8");
});

after(async () => {
  await browser.close();
  await resetBrowserForTests();
});

/** public/index.html 의 인라인 init 인자를 원문에서 뽑음 — 사본을 두지 않기 위함. */
function getViewerMermaidConfig(): Record<string, unknown> {
  const html = readFileSync(VIEWER_INDEX_PATH, "utf8");
  const at = html.indexOf("window.mermaid?.initialize(");
  assert.notEqual(at, -1, "public/index.html 에 mermaid initialize 호출이 없음");
  const source = html.slice(at, html.indexOf("</script>", at));

  let captured: Record<string, unknown> | null = null;
  const windowStub = {
    mermaid: {
      initialize: (config: Record<string, unknown>) => {
        captured = config;
      },
    },
  };
  new Function("window", source)(windowStub);

  assert.notEqual(captured, null, "initialize 인자를 잡지 못함");
  return captured as unknown as Record<string, unknown>;
}

/** clauded-docs.jsx 의 인라인 <style> 템플릿 리터럴 본문. */
function getViewerDocBodyCss(): string {
  const jsx = readFileSync(VIEWER_SCREEN_PATH, "utf8");
  const open = jsx.indexOf("<style>{`");
  const close = jsx.indexOf("`}</style>", open);
  assert.ok(open !== -1 && close !== -1, "clauded-docs.jsx 의 인라인 <style> 블록을 찾지 못함");
  return jsx.slice(open + "<style>{`".length, close);
}

/** 뷰어 실제 DOM 계층(wrap > inner > isolation)을 그대로 세운 하네스 문서. */
function buildViewerHarness(css: string): string {
  const nodes = FIXTURE_TYPES.map(
    (type) => `<pre class="mermaid" data-type="${type}"></pre>`,
  ).join("");
  return (
    "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">" +
    `<style>${css}</style>` +
    "</head><body>" +
    '<div class="detail-fullscreen"><div class="doc-fs-body-wrap">' +
    '<div class="doc-fs-body-inner"><div class="doc-body-isolation">' +
    nodes +
    "</div></div></div></div></body></html>"
  );
}

/** 페이지 안의 pre.mermaid 를 ViewerBodyCD 와 같은 방식으로 렌더한 뒤 계측. */
async function measureRenderedNodes(
  html: string,
  config: Record<string, unknown> | null,
  sources: string[] | null,
): Promise<NodeMeasurement[]> {
  const context = await browser.newContext({
    viewport: { width: NARROW_VIEWPORT_WIDTH, height: 900 },
  });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    if (config !== null && sources !== null) {
      await page.addScriptTag({ content: mermaidBundle });
      const renderError = await page.evaluate(async (args) => {
        const g = globalThis as unknown as {
          mermaid?: {
            initialize: (c: unknown) => void;
            render: (id: string, src: string) => Promise<{ svg: string }>;
          };
          document: { querySelectorAll: (sel: string) => ArrayLike<{ innerHTML: string }> };
        };
        const mermaid = g.mermaid;
        if (mermaid === undefined) return "window.mermaid undefined";
        try {
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

    return await page.evaluate((types) => {
      // 콜백은 chromium 에서 돎 — tsconfig lib 이 ES2022(DOM 없음)라 브라우저 타입은 국소 선언으로 받음.
      type DiagramNode = {
        querySelector: (sel: string) => { getAttribute: (name: string) => string | null } | null;
        scrollWidth: number;
        clientWidth: number;
      };
      const g = globalThis as unknown as {
        document: { querySelectorAll: (sel: string) => ArrayLike<DiagramNode> };
        getComputedStyle: (el: DiagramNode) => { overflowX: string };
      };

      const nodes = Array.from(g.document.querySelectorAll("pre.mermaid, .mermaid"));
      return nodes.map((node, i) => {
        const svg = node.querySelector("svg");
        return {
          type: types[i] ?? `node-${i}`,
          svgPresent: svg !== null,
          svgStyleAttr: svg?.getAttribute("style") ?? "",
          overflowX: g.getComputedStyle(node).overflowX,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      });
    }, FIXTURE_TYPES);
  } finally {
    await page.close();
    await context.close();
  }
}

/**
 * 내보내기 산출물을 1회만 만들어 재사용 — 두 다리가 같은 산출물을 봐야 하고
 * chromium 왕복이 비쌈. 본문은 Tailwind CDN 미참조(CDN 대기 경로 회피).
 */
let exportedHtmlCache: Promise<string> | null = null;

function getExportedHtml(): Promise<string> {
  if (exportedHtmlCache !== null) return exportedHtmlCache;

  const blocks = FIXTURE_TYPES.map(
    (type) => `<pre class="mermaid">${FIXTURES.get(type)}</pre>`,
  ).join("");
  const body =
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>diagram width</title>' +
    `</head><body><main>${blocks}</main></body></html>`;

  exportedHtmlCache = renderSelfContainedHtml(body, "html");
  return exportedHtmlCache;
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

test("AC-T22(b) 뷰어: 채택 타입 전부의 산출 <svg> 에 인라인 max-width 가 없음", async () => {
  const measurements = await measureRenderedNodes(
    buildViewerHarness(getViewerDocBodyCss()),
    getViewerMermaidConfig(),
    FIXTURE_TYPES.map((type) => FIXTURES.get(type) as string),
  );

  assert.equal(measurements.length, FIXTURE_TYPES.length);
  for (const m of measurements) {
    assert.ok(m.svgPresent, `${m.type}: <svg> 가 렌더되지 않음`);
    assert.ok(
      !/max-width/i.test(m.svgStyleAttr),
      `${m.type}: 인라인 max-width 가 남아 있음 — style="${m.svgStyleAttr}"`,
    );
  }
});

test("AC-T22(a) 뷰어: 넓은 다이어그램이 가로 스크롤을 얻고 잘리지 않음", async () => {
  const measurements = await measureRenderedNodes(
    buildViewerHarness(getViewerDocBodyCss()),
    getViewerMermaidConfig(),
    FIXTURE_TYPES.map((type) => FIXTURES.get(type) as string),
  );

  for (const m of measurements) {
    assert.ok(
      m.overflowX === "auto" || m.overflowX === "scroll",
      `${m.type}: 다이어그램 컨테이너의 overflow-x 가 ${m.overflowX} — 스크롤 컨테이너가 아님`,
    );
    assert.ok(
      m.scrollWidth > m.clientWidth,
      `${m.type}: scrollWidth(${m.scrollWidth}) 가 clientWidth(${m.clientWidth}) 를 넘지 않음 — 축소되어 스크롤이 없음`,
    );
  }
});

test("AC-T22(b) 내보내기: 산출 HTML 의 <svg> 전부에 인라인 max-width 가 없음", async () => {
  const measurements = await measureRenderedNodes(await getExportedHtml(), null, null);

  assert.equal(measurements.length, FIXTURE_TYPES.length);
  for (const m of measurements) {
    assert.ok(m.svgPresent, `${m.type}: 내보내기 산출물에 <svg> 가 없음`);
    assert.ok(
      !/max-width/i.test(m.svgStyleAttr),
      `${m.type}: 내보내기 <svg> 에 인라인 max-width 가 남아 있음 — style="${m.svgStyleAttr}"`,
    );
  }
});

test("AC-T22(a) 내보내기: 산출 HTML 을 열면 가로 스크롤이 생기고 잘리지 않음", async () => {
  const measurements = await measureRenderedNodes(await getExportedHtml(), null, null);

  assert.equal(measurements.length, FIXTURE_TYPES.length);
  for (const m of measurements) {
    assert.ok(
      m.overflowX === "auto" || m.overflowX === "scroll",
      `${m.type}: 내보내기 컨테이너의 overflow-x 가 ${m.overflowX} — 스크롤 컨테이너가 아님`,
    );
    assert.ok(
      m.scrollWidth > m.clientWidth,
      `${m.type}: 내보내기 scrollWidth(${m.scrollWidth}) 가 clientWidth(${m.clientWidth}) 를 넘지 않음`,
    );
  }
});
