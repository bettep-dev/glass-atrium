# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2310,SC2312  # SC2154: reads shared globals (MENU_*/STEP_*/GRAND_TOTAL/STEP_INDEX*/action + panel state declared + assigned by the glass-atrium loader; SC2034: assigns shared dispatch/menu-state globals read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2310: `fn || status=$?` is the intended exit-capture idiom (mirrors the loader's file-wide SC2310 disable); SC2312: gate/panel helpers are deliberately invoked inside command substitutions or conditionals (the masked return carries the intended signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — dispatch + menu-loop module. SOURCED by the glass-atrium
# entry point (never executed): the shebang, strict mode, IFS, traps and every
# interleaved top-level const/stub stay loader-owned so re-sourcing never re-arms them.
# Owns the typed-confirmation prompt, the action dispatcher and its per-panel handlers
# (token/monitor/uninstall/install), the quiet gate runner with its pre/post-gate and
# abort/surface helpers, the inline dispatch path, the interactive menu loop and the
# run_action_panel bridge back to the step-run module — reading and mutating the
# loader's file-scope menu/step globals at call time in the same sourced shell.
# run_gate_quiet runs its gate through a brace group (never a subshell) so the gate's
# counter/state mutations propagate to the parent.
# run_action_panel — drive ONE run_plan-backed action inside the alt-screen work-area box.
# $1=action ("install") · $2=plan title · $3=accent SGR. run_plan is always called with mode
# "panel" so RENDER_MODE=panel gates classify + the renderers into the fixed workbox body row;
# the engine-mode signal (fd-merge) is carried by run_step's panel arm. It enters the run
# state (dim menu + run body), runs the steps, transitions to the done state (status line),
# waits for a keypress, then returns to nav. Engine path + exit codes are byte-for-byte
# unchanged — ONLY the render target moved from the old panel row to the workbox body row.
run_action_panel() {
  local action="$1" title="$2" accent="$3" status=0
  # blank work-box hang fix: run_action_panel no longer self-engages — the CALLER owns the single frame-composing
  # enter_run_state at the genuine cleared-frame boundary (install: dispatch's post-preflight
  # re-engage; uninstall: the post-"remove"-pregate re-engage). By the time control reaches here the
  # box frame is already composed + intact (the interim monitor gates paint body-only), so this
  # preflight->run_plan HANDOFF is BODY-ONLY: no gratuitous full-frame repaint (the blank work-box hang symptom).
  # A/W3 (async feel): animate the handoff. build_step_plan (pure array assembly) runs before
  # run_plan's first step spinner — a brief static frame. Hold the idle animator across build_step_plan
  # so the box never sits un-animated; stop it just before run_plan (whose first run_step also
  # defensively stops it). The body paints land on the caller's intact frame — never a frameless box.
  start_idle_spinner "Preparing steps"
  build_step_plan "${action}"
  stop_idle_spinner
  # frozen unified step counter: snapshot the frozen grand total + carried base BEFORE run_plan's end-of-plan teardown
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

# === confirmation prompt ===================================================
# Destructive actions require a typed confirmation read from /dev/tty. The user
# must type the exact token (case-sensitive) to proceed. Returns 0 to proceed.
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

# === action dispatch =======================================================
# UNIFORM box model: every non-quit action renders its STATUS in the SAME work-area box
# (concise done line / digest). Install / Uninstall STAY in the alt-screen and run
# through run_action_panel (their interactive PRE-gates — install's dependency preflight +
# monitor stop, uninstall's typed confirms — run before the box opens, mirroring install's
# pattern). Token Setup (ITEM 3) now ALSO frames its OAuth flow in the box: the box shows the
# opening / waiting / provisioned|failed states, while the ONE unavoidable cooked-mode segment
# (the `claude setup-token` browser-approval prompt — the CLI owns the TTY for the URL display
# + paste-back code, which cannot be captured/relayed) runs as a minimal pre-gate, exactly like
# uninstall's typed-confirm pre-gate. Each returns the action's exit status (0 on cancel).
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
# any TTY interaction or alt-screen drop. Mirrors preflight_provision_headless_token's
# IDEMPOTENT FAST-PATH gate BYTE-FOR-BYTE (`-f secrets_file` AND a passing headless_auth_selftest)
# so the two cannot drift — a true verdict means the common skip case can be rendered fully in-box.
# `-f` is a pure file test; headless_auth_selftest sources a lib + runs a one-shot `claude -p`
# probe in a SUBSHELL (no prompt, no paste) — neither needs a cooked TTY. The selftest's lib-absent
# stderr line is suppressed (we are in the alt-screen; nothing must scribble the frame). SECURITY:
# reads no token value — the probe only checks file presence + an auth verdict.
token_already_provisioned() {
  local secrets_file
  secrets_file="${GA_ROOT:-${HOME}/.glass-atrium}/secrets/claude-auth.env"
  [[ -f "${secrets_file}" ]] && headless_auth_selftest 2>/dev/null
}

dispatch_action_token_panel() {
  local status=0
  # 1) RUN state: dim the menu + show the present-progressive box body. A single-step full bar
  #    (ITEM 4 vocabulary) marks the one provisioning unit; C_INFO accent (informational, VR-8).
  STEP_INDEX=1
  STEP_TOTAL=1
  STEP_LABEL_ACTIVE_CUR="Opening browser for OAuth approval…"
  STEP_BAR_ACCENT_CUR="${C_ACCENT}"
  STEP_BAR_CUR="$(build_run_bar)"
  enter_run_state # full-frame redraw: dim menu + run body (draws the box with the label + bar)

  # BUG C SKIP FAST-PATH: the COMMON already-provisioned case needs NO interactive input, so it
  # stays FULLY in the alt-screen workbox — never drop the UI. Detect it with the same gate
  # preflight_provision_headless_token's fast-path uses (token_already_provisioned), then render
  # the '✓ already provisioned · self-test ok' digest via the existing TOKEN_SUMMARY done-arm with
  # NO rmcup/smcup at all. Only the genuinely-interactive first-time path (secrets absent OR a
  # failing self-test, below) needs to drop the alt-screen for the live `claude setup-token` OAuth.
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

  # 2) Cooked-mode PRE-GATE (interactive first-time path only): the unavoidable `claude setup-token`
  #    interactive segment. Drop the alt-screen + restore cooked stty (the CLI needs a live cooked
  #    TTY for the URL + paste), print the box-framed approve cue, run the UNCHANGED provisioning,
  #    then re-enter the box. Mirrors _confirm_pregate's rmcup/smcup + stty toggle. Reached ONLY when
  #    the skip-probe above was false (secrets absent OR self-test 401) — the genuinely-interactive
  #    provisioning. The token VALUE never surfaces here.
  tp rmcup
  tp cnorm
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=false
  reset_plate_geometry
  # ONE point-of-need raw cue: the framed pre-cue + framed done-digest already bracket this
  # segment, so the verbose section-header block over-declared the one unavoidable cooked-TTY
  # moment. A single minimal line sits next to the setup-token URL where the user is looking.
  # SECURITY: env-var NAME only — the OAuth token value is never printed here.
  tty_line "$(c "${C_DIM}" "approve in your browser, then return here (env-var CLAUDE_CODE_OAUTH_TOKEN only — never the token value)")"
  # preflight_provision_headless_token UNCHANGED: prints its own URL-approval guidance + runs
  # `claude setup-token`, renders the 0600 secrets file, self-tests. Its return code drives the
  # box done-state digest. A non-zero is a rendered status, never a launcher crash.
  preflight_provision_headless_token || status=$?

  # Re-enter the alt-screen + raw mode for the box done-state.
  tp smcup
  tp civis
  stty -echo -icanon <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=true
  tp clear
  apply_plate_geometry

  # 3) DONE state: compose the OAuth-outcome digest (✓ provisioned / ✗ failed — reason) from the
  #    return code, then transition to the done box body. status_line carries the title used by
  #    workbox_body_str's Token-Setup done-arm. idx/total are 1/1 (one provisioning unit).
  _clear_step_state
  parse_token_summary "${status}"
  status_line "${status}" "Token Setup" "1" "1"
  IFS= read -rsn1 _ <"${TTY}" || true
  enter_nav_state
  # A provisioning warn (non-zero) is a rendered status (the daemons keep the keychain fallback),
  # never a launcher error — force 0 so the menu loop never treats it as a crash.
  return 0
}

# dispatch_action_monitor_panel — ITEM 5: the Monitor shortcut. A single-step, fully in-box,
# NON-interactive action (no alt-screen drop). INSTALL-GATED first: if the monitor plist is absent
# (program not installed) it renders the "available after Install" cue with NO "Opening…" run flash
# and NO browser open. When installed, it shows the single-step open flow, then `open`s the dashboard
# (xdg-open fallback for a non-macOS host). Returns 0 always — a non-zero open is a rendered status,
# never a launcher crash (mirrors Token). Reads NO secret — only the localhost URL.
dispatch_action_monitor_panel() {
  # Dashboard URL derives via atrium_monitor_port (ADR-1) — never a literal. A resolver
  # failure is masked to '' (this panel ALWAYS returns 0); the open then no-ops into a
  # rendered non-zero status, never a launcher crash.
  local port
  port="$(atrium_monitor_port 2>/dev/null || true)"
  local url="http://127.0.0.1:${port}" status=0
  # Single-step panel hygiene: clear any prior run_plan action's persisted fail-log path so the
  # Monitor done bottom-row never inherits a stale `log:` pointer (mirrors _panel_abort).
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

# dispatch_action_uninstall_panel — Uninstall through the work-area box. The destructive
# typed confirmations run as cooked-mode PRE-gates (the box cannot host a visible typed
# prompt), exactly mirroring install's preflight pattern: confirm inline, then run the
# step plan in the box. The REAL uninstall engine logic (remove_manifest_links / sweep_orphans
# / unwire_hooks / drop_databases / remove_node_modules / purge_config) + its exit codes are
# byte-for-byte unchanged — ONLY the progress render moves into the box. A cancelled confirm
# returns 0 (no-op, back to nav).
dispatch_action_uninstall_panel() {
  local status=0
  # PRE-gate: the "remove" typed confirm in cooked mode (drop alt-screen for the prompt,
  # then re-enter for the box). _confirm_pregate handles the rmcup/smcup + stty toggle.
  if ! _confirm_pregate "remove" "Uninstall: removes GA symlinks/hooks, DROPS the glass_atrium + shadow DBs (pre-drop pg_dump backup kept in ~/.claude/backups/postgres), and deletes monitor/node_modules."; then
    # Cancelled: a brief done line, then back to nav.
    status_line 0 "Uninstall cancelled" 0 0
    IFS= read -rsn1 _ <"${TTY}" || true
    enter_nav_state
    return 0
  fi
  # blank work-box hang fix: the "remove" pre-gate's rmcup/smcup+clear leaves the alt-screen CLEARED (not composed), so
  # compose the box frame HERE — the single cleared-frame-boundary re-engage for this path — before the
  # now-body-only run_action_panel handoff. Without it the uninstall box would paint over a cleared
  # screen = frameless. (run_action_panel no longer self-engages; the caller owns the engage.)
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

# _confirm_pregate — run ONE confirm_typed prompt in cooked-mode scrollback (a typed
# confirmation cannot render inside the dimmed alt-screen box), then re-enter the alt-screen.
# Drops rmcup + restores cooked stty for the prompt, re-engages smcup + raw on return. Mirrors
# dispatch_action_inline's enter/leave bracket. Returns confirm_typed's verdict (0 = proceed).
_confirm_pregate() {
  local token="$1" prompt="$2" rc=0
  # Same torn-down-frame guard as preflight_bracket: stop any idle spinner BEFORE rmcup so no idle
  # child paints into the alt-screen frame this pre-gate drops. Idempotent no-op when none is open.
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

# _panel_abort — show the concise FAIL done-line for an install PRE-gate abort (blocked
# preflight / stuck :16145), wait for a key, return to nav. status_line transitions to the
# done state + full-frame redraws (REDRAW_MODEL), so it wipes any preflight scrollback clean
# on its own — no pre-clear needed. No scrolling detail reaches the box.
_panel_abort() {
  STEP_FAIL_LOG_PERSISTED=""
  status_line "$1" "Install" "0" "0"
  IFS= read -rsn1 _ <"${TTY}" || true
  enter_nav_state
}

# run_gate_quiet — run ONE install-panel gate function with its fd 2 routed to the
# GATE_QUIET_LOG capture file instead of the terminal. WHY: the install panel's PRE/POST
# gates (dependency preflight, launchd/orphan monitor stop, monitor restore) run OUTSIDE
# run_step + OUTSIDE the ${TTY} chrome sink, so their engine log() lines (stderr) paint
# directly onto the alt-screen — a path-like leak that ALSO scrolls the screen, corrupting
# the subsequent menu/nav frame. This wrap keeps the alt-screen clean WHILE PRESERVING the
# lines for loud-fail diagnostics: on a non-zero gate rc the captured tail is surfaced (the
# genuine failure remediation), and any error is re-appended to the engine log stream for
# the operator. The captured file is APPENDED across gates so one log holds the whole
# pre-gate sequence; cleanup() sweeps it. Returns the gate's EXACT exit code (set -e off via
# the `|| rc=$?` capture so a return 1 inside the gate is propagated, not an ERR-trap abort).
# CLI/passthrough does NOT use this wrap — it calls the gates directly, so their stderr stays
# loud on that non-TUI path (the no-alt-screen path the leak never affected).
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

# dispatch_action_install_panel — the clean install run. STAYS in the alt-screen + raw
# mode: the menu dims in place, the run_plan output routes into the fixed panel (spinner +
# [i/N] + label only), and a SUCCESS/FAIL status line pins to the bottom. The engine path
# (dependency preflight, monitor stop/restore, the install steps, exit codes) is byte-for-
# byte the same as before — ONLY the user-facing rendering changes. The PRE/POST gates run
# via run_gate_quiet so their engine log() (stderr) never scribbles/scrolls the alt-screen
# (the path-like leak fix); the lines stay captured for loud-fail (surfaced on gate failure).
dispatch_action_install_panel() {
  local status=0 grc=0
  apply_plate_geometry # keep the centered-column plate width for the dimmed menu + panel
  # The dependency preflight + launchd-monitor stop are interactive PRE-gates (prompts /
  # polling). On a provisioned machine they are a silent no-op; on a bare machine they own
  # ${TTY} directly for prompts (preflight_line -> TTY, unaffected by run_gate_quiet which
  # only redirects fd 2 = the engine log() stream). Run them BEFORE engaging the panel.
  #
  # A/W1 (async feel): dim the menu + show the ANIMATED box IMMEDIATELY when Install is selected,
  # so the initial dependency detection + preflight_count_and_gate window (the silent blank gap
  # before the first framed step, incl. the fully-provisioned fast-path detection) never renders a
  # frozen static menu. The boxed preflight's own brackets/panel steps defensively stop this idle
  # when they take over; on the all-present fast path it animates the whole detection. rc is captured
  # BEFORE stop_idle (kill/wait/tput would clobber $?), and the idle is stopped BEFORE any abort
  # redraw so no stray idle child paints into _panel_abort's recomposed frame.
  enter_run_state
  start_idle_spinner "Detecting dependencies"
  run_gate_quiet run_dependency_preflight || grc=$?
  stop_idle_spinner
  if [[ "${grc}" -ne 0 ]]; then
    # _panel_abort's status_line full-frame redraws (REDRAW_MODEL), wiping the preflight
    # scrollback clean on its own — no pre-draw / pre-dim needed. The captured gate log
    # surfaces the failure detail to the operator (loud-fail preserved).
    _gate_surface_on_fail
    _panel_abort "${PREFLIGHT_EXIT_BLOCKED}"
    return "${PREFLIGHT_EXIT_BLOCKED}"
  fi
  # A/W2 (async feel): animate the launchd-monitor stop gate (it polls the daemon's death ~1-2s = a
  # static frame otherwise). blank work-box hang fix: this is THE SINGLE guaranteed re-engage at the preflight->monitor
  # cleared-frame boundary — run_dependency_preflight may return with its last bracket having left the
  # alt-screen cleared, so compose the frame ONCE here. Every downstream idle window (this gate, the
  # orphan gate, run_action_panel's build_step_plan handoff) then paints BODY-ONLY on this intact frame
  # — no further full-frame repaints. rc captured BEFORE stop_idle; idle stopped BEFORE abort.
  grc=0
  enter_run_state
  start_idle_spinner "Freeing monitor port"
  run_gate_quiet stop_launchd_monitor_for_install || grc=$?
  stop_idle_spinner
  if [[ "${grc}" -ne 0 ]]; then
    # IMP2: a launchd-owned monitor still holds :16145 — abort cleanly (stop_* already
    # restored + logged the remediation to the captured gate log; the box surfaces only
    # the concise done line, the captured remediation is surfaced to stderr).
    _gate_surface_on_fail
    _panel_abort "${PREFLIGHT_EXIT_BLOCKED}"
    return "${PREFLIGHT_EXIT_BLOCKED}"
  fi
  # CHANGE 3: AFTER the launchd-owned stop, sweep a NON-launchd orphan on :16145 (a stray
  # `node` left by a crashed install / manual dev run). The launchd stop above already
  # cleared a managed monitor, so anything still listening here is a true orphan that
  # would otherwise make bootstrap_health_gate die on its stale-instance precondition.
  # Ordering matters: launchd stop FIRST (so monitor_is_launchd_owned is false by the time
  # the orphan probe runs), orphan sweep SECOND. A stuck orphan aborts cleanly (same panel
  # path as the launchd case); the function logs the lsof remediation to the captured gate log.
  # A/W2 (cont.): same idle-animated wrap as the launchd gate — but BODY-ONLY. blank work-box hang fix: the single
  # post-preflight enter_run_state above already composed the frame, and the launchd gate painted only
  # body rows (never touched the frame), so this orphan gate reuses that intact frame with an idle body
  # paint. A re-engage here was a gratuitous full-frame repaint (the blank work-box hang intermittent refresh) — removed.
  grc=0
  start_idle_spinner "Freeing monitor port"
  run_gate_quiet stop_orphan_monitor_for_install || grc=$?
  stop_idle_spinner
  if [[ "${grc}" -ne 0 ]]; then
    _gate_surface_on_fail
    _panel_abort "${PREFLIGHT_EXIT_BLOCKED}"
    return "${PREFLIGHT_EXIT_BLOCKED}"
  fi
  # run_action_panel enters the run state (dim menu + run body), runs build_step_plan +
  # run_plan under RENDER_MODE=panel, transitions to the done line, waits for a key, then
  # returns to nav — each transition a full draw_frame, so no fragment can accumulate.
  run_action_panel install "Install" "${C_OK}" || status=$?
  # IMP2: restore the launchd monitor immediately (now serving the rebuilt dist), as before.
  # Quieted too: restore emits 2 informational log() lines that would otherwise scroll the
  # alt-screen on the post-run return-to-nav (the Defect-2 frame corruption). On a restore
  # failure the captured remediation is surfaced to stderr (loud-fail preserved).
  run_gate_quiet restore_launchd_monitor || _gate_surface_on_fail
  return "${status}"
}

# _gate_surface_on_fail — on a gate failure, surface the captured GATE_QUIET_LOG tail to
# the REAL stderr (loud-fail) so the operator sees WHY the gate aborted. Bounded tail (the
# captured log is small — a handful of engine log lines). No-op when nothing was captured.
# The screen is recomposed by _panel_abort's full-frame redraw right after, so this stderr
# write does not corrupt the rendered frame (it precedes the redraw / runs on exit).
_gate_surface_on_fail() {
  [[ -n "${GATE_QUIET_LOG}" && -f "${GATE_QUIET_LOG}" && -s "${GATE_QUIET_LOG}" ]] || return 0
  printf 'FATAL: install gate aborted — captured detail:\n' >&2
  tail -n 30 -- "${GATE_QUIET_LOG}" >&2 2>/dev/null || true
}

# dispatch_action_inline — the inline scrolling fallback for the internal unknown-action case
# ONLY. Install / Uninstall / Token Setup all render in the work-area box (dispatch_action
# routes them); this drops the alt-screen and surfaces a loud "unknown action" diagnostic so a
# future routing-table desync can never silently no-op. Drops the alt-screen for the message.
dispatch_action_inline() {
  local action="$1" status=0

  # Drop the alt-screen + raw mode so the diagnostic shares one clean scrollback.
  tp rmcup
  tp cnorm
  stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
  RAW_ACTIVE=false # restore is a no-op now; we re-arm on return
  # Restore the compact plate geometry (PLATE_MARGIN indent + term_cols width) so the
  # inline panels draw at their unchanged 2-cell indent regardless of the fullscreen
  # menu state we just left. on_winch is a no-op now (RAW_ACTIVE=false).
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

# === interactive loop ======================================================
run_menu() {
  # Arm the SIGWINCH redraw AFTER ui_init engaged raw mode, BEFORE the read loop. The
  # handler full-recomputes geometry + redraws on a terminal resize (no-op while a step
  # runs). A WINCH arriving mid `read -rsn1` is delivered when read returns/EINTRs —
  # acceptable (the redraw happens on the next key or on read's interrupt; no busy-poll).
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
        # Redraw the full frame after returning from a run (geometry recomputed in case
        # the terminal was resized during the inline run; re-saves the menu-row cursor).
        draw_full_menu
        ;;
      quit)
        return 0
        ;;
      *) : ;; # none — ignore
    esac
  done
}
