#!/usr/bin/env bash
# PreToolUse(Write|Edit|Bash) — block on secret-pattern detection.
#   Write|Edit channel: scan tool_input.content + tool_input.new_string through scripts/lib/secret-scan.sh.
#   Bash channel: scan tool_input.command for a HIGH-SIGNAL credential value
#     redirected/heredoc'd into a dotenv/secrets file (a secret can otherwise be
#     written via `echo KEY=... > .env`, fully bypassing the Write|Edit channel).
# One coherent secret-scan surface — branches on tool_name. Both invocations
# block with exit 2 on match. Bind this hook to BOTH Write|Edit and Bash.
# A Write|Edit whose every match is SEC-013 passes once on the owner's queue approval of exactly those lines
# (the monitor's consume); otherwise it is refused, plus one line: the request id, or why none was checked.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"
if [[ -r "${BASH_SOURCE%/*}/lib/pipe-drain.sh" ]]; then
  # shellcheck source=lib/pipe-drain.sh
  source "${BASH_SOURCE%/*}/lib/pipe-drain.sh"
else
  # Library missing or unreadable → the same drain_after in place, so the hook keeps its verdict.
  # A test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition.
  drain_after() {
    local rc=0
    "$@" || rc=$?
    cat >/dev/null || true
    return "${rc}"
  }
fi

# WHY fail-closed: field extraction degrades to EMPTY without python3 (tool_name
# mis-detects, content scans nothing), which would let a credential write through
# unscanned. A secret gate MUST refuse rather than silently allow — block here so
# no unscanned write can proceed on a python3-less PATH.
hook_require_python3 "SEC-017" \
  "Secret scan unavailable: python3 is required to parse hook input"

# Payload names: an inherited export would carry them into every child's environment, capped per string on Linux.
export -n INPUT CMD CONTENT input blob cmd
INPUT=$(hook_read_input)
TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")

# The content patterns and their scan live in the shared scanner, found through this file's real path — a symlinked
# copy has no scripts/ beside it; exit contract: the scanner's header.
self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then self="$(readlink -f -- "${self}")" || self=""; fi
readonly SCANNER="${self%/*}/../scripts/lib/secret-scan.sh"
readonly SCAN_CLEAN=0
readonly SCAN_MATCH=3
readonly SCAN_LIST_FLAG=--list-all
readonly HOOK_LIB_DIR="${self%/*}/lib"
readonly SCRIPTS_LIB_DIR="${self%/*}/../scripts/lib"
# the one rule an owner may approve and the monitor routes that bind the approval
readonly APPROVABLE_RULE=SEC-013
readonly CONSUME_ROUTE=/api/queue/scan-approvals/consume
readonly REGISTER_ROUTE=/api/queue/scan-approvals
# whole approval step (list, build, consume, register); each monitor call also carries queue_send's own deadlines
readonly APPROVAL_DEADLINE_S=6
readonly APPROVAL_PREFIX="${APPROVABLE_RULE} approval:"
readonly HASH_LIST_SHAPE='^[0-9a-f]{64}(,[0-9a-f]{64})*$'
readonly REPLY_CODE_SHAPE='^[a-z_]{1,64}$'
# the text the scanner sees → an approval binds the same lines
readonly SCANNED_FIELD_PY='def get_scanned_field(d):
    ti = d.get("tool_input", {})
    return ti.get("content", "") + ti.get("new_string", "")'
# payload on stdin, rule then the 1-based lines to approve as arguments → the consume body, the register body, the
# hashes joined by commas; exit 65 no session_id, 66 a target path with no real parent directory
readonly APPROVAL_BODIES_PY='import json, os, sys
d = json.load(sys.stdin)
session = d.get("session_id")
if not isinstance(session, str) or not session:
    sys.exit(65)
path = d.get("tool_input", {}).get("file_path")
if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isdir(os.path.dirname(path)):
    sys.exit(66)
path = os.path.realpath(path)
lines = get_lines(get_scanned_field(d).encode("utf-8"))
picked = [lines[int(index) - 1] for index in sys.argv[2:]]
hashes = [get_line_hash(line) for line in picked]
agent = {key: d.get(field) if isinstance(d.get(field), str) else "" for key, field in (("id", "agent_id"), ("type", "agent_type"))}
target = {"sessionId": session, "path": path, "rule": sys.argv[1]}
print(json.dumps(dict(target, hashes=hashes)))
texts = [{"text": line.decode("utf-8"), "hash": digest} for line, digest in zip(picked, hashes)]
print(json.dumps(dict(target, agent=agent, lines=texts)))
print(",".join(hashes))'
# reply body on stdin → the string value of the key named by the argument; exit 1 for any other shape, a line break
# included → the caller's $( ) cannot strip "pass\n" into "pass"
readonly REPLY_VALUE_PY='import json, sys
d = json.load(sys.stdin)
value = d.get(sys.argv[1]) if isinstance(d, dict) else None
if not isinstance(value, str) or "\n" in value:
    sys.exit(1)
print(value)'

# Scan a blob through the shared scanner; exit 2 on a match and on any outcome but clean (fail-closed).
# Args: $1=blob to scan
scan_content() {
  local blob="${1}" reply="" rc=0
  [[ -z "${blob}" ]] && return 0
  [[ -f "${SCANNER}" ]] || block_scan_unavailable
  reply="$("${BASH}" "${SCANNER}" <<<"${blob}")" || rc=$?
  [[ "${rc}" -eq "${SCAN_CLEAN}" ]] && return 0
  if [[ "${rc}" -ne "${SCAN_MATCH}" || ! "${reply}" =~ ^(SEC-[0-9]{3})$'\t'(.+)$ ]]; then
    block_scan_unavailable
  fi
  local code="${BASH_REMATCH[1]}" name="${BASH_REMATCH[2]}"
  APPROVAL_NOTE=""
  # shellcheck disable=SC2310  # the approval's verdict is its status; every failure inside refuses
  if [[ "${code}" == "${APPROVABLE_RULE}" ]] && is_approved_write "${blob}"; then return 0; fi
  emit_error "${code}" "block" \
    "Secret pattern detected: ${name}" \
    "Replace the hardcoded secret with an environment-variable reference (core-security.md -> Secret Management)" \
    "{\"pattern\":\"${code}\"}"
  [[ -z "${APPROVAL_NOTE}" ]] || _hook_emit_line "${APPROVAL_NOTE}"
  exit 2
}

# Asks the monitor to consume the owner's approval of this write's SEC-013 lines, within APPROVAL_DEADLINE_S.
# Returns 0 only on the monitor's pass, with a hash-only log line; else 1 with APPROVAL_NOTE the refusal's added line.
# Args: $1=scanned blob
is_approved_write() {
  local outcome status=0
  APPROVAL_NOTE="${APPROVAL_PREFIX} the approval check could not run; this write stays refused"
  # shellcheck disable=SC2310  # a library that cannot load is a refusal, never an errexit
  set_approval_libs || return 1
  # shellcheck disable=SC2310  # the step's own status is read below; a missed deadline is DEADLINE_STATUS
  outcome="$(run_with_deadline "${APPROVAL_DEADLINE_S}" get_approval_outcome "${1}" </dev/null)" || status=$?
  if ((status == DEADLINE_STATUS)); then
    APPROVAL_NOTE="${APPROVAL_PREFIX} the approval check passed its ${APPROVAL_DEADLINE_S} s deadline; this write stays refused"
    return 1
  fi
  is_pass_outcome "${outcome}"
}

# Reads the step's outcome line → 0 only on a well-formed pass, logged; else 1 with APPROVAL_NOTE naming what failed.
# Args: $1=outcome line
is_pass_outcome() {
  local kind="${1%%$'\t'*}" value="${1#*$'\t'}" hashes
  case "${kind}" in
    cause) APPROVAL_NOTE="${APPROVAL_PREFIX} ${value}; this write stays refused" ;;
    request)
      APPROVAL_NOTE="${APPROVAL_PREFIX} the monitor's register reply was malformed; this write stays refused"
      [[ ! "${value}" =~ ${QUEUE_UUID_SHAPE} ]] || APPROVAL_NOTE="$(get_request_note "${value}")"
      ;;
    pass)
      hashes="${value#*$'\t'}" value="${value%%$'\t'*}"
      if [[ "${value}" =~ ${QUEUE_UUID_SHAPE} && "${hashes}" =~ ${HASH_LIST_SHAPE} ]]; then
        put_pass_log "${value}" "${hashes}"
        return 0
      fi
      APPROVAL_NOTE="${APPROVAL_PREFIX} the monitor's consume reply was malformed; this write stays refused"
      ;;
    *) ;;
  esac
  return 1
}

# Loads the bounded wait, the line hash and the monitor client; 1 when any is missing or fails to load.
set_approval_libs() {
  local wait_lib="${HOOK_LIB_DIR}/bounded-wait.sh" hash_lib="${HOOK_LIB_DIR}/scan-approval.sh"
  local queue_lib="${SCRIPTS_LIB_DIR}/queue-session.sh"
  # a test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition
  [[ -r "${wait_lib}" && -r "${hash_lib}" && -r "${queue_lib}" ]] || return 1
  # shellcheck source-path=SCRIPTDIR source=lib/bounded-wait.sh
  source "${wait_lib}" || return 1
  # shellcheck source-path=SCRIPTDIR source=lib/scan-approval.sh
  source "${hash_lib}" || return 1
  # shellcheck source-path=SCRIPTDIR source=../scripts/lib/queue-session.sh
  source "${queue_lib}" || return 1
}

# The refusal's line for a registered request → its id and the one sanctioned route, never the line.
# Args: $1=request id
get_request_note() {
  printf '%s request %s registered. Post the secret-approval form with this request id alone, never the line; on the owner'"'"'s approve answer repeat the identical write once, and this hook decides. A subagent returns the request id and the target path, never the line; it never posts and never retries before its parent'"'"'s approve answer.\n' \
    "${APPROVAL_PREFIX}" "${1}"
}

# One line per approved pass → which approval let which line hashes through; ids and hashes only.
# Args: $1=request id · $2=hashes joined by commas
put_pass_log() {
  local stamp
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || stamp=unknown-time
  mkdir -p -- "${HOOK_LOG_DIR}" 2>/dev/null || return 0
  # GA-ABSORB[benign]: the pass is the monitor's consume; a lost log line never turns it into a refusal
  (printf '%s %s approved write passed request=%s hashes=%s\n' "${stamp}" "${APPROVABLE_RULE}" "${1}" "${2}") \
    >>"${HOOK_LOG_DIR}/validate-secret-scan.log" 2>/dev/null || true
}

# The bounded step: list every match, then consume, then register on a refusal. Prints one outcome line —
# "pass<TAB><request id><TAB><hashes>", "request<TAB><request id>" or "cause<TAB><why no approval was checked>".
# Args: $1=scanned blob
# shellcheck disable=SC2329  # invoked through run_with_deadline
get_approval_outcome() {
  local rows index code bodies rc=0 reply
  local -a indexes=()
  # pipe, not here-string → the text never spills to a temp file
  rows="$(printf '%s\n' "${1}" | "${BASH}" "${SCANNER}" "${SCAN_LIST_FLAG}")" || rc=$?
  if ((rc != SCAN_MATCH)) || [[ -z "${rows}" ]]; then
    printf 'cause\tthe scanner could not list the matching lines\n'
    return 0
  fi
  while IFS=$'\t' read -r index code; do
    if [[ "${code}" != "${APPROVABLE_RULE}" ]]; then
      printf 'cause\tanother secret rule also matches this write, so no approval can cover it\n'
      return 0
    fi
    indexes+=("${index}")
  done <<<"${rows}"
  if ! command -v curl >/dev/null 2>&1; then
    printf 'cause\tcurl is not available, so no approval was checked\n'
    return 0
  fi
  rc=0
  bodies="$(printf '%s\n' "${INPUT}" | python3 -I -c "${SCAN_APPROVAL_HASH_PY}"$'\n'"${SCANNED_FIELD_PY}"$'\n'"${APPROVAL_BODIES_PY}" \
    "${APPROVABLE_RULE}" "${indexes[@]}" 2>/dev/null)" || rc=$?
  case "${rc}" in
    0) ;;
    65) printf 'cause\tthe hook payload carries no session_id\n' && return 0 ;;
    66) printf 'cause\tthe target path has no real parent directory\n' && return 0 ;;
    *) printf 'cause\tthe approval request could not be built\n' && return 0 ;;
  esac
  # shellcheck disable=SC2310  # queue_send fails only with no reply at all → a cause, never an errexit
  reply="$(printf '%s\n' "${bodies%%$'\n'*}" | queue_send POST "${CONSUME_ROUTE}" -)" || {
    printf 'cause\tthe monitor did not answer, so no approval was checked\n'
    return 0
  }
  bodies="${bodies#*$'\n'}"
  put_consume_outcome "${reply}" "${bodies%%$'\n'*}" "${bodies#*$'\n'}"
}

# The consume reply decides: pass, or on the monitor's refusal register the lines; any other reply is a cause.
# Args: $1=consume reply · $2=register body · $3=hashes joined by commas
# shellcheck disable=SC2329  # invoked through run_with_deadline
put_consume_outcome() {
  local code body value
  code="$(queue_get_reply_code "${1}")"
  body="$(queue_get_reply_body "${1}")"
  value="$(printf '%s\n' "${body}" | python3 -I -c "${REPLY_VALUE_PY}" decision 2>/dev/null)" || value=""
  if [[ "${code}" == 200 && "${value}" == pass ]]; then
    value="$(printf '%s\n' "${body}" | python3 -I -c "${REPLY_VALUE_PY}" requestId 2>/dev/null)" || value=""
    printf 'pass\t%s\t%s\n' "${value}" "${3}"
  elif [[ "${code}" == 409 && "${value}" == refuse ]]; then
    put_register_outcome "${2}"
  else
    printf 'cause\tthe monitor'"'"'s consume reply was neither a pass nor a refusal\n'
  fi
}

# Registers the write's SEC-013 lines (body on curl's stdin, never an argument) → the request id, or a cause.
# Args: $1=register body
# shellcheck disable=SC2329  # invoked through run_with_deadline
put_register_outcome() {
  local reply code body value
  # shellcheck disable=SC2310  # queue_send fails only with no reply at all → a cause, never an errexit
  reply="$(printf '%s\n' "${1}" | queue_send POST "${REGISTER_ROUTE}" -)" || {
    printf 'cause\tthe monitor did not answer the request registration\n'
    return 0
  }
  code="$(queue_get_reply_code "${reply}")"
  body="$(queue_get_reply_body "${reply}")"
  if [[ "${code}" == 200 ]] && value="$(printf '%s\n' "${body}" | python3 -I -c "${REPLY_VALUE_PY}" requestId 2>/dev/null)"; then
    printf 'request\t%s\n' "${value}"
    return 0
  fi
  value="$(printf '%s\n' "${body}" | python3 -I -c "${REPLY_VALUE_PY}" error 2>/dev/null)" || value=""
  [[ "${value}" =~ ${REPLY_CODE_SHAPE} ]] || value="no readable code"
  printf 'cause\tthe monitor did not register the request (HTTP %s, %s)\n' "${code}" "${value}"
}

block_scan_unavailable() {
  emit_error "SEC-017" "block" \
    "Secret scan unavailable: the shared scanner is missing or failed" \
    "Restore scripts/lib/secret-scan.sh (glass-atrium update) and retry" \
    "{\"missing\":\"secret-scan\"}"
  exit 2
}

# Bash channel (HIGH SIGNAL ONLY).
# Block a credential VALUE written into a dotenv/secrets file via Bash.
# Anti-FP gate: require BOTH a secrets-file write target AND a credential value
# on the command — neither alone blocks (a benign `echo hello`, an `echo to
# app.log`, a `tee app.log`, a `dd of=backup.img`, or a placeholder `KEY=` →
# .env, all pass).
#   SECRET_TARGET — the secrets file (basename .env / .envrc / secrets* /
#                   credentials*) appearing as a write target across nine
#                   shell write methods, OR'd into one coherent alternation:
#                     (1) `>`/`>>` redirect   (2) heredoc → secrets file
#                     (3) `tee`/`tee -a` arg  (4) `dd of=` target
#                     (5) inline python/node `open('<secretsfile>','w'|'a')`
#                     (6) `cp`/`mv` whose DESTINATION (final positional arg) is a
#                         secrets-file name — a pre-staged file copied/moved INTO
#                         a .env/secrets name.
#                     (7) `sed -i`/`sed --in-place` whose terminal positional arg
#                         is a secrets file — an in-place stream edit that injects
#                         a credential without any `>`/`tee`/`cp` token.
#                     (8) `install` whose DESTINATION (final positional arg) is a
#                         secrets file — `install` copies stdin (`/dev/stdin`) or a
#                         source file to the target.
#                     (9) `ed` whose terminal positional arg is a secrets file — a
#                         line editor in-place write (`printf '...' | ed .env`).
#                   `tee`/`dd`/`cp`/`mv`/`sed`/`install`/`ed` are word-boundary-
#                   anchored (start | space | pipe | `;`/`&`) so `systee`/`scp`/
#                   `mvcmd`/`embed`/`uninstall` substrings do not match. The
#                   `cp`/`mv`/`sed -i`/`install`/`ed` destination is terminal-token-
#                   anchored (secrets file is the LAST positional arg, followed by a
#                   command terminator `;`/`&`/`|`, a `#` shell comment, a `<`
#                   redirect [the `install /dev/stdin .env <<<` here-string idiom],
#                   or end-of-line) so a SOURCE arg that merely looks like a secrets
#                   file (e.g. `cp config.env.example dist/`) does NOT match — only a
#                   true secrets DESTINATION does. `sed` additionally requires an
#                   in-place flag (`-i`/`--in-place`), so a benign
#                   `sed -i 's/x/y/' file.txt` to a non-secrets file never matches.
#   CRED_VALUE    — a structured secret token OR a generic credential assignment
#                   with a non-trivial (≥8 char) value (placeholders excluded).
# UNGUARDED residual (coverage boundary — a static command-string scan cannot see
#   runtime-resolved values): variable-expanded redirect target
#   (`F=.env; echo cred > $F`) · variable-indirected secret (`echo "$SECRET" >
#   .env`) · base64/hex-encoded value · bare `cp`/`mv`/`install`/`ed`/`sed -i` of a
#   pre-staged secret file with NO inline credential on the command line (the dual-
#   condition gate needs a visible CRED_VALUE; the pre-staged file's CONTENT is off
#   the command string, so `cp prestaged-secret .env` alone still PASSES — this
#   residual stays open and bounded). Further uncovered in-place channels: any tool
#   that takes a secrets file as a NON-terminal arg (e.g. `sed -i ... .env extra`),
#   `ex`/`vim -c`/`perl -i`/`awk -i inplace` editor variants, and a `tee`/`install`
#   whose target arrives via process substitution — these are additional channels
#   left open by this static heuristic. A PostToolUse filesystem-scan of the WRITTEN
#   file's content would be a SEPARATE detection layer (detection-AFTER-write, NOT
#   prevention) covering the runtime-value residuals above; this PreToolUse hook is a
#   high-signal first line, not a complete exfiltration barrier.
# SECRETS_FILE — reusable basename fragment shared by every method alternative.
SECRETS_FILE='[^ ]*(\.env(\.[a-z]+)?|\.envrc|secrets?(\.[a-z]+)?|credentials?(\.[a-z]+)?)'
SECRET_TARGET='(>>?[ ]*'"${SECRETS_FILE}"'|<<[-]?[ ]*[A-Za-z'"'"'"]*EOF[^ ]*[ ]*>>?[ ]*[^ ]*(\.env|\.envrc|secrets?|credentials?)|(^|[ |;&])tee( +-a)?( +-[^ ]+)* +'"${SECRETS_FILE}"'|(^|[ |;&])dd( +[^ ]+)* +of='"${SECRETS_FILE}"'|open\([ ]*["'"'"'][^"'"'"']*(\.env(\.[a-z]+)?|\.envrc|secrets?(\.[a-z]+)?|credentials?(\.[a-z]+)?)["'"'"'][ ]*,[ ]*["'"'"'](w|a)["'"'"']|(^|[ |;&])(cp|mv)( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#]|$)|(^|[ |;&])sed( +[^ ;&|]+)*( +(-i[^ ]*|--in-place[^ ]*))( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])install( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])ed( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$))'
CRED_VALUE='(AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|xox[bpoa]-[0-9a-zA-Z-]+|(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,})'

# Inspect a Bash command for a high-signal secret write; exit 2 on match.
# Args: $1=command string
scan_bash_command() {
  local cmd="${1}"
  [[ -z "${cmd}" ]] && return 0
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  if printf '%s\n' "${cmd}" | drain_after grep -qiE -- "${SECRET_TARGET}" \
    && printf '%s\n' "${cmd}" | drain_after grep -qiE -- "${CRED_VALUE}"; then
    emit_error "SEC-016" "block" \
      "Secret written to a dotenv/secrets file via Bash" \
      "Do not write credentials into .env/secrets files (redirect/heredoc/tee/dd/open/cp/mv/sed-i/install/ed); use env vars or a secret manager" \
      "{\"channel\":\"bash\"}"
    exit 2
  fi
}

if [[ "${TOOL_NAME}" == "Bash" ]]; then
  CMD=$(hook_get_tool_input "${INPUT}" "command")
  scan_bash_command "${CMD}"
  exit 0
fi

# Default (Write|Edit): scan combined content + new_string.
CONTENT=$(printf '%s\n' "${INPUT}" | python3 -c "${SCANNED_FIELD_PY}"$'\n''import sys, json
print(get_scanned_field(json.load(sys.stdin)))' 2>/dev/null) || CONTENT=""

scan_content "${CONTENT}"
exit 0
