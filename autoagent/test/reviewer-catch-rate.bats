#!/usr/bin/env bats
# reviewer-catch-rate.sh contract suite — scoring, run failures, preflight refusals, spawn and session shape.
# Hermetic: a stub launcher stands in for the claude CLI and stub hooks for the live ones, so no model call is made.
#
# Run via: bats autoagent/test/reviewer-catch-rate.bats
# Requires: bats >= 1.5.0, bash 3.2+, jq, python3

# shellcheck disable=SC2154  # BATS_* and run's status/output/stderr are bats-provided
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
ZERO_TOKENS='input=0 output=0 cache_read=0 cache_creation=0'
ZERO_PARENT_TOKENS='parent_input=0 parent_output=0 parent_cache_read=0 parent_cache_creation=0'
ZERO_TOTALS="${ZERO_TOKENS} ${ZERO_PARENT_TOKENS}"

setup() {
  RUNNER="${GA}/autoagent/reviewer-catch-rate.sh"
  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  CONFIG_DIR="${BATS_TEST_TMPDIR}/config"
  CALLER_CONFIG_DIR="${BATS_TEST_TMPDIR}/caller-config"
  CORPUS="${BATS_TEST_TMPDIR}/corpus"
  STUB_LOG_DIR="${BATS_TEST_TMPDIR}/stub-log"
  STUB_REPLY_DIR="${BATS_TEST_TMPDIR}/stub-replies"
  HOOKS_DIR="${BATS_TEST_TMPDIR}/hooks"
  LAUNCHER="${BATS_TEST_TMPDIR}/launcher"
  STUB_KEY_MODE=line1
  mkdir -p "${FAKE_HOME}" "${CORPUS}" "${STUB_LOG_DIR}" "${STUB_REPLY_DIR}"
  write_reviewer_definition "${CONFIG_DIR}" ''
  write_launcher
  write_stub_hooks
  printf '# diff\tdefect\tpattern\n' >"${CORPUS}/labels.tsv"
}

# Unkeyed by default; $2 adds one frontmatter line.
write_reviewer_definition() {
  mkdir -p "${1}/agents"
  {
    printf '%s\n' '---' 'name: glass-atrium-qa-code-reviewer' 'tools: [Read, Glob, Grep, Bash]'
    [[ -z "${2}" ]] || printf '%s\n' "${2}"
    printf '%s\n' '---' '' '# Reviewer body'
  } >"${1}/agents/glass-atrium-qa-code-reviewer.md"
}

# Stub CLI: logs argv, cwd, the tree under it, the prompt, the staged workflow script and diff; fires the hooks
# the cwd's .claude/settings.json wires; writes a parent and a reviewer transcript under the --session-id;
# replays the reply.
# Reply key: the diff's first line (line1, reply replayed raw) or its checksum (cksum, reply wrapped in the relay
# markers, else the diff quoted back); <key>.rc sets the exit status,
# <key>.records replaces the default assistant record, which carries the script's effort option;
# <key>.parent replaces the default usage-free parent record, and <key>.noparent writes no parent transcript;
# <key>.notranscript writes no reviewer transcript, and STUB_CONFIG_OVERRIDE stands in for a launcher that
# hard-sets its own config dir.
write_launcher() {
  cat >"${LAUNCHER}" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" >>"${STUB_LOG_DIR}/argv"
prompt="${!#}" session='' prev=''
for arg in "$@"; do
  [[ "${prev}" != --session-id ]] || session="${arg}"
  prev="${arg}"
done
script="$(printf '%s\n' "${prompt}" | grep -Eo '/[^[:space:]]+\.js' | head -n 1)"
diff_path="$(grep -Eo '/[^[:space:]]+\.diff' -- "${script}" | head -n 1)"
if [[ "${STUB_KEY_MODE}" == cksum ]]; then key="$(cksum <"${diff_path}" | awk '{ print $1 }')"; else key="$(head -n 1 -- "${diff_path}")"; fi
export STUB_KEY="${key}"
pwd -P >"${STUB_LOG_DIR}/cwd-${key}"
(cd -- "${diff_path%/*}" && pwd -P) >"${STUB_LOG_DIR}/stagedir-${key}"
find . >"${STUB_LOG_DIR}/tree-${key}"
printf '%s\n' "${diff_path}" >"${STUB_LOG_DIR}/staged-${key}"
cp -- "${diff_path}" "${STUB_LOG_DIR}/seen-${key}.diff"
cp -- "${script}" "${STUB_LOG_DIR}/script-${key}.js"
printf '%s\n' "${prompt}" >"${STUB_LOG_DIR}/prompt-${key}"
printf '%s\n' "${CLAUDE_CONFIG_DIR}" >"${STUB_LOG_DIR}/config-${key}"
fire() {
  local cmd
  [[ -f .claude/settings.json ]] || return 0
  while IFS='' read -r cmd; do "${cmd}" </dev/null; done < <(jq -r --arg e "${1}" '.hooks[$e][]?.hooks[]?.command' .claude/settings.json)
}
encoded="$(printf '%s' "$(pwd -P)" | tr -c 'A-Za-z0-9' '-')"
config="${STUB_CONFIG_OVERRIDE:-${CLAUDE_CONFIG_DIR}}"
dir="${config}/projects/${encoded}/${session}/subagents/workflows/wf_stub"
mkdir -p "${dir}"
transcript="${dir}/agent-stub.jsonl"
[[ ! -e "${STUB_REPLY_DIR}/${key}.notranscript" ]] || transcript=/dev/null
parent="${config}/projects/${encoded}/${session}.jsonl"
if [[ -f "${STUB_REPLY_DIR}/${key}.parent" ]]; then
  cat -- "${STUB_REPLY_DIR}/${key}.parent" >"${parent}"
elif [[ ! -e "${STUB_REPLY_DIR}/${key}.noparent" ]]; then
  jq -cn '{type: "assistant", message: {role: "assistant", id: "msg_parent", content: [{type: "text", text: "relayed"}]}}' >"${parent}"
fi
context="$(fire SubagentStart | jq -rs 'map(.hookSpecificOutput.additionalContext? // empty) | join("\n")')"
jq -cn --arg c "${context}" '{type: "attachment", attachment: {type: "hook_additional_context", hookEvent: "SubagentStart", content: [$c]}}' >"${transcript}"
if [[ -f "${STUB_REPLY_DIR}/${key}.records" ]]; then
  cat -- "${STUB_REPLY_DIR}/${key}.records" >>"${transcript}"
else
  effort="$(grep -Eo "effort: '[a-z]+'" -- "${script}" | head -n 1 | cut -d "'" -f 2)"
  jq -cn --arg e "${effort}" '{type: "assistant", effort: $e, message: {role: "assistant", id: "msg_default", content: [{type: "text", text: "ok"}]}}' >>"${transcript}"
fi
fire SubagentStop >/dev/null
if [[ "${STUB_KEY_MODE}" != cksum ]]; then
  cat -- "${STUB_REPLY_DIR}/${key}"
else
  printf 'REVIEWER-REPLY-BEGIN\n'
  if [[ -f "${STUB_REPLY_DIR}/${key}" ]]; then
    cat -- "${STUB_REPLY_DIR}/${key}"
  else
    printf '%s\n' '- `[CONSIDER][Risk: L] the change`: quoted back as proposed'
    sed 's/^/    /' "${diff_path}"
  fi
  printf 'REVIEWER-REPLY-END\n'
fi
fire Stop >/dev/null
if [[ -f "${STUB_REPLY_DIR}/${key}.rc" ]]; then exit "$(cat -- "${STUB_REPLY_DIR}/${key}.rc")"; fi
STUB
  chmod +x "${LAUNCHER}"
}

# Every stub hook logs its own name; inject-scope-rules.sh also emits the scope header unless <key>.noinject exists.
write_stub_hooks() {
  local hook n
  mkdir -p "${HOOKS_DIR}"
  # shellcheck disable=SC2016  # the stub hook expands $0 at its own run time
  for n in 01 02 03 04 05 06 07 08 09 10 11 12; do
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${0##*/}" >>"${STUB_LOG_DIR}/hooks"\n' >"${HOOKS_DIR}/inject-scope-part-${n}.sh"
  done
  for hook in track-outcome.sh cost-tracker.sh agent-tracker.sh telemetry-activation.sh; do
    cp -- "${HOOKS_DIR}/inject-scope-part-01.sh" "${HOOKS_DIR}/${hook}"
  done
  cat >"${HOOKS_DIR}/inject-scope-rules.sh" <<'HOOK'
#!/usr/bin/env bash
printf '%s\n' "${0##*/}" >>"${STUB_LOG_DIR}/hooks"
[[ -e "${STUB_REPLY_DIR}/${STUB_KEY}.noinject" ]] && exit 0
printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext": "**Scope rules — part 01 of 12 · auto-injected at spawn for glass-atrium-qa-code-reviewer**"}}'
HOOK
  chmod +x "${HOOKS_DIR}"/*.sh
}

# add_case <key> <defect id> <pattern> <relayed reply> [preamble] — one diff, its label row, its stub reply.
add_case() {
  printf '%s\n' "${1}" '--- a/hooks/x.sh' '+++ b/hooks/x.sh' >"${CORPUS}/${1}.diff"
  printf '%s\t%s\t%s\n' "${1}.diff" "${2}" "${3}" >>"${CORPUS}/labels.tsv"
  printf '%sREVIEWER-REPLY-BEGIN\n%s\nREVIEWER-REPLY-END\n' "${5:+${5}$'\n'}" "${4}" >"${STUB_REPLY_DIR}/${1}"
}

# assistant_record <effort, empty = absent> <message id> [usage JSON] [tool_use input JSON]
assistant_record() {
  jq -cn --arg e "${1}" --arg id "${2}" --argjson u "${3:-null}" --argjson t "${4:-null}" '
    {type: "assistant", message: {role: "assistant", id: $id,
      content: ([{type: "text", text: "ok"}] + (if $t == null then [] else [{type: "tool_use", name: "Read", input: $t}] end))}}
    | if $e == "" then . else .effort = $e end
    | if $u == null then . else .message.usage = $u end'
}

run_runner() {
  run --separate-stderr env \
    HOME="${FAKE_HOME}" \
    CLAUDE_CONFIG_DIR="${CALLER_CONFIG_DIR}" \
    REVIEWER_CATCH_RATE_CONFIG_DIR="${CONFIG_DIR}" \
    REVIEWER_CATCH_RATE_CLAUDE_BIN="${LAUNCHER}" \
    REVIEWER_CATCH_RATE_HOOKS_DIR="${HOOKS_DIR}" \
    STUB_LOG_DIR="${STUB_LOG_DIR}" \
    STUB_REPLY_DIR="${STUB_REPLY_DIR}" \
    STUB_KEY_MODE="${STUB_KEY_MODE}" \
    bash "${RUNNER}" "$@"
}

# assert_status <want> [row name]
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    printf '%sstatus=%s (want %s)\nstdout:\n%s\nstderr:\n%s\n' "${2:+row ${2}: }" "${status}" "${1}" "${output}" "${stderr}"
    return 1
  }
}

assert_report_rows() {
  local row
  for row in "$@"; do
    [[ $'\n'"${output}"$'\n' == *$'\n'"${row}"$'\n'* ]] || {
      printf 'missing row: %s\nstdout:\n%s\nstderr:\n%s\n' "${row}" "${output}" "${stderr}"
      return 1
    }
  done
}

# assert_stderr_names <diff key>... — each voided diff states its own reason.
assert_stderr_names() {
  local name
  for name in "$@"; do
    [[ "${stderr}" == *"${name}.diff"* ]] || {
      printf 'row %s: no stderr reason\n%s\n' "${name}" "${stderr}"
      return 1
    }
  done
}

assert_not_launched() {
  [[ ! -e "${STUB_LOG_DIR}/argv" ]] || {
    printf 'row %s launched:\n' "${1}"
    cat -- "${STUB_LOG_DIR}/argv"
    return 1
  }
}

# shellcheck disable=SC2016  # literal markdown backticks, as the review template wraps each tag
@test "a defect scores caught only when its pattern appears inside a severity-tagged finding of the relayed reply" {
  add_case hit unquoted-var 'unquoted.*file_list' \
    '- `[MUST FIX][Risk: H] hooks/x.sh → file_list`: Unquoted file_list expansion splits on spaces.'
  add_case sub-bullet split-use 'splitting.{0,20}forbidden' \
    $'- `[MUST FIX][Risk: H] hooks/x.sh → main`: **Shell.** Expands a path list.\n  - Rule: word splitting on paths is forbidden.'
  add_case blank-line-continuation split-use 'splitting.{0,20}forbidden' \
    $'- `[MUST FIX][Risk: H] hooks/x.sh → main`: Expands a path list.\n\n  - Rule: word splitting on paths is forbidden.'
  add_case numbered-list glob-use 'unquoted glob' '1. [MUST FIX] hooks/x.sh:2 — unquoted glob in the loop.'
  add_case bold-lead-in glob-use 'unquoted glob' '**[MUST FIX]** hooks/x.sh:2 — unquoted glob in the loop.'
  add_case lowercase-tag glob-use 'unquoted glob' '- [must fix] hooks/x.sh:2 — unquoted glob in the loop.'
  add_case padded-markers glob-use 'unquoted glob' 'unused'
  printf '  REVIEWER-REPLY-BEGIN \n[SHOULD FIX] hooks/x.sh:2 — unquoted glob in the loop.\n\tREVIEWER-REPLY-END  \n' \
    >"${STUB_REPLY_DIR}/padded-markers"
  add_case mid-line-tag glob-use 'unquoted glob' '- **Design**: nothing rises to [SHOULD FIX]; no unquoted glob.'
  add_case outside split-use 'word splitting' 'No defects found.' \
    '- `[MUST FIX][Risk: H] hooks/x.sh → main`: word splitting on a path.'
  run_runner --measured --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  assert_report_rows $'hit.diff\tunquoted-var\tcaught' $'sub-bullet.diff\tsplit-use\tcaught' \
    $'blank-line-continuation.diff\tsplit-use\tcaught' $'numbered-list.diff\tglob-use\tcaught' \
    $'bold-lead-in.diff\tglob-use\tcaught' $'lowercase-tag.diff\tglob-use\tcaught' \
    $'padded-markers.diff\tglob-use\tcaught' \
    $'mid-line-tag.diff\tglob-use\tmissed' $'outside.diff\tsplit-use\tmissed' \
    "RECALL tier=xhigh caught=7 scored=9 errors=0 ${ZERO_TOTALS}"
}

@test "a failed launch, a reply without a closed non-empty relay block or a reply naming the corpus scores that diff error and exits 1" {
  add_case hit unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  add_case bare no-markers 'unquoted' 'unused'
  printf 'The reviewer found an unquoted variable.\n' >"${STUB_REPLY_DIR}/bare"
  add_case empty-relay empty-block 'unquoted' $'\n  '
  add_case unclosed-relay truncated 'unquoted' 'unused'
  printf 'REVIEWER-REPLY-BEGIN\n[SHOULD FIX] hooks/x.sh:3 — unquo\n' >"${STUB_REPLY_DIR}/unclosed-relay"
  add_case crashed crash 'unquoted' 'unquoted variable'
  printf '3\n' >"${STUB_REPLY_DIR}/crashed.rc"
  add_case leaked-dir leak 'unquoted' \
    '[SHOULD FIX] hooks/x.sh:3 — unquoted variable, as autoagent/reviewer-catch-rate/case-01.diff shows'
  add_case leaked-labels leak 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable, per the labels.tsv row'
  run_runner --measured --tier high --corpus "${CORPUS}"
  assert_status 1
  assert_report_rows $'hit.diff\tunquoted-var\tcaught' $'bare.diff\tno-markers\terror' \
    $'empty-relay.diff\tempty-block\terror' $'unclosed-relay.diff\ttruncated\terror' \
    $'crashed.diff\tcrash\terror' $'leaked-dir.diff\tleak\terror' $'leaked-labels.diff\tleak\terror' \
    "RECALL tier=high caught=1 scored=1 errors=6 ${ZERO_TOTALS}"
  assert_stderr_names bare empty-relay unclosed-relay crashed leaked-dir leaked-labels
}

# tool_result_record <tool_result content JSON> — the user record carrying one tool's output back to the reviewer.
tool_result_record() {
  jq -cn --argjson c "${1}" \
    '{type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: "toolu_1", content: $c}]}}'
}

@test "a diff scores only when no reviewer tool input or tool result names a label path" {
  local row label_read repo_search label_hit corpus_hit clean_hit
  for row in input-read result-text result-items result-clean; do
    add_case "${row}" unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  done
  label_read="$(jq -cn --arg p "${CORPUS}/labels.tsv" '{file_path: $p}')"
  repo_search="$(jq -cn --arg p "${GA}" '{pattern: "unquoted", path: $p}')"
  label_hit="$(jq -cn --arg p "${CORPUS}/labels.tsv" '$p + ":4:case-01.diff unquoted"')"
  corpus_hit="$(jq -cn --arg p "${GA}/autoagent/reviewer-catch-rate/case-01.diff" '[{type: "text", text: $p}]')"
  clean_hit="$(jq -cn --arg p "${GA}/hooks/x.sh" '$p + ":3:echo $files"')"
  assistant_record xhigh msg_1 '' "${label_read}" >"${STUB_REPLY_DIR}/input-read.records"
  { assistant_record xhigh msg_1 '' "${repo_search}" && tool_result_record "${label_hit}"; } \
    >"${STUB_REPLY_DIR}/result-text.records"
  { assistant_record xhigh msg_1 '' "${repo_search}" && tool_result_record "${corpus_hit}"; } \
    >"${STUB_REPLY_DIR}/result-items.records"
  { assistant_record xhigh msg_1 '' "${repo_search}" && tool_result_record "${clean_hit}"; } \
    >"${STUB_REPLY_DIR}/result-clean.records"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 1
  assert_report_rows $'input-read.diff\tunquoted-var\terror' $'result-text.diff\tunquoted-var\terror' \
    $'result-items.diff\tunquoted-var\terror' $'result-clean.diff\tunquoted-var\tcaught'
  for row in input-read:labels.tsv result-text:labels.tsv result-items:reviewer-catch-rate/; do
    [[ "${stderr}" == *"${row%%:*}.diff: reviewer transcript names ${row#*:} "* ]] || {
      printf 'row %s: no label-read reason\n%s\n' "${row%%:*}" "${stderr}"
      return 1
    }
  done
}

@test "a launch that exits 0 yet leaves no reviewer transcript in the config dir stops the run with exit 9" {
  local name launches
  for name in case-a case-b case-c; do
    add_case "${name}" unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  done
  export STUB_CONFIG_OVERRIDE="${BATS_TEST_TMPDIR}/hard-set-config"
  run_runner --measured --tier xhigh --corpus "${CORPUS}"
  assert_status 9
  launches="$(grep -cx -- '-p' "${STUB_LOG_DIR}/argv")"
  [[ "${launches}" -eq 1 ]] || {
    printf 'launches=%s, want 1\n' "${launches}"
    return 1
  }
  [[ "${stderr}" == *'case-a.diff'*'REVIEWER_CATCH_RATE_CONFIG_DIR'* && $'\n'"${output}" != *$'\nRECALL '* ]] || {
    printf 'stdout:\n%s\nstderr:\n%s\n' "${output}" "${stderr}"
    return 1
  }
}

@test "a failed launch that leaves no reviewer transcript scores that diff error and the run goes on" {
  add_case crashed crash 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  add_case later unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  printf '3\n' >"${STUB_REPLY_DIR}/crashed.rc"
  : >"${STUB_REPLY_DIR}/crashed.notranscript"
  run_runner --measured --tier xhigh --corpus "${CORPUS}"
  assert_status 1
  assert_report_rows $'crashed.diff\tcrash\terror' $'later.diff\tunquoted-var\tcaught' \
    "RECALL tier=xhigh caught=1 scored=1 errors=1 ${ZERO_TOTALS}"
}

@test "a diff scores only when its reviewer transcript carries the injected scope header" {
  add_case injected unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  add_case uninjected unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  : >"${STUB_REPLY_DIR}/uninjected.noinject"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 1
  assert_report_rows $'injected.diff\tunquoted-var\tcaught' $'uninjected.diff\tunquoted-var\terror'
  assert_stderr_names uninjected
}

@test "a diff scores only when every recorded reviewer tier equals the requested arm" {
  local row
  for row in match mismatch absent mixed; do
    add_case "${row}" unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  done
  assistant_record xhigh msg_1 >"${STUB_REPLY_DIR}/match.records"
  assistant_record high msg_1 >"${STUB_REPLY_DIR}/mismatch.records"
  assistant_record '' msg_1 >"${STUB_REPLY_DIR}/absent.records"
  { assistant_record xhigh msg_1 && assistant_record high msg_2; } >"${STUB_REPLY_DIR}/mixed.records"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 1
  assert_report_rows $'match.diff\tunquoted-var\tcaught' $'mismatch.diff\tunquoted-var\terror' \
    $'absent.diff\tunquoted-var\terror' $'mixed.diff\tunquoted-var\terror'
  assert_stderr_names mismatch absent mixed
}

@test "token use sums reviewer and parent usage once per message id, per diff and on the summary line" {
  add_case tok unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  add_case quiet unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  add_case orphan unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  local usage_a='{"input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4}'
  local usage_b='{"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 40}'
  local usage_p='{"input_tokens": 100, "output_tokens": 200, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 400}'
  {
    assistant_record xhigh msg_a "${usage_a}"
    assistant_record xhigh msg_a "${usage_a}"
    assistant_record xhigh msg_b "${usage_b}"
  } >"${STUB_REPLY_DIR}/tok.records"
  {
    assistant_record xhigh msg_p "${usage_p}"
    assistant_record xhigh msg_p "${usage_p}"
    assistant_record xhigh msg_q "${usage_a}"
  } >"${STUB_REPLY_DIR}/tok.parent"
  : >"${STUB_REPLY_DIR}/orphan.noparent"
  run_runner --measured --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  assert_report_rows \
    $'TOKENS\ttok.diff\tinput=11 output=22 cache_read=33 cache_creation=44\tparent_input=101 parent_output=202 parent_cache_read=303 parent_cache_creation=404' \
    $'TOKENS\tquiet.diff\t'"${ZERO_TOKENS}"$'\t'"${ZERO_PARENT_TOKENS}" \
    $'TOKENS\torphan.diff\t'"${ZERO_TOKENS}"$'\tunread' \
    $'orphan.diff\tunquoted-var\tcaught' \
    'RECALL tier=xhigh caught=3 scored=3 errors=0 input=11 output=22 cache_read=33 cache_creation=44 parent_input=101 parent_output=202 parent_cache_read=303 parent_cache_creation=404'
  assert_stderr_names orphan
}

build_unlabeled_diff() {
  printf 'x\n' >"${1}/a.diff"
  printf 'x\n' >"${1}/b.diff"
  printf 'a.diff\td\tp\n' >"${1}/labels.tsv"
}
build_absent_label_file() { printf 'x\n' >"${1}/a.diff"; }
build_label_without_diff() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\td\tp\nghost.diff\td\tp\n' >"${1}/labels.tsv"
}
build_two_field_label() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\tp\n' >"${1}/labels.tsv"
}
build_empty_middle_field() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\t\tp\tq\n' >"${1}/labels.tsv"
}
build_invalid_pattern() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\td\t(\n' >"${1}/labels.tsv"
}
build_no_diff() { printf '# none\n' >"${1}/labels.tsv"; }

@test "an invalid corpus stops the run with exit 3 before any launch" {
  local row dir
  for row in unlabeled_diff absent_label_file label_without_diff two_field_label empty_middle_field \
    invalid_pattern no_diff; do
    dir="${BATS_TEST_TMPDIR}/corpus-${row}"
    mkdir -p "${dir}"
    "build_${row}" "${dir}"
    run_runner --tier xhigh --corpus "${dir}"
    assert_status 3 "${row}"
    assert_not_launched "${row}"
  done
}

@test "the launcher runs with the runner's config dir, whatever CLAUDE_CONFIG_DIR the caller exports" {
  add_case hit unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  write_reviewer_definition "${CALLER_CONFIG_DIR}" ''
  run_runner --measured --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  local seen
  seen="$(cat -- "${STUB_LOG_DIR}/config-hit")"
  [[ "${seen}" == "${CONFIG_DIR}" ]] || {
    printf 'launcher config dir %s, runner %s\n' "${seen}" "${CONFIG_DIR}"
    return 1
  }
  assert_report_rows $'hit.diff\tunquoted-var\tcaught'
}

@test "an absent reviewer definition stops the run with exit 5 before any launch, while an effort-keyed one runs" {
  add_case hit unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  CONFIG_DIR="${BATS_TEST_TMPDIR}/config-absent"
  mkdir -p "${CONFIG_DIR}"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 5 absent
  assert_not_launched absent
  CONFIG_DIR="${BATS_TEST_TMPDIR}/config-keyed"
  write_reviewer_definition "${CONFIG_DIR}" 'effort: high'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0 keyed
  assert_report_rows $'hit.diff\tunquoted-var\tcaught'
}

@test "only a --measured run prints a RECALL line, and any other run prints its result as a PROBE line" {
  add_case hit unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  local row name flag mode summary absent
  for row in "probe||probe|PROBE|RECALL" "measured|--measured|measured|RECALL|PROBE"; do
    IFS='|' read -r name flag mode summary absent <<<"${row}"
    if [[ -n "${flag}" ]]; then run_runner "${flag}" --tier xhigh --corpus "${CORPUS}"; else run_runner --tier xhigh --corpus "${CORPUS}"; fi
    assert_status 0 "${name}"
    assert_report_rows "# reviewer-catch-rate mode=${mode} tier=xhigh corpus=${CORPUS}" \
      "${summary} tier=xhigh caught=1 scored=1 errors=0 ${ZERO_TOTALS}" || {
      echo "row ${name}"
      return 1
    }
    [[ $'\n'"${output}" != *$'\n'"${absent} "* ]] || {
      printf 'row %s: prints a %s line\n%s\n' "${name}" "${absent}" "${output}"
      return 1
    }
  done
}

@test "an unset or non-directory launcher config dir is refused with exit 8 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  local row name
  for row in "unset|" "plain-file|${CORPUS}/hit.diff" "absent|${BATS_TEST_TMPDIR}/no-such-dir"; do
    name="${row%%|*}"
    CONFIG_DIR="${row#*|}"
    run_runner --measured --tier xhigh --corpus "${CORPUS}"
    assert_status 8 "${name}"
    assert_not_launched "${name}"
  done
}

@test "unusable session wiring stops the run with exit 7 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  rm -- "${HOOKS_DIR}/inject-scope-part-07.sh"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 7 missing-hook
  assert_not_launched missing-hook
}

launcher_for() {
  case "${1}" in
    stub) printf '%s' "${BATS_TEST_TMPDIR}/launcher" ;;
    plain-file) printf '%s' "${CORPUS}/hit.diff" ;;
    *) ;;
  esac
}

@test "an unplanned tier or an unusable launcher is refused before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  local row name want kind tier
  for row in 'tier-low|2|stub|low' 'tier-max|2|stub|max' 'tier-missing|2|stub|' 'launcher-unset|4|unset|xhigh' \
    'launcher-not-executable|4|plain-file|xhigh'; do
    IFS='|' read -r name want kind tier <<<"${row}"
    LAUNCHER="$(launcher_for "${kind}")"
    if [[ -n "${tier}" ]]; then run_runner --tier "${tier}" --corpus "${CORPUS}"; else run_runner --corpus "${CORPUS}"; fi
    assert_status "${want}" "${name}"
    assert_not_launched "${name}"
  done
}

@test "an unknown argument or a flag missing its value is refused with exit 2 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  local row name
  local -a extra
  for row in 'unknown-arg|--bogus|x' 'dangling-flag|--out'; do
    IFS='|' read -r -a extra <<<"${row}"
    name="${extra[0]}"
    run_runner --tier xhigh --corpus "${CORPUS}" "${extra[@]:1}"
    assert_status 2 "${name}"
    assert_not_launched "${name}"
  done
}

# effort_after <argv lines> — every value following an --effort flag, one per line.
effort_after() { awk 'prev == "--effort" { print } { prev = $0 }' <<<"${1}"; }

@test "every arm runs an xhigh headless parent whose staged workflow spawns the typed reviewer at the arm's tier with a schema" {
  add_case hit unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  local tier argv script parent_tier brief
  for tier in medium high xhigh; do
    mkdir -p "${STUB_LOG_DIR}"
    run_runner --measured --tier "${tier}" --corpus "${CORPUS}"
    assert_status 0 "${tier}"
    assert_report_rows "RECALL tier=${tier} caught=1 scored=1 errors=0 ${ZERO_TOTALS}" || {
      echo "row ${tier}"
      return 1
    }
    argv="$(cat -- "${STUB_LOG_DIR}/argv")"
    script="$(cat -- "${STUB_LOG_DIR}/script-hit.js")"
    parent_tier="$(effort_after "${argv}")"
    mv -- "${STUB_LOG_DIR}" "${BATS_TEST_TMPDIR}/log-${tier}"
    [[ $'\n'"${argv}"$'\n' == *$'\n-p\n'* && "${parent_tier}" == xhigh ]] || {
      echo "row ${tier}: ${argv}"
      return 1
    }
    [[ "${argv}" == *$'--setting-sources\nproject,local'* ]] || {
      echo "row ${tier}: ${argv}"
      return 1
    }
    printf '%s\n' "${argv}" | grep -Eqx -- '--session-id' || {
      echo "row ${tier}: ${argv}"
      return 1
    }
    ! printf '%s\n' "${argv}" | grep -Eqx -- '--agents?' || {
      echo "row ${tier}: ${argv}"
      return 1
    }
    [[ "${script}" == *"agentType: 'glass-atrium-qa-code-reviewer'"* && "${script}" == *"effort: '${tier}'"* &&
      "${script}" == *'schema'* && "${script}" == *"label: 'corpus:hit'"* ]] || {
      echo "row ${tier}: ${script}"
      return 1
    }
    printf '%s\n' "${script}" | grep -Eq 'CID: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}_change-review_[0-9a-f]{4}' \
      || {
        echo "row ${tier}: ${script}"
        return 1
      }
    brief="$(sed -n '/^const brief/,/CID:/p' <<<"${script}")"
    [[ -n "${brief}" && "${brief}" != *[Cc][Oo][Rr][Pp][Uu][Ss]* ]] || {
      echo "row ${tier}: the brief names the corpus: ${script}"
      return 1
    }
  done
}

@test "the reviewer works in the case stage dir outside the corpus and repo, holding a copy of the diff and no label path" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  cmp -- "${STUB_LOG_DIR}/seen-hit.diff" "${CORPUS}/hit.diff"
  local prompt staged cwd stage_dir corpus repo
  prompt="$(cat -- "${STUB_LOG_DIR}/prompt-hit")"
  staged="$(cat -- "${STUB_LOG_DIR}/staged-hit")"
  cwd="$(cat -- "${STUB_LOG_DIR}/cwd-hit")"
  stage_dir="$(cat -- "${STUB_LOG_DIR}/stagedir-hit")"
  corpus="$(cd -- "${CORPUS}" && pwd -P)"
  repo="$(cd -- "${GA}" && pwd -P)"
  [[ "${prompt}" != *"${CORPUS}"* && "${staged}" != "${CORPUS}"/* ]] || return 1
  [[ "${cwd}" == "${stage_dir}" && "${cwd}" != "${corpus}"* && "${cwd}" != "${repo}"* ]] || {
    printf 'cwd %s\n' "${cwd}"
    return 1
  }
  ! grep -Eq 'labels\.tsv|findings\.tsv|reviewer-catch-rate/' -- "${STUB_LOG_DIR}/tree-hit" || {
    cat -- "${STUB_LOG_DIR}/tree-hit"
    return 1
  }
  [[ ! -e "${staged%/*}" ]] || {
    printf 'stage dir left behind: %s\n' "${staged%/*}"
    return 1
  }
}

@test "a corpus run writes no outcome row and no lesson" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  local fired argv
  fired="$(cat -- "${STUB_LOG_DIR}/hooks")"
  argv="$(cat -- "${STUB_LOG_DIR}/argv")"
  [[ $'\n'"${fired}"$'\n' == *$'\ninject-scope-rules.sh\n'* && $'\n'"${fired}"$'\n' == *$'\ninject-scope-part-12.sh\n'* ]] || {
    printf 'fired:\n%s\n' "${fired}"
    return 1
  }
  ! grep -Eqx 'track-outcome\.sh|cost-tracker\.sh|agent-tracker\.sh|telemetry-activation\.sh' <<<"${fired}" || {
    printf 'fired:\n%s\n' "${fired}"
    return 1
  }
  [[ "${argv}" == *$'--setting-sources\nproject,local'* ]]
}

@test "a missing shared path guard stops the run with exit 6 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  mkdir -p "${BATS_TEST_TMPDIR}/tree/autoagent"
  cp -- "${RUNNER}" "${BATS_TEST_TMPDIR}/tree/autoagent/"
  RUNNER="${BATS_TEST_TMPDIR}/tree/autoagent/reviewer-catch-rate.sh"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 6
  assert_not_launched path-guard
}

@test "a run states its recorder-free footprint on stderr" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  local phrase
  for phrase in 'project,local' 'no outcome row' 'no lesson' 'no CostEvent' 'inject-scope' "${HOOKS_DIR}"; do
    [[ "${stderr}" == *"${phrase}"* ]] || {
      printf 'missing %s in:\n%s\n' "${phrase}" "${stderr}"
      return 1
    }
  done
}

@test "--out keeps each raw launcher reply under its diff name" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable' 'preamble'
  run_runner --tier xhigh --corpus "${CORPUS}" --out "${BATS_TEST_TMPDIR}/out"
  assert_status 0
  cmp -- "${BATS_TEST_TMPDIR}/out/hit.reply.txt" "${STUB_REPLY_DIR}/hit"
}

REPO_CORPUS="${GA}/autoagent/reviewer-catch-rate"

# generate-manifest.sh keeps the corpus out of the live bundle, so only a tree outside git may lack it.
require_repo_corpus() {
  if [[ -r "${REPO_CORPUS}/labels.tsv" ]]; then return 0; fi
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "no catch-rate corpus: generate-manifest.sh keeps it out of the live bundle (install root — repo-only check)"
  echo "catch-rate corpus missing from a git work tree: ${REPO_CORPUS}"
  return 1
}

# Label rows of the repo corpus, optionally only those naming diff $1.
count_corpus_labels() {
  awk -F '\t' -v name="${1:-}" '!/^[[:space:]]*(#|$)/ && (name == "" || $1 == name) { n++ } END { print n + 0 }' \
    "${REPO_CORPUS}/labels.tsv"
}

# Repo-corpus stub mode: replies are filed under the staged diff's checksum, else one severity-tagged finding
# quoting the diff back as indented continuation lines, which scoring reads.
write_corpus_launcher() { STUB_KEY_MODE='cksum'; }

# The review findings findings.tsv files for defect id $1, one per line, empty when none.
corpus_findings() {
  awk -F '\t' -v id="${1}" '!/^[[:space:]]*(#|$)/ && $1 == id { print $2 }' "${REPO_CORPUS}/findings.tsv"
}

@test "every corpus diff is a well-formed new-file patch carrying exactly one labelled defect" {
  require_repo_corpus
  local diff name count
  mkdir -p "${BATS_TEST_TMPDIR}/apply"
  for diff in "${REPO_CORPUS}"/*.diff; do
    name="${diff##*/}"
    count="$(count_corpus_labels "${name}")"
    [[ "${count}" -eq 1 ]] || {
      echo "${name}: ${count} label rows, want 1"
      return 1
    }
    (cd -- "${BATS_TEST_TMPDIR}/apply" && git apply --check -- "${diff}") || {
      echo "${name}: does not apply to an empty tree"
      return 1
    }
    ! grep -Eiq 'planted|corpus|defect|violation' -- "${diff}" || {
      echo "${name}: names what it plants"
      return 1
    }
  done
}

@test "a severity-tagged finding that only quotes the corpus diff back scores every planted defect missed" {
  require_repo_corpus
  write_corpus_launcher
  local count
  count="$(count_corpus_labels)"
  run_runner --measured --tier high
  assert_status 0
  [[ "${output}" != *$'\tcaught'* ]] || {
    printf '%s\n' "${output}"
    return 1
  }
  assert_report_rows "RECALL tier=high caught=0 scored=${count} errors=0 ${ZERO_TOTALS}"
}

# denial-reply.md: an unrelated finding citing the Residue class list, anchored away from every corpus file and symbol,
# then a no-findings section denying every corpus defect class.
@test "a reply denying every corpus defect class or citing a class list in a finding on other code scores every planted defect missed" {
  require_repo_corpus
  write_corpus_launcher
  local denial="${REPO_CORPUS}/denial-reply.md" line diff defect pattern key count=0
  while IFS='' read -r line || [[ -n "${line}" ]]; do
    [[ ! "${line}" =~ ^[[:space:]]*(#|$) ]] || continue
    IFS=$'\x1f' read -r diff defect pattern <<<"${line//$'\t'/$'\x1f'}"
    grep -Eiq -e "${pattern}" -- "${denial}" || {
      echo "the denial reply never names ${defect}, so its missed verdict would prove nothing"
      return 1
    }
    key="$(cksum <"${REPO_CORPUS}/${diff}")"
    cp -- "${denial}" "${STUB_REPLY_DIR}/${key%% *}"
    count=$((count + 1))
  done <"${REPO_CORPUS}/labels.tsv"
  run_runner --measured --tier xhigh
  assert_status 0
  assert_report_rows "RECALL tier=xhigh caught=0 scored=${count} errors=0 ${ZERO_TOTALS}"
}

# Fields split on \x1f like the runner's own label read, so an empty field cannot shift the rest.
# Each finding runs alone on a one-diff corpus, so one wording's catch cannot hide another's miss.
@test "each corpus defect scores caught on every finding filed for it" {
  require_repo_corpus
  write_corpus_launcher
  local orphans line diff defect pattern findings finding key dir n=0
  orphans="$(awk -F '\t' 'NR == FNR { if (!/^[[:space:]]*(#|$)/) ids[$2] = 1; next }
    !/^[[:space:]]*(#|$)/ && !($1 in ids) { print $1 }' "${REPO_CORPUS}/labels.tsv" "${REPO_CORPUS}/findings.tsv")"
  [[ -z "${orphans}" ]] || {
    echo "findings.tsv files rows under defect ids no label carries: ${orphans}"
    return 1
  }
  while IFS='' read -r line || [[ -n "${line}" ]]; do
    [[ ! "${line}" =~ ^[[:space:]]*(#|$) ]] || continue
    IFS=$'\x1f' read -r diff defect pattern <<<"${line//$'\t'/$'\x1f'}"
    findings="$(corpus_findings "${defect}")"
    [[ -n "${findings}" ]] || {
      echo "findings.tsv carries no finding for ${defect} (${pattern})"
      return 1
    }
    key="$(cksum <"${REPO_CORPUS}/${diff}")"
    while IFS='' read -r finding; do
      n=$((n + 1))
      dir="${BATS_TEST_TMPDIR}/finding-${n}"
      mkdir -p "${dir}"
      cp -- "${REPO_CORPUS}/${diff}" "${dir}/"
      printf '%s\n' "${line}" >"${dir}/labels.tsv"
      printf '%s\n' "${finding}" >"${STUB_REPLY_DIR}/${key%% *}"
      run_runner --tier xhigh --corpus "${dir}" </dev/null
      assert_status 0 "${defect}"
      assert_report_rows "${diff}"$'\t'"${defect}"$'\tcaught' || {
        printf 'finding: %s\n' "${finding}"
        return 1
      }
    done <<<"${findings}"
  done <"${REPO_CORPUS}/labels.tsv"
}
