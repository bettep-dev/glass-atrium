#!/usr/bin/env bash
# styleref-roster.sh — the STYLEREF_AGENTS roster, declared once. Declaration-only, sourced by
# lib/style-ref-consts.sh: the agents that receive scoped/scope-dev.md (Project Convention Probe)
# through registry membership, so the style_ref omission flag may hold them responsible. Not an
# injection roster — the set equals the registry rows whose rules.scope is scoped/scope-dev.md.
# Bash 3.2+ (macOS stock).
#
# Reconciled by agent_lifecycle sync-inject as one of its tracked arrays: the writer edits THIS
# file for STYLEREF_AGENTS and inject-scope-rules.sh for BUDGET_DEV_AGENTS.

# Double-source guard.
if [[ -n "${_STYLEREF_ROSTER_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _STYLEREF_ROSTER_LOADED=1

# style_ref scope-match — DEV ONLY (style_ref is DEV-scoped; QA excluded). Space-padded so a
# membership test cannot match a name fragment.
# shellcheck disable=SC2034
#   STYLEREF_AGENTS is read by the source-er — an intended export of this declaration-only file.
readonly STYLEREF_AGENTS=" glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-dev-swift "
