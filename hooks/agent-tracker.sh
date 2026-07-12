#!/usr/bin/env bash
# SubagentStart/SubagentStop — per-agent tracking: agent ID, type, start/end time, duration.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

# ONE interpreter pass parses the lifecycle fields, applies the agent_type
# disambiguation, and prints two lines: a TAB-joined "<event>\t<agent_type>" log
# tuple (consumed by emit_error below) then the core.agent_events envelope handed
# straight to _pg_dual_write.py's single-row path. Replaces the prior 4x
# hook_get_field field-extract spawns + a redundant envelope-building wrapper
# interpreter (5 python3 per fire -> 2). A parse failure loud-fails to stderr and
# exits nonzero; the `|| exit 0` keeps the hook non-blocking without swallowing the
# signal. Values cross via os.environ, never shell expansion (SC2016 pattern).
# shellcheck disable=SC2016
PARSED=$(TIMESTAMP="${TIMESTAMP}" python3 -c '
import json, os, sys

try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        raise ValueError("hook input is not a JSON object")
except Exception as exc:
    sys.stderr.write(json.dumps({
        "hook": "agent-tracker",
        "error_kind": "parse_error",
        "message": str(exc),
    }) + "\n")
    sys.exit(1)

hook_event = d.get("hook_event_name") or d.get("hook_event") or "unknown"
agent_id = d.get("agent_id") or "unknown"
agent_type = d.get("agent_type") or ""
# Disambiguate a missing agent_type by event: main-session events (Stop/PreCompact/
# SessionStart) legitimately lack it -> orchestrator; a SubagentStart/Stop gap ->
# unknown (a genuine subagent metadata gap, not the main session).
if not agent_type:
    agent_type = "unknown" if hook_event in ("SubagentStart", "SubagentStop") else "orchestrator"

envelope = {
    "hook_name": "agent-tracker",
    "target_table": "core.agent_events",
    "payload_ref": agent_id[:128],
    "row": {
        "event_ts": os.environ["TIMESTAMP"],
        "event_name": hook_event[:64],
        "agent_id": agent_id,
        "agent_type": agent_type[:64],
    },
}
# Line 1: TAB-joined log tuple for the bash emit_error (single-token controlled
# values; strip stray tab/newline so the parameter-expansion split stays aligned).
log_event = hook_event.replace("\t", " ").replace("\n", " ")
log_type = agent_type.replace("\t", " ").replace("\n", " ")
sys.stdout.write(log_event + "\t" + log_type + "\n")
# Line 2: the single-row envelope handed straight to the writer below.
sys.stdout.write(json.dumps(envelope) + "\n")
' <<<"${INPUT}") || exit 0

# Split the parse-pass output with pure parameter expansion (set -e safe, no
# subprocess): line 1 = "<event>\t<agent_type>" log tuple, line 2 = the PG envelope.
LOG_TUPLE="${PARSED%%$'\n'*}"
ENVELOPE="${PARSED#*$'\n'}"
HOOK_EVENT="${LOG_TUPLE%%$'\t'*}"
AGENT_TYPE="${LOG_TUPLE#*$'\t'}"

emit_error "DATA-073" "info" \
  "Agent lifecycle event recorded" \
  "N/A (automatic)" \
  "{\"event\":\"${HOOK_EVENT}\",\"agent_type\":\"${AGENT_TYPE}\"}"

# PHASE1-DUALWRITE-BEGIN
# Hand the single row straight to _pg_dual_write.py's single-row ("row") path. A PG
# failure loud-fails inside the helper (structured stderr + best-effort
# hook_failures) and is tolerated non-blocking here. psycopg connects via the
# Unix socket only — never -h/-p (see _pg_dual_write.py header).
printf '%s' "${ENVELOPE}" | python3 "${BASH_SOURCE%/*}/_pg_dual_write.py" >&2 || true
# PHASE1-DUALWRITE-END

exit 0
