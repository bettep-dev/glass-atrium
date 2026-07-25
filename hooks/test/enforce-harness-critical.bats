#!/usr/bin/env bats
# enforce-harness-critical.sh — envelope-driven suite (plan clauded-docs/285 T2).
#
# PreToolUse(Write|Edit + Bash) harness-critical gate, agent_id-INDEPENDENT:
#   Write|Edit arm → live settings.json/settings.local.json · live hook dirs ·
#   agents/*.md frontmatter identity keys {name, tools, scope} (model excluded,
#   body edits pass) · NEW agents/*.md Write · scheduled-exec dirs
#   autoagent/+scripts/+skills/ (rules/+scoped/ EXCLUDED per H1-D1). Bash arm →
#   best-effort, three block classes over three shared structural pre-passes
#   (heredoc stripping · quote mask · ordered segmenter with a cwd-arming flag):
#   bash-mutation (redirect / command-position verb + protected-path literal, in
#   its file OR bare-directory spelling), bash-interp-write (interpreter
#   code-string write, discriminated by ARGUMENT POSITION so a protected path
#   READ passes), bash-cwd-relative-write (relative write from an armed cwd,
#   incl. an unnameable `cd -` / `popd` return). Indirection residual PASSES by
#   design.
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

# ── P0-2: tilde-form targets — hook_normalize_path leading-~ expansion ────────
#
# A tool envelope carries file_path VERBATIM (the shell never expanded it), so a
# "~/" target dodged every ${HOME}-anchored case arm before the expansion landed
# in hook_normalize_path — each block row here was exit-0 at HEAD. "~user" stays
# literal by design (no portable resolution on stock Bash 3.2) → still passes.
# SC2088 disabled per-row: the quoted leading ~ IS the literal under test — an
# envelope byte, not a tilde meant for shell expansion.

# shellcheck disable=SC2088
@test "P0-2 tilde Edit into autoagent/ → HAR-001 block (tilde no longer dodges)" {
  run_hook "Edit" "$(edit_input '~/.glass-atrium/autoagent/daemon-apply.sh' 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" == *"scheduled-exec-dir"* ]] || return 1
}

# shellcheck disable=SC2088
@test "P0-2 tilde Write onto live settings.json → HAR-001 block" {
  run_hook "Write" "$(write_input '~/.claude/settings.json' '{"hooks":{}}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
}

# shellcheck disable=SC2088
@test "P0-2 tilde + traversal Edit into live GA hooks dir → block" {
  run_hook "Edit" "$(edit_input '~/x/../.glass-atrium/hooks/track-outcome.sh' 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"live-hooks-dir"* ]] || return 1
}

# shellcheck disable=SC2088
@test "P0-2 ~user form stays literal → pass (deliberately not expanded)" {
  run_hook "Edit" "$(edit_input '~other/.glass-atrium/autoagent/daemon-apply.sh' 'a' 'b')"
  [[ "${status}" -eq 0 ]] || return 1
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

# ── R2-2: the bare-directory spelling of a protected path ────────────────────
#
# PROT_RE matches the FILE form (`.glass-atrium/hooks/`, slash included), so a
# target written as a directory — the conventional `cp src <dir>` spelling —
# matched nothing at the redirect and mutation-verb sites while the identical
# trailing-slash form blocked. Both spellings are asserted together so the two
# call sites cannot drift apart again.

@test "R2-2 cp into a protected dir: no trailing slash AND trailing slash → block" {
  run_hook "Bash" "$(bash_input 'cp /tmp/e.sh ~/.glass-atrium/hooks')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-mutation"* ]] || return 1
  run_hook "Bash" "$(bash_input 'cp /tmp/e.sh ~/.glass-atrium/hooks/')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-2 redirect whose target is a bare protected dir → block" {
  run_hook "Bash" "$(bash_input 'echo x > ~/.glass-atrium/agents')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'echo x > ~/.claude/hooks')"
  [[ "${status}" -eq 2 ]] || return 1
}

# The name-boundary lookahead is what keeps the dir form from over-reaching —
# it must survive being wired into the two new call sites.
@test "R2-2-neg cp into a longer sibling dir name → pass (boundary lookahead)" {
  run_hook "Bash" "$(bash_input 'cp /tmp/e.sh ~/.glass-atrium/autoagent-backup')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cp /tmp/e.sh ~/.glass-atrium/rules')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── Arm A: interpreter code-string writes (bash-interp-write) ─────────────────
#
# A write expressed as a call inside a -c/-e code string presents NEITHER legacy
# shape: no '>' character exists anywhere, and no interpreter is in the verb
# alternation. Every block row here is exit-0 at HEAD. The conjunctive
# requirement (write-intent API AND a protected path, both inside the extracted
# code string) is what keeps the read rows below passing.

@test "ArmA python3 -c open(...,'w') → HAR-002 bash-interp-write block" {
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.glass-atrium/autoagent/daemon-apply.sh','w').write('x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "ArmA python3 -c open() write modes a / w+ / r+ → block (each mode)" {
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.glass-atrium/autoagent/f','a')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.glass-atrium/autoagent/f','w+')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.glass-atrium/autoagent/f','r+')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA python3 Path().write_text → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"Path('~/.glass-atrium/scripts/x.sh').write_text('x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "ArmA python3 shutil.copy onto a protected path → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"import shutil;shutil.copy('/tmp/e','~/.glass-atrium/hooks/a.sh')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA python3 os.remove / os.chmod on a protected path → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"import os;os.remove('~/.glass-atrium/hooks/a.sh')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"import os;os.chmod('~/.glass-atrium/hooks/a.sh',0o644)\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA node -e writeFileSync → block" {
  run_hook "Bash" "$(bash_input "node -e \"require('fs').writeFileSync('~/.glass-atrium/autoagent/f','x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "ArmA node --eval appendFileSync → block (long code flag)" {
  run_hook "Bash" "$(bash_input "node --eval \"fs.appendFileSync('~/.glass-atrium/autoagent/f','x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA perl -e open with a > mode → block" {
  run_hook "Bash" "$(bash_input "perl -e \"open(F,'>','~/.glass-atrium/autoagent/f')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "ArmA perl -i -pe in-place on a protected path → block (path is an argument)" {
  run_hook "Bash" "$(bash_input "perl -i -pe 's/a/b/' ~/.glass-atrium/autoagent/daemon-apply.sh")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "perl -pi -e 's/a/b/' ~/.glass-atrium/autoagent/daemon-apply.sh")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA ruby -e File.write → block" {
  run_hook "Bash" "$(bash_input "ruby -e \"File.write('~/.glass-atrium/autoagent/f','x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA ruby -i -pe in-place on a protected path → block" {
  run_hook "Bash" "$(bash_input "ruby -i -pe 'gsub(/a/,\"b\")' ~/.glass-atrium/autoagent/daemon-apply.sh")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA env-prefixed / absolute-binary / version-suffixed interpreters → block" {
  run_hook "Bash" "$(bash_input "/usr/bin/env python3 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "/opt/homebrew/bin/node -e \"fs.writeFileSync('~/.glass-atrium/autoagent/f','x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "python3.12 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA assignment / sudo prefix before the interpreter → block" {
  run_hook "Bash" "$(bash_input "FOO=1 python3 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "sudo python3 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA interpreter after | && ; and inside ( → block (command-position variants)" {
  run_hook "Bash" "$(bash_input "echo hi | python3 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "true && python3 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "true ; python3 -c \"open('~/.glass-atrium/autoagent/f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "(python3 -c \"open('~/.glass-atrium/autoagent/f','w')\")")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmA interpreter write onto a launchd plist literal → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/Library/LaunchAgents/com.glass-atrium.monitor.plist','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "ArmA os.system shell escape → block (escaped string re-scanned as shell)" {
  run_hook "Bash" "$(bash_input "python3 -c \"import os;os.system('cp /tmp/e ~/.glass-atrium/autoagent/daemon-apply.sh')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

# Reading a protected file THROUGH an interpreter is the production false-positive
# class. A closed write-intent allowlist does NOT settle it on its own: a code
# string may legitimately write SOMEWHERE ELSE while only READING the protected
# path, and matching write-intent and the path independently blocked exactly
# that. What makes these pass is the ARGUMENT-POSITION check — a protected
# literal blocks only where the API writes. The R2-1 rows below pair each read
# shape with its write-position twin so the discrimination cannot collapse in
# either direction (all-pass or all-block).

@test "ArmA-neg python3 json.load / .read() of a protected path → pass" {
  run_hook "Bash" "$(bash_input "python3 -c \"import json;print(json.load(open('~/.claude/settings.json')))\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"print(open('~/.claude/settings.json').read())\"")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmA-neg sys.stdout.write(open(p).read()) → pass (bare .write( excluded)" {
  run_hook "Bash" "$(bash_input "python3 -c \"import sys;sys.stdout.write(open('~/.claude/settings.json').read())\"")"
  [[ "${status}" -eq 0 ]] || return 1
}

# A non-mode keyword whose value merely CONTAINS a mode letter ('replace') must
# not pose as a write mode — the mode string is matched whole.
@test "ArmA-neg open(p,'r',errors='replace') → pass (mode matched whole)" {
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.claude/settings.json','r',errors='replace').read()\"")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmA-neg python3 -m module form → pass (code flag absent from the flag run)" {
  run_hook "Bash" "$(bash_input 'python3 -m json.tool ~/.claude/settings.json')"
  [[ "${status}" -eq 0 ]] || return 1
}

# Sanctioned CLI: agent creation traverses the session Bash tool as `python3 -m`.
# It passes because of the code-flag requirement, NOT an exemption — this row
# pins that a later "also match -m" edit cannot silently break agent creation.
@test "ArmA-neg python3 -m agent_lifecycle → pass (sanctioned CLI unchanged)" {
  run_hook "Bash" "$(bash_input 'python3 -m agent_lifecycle sync-inject --root ~/.glass-atrium/agents')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmA-neg python3 script-file form → pass (no code flag)" {
  run_hook "Bash" "$(bash_input 'python3 /opt/tools/dump.py ~/.claude/settings.json')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmA-neg node readFileSync / -p require → pass" {
  run_hook "Bash" "$(bash_input "node -e \"console.log(fs.readFileSync('~/.claude/settings.json','utf8'))\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "node -p \"require('~/.claude/settings.json').x\"")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmA-neg perl -pe without -i / ruby File.read → pass" {
  run_hook "Bash" "$(bash_input "perl -pe 's/a/b/' ~/.claude/settings.json")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "ruby -e \"puts File.read('~/.claude/settings.json')\"")"
  [[ "${status}" -eq 0 ]] || return 1
}

# jq has no file-write primitive, so it is deliberately NOT in the interpreter
# class — its '>' redirect stays the redirect arm's job.
@test "ArmA-neg jq read of live settings → pass (jq is not an interpreter)" {
  run_hook "Bash" "$(bash_input "jq -r '.model' ~/.claude/settings.json")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmA-neg read-only verbs on protected paths → pass" {
  run_hook "Bash" "$(bash_input 'grep -n foo ~/.claude/settings.json')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'head -5 ~/.claude/settings.json')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'wc -l ~/.glass-atrium/hooks/a.sh')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "sed -n '1,5p' ~/.claude/settings.json")"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── R2-1: write-POSITION discrimination inside interpreter code strings ───────
#
# Reproduced review regression: a code string that READS a protected path while
# writing somewhere unprotected blocked (exit 2) — write intent and the path
# were matched independently, so any co-occurrence sufficed. Each row pairs the
# read shape (must pass) with the same API called with the arguments swapped
# (must block), which is the only way a fix can be shown to discriminate rather
# than flip the default.

@test "R2-1 shutil.copy: FROM a protected path → pass · INTO one → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"import shutil;shutil.copy('~/.claude/settings.json','/tmp/backup.sh')\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"import shutil;shutil.copy('/tmp/backup.sh','~/.claude/settings.json')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "R2-1 json round-trip: load(protected) + dump(/tmp) → pass · dump(protected) → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"import json;d=json.load(open('~/.claude/settings.json'));json.dump(d,open('/tmp/o.json','w'))\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"import json;d=json.load(open('/tmp/o.json'));json.dump(d,open('~/.claude/settings.json','w'))\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-1 open('/tmp','w').write(open(protected).read()) → pass · swapped → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"open('/tmp/o','w').write(open('~/.claude/settings.json').read())\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.claude/settings.json','w').write(open('/tmp/o').read())\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-1 node writeFileSync(/tmp, readFileSync(protected)) → pass · swapped → block" {
  run_hook "Bash" "$(bash_input "node -e \"fs.writeFileSync('/tmp/o.json', fs.readFileSync('~/.claude/settings.json','utf8'))\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "node -e \"fs.writeFileSync('~/.claude/settings.json', fs.readFileSync('/tmp/o.json','utf8'))\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-1 ruby File.write('/tmp', File.read(protected)) → pass · swapped → block" {
  run_hook "Bash" "$(bash_input "ruby -e \"File.write('/tmp/o', File.read('~/.claude/settings.json'))\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "ruby -e \"File.write('~/.claude/settings.json', File.read('/tmp/o'))\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

# perl names its target after the mode in the 3-arg form and inside it in the
# 2-arg form, so read/write discrimination there is the mode, not the position.
@test "R2-1 perl open: read handle on a protected path → pass · '>' handle → block" {
  run_hook "Bash" "$(bash_input "perl -e \"open(I,'<','~/.claude/settings.json');open(O,'>','/tmp/o')\"")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "perl -e \"open(I,'<','/tmp/o');open(O,'>','~/.claude/settings.json')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

# The move/rename family DESTROYS its source, so a protected SOURCE is a write
# to the protected path — the position rule admits it deliberately.
@test "R2-1 shutil.move OUT of a protected path → block (source is destroyed)" {
  run_hook "Bash" "$(bash_input "python3 -c \"import shutil;shutil.move('~/.glass-atrium/hooks/a.sh','/tmp/a.sh')\"")"
  [[ "${status}" -eq 2 ]] || return 1
}

# ── R2-4: two-char redirect operators (>| clobber, >& fd-or-file, &>) ─────────
#
# `>|` and `>&` were structurally invisible: the segmenter split on the unquoted
# | / & BEFORE tokenizing, stranding the operator at a segment end so its target
# token was never examined. `&>` already reached the recogniser (the split
# leaves `> target` intact) — it is pinned here so the segmenter change cannot
# regress it silently.

@test "R2-4 clobber redirect >| into live settings → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'echo x >| ~/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "R2-4 >& redirect into a live hook file → block" {
  run_hook "Bash" "$(bash_input 'echo x >& ~/.glass-atrium/hooks/track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-4 &> redirect into live settings → block (separator-form, pinned)" {
  run_hook "Bash" "$(bash_input 'echo x &> ~/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
}

# A bare fd after >& names no path — the armed relative-target rule must not
# read the `1` of `2>&1` as a filename.
@test "R2-4-neg fd dup 2>&1 while armed → pass (no false relative target)" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && grep x f 2>&1')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && grep x f 2>&1 > /tmp/out')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── R2-6: mutation-verb allowlist additions (CLOSED set, no wildcarding) ──────

@test "R2-6 install / rsync / truncate onto a protected path → block" {
  run_hook "Bash" "$(bash_input 'install -m 755 /tmp/e.sh ~/.glass-atrium/hooks/a.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-mutation"* ]] || return 1
  run_hook "Bash" "$(bash_input 'rsync -a /tmp/e.sh ~/.glass-atrium/hooks/a.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'truncate -s 0 ~/.glass-atrium/hooks/a.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

# dd names its target in of= — if= is the READ source, so the segment-wide match
# the other verbs use would have blocked a backup taken FROM a protected path.
@test "R2-6 dd of= a protected path → block · dd if= a protected path → pass" {
  run_hook "Bash" "$(bash_input 'dd if=/tmp/e.sh of=~/.glass-atrium/hooks/a.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-mutation"* ]] || return 1
  run_hook "Bash" "$(bash_input 'dd if=~/.glass-atrium/hooks/a.sh of=/tmp/backup.sh')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "R2-6 cp -t into a protected dir → block (target precedes the sources)" {
  run_hook "Bash" "$(bash_input 'cp -t ~/.glass-atrium/hooks /tmp/e.sh /tmp/f.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-6 sed --in-place on a protected path → block (long twin of sed -i)" {
  run_hook "Bash" "$(bash_input "sed --in-place 's/a/b/' ~/.glass-atrium/hooks/a.sh")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "sed --in-place=.bak 's/a/b/' ~/.glass-atrium/hooks/a.sh")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-6-neg the added verbs on unprotected paths → pass (no false blocks)" {
  run_hook "Bash" "$(bash_input 'install -m 755 /tmp/e.sh /tmp/dest.sh')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'rsync -a /tmp/a/ /tmp/b/')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'dd if=/tmp/a of=/tmp/b')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'truncate -s 0 /tmp/log')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "sed --in-place 's/a/b/' /tmp/f.txt")"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── Arm B: cwd-context tracking (bash-cwd-relative-write) ─────────────────────
#
# The arm is a TEXT state machine — no filesystem canonicalization. A PreToolUse
# gate must not stat the FS (the target usually does not exist yet), and arming
# needs only a boolean: every spelling of the cd argument carries the protected
# literal. Every block row here is exit-0 at HEAD.

@test "ArmB cd into a protected dir then relative redirect → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && printf x > daemon-apply.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
  [[ "${output}" == *"bash-cwd-relative-write"* ]] || return 1
}

@test "ArmB semicolon separator + append redirect → block" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent; printf x >> daemon-apply.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmB armed mutation verbs (cp / tee / sed -i / chmod) with relative targets → block" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && cp /tmp/e.sh daemon-apply.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/hooks && echo x | tee track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "cd ~/.glass-atrium/hooks && sed -i '' s/a/b/ track-outcome.sh")"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/hooks && chmod 644 track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "ArmB subshell and pushd arming forms → block" {
  run_hook "Bash" "$(bash_input '(cd ~/.glass-atrium/autoagent && printf x > f)')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'pushd ~/.glass-atrium/autoagent && printf x > f')"
  [[ "${status}" -eq 2 ]] || return 1
}

# Arming spellings: no trailing slash, trailing slash, quoted $HOME, tilde, and
# an absolute /Users path all carry the protected literal → all arm.
@test "ArmB arming spellings (bare / slash / quoted \$HOME / tilde / absolute) → block" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && printf x > f')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent/ && printf x > f')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd "$HOME/.glass-atrium/autoagent" && printf x > f')"
  [[ "${status}" -eq 2 ]] || return 1
  run_hook "Bash" "$(bash_input "cd ${FAKE_HOME}/.glass-atrium/autoagent && printf x > f")"
  [[ "${status}" -eq 2 ]] || return 1
}

# `cd ..` while armed STAYS armed — the alternative is a one-line bypass
# (cd <prot>/sub && cd .. && printf > f).
@test "ArmB relative cd while armed stays armed → block" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent/lib && cd .. && printf x > daemon-apply.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

# Deliberate over-approximation: while armed, a write-intent interpreter call
# blocks WITHOUT a protected-path match, because the relative target lives
# inside the code string. The precondition (an explicit unquoted cd into a
# protected dir in the SAME command) keeps the cost narrow.
@test "ArmB armed + interpreter write without a path match → block (documented over-approximation)" {
  run_hook "Bash" "$(bash_input "cd ~/.glass-atrium/autoagent && python3 -c \"open('f','w')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-interp-write"* ]] || return 1
}

@test "ArmB-neg armed read / absolute redirect target / status commands → pass" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && cat daemon-apply.sh')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && grep -c x f > /tmp/out')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && ls -la')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && git status')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmB-neg unarmed relative write → pass (HEAD behaviour preserved)" {
  run_hook "Bash" "$(bash_input 'cd /tmp && printf x > f')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "ArmB-neg absolute cd out disarms → pass" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && cd /tmp && printf x > f')"
  [[ "${status}" -eq 0 ]] || return 1
}

# R2-5: `cd -` returns to the PREVIOUS directory, which a text machine cannot
# name — disarming there made `cd <prot> && cd /tmp && cd - && printf x > f` a
# one-line bypass of the row above. Arming is a boolean over-approximation, so
# an unnameable return re-arms whenever this command entered a protected dir
# earlier; `popd` is the same shape through the directory stack.

@test "R2-5 cd - back toward a protected dir → block (unknown return re-arms)" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent && cd /tmp && cd - && printf x > daemon-apply.sh')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-cwd-relative-write"* ]] || return 1
}

@test "R2-5 popd back toward a protected dir → block" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/hooks && pushd /tmp && popd && printf x > track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "R2-5-neg cd - / popd with no protected dir in the history → pass" {
  run_hook "Bash" "$(bash_input 'cd /tmp && cd /var && cd - && printf x > f')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd /tmp && pushd /var && popd && printf x > f')"
  [[ "${status}" -eq 0 ]] || return 1
}

# H1-D1: rules/ + scoped/ are deliberately unprotected. PROT_DIR_RE derives from
# the same roots as PROT_RE, so the exclusion is inherited — these rows guard it
# against a "complete the pattern" edit that arms on .glass-atrium/ wholesale.
@test "ArmB-neg cd into rules/ or scoped/ then relative write → pass (H1-D1)" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/rules && printf x > foo.md')"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/scoped && printf x > foo.md')"
  [[ "${status}" -eq 0 ]] || return 1
}

# The git repo tree has no leading dot, so it never arms — this is the
# implementing agent's own working directory.
@test "ArmB-neg cd into the repo tree then write → pass (leading dot required)" {
  run_hook "Bash" "$(bash_input "cd ${FAKE_HOME}/git/glass-atrium/hooks && printf x > foo.sh")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "cd ${FAKE_HOME}/git/glass-atrium/hooks && cp /tmp/a.sh enforce-harness-critical.sh")"
  [[ "${status}" -eq 0 ]] || return 1
}

# PROT_DIR_RE boundary: a longer sibling directory name must not arm.
@test "ArmB-neg cd into autoagent-backup → pass (name-boundary lookahead)" {
  run_hook "Bash" "$(bash_input 'cd ~/.glass-atrium/autoagent-backup && printf x > f')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── Shell -c code strings + the quote-mask regression guards ──────────────────
#
# The verb recogniser was blind inside every quoted code string while the
# redirect recogniser was not, so `bash -c 'cp ...'` passed while
# `bash -c 'echo x > ...'` blocked. The mask closes that asymmetry — but the mask
# ALONE would convert the two rows below from true positives into false
# negatives, which is why mask + shell recursion + awk scanning are one change.

@test "S4 bash -c with a copy verb → block (was a bypass at HEAD)" {
  run_hook "Bash" "$(bash_input "bash -c 'cp /tmp/e.sh ~/.glass-atrium/autoagent/daemon-apply.sh'")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "S4 sh -c with a nested cd + relative redirect → block (was a bypass at HEAD)" {
  run_hook "Bash" "$(bash_input "sh -c 'cd ~/.glass-atrium/autoagent && printf x > daemon-apply.sh'")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-cwd-relative-write"* ]] || return 1
}

@test "S5 REGRESSION GUARD: bash -c with a redirect still blocks after the mask" {
  run_hook "Bash" "$(bash_input "bash -c 'echo x > ~/.glass-atrium/autoagent/daemon-apply.sh'")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "S5 REGRESSION GUARD: awk in-program redirect still blocks after the mask" {
  run_hook "Bash" "$(bash_input "awk 'BEGIN{print \"x\" > \"~/.glass-atrium/autoagent/daemon-apply.sh\"}'")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "S4-neg shell -c with a non-protected cd → pass" {
  run_hook "Bash" "$(bash_input "bash -c 'cd /tmp/repo && npm test' # ~/.glass-atrium/hooks")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "S4-neg bash with a script-file argument → pass (no code flag)" {
  run_hook "Bash" "$(bash_input 'bash ~/.glass-atrium/scripts/update.sh')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── Quote mask + heredoc stripping: the reproduced false positives ────────────
#
# Both rows below BLOCK at HEAD (exit 2) purely because the redirect recogniser
# is quote-blind — a progress note documenting this very repair would block
# itself. These fixtures assert the fix, not a bar-raise.

@test "FP-FIX echo of a quoted redirect command → pass (blocked at HEAD)" {
  run_hook "Bash" "$(bash_input "echo 'run: echo x > ~/.claude/settings.json'")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "FP-FIX heredoc BODY quoting a redirect into live settings → pass (blocked at HEAD)" {
  run_hook "Bash" "$(bash_input "$(printf 'cat > /tmp/notes.md <<%sMD%s\nrun: echo x > ~/.claude/settings.json\nMD\n' "'" "'")")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "FP-FIX heredoc BODY quoting the cd and interpreter bypasses → pass" {
  run_hook "Bash" "$(bash_input "$(printf 'cat > /tmp/notes.md <<%sMD%s\nnote: cd ~/.glass-atrium/autoagent && printf x > daemon-apply.sh\nMD\n' "'" "'")")"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook "Bash" "$(bash_input "$(printf 'cat > /tmp/notes.md <<%sMD%s\nnote: python3 -c "open(%s~/.glass-atrium/autoagent/f%s,%sw%s)"\nMD\n' "'" "'" "'" "'" "'" "'")")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "FP-FIX quoted bypass text appended to a notes file → pass" {
  run_hook "Bash" "$(bash_input "printf '%s\n' 'cd ~/.glass-atrium/autoagent && printf x > f' >> /tmp/notes.md")"
  [[ "${status}" -eq 0 ]] || return 1
}

# A heredoc consumed by a SHELL is code, not data — its body is re-scanned.
@test "heredoc consumed by bash carrying cd + relative redirect → block" {
  run_hook "Bash" "$(bash_input "$(printf 'bash <<%sSH%s\ncd ~/.glass-atrium/autoagent\nprintf x > daemon-apply.sh\nSH\n' "'" "'")")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"bash-cwd-relative-write"* ]] || return 1
}

# The body is data, but the heredoc LINE keeps its own redirect — the strip
# removes the body only.
@test "heredoc line whose redirect target is protected → block (body stripped, line kept)" {
  run_hook "Bash" "$(bash_input "$(printf 'cat > ~/.claude/settings.json <<%sEOF%s\nharmless\nEOF\n' "'" "'")")"
  [[ "${status}" -eq 2 ]] || return 1
}

# Ambiguity (an unterminated body) falls back to scanning the raw text — the
# pre-strip behaviour, never a new miss.
@test "unterminated heredoc → raw scan fallback (still blocks)" {
  run_hook "Bash" "$(bash_input "$(printf 'cat > /tmp/n.md <<%sMD%s\nrun: echo x > ~/.claude/settings.json\n' "'" "'")")"
  [[ "${status}" -eq 2 ]] || return 1
}

# ── Carve-out invariant: the launch-env grant short-circuits before the arms ──
#
# The grant returns before hook_read_input and before the classifier, so every
# new arm lives strictly downstream. This row pins that structurally.

@test "carve-out HARNESS_PROTECTION_APPROVE=1 + an Arm A payload → pass (grant unchanged)" {
  local envelope
  envelope="$(jq -cn --arg c "python3 -c \"open('${FAKE_HOME}/.glass-atrium/autoagent/f','w')\"" \
    '{tool_name: "Bash", tool_input: {command: $c}}')"
  run env "HOME=${FAKE_HOME}" HARNESS_PROTECTION_APPROVE=1 "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 0 ]] || return 1
}
