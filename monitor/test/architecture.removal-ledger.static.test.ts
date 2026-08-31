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

interface LedgerToken {
  name: string;
  kind: TokenKind;
}

// B2-5 가 지운 전역 확장 블록의 어휘 — 레지스트리 · 컨테이너 · 그 컨테이너가 그리던 마크업.
// 하나라도 남아 있으면 죽음이 절반만 이뤄진 것임(선언이 남으면 다음 작업이 그것을 되살림).
const LEDGER_TOKENS: LedgerToken[] = [
  { name: "GLOBAL_DETAIL_BLOCKS", kind: "identifier" },
  { name: "GlobalDetailRegion", kind: "identifier" },
  { name: "getGlobalDetailBlocks", kind: "identifier" },
  { name: "getGlobalBlockDetailId", kind: "identifier" },
  { name: "arch-global-blocks", kind: "attribute" },
  { name: "arch-global-block", kind: "attribute" },
  { name: "arch-global-block-body", kind: "attribute" },
  { name: "data-global-block", kind: "attribute" },
];

// 경계 문자 집합 — 식별자와 CSS 이름이 서로 다름. 하이픈이 갈림길임.
const BOUNDARY: Record<TokenKind, string> = {
  identifier: "A-Za-z0-9_$",
  attribute: "-A-Za-z0-9_",
};

function getTokenPattern(token: LedgerToken): RegExp {
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
function getTokenHits(token: LedgerToken, files: string[]): string[] {
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
  const cssToken: LedgerToken = { name: "arch-global-block", kind: "attribute" };
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

  const idToken: LedgerToken = { name: "HealthStrip", kind: "identifier" };
  assert.equal(
    getTokenPattern(idToken).test("await waitForHealthStrip();"),
    false,
    "an identifier must not be read out of a longer identifier that contains it",
  );
  assert.equal(getTokenPattern(idToken).test("<HealthStrip state={s} />"), true, "the real use must still be caught");
});

for (const token of LEDGER_TOKENS) {
  test(`AC-B2-5d the removed ${token.name} is gone from the whole tracked tree`, () => {
    const hits = getTokenHits(token, ROOT_FILES);
    assert.deepEqual(
      hits,
      [],
      `${token.name} was removed, but it still reads at: ${hits.join(", ")}`,
    );
  });
}
