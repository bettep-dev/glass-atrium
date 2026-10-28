#!/usr/bin/env bash
# SessionStart — inject orchestrator behavior rules; stdout is the injected session context
# emit_error EXEMPT: context injection only, no error path — a failed progress-tracker source skips its block
#
# [INJECTION CANARY] ORCHESTRATOR_INIT emits one visible, printable, single-code-point BMP glyph
#   · never zero-width / bidi / variation-selector / combining / private-use (Trojan-Source vectors)
#   · injection-PRESENCE signal only — never a trust / auth / provenance token
set -Eeuo pipefail
IFS=$'\n\t'

# No $(cat): with fd 0 closed, the capture pipe takes fd 0 and cat deadlocks on it; read just fails.
_envelope=""
if [[ ! -t 0 ]]; then
  IFS= read -r -d '' _envelope 2>/dev/null || true # EOF before a NUL is the normal end of the envelope
fi

# Orchestrator core — scoped/ read in place from the store, like scripts/ below (hooks/ and scoped/ are sibling store dirs)
#   · SoT of the orchestrator banner: its figures and token grammars are re-verified there, not here
#   · main session only: a subagent receives no SessionStart output (host-channel delivery SoT: core-compliance-matrix.md -> "### Membership vs. Delivery")
readonly CORE_FILE="${HOME}/.glass-atrium/scoped/orchestrator-core.md"
_core=""
if [[ -r "${CORE_FILE}" ]]; then
  _core="$(<"${CORE_FILE}")" || _core=""
fi
[[ -n "${_core}" ]] || _core="[ORCHESTRATOR CORE] missing — ${CORE_FILE} is absent or empty, so this session starts without the orchestrator core"

# [RESTATED SoT FIGURES] reply language — GLASS_ATRIUM_GLOBAL_RULES.md -> "## Absolute Rules [ALL]" -> "### Output Language"
#   · the response-language rule and its children are restated by the three "Reply language" heredoc lines → re-verify on every edit
_banner=""
IFS= read -r -d '' _banner <<'ORCHESTRATOR_INIT' || true # EOF before a NUL is the normal end of a heredoc
Reply language: write the final message of each turn, clarifying questions and the end-of-job results summary to the user in the language of the user's own prose in their latest message; mid-turn progress notes between tool calls may be in English.
Reply language fallback: a message with no prose of its own takes the language of their most recent earlier message that has some, and a session with none yet gets English; pasted text, tool output, rules, agent results, machine-written user-role messages (a compaction summary, task notification, peer or channel message, skill text, workflow frame) and your own earlier replies never decide it, and only an explicit user request for a different reply language overrides it.
Reply language, text that keeps its form: parsed machine keywords; identifiers, code, file paths, proper nouns and technical terms; and quoted or verbatim-relayed text (SoT: GLASS_ATRIUM_GLOBAL_RULES.md → Absolute Rules → Output Language, response-language rule).
[INJECTION CANARY] ◈ — start the first line of your first tool-free reply with this glyph; it precedes the BLUF and is not part of it.
ORCHESTRATOR_INIT

# Resume, compact and fork: one line quoting the user's latest own message; that hook owns its wording and gate.
_REPLY_POINTER="$(dirname -- "${BASH_SOURCE[0]}")/inject-reply-language.sh"
_pointer=""
if [[ -n "${_envelope}" && -r "${_REPLY_POINTER}" ]]; then
  _pointer="$(bash "${_REPLY_POINTER}" <<<"${_envelope}")" || true
fi

# Open-plan list — every plan past doc_review and not yet done, from ONE monitor GET
#   · stages restate monitor/src/server/routes/clauded-docs.ts -> DOC_STAGES
#   · any failure prints the unavailable line, never an empty list → absence never reads as "nothing open"
#   · an echoed filter missing a stage = a page the monitor did not filter → treated as unreadable
#   · curl --max-time 0.5 keeps the leg inside the ~1 s hook budget when the monitor hangs
#   · one compact row per plan (id · stage · title prefix), at most OPEN_PLANS_MAX_ROWS of them, newest sync first
#     → the rest collapse into one "+N more → GET" line, so the list never grows into the core's headroom
# ponytail: rows past the route's 200-row cap go unshown — upgrade: page on .total once open plans near 200
readonly OPEN_PLANS_QUERY='doc_status=implementing,impl_review,impl_done&limit=200'
readonly OPEN_PLANS_MAX_ROWS=8
# shellcheck disable=SC2016  # $open, $fallback, $n, $max, $query and $plans are jq variables, not shell expansions
readonly OPEN_PLANS_JQ='
  def clean($fallback): if type == "string" and length > 0 then gsub("[[:cntrl:]]"; " ") else $fallback end;
  def prefix($n): if length > $n then .[0:$n] + "…" else . end;
  ["implementing", "impl_review", "impl_done"] as $open
  | if (.rows | type) != "array" or ($open - (.filter.doc_status // [])) != [] then error("unfiltered list") else . end
  | [.rows[] | select(.doc_status | IN($open[]))]
  | sort_by([(.last_synced_at // .created_at // ""), .id]) | reverse as $plans
  | if ($plans | length) == 0 then "[OPEN PLANS] none — no plan at implementing, impl_review or impl_done"
    else "[OPEN PLANS] \($plans | length) plan(s) past doc_review, not yet done — each closes by flow step 5 (Reconcile & Close):",
      ($plans[0:$max][] | "- clauded-docs/\(.id) · \(.doc_status) · \(.title | clean("(untitled)") | prefix(32))"),
      (if ($plans | length) > $max then "- +\(($plans | length) - $max) more → GET /api/clauded-docs?\($query)" else empty end)
    end'

# Collection URL of the monitor clauded-docs API, rc 1 when unresolvable; a full override wins so a suite never reaches the live monitor.
get_monitor_docs_url() {
  if [[ -n "${SESSION_CONTEXT_MONITOR_URL:-}" ]]; then
    printf '%s' "${SESSION_CONTEXT_MONITOR_URL}"
    return 0
  fi
  local lib port
  lib="$(dirname -- "${BASH_SOURCE[0]}")/lib/hook-utils.sh"
  [[ -r "${lib}" ]] || return 1
  # shellcheck source-path=SCRIPTDIR source=lib/hook-utils.sh
  source "${lib}" || return 1
  # shellcheck disable=SC2310  # a resolver miss degrades to an empty port, which the integer test rejects
  port="$(hook_monitor_port 2>/dev/null || true)"
  [[ "${port}" =~ ^[0-9]+$ ]] || return 1
  printf 'http://127.0.0.1:%s/api/clauded-docs' "${port}"
}

# The open-plan block (header + one row per plan), rc 1 on any failure.
get_open_plans() {
  local url body
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1
  # shellcheck disable=SC2310  # an unresolvable URL is the leg's fail-open answer
  url="$(get_monitor_docs_url)" || return 1
  body="$(curl -sf --max-time 0.5 "${url}?${OPEN_PLANS_QUERY}")" || return 1
  jq -r --argjson max "${OPEN_PLANS_MAX_ROWS}" --arg query "${OPEN_PLANS_QUERY}" "${OPEN_PLANS_JQ}" <<<"${body}"
}

# Command substitution isolates the leg → a failure inside it cannot drop the rest of this injection.
# shellcheck disable=SC2310  # any failure is answered by the unavailable line below
_open_plans="$(get_open_plans 2>/dev/null)" || _open_plans=""
[[ -n "${_open_plans}" ]] || _open_plans="[OPEN PLANS] unavailable — the monitor list could not be read, so this is NOT \"nothing open\" (GET /api/clauded-docs?${OPEN_PLANS_QUERY})"

# Cross-Session Continuity — up to 5 newest in_progress files → new session resumes them (GLOBAL_RULES)
# silent when none exist — no header line at all
# scripts/ is read in place from the store (hooks/ and scripts/ are sibling store dirs)
# Captured before the loop, never read through <( ): an un-waited child's SIGCHLD can fail the final printf with EINTR.
_PROGRESS_TRACKER="${HOME}/.glass-atrium/scripts/progress-tracker.sh"
_continuity=""
if [[ -r "${_PROGRESS_TRACKER}" ]]; then
  # shellcheck source=/dev/null
  source "${_PROGRESS_TRACKER}"
  _open_list="$(progress_list_open)" || _open_list=""
  _open_count=0
  while IFS= read -r _line; do
    [[ -n "${_line}" ]] || continue
    _continuity="${_continuity:+${_continuity}, }${_line}"
    _open_count=$((_open_count + 1))
    [[ ${_open_count} -ge 5 ]] && break
  done <<<"${_open_list}"
  # Comma-separated single line — easy for downstream prompt parsers.
  [[ -z "${_continuity}" ]] || _continuity="[CONTINUITY] open progress files: ${_continuity}"
fi

# Hook-context cap: 10,000 UTF-16 units (measured record: hooks/inject-scope-rules.sh -> INJECT_CTX_MAX_BYTES)
#   · over it the host delivers a ~2 KB preview → the core outranks the open-plan list, which yields to one overflow line
readonly CONTEXT_CAP_UNITS=10000

# UTF-16 code units of $1; the byte count when iconv cannot convert, which never undercounts.
get_utf16_units() {
  local bytes
  if bytes="$(printf '%s' "${1}" | iconv -f UTF-8 -t UTF-16LE 2>/dev/null | wc -c)"; then
    printf '%s' "$((${bytes//[[:space:]]/} / 2))"
    return 0
  fi
  bytes="$(printf '%s' "${1}" | wc -c)"
  printf '%s' "${bytes//[[:space:]]/}"
}

readonly WIKI_LINE='[WIKI] wiki search available: ~/.glass-atrium/scripts/wiki-query.sh "keywords"'
_context="${_core}"$'\n'"${_banner%$'\n'}${_pointer:+$'\n'${_pointer}}"$'\n'"${WIKI_LINE}"
_units="$(get_utf16_units "${_context}"$'\n'"${_open_plans}${_continuity:+$'\n'${_continuity}}")"
if ((_units > CONTEXT_CAP_UNITS)); then
  _open_plans="[OPEN PLANS] omitted — the session context would be ${_units} UTF-16 units, $((_units - CONTEXT_CAP_UNITS)) over the ${CONTEXT_CAP_UNITS}-unit hook cap; read the list with GET /api/clauded-docs?${OPEN_PLANS_QUERY}"
fi
printf '%s\n' "${_context}" "${_open_plans}"
[[ -z "${_continuity}" ]] || printf '%s\n' "${_continuity}"
