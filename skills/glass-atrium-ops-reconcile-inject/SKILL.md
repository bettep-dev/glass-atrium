---
name: glass-atrium-ops-reconcile-inject
description: Reconcile the tracked roster arrays with the DEV roster by running the agent_lifecycle sync-inject CLI — BUDGET_DEV_AGENTS in hooks/inject-scope-rules.sh and STYLEREF_AGENTS in hooks/lib/styleref-roster.sh — inserting every newly registered DEV agent and removing every deleted agent's stale name; the manual-curated rosters BUDGET_ANALYSIS_AGENTS and WIKI_UNTRUSTED_AGENTS are never written. Use when you just registered OR deleted a DEV agent, when an agent-delete result names this skill in skill_to_run or the add CLI prints a NOTE naming it, when finishing integrating or removing an agent, when asked to sync the roster arrays, when a registered DEV agent gets no BUDGET-DEV sizing block or its style_ref omission flag never fires, or via the /glass-atrium-ops-reconcile-inject slash command. Do NOT use for architecture-diagram drift (use glass-atrium-ops-verify-arch), model/budget config, or an agent whose scope-RULE membership looks wrong (a registry or selector problem).
---

# Reconcile the tracked roster arrays

Reconcile the tracked roster arrays with the live DEV roster through the tested `agent_lifecycle sync-inject` CLI: one transactional command inserts every missing roster member and removes every stale name, serving both the add and the delete lifecycle.

## When to Use

- You just registered a DEV agent through the monitor add-agent flow and need to finish integrating it (insert path).
- You just deleted a DEV agent through the monitor delete flow and need to drop its stale name from the arrays (remove path).
- The add CLI printed its NOTE naming `glass-atrium-ops-reconcile-inject`, or an agent-delete commit result carries `skill_to_run` naming it.
- You are asked to "finish integrating the new agent", "remove the deleted agent's array entries", or "sync the roster arrays".
- A registered DEV agent receives no BUDGET-DEV sizing block, or its `style_ref` omission `review_flag` never fires.
- The `/glass-atrium-ops-reconcile-inject` slash command was invoked.

### Exclusions

- Architecture-diagram drift / the `최신화 필요` badge → `glass-atrium-ops-verify-arch`; this skill does NOT chain it (see Prohibitions).
- Model / token-budget configuration → the monitor Models & budgets screen.
- An agent whose scope-RULE membership looks wrong → NOT this skill; start with `python3 -m agent_lifecycle orphan-scan --mode rules-membership-mismatch` (why: `## The gap this closes` → **Not the scope-RULE gap.**).

## The gap this closes

- **Not the scope-RULE gap.** `build_entry` records per-agent rule membership on the `agent-registry.json` row (`rules.scope` / `.shared` / `.conditional`) at ADD time, and the part slots deliver those rule files from it.
  - No reconcile run is involved, so running this CLI for a wrong-looking rule membership would report already-in-sync and prove nothing.
- **STYLEREF_AGENTS** — the whole DEV roster, declared in `hooks/lib/styleref-roster.sh`, the declaration-only lib `hooks/lib/style-ref-consts.sh` sources.
  - It is the `style_ref` `review_flag` predicate roster, not an injection roster: a DEV agent missing here never has its `style_ref` omission flagged.
- **BUDGET_DEV_AGENTS** — declared in `hooks/inject-scope-rules.sh`; each member receives the BUDGET-DEV sizing block (source `scoped/shared-turn-budget.md`).
  - Membership is the DEV roster minus `_BUDGET_DAEMON_CARRIERS` {glass-atrium-dev-nestjs, glass-atrium-dev-python, glass-atrium-dev-react, glass-atrium-dev-shell}; that constant changes only by manual governance.
  - Why the four carriers are excluded: each keeps a daemon-evolved in-body budget bullet the daemon owns (the daemon rewrites agent bodies, never hook sources), so injecting the block too would double-deliver.
- **Untracked rosters** — `BUDGET_ANALYSIS_AGENTS` and `WIKI_UNTRUSTED_AGENTS` are governance memberships that are not roster-derivable, so a predicate would be a second copy of the array rather than a check on it. Every run leaves them byte-identical.
- **Drift in both directions** — a newly registered DEV agent is absent from the arrays until reconciled; a deleted agent's name lingers in the arrays that carried it after the delete prunes its scope-dev.md roster entry.

## Core Process

### Step 1 — Run the reconcile CLI

- Invoke the `agent_lifecycle` package as a module from the `scripts/` directory. Normal operator use takes no flags:

```bash
cd ~/.glass-atrium/scripts && python3 -m agent_lifecycle sync-inject
```

- The package resolves the GA root internally and writes each tracked array in its own declaration file: `BUDGET_DEV_AGENTS` in `hooks/inject-scope-rules.sh`, `STYLEREF_AGENTS` in `hooks/lib/styleref-roster.sh`. Only a file whose array needs a change is written.
- **Argument ordering (only for a test run against a disposable temp copy of the tree)**: `--ga-root` is a global flag and MUST precede the subcommand — `python3 -m agent_lifecycle --ga-root DIR sync-inject`, never `sync-inject --ga-root DIR`, which fails as a usage error (exit 2).

### Step 2 — Read what it reports

- **Already in sync** — prints `sync-inject: already in sync (no names inserted or removed).` and exits 0.
  - This is the idempotent no-op: both declaration files stay byte-identical with mtime unchanged, and no `.bak` is written.
- **Names reconciled** — prints each name inserted and/or removed under its array (`[STYLEREF_AGENTS]` / `[BUDGET_DEV_AGENTS]`) and a `backup:` line; inserts and removes land together in one transaction.
  - A `.bak` is written beside each file the run changes, but only the first is printed: when both files changed, the printed path is the hook's, and a second `.bak` sits beside `hooks/lib/styleref-roster.sh`.
- A stderr `WARNING: agent roster drift` after exit 0 does not fail the reconcile: it flags the Scope Legend row in `core-compliance-matrix.md`, a manual doc update a freshly added agent always lacks.

### Step 3 — Report the outcome + exit code

- Relay to the user the inserted and removed names (or "already in sync"), every `.bak` path, and the exit code.
- Exit-code contract, owned by `cli.py`:

| Exit | Meaning |
|---|---|
| `0` | success — names reconciled, or already in sync |
| `2` | usage error — nothing ran (e.g. `--ga-root` placed after `sync-inject`) |
| `4` | halted before any write — a precondition was not met (e.g. a store could not be read) |
| `5` | transaction failed mid-write — every touched file was restored to its pre-run text |
| `6` | the restore itself failed — a touched file may be partial; escalate: compare each `.bak` with its live file |

## Idempotency

- Membership is checked by `split()` + token equality, not substring, so `glass-atrium-dev-rag` and a hypothetical `dev-rag-x` are distinct and a present name is never duplicated.
- Both directions are idempotent: inserting a name already present and removing a name already absent are no-ops, so running the skill repeatedly is safe.

## Output Format

```
RECONCILE-INJECT: [RECONCILED | ALREADY-SYNCED | FAILED]

Command: cd ~/.glass-atrium/scripts && python3 -m agent_lifecycle sync-inject
Exit code: <0|2|4|5|6>
Inserted:
  <agent-name> -> STYLEREF_AGENTS, BUDGET_DEV_AGENTS   # per actual membership (BUDGET_DEV excludes the four daemon carriers); "(none)" if no inserts
Removed:
  <agent-name> -> STYLEREF_AGENTS, BUDGET_DEV_AGENTS   # stale name of a deleted agent; "(none)" if no removes
Backup: <each .bak path>                                              # omit if no write occurred
```

## Prohibitions

- **No in-session array edit** — never edit `hooks/inject-scope-rules.sh` or `hooks/lib/styleref-roster.sh` via in-session Edit/Write/sed. The only sanctioned mutation path is the CLI subprocess (`.bak` backup + atomic write + rollback).
  - Backing: `hooks/enforce-harness-critical.sh` blocks in-session writes under the live `~/.glass-atrium/hooks/`.
- **DEV agents only** — the tracked arrays populate from the DEV roster; do not attempt to insert an agent outside it.
- **Does NOT chain verify-arch** — this skill is a fast array sync only and MUST NOT trigger `glass-atrium-ops-verify-arch` (the heavy build + launchctl restart).
  - Why: keeping the two skills decoupled avoids `execFile` timeout coupling.

## Red Flags

- A request to edit `inject-scope-rules.sh` or `styleref-roster.sh` directly → route to this CLI, never an in-session edit.
- `--ga-root` placed after `sync-inject` → wrong order, the CLI exits 2; the global flag precedes the subcommand.
- An agent outside the DEV roster offered for insertion → out of scope.
- "The new agent's scope-RULE membership is wrong" offered as the reason to run this → wrong CLI (see Exclusions).
- This skill kicking off an architecture-diagram build/restart → boundary violation; that is verify-arch's job.

## Verification

- [ ] Ran from `cd ~/.glass-atrium/scripts` (the module's package root), not the repo root.
- [ ] Used the no-flag `python3 -m agent_lifecycle sync-inject` for live operator use.
- [ ] Reported the inserted and removed names (or "already in sync"), every `.bak` path, and the exit code.
- [ ] Did not present the run as having fixed an agent's scope-RULE membership — what it fixes is the BUDGET-DEV roster and the `style_ref` flag roster.
- [ ] No in-session edit of either declaration file occurred — mutation happened only inside the CLI subprocess.
- [ ] verify-arch was NOT triggered.
