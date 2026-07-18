#!/usr/bin/env bats
# frame-short-terminal-degradation.bats — end-to-end region-presence pins for the top-down
# degradation ladder (T7). This is the INTEGRATION complement to the pure-math golden pins in
# frame-bottom-anchor-geometry.bats: it drives the REAL top-level composer draw_frame_full (which
# branches fullscreen-vs-compact) at each boundary size and asserts WHICH REGIONS actually render
# (art / wordmark / menu / workbox / keyhint) per tier. The single 55x18 asset ships (the 3-band
# system is retired) and the menu+work area are ONE merged box, so the ladder is:
#
#   R>=35 AND plate>=55 AND USE_UTF8  -> ART + wordmark + menu + workbox + keyhint  (art tier)
#   21<=R<=34  OR  plate<55  OR  !USE_UTF8 -> NO art; wordmark + menu + workbox + keyhint (fullscreen no-art)
#   R<21 (or cols<MIN_COLS)                -> compact top-left: wordmark + separator + menu (no art, no workbox)
#
# The dim dot-rule SEPARATOR is now COMPACT-ONLY: in fullscreen draw_separator emits nothing (the
# ex-separator row is a blank spacer held by the centered-block clear), so SEP renders ONLY in the
# compact tier. The KEY invariant pinned here: the bulldog is the FIRST region dropped; the menu +
# workbox never lose a row at ANY fullscreen size (R=21/24/34/38). Boundary matrix: R=20/21/24/34/38,
# plus the horizontal-fit boundary cols=60/61 at R=38, plus the !USE_UTF8 glyph-gate drop at R=38.
#
# Scaffolding mirrors art-scrollback-safety.bats: the REAL orchestration (compute_menu_geometry,
# ensure_geometry, apply_plate_geometry, _compose_frame_regions, draw_frame_full) runs; the six leaf
# renderers are stubbed to record their region NAME into a log WHEN they emit, each stub replicating
# its PRODUCTION gate verbatim (low-drift). No asset file, no menu/workbox content state needed — the
# test exercises the degradation WIRING, not the region contents.
#
# Run via: bats test/frame-short-terminal-degradation.bats
# Requires: bats (brew install bats-core), awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"
LIB="${GA}/lib"
REGION_LOG=""

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  [[ -f "${LIB}/ga-tui-frame.sh" ]] || skip "frame module not found"
  # the lib modules are strict-mode sourced in production; suspend any inherited ERR trap defensively.
  trap - ERR
  # shellcheck source=/dev/null
  source "${LIB}/ga-tui-primitives.sh"
  # shellcheck source=/dev/null
  source "${LIB}/ga-tui-frame.sh"

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
  GEOMETRY_DIRTY=true
  PLATE_LEFT="${PLATE_MARGIN}"
  MENU_INNER_OVERRIDE=""
  # TTY sink for the frame-level writes (tp clear / compact home-clear / cup_to); the region log is
  # a SEPARATE file the stubs append to, so nothing depends on TTY content.
  TTY="/dev/null"

  REGION_LOG="${BATS_TEST_TMPDIR}/regions"
  : >"${REGION_LOG}"

  # tp — the fullscreen alt-screen clear (`tp clear` = ESC[2J ESC[H); no-op in the test.
  tp() { :; }

  # Leaf-renderer stubs: each records its region NAME iff it EMITS, replicating its PRODUCTION gate
  # so the recorded set is exactly the set of regions the real composer would paint.
  #   * draw_bulldog_art  — FULLSCREEN AND ART_OK AND USE_UTF8 (ga-tui-bulldog.sh)
  #   * draw_wordmark — no self-gate; _compose calls it inside `if WORDMARK_OK` + compact inline
  #   * draw_separator — FULLSCREEN self-gate: emits NOTHING in fullscreen (blank ex-separator spacer),
  #     the dim dot-rule ONLY in the compact path — so it records SEP only when FULLSCREEN=false
  #   * draw_menu — always renders (the menu never drops)
  #   * draw_workbox/draw_bottom_row — FULLSCREEN self-guard (ga-tui-workbox.sh)
  draw_bulldog_art() {
    [[ "${FULLSCREEN}" == "true" && "${ART_OK}" == "true" && "${USE_UTF8}" == "true" ]] || return 0
    printf 'ART\n' >>"${REGION_LOG}"
  }
  draw_wordmark() { printf 'WORDMARK\n' >>"${REGION_LOG}"; }
  draw_separator() { [[ "${FULLSCREEN}" == "true" ]] && return 0; printf 'SEP\n' >>"${REGION_LOG}"; }
  draw_menu() { printf 'MENU\n' >>"${REGION_LOG}"; }
  draw_workbox() { [[ "${FULLSCREEN}" == "true" ]] || return 0; printf 'WORKBOX\n' >>"${REGION_LOG}"; }
  draw_bottom_row() { [[ "${FULLSCREEN}" == "true" ]] || return 0; printf 'KEYHINT\n' >>"${REGION_LOG}"; }
}

# _frame_at cols rows — drive the REAL draw_frame_full hermetically at a fixed TTY size. draw_frame_full
# forces GEOMETRY_DIRTY=true itself, so ensure_geometry recomputes; term_size echoes the size, tput
# succeeds so the cursor-addressing probe passes.
_frame_at() {
  GEO_COLS="$1"
  GEO_ROWS="$2"
  term_size() { printf '%s %s' "${GEO_COLS}" "${GEO_ROWS}"; }
  tput() { return 0; }
  : >"${REGION_LOG}"
  draw_frame_full
}

# _has_region NAME — 0 if the region emitted during the last _frame_at, else 1.
_has_region() { grep -qx "$1" "${REGION_LOG}"; }

# --- art tier: R=38 floor, wide plate, UTF8 -> every region incl. the bulldog ----------------------

@test "R=38 cols=80 (art tier): ART + wordmark + menu + workbox + keyhint render; SEP is a blank spacer" {
  _frame_at 80 38
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "true" ]
  _has_region ART
  _has_region WORDMARK
  # the ex-separator row is a BLANK spacer in fullscreen — draw_separator emits nothing, so SEP does
  # NOT render (the row still exists geometrically, held blank by the block clear).
  ! _has_region SEP
  _has_region MENU
  _has_region WORKBOX
  _has_region KEYHINT
}

# --- no-art fullscreen band: R=36/24/21 -> bulldog dropped, everything else survives ---------------

@test "R=34 cols=80 (art floor minus one): NO art; wordmark + menu + workbox + keyhint render" {
  _frame_at 80 34
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  ! _has_region ART
  _has_region WORDMARK
  _has_region MENU
  _has_region WORKBOX
  _has_region KEYHINT
}

@test "R=24 cols=80 (no-art band): NO art; menu + workbox never lose a row" {
  _frame_at 80 24
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  ! _has_region ART
  _has_region WORDMARK
  _has_region MENU
  _has_region WORKBOX
}

@test "R=21 cols=80 (fullscreen floor): NO art; menu + workbox never lose a row" {
  _frame_at 80 21
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  [ "${WORDMARK_OK}" = "true" ]
  ! _has_region ART
  _has_region WORDMARK
  _has_region MENU
  _has_region WORKBOX
}

# --- compact tier: R=20 (below the FULLSCREEN gate) -> top-left, no art, no workbox ----------------

@test "R=20 cols=80 (below FULLSCREEN gate): compact top-left; wordmark + separator + menu render, NO art, NO workbox" {
  _frame_at 80 20
  [ "${FULLSCREEN}" = "false" ]
  [ "${ART_OK}" = "false" ]
  # compact keeps its inline wordmark + dot-rule separator + menu; the bulldog art and the work box
  # are fullscreen-only. The separator (dot-rule) is COMPACT-ONLY and is byte-for-byte unchanged here.
  _has_region WORDMARK
  _has_region SEP
  _has_region MENU
  ! _has_region ART
  ! _has_region WORKBOX
}

# --- horizontal-fit boundary at R=38: cols=61 (plate exactly 55) fits, cols=60 drops the bulldog ---

@test "R=38 cols=61 (plate exactly 55): ART renders (horizontal-fit boundary)" {
  _frame_at 61 38
  # MENU_INNER = (min(61-4,64))-2 = 55 == ART_WIDTH -> the art fits exactly.
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "true" ]
  _has_region ART
  _has_region MENU
  _has_region WORKBOX
}

@test "R=38 cols=60 (plate 54, one short): NO art; wordmark + menu + workbox still render" {
  _frame_at 60 38
  # MENU_INNER = (min(60-4,64))-2 = 54 < ART_WIDTH(55) -> the bulldog drops on width alone.
  [ "${FULLSCREEN}" = "true" ]
  [ "${ART_OK}" = "false" ]
  ! _has_region ART
  _has_region WORDMARK
  _has_region MENU
  _has_region WORKBOX
}

# --- glyph gate: !USE_UTF8 drops the bulldog even in a tall, wide terminal -------------------------

@test "R=38 cols=80 USE_UTF8=false: NO art (glyph gate); wordmark + menu + workbox still render" {
  USE_UTF8=false
  _frame_at 80 38
  [ "${FULLSCREEN}" = "true" ]
  # ART_OK is a pure GEOMETRY gate (true here); the bulldog still drops because draw_bulldog_art
  # additionally gates on USE_UTF8 -> the ASCII / non-UTF8-locale path shows no braille.
  [ "${ART_OK}" = "true" ]
  ! _has_region ART
  _has_region WORDMARK
  _has_region MENU
  _has_region WORKBOX
}

# --- ladder summary: menu + workbox render at EVERY fullscreen size (zero row loss) ----------------

@test "menu + workbox render at every fullscreen size R=21/24/34/38 (zero row loss)" {
  local r
  for r in 21 24 34 38; do
    _frame_at 80 "${r}"
    [ "${FULLSCREEN}" = "true" ] || {
      echo "R=${r} unexpectedly not fullscreen"
      return 1
    }
    _has_region MENU || {
      echo "R=${r} lost the menu"
      return 1
    }
    _has_region WORKBOX || {
      echo "R=${r} lost the workbox"
      return 1
    }
  done
}
