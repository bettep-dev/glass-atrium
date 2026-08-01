#!/usr/bin/env bats
# daemon-apply-marker-preservation.bats — S2 acceptance spec for clauded-docs/762.
#
# TWO deliverables share one file, so one suite covers both:
#
#   (1) verify_patched gains a SIXTH check — editable-region marker COUNTS.
#       The five existing checks (non-empty · one heading · present-before
#       frontmatter · present-before `> Rules:` anchor · proportional shrink
#       floor) never look at `<!-- EDITABLE:BEGIN/END -->`, so a patch that
#       deletes one END marker of several verifies clean while silently merging
#       two regions into one. Counting (not mere presence) is the point: a
#       presence test passes exactly the case worth catching.
#
#   (2) the GIT_TXN_VERIFY_FAIL branch gains the stale-drain call its two
#       sibling failure branches already make. Deliverable (1) exists to FAIL
#       verification, so without the bound a permanently-unverifiable row
#       re-selects, re-applies and re-restores against a live agent body every
#       cycle forever.
#
# FAIL-AT-HEAD (observed, not derived from code shape):
#   * a result missing one END marker verifies CLEAN at HEAD (no marker check).
#   * a result missing one BEGIN marker verifies CLEAN at HEAD.
#   * a row failing verification on three successive batch cycles is STILL
#     selected on the fourth at HEAD (the verify-fail branch never advances the
#     stale counter, so the row never reaches 'snoozed').
#
# REGRESSION PINS (green at HEAD and after): the five existing checks each still
# fail their own case; a marker-count-preserving result still passes; a target
# that never carried markers is not penalized; the verify failure still hands off
# to the atomic restore; the verify-fail branch keeps counting ERRORS (NOT
# NEEDS_REGEN — the divergence daemon-apply.sh documents as deliberate); the
# helper's --auto-regen skip gate applies on the newly-wired branch too.
#
# HERMETIC: the predicate is extracted and driven in isolation; the end-to-end
# rows run against a temp tree with a stateful psql stand-in prepended to PATH.
# No live PG, no live install, no live agents dir.
#
# Run via: bats autoagent/test/daemon-apply-marker-preservation.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

BEGIN_MARK='<!-- EDITABLE:BEGIN -->'
END_MARK='<!-- EDITABLE:END -->'

setup() {
  [[ -x "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not executable: ${REAL_SCRIPT}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-marker.XXXXXX)" && pwd -P)"

  # Extract verify_patched (header line through the first column-0 close brace) —
  # daemon-apply.sh runs top-level code and is not sourceable.
  SNIPPET="${WORK}/verify_patched.sh"
  awk '/^verify_patched\(\)[[:space:]]*\{/{f=1} f{print} f&&/^\}/{exit}' \
    "${REAL_SCRIPT}" >"${SNIPPET}"
  [[ -s "${SNIPPET}" ]] || skip "could not extract verify_patched from daemon-apply.sh"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# ---------------------------------------------------------------------------
# Predicate-level fixtures + driver
# ---------------------------------------------------------------------------

# write_two_region_body PATH — a body carrying TWO editable regions (2 begin
# markers, 2 end markers) plus frontmatter, a heading and a `> Rules:` anchor.
write_two_region_body() {
  printf '%s\n' \
    '---' 'name: probe-agent' '---' \
    '# Probe Agent' \
    '> Rules: comment-logging' \
    '## Goal' "${BEGIN_MARK}" 'goal line one' 'goal line two' "${END_MARK}" \
    '## Work Rules' "${BEGIN_MARK}" 'work rule one' 'work rule two' "${END_MARK}" \
    >"$1"
}

# verify BEFORE AFTER — drive the extracted predicate. status 0 = preserved.
verify() {
  run env VBI="$1" TGT="$2" SNIP="${SNIPPET}" bash -c '
    source "${SNIP}"
    VERIFY_BEFORE_IMAGE="${VBI}"
    verify_patched "${TGT}"
  '
}

# --- (1) marker-count preservation ----------------------------------------

@test "a result missing one EDITABLE:END marker FAILS the predicate [FAIL-AT-HEAD]" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  # Drop the FIRST end marker: both markers are still present, the file still has
  # frontmatter, a heading, the anchor and ~all its lines — only the region
  # boundary is gone, silently merging region one into region two.
  awk -v m="${END_MARK}" 'BEGIN{done=0} $0==m && !done {done=1; next} {print}' \
    "${before}" >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || {
    echo "deleting one of two EDITABLE:END markers must fail the predicate" >&2
    return 1
  }
}

@test "a result missing one EDITABLE:BEGIN marker FAILS the predicate [FAIL-AT-HEAD]" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  awk -v m="${BEGIN_MARK}" 'BEGIN{done=0} $0==m && !done {done=1; next} {print}' \
    "${before}" >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || {
    echo "deleting one of two EDITABLE:BEGIN markers must fail the predicate" >&2
    return 1
  }
}

@test "a result preserving both marker counts PASSES (the check is not a blanket refusal)" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  sed 's/^goal line two$/goal line two, edited/' "${before}" >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -eq 0 ]] || {
    echo "an in-region edit preserving both marker counts must pass, got ${status}" >&2
    return 1
  }
}

@test "a target that carried no markers before and none after PASSES (present-before semantics)" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  printf '%s\n' '# Agent Global Rules' 'a rules file that never carried markers' 'body' \
    >"${before}"
  printf '%s\n' '# Agent Global Rules' 'a rules file that never carried markers' 'edited body' \
    >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -eq 0 ]] || {
    echo "a marker-less target must not be penalized for its continued absence, got ${status}" >&2
    return 1
  }
}

# --- (1) regression pins on the five existing checks -----------------------

@test "existing check: an empty result still fails" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  : >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || { echo "an empty result must fail" >&2; return 1; }
}

@test "existing check: a heading-less result still fails" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  grep -v '^#' "${before}" >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || { echo "a heading-less result must fail" >&2; return 1; }
}

@test "existing check: a result stripping present-before frontmatter still fails" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  tail -n +4 "${before}" >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || { echo "stripping present-before frontmatter must fail" >&2; return 1; }
}

@test "existing check: a result removing a present-before \`> Rules:\` anchor still fails" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  write_two_region_body "${before}"
  grep -v '^> Rules:' "${before}" >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || { echo "removing a present-before anchor must fail" >&2; return 1; }
}

@test "existing check: a result shrunk past the proportional floor still fails" {
  local before="${WORK}/before.md" after="${WORK}/after.md"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent'
    local i
    for i in $(seq 1 60); do printf 'substantial body line %s\n' "${i}"; done
  } >"${before}"
  printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' >"${after}"
  verify "${before}" "${after}"
  [[ "${status}" -ne 0 ]] || { echo "a gutted result must fail the shrink floor" >&2; return 1; }
}

# ---------------------------------------------------------------------------
# (2) end-to-end: the verification-failure branch and its retry bound
# ---------------------------------------------------------------------------

# install_psql_stub DIR — a STATEFUL PG stand-in. It persists the row's status
# and stale_attempt_count in a state file so the drain can be observed ACROSS
# successive daemon-apply invocations (the fossilization scenario is inherently
# multi-cycle). It honors the batch SELECT's status='pending' predicate and the
# mark_stale_attempt CTE's increment-then-flip-at-threshold semantics.
install_psql_stub() {
  cat >"$1/psql" <<'STUB'
#!/usr/bin/env bash
set -u
log="${STUB_PSQL_LOG:?stub needs STUB_PSQL_LOG}"
state="${STUB_STATE:?stub needs STUB_STATE}"
thr="${STUB_STALE_THRESHOLD:-3}"

sql="$(cat)"
{
  printf '=== psql invocation ===\n'
  printf 'argv: %s\n' "$*"
  printf 'sql<<<\n%s\n>>>\n' "${sql}"
} >>"${log}"

row_status="$(sed -n 's/^status=//p' "${state}")"
row_count="$(sed -n 's/^count=//p' "${state}")"

emit_row() {
  printf '%s|%s|%s|%s|%s|%s\n' \
    "${STUB_ROW_ID:?}" "${STUB_CYCLE:?}" "${STUB_LABEL:?}" \
    "${STUB_AGENT:?}" "${STUB_TARGET:?}" "${STUB_DIFF_B64:?}"
}

case "${sql}" in
  *stale_attempt_count*)
    row_count=$((row_count + 1))
    verdict=incremented
    if [[ "${row_count}" -ge "${thr}" ]]; then
      row_status=snoozed
      verdict=drained
    fi
    printf 'status=%s\ncount=%s\n' "${row_status}" "${row_count}" >"${state}"
    printf '%s\n' "${verdict}"
    ;;
  *"ORDER BY cycle_date ASC, id ASC"*)
    [[ "${row_status}" == "pending" ]] && emit_row
    ;;
  *"id::text = :'pid'"*)
    case "${row_status}" in pending | snoozed) emit_row ;; *) : ;; esac
    ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "$1/psql"
}

# setup_e2e — temp tree, stub PATH, probe fixture, and the unverifiable diff.
setup_e2e() {
  STUB="${WORK}/bin"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  FAKE_HOME="${WORK}/home"
  PSQL_LOG="${WORK}/psql-invocations.log"
  STATE="${WORK}/row-state"
  mkdir -p "${STUB}" "${AGENTS}" "${REPORTS}" "${FAKE_HOME}"
  install_psql_stub "${STUB}"
  printf 'status=pending\ncount=0\n' >"${STATE}"

  PROBE="${AGENTS}/probe.md"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' '' \
      '## Absolute Rules' '' '- MUST NOT do the dangerous thing' '' \
      '## Goal' "${BEGIN_MARK}"
    local i
    for i in $(seq -w 1 30); do printf 'editable goal line %s\n' "${i}"; done
    printf '%s\n' "${END_MARK}"
  } >"${PROBE}"
  PROBE_ORIGINAL="${WORK}/probe.original"
  cp -p -- "${PROBE}" "${PROBE_ORIGINAL}"
}

# gutting_diff_b64 — an in-region diff that PASSES the pre-apply landing-zone
# guard (its context + removed anchors all sit inside the editable region) yet
# guts the body past the proportional shrink floor, so verify_patched fails and
# the transaction restores. The permanently-unverifiable row this produces is
# exactly the fossil the retry bound has to terminate.
gutting_diff_b64() {
  {
    printf '%s\n' '--- a/probe.md' '+++ b/probe.md' '@@ -12,30 +12,2 @@' \
      ' editable goal line 01'
    local i
    for i in $(seq -w 2 29); do printf -- '-editable goal line %s\n' "${i}"; done
    printf '%s\n' ' editable goal line 30'
  } | base64 | tr -d '\n'
}

# run_apply ARGS... — invoke daemon-apply DIRECTLY (never `bash <path>`), with the
# stub PATH, a temp HOME (so no live install script or pause-flag lib is reached)
# and the re-entry sentinel that keeps a bats-invoked run from shelling the full
# suite recursively.
#
# AUTOAGENT_REMOVAL_LIVE is armed because the gutting fixture below is a
# REMOVAL-bearing diff: with the removal capability at its dry-run default the
# apply-time gate defers it before any apply, and the verify-fail branch these
# rows exist to pin is never reached. Arming keeps the branch reachable AND makes
# the pin stronger — the failure still fires with removals live.
run_apply() {
  run env PATH="${STUB}:${PATH}" \
    HOME="${FAKE_HOME}" \
    AUTOAGENT_REMOVAL_LIVE=1 \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    STUB_PSQL_LOG="${PSQL_LOG}" \
    STUB_STATE="${STATE}" \
    STUB_ROW_ID="2762" \
    STUB_CYCLE="2026-07-30" \
    STUB_LABEL="probe-unverifiable" \
    STUB_AGENT="probe" \
    STUB_TARGET="${PROBE}" \
    STUB_DIFF_B64="$(gutting_diff_b64)" \
    "${REAL_SCRIPT}" --agents-dir "${AGENTS}" "$@"
}

applied_log_path() {
  printf '%s/autoagent-applied-%s.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

@test "a verification failure leaves the target restored to its before-image content" {
  setup_e2e
  run_apply --proposal-id 2762

  [[ "${status}" -eq 9 ]] || { echo "expected single-mode apply-fail exit 9, got ${status}: ${output}" >&2; return 1; }
  grep -q '"reason":"verify_failed"' "$(applied_log_path)" || {
    echo "expected a verify_failed row in the applied log" >&2
    return 1
  }
  cmp -s "${PROBE}" "${PROBE_ORIGINAL}" || {
    echo "the target was not restored to its before-image content" >&2
    return 1
  }
}

@test "three failing verifications drain the row to snoozed and it is absent from the next batch selection [FAIL-AT-HEAD]" {
  setup_e2e

  local cycle
  for cycle in 1 2 3; do
    run_apply
    [[ "${status}" -eq 0 ]] || { echo "batch cycle ${cycle} exited ${status}: ${output}" >&2; return 1; }
    [[ "${output}" == *"processed=1"* ]] || { echo "batch cycle ${cycle} selected no row: ${output}" >&2; return 1; }
  done

  # The third failure is the one that reaches the threshold and terminalizes.
  [[ "${output}" == *"drained to snoozed"* ]] || {
    echo "the third verification failure did not reach the terminal drain: ${output}" >&2
    return 1
  }

  # Fourth cycle: the snoozed row must no longer be selected.
  run_apply
  [[ "${status}" -eq 0 ]] || { echo "the fourth batch cycle exited ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"0 pending backlog patches"* ]] || {
    echo "the drained row is still being selected by the batch: ${output}" >&2
    return 1
  }
}

@test "the verify-fail branch counts ERRORS, not NEEDS_REGEN (the deliberate divergence is preserved)" {
  setup_e2e
  run_apply --proposal-id 2762

  [[ "${output}" == *"needs_regen=0 errors=1"* ]] || {
    echo "expected the verify-fail row in the ERRORS bucket only: ${output}" >&2
    return 1
  }
  # The drain wiring still fired on that same branch (it is the log line, not the
  # counter, that mirrors the sibling branches).
  grep -q '"reason":"stale_drain_' "$(applied_log_path)" || {
    echo "the stale-drain wiring did not fire on the verify-fail branch" >&2
    return 1
  }
}

@test "--auto-regen skips the stale-drain on the newly-wired branch, as it does on the existing two" {
  setup_e2e
  run_apply --proposal-id 2762 --auto-regen

  # The branch must actually have been REACHED, else the assertion below is vacuous.
  grep -q '"reason":"verify_failed"' "$(applied_log_path)" || {
    echo "the run did not reach the verify-fail branch at all" >&2
    return 1
  }
  run grep -q 'stale_attempt_count' "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]] || {
    echo "--auto-regen must gate the stale-drain off on the verify-fail branch too" >&2
    return 1
  }
}
