#!/usr/bin/env bats
# art-scrollback-safety.bats — scrollback-discipline pins for the composed frame (T5/T6). The frame is
# painted with ABSOLUTE cup_to addressing bounded by the CENTERED block extent, and the LAST region
# (draw_bottom_row/draw_keyhint) parks the cursor at the keyhint row (the block's last row) WITHOUT a
# trailing newline — a '\n' there would scroll the alt-screen and stack top-rail fragments on the next
# cached redraw. The block is vertically centered, so there are blank (unaddressed) rows BOTH above the
# block top AND below the keyhint. Two tiers:
#
#   (art tier, R=40/cols=80) _compose_frame_regions
#     * addresses NO row beyond MENU_KEYHINT_ROW (37 — the block's last row, ABOVE the terminal's last
#       row 40, since rows 38..40 are the bottom centering pad)
#     * addresses NOTHING above the block top (min cup == MENU_FIRST_ROW == ART_FIRST_ROW == 4; rows
#       1..3 are the top centering pad)
#     * emits NO trailing newline after the keyhint row (last byte is not 0x0a)
#   (no-art band, 21<=rows<35, R=30/cols=80) _compose_frame_regions
#     * addresses NOTHING above WORDMARK_FIRST_ROW — the bulldog is gated off (ART_OK=false) so the
#       top DRAWN region is the wordmark; no cup_to reaches a row < WORDMARK_FIRST_ROW
#
# The REAL orchestration is exercised (compute_menu_geometry, _compose_frame_regions) with the REAL
# draw_bottom_row/draw_keyhint (they own the no-trailing-newline discipline) and cup_to instrumented to
# record each addressed row. Heavy content builders are stubbed, each re-emitting its PRODUCTION cup
# anchor from the REAL geometry globals — faithful, low-drift. draw_separator emits NOTHING in
# fullscreen (the ex-separator row is a blank spacer), so its stub records no cup. Byte output is
# captured via a pipe (od hex), NOT bats `run` (which strips the trailing newline the test must observe).
#
# Run via: bats test/art-scrollback-safety.bats
# Requires: bats (brew install bats-core), awk, od, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"
LIB="${GA}/lib"
CUP_ROWS=""
COMPOSE_HEX=""

# extract_launcher_fn — eval a single named launcher/lib function into the test shell (mirrors
# frame-bottom-anchor-geometry.bats). Used for draw_bottom_row (lives in ga-tui-workbox.sh, not sourced).
extract_launcher_fn() {
  eval "$(awk -v fn="$1" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
}

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  [[ -f "${LIB}/ga-tui-frame.sh" ]] || skip "frame module not found"
  # the lib modules are strict-mode sourced in production; suspend any inherited ERR trap defensively.
  trap - ERR
  # shellcheck source=/dev/null
  source "${LIB}/ga-tui-primitives.sh"
  # shellcheck source=/dev/null
  source "${LIB}/ga-tui-frame.sh"
  # draw_bottom_row + draw_keyhint stay REAL (they own the no-trailing-newline discipline); the former
  # lives in ga-tui-workbox.sh, so eval it in (draw_keyhint is already sourced from ga-tui-frame.sh).
  extract_launcher_fn draw_bottom_row

  # production gate + single-asset ART constants at C=5 (mirror the launcher readonly block).
  PLATE_MARGIN=2
  MAX_READABLE=64
  MIN_COLS=50
  MENU_COUNT=5
  MIN_ROWS=$((5 + 1 + (2 + MENU_COUNT) + 1 + 4 + 3))
  ART_ROWS=18
  ART_WIDTH=55
  ART_MIN_ROWS=$((12 + MENU_COUNT + ART_ROWS))
  USE_UTF8=true
  USE_COLOR=true
  COLUMNS=80
  GEOMETRY_DIRTY=true
  PLATE_LEFT="${PLATE_MARGIN}"
  MENU_INNER_OVERRIDE=""
  WORK_STATE=nav
  C_ACCENT=96
  C_DIM=90
  C_STRONG=97
  C_INFO=94
  C_FRAME=37
  G_ARROW_U="^"
  G_ARROW_D="v"
  G_ENTER="<"

  CUP_ROWS="${BATS_TEST_TMPDIR}/cup-rows"
  : >"${CUP_ROWS}"

  # cup_to instrumented: record the addressed row, then emit the real ESC to the TTY.
  cup_to() {
    printf '%s\n' "$1" >>"${CUP_ROWS}"
    printf '\033[%s;%sH' "$1" "$2" >"${TTY}"
  }
  # leaf-renderer stubs: each re-emits its PRODUCTION cup anchor from the REAL geometry globals
  # (draw_bottom_row/draw_keyhint stay real; the compose orchestration stays real).
  draw_bulldog_art() {
    [[ "${FULLSCREEN}" == "true" && "${ART_OK}" == "true" && "${USE_UTF8}" == "true" ]] || return 0
    cup_to "${ART_FIRST_ROW}" 1
  }
  draw_wordmark() { :; } # wrapper cups WORDMARK_FIRST_ROW (from _compose)
  # draw_separator emits NOTHING in fullscreen now (blank spacer) — mirror production: no cup.
  draw_separator() { [[ "${FULLSCREEN}" == "true" ]] && return 0; cup_to "${SEPARATOR_ROW}" 1; }
  draw_menu() { :; } # wrapper cups MENU_BLOCK_FIRST_ROW (from _compose)
  draw_workbox() { [[ "${FULLSCREEN}" == "true" ]] && cup_to "${WORKBOX_FIRST_ROW}" 1; }
}

# _compose_at cols rows — populate the REAL geometry hermetically, then drive _compose_frame_regions,
# recording addressed rows into CUP_ROWS and the full byte stream (hex) into COMPOSE_HEX.
_compose_at() {
  GEO_COLS="$1"
  GEO_ROWS="$2"
  COLUMNS="$1"
  term_size() { printf '%s %s' "${GEO_COLS}" "${GEO_ROWS}"; }
  tput() { return 0; }
  GEOMETRY_DIRTY=true
  compute_menu_geometry
  GEOMETRY_DIRTY=false
  apply_plate_geometry
  : >"${CUP_ROWS}"
  # capture ALL emitted bytes via a pipe (accumulates; no per-write truncation, no trailing-newline
  # strip) so the last byte is observable. cup_to's CUP_ROWS append persists (file side effect).
  COMPOSE_HEX="$(TTY=/dev/stdout _compose_frame_regions | od -An -v -tx1 | tr -d ' \n')"
}

# _cup_max / _cup_min — highest / lowest recorded CUP row.
_cup_max() {
  local r max=0
  while IFS= read -r r; do
    [[ "${r}" =~ ^[0-9]+$ ]] || continue
    [[ "${r}" -gt "${max}" ]] && max="${r}"
  done <"${CUP_ROWS}"
  printf '%s' "${max}"
}
_cup_min() {
  local r min=999999
  while IFS= read -r r; do
    [[ "${r}" =~ ^[0-9]+$ ]] || continue
    [[ "${r}" -lt "${min}" ]] && min="${r}"
  done <"${CUP_ROWS}"
  printf '%s' "${min}"
}

# --- art tier (R=40/cols=80): bounded by the centered block, no trailing newline ------------------

@test "compose R=40: addresses no row beyond MENU_KEYHINT_ROW (37), which is above the terminal bottom" {
  _compose_at 80 40
  [ "${ART_OK}" = "true" ]
  # keyhint is the block's LAST row (37), ABOVE the terminal's last row (40): rows 38..40 are the
  # bottom centering pad and are never addressed.
  [ "${MENU_KEYHINT_ROW}" -eq 37 ]
  [ "${MENU_KEYHINT_ROW}" -lt 40 ]
  local max
  max="$(_cup_max)"
  # every cup_to lands within [.., MENU_KEYHINT_ROW]; the keyhint row itself IS the extreme.
  [ "${max}" -le "${MENU_KEYHINT_ROW}" ]
  [ "${max}" -eq "${MENU_KEYHINT_ROW}" ]
  # nothing addressed BELOW the keyhint (max strictly less than the terminal's last row).
  [ "${max}" -lt 40 ]
}

@test "compose R=40: addresses nothing above the block top (min cup == ART_FIRST_ROW == 4)" {
  _compose_at 80 40
  [ "${ART_OK}" = "true" ]
  [ "${ART_FIRST_ROW}" -eq 4 ]
  [ "${MENU_FIRST_ROW}" -eq "${ART_FIRST_ROW}" ]
  local min
  min="$(_cup_min)"
  # the topmost DRAWN region is the art; nothing addressed above it (rows 1..3 are the top pad).
  [ "${min}" -eq "${ART_FIRST_ROW}" ]
  [ "${min}" -gt 1 ]
}

@test "compose R=40: emits no trailing newline after the keyhint row (last byte != 0x0a)" {
  _compose_at 80 40
  # non-empty output captured, and it does NOT end in a line feed (0a) — a trailing '\n' would scroll.
  [ -n "${COMPOSE_HEX}" ]
  [[ "${COMPOSE_HEX}" != *0a ]]
}

# --- no-art band (R=30/cols=80): art gated off, nothing addressed above the wordmark ---------------

@test "compose R=30 (no-art band): ART_OK=false, addresses nothing above WORDMARK_FIRST_ROW" {
  _compose_at 80 30
  [ "${ART_OK}" = "false" ]
  [ "${ART_FIRST_ROW}" -eq 0 ]
  [ "${WORDMARK_OK}" = "true" ]
  local min
  min="$(_cup_min)"
  # the bulldog is dropped, so the topmost DRAWN region is the wordmark: no cup_to reaches a row
  # ABOVE (numerically below) WORDMARK_FIRST_ROW. The centered no-art block seats the wordmark at 8.
  [ "${min}" -ge "${WORDMARK_FIRST_ROW}" ]
  [ "${min}" -eq "${WORDMARK_FIRST_ROW}" ]
  [ "${WORDMARK_FIRST_ROW}" -eq 8 ]
}

@test "compose R=30 (no-art band): still bounded by the centered keyhint, no trailing newline" {
  _compose_at 80 30
  local max
  max="$(_cup_max)"
  [ "${max}" -eq "${MENU_KEYHINT_ROW}" ]
  # keyhint (22) is above the terminal's last row (30): rows 23..30 are the bottom centering pad.
  [ "${MENU_KEYHINT_ROW}" -eq 22 ]
  [ "${max}" -lt 30 ]
  [ -n "${COMPOSE_HEX}" ]
  [[ "${COMPOSE_HEX}" != *0a ]]
}

# --- separator suppression: fullscreen draw_separator emits NO dot glyphs (blank spacer) -----------

@test "fullscreen draw_separator emits NO dot-rule glyphs (blank spacer); compact still emits the dot-rule" {
  local sep_probe="${BATS_TEST_TMPDIR}/sep-probe.sh"
  cat >"${sep_probe}" <<'SEP_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
SEP_LIB="${SEP_LIB:?}"
PLATE_MARGIN=2
PLATE_LEFT=8
MENU_INNER_OVERRIDE=40
USE_UTF8=true
USE_COLOR=false
COLUMNS=80
C_DIM=""
FULLSCREEN="${SEP_FULLSCREEN:?}"
SEPARATOR_ROW=6
# shellcheck source=/dev/null
source "${SEP_LIB}/ga-tui-primitives.sh"
# shellcheck source=/dev/null
source "${SEP_LIB}/ga-tui-caps.sh"
# shellcheck source=/dev/null
source "${SEP_LIB}/ga-tui-frame.sh"
resolve_glyphs
# strip any CUP/SGR control sequences so only the visible rule glyphs remain.
TTY=/dev/stdout draw_separator | sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g"
SEP_EOF
  # fullscreen: draw_separator returns early — ZERO output (the ex-separator row is a blank spacer).
  run env SEP_LIB="${GA}/lib" SEP_FULLSCREEN=true bash "${sep_probe}"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
  # compact: the dim dot-rule IS emitted (UTF-8 G_DOT '·' repeated across the plate inner) — unchanged.
  run env SEP_LIB="${GA}/lib" SEP_FULLSCREEN=false bash "${sep_probe}"
  [ "${status}" -eq 0 ]
  [ -n "${output}" ]
  [[ "${output}" == *"·"* ]]
}
