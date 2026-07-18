#!/usr/bin/env bats
# art-asset-integrity.bats — regression pin for the shipped bulldog asset (plan §4.7.5-1 dimension
# gate). The TUI loads docs/assets/bulldog-braille.txt WHOLESALE and emits it verbatim, so its shape
# is a hard contract: the row count IS ART_ROWS (18) and no row may exceed ART_WIDTH (55) or the
# center-pad math + horizontal-fit gate break. Pinned invariants:
#   1. exactly 18 lines            (== ART_ROWS; the vertical geometry contract)
#   2. every char in U+2800-U+28FF (single-width braille only — no ASCII/emoji/double-width leak)
#   3. widest line == 55 (ART_WIDTH), every line 1..55 cells (the horizontal bound)
#
# NOTE — the asset is RIGHT-TRIMMED (ragged), not a uniform 55-wide raster: the offline generator
# strips trailing blank braille cells, so per-line widths run 44..55 (leading blank cells that
# position the art are preserved). A literal "every line == 55" assertion (as some earlier notes
# phrased the gate) would therefore fail the real shipped asset. The load-bearing invariant is the
# BOUND (max == ART_WIDTH, none over), which is what the render's centering + the ART_OK
# horizontal-fit gate actually depend on — that is what is pinned here.
#
# Run via: bats test/art-asset-integrity.bats
# Requires: bats, python3 (build-time dep; also generates the asset via bulldog-braille-gen.py)

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
ASSET="${GA}/docs/assets/bulldog-braille.txt"
ART_ROWS=18
ART_WIDTH=55

setup() {
  [[ -r "${ASSET}" ]] || skip "bulldog asset not found: ${ASSET}"
  command -v python3 >/dev/null || skip "python3 required for braille codepoint validation"
  trap - ERR
}

@test "asset has exactly ART_ROWS (18) lines" {
  run python3 - "${ASSET}" <<'PY'
import sys
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
if lines and lines[-1] == "":  # drop the trailing element from the final newline
    lines = lines[:-1]
print(len(lines))
PY
  [ "${status}" -eq 0 ]
  [ "${output}" = "${ART_ROWS}" ]
}

@test "every character is single-width braille (U+2800-U+28FF)" {
  run python3 - "${ASSET}" <<'PY'
import sys
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
if lines and lines[-1] == "":
    lines = lines[:-1]
bad = []
for i, line in enumerate(lines, 1):
    for ch in line:
        if not (0x2800 <= ord(ch) <= 0x28FF):
            bad.append((i, hex(ord(ch))))
if bad:
    print("OUT_OF_RANGE", bad[:10])
else:
    print("OK")
PY
  [ "${status}" -eq 0 ]
  [ "${output}" = "OK" ]
}

@test "widest line == ART_WIDTH (55), every line 1..55 cells (right-trimmed, ragged)" {
  run python3 - "${ASSET}" "${ART_WIDTH}" <<'PY'
import sys
asset, art_width = sys.argv[1], int(sys.argv[2])
lines = open(asset, encoding="utf-8").read().split("\n")
if lines and lines[-1] == "":
    lines = lines[:-1]
widths = [len(l) for l in lines]      # char count (each braille cell == 1 display column)
if not widths:
    print("NO_LINES"); sys.exit(0)
over = [(i, w) for i, w in enumerate(widths, 1) if w > art_width]
empty = [i for i, w in enumerate(widths, 1) if w < 1]
if over:
    print("OVER_WIDTH", over[:10])
elif empty:
    print("EMPTY_LINES", empty[:10])
elif max(widths) != art_width:
    print("MAX_MISMATCH", max(widths))
else:
    print("OK")
PY
  [ "${status}" -eq 0 ]
  [ "${output}" = "OK" ]
}
