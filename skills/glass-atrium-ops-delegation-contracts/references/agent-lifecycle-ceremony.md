# In-context agent-lifecycle ceremony — steps, EXTEND path and failure recovery

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `### In-Context Agent-Lifecycle Ceremony (CREATE/EXTEND — ceremony SoT)` — the trigger, the standing conditions and the two mandatory human pauses.
- **Working directory**: run every `python3 -m agent_lifecycle` command from `~/.glass-atrium/scripts` — the package resolves only from that cwd.

## The 6 steps, each building on the previous

- Steps 1-2 run on either branch; a "no" at step 2 routes to EXTEND (step 3-alt).
- Steps 3-6 are the CREATE branch.

1. **Gate dry-run (write-free, before any authoring spend)** — `python3 -m agent_lifecycle add <name> --dry-run --scope DEV --origin user --domains "a,b" --gate-q1 <pass|fail> --gate-q2 <pass|fail>`.
   - It runs `evaluate_add_gate` (incl. the Q3 domain-overlap hard-block, `overlap.py` → `OVERLAP_THRESHOLD`) + target-absence pre-flight.
   - It prints JSON `{allowed, preflight_clear, reasons, q3_conflicts}`.
   - `allowed:false` → stop (EXTEND or report gap).
   - The orchestrator supplies the Q1/Q2 verdicts but never computes `allowed` — the gate is sole authority.
2. **Create-vs-extend approval (HUMAN PAUSE)** — present the dry-run verdict and a create-vs-extend recommendation; author only on explicit approval to create.
3. **Author body** — delegate: glass-atrium-intel-researcher (domain/capability research) + glass-atrium-meta-prompt-engineer (system prompt per CRISP) → authored body file.
4. **Foreground-commit approval (HUMAN PAUSE)** — Harness Path Protection Rule 1: the user explicitly OKs the path + change before the commit runs.
   - Rule 2's staged lane does not apply: the commit is a main-session foreground Bash call, not an Agent spawn, and the user watches it run.
5. **Commit via direct Bash CLI** — `python3 -m agent_lifecycle add <name> --scope DEV --origin user --domains "…" --gate-q1 <v> --gate-q2 <v> --body-file <path>`.
   - It writes the registry entry `~/.glass-atrium/agent-registry.json` and the body `~/.glass-atrium/agents/<name>.md`, then symlinks the body into the `~/.claude/agents/` farm — the only write Harness Path Protection covers.
6. **Reconcile (MANDATORY post-commit gate)** — run skill `glass-atrium-ops-reconcile-inject` (`python3 -m agent_lifecycle sync-inject`) to fill the tracked roster arrays.
   - `orphan-scan --mode reconcile` is not this step: it writes nothing and only lists failed-rollback recovery markers.
   - **Reconcile leaves the manual-curated rosters untouched** (`BUDGET_ANALYSIS_AGENTS`, `WIKI_UNTRUSTED_AGENTS`): an agent that belongs in one is added by hand, or it silently receives no such block.
     - Curation: `core-compliance-matrix.md` → `### Injected Blocks (SubagentStart allowlist)`.

## EXTEND path (step 3-alt — the DEFAULT branch)

- `python3 -m agent_lifecycle extend <name> --add-domain <token>` / `--append-section <file>` — additive, append-only; HALTs on any value mutation.
- It writes only the registry `domains` and the body, so no roster changes and step 6 does not run.

## CLI safety the gate owns

- The CLI owns the mutation lock and all authored-body safety, fail-closed to `EXIT_HALT`.
- The gate never injects into the body; it only refuses:
  - a body opening on a `---` frontmatter fence;
  - a frontmatter-shaped `name`/`tools`/`scope`/`maxTurns` key on any body or appended-section line;
  - a `> Rules:` header line;
  - a secret-scan hit.

## Failure recovery (exit code → action)

| Exit / case | Meaning | Recovery action |
|-------------|---------|-----------------|
| `0` EXIT_OK | committed, or a clean dry-run | after `add`, reconcile (step 6); after a dry-run, read `allowed` |
| `2` EXIT_USAGE | argparse usage error | fix the invocation, re-run |
| `4` EXIT_HALT, gate refusal | refused — zero writes | EXTEND or report the gap |
| `4` EXIT_HALT, body-safety refusal | refused — zero writes | fix the body per `## CLI safety the gate owns`, re-author |
| `4` EXIT_HALT, lock held | a concurrent mutation holds the lock — zero writes | wait for the holder, then re-run |
| `4` EXIT_HALT, any other pre-flight fail | refused — zero writes | read the stderr `HALT:` line, clear its cause, re-run |
| `5` EXIT_TX_FAILED | a forward step failed, rolled back cleanly (no residue) | read the stderr `FAILED` line, re-run from step 5 |
| `6` EXIT_ROLLBACK_FAILED | rollback itself failed — recovery marker written | `EXIT_ROLLBACK_FAILED` recovery below |

- `EXIT_ROLLBACK_FAILED` recovery: run `orphan-scan --mode reconcile` to list the recovery marker, then complete the described reconciliation manually.
  - The marker is not auto-cleared — never assume a clean tree.
