#!/usr/bin/env bats
# Cycle-boundary manifest gate — `generate-manifest.sh --check` must exit 0 on this
# repo (AC-17): the tracked manifest and the git-tracked file set agree in both
# directions (ORPHAN · MISSING · HASH · MODES). A hermetic negative control proves the
# assertion is not vacuous: a deliberately stale manifest copy in a sandbox repo must
# exit 1.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/generate-manifest.sh"
REAL_SPINE="${GA}/scripts/lib/apply-spine.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "generate-manifest.sh not found: ${REAL_SCRIPT}"
  [[ -f "${REAL_SPINE}" ]] || skip "apply-spine.sh not found: ${REAL_SPINE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Sandbox repo with a COPY of the generator, so its BASH_SOURCE-derived GA_ROOT
# resolves inside the sandbox and never touches the live tree.
make_sandbox() {
  WORK="$(cd -- "$(mktemp -d -t manifest-check-bats.XXXXXX)" && pwd -P)"
  mkdir -p "${WORK}/scripts/lib" "${WORK}/agents"
  cp "${REAL_SCRIPT}" "${WORK}/scripts/generate-manifest.sh"
  cp "${REAL_SPINE}" "${WORK}/scripts/lib/apply-spine.sh"
  printf '# agent alpha\n' >"${WORK}/agents/alpha.md"
  printf '{"files":[],"hashes":{}}\n' >"${WORK}/manifest.json"
  git -C "${WORK}" init -q
  git -C "${WORK}" config user.email bats@test.local
  git -C "${WORK}" config user.name bats
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm init
  "${WORK}/scripts/generate-manifest.sh" >/dev/null
}

@test "negative control: a stale manifest copy fails --check" {
  make_sandbox
  # Content changed, path unchanged -> HASH divergence.
  printf '# agent alpha edited\n' >"${WORK}/agents/alpha.md"
  run -1 "${WORK}/scripts/generate-manifest.sh" --check
  [[ "${output}" == *HASH* ]] || [[ "${output}" == *hash* ]]
}

@test "negative control: an untracked-then-added file fails --check as MISSING" {
  make_sandbox
  printf '# agent beta\n' >"${WORK}/agents/beta.md"
  git -C "${WORK}" add agents/beta.md
  run -1 "${WORK}/scripts/generate-manifest.sh" --check
  [[ "${output}" == *MISSING* ]] || [[ "${output}" == *agents/beta.md* ]]
}

@test "AC-17: generate-manifest.sh --check exits 0 on this repo" {
  run -0 "${REAL_SCRIPT}" --check
}
