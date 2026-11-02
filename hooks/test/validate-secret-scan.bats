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
# Hermetic strategy: the hook reads stdin and stats the file path (`.git`, links),
# never a file's content; content/command strings are pattern-scanned in place,
# path rows build their trees under BATS_TEST_TMPDIR. Credential fixtures are
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
  # repo roots: p/ · test/shop/ (a dir named test above its root) · secrets-app/ (a secrets shape above its root)
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git" "${BATS_TEST_TMPDIR}/test/shop/.git" "${BATS_TEST_TMPDIR}/secrets-app/.git"
  # links a fixture spelling can leave the tests dir through
  mkdir -p "${BATS_TEST_TMPDIR}/p/src" "${BATS_TEST_TMPDIR}/p/tests"
  ln -s ../src "${BATS_TEST_TMPDIR}/p/tests/src"
  ln -s ../src/config.ts "${BATS_TEST_TMPDIR}/p/tests/login.spec.ts"
  # links under no repo root, whose name alone would exempt them
  mkdir -p "${BATS_TEST_TMPDIR}/norepo"
  ln -s ../p/src/config.ts "${BATS_TEST_TMPDIR}/norepo/login.spec.ts"
  ln -s ../p/.env "${BATS_TEST_TMPDIR}/norepo/l.test.js"
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
    'dotenv file in a fixtures dir|p/test/fixtures/.env|2' \
    'secrets file in a fixtures dir|p/test/fixtures/secrets.json|2' \
    'dotenv-suffixed file in a fixtures dir|p/test/fixtures/prod.env|2' \
    'dotenv variant in a fixtures dir|p/test/fixtures/.env-staging|2' \
    'secrets stem inside a longer name|p/test/fixtures/app.secrets.json|2' \
    'capitalised secrets file|p/test/fixtures/Secrets.json|2' \
    'credentials stem inside a longer name|p/test/fixtures/aws-credentials.yml|2' \
    'production source in a repo below a dir named test|test/shop/src/config/prod.ts|2' \
    'traversal out of a test dir|p/test/../src/config/prod.ts|2' \
    'fixtures dir under no repo root|/p/test/fixtures/users.json|2' \
    'shell test script in a tests dir|p/tests/login.sh|0' \
    'config format in a fixtures dir|p/test/fixtures/values.yaml|0' \
    'config format in a testdata dir|p/testdata/prod.yml|0' \
    'spec below a repo whose own dir holds a secrets shape|secrets-app/src/login.spec.ts|0' \
    'secrets dir above a test dir|p/secrets/test/login.ts|2' \
    'secrets dir below a test dir|p/test/secrets/login.ts|2' \
    'credentials dir holding a source spec|p/credentials/a.spec.ts|2' \
    'dotenv dir below a test dir|p/test/.env.d/login.ts|2' \
    'secrets dir under no repo root|/p/secrets/a.spec.ts|2' \
    'test-environment config, yml|p/config/database.test.yml|2' \
    'test-environment config, capitalised json|p/config/appsettings.Test.json|2' \
    'spec-named deploy config|p/deploy/service.spec.yaml|2' \
    'test-named conf under no repo root|/p/prod.test.conf|2' \
    'config format in a deploy spec dir|p/deploy/spec/prod.yaml|2' \
    'config format in a k8s test dir|p/k8s/test/values.yaml|2' \
    'source below a dir link out of a tests dir|p/tests/src/config.ts|2' \
    'spec-named file that is itself a link|p/tests/login.spec.ts|2' \
    'spec-named link onto repo source under no repo root|norepo/login.spec.ts|2' \
    'test-named link onto a dotenv file under no repo root|norepo/l.test.js|2' \
    'plain spec under no repo root keeps the name exemption|/p/login.spec.ts|0' \
    'plain spec below a system dir link keeps the name exemption|/tmp/no-such-dir/login.spec.ts|0' \
    'a script in a test dir of a deploy tree, accepted|p/deploy/test/bootstrap.sh|0' \
    'source in a spec dir of an API tree, accepted|p/openapi/spec/client.py|0' \
    'npm credential dotfile in a fixtures dir|p/test/fixtures/.npmrc|2' \
    'netrc credential dotfile in a fixtures dir|p/test/fixtures/.netrc|2' \
    'postgres credential dotfile in a fixtures dir|p/test/fixtures/.pgpass|2' \
    'pypi credential dotfile in a fixtures dir|p/test/fixtures/.pypirc|2' \
    'mysql credential dotfile in a fixtures dir|p/test/fixtures/.my.cnf|2' \
    'yarn credential dotfile in a fixtures dir|p/test/fixtures/.yarnrc.yml|2' \
    'envrc with a source spec tail|p/.envrc.test.js|2' \
    'envrc with a test infix|p/test/fixtures/.envrc.test.local|2' \
    'envrc suffix in a fixtures dir|p/test/fixtures/.envrc.local|2' \
    'dotenv with a digit suffix in a fixtures dir|p/test/fixtures/.env2|2' \
    'dotenv editor backup in a fixtures dir|p/test/fixtures/.env~|2' \
    'config format in a jest fixtures dir|p/src/__fixtures__/users.yaml|0' \
    'rspec file outside a test dir|p/lib/login_spec.rb|0' \
    'bats file outside a test dir|p/hooks/login.bats|0' \
    'pytest module outside a test dir|p/src/test_login.py|0' \
    'config format in a fixtures dir of a deploy tree, accepted|p/deploy/fixtures/prod.yaml|0' \
    'config format in a testdata dir of a k8s tree, accepted|p/k8s/testdata/prod.yaml|0'; do
    name="${row%%|*}" path="${row#*|}" want="${row##*|}" path="${path%|*}"
    [[ "${path}" == /* ]] || path="${BATS_TEST_TMPDIR}/${path}"
    run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${path}\",\"content\":\"const user = { email: 'ada@example.com', ${fixture_assign} }\"}}"
    [[ "${status}" -eq "${want}" ]] || { echo "${name}: status ${status}, want ${want}: ${output}"; return 1; }
    [[ "${want}" -eq 0 || "${output}" == *"SEC-013"* ]] || { echo "${name}: ${output}"; return 1; }
  done
}

@test "Write channel: a relative path has no repo root, so only its file name can exempt it" {
  local fixture_assign cwd row name path want
  mkdir -p "${BATS_TEST_TMPDIR}/repo/.git" "${BATS_TEST_TMPDIR}/norepo"
  fixture_assign="password"
  fixture_assign="${fixture_assign}: 'correct-horse-battery'"
  for cwd in repo norepo; do
    cd "${BATS_TEST_TMPDIR}/${cwd}"
    for row in \
      'config format in a fixtures dir|test/fixtures/values.yaml|2' \
      'bare fixtures dir|fixtures/prod.yml|2' \
      'script in a tests dir|tests/deploy.sh|2' \
      'test-named source file|src/a.test.ts|0'; do
      IFS='|' read -r name path want <<<"${row}"
      run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${path}\",\"content\":\"const user = { ${fixture_assign} }\"}}"
      [[ "${status}" -eq "${want}" ]] || { echo "${name} from ${cwd}: status ${status}, want ${want}: ${output}"; return 1; }
    done
  done
}

# Key and value apart in each row → joined, a row trips the gate on this file's own write.
@test "Write channel: a test-fixture file keeps SEC-013 for a value of a known credential format" {
  local fixture_assign row name key value path="${BATS_TEST_TMPDIR}/p/tests/run.sh"
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git"
  fixture_assign="password"
  fixture_assign="${fixture_assign}: 'correct-horse-battery'"
  for row in \
    'Anthropic key|ANTHROPIC_API_KEY|sk-ant-api03-' \
    'OpenAI project key|api_key|sk-proj-' \
    'Stripe live key|api_key|sk_live_' \
    'Stripe restricted test key|api_key|rk_test_' \
    'GitHub fine-grained token|token|github_pat_' \
    'GitHub server token|token|ghs_' \
    'GitLab token|token|glpat-' \
    'Slack refresh token|token|xoxe-' \
    'AWS temporary key id|secret|ASIA' \
    'single JWT segment|token|eyJ' \
    'npm token|token|npm_' \
    'PyPI token|password|pypi-' \
    'Hugging Face token|token|hf_' \
    'SendGrid key|api_key|SG.' \
    'DigitalOcean token|token|dop_v1_' \
    'Google OAuth token|token|ya29.' \
    'Stripe webhook secret|secret|whsec_' \
    'Groq key|api_key|gsk_' \
    'Shopify admin token|token|shpat_' \
    'Shopify shared secret|secret|shpss_' \
    'Grafana service account token|token|glsa_' \
    'Slack app token|token|xapp-' \
    'Docker Hub token|token|dckr_pat_' \
    'Google client secret|client_secret|GOCSPX-' \
    'Vault token|vault_token|hvs.' \
    'xAI key|api_key|xai-' \
    'Perplexity key|api_key|pplx-' \
    'Atlassian token|secret|ATATT3x' \
    'Linear key|token|lin_api_' \
    'Figma token|token|figd_' \
    'Databricks token|token|dapi' \
    'age secret key|api_key|AGE-SECRET-KEY-' \
    'Notion legacy token|secret|secret_a1b2c3d4e5f6g7h8i9j0' \
    'Notion token|token|ntn_' \
    'Replicate token|token|r8_' \
    'connection string of a scheme without its own pattern|password|mysql://root:hunter2@'; do
    IFS='|' read -r name key value <<<"${row}"
    run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${path}\",\"content\":\"${fixture_assign}\\n${key}=${value}a1b2c3d4e5f6g7h8\"}}"
    [[ "${status}" -eq 2 && "${output}" == *"SEC-013"* ]] || { echo "${name}: status ${status}: ${output}"; return 1; }
  done
}

# A secret access key has no prefix → only its name tells it from a spec's login password.
@test "Write channel: a test-fixture file keeps SEC-013 for an assignment to a cloud key name, whatever its value" {
  local value="a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0" file row name key separator
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git"
  for file in tests/run.sh test/fixtures/values.yaml; do
    for row in \
      'AWS secret key, snake case|aws_secret_access_key|=' \
      'AWS secret key, upper case|AWS_SECRET_ACCESS_KEY|=' \
      'AWS secret key, yaml form|aws_secret_access_key|: ' \
      'secret key, camel case|secretAccessKey|: ' \
      'bare access key|access_key|=' \
      'hyphenated access key|access-key|: ' \
      'access key with a glued qualifier|minioAccessKey|: ' \
      'AWS session token|AWS_SESSION_TOKEN|=' \
      'short AWS secret name|aws_secret|: ' \
      'dotted AWS property|cloud.aws.credentials.secret|=' \
      'Azure client secret|AZURE_CLIENT_SECRET|=' \
      'Alibaba access key secret|ALIBABA_CLOUD_ACCESS_KEY_SECRET|=' \
      'bare access key secret|access_key_secret|='; do
      IFS='|' read -r name key separator <<<"${row}"
      run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${BATS_TEST_TMPDIR}/p/${file}\",\"content\":\"${key}${separator}${value}\"}}"
      [[ "${status}" -eq 2 && "${output}" == *"SEC-013"* ]] || { echo "${name} in ${file}: status ${status}: ${output}"; return 1; }
    done
  done
}

# Name and value apart in each row → joined, a row trips the gate on this file's own write.
@test "Write channel: a cloud key assignment after another assignment keeps SEC-013, on its line or a later one" {
  local value="a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0" file row name first lead key separator
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git"
  for file in tests/run.sh test/fixtures/values.yaml; do
    for row in \
      'query string|password|=foo12345&|aws_secret_access_key|=' \
      'comma list|password|=foo12345,|aws_secret_access_key|=' \
      'semicolon list|password|=foo12345;|access_key|=' \
      'connection string|Server=x;Password|=hunter2222;|AccessKey|=' \
      'second query parameter of a URL|https://x.test/?token|=abc12345&|access_key|=' \
      'unquoted object literal|{password|:foo12345,|accessKey|:' \
      'session token in a query string|password|=foo12345&|AWS_SESSION_TOKEN|=' \
      'later line|password|: correct-horse-battery\n|aws_secret_access_key|='; do
      IFS='|' read -r name first lead key separator <<<"${row}"
      run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${BATS_TEST_TMPDIR}/p/${file}\",\"content\":\"${first}${lead}${key}${separator}${value}\"}}"
      [[ "${status}" -eq 2 && "${output}" == *"SEC-013"* ]] || {
        echo "${name} in ${file}: status ${status}: ${output}"
        return 1
      }
    done
  done
}

@test "Write channel: a cloud key name counts only as the name of an assignment" {
  local value="a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0" login assign="=" row name content
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git"
  login="password"
  for row in \
    "name alone in prose beside a test password|see the aws_secret_access_key docs\\n${login}: correct-horse-battery" \
    "key id beside a test password|AWS_ACCESS_KEY_ID=${value}\\n${login}: correct-horse-battery" \
    "name inside a test password value|${login}=access_key_12345" \
    "provider name inside a test password value|${login}=aws_secret_12345" \
    "provider setting that holds no secret|AWS_REGION=eu-central-1\\n${login}: correct-horse-battery" \
    "session token under no cloud name|session_token${assign}${value}" \
    "client secret under no cloud name|client_secret${assign}${value}" \
    "api key under no cloud name|api_key${assign}${value}" \
    "bare token|token${assign}${value}" \
    "bare secret|secret${assign}${value}"; do
    IFS='|' read -r name content <<<"${row}"
    run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${BATS_TEST_TMPDIR}/p/tests/run.sh\",\"content\":\"${content}\"}}"
    [[ "${status}" -eq 0 ]] || { echo "${name}: status ${status}: ${output}"; return 1; }
  done
}

@test "Write channel: a known credential prefix counts only at the start of a word and in its own case" {
  local row name key value path="${BATS_TEST_TMPDIR}/p/tests/run.sh"
  mkdir -p "${BATS_TEST_TMPDIR}/p/.git"
  for row in \
    'prefix inside a longer word|token|task-runner-01' \
    'Notion prefix on a readable dummy value|token|secret_token_value_for_tests' \
    'Databricks prefix on a short word|token|dapiclient1' \
    'prefix spelled in another case|token|asia-pacific-1' \
    'URL with no userinfo|password|https://example.com/login'; do
    IFS='|' read -r name key value <<<"${row}"
    run_hook "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${path}\",\"content\":\"${key}=${value}\"}}"
    [[ "${status}" -eq 0 ]] || { echo "${name}: status ${status}: ${output}"; return 1; }
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
