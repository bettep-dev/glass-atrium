#!/usr/bin/env bats
# daemon-apply.sh apply-time LANDING-ZONE guard suite — pins assert_diff_in_editable_region:
#   * in-region edit       → ACCEPT (apply commit lands, file changed)
#   * out-of-region edit   → REJECT + rollback intact (WIP commit gone, tree clean,
#                            row left as an error, file unchanged)
#   * no-marker target      → REJECT (fail-closed)
#   * multi-region file      → one hunk per disjoint region → ACCEPT
#   * header-less fragment   → REJECT (Strategy-B EOF append lands outside) + rollback
#   * unreadable target      → read_error verdict → REJECT (fail-closed) + rollback
#   * mixed-hunk diff        → one in-region + one out-of-region hunk → REJECT the
#                            WHOLE diff (no partial apply) + rollback intact
#
# Run via: bats autoagent/test/daemon-apply-landing-zone.bats
# Requires: bats >= 1.5.0 (brew install bats-core), bash 3.2+, git, python3
#
# Hermetic strategy: a per-test standalone git repo fixture under a realpath-
# resolved temp root (pwd -P so the macOS /var -> /private/var symlink does not
# trip verify_target_in_agents). The PG backlog path is masked by pointing PATH
# at a stub bin of REAL-binary symlinks (built with `type -P`) that deliberately
# OMITS psql — so backlog_source_available() is false and daemon-apply takes the
# JSON-report fallback, exercising the full apply_patch_rows → guard → rollback
# flow against the report-sourced patch. No PG, no live agents/ dir is touched.

bats_require_minimum_version 1.5.0

REAL_SCRIPT="${HOME}/.glass-atrium/autoagent/daemon-apply.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so the realpath containment check passes.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-lz-bats.XXXXXX)" && pwd -P)"
  STUB="${WORK}/bin"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  mkdir -p "${STUB}" "${AGENTS}" "${REPORTS}"

  # Stub bin = real-binary symlinks via `type -P` (ignores shell functions /
  # aliases that bare `command -v` would return), psql DELIBERATELY omitted so
  # the report fallback is taken. Run the loop inside bash for `type -P`.
  bash -c '
    stub="$1"; shift
    for t in "$@"; do
      p="$(type -P "${t}" 2>/dev/null)" || true
      [[ -n "${p}" ]] && ln -sf "${p}" "${stub}/${t}"
    done
  ' _ "${STUB}" \
    git python3 jq date mktemp tail head wc tr cut grep sed awk cat \
    rmdir mkdir rm bash sh dirname xargs find sort

  git -C "${AGENTS}" init -q
  git -C "${AGENTS}" config user.email bats@test.local
  git -C "${AGENTS}" config user.name bats
}

teardown() {
  # Restore traversable perms across the tree first: the read_error test
  # chmod 000's a target's PARENT dir to force the guard's open() to fail, and
  # `rm -rf` cannot recurse into a 000 dir. u+rwX is a no-op for the other tests.
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# commit_agents — stage + commit the current agents/ tree (initial fixture state).
commit_agents() {
  git -C "${AGENTS}" add -A
  git -C "${AGENTS}" commit -qm "fixture"
}

# write_report — emit a one-patch JSON report (report-fallback shape) selecting
# the given target + diff. The diff body is passed verbatim; a trailing newline
# is added to mirror the PG-sourced proposed_diff convention.
write_report() {
  local target="$1" label="$2" diff="$3"
  python3 - "${target}" "${label}" "${diff}" >"${WORK}/report.json" <<'PY'
import json
import sys

target, label, diff = sys.argv[1], sys.argv[2], sys.argv[3]
print(
    json.dumps(
        {
            "patches": [
                {
                    "classification": "body-auto",
                    "approval_tier": "auto",
                    "haiku_status": "ok",
                    "pattern_label": label,
                    "pattern_agent": "probe",
                    "target_file": target,
                    "proposed_diff": diff + "\n",
                }
            ]
        }
    )
)
PY
}

# run_apply — invoke daemon-apply.sh on the report fixture with the stub PATH
# (psql masked → report fallback) and the standalone agents repo.
run_apply() {
  run env PATH="${STUB}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

# applied_log_path — today's report-fallback applied JSONL.
applied_log_path() {
  printf '%s/autoagent-applied-%s.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

# ---------------------------------------------------------------------------
# (a) in-region edit → ACCEPT
# ---------------------------------------------------------------------------

@test "in-region edit lands (apply commit, file changed)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  commit_agents
  local head_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"

  local diff='--- a/probe.md
+++ b/probe.md
@@ -8,2 +8,3 @@
 editable goal line one
+inserted editable line
 editable goal line two'
  write_report "${AGENTS}/probe.md" "probe-in" "${diff}"
  run_apply

  [[ "${status}" -eq 0 ]]
  grep -q 'inserted editable line' "${AGENTS}/probe.md"
  # A new [AUTO] commit landed (HEAD advanced).
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" != "${head_before}" ]]
  grep -q '"status":"applied"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# (b) out-of-region edit → REJECT + rollback intact
# ---------------------------------------------------------------------------

@test "out-of-region edit is rejected and the tree is fully rolled back" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' \
    '- MUST NOT do the dangerous thing' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  commit_agents
  local head_before tree_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"
  tree_before="$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')"

  # Diff anchored on the PROTECTED Absolute-Rules lines (outside any region).
  local diff='--- a/probe.md
+++ b/probe.md
@@ -5,2 +5,3 @@
 - MUST NOT do the dangerous thing
+- injected protected rule
 - protected rule line alpha'
  write_report "${AGENTS}/probe.md" "probe-out" "${diff}"
  run_apply

  # Loud reject reason recorded.
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"out_of_region"' "$(applied_log_path)"
  # File NOT changed (grep finds nothing → non-zero; assert the absence explicitly,
  # NOT a bare `! grep` which Bats does not treat as a failing assertion — SC2314).
  run grep -q 'injected protected rule' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
  # Rollback intact: HEAD unchanged (no orphan WIP commit) + working tree clean.
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" == "${head_before}" ]]
  [[ "$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')" == "${tree_before}" ]]
  [[ -z "$(git -C "${AGENTS}" status --porcelain)" ]]
}

# ---------------------------------------------------------------------------
# (c) target with no marker → REJECT
# ---------------------------------------------------------------------------

@test "target file with no editable marker is rejected (fail-closed)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Goal' '' \
    'plain unmarked body line one' 'plain unmarked body line two' \
    >"${AGENTS}/probe.md"
  commit_agents
  local head_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"

  local diff='--- a/probe.md
+++ b/probe.md
@@ -5,2 +5,3 @@
 plain unmarked body line one
+inserted line
 plain unmarked body line two'
  write_report "${AGENTS}/probe.md" "probe-nomarker" "${diff}"
  run_apply

  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"no_marker"' "$(applied_log_path)"
  run grep -q 'inserted line' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" == "${head_before}" ]]
  [[ -z "$(git -C "${AGENTS}" status --porcelain)" ]]
}

# ---------------------------------------------------------------------------
# (d) multi-region file, one hunk per region → ACCEPT
# ---------------------------------------------------------------------------

@test "multi-region file with one hunk per region is accepted" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'goal editable line one' 'goal editable line two' \
    '<!-- EDITABLE:END -->' '' \
    '## Prohibitions' '' '- protected prohibition beta' '' \
    '## Work Rules' '<!-- EDITABLE:BEGIN -->' \
    'work editable line one' 'work editable line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  commit_agents
  local head_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"

  # Two hunks: one into the first (Goal) region, one into the second (Work Rules).
  local diff='--- a/probe.md
+++ b/probe.md
@@ -8,2 +8,3 @@
 goal editable line one
+inserted into goal region
 goal editable line two
@@ -19,2 +20,3 @@
 work editable line one
+inserted into work region
 work editable line two'
  write_report "${AGENTS}/probe.md" "probe-multi" "${diff}"
  run_apply

  [[ "${status}" -eq 0 ]]
  grep -q 'inserted into goal region' "${AGENTS}/probe.md"
  grep -q 'inserted into work region' "${AGENTS}/probe.md"
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" != "${head_before}" ]]
  grep -q '"status":"applied"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# (e) header-less Strategy-B EOF-append fragment → REJECT (fail-closed)
# ---------------------------------------------------------------------------

@test "header-less Strategy-B fragment is rejected and the tree is fully rolled back" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  commit_agents
  local head_before tree_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"
  tree_before="$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')"

  # No '--- '/'+++ ' headers: a Strategy-B append-only fragment whose only valid
  # placement is EOF, which by construction lands OUTSIDE any editable region.
  local diff='+appended fragment line one
+appended fragment line two'
  write_report "${AGENTS}/probe.md" "probe-headerless" "${diff}"
  run_apply

  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"header_less"' "$(applied_log_path)"
  run grep -q 'appended fragment line one' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
  # Rollback intact: HEAD unchanged (no orphan WIP commit) + working tree clean.
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" == "${head_before}" ]]
  [[ "$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')" == "${tree_before}" ]]
  [[ -z "$(git -C "${AGENTS}" status --porcelain)" ]]
}

# ---------------------------------------------------------------------------
# (f) unreadable target → read_error verdict → REJECT (fail-closed) + rollback
# ---------------------------------------------------------------------------

@test "unreadable target yields read_error and the tree is fully rolled back" {
  # The marker-bearing target lives in a SUBDIR of the repo so we can revoke
  # traversal on the PARENT (chmod 000 on a tracked FILE flips git's stored mode
  # 100644->100000 = a tracked change that would dirty the tree and trigger the
  # stash path, which restores the file readable before the guard reads it; a
  # DIRECTORY mode is NOT git-tracked, so the tree stays clean + the file stays
  # genuinely unreadable). The guard's open() then raises OSError → read_error.
  mkdir -p "${AGENTS}/locked"
  printf '%s\n' \
    '# Probe Agent' '' '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/locked/probe.md"
  commit_agents
  local head_before tree_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"
  tree_before="$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')"

  # A diff that would be perfectly valid (in-region) IF the target were readable —
  # so the ONLY thing that can reject it is the read_error fail-closed branch.
  local diff='--- a/locked/probe.md
+++ b/locked/probe.md
@@ -5,2 +5,3 @@
 editable goal line one
+inserted editable line
 editable goal line two'
  write_report "${AGENTS}/locked/probe.md" "probe-readerr" "${diff}"

  # Revoke traversal on the parent dir so the guard's open() fails (fail-closed).
  # teardown restores perms (chmod -R u+rwX) before rm -rf.
  chmod 000 "${AGENTS}/locked"
  run_apply
  # Restore immediately so the assertion git/grep calls below can read the file.
  chmod 755 "${AGENTS}/locked"

  # Loud read_error reject reason recorded.
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"read_error"' "$(applied_log_path)"
  # File NOT changed (SC2314-safe negative assertion: run grep + status check, not `! grep`).
  run grep -q 'inserted editable line' "${AGENTS}/locked/probe.md"
  [[ "${status}" -ne 0 ]]
  # Rollback intact: HEAD unchanged (no orphan WIP commit), tree hash unchanged,
  # working tree clean.
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" == "${head_before}" ]]
  [[ "$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')" == "${tree_before}" ]]
  [[ -z "$(git -C "${AGENTS}" status --porcelain)" ]]
}

# ---------------------------------------------------------------------------
# (g) mixed-hunk diff (one in-region + one out-of-region) → REJECT WHOLE diff
# ---------------------------------------------------------------------------

@test "mixed-hunk diff with one out-of-region hunk rejects the whole diff and rolls back" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' \
    '- MUST NOT do the dangerous thing' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  commit_agents
  local head_before tree_before
  head_before="$(git -C "${AGENTS}" rev-parse HEAD)"
  tree_before="$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')"

  # ONE diff, TWO hunks against the SAME target:
  #   hunk 1 → anchors on the EDITABLE Goal lines  (lands INSIDE a region — valid)
  #   hunk 2 → anchors on the PROTECTED Absolute-Rules lines (OUTSIDE every region)
  # The per-hunk loop must reject the WHOLE diff on hunk 2 (out_of_region), so
  # NEITHER hunk is applied (no partial apply).
  local diff='--- a/probe.md
+++ b/probe.md
@@ -9,2 +9,3 @@
 editable goal line one
+inserted into editable region
 editable goal line two
@@ -5,2 +5,3 @@
 - MUST NOT do the dangerous thing
+- injected protected rule
 - protected rule line alpha'
  write_report "${AGENTS}/probe.md" "probe-mixed" "${diff}"
  run_apply

  # Loud out_of_region reject reason recorded (the protected hunk is the trigger).
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"out_of_region"' "$(applied_log_path)"
  # NEITHER hunk applied — assert the in-region one was NOT partially applied
  # (SC2314-safe negative assertion via run grep + status check).
  run grep -q 'inserted into editable region' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
  run grep -q 'injected protected rule' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
  # Rollback intact: HEAD unchanged, tree hash unchanged, working tree clean.
  [[ "$(git -C "${AGENTS}" rev-parse HEAD)" == "${head_before}" ]]
  [[ "$(git -C "${AGENTS}" rev-parse 'HEAD^{tree}')" == "${tree_before}" ]]
  [[ -z "$(git -C "${AGENTS}" status --porcelain)" ]]
}
