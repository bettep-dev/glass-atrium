# shellcheck shell=bash
# shellcheck disable=SC2154,SC2312  # SC2154: reads shared loader globals (GA_ROOT/PLATE_*/ART_*/FULLSCREEN/USE_UTF8/C_*) present at runtime; SC2312: c()/plate_inner run inside command subs (always succeed via printf → masked return no signal), mirrors loader-wide disable
# Glass Atrium launcher — bulldog art render module. SOURCED (never executed):
# shebang/strict-mode/IFS/traps stay loader-owned so re-sourcing never re-arms. Emits the
# top-of-screen brand mascot as a WHOLESALE-loaded braille asset: the TUI renders NO braille
# at runtime — it loads the offline-generated `docs/assets/bulldog-braille.txt` verbatim and
# prints each row. Function-definition-only (the loaded-rows array + load flag are loader
# stub-band state, set -u safe across re-source), so a double-source is a no-op reload guard.

# _bulldog_load_asset — read the shipped braille asset into BULLDOG_ROWS once (lazy, on the
# first draw). WHOLESALE contract: the rows are emitted verbatim — never generated, sliced, or
# transformed at runtime. bash-3.2-safe whole-file read (no mapfile): `while IFS= read -r` into
# an index-counted array. Idempotent — BULLDOG_LOADED guards re-entry so repeated draws never
# re-stat the file (perf). FAIL-SAFE: a missing/unreadable asset leaves BULLDOG_ROW_COUNT=0 and
# returns 0 (the caller then renders nothing) — never errors/exits under the loader's set -Eeuo
# pipefail, matching the graceful-degradation philosophy (a dropped bulldog, not a crash).
_bulldog_load_asset() {
  [[ "${BULLDOG_LOADED}" == "true" ]] && return 0
  BULLDOG_LOADED=true
  BULLDOG_ROWS=()
  BULLDOG_ROW_COUNT=0
  # GA_ROOT-anchored (the symlink farm points back at the real release tree), mirroring every
  # sibling module's bundled-resource resolution.
  local asset="${GA_ROOT}/docs/assets/bulldog-braille.txt"
  [[ -r "${asset}" ]] || return 0
  local line
  # `|| [[ -n "${line}" ]]` captures a final line lacking a trailing newline; read's EOF
  # non-zero in the while condition is exempt from set -e. Append (not indexed assignment) so
  # the subscript stays arithmetic-clean; the count then derives from the array length.
  while IFS= read -r line || [[ -n "${line}" ]]; do
    BULLDOG_ROWS+=("${line}")
  done <"${asset}"
  BULLDOG_ROW_COUNT="${#BULLDOG_ROWS[@]}"
  return 0
}

# _bulldog_color_for_row — map a 1-based asset row index to its whole-row color band, scaled to
# the 21-row asset (print-time c() wrapping only — NEVER per-dot/per-cell drawing). Four bands,
# top→bottom: crown/ears (recede) → C_INFO; brow/eyes (the ferocity band) → C_STRONG; mid-face/
# nose → C_ACCENT; jaw/chin (recede) → C_DIM. A simple index→color chain (bash-3.2; no assoc
# arrays). Mono tier leaves every C_* empty, so the emitted value is "" and c() is a no-op.
_bulldog_color_for_row() {
  local row_idx="$1"
  if [[ "${row_idx}" -le 4 ]]; then
    printf '%s' "${C_INFO}"
  elif [[ "${row_idx}" -le 9 ]]; then
    printf '%s' "${C_STRONG}"
  elif [[ "${row_idx}" -le 15 ]]; then
    printf '%s' "${C_ACCENT}"
  else
    printf '%s' "${C_DIM}"
  fi
}

# draw_bulldog_art — paint the bulldog art region at its absolute top anchor, OR emit NOTHING.
# Gate (top-down degradation step 1): draws ONLY in the fullscreen art tier with braille glyphs
# (FULLSCREEN AND ART_OK AND USE_UTF8) — any gate off returns with zero output (no cursor move,
# no blank rows), so the compose/redraw layers keep full ownership of the layout. When active:
# cup_to ART_FIRST_ROW, then emit each loaded row at a center-align pad (PLATE_LEFT + (inner -
# ART_WIDTH)/2 — mirrors draw_wordmark's centering, reusing the shared plate_inner/PLATE_LEFT),
# each row whole-row-wrapped via c() with its band color. FAIL-SAFE: no rows loaded (absent
# asset) → art-dropped, silent, exit 0.
draw_bulldog_art() {
  [[ "${FULLSCREEN}" == "true" && "${ART_OK}" == "true" && "${USE_UTF8}" == "true" ]] || return 0

  _bulldog_load_asset
  [[ "${BULLDOG_ROW_COUNT}" -gt 0 ]] || return 0

  local inner pad_n pad
  inner="$(plate_inner)"
  # Center the ART_WIDTH-cell art inside the plate inner (mirror of draw_wordmark:121). Clamp to
  # PLATE_LEFT so a sub-art-width plate stays flush — defensive; ART_OK already guarantees
  # inner >= ART_WIDTH via the horizontal-fit gate.
  pad_n=$((PLATE_LEFT + (inner - ART_WIDTH) / 2))
  [[ "${pad_n}" -lt "${PLATE_LEFT}" ]] && pad_n="${PLATE_LEFT}"
  pad="$(printf '%*s' "${pad_n}" "")"

  # Absolute anchor once, then stack the rows via natural newlines (mirrors draw_wordmark). The
  # art is a TOP region — its last row lands well above the bottom-pinned keyhint, so a trailing
  # newline never scrolls the alt-screen.
  cup_to "${ART_FIRST_ROW}" 1
  local i=0 row color
  while [[ "${i}" -lt "${BULLDOG_ROW_COUNT}" ]]; do
    row="${BULLDOG_ROWS[${i}]}"
    color="$(_bulldog_color_for_row "$((i + 1))")"
    tty_line "${pad}$(c "${color}" "${row}")"
    i=$((i + 1))
  done
}
