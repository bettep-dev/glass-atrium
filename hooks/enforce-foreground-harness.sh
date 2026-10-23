#!/usr/bin/env bash
# enforce-foreground-harness.sh — PreToolUse(Agent) gate enforcing
# Harness Path Protection Rule 2 (orchestrator-role.md): staged lane MANDATORY.
#
# Blocks an Agent call whose prompt names a non-exempt path under ~/.claude/ or any ~/.claude-* profile
# branch config dir, whatever run_in_background holds or omits — the field is model-sent and proves
# nothing about how the CLI launches the agent. A harness write never travels through an Agent prompt:
# it goes repo-side or through the user-applied staged lane, so the user sees the diff before it lands.
# Trigger: matcher "Agent" (registered in ~/.claude/settings.json).
#
# Contract: stdin = JSON (tool_name, tool_input{prompt}) · stdout silent · stderr = the block reason
#   on violation · exit 2 = block · exit 0 = pass / fail-open on internal error
#   (defense-in-depth — one of several layers, never break the session).
#
# BASENAME exception:
#   CLAUDE.md, MEMORY.md, GLASS_ATRIUM_GLOBAL_RULES.md may be written directly. If every
#   harness-path occurrence in the prompt resolves to one of these basenames, the call is exempt.
#
# Runtime-DATA exclusion: Rule 2 protects harness CONFIG writes (agents/, hooks/, skills/,
#   settings*.json, the memory dir). Runtime-DATA subdirs (data/, projects/, logs/, todos/,
#   shell-snapshots/, statsig/) hold transcripts/logs/caches that CANNOT misconfigure a future session,
#   so a bare reference (a text scan cannot tell READ from WRITE) is not blocked. The memory dir nests
#   under projects/ and stays protected via a /memory/ segment guard, never leaking into memory writes.
#
# Progress-file exclusion: a progress-*.md directly in a projects/<p>/memory/ dir is session-internal
#   state every agent must checkpoint before its turn cap (GLASS_ATRIUM_GLOBAL_RULES.md → Cross-Session
#   Continuity) — staging it would defeat it. MEMORY.md and every other memory file stay protected.
#   A `..` segment in a match voids every exemption.
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

prompt=""
prompt="$(printf '%s' "${input}" | jq -r '.tool_input.prompt // ""' 2>/dev/null)" || prompt=""

# Empty prompt → nothing to scan.
if [[ -z "${prompt}" ]]; then
  exit 0
fi

# Every root form the scan matches contains `.claude` → a prompt without it names no harness path.
if [[ "${prompt}" != *.claude* ]]; then
  exit 0
fi

# Remedy named by both block reasons — the Write routes of Harness Path Protection Rule 2.
readonly routes_text='Take a write route instead: (1) an install-managed file (a symlink into ~/.glass-atrium/: agent bodies, rules/glass-atrium/*, skills/glass-atrium-*, GLASS_ATRIUM_GLOBAL_RULES.md) -> edit the REPO path, which ships through manifest regeneration and the updater; (2) a harness file the install does not manage (profile settings*.json, settings.local.json, other profile-local files) -> the staged lane: the main session copies it to a staging dir in the working tree, the agent edits the copy, the user approves the diff and applies it; (3) a read -> the repo path for a bundle member, the staged lane read-only copy otherwise. Never name the resolved ~/.glass-atrium/ target to get past this check.'

# Branch-root grammar, single-sited in lib/. Sourced after the `.claude` precheck → the fail-closed lib
# check runs on every Agent prompt containing `.claude` (a security gate must never degrade silently),
# while a prompt naming no harness root never pays the source cost.
config_dirs_lib="${BASH_SOURCE%/*}/lib/claude-config-dirs.sh"
# shellcheck source=lib/claude-config-dirs.sh
if [[ ! -r "${config_dirs_lib}" ]] || ! source "${config_dirs_lib}"; then
  # Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored → exit 2 stands.
  (printf '%s %s\n' '[enforce-foreground-harness] Harness Path Protection Rule 2 gate degraded (fail-closed): lib/claude-config-dirs.sh is unreadable, so harness paths cannot be classified. Do not name the harness path in the Agent prompt, and repair the hook install.' "${routes_text}") >&2 || true
  exit 2
fi

# Literal-home forms → tilde form, so the tilde arm below matches them. The tilde comes from a variable:
# a bare `~` in the replacement is tilde-expanded by bash 4.3+ but kept literal by bash 3.2.
tilde='~'
# shellcheck disable=SC2016  # the patterns are literal prompt text, never expansions
for literal_home in '"${HOME}"/' '"$HOME"/' '${HOME}/' '$HOME/'; do
  prompt=${prompt//"${literal_home}"/${tilde}/}
done

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
# the Rule-2 check is bypassed. The `(^|[[:space:]"'`(<>])` boundary
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
progress_re='^projects/[^/]+/memory/progress-[^/]*\.md$'
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
  # A `..` segment can climb out of any exempt subtree → never exempt.
  if [[ "/${remainder}/" == */../* ]]; then
    all_exempt=false
    break
  fi
  # First segment after the root.
  first_segment="${remainder%%/*}"
  case "${first_segment}" in
    CLAUDE.md | MEMORY.md | GLASS_ATRIUM_GLOBAL_RULES.md) continue ;;
    data | projects | logs | todos | shell-snapshots | statsig)
      # Runtime-DATA subdir → not config, not blocked. But the memory dir nests under projects/
      # (projects/<proj>/memory/…), so a /memory/ path segment keeps the match protected — only a
      # progress checkpoint directly in it is exempt. `/${remainder}/` frames the glob boundaries.
      case "/${remainder}/" in
        */memory/*)
          if [[ "${remainder}" =~ ${progress_re} ]]; then
            continue
          fi
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

# Non-exempt harness path, whatever run_in_background holds → BLOCK (reason on stderr, exit 2).
# Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored → exit 2 stands.
(printf '%s %s %s\n' '[enforce-foreground-harness] Harness Path Protection Rule 2: staged lane MANDATORY. An Agent prompt may not name a path under ~/.claude/ or any ~/.claude-* profile branch config dir, whatever run_in_background holds or omits: the user must see and approve a harness change before it lands.' "${routes_text}" 'Source: rules/glass-atrium/orchestrator-role.md -> Harness Path Protection.') >&2 || true
exit 2
