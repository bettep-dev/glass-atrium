#!/usr/bin/env bash
# detect-secret-file-write.sh — PostToolUse(Bash) credential-content tripwire.
#
# DEFENSE-IN-DEPTH companion to PreToolUse validate-secret-scan.sh (SoT): that hook
# scans the COMMAND STRING, so it cannot see a value not literal in the command.
# This scans the WRITTEN FILE CONTENT post-write, catching 3 residual channels:
#   - variable-indirected value:  echo "$SECRET" > .env
#   - base64/hex-decoded value:   echo <b64> | base64 -d > .env
#   - copy of a pre-staged file:  cp prestaged.env .env
#
# DETECTOR, NOT PREVENTER: PostToolUse runs AFTER the write (secret already on disk,
# no block channel) → ALWAYS exits 0; value is the incident-response signal.
#
# Flow (3 stages, fail-fast):
#   1. Scope gate: require a WRITE CHANNEL to a .env-class target (redirect/heredoc/
#      tee/dd of=/cp/mv/sed -i/install/ed dest, or inline open(...,'w'|'a')), NOT a
#      bare path mention — a read-only cat/source/grep/--env-file exits 0 (no scan,
#      no warn). MIRRORS validate-secret-scan.sh SECRET_TARGET (the SoT).
#   2. Content scan: for each .env-class path token that now exists + is readable,
#      scan its CONTENT for credential-VALUE patterns.
#   3. Alert (never the value): on a match emit a SEC-017 stderr WARNING with FILE
#      PATH + pattern-TYPE label ONLY — NEVER the value (core-security: secrets
#      must never be logged). Exit 0.
#
# DOCUMENTED RESIDUAL (coverage boundary): a variable-indirected PATH
# (`F=.env; echo "$SECRET" > "$F"`) whose literal `.env` never appears in the
# command is NOT caught (path known only at runtime) — bounded, and it is a
# DETECTOR (post-write), not a preventer.
#
# Fail-safe: any parse error / no command / unreadable file / ERR trap → exit 0
# silently. Never blocks, never crashes a tool.
#
# Trigger: PostToolUse, Bash tool only. Read hook input JSON from stdin.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# fail-open ERR trap — a tripwire internal error must not perturb the session.
trap 'exit 0' ERR

# Pattern sources — MIRRORED from validate-secret-scan.sh (that hook is the SoT).
# Keep in sync with its SECRETS_FILE (~L141) + CRED_VALUE (~L143): no shared lib to
# source today, so this is a deliberate mirror, not a silent fork — update both on
# a pattern change.
#
# SECRETS_FILE — basename fragment for a .env-class target (.env/.env.<ext>/.envrc/
# secrets[.ext]/credentials[.ext]). Adds id_rsa + *.pem|*.key as explicit secrets-
# file names (validate-secret-scan gates those via content PEM patterns) so a
# key-file write is in scope for the content scan.
readonly SECRETS_FILE='[^ ]*(\.env(\.[a-zA-Z0-9]+)?|\.envrc|secrets?(\.[a-zA-Z0-9]+)?|credentials?(\.[a-zA-Z0-9]+)?|id_rsa|[^ ]*\.pem|[^ ]*\.key)'

# WRITE_TARGET — Stage-1 scope-gate discriminator. A bare .env-class PATH MENTION
# is NOT enough (fired a false SEC-017 on read-only cat/source/grep/--env-file
# whenever a legit credential-bearing .env existed); the gate requires a WRITE
# CHANNEL, MIRRORING validate-secret-scan.sh SECRET_TARGET (the SoT) scoped to this
# hook's SECRETS_FILE (keeps .pem/.key/id_rsa in scope):
#   (1) `>`/`>>` redirect  (2) heredoc redirect  (3) `tee`/`tee -a` arg
#   (4) `dd of=` target     (5) inline open('<secretsfile>','w'|'a')
#   (6-9) cp/mv/sed -i/install/ed whose terminal positional DEST is a secrets file
# tee/dd/cp/mv/sed/install/ed are word-boundary-anchored (start|space|pipe|`;`/`&`)
# so scp/mvcmd/embed/uninstall do not match; the DEST is terminal-token-anchored so
# a SOURCE that only looks like a secrets file (`cp prestaged.env .env`) does NOT
# trip the gate — only the true DESTINATION does. A read-only command matches none
# → exits before the content scan.
readonly WRITE_TARGET='(>>?[ ]*'"${SECRETS_FILE}"'|<<[-]?[ ]*[A-Za-z'"'"'"]*EOF[^ ]*[ ]*>>?[ ]*[^ ]*(\.env|\.envrc|secrets?|credentials?|id_rsa|\.pem|\.key)|(^|[ |;&])tee( +-a)?( +-[^ ]+)* +'"${SECRETS_FILE}"'|(^|[ |;&])dd( +[^ ]+)* +of='"${SECRETS_FILE}"'|open\([ ]*["'"'"'][^"'"'"']*(\.env(\.[a-zA-Z0-9]+)?|\.envrc|secrets?(\.[a-zA-Z0-9]+)?|credentials?(\.[a-zA-Z0-9]+)?|id_rsa|\.pem|\.key)["'"'"'][ ]*,[ ]*["'"'"'](w|a)["'"'"']|(^|[ |;&])(cp|mv)( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#]|$)|(^|[ |;&])sed( +[^ ;&|]+)*( +(-i[^ ]*|--in-place[^ ]*))( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])install( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])ed( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$))'

# CRED_VALUE — credential-VALUE patterns (structured tokens + generic assignment +
# PEM block + service-account marker). Mirrors validate-secret-scan.sh CRED_VALUE,
# extended with content-only patterns (JWT, DB/Mongo URI, PEM header,
# service_account) the SoT applies in its Write|Edit channel — apt here since we
# scan FILE CONTENT. Each pairs with a TYPE label (CRED_NAMES) for the alert; the
# VALUE is NEVER emitted.
readonly -a CRED_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[a-zA-Z0-9]{36}'
  'sk-[a-zA-Z0-9]{20,}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[bpoa]-[0-9a-zA-Z-]+'
  'eyJ[a-zA-Z0-9_-]*\.eyJ'
  'postgres://[^ ]*@'
  'mongodb(\+srv)?://[^ ]*@'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '"type"[ ]*:[ ]*"service_account"'
  '(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,}'
)
readonly -a CRED_NAMES=(
  "AWS access key pattern"
  "GitHub token pattern"
  "API key (sk-) pattern"
  "Google API key pattern"
  "Slack token pattern"
  "JWT token pattern"
  "Postgres connection-string pattern"
  "MongoDB connection-string pattern"
  "PEM private key block"
  "Service-account JSON marker"
  "Generic credential assignment"
)

# Scan a file's CONTENT for credential-value patterns; emit a SEC-017 alert
# (path + pattern-TYPE label only, NEVER the value) on the first match, exit 0.
# Args: $1 = file path (already confirmed to exist + be readable by caller)
scan_file_content() {
  local file="${1}" i
  for i in "${!CRED_PATTERNS[@]}"; do
    # `-i` case-insensitive for credential keys · `--` so a dash-leading PEM
    # pattern is not parsed by BSD grep as an option flag · `-q` so the matched
    # LINE (which contains the value) is never printed — only our label is.
    if grep -qiE -- "${CRED_PATTERNS[${i}]}" "${file}" 2>/dev/null; then
      # SECURITY: emit path + pattern-TYPE label + remediation ONLY. The
      # credential VALUE MUST NEVER be read out, echoed, or logged.
      emit_error "SEC-017" "warn" \
        "Credential content detected in a secrets file (post-write tripwire): ${CRED_NAMES[${i}]} in ${file}" \
        "Rotate the exposed credential immediately and remove it from the file; use env vars or a secret manager. This is a post-write alert — the value already landed on disk." \
        "{\"file\":\"${file}\",\"pattern_type\":\"${CRED_NAMES[${i}]}\"}"
      return 0
    fi
  done
  return 0
}

INPUT="$(hook_read_input)"
TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"

# Trigger gate: Bash tool only (the residual channels are bash commands).
if [[ "${TOOL_NAME}" != "Bash" ]]; then
  exit 0
fi

CMD="$(hook_get_tool_input "${INPUT}" "command")"

# Stage 1 — scope gate (cheap, fail-fast): require a WRITE CHANNEL to a .env-class
# target (WRITE_TARGET), not a bare path mention. A read-only command that only
# NAMES a secrets file → exit immediately (no scan, no warn).
if [[ -z "${CMD}" ]]; then
  exit 0
fi
if ! printf '%s\n' "${CMD}" | grep -qiE -- "${WRITE_TARGET}"; then
  exit 0
fi

# Stage 2 — extract each .env-class path token, content-scan it IF it exists + is
# readable. `< <(...)` process substitution keeps the loop in the current shell
# (a pipe would subshell-scope it). De-dup so a path appearing twice
# (`cp a.env b.env`) is scanned once.
declare -a scanned=()
while IFS= read -r token; do
  [[ -z "${token}" ]] && continue
  # Skip if the token is not a regular, readable file (e.g. `cat .env` of a
  # non-existent path).
  [[ -f "${token}" && -r "${token}" ]] || continue
  # De-dup inline (no predicate function — avoids SC2310 set -e disabling); `dup`
  # resets per iteration, matched entries set it and skip.
  dup=0
  for seen in "${scanned[@]:-}"; do
    if [[ "${seen}" == "${token}" ]]; then
      dup=1
      break
    fi
  done
  [[ "${dup}" -eq 1 ]] && continue
  scanned+=("${token}")
  scan_file_content "${token}"
done < <(printf '%s\n' "${CMD}" | grep -oiE -- "${SECRETS_FILE}" 2>/dev/null || true)

# Stage 3 alerts (if any) already emitted to stderr inside scan_file_content.
# Always advisory — PostToolUse cannot block.
exit 0
