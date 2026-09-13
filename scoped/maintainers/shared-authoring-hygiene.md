# Maintainer note — `scoped/shared-authoring-hygiene.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership — why a Tier-3 file rather than a scope-file section

- The rules bind three scopes: META (prompt, agent-instruction, rule and skill authoring), PLANNING and REPORT (the documents those agents author). The Tier-2 table gives each scope exactly one scope file, so no scope-file section can state a three-scope membership without a second copy of the text — which is the drift this file exists to avoid.
- Tier 3 is the corpus's cross-cutting tier and already carries files whose membership is a curated agent set rather than a whole scope, so a META+PLANNING+REPORT file is the tier's existing shape, not a new mechanism.
- **This is the only Tier-3 file with no DEV member**, and the only one BOTH META agents take: `glass-atrium-meta-agent` rewrites agent instructions, so a rule binding authored instruction text binds it. Every other Tier-3 META cell is `glass-atrium-meta-prompt-engineer` alone.
- Membership is declared on each agent's `agent-registry.json` row (`rules.shared`) and summarized in `rules/glass-atrium/core-compliance-matrix.md`.

## Delivery — how the rules reach their agents

- The file arrives whole at spawn for every agent whose `agent-registry.json` row lists it in `rules.shared`: the part-slot channel (`hooks/inject-scope-part-*.sh` → `hooks/lib/inject_chunk.py`) packs each `rules.scope` and `.shared` member into context. The file carries no marker, so slot 1 (`hooks/inject-scope-rules.sh`) delivers none of it.
- **Consequence for editors**: do not copy the bullets into an agent body — a body copy duplicates delivered text and has to be retired from a second direction.

## Decisions taken, with their reasoning

- **The provenance carve-out under `No history-type content` is ACCEPTED and stays.** A provenance line that changes what the reader DOES next is operative content, not history; an honest-backing note saying what is and is not enforced changes how the reader treats the rule, so the prohibition does not reach it. The boundary it does not move: a Wave or ADR tag, a correlation ID, a `doc NNNN` reference, an edit-history date, a changelog line, `(NEW)` or `(was X before)` change no reader action and still go. Written as a carve-out rather than a softened prohibition so the default stays a prohibition and the exception has to be argued at the line.
- **`Document kind decides the call` states its reach at the bullet.** Naming a plan and a handoff record is what makes the PLANNING and REPORT membership operative, so the reach past the prompt corpus is stated in the rule text rather than left for a reader to infer from the matrix row.
  - The bullet deliberately does NOT say that a plan carries no figures: `agents/glass-atrium-intel-planner.md` → `### Default Plan Shape` has a plan carrying figures that are estimates, and a prohibition on figures would contradict it. What binds a plan is the rest of the section — no computable count, no dated provenance.
- **`No derived values` takes the rule-plus-carve-out shape of its neighbour.** The carve-out is a judgement rather than an automatic exemption, because a bare cardinality standing beside no list can be the only signal that the list is closed.

## Readers, coupled tests, and operational constraints

- No code reads this file's TEXT. `monitor/src/server/architecture/governance-membership.ts` resolves every `scoped/…md` inline-code path written in the matrix against the install tree and reports an absent one, so the matrix rows and this file are created together.
- The path is pinned in `scripts/agent_lifecycle/registry_ops.py` (`RULE_FILES`, derived from `SCOPE_SHARED_RULE_FILES`) and in `manifest.json` (file list + hash). Renaming the file edits both, plus every registry row and the matrix row that name it.
- `scripts/test/test_agent_lifecycle_overhaul.py` reads `SCOPE_SHARED_RULE_FILES["DEV"]` dynamically and asserts no other key, so a META / PLANNING / REPORT entry needs no test edit.
- **The registry states the same membership as the matrix, and the two are edited together**: `SCOPE_SHARED_RULE_FILES` carries a `META`, a `PLANNING` and a `REPORT` entry naming this file, and the `rules.shared` array of `glass-atrium-meta-prompt-engineer`, `glass-atrium-meta-agent`, `glass-atrium-intel-planner` and `glass-atrium-intel-reporter` cites the same path. A matrix row whose registry counterpart is missing declares a membership no row cites, and no suite detects it — `hooks/validate-compliance-matrix.sh` reads only agent NAMES from the registry, never rule lists.
