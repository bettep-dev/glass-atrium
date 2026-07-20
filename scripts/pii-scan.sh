#!/usr/bin/env bash
# pii-scan.sh — PII release-gate scanner (personal paths · emails · hostnames).
#
# Blocks the publisher's personal identifying strings from leaking into release
#   artifacts. Called by the release-gate (T62) PII stage; the artifact-tree
#   check (T01) reuses directory mode.
# Patterns are derived at runtime from machine-identifying info ($HOME · $USER ·
#   git user.email · hostname) — hardcoding them would itself become tracked
#   PII, so that is forbidden. Single exception: the approved-disclosure
#   identifier constants (APPROVED_MAINTAINER_IDS — not PII per the maintainer
#   disclosure decision, see below).
# tracked mode reports two separate checks: worktree-clean (git grep) ·
#   history-clean (git log -S pickaxe). A clean worktree can still leave PII in
#   history, so the two checks report via independent exit bits.
#
# Usage:
#   pii-scan.sh                  scan the git TRACKED set (worktree + history, release-gate)
#   pii-scan.sh --worktree-only  skip the history check (worktree only)
#   pii-scan.sh <dir>...         recursive scan of arbitrary trees (artifact mode, .git/node_modules excluded)
#
# Exit (bitwise-OR composition — separates the two checks in tracked mode):
#   0 = all clean
#   1 = worktree hit (worktree PII — gate FAIL, fix immediately)
#   2 = precondition unmet (no git / not a git repo / bad arguments)
#   4 = history hit (history PII — a non-approved identifier persists in commit history, reported separately)
#   5 = worktree(1) + history(4) both hit · dir mode uses 0/1/2 only.
set -Eeuo pipefail
IFS=$'\n\t'

GA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly GA_ROOT

trap 'echo "[pii-scan] ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

log() { printf '[pii-scan] %s\n' "$*"; }
fail() {
  printf '[pii-scan] ERROR: %s\n' "$*" >&2
  exit 2
}

# Approved-disclosure identifier allowlist — maintainer disclosure decision
#   (user-approved 2026-07-20).
# The maintainer identifiers (bettep username · /Users/bettep home path ·
#   hongdaesik88 email) are cleared for public-repo exposure — the
#   "hardcoding = tracked PII" principle inverts for approved identifiers (not
#   PII per the disclosure decision). A derived pattern is excluded at
#   collection time ONLY on an EXACT full-string match against a list entry —
#   partial/regex matching forbidden. Everything else (hostnames · future
#   contributor emails/usernames) stays scanned.
APPROVED_MAINTAINER_IDS=(
  "bettep"
  "/Users/bettep"
  "hongdaesik88@gmail.com"
)
readonly APPROVED_MAINTAINER_IDS

# Pattern derivation
# Two parallel arrays (bash 3.2 — no associative arrays): PATTERNS[i] = fixed string,
# WORD_FLAGS[i] = "w" (word-boundary match — suppresses short-token partial-match false positives) or "".
PATTERNS=()
WORD_FLAGS=()

add_pattern() {
  # $1 = fixed string · $2 = "w" | "" — empty/duplicate/approved-disclosure identifiers are ignored (each pattern scanned once)
  local pat="$1" flag="${2:-}" existing approved
  [[ -n "${pat}" ]] || return 0
  for approved in "${APPROVED_MAINTAINER_IDS[@]}"; do
    if [[ "${pat}" == "${approved}" ]]; then
      # The pattern value itself keeps the existing masking convention (log length only)
      log "note: approved-disclosure identifier skipped (${#pat} chars)"
      return 0
    fi
  done
  for existing in "${PATTERNS[@]+"${PATTERNS[@]}"}"; do
    [[ "${existing}" == "${pat}" ]] && return 0
  done
  PATTERNS+=("${pat}")
  WORD_FLAGS+=("${flag}")
}

collect_patterns() {
  local email host local_host user
  # Prevents a set -u abort where USER is unset (root containers/cron/launchd/bash -lc) —
  #   prefer USER, else derive once via id -un and apply the same value to both patterns.
  user="${USER:-$(id -un)}"
  add_pattern "${HOME}" ""
  add_pattern "/Users/${user}" ""
  add_pattern "${user}" "w"
  email="$(git -C "${GA_ROOT}" config user.email 2>/dev/null || true)"
  if [[ -n "${email}" ]]; then
    add_pattern "${email}" ""
  else
    log "note: git user.email unset — email pattern skipped"
  fi
  host="$(hostname -s 2>/dev/null || true)"
  add_pattern "${host}" "w"
  if command -v scutil >/dev/null 2>&1; then
    local_host="$(scutil --get LocalHostName 2>/dev/null || true)"
    add_pattern "${local_host}" "w"
  fi
}

# Public-identifier precision filter
# "<user>-dev" = the project's public GitHub org token — an identifier
#   deliberately exposed in release URLs (README · install.sh · pricing.json
#   update endpoint). grep -w treats the hyphen as a word boundary and
#   false-positives on the username substring inside the org token.
# Narrowly scoped (not a global gate relaxation): applies only to word-boundary
#   (w) patterns, and instead of allowing the whole line, only the org token is
#   stripped before re-checking — a real username outside the org token on the
#   same line still FAILs. The token derives from the runtime $USER (hardcoding
#   it here would itself become tracked PII).
filter_public_org() {
  # $1 = pattern · stdin = hit lines → pass through only lines that still match after the allowed token is stripped
  local pat="$1" line stripped
  while IFS= read -r line; do
    stripped="${line//"${pat}-dev"/}"
    if printf '%s\n' "${stripped}" | grep -q -w -F -e "${pat}"; then
      printf '%s\n' "${line}"
    fi
  done
}

# Scans (per mode)
# Output = matching lines (file:line:content) → the caller gates on hit presence.
# grep exit 1 (no match) is normal → || true. All pattern matching is -F fixed-string.
scan_tracked() {
  local pat="$1" flag="$2"
  if [[ "${flag}" == "w" ]]; then
    git -C "${GA_ROOT}" grep -I -n -w -F -e "${pat}" -- ':!node_modules' || true
  else
    git -C "${GA_ROOT}" grep -I -n -F -e "${pat}" -- ':!node_modules' || true
  fi
}

scan_tree() {
  local pat="$1" flag="$2" dir="$3"
  if [[ "${flag}" == "w" ]]; then
    grep -R -I -n -w -F -e "${pat}" \
      --exclude-dir=.git --exclude-dir=node_modules -- "${dir}" || true
  else
    grep -R -I -n -F -e "${pat}" \
      --exclude-dir=.git --exclude-dir=node_modules -- "${dir}" || true
  fi
}

# Tracked-HISTORY pickaxe — whether the pattern ever appeared in a HEAD-reachable commit.
# Uses -S (substring): the word-boundary flag only suppresses worktree false
#   positives; in history even a partial match is a real leak, so substring is
#   the correct signal. --all omitted — scoped to the same HEAD history range
#   as the git grep worktree mode. Output = the matching commits, oneline.
scan_history() {
  local pat="$1"
  git -C "${GA_ROOT}" log -S "${pat}" --oneline -- ':!node_modules' || true
}

# Check functions return the hit-pattern count via the global CHECK_HITS — the
#   human-readable hit lines go to stdout, so capturing the count via command
#   substitution would mix the two streams. bash 3.2 compatible (no name-refs) +
#   the serial-daemon assumption makes a single global slot safe.
CHECK_HITS=0

# Worktree check — git grep (tracked mode) or grep -R (dir mode).
# CHECK_HITS = number of patterns that hit (>0 → worktree FAIL). Dir arguments arrive as positionals.
scan_worktree_check() {
  local mode="$1"
  shift
  local i pat flag hits dir
  CHECK_HITS=0
  for i in "${!PATTERNS[@]}"; do
    pat="${PATTERNS[${i}]}"
    flag="${WORD_FLAGS[${i}]}"
    if [[ "${mode}" == "tracked" ]]; then
      hits="$(scan_tracked "${pat}" "${flag}")"
    else
      hits=""
      for dir in "$@"; do
        hits+="$(scan_tree "${pat}" "${flag}" "${dir}")"
      done
    fi
    if [[ -n "${hits}" && "${flag}" == "w" ]]; then
      hits="$(printf '%s\n' "${hits}" | filter_public_org "${pat}")"
    fi
    if [[ -n "${hits}" ]]; then
      # The pattern itself (personal info) is masked in the log — the hit lines alone locate the finding
      log "WORKTREE HIT pattern #$((i + 1)) (${#pat} chars):"
      printf '%s\n' "${hits}"
      CHECK_HITS=$((CHECK_HITS + 1))
    fi
  done
}

# History check (tracked mode only) — sums pickaxe commit counts per pattern.
# CHECK_HITS = number of patterns that hit (>0 → history FAIL — a non-approved identifier persists in history).
scan_history_check() {
  local i pat hits commit_count
  CHECK_HITS=0
  for i in "${!PATTERNS[@]}"; do
    pat="${PATTERNS[${i}]}"
    hits="$(scan_history "${pat}")"
    if [[ -n "${hits}" ]]; then
      commit_count="$(printf '%s\n' "${hits}" | grep -c '' || true)"
      [[ -z "${commit_count}" ]] && commit_count=0
      log "HISTORY HIT pattern #$((i + 1)) (${#pat} chars) — ${commit_count} commit(s):"
      printf '%s\n' "${hits}"
      CHECK_HITS=$((CHECK_HITS + 1))
    fi
  done
}

main() {
  command -v git >/dev/null 2>&1 || fail "git not found"

  local worktree_only=""
  if [[ "${1:-}" == "--worktree-only" ]]; then
    worktree_only="1"
    shift
  fi

  local mode
  if [[ $# -eq 0 ]]; then
    mode="tracked"
    git -C "${GA_ROOT}" rev-parse --git-dir >/dev/null 2>&1 \
      || fail "not a git repo: ${GA_ROOT} (tracked-set mode needs the GA repo)"
  else
    mode="dir"
    [[ -z "${worktree_only}" ]] || fail "--worktree-only is tracked-mode only (no dir args allowed)"
    local dir
    for dir in "$@"; do
      [[ -d "${dir}" ]] || fail "not a directory: ${dir}"
    done
  fi

  collect_patterns
  log "patterns: ${#PATTERNS[@]} (derived from HOME/USER/email/hostname)"

  # Check 1: worktree-clean
  local exit_code=0
  log "check 1/2: worktree-clean (${mode} mode)"
  scan_worktree_check "${mode}" "$@"
  if [[ "${CHECK_HITS}" -gt 0 ]]; then
    log "worktree-clean: FAIL — ${CHECK_HITS}/${#PATTERNS[@]} pattern(s) hit (publication halt — fix the worktree)"
    exit_code=$((exit_code | 1))
  else
    log "worktree-clean: PASS — 0 hits across ${#PATTERNS[@]} patterns"
  fi

  # Check 2: history-clean (tracked mode + not --worktree-only)
  if [[ "${mode}" == "tracked" && -z "${worktree_only}" ]]; then
    log "check 2/2: history-clean (tracked HISTORY via git log -S)"
    scan_history_check
    if [[ "${CHECK_HITS}" -gt 0 ]]; then
      log "history-clean: FAIL — ${CHECK_HITS}/${#PATTERNS[@]} pattern(s) present in history"
      log "  → worktree is independent of this; a non-approved identifier persists in tracked history"
      exit_code=$((exit_code | 4))
    else
      log "history-clean: PASS — 0 patterns present in tracked history"
    fi
  else
    log "check 2/2: history-clean SKIPPED (${mode} mode or --worktree-only)"
  fi

  if [[ "${exit_code}" -eq 0 ]]; then
    log "ALL CLEAN — worktree + history (or scoped to worktree)"
  else
    log "GATE RESULT exit=${exit_code} (1=worktree, 4=history, 5=both)"
  fi
  exit "${exit_code}"
}

main "$@"
