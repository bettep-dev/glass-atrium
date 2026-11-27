# Variables & Booleans — Detailed Rules

Companion reference for `glass-atrium-dev-naming/SKILL.md`. Load when naming local variables, parameters, collections, maps, booleans, classes/types, enums or constants.

## Variable Names

### Scope-proportional length

| Scope | Length | Example |
|-------|--------|---------|
| Single expression | 1 char | `users.filter(u => u.isActive)` |
| 3-5 line closure | abbrev | `acc`·`curr`·`prev` |
| Entire function | 1+ words | `user`·`count` |
| Class field | 2 words | `activeUsers`·`requestTimeout` |
| Module/global | specific | `headerBounceAnimationDuration` |

### Allowed abbreviations

`Id`·`Url`·`Api`·`Dto`·`Db`·`Auth`·`Config`·`req`·`res`·`err`·`msg`·`ctx`·`cb`

### Other rules

- **Acronyms**: treat as words (`loadHttpUrl` O / `loadHTTPURL` X)
- **Short form allowed**: local variables with clear type (`const unit: OrganizationUnit` → `unit`)
- **Parameters**: if function name + type provide enough context → no need to repeat type (`findUser(id)` O)
  - Multiple parameters → must disambiguate (`fromId, toId`).
  - A function's own parameters are never grouped (`scoped/shared-naming.md` → **Prefix-family grouping**).
- **Collections**: prefer plural form (`users` O / `userList` X)
- **Maps**: `valuesByKey` pattern (`userById` O / `userMap` X) where no other name shares its value noun.
  - Beside another name of its value noun, a map joins that family by key: `userById`/`userByEmail` → `user: { byId, byEmail }` · `userById`/`userId` → `user: { id, byId }` (`scoped/shared-naming.md` → **Prefix-family grouping**).

### Noun-only form (data identifiers)

The noun rule is `scoped/shared-naming.md` → **Identifier-kind binary**. The cases below settle what counts as verb form.

- Standalone verb form forbidden: a gerund as the whole variable name (`computing`, `loading`) X.
- **Legitimate qualifier exception**: an adjective or past participle qualifying a noun is correct only when it answers "what kind" — `sortedList`·`cachedValue`·`parsedToken`·`activeUsers`.
  - A qualifier every value of the noun carries answers nothing and is verb padding: `processedData` X → `output`/`normalized` O · `calculatedTotal` X → `total` O.
- **Group members read with their group** (**Identifier-kind binary**): `request.pending`, `paymentRequest.failed` and `user.byId` pass — a member never stands alone.
- `handle`/`process` as a noun (file handle, OS handle) is a correct data name; only their use as a method's verb prefix is padding.

### Forbidden

- Letter-dropping abbreviation (`cstmrId` X)
- Hungarian notation (`strName` X)

## Booleans

The stative-first rule itself: `scoped/shared-naming.md` → `## Core rules outside the delta-core`. The part of speech each prefix takes:

| Prefix | Meaning | Following part of speech | Example |
|--------|---------|--------------------------|---------|
| `is` | State | adjective (current state) · past participle (result state) · present participle (UI progress) · noun | `isActive`·`isDeleted`·`isLoading`·`isAdmin` |
| `has` | Ownership/inclusion | noun only | `hasChildren`·`hasPermission` |
| `can` | Permission/capability | verb infinitive | `canEdit`·`canDelete` |
| `should` | Conditional | verb infinitive | `shouldRetry`·`shouldRender` |

- `will` (future) · `did` (past) → restate in the present tense under a prefix from the table (`didLoad` → `isLoaded` · `willRetry` → `shouldRetry`)

## Classes/Types · Enums/Constants · Greppability

### Classes/Types

- **Allowed-suffix allowlist and the `I`-prefix ban**: stated in `scoped/shared-naming.md` → `## Core rules outside the delta-core`.
  - Worked case of the ban: `IUserService` X → `UserService` O
- **Entity nouns**: class/type names are nouns naming the design intent — avoid verbified-noun fillers (`DataProcessor` → `Parser`/`Validator`/`Transformer`).
  - Exception: `-able` capability contracts (`Runnable`, `Callable`, `Comparable`) and `-er` agent nouns (`Reader`, `Writer`) are legitimate, not the filler pattern.
- **Forbidden suffixes**: the table in `references/ANTI-PATTERNS.md` → `## Forbidden Class/Type Suffixes`
- **DTO**: class name = specify direction (`CreateUserRequest`·`UserResponse`)
  - Filename: `.dto.ts` allowed.

### Enums/Constants

- **Enum members**: SCREAMING_CASE or PascalCase — consistent within the team
- **No type name repetition**: `Color.COLOR_RED` X → `Color.RED` O
- **Constants**: SCREAMING_CASE
  - Magic numbers → extract to named constants required.

### Greppability

The greppability and scope non-redundancy rules are stated in `scoped/shared-naming.md` → `## Core rules outside the delta-core`. Worked detail:

- Identifiers built by string concatenation are forbidden (`${prefix}Service` X): `references/ANTI-PATTERNS.md` → `## Anti-Pattern: Dynamic Identifier Construction`
- Internal variables: brevity first / public identifiers: searchability first
