#!/usr/bin/env bats
# art-band-selection.bats — pure-math coverage for the SINGLE art-tier gate (T1). The 3-band system
# (Large/Medium/Compact) is retired: the bulldog is ONE fixed 55x18 asset, admitted by a single
# boolean ART_OK. compute_menu_geometry sets ART_OK = FULLSCREEN AND rows >= ART_MIN_ROWS (=35 at
# C=5) AND the 55-cell art fits the centered plate inner (MENU_INNER >= ART_WIDTH). The horizontal
# fit derives from the same plate math the menu uses (MENU_INNER = min(cols-2*margin, MAX_READABLE) -
# 2), never a cols literal — so a tall-but-narrow terminal drops the bulldog. WORDMARK_OK is the
# step-2 degradation gate (wordmark+blank-separator survive the bulldog drop). This file pins the gate
# DECISION (ART_OK / WORDMARK_OK / the ART_FIRST_ROW zero-clamp) across the vertical floor, the
# horizontal-fit boundary, and the compact fallback; the CENTERED anchor row math is pinned in
# frame-bottom-anchor-geometry.bats. Hermetic: EVAL the single function, stub term_size + tput, assert.
#
# Run via: bats test/art-band-selection.bats
# Requires: bats (brew install bats-core), awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  trap - ERR
}

extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

# _geo_consts — production gate + single-asset ART constants at C=5 (mirrors the launcher readonly
# block). ART_ROWS/ART_WIDTH are the ONE fixed asset size; ART_MIN_ROWS = 12 + C + ART_ROWS = 35
# (the flatter 18-row asset lowered the art floor from the pre-flatten 39).
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

_run_geometry() {
  GEO_COLS="$1"
  GEO_ROWS="$2"
  term_size() { printf '%s %s' "${GEO_COLS}" "${GEO_ROWS}"; }
  tput() { return 0; }
  compute_menu_geometry
}

# _assert_gate cols rows fullscreen art_ok wordmark_ok — one-shot gate-decision assertion helper.
_assert_gate() {
  _geo_consts
  _run_geometry "$1" "$2"
  [ "${FULLSCREEN}" = "$3" ]
  [ "${ART_OK}" = "$4" ]
  [ "${WORDMARK_OK}" = "$5" ]
}

# --- vertical floor: rows 34 no-art | 35 art (wide cols) -------------------------------------------

@test "gate R=34 cols=80: ART_OK=false (one row below the art floor)" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 34 true false true
}

@test "gate R=35 cols=80: ART_OK=true (art floor exactly met, plate wide)" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 35 true true true
}

@test "gate R=40 cols=80: ART_OK=true (above the floor, plate wide)" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 40 true true true
}

@test "gate R=25 cols=80 (was Compact band): ART_OK=false (no more compact art band)" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 25 true false true
}

# --- horizontal fit: the plate must seat 55 cells; threshold is cols>=61 (MENU_INNER>=55) ---------

@test "gate R=40 cols=60: ART_OK=false (plate inner 54 < 55, one short)" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 60 40 true false true
}

@test "gate R=40 cols=61: ART_OK=true (plate inner 55 == 55, exact fit)" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 61 40 true true true
}

@test "gate R=40 cols=50 (tall but narrow): ART_OK=false, wordmark survives" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 50 40 true false true
}

# --- both axes required: tall-but-narrow AND short-but-wide both drop the bulldog -----------------

@test "gate R=35 cols=50 (art floor met, plate too narrow): ART_OK=false" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 50 35 true false true
}

@test "gate R=34 cols=80 (plate wide, rows below floor): ART_OK=false" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 34 true false true
}

# --- ART_FIRST_ROW zero-clamp: 0 when the art tier is off, block_top (= top_pad+1) when on ---------

@test "clamp R=25: art off -> ART_FIRST_ROW=0" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 25
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
}

@test "clamp R=40 cols=50: horizontal drop -> ART_FIRST_ROW=0" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 50 40
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
}

@test "clamp R=35 cols=80: art on -> ART_FIRST_ROW = block_top = 2 (top_pad clamped to 1)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 35
  [ "${ART_OK}" = "true" ]
  # BLOCK_H(art)=34; top_pad=(35-34)/2=0 -> floor-clamped to 1; block_top=top_pad+1=2.
  [ "${ART_FIRST_ROW}" -eq 2 ]
}

@test "clamp R=40 cols=80: art on -> ART_FIRST_ROW = block_top = 4 (centered)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  _run_geometry 80 40
  [ "${ART_OK}" = "true" ]
  # BLOCK_H(art)=34; top_pad=(40-34)/2=3 (floor); block_top=4.
  [ "${ART_FIRST_ROW}" -eq 4 ]
}

# --- WORDMARK_OK step-2 gate + compact fallback ---------------------------------------------------

@test "gate R=21 cols=80: fullscreen floor, ART_OK=false, WORDMARK_OK=true" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 21 true false true
}

@test "gate R=20 cols=80 (compact-tui): FULLSCREEN=false, both gates off" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 80 20 false false false
}

@test "gate R=40 cols=49 (below MIN_COLS): FULLSCREEN=false, both gates off" {
  extract_launcher_fn compute_menu_geometry
  _assert_gate 49 40 false false false
}
