# Maintainer note — `scoped/scope-wiki.md`

Maintainer-facing material for that source file, and the record of text cut from it.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: the surviving heading carries rules rather than a stub, so the source file takes no pointer back to this note.

## Status in the corpus

- `agents/glass-atrium-wiki-curator.md` cites these names in the source file — keep each verbatim:
  - `## Operational Constraints [WIKI]` — the raw-ingestion frontmatter precondition cites `per scope-wiki Operational Constraints`.
  - the **Staleness surface** lead — the health-check `Stale` bullet cites `scoped/scope-wiki.md (Staleness surface)`.
- `skills/glass-atrium-ops-orchestrator.md` cites the file by name only.
- The citations are prose references, not an instruction to Read: as the curator's `rules.scope` member, the file reaches a spawned curator whole through the part slots (`hooks/lib/inject_chunk.py`).
- The daily-compile batch reader does not receive it: `scripts/wiki-daily-compile.sh` passes only the curator body as `--system-prompt` to a `claude -p` call, where no SubagentStart fires.
  - A rule both readers need is stated in the body.

## What the cut removed, and why

Each duty already lives at the site named.

- **The `> **Loading**` / `> **Inherits**` / `> **See**` stanza, `Rules specific to WIKI agents: …` and `Curation rules for glass-atrium-wiki-curator.`** — membership lives on the registry row's `rules.scope`; the rest is editor bookkeeping.
- **The `> **Wiki store (canonical)**` blockquote** — Tier-1 `rules/glass-atrium/core-wiki-reference.md` opens with it, and the curator body's opening restates it.
- **`Sole writer of \`wiki/\``** — `core-wiki-reference.md` → `## Wiki Write Operations` (rule and researcher carve-out) · curator `## OWNS / DOES NOT OWN` (ownership half).
  - It also binds other agents, so the curator could not discharge it.
- **The immutability half of `raw/ is immutable`** — curator `## Guardrails (Absolute)` → **raw/ immutable**.
- **`## Absolute Rules [WIKI]`, the clauded-docs half** — the curator's **raw/ immutable** already forbids that move; the managed-doc handler holds the rule at `skills/glass-atrium-ops-orchestrator.md` → `## Managed Document Deletion (Direct Handling)`.
- **The health-check and read-only clauses of `Staleness surface`** — the curator's health-check bullet carries the duty and the script's header states it is read-only; the source keeps only the threshold and the surface.

## Concurrent-write guard — DROPPED, not repaired

- The dropped bullet: check `~/.claude/data/wiki-lock`, return `result: blocked` without waiting if present, remove the lock atomically on completion.
- It was dropped rather than corrected:
  - Nothing creates that path, so the guard always passes.
  - The real lock is `scripts/wiki-lock.sh` → its header `Interface`; the dropped bullet's `do NOT wait/spin` and `remove the lock atomically` clauses contradict it.
- The lock duty lives in the curator body: the turn-0 acquire, Guardrails **Lock pre-check**, `### Concurrent Write Safety`, and the extended-timeout reindex pattern.
- **Open lock-protocol defects** — owned by whoever next changes the body's lock protocol:
  - The turn-0 acquire `wiki-lock.sh wiki-compile 30` names no subcommand; the helper answers an unknown subcommand with its usage text and exit 64 [measured: `scripts/wiki-lock.sh` → `usage` and the subcommand `case`].
  - The **Lock pre-check** names the `with` form before the first Write/Edit, but `with` wraps a shell command (`-- <command...>`), which a Write or Edit tool call is not [measured: `scripts/wiki-lock.sh` → header `Interface`].
  - A bare `acquire` records the caller shell (`$PPID`) as holder; whether an agent's Bash tool call keeps that shell alive past the call is [hypothesis], unmeasured.

## Index regeneration obligation — DROPPED as superseded

- The dropped bullet: any structural change under `wiki/` regenerates the master index in the same session, atomically; `Partial-index session termination is FORBIDDEN`.
- It was dropped as superseded:
  - Curator `## Guardrails (Absolute)` → **Index post-check** grades unregistered notes `result: done_with_concerns`.
  - It exempts batch-compile runs (`-p` / `wiki-daily-compile.sh`), whose index `wiki-sync.sh` regenerates downstream — so a legitimate batch run ends with a partial index.
  - That exception stays in the body alone, the copy both the spawned curator and the batch reader hold.
- Registration itself survives in the body: turn-0 sequence step 3, **Index post-check** and `### Master Index = Single Source of Truth`.

## `raw/` frontmatter validation — kept, with its live scope named

- The curator body mirrors the rule (`## Workflow` → **Precondition — Frontmatter validation**), because the batch reader holds the body and not this file — a canonical + mirror pair.
- The source bullet stays as the anchor the body's `per scope-wiki Operational Constraints` citation resolves into.
- Only the source carries the live-scope note; the check behind it is `hooks/validate-pre-write-raw.sh` V1.

## Readers and coupled tests

- No test pins a literal from the source file; corpus scans such as `hooks/test/doc-status-vocabulary-pin.bats` read it for vocabulary only.
- Path readers: `agent-registry.json` · `scripts/agent_lifecycle/registry_ops.py` · `rules/glass-atrium/core-compliance-matrix.md`.
  - The matrix's Tier 2 table row writes the path in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the source file stops existing.
  - Its Compliance Matrix `scope-wiki.md` row carries the basename in plain text.
- After an edit, `python3 hooks/lib/inject_chunk.py --audit` should still report `events=none` for the curator.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` maps the curator to the source file by basename for the daemon verify prompt's C3 axis.
  - A missing source file emits `SCOPE_UNRESOLVED_SIGNAL` (`_scope_file_for_agent`); an empty one emits `SCOPE_EMPTY_SIGNAL` (`_empty_excerpt_directive`).
  - Each warns on stderr and tells the verifier to answer C3: FAIL.

## Curator body — machine readers and placement

- The batch call runs with the tools `Read,Glob,Grep`; a `scripts/wiki-daily-compile.sh` comment names `## Untrusted Raw Content [LLM01]`, so that heading keeps its name.
- That section mirrors `rules/glass-atrium/core-wiki-reference.md` → Wiki Raw-Store Untrusted-Data Contract, the canonical wording: the batch reader holds no rule file, so the mirror stays.
- It sits outside every EDITABLE region and adds no marker pair:
  - `autoagent/lib/editable_merge.py` routes a region-count mismatch to the manual structural-change ceremony.
  - Text outside the regions takes the release copy; a region the release leaves untouched keeps the local content.
- Not re-added, because the reader cannot reach them or the harness already enforces them:
  - A `[CONTINUITY]` guardrail: `hooks/inject-session-context.sh` emits that header at SessionStart, which a spawned subagent and the batch call do not receive.
  - A compiler-skill-loaded check: a spawn preloads it through frontmatter `skills:`; the batch call passes the file as plain text, so a halt-on-missing check would stop it.
  - A WebFetch/WebSearch ban: frontmatter `tools:` and the batch `--tools` both omit them.
