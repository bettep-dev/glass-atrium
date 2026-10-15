#!/usr/bin/env bats
# workflow-gate-plan-stage.bats — the plan-stage advisories of enforce-workflow-verify-stage.sh: the
#   close token (grammar SoT: orchestrator-role.md → Context Handoff Size, `[PLAN-CLOSE]`) with its
#   --lint --template section, and the `implementing` stage nudge. Advisory only: every row exits 0 or
#   keeps its block verdict.
#
# Hermetic: setup points WORKFLOW_GATE_MONITOR_URL at a refused loopback port, and the `implementing`
#   rows at a file:// fixture dir (one JSON file per id) — no test reaches the live monitor.
#
# BATS GATING NOTE (measured, bats 1.13.0 both legs): a mid-body `[[ ]]` gates on Linux bash 5 but not
#   on macOS bash 3.2 — every assertion carries `|| return 1` or `|| { …; return 1; }`.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-workflow-verify-stage.sh"
CLOSE_PHRASE='ADVISORY (close token, non-blocking)'
STAGE_PHRASE='ADVISORY (implementing stage, non-blocking)'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
  # Port 9 on loopback refuses (curl rc 7) → every monitor read on the PASS arm fails open.
  export WORKFLOW_GATE_MONITOR_URL="http://127.0.0.1:9/api/clauded-docs"
  FIXTURE_DIR="${BATS_TEST_TMPDIR}/clauded-docs"
  mkdir -p "${FIXTURE_DIR}"
  write_doc 101 glass-atrium-intel-planner doc_review
  write_doc 102 glass-atrium-intel-reporter doc_review
  write_doc 103 glass-atrium-intel-planner implementing
  write_doc 106 glass-atrium-intel-planner doc_review 101
}

# $1=id $2=author $3=doc_status $4=supersedes_id (empty → an original document). No file for 104: its
# read fails the way a down monitor's does.
write_doc() {
  jq -n --argjson id "${1}" --arg a "${2}" --arg s "${3}" --arg p "${4:-}" \
    '{id:$id, author:$a, doc_status:$s, supersedes_id:(if $p == "" then null else ($p | tonumber) end)}' \
    >"${FIXTURE_DIR}/${1}"
}

# Serves the monitor reads from the fixture dir; a refused port still wins when a test sets it after.
use_fixture_monitor() {
  command -v curl >/dev/null 2>&1 || skip "curl not on PATH"
  export WORKFLOW_GATE_MONITOR_URL="file://${FIXTURE_DIR}"
}

# Prints the plan id the `implementing` nudge names, one per nudge line; nothing when there is none.
get_nudged_ids() {
  printf '%s\n' "${output}" | sed -n 's|.*plan clauded-docs/\([0-9]*\) is still at doc_review.*|\1|p'
}

# Fire the hook directly (shebang + exec bit) over a Workflow envelope wrapping $1.
run_hook_exec() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# The advisory field of the last recorded trace line, or MISSING.
last_advisory() {
  awk -F'\t' 'END { for (i = 1; i <= NF; i++) if (index($i, "advisory=") == 1) { print substr($i, 10); exit } print "MISSING" }' "${TRACE_LOG}"
}

# A passing DEV workflow: verify team → implementation, with $1 spliced in as its entry and close lines.
dev_script() {
  printf '%s\n' "/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */" \
    "${1}" \
    "log('[SIZE-EST] bundles=1 tool_uses~=10 — one file');" \
    "log('[SCOPE] files=src/a.ts · deliverable=feature · out=none');" \
    "parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}));" \
    "agent('glass-atrium-dev-nestjs',{goal:'implement'});"
}

@test "close token: a plan-referencing DEV workflow is nudged exactly when it carries neither form" {
  local rows=(
    "plan-ref by monitor id, no close token|log('plan-ref: clauded-docs/100');|advise"
    "plan-ref by plan file path, no close token|log('plan-ref: docs/rollout-plan.html');|advise"
    "close form|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] in-script');|silent"
    "deferral form naming the closing step|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] deferred: the deploy script closes it');|silent"
    "deferral form naming a step led by a path|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] deferred: ./close-plan.js');|silent"
    "deferral form naming a step led by a backtick|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] deferred: \`wave-b.js\` closes it');|silent"
    "deferral form naming a step led by a quote|log('plan-ref: clauded-docs/100'); log(\"[PLAN-CLOSE] deferred: 'step 8 deploy'\");|silent"
    "deferral form naming no closing step|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] deferred:');|advise"
    "deferral form naming no closing step, code following on its line|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] deferred:');log('next');|advise"
    "unknown form value|log('plan-ref: clauded-docs/100'); log('[PLAN-CLOSE] later');|advise"
    "simple-task entry, no plan-ref|log('[ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — one line');|silent"
  )
  local row name lines expect
  for row in "${rows[@]}"; do
    IFS='|' read -r name lines expect <<<"${row}"
    run_hook_exec "$(dev_script "${lines}")"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: status ${status} -- ${output}"
      return 1
    }
    if [[ "${expect}" == "advise" ]]; then
      [[ "${output}" == *"${CLOSE_PHRASE}"* ]] || {
        echo "${name}: no nudge -- ${output}"
        return 1
      }
      [[ "$(last_advisory)" == *"close-token"* ]] || {
        echo "${name}: not traced -- $(last_advisory)"
        return 1
      }
    else
      [[ "${output}" != *"${CLOSE_PHRASE}"* ]] || {
        echo "${name}: nudged -- ${output}"
        return 1
      }
      [[ "$(last_advisory)" != *"close-token"* ]] || {
        echo "${name}: traced -- $(last_advisory)"
        return 1
      }
    fi
  done
}

@test "close token: a non-DEV workflow citing a plan is never nudged" {
  run_hook_exec "log('plan-ref: clauded-docs/100');
agent('glass-atrium-intel-researcher',{goal:'survey'});"
  [[ "${status}" -eq 0 ]] || {
    echo "status ${status} -- ${output}"
    return 1
  }
  [[ "${output}" != *"${CLOSE_PHRASE}"* ]] || {
    echo "nudged a non-DEV workflow -- ${output}"
    return 1
  }
}

@test "close token: a blocked DEV workflow keeps its block and carries no nudge (PASS-arm siting)" {
  run_hook_exec "log('plan-ref: clauded-docs/100');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one file');
parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'}));
agent('glass-atrium-dev-nestjs',{goal:'implement'});"
  [[ "${status}" -eq 2 ]] || {
    echo "declaration-less DEV script must block, status ${status} -- ${output}"
    return 1
  }
  [[ "${output}" != *"${CLOSE_PHRASE}"* ]] || {
    echo "nudge rode a block -- ${output}"
    return 1
  }
}

@test "template: the taught close form and terminal phase silence the nudge; the unfilled deferral placeholder does not" {
  run bash -c 'WORKFLOW_GATE_FIRED_LOG="$2" "$1" --lint --template' _ "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]] || {
    echo "--lint --template status ${status} -- ${output}"
    return 1
  }
  local template="${output}" close_line phase_line deferral_line
  close_line="$(printf '%s\n' "${template}" | grep -F "[PLAN-CLOSE] in-script" || true)"
  phase_line="$(printf '%s\n' "${template}" | grep -F "goal: RECONCILE_GOAL" || true)"
  deferral_line="$(printf '%s\n' "${template}" | grep -F "[PLAN-CLOSE] deferred:" || true)"
  [[ -n "${close_line}" && -n "${phase_line}" && -n "${deferral_line}" ]] || {
    echo "template lacks a close-token section -- close=[${close_line}] phase=[${phase_line}] deferral=[${deferral_line}]"
    return 1
  }

  run_hook_exec "$(dev_script "log('plan-ref: clauded-docs/100');
${close_line}")
${phase_line}"
  [[ "${status}" -eq 0 ]] || {
    echo "pasted close form + phase: status ${status} -- ${output}"
    return 1
  }
  [[ "${output}" != *"${CLOSE_PHRASE}"* ]] || {
    echo "the taught close form was nudged -- ${output}"
    return 1
  }

  run_hook_exec "$(dev_script "log('plan-ref: clauded-docs/100');
${deferral_line}")"
  [[ "${status}" -eq 0 ]] || {
    echo "pasted deferral form: status ${status} -- ${output}"
    return 1
  }
  [[ "${output}" == *"${CLOSE_PHRASE}"* ]] || {
    echo "an unfilled deferral placeholder passed as a close token -- ${output}"
    return 1
  }
}

@test "implementing: the nudge names the first planner-authored document still at doc_review, and only it" {
  use_fixture_monitor
  local -a rows=(
    "planner plan at doc_review|clauded-docs/101|101"
    "reporter document at doc_review only|clauded-docs/102|none"
    "reporter first, planner second|clauded-docs/102 then clauded-docs/101|101"
    "planner plan already implementing|clauded-docs/103|none"
    "walk stops at the first planner document|clauded-docs/103 then clauded-docs/101|none"
    "walk stops at the first failed read|clauded-docs/104 then clauded-docs/101|none"
  )
  local row name refs expected named
  for row in "${rows[@]}"; do
    IFS='|' read -r name refs expected <<<"${row}"
    run_hook_exec "$(dev_script "log('plan-ref: ${refs}');")"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: the nudge must never block, status ${status} -- ${output}"
      return 1
    }
    named="$(get_nudged_ids)"
    [[ "${named:-none}" == "${expected}" ]] || {
      echo "${name}: nudge named '${named:-none}', expected '${expected}' -- ${output}"
      return 1
    }
    if [[ "${expected}" == "none" ]]; then
      [[ "$(last_advisory)" != *"implementing"* ]] || {
        echo "${name}: traced with no nudge -- $(last_advisory)"
        return 1
      }
    else
      [[ "$(last_advisory)" == *"implementing"* ]] || {
        echo "${name}: nudge not traced -- $(last_advisory)"
        return 1
      }
    fi
  done
}

@test "implementing: both monitor walks read each cited document at most once, failed reads included" {
  use_fixture_monitor
  local real_curl url_log shim_dir
  real_curl="$(command -v curl)"
  url_log="${BATS_TEST_TMPDIR}/curl-urls.log"
  shim_dir="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${shim_dir}"
  cat >"${shim_dir}/curl" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
  case "\${a}" in
    file://*) printf '%s\n' "\${a##*/}" >>"${url_log}" ;;
  esac
done
exec "${real_curl}" "\$@"
SH
  chmod +x "${shim_dir}/curl"
  PATH="${shim_dir}:${PATH}"
  # The first-link walk reads the first cited id and its predecessors; the stage walk reads the cited ids.
  local -a rows=(
    "one planner plan both walks read|clauded-docs/101"
    "a revised plan, its predecessor read by the first-link walk only|clauded-docs/106"
    "a failed read, not retried by the second walk|clauded-docs/104"
    "a repeated citation after a reporter document|clauded-docs/102 then clauded-docs/102 then clauded-docs/101"
  )
  local row name refs repeated
  for row in "${rows[@]}"; do
    IFS='|' read -r name refs <<<"${row}"
    : >"${url_log}"
    run_hook_exec "$(dev_script "log('plan-ref: ${refs}');")"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: status ${status} -- ${output}"
      return 1
    }
    [[ -s "${url_log}" ]] || {
      echo "${name}: no monitor read at all -- ${output}"
      return 1
    }
    repeated="$(sort "${url_log}" | uniq -d)"
    [[ -z "${repeated}" ]] || {
      echo "${name}: read more than once: ${repeated//$'\n'/ } -- reads: $(tr '\n' ' ' <"${url_log}")"
      return 1
    }
  done
}

@test "implementing: a refused monitor fails the walk open, with no nudge and no internal error" {
  run_hook_exec "$(dev_script "log('plan-ref: clauded-docs/101');")"
  [[ "${status}" -eq 0 ]] || {
    echo "status ${status} -- ${output}"
    return 1
  }
  [[ "${output}" != *"${STAGE_PHRASE}"* ]] || {
    echo "nudged with the monitor refused -- ${output}"
    return 1
  }
  [[ "${output}" != *"internal error"* ]] || {
    echo "the walk tripped the ERR trap -- ${output}"
    return 1
  }
  [[ "$(last_advisory)" != *"implementing"* ]] || {
    echo "traced with the monitor refused -- $(last_advisory)"
    return 1
  }
}

@test "implementing: a non-DEV or blocked workflow citing an unstarted plan is never nudged" {
  use_fixture_monitor
  local -a rows=(
    "non-DEV workflow|0|log('plan-ref: clauded-docs/101'); agent('glass-atrium-intel-researcher',{goal:'survey'});"
    "declaration-less DEV workflow|2|log('plan-ref: clauded-docs/101'); log('[SIZE-EST] bundles=1 tool_uses~=10 — one file'); parallel(agent('glass-atrium-qa-code-reviewer',{goal:'judge'}),agent('glass-atrium-dev-nestjs',{goal:'feasible'})); agent('glass-atrium-dev-nestjs',{goal:'implement'});"
  )
  local row name want script
  for row in "${rows[@]}"; do
    IFS='|' read -r name want script <<<"${row}"
    run_hook_exec "${script}"
    [[ "${status}" -eq "${want}" ]] || {
      echo "${name}: status ${status}, expected ${want} -- ${output}"
      return 1
    }
    [[ "${output}" != *"${STAGE_PHRASE}"* ]] || {
      echo "${name}: nudged -- ${output}"
      return 1
    }
  done
}
