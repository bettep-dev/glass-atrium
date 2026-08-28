#!/usr/bin/env bash
# reconcile-backup-dir.sh — REPORT-ONLY reconciliation of [paths].backup_dir against the
# location that actually holds the pg_dump backups (ADR-10).
#
# ADR-6 makes the resolver decline a configured backup_dir it cannot safely adopt, which
# keeps the nightly job writing where the dumps already are. That is the safe outcome, but
# it leaves the disagreement standing: the config says one thing, the dumps sit elsewhere,
# and nothing resolves it. This script is the resolution path. It prints the configured
# value, the location the resolver will actually use, the dump census at each, and the two
# moves available to the operator — then exits non-zero for as long as the split stands.
#
# IT MOVES NOTHING. There is no mkdir, cp, mv or rm anywhere in this file. Relocating an
# accumulated archive is irreversible in practice, so the choice stays the operator's;
# test/reconcile-backup-dir.bats asserts the file set is byte-identical across a run.
#
# WHAT COUNTS AS A MISMATCH — two independent conditions, either of which stands alone:
#   (a) a declared [paths].backup_dir was NOT adopted, so the config states an intent the
#       resolver is deliberately ignoring (ADR-6 cases 4 and 5, the loud non-adoption);
#   (b) dumps sit at a location the resolver will NOT write to.
# Condition (b) is not implied by (a) and neither replaces the other. A configured
# directory that EXISTS wins adoption, so config and resolved AGREE — (a) is silent —
# while the archive already at the default is stranded outside both the rotation window
# and any restore search, which only (b) sees. The reverse is the live stale-render shape:
# the value is declined, so the dumps are exactly where the resolver writes and (b) is
# silent, while the config keeps stating an intent nobody acted on, which only (a) sees.
#
# Run via: scripts/reconcile-backup-dir.sh
# Requires: bash 3.2+ (macOS stock)
#
# Exit codes (per-script, not a shared table):
#   0 = nothing to reconcile (or --help)
#   2 = usage error
#   3 = an unreconciled mismatch stands — the report names the two options
#   4 = the config library could not be sourced, so nothing can be resolved
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly EXIT_USAGE=2
readonly EXIT_UNRECONCILED=3
readonly EXIT_NO_LIB=4

say() {
  printf '[reconcile-backup-dir] %s\n' "$*"
}

die() {
  printf '[reconcile-backup-dir] ERROR: %s\n' "$2" >&2
  exit "$1"
}

usage() {
  cat <<'USAGE'
Usage: reconcile-backup-dir.sh [-h|--help]

Reports whether the pg_dump backups sit at the location the ADR-6 resolver will
write to, and names the two ways an operator can close a split. Read-only: it
never creates, moves or deletes a file.

Exit: 0 nothing to reconcile - 2 usage - 3 mismatch stands - 4 library missing.
USAGE
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  "") ;;
  *)
    usage >&2
    die "${EXIT_USAGE}" "unknown argument: $1"
    ;;
esac

# LOUD PRECONDITION: without the resolver there is no "location the resolver will use",
# so there is nothing to report. Unlike the write sites, which fall back so a dump still
# happens, a reporter with nothing to report must fail rather than invent an answer.
CONFIG_LIB="${ATRIUM_CONFIG_LIB:-${SCRIPT_DIR}/lib/atrium-config.sh}"
readonly CONFIG_LIB
[[ -r "${CONFIG_LIB}" ]] || die "${EXIT_NO_LIB}" "config library not readable: ${CONFIG_LIB}"
# shellcheck source-path=SCRIPTDIR source=lib/atrium-config.sh
. "${CONFIG_LIB}"
declare -F atrium_backup_dir >/dev/null \
  || die "${EXIT_NO_LIB}" "atrium_backup_dir not defined by ${CONFIG_LIB}"

# add_location <dir> — append to LOCATIONS unless already present (bash 3.2 has no sets).
LOCATIONS=()
add_location() {
  local dir="$1" existing
  [[ -n "${dir}" ]] || return 0
  for existing in ${LOCATIONS[@]+"${LOCATIONS[@]}"}; do
    if [[ "${existing}" == "${dir}" ]]; then
      return 0
    fi
  done
  LOCATIONS+=("${dir}")
}

# describe_dir <dir> — "N dump(s)" or the reason there can be none.
describe_dir() {
  local dir="$1" count
  if [[ -e "${dir}" && ! -d "${dir}" ]]; then
    printf 'exists but is not a directory\n'
    return 0
  fi
  if [[ ! -d "${dir}" ]]; then
    printf 'directory absent\n'
    return 0
  fi
  count="$(atrium_backup_dump_count "${dir}")"
  printf '%s dump(s)\n' "${count}"
}

# say_location <label> <dir> — one report line, census resolved into a variable first so
# no status is masked inside the message.
say_location() {
  local label="$1" dir="$2" detail
  detail="$(describe_dir "${dir}")"
  say "${label}: ${dir} (${detail})"
}

config_file="$(atrium_config_file)"
default_dir="$(atrium_backup_dir_default)"
configured="$(atrium_toml_get '[paths]' 'backup_dir')"
# The resolver's own WARN points AT this script, so re-printing it above this report would
# say the same thing twice, less clearly.
# GA-ABSORB[handled@this report]: stderr only — the resolver always returns 0 and always echoes a path, and every fact its WARN carries is printed below
resolved="$(atrium_backup_dir 2>/dev/null)"

add_location "${resolved}"
add_location "${default_dir}"
add_location "${configured}"

say "config file          : ${config_file}"
if [[ -n "${configured}" ]]; then
  say_location "[paths].backup_dir   " "${configured}"
else
  say "[paths].backup_dir   : (not declared)"
fi
say_location "resolver will write  " "${resolved}"
say_location "default location     " "${default_dir}"

# Condition (b): any location OTHER than the resolved one that still holds dumps.
stranded=""
stranded_count=0
for candidate in ${LOCATIONS[@]+"${LOCATIONS[@]}"}; do
  if [[ "${candidate}" == "${resolved}" ]]; then
    continue
  fi
  count="$(atrium_backup_dump_count "${candidate}")"
  if [[ "${count}" -gt 0 ]]; then
    stranded="${candidate}"
    stranded_count="${count}"
    break
  fi
done

# Condition (a): a declared value the resolver declined.
declined=0
if [[ -n "${configured}" && "${configured}" != "${resolved}" ]]; then
  declined=1
fi

if [[ -z "${stranded}" && "${declined}" -eq 0 ]]; then
  say "nothing to reconcile: the resolver writes where the dumps are, and no declared value is being ignored."
  exit 0
fi

if [[ "${declined}" -eq 1 ]]; then
  say "MISMATCH: [paths].backup_dir names ${configured}, but the resolver will write to ${resolved} — the configured value is not being honoured."
fi
if [[ -n "${stranded}" ]]; then
  say "MISMATCH: ${stranded_count} dump(s) sit at ${stranded}, which is NOT where the resolver will write."
fi

# The location the operator would be choosing to KEEP if they leave the dumps alone: where
# they actually are, falling back to the resolved location when nothing is stranded.
keep_target="${stranded:-${resolved}}"
if [[ "${declined}" -eq 1 ]]; then
  if [[ -n "${stranded}" ]]; then
    say "Option 1 - honour the configured location: create ${configured} yourself, move the ${stranded_count} dump(s) from ${stranded} into it, then re-run this script."
  else
    say "Option 1 - honour the configured location: create ${configured} yourself, move any dumps from ${resolved} into it, then re-run this script."
  fi
else
  say "Option 1 - keep writing where the resolver writes: move the ${stranded_count} dump(s) from ${stranded} into ${resolved} yourself, then re-run this script."
fi
say "Option 2 - keep the dumps where they are: set [paths].backup_dir = \"${keep_target}\" in ${config_file} (or delete the key to fall back to ${default_dir}), then re-run this script."
say "Nothing was created, moved or deleted by this run."
exit "${EXIT_UNRECONCILED}"
