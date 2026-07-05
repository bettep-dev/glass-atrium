#!/usr/bin/env bats
# Hook command-path repoint (P2 essential-symlinks-only): the ~/.claude/hooks farm
# is dropped and hooks fire in place from ~/.glass-atrium/hooks. This suite covers
# the two primitives that make an EXISTING install survive the repoint:
#   * rewrite_hook_paths — run inside wire_hooks BEFORE the idempotency loop.
#     is_hook_bound compares by BASENAME, so a stale ~/.claude/hooks/<hook> binding
#     would be seen as already-wired and the add-loop would SKIP it → the template
#     repoint would be a silent no-op. rewrite_hook_paths first migrates every
#     old-dir command to the new dir so the repoint actually lands.
#   * verify_clean (post-uninstall assertion) — DUAL-DIR: a residual binding under
#     EITHER ~/.claude/hooks OR ~/.glass-atrium/hooks must FAIL the assertion. An
#     exact-cmd literal keyed on the old dir would assert a never-wired path after
#     the repoint and always PASS, letting a new-dir residual slip through.
#
# Run via: bats test/hook-repoint-dualdir.bats
# Requires: bats (brew install bats-core), jq, bash 3.2+
#
# Hermetic strategy: GA_TARGET_HOME points the target (and thus SETTINGS_JSON =
# <target>/settings.json) at a throwaway temp dir, so the tests drive the REAL
# primitives WITHOUT touching ~/.claude.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  TARGET="$(mktemp -d -t ga-repoint-bats.XXXXXX)"
  SETTINGS="${TARGET}/settings.json"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
}

run_wire_sandbox() {
  GA_TARGET_HOME="${TARGET}" run "${REAL_GA}" wire-hooks
}

# Drive the REAL verify_clean against the sandboxed target, under the entry
# point's strict mode (verify_clean has no standalone subcommand — it runs inside
# `uninstall --verify-clean`; mirror the sourced-function contract like unwire).
run_verify_clean_sandbox() {
  run env GA_TARGET_HOME="${TARGET}" bash -c '
    set -Eeuo pipefail
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    verify_clean
  ' _ "${GA}"
}

# Count command entries (any event) whose command CONTAINS the given substring.
count_cmd() {
  local needle="$1"
  jq --arg n "${needle}" '
    [ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command
      | select(type == "string" and contains($n)) ] | length
  ' "${SETTINGS}"
}

# ---- rewrite_hook_paths (via wire-hooks) ----------------------------------

@test "rewrite: stale ~/.claude/hooks binding is REPOINTED to ~/.glass-atrium/hooks (not a silent no-op)" {
  # an established install: advisory-spawn-budget wired under the OLD dir.
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] }
    ]
  }
}
JSON
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # the old-dir binding is GONE, repointed to the new dir (exactly one, no dup)
  [[ "$(count_cmd '.claude/hooks/advisory-spawn-budget.sh')" -eq 0 ]]
  [[ "$(count_cmd '.glass-atrium/hooks/advisory-spawn-budget.sh')" -eq 1 ]]
  # the resolved command is the absolute new-dir form
  run jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("/advisory-spawn-budget.sh")) | .hooks[].command' "${SETTINGS}"
  [[ "${output}" == "${HOME}/.glass-atrium/hooks/advisory-spawn-budget.sh" ]]
}

@test "rewrite: a FOREIGN user hook under neither Atrium dir is preserved byte-for-byte" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] },
      { "matcher": "Bash",  "hooks": [ { "type": "command", "command": "~/my-hooks/foreign.sh" } ] }
    ]
  }
}
JSON
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # the foreign hook path is untouched (still tilde form, not repointed)
  [[ "$(count_cmd '~/my-hooks/foreign.sh')" -eq 1 ]]
  [[ "$(count_cmd '.glass-atrium/hooks/foreign.sh')" -eq 0 ]]
}

@test "rewrite: takes a distinct .ga-repoint-backup before mutating an old-dir install" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] }
    ]
  }
}
JSON
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"rewrite_hook_paths: backed up settings.json -> ${SETTINGS}.ga-repoint-backup."* ]]
  local backup
  backup="$(find "${TARGET}" -name 'settings.json.ga-repoint-backup.*' | head -1)"
  [[ -n "${backup}" ]]
  # the backup holds the PRE-repoint (old-dir) content
  [[ "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "${backup}")" == "~/.claude/hooks/advisory-spawn-budget.sh" ]]
}

@test "rewrite: no old-dir binding present -> clean no-op (no repoint backup)" {
  # a fresh install already on the new dir: wire from a bare skeleton, then re-run.
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # rewrite_hook_paths found nothing under the old dir → took no repoint backup
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-repoint-backup.*' 2>/dev/null | head -1)" ]]
}

# ---- verify_clean dual-dir --------------------------------------------------

@test "verify_clean: residual ~/.glass-atrium/hooks binding FAILS (the exact-match blind spot)" {
  # this is the case an old exact-cmd literal (keyed on ~/.claude/hooks) would MISS.
  cat >"${SETTINGS}" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "${HOME}/.glass-atrium/hooks/advisory-spawn-budget.sh" } ] }
    ]
  }
}
JSON
  run_verify_clean_sandbox
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"Atrium hook binding(s) still present"* ]]
}

@test "verify_clean: residual legacy ~/.claude/hooks binding FAILS" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] }
    ]
  }
}
JSON
  run_verify_clean_sandbox
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"Atrium hook binding(s) still present"* ]]
}

@test "verify_clean: clean settings.json (only foreign hooks) PASSES" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/my-hooks/foreign.sh" } ] }
    ]
  }
}
JSON
  run_verify_clean_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"zero Atrium hook bindings in settings.json"* ]]
  [[ "${output}" == *"verify-clean: PASS"* ]]
}
