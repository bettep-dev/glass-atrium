# Naming Anti-Patterns — Prohibited Forms

Companion reference for `glass-atrium-dev-naming/SKILL.md`. Load when auditing naming violations or resolving review comments.

## Anti-Pattern Prohibition

### Verb-form padding & helper-verb wrappers (functions — forbidden)

- **Forbidden forms**: `do*` · `handle*` (standalone) · `manage*` · `process*` (standalone) · `perform*` · `execute*` · `getData` · `setData` — these wrap the real verb in empty scaffolding.
- **Strip to the direct verb**: a canonical-set verb (`scoped/shared-naming.md` → **Canonical verb set (PRIMARY)**) where it expresses the operation, otherwise the domain verb.
- **Nominalization** (`verb + NounFormOfVerb`: `performDeletion`, `executePayment`, `doCalculation`) is a disguised verb → use the base verb.

### Naming violations table

| X | O | Reason |
|---|---|--------|
| `performDeletion()` | `delete()` | Re-verbing a nominalization |
| `doValidation()` | `validate()` | `do` is empty scaffolding around the real verb |
| `executePayment()` | `pay()`/`charge()` | `execute` is a generic wrapper — domain verb is shorter + precise |
| `handleRequest()` | `route()`/`dispatch()` | `handle` says nothing specific about what happens |
| `DataProcessor` (class) | `Parser`/`Validator` | Verbified-noun class hides design intent (data identifier = noun) |
| `processedData` (var) | `normalized`/`output` | Past-participle verb form as data name → noun describing what it IS |
| `hasDeletion` | `isDeleted` | has + nominalization → is + past participle |
| `hasFileExistence` | `isFilePresent` | Unnecessary possessive expression; the boolean keeps a stative prefix |
| `isNotEnabled` | `isEnabled` | Negated name forces a double negation at use (`!isNotEnabled`) |
| `userList` | `users` | Redundant type suffix |
| `userMap` | `userById` | Ambiguous map suffix |
| `UrlManager` | → redefine the role | Noise suffix |
| `Color.COLOR_RED` | `Color.RED` | Enum type name repetition |

### Circular naming (class root = method root)

When a class name and a method name share the same root, the concept is doubled. Collapse to a noun entity + a distinct verb/predicate:

- `ConditionChecker.checkCondition()` → `Condition.isTrue()`
- `DataValidator.validateData()` → `Validator.validate()` (or distribute `validate` onto the data's own type)
- `*Manager`/`*Handler`/`*Processor` suffix (a verbified-noun disguise) → name the specific noun entity (`Session`, `Invoice`, `Queue`) and put verb methods directly on it (`session.open()`/`session.close()`).

### Synonym mixing forbidden

- Never mix get/find/fetch/retrieve etc. for one purpose in the same layer — `scoped/shared-naming.md` → **One verb per purpose per layer**.

### Inverse get/find school — application FORBIDDEN

- **The inverse school**: Joda/Colebourne (https://blog.joda.org/2015/09/naming-optional-query-methods.html) documents the INVERSE contract — `get` = throws on miss · `find` = returns null. Same vocabulary, OPPOSITE semantics.
- **This codebase**: the User Dictionary's `get` contract applies (`scoped/shared-naming.md` → `## Agent Injection Core`) — `get` = simple acquisition with null/undefined possible (JS `Map.get` lineage).
  - The non-null guarantee is carried ONLY by `*OrFail`/`*OrThrow` suffixes (Prisma/Kotlin style).
- **Violation**: writing a `get*` that throws on miss without the suffix — or "fixing" a nullable `get*` to throw because "get means guaranteed" — is a contract violation here.

### Forbidden mixing pairs

Each pair names two distinct semantic contracts — never use one verb where the other is meant:

- `encode` ↔ `encrypt`
- `hash` ↔ `encrypt`
- `validate` ↔ `sanitize` (order: sanitize → validate)
- `flush` ↔ `clear`
- `authenticate` ↔ `authorize` (order: authenticate → authorize)
- `preload` ↔ `prefetch`
- `memoize` ↔ `cache`

## Scope Non-Redundancy Principle (no-stutter)

Worked rows for `scoped/shared-naming.md` → **No-stutter**: name only the part the parent scope (package, class, module, namespace, receiver, directory) does not already express.

- `User.userName` X → `User.name` O
- `UserService.getUser()` X → `UserService.get()` O
- `auth/AuthValidator` X → `auth/Validator` O
- `http.HTTPServer` X → `http.Server` O (package qualifier already supplies HTTP)
- `sqldb.DBConnection` X → `sqldb.Connection` O
- `func (p *Project) ProjectName()` X → `Name()` O (receiver supplies the domain)
- inside `UserCount()`: `var userCount` X → `var count` O (method name established the domain)
- Application scope: a global acronym prefix on every member (`GSDFirstName`/`GSDLastName` X → `FirstName`/`LastName` O) adds zero discriminating context and pollutes autocomplete.

## Reduction Floor — over-reduction is also a violation

Conciseness has a floor: a name must still form a precise mental image, distinguish from siblings, and be uniquely greppable. The two moves are gated.

- **Order**: evaluate domain-strip first (does the enclosing scope supply it?), verb-strip second (is the noun alone sufficient?). Apply BOTH in one step only when each passes independently.
- **Generic-terminal ban**: never reduce to `data`·`value`·`status`·`result`·`thing`·`object`·`info`·`count` (unqualified) — these are the forbidden floor.
- **Sibling-collision keeps the qualifier**: if two identifiers collapse to the same name after domain-strip, retain it for both (`userCount`/`projectCount`, `fileBlock`/`diskBlock` — Ousterhout's Sprite-OS `block` data-corruption bug). Different things → different names always wins over conciseness.
- **Verb retained when it is the only signal** of a computation vs a stored field (`calculateTotal` ≠ stored `total`) or of operation direction (`validate`/`read`/`calculate`).
- **Cross-boundary names keep their qualifier**: a stripped name (`New`, `Load`, `Get`) is safe only when the package/scope restores context at every reading site — opaque in a log line / error message / across a package boundary → keep the word.
- **Abbreviation**: only universally recognized forms (HTTP, JWT, ctx), the list in `references/VARIABLES-BOOLEANS.md` → `### Allowed abbreviations`, and the short forms its `### Scope-proportional length` table allows inside a 3-5 line closure.
  - Outside those, partial truncation (`passwd`·`usr`·`cust`) is forbidden — unguessable.

| Over-reduction X | Keep O | Why |
|---|---|--------|
| `processOrder()` → `process()` | `process()` only inside an `Order` type | bare `process` loses the object + is unsearchable |
| `validatePaymentStatus()` → `status` | `validate` + scope-supplied domain | collapses to a generic-terminal anti-pattern |
| `handleAuthenticationError()` → `err` | scope-proportional descriptive name | single-letter beyond a tiny block conveys nothing |
| `fileBlock` → `block` (two block kinds coexist) | `fileBlock`/`diskBlock` | sibling collision → keep the disambiguator |

## Forbidden Class/Type Suffixes

- Class/type suffixes are a closed allowlist (`scoped/shared-naming.md` → `## Core rules outside the delta-core`); every suffix outside it is forbidden. Common violations:

| Suffix | Why forbidden |
|--------|---------------|
| `*Manager` | Noise — describes responsibility vaguely |
| `*Helper` | Signals missing SRP — fold into the owning class |
| `*Util` | Static grab-bag — prefer a named module |
| `*Processor` | Same issue as `handle` — too generic |
| `*Wrapper` | Wrapping without added semantics |
| `*Handler` | Same issue as `handle`; a qualifier (`ErrorHandler`) does not put it on the allowlist |

## Anti-Pattern: Dynamic Identifier Construction

- `${prefix}Service` / ``obj[`get${Field}`]`` — breaks greppability and IDE navigation
- Public identifiers MUST be statically visible in source

## Anti-Pattern: Cross-Layer Rename

- Naming one operation differently across layers is forbidden (`scoped/shared-naming.md` → **One verb per purpose per layer**).
  - Violation: Controller `createUser` / Service `addUser` / Repository `insertUser`.
  - Why: a reviewer cannot trace the call chain across renamed layers.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "The team already uses `getData` everywhere" | Existing bad patterns are not precedent — propose a migration plan with the correct verb |
| "The name is too long if I follow the rules" | Apply the conciseness principles in SKILL.md — length issues come from redundancy, not specificity |
| "It's just a local variable, naming doesn't matter" | Scope-proportional length still applies — even locals need to be intuitive within their scope |
| "I'll rename it later during refactoring" | Naming debt compounds — correct naming at creation costs less than retroactive renaming |
| "`handle` is clear enough in context" | `handle` is a code smell — replace with the specific action verb (validate, transform, route, etc.) |

## Red Flags

- Same verb (e.g., `get`) used for both O(1) access and O(n) search in the same module
- A `get*` function that throws on miss without an `*OrFail`/`*OrThrow` suffix (Joda-school contract leaking in)
- Boolean variable without `is`/`has`/`can`/`should` prefix
- Function name lacks a verb outside a vendor-adapter surface (noun-only like `user()` instead of `getUser()`/`findUser()`)
- Data identifier carries a verb form (`processedData`, `calculatedTotal` as a variable) instead of a noun
- Over-reduced to a generic terminal (`data`·`value`·`status`·`result`·unqualified `count`) or to a non-greppable single concept
- Class or type suffix outside the allowlist (`*Manager`, `*Helper`, `*Util`, `*Handler`), or a module named `*Manager`, `*Helper` or `*Util`
- Plural/singular mismatch: single item named `users`, collection named `user`
- Dynamic identifier construction via string concatenation (`${prefix}Service`)
- `encode` used where `encrypt` is meant (or vice versa)
- Same concept named differently across layers (`create`/`add`/`insert` for the same operation)

## Verification

- [ ] **Grep test**: All public identifiers return results via `Grep` (no dynamic construction)
- [ ] **Verb consistency**: `Grep` each verb category (get/find/fetch) per layer — no mixing within the same layer
- [ ] **Boolean audit**: `Grep` for `boolean` / `: boolean` declarations — all use approved prefixes
- [ ] **Forbidden suffix scan**: `Grep` for `Manager|Helper|Util|Processor|Wrapper|Handler` in class/type declarations — zero matches, and every remaining suffix is on the allowlist
- [ ] **Conciseness check**: No identifier repeats information already in its parent scope (class name, module name)
- [ ] **Reduction floor**: No reduced name is a generic terminal (`data`/`value`/`status`/`result`/unqualified `count`); each reduced form is uniquely greppable and keeps its qualifier where a sibling would collide
