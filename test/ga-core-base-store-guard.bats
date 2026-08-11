#!/usr/bin/env bats
# ga-core-base-store-guard.bats — pins the FIRST-SEED-ONLY contract of
# capture_base_agent_store (lib/ga-core.sh).
#
# DEFECT the guard closes: post-first-install ${GA_ROOT}/agents is the daemon-edited LIVE
# surface (symlink farm), so a bundle-refresh install re-seeded base:=live. With base==local
# every vendor-differing EDITABLE region resolves take-release, and live-only daemon lines
# appear as vendor deletions — the shape that trimmed 83 lines from 11 agents on 2026-08-10.
#
# Contracts pinned:
#   T1 first seed      — no existing entry → copied exactly as before (unchanged behavior).
#   T2 stale differing — existing byte-differing entry → overwrite REFUSED, the entry is
#                        byte-unchanged, and the warn names the ownership rule + the sanctioned
#                        re-seed escape hatch.
#   T3 identical       — existing byte-identical entry → silent pass-through (no warn).
#   T4 summary         — the refused count is surfaced in BOTH summary branches (missing==0 and
#                        missing>0), so a refusal can never be silently invisible.
#   T5 escape hatch    — GA_BASE_STORE_RESEED=1 overwrites a differing entry and says so loudly.
#
# STRATEGY (lib-as-library, mirrors test/doctor-fail-err-trap.bats): a driver SOURCES the real
# lib, then overrides the three collaborators the function reads (spine_baseline_dir /
# read_manifest_files / log) plus GA_ROOT. No install, no ~/.glass-atrium mutation.
#
# Run via: bats test/ga-core-base-store-guard.bats
# Requires: bats 1.5+, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
GA_CORE_SH="${GA}/lib/ga-core.sh"

setup() {
  [[ -f "${GA_CORE_SH}" ]] || skip "ga-core.sh not found: ${GA_CORE_SH}"
  SANDBOX="$(cd -- "$(mktemp -d -t ga-basestore.XXXXXX)" && pwd -P)"
  FAKE_ROOT="${SANDBOX}/ga-root"
  FAKE_STATE="${SANDBOX}/state"
  STORE="${FAKE_STATE}/base-agents"
  DRIVER="${SANDBOX}/driver.sh"
  mkdir -p "${FAKE_ROOT}/agents" "${STORE}"
  # The LIVE surface body (what a re-seed would wrongly copy into base).
  printf 'live body\nline2\n' >"${FAKE_ROOT}/agents/alpha.md"

  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck disable=SC1090,SC2317
source "${GA_CORE_SH}" >/dev/null 2>&1
GA_ROOT="${FAKE_ROOT}"
spine_baseline_dir() { printf '%s\n' "${FAKE_STATE}"; }
read_manifest_files() { printf '%s\n' "${MANIFEST_RELS}"; }
log() { printf '%s\n' "$*"; }
capture_base_agent_store
DRV
  chmod +x "${DRIVER}"
}

teardown() {
  if [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]]; then
    rm -rf -- "${SANDBOX}"
  fi
}

oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

seed() {
  run env \
    GA_CORE_SH="${GA_CORE_SH}" \
    FAKE_ROOT="${FAKE_ROOT}" \
    FAKE_STATE="${FAKE_STATE}" \
    MANIFEST_RELS="${MANIFEST_RELS:-agents/alpha.md}" \
    GA_BASE_STORE_RESEED="${GA_BASE_STORE_RESEED:-}" \
    bash "${DRIVER}"
}

@test "T1 first seed copies the body exactly as before" {
  seed
  [ "${status}" -eq 0 ] || return 1
  [ -f "${STORE}/alpha.md" ] || return 1
  cmp -s "${FAKE_ROOT}/agents/alpha.md" "${STORE}/alpha.md" || return 1
  no "REFUSED" "${output}" || return 1
  oc "0 existing entries refused" "${output}" || return 1
}

@test "T2 an existing byte-differing entry is REFUSED and left unchanged" {
  printf 'pristine release body\n' >"${STORE}/alpha.md"
  seed
  [ "${status}" -eq 0 ] || return 1
  oc "base-content overwrite REFUSED for alpha.md" "${output}" || return 1
  oc "the updater owns base advances" "${output}" || return 1
  oc "GA_BASE_STORE_RESEED=1" "${output}" || return 1
  # The base entry is byte-unchanged — base:=live never happened.
  [ "$(cat "${STORE}/alpha.md")" = "pristine release body" ] || return 1
}

@test "T3 an existing byte-identical entry passes through silently" {
  cp "${FAKE_ROOT}/agents/alpha.md" "${STORE}/alpha.md"
  seed
  [ "${status}" -eq 0 ] || return 1
  no "REFUSED" "${output}" || return 1
  oc "0 existing entries refused" "${output}" || return 1
}

@test "T4 the refused count is surfaced in the missing>0 summary branch too" {
  printf 'pristine release body\n' >"${STORE}/alpha.md"
  # beta.md is manifest-listed but has NO source → missing>0, exercising the other branch.
  MANIFEST_RELS="$(printf 'agents/alpha.md\nagents/beta.md')"
  seed
  [ "${status}" -eq 0 ] || return 1
  oc "missing/uncopyable" "${output}" || return 1
  oc "1 existing entries refused" "${output}" || return 1
}

@test "T5 GA_BASE_STORE_RESEED=1 forces the overwrite loudly" {
  printf 'pristine release body\n' >"${STORE}/alpha.md"
  GA_BASE_STORE_RESEED=1
  seed
  [ "${status}" -eq 0 ] || return 1
  oc "re-seed FORCED for alpha.md" "${output}" || return 1
  cmp -s "${FAKE_ROOT}/agents/alpha.md" "${STORE}/alpha.md" || return 1
}
