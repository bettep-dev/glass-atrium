#!/usr/bin/env bats
# Guard: EXPECTED_HOOK_BINDINGS (lib/ga-env.sh) completeness vs the architecture
# invariant (monitor/src/server/architecture/arch-invariants.ts). wire_hooks
# iterates this array, so a SHORT array silently leaves deployed hooks DORMANT
# (the 15->42 install-wiring gap this test locks down — 3 whole events,
# SubagentStart/SubagentStop/PreCompact, plus security + agent-tracker hooks were
# unwired). The guard parses BOTH sources LIVE and asserts a per-event AND total
# leaf-count match, so a future hook added to arch-invariants but not to the array
# (or vice-versa) fails here.
#
# Counting basis: per FLATTENED matcher-leaf, exactly as jq flattens
# .hooks.<event>[].hooks[] and as arch-invariants.ts HookEventCounts is defined
# (one leaf per event/command, NOT per matcher-GROUP). Each array row is already
# one leaf, so a row == a leaf. The event is parsed via a literal-TAB field split
# (IFS=$'\t'), mirroring wire_hooks — a space-delimited row would mis-parse its
# event and fail this guard (the tab-vs-space wiring trap).
#
# ACKNOWLEDGED LIMITATIONS (by design — NOT fixed here, no scope-creep):
#   (i)  wire_hooks emits only { matcher, hooks:[{type,command}] }; the 3-column
#        SoT (event/basename/matcher) cannot carry the settings backup's per-entry
#        `timeout` / `async:true` fields. PRE-EXISTING — arch-invariants counts
#        bindings only, so this guard is unaffected by the dropped fields.
#   (ii) wire_hooks re-wires SessionStart's 4 leaves as 4 single-leaf groups vs
#        the backup's 1-group-4-leaves shape. Semantically identical; the leaf
#        count is 4 either way, so the guard is unaffected.
#
# Run via: bats test/hook-bindings-complete.bats
# Requires: bats (brew install bats-core), awk, sed, grep (BSD or GNU), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CORE="${GA}/lib/ga-env.sh"
ARCH="${GA}/monitor/src/server/architecture/arch-invariants.ts"

# the 7 settings.json hook events arch-invariants.ts HookEventCounts declares.
EVENTS=(PreToolUse PostToolUse SessionStart Stop SubagentStart SubagentStop PreCompact)

setup() {
  [[ -f "${CORE}" ]] || skip "ga-env.sh not found: ${CORE}"
  [[ -f "${ARCH}" ]] || skip "arch-invariants.ts not found: ${ARCH}"
}

# emit each EXPECTED_HOOK_BINDINGS row body as "event<TAB>basename<TAB>matcher",
# the array indent + surrounding double-quotes stripped.
array_rows() {
  awk '
    /^[[:space:]]*EXPECTED_HOOK_BINDINGS=\(/ { f = 1; next }
    f && /^[[:space:]]*\)[[:space:]]*$/      { f = 0 }
    f                                        { print }
  ' "${CORE}" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//'
}

# per-event FLATTENED-LEAF count in the array (TAB-split event field).
array_event_count() {
  local want="$1" ev rest count=0
  while IFS=$'\t' read -r ev rest; do
    [[ "${ev}" == "${want}" ]] && count=$((count + 1))
  done < <(array_rows)
  printf '%s\n' "${count}"
}

# LIVE per-event count from arch-invariants.ts. ^-anchored: "Stop" is a SUBSTRING
# of "SubagentStop", so an unanchored 'Stop: [0-9]+' would double-match the
# SubagentStop line — the ^[[:space:]]* lead pins the match to the real key
# (BSD grep + bash 3.2 safe). The [0-9]+ tail also skips the interface line
# (`PreToolUse: number;` — non-numeric value).
arch_event_count() {
  local key="$1" hit
  hit="$(grep -oE "^[[:space:]]*${key}: [0-9]+" "${ARCH}" | head -n1)"
  [[ -n "${hit}" ]] || {
    printf 'MISSING\n'
    return
  }
  printf '%s\n' "${hit##*: }"
}

@test "per-event: EXPECTED_HOOK_BINDINGS leaf count == arch-invariants.ts count" {
  local ev a m
  for ev in "${EVENTS[@]}"; do
    a="$(array_event_count "${ev}")"
    m="$(arch_event_count "${ev}")"
    if [[ "${m}" == "MISSING" ]]; then
      echo "arch-invariants.ts has no numeric count for event: ${ev}"
      return 1
    fi
    if [[ "${a}" != "${m}" ]]; then
      echo "leaf-count mismatch for ${ev}: array=${a} arch-invariants=${m}"
      return 1
    fi
  done
}

@test "total: array leaf count == 42 == sum(arch-invariants.ts hooks)" {
  local ev m total arch_sum=0
  total="$(array_rows | wc -l | tr -d ' ')"
  for ev in "${EVENTS[@]}"; do
    m="$(arch_event_count "${ev}")"
    if [[ "${m}" == "MISSING" ]]; then
      echo "arch-invariants.ts has no numeric count for event: ${ev}"
      return 1
    fi
    arch_sum=$((arch_sum + m))
  done
  if [[ "${total}" != "42" ]]; then
    echo "array leaf total=${total}, expected 42"
    return 1
  fi
  if [[ "${arch_sum}" != "42" ]]; then
    echo "arch-invariants hooks sum=${arch_sum}, expected 42"
    return 1
  fi
}
