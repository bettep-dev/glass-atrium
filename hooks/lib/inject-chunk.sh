#!/usr/bin/env bash
# inject-chunk.sh — the shared library every chunk slot of the split SubagentStart
# scope-rule channel sources. It is a LIBRARY: sourcing it defines functions and runs
# nothing.
#
# Twelve SubagentStart bindings ARE TO SHIP. Slot 1 is inject-scope-rules.sh, which carries
# the kept marker blocks and no chunk; slots 2..12 are to be argument-free wrappers, one
# basename each, carrying parts 01..11. Today three bindings are registered (the architecture
# invariant reads `SubagentStart: 3`) and NO wrapper exists yet — stage 2 authors them. A
# binding carries no argument, so a wrapper will name its part in its own basename —
# `inject-scope-part-<NN>.sh` — or export GA_CHUNK_PART before sourcing. The wrapper body
# stage 2 is to write is:
#
#   #!/usr/bin/env bash
#   set -Eeuo pipefail
#   IFS=$'\n\t'
#   # shellcheck source=lib/inject-chunk.sh
#   source "${BASH_SOURCE%/*}/lib/inject-chunk.sh"
#   ga_chunk_inject
#
# Selection, packing, counting and the warning-token set all live in the python core
# (lib/inject_chunk.py): bash cannot count UTF-16 code units and jq counts code points.
# This file is the envelope seam only — read agent_type, resolve the part, pass the core's
# stdout through.
#
# fail-open, like every SubagentStart hook: a missing core, a missing python3, an empty
# envelope or any internal error yields exit 0. A spawn with no scope rules is survivable; a
# spawn killed by its own hook is not. Fail-open is not fail-silent, though: each abort that
# costs the agent its parts is recorded on the core's own sink as well as stderr (see
# ga_chunk_warn), because the engine discards this channel's stderr.

# Double-source guard.
# shellcheck disable=SC2317
#   SC2317-unreachable is a source-context-unaware false-positive on this return-after-||-true guard.
if [[ -n "${_GA_CHUNK_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _GA_CHUNK_LIB_LOADED=1

# shellcheck source-path=SCRIPTDIR source=../hook-utils.sh
source "${BASH_SOURCE[0]%/*}/../hook-utils.sh"

readonly GA_CHUNK_CORE="${GA_CHUNK_CORE:-${BASH_SOURCE[0]%/*}/inject_chunk.py}"

# Seam fault token + sink bound, MIRRORED from the core's SoT (lib/inject_chunk.py:
# EVENT_SEAMFAULT, SINK_MAX_BYTES). A mirror rather than a read because the seam aborts in states
# where the core cannot run at all — a missing python3 is exactly one — so reading the constant is
# unavailable precisely when it is needed. inject-scope-chunker.bats cross-reads this literal
# against the core's `--print-events` output, so the two cannot drift silently.
readonly GA_CHUNK_SEAM_EVENT="SEAMFAULT"
readonly GA_CHUNK_SINK_MAX_BYTES=1048576

# Resolve the sink the core writes, honouring the same two overrides in the same order.
ga_chunk_sink_path() {
  local root="${GA_CHUNK_RULES_ROOT:-${HOME}/.glass-atrium}"
  printf '%s' "${GA_CHUNK_SINK:-${root}/logs/inject-scope-chunk.diag.log}"
}

# Record a seam abort on BOTH durable channels. WHY the sink and not stderr alone: Claude Code
# DISCARDS SubagentStart hook stderr, so a stderr-only abort leaves no trace anywhere — a missing
# python3 on an install would hand every agent zero scope-rule bodies with nothing to find
# afterwards, which is the silent-failure class this channel exists to close. The sink append is the
# log-aggregator leg of the Precondition Loud-Fail remedy triad; every failure in it is swallowed,
# because a hook that breaks a spawn is worse than a lost log line.
# Args: $1=detail · $2=agent type (optional; the early aborts run before the envelope is read).
ga_chunk_warn() {
  local detail="${1}" agent="${2:-unknown}" sink stamp size
  printf '[inject-scope-chunk] %s agent=%s %s\n' "${GA_CHUNK_SEAM_EVENT}" "${agent}" "${detail}" >&2
  sink="$(ga_chunk_sink_path)"
  # Only shell out for the directory when it is genuinely absent: the append itself is a bash
  # redirect, so a seam abort caused by a broken PATH (the python3-missing case) still records.
  [[ -d "${sink%/*}" ]] || mkdir -p "${sink%/*}" 2>/dev/null || return 0
  if [[ -f "${sink}" ]]; then
    size="$(wc -c <"${sink}" 2>/dev/null | tr -cd '0-9' || true)"
    if [[ -n "${size}" && "${size}" -gt "${GA_CHUNK_SINK_MAX_BYTES}" ]]; then
      rm -f "${sink}" 2>/dev/null || true
    fi
  fi
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  printf '%s [inject-scope-chunk] %s agent=%s %s\n' \
    "${stamp}" "${GA_CHUNK_SEAM_EVENT}" "${agent}" "${detail}" >>"${sink}" 2>/dev/null || true
  return 0
}

# Part index this slot carries: the GA_CHUNK_PART override wins (the Bats sandbox binds no
# wrapper), otherwise the trailing digits of the calling wrapper's basename.
# Args: $1=caller path · stdout: part index, empty when underivable.
ga_chunk_part() {
  local raw="${GA_CHUNK_PART:-}" base
  if [[ -z "${raw}" ]]; then
    base="${1##*/}"
    base="${base%.sh}"
    raw="${base##*-}"
  fi
  printf '%s' "${raw}" | tr -cd '0-9'
}

# Emit this slot's part for the spawning agent. Reads the SubagentStart envelope on stdin.
ga_chunk_inject() {
  local caller="${BASH_SOURCE[1]:-${0}}" part agent input out

  part="$(ga_chunk_part "${caller}")"
  if [[ -z "${part}" ]]; then
    ga_chunk_warn "part index underivable from caller=${caller}; slot skipped"
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    ga_chunk_warn "python3 not on PATH; slot skipped (part=${part})"
    return 0
  fi
  if [[ ! -f "${GA_CHUNK_CORE}" ]]; then
    ga_chunk_warn "core absent: ${GA_CHUNK_CORE}; slot skipped (part=${part})"
    return 0
  fi

  input="$(hook_read_input)"
  [[ "${input}" == "{}" ]] && return 0
  agent="$(hook_get_field "${input}" "agent_type")"
  [[ -z "${agent}" ]] && return 0

  out="$(python3 "${GA_CHUNK_CORE}" --agent "${agent}" --part "$((10#${part}))" || true)"
  # An empty core stdout is the sanctioned no-op for a slot above this agent's part count:
  # no JSON, no empty additionalContext.
  [[ -n "${out}" ]] && printf '%s\n' "${out}"
  return 0
}
