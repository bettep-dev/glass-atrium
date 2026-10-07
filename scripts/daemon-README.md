# Glass Atrium launchd Jobs

> The scheduled and resident `com.glass-atrium.*` launchd jobs: the monitor server, plus the daily maintenance, AutoAgent and Wiki cycles.

## Jobs

- Roster SoT: `lib/ga-env.sh` → `LAUNCHD_JOBS`; `scripts/render-launchd-plists.sh` → `JOBS` mirrors it
- Lifecycle: `config.toml` → `[daemon.<job>]` — `mode = "keepalive"` or a daily `time = "HH:MM"`; the times below are the `config.toml.example` defaults

| Label | Lifecycle | Runs | Log |
|---|---|---|---|
| `com.glass-atrium.monitor` | keepalive | `node <monitor>/dist/server/main.js` | `<log_root>/monitor.out.log`, `<log_root>/monitor.err.log` |
| `com.glass-atrium.monitor-log-rotate` | daily 02:30 | `scripts/monitor-log-rotate.sh` | `/tmp/monitor-log-rotate.out.log`, `/tmp/monitor-log-rotate.err.log` |
| `com.glass-atrium.pg-backup` | daily 02:30 | `scripts/pg-backup.sh` | `/tmp/pg-backup.log` |
| `com.glass-atrium.autoagent-cycle` | daily 04:30 | `autoagent/daemon-cycle.sh` | `/tmp/autoagent-daemon-loop.log` |
| `com.glass-atrium.wiki-compile` | daily 04:50 | `scripts/wiki-daily-compile.sh`, then `scripts/wiki-daemon-cycle.sh` | `/tmp/wiki-compile.log`, `/tmp/wiki-daemon-loop.log` |

- `<root>`, `<monitor>`, `<log_root>` = `config.toml` → `[paths].root`, `[paths].monitor`, `[paths].log_root`

## Retired Jobs

- `com.glass-atrium.autoagent-daemon`, `com.glass-atrium.wiki-daemon`, `com.glass-atrium.daemon-daily-restart` and the `claude-autoagent-daemon` / `claude-wiki-daemon` tmux sessions are no longer rendered or loaded
- SoT: `lib/ga-env.sh` → `LAUNCHD_RETIRED_JOBS`, `GA_DAEMON_SESSIONS`
- Cleared on any install that still carries them by `lib/ga-launchd.sh` → `retire_launchd_jobs`, reached from:
  - the `autoagent-cycle` job's retire stage
  - Install, and `--load-launchd`
- Uninstall tears down the active and the retired labels alike

## Manual Operations

### Inspect

```bash
launchctl list | awk '$3 ~ /^com\.glass-atrium\./'
launchctl print gui/$(id -u)/com.glass-atrium.autoagent-cycle
```

- Column 2 = last exit status; `0` = clean

### Run a scheduled job now

```bash
launchctl kickstart gui/$(id -u)/com.glass-atrium.autoagent-cycle
```

### View logs

```bash
tail -50 /tmp/autoagent-daemon-loop.log
tail -50 /tmp/wiki-daemon-loop.log
```

## Loading the launchd Plists

> [!IMPORTANT]
> Install from the interactive menu loads the jobs itself, after its health gate; the non-interactive bootstrap path loads them only with `--load-launchd`. Opt out of the menu load with `GA_NO_LOAD_LAUNCHD=1` (or `--no-load-launchd`), then review the plists and load them with the commands below.

> [!NOTE]
> The plist FILES are generated from the rendered `config.toml` by `glass-atrium render-plists` (or `scripts/render-launchd-plists.sh` directly) into `rendered/launchd/` — review them, copy into `~/Library/LaunchAgents`, then load below. The renderer never touches `launchctl`.

### Load (modern syntax — macOS 10.10+)

```bash
for job in monitor monitor-log-rotate pg-backup autoagent-cycle wiki-compile; do
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.glass-atrium.${job}.plist
done
```

### Load (legacy fallback if `bootstrap` fails)

```bash
launchctl load -w ~/Library/LaunchAgents/com.glass-atrium.<job>.plist
```

### Verify

```bash
launchctl list | awk '$3 ~ /^com\.glass-atrium\./'
# expect 5 lines
```

## Unloading / Rollback

```bash
launchctl bootout gui/$(id -u)/com.glass-atrium.<job>

# Trash the deployed copy (the rendered SoT in rendered/launchd/ stays)
mv ~/Library/LaunchAgents/com.glass-atrium.<job>.plist ~/.Trash/
```

## Plist Key Reference

| Key | Value | Why |
|---|---|---|
| `Label` | `com.glass-atrium.<job>` | unique launchd job ID |
| `ProgramArguments` | absolute paths only | launchd does NOT expand `$HOME` |
| `RunAtLoad` | `true` (keepalive) · `false` (daily) | the resident monitor starts at load and every login |
| `KeepAlive.SuccessfulExit` | `false` (keepalive) | only respawn on failure |
| `ThrottleInterval` | `30` (keepalive) | minimum gap between respawns |
| `StartCalendarInterval` | `Hour` / `Minute` (daily) | from `[daemon.<job>].time` |
| `WorkingDirectory` | `$HOME` (monitor: `<monitor>`) | absolute path |
| `EnvironmentVariables.PATH` | rendered tool PATH | launchd's default PATH lacks Homebrew tools |
| `EnvironmentVariables.HOME` | target user's home | config lookup |
| `StandardOutPath` / `StandardErrorPath` | see `## Jobs` | debugging visibility |
