#!/usr/bin/env bash
# enforce-harness-critical.sh — PreToolUse(Write|Edit|MultiEdit + Bash) harness-critical file gate.
# Both arms block agent_id-INDEPENDENT (main session AND every subagent): a per-FILE
# protection floor, NOT a per-agent tool-grant check (core-security.md LLM06 boundary).
# Each arm also carries an agent_id gate (AGENT_ID ARMS below) that only adds blocks.
#
# Write|Edit|MultiEdit arm (deterministic):
#   (a) live harness settings — settings.json + settings.local.json of ~/.claude/ and
#       of every ~/.claude-*/ profile branch (a branch settings file carries that
#       profile's own hook wiring, so it is the same enforcement surface)
#   (b) LIVE hook dirs — ~/.glass-atrium/hooks/ (primary) + hooks/ of ~/.claude/ and of
#       every ~/.claude-*/ profile branch (legacy)
#   (c) agents/*.md frontmatter IDENTITY keys {name, tools, scope} — `model:` EXCLUDED
#       (monitor/operator writer); body edits PASS. An Edit blocks when its old_string
#       overlaps the on-disk frontmatter block AND either alters the fence-line count
#       (`---` removal/insertion — cuts the fence-removal → identity-edit →
#       fence-restore multi-step bypass) or touches a line-start identity key; a
#       Write on an EXISTING agent file blocks only when its identity lines DIFFER
#       from the on-disk frontmatter. A file left with an UNTERMINATED opening fence
#       is a tampered state: Edit AND Write both block until repaired via a
#       sanctioned path / launch-env grant. An Edit whose old_string is EMPTY is
#       the host's create shape rather than a no-op, and one whose old/new keys are
#       missing or non-string is unreadable — both block fail-closed (the latter
#       two shapes are host-REJECTED by the strict Edit schema, so they are closed
#       defensively). A MultiEdit is folded onto disk element
#       by element IN ORDER and the composed IDENTITY compared ONCE — per-element
#       comparison passes a widening staged across two elements, because a later
#       element's old_string exists only after an earlier one has landed; its fence
#       delta counts only the elements overlapping the accumulator's CURRENT
#       frontmatter span, which is the Edit arm's rule composed. An edits
#       payload this gate cannot read is unanswerable, so it blocks fail-closed.
#   (d) Write, Edit or MultiEdit of a NEW agents/*.md — creation routes through the
#       agent_lifecycle CLI (MultiEdit creates via an empty first old_string, Edit
#       via an empty top-level one).
#   (e) scheduled-execution surface — ~/.glass-atrium/{autoagent,scripts,skills}/;
#       launchd runs autoagent/ code unattended, so a plain Edit persists code the
#       scheduler later executes (LLM06). rules/ + scoped/ are EXCLUDED by design —
#       hand-edited live and often, so blocking them would train a hook-disable
#       habit; sanctioned autoagent maintenance reroutes via HARNESS_PROTECTION_APPROVE=1.
#       PROT_RE mirrors these three dirs for the Bash arm.
#   (f) the live canary directory — the per-agent trial text inject-scope-rules.sh
#       delivers at spawn (`<data root>/data/learning/canary/`). Derived from the
#       data-root seam (hook-utils.sh → HOOK_DATA_DIR, GA_DATA_ROOT override), so a
#       relocated root moves the protected directory; PROT_DIR_RE carries the same
#       derived directory for the Bash arm, its lookahead matching the file form too.
#
# Bash arm (best-effort, bar-raising ONLY). Three structural pre-passes feed every
# recogniser: heredoc bodies whose consumer is NOT a shell are DATA and leave the
# scan; a quote mask restricts arming / command-position / redirect-OPERATOR
# recognition to UNQUOTED offsets; an ordered segmenter walks unquoted
# `; & | newline ( )` boundaries carrying a cwd-arming flag (parens push/pop it).
# On top of those, three block classes:
#   bash-mutation — a redirect whose IMMEDIATE target token is a protected path
#     (operators > >> >| >&, and &> via the segmenter; a bare fd after >& is an
#     fd dup, not a path), or a COMMAND-POSITION copy/permission verb (tee, cp,
#     mv, ln, chmod, install, rsync, truncate, sed -i/--in-place, dd through its
#     of= operand) followed by a protected-path literal in the same segment (the
#     launchctl-bootstrap plists com.{claude,glass-atrium}.*.plist count as
#     protected-path literals). Both the file form and the bare-directory form
#     of a protected path count, so `cp x <prot>/hooks` blocks like the
#     trailing-slash spelling. A quoted '>' (grep -- '->', awk '$1 > 5') and a
#     non-command-position verb word never present these shapes.
#   bash-interp-write — an interpreter (python/node/perl/ruby/awk, plus the shell
#     members) invoked with a CODE FLAG in its contiguous leading flag run, whose
#     code string names a protected path in the WRITE POSITION of a narrow
#     write-intent API. Position is what separates a write from a read: a
#     protected path read (shutil.copy(<prot>, /tmp/x), open(<prot>).read(),
#     readFileSync(<prot>)) passes even when the same code writes elsewhere.
#     Shell members enumerate no APIs: their code string re-enters the same
#     scanner (depth-capped), so `bash -c` composes with every rule above.
#   bash-cwd-relative-write — while a `cd`/`pushd` has armed a protected dir, a
#     RELATIVE redirect target or mutation-verb argument (an absolute one stays
#     allowed, so `cd <prot> && grep x f > /tmp/out` passes). A return to an
#     unnameable directory (`cd -`, `popd`, a bare `pushd` stack swap, a
#     `pushd +N`/`-N` rotation) re-arms whenever this command entered a protected
#     dir earlier — arming is a boolean over-approximation and staying armed is
#     the safe direction.
# PATH NORMALISATION. A protected path is recognised at seven sites. The five that
# hold a DISCRETE path token — a redirect target, an interpreter write target, an awk
# redirect target, dd's of= operand, and the cwd-arming argument — resolve it through
# the classifier's normalize_path before matching, so a redundant separator, a dot
# segment and a `..` backtrack all name the path they resolve to (parity with
# hook_normalize_path is pinned by a shared-corpus bats row). Resolution is LEXICAL —
# "resolves to" is the path the TEXT names, never the one the filesystem walks — so it
# cuts both ways only while no intermediate segment is a symlink: a backtrack OUT of the
# protected tree stops blocking a spelling that lands nowhere protected, and a symlinked
# segment makes that same resolution name a destination the filesystem does not (residual
# below). The cwd-arming DISARM test deliberately keeps reading the RAW token —
# it keys on the leading character, which the normaliser preserves. The two
# recognisers that hold a SLICE OF COMMAND TEXT instead (a mutation verb's argument
# region, an in-place perl/ruby segment) have no single token to resolve, so the two
# protected-path patterns tolerate redundant separators and dot segments there by
# construction; a `..` backtrack in those two positions is the residual below.
# DOCUMENTED RESIDUAL (not covered): a `..` backtrack spelled inside a COMMAND-TEXT
# region — a mutation verb's argument run or an in-place perl/ruby segment — because
# no pattern resolves a path and those two sites hold no token to resolve (the
# resulting over-block, e.g. `cp x <prot>/hooks/../../tmp/y`, is the safe direction);
# a protected path reached through a SYMLINKED intermediate segment — the normaliser is
# lexical, so `<prot>/link/../x` resolves by text alone and stops matching while the write
# lands wherever the link points; the direct spelling through that link is unrecognised
# too, so link-following is uniformly outside this arm's reach and no spelling of it is
# narrower than another;
# variable indirection, in shell
# (P=...; echo > "$P") AND inside an interpreter code string
# (p = "<prot>"; open(p, "w")) — every target reader is literal-only, so a
# variable-bound target passes; command substitution, quote-split paths,
# non-command-position verb runs (xargs/find -exec), an interpreter fed code on
# STDIN rather than through a code flag, a `pushd -n` (pushes WITHOUT moving, so
# its argument reads as a destination change), and a cd issued in an EARLIER Bash
# call (the machine is per-command; the envelope cwd field is deliberately unread
# until its live-cwd semantics are confirmed) — the settings deny layer + the
# Write|Edit arm remain the primary gates. The pure-bash hot-path prefilter (raw
# envelope must contain a ".claude" / ".glass-atrium" dir-name literal, else exit 0
# with zero python3 spawns) shares the same residual: an envelope hiding those
# literals behind indirection or JSON \uXXXX escapes skips this gate (an agent_id
# envelope skips the prefilter itself).
# KNOWN FALSE POSITIVES (over-block — the safe direction, left uncorrected):
#   - entered-a-protected-dir flag scan-scoped, not paren-scoped → a SUBSHELL cd
#     into a protected dir keeps a later `cd -`/`popd` conservative outside it
#   - copy verbs matched segment-wide → rsync/install naming a protected path as
#     their SOURCE block like a target
#   - unanchored protected literals, kept on purpose: no PROT_RE / PROT_DIR_RE
#     alternative anchored to home or to the path start → every protected literal
#     (a `.claude`, `.claude-<branch>` or `.glass-atrium` root segment plus its
#     protected child, a com.{claude,glass-atrium}.*.plist label, the canary
#     segments) matches at ANY depth in a recognised write position, from any
#     caller — e.g. a scratch fixture `<mktemp -d dir>/.claude/settings.json`
#     - not narrowable lexically: a pre-exec hook cannot prove a variable or
#       linked path lies outside home
#       - shell-maintained parameters ($_, $PWD, $OLDPWD), zsh indirect and table
#         assignments (${(P)…::=…}, functions[…]=, commands[…]=), bash
#         `printf -v<name>` → a name rebound with no visible binding
#       - a background directory watcher from an earlier call → a fresh random
#         directory linked into home before the write
#       - a hardlink → invisible to realpath
#     - workaround: a neutral name in a scratch fixture for the matched protected
#       segment (root directory or plist label)
#
# AGENT_ID ARMS (subagent and Workflow calls; main-session verdicts unchanged). Each runs only
# where the arms above pass, so it only adds blocks. Exemption: the lib's predicate with the job
# scratchpad (jobs/<id>/tmp/) and progress files alone — no BASENAME exception, which is the
# orchestrator's; the rest of projects/ (session transcripts, memory) and the runtime-data dirs stay
# protected, since the transcript count found no other subagent write under a profile root.
#   Write|Edit|MultiEdit — the target as written and as resolved (non-strict realpath) blocks when
#     it sits under a profile root of HOME or of HOME's physical spelling and is not exempt.
#   Bash — a positive rule: a word naming a path under a profile root adds no block only as a
#     proven read (an admitted operand of the closed READERS set in a clean command position, or
#     a `<` source); every other such word is judged by the exemption in both forms, and a
#     non-literal one blocks. A rebinding, an argv consumer (xargs, read, mapfile, parallel) or a
#     pipe into a segment that is not a stdin-safe consumer, anywhere in the call, voids every read
#     in it. Variables: a binding pass first collects every assignment, for/select list, array
#     element and nameref in the call, so each later word — a cd operand included — is judged in
#     every spelling its plain references take (each bound value, the inherited value, empty);
#     an operator or indirect reference to a name with a home-spelled value is unprovable, and a
#     name the call may also set some other way keeps the word's own judgment. An assignment a
#     child process sees (exported, allexport, an inherited name, a command prefix) is judged as
#     a word, and a rebound HOME blocks. Substitution bodies, interpreter code strings and heredoc
#     bodies are judged too, a variable spelled inside them in every spelling it takes, and from an
#     in-scope cwd each path-shaped string literal in them relative to it; an eval string, past
#     assignments and prefix words, is re-scanned as shell code whose cd carries out; text past
#     MAX_SCAN_DEPTH fails closed.
#   Residuals, by target (honor-system):
#     - classification time: the exemption reads the text and the filesystem when the hook runs,
#       so a link swapped in afterwards — by a watcher an earlier call of the same agent started —
#       is not seen
#     - a reader name rebound outside the call's text (a binary planted earlier in a PATH dir)
#     - what a reader, or a script run as a reader or interpreter script operand, writes, and
#       what an interpreter running its own code string does with a read piped into it
#     - a read whose output reaches another command's arguments through a command or process
#       substitution, a variable assigned from one, or a file (`rm "$(echo <profile>/CLAUDE.md)"`,
#       `X=$(ls -d <profile>/CLAUDE.md); rm $X`)
#     - a variable whose value the call sets by a construct the binding pass does not read
#       (`read`, `printf -v`, `getopts`, `${X:=…}`, zsh `for f (…)`), when no visible home
#       spelling or in-scope cd marks the word; a variable a child shell inherits through an
#       assignment the call does not export
#     - positional parameters, never expanded: `set -- <profile>/jobs/a/tmp; rm "$1/../x"`, a
#       function argument (`f() { rm "$1/x"; }; f <profile>`), `bash -c '…' _ <profile>`
#     - a path an interpreter's code builds at run time (concatenation, a format string, a value
#       it reads), beyond the literals and variable spellings visible in its code text
#     - a relative spelling with no cd, resolved against the session cwd
#       (`echo x > .claude-personal/CLAUDE.md` from a $HOME cwd)
#     - a non-literal word reaching home with no visible home prefix (a glob over the home path,
#       a variable the call never binds, a `${X}aude` plant), and a profile path
#       embedded mid-word outside a code string, a substitution body or a heredoc
#     - zsh-only expansions the classifier does not model
#   Main-session gaps (pass today for every caller; follow-up candidates): the quoted command
#     word, flagged NEUTRAL_PREFIX members (`env -i`, `command -p`, `exec -a`), `coproc`, `eval`,
#     zsh precommand modifiers, the zsh short `if` and `always`, wrappers (`nice`, `xargs`), zsh
#     clobber redirects (`>!`, `>>!`, `&>!`, `>&!`, `>>|`, `2>!`) onto a live hook or settings
#     file, a command substitution inside double quotes, backticks or an unquoted-delimiter
#     heredoc, a `bash -c` nested past MAX_SCAN_DEPTH, interpreter code fed on stdin, `ln -s` of a
#     root or of home, a read piped into xargs or a shell, a variable bound to a protected path
#     (`F=~/.claude/settings.json; echo x > "$F"`), and staging through an append to a profile
#     `shell-snapshots/` file, which the Bash tool sources before every later call.
#
# Grant: HARNESS_PROTECTION_APPROVE=1 in the hook's LAUNCH environment → pass
# (parity with CONFIG_PROTECTION_APPROVE). CAVEAT: an in-session
# `export HARNESS_PROTECTION_APPROVE=1` via the Bash tool NEVER reaches the hook —
# hooks inherit the environment Claude Code was LAUNCHED with, not the session
# shell's children. Sanctioned live-sync delegations therefore need the launch-env
# grant, or those writes go via the existing NON-hook-mediated paths
# (installer / update.sh / daemon-apply / agent_lifecycle sync-inject).
#
# Fail-closed on python3 absence AND on classifier failure (DEL-002 precedent
# family): an extraction degraded to EMPTY would silently disarm the gate via the
# empty-target allow. Non-trivial input with python3 missing — or a classifier
# that exits non-zero, or whose in-band status trailer reads empty or misaligned
# (a non-numeric triple count or a triple run of the wrong length included) — is a
# HAR-003 block (exit 2), never a pass.
# Path matching is CASE-INSENSITIVE on BOTH arms, at every layer (prefilter,
# protected-path regexes, dispatch globs): the real volume is APFS, which resolves a
# case-varied spelling onto the protected file. Widening-only — on a case-SENSITIVE
# volume it blocks more, never less.
# Block channel: stderr emit_error + exit 2 (shared-hook-capability-contract.md).
# Scope: Write|Edit arm — LIVE install paths ONLY (HOME-anchored; the canary directory
# data-root-anchored), the git repo tree untouched; Bash arm — unanchored (KNOWN FALSE
# POSITIVES → unanchored protected literals).

set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# Launch-env approval — pass for an explicitly approved harness change.
if [[ "${HARNESS_PROTECTION_APPROVE:-}" == "1" ]]; then
  exit 0
fi

INPUT="$(hook_read_input)"

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard
# (mirrors enforce-delegation.sh DEL-002). Empty input ("{}") stays exit 0.
hook_require_python3_unless_empty "${INPUT}" "HAR-003" \
  "Harness-critical gate unavailable: python3 is required to parse hook input"

# Case-insensitive shell matching — the ONE bash-layer normalisation point (the
# python counterpart is re.IGNORECASE on the two protected-path regexes), so the
# prefilter, the dispatch globs and any future protection class inherit the
# property instead of re-deriving it per class.
# Why: the real volume is APFS (case-INSENSITIVE), so the OS resolves
# `.claude/Settings.json` onto the protected file while a case-SENSITIVE gate
# discards the block.
# MONOTONE-WIDENING BY CONSTRUCTION, not by inspection: for a fixed pattern every
# string matching case-sensitively still matches, and none of this file's 8 `case`
# sites is an allowlist-shaped early exit-0-on-match → the option can only ever
# block MORE. block_wording's per-class site is the 8th and selects TEXT only: every
# arm including `*)` returns into the caller's terminal `exit 2`, so a folded class
# name can change wording but never a verdict.
# Shell-GLOBAL, so two further enumerations complete that argument — record them
# here, or the next hook-utils.sh edit silently invalidates it:
#   (a) hook-utils.sh patterns reachable from here — hook_normalize_path's
#       '~' / '~/'* / /* / "" / "." / ".." arms · hook_input_is_empty's
#       "" / "{}" / "{ }" arms · _hook_json_escape's substitutions — are all
#       LETTER-FREE, so folding is a provable no-op there.
#   (b) the `[[ ]]` and parameter-expansion patterns it equally governs — the
#       PY_STATUS digit literal · the `error:*` / `block:*` verdict arms and the
#       `${VERDICT#block:}` strip (classifier-generated lowercase) · the TOOL_NAME
#       comparison (folds wider, harmless) · the TRIPLE_COUNT digit test and the
#       triple flag literal (classifier-generated) · the agent_id scope tests in
#       is_agent_form_blocked (fold wider). The ONE collapse it would cause is
#       held out in POSIX test form at write_edit_arm's raw-vs-normalised
#       inequality, which this option does not govern.
#   (c) the lib's claude_config_is_exempt_entry, reached through
#       is_agent_form_blocked — the first allowlist-shaped pass under this option.
#       A fold there admits only a case variant of a jobs/<id>/tmp or progress name, which APFS resolves to the same entry; the home prefix is
#       stripped case-sensitively and membership is anchored at the remainder's
#       first segment, so a fold never exempts a different file. The Bash reader-set
#       test sits in the classifier and is case-sensitive: a case-varied reader name
#       is a non-reader, an over-block.
# Accepted trades: an over-block on a case-SENSITIVE volume (fail-toward-blocking
# is the correct direction for a security floor) · folding is locale-dependent, so
# a Turkish-locale dotless-i spelling still evades — an INCOMPLETE widening
# relative to HEAD, never a narrowing.
shopt -s nocasematch

# Canary directory below the data root — the directory inject-scope-rules.sh reads as its CANARY_DIR.
readonly CANARY_DIR_SUFFIX="learning/canary"

# Hot-path prefilter (pure bash, zero spawns): every protected class of the
# agent_id-independent arms textually requires one of the two protected-root dir-name literals in the raw envelope, or
# the canary directory's own name — a relocated data root carries no root literal.
# PROT_RE and the deterministic path classes literal-match on them, and traversal
# forms still contain them. No literal → nothing this gate can block → exit 0.
# Residual shared with the Bash arm: indirection / JSON \uXXXX escaping of the
# literals skips this gate (see header).
# An agent_id envelope skips it: a resolved-form target can hold no root literal at all (a write
# through a link planted earlier to a profile root), so for the agent_id write gate this premise
# fails. A false key match costs one classifier spawn, never a verdict.
case "${INPUT}" in
  *'"agent_id"'* | *".claude"* | *".glass-atrium"* | *"${CANARY_DIR_SUFFIX##*/}"*) : ;;
  *) exit 0 ;;
esac

CLAUDE_DIR="${HOME}/.claude"
GA_DIR="${HOME}/.glass-atrium"
CANARY_DIR="$(hook_normalize_path "${HOOK_DATA_DIR}/${CANARY_DIR_SUFFIX}")"
readonly CLAUDE_DIR GA_DIR CANARY_DIR

# Single-pass envelope classifier (python3 — robust JSON/frontmatter/regex parsing),
# ONE spawn for the whole hook: emits tool_name, the arm target (file_path for
# Write|Edit, command for Bash), and the content-inspection verdict
# (block:<reason> | allow | error:<ExcType>), each NUL-terminated (hook_get_fields
# consumer convention). An internal refinement exception NEVER resolves to allow:
# the refinement is the sole owner of the interpreter classes, so swallowing one
# disarms them silently. It names its exception type in the verdict field and
# exits non-zero, engaging the HAR-003 fail-closed gate below.
# Unparseable agent frontmatter blocks the tool layer only — repair the frontmatter
# in the SOURCE repository with a non-tool-layer editor and ship it through the
# release path; this is a detour around the tool layer, never a lockout.
# `read -d ''` builtin assignment (no command-substitution-of-cat subshell); read
# returns 1 at heredoc EOF without a NUL → `|| true`.
IFS= read -r -d '' DETECT_PY <<'PY' || true
import json
import os
import re
import sys


# Identity trio ONLY — the operator pin key (model:) stays OUT of the guarded set
# by governance, so a live model pin edits freely. Column-0 anchoring is what keeps
# a folded continuation or a nested-map value from impersonating a guarded key.
GUARDED_KEYS = ("name", "tools", "scope")
GUARDED_KEY_RE = re.compile(r"^(name|tools|scope)[ \t]*:(.*)$")
PLAIN_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]*$")
LIST_ITEM_RE = re.compile(r"^[ \t]*-[ \t]+(.*)$")
NESTED_KEY_RE = re.compile(r"^[ \t]+[A-Za-z_][A-Za-z0-9_.\-]*[ \t]*:")


class FrontmatterUnparseable(Exception):
    """A GUARDED key's value is outside the parse contract — the guard cannot answer
    the identity question, so it must not allow (fail-closed). Raised only from
    guarded-key value paths; exotic shapes under non-guarded keys traverse inertly."""

# Protected-path literals (best-effort text match — Bash arm). The launchd
# alternation matches the harness launchctl-bootstrap plists by label
# (com.claude.* legacy + com.glass-atrium.* live) — the same label form
# daemon_cycle.py treats as a safety-tier surface; the label itself carries the
# prefilter literal, so a plist envelope reaches this classifier.
# IGNORECASE is the python counterpart of the shell's nocasematch and is purely
# WIDENING; it lands on exactly these two compiles, which covers every consumer of
# both at once — the combined protected-path predicate and the cwd-arming site.
# NOT re.ASCII alongside it — that redefines PROT_DIR_RE's
# trailing lookahead below. And NEVER a global locale export: the classifier
# inherits the hook environment, where a stdin decode failure degrades to an empty
# tool name and a fallthrough exit 0, so a locale pin can turn the gate FAIL-OPEN.
# A separator run the filesystem resolves to ONE separator: `/`, `//`, `/./`, `///`.
# Inserted only BETWEEN a protected root name and what follows it — never BEFORE a
# root name, because the leading dot on every alternative is what keeps this
# repository's own development checkout (.../git/glass-atrium/hooks/) out. It is a
# REPEATED separator, never an optional one, so the file form's trailing separator
# survives and a suffixed sibling (.glass-atrium/hooksx) still fails to match.
# It cannot resolve a `..` backtrack — no pattern can, because a backtrack is a
# resolution and not a spelling; the five discrete-token sites call normalize_path
# for that, and the two command-text sites carry it as a documented residual.
SEP = r"/(?:\.?/)*"

# Config root: `.claude` plus every `.claude-<branch>` profile dir, the dialect-native
# counterpart of lib/claude-config-dirs.sh's ERE fragment — the heredoc delimiter stays
# QUOTED, so the two grammars are declared independently and pinned equal by the
# shared-probe parity row in enforce-harness-critical-branch.bats. The suffix opens with an
# alnum (a bare `.claude-` is not a root, `.claudex` cannot match) and its class excludes
# `/`, so it can never over-reach past the root segment.
CLAUDE_ROOT = r"\.claude(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?"

# Live canary directory, handed over by the shell from the data-root seam. Its last four segments
# (root name, data, learning, canary) are the protected spelling, matched wherever they sit like the
# root-name literals above, so `~`, `$HOME` and absolute prefixes all match. An absent value — the
# module imported outside the hook — protects nothing, never every path.
CANARY_SEGMENTS = [seg for seg in os.environ.get("HARNESS_CANARY_DIR", "").split("/") if seg][-4:]
CANARY_DIR_RE = SEP.join(re.escape(seg) for seg in CANARY_SEGMENTS) if CANARY_SEGMENTS else r"(?!)"

PROT_RE = re.compile(
    "|".join((
        CLAUDE_ROOT + SEP + r"settings(?:\.local)?\.json",
        CLAUDE_ROOT + SEP + r"hooks" + SEP,
        r"\.glass-atrium" + SEP + r"hooks" + SEP,
        r"\.claude" + SEP + r"agents" + SEP,
        r"\.glass-atrium" + SEP + r"agents" + SEP,
        r"\.glass-atrium" + SEP + r"autoagent" + SEP,
        r"\.glass-atrium" + SEP + r"scripts" + SEP,
        r"\.glass-atrium" + SEP + r"skills" + SEP,
        r"com\.(?:claude|glass-atrium)\.[^/]+\.plist",
    )),
    re.IGNORECASE,
)

# Directory form of the protected roots, for cwd arming. A `cd` argument
# conventionally carries no trailing slash, which PROT_RE requires — so PROT_RE
# would arm on nothing. The trailing negative lookahead keeps a longer sibling
# name (.glass-atrium/autoagent-backup) OUT. The leading dot is what keeps the
# git repo tree (.../git/glass-atrium/hooks/) from arming.
# The hooks and agents alternatives are SPLIT rather than sharing one group: hooks/ of every
# profile branch is protected, agents/ stays rooted at the literal `.claude` this cycle.
PROT_DIR_RE = re.compile(
    r"(?:" + CLAUDE_ROOT + SEP + r"hooks"
    + r"|\.claude" + SEP + r"agents"
    + r"|\.glass-atrium" + SEP + r"(?:hooks|agents|autoagent|scripts|skills)"
    + r"|" + CANARY_DIR_RE + r")"
    + r"(?![\w.\-])",
    re.IGNORECASE,
)

# Copy/mutation/permission verbs recognised in COMMAND position (sed only with an
# in-place flag run). chmod is here because a mode-644 flip on a live hook
# silently disarms it. dd carries its target in an `of=` operand rather than a
# trailing argument, so it is recognised through a dedicated operand check.
# A CLOSED allowlist — read-only verbs never join it, and no wildcarding.
MUTATION_VERBS = (
    "tee", "cp", "mv", "ln", "chmod", "sed", "install", "rsync", "dd", "truncate",
)
NEUTRAL_PREFIX = ("sudo", "env", "command", "nohup", "time", "exec")

# Interpreter class. Shell members carry no write-API list: their code string is
# re-scanned by this same machine, so `bash -c` composes with every other rule
# instead of needing a parallel rule set.
INTERP_SHELL = ("sh", "bash", "zsh", "dash", "ksh")
INTERP_AWK = ("awk", "gawk", "mawk", "nawk")
INTERP_NODE = ("node", "nodejs", "bun", "deno")
PYTHON_NAME_RE = re.compile(r"^python(?:[23](?:\.\d+)?)?$")

ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*=")
# Code flag = the single strongest false-positive limiter. It must appear in the
# CONTIGUOUS leading flag run, so `python3 -m agent_lifecycle add` (module form,
# the sanctioned CLI) stops at the non-flag word and never matches.
CODE_FLAG_RE = re.compile(r"^-[a-zA-Z]*[cep]$")
LONG_CODE_FLAG_RE = re.compile(r"^--(?:eval|print)(?:=(.*))?$")
# In-place flag run — perl/ruby ONLY (`python3 -i` is the REPL), mirroring sed -i.
# The long twin `--in-place[=SUF]` is GNU sed's own spelling of the same flag.
INPLACE_FLAG_RE = re.compile(r"^-[a-zA-Z]*i(?:\.\S*)?$")
LONG_INPLACE_FLAG_RE = re.compile(r"^--in-place(?:=.*)?$")
HEREDOC_OP_RE = re.compile(r"<<(-?)(?!<)[ \t]*(['\"]?)([A-Za-z_][A-Za-z_0-9]*)\2")
AWK_REDIR_RE = re.compile(r">{1,2}[ \t]*(?:\"([^\"]*)\"|'([^']*)'|(\S+))")

# Write-intent APIs, per language and deliberately narrow, each carrying the
# ARGUMENT POSITIONS that name a WRITE target. Position is the discrimination
# the arm turns on: shutil.copy(<prot>, /tmp/backup) reads the protected path
# and writes elsewhere, while the same literal at position 1 is a write TO it —
# a target-blind match cannot tell those apart and over-blocks the read.
# Positions are 0-based; ALL_ARGS / TAIL_ARGS cover the list-taking verbs
# (unlink(a, b) · chmod(mode, a, b)). A source position joins the write set only
# when the call DESTROYS the source (rename / move), never for a plain copy.
# A bare `.write(` stays EXCLUDED: `sys.stdout.write(open(p).read())` is a read.
# Mode strings match WHOLE (mode letters only), so `errors='replace'` cannot
# pose as a mode.
ALL_ARGS = "*"
TAIL_ARGS = "1:"

QUOTED_RE = re.compile(r"'([^']*)'|\"([^\"]*)\"")
# node spells a string three ways — the template literal is the third, and only
# the node dispatch reads it (a backtick is command substitution in perl/ruby).
# The backquote is spelled \x60 throughout, per the enclosing-heredoc convention.
NODE_QUOTED_RE = re.compile(r"'([^']*)'|\"([^\"]*)\"|\x60([^\x60]*)\x60")
PY_MODE_ARG_RE = re.compile(r"^\s*(?:mode\s*=\s*)?(['\"])[rwaxbt+]*[wax+][rwaxbt+]*\1\s*$")
PY_OSFLAG_ARG_RE = re.compile(r"\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b")
NODE_MODE_ARG_RE = re.compile(r"^\s*(['\"\x60])[rwaxs+]*[wax+][rwaxs+]*\1\s*$")
RUBY_MODE_ARG_RE = re.compile(r"^\s*(['\"])[rwaxb+]*[wax+][rwaxb+]*\1\s*$")

# (api regex ending at its own '(', write-position spec, mode-argument guard).
PY_WRITE_RULES = (
    (re.compile(r"\bopen\s*\("), (0,), PY_MODE_ARG_RE),
    (re.compile(r"\bos\.open\s*\("), (0,), PY_OSFLAG_ARG_RE),
    (re.compile(r"\bos\.(?:remove|unlink|truncate|chmod|makedirs|mkdir|rmdir)\s*\("), (0,), None),
    (re.compile(r"\bos\.(?:rename|replace)\s*\("), (0, 1), None),
    (re.compile(r"\bos\.(?:symlink|link)\s*\("), (1,), None),
    (re.compile(r"\bshutil\.(?:copy2|copyfile|copytree|copy)\s*\("), (1,), None),
    (re.compile(r"\bshutil\.move\s*\("), (0, 1), None),
    (re.compile(r"\bshutil\.rmtree\s*\("), (0,), None),
)
# Receiver form — Path('<target>').write_text(...) names its target BEFORE the API.
PY_RECEIVER_RE = re.compile(
    r"(['\"])(?P<t>[^'\"]*)\1\s*\)?\s*\.(?:write_text|write_bytes|writelines)\s*\("
)
# Receiver form carrying a MODE — Path('<target>').open('w'). The mode is the
# whole discrimination: the same receiver with no mode, or a read one, is a read.
PY_RECEIVER_OPEN_RE = re.compile(
    r"(['\"])(?P<t>[^'\"]*)\1\s*\)?\s*\.open\s*\((?P<a>[^)]*)\)"
)
# fileinput rewrites the files it is HANDED and there is no argument position to
# key on, so every literal in the code string counts as a candidate target.
PY_INPLACE_RE = re.compile(r"\binplace\s*=\s*True\b")

NODE_WRITE_RULES = (
    (re.compile(r"\b(?:writeFile|appendFile)(?:Sync)?\s*\("), (0,), None),
    (re.compile(r"\b(?:unlink|rmdir|truncate|chmod|mkdir|rm)(?:Sync)?\s*\("), (0,), None),
    (re.compile(r"\bcopyFile(?:Sync)?\s*\("), (1,), None),
    (re.compile(r"\brename(?:Sync)?\s*\("), (0, 1), None),
    (re.compile(r"\bsymlink(?:Sync)?\s*\("), (1,), None),
    (re.compile(r"\bcreateWriteStream\s*\("), (0,), None),
    (re.compile(r"\bopenSync\s*\("), (0,), NODE_MODE_ARG_RE),
)

# perl: 3-arg open names the target after the mode, 2-arg carries it inside the
# mode string. A read mode ('<') matches neither, so a read open never fires.
PERL_OPEN3_RE = re.compile(
    r"\b(?:sys)?open\b[^;\n]{0,60}?(['\"])[ \t]*\+?>{1,2}[ \t]*\1[ \t]*,[ \t]*(['\"])(?P<t>[^'\"]*)\2"
)
PERL_OPEN2_RE = re.compile(
    r"\b(?:sys)?open\b[^;\n]{0,60}?(['\"])[ \t]*\+?>{1,2}[ \t]*(?P<t>[^'\"]+)\1"
)
# perl's list verbs are routinely written without parentheses, so the target
# window is the rest of the statement rather than a parsed argument list.
PERL_VERB_RE = re.compile(
    r"\b(?:unlink|rename|chmod|truncate|mkdir|rmdir|symlink)\b(?P<t>[^;\n]{0,120})"
)

RUBY_WRITE_RULES = (
    (re.compile(r"\b(?:File|IO)\.write\s*\("), (0,), None),
    (re.compile(r"\bFile\.(?:delete|unlink)\s*\("), (ALL_ARGS,), None),
    (re.compile(r"\bFile\.rename\s*\("), (0, 1), None),
    (re.compile(r"\b(?:File|IO)\.(?:open|new)\s*\("), (0,), RUBY_MODE_ARG_RE),
    (re.compile(r"\bFileUtils\.(?:cp_r|cp|install)\s*\("), (1,), None),
    (re.compile(r"\bFileUtils\.mv\s*\("), (0, 1), None),
    (re.compile(r"\bFileUtils\.(?:rm_rf|rm_r|rm|mkdir_p|mkdir)\s*\("), (ALL_ARGS,), None),
    (re.compile(r"\bFileUtils\.chmod\s*\("), (TAIL_ARGS,), None),
)
# Shell escape hatches inside a code string — the argument is shell text, so it
# is re-scanned rather than met with a second API enumeration. The backtick is
# spelled \x60 so the enclosing bash heredoc scan never sees a literal backquote.
ESCAPE_RE = re.compile(
    r"(?:os\.system|os\.popen"
    r"|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput)"
    r"|child_process\.exec(?:Sync|File|FileSync)?"
    r"|\bsystem)[ \t]*\([ \t]*(['\"])(.*?)\1"
)
BACKTICK_RE = re.compile(r"\x60([^\x60]*)\x60")

MAX_SCAN_DEPTH = 2

# Directory-stack rotation argument (`pushd +1`, `popd -0`) — it names a stack
# SLOT, never a path, so the destination is as unnameable as `cd -`.
ROTATE_ARG_RE = re.compile(r"^[+-]\d+$")

# Scan-scoped: a protected dir was entered by some earlier cd in THIS command.
# It is what makes a return to an unnameable directory (`cd -`, `popd`) decide
# conservatively without false-blocking a command that never went near one.
PROT_CD_SEEN = [False]


def frontmatter_span(text):
    """(start, end) char offsets of the frontmatter block, fences inclusive — or None."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None
    pos = len(lines[0]) + 1
    for line in lines[1:]:
        if line.strip() == "---":
            return (0, pos + len(line))
        pos += len(line) + 1
    return None


def normalize_path(path):
    """Mirror of hook_normalize_path (hook-utils.sh) — leading ~ / ~/ expansion via
    HOME, ~user left literal (no portable stock-Bash resolution), then "." / ".."
    segment collapse without touching the filesystem. The classifier reads the disk
    itself, so it needs the resolved form BEFORE read_disk; parity with the shell
    helper is pinned by a bats row feeding one shared corpus through both, and the
    helper itself is NOT modified."""
    home = os.environ.get("HOME", "")
    if path == "~" and home:
        path = home
    elif path.startswith("~/") and home:
        path = home + "/" + path[2:]
    lead = "/" if path.startswith("/") else ""
    out = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            # Pop the last real segment (never past root / a leading "..").
            if out and out[-1] != "..":
                out.pop()
            elif not lead:
                out.append("..")
            continue
        out.append(seg)
    return lead + "/".join(out)


def resolved_form(path):
    """Non-strict realpath of a target as written, only a leading ~ / ~/ expanded — never the
    normalize_path output, which collapses `..` lexically where the kernel follows a link first.
    Non-strict follows a dangling final link and keeps a nonexistent tail. Relative → ""."""
    home = os.environ.get("HOME", "")
    if path == "~" and home:
        path = home
    elif path.startswith("~/") and home:
        path = home + "/" + path[2:]
    return os.path.realpath(path) if path.startswith("/") else ""


def strip_inline_comment(text):
    """Drop a trailing ` #` comment that starts OUTSIDE a quoted span. An unbalanced
    quote leaves the remainder quoted, so nothing is stripped — literal, never lossy."""
    quote = None
    for i, ch in enumerate(text):
        if quote is not None:
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "#" and i > 0 and text[i - 1] in (" ", "\t"):
            return text[:i]
    return text


def canon(text):
    """Canonical form of a scalar or list item: whitespace-trimmed, inline comment
    dropped, ONE balanced surrounding quote pair removed. An UNBALANCED quote is
    taken literally — safe, because a genuine widening still differs."""
    out = strip_inline_comment(text.strip()).rstrip()
    if len(out) >= 2 and out[0] == out[-1] and out[0] in ("'", '"'):
        out = out[1:-1]
    return out


def split_flow(body):
    """Inline-flow body → canonical items, splitting on commas outside quotes."""
    items = []
    buf = []
    quote = None
    for ch in body:
        if quote is not None:
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            buf.append(ch)
        elif ch == ",":
            items.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    items.append("".join(buf))
    return [c for c in (canon(x) for x in items) if c != ""]


def guarded_key_line(line):
    """(name, raw value) for a column-0 guarded key line, else None.

    The host parser folds `"tools":` onto `tools`, so the bare matcher alone reads a
    quoted twin as prose while the grant it carries is real — key-side quote tolerance
    is the same allowance canon() already gives the value side. A column-0 key spelling
    that resolves to NEITHER a guarded key nor a plain identifier (an escape, an
    unbalanced quote) is one the host may still fold onto a guarded key, so it is
    unanswerable rather than inert. Colon-LESS column-0 lines — the fences among them
    — carry no key at all and stay inert."""
    bare = GUARDED_KEY_RE.match(line)
    if bare is not None:
        return bare.group(1), bare.group(2)
    if line[:1] in (" ", "\t") or LIST_ITEM_RE.match(line) is not None:
        return None
    head, sep, rest = line.partition(":")
    if not sep:
        return None
    spelling = head.strip()
    if len(spelling) >= 2 and spelling[0] == spelling[-1] and spelling[0] in ("'", '"'):
        spelling = spelling[1:-1]
    if spelling in GUARDED_KEYS:
        return spelling, rest
    if PLAIN_KEY_RE.match(spelling) is None:
        raise FrontmatterUnparseable("unreadable key spelling: " + head.strip())
    return None


def identity_struct(text):
    """Guarded key → the STRUCTURE it grants, parsed from the frontmatter region only.

    `tools` folds to a frozenset of canonical items in BOTH the inline-flow and the
    block-list form, so the two spellings of one grant compare equal and a widening
    is visible in either. `name`/`scope` are canonical scalars. An ABSENT guarded key
    is absent from the dict (both-absent compares equal); `tools:` with no items is
    an EMPTY frozenset, which differs from absence — revoking every grant is a change.
    Raises FrontmatterUnparseable when a guarded value leaves the parse contract, and
    when a guarded key occurs TWICE in any quoting mix: the host keeps the LAST value,
    so reproducing that fold here would make the winning grant unanswerable."""
    span = frontmatter_span(text)
    if span is None:
        return {}
    out = {}
    key = None
    items = []
    seen = set()

    def flush():
        if key is not None:
            out[key] = frozenset(items)

    for line in text[span[0]:span[1]].split("\n"):
        # Blank lines and full-line comments PRESERVE block-list state — a live agent
        # file puts a comment directly above `tools:` and between its items.
        if not line.strip() or re.match(r"^[ \t]*#", line):
            continue
        guarded = guarded_key_line(line)
        if guarded is not None:
            flush()
            key, items = None, []
            name, rest = guarded[0], canon(guarded[1])
            if name in seen:
                raise FrontmatterUnparseable("duplicate guarded key: " + name)
            seen.add(name)
            if rest == "":
                key = name
            elif rest.startswith("["):
                if not rest.endswith("]"):
                    raise FrontmatterUnparseable("multi-line flow on " + name)
                out[name] = frozenset(split_flow(rest[1:-1]))
            elif rest[0] in (">", "|", "&", "*") or rest.startswith("!!"):
                raise FrontmatterUnparseable("block scalar/anchor/tag on " + name)
            else:
                out[name] = rest
            continue
        if line[:1] not in (" ", "\t"):
            item = LIST_ITEM_RE.match(line) if key is not None else None
            if item is not None:
                # Column-0 list items are legal YAML and appear in live agent files.
                items.append(canon(item.group(1)))
                continue
            # Any other column-0 line (a non-guarded key, a fence) closes the block
            # list and is traversed inertly.
            flush()
            key, items = None, []
            continue
        if key is None:
            # Folded continuations, nested maps and list items under a NON-guarded
            # key never reach the guarded state — this is the containment boundary.
            continue
        item = LIST_ITEM_RE.match(line)
        if item is not None:
            items.append(canon(item.group(1)))
            continue
        if NESTED_KEY_RE.match(line):
            raise FrontmatterUnparseable("nested map under " + key)
        raise FrontmatterUnparseable("unrecognised value line under " + key)
    flush()
    return out


def read_disk(path):
    """On-disk text, or "" when the path is absent/unreadable. Absence is the
    EXPECTED shape for a new-file Write and must not read as an internal defect:
    the bash arm blocks a new agents/*.md by its own -e check, and every other
    new path leaves this arm before the verdict is consulted."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def fence_count(text):
    """Lines the frontmatter parser treats as a fence (strip == '---')."""
    return sum(1 for line in text.split("\n") if line.strip() == "---")


def unterminated(disk):
    """Opening fence present but no closing fence — a tampered frontmatter state."""
    return frontmatter_span(disk) is None and disk.split("\n", 1)[0].strip() == "---"


def overlaps_frontmatter(text, old):
    """True when SOME occurrence of `old` in `text` intersects text's frontmatter
    span. One definition serves both arms, so the MultiEdit fence delta is scoped by
    the same rule as the Edit one instead of re-deriving it."""
    span = frontmatter_span(text)
    if span is None:
        return False
    start = text.find(old)
    while start != -1:
        if start < span[1] and (start + len(old)) > span[0]:
            return True
        start = text.find(old, start + 1)
    return False


def detect_agent_write(tool_input):
    """Write on an EXISTING agents/*.md — block when the parsed identity structure
    differs from disk, or when the on-disk frontmatter is unterminated (tampered)."""
    disk = read_disk(tool_input.get("file_path", ""))
    content = tool_input.get("content", "")
    if unterminated(disk):
        return "unterminated-frontmatter"
    try:
        if identity_struct(disk) != identity_struct(content):
            return "identity-frontmatter-write"
    except FrontmatterUnparseable:
        return "frontmatter-unparseable"
    return ""


def detect_agent_edit(tool_input):
    """Edit on agents/*.md — block when old_string overlaps the on-disk frontmatter
    AND the edit alters the fence-line count OR the parsed identity structure.
    An unterminated opening fence blocks outright (tampered state).

    An EMPTY old_string is the host's own CREATE operation, not a no-op, so it can
    never take the overlap short-circuit: an absent target is owned by the shell
    arm's creation guard, and on an EXISTING guarded file the result is a whole-file
    overwrite this pair-wise arm cannot model — unanswerable, hence fail-closed.
    Missing or non-string old/new is likewise unreadable. Presence is tested BEFORE
    type and never by truthiness, because "" is exactly the legitimate create
    spelling and a truthiness gate would collapse the two shapes into one."""
    if "old_string" not in tool_input or "new_string" not in tool_input:
        return "unreadable-edit-payload"
    old = tool_input["old_string"]
    new = tool_input["new_string"]
    if not isinstance(old, str) or not isinstance(new, str):
        return "unreadable-edit-payload"
    if old == "":
        return "edit-create-shape"
    disk = read_disk(tool_input.get("file_path", ""))
    if unterminated(disk):
        return "unterminated-frontmatter"
    if not overlaps_frontmatter(disk, old):
        return ""
    if fence_count(old) != fence_count(new):
        return "frontmatter-fence-edit"
    # Apply the edit and compare the parsed region before vs after. `replace_all`
    # mirrors the Edit tool's own semantics; the default is first-occurrence.
    after = disk.replace(old, new) if tool_input.get("replace_all") else disk.replace(old, new, 1)
    try:
        if identity_struct(disk) != identity_struct(after):
            return "identity-frontmatter-edit"
    except FrontmatterUnparseable:
        return "frontmatter-unparseable"
    return ""


def apply_edits(disk, edits):
    """(composed text, fence-tamper flag) for every edits[] element applied IN ORDER,
    each honouring its OWN replace_all — the Edit tool's semantics, composed. A
    payload that is not a non-empty list of dicts carrying string old/new is one this
    gate cannot read, and an unreadable envelope on a guarded path is unanswerable,
    not inert.

    The fence flag is scoped per element against the ACCUMULATOR, never against disk:
    an element's `---` delta counts only while its old_string overlaps the
    accumulator's CURRENT frontmatter span. Scoping it to the accumulator is what
    keeps the staged shape visible (a later element's old_string exists only after an
    earlier one lands, so a disk probe would miss it), and scoping it at all is what
    keeps a body horizontal rule out of the count."""
    if not isinstance(edits, list) or not edits:
        raise FrontmatterUnparseable("unreadable MultiEdit edits payload")
    after = disk
    fence_tamper = False
    for element in edits:
        if not isinstance(element, dict):
            raise FrontmatterUnparseable("MultiEdit element is not a mapping")
        # PRESENCE before type: an empty-string default is itself a string, so the
        # type test alone reads a MISSING key as an empty edit. Presence — never
        # truthiness — is the test, because a present-but-empty old_string is the
        # legitimate create shape.
        if "old_string" not in element or "new_string" not in element:
            raise FrontmatterUnparseable("MultiEdit element is missing old_string or new_string")
        old = element["old_string"]
        new = element["new_string"]
        if not isinstance(old, str) or not isinstance(new, str):
            raise FrontmatterUnparseable("MultiEdit element old/new is not a string")
        if fence_count(old) != fence_count(new) and overlaps_frontmatter(after, old):
            fence_tamper = True
        after = after.replace(old, new) if element.get("replace_all") else after.replace(old, new, 1)
    return after, fence_tamper


def detect_agent_multiedit(tool_input):
    """MultiEdit on agents/*.md — fold the whole edits array onto disk, then compare
    the composed result ONCE.

    A per-element probe against DISK is exploitable: element 1 makes a
    frontmatter-overlapping but struct-NEUTRAL change, and element 2's old_string
    exists only AFTER element 1 lands, so its own overlap test misses while the
    composed file widens `tools`. Folding first is what makes the staged shape
    visible, so the IDENTITY comparison stays unconditional on the composed result.

    Only the FENCE delta is per-element (apply_edits, scoped to the accumulator's
    current frontmatter span). A whole-file `---` count cannot tell a frontmatter
    fence from a body horizontal rule, so it blocked benign body rules the Edit arm
    allows — and its only unique coverage was an f3-shaped second `---`…`---` block
    appended AFTER the real closing fence, a shape a whole-file count cannot
    distinguish from that same benign rule. That shape is now NOT COVERED: whether
    the host parser reads a second block as frontmatter at all is UNPROBED, and
    trading one unprobed assumption for another is not a fix (the post-rescope
    verdict is pinned as a characterization row in the MultiEdit suite).

    A composed file whose frontmatter span is GONE while disk had one is a tampered
    state no per-element overlap need establish, so it fails closed on its own."""
    disk = read_disk(tool_input.get("file_path", ""))
    if unterminated(disk):
        return "unterminated-frontmatter"
    try:
        after, fence_tamper = apply_edits(disk, tool_input.get("edits"))
        if fence_tamper:
            return "frontmatter-fence-edit"
        if frontmatter_span(disk) is not None and frontmatter_span(after) is None:
            return "frontmatter-fence-edit"
        if identity_struct(disk) != identity_struct(after):
            return "identity-frontmatter-edit"
    except FrontmatterUnparseable:
        return "frontmatter-unparseable"
    return ""


def quote_mask(text):
    """Per-offset boolean: True inside a single/double-quoted span (quote chars
    included). Arming, command-position and redirect-OPERATOR recognition read
    only UNQUOTED offsets, which is what stops an echoed or heredoc-quoted
    command from arming. An unbalanced quote leaves the remainder unquoted —
    the pre-mask behaviour, so ambiguity never manufactures a new miss."""
    mask = [False] * len(text)
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "'\"":
            j = i + 1
            while j < n and text[j] != ch:
                j += 2 if (ch == '"' and text[j] == "\\") else 1
            if j >= n:
                return mask
            for k in range(i, j + 1):
                mask[k] = True
            i = j + 1
            continue
        i += 1
    return mask


def heredoc_consumer(text, op_start, mask):
    """(is_shell, name) for the command owning this heredoc operator. A shell's body
    is CODE and gets re-scanned; every other consumer's body is DATA. `name` is the
    dequoted command name, read only by the agent_id read proof."""
    start = 0
    for i in range(op_start - 1, -1, -1):
        if not mask[i] and text[i] in ";&|\n()":
            start = i + 1
            break
    argv = command_argv(tokenize(text[start:op_start]))
    name = argv[0][1].rsplit("/", 1)[-1] if argv else ""
    return bool(argv) and not argv[0][2] and name in INTERP_SHELL, name


def split_heredocs(text):
    """(code text, [(consumer_is_shell, consumer name, body, delimiter quoted)]). A heredoc body consumed by a
    non-shell is DATA and leaves the scan entirely — without this, a progress
    note quoting a bypass would arm the machine and block itself. ANY parse
    ambiguity (unknown delimiter shape, unterminated body) returns the raw text
    unchanged, i.e. the pre-strip behaviour."""
    if "<<" not in text:
        return text, []
    mask = quote_mask(text)
    ops = []
    i = 0
    while True:
        i = text.find("<<", i)
        if i == -1:
            break
        if mask[i]:
            i += 2
            continue
        if text[i:i + 3] == "<<<":  # herestring — not a heredoc
            i += 3
            continue
        m = HEREDOC_OP_RE.match(text, i)
        if not m:
            return text, []
        ops.append((i, m.group(1) == "-", m.group(3), bool(m.group(2))))
        i = m.end()
    if not ops:
        return text, []
    lines = text.split("\n")
    op_line = {}
    pos = 0
    for num, line in enumerate(lines):
        for op in ops:
            if pos <= op[0] < pos + len(line) + 1:
                op_line.setdefault(num, []).append(op)
        pos += len(line) + 1
    kept = []
    bodies = []
    num = 0
    while num < len(lines):
        kept.append(lines[num])
        pending = op_line.get(num, [])
        num += 1
        for op in pending:
            body = []
            closed = False
            while num < len(lines):
                line = lines[num]
                num += 1
                if (line.lstrip("\t") if op[1] else line) == op[2]:
                    closed = True
                    break
                body.append(line)
            if not closed:
                return text, []
            bodies.append(heredoc_consumer(text, op[0], mask) + ("\n".join(body), op[3]))
    return "\n".join(kept), bodies


def tokenize(seg):
    """[(kind, value, quoted, start, end)] over one separator-free segment;
    kind is word | redir | redirin. `value` is quote-stripped so a path spelled
    "..." compares like a bare one, while `quoted` keeps the command-position
    anchor honest (a quoted verb is an argument, never a command)."""
    toks = []
    i = 0
    n = len(seg)
    while i < n:
        ch = seg[i]
        if ch in " \t":
            i += 1
            continue
        if ch == ">":
            # Two-char redirect OPERATORS: >> append, >| clobber, >& fd-or-file.
            j = i + 2 if seg[i:i + 2] in (">>", ">|", ">&") else i + 1
            # A lone fd digit glued to the operator is part of the redirect.
            if toks and toks[-1][0] == "word" and toks[-1][4] == i and toks[-1][1].isdigit():
                toks.pop()
            toks.append(("redir", seg[i:j], False, i, j))
            i = j
            continue
        if ch == "<":
            j = i
            while j < n and seg[j] == "<":
                j += 1
            toks.append(("redirin", seg[i:j], False, i, j))
            i = j
            continue
        start = i
        buf = []
        quoted = False
        while i < n and seg[i] not in " \t><":
            ch = seg[i]
            if ch == "\\" and i + 1 < n:
                buf.append(seg[i + 1])
                i += 2
                continue
            if ch in "'\"":
                quoted = True
                i += 1
                while i < n and seg[i] != ch:
                    if ch == '"' and seg[i] == "\\" and i + 1 < n:
                        buf.append(seg[i + 1])
                        i += 2
                        continue
                    buf.append(seg[i])
                    i += 1
                i += 1
                continue
            buf.append(ch)
            i += 1
        toks.append(("word", "".join(buf), quoted, start, i))
    return toks


def command_argv(toks):
    """Word tokens up to the first redirect, with the neutral prefix chain
    (VAR=value, sudo/env/command/nohup/time/exec, each optionally
    path-qualified) consumed — so `/usr/bin/env python3 -c` reads as python3."""
    argv = []
    for tok in toks:
        if tok[0] != "word":
            break
        argv.append(tok)
    i = 0
    while i < len(argv):
        val = argv[i][1]
        if argv[i][2]:
            break
        if ASSIGN_RE.match(val) or val.rsplit("/", 1)[-1] in NEUTRAL_PREFIX:
            i += 1
            continue
        break
    return argv[i:]


def is_protected(value):
    """A protected path in either spelling — PROT_RE's file form (trailing
    slash or a plist label) or PROT_DIR_RE's bare-directory form. A copy target
    is conventionally written WITHOUT a trailing slash (`cp x <prot>/hooks`),
    which PROT_RE alone never matches."""
    return bool(PROT_RE.search(value) or PROT_DIR_RE.search(value))


def is_relative(value):
    """A write target resolved against the CURRENT directory. `&1` (fd dup) and
    a flag-looking token are excluded — neither names a path."""
    return bool(value) and not value.startswith(("/", "~", "$", "&", "-"))


def is_inplace_flag(value):
    """Short (`-i`, `-i.bak`, `-pi`) or long (`--in-place=.bak`) in-place flag."""
    return bool(INPLACE_FLAG_RE.match(value) or LONG_INPLACE_FLAG_RE.match(value))


def trailing_arg(argv):
    """Last non-flag argument — the write target of a mutation verb."""
    for tok in reversed(argv[1:]):
        if tok[1] and not tok[1].startswith("-"):
            return tok[1]
    return ""


def leading_flag_run(argv):
    """(flag tokens, code string) for the interpreter's CONTIGUOUS leading flag
    run. The code string is the first non-flag token after the run, or the
    inline value of a --eval=/--print= flag; no code flag in the run → None."""
    flags = []
    inline = None
    found = False
    i = 1
    while i < len(argv):
        val = argv[i][1]
        if argv[i][2] or not val.startswith("-") or val == "-":
            break
        if val == "--":
            i += 1
            break
        m = LONG_CODE_FLAG_RE.match(val)
        if m:
            found = True
            if m.group(1) is not None:
                inline = m.group(1)
        elif CODE_FLAG_RE.match(val):
            found = True
        flags.append(val)
        i += 1
    if not found:
        return flags, None
    if inline is not None:
        return flags, inline
    return flags, argv[i][1] if i < len(argv) else None


def awk_program(argv):
    """Inline awk program text — the first non-flag argument. `-f progfile`
    carries no inline program, so there is nothing to scan."""
    i = 1
    while i < len(argv):
        val = argv[i][1]
        if argv[i][2] or not val.startswith("-") or val == "-":
            break
        if val == "--":
            i += 1
            break
        if val.startswith("-f"):
            return None
        i += 2 if val in ("-v", "-F") else 1
    return argv[i][1] if i < len(argv) else None


def call_args(text, lparen):
    """Top-level comma-split argument texts of the call whose '(' sits at
    `lparen`. Nested calls, brackets and quoted commas stay inside their own
    argument, so an argument INDEX means what it says. An unbalanced tail
    returns what was collected — best effort, never an exception."""
    args = []
    buf = []
    depth = 0
    quote = ""
    i = lparen
    n = len(text)
    while i < n:
        ch = text[i]
        if quote:
            buf.append(ch)
            i += 1
            if ch == "\\" and i < n:
                buf.append(text[i])
                i += 1
            elif ch == quote:
                quote = ""
            continue
        if ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch in "([{":
            depth += 1
            if depth > 1:
                buf.append(ch)
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                args.append("".join(buf))
                return args
            buf.append(ch)
        elif ch == "," and depth == 1:
            args.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    args.append("".join(buf))
    return args


def quoted_literals(text, literal_re=QUOTED_RE):
    """String literals inside one argument text — the only spelling of a target
    this machine can read (a variable target is the indirection residual)."""
    out = []
    for m in literal_re.finditer(text):
        for group in m.groups():
            if group is not None:
                out.append(group)
                break
    return out


def pick_args(args, positions):
    """Arguments at the rule's WRITE positions. A rule's position spec is ALWAYS
    a TUPLE — membership, not equality, is what reads the list-taking sentinels,
    so the table spelling and this reader cannot drift into a silent mismatch."""
    if ALL_ARGS in positions:
        return args
    if TAIL_ARGS in positions:
        return args[1:]
    return [args[i] for i in positions if i < len(args)]


def rules_scan(code, rules, literal_re=QUOTED_RE):
    """(a write API fired, [literals at its WRITE positions]) over a rule table."""
    fired = False
    targets = []
    for api_re, positions, mode_re in rules:
        for m in api_re.finditer(code):
            args = call_args(code, m.end() - 1)
            if mode_re is not None and not (len(args) > 1 and mode_re.search(args[1])):
                continue
            fired = True
            for arg in pick_args(args, positions):
                targets.extend(quoted_literals(arg, literal_re))
    return fired, targets


def write_scan(name, code):
    """(a write API fired, [WRITE-POSITION target literals]), dispatched by
    language — a cross-language union would import each language's false
    positives into every other one. The two halves answer different questions:
    `fired` alone drives the ARMED over-approximation (the target is relative
    and unnameable from the code text), while the targets are what a protected
    literal is matched against, so a protected path in a READ position passes."""
    if PYTHON_NAME_RE.match(name):
        fired, targets = rules_scan(code, PY_WRITE_RULES)
        for m in PY_RECEIVER_RE.finditer(code):
            fired = True
            targets.append(m.group("t"))
        for m in PY_RECEIVER_OPEN_RE.finditer(code):
            if not PY_MODE_ARG_RE.match(m.group("a").split(",")[0]):
                continue
            fired = True
            targets.append(m.group("t"))
        if PY_INPLACE_RE.search(code):
            fired = True
            targets.extend(quoted_literals(code))
        return fired, targets
    if name in INTERP_NODE:
        return rules_scan(code, NODE_WRITE_RULES, NODE_QUOTED_RE)
    if name == "perl":
        fired = False
        targets = []
        for open_re in (PERL_OPEN3_RE, PERL_OPEN2_RE):
            for m in open_re.finditer(code):
                fired = True
                targets.append(m.group("t"))
        for m in PERL_VERB_RE.finditer(code):
            fired = True
            targets.extend(quoted_literals(m.group("t")))
        return fired, targets
    return rules_scan(code, RUBY_WRITE_RULES)


def scan_escapes(code, backticks, depth, armed):
    """Shell escape hatches carry shell text — re-scan it instead of
    enumerating a second write-API set per language."""
    for m in ESCAPE_RE.finditer(code):
        reason = scan_command(m.group(2), depth + 1, armed)
        if reason:
            return reason
    if backticks:
        for m in BACKTICK_RE.finditer(code):
            reason = scan_command(m.group(1), depth + 1, armed)
            if reason:
                return reason
    return ""


def scan_interpreter(name, argv, seg, depth, armed):
    """Arm A — a write expressed as a call inside a code-string argument, a
    shape neither the redirect nor the verb recogniser can present."""
    if name in INTERP_SHELL:
        code = leading_flag_run(argv)[1]
        return scan_command(code, depth + 1, armed) if code else ""
    if name in INTERP_AWK:
        prog = awk_program(argv)
        if not prog:
            return ""
        for m in AWK_REDIR_RE.finditer(prog):
            target = m.group(1) or m.group(2) or m.group(3) or ""
            if is_protected(normalize_path(target)):
                return "bash-interp-write"
            # A BARE target is an awk comparison far more often than a redirect
            # ('$1 > 5'), so the armed-relative case needs a quoted filename.
            if armed and m.group(3) is None and is_relative(target):
                return "bash-interp-write"
        return scan_escapes(prog, False, depth, armed)
    if not (PYTHON_NAME_RE.match(name) or name in INTERP_NODE or name in ("perl", "ruby")):
        return ""
    flags, code = leading_flag_run(argv)
    if name in ("perl", "ruby") and is_protected(seg) \
            and any(is_inplace_flag(f) for f in flags):
        return "bash-interp-write"
    if not code:
        return ""
    fired, targets = write_scan(name, code)
    # Armed: the cwd is already a protected dir, so a target spelled relatively
    # inside the code string cannot be named from the text — write intent alone
    # blocks (a deliberate over-approximation, bounded by the explicit cd).
    if armed and fired:
        return "bash-interp-write"
    # Unarmed: a protected literal blocks ONLY in a WRITE position. The same
    # literal read — copied FROM, opened for reading, passed to readFileSync —
    # writes somewhere else entirely and passes.
    if any(is_protected(normalize_path(target)) for target in targets):
        return "bash-interp-write"
    return scan_escapes(code, name in ("perl", "ruby"), depth, armed)


def unknown_dir_armed(armed):
    """`cd -` lands in the PREVIOUS directory, which this text machine cannot
    name. Over-approximate in the safe direction: once any protected dir was
    entered in this command, `cd -` may return to it → re-arm (disarming there
    is the one-line bypass `cd <prot> && cd /tmp && cd - && printf x > f`).
    With nothing protected in the history the destination is unprotected as far
    as this command shows, so the current state simply carries."""
    return True if PROT_CD_SEEN[0] else armed


def next_armed(name, argv, armed):
    """Arm B state transition. A protected-dir argument ARMS; any other
    absolute/~/$-rooted argument DISARMS; a relative one KEEPS the state —
    `cd ..` must stay armed, else it is a one-line bypass. Every unnameable
    destination shares one treatment: `cd -`, a stack ROTATION (`pushd +1`) and
    a bare `pushd` (which swaps the top two stack entries rather than going
    HOME, unlike a bare `cd`) all land where the text cannot say, so they take
    the conservative return. Only a bare `cd` names a destination — HOME."""
    raw = [tok[1] for tok in argv[1:] if tok[1]]
    if "-" in raw or any(ROTATE_ARG_RE.match(val) for val in raw):
        return unknown_dir_armed(armed)
    args = [val for val in raw if not val.startswith("-")]
    if not args:
        return unknown_dir_armed(armed) if name == "pushd" else False
    # The PROTECTED test resolves the destination — an intermediate segment plus a
    # backtrack (`cd <prot>/wiki/../hooks`) is a spelling no pattern can collapse.
    # The disarm test below deliberately keeps reading the RAW token: it keys on the
    # leading character, which the normaliser preserves in every shape it produces.
    if PROT_DIR_RE.search(normalize_path(args[0])):
        PROT_CD_SEEN[0] = True
        return True
    if args[0].startswith(("/", "~", "$")):
        return False
    return armed


def scan_dd(argv, armed):
    """dd names its target in an `of=` operand, never a trailing argument — and
    `if=` is the READ source, so the segment-wide match the other verbs use
    would block `dd if=<prot> of=/tmp/backup`."""
    for tok in argv[1:]:
        if not tok[1].startswith("of="):
            continue
        target = tok[1][3:]
        if is_protected(normalize_path(target)):
            return "bash-mutation", armed
        if armed and is_relative(target):
            return "bash-cwd-relative-write", armed
    return "", armed


# Verbs whose LAST non-flag operand is the write target, so an earlier operand is a
# READ source. tee/truncate/chmod/sed(-i) are excluded because every file operand is
# a target; ln because operand roles are order- and flag-dependent (`ln -s TARGET
# LINK`, the one-operand form, `-t DIR`); dd because scan_dd is already position-
# precise. Per-verb NO-OPERAND short-cluster allowlists: every operand-taking or
# destination-naming flag (-t/--target-directory, install -m/-o/-g/-d/-t, rsync
# -e/-f/-T/-B/-M/--files-from=/--link-dest=) either names a WRITE destination or
# consumes the following token, and both break the last-operand-is-target model. `d`
# is omitted from the install cluster on purpose: `install -d` makes every operand a
# directory to CREATE. Any long form (a token opening `--`) fails these patterns and
# so resolves to bash-mutation.
SOURCE_POS_FLAG_RE = {
    "cp": re.compile(r"^-[afinpRrvLHPX]+$"),
    "mv": re.compile(r"^-[finv]+$"),
    "install": re.compile(r"^-[pbvc]+$"),
    "rsync": re.compile(r"^-[avzrltpogHAXnPu]+$"),
}
# Unexpanded expansion / glob / brace / remote spec — a token carrying one of these
# could expand onto a protected target, so its role is undecidable.
UNRESOLVABLE_CHARS = "$`*?[{:"


def is_source_position(name, argv):
    """True when the segment-wide protected match is explained ENTIRELY by a protected
    path in SOURCE position. Evaluated ONLY where the segment ALREADY blocks, and both
    outcomes return a block reason — this is a pure RE-LABELLING that can create
    neither a new block nor a new pass. TOTAL by construction: an unlisted verb, an
    unlisted flag, an unresolvable token, a protected destination, an unexplained
    match, a protected leftover, and any exception all resolve False → bash-mutation,
    never a pass."""
    try:
        flag_re = SOURCE_POS_FLAG_RE.get(name)
        if flag_re is None:
            return False
        ops = []
        for tok in argv[1:]:
            val = tok[1]
            if any(ch in val for ch in UNRESOLVABLE_CHARS):
                return False
            if val.startswith("-"):
                if not flag_re.match(val):
                    return False
                continue
            ops.append(val)
        # An implicit or absent destination leaves nothing to compare against.
        if len(ops) < 2:
            return False
        dest = ops[-1]
        if is_protected(dest) or is_protected(normalize_path(dest)):
            return False
        sources = ops[:-1]
        # Soundness: if no individual source operand explains the segment-wide match,
        # the match came from text the token model does not account for.
        if not any(is_protected(t) or is_protected(normalize_path(t)) for t in sources):
            return False
        for tok in argv[1:]:
            val = tok[1]
            if val in sources:
                continue
            if is_protected(val) or is_protected(normalize_path(val)):
                return False
        return True
    except Exception:  # noqa: BLE001 — total by contract; ambiguity is bash-mutation
        return False


# agent_id read proof (subagent and Workflow Bash calls): a positive rule. A word naming a path
# under a home profile root adds no block only as a proven read; every other such word becomes a
# (literal flag, as written, as resolved) triple the shell judges with the lib's exemption predicate.
# It runs beside the arms above and never changes their verdict, so it can only add blocks.
_HOME = os.environ.get("HOME", "").rstrip("/")
# HOME and its physical spelling: a home reached through a link realpaths elsewhere.
HOMES = tuple(dict.fromkeys(h for h in (_HOME, os.path.realpath(_HOME) if _HOME else "") if h))
FIRMLINK = "/system/volumes/data"
# Positive set: the Bash tool runs zsh, so a list of bash specials would miss zsh expansions.
LITERAL_RE = re.compile(r"^[A-Za-z0-9._/+,@%-]*$")
TILDE_RE = re.compile(r"~[A-Za-z0-9._-]*")
VAR_HOME_RE = re.compile(r"(?:\$HOME|\$\{HOME\})(?=/|$)")
ROOT_SEG_RE = re.compile(r"^" + CLAUDE_ROOT + r"$", re.IGNORECASE)
# A visible home spelling anywhere in code text (a code-flag string, an interpreter heredoc body).
CODE_HOME_RE = re.compile(
    r"(?:(?<![\w~$])~[A-Za-z0-9._-]*|\$\{?HOME\}?(?![A-Za-z0-9_])"
    + "".join("|(?i:" + re.escape(h) + ")" for h in HOMES)
    + r")[^\s'\"\x60;|&()<>,\[\]{}]*"
)
# A variable reference anywhere in code text, with the path tail glued to it.
CODE_VAR_RE = re.compile(r"\$(?:\{[^}\s]*\}|[A-Za-z_]\w*)[^\s'\"\x60;|&()<>,\[\]{}]*")
# A directory this text cannot name, entered after an in-scope one: every later word is unprovable.
UNKNOWN_DIR = "\x00unknown"
CLEAN_RESERVED = ("do", "then", "else", "elif", "{", "!", "while", "until", "if")
# Words that rebind a command name for the rest of the call — any one voids every reader position.
REBIND_CMDS = (
    ".", "source", "eval", "autoload", "zmodload", "emulate", "alias", "unalias", "hash", "unhash",
    "enable", "disable", "function", "functions", "setopt", "unsetopt", "trap",
)
REBIND_NAME_RE = re.compile(
    r"^(?:PATH|path|functions|commands|aliases|galiases|saliases|builtins|reswords|dis_\w+"
    r"|fpath|FPATH|BASH_ENV|ENV|ZDOTDIR)(?:\[[^\]]*\])?\+?="
)
ASSIGN_WORD_RE = re.compile(r"^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=")
DECLARE_CMDS = ("typeset", "declare", "export", "local", "readonly", "integer", "float")
# A reference whose value is the bound value itself: `$X`, `${X}`, `${X:?msg}`.
VAR_REF_RE = re.compile(r"\$(?:\{([A-Za-z_]\w*)(?::?\?[^}]*)?\}|([A-Za-z_]\w*))")
# Every reference, an operator form (`${X%/*}`, `${X:-y}`, `${#X}`) included.
VAR_USE_RE = re.compile(r"\$(?:\{(?:\([^)]*\))?[#=~^+!]*)?([A-Za-z_]\w*)")
# An indirect reference (bash `${!X}`, zsh `${(P)X}`): its value is another variable's.
INDIRECT_RE = re.compile(r"\$\{(?:!|\([^)]*P)")
ASSIGN_TAIL_RE = re.compile(r"(?:\[[^\]]*\])?\+?=")
REF_TAIL_RE = re.compile(r"(?::?\?[^}]*)?\}")
FOR_NAMES_RE = re.compile(
    r"(?:^|[\s;&|(){}])(?:for|select|foreach)\s+((?:[A-Za-z_]\w*\s+)*?[A-Za-z_]\w*)\s+in(?=\s|$)")
ALLEXPORT_RE = re.compile(r"\bset\s+[-+]\w*a|all_?export", re.IGNORECASE)
# Names the home-spelling and cwd rules own: never expanded from a binding.
NO_EXPAND = ("HOME", "PWD", "OLDPWD")
MAX_SPELLINGS = 64
PREFIX_WORDS = NEUTRAL_PREFIX + ("builtin", "noglob", "nocorrect", "-", "coproc", "nice", "repeat")
FUNC_DEF_RE = re.compile(r"\(\s*\)|(?:^|[\s;&|{}()])function(?=[\s{]|$)")
# Readers: command → (allowed option words, operand admission). ANY_OPTION only for a member with no
# option that writes a file or runs a command; the rest name a closed list, and an option outside
# it voids the reader position. Admission: every operand, only the first (uniq's second operand is
# its output file), a `[[ ]]` test with nothing after its close, or sed with a line-print script.
ANY_OPTION = re.compile(r"^-")
READERS = {name: (ANY_OPTION, "all") for name in (
    "cat", "ls", "grep", "egrep", "fgrep", "head", "tail", "wc", "stat", "readlink", "realpath",
    "du", "test", "[", "cmp", "diff", "cd", "pushd", "popd", "jq", "shasum", "md5", "basename",
    "dirname",
    # No operand is a file: what these print reaches a file only through a redirect, judged apart.
    "echo", "printf", "print",
)}
READERS["[["] = (ANY_OPTION, "test")
READERS["find"] = (re.compile(
    r"^-(?:i?name|type|i?path|i?wholename|maxdepth|mindepth|newer|[amc](?:time|min)|size|perm"
    r"|print0?|ls|prune|o|a|or|and|not|empty|user|group|uid|gid|nouser|nogroup|i?regex|depth"
    r"|xdev|mount|samefile|links|inum|i?lname|readable|writable|executable|true|false|follow"
    r"|quit|[LHPEXxsdf]|\d+[A-Za-z]?)$"), "all")
READERS["sort"] = (re.compile(r"^-(?:[bcCdfghiMmnRrsuVz]+|[kt].*)$"), "all")
READERS["uniq"] = (re.compile(r"^-[cdiuDfs0-9]+$"), "first")
READERS["sed"] = (re.compile(r"^-[nEr]+$"), "sed")
# The one sed script shape admitted as a read: a line or regex address range, then `p`.
SED_PRINT_RE = re.compile(r"^(?:(?:\d+|\$)(?:,(?:\d+|\$))?|/[^/\\]*/(?:,/[^/\\]*/)?)?p$")
# A path-qualified command word counts only from a system bin dir, never a planted copy.
READER_DIRS = ("/bin/", "/usr/bin/", "/sbin/", "/usr/sbin/")

# Commands that turn their input into another command's arguments: present anywhere in a call,
# they void every reader position in it.
ARGV_CONSUMERS = ("xargs", "parallel", "read", "mapfile", "readarray", "vared")
# Stdin filters beside READERS: what they read on stdin stays data, never argv or code.
PIPE_FILTERS = (
    "cut", "tr", "tee", "column", "nl", "rev", "fold", "paste", "tac", "base64", "od", "hexdump",
    "xxd", "less", "more", "sed", "fmt", "expand", "unexpand", "strings", "comm", "join",
)

AGENT = {"on": False, "triples": [], "keys": set(), "reads": [], "void": False,
         "cwd": None, "seen": False, "piped": False, "vars": {}, "opaque": set(), "known": {},
         "text": "", "array": None, "for_starts": None, "allexport": False, "cwds": [],
         "codes": []}


def agent_reset(text, carried):
    """Fresh walk state; carried = (bindings, opaque names) from the binding pass."""
    AGENT.update(triples=[], keys=set(), reads=[], void=False, cwd=None, seen=False, piped=False,
                 vars=carried[0], opaque=carried[1], known={}, text=text, array=None,
                 for_starts=None, allexport=bool(ALLEXPORT_RE.search(text)), cwds=[], codes=[])


def agent_emit(flag, written, resolved):
    key = (flag, written, resolved)
    if key not in AGENT["keys"]:
        AGENT["keys"].add(key)
        AGENT["triples"].append(key)


def home_split(word):
    """(remainder after a leading visible home spelling, literal flag), else None. The literal test
    reads the remainder of a `~` / `$HOME` word — the resolved form expands those itself — and the
    whole word for the literal home (case-folded, firmlink-prefixed or not, lexically collapsed)."""
    if not HOMES:
        return None
    m = TILDE_RE.match(word) or VAR_HOME_RE.match(word)
    if m:
        rest = word[m.end():]
        if rest and not rest.startswith("/"):
            rest = "/" + rest
        return rest, bool(LITERAL_RE.match(rest))
    if not word.startswith("/"):
        return None
    path = word[len(FIRMLINK):] if word.lower().startswith(FIRMLINK + "/") else word
    norm = normalize_path(path)
    for home in HOMES:
        if norm.lower() == home.lower() or norm.lower().startswith(home.lower() + "/"):
            return norm[len(home):], bool(LITERAL_RE.match(word))
    return None


def scope_segment(rest):
    """First segment below home of a home-relative remainder, after a lexical collapse."""
    norm = normalize_path(_HOME + rest)
    if not norm.startswith(_HOME + "/"):
        return ""
    return norm[len(_HOME) + 1:].split("/")[0]


def is_scope_candidate(path):
    """An absolute path whose first segment below either home spelling is a profile root."""
    if not path.startswith("/"):
        return False
    if path.lower().startswith(FIRMLINK + "/"):
        path = path[len(FIRMLINK):]
    norm = normalize_path(path).lower()
    for home in HOMES:
        if norm.startswith(home.lower() + "/") \
                and ROOT_SEG_RE.match(norm[len(home) + 1:].split("/")[0]):
            return True
    return False


def agent_literal(path):
    """Emit a literal absolute path when it, or its non-strict realpath, may sit under a root."""
    resolved = os.path.realpath(path)
    if is_scope_candidate(path) or is_scope_candidate(resolved):
        agent_emit("L", path, resolved)


def agent_nonliteral(word):
    """Emit a word as unprovable when its home-relative first segment is a root or non-literal."""
    split = home_split(word)
    if split is None:
        return False
    seg = scope_segment(split[0])
    if seg and (not LITERAL_RE.match(seg) or ROOT_SEG_RE.match(seg)):
        agent_emit("N", word, "")
    return True


def agent_judge(word, cwd):
    """Judge a non-read word in every spelling its references take; a name the call may set another
    way keeps the word's own judgment, an operator form of a relevant name is unprovable."""
    names = VAR_USE_RE.findall(word) if "$" in word else []
    if not names:
        judge_word(word, cwd)
        return
    spellings = var_spellings(word, 0)
    operators = list(AGENT["vars"]) if INDIRECT_RE.search(word) else operator_names(word)
    # Too many spellings (a self-referencing accumulator) is unprovable only where a value may be.
    if any(is_relevant_name(n, cwd) for n in (names if spellings is None else operators)):
        agent_emit("N", word, "")
        return
    if spellings is None:
        judge_word(word, cwd)
        return
    for spelling in spellings:
        judge_word(spelling, cwd)
    if not all(is_known(n) for n in names):
        judge_word(word, cwd)


def var_spellings(word, depth):
    """Every spelling of a word once each plain reference takes one of its values; None past
    MAX_SPELLINGS or when a nested value has too many."""
    spellings = [word]
    for m in reversed(list(VAR_REF_RE.finditer(word))):
        name = m.group(1) or m.group(2)
        if name in NO_EXPAND:
            continue
        values = var_values(name, depth)
        if values is None:
            return None
        spellings = [s[:m.start()] + v + s[m.end():] for s in spellings for v in values]
        if len(spellings) > MAX_SPELLINGS:
            return None
    return spellings


def var_values(name, depth):
    """A name's possible values: every binding in the call, the inherited value, and empty."""
    values = ["", os.environ.get(name, "")]
    for value in AGENT["vars"].get(name, ()):
        nested = var_spellings(value, depth + 1) if "$" in value and depth < 3 else [value]
        if nested is None:
            return None
        values.extend(nested)
    return list(dict.fromkeys(values))


def operator_names(word):
    simple = {m.start() for m in VAR_REF_RE.finditer(word)}
    return [m.group(1) for m in VAR_USE_RE.finditer(word) if m.start() not in simple]


def is_relevant_name(name, cwd, depth=0):
    """A name with a value that may name a profile path: home-spelled, an absolute scope
    candidate, relative to an in-scope or unknown directory, or holding such a name."""
    in_scope_cwd = is_scope_dir(cwd)
    for value in list(AGENT["vars"].get(name, ())) + ["", os.environ.get(name, "")]:
        if home_split(value) is not None or is_scope_candidate(value) \
                or (in_scope_cwd and not value.startswith("/")):
            return True
        if depth < 3 and any(is_relevant_name(n, cwd, depth + 1)
                             for n in VAR_USE_RE.findall(value) if n != name):
            return True
    return False


def is_scope_dir(cwd):
    """A cwd, or any of a tuple of them, that is unknown or names a path under a profile root."""
    dirs = cwd if isinstance(cwd, tuple) else (cwd,)
    return any(d == UNKNOWN_DIR or (d and is_scope_candidate(d)) for d in dirs)


def is_known(name):
    """A name bound in the call whose every occurrence is a plain or guarded reference, an
    assignment, or a for-list name — so its bindings, inherited value and empty are all it holds."""
    if name not in AGENT["known"]:
        occurrences = re.finditer(r"(?<![\w./-])" + re.escape(name) + r"(?!\w)", AGENT["text"])
        AGENT["known"][name] = name in AGENT["vars"] and name not in AGENT["opaque"] \
            and all(is_binding_occurrence(m.start(), m.end()) for m in occurrences)
    return AGENT["known"][name]


def is_binding_occurrence(i, j):
    text = AGENT["text"]
    if text[i - 1:i] == "$" or (text[i - 2:i] == "${" and REF_TAIL_RE.match(text, j)):
        return True
    return bool(ASSIGN_TAIL_RE.match(text, j)) or i in for_name_starts()


def for_name_starts():
    if AGENT["for_starts"] is None:
        AGENT["for_starts"] = {m.start(1) + k.start() for m in FOR_NAMES_RE.finditer(AGENT["text"])
                               for k in re.finditer(r"\w+", m.group(1))}
    return AGENT["for_starts"]


def judge_word(word, cwd):
    """Route one non-read spelling: home-spelled, literal absolute, or relative to each cwd."""
    if isinstance(cwd, tuple):
        for each in cwd:
            judge_word(word, each)
        return
    split = home_split(word)
    if split is not None:
        if not split[1]:
            agent_nonliteral(word)
        else:
            agent_literal(word if word.startswith("/") else _HOME + split[0])
        return
    if not word or word.startswith("-"):
        return
    if word.startswith("/"):
        if LITERAL_RE.match(word):
            agent_literal(word)
        return
    judge_relative(word, cwd)


def judge_relative(word, cwd):
    if cwd == UNKNOWN_DIR:
        agent_emit("N", word, "")
    elif cwd is not None:
        if LITERAL_RE.match(word):
            agent_literal(cwd + "/" + word)
        elif is_scope_candidate(cwd) or is_scope_candidate(os.path.realpath(cwd)):
            agent_emit("N", word, "")


def agent_code_search(code, cwd=None):
    """Each visible home spelling and each variable spelling inside code text is a non-read word;
    run from an in-scope directory, so is each path-shaped or variable-bearing string literal."""
    code = code or ""
    for m in CODE_HOME_RE.finditer(code):
        agent_judge(m.group(0), None)
    for m in CODE_VAR_RE.finditer(code):
        agent_judge(m.group(0), None)
    if not is_scope_dir(cwd):
        return
    for literal in quoted_literals(code):
        if "$" in literal or (LITERAL_RE.match(literal) and literal[:1] not in ("", "/")):
            agent_judge(literal, cwd)


def agent_cd(name, args, cwd):
    """The directory, or the tuple of directories, after a cd / pushd / popd: home spelling and
    variables expanded, `..` kept (the exemption voids it). An unnameable one is unknown only
    after an in-scope cd, else out of scope."""
    if isinstance(cwd, tuple):
        return merge_dirs([agent_cd(name, args, each) for each in cwd])
    unnameable = UNKNOWN_DIR if AGENT["seen"] else None
    if name == "popd" or "-" in args or any(ROTATE_ARG_RE.match(a) for a in args):
        return unnameable
    paths = [a for a in args if a and not a.startswith("-")]
    if not paths:
        return unnameable if name == "pushd" else _HOME
    spellings = cd_spellings(paths[0])
    new = UNKNOWN_DIR if spellings is None \
        else merge_dirs([cd_dir(dest, cwd, unnameable) for dest in spellings])
    for each in new if isinstance(new, tuple) else (new,):
        mark_cd_seen(each)
    return new


def cd_spellings(dest):
    """A cd operand's spellings: its variable expansions (an empty one leaves the cwd or goes
    home), plus the word itself while a name it uses may be set another way."""
    names = VAR_USE_RE.findall(dest) if "$" in dest and home_split(dest) is None else []
    if not names:
        return [dest]
    if operator_names(dest):
        return None
    spellings = var_spellings(dest, 0)
    if spellings is not None and not all(is_known(n) for n in names):
        spellings.append(dest)
    return spellings


def cd_dir(dest, cwd, unnameable):
    if not dest:
        return merge_dirs([cwd, _HOME])
    split = home_split(dest)
    if split is not None:
        return (dest if dest.startswith("/") else _HOME + split[0]) if split[1] else UNKNOWN_DIR
    if dest.startswith("/") or cwd not in (None, UNKNOWN_DIR):
        joined = dest if dest.startswith("/") else cwd + "/" + dest
        return joined if LITERAL_RE.match(dest) else unnameable
    return cwd


def merge_dirs(dirs):
    """One directory, or a tuple of the distinct ones; any unknown one, or too many, is unknown."""
    flat = []
    for each in dirs:
        flat.extend(each if isinstance(each, tuple) else (each,))
    flat = list(dict.fromkeys(flat))
    if UNKNOWN_DIR in flat or len(flat) > MAX_SPELLINGS:
        return UNKNOWN_DIR
    return flat[0] if len(flat) == 1 else tuple(flat)


def mark_cd_seen(new):
    if new == UNKNOWN_DIR or (new and (is_scope_candidate(new)
                                        or is_scope_candidate(os.path.realpath(new)))):
        AGENT["seen"] = True


def effective_command(plain):
    """(index, name) of the command a segment runs once assignments and prefix words are passed."""
    i = 0
    in_prefix = False
    while i < len(plain):
        val = plain[i][1]
        if ASSIGN_WORD_RE.match(val) or val in CLEAN_RESERVED:
            i += 1
            continue
        if val.rsplit("/", 1)[-1] in PREFIX_WORDS:
            in_prefix = True
            i += 1
            continue
        if in_prefix and (val.startswith("-") or val.isdigit()):
            i += 2 if val in ("-a", "-u", "-g", "-C") else 1
            continue
        return i, val.rsplit("/", 1)[-1]
    return i, ""


def agent_rebinds(plain):
    if any(REBIND_NAME_RE.match(tok[1]) for tok in plain):
        return True
    idx, name = effective_command(plain)
    if name in REBIND_CMDS:
        return True
    return name in DECLARE_CMDS and any(REBIND_NAME_RE.match(t[1]) for t in plain[idx + 1:])


def reader_name(value):
    if "/" not in value:
        return value
    return value.rsplit("/", 1)[-1] if value.startswith(READER_DIRS) else ""


def agent_redirects(toks, cwd):
    """(plain word tokens, here-string words, reader void). Every redirect target is a non-read;
    a `<` source is a read. A target that is not a path-shaped word voids the segment's reader
    positions."""
    plain, herestrings, void = [], [], False
    i = 0
    while i < len(toks):
        tok = toks[i]
        if tok[0] == "word":
            plain.append(tok)
            i += 1
            continue
        nxt, i = redirect_target(toks, i)
        if nxt is None or nxt[0] != "word" or not nxt[1] or nxt[1][:1] in ("!", "|", "&"):
            void = True
            i += 1
            continue
        redirect_judge(tok[1], nxt[1], herestrings, cwd)
        i += 2
    return plain, herestrings, void


def redirect_judge(op, target, herestrings, cwd):
    """A `<<<` word is code or data for the consumer; any other `<` source is a read; an output
    target is a non-read, a bare fd after `>&` excepted."""
    if op.startswith("<"):
        if op == "<<<":
            herestrings.append(target)
    elif not (op == ">&" and (target.isdigit() or target == "-")):
        agent_judge(target, cwd)


def redirect_target(toks, i):
    """(target token, operator index) for the redirect at toks[i]. A `!` or `|` glued right after
    a `>` operator is part of it (zsh `>!`, `>>|`), so the target is the word after that."""
    tok = toks[i]
    nxt = toks[i + 1] if i + 1 < len(toks) else None
    if tok[0] == "redir" and nxt and nxt[0] == "word" and not nxt[2] \
            and nxt[3] == tok[4] and nxt[1][:1] in ("!", "|"):
        if len(nxt[1]) > 1:
            return ("word", nxt[1][1:], False, nxt[3] + 1, nxt[4]), i
        i += 1
        nxt = toks[i + 1] if i + 1 < len(toks) else None
    return nxt, i


def is_code_interp(name):
    return bool(PYTHON_NAME_RE.match(name)) or name in INTERP_NODE \
        or name in INTERP_AWK or name in ("perl", "ruby")


def agent_interpreter(name, argv, herestrings, depth, armed, cwd):
    """An interpreter's script-file operand is a read; its code string — flag, here-string — is
    searched for home spellings (a shell's is re-scanned); every other operand is a non-read."""
    words = [t[1] for t in argv[1:]]
    if name in INTERP_AWK:
        code = awk_program(argv)
    else:
        code = leading_flag_run(argv)[1]
    for text in herestrings:
        if name in INTERP_SHELL:
            if scan_command(text, depth + 1, armed):
                agent_emit("N", text[:200], "")
        else:
            agent_code_search(text, cwd)
    if code is None:
        operands = [w for w in words if not w.startswith("-")]
        for w in operands[1:]:
            agent_judge(w, cwd)
        return
    if name in INTERP_SHELL:
        if scan_command(code, depth + 1, armed):
            agent_emit("N", code[:200], "")
    else:
        agent_code_search(code, cwd)
    rest = list(words)
    if code in rest:
        rest.remove(code)
    for w in rest:
        agent_judge(w, cwd)


def agent_segment(toks, depth, armed, glued):
    """Judge one segment for the agent_id read proof: a list binds its variable, a reader in a
    clean command position (behind CLEAN_RESERVED alone) reads, every other word is a non-read."""
    cwd = AGENT["cwd"]
    plain, herestrings, void = agent_redirects(toks, cwd)
    if glued and plain and agent_glued(plain[-1][1]):
        plain = plain[:-1]
    ci = clean_index(plain)
    if ci >= len(plain) or agent_list(plain[ci:]):
        return
    eff_idx, eff_name = effective_command(plain)
    agent_flow(plain, ci, eff_idx, eff_name)
    if eff_name in ("cd", "pushd", "popd"):
        AGENT["cwd"] = agent_cd(eff_name, [t[1] for t in plain[eff_idx + 1:]], cwd)
        new = AGENT["cwd"]
        AGENT["cwds"].extend(new if isinstance(new, tuple) else (new,))
    agent_dispatch(plain[ci:], plain[max(eff_idx, ci):], herestrings, void, (depth, armed), cwd)


def agent_glued(word):
    """A word glued to an unquoted `(`: an array assignment binds the elements up to its `)`, a
    substitution leaves its name opaque, any other word carries a zsh glob qualifier."""
    m = ASSIGN_WORD_RE.match(word)
    if m:
        name = re.match(r"\w+", word).group(0)
        AGENT["opaque"].add(name)
        if m.end() == len(word):
            AGENT["array"] = name
        return False
    return agent_nonliteral(word)


def agent_list(words):
    """Bind array elements, or a for / select list, to their names; a list word is no operand."""
    values = [t[1] for t in words]
    if AGENT["array"]:
        for value in values:
            agent_bind(AGENT["array"], value)
        return True
    if words[0][2] or values[0] not in ("for", "select", "foreach") or "in" not in values[2:]:
        return False
    k = values.index("in", 2)
    for name in values[1:k]:
        if REBIND_NAME_RE.match(name + "="):
            AGENT["void"] = True
        for value in values[k + 1:]:
            agent_bind(name, value)
    return True


def agent_bind(name, value):
    values = AGENT["vars"].setdefault(name, [])
    if value not in values:
        values.append(value)


def agent_dispatch(argv, eff_argv, herestrings, void, scan, cwd):
    """A reader reads from the clean position alone; eval and interpreters are found past
    assignments and prefix words, whose own words stay non-reads."""
    name = reader_name(argv[0][1])
    words = [t[1] for t in argv[1:]]
    reader = None if void else admitted_reader(name, words)
    eff_name = reader_name(eff_argv[0][1]) if eff_argv else ""
    if reader:
        agent_reads(reader, words, cwd)
        return
    if eff_name == "eval" or is_code_interp(eff_name) or eff_name in INTERP_SHELL:
        agent_nonreads(name, [t[1] for t in argv[1:len(argv) - len(eff_argv)]], cwd)
    if eff_name == "eval":
        agent_eval(eff_argv, scan, cwd)
    elif is_code_interp(eff_name) or eff_name in INTERP_SHELL:
        agent_interpreter(eff_name, eff_argv, herestrings, scan[0], scan[1], cwd)
    else:
        agent_nonreads(name, words, cwd)


def agent_eval(argv, scan, cwd):
    """eval re-parses its joined operands as shell code in this shell: re-scan them, and keep any
    directory the re-scan enters as a possible cwd afterwards."""
    words = [t[1] for t in argv[1:]]
    code = " ".join(words)
    entered = len(AGENT["cwds"])
    if scan_command(code, scan[0] + 1, scan[1]):
        agent_emit("N", code[:200], "")
    if len(AGENT["cwds"]) > entered:
        AGENT["cwd"] = merge_dirs([cwd] + AGENT["cwds"][entered:])
    agent_nonreads("eval", words, cwd)


def clean_index(plain):
    """Index of the first word past the leading CLEAN_RESERVED run."""
    ci = 0
    while ci < len(plain) and not plain[ci][2] and plain[ci][1] in CLEAN_RESERVED:
        ci += 1
    return ci


def agent_flow(plain, ci, eff_idx, eff_name):
    """Data flow out of a read and into a variable. A rebinding, an argv consumer (xargs, read)
    anywhere in the call, or a pipe into a segment that is not a stdin-safe consumer voids every
    reader position."""
    if agent_rebinds(plain) or eff_name in ARGV_CONSUMERS:
        AGENT["void"] = True
    if AGENT["piped"]:
        AGENT["piped"] = False
        if not is_pipe_safe(reader_name(plain[ci][1]), plain[ci:]):
            AGENT["void"] = True
    if eff_name in DECLARE_CMDS:
        flags = "".join(t[1] for t in plain[eff_idx + 1:] if t[1].startswith("-"))
        agent_assign(plain[eff_idx + 1:], eff_name == "export" or "x" in flags,
                     "nameref" if "n" in flags else "bind")
    agent_assign(plain[:eff_idx], bool(eff_name) and eff_name not in DECLARE_CMDS,
                 "prefix" if eff_name else "bind")


def agent_assign(toks, exported, mode):
    """Bind each assignment the shell keeps (`+=` appends, a nameref takes its target's values);
    judge each value a child sees: exported, allexport, an inherited name, a command prefix."""
    for tok in toks:
        m = ASSIGN_WORD_RE.match(tok[1])
        if not m:
            continue
        name, value = re.match(r"\w+", tok[1]).group(0), tok[1][m.end():]
        # A rebound HOME moves every later `~` and `$HOME` spelling off the home this text keys on.
        if name == "HOME" and mode != "prefix":
            agent_emit("N", tok[1], "")
        if mode == "bind":
            for base in (var_values(name, 0) or [""]) if tok[1][m.end() - 2] == "+" else ("",):
                agent_bind(name, base + value)
        else:
            AGENT["opaque"].add(name)
            if mode == "nameref" and re.fullmatch(r"[A-Za-z_]\w*", value):
                agent_bind(name, "${" + value + "}")
        if exported or AGENT["allexport"] or name in os.environ:
            agent_judge(value, AGENT["cwd"])


def is_pipe_safe(name, argv):
    """A pipe consumer whose stdin stays data: a reader-set or filter command, or an interpreter
    running its own code string (what that code does at run time is a named residual)."""
    if name in READERS or name in PIPE_FILTERS:
        return True
    if name in INTERP_AWK:
        return awk_program(argv) is not None
    return is_code_interp(name) and leading_flag_run(argv)[1] is not None


def admitted_reader(name, words):
    """The READERS entry for a command whose option words and script all stay inside its closed
    admission, else None."""
    reader = READERS.get(name)
    if reader and any(w.startswith("-") and w != "-" and not reader[0].match(w) for w in words):
        return None
    if reader and reader[1] == "test" and "]]" in words[:-1]:
        return None
    if reader and reader[1] == "sed":
        script = [w for w in words if not w.startswith("-")][:1]
        return reader if script and SED_PRINT_RE.match(script[0]) else None
    return reader


def agent_reads(reader, words, cwd):
    operands = [w for w in words if not (w.startswith("-") and w != "-")]
    # The sed script is no path, so it is neither read nor judged.
    reads, rest = {"first": (operands[:1], operands[1:]),
                   "sed": (operands[1:], [])}.get(reader[1], (operands, []))
    AGENT["reads"].extend((w, cwd) for w in reads)
    for w in rest:
        agent_judge(w, cwd)


def agent_nonreads(name, words, cwd):
    for w in words:
        split = home_split(w) if name == "ln" else None
        if split is not None and split[0] in ("", "/"):
            agent_emit("N", w, "")
        else:
            agent_judge(w, cwd)


def substitution_bodies(text, quoted_only):
    """Substitution bodies no segment cut reaches (`$(…)` in double quotes, any backtick outside
    single quotes); quoted_only False reads an unquoted-delimiter heredoc body, quotes literal."""
    bodies, i, single, double = [], 0, False, False
    while i < len(text):
        ch = text[i]
        if ch == "\\" and not single:
            i += 2
            continue
        if quoted_only and ch == "'" and not double:
            single = not single
        elif quoted_only and ch == '"' and not single:
            double = not double
        elif not single and (ch == "\x60" or (text.startswith("$(", i)
                                              and (double or not quoted_only))):
            body, i = substitution_body(text, i)
            bodies.append(body)
            continue
        i += 1
    return bodies


def substitution_body(text, i):
    """(body, index past it) of the backtick or `$(…)` substitution opening at text[i]; an
    unclosed one runs to the end."""
    if text[i] == "\x60":
        j = text.find("\x60", i + 1)
        j = len(text) if j == -1 else j
        return text[i + 1:j], j + 1
    level, j = 1, i + 2
    while j < len(text) and level:
        level += {"(": 1, ")": -1}.get(text[j], 0)
        j += 1
    return (text[i + 2:j - 1] if level == 0 else text[i + 2:]), j


def agent_extras(code, mask, heredocs, depth, armed):
    """Text a segment walk never judges: substitution bodies, a function definition anywhere in the
    unquoted text, and non-shell heredoc bodies (an interpreter's is code)."""
    bare = "".join(" " if mask[k] else c for k, c in enumerate(code))
    if FUNC_DEF_RE.search(bare):
        AGENT["void"] = True
    subs = substitution_bodies(code, True)
    for is_shell, name, body, quoted in heredocs:
        if is_shell:
            continue
        if not quoted:
            subs.extend(substitution_bodies(body, False))
        if is_code_interp(name) or name in INTERP_SHELL:
            agent_code_search(body)
            AGENT["codes"].append(body)
    for body in subs:
        if scan_command(body, depth + 1, armed):
            agent_emit("N", body[:200], "")


def scan_segment(seg, depth, armed, glued=False):
    """(block reason, armed after this segment) for ONE separator-free segment."""
    toks = tokenize(seg)
    if not toks:
        return "", armed
    if AGENT["on"]:
        agent_segment(toks, depth, armed, glued)
    for idx, tok in enumerate(toks):
        if tok[0] != "redir":
            continue
        target = toks[idx + 1] if idx + 1 < len(toks) else None
        if target is None or target[0] != "word" or not target[1]:
            continue
        # `>&` takes an fd as often as a file (`2>&1`); a bare fd names no path.
        if tok[1] == ">&" and (target[1].isdigit() or target[1] == "-"):
            continue
        if is_protected(normalize_path(target[1])):
            return "bash-mutation", armed
        if armed and is_relative(target[1]):
            return "bash-cwd-relative-write", armed
    argv = command_argv(toks)
    if not argv or argv[0][2]:
        return "", armed
    name = argv[0][1].rsplit("/", 1)[-1]
    if name in ("cd", "pushd"):
        return "", next_armed(name, argv, armed)
    if name == "popd":
        return "", unknown_dir_armed(armed)
    if name in MUTATION_VERBS:
        if name == "sed" and not any(is_inplace_flag(a[1]) for a in argv[1:]):
            return "", armed
        if name == "dd":
            return scan_dd(argv, armed)
        if is_protected(seg[argv[0][4]:]):
            if is_source_position(name, argv):
                return "bash-source-position", armed
            return "bash-mutation", armed
        if armed and is_relative(trailing_arg(argv)):
            return "bash-cwd-relative-write", armed
        return "", armed
    return scan_interpreter(name, argv, seg, depth, armed), armed


def scan_command(text, depth, armed):
    """Ordered left-to-right walk over UNQUOTED `; & | newline ( )` boundaries,
    carrying the cwd-arming flag between segments; `(`/`)` push and pop it so a
    subshell cd cannot leak out. Depth-capped, since a shell code string
    re-enters here."""
    if not text:
        return ""
    if depth > MAX_SCAN_DEPTH:
        # agent_id: text past the cap is unscanned, so a home spelling in it fails closed.
        if AGENT["on"] and CODE_HOME_RE.search(text):
            agent_emit("N", text[:200], "")
        return ""
    saved = (AGENT["cwd"], AGENT["piped"])
    AGENT["piped"] = False
    try:
        return scan_text(text, depth, armed)
    finally:
        # A re-scanned string runs in a child shell, so its cd never leaks out.
        AGENT["piped"] = saved[1]
        if depth:
            AGENT["cwd"] = saved[0]


def scan_text(text, depth, armed):
    """scan_command's walk over one depth-checked text."""
    code, heredocs = split_heredocs(text)
    mask = quote_mask(code)
    if AGENT["on"]:
        agent_extras(code, mask, heredocs, depth, armed)
    stack = []
    start = 0
    for i, ch in enumerate(code):
        if mask[i] or ch not in ";&|\n()":
            continue
        # `>|` and `>&` are two-char redirect OPERATORS, not separators. Cutting
        # the segment between the two characters would strand the operator at a
        # segment end and hide its target token from the redirect recogniser.
        if ch in "|&" and i > 0 and code[i - 1] == ">" and not mask[i - 1]:
            continue
        glued = ch == "(" and i > start and not code[i - 1].isspace()
        reason, armed = scan_segment(code[start:i], depth, armed, glued)
        if reason:
            return reason
        # A lone `|` (or `|&`) pipes this segment into the next non-empty one; `||` is no pipe.
        if ch == "|" and code[i + 1:i + 2] != "|" and code[i - 1:i] != "|":
            AGENT["piped"] = True
        if ch == "(":
            stack.append((armed, AGENT["cwd"]))
        elif ch == ")":
            AGENT["array"] = None
            if stack:
                armed, AGENT["cwd"] = stack.pop()
        start = i + 1
    reason, armed = scan_segment(code[start:], depth, armed)
    if reason:
        return reason
    for is_shell, _name, body, _quoted in heredocs:
        if is_shell:
            reason = scan_command(body, depth + 1, armed)
            if reason:
                return reason
    return ""


def detect_bash(tool_input):
    """Redirect / copy verb whose target is a protected path (bash-mutation), the
    same match explained entirely by a protected path in SOURCE position
    (bash-source-position — still a block, re-labelled so the payload can name the
    read re-spelling), an interpreter code-string write (bash-interp-write), or a
    relative write made from a protected cwd (bash-cwd-relative-write)."""
    command = tool_input.get("command", "")
    carried = agent_binding_pass(command) if AGENT["on"] else ({}, set())
    PROT_CD_SEEN[0] = False
    agent_reset(command, carried)
    reason = scan_command(command, 0, False)
    # A void anywhere in the call: every read operand is a non-read, and its text may be code.
    if AGENT["void"]:
        for word, cwd in AGENT["reads"]:
            agent_judge(word, cwd)
            agent_code_search(word)
    # An interpreter heredoc body is walked before any cd, so judge it from every dir entered.
    for body in AGENT["codes"]:
        for cwd in dict.fromkeys(AGENT["cwds"]):
            agent_code_search(body, cwd)
    return reason


def agent_binding_pass(command):
    """(bindings, opaque names) of the whole call. A loop runs a use before the assignment below
    it, so every binding is known before any word is judged."""
    PROT_CD_SEEN[0] = False
    agent_reset(command, ({}, set()))
    scan_command(command, 0, False)
    return AGENT["vars"], AGENT["opaque"]


class NulInCommand(Exception):
    """A NUL in Bash command text: no field of the NUL-framed output may carry one."""


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            data = {}
    except Exception:  # noqa: BLE001 — unparseable envelope → empty fields (extraction parity)
        data = {}
    tool_input = data.get("tool_input", {}) or {}
    if not isinstance(tool_input, dict):
        tool_input = {}
    tool_name = str(data.get("tool_name", ""))
    agent_id = str(data.get("agent_id", "") or "")
    raw_target = ""
    resolved = ""
    if tool_name in ("Write", "Edit", "MultiEdit"):
        # Normalisation is the FIRST operation on the parsed envelope — ahead of
        # every disk read and arm dispatch. A tilde/traversal spelling reaching
        # read_disk unresolved yields "" (OSError), which reads as "no frontmatter"
        # and passes an identity edit; resolving here is what closes that evasion.
        raw_target = str(tool_input.get("file_path", ""))
        target = normalize_path(raw_target)
        tool_input = dict(tool_input)
        tool_input["file_path"] = target
    elif tool_name == "Bash":
        target = str(tool_input.get("command", ""))
        raw_target = target
    else:
        target = ""
    status = 0
    AGENT["on"] = bool(agent_id)
    try:
        if tool_name in ("Write", "Edit", "MultiEdit"):
            resolved = resolved_form(raw_target)
        # NUL guard, every caller: a NUL splits the command differently for the shell that runs
        # it than for this scan, so it fails closed up front as HAR-003.
        if tool_name == "Bash" and "\x00" in target:
            raise NulInCommand()
        if tool_name == "Write":
            reason = detect_agent_write(tool_input)
        elif tool_name == "Edit":
            reason = detect_agent_edit(tool_input)
        elif tool_name == "MultiEdit":
            reason = detect_agent_multiedit(tool_input)
        elif tool_name == "Bash":
            reason = detect_bash(tool_input)
        else:
            reason = ""
        verdict = "block:" + reason if reason else "allow"
    except Exception as exc:  # noqa: BLE001 — an internal defect is fail-CLOSED
        # This refinement is the SOLE owner of the interpreter classes, so an
        # exception resolved to allow passes the entire command. Name the type
        # for the block payload, then exit non-zero so HAR-003 blocks.
        verdict = "error:" + type(exc).__name__
        status = 3
    # NUL-strip mirrors hook_get_fields (a JSON string MAY carry \u0000; an embedded
    # NUL would truncate the `read -r -d ''` consumer mid-value).
    # agent_id read proof: a count field, then one (literal flag, written, resolved) triple per
    # unproven word — judged only on an allow verdict, so a block or error carries none.
    triples = AGENT["triples"] if verdict == "allow" else []
    fields = [tool_name, target, verdict, raw_target, agent_id, resolved, str(len(triples))]
    fields.extend(value for triple in triples for value in triple)
    for field in fields:
        sys.stdout.write(field.rstrip("\n").replace("\x00", "") + "\0")
    sys.stdout.flush()
    if status:
        sys.exit(status)


main()
PY

# Block-payload context as VALID JSON whatever bytes the target carries: a raw
# interpolation of a path holding a " or \ produced malformed JSON, and emit_error's
# --argjson then degraded the whole object to {}, dropping BOTH fields. Dual path,
# mirroring the library's own emit: jq present → argument-passing construction ·
# jq absent → the library's pure-bash escaper. The fallback is mandatory — under
# errexit a bare jq call dies exit-127 on a jq-less machine, and a non-2 hook exit
# is NON-blocking, i.e. the gate would fail open inside its own block path. It is
# NEVER python3-based: the HAR-003 classifier-failure branch fires precisely when
# python3 is broken, so a python3 escaper would be dead exactly when needed.
# raw_target is the pre-normalisation spelling, reported ONLY when it differs from
# the resolved target — an operator reading the payload otherwise cannot tell which
# envelope produced a block. Absent key on every already-resolved path keeps the
# payload byte-identical for the common case.
# Args: $1=class $2=target $3=raw_target (optional) · stdout: a JSON object.
block_context() {
  local class="${1}" target="${2}" raw="${3:-}" e_class e_target e_raw
  if [[ -n "${raw}" ]]; then
    if command -v jq >/dev/null 2>&1 \
      && jq -cn --arg class "${class}" --arg target "${target}" --arg raw "${raw}" \
        '{class:$class,target:$target,raw_target:$raw}' 2>/dev/null; then
      return 0
    fi
    e_class="$(_hook_json_escape "${class}")"
    e_target="$(_hook_json_escape "${target}")"
    e_raw="$(_hook_json_escape "${raw}")"
    printf '{"class":"%s","target":"%s","raw_target":"%s"}' "${e_class}" "${e_target}" "${e_raw}"
    return 0
  fi
  if command -v jq >/dev/null 2>&1 \
    && jq -cn --arg class "${class}" --arg target "${target}" \
      '{class:$class,target:$target}' 2>/dev/null; then
    return 0
  fi
  e_class="$(_hook_json_escape "${class}")"
  e_target="$(_hook_json_escape "${target}")"
  printf '{"class":"%s","target":"%s"}' "${e_class}" "${e_target}"
}

# Per-class wording for the block payload. ONE hardcoded pair used to serve every
# class, so a source-position READ was reported as a "write" and offered three
# deployment remedies that cannot take a backup, while `update.sh` cannot land a
# settings.json change at all (it is user-owned + sensitive-partitioned out of the
# deterministic apply set).
# The frontmatter-repair sentence names a PARSE failure, so it belongs to exactly the
# two frontmatter-parse classes and is forbidden elsewhere — the identity-key classes
# block a guarded-key write, not a parse failure.
# `case` rather than an associative array: stock macOS bash 3.2 has none. The `*)`
# arm is MANDATORY — an unknown future class must still emit a usable pair, and every
# arm leaves the caller's terminal `exit 2` intact.
# Args: $1=class · sets BLOCK_MSG / BLOCK_SUG for the single caller below (two return
# values, and a command substitution per emit is the alternative).
block_wording() {
  local class="${1}"
  BLOCK_MSG="Harness-critical write blocked (${class})"
  case "${class}" in
    live-settings)
      BLOCK_SUG="Live settings.json is user-owned and protected agent_id-independent: edit it outside the tool layer with a non-tool-layer editor, then relaunch. The deterministic apply spine partitions this file out, so no release path can land the change for you. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    live-hooks-dir)
      BLOCK_SUG="Live hook files are protected agent_id-independent: change them in the SOURCE repository and ship the change through the installer / update.sh release path, never a direct tool-layer write. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    scheduled-exec-dir)
      BLOCK_SUG="This scheduled-execution surface (autoagent / scripts / skills) runs unattended, so it is protected agent_id-independent: change it in the SOURCE repository and ship it through the installer / update.sh release path. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    canary-dir)
      BLOCK_SUG="The canary directory holds the per-agent trial text the scope-rules hook delivers at spawn; only the improvement daemon writes it, so it is protected agent_id-independent and a tool-layer write would put unregistered text into a live trial. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    new-agent-creation)
      BLOCK_SUG="Agent creation runs through the lifecycle CLI: \`python3 -m agent_lifecycle add\` writes the body, the registry entry and the symlink farm as one gated transaction, where a direct file write leaves an agent that loads no scope rules. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    identity-frontmatter-write)
      BLOCK_SUG="This write replaces the agent frontmatter identity keys {name, tools, scope}, which the lifecycle CLI owns — run the change through \`python3 -m agent_lifecycle\` instead. The model: pin is outside the guarded set and edits freely. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    identity-frontmatter-edit)
      BLOCK_SUG="This edit moves a guarded agent identity key {name, tools, scope}; only \`python3 -m agent_lifecycle\` may move one. Body text below the fence edits freely, as does the unguarded model: pin. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    frontmatter-fence-edit)
      BLOCK_SUG="This edit alters the agent frontmatter fence itself, which would carry the guarded identity keys {name, tools, scope} out of the guard's reach. Leave the fence intact and edit the body, or run the change through \`python3 -m agent_lifecycle\`. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    unterminated-frontmatter)
      BLOCK_SUG="The agent frontmatter has no closing fence, so the identity guard cannot answer the identity question and fails closed. Unparseable agent frontmatter blocks the tool layer only — repair it in the SOURCE repository with a non-tool-layer editor and ship it through the release path."
      ;;
    frontmatter-unparseable)
      BLOCK_SUG="A guarded frontmatter key carries a value outside the parse contract, so the identity guard fails closed rather than guess. Unparseable agent frontmatter blocks the tool layer only — repair it in the SOURCE repository with a non-tool-layer editor and ship it through the release path."
      ;;
    edit-create-shape)
      BLOCK_SUG="An empty old_string is the CREATE spelling, and on an existing guarded agent file that reads as a whole-file overwrite this pair-wise guard cannot model, so it fails closed. Re-spell the change as a targeted edit with a non-empty old_string. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    unreadable-edit-payload)
      BLOCK_SUG="The edit payload carries no readable old_string/new_string pair, so the identity guard cannot tell whether a guarded key moves and fails closed. Re-issue the edit with both strings present as plain text. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    bash-mutation)
      BLOCK_SUG="A mutation verb in this command names a protected harness path as its target. Ship the change through the sanctioned path for that surface — the installer / update.sh release path, or \`python3 -m agent_lifecycle\` for agent files — or launch Claude Code with HARNESS_PROTECTION_APPROVE=1 for an approved change."
      ;;
    bash-interp-write)
      BLOCK_SUG="An interpreter code string in argument position (-c / -e / --eval) writes to a protected harness path; the code string is re-scanned by this same gate, so nesting the write one interpreter deeper does not pass it. Ship the change through the installer / update.sh release path, or launch Claude Code with HARNESS_PROTECTION_APPROVE=1 for an approved change."
      ;;
    bash-cwd-relative-write)
      BLOCK_SUG="An earlier \`cd\` into a protected harness directory armed this command, so its RELATIVE write target resolves inside the protected surface. Re-spell the target as an absolute path outside the protected roots, or ship the change through the installer / update.sh release path. An approved change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    bash-source-position)
      BLOCK_MSG="Harness-critical command blocked (bash-source-position): a protected path sits in SOURCE position"
      BLOCK_SUG="The copy verbs match the whole argument run, so reading a protected path blocks like writing one — an intentional over-block, not a bug. Re-spell the operation as a read and it passes: the Read tool, \`cat <protected> > <dest>\`, or \`dd if=<protected> of=<dest>\` (dd is inspected on its of= operand only). If it must run as written, launch Claude Code with HARNESS_PROTECTION_APPROVE=1."
      ;;
    nul-in-command)
      BLOCK_MSG="Harness-critical command blocked (nul-in-command): the command text carries a NUL byte"
      BLOCK_SUG="A NUL splits the command differently for the shell that runs it than for this gate's scan, so the gate fails closed rather than judge a command it cannot read as the shell will. Remove the NUL from the command text and re-run it."
      ;;
    agent-id-bash)
      BLOCK_MSG="Harness-critical command blocked (agent-id-bash): a subagent command names a ~/.claude* profile path it does not provably only read"
      BLOCK_SUG="A subagent or Workflow agent Bash call may name a profile path only as an operand of a reader command in a clean command position (cat, ls, grep, head, tail, wc, stat, find without -delete/-exec, cd, echo, printf), as a < source, or as a path in its job scratchpad (jobs/<id>/tmp/) or a progress-*.md file. After a cd into a profile path (the job scratchpad included) or into a directory named by a variable (\`cd \"\$T\"\`), every later relative word must be literal: name scratch files without \$var, glob or substitution, pass a glob to a reader (\`cat *.log\`), or cd into the literal path an earlier mktemp printed. A pipe into xargs, a while-read loop, a shell or any other non-filter command voids the read proof: pass the paths to the reader itself. A variable (an assignment, a for-list name) carries every value the call binds it to into each later use, so \`D=<memory dir>; cat \"\$D/x\"\` still reads, while writing through \$D — in a shell word, a code string, a heredoc body or an eval string — is judged as the path it spells. An assignment a child process sees — export, allexport, an inherited name such as CLAUDE_CONFIG_DIR, a command prefix — itself blocks unless its value is a job-scratchpad or progress path, and so does reassigning HOME. A progress file needs no mkdir — the Write tool creates its memory dir. Re-spell a copy as a read (\`cat <src> > <dest>\`), put scratch files in \$TMPDIR (bare mktemp), and return a harness or memory change to the orchestrator. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    agent-id-write)
      BLOCK_SUG="A subagent or Workflow agent writes under a ~/.claude* profile root only into its job scratchpad (jobs/<id>/tmp/) or a progress-*.md file in a memory dir — the BASENAME exception is the orchestrator's. Put scratch files in \$TMPDIR (bare mktemp), and return a harness or memory change to the orchestrator. An approved tool-layer change needs Claude Code launched with HARNESS_PROTECTION_APPROVE=1."
      ;;
    classifier-failure)
      BLOCK_MSG="Harness-critical gate unavailable (classifier-failure) — failing closed"
      BLOCK_SUG="The envelope classifier could not run, so the gate cannot tell a protected write from a harmless one and fails closed by design rather than pass unread input. Restore a working python3 on PATH and re-run the command. The block covers only envelopes naming a protected root, not all tool use."
      ;;
    *)
      BLOCK_SUG="This surface is protected agent_id-independent. Ship the change through the sanctioned path for that surface, or launch Claude Code with HARNESS_PROTECTION_APPROVE=1 for an approved change."
      ;;
  esac
}

# Emit the block payload + exit 2.
# Args: $1=code $2=class $3=target (path or command) $4=raw_target (optional).
block_critical() {
  local code="${1}" class="${2}" target="${3}" raw="${4:-}" ctx
  ctx="$(block_context "${class}" "${target}" "${raw}")"
  block_wording "${class}"
  emit_error "${code}" "block" "${BLOCK_MSG}" "${BLOCK_SUG}" "${ctx}"
  exit 2
}

# One detector pass over the hook INPUT, fail-CLOSED: the producer appends the
# classifier's exit status as a SEVENTH NUL-framed field, and the gate below
# compares it against the LITERAL zero string — non-zero, EMPTY, or misaligned all
# block, so a classifier crashing mid-stream can never smuggle a pass through
# partial output. A SIGPIPE (141) blocks too, which is the correct direction.
# `|| st=$?` sits in condition context, so the subshell-inherited errexit cannot
# abort before the trailer prints. Capturing the stream into a variable is
# FORBIDDEN — command substitution strips NUL bytes, which ARE the field framing —
# as is `wait` on the process substitution (bash 4.4+, broken on stock 3.2.57).
# Blast radius stays bounded by the prefilter above: a broken python3 blocks only
# envelopes naming a protected root, not all tool use.
# SC2312: the producer pipeline's own return is deliberately unread — the in-band
# status trailer, not the pipeline exit, is what the gate consumes.
# shellcheck disable=SC2312
{
  IFS= read -r -d '' TOOL_NAME || true
  IFS= read -r -d '' TARGET || true
  IFS= read -r -d '' VERDICT || true
  IFS= read -r -d '' RAW_TARGET || true
  IFS= read -r -d '' AGENT_ID || true
  IFS= read -r -d '' RESOLVED_TARGET || true
  # agent_id read proof: a count, then that many (flag, written, resolved) triples. A read stops at
  # EOF, so a short stream leaves PY_STATUS empty and a long one leaves it on a triple field.
  IFS= read -r -d '' TRIPLE_COUNT || true
  TRIPLES=()
  if [[ "${TRIPLE_COUNT}" =~ ^[0-9]{1,6}$ ]]; then
    while ((${#TRIPLES[@]} < 10#${TRIPLE_COUNT} * 3)); do
      IFS= read -r -d '' triple_field || break
      TRIPLES+=("${triple_field}")
    done
  fi
  IFS= read -r -d '' PY_STATUS || true
} < <(
  st=0
  printf '%s\n' "${INPUT}" | HARNESS_CANARY_DIR="${CANARY_DIR}" python3 -c "${DETECT_PY}" 2>/dev/null || st=$?
  printf '%s\0' "${st}"
)
# A count that is not a number, or a triple run of the wrong length, is a misaligned stream.
if [[ ! "${TRIPLE_COUNT}" =~ ^[0-9]{1,6}$ ]] || ((${#TRIPLES[@]} != 10#${TRIPLE_COUNT} * 3)); then
  PY_STATUS="framing:${PY_STATUS}"
fi
if [[ "${PY_STATUS}" != "0" ]]; then
  # `error:<ExcType>` is the classifier naming its OWN internal exception; any
  # other verdict value means it died before it could say anything.
  CLASSIFIER_DETAIL="python3 classifier exit ${PY_STATUS:-EOF}"
  case "${VERDICT}" in
    error:NulInCommand) block_critical "HAR-003" "nul-in-command" "${TARGET:0:200}" ;;
    error:*) CLASSIFIER_DETAIL="${CLASSIFIER_DETAIL} (${VERDICT})" ;;
    *) : ;;
  esac
  block_critical "HAR-003" "classifier-failure" "${CLASSIFIER_DETAIL}"
fi

# Branch-root grammar, single-sited in lib/. Sourced after every helper definition and before the
# first use; an unreadable lib cannot classify harness paths, so it blocks through the existing
# HAR-003 degradation class rather than passing the write.
config_dirs_lib="${BASH_SOURCE%/*}/lib/claude-config-dirs.sh"
# shellcheck source=lib/claude-config-dirs.sh
if [[ ! -r "${config_dirs_lib}" ]] || ! source "${config_dirs_lib}"; then
  block_critical "HAR-003" "classifier-failure" "lib/claude-config-dirs.sh unreadable"
fi

# agent_id write gate (Write/Edit/MultiEdit): a subagent or Workflow agent writes under a profile root
# only into its job scratchpad or a progress file — no BASENAME exception, which serves orchestrator
# memory-index and root-rule updates. Called only where today's arm would pass, so it adds blocks
# only. The target is judged as written and as resolved: a link or hardlink planted earlier under
# jobs/<id>/tmp/ cannot alias a protected entry. Main-session calls never reach it.
agent_write_arm() {
  [[ -n "${AGENT_ID}" ]] || return 0
  set_home_phys
  # Intended predicate calls (exit status IS the answer) → SC2310 disabled.
  # shellcheck disable=SC2310
  if is_agent_form_blocked "${RAW_TARGET}" ""; then
    block_critical "HAR-001" "agent-id-write" "${RAW_TARGET}"
  fi
  # shellcheck disable=SC2310
  if [[ -n "${RESOLVED_TARGET}" ]] && is_agent_form_blocked "${RESOLVED_TARGET}" hardlink; then
    block_critical "HAR-001" "agent-id-write" "${RESOLVED_TARGET}" "${RAW_TARGET}"
  fi
}

set_home_phys() {
  HOME_PHYS="$(cd -P -- "${HOME}" 2>/dev/null && pwd -P)" || HOME_PHYS=""
}

# agent_id read proof (Bash): each triple is a profile-root word the classifier could not prove a
# read. A non-literal word blocks outright; a literal one blocks when its written or resolved form
# is in scope and not exempt. Called only where today's verdict passes, so it adds blocks only.
agent_bash_arm() {
  local i=0 flag written resolved
  [[ -n "${AGENT_ID}" ]] || return 0
  set_home_phys
  while ((i + 2 < ${#TRIPLES[@]})); do
    flag="${TRIPLES[i]}" written="${TRIPLES[i + 1]}" resolved="${TRIPLES[i + 2]}"
    i=$((i + 3))
    [[ "${flag}" == L ]] || block_critical "HAR-002" "agent-id-bash" "${written:0:200}"
    # shellcheck disable=SC2310
    if is_agent_form_blocked "${written}" ""; then
      block_critical "HAR-002" "agent-id-bash" "${written:0:200}"
    fi
    # shellcheck disable=SC2310
    if [[ -n "${resolved}" ]] && is_agent_form_blocked "${resolved}" hardlink; then
      block_critical "HAR-002" "agent-id-bash" "${resolved:0:200}" "${written:0:200}"
    fi
  done
}

# One form of a target against every profile root of HOME and of its physical spelling (a home behind
# a link realpaths elsewhere). Scope folds case under the shell-global nocasematch; the remainder is
# stripped case-sensitively, so a case-varied home keeps a home component and matches no member.
# Args: $1=path form  $2=`hardlink` for the resolved form. Exit 0 = in scope and not exempt.
is_agent_form_blocked() {
  local form="${1}" path="${1}" home rest
  [[ "${path}" == /System/Volumes/Data/* ]] && path="${path:20}"
  path="$(hook_normalize_path "${path}")"
  for home in "${HOME}" "${HOME_PHYS}"; do
    [[ -n "${home}" && "${path}" == "${home}/"* ]] || continue
    rest="${path:${#home}+1}"
    [[ "${rest%%/*}" =~ ^${CLAUDE_CONFIG_ROOT_RE%/}$ ]] || continue
    rest="$(claude_config_strip_branch_root "${path}" "${home}")"
    # shellcheck disable=SC2310
    claude_config_is_exempt_entry "progress job" "${form}" "${rest}" ${2:+"${2}"} || return 0
  done
  return 1
}

write_edit_arm() {
  local norm raw
  [[ -z "${TARGET}" ]] && exit 0
  # TARGET already arrives normalised (the classifier resolves it before its own
  # disk read), so this is a deliberate idempotent second pass — defence in depth
  # for the shell-side match arms, not the live normalisation.
  norm="$(hook_normalize_path "${TARGET}")"
  raw=""
  # POSIX test, deliberately NOT `[[ ]]`: the shell-global nocasematch set above
  # governs `[[ ]]` but not `[ ]`, and folding here would report a case-varied
  # envelope as already-resolved — deleting the raw spelling from the block payload,
  # i.e. exactly the forensic evidence of the case-variance attack.
  # shellcheck disable=SC2292
  [ "${RAW_TARGET}" != "${norm}" ] && raw="${RAW_TARGET}"

  # Predicates rather than case globs on the `.claude` roots: they carry the branch grammar for
  # every profile dir, and being `[[ ]]`-based they inherit the shell-global nocasematch the
  # literal globs folded under.
  # Intended predicate calls (exit status IS the answer, no set -e reliance) → SC2310 disabled.
  # shellcheck disable=SC2310
  if claude_config_is_settings_path "${norm}"; then
    block_critical "HAR-001" "live-settings" "${norm}" "${raw}"
  fi
  # shellcheck disable=SC2310
  if claude_config_is_hooks_dir_path "${norm}"; then
    block_critical "HAR-001" "live-hooks-dir" "${norm}" "${raw}"
  fi

  case "${norm}" in
    "${GA_DIR}/hooks/"*)
      block_critical "HAR-001" "live-hooks-dir" "${norm}" "${raw}"
      ;;
    "${GA_DIR}/autoagent/"* | "${GA_DIR}/scripts/"* | "${GA_DIR}/skills/"*)
      block_critical "HAR-001" "scheduled-exec-dir" "${norm}" "${raw}"
      ;;
    "${CANARY_DIR}/"*)
      block_critical "HAR-001" "canary-dir" "${norm}" "${raw}"
      ;;
    *) : ;;
  esac

  # Only agents/*.md continues to the identity inspection; everything else passes.
  case "${norm}" in
    "${GA_DIR}/agents/"*.md | "${CLAUDE_DIR}/agents/"*.md) : ;;
    *)
      agent_write_arm
      exit 0
      ;;
  esac

  # Creation is not a Write-only shape — an absent target is the creation signal
  # for every tool this arm dispatches: MultiEdit creates through an EMPTY first
  # element old_string, and a plain Edit through an EMPTY top-level one, which the
  # host accepts and classifies as a create.
  if [[ "${TOOL_NAME}" == "Write" || "${TOOL_NAME}" == "Edit" || "${TOOL_NAME}" == "MultiEdit" ]] && [[ ! -e "${norm}" ]]; then
    block_critical "HAR-001" "new-agent-creation" "${norm}"
  fi
  case "${VERDICT}" in
    block:*) block_critical "HAR-001" "${VERDICT#block:}" "${norm}" ;;
    *)
      agent_write_arm
      exit 0
      ;;
  esac
}

bash_arm() {
  case "${VERDICT}" in
    block:*) block_critical "HAR-002" "${VERDICT#block:}" "${TARGET:0:200}" ;;
    *)
      agent_bash_arm
      exit 0
      ;;
  esac
}

case "${TOOL_NAME}" in
  Write | Edit | MultiEdit) write_edit_arm ;;
  Bash) bash_arm ;;
  *) exit 0 ;;
esac
