#!/usr/bin/env bats
# reviewer-catch-rate.sh contract suite — scoring, run failures, preflight refusals, invocation shape.
# Hermetic: a stub launcher stands in for the claude CLI, so no model call is ever made.
#
# Run via: bats autoagent/test/reviewer-catch-rate.bats
# Requires: bats >= 1.5.0, bash 3.2+

# shellcheck disable=SC2154  # BATS_* and run's status/output/stderr are bats-provided
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

setup() {
  RUNNER="${GA}/autoagent/reviewer-catch-rate.sh"
  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  CONFIG_DIR="${BATS_TEST_TMPDIR}/config"
  CORPUS="${BATS_TEST_TMPDIR}/corpus"
  STUB_LOG_DIR="${BATS_TEST_TMPDIR}/stub-log"
  STUB_REPLY_DIR="${BATS_TEST_TMPDIR}/stub-replies"
  LAUNCHER="${BATS_TEST_TMPDIR}/launcher"
  mkdir -p "${FAKE_HOME}" "${CORPUS}" "${STUB_LOG_DIR}" "${STUB_REPLY_DIR}"
  write_reviewer_definition "${CONFIG_DIR}" ''
  write_launcher
  printf '# diff\tdefect\tpattern\n' >"${CORPUS}/labels.tsv"
}

# Unkeyed by default; $2 adds one frontmatter line.
write_reviewer_definition() {
  mkdir -p "${1}/agents"
  {
    printf '%s\n' '---' 'name: glass-atrium-qa-code-reviewer' 'tools: [Read, Glob, Grep, Bash]'
    [[ -z "${2}" ]] || printf '%s\n' "${2}"
    printf '%s\n' '---' '' '# Reviewer body'
  } >"${1}/agents/glass-atrium-qa-code-reviewer.md"
}

# Stub CLI: logs argv, cwd, the prompt and the staged diff with its path, then replays the reply keyed by the
# diff's first line (plus an optional <key>.rc exit status).
write_launcher() {
  cat >"${LAUNCHER}" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" >>"${STUB_LOG_DIR}/argv"
pwd -P >>"${STUB_LOG_DIR}/cwd"
prompt="${!#}"
diff_path="$(printf '%s\n' "${prompt}" | grep -Eo '/[^[:space:]]+\.diff' | head -n 1)"
key="$(head -n 1 -- "${diff_path}")"
printf '%s\n' "${diff_path}" >"${STUB_LOG_DIR}/staged-${key}"
cp -- "${diff_path}" "${STUB_LOG_DIR}/seen-${key}.diff"
printf '%s\n' "${prompt}" >"${STUB_LOG_DIR}/prompt-${key}"
cat -- "${STUB_REPLY_DIR}/${key}"
if [[ -f "${STUB_REPLY_DIR}/${key}.rc" ]]; then exit "$(cat -- "${STUB_REPLY_DIR}/${key}.rc")"; fi
STUB
  chmod +x "${LAUNCHER}"
}

# add_case <key> <defect id> <pattern> <relayed reply> [preamble] — one diff, its label row, its stub reply.
add_case() {
  printf '%s\n' "${1}" '--- a/hooks/x.sh' '+++ b/hooks/x.sh' >"${CORPUS}/${1}.diff"
  printf '%s\t%s\t%s\n' "${1}.diff" "${2}" "${3}" >>"${CORPUS}/labels.tsv"
  printf '%sREVIEWER-REPLY-BEGIN\n%s\nREVIEWER-REPLY-END\n' "${5:+${5}$'\n'}" "${4}" >"${STUB_REPLY_DIR}/${1}"
}

run_runner() {
  run --separate-stderr env \
    HOME="${FAKE_HOME}" \
    CLAUDE_CONFIG_DIR="${CONFIG_DIR}" \
    REVIEWER_CATCH_RATE_CLAUDE_BIN="${LAUNCHER}" \
    STUB_LOG_DIR="${STUB_LOG_DIR}" \
    STUB_REPLY_DIR="${STUB_REPLY_DIR}" \
    bash "${RUNNER}" "$@"
}

# assert_status <want> [row name]
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    printf '%sstatus=%s (want %s)\nstdout:\n%s\nstderr:\n%s\n' "${2:+row ${2}: }" "${status}" "${1}" "${output}" "${stderr}"
    return 1
  }
}

assert_report_rows() {
  local row
  for row in "$@"; do
    [[ $'\n'"${output}"$'\n' == *$'\n'"${row}"$'\n'* ]] || {
      printf 'missing row: %s\nstdout:\n%s\n' "${row}" "${output}"
      return 1
    }
  done
}

assert_not_launched() {
  [[ ! -e "${STUB_LOG_DIR}/argv" ]] || {
    printf 'row %s launched:\n' "${1}"
    cat -- "${STUB_LOG_DIR}/argv"
    return 1
  }
}

# shellcheck disable=SC2016  # literal markdown backticks, as the review template wraps each tag
@test "a defect scores caught only when its pattern appears inside a severity-tagged finding of the relayed reply" {
  add_case hit unquoted-var 'unquoted.*file_list' \
    '- `[MUST FIX][Risk: H] hooks/x.sh → file_list`: Unquoted file_list expansion splits on spaces.'
  add_case sub-bullet split-use 'splitting.{0,20}forbidden' \
    $'- `[MUST FIX][Risk: H] hooks/x.sh → main`: **Shell.** Expands a path list.\n  - Rule: word splitting on paths is forbidden.'
  add_case blank-line-continuation split-use 'splitting.{0,20}forbidden' \
    $'- `[MUST FIX][Risk: H] hooks/x.sh → main`: Expands a path list.\n\n  - Rule: word splitting on paths is forbidden.'
  add_case numbered-list glob-use 'unquoted glob' '1. [MUST FIX] hooks/x.sh:2 — unquoted glob in the loop.'
  add_case bold-lead-in glob-use 'unquoted glob' '**[MUST FIX]** hooks/x.sh:2 — unquoted glob in the loop.'
  add_case lowercase-tag glob-use 'unquoted glob' '- [must fix] hooks/x.sh:2 — unquoted glob in the loop.'
  add_case padded-markers glob-use 'unquoted glob' 'unused'
  printf '  REVIEWER-REPLY-BEGIN \n[SHOULD FIX] hooks/x.sh:2 — unquoted glob in the loop.\n\tREVIEWER-REPLY-END  \n' \
    >"${STUB_REPLY_DIR}/padded-markers"
  add_case mid-line-tag glob-use 'unquoted glob' '- **Design**: nothing rises to [SHOULD FIX]; no unquoted glob.'
  add_case outside split-use 'word splitting' 'No defects found.' \
    '- `[MUST FIX][Risk: H] hooks/x.sh → main`: word splitting on a path.'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  assert_report_rows $'hit.diff\tunquoted-var\tcaught' $'sub-bullet.diff\tsplit-use\tcaught' \
    $'blank-line-continuation.diff\tsplit-use\tcaught' $'numbered-list.diff\tglob-use\tcaught' \
    $'bold-lead-in.diff\tglob-use\tcaught' $'lowercase-tag.diff\tglob-use\tcaught' \
    $'padded-markers.diff\tglob-use\tcaught' \
    $'mid-line-tag.diff\tglob-use\tmissed' $'outside.diff\tsplit-use\tmissed' \
    'RECALL tier=xhigh caught=7 scored=9 errors=0'
}

@test "a failed launch, a reply without a closed non-empty relay block or a reply naming the corpus scores that diff error and exits 1" {
  add_case hit unquoted-var 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable'
  add_case bare no-markers 'unquoted' 'unused'
  printf 'The reviewer found an unquoted variable.\n' >"${STUB_REPLY_DIR}/bare"
  add_case empty-relay empty-block 'unquoted' $'\n  '
  add_case unclosed-relay truncated 'unquoted' 'unused'
  printf 'REVIEWER-REPLY-BEGIN\n[SHOULD FIX] hooks/x.sh:3 — unquo\n' >"${STUB_REPLY_DIR}/unclosed-relay"
  add_case crashed crash 'unquoted' 'unquoted variable'
  printf '3\n' >"${STUB_REPLY_DIR}/crashed.rc"
  add_case leaked-dir leak 'unquoted' \
    '[SHOULD FIX] hooks/x.sh:3 — unquoted variable, as autoagent/reviewer-catch-rate/case-01.diff shows'
  add_case leaked-labels leak 'unquoted' '[SHOULD FIX] hooks/x.sh:3 — unquoted variable, per the labels.tsv row'
  run_runner --tier high --corpus "${CORPUS}"
  assert_status 1
  assert_report_rows $'hit.diff\tunquoted-var\tcaught' $'bare.diff\tno-markers\terror' \
    $'empty-relay.diff\tempty-block\terror' $'unclosed-relay.diff\ttruncated\terror' \
    $'crashed.diff\tcrash\terror' $'leaked-dir.diff\tleak\terror' $'leaked-labels.diff\tleak\terror' \
    'RECALL tier=high caught=1 scored=1 errors=6'
  local name
  for name in bare empty-relay unclosed-relay crashed leaked-dir leaked-labels; do
    [[ "${stderr}" == *"${name}.diff"* ]] || {
      printf 'row %s: no stderr reason\n%s\n' "${name}" "${stderr}"
      return 1
    }
  done
}

build_unlabeled_diff() {
  printf 'x\n' >"${1}/a.diff"
  printf 'x\n' >"${1}/b.diff"
  printf 'a.diff\td\tp\n' >"${1}/labels.tsv"
}
build_absent_label_file() { printf 'x\n' >"${1}/a.diff"; }
build_label_without_diff() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\td\tp\nghost.diff\td\tp\n' >"${1}/labels.tsv"
}
build_two_field_label() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\tp\n' >"${1}/labels.tsv"
}
build_empty_middle_field() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\t\tp\tq\n' >"${1}/labels.tsv"
}
build_invalid_pattern() {
  printf 'x\n' >"${1}/a.diff"
  printf 'a.diff\td\t(\n' >"${1}/labels.tsv"
}
build_no_diff() { printf '# none\n' >"${1}/labels.tsv"; }

@test "an invalid corpus stops the run with exit 3 before any launch" {
  local row dir
  for row in unlabeled_diff absent_label_file label_without_diff two_field_label empty_middle_field \
    invalid_pattern no_diff; do
    dir="${BATS_TEST_TMPDIR}/corpus-${row}"
    mkdir -p "${dir}"
    "build_${row}" "${dir}"
    run_runner --tier xhigh --corpus "${dir}"
    assert_status 3 "${row}"
    assert_not_launched "${row}"
  done
}

@test "an absent or effort-keyed reviewer definition stops the run with exit 5 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  local row
  for row in absent keyed; do
    CONFIG_DIR="${BATS_TEST_TMPDIR}/config-${row}"
    mkdir -p "${CONFIG_DIR}"
    [[ "${row}" == absent ]] || write_reviewer_definition "${CONFIG_DIR}" 'effort: high'
    run_runner --tier xhigh --corpus "${CORPUS}"
    assert_status 5 "${row}"
    assert_not_launched "${row}"
  done
}

launcher_for() {
  case "${1}" in
    stub) printf '%s' "${BATS_TEST_TMPDIR}/launcher" ;;
    plain-file) printf '%s' "${CORPUS}/hit.diff" ;;
    *) ;;
  esac
}

@test "an unplanned tier or an unusable launcher is refused before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  local row name want kind tier
  for row in 'tier-medium|2|stub|medium' 'tier-missing|2|stub|' 'launcher-unset|4|unset|xhigh' \
    'launcher-not-executable|4|plain-file|xhigh'; do
    IFS='|' read -r name want kind tier <<<"${row}"
    LAUNCHER="$(launcher_for "${kind}")"
    if [[ -n "${tier}" ]]; then run_runner --tier "${tier}" --corpus "${CORPUS}"; else run_runner --corpus "${CORPUS}"; fi
    assert_status "${want}" "${name}"
    assert_not_launched "${name}"
  done
}

@test "an unknown argument or a flag missing its value is refused with exit 2 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  local row name
  local -a extra
  for row in 'unknown-arg|--bogus|x' 'dangling-flag|--out'; do
    IFS='|' read -r -a extra <<<"${row}"
    name="${extra[0]}"
    run_runner --tier xhigh --corpus "${CORPUS}" "${extra[@]:1}"
    assert_status 2 "${name}"
    assert_not_launched "${name}"
  done
}

@test "the launcher runs headless from HOME at the requested tier and spawns the typed reviewer under a corpus CID" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  run_runner --tier high --corpus "${CORPUS}"
  assert_status 0
  local argv prompt cwd home
  argv="$(cat -- "${STUB_LOG_DIR}/argv")"
  prompt="$(cat -- "${STUB_LOG_DIR}/prompt-hit")"
  cwd="$(cat -- "${STUB_LOG_DIR}/cwd")"
  home="$(cd -- "${FAKE_HOME}" && pwd -P)"
  [[ $'\n'"${argv}"$'\n' == *$'\n-p\n'* && "${argv}" == *$'--effort\nhigh'* ]] || {
    printf '%s\n' "${argv}"
    return 1
  }
  [[ $'\n'"${argv}"$'\n' != *$'\n--agent\n'* ]] || {
    printf '%s\n' "${argv}"
    return 1
  }
  [[ "${cwd}" == "${home}" ]] || return 1
  [[ "${prompt}" == *glass-atrium-qa-code-reviewer* ]] || {
    printf '%s\n' "${prompt}"
    return 1
  }
  printf '%s\n' "${prompt}" | grep -Eq 'CID: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}_reviewer-corpus_[0-9a-f]{4}$'
}

@test "the reviewer is pointed at a temporary copy of the diff staged outside the corpus" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  cmp -- "${STUB_LOG_DIR}/seen-hit.diff" "${CORPUS}/hit.diff"
  local prompt staged
  prompt="$(cat -- "${STUB_LOG_DIR}/prompt-hit")"
  staged="$(cat -- "${STUB_LOG_DIR}/staged-hit")"
  [[ "${prompt}" != *"${CORPUS}"* && "${staged}" != "${CORPUS}"/* ]] || return 1
  [[ ! -e "${staged%/*}" ]] || {
    printf 'stage dir left behind: %s\n' "${staged%/*}"
    return 1
  }
}

@test "a missing shared path guard stops the run with exit 6 before any launch" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  mkdir -p "${BATS_TEST_TMPDIR}/tree/autoagent"
  cp -- "${RUNNER}" "${BATS_TEST_TMPDIR}/tree/autoagent/"
  RUNNER="${BATS_TEST_TMPDIR}/tree/autoagent/reviewer-catch-rate.sh"
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 6
  assert_not_launched path-guard
}

@test "a run states its live-profile footprint on stderr" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable'
  run_runner --tier xhigh --corpus "${CORPUS}"
  assert_status 0
  local word
  for word in reviewer-corpus outcome CostEvent lesson agent-tool-budget; do
    [[ "${stderr}" == *"${word}"* ]] || {
      printf 'missing %s in:\n%s\n' "${word}" "${stderr}"
      return 1
    }
  done
}

@test "--out keeps each raw launcher reply under its diff name" {
  add_case hit unquoted-var 'unquoted' 'unquoted variable' 'preamble'
  run_runner --tier xhigh --corpus "${CORPUS}" --out "${BATS_TEST_TMPDIR}/out"
  assert_status 0
  cmp -- "${BATS_TEST_TMPDIR}/out/hit.reply.txt" "${STUB_REPLY_DIR}/hit"
}

REPO_CORPUS="${GA}/autoagent/reviewer-catch-rate"

# generate-manifest.sh keeps the corpus out of the live bundle, so only a tree outside git may lack it.
require_repo_corpus() {
  if [[ -r "${REPO_CORPUS}/labels.tsv" ]]; then return 0; fi
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "no catch-rate corpus: generate-manifest.sh keeps it out of the live bundle (install root — repo-only check)"
  echo "catch-rate corpus missing from a git work tree: ${REPO_CORPUS}"
  return 1
}

# Label rows of the repo corpus, optionally only those naming diff $1.
count_corpus_labels() {
  awk -F '\t' -v name="${1:-}" '!/^[[:space:]]*(#|$)/ && (name == "" || $1 == name) { n++ } END { print n + 0 }' \
    "${REPO_CORPUS}/labels.tsv"
}

# Stub reviewer for the repo corpus: relays the reply filed under the staged diff's checksum, else one
# severity-tagged finding quoting the diff back as indented continuation lines, which scoring reads.
write_corpus_launcher() {
  cat >"${BATS_TEST_TMPDIR}/launcher" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
prompt="${!#}"
diff_path="$(printf '%s\n' "${prompt}" | grep -Eo '/[^[:space:]]+\.diff' | head -n 1)"
reply="${STUB_REPLY_DIR}/$(cksum <"${diff_path}" | awk '{ print $1 }')"
printf 'REVIEWER-REPLY-BEGIN\n'
if [[ -f "${reply}" ]]; then
  cat -- "${reply}"
else
  printf '%s\n' '- `[CONSIDER][Risk: L] the change`: quoted back as proposed'
  sed 's/^/    /' "${diff_path}"
fi
printf 'REVIEWER-REPLY-END\n'
STUB
  chmod +x "${BATS_TEST_TMPDIR}/launcher"
}

# The review findings findings.tsv files for defect id $1, one per line, empty when none.
corpus_findings() {
  awk -F '\t' -v id="${1}" '!/^[[:space:]]*(#|$)/ && $1 == id { print $2 }' "${REPO_CORPUS}/findings.tsv"
}

@test "every corpus diff is a well-formed new-file patch carrying exactly one labelled defect" {
  require_repo_corpus
  local diff name count
  mkdir -p "${BATS_TEST_TMPDIR}/apply"
  for diff in "${REPO_CORPUS}"/*.diff; do
    name="${diff##*/}"
    count="$(count_corpus_labels "${name}")"
    [[ "${count}" -eq 1 ]] || {
      echo "${name}: ${count} label rows, want 1"
      return 1
    }
    (cd -- "${BATS_TEST_TMPDIR}/apply" && git apply --check -- "${diff}") || {
      echo "${name}: does not apply to an empty tree"
      return 1
    }
    ! grep -Eiq 'planted|corpus|defect|violation' -- "${diff}" || {
      echo "${name}: names what it plants"
      return 1
    }
  done
}

@test "a severity-tagged finding that only quotes the corpus diff back scores every planted defect missed" {
  require_repo_corpus
  write_corpus_launcher
  local count
  count="$(count_corpus_labels)"
  run_runner --tier high
  assert_status 0
  [[ "${output}" != *$'\tcaught'* ]] || {
    printf '%s\n' "${output}"
    return 1
  }
  assert_report_rows "RECALL tier=high caught=0 scored=${count} errors=0"
}

# denial-reply.md: an unrelated finding citing the Residue class list, anchored away from every corpus file and symbol,
# then a no-findings section denying every corpus defect class.
@test "a reply denying every corpus defect class or citing a class list in a finding on other code scores every planted defect missed" {
  require_repo_corpus
  write_corpus_launcher
  local denial="${REPO_CORPUS}/denial-reply.md" line diff defect pattern key count=0
  while IFS='' read -r line || [[ -n "${line}" ]]; do
    [[ ! "${line}" =~ ^[[:space:]]*(#|$) ]] || continue
    IFS=$'\x1f' read -r diff defect pattern <<<"${line//$'\t'/$'\x1f'}"
    grep -Eiq -e "${pattern}" -- "${denial}" || {
      echo "the denial reply never names ${defect}, so its missed verdict would prove nothing"
      return 1
    }
    key="$(cksum <"${REPO_CORPUS}/${diff}")"
    cp -- "${denial}" "${STUB_REPLY_DIR}/${key%% *}"
    count=$((count + 1))
  done <"${REPO_CORPUS}/labels.tsv"
  run_runner --tier xhigh
  assert_status 0
  assert_report_rows "RECALL tier=xhigh caught=0 scored=${count} errors=0"
}

# Fields split on \x1f like the runner's own label read, so an empty field cannot shift the rest.
# Each finding runs alone on a one-diff corpus, so one wording's catch cannot hide another's miss.
@test "each corpus defect scores caught on every finding filed for it" {
  require_repo_corpus
  write_corpus_launcher
  local orphans line diff defect pattern findings finding key dir n=0
  orphans="$(awk -F '\t' 'NR == FNR { if (!/^[[:space:]]*(#|$)/) ids[$2] = 1; next }
    !/^[[:space:]]*(#|$)/ && !($1 in ids) { print $1 }' "${REPO_CORPUS}/labels.tsv" "${REPO_CORPUS}/findings.tsv")"
  [[ -z "${orphans}" ]] || {
    echo "findings.tsv files rows under defect ids no label carries: ${orphans}"
    return 1
  }
  while IFS='' read -r line || [[ -n "${line}" ]]; do
    [[ ! "${line}" =~ ^[[:space:]]*(#|$) ]] || continue
    IFS=$'\x1f' read -r diff defect pattern <<<"${line//$'\t'/$'\x1f'}"
    findings="$(corpus_findings "${defect}")"
    [[ -n "${findings}" ]] || {
      echo "findings.tsv carries no finding for ${defect} (${pattern})"
      return 1
    }
    key="$(cksum <"${REPO_CORPUS}/${diff}")"
    while IFS='' read -r finding; do
      n=$((n + 1))
      dir="${BATS_TEST_TMPDIR}/finding-${n}"
      mkdir -p "${dir}"
      cp -- "${REPO_CORPUS}/${diff}" "${dir}/"
      printf '%s\n' "${line}" >"${dir}/labels.tsv"
      printf '%s\n' "${finding}" >"${STUB_REPLY_DIR}/${key%% *}"
      run_runner --tier xhigh --corpus "${dir}" </dev/null
      assert_status 0 "${defect}"
      assert_report_rows "${diff}"$'\t'"${defect}"$'\tcaught' || {
        printf 'finding: %s\n' "${finding}"
        return 1
      }
    done <<<"${findings}"
  done <"${REPO_CORPUS}/labels.tsv"
}
