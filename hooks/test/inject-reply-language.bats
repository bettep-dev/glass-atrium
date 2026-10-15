#!/usr/bin/env bats
# inject-reply-language.bats — hooks/inject-reply-language.sh, the reply-language pointer line.
# Contracts protected:
# - a machine-written prompt gets one line quoting the user's latest own message
# - the line's fixed part names no language
# - the fixed part after the quote names the turn's final message, the report to the user, as what takes that language
# - an ordinary human prompt, a typed slash command included, stays silent without python3 or a transcript read
# - every input exits 0, so no prompt is erased

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME, status and output are set by bats
HOOK="${BATS_TEST_DIRNAME}/../inject-reply-language.sh"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"
# Names a resolver-derived language value would carry into the line's fixed part.
LANGUAGE_NAMES='english|korean|japanese|chinese|hangul|latin|kana|한국어|영어|일본어|중국어'
# Fixed phrase the context line carries after the quote.
REPLY_TARGET='the final message of each turn, your report to the user'
KOREAN_QUOTE='좋아, 이제 리뷰 반영해줘'
ENGLISH_QUOTE='Now apply the review comments please'
NOTIFICATION='<task-notification>\n<summary>Background build finished</summary>\n</task-notification>'
SPLIT=$'\x1f'
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  RL_TMP="$(mktemp -d -t inject-reply-language.XXXXXX)"
}

teardown() {
  if ga_guard_path "${RL_TMP:-}"; then rm -rf -- "${RL_TMP:?}"; fi
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

# Context line → `<fixed part>\x1f<quote>` | `silent` (no output) | `malformed: <output>` (else, incl. a named language or no REPLY_TARGET after the quote)
split_output() {
  if [[ -z "${output}" ]]; then
    printf 'silent'
    return 0
  fi
  jq -er --arg names "${LANGUAGE_NAMES}" --arg target "${REPLY_TARGET}" '
    select(.hookSpecificOutput.hookEventName == "UserPromptSubmit")
    | .hookSpecificOutput.additionalContext
    | capture("^(?<head>[^\"\n]*)(?<quote>\"(?:[^\"\\\\\n]|\\\\.)*\")(?<tail>[^\"\n]*)$")
    | select((.head + .tail) | test($names; "i") | not)
    | select(.tail | contains($target))
    | "\(.head)…\(.tail)\u001f\(.quote | fromjson)"' <<<"${output}" 2>/dev/null \
    || printf 'malformed: %s' "${output}"
}

# Prints the quote of the one context line, `silent`, or `malformed: <output>`.
get_output_quote() {
  local split
  split="$(split_output)"
  printf '%s' "${split#*"${SPLIT}"}"
}

# Asserts exit 0, then silence or a single line quoting the wanted text.
# Args: $1=row name $2=wanted quote or `silent`
assert_quote() {
  local got
  [[ "${status}" -eq 0 ]] || {
    echo "${1}: exit ${status}: ${output}"
    return 1
  }
  got="$(get_output_quote)"
  [[ "${got}" == "${2}" ]] || {
    echo "${1}: want ${2}, got ${got}"
    return 1
  }
}

# Row shape: name|entrypoint|source|corpus transcript|prompt|wanted quote or silent
assert_rows() {
  local row name entrypoint source transcript prompt want
  for row in "$@"; do
    IFS='|' read -r name entrypoint source transcript prompt want <<<"${row}"
    write_envelope "${source}" "${CORPUS}/${transcript}.jsonl" "${prompt}"
    run_hook "${entrypoint}"
    assert_quote "${name}" "${want}" || return 1
  done
}

@test "a machine-written prompt gets a line quoting the user's latest own message, never its own text" {
  assert_rows \
    "task notification|cli|-|newest-human-korean|${NOTIFICATION}|${KOREAN_QUOTE}" \
    "korean task notification over english history|cli|-|newest-human-english|<task-notification>\n<summary>빌드 작업이 완료되었습니다</summary>\n</task-notification>|${ENGLISH_QUOTE}" \
    "background agent notice|cli|-|newest-human-korean|Background agent \"lint\" completed|${KOREAN_QUOTE}" \
    "stopped agents notice|cli|-|newest-human-korean|3 background agents were stopped by the user|${KOREAN_QUOTE}" \
    "cross-session message|cli|-|newest-human-korean|<cross-session-message from=\"uds:/tmp/a.sock\">Please rebase now</cross-session-message>|${KOREAN_QUOTE}" \
    "another session wrapper|cli|-|newest-human-korean|Another Claude session sent a message:\n<cross-session-message from=\"a\">rebase now</cross-session-message>|${KOREAN_QUOTE}" \
    "cross-session idle notice|cli|-|newest-human-korean|[Cross-session idle notice] \"lane\" is idle|${KOREAN_QUOTE}" \
    "korean channel message over english history|cli|-|newest-human-english|<channel source=\"plugin:fakechat:fakechat\" chat_id=\"web\">한국어 메시지 확인해줘</channel>|${ENGLISH_QUOTE}" \
    "compaction continuation|cli|-|newest-human-korean|This session is being continued from a previous conversation that ran out of context.|${KOREAN_QUOTE}" \
    "stop hook feedback|cli|-|newest-human-korean|Stop hook feedback:\n[hook]: blocked|${KOREAN_QUOTE}" \
    "leading whitespace before a wrapper|cli|-|newest-human-korean|\n  ${NOTIFICATION}|${KOREAN_QUOTE}" \
    "a non-user source never quotes the prompt|cli|system|newest-human-english|이 결과 요약해줘|${ENGLISH_QUOTE}" \
    "any other non-user source|cli|poll_event|newest-human-korean|event payload arrived|${KOREAN_QUOTE}"
}

@test "the line's fixed part is the same whatever language the user wrote in" {
  local transcript prompt split fixed=()
  for prompt in "${NOTIFICATION}" 'Another Claude session sent a message:\nrebase now'; do
    for transcript in newest-human-korean newest-human-english; do
      write_envelope - "${CORPUS}/${transcript}.jsonl" "${prompt}"
      run_hook cli
      split="$(split_output)"
      [[ "${split}" == *"${SPLIT}"* ]] || {
        echo "${transcript}: ${split}"
        return 1
      }
      fixed+=("${split%%"${SPLIT}"*}")
    done
    [[ "${fixed[0]}" == "${fixed[1]}" ]] || {
      echo "fixed part varies: ${fixed[0]} / ${fixed[1]}"
      return 1
    }
    fixed=()
  done
}

@test "an ordinary human prompt, a typed slash command and an agent frame stay silent" {
  assert_rows \
    'korean prose|cli|-|newest-human-english|이 버그 원인 찾아서 고쳐줘|silent' \
    'english prose|cli|-|newest-human-korean|Please fix the flaky test in the monitor suite|silent' \
    'source user|cli|user|newest-human-english|이 결과 요약해줘|silent' \
    'slash command as typed|cli|-|newest-human-english|/ga-review 이 변경 사항 검토해줘|silent' \
    'prompt opening with an absolute path|cli|-|newest-human-english|/Users/dev/notes.md 이 파일 확인해줘|silent' \
    'wrapper named mid-prompt|cli|-|newest-human-english|Why did <task-notification> show up in my prompt?|silent' \
    'teammate frame|cli|-|newest-human-korean|<teammate-message teammate_id="team-lead">merge it</teammate-message>|silent' \
    'workflow frame|cli|-|newest-human-korean|[Workflow harness — computed task] The task text below was computed|silent' \
    'coordinator frame|cli|-|newest-human-korean|The coordinator sent a message while you were working|silent' \
    'agent frame with a non-user source|cli|system|newest-human-korean|<teammate-message teammate_id="x">go</teammate-message>|silent'
}

@test "a long prompt is classified by its cleaned start, however much whitespace leads it" {
  local tail padding
  tail="$(printf 'Error: build failed at step 7. %.0s' {1..300})"
  padding="$(printf '%4090s' '')"
  assert_rows \
    "long wrapper-led prompt|cli|-|newest-human-korean|<task-notification>\n<summary>${tail}</summary>\n</task-notification>|${KOREAN_QUOTE}" \
    "wrapper after whitespace filling most of the cleaned prefix|cli|-|newest-human-korean|${padding}${NOTIFICATION}${tail}|${KOREAN_QUOTE}" \
    "long ordinary prompt|cli|-|newest-human-korean|이 로그 보고 원인 찾아줘 ${tail}|silent"
}

@test "an ordinary human prompt spawns no python3 and never reads the transcript" {
  local real prompt
  real="$(command -v python3)"
  mkdir -p "${RL_TMP}/shim"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s/python3.log"\nexec "%s" "$@"\n' "${RL_TMP}" "${real}" \
    >"${RL_TMP}/shim/python3"
  chmod +x "${RL_TMP}/shim/python3"
  cp "${CORPUS}/newest-human-korean.jsonl" "${RL_TMP}/locked.jsonl"
  chmod 000 "${RL_TMP}/locked.jsonl"
  for prompt in '이 버그 원인 찾아서 고쳐줘' '/ga-review 이 변경 사항 검토해줘' \
    '<teammate-message teammate_id="x">go</teammate-message>'; do
    write_envelope - "${RL_TMP}/locked.jsonl" "${prompt}"
    run env PATH="${RL_TMP}/shim:${PATH}" CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/envelope.json"
    assert_quote "${prompt}" silent || return 1
    [[ ! -e "${RL_TMP}/python3.log" ]] || {
      echo "${prompt}: python3 ran:"
      cat "${RL_TMP}/python3.log"
      return 1
    }
  done
  write_envelope - "${RL_TMP}/locked.jsonl" "${NOTIFICATION}"
  run env PATH="${RL_TMP}/shim:${PATH}" CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/envelope.json"
  [[ "${status}" -eq 0 && -s "${RL_TMP}/python3.log" ]] || {
    echo "control: the python3 shim recorded no call"
    return 1
  }
}

@test "only an interactive cli session gets the line, and a transcript with no human entry gets none" {
  assert_rows \
    "cli control|cli|-|newest-human-korean|${NOTIFICATION}|${KOREAN_QUOTE}" \
    "sdk-cli|sdk-cli|-|newest-human-korean|${NOTIFICATION}|silent" \
    "sdk-ts|sdk-ts|-|newest-human-korean|${NOTIFICATION}|silent" \
    "no entrypoint|-|-|newest-human-korean|${NOTIFICATION}|silent" \
    "headless transcript|cli|-|sdk-cli|${NOTIFICATION}|silent" \
    "cleared transcript|cli|-|clear|${NOTIFICATION}|silent"
}

@test "the quote is one line of at most 200 characters with control characters stripped" {
  local text filler want
  filler="$(printf '가%.0s' {1..300})"
  # BEL, U+202E and U+200B, written as octal UTF-8 bytes
  text="$(printf 'A\aB\342\200\256C\342\200\213D\tE\nF %s' "${filler}")"
  want="A BCD E F $(printf '가%.0s' {1..190})"
  jq -cn --arg text "${text}" '{type: "user", origin: {kind: "human"}, message: {role: "user", content: $text}}' \
    >"${RL_TMP}/controls.jsonl"
  write_envelope - "${RL_TMP}/controls.jsonl" "${NOTIFICATION}"
  run_hook cli
  assert_quote 'controls and length' "${want}"
}

@test "malformed, empty or unresolvable input exits 0 with no output" {
  printf '%s' '{"prompt": "이 버그 원인 찾아' >"${RL_TMP}/malformed.json"
  : >"${RL_TMP}/empty.json"
  printf '%s\n' '["이 버그 원인 찾아서 고쳐줘"]' >"${RL_TMP}/array.json"
  printf '%s\n' '{"hook_event_name": "UserPromptSubmit"}' >"${RL_TMP}/no-fields.json"
  write_envelope - "${RL_TMP}/no-such-transcript.jsonl" "${NOTIFICATION}"
  mv "${RL_TMP}/envelope.json" "${RL_TMP}/missing-transcript.json"
  local name
  for name in malformed empty array no-fields missing-transcript; do
    run env CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/${name}.json"
    assert_quote "${name}" silent || return 1
  done
}

@test "a read cap reached before any human entry leaves the prompt without a line" {
  python3 - "${RL_TMP}/drift.jsonl" <<'PY'
import json, sys



def dump(entry):
    return json.dumps(entry, ensure_ascii=False, separators=(",", ":"))


notice = dump({"type": "user", "origin": {"kind": "task-notification"},
               "message": {"role": "user", "content": "<task-notification>" + "Result line. " * 40 + "</task-notification>"}})
human = dump({"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "좋아"}})
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write(human + "\n" + (notice + "\n") * 200)
PY
  write_envelope - "${RL_TMP}/drift.jsonl" "${NOTIFICATION}"
  run env CLAUDE_CODE_ENTRYPOINT=cli REPLY_LANG_WINDOW_BYTES=4096 REPLY_LANG_MAX_BYTES=16384 \
    "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_quote 'cap reached' silent || return 1
  run env CLAUDE_CODE_ENTRYPOINT=cli "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_quote 'control: default cap' '좋아'
}

@test "a missing python3 leaves the prompt untouched: exit 0 and no output" {
  local tool bin path
  write_envelope - "${CORPUS}/newest-human-korean.jsonl" "${NOTIFICATION}"
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
  assert_quote 'control with python3' "${KOREAN_QUOTE}" || return 1
  run env PATH="${RL_TMP}/without-python" CLAUDE_CODE_ENTRYPOINT=cli "${BASH}" "${HOOK}" <"${RL_TMP}/envelope.json"
  assert_quote 'without python3' silent
}
