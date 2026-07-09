# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2310,SC2312  # SC2154: reads shared globals (MENU_*/STEP_*/GRAND_TOTAL/STEP_INDEX*/action + panel state declared + assigned by the glass-atrium loader; SC2034: assigns shared dispatch/menu-state globals read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2310: `fn || status=$?` is the intended exit-capture idiom (mirrors the loader's file-wide SC2310 disable); SC2312: gate/panel helpers are deliberately invoked inside command substitutions or conditionals (the masked return carries the intended signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — dispatch + menu-loop module, SOURCED by the entry point (never
# executed): shebang, strict mode, IFS and traps stay loader-owned so re-sourcing never
# re-arms them. Owns the typed-confirmation prompt, the action dispatcher + per-panel handlers
# (token/monitor/uninstall/install), the quiet gate runner + pre/post-gate + abort/surface
# helpers, the inline dispatch path, the interactive menu loop and the run_action_panel bridge.
# run_gate_quiet runs its gate through a brace group (never a subshell) so the gate's
# counter/state mutations propagate to the parent.
# run_action_panel — drive ONE run_plan-backed action inside the alt-screen work-area box.
# $1=action · $2=plan title · $3=accent SGR. run_plan is always mode "panel" so RENDER_MODE=panel
# gates the classify + renderers into the fixed workbox body row (the engine-mode fd-merge signal
# rides run_step's panel arm). Enters the run state (dim menu + run body), runs the steps,
# transitions to the done state, waits for a key, returns to nav. Engine path + exit codes are
# byte-for-byte unchanged — ONLY the render target moved to the workbox body row.
run_action_panel() {
  local action="$1" title="$2" accent="$3" status=0
  # A1 blank work-box hang fix: run_action_panel no longer self-engages — the CALLER owns the
  # single frame-composing enter_run_state at the cleared-frame boundary (install: post-preflight;
  # uninstall: post-"remove"-pregate). The frame is already composed here (interim monitor gates
  # paint body-only), so this HANDOFF is BODY-ONLY — a gratuitous full-frame repaint IS the hang symptom.
  # A/W3: hold the idle animator across build_step_plan (pure array assembly = a static frame before
  # run_plan's first spinner); stop it just before run_plan (whose first run_step also stops it).
  start_idle_spinner "Preparing steps"
  build_step_plan "${action}"
  stop_idle_spinner
  # frozen step counter: snapshot the frozen grand total + carried base BEFORE run_plan's teardown
  # (_clear_step_state) sweeps them, so the done line's "failed at step N/T" stays on the SAME grand
  # scale as the running bar (install panel only). Empty for every shared caller (uninstall/db/token/
  # purge never set GRAND_TOTAL) => the N/T below is byte-for-byte the raw plan length, unchanged.
  local grand_total="${GRAND_TOTAL:-}" grand_base="${STEP_INDEX_BASE:-0}"
  run_plan "${title}" "${accent}" "panel" || status=$?
  # idx/total for the done line: STEP_FN holds the plan length; run_plan sets
  # STEP_FAIL_INDEX to the 1-based failing step on failure (default to total on success).
  local total_steps="${#STEP_FN[@]}"
  local fail_idx="${STEP_FAIL_INDEX:-${total_steps}}"
  # unified step counter: on the install-panel handoff, offset the failing-step index onto the grand sequence
  # (base+fail_idx / GRAND_TOTAL) so the done line matches the bar. No-op when GRAND_TOTAL is empty.
  if [[ -n "${grand_total}" ]]; then
    total_steps="${grand_total}"
    fail_idx=$((grand_base + fail_idx))
  fi
  status_line "${status}" "${title}" "${fail_idx}" "${total_steps}"
  IFS= read -rsn1 _ <"${TTY}" || true
  enter_nav_state
  return "${status}"
}

# confirmation prompt — destructive actions require the exact typed token (case-sensitive,
# read from /dev/tty) to proceed. Returns 0 to proceed.
confirm_typed() {
  local token="$1" prompt="$2" reply
  tty_line ""
  tty_line "$(c "${C_ALERT}" "⚠  ${prompt}")"
  tty_out "   type $(c "${C_ALERT}" "${token}") to proceed (anything else cancels): "
  # Temporarily restore cooked mode so the typed token echoes and edits normally.
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  IFS= read -r reply <"${TTY}" || reply=""
  stty -echo -icanon <"${TTY}" 2>/dev/null || true
  [[ "${reply}" == "${token}" ]]
}

# action dispatch — UNIFORM box model: every non-quit action renders its STATUS in the SAME
# work-area box (concise done line / digest). Install / Uninstall STAY in the alt-screen via
# run_action_panel (their interactive PRE-gates — install's dependency preflight + monitor stop,
# uninstall's typed confirms — run before the box opens). Token Setup also frames its OAuth flow
# in the box; the ONE unavoidable cooked-mode segment (`claude setup-token` browser-approval —
# the CLI owns the TTY for the URL + paste-back, uncapturable) runs as a minimal pre-gate. Each
# returns the action's exit status (0 on cancel).
dispatch_action() {
  local action="$1"
  case "${action}" in
    install)
      dispatch_action_install_panel
      return $?
      ;;
    uninstall)
      dispatch_action_uninstall_panel
      return $?
      ;;
    token-setup)
      dispatch_action_token_panel
      return $?
      ;;
    monitor)
      dispatch_action_monitor_panel
      return $?
      ;;
    *)
      # the internal unknown-action fallback: the inline scrolling view.
      dispatch_action_inline "${action}"
      return $?
      ;;
  esac
}

# token_already_provisioned — BUG C skip-probe: detect the already-provisioned state WITHOUT
# any TTY interaction or alt-screen drop. Mirrors preflight_provision_headless_token's IDEMPOTENT
# FAST-PATH gate BYTE-FOR-BYTE (`-f secrets_file` AND a passing headless_auth_selftest) so the two
# cannot drift. `-f` is a pure file test; headless_auth_selftest runs a one-shot `claude -p` probe
# in a SUBSHELL (no prompt/paste) — neither needs a cooked TTY; its lib-absent stderr is suppressed
# (nothing must scribble the alt-screen frame). SECURITY: reads no token value — the probe only
# checks file presence + an auth verdict.
token_already_provisioned() {
  local secrets_file
  secrets_file="${GA_ROOT:-${HOME}/.glass-atrium}/secrets/claude-auth.env"
  [[ -f "${secrets_file}" ]] && headless_auth_selftest 2>/dev/null
}

dispatch_action_token_panel() {
  local status=0
  # 1) RUN state: dim the menu + show the box body. A single-step full bar marks the one
  #    provisioning unit.
  STEP_INDEX=1
  STEP_TOTAL=1
  STEP_LABEL_ACTIVE_CUR="Opening browser for OAuth approval…"
  STEP_BAR_ACCENT_CUR="${C_ACCENT}"
  STEP_BAR_CUR="$(build_run_bar)"
  enter_run_state # full-frame redraw: dim menu + run body (draws the box with the label + bar)

  # BUG C skip fast-path: the COMMON already-provisioned case needs NO interactive input, so it
  # stays FULLY in the alt-screen workbox (never drop the UI). token_already_provisioned detects
  # it, then the TOKEN_SUMMARY done-arm renders the digest with NO rmcup/smcup. Only the
  # first-time path (secrets absent OR failing self-test) drops the alt-screen for the live OAuth.
  if token_already_provisioned; then
    _clear_step_state
    parse_token_summary 0 # rc 0 = provisioned / idempotent skip
    # Refine the in-box wording to the SKIP outcome (no re-provision happened); env-var NAME only.
    TOKEN_SUMMARY="$(c "${C_OK}" "${G_OK}") $(c "${C_STRONG}" "already provisioned") $(c "${C_DIM}" "${G_DOT} self-test ok")"
    status_line 0 "Token Setup" "1" "1"
    IFS= read -rsn1 _ <"${TTY}" || true
    enter_nav_state
    return 0
  fi

  # 2) Cooked-mode PRE-GATE (first-time path only): the unavoidable `claude setup-token` segment.
  #    Drop the alt-screen + restore cooked stty (the CLI needs a live cooked TTY for the URL +
  #    paste), then run the UNCHANGED provisioning and re-enter the box (mirrors _confirm_pregate).
  #    Reached ONLY when the skip-probe was false (secrets absent OR self-test 401); the token
  #    VALUE never surfaces here.
  tp rmcup
  tp cnorm
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=false
  reset_plate_geometry
  # ONE point-of-need raw cue next to the setup-token URL (the framed pre-cue + done-digest
  # already bracket this segment).
  # SECURITY: env-var NAME only — the OAuth token value is never printed here.
  tty_line "$(c "${C_DIM}" "approve in your browser, then return here (env-var CLAUDE_CODE_OAUTH_TOKEN only — never the token value)")"
  # preflight_provision_headless_token UNCHANGED: runs `claude setup-token`, renders the 0600
  # secrets file, self-tests. Its return code drives the box digest — a non-zero is a rendered
  # status, never a launcher crash.
  preflight_provision_headless_token || status=$?

  # Re-enter the alt-screen + raw mode for the box done-state.
  tp smcup
  tp civis
  stty -echo -icanon <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=true
  tp clear
  apply_plate_geometry

  # 3) DONE state: compose the OAuth-outcome digest from the return code, transition to the done
  #    box body. status_line carries the title for workbox_body_str's Token-Setup done-arm.
  _clear_step_state
  parse_token_summary "${status}"
  status_line "${status}" "Token Setup" "1" "1"
  IFS= read -rsn1 _ <"${TTY}" || true
  enter_nav_state
  # A provisioning warn (non-zero) is a rendered status (the daemons keep the keychain fallback),
  # never a launcher error — force 0 so the menu loop never treats it as a crash.
  return 0
}

# dispatch_action_monitor_panel — the Monitor shortcut: single-step, fully in-box, NON-interactive.
# INSTALL-GATED first: monitor plist absent (not installed) → the "available after Install" cue,
# NO run flash, NO browser open. When installed, the single-step open flow then `open`s the
# dashboard (xdg-open fallback off-macOS). Returns 0 always — a non-zero open is a rendered status,
# never a launcher crash. Reads NO secret — only the localhost URL.
dispatch_action_monitor_panel() {
  # Dashboard URL via atrium_monitor_port (ADR-1), never a literal. A resolver failure masks to ''
  # (this panel ALWAYS returns 0) — the open then no-ops into a rendered non-zero status.
  local port
  port="$(atrium_monitor_port 2>/dev/null || true)"
  local url="http://127.0.0.1:${port}" status=0
  # panel hygiene: clear any prior action's persisted fail-log path so the done row never
  # inherits a stale `log:` pointer (mirrors _panel_abort).
  STEP_FAIL_LOG_PERSISTED=""
  # INSTALL GATE — before any run flash. Not installed → straight to the gated done cue.
  if ! monitor_install_present; then
    _clear_step_state
    parse_monitor_summary 2 "${url}"
    status_line 0 "Monitor" "1" "1"
    IFS= read -rsn1 _ <"${TTY}" || true
    enter_nav_state
    return 0
  fi
  # Installed → single-step open flow (ITEM 4 bar vocabulary, C_ACCENT accent).
  STEP_INDEX=1
  STEP_TOTAL=1
  STEP_LABEL_ACTIVE_CUR="Opening monitor in your browser…"
  STEP_BAR_ACCENT_CUR="${C_ACCENT}"
  STEP_BAR_CUR="$(build_run_bar)"
  enter_run_state
  if command -v open >/dev/null 2>&1; then
    open "${url}" >/dev/null 2>&1 || status=1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${url}" >/dev/null 2>&1 || status=1
  else
    status=1
  fi
  _clear_step_state
  parse_monitor_summary "${status}" "${url}"
  status_line 0 "Monitor" "1" "1"
  IFS= read -rsn1 _ <"${TTY}" || true
  enter_nav_state
  return 0
}

# dispatch_action_uninstall_panel — Uninstall through the work-area box. The destructive typed
# confirmations run as cooked-mode PRE-gates (the box cannot host a visible typed prompt),
# mirroring install's preflight pattern. The REAL uninstall engine logic (remove_manifest_links /
# sweep_orphans / unwire_hooks / drop_databases / remove_node_modules / purge_config) + its exit
# codes are byte-for-byte unchanged — ONLY the progress render moves into the box. A cancelled
# confirm returns 0.
dispatch_action_uninstall_panel() {
  local status=0
  # PRE-gate: the "remove" typed confirm in cooked mode. _confirm_pregate handles the
  # rmcup/smcup + stty toggle.
  if ! _confirm_pregate "remove" "Uninstall: removes GA symlinks/hooks, DROPS the glass_atrium + shadow DBs (pre-drop pg_dump backup kept in ~/.claude/backups/postgres), and deletes monitor/node_modules."; then
    # Cancelled: a brief done line, then back to nav.
    status_line 0 "Uninstall cancelled" 0 0
    IFS= read -rsn1 _ <"${TTY}" || true
    enter_nav_state
    return 0
  fi
  # A1 blank work-box hang fix: the "remove" pre-gate's rmcup/smcup+clear leaves the alt-screen
  # CLEARED, so compose the box frame HERE — the single cleared-frame-boundary re-engage for this
  # path — before the body-only run_action_panel handoff (else the box paints over a cleared screen
  # = frameless). run_action_panel no longer self-engages; the caller owns the engage.
  enter_run_state
  # Run the base uninstall plan in the box (VR-8 accent: C_ALERT amber, destructive).
  run_action_panel uninstall "Uninstall" "${C_ALERT}" || status=$?
  # The optional config purge is a SECOND typed confirm pre-gate, then a single box step.
  if _confirm_pregate "purge" "Also move the rendered config.toml to the Trash?"; then
    enter_run_state
    STEP_INDEX=1
    STEP_TOTAL=1
    STEP_LABEL_ACTIVE_CUR="Purging config…"
    STEP_BAR_ACCENT_CUR="${C_ALERT}" # destructive purge → amber filled bar (ITEM 4)
    STEP_BAR_CUR="$(build_run_bar)"   # full bar for the single purge step
    draw_workbox # show the purge step label + bar in the box body before the (fast) step
    PURGE_CONFIG=true
    local RENDER_MODE="panel"
    run_step "Purge config" purge_config || status=$?
    PURGE_CONFIG=false
    _clear_step_state
    status_line "${status}" "Uninstall" "1" "1"
    IFS= read -rsn1 _ <"${TTY}" || true
    enter_nav_state
  fi
  return "${status}"
}

# _confirm_pregate — run ONE confirm_typed prompt in cooked-mode scrollback (a typed confirmation
# cannot render inside the dimmed alt-screen box), then re-enter the alt-screen. Drops rmcup +
# restores cooked stty for the prompt, re-engages smcup + raw on return. Returns confirm_typed's
# verdict (0 = proceed).
_confirm_pregate() {
  local token="$1" prompt="$2" rc=0
  # stop any idle spinner BEFORE rmcup so no idle child paints into the frame this pre-gate drops
  # (idempotent no-op when none is open).
  stop_idle_spinner
  tp rmcup
  tp cnorm
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=false
  reset_plate_geometry
  confirm_typed "${token}" "${prompt}" || rc=$?
  # Re-enter the alt-screen + raw mode (the box runs next, or nav resumes).
  tp smcup
  tp civis
  stty -echo -icanon <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=true
  tp clear
  apply_plate_geometry
  return "${rc}"
}

# _panel_abort — the concise FAIL done-line for an install PRE-gate abort (blocked preflight /
# stuck :16145): status_line transitions to the done state + full-frame redraws (REDRAW_MODEL),
# wiping any preflight scrollback on its own (no pre-clear needed). No scrolling detail reaches the box.
_panel_abort() {
  STEP_FAIL_LOG_PERSISTED=""
  status_line "$1" "Install" "0" "0"
  IFS= read -rsn1 _ <"${TTY}" || true
  enter_nav_state
}

# run_gate_quiet — run ONE install-panel gate with fd 2 routed to the GATE_QUIET_LOG capture file
# instead of the terminal. WHY: the panel's PRE/POST gates (dependency preflight, launchd/orphan
# monitor stop, monitor restore) run OUTSIDE run_step + OUTSIDE the ${TTY} chrome sink, so their
# engine log() stderr paints directly onto the alt-screen — a leak that ALSO scrolls it, corrupting
# the next menu/nav frame. The wrap keeps the alt-screen clean WHILE PRESERVING the lines for
# loud-fail: a non-zero gate rc surfaces the captured tail. The file is APPENDED across gates
# (one log holds the whole pre-gate sequence; cleanup() sweeps it). Returns the gate's EXACT exit
# code (set -e off via `|| rc=$?` so a return 1 propagates, not an ERR-trap abort). CLI/passthrough
# skips the wrap — it calls the gates directly, so their stderr stays loud on that non-TUI path.
run_gate_quiet() {
  local rc=0
  [[ -n "${GATE_QUIET_LOG}" ]] || GATE_QUIET_LOG="$(mktemp "${TMPDIR:-/tmp}/ga-gate.XXXXXX")"
  set +e
  trap - ERR
  { "$@" 2>>"${GATE_QUIET_LOG}"; }
  rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  return "${rc}"
}

# dispatch_action_install_panel — the clean install run, STAYS in the alt-screen + raw mode: the
# menu dims in place, run_plan output routes into the fixed panel, a SUCCESS/FAIL status line pins
# to the bottom. The engine path (dependency preflight, monitor stop/restore, the install steps,
# exit codes) is byte-for-byte the same — ONLY the rendering changes. The PRE/POST gates run via
# run_gate_quiet so their engine log() stderr never scribbles/scrolls the alt-screen; the lines
# stay captured for loud-fail.
dispatch_action_install_panel() {
  local status=0 grc=0
  apply_plate_geometry # keep the centered-column plate width for the dimmed menu + panel
  # The dependency preflight + launchd-monitor stop are interactive PRE-gates: a silent no-op on a
  # provisioned machine; on a bare machine they own ${TTY} directly for prompts (unaffected by
  # run_gate_quiet, which only redirects fd 2 = the engine log() stream). Run them BEFORE the panel.
  # A/W1: dim the menu + show the ANIMATED box IMMEDIATELY on Install-select, so the dependency
  # detection + preflight_count_and_gate window (the silent gap before the first framed step) never
  # shows a frozen static menu. The boxed preflight's brackets stop this idle when they take over.
  # rc is captured BEFORE stop_idle (kill/wait/tput would clobber $?); the idle is stopped BEFORE any
  # abort redraw so no stray idle child paints into _panel_abort's recomposed frame.
  enter_run_state
  start_idle_spinner "Detecting dependencies"
  run_gate_quiet run_dependency_preflight || grc=$?
  stop_idle_spinner
  if [[ "${grc}" -ne 0 ]]; then
    # _panel_abort's status_line full-frame redraws (REDRAW_MODEL), wiping the preflight scrollback
    # on its own. The captured gate log surfaces the failure detail (loud-fail preserved).
    _gate_surface_on_fail
    _panel_abort "${PREFLIGHT_EXIT_BLOCKED}"
    return "${PREFLIGHT_EXIT_BLOCKED}"
  fi
  # A/W2: animate the launchd-monitor stop gate (it polls the daemon's death ~1-2s). A1 blank
  # work-box hang fix: THE SINGLE guaranteed re-engage at the preflight->monitor cleared-frame
  # boundary — run_dependency_preflight may return with the alt-screen cleared, so compose the frame
  # ONCE here; every downstream idle window then paints BODY-ONLY on this intact frame (no further
  # full-frame repaints). rc captured BEFORE stop_idle; idle stopped BEFORE abort.
  grc=0
  enter_run_state
  start_idle_spinner "Freeing monitor port"
  run_gate_quiet stop_launchd_monitor_for_install || grc=$?
  stop_idle_spinner
  if [[ "${grc}" -ne 0 ]]; then
    # IMP2: a launchd-owned monitor still holds :16145 — abort cleanly (stop_* already restored +
    # logged the remediation; the box surfaces the concise done line, the remediation goes to stderr).
    _gate_surface_on_fail
    _panel_abort "${PREFLIGHT_EXIT_BLOCKED}"
    return "${PREFLIGHT_EXIT_BLOCKED}"
  fi
  # CHANGE 3: AFTER the launchd-owned stop, sweep a NON-launchd orphan on :16145 (a stray `node`
  # from a crashed install / manual dev run). The launchd stop cleared a managed monitor, so
  # anything still listening is a true orphan that would make bootstrap_health_gate die on its
  # stale-instance precondition. Ordering: launchd stop FIRST (so monitor_is_launchd_owned is false
  # by the orphan probe), orphan sweep SECOND; a stuck orphan aborts cleanly (same panel path).
  # A/W2 (cont.): same idle-animated wrap, but BODY-ONLY — the post-preflight enter_run_state above
  # composed the frame and the launchd gate painted only body rows, so this reuses that intact frame.
  # A re-engage here was a gratuitous full-frame repaint (the blank work-box hang) — removed.
  grc=0
  start_idle_spinner "Freeing monitor port"
  run_gate_quiet stop_orphan_monitor_for_install || grc=$?
  stop_idle_spinner
  if [[ "${grc}" -ne 0 ]]; then
    _gate_surface_on_fail
    _panel_abort "${PREFLIGHT_EXIT_BLOCKED}"
    return "${PREFLIGHT_EXIT_BLOCKED}"
  fi
  # run_action_panel enters the run state, runs build_step_plan + run_plan (RENDER_MODE=panel),
  # transitions to the done line, waits, returns to nav — each transition a full draw_frame.
  run_action_panel install "Install" "${C_OK}" || status=$?
  # IMP2: restore the launchd monitor (now serving the rebuilt dist). Quieted: restore emits 2
  # log() lines that would otherwise scroll the alt-screen on return-to-nav. On a restore failure
  # the captured remediation is surfaced to stderr (loud-fail preserved).
  run_gate_quiet restore_launchd_monitor || _gate_surface_on_fail
  return "${status}"
}

# _gate_surface_on_fail — on a gate failure, surface the captured GATE_QUIET_LOG tail to the REAL
# stderr (loud-fail) so the operator sees WHY the gate aborted. Bounded tail; no-op when nothing
# was captured. _panel_abort's full-frame redraw right after recomposes the screen, so this stderr
# write does not corrupt the rendered frame.
_gate_surface_on_fail() {
  [[ -n "${GATE_QUIET_LOG}" && -f "${GATE_QUIET_LOG}" && -s "${GATE_QUIET_LOG}" ]] || return 0
  printf 'FATAL: install gate aborted — captured detail:\n' >&2
  tail -n 30 -- "${GATE_QUIET_LOG}" >&2 2>/dev/null || true
}

# dispatch_action_inline — the inline scrolling fallback for the internal unknown-action case ONLY
# (Install / Uninstall / Token Setup all render in the box). Drops the alt-screen and surfaces a
# loud "unknown action" diagnostic so a routing-table desync can never silently no-op.
dispatch_action_inline() {
  local action="$1" status=0

  # Drop the alt-screen + raw mode so the diagnostic shares one clean scrollback.
  tp rmcup
  tp cnorm
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=false # restore is a no-op now; we re-arm on return
  # Restore the compact plate geometry so the inline panels draw at their 2-cell indent regardless
  # of the fullscreen menu state we left. on_winch is a no-op now (RAW_ACTIVE=false).
  reset_plate_geometry

  tty_line "$(c "${C_ALERT}" "internal: unknown action '${action}'")"
  status=2

  tty_line ""
  tty_out "$(c "${C_DIM}" "press any key to return to the menu …")"
  IFS= read -rsn1 _ <"${TTY}" || true

  # Re-enter the menu UI.
  tp smcup
  tp civis
  stty -echo -icanon <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=true
  tp clear
  return "${status}"
}

# interactive loop
run_menu() {
  # Arm the SIGWINCH redraw AFTER ui_init engaged raw mode, BEFORE the read loop. The handler
  # recomputes geometry + redraws on a resize (no-op while a step runs). A WINCH mid `read -rsn1`
  # is delivered when read returns/EINTRs — acceptable (redraw on the next key; no busy-poll).
  trap on_winch WINCH

  draw_full_menu

  local key
  while true; do
    key="$(read_key)"
    case "${key}" in
      up)
        local prev="${SELECTED}"
        SELECTED=$((SELECTED - 1))
        [[ "${SELECTED}" -lt 0 ]] && SELECTED=$((MENU_COUNT - 1))
        redraw_nav_move "${prev}" "${SELECTED}"
        ;;
      down)
        local prev="${SELECTED}"
        SELECTED=$(((SELECTED + 1) % MENU_COUNT))
        redraw_nav_move "${prev}" "${SELECTED}"
        ;;
      enter)
        local action="${MENU_ACTION[${SELECTED}]}"
        if [[ "${action}" == "quit" ]]; then
          return 0
        fi
        dispatch_action "${action}" || true
        # Redraw the full frame after a run (geometry recomputed in case of resize; re-saves the
        # menu-row cursor).
        draw_full_menu
        ;;
      quit)
        return 0
        ;;
      *) : ;; # none — ignore
    esac
  done
}
