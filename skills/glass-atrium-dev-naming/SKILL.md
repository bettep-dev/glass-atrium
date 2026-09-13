---
name: glass-atrium-dev-naming
description: Naming conventions for DEV agents — 5 conciseness principles (no-stutter context removal + identifier-kind verb-form scoping nouns-on-data/verbs-on-functions, with intention-revealing reduction floor), variables (scope-proportional, collections, maps), booleans (stative-first), functions (inverse-scope, layer-specific, 17-category verb taxonomy), classes/types, enums/constants, greppability, anti-pattern prohibition
---

> Core rules: the compressed non-inferable naming rules are in `scoped/shared-naming.md` → `## Agent Injection Core` and `## Core rules outside the delta-core`, a rule file DEV agents and glass-atrium-qa-code-reviewer receive through registry membership. This file is the on-demand detail those rules defer to.

## When to Use

Any identifier — variable, function, class, type, enum, constant — including renames. Excludes prose, commit messages, and comments (see shared-comment-logging.md).

## User Dictionary (Canonical)

The user's personal convention — it OVERRIDES the broad verb taxonomy (taxonomy = fallback only; lineage + citations in references/VERB-TAXONOMY.md preamble).

- The dictionary's rules — the canonical verb set with its worked mappings, the `get` contract, `put` vs `update`, the layer-verb map — are the rule file's delta-core. The rows below are the worked detail it does not carry.
- **Noun-form methods allowed on vendor-adapter surfaces** ("give me the X" resource feel): `recognition` · `transcript` · `timestamp` · `speaker` · `parse`
- **Family alignment**: shared prefix/suffix across related functions — `build*Embedding` siblings · `find/update/delete/put + Generating` lifecycle · `get/set + Embed` pairs
- **Controller REST verbs, spelled out**: `create` · `find` · `update` · `delete`

## Core Principles

**5 Conciseness Principles**:

- **Remove context aggressively — no-stutter**: strip the domain the enclosing class/module/package/receiver/type ALREADY supplies; name length is scope-proportional (echo nothing already in scope).
  - `http.HTTPServer` → `http.Server` · `User.userName` → `User.name` · `getBucketImage` → `getImage` (bucket service) · roundBillingTime → `bill` (Clova adapter)
- **Remove type** (the type system already expresses it) — `strName`/`userList` → `name`/`users`
- **Remove noise** (Data/Info/Result/Manager) — `loadEventData` → `loadEvent`
- **Trim affixes** — `categoryFilePath` → `categoryPath`
- **Verb-form is identifier-kind-scoped** — verbs belong on functions, nouns on data/types; this does NOT make functions nouns.
  - *Data identifiers* (variables · properties · fields · parameters · classes · types) = NOUN/noun-phrase; strip verb-form padding (`processedData` → `normalized`/`output`).
  - *Functions/methods* = concise direct verb, canonical set first; strip helper-verb padding + nominalization (`performDeletion` → `delete()`, `handleRequest` → `route()`).

**Reduction floor (guardrail)** — the floor itself is the rule file's **Reduction-floor guardrail**. Worked detail it does not carry:

- Strip context only when the enclosing scope provides it unambiguously.
- Evaluate domain-strip first, then verb-strip — apply both at once only when each passes alone.
- Rows: references/ANTI-PATTERNS.md.

**Where the quick rules live**:

- Booleans, class/type suffixes, the `I`-prefix ban, greppability and scope non-redundancy → the rule file's `## Core rules outside the delta-core`.
- Variable length, collections and maps → references/VARIABLES-BOOLEANS.md.
- Function verb choice → the rule file's **Canonical verb set (PRIMARY)** and **Identifier-kind binary**, plus the padding-verb table in references/ANTI-PATTERNS.md.

## References (Progressive Disclosure)

- **[references/VARIABLES-BOOLEANS.md](references/VARIABLES-BOOLEANS.md)** — scope-proportional length table, allowed abbreviations, collections/maps, boolean prefix semantics, classes/types/enums/greppability
- **[references/VERB-TAXONOMY.md](references/VERB-TAXONOMY.md)** — User Dictionary precedence preamble (lineage citations) + 17-category verb taxonomy as FALLBACK (Read/Create/Update/Delete/Batch/Suffix/State/Transform/Compute/Validate/Init-Shutdown/Flow/Events/Compose/Cache/Security/Logging) + layer-specific verbs
- **[references/ANTI-PATTERNS.md](references/ANTI-PATTERNS.md)** — vague-verb prohibition, violation table, synonym-mixing ban, forbidden mixing pairs, inverse get/find-school warning, Common Rationalizations, Red Flags, Verification checklist
