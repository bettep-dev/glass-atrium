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
# ever driven — the gate starts a real monitor + polls, out of scope for a unit test), plus DYNAMIC
# tests of the exact body/code split + db-field matcher idioms in isolation.

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

# === STEP 5 — the poll captures the BODY and the gate requires db:"open" =================

@test "STEP5(static): the poll captures the response body (not -o /dev/null) via -w code line" {
  local body
  body="$(gate_body)"
  [[ -n "${body}" ]]
  # the poll appends the http_code on its own trailing line + splits body/code.
  [[ "${body}" == *"-w '\\n%{http_code}'"* ]]
  [[ "${body}" == *'http_code="$(printf '"'"'%s\n'"'"' "${resp}" | tail -n1)"'* ]]
  [[ "${body}" == *"body=\"\$(printf '%s\\n' \"\${resp}\" | sed '\$d')\""* ]]
}

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
  # it surfaces the health-gate code on its fail paths via the T2b exit_step wrapper — `exit` on the
  # CLI passthrough (GA_TUI_STEP unset), `return` under the TUI run_step; the CLI exit-code is unchanged.
  [[ "$(grep -c 'exit_step "${BOOTSTRAP_EXIT_HEALTH}"' <<<"${body}")" -ge 3 ]]
}

# === STEP 5 — the body/code split + db-field matcher idioms (dynamic, falsifiable) =======

@test "STEP5(parse): last line is the http_code, everything before it is the JSON body" {
  local resp http_code body
  resp="$(printf '%s' '{"status":"ok","db":"open"}
200')"
  http_code="$(printf '%s\n' "${resp}" | tail -n1)"
  body="$(printf '%s\n' "${resp}" | sed '$d')"
  [[ "${http_code}" == "200" ]]
  [[ "${body}" == '{"status":"ok","db":"open"}' ]]
}

@test "STEP5(parse): an OPEN db body passes the db-field gate" {
  local body='{"status":"ok","db":"open","browser":"ok"}'
  local db_open="no"
  case "${body}" in
    *'"db":"open"'* | *'"db": "open"'*) db_open="yes" ;;
    *) db_open="no" ;;
  esac
  [[ "${db_open}" == "yes" ]]
}

@test "STEP5(parse): a CLOSED (degraded) db body FAILS the db-field gate at http 200" {
  local body='{"status":"degraded","db":"closed","browser":"ok"}'
  local db_open="no"
  case "${body}" in
    *'"db":"open"'* | *'"db": "open"'*) db_open="yes" ;;
    *) db_open="no" ;;
  esac
  [[ "${db_open}" == "no" ]]
}
