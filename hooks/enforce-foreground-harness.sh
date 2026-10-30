#!/usr/bin/env bash
# enforce-foreground-harness.sh — PreToolUse(Agent) gate enforcing
# Harness Path Protection Rule 2 (skills/glass-atrium-ops-orchestrator-role.md): staged lane MANDATORY.
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
#   A `..` in the written path, or `.claude` text after the root, voids every exemption.
#
# Negated-mention exclusion: a token naming only a root (no entry inside it), every occurrence of which
#   follows a negation cue in its clause (never, not, no, don't, cannot, must not …), is a constraint, not
#   a write target. A clause ends at . ; : ! ? , or a line end. A file or dir inside the root still blocks;
#   residual: a root-only directive behind an unrelated negation in one clause ("don't wait, edit ~/.claude").
#
# Resolution: the verdict follows what the filesystem says a path reaches, not how it is spelled.
#   - Candidates: every token whose text, glob metacharacters and quotes removed, holds `.claude` in any
#     case. A token starts at whitespace, a separator (`` ` ``()<>,;:|&), or after `=`, `@` or `-x`.
#   - A tilde form, `$HOME/` or `${HOME}/` at the token start, or a relative token, is read from $HOME;
#     `~+` and `~-` count as relative (the agent's cwd is unknowable). Anything else resolves as written.
#   - Segments are walked with stat tests only (`-d`, `-e`, `-ef`): a step whose inode is a protected
#     root's, or a root-grammar name under the home, enters the root — so case, Unicode folding, `..`
#     and symlinks resolve as the host filesystem resolves them. A file symlink is read with readlink.
#   - A glob is expanded by bash pathname expansion (no execution), each match walked, and its
#     metacharacter-stripped spelling walked too. A brace that bash would expand (`{a,b}`, `{a..b}`)
#     cannot be expanded without eval → protected, fail-safe. A brace with neither is literal text.
#   - A bare root word (relative, no `/` but a trailing one) is prose unless an action word, an option
#     (a lone `-` is a list marker), a redirect or a joined `=`/`@`/`-x`/list position makes it an operand.
#   - A block names the candidate that triggered it.
#   - Past 128 unique candidates the prompt is protected, fail-safe, with none of them walked.
#   Not read as home: any other expansion — `${HOME:-}/`, `${HOME%/}/`, `$(echo ~)/`.
#
# Source: skills/glass-atrium-ops-orchestrator-role.md → Harness Path Protection.
# Measured envelope (run_in_background never delivered): scoped/shared-hook-capability-contract.md →
#   ### PreToolUse(Agent) measured record.

# shellcheck disable=SC2310  # predicates return their verdict as status: a failed stat test is an answer
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

# Every candidate holds `.claude` in some case once quotes, backslashes and glob or brace metacharacters
# are dropped (`.cl"aude"`, `.cl*aude`), or a brace alternative spells it (`.cla{u,x}de`) → a prompt
# matching neither names no harness path. A regex, not a bash pattern substitution: bash 3.2 runs those
# superlinearly on a large prompt.
meta_run='[]["'"'"'\\*?{}]*'
precheck_re="\\.${meta_run}c${meta_run}l${meta_run}a${meta_run}u${meta_run}d${meta_run}e"
brace_re='\.[^[:space:]]*[{][^[:space:]{}]*,'
shopt -s nocasematch
if [[ ! "${prompt}" =~ ${precheck_re} && ! "${prompt}" =~ ${brace_re} ]]; then
  exit 0
fi
shopt -u nocasematch

# Remedy named by both block reasons — the Write routes of Harness Path Protection Rule 2.
readonly routes_text='Take a write route instead: (1) an install-managed file (a symlink into ~/.glass-atrium/: agent bodies, rules/glass-atrium/*, skills/glass-atrium-*, GLASS_ATRIUM_GLOBAL_RULES.md) -> edit the repo path, which ships through manifest regeneration and the updater; (2) a harness file the install does not manage (profile settings*.json, settings.local.json, other profile-local files) -> the staged lane: the main session copies it to a staging dir in the working tree with cat <real> > <stage>/<name> and no other command, the agent edits the copy, the user approves the diff and applies it; (3) a read -> the repo path for an install-managed file, the staged lane read-only copy otherwise; (4) a repo path that contains .claude (a worktree, a repo-local settings or audit file) -> name it by its absolute form: a relative one is judged as if read from the home dir, and can block. Never name the resolved ~/.glass-atrium/ target to get past this check: it writes the live install outside the updater.'

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

# Candidate extraction in ONE awk fork (linear, where bash 3.2 pattern substitution is not). Output
# lines `x<flags>\t<candidate>`: flag c = operand context (bare-root rule), b = brace bash would expand,
# a = an occurrence outside a negated clause (negated-mention rule).
# A `<placeholder>` stays one segment, a comma inside a brace stays in its token.
# shellcheck disable=SC2016  # awk program text, never shell expansions
extract_awk='
# Root text in s, metacharacters dropped, trying each brace alternative; past the probe budget the
# word counts as root text (fail-safe — its brace flag then decides).
function has_root_text(s,    pre, post, n, i, alt) {
  if (match(s, /\{[^{}]*\}/)) {
    if (++probes > 256) return 1
    pre = substr(s, 1, RSTART - 1)
    post = substr(s, RSTART + RLENGTH)
    n = split(substr(s, RSTART + 1, RLENGTH - 2), alt, /[,\003]/)
    for (i = 1; i <= n; i++) if (has_root_text(pre alt[i] post)) return 1
    return n == 0 && has_root_text(pre post)
  }
  s = tolower(s)
  gsub(/[*?[]/, "", s)
  gsub(/\]/, "", s)
  return index(s, ".claude") > 0
}
function emit(c, f) {
  probes = 0
  if (!has_root_text(c)) return
  if (!in_negation) f = f "a"
  if (index(c, "\003") || c ~ /\{[^{}]*\.\.[^{}]*\}/) f = f "b"
  gsub(/\003/, ",", c)
  gsub(/\001/, "<", c)
  gsub(/\002/, ">", c)
  seen[c] = seen[c] f
}
function starts(t, f,    c) {
  if (t == "") return
  emit(t, f)
  if (t ~ /^-/) {
    c = t
    sub(/^-+/, "", c)
    emit(c, f "c")
    if (t ~ /^-[A-Za-z0-9]/) emit(substr(t, 3), f "c")
  }
  c = t
  while (match(c, /[=@]/)) {
    c = substr(c, RSTART + 1)
    emit(c, f "c")
  }
}
function split_word(w, f,    b, m, j, k, s, part, piece, joined) {
  while (match(w, /<[^<>]*>/))
    w = substr(w, 1, RSTART - 1) "\001" substr(w, RSTART + 1, RLENGTH - 2) "\002" substr(w, RSTART + RLENGTH)
  while (match(w, /\{[^{}]*,[^{}]*\}/)) {
    b = substr(w, RSTART, RLENGTH)
    gsub(/,/, "\003", b)
    w = substr(w, 1, RSTART - 1) b substr(w, RSTART + RLENGTH)
  }
  gsub(/[<>]+/, "\005", w)
  m = split(w, part, /[`(),;|&:]+/)
  for (j = 1; j <= m; j++) {
    joined = (j > 1 && part[j - 1] != "")
    k = split(part[j], piece, "\005")
    for (s = 1; s <= k; s++) starts(piece[s], (f || joined || s > 1) ? "c" : "")
  }
}
BEGIN {
  quote_class = "[\"" sprintf("%c", 39) "\\\\]"
  verbs = " cd pushd popd ls cat cp mv rm rmdir mkdir touch ln tee chmod chown install find tar rsync sed awk vi vim nano code open source stat du head tail less grep git edit write update modify change delete remove create rewrite overwrite replace append patch move copy rename save "
}
{
  negated = 0
  n = split($0, words, /[[:space:]]+/)
  for (i = 1; i <= n; i++) {
    w = words[i]
    gsub(quote_class, "", w)
    p = prev
    prev = tolower(w)
    sub(/:$/, "", prev)
    probes = 0
    # A negation cue holds to the end of its clause; quotes are already dropped, so the cue reads dont.
    in_negation = negated
    cue = prev
    gsub(/[^a-z]/, "", cue)
    if (cue ~ /^(never|not|no|nor|dont|cannot|cant|mustnt|shouldnt|wont)$/) negated = 1
    if (w ~ /[.;:!?,]$/) negated = 0
    if (!index(w, ".") || !has_root_text(w)) continue
    # A lone `-` word is a markdown list marker, not an option; `--` still ends options.
    split_word(w, index(verbs, " " p " ") || (p ~ /^-/ && p != "-") || p ~ /[<>]$/)
  }
}
END { for (c in seen) print "x" seen[c] "\t" c }'

# Degraded extractor (awk failed): whitespace words with quotes dropped, split on the list separators,
# every candidate in operand context. Builtins only; slower, so it runs only after an awk failure.
fallback_candidates() {
  local IFS=$' \t\n' word piece
  set -f
  for word in ${prompt}; do
    word="${word//[\"\'\\]/}"
    [[ "${word}" == *.[Cc][Ll][Aa][Uu][Dd][Ee]* ]] || continue
    for piece in ${word//[,;|&:()<>\`]/ }; do
      if [[ "${piece}" == *.[Cc][Ll][Aa][Uu][Dd][Ee]* ]]; then
        printf 'xca\t%s\n' "${piece}"
      fi
    done
  done
  set +f
}

# On awk failure the fallback still classifies; the note prints on the allow exits only, so a block
# keeps its single stderr reason. `trap - ERR` inside: an inherited (-E) trap would exit 0 there.
candidates=""
degraded=false
if ! candidates="$(
  trap - ERR
  printf '%s\n' "${prompt}" | LC_ALL=C awk "${extract_awk}"
)"; then
  degraded=true
  candidates="$(fallback_candidates)" || candidates=""
fi

# Allow exit: exit 0, naming a degraded extraction first.
allow() {
  if [[ "${degraded}" == true ]]; then
    printf '[enforce-foreground-harness] awk normalization failed; only the raw prompt was scanned\n' >&2
  fi
  exit 0
}

# No harness path → out of scope.
if [[ -z "${candidates}" ]]; then
  allow
fi

# Non-exempt harness path, whatever run_in_background holds → BLOCK (reason on stderr, exit 2).
# Args: $1 = an optional reason line printed ahead of the Rule 2 text.
# Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored → exit 2 stands.
block() {
  (
    [[ -z "${1:-}" ]] || printf '%s\n' "${1}"
    printf '%s %s %s\n' '[enforce-foreground-harness] Harness Path Protection Rule 2: staged lane MANDATORY. An Agent prompt may not name a path under ~/.claude/ or any ~/.claude-* profile branch config dir, whatever run_in_background holds or omits: the user must see and approve a harness change before it lands.' "${routes_text}" 'Source: skills/glass-atrium-ops-orchestrator-role.md -> Harness Path Protection.'
  ) >&2 || true
  exit 2
}

# Each unique candidate costs one stat walk (~0.3 ms on bash 3.2) → past the cap the prompt blocks
# unresolved, fail-safe. The densest tracked text names 23; the degraded extractor counts repeats too.
readonly candidate_cap=128
candidate_list=()
IFS=$'\n' read -r -d '' -a candidate_list <<<"${candidates}" || true
if ((${#candidate_list[@]} > candidate_cap)); then
  block "[enforce-foreground-harness] The prompt names ${#candidate_list[@]} unique .claude path candidates, past the cap of ${candidate_cap} this gate resolves, so it is judged protected without resolving them (fail-safe). Split the delegation so each prompt names fewer such paths."
fi

# Home as the walk sees it. An empty home has no harness; a sentinel that cannot exist keeps the lexical
# root test (`~/.claude` → <sentinel>/.claude) blocking instead of reading every path as home.
home_dir="${HOME:-}"
while [[ "${home_dir}" == */ && "${home_dir}" != / ]]; do
  home_dir="${home_dir%/}"
done
[[ -n "${home_dir}" ]] || home_dir='/nonexistent/.enforce-foreground-harness-no-home'

# Lexical twin of an absolute path (the shell's logical view): empty and `.` segments dropped, `..` pops.
# Args: $1 = absolute path. Sets lexical_out.
set_lexical() {
  local rest="${1#/}" seg out=""
  while [[ -n "${rest}" ]]; do
    seg="${rest%%/*}"
    if [[ "${rest}" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    case "${seg}" in
      "" | .) ;;
      ..) out="${out%/*}" ;;
      *) out="${out}/${seg}" ;;
    esac
  done
  lexical_out="${out:-/}"
}
set_lexical "${home_dir}"
home_lex="${lexical_out}"

# Protected roots on disk: `.claude` and each `.claude-*` dir of the home that fits the lib grammar.
root_name_re="^${CLAUDE_CONFIG_ROOT_RE%/}$"
roots=()
shopt -s nullglob nocaseglob nocasematch
for dir in "${home_dir}/.claude" "${home_dir}"/.claude-*; do
  if [[ -d "${dir}" && "${dir##*/}" =~ ${root_name_re} ]]; then
    roots+=("${dir}")
  fi
done
shopt -u nullglob nocaseglob

# Exit 0 when $1 is the same inode as a protected root (case, Unicode and symlinks folded by stat).
is_root() {
  local dir
  [[ -e "${1}" ]] || return 1
  for dir in ${roots[@]+"${roots[@]}"}; do
    [[ "${1}" -ef "${dir}" ]] && return 0
  done
  return 1
}

# Next segment of walk_rest into seg; walk_rest keeps the tail.
take_segment() {
  seg="${walk_rest%%/*}"
  if [[ "${walk_rest}" == */* ]]; then walk_rest="${walk_rest#*/}"; else walk_rest=""; fi
}

# A non-directory symlink at walk_p restarts the walk at its target (readlink: a metadata read).
# Exit 1 when the hop budget is spent — a link loop, judged protected by the caller.
follow_file_link() {
  local target
  ((link_hops++ < 8)) || return 1
  target="$(readlink -- "${walk_p}" 2>/dev/null)" || return 0
  [[ "${target}" == /* ]] || target="${walk_p%/*}/${target}"
  walk_rest="${target#/}${walk_rest:+/${walk_rest}}"
  walk_p=/ walk_lex=/ crossed_link=true
}

# One step for a `..` segment: physical parent of an existing dir, else a lexical pop.
step_up() {
  if [[ -d "${walk_p}" ]]; then walk_p="${walk_p%/}/.."; else walk_p="${walk_p%/*}"; fi
  walk_lex="${walk_lex%/*}"
  walk_p="${walk_p:-/}" walk_lex="${walk_lex:-/}"
}

# Walk the written segments from walk_p (lexical twin walk_lex). Exit 0 on entering a root (sets
# root_dir and remainder); exit 1 otherwise, last_dir = the deepest existing dir a step reached.
walk_down() {
  local seg parent_p parent_lex
  while [[ -n "${walk_rest}" ]]; do
    take_segment
    case "${seg}" in
      "" | .) continue ;;
      ..) step_up ;;
      *)
        parent_p="${walk_p}" parent_lex="${walk_lex}"
        walk_p="${walk_p%/}/${seg}" walk_lex="${walk_lex%/}/${seg}"
        # A root-grammar name under the home is a root whether or not it exists yet.
        if [[ "${seg}" =~ ${root_name_re} ]] && [[ "${parent_p}" -ef "${home_dir}" || "${parent_lex}" == "${home_lex}" ]]; then
          root_dir="${home_dir}/${seg}" remainder="${walk_rest}"
          return 0
        fi
        ;;
    esac
    if [[ -L "${walk_p}" && ! -d "${walk_p}" ]]; then
      follow_file_link || { opaque=true && return 0; }
      continue
    fi
    [[ -L "${walk_p}" ]] && crossed_link=true
    if is_root "${walk_p}"; then
      root_dir="${walk_p}" remainder="${walk_rest}"
      return 0
    fi
    [[ -d "${walk_p}" ]] && last_dir="${walk_p}"
  done
  return 1
}

# After a symlink was crossed: is the deepest dir reached physically inside a root? Exit 0 = inside.
walk_up() {
  local dir="${last_dir}" level
  for ((level = 0; level < 64; level++)); do
    is_root "${dir}" && return 0
    [[ "${dir}" -ef / ]] && return 1
    dir="${dir%/}/.."
  done
  return 1
}

# The entered root's remainder against the exemptions. Exit 0 = needs the staged lane.
needs_staged_lane() {
  local first bare="${written}"
  [[ "${opaque}" == true ]] && return 0
  while [[ "${remainder}" == /* || "${remainder}" == ./* ]]; do
    remainder="${remainder#/}" remainder="${remainder#./}"
  done
  # The root itself: a bare relative root word in prose is a name, not an operand. A trailing slash
  # names no file inside the root, so `.claude/` is the same bare word.
  if [[ -z "${remainder}" ]]; then
    while [[ "${bare}" == */ ]]; do bare="${bare%/}"; done
    [[ "${relative}" == true && "${bare}" != */* && "${flags}" != *c* ]] && return 1
    # Named only in negated clauses ("never write under ~/.claude/") → a constraint, not a target.
    [[ "${flags}" != *a* ]] && return 1
    return 0
  fi
  # The `.claude`-text void reads written text: a glob match's remainder is a real name on disk.
  [[ "/${written}/" == */../* ]] && return 0
  [[ "${glob_match}" != true && "${remainder}" == *.claude* ]] && return 0
  first="${remainder%%/*}"
  if [[ "${relative}" == true && ! -e "${root_dir}/${first}" && ! -L "${root_dir}/${first}" && "${config_entries}" != *" ${first} "* ]]; then
    return 1
  fi
  exempt_entry "${first}" && return 1
  return 0
}

# BASENAME file, runtime-DATA subdir, or a progress checkpoint directly in a memory dir. Exit 0 = exempt.
exempt_entry() {
  case "${1}" in
    claude.md | memory.md | glass_atrium_global_rules.md) return 0 ;;
    data | projects | logs | todos | shell-snapshots | statsig)
      # The memory dir nests under projects/ → a /memory/ segment keeps it protected; `/…/` frames globs.
      case "/${remainder}/" in
        */memory/*) [[ "${remainder}" =~ ${progress_re} ]] ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# Walk one spelling from walk_p / walk_lex / walk_rest. Exit 0 = it reaches a protected path.
reaches_harness() {
  opaque=false crossed_link=false last_dir="" link_hops=0 root_dir="" remainder=""
  if walk_down; then
    needs_staged_lane && return 0
    return 1
  fi
  [[ "${crossed_link}" == true && -n "${last_dir}" ]] && walk_up && return 0
  return 1
}

# Split $1 into the walk start and the written tail; relative = read from $HOME as a guess.
set_start() {
  local spelled="${1}"
  relative=false walk_p="${home_dir}" walk_lex="${home_lex}"
  # shellcheck disable=SC2016  # the home spellings are literal prompt text, never expansions
  case "${spelled}" in
    '~+' | '~+/'* | '~-' | '~-/'*) relative=true walk_rest="${spelled:2}" ;;
    '~'*)
      if [[ "${spelled}" =~ ${tilde_re} ]]; then walk_rest="${spelled#"${BASH_REMATCH[0]}"}"; else relative=true walk_rest="${spelled}"; fi
      ;;
    '$HOME' | '$HOME/'*) walk_rest="${spelled#\$HOME}" ;;
    '${HOME}' | '${HOME}/'*) walk_rest="${spelled#\$\{HOME\}}" ;;
    /*) walk_p=/ walk_lex=/ walk_rest="${spelled#/}" ;;
    *) relative=true walk_rest="${spelled}" ;;
  esac
}

# A glob is expanded by bash pathname expansion, never run; >1024 matches is judged protected (walk cost).
# Exit 0 = a match reaches a protected path.
glob_reaches_harness() {
  local match matches=() head tail="" IFS=$'\n'
  set_start "${written}"
  [[ "${walk_p}" == *[][*?]* ]] && return 1
  # Expand only through the last wildcard segment: a file the prompt would create does not exist yet.
  head="${walk_rest}"
  while [[ "${head}" == */* && "${head##*/}" != *[][*?]* ]]; do
    tail="${head##*/}${tail:+/${tail}}" head="${head%/*}"
  done
  shopt -s nullglob
  # shellcheck disable=SC2206  # pathname expansion is the point; word splitting is on newline only
  matches=(${walk_p%/}/${head})
  shopt -u nullglob
  ((${#matches[@]} <= 1024)) || return 0
  glob_match=true
  for match in ${matches[@]+"${matches[@]}"}; do
    walk_p=/ walk_lex=/ walk_rest="${match#/}${tail:+/${tail}}"
    reaches_harness && return 0
  done
  glob_match=false
  return 1
}

# Glob metacharacters dropped from each segment; a segment of wildcards alone stays as one name, so
# `projects/*/memory/progress-x.md` keeps its shape for the exemptions.
strip_globs() {
  local rest="${written}" seg bare out="" sep=""
  while :; do
    seg="${rest%%/*}"
    bare="${seg//[][*?]/}"
    [[ -z "${bare}" ]] || seg="${bare}"
    out="${out}${sep}${seg}" sep=/
    [[ "${rest}" == */* ]] || break
    rest="${rest#*/}"
  done
  written="${out}"
}

# Exit 0 = the candidate names a path that needs the staged lane.
candidate_blocks() {
  [[ "${flags}" == *b* ]] && return 0
  # Trailing prose punctuation or markdown emphasis is not part of the path; a dot run is kept.
  while :; do
    case "${written}" in
      */. | */.. | *..) break ;;
      *[]?*_!.]) written="${written%?}" ;;
      *) break ;;
    esac
  done
  if [[ "${written}" == *[][*?]* ]]; then
    glob_reaches_harness && return 0
    strip_globs
  fi
  set_start "${written}"
  reaches_harness
}

# CWD-relative arm rule: a relative `.claude*/` token is ambiguous — read from $HOME it is the harness,
# read from a repo it is that repo's own `.claude/` (worktrees/, audit records). The agent's cwd is not
# knowable here (tool_input carries none; the envelope cwd is the session's, and a prompt `cd` moves it),
# so the token counts as a harness path when, read from $HOME, its first segment is an entry the
# harness root holds, or one Claude Code loads as config before it exists.
# Any other entry, created from $HOME, is a file no session reads → no misconfiguration, no block.
config_entries=' settings.json settings.local.json keybindings.json agents agent-memory commands skills hooks rules plugins output-styles projects '
tilde_re='^~[a-z0-9._-]*(/|$)'
progress_re='^projects/[^/]+/memory/progress-[^/]*\.md$'

# nocasematch stays on: the lexical root and exemption tests fold case as the host filesystem does.
glob_match=false
for line in "${candidate_list[@]}"; do
  flags="${line%%$'\t'*}" written="${line#*$'\t'}"
  [[ -n "${written}" ]] || continue
  shown="${written:0:200}"
  if candidate_blocks; then
    block "[enforce-foreground-harness] Blocking candidate: ${shown//[[:cntrl:]]/?} (this prompt token, quotes and backslashes dropped, resolves to a protected harness path)."
  fi
done
allow
