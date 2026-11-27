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
marker_key="$(hook_path_safe_key "${AGENT_ID}")"

# Status 0 once the marker is gone; a refused path or a failed delete counts as kept (DATA-075).
delete_live_child_marker() {
  local marker="${1:-}"
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${marker}"; then
    rm -f -- "${marker:?}"
    return
  fi
  return 1
}

readonly ORPHAN_LIST_MAX=10

# ORPHAN-ADV-001 — listing only: nothing is signalled or removed, the stop being the orchestrator's
# close-out act (scripts/prune-worktrees.sh). The stopped agent's worktrees are the writer locks it held;
# an agent that held none (Bash-only writes, read-only work, a lock past its TTL) gets no listing rather
# than a machine-wide scan.
# Args: $1=agent id, then the worktree roots its locks named · stderr only, exit status ignored by the caller.
list_orphan_processes() {
  local agent_id="${1}" script
  shift
  get_orphan_roots "$@"
  ((${#orphan_roots[@]} > 0)) || return 0
  # shellcheck disable=SC2310  # no cwd listing → no advisory
  worktree_get_processes "${orphan_roots[@]}" || return 0
  build_orphan_lines
  ((orphan_total > 0)) || return 0
  script="$(cd -P -- "${BASH_SOURCE%/*}/.." && pwd -P)/scripts/prune-worktrees.sh"
  (printf '%s\n' \
    "[agent-tracker] ORPHAN-ADV-001 ADVISORY ONLY — ${orphan_total} process(es) still run inside the worktree of stopped agent ${agent_id}; nothing was stopped; a listed process may belong to a live agent that holds no lock, and the close-out script decides:${orphan_lines}" \
    "  close-out (dry run; --apply stops them): ${script} ${orphan_roots[*]}") >&2 || true
}

# Sets orphan_roots: the canonical spelling (the one lsof reports) of each LINKED worktree among $@ —
# a main checkout also holds the session's own processes, which are no orphans.
get_orphan_roots() {
  local root canonical
  orphan_roots=()
  for root in "$@"; do
    [[ -f "${root}/.git" ]] || continue
    canonical="$(cd -P -- "${root}" 2>/dev/null && pwd -P)" || continue
    orphan_roots+=("${canonical}")
  done
}

# Sets orphan_lines (one "  pid= cmd= cwd=" line each, at most ORPHAN_LIST_MAX, then "and N more") and
# orphan_total from worktree_processes_out. This hook's own chain ($$, its parent, the session) is skipped.
build_orphan_lines() {
  local entry pid cwd cmd
  orphan_lines=""
  orphan_total=0
  for entry in "${worktree_processes_out[@]+"${worktree_processes_out[@]}"}"; do
    IFS=$'\x1f' read -r pid cwd cmd <<<"${entry}"
    case " $$ ${PPID} ${CLAUDE_PID:-} " in
      *" ${pid} "*) continue ;;
      *) ;;
    esac
    orphan_total=$((orphan_total + 1))
    ((orphan_total <= ORPHAN_LIST_MAX)) || continue
    orphan_lines+=$'\n'"  pid=${pid} cmd=${cmd} cwd=${cwd}"
  done
  ((orphan_total <= ORPHAN_LIST_MAX)) || orphan_lines+=$'\n'"  and $((orphan_total - ORPHAN_LIST_MAX)) more"
}

if [[ -n "${marker_key}" ]]; then
  case "${HOOK_EVENT}" in
    SubagentStart)
      if ! { mkdir -p "${LIVE_CHILD_DIR}" 2>/dev/null && : >"${LIVE_CHILD_DIR}/${marker_key}"; }; then
        emit_error "DATA-074" "warn" \
          "live-child marker write failed — the commit-time live-child advisory will under-report" \
          "Check permissions/free space on ${LIVE_CHILD_DIR}" \
          "{\"event\":\"${HOOK_EVENT}\",\"marker\":\"${marker_key}\"}"
      fi
      ;;
    SubagentStop)
      # shellcheck disable=SC2310  # the delete's status IS the DATA-075 branch — set -e disable intended
      if [[ -e "${LIVE_CHILD_DIR}/${marker_key}" ]] && ! delete_live_child_marker "${LIVE_CHILD_DIR}/${marker_key}"; then
        emit_error "DATA-075" "warn" \
          "live-child marker delete failed — a stale marker will over-report until its TTL expires" \
          "Remove ${LIVE_CHILD_DIR}/${marker_key} manually" \
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
      # shellcheck disable=SC2310  # advisory only: a failed listing prints nothing and never costs the lifecycle row
      list_orphan_processes "${AGENT_ID}" \
        "${worktree_lock_released_roots[@]+"${worktree_lock_released_roots[@]}"}" || true
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
