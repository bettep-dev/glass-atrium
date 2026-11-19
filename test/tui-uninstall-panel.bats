#!/usr/bin/env bats
# TUI uninstall panel — the queue MCP removal question, then the config purge prompt, are offered only after
# the base uninstall plan succeeded; a failed plan returns its own status instead.
#
# Run via: bats test/tui-uninstall-panel.bats
# Requires: bats (brew install bats-core), bash 3.2+

# shellcheck disable=SC2154 # BATS_TEST_DIRNAME is injected by the bats runtime
GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  WORK="$(mktemp -d)"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# Copy one function definition out of a shell file into a sourceable temp file
# (awk + source, never eval). Args: $1 = function name · $2 = source · $3 = destination.
extract_fn_to() {
  awk -v fn="$1" 'index($0, fn "() {") == 1 { f = 1 } f { print } f && /^}/ { exit }' \
    "$2" >"$3"
}

# Run the lifted panel with a base plan returning $1; each _confirm_pregate token is
# appended to ${WORK}/tokens ("remove" proceeds, any other token declines).
# Echoes the panel's return code.
run_panel_with_plan_rc() {
  local body="${WORK}/fn.sh"
  extract_fn_to dispatch_action_uninstall_panel "${GA}/lib/ga-tui-dispatch.sh" "${body}"
  [[ -s "${body}" ]] || return 1
  : >"${WORK}/tokens"
  PLAN_RC="$1" TOKENS="${WORK}/tokens" TTY=/dev/null bash -c '
    _confirm_pregate() { printf "%s\n" "$1" >>"${TOKENS}"; [[ "$1" == "remove" ]]; }
    tui_queue_mcp_gate() { printf "queue-%s\n" "$1" >>"${TOKENS}"; }
    run_action_panel() { return "${PLAN_RC}"; }
    ga_resolve_backup_dir() { printf "%s\n" /nonexistent/backups; }
    enter_run_state() { :; }
    enter_nav_state() { :; }
    source "$1"
    rc=0
    dispatch_action_uninstall_panel || rc=$?
    printf "%s\n" "${rc}"
  ' _ "${body}"
}

@test "the queue MCP question and then the purge prompt follow only a base plan that returned 0" {
  local row name plan_rc want_tokens want_rc got_rc tokens
  local rows=(
    "base plan returns 0|0|remove queue-remove purge|0"
    "base plan returns 3|3|remove|3"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name plan_rc want_tokens want_rc <<<"${row}"
    got_rc="$(run_panel_with_plan_rc "${plan_rc}")" || {
      echo "${name}: could not run the panel"
      return 1
    }
    tokens="$(tr '\n' ' ' <"${WORK}/tokens")"
    [[ "${tokens% }" == "${want_tokens}" ]] || {
      echo "${name}: asked '${tokens}', want '${want_tokens}'"
      return 1
    }
    [[ "${got_rc}" == "${want_rc}" ]] || {
      echo "${name}: returned ${got_rc}, want ${want_rc}"
      return 1
    }
  done
}
