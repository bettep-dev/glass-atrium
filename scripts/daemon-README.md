# Claude Daemon Pattern (Phase 1: M1 + W1)

> Two long-running tmux sessions (`claude-autoagent-daemon`, `claude-wiki-daemon`) that auto-start at boot/login via launchd and host always-on Claude Code instances for AutoAgent loops and Wiki curation.

## File Layout

```
~/Library/LaunchAgents/
  com.glass-atrium.autoagent-daemon.plist          launchd job → bootstrap script
  com.glass-atrium.wiki-daemon.plist               launchd job → bootstrap script

~/.claude/scripts/
  autoagent-daemon-bootstrap.sh              creates tmux session if missing
  autoagent-daemon-healthcheck.sh            verifies session + claude alive
  wiki-daemon-bootstrap.sh                   creates tmux session if missing
  wiki-daemon-healthcheck.sh                 verifies session + claude alive
  daemon-README.md                           this file

/tmp/
  autoagent-daemon.log                       launchd stdout/stderr capture
  wiki-daemon.log                            launchd stdout/stderr capture
```

## How the Pattern Works

```
boot/login
   │
   ▼
launchd reads ~/Library/LaunchAgents/com.claude.{role}-daemon.plist
   │
   ▼  RunAtLoad=true
launchd executes:  /bin/bash {role}-daemon-bootstrap.sh
   │
   ▼
bootstrap:  tmux has-session -t claude-{role}-daemon ?
   ├─ yes → supervise mode (launchd default): ADOPT — enter the self-health loop
   │        return mode (daily-restart):      log "no-op", exit 0
   └─ no  → tmux new-session -d -s claude-{role}-daemon 'exec claude …'
            → inject /loop → supervise: self-health loop · return: exit inject rc
   │
   ▼
launchd KeepAlive evaluates exit code:
   ├─ exit 0 + SuccessfulExit=false  →  do NOT restart (yield paths only)
   └─ exit !=0 (incl. monitor exit 3) →  wait ThrottleInterval=30s, retry
   │
   ▼
tmux server holds the session; the supervise bootstrap stays alive as its
supervisor (HTTP + has-session probes, exit 3 on sustained failure).
```

### Bootstrap lifecycle (supervise vs return)

The tmux **server** (`/opt/homebrew/bin/tmux`) holds the session; the bootstrap in supervise mode (launchd default) stays alive as the session's SUPERVISOR — a self-health loop probing `tmux has-session` + the fakechat HTTP port, exiting 3 on sustained failure so launchd respawns a fresh bootstrap. A symlink pid-lock (`/tmp/daemon-supervisor-<role>.lock`) guarantees exactly one live supervisor; a pre-existing session is ADOPTED, never no-op'd — a clean exit 0 under `KeepAlive.SuccessfulExit=false` would leave the session unsupervised until next login.

`KeepAlive.SuccessfulExit=false` tells launchd: "only restart on failure". This means:

- **Normal boot**: bootstrap creates the session, injects /loop, and keeps supervising it.
- **tmux missing / claude missing / creation failure**: bootstrap exits non-zero, launchd waits 30s (`ThrottleInterval`) and retries.
- **Session dies or the user kills it** (`tmux kill-session`): the supervisor's monitor loop exits 3 → launchd respawns the bootstrap → fresh create + inject.
- **Daily restart window**: `daemon-daily-restart.sh` holds `/tmp/daemon-restart-<role>.lock` across kill→recreate; a respawned supervise bootstrap waits on that lock, then adopts the recreated session instead of duplicate-racing the create.

## Manual Operations

### Attach to a daemon

```bash
tmux attach -t claude-autoagent-daemon
tmux attach -t claude-wiki-daemon
```

Detach without killing: `Ctrl-b` then `d` (default tmux prefix).

### Inspect without attaching

```bash
tmux list-sessions
tmux capture-pane -t claude-autoagent-daemon -p | tail -50
```

### Manual healthcheck

```bash
~/.claude/scripts/autoagent-daemon-healthcheck.sh && echo HEALTHY
~/.claude/scripts/wiki-daemon-healthcheck.sh     && echo HEALTHY
```

Exit code: `0` = healthy, `1` = session missing or claude process dead.

### Manual Restart (after killing a session)

```bash
# 1. Verify it's actually dead
tmux has-session -t claude-autoagent-daemon || echo "missing — needs restart"

# 2. Re-trigger the launchd job (modern syntax)
launchctl kickstart -k gui/$(id -u)/com.glass-atrium.autoagent-daemon

# 2b. OR run the bootstrap script directly
bash ~/.claude/scripts/autoagent-daemon-bootstrap.sh
```

Same pattern for `wiki`.

### View launchd logs

```bash
tail -50 /tmp/autoagent-daemon.log
tail -50 /tmp/wiki-daemon.log
```

## Loading the launchd Plists (User Action — Phase 1 First-Time Setup)

> [!IMPORTANT]
> The agent that authored these files does NOT load them. You (the user) run the commands below after reviewing the plists. Per `launchd-migration.md` §3.

> [!NOTE]
> The plist FILES are generated from the rendered `config.toml` by `glass-atrium render-plists` (or `scripts/render-launchd-plists.sh` directly) into `rendered/launchd/` — review them, copy into `~/Library/LaunchAgents`, then load below. The renderer never touches `launchctl`.

### Load (modern syntax — macOS 10.10+)

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.glass-atrium.autoagent-daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.glass-atrium.wiki-daemon.plist
```

### Load (legacy fallback if `bootstrap` fails)

```bash
launchctl load -w ~/Library/LaunchAgents/com.glass-atrium.autoagent-daemon.plist
launchctl load -w ~/Library/LaunchAgents/com.glass-atrium.wiki-daemon.plist
```

### Verify

```bash
launchctl list | grep com.claude.*-daemon
# expect 2 lines, status column = 0
tmux list-sessions
# expect: claude-autoagent-daemon, claude-wiki-daemon
```

## Unloading / Rollback

```bash
launchctl bootout gui/$(id -u)/com.glass-atrium.autoagent-daemon
launchctl bootout gui/$(id -u)/com.glass-atrium.wiki-daemon

# Optional: kill the running tmux sessions
tmux kill-session -t claude-autoagent-daemon
tmux kill-session -t claude-wiki-daemon

# Trash the plists (per ALL.md: rm forbidden for config files)
mv ~/Library/LaunchAgents/com.glass-atrium.autoagent-daemon.plist ~/.Trash/
mv ~/Library/LaunchAgents/com.glass-atrium.wiki-daemon.plist     ~/.Trash/
```

## Plist Key Reference

| Key | Value | Why |
|---|---|---|
| `Label` | `com.claude.{role}-daemon` | unique launchd job ID |
| `ProgramArguments` | `/bin/bash` + absolute bootstrap path | launchd does NOT expand `$HOME` — absolute required |
| `RunAtLoad` | `true` | auto-create session on first load + every login |
| `KeepAlive.SuccessfulExit` | `false` | only respawn on failure (bootstrap exits 0 in steady state) |
| `ThrottleInterval` | `30` (seconds) | minimum gap between respawns to prevent CPU storms |
| `WorkingDirectory` | `$HOME` | absolute home path |
| `EnvironmentVariables.PATH` | `/opt/homebrew/bin:...` | bootstrap needs `tmux` and `claude` discoverable |
| `EnvironmentVariables.HOME` | `$HOME` | tmux/claude config lookup |
| `StandardOutPath` / `StandardErrorPath` | `/tmp/{role}-daemon.log` | debugging visibility (T30 pattern) |

## Future Phases (Out of Scope for M1+W1)

- **M2+W2**: send `/loop` initialization message to each daemon's claude process via `claude-send.sh` after creation
- **M3+W3**: continuous self-healing — healthcheck-driven respawn watcher (cron or launchd `StartInterval`)
- **M7+W7**: integrate `*-daemon-healthcheck.sh` into `system-health-check.sh` 09:00 daily report
- **M3 stabilization**: unload the legacy `com.claude.autoagent.plist` (cron-style daily 03:00) once daemon-mode AutoAgent loop is proven stable (per integrity plan §6-4)

## Related Docs

- `~/.claude/scripts/launchd-migration.md` — original 5-plist migration guide (TCC, bootstrap/legacy syntax, troubleshooting)
- `~/.claude/scripts/system-health-check.sh` — already checks the existing user-managed `claude-daemon` session (line ~397); M7+W7 will extend it with the new daemons
