# shellcheck shell=bash
# shellcheck disable=SC1010,SC2034,SC2154,SC2312  # SC2154/SC2034: reads + assigns shared globals (STEP_*/WORK_STATE/SPIN_*/IDLE_*/PROG_*/STEP_BAR_*/MENU_DIMMED etc.) declared as stubs in the glass-atrium loader, present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC1010: `WORK_STATE=done` is a value assignment, not the `done` keyword (false positive); SC2312: builder helpers are deliberately invoked inside command substitutions (always succeed via printf, so the masked return carries no signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — work-box + progress/spinner module. SOURCED by the
# glass-atrium entry point (never executed): the shebang, strict mode, IFS, traps and
# every interleaved top-level const/stub (the STEP_*/WORK_STATE/SPIN_*/PROG_* band)
# stay loader-owned so re-sourcing never re-arms them. Owns the work-box body render,
# the step-log classifier/dumper, job-control save/restore, the step + idle spinners,
# the install-progress + run bars and the run/nav state transitions — reading and
# mutating the loader's file-scope step/spinner globals at call time in the same
# sourced shell.
# workbox_body_str — the colorized body content for the work-area box's single content row,
# chosen by WORK_STATE. Returns the bare content (no rails); draw_workbox wraps it in plate_row.
workbox_body_str() {
  case "${WORK_STATE}" in
    run)
      # A run just opened (or a non-spinner repaint): show the present dominant FILLED bar + label
      # so the body is never blank between dim-for-run and the first spinner tick. The spinner
      # subshell overwrites this row in place each tick (the ONE in-place exemption). ITEM 4: the
      # bar (STEP_BAR_CUR, prebuilt) is the visual; it leads, then the label. Falls back to the
      # narrow block-bar counter only when no bar was prebuilt (e.g. a single-step purge).
      local active_label="${STEP_LABEL_ACTIVE_CUR:-}"
      if [[ -n "${STEP_BAR_CUR:-}" ]]; then
        printf ' %s  %s' "${STEP_BAR_CUR}" "$(c "${C_STRONG}" "${active_label}")"
      else
        local counter=""
        if [[ -n "${STEP_INDEX:-}" && -n "${STEP_TOTAL:-}" ]]; then
          # 4a: same STEP_INDEX_BASE offset as the run_step counter so the pre-first-tick body
          # fallback stays on the grand sequence. Empty base => raw i/N (unchanged).
          local disp_i disp_n
          disp_i=$((${STEP_INDEX_BASE:-0} + STEP_INDEX))
          # frozen unified step counter: prefer the frozen GRAND_TOTAL denominator; empty (shared callers) => raw base+STEP_TOTAL.
          disp_n=${GRAND_TOTAL:-$((${STEP_INDEX_BASE:-0} + STEP_TOTAL))}
          counter="$(c "${C_DIM}" "$(build_counter_str "${disp_i}" "${disp_n}")")"
        fi
        printf ' %s%s' "${counter}" "$(c "${C_STRONG}" "${active_label}")"
      fi
      ;;
    done)
      # Per-action done-state DIGEST: an action with a composed summary renders it (its own ✓/✗
      # glyph baked in) instead of the generic "complete"/"failed at step" line. Any other action
      # keeps the generic line.
      if [[ "${DONE_TITLE}" == "Token Setup" && -n "${TOKEN_SUMMARY}" ]]; then
        # ITEM 3: Token Setup renders its OAuth-outcome digest (its own ✓/✗ glyph baked into
        # TOKEN_SUMMARY), not the generic "complete"/"failed at step" line. The token VALUE is
        # never present — only the provisioned/failed verdict + reason text.
        printf ' %s' "${TOKEN_SUMMARY}"
      elif [[ "${DONE_TITLE}" == "Monitor" && -n "${MONITOR_SUMMARY}" ]]; then
        # ITEM 5: Monitor renders its own ✓/!/✗ digest (glyph baked into MONITOR_SUMMARY).
        printf ' %s' "${MONITOR_SUMMARY}"
      elif [[ "${DONE_RC}" -eq 0 ]]; then
        printf ' %s %s' "$(c "${C_OK}" "${G_OK}")" "$(c "${C_OK}" "${DONE_TITLE} complete")"
      else
        printf ' %s %s' "$(c "${C_ALERT}" "${G_FAIL}")" "$(c "${C_ALERT}" "${DONE_TITLE} failed at step ${DONE_IDX}/${DONE_TOTAL}")"
      fi
      ;;
    *)
      # nav: the selected item's description (dim). plate_row clamps an over-wide line.
      printf ' %s' "$(c "${C_DIM}" "$(menu_nav_desc "${SELECTED}")")"
      ;;
  esac
}

# workbox_body_row2_str — the STANDING LINE 2 content for the work-area box, chosen by WORK_STATE.
# The box is now uniformly 4 rows (top rail + LINE1 + LINE2 + bottom rail); this resolves LINE2's
# initial content (the live spinner/idle animator overwrites it in place during a run):
#   run  — blank seed: the forked spinner (or idle spinner) owns LINE2, painting the output tail
#          or slow dots at its first tick, so a blank seed here is overwritten within ~1 tick.
#   done — the per-action 2nd-row digest (Token Setup env-var cue / Monitor dashboard URL) that used
#          to ride an OPTIONAL 3rd body row now occupies this STANDING LINE2; blank for other actions.
#   nav  — blank: LINE1 already carries the selected item's description; LINE2 stays empty.
workbox_body_row2_str() {
  case "${WORK_STATE}" in
    done)
      if [[ "${DONE_TITLE}" == "Token Setup" && -n "${TOKEN_SUMMARY_ROW2}" ]]; then
        printf ' %s' "${TOKEN_SUMMARY_ROW2}"
      elif [[ "${DONE_TITLE}" == "Monitor" && -n "${MONITOR_SUMMARY_ROW2}" ]]; then
        printf ' %s' "${MONITOR_SUMMARY_ROW2}"
      fi
      ;;
    *) : ;; # run + nav: LINE2 is spinner-owned / blank
  esac
}

# draw_workbox — emit the 4-row work-area box (top rail + LINE1 headline + LINE2 detail + bottom
# rail) at the computed WORKBOX_FIRST_ROW anchor. Fullscreen only (the compact path keeps the inline
# scrolling model). A "work" tab on the top rail mirrors the menu's "menu" tab. LINE2 is now a
# STANDING row (async-feel 2-line box): the live spinner/idle animator repaints it in place during a
# run (output tail / slow dots); at rest it carries the done-state digest (Token/Monitor) or blank.
# Rail-safety: the box is drawn ONLY when FULLSCREEN=true, and compute_menu_geometry gates FULLSCREEN
# on MIN_ROWS (which now reserves the 4-row box), so a WINCH that would collide the bottom rail with
# the pinned keyhint degrades to the compact (no-box) path BEFORE draw_workbox runs — no in-line guard.
draw_workbox() {
  [[ "${FULLSCREEN}" == "true" ]] || return 0
  local inner
  inner="$(plate_inner)"
  cup_to "${WORKBOX_FIRST_ROW}" 1
  plate_top "${inner}" " work " "${C_FRAME}"
  plate_row "${inner}" "$(workbox_body_str)"      # LINE 1 headline (bar + i/N + label)
  plate_row "${inner}" "$(workbox_body_row2_str)" # LINE 2 detail (tail / dots / done digest / blank)
  plate_bot "${inner}" "${C_FRAME}"
}

# draw_bottom_row — the ONE bottom-pinned row at MENU_KEYHINT_ROW, chosen by WORK_STATE:
#   nav  — the move/select/quit keyhint legend (draw_keyhint).
#   run  — nothing extra (the workbox body owns the live progress; the bottom row is cleared).
#   done — "press any key to return" (+ on failure, the persisted log path on the workbox
#          body's spare width is NOT used; the path rides this same row, dim).
# Fullscreen only; the compact path emits its keyhint inline from draw_menu.
draw_bottom_row() {
  [[ "${FULLSCREEN}" == "true" ]] || return 0
  cup_to "${MENU_KEYHINT_ROW}" "$((MENU_LEFT + 1))"
  printf '\033[2K' >"${TTY}" # clear the row first so a prior keyhint/status never lingers
  case "${WORK_STATE}" in
    run) : ;; # the workbox body owns the run feedback; bottom row stays clear
    done)
      cup_to "${MENU_KEYHINT_ROW}" "$((MENU_LEFT + 1))"
      if [[ "${DONE_RC}" -eq 0 ]]; then
        tty_out "$(c "${C_DIM}" "press any key to return …")"
      else
        tty_out "$(c "${C_DIM}" "press any key …")"
        if [[ -n "${STEP_FAIL_LOG_PERSISTED}" ]]; then
          tty_out "   $(c "${C_DIM}" "log: ${STEP_FAIL_LOG_PERSISTED}")"
        fi
      fi
      ;;
    *) draw_keyhint ;; # nav: the move/select/quit legend
  esac
}

# _classify_reprint_live — in install mode, reprint the live progress row (with the
# current incrementing STEP_SUPPRESSED_COUNT fold) beneath a just-committed permanent
# line. No-op when CLASSIFY_LIVE_GLYPH is empty (scrolling model). CR + clear-line only.
_classify_reprint_live() {
  [[ -n "${CLASSIFY_LIVE_GLYPH}" ]] || return 0
  redraw_install_progress "${CLASSIFY_LIVE_GLYPH}" "${CLASSIFY_LIVE_COUNTER}" "${CLASSIFY_LIVE_LABEL}" "${STEP_SUPPRESSED_COUNT}"
}

classify_step_log() {
  local log_file="$1"
  STEP_SUPPRESSED_COUNT=0
  [[ -f "${log_file}" ]] || return 0
  local line trimmed
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # GA_VERBOSE firehose: every line LIVE-DIM, no classification (current behavior).
    if [[ "${GA_VERBOSE:-}" == "1" ]]; then
      printf '\r\033[2K      %s\n' "$(c "${C_DIM}" "${line}")" >"${TTY}"
      _classify_reprint_live
      continue
    fi
    # PANEL mode: print NOTHING. Fold every line into the suppressed count.
    # Banners, file paths (target=…, secrets/clauded paths), doctor rows — all folded here,
    # so no raw subprocess noise and no secrets reach the clean panel.
    if [[ "${CLASSIFY_PANEL}" == "true" ]]; then
      STEP_SUPPRESSED_COUNT=$((STEP_SUPPRESSED_COUNT + 1))
      continue
    fi
    # classify on a leading-whitespace-trimmed copy (wire_hooks indents its per-item
    # `  skip (already wired)` / `  wired:` lines, so prefix matches must ignore indent).
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "${trimmed}" in
      # 1 LIVE-LOUD — errors (red glyph carrier, not color-alone).
      FATAL:* | *[Ee]rror* | *[Ff]ailed*)
        printf '\r\033[2K      %s %s\n' "$(c "${C_ALERT}" "${G_FAIL}")" "$(c "${C_ALERT}" "${line}")" >"${TTY}"
        _classify_reprint_live
        ;;
      # 1 LIVE-LOUD — warnings (literal `!` carrier).
      warn\ * | COLLISION:* | *dangling* | skip\ \(foreign*)
        printf '\r\033[2K      %s %s\n' "$(c "${C_INFO}" "!")" "$(c "${C_INFO}" "${line}")" >"${TTY}"
        _classify_reprint_live
        ;;
      # 2 LIVE-DIM — section banners + embedded aggregate summaries.
      ==\ *==* | wire_hooks:*)
        printf '\r\033[2K      %s\n' "$(c "${C_DIM}" "${line}")" >"${TTY}"
        _classify_reprint_live
        ;;
      # 3 SUPPRESS — routine per-item lines (counted only, NOT printed).
      linked:* | skip\ * | skip\(* | wired:* | un-wired:* | ok\ :* | dry-run* | collision:* | orphan-scan:* | render_config:* | repointing* | launchd\ repoint*)
        STEP_SUPPRESSED_COUNT=$((STEP_SUPPRESSED_COUNT + 1))
        ;;
      # 4 DEFAULT — unmatched. Install mode (CLASSIFY_LIVE_GLYPH non-empty): fold routine
      # non-loud subprocess noise (npm/tsc/prisma/vite) into the count — loud lines already
      # surfaced via the arms above, FAIL dumps the full log, GA_VERBOSE=1 shows all. Scrolling
      # mode (uninstall): keep the fail-open-to-VISIBLE permanent print, unchanged.
      *)
        if [[ -n "${CLASSIFY_LIVE_GLYPH}" ]]; then
          STEP_SUPPRESSED_COUNT=$((STEP_SUPPRESSED_COUNT + 1))
          _classify_reprint_live
        else
          printf '\r\033[2K      %s\n' "$(c "${C_DIM}" "${line}")" >"${TTY}"
        fi
        ;;
    esac
  done <"${log_file}"
  return 0
}

# _dump_step_log — on a FAILING step, print the COMPLETE captured STEP_LOG inline
# under a dim header so the full engine evidence stays visible (the file is fully
# written — the fd-2-to-regular-file redirect is synchronous, no truncation). Called
# from run_step's FAIL branch BEFORE any rm. Scrollback-safe (\r\033[2K, no cursor-up).
_dump_step_log() {
  local log_file="$1"
  [[ -f "${log_file}" ]] || return 0
  printf '\r\033[2K      %s\n' "$(c "${C_DIM}" "── captured engine output ──")" >"${TTY}"
  local line
  while IFS= read -r line || [[ -n "${line}" ]]; do
    printf '\r\033[2K      %s\n' "$(c "${C_DIM}" "${line}")" >"${TTY}"
  done <"${log_file}"
  return 0
}

# paint_workbox_body_inner — RAIL-SAFE in-place repaint of the workbox body row (BUG A).
# The per-tick spinner / resolved-frame redraw MUST NOT erase the box's left/right rails.
# The old form cup'd to the LEFT-RAIL column (MENU_LEFT+1) + ESC[2K (full-line erase),
# wiping BOTH rails every tick. This instead cups to the INNER start column (MENU_LEFT+2)
# and writes a bounded field of EXACTLY plate_inner visible cells — over-wide content is
# clamped via plate_truncate, short content right-padded — so the write lands precisely on
# the inner span (cols MENU_LEFT+2 .. MENU_LEFT+1+inner) and the pre-existing rails (drawn
# by the last full plate_row) are never touched. No ESC[2K, no rail rewrite.
# $1 = the colorized body content (no leading rail, no leading inner space — the caller
#       supplies the same content vocabulary plate_row would receive).
# _paint_workbox_inner_at — the rail-safe inner-span painter, parameterized by target ROW so the
# two-line box can repaint LINE 1 (WORKBOX_BODY_ROW) and LINE 2 (WORKBOX_BODY_ROW2) with the SAME
# bounded write (over-wide clamped via plate_truncate, short right-padded). $1 = absolute screen row
# · $2 = colorized body content. Both public wrappers below delegate here (ONE SoT for the bounds).
_paint_workbox_inner_at() {
  local row="$1" content="$2" inner vis pad
  inner="$(plate_inner)"
  vis="$(visible_len "${content}")"
  if [[ "${vis}" -gt "${inner}" ]]; then
    content="$(plate_truncate "${content}" "${inner}")"
    vis="$(visible_len "${content}")"
  fi
  pad=$((inner - vis))
  [[ "${pad}" -lt 0 ]] && pad=0
  cup_to "${row}" "$((MENU_LEFT + 2))"
  printf '%s%*s' "${content}" "${pad}" "" >"${TTY}"
}

# paint_workbox_body_inner — repaint LINE 1 (the headline: bar + i/N + label). $1 = colorized body.
paint_workbox_body_inner() { _paint_workbox_inner_at "${WORKBOX_BODY_ROW}" "$1"; }

# paint_workbox_body_row2_inner — repaint LINE 2 (the status detail: output tail / slow dots), same
# rail-safe inner-span write one row below LINE 1. $1 = colorized detail content.
paint_workbox_body_row2_inner() { _paint_workbox_inner_at "${WORKBOX_BODY_ROW2}" "$1"; }

# _job_control_state / _restore_job_control — snapshot + restore the shell's monitor
# (job-control) flag around a `set +m` window. WHY snapshot-restore, not an unconditional
# `set -m`: this launcher runs NON-INTERACTIVELY (job control OFF by default), so a bare
# `set -m` restore ENABLES it → a later terminal-mode write `stty "${TTY_SAVED}" <"${TTY}"`
# (confirm_typed / preflight_bracket cooked-mode toggle) runs in its own background process
# group, takes SIGTTOU, and STOPS (state T); the launcher then blocks forever on the stopped
# stty (the typed install-consent hang). Snapshot keeps an already-off shell off, yet
# preserves a genuinely-on interactive shell. _job_control_state is a pure read (safe inside
# `$(...)`); _restore_job_control mutates the caller's shell (call it directly, never in `$()`).
_job_control_state() {
  case $- in
    *m*) printf 'on' ;;
    *) printf 'off' ;;
  esac
}

_restore_job_control() {
  if [[ "$1" == "on" ]]; then set -m; else set +m; fi
}

# _spinner_dots — the SLOW-cadence "slowly in progress" dots for a step/window with NO meaningful
# real-time output. A PURE, bash-3.2-safe, set-u-safe helper: the phase is (tick / SPIN_SLOW_DIV) % 3
# → '.' / '..' / '...' (cycling back to '.'), so when the caller invokes it only on the slow boundary
# (tick % SPIN_SLOW_DIV == 0) the dots advance every SPIN_SLOW_DIV ticks ≈ 600ms — decoupled from the
# 100ms spinner frame (NOT the buggy per-tick label roll). $1 = tick index (>=0 integer).
_spinner_dots() {
  local tick="$1" div="${SPIN_SLOW_DIV:-6}" phase
  [[ "${div}" -gt 0 ]] || div=1
  phase=$(((tick / div) % 3))
  case "${phase}" in
    0) printf '.' ;;
    1) printf '..' ;;
    *) printf '...' ;;
  esac
}

# _spinner_rolling_label — the work-box LINE 2 DETAIL resolver (replaces the buggy per-tick
# text roll). A PURE, non-blocking, bash-3.2/set-u-safe helper (reads only its arg + the global
# STEP_LOG_CUR) so it is unit-testable in isolation. The STEP LABEL now lives on LINE 1 (the stable
# headline); this resolves ONLY the LINE 2 detail:
#   1. the running step's captured log (STEP_LOG_CUR) has content => its LATEST line (real-time
#      sub-process output), CR/TAB-sanitized to a single row + width-trimmed so it never wraps. The
#      caller invokes this on the SLOW boundary only, so the tail refreshes at a calm ~600ms cadence
#      (NOT the jittery per-100ms roll) and the tail fork runs ~2/sec, not 10/sec.
#   2. empty / no capture (a non-emitting or no-output step) => the SLOW dots animation (_spinner_dots),
#      expressing "slowly in progress" without a base label (the label is on LINE 1).
# Runs inside the FORKED spinner subshell, so the tail read never slows the parent step. STEP_LOG_CUR
# MUST be assigned to the current step's temp BEFORE the spinner forks (see run_step) or the child
# would snapshot a stale/empty pre-fork value. $1 = tick index (>=0 integer).
_spinner_rolling_label() {
  local tick="$1" cur="${STEP_LOG_CUR:-}" line=""
  if [[ -n "${cur}" && -s "${cur}" ]]; then
    line="$(tail -n 1 "${cur}" 2>/dev/null || true)"
    line="${line//$'\r'/}"  # strip CRs from in-place-updating sub-tools (progress redraws)
    line="${line//$'\t'/ }" # tabs -> spaces so the row stays single-line
    if [[ -n "${line// /}" ]]; then
      # width-trim so a long build line never wraps the single fixed status row (ASCII marker).
      [[ "${#line}" -gt 56 ]] && line="${line:0:55}..."
      printf '%s' "${line}"
      return 0
    fi
  fi
  # FALLBACK: no real-time output => the slow dots animation (advances on the slow boundary).
  _spinner_dots "${tick}"
}

# start_step_spinner / stop_step_spinner — a single-line braille animation tethered
# to one engine step. SCROLLBACK DISCIPLINE (C-2): the step screen runs in normal
# scrollback (dispatch_action dropped the alt-screen via `tp rmcup`), so the spinner
# repaints its OWN status line using ONLY `\r` (carriage return) + `\033[2K` (clear
# line) — NO `\033[s`/`\033[u` save-restore, NO cursor-up, NO absolute positioning
# (any of those would corrupt the classify_step_log tail beneath it).
#
# OFF-TTY CONTRACT: when stdout is not a TTY the spinner is a hard no-op — it emits
# NOTHING (no escapes, no civis) and start returns without forking. CURSOR SAFETY
# (VR-10): the forked spinner installs its OWN `tput cnorm` EXIT/INT/TERM trap, so a
# Ctrl-C mid-spin (or the stop-path `kill`) restores the cursor UNCONDITIONALLY —
# this fires even though dispatch_action already set RAW_ACTIVE=false (restore_terminal
# would early-return and skip cnorm), closing the hidden-cursor footgun.
# (SPIN_PID is declared at file scope ~L101 with the other cleanup-touched globals so the
# EXIT/INT/TERM trap armed before the spinner ever forks cannot trip set -u in cleanup().)
start_step_spinner() {
  local label="$1"
  # $2 (optional) = "prestyled": the label already carries its own C_*/G_* SGR codes
  # (the install single-line body = dim counter + C_STRONG active label), so the spinner
  # MUST NOT re-wrap it in C_STRONG — it paints the label verbatim. Empty (the historical
  # scrolling model) → the spinner colorizes the bare label in C_STRONG as before.
  local prestyled="${2:-}"
  # SINGLE-ACTIVE-SPINNER INVARIANT: a step spinner and the idle spinner MUST NOT animate the box
  # body concurrently (two forked children fighting over WORKBOX_BODY_ROW/ROW2 corrupt the box).
  # Defensively stop any running idle spinner before this step's spinner forks (idempotent no-op
  # when none is running), so an idle window that a caller forgot to close cannot overlap this step.
  stop_idle_spinner
  SPIN_PID=""
  [[ -t 1 ]] || return 0 # off-TTY: no animation, emit nothing

  tp civis # hide the cursor for the spin (the file's guarded tput wrapper)
  # The spinner body runs in a forked subshell with its own unconditional cnorm trap.
  # set +m around the launch suppresses the job-control "[n] PID" notice; the matching wrap
  # on the stop side suppresses the "Terminated" notice when we kill it. RESTORE the prior
  # monitor state (not an unconditional set -m) so a non-interactive run stays job-control-OFF
  # → no SIGTTOU-stop of a later stty (see _job_control_state / _restore_job_control above).
  local jobctl_prev
  jobctl_prev="$(_job_control_state)"
  set +m
  (
    # EXIT keeps the unconditional cnorm on every path; INT/TERM additionally EXIT
    # after restoring the cursor so the parent kill→wait reaps the subshell instead
    # of the bare 'tp cnorm' trap returning into the while-true loop (the deadlock).
    trap 'tp cnorm' EXIT
    trap 'tp cnorm; exit 0' INT TERM
    local IFS=' ' frames frame
    # shellcheck disable=SC2206
    frames=(${SPIN_FRAMES}) # word-split the space-joined frame string
    local n="${#frames[@]}" i=0
    [[ "${n}" -gt 0 ]] || n=1
    # The BASE label is FIXED for the whole step, so colorize it ONCE before the loop.
    # In install mode the label is pre-styled (its own SGR codes already applied) — paint
    # it verbatim; otherwise wrap the bare label in C_STRONG (the historical model).
    local label_str roll=""
    if [[ "${prestyled}" == "prestyled" ]]; then
      label_str="${label}"
    else
      label_str="$(c "${C_STRONG}" "${label}")"
    fi
    while true; do
      # CONSIDER-1 set -u guard: on the INTERNAL passthrough `bootstrap` from a TTY,
      # resolve_glyphs never runs, so SPIN_FRAMES is the empty file-scope default →
      # `frames` is an empty array, n is forced to 1, and `frames[0]` is unbound (set -u
      # trips). The `:-` empty-default keeps the spinner a clean fixed-width space cell on
      # that path; the resolved (menu) path holds real frames, so its cycling is unchanged.
      frame="${frames[$((i % n))]:- }"
      # LINE 2 detail: recompute ONLY on the SLOW boundary (calm ~600ms cadence + tail-fork
      # throttle to ~2/sec), caching `roll` across the intervening 100ms frame ticks. This is
      # the per-tick label-roll FIX — the detail no longer jitters every 100ms.
      if ((i % SPIN_SLOW_DIV == 0)); then
        roll="$(_spinner_rolling_label "${i}")"
      fi
      # Panel mode: repaint the SAME absolute workbox body rows (CUP) so each tick overwrites in
      # place — no scroll, no drift. The spinner owns TWO fixed rows INSIDE the already-stable
      # draw_frame frame (LINE1 headline + LINE2 detail), never a rail/keyhint/menu row. Other
      # modes park at column 0 via CR (scrollback model).
      if [[ "${RENDER_MODE:-}" == "panel" ]]; then
        # LINE 1 (headline: the dominant FILLED bar + the STABLE step label): repainted EVERY tick
        # so the frame glyph animates. The bar (STEP_BAR_CUR, prebuilt per step) leads; the label
        # trails (label_str). BUG A: paint ONLY the inner span (rail-safe) — no ESC[2K of the rail
        # columns, no rail rewrite. The box's left/right rails persist untouched across every tick.
        if [[ -n "${STEP_BAR_CUR:-}" ]]; then
          paint_workbox_body_inner "$(printf '  %s %s  %s' "$(c "${C_INFO}" "${frame}")" "${STEP_BAR_CUR}" "${label_str}")"
        else
          paint_workbox_body_inner "$(printf '  %s %s' "$(c "${C_INFO}" "${frame}")" "${label_str}")"
        fi
        # LINE 2 (detail: real-time output tail / slow dots): repainted ONLY on the slow boundary.
        if ((i % SPIN_SLOW_DIV == 0)); then
          paint_workbox_body_row2_inner "$(printf '  %s' "${roll}")"
        fi
      else
        # Scrolling (non-box) model: ONE line only, so the box's 2-line label/detail split does NOT
        # apply. Keep the ORIGINAL mutually-exclusive label-or-tail: the real-time output tail when the
        # step is emitting, else the STABLE label (the frame glyph supplies the motion — no jittery
        # per-tick text roll). `roll` already holds the tail on the slow boundary when STEP_LOG_CUR is
        # emitting, so pick it then; otherwise show the label.
        local scroll_detail="${label_str}"
        [[ -n "${STEP_LOG_CUR:-}" && -s "${STEP_LOG_CUR:-}" ]] && scroll_detail="${roll}"
        printf '\r\033[2K  %s %s' "$(c "${C_INFO}" "${frame}")" "${scroll_detail}" >"${TTY}"
      fi
      i=$((i + 1))
      sleep 0.1 # 100ms cadence (clig.dev feedback floor)
    done
  ) &
  SPIN_PID=$!
  _restore_job_control "${jobctl_prev}"
}

# stop_step_spinner — kill ONLY the spinner PID, clear its status line, restore the
# cursor. (The old caveat about a blanket `wait` draining run_step's step_sink proc-sub
# is moot — IMP1 replaced the proc-sub with a synchronous fd-2-to-file capture.)
stop_step_spinner() {
  [[ -n "${SPIN_PID}" ]] || return 0
  # RESTORE the prior monitor state (see start_step_spinner) — a bare set -m here would leave
  # job control ON in this non-interactive shell and SIGTTOU-stop a later stty.
  local jobctl_prev
  jobctl_prev="$(_job_control_state)"
  set +m
  kill "${SPIN_PID}" 2>/dev/null || true # default SIGTERM → the spinner's INT/TERM trap exits
  # belt-and-suspenders: if the spinner is somehow still alive (e.g. a future trap
  # regression re-swallows TERM), SIGKILL it — SIGKILL is untrappable, so the
  # following wait CANNOT deadlock. Targets ONLY the spinner PID, never a blanket wait.
  kill -0 "${SPIN_PID}" 2>/dev/null && kill -KILL "${SPIN_PID}" 2>/dev/null || true
  wait "${SPIN_PID}" 2>/dev/null || true # reap ONLY the spinner; the child's TERM trap ran cnorm
  _restore_job_control "${jobctl_prev}"
  SPIN_PID=""
  # BUG A (rail-safe panel clear): in panel RENDER_MODE the spinner's last paint sits on the
  # workbox BODY row, framed by the box's left/right rails. A full-row `\r\033[2K` here erases
  # the WHOLE body row — INCLUDING both rails — and the resolved-frame inner-only repaint that
  # follows never restores them, so steps 2+ render railless. Clear ONLY the inner span instead
  # (paint_workbox_body_inner "" cups to the inner start + writes inner-width spaces), leaving the
  # rail columns untouched. Non-panel scrolling modes (install/uninstall) keep the full-row
  # CR+clear — they have no rails to protect and the scrolling model needs the whole-row wipe.
  # cursor-visibility fix: the cursor visibility folds INTO the RENDER_MODE branch. In panel mode the box
  # never shows a live cursor block, so RE-HIDE (civis) after the child's EXIT-trap cnorm fired — no
  # nav/redraw_frame_inplace path re-emits cnorm, so a stray cnorm here leaks a visible cursor block
  # onto the menu edge + right body. In scrolling mode keep cnorm so the cursor stays visible for the
  # scrollback log. Either branch ends on a `tp` call, so the captured return code is unchanged.
  if [[ "${RENDER_MODE:-}" == "panel" ]]; then
    paint_workbox_body_inner ""      # clear LINE 1 inner span (rails preserved)
    paint_workbox_body_row2_inner "" # clear LINE 2 inner span (no stale tail/dots survives the stop)
    tp civis                         # panel: re-hide (the box has no live cursor)
  else
    printf '\r\033[2K' >"${TTY}" # erase the spinner's status line (scrolling model)
    tp cnorm                     # scrolling: restore the cursor for scrollback visibility
  fi
}

# start_idle_spinner / stop_idle_spinner — the ASYNC-FEEL animator for the BLOCKING windows that
# otherwise render a static/blank box: the initial dependency detection + preflight_count_and_gate,
# the monitor-stop gates, and the preflight->run_plan handoff. It reuses the SAME fork + cnorm-trap +
# job-control machinery as the step spinner, but paints an INDETERMINATE headline (frame + caller
# label, no i/N bar) on LINE 1 every 100ms tick and the SLOW dots on LINE 2 (advanced on the slow
# boundary), so the box always looks alive during a phase with no step-level progress.
#
# Distinct PID (IDLE_PID) so cleanup() reaps it independently; the single-active invariant is held by
# the defensive stop_idle_spinner in start_step_spinner / preflight_bracket / _confirm_pregate.
# RENDER_MODE-INDEPENDENT: these windows run with RENDER_MODE empty (function-local, unset here), so
# the idle spinner ALWAYS paints via the absolute-CUP box painters (never the scrolling `\r` model) —
# it must never fall to a scroll write that would scribble the alt-screen frame. FULLSCREEN-gated
# (the box is fullscreen-only) + off-TTY no-op, mirroring draw_workbox / the step spinner.
# $1 = the (unstyled) status label shown on LINE 1 (e.g. "Detecting dependencies").
start_idle_spinner() {
  local label="$1"
  stop_idle_spinner              # idempotent: never run two idle spinners (restart cleanly)
  IDLE_PID=""
  [[ -t 1 ]] || return 0         # off-TTY: no animation, emit nothing
  [[ "${FULLSCREEN}" == "true" ]] || return 0 # the work box is fullscreen-only (compact path has none)
  tp civis
  local jobctl_prev
  jobctl_prev="$(_job_control_state)"
  set +m
  (
    trap 'tp cnorm' EXIT
    trap 'tp cnorm; exit 0' INT TERM
    local IFS=' ' frames frame
    # shellcheck disable=SC2206
    frames=(${SPIN_FRAMES})
    local n="${#frames[@]}" i=0
    [[ "${n}" -gt 0 ]] || n=1
    local label_str
    label_str="$(c "${C_STRONG}" "${label}")"
    while true; do
      frame="${frames[$((i % n))]:- }"
      # LINE 1 (indeterminate headline: spinner frame + optional bar + the caller's status label) —
      # every tick. RC-1: composite the bar+count UNDER the spinner when a run bar is active (mirror
      # the panel-step arm) so the idle animation keeps the i/N bar visible; else frame + label only.
      if [[ "${WORK_STATE:-}" == "run" && -n "${STEP_BAR_CUR:-}" ]]; then
        paint_workbox_body_inner "$(printf '  %s %s  %s' "$(c "${C_INFO}" "${frame}")" "${STEP_BAR_CUR}" "${label_str}")"
      else
        paint_workbox_body_inner "$(printf '  %s %s' "$(c "${C_INFO}" "${frame}")" "${label_str}")"
      fi
      # LINE 2 (slow dots: "slowly in progress") — advanced ONLY on the slow boundary. An idle
      # window has no meaningful real-time output, so it always shows dots (never a STEP_LOG_CUR
      # tail — a prior step's stale capture MUST NOT leak here, hence _spinner_dots directly).
      if ((i % SPIN_SLOW_DIV == 0)); then
        paint_workbox_body_row2_inner "$(printf '  %s' "$(_spinner_dots "${i}")")"
      fi
      i=$((i + 1))
      sleep 0.1
    done
  ) &
  IDLE_PID=$!
  _restore_job_control "${jobctl_prev}"
}

# stop_idle_spinner — kill ONLY the idle PID, clear its two box rows (rail-safe inner span), restore
# the cursor. Idempotent (no-op when IDLE_PID is empty). rc-safe: masks every command so a stray
# non-zero can never clobber a caller's captured exit code (the exit-code-before-stop discipline in
# the W1/W2 gate wraps still applies — the wrapped rc is captured BEFORE this runs).
stop_idle_spinner() {
  [[ -n "${IDLE_PID}" ]] || return 0
  local jobctl_prev
  jobctl_prev="$(_job_control_state)"
  set +m
  kill "${IDLE_PID}" 2>/dev/null || true
  kill -0 "${IDLE_PID}" 2>/dev/null && kill -KILL "${IDLE_PID}" 2>/dev/null || true
  wait "${IDLE_PID}" 2>/dev/null || true
  _restore_job_control "${jobctl_prev}"
  IDLE_PID=""
  # Clear both box rows on the fullscreen path (rail-safe inner-span clear). The next render
  # (a bracket rmcup, a panel step, or the following idle window) repaints from a clean body.
  if [[ "${FULLSCREEN}" == "true" ]]; then
    # RC-1: in run-state WITH an active step bar, restore the bar+count resting body instead of
    # blanking — the conditional panel steps between idle windows otherwise leave a blank run body.
    # COMPOUND gate (run AND non-empty build_run_bar): the no-step-count windows (Detecting/Freeing/
    # Preparing) also run under WORK_STATE=run but have an empty bar and correctly rest blank.
    local run_bar=""
    if [[ "${WORK_STATE:-}" == "run" ]]; then
      run_bar="$(build_run_bar)"
    fi
    if [[ -n "${run_bar}" ]]; then
      STEP_BAR_CUR="${run_bar}"
      paint_workbox_body_inner "$(workbox_body_str)"
      paint_workbox_body_row2_inner ""
    else
      paint_workbox_body_inner ""
      paint_workbox_body_row2_inner ""
    fi
  fi
  # cursor-visibility fix: the idle spinner runs ONLY in the fullscreen box, which never shows a live cursor
  # block, so end on civis (re-hide) rather than cnorm. The cooked-prompt callers (_confirm_pregate,
  # preflight_bracket, token pre-gate) re-assert their OWN cnorm AFTER this returns, so the consent
  # prompts stay visible; the box/menu paths (which do NOT re-emit cnorm) keep the cursor hidden.
  tp civis
}

# build_install_progress_body — the styled progress-line body MINUS the leading
# spinner cell (the spinner subshell owns the frame). $1=colorized counter (already
# C_DIM-wrapped) · $2=active label · $3=suppressed count. The label is the ONE
# C_STRONG emphasis on the row; the counter + fold stay dim. Fold shown only when >0.
build_install_progress_body() {
  local counter="$1" active_label="$2" suppressed="$3"
  local fold=""
  if [[ "${suppressed}" -gt 0 ]]; then
    fold=" $(c "${C_DIM}" "${G_DOT} ${suppressed} items")"
  fi
  printf '%s%s%s' "${counter}" "$(c "${C_STRONG}" "${active_label}")" "${fold}"
}

# redraw_install_progress — paint the static (non-spinner) progress row in place when
# the spinner is NOT animating it (the spinner-suppressed reset before a step, and the
# transient resolved frame after a step). CR + clear-line, NO trailing newline, so the
# cursor stays parked at column 0 of the SAME row to be overwritten by the next redraw.
# $1=leading glyph cell (spinner frame / resolved G_OK — already colorized) · rest as
# build_install_progress_body. The 2-space indent matches the spinner row (L957).
redraw_install_progress() {
  local glyph="$1" counter="$2" active_label="$3" suppressed="$4"
  # Panel mode (in-alt-screen work-area box): repaint the SINGLE fixed body row via an
  # absolute CUP to WORKBOX_BODY_ROW + clear-line (no scroll, no drift), and DROP the
  # `N items` fold — the box shows ONLY spinner + counter + label. The counter passed
  # in panel mode is the `[i/N]` step stamp, not the block-bar gauge.
  if [[ "${RENDER_MODE:-}" == "panel" ]]; then
    # ITEM 4: the dominant FILLED bar (STEP_BAR_CUR) leads, then the label — the panel counter is
    # empty (the bar carries i/N). When the bar is unset (defensive) fall back to the plain body.
    # BUG A: paint ONLY the inner span (rail-safe) so the box's left/right rails survive the repaint.
    if [[ -n "${STEP_BAR_CUR:-}" ]]; then
      paint_workbox_body_inner "$(printf '  %s %s  %s' "${glyph}" "${STEP_BAR_CUR}" "$(c "${C_STRONG}" "${active_label}")")"
    else
      paint_workbox_body_inner "$(printf '  %s %s' "${glyph}" "$(build_install_progress_body "${counter}" "${active_label}" 0)")"
    fi
    return 0
  fi
  printf '\r\033[2K  %s %s' "${glyph}" "$(build_install_progress_body "${counter}" "${active_label}" "${suppressed}")" >"${TTY}"
}

# progress_bar_width — the dominant run-state bar's cell width (ITEM 4). A WIDE band (18 cells)
# clamped to the box inner minus the ` i/N` suffix + a label-room reserve, floored at 8 so a
# narrow terminal still shows a recognizable bar. MENU_INNER is the cached fullscreen inner width.
progress_bar_width() {
  local want=18 inner="${MENU_INNER:-52}" reserve=20 avail
  avail=$((inner - reserve))
  [[ "${avail}" -lt "${want}" ]] && want="${avail}"
  [[ "${want}" -lt 8 ]] && want=8
  printf '%s' "${want}"
}

# build_run_bar — assemble the per-step dominant bar string from the live STEP_INDEX/STEP_TOTAL
# (ITEM 4). The filled-run accent is STEP_BAR_ACCENT_CUR (C_ACCENT non-destructive / C_ALERT destructive),
# defaulting to C_ACCENT. Empty when the step globals are unset. Built ONCE per step into STEP_BAR_CUR.
build_run_bar() {
  [[ -n "${STEP_INDEX:-}" && -n "${STEP_TOTAL:-}" ]] || return 0
  # 4a: render the STEP_INDEX_BASE-OFFSET index/total so the install-panel bar continues ONE grand
  # sequence across the preflight->install handoff (base+1 .. base+n). Empty base => 0 offset =>
  # raw STEP_INDEX/STEP_TOTAL, byte-for-byte unchanged for every shared uninstall/db/token/purge caller.
  local disp_i disp_n
  disp_i=$((${STEP_INDEX_BASE:-0} + STEP_INDEX))
  # frozen unified step counter: prefer the frozen GRAND_TOTAL denominator; empty (shared callers) => raw base+STEP_TOTAL.
  disp_n=${GRAND_TOTAL:-$((${STEP_INDEX_BASE:-0} + STEP_TOTAL))}
  build_progress_bar "${disp_i}" "${disp_n}" "$(progress_bar_width)" "${STEP_BAR_ACCENT_CUR:-${C_ACCENT}}"
}

# enter_run_state — the dim-for-run transition (REDRAW_MODEL): set WORK_STATE=run +
# MENU_DIMMED=true, then full-frame redraw via draw_frame. draw_menu greys every label +
# drops the caret/selection; draw_workbox renders the run body (the spinner then owns its
# in-place body row); draw_bottom_row clears the keyhint row. No partial repaint — the full
# clear makes a leftover bright row / orphan rail impossible.
enter_run_state() {
  WORK_STATE=run
  MENU_DIMMED=true
  redraw_frame_inplace
}

# enter_nav_state — the un-dim / return-to-nav transition (REDRAW_MODEL): clear WORK_STATE
# back to nav + MENU_DIMMED=false, then full-frame redraw. The work-area box reverts to the
# selected item's description + the bottom row to the move/select/quit legend — and because
# draw_frame full-clears first, no doubled keyhint / leftover status / orphan rail survives.
enter_nav_state() {
  WORK_STATE=nav
  MENU_DIMMED=false
  redraw_frame_inplace
}

# status_line — the completion transition (REDRAW_MODEL): record the result into the DONE_*
# state, set WORK_STATE=done, then full-frame redraw. draw_workbox renders the concise
# success/fail body line (success or "failed at step N/T" — NO log body, NO banner) and
# draw_bottom_row renders "press any key …" + the persisted log path (path only, on failure).
# State carries a glyph (G_OK/G_FAIL) in ADDITION to color (colorblind-safe). $1=rc ·
# $2=action title · $3=failing step index · $4=total steps. Name kept for the call sites.
status_line() {
  DONE_RC="$1"
  DONE_TITLE="$2"
  DONE_IDX="$3"
  DONE_TOTAL="$4"
  WORK_STATE=done
  MENU_DIMMED=true # the menu stays paused/dim until the user dismisses the done line
  redraw_frame_inplace
}
