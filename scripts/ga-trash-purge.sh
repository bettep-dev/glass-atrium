#!/usr/bin/env bash
# ga-trash-purge.sh — permanently delete ONE named entry directly inside the home Trash ($HOME/.Trash)
# Usage: ga-trash-purge.sh <entry>
#   <entry>  a bare entry name, or a path whose parent is the home Trash: ~/.Trash/<entry>,
#            $HOME/.Trash/<entry>, ${HOME}/.Trash/<entry> (each also as unexpanded text) or the absolute path
#
# Why it exists: every live profile denies rm by its leading token, and a deny outranks any allow, so an
# agent that moved an entry to the Trash cannot purge it. This command is that one purge and nothing
# wider — a pass-through or general rm wrapper would be the smuggling settings.template.json warns of.
#
# Behavior:
#   1. Refuse anything but one operand naming one existing entry directly in a real-directory Trash
#   2. Ask the rm-wipe exception's own judge (hooks/lib/trash_rm.py, the one home of that rule) about the
#      canonical delete `rm -rf -- '<HOME>/.Trash/<entry>'`, and require its allow
#   3. Delete that one path through ga_guard_path (scripts/lib/path-guard.sh); a link entry goes as the
#      link alone, never followed — a dangling link included
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
#   3  = HOME unset, empty, relative or the filesystem root
#   4  = invalid entry name (empty, ".", "..", or a relative path holding "/")
#   5  = the operand is the Trash directory itself
#   6  = the operand lies outside the Trash or deeper than one level below it
#   7  = the Trash is a symlink or not a directory
#   8  = the entry does not exist (lstat: a dangling link exists)
#   9  = the shared judge hooks/lib/trash_rm.py denied the delete, or could not run
#   10 = the shared path guard is missing or refused the path
#   11 = the delete failed; the entry is still present
#   12 = the entry was purged but its log line could not be written
set -Eeuo pipefail
IFS=$'\n\t'

trap 'echo "ga-trash-purge: ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

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

# Strips every trailing slash; an all-slash value becomes empty. Args: $1=value
strip_slashes() {
  printf '%s' "${1%"${1##*[!/]}"}"
}

# The operand's entry name, or a refusal. Args: $1=operand, $2=absolute Trash path
get_entry_name() {
  local operand="${1}" trash_dir="${2}" bare name
  bare="$(strip_slashes "${operand}")"
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
  printf '%s' "${name}"
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

# Deletes one guarded path. Status 10 = the guard refused it, any other non-zero = the delete failed.
# Args: $1=absolute entry path
delete_entry() {
  local target="${1}"
  # shellcheck disable=SC2310  # the guard verdict is branched on, never an error trap
  if ga_guard_path "${target}"; then
    rm -rf -- "${target:?}"
  else
    return 10
  fi
}

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
  usage_line="$(du -sk -- "${1}" 2>/dev/null)" || true
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
  local operand="${1}" home trash_dir name target kind size_kib canonical rc=0
  local log_dir log_file stamp

  home="$(strip_slashes "${HOME:-}")"
  if [[ -z "${home}" || "${home}" != /* ]]; then
    refuse 3 "HOME is unset, empty, relative or the filesystem root"
  fi
  trash_dir="${home}/.Trash"

  # shellcheck disable=SC2310  # a refusal exits the substitution with its code; it is passed on as is
  name="$(get_entry_name "${operand}" "${trash_dir}")" || exit "$?"

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
  delete_entry "${target}" || rc=$?
  if ((rc == 10)); then
    refuse 10 "the shared path guard refused ${target}"
  fi
  if ((rc != 0)) || [[ -e "${target}" || -L "${target}" ]]; then
    printf 'ga-trash-purge: FAILED: the delete left the entry in place: %s\n' "${name}" >&2
    exit 11
  fi

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
