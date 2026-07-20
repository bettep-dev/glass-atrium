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
# runs no third-party `curl | sh`. It downloads the GitHub Release assets via
# unauthenticated `curl` against the fixed release-asset URLs (no gh, no GitHub
# API, no auth surface), verifies every file against the SHA-256 manifest — the
# sole trust anchor — extracts, and launches; nothing else.
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
#                     manifest verbatim (skip the network). This is how the PHASE-2
#                     acceptance test drives a real end-to-end no-.git install.
#
# Exit codes (named, loud-fail — no silent precondition absorption):
#   0   success (installed and either handed off or printed the run hint)
#   10  not macOS
#   11  a required tool (tar / curl / shasum) or manifest parser (jq / runnable
#       python3) is not available
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
# Manifest-parser backend ("jq" | "python3"), resolved ONCE by preflight's
# require_manifest_parser and consulted at every manifest_get call site.
_ga_manifest_parser=""

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

# NON-INTERACTIVE python3 runnability probe. Stock macOS ships /usr/bin/python3 as
# an Apple CLT shim that pops a GUI install dialog when executed without the
# Command Line Tools — PATH visibility alone is NOT runnability. The CLT gate
# (xcode-select -p) applies ONLY to that Apple shim path; a brew/pyenv python3
# runs without CLT and must never be rejected by it.
python3_runnable() {
  local py
  py="$(command -v python3 2>/dev/null)" || return 1
  if [[ "${py}" == "/usr/bin/python3" ]]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
}

# Resolve the manifest-parser backend ONCE: jq when present, runnable python3
# otherwise — the fallback is what lets the one-liner run on a bare Mac BEFORE
# ga-deps can ever install jq. Neither usable → loud-fail naming both accepted
# parsers + the brew remedy.
require_manifest_parser() {
  if command -v jq >/dev/null 2>&1; then
    _ga_manifest_parser="jq"
    return 0
  fi
  # shellcheck disable=SC2310  # probe in a condition by design — verdict branched on
  if python3_runnable; then
    _ga_manifest_parser="python3"
    return 0
  fi
  die "${EXIT_MISSING_TOOL}" \
    "no JSON parser available — install jq (brew install jq) or a runnable python3 (xcode-select --install), then re-run."
}

# manifest_get <mode> <manifest.json> — the ONE shared manifest-parse helper for
# every pre-bundle parse site, with an identical output contract on both backends:
#   version-or-empty   ≡ jq -r '.version // empty'
#   version-or-unknown ≡ jq -r '.version // "unknown"'
#   files              ≡ jq -r '.files[]'
# Backend chosen by require_manifest_parser (jq preferred; python3 on a bare Mac).
manifest_get() {
  local mode="$1" manifest="$2"
  if [[ "${_ga_manifest_parser}" == "jq" ]]; then
    case "${mode}" in
      version-or-empty) jq -r '.version // empty' -- "${manifest}" ;;
      version-or-unknown) jq -r '.version // "unknown"' -- "${manifest}" ;;
      files) jq -r '.files[]' -- "${manifest}" ;;
      *) return 2 ;;
    esac
    return
  fi
  # python3 backend: source captured FIRST, then run — an inline heredoc on the
  # python3 -c command line itself would swallow stdin (SC2259).
  local py_src
  py_src="$(
    cat <<'PY'
import json, sys

mode, path = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
if mode == "version-or-empty":
    v = data.get("version")
    if v is not None and v is not False:
        print(v)
elif mode == "version-or-unknown":
    v = data.get("version")
    print("unknown" if v is None or v is False else v)
elif mode == "files":
    files = data.get("files")
    if files is None or files is False:
        sys.exit(5)  # jq parity: iterating null is an error (exit 5)
    for entry in files:
        print(entry)
else:
    sys.exit(2)
PY
  )"
  python3 -c "${py_src}" "${mode}" "${manifest}"
}

# preflight (loud-fail)
# Verify the hard preconditions before touching the filesystem: macOS + the tools
# the download/verify/extract needs. Stock-macOS bar by design: tar + curl +
# shasum ship with the OS and the manifest parse falls back to runnable python3,
# so a bare Mac passes with nothing preinstalled (no gh, no jq).
preflight() {
  local os
  os="$(uname -s)"
  [[ "${os}" == "Darwin" ]] \
    || die "${EXIT_NOT_MACOS}" "Glass Atrium requires macOS (detected: ${os})."
  require_tool tar
  require_tool curl
  require_sha256
  require_manifest_parser
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
# extract the bundle into $2 (scratch new-release tree). The fixed release-asset URL
# forms MIRROR update.sh::update_fetch_release rather than sourcing it — on a fresh
# curl|bash install nothing is on disk yet, so the updater's libs can't be sourced
# pre-download. MANIFEST-FIRST by design: curl cannot glob an asset name, so the
# manifest is fetched first and the bundle name derived from its .version, then the
# bundle fetched from the version-pinned tag URL (releases/download/v<version>/…,
# the publish-release v<manifest.version> tag contract) — closing the race where
# "latest" moves between two latest-form requests. Unauthenticated by design: gh
# demands auth even for a public release and was dropped outright (D2-R1).
fetch_release() {
  local dl_dir="$1" new_tree="$2" slug base tag manifest_url bundle_url version expected bundle

  # TEST SEAM — both set → a locally-built bundle + manifest are used verbatim,
  # skipping the network entirely (mirrors update.sh's ATRIUM_UPDATE_SRC_* seam), so
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

  base="https://github.com/${slug}/releases"
  # -f is load-bearing: plain curl exits 0 on a 404 HTML body, which would poison
  # the download — -f turns HTTP errors into a non-zero rc for the exit-14 gate.
  if [[ -n "${GA_RELEASE_TAG}" ]]; then
    manifest_url="${base}/download/${GA_RELEASE_TAG}/manifest.json"
  else
    manifest_url="${base}/latest/download/manifest.json"
  fi
  log "Downloading the ${GA_RELEASE_TAG:-latest} Glass Atrium release manifest from ${slug} ..."
  curl -fSL --retry 3 -o "${dl_dir}/manifest.json" "${manifest_url}" \
    || die "${EXIT_DOWNLOAD_FAILED}" "manifest download failed: ${manifest_url}"

  # invalid-JSON manifest → the parser's non-zero rc folds into the same loud
  # exit-14 (a corrupt asset is a failed download, not an unnamed strict-mode abort).
  # shellcheck disable=SC2310,SC2312
  version="$(manifest_get version-or-empty "${dl_dir}/manifest.json" || true)"
  [[ -n "${version}" ]] \
    || die "${EXIT_DOWNLOAD_FAILED}" "release manifest.json carries no .version — cannot derive the expected bundle name."
  expected="glass-atrium-bundle-${version}.tar.gz"
  # A pinned GA_RELEASE_TAG keeps BOTH assets on that tag; otherwise the bundle is
  # version-pinned to the manifest just fetched (v<version> per publish-release).
  tag="${GA_RELEASE_TAG:-v${version}}"
  bundle_url="${base}/download/${tag}/${expected}"
  bundle="${dl_dir}/${expected}"
  log "Downloading ${expected} ..."
  curl -fSL --retry 3 -o "${bundle}" "${bundle_url}" \
    || die "${EXIT_DOWNLOAD_FAILED}" "bundle download failed: ${bundle_url}"
  tar -xzf "${bundle}" -C "${new_tree}" \
    || die "${EXIT_EXTRACT_FAILED}" "bundle extraction failed: ${bundle}"
}

# per-file integrity verify (reused spine lib)
# Verify every extracted file's SHA-256 against manifest.hashes[path]. BOOTSTRAP: the
# verify REUSES the shared spine lib rather than inlining the hash loop, but the lib is
# itself a bundle member existing only AFTER extract — so it is sourced post-extract
# from the scratch tree. This per-file SHA-256 manifest check IS the sole trust
# anchor of the unauthenticated download (integrity gate against a corrupt /
# tampered / partial asset).
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
  # shellcheck disable=SC2310,SC2312  # the pipeline verdict IS branched on
  if ! manifest_get files "${manifest}" \
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
  # shellcheck disable=SC2311
  release_version="$(manifest_get version-or-unknown "${dl_manifest}")"

  if [[ -f "${GA_DIR}/manifest.json" ]]; then
    # shellcheck disable=SC2310,SC2312
    installed_version="$(manifest_get version-or-unknown "${GA_DIR}/manifest.json" 2>/dev/null || printf 'unknown\n')"
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
  # the manifest was already parsed + hash-verified; the parser's rc here is not
  # the verdict.
  # shellcheck disable=SC2310,SC2312
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
  done < <(manifest_get files "${dl_manifest}")

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
