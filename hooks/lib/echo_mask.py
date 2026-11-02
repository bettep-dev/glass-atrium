#!/usr/bin/env python3
"""echo_mask.py — the echo exception judge of block-dangerous-commands.sh, command on stdin.
Exit 0 → stdout = the command with print-only echo/printf text blanked; exit 1 → unclassified, the hook keeps its block.
An allowlist: any program outside COMMANDS could run the echoed text or read it back (shell state, jobs, argv).
"""

import re
import sys
from types import SimpleNamespace

COMMANDS = SimpleNamespace(
    # run no text and read none of the shell's back; an rm stays judged by the hook's rm-wipe row and Trash judge
    INERT=frozenset({":", "true", "false", "test", "[", "cd", "pwd", "ls", "rm", "mkdir", "touch", "sleep"}),
    PRINT=frozenset({"echo", "printf"}),
)
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
    for statement in get_commands(get_lexemes(command)):
        name = statement.words[0][0]
        if name in COMMANDS.PRINT and is_print_only(statement):
            spans += get_quoted_spans(statement.words[1:])
        elif name not in COMMANDS.INERT or has_expansion(statement):
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


def is_print_only(command):
    """A whole pipeline of its own, only stdout/stderr copies or /dev/null as redirects, no printf -v (assigns)."""
    if command.is_piped or not all(is_print_redirect(*redirect) for redirect in command.redirects):
        return False
    words = command.words
    return words[0][0] == "echo" or len(words) == 1 or not can_be_option(words[1][0])


def can_be_option(word):
    """Could this first printf argument reach printf as an option? A glob or a $ can become one at run time."""
    quoted = [match.group() for match in PATTERN.QUOTED.finditer(word)]
    if re.search(r"[$*?\[]", PATTERN.QUOTED.sub("", word)) or any(q[0] == '"' and "$" in q for q in quoted):
        return True
    # quotes removed first: printf '-v' c … still assigns; `--` ends the options
    bare = re.sub(r"['\"]", "", word)
    return bare.startswith("-") and bare != "--"


def has_expansion(command):
    """Any $name: on an inert command one can take the blanked text back, as BASH_EXECUTION_STRING does."""
    texts = [word for word, _ in command.words] + [target for _, target in command.redirects]
    return any("$" in text for text in texts)


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
