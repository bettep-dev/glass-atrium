#!/usr/bin/env python3
"""reply_language.py — the reply language, resolved from the user's newest own prose.

Shared by the session-start, per-prompt and turn-end reply-language hooks. Only origin kind
`human` is the user's prose: compaction summaries, task notifications, peer, channel and headless
(sdk-cli) entries never set the language. Output contract: `reply_language.py --help`.
"""

import argparse
import json
import math
import os
import re
import sys

# Backward read, first window doubled per pass, never past the cap: the newest human entry trails a
# compaction or task-notification burst by up to ~2.3 MB on measured transcripts, and a transcript
# can reach ~145 MB, so a whole read is never an option on the per-turn path.
DEFAULT_WINDOW_BYTES = 256 * 1024
DEFAULT_MAX_BYTES = 8 * 1024 * 1024
HUMAN_MARKER = b'"kind":"human"'
PROSE_EXCERPT_CHARS = 500

# High enough that English quoting one Hangul literal stays Latin, low enough that Korean prose dense
# with English terms stays Korean.
NON_LATIN_MIN_SHARE = 1.0 / 3.0

# Scripts shared by several languages (Latin, Cyrillic, Arabic, Devanagari) name none.
LANGUAGE_BY_SCRIPT = {
    "hangul": "Korean",
    "kana": "Japanese",
    "han": "Chinese",
    "thai": "Thai",
    "greek": "Greek",
    "hebrew": "Hebrew",
}

# UserPromptSubmit carries no `source` field on the installed CLI, so a prompt's own opening is the
# primary machine-written signal; prefixes taken from real transcripts.
MACHINE_SHAPES = (
    ("task-notification", ("<task-notification>",)),
    ("peer", ("<cross-session-message", "<teammate-message", "Another Claude session sent a message")),
    ("channel", ("<channel ",)),
)

# One unit per word run; kana, han and thai write no word spaces, so they count one unit per 2 chars.
_WORD_SCRIPTS = {
    "hangul": re.compile("[ᄀ-ᇿ㄰-㆏가-힣]+"),
    "cyrillic": re.compile("[Ѐ-ӿ]+"),
    "greek": re.compile("[Ͱ-Ͽ]+"),
    "hebrew": re.compile("[֐-׿]+"),
    "arabic": re.compile("[؀-ۿ]+"),
    "devanagari": re.compile("[ऀ-ॿ]+"),
}
_KANA = re.compile("[぀-ヿㇰ-ㇿｦ-ﾟ]")
_HAN = re.compile("[㐀-䶿一-鿿]")
_THAI = re.compile("[฀-๿]")
_LATIN_RUN = re.compile("[A-Za-z0-9À-ɏ_$./\\\\:@#=+'-]+")
_LATIN_LETTER = re.compile("[A-Za-zÀ-ɏ]")
# Identifier-shaped tokens (paths, snake/kebab/camel case, versions) are code, not prose.
_IDENTIFIER_MARK = re.compile(r"[0-9_$/\\.:@#=+]|[a-z][A-Z]|[A-Za-z]-[A-Za-z]")

_NON_PROSE = (
    re.compile(r"<(pasted_content|command-message|command-name)\b[^>]*>.*?</\1[^>]*>", re.S),
    re.compile(r"```.*?(?:```|\Z)", re.S),
    re.compile(r"`[^`\n]*`"),
    re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+"),
    re.compile(r"</?[A-Za-z][\w:.-]*(?:\s[^<>]*)?>"),
)


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "transcript":
        result = find_newest_human_prose(
            args.path,
            _get_env_bytes("REPLY_LANG_WINDOW_BYTES", DEFAULT_WINDOW_BYTES),
            _get_env_bytes("REPLY_LANG_MAX_BYTES", DEFAULT_MAX_BYTES),
        )
    else:
        result = get_text_result(sys.stdin.buffer.read().decode("utf-8", "replace"))
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="reply_language.py",
        description="Print one JSON object: status (resolved|none|machine), script, language "
        "(null when the script names no single language), units, share and prose.",
    )
    commands = parser.add_subparsers(dest="command")
    commands.required = True
    transcript = commands.add_parser(
        "transcript", help="newest human prose of a transcript; adds entry, bytes_read, truncated"
    )
    transcript.add_argument("path")
    commands.add_parser("text", help="one prompt or reply on stdin; adds machine_shape")
    return parser


def find_newest_human_prose(path, window, cap):
    """Status `none` with truncated=true means the cap was reached before any human prose."""
    result = {"status": "none", "script": None, "language": None, "entry": None}
    scan = {"bytes_read": 0, "truncated": False}
    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, os.SEEK_END)
            for line in _get_lines_backward(fh, size, window, cap, scan):
                decision = _get_line_decision(line)
                if decision:
                    result = decision
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


def _get_line_decision(line):
    if HUMAN_MARKER not in line:
        return None
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    text, entry_kind = _get_human_text(entry) if isinstance(entry, dict) else (None, None)
    prose = get_prose(text or "")
    decision = get_script_decision(prose)
    if decision["script"] is None:  # no prose of its own (bare paste, argless command)
        return None
    decision.update(status="resolved", entry=entry_kind, prose=prose[:PROSE_EXCERPT_CHARS])
    return decision


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


def get_text_result(text):
    """A machine-shaped prompt gets no script decision: callers must resolve it from the transcript."""
    shape = get_machine_shape(text)
    if shape:
        return {"status": "machine", "machine_shape": shape, "script": None, "language": None}
    prose = get_prose(text)
    decision = get_script_decision(prose)
    decision.update(
        status="resolved" if decision["script"] else "none",
        machine_shape=None,
        prose=prose[:PROSE_EXCERPT_CHARS],
    )
    return decision


def get_machine_shape(text):
    head = text.lstrip()
    for shape, prefixes in MACHINE_SHAPES:
        if head.startswith(prefixes):
            return shape
    return None


def get_prose(text):
    for pattern in _NON_PROSE:
        text = pattern.sub(" ", text)
    return " ".join(text.split())


def get_script_decision(prose):
    units = _get_units(prose)
    latin = units["latin"]
    others = dict((script, count) for script, count in units.items() if script != "latin" and count)
    script, share = None, 0.0
    if others:
        best = max(others, key=others.get)
        share = others[best] / float(others[best] + latin)
        script = best if share >= NON_LATIN_MIN_SHARE else None
    if script is None and latin:
        script, share = "latin", latin / float(latin + sum(others.values()))
    return {"script": script, "language": LANGUAGE_BY_SCRIPT.get(script), "units": units, "share": round(share, 3)}


def _get_units(prose):
    units = {"latin": _get_latin_units(prose)}
    for script, pattern in _WORD_SCRIPTS.items():
        units[script] = len(pattern.findall(prose))
    kana, han, thai = (len(pattern.findall(prose)) for pattern in (_KANA, _HAN, _THAI))
    units["kana"] = int(math.ceil((kana + han) / 2.0)) if kana else 0
    units["han"] = 0 if kana else int(math.ceil(han / 2.0))
    units["thai"] = int(math.ceil(thai / 2.0))
    return units


def _get_latin_units(prose):
    count = 0
    for run in _LATIN_RUN.findall(prose):
        word = run.strip(".:'-")
        if not _LATIN_LETTER.search(word) or _IDENTIFIER_MARK.search(word):
            continue
        if len(word) > 1 and word.isupper():  # acronyms (PR, CI) carry no language
            continue
        count += 1
    return count


def _get_env_bytes(name, default):
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


if __name__ == "__main__":
    sys.exit(main())
