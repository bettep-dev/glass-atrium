#!/usr/bin/env bats
# daemon-apply.sh BACKLOG-ANOMALY abort row suite — pins the durable row the mass-apply tripwire
# writes before exit 7.
#
# WHY THIS ROW EXISTS. The tripwire printf'd FATAL to stderr and exited, and nothing else. On the
# launchd path that stderr has no reader, so the one terminal path that refuses to apply a flooded
# backlog left NO trace behind the cycle — the Precondition Loud-Fail triad with its third leg
# missing, which is the same blindness the preflight abort row and the zero-eligible heartbeat were
# added to close.
#
# LITERAL CHOICE. The row reuses `abort` with a NEW `reason`, and that choice is load-bearing in both
# directions — rationale at the backlog_anomaly_row header in autoagent/daemon-apply.sh. AC3 and AC4
# are what hold each direction closed.
#
#   AC1  a backlog above the threshold exits 7 and writes exactly ONE row with the anomaly shape
#   AC2  the row carries the evidence: observed count, the threshold it exceeded, the exit code
#   AC3  the status literal is `abort` — NOT a completed-cycle literal that would read as recovery
#   AC4  the literal stays inside the set §14's producer pin already fixes
#   AC5  a backlog AT the threshold does not fire (the tripwire is `>`, not `>=`)
#   AC6  a row that cannot be landed degrades to a loud WARN and never changes the exit
#
# Hermetic: a whole-PATH mirror (precedent: daemon-apply-zero-eligible-row.bats) with psql replaced
# by a stub answering every query with a fixed row set, a git shim that allows only `git apply`, an
# echo-OK claude stub, and AUTOAGENT_REPORTS_DIR pointed at a temp dir. No PG, no live agents dir,
# no ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.
#
# Run via: bats autoagent/test/daemon-apply-backlog-anomaly-row.bats
# Requires: bats >= 1.5.0, bash 3.2+, git (for `git apply` only), python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"
ABORT_PIN_SUITE="${GA}/test/doctor-apply-abort-rows.bats"

# mirror_path — symlink every real-PATH executable into $1 except the names this suite stubs (whole-
# PATH mirror per daemon-apply-zero-eligible-row.bats: an allowlist that misses one coreutil makes
# the daemon exit 127 opaquely).
# A `cat >` onto a mirrored symlink follows it and truncates the REAL binary at the far end, so every
# stubbed name is excluded here AND `rm -f`d before each write.
mirror_path() {
  local dest="$1"
  local excl=" psql git claude "
  mkdir -p -- "${dest}"
  local d f name
  local old_ifs="${IFS}"
  IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      case "${excl}" in
        *" ${name} "*) continue ;;
      esac
      [[ -e "${dest}/${name}" ]] || ln -sf "${f}" "${dest}/${name}"
    done
  done
  IFS="${old_ifs}"
}

build_git_apply_shim() {
  local stub="$1" real_git
  real_git="$(command -v git)"
  rm -f -- "${stub}/git"
  cat >"${stub}/git" <<EOF
#!/usr/bin/env bash
sub="\${1:-}"
[[ "\${sub}" == "-C" ]] && sub="\${3:-}"
if [[ "\${sub}" == "apply" ]]; then
  exec "${real_git}" "\$@"
fi
printf 'git-shim: BLOCKED non-apply git subcommand: %s\n' "\${sub:-\${1:-}}" >&2
exit 97
EOF
  chmod +x "${stub}/git"
}

make_claude_stub() {
  rm -f -- "${1}/claude"
  cat >"${1}/claude" <<'SH'
#!/usr/bin/env bash
echo OK
exit 0
SH
  chmod +x "${1}/claude"
}

# make_backlog_psql — a psql present on PATH (so backlog_source_available() is true) that answers
# EVERY query with $2 eligible rows in the producer's own 6-field pipe grammar
# (id|cycle_date|pattern_label|target_agent|target_file|diff_b64). The diff field is empty: the
# tripwire fires on the COUNT before any patch is read, so a real diff would only add fixture noise.
make_backlog_psql() {
  local dir="$1" rows="$2"
  rm -f -- "${dir}/psql"
  cat >"${dir}/psql" <<SH
#!/usr/bin/env bash
i=1
while [[ "\${i}" -le ${rows} ]]; do
  printf '%s|2026-08-0%s|probe-pattern-%s|probe|/tmp/anomaly-probe-%s.md|\n' "\${i}" 1 "\${i}" "\${i}"
  i=\$((i + 1))
done
exit 0
SH
  chmod +x "${dir}/psql"
}

setup_file() {
  MIRROR="${BATS_FILE_TMPDIR}/bin"
  if [[ -f "${REAL_SCRIPT}" ]]; then
    mirror_path "${MIRROR}"
    build_git_apply_shim "${MIRROR}"
    make_claude_stub "${MIRROR}"
  fi
  export MIRROR
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so the daemon's realpath containment check passes.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-anomaly-bats.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  BACKLOG_BIN="${WORK}/bin-backlog"
  mkdir -p -- "${AGENTS}" "${REPORTS}" "${WORK}/home" "${BACKLOG_BIN}"
  printf '%s\n' '{"patches": []}' >"${WORK}/report.json"
  TODAY="$(date -u +%Y-%m-%d)"
  APPLIED_LOG="${REPORTS}/autoagent-applied-${TODAY}.jsonl"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# run_apply — drive the REAL daemon over a backlog of $1 eligible rows against the threshold $2.
# AUTOAGENT_PREFLIGHT_ACTIVE=1: this suite exercises the post-gate tripwire, not the green-suite
# gate, so the sentinel skips the recursive suite run.
run_apply() {
  local rows="$1" threshold="$2"
  make_backlog_psql "${BACKLOG_BIN}" "${rows}"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED PATH="${BACKLOG_BIN}:${MIRROR}" HOME="${WORK}/home" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    AUTOAGENT_ANOMALY_THRESHOLD="${threshold}" \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

row_count() {
  [[ -f "${APPLIED_LOG}" ]] || {
    printf '0'
    return 0
  }
  grep -c -- "$1" "${APPLIED_LOG}" || true
}

dump_log() {
  echo "applied log (${APPLIED_LOG}):" >&2
  cat "${APPLIED_LOG}" 2>&1 >&2 || true
  echo "daemon output: ${output}" >&2
}

# ── AC1 — the tripwire fires, exits 7, and leaves exactly one row ──────────────────────────────

@test "AC1: a backlog above the threshold exits 7 and writes one anomaly abort row" {
  run_apply 3 2
  [[ "${status}" -eq 7 ]] || {
    dump_log
    return 1
  }
  [[ -f "${APPLIED_LOG}" ]] || {
    echo "no applied log — the tripwire is stderr-only again, which launchd discards" >&2
    echo "daemon output: ${output}" >&2
    return 1
  }
  [[ "$(wc -l <"${APPLIED_LOG}" | tr -d ' ')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"reason":"backlog_anomaly"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

# ── AC2 — the row carries the evidence an operator needs to act ────────────────────────────────

@test "AC2: the row states the observed count, the threshold it exceeded, and the exit code" {
  run_apply 3 2
  local missing=""
  # Without the count/threshold pair the row says only THAT the daemon refused, never how far past
  # the bound the backlog ran — which is the difference between a one-off drain and a runaway.
  grep -q '"eligible_pending":3' "${APPLIED_LOG}" || missing="${missing} eligible_pending"
  grep -q '"threshold":2' "${APPLIED_LOG}" || missing="${missing} threshold"
  grep -q '"exit_code":7' "${APPLIED_LOG}" || missing="${missing} exit_code"
  grep -q '"patch_source":"backlog"' "${APPLIED_LOG}" || missing="${missing} patch_source"
  [[ -z "${missing}" ]] || {
    echo "anomaly row missing evidence fields:${missing}" >&2
    dump_log
    return 1
  }
}

# ── AC3 — the status literal must NOT read to doctor §14 as recovery ───────────────────────────

@test "AC3: the row's status is abort, never a post-gate literal that would clear a real abort" {
  run_apply 3 2
  [[ "$(row_count '"status":"abort"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # The load-bearing half. §14 treats every non-abort literal as proof a cycle completed, so a
  # runaway backlog carrying one would supersede an unrelated preflight abort still live in the
  # window — silence traded for a false all-clear.
  local literal
  literal="$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "${APPLIED_LOG}")"
  [[ "${literal}" == "abort" ]] || {
    echo "anomaly row carries '${literal}' — doctor §14 would read it as the gate re-opening" >&2
    dump_log
    return 1
  }
}

# ── AC4 — the literal stays inside the already-pinned producer set ─────────────────────────────

@test "AC4: the anomaly row's status literal is inside the set §14's producer pin fixes" {
  [[ -f "${ABORT_PIN_SUITE}" ]] || skip "abort-rows pin suite not found: ${ABORT_PIN_SUITE}"
  # Read the EXPECTED set out of the pin suite rather than restating it here: a second hand-copied
  # copy of that string is exactly the drift the pin exists to prevent.
  local expected
  expected="$(sed -n 's/^  expected="\(.*\)"$/\1/p' "${ABORT_PIN_SUITE}")"
  [[ -n "${expected}" ]] || {
    echo "could not read the pinned literal set from ${ABORT_PIN_SUITE}" >&2
    return 1
  }
  run_apply 3 2
  local literal
  literal="$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "${APPLIED_LOG}")"
  [[ " ${expected} " == *" ${literal} "* ]] || {
    echo "anomaly literal '${literal}' is OUTSIDE the pinned set '${expected}' — adding it would" >&2
    echo "redden the pin under the preflight test root, aborting the live apply." >&2
    return 1
  }
}

# ── AC5 — the boundary: AT the threshold is not an anomaly ─────────────────────────────────────

@test "AC5: a backlog AT the threshold does not fire the tripwire" {
  # The guard is `>`, so an exactly-at-threshold backlog is a legal drain. Its exit is whatever the
  # apply loop makes of the fixture patches; the assertion is that the tripwire stayed silent.
  run_apply 2 2
  [[ "${status}" -ne 7 ]] || {
    echo "an at-threshold backlog fired the anomaly exit" >&2
    dump_log
    return 1
  }
  [[ "$(row_count '"reason":"backlog_anomaly"')" -eq 0 ]] || {
    echo "an at-threshold backlog wrote the anomaly row" >&2
    dump_log
    return 1
  }
}

# ── AC6 — an unlandable row degrades loudly and leaves the exit alone ──────────────────────────

@test "AC6: a row that cannot be landed WARNs and never changes the exit" {
  # A directory AT the sink path fails the append for any uid — a read-only mode would not, since
  # the daemon can run as root.
  mkdir -p -- "${APPLIED_LOG}"
  run_apply 3 2
  # The emit is a recorder, never a decider: exit 7 is what the caller (and daemon-cycle.sh) reads,
  # so a sink that cannot be written must not turn a refused mass-apply into some other outcome.
  [[ "${status}" -eq 7 ]] || {
    echo "an unlandable row moved the exit to ${status} — the tripwire's contract is 7" >&2
    echo "daemon output: ${output}" >&2
    return 1
  }
  # And the degrade has to be audible: without this line the operator sees the FATAL, finds no row,
  # and cannot tell a missing sink from a tripwire that never fired.
  [[ "${output}" == *"backlog-anomaly abort row NOT persisted"* ]] || {
    echo "the row failed to land silently — no WARN naming the sink" >&2
    echo "daemon output: ${output}" >&2
    return 1
  }
}
