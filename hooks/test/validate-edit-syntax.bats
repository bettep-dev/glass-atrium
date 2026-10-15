#!/usr/bin/env bats
# validate-edit-syntax.sh — edit-time syntax gate coverage.
#
# Proves the PreToolUse(Write|Edit) parse-only check: an invalid-syntax write WARNS by default and blocks
# (exit 2) only under the burn-in flag SYNTAX_GATE_BLOCK=1; valid syntax and templates always pass; an Edit
# is checked against the reconstructed post-edit file, never the fragment.
#
# Run via: bats hooks/test/validate-edit-syntax.bats
# Requires: bats, bash 3.2+, python3, jq (input assembly); node checks skip when node is absent.

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-edit-syntax.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required for input assembly"
  SANDBOX="$(mktemp -d -t ga-editsyntax-bats.XXXXXX)"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# Build a Write envelope. Args: $1=file_path $2=content.
write_input() {
  jq -n --arg fp "$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$fp,content:$c}}'
}

# Build an Edit envelope. Args: $1=file_path $2=old_string $3=new_string.
edit_input() {
  jq -n --arg fp "$1" --arg o "$2" --arg n "$3" \
    '{tool_name:"Edit",tool_input:{file_path:$fp,old_string:$o,new_string:$n}}'
}

# Run the hook. Args: $1=input JSON; $2..=extra env assignments.
run_hook() {
  printf '%s' "$1" >"${SANDBOX}/input.json"
  run env "${@:2}" bash "${HOOK_SH}" <"${SANDBOX}/input.json"
}

@test "invalid shell Write advises by default and does not block (exit 0)" {
  run_hook "$(write_input "${SANDBOX}/x.sh" 'if true')"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SYNTAX advisory"* ]]
}

@test "invalid shell Write blocks (exit 2) when burn-in is armed" {
  run_hook "$(write_input "${SANDBOX}/x.sh" 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"Invalid sh syntax"* ]]
}

@test "an armed block carries the checker's diagnostic in its suggestion" {
  run_hook "$(write_input "${SANDBOX}/x.sh" 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 2 ]] || {
    echo "${output}"
    return 1
  }
  local suggestion
  suggestion="$(grep -F '"SYNTAX-001"' <<<"${output}" | jq -r '.suggestion')"
  [[ "${suggestion}" == *"(checker: "*"syntax error"* ]] || {
    echo "suggestion lacks the checker diagnostic: ${suggestion}"
    return 1
  }
}

@test "valid shell Write passes clean (exit 0, no advisory)" {
  run_hook "$(write_input "${SANDBOX}/x.sh" 'echo hello')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SYNTAX advisory"* ]]
}

@test "invalid python Write advises" {
  run_hook "$(write_input "${SANDBOX}/x.py" 'def f(:')"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SYNTAX advisory"* ]]
}

@test "the advisory surfaces the checker's stderr diagnostic with a line number (R6)" {
  # py_compile prints the offending location ('File ..., line N') to stderr; the advisory must fold
  # the first stderr line in (with the ' — ' separator), not discard it as the old >/dev/null did.
  run_hook "$(write_input "${SANDBOX}/x.py" 'def f(:')"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SYNTAX advisory"* ]]
  [[ "${output}" == *" — "* ]]
  [[ "${output}" == *"line 1"* ]]
}

@test "invalid python Write blocks when armed" {
  run_hook "$(write_input "${SANDBOX}/x.py" 'def f(:')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"Invalid py syntax"* ]]
}

@test "invalid javascript Write advises" {
  command -v node >/dev/null 2>&1 || skip "node required"
  run_hook "$(write_input "${SANDBOX}/x.js" 'const x =')"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SYNTAX advisory"* ]]
}

@test "a valid ESM .mjs Write passes clean (extension preserved for module mode, armed)" {
  command -v node >/dev/null 2>&1 || skip "node required"
  # Regression: an extensionless temp made node --check parse ESM as CJS, false-failing import/export;
  # the src.${ext} temp keeps module mode, so this valid ESM write must not advise or block.
  run_hook "$(write_input "${SANDBOX}/x.mjs" 'import { basename } from "node:path";
export const name = basename("/a/b");')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SYNTAX advisory"* ]]
}

@test "a templates/ path is exempt even with invalid syntax (armed)" {
  run_hook "$(write_input "${SANDBOX}/templates/gen.sh" 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SYNTAX advisory"* ]]
}

@test "a template-suffixed basename is exempt (armed)" {
  run_hook "$(write_input "${SANDBOX}/config.template.sh" 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "an unlisted extension is not gated (armed)" {
  run_hook "$(write_input "${SANDBOX}/notes.md" 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "an Edit is checked against the reconstructed file, not the fragment" {
  printf 'echo hello\n' >"${SANDBOX}/good.sh"
  # The fragment "if true" alone is invalid; reconstructed it replaces the whole body.
  run_hook "$(edit_input "${SANDBOX}/good.sh" 'echo hello' 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"Invalid sh syntax"* ]]
}

@test "an Edit keeping valid syntax passes clean" {
  printf 'echo hello\n' >"${SANDBOX}/good.sh"
  run_hook "$(edit_input "${SANDBOX}/good.sh" 'echo hello' 'echo goodbye')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "an Edit whose old_string is absent is un-reconstructable and passes" {
  printf 'echo hello\n' >"${SANDBOX}/good.sh"
  run_hook "$(edit_input "${SANDBOX}/good.sh" 'NOT_PRESENT' 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "an Edit on an absent file cannot be reconstructed and passes" {
  run_hook "$(edit_input "${SANDBOX}/missing.sh" 'echo hello' 'if true')" SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "the kill switch disables the gate even on an invalid armed write" {
  run_hook "$(write_input "${SANDBOX}/x.sh" 'if true')" SYNTAX_GATE_BLOCK=1 SYNTAX_GATE_OFF=1
  [[ "${status}" -eq 0 ]]
}

@test "a non-Write/Edit tool is ignored" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"if true"}}' SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

@test "a missing file_path passes" {
  run_hook '{"tool_name":"Write","tool_input":{}}' SYNTAX_GATE_BLOCK=1
  [[ "${status}" -eq 0 ]]
}

# macOS mktemp -d ignores TMPDIR → a recording mktemp stub observes the work dir instead.
@test "the work dir never outlives the run, on the pass or the block verdict" {
  local -a rows=('pass|echo hello|0' 'block|if true|2')
  local stub_dir="${SANDBOX}/stub-bin" made_log="${SANDBOX}/mktemp-made.log" row name content want made
  mkdir -p "${stub_dir}"
  printf '#!/usr/bin/env bash\nmade="$(%q "$@")" || exit\nprintf "%%s\\n" "${made}" >>%q\nprintf "%%s\\n" "${made}"\n' \
    "$(command -v mktemp)" "${made_log}" >"${stub_dir}/mktemp"
  chmod +x "${stub_dir}/mktemp"
  for row in "${rows[@]}"; do
    IFS='|' read -r name content want <<<"${row}"
    : >"${made_log}"
    run_hook "$(write_input "${SANDBOX}/x.sh" "${content}")" SYNTAX_GATE_BLOCK=1 PATH="${stub_dir}:${PATH}"
    [[ "${status}" -eq "${want}" ]] || {
      echo "${name}: exit ${status}, want ${want}"
      return 1
    }
    [[ -s "${made_log}" ]] || {
      echo "${name}: the run never made its work dir"
      return 1
    }
    while IFS= read -r made; do
      [[ ! -e "${made}" ]] || {
        echo "${name}: work dir left after exit: ${made}"
        return 1
      }
    done <"${made_log}"
  done
}

# A setup skip leaves SANDBOX unset — a failing teardown would report the skip as not ok.
@test "teardown succeeds silently when setup skipped before creating the temp dir" {
  local saved="${SANDBOX}"
  unset SANDBOX
  run teardown
  SANDBOX="${saved}"
  [[ "${status}" -eq 0 ]] || {
    echo "teardown without a temp dir failed (status ${status}): ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "teardown without a temp dir wrote: ${output}" >&2
    return 1
  }
}
