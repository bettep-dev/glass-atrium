# Naming Rules (Cross-Cutting Concern)

Binds every identifier an agent authors or reviews — variable, property, field, parameter, function, method, class, type, enum, constant — renames included. Prose, commit messages and code comments are out of scope: `scoped/shared-comment-logging.md` owns those.

## Agent Injection Core

The delta-core below is the compressed non-inferable subset. It carries the rules an agent gets WRONG without them — a divergence from the model's default, or a closed vocabulary it cannot guess. The lookup half is on-demand detail (`## On-demand detail`).

**Naming delta-core — non-inferable subset; qa-code-reviewer = enforcement surface.**

1. **Canonical verb set (PRIMARY)** — prefer `get/set/find/create/update/delete/put/build` for ~all functions; domain verb ONLY when the set cannot express the op · mappings (keep): storeTranscript→`setTranscript` · resolveUrl→`getURL` · convertImage→`getImage` · combineFileEmbeddings→`getFileEmbeddings`.
2. **`get` contract (diverges from AIP-130)** — `get` = acquisition, null/undefined POSSIBLE, NOT throws-on-miss · non-null ONLY via `*OrFail`/`*OrThrow` suffix.
3. **`put` vs `update`** — `put*` = internal domain-transition pipeline (layer marker) · `update*` = public CRUD update.
4. **Layer-verb map** — Controller = REST verbs · Repository = Prisma verbs (`find*` glob), non-null via `*OrThrow`/`*OrFail` · Service = small set (noun-form OK on vendor-adapter surfaces).
5. **One verb per purpose per layer** — never mix get/find/fetch/retrieve in one layer; never rename an op across layers (create ≠ add ≠ insert).
6. **Identifier-kind binary** — data identifier (var/property/field/param/class/type) = NOUN · function/method = direct verb (vendor-adapters excepted); no noun↔verb cross-form. (Padding verbs + noise nouns Data/Info/Manager: model-inferable.)
7. **No-stutter** — strip the domain the enclosing class/module/receiver/type already supplies (`User.userName`→`User.name` · `getBucketImage`→`getImage` in a bucket service).
8. **Reduction-floor guardrail [NON-COMPRESSIBLE — never trim; counterweight to no-stutter]** — never collapse to a generic terminal (`data`/`value`/`status`/`result`/`count`-unqualified); on sibling collision KEEP the qualifier (`userCount`/`projectCount`); KEEP the verb when it is the sole compute-vs-stored-field signal (`calculateTotal` ≠ stored `total`).

Full skill: 17-category verb taxonomy, scope-proportional length table, abbreviations, anti-pattern tables, boolean stative-first.

## Core rules outside the delta-core

These pass the admission test the delta-core applies to itself: they are core rules, not on-demand detail, and bind exactly as the delta-core does.

- **Booleans — stative-first** with `is`/`has`/`can`/`should`. The delta-core's closing line lists this among the full skill's contents; it is a core rule nonetheless, stated here.
- **Class / type suffixes — a closed allowlist**: `*Repository` · `*Service` · `*Controller` · `*Builder` · `*Factory` · `*Provider` · `*Validator`. **`I`-prefixed interface names are FORBIDDEN** — the C#/Java default is the opposite, so the violation reads as idiomatic and passes review unremarked.
- **Greppability and scope non-redundancy** — a public identifier stays greppable, and a name never repeats the scope already enclosing it. This is the counterweight that makes the delta-core's no-stutter rule safe to apply aggressively.

## On-demand detail

- `skills/glass-atrium-dev-naming/SKILL.md` keeps the User Dictionary's worked rows the delta-core does not carry and the five conciseness principles as prose.
- Its `references/` keep the 17-category verb taxonomy (a fallback beneath the canonical verb set), the scope-proportional length table, the abbreviation list and the anti-pattern tables.
- Whether a subagent can still invoke that skill once its frontmatter no longer lists it is an open question this file does not settle.
