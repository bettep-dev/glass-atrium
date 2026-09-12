---
name: glass-atrium-ops-reconcile-inject
description: Bidirectionally reconcile the five tracked roster arrays — INJECT_AGENTS, MINIMALISM_AGENTS, NAMING_AGENTS and BUDGET_DEV_AGENTS in hooks/inject-scope-rules.sh plus STYLEREF_AGENTS in hooks/lib/styleref-roster.sh — with the DEV/QA roster, INSERTING every newly registered agent missing from an array AND REMOVING every stale name of a deleted agent, so each array matches the live roster and a new agent receives its injected blocks; the manual-curated governance rosters (BUDGET_ANALYSIS_AGENTS, WIKI_UNTRUSTED_AGENTS, PLAN_GATE_AGENTS) are never written by the CLI. Without it a registered DEV agent receives no comment-logging core, no minimalism reflex, no naming delta-core and no BUDGET-DEV sizing block, and is missing from the style_ref review_flag predicate that hooks/lib/style-ref-consts.sh reads directly. It does NOT decide whether an agent receives its scope RULES — that follows the agent-registry.json `rules` object the ADD already wrote. Runs the tested agent_lifecycle sync-inject CLI subcommand (transactional, .bak backup, atomic write, rollback), never an in-session hook edit. Use when you just registered OR deleted a DEV agent from the monitor flow, when the add-result or delete-result card shows the "skill-execution request" badge naming this skill, when finishing integrating or removing an agent, when asked to sync the roster arrays, when a registered DEV agent gets no injected block or its style_ref omission flag never fires, or via the /glass-atrium-ops-reconcile-inject slash command. Do NOT use for architecture-diagram drift (use glass-atrium-ops-verify-arch), model/budget config, or for an agent whose scope-RULE membership looks wrong — that is a registry or selector problem, not an array one.
---

# Reconcile the tracked roster arrays

Reconcile the five tracked roster arrays with the live DEV/QA roster by idempotently INSERTING every missing roster member AND REMOVING every stale name (a deleted agent), via the tested `agent_lifecycle sync-inject` CLI — one executable, transactional command serving both the add and delete lifecycle.

## When to Use

- You just registered a DEV (or QA) agent through the monitor add-agent flow and need to finish integrating it (insert path).
- You just deleted a DEV agent through the monitor delete flow and need to drop its stale name from the arrays (remove path).
- The add-result OR delete-result card shows the Pill **"skill-execution request"** badge naming `glass-atrium-ops-reconcile-inject`.
- You are asked to "finish integrating the new agent", "remove the deleted agent's array entries", or "sync the roster arrays".
- A registered DEV agent receives no comment-logging core, minimalism reflex, naming delta-core or BUDGET-DEV sizing block, or its `style_ref` omission `review_flag` never fires.
- The `/glass-atrium-ops-reconcile-inject` slash command was invoked.

**Exclusions**:
- Architecture-diagram drift / the `최신화 필요` badge → `glass-atrium-ops-verify-arch` (this skill does NOT chain it — see Prohibitions).
- Model / token-budget configuration → the monitor Models & budgets screen.
- **An agent whose scope-RULE membership looks wrong** → NOT this skill. That membership lives on the agent's `agent-registry.json` row, not in these arrays, so the symptom is a registry or selector problem and running this CLI would waste the diagnosis. Start with `agent_lifecycle orphan-scan --mode rules-membership-mismatch`. (A missing injected BLOCK is the opposite case and IS this skill.)
- Agents outside the DEV roster and the two QA names → out of scope; no tracked array carries another name.

## The gap this closes

**Not the scope-RULE gap.** Per-agent rule membership is recorded on the registry row (`rules.scope` / `.shared` / `.conditional`) by `build_entry` at ADD time, so a lifecycle-created agent's rule membership is complete the moment its row lands — no reconcile run is involved. What an unreconciled array costs is the INJECTED BLOCK it gates, and each is worth naming exactly:

- **INJECT_AGENTS** — the DEV roster plus both QA names: receives the comment-logging core block.
- **STYLEREF_AGENTS** — the DEV roster whole: receives the STYLE-REF block. Declared in `~/.glass-atrium/hooks/lib/styleref-roster.sh`, the declaration-only lib the hook sources and `hooks/lib/style-ref-consts.sh` reads for the `style_ref` `review_flag` predicate — so a DEV agent missing here loses the block AND never has its `style_ref` omission flagged, a detector that silently stops covering one agent. The CLI writes it in that lib, not in the hook.
- **MINIMALISM_AGENTS** — the DEV roster whole: receives the MINIMALISM block.
- **NAMING_AGENTS** — the DEV roster minus glass-atrium-dev-swift, plus glass-atrium-qa-code-reviewer: receives the naming delta-core block. Deliberately narrower than the others — it excludes glass-atrium-dev-swift AND glass-atrium-qa-debugger — and reconciled through its own dedicated predicate rather than the plain roster.
- **BUDGET_DEV_AGENTS** — the DEV roster minus the four daemon-carrier agents {glass-atrium-dev-nestjs, glass-atrium-dev-python, glass-atrium-dev-react, glass-atrium-dev-shell}, which keep daemon-evolved in-body budget bullets the daemon owns (the daemon rewrites agent BODIES, never hook sources), so injecting on top would double-deliver: receives the BUDGET-DEV sizing block (source `scoped/shared-turn-budget.md`). Reconciled through the predicate dev_roster − `_BUDGET_DAEMON_CARRIERS`; the carrier constant changes only by manual governance, like NAMING's exclusions.

The governance rosters — `BUDGET_ANALYSIS_AGENTS`, `WIKI_UNTRUSTED_AGENTS`, `PLAN_GATE_AGENTS` — are UNTRACKED by design: their membership is not roster-derivable, so a predicate would be a second copy of the array rather than a check on it. A reconcile run leaves each byte-identical.

A newly registered agent is in the registry + scope-dev roster but absent from these arrays until reconciled, so it silently receives NONE of the blocks above. Symmetrically, a deleted DEV agent's name lingers in every tracked array after the delete prunes its scope-dev.md roster entry, leaving a dangling injection target. This skill runs the CLI that detects BOTH the missing names (insert) and the stale names (remove) and writes the fix transactionally in one pass.

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
- **Names reconciled** — reports each agent name inserted and/or removed and the per-scope array it touched (INJECT / STYLEREF / MINIMALISM / NAMING / BUDGET_DEV), plus the `.bak` backup path created before the write. Inserts (a newly added agent) and removes (a deleted agent's stale name) are applied together in one transaction.

### Step 3 — Report the outcome + exit code

Relay to the user: the inserted names (or "already in sync"), the `.bak` backup path, and the exit code. Exit-code contract (owned by `cli.py`):

- `0` — success (names inserted, or already in sync).
- `5` — transaction failed mid-write; the array file was restored from `.bak`.
- `6` — rollback itself failed (escalate: inspect the `.bak` and the live file).
- `4` — halted before write (a precondition was not met).

A non-zero exit means the live hook was NOT left in a partial state — the `.bak` rollback restores it. `~/.glass-atrium/hooks/` is also git-tracked, so an independent `git restore` is available as a second recovery path.

## Idempotency

Membership is checked by `split()` + token equality (not substring), so `glass-atrium-dev-rag` and a hypothetical `dev-rag-x` are distinct and a present name is never duplicated. Both directions are idempotent: inserting a name already present is a no-op, and removing a name already absent is a no-op. Running the skill repeatedly is safe: an already-synced tree (nothing to insert AND nothing to remove) is a no-op with no content change. Every untracked array is left byte-identical by every run.

## Output Format

```
RECONCILE-INJECT: [RECONCILED | ALREADY-SYNCED | FAILED]

Command: cd ~/.glass-atrium/scripts && python3 -m agent_lifecycle sync-inject
Exit code: <0|4|5|6>
Inserted:
  <agent-name> -> INJECT_AGENTS, STYLEREF_AGENTS, MINIMALISM_AGENTS, NAMING_AGENTS, BUDGET_DEV_AGENTS   # per actual scope (NAMING excludes glass-atrium-dev-swift + glass-atrium-qa-debugger; BUDGET_DEV excludes the four daemon carriers); "(none)" if no inserts
Removed:
  <agent-name> -> INJECT_AGENTS, STYLEREF_AGENTS, MINIMALISM_AGENTS, NAMING_AGENTS, BUDGET_DEV_AGENTS   # stale name of a deleted agent; "(none)" if no removes
Backup: <path to .bak>                                                # omit if no write occurred
```

## Prohibitions

- **No in-session array edit** — never edit `inject-scope-rules.sh` or `hooks/lib/styleref-roster.sh` via in-session Edit/Write/sed. The only sanctioned mutation path is the CLI subprocess (`.bak` backup + atomic write + rollback). Harness Path Protection blocks and forbids the direct edit.
- **DEV/QA agents only** — the tracked arrays populate from the DEV roster plus the two QA names. An agent outside that set belongs to no tracked array; do not attempt to insert one. (The untracked governance rosters do name analysis agents, but the CLI never writes them — their membership is a manual governance decision, out of this skill's write scope.)
- **Does NOT chain verify-arch** — this skill is a fast array-sync only. It MUST NOT trigger `glass-atrium-ops-verify-arch` (the heavy build + launchctl restart). Architecture-diagram reconciliation is a separate, decoupled skill/badge — keeping them separate avoids `execFile` timeout coupling.

## Red Flags

- A request to edit `inject-scope-rules.sh` directly → route to this CLI, never an in-session edit.
- `--ga-root` placed after `sync-inject` → wrong order, the CLI errors; the global flag precedes the subcommand (and is for tests only).
- An agent outside the DEV roster and the two QA names offered for insertion → out of scope.
- "The new agent's scope-RULE membership is wrong" offered as the reason to run this → wrong CLI; that is registry/selector territory, and running this would report already-in-sync and prove nothing. A missing injected BLOCK is the case this skill does fix.
- This skill kicking off an architecture-diagram build/restart → boundary violation; that is verify-arch's job.

## Verification

- [ ] Ran from `cd ~/.glass-atrium/scripts` (the module's package root), not the repo root.
- [ ] Used the no-flag `python3 -m agent_lifecycle sync-inject` for live operator use (`--ga-root` reserved for disposable test fixtures, placed before the subcommand).
- [ ] Reported inserted names (or "already in sync"), the `.bak` backup path, and the exit code.
- [ ] Did not present the run as having fixed an agent's scope-RULE membership — it cannot, and does not need to; what it fixes is the roster that gates the injected blocks.
- [ ] No in-session edit of `inject-scope-rules.sh` occurred — mutation happened only inside the CLI subprocess.
- [ ] verify-arch was NOT triggered.
