#!/usr/bin/env bats
# validate-large-diff.bats — verdict + perf suite for the PostToolUse(Edit|Write) large-diff
# advisory after folding its repo-detection into the first diff:
#   old: git rev-parse --is-inside-work-tree  +  git diff --numstat  +  git diff --cached --numstat
#        = 3 git subprocesses per edit.
#   new: git diff --numstat (its non-zero exit outside a work tree replaces rev-parse) +
#        git diff --cached --numstat = 2 git subprocesses per edit (1 on the non-repo path).
#
# VERDICT PARITY (a): TOTAL = unstaged-churn + staged-churn (a SUM, not a HEAD net), and the
# strict `>400` threshold, are unchanged — proven at the boundary (400 → no advisory, 401 →
# SCOPE-080), on the staged+unstaged split (300+150=450 → advisory), and on binary dashes (0).
# PERF INVARIANT (b): the no-op/repo path now runs 2 git subprocesses (was 3), the non-repo path
# 1 — counted with a mock `git` on PATH. No live repo state is read.
#
# Hermetic: a mock `git` on PATH returns scripted numstat / repo-presence and logs every call.

bats_require_minimum_version 1.5.0

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-large-diff.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "validate-large-diff.sh not found: ${HOOK_SH}"
  command -v awk >/dev/null 2>&1 || skip "awk required"
  WORK="$(mktemp -d -t validate-large-diff-bats.XXXXXX)"
  mkdir -p "${WORK}/bin"
  install_mock_git
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Mock git: logs each invocation (one line) then answers from env —
#   FAKE_NONREPO=1        → every git call exits 128 (outside a work tree)
#   FAKE_UNSTAGED / FAKE_STAGED → numstat body for `git diff [--cached] --numstat` (printf %b,
#     so \t and \n in the fixture are real tabs/newlines). rev-parse is still answered so a
#     regression that reintroduces it does not silently break this mock.
install_mock_git() {
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf "git %%s\\n" "$*" >>%q\n' "${WORK}/gitlog"
    printf '[[ "${FAKE_NONREPO:-}" == 1 ]] && exit 128\n'
    printf 'case "$*" in\n'
    printf '  "rev-parse --is-inside-work-tree") printf "true\\n" ;;\n'
    printf '  "diff --numstat") printf "%%b" "${FAKE_UNSTAGED:-}" ;;\n'
    printf '  "diff --cached --numstat") printf "%%b" "${FAKE_STAGED:-}" ;;\n'
    printf '  *) exit 0 ;;\n'
    printf 'esac\n'
  } >"${WORK}/bin/git"
  chmod +x "${WORK}/bin/git"
}

# Drive the hook with the mock git first on PATH; stderr merged so the SCOPE-080 advisory
# lands in $output. Extra args (env assignments) pass through to `env`.
run_hook() {
  : >"${WORK}/gitlog"
  run env "$@" PATH="${WORK}/bin:${PATH}" bash -c 'printf "" | bash "$1" 2>&1' _ "${HOOK_SH}"
}

# Git subprocess count = lines in the call log (0 when absent — grep -c zero-match safe).
git_call_count() {
  [[ -f "${WORK}/gitlog" ]] || {
    printf '0\n'
    return 0
  }
  wc -l <"${WORK}/gitlog" | tr -d ' '
}

# --- VERDICT PARITY (a) --------------------------------------------------------

@test "verdict: no-op repo (no changes) → TOTAL 0 → exit 0, no SCOPE-080 advisory" {
  run_hook FAKE_UNSTAGED="" FAKE_STAGED=""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SCOPE-080"* ]] || return 1
}

@test "verdict: small diff (8 lines) → below threshold → no advisory" {
  run_hook FAKE_UNSTAGED='5\t3\tfile.txt\n' FAKE_STAGED=''
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SCOPE-080"* ]] || return 1
}

@test "verdict boundary: exactly 400 lines → strict >400 means NO advisory" {
  run_hook FAKE_UNSTAGED='400\t0\tbig.txt\n' FAKE_STAGED=''
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SCOPE-080"* ]] || return 1
}

@test "verdict boundary: 401 lines → SCOPE-080 advisory, still exit 0 (non-blocking)" {
  run_hook FAKE_UNSTAGED='401\t0\tbig.txt\n' FAKE_STAGED=''
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SCOPE-080"* ]] || return 1
  [[ "${output}" == *"Large diff detected"* ]] || return 1
}

@test "verdict: TOTAL is unstaged + staged SUM (300+150=450 > 400 → advisory)" {
  # A HEAD-net single-call substitution would net these differently; the SUM is what must hold.
  run_hook FAKE_UNSTAGED='300\t0\tu.txt\n' FAKE_STAGED='150\t0\ts.txt\n'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SCOPE-080"* ]] || return 1
}

@test "verdict: staged-only churn counts (0 unstaged + 450 staged → advisory)" {
  run_hook FAKE_UNSTAGED='' FAKE_STAGED='450\t0\ts.txt\n'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SCOPE-080"* ]] || return 1
}

@test "verdict: binary files (numstat dashes) contribute 0 lines → no advisory" {
  run_hook FAKE_UNSTAGED='-\t-\timage.png\n' FAKE_STAGED='-\t-\tblob.bin\n'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SCOPE-080"* ]] || return 1
}

@test "verdict: non-repo → exit 0, no advisory (short-circuit preserved)" {
  run_hook FAKE_NONREPO=1
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"SCOPE-080"* ]] || return 1
}

# --- PERF INVARIANT (b): fewer git subprocesses --------------------------------

@test "perf: no-op repo path runs exactly 2 git subprocesses (was 3, rev-parse folded out)" {
  run_hook FAKE_UNSTAGED='' FAKE_STAGED=''
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(git_call_count)" -eq 2 ]] || {
    printf 'git calls=%s (expected 2)\n' "$(git_call_count)" >&2
    return 1
  }
  # No rev-parse in the new flow.
  grep -q 'rev-parse' "${WORK}/gitlog" && return 1
  return 0
}

@test "perf: large-diff repo path also runs exactly 2 git subprocesses" {
  run_hook FAKE_UNSTAGED='401\t0\tbig.txt\n' FAKE_STAGED=''
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"SCOPE-080"* ]] || return 1
  [[ "$(git_call_count)" -eq 2 ]] || return 1
}

@test "perf: non-repo path short-circuits at 1 git subprocess (the first diff's non-zero exit)" {
  run_hook FAKE_NONREPO=1
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(git_call_count)" -eq 1 ]] || {
    printf 'git calls=%s (expected 1)\n' "$(git_call_count)" >&2
    return 1
  }
}
