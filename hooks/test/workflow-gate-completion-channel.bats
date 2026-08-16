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
#   prose: word followed by a colon       ->  silent    (masked anchor operand)
#   prose: word alone                     ->  silent
#   word only inside a line comment       ->  silent
#   RESIDUAL guard off an options object  ->  ADVISE    (named false positive, key-position exclusion)
#   RESIDUAL assignment to undefined      ->  ADVISE    (named false positive, same cause)
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
src = sys.stdin.read()
print("ADVISE" if mod.completion_block_advisory_needed(mod.strip_comments(src)) else "silent")
PYX
}

# probe SRC — the predicate verdict for one JS source, as ADVISE or silent. Source arrives on stdin so
# no shell quoting can reshape a fixture.
probe() {
  printf '%s' "${1}" | python3 "${PROBE_PY}" "${GATE_DEFS}" 2>&1
}

# check EXPECTED LABEL SRC — non-zero on mismatch, with the observed value named.
check() {
  local expected="${1}" label="${2}" observed
  observed="$(probe "${3}")"
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

# The two false positives are DOCUMENTED, so they are pinned rather than left to be rediscovered at
# promotion. A row flipping to silent means the key-position exclusion widened and the design changed.
@test "completion-channel(residuals): non-key-position occurrences stay sites" {
  local fails=""
  check ADVISE "guard-off-options" \
    "if (opts.schema) { run(); }" || fails="${fails} guard-off-options"
  check ADVISE "assignment-to-undefined" \
    "const schema = undefined;" || fails="${fails} assignment-to-undefined"
  [[ -z "${fails}" ]] || {
    echo "residual rows failed:${fails}" >&2
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
  for fence in "${outdir}"/fence_*.js; do
    name="${fence##*/}"
    body="$(cat "${fence}")"
    check silent "${name}" "${body}" || fails="${fails} ${name}"
  done
  [[ -z "${fails}" ]] || {
    echo "FALSE POSITIVE on skill skeletons:${fails}" >&2
    return 1
  }
}

# Verdict isolation is the blocking requirement: the scan owns its failure so it can never reach the
# module handler whose recovery path emits PASS.
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
print("silent" if mod.completion_block_advisory_needed("const r = agent({ schema: S });") is False else "LEAKED")
PYX
  [[ "${status}" -eq 0 && "${output}" == "silent" ]] || {
    echo "isolation broken: status=${status} output=${output}" >&2
    return 1
  }
}
