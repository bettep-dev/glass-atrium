#!/usr/bin/env bash
# reviewer-catch-rate.sh — planted-defect recall of glass-atrium-qa-code-reviewer at one effort tier.
# Recall only: a defect is caught when a severity-tagged finding of the relayed review matches its label pattern;
#   no gate reads the result.
# Usage: REVIEWER_CATCH_RATE_CLAUDE_BIN=<launcher> reviewer-catch-rate.sh --tier medium|high|xhigh [--corpus DIR] [--out DIR]
#
# Route: per diff, a headless parent (`<launcher> -p --effort xhigh`) runs the Workflow tool on a script staged in
#   the case dir; the script spawns the reviewer through `agent()` with the arm as its effort option and a
#   schema-mode verdict (`review`, `completion_block`) — the step-4 gate shape. The parent relays `review`.
#   The parent stays xhigh on every arm: the option is measured winning only under an xhigh parent.
# Session: `--setting-sources project,local` from the case dir, whose .claude/settings.json wires only the
#   SubagentStart scope-injection hooks named in lib/ga-env.sh → EXPECTED_HOOK_BINDINGS — no SubagentStop recorder
#   and no Stop cost tracker, so a run writes no outcome row, no lesson and no CostEvent.
# Void checks, read from the reviewer transcript under <config dir>/projects/*/<session id>/: the injected scope
#   header, no tool input naming a label path, and every recorded effort equal to the arm.
# Launcher: required, no PATH fallback — the headless rule is `claude-work-dev -p`, a zsh function,
#   so pass an executable wrapper such as `#!/bin/zsh -i` + `claude-work-dev "$@"`.
# Corpus: <name>.diff files + labels.tsv rows `<diff basename> TAB <defect id> TAB <ERE, matched case-insensitive>`.
# Install root: the live bundle omits the corpus (generate-manifest.sh → EXCLUDE_RE), so a run there needs --corpus.
# Base files: every corpus diff is a new-file patch, so the label-free base set is the empty tree — the case dir
#   holds only the staged diff, the workflow script and the session settings.
#
# Exit codes (this script's own):
#   0 = every diff reviewed and scored · 1 = a diff scored error (launch failed, relay missing, corpus named,
#       transcript missing, label path read, scope header absent, recorded tier off the arm)
#   2 = usage error · 3 = corpus invalid · 4 = launcher unset or not executable
#   5 = reviewer definition unreadable · 6 = shared path guard missing
#   7 = session wiring unusable: python3 absent, no injection binding readable, or an injection hook not executable
set -Eeuo pipefail
IFS=$'\n\t'
trap 'printf "reviewer-catch-rate: ERROR line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly PATH_GUARD="${SCRIPT_DIR}/../scripts/lib/path-guard.sh"
readonly BINDINGS_FILE="${SCRIPT_DIR}/../lib/ga-env.sh"
readonly REVIEWER='glass-atrium-qa-code-reviewer'
readonly CID_SLUG='reviewer-corpus'
readonly CORPUS_NAME='reviewer-catch-rate'
readonly REPLY_BEGIN='REVIEWER-REPLY-BEGIN'
readonly REPLY_END='REVIEWER-REPLY-END'
readonly PARENT_TIER='xhigh'
readonly INJECTION_HEADER="auto-injected at spawn for ${REVIEWER}"
readonly LABEL_PATHS=('labels.tsv' 'findings.tsv' "${CORPUS_NAME}/")

if [[ ! -r "${PATH_GUARD}" ]]; then
  printf 'reviewer-catch-rate: cannot source the shared path guard: %s\n' "${PATH_GUARD}" >&2
  exit 6
fi
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${PATH_GUARD}"

# Prints leak, injected, distinct efforts (absent for an assistant record without one) and four token sums,
# \x1f-separated; usage counts once per message id, as cost-tracker.sh → accumulate_usage does.
IFS='' read -r -d '' TRANSCRIPT_READER <<'PY' || true # GA-ABSORB[benign]: a heredoc read ends at EOF, never at a NUL
import json, sys
path, header, needles = sys.argv[1], sys.argv[2], sys.argv[3:]
keys = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
leak, injected, efforts, seen, tokens = '', 0, [], set(), [0, 0, 0, 0]
def injects(attachment):
    if attachment.get('type') != 'hook_additional_context' or attachment.get('hookEvent') != 'SubagentStart':
        return False
    content = attachment.get('content')
    return any(isinstance(p, str) and header in p for p in (content if isinstance(content, list) else [content]))
with open(path, encoding='utf-8', errors='replace') as handle:
    for line in handle:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        if record.get('type') == 'attachment' and isinstance(record.get('attachment'), dict):
            injected = injected or int(injects(record['attachment']))
        if record.get('type') != 'assistant':
            continue
        tier = record.get('effort')
        tier = tier if isinstance(tier, str) and tier else 'absent'
        if tier not in efforts:
            efforts.append(tier)
        message = record.get('message') if isinstance(record.get('message'), dict) else {}
        for item in message.get('content') if isinstance(message.get('content'), list) else []:
            if isinstance(item, dict) and item.get('type') == 'tool_use':
                text = json.dumps(item.get('input'))
                leak = leak or next((n for n in needles if n in text), '')
        usage, msg_id = message.get('usage'), message.get('id')
        if isinstance(usage, dict) and not (msg_id and msg_id in seen):
            if msg_id:
                seen.add(msg_id)
            tokens = [t + (usage.get(k) if isinstance(usage.get(k), int) else 0) for t, k in zip(tokens, keys)]
print('\x1f'.join([leak, str(injected), ','.join(efforts)] + [str(t) for t in tokens]))
PY
readonly TRANSCRIPT_READER

TIER=''
CORPUS="${SCRIPT_DIR}/${CORPUS_NAME}"
OUT=''
LAUNCHER="${REVIEWER_CATCH_RATE_CLAUDE_BIN:-}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
HOOKS_DIR="${REVIEWER_CATCH_RATE_HOOKS_DIR:-${GA_ROOT:-${HOME}/.glass-atrium}/hooks}"
STAGE_DIR=''
CASE_SESSION=''
CASE_TOKENS=''
DIFFS=()
INJECTION_HOOKS=()
LABEL_DIFFS=()
LABEL_DEFECTS=()
LABEL_PATTERNS=()
TOKENS=(0 0 0 0)
CAUGHT=0
SCORED=0
ERRORS=0

main() {
  parse_args "$@"
  require_launcher
  load_corpus
  require_reviewer_definition
  require_session_wiring
  if [[ -n "${OUT}" ]]; then mkdir -p -- "${OUT}"; fi
  trap 'delete_stage_dir' EXIT
  STAGE_DIR="$(mktemp -d)"
  write_settings >"${STAGE_DIR}/settings.json"
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
    medium | high | xhigh) ;;
    *) die 2 "--tier must be medium, high or xhigh, the three reviewer arms stream 7 compares (got '${TIER}')" ;;
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

# A frontmatter effort key is no refusal here: the agent() option beats it, and check_recorded_tier voids any
# diff where it did not.
require_reviewer_definition() {
  local definition="${CONFIG_DIR}/agents/${REVIEWER}.md"
  [[ -r "${definition}" ]] || die 5 "reviewer definition not readable: ${definition}"
}

# Bindings parsed, never sourced: ga-env.sh is a library whose init assigns readonly globals.
require_session_wiring() {
  local hook bindings
  command -v python3 >/dev/null || die 7 'python3 not found: the transcript reader and settings writer need it'
  [[ -r "${BINDINGS_FILE}" ]] || die 7 "hook bindings not readable: ${BINDINGS_FILE}"
  bindings="$(read_injection_hooks)"
  while IFS='' read -r hook; do [[ -z "${hook}" ]] || INJECTION_HOOKS+=("${hook}"); done <<<"${bindings}"
  ((${#INJECTION_HOOKS[@]} > 0)) || die 7 "no SubagentStart inject-scope binding in ${BINDINGS_FILE}"
  for hook in "${INJECTION_HOOKS[@]}"; do
    [[ -f "${HOOKS_DIR}/${hook}" && -x "${HOOKS_DIR}/${hook}" ]] || die 7 "injection hook not executable: ${HOOKS_DIR}/${hook}"
  done
}

read_injection_hooks() {
  awk -F '\t' '
    /^[[:space:]]*EXPECTED_HOOK_BINDINGS=\(/ { open = 1; next }
    open && /^[[:space:]]*\)/ { open = 0 }
    open { gsub(/^[[:space:]]*"|"[[:space:]]*$/, ""); if ($1 == "SubagentStart" && $2 ~ /^inject-scope-/) print $2 }
  ' "${BINDINGS_FILE}"
}

# Project settings for every case dir: the injection hooks only, plus the read tools the parent and reviewer use.
write_settings() {
  python3 -c '
import json, sys
hooks_dir, names = sys.argv[1], sys.argv[2:]
print(json.dumps({
    "hooks": {"SubagentStart": [{"hooks": [{"type": "command", "command": hooks_dir + "/" + n}]} for n in names]},
    "permissions": {"allow": ["Workflow", "Read", "Glob", "Grep"]},
}, indent=2))' "${HOOKS_DIR}" "${INJECTION_HOOKS[@]}"
}

# shellcheck disable=SC2329  # invoked from the EXIT trap string
delete_stage_dir() {
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${STAGE_DIR}"; then rm -rf -- "${STAGE_DIR:?}"; fi
}

print_footprint() {
  printf '%s\n' \
    "reviewer-catch-rate: footprint — each diff runs one parent session (--setting-sources project,local)" \
    "  and one ${REVIEWER} workflow subagent, cid slug ${CID_SLUG}:" \
    "  - wired hooks: the SubagentStart inject-scope hooks under ${HOOKS_DIR} only" \
    '  - no SubagentStop or Stop hook is wired: no outcome row, no lesson and no CostEvent is written' \
    "  - left behind: append-only inject-scope telemetry and the session transcripts under ${CONFIG_DIR}/projects/" \
    '  - no config, rules, agents or hooks are written' >&2
}

run_corpus() {
  local n=0 diff name case_dir body totals
  printf '# reviewer-catch-rate tier=%s corpus=%s\n' "${TIER}" "${CORPUS}"
  printf 'diff\tdefect\tverdict\n'
  for diff in "${DIFFS[@]}"; do
    n=$((n + 1))
    name="${diff##*/}"
    case_dir="${STAGE_DIR}/${n}"
    stage_case "${diff}" "${case_dir}" "${name%.diff}"
    body=''
    # shellcheck disable=SC2310  # the status IS the run verdict; staging above ran under errexit
    if review_case "${case_dir}" "${name}"; then body="${case_dir}/body"; fi
    if [[ -n "${OUT}" ]]; then cp -- "${case_dir}/reply" "${OUT}/${name%.diff}.reply.txt"; fi
    score_diff "${name}" "${body}"
    printf 'TOKENS\t%s\t%s\n' "${name}" "${CASE_TOKENS:-unread}"
  done
  totals="$(format_tokens "${TOKENS[@]}")"
  printf 'RECALL tier=%s caught=%s scored=%s errors=%s %s\n' "${TIER}" "${CAUGHT}" "${SCORED}" "${ERRORS}" "${totals}"
  ((ERRORS == 0)) || exit 1
}

# Case dir = the reviewer's cwd: the diff, the workflow script and the session settings, no label file.
stage_case() {
  mkdir -p -- "${2}/.claude"
  cp -- "${1}" "${2}/change.diff"
  cp -- "${STAGE_DIR}/settings.json" "${2}/.claude/settings.json"
  build_workflow "${2}/change.diff" "${3}" >"${2}/review.js"
}

# Both checks run, so a voided launch still adds its spent tokens; 1 when either voids the diff.
review_case() {
  local verdict=0
  # shellcheck disable=SC2310  # each status folds into the case verdict
  launch_review "$@" || verdict=1
  # shellcheck disable=SC2310  # each status folds into the case verdict
  audit_transcript "$@" || verdict=1
  return "${verdict}"
}

# Leaves the relayed reply in <case dir>/body; 1 when the launch fails, the relay block is missing or it names the corpus.
launch_review() {
  local case_dir="${1}" name="${2}" prompt rc=0 stderr_tail
  CASE_SESSION="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  prompt="$(build_prompt "${case_dir}/review.js")"
  (cd -- "${case_dir}" && "${LAUNCHER}" -p --effort "${PARENT_TIER}" --setting-sources project,local \
    --session-id "${CASE_SESSION}" --output-format text "${prompt}") \
    </dev/null >"${case_dir}/reply" 2>"${case_dir}/stderr" || rc=$?
  if ((rc != 0)); then
    stderr_tail="$(tail -n 5 -- "${case_dir}/stderr")"
    void_case "${name}" "launcher exited ${rc}: ${stderr_tail}"
    return 1
  fi
  # shellcheck disable=SC2310  # pure filter — its status is the relay verdict
  if ! extract_relay "${case_dir}/reply" >"${case_dir}/body"; then
    void_case "${name}" "reply lacks a non-empty ${REPLY_BEGIN} … ${REPLY_END} block"
    return 1
  fi
  if grep -Fq -e "${CORPUS_NAME}" -e 'labels.tsv' -- "${case_dir}/body"; then
    void_case "${name}" "reply names ${CORPUS_NAME} or labels.tsv — the reviewer could read the answer"
    return 1
  fi
}

void_case() { printf 'reviewer-catch-rate: %s: %s\n' "${1}" "${2}" >&2; }

build_prompt() {
  printf '%s\n' \
    "Use the Workflow tool to run the workflow script at ${1} (pass that path as scriptPath)." \
    'Do not modify the script, use no other tool and review nothing yourself.' \
    'After launching it, wait until the workflow completion notification arrives.' \
    "Then print the workflow's returned string verbatim, decoded from any JSON quoting, between a line" \
    "${REPLY_BEGIN} and a line ${REPLY_END}; print nothing else."
}

# The brief names neither the corpus nor the defect, so the reviewer sees an ordinary review request.
build_workflow() {
  local stamp suffix
  stamp="$(date +%Y-%m-%dT%H%M)"
  printf -v suffix '%04x' "${RANDOM}"
  printf '%s\n' \
    "export const meta = { name: 'review-change', description: 'One review of a proposed change' }" \
    "const brief = 'Review the proposed change to the Glass Atrium repository in the unified diff at ${1}.' +" \
    "  ' Report every defect you find, each with the file and line or symbol it sits at and the rule it breaks.' +" \
    "  ' Put the review in the review field and your full [COMPLETION] block in completion_block.' +" \
    "  ' CID: ${stamp}_${CID_SLUG}_${suffix}'" \
    "const schema = { type: 'object', properties: { review: { type: 'string' }, completion_block: { type: 'string' } }," \
    "  required: ['review', 'completion_block'] }" \
    "const r = await agent(brief, { agentType: '${REVIEWER}', effort: '${TIER}', label: 'corpus:${2}', schema })" \
    "return r ? r.review : ''"
}

# 1 when the case has no single reviewer transcript, or it read a label path, lacks the scope header or recorded
# a tier other than the arm; a read transcript sets CASE_TOKENS and adds to the totals whatever the verdict.
audit_transcript() {
  local name="${2}" transcript fields leak injected efforts input output cache_read cache_creation
  CASE_TOKENS=''
  # shellcheck disable=SC2310  # pure lookup — its status is the transcript verdict
  if ! transcript="$(find_transcript)"; then
    void_case "${name}" "no single reviewer transcript under ${CONFIG_DIR}/projects/*/${CASE_SESSION}/"
    return 1
  fi
  fields="$(python3 -c "${TRANSCRIPT_READER}" "${transcript}" "${INJECTION_HEADER}" "${LABEL_PATHS[@]}")"
  IFS=$'\x1f' read -r leak injected efforts input output cache_read cache_creation <<<"${fields}"
  add_tokens "${input}" "${output}" "${cache_read}" "${cache_creation}"
  if [[ -n "${leak}" ]]; then
    void_case "${name}" "reviewer transcript names ${leak} in a tool input — the answer key was read"
    return 1
  fi
  if ((injected != 1)); then
    void_case "${name}" "reviewer transcript lacks the injected scope header '${INJECTION_HEADER}'"
    return 1
  fi
  check_recorded_tier "${name}" "${efforts}"
}

find_transcript() {
  local -a found
  shopt -s nullglob
  found=("${CONFIG_DIR}"/projects/*/"${CASE_SESSION}"/subagents/workflows/wf_*/agent-*.jsonl)
  shopt -u nullglob
  ((${#found[@]} == 1)) || return 1
  printf '%s\n' "${found[0]}"
}

check_recorded_tier() {
  case "${2}" in
    "${TIER}") return 0 ;;
    '' | *absent*) void_case "${1}" 'reviewer transcript has an assistant record with no recorded effort, or none' ;;
    *,*) void_case "${1}" "reviewer transcript records mixed efforts ${2}, arm ${TIER}" ;;
    *) void_case "${1}" "reviewer transcript records effort ${2}, arm ${TIER}" ;;
  esac
  return 1
}

add_tokens() {
  local i
  local -a values=("$@")
  CASE_TOKENS="$(format_tokens "${values[@]}")"
  for i in 0 1 2 3; do TOKENS[i]=$((TOKENS[i] + values[i])); done
}

format_tokens() { printf 'input=%s output=%s cache_read=%s cache_creation=%s' "$@"; }

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
