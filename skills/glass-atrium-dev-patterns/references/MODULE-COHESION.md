# Module Structure & Cohesion/Coupling — Detailed Rules

Companion reference for `glass-atrium-dev-patterns/SKILL.md`. Load when designing module boundaries, evaluating coupling, or auditing DI graphs.

## Module Structure [DEV]

**Import direction**: Controller → Service → Repository — reverse direction forbidden.

## Barrel File (index.ts) Criteria

| Scenario | Decision |
|----------|----------|
| Library package entry point | **Allowed** (required) |
| App internal directory | **Forbidden** |
| `sideEffects: false` + tree-shaking | **Allowed** (beware of cycles) |

## Circular Dependency Prevention

- Enable ESLint `import/no-cycle`
- Self `index.ts` import forbidden
- Cycle detected → extract common module or separate interfaces

## Module Organization Patterns

| Pattern | Description | Application |
|---------|-------------|-------------|
| **Feature Module** | Domain-scoped module | NestJS default structure |
| **Layer Structure** | Controller/Service/Repository | Internal module structure |

## Cohesion/Coupling [DEV]

**High cohesion + low coupling** — split on violation.

## LCOM4 Metric

- LCOM4 >= 2 → class split signal
- Practical threshold: LCOM (normalized 0-1) > 0.8 **&&** fields > 10 **&&** methods > 10

## Class Split Signals

| Signal | Description |
|--------|-------------|
| **Field access separation** | Method groups access disjoint sets of fields |
| **7+ constructor dependencies** | God Class warning |
| **Repeated mode branching** | `if mode === 'admin'` repeated across methods |
| **Heavy test Arrange** | Unit test setup is excessively complex |
| **500+ line class** | SRP violation signal |

## ISP (Interface Segregation)

- Implementation meaningfully uses < 50% of interface → **split**
- `throw new Error('Not implemented')` = ISP violation signal

## DI (Dependency Injection)

| Rule | Description |
|------|-------------|
| **Depend on interfaces** | Depend on interfaces, not concrete classes |
| **Constructor parameters** | 7+ = God Class warning → consider splitting |
| **Circular DI** | Forbidden — forwardRef is a design flaw signal |

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "This function is complex but it's all one logical operation" | If it has multiple abstraction levels, it violates SLAP — extract helpers named by intent |
| "Adding a parameter object for 4 args is over-engineering" | 4+ parameters make call sites unreadable and error-prone — object destructuring is cheap |
| "Barrel files make imports cleaner" | App-internal barrels cause circular dependencies and break tree-shaking — use direct imports |
| "The class is long but everything belongs together" | 500+ lines with disjoint field access groups = LCOM4 violation — split by cohesion |
| "`any` is temporary, I'll fix the types later" | `any` propagates virally — use `unknown` + narrowing from the start |

## Red Flags

- Function exceeding 20 lines without clear single responsibility
- Switch/if-else chain without exhaustive `never` check on discriminated unions
- Import direction violation: Repository importing from Controller or Service
- Class with 7+ constructor dependencies (God Class)
- `throw new Error('Not implemented')` in an interface implementation (ISP violation)
- Nested generics beyond 2 levels (e.g., `Map<string, Array<Promise<T>>>`)
- `any` type appearing in non-test code
- Barrel `index.ts` file inside an application directory (not a library)

## Verification

- [ ] **Member ordering**: Spot-check 2-3 classes — members follow the 8-category accessibility order
- [ ] **Function size**: `Grep` for functions exceeding 20 lines — each has a justification or extraction plan
- [ ] **Import direction**: No reverse imports (Repository → Controller) found via `Grep`
- [ ] **Type safety**: `Grep` for `any` in `*.ts` files (excluding test files) — zero matches or each has a justifying comment
- [ ] **Circular dependency**: ESLint `import/no-cycle` enabled and passing
