#!/usr/bin/env bash
# glass-atrium-update — the user-triggered Glass Atrium updater (plan E3 / design
# C, task T09). This is the ADAPTER that ORCHESTRATES the already-built E3 spine
# libs; it is deliberately NOT a new merge engine and it NEVER writes
# core.autoagent_proposals (that surface belongs to the autoagent self-improvement
# loop, a different system). The binary subcommand `glass-atrium update` (T08)
# dispatches here.
#
# What it does, in order (each step builds on the previous):
#   1. WRITER-SERIALIZATION (T10): create the cooperative pause flag so the
#      launchd-live autoagent daemon SUSPENDS, acquire the daemon .apply-lock, and
#      refuse to start when HEAD is a mid-apply [WIP-AUTO] commit.
#   2. DOWNLOAD + STAGE (T04 transport): fetch the latest GitHub Release assets
#      (manifest.json + the hashed bundle) for config [release].repo and extract.
#   3. VERIFY: per-file SHA-256 of every changed file == manifest hashes[path]
#      (spine_stage_and_verify — loud-fail leaves the install untouched).
#   4. FOREGROUND CONFIRM (T12 / gate G3): a per-file unified-diff preview then a
#      single explicit y/N confirm; declining writes ZERO files (structural).
#   5. DETERMINISTIC NON-AGENT SYNC (T13): snapshot + swap + rollback via the
#      apply-spine (spine_commit_staged). Agent EDITABLE-region merge is EXCLUDED
#      here and left as a documented CALL SEAM for E4 (T17-T19).
#   6. BASELINE (T14 fns; T24 wiring seam): capture the applied manifest as the
#      base@install anchor for the next update's 3-anchor merge.
#   7. CLEANUP: a trap removes the pause flag and releases the lock on EVERY exit
#      path (success, decline, failure, SIGINT/SIGTERM).
#
# Sensitive-path refusal (T15 / gate G7): a sensitive harness file (GLOBAL_RULES,
# a security scope rule, a credential file, a launchd plist) is NEVER auto-synced
# by the deterministic path — it is partitioned OUT of the apply set via the
# shared python helper (autoagent/lib/sensitive_patterns.py, the SINGLE refusal
# source) and reported for manual review. The shell NEVER re-implements the
# refusal regex.
#
# Strict mode: this is an executable ENTRY POINT (unlike the sourced libs), so it
# sets strict mode itself. The sourced libs are written to be safe under it.
#
# Test seam: ATRIUM_UPDATE_SRC_DIR + ATRIUM_UPDATE_SRC_MANIFEST, when both set,
# bypass the gh download/extract (the new-release tree + manifest are supplied
# directly) so the apply pipeline is exercisable hermetically. Confirmation is
# injectable via ATRIUM_UPDATE_CONFIRM_ANSWER (the apply-gate's own seam).

set -Eeuo pipefail
IFS=$'\n\t'

# ---------------------------------------------------------------------------
# Resolution helpers (GA_ROOT-anchored, env-overridable for tests/sandboxes)
# ---------------------------------------------------------------------------

# Live install root. The same precedence as the sourced libs.
update_ga_root() {
  printf '%s\n' "${GA_ROOT:-${HOME}/.glass-atrium}"
}

# The autoagent daemon reports dir holding the shared .apply-lock — resolved with
# the SAME precedence daemon-apply.sh uses, so updater and daemon contend on ONE
# canonical lock directory.
update_reports_dir() {
  printf '%s\n' "${AUTOAGENT_REPORTS_DIR:-${HOME}/.claude/data/daemon-reports}"
}

# The daemon .apply-lock directory (mkdir-atomic lock, same as daemon-apply.sh).
update_apply_lock_dir() {
  printf '%s\n' "$(update_reports_dir)/.apply-lock"
}

# Resolve the GitHub release repo slug: ATRIUM_RELEASE_REPO env → config.toml
# [release].repo. Empty when unconfigured (the caller loud-fails).
update_release_slug() {
  if [[ -n "${ATRIUM_RELEASE_REPO:-}" ]]; then
    printf '%s\n' "${ATRIUM_RELEASE_REPO}"
    return 0
  fi
  atrium_config_get '[release]' 'repo' ''
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

update_log() { printf '[glass-atrium-update] %s\n' "$*" >&2; }
update_die() {
  printf '[glass-atrium-update] FATAL: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

# Loud-fail when a required external tool is absent (Precondition Loud-Fail).
update_require_tools() {
  local tool missing=0
  for tool in "$@"; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      update_log "required tool not found: ${tool}"
      missing=1
    fi
  done
  [[ "${missing}" -eq 0 ]] || update_die "missing required tool(s) — install and retry"
}

# Refuse to start when HEAD is a mid-apply [WIP-AUTO] snapshot commit (a daemon
# apply is in flight — its files are not yet in a settled state). rc 0 = WIP
# (caller refuses) · rc 1 = clean HEAD.
update_head_is_wip() {
  local root subject
  root="$(update_ga_root)"
  # `|| true` so a non-git checkout (no HEAD) is NOT treated as WIP — it is a
  # clean state for this predicate; the caller's own git operations loud-fail
  # later if the tree is genuinely unusable.
  subject="$(git -C "${root}" log -1 --format=%s 2>/dev/null || true)"
  [[ "${subject}" == '[WIP-AUTO]'* ]]
}

# ---------------------------------------------------------------------------
# Writer-serialization (pause flag + lock) — state tracked for trap cleanup
# ---------------------------------------------------------------------------

# Mutable run state (globals — set across functions, consumed in the gate
# callback + the trap cleanup; declared here so strict mode + shellcheck see a
# defined origin).
_update_pause_created=0
_update_lock_acquired=0
_update_workdir=""
_update_clean_paths=""
_update_staging=""
_update_snapshot=""

# Agent EDITABLE-region merge (E4 / T19) run state. The merge lib dir + update
# state dir are resolved once (update_main / the merge fn); the per-candidate
# verify context globals are SET right before each git_txn_apply call and READ by
# the injected verify callback (git_txn_apply hands the verify_fn only the target,
# so the remaining anchors travel through these globals — the same sourced-lib
# caller-scope contract git-txn.sh documents).
_update_merge_lib_dir=""
_update_state_dir=""
_update_agent_git_root=""
_update_agent_records_file=""
_update_agent_verify_local=""
_update_agent_verify_release=""
_update_agent_verify_agent=""
_update_agent_verify_target=""

# Single idempotent cleanup: remove ONLY what this run created. Registered on
# EXIT INT TERM so the pause flag clears and the daemon resumes on any exit path —
# the trap-guarded quiesce/restore the T10 contract requires.
update_cleanup() {
  if [[ "${_update_lock_acquired}" -eq 1 ]]; then
    rmdir -- "$(update_apply_lock_dir)" 2>/dev/null \
      || update_log "WARN: apply-lock release failed: $(update_apply_lock_dir)"
    _update_lock_acquired=0
  fi
  if [[ "${_update_pause_created}" -eq 1 ]]; then
    update_pause_remove
    _update_pause_created=0
  fi
  if [[ -n "${_update_workdir}" && -d "${_update_workdir}" ]]; then
    rm -rf -- "${_update_workdir}"
    _update_workdir=""
  fi
}

# Set the pause flag FIRST (the daemon's decision-to-run gate suspends as soon as
# it sees it), then acquire the lock. Acquiring after the flag minimizes the
# window in which a daemon cycle could already hold the lock; if one does, the
# mkdir loud-fails and we abort (the trap clears the flag we just set).
update_serialize_begin() {
  local lock_dir
  update_pause_create >/dev/null
  _update_pause_created=1
  # Ensure the reports dir exists (same as daemon-apply.sh) so the lock mkdir
  # fails ONLY on genuine contention, not a missing parent.
  mkdir -p -- "$(update_reports_dir)"
  lock_dir="$(update_apply_lock_dir)"
  if ! mkdir -- "${lock_dir}" 2>/dev/null; then
    update_die "another apply is in progress (lock held): ${lock_dir}"
  fi
  _update_lock_acquired=1
  if update_head_is_wip; then
    update_die "HEAD is a [WIP-AUTO] commit — a daemon apply is mid-flight; retry once it settles"
  fi
}

# ---------------------------------------------------------------------------
# Download + stage the latest GitHub Release asset
# ---------------------------------------------------------------------------

# Fetch the latest release's manifest.json + hashed bundle into $1 (download dir)
# and extract the bundle into $2 (new-release tree). Echoes nothing; on success
# $2 holds the new tree and $1/manifest.json the new manifest. Honors the
# ATRIUM_UPDATE_SRC_DIR / ATRIUM_UPDATE_SRC_MANIFEST test seam (both set → skip
# gh entirely, the supplied tree + manifest are used verbatim).
update_fetch_release() {
  local dl_dir="$1" new_dir="$2" slug bundle
  mkdir -p -- "${dl_dir}" "${new_dir}"

  if [[ -n "${ATRIUM_UPDATE_SRC_DIR:-}" && -n "${ATRIUM_UPDATE_SRC_MANIFEST:-}" ]]; then
    update_log "test seam: using local source tree ${ATRIUM_UPDATE_SRC_DIR}"
    cp -- "${ATRIUM_UPDATE_SRC_MANIFEST}" "${dl_dir}/manifest.json"
    cp -Rp -- "${ATRIUM_UPDATE_SRC_DIR}/." "${new_dir}/"
    return 0
  fi

  slug="$(update_release_slug)"
  [[ -n "${slug}" ]] \
    || update_die "release repo NOT configured — set ATRIUM_RELEASE_REPO=<owner/repo> or [release].repo in config.toml"
  update_require_tools gh tar
  update_log "downloading latest release from ${slug}"
  # No tag → latest. The two assets are deterministic: manifest.json + the
  # versioned bundle (glass-atrium-bundle-<version>.tar.gz, per publish-release.sh).
  gh release download --repo "${slug}" --dir "${dl_dir}" --clobber \
    --pattern 'manifest.json' --pattern 'glass-atrium-bundle-*.tar.gz' \
    || update_die "gh release download failed for ${slug}"
  [[ -f "${dl_dir}/manifest.json" ]] \
    || update_die "release asset manifest.json missing after download"
  bundle="$(find "${dl_dir}" -maxdepth 1 -name 'glass-atrium-bundle-*.tar.gz' -print -quit)"
  [[ -n "${bundle}" ]] \
    || update_die "release bundle asset (glass-atrium-bundle-*.tar.gz) missing after download"
  tar -xzf "${bundle}" -C "${new_dir}" \
    || update_die "bundle extraction failed: ${bundle}"
}

# ---------------------------------------------------------------------------
# Sensitive-path partition (T15 / gate G7) — fail-closed
# ---------------------------------------------------------------------------

# Split the change set (one relative path per line on STDIN) into two files:
# $1 = clean paths (safe to auto-sync) · $2 = sensitive paths (refused — manual
# review). A path the helper cannot conclusively clear (env/usage error) is
# fail-CLOSED into the sensitive set, never auto-synced. Returns 0 always; the
# caller decides on the sensitive set.
update_partition_sensitive() {
  local clean_out="$1" sensitive_out="$2" path
  : >"${clean_out}"
  : >"${sensitive_out}"
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    if sensitive_path_ok "${path}"; then
      printf '%s\n' "${path}" >>"${clean_out}"
    else
      printf '%s\n' "${path}" >>"${sensitive_out}"
    fi
  done
}

# ---------------------------------------------------------------------------
# Roster-migration gate (T20 / gate G8) — fail-closed
# ---------------------------------------------------------------------------
#
# A release that ADDS or REMOVES an agent is a ROSTER change, NOT a content edit.
# It MUST NOT be auto-applied by the silent deterministic sync: agents/**/*.md is
# already excluded by the spine (E4 merge path), but agent-registry.json is a
# NON-agent file that WOULD flow through the deterministic sync and silently swap
# an agent into / out of the roster. Roster changes belong to the agent_lifecycle
# human-pause ceremony (create/delete passes its gate + the two HITL pauses), so
# this gate refuses/defers them. A pure CONTENT edit to an already-present agent
# (same name on both sides) is NOT a roster change and passes through to E4.
#
# The roster is the UNION of two signals so a half-applied release (file present
# but registry stale, or vice-versa) is still caught:
#   * the agents/<name>.md file set (top-level only; references/ + GLOBAL_RULES
#     excluded — they are not agents)
#   * the agent-registry.json `.agents` object keys (the authoritative roster)

# Emit (one per line) the agent NAMES a manifest declares via its files[] — the
# top-level agents/<name>.md entries, with the references/ subtree and the
# non-agent GLOBAL_RULES.md charter excluded. Empty when the manifest is absent
# or unparseable (the comparison degrades to the other signal, never errors).
update_roster_names_from_manifest() {
  local manifest="$1"
  [[ -f "${manifest}" ]] || return 0
  jq -r '
    .files[]
    | select(type == "string")
    | select(test("^agents/[^/]+\\.md$"))
    | sub("^agents/"; "") | sub("\\.md$"; "")
    | select(. != "GLOBAL_RULES")
  ' -- "${manifest}" 2>/dev/null || true
}

# Emit (one per line) the agent NAMES present as top-level agents/<name>.md files
# under an install root (filesystem glob, non-recursive so references/ is skipped),
# with GLOBAL_RULES.md excluded. Empty when the agents dir is absent.
update_roster_names_from_dir() {
  local root="$1" file base
  # No `nullglob` (unsafe to set in a sourced lib) — guard each match instead so
  # an empty agents/ dir yields the literal glob, which the -e test rejects.
  for file in "${root}"/agents/*.md; do
    [[ -e "${file}" ]] || continue
    base="${file##*/}"
    base="${base%.md}"
    [[ "${base}" == 'GLOBAL_RULES' ]] && continue
    printf '%s\n' "${base}"
  done
}

# Emit (one per line) the registry agent KEYS from an agent-registry.json — the
# `.agents` object keys (the authoritative roster). Empty when the file is absent
# or unparseable, so a registry-less release falls back to the file-set signal.
update_roster_keys_from_registry() {
  local registry="$1"
  [[ -f "${registry}" ]] || return 0
  jq -r '(.agents // {}) | keys[]' -- "${registry}" 2>/dev/null || true
}

# Emit the sorted-unique roster of the incoming RELEASE: the manifest agent-file
# set ∪ the new-tree registry keys. Args: $1 = new manifest · $2 = new registry.
update_roster_new() {
  local manifest="$1" registry="$2"
  {
    update_roster_names_from_manifest "${manifest}"
    update_roster_keys_from_registry "${registry}"
  } | LC_ALL=C sort -u
}

# Emit the sorted-unique roster of the LIVE install: the filesystem agent-file set
# ∪ the local registry keys. Arg: $1 = install root.
update_roster_local() {
  local root="$1"
  {
    update_roster_names_from_dir "${root}"
    update_roster_keys_from_registry "${root}/agent-registry.json"
  } | LC_ALL=C sort -u
}

# Emit the sorted-unique PRIOR-VENDOR roster — the agent names the prior installed
# release declared, read from the stored base@install baseline manifest (the
# `spine_set_baseline` anchor; agent-file `.files[]` entries only — the baseline
# carries no registry). This is the provenance signal that lets the gate tell a
# VENDOR-dropped agent apart from a USER-added local-only agent. Empty when no
# baseline exists (first-ever update / relocated install) → the caller then flags
# NO removes, so a missing baseline degrades to "never false-block a removal".
# Arg: $1 = baseline manifest path (may be empty/absent).
update_roster_prior_vendor() {
  local baseline_manifest="${1:-}"
  [[ -n "${baseline_manifest}" && -f "${baseline_manifest}" ]] || return 0
  update_roster_names_from_manifest "${baseline_manifest}" | LC_ALL=C sort -u
}

# Emit the roster DELTA between the release and the live install, one change per
# line: `add <name>` or `remove <name>`. Empty output ⇒ no roster change (pure
# content / non-agent change) which the caller passes straight through.
#
# Provenance asymmetry (the T20 false-positive FIX):
#   * ADD    = present in the release roster, absent LOCALLY → an agent the install
#              does not yet have. Keyed on the local set: a user-added agent already
#              present locally is NOT re-flagged, and it can never appear here (it is
#              absent from the release), so adds carry no user-local false positive.
#   * REMOVE = present in the PRIOR-VENDOR baseline, absent in the NEW RELEASE → the
#              vendor dropped one of ITS OWN agents. Keyed on the prior-vendor
#              baseline (NOT the full local set): an agent the USER added via
#              agent_lifecycle — present locally but never in any vendor release — is
#              NOT a vendor removal and therefore does NOT gate. Before this fix the
#              remove side compared release-vs-local, so every customized install
#              (the common case) false-blocked on its user-local agents.
# A missing baseline yields an empty prior-vendor roster → no removes flagged
# (degrade-safe: never false-block a removal). Args: $1 = new manifest · $2 = new
# registry · $3 = install root · $4 = prior-vendor baseline manifest (optional).
update_detect_roster_changes() {
  local new_manifest="$1" new_registry="$2" install_root="$3" baseline_manifest="${4:-}"
  local new_list local_list prior_vendor name
  new_list="$(update_roster_new "${new_manifest}" "${new_registry}")"
  local_list="$(update_roster_local "${install_root}")"
  prior_vendor="$(update_roster_prior_vendor "${baseline_manifest}")"
  # `comm` requires sorted input (every list is already `sort -u`-ed). The empty
  # line a bare "" produces sorts first and is filtered by the -n guard below.
  while IFS= read -r name; do
    [[ -n "${name}" ]] && printf 'add %s\n' "${name}"
  done < <(LC_ALL=C comm -23 <(printf '%s\n' "${new_list}") <(printf '%s\n' "${local_list}"))
  # remove = prior-vendor baseline MINUS the new release (vendor-dropped only).
  while IFS= read -r name; do
    [[ -n "${name}" ]] && printf 'remove %s\n' "${name}"
  done < <(LC_ALL=C comm -23 <(printf '%s\n' "${prior_vendor}") <(printf '%s\n' "${new_list}"))
  # Always succeed: this function only EMITS the roster diff to stdout — its exit
  # status carries no meaning. An empty prior_vendor makes `comm` surface a spurious
  # blank line that the loop's `[[ -n ]]` guard rejects (returning 1), so without
  # this the final loop's status would propagate 1 and fail the caller's `set -e`
  # command substitution. (The original relied on both comm operands being
  # non-empty; the provenance fix introduces an empty-operand case.)
  return 0
}

# The gate proper (T20 / gate G8). On a detected roster change: report each
# add/remove and REFUSE — directing the user to the agent_lifecycle ceremony —
# unless ATRIUM_UPDATE_ALLOW_ROSTER is set, the explicit, non-silent opt-in that
# downgrades the refusal to a logged warning and proceeds. No roster change → a
# silent pass-through (return 0). Args mirror update_detect_roster_changes.
update_roster_gate() {
  local new_manifest="$1" new_registry="$2" install_root="$3" baseline_manifest="${4:-}" changes line
  changes="$(update_detect_roster_changes "${new_manifest}" "${new_registry}" "${install_root}" "${baseline_manifest}")"
  if [[ -z "${changes}" ]]; then
    return 0
  fi
  update_log "ROSTER CHANGE DETECTED — this release adds or removes an agent:"
  while IFS= read -r line; do
    [[ -n "${line}" ]] && update_log "  ${line}"
  done <<<"${changes}"
  if [[ -n "${ATRIUM_UPDATE_ALLOW_ROSTER:-}" ]]; then
    update_log "ATRIUM_UPDATE_ALLOW_ROSTER set — proceeding past the roster gate on explicit confirmation"
    return 0
  fi
  update_die "roster changes are NOT auto-applied — run the agent_lifecycle human-pause ceremony (python -m agent_lifecycle add|extend|delete) to add or remove an agent, then re-run the update (override for an explicit, non-silent apply: ATRIUM_UPDATE_ALLOW_ROSTER=1)"
}

# ---------------------------------------------------------------------------
# Agent EDITABLE-region merge — E4 (T17-T19), the live integration
# ---------------------------------------------------------------------------
#
# This is the agent-file counterpart to the deterministic non-agent sync: the
# spine EXCLUDES agents/**/*.md (spine_is_excluded_path), so each changed agent
# *.md flows through the three-anchor (base@install / vendor / local) resolver in
# autoagent/lib/editable_merge.py instead of being byte-swapped. Per plan S2 the
# merged candidate then passes the SAME T12 foreground confirm gate as the
# non-agent path AND is committed through the daemon's hardened git_txn_apply
# transaction (WIP-snapshot → apply → verify → commit|rollback). Reuse only — no
# merge logic is re-implemented here; this is the wiring.
#
# Per-file verdicts (from editable_merge `plan`) route as follows:
#   * REFUSED (sensitive path/diff, plan rc 3)  -> skipped, reported (never written)
#   * structural-change (region-count mismatch) -> routed to the agent_lifecycle
#                                                  ceremony (NOT auto-applied)
#   * keep-local / no-op (changed=False)         -> no write
#   * keep-local|take-release|merge-* (changed)  -> candidate collected -> gate -> txn
# A release-only agent file (an ADD: present in the release, absent locally) is a
# ROSTER change already handled by update_roster_gate; the merge skips it (the add
# belongs to the agent_lifecycle ceremony, not an in-band content merge).

# Echo the git worktree toplevel for an install path, or empty when it is not a
# git repo. The agent merge is git-sandboxed (git_txn_apply): a non-git install
# cannot run the transaction, so the merge loud-skips rather than corrupting.
update_git_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || true
}

# Resolve a (possibly facade-symlink) path to its real location so `git -C
# git_root add/checkout` references a path INSIDE the worktree (mirrors the
# daemon's ga_realpath — a facade ~/.claude/agents/X.md follows to its real GA
# body). python3 is already a required tool (update_run).
update_realpath() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# Extract a `key=value` token's value from an editable_merge plan line (values
# are space-free, so up-to-next-space is exact). Args: $1 = key · $2 = plan line.
update_plan_field() {
  local rest="${2#*"$1"=}"
  printf '%s\n' "${rest%% *}"
}

# Python verify shell-out (SC2259-safe: a plain assigned string constant, NOT a
# `<<'PY'` heredoc inside $()). Reconstructs the MergeCandidate from the SAME
# anchors `plan` used, then runs its git_txn verify callback: a sensitive re-scan
# of the on-disk patched file plus — only for an LLM-required (both-changed)
# region — the daemon's Haiku improvement-verify gate. Deterministic keep-local /
# take-release / no-op candidates pass WITHOUT any LLM call. argv:
#   1 merge_lib  2 target(logical)  3 local(orig backup)  4 release  5 base(or "")
#   6 agent  7 state_dir  8 on_disk(the patched target)
_UPDATE_VERIFY_PY='
import sys
merge_lib, target, local_p, release_p, base_p, agent, state_dir, on_disk = sys.argv[1:9]
sys.path.insert(0, merge_lib)
import editable_merge as em
with open(local_p, encoding="utf-8") as fh:
    local_text = fh.read()
with open(release_p, encoding="utf-8") as fh:
    release_text = fh.read()
if base_p:
    with open(base_p, encoding="utf-8") as fh:
        base_text = fh.read()
else:
    base_text = em.load_base_text(target, state_dir=state_dir or None)
cand = em.build_merge_candidate(
    target, local_text, release_text,
    base_text=base_text, agent=agent, skip_pre_verify=False,
)
sys.exit(0 if cand.verify(on_disk) == 0 else 1)
'

# git_txn_apply APPLY callback — write the resolved candidate to the target. The
# candidate file path arrives in git_txn's `diff` slot ($2). Contract (mirrors
# apply_diff): 0 = applied · 2 = malformed/unwritable (git_txn rolls back). The
# candidate is already verdict-filtered (non-refused, non-structural, changed), so
# this is a straight content swap; a failed copy is the only malformed case.
#
# shellcheck disable=SC2329
#   Invoked INDIRECTLY as the apply callback NAME injected into git_txn_apply —
#   never called by `()` syntax here, so ShellCheck's reachability pass misses it.
_update_agent_apply() {
  local target="$1" candidate="$2"
  cp -- "${candidate}" "${target}" || return 2
  return 0
}

# git_txn_apply VERIFY callback — 0 ok / non-0 fail. Shells out to the merge
# module's MergeCandidate.verify against the just-written file, reading the
# per-candidate anchors from the verify-context globals (git_txn hands a verify
# callback only the target path). A non-zero rc makes git_txn restore the file
# from the WIP snapshot and roll back.
#
# shellcheck disable=SC2329
#   Invoked INDIRECTLY as the verify callback NAME injected into git_txn_apply.
_update_agent_verify() {
  local on_disk="$1"
  if python3 -c "${_UPDATE_VERIFY_PY}" \
    "${_update_merge_lib_dir}" "${_update_agent_verify_target}" \
    "${_update_agent_verify_local}" "${_update_agent_verify_release}" \
    "" "${_update_agent_verify_agent}" "${_update_state_dir}" "${on_disk}" >&2; then
    return 0
  fi
  return 1
}

# The committing callback the foreground gate invokes ONLY on explicit confirm.
# Iterates the collected candidate records (TSV: logical, real, candidate,
# local_backup, release, agent) and drives each through git_txn_apply. Each file
# is an independent transaction — a verify failure rolls back that file alone and
# is reported LOUDLY; the rest still apply. rc 1 when any file rolled back.
#
# shellcheck disable=SC2329
#   Passed by NAME to gate_apply_confirmed (`"$@"`), never called by `()` here.
_update_agent_commit_callback() {
  local logical real candidate backup release agent rc=0
  while IFS=$'\t' read -r logical real candidate backup release agent; do
    [[ -n "${logical}" ]] || continue
    _update_agent_verify_target="${logical}"
    _update_agent_verify_local="${backup}"
    _update_agent_verify_release="${release}"
    _update_agent_verify_agent="${agent}"
    GIT_TXN_RC=""
    # BARE invocation (git-txn.sh header contract): it returns 0 for every handled
    # outcome and reports the structured result in GIT_TXN_RC. target == git_target
    # (real path) since GA uses no facade symlinks in-worktree; the candidate file
    # rides the diff slot to _update_agent_apply.
    git_txn_apply \
      "${_update_agent_git_root}" "${real}" "${real}" "${candidate}" \
      "[WIP-AUTO] glass-atrium-update pre-merge snapshot: ${logical}" \
      "[AUTO] glass-atrium-update EDITABLE-region merge: ${logical}" \
      _update_agent_apply _update_agent_verify "${agent}" "${logical}"
    if [[ "${GIT_TXN_RC}" == "${GIT_TXN_OK}" ]]; then
      update_log "agent merged + committed: ${logical}"
    else
      update_log "WARN: agent merge rolled back (GIT_TXN_RC=${GIT_TXN_RC}) — ${logical} left at its local version"
      rc=1
    fi
  done <"${_update_agent_records_file}"
  return "${rc}"
}

# Drive the three-anchor agent merge for every changed agents/<name>.md. Args:
# $1 = new-release tree root · $2 = new manifest (unused; kept for the call-site
# signature + future per-file manifest checks) · $3 = live install root.
update_merge_agent_editable_regions() {
  local new_dir="$1" root="$3"
  : "${2:?manifest}"
  local merge_dir git_root real_agents records_file gate_records=""
  local file base local_file candidate backup plan_err plan_line plan_rc
  local verdict changed n_candidates=0 rc=0

  _update_merge_lib_dir="${ATRIUM_UPDATE_MERGE_LIB_DIR:-${_update_merge_lib_dir}}"
  _update_state_dir="$(spine_baseline_dir)"

  merge_dir="$(mktemp -d -t glass-atrium-agent-merge.XXXXXX)"
  records_file="${merge_dir}/records.tsv"
  : >"${records_file}"

  # Collect a candidate per changed, mergeable agent file. agents/<name>.md is
  # top-level only (references/ + the non-agent GLOBAL_RULES.md charter excluded,
  # same scoping as the roster scan).
  for file in "${new_dir}"/agents/*.md; do
    [[ -e "${file}" ]] || continue
    base="${file##*/}"
    [[ "${base}" == 'GLOBAL_RULES.md' ]] && continue
    local_file="${root}/agents/${base}"
    if [[ ! -f "${local_file}" ]]; then
      update_log "agent merge: ${base} is release-only (ADD) — defer to the agent_lifecycle ceremony, skipping"
      continue
    fi
    # Byte-identical → nothing to merge (equivalent to plan changed=False).
    cmp -s -- "${local_file}" "${file}" && continue

    candidate="${merge_dir}/${base}.candidate"
    plan_err="${merge_dir}/${base}.planerr"
    plan_rc=0
    plan_line="$(python3 "${_update_merge_lib_dir}/editable_merge.py" plan \
      --target "agents/${base}" --local "${local_file}" --release "${file}" \
      --out "${candidate}" --agent "${base%.md}" \
      --state-dir "${_update_state_dir}" 2>"${plan_err}")" || plan_rc=$?

    if [[ "${plan_rc}" -eq 3 ]]; then
      update_log "agent merge: REFUSED sensitive agent file — review manually: agents/${base}"
      continue
    fi
    if [[ "${plan_rc}" -ne 0 ]]; then
      update_log "WARN: agent merge plan failed (rc ${plan_rc}) for agents/${base} — skipping: $(cat "${plan_err}" 2>/dev/null || true)"
      continue
    fi

    verdict="$(update_plan_field verdict "${plan_line}")"
    changed="$(update_plan_field changed "${plan_line}")"
    if [[ "${verdict}" == 'structural-change' ]]; then
      update_log "agent merge: STRUCTURAL change (EDITABLE region-count mismatch) in agents/${base} — route to the agent_lifecycle ceremony, NOT auto-applied"
      continue
    fi
    if [[ "${changed}" != 'True' ]]; then
      update_log "agent merge: agents/${base} resolves with no net change (regions kept local) — no write"
      continue
    fi

    # A mergeable candidate. Preserve the ORIGINAL local body (the apply overwrites
    # it; verify diffs the candidate against this backup), then queue the record +
    # the gate preview row (current = live local, proposed = merged candidate).
    backup="${merge_dir}/${base}.localbak"
    cp -- "${local_file}" "${backup}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "agents/${base}" "$(update_realpath "${local_file}")" "${candidate}" \
      "${backup}" "${file}" "${base%.md}" >>"${records_file}"
    gate_records="${gate_records}$(printf 'agents/%s\t%s\t%s' "${base}" "${local_file}" "${candidate}")"$'\n'
    n_candidates=$((n_candidates + 1))
  done

  if [[ "${n_candidates}" -eq 0 ]]; then
    update_log "agent EDITABLE-region merge: no agent files to merge"
    rm -rf -- "${merge_dir}"
    return 0
  fi

  # The merge is git-sandboxed; a non-git install cannot run the transaction.
  # Loud-skip (Precondition Loud-Fail) rather than corrupting a learned region.
  real_agents="$(update_realpath "${root}/agents" 2>/dev/null || true)"
  git_root="$(update_git_root "${real_agents:-${root}}")"
  if [[ -z "${git_root}" ]]; then
    update_log "WARN: ${n_candidates} agent file(s) changed but the install is not a git repo — agent EDITABLE-region merge SKIPPED (the git_txn transaction requires git); review/apply manually"
    rm -rf -- "${merge_dir}"
    return 0
  fi

  # Foreground confirm (the SAME T12 gate as the non-agent path), then the per-file
  # git_txn transactions on explicit confirm. The agent merge is best-effort and
  # NON-fatal to the (already-applied) non-agent sync: a decline simply leaves the
  # agent files unmerged.
  _update_agent_git_root="${git_root}"
  _update_agent_records_file="${records_file}"
  printf '%s' "${gate_records}" | gate_apply_confirmed _update_agent_commit_callback || rc=$?
  case "${rc}" in
    0) update_log "agent EDITABLE-region merge applied (${n_candidates} file(s))" ;;
    1) update_log "agent EDITABLE-region merge declined — agent files left unmerged" ;;
    2) update_log "agent EDITABLE-region merge: no changes to confirm" ;;
    *) update_log "WARN: agent EDITABLE-region merge had rolled-back file(s) — see the per-file outcome above" ;;
  esac
  rm -rf -- "${merge_dir}"
  return 0
}

# ---------------------------------------------------------------------------
# Post-apply baseline capture — T24 wiring SEAM (exposed call point)
# ---------------------------------------------------------------------------

# Capture the just-applied manifest as the base@install anchor (spine_set_baseline,
# T14). T24 (E5) owns the broader install/post-apply wiring; T09 exposes and calls
# the point so a successful sync anchors the next update's 3-anchor merge base.
# Arg: $1 = applied manifest.json.
update_capture_baseline() {
  local manifest="$1" stored
  if stored="$(spine_set_baseline "${manifest}")"; then
    update_log "baseline anchor captured: ${stored}"
  else
    update_log "WARN: baseline capture failed for ${manifest} (next update falls back to a wider merge base)"
  fi
}

# ---------------------------------------------------------------------------
# Post-apply base-content capture — T24 (the 3-way merge base TEXT store)
# ---------------------------------------------------------------------------
#
# The hash-only baseline manifest (above) proves "this file changed since base"
# but cannot reconstruct the base region TEXT a real 3-way merge needs. The
# base-content store is the SEPARATE provenance the next update's E4 resolver
# reads via editable_merge.load_base_text(target_file) — BASENAME-keyed at
# <state_dir>/base-agents/<basename> (the layout editable_merge.base_store_dir
# defines). After a successful apply we persist the just-installed (= the NEW
# base@install) agent bodies there, so the NEXT update does a true diff3 instead
# of degrading to the gated 2-way present-both fallback.

# Echo the base-content store dir, mirroring editable_merge.base_store_dir:
# <state_dir>/base-agents, where <state_dir> resolves with the SAME precedence as
# the hash baseline (spine_baseline_dir: ATRIUM_UPDATE_STATE_DIR → ~/.claude/data/update).
update_base_store_dir() {
  printf '%s\n' "$(spine_baseline_dir)/base-agents"
}

# Persist the new-release top-level agents/<name>.md bodies into the base-content
# store (basename-keyed, full body — what load_base_text reads + _region_contents
# splits). Non-recursive (references/ excluded, same as the roster dir scan). A
# best-effort copy: a single failed body is warned and skipped, never aborting the
# already-completed apply. Arg: $1 = new-release tree root.
update_capture_base_content() {
  local new_dir="$1" store file base count=0
  store="$(update_base_store_dir)"
  mkdir -p -- "${store}"
  for file in "${new_dir}"/agents/*.md; do
    [[ -e "${file}" ]] || continue
    base="${file##*/}"
    if cp -p -- "${file}" "${store}/${base}"; then
      count=$((count + 1))
    else
      update_log "WARN: base-content capture failed for ${base} (next update falls back to gated 2-way for it)"
    fi
  done
  update_log "base-content store updated: ${count} agent body(ies) → ${store}"
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

update_usage() {
  cat <<'USAGE'
glass-atrium update — apply the latest Glass Atrium release.

Usage:
  glass-atrium update            download, preview a per-file diff, confirm, apply
  glass-atrium update --help     show this help

Flow: pause the autoagent daemon → acquire the apply-lock → download + verify the
release → foreground diff/confirm → deterministic non-agent sync → capture the
baseline. Agent EDITABLE-region merges are handled separately (E4). Sensitive
harness files are never auto-synced (reported for manual review).
USAGE
}

# The committing callback the foreground gate invokes ONLY on explicit confirm.
# Reads the clean change set (one path per line) from STDIN and snapshot+swaps via
# the spine. Globals carry the paths the gate cannot (the gate owns stdin).
update_commit_callback() {
  printf '%s\n' "${_update_clean_paths}" \
    | spine_commit_staged "${_update_staging}" "$(update_ga_root)" "${_update_snapshot}"
}

update_run() {
  local root work dl_dir new_dir manifest staging snapshot baseline_manifest
  local changed clean_paths sensitive_paths n_sensitive records rc=0 path
  root="$(update_ga_root)"
  update_require_tools jq git python3

  # Step 1 — writer-serialization (pause flag → lock → WIP refusal).
  update_serialize_begin

  # Step 2 — download + stage the latest release.
  work="$(mktemp -d -t glass-atrium-update.XXXXXX)"
  _update_workdir="${work}"
  dl_dir="${work}/download"
  new_dir="${work}/new"
  staging="${work}/staging"
  snapshot="${work}/snapshot"
  mkdir -p -- "${staging}" "${snapshot}"
  update_fetch_release "${dl_dir}" "${new_dir}"
  manifest="${dl_dir}/manifest.json"

  # Resolve the prior-vendor baseline manifest (the base@install anchor) so the
  # roster gate keys REMOVALS on vendor provenance, not the full local set — a
  # user-added agent (present locally but absent from any vendor release) must
  # NEVER false-block a content update. Absent baseline → empty → no removes
  # flagged (`|| true`: absence is a normal non-error result of the `get`).
  baseline_manifest="$(spine_get_baseline || true)"

  # Step 2.5 — roster-migration gate (T20 / gate G8). A release that ADDS or
  # REMOVES a VENDOR agent must route through the agent_lifecycle human-pause
  # ceremony, never the silent deterministic sync — so refuse/defer BEFORE any
  # staging. A pure content edit to an existing agent (and a user-local-only agent)
  # is not a vendor roster change and passes through (agent md is handled by the E4
  # EDITABLE-region merge). The new-tree registry sits at the extracted bundle root
  # beside the manifest's agent files; the prior-vendor baseline scopes removals.
  update_roster_gate "${manifest}" "${new_dir}/agent-registry.json" "${root}" "${baseline_manifest}"

  # Step 3 — select the changed NON-AGENT files (agent md / overlays / config are
  # excluded by the spine), then partition out sensitive harness files.
  changed="$(spine_find_changed_files "${manifest}" "${root}")" \
    || update_die "change selection failed (manifest hash gap) — refusing to apply"
  if [[ -z "${changed}" ]]; then
    update_log "already up to date — no non-agent files changed"
    update_merge_agent_editable_regions "${new_dir}" "${manifest}" "${root}"
    return 0
  fi
  clean_paths="${work}/clean.paths"
  sensitive_paths="${work}/sensitive.paths"
  printf '%s\n' "${changed}" \
    | update_partition_sensitive "${clean_paths}" "${sensitive_paths}"
  n_sensitive="$(grep -c . "${sensitive_paths}" 2>/dev/null || true)"
  [[ -n "${n_sensitive}" ]] || n_sensitive=0
  if [[ "${n_sensitive}" -gt 0 ]]; then
    update_log "REFUSED to auto-sync ${n_sensitive} sensitive harness file(s) — review manually:"
    while IFS= read -r path; do
      [[ -n "${path}" ]] && update_log "  (sensitive, skipped) ${path}"
    done <"${sensitive_paths}"
  fi
  if [[ ! -s "${clean_paths}" ]]; then
    update_log "no auto-syncable files remain after the sensitive partition — nothing to apply"
    update_merge_agent_editable_regions "${new_dir}" "${manifest}" "${root}"
    return 0
  fi

  # Step 4 (verify) — per-file SHA-256 of every clean changed file == manifest
  # hashes[path], staged into the work dir. Loud-fail leaves the install untouched.
  spine_stage_and_verify "${new_dir}" "${manifest}" "${staging}" <"${clean_paths}" \
    || update_die "per-file hash verification failed — corrupt download, refusing to apply"

  # Step 5 — foreground diff/confirm gate, then deterministic snapshot+swap.
  _update_clean_paths="$(cat "${clean_paths}")"
  _update_staging="${staging}"
  _update_snapshot="${snapshot}"
  records="$(gate_build_nonagent_records "${new_dir}" "${root}" <"${clean_paths}")"
  printf '%s\n' "${records}" | gate_apply_confirmed update_commit_callback || rc=$?
  case "${rc}" in
    0) update_log "non-agent sync applied" ;;
    1) update_die "declined at the confirm gate — no files written" ;;
    2) update_log "no changes to confirm" ;;
    *) update_die "apply failed (rc ${rc}) — the spine rolled back any partial swap" ;;
  esac

  # Agent EDITABLE-region merge — E4 seam (no-op in T09).
  update_merge_agent_editable_regions "${new_dir}" "${manifest}" "${root}"

  # Step 6 — capture the applied manifest as the base@install anchor (T24 seam),
  # then persist the new-release agent bodies into the base-content store so the
  # NEXT update has real base TEXT for a true 3-way merge (T24 base-content capture).
  update_capture_baseline "${manifest}"
  update_capture_base_content "${new_dir}"

  update_log "update complete"
}

update_main() {
  case "${1:-}" in
    -h | --help)
      update_usage
      return 0
      ;;
    '') ;;
    *)
      update_log "unknown argument: $1"
      update_usage >&2
      return 2
      ;;
  esac

  # Source the E3 spine libs (function-only, no side effects). Resolved relative
  # to THIS script's own location (skills/glass-atrium-update/ → repo scripts/lib),
  # NOT GA_ROOT — GA_ROOT names the install being UPDATED, which the test seam can
  # redirect to a sandbox, whereas the running updater's libs always sit beside it.
  # ATRIUM_UPDATE_LIB_DIR overrides for non-standard layouts.
  local script_dir lib_dir merge_lib_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  lib_dir="${ATRIUM_UPDATE_LIB_DIR:-${script_dir}/../../scripts/lib}"
  # The agent-merge module + the shared git_txn transaction live under autoagent/lib
  # (a sibling tree to scripts/lib), resolved beside the running updater the same
  # way; ATRIUM_UPDATE_MERGE_LIB_DIR overrides for non-standard layouts.
  merge_lib_dir="${ATRIUM_UPDATE_MERGE_LIB_DIR:-${script_dir}/../../autoagent/lib}"
  _update_merge_lib_dir="${merge_lib_dir}"
  # shellcheck source=/dev/null
  source "${lib_dir}/atrium-config.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/update-pause-flag.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/apply-spine.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/apply-gate.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/sensitive-refusal.sh"
  # The agent-merge transaction lib. A static source directive (resolved relative
  # to this script's own dir) lets ShellCheck follow it under --external-sources
  # and SEE the GIT_TXN_* constants (silences SC2154 the way daemon-apply.sh does).
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=../../autoagent/lib/git-txn.sh
  source "${merge_lib_dir}/git-txn.sh"

  # Register cleanup BEFORE any state is created so an early failure still unwinds.
  trap update_cleanup EXIT INT TERM
  update_run
}

# Execute only when run directly — sourcing (the bats suite) exposes the functions
# without running the orchestration.
if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  update_main "$@"
fi
