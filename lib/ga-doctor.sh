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

  # 8. manifest drift gate (D-T2) — advisory-but-loud. generate-manifest.sh --check fails (exit 1)
  #    on a source-vs-manifest divergence (a tracked in-scope file missing from .files, or a listed
  #    entry no longer tracked). Surfaced as a WARNING (doctor still PASSes on §1-7) so a healthy
  #    install isn't blocked; skipped (not a fail) when the generator is absent.
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
