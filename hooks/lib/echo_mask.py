#!/usr/bin/env python3
"""echo_mask.py — the echo exception judge of block-dangerous-commands.sh: which echo/printf text only prints?

Reads the command on stdin. Exit 0 → every simple command is a print-only echo/printf or one named in
INERT_COMMANDS, and stdout is the command with each quoted argument of those echo/printf calls blanked, which the
hook re-checks against its rm-wipe row. Exit 1 → any construct the scan cannot classify, so the hook keeps its block.
Any other program could run the echoed text or read it back (shell state, the job table, the shell's own argv),
so a command naming one is never masked: the scan proves where the text goes instead of listing where it must not.
"""

import re
import sys
from types import SimpleNamespace

# run no text and read none of the shell's back; an rm stays judged by the hook's rm-wipe row and Trash judge
INERT_COMMANDS = frozenset({":", "true", "false", "test", "[", "cd", "pwd", "ls", "rm", "mkdir", "touch", "sleep"})
PRINT_COMMANDS = frozenset({"echo", "printf"})
SEPARATORS = SimpleNamespace(PIPE=frozenset({"|", "|&"}), CONTINUING=frozenset({"|", "|&", "&&", "||"}))
PATTERN = SimpleNamespace(
    # read on the raw text, quotes included: a heredoc or here-string, a backtick, any $ but a plain $name / ${name}
    UNPROVABLE=re.compile(r"<<|`|\$(?![A-Za-z]\w*|\{[A-Za-z]\w*\})"),
    # blank | newline | redirect operator | list or pipe operator | word; an unquoted ( ) { } or backslash matches none
    LEXEME=re.compile(
        r"(?P<blank>[ \t]+)|(?P<newline>\n)"
        r"|(?P<redirect>&>>?|\d*(?:>>|>&|>\||<&|<>|>|<))"
        r"|(?P<separator>&&|\|\||\|&|[|;&])"
        r"""|(?P<word>(?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\{\w+\}|[^\s'"\\;&|<>(){}`])+)""",
        re.S,
    ),
    QUOTED=re.compile(r"""'[^']*'|"(?:[^"\\]|\\.)*\""""),
)


def get_masked(command):
    """The command with each quoted argument of a print-only echo/printf blanked; any doubt raises ValueError."""
    spans = []
    for simple in get_commands(get_lexemes(command)):
        name = simple.words[0][0]
        if name in PRINT_COMMANDS and is_print_only(simple):
            spans += get_quoted_spans(simple.words[1:])
        elif name not in INERT_COMMANDS:
            raise ValueError("unclassified command")
    for start, end in reversed(spans):
        command = command[:start] + "''" + command[end:]
    return command


def get_lexemes(command):
    """(kind, text, start) per lexeme, blanks dropped; a multi-line quote, a comment or any unknown character raises."""
    if PATTERN.UNPROVABLE.search(command):
        raise ValueError("unprovable construct")
    lexemes, index = [], 0
    while index < len(command):
        match = PATTERN.LEXEME.match(command, index)
        if not match:
            raise ValueError("unclassifiable character")
        kind, text, index = match.lastgroup, match.group(), match.end()
        if kind == "word" and (text.startswith("#") or "\n" in text):
            raise ValueError("comment or multi-line quote")
        if kind != "blank":
            lexemes.append((kind, text, match.start()))
    return lexemes


def get_commands(lexemes):
    """One SimpleNamespace(words, redirects, is_piped) per simple command; an empty one between operators raises."""
    commands, current, previous = [], [], "\n"
    for lexeme in lexemes + [("newline", "\n", None)]:
        kind, text = lexeme[0], lexeme[1]
        if kind not in ("separator", "newline"):
            current.append(lexeme)
        elif current:
            is_piped = previous in SEPARATORS.PIPE or text in SEPARATORS.PIPE
            commands.append(get_command(current, is_piped))
            current, previous = [], text
        elif kind == "separator":
            raise ValueError("empty command")
    # a newline after | && || continues the list, so one still pending at the end dangles
    if previous in SEPARATORS.CONTINUING:
        raise ValueError("dangling operator")
    return commands


def get_command(lexemes, is_piped):
    """SimpleNamespace(words, redirects, is_piped): words as (text, start), redirects as (operator, target)."""
    words, redirects, index = [], [], 0
    while index < len(lexemes):
        kind, text, start = lexemes[index]
        if kind == "redirect":
            if index + 1 == len(lexemes) or lexemes[index + 1][0] != "word":
                raise ValueError("redirect without a target")
            redirects.append((text, lexemes[index + 1][1]))
            index += 2
            continue
        words.append((text, start))
        index += 1
    if not words:
        raise ValueError("no command word")
    return SimpleNamespace(words=words, redirects=redirects, is_piped=is_piped)


def is_print_only(simple):
    """A whole pipeline of its own, only stdout/stderr copies or /dev/null as redirects, no printf -v (assigns)."""
    if simple.is_piped or not all(is_print_redirect(*redirect) for redirect in simple.redirects):
        return False
    # quotes removed first: printf '-v' c … still assigns; an unquoted backslash never lexes, so \-v cannot reach here
    return simple.words[0][0] == "echo" or not any(
        re.sub(r"['\"]", "", word).startswith("-v") for word, _ in simple.words[1:]
    )


def is_print_redirect(operator, target):
    if re.fullmatch(r"[12]?>&", operator):
        return target in ("1", "2")
    return bool(re.fullmatch(r"\d*>|&>", operator)) and target == "/dev/null"


def get_quoted_spans(words):
    """(start, end) of every quoted piece of the words, in text order."""
    return [
        (start + match.start(), start + match.end())
        for word, start in words
        for match in PATTERN.QUOTED.finditer(word)
    ]


def main():
    try:
        sys.stdout.write(get_masked(sys.stdin.read()))
    except ValueError:  # every scan doubt keeps the hook's block
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
