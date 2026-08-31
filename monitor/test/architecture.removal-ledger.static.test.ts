// 제거 원장 — 이 작업이 지운 이름들이 정말 어디에도 남지 않았음을 잼 (ADR-10).
// 계기는 화면이 아니라 텍스트임: 렌더 테스트는 '그려지지 않음' 만 재므로, 호출되지 않은 채
// 선언만 살아남은 죽은 어휘를 보지 못함.
//
// ADR-13 이 얹은 두 규칙과 넓힌 루트를 그대로 따름:
//  · 판별성 — 제거 단위 밖에 같은 이름의 선언이 있는 토큰은 원장에 올리지 않음(영원히 붉어짐).
//  · 경계 고정 — 일치는 부분문자열이 아님. 식별자는 앞뒤가 [A-Za-z0-9_$] 가 아닐 것,
//    CSS 클래스·data 속성은 앞뒤가 [-A-Za-z0-9_] 가 아닐 것. 하이픈이 경계 문자에 들어가야
//    `arch-global-block` 이 `arch-global-block-body` 안에서 잡히지 않음.
//  · 루트 — `git ls-files` 전수에서 이 원장 파일 자신만 뺌. 죽은 어휘를 여기 적어 두는 것이
//    이 파일의 일이므로 자기 자신은 셀 수 없음.
//
// Runner: npx tsx --test test/architecture.removal-ledger.static.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const LEDGER_PATH = relative(REPO_ROOT, resolve(__dirname, "architecture.removal-ledger.static.test.ts"));

type TokenKind = "identifier" | "attribute";

// 경계 고정 일치가 필요한 최소 형태 — 원장 항목과 제외 항목이 같은 계기를 나눠 씀.
interface NamedToken {
  name: string;
  kind: TokenKind;
}

interface LedgerToken extends NamedToken {
  // 이 이름을 죽인 AC — 원장이 여러 작업의 어휘를 함께 들고 있으므로 실패 제목이 작업을 불러야 함.
  ac: string;
}

// B2-5 가 지운 전역 확장 블록의 어휘 — 레지스트리 · 컨테이너 · 그 컨테이너가 그리던 마크업.
// 하나라도 남아 있으면 죽음이 절반만 이뤄진 것임(선언이 남으면 다음 작업이 그것을 되살림).
const LEDGER_TOKENS: LedgerToken[] = [
  { name: "GLOBAL_DETAIL_BLOCKS", kind: "identifier", ac: "AC-B2-5d" },
  { name: "GlobalDetailRegion", kind: "identifier", ac: "AC-B2-5d" },
  { name: "getGlobalDetailBlocks", kind: "identifier", ac: "AC-B2-5d" },
  { name: "getGlobalBlockDetailId", kind: "identifier", ac: "AC-B2-5d" },
  { name: "arch-global-blocks", kind: "attribute", ac: "AC-B2-5d" },
  { name: "arch-global-block", kind: "attribute", ac: "AC-B2-5d" },
  { name: "arch-global-block-body", kind: "attribute", ac: "AC-B2-5d" },
  { name: "data-global-block", kind: "attribute", ac: "AC-B2-5d" },

  // B2-6a 가 지운 지도 위 두 줄 — 큐 스트립과 health 요약 스트립, 그리고 둘만 부르던 읽기 함수들.
  // `getStoreErrorAR` 의 호출 둘은 함께 사라진 큐 효과 안에 있었고, `.arch-queue-fact` 는
  // 두 스트립의 사실 칸 전용 클래스였음 — 이사한 경보는 `arch-queue-error` 를 씀.
  { name: "QueueStrip", kind: "identifier", ac: "AC-B2-6d" },
  { name: "getPendingCountAR", kind: "identifier", ac: "AC-B2-6d" },
  { name: "getTopSignalAR", kind: "identifier", ac: "AC-B2-6d" },
  { name: "getStoreErrorAR", kind: "identifier", ac: "AC-B2-6d" },
  { name: "QUEUE_PROPOSALS_LABEL", kind: "identifier", ac: "AC-B2-6d" },
  { name: "QUEUE_LEARNING_LABEL", kind: "identifier", ac: "AC-B2-6d" },
  { name: "arch-queue-strip", kind: "attribute", ac: "AC-B2-6d" },
  { name: "data-queue-source", kind: "attribute", ac: "AC-B2-6d" },
  { name: "arch-queue-fact", kind: "attribute", ac: "AC-B2-6d" },
  { name: "HealthStrip", kind: "identifier", ac: "AC-B2-6d" },
  { name: "getMapStripReadings", kind: "identifier", ac: "AC-B2-6d" },
  { name: "MAP_STRIP_CARD_IDS", kind: "identifier", ac: "AC-B2-6d" },
  { name: "arch-health-strip", kind: "attribute", ac: "AC-B2-6d" },
  { name: "data-health-fact", kind: "attribute", ac: "AC-B2-6d" },

  // B2-6b 가 지운 KPI 집계 — 스트립이 사라지면서 그 셈을 그리는 자리가 없어졌음. 화면 몫의
  // 분모는 표의 행 수였다가 표마저 걷히며(ADR-20) 노드 상세 패널의 부품 항목 수가 됐고, 그 사실은
  // AC-B2-4b 가 여전히 잼(다만 이제 '연 노드의 항목 수'를 셈). 카드 tone 버킷의 분할 불변식은
  // health-model 단위 시험이 resolveCardFacts 에서 직접 잼. 남은 것은 아무도 부르지 않는 세 이름뿐이었음.
  { name: "computeOverviewKpis", kind: "identifier", ac: "AC-B2-6b" },
  { name: "EMPTY_OVERVIEW_KPIS", kind: "identifier", ac: "AC-B2-6b" },
  { name: "getMapHealthKpis", kind: "identifier", ac: "AC-B2-6b" },

  // ADR-20 이 지운 라이브 상태 표 — 컴포넌트 · 그 행의 확장 영역 id 를 짓던 두 함수 ·
  // 표 전용 클래스 여섯. 판정은 노드가, 나머지 사실은 노드 상세 패널이 실어 나름.
  // `getRowDetailId`/`toDetailIdPart` 는 행의 aria-controls 전용이었음 — 패널에는 접을 것이
  // 없어 영역을 id 로 가리킬 일이 없고, 상세는 제 부품 항목 안에 서므로 자리로 결정됨.
  // 세 클래스(`arch-live-table` · `-wrap` · `-scroll`)를 따로 적음: 경계 문자에 하이픈이
  // 들어가 있어 짧은 이름이 긴 이름 안에서 잡히지 않으므로, 하나만 적으면 나머지가 남아도 초록임.
  { name: "HealthPartTable", kind: "identifier", ac: "ADR-20" },
  { name: "getRowDetailId", kind: "identifier", ac: "ADR-20" },
  { name: "toDetailIdPart", kind: "identifier", ac: "ADR-20" },
  { name: "arch-live-table", kind: "attribute", ac: "ADR-20" },
  { name: "arch-live-table-wrap", kind: "attribute", ac: "ADR-20" },
  { name: "arch-live-table-scroll", kind: "attribute", ac: "ADR-20" },
  { name: "arch-row-toggle", kind: "attribute", ac: "ADR-20" },
  { name: "arch-row-caret", kind: "attribute", ac: "ADR-20" },
  { name: "arch-run-cell", kind: "attribute", ac: "ADR-20" },

  // 표를 재던 하네스 어휘 — 열 이름표 · 표 모양 판독기 · 칸 판독기 · 확장 컨트롤 프로브 ·
  // 행 등장 대기 · 행 펼치기. 표가 사라진 자리에 이 이름들이 남으면 다음 작업이 그것을 보고
  // 표가 아직 있다고 읽음. 재던 사실 자체는 패널을 여는 계기로 옮겨 갔음(merged-surface e2e).
  { name: "LIVE_TABLE_HEADERS", kind: "identifier", ac: "ADR-20" },
  { name: "getLiveTableShape", kind: "identifier", ac: "ADR-20" },
  { name: "getPartCells", kind: "identifier", ac: "ADR-20" },
  { name: "getRowExpansionProbe", kind: "identifier", ac: "ADR-20" },
  { name: "waitForDaemonRows", kind: "identifier", ac: "ADR-20" },
  { name: "expandHookRow", kind: "identifier", ac: "ADR-20" },
];

// 원장에 올릴 수 없는 이름과 그 이유(ADR-13 판별성) — 제거 단위 밖에 같은 선언이 살아 있으면
// 텍스트 계수는 영원히 0 이 되지 않음. 이유를 주석이 아니라 단언으로 두어, 밖의 선언이 사라지는
// 날 이 자리가 붉어지며 '이제 원장에 올릴 수 있음' 을 알리게 함.
const DISCRIMINABILITY_EXCLUSIONS: { name: string; kind: TokenKind; declaredIn: string }[] = [
  // 지도의 학습 로그 상수는 죽었지만 improvement 화면이 같은 이름을 제 몫으로 선언함.
  // 그 죽음은 텍스트가 아니라 AC-B2-6c 의 요청 계수 0 이 잼.
  { name: "LEARNING_LOG_URL", kind: "identifier", declaredIn: "monitor/public/src/screens/improvement.jsx" },
  // tone 속성은 스트립과 함께 죽지 않았고 표와 함께 죽지도 않음 — 노드 상세 패널의 부품 항목이
  // 같은 어휘로 판정을 실으며(ADR-20), 하네스의 준비 앵커가 여전히 바로 그 속성임.
  { name: "data-health-tone", kind: "attribute", declaredIn: "monitor/public/src/screens/architecture.jsx" },
];

// 지우지 않은 것 — 이사한 경보의 본체와 live 스트립. 원장이 넘치게 지워지지 않았음을 재는 반대 방향.
const SURVIVING_TOKENS: LedgerToken[] = [
  { name: "StripAlertAR", kind: "identifier", ac: "AC-B2-6d" },
  { name: "HEALTH_STORE_LABELS_AR", kind: "identifier", ac: "AC-B2-6d" },
  { name: "getHealthStoreErrorsAR", kind: "identifier", ac: "AC-B2-6d" },
  { name: "LiveStrip", kind: "identifier", ac: "AC-B2-6d" },
  { name: "arch-queue-error", kind: "attribute", ac: "AC-B2-6d" },
  { name: "arch-live-strip", kind: "attribute", ac: "AC-B2-6d" },
  // KPI 가 읽던 카드 fold — 집계가 접힌 뒤 tone 버킷 불변식이 서는 자리가 바로 여기임.
  { name: "resolveCardFacts", kind: "identifier", ac: "AC-B2-6b" },

  // 표가 나르던 사실이 이사한 자리 (ADR-20) — 넘치게 지워지지 않았음을 재는 반대 방향.
  // 행을 부르던 두 data 속성은 그대로 살아 항목과 상세를 이름으로 붙듦: 이름이 같아야
  // 하네스가 재던 사실이 옮겨졌음을 보일 수 있고, 다른 어휘로 바꾸면 이사가 아니라 재작성이 됨.
  { name: "NodePartHealth", kind: "identifier", ac: "ADR-20" },
  { name: "getHealthPartRows", kind: "identifier", ac: "ADR-20" },
  { name: "HEALTH_ROW_DETAILS", kind: "identifier", ac: "ADR-20" },
  { name: "DaemonRunDetail", kind: "identifier", ac: "ADR-20" },
  { name: "data-node-health", kind: "attribute", ac: "ADR-20" },
  { name: "data-health-row", kind: "attribute", ac: "ADR-20" },
  { name: "data-daemon-row", kind: "attribute", ac: "ADR-20" },
  { name: "data-health-detail", kind: "attribute", ac: "ADR-20" },
  { name: "data-daemon-detail", kind: "attribute", ac: "ADR-20" },
  { name: "arch-part-entry", kind: "attribute", ac: "ADR-20" },
  { name: "arch-part-drill", kind: "attribute", ac: "ADR-20" },
  // 표 안에 서 있던 경보가 페이지로 올라간 자리 — 이 클래스가 그 이사 자체임.
  { name: "arch-health-alert-wrap", kind: "attribute", ac: "ADR-20" },
];

// 경계 문자 집합 — 식별자와 CSS 이름이 서로 다름. 하이픈이 갈림길임.
const BOUNDARY: Record<TokenKind, string> = {
  identifier: "A-Za-z0-9_$",
  attribute: "-A-Za-z0-9_",
};

function getTokenPattern(token: NamedToken): RegExp {
  const literal = token.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edge = BOUNDARY[token.kind];
  return new RegExp(`(?<![${edge}])${literal}(?![${edge}])`, "g");
}

// 추적 파일 전수 — 원장 자신만 뺌. dist/ 는 무시 대상이라 ls-files 가 애초에 내지 않음.
function getRootFiles(): string[] {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((path) => path.length > 0 && path !== LEDGER_PATH);
}

// 토큰 하나가 살아 있는 자리 — 파일과 줄까지 냄. 개수만 내면 어디를 고칠지가 메시지에 없음.
function getTokenHits(token: NamedToken, files: string[]): string[] {
  const pattern = getTokenPattern(token);
  const hits: string[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      // 심볼릭 링크 · 서브모듈 자리처럼 읽을 본문이 없는 항목 — 텍스트가 없으므로 셀 것도 없음.
      continue;
    }
    if (!text.includes(token.name)) continue;

    text.split("\n").forEach((line, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
    });
  }

  return hits;
}

const ROOT_FILES = getRootFiles();

test("ADR-13 the ledger scans the whole tracked tree, minus itself", () => {
  assert.ok(
    ROOT_FILES.length > 100,
    `the root set must be the tracked tree — read ${ROOT_FILES.length} files, which is a scan that found nothing to look at`,
  );

  // 개수만으로는 넓힘이 지켜지지 않음 — 루트가 `monitor/` 로 되돌아가도 이 트리에는 수백 개가
  // 남아 위 절이 초록임. ADR-13 이 넓힌 것은 크기가 아니라 경계이므로 그 경계를 직접 잼:
  // 화면 트리 밖의 파일이 최소 하나는 스캔에 들어와야 함(오늘 `LiveStrip` 이 사는 자리가 거기임).
  assert.ok(
    ROOT_FILES.some((path) => !path.startsWith("monitor/")),
    "the root set must reach past monitor/ — a dead name survives outside the screen's own tree, and that is why ADR-13 widened the root",
  );

  assert.ok(
    !ROOT_FILES.includes(LEDGER_PATH),
    "the ledger must exclude itself — it is the one file whose job is to name the dead vocabulary",
  );
});

// 경계 고정이 정말 판별하는지 먼저 잼 — 부분문자열로 재는 계기는 남의 생사를 제 판정으로 읽고,
// 그런 계기 위에 세운 0 건은 아무것도 증명하지 않음. 두 방향을 함께 잼: 감싼 이름은 안 잡히고,
// 진짜 쓰임은 잡힘.
test("ADR-13 the ledger match is boundary-anchored, never a substring", () => {
  const cssToken: LedgerToken = { name: "arch-global-block", kind: "attribute", ac: "AC-B2-5d" };
  assert.equal(
    getTokenPattern(cssToken).test('className="arch-global-block-body"'),
    false,
    "a CSS name must not be read out of a longer name it prefixes — the hyphen belongs in the boundary class",
  );
  assert.equal(
    getTokenPattern(cssToken).test('className="arch-global-block"'),
    true,
    "the real use must still be caught, or the ledger is green by blindness",
  );

  const idToken: LedgerToken = { name: "HealthStrip", kind: "identifier", ac: "AC-B2-6d" };
  assert.equal(
    getTokenPattern(idToken).test("await waitForHealthStrip();"),
    false,
    "an identifier must not be read out of a longer identifier that contains it",
  );
  assert.equal(getTokenPattern(idToken).test("<HealthStrip state={s} />"), true, "the real use must still be caught");
});

for (const token of LEDGER_TOKENS) {
  test(`${token.ac} the removed ${token.name} is gone from the whole tracked tree`, () => {
    const hits = getTokenHits(token, ROOT_FILES);
    assert.deepEqual(
      hits,
      [],
      `${token.name} was removed, but it still reads at: ${hits.join(", ")}`,
    );
  });
}

for (const excluded of DISCRIMINABILITY_EXCLUSIONS) {
  test(`AC-B2-6d ${excluded.name} stays off the ledger — a live declaration outside the removal unit holds it`, () => {
    assert.equal(
      LEDGER_TOKENS.some((token) => token.name === excluded.name),
      false,
      `${excluded.name} is on the ledger, but ADR-13 discriminability forbids it — its count can never reach zero`,
    );

    // 이유가 실재하는지 잼 — 밖의 선언이 사라지면 이 절이 붉어지고, 그때 비로소 원장 후보가 됨.
    const hits = getTokenHits(excluded, ROOT_FILES);
    assert.ok(
      hits.some((hit) => hit.startsWith(`${excluded.declaredIn}:`)),
      `${excluded.name} must still read in ${excluded.declaredIn} — without that declaration the exclusion has no ground, and the token belongs on the ledger`,
    );
  });
}

for (const token of SURVIVING_TOKENS) {
  test(`${token.ac} the surviving ${token.name} still reads somewhere in the tracked tree`, () => {
    assert.ok(
      getTokenHits(token, ROOT_FILES).length > 0,
      `${token.name} survives this removal — it reads nowhere, so the deletion went one name too far`,
    );
  });
}
