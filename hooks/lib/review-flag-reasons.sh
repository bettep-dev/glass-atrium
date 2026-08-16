#!/usr/bin/env bash
# review-flag-reasons.sh — review_flag reason-token registry + carrier helpers. Declaration-only
# (plus three small helpers), sourced by track-outcome.sh and lib/style-ref-consts.sh so the
# vocabulary has exactly one declaration. Bash 3.2+ (macOS stock).
#
# REVIEW_FLAG_REASON_TOKENS   — the token vocabulary (monitor label map asserted a superset of it).
# review_flag_add_reason      — append one token to the caller-scope carrier.
# review_flag_finalize_reasons— final guard: flag false ⇒ carrier empty.
# agent_registry_has          — registry membership, fail-open.

# Double-source guard.
if [[ -n "${_REVIEW_FLAG_REASONS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _REVIEW_FLAG_REASONS_LOADED=1

# Bash 3.2 has no associative arrays; a space-separated literal keeps the vocabulary greppable
# from the shell setters, the bats pins and the monitor consistency assertion alike.
# shellcheck disable=SC2034
#   REVIEW_FLAG_REASON_TOKENS is read by the source-er — an intended export of this file.
readonly REVIEW_FLAG_REASON_TOKENS='overconfidence underconfidence empty-metric degraded-attribution-derived degraded-attribution-synthesized grader-contradiction correction-gap correction-disagreement non-registry-agent-at-write probe-omission unregistered-agent-probe-exempt scope-excess'

# The attribution channels a WRITER emitted a complete [COMPLETION] block on — the ONLY rows a
# writer-side omission may be held against. Space-padded, one declaration for every consumer.
# The synthesis and truncation channels have no complete writer emission to hold responsible and
# the instrumentation channels have no writer at all, so both stay out by contract.
# shellcheck disable=SC2034
#   WRITER_ATTRIBUTION_SOURCES is read by the source-er — an intended export of this file.
readonly WRITER_ATTRIBUTION_SOURCES=' hook-input cron-derived structuredoutput-completion '

# The complement this file owns: channels whose row exists WITHOUT a writer emission, so the row
# reads healthy (confidence=low + metric_pass=false) while nothing was self-reported. Membership
# is declared here; the per-channel provenance token is stamped at the recorder trigger.
# shellcheck disable=SC2034
#   DEGRADED_ATTRIBUTION_SOURCES is read by the source-er — an intended export of this file.
readonly DEGRADED_ATTRIBUTION_SOURCES=' structuredoutput-derived completion-synthesized '

# Membership in a space-padded channel set. Padding blocks a name-fragment match.
attribution_in_set() {
  local value="${1:-}" set_literal="${2:-}"
  [[ -n "${value}" ]] || return 1
  case "${set_literal}" in
    *" ${value} "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Caller-scope: reads/writes REVIEW_FLAG_REASONS (comma-joined, deduplicated — the dual-write seam
# splits it into the text[] carrier column).
review_flag_add_reason() {
  local token="${1:-}"
  [[ -n "${token}" ]] || return 0
  case ",${REVIEW_FLAG_REASONS:-}," in
    *",${token},"*) return 0 ;;
    *) ;;
  esac
  if [[ -z "${REVIEW_FLAG_REASONS:-}" ]]; then
    REVIEW_FLAG_REASONS="${token}"
  else
    REVIEW_FLAG_REASONS="${REVIEW_FLAG_REASONS},${token}"
  fi
}

# Carrier-emptiness invariant enforced as a FINAL guard rather than by setter ordering — the
# polar-mismatch block re-initialises the flag mid-sequence, so an ordering-based invariant is
# unstable. Call once after every setter has run.
review_flag_finalize_reasons() {
  # shellcheck disable=SC2034
  #   REVIEW_FLAG_REASONS is read by the caller's PG envelope.
  [[ "${REVIEW_FLAG:-false}" = "true" ]] || REVIEW_FLAG_REASONS=""
}

# Registry membership — a key lookup under the registry file's agents object, never its root.
# Fail-OPEN by contract: an absent, unreadable or malformed registry returns success (validation
# skipped), so a registry outage never re-attributes, flags or drops a row.
agent_registry_has() {
  local name="${1:-}" registry probe
  [[ -n "${name}" ]] || return 0
  registry="${CLAUDE_AGENT_REGISTRY_FILE:-${HOME}/.glass-atrium/agent-registry.json}"
  [[ -r "${registry}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  probe="$(jq -r --arg n "${name}" \
    'if (.agents | type) == "object" then (if (.agents | has($n)) then "yes" else "no" end) else "skip" end' \
    "${registry}" 2>/dev/null || true)" # GA-ABSORB[benign]: malformed registry ⇒ empty probe ⇒ fail-open below
  [[ "${probe}" = "no" ]] && return 1
  return 0
}
