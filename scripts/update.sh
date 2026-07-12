#!/usr/bin/env bash
# File-wide: SC2310 (a function in an `if`/`||`/`!` condition disables set -e) and
# SC2312 (command substitution masks a return value) are both --enable=all INFO
# checks that flag the DELIBERATE strict-mode guard idioms this file uses
# throughout (best-effort DB guards `func || return 0`, precondition probes
# `if ! func`, and `"$(resolver)"` argument capture). set -e already propagates a
# command-substitution failure, so SC2312 carries no real signal here; the
# `func || …` guards are intentional. Scoped to these two info codes only — every
# warning/error-severity finding is still surfaced (matches the sibling idiom
# source autoagent/daemon-apply.sh, whose SC2329 callbacks are likewise disabled
# per-site below).
# shellcheck disable=SC2310,SC2312
# glass-atrium-update — the user-triggered Glass Atrium updater (plan E3 / design
# C, task T09). This is the ADAPTER that ORCHESTRATES the already-built E3 spine
# libs; it is deliberately NOT a new merge engine and it NEVER writes
# core.autoagent_proposals (that surface belongs to the autoagent self-improvement
# loop, a different system). The binary subcommand `glass-atrium update` (T08)
# dispatches here.
#
# What it does, in order (each step builds on the previous):
#   1. WRITER-SERIALIZATION (T10): create the cooperative pause flag so the
#      launchd-live autoagent daemon SUSPENDS, then acquire the daemon .apply-lock
#      (its mkdir contention refuses to start while a daemon apply is mid-flight).
#   2. DOWNLOAD + STAGE (T04 transport): fetch the latest GitHub Release assets
#      (manifest.json + the hashed bundle) for config [release].repo and extract.
#   3. VERIFY: per-file SHA-256 of every changed file == manifest hashes[path]
#      (spine_stage_and_verify — loud-fail leaves the install untouched).
#   4. FOREGROUND CONFIRM (T12 / gate G3): a per-file unified-diff preview then a
#      single explicit y/N confirm; declining writes ZERO files (structural).
#   5. DETERMINISTIC NON-AGENT SYNC (T13): snapshot + swap + rollback via the
#      apply-spine (spine_commit_staged). Agent EDITABLE-region merge is EXCLUDED
#      here and left as a documented CALL SEAM for E4 (T17-T19).
#   5b. VENDOR-REMOVAL SWEEP (#14): the deletion counterpart of the sync — move
#      files the prior-vendor baseline shipped but this release DROPPED (provenance
#      -clean only; a user-edited drop is PRESERVED) to Trash, previewed through the
#      SAME confirm gate. Runs before the baseline capture (still-old anchor) and
#      the mirror-farm refresh (a removed file gains no dangling mirror).
#   6. BASELINE (T14 fns; T24 wiring seam): capture the applied manifest as the
#      base@install anchor for the next update's 3-anchor merge.
#   7. CLEANUP: a trap removes the pause flag and releases the lock on EVERY exit
#      path (success, decline, failure, SIGINT/SIGTERM).
#
# Sensitive-path refusal (T15 / gate G7): a sensitive harness file (GLASS_ATRIUM_GLOBAL_RULES.md,
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
#
# ---------------------------------------------------------------------------
# P3 — headless / web-triggered orchestration (layered ON TOP of the interactive
# E3 flow above; the interactive TTY path is behavior-unchanged).
# ---------------------------------------------------------------------------
# Entry-point invariance: the SAME script backs both `glass-atrium update` (CLI,
# interactive TTY) and the web Update button (headless, non-TTY), the latter run
# by a DECOUPLED one-shot launchd job so the install-parity post-step's monitor
# `kickstart -k` cannot kill the update runner. Subflags select the mode:
#   (default)            interactive TTY apply — E3 behavior, NO DB tracking.
#   --headless           non-TTY apply: core.update_job status tracking
#                        (in-progress→completed/failed) + heartbeat + the
#                        install-parity post-step (monitor rebuild + launchd
#                        refresh). Confirm is the ATRIUM_UPDATE_CONFIRM_ANSWER
#                        seam (no TTY): unset/empty => fail-closed decline, zero
#                        writes; P3-T3 injects `yes` on an explicit web confirm.
#   --preview            dry-run: download + per-file diff to stdout, ZERO writes,
#                        no lock, no DB (P3-T3 consumes the diff for its nonce).
#   --restore-agents ID  restore agents/*.md from the agents-bak <ID> before-image
#                        (git-revert replacement, consumed by P3-T5).
#   --render-oneshot     render the DECOUPLED one-shot launchd plist and print its
#                        path to stdout (ZERO writes elsewhere; no lock/DB). The
#                        on-demand entry point P3-T3's route calls BEFORE
#                        `launchctl bootstrap`-ing the job (the plist is otherwise
#                        only (re)rendered by the post-step — chicken-and-egg on the
#                        first enqueue).
#
# Named exit codes (headless loud-fail — Precondition Loud-Fail): 1 generic fatal ·
# 2 usage · 7 claude binary unresolvable in the job/monitor plist env (the merge
# stage would fail) · 8 another update already in-progress (single-active DB guard)
# · 9 install-parity post-step failed · 10 agents-bak restore failed · 11
# mirror-farm refresh failed (files APPLIED, but the ~/.claude facade mirror was
# not refreshed — run `glass-atrium agents-only`; no rollback of applied files) ·
# 12 hook-binding wiring failed (files APPLIED + mirror refreshed, but the
# settings.json event->hook bindings were NOT reconciled to the new release — run
# `glass-atrium wire-hooks`; no rollback of applied files) · 13 vendor-removal
# sweep failed (files APPLIED, but a vendor-DROPPED file could not be moved to
# Trash — remove it manually; no rollback of applied files).
#
# DB tracking is HEADLESS-ONLY — the interactive/CLI path performs NO DB write, so
# the E3 no-DB boundary holds there (the boundary now forbids core.autoagent_proposals
# only, not core.update_job). update_job rows are written via psql reusing the
# daemon-apply.sh idiom; single-active is the migration's partial UNIQUE INDEX
# (update_job_single_active_uniq WHERE status='in-progress'). Seams (all default to
# production): ATRIUM_UPDATE_PSQL (psql) · ATRIUM_UPDATE_DB_NAME (glass_atrium) ·
# ATRIUM_UPDATE_DB=off (disable tracking) · ATRIUM_UPDATE_JOB_ID (adopt a row the
# web route pre-created instead of INSERTing) · ATRIUM_UPDATE_NPM (npm) ·
# ATRIUM_UPDATE_LAUNCHCTL (launchctl) · ATRIUM_UPDATE_MONITOR_DIR ·
# ATRIUM_UPDATE_MONITOR_PLIST · ATRIUM_UPDATE_ONESHOT_PLIST ·
# ATRIUM_UPDATE_RENDER_LAUNCHD · ATRIUM_UPDATE_RENDER_MONITOR_ENV ·
# ATRIUM_UPDATE_CLAUDE_BIN · AUTOAGENT_BACKUP_DIR (agents-bak base) ·
# ATRIUM_UPDATE_TRASH_DIR (vendor-removal Trash sink; default ${HOME}/.Trash).

set -Eeuo pipefail
IFS=$'\n\t'

# bash 5.2+ turns patsub_replacement ON by default, making a bare '&' in a
# ${var//pat/repl} REPLACEMENT expand to the matched text — that would corrupt the
# XML-entity replacements in update_xml_escape (the one-shot plist render). Disable
# it so '&' is a literal replacement char on every bash. Guarded so bash 3.2 (macOS
# stock, which lacks the option) is a harmless no-op.
shopt -u patsub_replacement 2>/dev/null || true

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

# Loud-fail with an explicit NAMED exit code (Precondition Loud-Fail). Distinct
# from update_die (exit 1): the headless orchestration must surface a
# machine-readable cause to the decoupled job's log + the enqueuing route. Code
# namespace is documented in the file header.
update_die_code() {
  local code="$1"
  shift
  printf '[glass-atrium-update] FATAL: %s\n' "$*" >&2
  exit "${code}"
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

# ---------------------------------------------------------------------------
# Writer-serialization (pause flag + lock) — state tracked for trap cleanup
# ---------------------------------------------------------------------------

# Mutable run state (globals — set across functions, consumed in the gate
# callback + the trap cleanup; declared here so strict mode + shellcheck see a
# defined origin).
_update_pause_created=0
# Background pause-flag heartbeat refresher pid (finding #14) — set by
# update_pause_refresher_start, killed+cleared by update_cleanup so a long confirm
# wait cannot let the flag age past its TTL and un-pause the daemon mid-update.
_update_pause_refresher_pid=""
_update_lock_acquired=0
_update_workdir=""
_update_clean_paths=""
_update_staging=""
_update_snapshot=""
# Vendor-removal sweep (#14) run state: the confirmed removal set + per-run Trash
# sink + install root. SET in update_sweep_removed_files, READ by the removal
# commit callback — which runs on the confirm gate's pipe-RHS subshell, so the
# values travel through globals (the gate owns stdin; the same carrier pattern as
# _update_clean_paths for the swap callback).
_update_removal_paths=""
_update_removal_root=""
_update_removal_dest=""

# P3 headless / web-triggered orchestration run state (see the file header). Mode
# flag + DB update_job tracking state + the resolved running-script dir (for the
# fixed-path render-parity resolution). All default to the interactive no-DB path.
_update_headless=0
_update_job_id=""
_update_job_final=0
_update_target_version=""
_update_script_dir=""

# Agent EDITABLE-region merge (E4 / T19) run state. The merge lib dir + update
# state dir are resolved once (update_main / the merge fn); the per-candidate
# verify context globals are SET right before each git_txn_apply call and READ by
# the injected verify callback (git_txn_apply hands the verify_fn only the target,
# so the remaining anchors travel through these globals — the same sourced-lib
# caller-scope contract git-txn.sh documents).
_update_merge_lib_dir=""
_update_state_dir=""
_update_agent_install_root=""
_update_agent_backup_dir=""
_update_agent_records_file=""
# Per-run agent-merge OUTCOME ledger (finding #9): one basename per line = the
# base-content store MAY advance for that file (its merge actually landed — applied
# GIT_TXN_OK, byte-identical, or resolved with no net change). Every other outcome
# (declined / rolled-back / refused / structural / plan-failed) is ABSENT, so the
# capture keeps its prior base entry. File-backed (not a shell var) because the
# commit callback runs on the gate's pipe-RHS subshell.
_update_agent_outcomes_file=""
_update_agent_verify_local=""
_update_agent_verify_release=""
_update_agent_verify_agent=""
_update_agent_verify_target=""

# Preserve a failed/interrupted apply's pre-swap snapshot so the operator keeps a
# rollback source after the workdir is torn down (finding #7). No-op when the
# snapshot is unset, missing, or EMPTY (the swap never mutated a live file, so
# there is nothing to recover). Copies — never moves — the snapshot into a
# persistent, timestamped dir BESIDE the agents-bak rollback store (cross-FS-safe:
# the workdir lives under $TMPDIR while agents-bak sits in the install area) and
# prints the path. Best-effort + fully guarded so a cleanup trap never aborts on it.
update_preserve_snapshot() {
  local snap="${_update_snapshot}" root base parent dest ts probe
  [[ -n "${snap}" && -d "${snap}" ]] || return 0
  # Empty snapshot → nothing was swapped → nothing worth preserving.
  probe="$(find "${snap}" -mindepth 1 -print -quit 2>/dev/null || true)"
  [[ -n "${probe}" ]] || return 0
  root="$(update_ga_root)"
  base="$(update_agents_bak_base "${root}")"
  parent="$(dirname -- "${base}")"
  ts="$(date +%Y%m%d-%H%M%S)"
  dest="${parent}/update-failed-snapshots/${ts}_$$"
  if mkdir -p -- "${dest}" 2>/dev/null && cp -Rp -- "${snap}/." "${dest}/" 2>/dev/null; then
    update_log "PRESERVED pre-swap snapshot from a failed/interrupted apply → ${dest}"
    update_log "  recover by restoring those files back under ${root}"
  else
    update_log "WARN: could not preserve the pre-swap snapshot (${snap}) — inspect it before it is removed"
  fi
}

# Single idempotent cleanup: remove ONLY what this run created. Registered on
# EXIT INT TERM so the pause flag clears and the daemon resumes on any exit path —
# the trap-guarded quiesce/restore the T10 contract requires.
update_cleanup() {
  local exit_code=$?
  # Headless DB-job finalization: any exit that did NOT already mark the row
  # 'completed' (update_die, a declined confirm gate, a crash caught by the trap)
  # leaves an in-progress row → mark it 'failed' with the exit code so the P3-T3
  # stale sweep + the web UI never observe a phantom-active job. Best-effort +
  # WHERE-guarded on status='in-progress' (a stale-sweep 'failed' is never
  # clobbered). No-op in the interactive path (no job row opened).
  if [[ "${_update_headless}" -eq 1 && -n "${_update_job_id}" && "${_update_job_final}" -ne 1 ]]; then
    update_job_fail "aborted (exit=${exit_code})"
  fi
  if [[ "${_update_lock_acquired}" -eq 1 ]]; then
    # Path-guarded rm -rf (via the shared lib) — the lock dir now holds a pid
    # file, so a bare rmdir would fail; the lib releases ONLY a lock we still own.
    apply_lock_release "$(update_apply_lock_dir)"
    _update_lock_acquired=0
  fi
  # Stop the pause-flag heartbeat refresher BEFORE removing the flag (finding #14):
  # kill-before-remove so the background refresher can never recreate the flag after
  # update_pause_remove deletes it — closing the recreate-after-removal race on every
  # EXIT/INT/TERM path (including a declined update_die and Ctrl-C).
  update_pause_refresher_stop
  if [[ "${_update_pause_created}" -eq 1 ]]; then
    update_pause_remove
    _update_pause_created=0
  fi
  if [[ -n "${_update_workdir}" && -d "${_update_workdir}" ]]; then
    # Snapshot preservation (finding #7): a swap that BEGAN but did NOT commit
    # cleanly leaves the pre-swap snapshot as the ONLY rollback source, yet the
    # workdir rm below would destroy it. The committing callback drops a
    # `.commit-ok` marker on a clean apply; its ABSENCE beside a non-empty snapshot
    # means a failed/interrupted apply — preserve that snapshot BESIDE agents-bak
    # before tearing the workdir down (no-op when the snapshot is empty = nothing
    # was swapped).
    if [[ ! -f "${_update_workdir}/.commit-ok" ]]; then
      update_preserve_snapshot
    fi
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
  # Set _update_pause_created ONLY on create success. A refusal (rc 1) means a fresh
  # flag is already held by a live foreign updater → abort WITHOUT touching it; the
  # flag stays 0 so the EXIT trap skips removal and the winner's flag survives.
  if ! update_pause_create >/dev/null; then
    update_die "another apply is in progress (pause flag held by a live updater)"
  fi
  _update_pause_created=1
  # Ensure the reports dir exists (same as daemon-apply.sh) so the lock mkdir
  # fails ONLY on genuine contention, not a missing parent.
  mkdir -p -- "$(update_reports_dir)"
  lock_dir="$(update_apply_lock_dir)"
  # Shared stale-reclaim acquire: a crashed daemon (SIGKILL, no EXIT trap) leaves
  # a stranded lock that the lib reclaims once the holder is not-live AND aged
  # past the TTL — so the updater no longer loud-fails forever on a dead lock. A
  # LIVE daemon apply still blocks here (writer mutual exclusion preserved).
  apply_lock_acquire "${lock_dir}"
  if [[ "${apply_lock_acquired}" != true ]]; then
    update_die "another apply is in progress (lock held): ${lock_dir}"
  fi
  _update_lock_acquired=1
  # Start the pause-flag heartbeat refresher LAST, once the flag + lock are held, so a
  # long interactive confirm wait cannot let the flag age past its TTL (finding #14).
  update_pause_refresher_start
}

# Start ONE liveness-guarded background refresher for the whole serialized section
# (finding #14): re-write the pause flag every tick so its mtime never ages past the
# 1800s TTL during a long interactive confirm wait — which would otherwise let the
# daemon treat the flag as crashed-updater residue and un-pause mid-update. The
# `kill -0 "${updater_pid}"` parent guard PRESERVES the TTL's crash-safety purpose: a
# SIGKILLed updater (no EXIT trap) makes the next tick's guard fail, the refresher
# exits within one tick, the flag then ages out and update_pause_is_active reclaims
# it. `$$` inside a ( ) subshell stays the PARENT updater pid, so the refresher's
# update_pause_create takes the own-pid heartbeat-refresh path (never the finding #15
# live-foreign-owner refusal). Tick default 600s (ample margin under the TTL);
# ATRIUM_UPDATE_PAUSE_REFRESH_SECS overrides for tests. Arg: $1 = pid to watch
# (default $$ — the updater), a test seam for the parent-death path.
update_pause_refresher_start() {
  local updater_pid="${1:-$$}" tick="${ATRIUM_UPDATE_PAUSE_REFRESH_SECS:-600}"
  # fd1/fd2 are detached to /dev/null so the background subshell (and its sleep child)
  # NEVER hold an inherited stdout pipe open — else a captured pipe (the bats harness
  # reads the parent's pipe to EOF) would wedge for a full tick after the parent exits.
  # The TERM trap kills the in-flight sleep child too, so update_pause_refresher_stop's
  # `kill` leaves NO stray sleep process (killing the subshell alone would orphan it).
  (
    trap 'if [[ -n "${_ga_sleep_pid:-}" ]]; then kill "${_ga_sleep_pid}" 2>/dev/null || true; fi; exit 0' TERM
    while kill -0 "${updater_pid}" 2>/dev/null; do
      update_pause_create >/dev/null 2>&1 || true
      sleep "${tick}" &
      _ga_sleep_pid=$!
      wait "${_ga_sleep_pid}" 2>/dev/null || true
    done
  ) >/dev/null 2>&1 &
  _update_pause_refresher_pid=$!
}

# Stop the background pause-flag refresher (finding #14): kill + reap + clear the pid.
# Idempotent (no refresher running → rc 0). Called from update_cleanup BEFORE the flag
# is removed so the refresher can never recreate the flag after removal.
update_pause_refresher_stop() {
  [[ -n "${_update_pause_refresher_pid}" ]] || return 0
  kill "${_update_pause_refresher_pid}" 2>/dev/null || true
  wait "${_update_pause_refresher_pid}" 2>/dev/null || true
  _update_pause_refresher_pid=""
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
# Lexical relpath normalization — resolves `.` / `..` / empty segments WITHOUT
# touching the filesystem. Prints the normal form on rc 0. Un-normalizable input
# (absolute path, escape above root via leading `..`, or an empty result) → rc 1,
# so the caller fails CLOSED: a spelling variant like `agents/NAME.md/.` or
# `agents/../NAME.md` can no longer dodge the helper's basename-anchored regex
# and get a false CLEAN verdict (manifest paths are always relative).
update_normalize_relpath() {
  local input="$1" seg joined
  local -a segs=() out=()
  [[ "${input}" == /* ]] && return 1
  IFS='/' read -r -a segs <<<"${input}"
  for seg in "${segs[@]+"${segs[@]}"}"; do
    case "${seg}" in
      '' | '.') ;;
      '..')
        [[ ${#out[@]} -gt 0 ]] || return 1
        unset "out[$((${#out[@]} - 1))]"
        ;;
      *) out+=("${seg}") ;;
    esac
  done
  [[ ${#out[@]} -gt 0 ]] || return 1
  joined="$(
    IFS='/'
    printf '%s' "${out[*]}"
  )"
  printf '%s\n' "${joined}"
}

update_partition_sensitive() {
  local clean_out="$1" sensitive_out="$2" path norm
  : >"${clean_out}"
  : >"${sensitive_out}"
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    # Verdict on the NORMAL form; bucket entries keep the original spelling
    # (downstream sync consumes the manifest-relative path as listed).
    if norm="$(update_normalize_relpath "${path}")" && sensitive_path_ok "${norm}"; then
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
#   * the agents/<name>.md file set (top-level only; references/ +
#     GLASS_ATRIUM_GLOBAL_RULES.md excluded — they are not agents)
#   * the agent-registry.json `.agents` object keys (the authoritative roster)

# Emit (one per line) the agent NAMES a manifest declares via its files[] — the
# top-level agents/<name>.md entries, with the references/ subtree and the
# non-agent GLASS_ATRIUM_GLOBAL_RULES.md charter excluded. Empty when the manifest is absent
# or unparseable (the comparison degrades to the other signal, never errors).
update_roster_names_from_manifest() {
  local manifest="$1"
  [[ -f "${manifest}" ]] || return 0
  jq -r '
    .files[]
    | select(type == "string")
    | select(test("^agents/[^/]+\\.md$"))
    | sub("^agents/"; "") | sub("\\.md$"; "")
    | select(. != "GLASS_ATRIUM_GLOBAL_RULES")
  ' -- "${manifest}" 2>/dev/null || true
}

# Emit (one per line) the agent NAMES present as top-level agents/<name>.md files
# under an install root (filesystem glob, non-recursive so references/ is skipped),
# with GLASS_ATRIUM_GLOBAL_RULES.md excluded. Empty when the agents dir is absent.
update_roster_names_from_dir() {
  local root="$1" file base
  # No `nullglob` (unsafe to set in a sourced lib) — guard each match instead so
  # an empty agents/ dir yields the literal glob, which the -e test rejects.
  for file in "${root}"/agents/*.md; do
    [[ -e "${file}" ]] || continue
    base="${file##*/}"
    base="${base%.md}"
    [[ "${base}" == 'GLASS_ATRIUM_GLOBAL_RULES' ]] && continue
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

# Fail-closed consistency check for the ATRIUM_UPDATE_ALLOW_ROSTER override (finding
# #16). When the override proceeds past a detected roster ADD, the deterministic sync
# WOULD swap in the release agent-registry.json, but the E4 merge SKIPS a release-only
# ADD's agents/<name>.md — so registering the agent WITHOUT its body leaves a
# PERMANENTLY half-applied roster (a registry key whose .md never landed, thereafter
# masked by the union-based local roster on every later update). Emit (one per line)
# the new-registry agent NAMES whose live agents/<name>.md is absent — the orphan-adds
# whose presence means the registry sync MUST be withheld. Empty when the incoming
# registry is absent/unparseable or every referenced body is present locally. Args:
# $1 = new-tree agent-registry.json · $2 = install root.
update_roster_orphan_registry_adds() {
  local new_registry="$1" install_root="$2" name
  [[ -f "${new_registry}" ]] || return 0
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    [[ -e "${install_root}/agents/${name}.md" ]] && continue
    printf '%s\n' "${name}"
  done < <(update_roster_keys_from_registry "${new_registry}")
}

# Symmetric REMOVE-direction counterpart to update_roster_orphan_registry_adds
# (finding #16). Under ATRIUM_UPDATE_ALLOW_ROSTER a release that DROPS a vendor
# agent correctly swaps in the new (agent-less) registry — but agents/<name>.md is
# USER-EDITABLE, deliberately EXCLUDED from the vendor sweep, so the body LINGERS on
# disk with no registry key: a silent orphan the roster gate never re-detects (it
# keys removals on the prior-vendor baseline, which the just-advanced baseline no
# longer carries). Emit (one per line) each prior-vendor agent NAME the new release
# dropped whose agents/<name>.md is still present — the leftover bodies to surface
# for MANUAL review (NOT auto-removed; the registry is NOT withheld — the drop is
# intended). Provenance-scoped like the gate's remove side: a USER-added local-only
# agent (never in the baseline) is not a vendor drop and never appears here. Empty
# when no vendor drop has a lingering body. Args: $1 = new manifest · $2 = new
# registry · $3 = install root · $4 = prior-vendor baseline manifest.
update_roster_orphan_registry_removes() {
  local new_manifest="$1" new_registry="$2" install_root="$3" baseline_manifest="${4:-}"
  local new_list prior_vendor name
  new_list="$(update_roster_new "${new_manifest}" "${new_registry}")"
  prior_vendor="$(update_roster_prior_vendor "${baseline_manifest}")"
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    [[ -e "${install_root}/agents/${name}.md" ]] || continue
    printf '%s\n' "${name}"
  done < <(LC_ALL=C comm -23 <(printf '%s\n' "${prior_vendor}") <(printf '%s\n' "${new_list}"))
}

# Remove the exact whole-line path $2 from the clean apply-set file $1 (finding #16
# registry withholding). Fixed-string, whole-line match (a manifest-relative path);
# atomic temp+rename. Best-effort: a no-match / now-empty set is a normal result.
update_filter_clean_path() {
  local clean_file="$1" drop="$2" tmp
  [[ -f "${clean_file}" ]] || return 0
  tmp="${clean_file}.filter.$$"
  grep -vxF -- "${drop}" "${clean_file}" >"${tmp}" 2>/dev/null || true
  mv -f -- "${tmp}" "${clean_file}"
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
# non-agent path AND is applied through the shared git-free git_txn_apply
# transaction (before-image → apply → verify → leave|restore). Reuse only — no
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

# Resolve a (possibly facade-symlink) path to its real location so the before-image
# capture + copy-apply act on the REAL file rather than a symlink (mirrors the
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
#   1 merge_lib  2 target(logical)  3 local(the pre-apply before-image in
#   agents-bak — the single authoritative original-local copy)  4 release
#   5 base(or "")  6 agent  7 state_dir  8 on_disk(the patched target)
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
# from the before-image in agents-bak and roll back.
#
# shellcheck disable=SC2329
#   Invoked INDIRECTLY as the verify callback NAME injected into git_txn_apply.
_update_agent_verify() {
  local on_disk="$1"
  python3 -c "${_UPDATE_VERIFY_PY}" \
    "${_update_merge_lib_dir}" "${_update_agent_verify_target}" \
    "${_update_agent_verify_local}" "${_update_agent_verify_release}" \
    "" "${_update_agent_verify_agent}" "${_update_state_dir}" "${on_disk}" >&2 || return 1
  return 0
}

# Record a base-content ADVANCE for an agent basename in the per-run outcome ledger
# (finding #9). Append-only; a no-op when no ledger is active (a caller that ran no
# merge). Called from BOTH the parent merge loop (pre-gate advances) and the commit
# callback's pipe-RHS subshell — the file append is the shared-state carrier.
update_agent_outcome_advance() {
  [[ -n "${_update_agent_outcomes_file}" ]] || return 0
  printf '%s\n' "$1" >>"${_update_agent_outcomes_file}"
}

# The committing callback the foreground gate invokes ONLY on explicit confirm.
# Iterates the collected candidate records (TSV: logical, real, candidate,
# release, agent) and drives each through git_txn_apply. Each file is an
# independent transaction — a verify failure rolls back that file alone and is
# reported LOUDLY; the rest still apply. rc 3 when any file rolled back / did
# not apply: 3 is deliberately DISJOINT from gate_apply_confirmed's own verdict
# codes (1 = declined, 2 = empty set) because the gate propagates a callback rc
# verbatim — a colliding 1 would summarize a rolled-back run as "declined".
#
# shellcheck disable=SC2329
#   Passed by NAME to gate_apply_confirmed (`"$@"`), never called by `()` here.
_update_agent_commit_callback() {
  local logical real candidate release agent rc=0
  while IFS=$'\t' read -r logical real candidate release agent; do
    [[ -n "${logical}" ]] || continue
    _update_agent_verify_target="${logical}"
    # The verify anchor for the ORIGINAL local body is the PERSISTENT agents-bak
    # before-image git_txn_apply captures pre-apply (single authoritative copy —
    # the same one --restore-agents reads; no ephemeral duplicate). Path mirrors
    # _git_txn_capture_before_image: <backup_dir>/<real basename>.bak. The file
    # exists by the time the verify callback runs (capture precedes apply; a
    # capture failure aborts before apply and never reaches verify).
    _update_agent_verify_local="${_update_agent_backup_dir}/${real##*/}.bak"
    _update_agent_verify_release="${release}"
    _update_agent_verify_agent="${agent}"
    GIT_TXN_RC=""
    # BARE invocation (git-txn.sh header contract): it returns 0 for every handled
    # outcome and reports the structured result in GIT_TXN_RC. target == real_target
    # (real path) since GA uses no facade symlinks in the install tree; the candidate
    # file rides the diff slot to _update_agent_apply, and the run's agents-bak dir is
    # the before-image sink the git-free transaction captures + restores from.
    git_txn_apply \
      "${_update_agent_install_root}" "${real}" "${real}" "${candidate}" \
      "${_update_agent_backup_dir}" \
      _update_agent_apply _update_agent_verify "${agent}" "${logical}"
    case "${GIT_TXN_RC}" in
      "${GIT_TXN_OK}")
        update_log "agent merged + applied: ${logical}"
        # Applied cleanly → the base-content store may advance for this file
        # (finding #9). Any other GIT_TXN outcome leaves the file at its local
        # version, so it is deliberately NOT recorded (the capture keeps its prior
        # base entry). File append survives this pipe-RHS subshell.
        update_agent_outcome_advance "${logical##*/}"
        ;;
      "${GIT_TXN_VERIFY_FAIL}")
        update_log "WARN: agent merge verify failed — ${logical} restored from its before-image (left at local version)"
        rc=3
        ;;
      "${GIT_TXN_BACKUP_CAPTURE_FAIL}")
        update_log "WARN: agent merge aborted before apply (before-image capture failed) — ${logical} untouched"
        rc=3
        ;;
      "${GIT_TXN_APPLY_REGEN}" | "${GIT_TXN_APPLY_FAIL}")
        update_log "WARN: agent merge not applied (GIT_TXN_RC=${GIT_TXN_RC}) — ${logical} left at its local version"
        rc=3
        ;;
      *)
        update_log "WARN: agent merge unexpected outcome (GIT_TXN_RC=${GIT_TXN_RC}) — ${logical} left at its local version"
        rc=3
        ;;
    esac
  done <"${_update_agent_records_file}"
  return "${rc}"
}

# Drive the three-anchor agent merge for every changed agents/<name>.md. Args:
# $1 = new-release tree root · $2 = new manifest (its .version names the per-run
# agents-bak before-image dir) · $3 = live install root.
update_merge_agent_editable_regions() {
  local new_dir="$1" manifest="$2" root="$3"
  : "${manifest:?manifest}"
  local merge_dir records_file gate_records=""
  local file base local_file candidate plan_err plan_line plan_rc
  local verdict changed n_candidates=0 rc=0
  local backup_base cycle_date version

  _update_merge_lib_dir="${ATRIUM_UPDATE_MERGE_LIB_DIR:-${_update_merge_lib_dir}}"
  _update_state_dir="$(spine_baseline_dir)"

  merge_dir="$(mktemp -d -t glass-atrium-agent-merge.XXXXXX)"
  records_file="${merge_dir}/records.tsv"
  : >"${records_file}"

  # Fresh per-run base-content outcome ledger (finding #9). It must OUTLIVE
  # merge_dir (rm'd below, before update_capture_base_content reads the ledger), so
  # anchor it in the run workdir (torn down by the EXIT trap — no leak); a caller
  # with no workdir (direct unit test) gets an mktemp fallback.
  if [[ -n "${_update_workdir}" && -d "${_update_workdir}" ]]; then
    _update_agent_outcomes_file="${_update_workdir}/agent-outcomes.ledger"
  else
    _update_agent_outcomes_file="$(mktemp -t glass-atrium-agent-outcomes.XXXXXX)"
  fi
  : >"${_update_agent_outcomes_file}"

  # Collect a candidate per changed, mergeable agent file. agents/<name>.md is
  # top-level only (references/ + the non-agent GLASS_ATRIUM_GLOBAL_RULES.md charter excluded,
  # same scoping as the roster scan).
  for file in "${new_dir}"/agents/*.md; do
    [[ -e "${file}" ]] || continue
    base="${file##*/}"
    [[ "${base}" == 'GLASS_ATRIUM_GLOBAL_RULES.md' ]] && continue
    local_file="${root}/agents/${base}"
    if [[ ! -f "${local_file}" ]]; then
      update_log "agent merge: ${base} is release-only (ADD) — defer to the agent_lifecycle ceremony, skipping"
      continue
    fi
    # Byte-identical → nothing to merge (equivalent to plan changed=False). Local
    # already equals the release, so the base-content store may advance (finding #9).
    if cmp -s -- "${local_file}" "${file}"; then
      update_agent_outcome_advance "${base}"
      continue
    fi

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
      # No net change → the resolved body is stable, so the base may advance (finding #9).
      update_agent_outcome_advance "${base}"
      continue
    fi

    # A mergeable candidate. Queue the record + the gate preview row (current =
    # live local, proposed = merged candidate). NO ephemeral local backup here:
    # the ORIGINAL local body the verify anchors on is the persistent agents-bak
    # before-image git_txn_apply captures pre-apply — the SINGLE authoritative
    # copy (P2-T2), derived per-file by the commit callback.
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "agents/${base}" "$(update_realpath "${local_file}")" "${candidate}" \
      "${file}" "${base%.md}" >>"${records_file}"
    gate_records="${gate_records}$(printf 'agents/%s\t%s\t%s' "${base}" "${local_file}" "${candidate}")"$'\n'
    n_candidates=$((n_candidates + 1))
  done

  if [[ "${n_candidates}" -eq 0 ]]; then
    update_log "agent EDITABLE-region merge: no agent files to merge"
    rm -rf -- "${merge_dir}"
    return 0
  fi

  # The transaction is git-FREE: git_txn_apply captures a before-image copy and
  # atomically restores from it (no repo lookup, no worktree), so the merge proceeds
  # on ANY install whether or not it is a git repo.

  # Foreground confirm (the SAME T12 gate as the non-agent path), then the per-file
  # git_txn transactions on explicit confirm. The agent merge is best-effort and
  # NON-fatal to the (already-applied) non-agent sync: a decline simply leaves the
  # agent files unmerged.
  _update_agent_install_root="${root}"
  _update_agent_records_file="${records_file}"
  # Per-run before-image sink for the git-free transaction: a ROOT-SIBLING
  # agents-bak/<cycle_date>_update-<version> dir (env override shares the daemon's
  # AUTOAGENT_BACKUP_DIR base var). Root-sibling so git ls-files never lists it and
  # tar merge-extract never clobbers it; the per-run subdir groups this run's
  # <agent>.md.bak images for retention prune. git_txn_apply captures + restores
  # from here (never commits). The base is derived by the shared
  # update_agents_bak_base helper — the SAME computation the prune/restore paths read,
  # so this write side and that read side can never drift apart.
  backup_base="$(update_agents_bak_base "${root}")"
  cycle_date="$(date +%Y-%m-%d)"
  version="$(jq -r '.version // "unknown"' "${manifest}")"
  _update_agent_backup_dir="${backup_base}/${cycle_date}_update-${version}"
  printf '%s' "${gate_records}" | gate_apply_confirmed _update_agent_commit_callback || rc=$?
  # rc namespace: 0/1/2 are the gate's own verdicts; 3 is the commit callback's
  # rolled-back/unapplied signal propagated verbatim through the gate (kept
  # disjoint from 1/2 so a confirmed run with a failed file never reads "declined").
  case "${rc}" in
    0) update_log "agent EDITABLE-region merge applied (${n_candidates} file(s))" ;;
    1) update_log "agent EDITABLE-region merge declined — agent files left unmerged" ;;
    2) update_log "agent EDITABLE-region merge: no changes to confirm" ;;
    *) update_log "WARN: agent EDITABLE-region merge had rolled-back or unapplied file(s) — see the per-file outcome above" ;;
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
#
# OUTCOME-KEYED (finding #9): the base store advances ONLY for a file whose merge
# actually LANDED — recorded in the per-run ledger update_merge_agent_editable_regions
# built (applied GIT_TXN_OK, byte-identical, or no net change). A declined /
# rolled-back / refused / structural / plan-failed merge is ABSENT from the ledger, so
# its prior base entry is KEPT untouched — blindly advancing it to the un-accepted
# release body would make the NEXT 3-way merge treat that vendor change as already in
# the base and silently swallow it forever. With no ledger (a direct caller that ran
# no merge) the prior blanket advance is preserved so a legacy caller is unchanged.
update_capture_base_content() {
  local new_dir="$1" store file base count=0 kept=0
  local ledger="${_update_agent_outcomes_file}"
  store="$(update_base_store_dir)"
  mkdir -p -- "${store}"
  # Load the per-run merge ledger ONCE (bash `$(<file)` — zero forks) into a
  # newline-wrapped string, then test membership per file with a fork-free `[[ ==
  # pattern ]]` whole-line scan (the newline anchors mirror `grep -qxF`). Replaces
  # the prior per-file grep fork (O(files) subprocesses), matching the diff's own
  # fork-free hoist pattern (spine_find_removed_files). `declare -A` is NOT usable —
  # stock macOS bash 3.2 has no associative arrays. ledger_active gates the lookup:
  # with no active ledger (a direct/legacy caller that ran no merge) the prior
  # blanket advance is preserved.
  local ledger_active=0 ledger_lines=""
  if [[ -n "${ledger}" && -f "${ledger}" ]]; then
    ledger_active=1
    ledger_lines=$'\n'"$(<"${ledger}")"$'\n'
  fi
  for file in "${new_dir}"/agents/*.md; do
    [[ -e "${file}" ]] || continue
    base="${file##*/}"
    # An active ledger that does NOT list this basename → the file's merge did not
    # land → keep its prior base entry (do not advance).
    if [[ "${ledger_active}" -eq 1 && "${ledger_lines}" != *$'\n'"${base}"$'\n'* ]]; then
      kept=$((kept + 1))
      continue
    fi
    # finding #9 part 4: before overwriting a PRIOR base entry, snapshot it beside
    # this run's live before-image (<name>.md.base.bak next to <name>.md.bak) so
    # --restore-agents can reverse the base store, not just the live body. Gated on
    # the live before-image existing: ONLY a git_txn-APPLIED file is restorable, so
    # only it needs a base snapshot — a byte-identical / no-net-change advance has no
    # <name>.md.bak and is never restored. The gate also guarantees the cycle dir
    # exists (it holds that .bak). A prior base entry MUST exist to snapshot; its
    # absence is the "first base for this agent" case restore reverses by DELETING
    # the entry. Best-effort + LOUD: a failed snapshot degrades that file's restore
    # to the safe base-DELETE fallback (gated 2-way), never aborts the capture.
    if [[ -n "${_update_agent_backup_dir}" &&
      -f "${_update_agent_backup_dir}/${base}.bak" &&
      -f "${store}/${base}" ]]; then
      spine_atomic_swap "${store}/${base}" "${_update_agent_backup_dir}/${base}.base.bak" \
        || update_log "WARN: prior base snapshot failed for ${base} — --restore-agents will DELETE its base entry (safe gated 2-way fallback)"
    fi
    if cp -p -- "${file}" "${store}/${base}"; then
      count=$((count + 1))
    else
      update_log "WARN: base-content capture failed for ${base} (next update falls back to gated 2-way for it)"
    fi
  done
  update_log "base-content store updated: ${count} advanced, ${kept} kept at prior base → ${store}"
  # One-shot ledger: reset so a later capture in the same process never reads a
  # stale set (the workdir teardown removes the file itself).
  _update_agent_outcomes_file=""
}

# ---------------------------------------------------------------------------
# Facade mirror-farm refresh — incident #58325 systemic fix
# ---------------------------------------------------------------------------
#
# After a successful apply, every NEWLY-shipped manifest file must gain its
# ~/.claude facade mirror — pre-wiring, nothing re-ran the symlink farm after
# install time, so each new release file shipped WITHOUT its mirror (incident
# #58325: scripts/lib/apply-lock.sh). Runs in EVERY entry mode (interactive
# TTY, headless launchd, web button) — deliberately NOT gated behind the
# headless-only post-step. Two steps, order load-bearing:
#   1. PERSIST the downloaded manifest to ${root}/manifest.json (install-parity
#      — install.sh::install_tree does the same; manifest.json is a release
#      asset, not a .files member, so the spine sync never writes it). The farm,
#      prune, and every later `agents-only` read ${GA_ROOT}/manifest.json —
#      skipping this would silently miss exactly the newly-added files
#      (stale-root-manifest trap) and would key prune on the OLD file set.
#   2. REFRESH the farm via the canonical entrypoint (shared lib ->
#      `glass-atrium agents-only`, a subprocess — never source ga-core.sh
#      in-process: readonly GA_ROOT/TARGET_HOME + bare log()/die() collide).
#      The scope passed is FILTERED to sources present under ${root}
#      (farm_write_present_manifest): a release file the sensitive partition
#      REFUSED to auto-sync is listed in the new manifest but missing from the
#      tree — unfiltered, swap_symlink would hard-die "manifest source missing"
#      on every update until manual review (warn+skip is the update contract).

# Persist + refresh, then surface orphan mirrors as a --dry-run ADVISORY only
# (prune stays explicit-opt-in by ga-core.sh design). Farm failure -> named
# exit 11 with "files applied, mirror refresh failed" semantics (the exit-9
# post-step precedent); NEVER rolls back the applied files. Arg: $1 = the
# downloaded/applied manifest.json.
update_refresh_mirror_farm() {
  local manifest="$1" root filtered tmp rc=0
  root="$(update_ga_root)"

  # Step 1 — persist (temp + rename: a concurrent manifest reader never sees a
  # half-written file). WARN-not-fatal: the refresh below reads the FILTERED
  # per-run scope, not this copy.
  tmp="${root}/manifest.json.ga-update.$$"
  if cp -p -- "${manifest}" "${tmp}" && mv -f -- "${tmp}" "${root}/manifest.json"; then
    update_log "root manifest persisted (install-parity): ${root}/manifest.json"
  else
    rm -f -- "${tmp}" 2>/dev/null || true
    update_log "WARN: could not persist the release manifest to ${root}/manifest.json — root scope stays stale until the next update"
  fi

  # Step 2 — filtered refresh via the canonical entrypoint (shared lib).
  filtered="${_update_workdir}/farm-manifest.json"
  if ! farm_write_present_manifest "${root}" "${manifest}" "${filtered}"; then
    update_die_code 11 "mirror-farm scope filter failed — update files applied but the facade mirror was NOT refreshed; run '${root}/glass-atrium agents-only' manually"
  fi
  farm_refresh "${root}" "${filtered}" || rc=$?
  case "${rc}" in
    0)
      # refreshed — orphan-mirror report only (removal stays explicit-opt-in).
      farm_prune_advisory "${root}"
      ;;
    3) : ;; # cleanly skipped (no facade home / no launcher) — logged by the lib
    *)
      update_die_code 11 "mirror-farm refresh failed (rc=${rc}) — update files applied but the facade mirror was NOT refreshed; run '${root}/glass-atrium agents-only' manually"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Post-apply hook-binding reconciliation — settings.json wire (install-parity)
# ---------------------------------------------------------------------------
#
# The file apply + mirror-farm refresh (above) deploy the new release's hook
# FILES and their ~/.claude mirrors, but the EVENT->HOOK BINDINGS live ONLY in
# settings.json — which the deterministic spine NEVER writes (settings.json is
# user-owned + sensitive-partitioned). Pre-wiring, an update that ADDED or
# CHANGED a hook binding shipped the new hook file yet left settings.json pinned
# to the OLD binding set, so the new hook stayed DORMANT until the next full
# install (the "update completes but the bindings stay stale" class). Install
# wires them (run_install: run_symlink_farm -> wire_hooks); update_run never did.
#
# Fix: after a VERIFIED apply + farm refresh, reconcile settings.json to the
# JUST-APPLIED hook binding set via the canonical `glass-atrium wire-hooks`
# subcommand — the SAME idempotent, timestamped-backup MERGE install uses (adds
# only MISSING Atrium bindings, preserves every user-owned key, backs up
# settings.json before mutating, LOUD-FAILS on a malformed settings.json). The
# bindings come from the just-applied launcher's embedded ga-core.sh
# EXPECTED_HOOK_BINDINGS, so a release that adds a binding gets it wired.
#
# Subprocess by design (the update_refresh_mirror_farm / mirror-farm.sh
# precedent): sourcing ga-core.sh in-process would collide with this caller on
# readonly GA_ROOT/TARGET_HOME + the bare log()/die() names. Runs in EVERY entry
# mode (interactive TTY, headless launchd, web button) — placed on the shared
# update_run path, NOT the headless-only finalize, so the DECOUPLED launchd
# update reconciles bindings too. Ordering is load-bearing: it runs ONLY after
# the confirmed apply + farm refresh SUCCEEDED, so the atomic-restore/rollback
# contract stays intact (a declined/failed apply exits before ever reaching here)
# and the hook FILES the new bindings point at already exist on disk.
#
# Precondition (loud, no silent absorption): the just-applied launcher must be
# present + executable. A missing/non-executable launcher is a WARN skip
# (mirrors farm_refresh's launcher-missing return 3 — nothing to invoke; the
# read-only doctor §6 check still surfaces the dormant bindings). A launcher that
# IS present but whose wire_hooks FAILS (malformed settings.json, unwritable
# target) is a loud NAMED exit 12 — never `2>/dev/null` / `|| true` absorbed. No
# rollback of the already-applied files (the mirror-farm exit-11 precedent:
# post-apply steps report their OWN failure; they never unwind the apply). Arg:
# none (resolves the launcher under update_ga_root, same as the farm refresh).
update_wire_hooks_post_apply() {
  local root launcher rc=0
  root="$(update_ga_root)"
  launcher="${root}/glass-atrium"
  if [[ ! -x "${launcher}" ]]; then
    update_log "WARN: launcher missing or not executable (${launcher}) — settings.json hook bindings were NOT reconciled; run '${launcher} wire-hooks' after repairing the install"
    return 0
  fi
  update_log "reconciling settings.json hook bindings (install-parity): ${launcher} wire-hooks"
  "${launcher}" wire-hooks || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    update_die_code 12 "hook-binding wiring failed (rc=${rc}) — update files applied + mirror refreshed, but the settings.json event->hook bindings were NOT reconciled to the new release; run '${launcher} wire-hooks' manually"
  fi
  update_log "settings.json hook bindings reconciled to the applied release"
}

# ---------------------------------------------------------------------------
# P3 — headless update_job DB tracking (psql; daemon-apply.sh idiom)
# ---------------------------------------------------------------------------
#
# HEADLESS-ONLY: every function below no-ops unless _update_headless=1, so the
# interactive/CLI path keeps the E3 no-DB boundary (it never touches Postgres).
# Single-active-job is the migration's partial UNIQUE INDEX
# (update_job_single_active_uniq WHERE status='in-progress'); a 2nd concurrent
# INSERT trips its unique violation, which update_job_begin catches → exit 8.

# rc 0 when DB status tracking should run: not explicitly disabled AND the psql
# client resolves. Absent psql (OSS no-DB host) degrades to best-effort — the file
# apply still succeeds, only the DB row is skipped (mirrors daemon-apply.sh).
update_db_enabled() {
  [[ "${ATRIUM_UPDATE_DB:-on}" != "off" ]] || return 1
  command -v "${ATRIUM_UPDATE_PSQL:-psql}" >/dev/null 2>&1 || return 1
  return 0
}

# psql wrapper — unix-socket auth via -d, ON_ERROR_STOP + tuples-only unaligned
# quiet output, exactly as daemon-apply.sh update_db_status. The SQL arrives on
# stdin (heredoc) so psql's `:'var'` preprocessor binds every value — NO shell SQL
# concat (injection-safe for a version string / failure reason carrying metachars).
update_db_psql() {
  "${ATRIUM_UPDATE_PSQL:-psql}" -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" \
    -v ON_ERROR_STOP=1 -tAq "$@"
}

# Open (or adopt) the update_job row. Headless only. Precedence:
#   * ATRIUM_UPDATE_JOB_ID set → ADOPT it (the web route pre-INSERTed the row to
#     catch the single-active unique violation synchronously in the request, then
#     handed the id to this decoupled job) — no INSERT, just heartbeat it.
#   * else INSERT status='in-progress' RETURNING id. The partial UNIQUE INDEX
#     rejects a 2nd in-progress row → a unique violation here is "another update in
#     progress" → loud-fail exit 8 (single-active). A non-unique psql error (DB
#     down) degrades to best-effort (WARN + proceed without tracking).
update_job_begin() {
  [[ "${_update_headless}" -eq 1 ]] || return 0
  if ! update_db_enabled; then
    update_log "update_job: DB tracking disabled (psql absent or ATRIUM_UPDATE_DB=off) — proceeding without a DB row"
    return 0
  fi
  if [[ -n "${ATRIUM_UPDATE_JOB_ID:-}" ]]; then
    _update_job_id="${ATRIUM_UPDATE_JOB_ID}"
    update_log "update_job: adopted route-created row id=${_update_job_id}"
    update_job_heartbeat
    return 0
  fi
  local out rc=0 tv="${_update_target_version:-pending}"
  out="$(
    update_db_psql -v "tv=${tv}" 2>&1 <<'PSQL'
INSERT INTO core.update_job (status, started_at, heartbeat_at, target_version)
VALUES ('in-progress'::core."UpdateJobStatus", now(), now(), :'tv')
RETURNING id;
PSQL
  )" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    if printf '%s' "${out}" | grep -qiE 'unique|duplicate|update_job_single_active'; then
      update_die_code 8 "another update is already in-progress (single-active DB guard) — refusing to start a second"
    fi
    update_log "WARN: update_job INSERT failed (rc=${rc}): $(printf '%s' "${out}" | tr '\n' ' ' | cut -c1-200) — proceeding without DB tracking"
    _update_job_id=""
    return 0
  fi
  _update_job_id="$(printf '%s' "${out}" | awk 'NF>0{print; exit}')"
  update_log "update_job: started row id=${_update_job_id} (version=${tv})"
}

# Record the resolved release version once the manifest is fetched (the INSERT used
# a 'pending' placeholder — the version is unknown pre-download).
update_job_set_version() {
  local version="${1:-unknown}"
  _update_target_version="${version}"
  [[ -n "${_update_job_id}" ]] || return 0
  update_db_enabled || return 0
  update_db_psql -v "id=${_update_job_id}" -v "tv=${version}" <<'PSQL' >/dev/null 2>&1 || update_log "WARN: update_job target_version UPDATE failed (id=${_update_job_id})"
UPDATE core.update_job SET target_version = :'tv'
WHERE id::text = :'id' AND status = 'in-progress'::core."UpdateJobStatus";
PSQL
}

# Refresh heartbeat_at=now(), WHERE-guarded on status='in-progress' (a stale-sweep
# 'failed' is never resurrected). No-op without an open job row.
update_job_heartbeat() {
  [[ -n "${_update_job_id}" ]] || return 0
  update_db_enabled || return 0
  update_db_psql -v "id=${_update_job_id}" <<'PSQL' >/dev/null 2>&1 || update_log "WARN: update_job heartbeat UPDATE failed (id=${_update_job_id})"
UPDATE core.update_job SET heartbeat_at = now()
WHERE id::text = :'id' AND status = 'in-progress'::core."UpdateJobStatus";
PSQL
}

# Terminal success write. WHERE-guarded on status='in-progress' (a running process
# must not clobber a row the sweep already flipped). Sets _update_job_final FIRST so
# the EXIT trap never re-marks a completed update failed on a best-effort DB miss.
update_job_complete() {
  _update_job_final=1
  [[ -n "${_update_job_id}" ]] || return 0
  update_db_enabled || return 0
  update_db_psql -v "id=${_update_job_id}" <<'PSQL' >/dev/null 2>&1 || update_log "WARN: update_job completion UPDATE failed (id=${_update_job_id})"
UPDATE core.update_job
SET status = 'completed'::core."UpdateJobStatus", heartbeat_at = now()
WHERE id::text = :'id' AND status = 'in-progress'::core."UpdateJobStatus";
PSQL
  update_log "update_job: completed row id=${_update_job_id}"
}

# Terminal failure write. Same WHERE-guard; records failure_reason. Idempotent —
# invoked from the EXIT trap on any abnormal exit AND callable directly.
update_job_fail() {
  local reason="${1:-unknown failure}"
  _update_job_final=1
  [[ -n "${_update_job_id}" ]] || return 0
  update_db_enabled || return 0
  update_db_psql -v "id=${_update_job_id}" -v "fr=${reason}" <<'PSQL' >/dev/null 2>&1 || update_log "WARN: update_job failure UPDATE failed (id=${_update_job_id})"
UPDATE core.update_job
SET status = 'failed'::core."UpdateJobStatus", failure_reason = :'fr', heartbeat_at = now()
WHERE id::text = :'id' AND status = 'in-progress'::core."UpdateJobStatus";
PSQL
  update_log "update_job: marked row id=${_update_job_id} failed (${reason})"
}

# One heartbeat tick at a long-stage boundary: refresh the update_job heartbeat
# (headless) AND rewrite the cooperative pause flag so its mtime advances — the
# 1800s pause TTL must NOT trip mid-update (else the daemon would clear a flag we
# still hold and then FATAL on the still-held .apply-lock). The .apply-lock needs no
# mtime refresh: its stale-reclaim additionally requires the holder to be not-live
# (kill -0), and this process is live, so the lock is liveness-protected.
update_heartbeat() {
  if [[ "${_update_pause_created}" -eq 1 ]] && declare -F update_pause_create >/dev/null 2>&1; then
    update_pause_create >/dev/null 2>&1 || update_log "WARN: pause-flag heartbeat refresh failed"
  fi
  update_job_heartbeat
}

# ---------------------------------------------------------------------------
# P3 — claude -p precondition (headless). The merge stage may invoke Haiku, and a
# launchd job with a broken PATH/HOME would fail cryptically mid-merge. Verify the
# 'claude' binary resolves in the running job env AND on the rendered monitor /
# one-shot plist PATH BEFORE the merge — loud-fail exit 7 if not.
# ---------------------------------------------------------------------------

# The claude binary name/path to look for (ATRIUM_UPDATE_CLAUDE_BIN seam).
update_claude_name() { printf '%s\n' "${ATRIUM_UPDATE_CLAUDE_BIN:-claude}"; }

# Resolve claude: an absolute override that is executable → config [paths].claude_bin
# → the name on PATH → the common install dirs. Echo the resolved path (rc 0) or
# rc 1 when unresolvable. Mirrors wiki-daily-compile.sh's resolution chain.
update_resolve_claude() {
  local name cfg dir
  name="$(update_claude_name)"
  if [[ "${name}" == /* && -x "${name}" ]]; then
    printf '%s\n' "${name}"
    return 0
  fi
  if declare -F atrium_config_get >/dev/null 2>&1; then
    cfg="$(atrium_config_get '[paths]' 'claude_bin' '' 2>/dev/null || true)"
    if [[ -n "${cfg}" && -x "${cfg}" ]]; then
      printf '%s\n' "${cfg}"
      return 0
    fi
  fi
  if command -v "${name##*/}" >/dev/null 2>&1; then
    command -v "${name##*/}"
    return 0
  fi
  for dir in /opt/homebrew/bin /usr/local/bin; do
    if [[ -x "${dir}/${name##*/}" ]]; then
      printf '%s\n' "${dir}/${name##*/}"
      return 0
    fi
  done
  return 1
}

# Extract EnvironmentVariables.PATH from a launchd plist. plutil when present (the
# rendered plists are macOS plists); an awk fallback reads the <string> after the
# <key>PATH</key> for non-macOS test hosts. Echoes the value; rc 1 when absent.
update_plist_env_path() {
  local plist="$1"
  [[ -f "${plist}" ]] || return 1
  if command -v plutil >/dev/null 2>&1; then
    plutil -extract EnvironmentVariables.PATH raw -o - -- "${plist}" 2>/dev/null || return 1
  else
    awk '
      matched && /<string>/ {
        line = $0
        sub(/^[^>]*<string>/, "", line)
        sub(/<\/string>.*/, "", line)
        print line
        exit
      }
      /<key>PATH<\/key>/ { matched = 1 }
    ' "${plist}"
  fi
}

# rc 0 when an executable `claude` (its basename) sits on the ':'-separated PATH $1.
update_claude_on_path() {
  local path_value="$1" name dir
  local -a dirs=()
  name="$(update_claude_name)"
  name="${name##*/}"
  IFS=':' read -r -a dirs <<<"${path_value}" || true
  [[ "${#dirs[@]}" -gt 0 ]] || return 1
  for dir in "${dirs[@]}"; do
    [[ -n "${dir}" && -x "${dir}/${name}" ]] && return 0
  done
  return 1
}

# The precondition proper. (1) claude must resolve in THIS process env (the running
# decoupled job's actual env — its own merge stage needs it). (2) each provided
# plist's EnvironmentVariables.PATH must also resolve claude (the monitor / one-shot
# plists the post-step refreshes; an absent plist is skipped, degrade-safe). Any
# miss → loud-fail exit 7. Args: $@ = plist paths to additionally verify.
update_verify_claude_precondition() {
  local plist path_value
  if ! update_resolve_claude >/dev/null; then
    update_die_code 7 "claude binary NOT resolvable in the decoupled job environment (checked ATRIUM_UPDATE_CLAUDE_BIN / [paths].claude_bin / PATH / /opt/homebrew/bin / /usr/local/bin) — the merge stage would fail; fix the launchd plist env and retry"
  fi
  for plist in "$@"; do
    [[ -f "${plist}" ]] || continue
    path_value="$(update_plist_env_path "${plist}" 2>/dev/null || true)"
    if [[ -z "${path_value}" ]] || ! update_claude_on_path "${path_value}"; then
      update_die_code 7 "claude NOT resolvable on the launchd plist PATH — the job/monitor would fail claude -p: ${plist}"
    fi
  done
  update_log "claude precondition ok (resolved in the job env)"
}

# Headless-guarded auth load: source claude-auth-env.sh's exporter (a launchd job
# cannot use the GUI keychain; the 0600 token file is the headless path). Best-effort.
update_headless_load_claude_auth() {
  [[ "${_update_headless}" -eq 1 ]] || return 0
  if declare -F claude_auth_load_env >/dev/null 2>&1; then
    claude_auth_load_env || true
  fi
}

# Headless-guarded precondition: verify the monitor + one-shot plists' env resolves
# claude before the merge. Plists are resolved from FIXED locations (never
# request-derived — SECURITY).
update_headless_verify_claude() {
  [[ "${_update_headless}" -eq 1 ]] || return 0
  update_verify_claude_precondition \
    "$(update_monitor_plist_path)" "$(update_oneshot_plist_path)"
}

# ---------------------------------------------------------------------------
# P3 — decoupled one-shot launchd job. The web route enqueues THIS plist via
# `launchctl bootstrap`; it runs `update.sh --headless` in a process tree DECOUPLED
# from the monitor, so the install-parity post-step's `kickstart -k` (which restarts
# the monitor) cannot kill the update runner. Label + path + bootstrap invocation
# are documented in the P3-T2 completion notes for P3-T3.
# ---------------------------------------------------------------------------

# Fixed monitor plist path (NEVER request-derived). Override for tests.
update_monitor_plist_path() {
  printf '%s\n' "${ATRIUM_UPDATE_MONITOR_PLIST:-${HOME}/Library/LaunchAgents/com.glass-atrium.monitor.plist}"
}

# Fixed decoupled one-shot plist path (NEVER request-derived). Override for tests.
update_oneshot_plist_path() {
  printf '%s\n' "${ATRIUM_UPDATE_ONESHOT_PLIST:-$(update_ga_root)/rendered/launchd/com.glass-atrium.update-oneshot.plist}"
}

# autoagent-cycle plist paths (NEVER request-derived). Overrides for tests.
#   *_path        = the launchd-canonical ~/Library/LaunchAgents copy launchctl loads.
#   *_rendered    = the render-parity SoT re-copied over the canonical copy so a
#                   repointed ProgramArguments (store-path daemon-cycle.sh) takes
#                   effect on reload. Mirrors load_launchd_jobs' rendered->LaunchAgents
#                   staging.
update_autoagent_plist_path() {
  printf '%s\n' "${ATRIUM_UPDATE_AUTOAGENT_PLIST:-${HOME}/Library/LaunchAgents/com.glass-atrium.autoagent-cycle.plist}"
}
update_autoagent_rendered_plist_path() {
  printf '%s\n' "${ATRIUM_UPDATE_AUTOAGENT_RENDERED_PLIST:-$(update_ga_root)/rendered/launchd/com.glass-atrium.autoagent-cycle.plist}"
}

# Minimal XML entity escape for the plist string values (patsub_replacement is
# disabled at the top of the file so '&' is a literal replacement char).
update_xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "${s}"
}

# Render the decoupled one-shot plist to update_oneshot_plist_path(). Env (HOME + a
# PATH leading with the node + claude bins) is config-derived so `claude` resolves
# for the merge stage; NO secret is embedded (the OAuth token is loaded at runtime
# from the 0600 secrets file by claude_auth_load_env). RunAtLoad=true + no KeepAlive
# = a one-shot that runs on bootstrap then exits. Echoes the rendered path.
update_render_oneshot_plist() {
  local out root node_bin node_dir claude_bin claude_dir path_value tmp
  local e_home e_root e_script e_path
  out="$(update_oneshot_plist_path)"
  root="$(update_ga_root)"
  node_bin=""
  if declare -F atrium_config_get >/dev/null 2>&1; then
    node_bin="$(atrium_config_get '[paths]' 'node_bin' '' 2>/dev/null || true)"
  fi
  [[ -n "${node_bin}" ]] || node_bin="$(command -v node 2>/dev/null || printf '/usr/local/bin/node')"
  node_dir="$(dirname -- "${node_bin}")"
  claude_bin="$(update_resolve_claude 2>/dev/null || printf '/opt/homebrew/bin/claude')"
  claude_dir="$(dirname -- "${claude_bin}")"
  path_value="${node_dir}:${claude_dir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  e_home="$(update_xml_escape "${HOME}")"
  e_root="$(update_xml_escape "${root}")"
  e_script="$(update_xml_escape "${root}/scripts/update.sh")"
  e_path="$(update_xml_escape "${path_value}")"
  mkdir -p -- "$(dirname -- "${out}")"
  tmp="${out}.ga-render.$$"
  cat >"${tmp}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.glass-atrium.update-oneshot</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${e_script}</string>
		<string>--headless</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>WorkingDirectory</key>
	<string>${e_root}</string>
	<key>StandardOutPath</key>
	<string>/tmp/glass-atrium-update-oneshot.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/glass-atrium-update-oneshot.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${e_home}</string>
		<key>PATH</key>
		<string>${e_path}</string>
	</dict>
</dict>
</plist>
PLIST
  mv -f -- "${tmp}" "${out}"
  update_log "rendered decoupled one-shot plist: ${out}"
  printf '%s\n' "${out}"
}

# ---------------------------------------------------------------------------
# P3 — install-parity post-step (headless success only): rebuild the monitor then
# refresh its launchd job, mirroring install.sh, so a web-triggered update lands
# byte-identical to a fresh install. Runs INSIDE the decoupled one-shot job, so
# `kickstart -k` restarting the monitor does NOT kill this runner.
# ---------------------------------------------------------------------------

# Build the monitor (tsc + build:assets + build:client via `npm run build`). Returns
# non-zero on build failure (the caller treats it as fatal → job 'failed').
update_build_monitor() {
  local monitor_dir npm
  monitor_dir="${ATRIUM_UPDATE_MONITOR_DIR:-$(update_ga_root)/monitor}"
  npm="${ATRIUM_UPDATE_NPM:-npm}"
  if [[ ! -d "${monitor_dir}" ]]; then
    update_log "post-step: monitor dir absent (${monitor_dir}) — skipping build"
    return 0
  fi
  update_log "post-step: building monitor (${monitor_dir})"
  (cd -- "${monitor_dir}" && "${npm}" run build)
}

# Re-render the launchd plists + monitor env for config parity (FIXED script paths,
# never request-derived — SECURITY), then (re)render the decoupled one-shot plist.
# Each render is best-effort + loud (a failure warns, never aborts the applied update).
update_render_parity() {
  local render_launchd render_monitor_env
  render_launchd="${ATRIUM_UPDATE_RENDER_LAUNCHD:-${_update_script_dir}/render-launchd-plists.sh}"
  render_monitor_env="${ATRIUM_UPDATE_RENDER_MONITOR_ENV:-${_update_script_dir}/render-monitor-env.sh}"
  # Loud-fail an absent/non-executable render script (Precondition Loud-Fail Principle) — a SILENT
  # skip here is exactly how the monitor boots without ATRIUM_* env → dev-fallback schedules + UTC
  # day-bucket under the launchd TZ=UTC shadow (Next-due 9h late). The WARN persists via update_log
  # (stderr → the one-shot job's StandardErrorPath log), so the skip is diagnosable, never invisible.
  if [[ -x "${render_launchd}" ]]; then
    "${render_launchd}" >/dev/null 2>&1 || update_log "WARN: render-launchd-plists failed — launchd parity skipped"
  else
    update_log "WARN: render-launchd-plists.sh missing or non-executable (${render_launchd}) — launchd parity SKIPPED; plists not re-rendered"
  fi
  if [[ -x "${render_monitor_env}" ]]; then
    "${render_monitor_env}" >/dev/null 2>&1 || update_log "WARN: render-monitor-env failed — monitor env parity skipped"
  else
    update_log "WARN: render-monitor-env.sh missing or non-executable (${render_monitor_env}) — monitor env parity SKIPPED; ATRIUM_* env NOT rendered (monitor will fall back to dev schedules + UTC day-bucket)"
  fi
  update_render_oneshot_plist >/dev/null 2>&1 || update_log "WARN: one-shot plist render failed"
}

# Refresh the monitor's launchd job. PROBE with `launchctl print` first: loaded →
# `kickstart -k` (restart in place); NOT loaded → `bootstrap` (kickstart -k is
# non-idempotent when unloaded, so the probe picks the correct verb). Best-effort +
# loud — a launchd hiccup must not fail an already-applied update.
update_refresh_monitor_launchd() {
  local launchctl_bin uid label domain plist
  launchctl_bin="${ATRIUM_UPDATE_LAUNCHCTL:-launchctl}"
  if ! command -v "${launchctl_bin}" >/dev/null 2>&1; then
    update_log "post-step: launchctl not resolvable (${launchctl_bin}) — monitor needs a manual restart"
    return 0
  fi
  uid="$(id -u)"
  label="com.glass-atrium.monitor"
  domain="gui/${uid}"
  plist="$(update_monitor_plist_path)"
  if "${launchctl_bin}" print "${domain}/${label}" >/dev/null 2>&1; then
    update_log "post-step: monitor loaded — kickstart -k ${domain}/${label}"
    "${launchctl_bin}" kickstart -k "${domain}/${label}" >/dev/null 2>&1 \
      || update_log "WARN: kickstart -k failed — monitor may need a manual restart"
  else
    update_log "post-step: monitor NOT loaded — bootstrap ${domain} ${plist}"
    "${launchctl_bin}" bootstrap "${domain}" "${plist}" >/dev/null 2>&1 \
      || update_log "WARN: bootstrap failed — monitor may need a manual load"
  fi
}

# Refresh the autoagent-cycle launchd job — ONLY when already loaded (review-first:
# an unloaded job stays the user's opt-in, never auto-bootstrapped here). Unlike the
# monitor, this job's ProgramArguments were repointed to the store-path daemon-cycle.sh,
# so a `kickstart -k` would re-run the STALE loaded definition; the new path takes
# effect ONLY by RE-COPYING the freshly rendered plist over the LaunchAgents copy then
# bootout+bootstrap (reload the definition). render-parity already re-rendered the plist
# FILE; this is the missing reload half. Best-effort + loud — a launchd hiccup must not
# fail an already-applied update.
update_refresh_autoagent_launchd() {
  local launchctl_bin uid label domain src dst
  launchctl_bin="${ATRIUM_UPDATE_LAUNCHCTL:-launchctl}"
  if ! command -v "${launchctl_bin}" >/dev/null 2>&1; then
    update_log "post-step: launchctl not resolvable (${launchctl_bin}) — autoagent-cycle needs a manual reload"
    return 0
  fi
  uid="$(id -u)"
  label="com.glass-atrium.autoagent-cycle"
  domain="gui/${uid}"
  src="$(update_autoagent_rendered_plist_path)"
  dst="$(update_autoagent_plist_path)"
  # PROBE — only refresh a LOADED job; not loaded → leave it to the user's opt-in load.
  if ! "${launchctl_bin}" print "${domain}/${label}" >/dev/null 2>&1; then
    update_log "post-step: autoagent-cycle NOT loaded — leaving user opt-in load untouched"
    return 0
  fi
  # the render-parity SoT must exist to re-copy — a render gap warns, never aborts.
  if [[ ! -f "${src}" ]]; then
    update_log "WARN: rendered autoagent-cycle plist absent (${src}) — reload skipped"
    return 0
  fi
  if ! cp -f -- "${src}" "${dst}"; then
    update_log "WARN: failed to stage autoagent-cycle plist (${src} -> ${dst}) — reload skipped"
    return 0
  fi
  update_log "post-step: autoagent-cycle loaded — bootout + bootstrap ${domain}/${label}"
  # bootout is ASYNCHRONOUS; a single transient retry (mirrors load_launchd_jobs) closes
  # the rc=5 race where launchd has not fully released the domain slot yet.
  "${launchctl_bin}" bootout "${domain}/${label}" </dev/null >/dev/null 2>&1 || true
  if ! "${launchctl_bin}" bootstrap "${domain}" "${dst}" </dev/null >/dev/null 2>&1; then
    sleep 1
    "${launchctl_bin}" bootstrap "${domain}" "${dst}" </dev/null >/dev/null 2>&1 \
      || update_log "WARN: bootstrap failed — autoagent-cycle may need a manual reload"
  fi
}

# The whole install-parity post-step, orchestrated. Heartbeats bracket the long
# build. Build failure is FATAL (returns 1 → job 'failed'); render + launchd refresh
# are best-effort. Returns 0 on success, 1 on build failure.
update_post_step() {
  update_heartbeat
  if ! update_build_monitor; then
    update_log "post-step: monitor build FAILED"
    return 1
  fi
  update_heartbeat
  update_render_parity
  update_refresh_monitor_launchd
  update_refresh_autoagent_launchd
  update_log "post-step: install-parity complete"
  return 0
}

# ---------------------------------------------------------------------------
# P3 — agents-bak restore (git-revert replacement, consumed by P3-T5) + retention
# ---------------------------------------------------------------------------
#
# The E4 merge writes a per-run before-image copy of each touched agent md into
# <agents-bak base>/<cycle-id>/<name>.md.bak (git_txn_apply's capture). Restore
# reverses a bad update: given a <cycle-id>, copy each before-image back over the
# live agent file (atomic temp+rename). Prune drops before-image dirs older than
# 14 days at the start of every run so the sink cannot grow unbounded.

# The agents-bak BASE dir (holds the per-run <cycle-id> subdirs). The single source
# for the backup_base sink: the write side (update_merge_agent_editable_regions) and
# the read side (prune / restore) both derive the base through this one helper.
update_agents_bak_base() {
  local root="$1" real_agents
  if [[ -n "${AUTOAGENT_BACKUP_DIR:-}" ]]; then
    printf '%s\n' "${AUTOAGENT_BACKUP_DIR}"
    return 0
  fi
  real_agents="$(update_realpath "${root}/agents" 2>/dev/null || true)"
  printf '%s\n' "$(dirname -- "${real_agents:-${root}/agents}")/agents-bak"
}

# SECURITY: only ever rm a path that is clearly an agents-bak per-run subdir, so a
# mis-derived base can never let rm -rf escape onto an unrelated path.
_update_agents_bak_guard() {
  case "$1" in
    */agents-bak/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prune per-run before-image dirs older than the 14-day retention. Age via python3
# mtime (portable — NEVER the BSD/GNU-divergent stat / find -mtime). Best-effort.
update_prune_agents_bak() {
  local root base dir age_days newest="" retention="${ATRIUM_UPDATE_AGENTS_BAK_RETENTION_DAYS:-14}"
  root="$(update_ga_root)"
  base="$(update_agents_bak_base "${root}")"
  [[ -d "${base}" ]] || return 0
  # Newest-anchor protection (finding #12): find the newest per-run subdir by mtime
  # (bash `-nt`, no external stat — mirrors daemon-apply.sh prune_backup_retention)
  # and NEVER prune it, even when an idle install ages every dir past the retention.
  # It is the most-recent rollback anchor --restore-agents reads.
  for dir in "${base}"/*/; do
    [[ -d "${dir}" ]] || continue
    dir="${dir%/}"
    _update_agents_bak_guard "${dir}" || continue
    if [[ -z "${newest}" || "${dir}" -nt "${newest}" ]]; then
      newest="${dir}"
    fi
  done
  for dir in "${base}"/*/; do
    [[ -d "${dir}" ]] || continue
    dir="${dir%/}"
    _update_agents_bak_guard "${dir}" || continue
    [[ "${dir}" == "${newest}" ]] && continue # protect the newest rollback anchor
    age_days="$(
      python3 - "${dir}" <<'PY' 2>/dev/null || true
import os, sys, time
try:
    print(int((time.time() - os.stat(sys.argv[1]).st_mtime) // 86400))
except OSError:
    print(-1)
PY
    )"
    [[ "${age_days}" =~ ^[0-9]+$ ]] || continue
    if [[ "${age_days}" -gt "${retention}" ]] && rm -rf -- "${dir}" 2>/dev/null; then
      update_log "agents-bak: pruned aged snapshot (${age_days}d > ${retention}d): ${dir##*/}"
    fi
  done
}

# Reverse the base-content store entry for a just-restored agent (finding #9 part
# 4). A restore that reverts the live agent body WITHOUT reverting its base entry
# leaves the NEXT update's 3-way merge keyed on the wrong (release) base. A
# <name>.md.base.bak snapshot beside the live before-image (captured pre-advance in
# update_capture_base_content) → restore it atomically (temp+rename); its ABSENCE
# (the release created the FIRST base for this agent, or the capture-time snapshot
# failed) → DELETE the live base entry so load_base_text returns None and the next
# merge falls back to the deterministic gated 2-way present-both path (strictly
# safer than a poisoned diff3 base). Args: $1 = <name>.md · $2 = restore cycle dir
# · $3 = base-content store dir. rc 1 on a revert/delete failure — LOUD, never
# silent (the caller marks the whole restore failed).
update_restore_base_entry() {
  local name="$1" restore_dir="$2" store="$3" base_bak base_target
  base_bak="${restore_dir}/${name}.base.bak"
  base_target="${store}/${name}"
  if [[ -f "${base_bak}" ]]; then
    if spine_atomic_swap "${base_bak}" "${base_target}"; then
      update_log "reverted base-content store entry for ${name}"
    else
      update_log "WARN: base-content store revert FAILED for ${name}"
      return 1
    fi
  elif [[ -e "${base_target}" ]]; then
    if rm -f -- "${base_target}"; then
      update_log "deleted base-content store entry for ${name} (no prior base snapshot → safe gated 2-way next merge)"
    else
      update_log "WARN: base-content store delete FAILED for ${name}"
      return 1
    fi
  fi
  return 0
}

# Restore agent md from a <cycle-id> before-image set. Serializes (writes live agent
# files) via the same pause+lock. Atomic per-file (temp+rename). Loud-fail (exit 10)
# on a bad cycle-id or missing snapshot dir. Prune runs first (retention). Each
# reverted live body ALSO reverses its base-content store entry (finding #9 part 4)
# so the next 3-way merge is not left keyed on the reverted-away release base.
update_restore_agents() {
  local cycle_id="${1:-}" root base restore_dir bak name target real store count=0 fail=0
  [[ -n "${cycle_id}" ]] || update_die_code 10 "--restore-agents requires a <cycle-id>"
  # SECURITY: reject path separators / traversal in the request-supplied cycle-id.
  case "${cycle_id}" in
    */* | *'..'*) update_die_code 10 "invalid cycle-id (no path separators): ${cycle_id}" ;;
    *) ;; # a plain <cycle_date>_update-<version> token — safe
  esac
  root="$(update_ga_root)"
  update_require_tools python3
  update_prune_agents_bak
  base="$(update_agents_bak_base "${root}")"
  restore_dir="${base}/${cycle_id}"
  [[ -d "${restore_dir}" ]] \
    || update_die_code 10 "no agents-bak snapshot for cycle-id '${cycle_id}' (${restore_dir})"
  # base-content store dir (same resolution the forward capture used) — the base
  # reversal target (finding #9 part 4).
  store="$(update_base_store_dir)"
  update_serialize_begin
  # The *.md.bak glob matches ONLY the live before-images — a sibling *.md.base.bak
  # ends in .base.bak, not .md.bak, so it is never iterated here (it is consumed by
  # update_restore_base_entry below, keyed on the live file's <name>).
  for bak in "${restore_dir}"/*.md.bak; do
    [[ -e "${bak}" ]] || continue
    name="${bak##*/}"
    name="${name%.bak}" # <name>.md
    target="${root}/agents/${name}"
    real="$(update_realpath "${target}" 2>/dev/null || printf '%s\n' "${target}")"
    if cp -p -- "${bak}" "${real}.restore.$$" 2>/dev/null \
      && mv -f -- "${real}.restore.$$" "${real}" 2>/dev/null; then
      update_log "restored agents/${name} from ${cycle_id} before-image"
      count=$((count + 1))
      # base reversal AFTER the live body reverted — keep base + live in lock-step
      # (a base revert without its live revert would desync the next merge anchor).
      update_restore_base_entry "${name}" "${restore_dir}" "${store}" || fail=1
    else
      rm -f -- "${real}.restore.$$" 2>/dev/null || true
      update_log "WARN: restore FAILED for agents/${name}"
      fail=1
    fi
  done
  [[ "${count}" -gt 0 ]] \
    || update_die_code 10 "no *.md.bak before-images found in ${restore_dir}"
  update_log "agents-bak restore complete: ${count} file(s) from ${cycle_id}"
  [[ "${fail}" -eq 0 ]] \
    || update_die_code 10 "one or more agent restores failed (see WARN lines) — cycle-id ${cycle_id}"
}

# ---------------------------------------------------------------------------
# P3 — success finalizer + preview (dry-run)
# ---------------------------------------------------------------------------

# Single success-path finalizer. On the applied path (did_apply=1) in headless mode
# run the install-parity post-step (fatal on build failure → exit 9); then mark the
# job completed. did_apply=0 (a no-op "already up to date" path) skips the post-step
# (nothing was built). Interactive mode no-ops both.
update_finalize_success() {
  local did_apply="${1:-0}"
  if [[ "${_update_headless}" -eq 1 && "${did_apply}" -eq 1 ]]; then
    if ! update_post_step; then
      update_die_code 9 "install-parity post-step (monitor build / launchd refresh) failed — update files applied but the monitor was not rebuilt/restarted; retry"
    fi
  fi
  update_job_complete
}

# Dry-run preview (P3-T3 consumes): download + stage the release, then render a
# per-file unified diff to STDOUT with ZERO writes. No lock, no pause flag, no DB row
# — a preview must never contend with (or block) a real apply; the server re-verifies
# bundle==pinned at commit, so the read/apply race is handled there.
update_preview() {
  local root work dl_dir new_dir manifest changed clean_paths sensitive_paths
  local records label current proposed path
  local rm_baseline rm_removed rm_path
  root="$(update_ga_root)"
  # git is NOT required: the whole flow (spine sync + git-free git_txn_apply
  # merge) runs without any git invocation, by design (no-.git consumer install).
  update_require_tools jq python3
  work="$(mktemp -d -t glass-atrium-update-preview.XXXXXX)"
  _update_workdir="${work}"
  dl_dir="${work}/download"
  new_dir="${work}/new"
  update_fetch_release "${dl_dir}" "${new_dir}"
  manifest="${dl_dir}/manifest.json"
  update_log "preview: dry-run diff for release version $(jq -r '.version // "unknown"' "${manifest}" 2>/dev/null || printf 'unknown')"
  # Vendor-removal preview (#14): list files the prior-vendor baseline shipped but
  # this release DROPS (provenance-clean only) — a dry-run MUST surface impending
  # deletions, not just content diffs, so the headless/web confirm is not blind.
  # No baseline → nothing to list; a detection failure degrades to no listing
  # (spine's own stderr is loud), never an aborted preview.
  rm_baseline="$(spine_get_baseline || true)"
  if [[ -n "${rm_baseline}" && -f "${rm_baseline}" ]]; then
    if rm_removed="$(spine_find_removed_files "${rm_baseline}" "${manifest}" "${root}")" \
      && [[ -n "${rm_removed}" ]]; then
      while IFS= read -r rm_path; do
        [[ -n "${rm_path}" ]] && update_log "  (would be removed -> Trash) ${rm_path}"
      done <<<"${rm_removed}"
    fi
  fi
  changed="$(spine_find_changed_files "${manifest}" "${root}")" \
    || update_die "preview: change selection failed (manifest hash gap)"
  if [[ -z "${changed}" ]]; then
    update_log "preview: already up to date — no non-agent files changed"
    return 0
  fi
  clean_paths="${work}/clean.paths"
  sensitive_paths="${work}/sensitive.paths"
  printf '%s\n' "${changed}" \
    | update_partition_sensitive "${clean_paths}" "${sensitive_paths}"
  while IFS= read -r path; do
    [[ -n "${path}" ]] && update_log "  (sensitive, would be skipped) ${path}"
  done <"${sensitive_paths}"
  if [[ ! -s "${clean_paths}" ]]; then
    update_log "preview: no auto-syncable files after the sensitive partition"
    return 0
  fi
  # Render every change's unified diff to STDOUT (no confirm prompt, no write). Reuse
  # the SAME record + diff format the confirm gate uses so P3-T3 sees identical output.
  records="$(gate_build_nonagent_records "${new_dir}" "${root}" <"${clean_paths}")"
  while IFS=$'\t' read -r label current proposed; do
    [[ -n "${label}" ]] || continue
    gate_render_diff "${label}" "${current}" "${proposed}" || true
  done <<<"${records}"
  update_log "preview complete (dry-run — no files written)"
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

update_usage() {
  cat <<'USAGE'
glass-atrium update — apply the latest Glass Atrium release.

Usage:
  glass-atrium update                    download, preview a per-file diff, confirm, apply (interactive TTY)
  glass-atrium update --headless         non-TTY apply: update_job DB tracking + heartbeat + install-parity
                                         post-step (monitor rebuild + launchd refresh). Confirm via the
                                         ATRIUM_UPDATE_CONFIRM_ANSWER seam (unset/empty => fail-closed decline).
  glass-atrium update --preview          dry-run: download + per-file diff to stdout, ZERO writes (no lock/DB).
  glass-atrium update --restore-agents ID  restore agents/*.md from the agents-bak <ID> before-image.
  glass-atrium update --render-oneshot   render the decoupled one-shot launchd plist, print its path (no writes elsewhere).
  glass-atrium update --help             show this help

Flow: pause the autoagent daemon → acquire the apply-lock → download + verify the
release → foreground diff/confirm → deterministic non-agent sync → agent
EDITABLE-region merge (E4) → capture the baseline → refresh the ~/.claude mirror
farm → reconcile settings.json hook bindings (wire-hooks). Headless additionally
tracks the core.update_job row and runs the install-parity post-step. Sensitive
harness files are never auto-synced (reported for manual review).
USAGE
}

# The committing callback the foreground gate invokes ONLY on explicit confirm.
# Reads the clean change set (one path per line) from STDIN and snapshot+swaps via
# the spine. Globals carry the paths the gate cannot (the gate owns stdin).
#
# Drops a `.commit-ok` FILE marker on a clean swap (finding #7). It MUST be a file,
# not a shell var: the gate runs this callback on a pipe RHS (a subshell), so a var
# set here would never reach the parent's EXIT trap — but the marker file survives.
# Its presence tells update_cleanup the swap committed cleanly (snapshot is safe to
# delete); its absence beside a non-empty snapshot means a failed/interrupted apply
# whose snapshot must be preserved. A spine failure is remapped to rc 3 (finding #8) —
# DISJOINT from the gate's own 1=declined / 2=empty verdicts it propagates verbatim —
# so a rolled-back apply is never mislabeled "declined".
update_commit_callback() {
  local rc=0
  printf '%s\n' "${_update_clean_paths}" \
    | spine_commit_staged "${_update_staging}" "$(update_ga_root)" "${_update_snapshot}" || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    if [[ -n "${_update_workdir}" && -d "${_update_workdir}" ]]; then
      : >"${_update_workdir}/.commit-ok"
    fi
    return 0
  fi
  # spine_commit_staged failed and rolled back the partial swap (finding #8). Map ANY
  # non-zero spine rc to 3 — DISJOINT from gate_apply_confirmed's own 1 (declined) /
  # 2 (empty set) verdicts, which it propagates VERBATIM from this callback. Without
  # the remap a spine rc 1 collided with the gate's 1=declined, so update_run
  # mislabeled a rolled-back apply "declined at the confirm gate — no files written".
  # Mirrors the agent path's _update_agent_commit_callback rc-3 convention.
  return 3
}

# ---------------------------------------------------------------------------
# Vendor-removal sweep (#14) — the deletion counterpart of the non-agent sync
# ---------------------------------------------------------------------------
#
# spine_find_changed_files selects files the release ADDS or CHANGES; nothing
# handled the files a release DROPS, so a vendor-retired file lingered forever
# (the "no deletion pass" gap). spine_find_removed_files (apply-spine.sh) is the
# provenance-gated DETECTION half — the non-agent files the PRIOR-VENDOR baseline
# shipped but the new release dropped, restricted to still-pristine copies (live
# hash == baseline hash); a USER-edited dropped file is PRESERVED (never listed).
# Below is the caller-side REMOVAL half: sensitive-partition the list, preview it
# through the SAME confirm gate as the sync, and MOVE each confirmed file to a
# per-run Trash sink (File Deletion Policy: rm is FORBIDDEN for source/config — mv
# to ~/.Trash on macOS). Removal policy stays caller-side — the same split as
# spine_find_changed_files -> update_commit_callback.

# The macOS Trash dir the sweep moves vendor-dropped files into. ATRIUM_UPDATE_TRASH_DIR
# overrides for hermetic tests; default ${HOME}/.Trash.
update_trash_dir() {
  printf '%s\n' "${ATRIUM_UPDATE_TRASH_DIR:-${HOME}/.Trash}"
}

# The removal confirm gate's committing callback — invoked ONLY on explicit
# confirm. Moves each vendor-dropped file to the per-run Trash sink preserving its
# relative path (atomic mv into one recovery bundle). Reads the removal set + sink
# from globals: it runs on the gate's pipe-RHS subshell (which owns no stdin — the
# gate consumed it), the same carrier pattern as update_commit_callback. Loud-fail
# rc 3 on ANY move failure — DISJOINT from gate_apply_confirmed's own 1 (declined)
# / 2 (empty set) verdicts it propagates verbatim — so the caller maps a genuine
# move failure to its named exit code without colliding with "declined".
#
# shellcheck disable=SC2329
#   Passed by NAME to gate_apply_confirmed ("$@"), never called by () here.
_update_removal_commit_callback() {
  local path src dest rc=0
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    src="${_update_removal_root}/${path}"
    # Already gone (concurrent sweep / manual delete) → nothing to move.
    [[ -e "${src}" ]] || continue
    dest="${_update_removal_dest}/${path}"
    if mkdir -p -- "$(dirname -- "${dest}")" && mv -f -- "${src}" "${dest}"; then
      update_log "vendor-dropped file removed → Trash: ${path}"
    else
      update_log "WARN: could NOT move ${src} to Trash (${dest}) — left in place"
      rc=3
    fi
  done <<<"${_update_removal_paths}"
  return "${rc}"
}

# Retire the settings.json BINDINGS of any HOOK files the vendor-removal sweep just
# Trashed (#13). A dropped hooks/<name> file whose event->hook binding LINGERS still
# points at the now-absent file → the hook ERRORS when its event fires. wire_hooks only
# ADDS bindings, so the launcher's targeted `retire-hook-bindings` subcommand (a jq
# surgical per-basename removal) is invoked — via the SAME launcher-subprocess model as
# update_wire_hooks_post_apply (sourcing ga-core.sh in-process collides on readonly
# GA_ROOT + bare log()/die()). Best-effort + LOUD: a retire failure WARNs (the file is
# already removed; doctor's hook-binding check surfaces a dangling binding), NEVER rolls
# back the applied sync. Args: $1 = confirmed-removed paths (newline-separated) · $2 =
# live install root.
update_retire_swept_hook_bindings() {
  local removed_paths="$1" root="$2" path launcher
  local -a basenames=()
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    # a BOUND hook is a TOP-LEVEL hooks/<basename> file — bindings key on the flat
    # basename, so hooks/lib/*, hooks/test/* etc. are never bound and are skipped.
    case "${path}" in
      hooks/*/*) continue ;; # nested (lib/test/…) — not a bound hook
      hooks/*) basenames+=("${path#hooks/}") ;;
      *) continue ;; # non-hook file
    esac
  done <<<"${removed_paths}"
  [[ "${#basenames[@]}" -gt 0 ]] || return 0
  launcher="${root}/glass-atrium"
  if [[ ! -x "${launcher}" ]]; then
    update_log "WARN: launcher missing (${launcher}) — could NOT retire the settings.json binding(s) for removed hook(s): ${basenames[*]}; run '${launcher} retire-hook-bindings ${basenames[*]}' after repairing the install"
    return 0
  fi
  # if-condition suppresses set -e; a launcher die/non-zero is a plain rc here (never
  # aborts the parent) → WARN, do not roll back the already-applied sync.
  if "${launcher}" retire-hook-bindings "${basenames[@]}"; then
    update_log "retired settings.json binding(s) for removed hook(s): ${basenames[*]}"
  else
    update_log "WARN: retire of settings.json binding(s) for removed hook(s) FAILED (${basenames[*]}) — the dropped hook file(s) were removed but a dangling binding may remain; run '${launcher} retire-hook-bindings ${basenames[*]}' manually"
  fi
}

# Drive the vendor-removal sweep for a completed apply. No prior-vendor baseline
# (first-ever update / relocated install) → empty set → no-op (degrade-safe: never
# sweep without vendor provenance, the same stance as the roster gate's remove
# side). A DETECTION failure (corrupt baseline hash gap) is LOUD but NON-fatal —
# it WARNs and skips so the run still captures a fresh baseline that self-heals the
# corrupt anchor (aborting here would only re-abort next run). A confirmed move
# that FAILS is a named loud-fail (exit 13) so a stale-file leftover surfaces with
# an actionable cause (never 2>/dev/null-absorbed); the applied sync is never
# rolled back. Args: $1 = prior-vendor baseline manifest (may be empty/absent) ·
# $2 = new manifest · $3 = live install root.
update_sweep_removed_files() {
  local baseline_manifest="${1:-}" manifest="$2" root="$3"
  local removed clean_removals sensitive_removals records empty_proposed
  local path label current ts rc=0
  # No provenance anchor → refuse to sweep anything.
  [[ -n "${baseline_manifest}" && -f "${baseline_manifest}" ]] || return 0
  if ! removed="$(spine_find_removed_files "${baseline_manifest}" "${manifest}" "${root}")"; then
    update_log "WARN: vendor-removal selection failed (baseline hash gap) — skipping the deletion pass; a fresh baseline will be captured next"
    return 0
  fi
  [[ -n "${removed}" ]] || return 0

  # Sensitive-partition the removal set: a vendor-dropped harness file (plist,
  # security rule, credential) is REPORTED for manual review, never auto-Trashed —
  # the same fail-closed carve-out the non-agent sync applies to changed files.
  clean_removals="$(mktemp -t glass-atrium-remove-clean.XXXXXX)"
  sensitive_removals="$(mktemp -t glass-atrium-remove-sens.XXXXXX)"
  printf '%s\n' "${removed}" \
    | update_partition_sensitive "${clean_removals}" "${sensitive_removals}"
  while IFS= read -r path; do
    [[ -n "${path}" ]] && update_log "  (sensitive vendor-drop, NOT removed — review manually) ${path}"
  done <"${sensitive_removals}"
  if [[ ! -s "${clean_removals}" ]]; then
    rm -f -- "${clean_removals}" "${sensitive_removals}"
    return 0
  fi

  # Per-run Trash sink: a timestamped subdir so one run's removals form a single
  # recovery bundle and same-basename drops never collide.
  ts="$(date +%Y%m%d-%H%M%S)"
  _update_removal_root="${root}"
  _update_removal_dest="$(update_trash_dir)/glass-atrium-update-removed-${ts}_$$"
  _update_removal_paths="$(cat "${clean_removals}")"

  # Preview each removal through the SAME confirm gate as the sync (structural
  # zero-write-on-decline). A removal has no proposed content, so an EMPTY file is
  # the diff RHS — the preview renders every line of the doomed file as removed.
  empty_proposed="$(mktemp -t glass-atrium-remove-empty.XXXXXX)"
  : >"${empty_proposed}"
  records=""
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    current="${root}/${path}"
    label="REMOVE ${path} (-> Trash)"
    records="${records}$(printf '%s\t%s\t%s' "${label}" "${current}" "${empty_proposed}")"$'\n'
  done <"${clean_removals}"

  printf '%s' "${records}" | gate_apply_confirmed _update_removal_commit_callback || rc=$?
  rm -f -- "${clean_removals}" "${sensitive_removals}" "${empty_proposed}"
  case "${rc}" in
    0)
      update_log "vendor-removal sweep complete"
      # #13: only on a CONFIRMED sweep (all dropped files moved to Trash) retire the
      # settings.json bindings of any removed hook files — a declined/failed sweep left
      # the files in place, so their bindings MUST stay.
      update_retire_swept_hook_bindings "${_update_removal_paths}" "${root}"
      ;;
    1) update_log "vendor-removal sweep declined — dropped files left in place" ;;
    2) update_log "vendor-removal sweep: nothing to remove" ;;
    3) update_die_code 13 "vendor-removal sweep FAILED to move one or more dropped files to Trash — update files applied, but stale vendor files remain; remove them manually (see the WARN lines above)" ;;
    *) update_die_code 13 "vendor-removal sweep failed (rc ${rc}) — update files applied; stale vendor files may remain" ;;
  esac
}

# The merge → vendor-sweep → baseline-capture → base-content-capture finalize
# sequence, shared by the main post-apply path and both early-return paths
# (already-up-to-date / all-sensitive). ORDER is load-bearing: the sweep keys off
# the STILL-OLD baseline, so it MUST precede update_capture_baseline advancing the
# anchor, and update_capture_base_content follows once the manifest is the new base.
# finding #9 (anchors advance for landed agent merges even on an agent-only /
# sensitive-only update) + finding #14 (a drop-only release still sweeps). Args: $1
# = new-release tree · $2 = manifest · $3 = install root · $4 = prior-vendor
# baseline manifest.
update_finalize_merge_and_anchors() {
  local new_dir="$1" manifest="$2" root="$3" baseline_manifest="$4"
  update_merge_agent_editable_regions "${new_dir}" "${manifest}" "${root}"
  update_sweep_removed_files "${baseline_manifest}" "${manifest}" "${root}"
  update_capture_baseline "${manifest}"
  update_capture_base_content "${new_dir}"
}

update_run() {
  local root work dl_dir new_dir manifest staging snapshot baseline_manifest
  local changed clean_paths sensitive_paths n_sensitive records rc=0 path name
  local withhold_registry=0 orphan_adds orphan_removes
  root="$(update_ga_root)"
  # git is NOT required (see update_preview) — requiring it would loud-fail the
  # git-less no-.git consumer install Phase 2 exists to enable.
  update_require_tools jq python3

  # Retention: prune agents-bak before-image snapshots older than 14 days at the
  # start of every run so the rollback sink cannot grow unbounded.
  update_prune_agents_bak

  # Step 1 — writer-serialization (pause flag → lock; lock contention IS the
  # mid-apply-daemon signal, with stale-dead-holder reclaim).
  update_serialize_begin

  # Headless only: open the update_job tracking row (single-active enforced by the
  # partial unique index → exit 8 on a 2nd active) + load the launchd claude auth
  # token so the merge stage's Haiku verify inherits it (no-ops interactively).
  update_job_begin
  update_headless_load_claude_auth

  # Step 2 — download + stage the latest release.
  work="$(mktemp -d -t glass-atrium-update.XXXXXX)"
  _update_workdir="${work}"
  dl_dir="${work}/download"
  new_dir="${work}/new"
  staging="${work}/staging"
  snapshot="${work}/snapshot"
  mkdir -p -- "${staging}" "${snapshot}"
  update_heartbeat
  update_fetch_release "${dl_dir}" "${new_dir}"
  manifest="${dl_dir}/manifest.json"
  # Record the resolved release version on the job row (INSERT used a placeholder).
  update_job_set_version "$(jq -r '.version // "unknown"' "${manifest}" 2>/dev/null || printf 'unknown')"
  update_heartbeat

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

  # Step 2.5b — finding #16 (ATRIUM_UPDATE_ALLOW_ROSTER fail-closed roster consistency).
  # The override just proceeded past a detected add/remove, but the E4 merge SKIPS a
  # release-only ADD's agents/<name>.md — so letting the deterministic sync swap in the
  # release agent-registry.json would register an agent whose body never landed (a
  # permanently half-applied roster the union-based local roster then masks forever).
  # Fail-closed: mark agent-registry.json to be WITHHELD from the apply set (Step 3)
  # whenever the incoming registry references an agent whose live .md is absent, keeping
  # files and registry consistent (both without the un-installed agent). Only under the
  # override — the un-set path already died at the gate on any roster change.
  if [[ -n "${ATRIUM_UPDATE_ALLOW_ROSTER:-}" ]]; then
    orphan_adds="$(update_roster_orphan_registry_adds "${new_dir}/agent-registry.json" "${root}")"
    if [[ -n "${orphan_adds}" ]]; then
      withhold_registry=1
      update_log "ATRIUM_UPDATE_ALLOW_ROSTER: WITHHOLDING agent-registry.json sync — the agent body is NOT installed for:"
      while IFS= read -r path; do
        [[ -n "${path}" ]] && update_log "  ${path} (run the agent_lifecycle ceremony to install it, then re-run update)"
      done <<<"${orphan_adds}"
    fi
    # Symmetric REMOVE half (finding #16): the release dropped a vendor agent whose
    # USER-EDITABLE body still lingers on disk (agents/*.md is excluded from the
    # vendor sweep). Do NOT withhold the registry (the drop is intended) and do NOT
    # auto-remove the body — emit a loud WARN so the leftover is not silently masked.
    orphan_removes="$(update_roster_orphan_registry_removes "${manifest}" "${new_dir}/agent-registry.json" "${root}" "${baseline_manifest}")"
    if [[ -n "${orphan_removes}" ]]; then
      update_log "ATRIUM_UPDATE_ALLOW_ROSTER: WARN — the release DROPPED an agent whose body still lingers on disk (USER-EDITABLE, not auto-removed) — review for manual removal:"
      while IFS= read -r name; do
        [[ -n "${name}" ]] && update_log "  ${root}/agents/${name}.md (registry key gone; delete via the agent_lifecycle ceremony if the removal is intended)"
      done <<<"${orphan_removes}"
    fi
  fi

  # Step 2.6 — claude -p precondition (headless): BEFORE the merge stage, verify the
  # decoupled job env + the rendered monitor/one-shot plist PATH resolve the claude
  # binary — loud-fail exit 7 if not, so the merge cannot fail cryptically mid-flight.
  update_headless_verify_claude

  # Step 3 — select the changed NON-AGENT files (agent md / overlays / config are
  # excluded by the spine), then partition out sensitive harness files.
  changed="$(spine_find_changed_files "${manifest}" "${root}")" \
    || update_die "change selection failed (manifest hash gap) — refusing to apply"
  if [[ -z "${changed}" ]]; then
    update_log "already up to date — no non-agent files changed"
    # Agent-only release path (finding #9 / #14): still advance the anchors for
    # landed merges (outcome-keyed) and sweep a drop-only release, even with no
    # non-agent content change.
    update_finalize_merge_and_anchors "${new_dir}" "${manifest}" "${root}" "${baseline_manifest}"
    update_finalize_success 0
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
  # finding #16: drop agent-registry.json from the apply set when withheld above, so the
  # deterministic sync cannot register an agent whose body was not installed. Runs after
  # the sensitive partition so the `! -s` empty-set branch below fires if this empties it.
  if [[ "${withhold_registry}" -eq 1 ]]; then
    update_filter_clean_path "${clean_paths}" "agent-registry.json"
  fi
  if [[ ! -s "${clean_paths}" ]]; then
    update_log "no auto-syncable files remain after the sensitive partition — nothing to apply"
    # Sensitive-only path (finding #9 / #14): advance anchors for landed merges
    # (outcome-keyed) and sweep a drop-only release on the all-sensitive path too.
    update_finalize_merge_and_anchors "${new_dir}" "${manifest}" "${root}" "${baseline_manifest}"
    update_finalize_success 0
    return 0
  fi

  # Step 4 (verify) — per-file SHA-256 of every clean changed file == manifest
  # hashes[path], staged into the work dir. Loud-fail leaves the install untouched.
  update_heartbeat
  spine_stage_and_verify "${new_dir}" "${manifest}" "${staging}" <"${clean_paths}" \
    || update_die "per-file hash verification failed — corrupt download, refusing to apply"

  # Step 5 — foreground diff/confirm gate, then deterministic snapshot+swap.
  _update_clean_paths="$(cat "${clean_paths}")"
  _update_staging="${staging}"
  _update_snapshot="${snapshot}"
  update_heartbeat
  records="$(gate_build_nonagent_records "${new_dir}" "${root}" <"${clean_paths}")"
  printf '%s\n' "${records}" | gate_apply_confirmed update_commit_callback || rc=$?
  case "${rc}" in
    0) update_log "non-agent sync applied" ;;
    1) update_die "declined at the confirm gate — no files written" ;;
    2) update_log "no changes to confirm" ;;
    3) update_die "apply failed — the spine rolled back the partial swap (no files changed)" ;;
    *) update_die "apply failed (rc ${rc}) — the spine rolled back any partial swap" ;;
  esac

  # Steps 5b/5c/6 — agent EDITABLE-region merge (E4), then the vendor-removal sweep
  # (#14: drops keyed off the STILL-OLD baseline, previewed through the same confirm
  # gate), then capture the applied manifest as the base@install anchor + persist the
  # new-release agent bodies into the base-content store (T24 — real base TEXT for the
  # next 3-way merge). Ordering is load-bearing: the sweep runs BEFORE the baseline
  # advance and BEFORE the mirror-farm refresh below, so a removed file gains no
  # dangling mirror.
  update_finalize_merge_and_anchors "${new_dir}" "${manifest}" "${root}" "${baseline_manifest}"

  # Step 7 — facade mirror-farm refresh (incident #58325): persist the new
  # manifest, then re-run the per-file symlink farm so every newly-shipped file
  # gains its ~/.claude mirror — in EVERY entry mode (interactive TTY, headless
  # launchd, web button), NOT only the headless post-step.
  update_refresh_mirror_farm "${manifest}"

  # Step 8 — reconcile settings.json hook BINDINGS to the just-applied release
  # (install-parity: run_install wires them via wire_hooks; the spine never
  # touches user-owned settings.json). Idempotent MERGE via the canonical
  # `glass-atrium wire-hooks` subcommand; a release that adds/changes a binding
  # gets it wired here instead of staying dormant until the next full install.
  # Runs AFTER the verified apply + farm refresh so the atomic-restore/rollback
  # contract is intact and the hook files the bindings point at already exist.
  update_wire_hooks_post_apply

  # Headless success finalize: install-parity post-step (monitor rebuild + launchd
  # refresh) then mark the update_job row completed. Interactive mode no-ops both.
  update_finalize_success 1
  update_log "update complete"
}

update_main() {
  # Mode selection (entry-point invariance — CLI + web button both land here).
  # Default = interactive TTY apply; subflags select headless / preview / restore.
  local mode="run" restore_cycle="" arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "${arg}" in
      -h | --help)
        update_usage
        return 0
        ;;
      --headless)
        _update_headless=1
        shift
        ;;
      --preview)
        mode="preview"
        shift
        ;;
      --render-oneshot)
        mode="render-oneshot"
        shift
        ;;
      --restore-agents)
        mode="restore"
        if [[ $# -lt 2 ]]; then
          update_log "--restore-agents requires a <cycle-id>"
          update_usage >&2
          return 2
        fi
        restore_cycle="$2"
        shift 2
        ;;
      --)
        shift
        break
        ;;
      *)
        update_log "unknown argument: ${arg}"
        update_usage >&2
        return 2
        ;;
    esac
  done

  # Source the E3 spine libs (function-only, no side effects). Resolved relative
  # to THIS script's own location (scripts/ → repo scripts/lib), NOT GA_ROOT —
  # GA_ROOT names the install being UPDATED, which the test seam can redirect to a
  # sandbox, whereas the running updater's libs always sit beside it.
  # ATRIUM_UPDATE_LIB_DIR overrides for non-standard layouts.
  local script_dir lib_dir merge_lib_dir
  # Realpath the FILE before dirname — pwd -P cannot dereference a file-level
  # symlink of the script itself, so a facade invocation would mis-anchor
  # lib_dir/merge_lib_dir (incident #58325 failure class; cf. daemon-apply.sh).
  script_dir="$(dirname -- "$(update_realpath "${BASH_SOURCE[0]}")")"
  # Resolved running-script dir — the FIXED, request-independent anchor the headless
  # render-parity post-step resolves render-launchd-plists.sh / render-monitor-env.sh
  # from (SECURITY: never request-derived).
  _update_script_dir="${script_dir}"
  lib_dir="${ATRIUM_UPDATE_LIB_DIR:-${script_dir}/lib}"
  # The agent-merge module + the shared git_txn transaction live under autoagent/lib
  # (a sibling tree to scripts/lib), resolved beside the running updater the same
  # way; ATRIUM_UPDATE_MERGE_LIB_DIR overrides for non-standard layouts.
  merge_lib_dir="${ATRIUM_UPDATE_MERGE_LIB_DIR:-${script_dir}/../autoagent/lib}"
  _update_merge_lib_dir="${merge_lib_dir}"
  # shellcheck source=/dev/null
  source "${lib_dir}/atrium-config.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/update-pause-flag.sh"
  # The shared .apply-lock stale-reclaim guard — the SAME lib daemon-apply.sh
  # sources, so updater and daemon reclaim a crashed holder's lock identically
  # (a divergent reclaim between the two writers would be a race hazard). A static
  # source directive lets ShellCheck follow it and SEE apply_lock_acquired
  # assigned (silences SC2154, the same way the git-txn source below does).
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=./lib/apply-lock.sh
  source "${lib_dir}/apply-lock.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/apply-spine.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/apply-gate.sh"
  # shellcheck source=/dev/null
  source "${lib_dir}/sensitive-refusal.sh"
  # Headless claude auth: a launchd job cannot use the GUI keychain, so the merge
  # stage's Haiku verify needs the 0600 token file's exporter. Function-only source.
  # shellcheck source=/dev/null
  source "${lib_dir}/claude-auth-env.sh"
  # The facade mirror-farm refresh wrapper (incident #58325) — farm_refresh /
  # farm_write_present_manifest / farm_prune_advisory, consumed post-apply by
  # update_refresh_mirror_farm. Function-only source (static directive so
  # ShellCheck follows it under --external-sources, the apply-lock.sh idiom).
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=./lib/mirror-farm.sh
  source "${lib_dir}/mirror-farm.sh"
  # The agent-merge transaction lib. A static source directive (resolved relative
  # to this script's own dir) lets ShellCheck follow it under --external-sources
  # and SEE the GIT_TXN_* constants (silences SC2154 the way daemon-apply.sh does).
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=../autoagent/lib/git-txn.sh
  source "${merge_lib_dir}/git-txn.sh"

  # Register cleanup BEFORE any state is created so an early failure still unwinds.
  trap update_cleanup EXIT INT TERM
  case "${mode}" in
    preview) update_preview ;;
    restore) update_restore_agents "${restore_cycle}" ;;
    render-oneshot) update_render_oneshot_plist ;;
    *) update_run ;;
  esac
}

# Execute only when run directly — sourcing (the bats suite) exposes the functions
# without running the orchestration.
if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  update_main "$@"
fi
