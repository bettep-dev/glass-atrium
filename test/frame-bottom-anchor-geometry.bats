#!/usr/bin/env bats
# frame-bottom-anchor-geometry.bats — pure-math golden pins for the VERTICALLY-CENTERED block geometry
# (T1). compute_menu_geometry centers the whole stack as ONE unit: top_pad = (rows - BLOCK_H)/2 (floor
# >= 1) blank rows above, then the block chained DOWNWARD from block_top = top_pad + 1, then the
# remaining rows blank below. The keyhint is the block's LAST row (it travels WITH the block, no longer
# pinned to the terminal's last row). The menu + work area are ONE merged box split by an internal
# 'work' divider (NO menu bottom rail, NO menu↔work gap). The ex-separator row is RETAINED as a BLANK
# spacer (draw_separator emits no glyphs in fullscreen). Downward offsets from block_top, at C=5:
#
#   block_top | (art tier: art ART_ROWS + 1 gap, then) wordmark block_top(+19)..+1 |
#   blank ex-separator +2 | box top rail +3 | menu items +4..+(3+C) | blank pad +(4+C) |
#   'work' divider +(5+C) | LINE1 +(6+C) | LINE2 +(7+C) | bottom rail +(8+C) | keyhint +(9+C)
#
# BLOCK_H per tier (WORDMARK_OK always true in the fullscreen range): no-art = 10 + C (=15 at C=5);
# art = ART_ROWS + 11 + C (=34 at C=5). The +1 vs the pre-pad model is the USER-DIRECTED blank interior
# row between the last menu item and the 'work' divider. The bulldog is ONE fixed 55x18 asset (the
# 3-band system is retired), admitted by ART_OK = rows >= ART_MIN_ROWS (=35 = BLOCK_H(art)+1) AND the
# 55-cell art fits the centered plate inner (MENU_INNER). Top-down degradation: the bulldog drops first
# (ART_OK=false) — the SMALLER no-art block then re-centers — then the wordmark (WORDMARK_OK=false);
# menu+workbox+keyhint always survive. Golden rows R=21/24/25/30/33/34 (fullscreen-no-art), R=35/38/40
# (fullscreen-with-art), R=20 (compact). Hermetic: each test EVALs the single compute_menu_geometry function
# (extract_launcher_fn), stubs term_size + tput, and asserts the derived globals — no TTY, no
# launcher boot, no system mutation.
#
# Run via: bats test/frame-bottom-anchor-geometry.bats
# Requires: bats (brew install bats-core), awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the launcher is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
}

# extract_launcher_fn — eval a single named function (launcher or lib) into the test shell so it can
# be driven in isolation without booting the TUI (mirrors continuous-index.bats).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

# _geo_consts — the production gate + single-asset ART constants at C=5 (mirrors the launcher
# readonly block). MIN_ROWS is the FULLSCREEN gate (21); ART_MIN_ROWS is the SEPARATE art sub-gate
# (35 = BLOCK_H(art)+1 = 12 + C + ART_ROWS), so the centered art block fits fully with top_pad >= 1.
# ART_ROWS/ART_WIDTH are the ONE fixed asset size (no per-band variants).
_geo_consts() {
  PLATE_MARGIN=2
  MAX_READABLE=64
  MIN_COLS=50
  MENU_COUNT=5
  MIN_ROWS=$((5 + 1 + (2 + MENU_COUNT) + 1 + 4 + 3))
  ART_ROWS=18
  ART_WIDTH=55
  ART_MIN_ROWS=$((12 + MENU_COUNT + ART_ROWS))
}

# _run_geometry cols rows — drive compute_menu_geometry hermetically at a fixed TTY size. tput stubbed
# to succeed so the cursor-addressing probe passes; term_size echoes the requested size.
_run_geometry() {
  GEO_COLS="$1"
  GEO_ROWS="$2"
  term_size() { printf '%s %s' "${GEO_COLS}" "${GEO_ROWS}"; }
  tput() { return 0; }
  compute_menu_geometry
}

# --- no-art fullscreen band (21-34): ART_OK=false, the smaller block (BLOCK_H=15) centers ------------

@test "geometry R=21 (fullscreen floor): fullscreen, ART_OK=false, WORDMARK_OK=true, centered anchors" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 21
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  [ "${WORDMARK_OK}" = "true" ]
  # BLOCK_H(no-art)=15; top_pad=(21-15)/2=3; block_top=4; keyhint=block_top+14=18.
  [ "${WORDMARK_FIRST_ROW}" -eq 4 ]
  [ "${SEPARATOR_ROW}" -eq 6 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 7 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 14 ]
  [ "${WORKBOX_BODY_ROW}" -eq 15 ]
  [ "${WORKBOX_BODY_ROW2}" -eq 16 ]
  [ "${MENU_KEYHINT_ROW}" -eq 18 ]
  # keyhint sits ABOVE the terminal's last row now (centered, not bottom-pinned).
  [ "${MENU_KEYHINT_ROW}" -lt 21 ]
  # MENU_FIRST_ROW = frame extent top = the topmost DRAWN row = block_top; ART_OK=false so it equals
  # the wordmark row.
  [ "${MENU_FIRST_ROW}" -eq "${WORDMARK_FIRST_ROW}" ]
  [ "${MENU_FIRST_ROW}" -eq 4 ]
}

@test "geometry R=24: fullscreen, ART_OK=false, centered block, no menu/workbox row loss" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 24
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  # top_pad=(24-15)/2=4; block_top=5; keyhint=19.
  [ "${WORDMARK_FIRST_ROW}" -eq 5 ]
  [ "${SEPARATOR_ROW}" -eq 7 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 8 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 15 ]
  [ "${MENU_KEYHINT_ROW}" -eq 19 ]
  # no-art top region (wordmark) stays on-screen (>=1); the whole block fits inside 24 rows.
  [ "${WORDMARK_FIRST_ROW}" -ge 1 ]
  [ "$((WORKBOX_FIRST_ROW + 3))" -lt "${MENU_KEYHINT_ROW}" ]
}

@test "geometry R=25 (was Compact band, now no-art): ART_OK=false, ART_FIRST_ROW=0, centered" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 25
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  # top_pad=(25-15)/2=5 (floor); block_top=6; keyhint=20.
  [ "${WORDMARK_FIRST_ROW}" -eq 6 ]
  [ "${SEPARATOR_ROW}" -eq 8 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 9 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 16 ]
  [ "${MENU_KEYHINT_ROW}" -eq 20 ]
}

@test "geometry R=30 (was Medium band, now no-art): ART_OK=false, ART_FIRST_ROW=0, centered" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 30
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  # top_pad=(30-15)/2=7; block_top=8; keyhint=22.
  [ "${WORDMARK_FIRST_ROW}" -eq 8 ]
  [ "${SEPARATOR_ROW}" -eq 10 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 11 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 18 ]
  [ "${MENU_KEYHINT_ROW}" -eq 22 ]
}

@test "geometry R=33 (art floor minus two): ART_OK=false, ART_FIRST_ROW=0, centered" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 33
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  # top_pad=(33-15)/2=9; block_top=10; keyhint=24.
  [ "${WORDMARK_FIRST_ROW}" -eq 10 ]
  [ "${SEPARATOR_ROW}" -eq 12 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 13 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 20 ]
  [ "${MENU_KEYHINT_ROW}" -eq 24 ]
}

@test "geometry R=34 (art floor minus one): ART_OK=false, ART_FIRST_ROW=0, centered" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 34
  [ "${FULLSCREEN}" = "true" ]
  # ART_MIN_ROWS is 35, so R=34 falls one row BELOW the art floor -> no-art.
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  # top_pad=(34-15)/2=9 (floor); block_top=10; keyhint=24.
  [ "${WORDMARK_FIRST_ROW}" -eq 10 ]
  [ "${SEPARATOR_ROW}" -eq 12 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 13 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 20 ]
  [ "${MENU_KEYHINT_ROW}" -eq 24 ]
}

# --- art tier (35/38/40): ART_OK=true (wide cols), BLOCK_H(art)=34 centers -------------------------

@test "geometry R=35 (art floor): ART_OK, ART_FIRST_ROW=2 (top_pad clamped to 1)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 35
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "true" ]
  # BLOCK_H(art)=34; top_pad=(35-34)/2=0 -> clamped to 1; block_top=2; keyhint=block_top+33=35.
  [ "${ART_FIRST_ROW}" -eq 2 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 21 ]
  [ "${SEPARATOR_ROW}" -eq 23 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 24 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 31 ]
  [ "${MENU_KEYHINT_ROW}" -eq 35 ]
  # at the floor the block fills the screen exactly: keyhint == rows, one blank row (top_pad) above.
  [ "${MENU_KEYHINT_ROW}" -eq 35 ]
  # MENU_FIRST_ROW = frame extent top = the art top.
  [ "${MENU_FIRST_ROW}" -eq "${ART_FIRST_ROW}" ]
  [ "${MENU_FIRST_ROW}" -eq 2 ]
}

@test "geometry R=38: ART_OK, ART_FIRST_ROW=3, centered above the floor" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 38
  [ "${ART_OK}" = "true" ]
  # top_pad=(38-34)/2=2; block_top=3; keyhint=block_top+33=36; 2 blank above, 2 below.
  [ "${ART_FIRST_ROW}" -eq 3 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 22 ]
  [ "${SEPARATOR_ROW}" -eq 24 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 25 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 32 ]
  [ "${WORKBOX_BODY_ROW}" -eq 33 ]
  [ "${WORKBOX_BODY_ROW2}" -eq 34 ]
  [ "${MENU_KEYHINT_ROW}" -eq 36 ]
  [ "$((38 - MENU_KEYHINT_ROW))" -eq 2 ]
}

@test "geometry R=40: ART_OK, ART_FIRST_ROW=4, art region rows 4..21, keyhint 37" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 40
  [ "${ART_OK}" = "true" ]
  # top_pad=(40-34)/2=3; block_top=4; keyhint=37; rows 1..3 blank above, 38..40 blank below.
  [ "${ART_FIRST_ROW}" -eq 4 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 23 ]
  [ "${SEPARATOR_ROW}" -eq 25 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 26 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 33 ]
  [ "${WORKBOX_BODY_ROW}" -eq 34 ]
  [ "${WORKBOX_BODY_ROW2}" -eq 35 ]
  [ "${MENU_KEYHINT_ROW}" -eq 37 ]
  # MENU_FIRST_ROW = frame extent top = the art top.
  [ "${MENU_FIRST_ROW}" -eq "${ART_FIRST_ROW}" ]
  [ "${MENU_FIRST_ROW}" -eq 4 ]
  # ART_ROWS=18 → art last row = 4 + 18 - 1 = 21, one gap row (22) below the art, wordmark at 23.
  [ "$((ART_FIRST_ROW + ART_ROWS - 1))" -eq 21 ]
  # floor-split centering: BLOCK_H(art)=34 even, rows=40 even -> 3 blank rows above and 3 below.
  [ "$((40 - MENU_KEYHINT_ROW))" -eq 3 ]
}

# --- horizontal fit: a tall-but-narrow terminal drops the bulldog (ART_OK=false) ------------------

@test "geometry R=40 cols=50 (tall but narrow): fullscreen but ART_OK=false, no-art block centers" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 50 40
  # cols=50 >= MIN_COLS -> fullscreen; but MENU_INNER = (min(50-4,64))-2 = 44 < ART_WIDTH(55).
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  # the wordmark tier still survives the horizontal drop of the bulldog.
  [ "${WORDMARK_OK}" = "true" ]
  # dropping the art shrinks BLOCK_H to 15 and re-centers: top_pad=(40-15)/2=12; block_top=13; keyhint=27.
  [ "${WORDMARK_FIRST_ROW}" -eq 13 ]
  [ "${MENU_KEYHINT_ROW}" -eq 27 ]
}

@test "geometry R=40 cols=61 (plate exactly 55): ART_OK=true, ART_FIRST_ROW=4 (horizontal-fit boundary)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 61 40
  # MENU_INNER = (min(61-4,64))-2 = 55 == ART_WIDTH -> the art fits exactly.
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "true" ]
  [ "${ART_FIRST_ROW}" -eq 4 ]
}

@test "geometry R=40 cols=60 (plate 54, one short): ART_OK=false (horizontal-fit boundary)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 60 40
  # MENU_INNER = (min(60-4,64))-2 = 54 < ART_WIDTH(55) -> the art drops.
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
}

# --- WORDMARK_OK gate: true across the fullscreen range, false in compact --------------------------

@test "WORDMARK_OK true across the fullscreen range (R=21 and R=40)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 21
  [ "${WORDMARK_OK}" = "true" ]
  _run_geometry 80 40
  [ "${WORDMARK_OK}" = "true" ]
}

# --- centering symmetry: blank rows above (top_pad) ≈ blank rows below (rows - keyhint) ------------

@test "geometry R=40 centered: floor-split blank rows above and below the block (art tier)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 40
  # top_pad = block_top - 1 (rows above the first drawn row); below = rows - keyhint. BLOCK_H(art)=34 is
  # even and rows=40 is even, so the split is balanced: 3 blank rows above and 3 below.
  local above below
  above=$((MENU_FIRST_ROW - 1))
  below=$((40 - MENU_KEYHINT_ROW))
  [ "${above}" -eq 3 ]
  [ "${below}" -eq 3 ]
  # centering is balanced to within one row (the odd-gap remainder, if any, lands below).
  [ "$((below - above))" -le 1 ]
}

# --- non-overlap: strictly ascending art -> wordmark -> sep -> box-top -> items -> divider -> work --

@test "geometry R=40 non-overlap: art < gap < wordmark < sep < box-top < items < divider < keyhint" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 40
  # art top margin >= 1 (top_pad floored at 1 -> block_top >= 2)
  [ "${ART_FIRST_ROW}" -ge 2 ]
  # art last row strictly above the wordmark (>=1 gap row between)
  [ "$((ART_FIRST_ROW + ART_ROWS - 1))" -lt "${WORDMARK_FIRST_ROW}" ]
  # wordmark (2 rows) strictly above the separator
  [ "$((WORDMARK_FIRST_ROW + 1))" -lt "${SEPARATOR_ROW}" ]
  # separator (blank spacer) strictly above the box top rail
  [ "${SEPARATOR_ROW}" -lt "${MENU_BLOCK_FIRST_ROW}" ]
  # MERGED BOX: box top rail + MENU_COUNT items + ONE blank pad row end EXACTLY at the row above the
  # internal 'work' divider (WORKBOX_FIRST_ROW) — NO menu bottom rail; the blank pad is the USER-DIRECTED
  # breathing row between the last menu item and the divider (top rail offset 1 + C items + 1 blank pad).
  [ "$((MENU_BLOCK_FIRST_ROW + MENU_COUNT + 2))" -eq "${WORKBOX_FIRST_ROW}" ]
  # workbox section (divider + LINE1 + LINE2 + bottom rail = 4 rows) bottom rail strictly above the keyhint
  [ "$((WORKBOX_FIRST_ROW + 3))" -lt "${MENU_KEYHINT_ROW}" ]
  # keyhint is the block's LAST row (bottom rail directly above it, no gap).
  [ "$((WORKBOX_FIRST_ROW + 4))" -eq "${MENU_KEYHINT_ROW}" ]
}

# --- degradation: rows<21 OR cols<MIN_COLS -> compact top-left, unchanged (ART_OK never true) -----

@test "geometry R=20 (below FULLSCREEN gate): compact top-left, ART_OK=false, WORDMARK_OK=false" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 20
  [ "${FULLSCREEN}" = "false" ]
  [ "${ART_OK}" = "false" ]
  [ "${WORDMARK_OK}" = "false" ]
  [ "${MENU_LEFT}" -eq "${PLATE_MARGIN}" ]
}

@test "geometry cols<MIN_COLS: compact top-left, ART_OK=false (art never draws compact)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 49 40
  [ "${FULLSCREEN}" = "false" ]
  [ "${ART_OK}" = "false" ]
  [ "${WORDMARK_OK}" = "false" ]
}
