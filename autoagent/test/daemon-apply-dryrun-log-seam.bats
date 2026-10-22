#!/usr/bin/env bats
# daemon-apply.sh --dry-run applied-log SEAM suite — pins the dry-run sink to the
# data-root seam the non-dry-run sink already uses:
#
#   APPLIED_LOG = ${REPORTS_DIR}/autoagent-applied-<UTC date>.dryrun.jsonl
#   REPORTS_DIR = ${AUTOAGENT_REPORTS_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-reports}
#
# Each leg of that chain gets its own case, because a dry-run is the FIRST writer
# of the data root on this path (the apply lock is skipped entirely in dry-run),
# so directory creation is a property of the seam and not an inherited one.
#
# The `.dryrun.jsonl` suffix is load-bearing: the file lands INSIDE the reports dir
# the backfill globs, so only the anchored filename filter keeps a simulated row out
# of the real applied-log corpus.
#
# Run via: bats autoagent/test/daemon-apply-dryrun-log-seam.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3
#
# Hermetic strategy: each dry-run drives the single-proposal path (--proposal-id)
# with PATH at a stub bin mirroring every real command EXCEPT psql, whose stand-in
# answers the id lookup — the one statement a dry-run issues — from a per-test row
# file (precedent: daemon-apply-landing-zone.bats). The parked-pattern guard (a
# psycopg reader no psql stub isolates) answers "no guard fires" through the
# AUTOAGENT_DAEMON_CYCLE_PY seam, and the stored row carries an ok generation
# outcome, so the dry-run short-circuit is reached. Agents and reports dirs live
# under a per-test mktemp WORK, and every assertion is keyed on a label unique to
# THIS run — a row another writer left behind can satisfy none of them. No live PG,
# no live agents dir, no live data root is touched.
#
# Every assertion carries a `|| return 1` fail-fast guard: an unguarded intermediate
# `[[ ]]` is masked under bash 3.2 (the macOS default) though CI's bash 5.3 gates it.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"
PROPOSAL_ID=501
BACKFILL_PY="${GA}/scripts/autoagent-status-backfill.py"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

# build_psql_masked_stub — symlink every real command into $1 EXCEPT psql. The
# whole-PATH mirror (vs a hand-maintained allowlist) keeps psql the ONLY masked
# command as the daemon's coreutils set shifts; an allowlist that misses one makes
# the daemon exit 127 mid-run and every case fail opaquely.
build_psql_masked_stub() {
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

# install_psql_stub — the PG stand-in: the id lookup answers the per-test row file.
install_psql_stub() {
  cat >"$1/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "${sql}" in
  *"id::text = :'pid'"*) cat -- "${STUB_SINGLE_ROW:?}" ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "$1/psql"
}

# build_guard_passthrough PATH — Python stand-in for the AUTOAGENT_DAEMON_CYCLE_PY seam (run as
# `python3 <seam>`): the parked-pattern guard answers "no guard fires" (stdin drained for the
# piping printf); every other mode execs the real file.
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

# setup_file — build the invariant stub bin and guard stand-in ONCE. `skip` is
# illegal here; a missing daemon-apply.sh is handled by the per-test setup skip below.
setup_file() {
  STUB="${BATS_FILE_TMPDIR}/bin"
  GUARD_SEAM="${BATS_FILE_TMPDIR}/daemon_cycle_passthrough.py"
  mkdir -p -- "${STUB}"
  if [[ -f "${GA}/autoagent/daemon-apply.sh" ]]; then
    build_psql_masked_stub "${STUB}"
    install_psql_stub "${STUB}"
    build_guard_passthrough "${GUARD_SEAM}"
  fi
  export STUB GUARD_SEAM
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so the realpath containment check passes.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-drs-bats.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents" # PLAIN dir — the git-free daemon needs NO repo here.
  FAKE_HOME="${WORK}/home"
  mkdir -p -- "${AGENTS}" "${FAKE_HOME}"
  CYCLE_DATE="$(date -u +%Y-%m-%d)"
  # The shared host path outside the seam — the negative half of every case.
  HOST_LOG="/tmp/autoagent-applied-${CYCLE_DATE}.dryrun.jsonl"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# b64 — base64 without line breaks, as the single lookup encodes free text.
b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

# write_proposal_row LABEL — write probe.md under AGENTS and the stored pending
# proposal the single lookup returns for it, carrying LABEL as its pattern_label.
write_proposal_row() {
  local label="$1" label_b64 agent_b64 target_b64 diff_b64
  printf '%s\n' '# Probe Agent' '' '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  label_b64="$(b64 "${label}")"
  agent_b64="$(b64 probe)"
  target_b64="$(b64 "${AGENTS}/probe.md")"
  diff_b64="$(printf '%s\n' '--- a/probe.md' '+++ b/probe.md' '@@ -5,1 +5,2 @@' \
    ' editable goal line one' '+inserted editable line' | base64 | tr -d '\n')"
  printf '%s|2026-06-26|%s|%s|%s|%s|pending|ok\n' "${PROPOSAL_ID}" "${label_b64}" \
    "${agent_b64}" "${target_b64}" "${diff_b64}" >"${WORK}/proposal.row"
}

# run_dryrun LABEL ENV... — dry-run the real script over the LABEL proposal with the
# stub PATH. Extra args are forwarded to `env` FIRST, so a case may lead with
# `-u NAME` options: env stops reading options at the first assignment, and the
# fixed assignments below would otherwise swallow them as a command name.
run_dryrun() {
  local label="$1"
  shift
  write_proposal_row "${label}"
  run env "$@" PATH="${STUB}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    STUB_SINGLE_ROW="${WORK}/proposal.row" AUTOAGENT_DAEMON_CYCLE_PY="${GUARD_SEAM}" \
    bash "${REAL_SCRIPT}" --dry-run --proposal-id "${PROPOSAL_ID}" --agents-dir "${AGENTS}"
}

# dryrun_log_path DIR — the dry-run JSONL inside the given reports directory.
dryrun_log_path() {
  printf '%s/autoagent-applied-%s.dryrun.jsonl' "$1" "${CYCLE_DATE}"
}

# assert_row_landed DIR LABEL — the dry-run row for LABEL is in DIR's dry-run log,
# and the run's own marker never reached the shared host path. `-e` guards
# the host file's absence (a clean CI host has none) so grep is never handed a
# missing path.
assert_row_landed() {
  local log
  log="$(dryrun_log_path "$1")"
  [[ -f "${log}" ]] || { echo "no dry-run log at ${log}" >&2; return 1; }
  grep -qF "\"pattern_label\":\"$2\"" "${log}" || { echo "row missing: $(cat "${log}")" >&2; return 1; }
  grep -qF '"status":"dryrun"' "${log}" || { echo "not a dryrun row: $(cat "${log}")" >&2; return 1; }
  [[ ! -e "${HOST_LOG}" ]] || ! grep -qF "$2" "${HOST_LOG}" || {
    echo "marker $2 leaked to the shared host path ${HOST_LOG}" >&2
    return 1
  }
}

# ---------------------------------------------------------------------------
# (a) AUTOAGENT_REPORTS_DIR — the override every existing suite already sets
# ---------------------------------------------------------------------------

@test "dry-run: AUTOAGENT_REPORTS_DIR receives the row, the shared host path does not" {
  local label="dryrun-seam-a-$$"
  local reports="${WORK}/reports"
  mkdir -p -- "${reports}"
  run_dryrun "${label}" AUTOAGENT_REPORTS_DIR="${reports}" HOME="${FAKE_HOME}" GA_DATA_ROOT="${FAKE_HOME}/.glass-atrium"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  assert_row_landed "${reports}" "${label}" || return 1
  # A simulated row never takes the real applied-log name, whatever the directory.
  [[ ! -e "${reports}/autoagent-applied-${CYCLE_DATE}.jsonl" ]] || {
    echo "dry-run wrote the REAL applied-log basename" >&2
    return 1
  }
}

# ---------------------------------------------------------------------------
# (b) GA_DATA_ROOT — the seam's middle leg. The directory is deliberately NOT
#     pre-created: a dry-run skips the apply lock entirely, so it is the first
#     writer of this data root and must create the tree itself.
# ---------------------------------------------------------------------------

@test "dry-run: GA_DATA_ROOT override is honored and its reports dir is created" {
  local label="dryrun-seam-b-$$"
  local root="${WORK}/custom-root"
  run_dryrun "${label}" -u AUTOAGENT_REPORTS_DIR GA_DATA_ROOT="${root}" HOME="${FAKE_HOME}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -d "${root}/data/daemon-reports" ]] || { echo "data root not created" >&2; return 1; }
  assert_row_landed "${root}/data/daemon-reports" "${label}" || return 1
}

# ---------------------------------------------------------------------------
# (c) no override at all — the HOME-anchored default. An unredirected run writes
#     the live data root through this leg, which is what FAKE_HOME stands in for.
# ---------------------------------------------------------------------------

@test "dry-run: with no override the row lands under \$HOME/.glass-atrium" {
  local label="dryrun-seam-c-$$"
  run_dryrun "${label}" -u AUTOAGENT_REPORTS_DIR -u GA_DATA_ROOT HOME="${FAKE_HOME}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  assert_row_landed "${FAKE_HOME}/.glass-atrium/data/daemon-reports" "${label}" || return 1
}

# ---------------------------------------------------------------------------
# (d) reader exclusion — the dry-run file sits inside the directory the
#     backfill globs, so its anchored filename filter is what keeps a simulated
#     row out of the real corpus. The pattern is read from the production source,
#     never restated here.
# ---------------------------------------------------------------------------

@test "the backfill filename filter rejects the dry-run basename and accepts the real one" {
  [[ -f "${BACKFILL_PY}" ]] || skip "backfill not found: ${BACKFILL_PY}"
  local py
  py="$(
    cat <<'PY'
import re
import sys

src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'_FNAME_RE\s*=\s*re\.compile\(r"([^"]+)"\)', src)
if not m:
    sys.exit("_FNAME_RE literal not found in the backfill source")
rx = re.compile(m.group(1))
print("dry=%s real=%s" % (bool(rx.match(sys.argv[2])), bool(rx.match(sys.argv[3]))))
PY
  )"
  run python3 -c "${py}" "${BACKFILL_PY}" \
    "autoagent-applied-${CYCLE_DATE}.dryrun.jsonl" "autoagent-applied-${CYCLE_DATE}.jsonl"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == "dry=False real=True" ]] || { echo "filter verdict: ${output}" >&2; return 1; }
}

# ---------------------------------------------------------------------------
# (e) reader exclusion, operator-facing half — the doctor's abort scan globs
#     `autoagent-applied-*.jsonl` under the reports dir, which the dry-run file
#     matches too. Only its date pattern keeps a SIMULATED abort out of a real
#     doctor verdict. The function is awk-range-extracted
#     rather than sourced (precedent: daemon-apply-json-fallback-haiku-guard.bats),
#     so the assertion runs the production code with none of the doctor's env.
# ---------------------------------------------------------------------------

@test "the doctor abort scan skips the dry-run sibling beside a real applied log" {
  local doctor="${GA}/lib/ga-doctor.sh"
  [[ -f "${doctor}" ]] || skip "ga-doctor.sh not found: ${doctor}"
  local scan_dir="${WORK}/doctor-scan"
  local fn="${WORK}/apply-abort-scan.sh"
  mkdir -p -- "${scan_dir}"
  awk '/^_apply_abort_scan\(\) \{/,/^\}/' "${doctor}" >"${fn}"
  grep -q '^_apply_abort_scan() {' "${fn}" || { echo "extraction missed the function" >&2; return 1; }

  # The real log is present but ROWLESS on purpose: the directory's ONLY abort row
  # sits in the dry-run sibling, so a scan that stopped filenames-filtering would
  # report `abort` and name the decoy instead of the `none` a real corpus yields.
  : >"${scan_dir}/autoagent-applied-${CYCLE_DATE}.jsonl"
  printf '%s\n' '{"ts":"1970-01-01T00:00:00.000Z","status":"abort","reason":"dryrun_decoy"}' \
    >"$(dryrun_log_path "${scan_dir}")"

  run bash -c 'set -Eeuo pipefail; . "$1"; _apply_abort_scan "$2" "$3"' _ \
    "${fn}" "${scan_dir}" "1970-01-01"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${lines[0]}" == "none" ]] || { echo "verdict=${lines[0]} (dry-run row was read)" >&2; return 1; }
  [[ "${output}" != *dryrun_decoy* ]] || { echo "decoy row surfaced: ${output}" >&2; return 1; }
}
