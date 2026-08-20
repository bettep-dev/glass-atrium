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
  #    apply-by-hand NOTE below + the settings.json contract in scripts/generate-manifest.sh's header).
  #    SECOND dormant class, same section because the trigger is the SAME wiring roster: a hook that IS
  #    wired but whose live file lacks the executable bit. Claude Code spawns each binding as a COMMAND,
  #    so a mode-644 hook is bound-yet-inert — the protection silently never runs (the defect this check
  #    exists to surface). Unlike a missing binding this is a hard FAIL: the file is Atrium-owned and the
  #    fix is a deterministic chmod, so §6's "fix lives in user-owned settings.json" warn rationale does
  #    not apply. Scoped by three guards — EXISTING files only (an absent file is §4/§7's deploy-presence
  #    class, never double-reported here), the GA_ROOT hooks dir wire_hooks emits, and the expected-roster
  #    loop (never a settings.json sweep, so foreign user hooks and sourced libraries cannot false-fail).
  #    THIRD class, split out of the missing-binding warning: a hook wired under one matcher but
  #    MISSING another expected tuple is NOT dormant — it fires, only that facet is unwired. Reporting
  #    it as "deployed but never fires" is wrong in the dangerous direction: the operator reads an inert
  #    gate and reaches for a full re-wire to satisfy a facet warning. Whole-hook bound state is not
  #    knowable inside the per-tuple loop at the moment it logs (a LATER tuple may be bound), so a
  #    PRE-PASS collects bound basenames first and the loop branches on it.
  local unbound=0 facet_unbound=0 nonexec=0 nonexec_seen="" bound_seen=""
  if [[ ! -f "${SETTINGS_JSON}" ]]; then
    log "  warn : settings.json absent (${SETTINGS_JSON}) — ALL hook event-bindings are unwired; deployed hooks are DORMANT"
    unbound=${#EXPECTED_HOOK_BINDINGS[@]}
  elif ! command -v jq >/dev/null 2>&1; then
    log "  warn : jq absent — cannot read hook bindings from settings.json (skipping binding check)"
  else
    # PRE-PASS: bound-basename set (bash-3.2-safe substring set, same idiom as nonexec_seen —
    # no assoc arrays). Basename-keyed, NOT per-tuple: the question it answers is "does this hook
    # file ever fire?", which is what the dormant wording claims. Deduped, so a hook bound under
    # two matchers costs one query.
    local pre_binding pre_event pre_hook pre_matcher
    for pre_binding in "${EXPECTED_HOOK_BINDINGS[@]}"; do
      IFS=$'\t' read -r pre_event pre_hook pre_matcher <<<"${pre_binding}"
      [[ "${bound_seen}" != *" ${pre_hook} "* ]] || continue
      # shellcheck disable=SC2310,SC2311,SC2312
      if [[ "$(is_hook_bound "${pre_event}" "${pre_hook}" "${pre_matcher}")" == "yes" ]]; then
        bound_seen="${bound_seen} ${pre_hook} "
      fi
    done
    local binding event hook matcher hook_path
    for binding in "${EXPECTED_HOOK_BINDINGS[@]}"; do
      IFS=$'\t' read -r event hook matcher <<<"${binding}"
      # matcher-scoped check so the same hook bound under two matchers (e.g. validate-secret-scan.sh
      # on Write|Edit AND Bash) is reported per-tuple — a missing Bash binding not masked by a present one.
      # is_hook_bound is a stdout verdict (exits 0) → SC2311 masking intentional (no file-scope set -e).
      # shellcheck disable=SC2310,SC2311,SC2312
      if [[ "$(is_hook_bound "${event}" "${hook}" "${matcher}")" == "yes" ]]; then
        log "  ok   : hook bound — ${event} -> ${hook} (matcher=${matcher:-<none>})"
        # mode is a per-FILE property (the binding is per-tuple), so a hook wired under two matchers
        # reports ONE executability line — the seen-list is a bash-3.2-safe substring set (no assoc arrays).
        hook_path="${GA_ROOT}/hooks/${hook}"
        if [[ -f "${hook_path}" && ! -x "${hook_path}" && "${nonexec_seen}" != *" ${hook} "* ]]; then
          log "  FAIL : hook wired but NOT executable — ${hook_path} (DORMANT: bound yet can never run)"
          nonexec_seen="${nonexec_seen} ${hook} "
          nonexec=$((nonexec + 1))
        fi
      elif [[ "${bound_seen}" == *" ${hook} "* ]]; then
        log "  warn : hook matcher facet NOT wired — ${event} -> ${hook} (matcher=${matcher:-<none>}) (PARTIAL: this hook IS wired elsewhere and DOES fire — the gate is live, only this facet is missing)"
        facet_unbound=$((facet_unbound + 1))
      else
        log "  warn : hook NOT bound — ${event} -> ${hook} (matcher=${matcher:-<none>}) (DORMANT: deployed but never fires)"
        unbound=$((unbound + 1))
      fi
    done
  fi
  # two CLASS-SCOPED aggregates so a mixed run (a facet miss AND a genuinely unbound hook) reports
  # both truthfully — one flattened line would either mislabel the facet or suppress the remedy the
  # real miss needs.
  if [[ "${facet_unbound}" -gt 0 ]]; then
    log "  ---- ${facet_unbound} unwired matcher facet(s) on hooks that ARE wired and firing — the gate is LIVE, not inert ----"
    log "       fix: hand-add the missing matcher as its own .hooks.<event> group in ${SETTINGS_JSON}; a live gate needs no redeploy."
  fi
  if [[ "${unbound}" -gt 0 ]]; then
    log "  ---- ${unbound} dormant hook binding(s): add each to ${SETTINGS_JSON} under .hooks.<event> ----"
    log "       example entry (PreToolUse): {\"matcher\":\"Agent\",\"hooks\":[{\"type\":\"command\",\"command\":\"~/.glass-atrium/hooks/<hook>.sh\"}]}"
    log "       NOTE: this doctor check is read-only and never writes settings.json. Add each missing binding BY HAND (example above) — a full installer run is NOT the reflex remedy: it reconciles EVERY Atrium binding at once, a far wider mutation than the gap reported here."
  fi
  if [[ "${nonexec}" -gt 0 ]]; then
    log "  ---- ${nonexec} wired hook(s) missing the executable bit — bound but permanently inert ----"
    log "       fix: chmod +x ${GA_ROOT}/hooks/<hook>.sh (or re-run 'glass-atrium install' to redeploy)"
    fail=1
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
  #    The consumer reconciliation additionally SKIPS the content comparison for every row the merge
  #    claims, so designed local evolution — daemon-learned EDITABLE-region bullets, an operator
  #    `model:` pin, a roster file's live rows — stops reading as drift. Presence and readability are
  #    still checked on a skipped row; the tamper signal on its content is what the skip gives up.
  #    See manifest_hash_drift. The source-dev --check branch stays STRICT on purpose: there the
  #    whole-file hash IS the regeneration trigger.
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
    # IFS prefix scopes space+tab splitting to THIS read only — the launcher's strict IFS=$'\n\t'
    # otherwise keeps `shasum -a 256` as one array word → an unrunnable command name.
    # shellcheck disable=SC2310
    IFS=$' \t' read -ra drift_sha < <(_resolve_sha256_cmd) || true
    if [[ "${#drift_sha[@]}" -eq 0 ]]; then
      log "  warn : manifest drift gate skipped (consumer install — no shasum/sha256sum for hash reconciliation)"
    else
      # manifest_hash_drift logs each drift to stderr + echoes the drift count (stdout verdict).
      # shellcheck disable=SC2311,SC2312
      drift="$(manifest_hash_drift "${drift_sha[@]}")"
      if [[ "${drift}" -eq 0 ]]; then
        log "  ok   : manifest matches on-disk hashes (git-independent consumer-install reconciliation)"
      else
        # Remedy names an action that CLEARS the reported condition. Every surviving drift is now
        # either a missing/unreadable file or altered content in a row the merge does NOT claim —
        # both are restored by re-running the updater, which re-lays the vendor structure from the
        # release while preserving the EDITABLE regions and the live-only `model:` pins.
        # The former "regenerate on the source tree, then re-release" could not clear it:
        # the source tree has no drift, and
        # forcing live to match the whole-file hash would overwrite exactly those pins.
        # The updater no longer partitions a row out of its apply set by path pattern, so no
        # drifted row is unreachable by the remedy for what the file is named.
        log "  ---- ${drift} manifest hash drift(s) on this consumer install ----"
        log "         remedy: run 'glass-atrium update' to restore the listed file(s) from the release (EDITABLE regions + model: pins are preserved)"
      fi
    fi
  fi

  # 9. update-system advisory (E5 — T22). PASS-compatible by design: every line is info, a
  #    note, or a WARN — §9 NEVER sets `fail` (an unconfigured release repo / source-dev tree is a
  #    valid state). Surfaces the update CLI's health: installed version, source-dev vs consumer
  #    tree, release-repo wiring, base@install baseline presence.
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
  # 10. inject-scope-rules shed surface. inject-scope-rules.sh compresses the AGENT-INJECT source
  #     blocks so the worst-case DEV assembly fits INJECT_CTX_MAX_BYTES; when the assembly still
  #     overruns, a block is shed SILENTLY (Claude Code discards SubagentStart hook stderr), so the
  #     hook persists each shed to a HOME-relative diag log. Two properties of that log decide the
  #     verdict shape here, and getting either wrong emits an unclearable imperative:
  #       · APPEND-ONLY + lifetime-scoped — a count over the whole file asserts a condition that may
  #         have ended months ago, so the verdict is computed over a DATE WINDOW only.
  #       · the shed classes have DIFFERENT remedies, and only one has any remedy at all:
  #           non-lesson DROP    → warn. A scope block stopped reaching subagents; recompressing the
  #                                AGENT-INJECT source blocks clears it.
  #           lesson DROP/PARTIAL → info, NO remedy. The lesson block is assembled at runtime from the
  #                                CTM/EPM store (build_lesson_block), not extracted from an
  #                                AGENT-INJECT source, so recompression cannot affect it — and lesson
  #                                is the designed lowest-priority first-shed block, i.e. the ceiling
  #                                mechanism working as specified.
  #     PARTIAL is surfaced rather than merely excluded so a future mechanism shift cannot move the
  #     live signal outside the monitored token unnoticed. Verdict shape mirrors §9e (age vs TTL,
  #     three outcomes). Mutation-free.
  local inject_drop_warns=0
  # Must read the SAME root inject-scope-rules.sh writes to: GA_DATA_ROOT/logs (the migrated
  # Tier-A seam = the producer's INJECT_DROP_LOG = HOOK_LOG_DIR) — reader + producer share one root.
  local inject_drop_log="${GA_DATA_ROOT}/logs/inject-scope-rules.diag.log"
  local drop_cutoff="" drop_counts="" win_drop=0 win_lesson=0 win_partial=0 life_events=0
  # A missing window boundary is the §9e un-ageable case: the condition cannot be ESTABLISHED, so the
  # elif below says so loudly instead of falling back to the lifetime total (which would restate the
  # defect this section exists to remove). SC2310/SC2311 disabled for the whole compound — the
  # helper rc IS the branch, and both helpers are stdout-only (Precondition Loud-Fail Principle:
  # the skip is named, never a silent OK).
  # shellcheck disable=SC2310,SC2311
  if [[ ! -f "${inject_drop_log}" ]]; then
    log "  ok   : no inject-scope-rules drop log (no block-shed events)"
  elif ! drop_cutoff="$(_drop_window_cutoff_date "${INJECT_DROP_WINDOW_DAYS}")"; then
    log "  warn : inject-scope-rules drop log present but un-windowable (${inject_drop_log}) — neither 'date -u -v-Nd' nor 'date -u -d \"N days ago\"' works here, so live sheds cannot be separated from history; install a BSD- or GNU-compatible date(1)"
    inject_drop_warns=1
  else
    # Single stdout line, field order `<non-lesson-drop> <lesson-drop> <partial> <lifetime>` — the
    # multi-field verdict-line precedent already used by snapshot_staleness_scan. A failed scan
    # (no awk, unreadable log) or a malformed line is LOUD, never zeroed into a clean OK.
    local drop_counts_re='^[0-9]+ [0-9]+ [0-9]+ [0-9]+$'
    # shellcheck disable=SC2310,SC2311
    if ! drop_counts="$(_inject_drop_scan "${inject_drop_log}" "${drop_cutoff}")" \
      || [[ ! "${drop_counts}" =~ ${drop_counts_re} ]]; then
      log "  warn : inject-scope-rules drop log unclassifiable (${inject_drop_log}) — the awk scan produced no counts, so live sheds cannot be separated from history; check awk(1) and the log's readability"
      inject_drop_warns=1
    else
      # Explicit IFS: the entry point runs under IFS=$'\n\t', which would NOT split this
      # space-separated verdict line into its four fields.
      IFS=' ' read -r win_drop win_lesson win_partial life_events <<<"${drop_counts}"
      if [[ "${win_drop}" -gt 0 ]]; then
        log "  warn : ${win_drop} inject-scope-rules scope-block drop(s) in the last ${INJECT_DROP_WINDOW_DAYS}d (${inject_drop_log}) — a scope block exceeded INJECT_CTX_MAX_BYTES and was NOT injected into subagents; recompress the AGENT-INJECT source blocks"
        inject_drop_warns="${win_drop}"
        local last_drop=""
        # Latest ACTIONABLE row: win_drop > 0 guarantees one exists inside the window, and the newest
        # non-lesson row is at least that recent. SC2312 — the lib carries no file-scope set -e.
        # shellcheck disable=SC2312
        last_drop="$(grep 'inject-scope-rules] DROP ' "${inject_drop_log}" 2>/dev/null | grep -v 'block=lesson ' | tail -n1 || true)"
        [[ -n "${last_drop}" ]] && log "         latest: ${last_drop}"
      fi
      if [[ "${win_lesson}" -gt 0 || "${win_partial}" -gt 0 ]]; then
        log "  info : ${win_lesson} lesson-block drop(s) + ${win_partial} lesson truncation(s) in the last ${INJECT_DROP_WINDOW_DAYS}d — designed shedding of the lowest-priority block; no action (recompression cannot affect a runtime-assembled block)"
      fi
      if [[ "${win_drop}" -eq 0 && "${win_lesson}" -eq 0 && "${win_partial}" -eq 0 ]]; then
        if [[ "${life_events}" -gt 0 ]]; then
          log "  ok   : no inject-scope-rules shed events in the last ${INJECT_DROP_WINDOW_DAYS}d (${life_events} historical event(s) on record in ${inject_drop_log})"
        else
          log "  ok   : no inject-scope-rules block-shed events recorded"
        fi
      fi
    fi
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
    # IFS prefix scopes space+tab splitting to THIS read only — the launcher's strict IFS=$'\n\t'
    # otherwise keeps `shasum -a 256` as one array word → an unrunnable command name.
    # shellcheck disable=SC2310
    IFS=$' \t' read -ra ld_sha < <(_resolve_sha256_cmd) || true
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

  # 12. domain-data separation (D6) — relocation correctness. Asserts the new HOME-anchored runtime
  #     root (GA_DATA_ROOT/data) landed AND warns on stale Tier-A leftovers still under the legacy
  #     claude root. Tier-A-ENUMERATED (never a blanket ~/.claude sweep): the deferred Tier-B monitor
  #     logs + the nested Tier-C data/update stay under ~/.claude by design, so they are NOT in the
  #     enumeration and never false-trip the stale warn. Mutation-free; advisory (warn, never a FAIL —
  #     a not-yet-migrated system is a valid transitional state, remediated by the migration op).
  local data_sep_stale=0
  if [[ -d "${GA_DATA_ROOT}/data" ]]; then
    log "  ok   : runtime data root present at new location (${GA_DATA_ROOT}/data)"
  fi
  # data_sep_leftover_scan logs each stale leftover to stderr + echoes the count (stdout verdict).
  # shellcheck disable=SC2311
  data_sep_stale="$(data_sep_leftover_scan "${TARGET_HOME}")"
  if [[ "${data_sep_stale}" -eq 0 ]]; then
    log "  ok   : no stale Tier-A stores under legacy root (${TARGET_HOME})"
  else
    log "  ---- ${data_sep_stale} stale Tier-A store(s) under ${TARGET_HOME} — run scripts/migrate-claude-to-ga-data.sh to relocate ----"
  fi

  # 13. live recovery-repo snapshot staleness (surfacing complement of scripts/snapshot-live-repos.sh).
  #     The install carries per-directory git repositories whose ONLY job is to be an operator restore
  #     point. The updater is deliberately git-free (zero git invocations in scripts/update.sh, so the
  #     no-.git consumer install stays supported), so a deploy NEVER commits into them: their HEAD
  #     silently falls behind the deployed release and a restore rolls the directory BACKWARD instead of
  #     forward. Surface that drift; the fix is a separate deliberate reconcile run, never a write from
  #     here (mutation-free like every other section — this check stages/commits nothing).
  #     A DIRTY working tree is the AUTHORITATIVE staleness signal: on a clean tree on-disk == index ==
  #     HEAD for every tracked path, so a HEAD-vs-mtime comparison there can only invent false staleness
  #     (a symlink-farm redeploy or a touch flips the sign with byte-identical content) — the recency lag
  #     is therefore a DETAIL line on an already-dirty repo, never an independent verdict.
  #     A repo directory that is absent or carries no .git is the git-less consumer install: reported
  #     not-applicable, never a warn (fail-open). WARN-only either way (doctor still PASSes on §1-12).
  #     A control-character path rides a SECOND counter, never the staleness one: the staleness
  #     remediation IS a snapshot run, and a snapshot no-ops on a file-less pathological tree — folding
  #     it into the stale count would prescribe a fix that cannot work, on the dangerous side.
  local snapshot_stale=0 snapshot_path_anomaly=0 snapshot_counts
  # snapshot_staleness_scan logs each per-repo verdict to stderr + echoes BOTH totals on one stdout
  # line, field order `<stale> <path_anomaly>` (single-line verdict precedent: _resolve_sha256_cmd).
  # shellcheck disable=SC2311
  snapshot_counts="$(snapshot_staleness_scan "${GA_ROOT}")"
  snapshot_stale="${snapshot_counts%% *}"
  snapshot_path_anomaly="${snapshot_counts##* }"
  if [[ "${snapshot_stale}" -eq 0 ]]; then
    log "  ok   : no live recovery-repo snapshot staleness"
  else
    log "  ---- ${snapshot_stale} live recovery repo(s) need a snapshot — run 'bash ${GA_ROOT}/scripts/snapshot-live-repos.sh' (a stale HEAD restores the install BACKWARD) ----"
  fi
  if [[ "${snapshot_path_anomaly}" -ne 0 ]]; then
    log "  ---- ${snapshot_path_anomaly} live recovery repo(s) carry a control-character path (file-less pathological tree) — NOT staleness: a snapshot run would no-op; inspect the path named above and remove the empty tree once verified ----"
  fi

  # 14. autoagent apply-abort surface. daemon-apply.sh loud-fails on two terminal paths and persists
  #     ONE abort row per abort into the daily applied-log JSONL: PRE-gate (exit 16) when the
  #     green-suite gate cannot certify the harness, and POST-gate (exit 7) when the eligible-pending
  #     backlog exceeds the anomaly threshold and the apply loop refuses to drain it. Both carry the
  #     same `abort` literal (why: _apply_abort_scan below); the row's `reason` names which, and the
  #     verdict line reads it to print the matching remedy. That row is the only durable trace of
  #     either: the launchd path discards the daemon's stderr, so without this section an aborted
  #     apply stage is invisible once the cycle ends. FAIL rather than warn — an install whose daemon
  #     has stopped applying is a live condition with a concrete remedy (fix the red suite / drain
  #     the flooded proposal table), not an advisory.
  #     SUPERSESSION, not counting: a later row that is neither an abort nor gate-skipped means a
  #     subsequent cycle got far enough to write one, so the older abort is history. Supersession is
  #     that set rather than a landed patch, because a recovered daemon with nothing eligible to apply
  #     never lands one (see _apply_abort_scan). The verdict is therefore the LAST apply-relevant
  #     event in the window (append-only rows + date-ordered filenames make that a single ordered
  #     scan), never an abort tally — a tally would keep asserting a condition that already cleared.
  local apply_abort_fail=0
  local apply_reports_dir="${DOCTOR_AUTH_REPORTS_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-reports}"
  local abort_cutoff="" abort_scan="" abort_state="" abort_row="" abort_cause=""
  # shellcheck disable=SC2310,SC2311
  if [[ ! -d "${apply_reports_dir}" ]]; then
    log "  ok   : no autoagent daemon-reports dir (no apply cycles recorded)"
  elif ! abort_cutoff="$(_drop_window_cutoff_date "${APPLY_ABORT_WINDOW_DAYS}")"; then
    log "  warn : apply-abort rows present but un-windowable (${apply_reports_dir}) — neither 'date -u -v-Nd' nor 'date -u -d \"N days ago\"' works here, so a live abort cannot be separated from history; install a BSD- or GNU-compatible date(1)"
    apply_abort_fail=1
  else
    # Two stdout lines: the verdict token, then the abort row itself (empty on a non-abort verdict).
    # shellcheck disable=SC2311
    abort_scan="$(_apply_abort_scan "${apply_reports_dir}" "${abort_cutoff}")"
    abort_state="$(printf '%s\n' "${abort_scan}" | sed -n '1p')"
    abort_row="$(printf '%s\n' "${abort_scan}" | sed -n '2p')"
    case "${abort_state}" in
      abort)
        # The two producers need opposite remedies, so the row's `reason` picks the clause: naming
        # the gate on a backlog anomaly sends the operator at a suite that was never red.
        case "${abort_row}" in
          *'"reason":"backlog_anomaly"'*)
            abort_cause="the apply loop refused to drain an eligible-pending backlog above the anomaly threshold; drain or correct core.autoagent_proposals (a generation runaway floods it), then let the next cycle apply"
            ;;
          *)
            abort_cause="the daemon has not reached its apply loop since; fix the named cause, then let the next cycle re-open the gate"
            ;;
        esac
        log "  FAIL : autoagent apply aborted in the last ${APPLY_ABORT_WINDOW_DAYS}d with no later non-abort row to supersede it — a row marked \"gate\":\"skipped\" does not supersede (${apply_reports_dir}) — ${abort_cause}"
        log "         abort row: ${abort_row}"
        apply_abort_fail=1
        ;;
      clean) log "  ok   : autoagent apply abort superseded by a later non-abort row not marked \"gate\":\"skipped\" (last ${APPLY_ABORT_WINDOW_DAYS}d)" ;;
      none) log "  ok   : no autoagent apply aborts in the last ${APPLY_ABORT_WINDOW_DAYS}d" ;;
      *)
        log "  warn : autoagent applied-log unclassifiable (${apply_reports_dir}) — the scan produced no verdict, so an abort cannot be separated from a clean cycle; check awk(1) and the log's readability"
        apply_abort_fail=1
        ;;
    esac
  fi
  [[ "${apply_abort_fail}" -eq 0 ]] || fail=1

  # 15. agent-body merge-decline surface. scripts/update.sh declines a deploy of any agent body whose
  #     EDITABLE-region merge conflicts, keeps the LOCAL body, and persists one entry per decline into
  #     an append-only record — but nothing read that record, so the divergence it names (local body
  #     ahead of the base store) reached an operator only through a deploy line that scrolls past.
  #     FAIL rather than warn on an in-window entry: the decline itself is a CORRECT outcome, yet the
  #     prescribed remedy is a HAND repair (re-apply the local edit onto the new base, then re-sync),
  #     and a warn leaves a prescribed repair permanently optional. The window is what keeps that from
  #     becoming a forever-red: an aged entry is history and reports `note`, never a failure.
  local decline_fail=0
  local decline_log="" decline_cutoff="" decline_scan="" decline_counts="" decline_body=""
  local decline_in=0 decline_out=0 decline_malformed=0
  # shellcheck disable=SC2310,SC2311
  decline_log="$(_decline_record_path)"
  # shellcheck disable=SC2310,SC2311
  if [[ ! -f "${decline_log}" ]]; then
    log "  ok   : no agent-body merge declines recorded (${decline_log})"
  elif ! decline_cutoff="$(_drop_window_cutoff_date "${DECLINE_WINDOW_DAYS}")"; then
    log "  warn : merge-decline entries present but un-windowable (${decline_log}) — neither 'date -u -v-Nd' nor 'date -u -d \"N days ago\"' works here, so an un-repaired decline cannot be separated from history; install a BSD- or GNU-compatible date(1)"
    decline_fail=1
  else
    # Two stdout lines: `<in-window> <out-of-window> <malformed>`, then the first declined body.
    # shellcheck disable=SC2311
    decline_scan="$(_decline_scan "${decline_log}" "${decline_cutoff}")"
    decline_counts="$(printf '%s\n' "${decline_scan}" | sed -n '1p')"
    decline_body="$(printf '%s\n' "${decline_scan}" | sed -n '2p')"
    # Explicit IFS: the entry point runs under IFS=$'\n\t', which would NOT split this
    # space-joined count line (same reason as the §10 drop-count read).
    IFS=' ' read -r decline_in decline_out decline_malformed <<<"${decline_counts}"
    if [[ "${decline_in}" -gt 0 ]]; then
      log "  FAIL : ${decline_in} agent body/bodies declined a merge in the last ${DECLINE_WINDOW_DAYS}d and the local copy was kept (${decline_log}) — the live body is diverged from the base store until it is hand-repaired: re-apply the local edit onto the new base, then re-sync the base store"
      log "         declined body: ${decline_body}"
      decline_fail=1
    elif [[ "${decline_out}" -gt 0 ]]; then
      log "  note : ${decline_out} agent-body merge decline(s) recorded, all older than ${DECLINE_WINDOW_DAYS}d (${decline_log}) — history, not a live divergence (advisory)"
    elif [[ "${decline_malformed}" -eq 0 ]]; then
      # Gated on the malformed count: a record holding ONLY a truncated line is not empty, and
      # reporting it as such would contradict the note the next block emits.
      log "  ok   : merge-decline record present but carries no entries (${decline_log})"
    fi
    # Additive, never a substitute for the verdict above: a truncated entry names no body, so the
    # window and the prescribed repair cannot be derived from it — but it is still an entry the
    # updater wrote, and reporting the record clean over it is the silence this line removes.
    if [[ "${decline_malformed}" -gt 0 ]]; then
      log "  note : ${decline_malformed} merge-decline entry/entries carry fewer than 3 tab-separated fields (${decline_log}) — no body name and no timestamp to age them by; inspect the record by hand"
    fi
  fi
  [[ "${decline_fail}" -eq 0 ]] || fail=1

  # 16. recording-channel liveness — the SECOND surface for the monitor's channel watchdog. The
  #     channel that carried most recorded outcomes once fell to zero and stayed there for over a
  #     day; nothing watched, so the resulting gap read as a quality regression on the dashboard.
  #     The verdict is NOT recomputed here: this section reads `alerting` off
  #     /api/outcomes/channel-liveness and reports the names, so the eligibility floor and the
  #     silence bound have exactly one definition (the route's) rather than two literals that agree
  #     until one is tuned. WARN, never FAIL: the remedy is an investigation of the recorder, and a
  #     quiet channel must not abort an install through the preflight alias.
  #     TWO counters, deliberately not one: `channel_silent` counts channels the route named, while
  #     `channel_blind` counts the distinct condition of this surface being unable to read a verdict
  #     at all. Folding the second into the first would report "1 channel-silent" for a run in which
  #     zero channels are silent and the reader is broken.
  local channel_silent=0 channel_blind=0
  local liveness_port="" liveness_raw="" liveness_code="" liveness_json="" liveness_alerting="" liveness_line=""
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    log "  note : curl or jq absent — recording-channel liveness not read (advisory)"
  elif ! liveness_port="$(atrium_monitor_port 2>/dev/null)"; then
    log "  note : monitor port unresolvable — recording-channel liveness not read (advisory)"
  # No --fail: it collapses every non-2xx into curl's generic failure exit, and the two cases need
  # different reports. A transport failure means the monitor is not answering; a non-2xx means it IS
  # answering and this route is not there — which is a partial deploy, exactly the state a doctor
  # exists to name rather than to disguise as a monitor being down. The status rides on its own
  # trailing line so a body that fails to parse cannot swallow it.
  elif ! liveness_raw="$(curl -s --connect-timeout 2 --max-time 5 -w '\n%{http_code}' \
      "http://127.0.0.1:${liveness_port}/api/outcomes/channel-liveness" 2>/dev/null)"; then
    log "  note : monitor not answering on :${liveness_port} — recording-channel liveness not read (advisory)"
  elif liveness_code="${liveness_raw##*$'\n'}"; liveness_json="${liveness_raw%$'\n'*}";
       [[ "${liveness_code}" != 2[0-9][0-9] ]]; then
    log "  warn : monitor answered HTTP ${liveness_code} for /api/outcomes/channel-liveness on :${liveness_port} — the monitor is up but does not carry this route, so the watchdog's second surface is blind"
    log "         remedy: the deployed monitor predates the route — rebuild and restart it (a stale build, not a silent channel)"
    channel_blind=1
  elif ! liveness_alerting="$(printf '%s' "${liveness_json}" | jq -er '.alerting | join(" ")' 2>/dev/null)"; then
    # jq rc != 0 = no readable `alerting` member: the route's shape moved under this reader, which
    # is itself the watchdog going blind — surface it rather than reading the miss as "none".
    log "  warn : /api/outcomes/channel-liveness carries no readable alerting set — the watchdog's second surface is blind"
    channel_blind=1
  elif [[ -z "${liveness_alerting}" ]]; then
    log "  ok   : no recording channel has gone silent (monitor watchdog reports none alerting)"
  else
    # One line per named channel, every number lifted from the SAME response.
    # shellcheck disable=SC2312
    while IFS= read -r liveness_line; do
      [[ -n "${liveness_line}" ]] || continue
      log "  warn : recording channel silent — ${liveness_line}"
      channel_silent=$((channel_silent + 1))
    done < <(printf '%s' "${liveness_json}" | jq -r '
        .thresholds as $t
        | .days as $d
        | .channels[]
        | select(.alerting)
        | "\(.attribution_source): peak \(.peak_daily_count) rows/day over \($d)d, nothing recorded for \(.silent_hours | floor)h (alerts past \($t.silence_hours)h once a channel exceeds \($t.eligibility_daily_floor)/day)"
      ' 2>/dev/null)
    log "         remedy: the recorder stopped writing through the named channel — check the hook path that feeds it (hooks/track-outcome.sh) before reading the resulting gap as a quality change"
  fi

  if [[ "${fail}" -eq 0 ]]; then
    local warns=$((unbound + drift + undeployed_fresh + inject_drop_warns + launchd_drift + snapshot_stale + snapshot_path_anomaly + data_sep_stale + channel_silent + channel_blind))
    if [[ "${warns}" -eq 0 ]]; then
      log "== doctor: PASS =="
    else
      # `warning(s)` leads the breakdown rather than trailing it. Trailing, it was glued to whichever
      # term happened to be last, so every downstream glob written against that term broke the next
      # time a category was appended (adding channel-silent did exactly that to
      # doctor-launchd-deploy-drift.bats). Leading, every term is `<n> <name>` and none is special.
      log "== doctor: PASS (with ${warns} warning(s): ${unbound} dormant-hook + ${drift} manifest-drift + ${undeployed_fresh} fresh-undeployed + ${inject_drop_warns} inject-drop + ${launchd_drift} launchd-drift + ${snapshot_stale} snapshot-stale + ${snapshot_path_anomaly} snapshot-path-anomaly + ${data_sep_stale} data-sep-leftover + ${channel_silent} channel-silent + ${channel_blind} channel-blind — see above) =="
    fi
    return 0
  fi
  log "== doctor: FAIL =="
  return 1
}

# §10 recency window (days) over the append-only inject-scope-rules shed log. Sized to the SIGNAL'S
# CADENCE, not to the daemon's 14d stale-pattern convention: a shed fires per subagent spawn, so a
# live over-ceiling condition emits tens-to-hundreds of rows per DAY. Seven consecutive days of
# silence is therefore strong evidence the condition ended — a fortnight would keep asserting a
# burst that was remediated a week earlier, which is the defect this section exists to remove.
# Env-overridable so an operator can widen it and a test can pin either side of the boundary.
INJECT_DROP_WINDOW_DAYS="${INJECT_DROP_WINDOW_DAYS:-7}"

# Emit the UTC calendar date $1 days ago as YYYY-MM-DD, or NOTHING with rc 1 when neither date(1)
# dialect is available. BSD (`-v-Nd`) is tried first, then GNU (`-d 'N days ago'`); python3 is
# deliberately not a fallback here because §9e already treats a missing python3 as a live condition.
# The caller branches on the rc — an un-resolvable window is surfaced, never defaulted away.
_drop_window_cutoff_date() {
  local days="${1}"
  date -u -v-"${days}"d +%Y-%m-%d 2>/dev/null && return 0
  date -u -d "${days} days ago" +%Y-%m-%d 2>/dev/null && return 0
  return 1
}

# Classify the inject-scope-rules shed log against a YYYY-MM-DD cutoff. Producer line grammar
# (hooks/inject-scope-rules.sh append_drop_log):
#   <ISO8601Z> [inject-scope-rules] <DROP|PARTIAL> agent=<t> block=<label> pre_drop_bytes=N ceiling=N overage_bytes=N[ kept_bytes=N]
# ISO-8601 dates compare correctly as strings, so the window needs no date arithmetic per row.
# A row whose timestamp field is EMPTY (the producer's date(1) failed, and its ts is fail-open) is
# counted as IN-window: an un-ageable row is surfaced, never silently aged out.
# Args: $1=log path $2=cutoff date · stdout: `<non-lesson-drop> <lesson-drop> <partial> <lifetime>`.
_inject_drop_scan() {
  awk -v cutoff="${2}" '
    index($0, "[inject-scope-rules]") == 0 { next }
    {
      event = ""; block = ""; in_window = 1
      if ($1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) {
        in_window = (substr($1, 1, 10) >= cutoff)
        event = $3
      } else {
        event = $2
      }
      for (i = 1; i <= NF; i++) {
        if (substr($i, 1, 6) == "block=") { block = substr($i, 7) }
      }
      life++
      if (!in_window) { next }
      if (event == "PARTIAL") { partial++ }
      else if (event == "DROP") { if (block == "lesson") { lesson++ } else { actionable++ } }
    }
    END { printf "%d %d %d %d\n", actionable + 0, lesson + 0, partial + 0, life + 0 }
  ' "${1}"
}

# §14 recency window (days) over the daily autoagent applied-log JSONL files. Sized to the SIGNAL'S
# CADENCE like §10, but the cadence is the opposite shape: an apply abort fires at most ONCE per
# daily cycle, so a week of silence is only ~7 possible events and a single abort followed by six
# skipped/failed cycles would age out while the condition still holds. 14 days is the daemon's own
# stale-pattern retention (the agents-bak prune window), which keeps the abort visible for as long as
# the artifacts that would explain it. Env-overridable so a test can pin either side of the boundary.
APPLY_ABORT_WINDOW_DAYS="${APPLY_ABORT_WINDOW_DAYS:-14}"

# Classify the daily applied-log JSONL files under $1 against the YYYY-MM-DD cutoff $2. Producer
# grammar (autoagent/daemon-apply.sh): one JSON object per line carrying a `"status":"<literal>"`
# field. `abort` is the sole abort-class literal, and the axis is the literal itself rather than
# which gate stage produced it: the pre-gate preflight abort (exit 16) and the post-gate
# backlog-anomaly tripwire (exit 7) both write it — two different producer sites, one literal (why
# the tripwire reuses it rather than taking its own: the backlog_anomaly_row header in
# autoagent/daemon-apply.sh). Their `reason` fields separate them for the verdict line.
# Every other literal (applied · skip · reject · needs_regen · dryrun · error) is a non-abort
# literal, and the classifier treats them alike — it keys on the abort/non-abort split rather than
# on `applied` alone: `applied` fires only when a patch actually LANDS, so a recovered daemon with
# nothing eligible emits skips and would hold the verdict red for the rest of the window over a
# condition that already cleared. A non-abort row supersedes unless it carries `"gate":"skipped"`. A
# producer adding a per-patch literal needs no change here; the covering test pins the producer's
# literal set so a NEW literal the abort/non-abort split has not classified fails loudly instead of
# reading as recovery.
# Filenames are autoagent-applied-YYYY-MM-DD.jsonl, so the glob's lexicographic order IS date order
# and the append-only rows inside preserve it — one ordered pass therefore yields the LAST
# apply-relevant event without any date arithmetic per row.
# stdout: line 1 = verdict (`abort` | `clean` | `none`), line 2 = the deciding abort row (empty
# unless the verdict is `abort`). A file whose name carries no parseable date is skipped, never
# guessed into the window.
# `clean` means SUPERSEDED and therefore requires an abort EARLIER in the window: non-abort rows on
# their own supersede nothing, so they are not a recovery. Reporting `clean` for them told every
# install that has never aborted its abort was superseded — daily, and the heartbeat row now
# guarantees such a row on idle cycles too, so that false line would fire on every healthy install.
_apply_abort_scan() {
  local dir="$1" cutoff="$2" f base fdate
  local -a in_window=()
  for f in "${dir}"/autoagent-applied-*.jsonl; do
    [[ -f "${f}" ]] || continue
    base="${f##*/}"
    fdate="${base#autoagent-applied-}"
    fdate="${fdate%.jsonl}"
    [[ "${fdate}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    # `! <` is the bash 3.2-safe form of `>=` for the ISO-8601 string compare.
    [[ ! "${fdate}" < "${cutoff}" ]] || continue
    in_window+=("${f}")
  done
  if [[ "${#in_window[@]}" -eq 0 ]]; then
    printf 'none\n\n'
    return 0
  fi
  # A non-abort row clears only an abort that PRECEDED it (state is non-empty exactly when one did);
  # with nothing to supersede the verdict stays `none`.
  # A row whose `gate` field says `skipped` is a cycle that took a preflight escape hatch, so it
  # verified nothing and supersedes nothing — reading it as a recovery clears real aborts silently.
  # ABSENCE of the field DEFAULTS to superseding, and that polarity is the correctness condition, not
  # a nicety: legacy rows carry none, and five of the six producer statuses will never carry one, so
  # keying on "supersede only when it says cleared" would report every recovered daemon as
  # still-aborted. The producer emits the field on the zero-eligible HEARTBEAT row only, so a
  # skipped-gate cycle that finds work and applies supersedes here too — that scope is deliberate,
  # and this guard narrows the mis-read to the row carrying the evidence rather than closing it on
  # every row a cycle can write. `index` over a match, for BSD/GNU awk parity.
  awk '
    index($0, "\"status\":\"abort\"") { state = "abort"; row = $0; next }
    /"status":"[^"]+"/               {
      if (state != "" && index($0, "\"gate\":\"skipped\"") == 0) { state = "clean"; row = "" }
      next
    }
    END { printf "%s\n%s\n", (state == "" ? "none" : state), row }
  ' "${in_window[@]}"
}

# §15 recency window (days) over the append-only merge-decline record. Sized to the agents-bak
# retention (14d): the prescribed hand repair reads the before-image the updater kept, so once that
# per-run backup is pruned the material the repair needs is gone and a still-open entry is history an
# operator can no longer act on from the record alone. Env-overridable so a test can pin either side.
DECLINE_WINDOW_DAYS="${DECLINE_WINDOW_DAYS:-14}"

# Resolve the merge-decline record path, mirroring the PRODUCER's own derivation
# (scripts/update.sh update_agents_bak_base + update_record_conflict_decline) rather than hardcoding
# a sibling of GA_ROOT: the writer honours AUTOAGENT_BACKUP_DIR, so a reader that ignored it would
# report `absent` on exactly the install that redirected its post-mortem artifacts.
_decline_record_path() {
  local base agents_dir resolved
  if [[ -n "${AUTOAGENT_BACKUP_DIR:-}" ]]; then
    base="${AUTOAGENT_BACKUP_DIR}"
  else
    agents_dir="${GA_ROOT}/agents"
    if resolved="$(cd -- "${agents_dir}" 2>/dev/null && pwd -P)"; then
      agents_dir="${resolved}"
    fi
    base="$(dirname -- "${agents_dir}")/agents-bak"
  fi
  printf '%s\n' "$(dirname -- "${base}")/update-declines/conflict-declines.log"
}

# Classify the merge-decline record $1 against the YYYY-MM-DD cutoff $2. Producer line grammar
# (scripts/update.sh update_record_conflict_decline), tab-separated:
#   <ISO8601Z>\t<resolver verdict>\t<repo-relative body>\tlocal-body-kept\trepair=<hint>
# ISO-8601 dates compare correctly as strings, so the window needs no date arithmetic per row (same
# bash-3.2-safe idiom as _apply_abort_scan). A row whose first field is NOT a timestamp is counted
# IN-window: an un-ageable entry is surfaced, never silently aged out.
# A row carrying FEWER than 3 fields yields neither a body nor a window verdict, so it is COUNTED and
# reported rather than dropped: the entry still testifies to a divergence, and dropping it silently
# would tell an operator the record is clean (Precondition Loud-Fail Principle). A blank separator
# line is not an entry and is not counted.
# stdout: line 1 = `<in-window> <out-of-window> <malformed>`, line 2 = the first in-window body.
_decline_scan() {
  awk -F'\t' -v cutoff="${2}" '
    $0 == "" { next }
    NF < 3 { malformed++; next }
    {
      in_window = 1
      if ($1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/) {
        in_window = (substr($1, 1, 10) >= cutoff)
      }
      if (in_window) { inw++; if (body == "") { body = $3 } }
      else { aged++ }
    }
    END { printf "%d %d %d\n%s\n", inw + 0, aged + 0, malformed + 0, body }
  ' "${1}"
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
#
# MERGE-CLAIMED EXCLUSION. A whole-file hash cannot tell SANCTIONED local evolution from tampering
# on a row the update system merges rather than byte-swaps: the daemon writes learned bullets inside
# an agent body's EDITABLE regions, the operator pins `model:` in its frontmatter (live-only by rule,
# 0 in the repo), and each roster file's live content is a union of vendor rows and live rows by
# design. Every such row read as drift under a remedy that could not clear it, so the content
# comparison is SKIPPED for exactly the paths the merge claims. The claim comes from
# spine_is_merge_claimed_path — the SAME predicate both merge loops iterate through, so a family
# added there is excluded here without a second edit, and no path list is restated in this file.
# Presence and readability are still checked on an excluded row: what the exclusion gives up is the
# tamper signal on vendor-owned content, not the deploy-gap signal.
manifest_hash_drift() {
  local sha_path sha_hash actual abs drift=0 excluded=0
  # The claim predicate's home lib — sourced lazily + source-path agnostic via BASH_SOURCE (mirrors
  # the recovery-repos.sh idiom in snapshot_staleness_scan), so a bats-sourced doctor lib resolves it
  # without the launcher's ga_init_env having run.
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=../scripts/lib/apply-spine.sh
  source "${BASH_SOURCE[0]%/*}/../scripts/lib/apply-spine.sh"
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
    # shellcheck disable=SC2310  # predicate in a condition: disabling set -e there is the point
    if spine_is_merge_claimed_path "${sha_path}"; then
      excluded=$((excluded + 1))
      continue
    fi
    # _sha_hex propagates a sha failure via || return (the assignment rc still trips set -e); SC2311 masking is moot.
    # shellcheck disable=SC2311
    actual="$(_sha_hex "$@" -- "${abs}")"
    [[ "${actual}" != "${sha_hash}" ]] || continue
    log "  warn : manifest DRIFT — content hash mismatch: ${sha_path}"
    drift=$((drift + 1))
  done < <(jq -r '(.hashes // {}) | to_entries[] | "\(.key)\t\(.value)"' -- "${MANIFEST}")
  if [[ "${excluded}" -gt 0 ]]; then
    log "  info : ${excluded} merge-claimed file(s) excluded from the content comparison (designed local evolution, not drift)"
  fi
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

# domain-data separation leftover scan (run_doctor §12 helper — D6). For each Tier-A ENUMERATED
# subpath still present under the legacy claude root ($1), log a stale-leftover warn (stderr, log →
# fd2) and count it; the total is the stdout verdict (mirrors manifest_hash_drift). ENUMERATION-
# scoped, NOT a blanket ~/.claude sweep: the deferred Tier-B monitor logs (logs/monitor.*) and the
# nested Tier-C spine baseline (data/update) are intentionally NOT in the list, so an on-purpose
# deferred path can never false-trip this warn. The enumeration is the shared leaf
# lib/ga-tier-a-subpaths.sh (GA_TIER_A_SUBPATHS), sourced here + by the migration script.
data_sep_leftover_scan() {
  local claude_root="$1"
  local rel stale=0
  # Tier-A enumeration from the shared leaf (SoT) — sourced lazily + idempotently,
  # source-path agnostic via BASH_SOURCE so a standalone-sourced doctor lib (bats
  # fixture) resolves the sibling. Replaces the inline copy formerly synced-by-comment.
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=ga-tier-a-subpaths.sh
  source "${BASH_SOURCE[0]%/*}/ga-tier-a-subpaths.sh"
  for rel in "${GA_TIER_A_SUBPATHS[@]}"; do
    if [[ -e "${claude_root}/${rel}" || -L "${claude_root}/${rel}" ]]; then
      log "  warn : stale Tier-A store under legacy root: ${claude_root}/${rel} — run scripts/migrate-claude-to-ga-data.sh"
      stale=$((stale + 1))
    fi
  done
  printf '%d\n' "${stale}"
}

# newest tracked-file mtime (snapshot_staleness_scan helper) — echoes the max mtime epoch across the
# tracked set of the repo at $1, rc 1 when un-computable (python3 absent / git read failed). python3
# os.stat is the portable mtime idiom the apply-lock lib already uses, NEVER the
# BSD/GNU-divergent `stat -f` / `stat -c`. The program body is captured FIRST and passed via -c so the
# NUL-delimited path list can travel on STDIN (a heredoc body would occupy stdin instead, SC2259), and
# the repo root travels through argv — an exotic path is never interpolated into the program text.
_snapshot_newest_mtime() {
  local repo="$1" py
  command -v python3 >/dev/null 2>&1 || return 1
  py="$(
    cat <<'PY'
import os, sys
root = os.fsencode(sys.argv[1])
newest = 0
for rel in sys.stdin.buffer.read().split(b"\0"):
    if not rel:
        continue
    try:
        mtime = int(os.stat(os.path.join(root, rel)).st_mtime)
    except OSError:
        continue
    if mtime > newest:
        newest = mtime
print(newest)
PY
  )"
  # The entry point's pipefail propagates a failed `git ls-files` into the `|| return 1`, so the
  # rc is NOT actually lost — the mask is visible only to a standalone lint of this sourced lib
  # (which cannot see the caller's strict mode, same reason as the file-header SC2154 disable).
  # shellcheck disable=SC2312
  git -C "${repo}" ls-files -z 2>/dev/null | python3 -c "${py}" "${repo}" 2>/dev/null || return 1
}

# live recovery-repo snapshot staleness scan (run_doctor §13 helper). $1 = the install root holding the
# per-directory recovery repositories. Per WHITELISTED repo, read-only (never stages/commits/writes):
#   * absent dir OR absent .git -> not-applicable info line (git-less consumer install — fail-open).
#   * .git presence ROUTES the git reads (mirrors §8/§9b): a `git -C` on a bare directory inside a
#     source checkout would be answered by the PARENT repo, reporting a tree that is not this one's.
#   * dirty tree (tracked changes vs HEAD, or untracked files) -> STALE warn + the counted verdict,
#     with the HEAD-vs-newest-tracked-mtime lag as a detail line (recency is derived, not independent).
#   * clean tree -> current; no mtime comparison (it could only report false staleness there).
#   * control-character path -> a PATH ANOMALY on its own SECOND counter, never the staleness one:
#     `ls-files --others --directory` sees a FILE-LESS pathological tree that `git status` structurally
#     cannot, such a path corrupts both porcelain parsing and any blanket snapshot stage downstream,
#     and a snapshot run — the staleness remediation — no-ops on a tree that holds no committable file.
#     The scan carries ZERO HEAD dependency and therefore sits ABOVE the commitless gate, whose
#     `continue` would otherwise hide the anomaly on exactly the repo least able to absorb it.
# Each finding is logged to stderr (log -> fd2); the stdout verdict is ONE line carrying BOTH totals in
# the field order `<stale> <path_anomaly>` (one line so a merged-capture reader still reads the last
# one; one function so the seven-repo loop, its .git/absent/git-missing preconditions and its n/a lines
# are not duplicated per counter). A repo is counted at most ONCE PER COUNTER however many findings it
# carries, and the two counters are independent — a dirty repo carrying an anomaly lands in both.
snapshot_staleness_scan() {
  local root="$1"
  local rel repo entry shown changed untracked flagged head_epoch newest lag
  local stale=0 path_anomaly=0 git_warned=0
  # The recovery-repo whitelist — the shared leaf (SoT) the write side
  # (scripts/snapshot-live-repos.sh) reads too, so neither side can go blind to a repo the
  # other reconciles. Sourced lazily + idempotently, source-path agnostic via BASH_SOURCE so
  # a standalone-sourced doctor lib (bats fixture) still resolves it.
  # shellcheck source-path=SCRIPTDIR
  # shellcheck source=../scripts/lib/recovery-repos.sh
  source "${BASH_SOURCE[0]%/*}/../scripts/lib/recovery-repos.sh"
  for rel in "${RECOVERY_REPOS[@]}"; do
    repo="${root}/${rel}"
    if [[ ! -d "${repo}" ]]; then
      log "  info : ${rel} — no such directory (recovery snapshot n/a)"
      continue
    fi
    if [[ ! -e "${repo}/.git" ]]; then
      log "  info : ${rel} — not a git repo (git-less install; recovery snapshot n/a)"
      continue
    fi
    # git is required only once a real .git exists, so a git-less install missing the binary
    # never draws a spurious warn; the skip is loud (Precondition Loud-Fail) but logged once.
    if ! command -v git >/dev/null 2>&1; then
      if [[ "${git_warned}" -eq 0 ]]; then
        log "  warn : recovery-repo staleness scan skipped — git not installed (cannot inspect ${rel} or any further repo)"
        git_warned=1
      fi
      continue
    fi
    flagged=0
    # --directory collapses an untracked tree to its top entry, which is the ONLY way a file-less
    # control-char tree becomes visible at all (git ignores empty directories everywhere else).
    # HEAD-independent, so it runs BEFORE the commitless gate whose `continue` would skip it.
    # shellcheck disable=SC2312
    while IFS= read -r -d '' entry; do
      [[ -n "${entry}" ]] || continue
      [[ "${entry}" == *[[:cntrl:]]* ]] || continue
      # printf %q so the log line cannot itself be broken by the embedded control character.
      shown="$(printf '%q' "${entry}")"
      log "  warn : ${rel} — control-character path, unsafe for a blanket snapshot stage (path anomaly, NOT snapshot staleness): ${shown}"
      flagged=1
    done < <(git -C "${repo}" ls-files --others --directory --exclude-standard -z 2>/dev/null || true)
    # Counted OUTSIDE the clean/dirty branch, on a condition evaluated independently of the staleness
    # one — that disjointness is what keeps either finding from masking the other.
    [[ "${flagged}" -eq 0 ]] || path_anomaly=$((path_anomaly + 1))
    # An initialized-but-commitless repo has nothing to restore TO — its own anomaly class, and
    # `diff HEAD` below would fail on it. A snapshot run IS the remediation here, so it counts as
    # stale even when the same repo already carried a path anomaly.
    if ! git -C "${repo}" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      log "  warn : ${rel} — recovery repo has no commit yet (nothing to restore to) — run scripts/snapshot-live-repos.sh"
      stale=$((stale + 1))
      continue
    fi
    changed=0
    # NUL-delimited reads throughout: a path may legitimately contain whitespace, and the anomaly
    # scan above exists precisely because one may contain a newline. `|| true` keeps a git read
    # failure from aborting the enclosing command substitution; an empty stream reads as no findings.
    # shellcheck disable=SC2312
    while IFS= read -r -d '' entry; do
      [[ -n "${entry}" ]] || continue
      changed=$((changed + 1))
    done < <(git -C "${repo}" diff --name-only -z HEAD 2>/dev/null || true)
    untracked=0
    # shellcheck disable=SC2312
    while IFS= read -r -d '' entry; do
      [[ -n "${entry}" ]] || continue
      untracked=$((untracked + 1))
    done < <(git -C "${repo}" ls-files --others --exclude-standard -z 2>/dev/null || true)
    # The ok line is UNCONDITIONAL: the untracked count above reads `ls-files --others` WITHOUT
    # --directory, which recurses into an untracked tree, so a control-char tree holding any
    # committable file inflates `untracked` and routes here to STALE. Reaching this branch therefore
    # ENTAILS that whatever the anomaly scan flagged holds no file — the snapshot really is current.
    if [[ "${changed}" -eq 0 && "${untracked}" -eq 0 ]]; then
      log "  ok   : ${rel} recovery snapshot current (clean tree — HEAD matches on-disk)"
      continue
    fi
    log "  warn : ${rel} recovery snapshot STALE — ${changed} uncommitted tracked change(s), ${untracked} untracked file(s); a restore would roll this directory BACKWARD — run scripts/snapshot-live-repos.sh"
    stale=$((stale + 1))
    # Recency DETAIL on an already-stale repo (AC-3 as a derived property, never its own verdict).
    # Both reads are advisory: a masked failure degrades to the un-ageable note, never to a false ok.
    head_epoch="$(git -C "${repo}" log -1 --format=%ct 2>/dev/null || true)"
    # `|| true` keeps an un-computable mtime (no python3) from aborting under the caller's set -e;
    # the empty capture then falls through to the "unavailable" note below, never to a false ok.
    # shellcheck disable=SC2310,SC2311
    newest="$(_snapshot_newest_mtime "${repo}" || true)"
    if [[ "${head_epoch}" =~ ^[0-9]+$ && "${newest}" =~ ^[0-9]+$ ]]; then
      lag=$((newest - head_epoch))
      if [[ "${lag}" -gt 0 ]]; then
        log "         HEAD trails the newest tracked-file mtime by ${lag}s (snapshot recency lag)"
      fi
    else
      log "         recency lag unavailable (python3 missing or the tracked set is unreadable)"
    fi
  done
  printf '%d %d\n' "${stale}" "${path_anomaly}"
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
