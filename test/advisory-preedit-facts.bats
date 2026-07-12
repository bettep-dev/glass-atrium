#!/usr/bin/env bats
# advisory-preedit-facts.sh — verdict + BOUNDED tail-read behavior.
#
# The hook scans only the last ~1 MiB of the transcript (lib/_read_tail seek), never the whole
# stream, so a long session is not re-read each turn-end. This suite pins two facets:
#   (1) current-turn fixtures (<= the window) read the ENTIRE file (start == 0), so the verdict is
#       byte-identical to the prior full-read baseline — declared -> silent, undeclared -> advisory,
#       no-edit -> silent.
#   (2) a fixture LARGER than the window whose only undeclared edit sits at the HEAD is NOT flagged:
#       the head falls outside the tail window and is never scanned (bounded-read proof). Paired with
#       the small-undeclared control, this isolates bounding — not "head edits are never flagged" —
#       as the reason for the silence.
#
# Run via: bats test/advisory-preedit-facts.bats
# Requires: bats (brew install bats-core), python3, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
HOOK="${GA}/hooks/advisory-preedit-facts.sh"

# The hook's tail window (must match _TAIL_WINDOW_BYTES in the hook). The large fixture below
# is generated strictly larger than this so its head edit provably falls outside the window.
TAIL_WINDOW_BYTES=1048576

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  [[ -f "${HOOK}" ]] || skip "hook not found: ${HOOK}"
  TRANSCRIPT="$(mktemp -t ga-preedit-bats.XXXXXX)"
}

teardown() {
  [[ -n "${TRANSCRIPT:-}" && -f "${TRANSCRIPT}" ]] && rm -f -- "${TRANSCRIPT}" || true
}

# Feed a {"transcript_path": ...} payload on stdin; capture stdout+stderr (advisory goes to stderr).
run_hook() {
  local payload
  payload="$(printf '{"transcript_path":"%s"}' "$1")"
  run bash -c 'printf "%s" "$2" | "$1" 2>&1' _ "${HOOK}" "${payload}"
}

# A transcript entirely within one turn: a declaration + its matching edit -> all_declared.
write_declared_fixture() {
  {
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Pre-Edit Facts: /x/tailfile.txt"}]}}'
    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/tailfile.txt"}}]}}'
  } >"$1"
}

# A small transcript with a single UNDECLARED edit -> missing advisory (detection control).
write_undeclared_fixture() {
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/x/smallfile.txt"}}]}}' >"$1"
}

# A transcript with text but no edits -> skip_silent.
write_noedit_fixture() {
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"just prose, no edits this turn"}]}}' >"$1"
}

# A fixture LARGER than the tail window: an undeclared HEAD edit, then > 1 MiB of skip-safe filler,
# then a current-turn declared edit at the tail. Full read -> HEADFILE flagged; bounded read -> silent.
write_large_fixture() {
  local f="$1" pad line
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/head/HEADFILE.txt"}}]}}' >"$f"
  pad="$(head -c 1200 </dev/zero | tr '\0' P)"
  line="{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"${pad}\"}]}}"
  yes "${line}" | head -n 1200 >>"$f"
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Pre-Edit Facts: /tail/tailfile.txt"}]}}' >>"$f"
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tail/tailfile.txt"}}]}}' >>"$f"
}

@test "current-turn declared edit -> silent (full-read-identical, start==0)" {
  write_declared_fixture "${TRANSCRIPT}"
  run_hook "${TRANSCRIPT}"
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" != *"ADVISORY"* ]] || return 1
}

@test "current-turn undeclared edit -> missing advisory names the file (detection control)" {
  write_undeclared_fixture "${TRANSCRIPT}"
  run_hook "${TRANSCRIPT}"
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"ADVISORY"* ]] || return 1
  [[ "${output}" == *"smallfile.txt"* ]] || return 1
}

@test "no edits this turn -> silent" {
  write_noedit_fixture "${TRANSCRIPT}"
  run_hook "${TRANSCRIPT}"
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" != *"ADVISORY"* ]] || return 1
}

@test "bounded tail-read: undeclared HEAD edit beyond the window is not scanned" {
  write_large_fixture "${TRANSCRIPT}"
  local bytes
  bytes="$(wc -c <"${TRANSCRIPT}" | tr -d ' ')"
  # fixture must exceed the tail window for the proof to hold
  [ "${bytes}" -gt "${TAIL_WINDOW_BYTES}" ] || return 1
  run_hook "${TRANSCRIPT}"
  [ "${status}" -eq 0 ] || return 1
  # HEADFILE (undeclared, at byte 0) would flag "missing" on a full read; the bounded read never sees it.
  [[ "${output}" != *"HEADFILE"* ]] || return 1
  [[ "${output}" != *"ADVISORY"* ]] || return 1
}
