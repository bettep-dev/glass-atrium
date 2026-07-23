#!/usr/bin/env bats
# pii-scan.sh release-gate scanner tests (T10 AC).
#
# AC pinned: intentional-violation fixtures are caught (exit 1), a clean tree is
#   0 hits (exit 0), unmet preconditions are exit 2. Patterns are derived from
#   the running machine ($HOME · $USER ...), so all fixture content is also
#   synthesized at runtime — hardcoding a personal string in the test file would
#   itself become tracked PII, so that is forbidden. Single exception: the
#   approved-disclosure identifiers (APPROVED_MAINTAINER_IDS — disclosure
#   decision 2026-07-20) are exact-match hardcoded constants, so verification
#   must use the same literal (fragment assembly cannot exercise the allowlist).
#
# Run via: bats scripts/test/pii-scan.bats
# Requires: bats (brew install bats-core), bash 3.2+

SCANNER="${BATS_TEST_DIRNAME}/../pii-scan.sh"

setup() {
  [[ -f "${SCANNER}" ]] || skip "pii-scan.sh not found: ${SCANNER}"
  # Host-independent synthetic USER (P0 Wave 3): the scanner derives PII pattern
  #   #3 from $USER (word-boundary). If the CI host's username is a token that
  #   appears in tracked sources (ci.yml/docs), it causes a worktree-clean
  #   false-positive FAIL. Injecting a fixed synthetic token makes the derived
  #   pattern deterministic and guarantees no match against real repo content on
  #   any host (CI/dev machine). The fixtures below synthesize dirty content from
  #   the same $USER, so the dir-mode word-boundary tests stay aligned. The
  #   expanded value is assembled from fragments so it never appears as a
  #   contiguous literal in this tracked file — otherwise the tracked-mode scan
  #   would self-match the fixture name and re-trigger the FAIL it was meant to
  #   remove.
  local u_head="ga-fixture" u_tail="user"
  export USER="${u_head}-${u_tail}"
  # Host-independent synthetic HOME (T1 allowlist): the maintainer machine's real
  #   HOME matches the approved-disclosure identifier (/Users/bettep) and is
  #   excluded at collection time, which would neutralize the HOME fixture tests
  #   on that host. As with USER, inject a synthetic value to make the derived
  #   pattern deterministic, with the same fragment assembly to avoid a
  #   contiguous literal (prevents tracked-mode self-match). Global git config
  #   missing under this HOME is harmless — every isolated-repo test commits
  #   with a repo-local user.email.
  local h_tail="home"
  export HOME="/Users/ga-fixture-${h_tail}"
  WORK="$(mktemp -d -t pii-scan-bats.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# ---------------------------------------------------------------------------
# dir mode (artifact-tree scan)
# ---------------------------------------------------------------------------

@test "dir mode: clean tree -> exit 0" {
  printf 'port = 16145\npath = "/usr/local/share"\n' >"${WORK}/clean.toml"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"worktree-clean: PASS"* ]]
}

@test "dir mode: HOME path literal in a file -> exit 1 + hit line names the file" {
  printf 'log_root = "%s/logs"\n' "${HOME}" >"${WORK}/pii-fixture.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"pii-fixture.txt"* ]]
  [[ "${output}" == *"FAIL"* ]]
}

@test "dir mode: bare USER token -> exit 1 (word-boundary match)" {
  printf 'owner: %s\n' "${USER}" >"${WORK}/owner.md"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"owner.md"* ]]
}

@test "dir mode: USER embedded inside a longer token -> no false positive" {
  # Verifies the word-boundary flag — a partial match of the short token must not be a hit.
  printf 'token: x%sx\n' "${USER}" >"${WORK}/embedded.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 0 ]]
}

@test "dir mode: PII under node_modules/ is excluded -> exit 0" {
  mkdir -p "${WORK}/node_modules/pkg"
  printf 'home = "%s"\n' "${HOME}" >"${WORK}/node_modules/pkg/cfg.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 0 ]]
}

@test "dir mode: missing directory argument -> exit 2 (precondition loud-fail)" {
  run bash "${SCANNER}" "${WORK}/does-not-exist"
  [[ "${status}" -eq 2 ]]
}

# ---------------------------------------------------------------------------
# tracked mode (release gate — two independent checks)
# ---------------------------------------------------------------------------

# The live-tree tracked-mode tests scan the GA root the scanner anchors to
# (script dirname/.. → BATS_TEST_DIRNAME/../..). A consumer install has no .git
# there, where the scanner loud-fails (exit 2) — mirror its own --git-dir probe
# verbatim so skip is exactly equivalent to that loud-fail. PER-TEST (not
# setup-wide): dir-mode + isolated-fixture-repo tests build their own trees and
# must keep running. The --worktree-only arg-rejection test stays UNGUARDED —
# its loud-fail fires before the repo check, so it is repo-independent.
require_ga_repo() {
  local ga_root
  ga_root="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
  git -C "${ga_root}" rev-parse --git-dir >/dev/null 2>&1 \
    || skip "not a git repo: ${ga_root} (consumer install — tracked-set mode needs the GA repo)"
}

@test "tracked mode: worktree is clean (release-gate invariant — no PII in HEAD tree)" {
  require_ga_repo
  # The two checks are separate, so worktree cleanliness is asserted on its own — holds regardless of history state.
  run bash "${SCANNER}" --worktree-only
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"worktree-clean: PASS"* ]]
}

@test "tracked mode: --worktree-only skips history and exits 0" {
  require_ga_repo
  run bash "${SCANNER}" --worktree-only
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"history-clean SKIPPED"* ]]
}

@test "tracked mode: full scan reports worktree + history as two distinct labeled checks" {
  require_ga_repo
  run bash "${SCANNER}"
  [[ "${output}" == *"check 1/2: worktree-clean"* ]]
  [[ "${output}" == *"check 2/2: history-clean"* ]]
}

@test "tracked mode: history-FAIL sets exit bit 4 independently of worktree bit 1" {
  # Asserts the exit-bit combination (minimal environment coupling): history FAIL
  #   sets bit 4 ON, worktree PASS keeps bit 1 OFF → verifies the two checks
  #   report independently. With the approved-identifier allowlist applied, this
  #   repo's expected state is history PASS — the combination assertion still
  #   holds in an environment where a non-approved identifier entered history
  #   (the bit is checked only on the FAIL branch).
  require_ga_repo
  run bash "${SCANNER}"
  if [[ "${output}" == *"history-clean: FAIL"* ]]; then
    # bit 4 set
    [[ $((status & 4)) -eq 4 ]]
  else
    [[ "${output}" == *"history-clean: PASS"* ]]
  fi
  # worktree is clean either way → bit 1 must be clear
  [[ $((status & 1)) -eq 0 ]]
}

@test "tracked mode: --worktree-only rejects directory arguments (exit 2 loud-fail)" {
  run bash "${SCANNER}" --worktree-only "${WORK}"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"--worktree-only is tracked-mode only"* ]]
}

# ---------------------------------------------------------------------------
# history-scan mechanism (isolated repo — GA-state-independent contract)
# ---------------------------------------------------------------------------

@test "history scan: PII removed from worktree but present in history -> worktree PASS + history FAIL (exit 4)" {
  # Synthesizes a history-only leak in an isolated repo — the worktree is clean
  #   but $HOME remains in history; asserts worktree (bit 1) clear + history
  #   (bit 4) set. Patterns derive from the running machine, so the fixture is
  #   synthesized from the runtime $HOME too (hardcoding forbidden).
  command -v git >/dev/null 2>&1 || skip "git not found"
  local repo="${WORK}/hist-repo"
  mkdir -p "${repo}"
  git -C "${repo}" init -q
  git -C "${repo}" config user.email "test@example.invalid"
  git -C "${repo}" config user.name "Test"
  # commit 1: introduce the PII into a tracked file
  printf 'log_root = "%s/logs"\n' "${HOME}" >"${repo}/cfg.txt"
  git -C "${repo}" add cfg.txt
  git -C "${repo}" commit -qm "add cfg with home path"
  # commit 2: scrub the PII from the worktree (history still retains it)
  printf 'log_root = "/var/log/app"\n' >"${repo}/cfg.txt"
  git -C "${repo}" add cfg.txt
  git -C "${repo}" commit -qm "scrub home path"

  # GA_ROOT is anchored to the script location (dirname/..), independent of cwd —
  #   to inject the isolated repo as GA_ROOT, copy the script into
  #   ${repo}/scripts/ and run it from there.
  mkdir -p "${repo}/scripts"
  cp "${SCANNER}" "${repo}/scripts/pii-scan.sh"
  run bash "${repo}/scripts/pii-scan.sh"
  [[ "${output}" == *"worktree-clean: PASS"* ]]
  [[ "${output}" == *"history-clean: FAIL"* ]]
  [[ $((status & 4)) -eq 4 ]]
  [[ $((status & 1)) -eq 0 ]]
}

# ---------------------------------------------------------------------------
# approved-disclosure allowlist (D1-R2 — maintainer identifiers, disclosure decision 2026-07-20)
# ---------------------------------------------------------------------------

@test "approved ids: USER seam — maintainer username/home-path skipped with note (exit 0)" {
  # Uses the approved-identifier literal — the allowlist is an exact-match constant, so only the same literal can verify it.
  export USER="bettep"
  printf 'owner: bettep\nhome = "/Users/bettep"\n' >"${WORK}/approved.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${output}" == *"worktree-clean: PASS"* ]]
  # The last assertion is compound — bash 3.2 bats ignores mid-test assertion
  #   failures (errexit does not propagate), so the decisive gates are combined
  #   into the single final command.
  [[ "${status}" -eq 0 && "${output}" == *"approved-disclosure identifier skipped"* ]]
}

@test "approved ids: git-config seam — maintainer email skipped in worktree AND history (exit 0)" {
  # Verifies the email seam in an isolated repo — even with the approved email in
  #   both worktree and history, the pattern is excluded at collection time, so
  #   both checks PASS.
  command -v git >/dev/null 2>&1 || skip "git not found"
  local repo="${WORK}/approved-email-repo"
  mkdir -p "${repo}"
  git -C "${repo}" init -q
  git -C "${repo}" config user.email "hongdaesik88@gmail.com"
  git -C "${repo}" config user.name "Maintainer"
  printf 'contact = "hongdaesik88@gmail.com"\n' >"${repo}/cfg.txt"
  git -C "${repo}" add cfg.txt
  git -C "${repo}" commit -qm "add contact"
  mkdir -p "${repo}/scripts"
  cp "${SCANNER}" "${repo}/scripts/pii-scan.sh"
  run bash "${repo}/scripts/pii-scan.sh"
  [[ "${output}" == *"approved-disclosure identifier skipped"* ]]
  [[ "${output}" == *"worktree-clean: PASS"* ]]
  # Compound final assertion — works around bash 3.2 bats ignoring mid-test assertions (see approved USER seam)
  [[ "${status}" -eq 0 && "${output}" == *"history-clean: PASS"* ]]
}

@test "foreign email via git-config seam -> worktree bit1 + history bit4 (exit 5)" {
  # A non-approved identifier still FAILs both checks as before — pins that the
  #   allowlist does not globally relax the gate.
  command -v git >/dev/null 2>&1 || skip "git not found"
  local repo="${WORK}/foreign-email-repo"
  mkdir -p "${repo}"
  git -C "${repo}" init -q
  git -C "${repo}" config user.email "contributor@example.invalid"
  git -C "${repo}" config user.name "Contributor"
  printf 'contact = "contributor@example.invalid"\n' >"${repo}/cfg.txt"
  git -C "${repo}" add cfg.txt
  git -C "${repo}" commit -qm "add contact"
  mkdir -p "${repo}/scripts"
  cp "${SCANNER}" "${repo}/scripts/pii-scan.sh"
  run bash "${repo}/scripts/pii-scan.sh"
  [[ "${output}" == *"worktree-clean: FAIL"* ]]
  # Compound final assertion — works around bash 3.2 bats ignoring mid-test assertions (see approved USER seam)
  [[ "${status}" -eq 5 && "${output}" == *"history-clean: FAIL"* ]]
}

@test "approved ids: exact-match only — near-miss username still flagged (exit 1)" {
  # Pins no partial/prefix matching — even one extra character on the approved literal stays scanned.
  local u_tail="2"
  export USER="bettep${u_tail}"
  printf 'owner: %s\n' "${USER}" >"${WORK}/near-miss.txt"
  run bash "${SCANNER}" "${WORK}"
  # Compound final assertion — works around bash 3.2 bats ignoring mid-test assertions (see approved USER seam)
  [[ "${status}" -eq 1 && "${output}" == *"near-miss.txt"* ]]
}
