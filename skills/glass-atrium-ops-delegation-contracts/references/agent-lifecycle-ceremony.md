# In-context agent-lifecycle ceremony — steps, EXTEND path and failure recovery

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### In-Context Agent-Lifecycle Ceremony (CREATE/EXTEND — ceremony SoT)` — the trigger, the standing conditions and the two mandatory human pauses.

## The 6 steps, each building on the previous

Steps 1-2 run on either branch; a "no" at step 2 routes to EXTEND (step 3-alt). Steps 3-5 are the CREATE branch; step 6 is the post-commit gate EXTEND re-enters per `## EXTEND path` below.

1. **Gate dry-run (write-free, before any authoring spend)** — `python -m agent_lifecycle add --dry-run --scope DEV --domains "a,b" --description "…" --gate-q1 <pass|fail> --gate-q2 <pass|fail>`.
   - It runs `evaluate_add_gate` (incl. the Q3 domain-overlap `>= 50%` hard-block via `overlap.py`) + target-absence pre-flight.
   - It prints JSON `{allowed, preflight_clear, reasons, q3_conflicts}`.
   - `allowed:false` → STOP (EXTEND or report gap), no spend.
   - The orchestrator supplies the Q1/Q2 verdicts but never computes `allowed` — the gate is sole authority.
2. **⏸ Create-vs-extend approval (HUMAN PAUSE)** — present the dry-run verdict and a create-vs-extend recommendation; author only on explicit approval to create.
3. **Author body** — delegate: glass-atrium-intel-researcher (domain/capability research) + glass-atrium-meta-prompt-engineer (system prompt per CRISP) → authored body file.
4. **Commit via direct Bash CLI** — `python -m agent_lifecycle add --scope DEV --domains "…" --gate-q1 <v> --gate-q2 <v> --body-file <path>`.
   - It writes the registry entry `~/.glass-atrium/agent-registry.json` and the body `~/.glass-atrium/agents/<name>.md` (`agent_lifecycle/paths.py` `ga_root`), then symlinks the body into the `~/.claude/agents/` farm.
   - Harness Path Protection covers only that symlink-farm write, so the commit is a foreground Bash call in the main session, run only after the user's OK (step 5).
5. **⏸ Foreground-commit approval (HUMAN PAUSE)** — Harness Path Protection Rule 1: the user explicitly OKs the path + change before the commit runs.
   - The commit is a main-session Bash call, not an Agent spawn, so Rule 2's staged lane does not apply; the user watches it run.
6. **Reconcile (MANDATORY post-commit gate)** — run skill `glass-atrium-ops-reconcile-inject` (`python3 -m agent_lifecycle sync-inject`) to fill the tracked roster arrays.
   - The arrays are declared in `scripts/agent_lifecycle/readers.py` → `_TRACKED_INJECT_ARRAYS`: `BUDGET_DEV_AGENTS` in `hooks/inject-scope-rules.sh` and `STYLEREF_AGENTS` in `hooks/lib/styleref-roster.sh`.
   - `sync-inject` fills the arrays; `orphan-scan --mode reconcile` writes nothing — it only lists failed-rollback recovery markers.
   - BUDGET_DEV is DEV minus the daemon-carrier agents holding in-body budget bullets. STYLEREF is the whole DEV roster and gates the `style_ref` `review_flag` predicate, not an injected block.
   - **Every other roster in that hook is manual-curated, and reconcile leaves it untouched** (`BUDGET_ANALYSIS_AGENTS`, `WIKI_UNTRUSTED_AGENTS`): an agent that belongs in one is added by hand, or it silently receives no such block.
     - Curation: `core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)`.
   - The new agent's scope and Tier-3 rules need no reconcile: the part slots deliver them from the registry row step 4 wrote.

## EXTEND path (step 3-alt — the DEFAULT branch)

- `python -m agent_lifecycle extend --add-domain <token>` / `--append-section <file>` — additive, append-only; HALTs on any value mutation.
- EXTEND still ends with the reconcile gate (step 6) when it alters the roster.

## CLI safety the gate owns

- The CLI owns a crash-safe `fcntl.flock` mutation lock (single owner of `run_add`/`run_delete`) and all authored-body safety, fail-closed to `EXIT_HALT`.
- The gate never injects into the body; it only refuses:
  - a body opening on a `---` frontmatter fence;
  - a frontmatter-shaped `name`/`tools`/`scope`/`maxTurns` key on any body or appended-section line;
  - a `> Rules:` header line;
  - a secret-scan hit.

## Failure recovery (exit code → action)

| Exit / case | Meaning | Recovery action |
|-------------|---------|-----------------|
| `0` EXIT_OK | committed (or clean dry-run) | proceed to reconcile (step 6) |
| `2` EXIT_USAGE | argparse usage error | fix the invocation, re-run |
| `4` EXIT_HALT | refused — zero writes (`EXIT_HALT` causes below) | read `reasons`, then act per `EXIT_HALT` causes below |
| `4` lock-contention | a concurrent mutation holds the flock | wait for the holder, then re-run — never retry blindly |
| `5` EXIT_TX_FAILED | a forward step failed, rolled back cleanly (no residue) | inspect `reasons`, re-run from step 4 |
| `6` EXIT_ROLLBACK_FAILED | rollback itself failed — recovery marker written | `EXIT_ROLLBACK_FAILED` recovery below |

- `EXIT_HALT` causes: gate refusal · pre-flight fail · lock held · body-safety refusal.
  - On gate refusal → EXTEND or report the gap.
  - On body-safety HALT → fix the body (wrong scope / secret / self-frontmatter), re-author.
- `EXIT_ROLLBACK_FAILED` recovery: run `orphan-scan --mode reconcile` to list the recovery marker, then complete the described reconciliation manually.
  - The marker is not auto-cleared — never assume a clean tree.
