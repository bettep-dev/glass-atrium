#!/usr/bin/env bats
# Detector lines of skills/glass-atrium-design-anti-slop/SKILL.md → `## Detection Guidance`: each
# named line flags its trope and stays silent on look-alike code that is no trope.
#
# Run via: bats scripts/test/anti-slop-detector-lines.bats
# Requires: bats >= 1.5.0, python3, bash 3.2+

# shellcheck disable=SC2154  # bats sets BATS_TEST_DIRNAME, status and output
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
SKILL="${GA}/skills/glass-atrium-design-anti-slop/SKILL.md"

# Python re stands in for ripgrep: same \b \d \s and alternation semantics on these lines
setup() {
  PY_SRC="$(
    cat <<'PY'
import re
import sys

skill, block, name, sample = sys.argv[1:5]
heading = "## Detection Guidance" if block == "general" else "### Admin-console signals"
with open(skill, encoding="utf-8") as handle:
    section = handle.read().split(heading, 1)[1]
fence = section.split("~~~text\n", 1)[1].split("~~~", 1)[0]
marker = "(case-insensitive)"
for line in fence.splitlines():
    fields = re.split(r"\s{2,}", line.strip())
    label, flags = fields[0], 0
    if label.endswith(marker):
        label, flags = label[: -len(marker)].strip(), re.I
    elif fields[1] == marker:
        fields, flags = fields[1:], re.I
    if label == name:
        print("match" if re.search(fields[1], sample, flags) else "none")
        sys.exit(0)
sys.exit("no detector line named " + name)
PY
  )"
}

assert_rows() {
  local row name block line expected sample
  for row in "$@"; do
    IFS='|' read -r name block line expected sample <<<"${row}"
    run python3 -I -c "${PY_SRC}" "${SKILL}" "${block}" "${line}" "${sample}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: ${output}"
      return 1
    }
    [[ "${output}" == "${expected}" ]] || {
      echo "${name}: expected ${expected}, got ${output}"
      return 1
    }
  done
}

@test "the Font line flags a font name only as a whole, case-exact word" {
  assert_rows \
    "a pointer cursor value is no font name|general|Font|none|cursor: pointer;" \
    "an ariaLabel prop is no font name|general|Font|none|<button ariaLabel=\"Close\">" \
    "an interval timer is no font name|general|Font|none|const interval = setInterval(tick, 1000);" \
    "a default Inter stack is flagged|general|Font|match|font-family: Inter, sans-serif;" \
    "a Fraunces display face is flagged|general|Font|match|font-family: \"Fraunces\", serif;"
}

@test "the Flat surface lines flag a blurred zero-offset shadow and pass zero-blur spread rings" {
  assert_rows \
    "a hairline spread ring is no glow|general|Flat surface|none|box-shadow: 0 0 0 1px var(--border);" \
    "an inset spread ring is no glow|general|Flat surface|none|box-shadow: inset 0 0 0 3px var(--accent);" \
    "a two-layer focus ring is no glow|general|Flat surface|none|box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus);" \
    "a blurred zero-offset shadow is a glow|general|Flat surface|match|box-shadow: 0 0 24px rgba(124, 58, 237, 0.6);" \
    "a glow in a later shadow layer is flagged|general|Flat surface|match|box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), 0 0 12px #a855f7;" \
    "an admin hairline spread ring is no glow|admin|Flat surface|none|box-shadow: 0 0 0 1px var(--border);" \
    "an admin blurred zero-offset shadow is a glow|admin|Flat surface|match|box-shadow: 0 0 16px var(--accent);"
}

@test "the Label line flags the uppercase class and value, never a toUpperCase call" {
  assert_rows \
    "a toUpperCase call is no label treatment|general|Label|none|const code = id.toUpperCase();" \
    "the Tailwind uppercase class is flagged|general|Label|match|<span class=\"uppercase tracking-widest\">" \
    "a CSS uppercase transform is flagged|general|Label|match|text-transform: uppercase;"
}
