#!/usr/bin/env bats
# reconcile_stale_hook_matchers — stale-matcher drop at COMMAND granularity.
#
# The wire loop is add-only, so a CHANGED expected matcher leaves the old-matcher row bound
# and the hook double-fires. This pass drops that row. Its drop unit MUST be the COMMAND,
# matching is_hook_bound's (event, matcher, basename) scope: a consolidated hook-group — the
# idiomatic Claude Code shape, and the shape the live settings already holds — carries several
# commands under ONE matcher, so a group-granularity drop silently deletes every sibling
# command, including a security hook and a user-owned foreign hook, while logging one drop.
# It MUST:
#   * drop ONLY the stale target command; every sibling command in that group SURVIVES;
#   * report the number of COMMANDS dropped, not the number of groups touched;
#   * preserve the group's matcher and every other group key (assign INTO the command list);
#   * remove a group its drop emptied and PRUNE the event key that leaves empty, while a
#     pre-existing user-owned empty [] is left alone;
#   * leave a non-matching group, a foreign path and an unlisted basename untouched;
#   * stay ATOMIC + LAZILY BACKED UP + IDEMPOTENT (a no-op run is a true zero-write).
#
# Every assertion is gated `|| return 1`: this bats version fails a test ONLY on the LAST
# command's status, so a bare mid-body `[[ ]]` would be silently ignored.
#
# Run via: bats test/reconcile-stale-hook-matchers.bats
# Requires: bats (brew install bats-core), jq, bash 3.2+
#
# Hermetic strategy (mirrors retire-hook-binding.bats): GA_TARGET_HOME points SETTINGS_JSON at
# a throwaway temp dir, so the test drives the REAL reconcile_stale_hook_matchers (sourced from
# lib/ga-core.sh) against a synthetic settings.json under the strict mode the entry point arms,
# WITHOUT touching ~/.claude.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  TARGET="$(mktemp -d -t ga-reconcile-bats.XXXXXX)"
  SETTINGS="${TARGET}/settings.json"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
}

# Drive the REAL reconcile_stale_hook_matchers against the sandboxed target under strict mode.
run_reconcile() {
  run env GA_TARGET_HOME="${TARGET}" bash -c '
    set -Eeuo pipefail
    # shellcheck source=/dev/null
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    reconcile_stale_hook_matchers
  ' _ "${GA}"
}

# count command entries (any event) whose command ENDS in /<basename>.
count_cmd() {
  jq --arg b "$1" '
    [ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command
      | select(type == "string" and endswith("/" + $b)) ] | length
  ' "${SETTINGS}"
}

# count command entries under one (event, matcher) whose command ENDS in /<basename>.
count_cmd_matcher() {
  jq --arg ev "$1" --arg m "$2" --arg b "$3" '
    [ (.hooks[$ev] // [])[] | select((.matcher // "") == $m) | .hooks[]? | .command
      | select(type == "string" and endswith("/" + $b)) ] | length
  ' "${SETTINGS}"
}

# total command entries across every event (the command-granularity census the count must match).
count_all_cmd() {
  jq '[ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command | select(type == "string") ] | length' "${SETTINGS}"
}

# CASE 2 — the live shape (fact [5]): enforce-harness-critical.sh is expected under `Bash` and
# `Write|Edit|MultiEdit`, so its `Write|Edit` row is STALE, and it shares that consolidated group
# with validate-secret-scan.sh (for which `Write|Edit` IS expected) plus a user-owned hook.
write_case2() {
  cat >"${SETTINGS}" <<'JSON'
{
  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },
  "model": "user-pinned-model",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "customKey": "keepme", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/enforce-harness-critical.sh" },
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-secret-scan.sh" },
          { "type": "command", "command": "~/my-hooks/user-owned.sh" }
      ] },
      { "matcher": "Bash", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/enforce-harness-critical.sh" }
      ] }
    ]
  }
}
JSON
}

@test "C2-a consolidated group: only the stale command drops, both siblings survive" {
  write_case2
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  jq -e . "${SETTINGS}" >/dev/null || return 1
  # the stale (event, matcher, basename) row is gone; the EXPECTED Bash row survives
  [[ "$(count_cmd_matcher PreToolUse 'Write|Edit' enforce-harness-critical.sh)" -eq 0 ]] || return 1
  [[ "$(count_cmd enforce-harness-critical.sh)" -eq 1 ]] || return 1
  # SIBLING COMMANDS in the SAME group survive: the security hook whose matcher IS expected...
  [[ "$(count_cmd_matcher PreToolUse 'Write|Edit' validate-secret-scan.sh)" -eq 1 ]] || return 1
  # ...and the user-owned foreign hook (collateral, not a match target)
  [[ "$(count_cmd user-owned.sh)" -eq 1 ]] || return 1
  # the group itself survives with its matcher AND every other group key intact
  [[ "$(jq -r '[ .hooks.PreToolUse[] | select((.matcher // "") == "Write|Edit") ] | length' "${SETTINGS}")" -eq 1 ]] || return 1
  [[ "$(jq -r '.hooks.PreToolUse[] | select((.matcher // "") == "Write|Edit") | .customKey' "${SETTINGS}")" == "keepme" ]] || return 1
  # user-owned top-level keys untouched
  [[ "$(jq -c '.permissions' "${SETTINGS}")" == '{"allow":["Bash(ls:*)"],"deny":[]}' ]] || return 1
  [[ "$(jq -r '.model' "${SETTINGS}")" == "user-pinned-model" ]] || return 1
}

@test "C2-b consolidated group: the reported count equals the COMMANDS actually dropped" {
  write_case2
  local before after actual reported
  before="$(count_all_cmd)"
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  after="$(count_all_cmd)"
  actual=$((before - after))
  # exactly ONE command is stale in this fixture — a group-granularity drop kills three
  [[ "${actual}" -eq 1 ]] || return 1
  # the aggregate line counts COMMANDS, so it must equal the observed delta (loud, not under-reported)
  reported="$(printf '%s\n' "${output}" | sed -n 's/.*: \([0-9][0-9]*\) stale hook command(s) dropped.*/\1/p' | tail -1)"
  [[ -n "${reported}" ]] || return 1
  [[ "${reported}" -eq "${actual}" ]] || return 1
  # the per-drop line also states its command count
  [[ "${output}" == *"dropped stale matcher: PreToolUse -> enforce-harness-critical.sh (matcher=Write|Edit) — 1 command(s)"* ]] || return 1
}

@test "C2-b2 two stale commands in ONE group: both drop cumulatively, the count sums" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-pre-write-raw.sh" },
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-scope-drift.sh" },
          { "type": "command", "command": "~/my-hooks/user-owned.sh" }
      ] }
    ]
  }
}
JSON
  local before after reported
  before="$(count_all_cmd)"
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  after="$(count_all_cmd)"
  # both expect Write|Edit, so BOTH Write commands are stale — the group survives for the foreign one
  [[ $((before - after)) -eq 2 ]] || return 1
  [[ "$(count_cmd user-owned.sh)" -eq 1 ]] || return 1
  [[ "$(jq -r '.hooks.PreToolUse | length' "${SETTINGS}")" -eq 1 ]] || return 1
  reported="$(printf '%s\n' "${output}" | sed -n 's/.*: \([0-9][0-9]*\) stale hook command(s) dropped.*/\1/p' | tail -1)"
  [[ "${reported}" -eq 2 ]] || return 1
  # one lazy backup for the whole pass, not one per dropped command
  [[ "$(find "${TARGET}" -name 'settings.json.ga-stale-backup.*' | wc -l | tr -d ' ')" -eq 1 ]] || return 1
}

@test "C2-c a group emptied by the drop is removed and the event key pruned; user [] kept" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Read", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/post-edit-format.sh" }
      ] }
    ],
    "UserEmpty": []
  }
}
JSON
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  jq -e . "${SETTINGS}" >/dev/null || return 1
  # the group held ONLY the stale command → group dropped → the event key it emptied is pruned
  [[ "$(jq -r '.hooks | has("PostToolUse")' "${SETTINGS}")" == "false" ]] || return 1
  # a pre-existing user-owned empty array is NOT ours to prune
  [[ "$(jq -c '.hooks.UserEmpty' "${SETTINGS}")" == "[]" ]] || return 1
}

@test "C2-d a non-matching group is untouched: matcher, siblings and other group keys kept" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-pre-write-raw.sh" }
      ] },
      { "matcher": "Bash", "customKey": "keepme", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-secret-scan.sh" },
          { "type": "command", "command": "~/my-hooks/user-owned.sh" }
      ] },
      { "matcher": "Read", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/some-retired-hook.sh" }
      ] }
    ]
  }
}
JSON
  local kept_bash kept_read
  kept_bash="$(jq -cS '.hooks.PreToolUse[] | select((.matcher // "") == "Bash")' "${SETTINGS}")"
  kept_read="$(jq -cS '.hooks.PreToolUse[] | select((.matcher // "") == "Read")' "${SETTINGS}")"
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  # only the stale Write row goes (validate-pre-write-raw.sh is expected under Write|Edit)
  [[ "$(count_cmd validate-pre-write-raw.sh)" -eq 0 ]] || return 1
  # the expected-matcher group survives byte-for-byte, extra key and foreign sibling included
  [[ "$(jq -cS '.hooks.PreToolUse[] | select((.matcher // "") == "Bash")' "${SETTINGS}")" == "${kept_bash}" ]] || return 1
  # an UNLISTED Atrium basename is retire_hook_binding territory — left alone
  [[ "$(jq -cS '.hooks.PreToolUse[] | select((.matcher // "") == "Read")' "${SETTINGS}")" == "${kept_read}" ]] || return 1
}

# CASE 1 — the Atrium-shaped settings wire_hooks itself emits: one command per group.
write_case1() {
  cat >"${SETTINGS}" <<'JSON'
{
  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-pre-write-raw.sh" }
      ] },
      { "matcher": "Write|Edit", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-secret-scan.sh" }
      ] }
    ]
  }
}
JSON
}

@test "C1 Atrium shape: the stale group drops, the expected sibling group and user keys stay" {
  write_case1
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_cmd validate-pre-write-raw.sh)" -eq 0 ]] || return 1
  [[ "$(count_cmd_matcher PreToolUse 'Write|Edit' validate-secret-scan.sh)" -eq 1 ]] || return 1
  [[ "$(jq -r '.hooks.PreToolUse | length' "${SETTINGS}")" -eq 1 ]] || return 1
  [[ "$(jq -c '.permissions' "${SETTINGS}")" == '{"allow":["Bash(ls:*)"],"deny":[]}' ]] || return 1
  [[ "${output}" == *"backed up settings.json -> ${SETTINGS}.ga-stale-backup."* ]] || return 1
}

@test "C1 idempotent: a second reconcile drops nothing and takes no further backup" {
  write_case1
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  local after_first
  after_first="$(cat "${SETTINGS}")"
  find "${TARGET}" -name 'settings.json.ga-stale-backup.*' -exec rm -f {} +
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${SETTINGS}")" == "${after_first}" ]] || return 1
  [[ "${output}" != *"dropped stale matcher"* ]] || return 1
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-stale-backup.*' 2>/dev/null | head -1)" ]] || return 1
}

@test "C0 no-op: nothing stale -> zero writes, zero backups" {
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/validate-secret-scan.sh" },
          { "type": "command", "command": "~/my-hooks/user-owned.sh" }
      ] },
      { "matcher": "Bash", "hooks": [
          { "type": "command", "command": "~/.glass-atrium/hooks/enforce-harness-critical.sh" }
      ] }
    ]
  }
}
JSON
  local before
  before="$(cat "${SETTINGS}")"
  run_reconcile
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${SETTINGS}")" == "${before}" ]] || return 1
  [[ "${output}" != *"dropped stale matcher"* ]] || return 1
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-stale-backup.*' 2>/dev/null | head -1)" ]] || return 1
}
