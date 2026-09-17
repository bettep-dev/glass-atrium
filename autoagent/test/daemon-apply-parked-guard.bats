#!/usr/bin/env bats
# daemon-apply.sh parked-pattern guard wiring — a selected proposal whose covering pattern rows are
# all terminal never lands, and a guard that cannot answer applies nothing.
#
# Hermetic: a whole-PATH mirror without psql, a psql stub answering from fixture files, and the
# daemon_cycle.py seam (AUTOAGENT_DAEMON_CYCLE_PY) pointed at a recording Python stub whose guard
# replies are scripted per call. No PG, no live agents dir, no ~/.glass-atrium state.
#
# Run via: bats autoagent/test/daemon-apply-parked-guard.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

NO_GUARD='{"guarded": [], "rejected": []}'

# mirror_path — symlink every PATH executable into $1 except psql, so a run without the stub dir
# takes the report source (precedent: daemon-apply-backlog-anomaly-row.bats).
mirror_path() {
  local dest="$1" d f name old_ifs="${IFS}"
  mkdir -p -- "${dest}"
  IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      [[ "${name}" != "psql" ]] || continue
      [[ -e "${dest}/${name}" ]] || ln -sf "${f}" "${dest}/${name}"
    done
  done
  IFS="${old_ifs}"
}

setup_file() {
  MIRROR="${BATS_FILE_TMPDIR}/bin"
  [[ -f "${REAL_SCRIPT}" ]] && mirror_path "${MIRROR}"
  export MIRROR
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so the daemon's realpath containment check passes.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-parked-guard.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  STUB="${WORK}/bin"
  GUARD_DIR="${WORK}/guard-answers"
  CALLS="${WORK}/cycle-calls.jsonl"
  PSQL_LOG="${WORK}/psql.log"
  mkdir -p -- "${AGENTS}" "${REPORTS}" "${STUB}" "${GUARD_DIR}" "${WORK}/home"
  APPLIED_LOG="${REPORTS}/autoagent-applied-$(date -u +%Y-%m-%d).jsonl"
  install_psql_stub
  install_cycle_stub
  write_probe probe-a
  write_probe probe-b
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# install_psql_stub — the status flip logs its bindings and returns one id; the backlog SELECT answers
# from its fixture file. The Nth single lookup answers from single.rows.N when scripted (a
# single.rows.N.rc file scripts a query failure instead), else from single.rows.
install_psql_stub() {
  cat >"${STUB}/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "${sql}" in
  *"'applied'::core"*)
    printf 'flip: %s\n' "$*" >>"${STUB_PSQL_LOG:?}"
    printf '1\n'
    ;;
  *stale_attempt_count*) printf 'incremented\n' ;;
  *"ORDER BY cycle_date ASC, id ASC"*) cat -- "${STUB_BACKLOG_ROWS:?}" ;;
  *"id::text = :'pid'"*)
    calls="${STUB_SINGLE_ROW:?}.calls"
    n=1
    [[ -f "${calls}" ]] && n=$(($(cat -- "${calls}") + 1))
    printf '%s\n' "${n}" >"${calls}"
    if [[ -f "${STUB_SINGLE_ROW}.${n}.rc" ]]; then
      printf 'psql: error: connection to server failed (stub)\n' >&2
      exit "$(cat -- "${STUB_SINGLE_ROW}.${n}.rc")"
    fi
    if [[ -f "${STUB_SINGLE_ROW}.${n}" ]]; then
      cat -- "${STUB_SINGLE_ROW}.${n}"
    else
      cat -- "${STUB_SINGLE_ROW}"
    fi
    ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${STUB}/psql"
  : >"${WORK}/backlog.rows"
  : >"${WORK}/single.rows"
}

# install_cycle_stub — records every seam call; the Nth guard call replies with GUARD_DIR/N.{out,rc}
# and an unscripted call fails, so an unexpected extra guard call cannot pass silently.
install_cycle_stub() {
  CYCLE_STUB="${WORK}/daemon_cycle_stub.py"
  cat >"${CYCLE_STUB}" <<'PY'
import json
import os
import sys

args = sys.argv[1:]
record = {"argv": args}
if "--parked-pattern-guard" in args:
    rows = [json.loads(line) for line in sys.stdin.read().splitlines() if line.strip()]
    record["stdin_ids"] = ",".join(str(row.get("proposal_id")) for row in rows)
elif "--removal-evidence" in args:
    sys.stdin.read()
calls_path = os.environ["STUB_CYCLE_CALLS"]
with open(calls_path, "a") as fh:
    fh.write(json.dumps(record) + "\n")

if "--parked-pattern-guard" in args:
    with open(calls_path) as fh:
        call_no = sum(1 for line in fh if "--parked-pattern-guard" in json.loads(line)["argv"])
    answer = os.path.join(os.environ["STUB_GUARD_DIR"], str(call_no))
    if not os.path.exists(answer + ".rc"):
        sys.exit("stub: no guard answer scripted for call %d" % call_no)
    with open(answer + ".out") as fh:
        sys.stdout.write(fh.read())
    with open(answer + ".rc") as fh:
        sys.exit(int(fh.read().strip()))
if "--removal-evidence" in args:
    sys.stdout.write("no_removal\t0\t0\n")
    sys.exit(0)
if "--regenerate-stale" in args:
    pid = int(args[args.index("--proposal-id") + 1])
    verdict = {"proposal_id": pid, "action": "regenerated", "preverify_passed": True,
               "preverify_axes": {}, "reason": "stub"}
    sys.stdout.write(json.dumps(verdict) + "\n")
    sys.exit(0)
sys.exit("stub: unexpected daemon_cycle mode %s" % args)
PY
}

# write_probe NAME — an agent body with one editable region.
write_probe() {
  printf '%s\n' '---' "name: $1" '---' "# Probe $1" '' '## Goal' \
    '<!-- EDITABLE:BEGIN -->' 'goal line one' 'goal line two' '<!-- EDITABLE:END -->' \
    >"${AGENTS}/$1.md"
  cp -p -- "${AGENTS}/$1.md" "${WORK}/$1.original"
}

# landing_diff NAME — an in-region addition that lands. stale_diff NAME — same hunk with its context
# out of order, so it passes the landing-zone guard but git apply rejects it (needs_regen).
landing_diff() {
  printf '%s\n' "--- a/$1.md" "+++ b/$1.md" '@@ -8,2 +8,3 @@' \
    ' goal line one' "+goal line added to $1" ' goal line two'
}

stale_diff() {
  printf '%s\n' "--- a/$1.md" "+++ b/$1.md" '@@ -8,2 +8,3 @@' \
    ' goal line two' "+goal line added to $1" ' goal line one'
}

# proposal_row ID NAME DIFF — one row in the producer's 6-field psql grammar.
proposal_row() {
  printf '%s|2026-09-01|probe-pattern-%s|%s|%s/%s.md|%s\n' \
    "$1" "$1" "$2" "${AGENTS}" "$2" "$(printf '%s' "$3" | base64 | tr -d '\n')"
}

# single_row ID NAME DIFF [STATUS] [HAIKU] — the single lookup's grammar: the 6 fields, then status
# (default pending) and haiku_status (default ok; pass '' for NULL).
single_row() {
  printf '%s|%s|%s\n' "$(proposal_row "$1" "$2" "$3")" "${4:-pending}" "${5-ok}"
}

# answer_guard N RC OUT — the stub's reply to its Nth guard call.
answer_guard() {
  printf '%s\n' "$2" >"${GUARD_DIR}/$1.rc"
  printf '%s' "$3" >"${GUARD_DIR}/$1.out"
}

# guarded_verdict ID REJECTED — a verdict guarding proposal ID (covering row 3384 rejected);
# REJECTED is the JSON list of ids the mode transitioned.
guarded_verdict() {
  printf '{"guarded": [{"proposal_id": %s, "rows": [{"id": 3384, "status": "rejected"}]}], "rejected": %s}\n' \
    "$1" "$2"
}

run_apply() {
  run env -u AUTOAGENT_ALLOW_UNVERIFIED PATH="${STUB}:${MIRROR}" HOME="${WORK}/home" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    AUTOAGENT_DAEMON_CYCLE_PY="${CYCLE_STUB}" \
    STUB_PSQL_LOG="${PSQL_LOG}" STUB_BACKLOG_ROWS="${WORK}/backlog.rows" \
    STUB_SINGLE_ROW="${WORK}/single.rows" STUB_CYCLE_CALLS="${CALLS}" STUB_GUARD_DIR="${GUARD_DIR}" \
    bash "${REAL_SCRIPT}" --agents-dir "${AGENTS}" --report "${WORK}/report.json" "$@"
}

# count_calls NEEDLE... — seam calls whose record carries every needle. Needles travel through
# ENVIRON, joined on \x1f: `awk -v` would process their backslashes and a space join would split them.
count_calls() {
  [[ -f "${CALLS}" ]] || {
    printf '0'
    return 0
  }
  local IFS=$'\x1f'
  NEEDLES="$*" awk '
    BEGIN { n = split(ENVIRON["NEEDLES"], want, "\037") }
    { hit = 1; for (i = 1; i <= n; i++) if (index($0, want[i]) == 0) hit = 0; count += hit }
    END { printf "%d", count }
  ' "${CALLS}"
}

is_unchanged() {
  cmp -s -- "${AGENTS}/$1.md" "${WORK}/$1.original"
}

was_flipped() {
  [[ -f "${PSQL_LOG}" ]] && grep -q -- "^flip: .*pid=$1 " "${PSQL_LOG}"
}

dump_state() {
  echo "status=${status} output: ${output}" >&2
  echo "seam calls:" >&2
  cat -- "${CALLS}" >&2 2>&1 || true
  echo "applied log:" >&2
  cat -- "${APPLIED_LOG}" >&2 2>&1 || true
}

@test "batch: a guarded row neither lands nor flips, its unguarded neighbour applies, and the live batch passes the reject flag" {
  {
    proposal_row 101 probe-a "$(landing_diff probe-a)"
    proposal_row 102 probe-b "$(landing_diff probe-b)"
  } >"${WORK}/backlog.rows"
  answer_guard 1 0 "$(guarded_verdict 101 '[101]')"
  run_apply

  [[ "${status}" -eq 0 ]] || {
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 101 || {
    echo "the guarded proposal landed or had its status flipped" >&2
    dump_state
    return 1
  }
  ! is_unchanged probe-b && was_flipped 102 || {
    echo "the unguarded proposal in the same batch did not apply" >&2
    dump_state
    return 1
  }
  [[ "$(count_calls --parked-pattern-guard --reject-parked '"stdin_ids": "101,102"')" -eq 1 ]] || {
    echo "expected ONE live-batch guard call carrying --reject-parked and both selected rows" >&2
    dump_state
    return 1
  }
  grep '"reason":"parked_pattern"' "${APPLIED_LOG}" | grep '"proposal_id":"101"' | grep -q '"rejected":true' || {
    echo "no skip row records the guarded proposal and its reject" >&2
    dump_state
    return 1
  }
}

@test "single: a guarded proposal is refused with its own exit, names the parked rows and the Reject way out, and touches nothing" {
  single_row 201 probe-a "$(landing_diff probe-a)" >"${WORK}/single.rows"
  answer_guard 1 0 "$(guarded_verdict 201 '[]')"
  run_apply --proposal-id 201

  [[ "${status}" -eq 18 ]] || {
    dump_state
    return 1
  }
  [[ "${output}" == *"3384:rejected"* && "${output}" == *"Reject"* ]] || {
    echo "the refusal names neither the parked rows nor the Reject action" >&2
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 201 || {
    dump_state
    return 1
  }
  [[ "$(count_calls --reject-parked)" -eq 0 ]] || {
    echo "single mode must never pass --reject-parked (a refusal is not a human rejection)" >&2
    dump_state
    return 1
  }
}

@test "a guard mode that exits non-zero applies nothing, exits 17, names the interpreter, and lands an abort row" {
  {
    proposal_row 101 probe-a "$(landing_diff probe-a)"
    proposal_row 102 probe-b "$(landing_diff probe-b)"
  } >"${WORK}/backlog.rows"
  answer_guard 1 8 ""
  run_apply

  [[ "${status}" -eq 17 ]] || {
    dump_state
    return 1
  }
  is_unchanged probe-a && is_unchanged probe-b && ! was_flipped 101 && ! was_flipped 102 || {
    echo "a failed guard read let a row apply" >&2
    dump_state
    return 1
  }
  [[ "${output}" == *"interpreter="* ]] || {
    dump_state
    return 1
  }
  grep '"status":"abort"' "${APPLIED_LOG}" | grep '"reason":"parked_guard_failed"' | grep -q '"exit_code":17' || {
    echo "the guard failure left no durable abort row" >&2
    dump_state
    return 1
  }
}

@test "a guard mode that exits 0 without exactly one verdict is a failure, never 'nothing guarded'" {
  proposal_row 101 probe-a "$(landing_diff probe-a)" >"${WORK}/backlog.rows"
  # empty stdout (the update-pause gate's clean exit) · not JSON · a key missing · two verdict lines
  local -a replies=("" "not a verdict" '{"guarded": []}' "${NO_GUARD}"$'\n'"${NO_GUARD}")
  local i
  for i in 0 1 2 3; do
    answer_guard "$((i + 1))" 0 "${replies[i]}"
    run_apply
    [[ "${status}" -eq 17 ]] && is_unchanged probe-a && ! was_flipped 101 || {
      echo "reply #${i} (${replies[i]}) was read as a verdict" >&2
      dump_state
      return 1
    }
  done
}

@test "no guarded rows: every selected row applies exactly as without the guard" {
  {
    proposal_row 101 probe-a "$(landing_diff probe-a)"
    proposal_row 102 probe-b "$(landing_diff probe-b)"
  } >"${WORK}/backlog.rows"
  answer_guard 1 0 "${NO_GUARD}"
  run_apply

  [[ "${status}" -eq 0 ]] || {
    dump_state
    return 1
  }
  ! is_unchanged probe-a && ! is_unchanged probe-b && was_flipped 101 && was_flipped 102 || {
    echo "an empty verdict changed the apply outcome" >&2
    dump_state
    return 1
  }
  ! grep -q '"reason":"parked_pattern"' "${APPLIED_LOG}" || {
    dump_state
    return 1
  }
}

@test "auto-regen: the re-attempt after a regenerate is guarded too" {
  single_row 301 probe-a "$(stale_diff probe-a)" >"${WORK}/single.rows"
  answer_guard 1 0 "${NO_GUARD}"
  answer_guard 2 0 "$(guarded_verdict 301 '[]')"
  run_apply --proposal-id 301 --auto-regen

  [[ "$(count_calls --regenerate-stale)" -eq 1 ]] || {
    echo "the first attempt never reached the regenerate path, so the re-attempt is untested" >&2
    dump_state
    return 1
  }
  [[ "${status}" -eq 18 && "$(count_calls --parked-pattern-guard)" -eq 2 ]] || {
    echo "the re-attempt ran without its own guard call" >&2
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 301 || {
    dump_state
    return 1
  }
}

@test "single: the guard answers before the generation outcome — a guarded non-ok row exits 18, an unguarded one exits 20" {
  single_row 201 probe-a "$(landing_diff probe-a)" pending 'skipped:chronic-timeout-backoff' >"${WORK}/single.rows"
  answer_guard 1 0 "$(guarded_verdict 201 '[]')"
  run_apply --proposal-id 201

  [[ "${status}" -eq 18 ]] || {
    echo "a guarded row with a non-ok outcome must take the guard's more specific refusal" >&2
    dump_state
    return 1
  }

  answer_guard 2 0 "${NO_GUARD}"
  run_apply --proposal-id 201

  [[ "${status}" -eq 20 && "$(count_calls --parked-pattern-guard)" -eq 2 ]] || {
    echo "an unguarded non-ok row must be refused (20) only after its guard call" >&2
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 201 && [[ "$(count_calls --reject-parked)" -eq 0 ]] || {
    dump_state
    return 1
  }
}

@test "single: a terminal row exits 8 before the guard is ever asked" {
  single_row 201 probe-a "$(landing_diff probe-a)" reverted >"${WORK}/single.rows"
  run_apply --proposal-id 201

  [[ "${status}" -eq 8 && "$(count_calls --parked-pattern-guard)" -eq 0 ]] || {
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 201 || {
    dump_state
    return 1
  }
}

@test "auto-regen: the re-read after a regenerate takes the same lookup branch — a failed query exits 21" {
  single_row 301 probe-a "$(stale_diff probe-a)" >"${WORK}/single.rows"
  printf '2\n' >"${WORK}/single.rows.2.rc"
  answer_guard 1 0 "${NO_GUARD}"
  run_apply --proposal-id 301 --auto-regen

  [[ "$(count_calls --regenerate-stale)" -eq 1 ]] || {
    echo "the first attempt never reached the regenerate path, so the re-read is untested" >&2
    dump_state
    return 1
  }
  [[ "${status}" -eq 21 && "$(count_calls --parked-pattern-guard)" -eq 1 ]] || {
    echo "a failed re-read must exit 21, never read as a row that still would not land" >&2
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 301 || {
    dump_state
    return 1
  }
}

@test "auto-regen: a re-read row whose generation outcome is not ok exits 20 after its own guard call" {
  single_row 301 probe-a "$(stale_diff probe-a)" >"${WORK}/single.rows"
  single_row 301 probe-a "$(landing_diff probe-a)" pending 'skipped:transient' >"${WORK}/single.rows.2"
  answer_guard 1 0 "${NO_GUARD}"
  answer_guard 2 0 "${NO_GUARD}"
  run_apply --proposal-id 301 --auto-regen

  [[ "${status}" -eq 20 && "$(count_calls --regenerate-stale)" -eq 1 \
    && "$(count_calls --parked-pattern-guard)" -eq 2 ]] || {
    dump_state
    return 1
  }
  is_unchanged probe-a && ! was_flipped 301 || {
    echo "the re-read row with a non-ok outcome landed" >&2
    dump_state
    return 1
  }
}

@test "dry-run: the guard still answers but never receives the reject flag" {
  single_row 201 probe-a "$(landing_diff probe-a)" >"${WORK}/single.rows"
  answer_guard 1 0 "$(guarded_verdict 201 '[]')"
  run_apply --proposal-id 201 --dry-run

  [[ "${status}" -eq 18 && "$(count_calls --parked-pattern-guard)" -eq 1 ]] || {
    dump_state
    return 1
  }
  [[ "$(count_calls --reject-parked)" -eq 0 ]] || {
    echo "a dry-run passed --reject-parked" >&2
    dump_state
    return 1
  }
}

@test "report source: rows carry no proposal id, so the guard is never called and a notice says so" {
  DIFF="$(landing_diff probe-a)" TARGET="${AGENTS}/probe-a.md" python3 -c '
import json, os
patch = {"classification": "body-auto", "approval_tier": "auto", "pre_verify_passed": True,
         "haiku_status": "ok", "pattern_label": "probe-report", "pattern_agent": "probe-a",
         "target_file": os.environ["TARGET"], "proposed_diff": os.environ["DIFF"] + "\n"}
print(json.dumps({"patches": [patch]}))
' >"${WORK}/report.json"
  # No stub dir on PATH: psql is absent, so a LIVE run takes the report source.
  run env -u AUTOAGENT_ALLOW_UNVERIFIED PATH="${MIRROR}" HOME="${WORK}/home" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    AUTOAGENT_DAEMON_CYCLE_PY="${CYCLE_STUB}" STUB_CYCLE_CALLS="${CALLS}" STUB_GUARD_DIR="${GUARD_DIR}" \
    bash "${REAL_SCRIPT}" --agents-dir "${AGENTS}" --report "${WORK}/report.json"

  [[ "${status}" -eq 0 ]] && ! is_unchanged probe-a || {
    dump_state
    return 1
  }
  [[ "$(count_calls --parked-pattern-guard)" -eq 0 ]] || {
    dump_state
    return 1
  }
  [[ "${output}" == *"parked-pattern guard unavailable"* ]] || {
    echo "the report source applied unguarded without saying so" >&2
    dump_state
    return 1
  }
}
