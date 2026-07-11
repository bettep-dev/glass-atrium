#!/usr/bin/env bats
# enforce-commit-guard.bats — pins the PreToolUse(Bash) dangerous-git-command gate.
#
# Regression under repair: the RULES table used '|' as the field delimiter, but the
# force-push (GIT-001) and push-to-main (GIT-006) regexes contain '|' alternation.
# The split truncated each pattern mid-regex — GIT-001 dropped its '-f' short-form
# arm and GIT-006 became 'git\s+push\s+\S+\s+(main' (an unbalanced '(' grep rejects
# as invalid) — so both blocks were silently disarmed (the sole gate fully bypassed)
# AND every command leaked a grep parse error to stderr. The fix delimits fields
# with US (0x1F), which can never occur in a regex, and lints each pattern's
# compilation before use.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK. Block detail (the
# JSON error object) is emitted to stderr → captured into GUARD_ERR.
#
# bats 1.13 checks ONLY the LAST command's status, so a bare intermediate `[[ ]]` is
# silently ignored (a false one never fails the test). Every gating assertion below
# therefore carries `|| return 1` so it aborts the test AT the failing line.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-commit-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-commit-guard.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Drive the hook as a Bash PreToolUse call. jq -n encodes the command safely.
# stderr is captured to a file (GUARD_ERR) so the "no grep parse error" control can
# distinguish the hook's own emit_error output from an invalid-regex grep leak.
run_guard() {
  local cmd="$1" payload
  payload="$(jq -n --arg c "${cmd}" '{tool_name:"Bash", tool_input:{command:$c}}')"
  local err_file="${BATS_TEST_TMPDIR}/guard-stderr"
  : >"${err_file}"
  run bash -c 'printf "%s" "$1" | bash "$2" 2>"$3"' _ "${payload}" "${HOOK_SH}" "${err_file}"
  GUARD_ERR="$(cat "${err_file}")"
}

# --- Force-push corpus (GIT-001): BOTH arms of the alternation must block ---

@test "git push -f (short force) is blocked with code GIT-001" {
  # RED before fix: the '-f' arm was severed by the pipe split, so only '--force'
  # survived → the short form silently passed through.
  run_guard 'git push -f origin feature'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-001"'* ]] || return 1
}

@test "git push --force (long force) is blocked with code GIT-001" {
  # RED before fix: '--force' matched the truncated pattern but the emitted code was
  # the corrupted regex fragment ('git\s+push\s+-f\b'), never the literal GIT-001.
  run_guard 'git push --force'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-001"'* ]] || return 1
}

# --- Push-to-main corpus (GIT-006): the truncated regex never compiled at all ---

@test "git push origin main is blocked with code GIT-006" {
  # RED before fix: 'git\s+push\s+\S+\s+(main' is an unbalanced-paren regex grep
  # refused to compile → the block never fired.
  run_guard 'git push origin main'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-006"'* ]] || return 1
}

@test "git push origin master is blocked with code GIT-006" {
  run_guard 'git push origin master'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-006"'* ]] || return 1
}

# --- Emitted fields are un-corrupted (delimiter no longer collides) ---

@test "block error carries the human message + suggestion intact (no field truncation)" {
  run_guard 'git push --force'
  [[ "${status}" -eq 2 ]] || return 1
  # Before the fix, 'message' held the code and 'suggestion' held two pipe-joined
  # fragments. Now each lands in its own field.
  [[ "${GUARD_ERR}" == *'"message":"Force push blocked"'* ]] || return 1
  [[ "${GUARD_ERR}" == *'"suggestion":"Request explicit user confirmation for force push"'* ]] || return 1
}

# --- Non-matching control: no block AND no invalid-regex grep leak on stderr ---

@test "benign git status is not blocked and leaks NO grep parse error" {
  # RED before fix: the invalid GIT-006 regex made grep print 'parentheses not
  # balanced' to stderr on EVERY command, even non-matching ones.
  run_guard 'git status'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${GUARD_ERR}" ]] || return 1
}

@test "other still-valid blocks are intact (GIT-002 hard reset)" {
  # Regression guard: a rule WITHOUT alternation was never corrupted; it must keep
  # blocking after the delimiter swap.
  run_guard 'git reset --hard HEAD~1'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-002"'* ]] || return 1
}

# --- Discard/restore-all corpus (GIT-004/GIT-005): the $-anchored arms ---
# These rules embed a '\$' end-anchor inside a DOUBLE-quoted RULES element. A
# '\$'->'$$' regression compiles as a VALID grep -E regex (the anchor becomes a
# literal PID number), so the GIT-000 lint stays green and the block is silently
# disarmed — only a behavior test catches it. The negative control pins the anchor:
# a path-scoped 'checkout ./file.txt' MUST fall through.

@test "git checkout . (discard-all) is blocked with code GIT-004" {
  run_guard 'git checkout .'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-004"'* ]] || return 1
}

@test "git restore . (restore-all) is blocked with code GIT-005" {
  run_guard 'git restore .'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${GUARD_ERR}" == *'"error_code":"GIT-005"'* ]] || return 1
}

@test "git checkout ./file.txt (path-scoped) is NOT blocked (EOL anchor holds)" {
  # RED if the '\$' anchor regressed: 'checkout\s+\.' would match the leading '.' of
  # './file.txt' with no end-of-line requirement, wrongly blocking a path-scoped op.
  run_guard 'git checkout ./file.txt'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${GUARD_ERR}" ]] || return 1
}

# --- Recurrence guard: rule-table lint fails CLOSED on a non-compiling pattern ---

@test "rule-table lint fails closed (GIT-000) when a pattern does not compile" {
  # Prove the lint catches a future delimiter/escaping regression: corrupt one
  # RULES regex into an unbalanced-paren pattern (literal string replace, not sed
  # regex — the file contains backslashes) and confirm a harmless command is
  # BLOCKED with GIT-000 rather than silently passed through.
  local dir="${BATS_TEST_TMPDIR}/broken"
  mkdir -p "${dir}"
  cp "${BATS_TEST_DIRNAME}/../hook-utils.sh" "${dir}/hook-utils.sh"
  python3 -c 'import sys
src = open(sys.argv[1]).read()
src = src.replace(r"git\s+reset\s+--hard", r"git\s+reset\s+(unbalanced")
open(sys.argv[2], "w").write(src)' "${HOOK_SH}" "${dir}/enforce-commit-guard.sh"

  local payload
  payload="$(jq -n --arg c "echo hello" '{tool_name:"Bash", tool_input:{command:$c}}')"
  run bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "${payload}" "${dir}/enforce-commit-guard.sh"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *'"error_code":"GIT-000"'* ]] || return 1
  [[ "${output}" == *"does not compile"* ]] || return 1
}

@test "well-formed table passes a harmless command (no false GIT-000)" {
  run_guard 'echo hello world'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${GUARD_ERR}" ]] || return 1
}
