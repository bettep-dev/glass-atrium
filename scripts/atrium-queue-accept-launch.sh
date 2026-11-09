#!/usr/bin/env bash
# atrium-queue-accept-launch.sh — opt-in launch wrapper for one bypass-mode Claude Code session that takes
# owner queue frames with no hold: a settings file holding only crossSessionInbound "accept" goes to that
# one session through --settings, from the wrapper's own 0700 temp dir, removed when the session exits.
# Never writes a shared settings file. Refuses --bg: it would return at once and remove the file under the
# running session.
# Exit codes: the session's own exit code · 1 no claude on PATH or no safe temp dir · 64 usage

set -Eeuo pipefail
IFS=$'\n\t'

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")"
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${self}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source-path=SCRIPTDIR source=lib/path-guard.sh
source "${SCRIPT_DIR}/lib/path-guard.sh"

readonly ACCEPT_SETTINGS='{"crossSessionInbound":"accept"}'

work_dir=""

cleanup() {
  local code=$?
  # shellcheck disable=SC2310  # a refused target is a skipped delete, never an errexit
  if ga_guard_path "${work_dir}"; then rm -rf -- "${work_dir:?}"; fi
  exit "${code}"
}
trap cleanup EXIT
# no INT trap → a Ctrl-C that claude catches to cancel a turn never ends the wrapper; a TERM trap runs once the session exits
trap 'exit 143' TERM

main() {
  local arg
  for arg in "$@"; do
    case "${arg}" in
      -h | --help)
        print_usage
        return 0
        ;;
      --bg | --background | --bg=* | --background=*)
        fail_usage "--bg is refused: launch a background bypass session with plain claude (it holds queue frames for approval)"
        ;;
      --settings | --settings=*)
        fail_usage "--settings is refused: this wrapper passes its own accept settings file"
        ;;
      *) ;;
    esac
  done
  local claude_bin
  claude_bin="$(command -v claude)" || fail "no claude on PATH"
  work_dir="$(mktemp -d)" || fail "cannot create the temp directory"
  # an empty, relative or root value is never written into, launched from or removed
  # shellcheck disable=SC2310  # a refused value is this script's named failure, never an errexit
  ga_guard_path "${work_dir}" || fail "refusing the temp directory value"
  [[ -d "${work_dir}" && ! -L "${work_dir}" && -O "${work_dir}" ]] || fail "the temp directory is not this user's own directory"
  chmod 700 "${work_dir}"
  local settings="${work_dir}/accept-settings.json" status=0
  (umask 077 && printf '%s\n' "${ACCEPT_SETTINGS}" >"${settings}")
  ATRIUM_QUEUE_ACCEPT_WRAPPER=1 "${claude_bin}" --settings "${settings}" "$@" || status=$?
  exit "${status}"
}

print_usage() {
  cat <<'USAGE'
Usage: atrium-queue-accept-launch.sh [claude options...]
  Starts one interactive claude session (pass your bypass flag, e.g. --dangerously-skip-permissions)
  that takes Atrium owner queue frames with no hold: its own settings file sets crossSessionInbound to
  accept for this session only and is removed when the session exits. The shared settings are untouched.
  RISK: on macOS the session socket token is optional, so any process running as your user can send this
  session a frame, and in bypass mode that frame drives tools with no prompt. Use it only when you accept
  that same-uid risk for this one session.
  --bg is refused: launch background bypass sessions with plain claude; they hold queue frames for approval.
  --settings is refused: the wrapper passes its own. An automatic resume by the monitor never gets the
  accept file, so a resumed bypass session holds frames again.
USAGE
}

fail_usage() {
  printf 'atrium-queue-accept-launch: %s\n' "$1" >&2
  print_usage >&2
  exit 64
}

fail() {
  printf 'atrium-queue-accept-launch: %s\n' "$1" >&2
  exit 1
}

main "$@"
