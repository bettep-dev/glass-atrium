#!/usr/bin/env bats
# daemon-apply.sh — coverage for the two P1a/P3b branches added to the SINGLE-
# proposal (--proposal-id) path:
#
#   P1a — landing_zone_reject now WIRES the bounded-retry stale-drain. An
#         out_of_region single/backlog row drives mark_stale_attempt (enforce=1)
#         BEFORE the trailing `continue` leaves the row pending (git-free: the
#         reject runs before any apply, so no bytes were written and there is
#         nothing to restore), emits a needs_regen/stale_drain_<verdict> log,
#         and prints the drained / no_column operator WARN. Gated on
#         AUTO_REGEN -ne 1 && PATCH_SOURCE in {backlog,single}. DRY_RUN reaches
#         NO DB write (short-circuits before the guard).
#
#   P3b — the single lookup selects by id only and the shell branches on what it
#         returns, in order: query failed → 21 · no row → 19 · row unreadable → 23 ·
#         terminal status → 8 · (parked guard 17/18, pinned in daemon-apply-parked-guard.bats) · generation
#         outcome (haiku_status) not ok-prefixed → 20 (NULL/skipped/error fail closed)
#         UNLESS the operator carve-out AUTOAGENT_ALLOW_HAIKU_SKIP=1 is engaged (loud
#         WARN). ok / ok:retried / ok:fuzzy-parsed all pass.
#
# Run via: bats autoagent/test/daemon-apply-stale-drain-haiku-guard.bats
# Requires: bats >= 1.5.0, bash 3.2+, git, python3, base64
#
# Hermetic strategy: a per-test standalone git repo fixture under a realpath-
# resolved temp root, plus a stub PATH whose `psql` is a PG stand-in. The stub
# dispatches on the SQL it receives, logs every invocation for assertions, and
# answers the id-only single lookup with the STUB_* row (its status and
# haiku_status included), no row (STUB_NO_ROW=1), a verbatim row (STUB_RAW_ROW)
# or a query failure (STUB_SINGLE_RC). It applies no predicate: the branch lives in the shell, and
# the id-only SQL shape is pinned by its own test below.
# The daemon_cycle.py seam points at a guard pass-through (build_guard_passthrough).
# No live PG, no live agents/ dir is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

# build_full_stub — symlink every real command into $1 EXCEPT psql. The whole-PATH
# mirror (vs a hand-maintained allowlist) keeps the fixture robust as the git-free
# daemon's command set shifts; psql is skipped so install_psql_stub can drop its
# faithful PG stand-in in cleanly (a fresh file, not a symlink onto real psql).
build_full_stub() {
  local stub="$1" d f name
  local IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      [[ "${name}" == "psql" ]] && continue
      [[ -e "${stub}/${name}" ]] || ln -sf "${f}" "${stub}/${name}"
    done
  done
}

# setup_file — build the INVARIANT stub bin ONCE per file (was rebuilt per-test): the whole-
# PATH command mirror + the faithful psql stand-in are pure functions of $PATH + runtime STUB_*
# env, byte-identical across all 9 tests, so their ~2.5s of repeated symlinking is hoisted here.
# BATS_FILE_TMPDIR (auto-available in every scope, no export needed) anchors the shared bin
# OUTSIDE per-test WORK, so per-test teardown's `rm -rf WORK` can never remove it.
setup_file() {
  [[ -f "${REAL_SCRIPT}" ]] || return 0
  local shared_stub="${BATS_FILE_TMPDIR}/bin"
  mkdir -p "${shared_stub}"
  build_full_stub "${shared_stub}"
  install_psql_stub "${shared_stub}"
  build_guard_passthrough "${BATS_FILE_TMPDIR}/daemon_cycle_passthrough.py"
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-sd-bats.XXXXXX)" && pwd -P)"
  # STUB and GUARD_SEAM point at the file-scoped fixtures pre-built once in setup_file; only per-test
  # fixture state (git repo, reports, psql log) is created here under the throwaway WORK.
  STUB="${BATS_FILE_TMPDIR}/bin"
  GUARD_SEAM="${BATS_FILE_TMPDIR}/daemon_cycle_passthrough.py"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  PSQL_LOG="${WORK}/psql-invocations.log"
  mkdir -p "${AGENTS}" "${REPORTS}"

  git -C "${AGENTS}" init -q
  git -C "${AGENTS}" config user.email bats@test.local
  git -C "${AGENTS}" config user.name bats
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# build_guard_passthrough PATH — Python stand-in for the AUTOAGENT_DAEMON_CYCLE_PY seam (run as
# `python3 <seam>`): the parked-pattern guard reads through psycopg, which no psql stub isolates, so
# it answers "no guard fires" (stdin drained for the piping printf); every other mode execs the real file.
build_guard_passthrough() {
  local real_literal
  real_literal="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "${GA}/autoagent/daemon_cycle.py")"
  cat >"$1" <<PY
import os
import sys

if "--parked-pattern-guard" in sys.argv[1:]:
    sys.stdin.buffer.read()
    sys.stdout.write('{"guarded": [], "rejected": []}\n')
    sys.exit(0)
os.execv(sys.executable, [sys.executable, ${real_literal}] + sys.argv[1:])
PY
}

# install_psql_stub — write the faithful PG stand-in into the stub bin.
install_psql_stub() {
  local bin="$1"
  cat >"${bin}/psql" <<'STUB'
#!/usr/bin/env bash
# Faithful PG stand-in for daemon-apply single-mode tests. Dispatches on the SQL
# received on stdin + the -v bindings, logs every invocation, and emits canned
# rows / verdicts driven by STUB_* env vars.
set -u
log="${STUB_PSQL_LOG:?stub needs STUB_PSQL_LOG}"

sql="$(cat)"
{
  printf '=== psql invocation ===\n'
  printf 'argv: %s\n' "$*"
  printf 'sql<<<\n%s\n>>>\n' "${sql}"
} >>"${log}"

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

case "${sql}" in
  *"translate(encode(convert_to"*)
    # single lookup — the backlog's 6 fields (free text base64-encoded, as the SELECT does), then
    # status and haiku_status (unset → ok, empty = NULL). STUB_RAW_ROW replaces the row verbatim.
    if [[ "${STUB_SINGLE_RC:-0}" -ne 0 ]]; then
      printf 'psql: error: connection to server failed (stub)\n' >&2
      exit "${STUB_SINGLE_RC}"
    fi
    if [[ -n "${STUB_RAW_ROW:-}" ]]; then
      printf '%s\n' "${STUB_RAW_ROW}"
    elif [[ "${STUB_NO_ROW:-0}" != "1" ]]; then
      printf '%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "${STUB_ROW_ID:?}" "${STUB_CYCLE:?}" "$(b64 "${STUB_LABEL:?}")" \
        "$(b64 "${STUB_AGENT:?}")" "$(b64 "${STUB_TARGET:?}")" "${STUB_DIFF_B64:?}" \
        "${STUB_STATUS:-pending}" "${STUB_HAIKU-ok}"
    fi
    ;;
  *"stale_attempt_count"*)
    # mark_stale_attempt CTE — emit the canned verdict token.
    printf '%s\n' "${STUB_STALE_VERDICT:-incremented}"
    ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${bin}/psql"
}

# make_probe — write the probe.md fixture (protected Absolute-Rules section +
# one editable Goal region) and commit it as the initial fixture state.
make_probe() {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' \
    '- MUST NOT do the dangerous thing' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  git -C "${AGENTS}" add -A
  git -C "${AGENTS}" commit -qm fixture
}

# oor_diff_b64 — base64 (newline-stripped, PG convention) of an out_of_region
# diff anchored on the PROTECTED Absolute-Rules lines.
oor_diff_b64() {
  printf '%s\n' \
    '--- a/probe.md' \
    '+++ b/probe.md' \
    '@@ -5,2 +5,3 @@' \
    ' - MUST NOT do the dangerous thing' \
    '+- injected protected rule' \
    ' - protected rule line alpha' | base64 | tr -d '\n'
}

# run_single — invoke daemon-apply in single mode with the stub PATH + STUB_*
# row fixture. Extra args ($2..) are forwarded (e.g. --dry-run, --auto-regen).
# $1 = haiku_status the stub reports for the row.
run_single() {
  local haiku="$1"
  shift
  run env PATH="${STUB}" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    STUB_PSQL_LOG="${PSQL_LOG}" \
    STUB_ROW_ID="1022" \
    STUB_CYCLE="2026-06-26" \
    STUB_LABEL="${LABEL:-probe-stale}" \
    STUB_AGENT="probe" \
    STUB_TARGET="${AGENTS}/probe.md" \
    STUB_DIFF_B64="$(oor_diff_b64)" \
    STUB_HAIKU="${haiku}" \
    AUTOAGENT_DAEMON_CYCLE_PY="${GUARD_SEAM}" \
    ${STUB_STALE_VERDICT:+STUB_STALE_VERDICT="${STUB_STALE_VERDICT}"} \
    ${STUB_STATUS:+STUB_STATUS="${STUB_STATUS}"} \
    ${STUB_NO_ROW:+STUB_NO_ROW="${STUB_NO_ROW}"} \
    ${STUB_SINGLE_RC:+STUB_SINGLE_RC="${STUB_SINGLE_RC}"} \
    ${STUB_RAW_ROW:+STUB_RAW_ROW="${STUB_RAW_ROW}"} \
    ${ALLOW:+AUTOAGENT_ALLOW_HAIKU_SKIP="${ALLOW}"} \
    bash "${REAL_SCRIPT}" --proposal-id 1022 --agents-dir "${AGENTS}" "$@"
}

applied_log_path() {
  printf '%s/autoagent-applied-%s.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

# dryrun_log_path — today's --dry-run JSONL: the .dryrun sibling of the applied
# log under the SAME reports dir, so AUTOAGENT_REPORTS_DIR isolates both sinks.
dryrun_log_path() {
  printf '%s/autoagent-applied-%s.dryrun.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

# ---------------------------------------------------------------------------
# P1a (a) — out_of_region single row WIRES stale-drain (verdict: incremented)
# ---------------------------------------------------------------------------

@test "P1a: landing_zone_reject drives mark_stale_attempt (incremented) and emits stale_drain log" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok"

  # Single-mode apply-fail → exit 9 (could not apply, left pending).
  [[ "${status}" -eq 9 ]]
  # Loud landing-zone reject recorded (the row anchored outside every region).
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"out_of_region"' "$(applied_log_path)"
  # The stale-drain wiring fired with the mirrored needs_regen log line. The
  # reason composes the full 'stale_drain_<verdict>' value then json-encodes it
  # ONCE (RC2 fix) → one clean JSON string, no nested quotes (json.loads-valid).
  grep -q '"status":"needs_regen"' "$(applied_log_path)"
  grep -q '"reason":"stale_drain_incremented"' "$(applied_log_path)"
  # The mark_stale_attempt CTE actually reached psql (enforce path).
  grep -q 'stale_attempt_count' "${PSQL_LOG}"
}

# ---------------------------------------------------------------------------
# P1a (b) — drained verdict prints the operator "drained to snoozed" WARN
# ---------------------------------------------------------------------------

@test "P1a: drained verdict emits the operator drain WARN + stale_drain_drained log" {
  make_probe
  STUB_STALE_VERDICT="drained"
  run_single "ok"

  [[ "${status}" -eq 9 ]]
  grep -q '"reason":"stale_drain_drained"' "$(applied_log_path)"
  # Operator-facing WARN on stderr (captured by bats in $output).
  [[ "${output}" == *"drained to snoozed"* ]]
}

# ---------------------------------------------------------------------------
# P1a (b2) — H8 provenance: the terminal drain names its mover and adjudicates nothing
# ---------------------------------------------------------------------------

@test "P1a: the terminal drain stamps the drain actor and assigns no reviewed_at" {
  make_probe
  STUB_STALE_VERDICT="drained"
  run_single "ok"

  grep -q 'stale_attempt_count' "${PSQL_LOG}" || {
    echo "the drain CTE never reached psql, so nothing below is observable" >&2
    return 1
  }
  # reviewed_at answers WHEN the row was adjudicated. The drain terminates a fossil and
  # adjudicates nothing, so no statement this run sends may assign it — the whole log is the
  # haystack because the single lookup names the column nowhere either.
  run grep -nE "reviewed_at[[:space:]]*=" "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]] || {
    echo "a statement assigned reviewed_at: ${output}" >&2
    return 1
  }
  # reviewed_by answers WHO moved it, and only the terminal arm of the CASE stamps: an
  # increment leaves the status where it was, so it names no new mover.
  grep -qF "reviewed_by = CASE" "${PSQL_LOG}" || {
    echo "the drain CTE stamps no actor" >&2
    return 1
  }
  grep -qF "actor=daemon-apply-drain" "${PSQL_LOG}" || {
    echo "the drain actor is not bound as a psql variable" >&2
    return 1
  }
  # The token travels as a binding, never concatenated into the quoted heredoc.
  run grep -nE "reviewed_by[[:space:]]*=.*'daemon-apply" "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]] || {
    echo "the drain actor is interpolated into the SQL text: ${output}" >&2
    return 1
  }
}

# ---------------------------------------------------------------------------
# P1a (c) — no_column verdict prints the migration-pending WARN (tolerant degrade)
# ---------------------------------------------------------------------------

@test "P1a: no_column verdict emits the column-absent WARN (fossil NOT drained)" {
  make_probe
  STUB_STALE_VERDICT="no_column"
  run_single "ok"

  [[ "${status}" -eq 9 ]]
  grep -q '"reason":"stale_drain_no_column"' "$(applied_log_path)"
  [[ "${output}" == *"stale_attempt_count column absent"* ]]
}

# ---------------------------------------------------------------------------
# P1a (d) — AUTO_REGEN gate: --auto-regen SKIPS the stale-drain (regen owns it)
# ---------------------------------------------------------------------------

@test "P1a: --auto-regen skips stale-drain (no mark_stale CTE, no stale_drain log)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok" --auto-regen

  # Still a landing-zone reject, but the stale-drain block is gated OFF.
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  run grep -q '"reason":"stale_drain' "$(applied_log_path)"
  [[ "${status}" -ne 0 ]]
  # mark_stale_attempt CTE must NOT have reached psql under --auto-regen.
  run grep -q 'stale_attempt_count' "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# P1a (e) — DRY_RUN reaches NO DB write (short-circuits before the guard)
# ---------------------------------------------------------------------------

@test "P1a: --dry-run short-circuits before the landing-zone guard (no mark_stale CTE)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok" --dry-run

  [[ "${status}" -eq 0 ]]
  # The single SELECT still ran (row fetched) ...
  grep -q 'translate(encode(convert_to' "${PSQL_LOG}"
  # ... but NO mark_stale_attempt CTE was sent (dry-run never reaches the guard).
  run grep -q 'stale_attempt_count' "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]]
  # Dry-run "would_commit" record went to THIS run's dry-run log, keyed on the
  # target this run produced — any other same-day dry-run row satisfies nothing.
  grep '"status":"dryrun"' "$(dryrun_log_path)" | grep -qF "\"target_file\":\"${AGENTS}/probe.md\""
}

# ---------------------------------------------------------------------------
# P3b (f) — a non-ok generation outcome is REFUSED with exit 20 (fail-closed)
# ---------------------------------------------------------------------------

@test "P3b: a non-ok or NULL generation outcome exits 20, leads with Reject, names haiku_status and the carve-out, applies nothing" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  local haiku
  for haiku in "skipped:chronic-timeout-backoff" ""; do
    rm -f -- "$(applied_log_path)" "${PSQL_LOG}"
    run_single "${haiku}"
    [[ "${status}" -eq 20 ]] || {
      echo "haiku_status='${haiku}': expected exit 20, got ${status}: ${output}" >&2
      return 1
    }
    [[ "${output}" == *"] use Reject"* && "${output}" == *"haiku_status=${haiku:-<none>} "* \
      && "${output}" == *"AUTOAGENT_ALLOW_HAIKU_SKIP"* ]] || {
      echo "haiku_status='${haiku}': refusal text lacks Reject / the stored value / the carve-out: ${output}" >&2
      return 1
    }
    [[ ! -f "$(applied_log_path)" ]] && ! grep -q 'stale_attempt_count' "${PSQL_LOG}" || {
      echo "haiku_status='${haiku}': the refused row reached the apply loop" >&2
      return 1
    }
  done
}

# ---------------------------------------------------------------------------
# P3b (g) — operator carve-out admits a haiku-skipped row + prints the loud WARN
# ---------------------------------------------------------------------------

@test "P3b: AUTOAGENT_ALLOW_HAIKU_SKIP=1 admits a haiku-skipped row with a loud WARN" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  ALLOW="1" run_single "skipped:empty-or-error"

  # Carve-out admitted the row → it flowed to the landing-zone reject (exit 9), with the loud
  # operator bypass WARN on stderr in generation-outcome terms.
  [[ "${status}" -eq 9 && "${output}" == *"haiku-skip guard BYPASSED by operator"* \
    && "${output}" == *"generation outcome"* ]] || {
    echo "expected exit 9 with the bypass WARN, got ${status}: ${output}" >&2
    return 1
  }
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# P3b (h) — ok-variant (ok:retried) passes the ok-prefix check (not ='ok')
# ---------------------------------------------------------------------------

@test "P3b: ok:retried is admitted (ok-prefix check preserves the variant)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok:retried"

  # Admitted → reaches the landing-zone reject (exit 9), proving the variant passes.
  [[ "${status}" -eq 9 ]] || {
    echo "expected exit 9, got ${status}: ${output}" >&2
    return 1
  }
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# P3b (i) — SQL-shape pin: the lookup is id-only, the branch lives in the shell
# ---------------------------------------------------------------------------

@test "P3b: the single lookup selects by id only and returns status + haiku_status for the shell to branch on; an unknown id exits 19" {
  make_probe
  STUB_NO_ROW="1" run_single "ok"

  # Exit 19 means one psql call (the lookup), so the log holds exactly its SQL.
  [[ "${status}" -eq 19 && "${output}" == *"id=1022 not found"* && "$(grep -c '=== psql invocation ===' "${PSQL_LOG}")" -eq 1 ]] || {
    echo "expected exit 19 naming the id after one lookup, got ${status}: ${output}" >&2
    return 1
  }
  grep -q "WHERE id::text = :'pid'" "${PSQL_LOG}"
  grep -qE "^[[:space:]]*status,?$" "${PSQL_LOG}"
  grep -qE "coalesce\(haiku_status, ''\)" "${PSQL_LOG}"
  # A status or outcome predicate back in the SQL would collapse 8/20 into the not-found exit.
  run grep -qE "status IN|haiku_status LIKE|allow_haiku_skip" "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# Exit split — 21 query failed · 19 not found (pinned by P3b (i)) · 23 row unreadable · 8 terminal,
# checked in that order
# ---------------------------------------------------------------------------

@test "exit split: a failed lookup query exits 21 and is never read as not-found or a no-op" {
  make_probe
  STUB_SINGLE_RC="2" run_single "ok"

  [[ "${status}" -eq 21 ]] || {
    echo "expected exit 21, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"single_proposal_query failed rc=2"* && "${output}" != *"not found"* \
    && "${output}" != *"already terminal"* ]] || {
    echo "the query failure is not named, or reads as not-found / terminal: ${output}" >&2
    return 1
  }
  [[ ! -f "$(applied_log_path)" ]]
}

@test "exit split: every terminal status exits 8 ahead of the outcome check; snoozed stays actionable" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  local terminal
  for terminal in applied rejected approved reverted; do
    STUB_STATUS="${terminal}" run_single "skipped:chronic-timeout-backoff"
    [[ "${status}" -eq 8 && "${output}" == *"already terminal (status=${terminal})"* ]] || {
      echo "status=${terminal}: expected exit 8 naming the status, got ${status}: ${output}" >&2
      return 1
    }
  done
  STUB_STATUS="snoozed" run_single "ok"
  [[ "${status}" -eq 9 ]] || {
    echo "status=snoozed must reach the apply (exit 9 on this out-of-region fixture), got ${status}: ${output}" >&2
    return 1
  }
}

@test "exit split: a '|' inside the stored label shifts no field — a terminal row still exits 8 and a pending one keeps its whole label" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  LABEL='probe|stale|label'
  STUB_STATUS="rejected" run_single "skipped:chronic-timeout-backoff"
  [[ "${status}" -eq 8 && "${output}" == *"already terminal (status=rejected)"* ]] || {
    echo "a '|' in the label moved the status field: expected exit 8, got ${status}: ${output}" >&2
    return 1
  }
  local column
  for column in "pattern_label" "coalesce(target_agent, '')" "target_file"; do
    grep -qF "encode(convert_to(${column}, 'UTF8'), 'base64')" "${PSQL_LOG}" || {
      echo "the single lookup sends ${column} unencoded, so a '|' in it would shift the status" >&2
      return 1
    }
  done

  run_single "ok"
  [[ "${status}" -eq 9 ]] || {
    echo "the pending '|'-labelled row must reach the apply (exit 9 on this fixture), got ${status}: ${output}" >&2
    return 1
  }
  grep -qF '"pattern_label":"probe|stale|label"' "$(applied_log_path)"
}

@test "exit split: a row that does not decode, or answers for another id, exits 23 before its status is read" {
  make_probe
  local target_b64 raw
  target_b64="$(printf '%s' "${AGENTS}/probe.md" | base64 | tr -d '\n')"
  for raw in \
    "1022|2026-06-26|probe|stale|probe|${AGENTS}/probe.md|$(oor_diff_b64)|rejected|ok" \
    "1023|2026-06-26|cHJvYmU=|cHJvYmU=|${target_b64}|$(oor_diff_b64)|rejected|ok"; do
    rm -f -- "$(applied_log_path)"
    STUB_RAW_ROW="${raw}" run_single "ok"
    [[ "${status}" -eq 23 && "${output}" == *"proposal id=1022 row is unreadable"* &&
      "${output}" != *"already terminal"* && "${output}" != *"lookup failed"* &&
      ! -f "$(applied_log_path)" ]] || {
      echo "row '${raw%%|*}|…': expected exit 23 naming the unreadable row and applying nothing, got ${status}: ${output}" >&2
      return 1
    }
  done
}
