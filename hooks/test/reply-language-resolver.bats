#!/usr/bin/env bats
# reply-language-resolver.bats — hooks/lib/reply_language.py, the newest-human-prose language resolver.
# Protects three contracts: only origin kind `human` sets the language, the transcript read stays
# bounded however far the human entry drifted, and the script decision survives identifiers, pastes
# and quoted literals.

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME is set by bats before the file loads
HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
LIB="${HOOKS_DIR}/lib/reply_language.py"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"

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

# Prints "status|script|language|entry" for the resolver JSON in ${output}.
decision_of_output() {
  jq -r '[.status, .script, .language, .entry] | map(tostring) | join("|")' <<<"${output}"
}

@test "only origin-kind human prose sets the language, whatever the machine entries around it say" {
  local rows=(
    'newest-human-korean|resolved|hangul|Korean|user'
    'newest-human-english|resolved|latin|null|user'
    'queued-human|resolved|hangul|Korean|queued_command'
    'task-notification-user|resolved|hangul|Korean|user'
    'task-notification-queued|resolved|hangul|Korean|user'
    'peer|resolved|hangul|Korean|user'
    'channel|resolved|latin|null|user'
    'compact-summary|resolved|hangul|Korean|user'
    'clear|none|null|null|null'
    'sdk-cli|none|null|null|null'
    'no-such-transcript|none|null|null|null'
  )
  local row name want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name want <<<"${row}"
    run python3 "${LIB}" transcript "${CORPUS}/${name}.jsonl"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
    got="$(decision_of_output)"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: got ${got}, want ${want}"
      return 1
    }
  done
}

@test "the script decision ignores identifiers, pastes and command wrappers but not a quoted literal's share" {
  local rows=(
    'mixed-identifiers|resolved|hangul|Korean|user'
    'paste-dominated|resolved|hangul|Korean|user'
    'english-quoting-hangul|resolved|latin|null|user'
    'paste-only|resolved|hangul|Korean|user'
    'command-args|resolved|hangul|Korean|user'
  )
  local row name want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name want <<<"${row}"
    run python3 "${LIB}" transcript "${CORPUS}/${name}.jsonl"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
    got="$(decision_of_output)"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: got ${got}, want ${want}"
      return 1
    }
  done
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
  got="$(decision_of_output)"
  bytes_read="$(jq -r '.bytes_read' <<<"${output}")"
  [[ "${got}" == 'resolved|hangul|Korean|user' ]] || {
    echo "${output}"
    return 1
  }
  ((bytes_read > 4096))
}

@test "the read never passes the cap, even when that leaves the language unresolved" {
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

@test "a large drifted transcript resolves within the per-turn latency budget and a partial read" {
  build_drift_transcript "${RL_TMP}/large.jsonl" 20000000 2400000
  local size started finished
  size="$(wc -c <"${RL_TMP}/large.jsonl")"
  started="$(python3 -c 'import time; print(time.time())')"
  run python3 "${LIB}" transcript "${RL_TMP}/large.jsonl"
  finished="$(python3 -c 'import time; print(time.time())')"
  [[ "${status}" -eq 0 ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  local got bytes_read
  got="$(decision_of_output)"
  bytes_read="$(jq -r '.bytes_read' <<<"${output}")"
  [[ "${got}" == 'resolved|hangul|Korean|user' ]] || {
    echo "${output}"
    return 1
  }
  ((bytes_read < size)) || {
    echo "read the whole ${size}-byte file"
    return 1
  }
  python3 -c 'import sys; sys.exit(0 if float(sys.argv[2]) - float(sys.argv[1]) < 1.0 else 1)' \
    "${started}" "${finished}"
}

@test "text mode names a machine-written prompt's shape and withholds a script decision for it" {
  # shellcheck disable=SC2016  # the backticks are literal fenced-code test input
  local rows=(
    'korean prose|이거 확인해줘|null|hangul'
    'japanese prose|このテストを確認してください|null|kana'
    'chinese prose|请帮我检查这个文件|null|han'
    'english prose|Please check this file|null|latin'
    'korean only inside fenced code|Please check this log\n```\n빌드 로그 확인 중 에러\n```|null|latin'
    'task notification|<task-notification>\n<summary>작업 완료</summary>\n</task-notification>|task-notification|null'
    'cross-session message|<cross-session-message from="uds:/tmp/a.sock">확인 부탁</cross-session-message>|peer|null'
    'teammate wrapper|Another Claude session sent a message:\n<cross-session-message from="a">rebase now</cross-session-message>|peer|null'
    'teammate message|<teammate-message teammate_id="plan-1">merge it</teammate-message>|peer|null'
    'channel message|<channel source="plugin:fakechat:fakechat" chat_id="web">한국어 메시지</channel>|channel|null'
  )
  local row name text want_shape want_script got
  for row in "${rows[@]}"; do
    IFS='|' read -r name text want_shape want_script <<<"${row}"
    printf '%b' "${text}" >"${RL_TMP}/prompt.txt"
    run python3 "${LIB}" text <"${RL_TMP}/prompt.txt"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
    got="$(jq -r '[.machine_shape, .script] | map(tostring) | join("|")' <<<"${output}")"
    [[ "${got}" == "${want_shape}|${want_script}" ]] || {
      echo "${name}: got ${got}"
      return 1
    }
  done
}

@test "an unknown subcommand exits non-zero so a caller falls silent" {
  run python3 "${LIB}" bogus
  [[ "${status}" -eq 2 && "${output}" == *usage:* ]]
}
