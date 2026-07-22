#!/usr/bin/env bats
# daemon-apply.sh apply-time LANDING-ZONE guard suite (git-FREE, P1-T4) — pins
# assert_diff_in_editable_region:
#   * in-region edit       → ACCEPT (bytes land, applied-log status=applied)
#   * out-of-region edit   → REJECT + target byte-unchanged (guard runs pre-apply)
#   * no-marker target      → REJECT (fail-closed) + byte-unchanged
#   * multi-region file      → one hunk per disjoint region → ACCEPT
#   * header-less fragment   → REJECT (Strategy-B EOF append lands outside) + unchanged
#   * unreadable target      → read_error verdict → REJECT (fail-closed) + unchanged
#   * mixed-hunk diff        → one in-region + one out-of-region hunk → REJECT the
#                            WHOLE diff (no partial apply) + byte-unchanged
#
# GIT-FREE MODEL (P1-T2): the daemon no longer wraps applies in git commits. The
# transaction is a before-image copy + `git apply --recount` (which lands a unified
# diff OUTSIDE any git repo) + verify + atomic restore-from-.bak. Consequences for
# THIS suite: the AGENTS dir is a PLAIN directory (no `git init`); a landing-zone
# REJECT writes NO bytes (the guard runs BEFORE the apply, nothing to restore); and
# "rollback intact" is asserted as the target staying BYTE-IDENTICAL to a pre-apply
# pristine snapshot — NOT via HEAD/tree rev-parse (there are no commits to inspect).
#
# Run via: bats autoagent/test/daemon-apply-landing-zone.bats
# Requires: bats >= 1.5.0 (brew install bats-core), bash 3.2+, git (for `git apply`
# only), python3
#
# Hermetic strategy: the PG backlog path is masked by pointing PATH at a stub bin
# that MIRRORS every real command EXCEPT psql (whole-PATH mirror — robust to the
# git-free daemon's shifting command set, where a hand-maintained allowlist would
# silently 127 on a newly-used binary like basename/mv/stat). backlog_source_
# available() (command -v psql) is therefore false and daemon-apply takes the
# deterministic JSON-report fallback, exercising the full apply_patch_rows → guard →
# (apply | reject) flow against the report-sourced patch. No PG, no live agents/
# dir, no git repo is touched. git is NOT mirrored: the stub carries an
# allow-only-apply git shim (precedent: git-txn-gitfree.bats) that delegates
# `git [-C <dir>] apply` to the real git and HARD-FAILS every other subcommand —
# a suppressed non-apply git call inside the daemon can never pass unnoticed at
# runtime.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

# build_psql_masked_stub — symlink every real command into $1 EXCEPT psql. The
# whole-PATH mirror (vs a hand-maintained allowlist) is deliberate: the git-free
# daemon + its sourced libs (git-txn.sh / apply-lock.sh) call a broad, evolving set
# of coreutils (basename/dirname/mv/stat/cp/…); an allowlist that misses one makes
# the daemon exit 127 mid-run and every test fail opaquely. Mirroring the whole
# PATH keeps psql the ONLY thing masked, so command -v psql fails under the
# stub-only PATH → the deterministic report-fallback path is taken.
build_psql_masked_stub() {
  local stub="$1" d f name
  local IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      # psql masked (forces the report fallback); git replaced by the
      # allow-only-apply shim build_git_apply_shim writes into the stub.
      [[ "${name}" == "psql" || "${name}" == "git" ]] && continue
      [[ -e "${stub}/${name}" ]] || ln -sf "${f}" "${stub}/${name}"
    done
  done
}

# build_git_apply_shim — write an allow-only-apply `git` into the stub dir:
# `git [-C <dir>] apply …` execs the REAL git; EVERY other subcommand hard-fails
# to stderr + rc 97 (precedent: git-txn-gitfree.bats). This closes the runtime
# gap the whole-PATH mirror left open — a suppressed non-apply git call inside
# the daemon now breaks its test loudly instead of silently succeeding. The
# LZ_GIT_APPLY_READY / LZ_GIT_APPLY_RESUME seam lets the SIGTERM test below hold
# the daemon INSIDE an in-flight apply (both env vars unset → plain
# pass-through; the RESUME wait is BOUNDED so an aborted test can never strand
# a spinning shim).
build_git_apply_shim() {
  local stub="$1" real_git
  real_git="$(command -v git)"
  cat >"${stub}/git" <<EOF
#!/usr/bin/env bash
sub="\${1:-}"
[[ "\${sub}" == "-C" ]] && sub="\${3:-}"
if [[ "\${sub}" == "apply" ]]; then
  if [[ -n "\${LZ_GIT_APPLY_READY:-}" ]]; then
    : >"\${LZ_GIT_APPLY_READY}"
    j=0
    while [[ ! -e "\${LZ_GIT_APPLY_RESUME:-}" && "\${j}" -lt 100 ]]; do
      sleep 0.1
      j=\$((j + 1))
    done
  fi
  exec "${real_git}" "\$@"
fi
printf 'git-shim: BLOCKED non-apply git subcommand: %s\n' "\${sub:-\${1:-}}" >&2
exit 97
EOF
  chmod +x "${stub}/git"
}

# setup_file — build the psql-masked stub + git shim ONCE (read-only, shared
# across tests). Per-test setup only creates the mutable agents/reports dirs.
# `skip` is illegal here; a missing daemon-apply.sh is handled by the per-test
# setup skip below.
setup_file() {
  STUB="${BATS_FILE_TMPDIR}/bin"
  mkdir -p -- "${STUB}"
  if [[ -f "${GA}/autoagent/daemon-apply.sh" ]]; then
    build_psql_masked_stub "${STUB}"
    build_git_apply_shim "${STUB}"
  fi
  export STUB
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so the realpath containment check passes.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-lz-bats.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents" # PLAIN dir — the git-free daemon needs NO repo here.
  REPORTS="${WORK}/reports"
  mkdir -p "${AGENTS}" "${REPORTS}"
}

teardown() {
  # Reap a straggler daemon from the SIGTERM test if an assertion aborted that
  # test between spawn and its bounded reap (best-effort; pid is our own child).
  [[ -n "${DAEMON_PID:-}" ]] && kill -9 "${DAEMON_PID}" 2>/dev/null || true
  DAEMON_PID=""
  # Restore traversable perms across the tree first: the read_error test chmod
  # 000's a target's PARENT dir to force the guard's open() to fail, and `rm -rf`
  # cannot recurse into a 000 dir. u+rwX is a no-op for the other tests.
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# snapshot_pristine — capture a byte-for-byte pre-apply baseline of the target.
# git-free rollback assertion: a REJECTED diff writes NO bytes (the landing-zone
# guard runs BEFORE the apply), so the target must stay identical to this snapshot.
snapshot_pristine() {
  PRISTINE_SNAPSHOT="${WORK}/pristine.snapshot"
  cp -p -- "$1" "${PRISTINE_SNAPSHOT}"
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
                    "pre_verify_passed": True,
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

# run_apply — invoke daemon-apply.sh on the report fixture with the psql-masked
# stub PATH (report fallback) and the plain agents dir (no git repo).
# AUTOAGENT_PREFLIGHT_ACTIVE=1: this suite exercises the landing-zone guard, not
# the test-suite preflight — the sentinel skips the batch-path green-suite (whose
# roots ARE present under the live GA_ROOT here) so the apply path runs directly.
run_apply() {
  run env PATH="${STUB}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

# applied_log_path — today's report-fallback applied JSONL.
applied_log_path() {
  printf '%s/autoagent-applied-%s.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

# ---------------------------------------------------------------------------
# (a) in-region edit → ACCEPT
# ---------------------------------------------------------------------------

@test "in-region edit lands (bytes applied, status=applied logged)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"

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
  # git-free: no commit — the applied-log status is the landing record.
  grep -q '"status":"applied"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# (b) out-of-region edit → REJECT + target byte-unchanged
# ---------------------------------------------------------------------------

@test "out-of-region edit is rejected and the target is byte-unchanged (no apply)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' \
    '- MUST NOT do the dangerous thing' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  snapshot_pristine "${AGENTS}/probe.md"

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
  # git-free rollback: the target is byte-identical to the pre-apply snapshot
  # (the guard rejected BEFORE any apply, so NOTHING was written).
  cmp -s "${PRISTINE_SNAPSHOT}" "${AGENTS}/probe.md"
  # And the injected line never reached the file (SC2314-safe negative assertion:
  # run grep + status check, NOT a bare `! grep` which Bats ignores).
  run grep -q 'injected protected rule' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# (c) target with no marker → REJECT
# ---------------------------------------------------------------------------

@test "target file with no editable marker is rejected (fail-closed)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Goal' '' \
    'plain unmarked body line one' 'plain unmarked body line two' \
    >"${AGENTS}/probe.md"
  snapshot_pristine "${AGENTS}/probe.md"

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
  cmp -s "${PRISTINE_SNAPSHOT}" "${AGENTS}/probe.md"
  run grep -q 'inserted line' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
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
  grep -q '"status":"applied"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# (e) header-less Strategy-B EOF-append fragment → REJECT (fail-closed)
# ---------------------------------------------------------------------------

@test "header-less Strategy-B fragment is rejected and the target is byte-unchanged" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  snapshot_pristine "${AGENTS}/probe.md"

  # No '--- '/'+++ ' headers: a Strategy-B append-only fragment whose only valid
  # placement is EOF, which by construction lands OUTSIDE any editable region.
  local diff='+appended fragment line one
+appended fragment line two'
  write_report "${AGENTS}/probe.md" "probe-headerless" "${diff}"
  run_apply

  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"header_less"' "$(applied_log_path)"
  cmp -s "${PRISTINE_SNAPSHOT}" "${AGENTS}/probe.md"
  run grep -q 'appended fragment line one' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# (f) unreadable target → read_error verdict → REJECT (fail-closed) + unchanged
# ---------------------------------------------------------------------------

@test "unreadable target yields read_error and the target is byte-unchanged" {
  # The marker-bearing target lives in a SUBDIR so we can revoke traversal on its
  # PARENT dir (chmod 000). git-free simplifies the old rationale: there is NO git
  # tree/stash, so a chmod cannot dirty a worktree or trip a stash-restore path —
  # the parent-dir 000 simply makes the guard's python open() raise OSError, which
  # the fail-closed guard maps to the read_error verdict and rejects (no bytes).
  mkdir -p "${AGENTS}/locked"
  printf '%s\n' \
    '# Probe Agent' '' '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/locked/probe.md"
  snapshot_pristine "${AGENTS}/locked/probe.md"

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
  # Restore immediately so the assertion grep/cmp calls below can read the file.
  chmod 755 "${AGENTS}/locked"

  # Loud read_error reject reason recorded.
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"read_error"' "$(applied_log_path)"
  # Target byte-unchanged + the insert never landed (SC2314-safe negative check).
  cmp -s "${PRISTINE_SNAPSHOT}" "${AGENTS}/locked/probe.md"
  run grep -q 'inserted editable line' "${AGENTS}/locked/probe.md"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# (g) mixed-hunk diff (one in-region + one out-of-region) → REJECT WHOLE diff
# ---------------------------------------------------------------------------

@test "mixed-hunk diff with one out-of-region hunk rejects the whole diff (byte-unchanged)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' \
    '- MUST NOT do the dangerous thing' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  snapshot_pristine "${AGENTS}/probe.md"

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
  # git-free: NEITHER hunk applied — the target is byte-identical to the snapshot
  # (no partial apply, nothing written).
  cmp -s "${PRISTINE_SNAPSHOT}" "${AGENTS}/probe.md"
  run grep -q 'inserted into editable region' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
  run grep -q 'injected protected rule' "${AGENTS}/probe.md"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# (h) SIGTERM mid-apply → the TERM trap releases the .apply-lock AND terminates
#     the daemon (exit 143, no post-signal mutations)
# ---------------------------------------------------------------------------

@test "SIGTERM mid-apply releases the .apply-lock and terminates (exit 143, no post-signal work)" {
  printf '%s\n' \
    '# Probe Agent' '' '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"

  local diff='--- a/probe.md
+++ b/probe.md
@@ -5,2 +5,3 @@
 editable goal line one
+inserted editable line
 editable goal line two'
  write_report "${AGENTS}/probe.md" "probe-sigterm" "${diff}"

  # Handshake seam (git shim): READY appears once the daemon is INSIDE the
  # in-flight `git apply` — i.e. mid-run, .apply-lock held; RESUME lets the
  # apply finish, because bash DEFERS a trapped signal until the foreground
  # child exits (the TERM trap cannot run while git is still in flight).
  local ready="${WORK}/git-apply.ready" resume="${WORK}/git-apply.resume"

  env PATH="${STUB}" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    LZ_GIT_APPLY_READY="${ready}" LZ_GIT_APPLY_RESUME="${resume}" \
    AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}" \
    </dev/null >"${WORK}/daemon.log" 2>&1 3>&- &
  DAEMON_PID=$!

  # Bounded wait for the mid-apply handshake (≤10s), then pin the mid-run state.
  local i=0
  while [[ ! -e "${ready}" && "${i}" -lt 100 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  [[ -e "${ready}" ]]               # daemon reached the apply (not a startup fail)
  [[ -d "${REPORTS}/.apply-lock" ]] # the lock IS held at SIGTERM-delivery time

  kill -TERM "${DAEMON_PID}" # delivered NOW, pending while git is in flight
  : >"${resume}"             # unblock the apply so the deferred trap can fire

  # Bounded reap. Regression pin: if TERM ever drops out of the trap list the
  # daemon dies trap-LESS (EXIT traps do NOT run on an untrapped fatal signal)
  # and the lock-gone assertion below catches the stranded dir.
  i=0
  while kill -0 "${DAEMON_PID}" 2>/dev/null && [[ "${i}" -lt 100 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "${DAEMON_PID}" 2>/dev/null; then
    kill -9 "${DAEMON_PID}" 2>/dev/null || true
    wait "${DAEMON_PID}" 2>/dev/null || true
    DAEMON_PID=""
    false # daemon failed to exit after SIGTERM + resume
  fi
  local daemon_rc=0
  wait "${DAEMON_PID}" 2>/dev/null || daemon_rc=$?
  DAEMON_PID=""

  [[ ! -d "${REPORTS}/.apply-lock" ]] # trap released the lock — nothing stranded

  # Regression pin (signal-exit defect): the TERM handler must TERMINATE the
  # daemon with 128+SIGTERM=143. Pre-fix, bash RESUMED execution after the
  # shared handler released the lock, so the daemon ran to natural completion
  # (exit 0) — mutating agent files with NO mutual exclusion post-signal.
  [[ "${daemon_rc}" -eq 143 ]]

  # No post-signal mutations: the handler exits BEFORE verify/emit_log, so the
  # applied log must NOT record an applied row for this run (SC2314-safe
  # negative assertion: run grep + status check, not a bare `! grep`).
  run grep -q '"status":"applied"' "$(applied_log_path)"
  [[ "${status}" -ne 0 ]]
}
