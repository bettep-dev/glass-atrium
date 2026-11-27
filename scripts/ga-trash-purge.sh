#!/usr/bin/env bash
# ga-trash-purge.sh — permanently delete ONE named entry directly inside the home Trash ($HOME/.Trash)
# Usage: ga-trash-purge.sh <entry>
#   <entry>  a bare entry name, or a path whose parent is the home Trash: ~/.Trash/<entry>,
#            $HOME/.Trash/<entry>, ${HOME}/.Trash/<entry> (each also as unexpanded text) or the absolute path
# Caller contract: callers purge only entries they moved into the Trash themselves; the owner's own Trash entries are never purged.
#
# Why it exists: every live profile denies rm by its leading token, and a deny outranks any allow, so an
# agent that moved an entry to the Trash cannot purge it. This command is that one purge and nothing
# wider — a pass-through or general rm wrapper would be the smuggling settings.template.json warns of.
#
# Behavior:
#   1. Refuse anything but one operand naming one existing entry directly in a real-directory Trash; an
#      operand or HOME holding a control character is refused before any parsing, and every parsed value
#      is returned through a variable, never $(...), which would strip a trailing newline after validation
#   2. Ask the rm-wipe exception's own judge (hooks/lib/trash_rm.py, the one home of that rule) about the
#      canonical delete `rm -rf -- '<HOME>/.Trash/<entry>'`, and require its allow
#   3. Pin the Trash as the working directory (cd -P, then the same inode as the Trash name, which is
#      still no link), check the absolute path through ga_guard_path (scripts/lib/path-guard.sh), and
#      delete ./<entry> from that pinned directory, so a Trash swapped for a link mid-run cannot redirect
#      the delete; a link entry goes as the link alone, never followed — a dangling link included
#   4. Append one line to ${GA_DATA_ROOT:-$HOME/.glass-atrium}/logs/trash-purge.log, so a Trash
#      instrument can attribute the purge instead of counting a loss:
#      <UTC ISO time> TAB purge TAB kind=dir|file|link TAB kib=<N|-> TAB name=<%q> TAB cwd=<%q>
#
# The script reads HOME and never expands `~`, so an unset HOME can never fall back to a passwd home.
#
# Exit codes:
#   0  = entry purged and logged
#   1  = unexpected internal error
#   2  = usage error (zero or several operands)
#   3  = HOME unset, empty, relative, the filesystem root, holding a "." or ".." component, or holding a
#        control character
#   4  = invalid entry name (empty, ".", "..", a relative path holding "/", or an operand holding a
#        newline or other control character)
#   5  = the operand is the Trash directory itself
#   6  = the operand lies outside the Trash or deeper than one level below it
#   7  = the Trash is a symlink or not a directory, or changed into one before the delete
#   8  = the entry does not exist (lstat: a dangling link exists)
#   9  = the shared judge hooks/lib/trash_rm.py denied the delete, or could not run. It refuses names
#        that hold the substring IFS or HOME, a glob character (* ? [ ]), a parenthesis (so a
#        Finder-style "shot (1).png"), a backtick, $, or any of ; < > | &. Remedy: the caller moves its
#        entry into the Trash under a judge-readable name, e.g. [A-Za-z0-9._-] plus a timestamp
#        (build-cache-20261029T0700Z), and purges that name
#   10 = the shared path guard is missing or refused the path
#   11 = the delete failed; the entry is still present
#   12 = the entry was purged but its log line could not be written
set -Eeuo pipefail
IFS=$'\n\t'

trap 'echo "ga-trash-purge: ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2; exit 1' ERR

# Physical directory, so the sibling hooks/ tree resolves from the real install root the way the hook
# resolves its own lib/ from its own directory.
SELF_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SELF_DIR
readonly INSTALL_ROOT="${SELF_DIR%/*}"
readonly JUDGE="${INSTALL_ROOT}/hooks/lib/trash_rm.py"
readonly PATH_GUARD="${SELF_DIR}/lib/path-guard.sh"

usage() {
  printf 'usage: ga-trash-purge.sh <entry>\n' >&2
}

# Prints the refusal and exits with its code. Args: $1=exit code, $2=message
refuse() {
  printf 'ga-trash-purge: REFUSED: %s\n' "${2}" >&2
  exit "${1}"
}

# Status 0 when the value holds a newline, tab or other control character. Args: $1=value
has_control_char() {
  [[ "${1}" == *[[:cntrl:]]* ]]
}

# Stores the value with every trailing slash stripped in the named variable; an all-slash value becomes
# empty. printf -v, never $(...), so no trailing newline is lost. Args: $1=variable name, $2=value
set_stripped() {
  printf -v "${1}" '%s' "${2%"${2##*[!/]}"}"
}

# Status 0 for a name that is one entry directly in the Trash. Args: $1=name
is_entry_name() {
  # shellcheck disable=SC2310  # a pure test; its status is the verdict
  [[ -n "${1}" && "${1}" != "." && "${1}" != ".." && "${1}" != */* ]] && ! has_control_char "${1}"
}

# Sets ENTRY_NAME to the operand's entry name, or refuses. A variable, never $(...), carries the result,
# so the name validated here is the name deleted. Args: $1=operand, $2=absolute Trash path
set_entry_name() {
  local operand="${1}" trash_dir="${2}" bare="" name
  set_stripped bare "${operand}"
  # shellcheck disable=SC2016,SC2088  # literal ~ / $HOME text a caller may pass unexpanded
  case "${bare}" in
    "${trash_dir}" | '~/.Trash' | '$HOME/.Trash' | '${HOME}/.Trash')
      refuse 5 "the Trash directory itself is not an entry: ${operand}"
      ;;
    *) ;;
  esac
  # shellcheck disable=SC2016,SC2088  # literal ~ / $HOME text a caller may pass unexpanded
  case "${operand}" in
    "${trash_dir}/"*) name="${operand#"${trash_dir}/"}" ;;
    '~/.Trash/'*) name="${operand#'~/.Trash/'}" ;;
    '$HOME/.Trash/'*) name="${operand#'$HOME/.Trash/'}" ;;
    '${HOME}/.Trash/'*) name="${operand#'${HOME}/.Trash/'}" ;;
    /* | '~'* | '$'*) refuse 6 "not an entry directly in ${trash_dir}: ${operand}" ;;
    *)
      if [[ "${operand}" == */* ]]; then
        refuse 4 "a relative path is not an entry name: ${operand}"
      fi
      name="${operand}"
      ;;
  esac
  if [[ -z "${name}" || "${name}" == "." || "${name}" == ".." ]]; then
    refuse 4 "invalid entry name: '${name}'"
  fi
  if [[ "${name}" == */* ]]; then
    refuse 6 "deeper than one level below ${trash_dir}: ${operand}"
  fi
  ENTRY_NAME="${name}"
}

# The shell text of the one delete this run performs, single-quoted for the judge. Args: $1=path
get_canonical_delete() {
  local quote="'" escaped="'\\''"
  # GA-RM[not-executed]: the delete's text for the judge to read on stdin; the real delete is delete_entry
  printf "rm -rf -- '%s'" "${1//${quote}/${escaped}}"
}

# Status 0 only when the judge allows the canonical delete and leaves no residual command.
# Args: $1=canonical delete text
is_judge_allow() {
  local residual
  [[ -r "${JUDGE}" ]] || return 1
  # The inner `|| exit 1` keeps a denial out of the ERR trap the substitution inherits (set -E).
  residual="$(python3 -I "${JUDGE}" <<<"${1}" || exit 1)" || return 1
  [[ -z "${residual}" ]]
}

# Deletes one entry from inside the pinned Trash, in a subshell so the caller's cwd stays as it was.
# Status 7 = the Trash is no longer the directory checked, 10 = the guard refused the path,
# 11 = the delete failed or left the entry. Args: $1=absolute Trash path, $2=entry name
delete_entry() (
  local trash_dir="${1}" name="${2}"
  local target="${trash_dir}/${name}"
  cd -P -- "${trash_dir}" 2>/dev/null || return 7
  # . is pinned now; the Trash name must still be no link and the same inode, or a swap redirected the cd
  if [[ -L "${trash_dir}" ]] || ! [[ . -ef "${trash_dir}" ]]; then
    return 7
  fi
  # shellcheck disable=SC2310  # the guard verdict is branched on, never an error trap
  if ga_guard_path "${target}"; then
    # GA-RM[unvalidatable]: ./<entry> from the pinned Trash cwd; ga_guard_path refuses a relative path, so it checks the absolute twin above
    rm -rf -- "./${name:?}" || return 11
  else
    return 10
  fi
  [[ ! -e "./${name}" && ! -L "./${name}" ]] || return 11
)

# kind of an entry, lstat-wise. Args: $1=path
get_kind() {
  if [[ -L "${1}" ]]; then
    printf 'link'
  elif [[ -d "${1}" ]]; then
    printf 'dir'
  else
    printf 'file'
  fi
}

# Disk usage in KiB without following links; "-" when du cannot tell. du walks the tree the delete
# walks anyway, so it costs no more than the purge itself. Args: $1=path
get_size_kib() {
  local usage_line=""
  # The inner `|| exit 0` keeps a du failure out of the ERR trap the substitution inherits (set -E);
  # an outer `|| true` alone runs too late, after the trap has already printed its error line.
  usage_line="$(du -sk -- "${1}" 2>/dev/null || exit 0)"
  usage_line="${usage_line%%[[:space:]]*}"
  if [[ "${usage_line}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${usage_line}"
  else
    printf '%s' '-'
  fi
}

main() {
  if (($# != 1)); then
    usage
    refuse 2 "exactly one operand expected, got $#"
  fi
  local operand="${1}" home="" trash_dir name target kind size_kib canonical rc=0 shown
  local log_dir log_file stamp

  # Before any parsing: a control character is never part of a name this command purges.
  # shellcheck disable=SC2310  # the predicate verdicts below are branched on, never an error trap
  if has_control_char "${operand}"; then
    printf -v shown '%q' "${operand}"
    refuse 4 "the operand holds a newline or other control character: ${shown}"
  fi
  # shellcheck disable=SC2310  # branched on, never an error trap
  if has_control_char "${HOME:-}"; then
    refuse 3 "HOME holds a newline or other control character"
  fi
  set_stripped home "${HOME:-}"
  if [[ -z "${home}" || "${home}" != /* ]]; then
    refuse 3 "HOME is unset, empty, relative or the filesystem root"
  fi
  # A "." or ".." component spells the root or another directory without being canonical.
  case "${home}/" in
    */./* | */../*) refuse 3 "HOME holds a '.' or '..' component: ${home}" ;;
    *) ;;
  esac
  trash_dir="${home}/.Trash"

  ENTRY_NAME=""
  set_entry_name "${operand}" "${trash_dir}"
  name="${ENTRY_NAME}"
  # Re-check what main will delete, independent of the parser that produced it.
  # shellcheck disable=SC2310  # branched on, never an error trap
  if ! is_entry_name "${name}"; then
    refuse 4 "invalid entry name after parsing: '${name}'"
  fi

  if [[ -L "${trash_dir}" || ! -d "${trash_dir}" ]]; then
    refuse 7 "the Trash is a symlink or not a directory: ${trash_dir}"
  fi
  target="${trash_dir}/${name}"
  if [[ ! -e "${target}" && ! -L "${target}" ]]; then
    refuse 8 "no such Trash entry: ${name}"
  fi

  canonical="$(get_canonical_delete "${target}")"
  # shellcheck disable=SC2310  # the judge verdict is branched on, never an error trap
  if ! is_judge_allow "${canonical}"; then
    refuse 9 "the shared judge ${JUDGE} does not allow deleting this entry: ${name}"
  fi

  if [[ ! -r "${PATH_GUARD}" ]]; then
    refuse 10 "cannot source the shared path guard ${PATH_GUARD}"
  fi
  # shellcheck source-path=SCRIPTDIR source=lib/path-guard.sh
  source "${PATH_GUARD}" || refuse 10 "cannot source the shared path guard ${PATH_GUARD}"

  kind="$(get_kind "${target}")"
  size_kib="$(get_size_kib "${target}")"

  # shellcheck disable=SC2310  # the delete status is branched on below
  delete_entry "${trash_dir}" "${name}" || rc=$?
  case "${rc}" in
    0) ;;
    7) refuse 7 "the Trash changed before the delete: ${trash_dir}" ;;
    10) refuse 10 "the shared path guard refused ${target}" ;;
    *)
      printf 'ga-trash-purge: FAILED: the delete left the entry in place: %s\n' "${name}" >&2
      exit 11
      ;;
  esac

  log_dir="${GA_DATA_ROOT:-${home}/.glass-atrium}/logs"
  log_file="${log_dir}/trash-purge.log"
  stamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if ! { mkdir -p -- "${log_dir}" \
    && printf '%s\tpurge\tkind=%s\tkib=%s\tname=%q\tcwd=%q\n' \
      "${stamp}" "${kind}" "${size_kib}" "${name}" "${PWD}" >>"${log_file}"; } 2>/dev/null; then
    printf 'ga-trash-purge: WARNING: purged %s but could not write %s\n' "${name}" "${log_file}" >&2
    exit 12
  fi
  printf 'purged: %s (%s)\n' "${name}" "${kind}"
}

main "$@"
