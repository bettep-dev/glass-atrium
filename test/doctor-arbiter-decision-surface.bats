#!/usr/bin/env bats
# doctor-arbiter-decision-surface.bats — pins run_doctor §18 (contested-gap arbitration surface).
#
# The plan process writes one decision record per contested EDITABLE gap under the update state dir
# and the verify process replays it. A record carrying a failure class is a gap the arbiter did not
# answer: the merge keeps the local run, which is a correct outcome and a silent one. §18 is what
# makes that silence answerable, and the unanswered case is the LIVE state while the model seam is
# exhausted — so the failure row here is DRIVEN through the producer rather than hand-planted.
#
# Each row asserts a token or a property the others must not produce:
#   AC1  a driven model-unavailable record -> warn naming the failure class, the agent AND the
#        region ordinal, after the directory the drive ran in is removed
#   AC2  no records at all                 -> ok (a different token), no warn of this section
#   AC3  a resolved record                 -> info naming the choice, and NO unanswered warn
#   AC4  exit status                       -> IDENTICAL with and without an unanswered record
#   AC5  the field names §18 reads         -> the ones the producer's record writer emits
#   AC6  a second plan run                 -> one record per gap key, rewritten, never appended
#
# Every model seam is a nonexistent binary: no drive invokes the headless CLI, and the missing-binary
# early exit IS the model-unavailable class this suite needs.
#
# Hermetic: GA_ROOT is a throwaway sandbox passed to ga_init_env in a subprocess; the target home,
# runtime-data root and update state dir are temp dirs; the manifest generator path does not exist
# (§8 hashing skipped) and the monitor port is dead (§16 curls nothing).
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
# Every assertion `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats test/doctor-arbiter-decision-surface.bats
# Requires: bats >= 1.5.0, jq, python3, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  [[ -f "${GA}/autoagent/lib/editable_merge.py" ]] || skip "editable_merge.py not found"

  SANDBOX="$(mktemp -d -t ga-doctor-arbiter-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STATE_DIR="${SANDBOX}/state"
  RECORD_DIR="${STATE_DIR}/arbiter-decisions"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STATE_DIR}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Drive the PRODUCER: one contested gap through the plan-mode arbiter with the model seam pointed at
# a path that does not exist, which is the missing-binary early exit and so the model-unavailable
# class. Runs inside a scratch dir that is then removed, reproducing the sequence the record's siting
# exists for — the merge scratch is gone by the time any health check reads.
# $1 = agent · $2 = region ordinal · $3 = region count
drive_unavailable_record() {
  local scratch
  scratch="$(mktemp -d -t ga-arbiter-scratch.XXXXXX)"
  (
    cd -- "${scratch}" || exit 1
    PYTHONPATH="${GA}/autoagent/lib:${GA}/autoagent" \
      ATRIUM_UPDATE_STATE_DIR="${STATE_DIR}" \
      AUTOAGENT_CLAUDE_BIN="${SANDBOX}/no-such-claude-binary" \
      python3 - "$1" "$2" "$3" <<'PY' 2>/dev/null
import sys

import editable_merge as em

agent, region_index, region_count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
hunk = em.ConflictHunk(
    out_index=0,
    base=("base line",),
    local=("local line",),
    release=("release line",),
)
arbiter = em.GapArbiter(f"agents/{agent}.md", agent, mode=em.ARBITER_PLAN)
arbiter.get_gap_outcome(
    region_index=region_index,
    region_count=region_count,
    gap_index=0,
    hunk=hunk,
    context="region context",
)
PY
  )
  local rc=$?
  rm -rf -- "${scratch}"
  return "${rc}"
}

# Hand-write one RESOLVED record. The producer cannot supply this one under an exhausted model seam,
# so AC5 pins this fixture's field names against the producer's record writer instead.
seed_resolved_record() {
  mkdir -p -- "${RECORD_DIR}"
  cat >"${RECORD_DIR}/agents_glass-atrium-dev-a.md-abc123def456.r1.g0.json" <<'JSON'
{
  "target": "agents/glass-atrium-dev-a.md",
  "agent": "glass-atrium-dev-a",
  "region_index": 1,
  "region_count": 3,
  "gap_index": 0,
  "choice": "INTERLEAVE",
  "refs": ["L1", "R1"],
  "rationale": "both sides carry a distinct clause",
  "failure_class": null,
  "clause": null,
  "fingerprints": {"base": "aa", "local": "bb", "release": "cc"}
}
JSON
}

run_doctor_sandbox() {
  run env GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${STATE_DIR}" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC1 — the driven unavailable record is surfaced with its agent and region ordinal ──────────

@test "AC1: a driven model-unavailable gap warns with its class, agent and region ordinal" {
  drive_unavailable_record "glass-atrium-dev-shell" 2 3 || {
    echo "the plan-mode drive failed to run" >&2
    return 1
  }
  [[ -d "${RECORD_DIR}" ]] || {
    echo "the drive wrote no record under ${RECORD_DIR}" >&2
    return 1
  }
  run_doctor_sandbox
  assert_output_has "warn : contested gap unanswered — model-unavailable" || return 1
  assert_output_has "agent=glass-atrium-dev-shell" || return 1
  assert_output_has "region=2/3" || return 1
  assert_output_has "remedy: the named gap(s) kept the local run" || return 1
  assert_output_lacks "ok   : no contested-gap decision records" || return 1
}

# ── AC2 — no records is a different token, and raises nothing ──────────────────────────────────

@test "AC2: no decision records emits ok and no gap warning" {
  run_doctor_sandbox
  assert_output_has "ok   : no contested-gap decision records" || return 1
  assert_output_lacks "contested gap unanswered" || return 1
  assert_output_lacks "contested gap arbiter-resolved" || return 1
}

# ── AC3 — a resolved record reports the choice, and is not an unanswered gap ───────────────────

@test "AC3: a resolved record emits info naming its choice, not a warning" {
  seed_resolved_record
  run_doctor_sandbox
  assert_output_has "info : contested gap arbiter-resolved — INTERLEAVE" || return 1
  assert_output_has "agent=glass-atrium-dev-a" || return 1
  assert_output_has "region=1/3" || return 1
  assert_output_lacks "contested gap unanswered" || return 1
  assert_output_lacks "ok   : no contested-gap decision records" || return 1
}

# ── AC4 — advisory means the exit status does not move ─────────────────────────────────────────

@test "AC4: an unanswered gap changes no exit status" {
  run_doctor_sandbox
  local empty_status="${status}"
  assert_output_lacks "contested gap unanswered" || return 1

  drive_unavailable_record "glass-atrium-dev-shell" 1 1 || return 1
  run_doctor_sandbox
  assert_output_has "contested gap unanswered" || return 1
  [[ "${status}" -eq "${empty_status}" ]] || {
    echo "an unanswered gap moved the exit status: ${empty_status} -> ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC5 — the fields §18 reads are the ones the producer writes ────────────────────────────────

@test "AC5: every record field the doctor reads is emitted by the producer's record writer" {
  local producer="${GA}/autoagent/lib/editable_merge.py" field
  # Read from the record-writing function only: a field name that merely occurs somewhere in the
  # module would pass this while the record carried nothing.
  local writer
  writer="$(sed -n '/def _set_record/,/^    def /p' "${producer}")"
  for field in target agent region_index region_count choice failure_class; do
    [[ "${writer}" == *"\"${field}\":"* ]] || {
      echo "the producer's record writer emits no '${field}' field — §18 reads a field that is never written" >&2
      return 1
    }
  done
  # and the doctor reads each of them
  local reader="${GA}/lib/ga-doctor.sh"
  for field in failure_class agent region_index region_count target choice; do
    grep -q -- "\.${field}" "${reader}" || {
      echo "§18 does not read the recorded field '${field}'" >&2
      return 1
    }
  done
}

# ── AC6 — a gap's record is rewritten under its key, so presence is the LAST outcome ───────────

@test "AC6: a second plan run rewrites the gap's record rather than appending another" {
  drive_unavailable_record "glass-atrium-dev-shell" 1 1 || return 1
  drive_unavailable_record "glass-atrium-dev-shell" 1 1 || return 1
  local count
  count="$(find "${RECORD_DIR}" -name '*.json' -type f | wc -l | tr -d ' ')"
  [[ "${count}" -eq 1 ]] || {
    echo "expected one record for one gap key after two runs, found ${count}" >&2
    find "${RECORD_DIR}" -name '*.json' -type f >&2
    return 1
  }
  run_doctor_sandbox
  local warned
  warned="$(printf '%s\n' "${output}" | grep -c "contested gap unanswered" || true)"
  [[ -z "${warned}" ]] && warned=0
  [[ "${warned}" -eq 1 ]] || {
    echo "expected one unanswered row for one gap, got ${warned} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}
