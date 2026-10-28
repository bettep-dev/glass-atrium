#!/usr/bin/env python3
"""trash_rm.py — the rm-wipe exception judge of block-dangerous-commands.sh: does every rm in a command delete only home-Trash entries?

Reads the command on stdin. Exit 0 → every rm invocation sits at a command position and each of its operands
is an entry strictly inside the home Trash; stdout is the command with those invocations removed, which the
hook re-checks against its rm-wipe row. Exit 1 → any doubt, so the hook keeps its block.
"""

import os
import re
import shlex
import sys

OPERATOR_CHARS = "();<>|&\n"
# Quoted regions and backslash escapes, scanned left to right from unquoted context
QUOTED = re.compile(r"""'[^']*'|"(?:[^"\\]|\\.)*"|\\.""", re.S)
# Substitution, subshell and HOME reassignment → the operands cannot be read from the text
UNREADABLE = ("`", "(", ")", "HOME=")
GLOB_CHARS = set("*?[]{}")
EXPANSION_CHARS = set("$`{}")


def get_words(command):
    """Shell words and operator runs; an operator character inside quotes or escaped raises."""
    if any(marker in command for marker in UNREADABLE):
        raise ValueError("unreadable construct")
    if any(set(OPERATOR_CHARS) & set(match.group()) for match in QUOTED.finditer(command)):
        raise ValueError("quoted operator")
    lexer = shlex.shlex(command, posix=True, punctuation_chars=OPERATOR_CHARS)
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def get_trash_prefixes():
    prefixes = ["~/.Trash/", "$HOME/.Trash/", "${HOME}/.Trash/"]
    home = os.environ.get("HOME", "").rstrip("/")
    if home.startswith("/"):
        prefixes.append(home + "/.Trash/")
    return prefixes


def is_operator(word):
    return word != "" and set(word) <= set(OPERATOR_CHARS)


def is_redirect(word):
    return is_operator(word) and bool(set(word) & set("<>"))


def is_control(word):
    return is_operator(word) and not is_redirect(word)


def is_trash_entry(target, prefixes):
    """A literal first segment under the Trash, no dot-dot segment, no expansion left in the path."""
    rest = next((target[len(prefix):] for prefix in prefixes if target.startswith(prefix)), "")
    segments = rest.split("/")
    if segments[0] in ("", ".", "..") or GLOB_CHARS & set(segments[0]):
        return False
    return ".." not in segments and not EXPANSION_CHARS & set(rest)


def skip_rm(words, index, prefixes):
    """Index past one rm invocation whose operands are all Trash entries; any other operand raises."""
    target_count, is_option = 0, True
    while index < len(words) and not is_control(words[index]):
        word = words[index]
        if is_redirect(word):
            index += 2
            continue
        if word.isdigit() and index + 1 < len(words) and is_redirect(words[index + 1]):
            pass
        elif is_option and word == "--":
            is_option = False
        elif is_option and word.startswith("-") and word != "-":
            pass
        elif is_trash_entry(word, prefixes):
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
        word = words[index]
        if os.path.basename(word) == "rm":
            if not is_command_start:
                raise ValueError("rm off a command position")
            index = skip_rm(words, index + 1, prefixes)
            continue
        residual.append(word)
        is_command_start = is_control(word)
        index += 1
    return residual


def main():
    try:
        words = get_words(sys.stdin.read())
        if not any(os.path.basename(word) == "rm" for word in words):
            return 1
        sys.stdout.write(" ".join(get_residual(words, get_trash_prefixes())))
    except Exception:  # every parse doubt, a malformed quote included, keeps the hook's block
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
