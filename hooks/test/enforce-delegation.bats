#!/usr/bin/env bats
# enforce-delegation.bats — Bats suite for the PreToolUse(Write|Edit) delegation
#   gate. Pins the block-ALL-orchestrator-direct-writes contract (path-independent;
#   basename + */memory/* session-state exempt), with focus on the FIX-MEM tightening: a "memory/" segment nested
#   directly under a protected harness dir (agents/, rules/, hooks/, skills/,
#   autoagent/, monitor/, scripts/) MUST stay BLOCKED, while a legitimate
#   session-state memory root still PASSES.
#
# Decision channel = exit code only (PreToolUse): exit 0 PASS / exit 2 BLOCK.
# 격리: agent_id 부재 → 메인 세션(오케스트레이터)로 평가. stdin 으로 합성 JSON 주입.
#   라이브 hook input 미의존.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-delegation.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-delegation.sh not found: ${HOOK_SH}"
  source "${BATS_TEST_DIRNAME}/lib/no-python3.bash"
  export DELEGATION_MONITOR_URL="http://127.0.0.1:9/api/clauded-docs"
  # Harness roots are anchored at HOME: the /Users/x/... rows below are harness paths under it.
  export HOME="/Users/x"
}

# Drive the hook as the orchestrator (no agent_id) with a synthetic Write input.
# Args: $1 = file_path. Captures the exit status via Bats `run`.
write_as_orchestrator() {
  run bash -c '
    printf "%s" "{\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2"
  ' _ "${1}" "${HOOK_SH}"
}

# BLOCKED: protected harness dir with a nested memory/ segment (FIX-MEM)

@test "agents/memory/x.md → BLOCKED (agent prompt surface, not session-state)" {
  write_as_orchestrator "/Users/x/.claude/agents/memory/x.md"
  [[ "${status}" -ne 0 ]]
}

@test "rules/memory/x.md → BLOCKED (rule SoT surface)" {
  write_as_orchestrator "/Users/x/.claude/rules/memory/x.md"
  [[ "${status}" -ne 0 ]]
}

@test "hooks/memory/x.sh → BLOCKED (hook surface)" {
  write_as_orchestrator "/Users/x/.claude/hooks/memory/x.sh"
  [[ "${status}" -ne 0 ]]
}

@test "skills/memory/x.md → BLOCKED (skill surface)" {
  write_as_orchestrator "/Users/x/.claude/skills/memory/x.md"
  [[ "${status}" -ne 0 ]]
}

@test "autoagent/memory/x.py → BLOCKED (self-improvement core surface)" {
  write_as_orchestrator "/Users/x/.claude/autoagent/memory/x.py"
  [[ "${status}" -ne 0 ]]
}

@test "monitor/memory/x.ts → BLOCKED (monitor surface)" {
  write_as_orchestrator "/Users/x/.claude/monitor/memory/x.ts"
  [[ "${status}" -ne 0 ]]
}

@test "scripts/memory/x.sh → BLOCKED (scripts surface)" {
  write_as_orchestrator "/Users/x/.claude/scripts/memory/x.sh"
  [[ "${status}" -ne 0 ]]
}

# BLOCKED: traversal cannot spoof a session-state memory root

@test "agents/memory/../x.md traversal → BLOCKED (normalizes to agents/x.md)" {
  write_as_orchestrator "/Users/x/.claude/agents/memory/../scope-dev.md"
  [[ "${status}" -ne 0 ]]
}

@test "memory/../hooks/x.sh traversal → BLOCKED (segment cannot be forged via ..)" {
  write_as_orchestrator "/Users/x/.claude/memory/../hooks/enforce-delegation.sh"
  [[ "${status}" -ne 0 ]]
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

# BLOCKED: a plain harness-config write (no memory segment) — regression guard

@test "rules/scope-dev.md → BLOCKED (plain harness config, no memory exception)" {
  write_as_orchestrator "/Users/x/.claude/rules/scope-dev.md"
  [[ "${status}" -ne 0 ]]
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

# H-3: python3-absent fail-closed (extraction degrades to EMPTY)
# Without python3, hook_get_tool_input returns empty → the legacy
# `[[ -z FILE_PATH ]] && exit 0` would ALLOW an orchestrator harness write. The
# fix blocks on non-trivial input but must NOT over-block genuinely-empty input.

# Shared fixture: lib/no-python3.bash (sourced in setup). Args: $1 = raw JSON stdin.
run_with_no_python3() { run_hook_with_no_python3 "${HOOK_SH}" "${1}"; }

@test "python3 absent + orchestrator harness write → BLOCKED (H-3 fail-closed)" {
  run_with_no_python3 '{"tool_input":{"file_path":"/Users/x/.claude/rules/scope-dev.md"}}'
  [[ "${status}" -ne 0 ]]
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
# stderr into $output so the emit_error JSON (DEL-003 / DEL-001) is assertable. Multi-assertion
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

@test "T4 AC3 well-formed blocked path → exit 2 with DEL-001 (drift path did not cannibalize the block)" {
  run_raw_envelope '{"tool_input":{"file_path":"/Users/x/.claude/rules/scope-dev.md"}}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"DEL-001"* ]] || return 1
}

# Orchestrator direct work: a tiny edit passes, while harness, sensitive, new-document and
# implementing-plan targets stay blocked. Hermetic: the monitor is a curl PATH shim serving the
# list from LIST_JSON_FILE and each plan from DOC_JSON_DIR/<id>.json; any other URL fails.

setup_monitor() {
  WORK="$(mktemp -d)"
  mkdir -p "${WORK}/bin" "${WORK}/docs" "${WORK}/src"
  export LIST_JSON_FILE="${WORK}/list.json" DOC_JSON_DIR="${WORK}/docs"
  printf '%s\n' '{"total":0,"rows":[]}' >"${LIST_JSON_FILE}"
  cat >"${WORK}/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""
for a in "$@"; do
  case "${a}" in
    http*) url="${a}" ;;
  esac
done
case "${url}" in
  */clauded-docs\?*) cat "${LIST_JSON_FILE}" ;;
  */clauded-docs/*)
    doc="${DOC_JSON_DIR}/${url##*/}.json"
    [[ -f "${doc}" ]] || exit 22
    cat "${doc}"
    ;;
  *) exit 22 ;;
esac
SH
  chmod +x "${WORK}/bin/curl"
  export PATH="${WORK}/bin:${PATH}"
  : >"${WORK}/src/existing.sh"
  : >"${WORK}/src/owned.sh"
  : >"${WORK}/notes.md"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

# Serve one implementing plan. Args: $1=id  $2=format  $3=body (JSON string contents).
seed_plan() {
  printf '{"id":%s,"format":"%s","body":"%s"}\n' "${1}" "${2}" "${3}" >"${DOC_JSON_DIR}/${1}.json"
}

# Orchestrator write with stderr merged, so the emitted error code is assertable. Args: $1=file_path.
write_capturing() {
  run bash -c '
    printf "%s" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2" 2>&1
  ' _ "${1}" "${HOOK_SH}"
}

@test "an orchestrator edit to an existing code file passes when no implementing plan lists it" {
  setup_monitor
  printf '%s\n' '{"total":1,"rows":[{"id":7,"doc_status":"implementing"}]}' >"${LIST_JSON_FILE}"
  local rows=(
    "another file listed|## Target Files\\n- \`hooks/other.sh\` — not this file\\n## Next\\n"
    "file named only in prose under the list|## Target Files\\n- \`hooks/other.sh\`\\nSee \`src/existing.sh\` for context.\\n"
    "plan declares no Target Files|## Goal\\nno list here\\n"
    "list holds no path-like item|## Target Files\\n- none\\n- \`.\`\\n"
  )
  local row name body
  for row in "${rows[@]}"; do
    IFS='|' read -r name body <<<"${row}"
    seed_plan 7 md "${body}"
    write_capturing "${WORK}/src/existing.sh"
    [[ "${status}" -eq 0 ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "an orchestrator edit to an existing markdown document passes" {
  setup_monitor
  write_capturing "${WORK}/notes.md"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
}

@test "an orchestrator write creating a new code file passes" {
  setup_monitor
  write_capturing "${WORK}/src/new-helper.sh"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
}

@test "a subagent write to a sensitive or plan-owned path passes as before" {
  setup_monitor
  run bash -c '
    printf "%s" "{\"agent_id\":\"a1\",\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2" 2>&1
  ' _ "${WORK}/.env" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
}

@test "harness paths stay blocked for the orchestrator, symlinked ones included" {
  setup_monitor
  export HOME="${WORK}"
  mkdir -p "${WORK}/.claude/agents"
  : >"${WORK}/.claude/agents/x.md"
  ln -s "${WORK}/.claude" "${WORK}/dirlink"
  ln -s "${WORK}/.claude/agents/x.md" "${WORK}/filelink.md"
  local rows=(
    "profile dir|${WORK}/.claude-work/settings.json"
    "live install root|${WORK}/.glass-atrium/hooks/enforce-delegation.sh"
    "directory symlink into a harness dir|${WORK}/dirlink/agents/x.md"
    "file symlink into a harness dir|${WORK}/filelink.md"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-001"* && "${output}" == *"harness"* ]] \
      || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "sensitive files stay blocked for the orchestrator" {
  setup_monitor
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

@test "an orchestrator write creating a new document file stays blocked as authoring" {
  setup_monitor
  local rows=(
    "markdown|${WORK}/report.md"
    "html upper-case extension|${WORK}/plan.HTML"
    "htm|${WORK}/spec.htm"
    "markdown in a new dir|${WORK}/docs-new/adr.md"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-005"* && "${output}" == *"intel-"* ]] \
      || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "a Target File of an implementing plan stays blocked, naming the plan" {
  setup_monitor
  local rows=(
    "md plan, backticked entry|md|## Target Files\\n- \`src/owned.sh\` — owned by the plan\\n## Next\\n"
    "html plan|html|<section id=\\\"target-files\\\"><ul><li>src/owned.sh</li></ul></section>"
  )
  local row name format body
  for row in "${rows[@]}"; do
    IFS='|' read -r name format body <<<"${row}"
    printf '%s\n' '{"total":2,"rows":[{"id":7,"doc_status":"implementing"},{"id":8,"doc_status":"implementing"}]}' \
      >"${LIST_JSON_FILE}"
    seed_plan 7 md '## Target Files\n- `hooks/other.sh`\n'
    seed_plan 8 "${format}" "${body}"
    write_capturing "${WORK}/src/owned.sh"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-006"* && "${output}" == *"clauded-docs/8"* ]] \
      || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "an unreadable implementing-plan list blocks the orchestrator edit (fail closed)" {
  setup_monitor
  local rows=(
    "monitor refused|list|"
    "malformed list|list|not json"
    "no rows array|list|{\"total\":0}"
    "page shorter than total|list|{\"total\":3,\"rows\":[]}"
    "plan GET fails|list|{\"total\":1,\"rows\":[{\"id\":99,\"doc_status\":\"implementing\"}]}"
    "plan GET body not JSON|plan|not json"
    "unknown plan format|plan|{\"id\":5,\"format\":\"pdf\",\"body\":\"x\"}"
  )
  local row name kind value
  for row in "${rows[@]}"; do
    IFS='|' read -r name kind value <<<"${row}"
    export LIST_JSON_FILE="${WORK}/list.json"
    if [[ "${kind}" == list && -z "${value}" ]]; then
      LIST_JSON_FILE="${WORK}/absent.json"
    elif [[ "${kind}" == list ]]; then
      printf '%s\n' "${value}" >"${LIST_JSON_FILE}"
    else
      printf '%s\n' '{"total":1,"rows":[{"id":5,"doc_status":"implementing"}]}' >"${LIST_JSON_FILE}"
      printf '%s\n' "${value}" >"${DOC_JSON_DIR}/5.json"
    fi
    write_capturing "${WORK}/src/existing.sh"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-007"* ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "curl absent blocks the orchestrator edit (fail closed)" {
  setup_monitor
  local bindir
  bindir="$(minimal_bin_without_python3 bash cat grep basename tr sed env mktemp dirname python3 jq readlink)"
  run env "PATH=${bindir}" bash -c '
    printf "%s" "{\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$2" 2>&1
  ' _ "${WORK}/src/existing.sh" "${HOOK_SH}"
  [[ "${status}" -eq 2 && "${output}" == *"DEL-007"* ]] || { echo "exit ${status}: ${output}"; return 1; }
}

@test "a symlink chain into a harness dir stays blocked at every hop, a loop included" {
  setup_monitor
  export HOME="${WORK}/home"
  mkdir -p "${HOME}/.claude/agents"
  : >"${HOME}/.claude/settings.json"
  ln -s "${HOME}/.claude/settings.json" "${WORK}/hop2"
  ln -s hop2 "${WORK}/hop1"
  ln -s "${HOME}/.claude" "${WORK}/dirhop2"
  ln -s dirhop2 "${WORK}/dirhop1"
  ln -s "${HOME}/.claude-new" "${WORK}/danglehop2"
  ln -s danglehop2 "${WORK}/danglehop1"
  ln -s loopb "${WORK}/loopa"
  ln -s loopa "${WORK}/loopb"
  local rows=(
    "two file hops|${WORK}/hop1"
    "two directory hops|${WORK}/dirhop1/agents/x.md"
    "dangling directory link chain|${WORK}/danglehop1/settings.json"
    "link loop|${WORK}/loopa"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-001"* ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "a project's own .claude dir is not a harness path" {
  setup_monitor
  export HOME="${WORK}/home"
  mkdir -p "${HOME}" "${WORK}/proj/.claude/worktrees/wt/hooks"
  : >"${WORK}/proj/.claude/worktrees/wt/hooks/foo.sh"
  write_capturing "${WORK}/proj/.claude/worktrees/wt/hooks/foo.sh"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status}: ${output}"; return 1; }
}

@test "a Target File binds only a path-like token, by whole-component suffix, never a basename or substring" {
  setup_monitor
  mkdir -p "${WORK}/repo/hooks" "${WORK}/repo/skills" "${WORK}/repo/myskills"
  local f
  for f in README.md hooks/foo.sh hooks/foo.sh.bak skills/x.md myskills/x.md abs.sh; do
    : >"${WORK}/repo/${f}"
  done
  printf '%s\n' '{"total":1,"rows":[{"id":9,"doc_status":"implementing"}]}' >"${LIST_JSON_FILE}"
  seed_plan 9 md '## Target Files\n- `README.md`\n'
  write_capturing "${WORK}/repo/README.md"
  [[ "${status}" -eq 0 ]] || { echo "plan listing only a bare README.md: exit ${status}: ${output}"; return 1; }
  seed_plan 9 md "## Target Files\\n- \`README.md\`\\n- \`hooks/foo.sh\`\\n- \`skills/\`\\n- \`${WORK}/repo/abs.sh\`\\n"
  local rows=(
    "bare basename binds nothing|0|README.md"
    "file token|2|hooks/foo.sh"
    "file token is no prefix of a longer name|0|hooks/foo.sh.bak"
    "directory token|2|skills/x.md"
    "directory token only at a component boundary|0|myskills/x.md"
    "absolute entry|2|abs.sh"
  )
  local row name want path
  for row in "${rows[@]}"; do
    IFS='|' read -r name want path <<<"${row}"
    write_capturing "${WORK}/repo/${path}"
    [[ "${status}" -eq "${want}" ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
    [[ "${want}" -eq 0 || "${output}" == *"DEL-006"* ]] || { echo "${name}: ${output}"; return 1; }
  done
}

@test "a project's .claude/settings*.json is hook wiring and stays blocked" {
  setup_monitor
  export HOME="${WORK}/home"
  mkdir -p "${HOME}" "${WORK}/proj/.claude/worktrees/wt/.claude"
  local f
  for f in proj/.claude/settings.json proj/.claude/settings.local.json \
    proj/.claude/worktrees/wt/.claude/settings.json; do
    : >"${WORK}/${f}"
  done
  ln -s "${WORK}/proj/.claude/settings.json" "${WORK}/settings-link.json"
  local rows=(
    "project settings.json|proj/.claude/settings.json"
    "project settings.local.json|proj/.claude/settings.local.json"
    "a worktree checkout's own settings.json|proj/.claude/worktrees/wt/.claude/settings.json"
    "symlink to a project settings.json|settings-link.json"
  )
  local row name path
  for row in "${rows[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    write_capturing "${WORK}/${path}"
    [[ "${status}" -eq 2 && "${output}" == *"DEL-001"* ]] || { echo "${name}: exit ${status}: ${output}"; return 1; }
  done
}

@test "the install root's physical path stays blocked when ~/.glass-atrium is a symlink" {
  setup_monitor
  export HOME="${WORK}/home"
  mkdir -p "${HOME}" "${WORK}/install/hooks"
  : >"${WORK}/install/hooks/x.sh"
  ln -s "${WORK}/install" "${HOME}/.glass-atrium"
  write_capturing "${WORK}/install/hooks/x.sh"
  [[ "${status}" -eq 2 && "${output}" == *"DEL-001"* ]] || { echo "exit ${status}: ${output}"; return 1; }
}

@test "an unreachable monitor emits one DEL-007 record naming the real cause" {
  setup_monitor
  LIST_JSON_FILE="${WORK}/absent.json"
  write_capturing "${WORK}/src/existing.sh"
  local records
  records="$(printf '%s\n' "${output}" | grep -c 'DEL-007' || true)"
  [[ "${status}" -eq 2 && "${records}" == 1 && "${output}" == *"could not be read"* \
    && "${output}" != *"internal error"* ]] || { echo "exit ${status}, ${records} records: ${output}"; return 1; }
}

@test "an html Target Files section with a nested <section> blocks with one DEL-007 record naming the cause" {
  setup_monitor
  printf '%s\n' '{"total":1,"rows":[{"id":5,"doc_status":"implementing"}]}' >"${LIST_JSON_FILE}"
  seed_plan 5 html '<section id=\"target-files\"><section><h3>x</h3></section><ul><li>src/owned.sh</li></ul></section>'
  write_capturing "${WORK}/src/owned.sh"
  local records
  records="$(printf '%s\n' "${output}" | grep -c 'DEL-007' || true)"
  [[ "${status}" -eq 2 && "${records}" == 1 && "${output}" == *"nested <section>"* \
    && "${output}" == *"clauded-docs/5"* && "${output}" != *"internal error"* ]] \
    || { echo "exit ${status}, ${records} records: ${output}"; return 1; }
}

@test "a memory/ nested under a protected dir name passes outside the harness roots, blocks under one" {
  setup_monitor
  mkdir -p "${WORK}/proj/agents/memory"
  : >"${WORK}/proj/agents/memory/x.md"
  write_capturing "${WORK}/proj/agents/memory/x.md"
  [[ "${status}" -eq 0 ]] || { echo "outside the harness roots: exit ${status}: ${output}"; return 1; }
  write_capturing "/Users/x/.claude/agents/memory/x.md"
  [[ "${status}" -eq 2 && "${output}" == *"DEL-001"* ]] \
    || { echo "under a harness root: exit ${status}: ${output}"; return 1; }
}

@test "the Target Files extractors live once in lib/target-files.sh, sourced by both hooks" {
  local lib="${HOOKS_DIR}/lib/target-files.sh" drift="${HOOKS_DIR}/validate-scope-drift.sh"
  grep -q '^extract_target_files_section() {' "${lib}" \
    && grep -q '^extract_target_files_heading() {' "${lib}" \
    && ! grep -q '^extract_target_files_' "${HOOK_SH}" "${drift}" "${HOOKS_DIR}/lib/scope-match.sh" \
    && grep -qF 'source "${BASH_SOURCE%/*}/lib/target-files.sh"' "${HOOK_SH}" \
    && grep -qF 'source "${BASH_SOURCE%/*}/lib/target-files.sh"' "${drift}"
}
