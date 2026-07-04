#!/usr/bin/env bats
# wire_hooks idempotent settings.json MERGE (glass-atrium `wire-hooks` subcommand).
#
# wire_hooks UPSERTS each EXPECTED_HOOK_BINDINGS entry into the user-owned
# settings.json under its event, attaching the declared matcher + the
# "$HOME/.glass-atrium/hooks/<basename>" command (repointed from ~/.claude/hooks).
# It MUST:
#   * MERGE (preserve every other key byte-for-byte) — never overwrite.
#   * be IDEMPOTENT — an already-present command is a no-op (no duplicate).
#   * be ATOMIC + BACKED UP — temp-file + mv, timestamped backup before mutating.
#   * LOUD-FAIL on a malformed settings.json; create a minimal {} when absent.
#
# Run via: bats test/wire-hooks-merge.bats
# Requires: bats (brew install bats-core), jq, bash 3.2+
#
# Hermetic strategy: GA_TARGET_HOME points the target (and thus SETTINGS_JSON =
# <target>/settings.json) at a throwaway temp dir, so the test drives the REAL
# wire_hooks against a synthetic settings.json WITHOUT touching ~/.claude.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  TARGET="$(mktemp -d -t ga-wire-bats.XXXXXX)"
  SETTINGS="${TARGET}/settings.json"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
}

# Run the real wire-hooks subcommand against the sandboxed target.
run_wire_sandbox() {
  GA_TARGET_HOME="${TARGET}" run "${REAL_GA}" wire-hooks
}

# Count how many command entries (any event) reference the given basename.
count_bound() {
  local base="$1"
  jq --arg b "${base}" '
    [ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command
      | select(endswith("/" + $b)) ] | length
  ' "${SETTINGS}"
}

@test "absent settings.json -> minimal skeleton created + all bindings wired" {
  [[ ! -f "${SETTINGS}" ]]
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # the merged file is valid JSON and now contains the 3 P1 advisory hooks
  jq -e . "${SETTINGS}" >/dev/null
  [[ "$(count_bound advisory-spawn-budget.sh)" -eq 1 ]]
  [[ "$(count_bound advisory-context-budget.sh)" -eq 1 ]]
  [[ "$(count_bound validate-tool-response.sh)" -eq 1 ]]
}

@test "absent binding -> added under the correct event with the right matcher" {
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # advisory-spawn-budget lands under PreToolUse with matcher "Agent"
  run jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("/advisory-spawn-budget.sh")) | .matcher' "${SETTINGS}"
  [[ "${output}" == "Agent" ]]
  # validate-tool-response lands under PostToolUse with the WebFetch|WebSearch matcher
  run jq -r '.hooks.PostToolUse[] | select(.hooks[].command | endswith("/validate-tool-response.sh")) | .matcher' "${SETTINGS}"
  [[ "${output}" == 'WebFetch|WebSearch|mcp__.*(fetch|get|read|search).*' ]]
  # the command path is the repointed $HOME/.glass-atrium/hooks/<name> form
  run jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("/advisory-spawn-budget.sh")) | .hooks[].command' "${SETTINGS}"
  [[ "${output}" == "${HOME}/.glass-atrium/hooks/advisory-spawn-budget.sh" ]]
}

@test "Workflow binding -> wired under PreToolUse with matcher Workflow (new event/matcher combo)" {
  # enforce-workflow-verify-stage.sh is the NEW PreToolUse + Workflow-matcher
  # binding — wire_hooks must upsert it via the matcher-generic merge path.
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # exactly one occurrence, landed under PreToolUse with matcher "Workflow"
  [[ "$(count_bound enforce-workflow-verify-stage.sh)" -eq 1 ]]
  run jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("/enforce-workflow-verify-stage.sh")) | .matcher' "${SETTINGS}"
  [[ "${output}" == "Workflow" ]]
  # command path is the repointed $HOME/.glass-atrium/hooks/<name> form
  run jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("/enforce-workflow-verify-stage.sh")) | .hooks[].command' "${SETTINGS}"
  [[ "${output}" == "${HOME}/.glass-atrium/hooks/enforce-workflow-verify-stage.sh" ]]
}

@test "Workflow binding -> idempotent: re-run adds no second occurrence" {
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound enforce-workflow-verify-stage.sh)" -eq 1 ]]
  # second run must skip it (already wired), no duplicate
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound enforce-workflow-verify-stage.sh)" -eq 1 ]]
  [[ "${output}" == *"skip (already wired): PreToolUse -> enforce-workflow-verify-stage.sh (matcher=Workflow)"* ]]
}

@test "already-present binding -> NOT duplicated (idempotent re-run)" {
  # first run wires everything from a bare skeleton
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound validate-tool-response.sh)" -eq 1 ]]
  # second run must be a pure no-op for every binding (no duplicates)
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound advisory-spawn-budget.sh)" -eq 1 ]]
  [[ "$(count_bound advisory-context-budget.sh)" -eq 1 ]]
  [[ "$(count_bound validate-tool-response.sh)" -eq 1 ]]
  [[ "${output}" == *"skip (already wired)"* ]]
}

@test "pre-wired hook (any matcher) -> recognized as bound, no duplicate added" {
  # advisory-spawn-budget pre-wired under a DIFFERENT matcher group shape than
  # wire_hooks would create — basename compare within the event must still match.
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
  # still exactly one advisory-spawn-budget entry (the pre-existing one), not 2
  [[ "$(count_bound advisory-spawn-budget.sh)" -eq 1 ]]
  [[ "${output}" == *"skip (already wired): PreToolUse -> advisory-spawn-budget.sh"* ]]
}

# Count command entries for a basename SCOPED to a specific matcher (matcher-aware
# — distinguishes the same hook bound under two different matchers).
count_bound_matcher() {
  local base="$1" matcher="$2"
  jq --arg b "${base}" --arg m "${matcher}" '
    [ .hooks // {} | to_entries[] | .value[]?
      | select((.matcher // "") == $m)
      | .hooks[]? | .command
      | select(endswith("/" + $b)) ] | length
  ' "${SETTINGS}"
}

@test "two-matcher one-hook -> Bash matcher added when Write|Edit already present" {
  # validate-secret-scan.sh pre-wired ONLY under Write|Edit. wire_hooks must add
  # the SECOND (Bash) matcher group — the Write|Edit presence must NOT mask it
  # (command-WITHIN-matcher idempotency key, not command-within-event).
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "~/.claude/hooks/validate-secret-scan.sh" } ] }
    ]
  }
}
JSON
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # exactly one Write|Edit and one Bash group for validate-secret-scan (no dup)
  [[ "$(count_bound_matcher validate-secret-scan.sh 'Write|Edit')" -eq 1 ]]
  [[ "$(count_bound_matcher validate-secret-scan.sh 'Bash')" -eq 1 ]]
  # total across matchers = 2 (one per matcher), not 1 and not 3
  [[ "$(count_bound validate-secret-scan.sh)" -eq 2 ]]
  [[ "${output}" == *"wired: PreToolUse -> validate-secret-scan.sh (matcher=Bash)"* ]]
  [[ "${output}" == *"skip (already wired): PreToolUse -> validate-secret-scan.sh (matcher=Write|Edit)"* ]]
}

@test "two-matcher one-hook -> idempotent: re-run adds no third occurrence" {
  # from a bare skeleton, wire everything (validate-secret-scan lands under BOTH
  # matchers), then re-run: still exactly one group per matcher, no duplicates.
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound_matcher validate-secret-scan.sh 'Write|Edit')" -eq 1 ]]
  [[ "$(count_bound_matcher validate-secret-scan.sh 'Bash')" -eq 1 ]]
  [[ "$(count_bound validate-secret-scan.sh)" -eq 2 ]]
  # second run is a pure no-op for both matchers
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound_matcher validate-secret-scan.sh 'Write|Edit')" -eq 1 ]]
  [[ "$(count_bound_matcher validate-secret-scan.sh 'Bash')" -eq 1 ]]
  [[ "$(count_bound validate-secret-scan.sh)" -eq 2 ]]
}

@test "user-owned keys -> PRESERVED untouched across the merge" {
  cat >"${SETTINGS}" <<'JSON'
{
  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },
  "env": { "MY_USER_VAR": "keepme" },
  "model": "user-pinned-model",
  "statusLine": { "type": "command", "command": "my-statusline" },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/my-own-hook.sh" } ] }
    ]
  }
}
JSON
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  # every user-owned key is byte-equal to its pre-merge value
  [[ "$(jq -c '.permissions' "${SETTINGS}")" == '{"allow":["Bash(ls:*)"],"deny":[]}' ]]
  [[ "$(jq -r '.env.MY_USER_VAR' "${SETTINGS}")" == "keepme" ]]
  [[ "$(jq -r '.model' "${SETTINGS}")" == "user-pinned-model" ]]
  [[ "$(jq -r '.statusLine.command' "${SETTINGS}")" == "my-statusline" ]]
  # the user's OWN hook entry survives alongside the newly merged Atrium ones
  [[ "$(count_bound my-own-hook.sh)" -eq 1 ]]
  [[ "$(count_bound advisory-spawn-budget.sh)" -eq 1 ]]
}

@test "merge backs up settings.json to a timestamped file before mutating" {
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"backed up settings.json -> ${SETTINGS}.ga-backup."* ]]
  # the backup exists and is valid JSON identical to the pre-merge content
  local backup
  backup="$(find "${TARGET}" -name 'settings.json.ga-backup.*' | head -1)"
  [[ -n "${backup}" ]]
  [[ "$(jq -c . "${backup}")" == '{"hooks":{}}' ]]
}

@test "malformed settings.json -> ABORT, original left intact (no corruption)" {
  printf '%s\n' '{ this is not json' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"not valid JSON"* ]]
  # the broken file is untouched (still byte-identical) — never silently rewritten
  [[ "$(cat "${SETTINGS}")" == '{ this is not json' ]]
}

@test "settings.json IS a symlink (dotfiles) -> converted to a regular file, link severed, target preserved, backup taken" {
  # RISKY EDGE (a): a dotfiles-managed settings.json is a SYMLINK into an external
  # store. wire_hooks `cp -p` FOLLOWS the symlink into the backup (backup = target
  # content), then `mv -f RENDER_TMP SETTINGS_JSON` REPLACES the symlink NAME with
  # a regular file — SEVERING the dotfiles link while leaving the original target
  # file byte-untouched. This pins all four current-behavior facts so a later
  # hook-repoint change cannot worsen the severance unnoticed.
  local store="${TARGET}/dotfiles-store"
  mkdir -p "${store}"
  local target_file="${store}/real-settings.json"
  cat >"${target_file}" <<'JSON'
{ "model": "dotfiles-pinned", "hooks": {} }
JSON
  local before_target
  before_target="$(jq -cS . "${target_file}")"
  ln -s "${target_file}" "${SETTINGS}"
  [[ -L "${SETTINGS}" ]] # precondition: settings.json starts as a symlink

  run_wire_sandbox
  [[ "${status}" -eq 0 ]]

  # FACT 1 — settings.json is now a REGULAR file (no longer a symlink)
  [[ -f "${SETTINGS}" && ! -L "${SETTINGS}" ]]
  # FACT 2 — the dotfiles link is SEVERED: the new regular file is a distinct inode
  # from the store target (mutating settings.json no longer writes through).
  [[ "$(count_bound advisory-spawn-budget.sh)" -eq 1 ]] # merge landed on the new file
  # FACT 3 — the original target file is byte-preserved (never written through)
  [[ "$(jq -cS . "${target_file}")" == "${before_target}" ]]
  [[ "$(jq -r '.hooks | has("PreToolUse")' "${target_file}")" == "false" ]]
  # FACT 4 — a timestamped backup exists, and it holds the pre-merge (followed) content
  [[ "${output}" == *"backed up settings.json -> ${SETTINGS}.ga-backup."* ]]
  local backup
  backup="$(find "${TARGET}" -name 'settings.json.ga-backup.*' | head -1)"
  [[ -n "${backup}" ]]
  [[ "$(jq -r '.model' "${backup}")" == "dotfiles-pinned" ]]
}

@test "doctor reports 0 dormant after wire-hooks (reconciliation)" {
  # bare skeleton → wire → doctor must report no dormant bindings
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  GA_TARGET_HOME="${TARGET}" run "${REAL_GA}" doctor
  [[ "${output}" != *"dormant hook binding(s)"* ]]
  [[ "${output}" == *"ok   : hook bound — PreToolUse -> advisory-spawn-budget.sh"* ]]
  [[ "${output}" == *"ok   : hook bound — PostToolUse -> validate-tool-response.sh"* ]]
}
