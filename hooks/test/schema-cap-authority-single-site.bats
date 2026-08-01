#!/usr/bin/env bats
# schema-cap-authority-single-site.bats — the schema-cap / output-shape authority is stated ONCE,
# in the SKILL, and every other surface carries a PRESCRIPTIVE POINTER to it rather than a rule of
# its own. TWO pointer surfaces are pinned here: the Tier-1 charter, and the
# glass-atrium-meta-prompt-engineer body (the agent that AUTHORS schema-mode prompts).
#
# WHY: the rule corpus carried four surfaces speaking about StructuredOutput schema shape/caps —
#   (1) agents/GLASS_ATRIUM_GLOBAL_RULES.md (Tier-1 charter, loads UNCONDITIONALLY),
#   (2) skills/glass-atrium-ops-orchestrator.md → Resilient Workflow Authoring (canonical),
#   (3) hooks/enforce-workflow-verify-stage.sh (the non-blocking schema-cap advisory),
#   (4) agents/glass-atrium-meta-prompt-engineer.md (META body, always loaded for the one agent
#       whose job is authoring the prompts those schemas ship with).
# The charter instructed authors to cap EVERY schema field — the exact defect surface (2) forbids
# and surface (3) flags. Because the charter loads unconditionally while the skill is read
# ON DEMAND, the charter's instruction is the one an author actually sees, so the defective
# prescription WON in practice. The reconciliation: the SKILL keeps the rules, the charter keeps
# only what is charter-level and its cap prescription becomes a pointer.
#
# Surface (4) carried the SAME authority fork in a different costume — it told the prompt author to
# design "explicit output-shape constraints (recursion depth, additionalProperties closure, array
# cardinality)" before draft. The three halves are NOT equally wrong, and the fix does not pretend
# they are:
#   * additionalProperties closure — a CLEAN contradiction. Surface (2) names a flat, all-string
#     `additionalProperties: false` object as the SHAPE root cause of the observed
#     retry-cap-exceeded collapse: the thing to AVOID, prescribed here as the thing to DO.
#   * array cardinality — AMBIGUOUS, not simply wrong. Surface (2) admits exactly ONE top-level
#     maxItems on an inherently multi-item array and FORBIDS caps on properties inside its `items`.
#     "Array cardinality" reads as either, so it cannot stand as a bare instruction.
#   * recursion depth — no counterpart in surface (2) at all: a constraint with no authority
#     behind it.
# All three are removed from surface (4) anyway, because the charter single-sites this authority in
# surface (2): a SECOND prescription site is drift regardless of whether a given clause is right.
# What surface (4) keeps is the part that is genuinely its own — the PRE-DRAFT scoping act — plus
# the pointer.
#
# THE LOAD-BEARING CRITERION IS THE POINTER ON EACH ALWAYS-LOADED SURFACE, and it is asserted as the
# PRESCRIPTIVE CLAUSE, not as the bare path token. The bare token
# `skills/glass-atrium-ops-orchestrator.md` was ALREADY present in the charter at HEAD (the defective
# sentence ended with it), so a bare-token assertion would have passed at HEAD and proved nothing.
# C1/C4 (charter) and M1/M3/M4 (META body) pin the prescriptive-clause needles instead. The META body
# is held to the SAME construction even though its bare path token was absent at HEAD: the pin must
# survive a future edit that re-adds the path while dropping the imperative.
#
# SCOPE (deliberately narrow — read before adding an assertion):
#   * The constraint-token absence gates (C2 charter, M2 META body) apply to those TWO files only.
#     Neither is a repo-wide word ban: the SKILL legitimately discusses `maxLength`/`maxItems` /
#     `additionalProperties` in prose (that is the canonical site), and the HOOK legitimately names
#     them as scan tokens. Both are out of this suite's scope. These two files are gated because
#     "no schema prescription outside the canonical" is precisely the reconciliation being pinned —
#     a rule reappearing in either re-forks the authority.
#     ESCAPE HATCH for a future author: state the rule in the SKILL, not in the charter or the
#     META body.
#   * M2 gates `additionalProperties` in ADDITION to the two cap tokens, because the META body's
#     defect was a SHAPE prescription (closure), not a size cap — a token list copied from C2 alone
#     would not have caught it.
#   * S1/S2/S3 assert the pointers' TARGET still exists (anti-dangling-pointer). S1/S2 PASS at HEAD
#     by construction and are regression pins, not the fail-at-HEAD criterion; S3 fails at HEAD only
#     because the META pointer did not exist there yet.
#   * M5 is an ANTI-OVER-DELETION pin. The scope of this fix was "de-prescribe, then point" — NOT
#     "delete the bullet". Removing the pre-draft scoping duty along with the drift would lose a
#     concern no other surface states, so the duty is pinned as explicitly as the deletion is.
#   * This suite asserts DOCUMENT CONTENT only. It invokes no hook, executes nothing, and asserts
#     nothing about runtime behaviour — so the direct-invocation constraint on hook assertions is
#     not engaged, and no monitor/DB/network is touched. It also touches no loop control flow.
#   * Sibling pin, DISJOINT and neither subsuming the other: orchestrator-skill-schema-example.bats
#     pins the five positive rules and the corrected worked example ON THE SKILL SIDE. This suite
#     pins the CONSUMER side — charter (C*) and META body (M*): defect absent + pointer present.
#     Repository precedent for a cross-file doc-consistency pin: emit-discipline-doc-consistency.bats.
#
# Run via: bats hooks/test/schema-cap-authority-single-site.bats
# Requires: bats (brew install bats-core), grep. No monitor/DB touched.

REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
CHARTER="${REPO_ROOT}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
SKILL="${REPO_ROOT}/skills/glass-atrium-ops-orchestrator.md"
META_AGENT="${REPO_ROOT}/agents/glass-atrium-meta-prompt-engineer.md"

# The defective cap prescription the charter carried at HEAD (single-quoted: it contains backticks).
DEFECT_LITERAL='`maxLength`/`maxItems` on EVERY field'

# Prescriptive-clause needles of the Tier-1 pointer. Short + distinctive, so wording edits AROUND
# them do not break the pin, while removing the prescription itself does.
POINTER_AUTHORITY='Schema-cap authority is single-sited'
POINTER_IMPERATIVE='read them there before authoring any workflow output schema'
POINTER_DISCLAIMER='this charter prescribes no cap of its own'

# The defective output-shape prescription the META body carried at HEAD, verbatim.
META_DEFECT_LITERAL='explicit output-shape constraints (recursion depth, additionalProperties closure, array cardinality)'

# Prescriptive-clause needles of the META pointer. Same construction as the charter's: the bare path
# token would be a weak pin, so the clause that carries the PRESCRIPTION is what is asserted.
META_POINTER_AUTHORITY='this agent states a pointer, not a schema rule'
META_POINTER_IMPERATIVE='read them there before authoring any schema'
META_POINTER_DISCLAIMER='this agent prescribes no schema constraint of its own'

# The half of the bullet that is genuinely the META agent's own and MUST survive the de-prescription:
# the pre-draft scoping act. Pinned so a future "just delete the bullet" edit fails instead of
# silently dropping the duty along with the drift.
META_SCOPING_DUTY='scope the output shape a schema-mode prompt actually needs BEFORE draft'

# The pointer's target, keyed on the canonical section name and one canonical rule marker.
SKILL_SECTION='Resilient Workflow Authoring'
SKILL_RULES_HEADING='Absolute schema-cap rules'

setup() {
  [[ -f "${CHARTER}" ]] || skip "owner site not found: ${CHARTER}"
  [[ -f "${SKILL}" ]] || skip "owner site not found: ${SKILL}"
  [[ -f "${META_AGENT}" ]] || skip "owner site not found: ${META_AGENT}"
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

# ── M1-M5: the META body de-prescribes and points, WITHOUT dropping its own duty ─────────
# Same construction as C1-C5, applied to the second always-loaded surface. M5 is the anti-
# over-deletion pin: the pre-draft scoping act is the META agent's own concern and survives.

@test "M1 the META body no longer prescribes output-shape constraints of its own" {
  assert_absent_in "${META_AGENT}" "${META_DEFECT_LITERAL}"
}

@test "M2 the META body states no schema constraint (no additionalProperties/maxLength/maxItems)" {
  local token hits total=0
  for token in additionalProperties maxLength maxItems; do
    hits="$(grep -Fc -- "${token}" "${META_AGENT}" || true)"
    if [[ "${hits}" != "0" ]]; then
      printf 'constraint token %s present in the META body (%s matching line(s)) — state the rule in %s instead:\n' \
        "${token}" "${hits}" "${SKILL}" >&2
      grep -Fn -- "${token}" "${META_AGENT}" >&2 || true
      total=$((total + 1))
    fi
  done
  [[ "${total}" -eq 0 ]]
}

@test "M3 the META body declares itself a pointer rather than a schema-rule site" {
  assert_present_in "${META_AGENT}" "${META_POINTER_AUTHORITY}"
}

@test "M4 the META pointer is an IMPERATIVE to read the canonical rules, not a bare token" {
  assert_present_in "${META_AGENT}" "${META_POINTER_IMPERATIVE}"
  assert_present_in "${META_AGENT}" "${META_POINTER_DISCLAIMER}"
}

@test "M5 the META body KEEPS its own pre-draft output-shape scoping duty" {
  assert_present_in "${META_AGENT}" "${META_SCOPING_DUTY}"
}

# ── S1/S2/S3: anti-dangling-pointer — the target the pointers name still exists ───────────
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

@test "S3 the META body names the canonical site (path + section) it points at" {
  assert_present_in "${META_AGENT}" "skills/glass-atrium-ops-orchestrator.md"
  assert_present_in "${META_AGENT}" "${SKILL_SECTION}"
}

# ── Aggregate: ONE statement of the authority (consistency gate) ─────────────────────────

@test "ALL schema-cap authority is stated once — skill prescribes, charter + META body point (gate)" {
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

  # META side: same shape — no prescription, pointer present, own scoping duty retained
  if grep -Fq -- "${META_DEFECT_LITERAL}" "${META_AGENT}"; then
    printf 'META body still carries the defective output-shape prescription\n' >&2
    failures=$((failures + 1))
  fi
  for token in additionalProperties maxLength maxItems; do
    if grep -Fq -- "${token}" "${META_AGENT}"; then
      printf 'META body still carries schema constraint token: %s\n' "${token}" >&2
      failures=$((failures + 1))
    fi
  done
  for needle in "${META_POINTER_AUTHORITY}" "${META_POINTER_IMPERATIVE}" "${META_POINTER_DISCLAIMER}" \
                "${META_SCOPING_DUTY}"; do
    if ! grep -Fq -- "${needle}" "${META_AGENT}"; then
      printf 'META pointer/duty clause absent: %s\n' "${needle}" >&2
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
