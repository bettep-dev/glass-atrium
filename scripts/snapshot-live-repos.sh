#!/usr/bin/env bash
# snapshot-live-repos.sh — idempotent recovery snapshot of the seven live
# per-directory git repos under the GA root (autoagent/ agents/ monitor/
# scripts/test/ rules/ test/ hooks/test/). It records whatever the deploy left
# on disk, so a restore in any of them rolls the install FORWARD to the deployed
# release instead of backward to an older one.
#
# Why a separate tool instead of a commit seam inside the updater: update.sh is
# deliberately git-free so the no-.git consumer install stays supported. This
# tool is invoked deliberately (operator, or an explicit post-deploy step) and
# never participates in the updater's flow, so that design property is untouched.
#
# Usage:
#   snapshot-live-repos.sh [--dry-run] [--trigger post-deploy|manual-reconcile]
#   GA_ROOT env overrides ~/.glass-atrium (tests point it at a sandbox root).
#
# Guarantees:
#   * whitelist-scoped — only the seven relative dirs below, never the GA root
#   * idempotent — a clean repo is a logged no-op, so a second run adds no commit
#   * human-in-the-loop — porcelain summary + diffstat + untracked list print
#     BEFORE anything is staged, and --dry-run stages/commits nothing at all
#   * refusal-screened — every candidate path is matched against the environment
#     / key-material / build-output / control-character list BEFORE any git add
#     in any repo; one hit refuses the whole run (no partial commit)
#   * serialized — holds the shared .apply-lock across the entire screen→commit
#     sequence, so it can never record a torn mid-apply tree
#   * local-only — never invokes push/fetch/pull; a repo that has acquired a
#     remote is warned about and still snapshotted (the invariant is never-PUSH,
#     which is what keeps daemon-evolved bodies and operator pins local)
#
# Exit codes:
#   0  success or no-op (every whitelisted repo clean, snapshotted, or .git-less)
#   1  precondition failure (git missing)
#   2  argument error
#   3  repo dir missing (loud-fail, nothing staged)
#   4  apply-lock held by a live writer (daemon-apply.sh parity)
#   5  apply-lock lib missing (daemon-apply.sh parity)
#   6  refusal screen matched (loud-fail, nothing staged, nothing committed)
set -Eeuo pipefail
IFS=$'\n\t'

# Own dir, resolved without a nested command substitution. Locates the shared
# apply-lock lib under ../scripts/lib; GA_ROOT is the fallback for an invocation
# through a facade dir that carries no lib/ mirror.
_self_dir="${BASH_SOURCE[0]}"
case "${_self_dir}" in
  */*) _self_dir="${_self_dir%/*}" ;;
  *) _self_dir='.' ;;
esac
SCRIPT_DIR="$(cd -- "${_self_dir}" && pwd)"
readonly SCRIPT_DIR
unset _self_dir

# GA_ROOT: live install root by default; env override for tests / alternate roots
# (same idiom as init-test-repos.sh).
readonly GA_ROOT="${GA_ROOT:-${HOME}/.glass-atrium}"

# Scope is EXACTLY these seven relative dirs — the GA root itself is never a
# candidate (it holds secrets, logs, runtime data and the before-image sink).
# Clean members are a no-op, so listing all seven costs nothing and covers a
# repo that goes dirty later.
readonly LIVE_REPOS=(
  'autoagent'
  'agents'
  'monitor'
  'scripts/test'
  'rules'
  'test'
  'hooks/test'
)

readonly EXIT_ARGS=2
readonly EXIT_MISSING_DIR=3
readonly EXIT_LOCK_HELD=4
readonly EXIT_LOCK_LIB=5
readonly EXIT_REFUSED=6

# Shared writer lock — SAME precedence as daemon-apply.sh and update.sh, so all
# three writers contend on ONE canonical lock directory.
readonly REPORTS_DIR="${AUTOAGENT_REPORTS_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-reports}"
readonly LOCK_DIR="${REPORTS_DIR}/.apply-lock"

# Mechanical committer identity: these commits are a tool's recording of on-disk
# state, so no human co-author and no coding-agent trailer belongs on them.
readonly COMMIT_NAME='glass-atrium-snapshot'
readonly COMMIT_EMAIL='snapshot@glass-atrium.invalid'

DRY_RUN=0
TRIGGER='manual-reconcile'
VERSION_LABEL='unversioned'
LOCK_HELD=0
TMP_DIR=''
SCREEN_HITS=0
REFUSAL_REASON=''

log() { printf '[snapshot-live-repos] %s\n' "$*" >&2; }

die() {
  local code="${2:-1}"
  printf '[snapshot-live-repos] ERROR: %s\n' "$1" >&2
  exit "${code}"
}

usage() {
  cat >&2 <<'EOF'
Usage: snapshot-live-repos.sh [--dry-run] [--trigger post-deploy|manual-reconcile]

Records the current on-disk state of the seven live per-directory git repos as a
recovery snapshot. Idempotent: a clean repo is a no-op.
  --dry-run            Print every pending change; stage and commit nothing.
  --trigger <t>        post-deploy | manual-reconcile (default manual-reconcile).
  --help               Show this help.
EOF
}

# Precondition gate before the lock lib: git is load-bearing for every phase.
command -v git >/dev/null 2>&1 || die "git not in PATH"

# The .apply-lock stale-reclaim logic is SHARED with daemon-apply.sh and
# update.sh via ONE lib so the three writers cannot drift a divergent reclaim.
# Load-bearing: a missing lib is FATAL, because writers cannot be serialized
# without it and an unserialized snapshot can record a torn tree.
# An explicit ATRIUM_APPLY_LOCK_LIB is authoritative (a missing one loud-fails
# rather than being silently substituted); only the DEFAULT path falls back to
# the GA root, for an invocation through a facade dir with no lib/ mirror.
if [[ -n "${ATRIUM_APPLY_LOCK_LIB:-}" ]]; then
  APPLY_LOCK_LIB="${ATRIUM_APPLY_LOCK_LIB}"
else
  APPLY_LOCK_LIB="${SCRIPT_DIR}/lib/apply-lock.sh"
  if [[ ! -f "${APPLY_LOCK_LIB}" ]]; then
    APPLY_LOCK_LIB="${GA_ROOT}/scripts/lib/apply-lock.sh"
  fi
fi
readonly APPLY_LOCK_LIB
if [[ ! -f "${APPLY_LOCK_LIB}" ]]; then
  die "apply-lock lib missing (${APPLY_LOCK_LIB}) — writers cannot be serialized" "${EXIT_LOCK_LIB}"
fi
# A static source directive lets ShellCheck follow the lib under
# --external-sources and see apply_lock_acquired assigned (silences SC2154).
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/apply-lock.sh
. "${APPLY_LOCK_LIB}"

# Release the lock only if we still hold it, and drop the status scratch dir.
cleanup() {
  local rc=$?
  if [[ "${LOCK_HELD}" -eq 1 ]]; then
    apply_lock_release "${LOCK_DIR}"
  fi
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf -- "${TMP_DIR}"
  fi
  exit "${rc}"
}

# Sets REFUSAL_REASON to the matched pattern name for path $1, or '' when the
# path is admissible. Every pattern is basename- or segment-anchored: a naive
# *secret* substring glob false-positives on legitimate fixtures such as
# hooks/test/validate-secret-scan.bats. Out-parameter rather than stdout so the
# hot loop forks no subshell and set -e stays armed at every call site.
snapshot_path_refusal() {
  local path="$1" base seg
  REFUSAL_REASON=''
  base="${path##*/}"
  seg="/${path}"

  # A newline- or tab-bearing path breaks porcelain parsing and turns a blanket
  # stage into garbage; two such directory trees exist on the live install.
  case "${path}" in
    *[[:cntrl:]]*)
      REFUSAL_REASON='control-character path'
      return 0
      ;;
    *) ;;
  esac

  # .env.example is bundled release content (a template, no values) and stays.
  case "${base}" in
    .env.example) ;;
    .env | .env.*)
      REFUSAL_REASON='environment file'
      return 0
      ;;
    *) ;;
  esac

  case "${base}" in
    *.pem | *.key | *.p12 | *.pfx | *.keystore | id_rsa* | id_ed25519* | credentials.json | .netrc | .npmrc)
      REFUSAL_REASON='key material'
      return 0
      ;;
    *) ;;
  esac

  case "${seg}" in
    */node_modules/* | */__pycache__/*)
      REFUSAL_REASON='dependency directory'
      return 0
      ;;
    */public/dist/*)
      REFUSAL_REASON='build output (nested public/dist)'
      return 0
      ;;
    *) ;;
  esac

  # Repo-ROOT anchored only: monitor's public/src/data/ is hand-written source
  # and MUST stay snapshottable. data/.gitkeep is a bundled structural
  # placeholder, so it is admitted even though the runtime data dir is not.
  case "${path}" in
    dist/*)
      REFUSAL_REASON='build output (repo-root dist)'
      return 0
      ;;
    data/.gitkeep) ;;
    data/*)
      REFUSAL_REASON='runtime data (repo-root data)'
      return 0
      ;;
    *) ;;
  esac

  case "${base}" in
    *.pyc)
      REFUSAL_REASON='python bytecode'
      return 0
      ;;
    .DS_Store)
      REFUSAL_REASON='finder metadata'
      return 0
      ;;
    *.log)
      REFUSAL_REASON='log file'
      return 0
      ;;
    *) ;;
  esac
}

# Screen one candidate path, counting a hit into SCREEN_HITS. %q rendering keeps
# a control-character path from reaching the terminal raw.
snapshot_screen_path() {
  local rel="$1" path="$2" shown
  snapshot_path_refusal "${path}"
  if [[ -n "${REFUSAL_REASON}" ]]; then
    shown="$(printf '%q' "${path}")"
    log "REFUSE ${rel}: ${shown} — matched ${REFUSAL_REASON}"
    SCREEN_HITS=$((SCREEN_HITS + 1))
  fi
}

# Screen every candidate path in one repo's NUL-delimited porcelain record.
# Entry form is "XY <path>"; a rename/copy carries the original path as a
# SECOND NUL field, which is screened too.
snapshot_screen_repo() {
  local rel="$1" status_file="$2" entry code path orig
  while IFS= read -r -d '' entry; do
    code="${entry:0:2}"
    path="${entry:3}"
    snapshot_screen_path "${rel}" "${path}"
    case "${code}" in
      R* | C* | ?R | ?C)
        orig=''
        IFS= read -r -d '' orig || orig=''
        if [[ -n "${orig}" ]]; then
          snapshot_screen_path "${rel}" "${orig}"
        fi
        ;;
      *) ;;
    esac
  done <"${status_file}"
}

# Print what is about to be recorded, before it is recorded. The untracked list
# is stated separately because diff --stat covers tracked paths only, so a
# blanket stage's new files would otherwise never appear in the preview.
snapshot_report_repo() {
  local rel="$1" dir="$2" untracked
  log "--- ${rel}: pending snapshot content (review before it is recorded) ---"
  git -C "${dir}" status --short --untracked-files=all >&2
  if git -C "${dir}" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    git -C "${dir}" diff --stat HEAD >&2
  else
    log "${rel}: no HEAD yet — the whole tree is the initial snapshot"
  fi
  untracked="$(git -C "${dir}" ls-files --others --exclude-standard)"
  if [[ -n "${untracked}" ]]; then
    log "${rel}: untracked paths to be added:"
    printf '%s\n' "${untracked}" >&2
  fi
}

# Stage and commit one repo. Never creates an empty commit: a blanket stage that
# leaves the index equal to HEAD is reported as a no-op instead.
snapshot_commit_repo() {
  local rel="$1" dir="$2" subject body remotes head_sha
  remotes="$(git -C "${dir}" remote)"
  if [[ -n "${remotes}" ]]; then
    log "WARNING: ${rel} has a git remote — the local-only assumption changed; this tool never pushes or fetches"
  fi
  subject="- [x] Snapshot live state (${VERSION_LABEL}, ${TRIGGER})"
  body="- Recorded by scripts/snapshot-live-repos.sh on a ${TRIGGER} run so this recovery snapshot restores the deployed release rather than an earlier install."

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "dry-run: would snapshot ${rel} as \"${subject}\" (nothing staged)"
    return 0
  fi

  git -C "${dir}" add -A
  if git -C "${dir}" rev-parse --verify -q HEAD >/dev/null 2>&1 \
    && git -C "${dir}" diff --cached --quiet HEAD; then
    log "no index change after staging, no-op: ${rel}"
    return 0
  fi
  # gpgsign is disabled explicitly per commit rather than via --no-gpg-sign,
  # which is a forbidden bypass flag; the identity is set inline so the run does
  # not depend on operator git config.
  git -C "${dir}" \
    -c commit.gpgsign=false \
    -c "user.name=${COMMIT_NAME}" \
    -c "user.email=${COMMIT_EMAIL}" \
    commit --quiet -m "${subject}" -m "${body}"
  head_sha="$(git -C "${dir}" rev-parse --short HEAD)"
  log "snapshotted: ${rel} @ ${head_sha}"
}

# Release label for the commit subject. An unreadable manifest is a warned
# fallback, never a silent one and never a hard stop: snapshot currency outranks
# the accuracy of its label.
snapshot_release_label() {
  local manifest="${GA_ROOT}/manifest.json" ver=''
  if command -v jq >/dev/null 2>&1 && [[ -r "${manifest}" ]]; then
    ver="$(jq -r '.version // empty' -- "${manifest}" 2>/dev/null || printf '')"
  fi
  if [[ -z "${ver}" ]]; then
    log "WARNING: release version unreadable (${manifest}) — labelling this snapshot 'unversioned'"
    VERSION_LABEL='unversioned'
    return 0
  fi
  VERSION_LABEL="v${ver}"
}

# ONE acquisition for the whole multi-repo sequence — a per-repo lock would let
# an apply interleave between repos and tear the multi-repo snapshot. A live
# holder loud-fails; there is no retry loop.
snapshot_lock_begin() {
  mkdir -p -- "${REPORTS_DIR}"
  apply_lock_acquire "${LOCK_DIR}"
  if [[ "${apply_lock_acquired}" != true ]]; then
    die "another apply in progress — retry after it completes (${LOCK_DIR})" "${EXIT_LOCK_HELD}"
  fi
  LOCK_HELD=1
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --trigger)
        if [[ $# -lt 2 ]]; then
          log "--trigger requires a value (post-deploy|manual-reconcile)"
          usage
          exit "${EXIT_ARGS}"
        fi
        TRIGGER="$2"
        shift
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        log "unknown argument: $1"
        usage
        exit "${EXIT_ARGS}"
        ;;
    esac
    shift
  done
  case "${TRIGGER}" in
    post-deploy | manual-reconcile) ;;
    *)
      log "invalid --trigger: ${TRIGGER} (expected post-deploy|manual-reconcile)"
      usage
      exit "${EXIT_ARGS}"
      ;;
  esac
  readonly DRY_RUN TRIGGER

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'log "ERROR: line ${LINENO}: ${BASH_COMMAND}"' ERR

  # Validate ALL dirs before mutating ANY — a missing repo dir loud-fails with
  # zero partial side effects.
  [[ -d "${GA_ROOT}" ]] || die "GA root not found: ${GA_ROOT}" "${EXIT_MISSING_DIR}"
  local rel dir
  for rel in "${LIVE_REPOS[@]}"; do
    [[ -d "${GA_ROOT}/${rel}" ]] || die "repo dir missing: ${GA_ROOT}/${rel}" "${EXIT_MISSING_DIR}"
  done

  snapshot_lock_begin
  snapshot_release_label
  log "start (root=${GA_ROOT} trigger=${TRIGGER} release=${VERSION_LABEL} dry-run=${DRY_RUN})"

  TMP_DIR="$(mktemp -d -t snapshot-live-repos.XXXXXX)"

  # Phase 1 — record every repo's candidate set and screen it. Screening ALL
  # seven before committing ANY is what makes a refusal all-or-nothing.
  local idx=0
  for rel in "${LIVE_REPOS[@]}"; do
    dir="${GA_ROOT}/${rel}"
    idx=$((idx + 1))
    if [[ ! -e "${dir}/.git" ]]; then
      log "not a repo (git-less install — n/a): ${rel}"
      continue
    fi
    git -C "${dir}" status --porcelain -z --untracked-files=all >"${TMP_DIR}/status.${idx}"
    snapshot_screen_repo "${rel}" "${TMP_DIR}/status.${idx}"
  done
  if [[ "${SCREEN_HITS}" -gt 0 ]]; then
    die "refusal screen matched ${SCREEN_HITS} path(s) — nothing staged, nothing committed" "${EXIT_REFUSED}"
  fi

  # Phase 2 — report, then record. Ordered per repo so the operator sees each
  # diffstat immediately before the commit it produces.
  local recorded=0 clean=0 absent=0
  idx=0
  for rel in "${LIVE_REPOS[@]}"; do
    dir="${GA_ROOT}/${rel}"
    idx=$((idx + 1))
    if [[ ! -e "${dir}/.git" ]]; then
      absent=$((absent + 1))
      continue
    fi
    if [[ ! -s "${TMP_DIR}/status.${idx}" ]]; then
      log "clean, no-op: ${rel}"
      clean=$((clean + 1))
      continue
    fi
    snapshot_report_repo "${rel}" "${dir}"
    snapshot_commit_repo "${rel}" "${dir}"
    recorded=$((recorded + 1))
  done

  log "done: ${recorded} with pending changes, ${clean} already clean, ${absent} not a repo (dry-run=${DRY_RUN})"
}

main "$@"
