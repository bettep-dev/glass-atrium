#!/usr/bin/env bats
# unwire_hooks — settings.json un-wire (uninstall path).
#
# unwire_hooks removes EVERY hook-group whose command resolves into EITHER Atrium
# hooks directory (~/.claude/hooks OR ~/.glass-atrium/hooks — dual-dir after the
# command-template repoint), across ALL events, PATH-TOLERANTLY (tilde or
# absolute form) and INDEPENDENTLY of the EXPECTED_HOOK_BINDINGS enumeration (so a
# deployed-but-not-listed surplus hook is still removed). It MUST:
#   * remove tilde-form AND absolute-form Atrium bindings (path tolerance);
#   * remove bindings under BOTH ~/.claude/hooks AND ~/.glass-atrium/hooks;
#   * remove a surplus Atrium hook NOT in EXPECTED_HOOK_BINDINGS (SoT-independent);
#   * PRESERVE a user hook whose command points elsewhere (e.g. ~/my-hooks/x.sh);
#   * PRUNE an event key IT emptied, but LEAVE a pre-existing user-owned empty [];
#   * be ATOMIC + BACKED UP — temp-file + mv, timestamped backup before mutating;
#   * LOUD-FAIL on a malformed settings.json (original left intact);
#   * be IDEMPOTENT — a re-run after a clean un-wire removes nothing.
#
# Run via: bats test/unwire-hooks.bats
# Requires: bats (brew install bats-core), jq, bash 3.2+
#
# Hermetic strategy: GA_TARGET_HOME points the target (and thus SETTINGS_JSON =
# <target>/settings.json) at a throwaway temp dir, so the test drives the REAL
# unwire_hooks (sourced from lib/ga-core.sh) against a synthetic settings.json
# WITHOUT touching ~/.claude. unwire_hooks has no standalone subcommand (it runs
# only inside the destructive full `uninstall`), so — mirroring the engine's own
# "source ga-core.sh + ga_init_env" contract — the test sources the engine and
# calls the function directly under the same `set -Eeuo pipefail` the entry point
# arms.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  TARGET="$(mktemp -d -t ga-unwire-bats.XXXXXX)"
  SETTINGS="${TARGET}/settings.json"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
}

# Drive the REAL unwire_hooks against the sandboxed target, under the entry
# point's strict mode. Optional first arg "dry" sets DRY_RUN=true.
run_unwire_sandbox() {
  local mode="${1:-live}"
  run env GA_TARGET_HOME="${TARGET}" bash -c '
    set -Eeuo pipefail
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    [ "$2" = "dry" ] && DRY_RUN=true
    unwire_hooks
  ' _ "${GA}" "${mode}"
}

# Count command entries (any event) whose command CONTAINS the given substring.
count_cmd() {
  local needle="$1"
  jq --arg n "${needle}" '
    [ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command
      | select(type == "string" and contains($n)) ] | length
  ' "${SETTINGS}"
}

# A sample settings.json exercising: (i) tilde + no-matcher + absolute Atrium
# hooks under several events, (ii) a NON-Atrium user hook that MUST survive,
# (iii) a pre-existing user-owned empty event array, (iv) top-level user keys.
write_sample() {
  cat >"${SETTINGS}" <<JSON
{
  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },
  "model": "user-pinned-model",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.claude/hooks/advisory-spawn-budget.sh" } ] },
      { "matcher": "Bash",  "hooks": [ { "type": "command", "command": "~/my-hooks/x.sh" } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-output.sh" } ] },
      { "matcher": "WebFetch", "hooks": [ { "type": "command", "command": "${HOME}/.claude/hooks/surplus-not-in-expected.sh" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-compliance-matrix.sh" } ] }
    ],
    "UserEmpty": []
  }
}
JSON
}

@test "tilde + absolute Atrium bindings removed across all events; user hook preserved" {
  write_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  jq -e . "${SETTINGS}" >/dev/null
  # every Atrium (~/.claude/hooks/... or absolute) binding is gone
  [[ "$(count_cmd '.claude/hooks/')" -eq 0 ]]
  # the user's own hook (elsewhere) survives, exactly once
  [[ "$(count_cmd '~/my-hooks/x.sh')" -eq 1 ]]
}

@test "surplus Atrium hook NOT in EXPECTED_HOOK_BINDINGS is removed (SoT-independent)" {
  write_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  # the absolute-form surplus hook (never listed in EXPECTED_HOOK_BINDINGS) is gone
  [[ "$(count_cmd 'surplus-not-in-expected.sh')" -eq 0 ]]
}

@test "WE-emptied event key is pruned; pre-existing user empty array is preserved" {
  write_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  # PostToolUse + SessionStart held ONLY Atrium hooks → emptied by us → pruned
  [[ "$(jq -r '.hooks | has("PostToolUse")' "${SETTINGS}")" == "false" ]]
  [[ "$(jq -r '.hooks | has("SessionStart")' "${SETTINGS}")" == "false" ]]
  # PreToolUse still holds the user hook → key kept, exactly one group
  [[ "$(jq -r '.hooks.PreToolUse | length' "${SETTINGS}")" -eq 1 ]]
  # the pre-existing user-owned empty array is left untouched (NOT pruned)
  [[ "$(jq -c '.hooks.UserEmpty' "${SETTINGS}")" == "[]" ]]
}

@test "top-level user-owned keys are preserved untouched" {
  write_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(jq -c '.permissions' "${SETTINGS}")" == '{"allow":["Bash(ls:*)"],"deny":[]}' ]]
  [[ "$(jq -r '.model' "${SETTINGS}")" == "user-pinned-model" ]]
}

@test "un-wire backs up settings.json to a timestamped file before mutating" {
  write_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"backed up settings.json -> ${SETTINGS}.ga-backup."* ]]
  local backup
  backup="$(find "${TARGET}" -name 'settings.json.ga-backup.*' | head -1)"
  [[ -n "${backup}" ]]
  jq -e . "${backup}" >/dev/null
}

@test "idempotent: a second un-wire removes nothing" {
  write_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"0 Atrium binding-group(s) removed across all events"* ]]
  # still exactly the one surviving user hook, no Atrium residue
  [[ "$(count_cmd '.claude/hooks/')" -eq 0 ]]
  [[ "$(count_cmd '~/my-hooks/x.sh')" -eq 1 ]]
}

@test "malformed settings.json -> ABORT, original left byte-intact (no corruption)" {
  printf '%s\n' '{ this is not json' >"${SETTINGS}"
  run_unwire_sandbox
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"not valid JSON"* ]]
  [[ "$(cat "${SETTINGS}")" == '{ this is not json' ]]
  # no backup taken (the abort precedes the first mutation)
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-backup.*' 2>/dev/null | head -1)" ]]
}

@test "absent settings.json -> no-op (nothing to un-wire, no backup)" {
  [[ ! -f "${SETTINGS}" ]]
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"nothing to un-wire"* ]]
  [[ ! -f "${SETTINGS}" ]]
}

# A settings.json where a user command SHARES the matcher VALUE "Shared" with an
# Atrium hook in TWO distinct shapes: (i) a SEPARATE group object (user-only) and
# (ii) the SAME group object that also bears an Atrium command. unwire drops at the
# hook-GROUP-OBJECT granularity (`map(select(... | any | not))`), so the two shapes
# diverge — this pins BOTH so the P2 dual-dir predicate change is characterized.
write_group_sharing_sample() {
  cat >"${SETTINGS}" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Shared", "hooks": [
        { "type": "command", "command": "~/.claude/hooks/enforce-delegation.sh" },
        { "type": "command", "command": "~/user-hooks/inside-atrium-group.sh" }
      ] },
      { "matcher": "Shared", "hooks": [
        { "type": "command", "command": "~/user-hooks/separate-group.sh" }
      ] }
    ]
  }
}
JSON
}

@test "unwire drops the whole group OBJECT: user cmd in a SEPARATE group survives, user cmd INSIDE the Atrium group is collaterally removed" {
  write_group_sharing_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  jq -e . "${SETTINGS}" >/dev/null
  # the Atrium hook is gone (the whole group object holding it was dropped)
  [[ "$(count_cmd '.claude/hooks/enforce-delegation.sh')" -eq 0 ]]
  # CHARACTERIZED CURRENT BEHAVIOR: a user command PHYSICALLY INSIDE the same
  # group object as the Atrium command is COLLATERALLY removed (group-granular
  # deletion). This documents the actual semantics — NOT an assertion that it is
  # desirable — precisely at the map(select()) site the P2 predicate mutates.
  [[ "$(count_cmd 'inside-atrium-group.sh')" -eq 0 ]]
  # the user command in a SEPARATE group object (same matcher VALUE) is PRESERVED
  [[ "$(count_cmd 'separate-group.sh')" -eq 1 ]]
  # PreToolUse survives with exactly the one surviving user-only group
  [[ "$(jq -r '.hooks.PreToolUse | length' "${SETTINGS}")" -eq 1 ]]
}

# DUAL-DIR (P2 repoint): after the command-template repoint, an install may hold
# bindings under the NEW ~/.glass-atrium/hooks dir, OR a mid-migration mix of both
# the old ~/.claude/hooks and the new dir. unwire MUST sweep BOTH Atrium-owned
# prefixes while preserving a foreign user hook that resolves under neither.
write_dualdir_sample() {
  cat >"${SETTINGS}" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [ { "type": "command", "command": "~/.glass-atrium/hooks/advisory-spawn-budget.sh" } ] },
      { "matcher": "Bash",  "hooks": [ { "type": "command", "command": "${HOME}/.glass-atrium/hooks/validate-secret-scan.sh" } ] },
      { "matcher": "Edit",  "hooks": [ { "type": "command", "command": "~/.claude/hooks/legacy-old-dir.sh" } ] },
      { "matcher": "Read",  "hooks": [ { "type": "command", "command": "~/my-hooks/foreign.sh" } ] }
    ]
  }
}
JSON
}

@test "dual-dir: ~/.glass-atrium/hooks AND legacy ~/.claude/hooks bindings both removed; foreign preserved" {
  write_dualdir_sample
  run_unwire_sandbox
  [[ "${status}" -eq 0 ]]
  jq -e . "${SETTINGS}" >/dev/null
  # both Atrium dirs are swept (new-dir tilde + absolute forms, and the legacy old dir)
  [[ "$(count_cmd '.glass-atrium/hooks/')" -eq 0 ]]
  [[ "$(count_cmd '.claude/hooks/')" -eq 0 ]]
  # the foreign user hook under neither Atrium dir survives, exactly once
  [[ "$(count_cmd '~/my-hooks/foreign.sh')" -eq 1 ]]
  # PreToolUse kept, holding only the one surviving foreign group
  [[ "$(jq -r '.hooks.PreToolUse | length' "${SETTINGS}")" -eq 1 ]]
}

@test "dry-run -> no mutation, no backup (reports intent only)" {
  write_sample
  local before
  before="$(jq -cS . "${SETTINGS}")"
  run_unwire_sandbox dry
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"dry-run: skipping settings.json un-wire"* ]]
  # settings.json is byte-for-byte (semantically) unchanged
  [[ "$(jq -cS . "${SETTINGS}")" == "${before}" ]]
  # no backup file was created
  [[ -z "$(find "${TARGET}" -name 'settings.json.ga-backup.*' 2>/dev/null | head -1)" ]]
}
