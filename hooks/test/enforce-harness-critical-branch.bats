#!/usr/bin/env bats
# enforce-harness-critical.sh — profile-branch coverage set (clauded-docs/2119 W2).
#
# The hard-block surface reaches every `~/.claude-*` profile branch's settings files and
# hooks/ dir, so a branch whose settings.json carries live hook wiring stops being a hole.
# Two grammars express that root — the shell lib fragment and the classifier's own
# alternation (the heredoc delimiter stays quoted by design) — so the first row pins them
# equal on one shared corpus and the rest assert per-consumer OUTCOMES on the same probes.
#
# Reporting contract: this file carries the branch set ONLY; the pre-existing suites stay
# byte-identical, so a partial landing reads as partial.
#
# Run via: bats hooks/test/enforce-harness-critical-branch.bats
# Requires: bats, bash 3.2+, python3, jq. Harness copied from
# enforce-harness-critical-pathnorm.bats (hermetic FAKE_HOME, DIRECT hook invocation).

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"
CONFIG_LIB="${BATS_TEST_DIRNAME}/../lib/claude-config-dirs.sh"

# Positive roots: plain, the three live profile branches, and the dormant backup dir
# (fail-safe over-coverage, user-approved).
POS_ROOTS=(.claude .claude-work .claude-personal .claude-work-dev .claude-pre-glass-atrium-backup-20260603T043853Z)
# Negative roots. `.claudex` catches a missing suffix-opener anchor and `.claude-` a sloppy
# `-.*` suffix class; the dot-less name catches a dropped leading-dot discipline, which is
# what keeps this repository's own checkout out of the gate.
NEG_ROOTS=(.claudex .claude- claude-work)
# Case-varied probe: the critical hook's shell-global nocasematch and the classifier's
# IGNORECASE both fold it, so it is a POSITIVE here — a tested property, not an assumption.
CASE_ROOT=.Claude-Work

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${FAKE_HOME}/.glass-atrium/agents"

  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" <<'MD'
---
name: glass-atrium-dev-shell
tools: [Read, Bash]
scope: DEV
---
# Body

Body paragraph.
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
bash_input() { jq -cn --arg c "${1}" '{command: $c}'; }

# ── AC10: the two branch grammars agree on one shared corpus ──────────────────
#
# The shell side is evaluated WITH nocasematch, because that is the ambient setting of the
# consumer being pinned (the critical hook sets it shell-globally); the classifier side is
# IGNORECASE for the same reason. Reading CLAUDE_ROOT out of the extracted module means a
# python-side edit that drifts from the lib fragment fails here loudly.
extract_detect_py() {
  local dir="${BATS_TEST_TMPDIR}/detect"
  mkdir -p "${dir}"
  sed -n "/^IFS= read -r -d '' DETECT_PY <<'PY'/,/^PY\$/p" "${HOOK_SH}" \
    | sed '1d;$d' | sed '$d' >"${dir}/detect_py.py"
  [[ -s "${dir}/detect_py.py" ]] || return 1
  printf '%s\n' "${dir}"
}

grammar_shell() {
  bash -c 'shopt -s nocasematch; source "$0"; claude_config_is_branch_path "$1"' \
    "${CONFIG_LIB}" "${1}" && printf '1' || printf '0'
}

grammar_py() {
  python3 -c 'import sys, re; sys.path.insert(0, sys.argv[1]); import detect_py; sys.stdout.write("1" if re.search(detect_py.CLAUDE_ROOT + "/", sys.argv[2], re.IGNORECASE) else "0")' \
    "${1}" "${2}"
}

@test "AC10 shell lib and classifier classify the shared root corpus identically" {
  local dir r p
  dir="$(extract_detect_py)" || return 1
  for r in "${POS_ROOTS[@]}" "${CASE_ROOT}"; do
    p="/x/${r}/y"
    [[ "$(grammar_shell "${p}")" == "1" ]] || return 1
    [[ "$(grammar_py "${dir}" "${p}")" == "1" ]] || return 1
  done
  for r in "${NEG_ROOTS[@]}"; do
    p="/x/${r}/y"
    [[ "$(grammar_shell "${p}")" == "0" ]] || return 1
    [[ "$(grammar_py "${dir}" "${p}")" == "0" ]] || return 1
  done
  # AC11: a git checkout of this repository is not a config root in either grammar.
  [[ "$(grammar_shell '/Users/x/git/glass-atrium/hooks/x.sh')" == "0" ]] || return 1
  [[ "$(grammar_py "${dir}" '/Users/x/git/glass-atrium/hooks/x.sh')" == "0" ]] || return 1
}

# ── AC6: branch settings.json / settings.local.json block on the Write|Edit arm ──

@test "AC6 Write of settings.json under every branch root → live-settings block" {
  local r
  for r in "${POS_ROOTS[@]}"; do
    run_hook "Write" "$(write_input "${FAKE_HOME}/${r}/settings.json" '{}')"
    [[ "${status}" -eq 2 ]] || return 1
    [[ "${output}" == *"live-settings"* ]] || return 1
  done
}

@test "AC6 Edit of settings.local.json under a branch root → live-settings block" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.claude-work-dev/settings.local.json" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"live-settings"* ]] || return 1
}

@test "AC6 case-varied branch spelling still blocks (nocasematch contract)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/${CASE_ROOT}/settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"live-settings"* ]] || return 1
}

@test "AC6 suffix-lookalike roots are not config roots → pass" {
  local r
  for r in "${NEG_ROOTS[@]}"; do
    run_hook "Write" "$(write_input "${FAKE_HOME}/${r}/settings.json" '{}')"
    [[ "${status}" -eq 0 ]] || return 1
  done
}

@test "AC6 branch hooks/ dir write → live-hooks-dir block" {
  local r
  for r in "${POS_ROOTS[@]}"; do
    run_hook "Write" "$(write_input "${FAKE_HOME}/${r}/hooks/x.sh" 'echo x')"
    [[ "${status}" -eq 2 ]] || return 1
    [[ "${output}" == *"live-hooks-dir"* ]] || return 1
  done
}

# ── AC7: the Bash arm sees the same branch class ──────────────────────────────

@test "AC7 redirect into a branch settings file → block" {
  run_hook "Bash" "$(bash_input 'echo x > ~/.claude-work-dev/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "AC7 interpreter write of a branch settings file → block" {
  run_hook "Bash" "$(bash_input "python3 -c \"open('~/.claude-personal/settings.local.json','w').write('x')\"")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "AC7 cp into a branch hooks dir → block" {
  run_hook "Bash" "$(bash_input 'cp /tmp/evil.sh ~/.claude-work/hooks/pre.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "AC11 a redirect inside a git checkout of this repo → pass" {
  run_hook "Bash" "$(bash_input 'echo x > /Users/x/git/glass-atrium/hooks/x.sh')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC8: the OPEN areas stay open, pinned ────────────────────────────────────

@test "AC8 branch jobs/, projects/ and memory writes pass" {
  local p
  for p in jobs/x.json projects/p/session.jsonl memory/notes.md; do
    run_hook "Write" "$(write_input "${FAKE_HOME}/.claude-work-dev/${p}" 'x')"
    [[ "${status}" -eq 0 ]] || return 1
  done
}

@test "AC8 an agent BODY edit below the frontmatter fence passes" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" 'Body paragraph.' 'Body paragraph, revised.')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "AC11 a Write inside a git checkout of this repo → pass" {
  run_hook "Write" "$(write_input "${BATS_TEST_TMPDIR}/git/glass-atrium/hooks/x.sh" 'echo x')"
  [[ "${status}" -eq 0 ]] || return 1
}
