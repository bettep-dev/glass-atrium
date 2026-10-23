#!/usr/bin/env bash
# enforce-foreground-harness.sh — PreToolUse(Agent) gate enforcing
# Harness Path Protection Rule 2 (orchestrator-role.md): staged lane MANDATORY.
#
# Blocks an Agent call whose prompt names a non-exempt path under ~/.claude/ or any ~/.claude-* profile
# branch config dir, whatever run_in_background holds or omits — the field is model-sent and proves
# nothing about how the CLI launches the agent. A harness write never travels through a subagent prompt:
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
#   A `..` in a match, or a second root inside it, voids every exemption.
#
# Spelling: the scan reads the prompt as the shell resolves it — quotes and backslashes removed,
#   `//` and `/./` collapsed, case folded (macOS APFS resolves `~/.Claude/` to the live dir), every
#   home form rewritten to `~/` — and a root counts with or without a trailing `/`, glob or brace.
#
# Source: rules/glass-atrium/orchestrator-role.md → Harness Path Protection.
# Measured envelope (run_in_background never delivered): scoped/shared-hook-capability-contract.md →
#   ### PreToolUse(Agent) measured record.

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

# One jq pass: a non-Agent call yields an empty prompt, so it exits with the empty-prompt case.
prompt=""
prompt="$(printf '%s' "${input}" | jq -r 'select(.tool_name == "Agent") | .tool_input.prompt // ""' 2>/dev/null)" || prompt=""

# Non-Agent call or empty prompt → nothing to scan.
if [[ -z "${prompt}" ]]; then
  exit 0
fi

# Every root form contains `.claude` in some case, a quote or backslash possibly inside it (the
# shell drops those: `.cl"aude"/x`) → a prompt matching neither names no harness path. A regex, not a
# bash pattern substitution: bash 3.2 runs those superlinearly on a large prompt.
quote_run='["'"'"'\\]*'
precheck_re="\\.${quote_run}c${quote_run}l${quote_run}a${quote_run}u${quote_run}d${quote_run}e"
shopt -s nocasematch
if [[ ! "${prompt}" =~ ${precheck_re} ]]; then
  exit 0
fi
shopt -u nocasematch

# Remedy named by both block reasons — the Write routes of Harness Path Protection Rule 2.
readonly routes_text='Take a write route instead: (1) an install-managed file (a symlink into ~/.glass-atrium/: agent bodies, rules/glass-atrium/*, skills/glass-atrium-*, GLASS_ATRIUM_GLOBAL_RULES.md) -> edit the repo path, which ships through manifest regeneration and the updater; (2) a harness file the install does not manage (profile settings*.json, settings.local.json, other profile-local files) -> the staged lane: the main session copies it to a staging dir in the working tree with cat <real> > <stage>/<name> and no other command, the agent edits the copy, the user approves the diff and applies it; (3) a read -> the repo path for an install-managed file, the staged lane read-only copy otherwise. Never name the resolved ~/.glass-atrium/ target to get past this check: it writes the live install outside the updater.'

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

# Normalize as the shell resolves a path, in ONE awk fork (linear, where bash 3.2 pattern substitution
# is not): case fold (macOS APFS resolves `~/.Claude/` to the live dir) · quotes and backslashes
# dropped · `//` and `/./` collapsed · every home form → `~/`, the resolved home matched as a FIXED
# string. An empty or `/` home adds no form — a bare `/` pattern would rewrite every separator.
home_dir="${HOME:-}"
home_dir="${home_dir%/}"
# shellcheck disable=SC2016  # awk program text, never shell expansions
normalize_awk='
function norm(s) {
  s = tolower(s)
  gsub(quote_class, "", s)
  while (gsub(/\/\//, "/", s)) {}
  while (gsub(/\/\.\//, "/", s)) {}
  return s
}
function swap(s, from,    out, i) {
  out = ""
  while ((i = index(s, from)) > 0) {
    out = out substr(s, 1, i - 1) "~/"
    s = substr(s, i + length(from))
  }
  return out s
}
BEGIN {
  quote_class = "[\"" sprintf("%c", 39) "\\\\]"
  home = norm(ENVIRON["FH_HOME"])
  sub(/\/$/, "", home)
}
{
  line = swap(swap(norm($0), "${home}/"), "$home/")
  if (home != "") line = swap(line, home "/")
  print line
}'
# On awk failure the raw prompt is still scanned; the note prints on the allow exits only, so a block
# keeps its single stderr reason. `trap - ERR` inside: an inherited (-E) trap would exit 0 there.
normalized=""
degraded=false
if normalized="$(
  trap - ERR
  printf '%s\n' "${prompt}" | FH_HOME="${home_dir}" LC_ALL=C awk "${normalize_awk}"
)"; then
  prompt="${normalized}"
else
  degraded=true
fi

# Allow exit: exit 0, naming a degraded normalization first.
allow() {
  if [[ "${degraded}" == true ]]; then
    printf '[enforce-foreground-harness] awk normalization failed; only the raw prompt was scanned\n' >&2
  fi
  exit 0
}

# Scan for root occurrences: `~/` or `~user/` before `.claude` (every home form after the rewrite), or
# a CWD-relative `.claude` after a boundary byte. A token runs to whitespace, a backtick, `)`, `<>`, or
# a list separator `,;:|` — so a protected path joined onto an exempt one is a token of its own — and
# keeps an `<angle-placeholder>` segment whole. The root grammar is checked per token below.
# shellcheck disable=SC2016  # backticks are literal bracket members, never expansions
tok_char='[^[:space:]`)<>,;:|]'
placeholder='<[^[:space:]<>]*>'
# shellcheck disable=SC2016  # backticks are literal bracket members, never expansions
boundary='[[:space:]`(<>{,;:|&=*[]'
scan_re="(~[a-z0-9._-]*/\\{?|(^|${boundary})(\\./)*\\{?)\\.claude(${tok_char}|${placeholder})*"
matches=""
matches="$(printf '%s' "${prompt}" \
  | { grep -oE "${scan_re}" || true; } \
  | sort -u)" || matches=""

# No harness path → out of scope.
if [[ -z "${matches}" ]]; then
  allow
fi

# CWD-relative arm rule: a relative `.claude*/` token is ambiguous — read from $HOME it is the harness,
# read from a repo it is that repo's own `.claude/` (worktrees/, audit records). The agent's cwd is not
# knowable here (tool_input carries none; the envelope cwd is the session's, and a prompt `cd` moves it),
# so the token counts as a harness path when, read from $HOME, its first segment is an entry the
# harness root holds, or one Claude Code loads as config before it exists.
# Any other entry, created from $HOME, is a file no session reads → no misconfiguration, no block.
config_entries=' settings.json settings.local.json keybindings.json agents agent-memory commands skills hooks rules plugins output-styles projects '

# Classify each token: strip the boundary byte and the `~/` / `./` / `{` lead, take the root with the
# lib grammar, then the first segment after it. EVERY token exempt → the call is exempt.
all_exempt=true
lead_re='^[^.~]+'
tilde_re='^~[a-z0-9._-]*/'
root_re="^${CLAUDE_CONFIG_ROOT_RE%/}"
wild_re='^-?[*?{}[]'
progress_re='^projects/[^/]+/memory/progress-[^/]*\.md$'
while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  if [[ "${path}" =~ ${lead_re} ]]; then
    path="${path#"${BASH_REMATCH[0]}"}"
  fi
  relative=true
  if [[ "${path}" =~ ${tilde_re} ]]; then
    relative=false
    path="${path#"${BASH_REMATCH[0]}"}"
  fi
  while [[ "${path}" == ./* ]]; do
    path="${path#./}"
  done
  path="${path#\{}"
  raw="${path}"
  # Trailing prose punctuation or markdown emphasis is not part of the path; a dot run is kept.
  while :; do
    case "${path}" in
      */. | */.. | *..) break ;;
      *[]?*_!.]) path="${path%?}" ;;
      *) break ;;
    esac
  done
  [[ "${path}" =~ ${root_re} ]] || continue
  root="${BASH_REMATCH[0]}"
  rest="${path#"${root}"}"
  # The root itself (bare, glob or brace spelling) → the whole config dir → never exempt.
  if [[ -z "${rest}" || "${rest}" =~ ${wild_re} ]]; then
    all_exempt=false
    break
  fi
  # A lookalike name (`.claude.json`, `.claudex/`) is no config root.
  [[ "${rest}" == /* ]] || continue
  remainder="${rest#/}"
  # A `..` climbs out of any exempt subtree; a second root inside the token is a swallowed path.
  if [[ "/${raw}/" == */../* || "/${remainder}/" == */../* || "${remainder}" == *.claude* ]]; then
    all_exempt=false
    break
  fi
  first_segment="${remainder%%/*}"
  if [[ "${relative}" == true && -n "${home_dir}" && -n "${first_segment}" ]]; then
    entry="${home_dir}/${root}/${first_segment}"
    if [[ ! -e "${entry}" && ! -L "${entry}" && "${config_entries}" != *" ${first_segment} "* ]]; then
      continue
    fi
  fi
  case "${first_segment}" in
    claude.md | memory.md | glass_atrium_global_rules.md) continue ;;
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
  allow
fi

# Non-exempt harness path, whatever run_in_background holds → BLOCK (reason on stderr, exit 2).
# Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored → exit 2 stands.
(printf '%s %s %s\n' '[enforce-foreground-harness] Harness Path Protection Rule 2: staged lane MANDATORY. An Agent prompt may not name a path under ~/.claude/ or any ~/.claude-* profile branch config dir, whatever run_in_background holds or omits: the user must see and approve a harness change before it lands.' "${routes_text}" 'Source: rules/glass-atrium/orchestrator-role.md -> Harness Path Protection.') >&2 || true
exit 2
