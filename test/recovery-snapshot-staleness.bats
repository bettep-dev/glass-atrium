#!/usr/bin/env bats
# run_doctor §13 live recovery-repo snapshot staleness surfacing (lib/ga-doctor.sh).
#
# The install carries per-directory git repositories whose only job is to be an operator
# restore point, and the updater is deliberately git-free (zero git invocations in
# scripts/update.sh, so the no-.git consumer install stays supported). A deploy therefore
# never commits into them: HEAD silently falls behind the deployed release and a restore
# rolls the directory BACKWARD. §13 SURFACES that drift and nothing more — the write side
# is a separate deliberate reconcile run (scripts/snapshot-live-repos.sh).
#
# TWO COUNTERS ON DISJOINT CONDITIONS: snapshot staleness and a control-character PATH
# ANOMALY are different findings with different remediations. A snapshot run fixes
# staleness; it no-ops on a file-less pathological tree, so scoring an anomaly as staleness
# prescribes a fix that cannot work — misleading on the dangerous side, since the install
# then reads as missing a restore point it actually has. The scan therefore returns BOTH
# totals on one stdout line (`<stale> <path_anomaly>`), increments them on independently
# evaluated conditions, and emits the clean-tree ok line regardless of the anomaly count.
#
# What this suite pins:
#   * dirty tree -> STALE warn naming the remediation, counted into the warn summary
#   * clean tree -> ok, and NO recency line even with a far-future tracked mtime (on a clean
#     tree on-disk == index == HEAD, so an mtime comparison could only invent staleness —
#     a symlink-farm redeploy or a touch flips its sign with byte-identical content)
#   * absent dir / absent .git -> not-applicable info, never a warn (git-less install fail-open)
#   * control-character path -> the path-anomaly counter ONLY, its warn carrying the mandatory
#     "NOT snapshot staleness" disclaimer, and the clean-tree ok line still emitted
#   * non-masking, pinned per combination: dirty+anomaly -> BOTH counters and both warns ·
#     clean+anomaly -> the anomaly counter alone · commitless+anomaly -> both (a snapshot IS
#     the commitless remediation, and the HEAD-independent anomaly scan still sees the tree)
#   * doctor route: the anomaly footer + its summary token appear WITHOUT the staleness footer,
#     and the no-staleness ok line fires underneath the anomaly warns
#   * doctor still PASSes in every case (advisory-only: §13 never changes the verdict)
#   * read-only: the scan stages nothing, commits nothing, leaves HEAD and the dirty tree as-is
#
# fail-before/pass-after: an implementation that scores a control-character path as staleness
# withholds the clean-tree ok and inflates the stale total, failing the clean+anomaly and
# doctor-route cases; one that counts the anomaly only inside the clean branch reports zero on
# a dirty or commitless repo, failing those two.
#
# Run via: bats test/recovery-snapshot-staleness.bats
# Requires: bats >= 1.5.0, bash 3.2+, git (python3 only for the recency detail line)
#
# Hermetic strategy: every repository under test is a synthetic fixture inside a mktemp
# GA_ROOT — the live ~/.glass-atrium repositories are structurally unreachable, since the
# scan root is passed in (helper route) or is the sandbox GA_ROOT (doctor route). git runs
# against a throwaway HOME with GIT_CONFIG_NOSYSTEM=1 and env identity, so no host config,
# signing key, or hook can reach a fixture commit. The real lib tree is only ever SOURCED.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_LIB="${GA}/lib/ga-core.sh"

# The engine lib tree is read-only across the suite (tests only source it), so stage it once.
# ga-core.sh is a thin loader for its domain siblings, and ga_init_env hard-requires the whole
# scripts/lib set — copy both so a sandbox GA_ROOT resolves the full engine.
setup_file() {
  [[ -f "${REAL_LIB}" ]] || return 0
  ENGINE_SRC="${BATS_FILE_TMPDIR}/engine"
  export ENGINE_SRC
  mkdir -p "${ENGINE_SRC}/lib" "${ENGINE_SRC}/scripts/lib"
  cp "${GA}/lib/"ga-*.sh "${ENGINE_SRC}/lib/"
  cp "${GA}/scripts/lib/"*.sh "${ENGINE_SRC}/scripts/lib/"
}

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "lib/ga-core.sh not found: ${REAL_LIB}"
  command -v git >/dev/null 2>&1 || skip "git required"

  WORK="$(mktemp -d -t recovery-snapshot-bats.XXXXXX)"
  GA_SBX="${WORK}/ga" # sandbox GA root: holds the fixture repos AND the symlinked engine
  TARGET="${WORK}/home/.claude"
  FAKE_MANIFEST="${WORK}/manifest.json"
  GEN_STUB="${WORK}/generate-manifest.sh"
  mkdir -p "${GA_SBX}/scripts" "${TARGET}" "${WORK}/home/Library/LaunchAgents"
  ln -s "${ENGINE_SRC}/lib" "${GA_SBX}/lib"
  ln -s "${ENGINE_SRC}/scripts/lib" "${GA_SBX}/scripts/lib"

  # minimal valid manifest so §4/§7 stay clean; the §8 generator is stubbed exit-0.
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${FAKE_MANIFEST}"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${GEN_STUB}"
  chmod +x "${GEN_STUB}"

  # Hermetic git: throwaway HOME (no host global config / gpgsign leakage) + env identity
  # so a fixture commit needs no user config.
  export HOME="${WORK}/home"
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_AUTHOR_NAME='ga-fixture' GIT_AUTHOR_EMAIL='ga@fixture.invalid'
  export GIT_COMMITTER_NAME='ga-fixture' GIT_COMMITTER_EMAIL='ga@fixture.invalid'
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# --- fixtures ------------------------------------------------------------------

# A whitelisted recovery repo at <GA_SBX>/$1 with one committed file (the clean baseline).
make_repo() {
  local dir="${GA_SBX}/$1"
  mkdir -p "${dir}"
  printf 'release-v1\n' >"${dir}/payload.txt"
  git -C "${dir}" init -q .
  git -C "${dir}" add payload.txt
  git -C "${dir}" commit -qm 'baseline'
}

# The live pathology reproduced inside <GA_SBX>/$1: a FILE-LESS directory tree whose name
# carries a newline. `git status` and `ls-files --others` are both blind to it, so only
# `--directory` surfaces it — and holding no committable file is precisely why a snapshot
# run no-ops on it, which is what makes it a path anomaly rather than staleness.
make_anomaly_tree() {
  mkdir -p "${GA_SBX}/$1/$(printf 'payload.txt\nnested')"
}

# --- runners -------------------------------------------------------------------

# The scan alone, in a fresh strict-mode subprocess against an explicit scan root. ga_init_env
# is deliberately NOT run: the helper takes its root as an argument and needs only log + git,
# which keeps the unit route independent of full-install preconditions.
run_scan() {
  run env bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      snapshot_staleness_scan "$2"
    ' _ "${GA}" "${GA_SBX}"
  # Both totals ride ONE stdout line while every finding goes to stderr, so under bats' merged
  # capture that line is the last one — split into the two variables the tests read. Parameter
  # expansion rather than `read`, mirroring the caller: the launcher pins IFS=$'\n\t'.
  scan_verdict="${lines[$((${#lines[@]} - 1))]}"
  scan_stale="${scan_verdict%% *}"
  scan_path_anomaly="${scan_verdict##* }"
}

# The REAL run_doctor against the sandbox GA root, so §13 scans the fixture repos.
run_doctor_sandbox() {
  run env HOME="${WORK}/home" GA_TARGET_HOME="${TARGET}" \
    GA_MANIFEST="${FAKE_MANIFEST}" GA_GENERATE_MANIFEST="${GEN_STUB}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      run_doctor
    ' _ "${GA_SBX}"
}

# === 1. dirty tracked change -> STALE warn + remediation + recency detail =======

@test "dirty repo -> STALE warn naming the reconcile CLI, counted once" {
  make_repo autoagent
  # the deployed-release shape: content advanced on disk, never committed to the snapshot.
  printf 'release-v2-deployed\n' >"${GA_SBX}/autoagent/payload.txt"
  # far-future mtime so the recency lag is strictly positive and host-clock independent.
  touch -t 203001010000 "${GA_SBX}/autoagent/payload.txt"

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"autoagent recovery snapshot STALE"* ]] || return 1
  [[ "${output}" == *"1 uncommitted tracked change(s), 0 untracked file(s)"* ]] || return 1
  [[ "${output}" == *"run scripts/snapshot-live-repos.sh"* ]] || return 1
  [[ "${output}" == *"HEAD trails the newest tracked-file mtime by"* ]] || return 1
  [[ "${scan_stale}" == "1" ]] || return 1
  [[ "${scan_path_anomaly}" == "0" ]] || return 1
}

# === 2. clean tree -> ok, and the mtime comparison is SUPPRESSED ===============

# The correctness property: a clean tree means on-disk == index == HEAD for every tracked
# path, so the future mtime planted here must NOT produce staleness. Pre-suppression this
# repo would warn on a byte-identical snapshot (the false-staleness class).
@test "clean repo -> ok, no warn, and no recency line even with a future tracked mtime" {
  make_repo rules
  touch -t 203001010000 "${GA_SBX}/rules/payload.txt"

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"rules recovery snapshot current (clean tree"* ]] || return 1
  [[ "${output}" != *"rules recovery snapshot STALE"* ]] || return 1
  [[ "${output}" != *"HEAD trails the newest tracked-file mtime"* ]] || return 1
  [[ "${scan_stale}" == "0" ]] || return 1
  [[ "${scan_path_anomaly}" == "0" ]] || return 1
}

# === 3. absent directory -> not-applicable, never a warn ======================

@test "absent repo directory -> not-applicable info, zero count, rc 0" {
  # no fixture at all: all seven whitelist entries are missing.
  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"autoagent — no such directory (recovery snapshot n/a)"* ]] || return 1
  [[ "${output}" == *"hooks/test — no such directory (recovery snapshot n/a)"* ]] || return 1
  [[ "${output}" != *"warn :"* ]] || return 1
  [[ "${scan_stale}" == "0" ]] || return 1
  [[ "${scan_path_anomaly}" == "0" ]] || return 1
}

# === 4. directory present without .git -> git-less install fail-open ==========

@test "present directory with no .git -> git-less install n/a, never a warn" {
  mkdir -p "${GA_SBX}/monitor"
  printf 'deployed\n' >"${GA_SBX}/monitor/server.js"

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"monitor — not a git repo (git-less install; recovery snapshot n/a)"* ]] || return 1
  [[ "${output}" != *"warn :"* ]] || return 1
  [[ "${scan_stale}" == "0" ]] || return 1
  [[ "${scan_path_anomaly}" == "0" ]] || return 1
}

# === 5. untracked-only drift -> STALE ========================================

# Bundled release content that was deployed but never added is invisible to `diff HEAD`;
# it is exactly the 32-entry class the reconcile has to capture, so it must count as stale.
@test "untracked-only bundled content -> STALE warn" {
  make_repo agents
  printf 'learned-body\n' >"${GA_SBX}/agents/dev-shell.md"

  run_scan

  [[ "${output}" == *"agents recovery snapshot STALE"* ]] || return 1
  [[ "${output}" == *"0 uncommitted tracked change(s), 1 untracked file(s)"* ]] || return 1
  [[ "${scan_stale}" == "1" ]] || return 1
  [[ "${scan_path_anomaly}" == "0" ]] || return 1
}

# === 6. initialized-but-commitless repo -> its own anomaly warn ===============

@test "repo with no commit yet -> warn (nothing to restore to)" {
  mkdir -p "${GA_SBX}/test"
  git -C "${GA_SBX}/test" init -q .

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"test — recovery repo has no commit yet (nothing to restore to)"* ]] || return 1
  [[ "${scan_stale}" == "1" ]] || return 1
  [[ "${scan_path_anomaly}" == "0" ]] || return 1
}

# === 7. clean tree + control-character path -> ANOMALY ONLY ====================

# The live shape (two such trees sat on the install): a provably current recovery repo that
# also carries a file-less newline-named tree. Scoring that as staleness prescribed a snapshot
# run that would no-op, and withheld the ok line that was the truth about the repo.
@test "clean tree + control-character path -> path-anomaly counted, staleness zero, ok still emitted" {
  make_repo scripts/test
  make_anomaly_tree scripts/test

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"scripts/test — control-character path, unsafe for a blanket snapshot stage (path anomaly, NOT snapshot staleness)"* ]] || return 1
  [[ "${output}" == *"scripts/test recovery snapshot current (clean tree"* ]] || return 1
  [[ "${output}" != *"scripts/test recovery snapshot STALE"* ]] || return 1
  [[ "${scan_stale}" == "0" ]] || return 1
  [[ "${scan_path_anomaly}" == "1" ]] || return 1
}

# === 8. dirty tree + control-character path -> BOTH counters ==================

# The non-masking property in code rather than prose: one repo carrying both findings must
# increment both totals and emit both warns — neither condition gates the other.
@test "one repo dirty AND carrying a control-character path -> stale 1 and path-anomaly 1" {
  make_repo autoagent
  printf 'release-v2-deployed\n' >"${GA_SBX}/autoagent/payload.txt"
  make_anomaly_tree autoagent

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"autoagent — control-character path, unsafe for a blanket snapshot stage (path anomaly, NOT snapshot staleness)"* ]] || return 1
  [[ "${output}" == *"autoagent recovery snapshot STALE"* ]] || return 1
  [[ "${scan_stale}" == "1" ]] || return 1
  [[ "${scan_path_anomaly}" == "1" ]] || return 1
}

# === 9. commitless repo + control-character path -> BOTH counters =============

# Pins the block order: the anomaly scan carries no HEAD dependency, so it must run ABOVE the
# commitless gate whose `continue` would otherwise drop the finding on the one repo that has
# neither a restore point nor a stageable tree.
@test "commitless repo carrying a control-character path -> both findings surfaced" {
  mkdir -p "${GA_SBX}/test"
  git -C "${GA_SBX}/test" init -q .
  make_anomaly_tree test

  run_scan

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"test — control-character path, unsafe for a blanket snapshot stage (path anomaly, NOT snapshot staleness)"* ]] || return 1
  [[ "${output}" == *"test — recovery repo has no commit yet (nothing to restore to)"* ]] || return 1
  [[ "${scan_stale}" == "1" ]] || return 1
  [[ "${scan_path_anomaly}" == "1" ]] || return 1
}

# === 10. read-only: the scan stages nothing and commits nothing ===============

@test "scan is read-only: HEAD, index, and dirty tree all unchanged" {
  make_repo autoagent
  printf 'release-v2-deployed\n' >"${GA_SBX}/autoagent/payload.txt"
  printf 'extra\n' >"${GA_SBX}/autoagent/untracked.txt"
  local head_before status_before head_after status_after commits
  head_before="$(git -C "${GA_SBX}/autoagent" rev-parse HEAD)"
  status_before="$(git -C "${GA_SBX}/autoagent" status --porcelain)"

  run_scan

  head_after="$(git -C "${GA_SBX}/autoagent" rev-parse HEAD)"
  status_after="$(git -C "${GA_SBX}/autoagent" status --porcelain)"
  commits="$(git -C "${GA_SBX}/autoagent" rev-list --count HEAD)"
  [[ "${head_after}" == "${head_before}" ]] || return 1
  [[ "${status_after}" == "${status_before}" ]] || return 1
  [[ "${commits}" -eq 1 ]] || return 1
  # nothing was staged: the index still matches HEAD.
  git -C "${GA_SBX}/autoagent" diff --cached --quiet || return 1
}

# === 11. doctor integration: warn summary carries it, verdict stays PASS ======

@test "dirty repo via run_doctor -> snapshot-stale in the warn summary, doctor PASSes" {
  make_repo autoagent
  printf 'release-v2-deployed\n' >"${GA_SBX}/autoagent/payload.txt"

  run_doctor_sandbox

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"autoagent recovery snapshot STALE"* ]] || return 1
  [[ "${output}" == *"1 live recovery repo(s) need a snapshot"* ]] || return 1
  [[ "${output}" == *"1 snapshot-stale"* ]] || return 1
  [[ "${output}" == *"0 snapshot-path-anomaly"* ]] || return 1
  [[ "${output}" != *"carry a control-character path"* ]] || return 1
  [[ "${output}" == *"== doctor: PASS"* ]] || return 1
  [[ "${output}" != *"== doctor: FAIL =="* ]] || return 1
}

# === 12. doctor integration: no drift -> ok line, verdict stays PASS =========

@test "clean and absent repos via run_doctor -> ok line, doctor PASSes" {
  make_repo rules

  run_doctor_sandbox

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"ok   : no live recovery-repo snapshot staleness"* ]] || return 1
  [[ "${output}" != *"recovery snapshot STALE"* ]] || return 1
  [[ "${output}" == *"== doctor: PASS"* ]] || return 1
  [[ "${output}" != *"== doctor: FAIL =="* ]] || return 1
}

# === 13. doctor integration: anomaly-only footer, no staleness prescription ====

# The live install's exact shape end-to-end: the operator sees the anomaly with an INSPECTION
# remedy (doctor is mutation-free), is never told to run a snapshot that would no-op, still
# gets the no-staleness ok, and the anomaly is enumerated in the warn summary — otherwise the
# zero-warning PASS line prints directly beneath its own warn lines.
@test "clean repo with a control-character path via run_doctor -> anomaly footer, no snapshot prescription" {
  make_repo rules
  make_anomaly_tree rules

  run_doctor_sandbox

  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"rules — control-character path, unsafe for a blanket snapshot stage (path anomaly, NOT snapshot staleness)"* ]] || return 1
  [[ "${output}" == *"1 live recovery repo(s) carry a control-character path (file-less pathological tree) — NOT staleness"* ]] || return 1
  [[ "${output}" == *"inspect the path named above and remove the empty tree once verified"* ]] || return 1
  [[ "${output}" != *"need a snapshot"* ]] || return 1
  [[ "${output}" == *"ok   : no live recovery-repo snapshot staleness"* ]] || return 1
  [[ "${output}" == *"0 snapshot-stale"* ]] || return 1
  [[ "${output}" == *"1 snapshot-path-anomaly"* ]] || return 1
  [[ "${output}" == *"== doctor: PASS (with"* ]] || return 1
  [[ "${output}" != *"== doctor: FAIL =="* ]] || return 1
}
