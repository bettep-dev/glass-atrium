#!/usr/bin/env bats
# workflow-gate-completion-channel.bats — pins completion_block_advisory_needed, the schema-mode
#   completion-channel detector in enforce-workflow-verify-stage.sh.
#
# HARNESS (why this is a separate file): the detector is a predicate, and the sibling workflow-gate
#   suites are envelope-driven black boxes whose only observables are an exit status and a trace line.
#   This suite extracts the hook's own verdict-block definitions into a module and calls the predicate
#   directly, so a row asserts the predicate rather than a downstream emit. Extraction reads the hook
#   at its real path → a copied predicate could drift; this one cannot.
#
# FROZEN OBSERVATION (produced by RUNNING the predicate over these exact rows, not derived from the
# regex shape). ADVISE = classified a schema-mode site with the reserved token absent.
#   bare key with value                   ->  ADVISE
#   quoted key with value                 ->  silent    (documented false negative: masking blanks it)
#   shorthand in a spread object          ->  ADVISE
#   shorthand with further keys           ->  ADVISE
#   text-mode fallback undefined value    ->  silent    (value exclusion; the recommended form)
#   a null value                          ->  silent
#   a void 0 / void(0) / void x value     ->  silent    (value exclusion, admitted by operator shape)
#   a merely FALSY value (0)              ->  ADVISE    (not an absent-value denotation; the boundary)
#   an identifier merely STARTING void    ->  ADVISE    (voidness — the trailing lookahead holds)
#   prose: word followed by a colon       ->  silent    (masked anchor operand)
#   prose: word alone                     ->  silent
#   word only inside a line comment       ->  silent
#   RESIDUAL guard off an options object  ->  ADVISE    (published false positive, key-position only)
#   RESIDUAL member write (opts.schema=S) ->  ADVISE    (published; excluding it would blank a REAL site)
#   RESIDUAL assignment to undefined      ->  ADVISE    (published false positive, same cause)
#   RESIDUAL import / destructure / param ->  ADVISE    (published; excluding them is inert, the USE fires)
#   RESIDUAL word in a regex literal      ->  ADVISE    (published; a lexical-class limit of the mask)
#   token declared as a schema member     ->  silent
#   token as prose in a goal string       ->  silent    (unmasked token half → recall)
#   token ONLY inside a comment           ->  ADVISE    (comment-stripped token half)
#
# bats-1.13 LAST-COMMAND SEMANTICS (load-bearing, mirrors the sibling suites): a test fails ONLY on its
#   final command exit, so every table test ends on one gate over an accumulated failure list.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"
SKILL_MD="${BATS_TEST_DIRNAME}/../../skills/glass-atrium-ops-orchestrator.md"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
  NUDGE_PHRASE='ADVISORY (completion channel, non-blocking)'
  ABSENT_PHRASE='ADVISORY (completion channel absent, non-blocking)'
  # A DEV workflow that clears every attestation gate and reaches the terminal emit.
  DECL_TEAM="/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/7440')
log('[SCOPE] files=hooks/a.sh')
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}))
agent('glass-atrium-dev-nestjs',{goal:'implement'})"
  SCHEMA_SITE="const S = { findings: 'string' };
const r = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: S });"
  GATE_DEFS="${BATS_TEST_TMPDIR}/gate_defs.py"
  PROBE_PY="${BATS_TEST_TMPDIR}/probe.py"
  # Definitions only: cut at the module-level `try:` so importing runs no argv-reading dispatch.
  awk 'index($0, "cat <<\047PY\047") > 0 { f = 1; next }
       f && $0 == "PY" { exit }
       f && $0 == "try:" { exit }
       f' "${HOOK_SH}" >"${GATE_DEFS}"
  cat >"${PROBE_PY}" <<'PYX'
import sys
import importlib.util

spec = importlib.util.spec_from_file_location("gate_defs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
predicate = getattr(mod, sys.argv[2])
src = sys.stdin.read()
print("ADVISE" if predicate(mod.strip_comments(src)) else "silent")
PYX
}

# probe SRC [PREDICATE] — the verdict for one JS source, as ADVISE or silent. Source arrives on stdin so
# no shell quoting can reshape a fixture. PREDICATE names which detector answers, defaulting to the
# script-wide one so every pre-existing row reads unchanged.
probe() {
  printf '%s' "${1}" | python3 "${PROBE_PY}" "${GATE_DEFS}" "${2:-completion_block_advisory_needed}" 2>&1
}

# Drive the hook as a command with a Workflow envelope wrapping $1, against a temp trace log so no
# live-install state is read or written.
run_hook_exec() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# The advisory field of the LAST recorded trace line, or MISSING when absent.
last_advisory() {
  awk -F'\t' 'END { for (i = 1; i <= NF; i++) if (index($i, "advisory=") == 1) { print substr($i, 10); exit } print "MISSING" }' "${TRACE_LOG}"
}

# check EXPECTED LABEL SRC [PREDICATE] — non-zero on mismatch, with the observed value named.
check() {
  local expected="${1}" label="${2}" observed
  observed="$(probe "${3}" "${4:-}")"
  [[ "${observed}" == "${expected}" ]] || {
    echo "row [${label}]: expected ${expected}, observed ${observed}" >&2
    return 1
  }
}

@test "completion-channel(extract): the hook's verdict block yields an importable detector" {
  grep -q 'def completion_block_advisory_needed' "${GATE_DEFS}" || {
    echo "extraction lost the detector from ${HOOK_SH}" >&2
    return 1
  }
  run probe "const x = 1;"
  [[ "${output}" == "silent" ]] || {
    echo "probe harness broken: ${output}" >&2
    return 1
  }
}

# The three rows the predicate CHOICE turns on, each pinning one decision.
@test "completion-channel(turning points): masked operand, bare-word match, value exclusion" {
  local fails=""
  # Anchor operand: masked. A colon after the word inside a goal string is not a site.
  check silent "prose-with-colon" \
    "agent('x', { goal: 'fill the schema: use the fields' });" || fails="${fails} prose-with-colon"
  # Match shape: bare word. A colon test would lose the shorthand the exemplar uses.
  check ADVISE "shorthand" \
    "const r = await agent('x', { ...opts, schema });" || fails="${fails} shorthand"
  # Value exclusion: the recommended text-mode fallback explicitly DISABLES schema mode.
  check silent "fallback-undefined" \
    "await agent(opts.goal, { ...opts, agentType, schema: undefined }).catch(() => null);" ||
    fails="${fails} fallback-undefined"
  [[ -z "${fails}" ]] || {
    echo "turning-point rows failed:${fails}" >&2
    return 1
  }
}

# VALUE EXCLUSION BY SHAPE, both edges. The excluded set is the CLOSED set of absent-value denotations
# the language provides, so `void` is admitted as an OPERATOR (every operand yields undefined) rather
# than as the one spelling seen in the wild. The guard rows are the other edge and matter more than the
# admissions: a merely falsy value is NOT absence, and an identifier that merely starts with `void`
# must not be swallowed by the alternation.
@test "completion-channel(absent values): the void operator excludes, falsy and near-miss names do not" {
  local fails=""
  check silent "void-zero" \
    "await agent('x', { ...opts, agentType, schema: void 0 });" || fails="${fails} void-zero"
  check silent "void-paren" \
    "await agent('x', { ...opts, schema: void(0) });" || fails="${fails} void-paren"
  check silent "void-operand-identifier" \
    "await agent('x', { schema: void x });" || fails="${fails} void-operand-identifier"
  check silent "void-spaced-colon" \
    "await agent('x', { schema : void 0 });" || fails="${fails} void-spaced-colon"
  # Boundary: falsy is not absent. Excluding these would trade a named FP for an unnamed FN.
  check ADVISE "falsy-zero" \
    "await agent('x', { schema: 0 });" || fails="${fails} falsy-zero"
  # Boundary: the trailing lookahead. `voidness` is an identifier, not the operator.
  check ADVISE "void-prefixed-identifier" \
    "const voidness = S; await agent('x', { schema: voidness });" ||
    fails="${fails} void-prefixed-identifier"
  check ADVISE "null-prefixed-identifier" \
    "await agent('x', { schema: nullish });" || fails="${fails} null-prefixed-identifier"
  [[ -z "${fails}" ]] || {
    echo "absent-value rows failed:${fails}" >&2
    return 1
  }
}

@test "completion-channel(sites): key, shorthand and non-site shapes classify as observed" {
  local fails=""
  check ADVISE "bare-key" \
    "const r = await agent('x', { schema: S });" || fails="${fails} bare-key"
  check ADVISE "shorthand-further-keys" \
    "const r = await agent('x', { ...opts, schema, effort: 'medium' });" ||
    fails="${fails} shorthand-further-keys"
  check silent "quoted-key" \
    "const r = await agent('x', { 'schema': S });" || fails="${fails} quoted-key"
  check silent "null-value" \
    "await agent('x', { schema: null });" || fails="${fails} null-value"
  check silent "prose-word-alone" \
    "agent('x', { goal: 'return a schema for review' });" || fails="${fails} prose-word-alone"
  check silent "word-in-comment" \
    "// schema goes here
agent('x', { goal: 'g' });" || fails="${fails} word-in-comment"
  [[ -z "${fails}" ]] || {
    echo "site rows failed:${fails}" >&2
    return 1
  }
}

# The published false positives are pinned rather than left to be rediscovered at promotion, because
# this list is what a promotion decision adjudicates against. A row flipping to silent means an
# exclusion widened and the design changed. Each row was decided by RUNNING its candidate exclusion:
#   member access  → the exclusion is UNSOUND (see the paired row below).
#   bind forms     → the exclusion is INERT (see the paired use rows below).
#   regex literal  → a lexical-class limit of the shared string mask, not a value one.
@test "completion-channel(residuals): every published false-positive shape stays a site" {
  local fails=""
  check ADVISE "guard-off-options" \
    "if (opts.schema) { run(); }" || fails="${fails} guard-off-options"
  check ADVISE "assignment-to-undefined" \
    "const schema = undefined;" || fails="${fails} assignment-to-undefined"
  check ADVISE "import-binding" \
    "import { schema } from './x';" || fails="${fails} import-binding"
  check ADVISE "destructuring-bind" \
    "const { schema } = opts;" || fails="${fails} destructuring-bind"
  check ADVISE "function-param" \
    "function build(schema) { return schema; }" || fails="${fails} function-param"
  check ADVISE "arrow-param" \
    "const build = (schema) => schema;" || fails="${fails} arrow-param"
  check ADVISE "regex-literal" \
    "const re = /schema/; run(re);" || fails="${fails} regex-literal"
  [[ -z "${fails}" ]] || {
    echo "residual rows failed:${fails}" >&2
    return 1
  }
}

# WHY THOSE RESIDUALS ARE NOT EXCLUDED — the rows that make the published reasons falsifiable rather
# than assertions. A member-access exclusion would blank the first row here, which is a REAL schema-mode
# configuration; the bind exclusions would be inert, because the USE of what they bind is itself a site.
@test "completion-channel(residuals): the reasons for keeping them are themselves pinned" {
  local fails=""
  # UNSOUND: the only occurrence is dot-preceded, yet this genuinely configures schema mode.
  check ADVISE "member-write-is-a-real-site" \
    "opts.schema = S;
await agent('x', opts);" || fails="${fails} member-write-is-a-real-site"
  # INERT: each bind is used at a spawn, and the use fires on its own.
  check ADVISE "import-then-use" \
    "import { schema } from './x';
await agent('x', { ...opts, schema });" || fails="${fails} import-then-use"
  check ADVISE "destructure-then-use" \
    "const { schema } = opts;
await agent('x', { schema });" || fails="${fails} destructure-then-use"
  check ADVISE "param-then-use" \
    "function mk(schema) { return agent('x', { schema }); }" || fails="${fails} param-then-use"
  [[ -z "${fails}" ]] || {
    echo "residual-reason rows failed:${fails}" >&2
    return 1
  }
}

# Token half — the opposite polarity. Unmasked so a quoted or prose occurrence suppresses;
# comment-stripped so a commented one does not.
@test "completion-channel(token): unmasked suppresses, comment-only does not" {
  local fails=""
  check silent "token-declared" \
    "const S = { properties: { completion_block: { type: 'string' } } };
agent('x', { schema: S });" || fails="${fails} token-declared"
  check silent "token-prose-in-goal" \
    "agent('x', { schema: S, goal: 'put the block into completion_block' });" ||
    fails="${fails} token-prose-in-goal"
  check ADVISE "token-comment-only" \
    "// fill completion_block
agent('x', { schema: S });" || fails="${fails} token-comment-only"
  [[ -z "${fails}" ]] || {
    echo "token rows failed:${fails}" >&2
    return 1
  }
}

# ── the per-site gap: the shape one compliant site hides from every script-wide read ────────────────
#
# FROZEN OBSERVATION for completion_per_site_advisory_needed (produced by RUNNING it over these exact
# rows). ADVISE = one site declares the reserved property and another omits it.
#   one inline compliant + one inline bare  ->  ADVISE   (the criterion)
#   both inline compliant                   ->  silent
#   both inline bare                        ->  silent   (the script-wide value owns that shape)
#   both bound to a named constant          ->  silent   (no inline span -> skipped, not judged)
#   compliant inline + object shorthand     ->  silent   (shorthand has no span either)
#   quoted property key inside the span     ->  ADVISE   (token half unmasked -> recall, as compliant)
#   inline spreading a base that declares   ->  ADVISE   (published false positive: the span holds a
#                                                         reference, not the property)
@test "per-site(criterion): one compliant and one bare site fires; either uniform script does not" {
  local fails=""
  check ADVISE "one-compliant-one-bare" \
    "agent('a', { goal: 'x', schema: { properties: { completion_block: { type: 'string' } } } });
agent('b', { goal: 'y', schema: { properties: { verdict: { type: 'string' } } } });" \
    completion_per_site_advisory_needed || fails="${fails} one-compliant-one-bare"
  check silent "both-compliant" \
    "agent('a', { schema: { properties: { completion_block: { type: 'string' } } } });
agent('b', { schema: { properties: { completion_block: { type: 'string' } } } });" \
    completion_per_site_advisory_needed || fails="${fails} both-compliant"
  check silent "both-bare" \
    "agent('a', { schema: { properties: { findings: { type: 'string' } } } });
agent('b', { schema: { properties: { verdict: { type: 'string' } } } });" \
    completion_per_site_advisory_needed || fails="${fails} both-bare"
  # DISJOINTNESS, the property that lets ONE line carry ONE value: the script-wide predicate is silent
  # on the very fixture the per-site one fires for, because a single declaration satisfies its token
  # half. Asserted rather than argued, since the multiplexed contract rests on it.
  check silent "script-wide-silent-on-the-gap" \
    "agent('a', { goal: 'x', schema: { properties: { completion_block: { type: 'string' } } } });
agent('b', { goal: 'y', schema: { properties: { verdict: { type: 'string' } } } });" \
    completion_block_advisory_needed || fails="${fails} script-wide-silent-on-the-gap"
  [[ -z "${fails}" ]] || {
    echo "per-site criterion rows failed:${fails}" >&2
    return 1
  }
}

# ADJUDICABLE SITES ONLY — the narrowing that keeps the per-site read sound, pinned from both ends: the
# skipped shapes stay silent, and the one shape whose span really does answer the question still fires.
@test "per-site(scope): sites with no inline span are skipped, and the span reads unmasked" {
  local fails=""
  check silent "const-bound-pair" \
    "const S = { properties: { completion_block: { type: 'string' } } };
agent('a', { schema: S });
agent('b', { schema: S });" \
    completion_per_site_advisory_needed || fails="${fails} const-bound-pair"
  check silent "shorthand-alongside-compliant" \
    "agent('a', { schema: { properties: { completion_block: { type: 'string' } } } });
agent('b', { ...opts, schema });" \
    completion_per_site_advisory_needed || fails="${fails} shorthand-alongside-compliant"
  # Token half inside the span keeps the sibling polarity: a QUOTED key counts as compliant, so this
  # fires. Were the span read masked instead, the quoted key would blank and the row would go silent.
  check ADVISE "quoted-key-is-compliant" \
    "agent('a', { schema: { properties: { 'completion_block': { type: 'string' } } } });
agent('b', { schema: { properties: { verdict: { type: 'string' } } } });" \
    completion_per_site_advisory_needed || fails="${fails} quoted-key-is-compliant"
  # PUBLISHED FALSE POSITIVE, pinned rather than left to be rediscovered: the spread is a reference, so
  # the property is not in the span and the site reads bare.
  check ADVISE "spread-base-reads-bare" \
    "const base = { completion_block: { type: 'string' } };
agent('a', { schema: { ...base, findings: { type: 'string' } } });
agent('b', { schema: { properties: { completion_block: { type: 'string' } } } });" \
    completion_per_site_advisory_needed || fails="${fails} spread-base-reads-bare"
  [[ -z "${fails}" ]] || {
    echo "per-site scope rows failed:${fails}" >&2
    return 1
  }
}

# FALSE-POSITIVE FLOOR — the copy-verbatim authoring skeletons are the shapes an author pastes, so a
# firing on one of them is a false block waiting to happen.
@test "completion-channel(floor): no skill JS skeleton fires the detector" {
  [[ -f "${SKILL_MD}" ]] || skip "skill file not found: ${SKILL_MD}"
  local outdir="${BATS_TEST_TMPDIR}/skill-fences"
  mkdir -p "${outdir}"
  awk -v dir="${outdir}" '
    /^[[:space:]]*```js/ { infence = 1; buf = ""; next }
    /^[[:space:]]*```[[:space:]]*$/ {
      if (infence) { n++; f = dir "/fence_" n ".js"; printf "%s", buf > f; close(f); infence = 0 }
      next
    }
    infence { buf = buf $0 "\n" }
  ' "${SKILL_MD}"
  local fails="" fence name body
  # Absence of a fence is itself a failure: a floor over nothing is vacuous green.
  [[ -f "${outdir}/fence_1.js" ]] || {
    echo "harvested no js fence from ${SKILL_MD}" >&2
    return 1
  }
  # Both values on the line share this floor: a paste of a canonical skeleton must nudge on neither,
  # since the author cannot tell which value produced the stderr they are reading.
  for fence in "${outdir}"/fence_*.js; do
    name="${fence##*/}"
    body="$(cat "${fence}")"
    check silent "${name}" "${body}" || fails="${fails} ${name}"
    check silent "${name}:per-site" "${body}" completion_per_site_advisory_needed ||
      fails="${fails} ${name}:per-site"
  done
  [[ -z "${fails}" ]] || {
    echo "FALSE POSITIVE on skill skeletons:${fails}" >&2
    return 1
  }
}

# Verdict isolation is the blocking requirement: the scan owns its failure so it can never reach the
# module handler whose recovery path emits PASS. ALL THREE predicates are asserted from one injection —
# they share the masker, so one raising import breaks whichever of them lacks its own terminal handler.
# Each fixture is chosen to reach the masker: the per-site one carries the token, without which it would
# return early and pass the row vacuously, and the schema-absent one carries a schema, without which its
# shared site test returns before masking anything.
@test "completion-channel(isolation): a raising scan returns false rather than propagating" {
  run python3 - "${GATE_DEFS}" <<'PYX'
import sys
import importlib.util

spec = importlib.util.spec_from_file_location("gate_defs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def boom(_src):
    raise RuntimeError("injected scan failure")


mod._string_mask = boom
per_site_src = "agent({ schema: { completion_block: 'string' } }); agent({ schema: {} });"
absent_src = "agent('glass-atrium-intel-researcher', { schema: S });"
leaked = (
    mod.completion_block_advisory_needed("const r = agent({ schema: S });") is not False
    or mod.completion_per_site_advisory_needed(per_site_src) is not False
    or mod.completion_schema_absent_advisory_needed(absent_src, False, ["glass-atrium-dev-shell"]) is not False
)
print("LEAKED" if leaked else "silent")
PYX
  [[ "${status}" -eq 0 && "${output}" == "silent" ]] || {
    echo "isolation broken: status=${status} output=${output}" >&2
    return 1
  }
}

# ── the wiring: the multiplexed advisory line, its trace value, and the precedence split ────────────

# SEAM PRESENCE PIN (source-structural). A black-box fixture cannot see a stale fail-open literal: the
# reads are pre-seeded to their silent defaults and the read group swallows EOF, so a nine-token literal
# and a ten-token one are byte-identical in observable behaviour. The DERIVED-EQUALITY arity assertion
# lives in the sibling declaration-contract suite and re-derives on its own across a tenth line, so it
# is deliberately not duplicated here — only the name-specific presence of the new token is owed.
@test "completion-channel(seam): the fail-open fallback literal carries the silent token" {
  local literal_line
  literal_line="$(grep -F "helper_out=\$'PASS" "${HOOK_SH}")"
  [[ "${literal_line}" == *"COMPLETION_SILENT"* ]] || {
    echo "SEAM: fail-open fallback literal lacks COMPLETION_SILENT: ${literal_line}" >&2
    return 1
  }
}

@test "completion-channel(wiring): a site with the property absent nudges, exits 0, and traces its value" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "${SCHEMA_SITE}"
  [[ "${status}" -eq 0 ]] || {
    echo "an advisory must never alter the exit code, got ${status}" >&2
    return 1
  }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || {
    echo "no nudge -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" == *"completion-channel:property-absent"* ]] || {
    echo "value not traced: $(last_advisory)" >&2
    return 1
  }
}

@test "completion-channel(wiring): the declared property silences the nudge and the tag" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "const S = { completion_block: 'string' };
const r = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: S });"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || {
    echo "nudged despite the declared property -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" != *"completion-channel"* ]] || {
    echo "tagged despite the declared property: $(last_advisory)" >&2
    return 1
  }
}

# PRECEDENCE SPLIT — a DEV script blocked BEFORE the terminal emit carries no tag (the block is the
# louder signal), while one blocked AT the terminal emit carries it. The counterfactual is what proves
# the advisory decides nothing: the same script with the property declared blocks identically.
@test "completion-channel(precedence): a DEV script blocked before the terminal emit carries no tag" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "const s = { schema: {} };
agent('glass-atrium-dev-shell', { goal: 'x' });"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"missing composition declaration"* ]] || return 1
  [[ "$(last_advisory)" != *"completion-channel"* ]] || {
    echo "pre-empted block still tagged: $(last_advisory)" >&2
    return 1
  }
}

@test "completion-channel(precedence): a terminal-emit block keeps its exit with and without the nudge" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "${DECL_TEAM}
${SCHEMA_SITE}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"size-attestation miss"* ]] || return 1
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || {
    echo "the nudge must ride a terminal-emit block -- ${output}" >&2
    return 1
  }
  # Counterfactual: property declared → same verdict, same exit, no nudge → the advisory decided nothing.
  run_hook_exec "${DECL_TEAM}
const S = { completion_block: 'string' };
const r = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: S });"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"size-attestation miss"* ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || {
    echo "nudged despite the declared property -- ${output}" >&2
    return 1
  }
}

# The DEV TERMINAL PASS arm — the fourth quadrant of the precedence split, and the one the other rows
# cannot reach: the rows above exercise non-DEV PASS and DEV BLOCK, so without this one nothing pins
# that the tag survives the arm where the gate returns 0 for a DEV script. The [SIZE-EST] token is
# inlined rather than kept as a fixture: this is its only use, and clearing the size gate is the whole
# reason the script reaches the terminal PASS at all.
@test "completion-channel(precedence): a DEV script passing at the terminal emit still nudges and tags" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "${DECL_TEAM}
log('[SIZE-EST] bundles=1 tool_uses~=10 — small.')
${SCHEMA_SITE}"
  [[ "${status}" -eq 0 ]] || {
    echo "the DEV script must PASS here, got ${status} -- ${output}" >&2
    return 1
  }
  [[ "${output}" == *"${NUDGE_PHRASE}"* ]] || {
    echo "no nudge on the DEV PASS arm -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" == *"completion-channel:property-absent"* ]] || {
    echo "value not traced on the DEV PASS arm: $(last_advisory)" >&2
    return 1
  }
  # Counterfactual: same script, property declared → same PASS, no nudge, no tag.
  run_hook_exec "${DECL_TEAM}
log('[SIZE-EST] bundles=1 tool_uses~=10 — small.')
const S = { completion_block: 'string' };
const r = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: S });"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || {
    echo "nudged despite the declared property on the PASS arm -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" != *"completion-channel"* ]] || {
    echo "tagged despite the declared property on the PASS arm: $(last_advisory)" >&2
    return 1
  }
}

# The per-site value end to end: it reaches stderr as its OWN message, records its OWN trace
# value, and leaves the exit code alone. The two nudges are asserted apart rather than by a shared
# prefix, because a value that printed the sibling message would be indistinguishable to the author.
@test "per-site(wiring): a masked bare site nudges with its own message, traces its value, exits 0" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "const a = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: { properties: { completion_block: { type: 'string' } } } });
const b = await agent('glass-atrium-intel-planner', { goal: 'plan', schema: { properties: { verdict: { type: 'string' } } } });"
  [[ "${status}" -eq 0 ]] || {
    echo "an advisory must never alter the exit code, got ${status}" >&2
    return 1
  }
  [[ "${output}" == *"ADVISORY (completion channel per-site, non-blocking)"* ]] || {
    echo "no per-site nudge -- ${output}" >&2
    return 1
  }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || {
    echo "the script-wide message fired too; one line carries one value -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" == *"completion-channel:per-site-gap"* ]] || {
    echo "value not traced: $(last_advisory)" >&2
    return 1
  }
  # Counterfactual: declare the property on the second site too → same PASS, neither nudge, no tag.
  run_hook_exec "const a = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: { properties: { completion_block: { type: 'string' } } } });
const b = await agent('glass-atrium-intel-planner', { goal: 'plan', schema: { properties: { completion_block: { type: 'string' } } } });"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ADVISORY (completion channel"* ]] || {
    echo "nudged despite the property on every site -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" != *"completion-channel"* ]] || {
    echo "tagged despite the property on every site: $(last_advisory)" >&2
    return 1
  }
}

# ── schema absent: the measured incident shape, which neither sibling value can reach ───────────────
#
# FROZEN OBSERVATION for completion_schema_absent_advisory_needed (produced by RUNNING it over these
# exact rows). ADVISE = an analysis-class non-DEV spawn in a script with no schema-mode site anywhere.
#   analysis spawn, no schema anywhere      ->  ADVISE   (the criterion — the dropped-schema shape)
#   the agentType spawn form                ->  ADVISE   (the roster reads both spawn positions)
#   text-mode fallback (schema: undefined)  ->  ADVISE   (an absent VALUE is not a site; the accepted
#                                                         over-nudge, since the deliverable may be prose)
#   any real schema in the script           ->  silent
#   a DEV literal present                   ->  silent   (its verify-stage is deliberately text-mode)
#   only a dev_set member spawns            ->  silent   (roster is non-DEV BY EXCLUSION)
#   no spawn literal at all                 ->  silent
#
# The predicate takes the DEV context as arguments, so these rows are driven directly rather than
# through the single-argument probe harness the sibling values share.
@test "schema-absent(criterion): fires only on a non-DEV analysis spawn with no site anywhere" {
  run python3 - "${GATE_DEFS}" <<'PYX'
import sys
import importlib.util

spec = importlib.util.spec_from_file_location("gate_defs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

DEV = ["glass-atrium-dev-nestjs", "glass-atrium-dev-shell"]
ANALYSIS = "const r = await agent('glass-atrium-intel-researcher', { goal: 'survey' });"

rows = [
    ("analysis-spawn-no-schema", ANALYSIS, False, True),
    ("agentType-spawn-form", "await agent('x', { agentType: 'glass-atrium-intel-planner' });", False, True),
    ("text-mode-fallback-value", "await agent('glass-atrium-intel-reporter', { schema: undefined });", False, True),
    ("real-schema-silences", ANALYSIS + " const S = { schema: { findings: 'string' } };", False, False),
    ("dev-present-silences", ANALYSIS + " agent('glass-atrium-dev-nestjs', { goal: 'build' });", True, False),
    ("dev-only-spawn-silences", "await agent('glass-atrium-dev-shell', { goal: 'build' });", False, False),
    ("no-spawn-silences", "log('nothing is spawned here');", False, False),
]

fails = []
for label, src, dev_present, expected in rows:
    got = mod.completion_schema_absent_advisory_needed(
        mod.strip_comments(src), dev_present, DEV)
    if got is not expected:
        fails.append("%s: expected %s, observed %s" % (label, expected, got))

# DISJOINTNESS, the property that lets ONE line carry ONE value: on the very fixture this value fires
# for, BOTH siblings are silent — they require a site to exist and this one requires that none does.
# Asserted rather than argued, since the multiplexed contract rests on it.
gap = mod.strip_comments(ANALYSIS)
if mod.completion_block_advisory_needed(gap) is not False:
    fails.append("disjointness: the script-wide value fired on the no-site fixture")
if mod.completion_per_site_advisory_needed(gap) is not False:
    fails.append("disjointness: the per-site value fired on the no-site fixture")

print("OK" if not fails else "; ".join(fails))
PYX
  [[ "${status}" -eq 0 && "${output}" == "OK" ]] || {
    echo "schema-absent rows failed: status=${status} ${output}" >&2
    return 1
  }
}

# FALSE-POSITIVE FLOOR, driven END TO END rather than at the predicate: this value reads the DEV
# context the module dispatch computes, so a predicate-level row would assert a hand-supplied
# classification instead of the hook's own. Each canonical skeleton is run through the gate as an
# author would paste it.
@test "schema-absent(floor): no skill JS skeleton fires the nudge" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  [[ -f "${SKILL_MD}" ]] || skip "skill file not found: ${SKILL_MD}"
  local outdir="${BATS_TEST_TMPDIR}/absent-fences"
  mkdir -p "${outdir}"
  awk -v dir="${outdir}" '
    /^[[:space:]]*```js/ { infence = 1; buf = ""; next }
    /^[[:space:]]*```[[:space:]]*$/ {
      if (infence) { n++; f = dir "/fence_" n ".js"; printf "%s", buf > f; close(f); infence = 0 }
      next
    }
    infence { buf = buf $0 "\n" }
  ' "${SKILL_MD}"
  local fails="" fence name
  # Absence of a fence is itself a failure: a floor over nothing is vacuous green.
  [[ -f "${outdir}/fence_1.js" ]] || {
    echo "harvested no js fence from ${SKILL_MD}" >&2
    return 1
  }
  for fence in "${outdir}"/fence_*.js; do
    name="${fence##*/}"
    run_hook_exec "$(cat "${fence}")"
    [[ "${output}" != *"${ABSENT_PHRASE}"* ]] || fails="${fails} ${name}"
  done
  [[ -z "${fails}" ]] || {
    echo "FALSE POSITIVE on skill skeletons:${fails}" >&2
    return 1
  }
}

# The schema-absent value end to end: its OWN message reaches stderr, its OWN trace value records, and
# the exit code is untouched. The three nudges are asserted apart rather than by a shared prefix,
# because a value printing a sibling message would be indistinguishable to the author reading stderr.
@test "schema-absent(wiring): a spawn with no schema nudges, traces its value, exits 0" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "const r = await agent('glass-atrium-intel-researcher', { goal: 'survey the landscape' });"
  [[ "${status}" -eq 0 ]] || {
    echo "an advisory must never alter the exit code, got ${status}" >&2
    return 1
  }
  [[ "${output}" == *"${ABSENT_PHRASE}"* ]] || {
    echo "no schema-absent nudge -- ${output}" >&2
    return 1
  }
  [[ "${output}" == *"16-25% depending on the window"* ]] || {
    echo "the measured justification is missing from the nudge -- ${output}" >&2
    return 1
  }
  [[ "${output}" != *"${NUDGE_PHRASE}"* ]] || {
    echo "the script-wide message fired too; one line carries one value -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" == *"completion-channel:schema-absent"* ]] || {
    echo "value not traced: $(last_advisory)" >&2
    return 1
  }
  # Counterfactual: declare a schema carrying the property → same PASS, no nudge, no tag.
  run_hook_exec "const r = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: { properties: { completion_block: { type: 'string' } } } });"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ADVISORY (completion channel"* ]] || {
    echo "nudged despite a declared schema -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" != *"completion-channel"* ]] || {
    echo "tagged despite a declared schema: $(last_advisory)" >&2
    return 1
  }
}

# The DEV exclusion, end to end: a canonical DEV workflow carries a reviewer verify-stage that is
# deliberately text-mode and declares no schema, which is precisely the shape that must NOT nudge.
@test "schema-absent(dev): a passing DEV workflow with no schema stays silent and exits 0" {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  run_hook_exec "${DECL_TEAM}
log('[SIZE-EST] bundles=1 tool_uses~=8 — small')"
  [[ "${status}" -eq 0 ]] || {
    echo "expected a passing DEV workflow, got ${status} -- ${output}" >&2
    return 1
  }
  [[ "${output}" != *"${ABSENT_PHRASE}"* ]] || {
    echo "nudged a DEV workflow -- ${output}" >&2
    return 1
  }
  [[ "$(last_advisory)" != *"completion-channel"* ]] || {
    echo "tagged a DEV workflow: $(last_advisory)" >&2
    return 1
  }
}
