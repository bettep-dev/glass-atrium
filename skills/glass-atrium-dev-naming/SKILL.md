---
name: glass-atrium-dev-naming
description: Naming conventions for DEV agents — 5 conciseness principles (no-stutter context removal + identifier-kind verb-form scoping nouns-on-data/verbs-on-functions, with intention-revealing reduction floor), variables (scope-proportional, collections, maps), booleans (stative-first), functions (inverse-scope, layer-specific, 17-category verb taxonomy), classes/types, enums/constants, greppability, anti-pattern prohibition
---

## Agent Injection Core

> The block below (between the `AGENT-INJECT:NAMING` markers) is the compressed injected core extracted verbatim by a SubagentStart hook and injected into DEV + glass-atrium-qa-code-reviewer subagents. Edit it here only — the full skill (User Dictionary, 5 Conciseness Principles, Quick rules, References) remains below as the on-demand detail.

<!-- AGENT-INJECT:NAMING:START -->
**Naming delta-core (auto-injected for DEV + glass-atrium-qa-code-reviewer) — non-inferable subset; qa-code-reviewer = enforcement surface.**

1. **Canonical verb set (PRIMARY)** — prefer `get/set/find/create/update/delete/put/build` for ~all functions; domain verb ONLY when the set cannot express the op · mappings (keep): storeTranscript→`setTranscript` · resolveUrl→`getURL` · convertImage→`getImage` · combineFileEmbeddings→`getFileEmbeddings`.
2. **`get` contract (diverges from AIP-130)** — `get` = acquisition, null/undefined POSSIBLE, NOT throws-on-miss · non-null ONLY via `*OrFail`/`*OrThrow` suffix · a suffix-less `get*` that throws violates the contract.
3. **`put` vs `update`** — `put*` = internal domain-transition pipeline (layer marker) · `update*` = public CRUD update.
4. **Layer-verb map** — Controller = REST verbs · Repository = Prisma verbs (`find*` glob), non-null via `*OrThrow`/`*OrFail` · Service = small set (noun-form OK on vendor-adapter surfaces).
5. **One verb per purpose per layer** — never mix get/find/fetch/retrieve in one layer; never rename an op across layers (create ≠ add ≠ insert — breaks call-chain grep).
6. **Identifier-kind binary** — data identifier (var/property/field/param/class/type) = NOUN (what it IS) · function/method = direct verb (what it DOES); no noun↔verb cross-form. (Generic padding verbs + noise nouns Data/Info/Manager are model-inferable — see skill.)
7. **No-stutter** — strip the domain the enclosing class/module/receiver/type already supplies (`User.userName`→`User.name` · `getBucketImage`→`getImage` in a bucket service).
8. **Reduction-floor guardrail [NON-COMPRESSIBLE — never trim; counterweight to no-stutter]** — never collapse to a generic terminal (`data`/`value`/`status`/`result`/`count`-unqualified); on sibling collision KEEP the qualifier (`userCount`/`projectCount`); KEEP the verb when it is the sole compute-vs-stored-field signal (`calculateTotal` ≠ stored `total`).

Detail below: 17-category verb taxonomy, scope-proportional length table, abbreviations, anti-pattern tables, boolean stative-first.
<!-- AGENT-INJECT:NAMING:END -->

## When to Use

Any identifier — variable, function, class, type, enum, constant — including renames. Excludes prose, commit messages, and comments (see shared-comment-logging.md).

## User Dictionary (Canonical)

The user's personal convention — it OVERRIDES the broad verb taxonomy (taxonomy = fallback only; lineage + citations in references/VERB-TAXONOMY.md preamble).

- **Small fixed verb set (PRIMARY)**: prefer `get/set/find/create/update/delete/put/build` for nearly all functions · domain verbs only when the set genuinely cannot express the operation — storeTranscript→`setTranscript` · resolveUrl→`getURL` · convertImage→`getImage` · combineFileEmbeddings→`getFileEmbeddings`
- **`get` contract**: simple acquisition, null/undefined possible (JS `Map.get` lineage) — NOT "throws on miss" · non-null guarantee carried by suffix `*OrFail`/`*OrThrow` (Prisma/Kotlin style)
- **`put` vs `update`**: `update*` = public CRUD update · `put*` = internal domain-transition pipeline (HTTP metaphor reused as a layer marker)
- **Noun-form methods allowed on vendor-adapter surfaces** ("give me the X" resource feel): `recognition` · `transcript` · `timestamp` · `speaker` · `parse`
- **Family alignment**: shared prefix/suffix across related functions — `build*Embedding` siblings · `find/update/delete/put + Generating` lifecycle · `get/set + Embed` pairs
- **Layer mapping**: Controller = REST verbs (create/find/update/delete) · Repository = Prisma verbs (`find*`/create/update/delete + `*OrThrow`)

## Core Principles

**Consistency > cleverness** — existing patterns first.

**5 Conciseness Principles**:

1. Remove context aggressively — **no-stutter**: strip the domain the enclosing class/module/package/receiver/type ALREADY supplies; name length is scope-proportional (echo nothing already in scope) — `http.HTTPServer` → `http.Server` · `User.userName` → `User.name` · `getBucketImage` → `getImage` (bucket service) · roundBillingTime → `bill` (Clova adapter)
2. Remove type (type system already expresses it) — `strName`/`userList` → `name`/`users`
3. Remove noise (Data/Info/Result/Manager) — `loadEventData` → `loadEvent`
4. Trim affixes — `categoryFilePath` → `categoryPath`
5. **Verb-form is identifier-kind-scoped** — *data identifiers* (variables · properties · fields · parameters · classes · types) = NOUN/noun-phrase, strip verb-form padding (`processedData` → `normalized`/`output`) · *functions/methods* = concise direct verb (small set first, domain verb only when the set cannot express it — see User Dictionary), strip helper-verb padding + nominalization (`performDeletion` → `delete()`, `handleRequest` → `route()`). This does NOT make functions nouns — verbs belong on functions, nouns on data/types.

**Reduction floor (guardrail)** — never reduce below the intention-revealing/searchable floor: strip context only when the enclosing scope provides it unambiguously (sibling collision → keep the qualifier: `userCount`/`projectCount`); never collapse to a generic terminal (`data`·`value`·`status`·`result`·`count`-unqualified); keep the verb when it is the sole signal of a computation vs stored field (`calculateTotal` ≠ `total`); evaluate domain-strip first, then verb-strip — apply both at once only when each passes alone. Detail + rows: references/ANTI-PATTERNS.md.

**Quick rules**:

- Variables: S-I-D (Short + Intuitive + Descriptive) · **noun/noun-phrase only** (no verb-form padding) · scope-proportional length · plural for collections · `userById` for maps
- Booleans: stative-first with `is`/`has`/`can`/`should`
- Functions: **small-set verb + object** (see User Dictionary) · concise direct verb, no padding (perform/do/handle/process/execute/manage) · inverse-scope (wide → short) · one verb per purpose per layer
- Classes/Types: allowed `*Repository`·`*Service`·`*Controller`·`*Builder`·`*Factory`·`*Provider`·`*Validator` · I-prefix forbidden
- Greppability: public identifiers greppable · **scope non-redundancy** (no repeating parent scope)

## References (Progressive Disclosure)

- **[references/VARIABLES-BOOLEANS.md](references/VARIABLES-BOOLEANS.md)** — scope-proportional length table, allowed abbreviations, collections/maps, boolean prefix semantics, classes/types/enums/greppability
- **[references/VERB-TAXONOMY.md](references/VERB-TAXONOMY.md)** — User Dictionary precedence preamble (lineage citations) + 17-category verb taxonomy as FALLBACK (Read/Create/Update/Delete/Batch/Suffix/State/Transform/Compute/Validate/Init-Shutdown/Flow/Events/Compose/Cache/Security/Logging) + layer-specific verbs
- **[references/ANTI-PATTERNS.md](references/ANTI-PATTERNS.md)** — vague-verb prohibition, violation table, synonym-mixing ban, forbidden mixing pairs, inverse get/find-school warning, Common Rationalizations, Red Flags, Verification checklist
