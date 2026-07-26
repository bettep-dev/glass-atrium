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
  mkdir -p "${WORK}/locked"
  chmod 555 "${WORK}/locked"
  run bash -c "set -Eeuo pipefail; GA_DATA_ROOT='${WORK}/locked/ga' PG_DROP_LOG='${WORK}/locked/ga/data/pg-report-drops.log' source '${WORK}/shim.sh'; pg_write_run ok 2026-06-10T00:01:00Z; echo REACHED"
  [ "$status" -eq 0 ]
  [[ "$output" == *"REACHED"* ]]
  # Exactly one diagnostic channel fires — the sink failure itself is silent by design.
  [ "$(grep -c 'WARN: PG daemon-run report failed' <<<"$output")" -eq 1 ]
}

# ---- wiki-daily-compile.sh: full-flow, exit contract preserved ----

# Sandbox the compile script with a failing PG helper and a stub claude binary.
make_wiki_sandbox() {
  SANDBOX="${WORK}/sandbox"
  mkdir -p "${SANDBOX}/lib"
  cp "${WIKI_SCRIPT}" "${SANDBOX}/wiki-daily-compile.sh"
  cp "${CONFIG_LIB}" "${SANDBOX}/lib/atrium-config.sh"
  make_failing_pg_helper "${SANDBOX}/_pg_dual_write_daemon.py"
  printf '#!/bin/sh\nexit 0\n' >"${SANDBOX}/claude-stub"
  chmod +x "${SANDBOX}/claude-stub"
  export WIKI_COMPILE_CLAUDE_BIN="${SANDBOX}/claude-stub"
  export HOME="${WORK}/home"
  # Claude-Code project-dir cwd encoding, mirrored so LOG_DIR exists before the
  # abort branch runs — otherwise the log redirect, not the helper, would fail.
  local proj="-${HOME#/}"
  proj="${proj//\//-}"
  mkdir -p "${HOME}/.claude-work/projects/${proj}/memory/traces"
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

@test "drop record format: ISO8601 UTC timestamp, script basename, site slug, exit status" {
  extract_sink_shim pg_write_run "${WORK}/shim.sh"
  set_restart_globals
  run bash -c "source '${WORK}/shim.sh'; append_pg_drop fmt-probe 3"
  [ "$status" -eq 0 ]
  run grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z \[daemon-daily-restart\] PG_REPORT_DROP site=fmt-probe exit=3$' "${DROP_LOG}"
  [ "$output" -eq 1 ]
}
