#!/usr/bin/env bash
# detect-secret-file-write.sh — PostToolUse(Bash) credential-content tripwire.
#
# DEFENSE-IN-DEPTH companion to the PreToolUse `validate-secret-scan.sh`. That
# hook scans the COMMAND STRING; it structurally CANNOT see a credential whose
# VALUE is not literal in the command text. This hook closes part of that gap by
# scanning the WRITTEN FILE'S CONTENT after the write already ran. Residual
# channels it catches that the command-string scan cannot:
#   - variable-indirected value:  echo "$SECRET" > .env   (cred is in a var)
#   - base64/hex-decoded value:   echo <b64> | base64 -d > .env
#   - copy of a pre-staged file:  cp prestaged.env .env    (no cred in command)
#
# DETECTOR, NOT PREVENTER: PostToolUse runs AFTER the write — the secret already
# landed on disk and PostToolUse has no block channel. This is an ALERT-ONLY
# tripwire: it ALWAYS exits 0. Its value is the incident-response signal +
# catching content the PreToolUse command-scan cannot.
#
# Flow (3 stages, fail-fast):
#   1. Scope gate (cheap, O(1) on the vast majority of Bash calls): proceed only
#      if the command shows a WRITE CHANNEL to a .env-class target — a redirect
#      (`> .env`/`>> .env`), heredoc, `tee`/`dd of=`/`cp`/`mv`/`sed -i`/`install`/
#      `ed` into a secrets-file destination, or an inline `open(...,'w'|'a')`.
#      A bare PATH MENTION with no write channel (a read-only `cat .env`,
#      `source .env`, `grep KEY .env`, `--env-file .env`) → exit 0 immediately,
#      NO scan, NO warn — pure reads are intentionally not flagged (this is a
#      WRITE tripwire; a read exposes nothing new on disk). The write-channel
#      alternation MIRRORS validate-secret-scan.sh SECRET_TARGET (the SoT).
#   2. Content scan: for each .env-class path token in the command, IF that file
#      now exists + is readable, scan its CONTENT for credential-VALUE patterns.
#   3. Alert (never the value): on a content match, emit a SEC-017 stderr WARNING
#      carrying the FILE PATH + matched pattern-TYPE label ONLY — NEVER the
#      credential value (core-security: secrets must never be logged). Exit 0.
#
# DOCUMENTED RESIDUAL (coverage boundary):
#   - A variable-indirected PATH (`F=.env; echo "$SECRET" > "$F"`) where the
#     literal `.env` token never appears in the command is NOT caught by the
#     command-token scope gate — the path is only known at runtime, off the
#     command string. This residual stays open and bounded.
#   - It is a DETECTOR (post-write), not a preventer: the secret already landed.
#
# Fail-safe: any jq/python/parse error, no command, unreadable file, or ERR trap
# → exit 0 silently. Never blocks, never crashes a tool.
#
# Trigger: PostToolUse, Bash tool only. Read hook input JSON from stdin.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# fail-open ERR trap — a tripwire internal error must not perturb the session.
trap 'exit 0' ERR

# --- Pattern sources (MIRRORED from validate-secret-scan.sh — that hook is the
# SoT) -----------------------------------------------------------------------
# Keep these in sync with validate-secret-scan.sh SECRETS_FILE (line ~141) and
# CRED_VALUE (line ~143). No shared lib exists to source today; this is a
# deliberate mirror, not a silent fork — update both on a pattern change.
#
# SECRETS_FILE — basename fragment for a .env-class secrets target:
#   .env / .env.<ext> / .envrc / secrets[.ext] / credentials[.ext]
# (validate-secret-scan also gates id_rsa/*.pem via its content PEM patterns;
# here the path gate adds id_rsa + *.pem|*.key as explicit secrets-file names so
# a key-file write is in scope for the content scan.)
readonly SECRETS_FILE='[^ ]*(\.env(\.[a-zA-Z0-9]+)?|\.envrc|secrets?(\.[a-zA-Z0-9]+)?|credentials?(\.[a-zA-Z0-9]+)?|id_rsa|[^ ]*\.pem|[^ ]*\.key)'

# WRITE_TARGET — the Stage-1 scope-gate discriminator. A bare .env-class PATH
# MENTION is NOT enough (that fired a false SEC-017 on every read-only `cat .env`
# / `source .env` / `grep KEY .env` / `--env-file .env` whenever a legit
# credential-bearing .env existed). The gate now requires a WRITE CHANNEL to the
# target, MIRRORING validate-secret-scan.sh SECRET_TARGET (the SoT) — scoped to
# THIS hook's SECRETS_FILE so the .pem/.key/id_rsa key-file names stay in scope:
#   (1) `>`/`>>` redirect into a secrets file
#   (2) heredoc redirected into a secrets file
#   (3) `tee`/`tee -a` arg              (4) `dd of=` target
#   (5) inline python/node `open('<secretsfile>','w'|'a')`
#   (6) `cp`/`mv` whose DESTINATION (terminal positional arg) is a secrets file
#   (7) `sed -i`/`--in-place` whose terminal positional arg is a secrets file
#   (8) `install` whose terminal positional arg is a secrets file
#   (9) `ed` whose terminal positional arg is a secrets file
# `tee`/`dd`/`cp`/`mv`/`sed`/`install`/`ed` are word-boundary-anchored (start |
# space | pipe | `;`/`&`) so `scp`/`mvcmd`/`embed`/`uninstall` substrings do not
# match; the cp/mv/sed-i/install/ed DESTINATION is terminal-token-anchored so a
# SOURCE that merely looks like a secrets file (`cp prestaged.env .env` — the
# `prestaged.env` source) does NOT trip the gate; only the true `.env`
# DESTINATION does. A read-only command matches none of these → exits before the
# content scan, so a legit on-disk credential is no longer cry-wolf flagged.
readonly WRITE_TARGET='(>>?[ ]*'"${SECRETS_FILE}"'|<<[-]?[ ]*[A-Za-z'"'"'"]*EOF[^ ]*[ ]*>>?[ ]*[^ ]*(\.env|\.envrc|secrets?|credentials?|id_rsa|\.pem|\.key)|(^|[ |;&])tee( +-a)?( +-[^ ]+)* +'"${SECRETS_FILE}"'|(^|[ |;&])dd( +[^ ]+)* +of='"${SECRETS_FILE}"'|open\([ ]*["'"'"'][^"'"'"']*(\.env(\.[a-zA-Z0-9]+)?|\.envrc|secrets?(\.[a-zA-Z0-9]+)?|credentials?(\.[a-zA-Z0-9]+)?|id_rsa|\.pem|\.key)["'"'"'][ ]*,[ ]*["'"'"'](w|a)["'"'"']|(^|[ |;&])(cp|mv)( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#]|$)|(^|[ |;&])sed( +[^ ;&|]+)*( +(-i[^ ]*|--in-place[^ ]*))( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])install( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])ed( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$))'

# CRED_VALUE — credential-VALUE patterns (structured tokens + generic
# assignment + PEM block + service-account JSON marker). Mirrors
# validate-secret-scan.sh CRED_VALUE, extended with the content-only patterns
# (JWT, DB/Mongo URI, PEM header, service_account marker) that the SoT applies in
# its Write|Edit content channel — appropriate here since we scan FILE CONTENT.
# Each entry pairs with a human-readable TYPE label (NAMES_EN) used in the alert;
# the credential VALUE itself is NEVER emitted.
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

# Stage 1 — scope gate (cheap, fail-fast): require a WRITE CHANNEL to a
# .env-class target (WRITE_TARGET), not a bare path mention. A read-only command
# that only NAMES a secrets file (`cat .env`, `source .env`, `grep KEY .env`,
# `--env-file .env`) has no write channel → exit immediately, no scan, no warn.
# This confines the post-write tripwire to actual writes (matching its name).
if [[ -z "${CMD}" ]]; then
  exit 0
fi
if ! printf '%s\n' "${CMD}" | grep -qiE -- "${WRITE_TARGET}"; then
  exit 0
fi

# Stage 2 — extract each .env-class path token from the command, then content-
# scan it IF it now exists + is readable. grep -oE yields each matching token
# on its own line; the `< <(...)` process substitution keeps the loop body in
# the current shell (a pipe would subshell-scope it). De-dup so a path that
# appears twice (e.g. `cp a.env b.env`) is scanned once per distinct path.
declare -a scanned=()
while IFS= read -r token; do
  [[ -z "${token}" ]] && continue
  # The token is a path candidate from the command. Skip if it is not a
  # regular, readable file on disk (e.g. `cat .env` of a non-existent path).
  [[ -f "${token}" && -r "${token}" ]] || continue
  # De-dup inline (no predicate function — avoids SC2310 set -e disabling): a
  # path appearing twice (e.g. `cp a.env b.env`) is scanned once per distinct
  # path. `dup` is reset per iteration; matched entries set it and skip.
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
