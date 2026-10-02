#!/usr/bin/env bats
# daemon-apply-landed-record.bats — the landed record every byte-landing apply writes: the unified diff
# from the transaction's own before-image to the verified target, plus both whole-file sha256 digests.
# Two copies: the applied JSONL row (durable) and core.autoagent_apply_records (queryable, written
# after the status flip). Pins the table preflight (exit 25) and the record-failure exit (26).
#
# HERMETIC: temp agents tree, temp HOME, a stateful psql stand-in prepended to PATH, and the
# daemon_cycle.py seam pointed at a stand-in. No live PG, no live install, no live agents dir.
#
# Run via: bats autoagent/test/daemon-apply-landed-record.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

BEGIN_MARK='<!-- EDITABLE:BEGIN -->'
END_MARK='<!-- EDITABLE:END -->'
ROW_ID=2763
# A quote inside the label: an inlined value would break or alter the SQL the stand-in receives.
LABEL="probe 'landed' record"
ADDED_LINE='record probe insertion'

setup() {
  [[ -x "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not executable: ${REAL_SCRIPT}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-record.XXXXXX)" && pwd -P)"
  STUB="${WORK}/bin"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  FAKE_HOME="${WORK}/home"
  PG="${WORK}/pg"
  SEAM="${WORK}/daemon_cycle_seam.py"
  mkdir -p "${STUB}" "${AGENTS}" "${REPORTS}" "${FAKE_HOME}" "${PG}"
  printf 'pending' >"${PG}/row-status"
  install_psql_stub "${STUB}"
  build_daemon_cycle_seam "${SEAM}"

  PROBE="${AGENTS}/probe.md"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' '' \
      '## Absolute Rules' '' '- MUST NOT do the dangerous thing' '' \
      '## Goal' "${BEGIN_MARK}"
    local i
    for i in $(seq -w 1 30); do printf 'editable goal line %s\n' "${i}"; done
    printf '%s\n' "${END_MARK}"
  } >"${PROBE}"
  BEFORE="${WORK}/probe.before"
  cp -p -- "${PROBE}" "${BEFORE}"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
  return 0
}

# install_psql_stub DIR — a stateful PG stand-in. Every -v binding of the flip and of the record
# INSERT lands as one file per name (byte-exact, multi-line safe) with the statement text beside it.
# STUB_PROBE answers the table probe (t | f | error); STUB_INSERT=error refuses the INSERT.
install_psql_stub() {
  cat >"$1/psql" <<'STUB'
#!/usr/bin/env bash
set -u
pg="${STUB_PG:?stub needs STUB_PG}"
sql="$(cat)"
printf '=== psql\nsql<<<\n%s\n>>>\n' "${sql}" >>"${pg}/psql.log"
row_status="$(cat "${pg}/row-status")"

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

emit_row() {
  printf '%s|%s|%s|%s|%s|%s%s\n' \
    "${STUB_ROW_ID:?}" "${STUB_CYCLE:?}" "$(b64 "${STUB_LABEL:?}")" \
    "$(b64 "${STUB_AGENT:?}")" "$(b64 "${STUB_TARGET:?}")" "${STUB_DIFF_B64:?}" "${1:-}"
}

save_bindings() {
  local out="$1" prev="" arg
  shift
  mkdir -p "${out}"
  printf '%s' "${sql}" >"${out}/__sql"
  for arg in "$@"; do
    if [[ "${prev}" == "-v" && "${arg}" == *=* ]]; then
      printf '%s' "${arg#*=}" >"${out}/${arg%%=*}"
    fi
    prev="${arg}"
  done
}

case "${sql}" in
  *"to_regclass('core.autoagent_apply_records')"*)
    if [[ "${STUB_PROBE:-t}" == "error" ]]; then
      printf 'ERROR:  permission denied for schema core\n' >&2
      exit 2
    fi
    printf '%s\n' "${STUB_PROBE:-t}"
    ;;
  *"INSERT INTO core.autoagent_apply_records"*)
    save_bindings "${pg}/insert" "$@"
    printf 'insert\n' >>"${pg}/inserts"
    if [[ "${STUB_INSERT:-ok}" == "error" ]]; then
      printf 'ERROR:  new row violates check constraint\n' >&2
      exit 3
    fi
    printf '501\n'
    ;;
  *"'applied'::core"*)
    save_bindings "${pg}/flip" "$@"
    printf 'applied' >"${pg}/row-status"
    printf '%s\n' "${STUB_ROW_ID}"
    ;;
  *"ORDER BY cycle_date ASC, id ASC"*)
    if [[ "${row_status}" == "pending" ]]; then emit_row; fi
    ;;
  *"id::text = :'pid'"*)
    emit_row "|${row_status}|ok"
    ;;
  *stale_attempt_count*)
    printf 'incremented\n'
    ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "$1/psql"
}

# build_daemon_cycle_seam PATH — stand-in for AUTOAGENT_DAEMON_CYCLE_PY: the parked-pattern guard
# reads through psycopg (no psql stub isolates it), so it answers "nothing guarded"; the stale regen
# answers already_applied; every other mode execs the real file.
build_daemon_cycle_seam() {
  local real_literal
  real_literal="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "${GA}/autoagent/daemon_cycle.py")"
  cat >"$1" <<PY
import os
import sys

if "--parked-pattern-guard" in sys.argv[1:]:
    sys.stdin.buffer.read()
    sys.stdout.write('{"guarded": [], "rejected": []}\n')
    sys.exit(0)
if "--regenerate-stale" in sys.argv[1:]:
    sys.stdout.write('{"proposal_id": ${ROW_ID}, "action": "already_applied", "preverify_passed": true, "preverify_axes": {}, "reason": "probe"}\n')
    sys.exit(0)
os.execv(sys.executable, [sys.executable, ${real_literal}] + sys.argv[1:])
PY
}

# Pure-addition hunk whose header names line 5, while its context sits at lines 21-22:
# git apply --recount lands it at an offset, so the proposal text is not what landed.
offset_diff() {
  printf '%s\n' '--- a/probe.md' '+++ b/probe.md' '@@ -5,2 +5,3 @@' \
    ' editable goal line 10' "+${ADDED_LINE}" ' editable goal line 11'
}

# Context lines that are not adjacent in the target: in-region, but git apply rejects the hunk.
stale_diff() {
  printf '%s\n' '--- a/probe.md' '+++ b/probe.md' '@@ -21,2 +21,3 @@' \
    ' editable goal line 10' "+${ADDED_LINE}" ' editable goal line 12'
}

headerless_diff() {
  printf '%s\n' "+${ADDED_LINE}"
}

# An in-region diff that guts the body past the shrink floor: it lands, verify fails, the
# transaction restores.
gutting_diff() {
  printf '%s\n' '--- a/probe.md' '+++ b/probe.md' '@@ -12,30 +12,2 @@' ' editable goal line 01'
  local i
  for i in $(seq -w 2 29); do printf -- '-editable goal line %s\n' "${i}"; done
  printf '%s\n' ' editable goal line 30'
}

# run_apply DIFF_FN [ARGS...] — the real script, run directly with the stub PATH first, a temp HOME,
# and the re-entry sentinel so no bats-invoked run shells the full suite.
run_apply() {
  local diff_fn="$1"
  shift
  run env PATH="${STUB}:${PATH}" \
    HOME="${FAKE_HOME}" \
    AUTOAGENT_REMOVAL_LIVE=1 \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    AUTOAGENT_DAEMON_CYCLE_PY="${SEAM}" \
    STUB_PG="${PG}" \
    STUB_ROW_ID="${ROW_ID}" \
    STUB_CYCLE="2026-10-01" \
    STUB_LABEL="${LABEL}" \
    STUB_AGENT="probe" \
    STUB_TARGET="${PROBE}" \
    STUB_DIFF_B64="$("${diff_fn}" | base64 | tr -d '\n')" \
    "${REAL_SCRIPT}" --agents-dir "${AGENTS}" "$@"
}

applied_log_path() {
  printf '%s/autoagent-applied-%s.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

# applied_field FIELD — FIELD of the one applied row in today's log; fails unless exactly one exists.
applied_field() {
  python3 - "$(applied_log_path)" "$1" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    rows = [json.loads(line) for line in fh if line.strip()]
applied = [row for row in rows if row.get("status") == "applied"]
if len(applied) != 1:
    sys.exit(f"expected one applied row, found {len(applied)}")
sys.stdout.write(str(applied[0].get(sys.argv[2], "")))
PY
}

applied_row_count() {
  local log
  log="$(applied_log_path)"
  [[ -f "${log}" ]] || {
    printf '0'
    return 0
  }
  grep -c '"status":"applied"' "${log}" || true
}

insert_count() {
  [[ -f "${PG}/inserts" ]] || {
    printf '0'
    return 0
  }
  wc -l <"${PG}/inserts" | tr -d ' '
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | cut -d' ' -f1
  else
    sha256sum -- "$1" | cut -d' ' -f1
  fi
}

# hunks_of — a unified diff from its first @@ line on (the header lines carry names, not content).
hunks_of() {
  sed -n '/^@@/,$p'
}

# has_abort_row EXIT_CODE REASON — one abort row carries both: lib/ga-doctor.sh picks its remedy by reason.
has_abort_row() {
  local log
  log="$(applied_log_path)"
  awk -v code="\"exit_code\":$1," -v reason="\"reason\":\"$2\"" '
    index($0, "\"status\":\"abort\"") && index($0, reason) && index($0, code) { found = 1 }
    END { exit !found }' "${log}"
}

@test "a landed apply records the before-to-after diff and both whole-file digests in the applied row and the database record" {
  run_apply offset_diff --proposal-id "${ROW_ID}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(cat "${PG}/row-status")" == "applied" ]] || {
    echo "the status flip did not run: ${output}"
    return 1
  }

  local expected recorded
  expected="$(diff -u "${BEFORE}" "${PROBE}" | hunks_of || true)"
  [[ -n "${expected}" && "${expected}" != "$(offset_diff | hunks_of)" ]] || {
    echo "fixture: the hunk must land at an offset from the proposal text"
    return 1
  }
  recorded="$(applied_field landed_diff)"
  [[ "$(printf '%s\n' "${recorded}" | hunks_of)" == "${expected}" ]] || {
    echo "JSONL diff: ${recorded}"
    return 1
  }
  [[ "$(applied_field before_sha256)" == "$(sha256_of "${BEFORE}")" ]] || return 1
  [[ "$(applied_field after_sha256)" == "$(sha256_of "${PROBE}")" ]] || return 1
  [[ "$(applied_field strategy)" == "recount" ]] || return 1

  [[ "$(insert_count)" -eq 1 ]] || {
    echo "expected one INSERT, got $(insert_count)"
    return 1
  }
  [[ "$(cat "${PG}/insert/diff")" == "${recorded}" ]] || return 1
  [[ "$(cat "${PG}/insert/bsha")" == "$(applied_field before_sha256)" ]] || return 1
  [[ "$(cat "${PG}/insert/asha")" == "$(applied_field after_sha256)" ]] || return 1
  [[ "$(cat "${PG}/insert/at")" == "$(applied_field ts)" ]] || return 1
  [[ "$(cat "${PG}/insert/pid")" == "${ROW_ID}" ]] || return 1
  [[ "$(cat "${PG}/insert/strategy")" == "recount" ]] || return 1
  [[ "$(cat "${PG}/insert/mid")" == "$(applied_field model_id)" ]] || return 1
}

@test "the record statement carries no value: every value reaches psql as a -v binding" {
  run_apply offset_diff --proposal-id "${ROW_ID}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ -f "${PG}/insert/__sql" ]] || {
    echo "no record INSERT reached psql: ${output}"
    return 1
  }

  local sql
  sql="$(cat "${PG}/insert/__sql")"
  [[ "${sql}" != *"${ADDED_LINE}"* && "${sql}" != *"landed' record"* && "${sql}" != *"${PROBE}"* ]] || {
    echo "a record value was inlined into the statement: ${sql}"
    return 1
  }
  [[ "$(cat "${PG}/insert/lbl")" == "${LABEL}" && "$(cat "${PG}/insert/tgt")" == "${PROBE}" ]] || return 1
}

@test "an apply that lands no bytes writes no record in either copy" {
  local rows=(
    "header-less fragment rejected before the transaction|headerless_diff"
    "verification failure restored from the before-image|gutting_diff"
  )
  local row name diff_fn
  for row in "${rows[@]}"; do
    name="${row%%|*}"
    diff_fn="${row#*|}"
    cp -p -- "${BEFORE}" "${PROBE}"
    run_apply "${diff_fn}" --proposal-id "${ROW_ID}"
    [[ "${status}" -eq 9 ]] || {
      echo "${name}: ${output}"
      return 1
    }
    cmp -s "${PROBE}" "${BEFORE}" || {
      echo "${name}: target changed"
      return 1
    }
    [[ "$(applied_row_count)" -eq 0 && "$(insert_count)" -eq 0 ]] || {
      echo "${name}: a record was written"
      return 1
    }
  done
}

@test "the already-applied regen arm flips the row and writes no record" {
  run_apply stale_diff --proposal-id "${ROW_ID}" --auto-regen
  [[ "${status}" -eq 12 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(cat "${PG}/row-status")" == "applied" ]] || {
    echo "the row was not flipped: ${output}"
    return 1
  }
  [[ "$(applied_row_count)" -eq 0 && "$(insert_count)" -eq 0 ]] || {
    echo "a record was written: ${output}"
    return 1
  }
}

# one row per gated source: the backlog drain, and --proposal-id (the monitor Approve route)
@test "a record table that cannot be confirmed stops the run before any apply with exit 25" {
  local rows=(
    "table absent, backlog source|f||"
    "probe failed, backlog source|error||"
    "table absent, single source|f|--proposal-id|${ROW_ID}"
  )
  local row name answer flag value
  for row in "${rows[@]}"; do
    IFS='|' read -r name answer flag value <<<"${row}"
    : >"$(applied_log_path)"
    STUB_PROBE="${answer}" run_apply offset_diff ${flag:+"${flag}" "${value}"}
    [[ "${status}" -eq 25 ]] || {
      echo "${name}: ${output}"
      return 1
    }
    [[ "${output}" == *"FATAL"*"core.autoagent_apply_records"* ]] || {
      echo "${name}: ${output}"
      return 1
    }
    has_abort_row 25 apply_record_table_unconfirmed || {
      echo "${name}: no exit-25 apply_record_table_unconfirmed abort row: ${output}"
      return 1
    }
    cmp -s "${PROBE}" "${BEFORE}" || {
      echo "${name}: target changed"
      return 1
    }
    [[ "$(cat "${PG}/row-status")" == "pending" && "$(insert_count)" -eq 0 ]] || {
      echo "${name}: DB written"
      return 1
    }
  done
}

# single row = the load-bearing one: only the gate's dry-run clause keeps a single source from the probe
@test "a dry run never probes the record table, whichever source selects its row" {
  python3 - "${WORK}/report.json" "${LABEL}" "${PROBE}" "$(offset_diff)" <<'PY'
import json, sys
patch = {"classification": "body-auto", "approval_tier": "auto", "pre_verify_passed": True,
         "haiku_status": "ok", "pattern_label": sys.argv[2], "pattern_agent": "probe",
         "target_file": sys.argv[3], "proposed_diff": sys.argv[4] + "\n"}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump({"patches": [patch]}, fh)
PY
  local rows=(
    "single source|--proposal-id|${ROW_ID}"
    "report source|--report|${WORK}/report.json"
  )
  local row name flag value
  for row in "${rows[@]}"; do
    IFS='|' read -r name flag value <<<"${row}"
    : >"${PG}/psql.log"
    # absent table → a probe that ran ends the dry run with exit 25
    STUB_PROBE=f run_apply offset_diff "${flag}" "${value}" --dry-run
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: ${output}"
      return 1
    }
    [[ "${output}" == *"processed=1"* ]] || {
      echo "${name}: the dry run reached no row: ${output}"
      return 1
    }
    run grep -c 'to_regclass' "${PG}/psql.log"
    [[ "${output}" == "0" ]] || {
      echo "${name}: the dry run probed the record table (to_regclass lines: ${output})"
      return 1
    }
  done
}

@test "a failed record insert keeps the row applied and the JSONL record, and exits 26" {
  STUB_INSERT=error run_apply offset_diff --proposal-id "${ROW_ID}"
  [[ "${status}" -eq 26 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(cat "${PG}/row-status")" == "applied" ]] || {
    echo "the flip did not run: ${output}"
    return 1
  }
  [[ -n "$(applied_field landed_diff)" ]] || return 1
  [[ "${output}" == *"FATAL"*"apply record"* ]] || {
    echo "${output}"
    return 1
  }
  has_abort_row 26 apply_record_failed || {
    echo "no exit-26 apply_record_failed abort row: ${output}"
    return 1
  }
}

@test "a digest or diff that cannot be computed never blocks the flip, issues no insert, and exits 26" {
  local rows=("truncating hasher|shasum" "diff tool error|diff")
  local row name tool stub_tool
  for row in "${rows[@]}"; do
    name="${row%%|*}"
    tool="${row#*|}"
    stub_tool="${STUB}/${tool}"
    cp -p -- "${BEFORE}" "${PROBE}"
    printf 'pending' >"${PG}/row-status"
    : >"$(applied_log_path)"
    # shellcheck disable=SC2016  # $0 expands inside the written stub, not here
    printf '#!/usr/bin/env bash\n%s\n' 'case "$0" in *shasum) echo "deadbeef  -" ;; *) exit 2 ;; esac' >"${stub_tool}"
    chmod +x "${stub_tool}"
    run_apply offset_diff --proposal-id "${ROW_ID}"
    if ga_guard_path "${stub_tool}"; then rm -f -- "${stub_tool:?}"; fi
    [[ "${status}" -eq 26 ]] || {
      echo "${name}: ${output}"
      return 1
    }
    [[ "$(cat "${PG}/row-status")" == "applied" ]] || {
      echo "${name}: the flip did not run"
      return 1
    }
    [[ "$(applied_row_count)" -eq 1 && "$(insert_count)" -eq 0 ]] || {
      echo "${name}: ${output}"
      return 1
    }
  done
}
