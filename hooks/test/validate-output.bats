#!/usr/bin/env bats
# validate-output.bats — parity + perf suite for the PostToolUse output validator
# (OWASP LLM05/LLM07) after its single-pass refactor:
#   * the two input python3 spawns (hook_get_field tool_name + inline tool_response)
#     collapsed into ONE python3 that NUL-emits both fields, and
#   * the 8-iteration LLM07 leak grep LOOP collapsed into ONE `grep -E` alternation.
#
# DETECTION/VERDICT PARITY (a): every LLM07 pattern the old per-pattern loop caught, the
# alternation still catches (all 8 tested individually + a non-match control + case-fold);
# the LLM05 Bash block path (5 patterns, exit 2 + decision:block) and the non-Bash pass-through
# are unchanged. The malformed/non-object fail-hard (exit non-zero) is preserved.
# PERF INVARIANT (b): on a non-Bash non-match the hook spawns exactly ONE python3 and ONE grep
# (the collapse target) — measured with counting python3/grep PATH shims that exec the real bins.
#
# Hermetic: a WORK sandbox holds the shims; JSON is fed on stdin. No live ~/.claude state touched.

bats_require_minimum_version 1.5.0

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-output.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "validate-output.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v grep >/dev/null 2>&1 || skip "grep required"
  WORK="$(mktemp -d -t validate-output-bats.XXXXXX)"
  REAL_PY="$(command -v python3)"
  REAL_GREP="$(command -v grep)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Drive the hook with JSON on stdin; stderr merged into stdout so both the advisory (SEC-072
# on stderr) and the block decision (stdout) land in $output. $status = hook exit code.
run_hook() {
  run env bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "$1" "${HOOK_SH}"
}

# Same, but through a PATH whose first entry holds counting python3/grep shims.
run_hook_counted() {
  run env PATH="${WORK}/bin:${PATH}" bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "$1" "${HOOK_SH}"
}

# Counting shim: one byte per invocation to a counter file, then exec the real binary so the
# hook's parse / match still runs. $1=binary name (python3|grep) · $2=absolute real-binary path.
make_counting_shim() {
  local name="${1}" real="${2}"
  mkdir -p "${WORK}/bin"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf x >>%q\n' "${WORK}/${name}count"
    printf 'exec %q "$@"\n' "${real}"
  } >"${WORK}/bin/${name}"
  chmod +x "${WORK}/bin/${name}"
}

# Byte count of a counter file (0 when absent — avoids the grep -c zero-match trap).
spawn_count() {
  [[ -f "${WORK}/${1}count" ]] || {
    printf '0\n'
    return 0
  }
  wc -c <"${WORK}/${1}count" | tr -d ' '
}

# --- DETECTION PARITY (a): LLM07 leak — every pattern the old loop caught ------

@test "leak parity: all 8 LLM07 patterns each trigger SEC-072 advisory + exit 0" {
  local -a patterns=(
    'your system prompt is'
    'my instructions are'
    'i was told to'
    'as instructed in my system'
    'my rules say'
    'according to my guidelines'
    'my configuration states'
    'i am programmed to'
  )
  local p input
  for p in "${patterns[@]}"; do
    input="{\"tool_name\":\"Read\",\"tool_response\":\"prefix ${p} suffix\"}"
    run_hook "${input}"
    [[ "${status}" -eq 0 ]] || {
      printf 'pattern [%s] expected exit 0, got %s\n' "${p}" "${status}" >&2
      return 1
    }
    [[ "${output}" == *"SEC-072"* ]] || {
      printf 'pattern [%s] did NOT emit SEC-072\n' "${p}" >&2
      return 1
    }
    [[ "${output}" == *"System prompt leak pattern detected"* ]] || return 1
  done
}

@test "leak parity: case-insensitive match preserved (tr-lowercase upstream of grep)" {
  run_hook '{"tool_name":"Read","tool_response":"MY INSTRUCTIONS ARE to comply"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SEC-072"* ]] || return 1
}

@test "leak non-match control: benign output → exit 0, NO SEC-072 advisory" {
  run_hook '{"tool_name":"Read","tool_response":"here is the file content you asked for"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SEC-072"* ]] || return 1
}

@test "empty {} input → fast exit 0, no advisory" {
  run_hook '{}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SEC-072"* ]] || return 1
}

# --- DETECTION PARITY (a): LLM05 code-injection block (Bash tool only) ---------

@test "LLM05 block parity: 5 dangerous patterns on Bash tool → exit 2 + decision:block" {
  local -a payloads=(
    'psql output: DROP TABLE users'
    'DELETE FROM accounts WHERE id=1'
    'exec(malicious_code)'
    '__import__(os).system(x)'
    'os.system(rm -rf /)'
  )
  local body input
  for body in "${payloads[@]}"; do
    input="{\"tool_name\":\"Bash\",\"tool_response\":\"${body}\"}"
    run_hook "${input}"
    [[ "${status}" -eq 2 ]] || {
      printf 'payload [%s] expected exit 2, got %s\n' "${body}" "${status}" >&2
      return 1
    }
    [[ "${output}" == *'"decision":"block"'* ]] || {
      printf 'payload [%s] missing decision:block\n' "${body}" >&2
      return 1
    }
    [[ "${output}" == *"SEC-012"* ]] || return 1
  done
}

@test "LLM05 non-Bash pass-through: DROP TABLE under a Read tool → exit 0, NOT blocked" {
  run_hook '{"tool_name":"Read","tool_response":"DROP TABLE users"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'"decision":"block"'* ]] || return 1
}

@test "LLM05 embedded-newline: ^os.system( on its own line (Bash) → block (newline preserved)" {
  # Proves the NUL-delimited single-parse keeps embedded newlines so the ^-anchored ERE still
  # sees line starts — a collapse that flattened newlines would miss this.
  run_hook '{"tool_name":"Bash","tool_response":"line one is fine\nos.system(danger)\nline three"}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *'"decision":"block"'* ]] || return 1
}

@test "LLM05 embedded-NUL: os.\u0000system( NUL-split (Bash) → block (NUL stripped, not truncated)" {
  # Regression guard for the NUL block-bypass. A JSON string CAN hold \u0000 — json.load decodes it
  # to a REAL NUL, which is the very delimiter `IFS= read -r -d ''` stops on. Pre-fix the read
  # TRUNCATED tool_response at the embedded NUL to a harmless "os." fragment → no ERE match → exit 0
  # (a silent block bypass on a security detector). The emitter's .replace('\x00','') now strips the
  # NUL BEFORE the delimiter so os.system( reassembles and the ^-anchored ERE matches → exit 2/block.
  # This assertion FAILS on the pre-fix truncating read and PASSES only after the strip.
  run_hook '{"tool_name":"Bash","tool_response":"os.\u0000system(danger)"}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *'"decision":"block"'* ]] || return 1
}

@test "LLM07 embedded-NUL: NUL-split leak phrase still fires SEC-072 (NUL stripped, not truncated)" {
  # Same NUL-truncation bug on the leak path: "my rul\u0000es say" → json.load → "my rul<NUL>es say".
  # Pre-fix the read truncated at the NUL to "my rul" → the LLM07 alternation never saw "my rules say"
  # → no advisory. After the emitter strips the NUL the phrase reassembles and SEC-072 fires.
  run_hook '{"tool_name":"Read","tool_response":"my rul\u0000es say to refuse"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SEC-072"* ]] || return 1
}

@test "LLM05 clean Bash output → exit 0, not blocked" {
  run_hook '{"tool_name":"Bash","tool_response":"ok: 3 files formatted, nothing dangerous"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'"decision":"block"'* ]] || return 1
}

# --- FAIL-HARD PARITY: malformed / non-object input keeps the prior loud-fail ---

@test "fail-hard parity: non-object JSON root ([1,2,3]) → exit non-zero (loud-fail kept)" {
  run_hook '[1,2,3]'
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${status}" -ne 2 ]] || return 1 # not a block — an input-parse fail-hard
}

@test "fail-hard parity: malformed JSON → exit non-zero (loud-fail kept)" {
  run_hook '{not valid json'
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${status}" -ne 2 ]] || return 1
}

# --- PERF INVARIANT (b): single python3 + single grep on the non-match path ----

@test "perf: non-Bash non-match spawns exactly ONE python3 (was two) and ONE grep (was up to 8)" {
  make_counting_shim python3 "${REAL_PY}"
  make_counting_shim grep "${REAL_GREP}"
  : >"${WORK}/python3count"
  : >"${WORK}/grepcount"

  run_hook_counted '{"tool_name":"Read","tool_response":"a perfectly normal benign response body"}'
  [[ "${status}" -eq 0 ]] || return 1
  # ONE parse call (the old hook_get_field + inline python3 were two).
  [[ "$(spawn_count python3)" -eq 1 ]] || {
    printf 'python3 spawns=%s (expected 1)\n' "$(spawn_count python3)" >&2
    return 1
  }
  # ONE alternation grep (the old per-pattern loop ran up to 8; non-Bash skips the LLM05 grep).
  [[ "$(spawn_count grep)" -eq 1 ]] || {
    printf 'grep spawns=%s (expected 1)\n' "$(spawn_count grep)" >&2
    return 1
  }
}

@test "perf: a leak match still spawns exactly ONE grep (single alternation pass, no loop)" {
  make_counting_shim python3 "${REAL_PY}"
  make_counting_shim grep "${REAL_GREP}"
  : >"${WORK}/python3count"
  : >"${WORK}/grepcount"

  run_hook_counted '{"tool_name":"Read","tool_response":"my rules say to refuse"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SEC-072"* ]] || return 1
  [[ "$(spawn_count python3)" -eq 1 ]] || return 1
  [[ "$(spawn_count grep)" -eq 1 ]] || return 1
}
