#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031  # status/output are bats run globals, read by a helper in the same test shell
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
# Hermetic strategy: the hook reads stdin, and for the SEC-013 classifier also the
# Edit target file and the .git ancestors of file_path → corpus rows run against a
# per-test tree under BATS_TEST_TMPDIR that carries its own .git root, and every
# Edit row splices into a real target file there. Credential fixtures are
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
  CORPUS_UTF8_LOCALE="$(find_utf8_locale)" || CORPUS_UTF8_LOCALE=""
  # shellcheck disable=SC2154  # BATS_TEST_TMPDIR is set by bats per test
  CORPUS_ROOT="${BATS_TEST_TMPDIR}/root"
  mkdir -p "${CORPUS_ROOT}/repo/.git"
}

# First UTF-8 locale the host has → the corpus runs under it and under C (grep's [[:space:]] is locale-dependent).
find_utf8_locale() {
  local loc charmap
  for loc in en_US.UTF-8 C.UTF-8; do
    charmap="$(LC_ALL="${loc}" locale charmap 2>/dev/null)" || charmap=""
    if [[ "${charmap}" == "UTF-8" ]]; then
      printf '%s' "${loc}"
      return 0
    fi
  done
  return 1
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

# --- Generic credential assignment corpus (Write|Edit channel) ---
# Each row runs as a Write (content) and as an Edit (new_string). Row text carries @NAME@
# placeholders → key words and structured markers assembled at run time (header convention).

# Expand the @NAME@ placeholders of one corpus template. Args: $1=template
expand_corpus_text() {
  local text="${1}"
  local pw="pass""word" pwu="PASS""WORD" pwm="PaSs""WoRd" passwd="pass""wd" sc="sec""ret" scu="SEC""RET"
  local tk="to""ken" tku="TO""KEN" ak="api""Key" aku="api""_key" akh="Api""-Key"
  local ack="access""_key" aws="aws_secret""_access_key" xoxb="xo""xb-"
  local pem="-----BEGIN RSA PRIV""ATE KEY-----" sa='"type": "service_''account"'
  text="${text//@PWU@/${pwu}}"
  text="${text//@PWM@/${pwm}}"
  text="${text//@PWD@/${passwd}}"
  text="${text//@PW@/${pw}}"
  text="${text//@SCU@/${scu}}"
  text="${text//@SC@/${sc}}"
  text="${text//@TKU@/${tku}}"
  text="${text//@TK@/${tk}}"
  text="${text//@ACK@/${ack}}"
  text="${text//@AWS@/${aws}}"
  text="${text//@XOXB@/${xoxb}}"
  text="${text//@AKU@/${aku}}"
  text="${text//@AKH@/${akh}}"
  text="${text//@AK@/${ak}}"
  text="${text//@PEM@/${pem}}"
  text="${text//@SA@/${sa}}"
  text="${text//@NBSP@/$'\xc2\xa0'}"
  text="${text//@TAB@/$'\t'}"
  text="${text//@NL@/$'\n'}"
  printf '%s' "${text}"
}

# Build a Write or Edit envelope; raw UTF-8, as the harness sends it.
# Args: $1=Write|Edit $2=file_path ("-" = key absent) $3=text $4=old_string (Edit) $5=replace_all true|false (Edit)
build_envelope() {
  python3 -c '
import json, sys
tool, path, text = sys.argv[1:4]
old = sys.argv[4] if len(sys.argv) > 4 else "// edit anchor"
ti = {"content": text} if tool == "Write" else {"old_string": old, "new_string": text}
if tool == "Edit" and sys.argv[5:6] == ["true"]:
    ti["replace_all"] = True
if path != "-":
    ti["file_path"] = path
print(json.dumps({"tool_name": tool, "tool_input": ti}, ensure_ascii=False))
' "$@"
}

# Write an Edit target file from a corpus template. Args: $1=absolute path $2=template
put_edit_target() {
  mkdir -p "${1%/*}"
  expand_corpus_text "${2}" >"${1}"
}

# Run one envelope under a UTF-8 locale and under C; a miss appends "<label> | <locale> | exit N" to CORPUS_FAILURES.
# Args: $1=expected code ("" = must pass) $2=row label $3=envelope
run_both_locales() {
  local code="${1}" loc is_hit
  [[ -n "${CORPUS_UTF8_LOCALE}" ]] || {
    CORPUS_FAILURES+=("no UTF-8 locale on this host | ${2}")
    return 0
  }
  for loc in "${CORPUS_UTF8_LOCALE}" C; do
    run env LC_ALL="${loc}" bash "${HOOK_SH}" <<<"${3}"
    is_hit=0
    [[ -z "${code}" && "${status}" -eq 0 ]] && is_hit=1
    [[ -n "${code}" && "${status}" -eq 2 && "${output}" == *"${code}"* ]] && is_hit=1
    ((is_hit == 1)) || CORPUS_FAILURES+=("${2} | ${loc} | exit ${status}")
  done
}

# Run one row as a Write and as an Edit; a /repo/ path maps under the corpus root, where the Edit
# target holds only the edit anchor, so the post-edit file is the row text.
# Args: $1=expected code ("" = must pass) $2=row name $3=file_path ("-" = none) $4=template
check_corpus_row() {
  local code="${1}" name="${2}" path="${3}" text tool envelope
  text="$(expand_corpus_text "${4}")"
  if [[ "${path}" == /repo/* ]]; then
    path="${CORPUS_ROOT}${path}"
    put_edit_target "${path}" "// edit anchor"
  fi
  for tool in Write Edit; do
    envelope="$(build_envelope "${tool}" "${path}" "${text}")"
    run_both_locales "${code}" "${tool} | ${name}" "${envelope}"
  done
}

# Run one Edit that splices new_string into a target under the corpus root.
# Args: $1=expected code ("" = must pass) $2=row name $3=target path below the root $4=old_string
#       $5=new_string template $6=replace_all (default false)
check_edit_row() {
  local envelope text
  text="$(expand_corpus_text "${5}")"
  envelope="$(build_envelope Edit "${CORPUS_ROOT}${3}" "${text}" "${4}" "${6:-false}")"
  run_both_locales "${1}" "Edit | ${2}" "${envelope}"
}

must_pass() { check_corpus_row "" "$@"; }
must_block() { check_corpus_row "$@"; }

# Fail with every missed row listed, so one run shows the whole corpus state.
assert_no_corpus_failures() {
  ((${#CORPUS_FAILURES[@]} == 0)) || {
    printf '%s\n' "${CORPUS_FAILURES[@]}"
    return 1
  }
}

# shellcheck disable=SC2016  # templates carry literal ${…} and backticks on purpose
@test "generic credential corpus: references, casts and fake-marked test fixtures pass on Write and Edit" {
  CORPUS_FAILURES=()
  must_pass "SQL seed: key word inside a quoted identifier before a regclass cast" /repo/db/seed.sql \
    "SELECT nextval('public.user_@TK@'::regclass);"
  must_pass "fake-marked short value in a .test.ts file" /repo/src/auth/login.test.ts \
    "const user = { name: 'Jane Doe', @PW@: 'fake-pw-4821' };"
  must_pass "fake-marked value in a test fixtures yml" /repo/test/fixtures/users.yml \
    '- name: Jane Doe@NL@  @PW@: fake-pw-4821'
  must_pass "fake-marked value in a Python test_ module under tests/" /repo/tests/test_login.py \
    '@PW@ = "fake-pw-4821"'
  must_pass "zod validator chain as the value" /repo/src/auth/schema.ts \
    '  @PW@: z.string().min(8),'
  must_pass "form-field lookup by the key's own name" /repo/src/auth/actions.ts \
    "const @PW@ = formData.get('@PW@');"
  must_pass "member expression on process.env" /repo/src/auth/jwt.ts \
    'const @SC@ = process.env.JWT_@SCU@;'
  must_pass "env subscript by an upper-snake name" /repo/app/settings.py \
    "@PW@ = os.environ['DB_@PWU@']"
  must_pass "Python annotation with a None default" /repo/app/models.py \
    '    @PW@: Optional[str] = None'
  must_pass "object key bound to a variable declared in the same content" /repo/src/auth/client.ts \
    'const accessToken = await getAccessToken();@NL@return { @TK@: accessToken };'
  must_pass "SQL upsert setting a column from EXCLUDED" /repo/db/upsert.sql \
    'INSERT INTO sessions (id, access_@TK@) VALUES ($1, $2)@NL@ON CONFLICT (id) DO UPDATE SET access_@TK@ = EXCLUDED.access_@TK@;'
  must_pass "SQL bind parameter in a WHERE clause" /repo/db/revoke.sql \
    'UPDATE sessions SET revoked = true WHERE @TK@ = :@TK@_value;'
  must_pass "SQL varchar cast" /repo/db/clients.sql \
    'SELECT @SC@::varchar(64) FROM api_clients;'
  must_pass "call with no quoted argument" /repo/app/csrf.py \
    'csrf_@TK@ = generate_@TK@()'
  must_pass "identifier-only dollar-brace placeholder in yaml" /repo/config/app.yaml \
    '  @PW@: ${DB_@PWU@}'
  must_pass "identifier-only double-brace placeholder in yaml" /repo/config/app.yaml \
    '  @PW@: "{{db_@PW@}}"'
  must_pass "bare TypeScript type annotation" /repo/src/auth/types.ts \
    '  @PW@: string;'
  must_pass "optional TypeScript key" /repo/src/auth/types.ts \
    '  @PW@?: string;'
  assert_no_corpus_failures
}

# shellcheck disable=SC2016  # templates carry literal ${…} and backticks on purpose
@test "generic credential corpus: literal values block on Write and Edit wherever a real one could land" {
  CORPUS_FAILURES=()
  must_block SEC-013 "quoted complex literal in source" /repo/src/db.ts \
    'const @PW@ = "Xk9#mQ2!vL7%pR4z";'
  must_block SEC-013 "32-hex value with no marker in a test file" /repo/src/auth/login.test.ts \
    "const @AK@ = '9f86d081884c7d659a2feaa0c55ad015';"
  must_block SEC-013 "base64-looking value in yaml config" /repo/config/app.yaml \
    '  @SC@: dGhpcyBpcyBub3QgcmVhbA=='
  must_block SEC-013 "word-plus-digits literal in source" /repo/app/settings.py \
    '@PW@ = "sunshine2024"'
  must_block SEC-013 "word-plus-digits literal in a test file" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'sunshine2024' };"
  must_block SEC-013 "env lookup with a hardcoded fallback argument" /repo/app/settings.py \
    '@PW@ = os.environ.get("DB_@PWU@", "Hx72kq9Lmz")'
  must_block SEC-013 "call wrapping a quoted literal" /repo/app/settings.py \
    '@PW@ = hash_pw("Hx72kq9Lmz")'
  must_block SEC-013 "fake-marked value outside a test path" /repo/src/auth/login.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "dotenv file with a bare value" /repo/.env \
    'DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "markdown prose: key word, colon, one long word" /repo/docs/guide.md \
    'The @TK@: regenerated on every deploy.'
  must_block SEC-013 "bare default-credential word in yaml" /repo/config/app.yaml \
    '  @PW@: changeme'
  must_block SEC-013 "properties: key, two colons, value" /repo/config/app.properties \
    'db.@PW@::Hx72kq9Lmz'
  must_block SEC-013 "yaml: key, two colons, value" /repo/config/app.yaml \
    '@PW@::Hx72kq9Lmz'
  must_block SEC-013 "properties: key, equals, colon-led value" /repo/config/app.properties \
    'db.@PW@=:Hx72kq9Lmz'
  must_block SEC-013 "yaml: bare alphanumeric value" /repo/config/app.yaml \
    '  @PW@: Hx72kq9Lmz'
  must_block SEC-013 "yaml: dotted bare value" /repo/config/app.yaml \
    '  @PW@: prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "yaml: colon-led bare value" /repo/config/app.yaml \
    '  @PW@: :Hx72kq9Lmz'
  must_block SEC-013 "yaml: angle-bracket placeholder value" /repo/config/app.yaml \
    '  @PW@: <YOUR_DB_@PWU@>'
  must_block SEC-013 "dotenv: angle-bracket-wrapped value" /repo/.env \
    'API_@SCU@=<Hx72kq9Lmz>'
  must_block SEC-013 "Dockerfile ENV with a bare value" /repo/Dockerfile \
    'ENV DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "shell script export with a bare value" /repo/scripts/run.sh \
    'export DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "shell script: identifier-shaped bare word" /repo/scripts/run.sh \
    'API_@TK@=accessTokenValue'
  must_block SEC-013 "extensionless file with a bare value" /repo/bin/setup \
    'DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "code file: env-style bare value with no other occurrence" /repo/src/config.ts \
    'DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "code file: one bare value under two keys" /repo/src/config.ts \
    'DB_@PWU@=Hx72kq9Lmz@NL@PG@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "Python typed declaration then literal" /repo/app/settings.py \
    '@PW@: str = "Hx72kq9Lmz!"'
  must_block SEC-013 "TypeScript typed declaration then literal" /repo/src/db.ts \
    'const @PW@: string = "Hx72kq9Lmz!";'
  must_block SEC-013 "prefix-lettered literal" /repo/app/settings.py \
    '@PW@ = b"Hx72kq9Lmz"'
  must_block SEC-013 "parenthesised literal" /repo/src/db.ts \
    'const @PW@ = ("Hx72kq9Lmz");'
  must_block SEC-013 "non-lookup call wrapping a letters-only literal" /repo/src/db.ts \
    'const @PW@ = derive("correcthorsebattery");'
  must_block SEC-013 "double-pipe fallback literal" /repo/src/db.ts \
    'const @PW@ = process.env.DB_@PWU@ || "Hx72kq9Lmz";'
  must_block SEC-013 "or fallback literal" /repo/app/settings.py \
    '@PW@ = os.getenv("DB_@PWU@") or "Hx72kq9Lmz"'
  must_block SEC-013 "double-question fallback after a short reference" /repo/src/db.ts \
    'const @TK@ = opts.t ?? "Hx72kq9Lmz";'
  must_block SEC-013 "colon-equals declaration" /repo/cmd/server/main.go \
    '@PW@ := "Hx72kq9Lmz"'
  must_block SEC-013 "tab after the separator" /repo/app/settings.py \
    '@PW@ =@TAB@"Hx72kq9Lmz"'
  must_block SEC-013 "i18n message argument after a credential key" /repo/src/auth/schema.ts \
    '  @PW@: t("errors.@PW@.tooShort"),'
  must_block SEC-013 "form-field lookup with a digit-bearing argument" /repo/src/auth/actions.ts \
    "const @PW@ = formData.get('Hx72kq9Lmz');"
  must_block SEC-013 "env subscript with a symbol-bearing argument" /repo/app/settings.py \
    "@PW@ = os.environ['Hx#q!Lmz%Kp']"
  must_block SEC-013 "header string holding key and value" /repo/src/http.ts \
    'const header = "X-@AKH@: Hx72kq9Lmz";'
  must_block SEC-013 "DSN string" /repo/app/db.py \
    'dsn = "host=db user=app @PW@=Hx72kq9Lmz dbname=app"'
  must_block SEC-013 "URL query parameter" /repo/src/http.ts \
    'await fetch("https://api.example.com/v1/items?@AKU@=Hx72kq9Lmz&page=1");'
  must_block SEC-013 "CLI flag in an argv list" /repo/app/db.py \
    'subprocess.run(["mysql", "--@PW@=Hx72kq9Lmz", "app"])'
  must_block SEC-013 "template-literal body in a code file" /repo/src/config.ts \
    'const env = `@NL@DB_@PWU@=Hx72kq9Lmz@NL@`;'
  must_block SEC-013 "triple-quoted body in a code file" /repo/app/config.py \
    'CONFIG = """@NL@@PW@: Hx72kq9Lmz@NL@"""'
  must_block SEC-013 "heredoc body in a shell script" /repo/scripts/run.sh \
    'cat >app.conf <<EOF@NL@@PW@=Hx72kq9Lmz@NL@EOF'
  must_block SEC-013 "log template interpolation inside a template string" /repo/src/log.ts \
    'logger.info(`@TK@=${@TK@}`);'
  must_block SEC-013 "dollar-brace placeholder with a colon-dash literal default" /repo/config/app.yaml \
    '  @PW@: ${DB_@PWU@:-Hx72kq9Lmz}'
  must_block SEC-013 "dollar-brace placeholder with a non-identifier body" /repo/config/app.yaml \
    '  @PW@: ${Hx72#kq9Lmz}'
  must_block SEC-013 "reference assignment then literal assignment on one line" /repo/src/auth/client.ts \
    'const accessToken = await getAccessToken();@NL@const auth = { @TK@: accessToken, @SC@: "Hx72kq9Lmz" };'
  must_block SEC-013 "fake marker as an inner substring" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'pw-fake-4821' };"
  must_block SEC-013 "fake marker as a suffix" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'pw-4821-fake' };"
  must_block SEC-013 "fake marker plus a 32-hex remainder" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-9f86d081884c7d659a2feaa0c55ad015' };"
  must_block SEC-013 "fake marker plus a base64-like remainder" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-dGhpcyBub3Q=' };"
  must_block SEC-013 "fake-marked value over 24 characters" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-abcdefghijklmnopqrstu' };"
  must_block SEC-013 "fake-marked value in a test-path dotenv file" /repo/test/fixtures/.env \
    'DB_@PWU@=fake-pw-4821'
  must_block SEC-013 "fake-marked value in a test-path secrets-named file" /repo/test/fixtures/secrets.yml \
    '@PW@: fake-pw-4821'
  must_block SEC-013 "fake-marked value in a path with a traversal segment" /repo/test/../src/auth/login.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "fake-marked value where the test word is only a segment substring" /repo/src/contest/entries.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "fake-marked value with no file_path" - \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-014 "fake-marked value beside a PEM header in a test file" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-4821' };@NL@const key = \"@PEM@\";"
  must_block SEC-015 "fake-marked value beside a service-account marker in a test fixture" /repo/test/fixtures/sa.json \
    '{ "@PW@": "fake-pw-4821",@NL@  @SA@ }'
  must_block SEC-013 "mixed-case key word" /repo/app/settings.py \
    '@PWM@ = "Hx72kq9Lmz"'
  must_block SEC-013 "no-break space after the separator" /repo/app/settings.py \
    '@PW@ =@NBSP@Hx72kq9Lmz'
  must_block SEC-013 "plain assignment of a letters-only literal" /repo/app/settings.py \
    '@PW@ = "correcthorsebattery"'
  must_block SEC-013 "or fallback to a letters-only literal" /repo/app/settings.py \
    '@PW@ = os.getenv("DB_@PWU@") or "correcthorsebattery"'
  must_block SEC-013 "double-pipe fallback to a letters-only literal" /repo/src/db.ts \
    'const @PW@ = process.env.DB_@PWU@ || "correcthorsebattery";'
  must_block SEC-013 "env lookup with a letters-only default argument" /repo/app/settings.py \
    '@PW@ = os.environ.get("DB_@PWU@", "correcthorsebattery")'
  must_block SEC-013 "quoted multi-word literal whose first word is short" /repo/app/settings.py \
    '@PW@ = "open sesame please"'
  must_block SEC-013 "single-line backtick literal" /repo/src/db.ts \
    'const @PW@ = `Hx72kq9Lmz`;'
  must_block SEC-013 "f-prefixed literal" /repo/app/settings.py \
    '@PW@ = f"Hx72kq9Lmz"'
  must_block SEC-013 "r-prefixed literal" /repo/app/settings.py \
    '@PW@ = r"Hx72kq9Lmz"'
  must_block SEC-013 "quoted-key JSON literal" /repo/config/app.json \
    '{ "@PW@": "Hx72kq9Lmz" }'
  must_block SEC-013 "passwd key word" /repo/app/settings.py \
    '@PWD@ = "Hx72kq9Lmz"'
  must_block SEC-013 "access-key key word" /repo/app/settings.py \
    '@ACK@ = "Hx72kq9Lmz"'
  must_block SEC-013 "AWS secret-access-key name" /repo/app/settings.py \
    '@AWS@ = "Hx72kq9Lmz"'
  assert_no_corpus_failures
}

# shellcheck disable=SC2016  # templates carry literal ${…} and backticks on purpose
@test "generic credential corpus: a value that would clear by its own shape still blocks in a string, a non-code file or a later match" {
  CORPUS_FAILURES=()
  must_block SEC-013 "template-literal body whose value is also declared outside the string" /repo/src/config.ts \
    'const Hx72kq9Lmz = loadKey();@NL@const env = `@NL@DB_@PWU@=Hx72kq9Lmz@NL@`;'
  must_block SEC-013 "triple-quoted body whose value is also declared outside the string" /repo/app/config.py \
    'Hx72kq9Lmz = load_key()@NL@CONFIG = """@NL@@PW@: Hx72kq9Lmz@NL@"""'
  must_block SEC-013 "DSN string holding a dotted member-shaped value" /repo/app/db.py \
    'dsn = "host=db user=app @PW@=cfg.vault.Hx72kq9Lmz dbname=app"'
  must_block SEC-013 "template-literal body holding a dotted member-shaped value" /repo/src/config.ts \
    'const env = `@NL@DB_@PWU@=cfg.vault.Hx72kq9Lmz@NL@`;'
  must_block SEC-013 "header string whose value names a variable declared in the content" /repo/src/http.ts \
    'const Hx72kq9Lmz = getKey();@NL@const header = "X-@AKH@: Hx72kq9Lmz";'
  must_block SEC-013 "yaml flow mapping: placeholder reference then a bare literal" /repo/config/app.yaml \
    'auth: { @TK@: ${API_@TKU@}, @SC@: Hx72kq9Lmz }'
  must_block SEC-013 "object literal: declared variable then an undeclared bare identifier" /repo/src/auth/client.ts \
    'const accessToken = await getAccessToken();@NL@const auth = { @TK@: accessToken, @SC@: Hx72kq9Lmz };'
  must_block SEC-013 "dotenv: dotted value" /repo/.env \
    'DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "dotenv: bare value also declared as a key" /repo/.env \
    'Hx72kq9Lmz=1@NL@DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "Dockerfile: dotted value" /repo/Dockerfile \
    'ENV DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "Dockerfile: bare value also declared as a key" /repo/Dockerfile \
    'ENV Hx72kq9Lmz=1@NL@ENV DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "shell script: dotted value" /repo/scripts/run.sh \
    'export DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "shell script: bare value also declared as a variable" /repo/scripts/run.sh \
    'Hx72kq9Lmz=1@NL@export DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "extensionless file: dotted value" /repo/bin/setup \
    'DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "extensionless file: bare value also declared as a variable" /repo/bin/setup \
    'Hx72kq9Lmz=1@NL@DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "unlisted extension: dotted value" /repo/conf/app.xyz \
    'DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "unlisted extension: object key bound to a variable declared in the content" /repo/conf/app.xyz \
    'const accessToken = await getAccessToken();@NL@return { @TK@: accessToken };'
  must_block SEC-013 "no file_path: dotted value" - \
    'DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "no file_path: object key bound to a variable declared in the content" - \
    'const accessToken = await getAccessToken();@NL@return { @TK@: accessToken };'
  must_block SEC-013 "code file: env-style dotted digit-bearing value" /repo/src/config.ts \
    'DB_@PWU@=prod.vault.Hx72kq9Lmz'
  must_block SEC-013 "code file: bare value whose other occurrence is in a comment" /repo/src/config.ts \
    '// Hx72kq9Lmz@NL@DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "code file: bare value whose other occurrence is inside a string literal" /repo/src/config.ts \
    'const label = "Hx72kq9Lmz";@NL@DB_@PWU@=Hx72kq9Lmz'
  must_block SEC-013 "SQL: key word, two colons, mixed-case digit-bearing token" /repo/db/clients.sql \
    'SELECT @SC@::Hx72kq9Lmz FROM api_clients;'
  must_block SEC-013 "SQL: quoted literal assigned then cast" /repo/db/clients.sql \
    "UPDATE api_clients SET @SC@ = 'Hx72kq9Lmz'::text;"
  must_block SEC-013 "double-brace placeholder with a non-identifier body" /repo/config/app.yaml \
    '  @PW@: "{{Hx72#kq9Lmz}}"'
  must_block SEC-013 "double-brace placeholder with a default-filter literal" /repo/config/app.yaml \
    "  @PW@: \"{{ db_@PW@ | default('Hx72kq9Lmz') }}\""
  must_block SEC-013 "dollar-brace placeholder with a dash default" /repo/config/app.yaml \
    '  @PW@: ${DB_@PWU@-Hx72kq9Lmz}'
  must_block SEC-013 "dollar-brace placeholder with a colon-equals default" /repo/config/app.yaml \
    '  @PW@: ${DB_@PWU@:=Hx72kq9Lmz}'
  must_block SEC-013 "dollar-brace placeholder with a colon-plus alternative" /repo/config/app.yaml \
    '  @PW@: ${DB_@PWU@:+Hx72kq9Lmz}'
  must_block SEC-013 "dollar-brace placeholder followed by literal text" /repo/config/app.yaml \
    '  @PW@: ${DB_@PWU@}Hx72kq9Lmz'
  must_block SEC-013 "quoted double-brace placeholder followed by literal text" /repo/config/app.yaml \
    '  @PW@: "{{db_@PW@}}Hx72kq9Lmz"'
  must_block SEC-013 "dollar-brace wrapping a mixed-case digit-bearing token" /repo/config/app.yaml \
    '  @PW@: ${Hx72kq9Lmz}'
  must_block SEC-013 "double-brace wrapping a mixed-case digit-bearing token" /repo/config/app.yaml \
    '  @PW@: "{{Hx72kq9Lmz}}"'
  assert_no_corpus_failures
}

@test "generic credential corpus: a call, subscript, member or bind clears only when every digit-bearing part is a reference" {
  CORPUS_FAILURES=()
  must_pass "call whose argument is a small size" /repo/src/auth/keys.ts \
    'const @SC@ = crypto.randomBytes(32);'
  must_block SEC-013 "numeric literal wrapped in int()" /repo/app/settings.py \
    '@PW@ = int(12345678)'
  must_block SEC-013 "numeric literal wrapped in String()" /repo/src/db.ts \
    'const @AK@ = String(12345678);'
  must_block SEC-013 "hex literal wrapped in BigInt()" /repo/src/db.ts \
    'const @TK@ = BigInt(0x9f86d0818);'
  must_block SEC-013 "numeric literal wrapped in bytes()" /repo/app/settings.py \
    '@PW@ = bytes(12345678)'
  must_block SEC-013 "numeric literal wrapped in Integer()" /repo/app/config.rb \
    '@PW@ = Integer(12345678)'
  must_block SEC-013 "empty call then a numeric literal" /repo/src/db.ts \
    'const @PW@ = f()+12345678;'
  must_block SEC-013 "digit-bearing token as the callee" /repo/src/config.ts \
    'DB_@PWU@=Hx72kq9Lmz()'
  must_block SEC-013 "digit-bearing token subscripted" /repo/src/config.ts \
    'DB_@PWU@=Hx72kq9Lmz[0]'
  must_block SEC-013 "digit-bearing token with a member call" /repo/src/config.ts \
    'DB_@PWU@=Hx72kq9Lmz.x()'
  must_block SEC-013 "short callee with a symbol-bearing unquoted argument" /repo/src/db.ts \
    'const @PW@ = f(Hx#72kq!9Lmz);'
  must_block SEC-013 "short subscript with a symbol-bearing unquoted run" /repo/src/db.ts \
    'const @PW@ = a[Hx#72kq!9Lmz];'
  must_block SEC-013 "the key's own name as the member root" /repo/src/config.ts \
    'DB_@PWU@=DB_@PWU@.Hx72kq9Lmz'
  must_block SEC-013 "a language keyword as the member root" /repo/src/db.ts \
    'const @PW@ = const.Hx72kq9Lmz;'
  must_block SEC-013 "SQL bind with a digit-bearing name" /repo/db/revoke.sql \
    'UPDATE sessions SET revoked = true WHERE @TK@ = :Hx72kq9Lmz;'
  must_block SEC-013 "char codes passed to String.fromCharCode" /repo/src/db.ts \
    'const @PW@ = String.fromCharCode(104,120,55,50,107,113,57,76);'
  must_block SEC-013 "four three-digit call arguments" /repo/src/db.ts \
    'const @PW@ = f(123,456,789,101);'
  must_block SEC-013 "three three-digit subscripts" /repo/src/db.ts \
    'const @PW@ = a[123][456][789];'
  must_pass "SQL numeric cast with precision and scale" /repo/db/clients.sql \
    'SELECT @SC@::numeric(10, 2) FROM api_clients;'
  must_block SEC-013 "key word as a path qualifier before a constructor with a numeric argument" /repo/src/config.rs \
    'let k = @PW@::new(12345678);'
  must_block SEC-013 "SQL cast followed by a comma-joined token" /repo/db/clients.sql \
    'SELECT @SC@::text,Hx72kq9Lmz FROM api_clients;'
  assert_no_corpus_failures
}

# shellcheck disable=SC2016  # templates carry literal ${…} on purpose
@test "generic credential corpus: a placeholder clears only with an env-name body outside dotenv and secrets files" {
  CORPUS_FAILURES=()
  must_pass "placeholder naming env words with short digit suffixes" /repo/config/app.yaml \
    '  @PW@: ${S3_@SCU@_V2}'
  must_block SEC-013 "dollar-brace wrapping a lower-case hex value in yaml" /repo/config/app.yaml \
    '  @PW@: ${deadbeef12345678}'
  must_block SEC-013 "dollar-brace wrapping an upper-case base32 value in yaml" /repo/config/app.yaml \
    '  @PW@: ${JBSWY3DPEHPK3PXP}'
  must_block SEC-013 "quoted double-brace wrapping a lower-case hex value in yaml" /repo/config/app.yaml \
    '  @PW@: "{{deadbeef12345678}}"'
  must_block SEC-013 "dollar-brace wrapping a lower-case hex value in dotenv" /repo/.env \
    'DB_@PWU@=${deadbeef12345678}'
  must_block SEC-013 "env-name placeholder in a dotenv file" /repo/.env \
    'DB_@PWU@=${DB_@PWU@}'
  must_block SEC-013 "env-name placeholder in a secrets-named yaml" /repo/config/secrets.yaml \
    '@PW@: ${DB_@PWU@}'
  assert_no_corpus_failures
}

# shellcheck disable=SC2016  # templates carry literal ${…} and backticks on purpose
@test "generic credential corpus: a multi-line string form is read as a string, so its body never clears by shape" {
  CORPUS_FAILURES=()
  must_pass "Ruby heredoc closed on its own tag line, then an env lookup" /repo/app/config.rb \
    'conf = <<~EOS@NL@  hello@NL@EOS@NL@@PW@ = ENV.fetch("DB_@PWU@")'
  must_pass "Rust lifetime quotes, then an env lookup" /repo/src/config.rs \
    "fn f<'a>(x: &'a str) -> &'a str { x }@NL@let @TK@ = env.get(\"API_@TKU@\");"
  must_block SEC-013 "Python triple-quoted body with an escaped quote before its close" /repo/app/config.py \
    'Hx72kq9Lmz = load_key()@NL@CONFIG = """@NL@say \""" then@NL@@PW@: Hx72kq9Lmz@NL@"""'
  must_block SEC-013 "Ruby squiggly heredoc with a line that starts with its tag" /repo/app/config.rb \
    'Hx72kq9Lmz = load_key@NL@conf = <<~EOS@NL@  EOS marks the end@NL@  @PW@: Hx72kq9Lmz@NL@EOS'
  must_block SEC-013 "SQL dollar-quoted body" /repo/db/fn.sql \
    'SELECT 1 AS Hx72kq9Lmz;@NL@DO $$@NL@BEGIN@NL@  @PW@ = Hx72kq9Lmz;@NL@END $$;'
  must_block SEC-013 "Ruby double-quoted string spanning lines" /repo/app/config.rb \
    'Hx72kq9Lmz = load_key@NL@conf = "@NL@@PW@: Hx72kq9Lmz@NL@"'
  must_block SEC-013 "PHP single-quoted string spanning lines" /repo/app/config.php \
    "Hx72kq9Lmz();@NL@\$conf = '@NL@@PW@: Hx72kq9Lmz@NL@';"
  must_block SEC-013 "Rust string spanning lines" /repo/src/config.rs \
    'let Hx72kq9Lmz = load_key();@NL@let conf = "@NL@@PW@: Hx72kq9Lmz@NL@";'
  must_block SEC-013 "Rust raw string" /repo/src/config.rs \
    'let Hx72kq9Lmz = load_key();@NL@let conf = r#"@NL@@PW@: Hx72kq9Lmz@NL@"#;'
  must_block SEC-013 "C# verbatim string" /repo/src/Config.cs \
    'var Hx72kq9Lmz = LoadKey();@NL@var conf = @"@NL@@PW@: Hx72kq9Lmz@NL@";'
  must_block SEC-013 "C++ raw string" /repo/src/config.cpp \
    'auto Hx72kq9Lmz = load_key();@NL@auto conf = R"cfg(@NL@@PW@: Hx72kq9Lmz@NL@)cfg";'
  must_block SEC-013 "Dart triple-single-quoted string" /repo/lib/config.dart \
    "final Hx72kq9Lmz = loadKey();@NL@final conf = '''@NL@@PW@: Hx72kq9Lmz@NL@''';"
  must_block SEC-013 "template literal whose interpolation holds a backtick in a comment" /repo/src/config.ts \
    'const Hx72kq9Lmz = loadKey();@NL@const env = `${a /* ` */}@NL@DB_@PWU@=Hx72kq9Lmz@NL@`;@NL@const z = `q`;'
  must_pass "regex literal holding quotes, then an object key bound to a declared variable" /repo/src/auth/client.ts \
    "const re = /['\"\`]/g;@NL@const accessToken = await getAccessToken();@NL@return { @TK@: accessToken };"
  must_pass "division, then an object key bound to a declared variable" /repo/src/auth/client.ts \
    'const half = total / 2;@NL@const accessToken = await getAccessToken();@NL@return { @TK@: accessToken };'
  must_block SEC-013 "TypeScript regex literal holding a backtick before a template literal" /repo/src/config.ts \
    'const Hx72kq9Lmz = loadKey();@NL@const re = /`/;@NL@const env = `@NL@DB_@PWU@=Hx72kq9Lmz@NL@`;'
  must_block SEC-013 "TypeScript regex literal holding a quote before a template opener on its line" /repo/src/config.ts \
    "const Hx72kq9Lmz = loadKey();@NL@const re = /'/, env = \`@NL@DB_@PWU@=Hx72kq9Lmz@NL@\`;"
  must_block SEC-013 "Go raw string ending in a backslash, then a raw-string body" /repo/cmd/server/main.go \
    'var Hx72kq9Lmz = loadKey()@NL@var dir = `C:\`@NL@var conf = `@NL@@PW@: Hx72kq9Lmz@NL@`'
  must_block SEC-013 "Ruby percent literal spanning lines" /repo/app/config.rb \
    'Hx72kq9Lmz = load_key@NL@conf = %q{@NL@@PW@: Hx72kq9Lmz@NL@}'
  must_block SEC-013 "Ruby block comment" /repo/app/config.rb \
    'Hx72kq9Lmz = load_key@NL@=begin@NL@@PW@: Hx72kq9Lmz@NL@=end'
  must_block SEC-013 "Rust byte raw string ending in a backslash, then a string body" /repo/src/config.rs \
    'let Hx72kq9Lmz = load_key();@NL@let dir = br"C:\";@NL@let conf = "@NL@@PW@: Hx72kq9Lmz@NL@";'
  must_block SEC-013 "SQL string ending in a backslash, then a string body" /repo/db/fn.sql \
    "SELECT 1 AS Hx72kq9Lmz;@NL@SELECT 'C:\\';@NL@SELECT '@NL@@PW@ = Hx72kq9Lmz;@NL@';"
  must_block SEC-013 "C# interpolated verbatim string, at-sign first" /repo/src/Config.cs \
    'var Hx72kq9Lmz = LoadKey();@NL@var conf = @$"@NL@@PW@: Hx72kq9Lmz@NL@";'
  must_block SEC-013 "a multi-line form left open at the end of the text" /repo/src/config.ts \
    'const Hx72kq9Lmz = loadKey();@NL@DB_@PWU@=Hx72kq9Lmz@NL@const z = `'
  assert_no_corpus_failures
}

# shellcheck disable=SC2016  # templates carry literal backticks on purpose
@test "generic credential corpus: an Edit is judged in its target's context, and an unknown context as a string" {
  local anchors="" i
  CORPUS_FAILURES=()
  put_edit_target "${CORPUS_ROOT}/repo/src/declared.ts" 'const Hx72kq9Lmz = loadKey();@NL@// edit anchor@NL@'
  check_edit_row "" "bare identifier declared elsewhere in the target" /repo/src/declared.ts \
    '// edit anchor' 'DB_@PWU@=Hx72kq9Lmz'
  put_edit_target "${CORPUS_ROOT}/repo/src/template.ts" 'const Hx72kq9Lmz = loadKey();@NL@const env = `@NL@ANCHOR@NL@`;'
  check_edit_row SEC-013 "splice into a template literal" /repo/src/template.ts ANCHOR 'DB_@PWU@=Hx72kq9Lmz'
  put_edit_target "${CORPUS_ROOT}/repo/app/config.py" 'Hx72kq9Lmz = load_key()@NL@CONFIG = """@NL@ANCHOR@NL@"""'
  check_edit_row SEC-013 "splice into a triple-quoted string" /repo/app/config.py ANCHOR '@PW@: Hx72kq9Lmz'
  put_edit_target "${CORPUS_ROOT}/repo/src/comment.ts" 'const Hx72kq9Lmz = loadKey();@NL@/* ANCHOR */'
  check_edit_row SEC-013 "splice point inside a comment" /repo/src/comment.ts ANCHOR 'DB_@PWU@=Hx72kq9Lmz'
  check_edit_row SEC-013 "unknown context: typed declaration then literal" /repo/src/comment.ts ANCHOR \
    'const @PW@: string = "Hx72kq9Lmz!";'
  check_edit_row SEC-013 "unknown context: prefix-lettered literal" /repo/src/comment.ts ANCHOR '@PW@ = b"Hx72kq9Lmz"'
  check_edit_row SEC-013 "unknown context: parenthesised literal" /repo/src/comment.ts ANCHOR \
    'const @PW@ = ("Hx72kq9Lmz");'
  check_edit_row SEC-013 "unknown context: wrapper call around a letters-only literal" /repo/src/comment.ts ANCHOR \
    'const @PW@ = derive("correcthorsebattery");'
  check_edit_row SEC-013 "unknown context: colon-equals declaration" /repo/src/comment.ts ANCHOR '@PW@ := "Hx72kq9Lmz"'
  check_edit_row SEC-013 "unknown context: multi-word literal" /repo/src/comment.ts ANCHOR \
    'const @PW@ = "open sesame please";'
  check_edit_row SEC-013 "target file missing" /repo/src/missing.ts ANCHOR \
    'const Hx72kq9Lmz = loadKey();@NL@DB_@PWU@=Hx72kq9Lmz'
  put_edit_target "${CORPUS_ROOT}/repo/src/other.ts" 'const a = 1;'
  check_edit_row SEC-013 "old_string absent from the target" /repo/src/other.ts ANCHOR \
    'const Hx72kq9Lmz = loadKey();@NL@DB_@PWU@=Hx72kq9Lmz'
  for ((i = 0; i < 51; i++)); do anchors+="ANCHOR@NL@"; done
  put_edit_target "${CORPUS_ROOT}/repo/src/many.ts" "const env = \`@NL@${anchors}\`;"
  check_edit_row SEC-013 "replace_all over 50 anchors inside a template literal" /repo/src/many.ts ANCHOR \
    'Hx72kq9Lmz;@NL@DB_@PWU@=Hx72kq9Lmz' true
  put_edit_target "${CORPUS_ROOT}/repo/src/big.ts" 'const Hx72kq9Lmz = loadKey();@NL@// edit anchor@NL@'
  printf '%*s\n' 1100000 '' >>"${CORPUS_ROOT}/repo/src/big.ts"
  check_edit_row SEC-013 "target over the size cap" /repo/src/big.ts '// edit anchor' 'DB_@PWU@=Hx72kq9Lmz'
  put_edit_target "${CORPUS_ROOT}/repo/src/locked.ts" 'const Hx72kq9Lmz = loadKey();@NL@// edit anchor@NL@'
  chmod 000 "${CORPUS_ROOT}/repo/src/locked.ts"
  check_edit_row SEC-013 "unreadable target" /repo/src/locked.ts '// edit anchor' 'DB_@PWU@=Hx72kq9Lmz'
  assert_no_corpus_failures
}

@test "generic credential corpus: the marker leg clears only a fake, dummy or fixture prefix in a closed test-path set" {
  CORPUS_FAILURES=()
  must_pass "dummy-marked value in a .test.ts file" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'dummy-pw-4821' };"
  must_pass "fixture-marked value with an underscore separator" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fixture_pw_4821' };"
  must_pass "upper-case marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'FAKE-pw-4821' };"
  must_pass "marked value at the 24-character cap" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-abcdefghijklmnop' };"
  must_block SEC-013 "excluded word test as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'test-pw-4821' };"
  must_block SEC-013 "excluded word mock as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'mock-pw-4821' };"
  must_block SEC-013 "excluded word example as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'example-4821' };"
  must_block SEC-013 "excluded word sample as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'sample-pw-48' };"
  must_block SEC-013 "excluded word demo as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'demo-pw-4821' };"
  must_block SEC-013 "excluded word default as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'default-4821' };"
  must_block SEC-013 "default-credential word as the marker" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'changeme-482' };"
  must_block SEC-013 "marker run straight into its remainder" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fakepw-48217' };"
  must_block SEC-013 "marked value one character over the cap" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-abcdefghijklmnopq' };"
  must_block SEC-013 "marked value with a plus sign" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw+4821xy' };"
  must_block SEC-013 "marked value with a slash" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw/4821xy' };"
  must_block SEC-013 "marked value with a dot" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw.4821xy' };"
  must_block SEC-013 "marked and unmarked literal on one line" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-4821', @SC@: 'Hx72kq9Lmz' };"
  must_block SEC-013 "marked and unmarked literal on separate lines" /repo/src/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-4821' };@NL@const api = { @SC@: 'Hx72kq9Lmz' };"
  must_block SEC-008 "marked value with a Slack-token-shaped remainder" /repo/src/auth/login.test.ts \
    "const user = { @TK@: 'fake-@XOXB@1234567890' };"
  must_block SEC-013 "credentials-named file in a test path" /repo/test/fixtures/credentials.yml \
    '@PW@: fake-pw-4821'
  must_block SEC-013 "dotenv basename carrying the test word as its suffix" /repo/test/.env.test \
    'DB_@PWU@=fake-pw-4821'
  must_block SEC-013 "dotenv suffix inside a longer basename in a test path" /repo/test/fixtures/app.env.local \
    'DB_@PWU@=fake-pw-4821'
  must_block SEC-013 "test-named directory with no project root above it" /nonexistent-ga-root/tests/login.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "fixtures segment with no test segment" /repo/fixtures/users.yml \
    '@PW@: fake-pw-4821'
  must_block SEC-013 "stem ending in the test word with no separator" /repo/src/auth/logintest.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "test suffix followed by a further extension" /repo/src/auth/login.test.ts.bak \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "segment that only starts with the test word" /repo/testing/login.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "upper-case test segment" /repo/Tests/login.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "relative test path" test/auth/login.test.ts \
    "const user = { @PW@: 'fake-pw-4821' };"
  must_block SEC-013 "empty-string file_path" "" \
    "const user = { @PW@: 'fake-pw-4821' };"
  assert_no_corpus_failures
}

@test "generic credential corpus: a malformed envelope blocks with SEC-017, only the degenerate-empty set passes" {
  local name expected code raw is_hit us=$'\x1f'
  CORPUS_FAILURES=()
  while IFS="${us}" read -r name expected code raw; do
    run bash "${HOOK_SH}" <<<"${raw}"
    is_hit=0
    [[ "${status}" -eq "${expected}" && "${output}" == *"${code}"* ]] && is_hit=1
    ((is_hit == 1)) || CORPUS_FAILURES+=("envelope | ${name} | exit ${status}")
  done <<EOF
truncated JSON${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts","content":"x
root that is not an object${us}2${us}SEC-017${us}["Write"]
Write with tool_input that is not an object${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":"x"}
Edit with tool_input that is not an object${us}2${us}SEC-017${us}{"tool_name":"Edit","tool_input":"x"}
Write with tool_input absent${us}2${us}SEC-017${us}{"tool_name":"Write"}
Edit with tool_input absent${us}2${us}SEC-017${us}{"tool_name":"Edit"}
Write with no content key${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts"}}
Edit with no new_string key${us}2${us}SEC-017${us}{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts","old_string":"x"}}
Write with a list as content${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts","content":["x"]}}
Write with a number as content${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts","content":42}}
Write with null content${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts","content":null}}
Edit with a list as new_string${us}2${us}SEC-017${us}{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts","old_string":"x","new_string":["x"]}}
Edit with a number as new_string${us}2${us}SEC-017${us}{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts","old_string":"x","new_string":42}}
Edit with null new_string${us}2${us}SEC-017${us}{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts","old_string":"x","new_string":null}}
Write with a file_path that is not a string${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":42,"content":"x"}}
Edit also carrying content${us}2${us}SEC-017${us}{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts","old_string":"x","new_string":"y","content":"z"}}
Write also carrying new_string${us}2${us}SEC-017${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts","content":"x","new_string":"y"}}
empty stdin${us}0${us}${us}
Write with empty content${us}0${us}${us}{"tool_name":"Write","tool_input":{"file_path":"/repo/src/a.ts","content":""}}
Edit deleting text (empty new_string)${us}0${us}${us}{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts","old_string":"x","new_string":""}}
EOF
  assert_no_corpus_failures
}

@test "generic credential corpus: a module file in the session's working directory cannot replace the scan's own imports" {
  local mod text envelope work="${BATS_TEST_TMPDIR}/cwd"
  text="$(expand_corpus_text 'const @PW@ = "Xk9#mQ2!vL7%pR4z";')"
  envelope="$(build_envelope Write "${CORPUS_ROOT}/repo/src/db.ts" "${text}")"
  for mod in bisect json re; do
    mkdir -p "${work}/${mod}"
    printf 'print("clear")\nraise SystemExit(0)\n' >"${work}/${mod}/${mod}.py"
    run bash -c 'cd "${1}" && bash "${2}"' _ "${work}/${mod}" "${HOOK_SH}" <<<"${envelope}"
    [[ "${status}" -eq 2 && "${output}" == *"SEC-013"* ]] || {
      echo "${mod}.py in cwd: exit ${status} ${output}"
      return 1
    }
  done
}

# Generated content whose cost grows with its size; a hook past the budget would block a benign file.
# Args: $1=rows $2=key word
build_generated_rows() {
  python3 -c '
import sys
n, key = int(sys.argv[1]), sys.argv[2]
print("".join("  { %s: accessToken },\n" % key for _ in range(n)) + "const accessToken = 1;", end="")
' "$@"
}

@test "generic credential corpus: many keys bound to one identifier declared last are judged well inside the scan budget" {
  local text envelope start
  text="$(build_generated_rows 12000 "to""ken")"
  envelope="$(build_envelope Write "${CORPUS_ROOT}/repo/src/rows.ts" "${text}")"
  start="${SECONDS}"
  run bash "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  ((SECONDS - start < 5)) || {
    echo "took $((SECONDS - start)) s"
    return 1
  }
}

@test "generic credential corpus: one long line of quoted words after a key blocks well inside the scan budget" {
  local text envelope start words
  words="$(python3 -c 'print(", ".join(["\"abcdefghij\""] * 12000), end="")')"
  text="$(expand_corpus_text "const @PW@ = x, w = [${words}];")"
  envelope="$(build_envelope Write "${CORPUS_ROOT}/repo/src/words.ts" "${text}")"
  start="${SECONDS}"
  run bash "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 2 && "${output}" == *"SEC-013"* ]] || {
    echo "exit ${status} ${output}"
    return 1
  }
  ((SECONDS - start < 5)) || {
    echo "took $((SECONDS - start)) s"
    return 1
  }
}

@test "generic credential corpus: non-ASCII source content passes under the C locale on Write and Edit" {
  local tool envelope
  for tool in Write Edit; do
    envelope="$(build_envelope "${tool}" /repo/src/i18n/ko.ts 'export const greeting = "안녕하세요, 다시 오셨네요";')"
    run env LC_ALL=C bash "${HOOK_SH}" <<<"${envelope}"
    [[ "${status}" -eq 0 ]] || {
      echo "${tool}: ${output}"
      return 1
    }
  done
}
