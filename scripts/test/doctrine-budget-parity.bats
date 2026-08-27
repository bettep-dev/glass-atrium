#!/usr/bin/env bats
# Every number the Pre-drawing Doctrine states must equal the constant it names.
# The doctrine is a MIRROR by its own words ("the numbers here are a mirror,
# never the source"), and a mirror with no judge drifts the moment either side
# moves — content-budget.ts is edited by monitor work that never opens a scope
# file, and the scope file is edited by doctrine work that never opens the TS.
#
# Judge shape: both sides are EXTRACTED, never hand-copied — the TS caps come
# from the BUDGET_CAPS.balanced row and the band from getRatioState, the
# doctrine caps from its own "Caps:" line. Keys join on a name folded to
# letters-only lowercase, so `labelChars` and `label chars` are one key and the
# join needs no hardcoded mapping table.
#
# The SoT PATH is read out of the doctrine too, so a doctrine that names a file
# it does not have fails here rather than reading as parity against nothing.
#
# `scope-planning.md` is a pointer mirror: it restates no cap today, so the row
# asserts the pointer still stands AND that any number it does restate matches.
#
# Absent sources SKIP: the live install's run-bats-parallel.sh executes every
# on-disk .bats, and the monitor TS sources are not part of every tree.
#
# Run via: bats scripts/test/doctrine-budget-parity.bats
# Requires: bats, bash 3.2+, awk, sed.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REPORT_MD="${GA}/scoped/scope-report.md"
PLANNING_MD="${GA}/scoped/scope-planning.md"
REPORT_HEAD='## Pre-drawing Doctrine [REPORT]'
PLANNING_HEAD='## Pre-drawing Doctrine [PLANNING]'
VIEWER_JSX="${GA}/monitor/public/src/screens/clauded-docs.jsx"
EXPORT_TS="${GA}/monitor/src/server/clauded-docs/html-export.ts"

# Body of one doctrine section, up to the next `##` heading, with the two
# comparison glyphs folded to ASCII so every downstream match is byte-plain.
section_body() {
  awk -v head="$2" '
    index($0, head) == 1 { insec = 1; next }
    insec && /^## / { exit }
    insec { print }
  ' "$1" | sed 's/≤/<=/g; s/≥/>=/g; s/·/|/g'
}

# `<key>|<value>` per cap stated on the doctrine "Caps:" line. Key folds to
# letters-only lowercase; the value is whatever follows its `<=`.
caps_from_doctrine() {
  section_body "$1" "$2" | awk '
    /Caps:/ {
      line = $0
      sub(/^.*Caps:/, "", line)
      n = split(line, seg, "\\|")
      for (i = 1; i <= n; i++) {
        if (match(seg[i], /<=[ \t]*[0-9]+/)) {
          v = substr(seg[i], RSTART + 2, RLENGTH - 2)
          k = substr(seg[i], 1, RSTART - 1)
          gsub(/[^A-Za-z]/, "", k)
          gsub(/[^0-9]/, "", v)
          if (k != "" && v != "") print tolower(k) "|" v
        }
      }
    }
  ' | LC_ALL=C sort
}

# `<key>|<value>|<tsName>` per field of the BUDGET_CAPS row named by $2.
caps_from_ts() {
  awk -v grade="$2" '
    index($0, "export const BUDGET_CAPS") > 0 { inblock = 1; next }
    inblock && /^\};/ { exit }
    inblock && index($0, grade ":") > 0 {
      line = $0
      while (match(line, /[A-Za-z]+[ \t]*:[ \t]*[0-9]+/)) {
        pair = substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
        split(pair, kv, ":")
        k = kv[1]; v = kv[2]
        gsub(/[^A-Za-z]/, "", k)
        gsub(/[^0-9]/, "", v)
        if (k != "" && v != "") print tolower(k) "|" v "|" k
      }
      exit
    }
  ' "$1" | LC_ALL=C sort
}

# `warn|<ratio>` and `fail|<ratio>` from the ratio-band function. `+0` folds
# `1.0` and `1` to one spelling so the two sides compare numerically.
band_from_ts() {
  awk '
    index($0, "function getRatioState") > 0 { inf = 1; next }
    inf && /^}/ { exit }
    inf && /return "fail"/ && match($0, />[ \t]*[0-9.]+/) {
      s = substr($0, RSTART + 1, RLENGTH - 1); printf "fail|%s\n", s + 0
    }
    inf && /return "warn"/ && match($0, />=[ \t]*[0-9.]+/) {
      s = substr($0, RSTART + 2, RLENGTH - 2); printf "warn|%s\n", s + 0
    }
  ' "$1" | LC_ALL=C sort
}

# Same two ratios off the doctrine "Band:" line. `>=` is consumed first so the
# fail scan cannot re-read the warn threshold's `>`.
band_from_doctrine() {
  section_body "$1" "$2" | awk '
    /Band:/ {
      line = $0
      gsub(/>=/, " GE ", line)
      gsub(/>/, " GT ", line)
      if (match(line, /GE[ \t]+[0-9.]+/)) {
        s = substr(line, RSTART + 2, RLENGTH - 2); printf "warn|%s\n", s + 0
      }
      if (match(line, /GT[ \t]+[0-9.]+/)) {
        s = substr(line, RSTART + 2, RLENGTH - 2); printf "fail|%s\n", s + 0
      }
    }
  ' | LC_ALL=C sort
}

# The path the doctrine names as a SoT, matched by the basename it cites.
sot_path_from_doctrine() {
  section_body "$1" "$2" | awk -v base="$3" '
    index($0, base) > 0 {
      line = $0
      while (match(line, "[A-Za-z0-9_./-]*/[A-Za-z0-9_./-]*")) {
        cand = substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
        if (index(cand, base) > 0) { print cand; exit }
      }
    }
  '
}

preset_names() { grep -o 'doc-diagram-[a-z]*' "$1" | LC_ALL=C sort -u; }

require_files() {
  local f
  for f in "$@"; do
    [[ -f "${f}" ]] || skip "source not present in this tree: ${f#"${GA}"/}"
  done
}

setup() { require_files "${REPORT_MD}"; }

@test "the doctrine names a budget SoT that exists in this tree" {
  local rel
  rel="$(sot_path_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}" content-budget.ts)"
  [[ -n "${rel}" ]] || {
    echo "the Budget step names no content-budget.ts path"
    return 1
  }
  [[ -f "${GA}/${rel}" ]] || skip "named SoT absent in this tree: ${rel}"
}

@test "every doctrine budget cap equals its BUDGET_CAPS.balanced field" {
  local rel ts doc_caps ts_caps key val name doc_val
  rel="$(sot_path_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}" content-budget.ts)"
  [[ -n "${rel}" ]] || { echo "the Budget step names no content-budget.ts path"; return 1; }
  ts="${GA}/${rel}"
  require_files "${ts}"

  doc_caps="$(caps_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}")"
  ts_caps="$(caps_from_ts "${ts}" balanced)"

  # Non-vacuity: an empty extraction on either side would compare clean.
  [[ "$(printf '%s\n' "${doc_caps}" | grep -c .)" -ge 4 ]] || {
    echo "doctrine caps unreadable — extracted:"; printf '%s\n' "${doc_caps}"; return 1
  }
  [[ "$(printf '%s\n' "${ts_caps}" | grep -c .)" -ge 4 ]] || {
    echo "BUDGET_CAPS.balanced unreadable — extracted:"; printf '%s\n' "${ts_caps}"; return 1
  }

  while IFS='|' read -r key val name; do
    [[ -n "${key}" ]] || continue
    doc_val="$(printf '%s\n' "${doc_caps}" | awk -F'|' -v k="${key}" '$1 == k { print $2; exit }')"
    [[ -n "${doc_val}" ]] || {
      echo "BUDGET_CAPS.balanced.${name} = ${val} is stated by no doctrine cap (key ${key})"
      echo "doctrine caps:"; printf '%s\n' "${doc_caps}"
      return 1
    }
    [[ "${doc_val}" == "${val}" ]] || {
      echo "budget cap drift on BUDGET_CAPS.balanced.${name}:"
      echo "  ${rel} = ${val}"
      echo "  scoped/scope-report.md doctrine Caps = ${doc_val}"
      return 1
    }
  done < <(printf '%s\n' "${ts_caps}")

  # And the reverse direction: a doctrine cap naming no TS field is drift too.
  while IFS='|' read -r key val; do
    [[ -n "${key}" ]] || continue
    printf '%s\n' "${ts_caps}" | awk -F'|' -v k="${key}" '$1 == k { found = 1 } END { exit !found }' || {
      echo "doctrine states ${key} <= ${val}, which BUDGET_CAPS.balanced does not carry"
      echo "TS caps:"; printf '%s\n' "${ts_caps}"
      return 1
    }
  done < <(printf '%s\n' "${doc_caps}")
}

@test "the doctrine warn and fail band equals getRatioState" {
  local rel ts doc_band ts_band key val ts_val
  rel="$(sot_path_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}" content-budget.ts)"
  [[ -n "${rel}" ]] || { echo "the Budget step names no content-budget.ts path"; return 1; }
  ts="${GA}/${rel}"
  require_files "${ts}"

  doc_band="$(band_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}")"
  ts_band="$(band_from_ts "${ts}")"

  [[ "$(printf '%s\n' "${doc_band}" | grep -c .)" -eq 2 ]] || {
    echo "doctrine Band line unreadable — extracted:"; printf '%s\n' "${doc_band}"; return 1
  }
  [[ "$(printf '%s\n' "${ts_band}" | grep -c .)" -eq 2 ]] || {
    echo "getRatioState unreadable — extracted:"; printf '%s\n' "${ts_band}"; return 1
  }

  while IFS='|' read -r key val; do
    [[ -n "${key}" ]] || continue
    ts_val="$(printf '%s\n' "${ts_band}" | awk -F'|' -v k="${key}" '$1 == k { print $2; exit }')"
    [[ "${ts_val}" == "${val}" ]] || {
      echo "budget band drift on the ${key} threshold:"
      echo "  ${rel} getRatioState = ${ts_val}"
      echo "  scoped/scope-report.md doctrine Band = ${val}"
      return 1
    }
  done < <(printf '%s\n' "${doc_band}")
}

@test "the three doctrine size presets are the three viewer and export selectors" {
  require_files "${VIEWER_JSX}" "${EXPORT_TS}"
  local doc viewer export
  doc="$(section_body "${REPORT_MD}" "${REPORT_HEAD}" | grep -o 'doc-diagram-[a-z]*' | LC_ALL=C sort -u)"
  viewer="$(preset_names "${VIEWER_JSX}")"
  export="$(preset_names "${EXPORT_TS}")"

  [[ "$(printf '%s\n' "${doc}" | grep -c .)" -ge 3 ]] || {
    echo "doctrine Preset step names fewer than three presets:"; printf '%s\n' "${doc}"; return 1
  }
  [[ "${doc}" == "${viewer}" ]] || {
    echo "preset drift between the doctrine and the viewer:"
    diff <(printf '%s\n' "${doc}") <(printf '%s\n' "${viewer}")
    return 1
  }
  [[ "${doc}" == "${export}" ]] || {
    echo "preset drift between the doctrine and the export:"
    diff <(printf '%s\n' "${doc}") <(printf '%s\n' "${export}")
    return 1
  }
}

@test "the planning mirror still points at the report SoT and restates no divergent cap" {
  require_files "${PLANNING_MD}"
  local body report_caps mirror_caps key val rep_val
  body="$(section_body "${PLANNING_MD}" "${PLANNING_HEAD}")"
  [[ -n "${body}" ]] || { echo "no ${PLANNING_HEAD} section in scoped/scope-planning.md"; return 1; }
  [[ "${body}" == *"scope-report.md"* ]] || {
    echo "the planning mirror no longer names scope-report.md as its SoT:"
    printf '%s\n' "${body}"
    return 1
  }

  report_caps="$(caps_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}")"
  mirror_caps="$(caps_from_doctrine "${PLANNING_MD}" "${PLANNING_HEAD}")"
  while IFS='|' read -r key val; do
    [[ -n "${key}" ]] || continue
    rep_val="$(printf '%s\n' "${report_caps}" | awk -F'|' -v k="${key}" '$1 == k { print $2; exit }')"
    [[ "${rep_val}" == "${val}" ]] || {
      echo "the planning mirror restates ${key} <= ${val}; scope-report.md states ${rep_val:-nothing}"
      return 1
    }
  done < <(printf '%s\n' "${mirror_caps}")
}

@test "the judge catches a doctrine cap edited away from the TS constant" {
  local rel ts fixture
  rel="$(sot_path_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}" content-budget.ts)"
  ts="${GA}/${rel}"
  require_files "${ts}"
  fixture="${BATS_TEST_TMPDIR}/mutated-scope-report.md"
  # Bump only the first cap on the Caps line; everything else stays byte-identical.
  sed 's/\(Caps: nodes ≤ \)\([0-9]*\)/\199/' "${REPORT_MD}" >"${fixture}"
  # The fixture must genuinely differ, or the row demonstrates nothing.
  ! cmp -s "${REPORT_MD}" "${fixture}"
  [[ "$(caps_from_doctrine "${fixture}" "${REPORT_HEAD}")" != "$(caps_from_doctrine "${REPORT_MD}" "${REPORT_HEAD}")" ]]
}
