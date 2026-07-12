#!/usr/bin/env bats
# track-outcome-transcript-parse-once.bats — PERF-INVARIANT for the single-parse consolidation
# (doc#4 T9). track-outcome.sh formerly open()+json.loads'd the SUBAGENT's OWN transcript up to
# FOUR times per SubagentStop fire (terminal-text ~ _last_assistant_text_from_transcript, tool_use
# count ~ count_tool_use_current_turn, write-targets ~ collect_write_targets_current_turn, and the
# StructuredOutput classification ~ _read_transcript_items). They now share ONE memoized parse
# (_read_subagent_transcript_once). This suite proves the subagent transcript is open()'d EXACTLY
# ONCE on the common (settled, non-race) path.
#
# Division of proof: the byte-identical OUTCOME (result/task_type/metric_pass/confidence/attribution)
# is pinned by the 4 sibling suites (schema-mode-completion / budget-truncation / transcript-source /
# workflow-root-synthesis, incl. the RACE flush-race retry). THIS suite proves the PERF property they
# do not measure — a revert to the 4-open form would land 3-4 here and fail.
#
# Method: a sitecustomize.py shim on PYTHONPATH wraps builtins.open and appends one line to a counter
# file for every open() whose path ends in the subagent transcript basename. CPython auto-imports
# sitecustomize at interpreter startup, so the shim is active for the hook's python3 subprocess
# WITHOUT touching production code. The parent-transcript T9 synthesis read (/nonexistent/parent.jsonl)
# and the PG helper never open this basename, so the count isolates the subagent-transcript opens in
# the main parser block. DB-free: PG is fail-opened (PGHOST → nonexistent socket); the assertion reads
# the open counter + the stderr parse_tier diagnostic, no live DB required.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  PO_TMP="$(mktemp -d)"
  AGENT_ID="poagent${$}x${RANDOM}"
  SESSION_ID="sess-po-$$-${RANDOM}"
  UNIQUE_AGENT="smoke-po-$$-${RANDOM}"

  SANDBOX_HOME="${PO_TMP}/home"
  # Subagent transcript at the exact path _resolve_subagent_transcript() globs. Project-dir slug
  # derived from the runtime HOME (the resolver globs projects/*/, so any slug works) — a hardcoded
  # literal would be PII in the tracked tree (pii-scan gate).
  PROJ_SLUG="${HOME//\//-}"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/${PROJ_SLUG}/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"
  TRANSCRIPT_BASENAME="agent-${AGENT_ID}.jsonl"

  PAYLOAD_FILE="${PO_TMP}/payload.json"
  OPEN_COUNT_FILE="${PO_TMP}/opens.log"

  # sitecustomize open()-counter shim (auto-imported by CPython's site machinery when on PYTHONPATH).
  SHIM_DIR="${PO_TMP}/pyshim"
  mkdir -p "${SHIM_DIR}"
  cat >"${SHIM_DIR}/sitecustomize.py" <<'PY'
import builtins
import os

_real_open = builtins.open
_counter = os.environ.get("OPEN_COUNT_FILE", "")
_target = os.environ.get("OPEN_COUNT_TARGET", "")


def _counting_open(file, *a, **k):
    # Record only opens of the subagent transcript basename. Uses the REAL open for the
    # counter write (no recursion), and the counter path never ends in _target (no self-count).
    try:
        if _counter and _target and isinstance(file, str) and file.endswith(_target):
            with _real_open(_counter, "a", encoding="utf-8") as _cf:
                _cf.write(file + "\n")
    except Exception:
        pass
    return _real_open(file, *a, **k)


builtins.open = _counting_open
PY
}

teardown() {
  if [[ -n "${PO_TMP:-}" && -d "${PO_TMP}" ]]; then
    rm -rf "${PO_TMP}"
  fi
}

# Common-path block-then-emit transcript: a full [COMPLETION] TEXT turn before a terminal consumed
# StructuredOutput (parse_tier=1). Written WITHOUT the shim (setup-time helper), so this write is
# never counted.
write_transcript_block() {
  python3 - "${TRANSCRIPT}" "${UNIQUE_AGENT}" <<'PY'
import json
import sys
path, agent = sys.argv[1], sys.argv[2]
completion = (
    "[COMPLETION]\n"
    "result: done\n"
    "task_type: research\n"
    "metric_pass: true\n"
    "confidence: high\n"
    f"summary: parse-once common path for {agent}\n"
    "[/COMPLETION]"
)
SO_ID = "toolu_po_so01"
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the work"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "Working."}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_po_bash", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_po_bash", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": SO_ID, "name": "StructuredOutput",
                     "input": {"done": True}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": SO_ID, "content": "ok"}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# Common-path synthesis transcript: NO [COMPLETION] and NO StructuredOutput (parse_tier=3). The SO
# classifier reaches its DEFINITIVE non-SO verdict on the shared cached parse (no retry, no re-read).
write_transcript_no_so() {
  python3 - "${TRANSCRIPT}" <<'PY'
import json
import sys
path = sys.argv[1]
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the work"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": "Working, no completion block."}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_po_bash", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_po_bash", "content": "ok"}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# SubagentStop payload WITHOUT last_assistant_message and WITHOUT inline messages — forces every
# collector to source from the subagent transcript. agent_type present ⇒ no sidecar recovery open.
write_payload() {
  jq -nc \
    --arg aid "${AGENT_ID}" \
    --arg sess "${SESSION_ID}" \
    --arg agent "${UNIQUE_AGENT}" \
    --arg cwd "${HOME}" \
    '{
      hook_event_name: "SubagentStop",
      agent_type: $agent,
      agent_id: $aid,
      session_id: $sess,
      cwd: $cwd,
      transcript_path: "/nonexistent/parent.jsonl"
    }' >"${PAYLOAD_FILE}"
}

# Drive the hook under the open-counting shim, PG fail-opened, stderr merged into stdout.
run_hook() {
  : >"${OPEN_COUNT_FILE}"
  run env \
    HOME="${SANDBOX_HOME}" \
    PYTHONPATH="${SHIM_DIR}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    OPEN_COUNT_FILE="${OPEN_COUNT_FILE}" \
    OPEN_COUNT_TARGET="${TRANSCRIPT_BASENAME}" \
    SUBAGENT_TOOL_BUDGET_DIR="${PO_TMP}/budget" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# Count recorded opens of the subagent transcript (one line per open). Empty file ⇒ 0.
open_count() {
  local n=0
  if [[ -f "${OPEN_COUNT_FILE}" ]]; then
    n=$(wc -l <"${OPEN_COUNT_FILE}")
  fi
  printf '%s\n' "$((n))"
}

@test "common path (parse_tier=1 block-then-emit): subagent transcript open()'d EXACTLY ONCE" {
  write_transcript_block
  write_payload
  run_hook
  [ "${status}" -eq 0 ] || return 1
  # Confirm we exercised the transcript-source common path (not an inline/short-circuit).
  [[ "${output}" == *"msg sourced from transcript fallback"* ]] || return 1
  [[ "${output}" == *"parse_tier=1"* ]] || return 1
  # The invariant: one open shared by terminal-text + tool_use + write-targets (SO returns early
  # on parse_tier!=3, no read). The pre-consolidation form opened 3x here.
  run open_count
  [ "${output}" = "1" ] || return 1
}

@test "synthesis path (parse_tier=3, no StructuredOutput): subagent transcript open()'d EXACTLY ONCE" {
  write_transcript_no_so
  write_payload
  run_hook
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"parse_tier=3"* ]] || return 1
  # SO classification attempt-0 uses the shared cached parse and settles DEFINITIVELY (terminal is a
  # non-SO tool_use, tail not partial) ⇒ no re-read. The pre-consolidation form opened 4x here.
  run open_count
  [ "${output}" = "1" ] || return 1
}
