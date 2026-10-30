# Maintainer note — `scoped/scope-wiki.md`

Maintainer-facing material for that source file, and the record of text cut from it that must not return.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.
- Applied here: both headings carry rules rather than stubs, so the source file takes no pointer back to this note.

## Status in the corpus

- `agents/glass-atrium-wiki-curator.md` cites these names in the source file — keep each verbatim:
  - `## Operational Constraints [WIKI]` — the raw-ingestion frontmatter precondition cites `per scope-wiki Operational Constraints`.
  - the **Staleness surface** lead — the health-check `Stale` bullet cites `scoped/scope-wiki.md (Staleness surface)`.
- `skills/glass-atrium-ops-orchestrator.md` and `scoped/scope-report.md` cite the file by name only.
- The citations are prose references, not an instruction to Read: as the curator's `rules.scope` member, the file reaches a spawned curator whole through the part slots (`hooks/lib/inject_chunk.py`).
- The daily-compile batch reader does not receive it: `scripts/wiki-daily-compile.sh` passes only the curator body as `--system-prompt` to a `claude -p` call, where no SubagentStart fires. A rule both readers need is stated in the body.

## What the cut removed, and why

Do not re-add these to the source file; each duty already lives at the site named.

- **The `> **Loading**` / `> **Inherits**` / `> **See**` stanza and `Rules specific to WIKI agents: …`** — membership lives on the registry row's `rules.scope`.
- **The `> **Wiki store (canonical)**` blockquote** — Tier-1 `rules/glass-atrium/core-wiki-reference.md` opens with it, and the curator body's opening restates it.
- **`Sole writer of \`wiki/\``** — `core-wiki-reference.md` → `## Wiki Write Operations` (rule and researcher carve-out) · curator `## OWNS / DOES NOT OWN` (ownership half).
  - It also binds other agents, so the curator could not discharge it.
- **The immutability half of `raw/ is immutable`** — curator `## Guardrails (Absolute)` → **raw/ immutable**.
  - The clauded-docs half stays in the source: stated nowhere else, and not derivable from tool scope, since the body's Bash allowlist permits `mv ~/.Trash/`.
- **The health-check clause of `Staleness surface`** — the curator's health-check bullet carries that duty; the source keeps only the threshold and the surface.

## Concurrent-write guard — DROPPED, not repaired

- The dropped bullet: check `~/.claude/data/wiki-lock`, return `result: blocked` without waiting if present, remove the lock atomically on completion. Do not restore it:
  - Nothing creates that path, so the guard always passes.
  - The real lock is `scripts/wiki-lock.sh`: `readonly LOCK_ROOT="/tmp"`, lock dir `/tmp/wiki-lock-<name>.lock`, atomic `mkdir`, pid liveness, stale reaping.
  - `acquire <name> [timeout_sec]` waits and exits 2 on timeout — the opposite of `do NOT wait/spin`.
  - The `wiki-lock.sh with <name> <timeout> -- <command>` wrapper releases its own token, so a manual removal targets something the agent does not own.
- The lock duty lives in the curator body: the turn-0 acquire, Guardrails **Lock pre-check**, `### Concurrent Write Safety`, and the extended-timeout reindex pattern.
- **Open lock-protocol defects** — owned by whoever next changes the body's lock protocol:
  - The turn-0 acquire `wiki-lock.sh wiki-compile 30` names no subcommand; the helper answers an unknown subcommand with its usage text and exit 64 [measured: `scripts/wiki-lock.sh` → `usage` and the subcommand `case`].
  - The **Lock pre-check** names the `with` form before the first Write/Edit, but `with` wraps a shell command (`-- <command...>`), which a Write or Edit tool call is not [measured: same file, header Interface].
  - A bare `acquire` records the caller shell (`$PPID`) as holder; whether an agent's Bash tool call keeps that shell alive past the call is [hypothesis], unmeasured.

## Index regeneration obligation — DROPPED as superseded

- The dropped bullet: any structural change under `wiki/` regenerates the master index in the SAME session, atomically; `Partial-index session termination is FORBIDDEN`. Do not restore it:
  - Curator `## Guardrails (Absolute)` → **Index post-check** grades unregistered notes `result: done_with_concerns` and exempts batch-compile runs (`-p` / `wiki-daily-compile.sh`), whose index `wiki-sync.sh` regenerates downstream — so a legitimate batch run ends with a partial index.
  - That exception stays in the body alone, the copy both the spawned curator and the batch reader hold.
- Registration itself survives in the body: turn-0 sequence step 3, **Index post-check**, `### Master Index = Single Source of Truth`, `## Completeness Contract`, and the `Termination without master-index registration` prohibition.
  - The last three each point at **Index post-check** for the batch-run exception.

## `raw/` frontmatter validation — kept, with its live scope named

- The curator body mirrors the rule (`## Workflow` → **Precondition — Frontmatter validation**), because the batch reader holds the body and not this file — a canonical + mirror pair; report drift between them.
- The source bullet stays as the anchor the body's `per scope-wiki Operational Constraints` citation resolves into.
- Only the source carries the live-scope note; the check behind it is `hooks/validate-pre-write-raw.sh` V1.

## Readers and coupled tests

- No test reads the source file's text.
- Path readers: `agent-registry.json` · `scripts/agent_lifecycle/registry_ops.py` · `rules/glass-atrium/core-compliance-matrix.md`.
  - The matrix's Tier 2 table row writes the path in inline code, which `monitor/src/server/architecture/governance-membership.ts` treats as a declared document and reports absent if the source file stops existing.
  - Its Compliance Matrix `scope-wiki.md` row carries the basename in plain text.
- `hooks/lib/inject_chunk.py` packs the whole source file into the curator's part slots at spawn; after an edit, `python3 hooks/lib/inject_chunk.py --audit` should still report `events=none` for the curator.
- `autoagent/daemon_cycle.py` → `_AGENT_SCOPE_MAP` maps the curator to the source file by basename for the daemon verify prompt's C3 axis.
  - A missing source file emits `SCOPE_UNRESOLVED_SIGNAL` (`_scope_file_for_agent`); an empty one emits `SCOPE_EMPTY_SIGNAL` (`_empty_excerpt_directive`).
  - Each warns on stderr and tells the verifier to answer C3: FAIL.
