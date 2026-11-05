# Naming Rules (Cross-Cutting Concern)

- Binds every identifier an agent authors or reviews — variable, property, field, parameter, function, method, class, type, enum, constant — renames included.
- Out of scope: prose · commit messages (`rules/glass-atrium/core-git-workflow.md`) · code comments (`scoped/shared-comment-logging.md`) · file, module and directory names · test function and method names (`scoped/shared-testing.md` → `### Names, comments and test data`).

## Agent Injection Core

**Naming delta-core** — the core naming rules; their lookup tables load on demand (`## On-demand detail`).

- **Canonical verb set (PRIMARY)** — prefer `get/set/find/create/update/delete/put/build` for ~all functions; a domain verb only when the set cannot express the op.
  - Mappings (keep): storeTranscript→`setTranscript` · resolveUrl→`getURL` · convertImage→`getImage` · combineFileEmbeddings→`getFileEmbeddings`.
- **`get` contract (diverges from AIP-130)** — `get` = acquisition, null/undefined possible, does not throw on a miss · non-null only via an `*OrFail`/`*OrThrow` suffix.
- **`put` vs `update`** — `put*` = internal domain-transition pipeline (layer marker) · `update*` = public CRUD update.
- **Layer-verb map** — Controller = REST verbs · Repository = Prisma verbs (`find*` glob), non-null via `*OrThrow`/`*OrFail` · Service = small set (noun-form OK on vendor-adapter surfaces).
- **One verb per purpose per layer** — never mix get/find/fetch/retrieve in one layer; never rename an op across layers (create ≠ add ≠ insert).
- **Identifier-kind binary** — data identifier (var/property/field/param/class/type) = noun · function/method = direct verb (vendor-adapters excepted); no noun↔verb cross-form.
  - A group member reads with its group, here and under **Reduction-floor guardrail**; an index-map member is named by its key: `request.pending` · `charge.status` · `user.byId` pass.
    - A member taken out of its group is renamed at extraction to rejoin its group's name — `:` in a destructuring read, `as` in an import: `{ byId } = user` → `{ byId: userById } = user`.
- **No-stutter** — strip the domain the enclosing class/module/receiver/type already supplies (`User.userName`→`User.name` · `getBucketImage`→`getImage` in a bucket service).
- **Reduction-floor guardrail** — the floor **No-stutter** never strips below: never collapse to a generic terminal (`data`/`value`/`status`/`result`/`count`-unqualified).
  - Keep the verb when it is the sole compute-vs-stored-field signal (`calculateTotal` ≠ stored `total`).
  - A sibling collision is resolved by **Qualifier-sibling grouping** first; the qualifier stays only where its fallback applies (`userCount`/`projectCount`: `count` cannot name a group).
  - Two siblings never collapse to one name.
- **Read-down naming** — a name reads down domain → class → function → local, carrying only the words its own level adds: `getChatTurnPoint`→`getPoint` in `ChatTurnService` · a name imported bare keeps its module's word.
- **Prefix-family grouping** — 2+ variables, constants, properties or fields sharing a leading noun the scope does not supply become one group with short members: `chargeState`/`chargeId`/`chargeExpiredAt` → `charge: { state, id, expiredAt }`.
  - A stative name joins through the domain noun right after its prefix, as a stative-first member, and counts toward the 2+: `chargeId`/`chargeAmount`/`isChargeActive` → `charge: { id, amount, isActive }`; a bare stative name (`isLoading`) stays flat.
  - A function's own parameters stay flat and count toward no family or set — the signature is the call contract: `transfer(fromId, toId)`.
  - Names fixed outside the change or in a flat-only medium are not grouped (`## Edge-case verdicts — identifier kinds`).
- **Qualifier-sibling grouping** — 2+ identifiers of a **Prefix-family grouping** kind in one scope that share a head noun and differ only by a qualifier become one group named by that head noun, one member per qualifier: `pendingRequest`/`paymentRequest` → `request: { pending, payment }`.
  - The set is every such name ending in the same noun, a unit suffix counted with the word before it.
  - The head noun alone (`request`) is no member.
  - Its head noun is the longest tail all members share, as written.
  - Inside the group the rule applies again.
  - **Prefix-family grouping** applies first, at every nesting level: a name that joins a prefix family never joins a qualifier group.
  - The exclusions of **Prefix-family grouping** apply.
  - Fallback, a closed list — keep the qualifier only when:
    - the head noun is a generic terminal (**Reduction-floor guardrail**);
    - the head noun names another binding in the scope, not this group;
    - a member's qualifier names an in-scope binding: that member alone stays flat, and the rest group if 2+ remain.
  - Where either head-noun fallback applies, members sharing a longer tail that passes group on it.

## Core rules outside the delta-core

These bind as the delta-core does.

- **Booleans — stative-first** with `is`/`has`/`can`/`should`.
- **Class / type suffixes — a closed allowlist**: `*Repository` · `*Service` · `*Controller` · `*Builder` · `*Factory` · `*Provider` · `*Validator`.
- **`I`-prefixed interface names are forbidden**.
  - Why: the C#/Java default is the opposite, so the violation reads as idiomatic and passes review unremarked.
- **Greppability and scope non-redundancy** — a public identifier stays greppable, and a name never repeats the scope already enclosing it (**No-stutter**).
  - Greppability is the counterweight that keeps **No-stutter** safe to apply aggressively.

## Edge-case verdicts — identifier kinds

One verdict per input shape for **Read-down naming**, **Prefix-family grouping** and **Qualifier-sibling grouping**.

| Input shape | Verdict |
|---|---|
| Fixed outside the change: framework or vendor contract, wire or external API field, generated code | stays as written |
| DB column, its ORM field (FK scalars too), env var, CLI flag, header, query or path param, CSS class | stays flat |
| Document-store model whose fields can nest | groups like any other type |
| Payload or DTO type the change authors that crosses a boundary: `{ chargeState, chargeId }` | groups: `{ charge: { state, id } }` |
| Constructor parameters that declare fields: TS parameter properties, Kotlin `val` params, dataclass fields | fields: they group |
| Props or options type used only as one function's or component's parameter: `Card({ headerTitle, footerTitle })` | the signature: stays flat |
| Class name, type name or enum member · a constant holding a schema, context, class or component: `createUserSchema` | not a family kind |
| Alternative values of one kind: `CHARGE_STATUS_PENDING`/`CHARGE_STATUS_PAID` | an enum, not a family |
| Function-valued name: method, arrow const `handleChargeSubmit`, callback prop `onChargeSubmit` | not a family kind — `skills/glass-atrium-dev-naming/SKILL.md` → **Family alignment** |
| Accessor `get chargeId()` | a property: in scope |
| Hook return bindings: `[x, setX]` pairs, `useRef`, `useMemo`, a query hook's result | each stays flat — merging hook cells is a hook-design call |
| Qualified read: `const { status: chargeStatus } = charge` | stays — a read-site rename |

## Edge-case verdicts — scopes and bindings

| Input shape | Verdict |
|---|---|
| Names in different declaring blocks: a module name and a nested local · `fileBlock`, `diskBlock` in two modules | different scopes: no family or set |
| Bare imports from different modules: `pendingRequest` from one, `paymentRequest` from another | judged in each declaring module |
| In-scope binding, for a group name or a fallback | a value readable bare there: local, parameter, module-level name, import — not `this.payment` or a class |
| Existing `user` beside an added `userById` — one not read out of `user` | a group object of this family's members: its own group, a new `userById` joins · any other value: another binding |
| Leading noun names another in-scope binding: `chargeTotal` beside entity `charge` · `userById` beside entity `user` | stays flat or moves onto that binding's type |

## Edge-case verdicts — family shapes

| Input shape | Verdict |
|---|---|
| Acronym or technical-noun lead: `dbHost`/`dbPort` | `db: { host, port }` |
| Adjective, quantifier or determiner lead: `max`, `min`, `prev`, `next`, `default`, `new` | a qualifier, no prefix family: `minWidth`/`maxWidth` → `width: { min, max }` |
| Shared second qualifier: `chargeCreditState`/`chargeCreditId`/`chargeRefundId` | nests: `charge: { credit: { state, id }, refundId }` |
| Plural members: `chargeIds`/`chargeAmounts` | `charge: { ids, amounts }` — never `charges` |
| Constants: `CHARGE_TIMEOUT_MS`/`CHARGE_MAX_RETRIES` | casing kept: `CHARGE.TIMEOUT_MS` |
| Index map beside another name of its value noun: `userById`/`userByEmail` · `userById`/`userId` | a map counts like any member: `user: { byId, byEmail }` · `user: { id, byId }` |
| Index map no other name shares a noun with: `userById` alone | stays `userById` |
| Index maps sharing only the key: `userById`/`orderById` | no family, no set — a `By<Key>` tail is a key, not a head noun |
| Plural value noun: `usersByTeam` beside `userById` | different families — the noun is kept as written |
| Stative name ending in its noun: `hasCharge` beside `chargeId` | stays flat — no word follows the noun |

## Edge-case verdicts — sibling sets

| Input shape | Verdict |
|---|---|
| Both axes: `paymentRequest`/`pendingRequest` beside `paymentTimes` | prefix first: `payment: { request, times }`; `pendingRequest` stays flat |
| Qualifier names beside a prefix group: `requestTimeout`/`requestRetries` + `pendingRequest`/`paymentRequest` | `request: { timeout, retries }`; the qualifiers stay — a name joins only a group of its own kind |
| Multi-word qualifier: `paymentTimes`/`memberSyncTimes` | `times: { payment, memberSync }`; in a member service `memberSync` → `sync` (**Read-down naming**) |
| Tails of different lengths: `pendingPaymentRequest`/`failedPaymentRequest`/`refundRequest` | `request: { payment: { pending, failed }, refund }` |
| Blocked head noun, a longer tail passes: `activeUserCount`/`blockedUserCount`/`projectCount` | `userCount: { active, blocked }` beside a flat `projectCount` |
| Unit suffix: `connectTimeoutMs`/`readTimeoutMs` · `timeoutMs`/`delayMs` | `timeoutMs: { connect, read }` · no set — a unit alone is no head noun |
| Attribute or technical head noun: `userId`/`orderId` · `apiUrl`/`cdnUrl` | `id: { user, order }` · `url: { api, cdn }` |
| Last word no noun: `createdAt`/`updatedAt` · `startX`/`endX` | no set — a preposition or a single letter is no head noun |
| Noise-noun head: `orderData`/`userData` | no set — the noise noun strips: `order` · `user` |
| Stative names sharing a tail: `hasPendingRequest`/`hasPaymentRequest` · `isHeaderVisible`/`isFooterVisible` | stay flat — a stative name forms no qualifier set |

## Edge-case verdicts — reads and joins

| Input shape | Verdict |
|---|---|
| Added name beside its own group: `request: { pending }` + `paymentRequest` · `charge: { id }` + `chargeExpiredAt` | joins: `request.payment` · `charge.expiredAt` |
| Member taken out of its group: `{ id } = user` · `{ byId } = user` · `{ expiredAt } = charge` · `{ payment } = request` | renamed at extraction to the flat name the group replaced: `userId` · `userById` · `chargeExpiredAt` · `paymentRequest` |
| Member named in log or error text: `expiredAt` read from `charge` · `request.payment` | `chargeExpiredAt` · `paymentRequest` — `ANTI-PATTERNS.md` → **Cross-boundary names keep their qualifier** |
| Members of different groups: `charge.status` beside `refund.status` | no collision |
| Module word repeated in a member: `referenceUseByReference` in the `reference` module | rename from what this level adds (**Canonical verb set (PRIMARY)**, **Identifier-kind binary**) |
| Module word the use site keeps: package-qualified, namespace import, class member, group path | stripped; a name imported bare keeps it (`CHARGE_TIMEOUT_MS` from `charge/config.ts`) |

## On-demand detail

- `skills/glass-atrium-dev-naming/SKILL.md` keeps the User Dictionary's worked rows the delta-core does not carry and the five conciseness principles as prose.
- Its `references/` keep the lookup tables: the verb taxonomy (`VERB-TAXONOMY.md`, a fallback beneath the canonical verb set) · scope-proportional length, allowed abbreviations and boolean forms (`VARIABLES-BOOLEANS.md`) · the anti-pattern tables (`ANTI-PATTERNS.md`).
- No agent frontmatter preloads that skill: when a lookup above applies, open the file by path with Read.
