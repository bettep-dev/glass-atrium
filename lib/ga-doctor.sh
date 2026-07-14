# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (GA_ROOT/TARGET_HOME/MANIFEST/SETTINGS_JSON/CONFIG_TOML/EXPECTED_HOOK_BINDINGS/GENERATE_MANIFEST/DRY_RUN) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — doctor/preflight diagnostics + verify-clean parity + post-install liveness domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# doctor / preflight
# Mutation-free checks: same-device, target writable, no dangling, manifest ok.
# $1 == "preflight" → §7 target-side deploy reconciliation is ADVISORY (warn, not abort): a fresh
# install legitimately has 0 deployed entries (run_symlink_farm runs AFTER preflight). The
# standalone `doctor` (no arg) → §7 stays a hard FAIL on a deployed system with drifted/missing symlinks.
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

  # 3. same-device advisory — GA root vs target home. Informational only: the swap rename is atomic
  # by construction (STAGE_TMP co-located with dst), so a cross-device layout does NOT abort the
  # install — surfaced as a layout note (e.g. GA checkout on an external volume) without failing doctor.
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

  # 6. hook event-binding gap (D-5) — the installer deploys hook FILES but the event->hook WIRING
  #    lives ONLY in settings.json (user-owned, NOT in the manifest), so a clean/partial install
  #    leaves deployed hooks DORMANT (on disk, never fired). Mutation-free by design: auto-writing
  #    settings.json is unsafe (clobbers user config + violates never-touch), so SURFACE the gap
  #    loudly and let the USER apply the bindings. Missing bindings are a WARNING (doctor still
  #    PASSes on §1-5), not a hard FAIL — the fix is documentation, not mutation (see the
  #    apply-by-hand NOTE below + manifest.json ._doc_settings_json).
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
      # matcher-scoped check so the same hook bound under two matchers (e.g. validate-secret-scan.sh
      # on Write|Edit AND Bash) is reported per-tuple — a missing Bash binding not masked by a present one.
      # is_hook_bound is a stdout verdict (exits 0) → SC2311 masking intentional (no file-scope set -e).
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

  # 7. target-side deploy reconciliation — symmetric inverse of §4. §4 checks manifest entry ->
  #    SOURCE present; this checks manifest entry -> TARGET installed (a symlink under TARGET_HOME
  #    resolving into GA_ROOT). An entry present in the source but NOT symlinked into the target is
  #    UNDEPLOYED — invisible to §4 (source present) and §5 (only flags EXISTING dangling links).
  #    Loud-fail per shared-self-improve-hygiene.md Precondition Loud-Fail Principle: surface every
  #    miss so a partial/stale deploy (e.g. a new skill/script never run through `glass-atrium
  #    agents-only`) cannot fossilize silently.
  local undeployed_fresh=0
  if command -v jq >/dev/null 2>&1 && [[ -f "${MANIFEST}" && -d "${TARGET_HOME}" ]] \
    && jq -e '.files | type == "array"' -- "${MANIFEST}" >/dev/null 2>&1; then
    # Two contexts downgrade §7 from hard-FAIL to advisory:
    #   (a) preflight — run_symlink_farm runs AFTER preflight, so a fresh install legitimately has
    #       0 deployed entries.
    #   (b) FULLY-FRESH standalone target — a brand-new empty target home with NO GA-pointing
    #       symlinks is the SAME not-yet-deployed case, not drift. ga_links (the §5 find idiom)
    #       counts GA-pointing symlinks under TARGET_HOME; zero ⇒ nothing deployed ⇒ every entry
    #       reports undeployed. The hard-FAIL is RESERVED for genuine PARTIAL drift (some deployed,
    #       some missing) on an established install.
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
      # install-internal payload (is_symlink_excluded: lib/ monitor/ hooks/ scoped/ scripts/ autoagent/
      # + the exact tail) is bundled + §4-hash-verified but consumed IN PLACE from GA_ROOT — never a
      # ~/.claude symlink — so a target-side deploy check can NEVER find it. Skip it here, matching the
      # write-side run_symlink_farm / removal-side remove_manifest_links choke point; without this the
      # ~278 internal entries wrongly report "not deployed" and FAIL doctor on a healthy install.
      # is_symlink_excluded is a stdout verdict (exits 0) → SC2311 masking intentional (no file-scope set -e).
      # shellcheck disable=SC2310,SC2311,SC2312
      if [[ "$(is_symlink_excluded "${rel}")" == "yes" ]]; then
        continue
      fi
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

  # 8. manifest drift gate (D-T2) — advisory-but-loud, git-presence-routed. generate-manifest.sh
  #    --check is git-backed (git ls-files is its file-list SoT) and HARD-EXITS 3 on a non-git root
  #    BEFORE any comparison — so on a deployed consumer install (~/.glass-atrium ships no .git) the
  #    gate read that exit-3 as DRIFT and false-warned on EVERY install. Route on `.git` presence
  #    (mirrors §9b): a source-dev tree keeps the git-backed --check; a consumer install falls back to
  #    a git-INDEPENDENT hash reconciliation (sha256 each manifest.hashes entry vs its on-disk file),
  #    which catches real content drift + a listed-but-missing file without needing git. Still a
  #    WARNING either way (doctor PASSes on §1-7); a skip (missing tool/generator) stays loud.
  local drift=0
  if [[ -e "${GA_ROOT}/.git" ]]; then
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
  elif ! command -v jq >/dev/null 2>&1 || [[ ! -f "${MANIFEST}" ]]; then
    log "  warn : manifest drift gate skipped (consumer install — manifest unreadable or jq absent)"
  else
    # consumer install (no .git): resolve the sha256 tool as generate-manifest.sh does (shasum →
    # sha256sum), then run the git-independent reconciliation. An absent tool is a loud skip, never
    # a silent pass (Precondition Loud-Fail Principle).
    local drift_sha=()
    # empty resolver → read hits EOF (rc 1); || true keeps set -e off so the empty-array loud-skip fires.
    # shellcheck disable=SC2310
    read -ra drift_sha < <(_resolve_sha256_cmd) || true
    if [[ "${#drift_sha[@]}" -eq 0 ]]; then
      log "  warn : manifest drift gate skipped (consumer install — no shasum/sha256sum for hash reconciliation)"
    else
      # manifest_hash_drift logs each drift to stderr + echoes the drift count (stdout verdict).
      # shellcheck disable=SC2311,SC2312
      drift="$(manifest_hash_drift "${drift_sha[@]}")"
      if [[ "${drift}" -eq 0 ]]; then
        log "  ok   : manifest matches on-disk hashes (git-independent consumer-install reconciliation)"
      else
        log "  ---- ${drift} manifest hash drift(s) on this consumer install (regenerate on the source tree, then re-release) ----"
      fi
    fi
  fi

  # 9. update-system advisory (E5 — T22/T27). PASS-compatible by design: every line is info, a
  #    note, or a WARN — §9 NEVER sets `fail` (an unconfigured release repo / source-dev tree is a
  #    valid state). Surfaces the update CLI's health: installed version, source-dev vs consumer
  #    tree, release-repo wiring, base@install baseline presence, a STALE-pause warning.
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

  # 10. inject-scope-rules drop marker (recurrence surface). inject-scope-rules.sh compresses the four
  #     AGENT-INJECT source blocks so the worst-case DEV assembly fits INJECT_CTX_MAX_BYTES; if a
  #     future block edit re-inflates the assembly past the ceiling, a scope block is dropped SILENTLY
  #     (Claude Code discards SubagentStart hook stderr), so the hook persists each drop to a
  #     HOME-relative diag log. Surface it as a WARN (never a FAIL): a recorded drop means a scope
  #     block stopped reaching subagents — recompress the AGENT-INJECT source blocks. Mutation-free.
  local drop_events=0
  local inject_drop_log="${TARGET_HOME}/.claude/logs/inject-scope-rules.diag.log"
  if [[ -f "${inject_drop_log}" ]]; then
    # grep -c prints "0" + exits 1 on zero matches → `|| true` swallows the rc without double-counting
    # (masked substitution rc keeps set -e intact; SC2312 fires only for the lib's lack of file-scope set -e).
    # shellcheck disable=SC2312
    drop_events="$(grep -c 'inject-scope-rules] DROP' "${inject_drop_log}" 2>/dev/null || true)"
    [[ -n "${drop_events}" ]] || drop_events=0
    if [[ "${drop_events}" -gt 0 ]]; then
      log "  warn : ${drop_events} inject-scope-rules block-drop event(s) recorded (${inject_drop_log}) — a scope block exceeded INJECT_CTX_MAX_BYTES and was NOT injected into subagents; recompress the AGENT-INJECT source blocks"
      local last_drop
      # shellcheck disable=SC2312
      last_drop="$(grep 'inject-scope-rules] DROP' "${inject_drop_log}" 2>/dev/null | tail -n1 || true)"
      [[ -n "${last_drop}" ]] && log "         latest: ${last_drop}"
    else
      log "  ok   : no inject-scope-rules block-drop events recorded"
    fi
  else
    log "  ok   : no inject-scope-rules drop log (no block-drop events)"
  fi

  # 11. launchd deploy-drift gate (recurrence guard for the stale-deployed PATH incident). The plist
  #     renderer (render-launchd-plists.sh) is RENDER-ONLY (T32): it writes plists into RENDERED_PLIST_DIR
  #     but NEVER deploys/reloads them — deploy+reload is a SEPARATE step (load_launchd_jobs / --load-launchd).
  #     So a renderer change (e.g. a PATH fix) that is re-rendered but NEVER re-deployed leaves the plists
  #     ACTUALLY LOADED under ${LAUNCH_AGENTS} diverged from what the current renderer produces — the jobs
  #     run for days on stale content (the exact PATH-drift incident). Render-time probe_launchd_deps()
  #     guards only render-time resolvability, NOT this deploy gap. Detect it: re-render the CURRENT
  #     expected plists into a TEMP dir (GA_PLIST_OUT override — side-effect-free per the render-only
  #     contract, never touches RENDERED_PLIST_DIR) and sha256-compare each DEPLOYED plist against its
  #     temp-rendered twin. A mismatch is advisory-but-loud (feeds `warns`, never a hard FAIL — same
  #     treatment as §8 manifest drift): a legitimately-drifted deployed install is FLAGGED, not failed.
  #     Mutation-free w.r.t. install state (temp scratch render + read-only compare; the temp dir is
  #     removed after). Skips are LOUD, never silent OKs (Precondition Loud-Fail Principle): NO deployed
  #     com.glass-atrium plists (not-yet-loaded install) is a CLEAN skip (not a warn); a missing renderer,
  #     no sha tool, or a failed reference-render is a WARN-style skip.
  local launchd_drift=0
  local deployed_count=0 ld_job ld_label
  for ld_job in "${LAUNCHD_JOBS[@]}"; do
    ld_label="${LAUNCHD_LABEL_PREFIX}.${ld_job}"
    [[ -f "${LAUNCH_AGENTS}/${ld_label}.plist" ]] && deployed_count=$((deployed_count + 1))
  done
  if [[ "${deployed_count}" -eq 0 ]]; then
    log "  ok   : no deployed com.glass-atrium launchd plists (not-yet-loaded install — deploy-drift check skipped)"
  elif [[ ! -f "${PLIST_RENDERER}" ]]; then
    log "  warn : launchd deploy-drift check skipped — plist renderer missing (${PLIST_RENDERER})"
  else
    local ld_sha=()
    # empty resolver → read hits EOF (rc 1); || true keeps set -e off so the empty-array loud-skip fires.
    # shellcheck disable=SC2310
    read -ra ld_sha < <(_resolve_sha256_cmd) || true
    if [[ "${#ld_sha[@]}" -eq 0 ]]; then
      log "  warn : launchd deploy-drift check skipped — no shasum/sha256sum for plist comparison"
    else
      local ld_tmp
      ld_tmp="$(mktemp -d -t ga-doctor-launchd.XXXXXX)"
      # A failed mktemp leaves ld_tmp EMPTY; the renderer resolves an empty GA_PLIST_OUT via
      # ${GA_PLIST_OUT:-<default>} to its PRODUCTION default (<GA root>/rendered/launchd), so rendering
      # with an empty ld_tmp would MUTATE the live rendered dir — violating §11's temp-isolation /
      # render-only contract. The end-of-block cleanup already guards the same [-n && -d]; guard it
      # BEFORE the render too. A missing temp dir is a LOUD skip (Precondition Loud-Fail), never a
      # false OK or a live write.
      if [[ -z "${ld_tmp}" || ! -d "${ld_tmp}" ]]; then
        log "  warn : launchd deploy-drift check skipped — temp render dir unavailable (mktemp failed)"
      # Re-render the current expected plists into the temp dir. GA_PLIST_OUT redirects the write
      # (render-only contract → RENDERED_PLIST_DIR untouched); GA_CONFIG_TOML pins THIS install's
      # config (same input load_launchd_jobs deployed from); GA_SKIP_DEP_PROBE silences the same-host
      # tool probe. A render failure (config missing/invalid, lint, path-leak) is a LOUD skip, never a
      # false OK — its non-zero exit routes to the else branch.
      elif GA_CONFIG_TOML="${CONFIG_TOML}" GA_PLIST_OUT="${ld_tmp}" GA_SKIP_DEP_PROBE=1 \
        bash "${PLIST_RENDERER}" >/dev/null 2>&1; then
        # launchd_deploy_drift logs each drift to stderr + echoes the drift count (stdout verdict).
        # shellcheck disable=SC2311,SC2312
        launchd_drift="$(launchd_deploy_drift "${ld_tmp}" "${ld_sha[@]}")"
        if [[ "${launchd_drift}" -eq 0 ]]; then
          log "  ok   : ${deployed_count} deployed launchd plist(s) match the current renderer output"
        else
          log "  ---- ${launchd_drift} stale-deployed launchd plist(s) — re-render + --load-launchd to redeploy ----"
        fi
      else
        log "  warn : launchd deploy-drift check skipped — reference re-render failed (config missing/invalid? run 'glass-atrium render-plists')"
      fi
      [[ -n "${ld_tmp}" && -d "${ld_tmp}" ]] && rm -rf -- "${ld_tmp}"
    fi
  fi

  if [[ "${fail}" -eq 0 ]]; then
    local warns=$((unbound + drift + stale_pause + undeployed_fresh + drop_events + launchd_drift))
    if [[ "${warns}" -eq 0 ]]; then
      log "== doctor: PASS =="
    else
      log "== doctor: PASS (with ${unbound} dormant-hook + ${drift} manifest-drift + ${stale_pause} stale-pause + ${undeployed_fresh} fresh-undeployed + ${drop_events} inject-drop + ${launchd_drift} launchd-drift warning(s) — see above) =="
    fi
    return 0
  fi
  log "== doctor: FAIL =="
  return 1
}

# sha256 tool resolver (run_doctor §8 + §11 shared) — emits the sha256 command tokens
# (`shasum -a 256` → `sha256sum`, generate-manifest.sh's order) as a whitespace line for a
# `read -ra`, or NOTHING when neither tool exists. Callers keep their own empty-array loud-skip
# (Precondition Loud-Fail Principle); this centralizes only the resolution order.
_resolve_sha256_cmd() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s\n' 'shasum -a 256'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' 'sha256sum'
  fi
}

# sha256 hex-digest extract (manifest_hash_drift / launchd_deploy_drift shared) — runs the passed
# sha command and echoes ONLY its first whitespace field (the hex digest, dropping the trailing
# filename). `|| return` propagates a sha failure to the caller, matching the abort semantics of the
# inline form it replaces. Usage: _sha_hex "${sha[@]}" -- "${file}".
_sha_hex() {
  local out
  out="$("$@")" || return
  printf '%s\n' "${out%% *}"
}

# consumer-install manifest hash reconciliation (git-independent) — run_doctor §8 helper.
# generate-manifest.sh --check is git-backed (git ls-files) and hard-exits 3 on a non-git root; this
# reconciles the manifest WITHOUT git so a deployed consumer install (no .git) still gets a real
# integrity gate instead of a false DRIFT warn. $@ = the sha256 command (e.g. `shasum -a 256` /
# `sha256sum`). For every manifest.hashes entry a DRIFT is flagged when the listed path is
# missing/unreadable on disk OR its content hash differs from the recorded one; each drift is logged
# to stderr (log → fd2) and the total is the stdout verdict (mirrors is_hook_bound). Detects real
# content drift + a dropped file; it CANNOT see a NEW untracked file (needs git ls-files) — an
# accepted gap off a dev tree. Callers pre-verify jq + MANIFEST presence.
manifest_hash_drift() {
  local sha_path sha_hash actual abs drift=0
  # jq streams `path\thash`; process substitution keeps the counter in this shell (mirrors §7).
  # shellcheck disable=SC2312
  while IFS=$'\t' read -r sha_path sha_hash; do
    [[ -n "${sha_path}" ]] || continue
    abs="${GA_ROOT}/${sha_path}"
    if [[ ! -e "${abs}" ]]; then
      log "  warn : manifest DRIFT — listed file missing on disk: ${sha_path}"
      drift=$((drift + 1))
      continue
    fi
    if [[ ! -r "${abs}" ]]; then
      log "  warn : manifest DRIFT — listed file not readable: ${sha_path}"
      drift=$((drift + 1))
      continue
    fi
    # _sha_hex propagates a sha failure via || return (the assignment rc still trips set -e); SC2311 masking is moot.
    # shellcheck disable=SC2311
    actual="$(_sha_hex "$@" -- "${abs}")"
    if [[ "${actual}" != "${sha_hash}" ]]; then
      log "  warn : manifest DRIFT — content hash mismatch: ${sha_path}"
      drift=$((drift + 1))
    fi
  done < <(jq -r '(.hashes // {}) | to_entries[] | "\(.key)\t\(.value)"' -- "${MANIFEST}")
  printf '%d\n' "${drift}"
}

# launchd deploy-drift comparison — run_doctor §11 helper. For each com.glass-atrium.* job whose plist
# is DEPLOYED under ${LAUNCH_AGENTS}, sha256-compare the deployed file against its freshly re-rendered
# twin in $1 (the temp render dir). A deployed plist whose content diverges from the current renderer
# output is STALE — rendered-but-never-redeployed drift (the PATH-incident recurrence surface). Each
# drift is logged to stderr (log → fd2) and the total is the stdout verdict (mirrors manifest_hash_drift).
# $1 = temp render dir · $2.. = the sha256 command (e.g. `shasum -a 256`). A job with NO deployed plist is
# skipped (partial-load is not this check's drift); a missing twin is a renderer anomaly, logged not
# counted. Callers pre-verify the reference render ran + the sha tool resolves.
launchd_deploy_drift() {
  local tmp_dir="$1"
  shift
  local ld_job label deployed twin dep_hash twin_hash drift=0
  for ld_job in "${LAUNCHD_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${ld_job}"
    deployed="${LAUNCH_AGENTS}/${label}.plist"
    twin="${tmp_dir}/${label}.plist"
    # only DEPLOYED jobs are in scope — a not-loaded job is not this check's drift.
    [[ -f "${deployed}" ]] || continue
    if [[ ! -f "${twin}" ]]; then
      log "  warn : launchd deploy-drift — no rendered reference for ${label} (renderer anomaly)"
      continue
    fi
    # _sha_hex propagates a sha failure via || return (the assignment rc still trips set -e); SC2311 masking is moot.
    # shellcheck disable=SC2311
    dep_hash="$(_sha_hex "$@" -- "${deployed}")"
    # shellcheck disable=SC2311
    twin_hash="$(_sha_hex "$@" -- "${twin}")"
    if [[ "${dep_hash}" != "${twin_hash}" ]]; then
      log "  warn : stale-deployed launchd plist drift: ${label} — re-render + --load-launchd to redeploy"
      drift=$((drift + 1))
    fi
  done
  printf '%d\n' "${drift}"
}

# verify-clean (parity doctor)
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
