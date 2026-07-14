#!/usr/bin/env bats
# retire_hook_binding — targeted settings.json hook-binding retirement (#13).
#
# The `glass-atrium update` vendor-removal sweep Trashes a dropped hook FILE, but its
# settings.json event->hook BINDING lingers pointing at the now-absent file, so the hook
# ERRORS when its event fires. wire_hooks only ADDS bindings and unwire_hooks removes ALL
# (too broad for an update). retire_hook_binding surgically drops ONLY the binding of ONE
# vendor-removed hook basename, in EITHER Atrium dir. It MUST:
#   * retire the target basename's binding across ALL events (tilde + absolute + dual-dir);
#   * PRESERVE every OTHER Atrium binding and a same-basename FOREIGN-path user hook;
#   * PRUNE an event key IT emptied, but LEAVE a pre-existing user-owned empty [];
#   * be ATOMIC + LAZILY BACKED UP (a no-op retire stays a true zero-write);
#   * LOUD-FAIL on a malformed settings.json (original left intact);
#   * be IDEMPOTENT — a re-run retires nothing; DRY_RUN reports intent only.
#
# Every assertion is gated `|| return 1`: this bats version fails a test ONLY on the LAST
# command's status, so a bare mid-body `[[ ]]` would be silently ignored.
#
# Run via: bats test/retire-hook-binding.bats
# Requires: bats (brew install bats-core), jq, bash 3.2+
#
# Hermetic strategy (mirrors unwire-hooks.bats): GA_TARGET_HOME points SETTINGS_JSON at a
# throwaway temp dir, so the test drives the REAL retire_hook_binding (sourced from
# lib/ga-core.sh) against a synthetic settings.json under the same strict mode the entry
# point arms, WITHOUT touching ~/.claude.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  TARGET="$(mktemp -d -t ga-retire-bats.XXXXXX)"
  SETTINGS="${TARGET}/settings.json"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
}

# Drive the REAL retire_hook_binding against the sandboxed target under strict mode.
# $1 = hook basename · optional $2 = "dry" to set DRY_RUN=true.
run_retire() {
  local hook="$1" mode="${2:-live}"
  run env GA_TARGET_HOME="${TARGET}" bash -c '
    set -Eeuo pipefail
    # shellcheck source=/dev/null
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    [ "$3" = "dry" ] && DRY_RUN=true
    retire_hook_binding "$2"
  ' _ "${GA}" "${hook}" "${mode}"
}

# count command entries (any event) whose command CONTAINS the given substring.
count_cmd() {
  local needle="$1"
  jq --arg n "${needle}" '
    [ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command
      | select(type == "string" and contains($n)) ] | length
  ' "${SETTINGS}"
}

# A sample settings.json: the target basename `dropped-hook.sh` appears in BOTH Atrium
# dirs (new + legacy) AND at a FOREIGN user path; other Atrium hooks + user keys coexist.
write_sample() {
  cat >"${SETTINGS}" <<JSON
{
  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },
  "model": "user-pinned-model",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.glass-atrium/hooks/dropped-hook.sh" } ] },
      { "matcher": "Bash",  "hooks": [ { "type": "command", "command": "~/.glass-atrium/hooks/kept-hook.sh" } ] },
      { "matcher": "Read",  "hooks": [ { "type": "command", "command": "~/my-hooks/dropped-hook.sh" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/dropped-hook.sh" } ] },
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/other-kept.sh" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "${HOME}/.glass-atrium/hooks/dropped-hook.sh" } ] }
    ],
    "UserEmpty": []
  }
}
JSON
}

@test "a dropped hook's binding is retired across all events; other bindings intact" {
  write_sample
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  jq -e . "${SETTINGS}" >/dev/null || return 1
  # the target basename is gone from BOTH Atrium dirs (new-dir tilde/absolute + legacy)
  [[ "$(count_cmd '.glass-atrium/hooks/dropped-hook.sh')" -eq 0 ]] || return 1
  [[ "$(count_cmd '.claude/hooks/dropped-hook.sh')" -eq 0 ]] || return 1
  # every OTHER Atrium binding survives untouched
  [[ "$(count_cmd '.glass-atrium/hooks/kept-hook.sh')" -eq 1 ]] || return 1
  [[ "$(count_cmd '.claude/hooks/other-kept.sh')" -eq 1 ]] || return 1
}

@test "a same-basename FOREIGN-path user hook is preserved (surgical, not basename-blanket)" {
  write_sample
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  # ~/my-hooks/dropped-hook.sh resolves under NEITHER Atrium dir → preserved exactly once
  [[ "$(count_cmd 'my-hooks/dropped-hook.sh')" -eq 1 ]] || return 1
}

@test "an event holding ONLY the target binding has its key pruned; user empty [] preserved" {
  write_sample
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  # SessionStart held ONLY the target → emptied by us → pruned
  [[ "$(jq -r '.hooks | has("SessionStart")' "${SETTINGS}")" == "false" ]] || return 1
  # PreToolUse kept its two survivors; PostToolUse kept its one survivor
  [[ "$(jq -r '.hooks.PreToolUse | length' "${SETTINGS}")" -eq 2 ]] || return 1
  [[ "$(jq -r '.hooks.PostToolUse | length' "${SETTINGS}")" -eq 1 ]] || return 1
  # the pre-existing user-owned empty array is left untouched (NOT pruned)
  [[ "$(jq -c '.hooks.UserEmpty' "${SETTINGS}")" == "[]" ]] || return 1
}

@test "top-level user-owned keys are preserved untouched" {
  write_sample
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(jq -c '.permissions' "${SETTINGS}")" == '{"allow":["Bash(ls:*)"],"deny":[]}' ]] || return 1
  [[ "$(jq -r '.model' "${SETTINGS}")" == "user-pinned-model" ]] || return 1
}

@test "retire backs up settings.json to a timestamped file before mutating" {
  write_sample
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"backed up settings.json -> ${SETTINGS}.ga-backup."* ]] || return 1
  local backup
  backup="$(find "${TARGET}" -name 'settings.json.ga-backup.*' | head -1)"
  [[ -n "${backup}" ]] || return 1
  jq -e . "${backup}" >/dev/null || return 1
}

@test "idempotent: a second retire of the same basename removes nothing and takes no backup" {
  write_sample
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  # clear the first-pass backup so the no-op assertion below is unambiguous
  find "${TARGET}" -name 'settings.json.ga-backup.*' -exec rm -f {} +
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"0 binding-group(s) retired for dropped-hook.sh"* ]] || return 1
  # no residue, survivors intact, and no backup written on the zero-mutation re-run
  [[ "$(count_cmd 'hooks/dropped-hook.sh')" -eq 1 ]] || return 1 # only the foreign one remains
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-backup.*' 2>/dev/null | head -1)" ]] || return 1
}

@test "a basename bound under NO event is a clean no-op (no mutation, no backup)" {
  write_sample
  local before
  before="$(jq -cS . "${SETTINGS}")"
  run_retire "never-bound-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(jq -cS . "${SETTINGS}")" == "${before}" ]] || return 1 # byte-identical (semantically)
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-backup.*' 2>/dev/null | head -1)" ]] || return 1
}

@test "missing basename argument -> die" {
  write_sample
  run_retire ""
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"a hook basename argument is required"* ]] || return 1
}

@test "malformed settings.json -> ABORT, original left byte-intact (no corruption, no backup)" {
  printf '%s\n' '{ this is not json' >"${SETTINGS}"
  run_retire "dropped-hook.sh"
  [[ "${status}" -ne 0 ]] || return 1
  [[ "${output}" == *"not valid JSON"* ]] || return 1
  [[ "$(cat "${SETTINGS}")" == '{ this is not json' ]] || return 1
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-backup.*' 2>/dev/null | head -1)" ]] || return 1
}

@test "dry-run -> no mutation, no backup (reports intent only)" {
  write_sample
  local before
  before="$(jq -cS . "${SETTINGS}")"
  run_retire "dropped-hook.sh" dry
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"dry-run: skipping settings.json retire of dropped-hook.sh"* ]] || return 1
  [[ "$(jq -cS . "${SETTINGS}")" == "${before}" ]] || return 1
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-backup.*' 2>/dev/null | head -1)" ]] || return 1
}

@test "absent settings.json -> no-op (nothing to retire)" {
  [[ ! -f "${SETTINGS}" ]] || return 1
  run_retire "dropped-hook.sh"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"nothing to retire"* ]] || return 1
  [[ ! -f "${SETTINGS}" ]] || return 1
}
