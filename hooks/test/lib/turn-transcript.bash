#!/usr/bin/env bash
# turn-transcript.bash — the transcript-entry builder shared by the suites that read a turn through
# hooks/lib/reply_language.py; one copy of the host's measured turn shape (shared-hook-capability-contract.md →
# Stop row). Callers source it at file scope.

# the entry timestamps, in the host's form; a caller moves TURN_STARTED_AT, a prompt turn's start, against a record's
# write time
TURN_STARTED_AT=2026-11-17T02:35:12.204Z
TURN_NOTIFIED_AT=2026-11-17T02:41:07.512Z
TURN_COMPACTED_AT=2026-11-17T02:38:44.019Z
# the installed queue CLI a Bash call names
TURN_QUEUE_CLI="${HOME}/.glass-atrium/scripts/atrium-queue.sh"

# <path> <token>... → writes <path>, one entry per token, oldest first: start:<uuid> and notify:<uuid> open a turn (a
# prompt, a task notification) · tool · result · text · bigtext (about 2 KB) · feedback (the isMeta Stop hook feedback
# entry) · compact:<uuid> (a compaction summary, carrying the turn position of the turn start it follows) ·
# nullmessage and stringmessage (an assistant entry whose message is no object) · record (the queue server's record
# tool) · post and lastpost (its post tool, without and with the turn's last-act flag) · clirecord and clipending (Bash calls of the queue CLI's record and pending); non-zero on an unknown token
write_turn_transcript() {
  local path="$1" token big command
  shift
  printf -v big '%2000s' ''
  : >"${path}"
  for token in "$@"; do
    case "${token}" in
      start:*) jq -cn --arg uuid "${token#start:}" --arg at "${TURN_STARTED_AT}" '{type: "user",
        uuid: $uuid, timestamp: $at, promptId: "p-1", turnOrigin: "sdk",
        turnPosition: {promptIndex: 0, turnIndex: 1}, message: {role: "user", content: "Run the release build"}}' ;;
      notify:*) jq -cn --arg uuid "${token#notify:}" --arg at "${TURN_NOTIFIED_AT}" '{type: "user", uuid: $uuid,
        timestamp: $at, promptId: "p-1",
        origin: {kind: "task-notification"}, turnPosition: {promptIndex: 0, turnIndex: 2},
        message: {role: "user", content: "<task-notification>build finished</task-notification>"}}' ;;
      tool) jq -cn '{type: "assistant", uuid: "a-1", turnPosition: null, message: {role: "assistant",
        content: [{type: "tool_use", id: "toolu_1", name: "Bash", input: {command: "make release"}}]}}' ;;
      record) jq -cn '{type: "assistant", uuid: "a-6", message: {role: "assistant",
        content: [{type: "tool_use", id: "toolu_1", name: "mcp__atrium-queue__record", input: {form: "nothing"}}]}}' ;;
      post | lastpost) jq -cn --argjson isLast "$([[ "${token}" == lastpost ]] && echo true || echo false)" \
        '{type: "assistant", uuid: "a-8", message: {role: "assistant", content: [{type: "tool_use", id: "toolu_1",
          name: "mcp__atrium-queue__post", input: ({kind: "report", title: "Build done", body: "All green."}
            + if $isLast then {lastAct: true} else {} end)}]}}' ;;
      clirecord | clipending)
        command="${TURN_QUEUE_CLI} ${token#cli}"
        [[ "${token}" == clipending ]] || command+=" nothing"
        jq -cn --arg command "${command}" '{type: "assistant", uuid: "a-7", message: {role: "assistant",
          content: [{type: "tool_use", id: "toolu_1", name: "Bash", input: {command: $command}}]}}'
        ;;
      result) jq -cn '{type: "user", uuid: "r-1", message: {role: "user",
        content: [{type: "tool_result", tool_use_id: "toolu_1", content: "build ok"}]}}' ;;
      text) jq -cn '{type: "assistant", uuid: "a-2", message: {role: "assistant",
        content: [{type: "text", text: "The build passed."}]}}' ;;
      bigtext) jq -cn --arg text "${big// /x}" '{type: "assistant", uuid: "a-3",
        message: {role: "assistant", content: [{type: "text", text: $text}]}}' ;;
      feedback) jq -cn '{type: "user", uuid: "f-1", isMeta: true,
        message: {role: "user", content: "Stop hook feedback:\nQueue record (harness)"}}' ;;
      compact:*) jq -cn --arg uuid "${token#compact:}" --arg at "${TURN_COMPACTED_AT}" '{type: "user", uuid: $uuid,
        timestamp: $at, isCompactSummary: true,
        turnPosition: {promptIndex: 0, turnIndex: 1},
        message: {role: "user", content: "Summary of the earlier conversation"}}' ;;
      nullmessage) jq -cn '{type: "assistant", uuid: "a-4", message: null, error: "tool_use"}' ;;
      stringmessage) jq -cn '{type: "assistant", uuid: "a-5", message: "tool_use"}' ;;
      *) return 1 ;;
    esac >>"${path}"
  done
}
