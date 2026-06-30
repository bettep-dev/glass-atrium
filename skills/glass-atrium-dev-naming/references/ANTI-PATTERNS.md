# Naming Anti-Patterns — Prohibited Forms

Companion reference for `glass-atrium-dev-naming/SKILL.md`. Load when auditing naming violations or resolving review comments.

## Anti-Pattern Prohibition

### Verb-form padding & helper-verb wrappers (functions — forbidden)

`do*` · `handle*` (standalone) · `manage*` · `process*` (standalone) · `perform*` · `execute*` · `getData` · `setData` — these wrap the real verb in empty scaffolding. Strip to the direct domain verb (within the User Dictionary small set where it expresses the operation). Nominalization (`verb + NounFormOfVerb`: performDeletion, executePayment, doCalculation) is a disguised verb → use the base verb.

### Naming violations table

| X | O | Reason |
|---|---|--------|
| `performDeletion()` | `delete()` | Re-verbing a nominalization |
| `doValidation()` | `validate()` | `do` is empty scaffolding around the real verb |
| `executePayment()` | `pay()`/`charge()` | `execute` is a generic wrapper — domain verb is shorter + precise |
| `handleRequest()` | `route()`/`dispatch()` | `handle` says nothing specific about what happens |
| `ConditionChecker.checkCondition()` | `Condition.isTrue()` | Circular naming — class + method double the same root |
| `DataProcessor` (class) | `Parser`/`Validator` | Verbified-noun class hides design intent (data identifier = noun) |
| `processedData` (var) | `normalized`/`output` | Past-participle verb form as data name → noun describing what it IS |
| `hasDeletion` | `isDeleted` | has + nominalization → is + past participle |
| `hasFileExistence` | `fileExists` | Unnecessary possessive expression |
| `isNotEnabled` | `isEnabled` | Double negation |
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

Cannot mix get/find/fetch/retrieve etc. in the same layer — **one verb per purpose within a project**.

### Inverse get/find school — application FORBIDDEN

The Joda/Colebourne school (https://blog.joda.org/2015/09/naming-optional-query-methods.html) documents the INVERSE contract: `get` = throws on miss · `find` = returns null. Same vocabulary, OPPOSITE semantics — a classic confusion source. In this codebase the User Dictionary applies: `get` = simple acquisition with null/undefined possible (JS `Map.get` lineage), and the non-null guarantee is carried ONLY by `*OrFail`/`*OrThrow` suffixes (Prisma/Kotlin style). Writing a `get*` that throws on miss without the suffix — or "fixing" a nullable `get*` to throw because "get means guaranteed" — is a contract violation here.

### Forbidden mixing pairs

- `encode` ↔ `encrypt`
- `hash` ↔ `encrypt`
- `validate` ↔ `sanitize` (order: sanitize → validate)
- `flush` ↔ `clear`
- `authenticate` ↔ `authorize` (order guaranteed)
- `preload` ↔ `prefetch`
- `memoize` ↔ `cache`

Mixing any of the above signals misunderstanding of the semantic contract.

## Scope Non-Redundancy Principle (no-stutter)

Do not repeat information the parent scope (package, class, module, namespace, receiver, directory) already expresses. The enclosing scope is free context — name only the distinguishing part.

- `User.userName` X → `User.name` O
- `UserService.getUser()` X → `UserService.get()` O
- `auth/AuthValidator` X → `auth/Validator` O
- `http.HTTPServer` X → `http.Server` O (package qualifier already supplies HTTP)
- `sqldb.DBConnection` X → `sqldb.Connection` O
- `func (p *Project) ProjectName()` X → `Name()` O (receiver supplies the domain)
- inside `UserCount()`: `var userCount` X → `var count` O (method name established the domain)

The same anti-pattern at application scope: a global acronym prefix on every member (`GSDFirstName`/`GSDLastName` → `FirstName`/`LastName`) adds zero discriminating context and pollutes autocomplete.

## Reduction Floor — over-reduction is also a violation

Conciseness has a floor: a name must still form a precise mental image, distinguish from siblings, and be uniquely greppable. The two moves are gated.

- **Order**: evaluate domain-strip first (does the enclosing scope supply it?), verb-strip second (is the noun alone sufficient?). Apply BOTH in one step only when each passes independently.
- **Generic-terminal ban**: never reduce to `data`·`value`·`status`·`result`·`thing`·`object`·`info`·`count` (unqualified) — these are the forbidden floor.
- **Sibling-collision keeps the qualifier**: if two identifiers collapse to the same name after domain-strip, retain it for both (`userCount`/`projectCount`, `fileBlock`/`diskBlock` — Ousterhout's Sprite-OS `block` data-corruption bug). Different things → different names always wins over conciseness.
- **Verb retained when it is the only signal** of a computation vs a stored field (`calculateTotal` ≠ stored `total`) or of operation direction (`validate`/`read`/`calculate`).
- **Cross-boundary names keep their qualifier**: a stripped name (`New`, `Load`, `Get`) is safe only when the package/scope restores context at every reading site — opaque in a log line / error message / across a package boundary → keep the word.
- **Abbreviation**: only universally recognized forms (HTTP, JWT, ctx). Partial truncation (`passwd`·`usr`·`acc`·`cust`) is always forbidden — unguessable.

| Over-reduction X | Keep O | Why |
|---|---|--------|
| `processOrder()` → `process()` | `process()` only inside an `Order` type | bare `process` loses the object + is unsearchable |
| `validatePaymentStatus()` → `status` | `validate` + scope-supplied domain | collapses to a generic-terminal anti-pattern |
| `handleAuthenticationError()` → `err` | scope-proportional descriptive name | single-letter beyond a tiny block conveys nothing |
| `fileBlock` → `block` (two block kinds coexist) | `fileBlock`/`diskBlock` | sibling collision → keep the disambiguator |

## Forbidden Class/Type Suffixes

| Suffix | Why forbidden |
|--------|---------------|
| `*Manager` | Noise — describes responsibility vaguely |
| `*Helper` | Signals missing SRP — fold into the owning class |
| `*Util` | Static grab-bag — prefer a named module |
| `*Processor` | Same issue as `handle` — too generic |
| `*Wrapper` | Wrapping without added semantics |
| `*Handler` (standalone) | OK only when disambiguated (`ErrorHandler`) |

## Anti-Pattern: Dynamic Identifier Construction

- `${prefix}Service` / `obj[`get${Field}`]` — breaks greppability and IDE navigation
- Public identifiers MUST be statically visible in source

## Anti-Pattern: Cross-Layer Rename

Same concept named differently across layers is forbidden. Example:

- Controller: `createUser` / Service: `addUser` / Repository: `insertUser`

Pick one verb per layer pair and stick to it — otherwise reviewers cannot trace call chains.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "The team already uses `getData` everywhere" | Existing bad patterns are not precedent — propose a migration plan with the correct verb |
| "The name is too long if I follow the rules" | Apply the 5 conciseness principles — length issues come from redundancy, not specificity |
| "It's just a local variable, naming doesn't matter" | Scope-proportional length still applies — even locals need to be intuitive within their scope |
| "I'll rename it later during refactoring" | Naming debt compounds — correct naming at creation costs less than retroactive renaming |
| "`handle` is clear enough in context" | `handle` is a code smell — replace with the specific action verb (validate, transform, route, etc.) |

## Red Flags

- Same verb (e.g., `get`) used for both O(1) access and O(n) search in the same module
- A `get*` function that throws on miss without an `*OrFail`/`*OrThrow` suffix (Joda-school contract leaking in)
- Boolean variable without `is`/`has`/`can`/`should` prefix
- Function name lacks a verb (noun-only like `user()` instead of `getUser()`/`findUser()`)
- Data identifier carries a verb form (`processedData`, `calculatedTotal` as a variable) instead of a noun
- Over-reduced to a generic terminal (`data`·`value`·`status`·`result`·unqualified `count`) or to a non-greppable single concept
- Class or module using a forbidden suffix (`*Manager`, `*Helper`, `*Util`)
- Plural/singular mismatch: single item named `users`, collection named `user`
- Dynamic identifier construction via string concatenation (`${prefix}Service`)
- `encode` used where `encrypt` is meant (or vice versa)
- Same concept named differently across layers (`create`/`add`/`insert` for the same operation)

## Verification

- [ ] **Grep test**: All public identifiers return results via `Grep` (no dynamic construction)
- [ ] **Verb consistency**: `Grep` each verb category (get/find/fetch) per layer — no mixing within the same layer
- [ ] **Boolean audit**: `Grep` for `boolean` / `: boolean` declarations — all use approved prefixes
- [ ] **Forbidden suffix scan**: `Grep` for `Manager|Helper|Util|Processor|Wrapper` in class/type declarations — zero matches
- [ ] **Conciseness check**: No identifier repeats information already in its parent scope (class name, module name)
- [ ] **Reduction floor**: No reduced name is a generic terminal (`data`/`value`/`status`/`result`/unqualified `count`); each reduced form is uniquely greppable and keeps its qualifier where a sibling would collide
