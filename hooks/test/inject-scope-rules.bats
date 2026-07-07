#!/usr/bin/env bats
# inject-scope-rules.bats — Bats suite for the SubagentStart inject-scope-rules.sh runtime path.
#   This covers the HOOK's runtime injection (test_inject_sync.py covers only the reconcile tooling
#   that maintains the 3 auto-synced arrays — it does NOT exercise the hook). Focus = the 4th
#   injected block (AGENT-INJECT:NAMING) wired in for DEV(12, excluding dev-swift) + qa-code-reviewer.
#
# Input is the real SubagentStart envelope parsed by the hook: {"agent_type":"<type>"} (read via
#   hook_get_field). Built with jq so the field is escaped safely.
# Env sandbox: AGENTS_DIR → /nonexistent (no maxTurns lookup) and SUBAGENT_BUDGET_METER_OFF=1 so the
#   universal budget-meter block is suppressed — this isolates the scope-block assertions (the meter
#   is agent-agnostic and would otherwise add noise to every run). The 3 OTHER scope sources
#   (comment-logging / style_ref / minimalism) are pointed at /nonexistent by DEFAULT so a "naming
#   present" assertion proves the naming block specifically, not an accidental match in a sibling
#   block. The naming source defaults to a HERMETIC in-sandbox fixture built in setup() (NOT the
#   HOME-anchored real SKILL.md, which is absent under a CI checkout) unless a test overrides it.
#
# BATS GATING NOTE: this bats version runs @test bodies WITHOUT `set -e`, so only the LAST command
#   gates pass/fail — a non-final failing `[[ ]]` is silently ignored. Every assertion below is
#   guarded with a helper that `return 1`s on mismatch, so EACH one independently fails the test.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/inject-scope-rules.sh"

# The marker string the naming block is uniquely identified by (its first line in the SKILL.md core).
NAMING_NEEDLE="Naming delta-core"

# The always-on [COMPLETION] emit-format directive needle — a stable, bracket-free substring unique
# to the emit block (must NOT collide with the meter / comment / naming needles). This block is
# delivered to EVERY agent_type independent of SUBAGENT_BUDGET_METER_OFF and of maxTurns (the PRIMARY
# fix for schema-mode/workflow subagents emitting the inline single-line [COMPLETION] form).
EMIT_NEEDLE="REQUIRED by the outcome recorder"

# The NAMING block markers the hermetic fixture must carry (mirror hooks/inject-scope-rules.sh anchors).
NAMING_MARKER_START='<!-- AGENT-INJECT:NAMING:START -->'
NAMING_MARKER_END='<!-- AGENT-INJECT:NAMING:END -->'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "inject-scope-rules.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"

  # Hermetic NAMING source fixture — the hook's default naming source is the HOME-anchored real
  # SKILL.md (${HOME}/.claude/skills/...), absent in a CI checkout → the naming block would be
  # empty and the positive-injection assertions would falsely fail. Build a self-contained fixture
  # carrying the NAMING markers + the NAMING_NEEDLE first line, and point run_hook at it by DEFAULT.
  # Tests that deliberately pass their own naming_src (fail-open cases) still override this.
  NAMING_FIXTURE="${BATS_TEST_TMPDIR}/naming-skill.md"
  printf '%s\n' \
    'skill preamble (must not reach the child)' \
    "${NAMING_MARKER_START}" \
    "**${NAMING_NEEDLE} (auto-injected for DEV + qa-code-reviewer)**" \
    'NAMING-CORE-BODY' \
    "${NAMING_MARKER_END}" \
    'skill trailer (must not reach the child)' >"${NAMING_FIXTURE}"
}

# Drive the hook with a SubagentStart envelope wrapping $1 (agent_type). The 3 non-naming scope
# sources + AGENTS_DIR are sandboxed to /nonexistent and the meter is off, isolating the naming
# block. The naming source defaults to the hermetic fixture built in setup() (so the positive
# assertions do not depend on the HOME-anchored real SKILL.md, absent in CI); $2 (optional)
# overrides INJECT_SCOPE_RULES_NAMING_SRC for the fail-open / absent-marker tests.
run_hook() {
  local agent="${1}" naming_src="${2:-${NAMING_FIXTURE}}"
  run bash -c '
    agent="$1"; hook="$2"; naming_src="$3"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    env_naming=()
    if [[ -n "${naming_src}" ]]; then
      env_naming=(INJECT_SCOPE_RULES_NAMING_SRC="${naming_src}")
    fi
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC=/nonexistent \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      "${env_naming[@]}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${naming_src}"
}

# Extract the additionalContext string from the hook's JSON stdout (empty if no JSON emitted).
# Operates on $output (bats merges stdout+stderr, but the only JSON line is the hook's stdout).
ctx_of() {
  printf '%s' "${output}" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except ValueError:
        continue
    print(d.get("hookSpecificOutput", {}).get("additionalContext", ""))
    break
' 2>/dev/null
}

# --- Per-assertion gate helpers (the bats body is NOT under set -e — see header note). ---
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    echo "expected status ${1}, got ${status} (output: ${output})" >&2
    return 1
  }
}
assert_ctx_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" == *"${1}"* ]] || {
    echo "expected additionalContext to contain [${1}], got: [${ctx}]" >&2
    return 1
  }
}
assert_ctx_not_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" != *"${1}"* ]] || {
    echo "expected additionalContext to NOT contain [${1}], got: [${ctx}]" >&2
    return 1
  }
}

# --- (a) a NAMING_AGENTS DEV member (dev-react) receives the naming block ---

@test "dev-react (NAMING_AGENTS member) → naming block injected, exit 0" {
  run_hook "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${NAMING_NEEDLE}"
}

@test "dev-shell (NAMING_AGENTS member) → naming block injected, exit 0" {
  run_hook "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_contains "${NAMING_NEEDLE}"
}

# --- (b) qa-code-reviewer (the QA enforcement surface) receives the naming block ---

@test "qa-code-reviewer (NAMING_AGENTS member) → naming block injected, exit 0" {
  run_hook "glass-atrium-qa-code-reviewer"
  assert_status 0
  assert_ctx_contains "${NAMING_NEEDLE}"
}

# --- (c) qa-debugger AND dev-swift do NOT receive it (deliberately absent from NAMING_AGENTS) ---

@test "qa-debugger (NOT in NAMING_AGENTS) → no naming block, exit 0" {
  run_hook "glass-atrium-qa-debugger"
  assert_status 0
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

@test "dev-swift (NOT in NAMING_AGENTS) → no naming block, exit 0" {
  run_hook "glass-atrium-dev-swift"
  assert_status 0
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

# Even with every scope source sandboxed to /nonexistent AND the meter off, the ALWAYS-ON emit-format
# directive is still delivered — so JSON IS emitted (the directive is the one universally-present
# block, independent of every scope source and of the meter). This is the R3 delivery-hole guard.
@test "qa-debugger with all scope sources absent + meter off → emit directive still delivered, JSON emitted (exit 0)" {
  run_hook "glass-atrium-qa-debugger"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

# --- (d) fail-open: naming markers absent → no hard error, naming block omitted, OTHER blocks emit ---

@test "naming markers absent → fail-open exit 0, naming omitted, comment-logging block still emits" {
  # A naming source WITHOUT the NAMING markers + a comment-logging source WITH its block.
  naming_src="${BATS_TEST_TMPDIR}/naming-no-markers.md"
  printf 'no naming markers here\n' >"${naming_src}"
  comment_src="${BATS_TEST_TMPDIR}/comment.md"
  printf '%s\n' \
    'intro' \
    '<!-- AGENT-INJECT:START -->' \
    'COMMENT-LOGGING-CORE-BODY' \
    '<!-- AGENT-INJECT:END -->' \
    'outro' >"${comment_src}"

  run bash -c '
    agent="$1"; hook="$2"; naming_src="$3"; comment_src="$4"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC="${comment_src}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC="${naming_src}" \
      bash "${hook}"
  ' _ "glass-atrium-dev-react" "${HOOK_SH}" "${naming_src}" "${comment_src}"

  assert_status 0
  assert_ctx_contains "COMMENT-LOGGING-CORE-BODY"
  assert_ctx_not_contains "${NAMING_NEEDLE}"
  # The fail-open path emits a single stderr diagnostic naming the empty source (bats merges it).
  [[ "${output}" == *"naming block empty or markers absent"* ]] || {
    echo "expected naming fail-open stderr diagnostic, got: ${output}" >&2
    return 1
  }
}

@test "naming source file absent entirely → fail-open exit 0, naming omitted, no hard error" {
  run_hook "glass-atrium-dev-react" "/nonexistent/naming.md"
  assert_status 0
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

# --- (d2) always-on [COMPLETION] emit-format directive (PRIMARY emit-side fix, T2/T3). ---
# The directive is delivered to EVERY agent independent of SUBAGENT_BUDGET_METER_OFF and of maxTurns,
# and is ordered before the four droppable scope blocks so it survives the ~2KB persistence preview.
# These assertions key on the 8192-byte ceiling and directive-first ordering, NOT on the 2KB preview.

# Drive the hook with the meter ENABLED (kill-switch explicitly unset) but AGENTS_DIR absent, so
# read_max_turns returns empty → METER_BLOCK is empty. All scope sources absent. This isolates the
# emit directive as the sole delivered block and proves it is INDEPENDENT of maxTurns (empty meter).
run_hook_no_meter() {
  local agent="${1}"
  run bash -c '
    agent="$1"; hook="$2"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u SUBAGENT_BUDGET_METER_OFF \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_SRC=/nonexistent \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}"
}

# Assert the assembled additionalContext is at most $1 bytes (byte-accurate via wc -c).
assert_ctx_max_bytes() {
  local ctx nbytes
  ctx="$(ctx_of)"
  nbytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ "${nbytes}" -le "${1}" ]] || {
    echo "expected additionalContext <= ${1} bytes, got ${nbytes} (ctx: [${ctx}])" >&2
    return 1
  }
}

@test "emit directive delivered under SUBAGENT_BUDGET_METER_OFF=1 (kill-switch independent)" {
  # run_hook forces SUBAGENT_BUDGET_METER_OFF=1 → meter suppressed; the emit directive must survive.
  run_hook "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_not_contains "${METER_NEEDLE}"
}

@test "emit directive delivered when agent has no maxTurns frontmatter (empty METER_BLOCK, meter enabled)" {
  # Meter NOT killed (kill-switch unset) but AGENTS_DIR absent → read_max_turns empty → METER_BLOCK
  # empty; the emit directive must still reach the child, independent of the maxTurns coupling.
  run_hook_no_meter "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_not_contains "${METER_NEEDLE}"
}

@test "emit directive ordered BEFORE the meter and all four droppable scope blocks" {
  run_hook_full "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_order "${EMIT_NEEDLE}" "${METER_NEEDLE}"
  assert_ctx_order "${EMIT_NEEDLE}" "${COMMENT_NEEDLE}"
  assert_ctx_order "${EMIT_NEEDLE}" "${STYLEREF_NEEDLE}"
  assert_ctx_order "${EMIT_NEEDLE}" "${MINIMALISM_NEEDLE}"
  assert_ctx_order "${EMIT_NEEDLE}" "${NAMING_NEEDLE}"
}

@test "assembled additionalContext stays <= 8192 bytes with emit block included, under drop pressure" {
  run_hook_full "glass-atrium-dev-react" 5000 5000 5000 5000
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_max_bytes 8192
}

# --- (e) meter-first assembly + universal 8KB byte-ceiling drop order (P1-T1 / P1-T2). ---
# Unlike run_hook (which suppresses the meter), these tests ENABLE it: they build a maxTurns
# frontmatter fixture + all four scope-block sources, then assert the meter is assembled FIRST and
# the 8KB ceiling drops blocks in the pinned order naming → style-ref → minimalism → comment-logging
# while never dropping the meter. Distinct needles per block make each assertion mutation-falsifiable.

METER_NEEDLE="Turn-budget meter"
COMMENT_NEEDLE="COMMENT-CORE-BODY"
STYLEREF_NEEDLE="STYLEREF-CORE-BODY"
MINIMALISM_NEEDLE="MINIMALISM-CORE-BODY"
# NAMING_NEEDLE ("Naming delta-core") is defined at the top of the file.

# Write a single-block source file: preamble, start marker, needle line, PAD 'X' bytes, end marker.
# The pad ('X' run from /dev/zero via tr) inflates the block to a controlled byte size so the ceiling
# drop order can be forced deterministically. Args: $1=path $2=start $3=end $4=needle $5=pad_bytes.
write_block_src() {
  local path="${1}" ms="${2}" me="${3}" needle="${4}" pad="${5}"
  {
    printf '%s\n' 'preamble (must not reach child)'
    printf '%s\n' "${ms}"
    printf '%s\n' "${needle}"
    head -c "${pad}" /dev/zero | tr '\0' 'X'
    printf '\n'
    printf '%s\n' "${me}"
    printf '%s\n' 'trailer (must not reach child)'
  } >"${path}"
}

# Build all four block sources + a maxTurns frontmatter dir, then drive the hook with the meter
# ENABLED (SUBAGENT_BUDGET_METER_OFF unset, AGENTS_DIR pointed at the fixture). style_ref + minimalism
# share ONE source file (scope-dev.md) carrying both marker pairs, mirroring production. Pads default
# to a tiny size; a test overrides them to force ceiling drops.
# Args: $1=agent $2=comment_pad $3=styleref_pad $4=minimalism_pad $5=naming_pad
run_hook_full() {
  local agent="${1}" cpad="${2:-16}" spad="${3:-16}" mpad="${4:-16}" npad="${5:-16}"
  local comment_src="${BATS_TEST_TMPDIR}/comment.md"
  local styleref_src="${BATS_TEST_TMPDIR}/scope-dev.md"
  local naming_src="${BATS_TEST_TMPDIR}/naming-full.md"
  local agents_dir="${BATS_TEST_TMPDIR}/agents"

  write_block_src "${comment_src}" '<!-- AGENT-INJECT:START -->' '<!-- AGENT-INJECT:END -->' "${COMMENT_NEEDLE}" "${cpad}"
  write_block_src "${naming_src}" "${NAMING_MARKER_START}" "${NAMING_MARKER_END}" "${NAMING_NEEDLE}" "${npad}"
  {
    printf '%s\n' 'preamble'
    printf '%s\n' '<!-- AGENT-INJECT:STYLE-REF:START -->'
    printf '%s\n' "${STYLEREF_NEEDLE}"
    head -c "${spad}" /dev/zero | tr '\0' 'X'
    printf '\n'
    printf '%s\n' '<!-- AGENT-INJECT:STYLE-REF:END -->'
    printf '%s\n' '<!-- AGENT-INJECT:MINIMALISM:START -->'
    printf '%s\n' "${MINIMALISM_NEEDLE}"
    head -c "${mpad}" /dev/zero | tr '\0' 'X'
    printf '\n'
    printf '%s\n' '<!-- AGENT-INJECT:MINIMALISM:END -->'
    printf '%s\n' 'trailer'
  } >"${styleref_src}"

  mkdir -p "${agents_dir}"
  printf 'maxTurns: 40\n' >"${agents_dir}/${agent}.md"

  run bash -c '
    agent="$1"; hook="$2"; comment_src="$3"; styleref_src="$4"; naming_src="$5"; agents_dir="$6"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents_dir}" \
      INJECT_SCOPE_RULES_SRC="${comment_src}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC="${styleref_src}" \
      INJECT_SCOPE_RULES_NAMING_SRC="${naming_src}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${comment_src}" "${styleref_src}" "${naming_src}" "${agents_dir}"
}

# Assert $1 appears strictly BEFORE $2 in the assembled additionalContext (both must be present).
assert_ctx_order() {
  local ctx first="${1}" second="${2}"
  ctx="$(ctx_of)"
  printf '%s' "${ctx}" | python3 -c '
import sys
ctx = sys.stdin.read()
a, b = sys.argv[1], sys.argv[2]
ia, ib = ctx.find(a), ctx.find(b)
sys.exit(0 if (ia != -1 and ib != -1 and ia < ib) else 1)
' "${first}" "${second}" || {
    echo "expected [${first}] to precede [${second}] in ctx: [${ctx}]" >&2
    return 1
  }
}

@test "meter block assembled FIRST — precedes comment-logging and naming (P1-T1)" {
  run_hook_full "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_contains "${COMMENT_NEEDLE}"
  assert_ctx_order "${METER_NEEDLE}" "${COMMENT_NEEDLE}"
  assert_ctx_order "${METER_NEEDLE}" "${NAMING_NEEDLE}"
}

@test "small blocks under 8KB ceiling — meter + all four scope blocks retained (P1-T2 baseline)" {
  run_hook_full "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_contains "${COMMENT_NEEDLE}"
  assert_ctx_contains "${STYLEREF_NEEDLE}"
  assert_ctx_contains "${MINIMALISM_NEEDLE}"
  assert_ctx_contains "${NAMING_NEEDLE}"
}

@test "over 8KB by one block — naming dropped FIRST, meter + other three retained (P1-T2 order 1)" {
  run_hook_full "glass-atrium-dev-react" 2200 2200 2200 2200
  assert_status 0
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_contains "${COMMENT_NEEDLE}"
  assert_ctx_contains "${STYLEREF_NEEDLE}"
  assert_ctx_contains "${MINIMALISM_NEEDLE}"
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

@test "far over 8KB — drops naming, style-ref, minimalism in order; keeps comment + meter (P1-T2)" {
  run_hook_full "glass-atrium-dev-react" 5000 5000 5000 5000
  assert_status 0
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_contains "${COMMENT_NEEDLE}"
  assert_ctx_not_contains "${STYLEREF_NEEDLE}"
  assert_ctx_not_contains "${MINIMALISM_NEEDLE}"
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}

@test "meter is NEVER dropped — a single oversized block cannot evict it (P1-T2 invariant)" {
  # comment alone = 9000B > ceiling; after dropping naming/style-ref/minimalism the comment+meter is
  # still over, so comment is dropped too — but the meter is not a drop candidate and MUST survive.
  run_hook_full "glass-atrium-dev-react" 9000 5000 5000 5000
  assert_status 0
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_not_contains "${COMMENT_NEEDLE}"
  assert_ctx_not_contains "${STYLEREF_NEEDLE}"
  assert_ctx_not_contains "${MINIMALISM_NEEDLE}"
  assert_ctx_not_contains "${NAMING_NEEDLE}"
}
