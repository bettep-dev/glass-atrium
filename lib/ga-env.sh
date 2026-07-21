# shellcheck shell=bash
# shellcheck disable=SC2034  # ga_init_env assigns the shared readonly globals (GA_ROOT/TARGET_HOME/MANIFEST/EXPECTED_HOOK_BINDINGS/...) consumed by sibling ga-*.sh domains after sourcing — unused within this producer file when linted standalone
# Glass Atrium — environment init, logging, and OS-portable stat/util primitives (foundation domain). Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# [1] idempotency sentinel + ga_init_env
# The ONLY function that runs `readonly`. Assigns ALL shared constants + run-mode flag DEFAULTS (flags stay
# plain/non-readonly so the caller's parse_args can set them). Idempotent: a second call (re-source /
# double-init) is a clean no-op so a `set -e` `readonly` re-assign can never fire twice.
# GA_ROOT contract: ga_init_env "<resolved_ga_root>" [<target_home_override>]. $1 is the authoritative
# GA_ROOT (the entry point's resolved location); no BASH_SOURCE fallback, no $GA_ROOT env read (the env
# var is scrubbed/repurposed by sibling renderers).
ga_init_env() {
  # idempotent: a second call is a clean no-op (set -e `readonly` never re-fires).
  if [[ -n "${GA_CORE_INITED:-}" ]]; then return 0; fi

  local ga_root="${1:?ga_init_env requires the resolved GA_ROOT as \$1}"

  # GA_ROOT is the entry point's resolved location — a copied GA tree is
  # self-isolating + not pinned to one user path (OSS portability).
  readonly GA_ROOT="${ga_root}"
  # sandbox override — throwaway target dir when GA_TARGET_HOME is set
  readonly TARGET_HOME="${GA_TARGET_HOME:-${HOME}/.claude}"

  # GA_DATA_ROOT — HOME-anchored runtime data/log root, DECOUPLED from the install-tree GA_ROOT (which is
  # unset in the CLI-fired-hook + launchd-daemon contexts). Exported so launcher-spawned children inherit
  # the resolved value; hook-utils.sh + ga_paths.py mirror the same default for contexts that never source
  # this lib. GA_DATA_ROOT override preserved (default-only). Two-step global idiom (plain assign, then
  # export + `readonly` WITHOUT -a) so a cross-function expansion stays defined under set -u.
  GA_DATA_ROOT="${GA_DATA_ROOT:-${HOME}/.glass-atrium}"
  export GA_DATA_ROOT
  readonly GA_DATA_ROOT
  # MANIFEST overridable (GA_MANIFEST) so a sandbox/CI run drives the installer against a tree-matched
  # manifest without editing the tracked one (GA_* override pattern). Default = the tracked manifest in the GA root.
  readonly MANIFEST="${GA_MANIFEST:-${GA_ROOT}/manifest.json}"
  readonly LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"

  # config.toml render: tracked ${HOME}-placeholder template -> git-ignored render
  # output. CONFIG_TOML target is overridable (GA_CONFIG_TOML) so a sandbox test
  # renders to a throwaway path instead of the real GA root — the default is the
  # real render-output location consumed by render-monitor-env.sh (GA_ROOT/config.toml).
  readonly CONFIG_TOML_EXAMPLE="${GA_ROOT}/config.toml.example"
  readonly CONFIG_TOML="${GA_CONFIG_TOML:-${GA_ROOT}/config.toml}"

  # DB bootstrap — fresh-machine path delegates to the monitor's own setup script (createdb + .env + npm ci
  # + prisma generate/deploy, each idempotent). DB_NAME / PG_SOCKET mirror the script's constants (peer-auth
  # Unix socket). GA_DB_NAME points the presence probe AND the delegated setup at a throwaway DB (sandbox/CI),
  # flowing through to oss-db-setup.sh unchanged (GA_* override pattern).
  readonly DB_SETUP_SCRIPT="${GA_ROOT}/monitor/scripts/oss-db-setup.sh"
  readonly DB_NAME="${GA_DB_NAME:-glass_atrium}"
  # GA_PG_SOCKET is a TEST SEAM (default /tmp): lets a test redirect the socket dir so clear_unmanaged_pg_orphan's rm can never target the live /tmp socket. Unset → /tmp, production byte-identical (mirrors the GA_* override pattern).
  readonly PG_SOCKET="${GA_PG_SOCKET:-/tmp}"

  # launchd plist render — file-write ONLY (never launchctl). Output dir is the
  # renderer's GA_PLIST_OUT default (<GA root>/rendered/launchd, git-ignored) or
  # its env override — mirrors the GA_* sandbox pattern.
  readonly PLIST_RENDERER="${GA_ROOT}/scripts/render-launchd-plists.sh"
  # rendered-plist source dir — mirrors render-launchd-plists.sh GA_PLIST_OUT
  # (default <GA root>/rendered/launchd). --load-launchd reads the rendered plists
  # from here, copies them into ~/Library/LaunchAgents, then launchctl bootstraps.
  readonly RENDERED_PLIST_DIR="${GA_PLIST_OUT:-${GA_ROOT}/rendered/launchd}"
  readonly LAUNCHD_LABEL_PREFIX="com.glass-atrium"
  # job names mirror render-launchd-plists.sh JOBS 1:1 (8 com.glass-atrium.* stanzas); drift vs the renderer
  # = a load gap. bash 3.2 + set -u: an in-function `readonly -a ARR=(...)` is function-local for nounset, so
  # a cross-function `${ARR[@]}` aborts "unbound" — use the two-step idiom (plain global assign, then
  # `readonly` WITHOUT -a) so every caller can expand it.
  LAUNCHD_JOBS=(
    monitor
    autoagent-daemon
    wiki-daemon
    monitor-log-rotate
    pg-backup
    autoagent-cycle
    wiki-compile
    daemon-daily-restart
  )
  readonly LAUNCHD_JOBS

  # GA_DAEMON_SESSIONS — the DETACHED daemon tmux session names. SoT = the bootstrap scripts' `readonly
  # SESSION=` (scripts/wiki-daemon-bootstrap.sh:15 'claude-wiki-daemon' + scripts/autoagent-daemon-bootstrap.sh:16
  # 'claude-autoagent-daemon'). These SURVIVE `launchctl bootout` (reparented to PID 1) + `claude plugin
  # uninstall`, so uninstall/install must kill them explicitly. Same two-step idiom as LAUNCHD_JOBS so a
  # cross-function `${GA_DAEMON_SESSIONS[@]}` stays defined under set -u.
  GA_DAEMON_SESSIONS=(
    claude-wiki-daemon
    claude-autoagent-daemon
  )
  readonly GA_DAEMON_SESSIONS

  # manifest drift gate (doctor preflight §8) — the --check verifier that fails
  # loud on a source-vs-manifest divergence before install. Override (GA_GENERATE_MANIFEST)
  # mirrors the GA_* sandbox pattern.
  readonly GENERATE_MANIFEST="${GA_GENERATE_MANIFEST:-${GA_ROOT}/scripts/generate-manifest.sh}"

  # collision-detection scope — only agents/ and skills/ entries are collision-
  # checked (the components the dropped plugin layer would have auto-namespaced).
  # A DIFFERENT same-named non-symlink user file under these dirs is WARN+skip
  # (or prompt with --collision-prompt), never overwritten.
  COLLISION_SCOPE_PREFIXES=(
    "agents/"
    "skills/"
  )
  readonly COLLISION_SCOPE_PREFIXES

  # symlink-farm exclusion — INSTALL-INTERNAL manifest entries that are BUNDLED + per-file hash-verified
  # (they ship + doctor §4 checks their presence) yet are NEVER symlinked into ~/.claude, because they are
  # consumed IN PLACE from ~/.glass-atrium: lib/ga-core.sh + lib/ga-deps.sh are SOURCED by the launcher from
  # its own dir; config.toml.example is the render_config template; requirements.txt is the python-deps
  # source; monitor/ is the dashboard the bootstrap BUILDS (`cd monitor && npm run build`) + RUNS in place
  # (`node dist/server/main.js`, launchd-repointed to ${GA_ROOT}/monitor) — a ~/.claude/monitor or
  # ~/.claude/lib link would be wrong (nothing there sources them). Prefix globs + exact basenames,
  # TARGET_HOME-relative (mirrors the COLLISION_SCOPE_PREFIXES / NEVER_TOUCH shapes).
  #
  # ESSENTIAL-SYMLINKS-ONLY drop-set: only the NATIVELY-DISCOVERED surfaces (agents/, skills/, rules/) stay
  # farmed into ~/.claude; the INDIRECTED / non-native-discovery surfaces are consumed in place from
  # ~/.glass-atrium and joined the exclude set — each per-surface reason is load-bearing:
  #   * hooks/  — settings.json binds ABSOLUTE command paths (repointed to ~/.glass-atrium/hooks), so no
  #     ~/.claude/hooks symlink is needed for the client to fire them.
  #   * scoped/ — NOT natively auto-loaded (native rule auto-load is ~/.claude/rules/*.md only); scoped/*.md
  #     is hook-INJECTED per-agent from ~/.glass-atrium/scoped, so a ~/.claude/scoped link is dead weight.
  #   * agent-registry.json — the monitor + agent_lifecycle resolve it from ~/.glass-atrium (env-independent
  #     default), so the ~/.claude link is a runtime dangling reference once dropped.
  #   * glass-atrium (the launcher) — invoked via the PATH-exported ~/.glass-atrium copy, never a ~/.claude alias.
  #   * scripts/ — Atrium-internal consumables (no native Claude Code discovery); every shipped runtime +
  #     prose reference is repointed to the ~/.glass-atrium/scripts copy, so a ~/.claude/scripts link is dead weight.
  #   * autoagent/ — the self-improvement daemon tree, invoked via ~/.glass-atrium/autoagent (launchd
  #     ProgramArguments + sibling resolution), never a ~/.claude alias.
  # RUNTIME-ACTIVATION SEQUENCING (cross-unit): the effective drop of these surfaces MUST NOT take runtime
  # effect before their long-running consumers are repointed (settings.json hook command path; monitor
  # registry.ts default; inject-scope-rules/validate-compliance-matrix SCOPED source) — else a live install
  # orphans them (hook blackout / dangling registry / empty scope injection). This array edit is the
  # farm-side mechanic only; those consumer repoints land in their own units.
  SYMLINK_EXCLUDE_PREFIXES=(
    "lib/"
    "monitor/"
    "hooks/"
    "scoped/"
    "scripts/"
    "autoagent/"
  )
  readonly SYMLINK_EXCLUDE_PREFIXES
  SYMLINK_EXCLUDE_EXACT=(
    "config.toml.example"
    "requirements.txt"
    "agent-registry.json"
    "glass-atrium"
    # The shipped bulldog art asset — the launcher reads it in place from
    # ~/.glass-atrium/docs/assets/bulldog-braille.txt (GA_ROOT-anchored), so a
    # ~/.claude symlink would be dead weight (Claude Code never discovers docs/).
    "docs/assets/bulldog-braille.txt"
  )
  readonly SYMLINK_EXCLUDE_EXACT

  # never-touch user-owned paths (relative to TARGET_HOME) — exact basenames +
  # prefix globs. These are NEVER read/moved/symlinked-over/deleted (spec §6-1).
  NEVER_TOUCH_EXACT=(
    ".credentials.json"
    "projects"
    "history.jsonl"
    "ide"
    "shell-snapshots"
    "todos"
  )
  readonly NEVER_TOUCH_EXACT
  # prefix-matched never-touch (e.g. vercel-plugin-device-id, -id.lock, ...)
  readonly NEVER_TOUCH_PREFIX="vercel-plugin-device-id"

  # settings.json — the EVENT->HOOK wiring lives ONLY here and is NOT in the manifest (user-owned config
  # the installer must never overwrite — see the never-touch guard + D-5 doctor binding check). The
  # installer deploys the hook FILES; the user wires them via these bindings. The doctor check (run_doctor
  # §6) reads settings.json read-only + WARNS per missing binding (a deployed-but-unwired hook is dormant).
  readonly SETTINGS_JSON="${TARGET_HOME}/settings.json"

  # expected hook->event bindings the user MUST register in settings.json for the deployed hooks to fire.
  # Each entry = "<event>\t<hook-basename>\t<matcher>" (events: PreToolUse / PostToolUse / SessionStart /
  # Stop / SubagentStart / SubagentStop / PreCompact). Matched against the live settings.json
  # .hooks[<event>][].hooks[].command by basename, SCOPED to its matcher (command-WITHIN-matcher — the
  # doctor binding check + wire_hooks idempotency key). The 3rd column (matcher) is BOTH the UPSERT selector
  # AND the bound/dormant scoping key; an empty 3rd column = "no matcher key" (SessionStart/Stop are
  # unmatched). Per-matcher, so the SAME hook may appear in TWO rows under one event with different matchers
  # (e.g. validate-secret-scan.sh on Write|Edit AND Bash) — each wired + tracked independently.
  # Add a row here when a new hook is deployed. SINGLE SoT — wire_hooks/run_doctor AND unwire_hooks/verify_clean
  # all read this one array (the prior per-script duplication collapsed here).
  EXPECTED_HOOK_BINDINGS=(
    "PreToolUse	advisory-context-budget.sh	Agent"
    "PreToolUse	advisory-spawn-budget.sh	Agent"
    "PreToolUse	advisory-spawn-cost.sh	Agent"
    "PreToolUse	advisory-subagent-budget.sh	"
    "PreToolUse	block-dangerous-commands.sh	Bash"
    "PreToolUse	block-doc-routing-leak.sh	Write"
    "PreToolUse	block-md-creation.sh	Write"
    "PreToolUse	block-no-verify.sh	Bash"
    "PreToolUse	enforce-commit-guard.sh	Bash"
    "PreToolUse	enforce-config-protection.sh	Write|Edit"
    "PreToolUse	enforce-delegation.sh	Write|Edit"
    "PreToolUse	enforce-foreground-harness.sh	Agent"
    "PreToolUse	enforce-harness-critical.sh	Bash"
    "PreToolUse	enforce-harness-critical.sh	Write|Edit"
    "PreToolUse	enforce-verification-gate.sh	Agent"
    "PreToolUse	enforce-workflow-verify-stage.sh	Workflow"
    "PreToolUse	lint-workflow-template-literal.sh	Workflow"
    "PreToolUse	telemetry-activation.sh	Agent"
    "PreToolUse	validate-edit-syntax.sh	Write|Edit"
    "PreToolUse	validate-pre-write-raw.sh	Write"
    "PreToolUse	validate-prompt.sh	Write|Edit"
    "PreToolUse	validate-scope-drift.sh	Write|Edit"
    "PreToolUse	validate-secret-scan.sh	Bash"
    "PreToolUse	validate-secret-scan.sh	Write|Edit"
    "PostToolUse	detect-secret-file-write.sh	Bash"
    "PostToolUse	enforce-verification-gate.sh	Agent"
    "PostToolUse	post-edit-format.sh	Edit|Write"
    "PostToolUse	post-edit-outcome-sync.sh	Write"
    "PostToolUse	post-edit-typecheck.sh	Edit|Write"
    "PostToolUse	validate-large-diff.sh	Edit|Write"
    "PostToolUse	validate-output.sh	"
    "PostToolUse	validate-tool-response.sh	WebFetch|WebSearch|mcp__.*(fetch|get|read|search).*"
    "SessionStart	inject-session-context.sh	"
    "SessionStart	prune-security-warnings-state.sh	"
    "SessionStart	prune-session-spawns.sh	"
    "SessionStart	validate-compliance-matrix.sh	"
    "Stop	advisory-preedit-facts.sh	"
    "Stop	cost-tracker.sh	"
    "Stop	post-edit-typecheck.sh	"
    "SubagentStart	agent-tracker.sh	"
    "SubagentStart	inject-scope-rules.sh	"
    "SubagentStart	telemetry-activation.sh	"
    "SubagentStop	agent-tracker.sh	"
    "SubagentStop	post-edit-typecheck.sh	"
    "SubagentStop	track-outcome.sh	"
    "PreCompact	pre-compact.sh	"
  )
  readonly EXPECTED_HOOK_BINDINGS

  # prune named exit codes (loud-fail, distinct from die's generic 1): 2 = no
  # target dir, 3 = manifest absent/unparseable. Inside the sentinel-guarded block
  # (not file-scope) so a re-source never re-runs `readonly` → fatal under set -e.
  readonly PRUNE_EXIT_NO_TARGET=2
  readonly PRUNE_EXIT_NO_MANIFEST=3

  # bootstrap exit-code semantics (distinct from die's generic 1):
  #   20 = monitor build failed   21 = monitor health gate failed (no 200 in window)
  #   22 = --load-launchd: rendered plists absent   23 = --load-launchd: a bootstrap failed
  # Inside the guarded block (not file-scope) for the same re-source safety.
  readonly BOOTSTRAP_EXIT_BUILD=20
  readonly BOOTSTRAP_EXIT_HEALTH=21
  readonly BOOTSTRAP_EXIT_LOAD_NORENDER=22
  readonly BOOTSTRAP_EXIT_LOAD_FAILED=23
  # health-gate window — the monitor is expected up well within this many seconds.
  readonly BOOTSTRAP_HEALTH_WINDOW_SECS=30

  # E5 update-system libs — sourced HERE (after GA_ROOT is readonly) so the install/uninstall/doctor flows
  # can call the update-system helpers:
  #   * atrium-config.sh    — atrium_toml_get (doctor §9 [release].repo read)
  #   * apply-spine.sh       — spine_set_baseline / spine_get_baseline / spine_* (T24 capture · §9 probe)
  #   * update-pause-flag.sh — update_pause_remove / update_pause_flag_path / update_pause_flag_age_secs (T26 · T27)
  # All three are PURE (function-only, no side effects / strict-mode mutation), so sourcing here defines the
  # functions without any file-scope action. Resolved under GA_ROOT/scripts/lib (GA_LIB_DIR overrides for
  # sandbox/CI). Loud-fail (die) on an absent lib — a missing E5 lib is a broken install, never a silent
  # skip (shared-self-improve-hygiene Precondition Loud-Fail Principle).
  readonly LIB_DIR="${GA_LIB_DIR:-${GA_ROOT}/scripts/lib}"
  local _e5_lib
  for _e5_lib in atrium-config.sh apply-spine.sh update-pause-flag.sh; do
    [[ -f "${LIB_DIR}/${_e5_lib}" ]] \
      || die "E5 lib missing: ${LIB_DIR}/${_e5_lib} (broken install — scripts/lib is incomplete)"
    # shellcheck source=/dev/null
    source "${LIB_DIR}/${_e5_lib}"
  done

  # fakechat port-cleanup lib — the shared, STRICTLY PORT-SCOPED fakechat_free_port
  # helper consumed by kill_daemon_tmux_sessions (install/uninstall teardown) to reap
  # the orphan bun squatting a daemon fakechat port. Loud-fail (die) on an absent lib
  # like the E5 libs — a missing lib is a broken install, never a silent skip
  # (shared-self-improve-hygiene Precondition Loud-Fail Principle).
  [[ -f "${LIB_DIR}/fakechat-cleanup.sh" ]] \
    || die "fakechat-cleanup lib missing: ${LIB_DIR}/fakechat-cleanup.sh (broken install — scripts/lib is incomplete)"
  # shellcheck source=/dev/null
  source "${LIB_DIR}/fakechat-cleanup.sh"

  # run-mode flag DEFAULTS — plain (NON-readonly) vars so the caller's parse_args
  # can still set them. The lib defines the defaults; the entry point parses argv.
  # shellcheck disable=SC2034  # consumed by the entry points + the fns below
  DRY_RUN=false
  # shellcheck disable=SC2034
  REPOINT_LAUNCHD=false
  # shellcheck disable=SC2034
  RE_RENDER=false
  # shellcheck disable=SC2034
  COLLISION_PROMPT=false
  # shellcheck disable=SC2034
  LOAD_LAUNCHD=false
  # CHANGE 1 opt-out: the interactive menu Install now auto-loads launchd (the 11th step,
  # menu_load_launchd_jobs in glass-atrium). --no-load-launchd / GA_NO_LOAD_LAUNCHD=1 keep
  # the historical render-only behavior for CI / non-interactive runs. Inert on the
  # passthrough engine path (which only loads behind --load-launchd anyway).
  # shellcheck disable=SC2034
  NO_LOAD_LAUNCHD=false
  # shellcheck disable=SC2034
  RECREATE_DB=false
  # shellcheck disable=SC2034
  RECREATE_YES=false
  # shellcheck disable=SC2034
  SCAN_ONLY=false
  # shellcheck disable=SC2034
  PURGE_CONFIG=false
  # shellcheck disable=SC2034
  VERIFY_CLEAN=false
  # shellcheck disable=SC2034  # consumed by the uninstall full-removal CLI gate (glass-atrium)
  ASSUME_YES=false
  # shellcheck disable=SC2034
  SUBCOMMAND="install"

  # set LAST so a mid-init failure does not wrongly mark inited (loud-fail friendly).
  readonly GA_CORE_INITED=1
}

# [2] leaf logging
# Prose-prefix coupling: the launcher's classify_step_log (glass-atrium) keys severity
# classes (LOUD/DIM/SUPPRESS) on these `log` message prefixes — keep them in sync.
log() { printf '%s\n' "$*" >&2; }

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

# exit_step / die_step — force-quit-CLASS guard for run_plan step functions shared between
# the TUI menu path and the CLI passthrough. The TUI run_step invokes each step as a SAME-SHELL
# brace group `{ "$@"; }` under `set +e` (glass-atrium run_step) then captures `rc=$?`; an in-step
# `exit`/`die` therefore terminates the WHOLE TUI process (masked force-quit, no FAIL panel — the
# cleanup() EXIT trap restores the terminal). run_step sets GA_TUI_STEP=1 ONLY across the "$@"
# invocation, so a step's routine failure must RETURN under it (run_plan renders the FAIL panel +
# persisted see:<log>) yet still `exit` on the CLI path (the named bootstrap codes 20/21/… stay the
# CLI/dashboard contract). These two leaves centralize that branch — the engine-level subshell
# alternative was rejected (cleanup() reads parent-shell globals a step mutates, e.g. GATE_LOG).
#
# exit_step CODE — for a site whose message is ALREADY logged: CLI → `exit CODE`; TUI → return
# non-zero so the caller's `|| return CODE` fires. Idiom: `exit_step "${rc}" || return "${rc}"`.
exit_step() {
  [[ -n "${GA_TUI_STEP:-}" ]] && return 1
  exit "${1:-1}"
}

# die_step CODE MSG… — die() variant: prints `FATAL: MSG`, then CLI → `exit CODE`; TUI → `return
# CODE` so the caller's `|| return CODE` fires. Idiom: `cond || die_step 1 "msg" || return 1`.
die_step() {
  local code="${1:-1}"
  shift
  printf 'FATAL: %s\n' "$*" >&2
  [[ -n "${GA_TUI_STEP:-}" ]] && return "${code}"
  exit "${code}"
}

# never-touch guard
# Echo "yes" when a target-relative path is a protected user-owned path, else
# "no". Always exits 0 — a stdout verdict (not a boolean return) so the ERR
# trap never fires on an expected "no" and no set +e bracketing is needed.
is_never_touch() {
  local rel="$1"
  # top-level component only — never-touch entries are all top-level
  local top="${rel%%/*}"
  local entry
  for entry in "${NEVER_TOUCH_EXACT[@]}"; do
    if [[ "${top}" == "${entry}" ]]; then
      printf 'yes\n'
      return 0
    fi
  done
  # prefix-glob match (vercel-plugin-device-id*)
  case "${top}" in
    "${NEVER_TOUCH_PREFIX}"*) printf 'yes\n' ;;
    *) printf 'no\n' ;;
  esac
}

# OS-portable stat accessors (BSD/macOS `stat -f` vs GNU/Linux `stat -c`)
# BSD and GNU stat diverge on BOTH the flag (-f vs -c) AND the per-field specifier, so a blind -f→-c swap
# silently returns WRONG values on GNU. Detect the flavor ONCE (uname -s, memoized) + route each PURPOSE
# through its own accessor carrying the correct flag+specifier:
#   dev   (st_dev) : BSD %d  == GNU %d   (specifier matches)
#   perms (octal)  : BSD %Lp -> GNU %a   (specifier DIFFERS)
#   mtime (epoch)  : BSD %m  -> GNU %Y   (specifier DIFFERS)
# __GA_STAT_IS_BSD is set on first use (1 = BSD/Darwin stat -f, 0 = GNU stat -c).
__ga_detect_stat_os() {
  [[ -n "${__GA_STAT_IS_BSD:-}" ]] && return 0
  local os
  os="$(uname -s 2>/dev/null || printf 'unknown')"
  if [[ "${os}" == "Darwin" ]]; then
    __GA_STAT_IS_BSD=1
  else
    __GA_STAT_IS_BSD=0
  fi
}

# Warm the flavor memo at load so `__GA_STAT_IS_BSD` is set in the sourcing shell — inherited by the
# `$(...)` command-sub subshells in wrapper callers (ga-doctor.sh/ga-tui-preflight.sh), so the per-call
# `uname` fork in the stat_dev/stat_perms/stat_mtime hot paths disappears (idempotent on re-source).
__ga_detect_stat_os

# stat_dev <path> — numeric st_dev (same %d specifier on both flavors).
stat_dev() {
  __ga_detect_stat_os
  if [[ "${__GA_STAT_IS_BSD}" -eq 1 ]]; then
    stat -f '%d' -- "$1"
  else
    stat -c '%d' -- "$1"
  fi
}

# stat_perms <path> — octal permission bits (BSD %Lp vs GNU %a).
stat_perms() {
  __ga_detect_stat_os
  if [[ "${__GA_STAT_IS_BSD}" -eq 1 ]]; then
    stat -f '%Lp' -- "$1"
  else
    stat -c '%a' -- "$1"
  fi
}

# stat_mtime <path> — epoch mtime seconds (BSD %m vs GNU %Y).
stat_mtime() {
  __ga_detect_stat_os
  if [[ "${__GA_STAT_IS_BSD}" -eq 1 ]]; then
    stat -f '%m' -- "$1"
  else
    stat -c '%Y' -- "$1"
  fi
}

# device id (doctor same-device advisory helper)
# Numeric st_dev of a path via the OS-portable accessor. Caller must pass an
# existing path.
dev_of() { stat_dev "$1"; }

# sandbox-target guard (launchd domain protection)
# Echo "yes" when this run targets a NON-real home, via EITHER sandbox seam:
#   (a) GA_TARGET_HOME override — TARGET_HOME points off ${HOME}/.claude (bats/CI: HOME real, target redirected);
#   (b) fake-HOME sandbox — ${HOME} diverges from the passwd-db home (oss-e2e-bootstrap.sh: HOME=<sandbox>,
#       GA_TARGET_HOME unset, so seam (a) alone can NEVER see it).
# WHY both: launchd gui-domain labels are per-UID, NOT per-HOME — a fake-HOME run still mutates the REAL
# user's gui/${UID} domain, so teardown must key on "is this the real home", not path derivation alone.
# Passwd-db home via dscl (macOS) / getent (Linux); UNRESOLVABLE → "no" (real-home semantics preserved —
# every host where bootout runs is macOS, where dscl always resolves). Stdout-verdict (always exits 0).
is_sandbox_target() {
  if [[ "${TARGET_HOME}" != "${HOME}/.claude" ]]; then
    printf 'yes\n'
    return 0
  fi
  local un pw_home="" pw_raw=""
  un="$(id -un 2>/dev/null)" || un=""
  if [[ -n "${un}" ]]; then
    if command -v dscl >/dev/null 2>&1; then
      pw_raw="$(dscl . -read "/Users/${un}" NFSHomeDirectory 2>/dev/null)" || pw_raw=""
      # "NFSHomeDirectory: /path" → prefix-strip via expansion (pipe-free)
      if [[ "${pw_raw}" == "NFSHomeDirectory: "* ]]; then
        pw_home="${pw_raw#NFSHomeDirectory: }"
      fi
    elif command -v getent >/dev/null 2>&1; then
      pw_raw="$(getent passwd "${un}" 2>/dev/null)" || pw_raw=""
      # passwd(5) field 6 via IFS split (pipe-free)
      IFS=: read -r _ _ _ _ _ pw_home _ <<<"${pw_raw}"
    fi
  fi
  if [[ -n "${pw_home}" && "${pw_home}" != "${HOME}" ]]; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

# post-install claude liveness (advisory)
# Run a command under a HARD wall-clock bound, killing its whole process group on expiry. bash 3.2 /
# macOS-portable: stock macOS has NO GNU `timeout`/`gtimeout`, but `/usr/bin/perl` is always present. The
# exec'd child leads its own process group (setpgrp), so on SIGALRM we SIGKILL the entire group.
# Defense-in-depth — primary hang-immunity is full /dev/null I/O decoupling at the call site
# (see doctor_postcheck), NOT this bound alone. Exit: child rc · 124 timeout · 70/71 fork/exec fail.
run_with_timeout() {
  local bound="$1"
  shift
  perl -e '
    my $bound = shift @ARGV;
    my $pid = fork();
    if (!defined $pid) { exit 70; }
    if ($pid == 0) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 71; }
    my $cpgid = $pid;
    $SIG{ALRM} = sub { kill("KILL", -$cpgid); waitpid($pid, 0); exit 124; };
    alarm($bound);
    waitpid($pid, 0);
    exit($? >> 8);
  ' "${bound}" "$@"
}
