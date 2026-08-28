#!/usr/bin/env bats
# sync-registry-tools.sh tests: duplicate-frontmatter-key rejection (the
# quoted-key widening smuggle), the root-resolution / DRY_RUN / --check
# contract, the atomic write path and its validate seam, plus the benign
# sync/idempotency paths that must keep working.
#
# Isolation runs through the tool's OWN root seam: setup exports a synthetic
# `GA_ROOT`, which outranks the `${HOME}/.glass-atrium` default, so the live
# install is unreachable from here while the REAL HOME keeps resolving a
# `pip install --user` PyYAML. (This file used to substitute HOME instead and
# then pin PYTHONUSERBASE to undo the resulting import breakage; both went away
# together — a pin left behind after the substitution is gone would be a false
# green, since it would still pass with the isolation removed.)
#
# EVERY assertion carries `|| return 1`: a bare `[[ ... ]]` that fails mid-body
# does NOT fail the test on bats 1.13 (only the final command's status is
# consulted), so an unguarded mid-body assertion is silently vacuous.
#
# Run via: bats scripts/test/sync-registry-tools.bats
# Requires: bats (brew install bats-core), python3 with PyYAML (the script's
# own runtime dependency — a missing PyYAML loudly SKIPs rather than reds).

SCRIPT="${BATS_TEST_DIRNAME}/../sync-registry-tools.sh"

setup() {
  [[ -x "${SCRIPT}" ]] || skip "sync-registry-tools.sh not executable: ${SCRIPT}"
  WORK="$(mktemp -d -t sync-registry-tools-bats.XXXXXX)"
  export GA_ROOT="${WORK}/root"
  python3 -c 'import yaml' 2>/dev/null \
    || skip "PyYAML not importable under python3 — sync-registry-tools.sh cannot run; install requirements.txt on this leg"
  # The two paths the script derives from the root; the fixtures land here.
  AGENTS="${GA_ROOT}/agents"
  REGISTRY="${GA_ROOT}/agent-registry.json"
  export REG="${REGISTRY}"
  mkdir -p "${AGENTS}"
  cat >"${REGISTRY}" <<'JSON'
{
  "agents": {
    "glass-atrium-dev-x": {
      "domains": [
        "x"
      ],
      "tools": [
        "Read"
      ],
      "phase": 3
    }
  }
}
JSON
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# Write an agent .md whose frontmatter body is `$1` (the text between fences).
write_agent_md() {
  local frontmatter="$1"
  {
    printf -- '---\n'
    printf '%s\n' "${frontmatter}"
    printf -- '---\n\n> Rules: GLASS_ATRIUM_GLOBAL_RULES.md (ALL + DEV)\n'
  } >"${AGENTS}/glass-atrium-dev-x.md"
}

# The `tools:` VALUE is the only frontmatter most cases vary — `$1` is that value.
# A case probing the frontmatter SHAPE itself (a duplicate key, a block list,
# malformed YAML) writes the whole body through write_agent_md instead.
write_agent_tools() {
  write_agent_md "name: glass-atrium-dev-x
tools: ${1}"
}

# Snapshot the registry bytes, then assert them byte-identical (or not) — "wrote
# nothing" is the shared claim of the refusal, dry-run and failed-write cases.
# The snapshot is a global so neither assertion needs an argument, and no test
# body reads it directly.
snapshot_registry() {
  REGISTRY_BEFORE="$(cat "${REGISTRY}")"
}

assert_registry_unchanged() {
  [[ "$(cat "${REGISTRY}")" == "${REGISTRY_BEFORE}" ]] || {
    echo "registry changed, but this case requires it untouched" >&2
    return 1
  }
}

assert_registry_changed() {
  [[ "$(cat "${REGISTRY}")" != "${REGISTRY_BEFORE}" ]] || {
    echo "registry unchanged, but this case requires a write" >&2
    return 1
  }
}

# Build a SECOND root (outside GA_ROOT) so root precedence has somewhere else
# to resolve to. Its registry is fixed at the canonical `["Read"]` serialization
# (byte-identical to what the tool re-emits, so a match really is `updated=0`);
# `$1` is the frontmatter `tools:` value, which is what decides drift vs clean.
write_alt_root() {
  local fm_tools="$1"
  ALT="${WORK}/alt"
  mkdir -p "${ALT}/agents"
  {
    printf -- '---\n'
    printf 'name: glass-atrium-dev-x\ntools: %s\n' "${fm_tools}"
    printf -- '---\n\n> body\n'
  } >"${ALT}/agents/glass-atrium-dev-x.md"
  cat >"${ALT}/agent-registry.json" <<'JSON'
{
  "agents": {
    "glass-atrium-dev-x": {
      "domains": [
        "x"
      ],
      "tools": [
        "Read"
      ],
      "phase": 3
    }
  }
}
JSON
}

registry_tools() {
  python3 -c 'import json,os,sys; print(json.load(open(os.environ["REG"]))["agents"]["glass-atrium-dev-x"]["tools"])' \
    2>/dev/null
}

# Count atomic-helper temp files (`<target>.XXXXXX.al-tmp`) left beside the
# registry. The helper removes its temp on ANY failure, so a surviving one means
# the write path aborted without cleaning up.
temp_leftovers() {
  find "${GA_ROOT}" -maxdepth 1 -name '*.al-tmp' | wc -l | tr -d '[:space:]'
}

# --- duplicate guarded key: the last-wins widening smuggle ------------------

@test "duplicate quoted tools key: refused, registry not widened" {
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read]
"tools": [Read, Bash, Write]'
  snapshot_registry
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"parse failed"* ]] || return 1
  assert_registry_unchanged || return 1
}

@test "duplicate bare tools key: refused, registry not widened" {
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read]
tools: [Read, Bash, Write]'
  snapshot_registry
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
  assert_registry_unchanged || return 1
}

@test "duplicate single-quoted tools key: refused" {
  write_agent_md "name: glass-atrium-dev-x
'tools': [Read]
tools: [Read, Bash]"
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "duplicate name key: refused (rejection is not tools-only)" {
  write_agent_md 'name: glass-atrium-dev-x
name: glass-atrium-dev-y
tools: [Read]'
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "duplicate key under --dry-run: refused before any planned update" {
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read]
"tools": [Read, Bash]'
  run "${SCRIPT}" --dry-run
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" != *"PLANNED UPDATES"* ]] || return 1
}

# --- benign paths (non-regression) -----------------------------------------

@test "single tools key differing from registry: synced through" {
  write_agent_tools '[Read, Bash]'
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"updated=1"* ]] || return 1
  run registry_tools
  [[ "${output}" == "['Read', 'Bash']" ]] || return 1
}

@test "quoted single tools key: parsed as an ordinary key" {
  write_agent_md 'name: glass-atrium-dev-x
"tools": [Read, Bash]'
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"updated=1"* ]] || return 1
}

@test "already-matching tools: idempotent no-op" {
  write_agent_tools '[Read]'
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"synced=1 updated=0"* ]] || return 1
}

@test "block-list tools: parsed as a list, synced" {
  write_agent_md 'name: glass-atrium-dev-x
tools:
  - Read
  - Bash'
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"updated=1"* ]] || return 1
}

@test "malformed yaml: still refused (existing fail-closed path)" {
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read'
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
}

# --- root resolution · DRY_RUN contract · --check ---------------------------

@test "--check on drift: nonzero exit, registry untouched" {
  write_agent_tools '[Read, Bash]'
  snapshot_registry
  run "${SCRIPT}" --check
  [[ "${status}" -eq 3 ]] || return 1
  [[ "${output}" == *"DRIFT"* ]] || return 1
  assert_registry_unchanged || return 1
}

@test "--check on a converged registry: exit 0" {
  write_agent_tools '[Read]'
  run "${SCRIPT}" --check
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"synced=1 updated=0"* ]] || return 1
  [[ "${output}" != *"DRIFT"* ]] || return 1
}

@test "--root outranks GA_ROOT: the flag's root decides the verdict" {
  # GA_ROOT is converged; the --root tree drifts. A rc-3 verdict can only come
  # from the flag's tree, and the reverse pairing must then come back rc 0.
  write_agent_tools '[Read]'
  write_alt_root '[Read, Bash]'
  run "${SCRIPT}" --root "${ALT}" --check
  [[ "${status}" -eq 3 ]] || return 1
  write_alt_root '[Read]'
  run "${SCRIPT}" --root "${ALT}" --check
  [[ "${status}" -eq 0 ]] || return 1
}

@test "DRY_RUN=1: dry-run, not a write (only empty/false/0 opt out)" {
  write_agent_tools '[Read, Bash]'
  snapshot_registry
  run env DRY_RUN=1 "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"PLANNED UPDATES"* ]] || return 1
  assert_registry_unchanged || return 1
  # ...and the documented opt-out still writes, so the guard is not blanket.
  run env DRY_RUN=0 "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  assert_registry_changed || return 1
}

@test "--dry-run overrides a write-mode DRY_RUN env: planned, never written" {
  # DRY_RUN contract ROW 4 — the flag wins over an env value that would
  # otherwise select write mode. The only other `--dry-run` case exits 2 at
  # frontmatter parse, before the write path, so it asserts nothing here: a
  # regression that accepted the flag but stopped reaching the python verdict
  # would keep that case green while WRITING the live registry.
  write_agent_tools '[Read, Bash]'
  snapshot_registry
  run env DRY_RUN=false "${SCRIPT}" --dry-run
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"PLANNED UPDATES"* ]] || return 1
  assert_registry_unchanged || return 1
}

@test "failure seam: an unreadable root fails loudly and writes nothing" {
  write_agent_tools '[Read, Bash]'
  local missing
  snapshot_registry
  missing="${WORK}/absent-root"
  run "${SCRIPT}" --root "${missing}" --check
  [[ "${status}" -eq 1 ]] || return 1
  [[ "${output}" == *"registry load failed"* ]] || return 1
  [[ "${output}" == *"${missing}"* ]] || return 1
  assert_registry_unchanged || return 1
}

# --- atomic write path · SYNC_REGISTRY_FAIL_VALIDATE seam -------------------
#
# The write goes through agent_lifecycle.atomic (temp + re-parse + os.replace).
# `SYNC_REGISTRY_FAIL_VALIDATE` arms the helper's PUBLIC `validate=` callback to
# reject, which is the only failure point a caller can reach — the helper binds
# `before_replace` internally. Restoring the old direct `write_text` makes the
# seam inert, so these four cases go red together: that is their RED control.

@test "write seam armed: the drifted write fails loudly, registry byte-identical" {
  write_agent_tools '[Read, Bash]'
  snapshot_registry
  run env SYNC_REGISTRY_FAIL_VALIDATE=1 "${SCRIPT}"
  [[ "${status}" -eq 1 ]] || return 1
  [[ "${output}" == *"registry write failed"* ]] || return 1
  # The helper's own rejection text — this is what pins the write to the atomic
  # path rather than to a direct write that happened to raise.
  [[ "${output}" == *"post-write validation rejected"* ]] || return 1
  assert_registry_unchanged || return 1
}

@test "write seam armed: no temp file survives beside the registry" {
  write_agent_tools '[Read, Bash]'
  run env SYNC_REGISTRY_FAIL_VALIDATE=1 "${SCRIPT}"
  [[ "${status}" -eq 1 ]] || return 1
  run temp_leftovers
  [[ "${output}" == "0" ]] || return 1
}

@test "write seam unset: the write lands and the result re-parses as JSON" {
  write_agent_tools '[Read, Bash]'
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"updated=1"* ]] || return 1
  # registry_tools parses the file, so a non-zero status here IS a parse failure.
  run registry_tools
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "['Read', 'Bash']" ]] || return 1
  run temp_leftovers
  [[ "${output}" == "0" ]] || return 1
}

@test "write seam armed under --check: the read-only contract is unaffected" {
  # The seam must live on the WRITE path only — CI and doctor consume --check,
  # and a seam that leaked into it would change their verdict.
  write_agent_tools '[Read, Bash]'
  snapshot_registry
  run env SYNC_REGISTRY_FAIL_VALIDATE=1 "${SCRIPT}" --check
  [[ "${status}" -eq 3 ]] || return 1
  [[ "${output}" == *"DRIFT"* ]] || return 1
  assert_registry_unchanged || return 1
}
