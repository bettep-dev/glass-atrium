#!/usr/bin/env bash
# enforce-foreground-harness.sh — PreToolUse(Agent) gate enforcing
# Harness Path Protection Rule 2 (orchestrator-role.md).
#
# Purpose:
#   Block sub-agent delegations that target ~/.claude/, ~/.claude-work/, or
#   ~/.claude-personal/ with run_in_background=true. The user MUST inspect
#   harness/memory writes in real time — background spawns hide diffs and
#   silently break future sessions. This hook is the deterministic runtime
#   gateway that an LLM-side self-check cannot guarantee.
#
# Trigger:
#   PreToolUse hook with matcher "Agent" (registered in ~/.claude/settings.json).
#
# Contract:
#   stdin  — JSON payload from Claude Code (tool_name, tool_input{prompt,
#            run_in_background}).
#   stdout — JSON {"decision":"block","reason":"..."} on violation; silent on
#            pass.
#   exit 2 — block (Rule 2 violation). exit 0 — pass / fail-open on internal
#            error (defense-in-depth: this is one of several enforcement layers,
#            never break the user's session on infrastructure failure).
#
# BASENAME exception:
#   CLAUDE.md, MEMORY.md, GLOBAL_RULES.md may be written directly. If every
#   harness-path occurrence in the prompt resolves to one of these basenames,
#   the call is exempt.
#
# Source: rules/orchestrator-role.md → Harness Path Protection.

set -Eeuo pipefail
IFS=$'\n\t'

# Diagnostic ERR trap — stderr only, never blocks. The cleanup ensures any
# unexpected failure exits 0 (fail-open) rather than blocking the user.
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

# jq absence would be a system misconfiguration; fail-open with a stderr note
# rather than blocking every Agent call.
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

# Extract delegation prompt body (string) and run_in_background flag.
# Default run_in_background to "false" when absent — matches Claude Code
# semantics (parameter is optional, foreground is the default).
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

# Scan the prompt for harness path occurrences. Each match is a path token
# starting at one of the four roots and continuing through the next whitespace
# or quote boundary.
#
# Regex captures the path-after-root (everything up to whitespace / quote /
# backtick / closing paren-or-bracket) so we can resolve its basename.
# grep -oE prints one match per line; sort -u dedupes identical occurrences.
# `|| true` on grep absorbs the exit-1 no-match case so pipefail does not
# trip the ERR trap when the prompt has no harness paths.
#
# Three alternations: tilde form (`~/.claude.../`) always; absolute-home form
# (`${HOME}/.claude.../`) only when $HOME is known — built from the
# regex-escaped runtime home so it matches the installing user, never a
# hardcoded developer identity; and a CWD-relative form (`.claude.../`).
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
harness_re='(~/\.claude(-work|-personal)?/|(^|[[:space:]"'"'"'`(<>])\.claude(-work|-personal)?/)'
if [[ -n "${home_re}" ]]; then
  harness_re="(~/\.claude(-work|-personal)?/|${home_re}/\.claude(-work|-personal)?/|(^|[[:space:]\"'\`(<>])\.claude(-work|-personal)?/)"
fi
matches=""
matches="$(printf '%s' "${prompt}" \
  | { grep -oE "${harness_re}"'[^[:space:]"'"'"'`)<>]*' || true; } \
  | sort -u)" || matches=""

# No harness path → out of scope.
if [[ -z "${matches}" ]]; then
  exit 0
fi

# BASENAME exception evaluation:
# A match is "exempt" when its first path segment after the harness root is one
# of {CLAUDE.md, MEMORY.md, GLOBAL_RULES.md} — i.e. the prompt references the
# allowlisted root-level files directly. If EVERY match is exempt, the call is
# exempt as a whole.
#
# Implementation: for each match, strip the harness root prefix, then take the
# first '/'-separated segment. If that segment is one of the three allowed
# basenames, the match is exempt. Any non-exempt match → BLOCK.
all_exempt=true
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  # The relative-form arm's boundary group captures one leading separator byte
  # (space / quote / backtick / paren / angle) — trim it so the prefix-strips
  # below see a clean path token. IFS=$'\n\t' read already trims a leading TAB.
  path="${path#[[:space:]]}"
  path="${path#\"}"
  path="${path#\'}"
  path="${path#\`}"
  path="${path#(}"
  path="${path#<}"
  path="${path#>}"
  # Strip leading root prefix. The pattern MUST be quoted — unquoted `~/...`
  # in `${var#pattern}` triggers tilde expansion and the literal `~/` prefix
  # never matches, leaving the path unstripped.
  remainder="${path#"~/.claude/"}"
  remainder="${remainder#"~/.claude-work/"}"
  remainder="${remainder#"~/.claude-personal/"}"
  # Absolute-home form — strip the runtime-resolved $HOME prefix (quoted so the
  # literal value is matched, not glob-expanded). Empty $HOME → these are no-ops.
  remainder="${remainder#"${home_dir}/.claude/"}"
  remainder="${remainder#"${home_dir}/.claude-work/"}"
  remainder="${remainder#"${home_dir}/.claude-personal/"}"
  # CWD-relative form — strip the bare `.claude.../` root (no `~`/`$HOME` prefix).
  remainder="${remainder#".claude/"}"
  remainder="${remainder#".claude-work/"}"
  remainder="${remainder#".claude-personal/"}"
  # First segment after the root.
  first_segment="${remainder%%/*}"
  case "${first_segment}" in
    CLAUDE.md | MEMORY.md | GLOBAL_RULES.md) continue ;;
    *)
      all_exempt=false
      break
      ;;
  esac
done <<<"${matches}"

if [[ "${all_exempt}" == "true" ]]; then
  exit 0
fi

# Non-exempt harness path detected with run_in_background=true → BLOCK.
# Emit JSON decision on stdout (Claude Code hook contract) and exit 2.
printf '%s\n' '{"decision":"block","reason":"Harness Path Protection Rule 2 violation: foreground MANDATORY for ~/.claude/, ~/.claude-work/, ~/.claude-personal/ writes. Set run_in_background=false (or omit). Source: rules/orchestrator-role.md."}'
exit 2
