#!/usr/bin/env bash
# styleref-roster.sh — the STYLEREF_AGENTS roster, declared once. Declaration-only, sourced by
# inject-scope-rules.sh (which agents receive the Project Convention Probe block) and by
# lib/style-ref-consts.sh (which agents the omission flag may hold responsible), so the delivered
# set and the responsible set cannot drift apart. Bash 3.2+ (macOS stock).
#
# Reconciled by agent_lifecycle sync-inject as one of the five tracked arrays: the writer edits
# THIS file for STYLEREF_AGENTS and inject-scope-rules.sh for the other four.

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
