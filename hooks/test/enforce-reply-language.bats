#!/usr/bin/env bats
# enforce-reply-language.bats — hooks/enforce-reply-language.sh, the Stop backstop for the final reply's language.
# Protects three contracts: a final reply holding none of the user's non-Latin script is blocked exactly
# once, a reply carrying it (or no prose at all) or honouring an explicit language request, never one only
# named, passes, and headless, disabled or malformed runs stay silent with exit 0.

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

# Appends the shape of a final message not yet recorded: English narration with a tool call, then its result.
# Args: $1=path
append_unrecorded_final() {
  {
    jq -cn '{type: "assistant", message: {id: "msg_narration", role: "assistant", content: [
      {type: "text", text: "Let me check the parser first."},
      {type: "tool_use", id: "toolu_parser", name: "Read", input: {file_path: "/tmp/parser.py"}}]}}'
    jq -cn '{type: "user", message: {role: "user",
      content: [{type: "tool_result", tool_use_id: "toolu_parser", content: "def parse(): pass"}]}}'
  } >>"${1}"
}

# Writes a Stop envelope; reply "-" leaves last_assistant_message out, the CLI's shape for a reply that trims to empty.
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
get_decision() {
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
  got="$(get_decision)"
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
    'korean obligation form asks for english|cli|false|이번 보고는 꼭 영어로 해야 해|The results are below.|pass'
    'korean request-question asks for english|cli|false|영어로 답해 줄래?|Sure, here it is.|pass'
    'japanese request-question asks for english|cli|false|英語で答えてくれる？|The test passes now.|pass'
    'english request-question inside korean prose|cli|false|이 로그 확인해 줄래? Could you reply in English?|The log shows a timeout.|pass'
    'korean asks for korean|cli|false|영어 말고 한국어로 답해줘|Here is the answer.|block:Korean'
  )
  assert_rows "${rows[@]}"
}

@test "a language only named, never requested for the reply, leaves the backstop on" {
  # shellcheck disable=SC2016,SC1112  # backticks and unicode quotes in rows are prompt text, never shell syntax
  local rows=(
    'english input described|cli|false|영어로 된 로그 요약해줘|The log shows a timeout.|block:Korean'
    'english named without a request|cli|false|영어 문서 링크 확인해줘|The link works.|block:Korean'
    'permission for mid-turn english|cli|false|여기에서는 영어로 진행되도 상관 없음 최종 사용자 보고에만 사용자 언어로 답하면 됨|Done.|block:Korean'
    'participle of a writing verb|cli|false|영어로 작성된 문서 요약해줘|The document covers the API.|block:Korean'
    'participle of a passive writing verb|cli|false|영어로 쓰인 에러 메시지 원인 찾아줘|The error is a timeout.|block:Korean'
    'participle of an explaining verb|cli|false|영어로 설명된 부분만 번역해줘|Translated the section.|block:Korean'
    'artifact language in a chained request|cli|false|커밋 메시지는 영어로 작성하고 결과는 알려줘|Committed the change.|block:Korean'
    'artifact language in a request|cli|false|커밋 메시지는 영어로 작성해줘|Committed the change.|block:Korean'
    'english clause quoted from a rule|cli|false|커밋 규칙에 write subjects in English 라고 되어 있는데 왜 한국어 제목이 들어갔는지 확인해줘|The rule applies to subjects.|block:Korean'
    'english clause embedded in a korean request|cli|false|봇이 reply in English 하도록 설정 바꿔줘|Updated the bot setting.|block:Korean'
    'owner complaint about english replies|cli|false|자꾸 영어로 답변하는 문제가 있음 원인 확인해줘|The cause is the compaction summary.|block:Korean'
    'owner why-question about english replies|cli|false|왜 자꾸 영문으로 대답하지?|The cause is the compaction summary.|block:Korean'
    'complaint asking why the reply is english|cli|false|왜 자꾸 영어로 대답해?|The cause is the compaction summary.|block:Korean'
    'plain question about the reply language|cli|false|영어로 답해?|Yes, in English.|block:Korean'
    'obligation question about the reply language|cli|false|영어로 답해야 해?|Yes, in English.|block:Korean'
    'later complaint outranks an earlier request|cli|false|한국어로 답해야지 왜 영어로 답해|The cause is the compaction summary.|block:Korean'
    'english clause in a korean complaint|cli|false|왜 자꾸 reply in English 해?|The cause is the compaction summary.|block:Korean'
    'chinese prohibition|cli|false|请不要用英文回答|The answer is below.|block:Chinese'
    'chinese why-question|cli|false|你为什么用英文回答?|The answer is below.|block:Chinese'
    'request in straight double quotes|cli|false|사용자가 "영어로 답해줘"라고 하면 어떻게 동작해?|It is treated as a request.|block:Korean'
    "request in straight single quotes|cli|false|'영어로 답변해줘' 같은 요청은 요청으로 잡혀야 해|It is captured now.|block:Korean"
    'request in curly double quotes|cli|false|봇이 “영어로 답해 주세요”를 받으면 뭐라고 해|The bot switches.|block:Korean'
    'request in curly single quotes|cli|false|‘영어로 대답해줘’ 문구가 테스트에 있는지 확인해|The phrase is covered.|block:Korean'
    'request in backticks|cli|false|`영어로 답해줘` 입력이 요청으로 잡히는지 봐줘|It is caught.|block:Korean'
    'request in corner brackets|cli|false|「英語で答えてください」という文をテストして|The sentence is tested.|block:Japanese'
    'request in double corner brackets|cli|false|『英語で返事してね』という例文を追加して|The example is added.|block:Japanese'
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

@test "without the envelope's final reply only the transcript's tail message is judged, and an empty one passes" {
  # Row shape: name|transcript final message, @unrecorded for none after English narration|envelope reply|want
  local rows=(
    'english final message in the transcript|Fixed the parser.|-|block:Korean'
    'korean final message in the transcript|파서를 수정했습니다.|-|pass'
    'empty final message in the transcript||-|pass'
    'final message not recorded after english narration|@unrecorded|-|pass'
    'envelope korean over transcript english|Fixed the parser.|파서를 수정했습니다.|pass'
    'envelope english over transcript korean|파서를 수정했습니다.|Fixed the parser.|block:Korean'
  )
  local row name transcript_reply envelope_reply want
  for row in "${rows[@]}"; do
    IFS='|' read -r name transcript_reply envelope_reply want <<<"${row}"
    if [[ "${transcript_reply}" == @unrecorded ]]; then
      write_transcript "${RL_TMP}/transcript.jsonl" '이 버그 원인 찾아서 고쳐줘' -
      append_unrecorded_final "${RL_TMP}/transcript.jsonl"
    else
      write_transcript "${RL_TMP}/transcript.jsonl" '이 버그 원인 찾아서 고쳐줘' "${transcript_reply}"
    fi
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

@test "a human entry far behind a notification burst on a large transcript is enforced within the turn-end CPU budget" {
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
  local reply
  for reply in 'All background builds finished and every check passed.' -; do
    write_envelope false "${RL_TMP}/large.jsonl" "${reply}"
    times >"${RL_TMP}/cpu-before"
    run_hook cli
    times >"${RL_TMP}/cpu-after"
    assert_decision "large drifted transcript, reply ${reply}" block:Korean || return 1
    assert_cpu_under 1.0 "reply ${reply}" || return 1
  done
}

# Asserts the CPU seconds (user + sys) this shell's children spent between the two `times` snapshots stay
# under the budget; CPU rather than wall-clock, so a loaded parallel run cannot fail it.
# Args: $1=budget seconds $2=row name
assert_cpu_under() {
  awk -v budget="${1}" -v name="${2}" '
    FNR == 2 {
      for (i = 1; i <= 2; i++) {
        t = $i
        gsub(",", ".", t)
        split(t, part, /[ms]/)
        cpu[FILENAME] += part[1] * 60 + part[2]
      }
    }
    END {
      spent = cpu[ARGV[2]] - cpu[ARGV[1]]
      if (spent < budget) exit 0
      printf "%s: %.3fs CPU, budget %ss\n", name, spent, budget
      exit 1
    }' "${RL_TMP}/cpu-before" "${RL_TMP}/cpu-after"
}
