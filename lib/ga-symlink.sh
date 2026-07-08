# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (GA_ROOT/TARGET_HOME/MANIFEST/SYMLINK_EXCLUDE_*/COLLISION_*/DRY_RUN/SCAN_ONLY) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — symlink-farm build + manifest link/dir management domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# manifest parsing
# manifest.json shape: { "files": ["agents/foo.md", "rules/bar.md", ...] }
# Emits one shipped relative path per line.
read_manifest_files() {
  command -v jq >/dev/null 2>&1 || die "jq required to parse ${MANIFEST}"
  [[ -f "${MANIFEST}" ]] || die "manifest not found: ${MANIFEST}"
  jq -r '.files[]' -- "${MANIFEST}"
}

# collision scope query
# Echo "yes" when a target-relative path falls under a collision-checked
# component dir (agents/ or skills/) — the components the dropped plugin layer
# would have auto-namespaced. Else "no". Stdout-verdict (always exits 0) so the
# ERR trap never fires, mirroring is_never_touch / is_hook_bound.
is_collision_scope() {
  local rel="$1"
  local prefix
  for prefix in "${COLLISION_SCOPE_PREFIXES[@]}"; do
    case "${rel}" in
      "${prefix}"*)
        printf 'yes\n'
        return 0
        ;;
      *) ;; # not this prefix — keep scanning
    esac
  done
  printf 'no\n'
}

# symlink-farm exclusion query
# Echo "yes" when a manifest-relative path is INSTALL-INTERNAL — bundled + hash-
# verified but consumed in place from ~/.glass-atrium and therefore never
# symlinked into ~/.claude (SYMLINK_EXCLUDE_PREFIXES / SYMLINK_EXCLUDE_EXACT).
# Else "no". Stdout-verdict (always exits 0) so the ERR trap never fires,
# mirroring is_never_touch / is_collision_scope. Applied at every symlink-farm
# WRITE site (run_symlink_farm create, remove_manifest_links remove); the doctor
# §4 source-presence check deliberately does NOT use it (it still verifies the
# bundle actually shipped lib/ etc.).
is_symlink_excluded() {
  local rel="$1"
  local prefix exact
  for prefix in "${SYMLINK_EXCLUDE_PREFIXES[@]}"; do
    case "${rel}" in
      "${prefix}"*)
        printf 'yes\n'
        return 0
        ;;
      *) ;; # not this prefix — keep scanning
    esac
  done
  for exact in "${SYMLINK_EXCLUDE_EXACT[@]}"; do
    if [[ "${rel}" == "${exact}" ]]; then
      printf 'yes\n'
      return 0
    fi
  done
  printf 'no\n'
}

# H-3 atomic per-file symlink swap
# Creates TARGET_HOME/<rel> as a symlink -> GA_ROOT/<rel>.
# Idempotent: skips when the correct symlink already exists.
# Coexistence: refuses to overwrite a non-symlink user file or a foreign symlink.
# Collision detection (agents/skills): a DIFFERENT same-named NON-symlink user
# file under agents/ or skills/ is WARN+skip (or prompt with --collision-prompt),
# never overwritten — the uniform-farm substitute for plugin auto-namespacing.
# Returns 0 on link/skip-correct, 2 on a collision skip (caller tallies it).
swap_symlink() {
  local rel="$1"
  local src="${GA_ROOT}/${rel}"
  local dst="${TARGET_HOME}/${rel}"
  local dst_dir
  dst_dir="$(dirname -- "${dst}")"

  # never-touch guard (defense in depth — manifest should never list these)
  # is_never_touch returns 0 by contract (stdout verdict) → masking is intentional.
  # SC2311 (not SC2310) fires here because the lib has NO file-scope `set -e`
  # (sourced-only, the caller arms it) — same intentional masking, different code.
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_never_touch "${rel}")" == "yes" ]]; then
    die "refusing to touch never-touch path: ${rel}"
  fi

  [[ -e "${src}" ]] || die "manifest source missing: ${src}"

  # ensure the target subdirectory exists (per-file farm coexists with user dirs)
  if [[ ! -d "${dst_dir}" ]]; then
    "${DRY_RUN}" || mkdir -p -- "${dst_dir}"
  fi

  # idempotency: already the correct symlink → skip
  if [[ -L "${dst}" ]]; then
    local cur
    cur="$(readlink -- "${dst}")"
    if [[ "${cur}" == "${src}" ]]; then
      log "skip (already correct): ${rel}"
      return 0
    fi
    # a foreign symlink (points elsewhere) — could be the user's own. Refuse.
    if [[ "${cur}" != "${GA_ROOT}/"* ]]; then
      die "refusing to overwrite foreign symlink not into GA root: ${dst} -> ${cur}"
    fi
    # a stale GA symlink (points into GA but wrong rel) → safe to re-swap
  elif [[ -e "${dst}" ]]; then
    # a real user file with the same basename. For collision-scoped components
    # (agents/ skills/) this is a basename COLLISION: WARN + skip (or prompt),
    # never overwrite — the uniform-farm replacement for plugin namespacing.
    # is_collision_scope returns 0 by contract (stdout verdict) → masking intentional
    # (SC2311 = the sourced-lib analog of SC2310; no file-scope set -e here)
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_collision_scope "${rel}")" == "yes" ]]; then
      log "COLLISION: a different user file already exists at ${dst} (not our symlink)"
      if "${COLLISION_PROMPT}"; then
        local reply=""
        # interactive prompt — only honoured when a tty is attached; otherwise
        # fall through to the safe default (skip), never blocking a scripted run.
        if [[ -t 0 ]]; then
          printf 'Overwrite user file with the Atrium symlink? [y/N]: ' >&2
          read -r reply || reply=""
        fi
        case "${reply}" in
          y | Y)
            log "  collision: user chose OVERWRITE — moving ${dst} to .ga-collision backup"
            mv -f -- "${dst}" "${dst}.ga-collision.$(date +%Y%m%d-%H%M%S)"
            ;;
          *)
            log "  collision: skipping ${rel} (user file preserved)"
            return 2
            ;;
        esac
      else
        log "  collision: skipping ${rel} (user file preserved; pass --collision-prompt to choose)"
        return 2
      fi
    else
      # outside collision scope — coexistence still demands hard refusal.
      die "refusing to symlink-over existing non-symlink user file: ${dst}"
    fi
  fi

  # dry-run stops here (no symlink write, no launchd) — staging report only
  if "${DRY_RUN}"; then
    log "dry-run would link: ${dst} -> ${src}"
    return 0
  fi

  # H-3 — atomic rename by construction: ln -s into .tmp (co-located in dst_dir, so
  # STAGE_TMP and dst always share st_dev) then mv -f over dst. The rename(2) is
  # unconditionally same-device atomic by this construction — no st_dev assertion
  # is needed (and the symlink TARGET's device is irrelevant: a symlink stores its
  # target only as a path string, never copying the target's data).
  STAGE_TMP="${dst}.ga-tmp.$$"
  ln -s -- "${src}" "${STAGE_TMP}"

  mv -f -- "${STAGE_TMP}" "${dst}"
  STAGE_TMP=""
  log "linked: ${rel}"
}

# single-link removal (target-verified)
# Removes the given absolute path ONLY if it is a symlink whose readlink target
# resolves into GA_ROOT. Real files + foreign symlinks + never-touch are skipped.
# Returns 0 when removed, 1 when (safely) skipped.
remove_if_ga_link() {
  local link="$1"
  # target-relative path for the never-touch guard
  local rel="${link#"${TARGET_HOME}/"}"

  # is_never_touch is a STDOUT-verdict helper (always exits 0) → branch on its
  # "yes"/"no" string, not on $? (which is always 0). Consumed as
  # `[[ "$(is_never_touch ...)" == "yes" ]]` — capturing $? here
  # misclassified every path as protected and skipped all removals.
  # is_never_touch returns 0 by contract (stdout verdict) → masking is intentional
  # (SC2311 = the sourced-lib analog of SC2310; no file-scope set -e here)
  # shellcheck disable=SC2310,SC2311,SC2312
  if [[ "$(is_never_touch "${rel}")" == "yes" ]]; then
    log "skip (never-touch): ${rel}"
    return 1
  fi

  # MUST be a symlink — never remove a real user file
  if [[ ! -L "${link}" ]]; then
    log "skip (not a symlink): ${link}"
    return 1
  fi

  # verify the link target points INTO the GA root before any rm
  local tgt
  tgt="$(readlink -- "${link}")"
  if [[ "${tgt}" != "${GA_ROOT}/"* ]]; then
    log "skip (foreign symlink): ${link} -> ${tgt}"
    return 1
  fi

  if "${SCAN_ONLY}"; then
    log "orphan-scan: GA symlink ${link} -> ${tgt}"
    return 0
  fi

  # DRY_RUN log-and-skip: a "dry-run" MUST perform ZERO mutations. Skip the rm
  # under EITHER SCAN_ONLY (above) OR DRY_RUN, while keeping SCAN_ONLY's own
  # branch + message intact. Return 0 (like the SCAN_ONLY skip) so the caller's
  # removed-counter reports the would-remove count accurately.
  if "${DRY_RUN}"; then
    log "dry-run: would remove ${rel} -> ${tgt}"
    return 0
  fi

  rm -f -- "${link}"
  log "removed: ${rel} -> ${tgt}"
  return 0
}

# manifest-driven removal
remove_manifest_links() {
  command -v jq >/dev/null 2>&1 || die "jq required to parse ${MANIFEST}"
  [[ -f "${MANIFEST}" ]] || {
    log "manifest absent (${MANIFEST}) — skipping manifest pass (orphan sweep still runs)"
    return 0
  }
  local rel removed=0 rc
  # jq output streamed via process substitution → loop stays in current shell.
  # shellcheck disable=SC2312
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    # install-internal payload was never symlinked (see run_symlink_farm) → there
    # is nothing to remove; skip it symmetrically so the removed-count stays
    # accurate. (stdout verdict, always exits 0 → SC2311 masking intentional.)
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_symlink_excluded "${rel}")" == "yes" ]]; then
      continue
    fi
    # A return 1 from remove_if_ga_link is a SAFE SKIP, not an error, so set -e
    # must not abort on it. Bracket the single call with set +e/set -e (the
    # SC2310-clean idiom) and capture rc, then branch. Also suspend the ERR trap
    # for the call (set -E propagates it into the callee, so the safe-skip
    # `return 1` would otherwise print a spurious ERROR line) and restore it.
    set +e
    trap - ERR
    remove_if_ga_link "${TARGET_HOME}/${rel}"
    rc=$?
    trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
    set -e
    [[ "${rc}" -eq 0 ]] && removed=$((removed + 1))
  done < <(jq -r '.files[]' -- "${MANIFEST}")
  log "manifest pass: ${removed} GA symlink(s) removed"
}

# orphan sweep (catch GA links not in the manifest)
# find every symlink under the target whose link-target glob is GA_ROOT/* —
# each is still target-verified inside remove_if_ga_link before any rm.
sweep_orphans() {
  [[ -d "${TARGET_HOME}" ]] || return 0
  local link removed=0 rc
  # find ends with `|| true` → masked exit benign; loop stays in current shell.
  # shellcheck disable=SC2312
  while IFS= read -r link; do
    [[ -n "${link}" ]] || continue
    # return 1 = safe skip — bracket the single call with set +e/set -e, and
    # suspend the ERR trap (set -E propagates it into the callee, so the safe-skip
    # `return 1` would otherwise print a spurious ERROR line) then restore it.
    set +e
    trap - ERR
    remove_if_ga_link "${link}"
    rc=$?
    trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
    set -e
    [[ "${rc}" -eq 0 ]] && removed=$((removed + 1))
  done < <(find "${TARGET_HOME}" -type l -lname "${GA_ROOT}/*" 2>/dev/null || true)
  "${SCAN_ONLY}" || log "orphan sweep: ${removed} extra GA symlink(s) removed"
}

# GA-created empty-directory cleanup (install/uninstall symmetry)
# INVERSE of the symlink farm's per-file `mkdir -p` (swap_symlink): once the
# symlink-removal passes (remove_manifest_links + sweep_orphans) have unlinked
# every GA symlink, the DIRECTORY skeletons the farm created (agents/, hooks/,
# skills/<name>/, agents/references/, ...) are left behind EMPTY. This removes
# exactly those — and ONLY when empty — so a clean uninstall leaves NO orphan GA
# dir skeletons, matching the install side that creates each one.
#
# SAFETY INVARIANT (why this can NEVER delete user content):
#   * `rmdir` removes ONLY an EMPTY directory — a dir still holding ANY user file
#     makes rmdir FAIL (non-zero), so a user file dropped into a GA dir keeps that
#     dir alive. This is the whole safety story; NEVER `rm -rf` (which would
#     recurse into user content) — see the dev-shell rm-rf guardrail.
#   * the candidate set is DERIVED from the manifest (read_manifest_dirs: the
#     ancestor dirs of every FARMED file), so only dirs the farm itself created
#     are ever considered — never an arbitrary target subtree.
#   * DEEPEST-FIRST order (read_manifest_dirs lists a descendant before its
#     ancestor) so a parent is attempted only AFTER its children were removed —
#     an emptied parent then rmdirs too, a still-occupied one fails safely.
#   * TARGET_HOME itself is NEVER a candidate (top-level manifest files map to the
#     boundary and are dropped by read_manifest_dirs); the never-touch guard is a
#     second line of defense.
# Honors DRY_RUN (report-only). Mirrors remove_manifest_links/sweep_orphans style.
remove_empty_dirs() {
  command -v jq >/dev/null 2>&1 || die "jq required to parse ${MANIFEST}"
  [[ -f "${MANIFEST}" ]] || {
    log "manifest absent (${MANIFEST}) — skipping empty-dir cleanup"
    return 0
  }
  [[ -d "${TARGET_HOME}" ]] || return 0

  local reldir abs removed=0 kept=0
  # read_manifest_dirs streams deepest-first via process substitution → the loop
  # stays in the current shell (counter-safe). SC2312: its exit is masked but
  # benign (it dies on its own precondition failure).
  # shellcheck disable=SC2312
  while IFS= read -r reldir; do
    [[ -n "${reldir}" ]] || continue
    # never-touch guard (defense in depth — a manifest dir should never be one).
    # is_never_touch is a stdout verdict (always exits 0) → SC2311 masking is
    # intentional (no file-scope set -e in this sourced lib).
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_never_touch "${reldir}")" == "yes" ]]; then
      log "skip (never-touch dir): ${reldir}"
      continue
    fi
    abs="${TARGET_HOME}/${reldir}"
    # a REAL directory only — never a symlink-to-dir (`! -L`), never an absent path
    [[ -d "${abs}" && ! -L "${abs}" ]] || continue
    if "${DRY_RUN}"; then
      log "dry-run: would rmdir GA dir if empty: ${reldir}"
      continue
    fi
    # rmdir removes ONLY an empty dir; a non-empty (user content) dir makes it fail
    # → SAFE skip. The `if` condition masks BOTH set -e and the ERR trap for that
    # expected non-zero, so no set +e/trap bracketing is needed here.
    if rmdir -- "${abs}" 2>/dev/null; then
      log "removed empty GA dir: ${reldir}"
      removed=$((removed + 1))
    else
      kept=$((kept + 1))
    fi
  done < <(read_manifest_dirs)

  if "${DRY_RUN}"; then
    log "empty-dir cleanup: dry-run — reported candidate GA dirs (no rmdir performed)"
  else
    log "empty-dir cleanup: ${removed} empty GA dir(s) removed, ${kept} kept (non-empty/user content)"
  fi
}

# manifest-derived directory set (deepest-first) — callee of remove_empty_dirs
# Emit every ANCESTOR directory (TARGET_HOME-relative) of every FARMED manifest
# file — i.e. the dirs swap_symlink's `mkdir -p` created — DEEPEST-FIRST and
# deduped, so the caller can rmdir children before parents.
#   * install-internal entries (is_symlink_excluded: lib/, monitor/, ...) are
#     skipped — they are never symlinked in, so their dirs are never GA-created.
#   * a top-level file (no '/') contributes NOTHING: its only parent IS
#     TARGET_HOME, the boundary this must never emit (safety).
# Deepest-first == reverse byte-order sort: an ancestor is always a proper string
# prefix of its descendant, so a reverse `LC_ALL=C sort` lists every descendant
# before its ancestor — the exact rmdir-children-before-parents invariant.
read_manifest_dirs() {
  local rel dir
  # read_manifest_files dies on its own precondition failure → masked exit benign;
  # the pipe subshell only emits to stdout (no vars read after) so it is var-safe.
  # shellcheck disable=SC2312
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    # install-internal payload → dir never GA-created. is_symlink_excluded is a
    # stdout verdict (exits 0) → SC2311 masking intentional (no file-scope set -e).
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_symlink_excluded "${rel}")" == "yes" ]]; then
      continue
    fi
    # no '/' → top-level file: only parent is TARGET_HOME (boundary) → emit nothing
    [[ "${rel}" == */* ]] || continue
    dir="${rel%/*}"
    # walk the ancestor chain up to (never including) TARGET_HOME
    while [[ -n "${dir}" && "${dir}" != "." ]]; do
      printf '%s\n' "${dir}"
      [[ "${dir}" == */* ]] || break
      dir="${dir%/*}"
    done
  done < <(read_manifest_files) | LC_ALL=C sort -ru
}

# shared per-file symlink farm
# The manifest-driven symlink-farm loop shared by run_install and
# run_agents_only. <label> distinguishes the two log-line prefixes
# ("install" vs "agents-only"); the swap/collision/rc contract is identical, so
# it lives here once (a change to the swap semantics or a new rc code lands in a
# single place). Honours TARGET_HOME + DRY_RUN via swap_symlink.
run_symlink_farm() {
  local label="$1"

  log "== ${label}: per-file symlink farm (target=${TARGET_HOME}) =="
  "${DRY_RUN}" && log "(dry-run: staging only — no symlink/launchd writes)"

  local rel count=0 collisions=0 rc
  # read_manifest_files dies on its own failure → masked exit is benign;
  # process substitution keeps the loop in the current shell (var-safe).
  # shellcheck disable=SC2312
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    # install-internal payload (lib/ engine, config template, requirements) is
    # bundled + hash-verified but consumed in place from GA_ROOT — never a
    # ~/.claude symlink. Skip it here (is_symlink_excluded is a stdout verdict,
    # always exits 0 → SC2311 masking is intentional; no file-scope set -e).
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_symlink_excluded "${rel}")" == "yes" ]]; then
      log "skip (install-internal, not symlinked): ${rel}"
      continue
    fi
    # swap_symlink returns 2 on a collision SKIP (a safe non-error outcome), so
    # set -e must not abort. Bracket the single call with set +e/set -e (the
    # SC2310-clean idiom) and branch on rc. Also suspend the ERR trap for the
    # call (set -E propagates it into the callee, so the safe-skip non-zero
    # return would otherwise print a spurious ERROR line) and restore it.
    set +e
    trap - ERR
    swap_symlink "${rel}"
    rc=$?
    trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR
    set -e
    if [[ "${rc}" -eq 2 ]]; then
      collisions=$((collisions + 1))
    elif [[ "${rc}" -ne 0 ]]; then
      die "swap_symlink failed (rc=${rc}) for ${rel}"
    fi
    count=$((count + 1))
  done < <(read_manifest_files)

  log "== ${label}: ${count} manifest entries processed (${collisions} collision skip(s)) =="
}
