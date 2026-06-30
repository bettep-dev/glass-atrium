#!/usr/bin/env bash
# PreToolUse(Write|Edit|Bash) — block on secret-pattern detection.
#   Write|Edit channel: scan tool_input.content + tool_input.new_string.
#   Bash channel: scan tool_input.command for a HIGH-SIGNAL credential value
#     redirected/heredoc'd into a dotenv/secrets file (a secret can otherwise be
#     written via `echo KEY=... > .env`, fully bypassing the Write|Edit channel).
# One coherent secret-scan surface — branches on tool_name. Both invocations
# block with exit 2 on match. Bind this hook to BOTH Write|Edit and Bash.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# WHY fail-closed: field extraction degrades to EMPTY without python3 (tool_name
# mis-detects, content scans nothing), which would let a credential write through
# unscanned. A secret gate MUST refuse rather than silently allow — block here so
# no unscanned write can proceed on a python3-less PATH.
hook_require_python3 "SEC-017" \
  "Secret scan unavailable: python3 is required to parse hook input / 시크릿 스캔 불가: hook 입력 파싱에 python3 필요"

INPUT=$(hook_read_input)
TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")

# --- Structured + format secret patterns (Write|Edit content channel) --------
# High-signal patterns: structured-token shapes + generic credential
# assignments (non-trivial value only, to avoid FP on empty/placeholder) +
# PEM private-key headers + cloud service-account JSON markers.
# NOTE: a literal-dash-leading pattern (PEM "-----BEGIN") MUST be matched with
# `grep -E --` so BSD grep does not parse it as an option flag.
PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[a-zA-Z0-9]{36}'
  'sk-[a-zA-Z0-9]{20,}'
  'eyJ[a-zA-Z0-9_-]*\.eyJ'
  'postgres://[^ ]*@'
  'mongodb(\+srv)?://[^ ]*@'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[bpoa]-[0-9a-zA-Z-]+'
  '(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '"private_key"[ ]*:[ ]*"-----BEGIN'
  '"type"[ ]*:[ ]*"service_account"'
)
CODES=(SEC-001 SEC-002 SEC-003 SEC-004 SEC-005 SEC-006 SEC-007 SEC-008 SEC-013 SEC-014 SEC-015 SEC-015)
NAMES_EN=(
  "AWS Access Key"
  "GitHub Token"
  "API Key (sk-)"
  "JWT Token"
  "DB connection string"
  "MongoDB connection string"
  "Google API Key"
  "Slack Token"
  "Generic credential assignment"
  "PEM private key"
  "Service-account private key"
  "Service-account JSON marker"
)
NAMES_KO=(
  "AWS 액세스 키"
  "GitHub 토큰"
  "API 키 (sk-)"
  "JWT 토큰"
  "DB 연결 문자열"
  "MongoDB 연결 문자열"
  "Google API 키"
  "Slack 토큰"
  "일반 자격증명 할당"
  "PEM 개인 키"
  "서비스 계정 개인 키"
  "서비스 계정 JSON 마커"
)

# Scan a blob against every PATTERNS entry; exit 2 on the first match.
# Args: $1=blob to scan
scan_content() {
  local blob="${1}" i
  [[ -z "${blob}" ]] && return 0
  for i in "${!PATTERNS[@]}"; do
    # `-i` for case-insensitive credential keys · `--` so a dash-leading PEM
    # pattern is not parsed as a grep option flag.
    if printf '%s\n' "${blob}" | grep -qiE -- "${PATTERNS[${i}]}"; then
      # emit_error is a 5-param signature (code, severity, message, suggestion,
      # ctx) — bilingual EN/KO text is combined into the single message/
      # suggestion args so the emitted JSON stays well-formed.
      emit_error "${CODES[${i}]}" "block" \
        "Secret pattern detected: ${NAMES_EN[${i}]} / 시크릿 패턴 감지: ${NAMES_KO[${i}]}" \
        "Replace hardcoded secret with environment variable / 하드코딩된 시크릿을 환경변수로 교체하세요" \
        "{\"pattern\":\"${CODES[${i}]}\"}"
      exit 2
    fi
  done
}

# --- Bash channel (HIGH SIGNAL ONLY) -----------------------------------------
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
  if printf '%s\n' "${cmd}" | grep -qiE -- "${SECRET_TARGET}" \
    && printf '%s\n' "${cmd}" | grep -qiE -- "${CRED_VALUE}"; then
    # emit_error 5-param signature (code, severity, message, suggestion, ctx) —
    # bilingual EN/KO text combined into single message/suggestion args.
    emit_error "SEC-016" "block" \
      "Secret written to a dotenv/secrets file via Bash / Bash 로 시크릿이 dotenv/secrets 파일에 기록됨" \
      "Do not write credentials into .env/secrets files (redirect/heredoc/tee/dd/open/cp/mv/sed-i/install/ed); use env vars or a secret manager / 자격증명을 .env/secrets 파일에 기록하지 마세요; 환경변수나 시크릿 매니저를 사용하세요" \
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
CONTENT=$(printf '%s\n' "${INPUT}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ti=d.get('tool_input',{}); print(ti.get('content','') + ti.get('new_string',''))
" 2>/dev/null) || CONTENT=""

scan_content "${CONTENT}"
exit 0
