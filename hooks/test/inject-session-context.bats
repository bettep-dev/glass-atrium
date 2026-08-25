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

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  SANDBOX="$(mktemp -d -t ga-sessctx-bats.XXXXXX)"
  FAKE_HOME="${SANDBOX}/home"
  mkdir -p "${FAKE_HOME}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
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

@test "no progress tracker → canary glyph still once, no [CONTINUITY] header, exit 0" {
  run_hook
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"[CONTINUITY]"* ]] || return 1
  [[ "$(glyph_count)" -eq 1 ]] || return 1
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
