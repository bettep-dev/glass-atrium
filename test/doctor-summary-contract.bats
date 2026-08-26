#!/usr/bin/env bats
# run_doctor warning-summary registration contract (lib/ga-doctor.sh): the warn total and the
# PASS breakdown MUST enumerate the same counters in the same order.
#
# Anchors are PATTERNS, never line numbers — several tasks edit lib/ga-doctor.sh above both
# expressions, so a pinned line number would silently make an unrelated line the contract.
# Counter DECLARATIONS are deliberately not scanned: run_doctor owns named counters that join
# neither expression on purpose (facet_unbound, nonexec, dangling, ga_links, deployed_count,
# registry_orphans), so a declaration census is red at HEAD.
#
# Run via: bats test/doctor-summary-contract.bats
# Requires: bats >= 1.5.0, bash 3.2+ (static read of one file — no doctor run, no sandbox)

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
DOCTOR="${GA}/lib/ga-doctor.sh"

SUM_ANCHOR='local warns=$(('
SUMMARY_ANCHOR='doctor: PASS (with'

# The 13 registered counters in participation order. Two suites anchor on this surface
# (recovery-snapshot-staleness.bats, doctor-launchd-deploy-drift.bats); appending a kind-A row to
# the tail is safe, renaming or reordering these is not.
REGISTERED_COUNTERS='unbound
drift
undeployed_fresh
inject_drop_warns
launchd_drift
snapshot_stale
snapshot_path_anomaly
data_sep_stale
channel_silent
channel_blind
registry_warns
arbiter_warns
retired_residue'

# Rows declared kind B (report-only) — promoting one to a counter is the regression. These are
# IDENTIFIER stems, not section titles: the check greps the operand and reference NAMES, so a
# token no identifier can carry asserts nothing (the retired `permission` was exactly that —
# section 20's names are all `perms_`). The fossil assertion pins each stem to a real name.
KIND_B_STEMS='perms
rewire
cfgkey'

# One synthetic operand per registered stem, in stem order — the promotion the guard must catch.
KIND_B_SYNTHETIC='perms_missing
rewire_pending
cfgkey_missing'

KIND_B_PATTERN="$(printf '%s\n' "${KIND_B_STEMS}" | tr '\n' '|' | sed 's/|$//')"

anchor_count() {
  grep -c -F -- "$1" "${DOCTOR}" || true
}

sum_operands() {
  local line
  line="$(grep -F -- "${SUM_ANCHOR}" "${DOCTOR}" | head -1)"
  line="${line#*\$((}"
  line="${line%%))*}"
  printf '%s\n' "${line}" | tr '+' '\n' | sed -e 's/[[:space:]]//g'
}

summary_refs() {
  grep -F -- "${SUMMARY_ANCHOR}" "${DOCTOR}" \
    | head -1 \
    | grep -o '\${[A-Za-z_][A-Za-z0-9_]*}' \
    | sed -e 's/^\${//' -e 's/}$//' \
    | grep -v '^warns$' || true
}

@test "anchor uniqueness: each contract pattern matches exactly once" {
  local sum_hits summary_hits
  sum_hits="$(anchor_count "${SUM_ANCHOR}")"
  summary_hits="$(anchor_count "${SUMMARY_ANCHOR}")"
  [[ "${sum_hits}" == "1" && "${summary_hits}" == "1" ]] || {
    printf 'AMBIGUOUS ANCHOR — sum matches=%s summary matches=%s (each MUST be 1)\n' \
      "${sum_hits}" "${summary_hits}" >&2
    return 1
  }
}

@test "parity: summary variable sequence equals the sum operand sequence" {
  local operands refs
  operands="$(sum_operands)"
  refs="$(summary_refs)"
  [[ -n "${operands}" ]] && [[ "${operands}" == "${refs}" ]] || {
    printf 'SUMMARY/TOTAL DRIFT\n--- sum operands ---\n%s\n--- summary refs ---\n%s\n' \
      "${operands}" "${refs}" >&2
    return 1
  }
}

@test "reader anchors: the 13 registered counters keep their names and order" {
  local operands head13
  operands="$(sum_operands)"
  head13="$(printf '%s\n' "${operands}" | head -13)"
  [[ "${head13}" == "${REGISTERED_COUNTERS}" ]] || {
    printf 'REGISTERED PREFIX CHANGED\n--- got ---\n%s\n--- expected ---\n%s\n' \
      "${head13}" "${REGISTERED_COUNTERS}" >&2
    return 1
  }
}

@test "kind B: report-only rows stay out of the warning surface" {
  local promoted
  promoted="$(printf '%s\n%s\n' "$(sum_operands)" "$(summary_refs)" \
    | grep -Ei -- "${KIND_B_PATTERN}" || true)"
  [[ -z "${promoted}" ]] || {
    printf 'KIND-B ROW PROMOTED TO A COUNTER: %s\n' "${promoted}" >&2
    return 1
  }
}

@test "kind B guard binds: a synthetic promotion of every registered stem is caught" {
  local unmatched stem_count synth_count
  unmatched="$(printf '%s\n' "${KIND_B_SYNTHETIC}" | grep -Eiv -- "${KIND_B_PATTERN}" || true)"
  [[ -z "${unmatched}" ]] || {
    printf 'REGISTERED STEM MATCHES NOT EVEN ITS OWN SYNTHETIC OPERAND: %s\n' "${unmatched}" >&2
    return 1
  }
  stem_count="$(printf '%s\n' "${KIND_B_STEMS}" | grep -c .)"
  synth_count="$(printf '%s\n' "${KIND_B_SYNTHETIC}" | grep -c .)"
  [[ "${stem_count}" == "${synth_count}" ]] || {
    printf 'SYNTHETIC LIST FELL BEHIND THE PATTERN — stems=%s synthetics=%s\n' \
      "${stem_count}" "${synth_count}" >&2
    return 1
  }
}

@test "kind B fossils: every registered stem exists as an identifier fragment in ga-doctor.sh" {
  local tokens stem missing=""
  tokens="$(grep -oE '[A-Za-z_][A-Za-z0-9_]*' "${DOCTOR}" | sort -u)"
  while IFS= read -r stem; do
    [[ -n "${stem}" ]] || continue
    printf '%s\n' "${tokens}" | grep -qF -- "${stem}" || missing="${missing}${stem} "
  done <<EOF
${KIND_B_STEMS}
EOF
  [[ -z "${missing}" ]] || {
    printf 'REGISTERED STEM WITH NO IDENTIFIER IN %s (row deleted or renamed): %s\n' \
      "${DOCTOR}" "${missing}" >&2
    return 1
  }
}
