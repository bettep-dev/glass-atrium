#!/usr/bin/env bats
# Category-3 conversion suite (silent-fail absorption triage) — pins the
# reporting-channel family in wiki-daily-compile.sh + daemon-daily-restart.sh:
# a failed PG daemon-run report must surface on stderr AND land a durable record
# on the pg-report-drops sink (AC-2), while never changing the caller's exit
# contract (AC-3). Every assertion here fails against the pre-conversion `|| true`
# shape, which exits clean and writes no marker.
# Hermetic: unit tests awk-extract the sink + writer functions into a sourceable
# shim; full-flow tests copy wiki-daily-compile.sh + lib/atrium-config.sh into a
# sandbox with a PG helper stub that always exits 1, HOME/GA_DATA_ROOT/WIKI_ROOT
# all inside the sandbox. No live install, PG connection, or real log is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
RESTART_SCRIPT="${GA}/scripts/daemon-daily-restart.sh"
WIKI_SCRIPT="${GA}/scripts/wiki-daily-compile.sh"
CONFIG_LIB="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${RESTART_SCRIPT}" ]] || skip "daemon-daily-restart.sh not found: ${RESTART_SCRIPT}"
  [[ -f "${WIKI_SCRIPT}" ]] || skip "wiki-daily-compile.sh not found: ${WIKI_SCRIPT}"
  WORK="$(mktemp -d -t absorption-conv-bats.XXXXXX)"
  export GA_DATA_ROOT="${WORK}/ga-data"
  DROP_LOG="${GA_DATA_ROOT}/data/pg-report-drops.log"
}

teardown() {
  if [[ -n "${WORK:-}" && -d "${WORK}" ]]; then
    chmod -R u+w "${WORK}" 2>/dev/null || true
    rm -rf -- "${WORK}"
  fi
}

# Extract one top-level function (declaration line → first column-0 brace) plus
# the two sink globals, into a sourceable shim.
extract_sink_shim() {
  local fn_name="$1" shim="$2"
  grep -E '^(PG_DROP_LOG|PG_DROP_LOG_MAX_BYTES)=' "${RESTART_SCRIPT}" >"${shim}"
  awk '
    $0 == "append_pg_drop() {" { capture = 1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "${RESTART_SCRIPT}" >>"${shim}"
  awk -v fn="${fn_name}" '
    $0 == fn "() {" { capture = 1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "${RESTART_SCRIPT}" >>"${shim}"
  grep -q "^${fn_name}() {" "${shim}" || skip "function extraction failed: ${fn_name}"
}

# PG helper stub that always fails — the forced-failure fixture behind AC-2/AC-3.
make_failing_pg_helper() {
  local dest="$1"
  cat >"${dest}" <<'PY'
#!/usr/bin/env python3
import sys
sys.stderr.write("forced PG failure fixture\n")
sys.exit(1)
PY
  chmod +x "${dest}"
}

# PG helper stub that always succeeds and records the delivered envelope beside
# itself — a landed report is then observable without a PG connection.
make_healthy_pg_helper() {
  local dest="$1"
  cat >"${dest}" <<'PY'
#!/usr/bin/env python3
import os
import sys

record = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pg-report.jsonl")
with open(record, "a", encoding="utf-8") as fh:
    fh.write(sys.stdin.read())
PY
  chmod +x "${dest}"
}

set_restart_globals() {
  export ROLE="wiki"
  export RUN_DATE="2026-06-10"
  export STARTED_AT="2026-06-10T00:00:00Z"
  export LOG_FILE="${WORK}/run.log"
  export PG_HELPER="${WORK}/_pg_dual_write_daemon.py"
  make_failing_pg_helper "${PG_HELPER}"
}

# ---- daemon-daily-restart.sh: pg_write_run / pg_write_autoagent_run ----

@test "AC-2 pg_write_run: a failed PG report emits a stderr diagnostic and a drop record" {
  extract_sink_shim pg_write_run "${WORK}/shim.sh"
  set_restart_globals
  # shellcheck source=/dev/null
  run bash -c "source '${WORK}/shim.sh'; pg_write_run ok 2026-06-10T00:01:00Z"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN: PG daemon-run report failed (site=daily-restart-run"* ]]
  grep -q 'PG_REPORT_DROP site=daily-restart-run exit=1' "${DROP_LOG}"
}

@test "AC-2 pg_write_autoagent_run: a failed PG report emits its own site-tagged drop record" {
  extract_sink_shim pg_write_autoagent_run "${WORK}/shim.sh"
  set_restart_globals
  # shellcheck source=/dev/null
  run bash -c "source '${WORK}/shim.sh'; pg_write_autoagent_run quota_exceeded 2026-06-10T00:01:00Z note"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN: PG daemon-run report failed (site=autoagent-quota-run"* ]]
  grep -q 'PG_REPORT_DROP site=autoagent-quota-run exit=1' "${DROP_LOG}"
}

@test "AC-3 pg_write_run: the conversion branch never changes the caller's status" {
  extract_sink_shim pg_write_run "${WORK}/shim.sh"
  set_restart_globals
  # `set -e` + a following statement: a non-zero return would abort before the marker.
  run bash -c "set -Eeuo pipefail; source '${WORK}/shim.sh'; pg_write_run error 2026-06-10T00:01:00Z fatal; echo REACHED"
  [ "$status" -eq 0 ]
  [[ "$output" == *"REACHED"* ]]
}

@test "sink rotation: a drop log above the byte ceiling is restarted, not appended forever" {
  extract_sink_shim pg_write_run "${WORK}/shim.sh"
  set_restart_globals
  mkdir -p "${GA_DATA_ROOT}/data"
  head -c 70000 /dev/zero | tr '\0' 'x' >"${DROP_LOG}"
  run bash -c "source '${WORK}/shim.sh'; append_pg_drop probe-site 7"
  [ "$status" -eq 0 ]
  [ "$(wc -c <"${DROP_LOG}" | tr -cd '0-9')" -lt 1000 ]
  grep -q 'PG_REPORT_DROP site=probe-site exit=7' "${DROP_LOG}"
}

@test "sink failure is terminal: an unwritable data root never aborts the caller or re-reports" {
  extract_sink_shim pg_write_run "${WORK}/shim.sh"
  set_restart_globals
  # A regular file where the sink expects a parent directory: mkdir -p fails
  # with ENOTDIR for EVERY user. A mode-bit denial would not — a privileged
  # runner sails straight through 555 and the fixture stops proving anything.
  printf 'blocker\n' >"${WORK}/blocked"
  run bash -c "set -Eeuo pipefail; GA_DATA_ROOT='${WORK}/blocked/ga' source '${WORK}/shim.sh'; pg_write_run ok 2026-06-10T00:01:00Z; echo REACHED"
  [ "$status" -eq 0 ] || {
    echo "unexpected abort: status=${status}"
    printf '%s\n' "${output}"
    false
  }
  [[ "$output" == *"REACHED"* ]]
  # Exactly one diagnostic channel fires — the sink failure itself is silent by design.
  [ "$(grep -c 'WARN: PG daemon-run report failed' <<<"$output")" -eq 1 ]
  [ ! -e "${WORK}/blocked/ga/data/pg-report-drops.log" ]
}

# ---- wiki-daily-compile.sh: full-flow, exit contract preserved ----

# Sandbox the compile script with a PG helper stub and a stub claude binary.
# $1 PG posture: `failing` (default, the AC-2/AC-3 forced-failure fixture) or
# `healthy` (records the envelope at ${PG_REPORT_RECORD}).
# $2 LOG_DIR posture: `present` (default) or `absent` — `absent` reproduces the
# first-cron-day state where the trace dir does not exist yet.
make_wiki_sandbox() {
  local pg_posture="${1:-failing}" log_dir_posture="${2:-present}"
  SANDBOX="${WORK}/sandbox"
  mkdir -p "${SANDBOX}/lib"
  cp "${WIKI_SCRIPT}" "${SANDBOX}/wiki-daily-compile.sh"
  cp "${CONFIG_LIB}" "${SANDBOX}/lib/atrium-config.sh"
  PG_REPORT_RECORD="${SANDBOX}/pg-report.jsonl"
  if [[ "${pg_posture}" == "healthy" ]]; then
    make_healthy_pg_helper "${SANDBOX}/_pg_dual_write_daemon.py"
  else
    make_failing_pg_helper "${SANDBOX}/_pg_dual_write_daemon.py"
  fi
  printf '#!/bin/sh\nexit 0\n' >"${SANDBOX}/claude-stub"
  chmod +x "${SANDBOX}/claude-stub"
  export WIKI_COMPILE_CLAUDE_BIN="${SANDBOX}/claude-stub"
  export HOME="${WORK}/home"
  # Claude-Code project-dir cwd encoding, mirrored so the trace dir is locatable.
  local proj="-${HOME#/}"
  proj="${proj//\//-}"
  WIKI_LOG_DIR="${HOME}/.claude-work/projects/${proj}/memory/traces"
  if [[ "${log_dir_posture}" != "absent" ]]; then
    mkdir -p "${WIKI_LOG_DIR}"
  fi
}

@test "AC-2/AC-3 wiki-daily-compile: wiki-root-missing reports the drop and still exits 1" {
  make_wiki_sandbox
  export WIKI_ROOT="${WORK}/absent-wiki-root"
  run bash "${SANDBOX}/wiki-daily-compile.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"WARN: PG daemon-run report failed (site=wiki-root-missing"* ]]
  grep -q 'PG_REPORT_DROP site=wiki-root-missing exit=' "${DROP_LOG}"
}

@test "AC-2/AC-3 wiki-daily-compile: no-unprocessed-skip reports the drop and still exits 0" {
  make_wiki_sandbox
  export WIKI_ROOT="${WORK}/wiki"
  mkdir -p "${WIKI_ROOT}/raw" "${WIKI_ROOT}/notes"
  run bash "${SANDBOX}/wiki-daily-compile.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN: PG daemon-run report failed (site=no-unprocessed-skip"* ]]
  grep -q 'PG_REPORT_DROP site=no-unprocessed-skip exit=' "${DROP_LOG}"
  # Primary work still completed: the clean-zero-work trace line was written.
  grep -qr '0 unprocessed raw sources' "${HOME}/.claude-work/projects"
}

@test "T1 AC-1 wiki-daily-compile: an absent LOG_DIR never fakes a PG drop on the abort branch" {
  make_wiki_sandbox healthy absent
  export WIKI_ROOT="${WORK}/absent-wiki-root"
  [ ! -d "${WIKI_LOG_DIR}" ]
  run bash "${SANDBOX}/wiki-daily-compile.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"FATAL: configured wiki root missing"* ]]
  # PG is healthy here, so a WARN or a drop record can only come from the log
  # redirect failing ahead of the helper — the ordering defect, not a real drop.
  [[ "$output" != *"WARN: PG daemon-run report failed"* ]] || {
    echo "spurious PG WARN against a healthy helper"
    printf '%s\n' "${output}"
    false
  }
  [ ! -e "${DROP_LOG}" ]
  grep -q '"status":"error"' "${PG_REPORT_RECORD}"
}

@test "T1 AC-2 wiki-daily-compile: an absent LOG_DIR never aborts the raw-absent fall-through" {
  make_wiki_sandbox healthy absent
  export WIKI_ROOT="${WORK}/wiki"
  mkdir -p "${WIKI_ROOT}"
  [ ! -d "${WIKI_LOG_DIR}" ]
  run bash "${SANDBOX}/wiki-daily-compile.sh"
  [ "$status" -eq 0 ]
  grep -q 'raw/ absent' "${WIKI_LOG_DIR}"/wiki-compile-*.log
  [ ! -e "${DROP_LOG}" ]
}

@test "drop record format: ISO8601 UTC timestamp, script basename, site slug, exit status" {
  extract_sink_shim pg_write_run "${WORK}/shim.sh"
  set_restart_globals
  run bash -c "source '${WORK}/shim.sh'; append_pg_drop fmt-probe 3"
  [ "$status" -eq 0 ]
  run grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z \[daemon-daily-restart\] PG_REPORT_DROP site=fmt-probe exit=3$' "${DROP_LOG}"
  [ "$output" -eq 1 ]
}
