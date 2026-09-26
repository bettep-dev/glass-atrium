#!/usr/bin/env bats
# track-outcome-completion-block-select.bats — tier-1 [COMPLETION] block SELECTION + KNOWN_FIELDS
# folding guard for track-outcome.sh.
#
# Contract pinned:
#  #25 — validity-aware LAST-preference over ALL tier-1 matches. A subagent that quotes the
#        emit-format template (whose [COMPLETION] block carries a pipe-joined
#        `result: done|...|fail` placeholder) BEFORE its real block must NOT have the template
#        shadow the writer signal. A bare re.search binds the FIRST match → the template's
#        result is not a single valid token → the row synthesizes and the writer signal is lost.
#        (a) template-then-real  → parse_tier=1, result=done (last-preference alone suffices)
#        (b) real-then-template  → parse_tier=1, result=done (the LAST match is the invalid
#            template, so the validity-aware reverse-scan MUST fall back to the earlier valid
#            block — the regression a naive last-match-only fix would fail).
#  KNOWN_FIELDS boundaries — white-box tests over the real parser
#        - key outside KNOWN_FIELDS → folds into the preceding field's value (multi-line + inline)
#        - template key after another field → starts its own field (multi-line + inline)
#
# The #25 cases run DB-free: PG is fail-opened via PGHOST and the parse decision is read off the
# stderr diagnostic channel (the DIAG parse_tier line + the auto-generated record marker carrying
# `"result":"done"`), mirroring the [inline] cases in track-outcome-schema-mode-completion.bats.
# result=done is the distinguishing recovery signal — the synthesis branch can only ever emit
# done_with_concerns (or blocked), never done. HOME is sandboxed so the transcript resolution and
# the diag log stay inside the test temp dir.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"
# The repo and the live install both root rules/glass-atrium/ beside hooks/.
RULES_DOC="${HOOKS_DIR}/../rules/glass-atrium/core-outcome-record.md"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  BS_TMP="$(mktemp -d)"
  SANDBOX_HOME="${BS_TMP}/home"
  mkdir -p "${SANDBOX_HOME}/.glass-atrium/logs"
  PAYLOAD_FILE="${BS_TMP}/payload.json"

  # The canonical emit-format template block (pipe-joined placeholders) an agent might quote.
  TEMPLATE_BLOCK="$(printf '%s\n' \
    '[COMPLETION]' \
    'result: done|done_with_concerns|blocked|needs_context|fail' \
    'task_type: bug-fix|feature|refactor|research|plan|review|diagnosis|doc|cleanup' \
    'metric_pass: true|false' \
    'confidence: high|medium|low' \
    'summary: 1-line summary' \
    '[/COMPLETION]')"
  # The real writer block (single valid tokens).
  REAL_BLOCK="$(printf '%s\n' \
    '[COMPLETION]' \
    'result: done' \
    'task_type: bug-fix' \
    'metric_pass: true' \
    'confidence: high' \
    'summary: the real deliverable' \
    '[/COMPLETION]')"
}

teardown() {
  # `if` (not `[[ ]] && cmd`) so a false guard returns 0 — a setup-skip (BS_TMP unset) must not
  # turn the clean skip into a non-zero teardown exit (which bats reports as `not ok`).
  if [[ -n "${BS_TMP:-}" && -d "${BS_TMP}" ]]; then
    rm -rf "${BS_TMP}"
  fi
}

# A bare intermediate `[[ ]]` assertion is silently ignored under bash 3.2 (macOS) — a false one
# never fails the test there — while bash 5.3 (CI) aborts on it (measured, bats 1.13.0 on both
# legs: bash is the variable, not bats). oc/no echo a diagnostic + return non-zero so each
# caller's `|| return 1` aborts the test AT the failing assertion on both.
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# DB-free hook driver: the combined message in last_assistant_message, PG fail-opened (PGHOST →
# nonexistent socket), stderr merged into stdout. $1 = last_assistant_message.
run_hook_dbfree() {
  jq -nc --arg m "${1}" '{
    hook_event_name: "SubagentStop",
    agent_type: "glass-atrium-dev-shell",
    agent_id: "bsagent01",
    session_id: "sess-bs-1",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "run the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "#25(a) template-quote BEFORE the real block does not shadow the writer signal (result=done)" {
  run_hook_dbfree "Here is the format I use:"$'\n\n'"${TEMPLATE_BLOCK}"$'\n\n'"Actual result:"$'\n\n'"${REAL_BLOCK}"
  [ "${status}" -eq 0 ] || return 1
  # The real block (last, valid) is selected — NOT the leading template placeholder.
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  # A shadowed template would leave an invalid result → synthesis branch.
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "#25(b) real block THEN a trailing template quote still selects the real block (validity reverse-scan)" {
  run_hook_dbfree "${REAL_BLOCK}"$'\n\n'"(for reference the template is:)"$'\n\n'"${TEMPLATE_BLOCK}"
  [ "${status}" -eq 0 ] || return 1
  # The LAST tier-1 match is the invalid template; a naive last-match-only fix would synthesize.
  # The validity-aware reverse-scan MUST fall back to the earlier valid block → result=done.
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "#25 single invalid (template-only) block still synthesizes — no crash, behavior preserved" {
  # No valid earlier match exists, so the last (invalid) block is kept and the row synthesizes,
  # exactly as before the fix. Guards the m_tier1/m_tier2 rebind (the downstream _block_text
  # grader-body extraction would NameError if either were left unbound).
  run_hook_dbfree "${TEMPLATE_BLOCK}"
  [ "${status}" -eq 0 ] || return 1
  no "Traceback" "${output}" || return 1
  no "NameError" "${output}" || return 1
  oc "attribution=completion-synthesized" "${output}" || return 1
}

# embedded parser prefix (pre-json.load) exec'd into `ns` → checks read the real parser, never a copy
# report(): one line per failure, non-zero exit on any
PARSER_PRELUDE="$(
  cat <<'PY'
import os, sys, re
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r"<<'PYEOF'\n(.*?)\nPYEOF", src, re.DOTALL)
assert m, "PYEOF heredoc not found"
ns = {}
exec(compile(m.group(1).split('\ntry:\n    d = json.load(sys.stdin)')[0], 'embedded', 'exec'), ns)
parse = ns['parse_completion_body']

def report(failures):
    print('\n'.join(failures) or 'OK')
    sys.exit(1 if failures else 0)
PY
)"

# $1 = python check source run after the prelude; the remaining args become sys.argv[2:].
run_parser_check() {
  local check_src="${1}"
  shift
  run python3 - "${HOOK_SH}" "$@" <<<"${PARSER_PRELUDE}"$'\n'"${check_src}"
  [ "${status}" -eq 0 ] || {
    printf '%s\n' "${output}"
    return 1
  }
  oc "OK" "${output}"
}

@test "a template key emitted after another field never joins that field's value" {
  local check_src
  check_src="$(
    cat <<'PY'
rows = [
    ('token_usage then agent_version',
     'result: done\ntoken_usage: input=5, output=6\nagent_version: 1.0.0',
     {'token_usage': 'input=5, output=6'}),
    ('a single relative test path in files then agent_version',
     'result: done\nfiles: hooks/test/code-based-grader.bats\nagent_version: 1.0.0',
     {'files': 'hooks/test/code-based-grader.bats'}),
    ('summary then grader_verdict then downgrade_origin',
     'result: done\nsummary: parser fix landed\ngrader_verdict: verified_pass\n'
     'downgrade_origin: writer_false',
     {'summary': 'parser fix landed'}),
    ('lesson then agent_version',
     'result: done\nlesson: register every template key\nagent_version: 1.0.0',
     {'lesson': 'register every template key'}),
    ('summary then qa_score then lesson',
     'result: done\nsummary: review verdict\nqa_score: cov=4,ins=4,instr=4,clar=4\nlesson: keep',
     {'summary': 'review verdict', 'qa_score': 'cov=4,ins=4,instr=4,clar=4'}),
]
failures = []
for name, block, expected in rows:
    parsed = parse(block)
    for field, want in expected.items():
        if parsed.get(field) != want:
            failures.append(f'{name}: {field}={parsed.get(field)!r}, want {want!r}')
report(failures)
PY
  )"
  run_parser_check "${check_src}"
}

@test "an inline block's template key never joins the preceding field's value" {
  local check_src
  # The inline tier's own split: delimiters → newlines, then parse_completion_body.
  check_src="$(
    cat <<'PY'
inline = 'result: done | token_usage: input=5, output=6 | agent_version: 1.0.0'
parsed = parse(re.sub(ns['_INLINE_DELIM_CLASS'], '\n', inline))
got = parsed.get('token_usage')
report([] if got == 'input=5, output=6' else [f'token_usage={got!r}'])
PY
  )"
  run_parser_check "${check_src}"
}

@test "a line whose key is outside KNOWN_FIELDS folds into the preceding field's value" {
  local check_src
  check_src="$(
    cat <<'PY'
rows = [
    ('multi-line colon-less prose line',
     'result: done\nsummary: first line\nsecond prose line',
     'first line second prose line'),
    ('multi-line non-template key line, then prose',
     'result: done\nsummary: first line\nNote: extra line\nsecond prose line',
     'first line Note: extra line second prose line'),
    ('inline non-template key segment',
     re.sub(ns['_INLINE_DELIM_CLASS'], '\n', 'result: done | summary: a | Note: b'),
     'a Note: b'),
]
failures = []
for name, block, want in rows:
    parsed = parse(block)
    if parsed != {'result': 'done', 'summary': want}:
        failures.append(f'{name}: parsed={parsed!r}, want summary={want!r}')
report(failures)
PY
  )"
  run_parser_check "${check_src}"
}

@test "a template key leading the block leaves every later field clean" {
  local check_src
  check_src="$(
    cat <<'PY'
parsed = parse('agent_version: 1.0.0\nresult: done\ntoken_usage: input=5, output=6')
want = {'result': 'done', 'token_usage': 'input=5, output=6'}
report([f'{k}={parsed.get(k)!r}' for k, v in want.items() if parsed.get(k) != v])
PY
  )"
  run_parser_check "${check_src}"
}

@test "every key of the [COMPLETION] template is a KNOWN_FIELDS member" {
  local check_src
  # Never skips: a missing doc, anchor, fence or key list fails with its own message.
  check_src="$(
    cat <<'PY'
doc = sys.argv[2]
if not os.path.isfile(doc):
    report([f'rules doc not found: {doc}'])
text = open(doc, encoding='utf-8').read()
anchor = re.search(r'^## Completion Report Output Obligation$', text, re.MULTILINE)
if not anchor:
    report([f'anchor "## Completion Report Output Obligation" missing in {doc}'])
section = re.split(r'^## ', text[anchor.end():], maxsplit=1, flags=re.MULTILINE)[0]
fence = re.search(r'^```[^\n]*\n(.*?)^```', section, re.DOTALL | re.MULTILINE)
if not fence:
    report([f'no fenced block inside the anchor section in {doc}'])
keys = set(re.findall(r'^([a-z_]+):', fence.group(1), re.MULTILINE))
if not keys:
    report([f'the template fence in {doc} carries no key lines'])
report([f'template key missing from KNOWN_FIELDS: {k}' for k in sorted(keys - ns['KNOWN_FIELDS'])])
PY
  )"
  run_parser_check "${check_src}" "${RULES_DOC}"
}
