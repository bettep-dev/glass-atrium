# Comment & Logging Rules (Cross-Cutting Concern)

## Agent Injection Core

- **Comment-rule core — the essence only**: a comment carries the non-obvious "why" plus current state, never history, narration, attribution or a paraphrase of the code.
  - The "why" is design rationale, never change narration: git owns history.
  - History shapes: date stamps · before/after or A→B notes · version / wave / ADR / bug-ID tags · authorship or review credit.
  - Owner and ticket appear only in a TODO (`## Inline Comments` → **TODO**).
- **Mirror = code form only**: from a sibling file, mirror naming case, imports, the error+log pattern and layout — never its comment density or header prose.
  - A sibling that breaks this file is no precedent: write compliant comments.
  - Reproduce as-is: tooling and pragma directives (`// @ts-expect-error`, `/* eslint-disable */`, prettier-ignore, region / fold / codegen anchors) and a header that passes **Justified header** (`## File / Module Header Comments`).

## Comment Principles

- **Density gate (ceiling, not floor)**: comment only where the "why" is non-obvious from names, types and surrounding context.
  - Self-evident code takes no comment · an appended `— because …` does not license one · in doubt, omit.
- **Stale comments**: a stale comment is worse than none — change it together with the code it describes.
- **Single Source of Truth**: each fact is documented at exactly one declaration site · restating it elsewhere (a docstring re-listing type members) is FORBIDDEN — drift risk.

## Comment Language & Style

- **Language precedence** for comments, highest wins (log language: `## Log Message Composition`):
  1. a comment language the user's task or `CLAUDE.md` specifies
  2. the target repository's own contributing policy, where that repository states one
  3. editing an existing non-English comment → match its language, so one comment is never left half-translated
  4. otherwise → English, the default in `GLASS_ATRIUM_GLOBAL_RULES.md` → `### Output Language`
- **Form** (every comment, docblock lines included): bullet / noun-phrase MUST — narrative sentences FORBIDDEN, except the 1–3-sentence file header (`## File / Module Header Comments`).
- **Causality**: compress with `→ — , +`.
- **Ending**: verb-stem preferred.
- **Decoration**: box / ASCII-art (`/* ---- */`, banners, star columns) FORBIDDEN.

```
BAD  → // Reads the live filesystem count then
       // compares and returns the result
GOOD → // live fs count ↔ invariant compare → return result
```

## Public API Comments (Block)

- **Two trigger axes**: a `/** */` block is warranted by public-API / exported scope (this section) or by an internal "why" too large for one `//` line (`## Inline Comments`).
- **Scope**: behavior summary + side effects + call constraints + param semantics + thrown exceptions + an ambiguous return or a non-obvious invocation.
- **First line**: a one-line summary, omitted when the name is self-evident.
- **Params & returns**: semantics only, never types (`@param value - desc`, never `@param {type}` / `@returns {type}`) · `@returns` only where it adds semantics, never on a void return.
- **Returned-object members** → document at the type / interface declaration site (`@property` / per-field), never in the function docstring.
- **Generic params** → `@typeParam` is omittable when the constraint already expresses the intent (`<E extends HTMLElement>`).
- **`@deprecated`** REQUIRES: version introduced · planned removal · replacement · `@link` ref.

## Inline Comments

- **One-line sufficiency gate (form, not whether)**: past the density gate, the comment MUST be one essence line; the table below gives the remedy per case.
  - Stacked `//` continuation lines and run-on paragraphs are FORBIDDEN.
  - Distinct complete points stay separate one-line comments — this gate targets continuation of one thought.
  - Helper extraction fires only on an independent structural trigger: `scope-dev.md` → **Minimalism reflex** · `shared-code-structure.md` → Function cap (20 lines OR cyclomatic complexity 10) · `scope-dev.md` → **Rule of Three before abstraction**.
    - Comment length alone never fires it.

| Overflow case | Remedy |
|---|---|
| none — a one-line-sufficient internal note | stays `//` (→ `## Public API Comments (Block)` → **Two trigger axes**) |
| overflow on a declaration-attached function / method / class | a `/** */` docblock, the primary remedy |
| overflow in a language without `/** */` | its idiomatic block (Python: `#` comments; a docstring only on a module / class / def) |
| overflow on a single variable or inline statement | compress or extract — a `/** */` block on a single variable is out of proportion to it |
| overflow + an independent structural trigger | extract a named helper, the secondary remedy |

```
BAD  → // This function takes the user list, filters active users, sorts by last login, returns top 10 … (rambling sprawl)
GOOD → // Top 10 active users (last login desc)                     ← one essence line
GOOD → /**                                                          ← declaration-attached "why" over one line → docblock
        * Capacity exhaustion → retries absorbed with exponential backoff, never a 429.
        * Caller bulk-retry → thundering herd right after capacity recovers.
        */
```

- **Placement**: trailing `//` on the same line, or `//` on the line above.
- **Step numbers** `// 1. xxx` — on 3+-step sequential logic only.
- **Branch labels / business rules** — only where the "why" is not inferable, and still subject to the density gate.
- **TODO**: `// TODO(owner/TICKET): reason` — owner + ticket REQUIRED.
- **External refs**: a checkable issue / RFC / CVE / Stack Overflow URL.

## File / Module Header Comments

A header is limited to a **1–3-sentence purpose summary** ("what this file does, and why").

- **Justified header** — write one only when it carries one of the below, compressed:
  - architectural role non-obvious from the name → 1-sentence role summary
  - scope boundary (does not handle X) → the minimum needed to prevent misuse
  - non-obvious design decision / rejected alternative → the load-bearing "why"
  - public module / exported interface → short usage contract
- **Prose-dump (FORBIDDEN)**: >~5 lines adding nothing non-obvious · restating structure the exports already show · a "This file contains …" preamble · 10+ lines of mechanism prose.
- **Complexity-proportional**: header length ∝ module complexity · simple module → omit · uniform mandatory headers FORBIDDEN.

## Comments That MUST NOT Be Written

- Comments excusing unclear code (improve the code instead) · redundant type-system information.
- Cyclomatic complexity > 10 → **decompose first**, never explain it away.
- **Vague / unverifiable source citations FORBIDDEN** — cite a checkable external ref (`## Inline Comments` → **External refs**) or none.
- **Newly commented-out / disabled dead code FORBIDDEN** — delete it, "for rollback" included: git restores it.
  - Pre-existing dead code: `scope-dev.md` → Dead Code Non-Touch. This rule forbids creating it.

## Log Level Criteria

| Level | Criteria | Examples |
|-------|----------|----------|
| **error** | Immediate action required · operation failed | DB connection failure · auth error · payment failure |
| **warn** | Potential issue · functional but warrants attention | Retry triggered · fallback used · deprecated API called |
| **info/log** | Normal events · significant state changes | Server started · batch completed · user logged in |
| **debug** | Dev/debug only · disabled in production | Function entry/exit · intermediate state values |

## Log Message Composition

- **Error logs — required elements**: what failed + why + context (identifiers, state).
- **Error-log structure**: action + target + result.
- **Variables**: template literals · multiple values `|`- or comma-separated.
- **Batch / cron**: log start / completion / failure + processed count.
- **Logger**: framework-provided — `console.*` in production code is FORBIDDEN (test files exempt).
- **Structured JSON** in production: timestamp, level, message, context.
- **Correlation ID**: carry one for distributed tracing.
- **Timestamps**: UTC ISO 8601 with ms.
- **Server logs in English** — user-facing text goes through i18n instead.
- **Lazy evaluation**: skip string construction below the level threshold.

## Prohibitions

- Empty catch / ignoring the error object → log it at minimum.
- Hardcoded identifiers in log messages → pass them as variables.
- **log + rethrow in the same catch FORBIDDEN** → choose one, so the same failure is not logged twice.
- **Log injection**: user input reaching a log MUST have newlines / delimiters sanitized.

## Platform-Specific Rules

- **NestJS**: a single logging point via `LoggingInterceptor` · `Logger` or Pino.
- **Android**: R8/ProGuard `assumenosideeffects` strips `Log.v/d/i` in release · Timber `DebugTree` in debug only · Crashlytics tree in release.
- **Frontend**: ESLint `no-console` in production builds · error tracking via an external service (e.g. Sentry).
