#!/usr/bin/env bats
# daemon-cycle-doctor-stage.bats — pins the TERMINAL DOCTOR STAGE in the cycle driver (T3-1).
#
# WHY: no scheduled job invokes the doctor — eight launchd jobs were enumerated and none of them runs
# it — so a verdict exists only when an operator asks for one, and every honesty fix that landed INTO
# the doctor is read by nobody unattended. The cycle is the scheduled carrier that already writes a
# durable per-cycle report, so the stage is terminal and its verdict is folded into that report.
#
# The load-bearing polarity is AC3: the doctor is an OBSERVABILITY surface. A verdict that reddened
# the apply loop would convert a reporting tool into an outage source, so a failing doctor must leave
# the apply stage's own composed outcome untouched.
#
# ACs pinned here (plan 774 T3-1):
#   AC1 (T3-1.a) a completed cycle ran the doctor and its verdict is durable outside the run log.
#   AC2 (T3-1.b) a FAILING verdict is recorded and the cycle still completes.
#   AC3 (T3-1.c) a failing doctor leaves the apply stage's composed outcome unchanged.
#   AC4 (T3-1.d) a clean verdict is recorded and raises no failure — a stage that always escalates
#                is a new surface that gets tuned out.
#   AC5 (T3-1.e) the stage runs through the driver's non-fatal fold: a non-zero doctor produces a
#                COMPLETED cycle whose aggregate reflects it, never an aborted one.
#   AC6          an entry point that is absent — or present with its executable bit cleared — skips
#                loudly and keeps the cycle clean. The stage must not become the new silent failure it
#                was added to remove, and a mode-644 entry is the condition the apply stage's own
#                unavailability flag already exists to name.
#   T3-1.f (absorption annotation) is NOT duplicated here: scripts/test/audit-absorption.bats plus the
#   blocking CI auditor step already run the auditor over its own scope list, which carries this
#   driver. A second copy here would red THIS suite for an unrelated file's finding.
#
# Run via: bats autoagent/test/daemon-cycle-doctor-stage.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3
#
# Hermetic: a mktemp "real tree" holds a COPIED driver, a STUB doctor entry point beside it, stub
# stages, a fake HOME for the dual-write helper, and a fixture bin for every binary the driver
# resolves. No live tree, no live DB, and the real doctor is never executed.
#
# STAGE-ABSENT GUARD: each case probes the driver's own stage line first and SKIPS when the terminal
# doctor stage is not present. autoagent/test/ is inside the green-suite preflight gate, so a suite
# that reddened on an unlanded stage would abort the live apply — the guard makes this suite inert
# until the stage lands and self-arming the moment it does.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DRIVER="${GA}/autoagent/daemon-cycle.sh"

setup() {
  [[ -f "${REAL_DRIVER}" ]] || skip "daemon-cycle.sh not found: ${REAL_DRIVER}"
  WORK="$(cd -- "$(mktemp -d -t daemon-cycle-doctor-stage.XXXXXX)" && pwd -P)"
  FAKE_HOME="${WORK}/home"
  ENVELOPE_LOG="${WORK}/envelopes.jsonl"
  CALL_LOG="${WORK}/calls.log"
  mkdir -p -- "${FAKE_HOME}/.glass-atrium/scripts" "${WORK}/real/autoagent" "${WORK}/bin"
  DRIVER="${WORK}/real/autoagent/daemon-cycle.sh"
  cp -p -- "${REAL_DRIVER}" "${DRIVER}"
  # The report the cycle writes IS the durable channel the verdict lands in, so it has to exist for
  # the same reason it exists on a real cycle: the cycle stage wrote it before the terminal stage runs.
  OUT_JSON="${WORK}/cycle.json"
  printf '%s\n' '{"patches": []}' >"${OUT_JSON}"
  make_stage_stubs 0
  make_helper 0
  make_psql_stub
  make_claude_stub
  make_doctor_stub 0
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# make_stage_stubs — the driver resolves daemon_cycle.py / daemon-apply.sh relative to its own dir.
# $1 = the apply stub's exit code.
make_stage_stubs() {
  local apply_code="$1"
  cat >"${WORK}/real/autoagent/daemon_cycle.py" <<EOF
import sys
open("${CALL_LOG}", "a").write("cycle-py %s\n" % " ".join(sys.argv[1:]))
EOF
  cat >"${WORK}/real/autoagent/daemon-apply.sh" <<EOF
#!/usr/bin/env bash
printf 'apply-stub\n' >>"${CALL_LOG}"
exit ${apply_code}
EOF
  chmod +x "${WORK}/real/autoagent/daemon-apply.sh"
}

# make_doctor_stub — the harness entry point beside the driver's own root (SCRIPT_DIR is <ga>/autoagent,
# so the doctor entry resolves to <ga>/glass-atrium). Records its invocation and exits $1, so a red
# install is simulated by a code rather than by an actual unhealthy fixture tree.
make_doctor_stub() {
  local code="$1"
  cat >"${WORK}/real/glass-atrium" <<EOF
#!/usr/bin/env bash
printf 'doctor-stub %s\n' "\$*" >>"${CALL_LOG}"
printf '  ok   : doctor stub\n' >&2
exit ${code}
EOF
  chmod +x "${WORK}/real/glass-atrium"
}

# make_helper — stub dual-write helper at the HOME-anchored path the driver invokes. Records every
# envelope it is handed and exits $1.
make_helper() {
  local code="$1"
  cat >"${FAKE_HOME}/.glass-atrium/scripts/_pg_dual_write_daemon.py" <<EOF
import sys
open("${ENVELOPE_LOG}", "a").write(sys.stdin.read().strip() + "\n")
print("0")
sys.exit(${code})
EOF
}

# make_psql_stub — the enum-presence probe's seam, answering with every composable label so the cases
# in this file are never gated on a probe they are not about. PATH-prepended, so no real psql is reached.
make_psql_stub() {
  cat >"${WORK}/bin/psql" <<'EOF'
#!/usr/bin/env bash
req=""
for arg in "$@"; do
  case "${arg}" in
    lbls=*) req="${arg#lbls=}" ;;
  esac
done
IFS=','
for lbl in ${req}; do
  printf '%s\n' "${lbl}"
done
EOF
  chmod +x "${WORK}/bin/psql"
}

# make_claude_stub — the driver resolves the claude CLI at LOAD time and exits 4 when it finds none,
# dying before any stage this file is about. Never executed: an invocation means a stub was bypassed.
make_claude_stub() {
  cat >"${WORK}/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'claude stub invoked — this suite must never reach an LLM\n' >&2
exit 1
EOF
  chmod +x "${WORK}/bin/claude"
}

# --out (not the OUT_PATH env var): the driver initialises OUT_PATH to empty before arg-parse, so an
# inherited env value is discarded. AUTOAGENT_CLAUDE_BIN is unset because an ambient value
# short-circuits the resolution the stub feeds.
run_driver() {
  run env -u AUTOAGENT_CLAUDE_BIN \
    HOME="${FAKE_HOME}" AUTOAGENT_PYTHON_BIN=python3 PATH="${WORK}/bin:${PATH}" \
    bash "${DRIVER}" --out "${OUT_JSON}" "$@"
}

# Behavioural presence probe: the stage announces itself on every path it takes (verdict, skip), so
# its absence is observable without reading the driver's source.
require_doctor_stage() {
  [[ "${output}" == *"stage=doctor"* ]] || skip "terminal doctor stage absent from the driver (T3-1 unlanded)"
}

# The verdict token recorded in the per-cycle report (empty when the report carries none).
report_verdict() {
  python3 - "${OUT_JSON}" <<'PY'
import json, sys
try:
    report = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
doctor = report.get("doctor") or {}
print(doctor.get("verdict", ""))
PY
}

# The apply_status value of the compose envelope (empty when none was sent).
compose_status() {
  [[ -f "${ENVELOPE_LOG}" ]] || return 0
  python3 - "${ENVELOPE_LOG}" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    row = json.loads(line)
    if row.get("op") == "compose_daemon_run_apply_status":
        print(row["args"]["apply_status"])
PY
}

# ── AC1 — the doctor runs unattended and its verdict outlives the run log ─────────────────────

@test "AC1: a completed cycle runs the doctor and records the verdict in the per-cycle report" {
  run_driver --apply-only
  require_doctor_stage
  # ran: the finding is that nothing invokes it, so an unread verdict token would prove nothing.
  grep -q '^doctor-stub doctor$' "${CALL_LOG}" || {
    echo "call log: $(cat "${CALL_LOG}" 2>&1)" >&2
    echo "driver output: ${output}" >&2
    return 1
  }
  # durable: the token is in the report the cycle already writes, NOT only on the evaporating stderr.
  [[ "$(report_verdict)" == "pass" ]] || {
    echo "report: $(cat "${OUT_JSON}" 2>&1)" >&2
    return 1
  }
}

# ── AC2 — a red verdict is recorded and the cycle still finishes ──────────────────────────────

@test "AC2: a failing doctor verdict is recorded and the cycle still completes" {
  make_doctor_stub 1
  run_driver --apply-only
  require_doctor_stage
  [[ "$(report_verdict)" == "fail" ]] || {
    echo "report: $(cat "${OUT_JSON}" 2>&1)" >&2
    echo "driver output: ${output}" >&2
    return 1
  }
  # completed, not aborted — the driver reached its own end-of-run reporting line.
  [[ "${output}" == *"cycle finished"* ]] || {
    echo "driver output: ${output}" >&2
    return 1
  }
}

# ── AC3 — the load-bearing polarity: a red doctor never reddens the apply loop ────────────────

@test "AC3: a failing doctor leaves the apply stage's composed outcome unchanged" {
  make_stage_stubs 0
  make_doctor_stub 1
  run_driver --apply-only
  require_doctor_stage
  # the apply stage ran and succeeded, so its composed health is `ok` — a doctor verdict that
  # re-labelled it would turn an observability surface into an apply outage.
  [[ "$(compose_status)" == "ok" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    echo "driver output: ${output}" >&2
    return 1
  }
  grep -q '^apply-stub$' "${CALL_LOG}" || return 1
  [[ "${output}" != *"stage=apply rc=1"* ]] || {
    echo "doctor rc leaked into the apply stage — output: ${output}" >&2
    return 1
  }
}

# ── AC4 — a clean verdict escalates nothing ───────────────────────────────────────────────────

@test "AC4: a clean doctor verdict is recorded and raises no failure" {
  run_driver --apply-only
  require_doctor_stage
  [[ "$(report_verdict)" == "pass" ]] || {
    echo "report: $(cat "${OUT_JSON}" 2>&1)" >&2
    return 1
  }
  [[ "${status}" -eq 0 ]] || {
    echo "clean cycle exited ${status} — output: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"DEGRADED"* ]] || {
    echo "clean doctor degraded the cycle — output: ${output}" >&2
    return 1
  }
}

# ── AC5 — non-fatal fold: the aggregate reflects it, the run is not aborted ───────────────────

@test "AC5: a non-zero doctor degrades the cycle's aggregate without aborting the run" {
  make_doctor_stub 2
  run_driver --apply-only
  require_doctor_stage
  # folded: the same aggregate every other stage feeds, so the cycle reports degraded (exit 1).
  [[ "${status}" -eq 1 ]] || {
    echo "driver exited ${status} — output: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"cycle finished DEGRADED"* ]] || {
    echo "driver output: ${output}" >&2
    return 1
  }
  # not fatal: every earlier stage still ran to completion and the verdict still landed.
  [[ "$(compose_status)" == "ok" ]] || return 1
  [[ "$(report_verdict)" == "fail" ]] || {
    echo "report: $(cat "${OUT_JSON}" 2>&1)" >&2
    return 1
  }
}

# ── AC6 — an install without the entry point is a loud skip, not a new silence ────────────────

@test "AC6: an absent or non-executable doctor entry point skips loudly and keeps the cycle clean" {
  rm -f -- "${WORK}/real/glass-atrium"
  run_driver --apply-only
  require_doctor_stage
  [[ "${output}" == *"stage=doctor SKIP"* ]] || {
    echo "driver output: ${output}" >&2
    return 1
  }
  [[ "${status}" -eq 0 ]] || {
    echo "a missing entry point degraded the cycle — exit ${status}, output: ${output}" >&2
    return 1
  }
  # a cleared executable bit is the SAME condition, and it is the one an interpreter prefix would
  # hide: `bash <entry>` runs a file no operator can run, reporting health from an install that is
  # in fact broken.
  make_doctor_stub 0
  chmod 644 "${WORK}/real/glass-atrium"
  run_driver --apply-only
  [[ "${output}" == *"stage=doctor SKIP"* && "${output}" == *"not executable"* ]] || {
    echo "driver output: ${output}" >&2
    return 1
  }
  [[ "${status}" -eq 0 ]] || {
    echo "a non-executable entry point degraded the cycle — exit ${status}" >&2
    return 1
  }
}
