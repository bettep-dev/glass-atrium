# Comment & Logging Rules (Cross-Cutting Concern)

## Agent Injection Core

<!-- AGENT-INJECT:START -->
**Comment-rule core (auto-injected DEV/QA · full: `~/.glass-atrium/scoped/shared-comment-logging.md`)**

TOP PROHIBITIONS:
- **NO history / narration / attribution** — git owns history; "why" = DESIGN RATIONALE, never change-narration. Forbidden: date-stamps, before/after or A→B notes, version/wave/ADR tags, authorship/review. Owner/ticket ONLY in TODO. **No commented-out dead code** "for rollback" → DELETE.
- **Density gate (ceiling, not floor)**: comment ONLY when "why" is non-obvious from names/types/context · self-evident code → NO comment · `— because …` does NOT license it · in doubt → omit.
- **One essence line → `/** */` on overflow**: non-obvious "why" in ONE `//` line; verbose prose FORBIDDEN. Overflow on a declaration (function/method/class) OR public-API/exported → `/** */` docblock, NEVER stacked `//` nor a paragraph. One-line internal note stays `//`; a variable whose why overflows → compress/extract (not a block). Non-`/** */` langs → idiomatic block (Python: `#`, docstrings for module/class/def only).
- **NO mid-sentence line-wrap** — one clause per `//` line. Compress causality with `→ — , +`, bullet/noun-phrase only. Does NOT forbid the 1–3-sentence header nor multiple one-line comments.
- **NO `console.*` in production** (test files exempt) → framework logger.

REMAINING RULES:
- Comment language: English by default (GLOBAL_RULES → Output Language). Overrides only: user's task/CLAUDE.md spec → target-repo contributing policy → editing an existing non-English comment (match it). Identifiers/API names keep original form. COMMENT language only — server logs stay English.
- Stale comments worse than none → sync with code.
- Log level: error=action-required/failed · warn=potential issue · info=state change · debug=dev-only (off in prod). Error logs need what+why+context.
- JSDoc: semantics only, MUST NOT duplicate types (`@param value - desc`, never `@param {type}`).
- TODO: `// TODO(owner/TICKET): reason` — owner+ticket REQUIRED.
- **File/module header = 1–3-sentence purpose limit** · prose-dump FORBIDDEN · complexity-proportional (self-evident module → omit).
- **Mirror = code form only** (naming/imports/error+log) — NEVER copy a sibling's comment density/header prose; sibling violates → author COMPLIANT comments. Carve-outs (reproduce): tooling/pragma directives (`// @ts-expect-error`, `/* eslint-disable */`, prettier-ignore / region / fold / codegen anchors) AND a header passing the Justified-header test (role / scope boundary / rejected alternative / usage contract).
<!-- AGENT-INJECT:END -->

## Comment Principles

- **Density gate (ceiling, not floor)** — the rule every later "the density gate" reference in this file resolves to: comment ONLY where the "why" is non-obvious from names, types and surrounding context.
  - Self-evident code takes NO comment · an appended `— because …` does not license one · in doubt, omit.
- **Single Source of Truth**: each fact is documented at exactly one declaration site · restating it elsewhere (a docstring re-listing type members) is FORBIDDEN — drift risk.
- **Essence over sprawl**: one concise `//` line is the default form; the overflow and demotion rules are in `## Inline Comments`.

```
BAD  → // This function takes the user list, filters active users, sorts by last login, returns top 10 … (rambling sprawl)
GOOD → // Top 10 active users (last login desc)                     ← one essence line
GOOD → /**                                                          ← declaration-attached "why" over one line → docblock
        * Absorbs retries with exponential backoff instead of 429 on capacity exhaustion.
        * Caller bulk-retry would cause a thundering herd right after capacity recovers.
        */
```

## Comment Language & Style

- **Language precedence** (highest wins). A comment an agent writes is English by default (`GLASS_ATRIUM_GLOBAL_RULES.md` → Absolute Rules → Output Language); the overrides run in this order, ending in the default itself:
  1. a comment language the user's task or `CLAUDE.md` specifies
  2. the target repository's own contributing policy, where that repository states one
  3. editing an existing non-English comment → match its existing language, so one comment is never left half-translated
  4. otherwise → English, per the canonical
- Identifiers / code / API names inside a comment keep their original form at every tier. This governs **comment** language ONLY — server logs stay English (`## Log Message Composition`).
- **Form**: bullet / noun-phrase MUST — narrative sentences FORBIDDEN.
- **Causality**: compress with `→ — , +`.
- **Ending**: verb-stem preferred.
- **JSDoc lines**: short noun-phrases.
- **Decoration**: box / ASCII-art (`/* ---- */`, banners, star columns) FORBIDDEN.

```
BAD  → // Reads the live filesystem count then
       // compares and returns the result
GOOD → // live fs count ↔ invariant compare → return result
```

## Public API Comments (Block)

- **Two trigger axes**: a `/** */` block is warranted by EITHER public-API / exported scope (this section) OR an internal "why" too large for one `//` line (`## Inline Comments`). A one-line-sufficient internal note stays `//`.
- **Scope**: behavior summary + side effects + call constraints + param semantics + thrown exceptions · NEVER an enumeration of returned-object members and NEVER a repeat of types · first line = one-line summary (omit when the name is self-evident) · void return: omit · ambiguous return / explicit throws / non-obvious invocation: document.
- **Params & returns**: semantics only, never types (`@param value - desc`, never `@param {type}` / `@returns {type}`; omit `@returns` when it adds no semantics).
- **Returned-object members** → document at the type / interface declaration site (`@property` / per-field), never in the function docstring.
- **Generic params** → `@typeParam` is omittable when the constraint already expresses the intent (`<E extends HTMLElement>`).
- **`@deprecated`** REQUIRES 4 elements: version introduced · planned removal · replacement · `@link` ref.

## Inline Comments

- **One-line sufficiency gate (form, not whether)**: past the density gate, the comment MUST be ONE essence line.
  - Overflow on a declaration-attached function / method / class → escalate to a `/** */` docblock (PRIMARY remedy).
  - Overflow on a single variable or inline statement → compress or extract; a single-variable `/** */` is OVERKILL.
  - Stacked `//` continuation lines and run-on paragraphs are FORBIDDEN.
  - A 2nd `//` line to finish a thought does NOT license keeping both — extracting a named helper is a CONDITIONAL secondary, fired only by an independent structural trigger (Minimalism gate / size-complexity / Rule of Three). Comment length alone is NOT such a trigger.
  - Distinct complete points stay separate one-line comments — this gate targets continuation of ONE thought.
- **Placement**: trailing `//` on the same line, or `//` on the line above.
- **Step numbers** `// 1. xxx` — on 3+-step sequential logic only. **Branch labels / business rules** — only where the "why" is not inferable, and still subject to the density gate.
- **Security flags**: `// SECURITY:` prefix. **External refs**: issue / RFC / Stack Overflow URL.

## File / Module Header Comments

A header is limited to a **1–3-sentence purpose summary** ("what this file does, and why"). File-spanning prose dumps are FORBIDDEN.

- **Justified header** — write one only when it carries one of the below, compressed:
  - architectural role non-obvious from the name → 1-sentence role summary
  - scope boundary (does NOT handle X) → the minimum needed to prevent misuse
  - non-obvious design decision / rejected alternative → the load-bearing "why"
  - public module / exported interface → short usage contract
- **Prose-dump (FORBIDDEN)**: >~5 lines adding nothing non-obvious · restating structure the exports already show · a "This file contains …" preamble · 10+ lines of mechanism prose · author / date / bug-ID / change-history (git owns those).
- **Complexity-proportional**: header length ∝ module complexity · simple module → omit · uniform mandatory headers FORBIDDEN.

## Comments That MUST NOT Be Written

Comments restating code · excusing unclear code (improve the code instead) · redundant type-system information · over-narration past the density gate · cyclomatic complexity > 10 → **decompose first**, never explain it away.

- **Vague / unverifiable source citations FORBIDDEN** — a checkable external ref (issue / RFC / CVE / Stack Overflow URL) is permitted (`## Inline Comments`); an unfollowable provenance note is not.
- **Newly commented-out / disabled dead code FORBIDDEN** — DELETE it (git restores it). Distinct from `scope-dev.md` Dead Code Non-Touch, which governs PRE-EXISTING dead code; this forbids CREATING it.
- **The positive form of every prohibition above**: a comment carries ONLY the essence — the non-obvious "why" plus current state, never history, never narration, never a paraphrase of the code.

## Log Level Criteria

| Level | Criteria | Examples |
|-------|----------|----------|
| **error** | Immediate action required · operation failed | DB connection failure · auth error · payment failure |
| **warn** | Potential issue · functional but warrants attention | Retry triggered · fallback used · deprecated API called |
| **info/log** | Normal events · significant state changes | Server started · batch completed · user logged in |
| **debug** | Dev/debug only · disabled in production | Function entry/exit · intermediate state values |

## Log Message Composition

- **Error logs — 3 elements REQUIRED**: what failed + why + context (identifiers, state).
- **Error-log structure**: action + target + result.
- **Variables**: template literals · multiple values `|`- or comma-separated.
- **Batch / cron**: log start / completion / failure + processed count.
- **Logger**: framework-provided.
- **Structured JSON** in production: timestamp, level, message, context.
- **Correlation ID**: carry one for distributed tracing.
- **Timestamps**: UTC ISO 8601 with ms.
- **Server logs in English** — user-facing text goes through i18n instead.
- **Lazy evaluation**: skip string construction below the level threshold.

## Prohibitions

- Logging sensitive info (passwords / tokens / PII) → see `core-security.md`.
- Empty catch / ignoring the error object (log at minimum) · hardcoded identifiers in log messages (pass them as variables).
- **log + rethrow in the same catch FORBIDDEN** → choose one, so the same failure is not logged twice.
- **Log injection**: user input reaching a log MUST have newlines / delimiters sanitized.

## Platform-Specific Rules

- **NestJS**: a single logging point via `LoggingInterceptor` · `Logger` or Pino.
- **Android**: R8/ProGuard `assumenosideeffects` strips `Log.v/d/i` in release · Timber `DebugTree` in debug only · Crashlytics tree in release.
- **Frontend**: ESLint `no-console` in production builds · error tracking via an external service (e.g. Sentry).
