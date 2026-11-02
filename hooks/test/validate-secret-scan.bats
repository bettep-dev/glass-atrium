#!/usr/bin/env bats
# validate-secret-scan.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# PreToolUse(Write|Edit|Bash) security gate, one surface with two channels:
#   Write|Edit → scan tool_input.content + tool_input.new_string for secret
#     patterns → SEC-00x emit_error + exit 2 BLOCK.
#   Bash → dual-condition gate (secrets-file write target AND credential value
#     on the command) → SEC-016 + exit 2 BLOCK; either alone → pass.
# Benign envelopes → exit 0 pass.
#
# Run via: bats hooks/test/validate-secret-scan.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (fail-closed
# precondition — the hook itself exits 2 without python3).
#
# Hermetic strategy: the hook reads ONLY stdin — no file is written; content/
# command strings are pattern-scanned in place. Credential fixtures are
# SYNTHETIC and RUNTIME-ASSEMBLED from split fragments so no secret-shaped
# literal ever sits in this file (it would trip the very gate under test on
# the test file's own write). The generic-assignment fixture is assembled in
# TWO statements — its pattern tolerates quote chars between name and "=", so
# an adjacent-string split alone would not defuse it.

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-secret-scan.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  # Runtime-assembled synthetic fixtures (see header): AKIA + 16 [0-9A-Z] /
  # ghp_ + 36 alnum / a generic name=value credential assignment.
  AWS_FIXTURE="AKIA""ABCDEFGHIJKLMNOP"
  GHP_FIXTURE="ghp_""aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  CRED_FIXTURE="password"
  CRED_FIXTURE="${CRED_FIXTURE}=supersecret123"
}

# Run the hook with an envelope on stdin. Args: $1=input JSON.
run_hook() {
  run bash "${HOOK_SH}" <<<"${1}"
}

@test "Write channel: AWS-key-shaped content → SEC-001 block (exit 2)" {
  run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"content\":\"const k = ${AWS_FIXTURE}\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-001"* ]] || return 1
}

@test "Edit channel: GitHub-token-shaped new_string → SEC-002 block (exit 2)" {
  run_hook "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"new_string\":\"const t = ${GHP_FIXTURE}\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-002"* ]] || return 1
}

@test "Bash channel: credential value redirected into .env → SEC-016 block (exit 2)" {
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > .env\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SEC-016"* ]] || return 1
}

@test "Bash benign: dual-condition gate — write target without credential value → pass" {
  run_hook '{"tool_name":"Bash","tool_input":{"command":"echo PLACEHOLDER= > .env"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

@test "Bash benign: credential value without a secrets-file target → pass" {
  # Dual-condition gate, other half: the value alone (no .env-class write
  # target — a log file) must NOT block.
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > out.log\"}}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "Write channel: a generic credential assignment passes only in a test-fixture file and blocks with SEC-013 elsewhere" {
  local fixture_assign row name path want
  # p/ and test/shop/ are repo roots; test/shop/ sits inside a dir named test above its own root, secrets-app/ holds a
  # secrets shape above its own root
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git" "${BATS_TEST_TMPDIR}/test/shop/.git" "${BATS_TEST_TMPDIR}/secrets-app/.git"
  fixture_assign="password"
  fixture_assign="${fixture_assign}: 'correct-horse-battery'"
  for row in \
    'jest spec|p/src/users/users.service.spec.ts|0' \
    'vitest test file|p/src/login.test.tsx|0' \
    'pytest module in a tests dir|p/tests/test_login.py|0' \
    'file in a __tests__ dir|p/src/__tests__/login.js|0' \
    'fixture data file|p/test/fixtures/users.json|0' \
    'go test file|p/auth/login_test.go|0' \
    'production source|p/src/users/users.service.ts|2' \
    'test word inside a longer name|p/src/latest.ts|2' \
    'test word inside a dir name|p/contest/app.ts|2' \
    'dotenv file in a test dir|p/test/.env|2' \
    'secrets file in a test dir|p/test/secrets.json|2' \
    'dotenv-suffixed file in a fixtures dir|p/test/fixtures/prod.env|2' \
    'dotenv variant in a fixtures dir|p/test/fixtures/.env-staging|2' \
    'secrets stem inside a longer name|p/tests/app.secrets.json|2' \
    'capitalised secrets file|p/test/Secrets.json|2' \
    'credentials stem inside a longer name|p/spec/aws-credentials.yml|2' \
    'production source in a repo below a dir named test|test/shop/src/config/prod.ts|2' \
    'traversal out of a test dir|p/test/../src/config/prod.ts|2' \
    'fixtures dir under no repo root|/p/test/fixtures/users.json|2' \
    'shell test script in a tests dir|p/tests/login.sh|0' \
    'config format in a fixtures dir|p/test/fixtures/values.yaml|0' \
    'config format in a testdata dir|p/testdata/prod.yml|0' \
    'spec below a repo whose own dir holds a secrets shape|secrets-app/src/login.spec.ts|0' \
    'secrets dir above a test dir|p/secrets/test/prod.yml|2' \
    'secrets dir below a test dir|p/test/secrets/prod.yml|2' \
    'credentials dir holding a source spec|p/credentials/a.spec.ts|2' \
    'dotenv dir below a test dir|p/test/.env.d/prod|2' \
    'secrets dir under no repo root|/p/secrets/a.spec.ts|2' \
    'test-environment config, yml|p/config/database.test.yml|2' \
    'test-environment config, capitalised json|p/config/appsettings.Test.json|2' \
    'spec-named deploy config|p/deploy/service.spec.yaml|2' \
    'test-named conf under no repo root|/p/prod.test.conf|2' \
    'config format in a deploy spec dir|p/deploy/spec/prod.yaml|2' \
    'config format in a k8s test dir|p/k8s/test/values.yaml|2' \
    'npm credential dotfile in a test dir|p/test/.npmrc|2' \
    'netrc credential dotfile in a test dir|p/test/.netrc|2' \
    'postgres credential dotfile in a test dir|p/test/.pgpass|2' \
    'pypi credential dotfile in a test dir|p/test/.pypirc|2' \
    'envrc with a source spec tail|p/.envrc.test.js|2' \
    'envrc with a test infix|p/.envrc.test.local|2' \
    'envrc suffix in a tests dir|p/tests/.envrc.local|2' \
    'dotenv with a digit suffix in a tests dir|p/tests/.env2|2' \
    'dotenv editor backup in a tests dir|p/tests/.env~|2'; do
    name="${row%%|*}" path="${row#*|}" want="${row##*|}" path="${path%|*}"
    [[ "${path}" == /* ]] || path="${BATS_TEST_TMPDIR}/${path}"
    run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${path}\",\"content\":\"const user = { email: 'ada@example.com', ${fixture_assign} }\"}}"
    [[ "${status}" -eq "${want}" ]] || { echo "${name}: status ${status}, want ${want}: ${output}"; return 1; }
    [[ "${want}" -eq 0 || "${output}" == *"SEC-013"* ]] || { echo "${name}: ${output}"; return 1; }
  done
}

@test "Write channel: a structured token in a test-fixture file still blocks with its own code" {
  run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/p/src/users/users.service.spec.ts\",\"content\":\"const k = ${AWS_FIXTURE}\"}}"
  [[ "${status}" -eq 2 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"SEC-001"* ]] || { echo "${output}"; return 1; }
}

@test "Write benign: ordinary source content → pass (exit 0, silent)" {
  run_hook '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.ts","content":"export const answer = 42"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

# ~160 KiB of JSON-escaped lines → a multi-write writer, which races a reader that stops at a line-1
# match at any size; a writer left with a write dies of SIGPIPE, which pipefail reports as "no match".
pipe_overflow_padding() {
  seq -f 'padding line %05g of ordinary source text' 1 4000 | awk '{ printf "%s\\n", $0 }'
}

@test "Write channel: a secret on line 1 of content larger than the pipe buffer still blocks, exit 2" {
  local padding
  padding="$(pipe_overflow_padding)"
  run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/x.ts\",\"content\":\"const k = ${AWS_FIXTURE}\\n${padding}\"}}"
  [[ "${status}" -eq 2 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"SEC-001"* ]] || { echo "${output}"; return 1; }
}

@test "Bash channel: a .env credential write on line 1 of a command larger than the pipe buffer still blocks, exit 2" {
  local padding
  padding="$(pipe_overflow_padding)"
  run_hook "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo ${CRED_FIXTURE} > .env\\n${padding}\"}}"
  [[ "${status}" -eq 2 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"SEC-016"* ]] || { echo "${output}"; return 1; }
}
