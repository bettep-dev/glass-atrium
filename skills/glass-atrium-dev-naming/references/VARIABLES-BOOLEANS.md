# Variables & Booleans — Detailed Rules

Companion reference for `glass-atrium-dev-naming/SKILL.md`. Load when working on local variables, parameters, collections, maps, or boolean flags.

## Variable Names

**S-I-D**: Short + Intuitive + Descriptive

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
- **Parameters**: if function name + type provide enough context → no need to repeat type (`findUser(id)` O) · multiple → must disambiguate (`fromId, toId`)
- **Collections**: prefer plural form (`users` O / `userList` X)
- **Maps**: `valuesByKey` pattern (`userById` O / `userMap` X)

### Noun-only form (data identifiers)

The noun rule is `scoped/shared-naming.md` → **Identifier-kind binary**. The cases below settle what counts as verb form.

- Standalone verb form forbidden: `processedData` X → `output`/`normalized` O · `calculatedTotal` X → `total` O · gerunds (`computing`, `loading`) X as a standalone variable name
- **Legitimate qualifier exception** (NOT verb padding): a past-participle adjective MODIFYING a noun answers "what kind" and is correct — `sortedList`·`cachedValue`·`parsedToken`·`activeUsers`.
  - The smell is the verb form STANDING ALONE as the whole name, not an adjective qualifying a noun.
- `handle`/`process` as a NOUN (file handle, OS handle) is correct; the anti-pattern is `handle*`/`process*` as a verb prefix on a method.

### Forbidden

- Letter-dropping abbreviation (`cstmrId` X)
- Hungarian notation (`strName` X)
- Single-char variables in 10+ line scope

## Booleans

**Which form follows the stative-first prefix** (the stative-first rule itself: `scoped/shared-naming.md` → `## Core rules outside the delta-core`):

- result state → `is` + past participle
- current state → `is` + adjective
- UI progress → `is` + present participle

| Prefix | Meaning | Following part of speech | Example |
|--------|---------|--------------------------|---------|
| `is` | State | adjective·past participle·present participle·noun | `isActive`·`isDeleted`·`isLoading`·`isAdmin` |
| `has` | Ownership/inclusion | noun only | `hasChildren`·`hasPermission` |
| `can` | Permission/capability | verb infinitive | `canEdit`·`canDelete` |
| `should` | Conditional | verb infinitive | `shouldRetry`·`shouldRender` |

- `will` (future) · `did` (past) → exceptional cases only · prefer present tense substitution

## Classes/Types · Enums/Constants · Greppability

### Classes/Types

- **Allowed-suffix allowlist and the `I`-prefix ban**: stated in `scoped/shared-naming.md` → `## Core rules outside the delta-core`.
  - Worked case of the ban: `IUserService` X → `UserService` O
- **Entity nouns**: class/type names are nouns naming the design intent — avoid verbified-noun fillers (`DataProcessor` → `Parser`/`Validator`/`Transformer`).
  - Exception: `-able` capability contracts (`Runnable`, `Callable`, `Comparable`) and `-er` agent nouns (`Reader`, `Writer`) are legitimate, NOT the filler pattern.
- **Forbidden suffixes**: `*Manager`·`*Helper`·`*Util`·`*Processor`·`*Wrapper`·`*Handler` (standalone)
- **DTO**: class name = specify direction (`CreateUserRequest`·`UserResponse`) / filename = `.dto.ts` allowed

### Enums/Constants

- **Enum members**: SCREAMING_CASE or PascalCase — consistent within the team
- **No type name repetition**: `Color.COLOR_RED` X → `Color.RED` O
- **Constants**: SCREAMING_CASE · magic numbers → extract to named constants required

### Greppability

The greppability and scope non-redundancy rules are stated in `scoped/shared-naming.md` → `## Core rules outside the delta-core`. Worked detail:

- Dynamic string concatenation for identifiers forbidden (`${prefix}Handler` X)
- Internal variables: brevity first / public identifiers: searchability first
