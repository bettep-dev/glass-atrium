# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2310,SC2312  # SC2154: reads shared globals (TTY/TTY_SAVED/PREFLIGHT_*/STEP_*/GRAND_TOTAL/INSTALL_PLAN_LEN/C_*/G_* etc.) declared + assigned by the glass-atrium loader; SC2034: assigns shared preflight/step-state globals (PREFLIGHT_NONINTERACTIVE/PREFLIGHT_TTY_OWNED/STEP_TOTAL/GRAND_TOTAL etc.) read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2310: `fn || rc=$?` is the intended exit-capture idiom (mirrors the loader's file-wide SC2310 disable); SC2312: detect/gate/render helpers are deliberately invoked inside command substitutions or conditionals (the masked return carries the intended signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — dependency-preflight + headless-auth module. SOURCED by the glass-atrium
# entry point (never executed): shebang/strict-mode/IFS/traps + the top-level const/stub band
# (readonly PREFLIGHT_EXIT_BLOCKED, AUTH_FAIL_RE, the PREFLIGHT_TTY_OWNED/PREFLIGHT_NONINTERACTIVE/
# PREFLIGHT_SUMMARY/PREFLIGHT_GROUP*_RUNNABLE stubs) stay loader-owned so re-sourcing never re-arms.
# Owns the always-on bare-Mac dependency preflight — the detect-then-skip bootstrap layer (TTY/PATH/rc
# helpers, grouped-consent + guide gates, launchd headless-auth token provisioning, fakechat + python
# installs, boxed/scroll render orchestrators) — reading/mutating the loader's file-scope preflight/step
# globals in the same sourced shell. R6 fd-4/TTY lifecycle: preflight_ensure_tty opens fd 4 here, cleanup
# (loader) closes it — same sourced shell, so the open/close pair spans the two files safely.

# preflight_out / preflight_line — the preflight's chrome sink. Mirrors tty_out / tty_line but targets
# the preflight TTY: the menu's fd 3 when ui_init engaged it, else our own fd 4 (passthrough), else
# stderr in the non-interactive fallback (no chrome to draw, only the loud-fail message).
preflight_out() {
  if [[ -n "${TTY}" ]]; then
    printf '%s' "$*" >"${TTY}"
  elif [[ "${PREFLIGHT_TTY_OWNED}" == "true" ]]; then
    printf '%s' "$*" >&4
  else
    printf '%s' "$*" >&2
  fi
}

preflight_line() {
  if [[ -n "${TTY}" ]]; then
    printf '%s\n' "$*" >"${TTY}"
  elif [[ "${PREFLIGHT_TTY_OWNED}" == "true" ]]; then
    printf '%s\n' "$*" >&4
  else
    printf '%s\n' "$*" >&2
  fi
}

# preflight_ensure_tty — make a TTY available for the preflight prompts/progress. Interactive menu:
# ${TTY} (fd 3) already open + TTY_SAVED captured by ui_init — reuse it. Passthrough: open /dev/tty as
# fd 4 when readable, snapshot TTY_SAVED so confirm_typed's cooked-mode toggle works, route TUI helpers
# at fd 4 via a temporary TTY assignment. No controlling TTY -> PREFLIGHT_NONINTERACTIVE so the
# missing-set path loud-fails instead of blocking on an unanswerable prompt.
preflight_ensure_tty() {
  # interactive menu already owns a TTY (fd 3 + TTY_SAVED) — nothing to acquire.
  if [[ -n "${TTY}" ]]; then
    PREFLIGHT_NONINTERACTIVE=false
    return 0
  fi
  # passthrough path: try to open the controlling terminal for prompts.
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    exec 4<>/dev/tty
    PREFLIGHT_TTY_OWNED=true
    TTY="/dev/fd/4"
    # snapshot cooked-mode settings so confirm_typed can toggle raw<->cooked.
    TTY_SAVED="$(stty -g <"${TTY}" 2>/dev/null || true)"
    PREFLIGHT_NONINTERACTIVE=false
    return 0
  fi
  # no controlling terminal — cannot prompt for consent.
  PREFLIGHT_NONINTERACTIVE=true
}

# preflight_release_tty — close the passthrough-opened fd 4 + unset the borrowed ${TTY} so the rest of
# the run does not write to a closed fd. No-op when the menu owned the TTY (release only what WE opened).
preflight_release_tty() {
  if [[ "${PREFLIGHT_TTY_OWNED}" == "true" ]]; then
    exec 4>&- 2>/dev/null || true
    PREFLIGHT_TTY_OWNED=false
    TTY=""
  fi
}

# preflight_eval_brew_shellenv — put a freshly-installed brew on PATH for the rest of the run
# (Apple-Silicon installs to /opt/homebrew, NOT on a stock PATH, so a later `brew install` would not
# resolve). ga_cmd_brew_shellenv echoes the `<prefix>/bin/brew shellenv` line; we eval its OUTPUT (the
# env exports), guarded so a missing brew binary is a no-op rather than a set -e abort.
preflight_eval_brew_shellenv() {
  local shellenv_cmd
  shellenv_cmd="$(ga_cmd_brew_shellenv)"
  [[ -n "${shellenv_cmd}" ]] || return 0
  # the command is a brew path we built ourselves (not user input); run it and eval
  # the exported env. command -v guards the prefix's brew actually existing.
  local brew_bin="${shellenv_cmd%% *}"
  [[ -x "${brew_bin}" ]] || return 0
  # shellcheck disable=SC2046  # word-splitting the shellenv exports is intended
  eval "$(${shellenv_cmd} 2>/dev/null || true)"
  return 0
}

# preflight_shell_rc — echo the login-shell rc file to persist PATH lines into. Default ~/.zshrc
# (macOS default since Catalina) when $SHELL is unset/unrecognized. Echo-only so callers grep-guard the append.
preflight_shell_rc() {
  case "${SHELL:-}" in
    */zsh) printf '%s\n' "${HOME}/.zshrc" ;;
    */bash) printf '%s\n' "${HOME}/.bash_profile" ;;
    *) printf '%s\n' "${HOME}/.zshrc" ;;
  esac
}

# preflight_persist_rc_line — append ONE line to the login-shell rc file IF not already present
# (grep -qxF whole-line idempotency). The line MUST be write-time-EXPANDED (never a `$(brew --prefix …)`
# subshell — that re-forks every startup). Best-effort: a non-writable rc is a silent no-op (the
# in-session export covered THIS run; the rc line is a FUTURE-shell convenience, never abort-worthy).
# OWNERSHIP MARKER: the trailing ` # glass-atrium` lets uninstall (remove_rc_lines) remove EXACTLY GA's
# lines; the marker is part of the written line, so the caller passes the bare export + this appends it once.
preflight_persist_rc_line() {
  local line="$1" rc marked
  [[ -n "${line}" ]] || return 0
  marked="${line} # glass-atrium"
  rc="$(preflight_shell_rc)"
  if ! grep -qxF "${marked}" "${rc}" 2>/dev/null; then
    printf '%s\n' "${marked}" >>"${rc}" 2>/dev/null || true
  fi
  return 0
}

# preflight_path_prepend — put one bin dir on the CURRENT session PATH (idempotent prepend, so a
# same-session `command -v` resolves it) AND persist the matching rc line for FUTURE shells. The rc
# line is write-time-EXPANDED ${dir} + LITERAL runtime $PATH (no subshell — never re-forks). $1 = bin
# dir. Shared by the keg-only and native-installer PATH injects.
preflight_path_prepend() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) ;;
    *) export PATH="${dir}:${PATH}" ;;
  esac
  preflight_persist_rc_line "export PATH=\"${dir}:\$PATH\""
}

# preflight_keg_path_inject — prepend a keg-only brew formula's bin to PATH (current session + rc) via
# preflight_path_prepend. WHY: versioned formulae (node@24, postgresql@N) are keg-only — `brew shellenv`
# does NOT add their bins to PATH, so a fresh `brew install node@24` leaves `node` unresolved this
# session. No-op when the formula/prefix is absent (nvm-node / no-brew-pg untouched). $1 = brew formula.
preflight_keg_path_inject() {
  local formula="$1" prefix
  [[ "$(ga_brew_formula_present "${formula}")" == "yes" ]] || return 0
  prefix="$(brew --prefix "${formula}" 2>/dev/null || true)"
  [[ -n "${prefix}" && -d "${prefix}/bin" ]] || return 0
  preflight_path_prepend "${prefix}/bin"
  return 0
}

# preflight_keg_path_inject_pg — version-agnostic keg-inject of the installed PostgreSQL keg. Resolves
# the HIGHEST installed brew postgresql@N via ga_pg_keg_major (brew-keg-first, NOT the psql-client-first
# ga_pg_installed_major — a stale lower-major psql on PATH must not pick the wrong keg), defaulting to
# the fresh-install pin @18 when none resolves (the post-consent brew batch just added postgresql@18 but
# its keg-only psql is not yet on PATH). A present-but-down PG14 injects @14, a fresh @18 injects @18; the single-major node@24 keg stays literal.
preflight_keg_path_inject_pg() {
  local major
  major="$(ga_pg_keg_major)"
  [[ -z "${major}" ]] && major="18"
  preflight_keg_path_inject "postgresql@${major}"
}

# preflight_pg_utc_guard — intercept a FOREIGN/BROKEN postgres squatting the peer-auth socket BEFORE
# the service/role steps (and the monitor) trust it. ga_detect_postgres=='present' is satisfied by a
# bare SELECT 1, but an orphaned postmaster from a deleted keg (lost tzdata) ANSWERS SELECT 1 yet
# REJECTS `SET timezone='UTC'` (pg 22023) — and the monitor's UTC-gated pool then FATALs the 30s
# bootstrap health gate. Discriminate via ga_detect_postgres_utc:
#   * not 'broken' (ok / down / absent) → clean, nothing to do (return 0).
#   * 'broken' + a brew-managed keg present → RESTART the resolved keg + re-verify (self-heal; a plain
#     start is a no-op on an already-running broken server, hence restart).
#   * 'broken' + NO brew keg (an UNMANAGED orphan of a deleted keg) → LOUD-FAIL with concrete
#     remediation + non-zero — NEVER silently proceed into the downstream 30s FATAL.
# Runs after the keg-inject (psql on PATH), in BOTH preflight paths. Returns 0 on a clean/healed socket,
# non-zero on an unrecoverable squatter (the caller bails like the other steps).
preflight_pg_utc_guard() {
  [[ "$(ga_detect_postgres_utc)" == "broken" ]] || return 0
  preflight_line "$(c "${C_ALERT}" "[warn]") a postgres on ${PG_SOCKET}/.s.PGSQL.5432 answers but REJECTS SET timezone='UTC' (broken/foreign server)."
  if [[ -n "$(ga_pg_keg_major)" ]]; then
    preflight_line "$(c "${C_DIM}" "[info]") brew-managed keg present — restarting the target service to clear the broken state."
    preflight_run_cmd "postgres: restart UTC-rejecting server" "$(ga_cmd_pg_service_restart)" || true
    ga_pg_wait_ready || true
    if [[ "$(ga_detect_postgres_utc)" != "broken" ]]; then
      preflight_line "$(c "${C_OK}" "[ok]") postgres now accepts SET timezone='UTC' — continuing."
      return 0
    fi
  fi
  # unmanaged orphan, OR a brew restart that did not clear it → attempt an install-scoped clear (SIGINT
  # + stale-socket removal), then re-verify. A freshly-cleared socket reads 'down' not 'ok', so the
  # success check is `!= broken` (mirrors the restart re-verify above), NEVER `== ok` — else a cleared
  # orphan falls to loud-fail. A DRY_RUN/sandbox clear is a no-op, so the orphan stays 'broken' and correctly reaches the loud-fail (never a false 'cleared').
  preflight_line "$(c "${C_DIM}" "[info]") no brew-managed keg (or restart did not clear it) — clearing the unmanaged orphan on the socket."
  clear_unmanaged_pg_orphan
  if [[ "$(ga_detect_postgres_utc)" != "broken" ]]; then
    preflight_line "$(c "${C_OK}" "[ok]") the unmanaged orphan was cleared (:5432 socket freed) — continuing."
    return 0
  fi
  # the clear did not free the socket (unfreeable, OR skipped under DRY_RUN/sandbox) → loud-fail.
  preflight_line "$(c "${C_ALERT}" "[fail]") a foreign/broken postgres owns ${PG_SOCKET}/.s.PGSQL.5432 and rejects SET timezone='UTC' —"
  preflight_line "        it could not be cleared automatically. Stop it, then re-run the installer:"
  preflight_line "          1) find it:   lsof ${PG_SOCKET}/.s.PGSQL.5432    (or: lsof -ti tcp:5432)"
  preflight_line "          2) stop it:   kill -INT <pid>    (fast shutdown; likely an orphan of a deleted keg)"
  preflight_line "          3) re-run once :5432 is free."
  preflight_release_tty
  return 1
}

# preflight_run_cmd — run ONE install command STRING (from a ga_cmd_* builder) as a labelled run_step.
# The string is word-split into argv under a local space-IFS (file-wide IFS is $'\n\t'). Returns the
# step's exit code. The command never originates from user input (every ga_cmd_* echoes a fixed,
# harness-authored line). The space-IFS save / word-split / restore-$'\n\t' sequence mirrors run_plan's
# per-step split (same SC2086 disable) — keep the two in sync if the IFS-restore value changes.
preflight_run_cmd() {
  local label="$1" cmd="$2" rc=0
  local IFS=' '
  # shellcheck disable=SC2086  # deliberate word-split of the harness-built command
  run_step "${label}" ${cmd} || rc=$?
  unset IFS
  IFS=$'\n\t'
  return "${rc}"
}

# preflight_run_or_bail — run ONE consented install step and, on failure, release the preflight-owned
# TTY before propagating the EXACT step exit code (rc captured BEFORE the release so the precise install
# exit code survives). The single release-on-failure guard the auto-install steps (Homebrew/brew batch/
# pg/claude CLI) share — each step is `preflight_run_or_bail … || return $?`. Step guards + post-actions stay inline.
preflight_run_or_bail() {
  local rc=0
  preflight_run_cmd "$1" "$2" || rc=$?
  [[ "${rc}" -eq 0 ]] || preflight_release_tty
  return "${rc}"
}

# preflight_run_or_bail_framed — run ONE consented NON-INTERACTIVE install step through the FRAMED
# install-progress render path, then release-on-failure like preflight_run_or_bail (delegated). Framing
# = install RENDER_MODE in run_step: fd 1 AND fd 2 captured into STEP_LOG + classify-folded, a single
# live spinner/label row replacing the raw scrolling flood so a noisy `brew install` / `npm i` does not
# swamp the terminal. RENDER_MODE is FUNCTION-local (bash 3.2 has no block scope, but this wrapper's
# only job IS the framed call), so ONLY this step is framed + it auto-reverts on return. Used for the
# brew batch / pg service+role / claude CLI steps (non-interactive once HOMEBREW_NO_ASK + NONINTERACTIVE
# are exported). DELIBERATELY NOT the Homebrew installer step (D3): its LIVE sudo password prompt
# (ga_homebrew_install) would be swallowed by fd-capture, so it stays on the visible raw path.
preflight_run_or_bail_framed() {
  local RENDER_MODE="install"
  preflight_run_or_bail "$1" "$2"
}

# preflight_bracket — run ONE interactive preflight gate in cooked-mode scrollback, bracketed by an
# alt-screen drop/re-enter (mirrors _confirm_pregate). MENU context only: a gate's preflight_line
# guidance + confirm_typed prompt cannot render inside the dimmed work box, so drop rmcup + restore
# cooked stty, then re-enter smcup + raw on return. Leaves a CLEARED alt-screen — the caller repaints
# the frame (enter_run_state) when a box render follows. $1.. = the gate function + its args. Returns
# the gate's EXACT exit code (set -e off here — run_gate_quiet wrapped the whole preflight).
preflight_bracket() {
  local rc=0
  # SINGLE-ACTIVE-SPINNER + torn-down-frame guard: stop any running idle spinner BEFORE rmcup, so no
  # idle child keeps painting into the alt-screen frame this bracket drops (KEEP-4d flicker-clean). Idempotent no-op when none open.
  stop_idle_spinner
  tp rmcup
  tp cnorm
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=false
  reset_plate_geometry
  "$@" || rc=$?
  # Re-enter the alt-screen + raw mode (a box render or nav resumes next).
  tp smcup
  tp civis
  stty -echo -icanon <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=true
  tp clear
  apply_plate_geometry
  return "${rc}"
}

# preflight_panel_step — render ONE non-interactive preflight command as a panel step inside the
# engaged work box (menu context only). Mirrors the token/monitor/purge panel vocabulary: set the STEP
# scaffolding + ITEM-4 bar, repaint the box body, then run the command as a RENDER_MODE=panel run_step
# (fd1+fd2 captured + suppressed, the spinner owning the box body row). $1 = past/resolved label · $2 =
# present-progressive ACTIVE label (empty → $1) · $3 = command. Returns the EXACT exit code; caller decides bail vs warn.
preflight_panel_step() {
  local resolved="$1" active="$2" cmd="$3" rc=0
  # shared step counter: advance the SHARED counter set up-front by preflight_count_and_gate — each
  # framed box step is step i of the shared N. STEP_TOTAL is fixed for the whole preflight (do NOT reset
  # here). Default STEP_INDEX to 0 when unset so a stray direct call still renders a sane counter.
  STEP_INDEX=$((${STEP_INDEX:-0} + 1))
  # Default STEP_TOTAL to the current index when the count pass never set it (a lone direct call →
  # i/i), then CLAMP i <= N so an imperfect estimate degrades to an N/N tail, never "7/5".
  { [[ "${STEP_TOTAL:-}" =~ ^[0-9]+$ ]] && [[ "${STEP_TOTAL}" -ge 1 ]]; } || STEP_TOTAL="${STEP_INDEX}"
  [[ "${STEP_INDEX}" -gt "${STEP_TOTAL}" ]] && STEP_INDEX="${STEP_TOTAL}"
  STEP_LABEL_ACTIVE_CUR="${active:-${resolved}}"
  STEP_BAR_ACCENT_CUR="${C_ACCENT}" # install = non-destructive → the blue ITEM-4 bar
  STEP_BAR_CUR="$(build_run_bar)"
  draw_workbox # show this step's label + bar in the box body before the (possibly slow) step
  # RENDER_MODE is FUNCTION-local but bash `local` is dynamically scoped, so preflight_run_cmd →
  # run_step both see "panel" and route into the fixed workbox body row (rail-safe inner paint).
  local RENDER_MODE="panel"
  preflight_run_cmd "${resolved}" "${cmd}" || rc=$?
  # shared step counter: clear ONLY the per-step render detail (label/bar), PRESERVING the shared
  # STEP_INDEX/STEP_TOTAL so the NEXT step advances i (not reset to 1/1). Swept once by _run_dependency_preflight_boxed's teardown after the final step.
  STEP_LABEL_ACTIVE_CUR=""
  STEP_BAR_CUR=""
  STEP_BAR_ACCENT_CUR=""
  STEP_SUPPRESS_SPINNER=""
  # The boxed path surfaces NO per-step log (clean UI), so sweep the panel FAIL temp in STEP_LAST_FAIL_LOG
  # rather than leaking it (the passthrough path retains full inline logs for diagnosis). rc stays the sole signal.
  if [[ "${rc}" -ne 0 && -n "${STEP_LAST_FAIL_LOG}" && -f "${STEP_LAST_FAIL_LOG}" ]]; then
    rm -f "${STEP_LAST_FAIL_LOG}"
    STEP_LAST_FAIL_LOG=""
  fi
  return "${rc}"
}

# preflight_panel_step_or_bail — preflight_panel_step + the release-on-failure guard the bailing ENGAGE1
# steps (brew batch / pg service+role / claude CLI) share (panel analogue of preflight_run_or_bail_framed).
# release_tty is a no-op in the menu context (menu owns fd3), kept for symmetry. rc captured BEFORE the release so the precise step exit code survives.
preflight_panel_step_or_bail() {
  local rc=0
  preflight_panel_step "$1" "$2" "$3" || rc=$?
  [[ "${rc}" -eq 0 ]] || preflight_release_tty
  return "${rc}"
}

# preflight_guide_xcode_clt — GUIDE-USER gate (install ORDER step 1). The CLT installer is a GUI dialog
# the user clicks through, so PRINT the trigger command, then POLL ga_detect_xcode_clt until present (a
# hard Homebrew prerequisite). Returns 0 once present, non-zero if the user cancels the poll. No
# mutation here — xcode-select --install opens the OS dialog itself.
preflight_guide_xcode_clt() {
  [[ "$(ga_detect_xcode_clt)" == "present" ]] && return 0

  preflight_line ""
  preflight_line "$(c "${C_ALERT}" "Xcode Command Line Tools are required (and not installed).")"
  preflight_line "$(c "${C_DIM}" "  A macOS dialog will open. Click Install and accept the license.")"
  preflight_line "$(c "${C_STRONG}" "  run:")  $(c "${C_INFO}" "$(ga_cmd_xcode_clt)")"
  preflight_line ""

  # open the OS installer dialog (the only side effect — a user-driven GUI install).
  xcode-select --install >/dev/null 2>&1 || true

  preflight_out "$(c "${C_DIM}" "waiting for the toolchain to appear (press Ctrl-C to abort) …")"
  # poll once per second; ga_detect_xcode_clt is a cheap path-existence check. User-driven wait —
  # intentionally UNBOUNDED (the toolchain install is user-paced; Ctrl-C aborts).
  local last_dot="${SECONDS}"
  while [[ "$(ga_detect_xcode_clt)" != "present" ]]; do
    /bin/sleep 1
    # heartbeat dot every ~5 WALL-CLOCK seconds (SECONDS-delta anchor — a per-iteration counter
    # drifts if a probe stalls).
    if [[ "$((SECONDS - last_dot))" -ge 5 ]]; then
      preflight_out "$(c "${C_DIM}" ".")"
      last_dot="${SECONDS}"
    fi
  done
  preflight_line ""
  preflight_line "$(c "${C_OK}" "[ok]") Xcode Command Line Tools present."
  return 0
}

# preflight_grouped_consent — the SINGLE grouped consent gate (install ORDER steps 2,3,4,5,8).
# Summarizes the EXACT commands the auto-with-consent set will run, then gates the whole batch on ONE
# confirm_typed. $1.. = the human-readable command lines. Returns 0 to proceed, non-zero on decline.
preflight_grouped_consent() {
  preflight_line ""
  preflight_line "$(c "${C_STRONG}" "The following will be installed (one consent for the whole set):")"
  local line
  for line in "$@"; do
    preflight_line "  $(c "${C_INFO}" "•") $(c "${C_DIM}" "${line}")"
  done
  preflight_line ""
  # reuse the existing typed-confirmation helper (cooked-mode echo, exact token).
  confirm_typed "install" "Install the dependencies listed above (system mutation)."
}

# preflight_guide_claude_auth — GUIDE-USER HARD GATE (install ORDER step 6). claude auth cannot be
# automated, so PRINT the login instruction, then loop: re-detect auth, require a typed confirmation to
# proceed only once auth is established. Detection NEVER reads ~/.claude/.credentials.json contents
# (presence-only, ga_detect_claude_auth). Returns 0 once authenticated, non-zero if the user abandons.
# Once interactive auth is established, preflight_provision_headless_token runs so the launchd daemons
# get a keychain-bypassing CLAUDE_CODE_OAUTH_TOKEN.
preflight_guide_claude_auth() {
  if [[ "$(ga_detect_claude_auth)" == "present" ]]; then
    # already interactively authenticated — still ensure the headless credential so
    # the launchd daemons (which CANNOT use the GUI keychain) do not 401 nightly.
    preflight_provision_headless_token
    return 0
  fi

  preflight_line ""
  preflight_line "$(c "${C_ALERT}" "Claude authentication is required before the plugin + harness install.")"
  preflight_line "$(c "${C_STRONG}" "  run:")  $(c "${C_INFO}" "$(ga_cmd_claude_auth_guide)")"
  preflight_line "$(c "${C_DIM}" "  (do this in another shell, then return here)")"
  preflight_line ""

  # confirm-before-proceed loop: re-detect on each typed 'ok'; a non-present verdict
  # re-prompts rather than proceeding (the hard gate).
  while true; do
    if confirm_typed "ok" "Type ok AFTER you have signed in (anything else aborts)."; then
      local verdict
      verdict="$(ga_detect_claude_auth)"
      if [[ "${verdict}" == "present" ]]; then
        preflight_line "$(c "${C_OK}" "[ok]") Claude authentication detected."
        # interactive auth confirmed — now provision the headless launchd credential.
        preflight_provision_headless_token
        return 0
      fi
      # 'present-but-down' is a DISTINCT failure from 'absent': no creds file AND no Keychain item AND
      # claude is not on PATH — the CLI is missing, not the login. Diagnose that specifically so a
      # claude-off-PATH user is not looped on a sign-in message that does not apply to their situation.
      if [[ "${verdict}" == "present-but-down" ]]; then
        preflight_line "$(c "${C_ALERT}" "claude CLI not found on PATH — install Claude Code and/or add it to PATH, then type ok again.")"
      else
        preflight_line "$(c "${C_ALERT}" "still not authenticated — sign in, then type ok again.")"
      fi
    else
      return 1
    fi
  done
}

# ga_render_auth_script / ga_claude_auth_env_lib — resolve the Stage-A scripts from OUR install tree
# (GA_DIR, the SoT checkout being installed) so the gate renders + self-tests against the exact scripts the deploy will symlink.
ga_render_auth_script() { printf '%s\n' "${GA_DIR}/scripts/render-claude-auth.sh"; }

ga_claude_auth_env_lib() { printf '%s\n' "${GA_DIR}/scripts/lib/claude-auth-env.sh"; }

# headless_auth_selftest — source the rendered secrets file (claude_auth_load_env) and run a minimal
# `claude -p` in a keychain-bypassing manner; return 0 iff the CLI answers (rc 0 AND no 401/credential
# signature in its output). This is THE gate signal: a green self-test means the launchd daemons will
# authenticate headlessly. Keychain-bypass: claude_auth_load_env exports CLAUDE_CODE_OAUTH_TOKEN from
# the secrets file; the env credential takes precedence over the keychain OAuth item for a `claude -p`
# call, so a successful probe proves the env path (not the keychain). The probe output is scanned for
# the daemon_cycle.py auth signatures (401/403 / "Invalid authentication credentials" / "Failed to
# authenticate") so a non-zero-masking CLI that still 401s is caught. Output is otherwise DISCARDED
# (never logged) — it could echo the rejected credential. The probe is BOUNDED by run_with_timeout
# (GA_AUTH_SELFTEST_TIMEOUT_SECS, default 30s) so a hung CLI on this menu hot path cannot stall the
# install — a timeout (exit 124) is treated as a self-test failure. Returns 2 when the lib is absent. CLAUDE bin +
# lib resolution honour test-stub overrides (GA_AUTH_CLAUDE_BIN / GA_AUTH_ENV_LIB) so the bats suite can
# drive both the pass and the 401 path without a real credential or `claude` — mirroring WIKI_COMPILE_CLAUDE_BIN.
headless_auth_selftest() {
  local claude_bin env_lib probe_out probe_rc=0
  claude_bin="${GA_AUTH_CLAUDE_BIN:-claude}"
  env_lib="${GA_AUTH_ENV_LIB:-$(ga_claude_auth_env_lib)}"

  if [[ ! -f "${env_lib}" ]]; then
    echo "headless self-test: claude-auth-env lib absent (${env_lib})" >&2
    return 2
  fi

  # Run the source + probe in a SUBSHELL so the exported credential never leaks into the install
  # process environment beyond the probe (set -a side effects contained). The lib's claude_auth_load_env
  # warns + returns 0 when the secrets file is absent, so an unprovisioned machine self-tests against the
  # keychain (and will 401 under launchd) — exactly the state the gate must detect and fix.
  probe_out="$(
    # disable the file-scope ERR trap inside the probe: a non-zero `claude -p` (the
    # 401 case the gate explicitly handles) is an EXPECTED outcome here, not a script
    # error — without this it would emit a misleading "ERROR: line …" stderr line.
    trap - ERR
    # shellcheck source=scripts/lib/claude-auth-env.sh
    . "${env_lib}" 2>/dev/null
    claude_auth_load_env >/dev/null 2>&1 || true
    # BOUNDED probe: this self-test runs on menu hot paths, so the `claude -p` call MUST have a hard
    # ceiling — run_with_timeout (ga-env.sh) kills the whole process group on expiry (exit 124) so a
    # hung CLI (network stall / stuck credential prompt) can never freeze the install. stdin is pinned
    # to /dev/null so the CLI cannot block reading it. exit 124 is non-zero → caught by the probe_rc
    # gate below as a self-test failure (identical handling to the 401 / non-zero-exit case).
    run_with_timeout "${GA_AUTH_SELFTEST_TIMEOUT_SECS:-30}" "${claude_bin}" -p --output-format text "reply with OK" </dev/null 2>&1
  )" || probe_rc=$?

  # probe_rc != 0 covers BOTH a non-zero `claude -p` exit AND a run_with_timeout expiry (exit 124).
  if [[ "${probe_rc}" -ne 0 ]]; then
    return 1
  fi
  # rc 0 but a 401/credential signature in the body → still an auth failure (the CLI can exit 0 while
  # reporting an API error in-band). Match the daemon_cycle.py _HAIKU_AUTH_PATTERNS set (case-insensitive).
  if printf '%s' "${probe_out}" \
    | grep -qiE "${AUTH_FAIL_RE}"; then
    return 1
  fi
  return 0
}

# sanitize_setup_token — extract the bare OAuth value from `claude setup-token`'s TTY-wrapped output
# (ANSI color + trailing CR + guidance lines stripped) so the value clears render-claude-auth.sh's
# control-char guard (exit-7s on any survivor). $1 = the raw captured stream; the clean value to stdout.
# Pipeline (bash 3.2 / BSD-portable — no GNU-only flags):
#   tr -d '\r'                          delete carriage returns
#   strip_csi                           strip CSI escape sequences (shared helper — the SAME stripper
#                                        visible_len uses, so the two cannot drift; value in a var, off-argv)
#   grep -oE -m1 'sk-ant-oat[A-Za-z0-9_-]+' first match by fixed prefix (no `head` pipe → no SIGPIPE)
# FALLBACK (vendor format drift — the grep finds nothing): the last non-empty CLEAN line of the scrubbed stream.
# SECURITY: value stays on stdout of a command substitution captured into a local —
# never argv, never logged.
sanitize_setup_token() {
  local raw="$1" cleaned extracted
  # tr -d removes CR (no value on its argv); strip_csi receives the value as a function
  # arg (a var, not a command line) and strips every CSI run via pure-bash glob math.
  cleaned="$(strip_csi "$(printf '%s' "${raw}" | tr -d '\r')")"
  # `-m1` (BSD/GNU) stops after the first match and exits 0 → no `head` pipe, so no
  # SIGPIPE; `|| true` swallows the no-match exit-1 so pipefail doesn't fire the ERR trap.
  extracted="$(printf '%s\n' "${cleaned}" | { grep -oE -m1 'sk-ant-oat[A-Za-z0-9_-]+' || true; })"
  if [[ -n "${extracted}" ]]; then
    printf '%s\n' "${extracted}"
    return 0
  fi
  # FALLBACK: last non-empty clean line (vendor may have changed the value format).
  printf '%s\n' "${cleaned}" | awk 'NF{last=$0} END{if (last != "") print last}'
}

# _provision_render_selftest — render one headless token VALUE (read from STDIN) into the 0600 secrets
# file, then POST-RENDER self-test it. The value enters render-claude-auth.sh via STDIN, kept off argv
# (never $1 → no `ps` exposure, never echoed/logged); render's own confirmation prints the KEY + redaction,
# never the value. render's value precedence is $1 → CLAUDE_CODE_OAUTH_TOKEN env → stdin, so an inherited
# exported CLAUDE_CODE_OAUTH_TOKEN in the install shell (v2.1.207 `claude setup-token` prints an
# `export CLAUDE_CODE_OAUTH_TOKEN` line) would SHADOW the piped value on the env axis; `env -u
# CLAUDE_CODE_OAUTH_TOKEN` clears that inherited var so STDIN is AUTHORITATIVE — a fresh pasted token
# always wins over a stale exported one. Safe for all three sources: each pipes its RESOLVED value via
# STDIN (Source A reads the env var into a local FIRST, then pipes that), so clearing the inherited env
# loses no source's value. GA_ROOT is passed EXPLICITLY (via env) because it is a readonly SHELL var, not
# exported — without this the child render would fall back to its own ${HOME}/.glass-atrium default,
# diverging from the GA_ROOT-anchored path the daemons' claude_auth_load_env reads (write-path and
# read-path MUST agree on ONE location). SHARED by all three value sources (env / auto-capture / paste)
# so the render+self-test gate cannot drift. Returns:
#   0 — rendered + self-test passes (the success gate)
#   1 — rendered but the self-test still 401s
#   4 — render-claude-auth.sh rejected the value (its own exit 6/7/8 propagated)
_provision_render_selftest() {
  local render_script render_rc=0
  render_script="$(ga_render_auth_script)"
  env -u CLAUDE_CODE_OAUTH_TOKEN GA_ROOT="${GA_ROOT:-${HOME}/.glass-atrium}" "${render_script}" || render_rc=$?
  if [[ "${render_rc}" -ne 0 ]]; then
    preflight_line "$(c "${C_ALERT}" "[warn]") render-claude-auth.sh rejected the value (exit ${render_rc}) — headless auth NOT provisioned."
    return 4
  fi
  # POST-RENDER self-test: confirm the rendered credential actually authenticates a keychain-bypassing
  # `claude -p`. A green result is the gate's success signal.
  if headless_auth_selftest; then
    return 0
  fi
  return 1
}

# _provision_tty_gate_ok — is the launcher's INHERITED stdin+stdout a real terminal? The in-place
# setup-token auto-run inherits fd 0/1 (the kqueue-able pty SLAVES, /dev/ttysNNN) so Bun's node:tty
# WriteStream can kqueue them; the ${TTY} /dev/tty handle (/dev/fd/3|4, a BSD-fdesc dup of
# open("/dev/tty")) throws EINVAL and crashes setup-token. Gate on fd 0 AND fd 1 only — fd 2 is
# DELIBERATELY not tested: in the menu install path it is run_gate_quiet's GATE_QUIET_LOG temp file
# (legitimately non-tty). GA_AUTH_FORCE_TTY is a test seam (the bats harness / a subagent has NO
# controlling terminal): 1 = force pass, 0 = force fail, unset = probe the real fds.
_provision_tty_gate_ok() {
  case "${GA_AUTH_FORCE_TTY:-}" in
    1) return 0 ;;
    0) return 1 ;;
    *) [[ -t 0 && -t 1 ]] ;;
  esac
}

# preflight_provision_headless_token — the AUTH-gate headless-provisioning step. IDEMPOTENT: when the
# secrets file exists AND the self-test passes, SKIP (no re-prompt). Otherwise it acquires a long-lived
# OAuth token from the FIRST source that yields a value passing render + self-test, in order:
#   A) a pre-exported CLAUDE_CODE_OAUTH_TOKEN env var (v2.1.207 `claude setup-token` prints an
#      `export CLAUDE_CODE_OAUTH_TOKEN` line; a user who ran it in THIS shell already has it) —
#      reliable, no capture, no leak;
#   B) OPT-IN legacy `$(claude setup-token)` auto-capture (GA_AUTH_SETUP_TOKEN_AUTOCAPTURE=1) — DEFAULT
#      OFF because command-substitution makes the CLI's stdout a NON-TTY pipe: v2.1.207 then wraps the
#      long token across the 80-col boundary, so sanitize_setup_token's `sk-ant-oat…` grep extracts only
#      a TRUNCATED fragment (renders OK, then 401s — the exact user-reported failure). Retained for older
#      CLIs / CI where the capture is byte-clean; any failure falls through to (C);
#   C) the INTERACTIVE path — AUTO-RUN `claude setup-token` IN PLACE when the launcher's INHERITED fd 0/1
#      are real terminals (the kqueue-able pty SLAVES; the ${TTY} /dev/tty handle crashes Bun's node:tty
#      WriteStream with EINVAL). The child INHERITS fd 0/1 (NO ${TTY} redirect) with stderr merged via
#      2>&1; the launcher NEVER reads that stdout. When the gate is false (passthrough / piped / CI) OR the
#      run exits non-zero, it falls back to a manual paste from `claude setup-token` in another terminal.
#      Either way the value is read SILENTLY off the TTY (no echo → never in the scrollback / transcript),
#      sanitized, piped to render via STDIN — never on argv / a pipe / a log.
# Loud-fails on a real failure (named return codes); non-fatal (a failure WARNs, daemons keep the keychain
# fallback) — the launchd 401 is a daemon-only issue, not an interactive-install blocker. The token value
# never touches argv, is never echoed/logged, and dies with the enclosing local.
# Return codes (all surfaced via stderr/preflight chrome — no silent absorption):
#   0 — provisioned (any source) or already valid (idempotent skip)
#   1 — a value was rendered but the self-test still 401s
#   2 — claude-auth-env lib absent (Stage-A scripts not in the tree)
#   3 — no usable value from ANY source (auto-capture + paste both empty / no TTY to prompt)
#   4 — render-claude-auth.sh rejected the value (its own exit 6/7/8 propagated)
preflight_provision_headless_token() {
  local secrets_file render_script env_val sanitized captured_value pasted tty_mode setup_bin st_rc=0 pv_rc=0
  secrets_file="${GA_ROOT:-${HOME}/.glass-atrium}/secrets/claude-auth.env"
  render_script="$(ga_render_auth_script)"

  preflight_line ""
  preflight_line "$(c "${C_INFO}" "── headless launchd auth (CLAUDE_CODE_OAUTH_TOKEN) ──")"

  # IDEMPOTENT FAST-PATH: present secrets file + passing self-test = daemons already authenticate headlessly.
  if [[ -f "${secrets_file}" ]] && headless_auth_selftest; then
    preflight_line "$(c "${C_OK}" "[ok]") headless auth already provisioned + self-test passes — skipping."
    return 0
  fi

  # Stage-A scripts must be present to render/self-test. Absent → loud WARN (daemons fall back to keychain; install not blocked).
  if [[ ! -f "${render_script}" || ! -f "$(ga_claude_auth_env_lib)" ]]; then
    preflight_line "$(c "${C_ALERT}" "[warn]") headless-auth scripts missing — skipping provisioning (daemons use keychain)."
    return 2
  fi

  preflight_line "$(c "${C_DIM}" "  launchd-spawned 'claude -p' cannot use the GUI keychain (401 nightly).")"

  # ── SOURCE A: a pre-exported CLAUDE_CODE_OAUTH_TOKEN env var (reliable, no capture). ──
  # sanitize defensively (a paste-into-shell may carry CR/CSI); value stays in a local, off argv.
  env_val="${CLAUDE_CODE_OAUTH_TOKEN:-}"
  if [[ -n "${env_val}" ]]; then
    sanitized="$(sanitize_setup_token "${env_val}")"
    if [[ -n "${sanitized}" ]]; then
      preflight_line "$(c "${C_DIM}" "  found an exported CLAUDE_CODE_OAUTH_TOKEN — provisioning from it.")"
      pv_rc=0
      printf '%s\n' "${sanitized}" | _provision_render_selftest || pv_rc=$?
      sanitized=""
      if [[ "${pv_rc}" -eq 0 ]]; then
        preflight_line "$(c "${C_OK}" "[ok]") headless auth provisioned from the exported token + self-test passes."
        return 0
      fi
      # render-reject (4) or rendered-but-401 (1): fall through to the reliable paste path (fresh token).
    fi
  fi

  # ── SOURCE B: OPT-IN legacy `$(claude setup-token)` auto-capture (default OFF — see the header). ──
  # stderr stays attached so browser-approval prompts reach the user; only stdout (the value) is captured
  # into a LOCAL + piped to render via STDIN — never argv, never echoed. Under v2.1.207 the non-TTY
  # capture truncates the token → self-test fails → falls through to the paste path.
  if [[ "${GA_AUTH_SETUP_TOKEN_AUTOCAPTURE:-0}" == "1" ]]; then
    setup_bin="${GA_AUTH_CLAUDE_BIN:-claude}"
    preflight_line "$(c "${C_DIM}" "  running 'claude setup-token' (auto-capture) — approve in the browser, then return here.")"
    st_rc=0
    captured_value="$("${setup_bin}" setup-token)" || st_rc=$?
    if [[ "${st_rc}" -eq 0 ]]; then
      captured_value="$(sanitize_setup_token "${captured_value}")"
      if [[ -n "${captured_value}" ]]; then
        pv_rc=0
        printf '%s\n' "${captured_value}" | _provision_render_selftest || pv_rc=$?
        captured_value=""
        if [[ "${pv_rc}" -eq 0 ]]; then
          preflight_line "$(c "${C_OK}" "[ok]") headless auth provisioned (auto-capture) + self-test passes."
          return 0
        fi
        preflight_line "$(c "${C_DIM}" "  auto-capture produced an invalid token (self-test failed) — falling back to paste.")"
      fi
    fi
    captured_value=""
  fi

  # ── SOURCE C: the INTERACTIVE path — run setup-token in place OR paste an existing token. No
  # controlling TTY → cannot prompt; loud-fail (no value). ──
  if [[ -z "${TTY}" ]]; then
    preflight_line "$(c "${C_ALERT}" "[warn]") no terminal to prompt for a token — headless auth NOT provisioned."
    preflight_line "$(c "${C_DIM}" "  fallback: the daemons use the keychain (may 401 under launchd). Re-run 'glass-atrium install' to retry.")"
    return 3
  fi

  # COOKED mode for the whole interactive segment (optional in-place setup-token → silent paste).
  # Reached from BOTH a cooked caller (menu dispatch) and a RAW one (right after confirm_typed, which
  # leaves the TTY raw): in raw mode Enter delivers CR (not LF), so a default `read` never terminates;
  # TTY_SAVED (the cooked snapshot with icrnl) makes Enter deliver LF. Snapshot the pre-segment mode and
  # restore it after, so a raw-mode caller is left exactly as it was. The alt-screen is ALREADY dropped by
  # every caller (preflight_bracket / the token panel's rmcup pre-gate / the passthrough scroll path), so
  # there is deliberately NO nested rmcup/smcup here — a second drop would re-enter the alt-screen and hide
  # the setup-token output the user must read.
  tty_mode="$(stty -g <"${TTY}" 2>/dev/null || true)"
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true

  preflight_line ""
  preflight_line "$(c "${C_STRONG}" "  Provision the headless token:")"

  # AUTO-RUN (default, no menu): hand the terminal to `claude setup-token` in place. The child MUST inherit
  # fd 0/1 (the launcher's pty SLAVES, /dev/ttysNNN) — the ONLY fds Bun's node:tty WriteStream can kqueue;
  # the ${TTY} /dev/tty handle (/dev/fd/3|4) throws EINVAL and crashes it, so there is deliberately NO
  # `<>"${TTY}"` redirect. Merge stderr into the inherited stdout with `2>&1`: REQUIRED because in the menu
  # path fd 2 is run_gate_quiet's GATE_QUIET_LOG temp file — a bare run (or `2>&2`) would route
  # setup-token's browser-URL/prompt into that HIDDEN log (silent hang) AND leak stderr to a persistent
  # temp file (secret-hygiene risk); `2>&1` keeps it on the VISIBLE pty-slave stdout (kqueue-able, leaking
  # nothing) in BOTH the standalone token panel (fd 2 already a terminal) and the menu path. The launcher
  # NEVER reads that stdout — the value reaches it only via the silent paste-back below, so the token never
  # lands on argv / a pipe / a log. st_rc reset to 0 first (Source-B autocapture fall-through can leave a
  # stale non-zero); the `|| st_rc=$?` LHS suppresses set -e / the ERR trap. NOTE: the real-Bun-binary
  # kqueue SUCCESS path is NOT auto-verifiable in the bats suite (a test harness / subagent has no
  # controlling terminal) — it needs a user real-terminal check; the graceful fallback below guarantees a
  # crash never strands the user.
  if _provision_tty_gate_ok; then
    setup_bin="${GA_AUTH_CLAUDE_BIN:-claude}"
    preflight_line "$(c "${C_DIM}" "  running 'claude setup-token' — approve in the browser, paste the auth code when prompted.")"
    st_rc=0
    "${setup_bin}" setup-token 2>&1 || st_rc=$?
    if [[ "${st_rc}" -ne 0 ]]; then
      # GRACEFUL FALLBACK: a crashed/declined setup-token must never strand the user — drop to the reliable
      # manual paste. The raw stderr stack is deliberately NOT suppressed (that would also hide the
      # success-case token, now merged onto the inherited stdout); a clean line frames the fall-through.
      preflight_line "$(c "${C_ALERT}" "[warn]") 'claude setup-token' did not complete (exit ${st_rc}) — paste a token instead."
    fi
    preflight_line ""
    preflight_line "$(c "${C_STRONG}" "  copy the printed sk-ant-oat… token, paste it below (input hidden), then Enter.")"
  else
    # GATE FALSE (passthrough / piped / CI — fd 0/1 are not terminals, exactly why fd 4 was opened): an
    # in-place setup-token would inherit pipes and re-crash, so route to the reliable manual paste.
    preflight_line "$(c "${C_STRONG}" "  Paste a token (reliable):")"
    preflight_line "$(c "${C_DIM}" "  1) in another terminal run:") $(c "${C_INFO}" "claude setup-token")"
    preflight_line "$(c "${C_DIM}" "  2) approve in the browser + paste the auth code there;")"
    preflight_line "$(c "${C_DIM}" "  3) copy the printed sk-ant-oat… token, paste it below (input hidden), then Enter.")"
  fi
  preflight_out "  $(c "${C_INFO}" "paste token ▸ ")"

  # SILENT read (-s → no echo REGARDLESS of the cooked echo bit, so the secret never reaches the terminal
  # scrollback / install transcript). Re-assert cooked first — an in-place setup-token may have left the
  # TTY in a different mode. `|| true` keeps a value pasted WITHOUT a trailing newline (read returns 1 at
  # EOF but still sets the var) and prevents set -e abort. The value stays in this LOCAL, sanitized, then
  # piped via STDIN below.
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  pasted=""
  IFS= read -rs pasted <"${TTY}" || true
  if [[ -n "${tty_mode}" ]]; then
    stty "${tty_mode}" <"${TTY}" 2>/dev/null || true
  fi
  preflight_line "" # echo was off — move the cursor off the prompt line.

  # Sanitize the paste (strip CR/CSI, extract the bare sk-ant-oat… value) before render's guard sees it.
  pasted="$(sanitize_setup_token "${pasted}")"
  if [[ -z "${pasted}" ]]; then
    preflight_line "$(c "${C_ALERT}" "[warn]") no token pasted — headless auth NOT provisioned."
    preflight_line "$(c "${C_DIM}" "  fallback: the daemons use the keychain (may 401 under launchd). Re-run 'glass-atrium install' to retry.")"
    return 3
  fi

  pv_rc=0
  printf '%s\n' "${pasted}" | _provision_render_selftest || pv_rc=$?
  pasted="" # scrub the local copy ASAP (defence-in-depth; the var dies with the function).
  case "${pv_rc}" in
    0)
      preflight_line "$(c "${C_OK}" "[ok]") headless auth provisioned + self-test passes (launchd daemons will authenticate)."
      return 0
      ;;
    4)
      # _provision_render_selftest already WARNed with render's exit code.
      return 4
      ;;
    *)
      preflight_line "$(c "${C_ALERT}" "[warn]") headless credential rendered but the self-test still failed (401) — daemons may 401 under launchd."
      preflight_line "$(c "${C_DIM}" "  re-run 'glass-atrium install' or paste a fresh 'claude setup-token' value to retry.")"
      return 1
      ;;
  esac
}

# === doctor: headless-auth advisory (non-fatal) ==============================
# Surfaced AFTER run_doctor in the doctor dispatch. ADVISORY-ONLY: never
# mutates the doctor exit code (the launchd-401 is a daemon-only concern, not an
# install-validity FAIL). Three sub-checks, each WARNed independently:
#   1. the 0600 secrets file exists with exactly 0600 perms;
#   2. a keychain-bypassing `claude -p` self-test passes (headless_auth_selftest);
#   3. recent daemon-report JSON under data/daemon-reports show no auth-failure /
#      infra_fault / haiku-exit-1 signature.
# On ANY miss it advises re-running the install auth step / `claude setup-token`.
# Uses log() (stderr) to share the run_doctor output stream. Returns 0 ALWAYS
# (advisory); a separate boolean is logged so the user sees the verdict.
#
# DOCTOR_AUTH_REPORTS_DIR overrides the report dir for the bats suite; the daemon
# CLAUDE bin is stubbable via GA_AUTH_CLAUDE_BIN (shared with headless_auth_selftest).
doctor_headless_auth_advisory() {
  local secrets_file reports_dir advise=0
  secrets_file="${GA_ROOT:-${HOME}/.glass-atrium}/secrets/claude-auth.env"
  reports_dir="${DOCTOR_AUTH_REPORTS_DIR:-${HOME}/.claude/data/daemon-reports}"

  log "  ---- headless launchd auth advisory (non-fatal) ----"

  # 1. secrets file present + exactly 0600.
  if [[ -f "${secrets_file}" ]]; then
    local perms
    perms="$(stat_perms "${secrets_file}" 2>/dev/null || true)"
    if [[ "${perms}" == "600" ]]; then
      log "  ok   : headless secrets file present + 0600 (${secrets_file})"
    else
      log "  warn : headless secrets file perms=${perms:-unknown} (expected 600) — run 'glass-atrium install' to re-render"
      advise=1
    fi
  else
    log "  warn : headless secrets file absent (${secrets_file}) — launchd daemons will 401; run the install auth step / 'claude setup-token'"
    advise=1
  fi

  # 2. keychain-bypassing self-test. Skip when the auth-env lib is absent (rc 2):
  #    a missing Stage-A lib is a deploy gap, not an auth fault — warn distinctly.
  local selftest_rc=0
  headless_auth_selftest || selftest_rc=$?
  case "${selftest_rc}" in
    0) log "  ok   : headless 'claude -p' self-test passes (keychain-bypassing)" ;;
    2) log "  warn : headless self-test skipped — claude-auth-env lib absent (deploy gap)" ;;
    *)
      log "  warn : headless 'claude -p' self-test FAILED (401/credential) — run the install auth step / 'claude setup-token'"
      advise=1
      ;;
  esac

  # 3. recent daemon-report scan for auth-failure / infra_fault / haiku-exit-1.
  #    Look at the newest few report JSON (mtime-sorted) for the failure signatures
  #    daemon_cycle.py emits. A hit means a real nightly auth outage was recorded.
  if [[ -d "${reports_dir}" ]]; then
    local hit=0 latest report_count=0 sorted
    # mtime-newest-first; bash 3.2 has no mapfile — iterate the find stream. -print0
    # is avoided (no readarray); a plain newline stream is fine (report names have
    # no newlines). Limit the scan to the newest 5 to keep doctor fast.
    #
    # Materialize the sorted list into a var, then iterate it via a here-string —
    # a `done < <(… | cut -f2-)` process sub keeps cut writing live, so an early break
    # (a signature match / the >5 limit) closes the read end mid-write → cut dies on
    # SIGPIPE (141) → pipefail fires the file-scope ERR trap ("ERROR: line …: cut -f2-").
    # A fully drained command sub has no live writer to signal; `|| true` preserves the
    # process-sub form's already-ignored pipeline status (empty → the ok/no-history path).
    sorted="$(find "${reports_dir}" -maxdepth 1 -type f -name '*.json' 2>/dev/null \
      | while IFS= read -r f; do
        printf '%s\t%s\n' "$(stat_mtime "${f}" 2>/dev/null || printf '0')" "${f}"
      done | sort -rn | cut -f2-)" || true
    while IFS= read -r latest; do
      [[ -n "${latest}" ]] || continue
      report_count=$((report_count + 1))
      [[ "${report_count}" -gt 5 ]] && break
      # grep the JSON for the auth/infra/haiku-exit signatures. The daemon writes
      # "error":"haiku non-zero exit 1", parse_mode "auth-failure", explicit_state
      # "infra_fault", or a raw 401/credential string into the report body.
      if grep -qiE "\"(parse_mode|explicit_state)\": *\"(auth-failure|infra_fault)\"|haiku non-zero exit 1|skipped:auth|${AUTH_FAIL_RE}" "${latest}" 2>/dev/null; then
        hit=1
        break
      fi
    done <<<"${sorted}"
    if [[ "${hit}" -eq 1 ]]; then
      log "  warn : a recent daemon report shows an auth-failure / infra_fault / haiku-exit-1 — run the install auth step / 'claude setup-token'"
      advise=1
    else
      log "  ok   : recent daemon reports show no auth-failure / infra_fault pattern"
    fi
  else
    log "  note : daemon-reports dir absent (${reports_dir}) — no nightly history to scan yet"
  fi

  if [[ "${advise}" -eq 1 ]]; then
    log "  ---- ACTION: re-run 'glass-atrium install' (auth gate) or 'claude setup-token' to provision the headless token ----"
  fi
  return 0
}

# preflight_install_fakechat — AUTO-NO-CONSENT (install ORDER step 7), post-auth.
# The marketplace-add is a PREREQUISITE: an unauthenticated / marketplace-absent
# claude cannot resolve the plugin, so we add the official marketplace FIRST (only
# when absent), THEN install the plugin. Skipped entirely when fakechat is already
# present. Returns the install step's exit code.
preflight_install_fakechat() {
  [[ "$(ga_detect_fakechat)" == "present" ]] && return 0

  local rc=0
  # prerequisite: register the official marketplace when it is not yet present.
  if [[ "$(ga_marketplace_present)" == "no" ]]; then
    preflight_run_cmd "fakechat: add official marketplace" "$(ga_cmd_marketplace_add)" || rc=$?
    [[ "${rc}" -eq 0 ]] || return "${rc}"
  fi
  preflight_run_cmd "fakechat: install plugin" "$(ga_cmd_fakechat_install)" || rc=$?
  return "${rc}"
}

# _preflight_fakechat_boxed — MENU render of preflight_install_fakechat: the marketplace-add
# prerequisite + the plugin install as 1/1 panel steps in the work box. Same detect guards +
# builders as the scroll variant; ONLY the render target moves into the box. G7: the marketplace-add
# carries a DISTINCT present-progressive label flagging the ~30s git clone (verified to COMPLETE, not
# hang — a purely UX cue) so the box does not read as stalled. Returns the failing step's rc (the
# caller treats a non-zero as non-fatal, mirroring the scroll path's warn-and-continue).
_preflight_fakechat_boxed() {
  [[ "$(ga_detect_fakechat)" == "present" ]] && return 0
  local rc=0
  if [[ "$(ga_marketplace_present)" == "no" ]]; then
    preflight_panel_step "fakechat: add official marketplace" \
      "adding marketplace (git clone, may take a minute)…" "$(ga_cmd_marketplace_add)" || rc=$?
    [[ "${rc}" -eq 0 ]] || return "${rc}"
  fi
  preflight_panel_step "fakechat: install plugin" "" "$(ga_cmd_fakechat_install)" || rc=$?
  return "${rc}"
}

# preflight_install_python_libs — AUTO-WITH-CONSENT (install ORDER step 8), PEP-668
# aware. PRIMARY: pip install --user the missing set. On an externally-managed
# (PEP-668) failure, AUTO-retry with --break-system-packages (no second typed gate):
# the grouped consent already covered installing the python libs, and the retry is
# `pip install --user --break-system-packages` — USER site-packages, not system, the
# low-risk PEP-668 escape hatch — so the override auto-proceeds, logged VISIBLY (a
# system-policy override, no longer a blocking prompt). requirements.txt is the package
# SoT; the command builders target only the genuinely-missing subset for a fast re-run.
# Returns 0 on success; on a retry FAILURE it returns that rc so the caller warns and
# continues (non-fatal — a manual install path exists).
preflight_install_python_libs() {
  [[ "$(ga_detect_python_libs)" == "present" ]] && return 0

  local user_cmd rc=0
  user_cmd="$(ga_cmd_python_libs_user)"
  [[ -n "${user_cmd}" ]] || return 0
  preflight_run_cmd "python libs (pip --user)" "${user_cmd}" || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    return 0
  fi

  # the --user line failed — the common cause on a modern python3 is the PEP-668
  # externally-managed marker. AUTO-retry with the override (no typed gate): the user
  # already consented to the python-libs install, and --break-system-packages here still
  # targets USER site-packages. Log the override visibly so the user SEES it was used.
  preflight_line ""
  preflight_line "$(c "${C_ALERT}" "pip --user failed (likely PEP-668 externally-managed-environment) — auto-retrying with --break-system-packages.")"
  local break_cmd
  break_cmd="$(ga_cmd_python_libs_break_system)"
  rc=0
  preflight_run_cmd "python libs (--break-system-packages)" "${break_cmd}" || rc=$?
  return "${rc}"
}

# _preflight_python_libs_boxed — MENU render of preflight_install_python_libs: the pip --user attempt
# stays FRAMED as a 1/1 panel step (G3), and ONLY on its PEP-668 failure the --break-system-packages
# retry AUTO-runs as another framed panel step — no alt-screen bracket, no typed consent. The grouped
# consent already covered the python-libs install and the override targets USER site-packages, so it
# auto-proceeds; the override is surfaced VISIBLY via the retry step's ACTIVE label (the panel frame
# stays intact — no bracket to clear, hence no enter_run_state re-engage). Same builders + detect
# guards as the scroll variant. Returns 0 on success; on a retry FAILURE it returns that rc so the
# caller warns and continues (non-fatal).
_preflight_python_libs_boxed() {
  [[ "$(ga_detect_python_libs)" == "present" ]] && return 0
  local user_cmd rc=0
  user_cmd="$(ga_cmd_python_libs_user)"
  [[ -n "${user_cmd}" ]] || return 0
  preflight_panel_step "python libs (pip --user)" "" "${user_cmd}" || rc=$?
  [[ "${rc}" -eq 0 ]] && return 0
  # --user failed (likely PEP-668) → AUTO-retry with the override as a framed panel step. The ACTIVE
  # label documents the override so the user SEES --break-system-packages was used (visible, not a
  # blocking prompt). No alt-screen bracket, so the panel frame is never torn down + needs no repaint.
  local break_cmd
  break_cmd="$(ga_cmd_python_libs_break_system)"
  rc=0
  preflight_panel_step "python libs (--break-system-packages)" \
    "pip --user failed (PEP-668) — auto-retrying with --break-system-packages…" \
    "${break_cmd}" || rc=$?
  return "${rc}"
}

preflight_build_summary() {
  PREFLIGHT_SUMMARY=""
  local cmd

  # (2) Homebrew — a human-readable label, NOT the bare ga_homebrew_install function
  # token the builder now emits (meaningless in the consent / missing-set print), mirroring
  # the claude CLI line below.
  [[ "$(ga_detect_homebrew)" == "absent" ]] \
    && PREFLIGHT_SUMMARY="${PREFLIGHT_SUMMARY}Homebrew (official curl|bash installer)"$'\n'
  # (3) brew batch — only when the missing-set is non-empty.
  cmd="$(ga_cmd_brew_batch)"
  [[ -n "${cmd}" ]] && PREFLIGHT_SUMMARY="${PREFLIGHT_SUMMARY}${cmd}"$'\n'
  # (4) postgres service + role.
  # one-shot postgres VERSION advisory (EOL/upgrade note). WHY here: its module-global
  # once-guard only persists from a DIRECT main-shell call — ga_detect_postgres runs in
  # $(...) subshells where the guard cannot dedupe, so the side-effect was relocated to
  # this display layer. stderr-only (no PREFLIGHT_SUMMARY line); self-guards on psql
  # presence + major, so safe to call unconditionally.
  ga_warn_postgres_version
  [[ "$(ga_detect_postgres)" == "present-but-down" ]] \
    && PREFLIGHT_SUMMARY="${PREFLIGHT_SUMMARY}$(ga_cmd_pg_service_start)"$'\n'
  [[ "$(ga_detect_postgres_role)" == "absent" ]] \
    && PREFLIGHT_SUMMARY="${PREFLIGHT_SUMMARY}$(ga_cmd_pg_create_role)"$'\n'
  # (5) claude CLI — a human-readable label, NOT the bare ga_claude_install function
  # token the builder emits (meaningless in the consent / missing-set print).
  [[ "$(ga_detect_claude_cli)" == "absent" ]] \
    && PREFLIGHT_SUMMARY="${PREFLIGHT_SUMMARY}claude CLI (native installer, npm fallback)"$'\n'
  # (8) python libs
  cmd="$(ga_cmd_python_libs_user)"
  [[ -n "${cmd}" ]] && PREFLIGHT_SUMMARY="${PREFLIGHT_SUMMARY}${cmd}"$'\n'
  # explicit success: a trailing false `[[ ]] &&` would otherwise leak non-zero as the
  # return, tripping the caller's set -e.
  return 0
}

# preflight_has_auto_work — 'yes' when preflight_build_summary produced any line
# (an auto-installable dep is missing), else 'no'. The grouped-consent + auto-run
# block fires only on 'yes'; the GUIDE gates (Xcode CLT, claude auth) + fakechat
# are evaluated independently of this (they are not part of the consent set).
preflight_has_auto_work() {
  [[ -n "${PREFLIGHT_SUMMARY}" ]] && printf 'yes\n' || printf 'no\n'
}

# preflight_all_present — 'yes' when EVERY tracked dependency is already present
# (the fast provisioned-machine no-op signal): no auto-work AND both GUIDE gates
# satisfied AND fakechat present. 'no' when any dep needs attention. Drives the
# silent-continue path in run_dependency_preflight.
preflight_all_present() {
  [[ -n "${PREFLIGHT_SUMMARY}" ]] && {
    printf 'no\n'
    return 0
  }
  [[ "$(ga_detect_xcode_clt)" == "present" ]] || {
    printf 'no\n'
    return 0
  }
  [[ "$(ga_detect_claude_auth)" == "present" ]] || {
    printf 'no\n'
    return 0
  }
  [[ "$(ga_detect_fakechat)" == "present" ]] || {
    printf 'no\n'
    return 0
  }
  printf 'yes\n'
}

# run_dependency_preflight — the orchestrator. ALWAYS-ON, runs FIRST in bootstrap.
# Returns 0 to let bootstrap proceed; a non-zero return aborts the caller (the
# passthrough exits PREFLIGHT_EXIT_BLOCKED, the menu renders the failure). Detect ->
# no-op when fully provisioned -> else drive the consent/guide flow in install order.
run_dependency_preflight() {
  preflight_build_summary

  # FAST NO-OP — fully provisioned machine: log + continue silently. Uses the
  # engine log() (stderr) not the TTY chrome: the no-op path runs with no TTY
  # acquired yet, and an informational "all present" line belongs in the log
  # stream (consistent with the engine's own == … == progress logs).
  if [[ "$(preflight_all_present)" == "yes" ]]; then
    log "== dependency preflight: all dependencies present — continuing =="
    return 0
  fi

  # something needs attention — acquire a TTY for the prompts.
  preflight_ensure_tty

  # NON-INTERACTIVE with missing deps: cannot consent — loud-fail (no silent
  # absorption of an unmet entry condition; Precondition Loud-Fail principle).
  if [[ "${PREFLIGHT_NONINTERACTIVE}" == "true" ]]; then
    printf 'FATAL: dependency preflight needs to install/guide missing dependencies,\n' >&2
    printf '       but no controlling terminal is available to confirm consent.\n' >&2
    printf '       run %s from an interactive terminal.\n' "'./glass-atrium bootstrap'" >&2
    if [[ -n "${PREFLIGHT_SUMMARY}" ]]; then
      printf '       missing auto-installable set:\n' >&2
      printf '%s' "${PREFLIGHT_SUMMARY}" | while IFS= read -r line; do
        [[ -n "${line}" ]] && printf '         - %s\n' "${line}" >&2
      done
    fi
    return 1
  fi

  # DUAL CALL-CONTEXT dispatch (REQUIRED): the work-box render (enter_run_state / draw_workbox /
  # paint_workbox_body_inner) needs the interactive-menu frame + plate geometry, which exist ONLY in
  # the menu context — dispatch_action_install_panel runs apply_plate_geometry THEN
  # `run_gate_quiet run_dependency_preflight` with PREFLIGHT_TTY_OWNED=false + TTY=fd3. The
  # passthrough/CLI context (direct call at the `bootstrap` subcommand, PREFLIGHT_TTY_OWNED=true +
  # TTY=fd4) has NO menu frame + NO plate geometry, so it MUST retain the scrolling
  # preflight_line/preflight_run_cmd path — painting into a never-drawn frame would corrupt output.
  # Discriminate on the menu's own non-owned fd3.
  if [[ "${PREFLIGHT_TTY_OWNED}" == "false" && "${TTY}" == "/dev/fd/3" ]]; then
    _run_dependency_preflight_boxed
  else
    _run_dependency_preflight_scroll
  fi
}

# _run_dependency_preflight_scroll — the PASSTHROUGH/CLI render path: the historical scrolling
# preflight (preflight_line chrome + preflight_run_cmd single-line / preflight_run_or_bail_framed
# install steps), byte-for-byte the pre-restructure body. Reached when no interactive-menu frame
# exists (fd4, preflight-owned TTY). All release_tty calls are live here (this path DOES own fd4).
_run_dependency_preflight_scroll() {
  preflight_line ""
  preflight_line "$(c "${C_INFO}" "── dependency preflight (bare-Mac bootstrap) ──")"

  # (1) Xcode CLT — GUIDE-USER gate, FIRST (a Homebrew prerequisite). Polls until
  # present; abort if the user cancels.
  if ! preflight_guide_xcode_clt; then
    preflight_line "$(c "${C_ALERT}" "[fail]") Xcode CLT gate not satisfied — aborting preflight."
    preflight_release_tty
    return 1
  fi

  # (2-5,8) the auto-with-consent set, behind ONE grouped consent. The GUIDE gates
  # (CLT above, auth below) + fakechat are NOT in the consent set.
  if [[ "$(preflight_has_auto_work)" == "yes" ]]; then
    # build the display list from the summary (newline -> argv).
    local consent_lines=() sline
    while IFS= read -r sline; do
      [[ -n "${sline}" ]] && consent_lines+=("${sline}")
    done <<EOF
${PREFLIGHT_SUMMARY}
EOF
    if ! preflight_grouped_consent "${consent_lines[@]}"; then
      preflight_line "$(c "${C_DIM}" "consent declined — dependency install cancelled.")"
      preflight_release_tty
      return 1
    fi

    # NON-INTERACTIVE env for the consented auto-install batch — consent was ALREADY
    # granted by the grouped gate above, so suppressing per-command prompts here is
    # correct, not a bypass. Scope: bash 3.2 `local` is FUNCTION-scoped (not block-scoped),
    # so this reaches every child from here to the end of run_dependency_preflight (the
    # brew/pg/claude steps AND the later fakechat/python steps) and AUTO-UNSETS on return —
    # no leak into bootstrap/monitor. WHY each var:
    #   HOMEBREW_NO_ASK=1     opts OUT of Homebrew 6.x DEFAULT ASK MODE — the `brew install`
    #     [Y/n] that HANGS against the raw-mode TUI (the menu holds the terminal in raw mode,
    #     so the user's `y` never reaches brew's cooked-mode read). `man brew` (6.0.6):
    #     "HOMEBREW_NO_ASK: If set, do not enable default ask mode." It governs EVERY brew
    #     child in the batch — `brew install`, `brew services start`, the `brew --prefix`
    #     keg probes — so the env is preferred over a per-line `brew install --no-ask` flag.
    #   NONINTERACTIVE=1      drops the Homebrew + claude curl|sh installers' RETURN pause and
    #     governs their sudo path. It does NOT suppress ask mode (verified absent from the
    #     `man brew` ask-mode governors), hence it is NOT sufficient alone — HOMEBREW_NO_ASK
    #     is the one that silences the batch [Y/n].
    #   HOMEBREW_NO_ENV_HINTS=1  silences post-install env hints (noise only).
    local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1 HOMEBREW_NO_ENV_HINTS=1

    # (2) Homebrew — install, then eval shellenv so the new brew is on PATH.
    if [[ "$(ga_detect_homebrew)" == "absent" ]]; then
      preflight_run_or_bail "Homebrew install" "$(ga_cmd_homebrew_install)" || return $?
      preflight_eval_brew_shellenv
    fi

    # (3) brew batch — single grouped `brew install` of only the missing formulae.
    local brew_cmd
    brew_cmd="$(ga_cmd_brew_batch)"
    if [[ -n "${brew_cmd}" ]]; then
      preflight_run_or_bail_framed "brew batch (missing formulae)" "${brew_cmd}" || return $?
    fi

    # (A1) keg-only PATH inject — MUST run BEFORE the postgres detect: keg-only formulae
    # are off PATH after `brew install`, so without this a fresh postgresql@18 leaves bare
    # `command -v psql` unresolved → ga_detect_postgres returns 'absent' → the service-
    # start branch below never fires. Each call self-guards on formula presence.
    preflight_keg_path_inject node@24
    # hash -r after the node keg PATH inject: drop the shell command-hash cache so a JUST-brewed node@24 npm resolves in-process
    # (a stale `hash` entry for npm/node from before the keg inject would otherwise mask the new bin).
    hash -r
    preflight_keg_path_inject_pg

    # (A2) foreign/broken postgres guard — a squatter that ANSWERS SELECT 1 but REJECTS
    # SET timezone='UTC' (an orphaned postmaster from a deleted keg, lost tzdata) passes
    # ga_detect_postgres=='present' and would be silently trusted, only to FATAL the
    # monitor's UTC-gated pool 30s later. Intercept it here (self-heal a brew-managed keg,
    # loud-fail an unmanaged orphan). Runs after keg-inject so psql is on PATH.
    preflight_pg_utc_guard || return $?

    # (A3) initialize an UNINITIALIZED cluster data dir — `brew install postgresql@N` can
    # pour the binaries but FAIL its post_install data-dir init ("unknown install step:
    # init_data_dir" on older Homebrew), leaving no PG_VERSION and no server for the
    # service-start below to boot. Fall back to a manual initdb. IDEMPOTENT (skipped when
    # PG_VERSION already exists → never re-initdb over live data) and no-op on a non-brew
    # cluster. Like the readiness wait, this is an UNCOUNTED extra step the shared-counter
    # clamp absorbs (an over-count would stick the bar at N-1/N; an under-count degrades to
    # an N/N tail — so initdb is deliberately not added to preflight_count_and_gate).
    if [[ "$(ga_pg_data_dir_initialized)" == "no" ]]; then
      preflight_run_or_bail_framed "postgres: initialize data dir" "$(ga_cmd_pg_initdb)" || return $?
    fi

    # (4) PostgreSQL service + peer-auth role.
    if [[ "$(ga_detect_postgres)" == "present-but-down" ]]; then
      preflight_run_or_bail_framed "postgres: start service" "$(ga_cmd_pg_service_start)" || return $?
      # readiness wait — `brew services start` returns BEFORE the postmaster accepts connections;
      # gate the role detect + the downstream setup_database on a bounded (~15s) live-server poll
      # so neither races a not-yet-ready cluster (a race → false present-but-down → the role step
      # is silently skipped). A timeout bails loudly via the framed FAIL row. Runs ONLY on the
      # start path (a purely 'present' cluster never enters this branch, so never waits).
      preflight_run_or_bail_framed "postgres: wait until ready" "ga_pg_wait_ready" || return $?
    fi
    # role gate is `!= present` (evaluated AFTER the readiness wait): a residual present-but-down
    # (server slow to answer) as well as a genuine absent both trigger the create. ga_pg_ensure_role
    # is idempotent (\gexec NOT-EXISTS guard + ON_ERROR_STOP=1), so a re-run over an existing role is
    # a safe no-op and a truly-down server fails loudly rather than being silently skipped.
    if [[ "$(ga_detect_postgres_role)" != "present" ]]; then
      preflight_run_or_bail_framed "postgres: create superuser role" "$(ga_cmd_pg_create_role)" || return $?
    fi

    # (5) claude CLI — native installer FIRST (curl|sh -> ~/.local/bin/claude), npm -g
    # fallback (node@24 from the brew batch above, so npm exists by now). The builder
    # emits the ga_claude_install token; run_step calls it in-process.
    if [[ "$(ga_detect_claude_cli)" == "absent" ]]; then
      preflight_run_or_bail_framed "claude CLI (native installer, npm fallback)" "$(ga_cmd_claude_cli_install)" || return $?
    fi

    # commit the framed sequence's final row. install RENDER_MODE reuses ONE physical
    # progress row and leaves the last resolved step in place with NO trailing newline (so
    # successive framed steps overwrite it, matching the main-install one-row UX); emit ONE
    # newline so the following GUIDE/auth output starts on a clean line instead of
    # overwriting that row. On the failure path the framed step already committed a
    # permanent FAIL line + returned, so this is reached only after an all-pass batch.
    [[ -n "${TTY}" ]] && printf '\n' >"${TTY}"
  fi

  # (C2) native-installer claude PATH inject — the native installer drops the binary at
  # ~/.local/bin/claude, NOT on a stock session PATH. The downstream auth hard-gate +
  # fakechat use a BARE `command -v claude`, so MUST prepend ~/.local/bin to this session
  # PATH BEFORE that gate. Runs OUTSIDE the auto-work block so it also covers a prior
  # native install. Guarded: only when the binary exists + not already on PATH (an
  # npm-global claude is untouched).
  if [[ -x "${HOME}/.local/bin/claude" ]]; then
    preflight_path_prepend "${HOME}/.local/bin"
  fi

  # (6) claude AUTH — GUIDE-USER HARD GATE, after the CLI is installed.
  if ! preflight_guide_claude_auth; then
    preflight_line "$(c "${C_ALERT}" "[fail]") claude auth gate not satisfied — aborting preflight."
    preflight_release_tty
    return 1
  fi

  # (7) fakechat — AUTO-NO-CONSENT, post-auth (marketplace-add prereq THEN install).
  if ! preflight_install_fakechat; then
    preflight_line "$(c "${C_ALERT}" "[warn]") fakechat install did not complete — continuing (non-fatal)."
  fi

  # (8) python libs — AUTO-WITH-CONSENT (covered by the grouped consent), PEP-668
  # fallback behind its own consent. A skip here is non-fatal (manual path exists).
  if [[ "$(ga_detect_python_libs)" != "present" ]]; then
    if ! preflight_install_python_libs; then
      preflight_line "$(c "${C_ALERT}" "[warn]") python libs not installed — continuing (install manually)."
    fi
  fi

  preflight_line ""
  preflight_line "$(c "${C_OK}" "[ok]") dependency preflight complete — continuing to bootstrap."
  preflight_release_tty
  return 0
}

# preflight_count_and_gate — shared step counter fix: evaluate EVERY framed box step's will-run predicate ONCE,
# up-front, and publish (1) a SHARED STEP_TOTAL the panel renderers consume and (2) the two
# per-group runnable counts the enter_run_state engages gate on (blank work-box skip-empty). COUNTED are
# ONLY the seven framed box steps — brew-batch, pg-service, pg-role, claude-CLI,
# fakechat-marketplace, fakechat-plugin, python-libs. NOT counted: Homebrew (an off-box
# cooked-sudo bracket) and the Xcode CLT / grouped consent / claude auth gates (brackets, not
# panel steps).
#
# COUNT-DRIFT: the pg + fakechat steps run DOWNSTREAM of installs that happen inside this same
# preflight, so their live detects are STALE up-front. We predict the post-install state:
#   * pg-service / pg-role — postgresql@18 in the brew MISSING-SET means a fresh cluster WILL be
#     installed, so BOTH the service-start and the role-create WILL run. (A cold bare-Mac reads
#     ga_detect_postgres=='absent' up-front — psql is still inside the brew batch — so the live
#     verdict would wrongly zero these.) WARM fallback (pg already installed, not in the
#     missing-set): the live ga_detect_postgres=='present-but-down' / ga_detect_postgres_role==
#     'absent' verdicts.
#   * fakechat — claude CLI absent up-front means it WILL be installed in ENGAGE1, so the
#     marketplace-add + plugin-install both WILL run once claude lands; a pre-claude
#     'present-but-down' fakechat verdict must NOT zero them. Claude already present => the live
#     fakechat / marketplace verdicts are authoritative.
# All predicates naturally collapse to 0 when there is no auto-work, so GROUP1 mirrors the
# `preflight_has_auto_work == yes` gate without re-testing it.
preflight_count_and_gate() {
  local g1=0 g2=0 missing_set claude_absent="no"
  missing_set="$(ga_brew_missing_set)"

  # --- ENGAGE1 group: brew batch + postgres service/role + claude CLI ---
  # (3) brew batch runs when ANY formula is missing (ga_cmd_brew_batch is non-empty).
  [[ -n "${missing_set}" ]] && g1=$((g1 + 1))
  # (4) postgres: missing-set-derived on a fresh cluster (service + role BOTH run), else the
  # warm live-down / role-absent fallback. Substring match is safe — no other formula name
  # contains 'postgresql@18'.
  if [[ "${missing_set}" == *"postgresql@18"* ]]; then
    g1=$((g1 + 2))
  else
    [[ "$(ga_detect_postgres)" == "present-but-down" ]] && g1=$((g1 + 1))
    [[ "$(ga_detect_postgres_role)" == "absent" ]] && g1=$((g1 + 1))
  fi
  # (5) claude CLI installs when absent (also the fakechat will-run driver below).
  [[ "$(ga_detect_claude_cli)" == "absent" ]] && claude_absent="yes"
  [[ "${claude_absent}" == "yes" ]] && g1=$((g1 + 1))

  # --- ENGAGE2 group: fakechat marketplace + plugin, python libs ---
  # (7) fakechat: claude-absent-up-front => both steps WILL run once claude lands; else the live
  # fakechat/marketplace verdicts decide (fakechat present => neither runs; else plugin runs and
  # the marketplace-add rides along only when the marketplace is not yet registered).
  if [[ "${claude_absent}" == "yes" ]]; then
    g2=$((g2 + 2))
  elif [[ "$(ga_detect_fakechat)" != "present" ]]; then
    g2=$((g2 + 1))
    [[ "$(ga_marketplace_present)" == "no" ]] && g2=$((g2 + 1))
  fi
  # (8) python libs run whenever the aggregate set is not fully present.
  [[ "$(ga_detect_python_libs)" != "present" ]] && g2=$((g2 + 1))

  PREFLIGHT_GROUP1_RUNNABLE="${g1}"
  PREFLIGHT_GROUP2_RUNNABLE="${g2}"
  # SHARED counter: fix the total ONCE; preflight_panel_step then advances a shared STEP_INDEX
  # and CLAMPS it to this total, so an imperfect estimate degrades to an N/N tail (never "7/5").
  # Leave STEP_INDEX empty until the first framed step increments it (no 0/N pre-flash).
  STEP_TOTAL=$((g1 + g2))
  STEP_INDEX=""
  # frozen unified step counter: freeze the ONE grand total = the (g1+g2) preflight steps + the fixed 14-step install plan,
  # so preflight AND install render the SAME denominator (no 6->19 jump). GLOBAL (no `local`) so it
  # propagates through run_gate_quiet's brace group into dispatch's install run_action_panel.
  GRAND_TOTAL=$((g1 + g2 + INSTALL_PLAN_LEN))
  return 0
}

# _run_dependency_preflight_boxed — the MENU render path: the SAME install-order flow, but the
# INTERACTIVE gates (Xcode CLT, grouped consent, claude auth/token, python --break) drop to a
# cooked-scrollback alt-screen bracket (preflight_bracket, mirroring _confirm_pregate), and the two
# contiguous NON-interactive install groups render INSIDE the work box as 1/1 panel steps
# (enter_run_state + STEP scaffolding + RENDER_MODE=panel run_step, mirroring
# dispatch_action_uninstall_panel), engaged TWICE around the auth gate. The Homebrew installer is the
# ONE unframed, off-workbox step: its LIVE sudo password prompt needs a cooked TTY (a panel
# fd-capture would swallow it — the D3 rationale), so it runs in its own bracket. Each bracket return
# leaves a CLEARED alt-screen, so the next box render is preceded by an enter_run_state repaint [G5].
# preflight_release_tty is a no-op here (the menu owns fd3), so it is omitted; a declined/aborted gate
# returns non-zero and dispatch_action_install_panel renders the concise abort (full step logs live on
# the passthrough path). Detect verdicts + command builders are byte-for-byte the scroll path's — ONLY
# the render target (box vs scroll) + the prompt bracket differ. set -e is off (run_gate_quiet wrap).
_run_dependency_preflight_boxed() {
  local rc=0

  # step-counter grand-total: count every framed box step's will-run predicate ONCE, up-front (before ANY install
  # mutates live detect state), publishing the shared STEP_TOTAL + the two per-group runnable
  # counts. Must run before ENGAGE1 so both enter_run_state engages can gate on their group.
  preflight_count_and_gate

  # (1) Xcode CLT — GUIDE gate, bracketed (guidance + poll need cooked scrollback). Skip the
  # rmcup/smcup flicker when the toolchain is already present (a common partial-provision case).
  if [[ "$(ga_detect_xcode_clt)" != "present" ]]; then
    preflight_bracket preflight_guide_xcode_clt || return 1
  fi

  # (2-5,8) the auto-with-consent set, behind ONE grouped consent bracket. The GUIDE gates
  # (CLT above, auth below) + fakechat are NOT in the consent set.
  if [[ "$(preflight_has_auto_work)" == "yes" ]]; then
    # build the display list from the summary (newline -> argv), same as the scroll path.
    local consent_lines=() sline
    while IFS= read -r sline; do
      [[ -n "${sline}" ]] && consent_lines+=("${sline}")
    done <<EOF
${PREFLIGHT_SUMMARY}
EOF
    preflight_bracket preflight_grouped_consent "${consent_lines[@]}" || return 1

    # consent granted → suppress per-command prompts for the batch (function-scoped, auto-unset).
    # Same three env vars + rationale as the scroll path (HOMEBREW_NO_ASK silences the brew [Y/n]).
    local -x NONINTERACTIVE=1 HOMEBREW_NO_ASK=1 HOMEBREW_NO_ENV_HINTS=1

    # (2) Homebrew — UNFRAMED, in its OWN bracket: the curl|sh installer has a LIVE sudo password
    # prompt a panel fd-capture would swallow (the D3 rationale), so it runs off the work box in
    # cooked scrollback. eval shellenv after so the new brew is on PATH for the batch below.
    if [[ "$(ga_detect_homebrew)" == "absent" ]]; then
      preflight_bracket preflight_run_or_bail "Homebrew install" "$(ga_cmd_homebrew_install)" || rc=$?
      [[ "${rc}" -eq 0 ]] || return "${rc}"
      preflight_eval_brew_shellenv
    fi

    # ENGAGE1 — dim the menu + show the work box for the framed non-interactive group. Placed AFTER
    # the Homebrew bracket so this repaints the full frame the bracket left cleared [G5]. blank work-box hang fix: gate
    # on GROUP1's runnable count so an all-present group (every ENGAGE1 predicate already satisfied)
    # never flashes an empty dimmed work box for seconds — skip the engage entirely when nothing runs.
    [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -gt 0 ]] && enter_run_state

    # (3) brew batch — single grouped `brew install` of only the missing formulae, framed panel step.
    local brew_cmd
    brew_cmd="$(ga_cmd_brew_batch)"
    if [[ -n "${brew_cmd}" ]]; then
      preflight_panel_step_or_bail "brew batch (missing formulae)" "" "${brew_cmd}" || return $?
    fi

    # A/W4 (async feel): the keg-inject + pg_utc_guard cluster runs between framed panel steps with
    # the previous step resolved to a STATIC frame — and pg_utc_guard does a real psql connect that
    # can stall on a slow cluster. Animate it with an idle spinner. blank work-box hang fix: the frame re-engage is now
    # CONDITIONAL on the EXACT INVERSE of ENGAGE1's gate — re-engage ONLY when ENGAGE1 was skipped
    # (GROUP1 empty), i.e. the grouped-consent bracket left the frame cleared and nothing re-composed
    # it. When ENGAGE1 FIRED the frame is already composed + intact through the brew batch panel step,
    # so a re-engage here would be a gratuitous full-frame repaint (the blank work-box hang symptom). The start_idle
    # body animation stays UNCONDITIONAL (always needed). rc captured BEFORE stop_idle (exit-code
    # preservation); idle stopped BEFORE the bail so no stray child paints past the return.
    [[ "${PREFLIGHT_GROUP1_RUNNABLE}" -le 0 ]] && enter_run_state
    # RC-1: publish the step bar BEFORE the spinner fork (the subshell snapshots STEP_BAR_CUR) so the
    # idle animation carries the i/N bar and stop_idle_spinner restores it. Seed STEP_INDEX to 0 ONLY
    # when empty (brew batch skipped => no prior panel step set it); a real mid-cluster index is kept.
    STEP_INDEX="${STEP_INDEX:-0}"
    STEP_BAR_CUR="$(build_run_bar)"
    start_idle_spinner "Resolving PostgreSQL"
    # (A1) keg-only PATH inject BEFORE the postgres detect (identical rationale to the scroll path).
    preflight_keg_path_inject node@24
    hash -r # re-resolve a just-brewed node@24 npm in-process after the keg PATH inject (clear stale command hash)
    preflight_keg_path_inject_pg

    # (A2) foreign/broken postgres guard — identical rationale to the scroll path: intercept a
    # squatter that answers SELECT 1 but rejects SET timezone='UTC' before the service/role
    # steps (and the monitor) trust it. preflight_pg_utc_guard prints its own loud-fail chrome,
    # so it is called directly (not as a framed panel step) and bails on non-zero.
    local pg_guard_rc=0
    preflight_pg_utc_guard || pg_guard_rc=$?
    stop_idle_spinner
    [[ "${pg_guard_rc}" -eq 0 ]] || return "${pg_guard_rc}"

    # (A3) initialize an UNINITIALIZED cluster data dir (identical rationale to the scroll path) —
    # the "@18 install 중단" data-dir fallback. UNCOUNTED extra step (clamp-absorbed), gated on the
    # PG_VERSION marker so a re-run / non-brew cluster is a no-op.
    if [[ "$(ga_pg_data_dir_initialized)" == "no" ]]; then
      preflight_panel_step_or_bail "postgres: initialize data dir" "" "$(ga_cmd_pg_initdb)" || return $?
    fi

    # (4) PostgreSQL service + peer-auth role — framed panel steps.
    # per-detect idle-spinner bracket: capture each detect verdict inside its OWN idle bracket so the timeout-bounded (~2s) connect never flashes a blank box body.
    # PER-DETECT, not one pair spanning the cluster — the framed panel steps below self-paint the same body row + would fight a cluster-wide idle child.
    # Separated declare/assign keeps the exit code clean (SC2155).
    local pg_verdict
    # RC-1: refresh the step bar before the fork (seed STEP_INDEX only when empty).
    STEP_INDEX="${STEP_INDEX:-0}"
    STEP_BAR_CUR="$(build_run_bar)"
    start_idle_spinner "Resolving PostgreSQL"
    pg_verdict="$(ga_detect_postgres)"
    stop_idle_spinner
    if [[ "${pg_verdict}" == "present-but-down" ]]; then
      preflight_panel_step_or_bail "postgres: start service" "" "$(ga_cmd_pg_service_start)" || return $?
      # readiness wait (see the scroll path for the full rationale) — bounded ~15s live-server poll
      # so the role detect + downstream setup_database never race a not-yet-ready cluster. Timeout
      # bails loudly. Runs ONLY on the start path (a purely 'present' cluster never waits).
      preflight_panel_step_or_bail "postgres: wait until ready" "" "ga_pg_wait_ready" || return $?
    fi
    # role gate is `!= present` post-readiness (see the scroll path for the full rationale) —
    # idempotent create covers both a residual present-but-down and a genuine absent.
    local pg_role_verdict
    # RC-1: refresh the step bar before the fork (seed STEP_INDEX only when empty).
    STEP_INDEX="${STEP_INDEX:-0}"
    STEP_BAR_CUR="$(build_run_bar)"
    start_idle_spinner "Resolving PostgreSQL"
    pg_role_verdict="$(ga_detect_postgres_role)"
    stop_idle_spinner
    if [[ "${pg_role_verdict}" != "present" ]]; then
      preflight_panel_step_or_bail "postgres: create superuser role" "" "$(ga_cmd_pg_create_role)" || return $?
    fi

    # (5) claude CLI — native installer FIRST, npm fallback — framed panel step.
    if [[ "$(ga_detect_claude_cli)" == "absent" ]]; then
      preflight_panel_step_or_bail "claude CLI (native installer, npm fallback)" "" "$(ga_cmd_claude_cli_install)" || return $?
    fi
  fi

  # (C2) native-installer claude PATH inject — before the auth gate's bare `command -v claude`.
  # Runs OUTSIDE the auto-work block so it also covers a prior native install (same as scroll).
  if [[ -x "${HOME}/.local/bin/claude" ]]; then
    preflight_path_prepend "${HOME}/.local/bin"
  fi

  # (6) claude AUTH — GUIDE HARD GATE, bracketed (login guidance + `claude setup-token` OAuth both
  # need a cooked TTY). Skip the bracket ONLY when auth is ALREADY present AND the headless token is
  # already provisioned (token_already_provisioned — the same fast-path the Token panel uses): then
  # preflight_guide_claude_auth would be a no-op, so the rmcup/smcup flicker is avoided.
  if [[ "$(ga_detect_claude_auth)" == "present" ]] && token_already_provisioned; then
    : # already authenticated + headless token provisioned — no interactive gate needed.
  else
    preflight_bracket preflight_guide_claude_auth || return 1
  fi

  # ENGAGE2 — fakechat + python libs (post-auth, NON-fatal), framed in the work box. enter_run_state
  # re-establishes the frame the auth bracket left cleared [G5]. blank work-box hang fix: gate on GROUP2's runnable count
  # so a fully-provisioned tail (fakechat present + python libs present) no longer shows a dimmed empty
  # frame for seconds before dispatch's install run — skip the engage entirely when nothing runs.
  [[ "${PREFLIGHT_GROUP2_RUNNABLE}" -gt 0 ]] && enter_run_state
  # (7) fakechat — AUTO-NO-CONSENT (marketplace-add prereq THEN plugin install). Non-fatal: a failure
  # is warn-and-continue in the scroll path, so here it just leaves its last box frame and proceeds.
  _preflight_fakechat_boxed || true
  # (8) python libs — AUTO-WITH-CONSENT (--user framed; --break consent bracketed). Also non-fatal.
  if [[ "$(ga_detect_python_libs)" != "present" ]]; then
    _preflight_python_libs_boxed || true
  fi
  # 4a: CARRY the preflight FINAL clamped STEP_INDEX (the real preflight step count, post-clamp) into
  # the opt-in STEP_INDEX_BASE render offset BEFORE clearing the counter, so dispatch's install run_plan
  # continues the SAME grand sequence (base+1 .. base+n) with NO reset/blink at the handoff. STEP_INDEX
  # is "" when no framed step ran (all-present tail) => base 0 => install shows 1/n..n/n (correct: zero
  # preflight steps). This function is EXCLUSIVE to the install-panel path (run_dependency_preflight
  # routes here only for PREFLIGHT_TTY_OWNED=false + TTY=/dev/fd/3), so the base is confined to it, and
  # run_gate_quiet wraps this call in a brace group (NOT a subshell) so the assignment propagates to
  # dispatch_action_install_panel + its later run_action_panel/run_plan. run_plan's end-of-plan
  # _clear_step_state then sweeps the base (see _clear_step_state), so no later shared caller inherits it.
  STEP_INDEX_BASE="${STEP_INDEX:-0}"
  # shared step counter fix: sweep the shared counter (STEP_INDEX/STEP_TOTAL) + the per-step render detail so no stale i/N
  # or label/bar leaks into dispatch's install run_plan (which re-seeds STEP_INDEX/STEP_TOTAL fresh 1..n).
  # This is the _clear_step_state reset block MINUS STEP_INDEX_BASE and GRAND_TOTAL (BOTH deliberately
  # PRESERVED — they are the carried render offset + the frozen grand denominator the install render
  # consumes, not stale values). Adding GRAND_TOTAL here would make install fall back to base+STEP_TOTAL
  # (=19) and reintroduce the 6->19 jump — mirror STEP_INDEX_BASE exactly (swept in _clear_step_state,
  # preserved at this handoff).
  STEP_INDEX=""
  STEP_TOTAL=""
  STEP_LABEL_ACTIVE_CUR=""
  STEP_BAR_CUR=""
  STEP_BAR_ACCENT_CUR=""
  return 0
}
