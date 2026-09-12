# Maintainer note — `scoped/scope-wiki.md`

Maintainer-facing material for that source file, plus the record of what the cut-and-restructure pass removed from it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: both surviving headings carry rules rather than stubs, so the source file took no pointer back to this note.

## Status in the corpus

- Tier 2 (Scope), membership `agent_scope ∈ {glass-atrium-wiki-curator}`, inheriting Tier 1. Declared at `rules/glass-atrium/core-compliance-matrix.md` → the Tier 2 table and the Compliance Matrix `scope-wiki.md` row.
- Both surviving headings are cited from `agents/glass-atrium-wiki-curator.md` and must keep their names: the health-check `Stale` bullet cites `scoped/scope-wiki.md (Staleness surface)`, and the raw-ingestion frontmatter precondition cites `per scope-wiki Operational Constraints`. `skills/glass-atrium-ops-orchestrator.md` and `scripts/wiki-daemon-entry-prompt.md` cite the file by name only.
- Those citations are prose references, not an instruction to Read. Unlike `scope-research.md`, this file has no on-demand-Read route from its agent, so an edit here reaches the curator only through whoever follows the pointer.

## What the cut removed, and why

- **The `> **Loading**: … auto-loads` stanza, `> **Inherits**`, the `> **See**` matrix link, and `Rules specific to WIKI agents: …`** — a selector that does not exist, plus corpus bookkeeping addressed to an editor.
- **The `> **Wiki store (canonical)**` blockquote** — Tier-1 `rules/glass-atrium/core-wiki-reference.md` opens with the same blockquote near-verbatim, and that file does arrive. The curator body states the same store description again in its own opening.
- **`Sole writer of \`wiki/\``** — Tier-1 `core-wiki-reference.md` → `## Wiki Write Operations` states the rule and the identical researcher carve-out, and the curator body restates the ownership half under `## OWNS / DOES NOT OWN`.
  - It also binds OTHER agents, so for the receiving curator it was informational rather than a duty it could discharge.
- **The immutability half of `raw/ is immutable`** — curator body `## Guardrails (Absolute)`: `**raw/ immutable**: Write/Edit/rm/mv forbidden under wiki/raw/**. Read only.`
  - The clauded-docs half survived: it is stated nowhere else, and it is not derivable from the tool scope, since the body's Bash allowlist does permit `mv ~/.Trash/`.
- **The healthcheck-carrying clause of `Staleness surface`** — the curator body's own health-check bullet states that duty and points here for the threshold and the surface, which is what the bullet now holds and nothing more.

## Concurrent-write guard — DROPPED, not repaired

The bullet ordered the curator to check `~/.claude/data/wiki-lock` for existence, return `result: blocked` if present without waiting, and remove the lock atomically on completion. It was dropped rather than corrected:

- **The path does not exist anywhere.** `data/wiki-lock` occurs once tree-wide — in that line. Injected or followed, the guard polls a file nothing ever creates, so it silently always passes.
- **The real mechanism is `scripts/wiki-lock.sh`**: `readonly LOCK_ROOT="/tmp"`, lock dir `/tmp/wiki-lock-<name>.lock`, acquired by atomic `mkdir` with pid liveness and stale reaping.
- **Both of the bullet's other clauses were wrong about that mechanism too.**
  - `acquire <name> [timeout_sec]` WAITS and exits 2 on timeout — the opposite of `do NOT wait/spin`.
  - The sanctioned `wiki-lock.sh with <name> <timeout> -- <command>` wrapper releases its own token, so `remove the lock atomically` ordered a manual removal of something the agent does not own.
- **The correct mechanism is already delivered, in four places in `agents/glass-atrium-wiki-curator.md`**: the mandatory turn-0 acquire, the Guardrails lock pre-check, the all-writes-via-wiki-lock rule, and the extended-timeout reindex pattern — each using the 30-second waiting form. Restating any of it here would have made a fifth copy of a rule the agent already reads correctly.

## Index regeneration obligation — DROPPED as superseded

The bullet read: any structural change under `wiki/` regenerates the master index in the SAME session, atomically, and `Partial-index session termination is FORBIDDEN`.

- The curator body sanctions exactly that termination, with a named exception and a graded outcome, at `## Guardrails (Absolute)` → Index post-check.
  - All compiled notes register before session end; unregistered notes grade `result: done_with_concerns`.
  - Batch-compile invocations (`-p` / `wiki-daily-compile.sh`) may complete without agent-side index edits, because `wiki-sync.sh` regenerates the master index downstream.
- So a legitimate batch run ends with a partial index, which this line called FORBIDDEN while the body graded it a completed-with-concerns outcome. Carrying the exception here would have duplicated a body rule that is already the stronger and the delivered copy; the line was dropped as superseded instead.
- The registration duty itself survives in the body in three forms (turn-0 sequence step 3, the Index post-check, and `Termination without master-index registration` in its prohibitions), so nothing was lost with it.

## `raw/` frontmatter validation — kept, with its live scope named

The curator body carries this duty in a stronger form (it adds the extra-fields strip) and cites this section by name while doing so, so the bullet stays as the anchor that citation resolves into. What this file adds and the body does not: the note that `hooks/validate-pre-write-raw.sh` V6 blocks a non-conforming raw write at creation time, which makes the failure state unreachable for new files and confines the duty to legacy / pre-contract ones.

## Readers and coupled tests

- No test reads this file's TEXT. The path is carried in `agent-registry.json` and `scripts/agent_lifecycle/registry_ops.py`, and `rules/glass-atrium/core-compliance-matrix.md` writes it in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the file stops existing.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` excerpts the file by basename for the daemon verify prompt; its C3 axis fails the verdict on an empty scope file.
