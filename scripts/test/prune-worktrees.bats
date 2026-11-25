#!/usr/bin/env bats
# prune-worktrees.bats — the worktree close-out: a linked worktree is removed only under --apply and
# only when all five parts pass; every other worktree is kept with its failing part named.
# Scratch repositories only, under one bare mktemp -d; the lock and live-agent stores are sandboxed per test.

PRUNE_SH="${BATS_TEST_DIRNAME}/../prune-worktrees.sh"
LOCK_LIB="${BATS_TEST_DIRNAME}/../../hooks/lib/worktree-lock.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

setup() {
  PW_TMP="$(mktemp -d)"
  # Canonical spelling (/private/var on macOS) — the one git and lsof report.
  PW_TMP="$(cd -P -- "${PW_TMP}" && pwd -P)"
  REPO="${PW_TMP}/repo"
  export WORKTREE_LOCK_DIR="${PW_TMP}/locks"
  export GA_DATA_ROOT="${PW_TMP}/ga"
  LIVE_DIR="${GA_DATA_ROOT}/data/live-children"
  export GA_PRUNE_WORKTREES_TERM_WAIT_SECS=2
  unset WORKTREE_LOCK_TTL_SECS
  STARTED_PIDS=()
  git init -q -b main "${REPO}"
  printf 'build/\n' >"${REPO}/.gitignore"
  printf 'one\n' >"${REPO}/tracked.txt"
  git -C "${REPO}" add .gitignore tracked.txt
  repo_commit "${REPO}" init
}

teardown() {
  local pid
  for pid in "${STARTED_PIDS[@]:-}"; do
    [[ -n "${pid}" ]] && kill -KILL "${pid}" 2>/dev/null
  done
  true
  if ga_guard_path "${PW_TMP:-}"; then rm -rf -- "${PW_TMP:?}"; fi
}

repo_commit() {
  git -C "${1}" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m "${2}"
}

# Linked worktree on its own branch at main's tip, so it starts contained and clean.
add_worktree() {
  git -C "${REPO}" worktree add -q -b "${1}" "${PW_TMP}/${1}"
  printf '%s\n' "${PW_TMP}/${1}"
}

# A writer lock stamped the way the PreToolUse arm stamps it, under the sandboxed store.
hold_lock() {
  (
    # shellcheck source=/dev/null
    source "${LOCK_LIB}"
    worktree_lock_dir_for "${1}"
    mkdir -p -- "${worktree_lock_dir_out}"
    printf 'agent-live\n' >"${worktree_lock_dir_out}/holder"
    printf '%s\n' "${worktree_lock_dir_out}"
  )
}

# Starts a process whose cwd is $1; $2 = the command. Returns once lsof sees the cwd.
start_inside() {
  local wt="${1}" pid tries=0
  shift
  (cd -- "${wt}" && exec "$@") </dev/null >/dev/null 2>&1 3>&- &
  pid=$!
  STARTED_PIDS+=("${pid}")
  until [[ "$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null)" == *"n${wt}"* ]]; do
    tries=$((tries + 1))
    ((tries < 50)) || { echo "process ${pid} never reached ${wt}"; return 1; }
    sleep 0.1
  done
  INSIDE_PID="${pid}"
}

# Starts $2... with its cwd in $1 as the child of a stand-in Claude session process, the way an agent's
# Bash call runs; a symlink keeps the name `claude` in its argv. Sets INSIDE_PID.
start_under_session() {
  local wt="${1}"
  shift
  make_session_launcher
  "${PW_TMP}/bin/claude" -c '(cd -- "$1" && shift 2 && exec "$@") & printf "%s\n" "$!" >"$2"; wait' \
    _ "${wt}" "${PW_TMP}/child.pid" "$@" </dev/null >/dev/null 2>&1 3>&- &
  STARTED_PIDS+=("$!")
  wait_for_child_inside "${wt}"
}

make_session_launcher() {
  mkdir -p "${PW_TMP}/bin"
  ln -sf "$(command -v bash)" "${PW_TMP}/bin/claude"
}

# Runs prune --apply on $1 from a stand-in Claude session that also holds $2... with its cwd in $1, so the
# process inside runs under the caller's own session; child.pid names that process.
prune_in_own_session() {
  local wt="${1}"
  shift
  make_session_launcher
  "${PW_TMP}/bin/claude" -c '
    (cd -- "$1" && shift 3 && exec "$@") </dev/null >/dev/null 2>&1 3>&- &
    printf "%s\n" "$!" >"$2"
    tries=0
    until [[ "$(lsof -a -p "$!" -d cwd -Fn 2>/dev/null)" == *"n$1"* ]]; do
      tries=$((tries + 1))
      ((tries < 50)) || exit 99
      sleep 0.1
    done
    bash "$3" --apply "$1"
    exit "$?"' _ "${wt}" "${PW_TMP}/child.pid" "${PRUNE_SH}" "$@"
}

# Starts $2... with its cwd in $1 detached from every session: its parent exits, so it is reparented.
start_detached_inside() {
  local wt="${1}"
  shift
  (
    (cd -- "${wt}" && exec "$@") </dev/null >/dev/null 2>&1 3>&- &
    printf '%s\n' "$!" >"${PW_TMP}/child.pid"
  )
  wait_for_child_inside "${wt}"
}

wait_for_child_inside() {
  local tries=0
  INSIDE_PID=""
  until [[ -n "${INSIDE_PID}" && "$(lsof -a -p "${INSIDE_PID}" -d cwd -Fn 2>/dev/null)" == *"n${1}"* ]]; do
    tries=$((tries + 1))
    ((tries < 50)) || { echo "no child reached ${1}"; return 1; }
    sleep 0.1
    [[ -s "${PW_TMP}/child.pid" ]] && INSIDE_PID="$(<"${PW_TMP}/child.pid")"
  done
  STARTED_PIDS+=("${INSIDE_PID}")
  rm -- "${PW_TMP}/child.pid"
}

# A live-child marker as agent-tracker.sh's SubagentStart arm writes it.
mark_live_agent() {
  mkdir -p "${LIVE_DIR}"
  : >"${LIVE_DIR}/${1}"
  printf '%s\n' "${LIVE_DIR}/${1}"
}

is_registered() {
  [[ "$(git -C "${REPO}" worktree list --porcelain)" == *"worktree ${1}"$'\n'* ]]
}

@test "without --apply a passing worktree is only listed as removable" {
  local wt
  wt="$(add_worktree feat)"

  run bash "${PRUNE_SH}" "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"would remove: ${wt}"* ]] || { echo "not listed: ${output}"; return 1; }
  [ -d "${wt}" ] || { echo "dry run removed the directory"; return 1; }
  is_registered "${wt}" || { echo "dry run unregistered the worktree"; return 1; }
}

@test "--apply removes a passing worktree with its ignored build output and keeps its branch" {
  local wt
  wt="$(add_worktree feat)"
  mkdir -p "${wt}/build"
  printf 'artifact\n' >"${wt}/build/out.bin"

  run bash "${PRUNE_SH}" --apply "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"removed: ${wt}"* ]] || { echo "not reported removed: ${output}"; return 1; }
  [ ! -e "${wt}" ] || { echo "directory survived: ${output}"; return 1; }
  ! is_registered "${wt}" || { echo "still registered: ${output}"; return 1; }
  git -C "${REPO}" rev-parse --verify -q refs/heads/feat >/dev/null || { echo "branch deleted"; return 1; }
}

@test "--apply keeps each worktree that fails a safe-test part and names that part" {
  local -a rows=(unmerged dirty untracked locked)
  local row wt
  for row in "${rows[@]}"; do
    wt="$(add_worktree "${row}")"
    case "${row}" in
      unmerged) repo_commit "${wt}" "work not in main" ;;
      dirty) printf 'two\n' >>"${wt}/tracked.txt" ;;
      untracked) printf 'new\n' >"${wt}/new.txt" ;;
      locked) hold_lock "${wt}" >/dev/null ;;
    esac
  done

  local -a expect=(
    'unmerged|contained: fail'
    'dirty|clean: fail'
    'untracked|clean: fail'
    'locked|skipped: live writer lock held by agent-live'
  )
  local pair reason
  for pair in "${expect[@]}"; do
    row="${pair%%|*}"
    reason="${pair#*|}"
    wt="${PW_TMP}/${row}"
    run bash "${PRUNE_SH}" --apply "${wt}"
    [ "${status}" -eq 0 ] || { echo "${row}: exit ${status}: ${output}"; return 1; }
    [[ "${output}" == *"${reason}"* ]] || { echo "${row}: reason missing: ${output}"; return 1; }
    [[ "${output}" == *"kept: ${wt}"* ]] || { echo "${row}: not reported kept: ${output}"; return 1; }
    [ -d "${wt}" ] || { echo "${row}: removed: ${output}"; return 1; }
  done
}

@test "a lock aged past its TTL does not hold the worktree" {
  local wt lock
  wt="$(add_worktree feat)"
  lock="$(hold_lock "${wt}")"
  touch -t 202001010000 "${lock}"
  export WORKTREE_LOCK_TTL_SECS=60

  run bash "${PRUNE_SH}" --apply "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"removed: ${wt}"* ]] || { echo "stale lock kept it: ${output}"; return 1; }
}

@test "without --apply a process inside is listed, left running, and keeps the worktree" {
  local wt
  wt="$(add_worktree feat)"
  start_inside "${wt}" sleep 300

  run bash "${PRUNE_SH}" "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"processes: fail"*"pid=${INSIDE_PID} "* ]] || { echo "not listed: ${output}"; return 1; }
  [[ "${output}" == *"kept: ${wt}"* ]] || { echo "not kept: ${output}"; return 1; }
  kill -0 "${INSIDE_PID}" || { echo "dry run stopped the process"; return 1; }
}

@test "--apply leaves a process inside a live-locked worktree running" {
  local wt
  wt="$(add_worktree feat)"
  hold_lock "${wt}" >/dev/null
  start_inside "${wt}" sleep 300

  run bash "${PRUNE_SH}" --apply "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  kill -0 "${INSIDE_PID}" || { echo "process stopped despite the live lock: ${output}"; return 1; }
  [[ "${output}" == *"skipped: live writer lock"* ]] || { echo "skip not reported: ${output}"; return 1; }
  [ -d "${wt}" ] || { echo "removed despite the live lock"; return 1; }
}

@test "--apply stops a process inside with TERM, reports it, then removes the worktree" {
  local wt
  wt="$(add_worktree feat)"
  start_inside "${wt}" sleep 300

  run bash "${PRUNE_SH}" --apply "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"stopped: pid=${INSIDE_PID} "*"cwd=${wt}"* ]] || { echo "stop not reported: ${output}"; return 1; }
  ! kill -0 "${INSIDE_PID}" 2>/dev/null || { echo "process still running"; return 1; }
  [[ "${output}" == *"removed: ${wt}"* ]] || { echo "not removed: ${output}"; return 1; }
}

@test "--apply reports a process that survives TERM, sends no KILL, and keeps the worktree" {
  local wt
  wt="$(add_worktree feat)"
  start_inside "${wt}" perl -e '$SIG{TERM} = "IGNORE"; sleep 300'

  run bash "${PRUNE_SH}" --apply "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"survivor: pid=${INSIDE_PID} "* ]] || { echo "survivor not reported: ${output}"; return 1; }
  kill -0 "${INSIDE_PID}" || { echo "the survivor was killed"; return 1; }
  [[ "${output}" == *"kept: ${wt}"*"processes: fail"* ]] || { echo "not kept on processes: ${output}"; return 1; }
  [ -d "${wt}" ] || { echo "removed with a survivor inside"; return 1; }
}

@test "--apply stops nothing and removes nothing while another session or a live agent may own a process inside" {
  local -a rows=(
    'live agent, process under the caller own session|live|own|kept'
    'agent marker past its TTL, process under the caller own session|stale|own|removed'
    'live agent, process under no session|live|none|removed'
    'agent marker past its TTL, process under another session|stale|other|kept'
    'live agent, process under another session|live|other|kept'
  )
  local row name agent session outcome wt marker n=0
  for row in "${rows[@]}"; do
    IFS='|' read -r name agent session outcome <<<"${row}"
    n=$((n + 1))
    marker="$(mark_live_agent "agent-${n}")"
    [[ "${agent}" == live ]] || touch -t 202001010000 "${marker}"
    wt="$(add_worktree "row${n}")"
    case "${session}" in
      own)
        run prune_in_own_session "${wt}" sleep 300
        [[ -s "${PW_TMP}/child.pid" ]] || { echo "${name}: not started: ${output}"; return 1; }
        INSIDE_PID="$(<"${PW_TMP}/child.pid")"
        STARTED_PIDS+=("${INSIDE_PID}")
        rm -- "${PW_TMP}/child.pid"
        ;;
      other)
        start_under_session "${wt}" sleep 300 || { echo "${name}: not started"; return 1; }
        run bash "${PRUNE_SH}" --apply "${wt}"
        ;;
      none)
        start_detached_inside "${wt}" sleep 300 || { echo "${name}: not started"; return 1; }
        run bash "${PRUNE_SH}" --apply "${wt}"
        ;;
    esac
    [ "${status}" -eq 0 ] || { echo "${name}: exit ${status}: ${output}"; return 1; }

    if [[ "${outcome}" == kept ]]; then
      kill -0 "${INSIDE_PID}" || { echo "${name}: process stopped: ${output}"; return 1; }
      [[ "${output}" == *"skipped: "*"pid=${INSIDE_PID}"* ]] || { echo "${name}: skip not reported: ${output}"; return 1; }
      [[ "${output}" == *"kept: ${wt} — agents: fail"* ]] || { echo "${name}: part not named: ${output}"; return 1; }
      [ -d "${wt}" ] || { echo "${name}: removed: ${output}"; return 1; }
    else
      [[ "${output}" == *"stopped: pid=${INSIDE_PID} "* ]] || { echo "${name}: not stopped: ${output}"; return 1; }
      [[ "${output}" == *"removed: ${wt}"* ]] || { echo "${name}: not removed: ${output}"; return 1; }
    fi
    rm -- "${marker}"
  done
}

@test "--apply never signals another session's process that starts inside after the ownership check" {
  local wt
  wt="$(add_worktree feat)"
  make_session_launcher
  export REAL_LSOF RACE_WT="${wt}" RACE_DIR="${PW_TMP}"
  REAL_LSOF="$(command -v lsof)"
  mkdir -p "${PW_TMP}/shim"
  # First cwd listing answered as is; only then does another session's process start inside.
  cat >"${PW_TMP}/shim/lsof" <<'SHIM'
#!/usr/bin/env bash
n=$(($(cat "${RACE_DIR}/lsof.calls" 2>/dev/null || printf 0) + 1))
printf '%s\n' "${n}" >"${RACE_DIR}/lsof.calls"
rc=0
"${REAL_LSOF}" "$@" || rc=$?
if ((n == 1)); then
  "${RACE_DIR}/bin/claude" -c '(cd -- "$1" && exec sleep 300) & printf "%s\n" "$!" >"$2"; wait' \
    _ "${RACE_WT}" "${RACE_DIR}/child.pid" </dev/null >/dev/null 2>&1 3>&- &
  printf '%s\n' "$!" >"${RACE_DIR}/session.pid"
  tries=0
  until [[ -s "${RACE_DIR}/child.pid" \
    && "$("${REAL_LSOF}" -a -p "$(<"${RACE_DIR}/child.pid")" -d cwd -Fn 2>/dev/null)" == *"n${RACE_WT}"* ]]; do
    tries=$((tries + 1))
    ((tries < 50)) || break
    sleep 0.1
  done
fi
exit "${rc}"
SHIM
  chmod +x "${PW_TMP}/shim/lsof"

  PATH="${PW_TMP}/shim:${PATH}" run bash "${PRUNE_SH}" --apply "${wt}"
  [[ -s "${PW_TMP}/child.pid" ]] || { echo "late process never started: ${output}"; return 1; }
  INSIDE_PID="$(<"${PW_TMP}/child.pid")"
  STARTED_PIDS+=("${INSIDE_PID}" "$(<"${PW_TMP}/session.pid")")
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  kill -0 "${INSIDE_PID}" || { echo "another session's process was signalled: ${output}"; return 1; }
  [[ "${output}" == *"kept: ${wt} — agents: fail (pid=${INSIDE_PID} runs under another Claude session"* ]] \
    || { echo "reason not printed: ${output}"; return 1; }
  [ -d "${wt}" ] || { echo "removed: ${output}"; return 1; }
}

@test "--apply keeps a passing worktree while the live-agent records cannot be read" {
  local wt
  wt="$(add_worktree feat)"
  mkdir -p "${LIVE_DIR}"
  chmod 000 "${LIVE_DIR}"

  run bash "${PRUNE_SH}" --apply "${wt}"
  chmod 755 "${LIVE_DIR}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"kept: ${wt} — agents: fail"* ]] || { echo "part not named: ${output}"; return 1; }
  [[ "${output}" == *"cannot read the live-agent records in ${LIVE_DIR}"* ]] || { echo "fact missing: ${output}"; return 1; }
  [ -d "${wt}" ] || { echo "removed: ${output}"; return 1; }
}

@test "the cwd listing asks lsof to avoid blocking kernel calls and to keep quiet" {
  local wt real
  wt="$(add_worktree feat)"
  real="$(command -v lsof)"
  mkdir -p "${PW_TMP}/shim"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"%s"\nexec "%s" "$@"\n' "${PW_TMP}/lsof.args" "${real}" \
    >"${PW_TMP}/shim/lsof"
  chmod +x "${PW_TMP}/shim/lsof"

  PATH="${PW_TMP}/shim:${PATH}" run bash "${PRUNE_SH}" "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"would remove: ${wt}"* ]] || { echo "listing changed: ${output}"; return 1; }
  [[ -s "${PW_TMP}/lsof.args" ]] || { echo "lsof never called"; return 1; }
  ! grep -v -e '-b ' "${PW_TMP}/lsof.args" | grep -q . || { echo "a call without -b: $(<"${PW_TMP}/lsof.args")"; return 1; }
  ! grep -v -e '-w ' "${PW_TMP}/lsof.args" | grep -q . || { echo "a call without -w: $(<"${PW_TMP}/lsof.args")"; return 1; }
}

@test "a worktree contained only in the --deployed commit passes the containment part" {
  local wt sha
  wt="$(add_worktree feat)"
  repo_commit "${wt}" "deployed but not merged"
  sha="$(git -C "${wt}" rev-parse HEAD)"

  run bash "${PRUNE_SH}" --apply --deployed "${sha}" "${wt}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"removed: ${wt}"* ]] || { echo "deployed leg ignored: ${output}"; return 1; }
}

@test "the main checkout is never a candidate, as an argument or under --list-all" {
  local wt
  wt="$(add_worktree feat)"

  run bash "${PRUNE_SH}" --apply "${REPO}"
  [ "${status}" -eq 3 ] || { echo "exit ${status}: ${output}"; return 1; }
  [[ "${output}" == *"refused: ${REPO}: the main checkout"* ]] || { echo "not refused: ${output}"; return 1; }
  is_registered "${REPO}" || { echo "main checkout touched"; return 1; }

  run bash -c 'cd -- "$1" && bash "$2" --list-all' _ "${REPO}" "${PRUNE_SH}"
  [ "${status}" -eq 0 ] || { echo "list exit ${status}: ${output}"; return 1; }
  [[ "${output}" == *"would remove: ${wt}"* ]] || { echo "linked worktree not listed: ${output}"; return 1; }
  [[ "${output}" != *"worktree: ${REPO}"$'\n'* ]] || { echo "main checkout listed: ${output}"; return 1; }
}

@test "--list-all refuses --apply" {
  run bash -c 'cd -- "$1" && bash "$2" --list-all --apply' _ "${REPO}" "${PRUNE_SH}"
  [ "${status}" -eq 2 ] || { echo "exit ${status}: ${output}"; return 1; }
}

@test "an argument the path guard refuses is reported and removes nothing" {
  local wt
  wt="$(add_worktree feat)"
  local -a rows=('' 'relative/feat' '/')
  local row
  for row in "${rows[@]}"; do
    run bash "${PRUNE_SH}" --apply "${row}"
    [ "${status}" -eq 3 ] || { echo "row '${row}': exit ${status}: ${output}"; return 1; }
    [[ "${output}" == *"refused: "* ]] || { echo "row '${row}': no refusal: ${output}"; return 1; }
  done
  [ -d "${wt}" ] || { echo "a refused argument removed a worktree"; return 1; }
}
