# Comment & Logging Rules (Cross-Cutting Concern)

Applies to all DEV and QA agents.

## Agent Injection Core

> The block below (between the `AGENT-INJECT` markers) is extracted verbatim by a SubagentStart hook and injected into DEV/QA subagents. Edit it here only.

<!-- AGENT-INJECT:START -->
**Comment-rule core (auto-injected for DEV/QA agents · full rule: `~/.claude/scoped/shared-comment-logging.md`)**

TOP PROHIBITIONS (most-violated — read these first):
- **NO history / change-narration / attribution** — git owns history; "why" = DESIGN RATIONALE only, never change-narration. Forbidden: date-stamps, before/after narration, A→B change notes, version/wave/ADR tags, authorship/review attribution. Owner/ticket metadata ONLY inside the TODO format. **No commented-out/disabled dead code** kept "for rollback/reference" → DELETE it (git restores).
- **NO over-commenting (density gate — ceiling, not floor)**: comment ONLY when "why" is non-obvious from names/types/context · self-evident code → NO comment · appending `— because …` to a self-evident line does NOT license it · when in doubt → omit.
- **NO narrative endings** — bullet / noun-phrase only · compress causality with `→ — , +`. **NO mid-sentence line-wrap** — one clause terminates on its own `//` line; never split ONE sentence across consecutive `//` continuation lines (distinct points → separate complete lines/bullets). Does NOT forbid the 1–3-sentence header or multiple separate one-line comments.
- **ONE essence line default → `/** */` on overflow** — a comment states only the non-obvious essence in ONE concise `//` line · verbose 구구절절 prose FORBIDDEN (code already shows "what"). "Why" too big for one line → on a declaration-attached function/method/class, a formal `/** */` docblock (summary line + structured semantics), NEVER stacked `//` continuation lines NOR a sprawling inline paragraph. `/** */` triggers = orthogonal axes: public-API/exported scope OR a declaration's internal "why" over one line · one-line-sufficient internal note stays `//`, and a single variable whose why overflows → compress/extract (block = OVERKILL either way) · separate, distinct points stay as separate one-line `//` comments (targets ONE continued thought, not two). Escalation = `/** */`-bearing langs (TS/JS/Java/C-family); non-`/** */` langs use the idiomatic block — Python: PEP 8 `#` block, docstrings only for module/class/def.
- **NO `console.*` in production** (test files exempt) → use framework logger.

REMAINING RULES:
- Comment language precedence (highest wins): 1) user-specified language in task instruction (e.g., a project CLAUDE.md specifying English-only) → top · 2) new comment → Korean (default) · 3) editing existing comment → match its existing language. Identifiers/code/API names → original form. Governs COMMENT language only — server logs stay English.
- Explain **"why"** (code shows "what") · comments restating code FORBIDDEN · stale comments worse than none → sync with code.
- Log level: error = action-required/failed · warn = potential issue · info = normal state change · debug = dev-only (off in prod). Error logs REQUIRE what + why + context (identifiers, state).
- JSDoc: semantics only · MUST NOT duplicate types (`@param {type}` / `@returns {type}` form FORBIDDEN → `@param value - desc`).
- TODO format: `// TODO(owner/TICKET): reason` — owner + ticket REQUIRED.
- **File/module header = 1–3-sentence purpose summary limit** · file-spanning prose dump FORBIDDEN · complexity-proportional (self-evident module → header MAY be omitted).
- **Mirror = code form only** (naming / imports / error+log) — NEVER copy a sibling's comment density or prose-dump header; when the sibling's comments violate the rules, author COMPLIANT comments instead. Two carve-outs (code-form, so reproduce them): tooling-directive / pragma comments (`// @ts-expect-error`, `/* eslint-disable */`, `// prettier-ignore`, `// #region`, `//<editor-fold>`, codegen anchors) AND a genuinely justified header (per the `shared-comment-logging.md` Justified-header test — architectural role / scope boundary / rejected alternative / usage contract) stay allowed.
<!-- AGENT-INJECT:END -->

## Comment Principles

Explain **"why"** (code expresses "what") · Comments restating code FORBIDDEN · **Stale comments worse than none** — sync with code · Block `/** */` = public API/exported docs **OR** internal "why" too large for one line · line `//` = internal notes (ONE essence line) · **Single Source of Truth**: each fact documented at exactly one declaration site · re-stating it elsewhere (function docstring re-listing type members, etc.) FORBIDDEN — drift risk.

**Length/structure escalation (one essence line → `/** */` docblock)** — DEFAULT: a comment carries only the essence in ONE concise `//` line · verbose 구구절절 explanation FORBIDDEN (code already conveys "what" — restating it in prose is noise, not signal). ESCALATION: when the "why" genuinely cannot fit one line on a **declaration-attached function / method / class comment**, write a formal `/** */` docblock (one-line summary + structured semantics) — NEVER a stack of `//` continuation lines, NEVER a sprawling inline paragraph. `/** */` triggers are two ORTHOGONAL axes: (a) public-API/exported scope (`## Public API Comments`) · (b) a declaration-attached comment whose internal "why" exceeds one line (length axis). Both escalate to a docblock; neither licenses verbose `//`. Demotion guard (additive override, not a style upgrade): a comment meeting NEITHER axis stays a single `//` line or is deleted — `/** */` on a one-line-sufficient internal note is OVERKILL, and a single variable whose why exceeds one line → compress or extract, NEVER a docblock (single-variable `/** */` stays OVERKILL). Language scope: the `//` → `/** */` escalation applies to `/** */`-bearing languages (TS/JS/Java/C-family); non-`/** */` languages use the idiomatic block form — Python: PEP 8 `#` block, docstrings reserved for module/class/function declarations.

```
BAD  → // 이 함수는 사용자 목록을 받아 활성 사용자만 거른 뒤 마지막 로그인 순으로 정렬해 상위 10명을 반환한다 … (구구절절 sprawl)
GOOD → // 활성 사용자 상위 10명 (마지막 로그인 desc)                    ← essence 한 줄
GOOD → /**                                                          ← 선언 부착 "why" 2줄 이상 → docblock
        * 정원 소진 시 429 대신 지수 백오프로 재시도를 흡수.
        * 호출측 일괄 재시도가 정원 회복 직후 동시 폭주(thundering herd)를 유발하기 때문.
        */
```

**Comment language** — precedence (highest wins; `scope-dev.md` "Consistent with existing style" + Project Convention Probe + `shared-search-first.md` Mirror defer here for comment language):
1. a comment language specified in the user's task instruction (e.g., a project CLAUDE.md specifying English-only)
2. new comment → Korean (default)
3. editing an existing comment → match its existing language

Carve-outs: identifiers, code fragments, API names inside comments stay in their original form regardless of tier. This governs **comment** language ONLY — server logs stay English per `## Log Message Composition` → "Server logs in English" (not overridden by tier 2). The Project Convention Probe / Mirror "existing-style" axes govern code style (naming / import order / error+log pattern), NOT comment language.

**Comment style**: bullet / noun-phrase style MUST · narrative full sentences FORBIDDEN · compress causality/parallelism with `→` `—` `,` `+` · verb-stem ending preferred · JSDoc lines stay short noun-phrases, not sentences · box / ASCII-art decoration (`/* ---- */`, banner rules, aligned star columns) FORBIDDEN.

```
BAD  → // 다이어그램 산문에 임베드된 카운트를 기계가 읽을 수 있는 const 로 추출하여 라이브 카운트와 비교하는 기준으로 삼기 위해 센다
GOOD → // 다이어그램 주장 카운트 → 기계검증 const (라이브 비교 기준)
```

**No mid-sentence line-wrap**: a single comment clause/sentence MUST terminate on its own line · splitting ONE thought across consecutive `//` continuation lines FORBIDDEN · each comment line = a self-contained unit · distinct points → separate complete lines (or bullets), never a sentence fragmented mid-way onto the next `//` line. Complements the `→ — , +` causality-compression above (push toward compact single-line comments). Scope (do NOT over-read): forbids CONTINUATION-WRAP only · does NOT forbid (a) the 1–3-sentence file/module header, nor (b) multiple SEPARATE complete one-line comments.

```
BAD  → // 라이브 파일시스템을 읽어 카운트를
       // 비교한 다음 결과를 반환
GOOD → // 라이브 fs 카운트 ↔ 불변식 비교 → 결과 반환
```

## Public API Comments (Block)

- **Two trigger axes (reconciled)**: a `/** */` block is warranted by EITHER public-API/exported scope (this section) OR an internal "why" too large for one `//` line (length axis, `## Comment Principles`) — the param/return/throws/semantics rules below apply to a block from either axis. A one-line-sufficient internal note stays `//`, never a block.
- **Scope**: behavior summary + side effects + call constraints + param semantics + thrown exceptions · NOT for enumerating returned-object members or repeating type-system info · First line: one-line summary · MAY omit if name self-evident · void return: omit · ambiguous return / explicit-thrown exceptions / non-obvious invocations: document
- **Params & returns**: semantics only · MUST NOT duplicate types · TS `@param {type}` / `@returns {type}` form FORBIDDEN → use `@param value - desc`; omit `@returns` when no semantic add-on
- **Returned-object members** → at the type/interface declaration site (`@property` on `@typedef`, or per-field on `interface`); enumerating in function docstring FORBIDDEN · **Generic params** → `@typeParam` MAY be omitted when constraint expresses intent (e.g., `<E extends HTMLElement>`); required only for non-obvious domain meaning
- **`@deprecated` 4 elements REQUIRED**: version introduced · planned removal · replacement · `@link` ref

## Inline Comments

- **Density gate (ceiling, not floor)**: comment ONLY when the "why" is non-obvious from names/types/context · self-evident code gets NO comment · appending `— because …` to a self-evident line does NOT license the comment · when in doubt → omit.
- **One-line sufficiency gate (form, not whether)**: once the density gate clears, the comment MUST be ONE concise essence line · a "why" that cannot honestly fit one line → on a declaration-attached function/method/class comment, escalate to a `/** */` docblock (PRIMARY remedy, per `## Comment Principles` length escalation); on a single variable / inline statement, compress or extract instead (single-variable `/** */` stays OVERKILL) · NEVER stack `//` continuation lines and NEVER cram a run-on paragraph onto one `//` · a 2nd `//` line written to finish a thought is NOT a license to keep both lines — extracting a named helper is a CONDITIONAL secondary only when an independent structural trigger fires (Minimalism gate / size-complexity / Rule-of-Three); comment length alone is NOT such a trigger (distinct, complete points stay as separate one-line comments — this gate targets continuation of ONE thought, not two separate thoughts).
- **Placement**: same-line trailing `//` OR `//` on line above · standalone `/** */` for a single variable is OVERKILL · **Step numbers** `// 1. xxx` for 3+-step sequential logic · **Branch labels** / **Business rules**: only when intent/"why" not inferable from code (subject to the density gate above)
- **Security flags**: prefix `// SECURITY:` for suspicious code · **External refs**: issue/RFC/Stack Overflow URLs · **TODO**: `// TODO(owner/TICKET-123): reason` — owner + ticket REQUIRED

## File / Module Header Comments

File/module header comments limited to a **1–3-sentence purpose summary** ("what this file does, and why") readable at a glance. File-spanning prose dumps FORBIDDEN.

- **Justified header** — only when carrying one of the below, and compressed:
  - module's architectural role non-obvious from name → 1-sentence role summary
  - scope boundary (does NOT handle X) → minimum needed to prevent misuse
  - non-obvious design decision (why this approach, rejected alternative) → load-bearing "why"
  - public module / exported interface → short usage contract (read without the implementation)
- **Over-explaining prose-dump (FORBIDDEN)**:
  - exceeds ~5 lines without adding non-obvious information
  - prose restating hierarchy/structure already shown by exports/structure
  - "This file contains ..." / "이 파일은 ... 한다" preamble (name already says it)
  - 10+-line prose of operational mechanism (code already expresses it)
  - author / date / bug-ID / change-history (git owns — see `## Comments That MUST NOT Be Written`)
- **Complexity-proportional**: header length ∝ module complexity · simple/self-evident module → header MAY be omitted · uniform mandatory headers FORBIDDEN.
- Inline density governed by `## Inline Comments` density gate (header scope is file/module, orthogonal); per-fact SoT governed by `## Comment Principles` Single Source of Truth — header section cross-references rather than restates.
- **Convention-mirror precedence (SoT)**: the Project Convention Probe / `style_ref` / Search-First Mirror (`scope-dev.md`, `shared-search-first.md`) extract **code-form axes only** (naming case / import order / error+log pattern). A mirrored sibling is NEVER a precedent for comment density or header length — when a sibling's own header violates THIS section (prose-dump, history/attribution, over-commenting), the new file's header obeys THIS section, not the sibling: author a COMPLIANT header, never reproduce the violation to match. Mirror governs HOW code is shaped; this section governs WHAT/how-much is commented. Two carve-outs (NOT mirror-licensing — each stands on its own merit): (a) **Tooling-directive / pragma comments are code-form — reproduce them.** A comment that the compiler / linter / formatter / folding-tool / codegen reads as a directive (`// @ts-expect-error`, `// @ts-ignore`, `/* eslint-disable */` `/* eslint-disable-next-line */`, `// prettier-ignore`, `// #region` / `// #endregion`, `//<editor-fold>` / `//</editor-fold>`, `// @ts-nocheck`, codegen anchors like `// <auto-generated>`) is a load-bearing tooling/lint/folding contract, not narrative — it is code-form and the density/header rules do NOT forbid it; mirror it like any other code convention. (b) A sibling header that independently satisfies the **Justified header** test above is reproduced because the new file passes that test on its own merits — a per-file scope-boundary header that genuinely applies to the new file (e.g. each file in a subsystem legitimately needing the same `does NOT handle X` boundary) is authored on its own merit even when its content overlaps the sibling's; the test, not the mirror, is the authority.

## Comments That MUST NOT Be Written

Comments restating code (logic readable from code needs no comment) · Comments excusing unclear code (improve code instead) · Redundant info already in type system · Over-narration violating the `## Inline Comments` density gate · Cyclomatic complexity > 10 → **decompose first**, never add explanatory comments.

- **History / changelog / attribution comments FORBIDDEN** — git owns change history; "why" means DESIGN RATIONALE, never change-narration. Forbidden forms: date-stamps · before/after narration · A→B change notes · version/wave/ADR tags · authorship/review attribution. Carve-out: owner/ticket metadata permitted ONLY inside the TODO format (`// TODO(owner/TICKET): reason`), nowhere else.
- **Unclear / unverifiable source citations FORBIDDEN** — an inline source-provenance note whose source is vague or uncheckable does not belong in a comment. A checkable external ref (issue / RFC / CVE / Stack Overflow URL) is permitted per `## Inline Comments` → External refs; an unfollowable provenance note is not.
- **Newly commented-out / disabled dead code FORBIDDEN** — never disable-and-keep "for rollback/reference"; DELETE it (git restores). Distinct from `scope-dev.md` "Dead Code Non-Touch" (NOT modifying PRE-EXISTING dead code) — this forbids CREATING new commented-out code.

**Positive rule**: a comment carries ONLY the essence — the non-obvious "why" plus current state. Never history, never narration, never a paraphrase of the code.

## Log Level Criteria

| Level | Criteria | Examples |
|-------|----------|----------|
| **error** | Immediate action required · operation failed | DB connection failure · authentication error · payment failure |
| **warn** | Potential issue · currently functional but warrants attention | Retry triggered · fallback used · deprecated API called |
| **info/log** | Normal events · significant state changes | Server started · batch completed · user logged in |
| **debug** | Development/debugging only · MUST be disabled in production | Function entry/exit · intermediate state values |

## Log Message Composition

- **Error logs 3 elements REQUIRED**: what failed + why + context (identifiers, state) · **Structure**: action + target + result
- **Variables**: template literals · multiple values separated by `|` or commas · **Batch/cron**: include start/completion/failure + processed count
- **Logger selection**: framework-provided · `console.*` in production code FORBIDDEN (test files excluded) · **Structured JSON** in production · fields: timestamp, level, message, context
- **Correlation ID** for distributed tracing · **Timestamps**: UTC ISO 8601 ms precision · **Server logs in English** · user-facing only uses i18n · **Lazy evaluation**: avoid string construction when level threshold not met

## Prohibitions

- Direct `console.*` in production (use framework logger) · Logging sensitive info (passwords/tokens/PII) → see core-security.md
- Empty catch / ignoring error objects (at minimum, log) · Hardcoded identifiers in log messages (pass as variables)
- **log + rethrow in same catch FORBIDDEN** → choose log OR rethrow (prevent duplicate logs)
- **Log injection**: user input written to logs MUST sanitize newlines/delimiters

## Platform-Specific Rules

- **NestJS**: Single logging point via LoggingInterceptor · Built-in Logger or Pino · `console.*` FORBIDDEN
- **Android**: Production builds strip `Log.v`/`Log.d`/`Log.i` via R8/ProGuard `assumenosideeffects` · Timber `DebugTree` debug only · Crashlytics Tree (or equivalent) in release
- **Frontend**: ESLint `no-console` as warning/error in production builds · Error tracking via external service (e.g., Sentry) · replace console.error
