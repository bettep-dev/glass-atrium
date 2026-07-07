#!/usr/bin/env bash
# hooks/lib/hook-utils.sh — monitor-port resolver wrapper for hook scripts.
#
# Usage: source "${BASH_SOURCE%/*}/lib/hook-utils.sh"; port="$(hook_monitor_port)"
#
# Env-preferring (ADR-1 R2): returns an exported ATRIUM_MONITOR_PORT directly on
# the hot per-tool-use path (no file read); on an env miss — the COMMON case at
# hook runtime, since render-monitor-env.sh writes the value into monitor/.env
# but never `export`s it — it DELEGATES to atrium_monitor_port in
# scripts/lib/atrium-config.sh (one cheap .env read). This wrapper carries NO
# literal port default of its own; the single terminal default (16145) lives in
# the resolver.
#
# Install-root resolution (AC-S1.3b): this file's real home is
# ${GA_ROOT}/hooks/lib/hook-utils.sh but hooks reach it through the ~/.claude/
# hooks symlink farm. It realpath-follows its OWN symlink to the real
# ${GA_ROOT}/hooks/lib location and derives ${GA_ROOT} = ../.. from there, then
# sources the GA-root-sibling scripts/lib/atrium-config.sh. It MUST NOT compute a
# BASH_SOURCE-relative ../scripts from the ~/.claude/hooks symlink directory —
# that resolves to the non-existent ~/.claude/scripts. An explicit GA_ROOT env
# short-circuits the symlink walk (sandbox/test override).
#
# Compatibility: Bash 3.2+ (macOS stock) — no readlink -f / realpath dependency.

# Guard against double-sourcing (distinct marker from the top-level hook-utils.sh
# so both may coexist in a hook's source set).
if [[ -n "${_HOOK_UTILS_PORT_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _HOOK_UTILS_PORT_LOADED=1

# Follow a (possibly symlinked) file path to its real containing directory —
# portable BSD/GNU (no readlink -f / realpath). The readlink loop resolves a
# file-level symlink; the terminal `pwd -P` additionally resolves symlinked
# directory components, so a symlink at EITHER the file or a parent dir lands on
# the real location. Args: $1 = starting path. Echoes the real directory.
_hook_utils_real_dir() {
  local src="$1" dir target
  while [[ -L "${src}" ]]; do
    dir="$(cd -- "$(dirname -- "${src}")" && pwd -P)"
    target="$(readlink "${src}")"
    case "${target}" in
      /*) src="${target}" ;;       # absolute symlink target
      *) src="${dir}/${target}" ;; # relative → resolve against the link's dir
    esac
  done
  cd -- "$(dirname -- "${src}")" && pwd -P
}

# Resolve the ${GA_ROOT} install root from THIS file's real location
# (${GA_ROOT}/hooks/lib → ../..), honoring an explicit GA_ROOT override first.
_hook_utils_ga_root() {
  if [[ -n "${GA_ROOT:-}" ]]; then
    printf '%s\n' "${GA_ROOT}"
    return 0
  fi
  local self_dir
  self_dir="$(_hook_utils_real_dir "${BASH_SOURCE[0]}")"
  cd -- "${self_dir}/../.." && pwd -P
}

# Effective monitor port for hook scripts. Env-prefer (hot path, trusts the
# value the running monitor exported), else delegate to the shared resolver.
# NO literal port default here. rc 1 (with the resolver's stderr) on a
# misconfigured value or an unlocatable atrium-config.sh.
hook_monitor_port() {
  if [[ -n "${ATRIUM_MONITOR_PORT:-}" ]]; then
    printf '%s\n' "${ATRIUM_MONITOR_PORT}"
    return 0
  fi
  local ga_root config_lib
  ga_root="$(_hook_utils_ga_root)"
  config_lib="${ga_root}/scripts/lib/atrium-config.sh"
  if [[ ! -f "${config_lib}" ]]; then
    printf 'hook-utils: cannot locate atrium-config.sh at %s\n' "${config_lib}" >&2
    return 1
  fi
  # shellcheck source=/dev/null
  . "${config_lib}"
  atrium_monitor_port
}
