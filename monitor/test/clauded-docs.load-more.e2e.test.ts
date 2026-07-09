// E2E Playwright test — Load More pagination + doc_status chip + folder grouping + cascade on screens/clauded-docs.jsx.
// Runner: npx tsx --test test/clauded-docs.load-more.e2e.test.ts
//
// DB: real Postgres — every seeded row tagged `load-more-test-${uuid}` 마커, after() 가 LIKE 일괄 cleanup.
// App: stripped Fastify (fastify-static + clauded-docs routes) on ephemeral port (production 16145 미간섭) · Browser: Playwright chromium headless, NO mocking.
// Chromium 미설치 시 loud-fail — `npx playwright install chromium` 선행 필요 (in-test guard 없음).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

// shared fixtures.

const SUITE_MARKER = `load-more-test-${randomUUID()}`;

// HERE = test 디렉터리 — public/ 은 상위 (repo root) 의 형제 폴더.
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..", "public");

let htmlSuiteRoot: string;
let app: FastifyInstance;
let serverUrl: string;
let browser: Browser;

function makeTitle(label: string, idx: number): string {
  // idx → zero-pad 3-자리 (정렬 시 created_at desc 와 무관하게 식별 가능)
  const padded = String(idx).padStart(3, "0");
  return `${SUITE_MARKER}-${label}-${padded}-${randomUUID().slice(0, 8)}`;
}

function makeHtmlBody(salt: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>x</title></head>' +
    `<body><main><h1>${salt}</h1><p>본문 ${salt}</p></main></body>` +
    "</html>"
  );
}

async function postCreate(payload: Record<string, unknown>): Promise<{ id: number; supersedes_id: number | null }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`POST failed: ${res.statusCode} ${res.payload}`);
  }
  const body = res.json() as { id: number; supersedes_id: number | null };
  return body;
}

async function deleteDoc(id: number): Promise<void> {
  try {
    await app.inject({ method: "DELETE", url: `/api/clauded-docs/${id}` });
  } catch {
    // best-effort cleanup
  }
}

before(async () => {
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "clauded-docs-load-more-html-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  await app.register(fastifyStatic, {
    root: PUBLIC_ROOT,
    prefix: "/",
    index: ["index.html"],
  });
  await registerClaudedDocsRoutes(app);
  await app.ready();
  // listen on ephemeral port — production 16145 미간섭.
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  // address 는 "http://127.0.0.1:PORT" 형식 — 그대로 사용 가능.
  serverUrl = address;
  // address 가 ip:port 만 반환하는 fastify 버전 호환 — server.address() fallback.
  if (!/^https?:/.test(serverUrl)) {
    const sockAddr = app.server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${sockAddr.port}`;
  }

  browser = await chromium.launch({ headless: true });
});

after(async () => {
  try {
    if (browser) await browser.close();
  } catch {
    // best-effort
  }
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[load-more-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  resetDocsRootCache();
});

// 60 docs 만들기 — prefix/doc_type 컬럼은 DROP 됨 (서버가 silent-ignore) → 격리는 SUITE_MARKER
// title + created_at DESC 정렬(시드 = 최신 → 첫 page 가시)에 의존.
async function seedManyDocs(count: number, label: string): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const title = makeTitle(label, i);
    const body = makeHtmlBody(`${title}-body`);
    const res = await postCreate({
      title,
      author: "load-more-tester",
      html_body: body,
    });
    ids.push(res.id);
  }
  return ids;
}

// helper — React 상태 변경이 트리거하는 /api/clauded-docs 응답 1건 대기 + 후행 동작 실행.
//   · screens/clauded-docs.jsx 의 fetch effect 는 React 다음 tick 에 실행되므로 networkidle 만으로는
//     동기화가 race-prone 함 (Playwright 가 click 직후 idle 윈도우를 잡아 fetch 시작 전 반환).
//   · waitForResponse 를 action 직전에 등록 → Promise.all 로 click + 응답 동시 대기 → 결정적 동기화.
//   · matcher predicate 는 production base path (`/api/clauded-docs`) 매칭 + 호출자 predicate 로 부수 경로 제외.
async function clickAndWaitForListResponse(
  page: Page,
  action: () => Promise<void>,
  predicate: (url: string) => boolean,
): Promise<void> {
  const respPromise = page.waitForResponse(
    (res) => {
      const url = res.url();
      // managed list/search endpoint 만 매칭 — /:id, /search, /legacy 제외 또는 별도 매칭.
      if (!url.includes("/api/clauded-docs")) return false;
      return predicate(url);
    },
    { timeout: 10_000 },
  );
  await Promise.all([respPromise, action()]);
}

// doc_status chip 클릭 helper.
//   · doc_status filter chip ('In progress' / 'Done' / 'All') → /api/clauded-docs/groups 호출 + ?doc_status= 송신.
//   · chip 변경 → currentOffset=0 리셋 → offset 파라미터 미포함 응답이 reset 완료 시그널.
//   · 응답 path: managedData.groups[] 정규화 후 setLoadedRows.
async function clickDocStatusChip(page: Page, label: string): Promise<void> {
  await clickAndWaitForListResponse(
    page,
    async () => {
      const within = page.getByRole("radiogroup", { name: "Status filter" });
      await within.getByRole("radio", { name: label, exact: true }).click();
    },
    (url) => !url.includes("offset="),
  );
}

// helper — Load More 버튼 locator. aria-label `Show ${N} more` (N = formatIntCD 콤마 포함) —
// 로딩 중 라벨 'Loading more' 와 구분 위해 ^Show 정규식 매칭.
function loadMoreButton(page: Page) {
  return page.getByRole("button", { name: /^Show [\d,]+ more$/ });
}

// helper — 'doc-row' 가시 행 수 카운트.
async function countVisibleRows(page: Page): Promise<number> {
  return await page.locator("tr.doc-row").count();
}

// helper — DOM 의 doc-row 수가 minCount 에 도달할 때까지 대기 (React re-render flush).
//   · waitForResponse 후에도 React batching → setLoadedRows 반영까지 한 tick 더 소요.
//   · waitForFunction 으로 polling — 결정적 + timeout 명시 (race-free).
async function waitForRowCountAtLeast(page: Page, minCount: number): Promise<void> {
  await page.waitForFunction(
    (n) => document.querySelectorAll("tr.doc-row").length >= n,
    minCount,
    { timeout: 10_000 },
  );
}

// helper — DOM 의 doc-row 수가 maxCount 이하로 떨어질 때까지 대기 (filter reset → page 축소 검증).
//   · '전체' 칩 클릭 후 누적 행이 정리되어 ≤ maxCount 가 되는 순간 잡기 위해 사용.
async function waitForRowCountAtMost(page: Page, maxCount: number): Promise<void> {
  await page.waitForFunction(
    (n) => document.querySelectorAll("tr.doc-row").length <= n,
    maxCount,
    { timeout: 10_000 },
  );
}

// load-more: 60 seeds → initial 50 + Load More click → 60.

test("load-more: 60 seeds → initial 50 visible + Load More button → click → 60 visible + button hidden", async () => {
  const ids = await seedManyDocs(60, "ac3lm");
  try {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      // 화면 진입 — hash router screen id 'clauded-docs' (app.jsx NAV 항목 id 와 동일 · '#clauded-docs' 패턴).
      // app.jsx parseHashScreen 가 raw hash 를 그대로 NAV.id 와 비교 — '#screen-clauded-docs' 같은 prefix 사용 시 fallback=dashboard.
      // 기본 doc_status filter = 'progress' — 시드 60건이 progress 기본값 + created_at DESC 최신이라 첫 page 포함.
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });

      // 최초 fetch — limit=50 → 50 행 가시 (총 group ≥ 60 → first page 50).
      await waitForRowCountAtLeast(page, 50);
      const initialRowCount = await countVisibleRows(page);
      assert.strictEqual(initialRowCount, 50, `initial render shows 50 rows (got ${initialRowCount})`);

      // Load More 버튼 노출 확인 — aria-label `Show ${N} more`.
      const loadMoreBtn = loadMoreButton(page);
      await loadMoreBtn.waitFor({ state: "visible" });

      // 클릭 → offset=50 fetch → 추가 row append. Promise.all 로 click + 응답 동시 대기.
      await clickAndWaitForListResponse(
        page,
        async () => { await loadMoreBtn.click(); },
        (url) => url.includes("offset=50"),
      );
      // React batching → setLoadedRows 반영까지 polling.
      await waitForRowCountAtLeast(page, 60);

      const afterLoadMore = await countVisibleRows(page);
      assert.ok(afterLoadMore >= 60, `Load More 후 ≥60 rows (got ${afterLoadMore})`);
      assert.ok(afterLoadMore > initialRowCount, `행 증가 (initial ${initialRowCount} → after ${afterLoadMore})`);
    } finally {
      await context.close();
    }
  } finally {
    for (const id of ids) await deleteDoc(id);
  }
});

// filter-reset: Load More 후 doc_status filter 변경 → offset=0 리셋.

test("filter-reset: Load More 누적 후 doc_status chip 변경 → 페이지 reset (offset=0) + 첫 page 만 표시", async () => {
  const ids = await seedManyDocs(60, "ac3reset");
  try {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });

      // 기본 progress filter — 60 시드 (progress 기본값 · 최신) 가 첫 page 점유.
      await waitForRowCountAtLeast(page, 50);

      // Load More click → 누적 ≥60. Promise.all 로 click + offset=50 응답 동기화.
      const loadMoreBtn = loadMoreButton(page);
      await loadMoreBtn.waitFor({ state: "visible" });
      await clickAndWaitForListResponse(
        page,
        async () => { await loadMoreBtn.click(); },
        (url) => url.includes("offset=50"),
      );
      await waitForRowCountAtLeast(page, 60);
      const afterLoadMore = await countVisibleRows(page);
      assert.ok(afterLoadMore >= 60, `Load More 후 ≥60 rows (got ${afterLoadMore})`);

      // 'All' chip 으로 filter 변경 → offset 리셋 + 새 첫 50 fetch.
      // 누적된 60+ 행이 사라지고 최대 50 행만 표시되어야 (리셋 증거).
      // clickDocStatusChip 는 offset 미포함 응답 대기 → reset 완료 시그널.
      await clickDocStatusChip(page, "All");
      await waitForRowCountAtMost(page, 50);
      const afterReset = await countVisibleRows(page);
      assert.ok(afterReset <= 50,
        `doc_status change 시 페이지 리셋 — row 수 ≤50 (got ${afterReset})`);
    } finally {
      await context.close();
    }
  } finally {
    for (const id of ids) await deleteDoc(id);
  }
});

// superseded-drawer: predecessor 가진 doc 선택 → version-history 섹션 표시.
// T-DOC-3 — predecessor 패널을 collapsed-by-default <details> "Version history" 로 전환(progressive disclosure).
//   collapsed 상태: <details> 는 DOM 에 존재하나 children 은 미가시 → expand 후 predecessor 노출 확인.

test("superseded-drawer: supersedes_id 가진 doc 선택 → meta sidebar 'Version history' 섹션 (collapsed-default) expand 시 이전 revision 노출", async () => {
  // chain: predecessor (final) + successor (draft + supersedes_id=pred.id) — CTE
  // 가 predecessor 를 superseded 로 transition.
  const predTitle = makeTitle("ac3-pred", 0);
  const succTitle = makeTitle("ac3-succ", 0);
  const predRes = await postCreate({
    title: predTitle,
    author: "load-more-tester",
    html_body: makeHtmlBody(predTitle),
  });
  const succRes = await postCreate({
    title: succTitle,
    author: "load-more-tester",
    html_body: makeHtmlBody(succTitle),
    supersedes_id: predRes.id,
  });
  try {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      // 기본 progress filter — successor (progress · 최신 created_at) 가 첫 page 포함.
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });
      await page.locator("tr.doc-row").first().waitFor({ state: "visible" });

      // successor 행 클릭 → fullscreen viewer 진입 → meta sidebar 노출.
      const succRow = page.locator("tr.doc-row", { hasText: succTitle });
      await succRow.waitFor({ state: "visible" });
      await succRow.click();

      // (a) viewer meta sidebar — DocMetaPanelCD → PredecessorPanelCD 의 'Version history' <details> 섹션 PRESENT.
      const versionHistory = page.locator("details.doc-version-history");
      await versionHistory.waitFor({ state: "attached" });
      await versionHistory.getByText("Version history", { exact: false }).waitFor({ state: "visible" });

      // (b) collapsed-by-default 확인 (T-DOC-3 progressive disclosure) — open 속성 미존재 → predecessor 미가시.
      assert.strictEqual(
        await versionHistory.evaluate((el) => (el as HTMLDetailsElement).open),
        false,
        "Version history <details> 는 default collapsed (open=false)",
      );
      await assert.rejects(
        page.getByText(predTitle, { exact: false }).waitFor({ state: "visible", timeout: 1000 }),
        "collapsed 상태에서는 predecessor title 미가시",
      );

      // (c) expand (summary 클릭) → predecessor revision 내용 노출 — fetch + 표시 검증(커버리지 유지).
      //   'Previous' 라벨은 .doc-revision-predecessor span — exact 매칭으로 'View previous →' 버튼과 분리.
      await versionHistory.locator("summary").click();
      await versionHistory.getByText("Previous", { exact: true }).waitFor({ state: "visible" });
      await page.getByText(predTitle, { exact: false }).waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  } finally {
    await deleteDoc(succRes.id);
    await deleteDoc(predRes.id);
  }
});

// cascade-doc-status: PUT doc_status → folder cascade → list reload 후 sibling docs 일괄 'done'.

test("cascade-doc-status: folder group cascade — PUT doc_status=done on B → server cascade → sibling C 도 done 으로 일괄 갱신", async () => {
  // server PUT 은 expected_hash + body 필드 필수 (parseUpdateBody @ routes/clauded-docs.ts).
  // 따라서 cascade trigger 는 실제 edit (body 재전송 + hash 검증) 흐름으로 수행.
  // 절차:
  //   1) root anchor A (folder_id=NULL) 생성 — A.id 가 folder_id 의 root 값.
  //   2) sibling B/C 생성 — folder_id=A.id (POST body folder_id 지원 · server INSERT 시 FK 검증).
  //   3) GET B → B 의 expected_hash + body 확보.
  //   4) PUT B { html_body=원본, expected_hash, doc_status=done } → server cascade SQL:
  //      WHERE id=B OR folder_id=(SELECT folder_id FROM target WHERE folder_id IS NOT NULL)
  //      → 같은 folder_id=A.id 의 B + C 일괄 갱신 (A 는 folder_id=NULL 이라 cascade 미포함).
  //   5) UI refresh + doc_status chip='Done' → B + C 가시, A 는 미가시 (progress 유지) 확인.
  // PUT folder_id mutation 자체는 본 cycle scope 외 — server parseUpdateBody 가 folder_id 무시 (silent ignore).

  const aTitle = makeTitle("acc-anchor-A", 0);
  const bTitle = makeTitle("acc-sibling-B", 0);
  const cTitle = makeTitle("acc-sibling-C", 0);

  // raw body 캐시 — server 가 storage 시 doctype + charset 을 strip (DOMPurify whitelist 누락).
  // GET response 의 body 는 sanitize 후 형태 → PUT 시 재전송하면 html_structure_invalid 400 발생.
  // 따라서 POST 시점 raw 본문을 그대로 보관 + PUT 시 재사용 (baseline 보존).
  const bRawBody = makeHtmlBody(bTitle);
  // PUT 시 body 일부 변경 의무 — server handleUpdateHtmlBody no-op short-circuit
  // (hash 동일 + audience 동일 시 cascadeAfterRowUpdate skip) 회피. 의미 동일 + hash 만 다르도록 trailing <p> 추가.
  const bRawBodyForPut = bRawBody.replace("</main>", "<p data-rev=\"2\">cascade trigger</p></main>");

  // 1) anchor A — folder_id 미명시 → NULL · A.id 가 sibling group 의 root value 역할.
  const aRes = await postCreate({
    title: aTitle,    author: "cascade-tester", html_body: makeHtmlBody(aTitle),
  });

  // 2) sibling B/C — folder_id=aRes.id (POST body folder_id 지원).
  const bRes = await postCreate({
    title: bTitle,    author: "cascade-tester", html_body: bRawBody,
    folder_id: aRes.id,
  });
  const cRes = await postCreate({
    title: cTitle,    author: "cascade-tester", html_body: makeHtmlBody(cTitle),
    folder_id: aRes.id,
  });

  try {
    // 3) GET B → content_hash 확보 (PUT expected_hash 검증용 — body 자체는 sanitized 라 재사용 불가).
    const getBRes = await app.inject({ method: "GET", url: `/api/clauded-docs/${bRes.id}` });
    assert.strictEqual(getBRes.statusCode, 200, `GET B succeeded (got ${getBRes.statusCode})`);
    const bDoc = getBRes.json() as { content_hash: string; folder_id: number | null };
    assert.strictEqual(bDoc.folder_id, aRes.id, "B 의 folder_id 가 A.id 와 매칭");

    // 4) PUT B doc_status=done — POST 변형 body (baseline 보존 + hash 차이 → no-op skip 회피) + doc_status → cascade 트리거.
    const cascadeRes = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${bRes.id}`,
      payload: {
        html_body: bRawBodyForPut,
        expected_hash: bDoc.content_hash,
        doc_status: "done",
      },
    });
    assert.strictEqual(cascadeRes.statusCode, 200,
      `PUT cascade succeeded (got ${cascadeRes.statusCode}: ${cascadeRes.payload})`);

    // 5) 서버 측 cascade 적용 확인 — GET C 의 doc_status 가 done 인지 직접 검증 (UI 진입 전 server contract 보장).
    const getCRes = await app.inject({ method: "GET", url: `/api/clauded-docs/${cRes.id}` });
    assert.strictEqual(getCRes.statusCode, 200, `GET C succeeded`);
    const cDoc = getCRes.json() as { doc_status: string };
    assert.strictEqual(cDoc.doc_status, "done",
      "C (sibling) cascade 적용 — server SQL 이 folder_id=A.id 의 sibling 도 일괄 갱신");

    // 6) UI 측 가시화 검증 — done chip 필터 적용 후 B + C 노출, A 는 progress 유지로 미가시.
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });

      // 기본 progress filter — 시드 행 (최신 created_at) 이 첫 page 가시.
      await page.locator("tr.doc-row").first().waitFor({ state: "visible" });

      // doc_status='Done' chip → /groups?doc_status=done 호출 → done 상태 그룹만 가시화.
      await clickDocStatusChip(page, "Done");

      // B + C 가 done 필터에서 가시 — server cascade 의 UI 가시화 확인.
      // 단, B/C 는 folder_id 가 동일하므로 group 1개 (representative_id=B 또는 C — created_at DESC 기준) → 1 row 가시.
      // 따라서 '둘 중 하나' 의 row 만 보여도 group representative 정합.
      const bRow = page.locator("tr.doc-row", { hasText: bTitle });
      const cRow = page.locator("tr.doc-row", { hasText: cTitle });
      // 둘 중 하나는 group representative 로 노출 (DISTINCT ON folder_id · created_at DESC) — C 가 더 최근 생성 → C 가 representative.
      await cRow.waitFor({ state: "visible", timeout: 5000 });
      const bVisible = await bRow.count();
      const cVisible = await cRow.count();
      assert.ok(cVisible > 0,
        `C (cascade target sibling) row 가시 — group representative (created_at DESC) — got cVisible=${cVisible}`);
      assert.strictEqual(bVisible, 0,
        `B 는 group representative 가 아님 — 같은 folder 의 sibling 1개 representative 만 surface (DISTINCT ON folder_id)`);

      // A 는 folder_id=NULL · cascade 미적용 → progress 유지 → done 필터에서 미가시.
      const aRow = page.locator("tr.doc-row", { hasText: aTitle });
      const aVisibleCount = await aRow.count();
      assert.strictEqual(aVisibleCount, 0,
        `A (folder_id=NULL · cascade 미포함) 는 done 필터에서 미가시 — progress 유지`);
    } finally {
      await context.close();
    }
  } finally {
    await deleteDoc(cRes.id);
    await deleteDoc(bRes.id);
    await deleteDoc(aRes.id);
  }
});

// Group lifecycle e2e — POST /group · POST /ungroup · PATCH /:id/move-group + auto-ungroup trigger + UI cascade/toast 회귀.
// 격리 seed + try/finally cleanup — production mutation 0 · SUITE_MARKER UUID 가 after() scrub LIKE 매칭 spine.

// helper — row checkbox 토글 (multi-select 추가). row title 매칭.
//   · GroupActionBarCD 의 selectionSize ≥ 2 → "Group" 활성 트리거.
//   · checkbox click 은 stopPropagation 으로 row select 와 분리됨.
async function checkRowByTitle(page: Page, title: string): Promise<void> {
  // group 펼침 시 representative 는 root + member 행 양쪽에 렌더 → .first() (DOM 순서 = root) 로
  // strict-mode 단일화 — selection 은 doc id 기준이라 어느 행의 checkbox 든 동일.
  const row = page.locator("tr.doc-row", { hasText: title }).first();
  await row.waitFor({ state: "visible" });
  // row 내 checkbox — aria-label=`Select ${title}`.
  await row.getByRole("checkbox", { name: `Select ${title}`, exact: true }).check();
}

// helper — group action bar 의 "Group" 버튼 클릭 + POST /group 응답 대기.
//   · GroupActionBarCD — 'role="toolbar" aria-label="Bulk group actions"' scope.
//   · 응답 후 triggerRefresh → /groups GET → list reload 까지 대기.
async function clickGroupCreateButton(page: Page): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Bulk group actions" });
  const btn = toolbar.getByRole("button", { name: "Group", exact: true });
  await btn.waitFor({ state: "visible" });
  // POST /group 응답 대기 + 후행 list refresh 응답 대기 — Promise.all chain.
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/api/clauded-docs/group") &&
              !res.url().includes("/groups") &&
              res.request().method() === "POST",
      { timeout: 10_000 },
    ),
    btn.click(),
  ]);
}

// helper — group action bar 의 "Ungroup" 버튼 클릭 + POST /ungroup 응답 대기.
async function clickUngroupButton(page: Page): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Bulk group actions" });
  const btn = toolbar.getByRole("button", { name: "Ungroup", exact: true });
  await btn.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/api/clauded-docs/ungroup") &&
              res.request().method() === "POST",
      { timeout: 10_000 },
    ),
    btn.click(),
  ]);
}

// helper — group root row 의 toggle 클릭 (member rows expand) + member list fetch 대기.
//   · expand 시 GroupMembersRowsCD 가 /api/clauded-docs?folder_id=X 호출.
async function expandGroup(page: Page, rootTitle: string): Promise<void> {
  const rootRow = page.locator("tr.doc-row.is-group-root", { hasText: rootTitle });
  await rootRow.waitFor({ state: "visible" });
  const toggleBtn = rootRow.locator("button.doc-group-toggle").first();
  await toggleBtn.waitFor({ state: "visible" });
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/api/clauded-docs") &&
              res.url().includes("folder_id=") &&
              res.request().method() === "GET",
      { timeout: 10_000 },
    ),
    toggleBtn.click(),
  ]);
}

// helper — direct POST /api/clauded-docs/group (서버 contract 우회용 pre-seed).
//   · UI 진입 전 격리 group 구성 시 사용 — 별도 시나리오 의 setup cost 회피.
async function postGroup(memberIds: number[]): Promise<{ folder_id: number; member_count: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs/group",
    payload: { member_ids: memberIds },
  });
  if (res.statusCode !== 200) {
    throw new Error(`POST /group failed: ${res.statusCode} ${res.payload}`);
  }
  return res.json() as { folder_id: number; member_count: number };
}

// helper — GET 단건 → folder_id 확인 (auto-ungroup 검증용).
async function getDocFolderId(id: number): Promise<number | null> {
  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}` });
  if (res.statusCode !== 200) {
    throw new Error(`GET ${id} failed: ${res.statusCode}`);
  }
  const body = res.json() as { folder_id: number | null };
  return body.folder_id;
}

// group-create: 3 docs multi-select → POST /group → root + member_count badge.

test("group-create: 격리 3 doc multi-select → 'Group' 클릭 → POST /group → folder_id 결성 + member_count badge 가시", async () => {
  // 격리 seed 3 doc — SUITE_MARKER title (after() scrub) + 최신 created_at → 첫 page 가시.
  const titles = [
    makeTitle("acg-grp-A", 0),
    makeTitle("acg-grp-B", 0),
    makeTitle("acg-grp-C", 0),
  ];
  const ids: number[] = [];
  for (const t of titles) {
    const r = await postCreate({
      title: t,      author: "group-tester", html_body: makeHtmlBody(t),
    });
    ids.push(r.id);
  }
  try {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });
      await page.locator("tr.doc-row").first().waitFor({ state: "visible" });

      // 3 doc multi-select — checkbox 토글 (selection_count = 3 → canGroup 활성).
      for (const t of titles) await checkRowByTitle(page, t);

      // selection_count 표시 확인 — "3 selected".
      const toolbar = page.getByRole("toolbar", { name: "Bulk group actions" });
      await toolbar.getByText("3 selected", { exact: true }).waitFor({ state: "visible" });

      // POST /group 트리거 + 후행 /groups list reload 대기 (triggerRefresh).
      await clickGroupCreateButton(page);

      // 응답 후 list refresh — /groups endpoint 재호출 + group representative row 갱신.
      // member_count_badge 가시 — root row (server: created_at DESC 기준 최신 = C) 에 "+2" 표시 (3-1=2 members 추가).
      await page.waitForResponse(
        (res) => res.url().includes("/api/clauded-docs/groups") &&
                res.request().method() === "GET" &&
                !res.url().includes("offset="),
        { timeout: 10_000 },
      );

      // C (created_at DESC 기준 최신) 가 group representative — member_count_badge 노출 확인.
      const cRow = page.locator("tr.doc-row.is-group-root", { hasText: titles[2] });
      await cRow.waitFor({ state: "visible", timeout: 5000 });
      // 멤버수 배지 = shared Badge(role="count") → [data-doc-member-count] wrapper 안 .pill--count.
      //   group-root row 로 scope → 페이지 내 다른 count pill 과 미충돌.
      const badge = cRow.locator("[data-doc-member-count] .pill--count");
      await badge.waitFor({ state: "visible" });
      const badgeText = await badge.textContent();
      assert.strictEqual(badgeText, "+2",
        `member_count badge "+2" 표시 — 3 doc group 의 root + 2 추가 멤버 (got "${badgeText}")`);

      // 토스트 "Grouped 3" surface — TOAST_DURATION_MS_CD=3200 ms 윈도우 안에서 검증.
      const toast = page.locator(".doc-toast.ok", { hasText: "Grouped 3" });
      await toast.waitFor({ state: "visible", timeout: 3000 });

      // server-side 검증 — 3 doc 모두 folder_id 동일 (최신 = C.id 가 root).
      const folderC = await getDocFolderId(ids[2]);
      assert.strictEqual(folderC, ids[2], `C 가 root (folder_id == 자신 id)`);
      const folderA = await getDocFolderId(ids[0]);
      const folderB = await getDocFolderId(ids[1]);
      assert.strictEqual(folderA, ids[2], `A 의 folder_id = C.id`);
      assert.strictEqual(folderB, ids[2], `B 의 folder_id = C.id`);
    } finally {
      await context.close();
    }
  } finally {
    for (const id of ids) await deleteDoc(id);
  }
});

// ungroup: pre-seed 2-doc group → multi-select → POST /ungroup → folder_id NULL.

test("ungroup: 2-doc grouped pre-seed → multi-select → 'Ungroup' 클릭 → POST /ungroup → folder_id NULL 검증", async () => {
  const aTitle = makeTitle("acg-ungrp-A", 0);
  const bTitle = makeTitle("acg-ungrp-B", 0);
  const aRes = await postCreate({
    title: aTitle,    author: "ungroup-tester", html_body: makeHtmlBody(aTitle),
  });
  const bRes = await postCreate({
    title: bTitle,    author: "ungroup-tester", html_body: makeHtmlBody(bTitle),
  });
  // pre-seed group — UI 진입 전 server contract 직접 호출 (setup cost 회피).
  await postGroup([aRes.id, bRes.id]);
  try {
    // sanity — group 결성 직후 양쪽 folder_id 동일.
    const beforeA = await getDocFolderId(aRes.id);
    const beforeB = await getDocFolderId(bRes.id);
    assert.ok(beforeA !== null && beforeA === beforeB,
      `pre-seed group sanity — A.folder_id (${beforeA}) === B.folder_id (${beforeB}) !== NULL`);

    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });
      await page.locator("tr.doc-row").first().waitFor({ state: "visible" });

      // group root row (B = 최신) expand → A member 가시화 (multi-select 가능 상태).
      // 단, root row 의 checkbox 만 토글해도 server 가 row 단위 ungroup 처리.
      // → 양쪽 모두 ungroup 시키려면 expand → A 도 select 필요.
      // 간소화 — root row 만 selection 해도 server 가 그 row 의 folder_id 만 NULL 처리 →
      // 잔여 1 member 인 A 가 auto-ungroup trigger 발화 → A 도 자동 NULL.
      // 본 시나리오는 명시적 multi-select ungroup 검증이 목적이므로 expand 후 양쪽 모두 check.
      await expandGroup(page, bTitle);

      // 양쪽 모두 multi-select.
      await checkRowByTitle(page, bTitle);
      await checkRowByTitle(page, aTitle);

      // "2 selected" 확인.
      const toolbar = page.getByRole("toolbar", { name: "Bulk group actions" });
      await toolbar.getByText("2 selected", { exact: true }).waitFor({ state: "visible" });

      // POST /ungroup 트리거.
      await clickUngroupButton(page);

      // 토스트 "Ungrouped 2" — auto_ungrouped_ids 가 0 건이라 추가 note 없음.
      const toast = page.locator(".doc-toast.ok", { hasText: "Ungrouped 2" });
      await toast.waitFor({ state: "visible", timeout: 3000 });

      // server-side 검증 — 양쪽 folder_id 모두 NULL.
      const afterA = await getDocFolderId(aRes.id);
      const afterB = await getDocFolderId(bRes.id);
      assert.strictEqual(afterA, null, `A.folder_id NULL 처리됨`);
      assert.strictEqual(afterB, null, `B.folder_id NULL 처리됨`);
    } finally {
      await context.close();
    }
  } finally {
    await deleteDoc(bRes.id);
    await deleteDoc(aRes.id);
  }
});

// move-group: 2 group → PATCH /:id/move-group → folder_id 이동 + auto-ungroup.
//   · server-only surface (화면 진입점 없음) → app.inject 직접 검증 — auto-ungroup 시나리오와 동일 방식.

test("move-group: 2 group (각 2 doc) → PATCH /move-group → 멤버 이동 + auto-ungroup source trigger + self-move 400", async () => {
  // group A: a1 + a2 (a2 가 최신 = root) · group B: b1 + b2 (b2 가 최신 = root).
  const a1Title = makeTitle("acg-mv-A1", 0);
  const a2Title = makeTitle("acg-mv-A2", 0);
  const b1Title = makeTitle("acg-mv-B1", 0);
  const b2Title = makeTitle("acg-mv-B2", 0);
  const a1Res = await postCreate({
    title: a1Title,    author: "move-tester", html_body: makeHtmlBody(a1Title),
  });
  const a2Res = await postCreate({
    title: a2Title,    author: "move-tester", html_body: makeHtmlBody(a2Title),
  });
  const b1Res = await postCreate({
    title: b1Title,    author: "move-tester", html_body: makeHtmlBody(b1Title),
  });
  const b2Res = await postCreate({
    title: b2Title,    author: "move-tester", html_body: makeHtmlBody(b2Title),
  });
  await postGroup([a1Res.id, a2Res.id]);
  await postGroup([b1Res.id, b2Res.id]);
  try {
    // sanity — A 의 root = a2.id, B 의 root = b2.id (가장 최근 created_at).
    const a1Folder = await getDocFolderId(a1Res.id);
    assert.strictEqual(a1Folder, a2Res.id, `a1.folder_id = a2.id (a2 가 root)`);

    // PATCH a1 → group B (target root = b2.id).
    const moveRes = await app.inject({
      method: "PATCH",
      url: `/api/clauded-docs/${a1Res.id}/move-group`,
      payload: { target_group_root_id: b2Res.id },
    });
    assert.strictEqual(moveRes.statusCode, 200,
      `PATCH /move-group 성공 (got ${moveRes.statusCode}: ${moveRes.payload})`);
    const moveBody = moveRes.json() as {
      moved_id: number;
      from_folder_id: number | null;
      to_folder_id: number;
      auto_ungrouped_id: number | null;
    };
    assert.strictEqual(moveBody.moved_id, a1Res.id, `moved_id = a1`);
    assert.strictEqual(moveBody.from_folder_id, a2Res.id, `from_folder_id = 소스 root (a2)`);
    assert.strictEqual(moveBody.to_folder_id, b2Res.id, `to_folder_id = 대상 root (b2)`);
    // 소스 group A 잔여 1 member (a2) — 1-member auto-ungroup trigger 발화.
    assert.strictEqual(moveBody.auto_ungrouped_id, a2Res.id,
      `auto_ungrouped_id = 소스 잔여 1 member (a2)`);

    // server-side 검증 — a1.folder_id = b2.id (이동됨), a2.folder_id = NULL (auto-ungroup).
    const a1After = await getDocFolderId(a1Res.id);
    const a2After = await getDocFolderId(a2Res.id);
    assert.strictEqual(a1After, b2Res.id, `a1 의 folder_id 이동됨 = b2.id`);
    assert.strictEqual(a2After, null, `a2 (소스 잔여 1건) auto-ungroup → NULL`);

    // group B 유지 + a1 합류 — b1, b2 의 folder_id 변화 없음.
    const b1After = await getDocFolderId(b1Res.id);
    const b2After = await getDocFolderId(b2Res.id);
    assert.strictEqual(b1After, b2Res.id, `b1 의 folder_id 변화 없음 = b2.id`);
    assert.strictEqual(b2After, b2Res.id, `b2 가 여전히 root (자기 자신)`);

    // self-move 거부 — target_group_root_id == :id → 400 invalid_body.
    const selfRes = await app.inject({
      method: "PATCH",
      url: `/api/clauded-docs/${b2Res.id}/move-group`,
      payload: { target_group_root_id: b2Res.id },
    });
    assert.strictEqual(selfRes.statusCode, 400,
      `self-move 400 invalid_body (got ${selfRes.statusCode})`);
  } finally {
    await deleteDoc(a1Res.id);
    await deleteDoc(a2Res.id);
    await deleteDoc(b1Res.id);
    await deleteDoc(b2Res.id);
  }
});

// auto-ungroup: 3-doc group → ungroup 2 → 남은 1 doc 자동 folder_id NULL.

test("auto-ungroup: 3-doc group → 2 member POST /ungroup → 잔여 1 member 자동 folder_id NULL trigger", async () => {
  // server contract 직접 검증 — UI 진입 없이 trigger 발화만 확인.
  // UI 시나리오 (ACG-ungroup) 와 분리 — auto-ungroup 은 순수 server-side 동작.
  const titles = [
    makeTitle("acg-auto-A", 0),
    makeTitle("acg-auto-B", 0),
    makeTitle("acg-auto-C", 0),
  ];
  const ids: number[] = [];
  for (const t of titles) {
    const r = await postCreate({
      title: t,      author: "auto-ungroup-tester", html_body: makeHtmlBody(t),
    });
    ids.push(r.id);
  }
  const grpRes = await postGroup(ids);
  try {
    // sanity — 3 doc 모두 folder_id = grpRes.folder_id (= 최신 = C.id).
    assert.strictEqual(grpRes.folder_id, ids[2], `group root = C (latest)`);
    const aFolder = await getDocFolderId(ids[0]);
    const bFolder = await getDocFolderId(ids[1]);
    const cFolder = await getDocFolderId(ids[2]);
    assert.strictEqual(aFolder, ids[2], `A.folder_id = C.id`);
    assert.strictEqual(bFolder, ids[2], `B.folder_id = C.id`);
    assert.strictEqual(cFolder, ids[2], `C.folder_id = C.id (self-root)`);

    // ungroup 2 members (A + B) → 잔여 1 member (C) 가 1-member auto-ungroup trigger 발화 조건.
    const ungrpRes = await app.inject({
      method: "POST",
      url: "/api/clauded-docs/ungroup",
      payload: { member_ids: [ids[0], ids[1]] },
    });
    assert.strictEqual(ungrpRes.statusCode, 200,
      `POST /ungroup 성공 (got ${ungrpRes.statusCode}: ${ungrpRes.payload})`);
    const ungrpBody = ungrpRes.json() as {
      ungrouped_count: number;
      auto_ungrouped_ids: number[];
    };

    assert.strictEqual(ungrpBody.ungrouped_count, 2,
      `명시적 ungroup 2건 surface`);
    // auto_ungrouped_ids 가 잔여 C 의 id 포함 — 1-member trigger 검증의 핵심.
    assert.deepStrictEqual(ungrpBody.auto_ungrouped_ids, [ids[2]],
      `1-member auto-ungroup trigger 발화 — 잔여 1 member (C) 자동 해제됨`);

    // 최종 server 상태 — 3 doc 모두 folder_id NULL.
    const finalA = await getDocFolderId(ids[0]);
    const finalB = await getDocFolderId(ids[1]);
    const finalC = await getDocFolderId(ids[2]);
    assert.strictEqual(finalA, null, `A.folder_id NULL 처리됨 (명시적)`);
    assert.strictEqual(finalB, null, `B.folder_id NULL 처리됨 (명시적)`);
    assert.strictEqual(finalC, null,
      `C.folder_id NULL 처리됨 (auto-ungroup trigger — 잔여 1건 자동 해제)`);
  } finally {
    for (const id of ids) await deleteDoc(id);
  }
});

// cascade-toast: group 생성 → toast notification dismissible (3초).

test("cascade-toast: 3-doc group 생성 → 'Grouped 3' toast 가시 + TOAST_DURATION_MS_CD (3.2초) 후 자동 dismiss", async () => {
  // 격리 seed 3 doc.
  const titles = [
    makeTitle("acg-tst-A", 0),
    makeTitle("acg-tst-B", 0),
    makeTitle("acg-tst-C", 0),
  ];
  const ids: number[] = [];
  for (const t of titles) {
    const r = await postCreate({
      title: t,      author: "toast-tester", html_body: makeHtmlBody(t),
    });
    ids.push(r.id);
  }
  try {
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${serverUrl}/#clauded-docs`, { waitUntil: "networkidle" });
      await page.locator("tr.doc-row").first().waitFor({ state: "visible" });

      // 3 doc multi-select + group 결성.
      for (const t of titles) await checkRowByTitle(page, t);
      await clickGroupCreateButton(page);

      // 토스트 가시 — '.doc-toast.ok' 매칭 + 'role="status" aria-live="polite"'.
      // ARIA live region 검증으로 a11y screen reader announce 정합 확인.
      const toast = page.locator(".doc-toast.ok", { hasText: "Grouped 3" });
      await toast.waitFor({ state: "visible", timeout: 3000 });

      // role + aria-live 속성 검증 — accessibility 회귀 방지.
      const role = await toast.getAttribute("role");
      const ariaLive = await toast.getAttribute("aria-live");
      assert.strictEqual(role, "status", `토스트 role=status (WCAG 4.1.3 status messages)`);
      assert.strictEqual(ariaLive, "polite", `토스트 aria-live=polite (assertive 아님)`);

      // TOAST_DURATION_MS_CD = 3200 ms 후 자동 dismiss — setToast(null) 트리거.
      //   · 토스트 DOM 자체가 detach (`toast && (...)`).
      //   · waitFor state=detached 로 3.5초 윈도우 안에서 dismiss 확인 (margin 0.3초).
      await toast.waitFor({ state: "detached", timeout: 4000 });
    } finally {
      await context.close();
    }
  } finally {
    for (const id of ids) await deleteDoc(id);
  }
});
