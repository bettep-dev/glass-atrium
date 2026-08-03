#!/usr/bin/env bats
# daemon-apply.sh ZERO-ELIGIBLE post-gate row suite (T3-1) — pins the heartbeat row a cycle with
# nothing to apply writes.
#
# WHY THIS ROW EXISTS. doctor §14 reports an apply-preflight abort as a live condition until a LATER
# post-gate row proves the gate re-opened. A cycle that clears the gate and finds zero eligible
# patches used to print to stderr and exit 0 having written NOTHING, so a recovered-but-idle daemon
# never superseded its own earlier abort: the launchd path discards that stderr, and the applied log
# — the only durable trace — stayed silent. The row is the missing evidence, not a cosmetic log line.
#
# LITERAL CHOICE. The row carries the EXISTING `skip` literal with a new `reason`, never a dedicated
# one. The producer's status-literal set is pinned by string equality in test/doctor-apply-abort-rows
# .bats (AC7) under a preflight test root, so a new literal would redden that suite, trip the fatal
# green-suite preflight, abort the live apply and write the very abort row this row exists to
# supersede. AC5 below pins that the literal actually used stays inside that already-pinned set.
#
#   AC1  backlog source, zero eligible → exactly ONE row: status skip, reason zero_eligible
#   AC2  report source, zero eligible  → the SAME row (the second silent exit, stated separately)
#   AC3  preflight abort               → the abort row and NO post-gate row (never self-supersede)
#   AC4  one eligible patch            → per-patch rows only, no extra heartbeat (no double count)
#   AC5  the row's status literal is inside the set §14's producer pin already fixes
#
# Hermetic: a whole-PATH mirror (precedent: daemon-apply-landing-zone.bats) with psql either MASKED
# (report fallback) or replaced by a zero-row STUB (backlog fallback with an empty eligible set), a
# git shim that allows only `git apply`, an echo-OK claude stub so a claude-less CI runner behaves
# like a claude-bearing one, and AUTOAGENT_REPORTS_DIR pointed at a temp dir. No PG, no live agents
# dir, no ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.
#
# Run via: bats autoagent/test/daemon-apply-zero-eligible-row.bats
# Requires: bats >= 1.5.0, bash 3.2+, git (for `git apply` only), python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"
ABORT_PIN_SUITE="${GA}/test/doctor-apply-abort-rows.bats"

# mirror_path — symlink every real-PATH executable into $1 except the names in $2.. (whole-PATH
# mirror per build_psql_masked_stub: an allowlist that misses one coreutil makes the daemon exit 127
# opaquely). psql, git and claude are always excluded — this suite supplies its own of each.
mirror_path() {
  local dest="$1"
  shift
  # EVERY name this suite later stubs MUST appear here.
  # A `cat >` onto a mirrored symlink follows it and truncates the REAL binary at the far end.
  # Precedent: daemon-apply-stale-drain-haiku-guard.bats — "a fresh file, not a symlink onto real psql".
  local excl=" $* psql git claude "
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

# build_git_apply_shim — allow-only-apply `git`: `git [-C <dir>] apply …` execs the REAL git, every
# other subcommand hard-fails (precedent: daemon-apply-landing-zone.bats). A suppressed non-apply git
# call inside the git-free daemon therefore breaks loudly instead of passing unnoticed.
build_git_apply_shim() {
  local stub="$1" real_git
  real_git="$(command -v git)"
  rm -f -- "${stub}/git" # never redirect onto an inherited symlink
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

# make_claude_stub — echo-OK `claude` so this suite behaves identically on a claude-less CI runner
# and a developer machine (the fixtures below pre-set haiku_status, so no live model call is needed —
# but a PATH without claude and one with it must not diverge silently).
make_claude_stub() {
  rm -f -- "${1}/claude" # never redirect onto an inherited symlink
  cat >"${1}/claude" <<'SH'
#!/usr/bin/env bash
echo OK
exit 0
SH
  chmod +x "${1}/claude"
}

# make_empty_backlog_psql — a psql that answers EVERY query with zero rows and exits 0. Present on
# PATH, so backlog_source_available() is true and the daemon takes the BACKLOG source with an empty
# eligible set — the exact live shape (a drained backlog) the heartbeat row exists for.
make_empty_backlog_psql() {
  rm -f -- "${1}/psql" # never redirect onto an inherited symlink
  cat >"${1}/psql" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "${1}/psql"
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
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-zeroelig-bats.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents" # PLAIN dir — the git-free daemon needs NO repo here.
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

# run_apply — drive the REAL daemon over the fixture. AUTOAGENT_PREFLIGHT_ACTIVE=1: this suite
# exercises the post-gate emit, not the green-suite gate, so the sentinel skips the recursive suite
# run. $1 = the PATH to run under (mirror = psql masked → report source; a dir carrying the zero-row
# psql stub → backlog source).
run_apply() {
  run env -u AUTOAGENT_ALLOW_UNVERIFIED PATH="$1" HOME="${WORK}/home" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

# backlog_path — the mirror PLUS the zero-row psql stub, ahead of it so `command -v psql` resolves.
backlog_path() {
  make_empty_backlog_psql "${BACKLOG_BIN}"
  printf '%s:%s' "${BACKLOG_BIN}" "${MIRROR}"
}

# Count rows in today's applied log matching the grep pattern $1 (0 when the log does not exist).
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

# ── AC1 — the backlog source drained: ONE post-gate row ────────────────────────────────────────

@test "AC1: a zero-eligible BACKLOG cycle writes exactly one skip/zero_eligible row" {
  run_apply "$(backlog_path)"
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ -f "${APPLIED_LOG}" ]] || {
    echo "no applied log written — a recovered-but-idle cycle left nothing to supersede an abort" >&2
    echo "daemon output: ${output}" >&2
    return 1
  }
  [[ "$(wc -l <"${APPLIED_LOG}" | tr -d ' ')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"skip"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # the row has to name WHICH source drained, or an operator cannot tell a drained backlog from a
  # report-fallback cycle that never had a DB at all.
  [[ "$(row_count '"patch_source":"backlog"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

# ── AC2 — the report fallback is the second silent exit, and gets the same row ─────────────────

@test "AC2: a zero-eligible REPORT cycle writes the same single post-gate row" {
  run_apply "${MIRROR}" # psql masked → report fallback over the empty-patches fixture
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ "$(wc -l <"${APPLIED_LOG}" | tr -d ' ')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"skip"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"patch_source":"report"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

# ── AC3 — an aborting cycle never supersedes its own abort ─────────────────────────────────────

@test "AC3: a preflight-aborting cycle writes the abort row and NO post-gate row" {
  # A sandbox copy WITHOUT the four test roots drives the real preflight into its abort (precedent:
  # test/doctor-apply-abort-rows.bats emit_abort_row) — the sentinel is dropped so the gate runs.
  local sandbox="${WORK}/real"
  mkdir -p -- "${sandbox}/autoagent/lib" "${sandbox}/scripts/lib"
  cp -p -- "${REAL_SCRIPT}" "${sandbox}/autoagent/daemon-apply.sh"
  cp -p -- "${GA}/autoagent/lib/git-txn.sh" "${sandbox}/autoagent/lib/git-txn.sh"
  cp -p -- "${GA}/autoagent/daemon_cycle.py" "${sandbox}/autoagent/daemon_cycle.py"
  cp -p -- "${GA}/scripts/lib/apply-lock.sh" "${sandbox}/scripts/lib/apply-lock.sh"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    PATH="${MIRROR}" HOME="${WORK}/home" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    bash "${sandbox}/autoagent/daemon-apply.sh" \
    --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -eq 16 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"abort"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # the load-bearing half: a cycle that never opened the gate must not claim post-gate progress.
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 0 ]] || {
    echo "an aborting cycle wrote the superseding row — it would clear its own abort" >&2
    dump_log
    return 1
  }
}

# ── AC4 — the normal path is untouched (no double counting) ────────────────────────────────────

@test "AC4: a cycle with one eligible patch writes the per-patch row only, no heartbeat" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  local diff='--- a/probe.md
+++ b/probe.md
@@ -8,2 +8,3 @@
 editable goal line one
+inserted editable line
 editable goal line two'
  python3 - "${AGENTS}/probe.md" "${diff}" >"${WORK}/report.json" <<'PY'
import json
import sys

target, diff = sys.argv[1], sys.argv[2]
print(
    json.dumps(
        {
            "patches": [
                {
                    "classification": "body-auto",
                    "approval_tier": "auto",
                    "pre_verify_passed": True,
                    "haiku_status": "ok",
                    "pattern_label": "probe-in",
                    "pattern_agent": "probe",
                    "target_file": target,
                    "proposed_diff": diff + "\n",
                }
            ]
        }
    )
)
PY
  run_apply "${MIRROR}"
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"applied"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # negative polarity: the heartbeat is for the EMPTY cycle only — a cycle that applied something
  # already testifies to post-gate progress, and a second row would double-count it.
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 0 ]] || {
    echo "a cycle that applied a patch also wrote the zero-eligible heartbeat" >&2
    dump_log
    return 1
  }
}

# ── AC5 — the literal stays inside the already-pinned producer set ─────────────────────────────

@test "AC5: the heartbeat row's status literal is inside the set §14's producer pin fixes" {
  [[ -f "${ABORT_PIN_SUITE}" ]] || skip "abort-rows pin suite not found: ${ABORT_PIN_SUITE}"
  # Read the EXPECTED set out of the pin suite rather than restating it here: a second hand-copied
  # copy of that string is exactly the drift the pin exists to prevent.
  local expected
  expected="$(sed -n 's/^  expected="\(.*\)"$/\1/p' "${ABORT_PIN_SUITE}")"
  [[ -n "${expected}" ]] || {
    echo "could not read the pinned literal set from ${ABORT_PIN_SUITE}" >&2
    return 1
  }
  run_apply "${MIRROR}"
  local literal
  literal="$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "${APPLIED_LOG}")"
  [[ -n "${literal}" ]] || {
    dump_log
    return 1
  }
  # membership, by the same whitespace-delimited form the pin uses.
  [[ " ${expected} " == *" ${literal} "* ]] || {
    echo "heartbeat literal '${literal}' is OUTSIDE the pinned set '${expected}' — adding it would" >&2
    echo "redden the pin under the preflight test root, aborting the live apply." >&2
    return 1
  }
}
