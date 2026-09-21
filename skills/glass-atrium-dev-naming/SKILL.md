---
name: glass-atrium-dev-naming
description: Naming conventions for DEV agents — conciseness principles (no-stutter context removal, identifier-kind verb form with nouns on data and verbs on functions) and their reduction floor, variables (scope-proportional, collections, maps), booleans (stative-first), functions (inverse-scope, layer-specific, verb taxonomy), classes/types, enums/constants, greppability, anti-patterns
---

> Core rules: the compressed non-inferable naming rules are in `scoped/shared-naming.md` → `## Agent Injection Core` and `## Core rules outside the delta-core`, a rule file DEV agents and glass-atrium-qa-code-reviewer receive through registry membership. This file is the on-demand detail those rules defer to.

## When to Use

Any identifier — variable, function, class, type, enum, constant — including renames. Excludes prose, commit messages, and comments (`scoped/shared-comment-logging.md`).

## User Dictionary (Canonical)

- **Precedence**: the dictionary OVERRIDES the verb taxonomy, which is the fallback only. Lineage and citations: `references/VERB-TAXONOMY.md` → `## User Dictionary Precedence (read first)`.
- **Where its rules live**: the canonical verb set with its worked mappings, the `get` contract, `put` vs `update` and the layer-verb map are the rule file's delta-core. The rows below are the worked detail it does not carry.

- **Noun-form methods allowed on vendor-adapter surfaces** ("give me the X" resource feel): `recognition` · `transcript` · `timestamp` · `speaker` · `parse`
- **Family alignment**: shared prefix/suffix across related functions — `build*Embedding` siblings · `find/update/delete/put + Generating` lifecycle · `get/set + Embed` pairs
- **Controller REST verbs, spelled out**: `create` · `find` · `update` · `delete`

## Core Principles

**5 Conciseness Principles**:

- **Remove context aggressively — no-stutter**: strip the domain the enclosing class/module/package/receiver/type ALREADY supplies; name length is scope-proportional.
  - `http.HTTPServer` → `http.Server` · roundBillingTime → `bill` (Clova adapter)
- **Remove type** (the type system already expresses it) — `strName`/`userList` → `name`/`users`
- **Remove noise** (Data/Info/Result/Manager) — `loadEventData` → `loadEvent`
- **Trim affixes** — `categoryFilePath` → `categoryPath`
- **Verb-form is identifier-kind-scoped** — verbs belong on functions, nouns on data/types; this does NOT make functions nouns.
  - *Data identifiers* (variables · properties · fields · parameters · classes · types) = NOUN/noun-phrase; strip verb-form padding (`processedData` → `normalized`/`output`).
  - *Functions/methods* = concise direct verb, canonical set first; strip helper-verb padding + nominalization (`performDeletion` → `delete()`, `handleRequest` → `route()`).
  - Exception: noun-form methods on vendor-adapter surfaces (`## User Dictionary (Canonical)`).

**Reduction floor (guardrail)** — the floor itself is the rule file's **Reduction-floor guardrail**. Worked detail it does not carry:

- Strip context only when the enclosing scope provides it unambiguously.
- Strip order → references/ANTI-PATTERNS.md → `## Reduction Floor — over-reduction is also a violation`.

**Where the quick rules live**:

- Booleans, class/type suffixes, the `I`-prefix ban, greppability and scope non-redundancy → the rule file's `## Core rules outside the delta-core`.
- Variable length, collections and maps → references/VARIABLES-BOOLEANS.md.
- Function verb choice → the rule file's **Canonical verb set (PRIMARY)**, **One verb per purpose per layer** and **Identifier-kind binary**, plus the padding-verb list in references/ANTI-PATTERNS.md → `### Verb-form padding & helper-verb wrappers (functions — forbidden)`.
- Function name length (wide scope → short name) → references/VERB-TAXONOMY.md **Inverse scope rule**.

## References (Progressive Disclosure)

- **[references/VARIABLES-BOOLEANS.md](references/VARIABLES-BOOLEANS.md)** — scope-proportional length table, allowed abbreviations, collections/maps, boolean prefix semantics, classes/types/enums/greppability
- **[references/VERB-TAXONOMY.md](references/VERB-TAXONOMY.md)** — User Dictionary precedence preamble (lineage citations) + verb taxonomy as FALLBACK + layer-specific verbs
- **[references/ANTI-PATTERNS.md](references/ANTI-PATTERNS.md)** — naming anti-patterns, by section:
  - padding verbs and the violation table · circular naming · synonym mixing · forbidden mixing pairs · the inverse get/find school
  - no-stutter · the reduction floor · forbidden class/type suffixes · dynamic identifiers · cross-layer rename
  - Common Rationalizations · Red Flags · Verification checklist
