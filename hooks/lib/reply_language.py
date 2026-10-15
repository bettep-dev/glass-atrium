#!/usr/bin/env python3
"""reply_language.py — the user's newest own message in a transcript, found by record structure alone.

Shared by the reply-language hooks, which quote its start so the model judges the reply language; nothing
here reads or names a language. Only origin kind `human` is the user's message, and an entry left
whitespace-empty once wrappers, pastes and code are removed has no prose of its own. Contract: `--help`.
"""

import argparse
import json
import os
import re
import sys

# Backward read, window doubled per pass up to the cap — human entry lags ~2.3 MB, transcripts reach ~145 MB
DEFAULT_WINDOW_BYTES = 256 * 1024
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
HUMAN_MARKER = b'"kind":"human"'
# Bounds the output only; the hook cleans and caps the quote the model sees.
PROSE_EXCERPT_CHARS = 500

_NON_PROSE = (
    re.compile(r"<(pasted_content|command-message|command-name)\b[^>]*>.*?</\1[^>]*>", re.S),
    re.compile(r"```.*?(?:```|\Z)", re.S),
    re.compile(r"`[^`\n]*`"),
    re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+"),
    re.compile(r"</?[A-Za-z][\w:.-]*(?:\s[^<>]*)?>"),
)


def main(argv=None):
    args = _build_parser().parse_args(argv)
    window = _get_env_bytes("REPLY_LANG_WINDOW_BYTES", DEFAULT_WINDOW_BYTES)
    cap = _get_env_bytes("REPLY_LANG_MAX_BYTES", DEFAULT_MAX_BYTES)
    json.dump(find_newest_human_prose(args.path, window, cap), sys.stdout)
    sys.stdout.write("\n")
    return 0


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="reply_language.py",
        description="Print one JSON object: status (found|none), entry (user|queued_command), prose, "
        "bytes_read and truncated, plus reason=unreadable when the transcript cannot be opened.",
    )
    commands = parser.add_subparsers(dest="command")
    commands.required = True
    transcript = commands.add_parser("transcript", help="the newest human message with prose of its own")
    transcript.add_argument("path")
    return parser


def find_newest_human_prose(path, window, cap):
    """Status `none` with truncated=true means the cap was reached before any human prose."""
    result = {"status": "none", "entry": None, "prose": None}
    scan = {"bytes_read": 0, "truncated": False}
    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, os.SEEK_END)
            for line in _get_lines_backward(fh, size, window, cap, scan):
                found = _get_line_prose(line)
                if found:
                    result = found
                    break
    except OSError:
        result["reason"] = "unreadable"
    result.update(scan)
    return result


def _get_lines_backward(fh, size, window, cap, scan):
    pos, carry = size, b""
    while pos > 0 and scan["bytes_read"] < cap:
        step = min(window, pos, cap - scan["bytes_read"])
        pos -= step
        fh.seek(pos)
        lines = (fh.read(step) + carry).split(b"\n")
        scan["bytes_read"] += step
        carry = lines[0]  # partial until the read reaches byte 0
        for line in reversed(lines[1:]):
            yield line
        window *= 2
    scan["truncated"] = pos > 0
    if pos == 0:
        yield carry


def _get_line_prose(line):
    if HUMAN_MARKER not in line:
        return None
    text, entry_kind = _get_human_text(_get_json_object(line))
    return _get_text_prose(text, entry_kind)


def _get_text_prose(text, entry_kind):
    prose = " ".join(_strip_non_prose(text or "").split())
    if not prose:  # no prose of its own (bare paste, argless command)
        return None
    return {"status": "found", "entry": entry_kind, "prose": prose[:PROSE_EXCERPT_CHARS]}


def _get_human_text(entry):
    """Human prose sits on user entries and, for prompts queued mid-turn, on the attachment."""
    if entry.get("type") == "user" and _get_origin_kind(entry) == "human":
        return _get_text_content(entry.get("message", {}).get("content")), "user"
    attachment = entry.get("attachment")
    if (
        entry.get("type") == "attachment"
        and isinstance(attachment, dict)
        and attachment.get("type") == "queued_command"
        and _get_origin_kind(attachment) == "human"
    ):
        return _get_text_content(attachment.get("prompt")), "queued_command"
    return None, None


def _get_origin_kind(holder):
    origin = holder.get("origin")
    return origin.get("kind") if isinstance(origin, dict) else None


def _get_text_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(block.get("text", "")) for block in content if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def _get_json_object(line):
    try:
        entry = json.loads(line)
    except ValueError:
        return {}
    return entry if isinstance(entry, dict) else {}


def _strip_non_prose(text):
    for pattern in _NON_PROSE:
        text = pattern.sub(" ", text)
    return text


def _get_env_bytes(name, default):
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


if __name__ == "__main__":
    sys.exit(main())
