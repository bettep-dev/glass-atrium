#!/usr/bin/env bats
# Wiring-only-coverage reconciliation + cheap smoke cases (plan clauded-docs/284 T5).
#
# RECONCILIATION RECORD (test/doctor-hook-bindings.bats roster vs hooks/test/ behavioral
# coverage, computed on this branch — the T5 AC's enumerate-before-authoring step):
#
#   Roster = 37 unique hook basenames across the 44 EXPECTED_HOOK_BINDINGS leaves.
#   Verified WIRING-ONLY set (bound in doctor, executed by NO hooks/test suite) = 12:
#     security six — block-dangerous-commands · block-no-verify · detect-secret-file-write
#                    · validate-secret-scan · enforce-config-protection · inject-session-context
#     plus       — advisory-preedit-facts · advisory-spawn-budget · block-md-creation
#                    · post-edit-outcome-sync · validate-compliance-matrix · validate-pre-write-raw
#   NOT wiring-only (adjacent-suite behavioral coverage confirmed by execution, not mention):
#     advisory-context-budget + advisory-spawn-cost → advisory-read-cache.bats (fires both)
#     post-edit-typecheck → hook-utils-fields.bats (migration-parity cases execute it)
#     prune-session-spawns + prune-security-warnings-state → prune-mtime-portable.bats
#   DELTA vs the review's count of 11: +1 — advisory-spawn-budget. Its only hooks/test
#     reference is a prose comment in enforce-verification-gate.bats (never executed),
#     so it IS wiring-only; the review's 11 evidently classed it covered.
#
#   Coverage AFTER this change: the security six each gain a dedicated smoke suite
#   (block-dangerous-commands.bats · block-no-verify.bats · detect-secret-file-write.bats
#   · validate-secret-scan.bats · enforce-config-protection.bats · inject-session-context.bats);
#   block-md-creation + validate-pre-write-raw gain cheap envelope smokes BELOW (both are
#   stdin-only with env seams — no fixture cost).
#
#   DOCUMENTED RESIDUAL GAP (4, each needs a non-trivial fixture — backlog per plan
#   Non-Goals, owner dev-shell):
#     advisory-preedit-facts    — Stop-only transcript-tail advisory; needs a JSONL
#                                 transcript corpus fixture.
#     advisory-spawn-budget     — PreToolUse(Agent) cumulative spawn-count advisory;
#                                 needs a seeded session-spawns append-trace fixture.
#     post-edit-outcome-sync    — PostToolUse(Write) outcome→progress status flip;
#                                 needs paired outcome + open-progress file fixtures.
#     validate-compliance-matrix — SessionStart matrix parser (Layer A drift + Layer B
#                                 consistency); needs a rules-tree + matrix-doc fixture.
#
# Run via: bats hooks/test/wiring-only-smoke.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq.
#
# Hermetic strategy: both hooks under test read ONLY stdin; block-md-creation's
# monitor-port resolver is pinned via ATRIUM_MONITOR_PORT (no config sourcing),
# and validate-pre-write-raw's WIKI_ROOT env seam points into a mktemp sandbox.

MD_HOOK="${BATS_TEST_DIRNAME}/../block-md-creation.sh"
RAW_HOOK="${BATS_TEST_DIRNAME}/../validate-pre-write-raw.sh"

setup() {
  [[ -f "${MD_HOOK}" ]] || skip "hook not found: ${MD_HOOK}"
  [[ -f "${RAW_HOOK}" ]] || skip "hook not found: ${RAW_HOOK}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  SANDBOX="$(mktemp -d -t ga-wiring-bats.XXXXXX)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# ── block-md-creation.sh — PreToolUse(Write) monitor SoT-bypass gate ─────────────────

# Run block-md-creation with an envelope on stdin. Args: $1=input JSON.
run_md_hook() {
  run env ATRIUM_MONITOR_PORT="16145" bash "${MD_HOOK}" <<<"${1}"
}

@test "block-md-creation: monitor-internal documents write → DEL-002 block (exit 2)" {
  run_md_hook '{"tool_name":"Write","tool_input":{"file_path":"/Users/u/.glass-atrium/monitor/data/documents/doc.md"}}'
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"DEL-002"* ]] || return 1
}

@test "block-md-creation: ordinary markdown write elsewhere → pass (exit 0)" {
  run_md_hook '{"tool_name":"Write","tool_input":{"file_path":"/tmp/proj/README.md"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

@test "block-md-creation: non-Write tool → pass (exit 0)" {
  run_md_hook '{"tool_name":"Edit","tool_input":{"file_path":"/Users/u/.glass-atrium/monitor/data/documents/doc.md"}}'
  [[ "${status}" -eq 0 ]] || return 1
}

# ── validate-pre-write-raw.sh — PreToolUse(Write) wiki raw-ingestion gate ────────────

# Run validate-pre-write-raw on a jq-built Write envelope, WIKI_ROOT sandboxed.
# Args: $1=file_path $2=content.
run_raw_hook() {
  local envelope
  envelope="$(jq -cn --arg path "$1" --arg body "$2" \
    '{tool_name: "Write", tool_input: {file_path: $path, content: $body}}')"
  run env WIKI_ROOT="${SANDBOX}/wiki" bash "${RAW_HOOK}" <<<"${envelope}"
}

@test "validate-pre-write-raw: raw write without frontmatter → SCOPE-001 block (exit 2)" {
  run_raw_hook "${SANDBOX}/wiki/raw/bad.md" "no frontmatter at all"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"SCOPE-001"* ]] || return 1
}

@test "validate-pre-write-raw: valid 3-field raw file → pass (exit 0)" {
  local content
  content="$(printf -- '---\nsource_url: https://example.com/article\ncollected: 2026-07-20\ncollector: glass-atrium-intel-researcher\n---\n# Original Title\n\nBody paragraph.\n')"
  run_raw_hook "${SANDBOX}/wiki/raw/good.md" "${content}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "validate-pre-write-raw: non-raw path → out of scope, pass (exit 0)" {
  run_raw_hook "/tmp/proj/notes.md" "no frontmatter at all"
  [[ "${status}" -eq 0 ]] || return 1
}
