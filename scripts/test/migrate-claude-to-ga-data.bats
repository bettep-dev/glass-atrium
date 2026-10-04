#!/usr/bin/env bats
# migrate-claude-to-ga-data.bats — pins the T6 Tier-A migration op (D2/D3, PIN-B) + the
# ga-doctor.sh D6 relocation-correctness check. Two surfaces:
#   (a) scripts/migrate-claude-to-ga-data.sh — invoked DIRECTLY as a command (shebang + exec bit),
#       never interpreter-prefixed. Fixture-root SANDBOX mode (GA_MIGRATE_SRC_ROOT set) skips the
#       host-global launchd/tmux lifecycle; the host-lifecycle rows run it against PATH-recorded
#       launchctl/tmux under a scratch HOME, so no test ever touches real dirs or launchd/tmux.
#   (b) lib/ga-doctor.sh data_sep_leftover_scan — sourced with a stub `log`, exercised against
#       fixture roots.
#
# fails-at-HEAD: the migration script + the data_sep_leftover_scan function are NEW at HEAD, so a
# direct invocation (127 command-not-found) / an undefined-function call FAILS every @test below;
# they PASS only after this task lands.
#
# Run via: bats scripts/test/migrate-claude-to-ga-data.bats
# Hermetic: HOME + all three migrate seams point at a per-test mktemp sandbox.
#
# Each assertion uses a `|| return 1` fail-fast guard: @test bodies run under errexit, but a bare
# mid-body `[[ ]]` / `(( ))` is exempt on macOS bash 3.2.57 and DOES gate on Linux bash 5.3.9 in CI
# (measured, bats 1.13.0 both legs — bash is the variable, not bats), so an unguarded intermediate
# assertion would be silently masked locally by a later passing one.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
SCRIPT="${GA}/scripts/migrate-claude-to-ga-data.sh"
DOCTOR_LIB="${GA}/lib/ga-doctor.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  SANDBOX="$(mktemp -d -t migrate-ga-data.XXXXXX)"
  SRC="${SANDBOX}/.claude"
  DST="${SANDBOX}/.glass-atrium"
  TRASH="${SANDBOX}/Trash"
  mkdir -p "${SRC}" "${DST}" "${TRASH}"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# run the migration op as a DIRECT command in fixture-root SANDBOX mode.
run_migrate() {
  run env GA_MIGRATE_SRC_ROOT="${SRC}" GA_MIGRATE_DEST_ROOT="${DST}" \
    GA_MIGRATE_TRASH_DIR="${TRASH}" HOME="${SANDBOX}" \
    "${SCRIPT}" "$@"
}

@test "migrate: relocates an enumerated Tier-A data dir to the new root" {
  mkdir -p "${SRC}/data/outcomes"
  printf 'rec\n' >"${SRC}/data/outcomes/rec1.json"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${DST}/data/outcomes/rec1.json" ]] || { echo "not relocated" >&2; return 1; }
  [[ ! -e "${SRC}/data/outcomes" ]] || { echo "source dir not removed" >&2; return 1; }
}

@test "migrate: relocates an enumerated Tier-A file to the new root" {
  mkdir -p "${SRC}/data"
  printf '{}\n' >"${SRC}/data/wiki-dedup-verified-hashes.json"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${DST}/data/wiki-dedup-verified-hashes.json" ]] || { echo "file not relocated" >&2; return 1; }
  [[ ! -e "${SRC}/data/wiki-dedup-verified-hashes.json" ]] || { echo "source file not removed" >&2; return 1; }
}

@test "migrate: idempotent — a second run against a migrated tree is a clean no-op" {
  mkdir -p "${SRC}/data/learning"
  printf 'x\n' >"${SRC}/data/learning/state"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "run1 status=${status}" >&2; return 1; }
  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "run2 status=${status} output=${output}" >&2; return 1; }
  [[ -f "${DST}/data/learning/state" ]] || { echo "state lost across re-run" >&2; return 1; }
}

@test "migrate: enumeration — leaves Tier-C data/update in place (never blanket-moves data/)" {
  mkdir -p "${SRC}/data/update/base-agents" "${SRC}/data/outcomes"
  printf 'baseline\n' >"${SRC}/data/update/base-agents/agent.md"
  printf 'rec\n' >"${SRC}/data/outcomes/o1"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  # enumerated store moved …
  [[ -f "${DST}/data/outcomes/o1" ]] || { echo "outcomes not migrated" >&2; return 1; }
  # … Tier-C spine baseline UNTOUCHED under the legacy root.
  [[ -f "${SRC}/data/update/base-agents/agent.md" ]] || { echo "Tier-C data/update was moved" >&2; return 1; }
  [[ ! -e "${DST}/data/update" ]] || { echo "Tier-C data/update leaked to new root" >&2; return 1; }
}

@test "migrate: merge-idempotent — a pre-existing dest dir merges per-entry (no BSD nesting)" {
  mkdir -p "${SRC}/data/session-spawns" "${DST}/data/session-spawns"
  printf 'new\n' >"${SRC}/data/session-spawns/sess-new"
  printf 'old\n' >"${DST}/data/session-spawns/sess-old"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${DST}/data/session-spawns/sess-new" ]] || { echo "new entry not merged in" >&2; return 1; }
  [[ -f "${DST}/data/session-spawns/sess-old" ]] || { echo "pre-existing entry clobbered" >&2; return 1; }
  # a blind dir-to-dir mv would have nested the source under the target on BSD.
  [[ ! -e "${DST}/data/session-spawns/session-spawns" ]] || { echo "BSD nest artifact present" >&2; return 1; }
}

@test "migrate: .apply-lock is regenerable — Trashed, never migrated" {
  mkdir -p "${SRC}/data/daemon-reports/.apply-lock"
  printf '12345\n' >"${SRC}/data/daemon-reports/.apply-lock/pid"
  printf 'report\n' >"${SRC}/data/daemon-reports/applied-2026-07-21.jsonl"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  # the real report moved …
  [[ -f "${DST}/data/daemon-reports/applied-2026-07-21.jsonl" ]] || { echo "report not migrated" >&2; return 1; }
  # … the regenerable lock did NOT land at the new root …
  [[ ! -e "${DST}/data/daemon-reports/.apply-lock" ]] || { echo ".apply-lock was migrated" >&2; return 1; }
  # … it went to Trash instead of being rm'd.
  run bash -c 'ls -A "$1" 2>/dev/null | grep -q .apply-lock' _ "${TRASH}"
  [[ "${status}" -eq 0 ]] || { echo ".apply-lock not found in Trash" >&2; return 1; }
}

@test "migrate: a stale duplicate file is Trashed (dest wins), never rm'd" {
  mkdir -p "${SRC}/data" "${DST}/data"
  printf 'source-copy\n' >"${SRC}/data/wiki-dedup-verified-hashes.json"
  printf 'dest-copy\n' >"${DST}/data/wiki-dedup-verified-hashes.json"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  # dest is authoritative — unchanged …
  run cat "${DST}/data/wiki-dedup-verified-hashes.json"
  [[ "${output}" == "dest-copy" ]] || { echo "dest overwritten: ${output}" >&2; return 1; }
  # … the source dup is gone from the legacy root …
  [[ ! -e "${SRC}/data/wiki-dedup-verified-hashes.json" ]] || { echo "stale source dup not removed" >&2; return 1; }
  # … and recoverable in Trash.
  run bash -c 'ls -A "$1" 2>/dev/null | grep -q wiki-dedup-verified-hashes.json' _ "${TRASH}"
  [[ "${status}" -eq 0 ]] || { echo "stale dup not found in Trash" >&2; return 1; }
}

@test "migrate: --dry-run mutates nothing" {
  mkdir -p "${SRC}/data/outcomes"
  printf 'rec\n' >"${SRC}/data/outcomes/o1"

  run_migrate --dry-run
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${SRC}/data/outcomes/o1" ]] || { echo "dry-run moved the source" >&2; return 1; }
  [[ ! -e "${DST}/data/outcomes/o1" ]] || { echo "dry-run wrote the dest" >&2; return 1; }
}

@test "migrate: rejects an unknown argument (exit 2)" {
  run_migrate --bogus
  [[ "${status}" -eq 2 ]] || { echo "expected exit 2, got ${status}" >&2; return 1; }
}

@test "migrate: fixture-root SANDBOX mode skips the host launchd/tmux lifecycle" {
  mkdir -p "${SRC}/data"
  printf '{}\n' >"${SRC}/data/wiki-dedup-verified-hashes.json"

  run_migrate
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"sandbox mode"* ]] || { echo "no sandbox-skip note: ${output}" >&2; return 1; }
  # the host-global quiesce (launchctl bootout) MUST NOT run under a fixture root.
  [[ "${output}" != *"quiesce: booted out"* ]] || { echo "launchctl bootout ran in sandbox" >&2; return 1; }
  [[ "${output}" != *"resume: bootstrapped"* ]] || { echo "launchctl bootstrap ran in sandbox" >&2; return 1; }
}

# --- host lifecycle (non-sandbox) against PATH recorders + a scratch HOME ----------

# Print a lib/ga-env.sh roster array, one entry per line; GA_PG_SOCKET seals the socket freeze.
get_roster() {
  # shellcheck disable=SC2016  # the child shell expands its own positional args
  env GA_PG_SOCKET="${SANDBOX}" bash -c 'set -u; source "$1/lib/ga-env.sh" && ga_init_env "$1" >/dev/null 2>&1 \
    && list="$2[@]" && printf "%s\n" "${!list}"' _ "${GA}" "$1"
}

# Run the op without GA_MIGRATE_SRC_ROOT (host lifecycle on) against recording launchctl/tmux stubs.
# Every retired label has a deployed plist and every retired session is present, so resume and
# quiesce both see the residue a not-yet-cleaned install holds.
run_migrate_host_lifecycle() {
  local bin="${SANDBOX}/bin" agents="${SANDBOX}/Library/LaunchAgents" job
  REC="${SANDBOX}/rec"
  mkdir -p "${bin}" "${agents}"
  : >"${REC}"
  printf '#!/bin/bash\nprintf "launchctl %%s\\n" "$*" >>"%s"\n' "${REC}" >"${bin}/launchctl"
  printf '#!/bin/bash\nprintf "tmux %%s\\n" "$*" >>"%s"\n' "${REC}" >"${bin}/tmux"
  chmod +x "${bin}/launchctl" "${bin}/tmux"
  RETIRED="$(get_roster LAUNCHD_RETIRED_JOBS)" || { echo "lib/ga-env.sh defines no LAUNCHD_RETIRED_JOBS"; return 1; }
  SESSIONS="$(get_roster GA_DAEMON_SESSIONS)" || { echo "lib/ga-env.sh defines no GA_DAEMON_SESSIONS"; return 1; }
  for job in ${RETIRED} monitor; do
    printf 'plist\n' >"${agents}/com.glass-atrium.${job}.plist"
  done
  run env -u GA_MIGRATE_SRC_ROOT GA_MIGRATE_DEST_ROOT="${DST}" GA_MIGRATE_TRASH_DIR="${TRASH}" \
    HOME="${SANDBOX}" PATH="${bin}:${PATH}" "${SCRIPT}"
}

@test "migrate: quiesce boots out every retired label and kills every retired session" {
  run_migrate_host_lifecycle
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  local job sess
  for job in ${RETIRED}; do
    grep -qxF "launchctl bootout gui/${UID}/com.glass-atrium.${job}" "${REC}" \
      || { echo "retired ${job} not booted out"; cat "${REC}"; return 1; }
  done
  for sess in ${SESSIONS}; do
    grep -qxF "tmux kill-session -t ${sess}" "${REC}" \
      || { echo "retired session ${sess} not killed"; cat "${REC}"; return 1; }
  done
}

@test "migrate: resume restarts an active writer but never a retired label whose plist is deployed" {
  run_migrate_host_lifecycle
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  grep -qxF "launchctl bootstrap gui/${UID} ${SANDBOX}/Library/LaunchAgents/com.glass-atrium.monitor.plist" "${REC}" \
    || { echo "active writer monitor not resumed"; cat "${REC}"; return 1; }
  local job
  for job in ${RETIRED}; do
    ! grep -qE "^launchctl (bootstrap|kickstart) .*com\.glass-atrium\.${job}(\.plist)?$" "${REC}" \
      || { echo "retired ${job} restarted"; cat "${REC}"; return 1; }
  done
}

# --- ga-doctor.sh D6 data_sep_leftover_scan (sourced, stub log) ----------------

# call the doctor helper with a silenced log; $output == the stale-count verdict.
run_scan_count() {
  run --separate-stderr env -u GA_ROOT bash -c '
    log() { :; }
    # shellcheck source=/dev/null
    source "$1"
    data_sep_leftover_scan "$2"
  ' _ "${DOCTOR_LIB}" "$1"
}

@test "doctor: data_sep_leftover_scan counts Tier-A leftovers under the legacy root" {
  mkdir -p "${SRC}/data/outcomes"
  printf '{}\n' >"${SRC}/data/wiki-dedup-verified-hashes.json"

  run_scan_count "${SRC}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} stderr=${stderr}" >&2; return 1; }
  [[ "${output}" == "2" ]] || { echo "expected 2 leftovers, got ${output}" >&2; return 1; }
}

@test "doctor: data_sep_leftover_scan ignores deferred Tier-B/C paths (no false warn)" {
  # Tier-C nested spine baseline + Tier-B monitor logs — intentionally deferred, NOT enumerated.
  mkdir -p "${SRC}/data/update/base-agents" "${SRC}/logs"
  printf 'baseline\n' >"${SRC}/data/update/base-agents/agent.md"
  printf 'log\n' >"${SRC}/logs/monitor.out.log"
  printf 'log\n' >"${SRC}/logs/monitor.err.log"

  run_scan_count "${SRC}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} stderr=${stderr}" >&2; return 1; }
  [[ "${output}" == "0" ]] || { echo "deferred Tier-B/C false-tripped the warn: ${output}" >&2; return 1; }
}
