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

# An explicit reply-language request is a request clause about the reply (영어로 답해줘 · 답변은 영어로 해줘 ·
# 英語で答えて · reply in English); a language only named — participle, permission, an artifact's language, a quoted
# clause, a question, a complaint, a statement, a prohibition — is none. Precision first: a missed request costs one
# continuation, a false one silences the turn's check, so an ending that also reads as a statement counts as none.
LANGUAGE_NAMES = {
    "English": ("English", "영어", "영문", "英語", "英文", "英语"),
    "Korean": ("Korean", "한국어", "한글", "韓国語", "韓語", "韩语"),
    "Japanese": ("Japanese", "일본어", "日本語", "日语"),
    "Chinese": ("Chinese", "중국어", "中国語", "中文"),
}


def _build_korean_forms():
    """A reply verb in request mood, or a generic verb (write, explain, do) only after a reply-noun topic.

    The bare 해체/해요체 ending (답해 · 답해요) is also a statement (또 영어로 답해 · 클로드가 영어로 답해), so it
    counts as none; a request followed by a quotative (답해줘 라고) is cited, never made.
    """
    tail = r"(?:\s*(?:줘요?|줄래요?|주(?:세요|실래요|십시오|시겠어요|라)|봐요?)|라)(?![가-힣])"
    hada = (
        "(?:해" + tail + r"|해야\s*(?:해요?|지|돼요?|합니다|한다)(?![가-힣])|하(?:자|세요|십시오|시오|라(?:니까)?)(?![가-힣])"
        r"|합시다)"
    )
    language = r"(?:{names})\s*으?로\s*(?:만\s*)?"
    reply_noun = (
        r"(?:^|[\s,.!?])(?:답변|대답|응답|답|결과|보고|요약|설명|리포트)(?:은|는|을|를|도|만|이|가)?\s+"
        r"(?:(?:앞으로|이제|전부|모두|다|꼭|반드시|항상|계속|좀)\s+)?"
    )
    quotative = r"(?!\s*(?:이?라(?:고|는|며|면|니)|이?란|하고|하는|하면|하니|같은|처럼))"
    return (
        language + r"(?:답|대답|응답|답변|회신|말|얘기|이야기|대화|소통|보고)(?:" + hada + r"|\s*부탁)" + quotative,
        reply_noun + language + "(?:(?:작성|설명|정리|요약|진행)?" + hada + "|(?:써|적어)" + tail + ")" + quotative,
    )


def _build_japanese_forms():
    """A bare て is also a connective (答えて、困る) and a bare くれる a statement, so each asks only at a sentence end."""
    boundary = r"(?=$|[\s。、！？!?.,」』)])"
    tail = (
        r"(?:(?:て(?:ください|下さい|くれ(?:(?:る|ます)か)?|ほしい|欲しい|ね|よ)|なさい|ましょう|ろ)" + boundary
        + r"|てくれ(?:る|ます)(?=\s*[?？])|て(?=\s*(?:$|[。！？!?.])))"
    )
    language = r"(?:{names})\s*で\s*(?:のみ\s*|だけ\s*)?"
    return (
        language + "(?:答え|回答し|返答し|返信し|応答し|返事し|話し|喋っ|しゃべっ|報告し|会話し)" + tail,
        r"(?:回答|返事|返答|答え|結果|報告|要約|説明)(?:は|を|も)\s*" + language + "(?:書い|説明し|まとめ|要約し|し)" + tail,
    )


def _build_english_forms():
    """A reply verb opening its own clause; `could you` opens one so the request-question stays in the match."""
    opener = (
        r"(?:^|[.!?;:,\n]\s*|[^\x00-\x7f]\s*"
        r"|\b(?:(?:can|could|would|will)\s+you|please|pls|plz|kindly|just|now|and|then|also|so|you)\s+)"
    )
    closer = (
        r"(?![A-Za-z])(?=\s*(?:$|[.!?,;:)\n]|(?:please|pls|plz|thanks?|thank\s+you|from\s+now\s+on|only|instead|too"
        r"|as\s+well)\b|(?:해|하)(?:\s*(?:줘요?|주세요)|요|자|세요)?(?![가-힣])))"
    )
    return (
        opener
        + r"(?:(?:reply|respond|answer|speak|talk|communicate|chat|write\s+back)\s+(?:(?:to\s+me|back|only)\s+)?"
        r"in\s+(?:{names})|(?:write|give|keep|send|put)\s+(?:(?:the|your|this|that|all|a|an|my)\s+)?"
        r"(?:answers?|repl(?:y|ies)|responses?|reports?|summar(?:y|ies))\s+in\s+(?:{names})"
        r"|(?:switch|change)\s+(?:back\s+)?to\s+(?:{names}))" + closer,
    )


def _build_chinese_forms():
    """Chinese marks no imperative on the verb (你又用英文回答 · 你用英文回答吗), so only a polite marker makes a request."""
    return (
        r"(?:(?<![申邀聘])请(?!问)|麻烦(?:你们?|您)|拜托|劳驾)(?:你们?|您)?(?:以后|今后|之后|接下来|下次|从现在(?:开始|起))?"
        r"(?:都|也|一直|总是|务必|一定|只)?用\s*(?:{names})\s*(?:来\s*)?(?:回答|回复|答复|说|讲|交流|沟通|聊|汇报)(?![的了过着])",
    )


def _build_language_requests():
    forms = _build_korean_forms() + _build_japanese_forms() + _build_chinese_forms() + _build_english_forms()
    return tuple(
        (language, re.compile("|".join(form.replace("{names}", "|".join(names)) for form in forms), re.I))
        for language, names in LANGUAGE_NAMES.items()
    )


_LANGUAGE_REQUESTS = _build_language_requests()
# A request clause only quoted is cited, never made; get_prose already drops `code spans`.
_QUOTATION = re.compile(
    r"\"[^\"\n]*\"|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』"
    r"|《[^》\n]*》|〈[^〉\n]*〉|«[^»\n]*»|＂[^＂\n]*＂|＇[^＇\n]*＇"
)
_SENTENCE_END = re.compile(r"[!?\n。！？]|\.(?=\s|$)")  # a dot inside a path or version ends none
# A why-question or a keeps-doing complaint anywhere in the request's sentence.
_COMPLAINT = re.compile(r"왜|자꾸|어째서|为什么|为何|怎么|干[嘛吗]|なぜ|どうして|なんで|何で|\bwhy\b|\bhow\s+come\b", re.I)
# A Chinese negator before the polite marker (不必麻烦您用英文回答); any other prohibition matches no form.
_PROHIBITION = re.compile(r"(?:不要|不用|不许|不准|不能|不必|别|勿|莫|禁止)[^,，、;；]*$")
# The one question that still asks: a benefactive request (답해 줄래? · 答えてくれる? · could you reply ...?).
_BENEFACTIVE = re.compile(
    r"줘|줄래|주(?:세요|실래|시겠|십시오)|くれ|ください|下さい|ほしい|欲しい|\b(?:can|could|would|will)\s+you\b", re.I
)

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
    window = _get_env_bytes("REPLY_LANG_WINDOW_BYTES", DEFAULT_WINDOW_BYTES)
    cap = _get_env_bytes("REPLY_LANG_MAX_BYTES", DEFAULT_MAX_BYTES)
    if args.command == "transcript":
        result = find_newest_human_prose(args.path, window, cap)
    elif args.command == "reply":
        text = find_last_reply(args.transcript, window, cap) if args.transcript else _read_stdin()
        result = get_script_decision(get_prose(text))
    else:
        result = get_text_result(_read_stdin())
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
        "transcript",
        help="newest human prose of a transcript; adds entry, requested_language, bytes_read, truncated",
    )
    transcript.add_argument("path")
    reply = commands.add_parser(
        "reply", help="a final reply on stdin, or with --transcript the transcript's tail assistant message; no status"
    )
    reply.add_argument("--transcript")
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
    decision.update(
        status="resolved",
        entry=entry_kind,
        requested_language=get_requested_language(_get_prose_lines(text or "")),
        prose=prose[:PROSE_EXCERPT_CHARS],
    )
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


def get_requested_language(prose):
    """The language an explicit reply-language request names; the latest request in the prose wins."""
    text = _QUOTATION.sub(" ", prose)
    latest, requested = -1, None
    for language, pattern in _LANGUAGE_REQUESTS:
        for match in pattern.finditer(text):
            if match.start() > latest and _is_request_mood(text, match):
                latest, requested = match.start(), language
    return requested


def _is_request_mood(text, match):
    """False for a request asked about, complained of or prohibited; a question counts only when benefactive."""
    start = max((end.end() for end in _SENTENCE_END.finditer(text, 0, match.end())), default=0)
    end = _SENTENCE_END.search(text, match.end())
    lead = text[start : match.end()]
    rest = text[match.end() : end.end() if end else len(text)]
    if _COMPLAINT.search(lead + rest) or _PROHIBITION.search(lead):
        return False
    return not (end and end.group() in "?？") or bool(_BENEFACTIVE.search(match.group()))


def find_last_reply(path, window, cap):
    """Text of the transcript's tail message; empty when unreadable or when the tail is no assistant message."""
    try:
        with open(path, "rb") as fh:
            size = fh.seek(0, os.SEEK_END)
            lines = _get_lines_backward(fh, size, window, cap, {"bytes_read": 0, "truncated": False})
            return "\n".join(reversed(_get_last_message_texts(lines)))
    except OSError:
        return ""


def _get_last_message_texts(lines):
    """Newest first: the transcript splits one message's content blocks over entries sharing its id.

    A user entry at the tail (a tool result, the prompt) means the final message is not recorded, so an
    earlier message's narration is never judged in its place.
    """
    texts, found, message_id = [], False, None
    for line in lines:
        entry = _get_json_object(line)
        message = entry.get("message") if isinstance(entry.get("message"), dict) else {}
        if entry.get("type") == "user":
            break
        if entry.get("type") == "assistant":
            if found and message.get("id") != message_id:
                break
            found, message_id = True, message.get("id")
            texts.append(_get_text_content(message.get("content")))
    return texts


def _get_json_object(line):
    try:
        entry = json.loads(line)
    except ValueError:
        return {}
    return entry if isinstance(entry, dict) else {}


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
    return " ".join(_strip_non_prose(text).split())


def _get_prose_lines(text):
    """get_prose per line: a line break stays a sentence end for request detection."""
    return "\n".join(" ".join(line.split()) for line in _strip_non_prose(text).splitlines())


def _strip_non_prose(text):
    for pattern in _NON_PROSE:
        text = pattern.sub(" ", text)
    return text


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


def _read_stdin():
    return sys.stdin.buffer.read().decode("utf-8", "replace")


def _get_env_bytes(name, default):
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


if __name__ == "__main__":
    sys.exit(main())
