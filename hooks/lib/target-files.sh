#!/usr/bin/env bash
# target-files.sh — the plan Target Files extractors, one definition for every reader: the drift
# advisory (validate-scope-drift.sh, SCOPE-070) and the delegation gate (enforce-delegation.sh,
# DEL-006). Kept out of lib/scope-match.sh, an A/A scope file (autoagent/daemon_cycle.py
# AA.SCOPE.FILES), so a change here leaves the A/A fingerprint alone.
# Requires drain_after (lib/pipe-drain.sh) in the sourcing shell. Bash 3.2+ (macOS stock).
#
# extract_target_files_section — html `<section id="target-files">` slice → newline list.
# extract_target_files_heading — md `## Target Files` list → its lines.

# Extract path-like tokens from the `<section id="target-files">` slice → newline list.
# Relies on the T1 flat-leaf contract (slices to the first </section>). sed-only (no awk).
# P1 nesting guard: a nested opening <section> in the slice violates the leaf contract → a
# truncated list could mis-fire SCOPE-070, so emit empty (fail-open, no guessing).
# Args: $1=html body. Prints cleaned list to stdout (empty on parse anomaly · always return 0).
extract_target_files_section() {
  local body="${1}"
  # Flatten to one line, then slice between opening tag and first </section>.
  local flattened from_open sliced
  flattened="$(printf '%s' "${body}" | tr '\n' ' ')"

  # After the opening tag (close not yet applied) — source for the nesting guard.
  from_open="$(printf '%s' "${flattened}" \
    | sed -n 's/.*<section[^>]*id="target-files"[^>]*>\(.*\)/\1/p')"
  [[ -z "${from_open}" ]] && return 0

  sliced="$(printf '%s' "${from_open}" | sed 's/<\/section>.*//')"
  [[ -z "${sliced}" ]] && return 0

  # P1 guard: nested opening <section> → leaf violation → fail-open.
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  if printf '%s' "${sliced}" | drain_after grep -q '<section[^>]*>'; then
    return 0
  fi

  # <li>/<br> → newlines (one item per line), then strip remaining tags + decode entities.
  # shellcheck disable=SC2312  # the sourcing hook runs under pipefail, so no stage's status is masked
  printf '%s' "${sliced}" \
    | sed 's/<li[^>]*>/\n/g; s/<\/li>/\n/g; s/<br[^>]*>/\n/g' \
    | sed 's/<[^>]*>//g' \
    | sed 's/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g'
}

# Extract the md `## Target Files` list, up to the next `## ` heading (case-insensitive initials,
# English-only). One definition for the PLAN_FILE leg and the monitor leg's md plans.
# Args: $1=md body. Prints the list to stdout (empty when the heading is absent).
extract_target_files_heading() {
  local heading_re='^##[[:space:]]+[Tt]arget [Ff]iles'
  printf '%s\n' "${1}" | sed -E -n "/${heading_re}/,/^## /{ /${heading_re}/d; /^## /d; p; }"
}
