#!/usr/bin/env bats
# enforce-harness-critical.sh — envelope-driven suite (plan clauded-docs/285 T2).
#
# PreToolUse(Write|Edit + Bash) harness-critical gate, agent_id-INDEPENDENT:
#   Write|Edit arm → live settings.json/settings.local.json · live hook dirs ·
#   agents/*.md frontmatter identity keys {name, tools, scope} (model excluded,
#   body edits pass) · NEW agents/*.md Write · scheduled-exec dirs
#   autoagent/+scripts/+skills/ (rules/+scoped/ EXCLUDED per H1-D1). Bash arm →
#   best-effort mutation-verb + protected-path-literal text match (indirection
#   residual PASSES by design).
# Block channel: HAR-001/HAR-002 emit_error + exit 2 · fail-closed HAR-003 on a
# python3-less PATH · HARNESS_PROTECTION_APPROVE=1 launch-env grant passes.
#
# Run via: bats hooks/test/enforce-harness-critical.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq.
#
# Hermetic strategy: the hook is HOME-anchored, so every protected path lives
# under a per-test FAKE_HOME (BATS_TEST_TMPDIR) — no live-install dependency.
#
# INVOCATION CONVENTION — the hook is executed DIRECTLY as a command, never
# interpreter-prefixed (`bash hook.sh`). An interpreter prefix bypasses the
# executable bit, so a hook shipped mode-644 — inert to Claude Code, protecting
# nothing — still passes a green suite. Direct execution exercises the real path.
# DOCUMENTED EXCEPTION: the python3-absent rows keep the interpreter prefix,
# because direct execution resolves `#!/usr/bin/env bash` through the narrowed
# PATH, and that fixture's stripped bin dir is the shared lib's roster rather than
# this suite's. Those rows assert a PATH condition, not the executable bit, which
# every other row in this file now covers.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  source "${BATS_TEST_DIRNAME}/lib/no-python3.bash"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${FAKE_HOME}/.claude/hooks" "${FAKE_HOME}/.claude/agents" \
    "${FAKE_HOME}/.glass-atrium/hooks" "${FAKE_HOME}/.glass-atrium/agents"

  # Seeded EXISTING agent file — identity keys + excluded model key + a body whose
  # text deliberately contains an identity-SHAPED line (must NOT block a body edit).
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" <<'MD'
---
name: glass-atrium-dev-shell
tools: [Read, Bash]
scope: DEV
model: claude-model-a
---
# Body

Body paragraph mentioning name: not-frontmatter inside the body.
MD
}

# Build an envelope with jq and run the hook under FAKE_HOME — DIRECT invocation.
# Args: $1=tool_name $2=tool_input JSON object $3=agent_id (optional, "" = main session).
run_hook() {
  local tool="${1}" tin="${2}" agent="${3:-}" envelope
  if [[ -n "${agent}" ]]; then
    envelope="$(jq -cn --arg t "${tool}" --arg a "${agent}" --argjson ti "${tin}" \
      '{tool_name: $t, agent_id: $a, tool_input: $ti}')"
  else
    envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" \
      '{tool_name: $t, tool_input: $ti}')"
  fi
  run env "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

# Same, but under a narrowed PATH. The bin dir MUST carry env + bash so the
# hook's shebang still resolves under direct execution.
# Args: $1=bin dir $2=tool_name $3=tool_input JSON object.
run_hook_on_path() {
  local bindir="${1}" tool="${2}" tin="${3}" envelope
  envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" \
    '{tool_name: $t, tool_input: $ti}')"
  run env "PATH=${bindir}" "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

# Symlink the named real tools into a bin dir. Args: $1=dir, rest=tool names.
link_bin() {
  local bindir="${1}" tool src
  shift
  mkdir -p "${bindir}"
  for tool in "$@"; do
    if src="$(command -v "${tool}")"; then ln -sf "${src}" "${bindir}/${tool}"; fi
  done
  printf '%s\n' "${bindir}"
}

# PATH where python3 is a stub running the given body — jq and the shebang tools
# stay real, so this isolates classifier FAILURE from python3 ABSENCE.
# Args: $1=stub body.
bin_with_broken_python3() {
  local bindir
  bindir="$(link_bin "${BATS_TEST_TMPDIR}/pybroken" env bash jq basename cat grep tr sed mktemp dirname)"
  printf '#!/usr/bin/env bash\n%s\n' "${1}" >"${bindir}/python3"
  chmod +x "${bindir}/python3"
  printf '%s\n' "${bindir}"
}

# PATH with jq stripped and python3 real — drives the pure-bash escaper fallback.
bin_without_jq() {
  link_bin "${BATS_TEST_TMPDIR}/nojq" env bash python3 basename cat grep tr sed mktemp dirname
}

# A protected path whose bytes break raw JSON interpolation (quote + backslash).
quoted_hook_path() { printf '%s' "${FAKE_HOME}/.glass-atrium/hooks/a\"b\\c.sh"; }

# jq-built Write/Edit tool_input helpers (nested quotes stay well-formed).
write_input() { jq -cn --arg p "${1}" --arg c "${2}" '{file_path: $p, content: $c}'; }
edit_input() { jq -cn --arg p "${1}" --arg o "${2}" --arg n "${3}" '{file_path: $p, old_string: $o, new_string: $n}'; }
bash_input() { jq -cn --arg c "${1}" '{command: $c}'; }

# ── AC2-1: block classes, each with AND without agent_id ─────────────────────

@test "live settings.json Write (main session) → HAR-001 block (exit 2)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/settings.json" '{"hooks":{}}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
}

@test "live settings.json Write (subagent, agent_id present) → block (agent_id-independent)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/settings.json" '{"hooks":{}}')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "live settings.local.json Edit → block (exit 2)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.claude/settings.local.json" 'x' 'y')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "live GA hooks dir Write (main session) → block (exit 2)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/hooks/track-outcome.sh" 'echo pwned')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "live GA hooks dir Write (subagent) → block (agent_id-independent)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/hooks/track-outcome.sh" 'echo pwned')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "legacy claude hooks dir Edit → block (exit 2)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.claude/hooks/legacy.sh" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "traversal cannot dodge the prefix: .claude/x/../settings.json → block" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/x/../settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "agents identity Edit: tools line (main session) → block (exit 2)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"identity-frontmatter-edit"* ]] || return 1
}

@test "agents identity Edit: tools line (subagent) → block (agent_id-independent)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "agents identity Write: existing file with changed scope line → block" {
  local content
  content="$(printf -- '---\nname: glass-atrium-dev-shell\ntools: [Read, Bash]\nscope: QA\nmodel: claude-model-a\n---\n# Body\n')"
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" "${content}")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"identity-frontmatter-write"* ]] || return 1
}

@test "NEW agents/*.md Write (main session) → block (agent_lifecycle CLI owns creation)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-new.md" $'---\nname: x\n---\nbody')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"new-agent-creation"* ]] || return 1
}

@test "NEW agents/*.md Write (subagent) → block (agent_id-independent)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/agents/glass-atrium-dev-new.md" $'---\nname: x\n---\nbody')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

# ── Fence-tamper guards: the 3-step fence-removal bypass is cut ──────────────

@test "agents fence-removal Edit (closing ---, no identity key) → block" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    $'---\n# Body' '# Body')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"frontmatter-fence-edit"* ]] || return 1
}

@test "agents fence-insertion Edit inside frontmatter → block (span-shrink attempt)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'model: claude-model-a' $'---\nmodel: claude-model-a')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"frontmatter-fence-edit"* ]] || return 1
}

@test "agents Edit on UNTERMINATED-fence file (value-only old_string) → block" {
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" <<'MD'
---
name: glass-atrium-dev-broken
tools: [Read]
scope: DEV
# Body without a closing fence
MD
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" \
    '[Read]' '[Read, Bash, Write]')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"unterminated-frontmatter"* ]] || return 1
}

@test "agents Write onto UNTERMINATED-fence file → block (tampered state frozen)" {
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" <<'MD'
---
name: glass-atrium-dev-broken
# Body without a closing fence
MD
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" 'anything')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"unterminated-frontmatter"* ]] || return 1
}

@test "agents body Edit touching a body --- hr → pass (fence guard is overlap-scoped)" {
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-hr.md" <<'MD'
---
name: glass-atrium-dev-hr
tools: [Read]
scope: DEV
---
# Body

---

After the horizontal rule.
MD
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-hr.md" \
    $'---\n\nAfter the horizontal rule.' 'After the rule.')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-2: body / model-line edits pass (0 false blocks) ─────────────────────

@test "agents body-only Edit → pass (exit 0)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'Body paragraph mentioning' 'Body paragraph now mentioning')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "agents body Edit touching an identity-SHAPED body line → pass (no frontmatter overlap)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'name: not-frontmatter' 'name: still-not-frontmatter')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "agents model-line Edit → pass (model excluded from identity set)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'model: claude-model-a' 'model: claude-model-b')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "agents Write of existing file: identity unchanged, model+body changed → pass" {
  local content
  content="$(printf -- '---\nname: glass-atrium-dev-shell\ntools: [Read, Bash]\nscope: DEV\nmodel: claude-model-b\n---\n# New body\n')"
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" "${content}")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "repo-tree agents path (outside HOME anchors) → pass (git tree untouched)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/git/glass-atrium/agents/glass-atrium-dev-shell.md" 'x')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "unprotected path Write → pass (exit 0)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/project/src/app.ts" 'code')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── H1: scheduled-execution surface — autoagent/ + scripts/ + skills/ ─────────
#
# launchd runs autoagent/ code unattended, so a plain Write/Edit persists code the
# scheduler later executes (LLM06). H1 extends BOTH arms to the three dirs. Every
# block row is exit-0 at HEAD (no deterministic case, no PROT_RE literal) and
# exit-2 after — a genuine before/after. rules/ + scoped/ are EXCLUDED by design
# (H1-D1); the four permit rows guard that exclusion against a later
# "complete the pattern" edit.

@test "H1 Write into autoagent/ → HAR-001 scheduled-exec block" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/autoagent/daemon-apply.sh" 'echo pwned')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" == *"scheduled-exec-dir"* ]] || return 1
}

@test "H1 Edit into autoagent/ → block (agent cannot rewrite scheduled code)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/autoagent/daemon_cycle.py" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"scheduled-exec-dir"* ]] || return 1
}

@test "H1 Write into scripts/ → block" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/scripts/generate-manifest.sh" 'x')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"scheduled-exec-dir"* ]] || return 1
}

@test "H1 Edit into scripts/ → block" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/scripts/wiki-query.sh" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "H1 Write into skills/ → block" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/skills/foo/SKILL.md" 'x')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"scheduled-exec-dir"* ]] || return 1
}

@test "H1 Edit into skills/ → block" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/skills/foo/SKILL.md" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
}

# Bash arm — redirect / copy verb targeting the three dirs (3 of 3 blocked).

@test "H1 bash redirect into autoagent/ → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'echo x > ~/.glass-atrium/autoagent/daemon-apply.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "H1 bash cp into scripts/ → block" {
  run_hook "Bash" "$(bash_input 'cp /tmp/evil.sh ~/.glass-atrium/scripts/generate-manifest.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "H1 bash tee into skills/ → block" {
  run_hook "Bash" "$(bash_input 'echo pwn | tee ~/.glass-atrium/skills/foo/SKILL.md')"
  [[ "${status}" -eq 2 ]] || return 1
}

# rules/ + scoped/ DELIBERATELY EXCLUDED (H1-D1) — permit rows guard the exclusion.

@test "H1 Write into rules/ → pass (excluded, hand-edited live)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/rules/glass-atrium/foo.md" 'x')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "H1 Edit into rules/ → pass (excluded)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/rules/glass-atrium/foo.md" 'a' 'b')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "H1 Write into scoped/ → pass (excluded)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/scoped/scope-dev.md" 'x')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "H1 Edit into scoped/ → pass (excluded)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/scoped/scope-dev.md" 'a' 'b')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-3: launch-env approval grant ─────────────────────────────────────────

@test "HARNESS_PROTECTION_APPROVE=1 launch env passes an otherwise-blocked write" {
  local envelope
  envelope="$(jq -cn --arg p "${FAKE_HOME}/.claude/settings.json" \
    '{tool_name: "Write", tool_input: {file_path: $p, content: "{}"}}')"
  run env "HOME=${FAKE_HOME}" HARNESS_PROTECTION_APPROVE=1 "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-4: python3-absent fail-closed (HAR-003) ──────────────────────────────

# Shared fixture: minimal_bin_without_python3 comes from lib/no-python3.bash
# (sourced in setup). These two rows are the file's ONLY sanctioned interpreter-
# prefixed invocations (see the header's INVOCATION CONVENTION): direct execution
# would have to resolve `#!/usr/bin/env bash` through the shared lib's stripped bin
# roster, which this suite does not own. They assert a PATH condition, not the
# executable bit — every other row exercises that directly.

@test "python3 absent + protected write → HAR-003 block (fail-closed, exit 2)" {
  local bindir
  bindir="$(minimal_bin_without_python3)"
  run env "PATH=${bindir}" "HOME=${FAKE_HOME}" bash -c '
    printf "%s" "$1" | bash "$2"
  ' _ "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${FAKE_HOME}/.claude/settings.json\",\"content\":\"{}\"}}" "${HOOK_SH}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-003"* ]] || return 1
}

@test "python3 absent + empty stdin → pass (no over-block of empty input)" {
  local bindir
  bindir="$(minimal_bin_without_python3)"
  run env "PATH=${bindir}" "HOME=${FAKE_HOME}" bash -c '
    printf "%s" "" | bash "$1"
  ' _ "${HOOK_SH}"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── F1: classifier PRESENT but FAILING → fail-closed HAR-003 ─────────────────
#
# Distinct from the python3-ABSENT rows above: here `command -v python3` succeeds,
# so the absence guard never fires. The regression these rows pin is the classifier
# exiting non-zero while the fallback emptied TARGET, which the empty-target guard
# then converted into a silent exit-0 pass — a blocking hook inverted to fail-open.
# Direct hook execution (no interpreter prefix): the executable bit is part of the
# behavior under test.

@test "classifier exits non-zero with no output → HAR-003 block (fail-closed)" {
  local bindir
  bindir="$(bin_with_broken_python3 'exit 1')"
  run_hook_on_path "${bindir}" "Write" \
    "$(write_input "${FAKE_HOME}/.claude/settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-003"* ]] || return 1
  [[ "${output}" == *"classifier-failure"* ]] || return 1
}

@test "classifier emits partial fields then crashes → HAR-003 block (misaligned trailer)" {
  local bindir
  bindir="$(bin_with_broken_python3 'printf "Write\0"; exit 1')"
  run_hook_on_path "${bindir}" "Write" \
    "$(write_input "${FAKE_HOME}/.claude/settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-003"* ]] || return 1
}

@test "classifier emits a full allow verdict then exits 1 → HAR-003 block (no pass smuggling)" {
  local bindir
  bindir="$(bin_with_broken_python3 'printf "Write\0/tmp/harmless.ts\0allow\0"; exit 1')"
  run_hook_on_path "${bindir}" "Write" \
    "$(write_input "${FAKE_HOME}/.claude/settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-003"* ]] || return 1
}

@test "classifier failure on a NON-protected envelope → pass (blast radius stays prefiltered)" {
  local bindir
  bindir="$(bin_with_broken_python3 'exit 1')"
  run_hook_on_path "${bindir}" "Write" "$(write_input "/tmp/app/src/main.ts" 'x')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── F3: block context survives quote/backslash bytes, jq present AND absent ───
#
# Raw string interpolation of the target produced malformed JSON, which emit_error's
# --argjson then degraded to {} — dropping BOTH class and target from every block
# record on such a path. The jq-absent half also pins AC-T1-4: a bare jq call would
# die exit-127 under errexit, and a non-2 hook exit is NON-blocking to the harness.

@test "quote+backslash target (jq present) → block context retains class AND target" {
  local path ctx_class ctx_target
  path="$(quoted_hook_path)"
  run_hook "Write" "$(write_input "${path}" 'x')"
  [[ "${status}" -eq 2 ]] || return 1
  ctx_class="$(printf '%s' "${output}" | jq -r '.context.class')"
  ctx_target="$(printf '%s' "${output}" | jq -r '.context.target')"
  [[ "${ctx_class}" == "live-hooks-dir" ]] || return 1
  [[ "${ctx_target}" == "${path}" ]] || return 1
}

@test "quote+backslash target (jq absent) → block context retains class AND target" {
  local bindir path ctx_class ctx_target
  bindir="$(bin_without_jq)"
  path="$(quoted_hook_path)"
  run_hook_on_path "${bindir}" "Write" "$(write_input "${path}" 'x')"
  [[ "${status}" -eq 2 ]] || return 1
  ctx_class="$(printf '%s' "${output}" | jq -r '.context.class')"
  ctx_target="$(printf '%s' "${output}" | jq -r '.context.target')"
  [[ "${ctx_class}" == "live-hooks-dir" ]] || return 1
  [[ "${ctx_target}" == "${path}" ]] || return 1
}

@test "jq absent + protected write → exit 2, never a non-2 interpreter death" {
  local bindir
  bindir="$(bin_without_jq)"
  run_hook_on_path "${bindir}" "Write" \
    "$(write_input "${FAKE_HOME}/.claude/settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
}

# ── Hot-path prefilter: no protected-root literal → exit 0, zero python3 spawns ──

@test "prefilter: non-protected envelope → pass without invoking python3" {
  # A recording python3 stub shadows the real one; the hook must exit 0 via the
  # pure-bash prefilter (envelope carries neither ".claude" nor ".glass-atrium"),
  # so the stub marker must stay absent.
  local stubdir="${BATS_TEST_TMPDIR}/stubbin" marker="${BATS_TEST_TMPDIR}/python3-called"
  mkdir -p "${stubdir}"
  printf '#!/usr/bin/env bash\ntouch "%s"\nexit 0\n' "${marker}" >"${stubdir}/python3"
  chmod +x "${stubdir}/python3"
  run env "PATH=${stubdir}:${PATH}" "HOME=${FAKE_HOME}" "${HOOK_SH}" \
    <<<'{"tool_name":"Write","tool_input":{"file_path":"/tmp/app/src/main.ts","content":"x"}}'
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${marker}" ]] || return 1
}

# ── AC2-5: Bash arm — mutation verb + protected-path literal ─────────────────

@test "bash: redirection overwrite into live settings → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'echo x > ~/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "bash: redirection append into live settings → block" {
  run_hook "Bash" "$(bash_input 'echo x >> ~/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: tee into live GA hooks dir → block" {
  run_hook "Bash" "$(bash_input 'echo pwn | tee ~/.glass-atrium/hooks/track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: cp into legacy claude hooks dir → block" {
  run_hook "Bash" "$(bash_input 'cp /tmp/evil.sh ~/.claude/hooks/evil.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: mv onto live agents file → block" {
  run_hook "Bash" "$(bash_input 'mv /tmp/x.md ~/.glass-atrium/agents/glass-atrium-dev-shell.md')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: ln -sfn into live hooks dir → block" {
  run_hook "Bash" "$(bash_input 'ln -sfn /tmp/evil.sh ~/.claude/hooks/x.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: sed -i in-place on live hook (\$HOME form) → block" {
  run_hook "Bash" "$(bash_input "sed -i '' 's/a/b/' \$HOME/.glass-atrium/hooks/a.sh")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: read-only use of a protected path (cat | tee /tmp) → pass" {
  run_hook "Bash" "$(bash_input 'cat ~/.claude/settings.json | tee /tmp/out')"
  [[ "${status}" -eq 0 ]] || return 1
}

# Quoted '>' inside an argument is NOT a redirect shape — read-only commands on
# protected paths must not false-block (reproduced review false-positives).

@test "bash: grep -- '->' on live settings → pass (quoted >, not a redirect)" {
  run_hook "Bash" "$(bash_input "grep -- '->' ~/.claude/settings.json")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: grep '=>' on live agents file → pass (quoted >, not a redirect)" {
  run_hook "Bash" "$(bash_input "grep '=>' ~/.glass-atrium/agents/glass-atrium-dev-shell.md")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: awk comparison '\$1 > 5' on live hook → pass (target token is not protected)" {
  run_hook "Bash" "$(bash_input "awk '\$1 > 5' ~/.glass-atrium/hooks/a.sh")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: variable-indirection residual → pass (documented, bar-raising only)" {
  run_hook "Bash" "$(bash_input 'P=~/.claude/settings.json; echo x > "$P"')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: unrelated command → pass" {
  run_hook "Bash" "$(bash_input 'ls -la /tmp')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── Bash arm: chmod permission verb + launchd-plist protected path ────────────
#
# chmod is a mutation verb (a mode-644 flip silently disarms a live hook); the
# harness launchctl-bootstrap plists (com.{claude,glass-atrium}.*.plist) are
# protected-path literals. Both are Bash-arm-only additions — a chmod or a plist
# write is unguarded at HEAD (verdict allow → exit 0), so each row below fails
# before the change and passes after.

@test "bash: chmod on live GA hooks dir → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'chmod +x ~/.glass-atrium/hooks/track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "bash: chmod on live settings.json (\$HOME form) → block" {
  run_hook "Bash" "$(bash_input 'chmod 600 $HOME/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: chmod on a launchd plist → block" {
  run_hook "Bash" "$(bash_input 'chmod 644 ~/Library/LaunchAgents/com.glass-atrium.monitor.plist')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "bash: redirect write into a launchd plist → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'echo x > ~/Library/LaunchAgents/com.glass-atrium.monitor.plist')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "bash: cp into a launchd plist (autoagent-daemon) → block" {
  run_hook "Bash" "$(bash_input 'cp /tmp/evil.plist ~/Library/LaunchAgents/com.glass-atrium.autoagent-daemon.plist')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: tee into a legacy com.claude launchd plist → block (legacy label)" {
  run_hook "Bash" "$(bash_input 'echo x | tee ~/Library/LaunchAgents/com.claude.monitor.plist')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: chmod on an unprotected path → pass (no false-block)" {
  run_hook "Bash" "$(bash_input 'chmod +x ~/project/build.sh')"
  [[ "${status}" -eq 0 ]] || return 1
}

# 'chmod' as an argument word, not a command-position verb — must not false-block.
@test "bash: chmod as an argument word (echo) → pass (command-position anchored)" {
  run_hook "Bash" "$(bash_input 'echo run chmod on ~/.claude/hooks/x.sh manually')"
  [[ "${status}" -eq 0 ]] || return 1
}

# The launchd alternation needs a mutation verb / redirect — a read-only reference
# to a plist path must pass (no verb in command position, no redirect shape).
@test "bash: read-only cat of a launchd plist → pass" {
  run_hook "Bash" "$(bash_input 'cat ~/Library/LaunchAgents/com.glass-atrium.monitor.plist')"
  [[ "${status}" -eq 0 ]] || return 1
}
