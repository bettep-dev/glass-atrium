#!/usr/bin/env bash
# install.sh — the one-line bootstrap for Glass Atrium.
#
#   curl -fsSL <raw-url>/install.sh | bash
#
# DOWNLOADS the latest release bundle and EXTRACTS it into ~/.glass-atrium (a plain
# tree, NO .git), then hands off to the interactive launcher (./glass-atrium), which
# owns every real install step + its own consent/auth gates. Safe both piped
# (curl|bash — stdin is the pipe, NOT the terminal) and run as a file, independent of
# its own on-disk location.
#
# No git: integrity is a PER-FILE SHA-256 check of every extracted file against the
# release manifest.hashes (reusing scripts/lib/apply-spine.sh, sourced post-extract).
# The extracted tree IS the runtime — the symlink farm points ~/.claude/<rel> INTO it
# and the harness updates in place, so moving/deleting the tree breaks the links.
#
# Additive by design: extract writes ONLY verified bundle members, NEVER
# `rm -rf ~/.glass-atrium`, so a re-install preserves runtime data (agents-bak/, wiki/,
# secrets/, data/, config.toml, .update-state) byte-intact. Idempotent on the persisted
# install manifest {version}: unchanged → no-op, changed → extract in place.
#
# SECURITY: handles NO tokens/secrets, reads no .env, echoes no credentials, and
# runs no third-party `curl | sh`. It downloads a GitHub Release asset via `gh`
# (authenticated), verifies it per-file, extracts it, and launches; nothing else.
#
# Environment overrides (all optional):
#   GA_RELEASE_REPO   GitHub release repo slug <owner>/<repo> to install from
#                     (default: bettep-dev/glass-atrium; also honors
#                     ATRIUM_RELEASE_REPO — the codebase-wide release env var).
#   GA_RELEASE_TAG    pin a specific release tag (default: empty = latest release)
#   GA_DIR            extract target (default: ~/.glass-atrium — see the symlink
#                     farm constraint above; only override for a sandbox/test)
#   GA_NO_RUN         when non-empty, install only + print the run hint (CI/testing)
#   GA_INSTALL_SRC_BUNDLE + GA_INSTALL_SRC_MANIFEST
#                     TEST SEAM — when BOTH are set, install from a local bundle +
#                     manifest verbatim (skip gh/network). This is how the PHASE-2
#                     acceptance test drives a real end-to-end no-.git install.
#
# Exit codes (named, loud-fail — no silent precondition absorption):
#   0   success (installed and either handed off or printed the run hint)
#   10  not macOS
#   11  a required tool (gh / tar / jq / shasum) is not on PATH
#   12  GA_RELEASE_REPO not configured / not an <owner>/<repo> slug
#   13  GA_DIR exists with foreign content (not a Glass Atrium install; refuse to clobber)
#   14  release download failed / expected assets missing
#   15  per-file SHA-256 verification failed (corrupt/tampered download)
#   16  launcher missing or not executable after extract
#   17  bundle extraction / tree write failed
#   18  mirror-farm refresh failed (reinstall path: files installed, but the
#       ~/.claude facade mirror was NOT refreshed — run `glass-atrium agents-only`)
#
# HARD CONSTRAINT: stock macOS bash 3.2 + BSD coreutils only (no mapfile, no
# associative arrays, no GNU-only flags).
set -Eeuo pipefail
IFS=$'\n\t'

# named exit codes
readonly EXIT_NOT_MACOS=10
readonly EXIT_MISSING_TOOL=11
readonly EXIT_NO_RELEASE_REPO=12
readonly EXIT_DIR_CONFLICT=13
readonly EXIT_DOWNLOAD_FAILED=14
readonly EXIT_VERIFY_FAILED=15
readonly EXIT_NO_LAUNCHER=16
readonly EXIT_EXTRACT_FAILED=17
readonly EXIT_FARM_FAILED=18

# parameters (env-overridable)
# The release repo slug is a REAL wired default (the one-liner installs with zero env
# config); GA_RELEASE_REPO overrides it, ATRIUM_RELEASE_REPO honored for parity.
readonly GA_RELEASE_REPO_DEFAULT="bettep-dev/glass-atrium"
GA_RELEASE_REPO="${GA_RELEASE_REPO:-${ATRIUM_RELEASE_REPO:-${GA_RELEASE_REPO_DEFAULT}}}"
GA_RELEASE_TAG="${GA_RELEASE_TAG:-}"
GA_DIR="${GA_DIR:-${HOME}/.glass-atrium}"
GA_NO_RUN="${GA_NO_RUN:-}"

# run state (global for the EXIT-trap cleanup)
# The download/verify/merge scratch tree. Declared here so the trap sees a defined
# origin under strict mode and cleans it on ANY early-exit path.
_ga_workdir=""

# leaf logging (stderr only; mirrors lib/ga-core.sh)
# Progress/diagnostics go to stderr so they never collide with a future exec of
# the launcher and stay visible under curl|bash.
log() { printf '%s\n' "$*" >&2; }
# die <exit_code> <message...> — loud-fail with a NAMED exit code (Precondition
# Loud-Fail principle: every unmet precondition gets a distinct code + message).
die() {
  local code="$1"
  shift
  printf 'FATAL: %s\n' "$*" >&2
  exit "${code}"
}

# Single idempotent cleanup: remove ONLY the scratch tree this run created. The
# successful hand-off path cleans it explicitly BEFORE exec (exec never returns, so
# the EXIT trap would not fire there); this trap covers every early-failure path.
cleanup() {
  local rc=$?
  if [[ -n "${_ga_workdir}" && -d "${_ga_workdir}" ]]; then
    rm -rf -- "${_ga_workdir}"
    _ga_workdir=""
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM
trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# tool preconditions (loud-fail, no silent 2>/dev/null swallowing)
require_tool() {
  command -v "$1" >/dev/null 2>&1 \
    || die "${EXIT_MISSING_TOOL}" "required tool not found: $1 — install it and re-run."
}

# A SHA-256 tool is needed by the reused spine verify (shasum on macOS, sha256sum
# on GNU); loud-fail when neither is present rather than a silent verify skip.
require_sha256() {
  command -v shasum >/dev/null 2>&1 && return 0
  command -v sha256sum >/dev/null 2>&1 && return 0
  die "${EXIT_MISSING_TOOL}" "no SHA-256 tool (shasum/sha256sum) on PATH — install one and re-run."
}

# preflight (loud-fail)
# Verify the hard preconditions before touching the filesystem: macOS + the tools
# the download/verify/extract needs. (gh is required only on the network path and
# is checked in fetch_release, so the local-bundle test seam needs no gh.)
preflight() {
  local os
  os="$(uname -s)"
  [[ "${os}" == "Darwin" ]] \
    || die "${EXIT_NOT_MACOS}" "Glass Atrium requires macOS (detected: ${os})."
  require_tool tar
  require_tool jq
  require_sha256
}

# foreign-dir guard (no-rm-rf clobber refusal, keyed on the manifest)
# Fail fast BEFORE downloading: an existing GA_DIR that is neither empty nor a
# recognized Glass Atrium install (no root manifest.json) is foreign content — the
# persisted install manifest is the sole "this is ours" signal (no git origin to
# compare in a no-.git flow). NEVER rm -rf the target (no-rm-rf clobber refusal).
assert_installable_target() {
  [[ -e "${GA_DIR}" ]] || return 0 # absent → fresh install
  if [[ ! -d "${GA_DIR}" ]]; then
    die "${EXIT_DIR_CONFLICT}" "${GA_DIR} exists and is not a directory — move it aside or set GA_DIR."
  fi
  # A managed install (carries the persisted install manifest) → idempotency in
  # install_tree decides no-op vs extract-in-place.
  [[ -f "${GA_DIR}/manifest.json" ]] && return 0
  # No manifest: allowed ONLY when the dir is empty (safe to extract into).
  if [[ -n "$(ls -A -- "${GA_DIR}" 2>/dev/null || true)" ]]; then
    log "${GA_DIR} exists, is not empty, and is not a Glass Atrium install (no manifest.json)."
    log "Refusing to overwrite it. Move it aside, or set GA_DIR to a different path."
    die "${EXIT_DIR_CONFLICT}" "${GA_DIR} exists with foreign content."
  fi
}

# download + extract the release bundle
# Fetch manifest.json + glass-atrium-bundle-<version>.tar.gz into $1 (download dir),
# extract the bundle into $2 (scratch new-release tree). The gh asset patterns MIRROR
# update.sh::update_fetch_release rather than sourcing it — on a fresh curl|bash
# install nothing is on disk yet, so the updater's libs can't be sourced pre-download.
fetch_release() {
  local dl_dir="$1" new_tree="$2" slug bundle

  # TEST SEAM — both set → a locally-built bundle + manifest are used verbatim,
  # skipping gh/network entirely (mirrors update.sh's ATRIUM_UPDATE_SRC_* seam), so
  # the PHASE-2 acceptance test can exercise a real no-.git install hermetically.
  if [[ -n "${GA_INSTALL_SRC_BUNDLE:-}" && -n "${GA_INSTALL_SRC_MANIFEST:-}" ]]; then
    log "Installing from a local release bundle (test seam): ${GA_INSTALL_SRC_BUNDLE}"
    cp -- "${GA_INSTALL_SRC_MANIFEST}" "${dl_dir}/manifest.json" \
      || die "${EXIT_DOWNLOAD_FAILED}" "cannot read the local manifest: ${GA_INSTALL_SRC_MANIFEST}"
    tar -xzf "${GA_INSTALL_SRC_BUNDLE}" -C "${new_tree}" \
      || die "${EXIT_EXTRACT_FAILED}" "cannot extract the local bundle: ${GA_INSTALL_SRC_BUNDLE}"
    return 0
  fi

  # NETWORK path. Resolve + sanity-check the release repo slug (<owner>/<repo>).
  slug="${GA_RELEASE_REPO}"
  case "${slug}" in
    '' | *' '*)
      die "${EXIT_NO_RELEASE_REPO}" \
        "release repo not configured — set GA_RELEASE_REPO=<owner>/<repo> and re-run."
      ;;
    */*) : ;; # <owner>/<repo> shape — proceed
    *)
      die "${EXIT_NO_RELEASE_REPO}" \
        "GA_RELEASE_REPO must be an <owner>/<repo> slug (got: '${slug}')."
      ;;
  esac
  require_tool gh

  local -a gh_args=(release download)
  [[ -n "${GA_RELEASE_TAG}" ]] && gh_args+=("${GA_RELEASE_TAG}")
  gh_args+=(
    --repo "${slug}" --dir "${dl_dir}" --clobber
    --pattern 'manifest.json' --pattern 'glass-atrium-bundle-*.tar.gz'
  )
  log "Downloading the ${GA_RELEASE_TAG:-latest} Glass Atrium release from ${slug} ..."
  gh "${gh_args[@]}" \
    || die "${EXIT_DOWNLOAD_FAILED}" \
      "gh release download failed for ${slug} — check the slug, the release, and gh auth."

  [[ -f "${dl_dir}/manifest.json" ]] \
    || die "${EXIT_DOWNLOAD_FAILED}" "release asset manifest.json missing after download."

  # Bundle-name/version assertion parity with update.sh::update_fetch_release: the
  # bundle is named glass-atrium-bundle-<version>.tar.gz by publish-release.sh from
  # the SAME manifest .version, so derive the expected name and refuse a zero /
  # ambiguous / version-mismatched match rather than blindly taking the first — a
  # mismatch is a corrupt release, not a file to guess at.
  local version expected b
  local -a bundles=()
  version="$(jq -r '.version // empty' -- "${dl_dir}/manifest.json")"
  [[ -n "${version}" ]] \
    || die "${EXIT_DOWNLOAD_FAILED}" "release manifest.json carries no .version — cannot derive the expected bundle name."
  expected="glass-atrium-bundle-${version}.tar.gz"
  # find/sort feed the loop; their rc is intentionally not the loop's verdict.
  # shellcheck disable=SC2312
  while IFS= read -r b; do
    [[ -n "${b}" ]] && bundles+=("${b}")
  done < <(find "${dl_dir}" -maxdepth 1 -type f -name 'glass-atrium-bundle-*.tar.gz' | LC_ALL=C sort)
  if [[ "${#bundles[@]}" -eq 0 ]]; then
    die "${EXIT_DOWNLOAD_FAILED}" "release bundle (${expected}) missing after download."
  fi
  if [[ "${#bundles[@]}" -gt 1 ]]; then
    die "${EXIT_DOWNLOAD_FAILED}" \
      "ambiguous release: ${#bundles[@]} bundle assets matched glass-atrium-bundle-*.tar.gz — expected exactly one (${expected}): ${bundles[*]}"
  fi
  bundle="${bundles[0]}"
  [[ "${bundle##*/}" == "${expected}" ]] \
    || die "${EXIT_DOWNLOAD_FAILED}" \
      "release bundle ${bundle##*/} does not match the manifest version bundle ${expected} — refusing a version-mismatched bundle."
  tar -xzf "${bundle}" -C "${new_tree}" \
    || die "${EXIT_EXTRACT_FAILED}" "bundle extraction failed: ${bundle}"
}

# per-file integrity verify (reused spine lib)
# Verify every extracted file's SHA-256 against manifest.hashes[path]. BOOTSTRAP: the
# verify REUSES the shared spine lib rather than inlining the hash loop, but the lib is
# itself a bundle member existing only AFTER extract — so it is sourced post-extract
# from the scratch tree. The trust anchor is the authenticated gh release + slug; this
# per-file check is the integrity gate against a corrupt/partial download.
# Args: $1 = new-release tree · $2 = manifest.json · $3 = staging.
verify_bundle() {
  local new_tree="$1" manifest="$2" staging="$3" spine_lib
  spine_lib="${new_tree}/scripts/lib/apply-spine.sh"
  [[ -f "${spine_lib}" ]] \
    || die "${EXIT_VERIFY_FAILED}" \
      "bundle is missing scripts/lib/apply-spine.sh — refusing to trust it."
  # shellcheck source=/dev/null
  source "${spine_lib}"
  log "Verifying per-file SHA-256 of the release against manifest.hashes ..."
  # A fresh install stages the WHOLE manifest.files set; spine_stage_and_verify
  # copies each into the staging dir and loud-fails on the first hash mismatch.
  if ! jq -r '.files[]' -- "${manifest}" \
    | spine_stage_and_verify "${new_tree}" "${manifest}" "${staging}"; then
    die "${EXIT_VERIFY_FAILED}" \
      "per-file hash verification failed — corrupt download, refusing to install."
  fi
}

# merge/additive install into GA_DIR (idempotent, no-origin)
# Extract-in-place is an ADDITIVE cp of the VERIFIED STAGING tree — writes only the
# hash-verified manifest.files members, NEVER rm -rf, so runtime data outside the
# bundle stays byte-intact. INSTALLED == VERIFIED: the copy source is the
# spine_stage_and_verify output (exactly manifest.files), NOT the raw tarball — so any
# UNLISTED tarball member (never hash-gated) is structurally excluded, not deployed.
# Idempotency keys on the persisted install manifest {version}: same → no-op, changed →
# extract in place. Args: $1 = verified staging tree · $2 = downloaded manifest.json.
install_tree() {
  local staged_tree="$1" dl_manifest="$2" release_version installed_version
  release_version="$(jq -r '.version // "unknown"' -- "${dl_manifest}")"

  if [[ -f "${GA_DIR}/manifest.json" ]]; then
    installed_version="$(jq -r '.version // "unknown"' -- "${GA_DIR}/manifest.json" 2>/dev/null || printf 'unknown\n')"
    if [[ "${installed_version}" != 'unknown' && "${installed_version}" == "${release_version}" ]]; then
      log "Glass Atrium ${installed_version} already installed at ${GA_DIR} (verified) — no extract needed."
      return 0
    fi
    log "Updating in place at ${GA_DIR}: ${installed_version} -> ${release_version} (additive; runtime data preserved)."
  else
    log "Installing Glass Atrium ${release_version} into ${GA_DIR} (fresh extract)."
  fi

  # Additive merge: swap each verified staging member into GA_DIR one file at a time
  # through the spine's ATOMIC swap (sibling temp + rename(2), same FS). A bulk
  # `cp -Rp` writes each file IN PLACE (truncate-then-write), so a mid-copy kill on a
  # reinstall-over-existing left a half-written member in the LIVE tree; the per-file
  # rename makes every destination either the whole old file or the whole new one, so
  # an interrupted reinstall leaves the prior tree intact (no truncated members).
  # Modes are preserved (spine cp -p, so ${GA_DIR}/glass-atrium stays executable), and
  # only verified manifest.files members are swapped — agents-bak/, wiki/, secrets/,
  # data/, config.toml (none bundle members) are untouched (no directory-level rename).
  command -v spine_atomic_swap >/dev/null 2>&1 \
    || die "${EXIT_EXTRACT_FAILED}" "spine_atomic_swap unavailable — apply-spine.sh was not sourced before install_tree."
  mkdir -p -- "${GA_DIR}"
  local rel src dst
  # the manifest was already parsed + hash-verified; jq's rc here is not the verdict.
  # shellcheck disable=SC2312
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    src="${staged_tree}/${rel}"
    dst="${GA_DIR}/${rel}"
    [[ -f "${src}" ]] \
      || die "${EXIT_EXTRACT_FAILED}" "verified staging member missing for ${rel} — refusing a partial install."
    mkdir -p -- "$(dirname -- "${dst}")" \
      || die "${EXIT_EXTRACT_FAILED}" "failed to create the destination directory for ${rel} under ${GA_DIR}."
    spine_atomic_swap "${src}" "${dst}" \
      || die "${EXIT_EXTRACT_FAILED}" "failed to atomically install ${rel} into ${GA_DIR}."
  done < <(jq -r '.files[]' -- "${dl_manifest}")

  # Persist the release manifest as the install manifest (the idempotency key + the
  # update path's baseline anchor). manifest.json is a SEPARATE release asset, not a
  # bundle member, so it is installed explicitly here — through the SAME atomic swap
  # so a mid-write kill never leaves a truncated idempotency key.
  spine_atomic_swap "${dl_manifest}" "${GA_DIR}/manifest.json" \
    || die "${EXIT_EXTRACT_FAILED}" "failed to persist the install manifest to ${GA_DIR}/manifest.json."
}

# facade mirror-farm refresh (reinstall parity)
# Reinstall parity: a reinstall-over-existing lands NEW release files in GA_DIR, but
# the per-file symlink farm only ran at first install — so new files ship WITHOUT their
# ~/.claude mirror. Refresh the farm ONLY on a prior CONSENTED deploy, detected by
# GA-pointing facade symlinks (the artifact only the menu Install / agents-only consent
# path creates; idempotent — swap_symlink refuses foreign symlinks + real user files,
# never deletes user data). A pre-existing install manifest is deliberately NOT a
# consent signal: install_tree persists it on a plain EXTRACT, so arming the refresh on
# it would farm into a real ~/.claude without the declared consent path. The link probe
# is safe post-copy (extract writes only into GA_DIR, never the facade). Runs BEFORE
# handoff so GA_NO_RUN / no-tty exits are covered.
# BOOTSTRAP: the shared lib is a bundle member sourced post-extract; an OLDER bundle
# without it degrades to a loud WARN + manual hint, never a silent skip.
refresh_mirror_farm() {
  local rc=0 linked
  local farm_lib="${GA_DIR}/scripts/lib/mirror-farm.sh"
  if [[ ! -f "${farm_lib}" ]]; then
    log "WARN: ${farm_lib} not in this bundle — mirror refresh skipped; run '${GA_DIR}/glass-atrium agents-only' manually."
    return 0
  fi
  # shellcheck source=/dev/null
  source "${farm_lib}"
  # stdout-verdict helpers (always exit 0) — the $( ) masking is their contract.
  # shellcheck disable=SC2311,SC2312
  linked="$(farm_has_ga_links "$(farm_target_home)" "${GA_DIR}")"
  if [[ "${linked}" != "yes" ]]; then
    log "No consented deployment (no GA-pointing facade links) — the symlink farm stays with the menu Install (consent gate)."
    return 0
  fi
  # rc 3 = clean skip (facade home / launcher absent — logged by the lib);
  # rc 1 = the farm subprocess failed -> named loud-fail, files stay installed.
  # shellcheck disable=SC2310
  farm_refresh "${GA_DIR}" || rc=$?
  if [[ "${rc}" -ne 0 && "${rc}" -ne 3 ]]; then
    die "${EXIT_FARM_FAILED}" \
      "mirror-farm refresh failed — files installed, but the ~/.claude facade mirror was NOT refreshed; run '${GA_DIR}/glass-atrium agents-only' and re-run the installer."
  fi
}

# hand off to the interactive launcher
# THE tricky part under curl|bash: stdin is the script pipe, so the menu cannot read
# keys from it. Reconnect to the controlling terminal (/dev/tty) and EXEC the launcher
# so the TUI owns the terminal. With no controlling tty (CI) or GA_NO_RUN set, print
# the run hint and exit 0 instead of launching a key-driven menu.
handoff() {
  local launcher="${GA_DIR}/glass-atrium"
  [[ -x "${launcher}" ]] \
    || die "${EXIT_NO_LAUNCHER}" "Launcher missing or not executable: ${launcher}"

  if [[ -n "${GA_NO_RUN}" ]]; then
    log "Install complete (GA_NO_RUN set). Launch the menu yourself:"
    log "  ${launcher}"
    return 0
  fi

  # Probe for a reachable controlling terminal. The 2>/dev/null here is NOT a
  # swallowed precondition: we branch on the result and print a clear message in
  # the no-tty case — it only hides the expected "Device not configured" noise.
  if [[ -e /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then
    log "Launching the Glass Atrium menu — choose Install."
    exec "${launcher}" </dev/tty
  fi

  log "Install complete — no interactive terminal detected. Launch the menu yourself:"
  log "  ${launcher}"
}

main() {
  local dl_dir new_tree staging manifest
  log "Glass Atrium installer"
  preflight
  assert_installable_target

  # Scratch tree for download → verify → merge. Registered for cleanup via the
  # global before creation (temp-leak guard); the trap removes it on failure.
  _ga_workdir="$(mktemp -d -t glass-atrium-install.XXXXXX)"
  dl_dir="${_ga_workdir}/download"
  new_tree="${_ga_workdir}/new"
  staging="${_ga_workdir}/staging"
  mkdir -p -- "${dl_dir}" "${new_tree}" "${staging}"

  fetch_release "${dl_dir}" "${new_tree}"
  manifest="${dl_dir}/manifest.json"
  verify_bundle "${new_tree}" "${manifest}" "${staging}"
  # Install from the VERIFIED staging tree, NOT the raw ${new_tree}: installed ==
  # verified == manifest.files, so an unlisted tarball member is never deployed.
  install_tree "${staging}" "${manifest}"

  # The scratch tree is done with; remove it BEFORE handoff since exec never returns
  # to fire the EXIT trap.
  rm -rf -- "${_ga_workdir}"
  _ga_workdir=""

  # Refresh the ~/.claude facade mirrors on a prior consented deployment — new release
  # files must never ship without their mirror.
  refresh_mirror_farm

  handoff
}

main "$@"
