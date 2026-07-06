# shellcheck shell=bash
# Glass Atrium — shared core for the install/uninstall engine. SOURCED ONLY by the
# executable entry point (glass-atrium) — it has no entrypoint dispatch and no
# file-scope `set -Eeuo pipefail`/`IFS`/traps (strict mode + traps stay owned by
# the entry point so re-sourcing never re-arms them).
# ga_init_env "<GA_ROOT>" MUST be called once with the ENTRY POINT'S resolved root
# before any other function — GA_ROOT is passed in, NEVER self-derived from this
# file's BASH_SOURCE (which would resolve to <root>/lib/, one dir too deep).

# === thin-loader: source the seven functional-domain siblings =============
# ga-core.sh is a THIN LOADER: it sources the seven domain siblings (byte-identical
# extractions of the former inline concerns) then defines the flow/orchestration
# functions inline below. Because `source lib/ga-core.sh` transitively loads every
# domain, all downstream consumers keep the whole engine after one source (zero
# consumer edits). Self-locates its own lib/ dir from BASH_SOURCE (source-path
# agnostic) — GA_ROOT still arrives ONLY via ga_init_env's $1, never self-derived
# here. Order is env-first defensive (D2): the source-time surface is empty so any
# permutation is correct today, env-first future-proofs a latent top-level stmt.
# Each source is an explicit loud-fail guard: printf (NOT log — log lives in
# ga-env.sh and is undefined if THAT source fails) to stderr + `return 1`; never
# `|| true`, never an implicit `set -e` (bats consumers source this WITHOUT strict
# mode, so the explicit guard is what fails loudly under both callers).
__ga_core_libdir="${BASH_SOURCE[0]%/*}"
# shellcheck source=lib/ga-env.sh
source "${__ga_core_libdir}/ga-env.sh" || {
  printf "%s\n" "FATAL: cannot source ga-env.sh" >&2
  return 1
}
# shellcheck source=lib/ga-symlink.sh
source "${__ga_core_libdir}/ga-symlink.sh" || {
  printf "%s\n" "FATAL: cannot source ga-symlink.sh" >&2
  return 1
}
# shellcheck source=lib/ga-config-hooks.sh
source "${__ga_core_libdir}/ga-config-hooks.sh" || {
  printf "%s\n" "FATAL: cannot source ga-config-hooks.sh" >&2
  return 1
}
# shellcheck source=lib/ga-launchd.sh
source "${__ga_core_libdir}/ga-launchd.sh" || {
  printf "%s\n" "FATAL: cannot source ga-launchd.sh" >&2
  return 1
}
# shellcheck source=lib/ga-db.sh
source "${__ga_core_libdir}/ga-db.sh" || {
  printf "%s\n" "FATAL: cannot source ga-db.sh" >&2
  return 1
}
# shellcheck source=lib/ga-daemons.sh
source "${__ga_core_libdir}/ga-daemons.sh" || {
  printf "%s\n" "FATAL: cannot source ga-daemons.sh" >&2
  return 1
}
# shellcheck source=lib/ga-doctor.sh
source "${__ga_core_libdir}/ga-doctor.sh" || {
  printf "%s\n" "FATAL: cannot source ga-doctor.sh" >&2
  return 1
}
unset __ga_core_libdir

# remove_node_modules — uninstall teardown: rm -rf monitor/node_modules to reclaim
# disk. node_modules is a regenerable build artifact (reinstall's oss-db-setup.sh
# bootstrap runs `npm ci`), so `rm` is correct here — the File Deletion Policy
# permits rm for regenerable files (NOT mv-to-Trash). IDEMPOTENT: an absent dir is
# a clean skip. The path is a fixed ${GA_ROOT}-anchored literal (the same install-
# tree anchor every other monitor step uses) — never a bare/relative/glob path.
# Returns 0 (teardown is best-effort, never fatal).
remove_node_modules() {
  local nm="${GA_ROOT}/monitor/node_modules"
  if "${DRY_RUN}"; then
    log "dry-run: skipping node_modules removal (${nm})"
    return 0
  fi
  if [[ ! -d "${nm}" ]]; then
    log "uninstall: ${nm} absent — nothing to remove"
    return 0
  fi
  # SECURITY: path is a fixed ${GA_ROOT}-anchored literal (no glob, no user input,
  # GA_ROOT is readonly + non-empty by construction) — rm -rf is scoped to exactly
  # this regenerable dir.
  # Best-effort, never fatal: under the inherited set -Eeuo pipefail a genuine rm
  # failure would otherwise abort before the return 0 (and halt later teardown steps,
  # since the run_uninstall call site is not if-wrapped). Explicit if (NOT a silent
  # `|| true`) so the failure is logged, then the contract's return 0 still holds.
  if ! rm -rf -- "${nm}"; then
    log "uninstall: warn: could not fully remove ${nm} (continuing)"
  else
    log "uninstall: removed ${nm} (regenerable — reinstall runs npm ci)"
  fi
  return 0
}

# remove_rc_lines — uninstall teardown: strip the PATH-export lines that install
# persisted into the user's login-shell rc (inverse of preflight_persist_rc_line in
# glass-atrium). Install tags EVERY persisted line with a trailing ` # glass-atrium`
# marker; this removes ONLY lines bearing that EXACT marker — never a bare `export PATH`
# (which would clobber the user's own lines). Both ~/.zshrc AND ~/.bash_profile are
# swept because the active $SHELL at uninstall time may differ from install time.
# SAFETY: a timestamped .ga-backup copy is taken BEFORE any edit (never edit a user rc
# without a backup); the marker-matched lines are removed via grep -v to a temp file +
# atomic mv (never a partial rc). IDEMPOTENT: an absent file or a file with no marker is
# a clean skip. GRACEFUL: returns 0 unconditionally — an rc edit failure NEVER aborts the
# rest of uninstall. LEGACY CAVEAT: pre-marker installs wrote UNMARKED rc lines that this
# (deliberately) will not catch — that is the accepted, safe forward path (better to leave
# a stale-but-harmless PATH line than to risk removing a user-authored one).
remove_rc_lines() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping shell rc PATH-line removal"
    return 0
  fi
  local marker=" # glass-atrium" rc backup tmp removed before after
  for rc in "${HOME}/.zshrc" "${HOME}/.bash_profile"; do
    # IDEMPOTENT: absent rc, or one with no GA-marked line, is a clean skip. grep -F
    # (fixed-string) on the exact marker — no regex, no bare-export match.
    [[ -f "${rc}" ]] || continue
    if ! grep -qF "${marker}" "${rc}" 2>/dev/null; then
      continue
    fi
    # SAFETY: back up the user rc BEFORE the first mutation (timestamped, recoverable).
    backup="${rc}.ga-backup.$(date +%Y%m%d-%H%M%S)"
    if ! cp -p -- "${rc}" "${backup}"; then
      log "uninstall: warn: could not back up ${rc} — leaving rc untouched"
      continue
    fi
    # Count matched lines for the log (grep -c emits an integer; guard the empty case).
    before="$(grep -cF "${marker}" "${rc}" 2>/dev/null || true)"
    [[ -n "${before}" ]] || before=0
    # SECURITY: remove ONLY the marker-tagged lines — grep -vF keeps every other line
    # verbatim (a user's own `export PATH` without the marker is preserved untouched).
    tmp="${rc}.ga-rcstrip.$$"
    if ! grep -vF "${marker}" "${rc}" >"${tmp}" 2>/dev/null; then
      # grep -v exits 1 when it filters away EVERY line (all lines were GA-marked):
      # an empty output file is the correct result, not an error. Distinguish that
      # (empty tmp) from a genuine failure (tmp missing) before treating it as fatal.
      if [[ ! -f "${tmp}" ]]; then
        log "uninstall: warn: rc filter failed for ${rc} (backup at ${backup}) — skipped"
        continue
      fi
    fi
    after="$(grep -cF "${marker}" "${tmp}" 2>/dev/null || true)"
    [[ -n "${after}" ]] || after=0
    # atomic replace: never leave a half-written rc.
    if ! mv -f -- "${tmp}" "${rc}"; then
      log "uninstall: warn: could not replace ${rc} (backup at ${backup}) — skipped"
      rm -f -- "${tmp}" 2>/dev/null || true
      continue
    fi
    removed=$((before - after))
    log "uninstall: removed ${removed} GA-marked PATH line(s) from ${rc} (backup: ${backup})"
  done
  return 0
}

# === [6] orchestration =====================================================

# --- install orchestration -------------------------------------------------
run_install() {
  # Capture the doctor verdict without tripping set -e OR the ERR trap on an
  # expected non-zero (FAIL) return: suspend both for the single call, restore
  # immediately, then branch. (SC2310-clean — call is not in a condition.)
  local doctor_rc
  set +e
  trap - ERR
  run_doctor "preflight"
  doctor_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  [[ "${doctor_rc}" -eq 0 ]] || die "doctor preflight failed — aborting install"

  # clear any STALE detached daemon tmux session before a fresh install: a
  # `claude-{wiki,autoagent}-daemon` session left over from a prior install (it
  # survives launchctl bootout + plugin uninstall) would otherwise linger with a
  # broken config. Guarded (DRY_RUN + sandbox + tmux-absent); a reinstall's own
  # daemons start clean afterward.
  kill_daemon_tmux_sessions

  # config.toml render — MUST precede any render-monitor-env.sh invocation
  # (ordering contract: that script validates [paths].monitor_docs_html_root as
  # an existing absolute dir, which an unexpanded ${HOME} literal would fail).
  # Runs before the symlink farm so a clean install has a rendered config ready.
  render_config

  # rendered launchd plists track the just-rendered config (file-write only —
  # loading stays manual, see render_plists)
  render_plists

  run_symlink_farm "install"

  # wire the Atrium hook bindings into settings.json (idempotent MERGE — owns
  # ONLY the Atrium hook commands, preserves every user-owned key). Runs after
  # the symlink farm so the hook FILES exist before they are bound. Skipped in
  # dry-run (mutation-free staging).
  wire_hooks

  # legacy-farm migration AFTER wire_hooks — repoint-first-THEN-sweep: the
  # settings.json bindings above already point at the in-place hooks dir, so
  # dropping the legacy bare-name-farm symlinks opens no hook-blackout window.
  # GA-link-guarded + idempotent (fresh install = clean no-op); honors DRY_RUN.
  migrate_layout

  # DB bootstrap BEFORE the launchd repoint — a (re)bootstrapped monitor daemon
  # needs the schema in place at first start. Skipped in dry-run; fast-path
  # no-op when the DB already exists (see setup_database).
  setup_database

  # launchd repoint is the only step gated by --repoint-launchd + never dry-run
  repoint_launchd

  # post-install `claude --version` liveness check (advisory) — confirms the CLI
  # runs after install. Deliberately `--version`, NOT `claude doctor` (doctor
  # detaches hanging MCP children — see doctor_postcheck). ADVISORY ONLY: absence
  # of the `claude` CLI or a non-zero exit is logged, never fatal (a sandbox / CI
  # host often lacks the CLI). Skipped in dry-run.
  doctor_postcheck

  # T24 — snapshot the just-installed manifest as the base@install baseline anchor.
  # Runs LAST (after the symlink farm + doctor postcheck) so the baseline reflects
  # the fully-installed tree. The post-APPLY baseline refresh is a SEPARATE seam
  # owned by the updater (scripts/update.sh update_capture_baseline) — NOT merged
  # here; this is install-time capture only.
  capture_install_baseline
}

# --- T24: base@install baseline capture (post-install) ---------------------
# Snapshot the installed manifest.json as the base@install baseline — the PRIMARY
# 3-anchor base the NEXT update diffs against (apply-spine spine_set_baseline
# writes it atomically to the canonical update-state dir, ATRIUM_UPDATE_STATE_DIR-
# overridable). ADVISORY-but-loud: a capture miss is WARNed, never fatal — the
# install itself already succeeded, and a missing baseline only widens the next
# update's merge base (the updater also re-captures its own baseline post-apply).
# Skipped in dry-run (mutation-free staging).
capture_install_baseline() {
  if "${DRY_RUN}"; then
    log "baseline: dry-run — skipping base@install capture (would snapshot ${MANIFEST})"
    return 0
  fi
  if [[ ! -f "${MANIFEST}" ]]; then
    log "  warn : baseline capture skipped — manifest absent (${MANIFEST})"
    return 0
  fi
  local stored
  # spine_set_baseline echoes the stored path / loud-fails (rc 1) on a missing
  # source manifest. Masking its rc in the `if` condition is intentional: this
  # post-install advisory must NEVER abort the already-succeeded install
  # (SC2310/SC2311 = the sourced-lib analog; no file-scope set -e in the lib).
  # shellcheck disable=SC2310,SC2311
  if stored="$(spine_set_baseline "${MANIFEST}")"; then
    log "baseline: captured base@install anchor -> ${stored}"
  else
    log "  warn : baseline capture failed (manifest=${MANIFEST}) — next update will re-derive its base"
  fi

  # T24 — ALSO seed the base-content STORE. The hash-only baseline manifest above
  # proves a file CHANGED but cannot reconstruct the base region TEXT a 3-way merge
  # needs (there is no content-from-hash). Seeding the store lets the NEXT update do
  # a REAL diff3 (base/vendor/local) instead of the gated-2-way present-both
  # fallback. Advisory like the manifest capture: a seeding miss only widens the
  # next update's merge gate, never aborts the already-succeeded install.
  capture_base_agent_store
}

# --- T24: base@install EDITABLE-region content store (post-install) ---------
# Snapshot each base@install agent *.md BODY into the base-content store that
# editable_merge.load_base_text CONSUMES — keyed by BASENAME under
# <state-dir>/base-agents/ (the editable_merge.base_store_dir layout, where
# state-dir == spine_baseline_dir so the hash manifest + the content store share
# one update-state root). WITH this store the next update resolves an EDITABLE
# region via a real 3-anchor diff3; WITHOUT it editable_merge degrades
# safety-conservatively to the gated-2-way fallback (more human gating, never a
# silent corrupt). The updater (scripts/update.sh update_capture_base_content)
# re-seeds the SAME store post-apply; install seeds it first.
#
# Source bodies come from ${GA_ROOT}/<rel> (the real release files the symlink farm
# points at), NOT the installed target symlinks. Only agents/*.md carry EDITABLE
# regions (the canonical predicate mirrors spine_is_excluded_path's agent-markdown
# branch). ADVISORY + loud: every copy miss is WARNed + counted, never fatal — the
# install already succeeded, and a partial store only widens the next merge gate.
capture_base_agent_store() {
  local store rel src dst base copied=0 missing=0
  store="$(spine_baseline_dir)/base-agents"
  if ! mkdir -p -- "${store}"; then
    log "  warn : base-content store dir uncreatable (${store}) — next update falls back to the gated-2-way merge"
    return 0
  fi
  # read_manifest_files dies on its OWN precondition failure (jq absent / manifest
  # missing) — both already guaranteed false here (the caller guarded MANIFEST
  # presence; jq is an install-wide hard dep). Even so, a die fires INSIDE the
  # process-substitution subshell only, so the loop would just see empty input
  # (copied=0) — never an aborted install. Process sub (not a pipe) keeps the
  # counters in THIS shell.
  # shellcheck disable=SC2312
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    # canonical "agent markdown" predicate (mirrors spine_is_excluded_path).
    [[ "${rel}" == agents/* && "${rel}" == *.md ]] || continue
    src="${GA_ROOT}/${rel}"
    if [[ ! -f "${src}" ]]; then
      missing=$((missing + 1))
      continue
    fi
    # basename-keyed store: editable_merge.load_base_text reads <store>/<basename>.
    base="$(basename -- "${rel}")"
    dst="${store}/${base}"
    # cp in an `if` masks set -e by design (a single copy miss is advisory, not a
    # fatal — it degrades that ONE region to the gated-2-way fallback).
    if cp -p -- "${src}" "${dst}"; then
      copied=$((copied + 1))
    else
      log "  warn : base-content copy failed for ${rel} — that region degrades to the gated-2-way merge"
      missing=$((missing + 1))
    fi
  done < <(read_manifest_files)
  if [[ "${missing}" -gt 0 ]]; then
    log "baseline: base-content store seeded (${copied} agent bodies -> ${store}; ${missing} source(s) missing/uncopyable — those regions degrade to the gated-2-way merge)"
  else
    log "baseline: base-content store seeded (${copied} agent bodies -> ${store})"
  fi
}

# --- agents-only symlink farm (agent add/delete scope) ---------------------
# Runs ONLY the per-file symlink-farm loop from run_install — the minimal step
# the F2 agent-lifecycle CLI needs to (re)link manifest entries after an agent
# add/delete. Reuses read_manifest_files + swap_symlink; honours TARGET_HOME +
# DRY_RUN. Deliberately SKIPS run_doctor / render_config / render_plists /
# wire_hooks / setup_database — a doctor preflight that dies (or rewriting
# settings.json / re-rendering config) is far beyond an agent-link refresh.
run_agents_only() {
  run_symlink_farm "agents-only"
}

# --- prune ORPHAN dangling GA symlinks (recurrence-prevention) --------------
# The symlink farm has no prune path: when a source file is dropped from the GA
# root AND from the manifest, its previously-installed symlink in the target is
# left dangling forever (doctor §5 only WARN-counts danglers, never unlinks).
# run_prune SAFELY removes those ORPHANS. A link is removed ONLY if it satisfies
# ALL FOUR criteria (mirrors the manual prune):
#   (a) IS a symlink                  } both guaranteed by the doctor §5
#   (c) target is under the GA root   } `find -type l -lname GA/*` idiom
#   (b) is BROKEN (target missing)    — [[ ! -e ]], the §5 resolving-preserve test
#   (d) its TARGET_HOME-rel path is NOT in manifest .files
# A BROKEN link that IS in the manifest = a should-exist source transiently
# missing → PRESERVE + flag (never remove). is_never_touch is a defense-in-depth
# preserve branch. A resolving symlink / non-symlink real file / foreign-target
# symlink is NEVER a candidate (criteria b / a+c exclude them structurally).
#
# EXPLICIT-OPT-IN: zero call sites inside run_install / run_bootstrap /
# run_agents_only — deleting during a routine install is unsafe.
# Exit codes (loud-fail, distinct from die's generic 1): 2 = no target dir,
# 3 = manifest absent/unparseable. --dry-run reports but removes nothing.
run_prune() {
  # STEP1 — preconditions (loud-fail, named exit codes; no silent absorption).
  if [[ ! -d "${TARGET_HOME}" ]]; then
    printf 'FATAL: prune target home not a directory: %s\n' "${TARGET_HOME}" >&2
    exit "${PRUNE_EXIT_NO_TARGET}"
  fi
  command -v jq >/dev/null 2>&1 \
    || {
      printf 'FATAL: jq required to parse %s\n' "${MANIFEST}" >&2
      exit "${PRUNE_EXIT_NO_MANIFEST}"
    }
  jq -e '.files | type == "array"' -- "${MANIFEST}" >/dev/null 2>&1 \
    || {
      printf 'FATAL: manifest absent or .files not an array: %s\n' "${MANIFEST}" >&2
      exit "${PRUNE_EXIT_NO_MANIFEST}"
    }

  log "== prune: orphan dangling GA symlinks (target=${TARGET_HOME}) =="
  "${DRY_RUN}" && log "(dry-run: report only — no unlink)"

  # STEP2 — build the manifest set ONCE (read-set-then-act: a mid-loop manifest
  # change cannot flip a removal decision). Newline-delimited TARGET_HOME-rel
  # paths for the criterion-d grep -Fxq lookup (bash 3.2 — no declare -A).
  local manifest_set
  # read_manifest_files dies on its own failure (already precondition-guarded
  # above); the command-substitution masks its rc, which is benign here.
  # (SC2311 = the sourced-lib analog; no file-scope set -e visible to shellcheck)
  # shellcheck disable=SC2311,SC2312
  manifest_set="$(read_manifest_files)"

  # STEP3+4+5 — enumerate candidates (doctor §5 idiom: find guarantees a+c),
  # then per-candidate apply criteria b + d + never-touch and remove/flag.
  local pruned=0 flagged=0 nevertouch=0 candidates=0 link rel
  # find ends with `|| true` → masked exit is benign; process substitution keeps
  # the loop in the current shell (counter-var-safe).
  # shellcheck disable=SC2312
  while IFS= read -r link; do
    [[ -n "${link}" ]] || continue
    candidates=$((candidates + 1))
    # (b) BROKEN — a resolving symlink is preserved (swap_symlink's concern).
    if [[ -e "${link}" ]]; then
      continue
    fi
    # TARGET_HOME-rel path = absolute link minus the exact "${TARGET_HOME}/" prefix.
    rel="${link#"${TARGET_HOME}"/}"
    # (d) NOT-IN-MANIFEST — a broken link that IS in the manifest means its
    # source is transiently missing (a should-exist file): preserve + flag.
    if printf '%s\n' "${manifest_set}" | grep -Fxq -- "${rel}"; then
      log "  flag : broken GA symlink in manifest (source transiently missing, preserved): ${link}"
      flagged=$((flagged + 1))
      continue
    fi
    # never-touch defense-in-depth — a never-touch path should never be a GA
    # symlink, but if one is, preserve it.
    # is_never_touch returns 0 by contract (stdout verdict) → masking is intentional
    # (SC2311 = the sourced-lib analog of SC2310; no file-scope set -e here)
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_never_touch "${rel}")" == "yes" ]]; then
      log "  keep : never-touch path preserved: ${link}"
      nevertouch=$((nevertouch + 1))
      continue
    fi
    # (a,b,c,d) all hold → remove (unlink only; never rm -rf, target already gone).
    if "${DRY_RUN}"; then
      log "  dry-run: would prune orphan GA symlink: ${link}"
    else
      rm -f -- "${link}"
      log "  prune: removed orphan GA symlink: ${link}"
    fi
    pruned=$((pruned + 1))
  done < <(find "${TARGET_HOME}" -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)

  # STEP6 — summary. Empty candidate set is a no-op (rc 0) with a no-orphan line.
  if [[ "${candidates}" -eq 0 ]]; then
    log "== prune: no GA symlinks under target — nothing to do =="
    return 0
  fi
  local verb="pruned"
  "${DRY_RUN}" && verb="would be pruned"
  log "== prune: ${pruned} ${verb}, ${flagged} flagged in-manifest, ${nevertouch} preserved never-touch (${candidates} candidates) =="
}

# --- P2 essential-symlinks-only MIGRATION (legacy bare-name farm -> new layout)
# Idempotent, data-safe reconcile of an EXISTING bare-name-farm install to the
# essential-symlinks-only + foldered-rules layout. Touches ONLY GA-CREATED
# symlinks — every unlink routes through remove_if_ga_link's readlink-into-
# GA_ROOT guard, so a foreign symlink OR a real user file at any of these paths
# is preserved byte-for-byte (never a raw rm on a legacy path). Two moves:
#   (A) DROP the now-excluded surfaces — unlink the legacy GA symlinks under
#       hooks/ + scoped/ + scripts/ + autoagent/ (prefixes) and at
#       agent-registry.json + glass-atrium (exacts) a prior farm created, then
#       rmdir-prune the emptied GA dirs (rmdir-only — a dir holding a user file
#       makes rmdir fail = SAFE skip). The find sweep is RECURSIVE (no maxdepth),
#       so nested legacy links (scripts/lib, scripts/agent_lifecycle, autoagent/
#       lib) are covered without a per-depth pass.
#   (B) FOLD the rules — relocate each flat rules/<name>.md GA symlink to the
#       foldered rules/glass-atrium/<name>.md location, but ONLY when the
#       foldered GA source actually exists (post rules-fold unit); otherwise the
#       flat link is LEFT IN PLACE (no dangling link) for the manifest re-farm to
#       reconcile once the foldered source lands.
# Idempotent by construction: a second run finds the excluded-surface links gone
# (nothing to sweep) and the flat rules links already relocated (the foldered
# link sits at depth 2, never re-matched by the maxdepth-1 scan), so it is a
# clean no-op. Honors DRY_RUN (report-only, zero mutation).
#
# CALL-SITES (repoint-first-THEN-sweep contract): (1) run_install invokes this
# immediately AFTER wire_hooks — the settings.json hook commands already point
# at the in-place hooks dir before the legacy links drop, so no hook-blackout
# window opens; (2) the `glass-atrium migrate` passthrough subcommand exposes a
# standalone (re-)run for an existing deployment (honors --dry-run). Sweeping
# before the repoint would orphan the live hooks/registry consumers — keep any
# new call site BEHIND the repoint.
migrate_layout() {
  log "== migrate: reconcile legacy bare-name farm -> essential-symlinks-only + foldered-rules (target=${TARGET_HOME}) =="
  "${DRY_RUN}" && log "(dry-run: report only — no unlink/relink)"
  if [[ ! -d "${TARGET_HOME}" ]]; then
    log "migrate: target home absent (${TARGET_HOME}) — nothing to migrate"
    return 0
  fi

  local prefix dir link rc exact swept=0
  # (A) DROP the now-excluded surfaces — GA symlinks only (remove_if_ga_link guard).
  for prefix in "${SYMLINK_EXCLUDE_PREFIXES[@]}"; do
    dir="${TARGET_HOME}/${prefix%/}"
    # a REAL dir only (never follow a symlinked dir) — lib//monitor/ were never
    # farmed so their dirs are typically absent (skip); hooks//scoped//scripts//
    # autoagent/ present on a legacy install.
    [[ -d "${dir}" && ! -L "${dir}" ]] || continue
    # each candidate is re-verified inside remove_if_ga_link before any unlink;
    # process substitution keeps the counter in this shell, find's masked exit
    # (|| true) is benign.
    # shellcheck disable=SC2312
    while IFS= read -r link; do
      [[ -n "${link}" ]] || continue
      # return 1 = safe skip (foreign/real/never-touch) — bracket the single call
      # with set +e + ERR-trap suspend (set -E propagates the trap into the
      # callee, so a safe-skip non-zero would print a spurious ERROR line).
      set +e
      trap - ERR
      remove_if_ga_link "${link}"
      rc=$?
      trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
      set -e
      [[ "${rc}" -eq 0 ]] && swept=$((swept + 1))
    done < <(find "${dir}" -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)
  done
  for exact in "${SYMLINK_EXCLUDE_EXACT[@]}"; do
    link="${TARGET_HOME}/${exact}"
    [[ -L "${link}" ]] || continue
    set +e
    trap - ERR
    remove_if_ga_link "${link}"
    rc=$?
    trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
    set -e
    [[ "${rc}" -eq 0 ]] && swept=$((swept + 1))
  done

  # prune the emptied excluded-surface dirs (rmdir-only — a dir still holding a
  # user file makes rmdir fail = SAFE skip; NEVER rm -rf, per the rm-rf guardrail).
  for prefix in "${SYMLINK_EXCLUDE_PREFIXES[@]}"; do
    dir="${TARGET_HOME}/${prefix%/}"
    [[ -d "${dir}" && ! -L "${dir}" ]] || continue
    if "${DRY_RUN}"; then
      log "migrate: dry-run — would rmdir emptied GA dir if empty: ${prefix%/}"
      continue
    fi
    # rmdir in an `if` masks BOTH set -e and the ERR trap for its expected
    # non-zero (dir non-empty) → no set +e/trap bracketing needed.
    if rmdir -- "${dir}" 2>/dev/null; then
      log "migrate: removed emptied GA dir: ${prefix%/}"
    fi
  done

  # (B) FOLD the rules — relocate each flat rules/<name>.md GA symlink to the
  # foldered rules/glass-atrium/<name>.md, only when the foldered GA source exists.
  local rules_dir="${TARGET_HOME}/rules" base folded_rel folded=0
  if [[ -d "${rules_dir}" && ! -L "${rules_dir}" ]]; then
    # maxdepth 1 → only FLAT rules links; an already-foldered link lives at
    # rules/glass-atrium/ (depth 2) and is never re-matched (loop is idempotent).
    # shellcheck disable=SC2312
    while IFS= read -r link; do
      [[ -n "${link}" ]] || continue
      base="$(basename -- "${link}")"
      folded_rel="rules/glass-atrium/${base}"
      # never create a dangling link: skip the fold until the foldered GA source
      # lands (rules-fold unit); the flat link stays put for the re-farm.
      if [[ ! -e "${GA_ROOT}/${folded_rel}" ]]; then
        log "migrate: foldered rules source absent (${folded_rel}) — leaving flat link ${base} for manifest re-farm"
        continue
      fi
      # remove the flat GA link (guarded — a foreign/real file returns 1 and is
      # left intact), then create the foldered link via swap_symlink (its
      # per-file mkdir -p auto-creates rules/glass-atrium/, atomic + idempotent).
      set +e
      trap - ERR
      remove_if_ga_link "${link}"
      rc=$?
      trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
      set -e
      [[ "${rc}" -eq 0 ]] || continue
      set +e
      trap - ERR
      swap_symlink "${folded_rel}"
      rc=$?
      trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
      set -e
      [[ "${rc}" -eq 0 ]] && folded=$((folded + 1))
    done < <(find "${rules_dir}" -maxdepth 1 -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)
  fi

  log "== migrate: ${swept} legacy GA symlink(s) dropped, ${folded} rules link(s) foldered =="
}

# --- one-stop bootstrap (install + monitor build + health gate) ------------
# Single-command wrap of the FULL fresh-machine sequence: run_install (doctor →
# config render → plist render → symlink farm → hook wiring → DB bootstrap →
# launchd repoint → claude --version) THEN monitor `npm run build` and a /api/
# health gate. Named exit codes (loud-fail, no silent absorption). launchd job
# LOADING stays manual (review-first ethos) BY DEFAULT — never launchctl from
# here UNLESS the opt-in --load-launchd flag is set, in which case the 8 jobs
# load AFTER the health gate passes (phase 4, load_launchd_jobs).
#
# Exit-code semantics (distinct from die's generic 1):
#   20 = monitor build failed   21 = monitor health gate failed (no 200 in window)
#   22 = --load-launchd: rendered plists absent   23 = --load-launchd: a bootstrap failed
# DB-conflict recreate is opt-in via --recreate-db (NEVER touches live 'glass_atrium').
run_bootstrap() {
  # phase 1 — the full base install (doctor-gated; aborts on any sub-step die).
  log "== bootstrap [1/3]: base install sequence =="
  run_install

  if "${DRY_RUN}"; then
    log "== bootstrap: dry-run — skipping monitor build + health gate =="
    # still exercise the load step so dry-run reports what --load-launchd WOULD do.
    load_launchd_jobs
    return 0
  fi

  # phase 2 — monitor production build (tsc + assets + client JSX). npm absence
  # is a loud-fail with a named exit code (no silent absorption).
  log "== bootstrap [2/3]: monitor build (npm run build, cwd=${GA_ROOT}/monitor) =="
  command -v npm >/dev/null 2>&1 \
    || die "npm not found — monitor build needs Node.js (install Node 24, then re-run bootstrap)"
  (cd -- "${GA_ROOT}/monitor" && npm run build) || {
    printf 'FATAL: monitor build failed (npm run build) — see output above\n' >&2
    exit "${BOOTSTRAP_EXIT_BUILD}"
  }
  log "== bootstrap: monitor build done =="

  # phase 3 — health gate: start the monitor directly (no launchd), poll /api/
  # health within the window, then stop it. A failed gate exits 21 (the build
  # succeeded but the server did not come up healthy). die/exit on failure means
  # the load step below is reached ONLY on a passed gate.
  bootstrap_health_gate

  # phase 4 (OPT-IN) — load the 8 rendered launchd jobs. Fires ONLY behind
  # --load-launchd; default (no flag) leaves loading to the operator (review-first).
  # Gated post-gate by control flow: a failed gate already exited above.
  load_launchd_jobs
}

# --- uninstall orchestration -----------------------------------------------
# Parallel to run_install: the callable uninstall flow. --verify-clean and
# --orphan-scan are mutually-exclusive standalone modes the launcher dispatches
# before reaching here; run_uninstall is the default removal path. Order:
# launchd teardown → DB drop → node_modules removal → manifest-link removal →
# orphan sweep → empty-dir cleanup → hook un-wire → shell-rc PATH-line removal →
# (opt-in config purge).
# launchd teardown runs FIRST so the daemons stop (connections drain) before the DB
# is dropped and before their symlinked files vanish.
run_uninstall() {
  log "== uninstall: removing GA symlinks (target=${TARGET_HOME}) =="
  # STEP1 — stop + deregister the com.glass-atrium.* launchd jobs before the
  # symlinks they depend on are swept (bootout the daemons first).
  unload_launchd_jobs
  # STEP1b — stop the DETACHED daemons launchctl bootout does NOT reach: the
  # daemon tmux sessions (reparented to PID 1) and lingering fakechat channel
  # procs. MUST run BEFORE the DB drop so the daemons release their DB connections
  # first. The postgres server + its socket are left untouched (never GA's to stop).
  stop_detached_daemons
  # STEP2 — back up, then drop, the GA databases (connections now drained).
  # BACKUP-BEFORE-DROP, fail-closed per DB: a failed/empty pre-drop pg_dump skips
  # that DB's drop (data preserved) — reinstall recreates a fresh, consistent DB.
  # Graceful-on-failure.
  drop_databases
  # STEP3 — reclaim disk: remove the regenerable monitor/node_modules.
  remove_node_modules
  remove_manifest_links
  sweep_orphans

  # STEP4 — INSTALL/UNINSTALL DIRECTORY SYMMETRY: the symlink passes above unlink
  # FILES but leave behind the empty DIRECTORY skeletons swap_symlink's `mkdir -p`
  # created (agents/, hooks/, skills/<name>/, ...). Runs AFTER both symlink passes
  # so those dirs are actually empty; rmdir-only (never rm -rf) so any dir holding
  # a user file survives untouched.
  remove_empty_dirs

  # T26 — explicit NON-SYMLINK update-state teardown. remove_manifest_links +
  # sweep_orphans only reach SYMLINKS, so the update system's plain-file runtime
  # state (pause flag) + recovery state (base@install baseline) would fossilize
  # after an uninstall unless torn down explicitly here.
  teardown_update_state

  # parity with install's additive wiring: un-wire ONLY the Atrium hook
  # bindings (matcher + Atrium-path scoped, backed up, additive-safe).
  unwire_hooks

  # inverse of install's preflight_persist_rc_line: strip the ` # glass-atrium`-marked
  # PATH-export lines from ~/.zshrc + ~/.bash_profile (marker-scoped, backed up first,
  # never touches a user-authored line). Graceful — never aborts uninstall.
  remove_rc_lines

  # config purge is opt-in (the user may have tuned the rendered config); when
  # requested, mv-to-Trash (never rm a config).
  if "${PURGE_CONFIG}"; then
    purge_config
  else
    log "uninstall: config.toml left in place (pass --purge-config to move it to the Trash)"
  fi

  log "== uninstall: done (real files + user files + never-touch untouched) =="
}

# --- T26: non-symlink update-state teardown (uninstall) --------------------
# The symlink farm helpers (remove_manifest_links/sweep_orphans) only unlink
# SYMLINKS; the update system's runtime/recovery state lives in PLAIN files that
# they never reach, so this explicit step tears them down:
#   * pause flag (GA_ROOT/.update-state/autoagent-pause.flag): ephemeral daemon-
#     coordination state — ALWAYS removed (a residual flag after uninstall is
#     meaningless and could wrongly suspend a later reinstall's daemon).
#     update_pause_remove is idempotent (absent flag → no-op).
#   * base@install baseline (the next update's diff base): RECOVERY state — KEPT
#     by default, mirroring config.toml's keep-unless-`--purge-config` policy;
#     moved to the Trash (never rm'd, per the file-deletion policy) ONLY under
#     --purge-config.
# Dry-run reports each action without performing it.
teardown_update_state() {
  # STEP A — pause flag (always; ephemeral coordination state).
  local flag
  # update_pause_flag_path is a stdout-only resolver (printf; always rc 0) — no
  # side effect, no condition, so no SC2310 masking concern.
  flag="$(update_pause_flag_path)"
  if "${DRY_RUN}"; then
    log "dry-run: would remove update pause flag (${flag})"
  elif [[ -e "${flag}" ]]; then
    update_pause_remove
    log "uninstall: removed update pause flag (${flag})"
  else
    log "uninstall: no update pause flag to remove (${flag})"
  fi

  # STEP B — base@install baseline (recovery state; keep unless --purge-config).
  local baseline
  baseline="$(spine_baseline_path)"
  if ! "${PURGE_CONFIG}"; then
    log "uninstall: base@install baseline kept (${baseline}; pass --purge-config to move it to the Trash)"
    return 0
  fi
  if "${DRY_RUN}"; then
    log "dry-run: would move base@install baseline to Trash (${baseline})"
    return 0
  fi
  if [[ ! -f "${baseline}" ]]; then
    log "uninstall: no base@install baseline to purge (${baseline})"
    return 0
  fi
  local trash dest
  trash="${HOME}/.Trash"
  mkdir -p -- "${trash}"
  # timestamp the moved name so a prior purge in the Trash is never clobbered
  # (mirrors purge_config). separated decl/assign (SC2155).
  dest="${trash}/baseline-manifest.json.ga-purged.$(date +%Y%m%d-%H%M%S)"
  mv -f -- "${baseline}" "${dest}"
  log "uninstall: moved base@install baseline -> ${dest} (Trash; never rm'd)"
}

# --- update orchestration (T08 dispatcher → T09 updater flow) ---------------
# run_update — the `glass-atrium update` subcommand handler. It DISPATCHES to the
# updater script (scripts/update.sh, the T09 entry point) and propagates its exit
# code verbatim.
#
# WHY a SUBPROCESS, never a source: the updater is its OWN executable entry point —
# it sets `set -Eeuo pipefail` + arms `trap update_cleanup EXIT INT TERM` (the T10
# pause-flag + apply-lock unwind). Sourcing it into the launcher would re-arm those
# traps in OUR shell, so its EXIT cleanup would fire on the launcher's exit (and a
# double-source would re-run readonly assigns). Running it as a child keeps its
# strict mode + trap-cleanup isolated to its own process; its exit code is ours.
#
# Args ("$@") pass through verbatim — the updater owns its own argv parsing
# (`--help`), so the launcher MUST NOT route them through ga_parse_args (the
# installer's flag parser, which loud-dies on the updater's --help).
#
# Resolution: GA_ROOT-anchored (the running install's OWN tree — the binary
# resolves through the symlink farm to its real repo, so the updater sits beside it),
# overridable via ATRIUM_UPDATE_SCRIPT for a sandbox/CI layout (mirrors the GA_*
# override pattern). Loud-fail (die) when the updater is absent or non-executable —
# no silent absorption of a missing entry point (Precondition Loud-Fail).
run_update() {
  local updater="${ATRIUM_UPDATE_SCRIPT:-${GA_ROOT}/scripts/update.sh}"
  [[ -f "${updater}" ]] \
    || die "updater not found: ${updater} (the updater script is missing from this install)"
  [[ -x "${updater}" ]] \
    || die "updater not executable: ${updater} (chmod +x the updater script)"
  # Run as a child so the updater's strict mode + EXIT/INT/TERM trap own their own
  # shell; the exit code propagates (0 ok · 1 die/decline · 2 usage). The caller
  # (passthrough) captures it via `|| rc=$?` so set -e never aborts on a non-zero.
  "${updater}" "$@"
}
