#!/usr/bin/env bats
# autoagents-eval.sh verdict and FAIL report on an eval output larger than one pipe buffer.
# An early-exit reader (grep -q, head) fed such an output stops while its writer still holds
# data, so under pipefail a reader-pipe verdict or report takes SIGPIPE 141 — these rows force that size.
#
# Hermetic: a per-test fake HOME supplies the agents dir, the path guard and the preflight and
# config stubs, and a stub claude prints the eval output. The script's own daily log stays in /tmp.
#
# Run via: bats autoagent/test/autoagents-eval-verdict.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/autoagents-eval.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "autoagents-eval.sh absent"
  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  AGENTS="${FAKE_HOME}/.claude/agents"
  mkdir -p "${AGENTS}" "${FAKE_HOME}/.glass-atrium/scripts/lib"
  cp -p -- "${GA}/scripts/lib/path-guard.sh" "${FAKE_HOME}/.glass-atrium/scripts/lib/path-guard.sh"
  printf '%s\n' 'llm_preflight() { echo "stub preflight ok"; }' \
    >"${FAKE_HOME}/.glass-atrium/scripts/llm-preflight.sh"
  printf '%s\n' 'atrium_resolve_worker_model() { printf "stub-model"; }' \
    >"${FAKE_HOME}/.glass-atrium/scripts/lib/atrium-config.sh"
  EVAL_OUTPUT="${BATS_TEST_TMPDIR}/eval-output.txt"
  CLAUDE_STUB="${FAKE_HOME}/claude-stub"
  printf '%s\n' '#!/bin/sh' "cat \"${EVAL_OUTPUT}\"" >"${CLAUDE_STUB}"
  chmod +x "${CLAUDE_STUB}"
  git -C "${AGENTS}" init -q
  printf 'x\n' >"${AGENTS}/probe.md"
}

# write_eval_output VERDICT LEAD SHAPE — the prompt's line layout with LEAD as the first ISSUES
# line, then about 1 MB more ISSUES text: SHAPE=lines (many short lines) or SHAPE=wide (two long
# lines, keeping the section under the report's 15- and 20-line caps).
write_eval_output() {
  awk -v verdict="${1}" -v lead="${2}" -v shape="${3}" 'BEGIN {
    print "RESULT: " verdict
    print "FILES_CHECKED: probe.md"
    print "ISSUES:"
    print lead
    if (shape == "lines") {
      for (i = 1; i <= 20000; i++) printf "- probe.md: note %d, the wording could be tighter\n", i
    } else {
      wide = "x"
      while (length(wide) < 500000) wide = wide wide
      for (i = 1; i <= 2; i++) print "- probe.md: detail " wide
    }
    print "SUMMARY: probe run"
  }' >"${EVAL_OUTPUT}"
}

# run_eval MODE — the whole script against the sandbox; MODE=unstaged (runner flow) or default.
run_eval() {
  local mode="${1}"
  if [[ "${mode}" == "unstaged" ]]; then
    set -- --unstaged probe.md
  else
    set --
  fi
  run --separate-stderr env HOME="${FAKE_HOME}" GA_DATA_ROOT="${FAKE_HOME}/.glass-atrium" \
    GIT_CEILING_DIRECTORIES="${BATS_TEST_TMPDIR}" AUTOAGENTS_EVAL_CLAUDE_BIN="${CLAUDE_STUB}" \
    bash "${REAL_SCRIPT}" "$@"
}

# assert_eval_rows — loops ROWS ("mode|status|stdout glob"), one run_eval per row; prints the row
# name with a bounded head of the captured output on failure.
assert_eval_rows() {
  local row mode want_status want_glob
  for row in "${ROWS[@]}"; do
    IFS='|' read -r mode want_status want_glob <<<"${row}"
    run_eval "${mode}"
    [[ "${status}" -eq "${want_status}" ]] || {
      echo "${mode}: status ${status}, want ${want_status}; stdout head: ${output:0:300}; stderr: ${stderr}"
      return 1
    }
    # shellcheck disable=SC2053  # the row's third field is a glob by contract
    [[ "${output}" == ${want_glob} ]] || {
      echo "${mode}: stdout does not match ${want_glob}; head: ${output:0:300}"
      return 1
    }
  done
}

@test "a PASS that lists notes past one pipe buffer stays PASS in both modes" {
  write_eval_output PASS "None" lines
  ROWS=(
    'unstaged|0|RESULT: PASS*SUMMARY: probe run'
    'default|0|'
  )
  assert_eval_rows
}

@test "a FAIL whose issues run past one pipe buffer still exits 1 with its full report in both modes" {
  write_eval_output FAIL "- probe.md: the description key is missing" lines
  ROWS=(
    'unstaged|1|RESULT: FAIL*ISSUES:*description key is missing*DIAGNOSIS:*RECOMMENDATION: FIX_AND_RETRY'
    'default|1|'
  )
  assert_eval_rows
}

@test "a FAIL report keeps its DIAG-FIX hints when the issue text runs past one pipe buffer" {
  write_eval_output FAIL "- probe.md: Korean prose in the body and an unparseable YAML frontmatter" wide
  ROWS=(
    'unstaged|1|RESULT: FAIL*DIAG-FIX: language → Translate to English*DIAG-FIX: YAML → Fix structure*RECOMMENDATION:*'
  )
  assert_eval_rows
}
