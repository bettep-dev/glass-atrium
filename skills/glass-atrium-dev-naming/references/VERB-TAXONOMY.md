# 17-Category Verb Taxonomy — Function Naming

## User Dictionary Precedence (read first)

- **Precedence**: `scoped/shared-naming.md` → **Canonical verb set (PRIMARY)** overrides this taxonomy.
  - This taxonomy is the fallback for an operation that set cannot express, such as transforms, security, events, caching, init/shutdown and flow control.
- **Upstream conventions this set departs from** — none of them applies here:
  - Google AIP-130/131 (https://google.aip.dev/131): `Get` returns the resource itself; here `get` is nullable.
  - Go (https://go.dev/doc/effective_go): omits `get`; here `get` stays.
  - Joda/Colebourne: `get` throws, `find` returns null → `references/ANTI-PATTERNS.md` → `### Inverse get/find school — application FORBIDDEN`.

## Function Name Core

- **Inverse scope rule**: wide scope → short name / narrow scope → long name.
- Function name = **verb + object**.
- Omit object when class already implies it.
- Disambiguate with parameters when unclear.

## 17-Category Verb Taxonomy

- Verbs that must never stand in for each other, and the order of those that run in sequence: `references/ANTI-PATTERNS.md` → `### Forbidden mixing pairs`.

### 1. Read (8 verbs)

- `get` = O(1) simple acquisition, null/undefined possible; non-null only via an `*OrFail`/`*OrThrow` suffix
- `find` = O(n) search, returns null
- `list` = returns list, empty array
- `search` = text search, empty array
- `fetch` = network (implies its cost), throws on error
- `load` = DB/file (implies IO cost), throws on error
- `exists` = boolean
- `count` = number

### 2. Create (7 verbs)

- `create` = create + persist immediately
- `add` = add to collection
- `insert` = direct SQL insert
- `save` = create + update combined (Spring)
- `register` = domain action (signup etc.)
- `build`·`make` = construct object, no persistence
- `generate` = algorithmic creation (tokens, hashes)

### 3. Update (6 verbs)

- `update` = general purpose (PUT/PATCH), the public CRUD verb
- `patch` = partial fields (PATCH)
- `replace` = full replacement (PUT)
- `set` = single field assignment
- `upsert` = create if absent, update if present
- `merge` = merge separated entities
  - Means Update in JPA, Upsert in Bulk ORM — use cautiously without framework context
- `put` = internal domain-transition pipeline, a layer marker

### 4. Delete (6 verbs)

- `delete` = hard delete (REST default)
- `remove` = DDD collection removal
- `archive` = soft delete, domain language
- `softDelete` = soft delete, technical language
- `purge` = GDPR complete erasure
- `clear` = empty entire collection

### 5. Batch

- Unify with `*Many` suffix (`createMany`·`updateMany`·`deleteMany`).
- Use only one of bulk/batch/Many within the team.
- `upsert` != `sync` — sync includes DELETE for missing items, mixing causes data loss

### 6. Suffix (6 patterns)

- `*OrFail`·`*OrThrow` = throw on miss
- `*OrCreate` = create on miss
- `*ById`·`*By*` = specify condition
- `try*` = tolerate failure, returns bool/null
- `ensure*` = guarantee condition, throws
- `re*` = re-execute/restore (retry·rebuild·refresh·restore)

### 7. State change pairs

- Always define as corresponding pairs: `activate↔deactivate` · `enable↔disable` · `publish↔unpublish` · `lock↔unlock` · `archive↔restore` · `suspend↔resume`

### 8. Transform/Parse

- **Input**: `parse` (grammar interpretation) → `deserialize` (restore object) → `decode` (representation change) · `unmarshal` (Go/gRPC)
- **Output**: `format` (human-readable) → `serialize` (byte stream) → `encode` (representation change) · `marshal` (RPC) · `stringify` (JS JSON)
- **Type**: `convert` (general) · `transform` (structural change) · `map` (element-wise) · `cast` (forced conversion, may lose data)

### 9. Computation

- `calculate` = mathematical
- `compute` = general, neutral
- `evaluate` = expression evaluation
- `resolve` = pending → determined (Promise·DNS·DI)
- Aggregation: `sum`·`total`·`aggregate`·`accumulate`
- Comparison: `compare` (returns integer) · `diff` (change list) · `match` (pattern conformance)

### 10. Normalization/Validation

- **Sanitization**: `normalize` (standardize) · `sanitize` (remove danger, security) · `clean` (improve quality) · `trim` (remove both ends) · `strip` (broad removal) · `escape` (convert special chars)
- **Validation**: `validate` = complex rules, error list · `verify` = single truth, security (signatures, tokens) · `check` = lightweight condition, returns false · `assert` = test only, immediate abort

### 11. Initialization/Shutdown

- **Init hierarchy**: `init` (single component) → `setup` (test/module) → `configure` (apply options) → `bootstrap` (entire system)
- **Cleanup**: `reset` (restore initial state) · `clear` (empty entire collection) · `flush` (force all) · `purge` (permanent delete)
- **Shutdown**: `close` (reopenable) → `disconnect` (network) → `dispose` (permanent release) → `destroy` (full destruction) · `teardown` (test)

### 12. Flow Control

- **Execution**: `run` (process) · `invoke` (dynamic call) · `call` (simple call) · `apply` (context + array)
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

- `memoize` (function args, pure functions) · `cache` (system level) · `store` (persistent/session) · `buffer` (speed difference compensation)
- **Invalidation**: `invalidate` (data changed) · `evict` (memory pressure) · `expire` (TTL)
- **Preloading**: `preload` (current page) · `prefetch` (next page) · `warm` (before service start)

### 16. Security

- `encrypt` (reversible, key required) · `encode` (reversible, no key, not security) · `hash` (irreversible) · `sign` (verifiable, private key)
- **Auth pipeline**: `authenticate` (verify identity) → `authorize` (verify permissions) → `permit` (grant access)
- **Masking**: `mask` (reversible) · `redact` (irreversible, legal) · `obfuscate` (code protection) · `anonymize` (irreversible, GDPR)

### 17. Logging/Tracing

- `log` (single event) · `trace` (request flow) · `record` (data storage) · `track` (change monitoring) · `audit` (security immutable record)
- **Measurement**: `measure` (general) · `time` (execution duration) · `benchmark` (performance comparison) · `profile` (bottleneck location)
