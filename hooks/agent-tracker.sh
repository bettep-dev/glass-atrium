#!/usr/bin/env bash
# SubagentStart/SubagentStop — per-agent tracking: agent ID, type, start/end time, duration.
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source-path=SCRIPTDIR source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"
# shellcheck source-path=SCRIPTDIR source=lib/worktree-lock.sh
source "${BASH_SOURCE%/*}/lib/worktree-lock.sh"

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

# ONE interpreter pass parses the lifecycle fields, applies the agent_type
# disambiguation, and prints two lines: a TAB-joined
# "<event>\t<agent_type>\t<agent_id>" log tuple (consumed by emit_error and the
# live-child marker below) then the core.agent_events envelope handed
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
log_aid = agent_id.replace("\t", " ").replace("\n", " ")
sys.stdout.write(log_event + "\t" + log_type + "\t" + log_aid + "\n")
# Line 2: the single-row envelope handed straight to the writer below.
sys.stdout.write(json.dumps(envelope) + "\n")
' <<<"${INPUT}") || exit 0

# Split the parse-pass output with pure parameter expansion (set -e safe, no
# subprocess): line 1 = "<event>\t<agent_type>\t<agent_id>" log tuple, line 2 = the
# PG envelope.
LOG_TUPLE="${PARSED%%$'\n'*}"
ENVELOPE="${PARSED#*$'\n'}"
IFS=$'\t' read -r HOOK_EVENT AGENT_TYPE AGENT_ID <<<"${LOG_TUPLE}"

# --- C1-H/C2-H live-child marker (ADVISORY OBSERVABILITY ONLY) -----------------
# One empty file per live subagent: created on SubagentStart, removed on SubagentStop.
# enforce-commit-guard.sh reads the directory to note that a child MAY still be
# running when the orchestrator commits.
# HONEST BACKING: this marker does NOT enforce the worktree-isolation rule and must
# never be described as doing so. SubagentStart's hook observe surface is agent_type
# and agent_id ONLY (shared-hook-capability-contract.md), so the writer structurally
# cannot record WHERE its child runs — the marker answers "is a child live", never
# "is a child live in THIS worktree", and it therefore false-positives on exactly the
# correctly-isolated configuration the rule encourages. Pure bash by design: the
# hook's 2-python3-per-fire perf invariant is pinned by agent-tracker.bats.
live_child_dir="${HOOK_DATA_DIR}/live-children"
marker_key="$(hook_path_safe_key "${AGENT_ID}")"
if [[ -n "${marker_key}" ]]; then
  case "${HOOK_EVENT}" in
    SubagentStart)
      if ! { mkdir -p "${live_child_dir}" 2>/dev/null && : >"${live_child_dir}/${marker_key}"; }; then
        emit_error "DATA-074" "warn" \
          "live-child marker write failed — the commit-time live-child advisory will under-report" \
          "Check permissions/free space on ${live_child_dir}" \
          "{\"event\":\"${HOOK_EVENT}\",\"marker\":\"${marker_key}\"}"
      fi
      ;;
    SubagentStop)
      if [[ -e "${live_child_dir}/${marker_key}" ]] && ! rm -f "${live_child_dir}/${marker_key}" 2>/dev/null; then
        emit_error "DATA-075" "warn" \
          "live-child marker delete failed — a stale marker will over-report until its TTL expires" \
          "Remove ${live_child_dir}/${marker_key} manually" \
          "{\"event\":\"${HOOK_EVENT}\",\"marker\":\"${marker_key}\"}"
      fi
      # Release arm of the per-worktree writer lock (lib/worktree-lock.sh; the acquire arm is
      # advisory-worktree-writer-lock.sh). Keyed on the agent_id, which is the holder record — never
      # marker_key, whose sanitizer is lossy and would miss the lock it means to free.
      # worktree_lock_holder_id is what makes the two arms agree: AGENT_ID is already this hook's
      # `unknown` sentinel when the envelope carried no id, and the acquire arm stamped that same
      # case as "orchestrator" — releasing the raw sentinel simply never matched, leaving an id-less
      # lock to its 6h TTL. The PG row above deliberately keeps the raw `unknown`; only the LOCK
      # identity folds.
      # Pure bash + one rm per match: this hook's 2-python3-per-fire budget is pinned by
      # agent-tracker.bats, which is also why the lock's TTL is evaluated at acquire, not here.
      # SC2310: the release is a predicate whose rc 1 IS the loud-warn branch — set -e disable intended.
      worktree_lock_holder_id "${AGENT_ID}"
      # shellcheck disable=SC2310
      if ! worktree_lock_release_by_holder "${worktree_lock_holder_id_out}"; then
        emit_error "DATA-076" "warn" \
          "worktree writer-lock release failed — the stale lock will over-warn until its TTL expires" \
          "Remove the holder-matching lock dir under ${WORKTREE_LOCK_ROOT} manually" \
          "{\"event\":\"${HOOK_EVENT}\",\"agent_key\":\"${marker_key}\"}"
      fi
      ;;
    *) ;; # main-session events (Stop/PreCompact/SessionStart) hold no live-child marker
  esac
fi

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
