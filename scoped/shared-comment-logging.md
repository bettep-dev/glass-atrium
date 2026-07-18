# Comment & Logging Rules (Cross-Cutting Concern)

Applies to all DEV and QA agents.

## Agent Injection Core

> The block between the `AGENT-INJECT` markers is extracted verbatim by a SubagentStart hook and injected into DEV/QA subagents. Edit it here only.

<!-- AGENT-INJECT:START -->
**Comment-rule core (auto-injected DEV/QA · full: `~/.glass-atrium/scoped/shared-comment-logging.md`)**

TOP PROHIBITIONS (read first):
- **NO history / narration / attribution** — git owns history; "why" = DESIGN RATIONALE, never change-narration. Forbidden: date-stamps, before/after or A→B notes, version/wave/ADR tags, authorship/review. Owner/ticket ONLY in TODO. **No commented-out dead code** "for rollback" → DELETE.
- **Density gate (ceiling, not floor)**: comment ONLY when "why" is non-obvious from names/types/context · self-evident code → NO comment · `— because …` does NOT license it · in doubt → omit.
- **One essence line → `/** */` on overflow**: non-obvious "why" in ONE concise `//` line; verbose prose FORBIDDEN. Overflow on a declaration (function/method/class) → `/** */` docblock, NEVER stacked `//` nor a paragraph. `/** */` triggers: public-API/exported OR a declaration's internal "why" >1 line. One-line internal note stays `//`; a variable whose why overflows → compress/extract (not a block). Distinct points → separate `//` comments. Non-`/** */` langs → idiomatic block (Python: `#`, docstrings for module/class/def only).
- **NO mid-sentence line-wrap** — one clause per `//` line; never split ONE sentence across continuation lines. Compress causality with `→ — , +`, bullet/noun-phrase only. Does NOT forbid the 1–3-sentence header nor multiple one-line comments.
- **NO `console.*` in production** (test files exempt) → framework logger.

REMAINING RULES:
- Comment language (highest wins): user-specified in task/CLAUDE.md → new = Korean (default) → editing existing = match its language. Identifiers/API names keep original form. COMMENT language only — server logs stay English.
- Explain **"why"**; restating code FORBIDDEN · stale comments worse than none → sync with code.
- Log level: error=action-required/failed · warn=potential issue · info=state change · debug=dev-only (off in prod). Error logs need what+why+context.
- JSDoc: semantics only, MUST NOT duplicate types (`@param value - desc`, never `@param {type}`).
- TODO: `// TODO(owner/TICKET): reason` — owner+ticket REQUIRED.
- **File/module header = 1–3-sentence purpose limit** · prose-dump FORBIDDEN · complexity-proportional (self-evident module → omit).
- **Mirror = code form only** (naming/imports/error+log) — NEVER copy a sibling's comment density or header prose; sibling violates → author COMPLIANT comments. Two carve-outs (reproduce): tooling/pragma directives (`// @ts-expect-error`, `/* eslint-disable */`, `// prettier-ignore`, `// #region`, `//<editor-fold>`, codegen anchors) AND a header passing the Justified-header test (architectural role / scope boundary / rejected alternative / usage contract).
<!-- AGENT-INJECT:END -->

## Comment Principles

- Explain **"why"** (code shows "what") · comments restating code FORBIDDEN · **stale comments worse than none** → sync with code.
- **Single Source of Truth**: each fact documented at exactly one declaration site · re-stating elsewhere (docstring re-listing type members) FORBIDDEN (drift risk).
- **One essence line → `/** */` docblock escalation**: DEFAULT is ONE concise `//` line — verbose/rambling prose FORBIDDEN. When "why" genuinely cannot fit one line on a **declaration-attached function/method/class**, write a formal `/** */` docblock (one-line summary + structured semantics), NEVER stacked `//` lines nor a sprawling paragraph. Triggers = two ORTHOGONAL axes: (a) public-API/exported scope (`## Public API Comments`); (b) a declaration's internal "why" exceeding one line. **Demotion guards (OVERKILL)**: a comment meeting NEITHER axis stays one `//` line or is deleted; `/** */` on a one-line-sufficient note is OVERKILL; a single variable whose why overflows → compress/extract, never a docblock. Language scope: escalation applies to `/** */`-bearing langs (TS/JS/Java/C-family); others use the idiomatic block (Python: PEP 8 `#`, docstrings for module/class/def).

```
BAD  → // This function takes the user list, filters active users, sorts by last login, returns top 10 … (rambling sprawl)
GOOD → // Top 10 active users (last login desc)                     ← one essence line
GOOD → /**                                                          ← declaration-attached "why" over one line → docblock
        * Absorbs retries with exponential backoff instead of 429 on capacity exhaustion.
        * Caller bulk-retry would cause a thundering herd right after capacity recovers.
        */
```

## Comment Language & Style

- **Language precedence** (highest wins; `scope-dev.md` "Consistent with existing style" + Project Convention Probe + `shared-search-first.md` Mirror defer here for comment language):
  1. a comment language specified in the user's task/CLAUDE.md (e.g., English-only)
  2. new comment → Korean (default)
  3. editing an existing comment → match its existing language
- Identifiers/code/API names inside comments stay original form regardless of tier. Governs **comment** language ONLY — server logs stay English (`## Log Message Composition`). Project Convention Probe / Mirror govern code style (naming / import order / error+log), NOT comment language.
- **Style**: bullet/noun-phrase MUST · narrative sentences FORBIDDEN · compress causality with `→ — , +` · verb-stem ending preferred · JSDoc lines = short noun-phrases · box/ASCII-art decoration (`/* ---- */`, banners, star columns) FORBIDDEN.
- **No mid-sentence line-wrap**: a single clause MUST terminate on its own line · splitting ONE thought across consecutive `//` lines FORBIDDEN · distinct points → separate complete lines/bullets. Does NOT forbid (a) the 1–3-sentence header, nor (b) multiple SEPARATE one-line comments.

```
BAD  → // Reads the live filesystem count then
       // compares and returns the result
GOOD → // live fs count ↔ invariant compare → return result
```

## Public API Comments (Block)

- **Two trigger axes**: a `/** */` block is warranted by EITHER public-API/exported scope (this section) OR an internal "why" too large for one `//` line (`## Comment Principles`). A one-line-sufficient internal note stays `//`.
- **Scope**: behavior summary + side effects + call constraints + param semantics + thrown exceptions · NOT for enumerating returned-object members or repeating types · first line = one-line summary (omit if name self-evident) · void return: omit · ambiguous return / explicit throws / non-obvious invocation: document.
- **Params & returns**: semantics only, MUST NOT duplicate types (`@param value - desc`, never `@param {type}` / `@returns {type}`; omit `@returns` when no semantic add-on).
- **Returned-object members** → document at the type/interface declaration site (`@property`/per-field), never in the function docstring. **Generic params** → `@typeParam` omittable when the constraint expresses intent (`<E extends HTMLElement>`).
- **`@deprecated`** REQUIRES 4 elements: version introduced · planned removal · replacement · `@link` ref.

## Inline Comments

- **Density gate (ceiling, not floor)**: comment ONLY when "why" is non-obvious from names/types/context · self-evident code → NO comment · `— because …` does NOT license it · when in doubt → omit.
- **One-line sufficiency gate (form, not whether)**: past the density gate, the comment MUST be ONE essence line. A "why" that cannot fit → declaration-attached function/method/class: escalate to `/** */` docblock (PRIMARY remedy); single variable / inline statement: compress or extract (single-variable `/** */` = OVERKILL). NEVER stack `//` continuation lines nor cram a run-on paragraph. A 2nd `//` line to finish a thought does NOT license keeping both — extracting a named helper is a CONDITIONAL secondary, only when an independent structural trigger fires (Minimalism gate / size-complexity / Rule-of-Three); comment length alone is NOT such a trigger. Distinct complete points stay separate one-line comments (this gate targets continuation of ONE thought).
- **Placement**: same-line trailing `//` or `//` above · **Step numbers** `// 1. xxx` for 3+-step sequential logic · **Branch labels / Business rules**: only when "why" not inferable (subject to the density gate).
- **Security flags**: `// SECURITY:` prefix · **External refs**: issue/RFC/Stack Overflow URLs · **TODO**: `// TODO(owner/TICKET-123): reason` — owner+ticket REQUIRED.

## File / Module Header Comments

Limited to a **1–3-sentence purpose summary** ("what this file does, and why"). File-spanning prose dumps FORBIDDEN.

- **Justified header** — only when carrying one of the below, compressed:
  - architectural role non-obvious from name → 1-sentence role summary
  - scope boundary (does NOT handle X) → minimum to prevent misuse
  - non-obvious design decision / rejected alternative → load-bearing "why"
  - public module / exported interface → short usage contract
- **Prose-dump (FORBIDDEN)**: >~5 lines adding nothing non-obvious · restating structure already shown by exports · "This file contains …" preamble · 10+-line mechanism prose · author/date/bug-ID/change-history (git owns).
- **Complexity-proportional**: header length ∝ module complexity · simple module → omit · uniform mandatory headers FORBIDDEN.
- Inline density governed by `## Inline Comments`; per-fact SoT by `## Comment Principles` — header cross-references, does not restate.
- **Convention-mirror precedence (SoT)**: Project Convention Probe / `style_ref` / Search-First Mirror extract **code-form axes only** (naming / import order / error+log). A mirrored sibling is NEVER a precedent for comment density or header length — when a sibling's header violates THIS section, author a COMPLIANT header, never reproduce the violation. Two carve-outs (each stands on its own merit, NOT mirror-licensing): (a) **Tooling/pragma directives are code-form — reproduce them**: comments a compiler/linter/formatter/folding-tool/codegen reads as directives (`// @ts-expect-error`, `// @ts-ignore`, `/* eslint-disable[-next-line] */`, `// prettier-ignore`, `// #region`/`#endregion`, `//<editor-fold>`, `// @ts-nocheck`, `// <auto-generated>`) are load-bearing contracts, not narrative. (b) A sibling header passing the **Justified-header** test is authored on the new file's own merit (e.g. a per-file `does NOT handle X` boundary legitimately applying) — the test, not the mirror, is the authority.

## Comments That MUST NOT Be Written

Comments restating code · excusing unclear code (improve the code) · redundant type-system info · over-narration violating the density gate · cyclomatic complexity > 10 → **decompose first**, never explain away.

- **History / changelog / attribution FORBIDDEN** — git owns change history; "why" = DESIGN RATIONALE. Forbidden: date-stamps · before/after or A→B notes · version/wave/ADR tags · authorship/review. Carve-out: owner/ticket ONLY in TODO format.
- **Vague / unverifiable source citations FORBIDDEN** — a checkable external ref (issue/RFC/CVE/Stack Overflow URL) is permitted (`## Inline Comments` External refs); an unfollowable provenance note is not.
- **Newly commented-out / disabled dead code FORBIDDEN** — DELETE it (git restores). Distinct from `scope-dev.md` "Dead Code Non-Touch" (not modifying PRE-EXISTING dead code); this forbids CREATING it.

**Positive rule**: a comment carries ONLY the essence — the non-obvious "why" plus current state. Never history, narration, or a paraphrase of the code.

## Log Level Criteria

| Level | Criteria | Examples |
|-------|----------|----------|
| **error** | Immediate action required · operation failed | DB connection failure · auth error · payment failure |
| **warn** | Potential issue · functional but warrants attention | Retry triggered · fallback used · deprecated API called |
| **info/log** | Normal events · significant state changes | Server started · batch completed · user logged in |
| **debug** | Dev/debug only · disabled in production | Function entry/exit · intermediate state values |

## Log Message Composition

- **Error logs 3 elements REQUIRED**: what failed + why + context (identifiers, state) · structure = action + target + result.
- **Variables**: template literals · multiple values `|`- or comma-separated · **Batch/cron**: start/completion/failure + processed count.
- **Logger**: framework-provided · `console.*` in production FORBIDDEN (test files exempt) · **Structured JSON** in production (timestamp, level, message, context).
- **Correlation ID** for distributed tracing · **Timestamps**: UTC ISO 8601 ms · **Server logs in English** · user-facing uses i18n · **Lazy evaluation**: skip string construction below level threshold.

## Prohibitions

- Direct `console.*` in production (use framework logger) · logging sensitive info (passwords/tokens/PII) → see core-security.md.
- Empty catch / ignoring error objects (log at minimum) · hardcoded identifiers in log messages (pass as variables).
- **log + rethrow in same catch FORBIDDEN** → choose one (prevent duplicate logs).
- **Log injection**: user input to logs MUST sanitize newlines/delimiters.

## Platform-Specific Rules

- **NestJS**: single logging point via LoggingInterceptor · Logger or Pino · `console.*` FORBIDDEN.
- **Android**: R8/ProGuard `assumenosideeffects` strips `Log.v/d/i` in release · Timber `DebugTree` debug only · Crashlytics Tree in release.
- **Frontend**: ESLint `no-console` in production builds · error tracking via external service (e.g., Sentry).
