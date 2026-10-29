#!/usr/bin/env bats
# shellcheck disable=SC2154  # bats sets BATS_TEST_DIRNAME, status and output
# ga-trash-purge.bats — pins the one-entry Trash purge: each refusal deletes nothing, each accepted
# operand form deletes exactly its one entry, a link entry goes as the link alone, and every purge
# leaves one log line.
#
# Hermetic strategy: HOME is a fake home inside a bare mktemp -d, and every operand, sentinel and link
# target sits inside that scratch tree, so even a broken script could reach nothing outside it.
# The script reads HOME only and never expands `~`, so the real ~/.Trash is out of its reach.
#
# Run via: bats scripts/test/ga-trash-purge.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3 (the shared predicate hooks/lib/trash_rm.py).

bats_require_minimum_version 1.5.0

PURGE_SH="${BATS_TEST_DIRNAME}/../ga-trash-purge.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  FAKE_ROOT="$(mktemp -d)"
  # The fake home must differ from the real one before anything runs under it.
  [[ -n "${FAKE_ROOT}" && "${FAKE_ROOT}" != "${HOME}" ]] || return 1
  export HOME="${FAKE_ROOT}/home"
  export GA_DATA_ROOT="${FAKE_ROOT}/data"
  TRASH="${HOME}/.Trash"
  OUTSIDE="${FAKE_ROOT}/outside"
  LOG_FILE="${GA_DATA_ROOT}/logs/trash-purge.log"
  mkdir -p "${TRASH}" "${OUTSIDE}/tree"
  printf 'sentinel\n' >"${OUTSIDE}/sentinel.txt"
  printf 'deep\n' >"${OUTSIDE}/tree/deep.txt"
  # A bystander entry every purge of another entry, and every refusal, must leave alone.
  printf 'keep\n' >"${TRASH}/bystander"
}

teardown() {
  if ga_guard_path "${FAKE_ROOT:-}"; then rm -rf -- "${FAKE_ROOT:?}"; fi
}

# Run the purge from inside the scratch tree, so a relative path the script resolved could only land there.
run_purge() {
  cd "${FAKE_ROOT}" || return 1
  run bash "${PURGE_SH}" "$@"
}

# The outside sentinel tree and the bystander entry are exactly as setup left them.
assert_untouched() {
  [[ "$(cat "${OUTSIDE}/sentinel.txt" 2>/dev/null)" == "sentinel" ]] || { echo "outside sentinel lost"; return 1; }
  [[ "$(cat "${OUTSIDE}/tree/deep.txt" 2>/dev/null)" == "deep" ]] || { echo "outside tree lost"; return 1; }
  [[ "$(cat "${TRASH}/bystander" 2>/dev/null)" == "keep" ]] || { echo "bystander Trash entry lost"; return 1; }
}

# Asserts a refusal: the exit code, a stderr message, and nothing deleted. Args: $1=expected exit code
assert_refused() {
  [[ "${status}" -eq "${1}" ]] || { echo "expected exit ${1}, got ${status}: ${output}"; return 1; }
  [[ "${output}" == *"ga-trash-purge: REFUSED"* ]] || { echo "no refusal message: ${output}"; return 1; }
  [[ ! -e "${LOG_FILE}" ]] || { echo "a refusal wrote a log line: $(cat "${LOG_FILE}")"; return 1; }
  assert_untouched
}

# Asserts the entry is gone, lstat-wise. Args: $1=entry path
assert_gone() {
  [[ ! -e "${1}" && ! -L "${1}" ]] || { echo "entry survived: ${1}"; return 1; }
}

@test "refusal: zero operands, two operands → exit 2" {
  printf 'x\n' >"${TRASH}/a"
  run_purge
  assert_refused 2 || return 1
  run_purge a bystander
  assert_refused 2 || return 1
  [[ -f "${TRASH}/a" ]] || { echo "entry a deleted"; return 1; }
}

@test "refusal: an unset, empty, relative or root HOME → exit 3" {
  local name="ga-trash-purge-unset-home-$$"
  printf 'x\n' >"${TRASH}/${name}"
  cd "${FAKE_ROOT}" || return 1
  run env -u HOME bash "${PURGE_SH}" "${name}"
  assert_refused 3 || return 1
  run env HOME= bash "${PURGE_SH}" "${name}"
  assert_refused 3 || return 1
  run env HOME=home bash "${PURGE_SH}" "${name}"
  assert_refused 3 || return 1
  run env HOME=/ bash "${PURGE_SH}" "${name}"
  assert_refused 3 || return 1
  [[ -f "${TRASH}/${name}" ]] || { echo "entry deleted"; return 1; }
}

@test "refusal: an empty name, '.', '..' or a relative name holding '/' → exit 4" {
  local operand
  mkdir -p "${TRASH}/dir"
  printf 'x\n' >"${TRASH}/dir/inner"
  for operand in '' '.' '..' 'dir/inner' './bystander' "${TRASH#/}/bystander"; do
    run_purge "${operand}"
    assert_refused 4 || { echo "operand: '${operand}'"; return 1; }
  done
  [[ -f "${TRASH}/dir/inner" ]] || { echo "nested file deleted"; return 1; }
}

@test "refusal: the Trash directory itself, in every spelling → exit 5" {
  local operand
  # shellcheck disable=SC2016,SC2088  # literal ~ / $HOME text the script must recognise, never expanded here
  for operand in "${TRASH}" "${TRASH}/" "${TRASH}//" '~/.Trash' '~/.Trash/' '$HOME/.Trash' '${HOME}/.Trash/'; do
    run_purge "${operand}"
    assert_refused 5 || { echo "operand: '${operand}'"; return 1; }
  done
  [[ -d "${TRASH}" ]] || { echo "Trash removed"; return 1; }
}

@test "refusal: a path outside the Trash or deeper than one level → exit 6" {
  local operand
  mkdir -p "${TRASH}/dir/sub" "${HOME}/Documents"
  printf 'x\n' >"${TRASH}/dir/sub/inner"
  # shellcheck disable=SC2016,SC2088  # literal ~ / $HOME text the script must judge, never expanded here
  for operand in "${OUTSIDE}/sentinel.txt" "${OUTSIDE}" "${HOME}/Documents" '~/Documents' '$HOME/Documents' \
    "${TRASH}/dir/sub" "${TRASH}/dir/" '~/.Trash/dir/sub' "${TRASH}/../Documents" '~/.Trash/../Documents' \
    "${HOME}//.Trash/bystander" "${HOME}/./.Trash/bystander" '/' '//'; do
    run_purge "${operand}"
    assert_refused 6 || { echo "operand: '${operand}'"; return 1; }
  done
  [[ -f "${TRASH}/dir/sub/inner" && -d "${HOME}/Documents" ]] || { echo "a deeper or outside path was deleted"; return 1; }
}

@test "refusal: a Trash that is a symlink or not a directory → exit 7" {
  printf 'x\n' >"${OUTSIDE}/victim"
  # A second fake home whose Trash links to the outside tree: a purge that followed it would reach victim.
  export HOME="${FAKE_ROOT}/home-linked"
  mkdir -p "${HOME}"
  ln -s "${OUTSIDE}" "${HOME}/.Trash"
  run_purge victim
  assert_refused 7 || { echo "symlinked Trash"; return 1; }
  [[ -f "${OUTSIDE}/victim" ]] || { echo "followed the Trash link"; return 1; }
  # A third fake home whose Trash is a regular file.
  export HOME="${FAKE_ROOT}/home-file"
  mkdir -p "${HOME}"
  printf 'not a dir\n' >"${HOME}/.Trash"
  run_purge victim
  assert_refused 7 || { echo "file Trash"; return 1; }
  [[ "$(cat "${HOME}/.Trash")" == "not a dir" ]] || { echo "file Trash touched"; return 1; }
}

@test "refusal: an entry that does not exist → exit 8" {
  run_purge no-such-entry
  assert_refused 8 || return 1
  run_purge "${TRASH}/no-such-entry"
  assert_refused 8 || return 1
}

@test "refusal: a name the shared predicate denies → exit 9, the entry survives" {
  local name
  for name in 'shot (1).png' 'star*name' 'semi;colon'; do
    printf 'x\n' >"${TRASH}/${name}"
    run_purge "${name}"
    assert_refused 9 || { echo "name: '${name}'"; return 1; }
    [[ -f "${TRASH}/${name}" ]] || { echo "denied entry deleted: '${name}'"; return 1; }
  done
}

@test "purge: a directory entry with nested contents, by bare name → exit 0, only it goes" {
  mkdir -p "${TRASH}/old-build/sub"
  printf 'x\n' >"${TRASH}/old-build/sub/f"
  run_purge old-build
  [[ "${status}" -eq 0 ]] || { echo "exit ${status}: ${output}"; return 1; }
  assert_gone "${TRASH}/old-build" || return 1
  assert_untouched
}

@test "purge: a file entry, by absolute path → exit 0" {
  printf 'x\n' >"${TRASH}/notes.txt"
  run_purge "${TRASH}/notes.txt"
  [[ "${status}" -eq 0 ]] || { echo "exit ${status}: ${output}"; return 1; }
  assert_gone "${TRASH}/notes.txt" || return 1
  assert_untouched
}

@test "purge: a name with spaces, by each literal home spelling → exit 0" {
  local operand
  # shellcheck disable=SC2016,SC2088  # literal ~ / $HOME text the script must recognise, never expanded here
  for operand in '~/.Trash/old build' '$HOME/.Trash/old build' '${HOME}/.Trash/old build' 'old build'; do
    mkdir -p "${TRASH}/old build"
    run_purge "${operand}"
    [[ "${status}" -eq 0 ]] || { echo "operand '${operand}': exit ${status}: ${output}"; return 1; }
    assert_gone "${TRASH}/old build" || return 1
  done
  assert_untouched
}

@test "purge: a dangling symlink entry is removed as the link itself" {
  ln -s "${FAKE_ROOT}/never-existed" "${TRASH}/dangling"
  run_purge dangling
  [[ "${status}" -eq 0 ]] || { echo "exit ${status}: ${output}"; return 1; }
  assert_gone "${TRASH}/dangling" || return 1
  assert_untouched
}

@test "purge: a symlink entry to an outside directory removes the link, the directory survives" {
  ln -s "${OUTSIDE}" "${TRASH}/docs-link"
  run_purge docs-link
  [[ "${status}" -eq 0 ]] || { echo "exit ${status}: ${output}"; return 1; }
  assert_gone "${TRASH}/docs-link" || return 1
  [[ -d "${OUTSIDE}/tree" ]] || { echo "outside dir followed"; return 1; }
  assert_untouched
}

@test "log: one line per purge with time, kind, size, name and the caller's cwd" {
  mkdir -p "${TRASH}/a dir"
  printf 'x\n' >"${TRASH}/a-file"
  ln -s "${OUTSIDE}" "${TRASH}/a-link"
  run_purge 'a dir'
  [[ "${status}" -eq 0 ]] || { echo "dir: ${status}: ${output}"; return 1; }
  run_purge a-file
  [[ "${status}" -eq 0 ]] || { echo "file: ${status}: ${output}"; return 1; }
  run_purge a-link
  [[ "${status}" -eq 0 ]] || { echo "link: ${status}: ${output}"; return 1; }
  local -a lines_read=()
  local line
  while IFS= read -r line; do lines_read+=("${line}"); done <"${LOG_FILE}"
  [[ "${#lines_read[@]}" -eq 3 ]] || { echo "expected 3 log lines: $(cat "${LOG_FILE}")"; return 1; }
  local cwd_q name_q
  cwd_q="$(printf '%q' "${FAKE_ROOT}")"
  name_q="$(printf '%q' 'a dir')"
  [[ "${lines_read[0]}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]] || { echo "time: ${lines_read[0]}"; return 1; }
  [[ "${lines_read[0]}" == *$'\tpurge\tkind=dir\tkib='[0-9]*$'\tname='"${name_q}"$'\tcwd='"${cwd_q}" ]] \
    || { echo "dir line: ${lines_read[0]}"; return 1; }
  [[ "${lines_read[1]}" == *$'\tkind=file\tkib='[0-9]*$'\tname=a-file\tcwd='* ]] || { echo "file line: ${lines_read[1]}"; return 1; }
  [[ "${lines_read[2]}" == *$'\tkind=link\tkib='*$'\tname=a-link\tcwd='* ]] || { echo "link line: ${lines_read[2]}"; return 1; }
}
