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
# Write|Edit arm remain the primary gates.
#
# Grant: HARNESS_PROTECTION_APPROVE=1 in the hook's LAUNCH environment → pass
# (parity with CONFIG_PROTECTION_APPROVE). CAVEAT: an in-session
# `export HARNESS_PROTECTION_APPROVE=1` via the Bash tool NEVER reaches the hook —
# hooks inherit the environment Claude Code was LAUNCHED with, not the session
# shell's children. Sanctioned live-sync delegations therefore need the launch-env
# grant, or those writes go via the existing NON-hook-mediated paths
# (installer / update.sh / daemon-apply / agent_lifecycle sync-inject).
#
# Fail-closed on python3 absence (DEL-002 precedent family): without python3 the
# extraction helpers degrade to EMPTY → the empty-path allow would silently disarm
# the gate; non-trivial input + no python3 → HAR-003 block (exit 2).
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
case "${INPUT}" in
  "" | "{}" | "{ }") : ;;
  *) hook_require_python3 "HAR-003" \
    "Harness-critical gate unavailable: python3 is required to parse hook input" ;;
esac

TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"

# Normalize a POSIX path by collapsing "." and ".." segments without touching the
# filesystem (the target may not exist yet). Traversal-safety: "hooks/../x" resolves
# to "x", so a protected prefix cannot be dodged via "..". Mirrors
# enforce-delegation.sh normalize_path. Args: $1 = path. Echoes normalized.
normalize_path() {
  local path="${1}" seg
  local -a out=()
  local lead=""
  [[ "${path}" == /* ]] && lead="/"
  local saved_ifs="${IFS}"
  IFS='/'
  # Word-split on "/" intentionally to walk each segment.
  # shellcheck disable=SC2206
  local -a parts=(${path})
  IFS="${saved_ifs}"
  # ${arr[@]+"${arr[@]}"} guards empty-array expansion under set -u on bash 3.2.
  for seg in ${parts[@]+"${parts[@]}"}; do
    case "${seg}" in
      "" | ".") : ;;
      "..")
        # Pop the last real segment (do not pop past root / a leading "..").
        if [[ ${#out[@]} -gt 0 && "${out[${#out[@]} - 1]}" != ".." ]]; then
          unset 'out[${#out[@]}-1]'
          out=(${out[@]+"${out[@]}"})
        elif [[ -z "${lead}" ]]; then
          out+=("..")
        fi
        ;;
      *) out+=("${seg}") ;;
    esac
  done
  local joined=""
  if [[ ${#out[@]} -gt 0 ]]; then
    local saved_ifs2="${IFS}"
    IFS='/'
    joined="${out[*]}"
    IFS="${saved_ifs2}"
  fi
  printf '%s\n' "${lead}${joined}"
}

CLAUDE_DIR="${HOME}/.claude"
GA_DIR="${HOME}/.glass-atrium"
readonly CLAUDE_DIR GA_DIR

# Content-inspection detector (python3 — robust frontmatter/regex parsing). Emits one
# token on stdout: block:<reason> → caller blocks (exit 2) · allow → pass. The
# refinement fails OPEN on an internal exception — the deterministic path classes
# (live settings / hook dirs / new-agent creation) block in pure bash and never
# depend on it.
DETECT_PY=$(
  cat <<'PY'
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
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    data = json.load(sys.stdin)
    tool_input = data.get("tool_input", {}) or {}
    if mode == "agent-write":
        reason = detect_agent_write(tool_input)
    elif mode == "agent-edit":
        reason = detect_agent_edit(tool_input)
    elif mode == "bash":
        reason = detect_bash(tool_input)
    else:
        reason = ""
    sys.stdout.write(("block:" + reason if reason else "allow") + "\n")


try:
    main()
except Exception:  # noqa: BLE001 — refinement fails open; bash-side classes stay armed
    sys.stdout.write("allow\n")
PY
)

# Run the detector in mode $1 over the hook INPUT; stdout: block:<reason> | allow.
# A detector crash degrades to allow (fail-open refinement, see DETECT_PY note).
run_detector() {
  local mode="${1}" out
  out="$(printf '%s\n' "${INPUT}" | python3 -c "${DETECT_PY}" "${mode}" 2>/dev/null)" || out="allow"
  printf '%s\n' "${out}"
}

# Emit the block payload + exit 2. Args: $1=code $2=class $3=target (path or command).
block_critical() {
  local code="${1}" class="${2}" target="${3}"
  emit_error "${code}" "block" \
    "Harness-critical write blocked (${class})" \
    "This surface is protected agent_id-independent. Use the sanctioned path (installer / update.sh / agent_lifecycle CLI), or launch Claude Code with HARNESS_PROTECTION_APPROVE=1 for an approved change" \
    "{\"class\":\"${class}\",\"target\":\"${target}\"}"
  exit 2
}

write_edit_arm() {
  local file_path norm verdict
  file_path="$(hook_get_tool_input "${INPUT}" "file_path")"
  [[ -z "${file_path}" ]] && exit 0
  norm="$(normalize_path "${file_path}")"

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

  if [[ "${TOOL_NAME}" == "Write" ]]; then
    if [[ ! -e "${norm}" ]]; then
      block_critical "HAR-001" "new-agent-creation" "${norm}"
    fi
    verdict="$(run_detector "agent-write")"
  else
    verdict="$(run_detector "agent-edit")"
  fi
  case "${verdict}" in
    block:*) block_critical "HAR-001" "${verdict#block:}" "${norm}" ;;
    *) exit 0 ;;
  esac
}

bash_arm() {
  local verdict cmd
  verdict="$(run_detector "bash")"
  case "${verdict}" in
    block:*)
      cmd="$(hook_get_tool_input "${INPUT}" "command")"
      block_critical "HAR-002" "${verdict#block:}" "${cmd:0:200}"
      ;;
    *) exit 0 ;;
  esac
}

case "${TOOL_NAME:-}" in
  Write | Edit) write_edit_arm ;;
  Bash) bash_arm ;;
  *) exit 0 ;;
esac
