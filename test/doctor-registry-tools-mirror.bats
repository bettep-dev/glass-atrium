#!/usr/bin/env bats
# doctor-registry-tools-mirror.bats — pins run_doctor §23 (agent-registry `tools` mirror vs. each
# agent body's frontmatter `tools:`).
#
# The registry's per-agent `tools` array is a MIRROR: the Capability Probe reads the frontmatter,
# tooling that prefers JSON reads the mirror, and a drifted mirror hands a probe a grant the agent
# does not hold. Nothing on the install compared the two, so drift stayed silent until a delegation
# acted on it. The section reports and changes nothing: no counter, no term in the warning total, no
# exit-code effect (kind B) — both remedies (write the mirror, or fix the frontmatter) are operator
# decisions on live routing state.
#
# Each row asserts a property the others cannot produce:
#   AC1  a drifted mirror              -> one info row NAMING each drifted agent
#   AC2  a synced mirror               -> one ok row
#   AC3  python3 without PyYAML        -> one note row, comparison announced skipped
#   AC4  the tool cannot answer (rc 2) -> one note row carrying the exit code
#   AC5  the warning total             -> identical across all four cases (kind B)
#
# FIXTURE BYTE-SHAPE: `--check` reports drift by comparing the SERIALIZED registry against the file's
# current bytes, so a clean fixture must already be `json.dumps(indent=2, ensure_ascii=false)` +
# trailing newline — hand-formatted JSON would read as permanent drift. The fixtures are therefore
# generated through json.dumps rather than written out by hand.
#
# Hermetic: agents dir, registry and target home are sandbox files under a throwaway GA_ROOT; the
# manifest generator path does not exist and the monitor port is dead, so no live install state is
# read. The section under test runs the shipped sync tool with `--check` (a dry run by construction)
# pointed at the sandbox root, so nothing is written anywhere.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict — every assertion here
# `return 1`s on mismatch so each fails the test independently.
#
# Run via: bats test/doctor-registry-tools-mirror.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3 with PyYAML (the mirror reader's own dependency)

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  [[ -f "${GA}/scripts/sync-registry-tools.sh" ]] || skip "sync tool not found (the section delegates to it)"
  python3 -c 'import yaml' >/dev/null 2>&1 || skip "python3 with PyYAML absent — the section's own dependency"
  SANDBOX="$(mktemp -d -t ga-doctor-mirror-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STUB_BIN="${SANDBOX}/stub-bin"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STUB_BIN}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  seed_agent
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# One synthetic agent body. `tools:` is the frontmatter SoT the mirror is compared against; the
# registry key matches `name` so §17 (registry key with no body) stays quiet and cannot be mistaken
# for this section's row.
seed_agent() {
  cat >"${GA_SANDBOX}/agents/dev-alpha.md" <<'MD'
---
name: dev-alpha
tools: [Read, Grep]
---

Synthetic agent body.
MD
}

# Registry carrying dev-alpha with the tools passed as arguments, serialized exactly as the sync
# tool re-serializes it — see FIXTURE BYTE-SHAPE above.
seed_registry() {
  python3 - "$@" >"${GA_SANDBOX}/agent-registry.json" <<'PY'
import json
import sys

registry = {
    "version": "1.0.0",
    "agents": {"dev-alpha": {"domains": ["shell"], "tools": list(sys.argv[1:])}},
}
sys.stdout.write(json.dumps(registry, indent=2, ensure_ascii=False) + "\n")
PY
}

# A python3 that resolves but cannot import PyYAML — the same condition for this reader as no python3
# at all (the tool invokes a bare `python3`, so either way it cannot run). Shadowing the interpreter
# for the whole doctor run is safe here: every other python3 consumer in run_doctor already degrades
# to a note and moves no counter, which AC5 re-checks rather than assumes.
stub_python_without_yaml() {
  cat >"${STUB_BIN}/python3" <<'STUB'
#!/usr/bin/env bash
echo "ModuleNotFoundError: No module named 'yaml'" >&2
exit 1
STUB
  chmod +x "${STUB_BIN}/python3"
}

# A second agent body with no frontmatter delimiters — the sync tool's parse-error path, which exits
# 2. Chosen over a corrupt registry on purpose: an unparseable registry ALSO moves §17's counter,
# which would make AC5's kind-B comparison test two changes at once.
seed_unparseable_agent() {
  printf 'no frontmatter here\n' >"${GA_SANDBOX}/agents/broken.md"
}

run_doctor_sandbox() {
  run env PATH="${1:-${PATH}}" GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" \
    GA_MANIFEST="${MANIFEST}" GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
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

# The warning total the PASS summary reports: 0 on a bare PASS, the parenthesised number otherwise.
warn_total_of_output() {
  local line
  line="$(printf '%s\n' "${output}" | grep -F '== doctor: PASS' || true)"
  [[ -n "${line}" ]] || {
    echo "no PASS summary line — harness defect, not a drift verdict:" >&2
    echo "${output}" >&2
    return 1
  }
  case "${line}" in
    *"with "*" warning(s)"*)
      printf '%s' "${line}" | sed -e 's/.*with \([0-9][0-9]*\) warning(s).*/\1/'
      ;;
    *) printf '0' ;;
  esac
}

@test "AC1 a drifted mirror is reported on an info row naming the drifted agent" {
  seed_registry Read
  run_doctor_sandbox
  assert_output_has "tools mirror drift"
  assert_output_has "dev-alpha"
  # Report-only: the drift row is an info row, never a warn row that a counter would follow.
  printf '%s\n' "${output}" | grep -F 'tools mirror drift' | grep -qF '  info :' || {
    echo "drift row is not an info row — output:" >&2
    printf '%s\n' "${output}" | grep -F 'tools mirror drift' >&2
    return 1
  }
}

@test "AC2 a synced mirror reports one ok row and no drift" {
  seed_registry Read Grep
  run_doctor_sandbox
  assert_output_has "tools mirror matches"
  assert_output_lacks "tools mirror drift"
}

@test "AC3 a python3 that cannot import PyYAML lands on one note row" {
  seed_registry Read
  stub_python_without_yaml
  run_doctor_sandbox "${STUB_BIN}:${PATH}"
  assert_output_has "tools mirror not compared"
  assert_output_has "PyYAML"
  # The skipped comparison must not masquerade as either verdict.
  assert_output_lacks "tools mirror drift"
  assert_output_lacks "tools mirror matches"
}

@test "AC4 a mirror check that cannot answer is announced with its exit code" {
  seed_registry Read Grep
  seed_unparseable_agent
  run_doctor_sandbox
  assert_output_has "tools mirror not compared"
  assert_output_has "exited 2"
  assert_output_lacks "tools mirror matches"
}

@test "AC5 the warning total is identical across all four cases (kind B)" {
  local synced drifted unavailable unanswerable
  seed_registry Read Grep
  run_doctor_sandbox
  synced="$(warn_total_of_output)"

  seed_registry Read
  run_doctor_sandbox
  drifted="$(warn_total_of_output)"
  assert_output_has "tools mirror drift"

  stub_python_without_yaml
  run_doctor_sandbox "${STUB_BIN}:${PATH}"
  unavailable="$(warn_total_of_output)"

  seed_registry Read Grep
  seed_unparseable_agent
  run_doctor_sandbox
  unanswerable="$(warn_total_of_output)"

  [[ "${synced}" == "${drifted}" && "${synced}" == "${unavailable}" && "${synced}" == "${unanswerable}" ]] || {
    echo "kind-B violation: warning total moved — synced=${synced} drifted=${drifted} unavailable=${unavailable} unanswerable=${unanswerable}" >&2
    return 1
  }
}
