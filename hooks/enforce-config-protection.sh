#!/usr/bin/env bash
# enforce-config-protection.sh — PreToolUse(Write|Edit) gate blocking config edits that WEAKEN
# lint/format/strictness (rule-disable, "off" value, eslint-disable, strictness true→false),
# stopping an agent from disabling a quality gate to pass verification.
#
# Protected basenames (scope-limited; anything else → allow):
#   .eslintrc* · .prettierrc* · ruff.toml · biome.json → rule-disable / "off" / eslint-disable added.
#   tsconfig.json → strictness key {strict, noImplicitAny, strictNullChecks, noUncheckedIndexedAccess}
#     flipped true→false. Non-strictness fields (paths/include/exclude) → allow (basename match would false-block).
#
# DEFAULT-ALLOW (exit 0): strengthen/neutral · ambiguous Edit fragment · tsconfig non-strictness
#   field · approval marker · any internal/parse error (fail-open).
# Block channel: stderr emit_error + exit 2, non-substitutable with the stdout decision channel
#   (shared-hook-capability-contract.md Block Channels).
# Approval marker CONFIG_PROTECTION_APPROVE=1 → one-time pass for intentional weakening,
#   per core-security.md high-impact-action explicit-approval posture.
# Fail-open: a parse bug must never wall off every config edit (system-wide blast radius) → internal error = exit 0 + warn.

set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# Diagnostic ERR trap — fail-open. Internal error must never wall off edits.
trap 'printf "[config-protection] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Approval bypass: user-approved weakening → one-time pass.
if [[ "${CONFIG_PROTECTION_APPROVE:-}" == "1" ]]; then
  exit 0
fi

INPUT="$(hook_read_input)"
TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"

# Pass any tool other than Write/Edit (belt-and-suspenders for matcher scope).
case "${TOOL_NAME:-}" in
  Write | Edit) : ;;
  *) exit 0 ;;
esac

FILE_PATH="$(hook_get_tool_input "${INPUT}" "file_path")"
if [[ -z "${FILE_PATH}" ]]; then
  exit 0
fi

basename_only="${FILE_PATH##*/}"

# Scope limit: classify the protected config type by basename.
# config_kind ∈ { linter, tsconfig, "" }. "" → not a protected config → allow.
config_kind=""
case "${basename_only}" in
  .eslintrc | .eslintrc.* | .prettierrc | .prettierrc.* | ruff.toml | biome.json)
    config_kind="linter"
    ;;
  tsconfig.json)
    config_kind="tsconfig"
    ;;
  *) : ;; # not a protected config basename → config_kind stays empty
esac

if [[ -z "${config_kind}" ]]; then
  exit 0
fi

# Gather the edit content to inspect. Write → full file content; Edit → new_string
# fragment only (ambiguous — absence of a weakening directive → DEFAULT-ALLOW).
NEW_CONTENT=""
if [[ "${TOOL_NAME}" == "Write" ]]; then
  NEW_CONTENT="$(hook_get_tool_input "${INPUT}" "content")"
else
  NEW_CONTENT="$(hook_get_tool_input "${INPUT}" "new_string")"
fi

# Empty content (cannot inspect) → DEFAULT-ALLOW.
if [[ -z "${NEW_CONTENT}" ]]; then
  exit 0
fi

# Weakening detection (delegated to python3 for robust JSON-key parsing). Emits one
# token on stdout: weaken:<reason> → caller blocks (exit 2) · allow → DEFAULT-ALLOW.
DETECT_PY=$(
  cat <<'PY'
import json
import os
import re
import sys


def emit(token):
    sys.stdout.write(token + "\n")


def detect_linter(text):
    """Linter/formatter weakening signals (.eslintrc/.prettierrc/ruff/biome)."""
    # 1. An added eslint-disable directive (file or line scope).
    if re.search(r"eslint-disable\b", text):
        return "eslint-disable-added"
    # 2. A rule explicitly set to "off" (eslint) — quoted or unquoted key.
    #    e.g.  "no-explicit-any": "off"   |   'no-unused-vars': 0
    if re.search(r"[\"']?[\w./@-]+[\"']?\s*:\s*[\"']off[\"']", text):
        return "rule-set-off"
    if re.search(r"[\"']?[\w./@-]+[\"']?\s*:\s*\[\s*[\"']off[\"']", text):
        return "rule-set-off-array"
    # 3. A rule level numerically disabled (eslint legacy 0 = off).
    if re.search(r"[\"'][\w./@-]+[\"']\s*:\s*0\b", text):
        return "rule-level-zero"
    return ""


_STRICTNESS_KEYS = (
    "strict",
    "noImplicitAny",
    "strictNullChecks",
    "noUncheckedIndexedAccess",
)


def detect_tsconfig(text):
    """tsconfig.json strictness flip-to-loose (key:true → false).

    Limited to the explicit strictness key set. Non-strictness fields
    (paths/include/exclude) are intentionally NOT inspected → DEFAULT-ALLOW.
    """
    for key in _STRICTNESS_KEYS:
        # Match `"<key>": false` (whitespace-tolerant). Presence of the key set
        # to false in the new content is the weakening signal.
        if re.search(r"[\"']" + re.escape(key) + r"[\"']\s*:\s*false\b", text):
            return f"{key}=false"
    return ""


def main():
    text = sys.stdin.read()
    kind = sys.argv[1] if len(sys.argv) > 1 else ""

    if kind == "linter":
        reason = detect_linter(text)
    elif kind == "tsconfig":
        reason = detect_tsconfig(text)
    else:
        reason = ""

    if reason:
        emit("weaken:" + reason)
    else:
        emit("allow")


try:
    main()
except Exception:  # noqa: BLE001 — fail-open, never block on parse bug
    sys.stdout.write("allow\n")
PY
)

# python3 absent → cannot inspect → DEFAULT-ALLOW (fail-open).
if ! command -v python3 >/dev/null 2>&1; then
  printf '[config-protection] python3 not found — DEFAULT-ALLOW (exit 0)\n' >&2
  exit 0
fi

DETECT_OUT=""
DETECT_OUT="$(printf '%s' "${NEW_CONTENT}" | python3 -c "${DETECT_PY}" "${config_kind}" 2>/dev/null)" || DETECT_OUT="allow"

case "${DETECT_OUT}" in
  weaken:*)
    reason="${DETECT_OUT#weaken:}"
    emit_error "CFG-001" "block" \
      "Config-weakening edit blocked on protected file" \
      "Strengthen the rule, or set CONFIG_PROTECTION_APPROVE=1 for an approved weakening" \
      "{\"file_path\":\"${FILE_PATH}\",\"kind\":\"${config_kind}\",\"reason\":\"${reason}\"}"
    exit 2
    ;;
  *)
    # allow / empty / unknown → DEFAULT-ALLOW.
    exit 0
    ;;
esac
