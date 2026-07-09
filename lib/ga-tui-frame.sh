# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2312  # SC2154: reads shared loader globals (PLATE_*/MENU_*/C_*/G_*/USE_* etc.); SC2034: assigns shared globals (WORKBOX_BODY_ROW*/MENU_INNER_OVERRIDE) read at runtime; both present at runtime, unresolvable standalone; SC2312: c()/plate_* run inside command subs (always succeed via printf → masked return no signal), mirrors loader-wide disable
# Glass Atrium launcher — frame + menu render module. SOURCED (never executed):
# shebang/strict-mode/IFS/traps + PLATE_* geometry band + MENU_* counts stay loader-owned
# so re-sourcing never re-arms. Owns the menu geometry math + the full framed-menu paint
# path (wordmark/separator/menu builders, plate apply/reset, region compositor, in-place
# redraws + SIGWINCH handler).
# compute_menu_geometry — geometry SoT. Reads the LIVE TTY size (term_size), decides
# compact-vs-fullscreen + (fullscreen) the centered column + vertical anchoring. Side-effect-free
# beyond FULLSCREEN/MENU_* so a WINCH burst collapses to one clean recompute. block_rows is
# COMPUTED (2 rails + MENU_COUNT + 5 wordmark + 1 sep), never hard-coded.
compute_menu_geometry() {
  local sz cols rows
  sz="$(term_size)"
  cols="${sz%% *}"
  rows="${sz##* }"

  # Degradation gate: a tiny terminal OR untrusted cursor-addressing (no `tput cup`) falls
  # back to the compact top-left layout.
  if [[ "${cols}" -lt "${MIN_COLS}" || "${rows}" -lt "${MIN_ROWS}" ]] \
    || ! tput cup 0 0 >/dev/null 2>&1; then
    FULLSCREEN=false
    MENU_LEFT="${PLATE_MARGIN}"
    return 0
  fi

  FULLSCREEN=true

  # HORIZONTAL: centered max-width column capped at MAX_READABLE (wide text never past 64
  # cells). inner = content_w - 2 rails; left centers content_w, floored at PLATE_MARGIN.
  local avail content_w
  avail=$((cols - (PLATE_MARGIN * 2)))
  content_w="${avail}"
  [[ "${content_w}" -gt "${MAX_READABLE}" ]] && content_w="${MAX_READABLE}"
  MENU_INNER=$((content_w - 2))
  [[ "${MENU_INNER}" -lt 24 ]] && MENU_INNER=24
  MENU_LEFT=$(((cols - content_w) / 2))
  [[ "${MENU_LEFT}" -lt "${PLATE_MARGIN}" ]] && MENU_LEFT="${PLATE_MARGIN}"

  # VERTICAL: block_rows occupies first_row..first_row+block_rows-1; the keyhint is pinned
  # alone to the last screen row with >=1 gap (guaranteed by MIN_ROWS). top_pad floors so the
  # block sits a touch above dead-center. The workbox is part of block_rows (+1 gap above), so
  # the centered column vertically centers the WHOLE composition, not just the menu.
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
  # block_first = menu top rail row = wordmark(5)+sep(1) below first_row; block_rows = top
  # rail + N items + bottom rail; workbox sits one blank row below the menu bottom rail.
  MENU_BLOCK_FIRST_ROW=$((MENU_FIRST_ROW + 6))
  MENU_BLOCK_ROWS=$((2 + MENU_COUNT))
  WORKBOX_FIRST_ROW=$((MENU_BLOCK_FIRST_ROW + MENU_BLOCK_ROWS + 1))
  WORKBOX_BODY_ROW=$((WORKBOX_FIRST_ROW + 1))  # LINE 1 headline
  WORKBOX_BODY_ROW2=$((WORKBOX_FIRST_ROW + 2)) # LINE 2 detail (bottom rail sits at WORKBOX_FIRST_ROW+3)
}

# ensure_geometry — dirty-gate caller. Runs compute_menu_geometry ONLY when GEOMETRY_DIRTY
# is set (init or post-WINCH), then clears the flag, so nav/dim/done/return reuse the cached
# anchors with NO per-keypress TTY size read (the source of the 1-row nav oscillation).
ensure_geometry() {
  [[ "${GEOMETRY_DIRTY}" == "true" ]] || return 0
  compute_menu_geometry
  GEOMETRY_DIRTY=false
}

# _sparkle_row — build ONE borderless row of scattered C_ACCENT sparkles: `base` leading
# pad cells, then a ✦ (ASCII '*') dropped at each CODEPOINT offset in the remaining args.
# Codepoint-based walk so the multibyte ✦ + zero-width CSI never desync the column count.
# Offsets MUST be ascending (the position cursor only advances).
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
    # One-line wordmark GLASS + ATRIUM = 44 cols across the 2-row half-block pixel font
    # (r0 = top row, r1 = bottom row).
    wm_w=44
    r0="█▀▀ █   █▀█ █▀▀ █▀▀  █▀█ ▀█▀ █▀▄ ▀█▀ █ █ █▄█"
    r1="█▄█ █▄▄ █▀█ ▄▄█ ▄▄█  █▀█  █  █▀▄ ▄█▄ █▄█ █ █"
  else
    # ASCII / mono fallback: plain one-line GLASS ATRIUM (12 cols) + blank 2nd row, holding
    # the same 5-row structure.
    wm_w=12
    r0="GLASS ATRIUM"
    r1=""
  fi

  # Center wm_w-wide wordmark: left pad = PLATE_LEFT + (inner - wm_w)/2, clamped to PLATE_LEFT
  # so a sub-wordmark-width plate stays flush.
  wpad_n=$((PLATE_LEFT + (inner - wm_w) / 2))
  [[ "${wpad_n}" -lt "${PLATE_LEFT}" ]] && wpad_n="${PLATE_LEFT}"
  wpad="$(printf '%*s' "${wpad_n}" "")"
  r0="$(c "${C_STRONG}" "${r0}")"
  [[ -n "${r1}" ]] && r1="$(c "${C_STRONG}" "${r1}")"

  # Scattered inner-scaled sparkle rows (~3 above, ~2 below) so the ✦ twinkle reads across
  # the band instead of an aligned grid.
  star_top="$(_sparkle_row "${PLATE_LEFT}" "$((inner / 12))" "$((inner * 5 / 12))" "$((inner * 10 / 12))")"
  star_bot="$(_sparkle_row "${PLATE_LEFT}" "$((inner * 3 / 12))" "$((inner * 8 / 12))")"

  # Borderless 5-row emission: top sparkle, 2 centered wordmark rows, bottom sparkle, blank
  # pad row. No rails/right-pad — the redraw clears by extent.
  tty_line "${star_top}"
  tty_line "${wpad}${r0}"
  tty_line "${wpad}${r1}"
  tty_line "${star_bot}"
  tty_line ""
}

# draw_separator — dim dot-rule between the wordmark and the menu: one row of dim G_DOT
# glyphs (`·`, ASCII `.`) spanning the plate inner width, indented PLATE_MARGIN. Stays exactly
# ONE line — the wordmark(5)+separator(1)=6-row offset redraw_frame_inplace adds to
# MENU_FIRST_ROW to anchor the menu block absolutely.
draw_separator() {
  local inner
  inner="$(plate_inner)"
  tty_out "$(printf '%*s' "${PLATE_LEFT}" "")"
  tty_line "$(c "${C_DIM}" "$(hrule "${G_DOT}" "${inner}")")"
}

# menu_row_str — colorized content string for menu row $1 (caret gutter + 14-cell label +
# optional destructive accent-dot tail), honoring MENU_DIMMED / SELECTED / the Monitor
# install-gate dim. Repaintable in isolation (differential nav); computes the Monitor gate
# inline (one stat, monitor row only).
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
# (MENU_BLOCK_FIRST_ROW + 1 + i). Differential nav: an arrow move touches only the two rows
# whose highlight changed; the static wordmark/separator/rails are never redrawn.
paint_menu_row() {
  local i="$1" inner
  inner="$(plate_inner)"
  cup_to "$((MENU_BLOCK_FIRST_ROW + 1 + i))" 1
  plate_row "${inner}" "$(menu_row_str "${i}")"
}

draw_menu() {
  local i
  # Clamp total width (menu rows are labels-only; per-item descriptions live in the work-area
  # box below, so no inline description column to size).
  local cols
  cols="$(term_cols)"

  # Frame drawn only when wide enough (≥ 56 cols); below that, unframed rows keep a small
  # window uncluttered. The framed path rides the SHARED plate so the menu right edge lands
  # on the SAME column as the wordmark + panels.
  local framed=true
  [[ "${cols}" -lt 56 ]] && framed=false
  local inner
  inner="$(plate_inner)"

  # top rail with a "menu" tab
  if [[ "${framed}" == "true" ]]; then
    plate_top "${inner}" " menu " "${C_FRAME}"
  fi

  i=0
  while [[ "${i}" -lt "${MENU_COUNT}" ]]; do
    # Per-row content is built by menu_row_str (shared with the nav repaint); draw_menu only
    # positions each row via the framed / unframed emit below.
    local row
    row="$(menu_row_str "${i}")"
    if [[ "${framed}" == "true" ]]; then
      plate_row "${inner}" "${row}"
    else
      tty_line "  ${row}" # 2-cell left margin (unframed narrow fallback, no rail)
    fi
    i=$((i + 1))
  done

  # bottom rail + keyhint footer
  if [[ "${framed}" == "true" ]]; then
    plate_bot "${inner}" "${C_FRAME}"
  fi
  # Fullscreen keyhint is bottom-pinned separately (draw_keyhint via absolute CUP), so
  # draw_menu emits it inline ONLY in the compact layout — keeping the redraw_frame_inplace
  # \033[J region clear from wiping the bottom-pinned keyhint on every arrow-key redraw.
  if [[ "${FULLSCREEN}" != "true" ]]; then
    draw_keyhint
  fi
}

# draw_keyhint — move/select/quit legend (dim labels, accent keys; ASCII-degrades to
# ^/v/enter/q). Hidden on a very narrow window (cols<40). Fullscreen: positioned at
# MENU_KEYHINT_ROW indented to MENU_LEFT (under the centered plate's left edge); inline
# otherwise.
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
  # SCROLL-SAFE: NO trailing newline. In fullscreen this row is cup-anchored at MENU_KEYHINT_ROW
  # = the LAST screen row; a '\n' would scroll the alt-screen one line, leaving the cached-CUP
  # redraw's prior frame one row higher → upward-stacking top-rail fragments. tty_out parks the
  # cursor at the row's end WITHOUT advancing.
  tty_out "$(c "${C_ACCENT}" "q") $(c "${C_DIM}" "quit")"
}

# menu_nav_desc — nav-state work-box description for menu index $1. Normally MENU_DESC[$1], but
# the Monitor shortcut is install-gated: until installed it reports the "run Install first" cue,
# so highlighting the row explains why Enter is a no-op.
menu_nav_desc() {
  local idx="$1"
  if [[ "${MENU_ACTION[${idx}]}" == "monitor" ]] && ! monitor_install_present; then
    printf 'available after Install — run Install first'
    return 0
  fi
  printf '%s' "${MENU_DESC[${idx}]}"
}

# apply_plate_geometry — set PLATE_LEFT + MENU_INNER_OVERRIDE from the fullscreen geometry
# (plate emitters pad to the centered column + width), OR restore the compact defaults
# (PLATE_MARGIN / no override) when not fullscreen. inline-run path calls reset_plate_geometry
# so the panels keep their 2-cell indent regardless of menu state.
apply_plate_geometry() {
  if [[ "${FULLSCREEN}" == "true" ]]; then
    PLATE_LEFT="${MENU_LEFT}"
    MENU_INNER_OVERRIDE="${MENU_INNER}"
  else
    reset_plate_geometry
  fi
}

# reset_plate_geometry — restore the compact / inline-run plate defaults. The inline-run panels
# MUST always draw at PLATE_MARGIN with the term_cols-driven width, so dispatch_action calls
# this before running an action.
reset_plate_geometry() {
  PLATE_LEFT="${PLATE_MARGIN}"
  MENU_INNER_OVERRIDE=""
}

# _compose_frame_regions — paint EVERY region at its absolute CUP anchor, in the fixed order
# (wordmark → separator → menu → workbox → bottom row). Shared by both redraw paths so the
# region sequence has ONE SoT. Fullscreen anchors via cup_to MENU_FIRST_ROW; natural newlines
# stack the wordmark/separator/menu.
_compose_frame_regions() {
  cup_to "${MENU_FIRST_ROW}" 1
  draw_wordmark   # 5 rows (sparkle + centered wordmark + sparkle + pad); the natural newlines stack the separator + menu below it
  draw_separator  # dim dot-rule separator (VR-11)
  draw_menu       # labels-only menu block (top rail + N rows + bottom rail), honors MENU_DIMMED
  draw_workbox    # the fixed work-area box: nav description OR run/done body from WORK_STATE
  draw_bottom_row # the ONE bottom row: keyhint legend OR status line, chosen by WORK_STATE
}

# draw_frame_full — the INIT + WINCH composer. Forces a geometry RECOMPUTE (GEOMETRY_DIRTY=true;
# extent may have changed on resize, first compose has no cache), then FULL-CLEARS the alt-screen
# (`tp clear` = \033[2J\033[H) and recomposes. The single ESC[2J flash is acceptable here (init
# runs once, resize rare); reserved for these two call sites ONLY — nav/dim/done/return use
# redraw_frame_inplace (no flash). Compact path keeps its top-left clear + inline scrolling model.
draw_frame_full() {
  GEOMETRY_DIRTY=true   # extent may have changed (resize) / no cache yet (init) — force recompute
  ensure_geometry       # geometry SoT (recomputes now; clears the flag)
  apply_plate_geometry  # PLATE_LEFT + MENU_INNER_OVERRIDE for the centered column
  if [[ "${FULLSCREEN}" == "true" ]]; then
    tp clear # \033[2J\033[H — wipe EVERYTHING (the SoT clear; fragment-proof by construction)
    _compose_frame_regions
  else
    # Compact path: top-left clear + inline scrolling-keyhint model. The work-area box is
    # fullscreen-only; the compact menu keeps inline description-free labels + inline keyhint.
    printf '\033[H\033[J' >"${TTY}" # home + clear to end of screen
    draw_wordmark
    draw_separator
    draw_menu
  fi
}

# redraw_frame_inplace — the FLICKER-FREE nav/dim/done/return composer. Does NOT emit ESC[2J —
# instead pre-clears the WHOLE cached frame extent (MENU_FIRST_ROW..MENU_KEYHINT_ROW inclusive,
# every row incl. wordmark/separator + menu↔workbox gaps) with per-row ESC[2K at the FIXED cached
# position, then recomposes via the SAME region order → ZERO accumulation (full extent cleared) +
# ZERO flash (no global blank-then-repaint). Geometry REUSED from cache (ensure_geometry no-ops
# when clean) → no size-jitter shift. Compact path has no cached extent → falls through to full-clear.
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

# draw_full_menu — thin wrapper: initial-entry / post-run full compose routes through the
# full-clear composer. Named entry point for call sites that mean "compose the whole frame
# from a clean screen".
draw_full_menu() { draw_frame_full; }

# redraw_nav_move — FLICKER-FREE arrow-move redraw. Repaints ONLY the two menu rows whose
# highlight changed (prev de-highlights, cur highlights) + the work-box body row (nav description
# follows the selection); wordmark/separator/rails/keyhint are never touched → zero flicker.
# Differential paint is valid ONLY in the framed fullscreen layout (cached anchors); the compact /
# narrow (<56-col) path has no fixed extent → falls back to the full in-place redraw.
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
# + full-clear redraw via draw_frame_full. No-op while NOT in raw mode (RAW_ACTIVE=false) so it
# never repaints over an inline scrolling run. Idempotent + side-effect-free beyond the redraw
# (a drag-resize burst collapses to one clean final redraw). SELECTED / WORK_STATE preserved.
on_winch() {
  [[ "${RAW_ACTIVE}" == "true" ]] || return 0
  draw_frame_full
}
