#!/usr/bin/env bats
# inject-reply-language.bats — hooks/inject-reply-language.sh, the per-turn UserPromptSubmit reply-language line.
# Protects three contracts: only human prose sets the named language (the prompt's own, else the
# transcript's newest), headless sessions stay silent, and every input exits 0 so no prompt is erased.

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME, status and output are set by bats
HOOK="${BATS_TEST_DIRNAME}/../inject-reply-language.sh"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  RL_TMP="$(mktemp -d -t inject-reply-language.XXXXXX)"
}

teardown() {
  case "${RL_TMP:-}" in
    */inject-reply-language.*) rm -rf -- "${RL_TMP}" ;;
    *) ;;
  esac
}

# Writes a UserPromptSubmit envelope; source "-" leaves the field out, as the installed CLI does.
# Args: $1=source $2=transcript path $3=prompt (printf %b escapes expanded)
write_envelope() {
  local prompt
  prompt="$(printf '%b' "${3}")"
  jq -n --arg source "${1}" --arg transcript "${2}" --arg prompt "${prompt}" '
    {session_id: "bats-session", transcript_path: $transcript, cwd: "/tmp",
     permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: $prompt}
    + (if $source == "-" then {} else {source: $source} end)' >"${RL_TMP}/envelope.json"
}

# Runs the hook on the written envelope; entrypoint "-" unsets CLAUDE_CODE_ENTRYPOINT.
run_hook() {
  if [[ "${1}" == "-" ]]; then
    run env -u CLAUDE_CODE_ENTRYPOINT "${HOOK}" <"${RL_TMP}/envelope.json"
  else
    run env CLAUDE_CODE_ENTRYPOINT="${1}" "${HOOK}" <"${RL_TMP}/envelope.json"
  fi
}

# Prints the context line, `silent` for no output, or `malformed: <output>` for any other output.
context_of_output() {
  if [[ -z "${output}" ]]; then
    printf 'silent'
    return 0
  fi
  jq -er 'select(.hookSpecificOutput.hookEventName == "UserPromptSubmit")
    | .hookSpecificOutput.additionalContext | select(test("\n") | not)' <<<"${output}" 2>/dev/null \
    || printf 'malformed: %s' "${output}"
}

# Asserts one row: exit 0 always, then silence or a single context line naming the wanted language.
# Args: $1=row name $2=wanted language or `silent`
assert_decision() {
  local got
  [[ "${status}" -eq 0 ]] || {
    echo "${1}: exit ${status}: ${output}"
    return 1
  }
  got="$(context_of_output)"
  if [[ "${2}" == silent ]]; then
    [[ "${got}" == silent ]] || {
      echo "${1}: want silent, got ${got}"
      return 1
    }
    return 0
  fi
  [[ "${got}" != malformed:* && "${got}" != silent && "${got}" == *"${2}"* ]] || {
    echo "${1}: want ${2}, got ${got}"
    return 1
  }
}

# Row shape: name|entrypoint|source|corpus transcript|prompt|wanted language or silent
assert_rows() {
  local row name entrypoint source transcript prompt want
  for row in "$@"; do
    IFS='|' read -r name entrypoint source transcript prompt want <<<"${row}"
    write_envelope "${source}" "${CORPUS}/${transcript}.jsonl" "${prompt}"
    run_hook "${entrypoint}"
    assert_decision "${name}" "${want}" || return 1
  done
}

@test "a human prompt names the language of its own prose, or of the newest earlier human prose when it has none" {
  local rows=(
    'korean prose over english history|cli|-|newest-human-english|이 버그 원인 찾아서 고쳐줘|Korean'
    'japanese prose over english history|cli|-|newest-human-english|このテストを確認してください|Japanese'
    'english prose over korean history|cli|-|newest-human-korean|Please fix the flaky test in the monitor suite|silent'
    'korean with english identifiers|cli|-|newest-human-english|claude-api prompt-audit 작업은 완료된 상태야?|Korean'
    'english quoting a hangul literal|cli|-|newest-human-korean|Find where the phrase "진행해" is matched in the correction regex|silent'
    'korean prose outside an english paste|cli|-|newest-human-english|왜 실패했는지 원인 찾아줘\n<pasted_content id="9c1d">\nThe build failed because the module graph could not be resolved and every downstream task was cancelled by the scheduler\n</pasted_content id="9c1d">|Korean'
    'paste with no prose of its own|cli|-|newest-human-korean|<pasted_content id="85af">\nError: build failed while resolving the module graph for the monitor package\n</pasted_content id="85af">|Korean'
    'argless slash command|cli|-|newest-human-korean|<command-message>ga-status</command-message>\n<command-name>/ga-status</command-name>|Korean'
    'source user reads the prompt|cli|user|newest-human-english|이 결과 요약해줘|Korean'
  )
  assert_rows "${rows[@]}"
}

@test "a machine-written prompt never sets the language: the newest human prose in the transcript does" {
  local rows=(
    'task notification|cli|-|newest-human-korean|<task-notification>\n<summary>Background build finished</summary>\n</task-notification>|Korean'
    'korean task notification over english history|cli|-|newest-human-english|<task-notification>\n<summary>빌드 작업이 완료되었습니다</summary>\n</task-notification>|silent'
    'cross-session message|cli|-|newest-human-korean|<cross-session-message from="uds:/tmp/a.sock">Please rebase now</cross-session-message>|Korean'
    'teammate wrapper|cli|-|newest-human-korean|Another Claude session sent a message:\n<cross-session-message from="a">rebase now</cross-session-message>|Korean'
    'teammate message|cli|-|newest-human-korean|<teammate-message teammate_id="plan-1">merge it</teammate-message>|Korean'
    'korean channel message over english history|cli|-|newest-human-english|<channel source="plugin:fakechat:fakechat" chat_id="web">한국어 메시지 확인해줘</channel>|silent'
    'source system never reads the prompt|cli|system|newest-human-english|이 결과 요약해줘|silent'
    'source system resolves from the transcript|cli|system|newest-human-korean|Background task finished|Korean'
    'any other source resolves from the transcript|cli|poll_event|newest-human-korean|event payload arrived|Korean'
  )
  assert_rows "${rows[@]}"
}

@test "only an interactive cli session gets the line, whatever a headless prompt holds" {
  local rows=(
    'cli control for a korean prompt|cli|-|sdk-cli|다음 교정 문구들을 분류해서 결과를 알려줘|Korean'
    'sdk-cli korean prompt|sdk-cli|-|sdk-cli|다음 교정 문구들을 분류해서 결과를 알려줘|silent'
    'sdk-cli english prompt with hangul literals|sdk-cli|-|sdk-cli|Classify each correction phrase such as 다시 해줘 and 이어서 진행해 and report which regex matches it|silent'
    'sdk-ts korean prompt|sdk-ts|-|newest-human-korean|다음 교정 문구들을 분류해줘|silent'
    'no entrypoint|-|-|newest-human-korean|이 버그 원인 찾아서 고쳐줘|silent'
    'machine prompt over a headless transcript|cli|-|sdk-cli|<task-notification>\n<summary>분류 완료</summary>\n</task-notification>|silent'
  )
  assert_rows "${rows[@]}"
}

@test "malformed, empty or unresolvable input exits 0 with no output" {
  printf '%s' '{"prompt": "이 버그 원인 찾아' >"${RL_TMP}/malformed.json"
  : >"${RL_TMP}/empty.json"
  printf '%s\n' '["이 버그 원인 찾아서 고쳐줘"]' >"${RL_TMP}/array.json"
  printf '%s\n' '{"hook_event_name": "UserPromptSubmit"}' >"${RL_TMP}/no-fields.json"
  write_envelope - "${RL_TMP}/no-such-transcript.jsonl" '<task-notification>\n<summary>done</summary>\n</task-notification>'
  mv "${RL_TMP}/envelope.json" "${RL_TMP}/missing-transcript.json"
  local name
  for name in malformed empty array no-fields missing-transcript; do
    run env CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/${name}.json"
    assert_decision "${name}" silent || return 1
  done
}

@test "a missing python3 leaves the prompt untouched: exit 0 and no output" {
  local tool bin path
  write_envelope - "${CORPUS}/newest-human-english.jsonl" '이 버그 원인 찾아서 고쳐줘'
  for bin in with-python without-python; do
    mkdir -p "${RL_TMP}/${bin}"
    for tool in cat dirname jq; do
      path="$(command -v "${tool}")"
      ln -s "${path}" "${RL_TMP}/${bin}/${tool}"
    done
  done
  path="$(command -v python3)"
  ln -s "${path}" "${RL_TMP}/with-python/python3"
  run env PATH="${RL_TMP}/with-python" CLAUDE_CODE_ENTRYPOINT=cli "${BASH}" "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_decision 'control with python3' Korean || return 1
  run env PATH="${RL_TMP}/without-python" CLAUDE_CODE_ENTRYPOINT=cli "${BASH}" "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_decision 'without python3' silent
}

@test "a human entry far behind a notification burst on a large transcript resolves within the per-turn budget" {
  python3 - "${RL_TMP}/large.jsonl" <<'PY'
import json, sys


def dump(entry):
    return json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"


noise = dump({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x" * 8000}]}})
notice = dump({"type": "user", "origin": {"kind": "task-notification"},
               "message": {"role": "user", "content": "<task-notification>" + "Background result line. " * 40 + "</task-notification>"}})
human = dump({"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "이 결과 한국어로 정리해줘"}})
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write(noise * (20000000 // len(noise)))
    fh.write(human)
    fh.write(notice * (2400000 // len(notice) + 1))
PY
  write_envelope - "${RL_TMP}/large.jsonl" '<task-notification>\n<summary>Background build finished</summary>\n</task-notification>'
  local started finished
  started="$(python3 -c 'import time; print(time.time())')"
  run_hook cli
  finished="$(python3 -c 'import time; print(time.time())')"
  assert_decision 'large drifted transcript' Korean || return 1
  python3 -c 'import sys; sys.exit(0 if float(sys.argv[2]) - float(sys.argv[1]) < 1.0 else 1)' \
    "${started}" "${finished}"
}
