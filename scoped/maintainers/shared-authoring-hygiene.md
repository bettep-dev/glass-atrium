# Maintainer note — `scoped/shared-authoring-hygiene.md`

Maintainer-facing material for that rule file. Nothing here binds an agent; the rule file carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most one pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- Not a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership — why a Tier-3 file rather than a scope-file section

- The rules bind META, PLANNING and REPORT, and the Tier-2 table gives each scope one scope file, so a scope-file section could state that membership only with a second copy of the text.

## Delivery — how the rules reach their agents

- The part slots deliver the file whole at spawn to every `rules.shared` member (`rules/glass-atrium/core-compliance-matrix.md` → `### Membership declaration and SubagentStart channels`).
- **Consequence for editors**: do not copy the bullets into an agent body — a body copy duplicates delivered text.

## Decisions taken, with their reasoning

- **The provenance carve-out under `No history-type content` stays**, for the reason its own clause states.
  - Written as a carve-out rather than a softened prohibition, so the default stays a prohibition and each exception is argued at the line.
- **`Document kind decides the call` states its reach at the bullet**, so a reader need not infer the PLANNING and REPORT membership from the matrix row.
  - The bullet deliberately does not say that a plan carries no figures: `agents/glass-atrium-intel-planner.md` → `### Default Plan Shape` lets a plan state figures as direction.
  - What binds a plan is the rest of the section — no computable count, no dated provenance.
- **`## Prompt-Audit Overrides` lives in the rule file, with no membership change.**
  - Its actor (glass-atrium-meta-prompt-engineer) and its judge (the structure verdict, glass-atrium-intel-reporter) already take the rule file, so glass-atrium-meta-agent and glass-atrium-intel-planner receive the section too.
  - Delta-only, so a guide update never leaves a stale copy of the guide's keep list in the rule file.

## Readers, coupled tests, and operational constraints

- Each reader below depends on the rule file's path, so a rename or a move breaks it.
- Of these, only `manifest.json` also carries a row for this note.

| Reader | Reads |
|---|---|
| each member agent, at spawn | the whole file — `rules.shared`, resolved by `hooks/lib/inject_chunk.py` |
| `scripts/agent_lifecycle/registry_ops.py` → `SCOPE_SHARED_RULE_FILES`, `RULE_FILES` | the path |
| `manifest.json` | the path and its hash |
| `monitor/src/server/architecture/governance-membership.ts` → `getMembershipAt` | the matrix's inline-code paths, on the install tree — on a break, the matrix path reports absent |

- **No test or hook pins the rule file's text**: a bare grep of its path, headings and bolded leads outside `scoped/`, `agents/`, `rules/` and `skills/` hits only `scripts/agent_lifecycle/registry_ops.py`, `agent-registry.json` and `manifest.json`.
- A rename also edits every corpus site naming the path (bare grep `shared-authoring-hygiene`).
- **The registry states the same membership as the matrix, and the two are edited together**: `SCOPE_SHARED_RULE_FILES` (`META`, `PLANNING`, `REPORT`) and each member agent's `rules.shared` cite the path.
  - A matrix row whose registry counterpart is missing declares a membership no row cites.
  - `hooks/validate-compliance-matrix.sh` misses that: it reads only agent names from the registry.
  - `scripts/agent_lifecycle/orphan_scan.py` → `_check_rules_membership_mismatch` reports it; no suite runs that against the real files, so run `python3 -m agent_lifecycle orphan-scan --mode rules-membership-mismatch` from `scripts/` after either edit.
