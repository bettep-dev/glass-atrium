#!/usr/bin/env bash
# advisory-preedit-facts.sh — Stop/SubagentStop Pre-Edit Facts advisory.
#
# Post-turn ADVISORY for the scope-dev.md "Pre-Edit Facts Disclosure" rule: surfaces files
# Write/Edit-ed without a `Pre-Edit Facts:` declaration. WARN only, NEVER blocks. Facts come from the
# transcript (Stop/SubagentStop supply only a transcript_path, not the inline last_assistant_message).
# Registered on Stop AND SubagentStop (matcher ""), firing alongside track-outcome.sh.
# Advisory-only because Stop/SubagentStop have NO block channel — a finished turn cannot be rewound
# by exit 2 (rules/shared-hook-capability-contract.md Per-Event table: observe-only), so ALWAYS exit 0.
#
# Declaration format (scope-dev.md rule): a block headed `Pre-Edit Facts: <file_path>` then
# `importers:` / `affected API:` / `data schemas:` / `user instruction:`. The advisory keys on the
# <file_path> header PRESENCE per edited file, NOT fact quality/accuracy.
# Per shared-hook-capability-contract.md the Stop/SubagentStop lifecycle is advisory accounting only.

set -Eeuo pipefail
IFS=$'\n\t'

# Diagnostic ERR trap — stderr only, fail-open so an internal error never breaks session-end.
trap 'printf "[preedit-facts-advisory] internal error at line %d: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Drain stdin. Empty payload → nothing to advise on, exit silently.
INPUT=""
if [[ ! -t 0 ]]; then
  INPUT="$(cat 2>/dev/null)" || INPUT=""
fi
if [[ -z "${INPUT}" ]]; then
  exit 0
fi

# python3 required for JSON + transcript parsing. Fail-open if absent (must not break session-end).
if ! command -v python3 >/dev/null 2>&1; then
  printf '[preedit-facts-advisory] python3 not found — fail-open (exit 0)\n' >&2
  exit 0
fi

# Single-pass python3: parse input JSON + transcript jsonl, collect the Write/Edit file_path set vs
# the Pre-Edit Facts: declared-path set, diff them. Inside python3 to avoid the multi-line shell
# extraction trap (sed/head collapse multi-line bodies). Emits @@verdict@@<token> on stdout:
# skip_silent (no transcript / no edits — fail-open) · all_declared · missing (+ @@files@@ list) ·
# error (internal error — caller exits 0 fail-open).
PIPELINE_PY=$(
  cat <<'PY'
import json
import os
import re
import sys


def emit(verdict, **extras):
    """Single-line verdict + optional kv pairs on stdout."""
    sys.stdout.write(f"@@verdict@@{verdict}\n")
    for k, v in extras.items():
        sys.stdout.write(f"@@{k}@@{v}\n")


# Block header form: `Pre-Edit Facts: <file_path>` (case-insensitive label;
# path captured to end-of-line, trimmed). One header per declared file.
_HEADER_RE = re.compile(
    r"^[ \t]*Pre-Edit\s+Facts[ \t]*:[ \t]*(.+?)[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

# Tools whose tool_use marks a file as edited this turn.
_EDIT_TOOLS = ("Write", "Edit", "MultiEdit")


def _content_list(entry):
    """Return the content list from a transcript entry (top-level OR nested under message)."""
    content = entry.get("content")
    if content is None:
        msg_obj = entry.get("message")
        content = msg_obj.get("content") if isinstance(msg_obj, dict) else None
    return content if isinstance(content, list) else None


def _norm(path):
    """Normalize a path for set membership: strip code-fence/quote wrappers."""
    return path.strip(chr(96) + "'\" ")


def scan_transcript(tpath):
    """Collect edited file_paths + Pre-Edit Facts declared paths from the transcript.

    Returns (edited_paths set, declared_paths set). Declarations are parsed
    from assistant text chunks; edits from Write/Edit/MultiEdit tool_use chunks.
    """
    edited = set()
    declared = set()
    with open(tpath, "r", encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                entry = json.loads(raw_line)
            except (ValueError, json.JSONDecodeError):
                continue
            content = _content_list(entry)
            if content is None:
                continue
            for chunk in content:
                if not isinstance(chunk, dict):
                    continue
                ctype = chunk.get("type")
                if ctype == "tool_use" and chunk.get("name") in _EDIT_TOOLS:
                    tool_input = chunk.get("input", {})
                    if isinstance(tool_input, dict):
                        fpath = tool_input.get("file_path", "")
                        if isinstance(fpath, str) and fpath:
                            edited.add(_norm(fpath))
                elif ctype == "text":
                    text = chunk.get("text", "")
                    if isinstance(text, str) and text:
                        for m in _HEADER_RE.finditer(text):
                            cand = _norm(m.group(1))
                            if cand:
                                declared.add(cand)
    return edited, declared


def _declared_match(edited_path, declared):
    """True if edited_path is covered by any declared path (path OR basename match)."""
    if edited_path in declared:
        return True
    base = os.path.basename(edited_path)
    for d in declared:
        # Substring handles relative-vs-absolute divergence between the
        # tool_use file_path and the prose-declared path.
        if edited_path in d or d in edited_path:
            return True
        if base and base == os.path.basename(d):
            return True
    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, json.JSONDecodeError):
        emit("skip_silent")
        return

    tpath = payload.get("transcript_path", "") or ""

    # transcript_path absent/unreadable → fail-open silent (advisory cannot run).
    if not tpath or not os.access(tpath, os.R_OK):
        emit("skip_silent")
        return

    try:
        edited, declared = scan_transcript(tpath)
    except (OSError, IOError):
        emit("skip_silent")
        return

    # No edits this turn → nothing to advise on.
    if not edited:
        emit("skip_silent")
        return

    missing = [p for p in sorted(edited) if not _declared_match(p, declared)]
    if not missing:
        emit("all_declared")
        return

    # Report basenames for readability when paths share a prefix; full path
    # would bloat the single advisory line.
    report = ",".join(os.path.basename(p) or p for p in missing)
    emit("missing", files=report)


try:
    main()
except Exception as exc:  # noqa: BLE001 — fail-open, never block on parse bug
    sys.stdout.write(f"@@verdict@@error\n@@reason@@{exc}\n")
PY
)

PIPELINE_OUT=""
PIPELINE_OUT="$(printf '%s' "${INPUT}" | python3 -c "${PIPELINE_PY}" 2>/dev/null)" || PIPELINE_OUT=""

extract_field() {
  printf '%s\n' "${PIPELINE_OUT}" | sed -n "s/^@@${1}@@//p" | head -1
}

VERDICT="$(extract_field verdict)"

case "${VERDICT}" in
  all_declared | skip_silent | "")
    exit 0
    ;;
  missing)
    reported_files="$(extract_field files)"
    printf '[preedit-facts-advisory] ADVISORY: edited without a Pre-Edit Facts declaration: %s (scope-dev.md Pre-Edit Facts Disclosure)\n' "${reported_files}" >&2
    exit 0
    ;;
  error)
    reason="$(extract_field reason)"
    printf '[preedit-facts-advisory] internal error: %s — fail-open (exit 0)\n' "${reason:-unknown}" >&2
    exit 0
    ;;
  *)
    # Unknown verdict — fail-open.
    exit 0
    ;;
esac
