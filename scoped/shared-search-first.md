# Search-First Rules (Cross-Cutting Concern)

Applies to all DEV agents.

## Principles

**Searching for existing solutions is REQUIRED before implementing new functionality**:

- **Within the project**: search for similar implementations via Grep/Glob → prevent duplication
- **Packages**: check existing libraries on npm/pub/maven → minimize custom implementations
- **Official docs**: verify framework built-in features → avoid reinventing the wheel
- **Pattern recognition** (Search → Read → Mirror — see scope-dev.md → Pre-Execution Verification → Project Convention Probe):
  - **Step 1 — Search**: Glob sibling files in the same directory + same extension as the planned Write/Edit target
  - **Step 2 — Read**: read 1 most-recently-modified sibling file before any new write (mandatory — Karpathy "Surgical Changes" alignment)
  - **Step 3 — Mirror**: apply the 3 extracted axes (`naming case` / `import order` / `error+log pattern`) to the new code — these axes govern code style only; comment LANGUAGE **and comment density / header length** defer to `shared-comment-logging.md` (a sibling is never a precedent for reproducing a non-compliant comment block — author compliant comments per the comment rules; tooling-directive / pragma comments are the exception — they are code-form and ARE mirrored)

## When to Apply

- When adding features, writing utilities, or integrating external APIs
- **During bug fixes for root cause analysis** — search for similar patterns, prior fix history, and related tests

## Prohibitions

- Starting implementation without searching first
- Duplicating functionality that already exists in existing utilities
- Reimplementing features already built into the framework

> See the central **Rationalization Rejection Table** in [[GLOBAL_RULES#Rationalization Rejection Table (Central)]]

## Escalation to Iterative Codebase Retrieval

Opt-in escalation path — applies when the 3-step Pattern recognition chain (Search → Read → Mirror, see `## Principles`) yields ambiguous, oversized (>50 hits), or unrelated results. Single-pass exact-match cases (known file path, unique symbol name) remain on the 3-step chain — escalation is NOT a default upgrade.

- **Trigger**: Step 1 Glob returns >50 sibling hits OR Step 2 Read of the most-recent sibling reveals inconsistent conventions (3+ divergent patterns) OR Step 3 Mirror axes cannot be extracted with confidence → escalate to the iterative Retrieve → Evaluate → Refine → Stop loop.
- **Reference**: `scope-research.md` → `## Iterative Codebase Retrieval [RESEARCH]` (canonical loop spec + 4-dimension EVALUATE rubric + Stop-RAG cap=3 ceiling). DEV agents invoke the loop directly when triggered; full delegation to intel-researcher only when codebase exploration scope exceeds current-task surface area.
- **Non-replacement**: the 3-step Mirror chain remains the default Project Convention Probe — escalation supplements it for ambiguous cases, never substitutes.
