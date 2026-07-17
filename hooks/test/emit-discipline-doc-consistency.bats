#!/usr/bin/env bats
# emit-discipline-doc-consistency.bats — the "print-block-then-emit" marker stays present at all
# three owner sites, and stays prominent (top of the completion section) in the qa-code-reviewer.
#
# WHY: F1 emission discipline is a documentation contract split across three files. The stable
# marker "print-block-then-emit" is the shared anchor tying them together; if any one site drops
# it, the discipline drifts out of sync. This test greps the marker CASE-INSENSITIVELY (grep -i)
# because GLASS_ATRIUM_GLOBAL_RULES.md carries it as the capitalized bold header
# "Print-block-then-emit" while the other two sites use lowercase. The full sentence is NOT
# echoed — only the stable marker is keyed, so wording edits at each site do not break the check.
#
# HONESTY (acceptance scope): the acceptance criterion here is DOC-CONSISTENCY only. It does NOT
# assert a runtime synthesized-outcome-rate threshold — runtime synthesis rate is an observed
# metric, not something a repo-file grep can gate. This test proves the marker is present and
# prominent, nothing about live recorder behavior.
#
# Run via: bats hooks/test/emit-discipline-doc-consistency.bats
# Requires: bats (brew install bats-core), grep. No monitor/DB touched.

REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
MARKER="print-block-then-emit"

GLOBAL_RULES="${REPO_ROOT}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
INJECT_HOOK="${REPO_ROOT}/hooks/inject-scope-rules.sh"
QA_REVIEWER="${REPO_ROOT}/agents/glass-atrium-qa-code-reviewer.md"

setup() {
  [[ -f "${GLOBAL_RULES}" ]] || skip "owner site not found: ${GLOBAL_RULES}"
  [[ -f "${INJECT_HOOK}" ]] || skip "owner site not found: ${INJECT_HOOK}"
  [[ -f "${QA_REVIEWER}" ]] || skip "owner site not found: ${QA_REVIEWER}"
}

# ── Per-site presence (case-insensitive) ────────────────────────────────────────────────

@test "S1 GLASS_ATRIUM_GLOBAL_RULES.md carries the marker (capitalized header allowed)" {
  grep -qi "${MARKER}" "${GLOBAL_RULES}" || {
    printf 'marker %s absent from %s\n' "${MARKER}" "${GLOBAL_RULES}" >&2
    return 1
  }
}

@test "S2 inject-scope-rules.sh carries the marker" {
  grep -qi "${MARKER}" "${INJECT_HOOK}" || {
    printf 'marker %s absent from %s\n' "${MARKER}" "${INJECT_HOOK}" >&2
    return 1
  }
}

@test "S3 glass-atrium-qa-code-reviewer.md carries the marker" {
  grep -qi "${MARKER}" "${QA_REVIEWER}" || {
    printf 'marker %s absent from %s\n' "${MARKER}" "${QA_REVIEWER}" >&2
    return 1
  }
}

# ── Aggregate consistency: absent from ANY of the three → fail ──────────────────────────

@test "ALL three owner sites carry the marker (consistency gate)" {
  local site missing=0
  for site in "${GLOBAL_RULES}" "${INJECT_HOOK}" "${QA_REVIEWER}"; do
    if ! grep -qi "${MARKER}" "${site}"; then
      printf 'marker %s absent from %s\n' "${MARKER}" "${site}" >&2
      missing=$((missing + 1))
    fi
  done
  [[ "${missing}" -eq 0 ]]
}

# ── Prominence: the marker leads the qa-code-reviewer completion section ─────────────────

@test "PROMINENCE marker precedes the deliverable-format body in qa-code-reviewer.md" {
  # The relocated FINAL STEP sits at the top of the Deliverable Format (completion) section,
  # above the "## Review Summary" template body. A first-marker line number below the template
  # heading line number proves the top-of-section placement.
  local marker_line body_line
  marker_line="$(grep -ni "${MARKER}" "${QA_REVIEWER}" | head -1 | cut -d: -f1)"
  body_line="$(grep -n '^## Review Summary' "${QA_REVIEWER}" | head -1 | cut -d: -f1)"
  [[ -n "${marker_line}" ]] || {
    printf 'marker %s not found in %s\n' "${MARKER}" "${QA_REVIEWER}" >&2
    return 1
  }
  [[ -n "${body_line}" ]] || {
    printf 'deliverable-format body anchor "## Review Summary" not found in %s\n' "${QA_REVIEWER}" >&2
    return 1
  }
  [[ "${marker_line}" -lt "${body_line}" ]] || {
    printf 'marker at L%s is not above the completion-section body at L%s\n' "${marker_line}" "${body_line}" >&2
    return 1
  }
}
