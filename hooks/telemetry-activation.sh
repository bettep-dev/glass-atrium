#!/usr/bin/env bash
# telemetry-activation.sh — Agent activation telemetry collector.
#
# POSTs the activated-agent distribution to the monitor's /api/telemetry/activation, the data
# source for measuring agent-instruction improvement effect.
#   - PreToolUse(Agent): source=orchestrator, agent_name=subagent_type, trigger_phrase=prompt[:500]
#   - SubagentStart:     source=subagent, agent_name=agent_type, cid=extracted from prompt
# fire-and-forget: monitor down/503 has zero impact (silent), curl --max-time 2, every error
# logs 1 stderr line then exit 0. Security: loopback-only URL, jq --arg escaping, no -K env leak.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — protect the hook's intrinsic behavior.
trap 'printf "[telemetry-activation] internal error at line %d: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Port derived via the hook_monitor_port wrapper (ADR-1: env → monitor/.env → config
# → 16145). Host stays FIXED at loopback — only the port is externalized. NO literal
# fallback here (the single default lives in the resolver); a resolver failure degrades
# to '' → the URL becomes non-bindable and the fire-and-forget POST silently no-ops.
# shellcheck source=lib/hook-utils.sh
source "${BASH_SOURCE%/*}/lib/hook-utils.sh"
monitor_port="$(hook_monitor_port || true)"
readonly MONITOR_URL="http://127.0.0.1:${monitor_port}/api/telemetry/activation"
readonly CURL_TIMEOUT=2
# Same as the monitor route's TRIGGER_PHRASE_MAX_LENGTH (double defense).
readonly TRIGGER_PHRASE_MAX=500

# stdin non-interactive → drain once, otherwise fail-open.
input=""
if [[ ! -t 0 ]]; then
  input="$(cat 2>/dev/null)" || input=""
fi

# Empty payload → nothing to POST.
[[ -z "${input}" ]] && exit 0

# Absent jq / curl is a system misconfiguration — fail-open.
if ! command -v jq >/dev/null 2>&1; then
  printf '[telemetry-activation] jq not found on PATH; skipping\n' >&2
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  printf '[telemetry-activation] curl not found on PATH; skipping\n' >&2
  exit 0
fi

# 1. Single jq fan-out — all fields in 1 fork (vs 6-7).
#    Separator: ASCII Unit Separator (0x1F) — non-whitespace IFS so bash 3.2 `read -r` preserves
#    empty fields, and disjoint from the base64 alphabet so the @base64-encoded prompt is safe.
ta_sep=$'\x1f'
ta_tsv=""
ta_tsv="$(printf '%s' "${input}" | jq -r --arg sep "${ta_sep}" '[
  (.hook_event_name // .hook_event // ""),
  (.tool_name // ""),
  (.tool_input.subagent_type // .agent_type // ""),
  (.agent_id // ""),
  ((.tool_input.prompt // "") | @base64)
] | join($sep)' 2>/dev/null)" || ta_tsv=""

hook_event=""
tool_name=""
subagent_type_raw=""
agent_id_value=""
prompt_b64=""
{
  IFS=$'\x1f' read -r hook_event tool_name subagent_type_raw agent_id_value prompt_b64
} <<<"${ta_tsv}"

[[ -z "${hook_event}" ]] && exit 0

# 2. Branch per event → source / agent_name / trigger_phrase / cid / metadata.
source_label=""
agent_name=""
trigger_phrase=""
cid_value=""
metadata_json="{}"

case "${hook_event}" in
  PreToolUse)
    # PreToolUse fires on every tool — only Agent (= Task tool) is a target.
    if [[ "${tool_name}" != "Agent" && "${tool_name}" != "Task" ]]; then
      exit 0
    fi
    source_label="orchestrator"
    agent_name="${subagent_type_raw}"
    prompt_full=""
    if [[ -n "${prompt_b64}" ]]; then
      prompt_full="$(printf '%s' "${prompt_b64}" | base64 --decode 2>/dev/null)" || prompt_full=""
    fi
    # cid — orchestrator-role.md Correlation ID format YYYY-MM-DDTHHMM_slug_xxxx (T-or-_ variant).
    if [[ -n "${prompt_full}" ]]; then
      cid_value="$(printf '%s' "${prompt_full}" | grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2}T?[0-9]{0,4}_[a-zA-Z0-9-]{1,20}_[a-zA-Z0-9]{4,8}' | head -1 || true)"
      trigger_phrase="${prompt_full:0:${TRIGGER_PHRASE_MAX}}"
    fi
    metadata_json='{"hook_event":"PreToolUse","tool_name":"'"${tool_name}"'"}'
    ;;
  SubagentStart | SubagentStop)
    # SubagentStop skipped — already POSTed at start (dedup).
    if [[ "${hook_event}" == "SubagentStop" ]]; then
      exit 0
    fi
    source_label="subagent"
    # agent_id is a hash, unsuitable as a name; agent_type is the real agent name.
    agent_name="${subagent_type_raw}"
    metadata_json="$(jq -n -c \
      --arg hook_event "${hook_event}" \
      --arg agent_id "${agent_id_value}" \
      '{hook_event: $hook_event, agent_id: $agent_id}' 2>/dev/null)" || metadata_json='{}'
    ;;
  *)
    # Unregistered event (Stop / SessionStart / PreCompact etc.) → not a target.
    exit 0
    ;;
esac

# 4. Empty agent_name → monitor route rejects with 400; guards missing subagent_type.
if [[ -z "${agent_name}" ]]; then
  exit 0
fi

# 5. Assemble JSON — jq --arg escapes the prompt's quotes/newlines; "" → null via the route.
payload=""
payload="$(jq -n -c \
  --arg source "${source_label}" \
  --arg agent_name "${agent_name}" \
  --arg trigger_phrase "${trigger_phrase}" \
  --arg cid "${cid_value}" \
  --argjson selected true \
  --argjson metadata "${metadata_json}" \
  '{
    source: $source,
    selected: $selected,
    agent_name: (if $agent_name == "" then null else $agent_name end),
    trigger_phrase: (if $trigger_phrase == "" then null else $trigger_phrase end),
    cid: (if $cid == "" then null else $cid end),
    metadata: $metadata
  }' 2>/dev/null)" || payload=""

if [[ -z "${payload}" ]]; then
  printf '[telemetry-activation] payload assembly failed (event=%s); skipping\n' "${hook_event}" >&2
  exit 0
fi

# 6. fire-and-forget POST. Body discarded; `|| true` keeps a curl failure from interfering.
http_code=""
http_code="$(curl -sS -o /dev/null \
  -w '%{http_code}' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "${payload}" \
  --max-time "${CURL_TIMEOUT}" \
  "${MONITOR_URL}" 2>/dev/null || true)"

# Diagnostic log — 1 stderr line, 201 success / otherwise failure.
case "${http_code}" in
  201)
    printf '[telemetry-activation] ok event=%s source=%s agent=%s\n' \
      "${hook_event}" "${source_label}" "${agent_name:-_}" >&2
    ;;
  "" | 000)
    # Monitor down / unreachable — intended silent-fail.
    printf '[telemetry-activation] monitor unreachable (event=%s); silently ignored\n' \
      "${hook_event}" >&2
    ;;
  *)
    # 4xx / 5xx — monitor responded but POST failed (DB down / validation).
    printf '[telemetry-activation] post failed http=%s event=%s source=%s agent=%s\n' \
      "${http_code}" "${hook_event}" "${source_label}" "${agent_name:-_}" >&2
    ;;
esac

exit 0
