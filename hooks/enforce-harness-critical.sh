#!/usr/bin/env bash
# enforce-harness-critical.sh — PreToolUse(Write|Edit + Bash) harness-critical file gate.
# Both arms block agent_id-INDEPENDENT (main session AND every subagent): a per-FILE
# protection floor, NOT a per-agent tool-grant check (core-security.md LLM06 boundary).
#
# Write|Edit arm (deterministic):
#   (a) live harness settings — ~/.claude/settings.json + ~/.claude/settings.local.json
#   (b) LIVE hook dirs — ~/.glass-atrium/hooks/ (primary) + ~/.claude/hooks/ (legacy)
#   (c) agents/*.md frontmatter IDENTITY keys {name, tools, scope} — `model:` EXCLUDED
#       (monitor/operator writer); body edits PASS. An Edit blocks when its old_string
#       overlaps the on-disk frontmatter block AND either alters the fence-line count
#       (`---` removal/insertion — cuts the fence-removal → identity-edit →
#       fence-restore multi-step bypass) or touches a line-start identity key; a
#       Write on an EXISTING agent file blocks only when its identity lines DIFFER
#       from the on-disk frontmatter. A file left with an UNTERMINATED opening fence
#       is a tampered state: Edit AND Write both block until repaired via a
#       sanctioned path / launch-env grant.
#   (d) Write of a NEW agents/*.md — creation routes through the agent_lifecycle CLI.
#   (e) scheduled-execution surface — ~/.glass-atrium/{autoagent,scripts,skills}/;
#       launchd runs autoagent/ code unattended, so a plain Edit persists code the
#       scheduler later executes (LLM06). rules/ + scoped/ are EXCLUDED by design —
#       hand-edited live and often, so blocking them would train a hook-disable
#       habit; sanctioned autoagent maintenance reroutes via HARNESS_PROTECTION_APPROVE=1.
#       PROT_RE mirrors these three dirs for the Bash arm.
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
#     unnameable directory (`cd -`, `popd`) re-arms whenever this command
#     entered a protected dir earlier — arming is a boolean over-approximation
#     and staying armed is the safe direction.
# DOCUMENTED RESIDUAL (not covered): variable
# indirection (P=...; echo > "$P"), command substitution, quote-split paths,
# non-command-position verb runs (xargs/find -exec), an interpreter fed code on
# STDIN rather than through a code flag, and a cd issued in an EARLIER Bash call
# (the machine is per-command; the envelope cwd field is deliberately unread until
# its live-cwd semantics are confirmed) — the settings deny layer + the
# Write|Edit arm remain the primary gates. The pure-bash hot-path prefilter (raw
# envelope must contain a ".claude" / ".glass-atrium" dir-name literal, else exit 0
# with zero python3 spawns) shares the same residual: an envelope hiding those
# literals behind indirection or JSON \uXXXX escapes skips this gate.
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
# — is a HAR-003 block (exit 2), never a pass.
# Block channel: stderr emit_error + exit 2 (shared-hook-capability-contract.md).
# Scope: LIVE install paths ONLY (HOME-anchored) — the git repo tree is untouched.

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

# Hot-path prefilter (pure bash, zero spawns): every protected class textually
# requires one of the two protected-root dir-name literals in the raw envelope —
# PROT_RE and the deterministic path classes literal-match on them, and traversal
# forms still contain them. No literal → nothing this gate can block → exit 0.
# Residual shared with the Bash arm: indirection / JSON \uXXXX escaping of the
# literals skips this gate (see header).
case "${INPUT}" in
  *".claude"* | *".glass-atrium"*) : ;;
  *) exit 0 ;;
esac

CLAUDE_DIR="${HOME}/.claude"
GA_DIR="${HOME}/.glass-atrium"
readonly CLAUDE_DIR GA_DIR

# Single-pass envelope classifier (python3 — robust JSON/frontmatter/regex parsing),
# ONE spawn for the whole hook: emits tool_name, the arm target (file_path for
# Write|Edit, command for Bash), and the content-inspection verdict
# (block:<reason> | allow | error:<ExcType>), each NUL-terminated (hook_get_fields
# consumer convention). An internal refinement exception NEVER resolves to allow:
# the refinement is the sole owner of the interpreter classes, so swallowing one
# disarms them silently. It names its exception type in the verdict field and
# exits non-zero, engaging the HAR-003 fail-closed gate below.
# `read -d ''` builtin assignment (no command-substitution-of-cat subshell); read
# returns 1 at heredoc EOF without a NUL → `|| true`.
IFS= read -r -d '' DETECT_PY <<'PY' || true
import json
import re
import sys


IDENTITY_LINE_RE = re.compile(r"^(?:name|tools|scope)[ \t]*:", re.MULTILINE)

# Protected-path literals (best-effort text match — Bash arm). The launchd
# alternation matches the harness launchctl-bootstrap plists by label
# (com.claude.* legacy + com.glass-atrium.* live) — the same label form
# daemon_cycle.py treats as a safety-tier surface; the label itself carries the
# prefilter literal, so a plist envelope reaches this classifier.
PROT_RE = re.compile(
    r"\.claude/settings(?:\.local)?\.json"
    r"|\.claude/hooks/"
    r"|\.glass-atrium/hooks/"
    r"|\.claude/agents/"
    r"|\.glass-atrium/agents/"
    r"|\.glass-atrium/autoagent/"
    r"|\.glass-atrium/scripts/"
    r"|\.glass-atrium/skills/"
    r"|com\.(?:claude|glass-atrium)\.[^/]+\.plist"
)

# Directory form of the protected roots, for cwd arming. A `cd` argument
# conventionally carries no trailing slash, which PROT_RE requires — so PROT_RE
# would arm on nothing. The trailing negative lookahead keeps a longer sibling
# name (.glass-atrium/autoagent-backup) OUT. The leading dot is what keeps the
# git repo tree (.../git/glass-atrium/hooks/) from arming.
PROT_DIR_RE = re.compile(
    r"(?:\.claude/(?:hooks|agents)"
    r"|\.glass-atrium/(?:hooks|agents|autoagent|scripts|skills))"
    r"(?![\w.\-])"
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


def identity_lines(text):
    """Identity key → stripped value, read from the frontmatter block only."""
    span = frontmatter_span(text)
    if span is None:
        return {}
    out = {}
    for line in text[span[0]:span[1]].split("\n"):
        m = re.match(r"^(name|tools|scope)[ \t]*:(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
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


def detect_agent_write(tool_input):
    """Write on an EXISTING agents/*.md — block when identity lines differ from
    disk, or when the on-disk frontmatter is unterminated (tampered state)."""
    disk = read_disk(tool_input.get("file_path", ""))
    content = tool_input.get("content", "")
    if unterminated(disk):
        return "unterminated-frontmatter"
    if identity_lines(disk) != identity_lines(content):
        return "identity-frontmatter-write"
    return ""


def detect_agent_edit(tool_input):
    """Edit on agents/*.md — block when old_string overlaps the on-disk frontmatter
    AND the edit alters the fence-line count OR carries a line-start identity key.
    An unterminated opening fence blocks outright (tampered state)."""
    old = tool_input.get("old_string", "")
    new = tool_input.get("new_string", "")
    if not old:
        return ""
    disk = read_disk(tool_input.get("file_path", ""))
    if unterminated(disk):
        return "unterminated-frontmatter"
    span = frontmatter_span(disk)
    if span is None:
        return ""
    overlap = False
    start = disk.find(old)
    while start != -1:
        if start < span[1] and (start + len(old)) > span[0]:
            overlap = True
            break
        start = disk.find(old, start + 1)
    if not overlap:
        return ""
    if fence_count(old) != fence_count(new):
        return "frontmatter-fence-edit"
    if IDENTITY_LINE_RE.search(old) or IDENTITY_LINE_RE.search(new):
        return "identity-frontmatter-edit"
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


def heredoc_consumer_is_shell(text, op_start, mask):
    """True when the command owning this heredoc operator is a shell — its body
    is CODE and gets re-scanned; every other consumer's body is DATA."""
    start = 0
    for i in range(op_start - 1, -1, -1):
        if not mask[i] and text[i] in ";&|\n()":
            start = i + 1
            break
    argv = command_argv(tokenize(text[start:op_start]))
    return bool(argv) and not argv[0][2] and argv[0][1].rsplit("/", 1)[-1] in INTERP_SHELL


def split_heredocs(text):
    """(code text, [(consumer_is_shell, body)]). A heredoc body consumed by a
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
        ops.append((i, m.group(1) == "-", m.group(3)))
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
            bodies.append((heredoc_consumer_is_shell(text, op[0], mask), "\n".join(body)))
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
            if is_protected(target):
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
    if any(is_protected(target) for target in targets):
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
    if PROT_DIR_RE.search(args[0]):
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
        if is_protected(target):
            return "bash-mutation", armed
        if armed and is_relative(target):
            return "bash-cwd-relative-write", armed
    return "", armed


def scan_segment(seg, depth, armed):
    """(block reason, armed after this segment) for ONE separator-free segment."""
    toks = tokenize(seg)
    if not toks:
        return "", armed
    for idx, tok in enumerate(toks):
        if tok[0] != "redir":
            continue
        target = toks[idx + 1] if idx + 1 < len(toks) else None
        if target is None or target[0] != "word" or not target[1]:
            continue
        # `>&` takes an fd as often as a file (`2>&1`); a bare fd names no path.
        if tok[1] == ">&" and (target[1].isdigit() or target[1] == "-"):
            continue
        if is_protected(target[1]):
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
    if not text or depth > MAX_SCAN_DEPTH:
        return ""
    code, heredocs = split_heredocs(text)
    mask = quote_mask(code)
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
        reason, armed = scan_segment(code[start:i], depth, armed)
        if reason:
            return reason
        if ch == "(":
            stack.append(armed)
        elif ch == ")" and stack:
            armed = stack.pop()
        start = i + 1
    reason, armed = scan_segment(code[start:], depth, armed)
    if reason:
        return reason
    for is_shell, body in heredocs:
        if is_shell:
            reason = scan_command(body, depth + 1, armed)
            if reason:
                return reason
    return ""


def detect_bash(tool_input):
    """Redirect / copy verb whose target is a protected path (bash-mutation),
    an interpreter code-string write (bash-interp-write), or a relative write
    made from a protected cwd (bash-cwd-relative-write)."""
    PROT_CD_SEEN[0] = False
    return scan_command(tool_input.get("command", ""), 0, False)


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
    if tool_name in ("Write", "Edit"):
        target = str(tool_input.get("file_path", ""))
    elif tool_name == "Bash":
        target = str(tool_input.get("command", ""))
    else:
        target = ""
    status = 0
    try:
        if tool_name == "Write":
            reason = detect_agent_write(tool_input)
        elif tool_name == "Edit":
            reason = detect_agent_edit(tool_input)
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
    for field in (tool_name, target, verdict):
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
# Args: $1=class $2=target · stdout: a JSON object.
block_context() {
  local class="${1}" target="${2}" e_class e_target
  if command -v jq >/dev/null 2>&1 \
    && jq -cn --arg class "${class}" --arg target "${target}" \
      '{class:$class,target:$target}' 2>/dev/null; then
    return 0
  fi
  e_class="$(_hook_json_escape "${class}")"
  e_target="$(_hook_json_escape "${target}")"
  printf '{"class":"%s","target":"%s"}' "${e_class}" "${e_target}"
}

# Emit the block payload + exit 2. Args: $1=code $2=class $3=target (path or command).
block_critical() {
  local code="${1}" class="${2}" target="${3}" ctx
  ctx="$(block_context "${class}" "${target}")"
  emit_error "${code}" "block" \
    "Harness-critical write blocked (${class})" \
    "This surface is protected agent_id-independent. Use the sanctioned path (installer / update.sh / agent_lifecycle CLI), or launch Claude Code with HARNESS_PROTECTION_APPROVE=1 for an approved change" \
    "${ctx}"
  exit 2
}

# One detector pass over the hook INPUT, fail-CLOSED: the producer appends the
# classifier's exit status as a FOURTH NUL-framed field, and the gate below
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
  IFS= read -r -d '' PY_STATUS || true
} < <(
  st=0
  printf '%s\n' "${INPUT}" | python3 -c "${DETECT_PY}" 2>/dev/null || st=$?
  printf '%s\0' "${st}"
)
if [[ "${PY_STATUS}" != "0" ]]; then
  # `error:<ExcType>` is the classifier naming its OWN internal exception; any
  # other verdict value means it died before it could say anything.
  CLASSIFIER_DETAIL="python3 classifier exit ${PY_STATUS:-EOF}"
  case "${VERDICT}" in
    error:*) CLASSIFIER_DETAIL="${CLASSIFIER_DETAIL} (${VERDICT})" ;;
    *) : ;;
  esac
  block_critical "HAR-003" "classifier-failure" "${CLASSIFIER_DETAIL}"
fi

write_edit_arm() {
  local norm
  [[ -z "${TARGET}" ]] && exit 0
  norm="$(hook_normalize_path "${TARGET}")"

  case "${norm}" in
    "${CLAUDE_DIR}/settings.json" | "${CLAUDE_DIR}/settings.local.json")
      block_critical "HAR-001" "live-settings" "${norm}"
      ;;
    "${GA_DIR}/hooks/"* | "${CLAUDE_DIR}/hooks/"*)
      block_critical "HAR-001" "live-hooks-dir" "${norm}"
      ;;
    "${GA_DIR}/autoagent/"* | "${GA_DIR}/scripts/"* | "${GA_DIR}/skills/"*)
      block_critical "HAR-001" "scheduled-exec-dir" "${norm}"
      ;;
    *) : ;;
  esac

  # Only agents/*.md continues to the identity inspection; everything else passes.
  case "${norm}" in
    "${GA_DIR}/agents/"*.md | "${CLAUDE_DIR}/agents/"*.md) : ;;
    *) exit 0 ;;
  esac

  if [[ "${TOOL_NAME}" == "Write" && ! -e "${norm}" ]]; then
    block_critical "HAR-001" "new-agent-creation" "${norm}"
  fi
  case "${VERDICT}" in
    block:*) block_critical "HAR-001" "${VERDICT#block:}" "${norm}" ;;
    *) exit 0 ;;
  esac
}

bash_arm() {
  case "${VERDICT}" in
    block:*) block_critical "HAR-002" "${VERDICT#block:}" "${TARGET:0:200}" ;;
    *) exit 0 ;;
  esac
}

case "${TOOL_NAME}" in
  Write | Edit) write_edit_arm ;;
  Bash) bash_arm ;;
  *) exit 0 ;;
esac
