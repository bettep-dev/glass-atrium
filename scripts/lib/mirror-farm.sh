#!/usr/bin/env bash
# File-wide: SC2310/SC2311 (function in a condition / command substitution
# disables or masks set -e) and SC2312 (command substitution masks a return
# value) are --enable=all INFO checks that flag the DELIBERATE strict-mode guard
# idioms this lib uses (stdout-verdict helpers, `func || rc=$?` capture, bounded
# `find | head` scans) — the same scoping the sibling source scripts/update.sh
# documents. Every warning/error-severity finding is still surfaced.
# shellcheck disable=SC2310,SC2311,SC2312
#
# mirror-farm.sh — shared facade mirror-farm refresh wrapper (incident #58325
# systemic fix). Sourced by install.sh (reinstall parity), scripts/update.sh
# (post-apply refresh), and scripts/generate-manifest.sh (maintainer flow); the
# sourcing script owns strict mode + the ERR trap.
#
# Problem this closes: the ~/.claude per-file symlink facade was created ONCE at
# install (lib/ga-core.sh run_symlink_farm) and re-run only by the agent_lifecycle
# CLI after an agent add/delete — every OTHER new manifest file shipped WITHOUT its
# mirror until hand-linked (incident #58325: scripts/lib/apply-lock.sh had no
# mirror → daemon FATALed). This lib gives install / update / manifest-regen flows
# ONE shared, probe-guarded way to re-run the farm so a new file never again ships
# unmirrored.
#
# Mechanism REUSE, not reimplementation: the refresh shells out to the CANONICAL
# sync entrypoint `<ga_root>/glass-atrium agents-only` (run_agents_only →
# run_symlink_farm → swap_symlink), so the scope rule, idempotency, the atomic
# ln-into-temp + rename swap, the collision / foreign-symlink / real-user-file
# refusals, and the NEVER_TOUCH guards all stay in lib/ga-core.sh — swap semantics
# change in ONE place. Subprocess by design (agent_lifecycle subproc.py precedent):
# sourcing ga-core.sh in-process would collide with the caller (readonly
# GA_ROOT/TARGET_HOME + bare log()/die()).
#
# Stale-mirror REMOVAL stays OUT of the automatic path: run_prune is explicit
# opt-in by ga-core.sh design (4-criteria: symlink + GA-target + broken +
# not-in-manifest); farm_prune_advisory surfaces a --dry-run report only —
# auto-delete is a separate governance decision.
#
# Sandbox seams (inherited by the launcher subprocess): GA_TARGET_HOME pins the
# facade home, GA_MANIFEST (farm_refresh $2) pins the scope manifest, so a
# hermetic test never touches the real ~/.claude.

# leaf logging (stderr only; mirrors apply-lock.sh's `[apply-lock]` prefix).
farm_log() { printf '[mirror-farm] %s\n' "$*" >&2; }

# Echo the facade home the farm writes into — the engine's own TARGET_HOME
# precedence (GA_TARGET_HOME sandbox override -> ~/.claude).
farm_target_home() {
  printf '%s\n' "${GA_TARGET_HOME:-${HOME}/.claude}"
}

# Echo "yes" when facade home $1 already holds a symlink pointing into GA root
# $2 (existing-deployment signal), else "no" — the doctor §5
# `find -type l -lname GA/*` idiom, -prune'd on the heavy user-owned dirs no
# manifest path ever lives under (never-touch set + data/wiki/logs) and cut at
# the FIRST hit. Stdout-verdict (always exits 0) so strict-mode callers use it
# in $( ) freely — mirrors ga-core.sh is_never_touch / is_symlink_excluded.
farm_has_ga_links() {
  local home="$1" ga_root="$2" hit=""
  if [[ -d "${home}" ]]; then
    # 2>/dev/null hides expected permission noise only — the verdict still
    # branches on the result (not a swallowed precondition). `head -n 1` bounds
    # the scan at the first hit (portable — no reliance on find -quit); the
    # `|| true` absorbs head's benign early-close SIGPIPE under pipefail.
    hit="$(find "${home}" \
      \( -path "${home}/projects" -o -path "${home}/todos" \
      -o -path "${home}/shell-snapshots" -o -path "${home}/ide" \
      -o -path "${home}/data" -o -path "${home}/wiki" \
      -o -path "${home}/logs" \) -prune \
      -o -type l -lname "${ga_root}/*" -print 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -n "${hit}" ]]; then printf 'yes\n'; else printf 'no\n'; fi
}

# Refresh the facade mirror farm for GA root $1 via the canonical entrypoint,
# optionally scoped to manifest $2 (GA_MANIFEST override — the update flow
# passes a source-present FILTERED manifest, see farm_write_present_manifest;
# empty/omitted -> the launcher's default <ga_root>/manifest.json).
# rc contract (callers translate to their own named exit codes; invoke as
# `farm_refresh ... || rc=$?` under set -e):
#   0 = farm ran to completion (mirrors created / verified idempotently)
#   3 = cleanly SKIPPED — facade home absent (consumer machine without a
#       facade) or launcher missing; both logged, never silent
#   1 = the farm subprocess FAILED (unwritable facade / manifest source
#       missing / user-file refusal) — files a caller already applied STAY
#       applied; no rollback is attempted here
farm_refresh() {
  local ga_root="$1" manifest="${2:-}" home launcher
  home="$(farm_target_home)"
  if [[ ! -d "${home}" ]]; then
    farm_log "facade home absent (${home}) — mirror refresh skipped (no facade on this machine)"
    return 3
  fi
  launcher="${ga_root}/glass-atrium"
  if [[ ! -x "${launcher}" ]]; then
    farm_log "WARN: launcher missing or not executable (${launcher}) — mirror refresh skipped; repair the install, then run '${launcher} agents-only'"
    return 3
  fi
  farm_log "refreshing facade mirrors (target=${home}): ${launcher} agents-only"
  if [[ -n "${manifest}" ]]; then
    GA_MANIFEST="${manifest}" "${launcher}" agents-only || return 1
  else
    "${launcher}" agents-only || return 1
  fi
}

# Write to $3 a {version, files} manifest copying $2 with .files FILTERED to
# entries whose source exists under GA root $1, WARN-listing each absent one.
# Update-context guard: a release file the sensitive partition REFUSED to sync (or
# a rolled-back apply) is in the new manifest but missing from the tree —
# unfiltered, swap_symlink would loud-die "manifest source missing" and hard-fail
# EVERY update until manual review. Warn+skip is the update contract (the doctor §4
# check still reports the gap). Output is a per-run scratch scope (hashes dropped),
# NEVER the persisted root manifest. rc 1 on jq/manifest/write failure.
farm_write_present_manifest() {
  local ga_root="$1" src="$2" out="$3" rel version missing=0 kept=0
  local present_list=""
  if ! command -v jq >/dev/null 2>&1; then
    farm_log "ERROR: jq required to filter ${src}"
    return 1
  fi
  if ! jq -e '.files | type == "array"' -- "${src}" >/dev/null 2>&1; then
    farm_log "ERROR: manifest absent or .files not an array: ${src}"
    return 1
  fi
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    if [[ -e "${ga_root}/${rel}" ]]; then
      present_list="${present_list}${rel}"$'\n'
      kept=$((kept + 1))
    else
      farm_log "WARN: manifest source missing under ${ga_root} (sensitive-refused or unapplied) — mirror skipped: ${rel}"
      missing=$((missing + 1))
    fi
  done < <(jq -r '.files[]' -- "${src}")
  version="$(jq -r '.version // "unknown"' -- "${src}" 2>/dev/null || printf 'unknown\n')"
  if ! printf '%s' "${present_list}" \
    | jq -R . \
    | jq -s --arg ver "${version}" '{version: $ver, files: .}' >"${out}"; then
    farm_log "ERROR: could not write the filtered farm manifest: ${out}"
    return 1
  fi
  if [[ "${missing}" -gt 0 ]]; then
    farm_log "WARN: ${missing} of $((kept + missing)) manifest entries have no source — their mirrors were NOT refreshed this run"
  fi
  return 0
}

# Post-refresh orphan-mirror ADVISORY for GA root $1: report (never remove)
# dangling GA-pointing mirrors via the engine's 4-criteria prune in --dry-run.
# Prune stays explicit-opt-in (ga-core.sh design) — auto-delete on a routine
# flow is a governance decision this lib deliberately does not take.
# Best-effort: a failure is WARNed, never propagated (always returns 0).
farm_prune_advisory() {
  local ga_root="$1" launcher
  launcher="${ga_root}/glass-atrium"
  [[ -x "${launcher}" ]] || return 0
  "${launcher}" --dry-run prune \
    || farm_log "WARN: prune --dry-run advisory failed (non-fatal) — review orphan mirrors with '${launcher} --dry-run prune'"
}
