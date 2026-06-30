# 17-Category Verb Taxonomy — Function Naming

Companion reference for `glass-atrium-dev-naming/SKILL.md`. Load when designing or reviewing any function name.

## User Dictionary Precedence (read first)

The User Dictionary in SKILL.md OVERRIDES this taxonomy: prefer the small fixed verb set `get/set/find/create/update/delete/put/build` for nearly all functions. The taxonomy below remains the FALLBACK for concepts the small set genuinely cannot express — transforms, security, events, caching, init/shutdown, flow control etc. stay valid.

Lineage anchoring the dictionary:

- **Google AIP-130/131** (https://google.aip.dev/130 · https://google.aip.dev/131) — small fixed standard-method verb set (Get/List/Create/Update/Delete) + REST noun-resource orientation → small-set rule, noun-form adapter methods, put/update layering, layer mapping. Divergence: AIP `Get` is non-nullable; the user's `get` is nullable.
- **Go naming philosophy** (https://go.dev/doc/effective_go · https://google.github.io/styleguide/go/decisions.html) — "avoid stutter": surrounding context qualifies names → aggressive context removal; "prefer starting with the noun" → noun-form adapter methods. Divergence: Go omits `get` entirely; the user retains it.
- **Kotlin/Prisma suffix guarantee** (https://kotlinlang.org/api/core/kotlin-stdlib/kotlin/-result/get-or-null.html · https://www.prisma.io/docs/orm/reference/prisma-client-reference) — `get` = nullable; the non-null guarantee is carried by the `*OrThrow`/`*OrFail` suffix, not by the verb.
- **Clean Code "one word per concept"** — supports small-set consistency; the user's rule is the stricter form.
- **Anti-confusion**: the Joda/Colebourne school defines the INVERSE contract (`get` = throws · `find` = null) — same vocabulary, opposite semantics. Do NOT apply that school here; see references/ANTI-PATTERNS.md "Inverse get/find school".

## Function Name Core

**Inverse scope rule** (Martin): wide scope → short name / narrow scope → long name.

- Function name = **verb + object** · omit object when class already implies it · disambiguate with parameters when unclear.

### Layer-specific verbs

| Layer | Primary Verbs |
|-------|---------------|
| Controller | REST verbs — create·find·update·delete |
| Service | small set — get·set·find·create·update·delete·put·build (noun-form allowed on vendor-adapter surfaces) |
| Repository | Prisma verbs — find*·create·update·delete + `*OrThrow` |

## 17-Category Verb Taxonomy

### 1. Read (8 verbs)

`get` = simple acquisition, null/undefined possible (JS `Map.get` lineage — non-null guarantee ONLY via `*OrFail`/`*OrThrow` suffix) / `find` = search, returns null / `list` = returns list, empty array / `search` = text search, empty array / `fetch` = network, throws on error / `load` = DB/file, throws on error / `exists` = boolean / `count` = number

- get = O(1) simple acquisition, null possible · find = O(n) search · fetch = implies network cost · load = implies IO cost

### 2. Create (7 verbs)

`create` = create + persist immediately / `add` = add to collection / `insert` = direct SQL insert / `save` = create + update combined (Spring) / `register` = domain action (signup etc.) / `build`·`make` = construct object, no persistence / `generate` = algorithmic creation (tokens, hashes)

### 3. Update (6 verbs)

`update` = general purpose (PUT/PATCH) / `patch` = partial fields (PATCH) / `replace` = full replacement (PUT) / `set` = single field assignment / `upsert` = create if absent, update if present / `merge` = merge separated entities / `put` = internal domain-transition pipeline (User Dictionary — HTTP metaphor reused as a layer marker; `update` stays the public CRUD verb)

- Warning: `merge` means Update in JPA, Upsert in Bulk ORM — use cautiously without framework context

### 4. Delete (6 verbs)

`delete` = hard delete (REST default) / `remove` = DDD collection removal / `archive` = soft delete, domain language / `softDelete` = soft delete, technical language / `purge` = GDPR complete erasure / `clear` = empty entire collection

### 5. Batch

Unify with `*Many` suffix (`createMany`·`updateMany`·`deleteMany`) · use only one of bulk/batch/Many within the team.

- Warning: `upsert` != `sync` — sync includes DELETE for missing items, mixing causes data loss

### 6. Suffix (6 patterns)

`*OrFail`·`*OrThrow` = throw on miss / `*OrCreate` = create on miss / `*ById`·`*By*` = specify condition / `try*` = tolerate failure, returns bool/null / `ensure*` = guarantee condition, throws / `re*` = re-execute/restore (retry·rebuild·refresh·restore)

### 7. State change pairs

`activate↔deactivate` · `enable↔disable` · `publish↔unpublish` · `lock↔unlock` · `archive↔restore` · `suspend↔resume` — always define as corresponding pairs.

### 8. Transform/Parse

- **Input**: `parse` (grammar interpretation) → `deserialize` (restore object) → `decode` (representation change) · `unmarshal` (Go/gRPC)
- **Output**: `format` (human-readable) → `serialize` (byte stream) → `encode` (representation change) · `marshal` (RPC) · `stringify` (JS JSON)
- **Type**: `convert` (general) · `transform` (structural change) · `map` (element-wise) · `cast` (forced conversion, may lose data)
- **Rust**: `as_` = borrow, zero-cost / `to_` = retain, has cost / `into_` = consume, ownership transfer

### 9. Computation

`calculate` = mathematical / `compute` = general, neutral / `evaluate` = expression evaluation / `resolve` = pending → determined (Promise·DNS·DI)

- Aggregation: `sum`·`total`·`aggregate`·`accumulate`
- Comparison: `compare` (returns integer) · `diff` (change list) · `match` (pattern conformance)

### 10. Normalization/Validation

- **Sanitization**: `normalize` (standardize) · `sanitize` (remove danger, security) · `clean` (improve quality) · `trim` (remove both ends) · `strip` (broad removal) · `escape` (convert special chars) — order: sanitize → validate
- **Validation**: `validate` = complex rules, error list / `verify` = single truth, security (signatures, tokens) / `check` = lightweight condition, returns false / `assert` = test only, immediate abort / `ensure` = guard, throws

### 11. Initialization/Shutdown

- **Init hierarchy**: `init` (single component) → `setup` (test/module) → `configure` (apply options) → `bootstrap` (entire system)
- **Cleanup**: `reset` (restore initial state) · `clear` (selective) · `flush` (force all) · `purge` (permanent delete)
- **Shutdown**: `close` (reopenable) → `disconnect` (network) → `dispose` (permanent release) → `destroy` (full destruction) · `teardown` (test)

### 12. Flow Control

- **Execution**: `execute` (command/SQL) · `run` (process) · `invoke` (dynamic call) · `call` (simple call) · `apply` (context + array) · `perform` (domain action)
- **Start**: `start` (single service) · `begin` (transaction) · `launch` (process/thread) · `boot` (system)
- **Termination hierarchy**: `stop` (resumable) → `terminate` (with cleanup) → `abort` (abnormal, core dump) → `kill` (SIGKILL)
- **Pause/Resume**: `pause`↔`resume` · `suspend` (coroutine) · `retry` (after failure) · `repeat` (after success)

### 13. Events/Messaging

- **Publish**: `emit` (Node/Vue) · `dispatch` (DOM/Redux) · `trigger`·`fire` (jQuery) · `raise` (.NET) · `publish` (pub-sub)
- **Subscribe**: `subscribe` (explicit topic) · `listen` (global events) · `watch` (property/file) · `observe` (detect changes) · `monitor` (continuous state)

### 14. Compose/Split

- **Compose**: `compose` (function composition) · `combine` (heterogeneous join) · `merge` (homogeneous, key-based) · `join` (relational) · `concat` (sequential append)
- **Split**: `split` (delimiter) · `partition` (predicate, exactly 2) · `chunk` (fixed size) · `slice` (index range)
- **Symmetric**: `pick↔omit` (properties) · `filter↔reject` (predicate) · `select↔exclude` (condition) · `extract` (value extraction)

### 15. Caching

`memoize` (function args, pure functions) · `cache` (system level) · `store` (persistent/session) · `buffer` (speed difference compensation)

- **Invalidation**: `invalidate` (data changed) · `evict` (memory pressure) · `expire` (TTL)
- **Preloading**: `preload` (current page) · `prefetch` (next page) · `warm` (before service start) — preload != prefetch, mixing forbidden

### 16. Security

`encrypt` (reversible, key required) · `encode` (reversible, no key, not security) · `hash` (irreversible) · `sign` (verifiable, private key)

- **Warning**: encode != encrypt · hash != encrypt — never mix
- **Auth pipeline**: `authenticate` (verify identity) → `authorize` (verify permissions) → `permit` (grant access)
- **Masking**: `mask` (reversible) · `redact` (irreversible, legal) · `obfuscate` (code protection) · `anonymize` (irreversible, GDPR)

### 17. Logging/Tracing

`log` (single event) · `trace` (request flow) · `record` (data storage) · `track` (change monitoring) · `audit` (security immutable record)

- **Measurement**: `measure` (general) · `time` (execution duration) · `benchmark` (performance comparison) · `profile` (bottleneck location)
