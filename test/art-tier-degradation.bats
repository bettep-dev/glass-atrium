#!/usr/bin/env bats
# art-tier-degradation.bats — behavioral coverage for the bulldog render module (T3). draw_bulldog_art
# emits the WHOLESALE-loaded braille asset ONLY in the fullscreen art tier with braille glyphs
# (FULLSCREEN AND ART_OK AND USE_UTF8); every gate-off path emits NOTHING (top-down degradation —
# the bulldog is the first region dropped). COLORLESS contract (USER-DIRECTED): the whole bulldog
# renders one flat C_STRONG (near-white) — there is NO eye accent, no C_ACCENT anywhere, no pupil
# trim. This file pins the tier ladder end-to-end:
#   (a) USE_UTF8 + colors      -> 18 braille rows; EVERY row whole-row C_STRONG, NO accent, centered pad
#   (b) mono (empty C_*)       -> same 18 rows, ZERO SGR, byte-for-byte verbatim asset
#   (c) USE_UTF8=false         -> NOTHING (ascii / non-UTF8 locale drops the bulldog)
#   (d) ART_OK=false           -> NOTHING (too short / too narrow terminal)
#   (e) missing asset file     -> NOTHING, exit 0 under set -Eeuo pipefail (fail-safe, not a crash)
# plus the whole-row bake unit test, FULLSCREEN=false, and idempotent-load coverage.
#
# The render is driven through a strict-mode (set -Eeuo pipefail) probe script so EVERY path also
# proves the module never trips errexit — the module is SOURCED under a strict-mode loader in
# production. Output is captured via TTY=/dev/stdout (the primitives write `>"${TTY}"`, which
# accumulates on a captured pipe; a plain file would be truncated per-write). The real
# ga-tui-primitives.sh + ga-tui-bulldog.sh are sourced (pure function-def modules) so the real
# cup_to/tty_line/c/plate_inner run — no awk-extraction, which cannot capture the single-line sinks.
#
# Run via: bats test/art-tier-degradation.bats
# Requires: bats (brew install bats-core), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LAUNCHER="${GA}/glass-atrium"
PROBE=""

setup() {
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  [[ -f "${GA}/lib/ga-tui-bulldog.sh" ]] || skip "bulldog module not found"
  [[ -r "${GA}/docs/assets/bulldog-braille.txt" ]] || skip "bulldog asset not found"
  # the lib modules are sourced under strict mode in the probe; suspend any inherited ERR trap
  # in the test shell defensively (mirrors the Wave-1 geometry bats).
  trap - ERR
  # Emit the env-driven strict-mode render probe (per-test tmpdir; regenerated each setup).
  PROBE="${BATS_TEST_TMPDIR}/render-probe.sh"
  cat >"${PROBE}" <<'PROBE_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
# All loader globals the render + primitives read, env-overridable so one probe drives every tier.
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

# --- (a) full tier: USE_UTF8 + colors -> 18 whole-row-white braille rows at the centered pad --------

@test "(a) USE_UTF8 + colors: 18 rows; EVERY row whole-row C_STRONG, no accent anywhere, pad=11" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" bash "${PROBE}"
  [ "${status}" -eq 0 ]
  # 18 emitted rows (asset row count; independently pinned by art-asset-integrity.bats).
  [ "${#lines[@]}" -eq 18 ]
  local esc
  esc="$(_esc)"
  # Colorless palette contract: the whole bulldog renders C_STRONG (97, near-white). The accent color
  # C_ACCENT (96) is GONE — no eye accent — and the retired bands C_INFO (94) / C_DIM (90) stay absent.
  printf '%s' "${output}" | grep -q "${esc}\[97m"
  ! printf '%s' "${output}" | grep -q "${esc}\[96m"
  ! printf '%s' "${output}" | grep -q "${esc}\[94m"
  ! printf '%s' "${output}" | grep -q "${esc}\[90m"
  # EVERY row is a single whole-row C_STRONG wrap with NO accent — no segmentation, no per-row case.
  local i=0
  while [[ "${i}" -lt "${#lines[@]}" ]]; do
    printf '%s' "${lines[${i}]}" | grep -q "${esc}\[97m"
    ! printf '%s' "${lines[${i}]}" | grep -q "${esc}\[96m"
    i=$((i + 1))
  done
  # Row 1 (crown/ears) is wrapped in C_STRONG: the FIRST SGR sequence emitted is ESC[97m (grep -o
  # yields matches left-to-right, so head -1 is the first opening color, not the reset).
  local first_seq first_code
  first_seq="$(printf '%s' "${output}" | grep -o "${esc}\[[0-9;]*m" | head -1)"
  first_code="$(printf '%s' "${first_seq}" | sed "s/${esc}\[\([0-9;]*\)m/\1/")"
  [ "${first_code}" = "97" ]
  # Centered pad: strip leading spaces off row 2 (before its SGR wrap) -> 8 + (62-55)/2 = 11.
  local prefix="${lines[1]%%[! ]*}"
  [ "${#prefix}" -eq 11 ]
}

# --- (b) mono tier: empty C_* / USE_COLOR=false -> same 18 rows, no SGR, verbatim asset -------------

@test "(b) mono (empty C_*): 18 braille rows, zero SGR sequences, same pad, byte-for-byte verbatim" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" \
    PROBE_USE_COLOR=false PROBE_C_INFO= PROBE_C_STRONG= PROBE_C_ACCENT= PROBE_C_DIM= \
    bash "${PROBE}"
  [ "${status}" -eq 0 ]
  [ "${#lines[@]}" -eq 18 ]
  local esc
  esc="$(_esc)"
  # NO SGR color sequence anywhere (the cup_to ESC[..H is not an SGR 'm' sequence).
  ! printf '%s' "${output}" | grep -q "${esc}\[[0-9;]*m"
  # braille still emits: row 2 carries the centered pad, unchanged from the colored tier.
  local prefix="${lines[1]%%[! ]*}"
  [ "${#prefix}" -eq 11 ]
  # every row is byte-for-byte the verbatim asset row (the mono squint-test contract). Row 0 carries
  # the leading absolute CUP (…H), so strip that first; then strip the centering pad (leading ASCII
  # spaces; the braille blank ⠀ = U+2800 is NOT an ASCII space) and compare to the raw asset line.
  local i=0
  while [[ "${i}" -lt "${#lines[@]}" ]]; do
    local ln body raw
    ln="${lines[${i}]}"
    [[ "${i}" -eq 0 ]] && ln="${ln#*H}"
    body="${ln#"${ln%%[! ]*}"}"
    raw="$(sed -n "$((i + 1))p" "${GA}/docs/assets/bulldog-braille.txt")"
    [ "${body}" = "${raw}" ]
    i=$((i + 1))
  done
}

# --- (c) glyph gate off: USE_UTF8=false -> NOTHING ------------------------------------------------

@test "(c) USE_UTF8=false: emits nothing (ascii / non-UTF8 locale drops the bulldog)" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" PROBE_USE_UTF8=false bash "${PROBE}"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
  [ "${#lines[@]}" -eq 0 ]
}

# --- (d) art gate off: ART_OK=false -> NOTHING ---------------------------------------------------

@test "(d) ART_OK=false: emits nothing (too-short or too-narrow terminal)" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" PROBE_ART_OK=false bash "${PROBE}"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

# --- (e) missing asset: NOTHING + exit 0 under set -Eeuo pipefail (fail-safe) --------------------

@test "(e) missing asset file: emits nothing, exits 0 under set -Eeuo pipefail" {
  local empty="${BATS_TEST_TMPDIR}/empty-root"
  mkdir -p "${empty}/docs/assets" # dir exists but the .txt is absent -> unreadable
  run env PROBE_GA_ROOT="${empty}" PROBE_LIB="${GA}/lib" bash "${PROBE}"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

# --- extra degradation coverage: FULLSCREEN=false drops the bulldog ------------------------------

@test "FULLSCREEN=false: emits nothing (compact top-left path never draws art)" {
  run env PROBE_GA_ROOT="${GA}" PROBE_LIB="${GA}/lib" PROBE_FULLSCREEN=false bash "${PROBE}"
  [ "${status}" -eq 0 ]
  [ -z "${output}" ]
}

# --- whole-row bake unit: every row gets a single C_STRONG wrap, NO accent, mono verbatim -----------

@test "_bulldog_bake_row: whole-row C_STRONG wrap on every row, no accent; mono emits verbatim" {
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-tui-primitives.sh"
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-tui-bulldog.sh"
  USE_COLOR=true
  C_STRONG="S"
  C_ACCENT="A"
  local esc
  esc="$(_esc)"
  # 55-char ASCII marker row (locale-independent: 1 byte == 1 char). The bake takes ONE arg (the raw
  # row) — no row-index special case — and wraps the WHOLE row in C_STRONG with NO accent segment.
  local row="LLLLLLLLLLLLLLL11MMMMMMMMMMMMMMMMMMMMMM22RRRRRRRRRRRRRR"
  [ "${#row}" -eq 55 ]
  [ "$(_bulldog_bake_row "${row}")" = "${esc}[Sm${row}${esc}[0m" ]
  ! printf '%s' "$(_bulldog_bake_row "${row}")" | grep -q "${esc}\[Am"
  # A row carrying the solid ⣿⣿ cores is NOT trimmed and NOT accented — the eye machinery is gone, so
  # the whole row (⣿⣿ included) passes through inside the single C_STRONG wrap.
  local core="LLLLLLLLLLLLLLL⣿⣿MMMMMMMMMMMMMMMMMMMMMM⣿⣿RRRRRRRRRRRRRR"
  [ "$(_bulldog_bake_row "${core}")" = "${esc}[Sm${core}${esc}[0m" ]
  ! printf '%s' "$(_bulldog_bake_row "${core}")" | grep -q "${esc}\[Am"
  # Mono contract: empty palette -> c() no-op -> the row emits verbatim with ZERO SGR.
  USE_COLOR=false
  C_STRONG=""
  C_ACCENT=""
  [ "$(_bulldog_bake_row "${row}")" = "${row}" ]
  [ "$(_bulldog_bake_row "${core}")" = "${core}" ]
}

# --- idempotent load: a second _bulldog_load_asset is a no-op (BULLDOG_LOADED guards re-entry) -------

@test "_bulldog_load_asset: idempotent — a second load neither re-appends nor re-colors" {
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-tui-primitives.sh"
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-tui-bulldog.sh"
  GA_ROOT="${GA}"
  ART_ROWS=18
  USE_COLOR=false
  C_STRONG=""
  BULLDOG_ROWS=()
  BULLDOG_ROWS_C=()
  BULLDOG_LOADED=false
  _bulldog_load_asset
  [ "${BULLDOG_LOADED}" = "true" ]
  local n1="${#BULLDOG_ROWS[@]}"
  [ "${n1}" -eq 18 ]
  [ "${#BULLDOG_ROWS_C[@]}" -eq 18 ]
  # a second call returns early on the BULLDOG_LOADED guard — the arrays are not doubled/re-baked.
  _bulldog_load_asset
  [ "${#BULLDOG_ROWS[@]}" -eq "${n1}" ]
  [ "${#BULLDOG_ROWS_C[@]}" -eq "${n1}" ]
}
