#!/usr/bin/env bats
# enforce-reply-language.bats — hooks/enforce-reply-language.sh, the Stop backstop for the final reply's language.
# Protects three contracts: a final reply holding none of the user's non-Latin script is blocked exactly
# once, a reply carrying it (or no prose at all) or honouring an explicit language request passes, and
# headless, disabled or malformed runs stay silent with exit 0.

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME, status and output are set by bats
HOOK="${BATS_TEST_DIRNAME}/../enforce-reply-language.sh"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  RL_TMP="$(mktemp -d -t enforce-reply-language.XXXXXX)"
}

teardown() {
  case "${RL_TMP:-}" in
    */enforce-reply-language.*) rm -rf -- "${RL_TMP}" ;;
    *) ;;
  esac
}

# Writes a transcript: a previous turn's Korean reply, the human entry, then the final assistant message
# split over a thinking entry and a text entry sharing one message id, as the CLI records it.
# Args: $1=path $2=human prose $3=final reply, "-" for none (printf %b escapes expanded)
write_transcript() {
  local human reply
  human="$(printf '%b' "${2}")"
  reply="$(printf '%b' "${3}")"
  {
    jq -cn '{type: "assistant", message: {id: "msg_previous", role: "assistant",
      content: [{type: "text", text: "이전 작업을 마쳤습니다."}]}}'
    jq -cn --arg text "${human}" \
      '{type: "user", entrypoint: "cli", origin: {kind: "human"}, message: {role: "user", content: $text}}'
    if [[ "${3}" != "-" ]]; then
      jq -cn '{type: "assistant", message: {id: "msg_final", role: "assistant",
        content: [{type: "thinking", thinking: "Checking the result."}]}}'
      jq -cn --arg text "${reply}" \
        '{type: "assistant", message: {id: "msg_final", role: "assistant", content: [{type: "text", text: $text}]}}'
    fi
  } >"${1}"
}

# Writes a Stop envelope; reply "-" leaves last_assistant_message out, as older CLI builds do.
# Args: $1=stop_hook_active $2=transcript path $3=last assistant message (printf %b escapes expanded)
write_envelope() {
  local reply
  reply="$(printf '%b' "${3}")"
  jq -n --argjson active "${1}" --arg transcript "${2}" --arg reply "${reply}" --arg raw "${3}" '
    {session_id: "bats-session", transcript_path: $transcript, cwd: "/tmp", permission_mode: "default",
     hook_event_name: "Stop", stop_hook_active: $active}
    + (if $raw == "-" then {} else {last_assistant_message: $reply} end)' >"${RL_TMP}/envelope.json"
}

# Runs the hook on the written envelope; entrypoint "-" unsets CLAUDE_CODE_ENTRYPOINT.
run_hook() {
  if [[ "${1}" == "-" ]]; then
    run env -u CLAUDE_CODE_ENTRYPOINT "${HOOK}" <"${RL_TMP}/envelope.json"
  else
    run env CLAUDE_CODE_ENTRYPOINT="${1}" "${HOOK}" <"${RL_TMP}/envelope.json"
  fi
}

# Prints `pass` for no output, `block:<reason>` for one block decision with a one-line reason, or
# `malformed: <output>` for any other output.
decision_of_output() {
  if [[ -z "${output}" ]]; then
    printf 'pass'
    return 0
  fi
  jq -er 'select(.decision == "block") | .reason
    | select(type == "string" and length > 0 and (test("\n") | not)) | "block:" + .' <<<"${output}" 2>/dev/null \
    || printf 'malformed: %s' "${output}"
}

# Asserts one row: exit 0 always, then no output or a block whose reason names the wanted language.
# Args: $1=row name $2=`pass` or `block:<language>`
assert_decision() {
  local got
  [[ "${status}" -eq 0 ]] || {
    echo "${1}: exit ${status}: ${output}"
    return 1
  }
  got="$(decision_of_output)"
  if [[ "${2}" == pass ]]; then
    [[ "${got}" == pass ]] || {
      echo "${1}: want pass, got ${got}"
      return 1
    }
    return 0
  fi
  [[ "${got}" == block:*"${2#block:}"* ]] || {
    echo "${1}: want ${2}, got ${got}"
    return 1
  }
}

# Row shape: name|entrypoint|stop_hook_active|human prose or @corpus transcript|final reply|want
assert_rows() {
  local row name entrypoint active human reply want transcript
  for row in "$@"; do
    IFS='|' read -r name entrypoint active human reply want <<<"${row}"
    transcript="${RL_TMP}/transcript.jsonl"
    if [[ "${human}" == @* ]]; then
      transcript="${CORPUS}/${human#@}.jsonl"
    else
      write_transcript "${transcript}" "${human}" -
    fi
    write_envelope "${active}" "${transcript}" "${reply}"
    run_hook "${entrypoint}"
    assert_decision "${name}" "${want}" || return 1
  done
}

@test "a final reply holding none of the user's script is blocked with a reason naming the user's language" {
  # shellcheck disable=SC2016  # backticks in rows are markdown code in a reply, never expansions
  local rows=(
    'korean turn, english reply|cli|false|이 버그 원인 찾아서 고쳐줘|I found the root cause and fixed the parser.|block:Korean'
    'japanese turn, english reply|cli|false|このテストを確認してください|The test passes now.|block:Japanese'
    'korean only inside code|cli|false|정규식 수정해줘|Updated the regex to match `진행해` and `계속`.|block:Korean'
    'korean turn, japanese reply|cli|false|이 결과 요약해줘|結果をまとめました。|block:Korean'
    'task notification after korean prose|cli|false|@task-notification-user|The background build finished and all checks passed.|block:Korean'
    'compaction summary after korean prose|cli|false|@compact-summary|Continuing with the plan from the summary.|block:Korean'
  )
  assert_rows "${rows[@]}"
}

@test "the continuation a block forces is never blocked again: the block fires once" {
  local rows=(
    'first stop|cli|false|이 버그 원인 찾아서 고쳐줘|Fixed the parser.|block:Korean'
    'stop after the forced continuation|cli|true|이 버그 원인 찾아서 고쳐줘|Fixed the parser.|pass'
  )
  assert_rows "${rows[@]}"
}

@test "a reply carrying the user's script, or holding no prose at all, passes" {
  # shellcheck disable=SC2016  # backticks in rows are markdown code in a reply, never expansions
  local rows=(
    'korean reply|cli|false|이 버그 원인 찾아서 고쳐줘|원인을 찾아 파서를 수정했습니다.|pass'
    'korean reply dense with identifiers|cli|false|이 버그 원인 찾아서 고쳐줘|`hooks/cost-tracker.sh` 수정 완료, PR #12 CI green.|pass'
    'english reply with korean prose in it|cli|false|이 버그 원인 찾아서 고쳐줘|Fixed it — 확인 부탁드립니다.|pass'
    'code block only|cli|false|스크립트 보여줘|```bash\nls -la hooks\n```|pass'
    'inline code only|cli|false|파일 경로 알려줘|`hooks/enforce-reply-language.sh`|pass'
    'bare path only|cli|false|파일 경로 알려줘|/Users/dev/glass-atrium/hooks/lib/reply_language.py|pass'
    'empty reply|cli|false|이 버그 원인 찾아서 고쳐줘||pass'
  )
  assert_rows "${rows[@]}"
}

@test "a turn whose newest human prose names no non-Latin language never blocks" {
  local rows=(
    'english turn|cli|false|Please fix the flaky test in the monitor suite|Fixed the flaky test.|pass'
    'french turn|cli|false|Corrige le test instable dans la suite du moniteur|Fixed the flaky test.|pass'
    'english newest human over korean history|cli|false|@newest-human-english|Applied the review comments.|pass'
    'no human entry|cli|false|@sdk-cli|Done.|pass'
    'cleared session|cli|false|@clear|Done.|pass'
  )
  assert_rows "${rows[@]}"
}

@test "an explicit request in the newest human prose for another reply language lets the reply stand" {
  local rows=(
    'korean asks for english|cli|false|이번 답변은 영어로 해줘|Here is the summary.|pass'
    'korean asks for english replies|cli|false|앞으로 영어로 답변해줘|Understood, replying in English from now on.|pass'
    'korean asks for an english write-up|cli|false|결과는 영문으로 작성해 주세요|The results are below.|pass'
    'japanese asks for english|cli|false|英語で答えてください|The test passes now.|pass'
    'korean asks for japanese|cli|false|일본어로 대답해줘|テストは合格しました。|pass'
    'english request inside korean prose|cli|false|이 로그 확인하고 reply in English|The log shows a timeout.|pass'
    'korean asks for korean|cli|false|영어 말고 한국어로 답해줘|Here is the answer.|block:Korean'
    'english input described, not requested|cli|false|영어로 된 로그 요약해줘|The log shows a timeout.|block:Korean'
    'english named without a request|cli|false|영어 문서 링크 확인해줘|The link works.|block:Korean'
  )
  assert_rows "${rows[@]}"
}

@test "headless sessions and the kill switch stay silent" {
  local rows=(
    'interactive control|cli|false|이 버그 원인 찾아서 고쳐줘|Fixed the parser.|block:Korean'
    'sdk-cli|sdk-cli|false|이 버그 원인 찾아서 고쳐줘|Fixed the parser.|pass'
    'sdk-ts|sdk-ts|false|이 버그 원인 찾아서 고쳐줘|Fixed the parser.|pass'
    'no entrypoint|-|false|이 버그 원인 찾아서 고쳐줘|Fixed the parser.|pass'
    'headless transcript with hangul literals|cli|false|@sdk-cli|Classified all phrases.|pass'
  )
  assert_rows "${rows[@]}"
  write_transcript "${RL_TMP}/transcript.jsonl" '이 버그 원인 찾아서 고쳐줘' -
  write_envelope false "${RL_TMP}/transcript.jsonl" 'Fixed the parser.'
  run env REPLY_LANGUAGE_BACKSTOP_OFF=1 CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_decision 'kill switch' pass
}

@test "the transcript's final assistant message is read only when the envelope carries none" {
  local rows=(
    'english final message in the transcript|Fixed the parser.|-|block:Korean'
    'korean final message in the transcript|파서를 수정했습니다.|-|pass'
    'envelope korean over transcript english|Fixed the parser.|파서를 수정했습니다.|pass'
    'envelope english over transcript korean|파서를 수정했습니다.|Fixed the parser.|block:Korean'
  )
  local row name transcript_reply envelope_reply want
  for row in "${rows[@]}"; do
    IFS='|' read -r name transcript_reply envelope_reply want <<<"${row}"
    write_transcript "${RL_TMP}/transcript.jsonl" '이 버그 원인 찾아서 고쳐줘' "${transcript_reply}"
    write_envelope false "${RL_TMP}/transcript.jsonl" "${envelope_reply}"
    run_hook cli
    assert_decision "${name}" "${want}" || return 1
  done
}

@test "malformed, empty or unresolvable input exits 0 with no output" {
  printf '%s' '{"stop_hook_active": false, "last_assistant_message": "Fixed' >"${RL_TMP}/malformed.json"
  : >"${RL_TMP}/empty.json"
  printf '%s\n' '["Fixed the parser."]' >"${RL_TMP}/array.json"
  printf '%s\n' '{"hook_event_name": "Stop"}' >"${RL_TMP}/no-fields.json"
  write_envelope false "${RL_TMP}/no-such-transcript.jsonl" 'Fixed the parser.'
  mv "${RL_TMP}/envelope.json" "${RL_TMP}/missing-transcript.json"
  write_envelope false "${RL_TMP}" 'Fixed the parser.'
  mv "${RL_TMP}/envelope.json" "${RL_TMP}/directory-transcript.json"
  local name
  for name in malformed empty array no-fields missing-transcript directory-transcript; do
    run env CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/${name}.json"
    assert_decision "${name}" pass || return 1
  done
}

@test "a missing python3 lets the turn end: exit 0 and no output" {
  local tool bin path
  write_transcript "${RL_TMP}/transcript.jsonl" '이 버그 원인 찾아서 고쳐줘' -
  write_envelope false "${RL_TMP}/transcript.jsonl" 'Fixed the parser.'
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
  assert_decision 'control with python3' block:Korean || return 1
  run env PATH="${RL_TMP}/without-python" CLAUDE_CODE_ENTRYPOINT=cli "${BASH}" "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_decision 'without python3' pass
}

@test "a human entry far behind a notification burst on a large transcript is enforced within the turn-end budget" {
  python3 - "${RL_TMP}/large.jsonl" <<'PY'
import json, sys


def dump(entry):
    return json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"


noise = dump({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x" * 8000}]}})
notice = dump({"type": "user", "origin": {"kind": "task-notification"},
               "message": {"role": "user", "content": "<task-notification>" + "Background result line. " * 40 + "</task-notification>"}})
human = dump({"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "이 결과 한국어로 정리해줘"}})
reply = dump({"type": "assistant", "message": {"id": "msg_final", "role": "assistant",
              "content": [{"type": "text", "text": "All background builds finished and every check passed."}]}})
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write(noise * (20000000 // len(noise)))
    fh.write(human)
    fh.write(notice * (2400000 // len(notice) + 1))
    fh.write(reply)
PY
  local reply started finished
  for reply in 'All background builds finished and every check passed.' -; do
    write_envelope false "${RL_TMP}/large.jsonl" "${reply}"
    started="$(python3 -c 'import time; print(time.time())')"
    run_hook cli
    finished="$(python3 -c 'import time; print(time.time())')"
    assert_decision "large drifted transcript, reply ${reply}" block:Korean || return 1
    python3 -c 'import sys; sys.exit(0 if float(sys.argv[2]) - float(sys.argv[1]) < 1.0 else 1)' \
      "${started}" "${finished}" || {
      echo "reply ${reply}: took longer than 1s"
      return 1
    }
  done
}
