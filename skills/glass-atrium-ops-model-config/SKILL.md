---
name: glass-atrium-ops-model-config
description: Close the monitor "Models & budgets" Save→apply gap. Reads GET /api/model-config, finds model/budget drift, and applies only the two surfaces the monitor cannot auto-write — the orchestrator model in ~/.claude/settings.json (Harness Path Protection) and the autoagent/wiki daemon models in their tmux REPL (needs restart). Reports next-spawn/next-cycle domains that auto-apply. Use when the user pressed Save on the Models & budgets screen and the main session or daemon model did not change, asks to apply model config / reconcile model drift / make the saved model take effect, or types /glass-atrium-ops-model-config. Do NOT use for editing the monitor screen, the daemon-config.json budget caps (those auto-apply next cycle), or dev/research agent frontmatter (auto-applies next spawn).
disable-model-invocation: true
---

# Glass Atrium Config

Closes the gap between what the monitor's "Models & budgets" screen SAVES (desired model/budget state in its DB) and what is actually IN EFFECT. The monitor records the desired config and write-throughs `daemon-config.json` + agent frontmatter itself. Two surfaces are out of its reach by design, and this skill applies exactly those two — safely and idempotently, from the interactive main session:

- **(a) orchestrator model** lives in `~/.claude/settings.json`, which the monitor never writes (Harness Path Protection), and the running session reads it only at start.
- **(b) autoagent / wiki daemon models** live in long-lived tmux REPL sessions (`claude-autoagent-daemon`, `claude-wiki-daemon`) that need a restart to pick up a new model.

## Per-`apply_mode` Action Table

Every domain in the GET response carries its own `apply_mode`, and that field selects the row. This table is the authority for what the skill does per mode:

| apply_mode | Skill action |
|------------|--------------|
| `next-spawn` | **No-op + report** — monitor already wrote frontmatter; takes effect on the agent's next spawn |
| `next-cycle` | **No-op + report** — monitor already wrote `daemon-config.json`; takes effect on the next daemon cycle |
| `tmux-restart` | **APPLY** — restart the drifted daemon via `daemon-daily-restart.sh {autoagent\|wiki}` |
| `session-restart-manual` | **APPLY (confirm-gated)** — merge desired `model` + `effortLevel` into `~/.claude/settings.json`, then tell the user to restart the session |

Apply only on `drift: true`. A domain in sync needs no action regardless of mode.

## Core Process

1. **Plan (always first, read-only)** — run the helper in plan mode and show the user its per-domain output (drift state + `apply_mode` + the action it implies):
   ```
   ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --plan
   ```

2. **Orchestrator drift (`session-restart-manual`)** — only if `model.orchestrator` shows `drift: true`:
   - **CONFIRM with the user first** — this writes a protected harness file (`~/.claude/settings.json`). State the path and the exact change (model id + effort), then wait for explicit approval (Harness Path Protection Rule 1).
   - On approval, run:
     ```
     ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --apply-settings
     ```
   - The write is a key-scoped JSON merge — only `model` (lowercase) and `effortLevel` (camelCase) change, every other key is preserved; atomic (temp file + `os.replace`) and idempotent (already-equal → no write).
   - **Tell the user to restart this Claude Code session** — the running session reads model/effort only at start.

3. **Daemon drift (`tmux-restart`)** — for each of `model.autoagent_daemon` / `model.wiki_daemon` showing `drift: true`:
   ```
   ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --restart autoagent
   ~/.claude/skills/glass-atrium-ops-model-config/apply-model-config.sh --restart wiki
   ```
   This reuses `daemon-daily-restart.sh` — the daily launchd job's own entry point (quota gate + concurrency lock + bootstrap + pane verify) — and targets only the `claude-autoagent-daemon` / `claude-wiki-daemon` sessions.

4. **Auto-applied domains (`next-spawn` / `next-cycle`)** — report only: the monitor already applied them; state when they take effect (next spawn / next cycle).

5. **Re-verify** — re-run `--plan` and confirm the previously drifted domains the skill could apply now read `in sync` (orchestrator stays drift-until-session-restart by design — call that out).

## Edge Cases

- **Monitor down** — `--plan` exits non-zero reporting that the GET failed. Surface that; attempt no write.
- **settings.json has no `model` key** — the merge ADDS the key (the route reads `parsed.model`); other keys untouched. This is the common first-apply case.
- **Already in sync** — `--apply-settings` detects model+effort already equal and writes nothing (idempotent no-op).
- **No drift anywhere** — `--plan` reports "No drift this skill must close"; stop.
- **Daemon session not running** — `daemon-daily-restart.sh` handles a missing session (skips kill, bootstraps fresh); it also self-skips on a quota wall.
- **effort_level empty/absent** — only `model` is merged; `effortLevel` is left as-is.

## Safety Invariants

- **No secret is ever output** — the GET serializes only `model` + `effortLevel`, never the settings.json `env` block; never echo, grep or log that block.
- **The merge cannot leak the env block** — it `json.load()`s the whole file and `json.dump()`s it back, so the env block round-trips verbatim into its own protected file; only `model` + `effortLevel` are mutated.

## Red Flags

- About to write `~/.claude/settings.json` without explicit user confirmation
- Using `sed`/`echo` to edit settings.json instead of the JSON merge — a line-edit risks corrupting the JSON and cannot preserve key order safely
- Restarting a session other than `claude-autoagent-daemon` / `claude-wiki-daemon` when the drift is on one of those daemons

## Verification

- [ ] `--plan` ran first and the user saw the per-domain plan
- [ ] settings.json write happened only after explicit user confirmation
- [ ] settings.json still valid JSON with all non-model keys intact (env block untouched)
- [ ] Daemon restart used `daemon-daily-restart.sh` against the `claude-autoagent-daemon` / `claude-wiki-daemon` session
- [ ] Re-run `--plan` shows the applied daemon domains `in sync`; orchestrator flagged as pending session restart
- [ ] No secret value was echoed, printed, or logged
