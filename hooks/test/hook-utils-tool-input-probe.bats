#!/usr/bin/env bats
# hooks/hook-utils.sh — hook_probe_tool_input (three-state tool_input schema-drift probe) unit suite.
#
# Pins the T3 contract: the value-only hook_get_tool_input returns empty for BOTH a legitimately
# empty field AND a drifted (renamed / malformed / non-object) envelope, so a fail-open gate reading
# empty=allow cannot tell a real empty from a silent disarm. The probe adds the missing distinction:
#   * present       tool_input is an object AND the extracted value is non-empty
#   * empty         tool_input is an object AND the field is absent or extracts to empty
#   * unrecognized  root non-object, malformed JSON, tool_input absent, tool_input non-object
# and keeps the VALUE channel byte-identical to $(hook_get_tool_input ...) on every input, so the
# probe is a pure superset — it adds state, it never changes the value a caller already relied on.
# python3 absent → fail-open `empty` (today's silent allow), NOT `unrecognized` (AC4).
#
# Run via: bats hooks/test/hook-utils-tool-input-probe.bats
# Hermetic: sources the library + inline fixtures; no live monitor/DB/~/.claude state is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/hooks/hook-utils.sh"

# Field-kind fixture — one tool_input object exercising every str()/rstrip value edge in one probe.
#   plain  = ordinary path · num = number · special = spaces + escaped quote + backslash + unicode
#   nl     = embedded newline (preserved) · trail = trailing newlines (stripped, → empty state)
#   empty  = empty string value (legitimately-empty)
FIXTURE_JSON='{"tool_input":{"plain":"/tmp/secret.env","num":5,"special":"  q\"x\\y café  ","nl":"a\nb","trail":"keep\n\n","empty":""}}'

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "hook-utils.sh not found: ${REAL_LIB}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  WORK="$(mktemp -d -t hook-utils-probe.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Run the probe and split its two NUL-terminated records into the STATE + VALUE globals. A trailing
# `|| true` keeps a fail-at-HEAD (function undefined) from aborting the test before the assertion.
probe() {
  STATE=""
  VALUE=""
  {
    IFS= read -r -d '' STATE
    IFS= read -r -d '' VALUE
  } < <(hook_probe_tool_input "${1}" "${2}" || true)
}

@test "AC1 present: non-empty field → state=present, value returned unchanged" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe "${FIXTURE_JSON}" plain
  [[ "${STATE}" == "present" ]] || return 1
  [[ "${VALUE}" == "/tmp/secret.env" ]] || return 1
}

@test "AC1 byte-identical: probe VALUE equals hook_get_tool_input for every field kind" {
  # The value channel is a pure superset — the probe adds STATE but never mutates the value the
  # existing extractor already produced (present / number / unicode+quote+backslash / embedded-
  # newline / trailing-newline-stripped / empty-string). This is the "byte-identical across the
  # fixture set" AC, asserted against the real extractor as oracle.
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local f exp
  for f in plain num special nl trail empty; do
    probe "${FIXTURE_JSON}" "${f}"
    exp="$(hook_get_tool_input "${FIXTURE_JSON}" "${f}")"
    [[ "${VALUE}" == "${exp}" ]] || {
      printf 'mismatch on %s: probe=[%s] extractor=[%s]\n' "${f}" "${VALUE}" "${exp}" >&2
      return 1
    }
  done
}

@test "AC1 spot-checks: type coercion + trailing-newline strip + embedded-newline keep" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe "${FIXTURE_JSON}" num
  [[ "${STATE}" == "present" && "${VALUE}" == "5" ]] || return 1 # number → str()
  probe "${FIXTURE_JSON}" special
  [[ "${VALUE}" == "  q\"x\\y café  " ]] || return 1 # spaces+quote+backslash+unicode
  probe "${FIXTURE_JSON}" nl
  [[ "${VALUE}" == "a"$'\n'"b" ]] || return 1 # embedded newline preserved
}

@test "AC1 byte-identical: embedded-NUL value stripped, matching hook_get_tool_input" {
  # json.load decodes a JSON NUL escape to a real NUL byte — the same byte the two-record stream uses
  # as a delimiter. The probe must drop it so the value round-trips AND the record boundary stays intact
  # (VALUE arrives whole, not truncated at the NUL). The escape is built via printf so the .bats source
  # carries no literal NUL of its own.
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local esc json exp
  esc="$(printf '\\u0000')" # backslash + u0000 → the 6-char JSON escape
  json="{\"tool_input\":{\"cmd\":\"rm${esc}-rf\"}}"
  probe "${json}" cmd
  exp="$(hook_get_tool_input "${json}" cmd)" # oracle: the value-only extractor's byte output
  [[ "${STATE}" == "present" ]] || return 1
  [[ "${VALUE}" == "rm-rf" ]] || return 1 # NUL removed, surrounding text preserved
  [[ "${VALUE}" == "${exp}" ]] || return 1
}

@test "AC2 legitimately-empty: field absent from tool_input → state=empty" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{"tool_input":{"other":"x"}}' file_path
  [[ "${STATE}" == "empty" ]] || return 1
  [[ -z "${VALUE}" ]] || return 1
}

@test "AC2 legitimately-empty: field present but empty string → state=empty" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe "${FIXTURE_JSON}" empty
  [[ "${STATE}" == "empty" ]] || return 1
  [[ -z "${VALUE}" ]] || return 1
}

@test "AC2 legitimately-empty: value that rstrips to empty → state=empty (matches extractor)" {
  # State keys on the FINAL extracted value, so an all-newline value (extractor yields empty) reports
  # empty, not present — the state stays consistent with the byte-identical value channel.
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{"tool_input":{"file_path":"\n\n"}}' file_path
  [[ "${STATE}" == "empty" ]] || return 1
  [[ -z "${VALUE}" ]] || return 1
}

@test "AC3 unrecognized: tool_input key absent → state=unrecognized" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{"hook_event_name":"PreToolUse","session_id":"s1"}' file_path
  [[ "${STATE}" == "unrecognized" ]] || return 1
}

@test "AC3 unrecognized: malformed JSON → state=unrecognized" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{not valid json' file_path
  [[ "${STATE}" == "unrecognized" ]] || return 1
}

@test "AC3 unrecognized: tool_input is a non-object (string) → state=unrecognized" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{"tool_input":"a string, not an object"}' file_path
  [[ "${STATE}" == "unrecognized" ]] || return 1
}

@test "AC3 unrecognized: tool_input is null → state=unrecognized" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{"tool_input":null}' file_path
  [[ "${STATE}" == "unrecognized" ]] || return 1
}

@test "AC3 unrecognized: non-object root (JSON array) → state=unrecognized" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '[1,2,3]' file_path
  [[ "${STATE}" == "unrecognized" ]] || return 1
}

@test "AC3 distinctness: legitimately-empty and drifted envelope report different states" {
  # The whole point of the probe — the two conditions the value-only extractor collapses to a shared
  # empty must be told apart, so a consumer keeps allow on empty yet fails loud on unrecognized.
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  probe '{"tool_input":{}}' file_path # legit empty (object present, field gone)
  local empty_state="${STATE}"
  probe '{"tool_input":"drifted"}' file_path # drift (envelope no longer an object)
  local drift_state="${STATE}"
  [[ "${empty_state}" == "empty" ]] || return 1
  [[ "${drift_state}" == "unrecognized" ]] || return 1
  [[ "${empty_state}" != "${drift_state}" ]] || return 1
}

@test "AC4 fail-open: python3 absent → state=empty (today's silent allow), NOT unrecognized" {
  mkdir -p "${WORK}/nopy"
  # Let bats resolve bash via the ambient PATH, then strip PATH INSIDE the body (source + the probe
  # are builtins) — `env PATH=<nopy> bash` would fail bash's own lookup (exit 127). A present, drift-
  # free value that WOULD probe `present` with python must degrade to fail-open `empty` without it.
  run bash -c '
    # shellcheck source=/dev/null
    source "$1"
    export PATH="$2"
    state=""
    value="sentinel"
    { IFS= read -r -d "" state; IFS= read -r -d "" value; } < <(hook_probe_tool_input "{\"tool_input\":{\"file_path\":\"/x\"}}" file_path || true)
    printf "state=[%s] value=[%s]\n" "${state}" "${value}"
  ' _ "${REAL_LIB}" "${WORK}/nopy"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"state=[empty]"* ]] || return 1
  [[ "${output}" == *"value=[]"* ]] || return 1
  [[ "${output}" != *"unrecognized"* ]] || return 1
}
