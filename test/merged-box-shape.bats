#!/usr/bin/env bats
# merged-box-shape.bats — rendered-glyph pins for the MERGED menu+work box (the one-box redesign).
# The menu section and the work section are now ONE framed box split by an INTERNAL 'work' divider
# rail: the box has exactly ONE top rail (' menu ' tab, top corners ╭ ╮), the menu items, ONE internal
# divider (' work ' tab, SIDE-RAIL JUNCTIONS ├ ┤ — NOT corners), the two work-body rows, and ONE
# shared bottom rail (bottom corners ╰ ╯). There is NO menu bottom rail; a single blank interior row
# (side rails present, no glyph content — the USER-DIRECTED breathing room) pads the last menu item off
# the divider. This file pins that SHAPE end-to-end by rendering the REAL
# draw_menu (frame module) + draw_workbox (workbox module) through the REAL plate primitives + the
# REAL glyph SoT (resolve_glyphs), only the leaf CONTENT builders (menu_row_str / workbox_body_str)
# stubbed. Two tiers: UTF-8 (╭╮ ├┤ ╰╯) is the primary pin; ASCII (+ corners, | junction, |-- work) is
# the fallback pin. The render runs under a strict-mode (set -Eeuo pipefail) probe so it ALSO proves
# the merged draw path never trips errexit. CUP sequences are stripped so line boundaries are clean.
#
# Run via: bats test/merged-box-shape.bats
# Requires: bats (brew install bats-core), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  [[ -f "${GA}/glass-atrium" ]] || skip "launcher not found"
  [[ -f "${GA}/lib/ga-tui-frame.sh" ]] || skip "frame module not found"
  [[ -f "${GA}/lib/ga-tui-workbox.sh" ]] || skip "workbox module not found"
  # the lib modules are sourced under a strict-mode probe; suspend any inherited ERR trap defensively.
  trap - ERR
  # env-driven strict-mode render probe: draws the merged box (draw_menu upper + draw_workbox lower)
  # at a fixed fullscreen tier (PLATE_LEFT=8, inner=40, C=5), USE_UTF8 overridable so ASCII reuses it.
  PROBE="${BATS_TEST_TMPDIR}/merged-probe.sh"
  cat >"${PROBE}" <<'PROBE_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
GA_ROOT="${PROBE_GA_ROOT:?}"
LIB="${PROBE_LIB:?}"
FULLSCREEN=true
USE_UTF8="${PROBE_USE_UTF8:-true}"
USE_COLOR=false
COLUMNS=80
PLATE_MARGIN=2
PLATE_LEFT=8
MENU_INNER_OVERRIDE=40
MENU_COUNT=5
WORK_STATE=nav
# color globals empty (mono — SGR discounted so glyphs read cleanly)
C_FRAME=""
C_ACCENT=""
C_DANGER=""
C_STRONG=""
C_DIM=""
C_OK=""
C_ALERT=""
C_INFO=""
SELECTED=0
MENU_DIMMED=false
# work-section anchor (the divider self-cups here; the absolute row is arbitrary for a shape render)
WORKBOX_FIRST_ROW=7
WORKBOX_BODY_ROW=8
WORKBOX_BODY_ROW2=9
# shellcheck source=/dev/null
source "${LIB}/ga-tui-primitives.sh"
# shellcheck source=/dev/null
source "${LIB}/ga-tui-caps.sh"
# shellcheck source=/dev/null
source "${LIB}/ga-tui-frame.sh"
# shellcheck source=/dev/null
source "${LIB}/ga-tui-workbox.sh"
resolve_glyphs
# stub the leaf CONTENT builders — the SHAPE (rails/divider/corners), not the content, is under test.
menu_row_str() { printf 'item %s' "$1"; }
workbox_body_str() { printf ' body headline'; } # no "work" substring (the ' work ' tab must be unique)
workbox_body_row2_str() { printf ''; }
# render the merged box (menu upper section + workbox lower section) to stdout, CUP sequences stripped.
TTY=/dev/stdout
{ draw_menu; draw_workbox; } | sed "s/$(printf '\033')\[[0-9;]*H//g"
PROBE_EOF
}

# --- UTF-8 tier: ╭ menu ╮ top rail | ├ work ┤ divider | ╰ ╯ bottom rail, no gap, 5 items -----------

@test "UTF-8 merged box: ONE ' menu ' top rail, ONE ' work ' divider (├ ┤ junctions), ONE bottom rail, ONE blank pad row" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" bash "${PROBE}"
  [ "${status}" -eq 0 ]

  local i=0 line
  local menu_top=0 work_div=0 bottom=0
  local top_idx=-1 work_idx=-1 bottom_idx=-1
  for line in "${lines[@]}"; do
    if [[ "${line}" == *" menu "* ]]; then
      menu_top=$((menu_top + 1))
      top_idx="${i}"
    fi
    if [[ "${line}" == *" work "* ]]; then
      work_div=$((work_div + 1))
      work_idx="${i}"
    fi
    # bottom rail = a rail carrying BOTH bottom corners (╰ ╯) and no tab label.
    if [[ "${line}" == *"╰"* && "${line}" == *"╯"* ]]; then
      bottom=$((bottom + 1))
      bottom_idx="${i}"
    fi
    i=$((i + 1))
  done

  # exactly ONE of each rail in the whole merged box.
  [ "${menu_top}" -eq 1 ]
  [ "${work_div}" -eq 1 ]
  [ "${bottom}" -eq 1 ]

  # the ' menu ' top rail uses TOP corners.
  [[ "${lines[${top_idx}]}" == *"╭"* && "${lines[${top_idx}]}" == *"╮"* ]]

  # the ' work ' divider uses SIDE-RAIL JUNCTIONS (├ ┤), NOT corner glyphs — this is the merged-box
  # invariant: the left/right rails run THROUGH the divider, so it is one box, not two stacked boxes.
  [[ "${lines[${work_idx}]}" == *"├"* && "${lines[${work_idx}]}" == *"┤"* ]]
  [[ "${lines[${work_idx}]}" != *"╭"* && "${lines[${work_idx}]}" != *"╮"* ]]
  [[ "${lines[${work_idx}]}" != *"╰"* && "${lines[${work_idx}]}" != *"╯"* ]]

  # ordering: top rail < divider < bottom rail (the box builds top→bottom).
  [ "${top_idx}" -lt "${work_idx}" ]
  [ "${work_idx}" -lt "${bottom_idx}" ]

  # NO menu bottom rail. Between the top rail and the divider sit MENU_COUNT (5) item rows PLUS ONE
  # blank pad row (the USER-DIRECTED breathing room between the last menu item and the divider) = 6
  # CONTIGUOUS framed rows (│ … │), none a corner/junction rail. The blank pad carries side rails but
  # NO glyph content; it MUST be the LAST row before the divider.
  [ "$((work_idx - top_idx - 1))" -eq 6 ]
  local j="$((top_idx + 1))" item_rows=0 blank_rows=0
  while [[ "${j}" -lt "${work_idx}" ]]; do
    [[ "${lines[${j}]}" == *"│"* ]]                          # framed content row (both side rails)
    [[ "${lines[${j}]}" != *"╭"* && "${lines[${j}]}" != *"╮"* ]] # not a top rail
    [[ "${lines[${j}]}" != *"╰"* && "${lines[${j}]}" != *"╯"* ]] # not a bottom rail (no menu bottom rail)
    [[ "${lines[${j}]}" != *"├"* && "${lines[${j}]}" != *"┤"* ]] # not a divider
    if [[ "${lines[${j}]}" == *"item"* ]]; then
      item_rows=$((item_rows + 1)) # an item row carries the stubbed 'item N' content
    else
      # blank pad: strip the side rails, the remainder MUST be all spaces (no glyph content).
      local stripped="${lines[${j}]//│/}"
      [[ -z "${stripped// /}" ]]
      blank_rows=$((blank_rows + 1))
    fi
    j=$((j + 1))
  done
  # exactly 5 item rows + exactly 1 blank interior row.
  [ "${item_rows}" -eq 5 ]
  [ "${blank_rows}" -eq 1 ]
  # the blank pad is the LAST row before the divider (side rails only, no glyph content).
  local last_before_div="${lines[$((work_idx - 1))]//│/}"
  [[ -z "${last_before_div// /}" ]]
}

# --- ASCII tier: '+ menu +' top rail, '|-- work' divider (| junction, NOT + corner) ----------------

@test "ASCII merged box: ' work ' divider uses '|' junctions (not '+' corners), one ' menu ' top rail" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" PROBE_USE_UTF8=false bash "${PROBE}"
  [ "${status}" -eq 0 ]

  local i=0 line
  local menu_top=0 work_div=0 plus_lines=0
  local top_idx=-1 work_idx=-1
  for line in "${lines[@]}"; do
    if [[ "${line}" == *" menu "* ]]; then
      menu_top=$((menu_top + 1))
      top_idx="${i}"
    fi
    if [[ "${line}" == *" work "* ]]; then
      work_div=$((work_div + 1))
      work_idx="${i}"
    fi
    # '+'-bearing rails in ASCII = the top rail + the bottom rail ONLY (the divider uses '|').
    [[ "${line}" == *"+"* ]] && plus_lines=$((plus_lines + 1))
    i=$((i + 1))
  done

  [ "${menu_top}" -eq 1 ]
  [ "${work_div}" -eq 1 ]
  # exactly TWO '+' rails (top + bottom) — the divider is NOT one of them.
  [ "${plus_lines}" -eq 2 ]
  # the ' work ' divider uses '|' side-rail junctions, NOT '+' corners (the '|-- work ---|' sketch).
  [[ "${lines[${work_idx}]}" == *"|"* ]]
  [[ "${lines[${work_idx}]}" != *"+"* ]]
  # the ' menu ' top rail DOES carry the '+' corners.
  [[ "${lines[${top_idx}]}" == *"+"* ]]
  # between the top rail and the divider: 5 item rows + ONE blank pad row = 6 rows (no menu bottom rail).
  [ "$((work_idx - top_idx - 1))" -eq 6 ]
  # the blank pad is the LAST row before the divider: side rails '|' only, no glyph content.
  local ascii_last="${lines[$((work_idx - 1))]//|/}"
  [[ -z "${ascii_last// /}" ]]
}
