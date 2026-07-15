# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154,SC2312  # SC2154: reads shared loader globals (PLATE_*/MENU_*/C_*/G_*/USE_* etc.); SC2034: assigns shared globals (WORKBOX_BODY_ROW*/MENU_INNER_OVERRIDE) read at runtime; both present at runtime, unresolvable standalone; SC2312: c()/plate_* run inside command subs (always succeed via printf → masked return no signal), mirrors loader-wide disable
# Glass Atrium launcher — frame + menu render module. SOURCED (never executed):
# shebang/strict-mode/IFS/traps + PLATE_* geometry band + MENU_* counts stay loader-owned
# so re-sourcing never re-arms. Owns the menu geometry math + the full framed-menu paint
# path (wordmark/separator/menu builders, plate apply/reset, region compositor, in-place
# redraws + SIGWINCH handler).
# compute_menu_geometry — geometry SoT. Reads the LIVE TTY size (term_size), decides
# compact-vs-fullscreen + (fullscreen) the centered column + a bottom-fixed build-UP anchoring
# (keyhint pinned to the last row, every region offset UPWARD by a MENU_COUNT-derived amount —
# never a row literal). Side-effect-free beyond FULLSCREEN/MENU_*/ART_*/WORDMARK_OK so a WINCH
# burst collapses to one clean recompute.
compute_menu_geometry() {
  local sz cols rows
  sz="$(term_size)"
  cols="${sz%% *}"
  rows="${sz##* }"

  # Degradation gate: a tiny terminal OR untrusted cursor-addressing (no `tput cup`) falls
  # back to the compact top-left layout. MIN_ROWS is the FULLSCREEN gate (back-compat value,
  # MENU_COUNT-tracking); art entry is a SEPARATE, taller ART_MIN_ROWS sub-gate computed below.
  if [[ "${cols}" -lt "${MIN_COLS}" || "${rows}" -lt "${MIN_ROWS}" ]] \
    || ! tput cup 0 0 >/dev/null 2>&1; then
    FULLSCREEN=false
    MENU_LEFT="${PLATE_MARGIN}"
    # Reset the art + wordmark gates so a fullscreen->compact resize never leaves them stale-true.
    # ART_ROWS/ART_WIDTH are readonly launcher constants (not runtime state) — never reassigned here.
    ART_OK=false
    ART_FIRST_ROW=0
    WORDMARK_OK=false
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

  # VERTICAL: bottom-fixed build-UP. The keyhint pins to the last screen row (R); every region
  # anchors UPWARD from it by a MENU_COUNT(C)-derived offset (frame.sh invariant: COMPUTED,
  # never a row literal). Offsets: keyhint R | workbox R-4..R-1 | menu top rail R-(7+C) |
  # separator R-(8+C) | wordmark R-(10+C)..R-(9+C). The 2-row wordmark (T4) is load-bearing —
  # a 5-row wordmark would overrun the separator + menu top rail.
  MENU_KEYHINT_ROW="${rows}"
  WORKBOX_FIRST_ROW=$((rows - 4))              # top rail + LINE1 + LINE2 + bottom rail (fixed 4)
  WORKBOX_BODY_ROW=$((WORKBOX_FIRST_ROW + 1))  # LINE 1 headline
  WORKBOX_BODY_ROW2=$((WORKBOX_FIRST_ROW + 2)) # LINE 2 detail (bottom rail sits at WORKBOX_FIRST_ROW+3)
  MENU_BLOCK_FIRST_ROW=$((rows - (7 + MENU_COUNT)))
  SEPARATOR_ROW=$((rows - (8 + MENU_COUNT)))
  WORDMARK_FIRST_ROW=$((rows - (10 + MENU_COUNT)))
  # MENU_FIRST_ROW = the wordmark row: the redraw-extent top WHEN the art is absent (ART_OK false),
  # and the topmost DRAWN region below the art otherwise. When ART_OK the extent top lifts to
  # ART_FIRST_ROW (redraw_frame_inplace clear_top).
  MENU_FIRST_ROW="${WORDMARK_FIRST_ROW}"

  # ART gate — the SINGLE art tier (the 3-band system is retired; one 55x21 asset ships). Art
  # needs BOTH a taller terminal AND a wide-enough plate: rows >= ART_MIN_ROWS (=39 at C=5, which
  # keeps ART_FIRST_ROW = R-(11+C)-ART_ROWS >= 2 at the floor) AND the 55-cell art fits the
  # centered plate inner (MENU_INNER — the fullscreen plate_inner SoT derived above from cols,
  # never a cols literal). Top-down degradation step 1: a too-short OR tall-but-narrow terminal
  # drops the bulldog; the menu + workbox + keyhint never lose a row.
  if [[ "${rows}" -ge "${ART_MIN_ROWS}" && "${MENU_INNER}" -ge "${ART_WIDTH}" ]]; then
    ART_OK=true
  else
    ART_OK=false
  fi
  if [[ "${ART_OK}" == "true" ]]; then
    ART_FIRST_ROW=$((rows - (11 + MENU_COUNT) - ART_ROWS))
  else
    ART_FIRST_ROW=0
  fi

  # WORDMARK gate — top-down degradation step 2 (defensive). After the bulldog drops, the wordmark
  # + separator drop NEXT if the terminal is too short to seat the wordmark top at row >= 2
  # (rows >= 12+C). Inside the fullscreen range (rows >= 21) WORDMARK_FIRST_ROW >= 6, so this is
  # always true today; it is a REAL gate the compose step consults (wordmark + separator drawn only
  # when WORDMARK_OK) so the degradation ladder stays structurally complete for a later render wave.
  if [[ "${WORDMARK_FIRST_ROW}" -ge 2 ]]; then
    WORDMARK_OK=true
  else
    WORDMARK_OK=false
  fi
}

# ensure_geometry — dirty-gate caller. Runs compute_menu_geometry ONLY when GEOMETRY_DIRTY
# is set (init or post-WINCH), then clears the flag, so nav/dim/done/return reuse the cached
# anchors with NO per-keypress TTY size read (the source of the 1-row nav oscillation).
ensure_geometry() {
  [[ "${GEOMETRY_DIRTY}" == "true" ]] || return 0
  compute_menu_geometry
  GEOMETRY_DIRTY=false
}

draw_wordmark() {
  local inner wm_w r0 r1 wpad wpad_n
  inner="$(plate_inner)"

  if [[ "${USE_UTF8}" == "true" ]]; then
    # One-line wordmark GLASS + ATRIUM = 44 cols across the 2-row half-block pixel font
    # (r0 = top row, r1 = bottom row).
    wm_w=44
    r0="█▀▀ █   █▀█ █▀▀ █▀▀  █▀█ ▀█▀ █▀▄ ▀█▀ █ █ █▄█"
    r1="█▄█ █▄▄ █▀█ ▄▄█ ▄▄█  █▀█  █  █▀▄ ▄█▄ █▄█ █ █"
  else
    # ASCII / mono fallback: plain one-line GLASS ATRIUM (12 cols) + blank 2nd row, holding
    # the same 2-row structure.
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

  # Borderless 2-row emission: the 2 centered wordmark rows only. This 2-row height is load-bearing:
  # the SEPARATOR_ROW/menu-top offsets in compute_menu_geometry assume exactly it. No rails/right-pad
  # — the redraw clears by extent.
  tty_line "${wpad}${r0}"
  tty_line "${wpad}${r1}"
}

# draw_separator — dim dot-rule between the wordmark and the menu: one row of dim G_DOT
# glyphs (`·`, ASCII `.`) spanning the plate inner width, indented PLATE_LEFT. Stays exactly
# ONE line. Fullscreen: self-anchors at the bottom-fixed SEPARATOR_ROW (decoupled from the
# wordmark row count); compact keeps its natural-newline inline flow (no cup_to).
draw_separator() {
  local inner
  inner="$(plate_inner)"
  [[ "${FULLSCREEN}" == "true" ]] && cup_to "${SEPARATOR_ROW}" 1
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

# _compose_frame_regions — paint EVERY region at its OWN absolute CUP anchor, in the fixed
# top→bottom order (art → wordmark → separator → menu → workbox → bottom row). Shared by both
# redraw paths so the region sequence has ONE SoT. Each region seats itself with an absolute
# cup_to (no single frame-top cup + natural-newline chaining across gaps), so a gap between two
# regions (art↔wordmark, menu↔workbox) never depends on a prior region's trailing cursor. Every
# NEW per-region cup_to is FULLSCREEN-conditional; _compose_frame_regions is only ever reached in
# the fullscreen path, so the guards are defensive (the compact path composes inline elsewhere).
_compose_frame_regions() {
  # (1) Bulldog art — TOP region. Self-gated (FULLSCREEN AND ART_OK AND USE_UTF8) and self-anchored
  # (cup_to ART_FIRST_ROW) inside draw_bulldog_art, which emits NOTHING when any gate is off (no
  # cursor move, no blank rows) — so a no-art terminal leaves the rows below untouched.
  draw_bulldog_art
  # (2)+(3) wordmark + separator: top-down degradation step 2 — drawn ONLY when WORDMARK_OK (the
  # terminal seats the wordmark top at row >= 2, always true inside the fullscreen range today).
  # The wordmark self-anchors at WORDMARK_FIRST_ROW; the separator self-anchors at SEPARATOR_ROW
  # (its own fullscreen cup_to).
  if [[ "${WORDMARK_OK}" == "true" ]]; then
    [[ "${FULLSCREEN}" == "true" ]] && cup_to "${WORDMARK_FIRST_ROW}" 1
    draw_wordmark  # 2 centered wordmark rows
    draw_separator # dim dot-rule separator (fullscreen self-anchors at SEPARATOR_ROW)
  fi
  # (4) menu: EXPLICIT self-anchor at MENU_BLOCK_FIRST_ROW — the menu block is position-independent
  # of the wordmark/separator gate, so it seats correctly even when WORDMARK_OK is false and the
  # separator is skipped. Compact composes inline elsewhere.
  [[ "${FULLSCREEN}" == "true" ]] && cup_to "${MENU_BLOCK_FIRST_ROW}" 1
  draw_menu       # labels-only menu block (top rail + N rows + bottom rail), honors MENU_DIMMED
  draw_workbox    # the fixed work-area box (self-anchored at WORKBOX_FIRST_ROW), from WORK_STATE
  draw_bottom_row # the ONE bottom row (self-anchored at MENU_KEYHINT_ROW): keyhint OR status line
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
    _compose_frame_regions # includes the bulldog art (self-gated on ART_OK) at the top
  else
    # Compact path: top-left clear + inline scrolling-keyhint model. The work-area box AND the
    # bulldog art are fullscreen-only; the compact menu keeps inline description-free labels +
    # inline keyhint (no art, no per-region cup_to — the natural-newline inline flow is preserved).
    printf '\033[H\033[J' >"${TTY}" # home + clear to end of screen
    draw_wordmark
    draw_separator
    draw_menu
  fi
}

# redraw_frame_inplace — the FLICKER-FREE nav/dim/done/return composer. Does NOT emit ESC[2J —
# instead pre-clears the WHOLE cached frame extent with per-row ESC[2K at the FIXED cached position,
# then recomposes via the SAME region order → ZERO accumulation (full extent cleared) + ZERO flash
# (no global blank-then-repaint). The extent TOP is ART_FIRST_ROW when ART_OK (so a repeated redraw
# leaves no ghost/accumulation of the static art rows), else MENU_FIRST_ROW (the wordmark row — the
# topmost region when the art is absent); the BOTTOM is always MENU_KEYHINT_ROW (incl. every
# wordmark/separator + menu↔workbox gap row). Geometry REUSED from cache (ensure_geometry no-ops when
# clean) → no size-jitter shift. Compact path has no cached extent → falls through to full-clear.
# NOTE (resize): a shrink out of the art tier (ART_OK true→false) or out of fullscreen is handled by
# on_winch → draw_frame_full, which ESC[2J-clears the WHOLE screen before recomposing, so former art
# rows are wiped there — no extra clearing is needed on this in-place path for that transition.
redraw_frame_inplace() {
  ensure_geometry      # cached → no-op (no per-keypress TTY size read = no 1-row oscillation)
  apply_plate_geometry # PLATE_LEFT + MENU_INNER_OVERRIDE for the centered column
  if [[ "${FULLSCREEN}" != "true" ]]; then
    draw_frame_full # compact path: no cached extent to per-row clear — reuse the full composer
    return 0
  fi
  # Extent top: the art region sits ABOVE the wordmark, so when ART_OK the per-row clear must reach
  # up to ART_FIRST_ROW (else a repeated in-place redraw would stack ghost art rows); no art → the
  # wordmark row (MENU_FIRST_ROW) is the top.
  local clear_top="${MENU_FIRST_ROW}"
  [[ "${ART_OK}" == "true" ]] && clear_top="${ART_FIRST_ROW}"
  # Pre-clear every row of the cached extent in place (guarded: skip if the extent is degenerate).
  if [[ "${MENU_KEYHINT_ROW}" -ge "${clear_top}" ]]; then
    local r="${clear_top}"
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
# follows the selection); the entire STATIC top region — bulldog art, wordmark, separator, rails,
# keyhint — is never touched → zero flicker (this is exactly why the art is held STATIC: the
# differential nav path addresses no row in [ART_FIRST_ROW, ART_FIRST_ROW+ART_ROWS), so it never
# needs to repaint the ~21 art rows). Differential paint is valid ONLY in the framed fullscreen
# layout (cached anchors); the compact / narrow (<56-col) path has no fixed extent → falls back to
# the full in-place redraw.
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

# on_winch — SIGWINCH handler: a resize MAY change the extent (incl. ART_OK / ART_FIRST_ROW / the
# band), so it forces a geometry recompute + full-clear redraw via draw_frame_full. draw_frame_full
# ESC[2J-clears the WHOLE screen (fullscreen: tp clear; compact: \033[H\033[J) BEFORE recomposing,
# so a shrink OUT of the art tier (ART_OK true→false) or out of fullscreen fully wipes the former
# art rows — the recompose then no-op-draws the (now gated-off) art, leaving zero ghost. No-op while
# NOT in raw mode (RAW_ACTIVE=false) so it never repaints over an inline scrolling run. Idempotent +
# side-effect-free beyond the redraw (a drag-resize burst collapses to one clean final redraw).
# SELECTED / WORK_STATE preserved.
on_winch() {
  [[ "${RAW_ACTIVE}" == "true" ]] || return 0
  draw_frame_full
}
