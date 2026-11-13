#!/usr/bin/env bats
# reply-language-resolver.bats — hooks/lib/reply_language.py, the newest-human-message finder.
# Contracts protected:
# - only origin kind `human` is the user's message
# - an entry whitespace-empty after wrapper, paste and code removal is passed over
# - the transcript read stays bounded

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME is set by bats before the file loads
HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
LIB="${HOOKS_DIR}/lib/reply_language.py"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"
# The whole output contract: any other key, a language or script field included, fails the row.
OUTPUT_KEYS='["bytes_read","entry","prose","reason","status","truncated"]'
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  RL_TMP="$(mktemp -d -t reply-language.XXXXXX)"
}

teardown() {
  if ga_guard_path "${RL_TMP:-}"; then rm -rf -- "${RL_TMP:?}"; fi
}

# One human entry buried under machine entries — the compaction / task-notification drift shape
# Args: $1=path $2=bytes of assistant noise before the human entry $3=bytes of task notifications after it
build_drift_transcript() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys

path, before, after = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])


def dump(entry):
    return json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"


noise = dump({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x" * 8000}]}})
notice = dump({"type": "user", "origin": {"kind": "task-notification"},
               "message": {"role": "user", "content": "<task-notification>" + "Background result line. " * 40 + "</task-notification>"}})
human = dump({"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "이 결과 한국어로 정리해줘"}})
with open(path, "w", encoding="utf-8") as fh:
    fh.write(noise * (before // len(noise)))
    fh.write(human)
    fh.write(notice * (after // len(notice) + 1))
PY
}

# Writes one human user entry per text, oldest first.
# Args: $1=path $@=entry texts
write_human_transcript() {
  local path="${1}" text
  shift
  : >"${path}"
  for text in "$@"; do
    jq -cn --arg text "${text}" \
      '{type: "user", origin: {kind: "human"}, message: {role: "user", content: $text}}' >>"${path}"
  done
}

# Writes one transcript entry per token, oldest first: start:<uuid> and notify:<uuid> open a turn (a prompt, a task
# notification) · tool · result · text · bigtext (about 2 KB) · feedback (the isMeta Stop hook feedback entry)
write_turn_transcript() {
  local path="$1" token big
  shift
  printf -v big '%2000s' ''
  : >"${path}"
  for token in "$@"; do
    case "${token}" in
      start:*) jq -cn --arg uuid "${token#start:}" '{type: "user", uuid: $uuid, promptId: "p-1", turnOrigin: "sdk",
        turnPosition: {promptIndex: 0, turnIndex: 1}, message: {role: "user", content: "Run the release build"}}' ;;
      notify:*) jq -cn --arg uuid "${token#notify:}" '{type: "user", uuid: $uuid, promptId: "p-1",
        origin: {kind: "task-notification"}, turnPosition: {promptIndex: 0, turnIndex: 2},
        message: {role: "user", content: "<task-notification>build finished</task-notification>"}}' ;;
      tool) jq -cn '{type: "assistant", uuid: "a-1", turnPosition: null, message: {role: "assistant",
        content: [{type: "tool_use", id: "toolu_1", name: "Bash", input: {command: "make release"}}]}}' ;;
      result) jq -cn '{type: "user", uuid: "r-1", message: {role: "user",
        content: [{type: "tool_result", tool_use_id: "toolu_1", content: "build ok"}]}}' ;;
      text) jq -cn '{type: "assistant", uuid: "a-2", message: {role: "assistant",
        content: [{type: "text", text: "The build passed."}]}}' ;;
      bigtext) jq -cn --arg text "${big// /x}" '{type: "assistant", uuid: "a-3",
        message: {role: "assistant", content: [{type: "text", text: $text}]}}' ;;
      feedback) jq -cn '{type: "user", uuid: "f-1", isMeta: true,
        message: {role: "user", content: "Stop hook feedback:\nQueue verdict (harness)"}}' ;;
      *) return 1 ;;
    esac >>"${path}"
  done
}

# Prints "status|entry|prose" for the resolver JSON in ${output}, or the keys outside the contract.
get_found() {
  jq -r --argjson contract "${OUTPUT_KEYS}" '
    (keys - $contract) as $extra
    | if $extra != [] then "extra keys: \($extra)" else [.status, .entry, .prose] | map(tostring) | join("|") end' \
    <<<"${output}"
}

# Row shape: transcript name|status|entry|prose. A name written to RL_TMP wins over the corpus.
assert_rows() {
  local row name want_status want_entry want_prose path got
  for row in "$@"; do
    IFS='|' read -r name want_status want_entry want_prose <<<"${row}"
    path="${CORPUS}/${name}.jsonl"
    if [[ -f "${RL_TMP}/${name}.jsonl" ]]; then
      path="${RL_TMP}/${name}.jsonl"
    fi
    run python3 "${LIB}" transcript "${path}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
    got="$(get_found)"
    [[ "${got}" == "${want_status}|${want_entry}|${want_prose}" ]] || {
      echo "${name}: got ${got}"
      return 1
    }
  done
}

@test "only origin-kind human entries are the user's message, whatever machine entries follow them" {
  assert_rows \
    'newest-human-korean|found|user|좋아, 이제 리뷰 반영해줘' \
    'newest-human-english|found|user|Now apply the review comments please' \
    'queued-human|found|queued_command|중간에 하나 더: 로그도 같이 확인해줘' \
    'task-notification-user|found|user|워크플로 돌려서 결과 알려줘' \
    'task-notification-queued|found|user|워크플로 돌려서 결과 알려줘' \
    'peer|found|user|레인 상태 확인해줘' \
    'channel|found|user|Summarize the open pull requests' \
    'compact-summary|found|user|이 계획대로 진행해줘' \
    'clear|none|null|null' \
    'sdk-cli|none|null|null' \
    'no-such-transcript|none|null|null'
}

@test "an entry whitespace-empty after wrapper, paste and code removal is passed over, and nothing else is" {
  write_human_transcript "${RL_TMP}/fenced-code-only.jsonl" '이 로그 좀 봐줘' $'```\nError: build failed\n```'
  write_human_transcript "${RL_TMP}/url-only.jsonl" '이 로그 좀 봐줘' 'https://example.com/build/42'
  write_human_transcript "${RL_TMP}/identifiers-only.jsonl" '이 로그 좀 봐줘' 'hooks/lib/reply_language.py?'
  assert_rows \
    'paste-only|found|user|이 로그 좀 봐줘' \
    'command-args|found|user|이 변경 사항 검토해줘' \
    'fenced-code-only|found|user|이 로그 좀 봐줘' \
    'url-only|found|user|이 로그 좀 봐줘' \
    'paste-dominated|found|user|왜 실패했는지 원인 찾아줘' \
    'identifiers-only|found|user|hooks/lib/reply_language.py?'
}

@test "a human entry beyond the first read window is still found by the growing windows" {
  build_drift_transcript "${RL_TMP}/drift.jsonl" 0 200000
  run env REPLY_LANG_WINDOW_BYTES=4096 REPLY_LANG_MAX_BYTES=1048576 \
    python3 "${LIB}" transcript "${RL_TMP}/drift.jsonl"
  [[ "${status}" -eq 0 ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  local got bytes_read
  got="$(get_found)"
  bytes_read="$(jq -r '.bytes_read' <<<"${output}")"
  [[ "${got}" == 'found|user|이 결과 한국어로 정리해줘' ]] || {
    echo "${output}"
    return 1
  }
  ((bytes_read > 4096))
}

@test "the read never passes the cap, even when that leaves no human entry found" {
  build_drift_transcript "${RL_TMP}/drift.jsonl" 0 200000
  run env REPLY_LANG_WINDOW_BYTES=4096 REPLY_LANG_MAX_BYTES=65536 \
    python3 "${LIB}" transcript "${RL_TMP}/drift.jsonl"
  [[ "${status}" -eq 0 ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  local got bytes_read
  got="$(jq -r '[.status, .truncated] | map(tostring) | join("|")' <<<"${output}")"
  bytes_read="$(jq -r '.bytes_read' <<<"${output}")"
  [[ "${got}" == 'none|true' ]] || {
    echo "${output}"
    return 1
  }
  ((bytes_read <= 65536))
}

@test "a large drifted transcript is found through a partial read within the default cap" {
  build_drift_transcript "${RL_TMP}/large.jsonl" 20000000 2400000
  run python3 "${LIB}" transcript "${RL_TMP}/large.jsonl"
  [[ "${status}" -eq 0 ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  local got stats
  got="$(get_found)"
  stats="$(jq -r '[.truncated, (.bytes_read <= 8388608)] | map(tostring) | join("|")' <<<"${output}")"
  [[ "${got}" == 'found|user|이 결과 한국어로 정리해줘' && "${stats}" == 'false|true' ]] || {
    echo "${output}"
    return 1
  }
}

@test "the current turn starts at the newest entry with a turn position, whatever its origin, and owns only the tool calls after it" {
  local row name tokens want got
  # Row shape: name|tokens|status|turn|tools; an empty turn prints as null
  for row in \
    'tool turn and its continuation|start:t-1 tool result text feedback tool result|found|t-1|true' \
    'tool-free turn|start:t-1 text|found|t-1|false' \
    'notification turn after a tool turn|start:t-1 tool result text notify:n-1 text|found|n-1|false' \
    'tool call in a notification turn|start:t-1 text notify:n-1 tool result text|found|n-1|true' \
    'no turn start|tool result text|none|null|false'; do
    IFS='|' read -r name tokens want <<<"${row}"
    IFS=' ' read -r -a tokens <<<"${tokens}"
    write_turn_transcript "${RL_TMP}/turn.jsonl" "${tokens[@]}"
    run python3 "${LIB}" turn "${RL_TMP}/turn.jsonl"
    got="$(jq -r '(keys - ["bytes_read","reason","status","tools","truncated","turn"]) as $extra
      | if $extra != [] then "extra keys: \($extra)" else [.status, .turn, .tools] | map(tostring) | join("|") end' \
      <<<"${output}" 2>/dev/null)" || got="unparsed: ${output}"
    [[ "${status}" -eq 0 && "${got}" == "${want}" ]] || {
      echo "${name}: exit ${status}, got ${got}"
      return 1
    }
  done
}

@test "a turn start past the read cap or an unreadable transcript is reported as no turn" {
  write_turn_transcript "${RL_TMP}/long.jsonl" start:t-1 tool result bigtext bigtext bigtext bigtext
  local row name path want got
  for row in "past the cap|${RL_TMP}/long.jsonl|none|true|null" \
    "unreadable|${RL_TMP}/no-such.jsonl|none|false|unreadable"; do
    IFS='|' read -r name path want <<<"${row}"
    run env REPLY_LANG_WINDOW_BYTES=1024 REPLY_LANG_MAX_BYTES=4096 python3 "${LIB}" turn "${path}"
    got="$(jq -r '[.status, .truncated, .reason] | map(tostring) | join("|")' <<<"${output}" 2>/dev/null)" || got=""
    [[ "${status}" -eq 0 && "${got}" == "${want}" ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
  done
}

@test "an unknown subcommand exits non-zero so a caller falls silent" {
  local name
  for name in bogus text reply; do
    run python3 "${LIB}" "${name}"
    [[ "${status}" -eq 2 && "${output}" == *usage:* ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
  done
}
