#!/usr/bin/env bats
# track-outcome-effort-tier.bats — the recorder's effort-tier reader over the row's own transcript.
#
# Relationship: the recorded tier is the last non-null `effort` on an `assistant` record in
# transcript order; has_mixed_effort is true only when more than one distinct tier appeared; a
# transcript with no assistant-carried tier records null for both. Other record types are never
# read, so every fixture plants a non-assistant `effort` that a type-blind reader would return.
#
# Isolation: the sibling recorder harness (track-outcome-style-ref-empty-history.bats) — HOME
# sandboxed, dual-write stubbed by a PATH python3 shim so the envelope spools, no PG contact.

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  ET_TMP="$(mktemp -d -t track-effort.XXXXXX)"
  SANDBOX_HOME="${ET_TMP}/home"
  mkdir -p "${SANDBOX_HOME}/.claude/logs"

  SHIM_DIR="${ET_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' '    *_pg_outcome_dualwrite.py) cat >/dev/null; exit 6 ;;'
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"
}

teardown() {
  if ga_guard_path "${ET_TMP:-}"; then rm -rf -- "${ET_TMP:?}"; fi
}

# $1 = fixture shape, $2 = output path. The [COMPLETION] block travels in the payload's
# last_assistant_message, so each transcript holds only the records the reader is judged on.
write_fixture() {
  python3 - "${1}" "${2}" <<'PY'
import json, sys

shape, path = sys.argv[1], sys.argv[2]
OPUS = "claude-opus-5-5"
HAIKU = "claude-haiku-4-5-20251001"


def user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def attachment(effort=None):
    rec = {"type": "attachment", "attachment": {"type": "todo_reminder", "content": []}}
    if effort is not None:
        rec["effort"] = effort
    return rec


def assistant(model, effort=None, tool="Read"):
    rec = {"type": "assistant", "message": {"role": "assistant", "model": model,
           "content": [{"type": "tool_use", "id": "toolu_" + tool, "name": tool,
                        "input": {"file_path": "/repo/hooks/a.sh"}}]}}
    if effort is not None:
        rec["effort"] = effort
    return rec


def synthetic_notice():
    return {"type": "assistant", "message": {"role": "assistant", "model": "<synthetic>",
            "content": [{"type": "text", "text": "Session limit reached"}]}}


SHAPES = {
    "mixed": [
        user("delegation prompt"), attachment(), attachment(),
        assistant(OPUS, "high", "Read"), assistant(OPUS, None, "Grep"),
        assistant(OPUS, "xhigh", "Edit"), assistant(OPUS, None, "Bash"),
        attachment("low"),
    ],
    "single": [
        user("delegation prompt"), attachment(),
        assistant(OPUS, "high", "Read"), assistant(OPUS, None, "Grep"),
        assistant(OPUS, "high", "Edit"), attachment("max"),
    ],
    "haiku-only": [
        user("delegation prompt"), attachment(),
        assistant(HAIKU, None, "Read"), assistant(HAIKU, None, "Edit"), attachment("low"),
    ],
    "synthetic-only": [user("delegation prompt"), synthetic_notice(), attachment("low")],
    "no-assistant": [user("delegation prompt"), attachment("low"), attachment()],
}

with open(path, "w", encoding="utf-8") as f:
    for rec in SHAPES[shape]:
        f.write(json.dumps(rec) + "\n")
PY
}

completion_text() {
  printf '%s\n' '[COMPLETION]' 'result: done' 'task_type: bug-fix' 'metric_pass: true' \
    'confidence: high' 'files: hooks/a.sh' 'summary: fixed a' '[/COMPLETION]'
}

# $1 = fixture shape. Runs the hook on a fresh agent id + spool, then prints the spooled
# envelope as `effort|has_mixed_effort|body Effort line` (null / none when absent).
record_shape() {
  local shape="${1}" aid sess tdir spool payload envelope
  aid="effaid${$}x${RANDOM}"
  sess="sess-eff-$$-${RANDOM}"
  tdir="${SANDBOX_HOME}/.claude/projects/proj/${sess}/subagents"
  spool="${ET_TMP}/spool-${shape}"
  payload="${ET_TMP}/payload-${shape}.json"
  mkdir -p "${tdir}"
  write_fixture "${shape}" "${tdir}/agent-${aid}.jsonl" || return 1
  jq -nc --arg aid "${aid}" --arg sess "${sess}" --arg msg "$(completion_text)" '{
    hook_event_name: "SubagentStop", agent_type: "glass-atrium-dev-shell",
    agent_id: $aid, session_id: $sess, last_assistant_message: $msg,
    transcript_path: "/nonexistent/parent.jsonl"
  }' >"${payload}"

  run env HOME="${SANDBOX_HOME}" PATH="${SHIM_DIR}:${PATH}" CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" STYLE_REF_READCACHE_OFF="1" OUTCOME_SPOOL_DIR="${spool}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${payload}"
  [[ "${status}" -eq 0 ]] || {
    echo "hook exit ${status}: ${output}"
    return 1
  }

  envelope="$(find "${spool}" -type f 2>/dev/null | head -1)"
  [[ -n "${envelope}" ]] || {
    echo "no spooled envelope: ${output}"
    return 1
  }
  jq -r '.outcome
    | [ (.effort | if . == null then "null" else tostring end),
        (.has_mixed_effort | if . == null then "null" else tostring end),
        ((.body_md // "") | split("\n") | map(select(startswith("- **Effort**:"))) | .[0] // "none") ]
    | join("|")' "${envelope}"
}

@test "recorded tier is the last non-null assistant effort, flagged when tiers differ, null when none" {
  local rows row name shape want got
  rows=(
    "mixed tiers among gaps and attachments|mixed|xhigh|true|- **Effort**: xhigh (mixed tiers)"
    "one tier with gaps and a trailing attachment|single|high|false|- **Effort**: high"
    "Haiku-only transcript carries no tier|haiku-only|null|null|none"
    "<synthetic>-only transcript carries no tier|synthetic-only|null|null|none"
    "zero assistant records|no-assistant|null|null|none"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name shape want <<<"${row}"
    got="$(record_shape "${shape}")" || {
      echo "${name}: ${got}"
      return 1
    }
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: want '${want}', got '${got}'"
      return 1
    }
  done
}
