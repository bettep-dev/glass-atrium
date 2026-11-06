#!/usr/bin/env bats
# art-nav-static-invariant.bats — CUP-addressing invariants of the differential-vs-full redraw split at the
# R=40/cols=80 art tier: an arrow move never repaints the static art band, while the full in-place redraw
# pre-clears the whole centered block and is idempotent. Real compose/redraw orchestration with cup_to
# instrumented; only leaf renderers are stubbed, each re-emitting its production anchor from the geometry globals.
# shellcheck disable=SC2034,SC2154,SC2329 # globals read/assigned by the sourced lib · stubs invoked by it

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LIB="${GA}/lib"

setup() {
  trap - ERR
  # shellcheck source=/dev/null
  source "${LIB}/ga-tui-primitives.sh"
  # shellcheck source=/dev/null
  source "${LIB}/ga-tui-frame.sh"

  # production gate + single-asset ART constants at C=5 (mirror the launcher readonly block)
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

  CUP_ROWS="${BATS_TEST_TMPDIR}/cup-rows"
  : >"${CUP_ROWS}"
  cup_to() {
    printf '%s\n' "$1" >>"${CUP_ROWS}"
    printf '\033[%s;%sH' "$1" "$2" >"${TTY}"
  }
  draw_bulldog_art() {
    [[ "${FULLSCREEN}" == "true" && "${ART_OK}" == "true" && "${USE_UTF8}" == "true" ]] || return 0
    cup_to "${ART_FIRST_ROW}" 1
  }
  draw_wordmark() { :; } # wrapper cups WORDMARK_FIRST_ROW
  draw_separator() {
    [[ "${FULLSCREEN}" == "true" ]] && return 0
    cup_to "${SEPARATOR_ROW}" 1
  }
  draw_menu() { :; } # wrapper cups MENU_BLOCK_FIRST_ROW
  draw_workbox() { [[ "${FULLSCREEN}" == "true" ]] && cup_to "${WORKBOX_FIRST_ROW}" 1; }
  draw_bottom_row() { [[ "${FULLSCREEN}" == "true" ]] && cup_to "${MENU_KEYHINT_ROW}" "$((MENU_LEFT + 1))"; }
  paint_workbox_body_inner() { cup_to "${WORKBOX_BODY_ROW}" "$((MENU_LEFT + 2))"; }
  workbox_body_str() { printf 'body'; }
  menu_row_str() { printf 'row%s' "$1"; }
  plate_row() { :; }
  term_size() { printf '80 40'; }
  tput() { return 0; }

  compute_menu_geometry
  GEOMETRY_DIRTY=false
  apply_plate_geometry
  ART_LO="${ART_FIRST_ROW}"
  ART_HI=$((ART_FIRST_ROW + ART_ROWS - 1))

  # the art tier every invariant exercises actually engaged
  [[ "${FULLSCREEN}" == "true" ]] || {
    echo "FULLSCREEN=${FULLSCREEN}, expected true"
    return 1
  }
  [[ "${ART_OK}" == "true" ]] || {
    echo "ART_OK=${ART_OK}, expected true"
    return 1
  }
  [[ "${ART_FIRST_ROW}" -eq 4 ]] || {
    echo "ART_FIRST_ROW=${ART_FIRST_ROW}, expected 4"
    return 1
  }
  [[ "${MENU_KEYHINT_ROW}" -eq 37 ]] || {
    echo "MENU_KEYHINT_ROW=${MENU_KEYHINT_ROW}, expected 37"
    return 1
  }
}

# _rows_in_band lo hi — count of recorded CUP rows r with lo <= r <= hi
_rows_in_band() {
  local lo="$1" hi="$2" r n=0
  while IFS= read -r r; do
    [[ "${r}" =~ ^[0-9]+$ ]] || continue
    if [[ "${r}" -ge "${lo}" && "${r}" -le "${hi}" ]]; then n=$((n + 1)); fi
  done <"${CUP_ROWS}"
  printf '%s' "${n}"
}

_row_recorded() { grep -qx "$1" "${CUP_ROWS}"; }

@test "an arrow move never repaints an art row, only the two changed menu rows and the workbox body" {
  TTY=/dev/null redraw_nav_move 0 1
  local nav_art
  nav_art="$(_rows_in_band "${ART_LO}" "${ART_HI}")"
  [[ "${nav_art}" -eq 0 ]] || {
    echo "addressed ${nav_art} rows in art band [${ART_LO},${ART_HI}]; recorded rows:"
    cat -- "${CUP_ROWS}"
    return 1
  }
  # MENU_BLOCK_FIRST_ROW=26 → items 0,1 sit at rows 27,28
  _row_recorded 27 && _row_recorded 28 && _row_recorded "${WORKBOX_BODY_ROW}" \
    || {
      echo "missed menu rows 27,28 or workbox body ${WORKBOX_BODY_ROW}; recorded rows:"
      cat -- "${CUP_ROWS}"
      return 1
    }
}

@test "the full in-place redraw covers every block row from the art top to the keyhint" {
  TTY=/dev/null redraw_frame_inplace
  local inplace_art missing="" r="${ART_FIRST_ROW}"
  inplace_art="$(_rows_in_band "${ART_LO}" "${ART_HI}")"
  [[ "${inplace_art}" -gt 0 ]] || {
    echo "no row addressed in art band [${ART_LO},${ART_HI}]"
    return 1
  }
  while [[ "${r}" -le "${MENU_KEYHINT_ROW}" ]]; do
    _row_recorded "${r}" || missing="${missing} ${r}"
    r=$((r + 1))
  done
  [[ -z "${missing}" ]] || {
    echo "unaddressed rows in [${ART_FIRST_ROW}..${MENU_KEYHINT_ROW}]:${missing}"
    return 1
  }
}

@test "a repeated full in-place redraw is byte-identical" {
  local out1 out2
  out1="$(TTY=/dev/stdout redraw_frame_inplace)"
  out2="$(TTY=/dev/stdout redraw_frame_inplace)"
  [[ "${out1}" == "${out2}" ]] || {
    echo "pass outputs differ: ${#out1} vs ${#out2} bytes"
    return 1
  }
}
