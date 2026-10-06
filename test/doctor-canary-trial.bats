#!/usr/bin/env bats
# doctor-canary-trial.bats — pins run_doctor's canary-trial warnings (lib/ga-doctor.sh §10 + §28).
#
# Four conditions cost a canary trial its evidence without failing anything, so each one is a
# counted warning under the `canary-trial` breakdown term:
#   · a shed canary — a DROP row with block=canary in the §10 shed log, kept apart from the
#     scope-block drop count, whose remedy names a different cause;
#   · a hash-mismatch void and a delivery bound to no open trial — trial-ledger rows the daemon
#     writes at MANIFEST ingest;
#   · an install with neither digest tool the hook probes, where no canary is ever delivered.
# Every leg is read-only: the ledger read is one SELECT, and nothing is written.
#
# NO DATABASE IS CONTACTED. psql resolves to a recording stub first on PATH that answers per query
# kind; GA_PG_SOCKET points at an empty directory and GA_DB_NAME at a throwaway name, so even a
# stub bypass could reach no live server.
#
# Run via: bats test/doctor-canary-trial.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-canary-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STUB="${SANDBOX}/bin"
  STUB_STATE="${SANDBOX}/stub"
  MIGRATIONS="${SANDBOX}/migrations"
  PG_EMPTY="${SANDBOX}/pg-socket-empty"
  DROPLOG="${SANDBOX}/data/logs/inject-scope-rules.diag.log"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STUB}" "${STUB_STATE}" "${MIGRATIONS}" \
    "${PG_EMPTY}" "${SANDBOX}/data/logs"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_psql_stub
}

teardown() {
  unset GA_SKIP_DB_SETUP
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# Recording psql stub: the query kind is read off the SQL on stdin; answer and exit code come from
# per-kind files; every call is logged with its statement.
seed_psql_stub() {
  cat >"${STUB}/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "${sql}" in
  *pg_database*) kind=exists ;;
  *autoagent_trial_ledger*) kind=ledger ;;
  *) kind=other ;;
esac
{
  printf '%s\n' "${kind}"
  printf 'sql<<<\n%s\n>>>\n' "${sql}"
} >>"${GA_STUB_STATE}/calls.log"
[[ -f "${GA_STUB_STATE}/${kind}.out" ]] && cat -- "${GA_STUB_STATE}/${kind}.out"
if [[ -f "${GA_STUB_STATE}/${kind}.rc" ]]; then
  exit "$(cat -- "${GA_STUB_STATE}/${kind}.rc")"
fi
exit 0
STUB
  chmod +x "${STUB}/psql"
  stub_out exists '1'
  stub_rc exists 0
  stub_rc ledger 0
  ledger_answer 0 0 '' ''
}

stub_out() {
  printf '%s' "$2" >"${STUB_STATE}/$1.out"
}

stub_rc() {
  printf '%s' "$2" >"${STUB_STATE}/$1.rc"
}

# The ledger read's one row: void count, unbound count, void agents, unbound agents — unit-separator
# delimited, so an empty agent list survives the split.
ledger_answer() {
  printf '%s\x1f%s\x1f%s\x1f%s' "$1" "$2" "$3" "$4" >"${STUB_STATE}/ledger.out"
}

# A PATH with every command of the stub-first PATH except the two digest tools the inject hook
# probes: one directory of symlinks, so dropping a tool never drops the interpreter beside it.
path_without_digest_tools() {
  local farm="${SANDBOX}/farm-bin" part
  local -a parts=()
  mkdir -p "${farm}"
  IFS=: read -r -a parts <<<"${STUB}:${PATH}"
  for part in "${parts[@]}"; do
    [[ -d "${part}" ]] || continue
    # a name already linked from an earlier entry keeps that link, mirroring PATH precedence
    ln -s -- "${part}"/* "${farm}/" 2>/dev/null || true
  done
  if ga_guard_path "${farm}"; then rm -f -- "${farm:?}/shasum"; fi
  if ga_guard_path "${farm}"; then rm -f -- "${farm:?}/sha256sum"; fi
  [[ ! -L "${farm}/shasum" && ! -L "${farm}/sha256sum" ]] || return 1
  printf '%s' "${farm}"
}

run_doctor_sandbox() {
  run env PATH="${1:-${STUB}:${PATH}}" \
    GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
    GA_DB_NAME="ga_doctor_canary_sandbox" GA_PG_SOCKET="${PG_EMPTY}" \
    GA_MIGRATIONS_DIR="${MIGRATIONS}" GA_STUB_STATE="${STUB_STATE}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# The `<n> canary-trial` term of the PASS breakdown; empty when the doctor printed none.
canary_term_of_output() {
  printf '%s\n' "${output}" | grep -F -- '== doctor: PASS' | head -n 1 \
    | sed -n 's/.* \([0-9][0-9]*\) canary-trial.*/\1/p'
}

assert_canary_term() {
  local term
  term="$(canary_term_of_output)"
  [[ "${term}" == "${1}" ]] || {
    echo "expected '${1} canary-trial' in the PASS breakdown, got '${term}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# One producer-grammar shed row (hooks/inject-scope-rules.sh → append_drop_log). $1 = UTC date.
shed_row() {
  printf '%sT10:00:00Z [inject-scope-rules] DROP agent=glass-atrium-dev-shell block=%s pre_drop_bytes=10400 ceiling=9984 overage_bytes=416\n' \
    "$1" "$2" >>"${DROPLOG}"
}

utc_days_ago() {
  date -u -v-"$1"d +%Y-%m-%d 2>/dev/null || date -u -d "$1 days ago" +%Y-%m-%d
}

@test "a healthy install reports every canary leg ok and counts no canary-trial warning" {
  run_doctor_sandbox
  assert_output_has "ok   : canary digest tool present" || return 1
  assert_output_has "ok   : no canary void or unbound canary delivery" || return 1
  assert_output_lacks "canary shed" || return 1
  assert_canary_term 0
}

@test "an in-window canary shed warns on its own, blames the injection ceiling, and is not counted as a scope-block drop" {
  shed_row "$(utc_days_ago 1)" canary
  run_doctor_sandbox
  assert_output_has "warn : 1 canary shed(s) in the last 7d" || return 1
  assert_output_has "block=canary" || return 1
  # every rule block is out before the canary is weighed, so the AGENT-INJECT sources cannot cause it
  local shed_line
  shed_line="$(printf '%s\n' "${output}" | grep -F -- 'canary shed(s)' || true)"
  [[ "${shed_line}" == *INJECT_SCOPE_RULES_CTX_MAX_BYTES* && "${shed_line}" != *AGENT-INJECT* ]] || {
    echo "the canary shed remedy names a cause other than the injection ceiling: ${shed_line}" >&2
    return 1
  }
  assert_output_lacks "scope-block drop(s) in the last" || return 1
  assert_canary_term 1
}

@test "a canary shed older than the shed window warns nothing" {
  shed_row "$(utc_days_ago 30)" canary
  run_doctor_sandbox
  assert_output_lacks "canary shed" || return 1
  assert_canary_term 0
}

@test "a scope-block drop beside a canary shed keeps both counts apart" {
  shed_row "$(utc_days_ago 1)" budget-dev
  shed_row "$(utc_days_ago 1)" canary
  shed_row "$(utc_days_ago 1)" canary
  run_doctor_sandbox
  assert_output_has "warn : 1 inject-scope-rules scope-block drop(s)" || return 1
  assert_output_has "warn : 2 canary shed(s) in the last 7d" || return 1
  assert_canary_term 2 || return 1
  local scope_latest
  scope_latest="$(printf '%s\n' "${output}" | awk 'index($0, "scope-block drop(s)") { getline; print; exit }')"
  [[ "${scope_latest}" == *"latest:"*"block=budget-dev "* ]] || {
    echo "the scope-block latest: row is not the budget-dev row: '${scope_latest}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

@test "a hash-mismatch void in the ledger window warns and names the agent" {
  ledger_answer 1 0 'glass-atrium-dev-shell' ''
  run_doctor_sandbox
  assert_output_has "warn : 1 canary trial void(s) for a foreign canary hash in the last 14d" || return 1
  assert_output_has "glass-atrium-dev-shell" || return 1
  assert_canary_term 1
}

@test "a delivery bound to no open trial warns and names the agents" {
  ledger_answer 0 2 '' 'glass-atrium-qa-debugger,glass-atrium-dev-shell'
  run_doctor_sandbox
  assert_output_has "warn : 2 canary delivery(ies) bound to no open trial in the last 14d" || return 1
  assert_output_has "glass-atrium-qa-debugger,glass-atrium-dev-shell" || return 1
  assert_canary_term 2
}

@test "the ledger read is one read-only statement over the windowed void and unbound rows" {
  ledger_answer 1 1 'glass-atrium-dev-shell' 'glass-atrium-dev-shell'
  run_doctor_sandbox
  assert_canary_term 2
  local sql
  sql="$(awk '/^ledger$/{getline; on=1; next} on && /^>>>$/{on=0} on' "${STUB_STATE}/calls.log")"
  [[ -n "${sql}" ]] || {
    echo "no ledger statement recorded: $(cat -- "${STUB_STATE}/calls.log")" >&2
    return 1
  }
  [[ "${sql}" == *"'foreign-canary-hash'"* && "${sql}" == *"'canary-unbound-delivery'"* ]] || {
    echo "the ledger statement lacks the void reason or the unbound event: ${sql}" >&2
    return 1
  }
  ! printf '%s' "${sql}" | grep -Eiq '(^|[^a-z_])(insert|update|delete|truncate|alter|drop|create)([^a-z_]|$)' || {
    echo "the ledger statement writes: ${sql}" >&2
    return 1
  }
}

@test "an install with neither digest tool warns once" {
  local farm
  farm="$(path_without_digest_tools)"
  run_doctor_sandbox "${farm}"
  assert_output_has "warn : no canary digest tool" || return 1
  assert_canary_term 1
}

@test "an unread ledger is a named note and never a warning or a clean read" {
  local -a rows=(
    "skip|GA_SKIP_DB_SETUP|canary trial ledger check skipped (GA_SKIP_DB_SETUP set)"
    "probe-fail|exists-rc|canary trial ledger unread — the 'ga_doctor_canary_sandbox' existence probe failed"
    "absent-db|exists-empty|database 'ga_doctor_canary_sandbox' absent — no canary trial rows to check"
    "read-fail|ledger-rc|canary trial ledger unread — the read against 'ga_doctor_canary_sandbox' failed"
    "malformed|ledger-junk|canary trial ledger unread — the read against 'ga_doctor_canary_sandbox' answered something other than two counts"
  )
  local row name kind want
  for row in "${rows[@]}"; do
    IFS='|' read -r name kind want <<<"${row}"
    seed_psql_stub
    unset GA_SKIP_DB_SETUP
    case "${kind}" in
      GA_SKIP_DB_SETUP) export GA_SKIP_DB_SETUP=1 ;;
      exists-rc) stub_rc exists 2 ;;
      exists-empty) stub_out exists '' ;;
      ledger-rc) stub_rc ledger 1 ;;
      ledger-junk) stub_out ledger 'NOTICE: something else' ;;
      *)
        echo "${name}: unknown row kind ${kind}"
        return 1
        ;;
    esac
    run_doctor_sandbox
    [[ "${output}" == *"${want}"* ]] || {
      echo "${name}: missing '${want}' — output:"
      echo "${output}"
      return 1
    }
    [[ "${output}" != *"ok   : no canary void"* ]] || {
      echo "${name}: an unread ledger read as clean"
      echo "${output}"
      return 1
    }
    [[ "$(canary_term_of_output)" == "0" ]] || {
      echo "${name}: canary-trial term moved"
      echo "${output}"
      return 1
    }
  done
}
