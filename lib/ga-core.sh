# shellcheck shell=bash
# Glass Atrium — shared core for the install/uninstall engine. SOURCED ONLY by the
# executable entry point (glass-atrium) — it has no entrypoint dispatch and no
# file-scope `set -Eeuo pipefail`/`IFS`/traps (strict mode + traps stay owned by
# the entry point so re-sourcing never re-arms them).
# ga_init_env "<GA_ROOT>" MUST be called once with the ENTRY POINT'S resolved root
# before any other function — GA_ROOT is passed in, NEVER self-derived from this
# file's BASH_SOURCE (which would resolve to <root>/lib/, one dir too deep).



# === [3] leaf guards / queries (stdout-verdict, always exit 0) =============















# === [4] mid-level mutators ================================================




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

# --- same-name conflict recreate gate (--recreate-db) ----------------------
# Backs up + drops + recreates an EXISTING DB. SANDBOX-ONLY by construction:
#   * refuses on the literal live DB 'glass_atrium' unless GA_DB_NAME points the whole
#     DB path at a throwaway name (DB_NAME != glass_atrium). Mirrors oss-db-setup.sh's
#     internal recreate_database guard — defense in depth (both layers refuse).
#   * operator-approve gate: a TTY prompt defaulting to No, or the explicit
#     --recreate-yes flag for non-interactive (CI/sandbox) runs. Never default-
#     yes (irreversible single-sink data loss — Excessive-Agency iron-law).
# The backup-before-drop + connection-drain HOW lives in oss-db-setup.sh
# (recreate_database), invoked here with GA_DB_RECREATE=1.
recreate_db_gate() {
  # SAFETY: never recreate the live single-sink 'glass_atrium' DB from the installer.
  if [[ "${DB_NAME}" == "glass_atrium" ]]; then
    die "--recreate-db refused on the live DB 'glass_atrium' — set GA_DB_NAME to a throwaway name (sandbox/CI only)"
  fi

  log "RECREATE: DB '${DB_NAME}' exists and --recreate-db was requested."
  log "RECREATE: this BACKS UP (pg_dump), DROPS, and RECREATES '${DB_NAME}' — existing data is replaced."

  # operator-approve: explicit --recreate-yes, else a TTY prompt (default No).
  # A non-TTY without --recreate-yes aborts cleanly (never default-yes).
  if ! "${RECREATE_YES}"; then
    local reply=""
    if [[ -t 0 ]]; then
      printf 'Back up, drop, and recreate DB "%s"? [y/N]: ' "${DB_NAME}" >&2
      read -r reply || reply=""
    fi
    case "${reply}" in
      y | Y) log "RECREATE: operator approved (TTY)" ;;
      *) die "--recreate-db declined (no approval) — DB '${DB_NAME}' left intact" ;;
    esac
  else
    log "RECREATE: operator approved (--recreate-yes)"
  fi

  # delegate to oss-db-setup.sh with GA_DB_RECREATE=1: it backs up (parameterized
  # pg_dump of DB_NAME, NEVER live glass_atrium), drains connections, drops, then runs
  # the full createdb + .env + migrate-deploy path against the recreated DB.
  [[ -f "${DB_SETUP_SCRIPT}" ]] || die "DB setup script missing: ${DB_SETUP_SCRIPT}"
  log "== DB recreate: oss-db-setup.sh GA_DB_RECREATE=1 (cwd=${GA_ROOT}/monitor) =="
  # preserve the child's named exit code (5/6/7/8) instead of collapsing it to
  # die's generic 1 — a CI/dashboard wrapper branches on the documented codes.
  local db_rc
  # set -E propagates the ERR trap INTO the subshell, so a non-zero exit from the
  # `&&`-chained bash call would fire it (a spurious ERROR line) before db_rc is
  # captured. Suspend the trap for the bracketed call and restore it afterward.
  set +e
  trap - ERR
  (cd -- "${GA_ROOT}/monitor" && GA_DB_RECREATE=1 bash "${DB_SETUP_SCRIPT}")
  db_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  if [[ "${db_rc}" -ne 0 ]]; then
    log "DB recreate failed — oss-db-setup.sh exit codes: 5=createdb 6=prisma 7=override 8=recreate-guard (rc=${db_rc})"
    exit "${db_rc}"
  fi
  log "== DB recreate done =="
}

# full DB path, regardless of DB presence — safe to repeat (oss-db-setup.sh is
# idempotent: createdb skip / .env preserve / migrate deploy applies pending only).
run_db_setup() {
  [[ -f "${DB_SETUP_SCRIPT}" ]] || die "DB setup script missing: ${DB_SETUP_SCRIPT}"
  log "== DB bootstrap: oss-db-setup.sh (cwd=${GA_ROOT}/monitor) =="
  # cwd precondition of the script: monitor project root (prisma.config.ts)
  # preserve the child's named exit code (3/4/5/6) instead of collapsing it to
  # die's generic 1 — a CI/dashboard wrapper branches on the documented codes.
  local db_rc
  # set -E propagates the ERR trap INTO the subshell, so a non-zero exit from the
  # `&&`-chained bash call would fire it (a spurious ERROR line) before db_rc is
  # captured. Suspend the trap for the bracketed call and restore it afterward.
  set +e
  trap - ERR
  (cd -- "${GA_ROOT}/monitor" && bash "${DB_SETUP_SCRIPT}")
  db_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  if [[ "${db_rc}" -ne 0 ]]; then
    log "DB bootstrap failed — oss-db-setup.sh exit codes: 3=cwd 4=missing-cli 5=createdb 6=prisma (rc=${db_rc})"
    exit "${db_rc}"
  fi
  log "== DB bootstrap done =="
}

# --- DB bootstrap (fresh-machine gate — delegates to oss-db-setup.sh) ------
# glass-atrium owns the WHEN (fresh machine = 'glass_atrium' DB absent), the monitor's
# oss-db-setup.sh owns the HOW. Existing-DB machines skip here so a re-run is
# zero-diff and never re-enters the heavy npm-ci path; applying PENDING
# migrations on an existing DB is an explicit operator action (`glass-atrium
# db-setup` runs the full path regardless of DB presence).
# GA_SKIP_DB_SETUP opts out entirely — sandbox/CI runs must never touch the
# machine-global PostgreSQL (mirrors the GA_TARGET_HOME override pattern).
setup_database() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping DB bootstrap (mutation-free staging)"
    return 0
  fi
  if [[ -n "${GA_SKIP_DB_SETUP:-}" ]]; then
    log "DB bootstrap skipped (GA_SKIP_DB_SETUP set) — run '${0##*/} db-setup' later"
    return 0
  fi
  command -v psql >/dev/null 2>&1 \
    || die "psql not found — install PostgreSQL, or set GA_SKIP_DB_SETUP=1 and run '${0##*/} db-setup' later"
  # presence probe only — a server-down/unreachable socket falls through to the
  # full setup path, whose createdb step loud-fails with a named exit code.
  local db_exists
  db_exists="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null || true)"
  if [[ "${db_exists}" == "1" ]]; then
    # SAME-NAME CONFLICT path: --recreate-db requested AND the DB already exists.
    # Default (no flag) is the historical bare skip (idempotent re-run).
    if "${RECREATE_DB}"; then
      recreate_db_gate
      return 0
    fi
    log "DB '${DB_NAME}' present — skipping bootstrap (pending migrations: '${0##*/} db-setup')"
    return 0
  fi
  run_db_setup
}








# === [5] predicate / report ================================================

# --- doctor / preflight ----------------------------------------------------
# Mutation-free checks: same-device, target writable, no dangling, manifest ok.
# $1 == "preflight" → §7 target-side deploy reconciliation is ADVISORY (warn,
# not abort): a fresh install legitimately has 0 deployed entries because
# run_symlink_farm runs AFTER this preflight, so "not installed" is not a fault
# there. The standalone `doctor` subcommand passes no arg → §7 stays a hard FAIL
# on a genuinely-deployed system that has drifted/missing symlinks.
run_doctor() {
  local mode="${1:-standalone}"
  local fail=0

  log "== doctor: Glass Atrium preflight =="

  # 1. GA root present
  if [[ -d "${GA_ROOT}" ]]; then
    log "  ok   : GA root exists (${GA_ROOT})"
  else
    log "  FAIL : GA root missing (${GA_ROOT})"
    fail=1
  fi

  # 2. target home present + writable
  if [[ -d "${TARGET_HOME}" ]]; then
    if [[ -w "${TARGET_HOME}" ]]; then
      log "  ok   : target home writable (${TARGET_HOME})"
    else
      log "  FAIL : target home not writable (${TARGET_HOME})"
      fail=1
    fi
  else
    log "  FAIL : target home missing (${TARGET_HOME})"
    fail=1
  fi

  # 3. same-device advisory — GA root vs target home. Informational only: the swap
  # rename is atomic by construction (STAGE_TMP co-located with dst), so a cross-
  # device GA/target layout does NOT abort the install; it is surfaced here as a
  # layout note (e.g. GA checkout on an external volume) without failing doctor.
  if [[ -d "${GA_ROOT}" && -d "${TARGET_HOME}" ]]; then
    local ga_dev th_dev
    # dev_of is a thin stat wrapper; an advisory-only verdict — masking its rc is
    # intentional (SC2311 fires only because the lib has no file-scope set -e).
    # shellcheck disable=SC2311
    ga_dev="$(dev_of "${GA_ROOT}")"
    # shellcheck disable=SC2311
    th_dev="$(dev_of "${TARGET_HOME}")"
    if [[ "${ga_dev}" == "${th_dev}" ]]; then
      log "  ok   : same device (st_dev=${ga_dev})"
    else
      log "  note : GA root and target on different devices — GA=${ga_dev} target=${th_dev} (advisory; swap stays atomic)"
    fi
  fi

  # 4. manifest integrity — parseable + every source present
  if command -v jq >/dev/null 2>&1 && [[ -f "${MANIFEST}" ]]; then
    if jq -e '.files | type == "array"' -- "${MANIFEST}" >/dev/null 2>&1; then
      log "  ok   : manifest parseable (${MANIFEST})"
      local rel missing=0
      # read_manifest_files dies on its own failure → masked exit is benign;
      # process substitution keeps the loop in the current shell (var-safe).
      # shellcheck disable=SC2312
      while IFS= read -r rel; do
        [[ -n "${rel}" ]] || continue
        [[ -e "${GA_ROOT}/${rel}" ]] || {
          log "  FAIL : manifest source missing: ${rel}"
          missing=$((missing + 1))
        }
      done < <(read_manifest_files)
      [[ "${missing}" -eq 0 ]] || fail=1
    else
      log "  FAIL : manifest .files not an array"
      fail=1
    fi
  else
    log "  FAIL : manifest unreadable or jq absent (${MANIFEST})"
    fail=1
  fi

  # 5. no dangling GA symlinks under target (existing install health)
  if [[ -d "${TARGET_HOME}" ]]; then
    local dangling=0 link
    # find ends with `|| true` → masked exit is benign; process substitution
    # keeps the loop in the current shell (var-safe).
    # shellcheck disable=SC2312
    while IFS= read -r link; do
      [[ -n "${link}" ]] || continue
      [[ -e "${link}" ]] || {
        log "  warn : dangling GA symlink: ${link}"
        dangling=$((dangling + 1))
      }
    done < <(find "${TARGET_HOME}" -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)
    [[ "${dangling}" -eq 0 ]] && log "  ok   : no dangling GA symlinks"
  fi

  # 6. hook event-binding gap (D-5) — the installer deploys hook FILES but the
  #    event->hook WIRING lives ONLY in settings.json, which is user-owned and
  #    NOT in the manifest. A clean/partial install therefore leaves deployed
  #    hooks DORMANT (present on disk, never fired). This check is mutation-free
  #    by design: auto-writing the user's settings.json is unsafe (would clobber
  #    user config + violate the never-touch guard), so we SURFACE the gap
  #    loudly (loud-fail) and let the USER apply the bindings. Missing bindings
  #    are a WARNING advisory (doctor still PASSes on §1-5), not a hard FAIL —
  #    so a dormant-hook gap is reported without blocking an otherwise-valid
  #    install. The fix is documentation, not mutation (see the apply-by-hand
  #    NOTE emitted below + manifest.json ._doc_settings_json).
  local unbound=0
  if [[ ! -f "${SETTINGS_JSON}" ]]; then
    log "  warn : settings.json absent (${SETTINGS_JSON}) — ALL hook event-bindings are unwired; deployed hooks are DORMANT"
    unbound=${#EXPECTED_HOOK_BINDINGS[@]}
  elif ! command -v jq >/dev/null 2>&1; then
    log "  warn : jq absent — cannot read hook bindings from settings.json (skipping binding check)"
  else
    local binding event hook matcher
    for binding in "${EXPECTED_HOOK_BINDINGS[@]}"; do
      IFS=$'\t' read -r event hook matcher <<<"${binding}"
      # matcher-scoped check so the same hook bound under two matchers (e.g.
      # validate-secret-scan.sh on Write|Edit AND Bash) is reported per-tuple —
      # a missing Bash binding must NOT be masked by a present Write|Edit one.
      # is_hook_bound returns 0 by contract (stdout verdict) → masking is intentional
      # (SC2311 = the sourced-lib analog of SC2310; no file-scope set -e here)
      # shellcheck disable=SC2310,SC2311,SC2312
      if [[ "$(is_hook_bound "${event}" "${hook}" "${matcher}")" == "yes" ]]; then
        log "  ok   : hook bound — ${event} -> ${hook} (matcher=${matcher:-<none>})"
      else
        log "  warn : hook NOT bound — ${event} -> ${hook} (matcher=${matcher:-<none>}) (DORMANT: deployed but never fires)"
        unbound=$((unbound + 1))
      fi
    done
  fi
  if [[ "${unbound}" -gt 0 ]]; then
    log "  ---- ${unbound} dormant hook binding(s): add each to ${SETTINGS_JSON} under .hooks.<event> ----"
    log "       example entry (PreToolUse): {\"matcher\":\"Agent\",\"hooks\":[{\"type\":\"command\",\"command\":\"~/.glass-atrium/hooks/<hook>.sh\"}]}"
    log "       NOTE: this doctor check is read-only and never writes settings.json. To apply these bindings, run 'glass-atrium install' — wire_hooks performs an idempotent, timestamped-backup MERGE of ONLY the Atrium hook bindings (it never deletes/overwrites user-owned keys; 'agents-only' skips it). You may also add them by hand."
  fi

  # 7. target-side deploy reconciliation — symmetric inverse of §4. §4 checks
  #    manifest entry -> SOURCE present; this checks manifest entry -> TARGET
  #    installed (a symlink under TARGET_HOME resolving into GA_ROOT). A manifest
  #    entry on disk in the source but NOT symlinked into the target is an
  #    UNDEPLOYED entry — invisible to §4 (source present) and §5 (only flags
  #    EXISTING dangling links, never a missing one). Loud-fail per
  #    shared-self-improve-hygiene.md Precondition Loud-Fail Principle: surface
  #    every miss so a partial/stale deploy (e.g. a newly added skill or script
  #    never run through `glass-atrium agents-only`) cannot fossilize silently.
  local undeployed_fresh=0
  if command -v jq >/dev/null 2>&1 && [[ -f "${MANIFEST}" && -d "${TARGET_HOME}" ]] \
    && jq -e '.files | type == "array"' -- "${MANIFEST}" >/dev/null 2>&1; then
    # Two contexts downgrade §7 from hard-FAIL to an advisory:
    #   (a) preflight — run_symlink_farm runs AFTER this preflight, so a fresh
    #       install legitimately has 0 deployed entries (existing behavior).
    #   (b) FULLY-FRESH standalone target — a brand-new empty target home with NO
    #       GA-pointing symlinks at all is the SAME not-yet-deployed case, not
    #       drift: 0/N deployed because nothing was ever installed here. ga_links
    #       (the §5 find idiom) counts GA-pointing symlinks under TARGET_HOME;
    #       zero such links ⇒ nothing is deployed ⇒ every manifest entry reports
    #       undeployed. The hard-FAIL is RESERVED for genuine PARTIAL drift (some
    #       entries deployed, some missing) on an established install.
    local ga_links=0 lk
    # find ends with `|| true` → masked exit is benign; process substitution
    # keeps the loop in the current shell (var-safe).
    # shellcheck disable=SC2312
    while IFS= read -r lk; do
      [[ -n "${lk}" ]] || continue
      ga_links=$((ga_links + 1))
    done < <(find "${TARGET_HOME}" -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)

    local sev="FAIL" fresh=0
    if [[ "${mode}" == "preflight" ]]; then
      sev="note"
    elif [[ "${ga_links}" -eq 0 ]]; then
      # fully-fresh standalone target — relabel per-entry lines + summary as warn.
      sev="warn"
      fresh=1
    fi
    local rel total=0 undeployed=0 dst cur
    # read_manifest_files dies on its own failure → masked exit is benign;
    # process substitution keeps the loop in the current shell (var-safe).
    # shellcheck disable=SC2312
    while IFS= read -r rel; do
      [[ -n "${rel}" ]] || continue
      total=$((total + 1))
      dst="${TARGET_HOME}/${rel}"
      if [[ -L "${dst}" ]]; then
        cur="$(readlink -- "${dst}")"
        if [[ "${cur}" == "${GA_ROOT}/${rel}" ]]; then
          continue
        fi
        log "  ${sev} : manifest entry mis-linked: ${rel} -> ${cur} (expected ${GA_ROOT}/${rel}) — run 'glass-atrium agents-only' to deploy"
        undeployed=$((undeployed + 1))
      else
        log "  ${sev} : manifest entry not installed: ${rel} — run 'glass-atrium agents-only' to deploy"
        undeployed=$((undeployed + 1))
      fi
    done < <(read_manifest_files)
    if [[ "${undeployed}" -eq 0 ]]; then
      log "  ok   : all manifest entries deployed to target (symlinks into GA root)"
    elif [[ "${mode}" == "preflight" ]]; then
      log "  note : ${undeployed} manifest entr(y/ies) not yet deployed to ${TARGET_HOME} — deploy step runs next (preflight advisory)"
    elif [[ "${fresh}" -eq 1 && "${undeployed}" -eq "${total}" ]]; then
      # FULLY-FRESH target: no GA symlinks present + 0/N deployed = a brand-new
      # empty target home, NOT a drifted install. WARN (advisory), never hard-FAIL.
      log "  ---- ${undeployed}/${total} manifest entr(y/ies) not yet deployed to ${TARGET_HOME} (fresh target — no GA symlinks present; run 'glass-atrium agents-only' to deploy) ----"
      undeployed_fresh="${undeployed}"
    else
      log "  ---- ${undeployed} manifest entr(y/ies) not deployed to ${TARGET_HOME} ----"
      fail=1
    fi
  else
    log "  warn : target-side reconciliation skipped (manifest unreadable, jq absent, or target home missing)"
  fi

  # 8. manifest drift gate (D-T2) — advisory-but-loud. generate-manifest.sh
  #    --check fails (exit 1) on a source-vs-manifest divergence (a tracked
  #    in-scope file missing from .files, or a listed entry no longer tracked).
  #    Surfaced as a WARNING (doctor still PASSes on §1-7) so a healthy install
  #    is not blocked by a manifest the operator can regenerate; the loud line
  #    points at the fix. Skipped (not a fail) when the generator is absent.
  local drift=0
  if [[ -x "${GENERATE_MANIFEST}" ]]; then
    if bash "${GENERATE_MANIFEST}" --check >/dev/null 2>&1; then
      log "  ok   : manifest matches generated set (generate-manifest --check)"
    else
      log "  warn : manifest DRIFT — source-vs-manifest divergence (run scripts/generate-manifest.sh to regenerate)"
      log "         detail: bash scripts/generate-manifest.sh --check"
      drift=1
    fi
  else
    log "  warn : manifest drift gate skipped (generator not executable: ${GENERATE_MANIFEST})"
  fi

  # 9. update-system advisory (E5 — T22/T27). PASS-compatible by design: every
  #    line here is informational, a note, or a WARN — §9 NEVER sets `fail` (an
  #    unconfigured release repo or a source-dev tree is a valid state, not an
  #    install fault). Surfaces the update CLI's health at a glance: installed
  #    version, source-dev vs consumer tree, release-repo wiring, base@install
  #    baseline presence, and a STALE-pause warning (a dormant-daemon indicator).
  local stale_pause=0
  # 9a — installed CLI version (manifest.version), advisory visibility.
  if command -v jq >/dev/null 2>&1 && [[ -f "${MANIFEST}" ]]; then
    local mver
    # advisory read — a malformed manifest already FAILs §4, so a here-default is
    # enough; mask the rc (|| printf) so set -e never trips on a parse miss.
    # shellcheck disable=SC2312
    mver="$(jq -r '.version // "unknown"' -- "${MANIFEST}" 2>/dev/null || printf 'unknown')"
    log "  info : Glass Atrium version ${mver} (manifest.version)"
  else
    log "  info : Glass Atrium version unknown (manifest unreadable or jq absent)"
  fi
  # 9b — source-dev vs consumer tree. A `.git` (dir OR file) at the GA root marks
  #      the maintainer source checkout; a released consumer tarball never ships
  #      .git/ (mirrors monitor update-status defaultIsSourceDev — `.git` presence
  #      == source-dev → update-check suppressed there).
  if [[ -e "${GA_ROOT}/.git" ]]; then
    log "  info : source-dev tree (.git present at GA root) — update-check suppressed here"
  else
    log "  info : consumer install (no .git at GA root) — update-check active"
  fi
  # 9c — release-repo wiring (ATRIUM_RELEASE_REPO env → [release].repo). The
  #      config template ships the literal "<owner>/<repo>" placeholder; an empty
  #      OR placeholder value is UNCONFIGURED (release status shows no badge).
  #      Resolution mirrors publish-release.sh repo_slug() (env overrides config).
  local repo_slug=""
  if [[ -n "${ATRIUM_RELEASE_REPO:-}" ]]; then
    repo_slug="${ATRIUM_RELEASE_REPO}"
  else
    # pin atrium_toml_get at ga-core's resolved CONFIG_TOML (env-scoped subshell)
    # so a sandbox GA_CONFIG_TOML override is honored. Read rc masked (advisory).
    # shellcheck disable=SC2311,SC2312
    repo_slug="$(ATRIUM_CONFIG_TOML="${CONFIG_TOML}" atrium_toml_get "[release]" "repo" 2>/dev/null || printf '')"
  fi
  if [[ -z "${repo_slug}" || "${repo_slug}" == "<owner>/<repo>" ]]; then
    log "  info : release repo unconfigured ([release].repo unset/placeholder) — release status shows no badge"
  else
    log "  info : release repo configured ([release].repo=${repo_slug})"
  fi
  # 9d — base@install baseline presence (T24). Meaningful on a CONSUMER install
  #      (the next update's 3-anchor diff base); a source-dev tree never captures
  #      one. spine_get_baseline echoes the path / rc 1 when absent. In preflight
  #      (a fresh install has not captured yet — capture runs at run_install's
  #      end) the absence is a note, not a warn (mirrors §7's preflight downgrade).
  local baseline_path
  # spine_get_baseline in an `if` masks set -e by design (the `get` contract —
  # absence is a normal branch, not a thrown failure); SC2310/SC2311 disabled.
  # shellcheck disable=SC2310,SC2311
  if baseline_path="$(spine_get_baseline)"; then
    log "  info : base@install baseline present (${baseline_path})"
  elif [[ -e "${GA_ROOT}/.git" ]]; then
    log "  info : no base@install baseline (source-dev tree — captured on a consumer install)"
  elif [[ "${mode}" == "preflight" ]]; then
    log "  note : no base@install baseline yet — capture runs at the end of this install (preflight advisory)"
  else
    log "  warn : no base@install baseline — run 'glass-atrium install' to capture it (next update falls back to a wider merge base)"
  fi
  # 9e — STALE update pause flag (T27). doctor is MUTATION-FREE, so it must NOT
  #      call update_pause_is_active (that loud-CLEARS a stale flag as a side
  #      effect); instead read the age directly vs the TTL. A present-but-stale
  #      flag is crashed-updater residue holding the autoagent daemon dormant.
  local pause_flag pause_age pause_ttl
  # stdout-only resolver (printf; rc 0) — no condition, no masking concern.
  pause_flag="$(update_pause_flag_path)"
  if [[ ! -e "${pause_flag}" ]]; then
    log "  ok   : no update pause flag (autoagent daemon not update-suspended)"
  else
    pause_ttl="$(update_pause_ttl_secs)"
    # update_pause_flag_age_secs (python3 mtime) rc 1 when un-ageable (python3
    # broken / a race removed the flag). Masking in the `if` is intentional —
    # the un-ageable case is handled in the else branch (SC2310/SC2311 disabled).
    # shellcheck disable=SC2310,SC2311
    if pause_age="$(update_pause_flag_age_secs "${pause_flag}")"; then
      if [[ "${pause_age}" -gt "${pause_ttl}" ]]; then
        log "  warn : STALE update pause flag (age=${pause_age}s > ttl=${pause_ttl}s): ${pause_flag} — crashed-updater residue; the autoagent daemon is suspended behind it (remove it or run an update)"
        stale_pause=1
      else
        log "  info : update pause flag active (age=${pause_age}s ttl=${pause_ttl}s) — an update is in progress; daemon paused"
      fi
    else
      log "  warn : update pause flag present but un-ageable (${pause_flag}) — cannot determine staleness (python3 missing?)"
      stale_pause=1
    fi
  fi

  if [[ "${fail}" -eq 0 ]]; then
    local warns=$((unbound + drift + stale_pause + undeployed_fresh))
    if [[ "${warns}" -eq 0 ]]; then
      log "== doctor: PASS =="
    else
      log "== doctor: PASS (with ${unbound} dormant-hook + ${drift} manifest-drift + ${stale_pause} stale-pause + ${undeployed_fresh} fresh-undeployed warning(s) — see above) =="
    fi
    return 0
  fi
  log "== doctor: FAIL =="
  return 1
}

# --- verify-clean (parity doctor) ------------------------------------------
# Mutation-free: asserts zero GA symlinks under the target AND zero Atrium hook
# bindings remain in settings.json. Returns 0 when clean, 1 otherwise.
verify_clean() {
  local fail=0

  log "== verify-clean: post-uninstall assertion (target=${TARGET_HOME}) =="

  # 1. zero GA-pointing symlinks under the target
  local ga_links=0 link
  if [[ -d "${TARGET_HOME}" ]]; then
    # find ends with `|| true` → masked exit benign; loop stays in current shell.
    # shellcheck disable=SC2312
    while IFS= read -r link; do
      [[ -n "${link}" ]] || continue
      log "  FAIL : residual GA symlink: ${link}"
      ga_links=$((ga_links + 1))
    done < <(find "${TARGET_HOME}" -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)
  fi
  if [[ "${ga_links}" -eq 0 ]]; then
    log "  ok   : zero GA symlinks under target"
  else
    fail=1
  fi

  # 2. zero Atrium hook bindings in settings.json — DUAL-DIR, prefix-based.
  #    An EXACT-cmd literal keyed on the OLD ${HOME}/.claude/hooks path would, after
  #    the wire-template repoint, assert a never-wired path and always PASS — a
  #    residual ${HOME}/.glass-atrium/hooks binding would slip through undetected.
  #    Mirror unwire_hooks' dir-prefix approach instead: FAIL on ANY command that
  #    (tilde-normalized) resolves under EITHER Atrium hooks dir, so no residual
  #    Atrium binding under either prefix escapes the post-uninstall assertion.
  if [[ -f "${SETTINGS_JSON}" ]] && command -v jq >/dev/null 2>&1; then
    if ! jq -e . -- "${SETTINGS_JSON}" >/dev/null 2>&1; then
      log "  FAIL : settings.json is not valid JSON (${SETTINGS_JSON})"
      fail=1
    else
      local old_dir="${HOME}/.claude/hooks/" new_dir="${HOME}/.glass-atrium/hooks/"
      local residual
      residual="$(
        jq -r --arg d1 "${old_dir}" --arg d2 "${new_dir}" --arg home "${HOME}" '
          def norm:
            (. // "")
            | (if startswith("~/") then $home + .[1:] else . end);
          [ (.hooks // {}) | to_entries[] | .value[]? | (.hooks // [])[]? | .command | norm
            | select(startswith($d1) or startswith($d2)) ] | length
        ' -- "${SETTINGS_JSON}"
      )"
      [[ -z "${residual}" ]] && residual=0
      if [[ "${residual}" -gt 0 ]]; then
        log "  FAIL : ${residual} Atrium hook binding(s) still present in settings.json (under ~/.claude/hooks or ~/.glass-atrium/hooks)"
        fail=1
      else
        log "  ok   : zero Atrium hook bindings in settings.json"
      fi
    fi
  else
    log "  ok   : settings.json absent or jq missing — no Atrium bindings to check"
  fi

  if [[ "${fail}" -eq 0 ]]; then
    log "== verify-clean: PASS =="
    return 0
  fi
  log "== verify-clean: FAIL =="
  return 1
}


# Start the built monitor directly, poll /api/health until 200 or the window
# expires, then stop it. Port is read from monitor/.env (ATRIUM_MONITOR_PORT),
# defaulting to 7842. The monitor PID is stopped via kill (NEVER launchctl).
bootstrap_health_gate() {
  log "== bootstrap [3/3]: monitor health gate (/api/health, ${BOOTSTRAP_HEALTH_WINDOW_SECS}s window) =="
  command -v curl >/dev/null 2>&1 \
    || die "curl not found — required for the monitor health gate"

  local port="7842"
  if [[ -f "${GA_ROOT}/monitor/.env" ]]; then
    local env_port
    # read the rendered port (single key, last wins); empty/absent → keep default.
    # SC2312 fires only because the lib has no file-scope `set -o pipefail`
    # visible to shellcheck (the caller arms it) — the pipe rc mask is intentional.
    # shellcheck disable=SC2312
    env_port="$(grep -E '^ATRIUM_MONITOR_PORT=[0-9]+$' -- "${GA_ROOT}/monitor/.env" | tail -1 | cut -d= -f2)"
    [[ -n "${env_port}" ]] && port="${env_port}"
  fi

  # precondition (loud-fail): a pre-existing listener on the gate's own port (e.g.
  # an already-loaded launchd monitor) would answer curl with 200 from the STALE
  # instance, masking the freshly-built dist/. Refuse to start the gate in that case.
  if curl -s -o /dev/null --fail --connect-timeout 2 --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
    die "port ${port} already serving /api/health (launchd monitor up?) — stop it (launchctl bootout gui/${UID}/com.glass-atrium.monitor) before the bootstrap gate, else the gate validates the stale instance, not the rebuilt dist/"
  fi

  # start the built server in the background; capture its PID for a clean stop.
  # redirect its output to a trap-tracked log (not the gate's stderr) so monitor
  # noise never interleaves with the gate verdict — surfaced via tail only on fail.
  GATE_LOG="${TMPDIR:-/tmp}/ga-bootstrap-gate.$$.log"
  local mon_pid=""
  (cd -- "${GA_ROOT}/monitor" && exec node dist/server/main.js) >"${GATE_LOG}" 2>&1 &
  mon_pid=$!

  # F10 — early-liveness probe: a backgrounded subshell whose cd/exec fails (wrong
  # cwd, missing/non-exec dist/server/main.js) dies immediately, invisible to set -e.
  # Short-circuit the full poll window and point the operator at a build/exec problem
  # rather than burning the window on a generic "no 200".
  sleep 1
  if ! kill -0 "${mon_pid}" 2>/dev/null; then
    printf 'FATAL: monitor process exited immediately (build/cwd/exec failure) — see %s\n' "${GATE_LOG}" >&2
    tail -n 20 -- "${GATE_LOG}" >&2 || true
    exit "${BOOTSTRAP_EXIT_HEALTH}"
  fi

  # poll loop — break on the first HTTP 200. set -e safe: curl is in a condition. The response
  # BODY is captured too (not -o /dev/null): /api/health ALWAYS returns 200 (degraded → db:"closed"
  # on a DB failure), so the db-field gate below needs the body, not just the status. `-w
  # '\n%{http_code}'` appends the code on its own trailing line (the health JSON is single-line),
  # so the last line is the status + everything before it is the body. --connect-timeout/--max-time
  # bound each probe so a still-booting monitor cannot wedge the poll.
  local http_code="" body="" resp="" elapsed=0
  while [[ "${elapsed}" -lt "${BOOTSTRAP_HEALTH_WINDOW_SECS}" ]]; do
    resp="$(curl -s --connect-timeout 2 --max-time 5 -w '\n%{http_code}' \
      "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
    http_code="$(printf '%s\n' "${resp}" | tail -n1)"
    body="$(printf '%s\n' "${resp}" | sed '$d')"
    [[ "${http_code}" == "200" ]] && break
    sleep 1
    elapsed=$((elapsed + 1))
  done

  # db-field gate: an http-code-only PASS would FALSE-PASS a DB-down monitor (health is 200 even
  # when degraded). Require the body's db field to be "open" (tolerate an optional space after ':').
  local db_open="no"
  case "${body}" in
    *'"db":"open"'* | *'"db": "open"'*) db_open="yes" ;;
    *) db_open="no" ;;
  esac

  # bind the verdict to the freshly-built child: capture WHILE the port is still
  # bound (before the kill block frees it). lsof -ti tcp:<port> lists the listener
  # PID(s); require mon_pid among them so a stale launchd instance answering 200
  # cannot be mistaken for the new build. lsof is BSD/macOS-available — loud-fail
  # (not silent-skip) if absent, per the Precondition Loud-Fail principle.
  local listener_ok="no"
  if [[ "${http_code}" == "200" ]]; then
    command -v lsof >/dev/null 2>&1 \
      || die "lsof not found — cannot verify the gate's own build is the :${port} listener (install lsof or stop any stale monitor and re-run)"
    local listener_pids
    listener_pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if printf '%s\n' "${listener_pids}" | grep -Fxq -- "${mon_pid}"; then
      listener_ok="yes"
    fi
  fi

  # stop the gate's monitor instance (kill, never launchctl). TERM→KILL escalation:
  # a SIGTERM-ignoring monitor would hang the wait, so re-check kill -0 after a short
  # grace and SIGKILL if still alive. Masked: a missing or already-exited PID must
  # not abort the gate's verdict.
  if [[ -n "${mon_pid}" ]] && kill -0 "${mon_pid}" 2>/dev/null; then
    kill "${mon_pid}" 2>/dev/null || true
    local grace=0
    while [[ "${grace}" -lt 5 ]] && kill -0 "${mon_pid}" 2>/dev/null; do
      sleep 1
      grace=$((grace + 1))
    done
    kill -0 "${mon_pid}" 2>/dev/null && kill -KILL "${mon_pid}" 2>/dev/null || true
    wait "${mon_pid}" 2>/dev/null || true
  fi

  if [[ "${http_code}" == "200" && "${listener_ok}" == "yes" && "${db_open}" == "yes" ]]; then
    log "== bootstrap: monitor health gate PASS (/api/health 200 + db:open in ${elapsed}s, port ${port}, listener=pid ${mon_pid}) =="
    if "${LOAD_LAUNCHD}"; then
      log "== bootstrap: health gate passed — proceeding to --load-launchd (loading the 8 launchd jobs) =="
    else
      log "== bootstrap COMPLETE — load launchd jobs manually (review-first): docs/INSTALL.md §7, or re-run with --load-launchd =="
    fi
    return 0
  fi
  # 200 from OUR freshly-built listener but the DB is unavailable (db:"closed" / degraded) — a
  # DISTINCT loud-fail (not the generic no-200 tail): the monitor is up, PostgreSQL is not.
  if [[ "${http_code}" == "200" && "${listener_ok}" == "yes" && "${db_open}" != "yes" ]]; then
    printf 'FATAL: monitor health gate FAILED — /api/health 200 on port %s but db is not "open" (monitor up, DB unavailable) — start/repair PostgreSQL, then re-run\n' \
      "${port}" >&2
    log "  monitor output (last 20 lines of ${GATE_LOG}):"
    tail -n 20 -- "${GATE_LOG}" >&2 || true
    exit "${BOOTSTRAP_EXIT_HEALTH}"
  fi
  if [[ "${http_code}" == "200" && "${listener_ok}" != "yes" ]]; then
    printf 'FATAL: /api/health returned 200 on port %s but the gate child (pid %s) was NOT the listener — a stale monitor (launchd?) answered, the freshly-built dist/ is unverified\n' \
      "${port}" "${mon_pid}" >&2
    log "  monitor output (last 20 lines of ${GATE_LOG}):"
    tail -n 20 -- "${GATE_LOG}" >&2 || true
    exit "${BOOTSTRAP_EXIT_HEALTH}"
  fi
  # surface the captured monitor log on failure — the only diagnostic for WHY the
  # gate never saw a 200 (e.g. a bind error / crash in the redirected output).
  printf 'FATAL: monitor health gate FAILED — no /api/health 200 within %ss (port %s, last=%s)\n' \
    "${BOOTSTRAP_HEALTH_WINDOW_SECS}" "${port}" "${http_code:-none}" >&2
  log "  monitor output (last 20 lines of ${GATE_LOG}):"
  tail -n 20 -- "${GATE_LOG}" >&2 || true
  exit "${BOOTSTRAP_EXIT_HEALTH}"
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
    # loaded job (esp. com.glass-atrium.monitor, which holds :7842) the daemon does
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

# kill_daemon_tmux_sessions — kill the DETACHED daemon tmux sessions (GA_DAEMON_SESSIONS).
# These run `claude --channels plugin:fakechat@...` and SURVIVE `launchctl bootout`
# (reparented to PID 1), so bootout alone leaves them running. Shared by uninstall
# (stop_detached_daemons) AND install start (clear a stale session so a fresh daemon boots
# clean). GUARDED exactly like unload_launchd_jobs: DRY_RUN reports without acting;
# is_sandbox_target skips the WHOLE kill (the tmux server is a per-USER host resource shared
# with the real user regardless of HOME — a sandboxed run must NOT kill the real sessions);
# a missing tmux is a loud-log skip (Precondition Loud-Fail — never silent). Best-effort,
# always returns 0.
kill_daemon_tmux_sessions() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping detached daemon tmux session teardown (${GA_DAEMON_SESSIONS[*]})"
    return 0
  fi
  # is_sandbox_target returns 0 by contract (stdout verdict) → masking is intentional
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "sandbox target — detached daemon tmux sessions untouched"
    return 0
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    log "tmux not found — skipping detached daemon tmux session teardown"
    return 0
  fi
  local sess
  for sess in "${GA_DAEMON_SESSIONS[@]}"; do
    if tmux has-session -t "${sess}" 2>/dev/null; then
      if tmux kill-session -t "${sess}" 2>/dev/null; then
        log "killed detached tmux session '${sess}'"
      else
        log "tmux kill-session '${sess}' failed (continuing)"
      fi
    else
      log "no detached tmux session '${sess}' to kill"
    fi
  done
  return 0
}

# clear_unmanaged_pg_orphan — INSTALL-scoped clear of a GENUINE unmanaged postgres orphan: a
# postmaster from a now-DELETED keg (files gone, process alive PPID 1) that keeps the :5432 /
# peer-auth socket and, having lost its tzdata, REJECTS `SET timezone='UTC'` — breaking the
# monitor's UTC-gated pool. Called ONLY from preflight_pg_utc_guard's unmanaged-orphan branch,
# reached after ga_detect_postgres_utc=='broken' AND a brew RESTART did not clear it — so a
# HEALTHY server (ok / down / absent) is never entered here and is NEVER touched. Two layers, NO
# brew-service stop (never stop a brew-managed server): (layer-2) lsof the socket/:5432, SIGINT
# (postgres FAST shutdown), poll the socket free (bounded); (layer-3) remove the stale socket
# file so a fresh install binds clean. Carries its OWN DRY_RUN + sandbox guards (it no longer
# sits behind stop_detached_daemons' guards) — a skipped clear leaves the orphan in place, so
# the caller's post-clear re-verify stays 'broken' and falls through to the loud-fail (never a
# false 'cleared'). GRACEFUL — every missing tool / failed signal is a loud-log skip, never
# fatal; always returns 0.
clear_unmanaged_pg_orphan() {
  local sock="${PG_SOCKET}/.s.PGSQL.5432"
  # This helper now runs install-scoped (from preflight_pg_utc_guard), NOT behind
  # stop_detached_daemons' guards — so it carries its OWN DRY_RUN + sandbox guards. A skipped
  # clear leaves the orphan, so the caller's re-verify stays 'broken' → correct loud-fail.
  if "${DRY_RUN}"; then
    log "dry-run: skipping unmanaged pg orphan clear on ${sock}"
    return 0
  fi
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "sandbox target — unmanaged pg orphan on ${sock} left untouched"
    return 0
  fi
  # (layer-2) identify the postmaster owning the socket/:5432 and SIGINT it (fast shutdown).
  if ! command -v lsof >/dev/null 2>&1; then
    log "lsof not found — cannot detect an orphaned postmaster on ${sock}"
    return 0
  fi
  local pids
  pids="$(lsof -t -- "${sock}" 2>/dev/null || true)"
  [[ -z "${pids}" ]] && pids="$(lsof -ti tcp:5432 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    log "no orphaned postmaster bound to ${sock} / :5432"
  else
    local pid
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] || continue
      # SIGINT = postgres "fast shutdown": rolls back active txns, then exits.
      if kill -INT "${pid}" 2>/dev/null; then
        log "sent SIGINT (fast shutdown) to orphaned postmaster pid ${pid}"
      else
        log "could not signal postmaster pid ${pid} (continuing)"
      fi
    done <<EOF
${pids}
EOF
    # bounded poll until the socket frees (never an unbounded wait — that would be a new
    # hang path). ~10s ceiling; break the instant the socket has no owner.
    local waited=0
    while [[ "${waited}" -lt 10 ]]; do
      [[ -e "${sock}" ]] || break
      [[ -z "$(lsof -t -- "${sock}" 2>/dev/null || true)" ]] && break
      sleep 1
      waited=$((waited + 1))
    done
  fi
  # (layer-3) remove a stale socket file left behind by the killed postmaster so a fresh
  # install's cluster binds a clean socket.
  if [[ -S "${sock}" ]]; then
    if rm -f -- "${sock}" 2>/dev/null; then
      log "removed stale postgres socket ${sock}"
    fi
  fi
  return 0
}

# stop_detached_daemons — uninstall teardown of the orphans that survive `launchctl bootout`
# + `claude plugin uninstall`: (a) the detached daemon tmux sessions and (b) lingering fakechat
# channel procs (`claude --channels plugin:fakechat@...` + their `spawn-unix-fd.py` helpers)
# that outlive the plugin uninstall. Runs BEFORE the DB drop so the daemons release their DB
# connections first. The postgres SERVER + its /tmp peer-auth socket are LEFT ALONE — uninstall
# must never stop a server it did not start (a healthy brew server + its socket are the user's,
# not GA's to tear down; the orphan clear lives install-side in preflight_pg_utc_guard, entered
# only for a genuinely broken/unmanaged squatter). GUARDED like unload_launchd_jobs (DRY_RUN
# report-only, is_sandbox_target skip — these are per-USER host resources shared with the real
# user regardless of HOME). Best-effort + loud-log each action; NEVER aborts uninstall (returns 0).
stop_detached_daemons() {
  # (a) tmux sessions — shared helper carries its own DRY_RUN + sandbox + tmux-absent guards.
  kill_daemon_tmux_sessions

  if "${DRY_RUN}"; then
    log "dry-run: skipping fakechat proc reap"
    return 0
  fi
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_sandbox_target)" == "yes" ]]; then
    log "sandbox target — fakechat procs untouched"
    return 0
  fi

  # (b) lingering fakechat channel procs + spawn helpers (outlive the plugin uninstall).
  if command -v pkill >/dev/null 2>&1; then
    if pkill -f 'claude --channels plugin:fakechat@' 2>/dev/null; then
      log "reaped lingering fakechat channel procs (claude --channels plugin:fakechat@)"
    else
      log "no lingering fakechat channel procs to reap"
    fi
    if pkill -f 'spawn-unix-fd.py' 2>/dev/null; then
      log "reaped fakechat spawn-unix-fd.py helper procs"
    else
      log "no fakechat spawn-unix-fd.py helper procs to reap"
    fi
  else
    log "pkill not found — skipping fakechat proc reap"
  fi
  # The postgres server + its /tmp peer-auth socket are intentionally NOT touched here — a
  # healthy server is the user's, and the genuine-orphan clear is install-scoped (preflight).
  return 0
}

# drop_databases — uninstall teardown: pre-drop BACKUP, then DROP, of the GA
# PostgreSQL databases (primary ${DB_NAME} + its shadow ${DB_NAME}_shadow) so a
# reinstall recreates a fresh, consistent DB while the dropped data stays
# RECOVERABLE. The fresh-DB intent stands (dev-agent roster + schema drift across
# installs → no auto-restore) — but the drop is gated on a verified backup:
# BACKUP-BEFORE-DROP, FAIL-CLOSED per database. Each EXISTING database is
# pg_dump'ed (custom -F c, pg_restore-compatible) to
#   ${HOME}/.claude/backups/postgres/<db>-pre-uninstall-<ts>.dump
# (pg-backup.sh's dir + timestamp convention; GA_DB_BACKUP_DIR sandbox override,
# mirroring oss-db-setup.sh). A dump that FAILS or is EMPTY (non-empty gate =
# oss-db-setup.sh backup_db_to_file precedent) SKIPS the drop for THAT database —
# loud log, data preserved, uninstall continues. Applied uniformly (the shadow DB
# may legitimately dump near-empty; the same gate still governs it).
# Pre-uninstall dumps are KEEP-FOREVER safety artifacts: no rotation here, and
# pg-backup.sh's 14-dump keep-window never trashes them ('pre-' sorts above every
# dated glass_atrium-* name in its DESCENDING keep-window — load-bearing ordering,
# do not rename without re-checking that glob). An absent database skips both dump
# and drop silently (--if-exists semantics). SECURITY: peer-auth Unix socket ONLY
# (-h ${PG_SOCKET}), never a host/port + credentials, never reads/echoes a secret.
# IDEMPOTENT (absent DB → clean no-op). GRACEFUL: a missing binary or unreachable
# server logs a warning and returns 0 so the rest of uninstall still completes —
# never fatal, and EVERY failure path lands on the data-PRESERVING side (skip the
# drop, keep the DB). This is a DELIBERATE, user-requested path that drops the
# LIVE DB; it is DISTINCT from recreate_db_gate (which refuses the live DB from
# the installer's --recreate-db path). That guard is for a different path and is
# intentionally NOT reused or weakened here.
drop_databases() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping DB backup + drop (${DB_NAME}, ${DB_NAME}_shadow)"
    return 0
  fi
  if ! command -v dropdb >/dev/null 2>&1; then
    log "uninstall: dropdb not found — skipping DB drop (advisory; reinstall recreates the DB)"
    return 0
  fi
  # BACKUP-BEFORE-DROP hard precondition: without pg_dump nothing can be backed
  # up, so nothing may be dropped (fail-closed, data preserved, still exit 0).
  if ! command -v pg_dump >/dev/null 2>&1; then
    log "uninstall: pg_dump not found — SKIPPING DB drop entirely (backup-before-drop is mandatory; data preserved)"
    return 0
  fi
  local backup_dir="${GA_DB_BACKUP_DIR:-${HOME}/.claude/backups/postgres}"
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  if ! mkdir -p -- "${backup_dir}"; then
    log "uninstall: cannot create backup dir ${backup_dir} — SKIPPING DB drop entirely (data preserved)"
    return 0
  fi
  local db probe dump dropped=0
  log "uninstall: backing up + dropping GA databases via peer-auth socket (${PG_SOCKET})"
  # Scope is EXACTLY the two GA databases — never a wildcard, never "drop all".
  for db in "${DB_NAME}" "${DB_NAME}_shadow"; do
    # Absent DB → skip dump AND drop silently. A FAILED probe (server unreachable)
    # also lands on the data-preserving side: no dump, no drop, loud warn.
    if ! probe="$(psql -h "${PG_SOCKET}" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${db}'" 2>/dev/null)"; then
      log "  warn: existence probe for '${db}' failed (server unreachable?) — drop skipped (data preserved)"
      continue
    fi
    if [[ "${probe}" != "1" ]]; then
      log "  skip: ${db} absent — nothing to back up or drop"
      continue
    fi
    # FAIL-CLOSED dump gate: dump must complete AND be non-empty, or THIS
    # database's drop is skipped. pg_dump stderr flows through (loud-fail aid).
    dump="${backup_dir}/${db}-pre-uninstall-${ts}.dump"
    if ! pg_dump -h "${PG_SOCKET}" -d "${db}" -F c -f "${dump}" || [[ ! -s "${dump}" ]]; then
      log "  SKIP-DROP: pre-drop backup of '${db}' failed or empty (${dump}) — '${db}' NOT dropped (data preserved)"
      continue
    fi
    log "  backup: ${db} → ${dump}"
    # --if-exists: drop-race tolerance. --force (PG 13+): terminate residual
    # connections (daemons were booted out above, but stay defensive).
    if dropdb -h "${PG_SOCKET}" --if-exists --force "${db}" >/dev/null 2>&1; then
      dropped=$((dropped + 1))
      log "  drop: ${db} dropped (backup: ${dump})"
    else
      log "  warn: dropdb '${db}' failed (server unreachable?) — skipped (advisory)"
    fi
  done
  log "uninstall: DB drop done (${dropped}/2 dropped — skipped DBs preserved)"
  return 0
}

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


# Advisory post-install liveness check — NEVER aborts AND NEVER hangs the install.
# Uses `claude --version`, deliberately NOT `claude doctor`: doctor spawns MCP
# health-check servers that (a) hang in a non-interactive context and (b) DETACH to
# their own session/pgroup, so even a process-group SIGKILL cannot reliably reap
# them — and a detached child that inherited the caller's run_step step_sink
# process-substitution pipe keeps that pipe's write end open, so run_step's bare
# `wait` deadlocks forever (the install-hang root cause). `--version` spawns no MCP,
# completes sub-second, and confirms the CLI runs post-install (the advisory intent).
#
# HANG-IMMUNITY (primary): claude's stdin/stdout/stderr are ALL routed to /dev/null,
# NOT to the inherited fd 2 (which IS the run_step sink pipe). The verdict travels
# only via the wrapper's EXIT CODE, never via claude's output streams — so claude
# (and any child it might fork) holds /dev/null, never the sink pipe → run_step's
# `wait` always reaches EOF and returns regardless of orphans. The timeout bound is
# secondary defense-in-depth.
doctor_postcheck() {
  "${DRY_RUN}" && return 0
  if ! command -v claude >/dev/null 2>&1; then
    log "post-check: 'claude' CLI not found — skipping liveness check (advisory)"
    return 0
  fi
  if ! command -v perl >/dev/null 2>&1; then
    log "post-check: 'perl' not found — cannot bound the check; skipping (advisory)"
    return 0
  fi

  local check_timeout=15 check_rc=0
  log "post-check: running 'claude --version' liveness check (advisory)"
  # masked exit + full /dev/null I/O decoupling. The set +e capture keeps the
  # engine's set -e intact; also suspend the ERR trap, which set -E propagates into
  # run_with_timeout — a non-zero (timeout/exit) return would otherwise print a
  # spurious ERROR line. stdin /dev/null: no interactive-prompt block possible.
  set +e
  trap - ERR
  run_with_timeout "${check_timeout}" claude --version </dev/null >/dev/null 2>&1
  check_rc=$?
  trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
  set -e
  if [[ "${check_rc}" -eq 0 ]]; then
    log "post-check: 'claude --version' ok — CLI is live"
  elif [[ "${check_rc}" -eq 124 ]]; then
    log "post-check: 'claude --version' timed out after ${check_timeout}s — skipped (advisory only)"
  else
    log "post-check: 'claude --version' exited ${check_rc} — advisory only, install unaffected"
  fi
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
