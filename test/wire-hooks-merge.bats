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
  # Skip 3 assertion-IRRELEVANT heavy doctor sections via the existing test-mode seams.
  # The doctor test asserts ONLY §6 dormant-count — never §8 manifest / auth self-test / §reports.
  mkdir -p "${TARGET}/bin" "${TARGET}/empty-reports"
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"             # echo-OK stub → no live claude -p network call
  export DOCTOR_AUTH_REPORTS_DIR="${TARGET}/empty-reports"     # empty dir → trivial daemon-reports scan
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

@test "Workflow matcher -> BOTH Workflow hooks EMITTED by the wire loop as independent leaves" {
  # EMISSION axis — the one property no other suite owns. Three axes are in play:
  # roster MEMBERSHIP (hook-bindings-complete.bats :: per-event leaf count) and
  # roster MATCHER VALUE (doctor-hook-bindings.bats :: Workflow-matcher binding)
  # are both owned, but neither can witness what wire_hooks EMITS — the first two
  # read lib/ga-env.sh's roster, and doctor-hook-bindings asserts against a
  # hand-written heredoc fixture (write_full_settings), never against wire output.
  # A hook-specific `continue` inside the roster-generic wire_hooks loop, roster
  # fully intact, reds HERE and nowhere else.
  # Both hooks declare the SAME matcher, so this is also the wire-side pin that
  # they land as two INDEPENDENT, non-masking leaves: is_hook_bound keys on
  # basename WITHIN the matcher, and a matcher-only key would let the first
  # Workflow row mask the second into a silent skip.
  printf '%s\n' '{ "hooks": {} }' >"${SETTINGS}"
  run_wire_sandbox
  [[ "${status}" -eq 0 ]] || return 1

  local a='enforce-workflow-verify-stage.sh' b='lint-workflow-template-literal.sh'
  # every Workflow-matcher command for the two basenames, sorted — one read that
  # pins event + matcher + repointed command path together.
  local cmds
  cmds="$(jq -r --arg a "${a}" --arg b "${b}" '
    [ .hooks.PreToolUse[]? | select((.matcher // "") == "Workflow")
      | .hooks[]?.command | select(endswith("/" + $a) or endswith("/" + $b)) ]
    | sort | join(",")' "${SETTINGS}")"

  # ONE && chain: every clause decides the test. Written as separate mid-body
  # [[ ]] lines they would be inert — bash errexit does not fire on a failing
  # [[ ]] keyword conditional, so only the LAST line of a test can red it.
  [[ "$(count_bound "${a}")" -eq 1 ]] &&
    [[ "$(count_bound "${b}")" -eq 1 ]] &&
    [[ "$(count_bound_matcher "${a}" 'Workflow')" -eq 1 ]] &&
    [[ "$(count_bound_matcher "${b}" 'Workflow')" -eq 1 ]] &&
    [[ "${cmds}" == "${HOME}/.glass-atrium/hooks/${a},${HOME}/.glass-atrium/hooks/${b}" ]]
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

@test "U-B stale matcher -> a bogus matcher on a MATCHER-LESS expected hook is dropped" {
  # agent-tracker.sh is expected under SubagentStart with NO matcher. A row carrying
  # a matcher is therefore stale. This is the empty-field edge: the expected matcher
  # is "", which a tab-IFS read would silently collapse away.
  cat >"${SETTINGS}" <<'JSON'
{
  "hooks": {
    "SubagentStart": [
      { "matcher": "Bogus", "hooks": [ { "type": "command", "command": "~/.claude/hooks/agent-tracker.sh" } ] }
    ]
  }
}
JSON
  run_wire_sandbox
  [[ "${status}" -eq 0 ]]
  [[ "$(count_bound agent-tracker.sh)" -eq 2 ]] # SubagentStart + SubagentStop, both matcher-less
  [[ "$(count_bound_matcher agent-tracker.sh 'Bogus')" -eq 0 ]]
  run jq -r '[ .hooks.SubagentStart[] | select(.hooks[].command | endswith("/agent-tracker.sh")) | (.matcher // "<none>") ] | join(",")' "${SETTINGS}"
  [[ "${output}" == "<none>" ]]
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
  [[ "${status}" -eq 0 ]] || return 1
  GA_TARGET_HOME="${TARGET}" run "${REAL_GA}" doctor
  # ONE && chain so the DORMANCY claim — the whole point of this case — actually
  # decides it. As three separate mid-body [[ ]] lines the first two were inert:
  # bash errexit does not fire on a failing [[ ]] keyword conditional, so only the
  # last line could red the case and the reconciliation claim asserted nothing.
  [[ "${output}" != *"dormant hook binding(s)"* ]] &&
    [[ "${output}" == *"ok   : hook bound — PreToolUse -> advisory-spawn-budget.sh"* ]] &&
    [[ "${output}" == *"ok   : hook bound — PostToolUse -> validate-tool-response.sh"* ]]
}
