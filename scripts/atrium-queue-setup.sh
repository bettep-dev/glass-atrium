#!/usr/bin/env bash
# atrium-queue-setup.sh — owner-run provisioning of the owner queue's two secrets on a TTY: the queue key the
# sessions send, and the scrypt record of the owner passphrase the monitor's login checks (monitor
# src/server/queue/passphrase.ts reads that record shape). No HTTP route sets either; only this script does.
# A secret never reaches stdout, stderr, a log or a child's argv or env: the passphrase goes to node over stdin.
# Exit codes: 0 done · 1 failed, nothing replaced · 64 usage, or stdin is not a TTY

set -Eeuo pipefail
IFS=$'\n\t'
trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# the terminal state main saves before any prompt; the EXIT trap puts it back on any exit path
tty_state=""
put_tty_state() {
  if [[ -n "${tty_state}" ]]; then
    stty "${tty_state}" 2>/dev/null || stty echo 2>/dev/null || true
    tty_state=""
  fi
}
trap put_tty_state EXIT

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")"
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${self}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source-path=SCRIPTDIR source=lib/queue-session.sh
source "${SCRIPT_DIR}/lib/queue-session.sh"

readonly KEY_FILE_NAME="queue-key"
readonly PASSPHRASE_FILE_NAME="owner-passphrase.json"

# 32 random bytes → 43 base64url characters, inside the hooks' and the CLI's QUEUE_KEY_SHAPE
readonly KEY_JS='process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")'

# stdin passphrase → the monitor's record; N=2^17 r=8 p=1 sits inside its SCRYPT_BOUNDS, maxmem as getScryptMemoryBytes
PASSPHRASE_JS="$(
  cat <<'JS'
const { scrypt, randomBytes } = require("node:crypto");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const passphrase = Buffer.concat(chunks).toString("utf8");
  if (passphrase.length < 12 || passphrase.length > 1024) {
    process.stderr.write("the passphrase must be 12 to 1024 characters\n");
    process.exit(2);
  }
  const N = 2 ** 17, r = 8, p = 1, keyLength = 64;
  const salt = randomBytes(32);
  scrypt(passphrase, salt, keyLength, { N, r, p, maxmem: 128 * r * (N + p + 2) }, (error, hash) => {
    if (error) {
      process.stderr.write("scrypt derivation failed\n");
      process.exit(1);
    }
    const record = { algorithm: "scrypt", N, r, p, keyLength, salt: salt.toString("base64"), hash: hash.toString("base64") };
    process.stdout.write(JSON.stringify(record) + "\n");
  });
});
JS
)"
readonly PASSPHRASE_JS

main() {
  local rotate=""
  case "${1:-}" in
    "") ;;
    -h | --help)
      print_usage
      return 0
      ;;
    --rotate)
      rotate="${2:-}"
      [[ "${rotate}" == key || "${rotate}" == passphrase ]] || fail_usage "--rotate takes key or passphrase"
      (($# == 2)) || fail_usage "unexpected argument after --rotate ${rotate}"
      ;;
    *) fail_usage "unknown argument $1" ;;
  esac
  [[ -t 0 ]] || fail_usage "stdin is not a terminal — run this yourself on a TTY"
  command -v node >/dev/null || fail "node is not on PATH; it derives the passphrase hash"
  # saved in this shell → its EXIT trap restores echo even when the passphrase read inside a $( ) is cut off
  tty_state="$(stty -g)" || fail "cannot read the terminal state"

  local dir
  # shellcheck disable=SC2310  # an unusable secrets dir is this script's named failure, never an errexit
  dir="$(get_secrets_dir)" || fail "cannot prepare the 0700 secrets directory"
  if [[ -n "${rotate}" ]]; then
    put_rotated_secret "${dir}" "${rotate}"
  else
    put_missing_secrets "${dir}"
  fi
}

print_usage() {
  local dir
  dir="$(queue_get_root)/secrets"
  cat <<USAGE
Usage: atrium-queue-setup.sh [--rotate key|passphrase]
  Run once on a terminal. Writes, as 0600 files in the 0700 directory ${dir}:
    ${KEY_FILE_NAME}               the queue key the sessions' hooks and the queue CLI send
    ${PASSPHRASE_FILE_NAME}   the scrypt record of the owner passphrase the Queue page login checks
  With no option it writes only what is missing and keeps an existing secret.
  --rotate key|passphrase replaces that one secret; restart the monitor afterwards so it reads it.
  The passphrase is asked twice with echo off and goes to node over stdin, never argv or env.
USAGE
}

fail_usage() {
  printf 'atrium-queue-setup: %s\n' "$1" >&2
  print_usage >&2
  exit 64
}

fail() {
  printf 'atrium-queue-setup: %s\n' "$1" >&2
  exit 1
}

# The secrets dir, created 0700; a link or a foreign-owned entry is never written through.
get_secrets_dir() {
  local dir
  dir="$(queue_get_root)/secrets"
  (umask 077 && mkdir -p -- "${dir}") || return 1
  [[ -d "${dir}" && ! -L "${dir}" && -O "${dir}" ]] || return 1
  chmod 700 "${dir}" || return 1
  printf '%s\n' "${dir}"
}

put_missing_secrets() {
  local dir="$1" key="" record=""
  if [[ -e "${dir}/${KEY_FILE_NAME}" && -e "${dir}/${PASSPHRASE_FILE_NAME}" ]]; then
    printf 'Both secrets are already in %s; nothing changed. Replace one with --rotate key|passphrase.\n' "${dir}"
    return 0
  fi
  if [[ ! -e "${dir}/${PASSPHRASE_FILE_NAME}" ]]; then
    # shellcheck disable=SC2310  # the getter already printed its reason; exit 1 without an ERR trace
    record="$(get_passphrase_record)" || exit 1
  fi
  if [[ ! -e "${dir}/${KEY_FILE_NAME}" ]]; then
    # shellcheck disable=SC2310  # the getter already printed its reason; exit 1 without an ERR trace
    key="$(get_new_key)" || exit 1
  fi
  if [[ -n "${record}" ]]; then put_secret "${dir}" "${PASSPHRASE_FILE_NAME}" "${record}"; fi
  if [[ -n "${key}" ]]; then put_secret "${dir}" "${KEY_FILE_NAME}" "${key}"; fi
  printf 'Provisioned in %s. The monitor reads new secrets on its next request; no restart needed.\n' "${dir}"
}

put_rotated_secret() {
  local dir="$1" rotate="$2" value file
  if [[ "${rotate}" == passphrase ]]; then
    # shellcheck disable=SC2310  # the getter already printed its reason; exit 1 without an ERR trace
    value="$(get_passphrase_record)" || exit 1
    file="${PASSPHRASE_FILE_NAME}"
  else
    # shellcheck disable=SC2310  # the getter already printed its reason; exit 1 without an ERR trace
    value="$(get_new_key)" || exit 1
    file="${KEY_FILE_NAME}"
  fi
  put_secret "${dir}" "${file}" "${value}"
  printf 'Replaced %s/%s. Restart the monitor so it reads the new %s.\n' "${dir}" "${file}" "${rotate}"
}

# Two echo-off entries → the record JSON on stdout; the passphrase stays in this shell, never exported.
get_passphrase_record() {
  local first second record
  # echo off before the first prompt shows: read -s may print its prompt first, so early typing would echo
  stty -echo || fail "cannot turn terminal echo off"
  printf 'Owner passphrase (12 to 1024 characters): ' >&2
  IFS= read -r first || fail "no passphrase entered"
  printf '\nRepeat the passphrase: ' >&2
  IFS= read -r second || fail "no passphrase entered"
  printf '\n' >&2
  put_tty_state
  [[ "${first}" == "${second}" ]] || fail "the two entries differ; nothing written"
  # shellcheck disable=SC2310  # a refused or failed derivation is this script's failure, never an errexit
  record="$(printf '%s' "${first}" | node -e "${PASSPHRASE_JS}")" || fail "the passphrase hash was not derived; nothing written"
  printf '%s\n' "${record}"
}

get_new_key() {
  local key
  key="$(node -e "${KEY_JS}")" || fail "the queue key was not generated; nothing written"
  [[ "${key}" =~ ${QUEUE_KEY_SHAPE} ]] || fail "the generated queue key has the wrong shape; nothing written"
  printf '%s\n' "${key}"
}

# Write-then-rename in the same 0700 dir → a reader sees the old file or the whole new one.
put_secret() {
  local dir="$1" name="$2" value="$3" tmp
  tmp="$(umask 077 && mktemp "${dir}/.${name}.XXXXXX")" || fail "cannot create a temp file in ${dir}"
  if ! printf '%s\n' "${value}" >"${tmp}" || ! chmod 600 "${tmp}" || ! mv -f -- "${tmp}" "${dir}/${name}"; then
    if ga_guard_path "${tmp}"; then rm -f -- "${tmp:?}"; fi
    fail "cannot write ${dir}/${name}"
  fi
}

main "$@"
