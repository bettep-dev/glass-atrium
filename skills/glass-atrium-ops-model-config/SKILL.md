---
name: glass-atrium-ops-model-config
description: Close the monitor "Models & budgets" Save→apply gap. Reads GET /api/model-config, finds model/budget drift, and applies only the two surfaces the monitor cannot auto-write — the orchestrator model in ~/.claude/settings.json (Harness Path Protection) and the autoagent/wiki daemon models in their tmux REPL (needs restart). Reports next-spawn/next-cycle domains that auto-apply. Use when the user pressed Save on the Models & budgets screen and the main session or daemon model did not change, asks to apply model config / reconcile model drift / make the saved model take effect, or types /glass-atrium-ops-model-config. Do NOT use for editing the monitor screen, the daemon-config.json budget caps (those auto-apply next cycle), or dev/research agent frontmatter (auto-applies next spawn).
disable-model-invocation: true
---

# Glass Atrium Config

Closes the gap between what the monitor's "Models & budgets" screen SAVES (desired model/budget state in its DB) and what is actually IN EFFECT. The monitor write-throughs the surfaces it owns, but two surfaces are out of its reach by design — this skill applies exactly those two, safely and idempotently, from the interactive main session.

## When to Use

- User pressed **Save** on the Models & budgets screen, but the **main session model** did not change
- User changed the **autoagent / wiki daemon** model and it has not taken effect
- User asks to "apply model config", "reconcile model drift", "make the saved model take effect"
- User types `/glass-atrium-ops-model-config`
- **Exclusions**: budget cap changes (auto-apply next cycle), dev/research frontmatter (auto-apply next spawn), editing the monitor UI itself

## The Gap (why this skill exists)

The monitor records DESIRED config in its DB and write-throughs `daemon-config.json` + agent frontmatter. It **cannot** auto-apply two cases:

- **(a) orchestrator model** lives in `~/.claude/settings.json`, which the monitor never writes (Harness Path Protection), and the running session reads it only at start.
- **(b) autoagent / wiki daemon models** live in long-lived tmux REPL sessions (`claude-autoagent-daemon`, `claude-wiki-daemon`) that need a restart to pick up a new model.

The **next-spawn** (dev/research frontmatter) and **next-cycle** (budget caps, `daemon_cycle_haiku`) domains already auto-apply and need NO action — this skill only reports them.

## Per-`apply_mode` Action Table

Every domain in the GET response carries an `apply_mode`. This table is the authority for what the skill does per mode (verified against `model-config-consts.ts` + the live GET contract):

| apply_mode | Domains | Skill action |
|------------|---------|--------------|
| `next-spawn` | `model.dev`, `model.research` | **No-op + report** — monitor already wrote frontmatter; takes effect on the agent's next spawn |
| `next-cycle` | `model.daemon_cycle_haiku`, `budget.haiku_max_usd`, `budget.pre_verify_max_usd` | **No-op + report** — monitor already wrote `daemon-config.json`; takes effect on the next daemon cycle |
| `tmux-restart` | `model.autoagent_daemon`, `model.wiki_daemon` | **APPLY** — restart the drifted daemon via `daemon-daily-restart.sh {autoagent\|wiki}` |
| `session-restart-manual` | `model.orchestrator` | **APPLY (confirm-gated)** — merge desired `model` + `effortLevel` into `~/.claude/settings.json`, then tell the user to restart the session |
| `immediate` | (none currently) | **No-op + report** — takes effect on the very next call |

Apply only on `drift: true`. A domain in sync needs no action regardless of mode.

## Core Process

1. **Plan (always first, read-only)** — run the helper in plan mode and show the user the per-domain plan:
   ```
   ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --plan
   ```
   This GETs `/api/model-config`, prints each domain's drift state + apply_mode + the action, and writes nothing. The GET endpoint never returns secrets (the route serializes only `model` + `effortLevel` from settings.json — never the env block).

2. **Orchestrator drift (`session-restart-manual`)** — only if `model.orchestrator` shows `drift: true`:
   - **CONFIRM with the user first** — this writes a protected harness file (`~/.claude/settings.json`). State the file path and the exact change (model id + effort) and wait for explicit approval.
   - On approval, run:
     ```
     ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --apply-settings
     ```
   - The write is a key-scoped JSON merge: only `model` (lowercase, what the route reads) and `effortLevel` (camelCase) change; every other key is preserved. It is atomic (temp file + `os.replace`) and idempotent (already-equal → no write).
   - **Tell the user to restart this Claude Code session** — the running session reads model/effort only at start.

3. **Daemon drift (`tmux-restart`)** — for each of `model.autoagent_daemon` / `model.wiki_daemon` showing `drift: true`:
   ```
   ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --restart autoagent
   ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --restart wiki
   ```
   This reuses the canonical `daemon-daily-restart.sh` entry point (same mechanism the daily launchd job uses — quota gate + concurrency lock + bootstrap + pane verify). It targets only the `claude-autoagent-daemon` / `claude-wiki-daemon` sessions.

4. **Auto-applied domains (`next-spawn` / `next-cycle`)** — report only: state that the monitor already applied them and when they take effect (next spawn / next cycle). No action.

5. **Re-verify** — re-run `--plan` and confirm the previously drifted domains the skill could apply now read `in sync` (orchestrator stays drift-until-session-restart by design — call that out).

## Edge Cases

- **Monitor down** — `--plan` exits with "is the monitor running on 127.0.0.1:16145?". Surface it; do not attempt any write.
- **settings.json has no `model` key** (current real state) — the merge ADDS the key (route reads `parsed.model`); other keys untouched. This is the common first-apply case.
- **Already in sync** — `--apply-settings` detects model+effort already equal and writes nothing (idempotent no-op).
- **No drift anywhere** — `--plan` reports "No drift this skill must close"; stop.
- **Daemon session not running** — `daemon-daily-restart.sh` handles a missing session (skips kill, bootstraps fresh); it also self-skips on a quota wall.
- **effort_level empty/absent** — only `model` is merged; `effortLevel` is left as-is.

## Safety Invariants

- **Never reads/echoes/greps/logs secrets** — no secret is ever read-for-output, echoed, grepped, or logged; the env block is written back verbatim to settings.json (the merge `json.load()`s the whole file and `json.dump()`s it back, so the env block round-trips to its own protected file — no leak). Only `model` + `effortLevel` are mutated.
- **Confirm before writing settings.json** — protected harness path; explicit user approval required (Harness Path Protection Rule 1).
- **Idempotent** — re-running with no drift is a clean no-op.
- **Atomic** — settings.json write is temp-file + `os.replace`; never a partial file.
- **Parameterized + BSD-portable** — paths via env override; `python3` for JSON, no GNU-only flags.

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "I'll just edit settings.json directly without confirming" | settings.json is a protected harness file — the user must see and approve the change in the foreground (Harness Path Protection). |
| "I'll `sed` the model line into settings.json" | A line-edit risks corrupting JSON and cannot preserve key order/structure safely. Use the key-scoped JSON merge. |
| "Any tmux daemon restart is close enough" | Model drift on `claude-autoagent-daemon` / `claude-wiki-daemon` closes only via `daemon-daily-restart.sh` for that exact session. A different session leaves the drift open. |
| "next-spawn/next-cycle domains need applying too" | The monitor already wrote those surfaces. Re-applying does nothing; just report when they take effect. |
| "Skip re-verify, the write succeeded" | Orchestrator drift stays until session restart by design — re-verify so the user knows what is and isn't yet live. |

## Red Flags

- About to write `~/.claude/settings.json` without explicit user confirmation
- Using `sed`/`echo` to edit settings.json instead of the JSON merge
- Restarting a session other than `claude-autoagent-daemon` / `claude-wiki-daemon` when the drift is on one of those daemons
- Reading or printing the settings.json `env` block (secrets)
- Applying a domain that shows `drift: false`

## Verification

- [ ] `--plan` ran first and the user saw the per-domain plan
- [ ] settings.json write happened only after explicit user confirmation
- [ ] settings.json still valid JSON with all non-model keys intact (env block untouched)
- [ ] Daemon restart used `daemon-daily-restart.sh` against the `claude-autoagent-daemon` / `claude-wiki-daemon` session
- [ ] Re-run `--plan` shows the applied daemon domains `in sync`; orchestrator flagged as pending session restart
- [ ] No secret value was read, echoed, or logged
