#!/usr/bin/env bats
# daemon-cycle-apply-status.bats — pins the composed apply-health write (T-B4) in the CYCLE DRIVER.
#
# WHY: the run record is written BEFORE the apply stage runs and its status derives solely from
# per-patch generation errors, so an aborted apply stage reached no operator surface — the cycle
# rendered green while nothing was applied. The driver now folds the apply rc into that record after
# the stage returns. What is pinned here is the DRIVER's half of the contract: which status token it
# sends, when it sends nothing at all, and that it is sequenced past the tail push. The SQL CASE that
# preserves a patch-generation failure lives in the helper and is pinned with the helper.
#
# ACs pinned here:
#   AC1  an aborted apply on an otherwise dispatched cycle sends apply_status=apply_failed.
#   AC2  a clean apply sends apply_status=ok.
#   AC3  the compose write is the LAST daemon_runs write of the dispatch — a non-full mode's tail
#        push runs post-apply, so an earlier placement would be blind-overwritten.
#   AC4  a dispatch that never ran the apply stage writes no apply health at all.
#   AC5  a helper/DB failure degrades the cycle (non-zero exit) without crashing it.
#   AC6  a DB whose enum lacks the composed label skips the write with a notice naming the missing
#        migration, and the cycle stays rc 0 — an uncoupled write would error every single cycle.
#   AC7  a DB that HAS the label still composes — the coupling is a gate on evidence, not a blanket
#        skip.
#   AC8  an unprobeable enum warns loudly and composes anyway — only absence is evidence.
#
# Run via: bats autoagent/test/daemon-cycle-apply-status.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3
#
# Hermetic: a mktemp "real tree" holds a COPIED driver plus STUB stages, and a fake HOME supplies the
# stub dual-write helper. Nothing under the live tree or the live DB is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DRIVER="${GA}/autoagent/daemon-cycle.sh"

setup() {
  [[ -f "${REAL_DRIVER}" ]] || skip "daemon-cycle.sh not found: ${REAL_DRIVER}"
  WORK="$(cd -- "$(mktemp -d -t daemon-cycle-apply-status.XXXXXX)" && pwd -P)"
  FAKE_HOME="${WORK}/home"
  ENVELOPE_LOG="${WORK}/envelopes.jsonl"
  CALL_LOG="${WORK}/calls.log"
  mkdir -p -- "${FAKE_HOME}/.glass-atrium/scripts" "${WORK}/real/autoagent" "${WORK}/bin"
  DRIVER="${WORK}/real/autoagent/daemon-cycle.sh"
  cp -p -- "${REAL_DRIVER}" "${DRIVER}"
  OUT_JSON="${WORK}/cycle.json"
  printf '%s\n' '{"patches": []}' >"${OUT_JSON}"
  # The driver probes the DB for the composed enum label before writing. Default the seam to a
  # migrated DB so the ACs that are not ABOUT the probe keep asserting the write, and so no test in
  # this file can reach a real psql (the hermetic claim above).
  make_psql_stub present
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# make_stage_stubs — the driver resolves daemon_cycle.py / daemon-apply.sh relative to its own dir,
# so the sandbox copies get stubs that record their invocation. $1 = the apply stub's exit code.
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

# make_helper — stub dual-write helper at the HOME-anchored path the driver invokes. Records every
# envelope it is handed (one JSON line each) and exits $1, so a failing DB is simulated by a code.
make_helper() {
  local code="$1"
  cat >"${FAKE_HOME}/.glass-atrium/scripts/_pg_dual_write_daemon.py" <<EOF
import sys
open("${ENVELOPE_LOG}", "a").write(sys.stdin.read().strip() + "\n")
sys.exit(${code})
EOF
}

# make_push_helper — stub pg-push helper. It writes an envelope line of its own so the ORDER of the
# two daemon_runs writers is observable (AC3).
make_push_helper() {
  cat >"${FAKE_HOME}/.glass-atrium/scripts/_pg_push_autoagent_cycle.py" <<EOF
open("${ENVELOPE_LOG}", "a").write('{"op":"write_daemon_run","args":{"source":"pg_push"}}\n')
EOF
}

# make_psql_stub — the enum-presence probe's seam. $1: present (label in the enum) · absent
# (migration unapplied) · fail (catalog query errored, e.g. an unreachable DB). PATH-prepended by
# run_driver, so the probe resolves to this stub and never to a real psql.
make_psql_stub() {
  local body
  case "$1" in
    present) body='printf "1\n"' ;;
    absent) body='printf "0\n"' ;;
    fail) body='printf "psql: error: connection to server failed\n" >&2; exit 2' ;;
    *) return 1 ;;
  esac
  cat >"${WORK}/bin/psql" <<EOF
#!/usr/bin/env bash
${body}
EOF
  chmod +x "${WORK}/bin/psql"
}

# --out (not the OUT_PATH env var): the driver initialises OUT_PATH to empty before arg-parse, so an
# inherited env value is discarded and the daily report path would be used instead of the fixture.
run_driver() {
  run env HOME="${FAKE_HOME}" AUTOAGENT_PYTHON_BIN=python3 PATH="${WORK}/bin:${PATH}" \
    bash "${DRIVER}" --out "${OUT_JSON}" "$@"
}

# The apply_status value of the single compose envelope (empty when none was sent).
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

# ── AC1 — an aborted apply composes the degraded value ────────────────────────────────────────

@test "AC1: an aborted apply stage sends apply_status=apply_failed" {
  make_stage_stubs 16
  make_helper 0
  run_driver --apply-only
  [[ "$(compose_status)" == "apply_failed" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    echo "driver output: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"APPLY_STATUS start"* ]] || return 1
}

# ── AC2 — a clean apply composes the clean value ──────────────────────────────────────────────

@test "AC2: a clean apply stage sends apply_status=ok" {
  make_stage_stubs 0
  make_helper 0
  run_driver --apply-only
  [[ "$(compose_status)" == "ok" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    return 1
  }
}

# ── AC3 — the compose write is sequenced past the tail push ───────────────────────────────────

@test "AC3: the compose write is the LAST daemon_runs write of the dispatch" {
  make_stage_stubs 16
  make_helper 0
  make_push_helper
  run_driver --apply-only
  local order
  order="$(python3 - "${ENVELOPE_LOG}" <<'PY'
import json, sys
ops = [json.loads(l)["op"] for l in open(sys.argv[1]) if l.strip()]
print(",".join(ops))
PY
)"
  # The apply-only tail push runs AFTER the apply stage; a compose placed before it would be
  # blind-overwritten by that pre-apply status. Both writers must appear, in this order — asserting
  # only "compose is last" would also pass if the push had never run at all.
  [[ "${order}" == "write_daemon_run,compose_daemon_run_apply_status" ]] || {
    echo "envelope order: ${order} — log: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    return 1
  }
}

# ── AC4 — a dispatch without an apply stage asserts nothing about apply health ────────────────

@test "AC4: a mode that never ran the apply stage writes no apply health" {
  make_stage_stubs 0
  make_helper 0
  run_driver --cycle-only
  [[ -z "$(compose_status)" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    return 1
  }
  [[ "${output}" != *"APPLY_STATUS start"* ]] || return 1
}

# ── AC5 — a failed compose write degrades the cycle without crashing it ───────────────────────

@test "AC5: a helper/DB failure degrades the cycle instead of crashing it" {
  make_stage_stubs 0
  make_helper 4 # named helper exit for a PG write failure after the retry
  run_driver --apply-only
  # degraded, not crashed: the driver still reached its own end-of-run reporting.
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"APPLY_STATUS end rc=4"* ]] || {
    echo "driver output: ${output}" >&2
    return 1
  }
}

# ── AC6 — an unapplied migration skips the write loudly, never errors it ──────────────────────

@test "AC6: a DB lacking the composed enum label skips the write and names the migration" {
  # A CLEAN apply is the sharp case: PostgreSQL resolves the cast when it PLANS the statement, so a
  # pre-migration DB errors even on the cycle that composes 'ok'. A clean stage also leaves the
  # compose as the only possible rc contributor, which is what makes the rc assertion below mean
  # anything.
  make_stage_stubs 0
  make_helper 0
  make_psql_stub absent
  run_driver --apply-only
  # no envelope: the statement the helper would run cannot be PLANNED on this DB.
  [[ -z "$(compose_status)" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    return 1
  }
  # loud, and actionable — the notice names the migration the operator has to apply.
  [[ "${output}" == *"APPLY_STATUS SKIP enum=absent"* ]] || {
    echo "driver output: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"20260802000000_add_daemon_status_apply_failed"* ]] || return 1
  # a skip is not a failure: an uncoupled write would fold a non-zero rc in every single cycle.
  [[ "${status}" -eq 0 ]] || {
    echo "driver exited ${status} — output: ${output}" >&2
    return 1
  }
}

# ── AC7 — a migrated DB still composes ────────────────────────────────────────────────────────

@test "AC7: a DB carrying the enum label still composes the apply health" {
  make_stage_stubs 16
  make_helper 0
  make_psql_stub present
  run_driver --apply-only
  [[ "$(compose_status)" == "apply_failed" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    return 1
  }
  [[ "${output}" != *"APPLY_STATUS SKIP enum=absent"* ]] || {
    echo "coupling degenerated into a blanket skip — output: ${output}" >&2
    return 1
  }
}

# ── AC8 — an unprobeable enum is not evidence of absence ──────────────────────────────────────

@test "AC8: a failed presence probe warns loudly and composes anyway" {
  make_stage_stubs 0
  make_helper 0
  make_psql_stub fail
  run_driver --apply-only
  # only ABSENCE is evidence — an unreachable DB must not silently disable apply-health recording.
  [[ "$(compose_status)" == "ok" ]] || {
    echo "envelopes: $(cat "${ENVELOPE_LOG}" 2>&1)" >&2
    echo "driver output: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"APPLY_STATUS WARN enum=unknown"* ]] || {
    echo "unprobeable enum was silent — output: ${output}" >&2
    return 1
  }
}
