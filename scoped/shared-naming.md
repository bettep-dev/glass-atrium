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
9. **Read-down naming** — a name reads down domain → class → function → local, carrying only the words its own level adds, never the whole meaning alone; No-stutter applied over the whole chain.
    - `getChatTurnPoint`→`getPoint` in `ChatTurnService` · `referenceUseByReference` in the `reference` module carries the module's word twice: rename from what this level adds, under the Canonical verb set and the Identifier-kind binary.
10. **Prefix-family grouping** — variables, properties, fields and params sharing a leading qualifier the scope does not supply go into ONE group (object/type) with short members; class and type names are out of scope.
    - The leading qualifier is a domain or entity noun: stative `is`/`has`/`can`/`should` prefixes never form a family (`isLoading`/`isOpen` stay flat under **Booleans — stative-first**).
    - `chargeCreditState`/`chargeCreditId`/`chargeCreditExpiredAt` → `charge: { state, id, expiredAt }` in the credit domain · `charge.chargeId`→`charge.id` by No-stutter.
    - The group supplies the qualifier, so a member is judged together with its group: `charge.status` passes the Reduction-floor guardrail, a lone `status` still fails it.
    - Wherever a member is read without its group — a destructured local, log or error text, a cross-boundary payload, a sibling group's same-named member — the Reduction-floor guardrail binds again: keep the qualifier (`chargeStatus`).
    - Those qualified locals and payload fields are not a prefix family: `const { status: chargeStatus, id: chargeId } = charge` is compliant.
    - The group name obeys the Identifier-kind binary and the Reduction-floor guardrail (a specific noun, never `data`/`info`/`values`), and it is the greppable unit: grep the group path or its type name, never a bare member.
    - Function and method families sharing a verb or suffix are not prefix families: they stay under `skills/glass-atrium-dev-naming/SKILL.md` → **Family alignment**.

Full skill: 17-category verb taxonomy, scope-proportional length table, abbreviations, anti-pattern tables, boolean stative-first.

## Core rules outside the delta-core

These pass the admission test the delta-core applies to itself: they are core rules, not on-demand detail, and bind exactly as the delta-core does.

- **Booleans — stative-first** with `is`/`has`/`can`/`should`. The delta-core's closing line lists this among the full skill's contents; it is a core rule nonetheless, stated here.
- **Class / type suffixes — a closed allowlist**: `*Repository` · `*Service` · `*Controller` · `*Builder` · `*Factory` · `*Provider` · `*Validator`. **`I`-prefixed interface names are FORBIDDEN** — the C#/Java default is the opposite, so the violation reads as idiomatic and passes review unremarked.
- **Greppability and scope non-redundancy** — a public identifier stays greppable, and a name never repeats the scope already enclosing it. This is the counterweight that makes the delta-core's no-stutter rule safe to apply aggressively.

## On-demand detail

- `skills/glass-atrium-dev-naming/SKILL.md` keeps the User Dictionary's worked rows the delta-core does not carry and the five conciseness principles as prose.
- Its `references/` keep the lookup tables the delta-core's closing `Full skill:` line names; the verb taxonomy is a fallback beneath the canonical verb set.
- Whether a subagent can still invoke that skill once its frontmatter no longer lists it is an open question this file does not settle.
