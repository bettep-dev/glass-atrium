#!/usr/bin/env bash
# SubagentStart/SubagentStop — per-agent tracking: agent ID, type, start/end time, duration.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

# PG core.agent_events is the single sink; HOOK_EVENT/AGENT_ID/AGENT_TYPE/TIMESTAMP feed the write.
HOOK_EVENT=$(hook_get_field "${INPUT}" "hook_event_name")
[[ -z "${HOOK_EVENT}" ]] && HOOK_EVENT=$(hook_get_field "${INPUT}" "hook_event")
AGENT_ID=$(hook_get_field "${INPUT}" "agent_id")
AGENT_TYPE=$(hook_get_field "${INPUT}" "agent_type")
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

[[ -z "${HOOK_EVENT}" ]] && HOOK_EVENT="unknown"
[[ -z "${AGENT_ID}" ]] && AGENT_ID="unknown"

# Disambiguate a missing agent_type by HOOK_EVENT: (a) main-session events (Stop/PreCompact/
# SessionStart) legitimately lack it → 'orchestrator'; (b) SubagentStop gap (agent_id present,
# agent_type missing) → 'unknown' (a genuine subagent metadata gap, not the main session).
case "${HOOK_EVENT}" in
  SubagentStart | SubagentStop)
    [[ -z "${AGENT_TYPE}" ]] && AGENT_TYPE="unknown"
    ;;
  *)
    # Stop / PreCompact / SessionStart / unknown — main session (registered events only).
    [[ -z "${AGENT_TYPE}" ]] && AGENT_TYPE="orchestrator"
    ;;
esac

emit_error "DATA-073" "info" \
  "Agent lifecycle event recorded" \
  "N/A (automatic)" \
  "{\"event\":\"$HOOK_EVENT\",\"agent_type\":\"$AGENT_TYPE\"}"

# PHASE1-DUALWRITE-BEGIN
# Write the lifecycle event into core.agent_events (same envelope contract as cost-tracker; see
# _pg_dual_write.py header). A PG failure is tolerated with structured stderr + a best-effort
# hook_failures counter (non-blocking). PG_HELPER: sibling-of-this-script resolution, passed via env
# because __file__ is absent under `python3 -c`.
TIMESTAMP="${TIMESTAMP}" \
  HOOK_EVENT="${HOOK_EVENT}" \
  AGENT_ID="${AGENT_ID}" \
  AGENT_TYPE="${AGENT_TYPE}" \
  PG_HELPER="${BASH_SOURCE%/*}/_pg_dual_write.py" \
  python3 -c '
import json, os, subprocess, sys
row = {
    "event_ts": os.environ["TIMESTAMP"],
    "event_name": os.environ["HOOK_EVENT"][:64],
    "agent_id": os.environ["AGENT_ID"],
    "agent_type": os.environ["AGENT_TYPE"][:64],
}
envelope = {
    "hook_name": "agent-tracker",
    "target_table": "core.agent_events",
    "payload_ref": os.environ["AGENT_ID"][:128],
    "row": row,
}
helper = os.environ["PG_HELPER"]
subprocess.run(
    ["python3", helper],
    input=json.dumps(envelope),
    text=True,
    timeout=5,
)
sys.exit(0)
' >&2 || true
# PHASE1-DUALWRITE-END

exit 0
