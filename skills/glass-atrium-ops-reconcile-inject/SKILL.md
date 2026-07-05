---
name: glass-atrium-ops-reconcile-inject
description: Bidirectionally reconcile the four inject-scope-rules.sh bash arrays (INJECT_AGENTS, STYLEREF_AGENTS, MINIMALISM_AGENTS, NAMING_AGENTS) with the DEV/QA roster — INSERTING every newly registered agent missing from an array AND REMOVING every stale name of a deleted agent — so each array matches the live roster and a new agent loads its scope-rule injection blocks. Runs the tested agent_lifecycle sync-inject CLI subcommand (transactional, .bak backup, atomic write, rollback), never an in-session hook edit. Use when you just registered OR deleted a DEV agent from the monitor flow, when the add-result or delete-result card shows the "skill-execution request" badge naming this skill, when finishing integrating or removing an agent, when asked to sync inject-scope-rules.sh, when a newly added agent loads no scope rules, or via the /glass-atrium-ops-reconcile-inject slash command. Do NOT use for architecture-diagram drift (use glass-atrium-ops-verify-arch), model/budget config, or non-DEV/QA agents.
---

# Reconcile inject-scope-rules.sh arrays

Reconcile the four `inject-scope-rules.sh` bash arrays with the live DEV/QA roster by idempotently INSERTING every missing roster member AND REMOVING every stale name (a deleted agent), via the tested `agent_lifecycle sync-inject` CLI. This replaces the old manual "hand-edit the bash arrays" TODO with one executable, transactional command that serves both the add and the delete lifecycle.

## When to Use

- You just registered a DEV (or QA) agent through the monitor add-agent flow and need to finish integrating it (insert path).
- You just deleted a DEV agent through the monitor delete flow and need to drop its stale name from the arrays (remove path).
- The add-result OR delete-result card shows the Pill **"skill-execution request"** badge naming `glass-atrium-ops-reconcile-inject`.
- You are asked to "finish integrating the new agent", "remove the deleted agent's array entries", "sync inject-scope-rules.sh", or you observe that a newly added agent loads no scope rules.
- The `/glass-atrium-ops-reconcile-inject` slash command was invoked.

**Exclusions**:
- Architecture-diagram drift / the `최신화 필요` badge → `glass-atrium-ops-verify-arch` (this skill does NOT chain it — see Prohibitions).
- Model / token-budget configuration → `glass-atrium-ops-model-config`.
- Non-DEV / non-QA agents → out of scope; only DEV agents (and the two QA agents) populate these injection arrays.

## The gap this closes

`~/.glass-atrium/hooks/inject-scope-rules.sh` holds four readonly arrays that drive scope-rule injection at SubagentStart:

- **INJECT_AGENTS** — DEV (12) + QA (2): receives the comment-logging core block.
- **STYLEREF_AGENTS** — DEV (12): receives the STYLE-REF block.
- **MINIMALISM_AGENTS** — DEV (12): receives the MINIMALISM block.
- **NAMING_AGENTS** — DEV minus glass-atrium-dev-swift (11) + glass-atrium-qa-code-reviewer (1) = 12: receives the naming delta-core block. Roster is deliberately narrower than the others — excludes glass-atrium-dev-swift AND glass-atrium-qa-debugger. Under the HYBRID fix this array is now auto-reconciled by the CLI alongside the other three.

A newly registered DEV/QA agent is in the registry + scope-dev roster but absent from these arrays until reconciled, so it silently loads NO injection blocks. Symmetrically, a deleted DEV agent's name lingers in the arrays after the delete prunes its scope-dev.md roster entry, leaving a dangling injection target. Previously the operator was told to hand-edit the arrays (a prose TODO). That manual step is now executable: this skill runs the CLI that detects BOTH the missing names (insert) and the stale names (remove) and writes the fix transactionally in one pass.

## Core Process

The array WRITE happens ONLY inside the CLI subprocess — never via an in-session Edit/sed of the live hook (`~/.glass-atrium/hooks/` is harness-protected; in-session writes are blocked and forbidden).

### Step 1 — Run the reconcile CLI

The `agent_lifecycle` package is invoked as a module from the `scripts/` directory. The canonical normal-use invocation takes no flags:

```bash
cd ~/.glass-atrium/scripts && python3 -m agent_lifecycle sync-inject
```

The package resolves the GA root internally and writes to the live `inject-scope-rules.sh`.

**Argument ordering (only for an isolated test fixture)**: `--ga-root` is a GLOBAL flag and MUST precede the subcommand — `python3 -m agent_lifecycle --ga-root DIR sync-inject` (NOT `sync-inject --ga-root DIR`, which errors). `--ga-root` targets a disposable temp copy of the tree and is for tests only; normal operator use omits it.

### Step 2 — Read what it reports

- **Already in sync** — prints `sync-inject: already in sync (no names inserted or removed).` and exits 0. This is the idempotent no-op: re-running on a clean tree (nothing to insert AND nothing to remove) leaves the array file byte-identical with mtime unchanged and NO `.bak` written. Safe to run any number of times.
- **Names reconciled** — reports each agent name inserted and/or removed and the per-scope array it touched (INJECT / STYLEREF / MINIMALISM / NAMING), plus the `.bak` backup path created before the write. Inserts (a newly added agent) and removes (a deleted agent's stale name) are applied together in one transaction.

### Step 3 — Report the outcome + exit code

Relay to the user: the inserted names (or "already in sync"), the `.bak` backup path, and the exit code. Exit-code contract (owned by `cli.py`):

- `0` — success (names inserted, or already in sync).
- `5` — transaction failed mid-write; the array file was restored from `.bak`.
- `6` — rollback itself failed (escalate: inspect the `.bak` and the live file).
- `4` — halted before write (a precondition was not met).

A non-zero exit means the live hook was NOT left in a partial state — the `.bak` rollback restores it. `~/.glass-atrium/hooks/` is also git-tracked, so an independent `git restore` is available as a second recovery path.

## Idempotency

Membership is checked by `split()` + token equality (not substring), so `glass-atrium-dev-rag` and a hypothetical `dev-rag-x` are distinct and a present name is never duplicated. Both directions are idempotent: inserting a name already present is a no-op, and removing a name already absent is a no-op. Running the skill repeatedly is safe: an already-synced tree (nothing to insert AND nothing to remove) is a no-op with no content change.

## Output Format

```
RECONCILE-INJECT: [RECONCILED | ALREADY-SYNCED | FAILED]

Command: cd ~/.glass-atrium/scripts && python3 -m agent_lifecycle sync-inject
Exit code: <0|4|5|6>
Inserted:
  <agent-name> -> INJECT_AGENTS, STYLEREF_AGENTS, MINIMALISM_AGENTS, NAMING_AGENTS   # per actual scope (NAMING excludes glass-atrium-dev-swift + glass-atrium-qa-debugger); "(none)" if no inserts
Removed:
  <agent-name> -> INJECT_AGENTS, STYLEREF_AGENTS, MINIMALISM_AGENTS, NAMING_AGENTS   # stale name of a deleted agent; "(none)" if no removes
Backup: <path to .bak>                                                # omit if no write occurred
```

## Prohibitions

- **No in-session array edit** — never edit `inject-scope-rules.sh` via in-session Edit/Write/sed. The only sanctioned mutation path is the CLI subprocess (`.bak` backup + atomic write + rollback). Harness Path Protection blocks and forbids the direct edit.
- **DEV/QA agents only** — these arrays populate from the DEV (12) + QA (2) roster. Non-DEV/non-QA agents are not array members; do not attempt to inject them.
- **Does NOT chain verify-arch** — this skill is a fast array-sync only. It MUST NOT trigger `glass-atrium-ops-verify-arch` (the heavy build + launchctl restart). Architecture-diagram reconciliation is a separate, decoupled skill/badge — keeping them separate avoids `execFile` timeout coupling.

## Red Flags

- A request to edit `inject-scope-rules.sh` directly → route to this CLI, never an in-session edit.
- `--ga-root` placed after `sync-inject` → wrong order, the CLI errors; the global flag precedes the subcommand (and is for tests only).
- A non-DEV/non-QA agent named for injection → out of scope.
- This skill kicking off an architecture-diagram build/restart → boundary violation; that is verify-arch's job.

## Verification

- [ ] Ran from `cd ~/.glass-atrium/scripts` (the module's package root), not the repo root.
- [ ] Used the no-flag `python3 -m agent_lifecycle sync-inject` for live operator use (`--ga-root` reserved for disposable test fixtures, placed before the subcommand).
- [ ] Reported inserted names (or "already in sync"), the `.bak` backup path, and the exit code.
- [ ] No in-session edit of `inject-scope-rules.sh` occurred — mutation happened only inside the CLI subprocess.
- [ ] verify-arch was NOT triggered.
