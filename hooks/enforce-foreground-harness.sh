#!/usr/bin/env bash
# enforce-foreground-harness.sh — PreToolUse(Agent) gate enforcing
# Harness Path Protection Rule 2 (orchestrator-role.md).
#
# Blocks sub-agent delegations targeting ~/.claude/ or any ~/.claude-* profile branch config dir with
# run_in_background=true. The user MUST inspect harness/memory writes in real time — background spawns
# hide diffs and silently break future sessions; this hook is the deterministic runtime gateway an
# LLM-side self-check cannot guarantee. Trigger: matcher "Agent" (registered in ~/.claude/settings.json).
#
# Contract: stdin = JSON (tool_name, tool_input{prompt, run_in_background}) · stdout silent · stderr =
#   the block reason on violation · exit 2 = block · exit 0 = pass / fail-open on internal error
#   (defense-in-depth — one of several layers, never break the session).
#
# BASENAME exception:
#   CLAUDE.md, MEMORY.md, GLASS_ATRIUM_GLOBAL_RULES.md may be written directly. If every
#   harness-path occurrence in the prompt resolves to one of these basenames, the call is exempt.
#
# Runtime-DATA exclusion: Rule 2 protects harness CONFIG writes (agents/, hooks/, skills/,
#   settings*.json, the memory dir). Runtime-DATA subdirs (data/, projects/, logs/, todos/,
#   shell-snapshots/, statsig/) hold transcripts/logs/caches that CANNOT misconfigure a future session,
#   so a bare reference (a text scan cannot tell READ from WRITE) must not force foreground. The memory
#   dir nests under projects/ and stays protected via a /memory/ segment guard, never leaking into memory writes.
#
# Source: rules/glass-atrium/orchestrator-role.md → Harness Path Protection.

set -Eeuo pipefail
IFS=$'\n\t'

# Diagnostic ERR trap — stderr only, fail-open (exit 0), never blocks the user.
trap 'printf "[enforce-foreground-harness] internal error at line %d: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Drain stdin into a variable. cat failure is tolerated (empty input → fail-open).
input=""
if [[ ! -t 0 ]]; then
  input="$(cat 2>/dev/null)" || input=""
fi

# Empty payload → nothing to check.
if [[ -z "${input}" ]]; then
  exit 0
fi

# jq absence = system misconfiguration → fail-open with a stderr note, not a block.
if ! command -v jq >/dev/null 2>&1; then
  printf '[enforce-foreground-harness] jq not found on PATH; skipping check\n' >&2
  exit 0
fi

# Extract tool_name. Non-Agent calls are out of scope.
tool_name=""
tool_name="$(printf '%s' "${input}" | jq -r '.tool_name // ""' 2>/dev/null)" || tool_name=""
if [[ "${tool_name}" != "Agent" ]]; then
  exit 0
fi

# Measurement capture (plan clauded-docs/43753 Stream 0b): one JSON line per Agent call under the data root.
#   Records the CLI version, envelope + tool_input key NAMES and run_in_background's type, its value only
#   when boolean or "true"/"false" — never prompt text or any other value. Best-effort: never alters the verdict.
capture_data_dir="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data"
capture_agent_envelope() {
  local transcript version=""
  version="$(printf '%s' "${input}" | jq -r '.version | strings' 2>/dev/null)" || version=""
  transcript="$(printf '%s' "${input}" | jq -r '.transcript_path // ""' 2>/dev/null)" || transcript=""
  if [[ -z "${version}" && -n "${transcript}" && -r "${transcript}" ]]; then
    version="$(tail -n 1 -- "${transcript}" | jq -r '.version // ""' 2>/dev/null)" || version=""
  fi
  mkdir -p -- "${capture_data_dir}" 2>/dev/null || return 0
  printf '%s' "${input}" | jq -c --arg v "${version}" '
    (.tool_input | if type == "object" then . else {} end) as $t
    | {ts: (now | todate), cli_version: $v, envelope_keys: keys, tool_input_keys: ($t | keys),
       run_in_background: (if ($t | has("run_in_background")) then
         ($t.run_in_background as $b | {type: ($b | type),
           value: (if ($b | type) == "boolean" or $b == "true" or $b == "false" then $b else null end)})
       else null end)}' 2>/dev/null >>"${capture_data_dir}/hpp-agent-capture.jsonl"
}
# Gate: env var for a fresh session, flag file for a running one (hook config is snapshotted at session start).
if [[ "${GA_HPP_AGENT_CAPTURE:-}" == "1" || -e "${capture_data_dir}/hpp-agent-capture.on" ]]; then
  # shellcheck disable=SC2310  # best-effort capture: a failure inside must neither exit nor fire the ERR trap
  capture_agent_envelope || true
fi

# Extract prompt body + run_in_background flag. Absent run_in_background → "false"
# (Claude Code semantics: optional param, foreground is the default).
prompt=""
prompt="$(printf '%s' "${input}" | jq -r '.tool_input.prompt // ""' 2>/dev/null)" || prompt=""
run_bg=""
run_bg="$(printf '%s' "${input}" | jq -r '.tool_input.run_in_background // false | tostring' 2>/dev/null)" || run_bg="false"

# Foreground (or unset) → no Rule-2 risk regardless of paths.
if [[ "${run_bg}" != "true" ]]; then
  exit 0
fi

# Empty prompt → nothing to scan.
if [[ -z "${prompt}" ]]; then
  exit 0
fi

# Branch-root grammar, single-sited in lib/. Sourced HERE — after the foreground and empty-prompt
# early exits — so a missing lib fails CLOSED on background calls only (a security gate must never
# degrade silently) while the common foreground path never pays the source cost.
config_dirs_lib="${BASH_SOURCE%/*}/lib/claude-config-dirs.sh"
# shellcheck source=lib/claude-config-dirs.sh
if [[ ! -r "${config_dirs_lib}" ]] || ! source "${config_dirs_lib}"; then
  # Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored → exit 2 stands.
  (printf '%s\n' '[enforce-foreground-harness] Harness Path Protection Rule 2 gate degraded (fail-closed): lib/claude-config-dirs.sh is unreadable, so harness paths cannot be classified. Set run_in_background=false (or omit) and repair the hook install.') >&2 || true
  exit 2
fi

# Resolve the installing user's home at runtime → both the harness regex and the
# prefix-strip loop (below) match `${HOME}/.claude.../` in addition to `~/`.
# Dual-form coverage: a prompt may write the harness path in absolute-home form,
# so dropping the absolute arm would reopen a bypass hole.
home_dir="${HOME:-}"
# Regex-escape the home prefix for safe inclusion in the grep -E alternation
# (a literal `.` or other metachar in $HOME must not act as a regex operator).
home_re=""
if [[ -n "${home_dir}" ]]; then
  home_re="$(printf '%s' "${home_dir}" | sed -e 's/[][\\.^$*+?(){}|/]/\\&/g')"
fi

# Scan the prompt for harness path occurrences — each match is a path token from any `.claude*`
# config root up to the next whitespace / quote / backtick / closing paren-or-bracket (so we can resolve
# its basename). grep -oE prints one match per line; sort -u dedupes. `|| true` absorbs grep's
# exit-1 no-match so pipefail does not trip the ERR trap when there are no harness paths.
#
# Three alternations: tilde form (`~/.claude.../`) always; absolute-home form (`${HOME}/.claude.../`)
# only when $HOME is known (regex-escaped runtime home — installing user, never a hardcoded identity);
# and a CWD-relative form (`.claude.../`).
#
# Relative-form arm closes the prior blind spot: a prompt that first changes
# directory to $HOME (`cd ~ && edit .claude/agents/x.md`) references the harness
# root with no `~/` or `${HOME}/` prefix, so the two absolute arms miss it and
# the Rule-2 background check is bypassed. The `(^|[[:space:]"'`(<>])` boundary
# anchors `.claude` to a genuine path start — it never re-matches the absolute
# arms (their `/` or `~` precedes `.claude`) and never matches an incidental
# substring (e.g. `foo.claude`).
#   Residual blind spot (documented, low-risk): the relative arm presumes the
# CWD is $HOME. A relative `.claude/...` resolved against a NON-home CWD points
# outside the harness and is NOT a Rule-2 target, yet still matches here — an
# over-match that can only over-block (fail-SAFE for a Rule-2 gate). Forms that
# fully obscure the path (variable indirection, base64, a `cd` to a deeper dir
# then `../.claude/...`) remain out of a static text scan's reach; this is one
# enforcement layer among several, not a complete sandbox.
harness_re="(~/${CLAUDE_CONFIG_ROOT_RE}|(^|[[:space:]\"'\`(<>])${CLAUDE_CONFIG_ROOT_RE})"
if [[ -n "${home_re}" ]]; then
  harness_re="(~/${CLAUDE_CONFIG_ROOT_RE}|${home_re}/${CLAUDE_CONFIG_ROOT_RE}|(^|[[:space:]\"'\`(<>])${CLAUDE_CONFIG_ROOT_RE})"
fi
matches=""
matches="$(printf '%s' "${prompt}" \
  | { grep -oE "${harness_re}"'[^[:space:]"'"'"'`)<>]*' || true; } \
  | sort -u)" || matches=""

# No harness path → out of scope.
if [[ -z "${matches}" ]]; then
  exit 0
fi

# BASENAME exception: a match is exempt when its first segment after the harness root is one
# of {CLAUDE.md, MEMORY.md, GLASS_ATRIUM_GLOBAL_RULES.md} — the prompt references an allowlisted
# root-level file directly. EVERY match exempt → the call is exempt. Implementation: strip the
# harness root prefix, take the first '/'-separated segment, compare; any non-exempt match → BLOCK.
all_exempt=true
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  # The relative-form arm captures one leading separator byte (space/quote/backtick/paren/angle) —
  # trim it so the prefix-strips below see a clean path token (IFS read already trims a leading TAB).
  path="${path#[[:space:]]}"
  path="${path#\"}"
  path="${path#\'}"
  path="${path#\`}"
  path="${path#(}"
  path="${path#<}"
  path="${path#>}"
  # Strip the leading root prefix in any of its three forms (tilde / absolute-home / bare). The
  # helper shares ONE root grammar with the scan regex above, so a root the scan admits can never
  # be one the strip fails to reduce — the drift that left profile branches unrecognized.
  remainder="$(claude_config_strip_branch_root "${path}" "${home_dir}")"
  # First segment after the root.
  first_segment="${remainder%%/*}"
  case "${first_segment}" in
    CLAUDE.md | MEMORY.md | GLASS_ATRIUM_GLOBAL_RULES.md) continue ;;
    data | projects | logs | todos | shell-snapshots | statsig)
      # Runtime-DATA subdir → not config, does not force foreground. But the memory dir nests under
      # projects/ (projects/<proj>/memory/…), so a /memory/ path segment keeps the match protected —
      # this exclusion cannot un-protect a memory write. `/${remainder}/` frames the glob boundaries.
      case "/${remainder}/" in
        */memory/*)
          all_exempt=false
          break
          ;;
        *) continue ;;
      esac
      ;;
    *)
      all_exempt=false
      break
      ;;
  esac
done <<<"${matches}"

if [[ "${all_exempt}" == "true" ]]; then
  exit 0
fi

# Non-exempt harness path with run_in_background=true → BLOCK (reason on stderr, exit 2).
# Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored → exit 2 stands.
(printf '%s\n' '[enforce-foreground-harness] Harness Path Protection Rule 2: foreground MANDATORY for an Agent call that writes under ~/.claude/ or any ~/.claude-* profile branch config dir, so the user can watch the harness change as it happens. Set run_in_background=false (or omit it). Source: rules/glass-atrium/orchestrator-role.md -> Harness Path Protection.') >&2 || true
exit 2
