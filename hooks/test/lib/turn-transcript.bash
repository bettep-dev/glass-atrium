#!/usr/bin/env bash
# turn-transcript.bash — the transcript-entry builder shared by the suites that read a turn through
# hooks/lib/reply_language.py; one copy of the host's measured turn shape (shared-hook-capability-contract.md →
# Stop row). Callers source it at file scope.

# <path> <token>... → writes <path>, one entry per token, oldest first: start:<uuid> and notify:<uuid> open a turn (a
# prompt, a task notification) · tool · result · text · bigtext (about 2 KB) · feedback (the isMeta Stop hook feedback
# entry) · compact:<uuid> (a compaction summary, carrying the turn position of the turn start it follows) ·
# nullmessage and stringmessage (an assistant entry whose message is no object); non-zero on an unknown token
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
      compact:*) jq -cn --arg uuid "${token#compact:}" '{type: "user", uuid: $uuid, isCompactSummary: true,
        turnPosition: {promptIndex: 0, turnIndex: 1},
        message: {role: "user", content: "Summary of the earlier conversation"}}' ;;
      nullmessage) jq -cn '{type: "assistant", uuid: "a-4", message: null, error: "tool_use"}' ;;
      stringmessage) jq -cn '{type: "assistant", uuid: "a-5", message: "tool_use"}' ;;
      *) return 1 ;;
    esac >>"${path}"
  done
}
