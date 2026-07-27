#!/usr/bin/env bats
# enforce-harness-critical.sh — B-set: frontmatter structure (clauded-docs/743 P0-B).
#
# The identity matcher is a line-anchored pattern over the three guarded key lines,
# so a block-list `tools:` puts every granted item on a continuation line the matcher
# cannot see: an Edit that inserts one item matches nothing, and a full-file Write
# compares two identical empty remainders. 7 of 23 live agent files use that form.
#
# Reporting contract (AC-S1): this file carries the B-set ONLY. The A-set lives in
# enforce-harness-critical-pathnorm.bats, so a partial landing reads as partial.
#
# STRUCTURAL SAFETY of the permit rows (AC-B6): the extractor walks ONLY the slice
# returned by frontmatter_span(), so body prose — including ordinary `- bullet`
# lines — never reaches it. The naive "any whitespace-dash line" matcher named as
# the dominant risk would fail every AC-B6 row; that is what those rows exist for.
#
# SPEC DEVIATION, stated rather than smoothed over: the settled spec spells AC-B1/
# AC-B2 as "add `  - Bash`" to glass-atrium-dev-shell. That file already grants
# Bash, so the literal row would be a DUPLICATE item — which the same spec rules a
# NON-change that must PASS. The widening rows therefore add a tool the target
# genuinely lacks: Bash on glass-atrium-meta-prompt-engineer (the exact LLM06
# escalation of the spec's section 1) and WebSearch on glass-atrium-dev-shell.
#
# Run via: bats hooks/test/enforce-harness-critical-frontmatter.bats
# Requires: bats, bash 3.2+, python3, jq. Harness copied from
# enforce-harness-critical.bats (hermetic FAKE_HOME, DIRECT hook invocation).

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"
CORPUS="${BATS_TEST_DIRNAME}/corpus/agents-blocklist"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  AGENTS="${FAKE_HOME}/.glass-atrium/agents"
  mkdir -p "${FAKE_HOME}/.claude/agents" "${AGENTS}"
  # Frontmatter copied VERBATIM from the repo agents/*.md (repo == live on this
  # count) + a fixed synthetic body — real-form coverage with no live dependency.
  cp "${CORPUS}"/*.md "${AGENTS}/"

  # Inline-flow twin of the META block-list file: same grants, other form. The
  # cross-form parity rows (AC-B3) turn on this pair.
  cat >"${AGENTS}/glass-atrium-meta-inline.md" <<'MD'
---
name: glass-atrium-meta-inline
description: 'Inline-flow twin of the block-list META agent file.'
tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]
maxTurns: 80
---
# Body

Intro line.

- ordinary prose bullet
- second prose bullet
MD

  # agent_lifecycle scaffold output form (scripts/agent_lifecycle/scaffold.py).
  cat >"${AGENTS}/glass-atrium-dev-scaffold.md" <<'MD'
---
name: glass-atrium-dev-scaffold
description: glass-atrium-dev-scaffold agent (scaffolded by agent-lifecycle; body pending authoring).
tools: [Read, Glob, Grep, Edit, Write, Bash]
maxTurns: 40
---

> Rules: GLASS_ATRIUM_GLOBAL_RULES.md (ALL + DEV)
MD

  # Guarded keys adjacent, for the key-line reorder ruling.
  cat >"${AGENTS}/s24-keyorder.md" <<'MD'
---
name: s24-keyorder
tools: [Read, Glob]
maxTurns: 80
---
# Body
MD

  # Unbalanced quote — taken literally, never stripped.
  cat >"${AGENTS}/s24-unbalanced.md" <<'MD'
---
name: "x
maxTurns: 80
---
# Body
MD

  seed_b7
}

# Out-of-contract shapes, each on a GUARDED key. Every file also carries a
# `model:` line: the Edit rows key their old_string on it so the edit provably
# OVERLAPS the region and the HEAD failure is unambiguous.
seed_b7() {
  cat >"${AGENTS}/b7-nested.md" <<'MD'
---
name: b7-nested
tools:
  read: true
  bash: true
model: claude-model-a
---
# Body

Intro line.
MD

  cat >"${AGENTS}/b7-flow.md" <<'MD'
---
name: b7-flow
tools: [Read,
  Glob]
model: claude-model-a
---
# Body

Intro line.
MD

  cat >"${AGENTS}/b7-blockscalar.md" <<'MD'
---
name: b7-blockscalar
tools: >
  Read
  Glob
model: claude-model-a
---
# Body

Intro line.
MD

  cat >"${AGENTS}/b7-namepipe.md" <<'MD'
---
name: |
  b7-namepipe
model: claude-model-a
---
# Body

Intro line.
MD

  cat >"${AGENTS}/b7-anchor.md" <<'MD'
---
name: b7-anchor
tools: &a [Read]
model: claude-model-a
---
# Body

Intro line.
MD

  cat >"${AGENTS}/b7-alias.md" <<'MD'
---
name: b7-alias
tools: *a
model: claude-model-a
---
# Body

Intro line.
MD

  cat >"${AGENTS}/b7-tag.md" <<'MD'
---
name: !!str b7-tag
model: claude-model-a
---
# Body

Intro line.
MD

  # CONTAINMENT: the same exotic spelling under a NON-guarded key stays inert.
  cat >"${AGENTS}/b7-ok-anchor.md" <<'MD'
---
name: b7-ok-anchor
tools: [Read]
skills: &s [glass-atrium-dev-naming]
model: claude-model-a
---
# Body

Intro line.
MD
}

# Args: $1=tool_name $2=tool_input JSON object.
run_hook() {
  local tool="${1}" tin="${2}" envelope
  envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" \
    '{tool_name: $t, tool_input: $ti}')"
  run env "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

write_input() { jq -cn --arg p "${1}" --arg c "${2}" '{file_path: $p, content: $c}'; }
edit_input() { jq -cn --arg p "${1}" --arg o "${2}" --arg n "${3}" '{file_path: $p, old_string: $o, new_string: $n}'; }

# Edit envelope against a seeded agent file. Args: $1=basename $2=old $3=new.
edit_agent() { run_hook "Edit" "$(edit_input "${AGENTS}/${1}" "${2}" "${3}")"; }

# Write envelope carrying the file's own bytes with one line inserted after a
# match — the widened-block-list Write, whose three key lines stay identical.
# Args: $1=basename $2=line to match $3=line to insert after it.
write_agent_insert() {
  local content
  content="$(awk -v pat="${2}" -v ins="${3}" '{print} $0==pat{print ins}' "${AGENTS}/${1}")"
  run_hook "Write" "$(write_input "${AGENTS}/${1}" "${content}")"
}

# Write envelope carrying the file's own bytes with one line REPLACED — the inline
# form's widening replaces its single key line rather than gaining a second one.
# Args: $1=basename $2=line to replace $3=replacement line.
write_agent_replace() {
  local content
  content="$(awk -v pat="${2}" -v rep="${3}" '{print ($0==pat ? rep : $0)}' "${AGENTS}/${1}")"
  run_hook "Write" "$(write_input "${AGENTS}/${1}" "${content}")"
}

# The block-reason token as the payload carries it — the parity rows compare this,
# never the whole output.
reason_token() {
  printf '%s' "${1}" \
    | grep -o 'identity-frontmatter-write\|identity-frontmatter-edit\|frontmatter-fence-edit\|unterminated-frontmatter\|frontmatter-unparseable\|new-agent-creation' \
    | head -1
}

# Write envelope differing from disk in the BODY only. Args: $1=basename.
write_agent_body_only() {
  local content
  content="$(cat "${AGENTS}/${1}")
appended body line"
  run_hook "Write" "$(write_input "${AGENTS}/${1}" "${content}")"
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

passed_clean() {
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"frontmatter-unparseable"* ]] || return 1
}

# ── AC-B5: legitimate non-identity frontmatter edits on block-list files ─────
# (The spec names `model:` on glass-atrium-dev-rag; no repo agent file carries a
# `model:` key — every pin is live-only — so the model row runs on the synthetic
# shapes fixture and rag keeps the maxTurns row.)

@test "AC-B5 maxTurns edit (dev-rag) → pass" {
  edit_agent "glass-atrium-dev-rag.md" 'maxTurns: 80' 'maxTurns: 81'
  passed_clean
}

@test "AC-B5 model pin edit (shapes) → pass" {
  edit_agent "glass-atrium-dev-shapes.md" 'model: claude-model-a' 'model: claude-model-b'
  passed_clean
}

@test "AC-B5 folded description continuation edit (dev-rag) → pass" {
  edit_agent "glass-atrium-dev-rag.md" \
    '  RAG retrieval pipeline implementation and parameter tuning agent (code-only scope).' \
    '  RAG retrieval pipeline implementation agent (code-only scope).'
  passed_clean
}

@test "AC-B5 non-guarded nested-map value edit (designer skills_policy) → pass" {
  edit_agent "glass-atrium-design-designer.md" \
    '  status: selective_injection_allowed' '  status: selective_injection_denied'
  passed_clean
}

@test "AC-B5 non-guarded list-item edit with inline comment (designer skills) → pass" {
  edit_agent "glass-atrium-design-designer.md" \
    '  - glass-atrium-design-anti-slop # mechanical AI-slop detector' \
    '  - glass-atrium-design-anti-slop # mechanical AI-slop detector (revised)'
  passed_clean
}

# ── AC-B6: body prose edits pass on ALL SEVEN live block-list files ──────────
# Explicit rows, not a loop: the TAP output must name WHICH file regressed.

@test "AC-B6 glass-atrium-design-designer: remove a prose bullet → pass" {
  edit_agent "glass-atrium-design-designer.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-design-designer: add a prose bullet → pass" {
  edit_agent "glass-atrium-design-designer.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

@test "AC-B6 glass-atrium-dev-android: remove a prose bullet → pass" {
  edit_agent "glass-atrium-dev-android.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-dev-android: add a prose bullet → pass" {
  edit_agent "glass-atrium-dev-android.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

@test "AC-B6 glass-atrium-dev-db: remove a prose bullet → pass" {
  edit_agent "glass-atrium-dev-db.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-dev-db: add a prose bullet → pass" {
  edit_agent "glass-atrium-dev-db.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

@test "AC-B6 glass-atrium-dev-gsap: remove a prose bullet → pass" {
  edit_agent "glass-atrium-dev-gsap.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-dev-gsap: add a prose bullet → pass" {
  edit_agent "glass-atrium-dev-gsap.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

@test "AC-B6 glass-atrium-dev-rag: remove a prose bullet → pass" {
  edit_agent "glass-atrium-dev-rag.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-dev-rag: add a prose bullet → pass" {
  edit_agent "glass-atrium-dev-rag.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

@test "AC-B6 glass-atrium-dev-shell: remove a prose bullet → pass" {
  edit_agent "glass-atrium-dev-shell.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-dev-shell: add a prose bullet → pass" {
  edit_agent "glass-atrium-dev-shell.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

@test "AC-B6 glass-atrium-meta-prompt-engineer: remove a prose bullet → pass" {
  edit_agent "glass-atrium-meta-prompt-engineer.md" '- second prose bullet' ''
  passed_clean
}

@test "AC-B6 glass-atrium-meta-prompt-engineer: add a prose bullet → pass" {
  edit_agent "glass-atrium-meta-prompt-engineer.md" '- ordinary prose bullet' '- ordinary prose bullet
- third bullet'
  passed_clean
}

# Fail-closed direction, UNREACHABLE through the real tool layer: the Edit tool
# refuses a non-unique old_string without replace_all, and the hook's
# first-occurrence model resolves this one to the frontmatter item.
@test "AC-B6 body bullet duplicating a tools item → block (fail-closed, unreachable in practice)" {
  # The ADDED item must be one the file does not already grant. `Write` is already
  # in this file's tools, so adding it yields an identical grant set — a ruled
  # non-change (S2.4 duplicate row), which would make this row vacuous: a hook that
  # inspected only the BODY occurrence would pass too, so it could not discriminate.
  # `WebSearch` is ungranted, so a pass here can only mean the frontmatter
  # occurrence was missed — which is exactly the property this row pins.
  printf '  - Read\n' >>"${AGENTS}/glass-atrium-dev-shell.md"
  edit_agent "glass-atrium-dev-shell.md" '  - Read' '  - Read
  - WebSearch'
  blocked_identity
}

# ── AC-B1 / AC-B2 / AC-B3 / AC-B1b: the block-list evasion ──────────────────

@test "AC-B1 block-list Edit granting Bash to the META agent → HAR-001 block (exit 2)" {
  edit_agent "glass-atrium-meta-prompt-engineer.md" '  - Write
  - WebSearch' '  - Write
  - Bash
  - WebSearch'
  blocked_identity
  [[ "${output}" == *"identity-frontmatter-edit"* ]] || return 1
}

@test "AC-B1 block-list Edit granting WebSearch to the shell agent → HAR-001 block (exit 2)" {
  edit_agent "glass-atrium-dev-shell.md" '  - Bash' '  - Bash
  - WebSearch'
  blocked_identity
}

@test "AC-B2 full-file Write widening a block list, key lines identical → HAR-001 block (exit 2)" {
  write_agent_insert "glass-atrium-meta-prompt-engineer.md" '  - Write' '  - Bash'
  blocked_identity
  [[ "${output}" == *"identity-frontmatter-write"* ]] || return 1
}

@test "AC-B3a Edit arm: inline and block-list forms of ONE widening agree" {
  local status_inline reason_inline status_block reason_block
  edit_agent "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]'
  status_inline="${status}"
  reason_inline="$(reason_token "${output}")"
  edit_agent "glass-atrium-meta-prompt-engineer.md" '  - Write
  - WebSearch' '  - Write
  - Bash
  - WebSearch'
  status_block="${status}"
  reason_block="$(reason_token "${output}")"
  [[ "${status_inline}" -eq "${status_block}" ]] || return 1
  [[ "${reason_inline}" == "${reason_block}" ]] || return 1
  [[ -n "${reason_inline}" ]] || return 1
}

@test "AC-B3b Write arm: inline and block-list forms of ONE widening agree" {
  local status_inline reason_inline status_block reason_block
  write_agent_replace "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]'
  status_inline="${status}"
  reason_inline="$(reason_token "${output}")"
  write_agent_insert "glass-atrium-meta-prompt-engineer.md" '  - Write' '  - Bash'
  status_block="${status}"
  reason_block="$(reason_token "${output}")"
  [[ "${status_inline}" -eq "${status_block}" ]] || return 1
  [[ "${reason_inline}" == "${reason_block}" ]] || return 1
  [[ -n "${reason_inline}" ]] || return 1
}

@test "AC-B1b/AC-B4-5 column-0 block list widened → HAR-001 block (exit 2)" {
  edit_agent "glass-atrium-dev-col0.md" '- Grep' '- Grep
- Bash'
  blocked_identity
}

# ── AC-B4: one block row and one permit row per IN-contract shape ────────────

@test "AC-B4-1 plain scalar: name rename → block" {
  edit_agent "glass-atrium-dev-db.md" 'name: glass-atrium-dev-db' 'name: glass-atrium-dev-evil'
  blocked_identity
}

@test "AC-B4-1 plain scalar: description reword → pass" {
  edit_agent "glass-atrium-dev-db.md" \
    '  PostgreSQL/MySQL schema migration files, query optimization, and DDL authoring agent.' \
    '  PostgreSQL schema migration files and DDL authoring agent.'
  passed_clean
}

@test "AC-B4-2 quoted scalar: name value change → block" {
  edit_agent "glass-atrium-dev-shapes.md" 'name: "glass-atrium-dev-shapes"' 'name: "glass-atrium-dev-evil"'
  blocked_identity
}

@test "AC-B4-2 quoted scalar: same value re-quoted → pass (ruled non-change)" {
  edit_agent "glass-atrium-dev-shapes.md" 'name: "glass-atrium-dev-shapes"' 'name: glass-atrium-dev-shapes'
  passed_clean
}

@test "AC-B4-3 folded scalar under a non-guarded key: continuation edit → pass" {
  edit_agent "glass-atrium-dev-shapes.md" \
    '  Second continuation line, indented under a folded block scalar.' \
    '  Second continuation line, reworded.'
  passed_clean
}

@test "AC-B4-4 block list (2-space): widen → block" {
  edit_agent "glass-atrium-dev-db.md" '  - Grep' '  - Grep
  - Task'
  blocked_identity
}

@test "AC-B4-4 block list (2-space): reorder → pass" {
  edit_agent "glass-atrium-dev-db.md" '  - Read
  - Glob' '  - Glob
  - Read'
  passed_clean
}

@test "AC-B4-6 inline flow: widen → block" {
  edit_agent "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch, Bash]'
  blocked_identity
}

@test "AC-B4-7 full-line comment in the region: a widening edit below it still blocks" {
  edit_agent "glass-atrium-dev-rag.md" '  - WebFetch' '  - WebFetch
  - Task'
  blocked_identity
}

@test "AC-B4-7 full-line comment in the region: editing the comment text → pass" {
  edit_agent "glass-atrium-dev-rag.md" \
    '# NOTE: DEV scope but retains WebSearch/WebFetch due to RAG-domain needs — see scope-dev.md "Agent-Level Tool Exceptions"' \
    '# NOTE: DEV scope, retains WebSearch/WebFetch — see scope-dev.md "Agent-Level Tool Exceptions"'
  passed_clean
}

@test "AC-B4-8 inline comment after a list item: appending a comment to an item → pass" {
  edit_agent "glass-atrium-dev-shapes.md" '  - Read' '  - Read # keep'
  passed_clean
}

@test "AC-B4-8 inline comment after a list item: adding an item that carries one → block" {
  edit_agent "glass-atrium-dev-shapes.md" '  - Read' '  - Read
  - Bash # newly granted'
  blocked_identity
}

@test "AC-B4-9 nested map under a non-guarded key: edit → pass, no unparseable verdict" {
  edit_agent "glass-atrium-design-designer.md" \
    '  last_reviewed: 2026-05-21' '  last_reviewed: 2026-05-22'
  passed_clean
}

@test "AC-B4-10 blank line in the region: a widening edit after it still blocks" {
  edit_agent "glass-atrium-dev-shapes.md" '  - Grep' '  - Grep
  - Bash'
  blocked_identity
}

# ── S2.4: ruled NON-changes — the mandated polarity flips ────────────────────
# HEAD blocks several of these; the R-Q4 ruling says they are not changes, so the
# flip is a tested decision rather than a silent narrowing.

@test "S2.4 inline tools reorder → pass (ruled non-change)" {
  edit_agent "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: [WebFetch, WebSearch, Write, Edit, Grep, Glob, Read]'
  passed_clean
}

@test "S2.4 quote a block-list item → pass (ruled non-change)" {
  edit_agent "glass-atrium-dev-db.md" '  - Read' '  - "Read"'
  passed_clean
}

@test "S2.4 quote an inline item → pass (ruled non-change)" {
  edit_agent "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: ["Read", Glob, Grep, Edit, Write, WebSearch, WebFetch]'
  passed_clean
}

@test "S2.4 duplicate an already-granted inline item → pass (ruled non-change)" {
  edit_agent "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch, Read]'
  passed_clean
}

@test "S2.4 append an inline comment to an inline-form key line → pass (ruled non-change)" {
  edit_agent "glass-atrium-meta-inline.md" \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch]' \
    'tools: [Read, Glob, Grep, Edit, Write, WebSearch, WebFetch] # unchanged grants'
  passed_clean
}

@test "S2.4 reorder the guarded key LINES → pass (ruled non-change)" {
  edit_agent "s24-keyorder.md" 'name: s24-keyorder
tools: [Read, Glob]' 'tools: [Read, Glob]
name: s24-keyorder'
  passed_clean
}

@test "S2.4 unbalanced quote is taken literally → block (values differ)" {
  edit_agent "s24-unbalanced.md" 'name: "x' 'name: "y'
  blocked_identity
}

@test "S2.4 adding scope where absent → block" {
  local content
  content="$(awk '{print} $0=="name: glass-atrium-dev-db"{print "scope: DEV"}' "${AGENTS}/glass-atrium-dev-db.md")"
  run_hook "Write" "$(write_input "${AGENTS}/glass-atrium-dev-db.md" "${content}")"
  blocked_identity
}

@test "S2.4 scope absent on BOTH sides compares equal → pass" {
  write_agent_body_only "glass-atrium-dev-db.md"
  passed_clean
}

# ── AC-B7: an unanswerable identity question is a NAMED block, never an allow ─

@test "AC-B7 nested map under tools: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-nested.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 nested map under tools: body-only Write → frontmatter-unparseable" {
  write_agent_body_only "b7-nested.md"
  blocked_unparseable
}

@test "AC-B7 multi-line flow on tools: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-flow.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 multi-line flow on tools: body-only Write → frontmatter-unparseable" {
  write_agent_body_only "b7-flow.md"
  blocked_unparseable
}

@test "AC-B7 block scalar as the tools value: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-blockscalar.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 block scalar as the tools value: body-only Write → frontmatter-unparseable" {
  write_agent_body_only "b7-blockscalar.md"
  blocked_unparseable
}

@test "AC-B7 block scalar as the name value: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-namepipe.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 anchor on tools: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-anchor.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 anchor on tools: body-only Write → frontmatter-unparseable" {
  write_agent_body_only "b7-anchor.md"
  blocked_unparseable
}

@test "AC-B7 alias on tools: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-alias.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 tag on name: Edit overlapping the region → frontmatter-unparseable" {
  edit_agent "b7-tag.md" 'model: claude-model-a' 'model: claude-model-b'
  blocked_unparseable
}

@test "AC-B7 unparseable frontmatter surfaces as HAR-001, never HAR-003" {
  edit_agent "b7-nested.md" 'model: claude-model-a' 'model: claude-model-b'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" != *"HAR-003"* ]] || return 1
}

# CONTAINMENT: exotic spellings under NON-guarded keys are traversed inertly.

@test "AC-B7 containment: nested map under a non-guarded key → pass, not unparseable" {
  edit_agent "glass-atrium-design-designer.md" \
    '  rationale: "Selective skills permitted when they are pure knowledge-injection (glass-atrium-design-anti-slop mechanical detector, contrast verification, 5-axis critique rubric) — not workflow-procedural skills that would override creative judgment. glass-atrium-design-designer.md AI Slop Tropes remains SoT, skill is detector layer only. Craft-first iteration loop preserved."' \
    '  rationale: "Selective skills permitted when purely knowledge-injecting."'
  passed_clean
}

@test "AC-B7 containment: folded scalar under a non-guarded key → pass, not unparseable" {
  edit_agent "glass-atrium-dev-gsap.md" \
    '  GSAP 3.15+ animation modules (.ts/.tsx) — scroll storytelling and interaction motion code.' \
    '  GSAP animation modules (.ts/.tsx).'
  passed_clean
}

@test "AC-B7 containment: anchor under a non-guarded key → pass, not unparseable" {
  edit_agent "b7-ok-anchor.md" 'model: claude-model-a' 'model: claude-model-b'
  passed_clean
}

# NOT a fail-open: with no overlap the region is provably unchanged, so the
# identity question is answerable without parsing the exotic value at all.
@test "AC-B7 containment: body-only Edit not overlapping an unparseable region → pass" {
  edit_agent "b7-nested.md" 'Intro line.' 'Intro line, reworded.'
  passed_clean
}

# ── AC-S2: the sanctioned lifecycle write path still functions ───────────────

@test "AC-S2 lifecycle-scaffold frontmatter form parses clean → pass" {
  edit_agent "glass-atrium-dev-scaffold.md" \
    'description: glass-atrium-dev-scaffold agent (scaffolded by agent-lifecycle; body pending authoring).' \
    'description: glass-atrium-dev-scaffold agent (body authored).'
  passed_clean
}
