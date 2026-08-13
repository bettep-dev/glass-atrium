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
readonly REVIEW_FLAG_REASON_TOKENS='overconfidence underconfidence empty-metric degraded-attribution-derived degraded-attribution-synthesized grader-contradiction correction-gap non-registry-agent-at-write probe-omission unregistered-agent-probe-exempt'

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
