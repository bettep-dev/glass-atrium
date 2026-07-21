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
#
# Bash arm (best-effort, bar-raising ONLY): a >/>> redirect blocks when the > sits
# at start/after whitespace-or-separator (optional fd digit) AND the protected path
# is its IMMEDIATE target token — a quoted '>' inside an argument (grep -- '->',
# awk '$1 > 5') does not present this shape; copy verbs (tee, cp, mv, ln, sed -i)
# match in COMMAND position, followed — within the same unpiped command segment —
# by a protected-path literal. DOCUMENTED RESIDUAL (not covered): variable
# indirection (P=...; echo > "$P"), command substitution, quote-split paths,
# non-command-position verb runs (xargs/find -exec) — the settings deny layer + the
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
# (block:<reason> | allow), each NUL-terminated (hook_get_fields consumer
# convention). The verdict refinement fails OPEN on an internal exception — the
# deterministic path classes (live settings / hook dirs / new-agent creation) block
# in pure bash and never depend on it.
# `read -d ''` builtin assignment (no command-substitution-of-cat subshell); read
# returns 1 at heredoc EOF without a NUL → `|| true`.
IFS= read -r -d '' DETECT_PY <<'PY' || true
import json
import re
import sys


IDENTITY_LINE_RE = re.compile(r"^(?:name|tools|scope)[ \t]*:", re.MULTILINE)

# Protected-path literals (best-effort text match — Bash arm).
PROT_RE = re.compile(
    r"\.claude/settings(?:\.local)?\.json"
    r"|\.claude/hooks/"
    r"|\.glass-atrium/hooks/"
    r"|\.claude/agents/"
    r"|\.glass-atrium/agents/"
)

# Redirect shape: start-or-separator, optional fd digit, > or >>, then the
# protected path as the IMMEDIATE next token. A quoted '>' inside an argument
# (grep -- '->', awk '$1 > 5') never presents this shape.
REDIR_RE = re.compile(r"(?:^|[\s;&|])\d?>{1,2}[ \t]*(\S+)")

# Copy/mutation verbs in COMMAND position (segment start, optional sudo/env
# prefix): tee, cp, mv, ln, sed short-flag -i run. The position class carries "("
# (subshell / command substitution) and \x60 (backtick — spelled as an escape so
# the enclosing bash heredoc scan never sees a literal backquote).
CMD_VERB_RE = re.compile(
    r"(?:^|[|;&\n(\x60])[ \t]*(?:sudo[ \t]+|env[ \t]+)?"
    r"(?:tee\b|cp\b|mv\b|ln\b|sed\b[^|;&\n]*\s-[a-zA-Z]*i)"
)


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
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


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


def detect_bash(tool_input):
    """Redirect whose immediate target token is a protected path, or a
    command-position copy verb followed (same unpiped segment) by one."""
    cmd = tool_input.get("command", "")
    if not cmd:
        return ""
    for m in REDIR_RE.finditer(cmd):
        if PROT_RE.search(m.group(1)):
            return "bash-mutation"
    for vm in CMD_VERB_RE.finditer(cmd):
        segment = re.split(r"[|;&\n]", cmd[vm.end():], 1)[0]
        if PROT_RE.search(segment):
            return "bash-mutation"
    return ""


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
    try:
        if tool_name == "Write":
            reason = detect_agent_write(tool_input)
        elif tool_name == "Edit":
            reason = detect_agent_edit(tool_input)
        elif tool_name == "Bash":
            reason = detect_bash(tool_input)
        else:
            reason = ""
    except Exception:  # noqa: BLE001 — refinement fails open; bash-side classes stay armed
        reason = ""
    verdict = "block:" + reason if reason else "allow"
    # NUL-strip mirrors hook_get_fields (a JSON string MAY carry \u0000; an embedded
    # NUL would truncate the `read -r -d ''` consumer mid-value).
    for field in (tool_name, target, verdict):
        sys.stdout.write(field.rstrip("\n").replace("\x00", "") + "\0")


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
[[ "${PY_STATUS}" == "0" ]] || block_critical "HAR-003" "classifier-failure" "python3 classifier exit ${PY_STATUS:-EOF}"

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
