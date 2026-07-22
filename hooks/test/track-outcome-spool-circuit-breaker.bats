#!/usr/bin/env bats
# track-outcome-spool-circuit-breaker.bats — pins T10 (outcome dead-letter spool) + T9 (recovery-loop
# circuit-breaker) in track-outcome.sh.
#
# T10: the DB dual-write formerly ran under `| python3 helper || true`, so a non-zero helper exit (DB
# unreachable / write-failed) was swallowed and the outcome was permanently, silently lost. The fix
# captures the exit code: non-zero → spool the envelope to a bounded on-disk dir; a later success →
# drain it. T9: a per-agent consecutive-fail counter records a spawn-readable suspension signal at the
# threshold and resets on any non-fail — the Failure Recovery Loop's circuit-breaker had no backing code.
#
# The DB helper is stubbed by a PATH python3 shim whose exit code is driven by STUB_PG_EXIT, so a write
# outage is simulated deterministically without a live Postgres. The hook is invoked DIRECTLY as a
# command (via its shebang), never interpreter-prefixed. TRACK_OUTCOME_SH lets a fail-at-HEAD run point
# the same suite at the pre-fix hook copy.

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"
PG_HELPER_SRC="${BATS_TEST_DIRNAME}/../_pg_outcome_dualwrite.py"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  [[ -x "${PG_HELPER_SRC}" ]] || skip "_pg_outcome_dualwrite.py not executable: ${PG_HELPER_SRC}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  SCB_TMP="$(mktemp -d -t track-scb.XXXXXX)"
  UNIQUE_AGENT="scb-$$-${RANDOM}"
  AGENT_ID="scbaid${$}x${RANDOM}"
  SESSION_ID="sess-scb-$$-${RANDOM}"

  SANDBOX_HOME="${SCB_TMP}/home"
  PROJ_SLUG="${SANDBOX_HOME//\//-}"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/${PROJ_SLUG}/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"
  PAYLOAD_FILE="${SCB_TMP}/payload.json"

  # Explicit sandbox state dirs (the hook's own defaults already resolve under the sandboxed HOME,
  # but pinning them keeps assertions self-documenting).
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  CB_DIR="${SANDBOX_HOME}/.claude/data/agent-circuit-breaker"

  # PATH python3 shim — stubs ONLY the dual-write helper (exit driven by STUB_PG_EXIT), passes all
  # other python3 calls (timestamp, transcript parse) through to the real interpreter.
  SHIM_DIR="${SCB_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' '    *_pg_outcome_dualwrite.py) cat >/dev/null; exit "${STUB_PG_EXIT:-0}" ;;'
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"
}

teardown() {
  [[ -n "${SCB_TMP:-}" && -d "${SCB_TMP}" ]] && rm -rf -- "${SCB_TMP}" || true
}

# Synthetic subagent transcript ending in a terminal [COMPLETION] with the given result, preceded by a
# tool_use so the turn is deliverable-producing (not conversation-only).
write_transcript() {
  local result="${1:-done}"
  "${REAL_PY3}" - "${TRANSCRIPT}" "${UNIQUE_AGENT}" "${result}" <<'PY'
import json, sys
path, agent, result = sys.argv[1], sys.argv[2], sys.argv[3]
completion = (
    "[COMPLETION]\n"
    f"result: {result}\n"
    "task_type: review\n"
    "metric_pass: false\n"
    "confidence: low\n"
    f"summary: spool/circuit-breaker outcome for {agent}\n"
    "[/COMPLETION]"
)
rows = [
    {"type": "user", "message": {"role": "user", "content": "run the review"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

write_payload() {
  jq -nc \
    --arg aid "${AGENT_ID}" \
    --arg sess "${SESSION_ID}" \
    --arg agent "${UNIQUE_AGENT}" \
    --arg cwd "${SANDBOX_HOME}" \
    '{
      hook_event_name: "SubagentStop",
      agent_type: $agent,
      agent_id: $aid,
      session_id: $sess,
      cwd: $cwd,
      transcript_path: "/nonexistent/parent.jsonl"
    }' >"${PAYLOAD_FILE}"
}

# Invoke the hook DIRECTLY (shebang), never `bash <hook>`. STUB_PG_EXIT + the spool/breaker knobs are
# read from the calling test's shell vars.
run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    STUB_PG_EXIT="${STUB_PG_EXIT:-0}" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    OUTCOME_SPOOL_MAX_ENTRIES="${SPOOL_MAX:-100}" \
    OUTCOME_SPOOL_MAX_AGE_DAYS="${SPOOL_MAX_AGE:-7}" \
    OUTCOME_SPOOL_DRAIN_BATCH="${SPOOL_BATCH:-25}" \
    CIRCUIT_BREAKER_DIR="${CB_DIR}" \
    CIRCUIT_BREAKER_THRESHOLD="${CB_THRESHOLD:-3}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

spool_count() {
  find "${SPOOL_DIR}" -type f 2>/dev/null | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
# T10 — dead-letter spool
# ---------------------------------------------------------------------------

@test "T10 AC1: a failed DB write spools the envelope and the hook still exits 0" {
  write_transcript done
  write_payload
  STUB_PG_EXIT=6
  run_hook
  [ "${status}" -eq 0 ] || { echo "hook exit ${status}: ${output}"; return 1; }

  local n; n="$(spool_count)"
  [ "${n}" = "1" ] || { echo "expected 1 spool entry, got ${n}"; find "${SPOOL_DIR}" -type f; return 1; }

  # The spooled file is the valid outcome envelope for THIS run (recoverable, not opaque bytes).
  local sf got
  sf="$(find "${SPOOL_DIR}" -type f | head -1)"
  got="$("${REAL_PY3}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["outcome"]["agent"])' "${sf}" 2>/dev/null)" || {
    echo "spool file is not a valid envelope: ${sf}"; return 1;
  }
  [ "${got}" = "${UNIQUE_AGENT}" ] || { echo "spool agent '${got}' != '${UNIQUE_AGENT}'"; return 1; }
}

@test "T10 AC2: a successful write drains a non-empty spool (each entry removed on confirmed write)" {
  write_transcript done
  write_payload

  # Phase 1 — two induced failures populate the spool.
  STUB_PG_EXIT=6
  run_hook
  [ "${status}" -eq 0 ] || { echo "fail-run-1 exit ${status}: ${output}"; return 1; }
  run_hook
  [ "${status}" -eq 0 ] || { echo "fail-run-2 exit ${status}: ${output}"; return 1; }
  local n1; n1="$(spool_count)"
  [ "${n1}" = "2" ] || { echo "expected 2 spooled entries, got ${n1}"; return 1; }

  # Phase 2 — a successful write drains the spool.
  STUB_PG_EXIT=0
  run_hook
  [ "${status}" -eq 0 ] || { echo "drain-run exit ${status}: ${output}"; return 1; }
  local n2; n2="$(spool_count)"
  [ "${n2}" = "0" ] || { echo "spool not drained, ${n2} entries remain"; find "${SPOOL_DIR}" -type f; return 1; }
}

@test "T10 AC3: spool over the count bound evicts oldest-first and records the count" {
  write_transcript done
  write_payload
  mkdir -p "${SPOOL_DIR}"

  # Pre-seed 3 recent-but-ordered entries (distinct epoch prefixes within the age window).
  local now; now="$(date +%s)"
  : >"${SPOOL_DIR}/$((now - 30))-seedA"
  : >"${SPOOL_DIR}/$((now - 20))-seedB"
  : >"${SPOOL_DIR}/$((now - 10))-seedC"

  # A failed write adds a 4th (newest) entry; MAX=2 → evict the 2 oldest.
  STUB_PG_EXIT=6
  SPOOL_MAX=2
  run_hook
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  local n; n="$(spool_count)"
  [ "${n}" = "2" ] || { echo "expected 2 survivors, got ${n}"; find "${SPOOL_DIR}" -type f; return 1; }

  # Oldest-first: seedA + seedB evicted, seedC survives.
  [ ! -e "${SPOOL_DIR}/$((now - 30))-seedA" ] || { echo "oldest seedA not evicted"; return 1; }
  [ ! -e "${SPOOL_DIR}/$((now - 20))-seedB" ] || { echo "2nd-oldest seedB not evicted"; return 1; }
  [ -e "${SPOOL_DIR}/$((now - 10))-seedC" ] || { echo "seedC wrongly evicted"; return 1; }

  # The removed count is recorded (T10 AC3).
  printf '%s\n' "${output}" | grep -q 'DATA-072' || { echo "no DATA-072 eviction record"; return 1; }
}

@test "T10 AC3: entries older than the max age are pruned" {
  write_transcript done
  write_payload
  mkdir -p "${SPOOL_DIR}"

  # An ancient entry (epoch 10^9 = 2001) — far beyond any max-age window.
  : >"${SPOOL_DIR}/1000000000-ancient"

  STUB_PG_EXIT=6
  SPOOL_MAX=100
  run_hook
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [ ! -e "${SPOOL_DIR}/1000000000-ancient" ] || { echo "ancient entry not age-pruned"; return 1; }
  printf '%s\n' "${output}" | grep -q 'DATA-072' || { echo "no DATA-072 record for the aged prune"; return 1; }
}

@test "T10 AC4: an uncreatable spool dir drops the write with a named code and exits 0" {
  write_transcript done
  write_payload

  # A regular file where a parent dir must be → mkdir -p fails (ENOTDIR).
  : >"${SANDBOX_HOME}/blocker"
  SPOOL_DIR="${SANDBOX_HOME}/blocker/spool"
  STUB_PG_EXIT=6
  run_hook
  [ "${status}" -eq 0 ] || { echo "hook must exit 0 on uncreatable spool: ${status} ${output}"; return 1; }

  printf '%s\n' "${output}" | grep -q 'DATA-071' || { echo "no DATA-071 uncreatable-dir record"; return 1; }
}

@test "T12 Site C: a present-but-unwritable spool dir emits DATA-080 (distinct from DATA-071), drops the write, exits 0" {
  write_transcript done
  write_payload

  # The spool DIR exists (spool_dir_ensure's `-d` test passes → not the DATA-071 uncreatable path), but
  # is not writable, so the per-entry mktemp inside spool_write fails — the distinct write-failure branch.
  mkdir -p "${SPOOL_DIR}"
  chmod 0555 "${SPOOL_DIR}"
  STUB_PG_EXIT=6
  run_hook
  chmod 0755 "${SPOOL_DIR}" 2>/dev/null || true
  [ "${status}" -eq 0 ] || { echo "hook must exit 0 on a failed spool write: ${status} ${output}"; return 1; }

  local n; n="$(spool_count)"
  [ "${n}" = "0" ] || { echo "expected the write to be dropped (0 entries), got ${n}"; return 1; }

  printf '%s\n' "${output}" | grep -q 'DATA-080' || { echo "no DATA-080 spool-write-failure record"; return 1; }
  # It must NOT be misreported as the uncreatable-dir case.
  ! printf '%s\n' "${output}" | grep -q 'DATA-071' || { echo "wrongly emitted DATA-071 for a present dir"; return 1; }
}

# ---------------------------------------------------------------------------
# T9 — recovery-loop circuit-breaker
# ---------------------------------------------------------------------------

@test "T9 AC1: consecutive fails reaching the threshold write a spawn-readable suspension signal" {
  write_transcript fail
  write_payload
  CB_THRESHOLD=2

  # First fail — below threshold, no suspension yet.
  run_hook
  [ "${status}" -eq 0 ] || { echo "fail-1 exit ${status}: ${output}"; return 1; }
  local s1; s1="$(find "${CB_DIR}" -name '*.suspended' 2>/dev/null | wc -l | tr -d ' ')"
  [ "${s1}" = "0" ] || { echo "suspended before threshold"; return 1; }

  # Second fail — reaches the threshold, a suspension signal is recorded.
  run_hook
  [ "${status}" -eq 0 ] || { echo "fail-2 exit ${status}: ${output}"; return 1; }
  local sf; sf="$(find "${CB_DIR}" -name '*.suspended' 2>/dev/null | head -1)"
  { [ -n "${sf}" ] && [ -s "${sf}" ]; } || { echo "no suspension signal at threshold"; find "${CB_DIR}" -type f; return 1; }

  # The signal is a readable record naming the fail count (consumable at spawn).
  "${REAL_PY3}" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert int(d["consecutive_fails"])>=2' "${sf}" || {
    echo "suspension signal missing consecutive_fails>=2"; cat "${sf}"; return 1;
  }
}

@test "T9 AC2: a non-fail outcome resets the counter and clears the suspension" {
  write_payload
  CB_THRESHOLD=2

  # Trip the breaker with two fails.
  write_transcript fail
  run_hook
  run_hook
  local sf; sf="$(find "${CB_DIR}" -name '*.suspended' 2>/dev/null | head -1)"
  [ -n "${sf}" ] || { echo "breaker did not trip during setup"; find "${CB_DIR}" -type f; return 1; }

  # A non-fail outcome clears both the counter and the suspension.
  write_transcript done
  run_hook
  [ "${status}" -eq 0 ] || { echo "reset-run exit ${status}: ${output}"; return 1; }

  local susp cnt
  susp="$(find "${CB_DIR}" -name '*.suspended' 2>/dev/null | wc -l | tr -d ' ')"
  cnt="$(find "${CB_DIR}" -name '*.fails' 2>/dev/null | wc -l | tr -d ' ')"
  [ "${susp}" = "0" ] || { echo "suspension not cleared on non-fail"; return 1; }
  [ "${cnt}" = "0" ] || { echo "fail counter not reset on non-fail"; return 1; }
}
