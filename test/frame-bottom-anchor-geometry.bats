#!/usr/bin/env bats
# frame-bottom-anchor-geometry.bats — pure-math golden pins for the bottom-fixed build-UP geometry
# (T1). compute_menu_geometry pins the keyhint to the last row (R) and anchors every region UPWARD
# by a MENU_COUNT(C)-derived offset. These anchors are the SoT downstream render/redraw waves
# consume, so they are golden-pinned here FIRST at C=5:
#
#   keyhint R | workbox R-4..R-1 | menu top rail R-(7+C) | separator R-(8+C) |
#   wordmark R-(10+C)..R-(9+C) | art gap R-(11+C) | art R-(11+C)-ART_ROWS..R-(12+C)
#
# The bulldog is ONE fixed 55x21 asset (the 3-band system is retired). The single art tier is gated
# by ART_OK = rows >= ART_MIN_ROWS (=39 at C=5) AND the 55-cell art fits the centered plate inner
# (MENU_INNER). When admitted, ART_FIRST_ROW = R-(11+C)-ART_ROWS = R-37. Top-down degradation: the
# bulldog drops first (ART_OK=false), then the wordmark (WORDMARK_OK=false); menu+workbox+keyhint
# always survive. Golden rows R=21/24/25/30/38 (fullscreen-no-art), R=39/40 (fullscreen-with-art),
# R=20 (compact). Hermetic: each test EVALs the single compute_menu_geometry function
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
# (39 = 13 + C + ART_ROWS). ART_ROWS/ART_WIDTH are the ONE fixed asset size (no per-band variants).
_geo_consts() {
  PLATE_MARGIN=2
  MAX_READABLE=64
  MIN_COLS=50
  MENU_COUNT=5
  MIN_ROWS=$((5 + 1 + (2 + MENU_COUNT) + 1 + 4 + 3))
  ART_ROWS=21
  ART_WIDTH=55
  ART_MIN_ROWS=$((13 + MENU_COUNT + ART_ROWS))
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

# --- no-art fullscreen band (21-38): ART_OK=false, bottom-fixed stack, menu+workbox survive --------

@test "geometry R=21 (fullscreen floor): fullscreen, ART_OK=false, WORDMARK_OK=true, bottom-fixed anchors" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 21
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  [ "${WORDMARK_OK}" = "true" ]
  [ "${MENU_KEYHINT_ROW}" -eq 21 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 17 ]
  [ "${WORKBOX_BODY_ROW}" -eq 18 ]
  [ "${WORKBOX_BODY_ROW2}" -eq 19 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 9 ]
  [ "${SEPARATOR_ROW}" -eq 8 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 6 ]
  [ "${MENU_FIRST_ROW}" -eq 6 ]
}

@test "geometry R=24: fullscreen, ART_OK=false, no menu/workbox row loss" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 24
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${MENU_KEYHINT_ROW}" -eq 24 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 20 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 12 ]
  [ "${SEPARATOR_ROW}" -eq 11 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 9 ]
  # no-art top region (wordmark) stays on-screen (>=1); the whole stack fits inside 24 rows.
  [ "${WORDMARK_FIRST_ROW}" -ge 1 ]
  [ "$((WORKBOX_FIRST_ROW + 3))" -lt "${MENU_KEYHINT_ROW}" ]
}

@test "geometry R=25 (was Compact band, now no-art): ART_OK=false, ART_FIRST_ROW=0, anchors unchanged" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 25
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  [ "${MENU_KEYHINT_ROW}" -eq 25 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 21 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 13 ]
  [ "${SEPARATOR_ROW}" -eq 12 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 10 ]
}

@test "geometry R=30 (was Medium band, now no-art): ART_OK=false, ART_FIRST_ROW=0" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 30
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  [ "${MENU_KEYHINT_ROW}" -eq 30 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 26 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 18 ]
  [ "${SEPARATOR_ROW}" -eq 17 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 15 ]
}

@test "geometry R=38 (art floor minus one): ART_OK=false, ART_FIRST_ROW=0" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 38
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  [ "${MENU_KEYHINT_ROW}" -eq 38 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 34 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 26 ]
  [ "${SEPARATOR_ROW}" -eq 25 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 23 ]
}

# --- art tier (39/40): ART_OK=true (wide cols), ART_FIRST_ROW = R-37 -------------------------------

@test "geometry R=39 (art floor): ART_OK, ART_FIRST_ROW=2 (top margin 1)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 39
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "true" ]
  [ "${ART_FIRST_ROW}" -eq 2 ]
  [ "${MENU_KEYHINT_ROW}" -eq 39 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 35 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 27 ]
  [ "${SEPARATOR_ROW}" -eq 26 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 24 ]
}

@test "geometry R=40: ART_OK, ART_FIRST_ROW=3, art region rows 3..23" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 40
  [ "${ART_OK}" = "true" ]
  [ "${ART_FIRST_ROW}" -eq 3 ]
  [ "${MENU_KEYHINT_ROW}" -eq 40 ]
  [ "${WORKBOX_FIRST_ROW}" -eq 36 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 28 ]
  [ "${SEPARATOR_ROW}" -eq 27 ]
  [ "${WORDMARK_FIRST_ROW}" -eq 25 ]
  # ART_ROWS=21 → art last row = 3 + 21 - 1 = 23, one gap row (24) below the wordmark (25).
  [ "$((ART_FIRST_ROW + ART_ROWS - 1))" -eq 23 ]
}

# --- horizontal fit: a tall-but-narrow terminal drops the bulldog (ART_OK=false) ------------------

@test "geometry R=40 cols=50 (tall but narrow): fullscreen but ART_OK=false (plate < 55)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 50 40
  # cols=50 >= MIN_COLS -> fullscreen; but MENU_INNER = (min(50-4,64))-2 = 44 < ART_WIDTH(55).
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  # the wordmark tier still survives the horizontal drop of the bulldog.
  [ "${WORDMARK_OK}" = "true" ]
  [ "${MENU_KEYHINT_ROW}" -eq 40 ]
}

@test "geometry R=40 cols=61 (plate exactly 55): ART_OK=true (horizontal-fit boundary)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 61 40
  # MENU_INNER = (min(61-4,64))-2 = 55 == ART_WIDTH -> the art fits exactly.
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "true" ]
  [ "${ART_FIRST_ROW}" -eq 3 ]
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

# --- non-overlap: the whole stack is strictly ascending art -> wordmark -> sep -> menu -> workbox -

@test "geometry R=40 non-overlap: art < gap < wordmark < sep < menu < gap < workbox < keyhint" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 40
  # art top margin >= 1
  [ "${ART_FIRST_ROW}" -ge 2 ]
  # art last row strictly above the wordmark (>=1 gap row between)
  [ "$((ART_FIRST_ROW + ART_ROWS - 1))" -lt "${WORDMARK_FIRST_ROW}" ]
  # wordmark (2 rows) strictly above the separator
  [ "$((WORDMARK_FIRST_ROW + 1))" -lt "${SEPARATOR_ROW}" ]
  # separator strictly above the menu top rail
  [ "${SEPARATOR_ROW}" -lt "${MENU_BLOCK_FIRST_ROW}" ]
  # menu block (2 rails + MENU_COUNT items) bottom strictly above the workbox top (>=1 gap)
  [ "$((MENU_BLOCK_FIRST_ROW + 2 + MENU_COUNT - 1))" -lt "${WORKBOX_FIRST_ROW}" ]
  # workbox (4 rows) bottom rail strictly above the pinned keyhint
  [ "$((WORKBOX_FIRST_ROW + 3))" -lt "${MENU_KEYHINT_ROW}" ]
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
