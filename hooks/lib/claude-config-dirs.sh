#!/usr/bin/env bash
# claude-config-dirs.sh — the `~/.claude*` config-root grammar, declared once. Declaration-only,
# sourced by enforce-foreground-harness.sh (Rule-2 path scan + BASENAME-exception strip),
# validate-scope-drift.sh (system-path short-circuit) and enforce-harness-critical.sh (Write/Edit
# dispatch), so no consumer can lag behind a newly created profile branch. Bash 3.2+ (macOS stock).
#
# `nocasematch` is deliberately never touched here: every predicate uses [[ ]], so each consumer's
# AMBIENT setting governs — the critical hook's shell-global nocasematch keeps its case-insensitive
# contract while the foreground hook stays case-sensitive, from one code path.

# Double-source guard.
# shellcheck disable=SC2317
#   SC2317-unreachable is a source-context-unaware false-positive on this return-after-||-true guard.
if [[ -n "${_CLAUDE_CONFIG_DIRS_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _CLAUDE_CONFIG_DIRS_LOADED=1

# POSIX ERE fragment: a config root plus its trailing separator — `.claude/` and every
# `.claude-<branch>/` profile dir. The suffix must open with an alnum (so a bare `.claude-` is not a
# root, and `.claudex` cannot match) and its character class excludes `/` (so it can never
# over-reach into the path tail). Consumers compose their own anchor/prefix around it; grep -E and
# bash `[[ =~ ]]` are both POSIX ERE, so ONE string serves both dialects.
# shellcheck disable=SC2034
#   CLAUDE_CONFIG_ROOT_RE is read by the source-er — an intended export of this declaration-only file.
readonly CLAUDE_CONFIG_ROOT_RE='\.claude(-[A-Za-z0-9][A-Za-z0-9._-]*)?/'

# Strip a leading config-root prefix in any of its three forms (`${HOME}/`, `~/`, bare) and print
# the remainder. A non-matching path is printed unchanged. The home prefix is removed as a FIXED
# STRING (case-sensitive), matching the literal strips this replaces; the root itself is removed via
# BASH_REMATCH[0], so the helper stays independent of the fragment's internal group count.
# Args: $1=path  $2=home (default $HOME). Prints the remainder.
claude_config_strip_branch_root() {
  local path="${1}" home="${2-${HOME:-}}" rest
  [[ -n "${home}" ]] && path="${path#"${home}/"}"
  path="${path#\~/}"
  rest="${path}"
  # RHS unquoted — a quoted regex would be matched literally (bash 3.2+).
  if [[ "${rest}" =~ ^${CLAUDE_CONFIG_ROOT_RE} ]]; then
    rest="${rest#"${BASH_REMATCH[0]}"}"
  fi
  printf '%s\n' "${rest}"
}

# settings-class membership: settings.json / settings.local.json directly under any branch root of
# the given home. The home prefix is compared with [[ == ]] + a length slice rather than a
# fixed-string strip so an ambient nocasematch still folds the home segment — a fixed strip would
# silently narrow the critical hook's current case-insensitive coverage.
# Args: $1=normalized absolute path  $2=home (default $HOME). Exit status = membership.
claude_config_is_settings_path() {
  local home="${2-${HOME:-}}" rest
  [[ -n "${home}" && "${1}" == "${home}/"* ]] || return 1
  rest="${1:${#home}+1}"
  [[ "${rest}" =~ ^${CLAUDE_CONFIG_ROOT_RE}settings(\.local)?\.json$ ]]
}

# hooks-dir membership: anything below `hooks/` of any branch root of the given home.
# Args: $1=normalized absolute path  $2=home (default $HOME). Exit status = membership.
claude_config_is_hooks_dir_path() {
  local home="${2-${HOME:-}}" rest
  [[ -n "${home}" && "${1}" == "${home}/"* ]] || return 1
  rest="${1:${#home}+1}"
  [[ "${rest}" =~ ^${CLAUDE_CONFIG_ROOT_RE}hooks/ ]]
}

# Any-branch containment. The required leading `/` keeps this exactly as wide as the `*/.claude/*`
# globs it replaces — a bare relative `.claude/x` is deliberately NOT matched.
# Args: $1=path. Exit status = containment.
claude_config_is_branch_path() {
  [[ "${1}" =~ /${CLAUDE_CONFIG_ROOT_RE} ]]
}
