#!/usr/bin/env bats
# hooks/hook-utils.sh — hook_get_fields (single-pass multi-field extractor) unit suite.
#
# Pins two contracts:
#   * PARITY: each batch-extracted field value is byte-identical to a sequential hook_get_field
#     call for the same key (present / absent / nested-object / number / bool / null / special-char
#     / embedded-newline / trailing-newline), incl. the fail-open cases (python3 absent, malformed
#     JSON, non-object root) where both degrade to empty.
#   * PERF INVARIANT: the batch path spawns ONE python3, N sequential hook_get_field calls spawn N —
#     measured with a counting python3 PATH shim that execs the real interpreter.
# Plus behavior-parity for the two migrated callers (post-edit-typecheck.sh, advisory-subagent-budget.sh),
# and the hook_is_subagent origin read: an unreadable envelope is never read as an absent agent_id.
#
# Run via: bats hooks/test/hook-utils-fields.bats
# Hermetic: a WORK sandbox holds the shim + fixtures; no live monitor/DB/~/.claude state is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/hooks/hook-utils.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

# Field-kind fixture — one input string exercising every str()/rstrip parity edge in one parse.
#   special = leading+trailing spaces + escaped quote + backslash + non-ASCII (café)
#   nl      = embedded newline (preserved) · trail = trailing newlines (stripped to mirror $())
FIXTURE_JSON='{"plain":"hello","num":5,"flag":true,"nul":null,"obj":{"a":1},"special":"  q\"x\\y café  ","nl":"line1\nline2","trail":"keep\n\n","empty":""}'

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "hook-utils.sh not found: ${REAL_LIB}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  WORK="$(mktemp -d -t hook-utils-fields.XXXXXX)"
  REAL_PY="$(command -v python3)"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# Install a counting python3 shim into WORK/bin that records one byte per invocation then execs the
# real interpreter (so JSON parsing still works while the spawn count is observable via WORK/pycount).
make_counting_python3() {
  mkdir -p "${WORK}/bin"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf x >>%q\n' "${WORK}/pycount"
    printf 'exec %q "$@"\n' "${REAL_PY}"
  } >"${WORK}/bin/python3"
  chmod +x "${WORK}/bin/python3"
}

# A python3 on PATH that fails before reading anything — the interpreter-present misread.
make_failing_python3() {
  mkdir -p "${WORK}/failpy"
  printf '#!/usr/bin/env bash\nexit 1\n' >"${WORK}/failpy/python3"
  chmod +x "${WORK}/failpy/python3"
}

# hook_is_subagent's exit status on $2, run with python3 per $1: real · absent · failing.
is_subagent_status() {
  local python="${1}" json="${2}" path="${PATH}"
  case "${python}" in
    absent)
      mkdir -p "${WORK}/nopy"
      path="${WORK}/nopy"
      ;;
    failing)
      make_failing_python3
      path="${WORK}/failpy:${PATH}"
      ;;
    *) : ;;
  esac
  # Strict mode + an ERR trap, as in a hook: a misread must not fire the caller's trap.
  # PATH narrows after bash is found, as in the python3-absent row above.
  # SC2016: the inner $1/$2/$3 are the child bash's own positionals — no expansion here.
  # shellcheck disable=SC2016
  bash -c '
    set -Eeuo pipefail
    trap "printf \"ERR trap fired\\n\" >&2" ERR
    # shellcheck source=/dev/null
    source "$1"
    export PATH="$2"
    if hook_is_subagent "$3"; then status=0; else status=$?; fi
    printf "%s\n" "${status}"
  ' _ "${REAL_LIB}" "${path}" "${json}" 2>&1
}

# Byte count of the spawn-counter file (0 when absent — avoids the grep -c zero trap).
py_spawn_count() {
  [[ -f "${WORK}/pycount" ]] || {
    printf '0\n'
    return 0
  }
  wc -c <"${WORK}/pycount" | tr -d ' '
}

@test "parity: batch value is byte-identical to hook_get_field across every field kind" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local -a fields=(plain missing num flag nul obj special nl trail empty)
  local -a got=()
  local v
  while IFS= read -r -d '' v; do got+=("$v"); done \
    < <(hook_get_fields "${FIXTURE_JSON}" "${fields[@]}" || true)
  [[ "${#got[@]}" -eq "${#fields[@]}" ]] || return 1

  local i=0 f exp
  for f in "${fields[@]}"; do
    exp="$(hook_get_field "${FIXTURE_JSON}" "${f}")"
    [[ "${got[$i]}" == "${exp}" ]] || {
      printf 'mismatch on %s: batch=[%s] single=[%s]\n' "${f}" "${got[$i]}" "${exp}" >&2
      return 1
    }
    i=$((i + 1))
  done
}

@test "parity spot-checks: type coercion + trailing-newline strip + embedded-newline keep" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local -a got=()
  local v
  while IFS= read -r -d '' v; do got+=("$v"); done \
    < <(hook_get_fields "${FIXTURE_JSON}" num flag nul obj trail nl special || true)
  [[ "${got[0]}" == "5" ]] || return 1                 # number → str()
  [[ "${got[1]}" == "True" ]] || return 1              # JSON true → Python True (matches print())
  [[ "${got[2]}" == "None" ]] || return 1              # JSON null → None
  [[ "${got[3]}" == "{'a': 1}" ]] || return 1          # nested object → dict str()
  [[ "${got[4]}" == "keep" ]] || return 1              # "keep\n\n" → trailing newlines stripped
  [[ "${got[5]}" == "line1"$'\n'"line2" ]] || return 1 # embedded newline preserved
  [[ "${got[6]}" == "  q\"x\\y café  " ]] || return 1  # spaces + quote + backslash + unicode intact
}

@test "parity: embedded-NUL value stripped → batch byte-identical to hook_get_field (no truncation)" {
  # Regression guard for the NUL-truncation divergence. A JSON string CAN hold \u0000 — json.load
  # decodes it to a REAL NUL, the very delimiter the `IFS= read -r -d ''` consumer stops on.
  # hook_get_field captures via $() which DROPS NUL bytes → "os.system(x)"; the batch emitter must
  # .replace('\x00','') to match. Pre-fix the un-stripped NUL split the batch stream: nulval read
  # TRUNCATED to "os." and the trailing NUL fragment shifted every later field — so got had 3 elems
  # (not 2) and got[0] != the $()-capture. This asserts BOTH: parity of the value AND that the field
  # AFTER nulval still arrives intact (the delimiter stream was not corrupted).
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local json='{"nulval":"os.\u0000system(x)","after":"present"}'
  local -a got=()
  local v
  while IFS= read -r -d '' v; do got+=("$v"); done \
    < <(hook_get_fields "${json}" nulval after || true)
  [[ "${#got[@]}" -eq 2 ]] || {
    printf 'expected 2 fields, got %s (NUL split the stream?): %s\n' "${#got[@]}" "${got[*]}" >&2
    return 1
  }
  local exp
  exp="$(hook_get_field "${json}" nulval)"
  [[ "${got[0]}" == "${exp}" ]] || {
    printf 'batch=[%s] single=[%s]\n' "${got[0]}" "${exp}" >&2
    return 1
  }
  [[ "${got[0]}" == "os.system(x)" ]] || return 1 # NUL removed, surrounding text preserved
  [[ "${got[1]}" == "present" ]] || return 1       # field after the NUL value still intact
}

@test "perf invariant: hook_get_fields spawns exactly ONE python3 for N fields" {
  make_counting_python3
  : >"${WORK}/pycount"
  run env PATH="${WORK}/bin:${PATH}" bash -c '
    # shellcheck source=/dev/null
    source "$1"
    while IFS= read -r -d "" _v; do :; done < <(hook_get_fields "{\"a\":1,\"b\":2,\"c\":3,\"d\":4}" a b c d || true)
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(py_spawn_count)" -eq 1 ]] || return 1
}

@test "perf baseline: N sequential hook_get_field calls spawn N python3 (the cost this replaces)" {
  make_counting_python3
  : >"${WORK}/pycount"
  run env PATH="${WORK}/bin:${PATH}" bash -c '
    # shellcheck source=/dev/null
    source "$1"
    for f in a b c d; do hook_get_field "{\"a\":1,\"b\":2,\"c\":3,\"d\":4}" "$f" >/dev/null; done
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(py_spawn_count)" -eq 4 ]] || return 1
}

@test "fail-open: python3 absent → N empty values (parity with N× hook_get_field empties)" {
  mkdir -p "${WORK}/nopy"
  # Let bats resolve bash via the ambient PATH, then strip PATH INSIDE the body (source + the batch
  # path are all builtins) — `env PATH=<nopy> bash` would fail bash's own lookup (exit 127) instead.
  run bash -c '
    # shellcheck source=/dev/null
    source "$1"
    export PATH="$2"
    declare -a got=()
    while IFS= read -r -d "" v; do got+=("$v"); done < <(hook_get_fields "{\"a\":\"x\"}" a b || true)
    printf "count=%s\n" "${#got[@]}"
    [[ -z "${got[0]}" && -z "${got[1]}" ]] && printf "empties=yes\n"
  ' _ "${REAL_LIB}" "${WORK}/nopy"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"count=2"* ]] || return 1
  [[ "${output}" == *"empties=yes"* ]] || return 1
}

@test "fail-open: malformed JSON → N empty values, matching hook_get_field" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local bad='{not valid json'
  local -a got=()
  local v
  while IFS= read -r -d '' v; do got+=("$v"); done < <(hook_get_fields "${bad}" a b || true)
  [[ "${#got[@]}" -eq 2 ]] || return 1
  [[ "${got[0]}" == "$(hook_get_field "${bad}" a)" ]] || return 1
  [[ "${got[1]}" == "$(hook_get_field "${bad}" b)" ]] || return 1
  [[ -z "${got[0]}" && -z "${got[1]}" ]] || return 1
}

@test "fail-open: non-object root (JSON array) → N empty values, matching hook_get_field" {
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  local arr='[1,2,3]'
  local -a got=()
  local v
  while IFS= read -r -d '' v; do got+=("$v"); done < <(hook_get_fields "${arr}" a b || true)
  [[ "${#got[@]}" -eq 2 ]] || return 1
  [[ "${got[0]}" == "$(hook_get_field "${arr}" a)" ]] || return 1
  [[ "${got[1]}" == "$(hook_get_field "${arr}" b)" ]] || return 1
}

@test "zero fields requested → no output, return 0 (no python3 spawn)" {
  make_counting_python3
  : >"${WORK}/pycount"
  run env PATH="${WORK}/bin:${PATH}" bash -c '
    # shellcheck source=/dev/null
    source "$1"
    out="$(hook_get_fields "{\"a\":1}" || true)"
    printf "len=%s\n" "${#out}"
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"len=0"* ]] || return 1
  [[ "$(py_spawn_count)" -eq 0 ]] || return 1
}

@test "origin: only a readable envelope without agent_id reads as main session, never a misread one" {
  # Row: name|python3|envelope|expected status (0 = not main session, 1 = main session).
  local -a cases=(
    'agent_id present|real|{"agent_id":"a1","session_id":"s"}|0'
    'agent_id absent from a readable object|real|{"session_id":"s"}|1'
    'agent_id empty|real|{"agent_id":"","session_id":"s"}|1'
    'empty object, the hook_read_input fallback|real|{}|1'
    'malformed JSON|real|{"session_id":"s"|0'
    'non-object root|real|[{"session_id":"s"}]|0'
    'python3 absent|absent|{"session_id":"s"}|0'
    'python3 failing|failing|{"session_id":"s"}|0'
  )
  local row name python json want got
  for row in "${cases[@]}"; do
    IFS='|' read -r name python json want <<<"${row}"
    got="$(is_subagent_status "${python}" "${json}")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: status ${got}, want ${want}"
      return 1
    }
  done
}

@test "migrated post-edit-typecheck.sh: batch EVENT+SESSION_ID still drive marker + Stop routing" {
  command -v git >/dev/null 2>&1 || skip "git required"
  local repo="${WORK}/repo" markers="${WORK}/markers"
  mkdir -p "${repo}" "${markers}"
  git -C "${repo}" init -q
  printf '{}\n' >"${repo}/tsconfig.json"

  # PostToolUse(Edit) on a .ts file → EVENT routes to record_marker, keyed by SESSION_ID.
  local ptu
  ptu="{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"sessX\",\"tool_input\":{\"file_path\":\"${repo}/a.ts\"}}"
  run env TYPECHECK_MARKER_DIR="${markers}" bash "${GA}/hooks/post-edit-typecheck.sh" <<<"${ptu}"
  [[ "${status}" -eq 0 ]] || return 1
  # Exact filename proves SESSION_ID="sessX" was extracted; existence proves EVENT="PostToolUse" routing.
  [[ -f "${markers}/typecheck-pending_sessX.json" ]] || return 1
  grep -q '"roots"' "${markers}/typecheck-pending_sessX.json" || return 1

  # Stop with the SAME session_id → EVENT routes to run_pending_typechecks; marker read then removed.
  run env TYPECHECK_MARKER_DIR="${markers}" TYPECHECK_DRY_RUN=1 \
    bash "${GA}/hooks/post-edit-typecheck.sh" <<<'{"hook_event_name":"Stop","session_id":"sessX"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"DRY-RUN"* ]] || return 1
  [[ "${output}" == *"root="* ]] || return 1
  [[ ! -f "${markers}/typecheck-pending_sessX.json" ]] || return 1
}

@test "migrated advisory-subagent-budget.sh: batch transcript_path recovers agent_type at crossing" {
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  local budget_dir="${WORK}/counters" rows="${WORK}/rows" stub="${WORK}/stub-writer.sh"
  mkdir -p "${budget_dir}" "${WORK}/tx"
  {
    printf '#!/bin/bash\n'
    printf 'cat >>%q\n' "${rows}"
    printf 'exit 0\n'
  } >"${stub}"
  chmod +x "${stub}"
  printf '{"agentType":"glass-atrium-dev-shell"}\n' >"${WORK}/tx/agent-agC.meta.json"
  printf '39\n' >"${budget_dir}/agC" # next call = 40 = the 100% crossing → sidecar recovery fires

  local input
  input="{\"agent_id\":\"agC\",\"transcript_path\":\"${WORK}/tx/transcript.jsonl\",\"session_id\":\"s1\"}"
  run env SUBAGENT_TOOL_BUDGET_DIR="${budget_dir}" SUBAGENT_OVERAGE_WRITER="${stub}" \
    bash "${GA}/hooks/advisory-subagent-budget.sh" <<<"${input}"
  [[ "${status}" -eq 0 ]] || return 1
  # agent_type reached the row ONLY if the batch-extracted transcript_path found the sidecar.
  grep -q '"agent_type": "glass-atrium-dev-shell"' "${rows}" || return 1
}

# F7 guard — the hook_require_python3 comment publishes a derivation recipe whose grep would
# self-match hook-utils.sh, the file DEFINING the function; the -v exclusion is what keeps the
# definer out of the caller set, so its presence is the invariant worth asserting.
#
# Not hook-invocation coverage: this asserts a documentation invariant over the repo. The
# direct-command-execution rule governs rows that exercise hook BEHAVIOR (where an interpreter
# prefix would bypass the executable bit); no hook is executed here, so that rule has nothing to bind.
@test "F7: hook_require_python3 comment's derivation recipe excludes the definer" {
  grep -q "grep -v hook-utils.sh" "${REAL_LIB}" || return 1
}
