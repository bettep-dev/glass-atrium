#!/usr/bin/env bats
# inject-session-context.sh — envelope-driven smoke (plan clauded-docs/284 T5).
#
# SessionStart hook — NO blocking semantics (the block/pass envelope ACs do not
# apply): stdout IS the additionalContext injected into the session. The smoke
# asserts EMISSION — the [ORCHESTRATOR SESSION] + [WIKI] context blocks on a
# session-start envelope, plus the [CONTINUITY] header contract (present with
# open progress files, absent without).
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

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  SANDBOX="$(mktemp -d -t ga-sessctx-bats.XXXXXX)"
  FAKE_HOME="${SANDBOX}/home"
  mkdir -p "${FAKE_HOME}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
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

# Run the hook with a session-start envelope on stdin under the sandbox HOME.
run_hook() {
  run env HOME="${FAKE_HOME}" bash "${HOOK_SH}" <<<'{"hook_event_name":"SessionStart","session_id":"sess-smoke"}'
}

@test "emission: session-start envelope → orchestrator + wiki context on stdout, exit 0" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"[ORCHESTRATOR SESSION]"* ]] || return 1
  [[ "${output}" == *"[WIKI] wiki search available"* ]] || return 1
}

@test "no progress tracker → no [CONTINUITY] header (silent fallback)" {
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
