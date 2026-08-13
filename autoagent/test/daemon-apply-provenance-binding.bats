#!/usr/bin/env bats
# daemon-apply.sh apply-time provenance suite (T130) — pins the two record-only values the status
# transition samples: the sha256 of the target agent body as it landed, and the daemon model id.
#
# WHY THE FAIL-OPEN SHAPE IS THE SUBJECT. Neither value gates anything, so a hasher that is absent
# or broken must not fail an apply. The dangerous direction is the other one: a truncated or
# partial digest persisted as if it were a whole sample compares unequal against every other apply
# of the identical body, which is exactly the false signal the columns exist to avoid. So the
# criterion is not "a hash is produced" but "a whole digest or nothing, and the failure is loud".
#
# WHY THE BINDING IS PINNED STRUCTURALLY. The two values reach psql as variable bindings on a
# QUOTED heredoc, substituted by psql's own preprocessor. Interpolating either into the heredoc
# body would require unquoting it, which is the string-concatenation injection surface the Input
# Validation rule bans outright — a shape no behavioural test can catch once it lands, hence AC5.
#
#   AC1  a readable target hashes to a whole 64-hex digest equal to the reference hasher
#   AC2  hash-failure injection (no hasher on PATH) → EMPTY + a loud stderr line, status 0
#   AC3  a truncating hasher stub → EMPTY, never the partial digest (the column carries all or none)
#   AC4  an unreadable target → EMPTY + a loud stderr line, status 0
#   AC5  the model id resolves through the shared config helper; a missing lib → EMPTY + loud stderr
#   AC6  structural: the heredoc stays quoted and both values arrive as -v bindings, never inlined
#
# Hermetic: the two helpers are extracted from the non-sourceable script and driven in isolation
# against temp fixtures. No PG, no live agents dir, no ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.
#
# Run via: bats autoagent/test/daemon-apply-provenance-binding.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
DAEMON_APPLY="${GA}/autoagent/daemon-apply.sh"

setup() {
  [[ -f "${DAEMON_APPLY}" ]] || skip "daemon-apply.sh not found: ${DAEMON_APPLY}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-provenance.XXXXXX)" && pwd -P)"

  # Extract each helper (header line through the first column-0 close brace) — daemon-apply.sh runs
  # top-level code and is NOT sourceable. Precedent: daemon-apply-preservation-verify.bats.
  SNIPPET="${WORK}/provenance.sh"
  {
    awk '/^get_body_hash\(\)[[:space:]]*\{/{f=1} f{print} f&&/^\}/{exit}' "${DAEMON_APPLY}"
    awk '/^get_model_id\(\)[[:space:]]*\{/{f=1} f{print} f&&/^\}/{exit}' "${DAEMON_APPLY}"
  } >"${SNIPPET}"
  grep -q '^get_body_hash()' "${SNIPPET}" || skip "could not extract get_body_hash"
  grep -q '^get_model_id()' "${SNIPPET}" || skip "could not extract get_model_id"

  TARGET="${WORK}/probe-agent.md"
  printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' 'a body line' >"${TARGET}"

  # Reference digest from whichever hasher this host actually has.
  if command -v shasum >/dev/null 2>&1; then
    EXPECTED_SHA="$(shasum -a 256 -- "${TARGET}" | cut -d' ' -f1)"
  else
    EXPECTED_SHA="$(sha256sum -- "${TARGET}" | cut -d' ' -f1)"
  fi

  BIN="${WORK}/bin"
  mkdir -p -- "${BIN}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
  return 0
}

# run_helper — source the extracted snippet and call one helper with a caller-supplied PATH.
# The interpreter is resolved ABSOLUTELY: a PATH override sharp enough to hide the hashers also
# hides `bash` itself, and the resulting 127 would masquerade as the fail-open path under test.
run_helper() {
  local path_override="$1"
  shift
  PATH="${path_override}" "${BASH}" -c '
    set -Eeuo pipefail
    . "$1"
    shift
    "$@"
  ' _ "${SNIPPET}" "$@"
}

@test "AC1: a readable target hashes to the whole 64-hex reference digest" {
  run --separate-stderr -0 run_helper "${PATH}" get_body_hash "${TARGET}"
  [[ "${output}" == "${EXPECTED_SHA}" ]] || return 1
  [[ "${output}" =~ ^[0-9a-f]{64}$ ]] || return 1
}

@test "AC2: no hasher on PATH → empty digest, loud stderr, apply-safe status 0" {
  # An empty bin dir as the whole PATH removes both hashers — the sharpest available injection
  # of a hash-computation failure.
  run --separate-stderr -0 run_helper "${BIN}" get_body_hash "${TARGET}"
  [[ -z "${output}" ]] || return 1
  [[ "${stderr}" == *"provenance body_hash failed"* ]] || return 1
}

@test "AC3: a truncating hasher persists nothing, never the partial digest" {
  cat >"${BIN}/shasum" <<'STUB'
#!/usr/bin/env bash
printf '%s  -\n' 'deadbeef'
STUB
  chmod +x "${BIN}/shasum"
  run --separate-stderr -0 run_helper "${BIN}" get_body_hash "${TARGET}"
  [[ -z "${output}" ]] || return 1
  [[ "${output}" != *"deadbeef"* ]] || return 1
  [[ "${stderr}" == *"provenance body_hash failed"* ]] || return 1
}

@test "AC4: an unreadable target → empty digest, loud stderr, apply-safe status 0" {
  run --separate-stderr -0 run_helper "${PATH}" get_body_hash "${WORK}/does-not-exist.md"
  [[ -z "${output}" ]] || return 1
  [[ "${stderr}" == *"provenance body_hash unreadable"* ]] || return 1
}

@test "AC5: the model id resolves through the shared helper; a missing lib is empty and loud" {
  local lib="${GA}/scripts/lib/atrium-config.sh"
  [[ -r "${lib}" ]] || skip "atrium-config.sh not found: ${lib}"

  printf '%s\n' '{"haiku_model":"probe-model-id"}' >"${WORK}/daemon-config.json"
  run --separate-stderr -0 env ATRIUM_CONFIG_LIB="${lib}" GA_DATA_ROOT="${WORK}/nonexistent-root" \
    bash -c 'set -Eeuo pipefail; . "$1"; get_model_id' _ "${SNIPPET}"
  # Non-empty is the contract the helper guarantees (configured id or alias fallback).
  [[ -n "${output}" ]] || return 1

  run --separate-stderr -0 env ATRIUM_CONFIG_LIB="${WORK}/absent-lib.sh" \
    bash -c 'set -Eeuo pipefail; . "$1"; get_model_id' _ "${SNIPPET}"
  [[ -z "${output}" ]] || return 1
  [[ "${stderr}" == *"provenance model_id unresolved"* ]] || return 1
}

@test "AC6: both values arrive as psql -v bindings on a heredoc that stays quoted" {
  grep -q -- "-v \"bh=\${body_hash}\" -v \"mid=\${model_id}\"" "${DAEMON_APPLY}" || return 1
  grep -q "<<'PSQL'" "${DAEMON_APPLY}" || return 1
  grep -q "applied_body_sha256 = nullif(:'bh', '')" "${DAEMON_APPLY}" || return 1
  grep -q "applied_model_id    = nullif(:'mid', '')" "${DAEMON_APPLY}" || return 1
  # The values must never appear inside the SQL text itself (that is the concat surface).
  grep -q 'applied_body_sha256 = .*\${' "${DAEMON_APPLY}" && return 1
  grep -q 'applied_model_id = .*\${' "${DAEMON_APPLY}" && return 1
  return 0
}
