#!/usr/bin/env bash
# reviewer-catch-rate.sh — planted-defect recall of glass-atrium-qa-code-reviewer at one effort tier.
# Recall only: a defect is caught when a severity-tagged finding of the relayed review matches its label pattern;
#   no gate reads the result.
# Usage: REVIEWER_CATCH_RATE_CLAUDE_BIN=<launcher> reviewer-catch-rate.sh --tier high|xhigh [--corpus DIR] [--out DIR]
#
# Route: a headless parent (`<launcher> -p --effort <tier>`, cwd $HOME) spawns one unnamed typed reviewer through
#   the Agent tool and relays its reply. `--agent` is never used: it runs the reviewer as the main session, without
#   the SubagentStart injections production reviewers get. On this manual unnamed path an unkeyed reviewer takes
#   the parent tier, and a frontmatter `effort:` key overrides it — hence exit 5 on a keyed definition.
# Launcher: required, no PATH fallback — the headless rule is `claude-work-dev -p` from $HOME, a zsh function,
#   so pass an executable wrapper such as `#!/bin/zsh -i` + `claude-work-dev "$@"`.
# Corpus: <name>.diff files + labels.tsv rows `<diff basename> TAB <defect id> TAB <ERE, matched case-insensitive>`.
# Install root: the live bundle omits the corpus (generate-manifest.sh → EXCLUDE_RE), so a run there needs --corpus.
# Leak residual: the repo checkout stays readable — a reply naming the corpus scores error; a silent read goes unseen.
#
# Exit codes (this script's own):
#   0 = every diff reviewed and scored · 1 = a launch failed, or its reply lacked the relay markers or named the corpus
#   2 = usage error · 3 = corpus invalid · 4 = launcher unset or not executable
#   5 = reviewer definition unreadable or carrying a frontmatter effort key · 6 = shared path guard missing
set -Eeuo pipefail
IFS=$'\n\t'
trap 'printf "reviewer-catch-rate: ERROR line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PATH_GUARD="${SCRIPT_DIR}/../scripts/lib/path-guard.sh"
readonly REVIEWER='glass-atrium-qa-code-reviewer'
readonly CID_SLUG='reviewer-corpus'
readonly CORPUS_NAME='reviewer-catch-rate'
readonly REPLY_BEGIN='REVIEWER-REPLY-BEGIN'
readonly REPLY_END='REVIEWER-REPLY-END'

if [[ ! -r "${PATH_GUARD}" ]]; then
  printf 'reviewer-catch-rate: cannot source the shared path guard: %s\n' "${PATH_GUARD}" >&2
  exit 6
fi
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${PATH_GUARD}"

TIER=''
CORPUS="${SCRIPT_DIR}/${CORPUS_NAME}"
OUT=''
LAUNCHER="${REVIEWER_CATCH_RATE_CLAUDE_BIN:-}"
STAGE_DIR=''
DIFFS=()
LABEL_DIFFS=()
LABEL_DEFECTS=()
LABEL_PATTERNS=()
CAUGHT=0
SCORED=0
ERRORS=0

main() {
  parse_args "$@"
  require_launcher
  load_corpus
  require_unkeyed_reviewer
  if [[ -n "${OUT}" ]]; then mkdir -p -- "${OUT}"; fi
  trap 'delete_stage_dir' EXIT
  STAGE_DIR="$(mktemp -d)"
  print_footprint
  run_corpus
}

die() {
  printf 'reviewer-catch-rate: %s\n' "${2}" >&2
  exit "${1}"
}

parse_args() {
  while (($# > 0)); do
    (($# >= 2)) || die 2 "${1}: missing value"
    case "${1}" in
      --tier) TIER="${2}" ;;
      --corpus) CORPUS="${2}" ;;
      --out) OUT="${2}" ;;
      *) die 2 "unknown argument: ${1}" ;;
    esac
    shift 2
  done
  case "${TIER}" in
    high | xhigh) ;;
    *) die 2 "--tier must be high or xhigh, the two reviewer arms stream 7 compares (got '${TIER}')" ;;
  esac
}

require_launcher() {
  [[ -n "${LAUNCHER}" ]] || die 4 'REVIEWER_CATCH_RATE_CLAUDE_BIN is unset: pass a launcher that runs claude-work-dev'
  [[ -f "${LAUNCHER}" && -x "${LAUNCHER}" ]] || die 4 "launcher is not an executable file: ${LAUNCHER}"
}

load_corpus() {
  local labels="${CORPUS}/labels.tsv"
  [[ -r "${labels}" ]] || die 3 "label file not readable: ${labels}"
  shopt -s nullglob
  DIFFS=("${CORPUS}"/*.diff)
  shopt -u nullglob
  ((${#DIFFS[@]} > 0)) || die 3 "no .diff file in ${CORPUS}"
  read_labels "${labels}"
  check_labels
}

# Fields split on \x1f, not TAB: a whitespace IFS would collapse an empty field and shift the rest.
read_labels() {
  local line n=0 diff defect pattern extra
  while IFS='' read -r line || [[ -n "${line}" ]]; do
    n=$((n + 1))
    if [[ "${line}" =~ ^[[:space:]]*(#|$) ]]; then continue; fi
    IFS=$'\x1f' read -r diff defect pattern extra <<<"${line//$'\t'/$'\x1f'}"
    [[ -n "${diff}" && -n "${defect}" && -n "${pattern}" && -z "${extra}" ]] \
      || die 3 "${1}:${n}: a label row needs exactly three non-empty TAB-separated fields"
    LABEL_DIFFS+=("${diff}")
    LABEL_DEFECTS+=("${defect}")
    LABEL_PATTERNS+=("${pattern}")
  done <"${1}"
}

# Every label names a corpus diff with a compilable pattern, and every diff carries a label.
check_labels() {
  local i rc diff
  for ((i = 0; i < ${#LABEL_DIFFS[@]}; i++)); do
    diff="${LABEL_DIFFS[i]}"
    [[ "${diff}" == *.diff && "${diff}" != */* && -f "${CORPUS}/${diff}" ]] || die 3 "label names no corpus diff: ${diff}"
    rc=0
    grep -Eq -e "${LABEL_PATTERNS[i]}" </dev/null || rc=$?
    ((rc < 2)) || die 3 "invalid ERE for ${diff} / ${LABEL_DEFECTS[i]}: ${LABEL_PATTERNS[i]}"
  done
  for diff in "${DIFFS[@]}"; do
    # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
    has_label "${diff##*/}" || die 3 "no label row for ${diff##*/}"
  done
}

has_label() {
  local i
  for ((i = 0; i < ${#LABEL_DIFFS[@]}; i++)); do
    [[ "${LABEL_DIFFS[i]}" != "${1}" ]] || return 0 # GA-ABSORB[benign]: a false test is the match this returns
  done
  return 1
}

# Manual unnamed path: a frontmatter effort key beats the parent tier, so --tier would not bind.
require_unkeyed_reviewer() {
  local definition="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/agents/${REVIEWER}.md"
  [[ -r "${definition}" ]] || die 5 "reviewer definition not readable: ${definition}"
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if has_effort_key "${definition}"; then
    die 5 "${definition} carries a frontmatter effort key, which overrides --effort on the manual path"
  fi
}

has_effort_key() {
  awk 'NR == 1 { if ($0 !~ /^---[[:space:]]*$/) exit; next }
    /^---[[:space:]]*$/ { exit }
    /^effort:/ { found = 1; exit }
    END { exit !found }' "${1}"
}

# shellcheck disable=SC2329  # invoked from the EXIT trap string
delete_stage_dir() {
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${STAGE_DIR}"; then rm -rf -- "${STAGE_DIR:?}"; fi
}

print_footprint() {
  printf '%s\n' \
    "reviewer-catch-rate: footprint — each diff runs one parent session and one ${REVIEWER} subagent" \
    "  through the launcher's live profile, so its live hooks fire:" \
    '  - append-only telemetry under ~/.glass-atrium: data/agent-tool-budget/ entries,' \
    '    data/workflow-gate-fired.log, logs/inject-scope-*.log' \
    "  - one review outcome row per reviewer spawn, cid slug ${CID_SLUG}, plus CostEvent rows" \
    '  - reviewer lessons may enter the CTM/EPM lesson store: a re-run after a reviewer edit measures that' \
    '    edit plus these lessons' \
    '  - no config, rules, agents or hooks are written' >&2
}

run_corpus() {
  local n=0 diff name case_dir body
  printf '# reviewer-catch-rate tier=%s corpus=%s\n' "${TIER}" "${CORPUS}"
  printf 'diff\tdefect\tverdict\n'
  for diff in "${DIFFS[@]}"; do
    n=$((n + 1))
    name="${diff##*/}"
    case_dir="${STAGE_DIR}/${n}"
    mkdir -- "${case_dir}"
    cp -- "${diff}" "${case_dir}/change.diff"
    body=''
    # shellcheck disable=SC2310  # the status IS the run verdict; staging above ran under errexit
    if launch_review "${case_dir}" "${name}"; then body="${case_dir}/body"; fi
    if [[ -n "${OUT}" ]]; then cp -- "${case_dir}/reply" "${OUT}/${name%.diff}.reply.txt"; fi
    score_diff "${name}" "${body}"
  done
  printf 'RECALL tier=%s caught=%s scored=%s errors=%s\n' "${TIER}" "${CAUGHT}" "${SCORED}" "${ERRORS}"
  ((ERRORS == 0)) || exit 1
}

# Leaves the relayed reply in <case dir>/body; 1 when the launch fails, the relay block is missing or it names the corpus.
launch_review() {
  local case_dir="${1}" name="${2}" prompt rc=0 stderr_tail
  prompt="$(build_prompt "${case_dir}/change.diff")"
  (cd -- "${HOME}" && "${LAUNCHER}" -p --effort "${TIER}" --output-format text "${prompt}") \
    </dev/null >"${case_dir}/reply" 2>"${case_dir}/stderr" || rc=$?
  if ((rc != 0)); then
    stderr_tail="$(tail -n 5 -- "${case_dir}/stderr")"
    printf 'reviewer-catch-rate: %s: launcher exited %s: %s\n' "${name}" "${rc}" "${stderr_tail}" >&2
    return 1
  fi
  # shellcheck disable=SC2310  # pure filter — its status is the relay verdict
  if ! extract_relay "${case_dir}/reply" >"${case_dir}/body"; then
    printf 'reviewer-catch-rate: %s: reply lacks a non-empty %s … %s block\n' "${name}" "${REPLY_BEGIN}" "${REPLY_END}" >&2
    return 1
  fi
  if grep -Fq -e "${CORPUS_NAME}" -e 'labels.tsv' -- "${case_dir}/body"; then
    printf 'reviewer-catch-rate: %s: reply names %s or labels.tsv — the reviewer could read the answer\n' \
      "${name}" "${CORPUS_NAME}" >&2
    return 1
  fi
}

# The brief names neither the corpus nor the defect, so the reviewer sees an ordinary review request.
build_prompt() {
  local stamp suffix
  stamp="$(date +%Y-%m-%dT%H%M)"
  printf -v suffix '%04x' "${RANDOM}"
  printf '%s\n' \
    "Spawn exactly one subagent with the Agent tool: subagent_type ${REVIEWER}, no name, in the foreground." \
    'Give it the text between BRIEF-BEGIN and BRIEF-END as its prompt, unchanged. Do not review the change yourself.' \
    "When it returns, print its final reply verbatim between a line ${REPLY_BEGIN} and a line ${REPLY_END}; print nothing else." \
    'BRIEF-BEGIN' \
    "Review the proposed change to the Glass Atrium repository in the unified diff at ${1}." \
    'Report every defect you find, each with the file and line or symbol it sits at and the rule it breaks.' \
    "CID: ${stamp}_${CID_SLUG}_${suffix}" \
    'BRIEF-END'
}

extract_relay() {
  awk -v begin="${REPLY_BEGIN}" -v end="${REPLY_END}" '
    { line = $0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", line) }
    open && line == end { closed = 1; exit }
    open { print; if (line != "") lines++ }
    !open && line == begin { open = 1 }
    END { exit !(closed && lines > 0) }' "${1}"
}

# Prints each severity-tagged entry: its opening line plus the deeper-indented lines under it.
# Opener: [MUST FIX], [SHOULD FIX] or [CONSIDER] in any case, led only by indentation, a list marker, backticks or *.
# A blank line is skipped; any other line closes the entry.
# Only entry text scores — a denial written inside an entry scores too.
extract_findings() {
  awk '
    { indent = match($0, /[^[:space:]]/) - 1 }
    indent < 0 { next }
    open && indent > depth { print; next }
    { open = (tolower($0) ~ /^[[:space:]]*(([-*+]|[0-9]+[.)])[[:space:]]+)?[`*]*\[(must fix|should fix|consider)\]/) }
    open { depth = indent; print }' "${1}"
}

score_diff() {
  local name="${1}" body="${2}" findings='' i verdict
  if [[ -n "${body}" ]]; then
    findings="${body}.findings"
    extract_findings "${body}" >"${findings}"
  fi
  for ((i = 0; i < ${#LABEL_DIFFS[@]}; i++)); do
    [[ "${LABEL_DIFFS[i]}" == "${name}" ]] || continue
    verdict=error
    if [[ -n "${findings}" ]]; then
      verdict=missed
      if grep -Eiq -e "${LABEL_PATTERNS[i]}" -- "${findings}"; then verdict=caught; fi
    fi
    count_verdict "${verdict}"
    printf '%s\t%s\t%s\n' "${name}" "${LABEL_DEFECTS[i]}" "${verdict}"
  done
}

count_verdict() {
  case "${1}" in
    caught) CAUGHT=$((CAUGHT + 1)) SCORED=$((SCORED + 1)) ;;
    missed) SCORED=$((SCORED + 1)) ;;
    *) ERRORS=$((ERRORS + 1)) ;;
  esac
}

main "$@"
