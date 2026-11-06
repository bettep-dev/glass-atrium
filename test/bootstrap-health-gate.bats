#!/usr/bin/env bats
# bootstrap-health-gate.bats — falsifiable coverage for the monitor bootstrap health gate's
# DB-field correctness fix (STEP 5). /api/health ALWAYS returns HTTP 200 (degraded → db:"closed"
# on a DB failure), so an http-code-only PASS FALSE-PASSES a DB-down monitor. The gate now:
#   * bounds BOTH curls with --connect-timeout/--max-time (a still-booting monitor cannot wedge it),
#   * captures the response BODY (not -o /dev/null) and requires db:"open" before PASS,
#   * emits a DISTINCT 'monitor up but DB unavailable' loud-fail (exit BOOTSTRAP_EXIT_HEALTH).
#
# Run via: bats test/bootstrap-health-gate.bats
# Requires: bats, bash 3.2+
#
# Hermetic: STATIC assertions grep/awk the bootstrap_health_gate function text (no node/curl/DB is
# ever driven — the gate starts a real monitor + polls, out of scope for a unit test). Each assertion
# must key on a SEMANTIC token of the gate decision, never on a source idiom the function could
# express another way, and never on a token that also appears in the function's own comments.
# Exception: the listener-check row runs the extracted gate against shell stubs (curl, lsof) and a
# sleeping `node` stand-in, so no real monitor, port or DB is reached.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CORE_SH="${GA}/lib/ga-db.sh"

setup() {
  [[ -f "${CORE_SH}" ]] || skip "lib not found: ${CORE_SH}"
  trap - ERR
}

# gate_body — the bootstrap_health_gate function text (column-1 def → its closing brace).
gate_body() {
  awk '/^bootstrap_health_gate\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${CORE_SH}"
}

# === STEP 5 — both curls are bounded by connect + max timeouts ==========================

@test "STEP5(static): BOTH health curls carry --connect-timeout + --max-time" {
  local body
  body="$(gate_body)"
  [[ -n "${body}" ]]
  # precondition (pre-existing-listener) curl + the poll curl are BOTH bounded.
  [[ "$(grep -c -- '--connect-timeout 2 --max-time 5' <<<"${body}")" -eq 2 ]]
  # both curl invocations (precondition + poll) exist — each `curl -s` keyword on its own line,
  # so the bounded count above (2) covers every curl the gate issues (no unbounded one survives).
  [[ "$(grep -c 'curl -s' <<<"${body}")" -eq 2 ]]
}

# === STEP 5 — the db-field gate + its distinct loud-fail ================================

@test "STEP5(static): the db-field gate requires db:open and PASS is gated on db_open==yes" {
  local body
  body="$(gate_body)"
  [[ -n "${body}" ]]
  # db_open derived from the body (tolerant of an optional space after the colon).
  [[ "${body}" == *'*'"'"'"db":"open"'"'"'*'* ]]
  [[ "${body}" == *'db_open="yes"'* ]]
  # PASS branch now requires db_open==yes (not merely http 200 + listener).
  [[ "${body}" == *'"${http_code}" == "200" && "${listener_ok}" == "yes" && "${db_open}" == "yes"'* ]]
}

@test "STEP5(static): a DISTINCT db-unavailable loud-fail exits BOOTSTRAP_EXIT_HEALTH" {
  local body
  body="$(gate_body)"
  [[ -n "${body}" ]]
  # the 200 + our-listener + db-not-open branch is its own loud-fail (monitor up, DB down).
  [[ "${body}" == *'"${http_code}" == "200" && "${listener_ok}" == "yes" && "${db_open}" != "yes"'* ]]
  [[ "${body}" == *'monitor up, DB unavailable'* ]]
  # it surfaces the health-gate code on its fail paths via the exit_step force-quit-guard wrapper — `exit` on the
  # CLI passthrough (GA_TUI_STEP unset), `return` under the TUI run_step; the CLI exit-code is unchanged.
  [[ "$(grep -c 'exit_step "${BOOTSTRAP_EXIT_HEALTH}"' <<<"${body}")" -ge 3 ]]
}

# === listener check — the gate's own child heading a listener list past one pipe buffer =========
@test "the gate passes when its own child heads a listener list past one pipe buffer" {
  local stub_bin="${BATS_TEST_TMPDIR}/bin" pids="${BATS_TEST_TMPDIR}/pids"
  mkdir -p "${stub_bin}" "${BATS_TEST_TMPDIR}/ga/monitor"
  # the monitor child: a stand-in process the gate starts, polls and stops
  printf '#!/bin/sh\nexec /bin/sleep 30\n' >"${stub_bin}/node"
  chmod +x "${stub_bin}/node"
  awk 'BEGIN { for (i = 0; i < 170000; i++) print 100000 + i }' >"${pids}"
  gate_body >"${BATS_TEST_TMPDIR}/gate.sh"
  # shellcheck source=/dev/null
  source "${BATS_TEST_TMPDIR}/gate.sh"
  local rc=0 out
  # shellcheck disable=SC2034,SC2154,SC2329  # the gate's globals, its local mon_pid and the stubs it calls, which shellcheck cannot trace
  (
    set -o pipefail
    export PATH="${stub_bin}:${PATH}" TMPDIR="${BATS_TEST_TMPDIR}"
    GA_ROOT="${BATS_TEST_TMPDIR}/ga" BOOTSTRAP_HEALTH_WINDOW_SECS=3 BOOTSTRAP_EXIT_HEALTH=9
    LOAD_LAUNCHD=false LAUNCHD_JOBS=()
    log() { printf '%s\n' "$*"; }
    die() {
      printf 'DIE %s\n' "$*"
      exit 97
    }
    exit_step() { return 1; }
    atrium_monitor_port() { printf '16999\n'; }
    sleep() { :; }
    # the precondition probe finds no listener; the poll answers 200 with db:open
    curl() {
      case " $* " in *' -o /dev/null '*) return 7 ;; *) ;; esac
      printf '{"db":"open"}\n200'
    }
    # the gate's child first, then ~1 MB of other pids: an early-exit lookup leaves its writer mid-write
    lsof() {
      printf '%s\n' "${mon_pid}"
      cat "${pids}"
    }
    bootstrap_health_gate
  ) >"${BATS_TEST_TMPDIR}/gate.out" 2>&1 || rc=$?
  out="$(cat "${BATS_TEST_TMPDIR}/gate.out")"
  [[ "${rc}" -eq 0 ]] || {
    printf 'rc %s\n%s\n' "${rc}" "${out}"
    return 1
  }
  [[ "${out}" == *"monitor health gate PASS"* ]] || {
    printf '%s\n' "${out}"
    return 1
  }
}
