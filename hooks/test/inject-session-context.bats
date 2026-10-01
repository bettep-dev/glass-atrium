#!/usr/bin/env bats
# inject-session-context.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# SessionStart hook — NO blocking semantics (the block/pass envelope ACs do not
# apply): stdout IS the additionalContext injected into the session. The smoke
# asserts EMISSION — the [ORCHESTRATOR SESSION] + [WIKI] context blocks on a
# session-start envelope, the [CONTINUITY] header contract (present with open
# progress files, absent without), and the injection-presence canary glyph
# (emitted exactly once, unconditionally).
#
# Run via: bats hooks/test/inject-session-context.bats
# Requires: bats (brew install bats-core), bash 3.2+.
#
# Hermetic strategy: HOME is pointed at a mktemp sandbox, so the progress-
# tracker source path (${HOME}/.glass-atrium/scripts/progress-tracker.sh)
# resolves inside the sandbox — absent by default (silent-fallback branch), or
# a stub defining progress_list_open when a test seeds one. The live user HOME
# is never read.

HOOK_SH="${BATS_TEST_DIRNAME}/../inject-session-context.sh"
CORPUS="${BATS_TEST_DIRNAME}/corpus/reply-language"
# Names a resolver-derived language value would carry into the pointer line's fixed part.
LANGUAGE_NAMES='english|korean|japanese|chinese|hangul|latin|kana|한국어|영어|일본어|중국어'
# Fixed phrase the pointer line carries after the quote.
REPLY_TARGET='the final message of each turn, your report to the user'
# Closed loopback port → the open-plan GET is refused, so no run reaches the live monitor.
DEAD_MONITOR_URL='http://127.0.0.1:9/api/clauded-docs'
OPEN_STAGES_FILTER='"filter":{"doc_status":["implementing","impl_review","impl_done"],"limit":200,"offset":0}'
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  SANDBOX="$(mktemp -d -t ga-sessctx-bats.XXXXXX)"
  FAKE_HOME="${SANDBOX}/home"
  mkdir -p "${FAKE_HOME}"
  export SESSION_CONTEXT_MONITOR_URL="${DEAD_MONITOR_URL}"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# The canary glyph is DEFINED only by the hook — derive it from the emitted
# marker line so this file carries no second definition of it.
canary_glyph() {
  printf '%s\n' "${output}" | awk '/^\[INJECTION CANARY\] /{print $3; exit}'
}

# Occurrences (not lines) of the derived canary glyph in ${output}.
glyph_count() {
  local g
  g="$(canary_glyph)"
  if [[ -z "${g}" ]]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "${output}" | grep -Fo -- "${g}" | wc -l | tr -d ' '
}

# Seed a progress-tracker stub whose progress_list_open prints the given lines.
# Args: $@=open progress file paths (zero or more).
seed_tracker() {
  local dir="${FAKE_HOME}/.glass-atrium/scripts"
  mkdir -p "${dir}"
  {
    printf 'progress_list_open() {\n'
    local p
    for p in "$@"; do
      printf '  printf "%%s\\n" "%s"\n' "${p}"
    done
    printf '  return 0\n}\n'
  } >"${dir}/progress-tracker.sh"
}

# Serves the open-plan list from a file:// fixture — curl ignores the query string on file://.
# Args: $1=list response body.
seed_open_plans() {
  printf '%s\n' "${1}" >"${SANDBOX}/open-plans.json"
  SESSION_CONTEXT_MONITOR_URL="file://${SANDBOX}/open-plans.json"
}

# Step number of the one turn-0 flow line containing $1, empty without one.
get_step_number() {
  printf '%s\n' "${output}" | awk -v needle="${1}" '/^[0-9]+\. / && index($0, needle) { print $1 + 0; exit }'
}

# Run the hook with a session-start envelope on stdin under the sandbox HOME.
run_hook() {
  run env HOME="${FAKE_HOME}" bash "${HOOK_SH}" <<<'{"hook_event_name":"SessionStart","session_id":"sess-smoke"}'
}

# Runs the hook on a SessionStart envelope naming a corpus transcript.
# Args: $1=source $2=corpus transcript $3=entrypoint
run_session_source() {
  local envelope
  envelope="$(jq -cn --arg source "${1}" --arg transcript "${CORPUS}/${2}.jsonl" \
    '{hook_event_name: "SessionStart", session_id: "sess-smoke", source: $source, transcript_path: $transcript}')"
  run env HOME="${FAKE_HOME}" CLAUDE_CODE_ENTRYPOINT="${3}" bash "${HOOK_SH}" <<<"${envelope}"
}

# Prints the quote of the one [REPLY LANGUAGE] line in ${output}, `none` without one, or `malformed: <lines>`
# for several lines, one whose fixed part (everything outside the quote) names a language, or one with no REPLY_TARGET after the quote.
get_pointer_quote() {
  local lines quote
  lines="$(printf '%s\n' "${output}" | awk '/^\[REPLY LANGUAGE\] /')"
  if [[ -z "${lines}" ]]; then
    printf 'none'
    return 0
  fi
  if [[ "${lines}" == *$'\n'* ]]; then
    printf 'malformed: %s' "${lines}"
    return 0
  fi
  quote="$(jq -eRr --arg names "${LANGUAGE_NAMES}" --arg target "${REPLY_TARGET}" '
    capture("^(?<head>[^\"]*)(?<quote>\"(?:[^\"\\\\]|\\\\.)*\")(?<tail>[^\"]*)$")
    | select((.head + .tail) | test($names; "i") | not)
    | select(.tail | contains($target))
    | .quote | fromjson' <<<"${lines}" 2>/dev/null)" || quote="malformed: ${lines}"
  printf '%s' "${quote}"
}

@test "resume, compact and fork add one line quoting the user's latest own message; startup and clear add none" {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local rows=(
    'resume|newest-human-korean|좋아, 이제 리뷰 반영해줘'
    'compact|compact-summary|이 계획대로 진행해줘'
    'fork|newest-human-english|Now apply the review comments please'
    'startup|newest-human-korean|none'
    'clear|newest-human-korean|none'
    'compact|sdk-cli|none'
  )
  local row source transcript want got
  for row in "${rows[@]}"; do
    IFS='|' read -r source transcript want <<<"${row}"
    run_session_source "${source}" "${transcript}" cli
    got="$(get_pointer_quote)"
    [[ "${status}" -eq 0 && "${output}" == *"[ORCHESTRATOR SESSION]"* && "${got}" == "${want}" ]] || {
      echo "${source}/${transcript}: exit ${status}, want ${want}, got ${got}"
      return 1
    }
  done
}

@test "a headless session start adds no pointer line" {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local entrypoint got
  for entrypoint in cli sdk-cli; do
    run_session_source resume newest-human-korean "${entrypoint}"
    got="$(get_pointer_quote)"
    [[ "${status}" -eq 0 && "${output}" == *"[ORCHESTRATOR SESSION]"* ]] || return 1
    if [[ "${entrypoint}" == cli ]]; then
      [[ "${got}" == '좋아, 이제 리뷰 반영해줘' ]] || {
        echo "control: got ${got}"
        return 1
      }
    else
      [[ "${got}" == none ]] || {
        echo "${entrypoint}: got ${got}"
        return 1
      }
    fi
  done
}

@test "an empty or closed stdin still yields the session context, with no pointer line" {
  local got
  run env HOME="${FAKE_HOME}" CLAUDE_CODE_ENTRYPOINT=cli bash "${HOOK_SH}" </dev/null
  got="$(get_pointer_quote)"
  [[ "${status}" -eq 0 && "${output}" == *"[ORCHESTRATOR SESSION]"* && "${got}" == none ]] || {
    echo "empty stdin: exit ${status}: ${output}"
    return 1
  }
  # Closed inside the child: a `run ... <&-` lets bats reuse fd 0 for its own capture pipe.
  # shellcheck disable=SC2016  # $1 expands in the child shell, not here
  run env HOME="${FAKE_HOME}" CLAUDE_CODE_ENTRYPOINT=cli bash -c 'exec 0<&-; exec bash "$1"' _ "${HOOK_SH}"
  got="$(get_pointer_quote)"
  [[ "${status}" -eq 0 && "${output}" == *"[ORCHESTRATOR SESSION]"* && "${got}" == none ]] || {
    echo "closed stdin: exit ${status}: ${output}"
    return 1
  }
}

@test "emission: session-start envelope → orchestrator + wiki context on stdout, exit 0" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"[ORCHESTRATOR SESSION]"* ]] || return 1
  [[ "${output}" == *"[WIKI] wiki search available"* ]] || return 1
}

@test "no progress tracker → no [CONTINUITY] header, exit 0" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"[CONTINUITY]"* ]] || return 1
}

@test "open progress files → [CONTINUITY] header lists them comma-joined" {
  seed_tracker "memory/progress-alpha.md" "memory/progress-beta.md"
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"[CONTINUITY] open progress files: memory/progress-alpha.md, memory/progress-beta.md"* ]] || return 1
}

@test "tracker with zero open files → no [CONTINUITY] header" {
  seed_tracker
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"[CONTINUITY]"* ]] || return 1
}

@test "the turn-0 flow writes implementing before delegating and reconciles and closes before reporting" {
  run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  local implementing delegate reconcile report
  # shellcheck disable=SC2016  # literal backticks of the step name
  implementing="$(get_step_number '`implementing` write')"
  delegate="$(get_step_number 'Delegate via the Agent tool')"
  reconcile="$(get_step_number 'Reconcile & Close')"
  report="$(get_step_number 'Synthesize results')"
  [[ -n "${implementing}" && -n "${delegate}" && -n "${reconcile}" && -n "${report}" ]] \
    && ((implementing < delegate && delegate < reconcile && reconcile < report)) || {
    echo "steps: implementing=${implementing} delegate=${delegate} reconcile=${reconcile} report=${report}"
    return 1
  }
}

@test "the workflow pre-flight carries both close-token forms of the grammar SoT" {
  local rules="${BATS_TEST_DIRNAME}/../../rules/glass-atrium/orchestrator-role.md"
  [[ -f "${rules}" ]] || skip "grammar SoT absent: ${rules}"
  run_hook
  local preflight form count
  preflight="$(printf '%s\n' "${output}" | grep -F '[WORKFLOW PRE-FLIGHT]')"
  for form in '[PLAN-CLOSE] in-script' '[PLAN-CLOSE] deferred:'; do
    # exactly once — a second copy would keep a presence match green after the grammar line is reworded
    count="$(awk -v needle="${form}" '{ s = $0; while ((i = index(s, needle)) > 0) { n++; s = substr(s, i + length(needle)) } } END { print n + 0 }' "${rules}")"
    [[ "${preflight}" == *"${form}"* && "${count}" -eq 1 ]] || {
      echo "close-token form missing from the pre-flight line, or not exactly once in the grammar SoT (count ${count}): ${form}"
      return 1
    }
  done
}

@test "open plans are listed one per row with id, stage, status actor and a single-line title" {
  seed_open_plans '{"total":4,"rows":[
    {"id":40619,"title":"Plan — reconcile and close","doc_status":"implementing","last_status_model":"claude-opus-5-5"},
    {"id":40299,"title":"Plan — reply-language pointer","doc_status":"impl_review","last_status_model":null},
    {"id":39913,"title":"Plan — effort\ntiers","doc_status":"impl_done","last_status_model":"claude-opus-5-5"},
    {"id":39700,"title":"Tracker — standing decisions","doc_status":"doc_review","last_status_model":null}],
    '"${OPEN_STAGES_FILTER}"'}'
  run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  local rows=(
    'implementing with an actor|- clauded-docs/40619 · implementing · claude-opus-5-5 · Plan — reconcile and close'
    'null actor reads unknown|- clauded-docs/40299 · impl_review · unknown · Plan — reply-language pointer'
    'embedded newline flattened|- clauded-docs/39913 · impl_done · claude-opus-5-5 · Plan — effort tiers'
  )
  local row name line
  for row in "${rows[@]}"; do
    IFS='|' read -r name line <<<"${row}"
    printf '%s\n' "${output}" | grep -qxF -- "${line}" || {
      echo "${name}: no line '${line}' in: ${output}"
      return 1
    }
  done
  printf '%s\n' "${output}" | grep -q '^\[OPEN PLANS\] 3 ' && [[ "${output}" != *"clauded-docs/39700"* ]] || {
    echo "header count or doc_review exclusion wrong: ${output}"
    return 1
  }
}

@test "a readable list with no open plan prints the none line, never the unavailable line" {
  seed_open_plans '{"total":0,"rows":[],'"${OPEN_STAGES_FILTER}"'}'
  run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  printf '%s\n' "${output}" | grep -q '^\[OPEN PLANS\] none' && [[ "${output}" != *"[OPEN PLANS] unavailable"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "an unreadable open-plan list yields the unavailable line and the rest of the session context" {
  seed_tracker "memory/progress-alpha.md"
  local rows=(
    "refused port|url|${DEAD_MONITOR_URL}"
    "missing fixture|url|file://${SANDBOX}/absent.json"
    'malformed body|body|not json'
    'no rows array|body|{"total":0,'"${OPEN_STAGES_FILTER}"'}'
    'stage filter not applied|body|{"total":1,"rows":[{"id":1,"title":"t","doc_status":"implementing","last_status_model":null}],"filter":{"doc_status":null}}'
  )
  local row name kind value
  for row in "${rows[@]}"; do
    IFS='|' read -r name kind value <<<"${row}"
    if [[ "${kind}" == body ]]; then
      seed_open_plans "${value}"
    else
      SESSION_CONTEXT_MONITOR_URL="${value}"
    fi
    run_hook
    [[ "${status}" -eq 0 && "${output}" == *"[ORCHESTRATOR SESSION]"* && "${output}" == *"[WIKI] wiki search available"* ]] \
      && [[ "${output}" == *"[CONTINUITY] open progress files: memory/progress-alpha.md"* ]] \
      && printf '%s\n' "${output}" | grep -q '^\[OPEN PLANS\] unavailable' \
      && [[ "${output}" != *"clauded-docs/1 "* ]] || {
      echo "${name}: exit ${status}: ${output}"
      return 1
    }
  done
}

@test "the open-plan list is one GET for the three open stages, bounded under a second" {
  local stub="${SANDBOX}/bin" log="${SANDBOX}/curl.log"
  local url="${DEAD_MONITOR_URL}?doc_status=implementing,impl_review,impl_done&limit=200"
  mkdir -p "${stub}"
  # shellcheck disable=SC2016  # $* and CURL_LOG expand inside the stub, not here
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >>"${CURL_LOG}"' \
    "printf '%s\\n' '{\"total\":0,\"rows\":[],${OPEN_STAGES_FILTER}}'" >"${stub}/curl"
  chmod +x "${stub}/curl"
  run env HOME="${FAKE_HOME}" CURL_LOG="${log}" PATH="${stub}:${PATH}" bash "${HOOK_SH}" \
    <<<'{"hook_event_name":"SessionStart","session_id":"sess-smoke"}'
  [[ "${status}" -eq 0 && -f "${log}" ]] || {
    echo "exit ${status}, no curl call: ${output}"
    return 1
  }
  local calls max_time
  calls="$(awk 'END { print NR }' "${log}")"
  max_time="$(awk '{ for (i = 1; i < NF; i++) if ($i == "--max-time") print $(i + 1) }' "${log}")"
  [[ "${calls}" -eq 1 ]] \
    && awk -v url="${url}" '{ for (i = 1; i <= NF; i++) if ($i == url) found = 1 } END { exit !found }' "${log}" \
    && awk -v t="${max_time:-0}" 'BEGIN { exit !(t > 0 && t < 1) }' || {
    echo "calls=${calls} max_time=${max_time}:"
    cat -- "${log}"
    return 1
  }
}

@test "canary: session-start envelope → canary glyph on stdout exactly once" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(glyph_count)" -eq 1 ]] || return 1
}

@test "canary: emitted glyph is a visible single BMP code point (no zero-width/bidi/VS/combining/private-use)" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  local g cp
  local bytes=()
  g="$(canary_glyph)"
  [[ -n "${g}" ]] || return 1
  # Decode the UTF-8 bytes; a 4-byte sequence (non-BMP) or a longer run (more
  # than one code point, e.g. a combining pair or a variation selector) fails.
  read -r -a bytes < <(printf '%s' "${g}" | od -An -tu1)
  case "${#bytes[@]}" in
    1) cp="${bytes[0]}" ;;
    2) cp=$(((bytes[0] - 192) << 6 | (bytes[1] - 128))) ;;
    3) cp=$(((bytes[0] - 224) << 12 | (bytes[1] - 128) << 6 | (bytes[2] - 128))) ;;
    *) return 1 ;;
  esac
  # printable + non-space + BMP (U+0021..U+FFFD, excluding DEL)
  [[ "${cp}" -ge 33 && "${cp}" -le 65533 && "${cp}" -ne 127 ]] || return 1
  # zero-width + bidi controls: U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF
  [[ "${cp}" -lt 8203 || "${cp}" -gt 8207 ]] || return 1
  [[ "${cp}" -lt 8234 || "${cp}" -gt 8238 ]] || return 1
  [[ "${cp}" -lt 8294 || "${cp}" -gt 8297 ]] || return 1
  [[ "${cp}" -ne 65279 ]] || return 1
  # combining marks U+0300-036F / U+20D0-20FF · variation selectors U+FE00-FE0F · private use U+E000-F8FF
  [[ "${cp}" -lt 768 || "${cp}" -gt 879 ]] || return 1
  [[ "${cp}" -lt 8400 || "${cp}" -gt 8447 ]] || return 1
  [[ "${cp}" -lt 65024 || "${cp}" -gt 65039 ]] || return 1
  [[ "${cp}" -lt 57344 || "${cp}" -gt 63743 ]] || return 1
}

@test "canary: the glyph is defined in exactly one file across hooks/rules/scoped/agents/skills" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  local g root hits
  g="$(canary_glyph)"
  [[ -n "${g}" ]] || return 1
  root="${BATS_TEST_DIRNAME}/../.."
  [[ -d "${root}/skills" ]] || skip "search roots absent: ${root}"
  hits="$(cd "${root}" && grep -rlF -- "${g}" hooks rules scoped agents skills 2>/dev/null | sort)"
  [[ "${hits}" == 'hooks/inject-session-context.sh' ]] || {
    echo "glyph found in: ${hits}" >&2
    return 1
  }
}

# A setup skip leaves SANDBOX unset — a failing teardown would report the skip as not ok.
@test "teardown succeeds silently when setup skipped before creating the sandbox" {
  local sandbox="${SANDBOX}"
  unset SANDBOX
  run teardown
  SANDBOX="${sandbox}"
  [[ "${status}" -eq 0 ]] || {
    echo "teardown without a sandbox failed (status ${status}): ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "teardown without a sandbox wrote: ${output}" >&2
    return 1
  }
}
