#!/usr/bin/env bats
# art-plate-alignment.bats — center-align + anchor pins for the composed bulldog art region (T5).
# _compose_frame_regions seats the art as the TOP region at an ABSOLUTE cup_to ART_FIRST_ROW, then
# stacks the ART_ROWS asset rows via natural newlines at a CENTERED left pad. This file pins the
# horizontal + vertical placement contract at the canonical R=40 / cols=80 tier (ART_OK, plate wide;
# ART_FIRST_ROW=4 since the whole block is VERTICALLY CENTERED — BLOCK_H(art)=34, top_pad=(40-34)/2=3,
# block_top=4):
#
#   * pad = PLATE_LEFT + (plate_inner - ART_WIDTH)/2 (mirror of draw_wordmark:121) — 8 + (62-55)/2 = 11
#   * first art row: EXACTLY one absolute CUP at (ART_FIRST_ROW, 1) = (4, 1); last art row lands at
#     ART_FIRST_ROW + ART_ROWS - 1 = 21 (single anchor + ART_ROWS natural-newline rows, no extra CUP)
#   * wordmark + menu anchors RE-CENTER when the art drops: the smaller no-art block (BLOCK_H 15 vs 34)
#     centers higher, so dropping the bulldog moves the wordmark + box UP by 10 rows — the
#     centered model, UNLIKE the old bottom-fixed stack where these anchors were art-invariant
#   * a mono run (empty C_*) has BYTE-IDENTICAL geometry to the colored run once SGR is discounted
#     (same CUP, same pad, same row count)
#
# The render is driven through the SAME strict-mode probe art-tier-degradation.bats uses (real
# ga-tui-primitives.sh + ga-tui-bulldog.sh sourced, TTY=/dev/stdout so the `>"${TTY}"` single-line
# sinks accumulate on the captured pipe). The geometry re-centering assertions EVAL the real
# compute_menu_geometry via extract_launcher_fn (mirrors frame-bottom-anchor-geometry.bats).
#
# Run via: bats test/art-plate-alignment.bats
# Requires: bats (brew install bats-core), awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"
PROBE=""

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  [[ -f "${GA}/lib/ga-tui-bulldog.sh" ]] || skip "bulldog module not found"
  [[ -r "${GA}/docs/assets/bulldog-braille.txt" ]] || skip "bulldog asset not found"
  # the lib modules are sourced under strict mode in the probe; suspend any inherited ERR trap
  # in the test shell defensively (mirrors art-tier-degradation.bats).
  trap - ERR
  # env-driven strict-mode render probe: defaults reproduce the canonical R=40/cols=80 art tier
  # (PLATE_LEFT=8, MENU_INNER=62, ART_FIRST_ROW=4), overridable so mono reuses one probe.
  PROBE="${BATS_TEST_TMPDIR}/render-probe.sh"
  cat >"${PROBE}" <<'PROBE_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
GA_ROOT="${PROBE_GA_ROOT:?}"
FULLSCREEN="${PROBE_FULLSCREEN:-true}"
ART_OK="${PROBE_ART_OK:-true}"
USE_UTF8="${PROBE_USE_UTF8:-true}"
USE_COLOR="${PROBE_USE_COLOR:-true}"
PLATE_MARGIN=2
PLATE_LEFT="${PROBE_PLATE_LEFT:-8}"
ART_ROWS=18
ART_WIDTH=55
ART_FIRST_ROW="${PROBE_ART_FIRST_ROW:-4}"
MENU_INNER_OVERRIDE="${PROBE_INNER:-62}"
# `-` default: unset -> the fallback code; set-but-empty -> "" (the mono tier passes C_*= empty).
C_INFO="${PROBE_C_INFO-94}"
C_STRONG="${PROBE_C_STRONG-97}"
C_ACCENT="${PROBE_C_ACCENT-96}"
C_DIM="${PROBE_C_DIM-90}"
BULLDOG_ROWS=()
BULLDOG_ROWS_C=()
BULLDOG_LOADED=false
# shellcheck source=/dev/null
source "${PROBE_LIB:?}/ga-tui-primitives.sh"
# shellcheck source=/dev/null
source "${PROBE_LIB:?}/ga-tui-bulldog.sh"
TTY=/dev/stdout draw_bulldog_art
PROBE_EOF
}

# _esc — a literal ESC byte (mirrors ga-tui-primitives.sh strip_csi; $'\033' avoided for 3.2 parity).
_esc() { printf '\033'; }

# extract_launcher_fn — eval a single named launcher/lib function into the test shell (mirrors
# frame-bottom-anchor-geometry.bats) for the hermetic geometry assertions.
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

# _geo_consts — the production gate + single-asset ART constants at C=5 (mirrors the launcher).
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

# _run_geometry cols rows — drive compute_menu_geometry hermetically (tput ok, term_size echoes size).
_run_geometry() {
  GEO_COLS="$1"
  GEO_ROWS="$2"
  term_size() { printf '%s %s' "${GEO_COLS}" "${GEO_ROWS}"; }
  tput() { return 0; }
  compute_menu_geometry
}

# --- horizontal: centered pad = PLATE_LEFT + (plate_inner - ART_WIDTH)/2 = 11 ----------------------

@test "art rows emitted at centered pad 11 = PLATE_LEFT 8 + (inner 62 - ART_WIDTH 55)/2" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" bash "${PROBE}"
  [ "${status}" -eq 0 ]
  [ "${#lines[@]}" -eq 18 ]
  # Formula pin: PLATE_LEFT=8, inner=62, ART_WIDTH=55 -> 8 + (62-55)/2 = 8 + 3 = 11.
  local expected_pad=$((8 + (62 - 55) / 2))
  [ "${expected_pad}" -eq 11 ]
  # First art row (lines[0]) carries the leading absolute CUP, so strip up to its 'H' first, THEN
  # measure the pad; the last art row (lines[17]) has no CUP prefix so measure directly.
  local first_body first_pad last_pad
  first_body="${lines[0]#*H}"
  first_pad="${first_body%%[! ]*}"
  last_pad="${lines[17]%%[! ]*}"
  [ "${#first_pad}" -eq "${expected_pad}" ]
  [ "${#last_pad}" -eq "${expected_pad}" ]
}

# --- vertical: first art row CUP = (ART_FIRST_ROW, 1); single anchor -> last row = block_top+20 -----

@test "art anchor: EXACTLY one CUP at (ART_FIRST_ROW 4, col 1), 18 rows stacked to last row 21" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" bash "${PROBE}"
  [ "${status}" -eq 0 ]
  local esc
  esc="$(_esc)"
  # Only CUP sequences end in 'H' (SGR ends in 'm'); the art is a SINGLE cup_to + natural-newline
  # stack, so there is EXACTLY one CUP and it is the first-row anchor at row 4, col 1.
  local cups cup_count first_cup
  cups="$(printf '%s' "${output}" | grep -o "${esc}\[[0-9]*;[0-9]*H")"
  cup_count="$(printf '%s\n' "${cups}" | grep -c .)"
  [ "${cup_count}" -eq 1 ]
  first_cup="$(printf '%s\n' "${cups}" | head -1)"
  [ "${first_cup}" = "$(printf '\033[4;1H')" ]
  # The single anchor at row 4 plus exactly ART_ROWS natural-newline rows (no extra CUP walks the
  # cursor) is what places the last art row at ART_FIRST_ROW + ART_ROWS - 1 = 21: assert the emitted
  # row count IS ART_ROWS, so the landing follows from the verified single-anchor stack, not from
  # re-deriving the constant.
  [ "${#lines[@]}" -eq 18 ]
}

# --- wordmark/menu anchors RE-CENTER when the art drops (centered block, not art-invariant) ---------

@test "wordmark + menu anchors re-center when the art drops (moves up 10 rows)" {
  extract_launcher_fn compute_menu_geometry
  _geo_consts
  # art present: R=40 cols=80 -> ART_OK=true, BLOCK_H(art)=34, top_pad=3, block_top=4.
  _run_geometry 80 40
  [ "${ART_OK}" = "true" ]
  local wm_art="${WORDMARK_FIRST_ROW}" menu_art="${MENU_BLOCK_FIRST_ROW}" sep_art="${SEPARATOR_ROW}"
  # canonical art-tier pins (block_top=4): wordmark 4+19=23, blank sep 25, box top rail 26.
  [ "${wm_art}" -eq 23 ]
  [ "${sep_art}" -eq 25 ]
  [ "${menu_art}" -eq 26 ]
  # art dropped (tall but narrow): R=40 cols=50 -> ART_OK=false, BLOCK_H(no-art)=15, the SMALLER block
  # re-centers HIGHER: top_pad=(40-15)/2=12, block_top=13.
  _run_geometry 50 40
  [ "${ART_OK}" = "false" ]
  [ "${WORDMARK_FIRST_ROW}" -eq 13 ]
  [ "${SEPARATOR_ROW}" -eq 15 ]
  [ "${MENU_BLOCK_FIRST_ROW}" -eq 16 ]
  # the re-centering shift = wordmark 23 (art tier) - 13 (no-art) = 10 rows up (block_top 4+art-lead 19
  # vs no-art block_top 13).
  [ "$((wm_art - WORDMARK_FIRST_ROW))" -eq 10 ]
  [ "$((menu_art - MENU_BLOCK_FIRST_ROW))" -eq 10 ]
}

# --- mono run (empty C_*) is byte-identical to the colored run once SGR is discounted --------------

@test "mono (empty C_*): identical CUP, pad, row count vs colored run (SGR discounted)" {
  local esc
  esc="$(_esc)"
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" bash "${PROBE}"
  [ "${status}" -eq 0 ]
  local color_lines="${#lines[@]}"
  local color_cup color_first_body color_pad
  color_cup="$(printf '%s' "${output}" | grep -o "${esc}\[[0-9]*;[0-9]*H" | head -1)"
  color_first_body="${lines[0]#*H}"
  color_pad="${color_first_body%%[! ]*}"

  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" \
    PROBE_USE_COLOR=false PROBE_C_INFO= PROBE_C_STRONG= PROBE_C_ACCENT= PROBE_C_DIM= \
    bash "${PROBE}"
  [ "${status}" -eq 0 ]
  # mono emits NO SGR sequence (the cup_to ESC[..H is not an SGR 'm' sequence).
  ! printf '%s' "${output}" | grep -q "${esc}\[[0-9;]*m"
  # identical geometry: same row count, same first-row anchor, same centered pad.
  [ "${#lines[@]}" -eq "${color_lines}" ]
  local mono_cup mono_first_body mono_pad
  mono_cup="$(printf '%s' "${output}" | grep -o "${esc}\[[0-9]*;[0-9]*H" | head -1)"
  mono_first_body="${lines[0]#*H}"
  mono_pad="${mono_first_body%%[! ]*}"
  [ "${mono_cup}" = "${color_cup}" ]
  [ "${#mono_pad}" -eq "${#color_pad}" ]
}
