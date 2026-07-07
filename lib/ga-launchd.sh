# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (GA_ROOT/LAUNCH_AGENTS/LAUNCHD_JOBS/LAUNCHD_LABEL_PREFIX/PLIST_RENDERER/RENDERED_PLIST_DIR/CONFIG_TOML/BOOTSTRAP_EXIT_*/DRY_RUN/LOAD_LAUNCHD/REPOINT_LAUNCHD) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — launchd plist render + job load/unload lifecycle domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# --- launchd repoint (guarded, OFF by default, never in dry-run) -----------
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

# --- launchd plist render (file-write only — NEVER touches launchctl) -------
# Renders the 8 com.glass-atrium.* plists from the rendered config.toml.
# Loading them into ~/Library/LaunchAgents stays a MANUAL user action (see
# scripts/daemon-README.md "Loading the launchd Plists"); the only launchctl
# mutation glass-atrium performs remains behind --repoint-launchd above.
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

# --- launchd job load (OPT-IN: --load-launchd, post-health-gate only) -------
# The opt-in completion of the one-stop install: copy each rendered plist into
# ~/Library/LaunchAgents, then launchctl bootstrap it (the same primitive
# repoint_launchd uses). OFF by default — no flag = NO launchctl (review-first).
# Reached only AFTER the bootstrap health gate passes (a failed gate exits first),
# so a loaded job always tracks a verified build.
#   --dry-run → log what WOULD load, never touches launchctl.
#   idempotent → bootout → settle-poll → bootstrap (re-load a running job cleanly;
#   the settle poll + single transient retry close the async-bootout rc=5 race).
# Named exit codes: 22 = plists not rendered (render gap) · 23 = a bootstrap failed.
load_launchd_jobs() {
  # default OFF — the no-flag path emits NOTHING and never calls launchctl.
  if ! "${LOAD_LAUNCHD}"; then
    return 0
  fi

  log "== bootstrap [4/4]: --load-launchd — loading ${#LAUNCHD_JOBS[@]} com.glass-atrium.* launchd jobs =="

  # GUARD — only load if the plists were actually rendered. The renderer writes
  # all 8 in one pass, so the first job's plist standing in for the set is a
  # sufficient presence probe; a missing dir is a render gap (loud-fail, exit 22).
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

    # per-job render-gap guard — a partial render (some plists missing) loud-fails
    # rather than silently loading a subset.
    if [[ ! -f "${src}" ]]; then
      printf 'FATAL: rendered plist missing for %s: %s — re-run render-plists\n' "${label}" "${src}" >&2
      exit "${BOOTSTRAP_EXIT_LOAD_NORENDER}"
    fi

    # STEP1 — stage the reviewed plist into the launchd-canonical location.
    cp -f -- "${src}" "${dst}" \
      || die "failed to copy ${src} → ${dst} (--load-launchd)"

    # STEP2 — idempotent reload: bootout any running instance, WAIT for it to
    # actually unload, then bootstrap. `bootout` is ASYNCHRONOUS — for an already-
    # loaded job (esp. com.glass-atrium.monitor, which holds :16145) the daemon does
    # not release its port/unload instantly, so an IMMEDIATE re-bootstrap races the
    # still-terminating old instance and fails with rc=5 (Input/output error) →
    # spurious exit 23. The settle poll closes that race: a not-loaded job (fresh
    # install) passes the poll immediately (bootout is a no-op, label already absent),
    # while a re-load waits out the real teardown before bootstrap.
    # stdio hygiene — bootout/bootstrap run with stdin/stdout/stderr detached so no
    # inherited capture/tty fd reaches launchctl or a spawned daemon; the loop keys
    # on EXIT CODE only, so suppressing their stdio is safe (loud-fail preserved).
    launchctl bootout "gui/${UID}/${label}" </dev/null >/dev/null 2>&1 || true

    # settle poll — bounded wait until the label is ABSENT from launchctl's domain
    # (the old instance finished unloading). Up to ~10s (50 × 0.2s); "already absent"
    # (fresh install / not-loaded job) exits on the first iteration. bash 3.2-safe:
    # plain arithmetic loop, awk for the TAB-delimited `launchctl list` column match.
    local settle_i=0
    while [[ "${settle_i}" -lt 50 ]]; do
      # shellcheck disable=SC2312  # awk exit code IS the verdict; pipe-masking is intentional
      if ! launchctl list 2>/dev/null | awk -v l="${label}" '$3 == l { found = 1 } END { exit found ? 0 : 1 }'; then
        break
      fi
      sleep 0.2
      settle_i=$((settle_i + 1))
    done

    # bootstrap with a single transient retry — if the first attempt still hits the
    # rc=5 race residue (the unload settled but launchd has not fully released the
    # domain slot), sleep briefly and retry ONCE before declaring FATAL. A bootstrap
    # failure after the retry is a loud-fail (exit 23), NEVER silently absorbed.
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
# of the LAUNCHD_JOBS (inverse of load_launchd_jobs). IDEMPOTENT — a not-loaded job or an
# absent plist is fine. launchctl absent → skip with a log (a machine without the jobs is
# not a fault). SANDBOX-GUARDED — a run against a non-real home (is_sandbox_target:
# fake HOME or GA_TARGET_HOME seam) skips the whole teardown, because the gui/${UID}
# domain is shared with the real user regardless of HOME. The deployed plists in
# ${LAUNCH_AGENTS} are regenerable COPIES of the rendered SoT (${RENDERED_PLIST_DIR}),
# which is left intact — so `rm -f` is correct here (generated artifact, not a user
# config). Returns 0 (teardown is best-effort, never fatal).
unload_launchd_jobs() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping launchd teardown (${#LAUNCHD_JOBS[@]} com.glass-atrium.* jobs — bootout + plist rm)"
    return 0
  fi
  # SANDBOX GUARD: gui-domain labels are per-UID, NOT per-HOME — a sandboxed run
  # (fake HOME or GA_TARGET_HOME) would bootout the REAL user's live jobs. Skip
  # the WHOLE teardown, not just bootout: under a GA_TARGET_HOME-only sandbox
  # HOME stays real, so ${LAUNCH_AGENTS} is the REAL ~/Library/LaunchAgents and
  # the plist rm would hit real deployed plists. Skipping is the safe direction
  # (fail-open); real-home runs are byte-identical to the pre-guard behavior.
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
  local job label plist booted=0 removed=0
  log "uninstall: tearing down ${#LAUNCHD_JOBS[@]} com.glass-atrium.* launchd jobs"
  for job in "${LAUNCHD_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    plist="${LAUNCH_AGENTS}/${label}.plist"
    launchctl bootout "gui/${UID}/${label}" >/dev/null 2>&1 && booted=$((booted + 1)) || true
    if [[ -e "${plist}" ]]; then
      rm -f -- "${plist}" && removed=$((removed + 1))
    fi
  done
  log "uninstall: launchd teardown done (${booted} booted out, ${removed} plists removed)"
  return 0
}
