#!/usr/bin/env bats
# reply-language-resolver.bats — hooks/lib/reply_language.py, the newest-human-message finder.
# Contracts protected:
# - only origin kind `human` is the user's message
# - an entry whitespace-empty after wrapper, paste and code removal is passed over
# - a pending message on stdin passes the same test as a transcript entry
# - the transcript read stays bounded

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME is set by bats before the file loads
HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
LIB="${HOOKS_DIR}/lib/reply_language.py"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"
# The whole output contract: any other key, a language or script field included, fails the row.
OUTPUT_KEYS='["bytes_read","entry","prose","reason","status","truncated"]'

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  RL_TMP="$(mktemp -d -t reply-language.XXXXXX)"
}

teardown() {
  case "${RL_TMP:-}" in
    */reply-language.*) rm -rf -- "${RL_TMP}" ;;
    *) ;;
  esac
}

# One human entry after a run of machine-written entries, the drift shape a compaction or a burst of
# task notifications leaves behind the newest human prompt.
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

@test "a pending message is judged exactly as the same text appended as the transcript's newest human entry" {
  # shellcheck disable=SC2016  # the backticks are a literal code fence, never an expansion
  local rows=(
    'plain prose|Now review the staged diff'
    'prose around a URL|이 PR 검토해줘 https://github.com/org/repo/pull/12'
    'URL only|https://github.com/org/repo/pull/12'
    'fenced code only|```\nnpm ERR! code 1\n```'
    'paste only|<pasted_content id="1">Error: build failed</pasted_content>'
    'whitespace only|  \t '
    'empty|'
  )
  local row name text appended pending
  write_human_transcript "${RL_TMP}/base.jsonl" '이 로그 좀 봐줘'
  for row in "${rows[@]}"; do
    IFS='|' read -r name text <<<"${row}"
    printf '%b' "${text}" >"${RL_TMP}/pending.txt"
    cp "${RL_TMP}/base.jsonl" "${RL_TMP}/appended.jsonl"
    jq -cRs '{type: "user", origin: {kind: "human"}, message: {role: "user", content: .}}' \
      <"${RL_TMP}/pending.txt" >>"${RL_TMP}/appended.jsonl"
    run python3 "${LIB}" transcript "${RL_TMP}/appended.jsonl"
    appended="$(jq -r '[.status, .prose] | map(tostring) | join("|")' <<<"${output}")"
    run python3 "${LIB}" transcript --pending "${RL_TMP}/base.jsonl" <"${RL_TMP}/pending.txt"
    pending="$(jq -r '[.status, .prose] | map(tostring) | join("|")' <<<"${output}")"
    [[ "${status}" -eq 0 && "${pending}" == "${appended}" ]] || {
      echo "${name}: pending ${pending}, appended ${appended}"
      return 1
    }
  done
}

@test "a pending message with prose is found without opening the transcript" {
  printf '%s' 'Now review the staged diff' >"${RL_TMP}/pending.txt"
  run python3 "${LIB}" transcript --pending "${RL_TMP}/no-such-transcript.jsonl" <"${RL_TMP}/pending.txt"
  local got
  got="$(jq -r '[.status, .entry, .prose, .bytes_read, .reason] | map(tostring) | join("|")' <<<"${output}")"
  [[ "${status}" -eq 0 && "${got}" == 'found|pending|Now review the staged diff|0|null' ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
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

@test "any subcommand but transcript exits non-zero so a caller falls silent" {
  local name
  for name in bogus text reply; do
    run python3 "${LIB}" "${name}"
    [[ "${status}" -eq 2 && "${output}" == *usage:* ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
  done
}
