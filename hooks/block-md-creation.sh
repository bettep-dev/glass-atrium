#!/usr/bin/env bash
# PreToolUse hook: block monitor SoT-bypass patterns · exit 2 = block the tool call
#
# BLOCK: monitor-internal documents root .{md,yaml,yml,json,txt} — POST API only
# ALLOW: all other .{md,yaml,yml,json,txt} — README · ADR · wiki · harness · memory
#
# Format is request-driven (agent-only default / explicit-HTML-request) → a basename
#   prefix is not an HTML-primary signal. Only the path-based monitor-internal
#   POST-API gate applies.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# POST-API hint port from the config-rendered env key (config.toml [ports].monitor
# → ATRIUM_MONITOR_PORT) — keeps the guidance accurate on a non-default port;
# non-numeric → default.
monitor_port="${ATRIUM_MONITOR_PORT:-7842}"
[[ "${monitor_port}" =~ ^[0-9]+$ ]] || monitor_port=7842

INPUT="$(hook_read_input)"
TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"

# Step 1: pass any tool other than Write
if [[ "${TOOL_NAME:-}" != "Write" ]]; then
  exit 0
fi

FILE_PATH="$(hook_get_tool_input "${INPUT}" "file_path")"

# Step 2: pass anything other than a block-eligible extension
case "${FILE_PATH:-}" in
  *.md | *.yaml | *.yml | *.json | *.txt) : ;;
  *) exit 0 ;;
esac

# Step 3 BLOCK: monitor-internal path — block POST API bypass
# Live path = .glass-atrium/monitor · legacy .claude/monitor kept in the OR (portability).
if [[ "${FILE_PATH}" == *"/.glass-atrium/monitor/data/documents/"* || "${FILE_PATH}" == *"/.claude/monitor/data/documents/"* ]]; then
  hook_log "blocked: ${FILE_PATH} reason=monitor-internal"
  emit_error "DEL-002" "block" \
    "Markdown write to monitor-internal documents root blocked" \
    "Use POST /api/clauded-docs (127.0.0.1:${monitor_port}) instead of direct write" \
    "{\"file_path\":\"${FILE_PATH}\",\"reason\":\"monitor-internal\"}"
  exit 2
fi

# Step 4: pass everything else (see header ALLOW)
exit 0
