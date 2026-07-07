# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2310,SC2312  # SC2154: reads shared globals (STEP_*/GRAND_TOTAL/STEP_INDEX*/INSTALL_PLAN_*/STEP_LABEL/STEP_FN/WORK_STATE/C_*/G_* etc.) declared + assigned by the glass-atrium loader; SC2034: assigns shared step/run globals read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2310: `fn || rc=$?` is the intended exit-capture idiom (mirrors the loader's file-wide SC2310 disable); SC2312: summary/render helpers are deliberately invoked inside command substitutions (the masked return carries no signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — step-run orchestration module. SOURCED by the glass-atrium
# entry point (never executed): the shebang, strict mode, IFS, traps and every
# interleaved top-level const/stub (the step-counter state band, readonly
# INSTALL_PLAN_LEN, the STEP_LABEL/STEP_FN arrays) stay loader-owned so re-sourcing
# never re-arms them. Owns the per-step runner and its section/outcome panels, the
# install + step-plan builders, the doctor preflight gate, the monitor build, the
# launchd job loader and the token/summary parsers — reading and mutating the loader's
# file-scope step/run globals at call time in the same sourced shell. run_step drives
# the counters through a brace group (never a subshell) so STEP_INDEX/GRAND_TOTAL/
# STEP_INDEX_BASE mutations propagate to the parent.
# commit_install_permanent — erase the live progress row, print ONE permanent line
# (newline-terminated → scrolled-up history), then REPRINT the live progress row below
# it so the loud line becomes permanent history and the live row sits one row under.
# CR + clear-line ONLY (no cursor-up / save-restore). $1=the already-formatted +
# already-newline-terminated permanent line (printed verbatim) · $2..$5 = the live-row
# redraw args (glyph/counter/active_label/suppressed) to reprint beneath it.
commit_install_permanent() {
  local permanent_line="$1" glyph="$2" counter="$3" active_label="$4" suppressed="$5"
  printf '\r\033[2K' >"${TTY}"              # erase the live progress row first
  printf '%s' "${permanent_line}" >"${TTY}" # the loud line already leads with \r\033[2K + ends in \n
  redraw_install_progress "${glyph}" "${counter}" "${active_label}" "${suppressed}"
}

# parse_token_summary — ITEM 3: synthesize the Token Setup done-state digest into TOKEN_SUMMARY
# from preflight_provision_headless_token's return code ($1). NEVER reads or echoes the token
# value — the OAuth credential never reaches this function (it stays in preflight_provision's
# local, scrubbed there). It composes only a verdict glyph + a concise human reason + the
# env-var NAME cue. Return-code map (mirrors preflight_provision_headless_token's documented set):
#   0 — provisioned (or idempotent skip)               → ✓ green
#   1 — rendered but self-test still 401s               → ✗ red, "self-test still 401"
#   2 — headless-auth scripts absent (keychain fallback)→ ✗ red, "auth scripts missing"
#   3 — 'claude setup-token' produced no usable value   → ✗ red, "no token from setup-token"
#   4 — render-claude-auth.sh rejected the value        → ✗ red, "render rejected the value"
#   * — any other non-zero (e.g. setup-token non-zero)  → ✗ red, "setup-token failed (exit N)"
# The PASS row2 carries the env-var-name cue; the FAIL row2 carries the retry hint. NO token, NO
# secrets-file path content — env-var NAME only (CLAUDE_CODE_OAUTH_TOKEN is a name, not a secret).
parse_token_summary() {
  local rc="$1" reason="" glyph head
  TOKEN_SUMMARY=""
  TOKEN_SUMMARY_ROW2=""
  if [[ "${rc}" -eq 0 ]]; then
    glyph="$(c "${C_OK}" "${G_OK}")"
    head="$(c "${C_STRONG}" "Token provisioned")"
    TOKEN_SUMMARY="${glyph} ${head}"
    TOKEN_SUMMARY_ROW2="$(c "${C_DIM}" "env: CLAUDE_CODE_OAUTH_TOKEN ${G_DOT} launchd daemons will authenticate")"
    return 0
  fi
  case "${rc}" in
    1) reason="self-test still 401" ;;
    2) reason="auth scripts missing" ;;
    3) reason="no token from setup-token" ;;
    4) reason="render rejected the value" ;;
    *) reason="setup-token failed (exit ${rc})" ;;
  esac
  glyph="$(c "${C_ALERT}" "${G_FAIL}")"
  head="$(c "${C_STRONG}" "Token setup failed")"
  TOKEN_SUMMARY="${glyph} ${head} $(c "${C_DIM}" "${G_DOT} ${reason}")"
  TOKEN_SUMMARY_ROW2="$(c "${C_DIM}" "re-run Token Setup or 'glass-atrium install' to retry")"
  return 0
}

# run_step — invoke ONE engine step with a live pending->running->done glyph and
# its STDERR captured into a temp file, then classified + folded. Returns the step rc.
#
# Capture pattern (IMP1 — SYNCHRONOUS, no proc-sub race): redirect fd 2 to a regular
# temp file (`2>"${STEP_LOG}"`) — the file is fully flushed + complete the instant the
# command returns, so the post-return classify reads it reliably in run_step's OWN
# shell (no cross-subshell count handoff, no bare `wait` for a sink — the old proc-sub
# `2> >(step_sink)` was unsound on bash 3.2: the bare wait did not synchronize it).
# set +e/-e brackets the call and $? is captured immediately; the ERR trap is suspended
# for the bracketed call so an expected non-zero step (doctor FAIL) renders its glyph.
# classify_step_log prints LOUD/DIM lines + counts SUPPRESSED routine lines into
# STEP_SUPPRESSED_COUNT; the count folds into the ✓ row's single printf; PASS rm's the
# temp, FAIL dumps it inline (_dump_step_log) and persists it via run_plan.
#
# $1 = past/nominal label (the resolved-line label) · $2.. = the engine function +
# its positional args (e.g. `run_symlink_farm install`). While the step runs, the
# braille spinner owns the status line showing the present-progressive ACTIVE label
# (STEP_LABEL_ACTIVE_CUR, set per step by run_plan; falls back to $1 when unset); on
# resolution a fresh stamped ✓/✗ line carrying the past label is appended. The optional
# STEP_INDEX / STEP_TOTAL globals (set by run_plan) prefix a dim block-bar counter.
run_step() {
  local label="$1"
  shift

  # Glyphs from the shared G_* set so a single --ascii toggle degrades the step marks
  # together with the menu frame + wordmark.
  local done_glyph fail_glyph
  done_glyph="$(c "${C_OK}" "${G_OK}")"
  fail_glyph="$(c "${C_ALERT}" "${G_FAIL}")"

  # Optional dim sub-char block-bar step counter (run_plan sets STEP_INDEX/STEP_TOTAL
  # per step). build_counter_str renders the fixed-width X-of-Y gauge from the shared
  # PROG_FULL/PROG_EMPTY glyph SoT, so --ascii degrades it to `#`/`.`.
  local counter=""
  if [[ -n "${STEP_INDEX:-}" && -n "${STEP_TOTAL:-}" ]]; then
    # 4a: offset by STEP_INDEX_BASE (empty except on the install-panel handoff) so the block-bar
    # counter continues the grand sequence rather than restarting at 1/n. Empty base => raw i/N.
    local disp_i disp_n
    disp_i=$((${STEP_INDEX_BASE:-0} + STEP_INDEX))
    # frozen unified step counter: prefer the frozen GRAND_TOTAL denominator; empty (shared callers) => raw base+STEP_TOTAL.
    disp_n=${GRAND_TOTAL:-$((${STEP_INDEX_BASE:-0} + STEP_TOTAL))}
    counter="$(c "${C_DIM}" "$(build_counter_str "${disp_i}" "${disp_n}")")"
  fi

  # Tense shift (VR-5): the running line shows the present-progressive ACTIVE label
  # (e.g. "Building monitor…"); the resolved line below carries the past label ($1).
  local active_label="${STEP_LABEL_ACTIVE_CUR:-${label}}"

  # install / panel RENDER_MODE: ONE in-place progress row replaces the per-step scrolling
  # line. The spinner paints the pre-styled body (counter + C_STRONG label) verbatim; the
  # classify reprint context lets each committed LOUD/DIM line reprint the live row below it
  # (install mode only — panel mode suppresses ALL output, so its reprint is a no-op). Empty
  # mode = the historical scrolling model (uninstall) — unchanged. In install mode the
  # counter is the block-bar gauge; in panel mode it is EMPTY — the dominant FILLED bar (ITEM 4,
  # STEP_BAR_CUR) carries the i/N now, so the redundant `[i/N]` stamp is dropped from the body.
  local install_mode="" panel_mode=""
  [[ "${RENDER_MODE:-}" == "install" ]] && install_mode="install"
  if [[ "${RENDER_MODE:-}" == "panel" ]]; then
    install_mode="install" # reuse the single-line render path (fd-1+fd-2 merge, spinner body)
    panel_mode="panel"
    counter="" # ITEM 4: the bar owns the i/N; no separate [i/N] stamp in the panel body
  fi

  # 4e: create the step's capture temp + publish STEP_LOG_CUR BEFORE the spinner forks. The forked
  # spinner subshell snapshots STEP_LOG_CUR at fork time, so it MUST already hold THIS step's path
  # for the per-tick rolling label to tail the running sub-process output (a pre-fork empty/stale
  # value would make the rolling label silently no-op). The file is empty at fork; "$@" appends to it
  # below (same path), and the child's `tail -n 1` reads the growing file live. Moved up from its
  # historical spot just before the capture redirect (no behavior change to the capture itself — the
  # redirect target is still this STEP_LOG; only the mktemp+track now precede the spinner start).
  local STEP_LOG
  STEP_LOG="$(mktemp "${TMPDIR:-/tmp}/ga-step.XXXXXX")"
  STEP_LOG_CUR="${STEP_LOG}" # track for the abort-trap sweep + the 4e rolling-label tail while in flight

  # spinner owns the animated running status line (off-TTY: a hard no-op). It is
  # started BEFORE the brace group and stopped just after, so the spinner PID is
  # reaped on its own (kill-targeted, never a blanket wait).
  #
  # SUPPRESSION (BUG-2 B): for a step whose STDERR is the scrolling feedback
  # (run_doctor emits ~15-34 log lines), a CR-repainting spinner would tick
  # against the classify tail. STEP_SUPPRESS_SPINNER (set per step by run_plan) gates
  # the spinner OFF for those steps; stop_step_spinner is a no-op when SPIN_PID stayed empty.
  if [[ "${STEP_SUPPRESS_SPINNER:-}" != "true" ]]; then
    if [[ -n "${install_mode}" ]]; then
      # install: feed the spinner the pre-styled single-line body (no fold during the run;
      # the bash-3.2-faithful generic fold lands the final N-items count on the resolved
      # redraw) so it repaints the whole row, advancing ONLY the frame glyph per tick.
      start_step_spinner "$(build_install_progress_body "${counter}" "${active_label}" 0)" prestyled
    else
      start_step_spinner "${counter}${active_label}"
    fi
  elif [[ -n "${panel_mode}" ]]; then
    # SUPPRESSED-spinner panel step: the spinner
    # is what paints WORKBOX_BODY_ROW during a run, so a suppressed step leaves the box body
    # BLANK for the whole probe. Paint the run-state body ONCE here — AFTER STEP_INDEX/STEP_TOTAL
    # /STEP_LABEL_ACTIVE_CUR are set for the step (run_plan sets them before run_step) — via the
    # SAME rail-safe panel path the live spinner + resolved frame use (redraw_install_progress →
    # paint_workbox_body_inner: inner span only, box rails preserved). Running glyph = C_INFO G_DOT
    # (mirrors the classify live glyph). Generalizes to ANY future suppressed-spinner panel step.
    redraw_install_progress "$(c "${C_INFO}" "${G_DOT}")" "${counter}" "${active_label}" 0
    # LINE 2 for a suppressed-spinner step: no live animator paints it, so seed the slow dots ONCE
    # (a static "…" cue) rather than leaving LINE2 blank for the whole probe. Rail-safe inner span.
    paint_workbox_body_row2_inner "$(printf '  %s' "$(_spinner_dots 0)")"
  fi

  # install: arm the classify reprint context so each committed permanent (loud/dim) line
  # reprints the live progress row beneath it (the static spinner frame is used as the
  # leading cell; the spinner is stopped by the time classify runs). Empty in other modes.
  # Panel mode does NOT arm the reprint context — classify prints nothing, so there is no
  # live row to reprint beneath; it sets CLASSIFY_PANEL instead (full suppression + loud-detect).
  STEP_PANEL_LOUD_SEEN=""
  CLASSIFY_PANEL=""
  if [[ -n "${panel_mode}" ]]; then
    CLASSIFY_PANEL="true"
  elif [[ -n "${install_mode}" ]]; then
    CLASSIFY_LIVE_GLYPH="$(c "${C_INFO}" "${G_DOT}")"
    CLASSIFY_LIVE_COUNTER="${counter}"
    CLASSIFY_LIVE_LABEL="${active_label}"
  fi

  # Capture the step's output to a regular temp file (IMP1): the redirect is synchronous —
  # the file is fully written the instant "$@" returns, so the post-return classify reads
  # it in run_step's own shell with no proc-sub race + a directly-usable suppressed count.
  # install mode MERGES fd 1 into the capture (`>… 2>&1`) so a noisy subprocess STDOUT
  # (npm run build, prisma/npm-ci in oss-db-setup.sh) is suppressible by classify instead
  # of flooding the terminal + breaking the single-line model. Other modes capture fd 2
  # only (the historical behavior — uninstall unchanged). NB: STEP_LOG / STEP_LOG_CUR are created
  # ABOVE (before the spinner fork, 4e) — the capture redirect below writes to that same STEP_LOG.
  local rc=0
  set +e
  trap - ERR
  # force-quit-class guard: mark the step TUI-run so a step fn's routine-failure `exit` becomes a
  # FAIL-panel RETURN via exit_step/die_step (lib/ga-env.sh) — not a masked whole-process force-quit.
  # CLI-passthrough-shared fns (setup_database/bootstrap_health_gate) keep `exit` when GA_TUI_STEP unset.
  GA_TUI_STEP=1
  if [[ -n "${install_mode}" ]]; then
    # </dev/null: pin the CAPTURED exec's stdin to EOF so a hidden sub-tool prompt (brew/pip/
    # claude/fakechat) fails fast (rc!=0, surfaced) instead of blocking invisibly forever. Every
    # legitimate prompt reads <"${TTY}" / /dev/tty on a DIFFERENT fd outside this capture, so this
    # never starves a real prompt — it only closes the invisible-hang path (P1 install-stall).
    { "$@" </dev/null >"${STEP_LOG}" 2>&1; } # merge fd 1 + fd 2 so stdout flood is captured
  else
    { "$@" </dev/null 2>"${STEP_LOG}"; } # fd-2-only capture (historical scrolling model)
  fi
  rc=$?
  GA_TUI_STEP=""
  stop_step_spinner # kill ONLY the spinner PID (synchronous capture needs no sink wait)
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e

  # CLASSIFY-AND-RENDER the now-complete log: LOUD/DIM lines printed live, SUPPRESSED
  # routine lines counted into STEP_SUPPRESSED_COUNT (a plain var in THIS shell). In
  # install mode, committed loud/dim lines reprint the live progress row beneath them.
  classify_step_log "${STEP_LOG}"
  local suppressed="${STEP_SUPPRESSED_COUNT}"
  # disarm the reprint + panel context immediately so a later step never inherits them.
  # rc stays the SOLE source of truth for pass/fail — STEP_PANEL_LOUD_SEEN is diagnostic
  # only and never overrides the engine exit code (exit-code behavior is byte-for-byte).
  CLASSIFY_LIVE_GLYPH=""
  CLASSIFY_LIVE_COUNTER=""
  CLASSIFY_LIVE_LABEL=""
  CLASSIFY_PANEL=""
  STEP_PANEL_LOUD_SEEN=""

  # restamp the status row: append a fresh stamped line (the running row stays as
  # scrollback) — consistent with the engine's own scrolling-log ethos (nothing hidden).
  # The cursor is at col 0 below the tail; we do not track the tail-line count, so a
  # fresh-line append avoids a mis-targeted in-place restamp.
  if [[ "${rc}" -eq 0 ]]; then
    # FOLD the per-step tally into the ONE PASS printf (qa: single printf, not a 2nd):
    # when count>0 append ` <G_DOT> N items` in C_DIM, mirroring outcome_panel's ` · Ns`.
    local items_suffix=""
    if [[ "${suppressed}" -gt 0 ]]; then
      items_suffix=" $(c "${C_DIM}" "${G_DOT} ${suppressed} items")"
    fi
    if [[ -n "${panel_mode}" ]]; then
      # panel: redraw the resolved frame on the SAME absolute workbox body row (G_OK + the ITEM 4
      # dominant bar at THIS step's fill + past label in C_DIM, NO items fold) — overwritten by the
      # next step's start redraw. STEP_BAR_CUR still holds this step's bar (run_plan clears it after).
      # BUG A: paint ONLY the inner span (rail-safe) so the box's left/right rails survive the resolve.
      if [[ -n "${STEP_BAR_CUR:-}" ]]; then
        paint_workbox_body_inner "$(printf '  %s %s  %s' "${done_glyph}" "${STEP_BAR_CUR}" "$(c "${C_DIM}" "${label}")")"
      else
        paint_workbox_body_inner "$(printf '  %s %s' "${done_glyph}" "$(c "${C_DIM}" "${label}")")"
      fi
      paint_workbox_body_row2_inner "" # resolved frame: clear LINE 2 (no stale running-detail lingers)
    elif [[ -n "${install_mode}" ]]; then
      # install: REDRAW the SAME row one last time as a transient resolved frame (G_OK +
      # counter + past label in C_DIM + final fold), NO newline — it stays in place to be
      # overwritten by the next step's start redraw, so exactly ONE physical row is reused.
      printf '\r\033[2K  %s %s%s%s' "${done_glyph}" "${counter}" "$(c "${C_DIM}" "${label}")" "${items_suffix}" >"${TTY}"
    else
      printf '  %s%s %s%s\n' "${counter}" "${done_glyph}" "$(c "${C_DIM}" "${label}")" "${items_suffix}" >"${TTY}"
    fi
    rm -f "${STEP_LOG}"
    STEP_LOG_CUR="" # resolved + swept; no longer an abort-trap concern
  elif [[ -n "${panel_mode}" ]]; then
    # panel: NO inline FAIL row, NO _dump_step_log — the clean UI shows nothing but the
    # status line (painted by run_action_panel) + the persisted log path. The captured log
    # is still handed to run_plan via STEP_LAST_FAIL_LOG for the persist mv (path-only surface).
    STEP_LAST_FAIL_LOG="${STEP_LOG}"
    STEP_LOG_CUR="" # ownership passes to run_plan (mv-persist); not an abort orphan
  else
    # install: clear the live progress row FIRST, then commit the FAIL row as a PERMANENT
    # line (the printf below leads with \r\033[2K + ends in \n in install mode); other
    # modes append the fresh FAIL line below the scrolling tail (historical behavior).
    if [[ -n "${install_mode}" ]]; then
      printf '\r\033[2K' >"${TTY}" # erase the transient live row before the permanent FAIL row
    fi
    printf '  %s%s %s %s\n' "${counter}" "${fail_glyph}" "$(c "${C_STRONG}" "${label}")" "$(c "${C_ALERT}" "(exit ${rc})")" >"${TTY}"
    # FAIL diagnosability: dump the COMPLETE captured log inline BEFORE any rm, then
    # hand the temp to run_plan (via STEP_LAST_FAIL_LOG) to persist outside the git tree.
    # In install mode the dump is strictly MORE complete (fd-1 stdout is now in the log).
    _dump_step_log "${STEP_LOG}"
    STEP_LAST_FAIL_LOG="${STEP_LOG}"
    STEP_LOG_CUR="" # ownership passes to run_plan (mv-persist) / outcome pointer; not an abort orphan
  fi
  return "${rc}"
}

# section_header — a framed run-section banner: a top rail with the title as a tab,
# matching the menu panel's frame language. Degrades to a plain "── title ──" rule
# under ASCII via the shared G_* glyphs. Width is clamped to a readable band.
#
# $1=title · $2=accent SGR (OPTIONAL — the frame-rail color). Omitted/empty → C_INFO,
# preserving the pre-accent default; run_plan threads the per-action accent (VR-8) so
# the banner carries the action's risk class (Install=C_OK … Uninstall=C_ALERT).
section_header() {
  local title="$1" accent="${2:-${C_INFO}}"
  local inner
  inner="$(plate_inner)"
  tty_line ""
  # The title rides the top rail as a tab (its own surrounding spaces); the lone
  # leading G_H is dropped so the banner rhythm matches outcome_panel's plate_bot.
  plate_top "${inner}" " ${title} " "${accent}"
}

# outcome_panel — the closing result frame for a run. A bottom rail + a status line
# stamped with the OK/FAIL glyph, the title, and a step tally. Mirrors section_header
# so the run reads as one bracketed unit.
#
# $1=title · $2=rc · $3=passed · $4=total · $5=accent SGR (OPTIONAL — the success
# bottom-rail color; omitted/empty → C_INFO, the pre-accent default) · $6=elapsed
# seconds (OPTIONAL — VR-9; appended as a dim `· Ns` suffix when set) · $7=fail-log
# path (OPTIONAL — IMP1; the FAIL branch prints a dim `see: <path>` pointer to the
# persisted captured engine output). The FAIL path keeps C_ALERT (amber) regardless of
# the action accent: failure reads as red always.
outcome_panel() {
  local title="$1" rc="$2" passed="$3" total="$4" accent="${5:-${C_INFO}}" elapsed="${6:-}" fail_log="${7:-}"
  local inner
  inner="$(plate_inner)"

  # elapsed suffix (VR-9): a dim `· Ns` appended to the tally line when run_plan
  # passed the $SECONDS delta. Whole-second resolution (clig.dev summary granularity).
  local elapsed_suffix=""
  [[ -n "${elapsed}" ]] && elapsed_suffix=" $(c "${C_DIM}" "${G_DOT} ${elapsed}s")"

  # Stamp lines indent to PLATE_MARGIN+2 so they sit UNDER the rail (the rail
  # corner is at PLATE_MARGIN; +2 clears the corner glyph + one pad cell).
  local stamp
  stamp="$(printf '%*s' "$((PLATE_MARGIN + 2))" "")"
  tty_line ""
  plate_bot "${inner}" "${accent}"
  if [[ "${rc}" -eq 0 ]]; then
    tty_out "${stamp}$(c "${C_OK}" "${G_OK}") $(c "${C_STRONG}" "${title} complete")"
    tty_line "   $(c "${C_DIM}" "${passed}/${total} steps ${G_DOT} exit 0")${elapsed_suffix}"
  else
    tty_out "${stamp}$(c "${C_ALERT}" "${G_FAIL}") $(c "${C_STRONG}" "${title} stopped")"
    tty_line "   $(c "${C_ALERT}" "exit ${rc}") $(c "${C_DIM}" "${G_DOT} ${passed}/${total} steps before the failing step")${elapsed_suffix}"
    # IMP1: point at the persisted captured engine output (run_plan saved it outside
    # the git tree). Whole captured log already dumped inline under the ✗ row above.
    [[ -n "${fail_log}" ]] && tty_line "   $(c "${C_DIM}" "see: ${fail_log}")"
  fi
}

# _clear_step_state — reset the per-step render globals to empty. Shared by run_plan's teardown +
# the single-step token/uninstall/purge dispatchers (identical reset block, one SoT).
# 4a: STEP_INDEX_BASE is swept here too so an install-panel run's carried offset never leaks into a
# later same-session shared caller (its end-of-plan teardown at run_plan clears the base after the
# install render consumed it). The preflight->install handoff (which SETS the base) does NOT call
# this function — it inlines a partial clear that PRESERVES the base (see _run_dependency_preflight_boxed).
_clear_step_state() {
  STEP_INDEX=""
  STEP_TOTAL=""
  STEP_INDEX_BASE=""
  GRAND_TOTAL="" # frozen unified step counter: sweep beside STEP_INDEX_BASE so a prior install grand total never leaks
  STEP_LABEL_ACTIVE_CUR=""
  STEP_BAR_CUR=""
  STEP_BAR_ACCENT_CUR=""
}

run_plan() {
  local title="$1" accent="${2:-}" mode="${3:-}"
  # $3 (optional): "install" = the inline single-line progress renderer (fd-1+fd-2 merge +
  # in-place CR redraw); "panel" = the in-alt-screen clean panel (same single-line render
  # path, but routed to the fixed MENU_PANEL_ROW + ALL non-loud output suppressed). NO mode
  # arg (uninstall) → RENDER_MODE stays empty and run_step falls through to the
  # exact fd-2-only capture + scrolling-log rows — byte-for-byte unchanged.
  # RENDER_MODE is local-scoped to this call (reset on return) so it never leaks into a
  # later same-session action.
  local RENDER_MODE=""
  [[ "${mode}" == "install" ]] && RENDER_MODE="install"
  [[ "${mode}" == "panel" ]] && RENDER_MODE="panel"
  # Panel mode renders into fixed regions inside the alt-screen — the scrolling
  # section_header banner + the cursor-show would corrupt that, so both are suppressed.
  if [[ "${RENDER_MODE:-}" != "panel" ]]; then
    section_header "${title}" "${accent}"
    tp cnorm # show cursor so an interactive engine prompt (collision/recreate) shows
  fi
  STEP_LAST_FAIL_LOG=""
  STEP_FAIL_LOG_PERSISTED=""
  STEP_FAIL_INDEX=""

  # ITEM 4: the dominant progress bar's filled-run accent. Every non-destructive action's filled run
  # is C_ACCENT (Atrium blue) so the bar is the bright brand-primary visual; a destructive run
  # (uninstall passes C_ALERT) keeps amber. Any non-alert section accent still gets a blue bar via
  # the else branch.
  if [[ -n "${accent}" && "${accent}" == "${C_ALERT}" ]]; then
    STEP_BAR_ACCENT_CUR="${C_ALERT}"
  else
    STEP_BAR_ACCENT_CUR="${C_ACCENT}"
  fi

  # VR-9: snapshot $SECONDS at plan start; the delta below feeds outcome_panel's
  # elapsed suffix. $SECONDS is a zero-dependency bash builtin (whole-second resolution).
  local started="${SECONDS}"
  local n="${#STEP_FN[@]}" i=0 rc=0 label fn_str passed=0
  STEP_TOTAL="${n}"
  while [[ "${i}" -lt "${n}" ]]; do
    label="${STEP_LABEL[${i}]}"
    fn_str="${STEP_FN[${i}]}"
    STEP_INDEX=$((i + 1))
    # tense shift (VR-5): hand run_step the index-aligned present-progressive ACTIVE
    # label for the running line; the past label ($label) stamps the resolved line.
    # Fall back to the past label when the active array is short (defensive).
    STEP_LABEL_ACTIVE_CUR="${STEP_LABEL_ACTIVE[${i}]:-${label}}"
    # ITEM 4: prebuild the dominant bar string ONCE per step (the 100ms spinner tick reads
    # STEP_BAR_CUR verbatim, never recomputing it). Built AFTER STEP_INDEX/STEP_TOTAL are set.
    STEP_BAR_CUR="$(build_run_bar)"
    # per-step spinner suppression (BUG-2 B): the parallel STEP_SUPPRESS array (set by
    # build_step_plan; index-aligned, defaults to "" when short) gates the live spinner
    # for stderr-streamed steps whose scrolling sink IS the live feedback.
    STEP_SUPPRESS_SPINNER="${STEP_SUPPRESS[${i}]:-}"
    # word-split fn_str into the engine call (function name + any positional args).
    # IFS is $'\n\t' file-wide, so split on a literal space requires a local IFS.
    local IFS=' '
    # shellcheck disable=SC2086
    run_step "${label}" ${fn_str} || rc=$?
    unset IFS
    IFS=$'\n\t'
    STEP_LABEL_ACTIVE_CUR=""
    STEP_BAR_CUR=""
    STEP_SUPPRESS_SPINNER=""
    if [[ "${rc}" -ne 0 ]]; then
      STEP_FAIL_INDEX=$((i + 1)) # 1-based failing-step index (panel status line)
      break
    fi
    passed=$((passed + 1))
    i=$((i + 1))
  done
  _clear_step_state
  STEP_SUPPRESS_SPINNER=""

  # IMP1: on a failed plan, persist the failing step's captured log OUTSIDE the git tree
  # (${TMPDIR:-/tmp}, NOT GA_ROOT) so the post-run `see: <path>` pointer survives the
  # run_step PASS-rm / abort-trap cleanup. mv (not cp) — the temp is no longer needed.
  if [[ "${rc}" -ne 0 && -n "${STEP_LAST_FAIL_LOG}" && -f "${STEP_LAST_FAIL_LOG}" ]]; then
    local persist="${TMPDIR:-/tmp}/ga-install-fail.$$.log"
    if mv -f "${STEP_LAST_FAIL_LOG}" "${persist}" 2>/dev/null; then
      STEP_FAIL_LOG_PERSISTED="${persist}"
    fi
  fi

  # install: on a SUCCESSFUL plan the last step left a transient resolved progress frame
  # in place (no newline). Erase it with CR + clear-line before outcome_panel stamps the
  # ONE permanent closing line, so the single live row is replaced — not scrolled up. On a
  # FAILED plan run_step already cleared the live row + committed a permanent FAIL row, so
  # nothing transient remains to erase.
  if [[ "${RENDER_MODE}" == "install" && "${rc}" -eq 0 ]]; then
    printf '\r\033[2K' >"${TTY}"
  fi

  # Panel mode draws NO scrolling outcome_panel — the caller (run_action_panel) paints the
  # bottom-pinned status line + the persisted-log pointer instead. Other modes are unchanged.
  if [[ "${RENDER_MODE}" == "panel" ]]; then
    return "${rc}"
  fi

  local elapsed=$((SECONDS - started))
  outcome_panel "${title}" "${rc}" "${passed}" "${n}" "${accent}" "${elapsed}" "${STEP_FAIL_LOG_PERSISTED}"
  return "${rc}"
}

# doctor preflight gate — run_install's opening step: a FAIL aborts the install.
# Mirrors run_install's set +e / trap-suspend / die-on-fail block exactly.
run_doctor_preflight() {
  local doctor_rc
  set +e
  trap - ERR
  run_doctor "preflight"
  doctor_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  # force-quit-class guard: RETURN the doctor rc under the TUI run_step (FAIL panel) — a bare `die` here force-quit the
  # whole process (masked, no panel). This step fn is TUI-only (its sole caller is the install
  # STEP_FN plan; the CLI run_install runs `run_doctor` inline with its own die), so die_step always
  # RETURNS in practice; the CLI branch is a harmless never-reached safety default.
  [[ "${doctor_rc}" -eq 0 ]] || die_step "${doctor_rc}" "doctor preflight failed — aborting install" || return "${doctor_rc}"
}

# monitor production build — run_bootstrap's phase-2 inline step. npm absence is a
# loud-fail with the engine's named build exit code (BOOTSTRAP_EXIT_BUILD=20).
# DRY_RUN is honoured for symmetry (the engine skips build+gate in dry-run).
build_monitor() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping monitor build (mutation-free staging)"
    return 0
  fi
  log "== monitor build: npm run build (cwd=${GA_ROOT}/monitor) =="
  # build_monitor returns on failure: every failure path RETURNS (never exit/die). run_step invokes this step as a
  # SAME-SHELL brace group `{ "$@"; }` under set +e (glass-atrium run_step) then captures
  # `rc=$?`; an in-step `exit`/`die` would terminate the WHOLE TUI process (masked
  # force-quit, no FAIL panel), whereas a `return N` becomes rc → run_plan renders the
  # FAIL panel + persisted see:<log>. RETURN CODE CHOICE: BOOTSTRAP_EXIT_BUILD (20) for
  # EVERY failure path (npm-absent + build-failure) — one uniform build code so the FAIL
  # panel reads identically regardless of which precondition failed.
  if ! command -v npm >/dev/null 2>&1; then
    printf 'FATAL: npm not found — monitor build needs Node.js (install Node 24, then re-run bootstrap)\n' >&2
    return "${BOOTSTRAP_EXIT_BUILD}"
  fi
  # npm-ci self-heal of a partial install (DB present + node_modules absent perpetuates a tree
  # missing tsc, since npm ci runs only in oss-db-setup.sh's DB-absent branch). When the
  # tsc binary is absent, run `npm ci` (idempotent + atomic from package-lock.json) BEFORE
  # the build, inside the SAME subshell so cwd stays monitor/. The .bin/tsc probe (not a
  # bare node_modules/ dir check) catches a partially-populated tree. DUPLICATED verbatim
  # in lib/ga-core.sh run_bootstrap (CLI copy) — see that copy's note; a shared helper is
  # not worth the indirection for a one-line snippet whose failure terminal diverges.
  (cd -- "${GA_ROOT}/monitor" && { [[ -x node_modules/.bin/tsc ]] || npm ci; } && npm run build) || {
    printf 'FATAL: monitor build failed (npm run build) — see output above\n' >&2
    return "${BOOTSTRAP_EXIT_BUILD}"
  }
  log "== monitor build done =="
}

# CHANGE 1 (menu launchd auto-load) — the 11th install step. The interactive menu Install
# was render-only (LOAD_LAUNCHD defaults false in ga-core.sh), so it NEVER registered the 8
# com.glass-atrium.* launchd jobs — the user had to run --load-launchd manually afterward.
# This wrapper flips LOAD_LAUNCHD=true (the SAME engine switch the --load-launchd flag sets)
# then delegates to the existing engine load_launchd_jobs (post-health-gate: this step runs
# only AFTER bootstrap_health_gate passed, so a loaded job always tracks a verified build).
# OPT-OUT (CI / non-interactive): GA_NO_LOAD_LAUNCHD=1 (env, mirrors the GA_* override
# pattern) OR the --no-load-launchd passthrough flag (NO_LOAD_LAUNCHD=true) → keep the
# historical render-only behavior (log + no-op). The 8 daemons run on launchd; 2 of them
# (autoagent-cycle, wiki-compile) invoke Claude on a daily schedule — this is the cost/
# consent note preserved from docs/INSTALL.md §7 (the menu Install now owns the load that
# was previously the operator's manual --load-launchd step).
#
# COST/CONSENT: this registers 8 launchd jobs; 2 of them call Claude daily (autoagent-cycle,
# wiki-compile). Opt out with GA_NO_LOAD_LAUNCHD=1 or --no-load-launchd to defer the load.
menu_load_launchd_jobs() {
  if [[ "${GA_NO_LOAD_LAUNCHD:-}" == "1" || "${NO_LOAD_LAUNCHD:-false}" == "true" ]]; then
    log "== install: launchd auto-load opted out (GA_NO_LOAD_LAUNCHD / --no-load-launchd) — load manually later: re-run with --load-launchd =="
    return 0
  fi
  # flip the engine switch the --load-launchd flag would set, then reuse the engine loader
  # verbatim (idempotent bootout→bootstrap per job; named exit codes 22/23 on a render gap /
  # bootstrap failure propagate as the step's rc). DRY_RUN is handled inside load_launchd_jobs.
  log "== install: registering the 8 com.glass-atrium.* launchd jobs (2 call Claude daily: autoagent-cycle, wiki-compile) =="
  LOAD_LAUNCHD=true
  load_launchd_jobs
}

build_step_plan() {
  local action="$1"
  STEP_LABEL=()
  STEP_LABEL_ACTIVE=()
  STEP_FN=()
  STEP_SUPPRESS=()
  case "${action}" in
    install)
      # run_install body (doctor gate → stale-daemon clear → render → farm → wire → migrate → DB →
      # repoint → post-check → baseline capture) then run_bootstrap's build + health gate, THEN the
      # 14th step that registers the 8 launchd jobs (CHANGE 1: menu Install now auto-loads
      # launchd via menu_load_launchd_jobs, opt-out GA_NO_LOAD_LAUNCHD=1 / --no-load-launchd).
      # The load step runs LAST — post-health-gate by position, so a loaded job always tracks
      # a verified build. baseline capture is run_install's final body step (capture_install_
      # baseline — snapshots the base@install anchor + seeds the base-content store), so the
      # TUI plan must include it or a menu install never anchors its first editable_merge.
      # dry-run/repoint/etc. honour the lib flag vars (load + baseline capture are dry-run
      # reports under --dry-run). The three arrays are a PARALLEL-array contract — they MUST
      # stay equal-length (14 each) and in this order; run_plan iterates [0, #STEP_FN).
      STEP_LABEL=(
        "Doctor preflight"
        "Clear stale daemon sessions"
        "Render config.toml"
        "Render launchd plists"
        "Symlink farm"
        "Wire hooks (settings.json)"
        "Migrate legacy layout"
        "Database bootstrap"
        "launchd repoint"
        "claude liveness (advisory)"
        "Capture install baseline"
        "Monitor build"
        "Monitor health gate"
        "Load launchd jobs"
      )
      STEP_LABEL_ACTIVE=(
        "Running doctor preflight…"
        "Clearing stale daemon sessions…"
        "Rendering config.toml…"
        "Rendering launchd plists…"
        "Farming symlinks…"
        "Wiring hooks…"
        "Migrating legacy layout…"
        "Bootstrapping database…"
        "Repointing launchd…"
        "Checking claude liveness…"
        "Capturing install baseline…"
        "Building monitor…"
        "Gating monitor health…"
        "Loading launchd jobs…"
      )
      STEP_FN=(
        "run_doctor_preflight"
        "kill_daemon_tmux_sessions"
        "render_config"
        "render_plists"
        "run_symlink_farm install"
        "wire_hooks"
        "migrate_layout"
        "setup_database"
        "repoint_launchd"
        "doctor_postcheck"
        "capture_install_baseline"
        "build_monitor"
        "bootstrap_health_gate"
        "menu_load_launchd_jobs"
      )
      ;;
    uninstall)
      # run_uninstall body: launchd teardown → detached-daemon stop → DB drop →
      # node_modules removal → manifest-link removal → orphan sweep → empty-dir
      # cleanup → update-state teardown → hook un-wire → shell-rc PATH-line removal.
      # launchd teardown runs FIRST, then the detached-daemon stop reaches the tmux
      # daemon sessions launchctl bootout does NOT, so all connections drain before
      # the DB is dropped and before their symlinked files are removed. The DB drop is BACKUP-BEFORE-DROP,
      # fail-closed per DB (a failed/empty pre-drop pg_dump skips that DB's drop —
      # lib drop_databases) — reinstall recreates a fresh, consistent DB. empty-dir cleanup +
      # update-state teardown mirror run_uninstall's STEP4/T26 (rmdir-only empty
      # skeletons + non-symlink pause-flag/baseline teardown) so the TUI matches the
      # CLI. The config purge is a SEPARATE confirmed step in dispatch_action (it
      # runs only after a second typed confirmation), so it is not in this base plan.
      # The three arrays below are a PARALLEL-array contract — keep them equal-length
      # and in run_uninstall order.
      STEP_LABEL=(
        "Tear down launchd jobs"
        "Stop detached daemons"
        "Drop databases"
        "Remove node_modules"
        "Remove manifest symlinks"
        "Sweep orphan symlinks"
        "Remove empty directories"
        "Tear down update state"
        "Un-wire hooks (settings.json)"
        "Remove shell rc PATH lines"
      )
      STEP_LABEL_ACTIVE=(
        "Tearing down launchd jobs…"
        "Stopping detached daemons…"
        "Dropping databases…"
        "Removing node_modules…"
        "Removing manifest symlinks…"
        "Sweeping orphan symlinks…"
        "Removing empty directories…"
        "Tearing down update state…"
        "Un-wiring hooks…"
        "Removing shell rc PATH lines…"
      )
      STEP_FN=(
        "unload_launchd_jobs"
        "stop_detached_daemons"
        "drop_databases"
        "remove_node_modules"
        "remove_manifest_links"
        "sweep_orphans"
        "remove_empty_dirs"
        "teardown_update_state"
        "unwire_hooks"
        "remove_rc_lines"
      )
      ;;
    *)
      STEP_LABEL=()
      STEP_LABEL_ACTIVE=()
      STEP_FN=()
      ;;
  esac
}
