# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2312  # SC2154: reads shared globals (PLATE_*/MENU_*/C_*/G_*/USE_*/WORDMARK/SEP_* etc.) assigned by the glass-atrium loader + caps module; SC2034: assigns shared globals (WORKBOX_BODY_ROW*/MENU_INNER_OVERRIDE etc.) read at runtime by the loader + other TUI siblings; both present at runtime after the loader sources every TUI module, unresolvable when linted standalone; SC2312: c()/plate_* helpers are deliberately invoked inside command substitutions (always succeed via printf, so the masked return carries no signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — frame + menu render module. SOURCED by the glass-atrium
# entry point (never executed): the shebang, strict mode, IFS, traps and every
# interleaved top-level const/stub (the PLATE_* geometry band, MENU_* counts) stay
# loader-owned so re-sourcing never re-arms them. Owns the menu geometry math and the
# full framed-menu paint path — wordmark/separator/menu-row builders, the plate
# geometry apply/reset, the region compositor (draws the work-box via the workbox
# sibling) and the in-place frame/menu redraws + SIGWINCH handler — all reading the
# loader's file-scope globals at call time in the same sourced shell.
# compute_menu_geometry — the geometry SoT. Reads the LIVE TTY size (term_size), then
# decides compact-vs-fullscreen and (when fullscreen) the centered column + the
# vertical anchoring. Side-effect-free beyond setting the FULLSCREEN/MENU_* vars, so a
# burst of WINCH events collapses to a clean final recompute. block_rows is COMPUTED
# (2 rails + MENU_COUNT items + 5 wordmark + 1 separator), never hard-coded.
compute_menu_geometry() {
  local sz cols rows
  sz="$(term_size)"
  cols="${sz%% *}"
  rows="${sz##* }"

  # Degradation gate: a tiny terminal OR a terminal whose cursor-addressing we cannot
  # trust (no `tput cup`) falls back to the compact top-left layout (the unchanged
  # code path). `tput cup` absence is treated identically to the tiny-terminal branch.
  if [[ "${cols}" -lt "${MIN_COLS}" || "${rows}" -lt "${MIN_ROWS}" ]] \
    || ! tput cup 0 0 >/dev/null 2>&1; then
    FULLSCREEN=false
    MENU_LEFT="${PLATE_MARGIN}"
    return 0
  fi

  FULLSCREEN=true

  # HORIZONTAL: a centered max-width column, capped at MAX_READABLE so wide text never
  # stretches past 64 cells. avail = cols - 2*margin; content_w = min(avail, MAX_READABLE);
  # inner = content_w - 2 rails; left centers content_w, floored at PLATE_MARGIN.
  local avail content_w
  avail=$((cols - (PLATE_MARGIN * 2)))
  content_w="${avail}"
  [[ "${content_w}" -gt "${MAX_READABLE}" ]] && content_w="${MAX_READABLE}"
  MENU_INNER=$((content_w - 2))
  [[ "${MENU_INNER}" -lt 24 ]] && MENU_INNER=24
  MENU_LEFT=$(((cols - content_w) / 2))
  [[ "${MENU_LEFT}" -lt "${PLATE_MARGIN}" ]] && MENU_LEFT="${PLATE_MARGIN}"

  # VERTICAL: block_rows occupies first_row .. first_row+block_rows-1; the keyhint is
  # pinned alone to the last screen row with >=1 clear gap (guaranteed by MIN_ROWS).
  # top_pad floors so the block sits a touch above dead-center (reads better). The workbox
  # (top rail + 2 body rows + bottom rail) is now part of block_rows + a 1-row gap above it,
  # so the centered column still vertically centers the WHOLE composition (wordmark + menu
  # + work-area box), not just the menu.
  local menu_rows workbox_rows block_rows region top_pad
  menu_rows=$((2 + MENU_COUNT)) # 2 rails + N item rows
  workbox_rows=4                # top rail + 2 body rows (LINE1 headline + LINE2 detail) + bottom rail
  block_rows=$((5 + 1 + menu_rows + 1 + workbox_rows)) # wordmark(5)+sep(1)+menu + 1 gap + workbox
  MENU_KEYHINT_ROW="${rows}"
  region=$((rows - 1))
  top_pad=$(((region - block_rows) / 2))
  [[ "${top_pad}" -lt 1 ]] && top_pad=1
  MENU_FIRST_ROW=$((1 + top_pad))

  # Derived block + workbox anchors (shared by draw_menu / draw_workbox / the spinner).
  # block_first = the menu top rail's absolute row: wordmark(5)+separator(1) below first_row.
  # block_rows  = top rail + N items + bottom rail. The workbox sits one blank row below the
  # menu's bottom rail; its body row is the single content/spinner row.
  MENU_BLOCK_FIRST_ROW=$((MENU_FIRST_ROW + 6))
  MENU_BLOCK_ROWS=$((2 + MENU_COUNT))
  WORKBOX_FIRST_ROW=$((MENU_BLOCK_FIRST_ROW + MENU_BLOCK_ROWS + 1))
  WORKBOX_BODY_ROW=$((WORKBOX_FIRST_ROW + 1))  # LINE 1 headline
  WORKBOX_BODY_ROW2=$((WORKBOX_FIRST_ROW + 2)) # LINE 2 detail (bottom rail sits at WORKBOX_FIRST_ROW+3)
}

# ensure_geometry — the dirty-gate caller (ITEM 1 flicker fix). Runs compute_menu_geometry
# ONLY when GEOMETRY_DIRTY is set (init or post-WINCH), then clears the flag. compute_menu_geometry
# stays the SoT body (unchanged internals); this is the thin gate so nav/dim/done/return reuse the
# cached anchors with NO per-keypress TTY size read (the source of the 1-row nav oscillation).
ensure_geometry() {
  [[ "${GEOMETRY_DIRTY}" == "true" ]] || return 0
  compute_menu_geometry
  GEOMETRY_DIRTY=false
}

# _sparkle_row — build ONE borderless row of scattered C_ACCENT sparkles: `base`
# leading pad cells, then a ✦ (ASCII '*') dropped at each ascending CODEPOINT offset
# given in the remaining args. The walk is codepoint-based so the multibyte ✦ and the
# zero-width color CSI never desync the column count. Offsets MUST be ascending (the
# position cursor only advances).
_sparkle_row() {
  local base="$1"
  shift
  local glyph star out pos=0 off
  if [[ "${USE_UTF8}" == "true" ]]; then glyph="✦"; else glyph="*"; fi
  star="$(c "${C_ACCENT}" "${glyph}")"
  out="$(printf '%*s' "${base}" "")"
  for off in "$@"; do
    while [[ "${pos}" -lt "${off}" ]]; do
      out="${out} "
      pos=$((pos + 1))
    done
    out="${out}${star}"
    pos=$((pos + 1))
  done
  printf '%s' "${out}"
}

draw_wordmark() {
  local inner wm_w r0 r1 star_top star_bot wpad wpad_n
  inner="$(plate_inner)"

  if [[ "${USE_UTF8}" == "true" ]]; then
    # One-line wordmark: GLASS (19 cols) + 2-space gap + ATRIUM (23 cols) = 44 cols,
    # laid across the 2-row half-block pixel font (r0 = top row, r1 = bottom row).
    wm_w=44
    r0="█▀▀ █   █▀█ █▀▀ █▀▀  █▀█ ▀█▀ █▀▄ ▀█▀ █ █ █▄█"
    r1="█▄█ █▄▄ █▀█ ▄▄█ ▄▄█  █▀█  █  █▀▄ ▄█▄ █▄█ █ █"
  else
    # ASCII / mono fallback — a plain one-line GLASS ATRIUM (12 cols) on the first
    # content row + a blank second content row, holding the same 5-row structure.
    wm_w=12
    r0="GLASS ATRIUM"
    r1=""
  fi

  # Center the wm_w-wide wordmark: left pad = PLATE_LEFT + (inner - wm_w)/2, clamped
  # to PLATE_LEFT so a sub-wordmark-width plate stays flush rather than under-padding.
  wpad_n=$((PLATE_LEFT + (inner - wm_w) / 2))
  [[ "${wpad_n}" -lt "${PLATE_LEFT}" ]] && wpad_n="${PLATE_LEFT}"
  wpad="$(printf '%*s' "${wpad_n}" "")"
  r0="$(c "${C_STRONG}" "${r0}")"
  [[ -n "${r1}" ]] && r1="$(c "${C_STRONG}" "${r1}")"

  # Scattered (asymmetric, inner-scaled) sparkle rows — ~3 above, ~2 below — so the
  # ✦ twinkle reads across the content band instead of as an aligned grid.
  star_top="$(_sparkle_row "${PLATE_LEFT}" "$((inner / 12))" "$((inner * 5 / 12))" "$((inner * 10 / 12))")"
  star_bot="$(_sparkle_row "${PLATE_LEFT}" "$((inner * 3 / 12))" "$((inner * 8 / 12))")"

  # Borderless 5-row emission: top sparkle, the 2 centered wordmark rows, bottom
  # sparkle, a blank bottom-pad row. No rails/right-pad — the redraw clears by extent.
  tty_line "${star_top}"
  tty_line "${wpad}${r0}"
  tty_line "${wpad}${r1}"
  tty_line "${star_bot}"
  tty_line ""
}

# draw_separator — the dim dot-rule between the wordmark and the menu (VR-11),
# replacing the former blank gap. A single row of dim G_DOT glyphs (`·`, ASCII `.`)
# spanning the shared plate inner width, indented PLATE_MARGIN to align under the
# plate. Stays exactly ONE line — the wordmark(5)+separator(1)=6-row offset is the
# constant redraw_frame_inplace adds to MENU_FIRST_ROW to anchor the menu block absolutely.
draw_separator() {
  local inner
  inner="$(plate_inner)"
  tty_out "$(printf '%*s' "${PLATE_LEFT}" "")"
  tty_line "$(c "${C_DIM}" "$(hrule "${G_DOT}" "${inner}")")"
}

# menu_row_str — the colorized content string for menu row $1 (caret gutter + 14-cell label + an
# optional destructive accent-dot tail), honoring MENU_DIMMED / SELECTED / the Monitor install-gate
# dim. Extracted from draw_menu so a single row can be repainted in isolation (differential nav).
# Self-contained: computes the Monitor gate inline (one stat, only for the monitor row).
menu_row_str() {
  local i="$1" label dest caret label_cell row tail="" sel_color
  label="${MENU_LABEL[${i}]}"
  dest="${MENU_DESTRUCTIVE[${i}]}"
  # selected destructive row (Uninstall) takes a red focus; every other selected row stays accent-blue.
  sel_color="${C_ACCENT}"
  [[ "${i}" -eq "${SELECTED}" && "${dest}" -eq 1 ]] && sel_color="${C_DANGER}"
  if [[ "${MENU_DIMMED}" == "true" ]]; then
    caret=" "
  elif [[ "${i}" -eq "${SELECTED}" ]]; then
    caret="${G_CARET}"
  else
    caret=" "
  fi
  if [[ "${MENU_DIMMED}" == "true" ]]; then
    label_cell="$(c "${C_DIM}" "$(printf '%-14s' "${label}")")"
  else
    if [[ "${i}" -eq "${SELECTED}" && "${dest}" -eq 1 ]]; then
      tail=" $(c "${sel_color}" "${G_DOT}")"
    fi
    if [[ "${i}" -eq "${SELECTED}" ]]; then
      label_cell="$(c "${sel_color}" "$(printf '%-14s' "${label}")")"
    elif [[ "${MENU_ACTION[${i}]}" == "monitor" ]] && ! monitor_install_present; then
      label_cell="$(c "${C_DIM}" "$(printf '%-14s' "${label}")")"
    else
      label_cell="$(c "${C_STRONG}" "$(printf '%-14s' "${label}")")"
    fi
  fi
  row=" $(c "${sel_color}" "${caret}") ${label_cell}${tail}"
  printf '%s' "${row}"
}

# paint_menu_row — repaint exactly ONE menu row in place at its absolute cached anchor
# (MENU_BLOCK_FIRST_ROW + 1 + i). Used by the differential nav redraw so an arrow move touches
# only the two rows whose highlight changed — the static wordmark/separator/rails are never redrawn.
paint_menu_row() {
  local i="$1" inner
  inner="$(plate_inner)"
  cup_to "$((MENU_BLOCK_FIRST_ROW + 1 + i))" 1
  plate_row "${inner}" "$(menu_row_str "${i}")"
}

draw_menu() {
  local i
  # Clamp total width (the menu rows are now labels-only — the per-item descriptions
  # moved into the work-area box below, so there is no inline description column to size).
  local cols
  cols="$(term_cols)"

  # Frame drawn only when the terminal is wide enough (≥ 56 cols); below that we
  # fall back to unframed rows so a small window stays uncluttered. The framed
  # path rides the SHARED plate (plate_inner / plate_top / plate_row / plate_bot)
  # so the menu right edge lands on the SAME column as the wordmark + panels.
  local framed=true
  [[ "${cols}" -lt 56 ]] && framed=false
  local inner
  inner="$(plate_inner)"

  # --- top rail with a "menu" tab -------------------------------------------
  if [[ "${framed}" == "true" ]]; then
    plate_top "${inner}" " menu " "${C_FRAME}"
  fi

  i=0
  while [[ "${i}" -lt "${MENU_COUNT}" ]]; do
    # The per-row content build now lives in menu_row_str (shared with the differential
    # nav repaint); draw_menu only positions each row via the framed / unframed emit below.
    local row
    row="$(menu_row_str "${i}")"
    if [[ "${framed}" == "true" ]]; then
      plate_row "${inner}" "${row}"
    else
      tty_line "  ${row}" # 2-cell left margin (unframed narrow fallback, no rail)
    fi
    i=$((i + 1))
  done

  # --- bottom rail + keyhint footer -----------------------------------------
  if [[ "${framed}" == "true" ]]; then
    plate_bot "${inner}" "${C_FRAME}"
  fi
  # In fullscreen mode the keyhint is bottom-pinned separately (draw_keyhint via an
  # absolute CUP), so draw_menu emits it inline ONLY in the compact layout — that keeps
  # the redraw_frame_inplace \033[J region (which clears to end-of-screen from the saved menu row)
  # from wiping the bottom-pinned keyhint on every arrow-key redraw.
  if [[ "${FULLSCREEN}" != "true" ]]; then
    draw_keyhint
  fi
}

# draw_keyhint — the move/select/quit legend (dim labels, accent keys; ASCII-degrades
# to ^/v/enter/q). Hidden on a very narrow window where the description column was also
# dropped (cols<40). In fullscreen mode it is positioned at MENU_KEYHINT_ROW indented to
# MENU_LEFT (aligned under the centered plate's left edge); inline otherwise. The exact
# legend string is preserved byte-for-byte (triple-key reuse).
draw_keyhint() {
  local cols
  cols="$(term_cols)"
  [[ "${cols}" -ge 40 ]] || return 0
  if [[ "${FULLSCREEN}" == "true" ]]; then
    cup_to "${MENU_KEYHINT_ROW}" "$((MENU_LEFT + 1))"
  else
    tty_out "      "
  fi
  tty_out "$(c "${C_ACCENT}" "${G_ARROW_U}${G_ARROW_D}") $(c "${C_DIM}" "move")   "
  tty_out "$(c "${C_ACCENT}" "${G_ENTER}") $(c "${C_DIM}" "select")   "
  # SCROLL-SAFE (BUG B): NO trailing newline. In fullscreen this row is cup-anchored at
  # MENU_KEYHINT_ROW = the LAST screen row; a '\n' there would index/scroll the alt-screen
  # one line, leaving the cached-CUP redraw's prior frame one row higher → upward-stacking
  # top-rail fragments. tty_out parks the cursor at the row's end WITHOUT advancing.
  tty_out "$(c "${C_ACCENT}" "q") $(c "${C_DIM}" "quit")"
}

# menu_nav_desc — the nav-state work-box description for menu index $1. Normally MENU_DESC[$1],
# but the Monitor shortcut is install-gated: until the program is installed it reports the
# "run Install first" cue, so merely highlighting the row explains why Enter is a no-op.
menu_nav_desc() {
  local idx="$1"
  if [[ "${MENU_ACTION[${idx}]}" == "monitor" ]] && ! monitor_install_present; then
    printf 'available after Install — run Install first'
    return 0
  fi
  printf '%s' "${MENU_DESC[${idx}]}"
}

# apply_plate_geometry — set PLATE_LEFT + MENU_INNER_OVERRIDE from the computed
# fullscreen geometry (so the plate emitters pad to the centered column + width), OR
# restore them to the compact defaults (PLATE_MARGIN / no override) when not fullscreen.
# Called by draw_frame before drawing; the inline-run path calls reset_plate_geometry
# to guarantee the panels keep their 2-cell indent regardless of menu state.
apply_plate_geometry() {
  if [[ "${FULLSCREEN}" == "true" ]]; then
    PLATE_LEFT="${MENU_LEFT}"
    MENU_INNER_OVERRIDE="${MENU_INNER}"
  else
    reset_plate_geometry
  fi
}

# reset_plate_geometry — restore the compact / inline-run plate defaults. The inline-run
# panels (untouched scope) MUST always draw at PLATE_MARGIN with the term_cols-driven
# width, so dispatch_action calls this before running an action.
reset_plate_geometry() {
  PLATE_LEFT="${PLATE_MARGIN}"
  MENU_INNER_OVERRIDE=""
}

# _compose_frame_regions — paint EVERY composed region at its absolute CUP anchor, in the
# fixed top-to-bottom order (wordmark → separator → menu → workbox → bottom row). Shared by
# both redraw paths (full-clear + in-place) so the region sequence has ONE SoT. Fullscreen
# anchors via cup_to MENU_FIRST_ROW; the natural newlines stack the wordmark/separator/menu.
_compose_frame_regions() {
  cup_to "${MENU_FIRST_ROW}" 1
  draw_wordmark   # 5 rows (sparkle + centered wordmark + sparkle + pad); the natural newlines stack the separator + menu below it
  draw_separator  # dim dot-rule separator (VR-11)
  draw_menu       # labels-only menu block (top rail + N rows + bottom rail), honors MENU_DIMMED
  draw_workbox    # the fixed work-area box: nav description OR run/done body from WORK_STATE
  draw_bottom_row # the ONE bottom row: keyhint legend OR status line, chosen by WORK_STATE
}

# draw_frame_full — the INIT + WINCH composer (ITEM 1). Forces a geometry RECOMPUTE
# (GEOMETRY_DIRTY=true) — the extent may have changed on a resize, and the first compose has no
# cache yet — then FULL-CLEARS the alt-screen (`tp clear` = \033[2J\033[H) and recomposes. The
# single ESC[2J flash is acceptable here: init runs once, a resize is rare. Reserved for those
# two call sites ONLY; nav/dim/done/return use redraw_frame_inplace (no flash). The compact
# (sub-MIN_COLS/ROWS) path keeps its top-left clear + inline scrolling model, unchanged.
draw_frame_full() {
  GEOMETRY_DIRTY=true   # extent may have changed (resize) / no cache yet (init) — force recompute
  ensure_geometry       # geometry SoT (recomputes now; clears the flag)
  apply_plate_geometry  # PLATE_LEFT + MENU_INNER_OVERRIDE for the centered column
  if [[ "${FULLSCREEN}" == "true" ]]; then
    tp clear # \033[2J\033[H — wipe EVERYTHING (the SoT clear; fragment-proof by construction)
    _compose_frame_regions
  else
    # Compact path unchanged: top-left clear + the inline scrolling-keyhint model. The
    # work-area box is fullscreen-only; the compact menu keeps its inline description-free
    # labels + inline keyhint (draw_menu emits the keyhint inline when not fullscreen).
    printf '\033[H\033[J' >"${TTY}" # home + clear to end of screen
    draw_wordmark
    draw_separator
    draw_menu
  fi
}

# redraw_frame_inplace — the FLICKER-FREE nav/dim/done/return composer (ITEM 1). Does NOT emit
# ESC[2J — instead it pre-clears the WHOLE cached frame extent (MENU_FIRST_ROW .. MENU_KEYHINT_ROW
# inclusive, every row incl. the wordmark/separator + menu↔workbox gaps) with per-row ESC[2K at
# the FIXED cached absolute position, then recomposes via the SAME region order. Because every row
# of the entire extent is overwritten in place at a cached anchor: ZERO accumulation (full extent
# always cleared) AND ZERO flash (no global blank-then-repaint — the terminal never shows an empty
# screen). Geometry is REUSED from cache (ensure_geometry no-ops when clean) → no size-jitter shift.
# The compact path has no fixed cached extent, so it falls through to the full-clear composer.
redraw_frame_inplace() {
  ensure_geometry      # cached → no-op (no per-keypress TTY size read = no 1-row oscillation)
  apply_plate_geometry # PLATE_LEFT + MENU_INNER_OVERRIDE for the centered column
  if [[ "${FULLSCREEN}" != "true" ]]; then
    draw_frame_full # compact path: no cached extent to per-row clear — reuse the full composer
    return 0
  fi
  # Pre-clear every row of the cached extent in place (guarded: skip if the extent is degenerate).
  if [[ "${MENU_KEYHINT_ROW}" -ge "${MENU_FIRST_ROW}" ]]; then
    local r="${MENU_FIRST_ROW}"
    while [[ "${r}" -le "${MENU_KEYHINT_ROW}" ]]; do
      cup_to "${r}" 1
      printf '\033[2K' >"${TTY}"
      r=$((r + 1))
    done
  fi
  _compose_frame_regions
}

# draw_full_menu — thin wrapper: the initial-entry / post-run full compose routes through the
# full-clear composer (ITEM 1: init is a legitimate ESC[2J site). Kept as the named entry point
# for the call sites that mean "compose the whole frame from a clean screen".
draw_full_menu() { draw_frame_full; }

# redraw_nav_move — the FLICKER-FREE arrow-move redraw. Instead of recomposing the whole frame, it
# repaints ONLY the two menu rows whose highlight changed (prev de-highlights, cur highlights) plus
# the work-box body row (the nav description follows the selection). The wordmark/separator/menu
# rails/keyhint are never touched → zero flicker on every terminal. Differential paint is valid only
# in the framed fullscreen layout (cached absolute anchors); the compact / narrow (<56-col) path has
# no fixed extent, so it falls back to the full in-place redraw.
redraw_nav_move() {
  local prev="$1" cur="$2" cols
  ensure_geometry      # cached → no-op (no per-keypress size read)
  apply_plate_geometry
  cols="$(term_cols)"
  if [[ "${FULLSCREEN}" != "true" || "${cols}" -lt 56 ]]; then
    redraw_frame_inplace
    return 0
  fi
  paint_menu_row "${prev}"
  [[ "${cur}" -ne "${prev}" ]] && paint_menu_row "${cur}"
  paint_workbox_body_inner "$(workbox_body_str)"
}

# on_winch — SIGWINCH handler: a resize MAY change the extent, so it forces a geometry recompute
# + full-clear redraw via draw_frame_full (the one place a single ESC[2J flash is acceptable).
# No-op while NOT in raw mode (RAW_ACTIVE=false) so it never repaints over an inline scrolling run.
# Idempotent + side-effect-free beyond the redraw, so a drag-resize burst collapses to one clean
# final redraw. SELECTED / WORK_STATE are preserved (no reset).
on_winch() {
  [[ "${RAW_ACTIVE}" == "true" ]] || return 0
  draw_frame_full
}
