#!/usr/bin/env bats
# schema-cap-authority-single-site.bats — the schema-cap authority is stated ONCE, in the SKILL,
# and the always-loaded charter carries a PRESCRIPTIVE POINTER to it rather than a cap rule of
# its own.
#
# WHY: the rule corpus carried three surfaces speaking about StructuredOutput schema caps —
#   (1) agents/GLASS_ATRIUM_GLOBAL_RULES.md (Tier-1 charter, loads UNCONDITIONALLY),
#   (2) skills/glass-atrium-ops-orchestrator.md → Resilient Workflow Authoring (canonical),
#   (3) hooks/enforce-workflow-verify-stage.sh (the non-blocking schema-cap advisory).
# The charter instructed authors to cap EVERY schema field — the exact defect surface (2) forbids
# and surface (3) flags. Because the charter loads unconditionally while the skill is read
# ON DEMAND, the charter's instruction is the one an author actually sees, so the defective
# prescription WON in practice. The reconciliation: the SKILL keeps the rules, the charter keeps
# only what is charter-level and its cap prescription becomes a pointer.
#
# THE LOAD-BEARING CRITERION IS THE TIER-1 POINTER, and it is asserted as the PRESCRIPTIVE CLAUSE,
# not as the bare path token. The bare token `skills/glass-atrium-ops-orchestrator.md` was ALREADY
# present in the charter at HEAD (the defective sentence ended with it), so a bare-token assertion
# would have passed at HEAD and proved nothing. C1/C4 pins the prescriptive-clause needles instead.
#
# SCOPE (deliberately narrow — read before adding an assertion):
#   * The cap-token absence gate (C2) applies to the CHARTER ONLY. It is NOT a repo-wide word ban:
#     the SKILL legitimately discusses `maxLength`/`maxItems` in prose (that is the canonical site),
#     and the HOOK legitimately names them as scan tokens. Both are out of this suite's scope.
#     The charter is gated because "no cap prescription in the always-loaded file" is precisely the
#     reconciliation being pinned — a cap rule reappearing there re-forks the authority.
#     ESCAPE HATCH for a future author: state the rule in the SKILL, not in the charter.
#   * S1/S2 assert the pointer's TARGET still exists (anti-dangling-pointer). They PASS at HEAD by
#     construction and are regression pins, not the fail-at-HEAD criterion.
#   * This suite asserts DOCUMENT CONTENT only. It invokes no hook, executes nothing, and asserts
#     nothing about runtime behaviour — so the direct-invocation constraint on hook assertions is
#     not engaged, and no monitor/DB/network is touched. It also touches no loop control flow.
#   * Sibling pin, DISJOINT and neither subsuming the other: orchestrator-skill-schema-example.bats
#     pins the five positive rules and the corrected worked example ON THE SKILL SIDE. This suite
#     pins the CHARTER side (defect absent + pointer present). Repository precedent for a
#     cross-file doc-consistency pin: emit-discipline-doc-consistency.bats.
#
# Run via: bats hooks/test/schema-cap-authority-single-site.bats
# Requires: bats (brew install bats-core), grep. No monitor/DB touched.

REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
CHARTER="${REPO_ROOT}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
SKILL="${REPO_ROOT}/skills/glass-atrium-ops-orchestrator.md"

# The defective cap prescription the charter carried at HEAD (single-quoted: it contains backticks).
DEFECT_LITERAL='`maxLength`/`maxItems` on EVERY field'

# Prescriptive-clause needles of the Tier-1 pointer. Short + distinctive, so wording edits AROUND
# them do not break the pin, while removing the prescription itself does.
POINTER_AUTHORITY='Schema-cap authority is single-sited'
POINTER_IMPERATIVE='read them there before authoring any workflow output schema'
POINTER_DISCLAIMER='this charter prescribes no cap of its own'

# The pointer's target, keyed on the canonical section name and one canonical rule marker.
SKILL_SECTION='Resilient Workflow Authoring'
SKILL_RULES_HEADING='Absolute schema-cap rules'

setup() {
  [[ -f "${CHARTER}" ]] || skip "owner site not found: ${CHARTER}"
  [[ -f "${SKILL}" ]] || skip "owner site not found: ${SKILL}"
}

# helper: fixed-string presence assertion with a legible failure message
assert_present_in() {
  local file="$1" needle="$2"
  grep -Fq -- "${needle}" "${file}" || {
    printf 'required marker absent from %s:\n  %s\n' "${file}" "${needle}" >&2
    return 1
  }
}

# helper: fixed-string absence assertion that reports the surviving occurrences
assert_absent_in() {
  local file="$1" needle="$2" hits
  hits="$(grep -Fc -- "${needle}" "${file}" || true)"
  [[ "${hits}" == "0" ]] || {
    printf 'forbidden literal still present in %s (%s matching line(s)):\n  %s\n' \
      "${file}" "${hits}" "${needle}" >&2
    grep -Fn -- "${needle}" "${file}" >&2 || true
    return 1
  }
}

# ── C1: the defective cap prescription is gone from the always-loaded charter ────────────

@test "C1 the charter no longer instructs authors to cap EVERY schema field" {
  assert_absent_in "${CHARTER}" "${DEFECT_LITERAL}"
}

# ── C2: the charter carries NO cap token at all (charter-scoped, see SCOPE note) ─────────

@test "C2 the charter states no schema-cap rule of its own (no maxLength/maxItems token)" {
  local token hits total=0
  for token in maxLength maxItems; do
    hits="$(grep -Fc -- "${token}" "${CHARTER}" || true)"
    if [[ "${hits}" != "0" ]]; then
      printf 'cap token %s present in the charter (%s matching line(s)) — state the rule in %s instead:\n' \
        "${token}" "${hits}" "${SKILL}" >&2
      grep -Fn -- "${token}" "${CHARTER}" >&2 || true
      total=$((total + 1))
    fi
  done
  [[ "${total}" -eq 0 ]]
}

# ── C3/C4/C5: the Tier-1 pointer is present AS A PRESCRIPTIVE CLAUSE ─────────────────────
# These are the load-bearing criterion: the charter loads unconditionally, the skill does not.

@test "C3 the charter declares the schema-cap authority single-sited" {
  assert_present_in "${CHARTER}" "${POINTER_AUTHORITY}"
}

@test "C4 the charter's pointer is an IMPERATIVE to read the canonical rules, not a bare token" {
  assert_present_in "${CHARTER}" "${POINTER_IMPERATIVE}"
}

@test "C5 the charter explicitly disclaims prescribing a cap of its own" {
  assert_present_in "${CHARTER}" "${POINTER_DISCLAIMER}"
}

# ── S1/S2: anti-dangling-pointer — the target the charter points at still exists ──────────
# Regression pins (they pass at HEAD): a pointer to a vanished section is worse than no pointer.

@test "S1 the charter names the canonical site (path + section) it points at" {
  assert_present_in "${CHARTER}" "skills/glass-atrium-ops-orchestrator.md"
  assert_present_in "${CHARTER}" "${SKILL_SECTION}"
}

@test "S2 the skill still carries that section and its absolute cap rules" {
  assert_present_in "${SKILL}" "${SKILL_SECTION}"
  assert_present_in "${SKILL}" "${SKILL_RULES_HEADING}"
  assert_present_in "${SKILL}" 'no `maxLength` anywhere on a workflow output schema'
}

# ── Aggregate: ONE statement of the authority (consistency gate) ─────────────────────────

@test "ALL schema-cap authority is stated once — skill prescribes, charter points (gate)" {
  # NOTE ON FORM: every check below uses an `if` condition, never `cmd && { ... }`. Under the
  # errexit bats runs each test with, a failing `grep` heading an AND-list makes the list itself
  # return non-zero and aborts the test — which for an ABSENCE check would invert the gate (a
  # CLEAN charter would abort as a failure). Condition context is the only safe form here.
  local failures=0

  # charter side: no prescription, pointer present in all three prescriptive parts
  if grep -Fq -- "${DEFECT_LITERAL}" "${CHARTER}"; then
    printf 'charter still carries the defective cap prescription\n' >&2
    failures=$((failures + 1))
  fi
  local token
  for token in maxLength maxItems; do
    if grep -Fq -- "${token}" "${CHARTER}"; then
      printf 'charter still carries cap token: %s\n' "${token}" >&2
      failures=$((failures + 1))
    fi
  done
  local needle
  for needle in "${POINTER_AUTHORITY}" "${POINTER_IMPERATIVE}" "${POINTER_DISCLAIMER}"; do
    if ! grep -Fq -- "${needle}" "${CHARTER}"; then
      printf 'charter pointer clause absent: %s\n' "${needle}" >&2
      failures=$((failures + 1))
    fi
  done

  # skill side: the canonical prescription still lives there
  for needle in "${SKILL_SECTION}" "${SKILL_RULES_HEADING}"; do
    if ! grep -Fq -- "${needle}" "${SKILL}"; then
      printf 'canonical marker absent from the skill: %s\n' "${needle}" >&2
      failures=$((failures + 1))
    fi
  done

  [[ "${failures}" -eq 0 ]]
}
