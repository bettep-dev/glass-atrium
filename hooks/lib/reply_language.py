#!/usr/bin/env python3
"""reply_language.py — bounded backward transcript reads, by record structure alone.

`transcript`: the user's newest own message, for the reply-language hooks, which quote its start so the model
judges the reply language; nothing here reads or names a language. Only origin kind `human` is the user's
message, and an entry left whitespace-empty once wrappers, pastes and code are removed has no prose of its own.
`turn`: the current turn's start entry, its time, and the turn's tool calls, for the queue turn-end check.
Contract: `--help`.
"""

import argparse
import json
import os
import re
import sys
from types import SimpleNamespace

# Backward read, window doubled per pass up to the cap — human entry lags ~2.3 MB, transcripts reach ~145 MB
DEFAULT_WINDOW_BYTES = 256 * 1024
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
# Byte needles that admit a line to the JSON parse
MARKER = SimpleNamespace(
    HUMAN=b'"kind":"human"',
    # a turn's start entry, whatever its origin, carries a turnPosition object; tool results, assistant and Stop
    # feedback entries carry none (shared-hook-capability-contract.md → Stop row); a compaction summary carries the
    # position of the turn start it follows
    TURN=b'"turnPosition":{',
    TOOL_USE=b'"tool_use"',
    # a tool result the host marks as an error: the call made nothing (measured on refused queue posts)
    ERROR=b'"is_error":true',
)
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
    find = find_current_turn if args.command == "turn" else find_newest_human_prose
    json.dump(find(args.path, window, cap), sys.stdout)
    sys.stdout.write("\n")
    return 0


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="reply_language.py",
        description="Print one JSON object: status (found|none), bytes_read and truncated, plus "
        "reason=unreadable when the transcript cannot be opened; transcript adds entry (user|queued_command) and "
        "prose, turn adds turn (the turn-start entry's uuid), started (its timestamp), tools (the turn called a tool) "
        "and last_tool (the newest call's name, Bash command and last-act flag, whether its message held no other "
        "call, and how many calls of its name the turn made whose result is no error).",
    )
    commands = parser.add_subparsers(dest="command")
    commands.required = True
    transcript = commands.add_parser("transcript", help="the newest human message with prose of its own")
    transcript.add_argument("path")
    turn = commands.add_parser("turn", help="the current turn's start entry and whether it called a tool")
    turn.add_argument("path")
    return parser


def find_newest_human_prose(path, window, cap):
    """Status `none` with truncated=true means the cap was reached before any human prose."""
    def visit(line, result):
        found = _get_line_prose(line)
        if found:
            result.update(found)
        return bool(found)

    return _scan_backward(path, window, cap, {"status": "none", "entry": None, "prose": None}, visit)


def find_current_turn(path, window, cap):
    """Status `none` with truncated=true means the cap was reached before the turn's start entry.

    A compaction summary is passed over, so tool calls before a mid-turn compaction stay the turn's and the turn keeps
    one id; a transcript that opens on summaries, its turn start left in an earlier file, starts at the oldest."""
    oldest_summary = None
    # (name, message key, call id) per call, newest first; the host writes each call of one message as its own entry
    turn_calls = []
    error_ids = set()

    def visit(line, result):
        nonlocal oldest_summary
        if MARKER.ERROR in line:
            error_ids.update(_get_error_result_ids(_get_json_object(line)))
        call_entry = _get_json_object(line) if MARKER.TOOL_USE in line else {}
        calls = _get_tool_calls(call_entry)
        message_key = _get_message_id(call_entry) or object()
        turn_calls.extend((call.get("name"), message_key, call.get("id")) for call in reversed(calls))
        if calls and not result["tools"]:
            result.update(tools=True, last_tool=_get_tool_call_view(calls[-1]))
        entry = _get_json_object(line) if MARKER.TURN in line else {}
        turn = _get_turn_position_id(entry)
        if turn and entry.get("isCompactSummary") is True:
            oldest_summary, turn = (turn, entry.get("timestamp")), None
        if turn:
            result.update(status="found", turn=turn, started=entry.get("timestamp"))
        return bool(turn)

    initial = {"status": "none", "turn": None, "started": None, "tools": False, "last_tool": None}
    result = _scan_backward(path, window, cap, dict(initial), visit)
    if result["status"] == "none" and oldest_summary and not result["truncated"]:
        result.update(status="found", turn=oldest_summary[0], started=oldest_summary[1])
    if result["status"] == "none":
        result.update(tools=False, last_tool=None)
    elif result["tools"]:
        name, message_key, _ = turn_calls[0]
        result["last_tool"].update(alone=sum(key == message_key for _, key, _ in turn_calls) == 1,
                                   name_calls=sum(other == name and call_id not in error_ids
                                                  for other, _, call_id in turn_calls))
    if not isinstance(result["started"], str):
        result["started"] = None
    return result


def _scan_backward(path, window, cap, result, visit):
    """Lines newest first → `visit(line, result)` until true; adds bytes_read + truncated, reason=unreadable on an
    unreadable transcript."""
    scan = {"bytes_read": 0, "truncated": False}
    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, os.SEEK_END)
            for line in _get_lines_backward(fh, size, window, cap, scan):
                if visit(line, result):
                    break
    except OSError:
        result["reason"] = "unreadable"
    result.update(scan)
    return result


def _get_tool_calls(entry):
    content = _get_message_content(entry) if entry.get("type") == "assistant" else None
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]


def _get_error_result_ids(entry):
    content = _get_message_content(entry) if entry.get("type") == "user" else None
    if not isinstance(content, list):
        return []
    return [b.get("tool_use_id") for b in content
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error") is True]


def _get_tool_call_view(call):
    """{name, command, last_act}: command is the Bash input's command, None for any other call; last_act is whether
    the input flags the call as its turn's last act."""
    name = call.get("name") if isinstance(call.get("name"), str) else None
    tool_input = call.get("input") if isinstance(call.get("input"), dict) else {}
    command = tool_input.get("command") if name == "Bash" else None
    return {"name": name, "command": command if isinstance(command, str) else None,
            "last_act": tool_input.get("lastAct") is True}


def _get_message_id(entry):
    message = entry.get("message")
    message_id = message.get("id") if isinstance(message, dict) else None
    return message_id if isinstance(message_id, str) and message_id else None


def _get_turn_position_id(entry):
    uuid = entry.get("uuid")
    return uuid if isinstance(entry.get("turnPosition"), dict) and isinstance(uuid, str) and uuid else None


def _get_message_content(entry):
    """None when the entry's message is no object."""
    message = entry.get("message")
    return message.get("content") if isinstance(message, dict) else None


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
    if MARKER.HUMAN not in line:
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
        return _get_text_content(_get_message_content(entry)), "user"
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
