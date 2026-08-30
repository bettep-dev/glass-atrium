#!/usr/bin/env bats
# DB backup path consistency — the three sites that write a pg_dump must agree on
# WHERE it goes, and every user-facing string naming that directory must agree with
# them. One of those strings is the DROP typed-confirm pre-gate, so a stale path is
# read exactly when the user is deciding whether data is recoverable.
#
# Since ADR-6 the directory is decided by ONE resolver (atrium_backup_dir), and each
# site keeps a last-resort literal for the branch where that library is unreachable.
# This suite pins both halves:
#   * agreement  -> the three sites resolve to the SAME path under one sandbox config
#   * the literal-> the four files spell the default byte-identically
#   * the wiring -> each site actually calls the resolver
#
# Run via: bats test/db-backup-path-consistency.bats
# Requires: bats (brew install bats-core), git, bash 3.2+
#
# TRACKED-CONTENT SCAN: this file ships to the live install, where the scan root
# is not a git checkout but does hold user-owned config and monitor documents
# that legitimately quote the legacy path. A filesystem-wide scan there fails for
# the wrong reason and reds the apply gate, so the guard scopes itself to
# git-tracked files and goes inert off a checkout root.
#
# SELF-TRIP HAZARD: this file is inside the scanned tree, so the stale needle is
# assembled at runtime from two fragments and never appears literally here.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# The 3 legacy-path strings in test/oss-db-setup.bats are NEGATIVE assertions
# (the legacy dir must NOT be created) — correcting them would invert the test.
NEGATIVE_ASSERTION_FILE="test/oss-db-setup.bats"

# `-ef` (same inode) rather than string equality: a symlinked checkout resolves
# to a different spelling of the same root.
is_repo_root() {
  local top
  top="$(git -C "${GA}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ -n "${top}" ]] || return 1
  [[ "${top}" -ef "${GA}" ]]
}

@test "no stale legacy backup path remains in tracked files" {
  local needle hits
  is_repo_root || skip "scan root is not a git checkout root: ${GA}"
  needle=".claude/backups/""postgres"
  hits="$(git -C "${GA}" grep -nIF --full-name -e "${needle}" \
    -- '.' ":(exclude)${NEGATIVE_ASSERTION_FILE}" || true)"
  [[ -z "${hits}" ]] || { printf 'stale backup path sites:\n%s\n' "${hits}" >&2; return 1; }
}

# The one spelling of the default location. The resolver owns it; each consumer
# repeats it ONLY inside its library-absent fallback, which is the branch that runs
# when the resolver cannot be reached — so the duplication is deliberate and this
# assertion is what holds the copies equal.
DEFAULT_LITERAL='GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres'

# Every file that spells the default, and the call each consumer must make instead
# of deriving it. Kept as parallel space-separated records because bash 3.2 has no
# associative arrays.
#   <file>|<resolver call the site must contain, or "-" for the resolver itself>
SITE_RECORDS=(
  "scripts/lib/atrium-config.sh|-"
  "scripts/pg-backup.sh|atrium_backup_dir"
  "lib/ga-db.sh|atrium_backup_dir"
  "monitor/scripts/oss-db-setup.sh|atrium_backup_dir"
)

@test "the default location is spelled identically by the resolver and every fallback" {
  local record file missing=""
  for record in "${SITE_RECORDS[@]}"; do
    file="${record%%|*}"
    grep -q -F -- "${DEFAULT_LITERAL}" "${GA}/${file}" \
      || missing="${missing}${missing:+, }${file}"
  done
  [[ -z "${missing}" ]] || {
    echo "files not spelling the default location identically: ${missing}" >&2
    return 1
  }
}

@test "each writing site resolves through atrium_backup_dir rather than deriving it" {
  local record file call unwired=""
  for record in "${SITE_RECORDS[@]}"; do
    file="${record%%|*}"
    call="${record##*|}"
    [[ "${call}" != "-" ]] || continue
    grep -q -F -- "${call}" "${GA}/${file}" \
      || unwired="${unwired}${unwired:+, }${file}"
  done
  [[ -z "${unwired}" ]] || {
    echo "sites that no longer call the resolver: ${unwired}" >&2
    return 1
  }
}

# The DISPLAY site. It writes no dump, so it is not in the records above, but it names the
# backup directory to the user inside the uninstall typed confirm — the one moment the
# reader is deciding whether their data is recoverable. A literal there would be a promise
# the resolver need not keep, so the file must carry no path literal at all.
@test "the uninstall confirm prompt resolves the directory rather than naming one" {
  local dispatch="${GA}/lib/ga-tui-dispatch.sh"
  grep -q -F -- 'ga_resolve_backup_dir' "${dispatch}" || {
    echo "the uninstall prompt no longer resolves the backup directory" >&2
    return 1
  }
  grep -q -F -- 'backups/postgres' "${dispatch}" && {
    echo "a backup path literal reappeared in the uninstall prompt" >&2
    return 1
  }
  return 0
}

# --- AC-C3: the three sites agree under one sandbox config -------------------
#
# Each site owns a small resolve function whose stdout IS the directory it will
# write to. The test lifts each one out of its own file into a temp file and
# sources it (never eval), so the assertion runs the SITE's code, not a
# re-implementation of it — a site reverted to a hardcoded default answers with the
# default while the others answer with the configured value, and the comparison reds.
#
# The fixture picks case 2 of the ADR-6 table (absolute, elsewhere, DIRECTORY
# EXISTS) so the configured value is adopted and therefore DIFFERS from the default:
# a site that ignores the resolver cannot accidentally agree.
#
# NO LIVE PATH LITERAL: the first test in this file greps every tracked file for the
# stale backup path, so the fixture is built from sandbox paths and never spells it.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict — every
# assertion below `return 1`s with its own message so each fails independently.

SITE_FUNCTIONS=(
  "scripts/pg-backup.sh|resolve_backup_dir"
  "lib/ga-db.sh|ga_resolve_backup_dir"
  "monitor/scripts/oss-db-setup.sh|resolve_backup_dir"
)

setup() {
  # CANONICAL fixture root. macOS `mktemp -d` hands back /var/folders/..., a symlink to
  # /private/var/folders/..., and the ADR-6 resolver now resolves the value it adopts
  # (CWE-59). Without this the agreement test below would compare three resolved paths
  # against an unresolved fixture and report a disagreement the three sites do not have.
  WORK="$(cd -P -- "$(mktemp -d -t ga-backup-consistency.XXXXXX)" && pwd -P)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Copy one function definition out of a shell file into a sourceable temp file.
# awk, not eval: the extracted text is executed by `source` in a child shell, so a
# malformed extraction fails loudly there instead of running in this one.
# Args: $1 = function name · $2 = source file · $3 = destination file.
extract_fn_to() {
  awk -v fn="$1" 'index($0, fn "() {") == 1 { f = 1 } f { print } f && /^}/ { exit }' \
    "$2" >"$3"
}

# Run one site's resolve function against the sandbox config. Echoes the path.
# Args: $1 = repo-relative file · $2 = function name.
site_resolves() {
  local file="$1" fn="$2" body="${WORK}/fn.sh"
  extract_fn_to "${fn}" "${GA}/${file}" "${body}"
  [[ -s "${body}" ]] || return 1
  env -u GA_DB_BACKUP_DIR -u GA_ROOT \
    ATRIUM_CONFIG_LIB="${GA}/scripts/lib/atrium-config.sh" \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash -c 'source "$1"; source "$2"; "$3"' _ \
    "${GA}/scripts/lib/atrium-config.sh" "${body}" "${fn}" 2>/dev/null
}

@test "AC-C3 the three writing sites resolve to the same path under one config" {
  local relocated="${WORK}/relocated" record file fn got first="" disagree=""
  # case 2: the destination EXISTS, so the configured value is adopted and differs
  # from ${WORK}/ga/backups/postgres (the default under this sandbox data root).
  mkdir -p -- "${relocated}" "${WORK}/ga/backups/postgres"
  printf '[paths]\nbackup_dir = "%s"\n' "${relocated}" >"${WORK}/config.toml"

  for record in "${SITE_FUNCTIONS[@]}"; do
    file="${record%%|*}"
    fn="${record##*|}"
    got="$(site_resolves "${file}" "${fn}")" || {
      echo "could not run ${fn} from ${file}" >&2
      return 1
    }
    [[ "${got}" == "${relocated}" ]] \
      || disagree="${disagree}${disagree:+, }${file}(${got})"
    [[ -n "${first}" ]] || first="${got}"
    [[ "${got}" == "${first}" ]] \
      || disagree="${disagree}${disagree:+, }${file}!=${first}"
  done
  [[ -z "${disagree}" ]] || {
    echo "sites disagreeing with the configured ${relocated}: ${disagree}" >&2
    return 1
  }
}
