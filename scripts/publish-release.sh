#!/usr/bin/env bash
# publish-release.sh — Glass Atrium release publishing helper (GitHub Releases).
#
# SCAFFOLD (E1/T04). Transport = GitHub Releases assets: each release carries
# manifest.json (version + per-file SHA-256) plus a hashed file bundle, consumed
# by the update skill over HTTPS — integrity is verified per-file against the
# manifest hashes, never raw `main`, no git remote required on the CONSUMER.
#
# This helper NEVER creates a git remote and NEVER pushes a tag. `build` only
# stages assets; `publish` only uploads them to an ALREADY-EXISTING remote via
# `gh release create`. The default `publish` run is a DRY RUN that prints the
# exact command (creates nothing) — actual upload needs --execute.
#
#   ┌─ TODO (PENDING USER STEP — the GitHub repo URL is not known yet) ────────┐
#   │ The release repo is UNCONFIGURED. Before the first real release the user  │
#   │ must, OUTSIDE this script:                                                │
#   │   1. create the GitHub repo,                                             │
#   │   2. `git remote add origin <url>` in ~/.glass-atrium,                    │
#   │   3. set the slug: ATRIUM_RELEASE_REPO=<owner/repo> (or [release].repo    │
#   │      in config.toml),                                                     │
#   │   4. create + push the first tag `v<manifest.version>`.                   │
#   │ Until the slug is set, `publish` loud-fails (exit 5) and uploads nothing. │
#   └──────────────────────────────────────────────────────────────────────────┘
#
# Runbook (the repeatable release step):
#   1. scripts/generate-manifest.sh                 # stamp version + hashes
#   2. (commit + push the manifest via the normal PR flow)
#   3. ATRIUM_RELEASE_REPO=<owner/repo> \
#        scripts/publish-release.sh publish --execute    # after the repo exists
#   - CI alternative: push a `v*` tag → .github/workflows/release.yml runs this.
#
# Repo slug resolution: ATRIUM_RELEASE_REPO env → config.toml [release].repo →
# unset (publish refuses). The slug is the ONLY repo coordinate — no URL is ever
# hardcoded here (gh resolves owner/repo against the authenticated host).
#
# Env / sandbox overrides (mirror the engine's GA_* pattern):
#   GA_ROOT             repo root           (default: parent of this scripts/ dir)
#   GA_RELEASE_OUT      asset staging dir   (default: $TMPDIR/glass-atrium-release)
#   ATRIUM_RELEASE_REPO owner/repo slug     (overrides config [release].repo)
#
# Named exit codes: 2=usage · 3=required tool absent (jq/tar/generator) ·
# 4=manifest --check failed (stale manifest, refuse to release) · 5=release repo
# not configured (the pending user step) · 6=gh CLI absent.
set -Eeuo pipefail
IFS=$'\n\t'

# Repo root = parent of this script's scripts/ dir (portable, engine idiom).
GA_ROOT_DEFAULT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly GA_ROOT="${GA_ROOT:-${GA_ROOT_DEFAULT}}"
readonly MANIFEST="${GA_ROOT}/manifest.json"
readonly GENERATE_MANIFEST="${GA_ROOT}/scripts/generate-manifest.sh"
readonly BUNDLE_PREFIX="glass-atrium-bundle"

# Default asset staging dir (printed, NOT auto-removed — the user uploads from
# it). Trailing slash on $TMPDIR is stripped so the path never doubles up.
_tmp="${TMPDIR:-/tmp}"
readonly DEFAULT_OUT="${GA_RELEASE_OUT:-${_tmp%/}/glass-atrium-release}"

# Shared config accessor (atrium_config_get) for [release].repo. Sourcing only
# defines functions (side-effect-free under strict mode).
SCRIPT_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
readonly SCRIPT_SELF_DIR
# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_SELF_DIR}/lib/atrium-config.sh"

TMP_FILES=()
EXECUTE=0

# EXIT trap: capture the triggering status FIRST, drop temp scratch, then re-exit
# with the preserved code (the out dir is intentionally NOT removed).
cleanup() {
  local rc=$?
  local f
  for f in "${TMP_FILES[@]:-}"; do
    [[ -n "${f}" && -e "${f}" ]] && rm -f -- "${f}"
  done
  exit "${rc}"
}
trap cleanup EXIT
trap 'printf "publish-release: ERROR at line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

err() { printf 'publish-release: %s\n' "$*" >&2; }
warn() { printf 'publish-release: %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
usage: publish-release.sh <build|publish> [--out DIR] [--tag TAG] [--execute]

  build              stage manifest.json + the hashed file bundle into --out
  publish            upload the staged assets to the configured GitHub repo
                     (DRY RUN unless --execute; never creates a remote or tag)

  --out DIR          asset staging dir (default: $TMPDIR/glass-atrium-release)
  --tag TAG          release tag (default: v<manifest.version>)
  --execute          actually run `gh release create` (publish only)

  Set ATRIUM_RELEASE_REPO=<owner/repo> (or [release].repo in config.toml)
  before `publish` — the GitHub repo must already exist (see header TODO).
USAGE
}

# Echo the manifest version (empty if absent).
manifest_version() {
  jq -r '.version // empty' -- "${MANIFEST}"
}

# Echo the configured release repo slug (owner/repo), empty when unset.
repo_slug() {
  if [[ -n "${ATRIUM_RELEASE_REPO:-}" ]]; then
    printf '%s\n' "${ATRIUM_RELEASE_REPO}"
    return 0
  fi
  atrium_config_get '[release]' repo ''
}

# Hard prerequisites for staging assets. gh is checked only on the publish path.
preflight_tools() {
  local tool
  for tool in jq tar; do
    command -v "${tool}" >/dev/null 2>&1 || {
      err "${tool} required but not found"
      exit 3
    }
  done
  [[ -x "${GENERATE_MANIFEST}" ]] || {
    err "manifest generator not found/executable: ${GENERATE_MANIFEST}"
    exit 3
  }
  [[ -f "${MANIFEST}" ]] || {
    err "manifest not found: ${MANIFEST} — run scripts/generate-manifest.sh first"
    exit 3
  }
}

# Refuse to release a stale manifest: --check must be clean (version + hashes +
# file list all match the tracked tree). `!` negation is a set -e exception.
verify_manifest() {
  if ! "${GENERATE_MANIFEST}" --check >&2; then
    err "manifest --check FAILED — regenerate with scripts/generate-manifest.sh before releasing"
    exit 4
  fi
}

# Stage manifest.json + the hashed bundle (exactly the manifest.files set) into
# the out dir. Echoes nothing; assets land at deterministic names the caller
# reconstructs from the version.
build_assets() {
  local out="$1" version filelist bundle
  version="$(manifest_version)"
  [[ -n "${version}" ]] || {
    err "manifest carries no version — regenerate first"
    exit 4
  }
  mkdir -p -- "${out}"
  cp -- "${MANIFEST}" "${out}/manifest.json"

  filelist="$(mktemp -t ga-release-filelist.XXXXXX)"
  TMP_FILES+=("${filelist}")
  jq -r '.files[]' -- "${MANIFEST}" >"${filelist}"

  bundle="${out}/${BUNDLE_PREFIX}-${version}.tar.gz"
  # -C GA_ROOT + -T filelist: bundle the deploy set with manifest-relative paths
  # (BSD bsdtar and GNU tar both honor -T).
  tar -czf "${bundle}" -C "${GA_ROOT}" -T "${filelist}"
}

print_build_summary() {
  local out="$1" version
  version="$(manifest_version)"
  cat <<SUMMARY
publish-release: staged release assets (version ${version})
  manifest : ${out}/manifest.json
  bundle   : ${out}/${BUNDLE_PREFIX}-${version}.tar.gz
  integrity: per-file SHA-256 in manifest.json .hashes (verified by the consumer)
SUMMARY
}

cmd_build() {
  local out="$1"
  preflight_tools
  verify_manifest
  build_assets "${out}"
  print_build_summary "${out}"
}

cmd_publish() {
  local out="$1" tag="$2" slug version bundle
  preflight_tools
  command -v gh >/dev/null 2>&1 || {
    err "gh CLI not found — required to publish a GitHub Release"
    exit 6
  }
  slug="$(repo_slug)"
  if [[ -z "${slug}" ]]; then
    err "release repo NOT configured — set ATRIUM_RELEASE_REPO=<owner/repo> or [release].repo in config.toml"
    err "TODO (pending user step): the GitHub repo does not exist yet — create it + the remote + the first tag, then re-run (see header)."
    exit 5
  fi
  verify_manifest
  build_assets "${out}"
  version="$(manifest_version)"
  [[ -n "${tag}" ]] || tag="v${version}"
  bundle="${out}/${BUNDLE_PREFIX}-${version}.tar.gz"

  # The exact upload command. gh resolves owner/repo against the authenticated
  # host — no URL is hardcoded. `gh release create <tag>` requires the remote to
  # already exist; this script never adds a remote or pushes a tag itself.
  local -a gh_cmd=(
    gh release create "${tag}" --repo "${slug}"
    --title "Glass Atrium ${version}"
    --notes "Glass Atrium release ${version} (manifest + hashed bundle)."
    "${out}/manifest.json" "${bundle}"
  )

  if [[ "${EXECUTE}" -eq 1 ]]; then
    warn "publishing to ${slug} (tag ${tag}) — executing gh release create"
    "${gh_cmd[@]}"
    printf 'publish-release: published %s to %s\n' "${tag}" "${slug}"
  else
    # space-join the argv for display (IFS-independent: $'\n\t' would otherwise
    # newline-split "${gh_cmd[*]}").
    local preview
    preview="$(printf '%s ' "${gh_cmd[@]}")"
    printf 'publish-release: DRY RUN — re-run with --execute to publish. Would run:\n  %s\n' "${preview% }"
  fi
}

main() {
  local sub="${1:-}"
  [[ "$#" -gt 0 ]] && shift
  case "${sub}" in
    build | publish) ;;
    -h | --help)
      usage
      exit 0
      ;;
    "")
      usage >&2
      exit 2
      ;;
    *)
      err "unknown subcommand: ${sub}"
      usage >&2
      exit 2
      ;;
  esac

  local out="${DEFAULT_OUT}" tag=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --out)
        out="${2:-}"
        [[ -n "${out}" ]] || {
          err "--out requires a directory"
          exit 2
        }
        shift 2
        ;;
      --tag)
        tag="${2:-}"
        [[ -n "${tag}" ]] || {
          err "--tag requires a value"
          exit 2
        }
        shift 2
        ;;
      --execute)
        EXECUTE=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        err "unknown option: $1"
        usage >&2
        exit 2
        ;;
    esac
  done

  case "${sub}" in
    build) cmd_build "${out}" ;;
    publish) cmd_publish "${out}" "${tag}" ;;
  esac
}

main "$@"
