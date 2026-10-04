# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (GA_ROOT/LAUNCH_AGENTS/LAUNCHD_JOBS/LAUNCHD_RETIRED_JOBS/GA_DAEMON_SESSIONS/LAUNCHD_LABEL_PREFIX/PLIST_RENDERER/RENDERED_PLIST_DIR/CONFIG_TOML/BOOTSTRAP_EXIT_*/DRY_RUN/LOAD_LAUNCHD/REPOINT_LAUNCHD) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — launchd plist render + job load/unload lifecycle domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# launchd repoint (guarded, OFF by default, never in dry-run)
repoint_launchd() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping launchd repoint (never run in staging dry-run)"
    return 0
  fi
  if ! "${REPOINT_LAUNCHD}"; then
    log "launchd repoint OFF (default) — pass --repoint-launchd to enable"
    return 0
  fi
  command -v launchctl >/dev/null 2>&1 || die "launchctl not found"
  local label="com.glass-atrium.monitor"
  local plist="${LAUNCH_AGENTS}/${label}.plist"
  [[ -f "${plist}" ]] || die "monitor plist not found: ${plist} (provision it first)"

  log "repointing launchd monitor to ${GA_ROOT}/monitor + re-bootstrap"
  # bootout first (macOS 11+), fall back to legacy unload on non-zero exit
  launchctl bootout "gui/${UID}/${label}" 2>/dev/null \
    || launchctl unload -w "${plist}" 2>/dev/null || true
  launchctl bootstrap "gui/${UID}" "${plist}"
  log "launchd repoint done"
}

# launchd plist render (file-write only — NEVER touches launchctl). Renders the active-roster
# com.glass-atrium.* plists from the rendered config.toml. Loading them into
# ~/Library/LaunchAgents stays a MANUAL user action (see scripts/daemon-README.md); the only
# launchctl mutation glass-atrium performs is --repoint-launchd above.
render_plists() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping launchd plist render (file-write step)"
    return 0
  fi
  [[ -f "${PLIST_RENDERER}" ]] || die "plist renderer missing: ${PLIST_RENDERER}"
  # GA_CONFIG_TOML pins the renderer to THIS install's (possibly sandboxed)
  # config; GA_PLIST_OUT passes through from the environment.
  GA_CONFIG_TOML="${CONFIG_TOML}" bash "${PLIST_RENDERER}" \
    || die "launchd plist render failed — exit codes: 3=config 4=key 5=lint 6=path-leak"
}

# launchd job load (OPT-IN: --load-launchd, post-health-gate only)
# Copy each rendered plist into ~/Library/LaunchAgents, then launchctl bootstrap it (the same
# primitive repoint_launchd uses). OFF by default — no flag = NO launchctl (review-first).
# Reached only AFTER the bootstrap health gate passes, so a loaded job always tracks a verified
# build. --dry-run logs what WOULD load (no launchctl). Idempotent: bootout → settle-poll →
# bootstrap (settle poll + single transient retry close the async-bootout rc=5 race).
# Named exit codes: 22 = plists not rendered (render gap) · 23 = a bootstrap failed.
load_launchd_jobs() {
  # default OFF — the no-flag path emits NOTHING and never calls launchctl.
  if ! "${LOAD_LAUNCHD}"; then
    return 0
  fi

  log "== bootstrap [4/4]: --load-launchd — loading ${#LAUNCHD_JOBS[@]} com.glass-atrium.* launchd jobs =="

  # GUARD — only load if the plists were rendered. The renderer writes the whole roster in one pass, so the
  # first job's plist is a sufficient presence probe; a missing dir = render gap (loud-fail, exit 22).
  local first_plist="${RENDERED_PLIST_DIR}/${LAUNCHD_LABEL_PREFIX}.${LAUNCHD_JOBS[0]}.plist"
  if [[ ! -d "${RENDERED_PLIST_DIR}" || ! -f "${first_plist}" ]]; then
    if "${DRY_RUN}"; then
      log "  dry-run: rendered plists absent (${RENDERED_PLIST_DIR}) — a real run would exit ${BOOTSTRAP_EXIT_LOAD_NORENDER}"
      return 0
    fi
    printf 'FATAL: --load-launchd requested but rendered plists are absent in %s — run render-plists first\n' \
      "${RENDERED_PLIST_DIR}" >&2
    exit "${BOOTSTRAP_EXIT_LOAD_NORENDER}"
  fi

  # retired labels leave the domain before the active roster loads → --load-launchd is an honest doctor remedy
  retire_launchd_jobs_or_warn

  # dry-run: report what WOULD load, touch neither launchctl nor LaunchAgents.
  if "${DRY_RUN}"; then
    local job
    for job in "${LAUNCHD_JOBS[@]}"; do
      log "  dry-run: would load ${LAUNCHD_LABEL_PREFIX}.${job} (copy → ${LAUNCH_AGENTS}, launchctl bootstrap gui/${UID})"
    done
    log "== bootstrap: dry-run — --load-launchd would load ${#LAUNCHD_JOBS[@]} jobs (no launchctl invoked) =="
    return 0
  fi

  command -v launchctl >/dev/null 2>&1 || die "launchctl not found — required for --load-launchd"
  mkdir -p -- "${LAUNCH_AGENTS}"

  local job label src dst loaded=0
  for job in "${LAUNCHD_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    src="${RENDERED_PLIST_DIR}/${label}.plist"
    dst="${LAUNCH_AGENTS}/${label}.plist"

    # per-job render-gap guard — a partial render (some plists missing) loud-fails, never loads a subset.
    if [[ ! -f "${src}" ]]; then
      printf 'FATAL: rendered plist missing for %s: %s — re-run render-plists\n' "${label}" "${src}" >&2
      exit "${BOOTSTRAP_EXIT_LOAD_NORENDER}"
    fi

    # STEP1 — stage the reviewed plist into the launchd-canonical location.
    cp -f -- "${src}" "${dst}" \
      || die "failed to copy ${src} → ${dst} (--load-launchd)"

    # STEP2 — idempotent reload: bootout, WAIT for the real unload, then bootstrap. `bootout` is
    # ASYNCHRONOUS — an already-loaded job (esp. com.glass-atrium.monitor, holding :16145) does not
    # release its port instantly, so an IMMEDIATE re-bootstrap races the still-terminating instance
    # and fails with rc=5 (Input/output error) → spurious exit 23. The settle poll closes the race:
    # a not-loaded job passes immediately (bootout a no-op), a re-load waits out the teardown.
    # stdio hygiene — bootout/bootstrap detach stdin/stdout/stderr so no inherited capture/tty fd
    # reaches launchctl or a daemon; the loop keys on EXIT CODE only, so suppressing stdio is safe.
    # shellcheck disable=SC2310  # a not-loaded label is a no-op bootout
    bootout_launchd_label "${label}" || true
    wait_launchd_label_unloaded "${label}"

    # bootstrap with a single transient retry — if the first attempt still hits the rc=5 race
    # residue (unload settled but launchd hasn't released the domain slot), sleep + retry ONCE
    # before FATAL. A bootstrap failure after the retry is a loud-fail (exit 23), never absorbed.
    if ! launchctl bootstrap "gui/${UID}" "${dst}" </dev/null >/dev/null 2>&1; then
      log "  load: ${label} first bootstrap returned non-zero — retrying once after 1s (transient race)"
      sleep 1
      if ! launchctl bootstrap "gui/${UID}" "${dst}" </dev/null >/dev/null 2>&1; then
        printf 'FATAL: launchctl bootstrap failed for %s (%s) after retry\n' "${label}" "${dst}" >&2
        exit "${BOOTSTRAP_EXIT_LOAD_FAILED}"
      fi
    fi
    log "  load: ${label} bootstrapped (gui/${UID})"
    loaded=$((loaded + 1))
  done

  log "== bootstrap: --load-launchd done — ${loaded}/${#LAUNCHD_JOBS[@]} launchd jobs loaded =="
}

# unload_launchd_jobs — uninstall teardown: bootout + remove the deployed plist for each
# LAUNCHD_JOBS and LAUNCHD_RETIRED_JOBS label (inverse of load_launchd_jobs, plus the retired labels). IDEMPOTENT (not-loaded job / absent plist fine).
# launchctl absent → skip with a log. SANDBOX-GUARDED — is_sandbox_target (fake HOME or
# GA_TARGET_HOME) skips the WHOLE teardown, because the gui/${UID} domain is shared with the real
# user regardless of HOME. The deployed plists in ${LAUNCH_AGENTS} are regenerable COPIES of the
# rendered SoT (${RENDERED_PLIST_DIR}, left intact) — so `rm -f` is correct (generated artifact,
# not user config). Returns 0 (best-effort, never fatal).
unload_launchd_jobs() {
  local jobs=("${LAUNCHD_JOBS[@]}" "${LAUNCHD_RETIRED_JOBS[@]}")
  if "${DRY_RUN}"; then
    log "dry-run: skipping launchd teardown (${#jobs[@]} com.glass-atrium.* jobs — bootout + plist rm)"
    return 0
  fi
  # SANDBOX GUARD: gui-domain labels are per-UID, NOT per-HOME — a sandboxed run (fake HOME or
  # GA_TARGET_HOME) would bootout the REAL user's live jobs. Skip the WHOLE teardown, not just
  # bootout: under a GA_TARGET_HOME-only sandbox HOME stays real, so ${LAUNCH_AGENTS} is the REAL
  # ~/Library/LaunchAgents and the plist rm would hit real plists. Skipping is fail-open; real-home
  # runs are byte-identical to pre-guard behavior.
  # is_sandbox_target returns 0 by contract (stdout verdict) → masking is intentional
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "uninstall: sandbox target — launchd domain untouched (bootout + plist rm skipped)"
    return 0
  fi
  if ! command -v launchctl >/dev/null 2>&1; then
    log "uninstall: launchctl not found — skipping launchd teardown"
    return 0
  fi
  local job label booted=0 removed=0
  log "uninstall: tearing down ${#jobs[@]} com.glass-atrium.* launchd jobs"
  for job in "${jobs[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    # shellcheck disable=SC2310  # per-label rc counted, never an abort
    bootout_launchd_label "${label}" && booted=$((booted + 1)) || true
    # shellcheck disable=SC2310  # per-label rc counted, never an abort
    delete_launchd_plist "${label}" && removed=$((removed + 1)) || true
  done
  log "uninstall: launchd teardown done (${booted} booted out, ${removed} plists removed)"
  return 0
}

# retire_launchd_jobs — retire the LAUNCHD_RETIRED_JOBS labels and GA_DAEMON_SESSIONS an install still carries.
# Observe first: no residue → one no-residue line; no mutating launchctl verb, rm, session kill, port lookup or signal.
# Residue → per retired label a settled bootout + plist removal, then kill_daemon_tmux_sessions once (port-scoped free).
# Never stop_detached_daemons — its account-wide pkill stays uninstall-only. Guards as unload_launchd_jobs.
# Returns 1 only when observed residue is still present after acting; the best-effort port free never sets it.
retire_launchd_jobs() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping retired launchd job retirement (${LAUNCHD_RETIRED_JOBS[*]} + ${GA_DAEMON_SESSIONS[*]})"
    return 0
  fi
  # is_sandbox_target returns 0 by contract (stdout verdict) → masking is intentional
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "retire: sandbox target — launchd domain and daemon sessions untouched"
    return 0
  fi
  if ! command -v launchctl >/dev/null 2>&1; then
    log "retire: launchctl not found — skipping retired launchd job retirement"
    return 0
  fi
  local residue kind name
  residue="$(get_retired_residue)"
  if [[ -z "${residue}" ]]; then
    log "retire: no retired residue (${LAUNCHD_RETIRED_JOBS[*]} + ${GA_DAEMON_SESSIONS[*]}) — nothing to do"
    return 0
  fi
  log "retire: retired residue present — ${residue//$'\n'/, }"
  while IFS=' ' read -r kind name; do
    case "${kind}" in
      loaded)
        # shellcheck disable=SC2310  # the settle wait and the re-observation below decide the outcome
        bootout_launchd_label "${name}" || true
        wait_launchd_label_unloaded "${name}"
        ;;
      plist)
        # shellcheck disable=SC2310  # a refused removal stays residue → reported by the re-observation
        delete_launchd_plist "${name}" || log "retire: could not remove ${LAUNCH_AGENTS}/${name}.plist (continuing)"
        ;;
      *) : ;;
    esac
  done <<<"${residue}"
  kill_daemon_tmux_sessions
  residue="$(get_retired_residue)"
  if [[ -n "${residue}" ]]; then
    log "WARNING: retire: retired residue still present after teardown — ${residue//$'\n'/, }"
    return 1
  fi
  log "retire: retired launchd jobs and daemon sessions cleared"
  return 0
}

# retire_launchd_jobs_or_warn — install-start and --load-launchd form: residue left in place is a named warning, never
# an abort (doctor and the next autoagent-cycle retry it); the retire-launchd-jobs passthrough keeps the routine's rc.
retire_launchd_jobs_or_warn() {
  # shellcheck disable=SC2310  # the routine's rc is the warning trigger
  retire_launchd_jobs && return 0
  log "WARNING: retired launchd residue left in place — doctor and the next autoagent-cycle retry the retirement"
  return 0
}

# get_retired_residue — one `<kind> <name>` line per retired item present now (read-only probes only):
# `loaded`/`plist` per LAUNCHD_RETIRED_JOBS label, `session` per GA_DAEMON_SESSIONS name.
get_retired_residue() {
  local job label sess
  for job in "${LAUNCHD_RETIRED_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    # shellcheck disable=SC2310  # the probe verdict is branched on
    if is_launchd_label_loaded "${label}"; then
      printf 'loaded %s\n' "${label}"
    fi
    if [[ -e "${LAUNCH_AGENTS}/${label}.plist" ]]; then
      printf 'plist %s\n' "${label}"
    fi
  done
  command -v tmux >/dev/null 2>&1 || return 0
  for sess in "${GA_DAEMON_SESSIONS[@]}"; do
    if tmux has-session -t "${sess}" 2>/dev/null; then
      printf 'session %s\n' "${sess}"
    fi
  done
  return 0
}

# bootout_launchd_label — boot one label out of this UID's gui domain, stdio detached; the rc is launchctl's.
bootout_launchd_label() {
  launchctl bootout "gui/${UID}/$1" </dev/null >/dev/null 2>&1
}

# delete_launchd_plist — remove one label's deployed LaunchAgents copy (a regenerable copy of the rendered SoT, so
# `rm -f` fits); returns 0 only when a copy was removed — an absent or guard-refused copy returns 1.
delete_launchd_plist() {
  local plist="${LAUNCH_AGENTS}/$1.plist"
  [[ -e "${plist}" ]] || return 1
  # shellcheck disable=SC2310  # guard verdict branched on — a refusal is a skip, never an abort
  if ga_guard_path "${plist}"; then
    rm -f -- "${plist:?}"
  else
    return 1
  fi
}

# is_launchd_label_loaded — returns 0 when the label is loaded in this UID's gui domain (`launchctl list`, label = column 3).
is_launchd_label_loaded() {
  # shellcheck disable=SC2312  # awk exit code IS the verdict; pipe-masking is intentional
  launchctl list 2>/dev/null | awk -v l="$1" '$3 == l { found = 1 } END { exit found ? 0 : 1 }'
}

# wait_launchd_label_unloaded — `bootout` is ASYNCHRONOUS: poll until the label leaves the domain, bounded by a
# SECONDS-delta ceiling (GA_LAUNCHD_SETTLE_TIMEOUT_SECS, ~10s) — an iteration count drifts when a probe blocks.
wait_launchd_label_unloaded() {
  local settle_started="${SECONDS}" settle_ceiling="${GA_LAUNCHD_SETTLE_TIMEOUT_SECS:-10}"
  while [[ "$((SECONDS - settle_started))" -lt "${settle_ceiling}" ]]; do
    # shellcheck disable=SC2310  # the probe verdict is branched on
    is_launchd_label_loaded "$1" || break
    sleep 0.2
  done
  return 0
}
