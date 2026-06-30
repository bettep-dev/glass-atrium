// Unit tests for clauded-docs/search-sql SQL builder.
// Runner: node:test (built-in) via tsx — npx tsx --test test/clauded-docs.*.test.ts
//
// Scope (DB 무접속 단위 테스트):
//   - tsvector 가중치 식 (title=A, author=B, body=D) 가 SQL 텍스트에 출현
//   - pg_bigm OR-branch 활성/비활성 분기 텍스트 정확성
//   - 사용자 입력 (q · limit · offset) 이 모두 parameter binding (placeholder) 으로 직렬화 — LLM05 (SQL injection 방어) 검증
//   - rows/count SQL 의 WHERE 절 일관성 — bigmEnabled 변경 시 양쪽 동기화
//   - 특수 문자 / 한국어 / 빈 문자열 등 q 값이 SQL 텍스트에 inline 되지 않음 (escape-by-bind 검증)
//
// Note: 실제 DB 실행 검증은 manual smoke probe 로 분리 (라우트 핸들러 통합 테스트
// 인프라 부재) — 본 파일은 builder pure-function 책임 한정. handleSearch 호출
// 시점에 prisma.$queryRaw(rowsSql) 으로 직렬화되어 placeholder 가 실제 binding
// 으로 치환됨.

import test from "node:test";
import assert from "node:assert/strict";

import { BIGM_PROBE_SQL, buildSearchSql } from "../src/server/clauded-docs/search-sql.js";

// 공통 ctx — 각 테스트가 overrides 로 부분 변경.
// excludeArchived=false default 유지 — 기존 SQL 정확 매칭 invariant 보존
// (새 절 출현 금지 위한 explicit false).
function baseCtx(overrides: Partial<Parameters<typeof buildSearchSql>[0]> = {}) {
  return {
    q: "검색",
    limit: 20,
    offset: 0,
    bigmEnabled: false,
    excludeArchived: false,
    ...overrides,
  };
}

test("buildSearchSql: tsvector 가중치 식 — title=A · author=B · body=D 명시 출현", () => {
  const { rowsSql } = buildSearchSql(baseCtx());
  const sqlText = rowsSql.sql;
  // 가중치 매핑 검증 — 각 칼럼에 정확한 weight letter 가 붙어야 함.
  assert.match(sqlText, /setweight\(to_tsvector\('simple', coalesce\(title,\s*''\)\),\s*'A'\)/);
  assert.match(sqlText, /setweight\(to_tsvector\('simple', coalesce\(author,\s*''\)\),\s*'B'\)/);
  assert.match(sqlText, /setweight\(to_tsvector\('simple', coalesce\(indexable_text,''\)\),\s*'D'\)/);
});

test("buildSearchSql: 정규화 모드 32 명시 — length-normalized rank (high-freq term suppression)", () => {
  const { rowsSql } = buildSearchSql(baseCtx());
  // ts_rank_cd 3번째 인자가 normalization bitmask — 32 = divide by 1 + log(length)
  // (단순 0 이면 길이 보정 없음 → 본문 다중 매칭 우위 재발) .
  assert.match(rowsSql.sql, /ts_rank_cd\([\s\S]+?websearch_to_tsquery\('simple', \?\),\s*32\s*\)/);
});

test("buildSearchSql: bigmEnabled=false — bigm_similarity 미사용 · 0::float8 fallback", () => {
  const { rowsSql, countSql } = buildSearchSql(baseCtx({ bigmEnabled: false }));
  // SELECT 절의 bigm_rank fallback 검증.
  assert.match(rowsSql.sql, /0::float8 AS bigm_rank/);
  // bigm_similarity 호출이 SQL 어디에도 출현하지 않아야 함.
  assert.ok(!/bigm_similarity/.test(rowsSql.sql), "bigm_similarity must not appear when disabled");
  assert.ok(!/bigm_similarity/.test(countSql.sql), "bigm_similarity must not appear in count when disabled");
  // OR-branch `=%` 연산자 미사용 검증.
  assert.ok(!/=%/.test(rowsSql.sql), "=% operator must not appear when bigm disabled");
  assert.ok(!/=%/.test(countSql.sql), "=% operator must not appear in count when bigm disabled");
});

test("buildSearchSql: bigmEnabled=true — bigm_similarity 호출 + OR-branch (=%) 활성화", () => {
  const { rowsSql, countSql } = buildSearchSql(baseCtx({ bigmEnabled: true }));
  // bigm_similarity 가 rows / ORDER BY 모두에 등장.
  assert.match(rowsSql.sql, /monitor\.bigm_similarity\(indexable_text,\s*\?\)::float8/);
  // OR-branch — 한국어 substring 매칭 경로.
  assert.match(rowsSql.sql, /ts @@ websearch_to_tsquery\('simple', \?\) OR indexable_text =% \?/);
  // count SQL 도 동일 WHERE 절 — rows/count 동기화 (mismatch 시 total 과 rows.length 일치 깨짐).
  assert.match(countSql.sql, /ts @@ websearch_to_tsquery\('simple', \?\) OR indexable_text =% \?/);
});

test("buildSearchSql: rows/count WHERE 절 동기화 — bigm 분기 양쪽 동일", () => {
  for (const bigmEnabled of [true, false]) {
    const { rowsSql, countSql } = buildSearchSql(baseCtx({ bigmEnabled }));
    // 두 SQL 모두 동일한 매칭 표현을 포함해야 — 총 count 와 페이지 rows 의 모집단이 일치.
    const rowsHasOr = /OR indexable_text =%/.test(rowsSql.sql);
    const countHasOr = /OR indexable_text =%/.test(countSql.sql);
    assert.equal(rowsHasOr, countHasOr, `OR branch mismatch when bigmEnabled=${bigmEnabled}`);
  }
});

test("buildSearchSql: prefix 절 미생성 — prefix 컬럼은 schema 에 없음 (drift guard)", () => {
  // monitor.documents 에 prefix 컬럼 부재 — 절이 생성되면 runtime SQL error.
  const { rowsSql, countSql } = buildSearchSql(baseCtx());
  assert.ok(!/prefix::text =/.test(rowsSql.sql), "no prefix clause in rows SQL");
  assert.ok(!/prefix::text =/.test(countSql.sql), "no prefix clause in count SQL");
});

test("buildSearchSql: 사용자 입력 q 가 SQL text 에 inline 되지 않음 (parameter binding 검증)", () => {
  // SQL injection 시도 패턴 — Prisma.sql 태그드 템플릿이 escape 책임.
  const malicious = `'; DROP TABLE monitor.documents; --`;
  const { rowsSql, countSql } = buildSearchSql(baseCtx({ q: malicious }));
  // SQL 텍스트에 malicious 문자열이 출현하면 binding 실패 (즉시 fatal — 매우 위험).
  assert.ok(!rowsSql.sql.includes(malicious), `q must be bound, not inlined — got: ${rowsSql.sql.slice(0, 200)}`);
  assert.ok(!countSql.sql.includes(malicious), `q must be bound, not inlined in count — got: ${countSql.sql.slice(0, 200)}`);
  // values 배열에 정확히 1번 (rows) / 1번 (count) 이상 등장 — 실제 binding 으로 전달됨을 확인.
  assert.ok(rowsSql.values.includes(malicious), "q must be present in bound values");
  assert.ok(countSql.values.includes(malicious), "q must be present in count bound values");
});

test("buildSearchSql: 한국어 q (검색테스트) — 직렬화 안전 + values 에 포함", () => {
  const { rowsSql } = buildSearchSql(baseCtx({ q: "검색테스트" }));
  // 한국어 q 가 SQL 텍스트에 literal 로 inline 되지 않아야 함 — 모두 placeholder.
  assert.ok(!rowsSql.sql.includes("검색테스트"), "Korean q must be bound, not inlined");
  assert.ok(rowsSql.values.includes("검색테스트"), "Korean q must appear in values");
});

test("buildSearchSql: limit / offset — placeholder binding · 정수만 허용", () => {
  const { rowsSql } = buildSearchSql(baseCtx({ limit: 50, offset: 100 }));
  // LIMIT / OFFSET 도 binding — direct interpolation 금지.
  assert.match(rowsSql.sql, /LIMIT \?/);
  assert.match(rowsSql.sql, /OFFSET \?/);
  assert.ok(rowsSql.values.includes(50), "limit must be in bound values");
  assert.ok(rowsSql.values.includes(100), "offset must be in bound values");
});

test("buildSearchSql: ORDER BY — lexical_rank + bigm_rank 합산 정렬", () => {
  const { rowsSql } = buildSearchSql(baseCtx({ bigmEnabled: true }));
  // ORDER BY 절이 ts_rank_cd 와 bigm_similarity 의 합산을 1차 정렬 키로 사용해야 함.
  // (단순히 lexical_rank 컬럼만 정렬하면 SELECT 표현식이 inline 되어 SQL 표준상 동작하지만, 명시적 식이 더 안전.)
  assert.match(
    rowsSql.sql,
    /ORDER BY\s*\(\s*ts_rank_cd\([\s\S]+?\)\s*\+\s*monitor\.bigm_similarity\(indexable_text,\s*\?\)::float8\s*\)\s*DESC/,
  );
  // created_at DESC, id DESC 보조 정렬 키 유지.
  assert.match(rowsSql.sql, /created_at DESC,\s*id DESC/);
});

test("buildSearchSql: ts_headline snippet — title=A 가중치와 별개 · indexable_text 기반 유지", () => {
  const { rowsSql } = buildSearchSql(baseCtx());
  // snippet 은 본문 기반 — 가중치와 무관 (UI 표시용).
  assert.match(
    rowsSql.sql,
    /ts_headline\(\s*'simple',\s*indexable_text,\s*websearch_to_tsquery\('simple', \?\)/,
  );
  // MaxFragments / MaxWords / MinWords 옵션 보존.
  assert.match(rowsSql.sql, /MaxFragments=2/);
  assert.match(rowsSql.sql, /MaxWords=25/);
  assert.match(rowsSql.sql, /MinWords=8/);
});

test("buildSearchSql: 결정성 — 동일 ctx → 동일 SQL 텍스트 + 동일 values 배열", () => {
  const ctx = baseCtx({ q: "monitor", bigmEnabled: true });
  const a = buildSearchSql(ctx);
  const b = buildSearchSql(ctx);
  assert.equal(a.rowsSql.sql, b.rowsSql.sql);
  assert.equal(a.countSql.sql, b.countSql.sql);
  assert.deepEqual(a.rowsSql.values, b.rowsSql.values);
  assert.deepEqual(a.countSql.values, b.countSql.values);
});

test("BIGM_PROBE_SQL: pg_extension 조회 — extname='pg_bigm' literal 만 포함 · 사용자 입력 없음", () => {
  // probe SQL 은 startup 전용 — 사용자 입력 binding 없음.
  assert.equal(BIGM_PROBE_SQL.values.length, 0, "probe SQL must have zero bound values");
  assert.match(BIGM_PROBE_SQL.sql, /pg_extension/);
  assert.match(BIGM_PROBE_SQL.sql, /'pg_bigm'/);
});
