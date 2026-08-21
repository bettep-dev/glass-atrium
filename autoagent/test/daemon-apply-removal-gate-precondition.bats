#!/usr/bin/env bats
# daemon-apply-removal-gate-precondition.bats — artifact assertion for the
# removal gate's precondition.
#
# `assert_removal_evidence` refuses a live removal unless it can see an
# editable-region marker check inside `verify_patched`, and it looks by
# introspection: `declare -f verify_patched | grep -q 'EDITABLE:BEGIN'`. That
# coupling is invisible to every other suite — nothing calls the check, so a
# rename of the verify function or a move of the marker loop into a helper
# leaves the deletion power armed while the guard that detects a wrong deletion
# is no longer reachable by the string the gate greps for.
#
# What is pinned:
#   * the live tree satisfies the precondition — the gate is reached, finds the
#     marker string, and passes through to the dry-run report.
#   * a renamed verify function trips it.
#   * a marker loop lifted into a helper, behaviour unchanged, trips it too.
#
# POLARITY: each negative probe asserts the SPECIFIC
# `FATAL removal_gate_precondition` line, not a non-zero exit — the driven
# function returns 1 on several unrelated paths, so an exit-status assertion is
# satisfied by a typo in the probe. Both negatives share this file with the
# positive control, so a driver that FATALs unconditionally reddens the control.
#
# HERMETIC: the two functions are extracted and driven in isolation with the
# python evidence call, the log sink and the JSON helpers stubbed. No live PG,
# no live install, no live agents dir, no python.
#
# Run via: bats autoagent/test/daemon-apply-removal-gate-precondition.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

# The anchor line the helper-lift mutation replaces. Asserted present before the
# mutation runs, so an edit that moves it reddens this suite by name instead of
# turning the probe into a no-op that reads as a passing negative.
LIFT_ANCHOR='    local marker before_markers after_markers'

setup() {
  [[ -r "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not readable: ${REAL_SCRIPT}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-removal-precondition.XXXXXX)" && pwd -P)"

  # Extract the gate and the function it introspects — each header line through
  # its own first column-0 close brace. daemon-apply.sh runs top-level code and
  # is not sourceable.
  SNIPPET="${WORK}/gate.sh"
  awk '/^(assert_removal_evidence|verify_patched)\(\)[[:space:]]*\{/ { f = 1 }
       f { print }
       f && /^\}/ { f = 0 }' "${REAL_SCRIPT}" >"${SNIPPET}"
  grep -q '^assert_removal_evidence() {' "${SNIPPET}" \
    || skip "could not extract assert_removal_evidence from daemon-apply.sh"
  grep -q '^verify_patched() {' "${SNIPPET}" \
    || skip "could not extract verify_patched from daemon-apply.sh"

  # The driver: stub the gate's collaborators, source the extraction, and call
  # the gate. The python stub returns an `ok` verdict with the live flag OFF, so
  # a gate that clears its precondition lands on the dry-run report — a
  # side-effect-free path that still proves the marker check was satisfied.
  DRIVER="${WORK}/drive.sh"
  cat >"${DRIVER}" <<'DRIVE'
set -uo pipefail
DAEMON_CYCLE_PY="/nonexistent/daemon_cycle.py"
ts_now_json() { printf '0'; }
json_escape() { printf '"stub"'; }
emit_log() { :; }
python3() { printf 'ok\t0\t1\ndeclared removal line\n'; }
source "${SNIP}"
assert_removal_evidence "/nonexistent/target.md" "diff body" "probe-label" "probe-target.md"
printf 'verdict=%s\n' "${REMOVAL_VERDICT}"
DRIVE
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# drive SNIPPET — run the gate against one extraction. stdout and stderr are
# merged into ${output} because the FATAL line the probes assert goes to stderr.
drive() {
  run env SNIP="$1" bash "${DRIVER}" 2>&1
}

FATAL_LINE='FATAL removal_gate_precondition'

# --- positive control ------------------------------------------------------

@test "the live verify_patched satisfies the gate's precondition" {
  drive "${SNIPPET}"
  [[ "${output}" != *"${FATAL_LINE}"* ]] || {
    echo "the unmutated tree tripped the precondition: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"verdict=dry_run"* ]] || {
    echo "the gate did not reach its dry-run report, so nothing proves the precondition passed: ${output}" >&2
    return 1
  }
}

# --- negative probes -------------------------------------------------------

@test "renaming verify_patched trips the precondition" {
  local renamed="${WORK}/renamed.sh"
  sed 's/^verify_patched() {/verify_patched_renamed() {/' "${SNIPPET}" >"${renamed}"
  grep -q '^verify_patched_renamed() {' "${renamed}" || {
    echo "the rename mutation did not apply, so this probe would assert nothing" >&2
    return 1
  }

  drive "${renamed}"
  [[ "${output}" == *"${FATAL_LINE}"* ]] || {
    echo "a renamed verify function must trip the precondition loudly: ${output}" >&2
    return 1
  }
}

@test "lifting the marker loop into a helper trips the precondition" {
  grep -qF "${LIFT_ANCHOR}" "${SNIPPET}" || {
    echo "the lift anchor is gone from verify_patched; re-derive it before trusting this probe" >&2
    return 1
  }

  # Move the marker loop verbatim into a helper verify_patched calls. Behaviour
  # is preserved and only the loop's home changes — which is the whole point:
  # the check still runs, and the gate can no longer see it.
  local lifted="${WORK}/lifted.sh" helper="${WORK}/helper.sh"
  awk -v helper="${helper}" -v anchor="${LIFT_ANCHOR}" '
    $0 == anchor {
      print "    verify_marker_counts \"${before}\" \"${target}\" || return 1"
      print "verify_marker_counts() {" > helper
      print "    local before=\"$1\" target=\"$2\"" > helper
      print $0 > helper
      inlift = 1
      next
    }
    inlift {
      print $0 > helper
      if ($0 == "    done") { print "}" > helper; inlift = 0 }
      next
    }
    { print }
  ' "${SNIPPET}" >"${lifted}"
  cat "${helper}" >>"${lifted}"

  bash -n "${lifted}" || {
    echo "the lift mutation produced unparseable shell, so the probe proves nothing" >&2
    return 1
  }
  grep -q 'EDITABLE:BEGIN' "${helper}" || {
    echo "the lift did not carry the marker loop into the helper" >&2
    return 1
  }

  drive "${lifted}"
  [[ "${output}" == *"${FATAL_LINE}"* ]] || {
    echo "a marker check lifted out of verify_patched must trip the precondition loudly: ${output}" >&2
    return 1
  }
}
