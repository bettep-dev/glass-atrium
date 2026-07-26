#!/usr/bin/env bats
# snapshot-live-repos.sh tests: sandbox GA-root snapshot, idempotency (2nd run
# adds no commit), commit convention, diffstat-before-commit, the refusal screen
# (both polarities, all-or-nothing, zero staged residue), git-less skip,
# whitelist scoping, apply-lock behaviour, and argument loud-fails.
#
# Every case runs against a synthetic GA_ROOT with fabricated repos — the live
# ~/.glass-atrium repositories are structurally unreachable from here.
#
# EVERY assertion carries `|| return 1`: a bare `[[ ... ]]` that fails mid-body
# does NOT fail the test on bats 1.13 (only the final command's status is
# consulted), so an unguarded mid-body assertion is silently vacuous. Plain
# commands used as assertions (`git diff --cached --quiet`) are given the same
# suffix for uniformity.
#
# Run via: bats scripts/test/snapshot-live-repos.bats
# Requires: bats (brew install bats-core), bash 3.2+, git

SCRIPT="${BATS_TEST_DIRNAME}/../snapshot-live-repos.sh"
REPO_RELS='autoagent agents monitor scripts/test rules test hooks/test'

# Fixture commit — explicit gpgsign-off, because the fixture gitconfig turns
# signing ON to prove the tool passes its own -c commit.gpgsign=false.
fixture_commit() {
  local dir="$1" msg="$2"
  git -C "${dir}" add -A
  git -C "${dir}" -c commit.gpgsign=false commit --quiet -m "${msg}"
}

total_commits() {
  local rel sum=0 n
  for rel in ${REPO_RELS}; do
    n=0
    if [[ -e "${GA_ROOT}/${rel}/.git" ]]; then
      n="$(git -C "${GA_ROOT}/${rel}" rev-list --count HEAD)"
    fi
    sum=$((sum + n))
  done
  printf '%s\n' "${sum}"
}

setup() {
  [[ -f "${SCRIPT}" ]] || skip "snapshot-live-repos.sh not found: ${SCRIPT}"
  WORK="$(mktemp -d -t snapshot-live-repos-bats.XXXXXX)"
  export GA_ROOT="${WORK}/ga"
  export AUTOAGENT_REPORTS_DIR="${WORK}/reports"
  # Hermetic git: synthetic HOME so no host config leaks, identity in a config
  # file rather than GIT_AUTHOR_* env (env would outrank the tool's own -c
  # identity and hide a regression in it), and gpgsign deliberately ON with an
  # unusable signer so an unsigned-commit regression loud-fails.
  export HOME="${WORK}/home"
  mkdir -p "${HOME}"
  export GIT_CONFIG_NOSYSTEM=1
  cat >"${HOME}/.gitconfig" <<EOF
[user]
	name = ga-fixture
	email = ga@fixture.invalid
[commit]
	gpgsign = true
[gpg]
	program = ${WORK}/no-such-gpg
EOF
  local rel
  for rel in ${REPO_RELS}; do
    mkdir -p "${GA_ROOT}/${rel}"
    printf 'baseline\n' >"${GA_ROOT}/${rel}/tracked.txt"
    git -C "${GA_ROOT}/${rel}" init --quiet
    fixture_commit "${GA_ROOT}/${rel}" 'base'
  done
  printf '{"version":"1.0.1"}\n' >"${GA_ROOT}/manifest.json"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# Make autoagent dirty exactly the way a deploy leaves it: modified tracked
# content plus never-tracked bundled release directories.
dirty_autoagent() {
  printf 'deployed\n' >"${GA_ROOT}/autoagent/tracked.txt"
  mkdir -p "${GA_ROOT}/autoagent/test" "${GA_ROOT}/autoagent/baseline"
  printf 'suite\n' >"${GA_ROOT}/autoagent/test/git-txn-gitfree.bats"
  printf 'suite\n' >"${GA_ROOT}/autoagent/test/test_daemon_cycle.py"
  printf 'doc\n' >"${GA_ROOT}/autoagent/baseline/baseline-2026-07-22.md"
}

@test "snapshot: dirty repo ends clean with HEAD content parity and bundled dirs tracked" {
  dirty_autoagent
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "$(git -C "${GA_ROOT}/autoagent" status --porcelain --untracked-files=all)" ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" show HEAD:tracked.txt)" == 'deployed' ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" ls-files test | wc -l | tr -d ' ')" -eq 2 ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" ls-files baseline | wc -l | tr -d ' ')" -eq 1 ]] || return 1
  # Clean members stay untouched at one commit each.
  [[ "$(git -C "${GA_ROOT}/rules" rev-list --count HEAD)" -eq 1 ]] || return 1
  [[ "${output}" == *"clean, no-op: rules"* ]] || return 1
}

@test "idempotency: a second consecutive run creates no new commit" {
  dirty_autoagent
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  head_before="$(git -C "${GA_ROOT}/autoagent" rev-parse HEAD)"
  count_before="$(total_commits)"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" rev-parse HEAD)" == "${head_before}" ]] || return 1
  [[ "$(total_commits)" -eq "${count_before}" ]] || return 1
  [[ "${output}" == *"clean, no-op: autoagent"* ]] || return 1
  [[ "${output}" == *"0 with pending changes"* ]] || return 1
}

@test "commit convention: subject names release and trigger, body names the tool, mechanical identity" {
  dirty_autoagent
  run bash "${SCRIPT}" --trigger post-deploy
  [[ "${status}" -eq 0 ]] || return 1
  subject="$(git -C "${GA_ROOT}/autoagent" log -1 --format=%s)"
  [[ "${subject}" == '- [x] Snapshot live state (v1.0.1, post-deploy)' ]] || return 1
  body="$(git -C "${GA_ROOT}/autoagent" log -1 --format=%b)"
  [[ "${body}" == *'scripts/snapshot-live-repos.sh'* ]] || return 1
  [[ "${body}" == *'post-deploy'* ]] || return 1
  # No human co-authorship / agent attribution on a mechanical snapshot.
  full="$(git -C "${GA_ROOT}/autoagent" log -1 --format=%B)"
  [[ "${full}" != *'Co-Authored-By'* ]] || return 1
  [[ "${full}" != *'Coding-Agent'* ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" log -1 --format='%an <%ae>')" == 'glass-atrium-snapshot <snapshot@glass-atrium.invalid>' ]] || return 1
}

@test "version label: an unreadable manifest warns and falls back to unversioned" {
  dirty_autoagent
  rm -f -- "${GA_ROOT}/manifest.json"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *'release version unreadable'* ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" log -1 --format=%s)" == '- [x] Snapshot live state (unversioned, manual-reconcile)' ]] || return 1
}

@test "dry-run: prints the pending content and stages nothing" {
  dirty_autoagent
  head_before="$(git -C "${GA_ROOT}/autoagent" rev-parse HEAD)"
  run bash "${SCRIPT}" --dry-run
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *'dry-run: would snapshot autoagent'* ]] || return 1
  [[ "${output}" == *'tracked.txt'* ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" rev-parse HEAD)" == "${head_before}" ]] || return 1
  # Nothing staged either: the index still matches HEAD, and the tree is still dirty.
  git -C "${GA_ROOT}/autoagent" diff --cached --quiet HEAD || return 1
  [[ -n "$(git -C "${GA_ROOT}/autoagent" status --porcelain --untracked-files=all)" ]] || return 1
}

@test "diffstat: the pending-content report precedes the commit it produces" {
  dirty_autoagent
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  report_at="$(printf '%s\n' "${output}" | grep -n 'pending snapshot content' | head -1 | cut -d: -f1)"
  commit_at="$(printf '%s\n' "${output}" | grep -n 'snapshotted: autoagent' | head -1 | cut -d: -f1)"
  [[ -n "${report_at}" && -n "${commit_at}" ]] || return 1
  [[ "${report_at}" -lt "${commit_at}" ]] || return 1
  # Untracked additions are listed too — diff --stat alone would not show them.
  [[ "${output}" == *'untracked paths to be added'* ]] || return 1
  [[ "${output}" == *'baseline/baseline-2026-07-22.md'* ]] || return 1
}

@test "refusal: a planted env file refuses the whole run with zero commits and zero staged residue" {
  dirty_autoagent
  printf 'TOKEN=xyz\n' >"${GA_ROOT}/monitor/.env"
  count_before="$(total_commits)"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 6 ]] || return 1
  [[ "${output}" == *'REFUSE monitor'* ]] || return 1
  [[ "${output}" == *'environment file'* ]] || return 1
  # All-or-nothing: the dirty autoagent repo is NOT committed either.
  [[ "$(total_commits)" -eq "${count_before}" ]] || return 1
  git -C "${GA_ROOT}/autoagent" diff --cached --quiet HEAD || return 1
  git -C "${GA_ROOT}/monitor" diff --cached --quiet HEAD || return 1
}

@test "refusal: key material, build output and finder junk each refuse" {
  mkdir -p "${GA_ROOT}/monitor/public/dist"
  printf 'k\n' >"${GA_ROOT}/agents/deploy.pem"
  printf 'j\n' >"${GA_ROOT}/monitor/public/dist/app.js"
  printf 'd\n' >"${GA_ROOT}/rules/.DS_Store"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 6 ]] || return 1
  [[ "${output}" == *'key material'* ]] || return 1
  [[ "${output}" == *'build output (nested public/dist)'* ]] || return 1
  [[ "${output}" == *'finder metadata'* ]] || return 1
  [[ "${output}" == *'refusal screen matched 3 path(s)'* ]] || return 1
}

@test "refusal: a control-character path refuses and is rendered escaped" {
  weird=$'weird\nname.txt'
  printf 'x\n' >"${GA_ROOT}/rules/${weird}"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 6 ]] || return 1
  [[ "${output}" == *'control-character path'* ]] || return 1
  # %q rendering keeps the raw newline out of the report.
  [[ "${output}" == *'weird\nname.txt'* ]] || return 1
  [[ -z "$(git -C "${GA_ROOT}/rules" diff --cached --name-only HEAD)" ]] || return 1
}

@test "refusal polarity: template, fixture, source-data and placeholder paths are admitted" {
  # A naive *secret* / *env* / *data* glob would false-positive on all four.
  printf 'KEY=\n' >"${GA_ROOT}/monitor/.env.example"
  printf 'bats\n' >"${GA_ROOT}/hooks/test/validate-secret-scan.bats"
  mkdir -p "${GA_ROOT}/monitor/public/src/data" "${GA_ROOT}/monitor/data"
  printf 'export const pricing = {};\n' >"${GA_ROOT}/monitor/public/src/data/pricing.js"
  : >"${GA_ROOT}/monitor/data/.gitkeep"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'REFUSE'* ]] || return 1
  [[ -n "$(git -C "${GA_ROOT}/monitor" ls-files .env.example)" ]] || return 1
  [[ -n "$(git -C "${GA_ROOT}/monitor" ls-files public/src/data/pricing.js)" ]] || return 1
  [[ -n "$(git -C "${GA_ROOT}/monitor" ls-files data/.gitkeep)" ]] || return 1
  [[ -n "$(git -C "${GA_ROOT}/hooks/test" ls-files validate-secret-scan.bats)" ]] || return 1
}

@test "git-less: a whitelisted dir with no repo is reported n/a and the others still snapshot" {
  dirty_autoagent
  rm -rf -- "${GA_ROOT}/monitor/.git"
  printf 'changed\n' >"${GA_ROOT}/monitor/tracked.txt"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *'not a repo (git-less install — n/a): monitor'* ]] || return 1
  [[ "${output}" == *'1 not a repo'* ]] || return 1
  [[ ! -e "${GA_ROOT}/monitor/.git" ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" rev-list --count HEAD)" -eq 2 ]] || return 1
}

@test "missing dir: loud-fail exit 3 with zero commits" {
  dirty_autoagent
  rm -rf -- "${GA_ROOT}/hooks/test"
  count_before="$(total_commits)"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 3 ]] || return 1
  [[ "${output}" == *"repo dir missing: ${GA_ROOT}/hooks/test"* ]] || return 1
  # Validate-all-first: the dirty repo was not committed before the failure.
  [[ "$(total_commits)" -eq "${count_before}" ]] || return 1
}

@test "lock: a live holder loud-fails exit 4 and its lock survives" {
  dirty_autoagent
  lock="${AUTOAGENT_REPORTS_DIR}/.apply-lock"
  mkdir -p "${lock}"
  printf '%s\n' "$$" >"${lock}/pid"
  count_before="$(total_commits)"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 4 ]] || return 1
  [[ "${output}" == *'another apply in progress'* ]] || return 1
  [[ "$(total_commits)" -eq "${count_before}" ]] || return 1
  [[ -d "${lock}" ]] || return 1
  [[ "$(cat "${lock}/pid")" == "$$" ]] || return 1
}

@test "lock: the lock is released on a successful run" {
  dirty_autoagent
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${AUTOAGENT_REPORTS_DIR}/.apply-lock" ]] || return 1
}

@test "lock: a missing apply-lock lib loud-fails exit 5" {
  dirty_autoagent
  ATRIUM_APPLY_LOCK_LIB="${WORK}/absent-apply-lock.sh" run bash "${SCRIPT}"
  [[ "${status}" -eq 5 ]] || return 1
  [[ "${output}" == *'apply-lock lib missing'* ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" rev-list --count HEAD)" -eq 1 ]] || return 1
}

@test "whitelist: a dirty non-whitelisted dir is never touched and the GA root never becomes a repo" {
  dirty_autoagent
  mkdir -p "${GA_ROOT}/skills"
  printf 'skill\n' >"${GA_ROOT}/skills/s.md"
  git -C "${GA_ROOT}/skills" init --quiet
  fixture_commit "${GA_ROOT}/skills" 'base'
  printf 'edited\n' >"${GA_ROOT}/skills/s.md"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'skills'* ]] || return 1
  [[ "$(git -C "${GA_ROOT}/skills" rev-list --count HEAD)" -eq 1 ]] || return 1
  [[ -n "$(git -C "${GA_ROOT}/skills" status --porcelain)" ]] || return 1
  [[ ! -e "${GA_ROOT}/.git" ]] || return 1
}

@test "remote: a repo carrying a remote is warned about, still snapshotted, never pushed" {
  dirty_autoagent
  git init --quiet --bare "${WORK}/upstream.git"
  git -C "${GA_ROOT}/autoagent" remote add origin "${WORK}/upstream.git"
  run bash "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *'has a git remote'* ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" rev-list --count HEAD)" -eq 2 ]] || return 1
  # Nothing travelled upstream: the bare repo still has no refs.
  [[ -z "$(git -C "${WORK}/upstream.git" for-each-ref)" ]] || return 1
}

@test "arguments: an unknown flag and an invalid trigger both exit 2 without committing" {
  dirty_autoagent
  run bash "${SCRIPT}" --commit-everything
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *'unknown argument'* ]] || return 1
  run bash "${SCRIPT}" --trigger whenever
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *'invalid --trigger'* ]] || return 1
  run bash "${SCRIPT}" --trigger
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(git -C "${GA_ROOT}/autoagent" rev-list --count HEAD)" -eq 1 ]] || return 1
}
