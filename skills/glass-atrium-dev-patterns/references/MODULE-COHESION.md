# Module Structure & Cohesion/Coupling — Detailed Rules

## Barrel File (index.ts) Criteria

| Scenario | Decision |
|----------|----------|
| Library package entry point | **Required** |
| App internal directory | **Forbidden** |
| `sideEffects: false` + tree-shaking | **Allowed** (beware of cycles) |

## Circular Dependency Prevention

- Enable ESLint `import/no-cycle`
- Self `index.ts` import forbidden
- Cycle detected → extract common module or separate interfaces

## LCOM4 Metric

- LCOM4 >= 2 → class split signal
- Practical threshold: normalized LCOM > 0.8 with more than 10 fields and 10 methods
  - Measure it with the project's metrics tool where one exists.
  - Without a tool, judge by `## Class Split Signals` rather than computing LCOM by hand.

## Class Split Signals

| Signal | Description |
|--------|-------------|
| **Field access separation** | Method groups access disjoint sets of fields |
| **Repeated mode branching** | `if mode === 'admin'` repeated across methods |
| **Heavy test Arrange** | Unit test setup is excessively complex |
| **500+ line class** | SRP violation signal |

## ISP (Interface Segregation)

- Implementation meaningfully uses < 50% of interface → **split**
- `throw new Error('Not implemented')` = ISP violation signal

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "This function is complex but it's all one logical operation" | If it has multiple abstraction levels, it violates SLAP — extract helpers named by intent |
| "Adding a parameter object for 4 args is over-engineering" | 4+ parameters make call sites unreadable and error-prone — object destructuring is cheap |
| "Barrel files make imports cleaner" | App-internal barrels cause circular dependencies and break tree-shaking — use direct imports |
| "The class is long but everything belongs together" | 500+ lines with disjoint field access groups = LCOM4 violation — split by cohesion |
| "`any` is temporary, I'll fix the types later" | `any` propagates virally — use `unknown` + narrowing from the start |

## Verification

- [ ] **Member ordering**: Spot-check 2-3 classes — members follow `scoped/shared-code-structure.md` → `## Core Principles` → `Member ordering`
- [ ] **Function size**: Each function over 20 lines has a justification or extraction plan
- [ ] **Import direction**: No reverse imports (Repository → Service or Controller) found via `Grep`
- [ ] **Type safety**: `Grep` for `any` used as a type in `*.ts` files (excluding test files) — zero matches
- [ ] **Circular dependency**: ESLint `import/no-cycle` enabled and passing
