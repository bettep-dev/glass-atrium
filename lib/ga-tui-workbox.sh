# shellcheck shell=bash
# shellcheck disable=SC1010,SC2034,SC2154,SC2312  # SC2154/SC2034: reads + assigns shared globals (STEP_*/WORK_STATE/SPIN_*/IDLE_*/PROG_*/STEP_BAR_*/MENU_DIMMED etc.) declared as stubs in the glass-atrium loader, present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC1010: `WORK_STATE=done` is a value assignment, not the `done` keyword (false positive); SC2312: builder helpers are deliberately invoked inside command substitutions (always succeed via printf, so the masked return carries no signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — work-box + progress/spinner module. SOURCED by the glass-atrium entry
# point (never executed): shebang/strict-mode/IFS/traps + the top-level const/stub band
# (STEP_*/WORK_STATE/SPIN_*/PROG_*) stay loader-owned so re-sourcing never re-arms them. Owns the
# work-box body render, step-log classifier/dumper, job-control save/restore, step + idle spinners,
# install-progress + run bars and run/nav transitions — reading/mutating the loader's file-scope
# step/spinner globals in the same sourced shell.
# workbox_body_str — the colorized body content for the work-area box's single content row,
# chosen by WORK_STATE. Returns the bare content (no rails); draw_workbox wraps it in plate_row.
workbox_body_str() {
  case "${WORK_STATE}" in
    run)
      # Run just opened (or non-spinner repaint): FILLED bar + label so the body is never blank
      # between dim-for-run and first tick (spinner subshell then overwrites in place each tick —
      # the ONE in-place exemption). ITEM 4: prebuilt bar (STEP_BAR_CUR) leads then label; falls
      # back to the narrow block-bar counter only when no bar prebuilt (e.g. single-step purge).
      local active_label="${STEP_LABEL_ACTIVE_CUR:-}"
      if [[ -n "${STEP_BAR_CUR:-}" ]]; then
        printf ' %s  %s' "${STEP_BAR_CUR}" "$(c "${C_STRONG}" "${active_label}")"
      else
        local counter=""
        if [[ -n "${STEP_INDEX:-}" && -n "${STEP_TOTAL:-}" ]]; then
          # 4a: STEP_INDEX_BASE offset (as run_step) keeps the pre-first-tick body fallback on the grand sequence; empty base => raw i/N.
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
      # Per-action done DIGEST: an action with a composed summary renders it (own ✓/✗ glyph baked
      # in) instead of the generic "complete"/"failed at step" line; other actions keep the generic.
      if [[ "${DONE_TITLE}" == "Token Setup" && -n "${TOKEN_SUMMARY}" ]]; then
        # ITEM 3: Token Setup renders its OAuth-outcome digest (glyph in TOKEN_SUMMARY). The token
        # VALUE is never present — only the provisioned/failed verdict + reason text.
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

# workbox_body_row2_str — the STANDING LINE 2 content for the 4-row work box, chosen by WORK_STATE
# (the live spinner/idle animator overwrites it in place during a run):
#   run  — blank seed: the spinner/idle owns LINE2 (output tail / slow dots), overwritten within ~1 tick.
#   done — the per-action 2nd-row digest (Token Setup env cue / Monitor dashboard); blank for others.
#   nav  — blank: LINE1 already carries the selected item's description.
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

# draw_workbox — emit the LOWER half of the merged menu+work box: the internal 'work' divider rail +
# LINE1 headline + LINE2 detail + the SINGLE shared bottom rail, at the WORKBOX_FIRST_ROW anchor.
# Fullscreen only (compact keeps the inline scrolling model). The divider is a plate_mid rail — side
# rails run THROUGH it (junction glyphs ├ ┤), splitting the ONE box into a menu section (drawn above by
# draw_menu, top rail + items, NO bottom rail) and this work section; the 'work' tab mirrors the menu
# section's 'menu' tab. LINE2 is a STANDING row the spinner/idle repaints in place during a run, else
# the done-state digest (Token/Monitor) or blank. Rail-safety: no in-line guard — compute_menu_geometry
# gates FULLSCREEN on MIN_ROWS (reserves the box), so a rail-colliding WINCH degrades to the compact
# no-box path BEFORE draw_workbox runs.
# FRAME GATE (must MIRROR draw_menu): draw_menu frames only at cols >= 56, but compute_menu_geometry
# admits FULLSCREEN from MIN_COLS=50, so cols 50-55 is fullscreen-yet-unframed — draw_menu emits
# rail-less item rows there. A plate_mid ├┤ divider in that band would dangle its junctions below a
# rail-less menu, so below the frame gate close the work area as a SELF-CONTAINED box (plate_top ╭╮
# corners) instead of the merged-box divider.
draw_workbox() {
  [[ "${FULLSCREEN}" == "true" ]] || return 0
  local inner cols
  inner="$(plate_inner)"
  cols="$(term_cols)"
  cup_to "${WORKBOX_FIRST_ROW}" 1
  if [[ "${cols}" -lt 56 ]]; then
    plate_top "${inner}" " work " "${C_FRAME}"    # unframed band (cols 50-55): self-contained top rail (╭╮), no ├┤ junctions
  else
    plate_mid "${inner}" " work " "${C_FRAME}"    # INTERNAL divider rail (├ ┤ junctions), splits the merged box
  fi
  plate_row "${inner}" "$(workbox_body_str)"      # LINE 1 headline (bar + i/N + label)
  plate_row "${inner}" "$(workbox_body_row2_str)" # LINE 2 detail (tail / dots / done digest / blank)
  plate_bot "${inner}" "${C_FRAME}"               # the SINGLE shared bottom rail closing the whole box
}

# draw_bottom_row — the ONE bottom-pinned row at MENU_KEYHINT_ROW, chosen by WORK_STATE. Fullscreen
# only (compact emits its keyhint inline from draw_menu):
#   nav  — the move/select/quit keyhint legend (draw_keyhint).
#   run  — nothing extra (the workbox body owns the live progress; the row is cleared).
#   done — "press any key to return" (+ on failure the persisted log path, dim, on this same row).
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

# _classify_reprint_live — install mode: reprint the live progress row (current STEP_SUPPRESSED_COUNT
# fold) beneath a just-committed line. No-op when CLASSIFY_LIVE_GLYPH empty (scrolling). CR + clear-line.
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
    # PANEL mode: print NOTHING, fold every line into the suppressed count — banners, file paths
    # (target=…, secrets/clauded paths), doctor rows all folded, so no raw noise or secrets reach the panel.
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
      # 4 DEFAULT — unmatched. Install mode (CLASSIFY_LIVE_GLYPH non-empty): fold routine non-loud
      # noise (npm/tsc/prisma/vite) into the count (loud lines surfaced above, FAIL dumps the full
      # log, GA_VERBOSE=1 shows all). Scrolling mode (uninstall): keep the fail-open VISIBLE print.
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

# _dump_step_log — on a FAILING step, print the COMPLETE captured STEP_LOG inline under a dim header
# (the fd-2-to-file redirect is synchronous, so the file is fully written — no truncation). Called
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

# _paint_workbox_inner_at — RAIL-SAFE in-place repaint of a workbox body row (BUG A), parameterized
# by target ROW so the two-line box repaints LINE 1 (WORKBOX_BODY_ROW) and LINE 2 (WORKBOX_BODY_ROW2)
# with the SAME bounded write. The per-tick spinner/resolved-frame redraw MUST NOT erase the box's
# left/right rails: cup to the INNER start column (MENU_LEFT+2) and write EXACTLY plate_inner visible
# cells (over-wide clamped via plate_truncate, short right-padded) so the write lands on the inner
# span and the rails are never touched — no ESC[2K, no rail rewrite. $1 = absolute screen row · $2 =
# colorized body content (no leading rail/inner space). Both public wrappers below delegate here (ONE SoT).
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

# paint_workbox_body_row2_inner — repaint LINE 2 (status detail: output tail / slow dots), rail-safe. $1 = detail.
paint_workbox_body_row2_inner() { _paint_workbox_inner_at "${WORKBOX_BODY_ROW2}" "$1"; }

# _job_control_state / _restore_job_control — snapshot + restore the shell's monitor (job-control)
# flag around a `set +m` window. WHY snapshot-restore, not an unconditional `set -m`: this launcher
# runs NON-INTERACTIVELY (job control OFF), so a bare `set -m` restore ENABLES it → a later
# `stty "${TTY_SAVED}" <"${TTY}"` (confirm_typed / preflight_bracket cooked-mode toggle) runs in its
# own process group, takes SIGTTOU, STOPS (state T), and the launcher blocks forever on it (the typed
# install-consent hang). Snapshot keeps an already-off shell off, preserves a genuinely-on interactive
# shell. _job_control_state is a pure read (safe in `$(...)`); _restore_job_control mutates the caller (call directly, never in `$()`).
_job_control_state() {
  case $- in
    *m*) printf 'on' ;;
    *) printf 'off' ;;
  esac
}

_restore_job_control() {
  if [[ "$1" == "on" ]]; then set -m; else set +m; fi
}

# _spinner_dots — SLOW-cadence "slowly in progress" dots for a step/window with NO real-time output.
# PURE, bash-3.2/set-u-safe: phase = (tick / SPIN_SLOW_DIV) % 3 → '.' / '..' / '...'. Called only on
# the slow boundary (tick % SPIN_SLOW_DIV == 0) so the dots advance every SPIN_SLOW_DIV ticks ≈ 600ms,
# decoupled from the 100ms spinner frame. $1 = tick index (>=0 integer).
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

# _spinner_rolling_label — the work-box LINE 2 DETAIL resolver. PURE, non-blocking, bash-3.2/set-u-safe
# (reads only its arg + the global STEP_LOG_CUR, so unit-testable). The STEP LABEL lives on LINE 1;
# this resolves ONLY the LINE 2 detail:
#   1. STEP_LOG_CUR has content => its LATEST line (real-time output), CR/TAB-sanitized to one row +
#      width-trimmed so it never wraps. Called on the SLOW boundary only, so the tail refreshes at a
#      calm ~600ms cadence and the tail fork runs ~2/sec.
#   2. empty / no capture => the SLOW dots (_spinner_dots), no base label (the label is on LINE 1).
# Runs inside the FORKED spinner subshell (the tail read never slows the parent). STEP_LOG_CUR MUST be
# assigned to the step's temp BEFORE the spinner forks (see run_step) or the child snapshots a stale
# value. $1 = tick index (>=0 integer).
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

# start_step_spinner / stop_step_spinner — a single-line braille animation tethered to one engine
# step. SCROLLBACK DISCIPLINE (C-2): the step screen runs in normal scrollback (dispatch_action
# dropped the alt-screen via `tp rmcup`), so the spinner repaints its OWN status line using ONLY `\r`
# + `\033[2K` — NO save-restore, NO cursor-up, NO absolute positioning (any would corrupt the
# classify_step_log tail beneath it). OFF-TTY CONTRACT: non-TTY stdout => hard no-op (emits NOTHING,
# start returns without forking). CURSOR SAFETY (VR-10): the forked spinner installs its OWN `tput
# cnorm` EXIT/INT/TERM trap, so a Ctrl-C mid-spin (or the stop-path `kill`) restores the cursor
# UNCONDITIONALLY — this fires even though dispatch_action set RAW_ACTIVE=false (restore_terminal would
# early-return + skip cnorm), closing the hidden-cursor footgun. (SPIN_PID is declared at file scope
# with the other cleanup-touched globals so the EXIT/INT/TERM trap armed pre-fork cannot trip set -u in cleanup().)
start_step_spinner() {
  local label="$1"
  # $2 (optional) = "prestyled": the label already carries its own C_*/G_* SGR codes (install body =
  # dim counter + C_STRONG label), so the spinner paints it verbatim (no re-wrap in C_STRONG). Empty
  # (scrolling model) → the spinner colorizes the bare label in C_STRONG.
  local prestyled="${2:-}"
  # SINGLE-ACTIVE-SPINNER INVARIANT: a step spinner and the idle spinner MUST NOT animate the box body
  # concurrently (two forked children fighting over WORKBOX_BODY_ROW/ROW2 corrupt the box). Defensively
  # stop any running idle spinner before this step's spinner forks (idempotent no-op when none runs).
  stop_idle_spinner
  SPIN_PID=""
  [[ -t 1 ]] || return 0 # off-TTY: no animation, emit nothing

  tp civis # hide the cursor for the spin (the file's guarded tput wrapper)
  # The spinner body runs in a forked subshell with its own unconditional cnorm trap. set +m around
  # the launch suppresses the "[n] PID" notice (the stop-side wrap suppresses "Terminated" on kill).
  # RESTORE the prior monitor state (not an unconditional set -m) so a non-interactive run stays
  # job-control-OFF → no SIGTTOU-stop of a later stty (see _job_control_state / _restore_job_control).
  local jobctl_prev
  jobctl_prev="$(_job_control_state)"
  set +m
  (
    # EXIT keeps the unconditional cnorm on every path; INT/TERM additionally EXIT after the cursor
    # restore so the parent kill→wait reaps the subshell (not the bare cnorm trap returning into the loop = deadlock).
    trap 'tp cnorm' EXIT
    trap 'tp cnorm; exit 0' INT TERM
    local IFS=' ' frames frame
    # shellcheck disable=SC2206
    frames=(${SPIN_FRAMES}) # word-split the space-joined frame string
    local n="${#frames[@]}" i=0
    [[ "${n}" -gt 0 ]] || n=1
    # The BASE label is FIXED for the whole step, so colorize it ONCE before the loop. Install mode:
    # pre-styled label painted verbatim; otherwise wrap the bare label in C_STRONG.
    local label_str roll=""
    if [[ "${prestyled}" == "prestyled" ]]; then
      label_str="${label}"
    else
      label_str="$(c "${C_STRONG}" "${label}")"
    fi
    while true; do
      # CONSIDER-1 set -u guard: on the INTERNAL passthrough `bootstrap` from a TTY, resolve_glyphs
      # never runs, so SPIN_FRAMES is the empty default → `frames` empty, n forced to 1, `frames[0]`
      # unbound (set -u trips). The `:-` empty-default paints a clean fixed-width space cell there; the resolved menu path holds real frames.
      frame="${frames[$((i % n))]:- }"
      # LINE 2 detail: recompute ONLY on the SLOW boundary (~600ms cadence + tail-fork throttle
      # ~2/sec), caching `roll` across the intervening 100ms frame ticks.
      if ((i % SPIN_SLOW_DIV == 0)); then
        roll="$(_spinner_rolling_label "${i}")"
      fi
      # Panel mode: repaint the SAME absolute workbox body rows (CUP) so each tick overwrites in place
      # — no scroll, no drift. The spinner owns TWO fixed rows inside the stable draw_frame frame (LINE1
      # headline + LINE2 detail), never a rail/keyhint/menu row. Other modes park at column 0 via CR.
      if [[ "${RENDER_MODE:-}" == "panel" ]]; then
        # LINE 1 (headline: FILLED bar + STABLE step label): repainted EVERY tick so the frame glyph
        # animates. The prebuilt bar (STEP_BAR_CUR) leads, the label (label_str) trails. BUG A: paint
        # ONLY the inner span (rail-safe) — no ESC[2K of the rail columns, rails persist untouched.
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
        # Scrolling (non-box) model: ONE line, so the 2-line label/detail split does NOT apply. Keep
        # the mutually-exclusive label-or-tail: the output tail when the step is emitting, else the
        # STABLE label (the frame glyph supplies the motion). `roll` holds the tail on the slow
        # boundary when STEP_LOG_CUR is emitting, so pick it then; otherwise show the label.
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

# stop_step_spinner — kill ONLY the spinner PID, clear its status line, restore the cursor.
stop_step_spinner() {
  [[ -n "${SPIN_PID}" ]] || return 0
  # RESTORE the prior monitor state (see start_step_spinner) — a bare set -m would leave job control ON and SIGTTOU-stop a later stty.
  local jobctl_prev
  jobctl_prev="$(_job_control_state)"
  set +m
  kill "${SPIN_PID}" 2>/dev/null || true # default SIGTERM → the spinner's INT/TERM trap exits
  # belt-and-suspenders: if the spinner is somehow still alive (a future trap regression re-swallows
  # TERM), SIGKILL it — untrappable, so the following wait CANNOT deadlock. ONLY the spinner PID, never a blanket wait.
  kill -0 "${SPIN_PID}" 2>/dev/null && kill -KILL "${SPIN_PID}" 2>/dev/null || true
  wait "${SPIN_PID}" 2>/dev/null || true # reap ONLY the spinner; the child's TERM trap ran cnorm
  _restore_job_control "${jobctl_prev}"
  SPIN_PID=""
  # BUG A (rail-safe panel clear): in panel RENDER_MODE the spinner's last paint sits on the workbox
  # BODY row framed by the rails. A full-row `\r\033[2K` would erase the WHOLE row (INCLUDING both
  # rails) and the resolved-frame inner-only repaint never restores them → steps 2+ render railless.
  # Clear ONLY the inner span (paint_workbox_body_inner "" cups the inner start + writes inner-width
  # spaces), rails untouched. Non-panel scrolling modes keep the full-row CR+clear (no rails, the
  # scrolling model needs the whole-row wipe). cursor-visibility fix (folds into the RENDER_MODE branch):
  # panel mode never shows a live cursor, so RE-HIDE (civis) after the child's EXIT-trap cnorm — no
  # nav/redraw_frame_inplace re-emits cnorm, so a stray cnorm would leak a visible cursor block onto the
  # menu edge + right body; scrolling mode keeps cnorm for the scrollback log. Either branch ends on a `tp` call, so the captured rc is unchanged.
  if [[ "${RENDER_MODE:-}" == "panel" ]]; then
    paint_workbox_body_inner ""      # clear LINE 1 inner span (rails preserved)
    paint_workbox_body_row2_inner "" # clear LINE 2 inner span (no stale tail/dots survives the stop)
    tp civis                         # panel: re-hide (the box has no live cursor)
  else
    printf '\r\033[2K' >"${TTY}" # erase the spinner's status line (scrolling model)
    tp cnorm                     # scrolling: restore the cursor for scrollback visibility
  fi
}

# start_idle_spinner / stop_idle_spinner — the ASYNC-FEEL animator for BLOCKING windows that otherwise
# render a static/blank box (initial dependency detection + preflight_count_and_gate, the monitor-stop
# gates, the preflight->run_plan handoff). Reuses the step spinner's fork + cnorm-trap + job-control
# machinery, but paints an INDETERMINATE headline (frame + caller label, no i/N bar) on LINE 1 every
# 100ms tick + the SLOW dots on LINE 2 (slow boundary), so the box always looks alive. Distinct PID
# (IDLE_PID) so cleanup() reaps it independently; the single-active invariant is held by the defensive
# stop_idle_spinner in start_step_spinner / preflight_bracket / _confirm_pregate. RENDER_MODE-INDEPENDENT:
# these windows run RENDER_MODE empty, so the idle spinner ALWAYS paints via the absolute-CUP box
# painters (never the scrolling `\r` model that would scribble the alt-screen frame). FULLSCREEN-gated +
# off-TTY no-op, mirroring draw_workbox. $1 = the (unstyled) LINE 1 status label (e.g. "Detecting dependencies").
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
      # LINE 1 (indeterminate headline: frame + optional bar + caller label) — every tick. RC-1:
      # composite the bar+count UNDER the spinner when a run bar is active (keeps i/N visible); else frame + label only.
      if [[ "${WORK_STATE:-}" == "run" && -n "${STEP_BAR_CUR:-}" ]]; then
        paint_workbox_body_inner "$(printf '  %s %s  %s' "$(c "${C_INFO}" "${frame}")" "${STEP_BAR_CUR}" "${label_str}")"
      else
        paint_workbox_body_inner "$(printf '  %s %s' "$(c "${C_INFO}" "${frame}")" "${label_str}")"
      fi
      # LINE 2 (slow dots) — advanced ONLY on the slow boundary. An idle window has no real-time
      # output, so always dots (never a STEP_LOG_CUR tail — a prior step's stale capture MUST NOT leak, hence _spinner_dots directly).
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
# the cursor. Idempotent (no-op when IDLE_PID empty). rc-safe: masks every command so a stray non-zero
# can never clobber a caller's captured rc (the W1/W2 gate wraps capture the wrapped rc BEFORE this runs).
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
  # Clear both box rows on the fullscreen path (rail-safe inner-span clear); the next render repaints from a clean body.
  if [[ "${FULLSCREEN}" == "true" ]]; then
    # RC-1: in run-state WITH an active step bar, restore the bar+count resting body instead of
    # blanking (conditional panel steps between idle windows otherwise leave a blank run body). COMPOUND
    # gate (run AND non-empty build_run_bar): no-step-count windows (Detecting/Freeing/Preparing) run under WORK_STATE=run but have an empty bar and correctly rest blank.
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
  # cursor-visibility fix: the idle spinner runs ONLY in the fullscreen box (never a live cursor), so
  # end on civis (re-hide) not cnorm. The cooked-prompt callers (_confirm_pregate, preflight_bracket,
  # token pre-gate) re-assert their OWN cnorm AFTER this returns (consent prompts stay visible); box/menu paths keep the cursor hidden.
  tp civis
}

# build_install_progress_body — the styled progress-line body MINUS the leading spinner cell (the
# spinner subshell owns the frame). $1=colorized counter (C_DIM-wrapped) · $2=active label · $3=suppressed
# count. The label is the ONE C_STRONG emphasis; the counter + fold stay dim. Fold shown only when >0.
build_install_progress_body() {
  local counter="$1" active_label="$2" suppressed="$3"
  local fold=""
  if [[ "${suppressed}" -gt 0 ]]; then
    fold=" $(c "${C_DIM}" "${G_DOT} ${suppressed} items")"
  fi
  printf '%s%s%s' "${counter}" "$(c "${C_STRONG}" "${active_label}")" "${fold}"
}

# redraw_install_progress — paint the static (non-spinner) progress row in place when the spinner is
# NOT animating it (the spinner-suppressed reset before a step, the transient resolved frame after).
# CR + clear-line, NO trailing newline, so the cursor stays parked at column 0 of the SAME row for the
# next redraw. $1=leading glyph cell (spinner frame / resolved G_OK, colorized) · rest as build_install_progress_body.
redraw_install_progress() {
  local glyph="$1" counter="$2" active_label="$3" suppressed="$4"
  # Panel mode (in-alt-screen work box): repaint the SINGLE fixed body row via absolute CUP to
  # WORKBOX_BODY_ROW + clear-line (no scroll/drift), and DROP the `N items` fold — the box shows
  # ONLY spinner + counter + label. The panel counter is the `[i/N]` step stamp, not the block-bar gauge.
  if [[ "${RENDER_MODE:-}" == "panel" ]]; then
    # ITEM 4: the FILLED bar (STEP_BAR_CUR) leads then the label (panel counter empty, the bar carries
    # i/N); unset bar (defensive) → plain body. BUG A: paint ONLY the inner span (rail-safe), rails survive.
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
  # sequence across the preflight->install handoff (base+1 .. base+n). Empty base => 0 offset => raw STEP_INDEX/STEP_TOTAL, unchanged for shared uninstall/db/token/purge callers.
  local disp_i disp_n
  disp_i=$((${STEP_INDEX_BASE:-0} + STEP_INDEX))
  # frozen unified step counter: prefer the frozen GRAND_TOTAL denominator; empty (shared callers) => raw base+STEP_TOTAL.
  disp_n=${GRAND_TOTAL:-$((${STEP_INDEX_BASE:-0} + STEP_TOTAL))}
  build_progress_bar "${disp_i}" "${disp_n}" "$(progress_bar_width)" "${STEP_BAR_ACCENT_CUR:-${C_ACCENT}}"
}

# enter_run_state — the dim-for-run transition (REDRAW_MODEL): set WORK_STATE=run + MENU_DIMMED=true,
# then full-frame redraw. draw_menu greys every label + drops the caret; draw_workbox renders the run
# body (the spinner then owns its in-place body row); draw_bottom_row clears the keyhint row. No
# partial repaint — the full clear makes a leftover bright row / orphan rail impossible.
enter_run_state() {
  WORK_STATE=run
  MENU_DIMMED=true
  redraw_frame_inplace
}

# enter_nav_state — the un-dim / return-to-nav transition (REDRAW_MODEL): clear WORK_STATE to nav +
# MENU_DIMMED=false, then full-frame redraw. The box reverts to the selected item's description + the
# bottom row to the move/select/quit legend; the full clear leaves no doubled keyhint / leftover status / orphan rail.
enter_nav_state() {
  WORK_STATE=nav
  MENU_DIMMED=false
  redraw_frame_inplace
}

# status_line — the completion transition (REDRAW_MODEL): record the result into DONE_*, set
# WORK_STATE=done, then full-frame redraw. draw_workbox renders the concise success/fail body (success
# or "failed at step N/T" — NO log body, NO banner); draw_bottom_row renders "press any key …" + the
# persisted log path (on failure). State carries a glyph (G_OK/G_FAIL) in ADDITION to color (colorblind-safe).
# $1=rc · $2=action title · $3=failing step index · $4=total steps. Name kept for the call sites.
status_line() {
  DONE_RC="$1"
  DONE_TITLE="$2"
  DONE_IDX="$3"
  DONE_TOTAL="$4"
  WORK_STATE=done
  MENU_DIMMED=true # the menu stays paused/dim until the user dismisses the done line
  redraw_frame_inplace
}
