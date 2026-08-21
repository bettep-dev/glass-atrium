#!/usr/bin/env bats
# doctor-registry-orphan.bats — pins run_doctor §17 (registry keys with no agent body).
#
# The registry names the selectable agents; each key's body is a sibling file under agents/. A key
# whose body is absent therefore names an agent a router can select and a spawn cannot load, and
# nothing read that state: the create path reports its failure once, on a line that scrolls past.
#
# The rows below are chosen so no one of them can be satisfied by a check that merely prints the
# registry: each asserts a token or a property the others must not produce.
#   AC1  a key with no body        -> warn naming the key AND the absent body path, plus the remedy
#   AC2  every key bodied          -> ok (a different token), and no warn of this section
#   AC3  exit status               -> IDENTICAL with and without the orphan (advisory, as specified)
#   AC4  an unparseable registry   -> the reader-blind warn, and NO claim that the keys reconcile
#   AC5  reported set = orphan set -> a bodied sibling of an orphan is never named (counting property)
#
# Hermetic: GA_ROOT is a throwaway sandbox passed to ga_init_env in a subprocess, the target home,
# runtime-data root and update state dir are temp dirs, the manifest generator path does not exist
# (§8 hashing skipped) and the monitor port is dead (§16 curls nothing). No ~/.claude or
# ~/.glass-atrium state is read or written, and no live registry is consulted.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` / `(( ))` does NOT gate — the keyword is read as a
# tested condition — whereas a plain command's non-zero return IS caught mid-body. Every assertion
# here `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats test/doctor-registry-orphan.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-registry-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  REGISTRY="${GA_SANDBOX}/agent-registry.json"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Write a registry whose `agents` member carries each named key with a minimal entry.
seed_registry() {
  local key entries=""
  for key in "$@"; do
    entries="${entries}${entries:+,}\"${key}\":{\"domains\":[\"x\"],\"phase\":\"implementation\"}"
  done
  printf '{"version":"1.0.0","agents":{%s}}\n' "${entries}" >"${REGISTRY}"
}

# Lay the body file a registry key is reconciled against.
seed_body() {
  printf -- '---\nname: %s\n---\nbody\n' "$1" >"${GA_SANDBOX}/agents/${1}.md"
}

# Run the REAL run_doctor against the sandbox GA_ROOT in a fresh strict-mode subprocess. The update
# state dir is sandboxed too: §18 reads the arbiter decision records from it, and an unpinned one
# would make this suite's verdict a property of the developer's live install.
run_doctor_sandbox() {
  run env GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC1 — a bodiless key is named, with the body path it lacks and the remedy ──────────────────

@test "AC1: a registry key with no agent body warns, naming the key and the absent body" {
  seed_registry "glass-atrium-dev-ghost"
  run_doctor_sandbox
  assert_output_has "warn : registry key with no agent body — glass-atrium-dev-ghost" || return 1
  assert_output_has "agents/glass-atrium-dev-ghost.md absent" || return 1
  # a verdict with no next step leaves the operator where the scrolled-past create line did
  assert_output_has "remedy: re-run 'glass-atrium update' to lay the missing body" || return 1
  assert_output_lacks "every agent-registry key has a body" || return 1
}

# ── AC2 — a fully bodied registry is a different token, and raises nothing ─────────────────────

@test "AC2: every key bodied emits ok and no registry warning" {
  seed_registry "glass-atrium-dev-a" "glass-atrium-dev-b"
  seed_body "glass-atrium-dev-a"
  seed_body "glass-atrium-dev-b"
  run_doctor_sandbox
  assert_output_has "ok   : every agent-registry key has a body under agents/" || return 1
  assert_output_lacks "registry key with no agent body" || return 1
  assert_output_lacks "agent registry unparseable" || return 1
}

# ── AC3 — advisory means the exit status does not move ─────────────────────────────────────────

@test "AC3: the orphan changes no exit status — the same sandbox exits identically without it" {
  seed_registry "glass-atrium-dev-a"
  seed_body "glass-atrium-dev-a"
  run_doctor_sandbox
  local bodied_status="${status}"
  assert_output_lacks "registry key with no agent body" || return 1

  rm -f -- "${GA_SANDBOX}/agents/glass-atrium-dev-a.md"
  run_doctor_sandbox
  assert_output_has "registry key with no agent body" || return 1
  [[ "${status}" -eq "${bodied_status}" ]] || {
    echo "orphan moved the exit status: ${bodied_status} -> ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC4 — a registry this reader cannot parse is reported as blind, never as reconciled ────────

@test "AC4: an unparseable registry warns that the reconciliation could not run" {
  printf '{"agents": {"broken"\n' >"${REGISTRY}"
  run_doctor_sandbox
  assert_output_has "warn : agent registry unparseable" || return 1
  assert_output_lacks "every agent-registry key has a body" || return 1
  assert_output_lacks "registry key with no agent body" || return 1
}

# ── AC5 — the reported set is exactly the orphan set ───────────────────────────────────────────

@test "AC5: only the bodiless keys are named — a bodied sibling never appears" {
  seed_registry "glass-atrium-dev-bodied" "glass-atrium-dev-ghost"
  seed_body "glass-atrium-dev-bodied"
  run_doctor_sandbox
  assert_output_has "registry key with no agent body — glass-atrium-dev-ghost" || return 1
  assert_output_lacks "registry key with no agent body — glass-atrium-dev-bodied" || return 1
  local named
  named="$(printf '%s\n' "${output}" | grep -c "registry key with no agent body" || true)"
  [[ -z "${named}" ]] && named=0
  [[ "${named}" -eq 1 ]] || {
    echo "expected exactly one named orphan, got ${named} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}
