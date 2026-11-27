#!/usr/bin/env bats
# enforce-delegation.bats — Bats suite for the PreToolUse(Write|Edit) delegation
#   gate: an orchestrator write passes unless it targets a sensitive file. A subagent, an
#   allowed basename and a */memory/*
#   session-state path pass first; a "memory/" nested directly under a protected dir name
#   (agents/, rules/, hooks/, skills/, autoagent/, monitor/, scripts/) gets no session-state
#   exemption, so the later checks decide it.
#
# Decision channel = exit code only (PreToolUse): exit 0 PASS / exit 2 BLOCK.
# 격리: agent_id 부재 → 메인 세션(오케스트레이터)로 평가. stdin 으로 합성 JSON 주입.
#   라이브 hook input 미의존.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-delegation.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-delegation.sh not found: ${HOOK_SH}"
  source "${BATS_TEST_DIRNAME}/lib/no-python3.bash"
  # A fixed HOME keeps the /Users/x/... rows below independent of the runner's home.
  export HOME="/Users/x"
  # Every test sandboxes HOME, so the hook's logs/data land on a per-test root, never the run-wide one.
  export GA_DATA_ROOT="${BATS_TEST_TMPDIR}/data-root"
}

# Drive the hook as the orchestrator (no agent_id) with a synthetic Write input.
# Args: $1 = file_path. Captures the exit status via Bats `run`.
write_as_orchestrator() {
  run bash -c '
    printf "%s" "{\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2"
  ' _ "${1}" "${HOOK_SH}"
}

# PASS: legitimate session-state memory roots stay allowed

@test "personal-dir memory/MEMORY.md → PASS (session-state root)" {
  write_as_orchestrator "/Users/x/.claude-personal/projects/-Users-x/memory/MEMORY.md"
  [[ "${status}" -eq 0 ]]
}

@test "project-level memory/progress.md → PASS (session-state root)" {
  write_as_orchestrator "/Users/x/some-project/memory/progress.md"
  [[ "${status}" -eq 0 ]]
}

@test "memory/ nested under a non-protected dir → PASS (e.g. src/memory/cache.md)" {
  write_as_orchestrator "/Users/x/some-project/src/memory/cache.md"
  [[ "${status}" -eq 0 ]]
}

# PASS: allowed basenames + subagent context (orthogonal guards intact)

@test "CLAUDE.md basename → PASS regardless of harness dir" {
  write_as_orchestrator "/Users/x/.claude/agents/CLAUDE.md"
  [[ "${status}" -eq 0 ]]
}

@test "subagent (agent_id present) → PASS on a protected memory path" {
  run bash -c '
    printf "%s" "{\"agent_id\":\"a1\",\"tool_input\":{\"file_path\":\"/Users/x/.claude/agents/memory/x.md\"}}" | bash "$1"
  ' _ "${HOOK_SH}"
  [[ "${status}" -eq 0 ]]
}

# python3-absent fail-closed (extraction degrades to EMPTY)
# Without python3, hook_get_tool_input returns empty → an empty-path allow would pass an
# orchestrator sensitive-file write unjudged. Non-empty input blocks; genuinely-empty input passes.

# Shared fixture: lib/no-python3.bash (sourced in setup). Args: $1 = raw JSON stdin.
run_with_no_python3() { run_hook_with_no_python3 "${HOOK_SH}" "${1}"; }

@test "python3 absent + a non-empty orchestrator write blocks before any path is judged" {
  run_with_no_python3 '{"tool_input":{"file_path":"/Users/x/project/.env"}}'
  [[ "${status}" -eq 2 && "${output}" == *"DEL-002"* ]] || { echo "exit ${status}: ${output}"; return 1; }
}

@test "python3 absent + empty stdin → PASS (no over-block of empty input)" {
  run_with_no_python3 ''
  [[ "${status}" -eq 0 ]]
}

@test "python3 absent + '{}' input → PASS (no over-block of empty object)" {
  run_with_no_python3 '{}'
  [[ "${status}" -eq 0 ]]
}

# T4: fail-closed on an UNRECOGNIZED tool_input envelope (host schema drift).
# The value-only extractor collapsed a legitimately-empty field AND a drifted envelope
# (renamed / dropped / non-object tool_input) into a shared empty → the gate read
# empty=ALLOW and disarmed silently + permanently. T4 consumes T3's three-state probe:
# legit-empty keeps today's allow; a real drift emits a distinctly-coded (DEL-003),
# aggregation-visible error and STILL allows (ADR-2 emit-and-allow, not block). These
# rows REQUIRE python3 (the probe classifier) — without it hook_require_python3_unless_empty
# blocks non-empty input at exit 2 upstream, so a drift envelope never reaches the probe.

# Drive the hook with a RAW JSON envelope (renamed keys, non-object, malformed …), merging
# stderr into $output so the emit_error JSON (DEL-003 / DEL-004) is assertable. Multi-assertion
# rows gate via `|| return 1` per line so a mid-body failure fails the test (a bare mid-body
# `[[ ]]` is not aborted by errexit under bash 3.2 on macOS, though bash 5.3 on CI does abort —
# measured, bats 1.13.0 on both legs). Args: $1 = raw JSON stdin.
run_raw_envelope() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required for envelope classification"
  # SC2016: inner $1/$2 are the child bash's OWN positionals — no expansion here.
  # shellcheck disable=SC2016
  run bash -c 'printf "%s" "$1" | bash "$2" 2>&1' _ "${1}" "${HOOK_SH}"
}

@test "T4 AC2 drift (tool_input renamed) → DEL-003 error + exit 0 (loud, not silent disarm)" {
  # A host field rename tool_input → toolInput. The old gate extracted empty and ALLOWed
  # silently (permanently disarmed); now the drift is loud (DEL-003) yet still allows (ADR-2).
  run_raw_envelope '{"tool_name":"Write","toolInput":{"file_path":"/Users/x/.claude/rules/scope-dev.md"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"DEL-003"* ]] || return 1
}

@test "T4 AC2 drift (tool_input non-object) → DEL-003 error + exit 0" {
  run_raw_envelope '{"tool_input":"a string, not an object"}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"DEL-003"* ]] || return 1
}

@test "T4 AC2 drift (malformed JSON) → DEL-003 error + exit 0" {
  run_raw_envelope '{not valid json'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"DEL-003"* ]] || return 1
}

@test "T4 distinctness: legitimately-empty field → silent allow (exit 0, NO DEL-003)" {
  # tool_input is an object, file_path absent → keep today's allow WITHOUT the drift error.
  run_raw_envelope '{"tool_input":{"other":"x"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"DEL-003"* ]] || return 1
}

@test "T4 degenerate empty object '{}' (python3 present) → silent allow (nothing to guard, no drift)" {
  # "{}" is the input-empty carve-out (nothing to guard), NOT a drift → no DEL-003 noise.
  run_raw_envelope '{}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"DEL-003"* ]] || return 1
}

@test "a well-formed sensitive path still blocks beside the drift branch" {
  run_raw_envelope '{"tool_input":{"file_path":"/Users/x/project/.env"}}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"DEL-004"* ]] || return 1
}

# Orchestrator direct work: every write passes except a sensitive target.

setup_work() {
  WORK="$(mktemp -d)"
  mkdir -p "${WORK}/src"
  : >"${WORK}/src/existing.sh"
  : >"${WORK}/notes.md"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

# Orchestrator write with stderr merged, so the emitted error code is assertable. Args: $1=file_path.
write_capturing() {
  run bash -c '
    printf "%s" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2" 2>&1
  ' _ "${1}" "${HOOK_SH}"
}

@test "an orchestrator write that is not sensitive passes with no record, a new document included" {
  setup_work
  local rows=(
    "existing code file|${WORK}/src/existing.sh"
    "new markdown document|${WORK}/report.md"
    "new html document, upper-case extension|${WORK}/plan.HTML"
    "new document in a new dir|${WORK}/docs-new/adr.md"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 0 && -z "${output}" ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "an orchestrator edit to an existing markdown document passes" {
  setup_work
  write_capturing "${WORK}/notes.md"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
}

@test "an orchestrator write creating a new code file passes" {
  setup_work
  write_capturing "${WORK}/src/new-helper.sh"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
}

@test "a subagent write to a sensitive path passes" {
  setup_work
  run bash -c '
    printf "%s" "{\"agent_id\":\"a1\",\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2" 2>&1
  ' _ "${WORK}/.env" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
}

@test "a symlink to a sensitive file or into a sensitive dir stays blocked by its physical path" {
  setup_work
  mkdir -p "${WORK}/home/.ssh"
  : >"${WORK}/home/.ssh/config"
  : >"${WORK}/.env"
  ln -s "${WORK}/home/.ssh" "${WORK}/dirlink"
  ln -s "${WORK}/home/.ssh/config" "${WORK}/filelink.txt"
  ln -s "${WORK}/.env" "${WORK}/src/settings.sh"
  local rows=(
    "directory symlink into a sensitive dir|${WORK}/dirlink/config"
    "file symlink into a sensitive dir|${WORK}/filelink.txt"
    "file symlink to a dotenv file|${WORK}/src/settings.sh"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-004"* ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "sensitive files stay blocked for the orchestrator" {
  setup_work
  local rows=(
    "dotenv|${WORK}/.env"
    "dotenv variant|${WORK}/.env.local"
    "envrc|${WORK}/.envrc"
    "credentials file|${WORK}/credentials.json"
    "secrets file|${WORK}/secrets.yaml"
    "ssh private key|${WORK}/id_ed25519"
    "pem key|${WORK}/server.pem"
    "key file|${WORK}/tls.key"
    "ssh dir|/Users/x/.ssh/config"
    "aws dir|/Users/x/.aws/config"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-004"* ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "a symlink chain to a sensitive path stays blocked at every hop, an unresolvable loop included" {
  setup_work
  local home="${WORK}/home"
  mkdir -p "${home}/.ssh"
  : >"${home}/.ssh/config"
  ln -s "${home}/.ssh/config" "${WORK}/hop2"
  ln -s hop2 "${WORK}/hop1"
  ln -s "${home}/.ssh" "${WORK}/dirhop2"
  ln -s dirhop2 "${WORK}/dirhop1"
  ln -s "${home}/.aws" "${WORK}/danglehop2"
  ln -s danglehop2 "${WORK}/danglehop1"
  ln -s loopb "${WORK}/loopa"
  ln -s loopa "${WORK}/loopb"
  local rows=(
    "two file hops|${WORK}/hop1"
    "two directory hops|${WORK}/dirhop1/known_hosts"
    "dangling directory link chain|${WORK}/danglehop1/config"
    "link loop|${WORK}/loopa"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-004"* ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "a relative path cannot be judged against the sensitive-file rule and blocks (fail closed)" {
  setup_work
  write_capturing "src/existing.sh"
  [[ "${status}" -eq 2 && "${output}" == *"DEL-004"* && "${output}" == *"relative path"* ]] \
    || { echo "exit ${status}: ${output}"; return 1; }
}

@test "a memory/ nested under a protected dir name gets no session-state exemption, so the sensitive-file check decides it" {
  setup_work
  local rows=(
    "plain memory/ keeps the exemption|0|${WORK}/proj/memory/.env"
    "agents/memory|2|${WORK}/proj/agents/memory/.env"
    "rules/memory|2|${WORK}/proj/rules/memory/.env"
    "hooks/memory|2|${WORK}/proj/hooks/memory/.env"
    "skills/memory|2|${WORK}/proj/skills/memory/.env"
    "autoagent/memory|2|${WORK}/proj/autoagent/memory/.env"
    "monitor/memory|2|${WORK}/proj/monitor/memory/.env"
    "scripts/memory|2|${WORK}/proj/scripts/memory/.env"
  )
  local row name want path
  for row in "${rows[@]}"; do
    IFS='|' read -r name want path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq "${want}" ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
    [[ "${want}" -eq 0 || "${output}" == *"DEL-004"* ]] || { echo "${name}: ${output}"; return 1; }
  done
}

@test "a .. traversal cannot forge a session-state memory/ segment" {
  setup_work
  write_capturing "${WORK}/proj/memory/../hooks/.env"
  [[ "${status}" -eq 2 && "${output}" == *"DEL-004"* ]] || { echo "exit ${status}: ${output}"; return 1; }
}
