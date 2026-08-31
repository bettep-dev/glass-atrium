#!/usr/bin/env bats
# reconcile-backup-dir.sh — the report-only reconciler (ADR-10).
#
# ADR-6 leaves a backup-path disagreement STANDING rather than resolving it silently, so
# something has to tell the operator what the split is and what their two moves are. This
# suite pins that report and, above everything else, pins that the reconciler MOVES
# NOTHING: every shape asserts the sandbox file set is byte-identical across the run, so a
# mv/cp/rm/mkdir introduced anywhere in the script reds the suite regardless of which
# branch it lands on.
#
# Shapes (AC-C9):
#   1 the resolver writes where the dumps are and no value is being ignored -> rc 0
#   2 a declared value the resolver declined                                -> rc != 0
#   2b a declared value that WON while the dumps stayed behind (silent split) -> rc != 0
#   3 no [paths].backup_dir key at all                                      -> rc 0
#   4 the key declared with an EMPTY value                                  -> rc != 0
#
# Shape 4 is the contract-consistency one: ADR-6 classifies it as case 5 and WARNs, so a
# reconciler that reports it as "(not declared)" and exits 0 contradicts the resolver on
# the one surface an operator is told to run.
#
# Shape 2b is the one a config-vs-resolved string comparison cannot see: the configured
# directory exists, so it is adopted, so the two agree — while the archive at the default
# is stranded outside both the rotation window and any restore search.
#
# Hermetic: every path lives under a mktemp sandbox and GA_DATA_ROOT is pinned into it, so
# the live ~/.glass-atrium backups are never read or touched.
#
# NO LIVE PATH LITERAL: test/db-backup-path-consistency.bats greps every tracked file for
# the stale backup path string, so the fixtures here are sandbox paths only.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict — every assertion
# below `return 1`s with its own message so each fails independently.
#
# Run via: bats test/reconcile-backup-dir.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
SCRIPT="${GA}/scripts/reconcile-backup-dir.sh"
LIB="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${SCRIPT}" ]] || skip "script not found: ${SCRIPT}"
  [[ -f "${LIB}" ]] || skip "config library not found: ${LIB}"
  WORK="$(mktemp -d -t ga-reconcile-bats.XXXXXX)"
  DEFAULT_DIR="${WORK}/ga/backups/postgres"
  ELSEWHERE="${WORK}/elsewhere"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# seed_dumps <dir> <count> — create <count> nightly-shaped dumps with distinct contents.
seed_dumps() {
  local dir="$1" want="$2" i=1
  mkdir -p -- "${dir}"
  while [[ "${i}" -le "${want}" ]]; do
    printf 'DUMP-%s\n' "${i}" >"${dir}/glass_atrium-2026010${i}-000000.dump"
    i=$((i + 1))
  done
}

# write_config <backup_dir value> — or no argument to declare no such key at all.
write_config() {
  {
    printf '[paths]\n'
    printf 'target_home = "%s"\n' "${WORK}/facade"
    [[ $# -eq 0 ]] || printf 'backup_dir = "%s"\n' "$1"
  } >"${WORK}/config.toml"
}

# tree_snapshot — every path under the sandbox plus a checksum per file. Paths catch a
# create, a delete and a rename; the checksums catch a same-name rewrite. Directories are
# included so a stray mkdir of the configured destination is caught too.
# `-exec ... +` rather than a pipe to xargs: with zero matches the command is never run,
# where macOS xargs would invoke cksum with no operands and block on stdin.
tree_snapshot() {
  find "${WORK}" -print | LC_ALL=C sort
  find "${WORK}" -type f -exec cksum {} + | LC_ALL=C sort
}

run_reconcile() {
  run --separate-stderr env -u GA_DB_BACKUP_DIR -u GA_ROOT \
    ATRIUM_CONFIG_LIB="${LIB}" \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash "${SCRIPT}"
}

# assert_untouched <before snapshot> — the file set must be byte-identical after the run.
assert_untouched() {
  local before="$1" after
  after="$(tree_snapshot)"
  [[ "${before}" == "${after}" ]] || {
    printf 'the reconciler changed the tree.\n--- before ---\n%s\n--- after ---\n%s\n' \
      "${before}" "${after}" >&2
    return 1
  }
}

@test "AC-C9(1) the resolver writes where the dumps are -> report, rc 0, nothing touched" {
  local before
  seed_dumps "${DEFAULT_DIR}" 2
  write_config "${DEFAULT_DIR}"
  before="$(tree_snapshot)"

  run_reconcile
  [[ "${status}" -eq 0 ]] || { echo "expected rc 0, got ${status}; out=${output}" >&2; return 1; }
  [[ "${output}" == *"nothing to reconcile"* ]] || {
    echo "no reconciled line in the report; out=${output}" >&2
    return 1
  }
  assert_untouched "${before}"
}

@test "AC-C9(2) a declined value -> both paths, both censuses, two options, rc != 0" {
  local before
  # ADR-6 case 4: absolute, elsewhere, directory ABSENT, dumps already at the default.
  seed_dumps "${DEFAULT_DIR}" 3
  write_config "${ELSEWHERE}"
  before="$(tree_snapshot)"

  run_reconcile
  [[ "${status}" -ne 0 ]] || { echo "expected a non-zero rc; out=${output}" >&2; return 1; }
  # the configured value, the resolved value …
  [[ "${output}" == *"${ELSEWHERE}"* ]] || { echo "configured value absent from the report" >&2; return 1; }
  [[ "${output}" == *"${DEFAULT_DIR}"* ]] || { echo "resolved value absent from the report" >&2; return 1; }
  # … the census at BOTH locations …
  [[ "${output}" == *"${ELSEWHERE} (directory absent)"* ]] || {
    echo "no census line for the configured location; out=${output}" >&2
    return 1
  }
  [[ "${output}" == *"3 dump(s)"* ]] || {
    echo "no dump census for the resolved location; out=${output}" >&2
    return 1
  }
  # … and the two moves the operator can make.
  [[ "${output}" == *"Option 1"* && "${output}" == *"Option 2"* ]] || {
    echo "the two operator options are not both present; out=${output}" >&2
    return 1
  }
  assert_untouched "${before}"
}

@test "AC-C9(2b) a value that WON while the dumps stayed behind -> rc != 0, nothing touched" {
  local before
  # The silent split: the configured directory EXISTS, so ADR-6 adopts it and the config
  # agrees with the resolved value — while every dump sits at the default.
  mkdir -p -- "${ELSEWHERE}"
  seed_dumps "${DEFAULT_DIR}" 2
  write_config "${ELSEWHERE}"
  before="$(tree_snapshot)"

  run_reconcile
  [[ "${status}" -ne 0 ]] || {
    echo "a config that agrees with the resolver still stranded the dumps, but rc was 0; out=${output}" >&2
    return 1
  }
  [[ "${output}" == *"2 dump(s) sit at ${DEFAULT_DIR}"* ]] || {
    echo "the stranded archive is not named in the report; out=${output}" >&2
    return 1
  }
  assert_untouched "${before}"
}

@test "AC-C9(3) no [paths].backup_dir key -> report, rc 0, nothing touched" {
  local before
  seed_dumps "${DEFAULT_DIR}" 1
  write_config
  before="$(tree_snapshot)"

  run_reconcile
  [[ "${status}" -eq 0 ]] || { echo "expected rc 0, got ${status}; out=${output}" >&2; return 1; }
  [[ "${output}" == *"(not declared)"* ]] || {
    echo "an undeclared key was not reported as such; out=${output}" >&2
    return 1
  }
  assert_untouched "${before}"
}

@test "AC-C9(4) the key declared EMPTY -> reported as declared, rc != 0, nothing touched" {
  local before
  # ADR-6 case 5: the key is present with an empty value, so the resolver declines it and
  # WARNs. The reconciler is where that WARN points, so it must not read as an absent key.
  seed_dumps "${DEFAULT_DIR}" 1
  write_config ""
  before="$(tree_snapshot)"

  run_reconcile
  [[ "${status}" -ne 0 ]] || {
    echo "a declared-but-empty value is a misconfiguration; expected a non-zero rc, got ${status}; out=${output}" >&2
    return 1
  }
  [[ "${output}" == *"declared with an empty value"* ]] || {
    echo "the empty declaration is not named in the report; out=${output}" >&2
    return 1
  }
  [[ "${output}" != *"(not declared)"* ]] || {
    echo "a declared-but-empty key was reported as undeclared; out=${output}" >&2
    return 1
  }
  [[ "${output}" != *"nothing to reconcile"* ]] || {
    echo "the report claims nothing to reconcile while the resolver is declining the value; out=${output}" >&2
    return 1
  }
  # The operator still needs a way out, and it cannot be "honour the configured location"
  # because the configuration names none.
  [[ "${output}" == *"Option 1"* && "${output}" == *"Option 2"* ]] || {
    echo "the two operator options are not both present; out=${output}" >&2
    return 1
  }
  assert_untouched "${before}"
}

@test "AC-C9(5) a SYMLINKED declaration the resolver honours is not reported as a mismatch" {
  local before
  # The canonical comparison has a deliberate link here because otherwise it is pinned
  # only by an accident of the platform: macOS `mktemp -d` hands back /var/... for
  # /private/var/..., so every fixture path already traverses a symlink and the compare
  # is exercised for free. Linux has no such link, and canonicalizing these roots would
  # retire it on macOS too — at which point a raw comparison passes the whole suite while
  # calling every symlinked-but-honoured install unreconciled.
  mkdir -p -- "${ELSEWHERE}"
  ln -sfn "${ELSEWHERE}" "${WORK}/link-to-elsewhere"
  seed_dumps "${ELSEWHERE}" 2
  write_config "${WORK}/link-to-elsewhere"
  before="$(tree_snapshot)"

  run_reconcile
  [[ "${status}" -eq 0 ]] || {
    echo "a honoured symlinked declaration must reconcile; rc=${status}, out=${output}" >&2
    return 1
  }
  [[ "${output}" == *"nothing to reconcile"* ]] || {
    echo "no reconciled line for the symlinked declaration; out=${output}" >&2
    return 1
  }
  # The link's own spelling must not surface as a SECOND location holding the same dumps.
  [[ "${output}" != *"MISMATCH"* ]] || {
    echo "the link and its target were counted as two locations; out=${output}" >&2
    return 1
  }
  assert_untouched "${before}"
}

@test "AC-C9(6) a library without atrium_canonical_config_path dies with the named exit" {
  # The seam lets an OLDER library reach this script, and every report line below the
  # guard calls this function — so an unguarded absence surfaces as `command not found`
  # from wherever the ERR trap happens to fire, which is the generic shell failure the
  # loud-precondition block exists to convert into a code the wrapper can branch on.
  local stub="${WORK}/stub-lib.sh"
  cat >"${stub}" <<'STUB'
atrium_backup_dir() { printf '%s
' "/dev/null/never"; }
atrium_config_has_key() { return 1; }
atrium_backup_dir_default() { printf '%s
' "/dev/null/never"; }
atrium_backup_dump_count() { printf '0
'; }
atrium_toml_get() { printf '
'; }
STUB
  write_config "${ELSEWHERE}"

  run --separate-stderr env -u GA_DB_BACKUP_DIR -u GA_ROOT \
    ATRIUM_CONFIG_LIB="${stub}" \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash "${SCRIPT}"

  # 4 is EXIT_NO_LIB — the same code the two sibling guards use, never a bare 1 and never
  # the 127 an unguarded call would produce.
  [[ "${status}" -eq 4 ]] || {
    echo "expected EXIT_NO_LIB (4), got ${status}; out=${output} err=${stderr}" >&2
    return 1
  }
  [[ "${stderr}" == *"atrium_canonical_config_path"* ]] || {
    echo "the failure must name the missing function; err=${stderr}" >&2
    return 1
  }
}

@test "the reconciler's code contains no filesystem-mutating command" {
  local hits
  # A second net beside the per-shape snapshots: those cover the branches they exercise,
  # this covers every line. Comments are stripped first — the header says in prose that
  # the script does not move files, and that sentence must not read as a violation.
  hits="$(grep -v '^[[:space:]]*#' -- "${SCRIPT}" \
    | grep -nE '(^|[^[:alnum:]_./-])(mkdir|rmdir|cp|mv|rm|ln|touch|install|truncate)([^[:alnum:]_-]|$)' || true)"
  [[ -z "${hits}" ]] || {
    printf 'mutating commands in a report-only script:\n%s\n' "${hits}" >&2
    return 1
  }
}
