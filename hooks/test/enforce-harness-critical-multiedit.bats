#!/usr/bin/env bats
# enforce-harness-critical.sh — M-set: the MultiEdit envelope (clauded-docs/748 T7).
#
# THREE stacked pass-throughs each reduced a MultiEdit envelope to allow on their
# own — the classifier's normaliser tuple, the classifier's arm dispatch, and the
# shell-side `case "${TOOL_NAME}"`. Closing one leaves the other two, so every row
# below drives the WHOLE hook through a DIRECT invocation: a binding-only change
# cannot turn this file green.
#
# FOLD, not per-element union: the edits array is applied to disk IN ORDER and the
# composed result is compared ONCE. A per-element probe against disk is exploitable
# — AC-M4 stages a widening across two elements NEITHER of which trips a block on
# its own (AC-M4a/AC-M4b pin that), while the composed file widens `tools`.
#
# Polarity: AC-M3 / AC-M4a / AC-M4b / AC-M9 / AC-M10 are PASS controls and pass at
# HEAD by construction (HEAD allows every MultiEdit) — they exist so the fix cannot
# buy its blocks with an over-block. Every BLOCK row fails at HEAD (exit 0).
#
# Run via: bats hooks/test/enforce-harness-critical-multiedit.bats
# Requires: bats, bash 3.2+, python3, jq. Harness mirrors
# enforce-harness-critical-frontmatter.bats (hermetic FAKE_HOME, DIRECT invocation).

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  AGENTS="${FAKE_HOME}/.glass-atrium/agents"
  mkdir -p "${FAKE_HOME}/.claude/agents" "${AGENTS}" "${FAKE_HOME}/.glass-atrium/rules"

  # Two body lines so a multi-element benign edit has somewhere to land, and a
  # `model:` line so an element can overlap the frontmatter while staying
  # structurally NEUTRAL — that element is what stages AC-M4.
  cat >"${AGENTS}/t7-stage.md" <<'MD'
---
name: t7-stage
tools: [Read, Glob]
model: claude-model-a
---
# Body

Intro line.
Second line.
MD

  # 2 frontmatter fences + 2 body fences — the shape that separates a whole-file
  # `---` count from a frontmatter-scoped one, and the host for the f3 residual row.
  cat >"${AGENTS}/t7-hr.md" <<'MD'
---
name: t7-hr
tools: [Read, Glob]
model: claude-model-a
---
# Body

---

After the horizontal rule.

---

Tail line.
MD

  cat >"${AGENTS}/t7-repeat.md" <<'MD'
---
name: t7-repeat
tools: [Read, Glob]
model: claude-model-a
---
# Body

repeat token here.
repeat token here.
MD
}

# Args: $1=tool_name $2=tool_input JSON object.
run_hook() {
  local tool="${1}" tin="${2}" envelope
  envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" \
    '{tool_name: $t, tool_input: $ti}')"
  run env "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

# Args: pairs of old,new → compact JSON array of edits elements.
edits_array() {
  local out="[]" element
  while [[ "$#" -ge 2 ]]; do
    element="$(jq -cn --arg o "${1}" --arg n "${2}" '{old_string: $o, new_string: $n}')"
    out="$(jq -cn --argjson a "${out}" --argjson e "${element}" '$a + [$e]')"
    shift 2
  done
  printf '%s' "${out}"
}

# Args: $1=absolute path $2=edits JSON array.
run_multiedit() {
  run_hook "MultiEdit" "$(jq -cn --arg p "${1}" --argjson e "${2}" \
    '{file_path: $p, edits: $e}')"
}

# Args: $1=basename under AGENTS, then old,new pairs.
multiedit_agent() {
  local name="${1}"
  shift
  run_multiedit "${AGENTS}/${name}" "$(edits_array "$@")"
}

blocked_identity() {
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" == *"identity-frontmatter-"* ]] || return 1
}

blocked_unparseable() {
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" == *"frontmatter-unparseable"* ]] || return 1
}

# Args: $1=expected reason token.
blocked_reason() {
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" == *"${1}"* ]] || return 1
}

passed_clean() {
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"HAR-0"* ]] || return 1
}

# ── AC-M1/AC-M2: the widening hides at either end of the edits array ─────────

@test "AC-M1 widening in the LAST edits element → identity block" {
  multiedit_agent "t7-stage.md" \
    'Intro line.' 'Intro line edited.' \
    'Second line.' 'Second line edited.' \
    'tools: [Read, Glob]' 'tools: [Read, Glob, Bash]'
  blocked_identity
}

@test "AC-M2 widening in the FIRST edits element → identity block" {
  multiedit_agent "t7-stage.md" \
    'tools: [Read, Glob]' 'tools: [Read, Glob, Bash]' \
    'Intro line.' 'Intro line edited.' \
    'Second line.' 'Second line edited.'
  blocked_identity
}

@test "AC-M3 benign multi-element body-only MultiEdit → pass" {
  multiedit_agent "t7-stage.md" \
    'Intro line.' 'Intro line edited.' \
    'Second line.' 'Second line edited.'
  passed_clean
}

# ── AC-M4: staged widening — the row that separates a FOLD from a per-element
# union. Element 1 overlaps the frontmatter but is struct-neutral; element 2's
# old_string exists ONLY after element 1 has landed, so a probe against disk
# misses it entirely. Neither element blocks alone (AC-M4a/AC-M4b).

@test "AC-M4a staged element 1 alone (model pin) → pass" {
  multiedit_agent "t7-stage.md" \
    'model: claude-model-a' 'model: claude-model-b'
  passed_clean
}

@test "AC-M4b staged element 2 alone (old_string absent from disk) → pass" {
  multiedit_agent "t7-stage.md" \
    'tools: [Read, Glob]
model: claude-model-b' 'tools: [Read, Glob, Bash]
model: claude-model-b'
  passed_clean
}

@test "AC-M4 staged widening across two elements → identity block" {
  multiedit_agent "t7-stage.md" \
    'model: claude-model-a' 'model: claude-model-b' \
    'tools: [Read, Glob]
model: claude-model-b' 'tools: [Read, Glob, Bash]
model: claude-model-b'
  blocked_identity
}

# ── AC-M5: an edits payload this gate cannot read is unanswerable → fail-closed
# on the EXISTING frontmatter-unparseable reason, never a second vocabulary.

@test "AC-M5 edits key absent → frontmatter-unparseable" {
  run_hook "MultiEdit" "$(jq -cn --arg p "${AGENTS}/t7-stage.md" '{file_path: $p}')"
  blocked_unparseable
}

@test "AC-M5 edits is a string, not an array → frontmatter-unparseable" {
  run_hook "MultiEdit" "$(jq -cn --arg p "${AGENTS}/t7-stage.md" \
    '{file_path: $p, edits: "tools: [Read, Glob, Bash]"}')"
  blocked_unparseable
}

@test "AC-M5 edits is an EMPTY array → frontmatter-unparseable" {
  run_multiedit "${AGENTS}/t7-stage.md" '[]'
  blocked_unparseable
}

@test "AC-M5 edits element is not an object → frontmatter-unparseable" {
  run_multiedit "${AGENTS}/t7-stage.md" '["tools: [Read, Glob, Bash]"]'
  blocked_unparseable
}

@test "AC-M5 edits element carries a non-string old_string → frontmatter-unparseable" {
  run_multiedit "${AGENTS}/t7-stage.md" '[{"old_string": 7, "new_string": "x"}]'
  blocked_unparseable
}

# ── AC-M6: MultiEdit CAN create a file (first element with an empty old_string),
# so the new-agent guard is tool_name-sensitive in the same way the Write arm is.

@test "AC-M6 MultiEdit creating a NEW agents/*.md → new-agent-creation block" {
  run_multiedit "${AGENTS}/t7-brand-new.md" \
    "$(edits_array '' '---
name: t7-brand-new
tools: [Read, Glob, Bash, Write]
---
# Body
')"
  blocked_reason "new-agent-creation"
}

# ── AC-M7/AC-M8: the shell-side path arms and the fence branch reached through
# the MultiEdit dispatch, not only the identity comparison.

@test "AC-M7 MultiEdit on live settings.json → live-settings block" {
  run_multiedit "${FAKE_HOME}/.claude/settings.json" \
    "$(edits_array '"model":' '"model": "x",')"
  blocked_reason "live-settings"
}

@test "AC-M8 MultiEdit removing the closing fence → frontmatter-fence-edit" {
  multiedit_agent "t7-stage.md" \
    '---
# Body' '# Body'
  blocked_reason "frontmatter-fence-edit"
}

# ── AC-M9/AC-M10: the widened dispatch must not over-block. ──────────────────

@test "AC-M9 MultiEdit on an unprotected .glass-atrium path → pass" {
  run_multiedit "${FAKE_HOME}/.glass-atrium/rules/example.md" \
    "$(edits_array 'a' 'b')"
  passed_clean
}

@test "AC-M10 body-only element with replace_all honoured → pass" {
  run_multiedit "${AGENTS}/t7-repeat.md" \
    '[{"old_string": "repeat token here.", "new_string": "changed.", "replace_all": true}]'
  passed_clean
}

# ── T1: case-varied protected paths through the MultiEdit dispatch (753 F1) ───
#
# APFS is case-INSENSITIVE, so a case-varied spelling resolves onto the protected
# agent file while the case-SENSITIVE dispatch glob discards the block. Three
# spellings, one per position that can vary: the EXTENSION (the sharpest — every
# earlier layer works), the agents DIRECTORY, and the protected ROOT.
# EXIT CODE ONLY: CI runs on a case-SENSITIVE volume where the block class
# legitimately diverges, and each row materializes its target under BOTH spellings
# so the classifier's disk read finds it on either platform.

# Args: $1=existing source path $2=case-varied destination path.
materialize_case_variant() {
  mkdir -p "$(dirname "${2}")"
  # On a case-INSENSITIVE volume the destination ALREADY resolves to the source, so
  # a copy would truncate the fixture it is meant to duplicate — only a
  # case-SENSITIVE volume needs the second file.
  [[ -e "${2}" ]] || cp "${1}" "${2}"
}

@test "T1-K1 case-varied .MD extension, MultiEdit widening → block" {
  local variant="${AGENTS}/t7-stage.MD"
  materialize_case_variant "${AGENTS}/t7-stage.md" "${variant}"
  run_multiedit "${variant}" \
    "$(edits_array 'tools: [Read, Glob]' 'tools: [Read, Glob, Bash]')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "T1-K2 case-varied agents DIRECTORY, MultiEdit widening → block" {
  local variant="${FAKE_HOME}/.glass-atrium/Agents/t7-stage.md"
  materialize_case_variant "${AGENTS}/t7-stage.md" "${variant}"
  run_multiedit "${variant}" \
    "$(edits_array 'tools: [Read, Glob]' 'tools: [Read, Glob, Bash]')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "T1-K3 case-varied protected ROOT, MultiEdit widening → block" {
  local variant="${FAKE_HOME}/.Glass-atrium/agents/t7-stage.md"
  materialize_case_variant "${AGENTS}/t7-stage.md" "${variant}"
  run_multiedit "${variant}" \
    "$(edits_array 'tools: [Read, Glob]' 'tools: [Read, Glob, Bash]')"
  [[ "${status}" -eq 2 ]] || return 1
}

# Over-shoot control: the folded extension glob must not reach an EXCLUDED dir.

@test "T1-neg case-varied .MD under the excluded rules dir → still pass" {
  run_multiedit "${FAKE_HOME}/.glass-atrium/rules/example.MD" \
    "$(edits_array 'a' 'b')"
  passed_clean
}

# ── T2: the fence delta is accumulator-scoped, matching the Edit arm (753 F-REG) ─
#
# A WHOLE-FILE `---` count cannot tell a body horizontal rule from a frontmatter
# fence, so it blocked a benign body rule that the byte-identical Edit allows (the
# shipped Edit polarity row: "agents body Edit touching a body --- hr" in
# enforce-harness-critical.bats). G1/G2 port that polarity onto this arm; G3 keeps
# the frontmatter-scoped block; G4 pins the residual the rescope leaves behind.
#
# DEFENSIVE, not live: the divergence is a correctness defect in the arm rather than
# an operator-facing breakage, since no MultiEdit envelope is emittable on this host
# — these rows are forward-compat insurance for whenever one becomes emittable.

@test "G1 MultiEdit ADDING a body --- hr → pass (fence delta is span-scoped)" {
  multiedit_agent "t7-hr.md" \
    'Tail line.' $'---\n\nTail line.'
  passed_clean
}

@test "G2 MultiEdit REMOVING a body --- hr → pass (same old/new as the Edit row)" {
  multiedit_agent "t7-hr.md" \
    $'---\n\nAfter the horizontal rule.' 'After the rule.'
  passed_clean
}

@test "G3 MultiEdit inserting a fence INSIDE the frontmatter → still block" {
  multiedit_agent "t7-hr.md" \
    'model: claude-model-a' $'---\nmodel: claude-model-a'
  blocked_reason "frontmatter-fence-edit"
}

# CHARACTERIZATION, not a demand: an f3-shaped second `---`…`---` block appended
# AFTER the real closing fence is NOT covered once the delta is span-scoped — the
# body element never overlaps the frontmatter span and the composed identity
# structure is unchanged. Whether the host parser reads such a second block as
# frontmatter at all is UNPROBED (deferral D6), so the shape is pinned here as
# "not covered" rather than described in prose.
@test "G4 CHARACTERIZATION f3 second ---…--- block after the closing fence → pass" {
  multiedit_agent "t7-hr.md" \
    'Tail line.' $'Tail line.\n\n---\ntools: [Read, Glob, Bash, Write]\n---'
  passed_clean
}

# ── T4: a MISSING old/new key is unreadable, not an empty string (753 F3) ──────
#
# The type test alone cannot see a missing key: the empty-string default IS a
# string, so `{}` composed to disk unchanged and passed. M9/M10 did block, but
# only INCIDENTALLY — an empty old_string prepends the replacement and the
# identity structure changes as a side effect. The presence test makes all three
# close on the same intended raise, so the reason token is asserted here.
#
# DEFENSIVE, not live: no MultiEdit envelope is emittable on this host.

@test "T4-M14 edits element with BOTH keys missing → frontmatter-unparseable" {
  run_multiedit "${AGENTS}/t7-stage.md" '[{}]'
  blocked_unparseable
}

@test "T4-M9 edits element missing new_string → frontmatter-unparseable" {
  run_multiedit "${AGENTS}/t7-stage.md" '[{"old_string": "tools: [Read, Glob]"}]'
  blocked_unparseable
}

@test "T4-M10 edits element missing old_string → frontmatter-unparseable" {
  run_multiedit "${AGENTS}/t7-stage.md" '[{"new_string": "Intro line edited."}]'
  blocked_unparseable
}

# An empty old_string is the legitimate create shape (AC-M6), so presence — never
# truthiness — is what the raise keys on: both keys PRESENT here, one empty.
@test "T4-M14neg control: present-but-empty old_string on an EXISTING file → pass" {
  run_multiedit "${AGENTS}/t7-repeat.md" \
    '[{"old_string": "repeat token here.", "new_string": ""}]'
  passed_clean
}
