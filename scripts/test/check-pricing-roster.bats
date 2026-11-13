#!/usr/bin/env bats
# check-pricing-roster.bats — the updater's pricing-roster verdict over the model ids an install ran.
#
# psql is a stub that replays canned rows and records its environment and SQL, so neither the live
# database nor any network is reached; the pricing file is a copy of the shipped hooks/pricing.json.

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../check-pricing-roster.sh"
  PRICING="${BATS_TEST_TMPDIR}/pricing.json"
  cp "${BATS_TEST_DIRNAME}/../../hooks/pricing.json" "${PRICING}"
  STUB_DIR="${BATS_TEST_TMPDIR}/stub"
  mkdir -p "${STUB_DIR}"
  export STUB_ROWS="${STUB_DIR}/rows.tsv" STUB_RECORD="${STUB_DIR}/record"
  export STUB_RC=0 STUB_ERR='connection to server at "db.example" (10.0.0.9), port 5432 failed: timeout expired'
  : >"${STUB_ROWS}"
  cat >"${STUB_DIR}/psql" <<'STUB'
#!/usr/bin/env bash
{
  printf 'PGCONNECT_TIMEOUT=%s\nPGOPTIONS=%s\nARGS=%s\n' "${PGCONNECT_TIMEOUT:-}" "${PGOPTIONS:-}" "$*"
  cat
} >"${STUB_RECORD}"
if [[ "${STUB_RC}" -ne 0 ]]; then
  printf '%s\n' "${STUB_ERR}" >&2
  exit "${STUB_RC}"
fi
cat "${STUB_ROWS}"
STUB
  chmod +x "${STUB_DIR}/psql"
  export ATRIUM_UPDATE_PSQL="${STUB_DIR}/psql"
}

# One `<source>\t<model>` line per argument, the shape the roster query returns.
seed_rows() {
  local row
  for row in "$@"; do
    printf '%s\n' "${row}" >>"${STUB_ROWS}"
  done
}

@test "the verdict lists exactly the ids the pricing file cannot price, after normalization and the config-value skips" {
  local rows=(
    "priced cost id|cost	claude-opus-4-8|0|"
    "dated snapshot of a priced id|cost	claude-haiku-4-5-20251001|0|"
    "context-variant of a priced id|cost	claude-fable-5[1m]|0|"
    "config value inherit|config	inherit|0|"
    "config value unset|config	|0|"
    "unpriced cost id|cost	claude-foobar-9-9|3|claude-foobar-9-9"
    "unpriced config id|config	claude-sonnet-9-9|3|claude-sonnet-9-9"
  )
  local row name line want_rc want_out
  for row in "${rows[@]}"; do
    IFS='|' read -r name line want_rc want_out <<<"${row}"
    : >"${STUB_ROWS}"
    seed_rows "${line}"
    run "${SCRIPT}" "${PRICING}"
    [[ "${status}" -eq "${want_rc}" ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
    [[ -z "${want_out}" || "${output}" == *"${want_out}"* ]] || {
      echo "${name}: id not listed"
      echo "${output}"
      return 1
    }
  done
}

# Prints one parity-table id per line from the given list key — a null as the empty string the
# roster query's coalesce renders it as.
parity_ids() {
  python3 -I -c 'import json, sys
for model in json.load(open(sys.argv[1]))[sys.argv[2]]:
    print(model or "")' "${BATS_TEST_DIRNAME}/../../hooks/test/fixtures/model-id-pricing-parity.json" "${1}"
}

@test "an id cost-tracker prices at zero is skipped, while a near miss of one still needs a row" {
  local zero_ids lookup_ids model
  zero_ids="$(parity_ids zero_cost_ids)"
  lookup_ids="$(parity_ids rate_lookup_ids)"
  while IFS= read -r model; do
    : >"${STUB_ROWS}"
    seed_rows "cost	${model}"
    run "${SCRIPT}" "${PRICING}"
    [[ "${status}" -eq 0 ]] || {
      echo "zero-cost id '${model}': status ${status}"
      echo "${output}"
      return 1
    }
  done <<<"${zero_ids}"
  while IFS= read -r model; do
    : >"${STUB_ROWS}"
    seed_rows "cost	${model}"
    run "${SCRIPT}" "${PRICING}"
    [[ "${status}" -eq 3 && "${output}" == *"${model}"* ]] || {
      echo "rate-lookup id '${model}': status ${status}"
      echo "${output}"
      return 1
    }
  done <<<"${lookup_ids}"
}

@test "several unpriced ids are each listed once on stdout, sorted, while priced ids are not" {
  seed_rows $'cost\tclaude-zeta-9-9' $'config\tclaude-alpha-9-9' $'cost\tclaude-opus-4-8' $'config\tclaude-zeta-9-9'
  run --separate-stderr "${SCRIPT}" "${PRICING}"
  [[ "${status}" -eq 3 ]] || {
    echo "${output}"
    echo "${stderr}"
    return 1
  }
  [[ "${output}" == $'claude-alpha-9-9\nclaude-zeta-9-9' ]] || {
    echo "${output}"
    return 1
  }
  [[ "${stderr}" == *"claude-alpha-9-9"* && "${stderr}" == *"claude-zeta-9-9"* ]]
}

@test "a database that cannot answer gives no verdict and never echoes the connection error" {
  local rc
  for rc in 2 3 127; do
    STUB_RC="${rc}"
    seed_rows $'cost\tclaude-foobar-9-9'
    run --separate-stderr "${SCRIPT}" "${PRICING}"
    [[ "${status}" -eq 4 ]] || {
      echo "psql rc ${rc}: status ${status}"
      echo "${stderr}"
      return 1
    }
    [[ -z "${output}" ]] || {
      echo "psql rc ${rc}: verdict printed: ${output}"
      return 1
    }
    [[ "${stderr}" != *"db.example"* && "${stderr}" != *"10.0.0.9"* ]] || {
      echo "psql rc ${rc}: ${stderr}"
      return 1
    }
  done
}

@test "the query runs read-only, bounded by a connect and a statement timeout, without the user's psqlrc" {
  run "${SCRIPT}" "${PRICING}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  grep -Eq '^PGCONNECT_TIMEOUT=[1-9][0-9]*$' "${STUB_RECORD}"
  grep -Eq '^PGOPTIONS=.*default_transaction_read_only=on' "${STUB_RECORD}"
  grep -Eq '^PGOPTIONS=.*statement_timeout=[1-9][0-9]*' "${STUB_RECORD}"
  grep -Eq '^ARGS=.*-X' "${STUB_RECORD}"
}

@test "a pricing file the loader rejects is a usage failure, never a pass" {
  local bad=(
    "missing file|${BATS_TEST_TMPDIR}/absent.json"
    "invalid json|${BATS_TEST_TMPDIR}/broken.json"
  )
  printf '{"models":' >"${BATS_TEST_TMPDIR}/broken.json"
  seed_rows $'cost\tclaude-foobar-9-9'
  local row name path
  for row in "${bad[@]}"; do
    IFS='|' read -r name path <<<"${row}"
    run "${SCRIPT}" "${path}"
    [[ "${status}" -eq 2 ]] || {
      echo "${name}: status ${status}"
      echo "${output}"
      return 1
    }
  done
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || {
    echo "no argument: status ${status}"
    echo "${output}"
    return 1
  }
}
