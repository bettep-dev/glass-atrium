#!/usr/bin/env bats
# validate-scope-drift.sh — `[SCOPE]` declaration source suite (second allowed-path source).
#
# Pins: union semantics across the two sources, the payload source field that tells them apart,
# the record-0 pin that keeps a child from widening its own declaration, the per-agent cache
# (shape shared with the plan-doc cache), and the single lib-level definition of the predicate.
# Hermetic: HOME redirected under mktemp, curl shimmed to fail so the plan-doc leg stays inert.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
HOOK="${GA}/hooks/validate-scope-drift.sh"

setup() {
  [[ -f "${HOOK}" ]] || skip "hook not found: ${HOOK}"
  WORK="$(mktemp -d -t scope-drift-decl.XXXXXX)"
  SHIMBIN="${WORK}/bin"
  CACHE_DIR="${WORK}/cache"
  SID="sess-decl-test"
  AID="agent-decl-1"
  TDIR="${WORK}/.claude/projects/p1/${SID}/subagents"
  TPATH="${TDIR}/agent-${AID}.jsonl"
  mkdir -p "${SHIMBIN}" "${TDIR}"

  # No monitor in the loop: a failing curl keeps the plan-doc leg fail-open and silent.
  printf '%s\n' '#!/usr/bin/env bash' 'exit 22' >"${SHIMBIN}/curl"
  chmod +x "${SHIMBIN}/curl"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Write the subagent transcript. $1 = record-0 (parent delegation prompt) text,
# remaining args = extra assistant records appended after it.
seed_transcript() {
  local first="${1}"
  shift
  jq -cn --arg t "${first}" '{type:"user", message:{role:"user", content:$t}}' >"${TPATH}"
  local extra
  for extra in "$@"; do
    jq -cn --arg t "${extra}" \
      '{type:"assistant", message:{role:"assistant", content:[{type:"text", text:$t}]}}' >>"${TPATH}"
  done
}

# Fire the hook for one edit target. $2 (optional) = PLAN_FILE path.
run_hook() {
  local fp="${1}" plan="${2:-}" input
  input="$(jq -n --arg sid "${SID}" --arg aid "${AID}" --arg fp "${fp}" \
    '{session_id: $sid, agent_id: $aid, tool_input: {file_path: $fp}}')"
  run env -u PLAN_FILE \
    HOME="${WORK}" \
    ATRIUM_MONITOR_PORT=16145 \
    SCOPE_DRIFT_CACHE_DIR="${CACHE_DIR}" \
    PLAN_FILE="${plan}" \
    PATH="${SHIMBIN}:${PATH}" \
    bash -c 'bash "$0" 2>&1' "${HOOK}" <<<"${input}"
}

@test "declared file outside [SCOPE] files= → SCOPE-070 advisory, non-blocking, source=scope-decl" {
  seed_transcript '[SCOPE] files=hooks/a.sh, hooks/b.sh · deliverable=x · out=y'
  run_hook "/repo/hooks/other.sh"
  [[ "${status}" -eq 0 ]] || { echo "blocking exit ${status}" >&2; return 1; }
  [[ "${output}" == *SCOPE-070* ]] && [[ "${output}" == *scope-decl* ]] \
    || { echo "missing scope-decl advisory: ${output}" >&2; return 1; }
}

@test "file inside [SCOPE] files= → silent (union: either source may allow the edit)" {
  seed_transcript '[SCOPE] files=hooks/a.sh, hooks/b.sh'
  run_hook "/repo/hooks/b.sh"
  [[ "${status}" -eq 0 ]] && [[ "${output}" != *SCOPE-070* ]] \
    || { echo "false advisory on declared path: ${output}" >&2; return 1; }
}

@test "plan-doc source keeps its own payload label (sources are distinguishable)" {
  seed_transcript 'no declaration in this delegation'
  printf '%s\n' '## Target Files' '- hooks/a.sh' >"${WORK}/plan.md"
  run_hook "/repo/hooks/other.sh" "${WORK}/plan.md"
  [[ "${output}" == *SCOPE-070* ]] && [[ "${output}" == *plan-doc* ]] && [[ "${output}" != *scope-decl* ]] \
    || { echo "plan-doc payload label wrong: ${output}" >&2; return 1; }
}

@test "record-0 pin: a child-emitted wider [SCOPE] line cannot nullify the check" {
  seed_transcript '[SCOPE] files=hooks/a.sh' '[SCOPE] files=hooks/, src/, everything'
  run_hook "/repo/hooks/other.sh"
  [[ "${output}" == *SCOPE-070* ]] \
    || { echo "self-nullified by child declaration: ${output}" >&2; return 1; }
}

@test "declaration is cached per agent_id; bypass env forces a re-resolve" {
  seed_transcript '[SCOPE] files=hooks/a.sh'
  run_hook "/repo/hooks/other.sh"
  [[ "${output}" == *SCOPE-070* ]] || { echo "first pass silent: ${output}" >&2; return 1; }

  # Transcript removed: a cache hit still yields the same verdict (no re-parse per edit).
  rm -f "${TPATH}"
  run_hook "/repo/hooks/other.sh"
  [[ "${output}" == *scope-decl* ]] || { echo "cache miss — re-parsed: ${output}" >&2; return 1; }

  SCOPE_DRIFT_CACHE_BYPASS=1 run_hook "/repo/hooks/other.sh"
  [[ "${output}" != *scope-decl* ]] || { echo "bypass ignored the missing transcript: ${output}" >&2; return 1; }
}

@test "the comparison predicate is defined once, in lib/, and both consumers source it" {
  local defs
  defs="$(grep -rlF --include='*.sh' 'match_file_against_allowed() {' "${GA}/hooks" | wc -l | tr -d '[:space:]')"
  [[ "${defs}" -eq 1 ]] || { echo "predicate defined in ${defs} files, want 1" >&2; return 1; }
  grep -qF 'match_file_against_allowed() {' "${GA}/hooks/lib/scope-match.sh" \
    || { echo "predicate not in lib/scope-match.sh" >&2; return 1; }
  grep -qF 'lib/scope-match.sh' "${GA}/hooks/validate-scope-drift.sh" \
    && grep -qF 'lib/scope-match.sh' "${GA}/hooks/track-outcome.sh" \
    || { echo "a consumer does not source the lib" >&2; return 1; }
}
