#!/usr/bin/env bats
# autoagents-eval.sh git-status failure suite (doc-739 T2 category-3 adjudication).
# Pins that a GENUINE git failure on the default/manual path loud-fails (captured
# git stderr + named exit 5) instead of collapsing into the empty filter result
# and the affirmative-false "no changes — exit" success. Under pipefail the old
# single pipeline reported the RIGHTMOST status, so a trailing grep no-match (1)
# was indistinguishable from a git 128 — that indistinguishability is the defect.
# Row 1 FAILS at HEAD (exit 0, silent); rows 2-4 are unchanged-green guards for
# the legitimate no-match path, the changed-file data path, and the mode-2
# (--unstaged) runner contract the conversion must not touch.
#
# Assertion idiom: `[[ ... ]] || return 1`. Bats does NOT catch a bare non-final
# `[[ ]]` failure, so every assertion is routed through `|| return 1`.
#
# Hermetic: a per-test fake HOME supplies both the AGENTS_DIR the script cd's
# into and the sourced llm-preflight stub, so nothing under the live tree is read
# or written. The git failure is produced by the real git against a NON-repo
# sandbox (GIT_CEILING_DIRECTORIES stops the upward discovery walk) — no PATH
# shim, which would lose to the script's own /opt/homebrew/bin PATH prepend.
#
# Run via: bats autoagent/test/autoagents-eval-git-status-failure.bats
# Requires: bats >= 1.5.0, bash 3.2+, git

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/autoagents-eval.sh"

# make_sandbox — fake HOME with $1 = repo|norepo deciding whether the agents dir
# is a git work tree. The preflight stub always REFUSES: every row that gets past
# the git-status block must stop at a deterministic seam, never at a real LLM.
make_sandbox() {
  local kind="${1}"
  FAKE_HOME="${BATS_TEST_TMPDIR}/home-${kind}"
  AGENTS="${FAKE_HOME}/.claude/agents"
  mkdir -p "${AGENTS}" "${FAKE_HOME}/.glass-atrium/scripts"
  cat >"${FAKE_HOME}/.glass-atrium/scripts/llm-preflight.sh" <<'STUB'
llm_preflight() {
  echo "stubbed preflight refusal"
  return 1
}
STUB
  CLAUDE_STUB="${FAKE_HOME}/claude-stub"
  printf '%s\n' '#!/bin/sh' 'echo "RESULT: PASS"' >"${CLAUDE_STUB}"
  chmod +x "${CLAUDE_STUB}"
  if [[ "${kind}" == "repo" ]]; then
    git -C "${AGENTS}" init -q
    git -C "${AGENTS}" config user.email "t@e.st"
    git -C "${AGENTS}" config user.name "t"
  fi
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "autoagents-eval.sh absent"
}

@test "git status failure loud-fails with exit 5 and the captured git stderr" {
  make_sandbox norepo
  run --separate-stderr -5 env \
    HOME="${FAKE_HOME}" \
    GIT_CEILING_DIRECTORIES="${BATS_TEST_TMPDIR}" \
    AUTOAGENTS_EVAL_CLAUDE_BIN="${CLAUDE_STUB}" \
    bash "${REAL_SCRIPT}"
  [[ "${stderr}" == *"git status failed"* ]] || return 1
  [[ "${stderr}" == *"not a git repository"* ]] || return 1
  [[ "${output}" != *"no changes"* ]] || return 1
}

@test "legitimate no-match keeps the quiet no-changes exit 0" {
  make_sandbox repo
  run --separate-stderr -0 env \
    HOME="${FAKE_HOME}" \
    GIT_CEILING_DIRECTORIES="${BATS_TEST_TMPDIR}" \
    AUTOAGENTS_EVAL_CLAUDE_BIN="${CLAUDE_STUB}" \
    bash "${REAL_SCRIPT}"
  [[ -z "${output}" ]] || return 1
  [[ "${stderr}" != *"git status failed"* ]] || return 1
}

@test "a changed .md still reaches the eval path" {
  make_sandbox repo
  printf 'x\n' >"${AGENTS}/t2-probe.md"
  run --separate-stderr -1 env \
    HOME="${FAKE_HOME}" \
    GIT_CEILING_DIRECTORIES="${BATS_TEST_TMPDIR}" \
    AUTOAGENTS_EVAL_CLAUDE_BIN="${CLAUDE_STUB}" \
    bash "${REAL_SCRIPT}"
  [[ "${output}" == *"RESULT: FAIL"* ]] || return 1
  [[ "${output}" == *"LLM preflight failed"* ]] || return 1
}

@test "mode-2 --unstaged path is untouched by the conversion" {
  make_sandbox norepo
  run --separate-stderr -1 env \
    HOME="${FAKE_HOME}" \
    GIT_CEILING_DIRECTORIES="${BATS_TEST_TMPDIR}" \
    AUTOAGENTS_EVAL_CLAUDE_BIN="${CLAUDE_STUB}" \
    bash "${REAL_SCRIPT}" --unstaged "t2-probe.md"
  [[ "${output}" == *"RESULT: FAIL"* ]] || return 1
  [[ "${stderr}" != *"git status failed"* ]] || return 1
}
