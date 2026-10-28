#!/usr/bin/env python3
"""trash_rm.py — the rm-wipe exception judge of block-dangerous-commands.sh: does every rm in a command delete only home-Trash entries?

Reads the command on stdin. Exit 0 → every rm invocation sits at a command position and each of its operands
is one named entry directly in the home Trash; stdout is the command with those invocations removed, which the
hook re-checks against its rm-wipe row. Exit 1 → any doubt, so the hook keeps its block.
"""

import os
import re
import sys
from types import SimpleNamespace

CHARS = SimpleNamespace(
    OPERATOR=frozenset("();<>|&\n"),
    # bash and zsh pattern characters, the zsh extended-glob ones included
    GLOB=frozenset("*?[]{}^#~"),
    EXPANSION=frozenset("$`{}"),
    BLANK=frozenset(" \t\n"),
)
PATTERN = SimpleNamespace(
    # substitution, subshell, an IFS change, any HOME text but a plain $HOME / ${HOME} read
    UNREADABLE=re.compile(r"[`()]|IFS|(?<!\$)(?<!\$\{)HOME|\$\{HOME(?!\})"),
    # blank run | operator run | word; a backslash inside double quotes has no word form → doubt
    LEXEME=re.compile(r"""[ \t\r]+|[();<>|&\n]+|(?:'[^']*'|"[^"\\]*"|\\.|[^\s'"\\();<>|&])+""", re.S),
    # one piece of a word, its group number picking the quoting kind in PIECE_KINDS
    PIECE=re.compile(r"""'([^']*)'|"([^"]*)"|\\(.)|([^'"\\]+)""", re.S),
)
# s(ingle-quoted) d(ouble-quoted) e(scaped) u(nquoted), in PATTERN.PIECE group order
PIECE_KINDS = "sdeu"


def get_words(command):
    """(text, kinds) per shell word and operator run; kinds holds one PIECE_KINDS letter per text character."""
    if PATTERN.UNREADABLE.search(command):
        raise ValueError("unreadable construct")
    words, index = [], 0
    while index < len(command):
        match = PATTERN.LEXEME.match(command, index)
        if not match:
            raise ValueError("unbalanced quote or unknown character")
        lexeme, index = match.group(), match.end()
        if lexeme[0] in " \t\r":
            continue
        is_operator_run = set(lexeme) <= CHARS.OPERATOR
        words.append((lexeme, "u" * len(lexeme)) if is_operator_run else get_dequoted(lexeme))
    return words


def get_dequoted(lexeme):
    """The word's text and kinds; an operator character inside quotes or escaped raises."""
    text, kinds = "", ""
    for match in PATTERN.PIECE.finditer(lexeme):
        piece, kind = match.group(match.lastindex), PIECE_KINDS[match.lastindex - 1]
        if kind != "u" and CHARS.OPERATOR & set(piece):
            raise ValueError("quoted operator")
        text, kinds = text + piece, kinds + kind * len(piece)
    return text, kinds


def get_trash_prefixes():
    """(prefix, head length, quoting kinds the head may carry) per accepted spelling of the home Trash."""
    home = os.environ.get("HOME", "").rstrip("/")
    # no absolute HOME, or one that splits or globs once expanded → no spelling is safe
    if not home.startswith("/") or (CHARS.GLOB | CHARS.BLANK) & set(home):
        return []
    return [("~/.Trash/", 2, "u"), ("$HOME/.Trash/", 5, "ud"), ("${HOME}/.Trash/", 7, "ud"), (home + "/.Trash/", 0, "")]


def is_operator(word):
    return word != "" and set(word) <= CHARS.OPERATOR


def is_redirect(word):
    return is_operator(word) and bool(set(word) & set("<>"))


def is_control(word):
    return is_operator(word) and not is_redirect(word)


def is_trash_entry(word, prefixes):
    """One literal name directly under the Trash, its expanding head in one quoting kind the shell expands."""
    text, kinds = word
    for prefix, head_length, head_kinds in prefixes:
        head = set(kinds[:head_length])
        if text.startswith(prefix) and len(head) <= 1 and head <= set(head_kinds):
            name = text[len(prefix):]
            return name not in ("", ".", "..") and not (CHARS.GLOB | CHARS.EXPANSION | {"/"}) & set(name)
    return False


def get_rm_end(words, index, prefixes):
    """Index past one rm invocation whose operands are all Trash entries; any other operand raises."""
    target_count, is_option = 0, True
    while index < len(words) and not is_control(words[index][0]):
        word = words[index][0]
        if is_redirect(word) and "<" not in word:  # zsh reads <-> and <1-9> as a numeric glob → an operand
            index += 2
            continue
        if word.isdigit() and index + 1 < len(words) and is_redirect(words[index + 1][0]):
            pass
        elif is_option and word == "--":
            is_option = False
        elif is_option and word.startswith("-") and word != "-":
            pass
        elif is_trash_entry(words[index], prefixes):
            target_count, is_option = target_count + 1, False
        else:
            raise ValueError("operand outside the Trash")
        index += 1
    if not target_count:
        raise ValueError("rm without an operand")
    return index


def get_residual(words, prefixes):
    """The words outside the rm invocations; an rm off a command position (xargs, sudo, env) raises."""
    residual, index, is_command_start = [], 0, True
    while index < len(words):
        word = words[index][0]
        if os.path.basename(word) == "rm":
            if not is_command_start:
                raise ValueError("rm off a command position")
            index = get_rm_end(words, index + 1, prefixes)
            continue
        residual.append(word)
        is_command_start = is_control(word)
        index += 1
    return residual


def main():
    try:
        words = get_words(sys.stdin.read())
        if not any(os.path.basename(text) == "rm" for text, _ in words):
            return 1
        sys.stdout.write(" ".join(get_residual(words, get_trash_prefixes())))
    except Exception:  # every parse doubt, a malformed quote included, keeps the hook's block
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
