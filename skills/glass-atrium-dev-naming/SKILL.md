---
name: glass-atrium-dev-naming
description: Naming conventions for DEV agents — conciseness principles (no-stutter context removal, identifier-kind verb form with nouns on data and verbs on functions) and their reduction floor, variables (scope-proportional, collections, maps), booleans (stative-first), functions (inverse-scope, layer-specific, verb taxonomy), classes/types, enums/constants, greppability, anti-patterns
---

> Core rules: the rule file `scoped/shared-naming.md` → `## Agent Injection Core` and `## Core rules outside the delta-core`; this file is their on-demand detail.

## User Dictionary (Canonical)

- **Where its rules live**: the canonical verb set, the `get` contract, `put` vs `update` and the layer-verb map are the rule file's delta-core.
- Worked detail it does not carry:
  - **Noun-form methods allowed on vendor-adapter surfaces** ("give me the X" resource feel): `recognition` · `transcript` · `timestamp` · `speaker` · `parse`
  - **Family alignment**: shared prefix/suffix across related functions — `build*Embedding` siblings · `find/update/delete/put + Generating` lifecycle · `get/set + Embed` pairs
  - **Controller REST verbs, spelled out**: `create` · `find` · `update` · `delete`

## Core Principles

### Conciseness principles

- **Remove context aggressively — no-stutter**: strip the domain the enclosing scope already supplies — `roundBillingTime` → `bill` (Clova adapter).
  - Worked rows: `references/ANTI-PATTERNS.md` → `## Scope Non-Redundancy Principle (no-stutter)`.
- **Remove type** (the type system already expresses it) — `strName`/`userList` → `name`/`users`
- **Remove noise** (Data/Info/Result/Manager) — `loadEventData` → `loadEvent`
- **Trim affixes** — `categoryFilePath` → `categoryPath`
- **Verb-form is identifier-kind-scoped** — verbs belong on functions, nouns on data/types (the rule file's **Identifier-kind binary**).
  - Exception: noun-form methods on vendor-adapter surfaces (`## User Dictionary (Canonical)`).
  - Worked rows: `references/ANTI-PATTERNS.md` → `### Naming violations table`.

### Reduction floor

- The floor is the rule file's **Reduction-floor guardrail**.
- Strip order and over-reduction rows: `references/ANTI-PATTERNS.md` → `## Reduction Floor — over-reduction is also a violation`.

## References (Progressive Disclosure)

| Looking up | Open |
|---|---|
| Booleans, class/type suffixes, the `I`-prefix ban, greppability, scope non-redundancy | the rule file → `## Core rules outside the delta-core` |
| Function verb choice | the rule file → **Canonical verb set (PRIMARY)**, **One verb per purpose per layer**, **Identifier-kind binary** |
| Padding verbs to strip | `references/ANTI-PATTERNS.md` → `### Verb-form padding & helper-verb wrappers (functions — forbidden)` |
| Function name length (wide scope → short name) | `references/VERB-TAXONOMY.md` → **Inverse scope rule** |
| A verb the canonical set cannot express · the upstream conventions it departs from | `references/VERB-TAXONOMY.md`, fallback only: the dictionary overrides it |
| Scope-proportional length, allowed abbreviations, collections, maps, boolean forms, classes/types/enums, greppability | `references/VARIABLES-BOOLEANS.md` |
| Prohibited forms and their rows — audits, review comments, rationalizations, red flags, the verification checklist | `references/ANTI-PATTERNS.md` |
