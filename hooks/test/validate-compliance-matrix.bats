#!/usr/bin/env bats
# validate-compliance-matrix.bats — first bats corpus for the compliance-matrix
# validator; pins the new Layer C (registry ↔ Scope Legend roster reconciliation)
# and its interaction with the two pre-existing layers.
#
#   ACs pinned here:
#     AC1  a registered agent absent from the Scope Legend is NAMED and exits 2.
#     AC2  a Scope-Legend-listed agent absent from the registry is NAMED and exits 2.
#     AC3  the legend's non-agent literals ("All agents", "Global agent /
#          coordinator") and the archived struck-through row are reported as
#          NOTHING — the positive-shape predicate drops them by construction.
#     AC4  an unparseable structure (either side) emits an advisory note and
#          exits 0 — the load-bearing FAIL-OPEN contract, tested on the legend
#          side, the registry side, and a malformed-JSON registry. An ABSENT
#          matrix names the file as absent rather than as merely unreadable.
#     AC5  registry and legend in agreement → exit 0 with no report.
#     AC6  a CONFIRMED Layer B fault survives a clean Layer C at ALL THREE exit
#          points (merge, never assign), and a Layer C mismatch survives a clean
#          Layer B.
#     AC7  the two pre-existing layers behave unchanged: Layer A's OK / drift
#          banners, Layer B's B1 detection and its own fail-open note. An absent
#          matrix short-circuits ahead of both enforcement layers, so the guard
#          emits BOTH layers' advisories itself — still exit 0.
#
#   Isolation follows the corpus convention: per-test tmpdir fixtures driven
#   through the hook's own env-overridable constants (COMPLIANCE_MATRIX_FILE /
#   COMPLIANCE_RULES_DIR / COMPLIANCE_SCOPED_DIR / COMPLIANCE_REGISTRY_FILE) —
#   never a faked HOME, never the live matrix.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command
#   gates pass/fail. Every assertion `return 1`s on mismatch, so EACH one
#   independently fails the test.

HOOK_SH="${BATS_TEST_DIRNAME}/../validate-compliance-matrix.sh"

setup() {
  [[ -x "${HOOK_SH}" ]] || skip "hook not executable: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"

  MATRIX="${BATS_TEST_TMPDIR}/core-compliance-matrix.md"
  REGISTRY="${BATS_TEST_TMPDIR}/agent-registry.json"
  RULES_DIR="${BATS_TEST_TMPDIR}/rules"
  SCOPED_DIR="${BATS_TEST_TMPDIR}/scoped"
  mkdir -p "${RULES_DIR}" "${SCOPED_DIR}"
  # Layer A's declared set is the matrix's rule-file rows; keep the filesystem in
  # sync so Layer A stays quiet unless a test perturbs it deliberately.
  : >"${RULES_DIR}/core-security.md"

  write_matrix "glass-atrium-dev-shell, glass-atrium-dev-python"
  write_registry glass-atrium-dev-shell glass-atrium-dev-python
}

# A structurally valid matrix: Tier-1 list (Layer B1), Scope Legend carrying the
# DEV agent cell $1 plus all three non-agent shapes (AC3), and a Compliance
# Matrix table whose columns are legal legend scopes.
write_matrix() {
  local dev_agents="${1}"
  cat >"${MATRIX}" <<EOF
# Rule-to-Agent Compliance Matrix

### Tier 1 — Core

- \`rules/glass-atrium/core-security.md\`

## Scope Legend

| Scope | Agents |
|-------|--------|
| ALL | All agents |
| DEV | ${dev_agents} |
| ~~DATA~~ | All DATA agents archived; scope inactive — see Archived Agents section |
| ORCHESTRATOR | Global agent / coordinator |

## Compliance Matrix

| Rule File | ALL | DEV |
|-----------|-----|-----|
| core-security.md | ✓ | |
EOF
}

write_registry() {
  local name
  printf '{\n  "agents": {\n' >"${REGISTRY}"
  local first=1
  for name in "$@"; do
    if [[ "${first}" -eq 1 ]]; then first=0; else printf ',\n' >>"${REGISTRY}"; fi
    printf '    "%s": {"scope": "DEV"}' "${name}" >>"${REGISTRY}"
  done
  printf '\n  }\n}\n' >>"${REGISTRY}"
}

# Invoke the hook with every input pinned into the per-test tmpdir. Extra args
# (e.g. --roster-check) are forwarded.
run_hook() {
  COMPLIANCE_MATRIX_FILE="${MATRIX}" \
    COMPLIANCE_REGISTRY_FILE="${REGISTRY}" \
    COMPLIANCE_RULES_DIR="${RULES_DIR}" \
    COMPLIANCE_SCOPED_DIR="${SCOPED_DIR}" \
    "${HOOK_SH}" "$@" </dev/null 2>&1
}

# STDERR-only variant. The fail-open advisories are a stderr-channel contract, so
# the cases that pin them capture stderr alone (2>&1 first, then stdout to null).
run_hook_stderr() {
  COMPLIANCE_MATRIX_FILE="${MATRIX}" \
    COMPLIANCE_REGISTRY_FILE="${REGISTRY}" \
    COMPLIANCE_RULES_DIR="${RULES_DIR}" \
    COMPLIANCE_SCOPED_DIR="${SCOPED_DIR}" \
    "${HOOK_SH}" "$@" </dev/null 2>&1 1>/dev/null
}

# ── AC1 / AC2 — mismatch is named, exit 2 ──────────────────────────────────────

@test "AC1 registered-but-unlisted agent is named and exits 2" {
  write_registry glass-atrium-dev-shell glass-atrium-dev-python glass-atrium-dev-ghost

  run run_hook --roster-check
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"registered-but-unlisted: glass-atrium-dev-ghost"* ]] || {
    echo "agent not named: ${output}"
    return 1
  }
}

@test "AC2 listed-but-unregistered agent is named and exits 2" {
  write_matrix "glass-atrium-dev-shell, glass-atrium-dev-python, glass-atrium-dev-retired"

  run run_hook --roster-check
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"listed-but-unregistered: glass-atrium-dev-retired"* ]] || {
    echo "agent not named: ${output}"
    return 1
  }
}

# ── AC3 — non-agent legend content is never a mismatch ─────────────────────────

@test "AC3 non-agent literals and the archived struck-through row report nothing" {
  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" != *"All agents"* ]] || {
    echo "the ALL literal leaked into the report: ${output}"
    return 1
  }
  [[ "${output}" != *"Global agent"* ]] || {
    echo "the ORCHESTRATOR literal leaked into the report: ${output}"
    return 1
  }
  [[ "${output}" != *"Archived"* ]] || {
    echo "the archived row leaked into the report: ${output}"
    return 1
  }
}

@test "AC3 an agent name in the archived row's prose is still shape-filtered out" {
  # The archived row is free prose a blocklist would have to chase; the positive
  # shape predicate only takes comma-separated tokens that ARE agent names, so a
  # name embedded in a sentence is not extracted.
  cat >"${MATRIX}" <<'EOF'
# Matrix

## Scope Legend

| Scope | Agents |
|-------|--------|
| DEV | glass-atrium-dev-shell, glass-atrium-dev-python |
| ~~DATA~~ | archived: glass-atrium-data-etl was retired here |
EOF

  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" != *"glass-atrium-data-etl"* ]] || {
    echo "prose-embedded name was extracted: ${output}"
    return 1
  }
}

# ── AC4 — fail-open on unparseable structure ───────────────────────────────────

@test "AC4 an absent Scope Legend section fails open with an advisory note" {
  printf '# Matrix\n\nno legend section at all\n' >"${MATRIX}"

  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"fail-open"* && "${output}" == *"Scope Legend roster unparseable"* ]] || {
    echo "advisory note missing: ${output}"
    return 1
  }
}

@test "AC4 a reshaped legend table (no agent column) fails open, never reports every agent" {
  cat >"${MATRIX}" <<'EOF'
# Matrix

## Scope Legend

| Scope |
|-------|
| DEV |
EOF

  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" != *"registered-but-unlisted"* ]] || {
    echo "empty extraction was read as 'every agent missing': ${output}"
    return 1
  }
}

@test "AC4 a malformed registry JSON fails open with an advisory note" {
  printf '{ this is not json\n' >"${REGISTRY}"

  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"registry roster unparseable"* ]] || {
    echo "advisory note missing: ${output}"
    return 1
  }
}

@test "AC4 an absent matrix in --roster-check is named absent, not merely unreadable" {
  MATRIX="${BATS_TEST_TMPDIR}/absent-matrix.md"

  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"[compliance-matrix-roster] fail-open: matrix file absent"* ]] || {
    echo "absence advisory missing: ${output}"
    return 1
  }
}

@test "AC4 an unreadable registry path fails open with an advisory note" {
  REGISTRY="${BATS_TEST_TMPDIR}/absent-registry.json"

  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"registry unreadable"* ]] || {
    echo "advisory note missing: ${output}"
    return 1
  }
}

# ── AC5 — agreement is silent ──────────────────────────────────────────────────

@test "AC5 registry and legend in agreement exits 0 with an empty report" {
  run run_hook --roster-check
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}"
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "expected no report, got: ${output}"
    return 1
  }
}

# ── AC6 — status merge across the three exit points ────────────────────────────

# Drop the ALL-column ✓ from the Tier-1 rule row: a CONFIRMED Layer B (B1) fault
# with the roster left in agreement.
break_layer_b() {
  local tmp="${BATS_TEST_TMPDIR}/matrix-b1.md"
  sed 's/^| core-security.md | ✓ | |$/| core-security.md |  | |/' "${MATRIX}" >"${tmp}"
  mv "${tmp}" "${MATRIX}"
}

@test "AC6 a Layer B fault survives a clean Layer C at the Layer-A-OK exit point" {
  break_layer_b

  run run_hook
  [[ "${status}" -eq 2 ]] || {
    echo "Layer B status clobbered: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"lost its ALL-column"* ]] || {
    echo "B1 finding missing: ${output}"
    return 1
  }
  [[ "${output}" == *"[compliance-matrix-drift] OK"* ]] || {
    echo "expected the Layer A OK exit point: ${output}"
    return 1
  }
}

@test "AC6 a Layer B fault survives a clean Layer C at the rules-dir-missing exit point" {
  break_layer_b
  RULES_DIR="${BATS_TEST_TMPDIR}/no-such-rules-dir"

  run run_hook
  [[ "${status}" -eq 2 ]] || {
    echo "Layer B status clobbered: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"rules dir missing"* ]] || {
    echo "expected the rules-dir-missing exit point: ${output}"
    return 1
  }
}

@test "AC6 a Layer B fault survives a clean Layer C at the drift-report exit point" {
  break_layer_b
  : >"${RULES_DIR}/undeclared-extra.md"

  run run_hook
  [[ "${status}" -eq 2 ]] || {
    echo "Layer B status clobbered: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"undeclared-present: undeclared-extra.md"* ]] || {
    echo "expected the drift-report exit point: ${output}"
    return 1
  }
}

@test "AC6 a Layer C mismatch exits 2 through the full run when Layer B is clean" {
  write_registry glass-atrium-dev-shell glass-atrium-dev-python glass-atrium-dev-ghost

  run run_hook
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"registered-but-unlisted: glass-atrium-dev-ghost"* ]] || {
    echo "Layer C finding missing: ${output}"
    return 1
  }
  [[ "${output}" != *"CONFIRMED inconsistency"* ]] || {
    echo "Layer B unexpectedly fired: ${output}"
    return 1
  }
}

# ── AC7 — the two pre-existing layers behave unchanged ─────────────────────────

@test "AC7 a clean matrix exits 0 with the Layer A OK banner" {
  run run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"[compliance-matrix-drift] OK"* ]] || {
    echo "Layer A banner missing: ${output}"
    return 1
  }
}

@test "AC7 Layer A still reports declared-missing and undeclared-present" {
  rm -f "${RULES_DIR}/core-security.md"
  : >"${RULES_DIR}/undeclared-extra.md"

  run run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "Layer A must stay advisory: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"declared-missing: core-security.md"* ]] || {
    echo "declared-missing missing: ${output}"
    return 1
  }
  [[ "${output}" == *"undeclared-present: undeclared-extra.md"* ]] || {
    echo "undeclared-present missing: ${output}"
    return 1
  }
}

@test "AC7 Layer B still fails open on an unparseable Compliance Matrix table" {
  # Legend intact (Layer C parses), Compliance Matrix table removed.
  write_matrix "glass-atrium-dev-shell, glass-atrium-dev-python"
  local tmp="${BATS_TEST_TMPDIR}/matrix-noB.md"
  sed '/^## Compliance Matrix$/,$d' "${MATRIX}" >"${tmp}"
  mv "${tmp}" "${MATRIX}"

  run run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "Layer B fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"matrix table unparseable"* ]] || {
    echo "Layer B advisory note missing: ${output}"
    return 1
  }
}

@test "AC7 an unreadable matrix still short-circuits to exit 0" {
  MATRIX="${BATS_TEST_TMPDIR}/absent-matrix.md"

  run run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"matrix file unreadable"* ]] || {
    echo "guard note missing: ${output}"
    return 1
  }
}

@test "AC7 an absent matrix emits BOTH enforcement layers' advisories on stderr" {
  # The guard short-circuits ahead of Layer B and Layer C, so neither reaches its
  # own fail-open note — the operator signal exists only if the guard speaks for
  # both. Exit stays 0: this pins the ADVISORY, never a new blocking path.
  MATRIX="${BATS_TEST_TMPDIR}/absent-matrix.md"

  run run_hook_stderr
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"[compliance-matrix-consistency] fail-open: matrix file absent"* ]] || {
    echo "Layer B absence advisory missing from stderr: ${output}"
    return 1
  }
  [[ "${output}" == *"[compliance-matrix-roster] fail-open: matrix file absent"* ]] || {
    echo "Layer C absence advisory missing from stderr: ${output}"
    return 1
  }
}

@test "AC7 a present-but-unreadable matrix is named unreadable, not absent" {
  # The two are different operator situations (vanished file vs permission
  # fault); the advisory distinguishes them.
  if [[ "$(id -u)" -eq 0 ]]; then
    skip "running as root: any file mode is readable"
  fi
  chmod 000 "${MATRIX}"

  run run_hook_stderr
  [[ "${status}" -eq 0 ]] || {
    echo "fail-open broken: exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"matrix file unreadable"* ]] || {
    echo "unreadable advisory missing: ${output}"
    return 1
  }
  [[ "${output}" != *"matrix file absent"* ]] || {
    echo "a present file was reported absent: ${output}"
    return 1
  }
}

# ── AC8 — documented exemptions stay out of the Layer A drift report ───────────

# The hook's exemption list, read from its own source. Deriving it keeps this
# suite from re-declaring a second copy that could drift from the first.
_exempt_files() {
  sed -n 's/^readonly EXEMPT_FILES="\(.*\)"$/\1/p' "${HOOK_SH}" \
    | tr ',' '\n' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d'
}

# The `undeclared-present:` field alone. Matching the whole output would read the
# banner prefix and any advisory naming the matrix PATH as a report hit.
_undeclared_field() {
  printf '%s\n' "${output}" | grep -F 'undeclared-present:' || true
}

# The positive control both AC8 cases seed: a genuinely undeclared file that MUST
# be reported, so an empty drift report cannot pass either test. `$1` is the
# `undeclared-present:` field.
_assert_control_reported() {
  [[ "${1}" == *"undeclared-extra.md"* ]] || {
    echo "control file unreported — the drift scan is not running: ${output}"
    return 1
  }
}

@test "AC8 the injection-text source is exempt, so Layer A stops reporting it" {
  # Behavioural, not a list assertion: the file is seeded where the live one
  # lives and left out of the matrix, which is exactly the standing advisory
  # this exemption closes. Dropping it from EXEMPT_FILES turns this red.
  : >"${SCOPED_DIR}/shared-turn-budget.md"
  # Positive control in the same run — an empty report must not pass this test.
  : >"${RULES_DIR}/undeclared-extra.md"

  run run_hook
  local field
  field="$(_undeclared_field)"
  _assert_control_reported "${field}" || return 1
  [[ "${field}" != *"shared-turn-budget.md"* ]] || {
    echo "an exempt file surfaced in the drift report: ${field}"
    return 1
  }
}

@test "AC8 no file on the exemption list reaches undeclared-present" {
  local exempt name field missing=""
  exempt="$(_exempt_files)"
  [[ -n "${exempt}" ]] || {
    echo "no EXEMPT_FILES parsed from ${HOOK_SH} — the parser lost its anchor"
    return 1
  }
  # Basenames are subtracted AFTER the rules/scoped union, so the seeding dir is
  # immaterial to the verdict; scoped/ is used because that is where the live
  # standing advisory came from.
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    : >"${SCOPED_DIR}/${name}"
  done <<<"${exempt}"
  : >"${RULES_DIR}/undeclared-extra.md"

  run run_hook
  field="$(_undeclared_field)"
  _assert_control_reported "${field}" || return 1
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    case "${field}" in
      *"${name}"*) missing="${missing}${name} " ;;
      *) ;;
    esac
  done <<<"${exempt}"
  [[ -z "${missing}" ]] || {
    echo "exempt file(s) reported as undeclared-present: ${missing}— ${field}"
    return 1
  }
}
