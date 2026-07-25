#!/usr/bin/env bash
# init-test-repos.sh — idempotent per-dir git init for the three test corpora
# (test/ hooks/test/ scripts/test/ under the GA root), so live-install corpus
# edits get git recovery like the rules/agents/autoagent/monitor repos.
#
# Usage:
#   init-test-repos.sh              # GA_ROOT env overrides ~/.glass-atrium
#
# Exit codes:
#   0  all corpora initialized or already repos (no-op)
#   1  precondition failure (git missing)
#   3  corpus dir missing (loud-fail, nothing initialized)

set -Eeuo pipefail
IFS=$'\n\t'

# GA_ROOT: live install root by default; env override for tests / alternate roots
# (same idiom as wiki-init-db.sh WIKI_ROOT).
GA_ROOT="${GA_ROOT:-${HOME}/.glass-atrium}"
readonly GA_ROOT
# Scope is EXACTLY these three relative dirs — the live repos (rules/ agents/
# autoagent/ monitor/) and the GA root itself are never candidates.
readonly CORPUS_DIRS=('test' 'hooks/test' 'scripts/test')
readonly EXIT_MISSING_DIR=3

log() { printf '[init-test-repos] %s\n' "$*" >&2; }
die() {
  local code="${2:-1}"
  printf '[init-test-repos] ERROR: %s\n' "$1" >&2
  exit "${code}"
}

command -v git >/dev/null 2>&1 || die "git not in PATH"

# Validate ALL dirs before mutating ANY — a missing corpus loud-fails with zero
# partial side effects.
[[ -d "${GA_ROOT}" ]] || die "GA root not found: ${GA_ROOT}" "${EXIT_MISSING_DIR}"
for rel in "${CORPUS_DIRS[@]}"; do
  [[ -d "${GA_ROOT}/${rel}" ]] || die "corpus dir missing: ${GA_ROOT}/${rel}" "${EXIT_MISSING_DIR}"
done

for rel in "${CORPUS_DIRS[@]}"; do
  dir="${GA_ROOT}/${rel}"
  if [[ -e "${dir}/.git" ]]; then
    log "already a repo, no-op: ${rel}"
    continue
  fi
  log "initializing: ${rel}"
  git -C "${dir}" init --quiet
  git -C "${dir}" add -A
  git -C "${dir}" commit --quiet -m 'Initialize test-corpus version control'
done

log "ready: ${#CORPUS_DIRS[@]} corpus repos under ${GA_ROOT}"
