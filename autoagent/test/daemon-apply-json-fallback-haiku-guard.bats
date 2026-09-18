#!/usr/bin/env bats
# DISPOSABLE verification test for the P3b JSON-fallback haiku gate added to
# extract_body_auto_patches in daemon-apply.sh. Proves the degraded-mode
# (psql-absent) JSON-report fallback path now mirrors assert_generation_outcome:
#   (a) EXCLUDES a haiku-skipped (and a missing-haiku) body-auto patch by default
#       (fail-CLOSED), and
#   (b) ADMITS a haiku-skipped patch with AUTOAGENT_ALLOW_HAIKU_SKIP=1 plus a loud
#       operator WARN (never silent).
# Plus regression guards: an 'ok'/'ok:retried' status is still admitted by default
# (the gate is not over-blocking — startswith('ok') == the single path's ok* match).
# And (f): a report that cannot be read — by its CONTENT (malformed JSON) or by its PATH SHAPE (a
# directory, a dangling link, nesting past the decoder's limit) — returns non-zero with one named
# stderr line and no traceback, the signal the source dispatch turns into exit 22 (the dispatch
# itself: daemon-apply-zero-eligible-row.bats AC9). A symlink to a valid report stays readable.
#
# Originated as a disposable verification artifact (agent-test-files-disposable);
# now retained in-repo under autoagent/test/.
# Run via: bats autoagent/test/daemon-apply-json-fallback-haiku-guard.bats
#
# Strategy: extract ONLY the function under test (and its override helper) into a sourceable file and call
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
  # Extract ONLY extract_body_auto_patches and its override helper into a sourceable file.
  awk '/^(extract_body_auto_patches|is_haiku_skip_override_set)\(\) \{/,/^\}/' "${REAL_SCRIPT}" >"${FN_FILE}"
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
      "pre_verify_passed": true,
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
  # Admitted → the patch JSON is emitted on stdout; the loud operator bypass WARN (never silent) is
  # merged into $output by run, and names the generation outcome — pre-verify is a different gate.
  [[ "${status}" -eq 0 && "${output}" == *'"classification": "body-auto"'* ]] || {
    echo "the carve-out did not admit the patch: ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"haiku-skip guard BYPASSED by operator"* &&
    "${output}" == *"(generation outcome skipped/failed)"* && "${output}" != *"pre-verify"* ]] || {
    echo "the bypass WARN is missing or names the wrong gate: ${output}" >&2
    return 1
  }
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

@test "JSON-fallback: 'ok:retried' variant admitted by default (startswith 'ok' == the single path's ok*)" {
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
      "pre_verify_passed": true,
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

# ---------------------------------------------------------------------------
# (e) DF-17 pre-verify gate — a body-auto/auto/ok patch that skipped or failed
#     pre-verify is EXCLUDED in psql-absent mode (matches the backlog SELECT's
#     `pre_verify_passed = true`).
# ---------------------------------------------------------------------------

@test "JSON-fallback: a body-auto patch WITHOUT pre_verify_passed is EXCLUDED (DF-17 fail-closed)" {
  cat >"${REPORT}" <<'JSON'
{
  "patches": [
    {
      "classification": "body-auto",
      "approval_tier": "auto",
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

@test "JSON-fallback: pre_verify_passed=false is EXCLUDED even with an ok haiku_status" {
  cat >"${REPORT}" <<'JSON'
{
  "patches": [
    {
      "classification": "body-auto",
      "approval_tier": "auto",
      "pre_verify_passed": false,
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

@test "JSON-fallback: pre_verify gate is NOT bypassed by the haiku operator carve-out" {
  cat >"${REPORT}" <<'JSON'
{
  "patches": [
    {
      "classification": "body-auto",
      "approval_tier": "auto",
      "pre_verify_passed": false,
      "haiku_status": "skipped:empty-or-error",
      "pattern_label": "probe",
      "target_file": "/x/probe.md",
      "proposed_diff": "diff"
    }
  ]
}
JSON
  AUTOAGENT_ALLOW_HAIKU_SKIP=1 run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 ]]
  # Carve-out bypasses ONLY the haiku gate; the pre-verify gate still excludes it.
  [[ "${output}" != *'"pattern_label": "probe"'* ]]
}

# ---------------------------------------------------------------------------
# (f) an unreadable report — the extractor fails, so the dispatch exits 22 and
#     never reads the report as zero patches
# ---------------------------------------------------------------------------

@test "JSON-fallback: every unreadable report shape returns non-zero with one named line and no traceback" {
  # One fixture per way a present report can be unreadable; an empty patches list is the valid boundary.
  # The operator sees the extractor's stderr verbatim, so each shape owes one line naming the report.
  local body
  for body in '{"patches": [' $'\xff' '[]' '{"patches": {}}' '{"patches": ["body-auto"]}'; do
    printf '%s\n' "${body}" >"${REPORT}"
    run extract_body_auto_patches "${REPORT}"
    [[ "${status}" -ne 0 && "${output}" != *'"classification"'* && "${output}" != *Traceback* &&
      "${#lines[@]}" -eq 1 && "${output}" == "[daemon-apply] report ${REPORT}: "* ]] || {
      echo "report ${body} read as rc=${status}: ${output}" >&2
      return 1
    }
  done
  printf '%s\n' '{"patches": []}' >"${REPORT}"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 && -z "${output}" ]] || {
    echo "an empty patches list is a readable report, got rc=${status}: ${output}" >&2
    return 1
  }
}

@test "JSON-fallback: every unreadable report PATH shape returns non-zero with one named line and no traceback" {
  # The loop above covers what a readable file can SAY; these cover what the path itself can BE.
  # None is a decode failure — a directory and a dangling link raise OSError, a nested-past-the-limit
  # array exhausts the decoder — so each owes the same one named line, never a traceback.
  local shape
  for shape in directory dangling-link deeply-nested; do
    rm -rf -- "${REPORT}" # removes a directory, and a link without following it
    case "${shape}" in
      directory) mkdir -- "${REPORT}" ;;
      dangling-link) ln -s -- "${WORK}/no-such-report.json" "${REPORT}" ;;
      deeply-nested) python3 -c 'import sys; sys.stdout.write("[" * 200000)' >"${REPORT}" ;;
    esac
    run extract_body_auto_patches "${REPORT}"
    [[ "${status}" -ne 0 && "${output}" != *'"classification"'* && "${output}" != *Traceback* &&
      "${#lines[@]}" -eq 1 && "${output}" == "[daemon-apply] report ${REPORT}: "* ]] || {
      echo "report shape ${shape} read as rc=${status}: ${output}" >&2
      return 1
    }
  done
}

@test "JSON-fallback: a symlink to a readable report is still read (the non-regular refusal follows links)" {
  # The over-rejection boundary of the case above: link-following stat semantics, so an operator's
  # symlinked report keeps working — only the link's TARGET decides whether the path is regular.
  local target="${WORK}/linked-report.json"
  write_report "ok"
  mv -- "${REPORT}" "${target}"
  ln -s -- "${target}" "${REPORT}"
  run extract_body_auto_patches "${REPORT}"
  [[ "${status}" -eq 0 && "${output}" == *'"classification": "body-auto"'* ]] || {
    echo "a symlink to a valid report was refused: rc=${status}: ${output}" >&2
    return 1
  }
}
