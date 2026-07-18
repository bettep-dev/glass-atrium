#!/usr/bin/env bash
# art-nav-static-invariant-harness.sh — CUP-addressing coverage for the differential-vs-full redraw
# split (T6) on the UNCOMMITTED working tree. The bulldog art is a STATIC top region: an arrow-move
# (redraw_nav_move) MUST repaint ONLY the two changed menu rows + the workbox body and NEVER address
# an art row, while the full in-place composer (redraw_frame_inplace) MUST clear+recompose the WHOLE
# cached extent INCLUDING the art rows (so a dim/done/return transition leaves no ghost). The block is
# VERTICALLY CENTERED, so at R=40 top_pad=(40-34)/2=3 seats the art at block_top=4 and the keyhint at
# the block's last row 37 (rows 1..3 + rows 38..40 are the centering pad). Three invariants at the canonical
# R=40 / cols=80 art tier (ART_OK, ART_FIRST_ROW=4, art band rows 4..21):
#
#   (I1) STATIC ART   — redraw_nav_move addresses NO row in [ART_FIRST_ROW, ART_FIRST_ROW+17] = [4,21]
#                       (it touches only the prev/cur menu rows + the workbox body row).
#   (I2) EXTENT PROOF — redraw_frame_inplace addresses EVERY row of [ART_FIRST_ROW..MENU_KEYHINT_ROW]
#                       = [4..37] (the per-row ESC[2K pre-clear covers exactly the centered block).
#   (I3) IDEMPOTENT   — repeated redraw_frame_inplace emits BYTE-IDENTICAL output (no accumulation).
#
# The REAL compose/redraw orchestration is exercised (compute_menu_geometry, redraw_frame_inplace,
# redraw_nav_move, _compose_frame_regions, paint_menu_row) with the REAL cup_to instrumented to record
# each addressed row; only the heavy leaf renderers are stubbed, each re-emitting its PRODUCTION cup_to
# anchor sourced from the REAL geometry globals (ART_FIRST_ROW/SEPARATOR_ROW/... — never a row literal),
# so the captured addressing is faithful and low-drift. READ-ONLY toward the live system: no TTY, no
# stty, no alt-screen; every sink writes to a captured pipe or /dev/null.
#
# ShellCheck: this harness sources the frame + primitives modules and OVERRIDES their symbols, so the
# usual dynamic-source false positives apply — SC2034 vars read by the sourced fns · SC2154 globals
# assigned by the (absent) loader · SC2329 fns invoked indirectly by the sourced code.
# shellcheck disable=SC2034,SC2154,SC2329
set -uo pipefail

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GA_DIR_ROOT="$(cd -- "${HARNESS_DIR}/.." && pwd)"
LIB="${GA_DIR_ROOT}/lib"

# shellcheck source=/dev/null
source "${LIB}/ga-tui-primitives.sh"
# shellcheck source=/dev/null
source "${LIB}/ga-tui-frame.sh"
set +e
trap - ERR EXIT INT TERM

FAILS=0
PASSES=0
pass() {
  PASSES=$((PASSES + 1))
  printf '    PASS  %s\n' "$1"
}
fail() {
  FAILS=$((FAILS + 1))
  printf '    FAIL  %s\n' "$1"
}

# === production gate + single-asset ART constants at C=5 (mirror the launcher readonly block) =====
PLATE_MARGIN=2
MAX_READABLE=64
MIN_COLS=50
MENU_COUNT=5
MIN_ROWS=$((5 + 1 + (2 + MENU_COUNT) + 1 + 4 + 3))
ART_ROWS=18
ART_WIDTH=55
ART_MIN_ROWS=$((12 + MENU_COUNT + ART_ROWS))
USE_UTF8=true
COLUMNS=80
GEOMETRY_DIRTY=true
PLATE_LEFT="${PLATE_MARGIN}"
MENU_INNER_OVERRIDE=""

# === cup_to instrumentation: record every addressed row into CUP_ROWS, emit the real ESC to TTY ===
CUP_ROWS="$(mktemp "${TMPDIR:-/tmp}/ga-artnav-cup.XXXXXX")"
_cup_reset() { : >"${CUP_ROWS}"; }
cup_to() {
  printf '%s\n' "$1" >>"${CUP_ROWS}"
  printf '\033[%s;%sH' "$1" "$2" >"${TTY}"
}

# === leaf-renderer stubs: each re-emits its PRODUCTION cup anchor from the REAL geometry globals ====
# (the compose/redraw orchestration + paint_menu_row stay REAL; only content builders are stubbed).
draw_bulldog_art() {
  [[ "${FULLSCREEN}" == "true" && "${ART_OK}" == "true" && "${USE_UTF8}" == "true" ]] || return 0
  cup_to "${ART_FIRST_ROW}" 1
}
draw_wordmark() { :; }                                        # wrapper cups WORDMARK_FIRST_ROW
# draw_separator emits NOTHING in fullscreen now (blank spacer) — mirror production: no cup.
draw_separator() { [[ "${FULLSCREEN}" == "true" ]] && return 0; cup_to "${SEPARATOR_ROW}" 1; }
draw_menu() { :; }                                            # wrapper cups MENU_BLOCK_FIRST_ROW
draw_workbox() { [[ "${FULLSCREEN}" == "true" ]] && cup_to "${WORKBOX_FIRST_ROW}" 1; }
draw_bottom_row() { [[ "${FULLSCREEN}" == "true" ]] && cup_to "${MENU_KEYHINT_ROW}" "$((MENU_LEFT + 1))"; }
paint_workbox_body_inner() { cup_to "${WORKBOX_BODY_ROW}" "$((MENU_LEFT + 2))"; }
workbox_body_str() { printf 'body'; }   # redraw_nav_move builds paint_workbox_body_inner's arg from this
menu_row_str() { printf 'row%s' "$1"; } # paint_menu_row builds its arg from this
plate_row() { :; }                      # paint_menu_row's emit (cup addressing is what matters)

# === term stubs: fixed R=40/cols=80 size + succeeding cursor-addressing probe =====================
term_size() { printf '80 40'; }
tput() { return 0; }

# === geometry populate: run the REAL compute once, then cache (dirty=false) ========================
_populate_geometry() {
  GEOMETRY_DIRTY=true
  compute_menu_geometry
  GEOMETRY_DIRTY=false
  apply_plate_geometry
}

# _rows_in_band lo hi — echo the count of recorded CUP rows r with lo <= r <= hi.
_rows_in_band() {
  local lo="$1" hi="$2" r n=0
  while IFS= read -r r; do
    [[ "${r}" =~ ^[0-9]+$ ]] || continue
    if [[ "${r}" -ge "${lo}" && "${r}" -le "${hi}" ]]; then n=$((n + 1)); fi
  done <"${CUP_ROWS}"
  printf '%s' "${n}"
}

# _row_recorded r — return 0 iff row r appears in CUP_ROWS.
_row_recorded() { grep -qx "$1" "${CUP_ROWS}"; }

# === drive ========================================================================================
_populate_geometry

printf '\n  art-nav-static-invariant — R=40 cols=80 (ART_OK, ART_FIRST_ROW=%s, band [%s,%s])\n' \
  "${ART_FIRST_ROW}" "${ART_FIRST_ROW}" "$((ART_FIRST_ROW + ART_ROWS - 1))"

# preconditions: the tier we intend to exercise actually engaged.
_expect() { # $1 label · $2 actual · $3 expected
  if [[ "$2" == "$3" ]]; then pass "$1 (= $3)"; else fail "$1 (expected $3, got $2)"; fi
}
_expect "precondition FULLSCREEN" "${FULLSCREEN}" "true"
_expect "precondition ART_OK" "${ART_OK}" "true"
_expect "precondition ART_FIRST_ROW" "${ART_FIRST_ROW}" "4"
_expect "precondition MENU_KEYHINT_ROW" "${MENU_KEYHINT_ROW}" "37"

ART_LO="${ART_FIRST_ROW}"
ART_HI=$((ART_FIRST_ROW + ART_ROWS - 1))

# --- (I1) STATIC ART: redraw_nav_move addresses no art row ----------------------------------------
_cup_reset
TTY=/dev/null redraw_nav_move 0 1
nav_art="$(_rows_in_band "${ART_LO}" "${ART_HI}")"
if [[ "${nav_art}" -eq 0 ]]; then
  pass "(I1) redraw_nav_move addresses 0 rows in the art band [${ART_LO},${ART_HI}]"
else
  fail "(I1) redraw_nav_move addressed ${nav_art} art-band rows (expected 0)"
fi
# positive complement: it DID repaint the two menu rows (27,28) + the workbox body row (34).
# (MENU_BLOCK_FIRST_ROW=26 → items at 27+i; the centered art tier seats the box top rail at 26.)
nav_rows="$(tr '\n' ' ' <"${CUP_ROWS}")"
if _row_recorded 27 && _row_recorded 28 && _row_recorded "${WORKBOX_BODY_ROW}"; then
  pass "(I1) redraw_nav_move repainted menu rows 27,28 + workbox body ${WORKBOX_BODY_ROW}"
else
  fail "(I1) redraw_nav_move missed an expected menu/workbox row (rows: ${nav_rows})"
fi

# --- (I2) EXTENT PROOF: redraw_frame_inplace addresses every row of [ART_FIRST_ROW..MENU_KEYHINT] --
_cup_reset
TTY=/dev/null redraw_frame_inplace
inplace_art="$(_rows_in_band "${ART_LO}" "${ART_HI}")"
if [[ "${inplace_art}" -gt 0 ]]; then
  pass "(I2) redraw_frame_inplace addresses the art band (${inplace_art} rows in [${ART_LO},${ART_HI}])"
else
  fail "(I2) redraw_frame_inplace addressed NO art-band row (extent not lifted to ART_FIRST_ROW)"
fi
missing=""
r="${ART_FIRST_ROW}"
while [[ "${r}" -le "${MENU_KEYHINT_ROW}" ]]; do
  _row_recorded "${r}" || missing="${missing} ${r}"
  r=$((r + 1))
done
if [[ -z "${missing}" ]]; then
  pass "(I2) full extent [${ART_FIRST_ROW}..${MENU_KEYHINT_ROW}] pre-cleared (every row addressed)"
else
  fail "(I2) extent gap — unaddressed rows:${missing}"
fi

# --- (I3) IDEMPOTENT: repeated redraw_frame_inplace is byte-identical ------------------------------
_cup_reset
out1="$(TTY=/dev/stdout redraw_frame_inplace)"
out2="$(TTY=/dev/stdout redraw_frame_inplace)"
if [[ "${out1}" == "${out2}" ]]; then
  pass "(I3) two redraw_frame_inplace passes emit byte-identical output (no accumulation)"
else
  fail "(I3) redraw_frame_inplace output differs between passes (non-idempotent)"
fi

rm -f "${CUP_ROWS}"

printf '\n'
printf '============================================================================\n'
printf 'ART-NAV RESULT: %s passed, %s failed\n' "${PASSES}" "${FAILS}"
printf '============================================================================\n'
[[ "${FAILS}" -eq 0 ]]
