#!/usr/bin/env bats
# sync-registry-tools.sh tests: duplicate-frontmatter-key rejection (the
# quoted-key widening smuggle), plus the benign sync/idempotency paths that
# must keep working.
#
# The script's roots are hardcoded `${HOME}/.claude/...` (readonly, no CLI or
# env override), so every case runs against a synthetic HOME — the live
# ~/.claude registry is structurally unreachable from here.
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
  # A `pip install --user` PyYAML lives under the REAL home, so the synthetic
  # HOME below would hide it; pin the user base to the real one first so the
  # override relocates only the script's own roots.
  PYTHONUSERBASE="$(python3 -c 'import site; print(site.getuserbase())' 2>/dev/null)" || true
  export PYTHONUSERBASE
  export HOME="${WORK}/home"
  python3 -c 'import yaml' 2>/dev/null \
    || skip "PyYAML not importable under python3 — sync-registry-tools.sh cannot run; install requirements.txt on this leg"
  AGENTS_DIR="${HOME}/.claude/agents"
  REGISTRY="${HOME}/.claude/agent-registry.json"
  export REG="${REGISTRY}"
  mkdir -p "${AGENTS_DIR}"
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
  } >"${AGENTS_DIR}/glass-atrium-dev-x.md"
}

registry_tools() {
  python3 -c 'import json,os,sys; print(json.load(open(os.environ["REG"]))["agents"]["glass-atrium-dev-x"]["tools"])' \
    2>/dev/null
}

# --- duplicate guarded key: the last-wins widening smuggle ------------------

@test "duplicate quoted tools key: refused, registry not widened" {
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read]
"tools": [Read, Bash, Write]'
  local before
  before="$(cat "${REGISTRY}")"
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"parse failed"* ]] || return 1
  [[ "$(cat "${REGISTRY}")" == "${before}" ]] || return 1
}

@test "duplicate bare tools key: refused, registry not widened" {
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read]
tools: [Read, Bash, Write]'
  local before
  before="$(cat "${REGISTRY}")"
  run "${SCRIPT}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(cat "${REGISTRY}")" == "${before}" ]] || return 1
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
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read, Bash]'
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
  write_agent_md 'name: glass-atrium-dev-x
tools: [Read]'
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
