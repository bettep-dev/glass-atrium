#!/usr/bin/env bats
# Envelope smoke cases for the stdin-only bound hook validate-pre-write-raw.
#
# Run via: bats hooks/test/wiring-only-smoke.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq.
#
# Hermetic strategy: the hook reads ONLY stdin, and its WIKI_ROOT env seam points into a
# mktemp sandbox.

RAW_HOOK="${BATS_TEST_DIRNAME}/../validate-pre-write-raw.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${RAW_HOOK}" ]] || skip "hook not found: ${RAW_HOOK}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  SANDBOX="$(mktemp -d -t ga-wiring-bats.XXXXXX)"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# ── validate-pre-write-raw.sh — PreToolUse(Write|Edit) wiki raw-ingestion gate ───────

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
  # V6 (plan H2/R5) requires a body-resident provenance envelope in addition to the 3-field
  # frontmatter — a conforming raw write wraps the preserved content in the UNTRUSTED-SOURCE markers.
  local content
  content="$(printf -- '---\nsource_url: https://example.com/article\ncollected: 2026-07-20\ncollector: glass-atrium-intel-researcher\n---\n<!-- UNTRUSTED-SOURCE -->\n# Original Title\n\nBody paragraph.\n<!-- /UNTRUSTED-SOURCE -->\n')"
  run_raw_hook "${SANDBOX}/wiki/raw/good.md" "${content}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "validate-pre-write-raw: non-raw path → out of scope, pass (exit 0)" {
  run_raw_hook "/tmp/proj/notes.md" "no frontmatter at all"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "teardown succeeds silently when setup skipped before creating the temp dir" {
  local saved="${SANDBOX}"
  unset SANDBOX
  run teardown
  SANDBOX="${saved}"
  [[ "${status}" -eq 0 ]] || {
    echo "teardown without a temp dir failed (status ${status}): ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "teardown without a temp dir wrote: ${output}" >&2
    return 1
  }
}
