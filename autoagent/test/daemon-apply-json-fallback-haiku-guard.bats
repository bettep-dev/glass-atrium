#!/usr/bin/env bats
# DISPOSABLE verification test for the P3b JSON-fallback haiku gate added to
# extract_body_auto_patches in daemon-apply.sh. Proves the degraded-mode
# (psql-absent) JSON-report fallback path now mirrors extract_single_proposal:
#   (a) EXCLUDES a haiku-skipped (and a missing-haiku) body-auto patch by default
#       (fail-CLOSED), and
#   (b) ADMITS a haiku-skipped patch with AUTOAGENT_ALLOW_HAIKU_SKIP=1 plus a loud
#       operator WARN (never silent).
# Plus regression guards: an 'ok'/'ok:retried' status is still admitted by default
# (the gate is not over-blocking — startswith('ok') == the SELECT's LIKE 'ok%').
#
# Originated as a disposable verification artifact (agent-test-files-disposable);
# now retained in-repo under autoagent/test/.
# Run via: bats autoagent/test/daemon-apply-json-fallback-haiku-guard.bats
#
# Strategy: extract ONLY the function under test into a sourceable file and call
# it directly — no full-script side effects (no CLI parse / git precondition /
# lock), so the assertion targets the gate alone. python3 is the only runtime dep.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-jf-bats.XXXXXX)" && pwd -P)"
  FN_FILE="${WORK}/fn.sh"
  REPORT="${WORK}/report.json"
  # Extract ONLY extract_body_auto_patches into a sourceable file.
  awk '/^extract_body_auto_patches\(\) \{/,/^\}/' "${REAL_SCRIPT}" >"${FN_FILE}"
  # Sanity: extraction captured the new gate (else the test is vacuous).
  grep -q 'allow_haiku_skip' "${FN_FILE}"
  # shellcheck source=/dev/null
  source "${FN_FILE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# write_report — one-patch cycle report fixture. $1 = haiku_status value, or the
# sentinel "__absent__" to omit the key entirely (the fail-closed missing case).
write_report() {
  local haiku="$1"
  local haiku_field=""
  if [[ "${haiku}" != "__absent__" ]]; then
    haiku_field="\"haiku_status\": \"${haiku}\","
  fi
  cat >"${REPORT}" <<JSON
{
  "patches": [
    {
      "classification": "body-auto",
      "approval_tier": "auto",
      ${haiku_field}
      "pattern_label": "probe",
      "target_file": "/x/probe.md",
      "proposed_diff": "diff"
    }
  ]
}
JSON
}

# ---------------------------------------------------------------------------
# (a) default fail-closed — skipped/missing haiku_status is EXCLUDED
# ---------------------------------------------------------------------------

@test "JSON-fallback: a haiku-skipped body-auto patch is EXCLUDED by default (fail-closed)" {
  write_report "skipped:empty-or-error"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  # Gate excluded it → no patch line, no WARN → empty combined output.
  [[ -z "${output}" ]]
}

@test "JSON-fallback: a MISSING haiku_status is EXCLUDED by default (fail-closed)" {
  write_report "__absent__"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

@test "JSON-fallback: an error:* haiku_status is EXCLUDED by default (fail-closed)" {
  write_report "error:timeout"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

# ---------------------------------------------------------------------------
# (b) operator carve-out — AUTOAGENT_ALLOW_HAIKU_SKIP=1 ADMITS + loud WARN
# ---------------------------------------------------------------------------

@test "JSON-fallback: AUTOAGENT_ALLOW_HAIKU_SKIP=1 ADMITS a haiku-skipped patch with a loud WARN" {
  write_report "skipped:empty-or-error"
  AUTOAGENT_ALLOW_HAIKU_SKIP=1 run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  # Admitted → the patch JSON is emitted on stdout.
  [[ "${output}" == *'"classification": "body-auto"'* ]]
  # Loud operator bypass WARN (never silent) — stderr merged into $output by run.
  [[ "${output}" == *"haiku-skip guard BYPASSED by operator"* ]]
}

@test "JSON-fallback: carve-out accepts truthy variants (yes) too" {
  write_report "skipped:auth"
  AUTOAGENT_ALLOW_HAIKU_SKIP=yes run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *'"pattern_label": "probe"'* ]]
  [[ "${output}" == *"BYPASSED by operator"* ]]
}

# ---------------------------------------------------------------------------
# (c) regression — gate is not over-blocking; ok* still admitted by default
# ---------------------------------------------------------------------------

@test "JSON-fallback: an 'ok' haiku_status is admitted by default (no WARN, no over-block)" {
  write_report "ok"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *'"classification": "body-auto"'* ]]
  [[ "${output}" != *"BYPASSED by operator"* ]]
}

@test "JSON-fallback: 'ok:retried' variant admitted by default (startswith 'ok' == LIKE 'ok%')" {
  write_report "ok:retried"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *'"classification": "body-auto"'* ]]
}

@test "JSON-fallback: 'ok:fuzzy-parsed' variant admitted by default" {
  write_report "ok:fuzzy-parsed"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *'"classification": "body-auto"'* ]]
}

# ---------------------------------------------------------------------------
# (d) the pre-existing tier/classification gates still hold (not regressed)
# ---------------------------------------------------------------------------

@test "JSON-fallback: a safety-tier patch is EXCLUDED even with an ok haiku_status" {
  cat >"${REPORT}" <<'JSON'
{
  "patches": [
    {
      "classification": "body-auto",
      "approval_tier": "safety",
      "haiku_status": "ok",
      "pattern_label": "probe",
      "target_file": "/x/probe.md",
      "proposed_diff": "diff"
    }
  ]
}
JSON
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}
