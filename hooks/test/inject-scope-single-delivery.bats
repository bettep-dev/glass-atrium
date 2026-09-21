#!/usr/bin/env bats
# inject-scope-single-delivery.bats — exactly-once pin over everything one spawn assembles.
#
#   One spawn runs slot 1 (inject-scope-rules.sh) plus parts 01..11 (inject-scope-part-NN.sh). The
#   blocks slot 1 no longer extracts reach an agent only through its registry membership, so each
#   block's needle must occur EXACTLY ONCE for a member of its source file and ZERO times otherwise;
#   each kept slot-1 block must occur exactly once for its roster. Expected sets come from the
#   registry, the hook's roster declarations and agent frontmatter — never from a roster literal.
#
#   HOST INVARIANCE: counts only. No byte size, part count or part index is asserted — the rendered
#   part headers carry the rules root path, so packing moves with the root's length.
#
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` is inert on bash 3.2.57
#   but GATES on CI's bash 5.3.9. Every check below collects failures and ends in a guarded
#   `return 1`, so each one fails on both legs.

# shellcheck disable=SC2154  # BATS_TEST_DIRNAME / BATS_FILE_TMPDIR are assigned by the bats runner
HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
SLOT1_HOOK="${HOOKS_DIR}/inject-scope-rules.sh"
CORE="${HOOKS_DIR}/lib/inject_chunk.py"
REGISTRY_SRC="${REPO_ROOT}/agent-registry.json"
AGENTS_DIR="${REPO_ROOT}/agents"
BUDGET_SRC="${REPO_ROOT}/scoped/shared-turn-budget.md"
WIKI_UNTRUSTED_SRC="${REPO_ROOT}/rules/glass-atrium/core-wiki-reference.md"

# Retired blocks: `<source>|<anchor>`. The anchor locates ONE line in the source; that whole line
# is the needle, so a reworded lead is followed rather than silently counting zero. PLAN-GATE's
# block text is gone — its clauses live in the Plan Direction Verification Gate section, and the
# non-waiver bullet is the one line of that section no other file carries.
RETIRED_BLOCKS=(
  "scoped/shared-comment-logging.md|**Comment-rule core"
  "scoped/scope-dev.md|**style_ref emit"
  "scoped/scope-dev.md|**Minimalism reflex"
  "scoped/shared-naming.md|**Naming delta-core"
  "scoped/scope-dev.md|**Non-waiver (binding on YOU"
)
# Slot-1 leftovers that must reach no agent: the retired marker labels and the deleted plan-gate lead.
RETIRED_LEFTOVERS=(
  "AGENT-INJECT:START"
  "AGENT-INJECT:STYLE-REF"
  "AGENT-INJECT:MINIMALISM"
  "AGENT-INJECT:NAMING"
  "AGENT-INJECT:PLAN-GATE"
  "Plan-gate verdict"
)

EMIT_NEEDLE="REQUIRED by the outcome recorder"
METER_NEEDLE="Turn-budget meter"
BUDGET_DEV_NEEDLE="Budget sizing (auto-injected DEV"
BUDGET_ANALYSIS_NEEDLE="Budget sizing (auto-injected analysis"
WIKI_UNTRUSTED_NEEDLE="Wiki raw-store untrusted-data clause"
LESSON_NEEDLE="Prior-lesson recall"
LESSON_AGENT="glass-atrium-dev-front"

# Non-overlapping occurrences of fixed string $1 in file $2. `grep -o` rather than a bash pattern
# substitution: the substitution is quadratic on bash 3.2 over a ~40 KB assembly.
count_in() {
  local count
  count="$(grep -oF -- "${1}" "${2}" | wc -l | tr -cd '0-9' || true)"
  printf '%s' "${count:-0}"
}

# Roster string declared by the hook for array $1 (space-padded, as the hook matches it).
get_roster() {
  sed -n "s/^readonly ${1}=\"\\(.*\\)\"\$/\\1/p" "${SLOT1_HOOK}"
}

# Whole source line carrying retired-block anchor $2 in source $1.
get_needle() {
  grep -F -- "${2}" "${REPO_ROOT}/${1}"
}

# Append a mismatch to the caller's `bad` when agent $1's assembly carries needle $2 other than $3 times.
check_count() {
  local count
  count="$(count_in "${2}" "${ASM_DIR}/${1}.txt")"
  if [[ "${count}" != "${3}" ]]; then
    bad="${bad}${1}: '${2}' ${count}x, expected ${3}\n"
  fi
}

# check_count with the expectation derived from roster $3 (space-padded): 1 for a member, else 0.
check_roster_count() {
  if [[ "${3}" == *" ${1} "* ]]; then
    check_count "${1}" "${2}" 1
  else
    check_count "${1}" "${2}" 0
  fi
}

# Run one slot for agent $1 with lesson store $2 and drop log $3; stdout = that slot's context.
get_slot_ctx() {
  local agent="${1}" lessons="${2}" droplog="${3}" slot="${4}" payload out
  payload="$(jq -nc --arg a "${agent}" '{hook_event_name:"SubagentStart",agent_type:$a}')"
  # Slots are fail-open by contract, so a non-zero exit is not a verdict — the counts are.
  out="$(env -u SUBAGENT_BUDGET_METER_OFF -u GA_DATA_ROOT -u GA_CHUNK_REGISTRY -u GA_CHUNK_PART \
    -u GA_CHUNK_SLOTS -u GA_CHUNK_MAX_UNITS -u GA_CHUNK_RESERVE -u GA_CHUNK_CORE \
    -u INJECT_SCOPE_RULES_CTX_MAX_BYTES \
    HOME="${SANDBOX_HOME}" \
    GA_CHUNK_RULES_ROOT="${RULES_ROOT}" \
    GA_CHUNK_SINK="${CHUNK_SINK}" \
    INJECT_SCOPE_RULES_BUDGET_SRC="${BUDGET_SRC}" \
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${WIKI_UNTRUSTED_SRC}" \
    INJECT_SCOPE_RULES_AGENTS_DIR="${AGENTS_DIR}" \
    INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
    INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
    INJECT_SCOPE_RULES_SPAWN_COUNTER="${BATS_FILE_TMPDIR}/spawns.count" \
    INJECT_SCOPE_RULES_MANIFEST_LOG="${BATS_FILE_TMPDIR}/manifest.log" \
    bash "${slot}" <<<"${payload}" 2>/dev/null || true)"
  jq -Rj 'fromjson? | .hookSpecificOutput.additionalContext? // empty' <<<"${out}"
}

# Join all twelve slots for agent $1 into file $4 — what one spawn hands the model.
build_assembly() {
  local agent="${1}" lessons="${2}" droplog="${3}" out="${4}" slot ctx
  : >"${out}"
  for slot in "${SLOT1_HOOK}" "${HOOKS_DIR}"/inject-scope-part-[0-9][0-9].sh; do
    ctx="$(get_slot_ctx "${agent}" "${lessons}" "${droplog}" "${slot}")"
    if [[ -n "${ctx}" ]]; then
      printf '%s\n\n' "${ctx}" >>"${out}"
    fi
  done
}

setup_file() {
  local required agent repo_abs
  for required in "${SLOT1_HOOK}" "${CORE}" "${REGISTRY_SRC}" "${AGENTS_DIR}" "${BUDGET_SRC}" \
    "${WIKI_UNTRUSTED_SRC}" "${HOOKS_DIR}/inject-scope-part-01.sh"; do
    [[ -e "${required}" ]] || {
      printf 'pin target absent: %s — the repository always ships it\n' "${required}" >&2
      return 1
    }
  done
  command -v jq >/dev/null 2>&1 || {
    printf 'jq not on PATH — slot 1 cannot run\n' >&2
    return 1
  }
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 not on PATH — the part slots cannot run\n' >&2
    return 1
  }

  export RULES_ROOT="${BATS_FILE_TMPDIR}/root"
  export SANDBOX_HOME="${BATS_FILE_TMPDIR}/home"
  export CHUNK_SINK="${BATS_FILE_TMPDIR}/chunk.diag.log"
  export ASM_DIR="${BATS_FILE_TMPDIR}/asm"
  export LESSON_STORE="${BATS_FILE_TMPDIR}/lessons.json"
  mkdir -p "${RULES_ROOT}" "${SANDBOX_HOME}" "${ASM_DIR}"
  repo_abs="$(cd "${REPO_ROOT}" && pwd)"
  ln -s "${repo_abs}/scoped" "${RULES_ROOT}/scoped"
  cp "${REGISTRY_SRC}" "${RULES_ROOT}/agent-registry.json"

  jq -r '.agents | keys[]' "${RULES_ROOT}/agent-registry.json" >"${ASM_DIR}/agents.txt"
  jq -r '[.agents[].rules // {} | (.scope // empty), (.shared // [])[]]
    | unique[] | select(startswith("scoped/"))' \
    "${RULES_ROOT}/agent-registry.json" >"${ASM_DIR}/member-files.txt"
  while IFS= read -r agent; do
    jq -r --arg a "${agent}" '.agents[$a].rules // {} | (.scope // empty), (.shared // [])[]' \
      "${RULES_ROOT}/agent-registry.json" >"${ASM_DIR}/${agent}.members"
    build_assembly "${agent}" /nonexistent "${ASM_DIR}/${agent}.drop" "${ASM_DIR}/${agent}.txt"
  done <"${ASM_DIR}/agents.txt"

  python3 -c '
import json, sys
json.dump({"ctm": [{"agent": sys.argv[2], "task_type": "bug-fix", "text": "SINGLE_LESSON_ENTRY",
                    "score": 5, "frequency": 9}], "epm": []}, open(sys.argv[1], "w"))
' "${LESSON_STORE}" "${LESSON_AGENT}"
  build_assembly "${LESSON_AGENT}" "${LESSON_STORE}" "${ASM_DIR}/lesson.drop" "${ASM_DIR}/lesson.txt"
}

@test "every registry agent packs with events=none, over exactly the slots the wrappers bind" {
  local audit wrappers slots agents lines bad
  audit="$(GA_CHUNK_RULES_ROOT="${RULES_ROOT}" GA_CHUNK_SINK="${CHUNK_SINK}" python3 "${CORE}" --audit)" || {
    printf 'audit exited non-zero\n' >&2
    return 1
  }
  set -- "${HOOKS_DIR}"/inject-scope-part-[0-9][0-9].sh
  wrappers="${#}"
  slots="$(sed -n 's/.* slots=\([0-9]*\) .*/\1/p' <<<"${audit}")"
  agents="$(grep -c '' "${ASM_DIR}/agents.txt" || true)"
  lines="$(grep -c '^agent=' <<<"${audit}" || true)"
  bad="$(grep '^agent=' <<<"${audit}" | grep -v ' events=none$' || true)"
  [[ "${wrappers}" == "${slots}" && "${lines}" == "${agents}" && -z "${bad}" ]] || {
    printf 'wrappers=%s slots=%s audited=%s registry=%s\nevents:\n%s\n' \
      "${wrappers}" "${slots}" "${lines}" "${agents}" "${bad}" >&2
    return 1
  }
}

@test "each retired needle is one line of its source and occurs in no other member file" {
  local entry src anchor needle lines member count total bad=""
  for entry in "${RETIRED_BLOCKS[@]}"; do
    src="${entry%%|*}"
    anchor="${entry#*|}"
    lines="$(grep -cF -- "${anchor}" "${REPO_ROOT}/${src}" || true)"
    if [[ "${lines}" != "1" ]]; then
      bad="${bad}anchor '${anchor}' on ${lines:-0} lines of ${src}\n"
      continue
    fi
    needle="$(get_needle "${src}" "${anchor}")"
    total=0
    while IFS= read -r member; do
      count="$(count_in "${needle}" "${REPO_ROOT}/${member}")"
      total=$((total + count))
      if [[ "${member}" == "${src}" && "${count}" != "1" ]]; then
        bad="${bad}'${anchor}' occurs ${count}x in its source ${src}\n"
      fi
    done <"${ASM_DIR}/member-files.txt"
    if [[ "${total}" != "1" ]]; then
      bad="${bad}'${anchor}' occurs ${total}x across all member files\n"
    fi
  done
  [[ -z "${bad}" ]] || {
    printf '%b' "${bad}" >&2
    return 1
  }
}

@test "retired blocks: exactly once for a member of the source file, zero for every other agent" {
  local entry src anchor needle agent bad=""
  for entry in "${RETIRED_BLOCKS[@]}"; do
    src="${entry%%|*}"
    anchor="${entry#*|}"
    needle="$(get_needle "${src}" "${anchor}")"
    while IFS= read -r agent; do
      if grep -qxF -- "${src}" "${ASM_DIR}/${agent}.members"; then
        check_count "${agent}" "${needle}" 1
      else
        check_count "${agent}" "${needle}" 0
      fi
    done <"${ASM_DIR}/agents.txt"
  done
  [[ -z "${bad}" ]] || {
    printf '%b' "${bad}" >&2
    return 1
  }
}

@test "retired slot-1 marker labels and the deleted plan-gate lead reach no agent" {
  local agent leftover bad=""
  while IFS= read -r agent; do
    for leftover in "${RETIRED_LEFTOVERS[@]}"; do
      check_count "${agent}" "${leftover}" 0
    done
  done <"${ASM_DIR}/agents.txt"
  [[ -z "${bad}" ]] || {
    printf '%b' "${bad}" >&2
    return 1
  }
}

@test "kept blocks: emit once everywhere, meter once above the floor, rostered blocks once for members only" {
  local floor budget_dev budget_analysis wiki agent turns bad=""
  floor="$(sed -n 's/^readonly METER_MIN_MAX_TURNS=\([0-9]*\)$/\1/p' "${SLOT1_HOOK}")"
  budget_dev="$(get_roster BUDGET_DEV_AGENTS)"
  budget_analysis="$(get_roster BUDGET_ANALYSIS_AGENTS)"
  wiki="$(get_roster WIKI_UNTRUSTED_AGENTS)"
  [[ -n "${floor}" && -n "${budget_dev// /}" && -n "${budget_analysis// /}" && -n "${wiki// /}" ]] || {
    printf 'hook declarations unreadable: floor=%s dev=%s analysis=%s wiki=%s\n' \
      "${floor}" "${budget_dev}" "${budget_analysis}" "${wiki}" >&2
    return 1
  }
  while IFS= read -r agent; do
    turns="$(grep -m1 '^maxTurns:' "${AGENTS_DIR}/${agent}.md" | tr -cd '0-9' || true)"
    check_count "${agent}" "${EMIT_NEEDLE}" 1
    if [[ -n "${turns}" && "${turns}" -ge "${floor}" ]]; then
      check_count "${agent}" "${METER_NEEDLE}" 1
    else
      check_count "${agent}" "${METER_NEEDLE}" 0
    fi
    check_roster_count "${agent}" "${BUDGET_DEV_NEEDLE}" "${budget_dev}"
    check_roster_count "${agent}" "${BUDGET_ANALYSIS_NEEDLE}" "${budget_analysis}"
    check_roster_count "${agent}" "${WIKI_UNTRUSTED_NEEDLE}" "${wiki}"
    check_count "${agent}" "${LESSON_NEEDLE}" 0
  done <"${ASM_DIR}/agents.txt"
  [[ -z "${bad}" ]] || {
    printf '%b' "${bad}" >&2
    return 1
  }
}

@test "no slot sheds and no part warns for any agent" {
  local agent rows=""
  while IFS= read -r agent; do
    if [[ -s "${ASM_DIR}/${agent}.drop" ]]; then
      rows="${rows}${agent} drop sink: $(<"${ASM_DIR}/${agent}.drop")\n"
    fi
  done <"${ASM_DIR}/agents.txt"
  if [[ -s "${CHUNK_SINK}" ]]; then
    rows="${rows}chunk sink: $(<"${CHUNK_SINK}")\n"
  fi
  [[ -z "${rows}" ]] || {
    printf '%b' "${rows}" >&2
    return 1
  }
}

@test "one-entry lesson store: dev-front receives the lesson once, retired blocks stay once, drop sink empty" {
  local entry src anchor needle bad=""
  check_count lesson "${LESSON_NEEDLE}" 1
  check_count lesson "- [bug-fix] SINGLE_LESSON_ENTRY" 1
  check_count lesson "Injection shed" 0
  for entry in "${RETIRED_BLOCKS[@]}"; do
    src="${entry%%|*}"
    anchor="${entry#*|}"
    if grep -qxF -- "${src}" "${ASM_DIR}/${LESSON_AGENT}.members"; then
      needle="$(get_needle "${src}" "${anchor}")"
      check_count lesson "${needle}" 1
    fi
  done
  if [[ -s "${ASM_DIR}/lesson.drop" ]]; then
    bad="${bad}drop sink written: $(<"${ASM_DIR}/lesson.drop")\n"
  fi
  [[ -z "${bad}" ]] || {
    printf '%b' "${bad}" >&2
    return 1
  }
}
