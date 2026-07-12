#!/usr/bin/env bash
# publish-release.sh — Glass Atrium release publishing helper (GitHub Releases).
#
# SCAFFOLD (E1/T04). Transport = GitHub Releases assets: each release carries
# manifest.json (version + per-file SHA-256) + a hashed bundle, consumed by the
# update skill over HTTPS — integrity verified per-file against manifest hashes,
# never raw `main`, no git remote on the CONSUMER.
#
# This helper NEVER creates a git remote and NEVER pushes a tag. `build` only
# stages assets; `publish` only uploads to an ALREADY-EXISTING remote via
# `gh release create`. Default `publish` is a DRY RUN (prints the exact command,
# creates nothing) — actual upload needs --execute.
#
# TODO (PENDING USER STEP — GitHub repo URL not known yet): the release repo is
# UNCONFIGURED. Before the first real release the user must, OUTSIDE this script:
#   1. create the GitHub repo,
#   2. `git remote add origin <url>` in ~/.glass-atrium,
#   3. set the slug ATRIUM_RELEASE_REPO=<owner/repo> (or [release].repo in config.toml),
#   4. create + push the first tag `v<manifest.version>`.
# Until the slug is set, `publish` loud-fails (exit 5) and uploads nothing.
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
# not configured (the pending user step) · 6=gh CLI absent · 7=release consistency
# gate failed (GA_ROOT not a work tree, dirty tree, tag != v<manifest.version>, or a
# remote tag already pointing at a DIFFERENT commit than the verified local HEAD) ·
# 8=--replace-assets swap failed (release absent, a failed re-upload, or a post-swap
# verify that found the release left WITHOUT its canonical assets — loud, never silent).
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
REPLACE_ASSETS=0

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
usage: publish-release.sh <build|publish> [--out DIR] [--tag TAG] [--execute] [--replace-assets]

  build              stage manifest.json + the hashed file bundle into --out
  publish            upload the staged assets to the configured GitHub repo
                     (DRY RUN unless --execute; never creates a remote or tag)

  --out DIR          asset staging dir (default: $TMPDIR/glass-atrium-release)
  --tag TAG          release tag (default: v<manifest.version>)
  --execute          actually run `gh release create` (publish only)
  --replace-assets   re-publish: safely REPLACE the assets on an EXISTING release
                     (upload-then-swap; loud-fails rather than leaving it asset-less)

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

# Resolve the push remote for the remote-tag gate: prefer 'origin', else the first
# configured remote, else empty (no remote → the remote-tag gate is skipped, since gh
# owns the actual remote interaction on the publish path). Echoes the remote name.
publish_release_remote() {
  local remotes r
  if ! remotes="$(git -C "${GA_ROOT}" remote)"; then
    return 0
  fi
  [[ -n "${remotes}" ]] || return 0
  while IFS= read -r r; do
    [[ "${r}" == "origin" ]] && {
      printf 'origin\n'
      return 0
    }
  done <<<"${remotes}"
  # no 'origin' → the first configured remote (bash-native first line, no pipe).
  printf '%s\n' "${remotes%%$'\n'*}"
}

# Refuse to publish an inconsistent release. The bundle is tarred from the WORKING
# TREE (build_assets), so the released bytes must already exist in a commit, and the
# release tag must be the manifest version of record. Three fail-closed gates:
#   (1) CLEAN-TREE  — GA_ROOT is a git work tree with no unstaged/staged changes
#                     (whole-tree, so manifest.json — uploaded but outside the
#                     manifest SCOPE_PATHS — is covered too).
#   (2) TAG-VERSION — the release tag equals v<manifest.version> (mirrors the
#                     release.yml tag-assert so the version of record cannot drift
#                     from the asset it ships).
#   (3) REMOTE-TAG  — if the tag ALREADY exists on the remote, its peeled commit MUST
#                     equal the verified local HEAD (== the tarred, clean-tree bytes).
#                     A re-publish must never point a moved tag at a DIFFERENT commit
#                     than the assets it ships. Tag absent on the remote (first publish)
#                     or no remote configured → gate is a no-op.
# The git probes use the `if ! ...` set -e exception. Loud-fails with exit 7.
verify_publish_consistency() {
  local tag="$1" version="$2"

  # (1) CLEAN-TREE
  if ! git -C "${GA_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    err "GA_ROOT is not a git work tree: ${GA_ROOT}"
    exit 7
  fi
  if ! git -C "${GA_ROOT}" diff --quiet -- || ! git -C "${GA_ROOT}" diff --cached --quiet --; then
    err "working tree dirty — commit before publishing (released bytes must exist in a commit)"
    exit 7
  fi

  # (2) TAG-VERSION
  if [[ "${tag}" != "v${version}" ]]; then
    err "--tag ${tag} != v${version} (manifest version of record)"
    exit 7
  fi

  # (3) REMOTE-TAG — resolve the verified commit (clean-tree HEAD) + the remote.
  local head_sha remote
  if ! head_sha="$(git -C "${GA_ROOT}" rev-parse HEAD)"; then
    err "cannot resolve local HEAD in ${GA_ROOT} — refusing to publish"
    exit 7
  fi
  remote="$(publish_release_remote)"
  [[ -n "${remote}" ]] || return 0 # no remote configured → nothing to compare against
  local ls_out=""
  # ls-remote is a network round-trip; a FAILURE (unreachable remote) is not a MISMATCH,
  # so warn-and-proceed (gh still gates the actual push) — its stderr is NOT swallowed.
  if ! ls_out="$(git -C "${GA_ROOT}" ls-remote --tags "${remote}" "refs/tags/${tag}")"; then
    warn "remote-tag consistency check SKIPPED — 'git ls-remote ${remote}' failed (unreachable remote?); gh will still gate the push"
    return 0
  fi
  # Prefer the peeled ('^{}') SHA (an annotated tag's commit); fall back to the direct
  # SHA (a lightweight tag). Empty result → the tag is absent on the remote (first
  # publish) → nothing to assert.
  local remote_sha
  remote_sha="$(awk -v t="refs/tags/${tag}" '
    $2 == t "^{}" { peeled = $1 }
    $2 == t       { direct = $1 }
    END { print (peeled != "" ? peeled : direct) }' <<<"${ls_out}")"
  if [[ -n "${remote_sha}" && "${remote_sha}" != "${head_sha}" ]]; then
    err "remote tag ${tag} points at ${remote_sha} but the verified local HEAD is ${head_sha}"
    err "a re-publish must not move the tag to a different commit than the shipped assets — refusing"
    exit 7
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

# Re-publish (--replace-assets): safely REPLACE the assets on an ALREADY-PUBLISHED
# release. The silent-rollback this closes: a naive delete-then-upload whose delete
# succeeds and whose upload then fails leaves the release with NO bundle. Instead:
#   1. the release MUST already exist (first publish uses `gh release create`, exit 8);
#   2. UPLOAD-THEN-SWAP — the new bundle is first uploaded under a temp `.swap` asset
#      name, so a failed/incomplete upload NEVER touches the live bundle (the release
#      keeps serving its old, intact bundle — no asset-less window). gh has no asset
#      rename, so a same-version replace must still clobber the canonical name AFTER the
#      new bytes are proven uploadable — that clobber is the swap;
#   3. every re-upload failure is LOUD (exit 8 + message), never `|| true`-absorbed;
#   4. POST-VERIFY the canonical manifest.json + bundle are actually present (a silent
#      'success' that dropped the bundle is caught here, exit 8), THEN drop the temp.
# The `.swap` suffix is invisible to the consumer glob (glass-atrium-bundle-*.tar.gz).
replace_release_assets() {
  local tag="$1" slug="$2" version="$3" out="$4" bundle="$5"
  local canonical="${BUNDLE_PREFIX}-${version}.tar.gz"
  local manifest="${out}/manifest.json"

  if ! gh release view "${tag}" --repo "${slug}" >/dev/null 2>&1; then
    err "release ${tag} not found on ${slug} — --replace-assets replaces an EXISTING release (publish it first)"
    exit 8
  fi

  # (2) stage the new bundle under a temp name — a failure here leaves the live bundle
  # untouched, so the release is never left asset-less.
  local swap_name="${canonical}.swap"
  local swap_path="${out}/${swap_name}"
  cp -f -- "${bundle}" "${swap_path}"
  TMP_FILES+=("${swap_path}")
  if ! gh release upload "${tag}" --repo "${slug}" --clobber "${swap_path}"; then
    err "replace staging upload FAILED for ${tag} — the LIVE bundle is untouched (release intact); fix the error and re-run 'publish --replace-assets'"
    exit 8
  fi

  # swap: the new bytes are proven uploadable → clobber the canonical manifest + bundle.
  if ! gh release upload "${tag}" --repo "${slug}" --clobber "${manifest}" "${bundle}"; then
    err "canonical asset upload FAILED after staging on ${tag} — the new bundle is preserved as '${swap_name}'; re-run 'publish --replace-assets'"
    exit 8
  fi

  # (4) POST-VERIFY both canonical assets landed (--jq reads gh's embedded jq).
  local assets
  if ! assets="$(gh release view "${tag}" --repo "${slug}" --json assets --jq '.assets[].name')"; then
    err "post-replace asset verification failed (gh release view ${tag}) — verify the release manually"
    exit 8
  fi
  grep -qxF "${canonical}" <<<"${assets}" || {
    err "release ${tag} is MISSING its bundle ${canonical} after replace — the new bytes remain as '${swap_name}'; re-run"
    exit 8
  }
  grep -qxF 'manifest.json' <<<"${assets}" || {
    err "release ${tag} is MISSING manifest.json after replace — re-run 'publish --replace-assets'"
    exit 8
  }

  # best-effort temp cleanup — a lingering '.swap' asset is harmless (the consumer glob
  # ignores it); stderr is NOT swallowed so a failure stays visible.
  gh release delete-asset "${tag}" "${swap_name}" --repo "${slug}" --yes >/dev/null || {
    warn "temp swap asset '${swap_name}' not removed on ${tag} — harmless (consumer glob ignores '.swap'); delete manually if desired"
  }
  printf 'publish-release: replaced assets on %s (verified manifest.json + %s; upload-then-swap)\n' "${tag}" "${canonical}"
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
  version="$(manifest_version)"
  [[ -n "${version}" ]] || {
    err "manifest carries no version — regenerate first"
    exit 4
  }
  [[ -n "${tag}" ]] || tag="v${version}"
  # Fail-closed BEFORE building the bundle: a dirty tree, tag/version mismatch, or a
  # moved remote tag must never produce release assets (exit 7).
  verify_publish_consistency "${tag}" "${version}"
  build_assets "${out}"
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
    if [[ "${REPLACE_ASSETS}" -eq 1 ]]; then
      warn "replacing assets on ${slug} (tag ${tag}) — upload-then-swap"
      replace_release_assets "${tag}" "${slug}" "${version}" "${out}" "${bundle}"
    else
      warn "publishing to ${slug} (tag ${tag}) — executing gh release create"
      "${gh_cmd[@]}"
      printf 'publish-release: published %s to %s\n' "${tag}" "${slug}"
    fi
  else
    if [[ "${REPLACE_ASSETS}" -eq 1 ]]; then
      printf 'publish-release: DRY RUN — re-run with --execute to replace. Would upload-then-swap:\n  gh release upload %s --repo %s --clobber %s %s\n' \
        "${tag}" "${slug}" "${out}/manifest.json" "${bundle}"
    else
      # space-join the argv for display (IFS-independent: $'\n\t' would otherwise
      # newline-split "${gh_cmd[*]}").
      local preview
      preview="$(printf '%s ' "${gh_cmd[@]}")"
      printf 'publish-release: DRY RUN — re-run with --execute to publish. Would run:\n  %s\n' "${preview% }"
    fi
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
      --replace-assets)
        REPLACE_ASSETS=1
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
    *)
      # unreachable — the top-of-main case already rejects any non-build/publish sub;
      # explicit loud-fail guard on an impossible state (SC2249).
      err "internal: unexpected subcommand ${sub}"
      exit 2
      ;;
  esac
}

# Run main ONLY on direct execution. When sourced (the bats unit suite), BASH_SOURCE
# differs from $0, so main is skipped and the functions become callable for isolated
# testing — the standard sourced-script source-guard (mirrors update.sh + the launcher).
if [[ "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
  main "$@"
fi
