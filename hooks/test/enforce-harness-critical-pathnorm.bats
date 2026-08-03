#!/usr/bin/env bats
# enforce-harness-critical.sh — A-set: envelope path normalisation (clauded-docs/743 P0-A).
#
# The classifier decides the agents/*.md content question on the RAW file_path while
# the shell arm normalises afterwards, so the two arms of one hook disagree about
# which file they are discussing. A leading tilde therefore makes the classifier's
# on-disk text the empty string, and an Edit that widens an allowlist is allowed.
#
# Reporting contract (AC-S1): this file carries the A-set ONLY. The B-set lives in
# enforce-harness-critical-frontmatter.bats so a partial landing reads as partial.
#
# Run via: bats hooks/test/enforce-harness-critical-pathnorm.bats
# Requires: bats, bash 3.2+, python3, jq. Harness copied from
# enforce-harness-critical.bats (hermetic FAKE_HOME, DIRECT hook invocation — an
# interpreter prefix would bypass the executable bit).

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"
HOOK_UTILS="${BATS_TEST_DIRNAME}/../hook-utils.sh"
CORPUS="${BATS_TEST_DIRNAME}/corpus/agents-blocklist"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${FAKE_HOME}/.claude/agents" "${FAKE_HOME}/.glass-atrium/agents"

  # Inline-flow seed, byte-equal to the sibling suite's setup() seed: the A-set
  # asserts path handling, so its identity edits use the form the matcher already
  # sees. Form coverage is the B-set's job.
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

  # One block-list corpus copy, for the body-bullet permit row.
  cp "${CORPUS}/glass-atrium-dev-db.md" "${FAKE_HOME}/.glass-atrium/agents/"
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

# The block-reason token as the payload carries it — AC-A2 compares this, never the
# whole output (the raw-path reporting field deliberately differs between forms).
block_reason() {
  printf '%s' "${1}" \
    | grep -o 'identity-frontmatter-write\|identity-frontmatter-edit\|frontmatter-fence-edit\|unterminated-frontmatter\|frontmatter-unparseable\|new-agent-creation' \
    | head -1
}

# ── AC-A4: a legitimate body edit passes in BOTH path forms ──────────────────
#
# HONESTY NOTE — the tilde rows below are green at HEAD for the WRONG reason: the
# unresolved read yields an empty disk string, so nothing can overlap and the
# verdict is a vacuous allow. Written alone they would be vacuous. Their value is
# post-fix, PAIRED with "AC-A1 tilde identity Edit …" (red at HEAD): the pair pins
# that normalisation closed the evasion WITHOUT over-blocking the body edit.

@test "AC-A4 body Edit (absolute form) → pass" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" '# Body' '# Body text')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "AC-A4 body Edit (tilde form) → pass" {
  run_hook "Edit" "$(edit_input '~/.glass-atrium/agents/glass-atrium-dev-shell.md' '# Body' '# Body text')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "AC-A4 body bullet add (tilde form, block-list file) → pass" {
  run_hook "Edit" "$(edit_input '~/.glass-atrium/agents/glass-atrium-dev-db.md' \
    '- ordinary prose bullet' '- ordinary prose bullet
- added bullet')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC-A1 / AC-A2 / AC-A3: the tilde evasion ─────────────────────────────────

@test "AC-A1 tilde identity Edit widening tools → HAR-001 block (exit 2)" {
  run_hook "Edit" "$(edit_input '~/.glass-atrium/agents/glass-atrium-dev-shell.md' \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
  [[ "${output}" == *"identity-frontmatter-edit"* ]] || return 1
}

@test "AC-A2 tilde and absolute forms of ONE identity Edit agree (status + reason)" {
  local status_tilde reason_tilde status_abs reason_abs
  run_hook "Edit" "$(edit_input '~/.glass-atrium/agents/glass-atrium-dev-shell.md' \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')"
  status_tilde="${status}"
  reason_tilde="$(block_reason "${output}")"
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')"
  status_abs="${status}"
  reason_abs="$(block_reason "${output}")"
  [[ "${status_tilde}" -eq "${status_abs}" ]] || return 1
  [[ "${reason_tilde}" == "${reason_abs}" ]] || return 1
  [[ -n "${reason_abs}" ]] || return 1
}

@test "AC-A3 traversal-bearing tilde identity Edit → HAR-001 block (exit 2)" {
  run_hook "Edit" "$(edit_input '~/x/../.glass-atrium/agents/glass-atrium-dev-shell.md' \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"identity-frontmatter-edit"* ]] || return 1
}

# GUARD row: green at HEAD (the empty disk map cannot equal the content map), and
# it must STAY green after P0-A — then for the right reason, on a resolved read.
@test "AC-A2b tilde and absolute Write changing scope agree (status + reason)" {
  local body status_tilde reason_tilde status_abs reason_abs
  body='---
name: glass-atrium-dev-shell
tools: [Read, Bash]
scope: QA
model: claude-model-a
---
# Body

Body paragraph mentioning name: not-frontmatter inside the body.'
  run_hook "Write" "$(write_input '~/.glass-atrium/agents/glass-atrium-dev-shell.md' "${body}")"
  status_tilde="${status}"
  reason_tilde="$(block_reason "${output}")"
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" "${body}")"
  status_abs="${status}"
  reason_abs="$(block_reason "${output}")"
  [[ "${status_tilde}" -eq 2 ]] || return 1
  [[ "${status_tilde}" -eq "${status_abs}" ]] || return 1
  [[ "${reason_tilde}" == "identity-frontmatter-write" ]] || return 1
  [[ "${reason_tilde}" == "${reason_abs}" ]] || return 1
}

# ── AC-A-parity: the classifier's normaliser mirrors hook_normalize_path ─────
#
# P0-A adds normalize_path to the classifier rather than modifying the shared
# shell helper (AC-S3 keeps hook-utils.sh byte-unchanged), so the two
# implementations must agree byte-for-byte on one shared corpus.
#
# The classifier source is lifted out of the hook the way the sibling suite already
# precedents (its injected-defect fixture sed-transforms the same heredoc): print
# the heredoc span, drop the `IFS= read …` opener and the `PY` terminator, then drop
# the trailing `main()` call so the module imports without running.
extract_detect_py() {
  local dir="${BATS_TEST_TMPDIR}/detect"
  mkdir -p "${dir}"
  sed -n "/^IFS= read -r -d '' DETECT_PY <<'PY'/,/^PY\$/p" "${HOOK_SH}" \
    | sed '1d;$d' | sed '$d' >"${dir}/detect_py.py"
  [[ -s "${dir}/detect_py.py" ]] || return 1
  printf '%s\n' "${dir}"
}

@test "AC-A-parity classifier normalize_path matches hook_normalize_path on the corpus" {
  local dir p py sh
  dir="$(extract_detect_py)" || return 1
  # The bash helper prints a trailing newline; command substitution strips it, and
  # no corpus entry ends in one, so the two sides compare on identical bytes.
  # The trailing group is the Bash-arm repair's dependency set (clauded-docs/774
  # T1-1.g): the five discrete-token recognition sites resolve their token through
  # this normaliser, so parity is asserted for exactly the redundant-separator,
  # dot-segment and backtrack spellings that repair relies on.
  for p in '~' '~/x' '~/' '~other/x' '~user/.glass-atrium/agents/a.md' \
    '/a/../b/./c' 'a/b' '/a/b/' '..' '/..' '' '~/x/../y' '//a//b' \
    '/a///b' '/a/./b' '/a/.//./b' 'a/b/../c' '/a/b/../../c' '/a/b/..' './a/b' \
    '~//x' '~/./x' '~/x/../../y' '/a/b/../..' '../a/b' \
    "${FAKE_HOME}/.claude//settings.json" \
    "${FAKE_HOME}/.claude/todos/../settings.json" \
    "${FAKE_HOME}/.glass-atrium/wiki/../hooks" \
    "${FAKE_HOME}/.glass-atrium/hooks/../../work" \
    "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md"; do
    py="$(env "HOME=${FAKE_HOME}" python3 -c \
      'import sys; sys.path.insert(0, sys.argv[1]); import detect_py; sys.stdout.write(detect_py.normalize_path(sys.argv[2]))' \
      "${dir}" "${p}")" || return 1
    sh="$(env "HOME=${FAKE_HOME}" bash -c 'source "$0"; hook_normalize_path "$1"' "${HOOK_UTILS}" "${p}")" || return 1
    [[ "${py}" == "${sh}" ]] || return 1
  done
}
