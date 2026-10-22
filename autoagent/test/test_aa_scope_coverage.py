"""A/A fingerprint scope: every writer and reader on the A/A evidence path is in ``AA.SCOPE``.

Two rows over the git-tracked tree keep ``AA.SCOPE`` a closed list without resolving anything at
fingerprint time. The roots row finds every writer of a table an A/A criterion reads; the closure
row walks the source, import and run edges from the evidence path. A data file a seed reads is no
edge: repo data reaches a criterion input only through agent behaviour, and the live canary dir has
no manifest hash, held instead by its scoped writer and the scoped critical-file guard.
No database, no install.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_aa_scope_coverage.py -v
    python3 -m unittest autoagent.test.test_aa_scope_coverage -v
"""

from __future__ import annotations

import ast
import functools
import posixpath
import re
import subprocess
import sys
import unittest
from collections.abc import Iterator
from pathlib import Path
from typing import NamedTuple

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

for _anchor in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent", _REPO_ROOT / "autoagent" / "lib"):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import daemon_cycle as dc  # noqa: E402 — autoagent dir pinned above

_HOME = "~"
_INSTALL_PREFIXES = ("~/.glass-atrium/", "~/.claude/")
_CODE_SUFFIXES = (".py", ".sh", ".bash", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx")
_TABLE_REF = re.compile(r'\bcore"?\."?([a-z_]+)\b')
_WRITE_VERB = r"(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY|MERGE\s+INTO)"
_MIGRATION = re.compile(r"monitor/prisma/migrations/[^/]+/migration\.sql")

# table → its writer chain: the write site, its allowlist writer, the caller handing it rows
_ROOTS = {
    "spawn_manifest": (
        "hooks/inject-scope-rules.sh",
        "scripts/_pg_dual_write_daemon.py",
        "autoagent/daemon_cycle.py",
    ),
    "agent_events": ("hooks/agent-tracker.sh", "hooks/_pg_dual_write.py", "hooks/_pg-write.py"),
    "budget_overages": ("hooks/advisory-subagent-budget.sh", "hooks/_pg-write.py"),
    "outcomes": ("hooks/track-outcome.sh", "hooks/_pg_outcome_dualwrite.py"),
    "autoagent_loop_events": ("scripts/_pg_dual_write_daemon.py",),
    "autoagent_trial_ledger": ("autoagent/daemon_cycle.py", "scripts/_pg_dual_write_daemon.py"),
}
# a writer touching only columns no criterion reads stays unscoped, pinned to those columns
_COLUMN_ONLY_WRITERS = {
    "monitor/src/server/routes/outcomes.ts": {"outcomes": frozenset({"closed_at"})},
}
# the A/A read and evaluate path: the daemon, the cycle entry that runs it, the named evidence files
_READERS = (
    "autoagent/daemon_cycle.py",
    "autoagent/daemon-cycle.sh",
    "hooks/inject-scope-rules.sh",
    "hooks/hook-utils.sh",
    "hooks/enforce-harness-critical.sh",
    "hooks/track-outcome.sh",
    "hooks/_outcome_signal.py",
    "hooks/_pg_learning_dualwrite.py",
    "scripts/_pg_dual_write_daemon.py",
)

_STOP_CATEGORIES = frozenset(
    {
        "test runner",
        "apply pipeline",
        "learning aggregator",
        "LLM and auth setup",
        "cycle-report push",
        "read-only diagnostic",
        "retired-job teardown",
        "absent target",
    }
)


class Stop(NamedTuple):
    source: str
    target: str
    subcommand: str | None  # None = every invocation of the target from this source
    category: str
    reason: str


_STOPS = (
    Stop(
        "autoagent/daemon-cycle.sh",
        "autoagent/daemon-apply.sh",
        None,
        "apply pipeline",
        "the apply pipeline and its test runner write no criterion table (roots-row scan); "
        "it reaches the roster only through agents/, a member",
    ),
    Stop(
        "autoagent/daemon-cycle.sh",
        "hooks/learning-aggregator.py",
        None,
        "learning aggregator",
        "reads core.budget_overages, writes learning tables only (roots-row scan)",
    ),
    Stop(
        "autoagent/daemon-cycle.sh",
        "scripts/lib/claude-auth-env.sh",
        None,
        "LLM and auth setup",
        "loads the live credential env for the LLM call; its values live outside the repo",
    ),
    Stop(
        "autoagent/daemon-cycle.sh",
        "scripts/_pg_push_autoagent_cycle.py",
        None,
        "cycle-report push",
        "writes the cycle-report tables only (roots-row scan); its helper is the scoped writer",
    ),
    Stop(
        "autoagent/daemon-cycle.sh",
        "autoagent/archive/daemon-regression-deprecated-2026-05-02.sh",
        None,
        "absent target",
        "the file is not in the tree, so the stage skips",
    ),
    Stop(
        "autoagent/daemon-cycle.sh",
        "glass-atrium",
        "doctor",
        "read-only diagnostic",
        "its psql probes are SELECTs and its verdict lands in the report's doctor key, which no "
        "criterion reader consumes; its write-site half is held by the roots row's whole-tree scan",
    ),
    Stop(
        "autoagent/daemon-cycle.sh",
        "glass-atrium",
        "retire-launchd-jobs",
        "retired-job teardown",
        "lib/ga-launchd.sh, lib/ga-env.sh, lib/ga-daemons.sh and scripts/lib/fakechat-cleanup.sh "
        "tear down retired labels, sessions and fakechat ports only; RetireStopTest holds that",
    ),
)


class Binding(NamedTuple):
    """A variable the row cannot evaluate, declared with its value and pinned to its assignment."""

    source: str
    name: str
    assignment: str  # the raw right-hand side as written; another text voids the declaration
    value: str  # repo path, "~/…" or a bare PATH binary
    reason: str


class DeclaredEdge(NamedTuple):
    """An edge built at run time, declared with the repo path it reaches (None = no code target)."""

    source: str
    raw: str
    target: str | None
    reason: str


_BINDINGS = (
    Binding(
        "autoagent/daemon-cycle.sh",
        "SCRIPT_DIR",
        '"$(resolve_self)"',
        "autoagent",
        "resolve_self follows the entry's symlinks to its own directory",
    ),
    Binding(
        "autoagent/daemon-cycle.sh",
        "PYTHON_BIN",
        '"${AUTOAGENT_PYTHON_BIN:-python3}"',
        "python3",
        "an interpreter override, never a repo file",
    ),
    Binding(
        "autoagent/daemon-cycle.sh",
        "BACKFILL_LOCK_LIB",
        '"${ATRIUM_APPLY_LOCK_LIB:-${SCRIPT_DIR}/../scripts/lib/apply-lock.sh}"',
        "scripts/lib/apply-lock.sh",
        "the env override is a test seam; the install runs the default",
    ),
    Binding(
        "hooks/advisory-subagent-budget.sh",
        "overage_writer",
        '"${SUBAGENT_OVERAGE_WRITER:-${DEFAULT_OVERAGE_WRITER}}"',
        "hooks/_pg-write.py",
        "the env override is a test seam; the default is the sibling _pg-write.py",
    ),
)
_DECLARED_EDGES = (
    DeclaredEdge(
        "hooks/hook-utils.sh",
        '"${guard}"',
        "scripts/lib/path-guard.sh",
        "the loader's own dir joined with ../scripts/lib/path-guard.sh",
    ),
    DeclaredEdge(
        "hooks/lib/hook-utils.sh",
        '"${config_lib}"',
        "scripts/lib/atrium-config.sh",
        "the install root _hook_utils_ga_root prints, joined with scripts/lib/atrium-config.sh",
    ),
    DeclaredEdge(
        "hooks/hook-utils.sh",
        '"${live_fn}"',
        None,
        "hook_cached_int_read dispatches a function its caller defines, never a file",
    ),
    DeclaredEdge(
        "hooks/inject-scope-rules.sh",
        '"${cmd}"',
        None,
        "the manifest digest tool: shasum, sha256sum or its override, a binary on PATH",
    ),
    DeclaredEdge(
        "autoagent/daemon_cycle.py",
        "claude_bin",
        None,
        "the claude CLI (LLM setup), not a repo file",
    ),
    DeclaredEdge(
        "autoagent/daemon_cycle.py",
        "ps_bin",
        None,
        "ps or its AUTOAGENT_PS_BIN override, not a repo file",
    ),
)
_USED_BINDINGS: set[Binding] = set()


class Edge(NamedTuple):
    source: str
    raw: str
    target: str | None  # None = the row could not resolve it
    subcommand: str | None


# -- tracked tree ------------------------------------------------------------------------------


@functools.cache
def _get_tracked() -> frozenset[str]:
    listing = subprocess.run(
        ["git", "-C", str(_REPO_ROOT), "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return frozenset(path for path in listing.split("\0") if path)


def _is_test_path(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    return (
        any(part in {"test", "tests", "__tests__", "fixtures"} for part in parts[:-1])
        or name.startswith("test_")
        or ".test." in name
        or ".spec." in name
    )


@functools.cache
def _read(path: str) -> str | None:
    try:
        return (_REPO_ROOT / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _get_language(path: str) -> str | None:
    if path.endswith(".py"):
        return "python"
    if path.endswith((".sh", ".bash")):
        return "shell"
    first_line = (_read(path) or "").split("\n", 1)[0]
    if first_line.startswith("#!") and re.search(r"\b(bash|sh)\b", first_line):
        return "shell"
    if first_line.startswith("#!") and "python" in first_line:
        return "python"
    return None


def _get_code_files() -> Iterator[str]:
    for path in sorted(_get_tracked()):
        if _is_test_path(path):
            continue
        if path.endswith(_CODE_SUFFIXES) or (
            "." not in path.rsplit("/", 1)[-1] and _get_language(path)
        ):
            yield path


def _is_scoped(path: str) -> bool:
    return dc._is_aa_scoped(_REPO_ROOT, path)


# -- roots row ---------------------------------------------------------------------------------


def _get_criterion_sql() -> list[str]:
    texts: list[str] = _get_spawn_facts_sql()
    pending: list[object] = [dc.AA.SQL]
    while pending:
        node = pending.pop()
        if isinstance(node, str):
            texts.append(node)
        elif isinstance(node, dict):
            pending.extend(node.values())
        elif isinstance(node, (tuple, list)):
            pending.extend(node)
        elif hasattr(node, "__dict__"):
            pending.extend(vars(node).values())
    return texts


def _get_spawn_facts_sql() -> list[str]:
    """The SpawnFacts select's string parts, read from its source: the module needs psycopg."""
    tree = ast.parse(_read("hooks/_pg_learning_dualwrite.py") or "")
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "_SPAWN_FACTS_SELECT_SQL"
            for target in node.targets
        ):
            return [
                part.value
                for part in ast.walk(node.value)
                if isinstance(part, ast.Constant) and isinstance(part.value, str)
            ]
    raise AssertionError("hooks/_pg_learning_dualwrite.py: no _SPAWN_FACTS_SELECT_SQL")


def _get_criterion_tables() -> frozenset[str]:
    return frozenset(m.group(1) for sql in _get_criterion_sql() for m in _TABLE_REF.finditer(sql))


def _get_write_sites(text: str, tables: frozenset[str]) -> list[tuple[str, str, int]]:
    """(verb, table, offset) of every SQL write naming a criterion table."""
    names = "|".join(sorted(tables))
    pattern = re.compile(_WRITE_VERB + r'\s+"?core"?\s*\.\s*"?(' + names + r")\b", re.IGNORECASE)
    return [(m.group(1).split()[0].upper(), m.group(2), m.end()) for m in pattern.finditer(text)]


def _get_allowlisted_tables(text: str, tables: frozenset[str]) -> set[str]:
    """Tables a writer allowlist keys: a quoted ``core.<table>`` mapping key."""
    names = "|".join(sorted(tables))
    pattern = re.compile(r"[\"']core\.(" + names + r")[\"']\s*:")
    return {m.group(1) for m in pattern.finditer(text)}


def _get_handed_tables(path: str, tables: frozenset[str], writers: set[str]) -> set[str]:
    """Tables a caller hands a writer: an exact ``"core.<table>"`` literal, or an argument of a
    shell command whose run target is a found writer."""
    names = "|".join(sorted(tables))
    literal = re.compile(r"([\"'])core\.(" + names + r")\1")
    argument = re.compile(r"core\.(" + names + r")")
    handed = {
        m.group(2)
        for line in (_read(path) or "").splitlines()
        if not line.lstrip().startswith(("#", "//", "*", "/*"))
        for m in literal.finditer(line)
    }
    if _get_language(path) != "shell":
        return handed
    scope = _ShellScope(path, _read(path) or "")
    for words in scope.commands:
        targets = {
            edge.target for edge in _get_run_edges_of(scope, _get_command_words(words), set())
        }
        if targets & writers:
            handed |= {
                m.group(1) for word in words if (m := argument.fullmatch(_get_raw_value(word)))
            }
    return handed


def _get_discovered_writers(tables: frozenset[str]) -> dict[str, set[str]]:
    """file → criterion tables it writes, allowlists, or hands to a found writer."""
    writers: dict[str, set[str]] = {}
    for path in _get_code_files():
        text = _read(path) or ""
        found = {table for _, table, _ in _get_write_sites(text, tables)}
        found |= _get_allowlisted_tables(text, tables)
        if found:
            writers[path] = found
    stems = {Path(path).stem for path in writers if path not in _COLUMN_ONLY_WRITERS}
    stem_ref = re.compile(r"(?<![\w-])(" + "|".join(map(re.escape, sorted(stems))) + r")(?![\w-])")
    for path in _get_code_files():
        text = _read(path) or ""
        if path in writers or not stem_ref.search(text):
            continue
        handed = _get_handed_tables(path, tables, set(writers))
        if handed:
            writers[path] = handed
    return writers


def _get_set_columns(text: str, offset: int) -> set[str] | None:
    """Columns of the SET list after an UPDATE's table name; None when no SET list follows."""
    match = re.match(
        r"\s+SET\s+(.*?)(?:\bWHERE\b|\bRETURNING\b|\bFROM\b|`|;|$)", text[offset:], re.I | re.S
    )
    if match is None:
        return None
    return {m.group(1) for m in re.finditer(r"(?:^|,)\s*\"?([a-z_]+)\"?\s*=", match.group(1))}


class RootsTest(unittest.TestCase):
    def test_every_table_an_aa_criterion_reads_names_its_writer_chain(self) -> None:
        tables = _get_criterion_tables()

        self.assertEqual(set(_ROOTS), set(tables), "criterion tables vs declared roots")
        self.assertTrue(all(_ROOTS[table] for table in tables))

    def test_every_writer_a_tree_scan_finds_is_a_declared_root_or_column_only_writer(self) -> None:
        declared = {(path, table) for table, paths in _ROOTS.items() for path in paths}
        declared |= {(path, table) for path, cols in _COLUMN_ONLY_WRITERS.items() for table in cols}

        found = {
            (path, table)
            for path, found_tables in _get_discovered_writers(_get_criterion_tables()).items()
            for table in found_tables
        }

        self.assertEqual(sorted(found - declared), [], "writers not declared in _ROOTS")

    def test_every_declared_root_writer_is_aa_scoped(self) -> None:
        unscoped = sorted(
            {path for paths in _ROOTS.values() for path in paths if not _is_scoped(path)}
        )

        self.assertEqual(unscoped, [], "root writers outside AA.SCOPE")

    def test_a_column_only_writer_updates_only_its_declared_columns_and_no_criterion_reads_them(
        self,
    ) -> None:
        tables = _get_criterion_tables()
        criterion_sql = "\n".join(_get_criterion_sql())
        for path, declared in _COLUMN_ONLY_WRITERS.items():
            text = _read(path) or ""
            sites = _get_write_sites(text, tables)
            self.assertTrue(sites, f"{path}: declared column-only writer has no write site")
            for verb, table, offset in sites:
                columns = _get_set_columns(text, offset) if verb == "UPDATE" else None
                allowed = declared.get(table, frozenset())
                self.assertTrue(
                    columns and columns <= allowed,
                    f"{path}: {verb} core.{table} sets {columns}, declared {sorted(allowed)}",
                )
            for column in frozenset().union(*declared.values()):
                self.assertNotRegex(
                    criterion_sql, rf"\b{column}\b", f"criterion SQL reads {column}"
                )

    def test_every_migration_naming_a_criterion_table_is_aa_scoped(self) -> None:
        tables = _get_criterion_tables()
        names = re.compile(r'\bcore"?\."?(' + "|".join(sorted(tables)) + r")\b")
        unscoped = [
            path
            for path in sorted(_get_tracked())
            if _MIGRATION.fullmatch(path)
            and names.search(_read(path) or "")
            and not _is_scoped(path)
        ]

        self.assertEqual(unscoped, [], "schema writers of criterion tables outside AA.SCOPE")


# -- path evaluation ---------------------------------------------------------------------------


def _join(base: str, tail: str) -> str | None:
    if tail.startswith("/"):
        return tail
    joined = posixpath.normpath(posixpath.join(base, tail))
    return None if joined.startswith("..") else joined


def _get_parent(path: str) -> str | None:
    if path in {"", "."}:
        return None
    return posixpath.dirname(path)


def _get_repo_path(path: str) -> str | None:
    """Install-root forms map to the repo path; an unmappable absolute path maps to None."""
    for prefix in _INSTALL_PREFIXES:
        if path.startswith(prefix):
            return posixpath.normpath(path[len(prefix) :])
    if path.startswith(("/", "~")):
        return None
    return posixpath.normpath(path)


# -- shell edges -------------------------------------------------------------------------------

_SHELL_PREFIX_WORDS = frozenset(
    {
        "exec",
        "command",
        "nohup",
        "env",
        "time",
        "!",
        "if",
        "then",
        "else",
        "elif",
        "do",
        "while",
        "until",
        "builtin",
        "{",
        "}",
    }
)
_NON_RUN_WORDS = frozenset(
    {
        "[",
        "test",
        "echo",
        "printf",
        "local",
        "case",
        "for",
        "return",
        "export",
        "readonly",
        "declare",
        "typeset",
        "unset",
        "esac",
        "fi",
        "done",
        "in",
        "trap",
        "read",
        "shift",
        "eval",
    }
)
_ARGV_WORDS = frozenset({'"$@"', "$@", '"${@}"', "${@}"})
_INTERPRETERS = frozenset({"bash", "sh", "zsh", "python", "python3"})
_SELF_DIR = re.compile(
    r'^"?\$\(\s*(?:cd\s+(?:-P\s+)?)?"?\$\(\s*dirname\s+"?\$\{?(?:BASH_SOURCE(?:\[0\])?|0)\}?"?\s*\)'
    r'(?P<tail>/[\w./-]*)?"?(?:\s*(?:>\s*/dev/null|2>&1))*\s*(?:&&\s*pwd(?:\s+-P)?\s*)?\)"?$'
)
_ASSIGNMENT = re.compile(r"^([A-Za-z_]\w*)(?:\[[^]]*\])?(\+?)=(.*)$", re.S)
_DECLARATION_WORDS = frozenset({"local", "readonly", "export", "declare", "typeset"})
_REDIRECT = re.compile(r"^\d*(?:&>>?|[<>]{1,3})&?\d*")
_VARIABLE_REF = re.compile(
    r"\$\{([A-Za-z_]\w*)(?:\[0\])?(%/\*|:-[^}]*)?\}|\$([A-Za-z_]\w*|0)(?![\w\[])"
)


class Heredoc(NamedTuple):
    opener: list[str]  # the words of the command that opened it
    body: str


class _ShellParser:
    """Simple commands of a shell file as raw words; quotes, substitutions, heredocs kept apart."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.index = 0
        self.commands: list[list[str]] = []
        self.heredocs: list[Heredoc] = []
        self.pending: list[tuple[str, bool, list[str]]] = []
        self.line_start = 0

    def parse(self, closer: str | None = None) -> None:
        words: list[str] = []
        word = ""
        while self.index < len(self.text):
            char = self.text[self.index]
            if closer and char == closer and not word.endswith("\\"):
                self.index += 1
                break
            if char in " \t\n;&|" or (char == ")" and closer is None):
                words, word = self._end_word(words, word, char)
                continue
            if char == "#" and not word:
                self._skip_to_newline()
                continue
            word += self._read_unit(word, words)
        self._end_command(words + ([word] if word else []))

    def _end_word(self, words: list[str], word: str, char: str) -> tuple[list[str], str]:
        if word:
            words.append(word)
        self.index += 1
        if char == ")":
            del self.commands[self.line_start :]  # an unmatched ")" ends a case pattern, no command
            return [], ""
        if char in "\n;&|":
            self._end_command(words)
            if char == "\n":
                self._read_heredocs()
                self.line_start = len(self.commands)
            return [], ""
        return words, ""

    def _end_command(self, words: list[str]) -> None:
        if words:
            self.commands.append(words)
            for index, word in enumerate(words):
                marker = re.match(r"^<<(-?)\s*['\"]?(\w+)['\"]?$", word)
                if marker:
                    self.pending.append((marker.group(2), bool(marker.group(1)), words[:index]))

    def _read_heredocs(self) -> None:
        for delimiter, dashed, opener in self.pending:
            lines: list[str] = []
            while self.index < len(self.text):
                end = self.text.find("\n", self.index)
                end = len(self.text) if end < 0 else end
                line = self.text[self.index : end]
                self.index = end + 1
                if (line.strip() if dashed else line) == delimiter:
                    break
                lines.append(line)
            self.heredocs.append(Heredoc(opener, "\n".join(lines)))
        self.pending = []

    def _skip_to_newline(self) -> None:
        end = self.text.find("\n", self.index)
        self.index = len(self.text) if end < 0 else end

    def _read_unit(self, word: str, words: list[str]) -> str:
        text = self.text
        start = self.index
        char = text[start]
        if char == "\\":
            self.index += 2
            return "" if text[start + 1 : start + 2] == "\n" else text[start : start + 2]
        if char == "'":
            self.index = text.find("'", start + 1) + 1 or len(text)
            return text[start : self.index]
        if char == '"':
            return self._read_double_quoted()
        at_command = not word and (not words or words[-1] in _SHELL_PREFIX_WORDS)
        if text.startswith("$((", start) or (text.startswith("((", start) and at_command):
            self.index = self._find_close(start + (3 if char == "$" else 2), "(", ")", 2)
            return text[start : self.index] if char == "$" else ""
        if text.startswith("$(", start) or char == "`":
            return self._read_substitution()
        if text.startswith("${", start):
            self.index = self._find_close(start + 2, "{", "}", 1)
            return text[start : self.index]
        if char == "(" and (word.endswith("=") or at_command):
            if word.endswith("="):
                self.index = self._find_close(start + 1, "(", ")", 1)
                return text[start : self.index]
            self.index += 1
            self.parse(")")
            return ""
        if text.startswith("[[", start) and at_command:
            end = re.compile(r"\s\]\](?=[\s;&|)]|$)").search(text, start)
            self.index = len(text) if end is None else end.end()
            return ""
        self.index += 1
        return char

    def _read_double_quoted(self) -> str:
        text = self.text
        start = self.index
        self.index += 1
        out = '"'
        while self.index < len(text) and text[self.index] != '"':
            if text[self.index] == "\\":
                out += text[self.index : self.index + 2]
                self.index += 2
            elif text.startswith("$(", self.index) and not text.startswith("$((", self.index):
                out += self._read_substitution()
            elif text.startswith("${", self.index):
                end = self._find_close(self.index + 2, "{", "}", 1)
                out += text[self.index : end]
                self.index = end
            else:
                out += text[self.index]
                self.index += 1
        self.index += 1
        return out + '"' if self.index <= len(text) else text[start:]

    def _read_substitution(self) -> str:
        start = self.index
        closer = "`" if self.text[start] == "`" else ")"
        self.index += 1 if closer == "`" else 2
        self.parse(closer)
        return self.text[start : self.index]

    def _find_close(self, index: int, opener: str, closer: str, width: int) -> int:
        depth = 1
        while index < len(self.text) and depth:
            char = self.text[index]
            if char == "\\":
                index += 2
                continue
            if char == "'":
                index = self.text.find("'", index + 1) + 1 or len(self.text)
                continue
            depth += 1 if char == opener else -1 if char == closer else 0
            index += 1
        return min(len(self.text), index + width - 1)


def _get_words_of(text: str) -> list[str]:
    parser = _ShellParser(text)
    parser.parse()
    return parser.commands[0] if parser.commands else []


def _get_raw_value(word: str) -> str:
    return word[1:-1] if len(word) > 1 and word[0] == word[-1] and word[0] in "'\"" else word


class _ShellScope:
    def __init__(self, path: str, text: str) -> None:
        self.path = path
        parser = _ShellParser(text)
        parser.parse()
        self.commands = parser.commands
        self.heredocs = parser.heredocs
        self.assignments: dict[str, set[str]] = {}
        self.array_sites: list[tuple[int, str, str]] = []
        self.current = 0
        for position, words in enumerate(self.commands):
            for word in words:
                if word in _DECLARATION_WORDS or word.startswith("-"):
                    continue
                match = _ASSIGNMENT.match(word)
                if match is None:
                    break
                self.assignments.setdefault(match.group(1), set()).add(
                    match.group(2) + match.group(3)
                )
                if not match.group(2) and match.group(3).startswith("("):
                    self.array_sites.append((position, match.group(1), match.group(3)))

    def get_variable(self, name: str, seen: frozenset[str]) -> str | None:
        raws = self.assignments.get(name)
        for binding in _BINDINGS:
            if (binding.source, binding.name) == (self.path, name) and raws == {binding.assignment}:
                _USED_BINDINGS.add(binding)
                return binding.value
        if raws is None:
            builtins = {
                "HOME": _HOME,
                "GA_ROOT": "~/.glass-atrium",
                "BASH_SOURCE": self.path,
                "0": self.path,
            }
            return builtins.get(name)
        if name in seen or len(raws) != 1:
            return None
        return self.evaluate(next(iter(raws)), seen | {name})

    def get_subcommand(self, word: str) -> str:
        """A literal subcommand, or the first element an array's one literal assignment holds."""
        raw = _get_raw_value(word)
        array = re.fullmatch(r"\$\{(\w+)\[@\]\}", raw)
        if array is None:
            return raw
        literals = [
            r for at, n, r in self.array_sites if n == array.group(1) and at <= self.current
        ]
        words = _get_words_of(literals[-1][1:-1]) if literals else []
        return _get_raw_value(words[0]) if words else raw

    def evaluate(self, word: str, seen: frozenset[str] = frozenset()) -> str | None:
        self_dir = _SELF_DIR.match(word)
        if self_dir:
            tail = (self_dir.group("tail") or "").lstrip("/")
            return _join(posixpath.dirname(self.path), tail)
        if "$(" in word or "`" in word:
            return None
        value = self._substitute(word.replace('"', "").replace("'", ""), seen)
        return None if value is None or "*" in value else value

    def _substitute(self, text: str, seen: frozenset[str]) -> str | None:
        out = ""
        cursor = 0
        for match in _VARIABLE_REF.finditer(text):
            name = match.group(1) or match.group(3)
            operator = match.group(2) or ""
            value = self.get_variable(name, seen)
            if value is None:
                return None
            value = (posixpath.dirname(value) or ".") if operator == "%/*" else value
            out += text[cursor : match.start()] + value
            cursor = match.end()
        out += text[cursor:]
        return None if "$" in out else out


def _get_shell_edges(path: str) -> list[Edge]:
    scope = _ShellScope(path, _read(path) or "")
    inline = _get_inline_programs(scope)
    edges: list[Edge] = []
    for position, words in enumerate(scope.commands):
        scope.current = position
        edges.extend(_get_command_edges(scope, words, inline))
    for heredoc in scope.heredocs:
        if _is_inline_python(scope, heredoc):
            edges.extend(_get_python_edges(path, heredoc.body, search_dirs=[]))
    return edges


def _get_heredoc_variable(opener: list[str]) -> str | None:
    """The variable a heredoc fills: the temp file ``cat`` writes, or the name ``read`` sets."""
    for word in opener:
        match = re.match(r'^>\s*"?\$\{?(\w+)\}?"?$', word)
        if match:
            return match.group(1)
    if "read" in opener:
        names = [
            word for word in opener[opener.index("read") + 1 :] if not word.startswith(("-", "'"))
        ]
        return names[-1] if names else None
    return None


def _get_inline_programs(scope: _ShellScope) -> set[str]:
    """Variables a heredoc fills: running one runs that heredoc's body."""
    return {name for h in scope.heredocs if (name := _get_heredoc_variable(h.opener))}


def _is_inline_python(scope: _ShellScope, heredoc: Heredoc) -> bool:
    if any(word in _INTERPRETERS for word in heredoc.opener):
        return True
    name = _get_heredoc_variable(heredoc.opener)
    if name is None:
        return False
    ref = re.compile(r'"?\$\{?' + name + r'\}?"?')
    return any(
        word in _INTERPRETERS
        and any(ref.fullmatch(operand) for operand in words[index + 1 : index + 3])
        for words in scope.commands
        for index, word in enumerate(words)
    )


def _get_command_edges(scope: _ShellScope, words: list[str], inline: set[str]) -> list[Edge]:
    return _get_handoff_edges(scope, words) + _get_run_edges_of(
        scope, _get_command_words(words), inline
    )


def _get_handoff_edges(scope: _ShellScope, words: list[str]) -> list[Edge]:
    """An env hand-off: a command-prefix or exported assignment whose value names a code file."""
    exported = words[:1] == ["export"]
    assignments = []
    for word in words[1:] if exported else words:
        match = _ASSIGNMENT.match(word)
        if match is None:
            break
        assignments.append(match.group(3))
    if not exported and len(assignments) == len(words):
        return []
    edges: list[Edge] = []
    for raw in assignments:
        value = scope.evaluate(raw)
        if (value or _get_raw_value(raw)).endswith((".py", ".sh", ".bash")):
            edges.extend(_get_target_edges(scope, [raw], None))
    return edges


def _get_run_edges_of(scope: _ShellScope, words: list[str], inline: set[str]) -> list[Edge]:
    if not words or words[0] in _NON_RUN_WORDS or words[0] in _ARGV_WORDS:
        return []
    if words[0] in {"source", "."}:
        return _get_target_edges(scope, words[1:2], None)
    if words[0] in _INTERPRETERS or scope.evaluate(words[0]) in _INTERPRETERS:
        return _get_interpreter_edges(scope, words, inline)
    if "/" in words[0] or "$" in words[0] or words[0].endswith((".sh", ".py")):
        return _get_target_edges(
            scope, words[:1], scope.get_subcommand(words[1]) if len(words) > 1 else None
        )
    nested = next((i for i, word in enumerate(words) if i and word in _INTERPRETERS), None)
    return [] if nested is None else _get_interpreter_edges(scope, words[nested:], inline)


def _get_command_words(words: list[str]) -> list[str]:
    """Words of a command with redirections and leading assignments or prefix words dropped."""
    kept: list[str] = []
    skip = False
    for word in words:
        if skip:
            skip = False
            continue
        redirect = _REDIRECT.match(word)
        if redirect:
            skip = redirect.end() == len(word) and not word.startswith("<<")
            continue
        if not kept and word == "command" and len(words) > 1 and words[1] in {"-v", "-V"}:
            return []
        if not kept and (word in _SHELL_PREFIX_WORDS or _ASSIGNMENT.match(word)):
            continue
        kept.append(word)
    return kept


def _get_interpreter_edges(scope: _ShellScope, words: list[str], inline: set[str]) -> list[Edge]:
    if "-c" in words[1:2] and len(words) > 2:
        return _get_inline_code_edges(scope, words[2], inline)
    operands = [word for word in words[1:] if not word.startswith("-")]
    if "-" in words[1:2]:
        return []
    if not operands:
        return [Edge(scope.path, " ".join(words), None, None)]
    if _is_inline_ref(operands[0], inline):
        return []  # a heredoc's body, scanned as Python where it is written
    subcommand = scope.get_subcommand(operands[1]) if len(operands) > 1 else None
    return _get_target_edges(scope, operands[:1], subcommand)


def _get_inline_code_edges(scope: _ShellScope, word: str, inline: set[str]) -> list[Edge]:
    """A ``python3 -c`` program: a literal or heredoc body scans as Python, else unresolved."""
    if _is_inline_ref(word, inline):
        return []
    if word[:1] not in "'\"" or "$" in (word if word[0] == '"' else ""):
        return [Edge(scope.path, f"python3 -c {word}", None, None)]
    code = word[1:-1] if word[0] == "'" else word[1:-1].replace('\\"', '"')
    try:
        return _get_python_edges(scope.path, code, search_dirs=[])
    except SyntaxError:
        return [Edge(scope.path, f"python3 -c {word}", None, None)]


def _is_inline_ref(word: str, inline: set[str]) -> bool:
    return re.fullmatch(r'"?\$\{?(' + "|".join(inline or {"_"}) + r')\}?"?', word) is not None


def _get_target_edges(scope: _ShellScope, words: list[str], subcommand: str | None) -> list[Edge]:
    if not words:
        return []
    raw = words[0]
    value = scope.evaluate(raw)
    if value is not None and "/" not in value and not value.endswith((".sh", ".py")):
        return [] if value not in _get_tracked() else [Edge(scope.path, raw, value, subcommand)]
    return [Edge(scope.path, raw, _get_repo_path(value) if value is not None else None, subcommand)]


# -- python edges ------------------------------------------------------------------------------

_RUN_CALLS = frozenset(
    {"run", "Popen", "call", "check_call", "check_output", "create_subprocess_exec"}
)
_LOAD_CALLS = frozenset({"spec_from_file_location", "run_path"})


class _PythonScope:
    def __init__(self, path: str, tree: ast.Module) -> None:
        self.path = path
        self.values: dict[str, list[ast.expr]] = {}
        self.loops: dict[str, ast.expr] = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        self.values.setdefault(target.id, []).append(node.value)
            elif (
                isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value
            ):
                self.values.setdefault(node.target.id, []).append(node.value)
            elif isinstance(node, ast.For) and isinstance(node.target, ast.Name):
                self.loops[node.target.id] = node.iter

    def get_name(self, name: str, seen: frozenset[str]) -> str | None:
        if name == "__file__":
            return self.path
        nodes = self.values.get(name, [])
        written = {ast.unparse(node) for node in nodes}
        for binding in _BINDINGS:
            if (binding.source, binding.name) == (self.path, name) and written == {
                binding.assignment
            }:
                _USED_BINDINGS.add(binding)
                return binding.value
        if name in seen or not nodes:
            return None
        values = {self.evaluate(node, seen | {name}) for node in nodes}
        return values.pop() if len(values) == 1 else None

    def get_choices(self, node: ast.expr) -> list[ast.expr]:
        """The values a for-loop target takes over a literal tuple or list; else the node."""
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "str":
            node = node.args[0]
        if isinstance(node, ast.Name) and node.id in self.loops:
            loop = self.loops[node.id]
            if isinstance(loop, (ast.Tuple, ast.List)):
                return list(loop.elts)
        return [node]

    def evaluate(self, node: ast.expr, seen: frozenset[str] = frozenset()) -> str | None:
        match node:
            case ast.Constant(value=str() as text):
                return text
            case ast.Name(id=name):
                return self.get_name(name, seen)
            case ast.BinOp(left=left, op=ast.Div(), right=right):
                return self._join(self.evaluate(left, seen), self.evaluate(right, seen))
            case ast.Attribute(value=inner, attr="parent"):
                value = self.evaluate(inner, seen)
                return None if value is None else _get_parent(value)
            case ast.Subscript(
                value=ast.Attribute(value=inner, attr="parents"),
                slice=ast.Constant(value=int() as n),
            ):
                value = self.evaluate(inner, seen)
                for _ in range(n + 1):
                    value = None if value is None else _get_parent(value)
                return value
            case ast.Call():
                return self._evaluate_call(node, seen)
            case ast.JoinedStr(values=parts):
                pieces = [
                    self.evaluate(p.value if isinstance(p, ast.FormattedValue) else p, seen)
                    for p in parts
                ]
                return (
                    None
                    if any(piece is None for piece in pieces)
                    else "".join(piece for piece in pieces if piece is not None)
                )
        return None

    def _evaluate_call(self, node: ast.Call, seen: frozenset[str]) -> str | None:
        name = ast.unparse(node.func)
        args = node.args
        if name in {"Path.home", "pathlib.Path.home"} or ast.unparse(node) in {
            "os.path.expanduser('~')",
            "os.environ.get('HOME', str(Path.home()))",
            "os.environ['HOME']",
        }:
            return _HOME
        if (
            name
            in {"Path", "pathlib.Path", "str", "os.fspath", "os.path.abspath", "os.path.realpath"}
            and len(args) == 1
        ):
            return self.evaluate(args[0], seen)
        if name.endswith((".resolve", ".absolute", ".expanduser")) and isinstance(
            node.func, ast.Attribute
        ):
            return self.evaluate(node.func.value, seen)
        if name == "os.path.dirname" and len(args) == 1:
            value = self.evaluate(args[0], seen)
            return None if value is None else _get_parent(value)
        if name in {"os.path.join", "Path.joinpath"} and args:
            value = self.evaluate(args[0], seen)
            for arg in args[1:]:
                value = self._join(value, self.evaluate(arg, seen))
            return value
        return None

    @staticmethod
    def _join(base: str | None, tail: str | None) -> str | None:
        if base is None or tail is None:
            return None
        if base == _HOME or base.startswith(_HOME + "/"):
            return posixpath.normpath(posixpath.join(base, tail))
        return _join(base, tail)


def _get_python_edges(
    path: str, text: str | None = None, search_dirs: list[str] | None = None
) -> list[Edge]:
    """Edges of a Python file, or of an inline program a shell file runs (its own search dirs)."""
    tree = ast.parse(_read(path) or "" if text is None else text, filename=path)
    scope = _PythonScope(path, tree)
    edges: list[Edge] = []
    search_dirs = [posixpath.dirname(path)] if search_dirs is None else search_dirs
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and ast.unparse(node.func) in {
            "sys.path.insert",
            "sys.path.append",
        }:
            edges.extend(_get_search_dir_edges(scope, node, search_dirs))
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            edges.extend(_get_import_edges(path, node, search_dirs))
        elif isinstance(node, ast.Call):
            edges.extend(_get_run_edges(scope, node))
    return edges


def _get_search_dir_edges(
    scope: _PythonScope, node: ast.Call, search_dirs: list[str]
) -> list[Edge]:
    edges: list[Edge] = []
    for choice in scope.get_choices(node.args[-1]):
        value = scope.evaluate(choice)
        directory = _get_repo_path(value) if value is not None else None
        if directory is None:
            edges.append(Edge(scope.path, f"sys.path {ast.unparse(choice)}", None, None))
        elif directory not in search_dirs:
            search_dirs.append(directory)
    return edges


@functools.cache
def _get_module_stems() -> frozenset[str]:
    return frozenset(
        Path(path).stem
        for path in _get_tracked()
        if path.endswith(".py") and not _is_test_path(path)
    )


def _get_import_edges(
    path: str, node: ast.Import | ast.ImportFrom, search_dirs: list[str]
) -> list[Edge]:
    if isinstance(node, ast.ImportFrom):
        if node.level or node.module is None:
            return [Edge(path, ast.unparse(node), None, None)]
        modules = [node.module.split(".")[0]]
    else:
        modules = [alias.name.split(".")[0] for alias in node.names]
    edges: list[Edge] = []
    for module in modules:
        found = [
            candidate
            for directory in search_dirs
            for candidate in (
                _join(directory, f"{module}.py"),
                _join(directory, f"{module}/__init__.py"),
            )
            if candidate in _get_tracked()
        ]
        if found:
            edges.append(Edge(path, f"import {module}", found[0], None))
        elif module in _get_module_stems():
            edges.append(Edge(path, f"import {module}", None, None))
    return edges


def _get_run_edges(scope: _PythonScope, node: ast.Call) -> list[Edge]:
    name = ast.unparse(node.func)
    tail = name.rsplit(".", 1)[-1]
    if tail in _LOAD_CALLS and node.args:
        return [
            _get_python_target(
                scope, node.args[-1 if tail == "spec_from_file_location" else 0], None
            )
        ]
    if tail not in _RUN_CALLS or not (name.startswith(("subprocess.", "asyncio.")) or name == tail):
        return []
    argv = (
        node.args[0]
        if node.args
        else next((k.value for k in node.keywords if k.arg == "args"), None)
    )
    if tail == "create_subprocess_exec":
        elements: list[ast.expr] = list(node.args)
    elif isinstance(argv, (ast.List, ast.Tuple)):
        elements = list(argv.elts)
    elif argv is None:
        return []
    else:
        return [Edge(scope.path, ast.unparse(argv), None, None)]
    return _get_argv_edges(scope, elements)


def _get_argv_edges(scope: _PythonScope, elements: list[ast.expr]) -> list[Edge]:
    if (
        elements
        and isinstance(elements[0], ast.Starred)
        and isinstance(elements[0].value, ast.Name)
    ):
        bound = scope.values.get(elements[0].value.id, [])
        if len(bound) == 1 and isinstance(bound[0], (ast.List, ast.Tuple)):
            elements = [*bound[0].elts, *elements[1:]]
    if not elements:
        return []
    if isinstance(elements[0], ast.Starred):
        return [Edge(scope.path, ast.unparse(elements[0]), None, None)]
    program = ast.unparse(elements[0])
    value = "python3" if program == "sys.executable" else scope.evaluate(elements[0])
    if value in _INTERPRETERS:
        operands = [
            e
            for e in elements[1:]
            if not (isinstance(e, ast.Constant) and str(e.value).startswith("-"))
        ]
        if not operands:
            return []
        subcommand = scope.evaluate(operands[1]) if len(operands) > 1 else None
        return [_get_python_target(scope, operands[0], subcommand)]
    if value is not None and "/" not in value:
        return [] if value not in _get_tracked() else [Edge(scope.path, program, value, None)]
    subcommand = scope.evaluate(elements[1]) if len(elements) > 1 else None
    return [_get_python_target(scope, elements[0], subcommand)]


def _get_python_target(scope: _PythonScope, node: ast.expr, subcommand: str | None) -> Edge:
    value = scope.evaluate(node)
    return Edge(scope.path, ast.unparse(node), _get_repo_path(value) if value else None, subcommand)


# -- closure row -------------------------------------------------------------------------------


class Closure(NamedTuple):
    failures: list[str]
    used_stops: set[Stop]
    used_edges: set[DeclaredEdge]
    walked: set[str]


def _get_edges(path: str) -> list[Edge] | None:
    language = _get_language(path)
    if language == "python":
        return _get_python_edges(path)
    if language == "shell":
        return _get_shell_edges(path)
    return None


def _get_declared_edge(edge: Edge) -> DeclaredEdge | None:
    return next((d for d in _DECLARED_EDGES if (d.source, d.raw) == (edge.source, edge.raw)), None)


def _get_stop(edge: Edge, target: str) -> Stop | str | None:
    """The stop covering this invocation; a message when its target stops but its subcommand not."""
    stops = [stop for stop in _STOPS if (stop.source, stop.target) == (edge.source, target)]
    if not stops:
        return None
    covering = [stop for stop in stops if stop.subcommand in {None, edge.subcommand}]
    if covering:
        return covering[0]
    return f"{edge.source}: {target} {edge.subcommand!r} — no stop declares this subcommand"


@functools.cache
def _get_closure() -> Closure:
    closure = Closure([], set(), set(), set())
    pending = sorted({path for paths in _ROOTS.values() for path in paths} | set(_READERS))
    while pending:
        path = pending.pop()
        if path in closure.walked:
            continue
        closure.walked.add(path)
        edges = _get_edges(path)
        if edges is None:
            closure.failures.append(f"{path}: no shell or python edge scan for this file")
            continue
        for edge in edges:
            target = _get_resolved_target(closure, edge)
            if target is not None:
                pending.extend(_get_walk(closure, edge, target))
    return closure


def _get_resolved_target(closure: Closure, edge: Edge) -> str | None:
    if edge.target is not None:
        return edge.target
    declared = _get_declared_edge(edge)
    if declared is None:
        closure.failures.append(f"{edge.source}: unresolved edge {edge.raw!r}")
        return None
    closure.used_edges.add(declared)
    return declared.target


def _get_walk(closure: Closure, edge: Edge, target: str) -> list[str]:
    stop = _get_stop(edge, target)
    if isinstance(stop, Stop):
        closure.used_stops.add(stop)
        return []
    if isinstance(stop, str):
        closure.failures.append(stop)
        return []
    if target not in _get_tracked():
        closure.failures.append(f"{edge.source}: {edge.raw!r} → {target} is not in the tree")
        return []
    if not _is_scoped(target):
        closure.failures.append(f"{edge.source}: {edge.raw!r} → {target} is outside AA.SCOPE")
        return []
    return [target]


class ClosureTest(unittest.TestCase):
    def test_every_edge_from_the_evidence_path_is_aa_scoped_or_a_declared_stop(self) -> None:
        failures = _get_closure().failures

        self.assertEqual(failures, [], "\n".join(failures))

    def test_every_declared_stop_edge_and_binding_is_met_by_the_walk(self) -> None:
        closure = _get_closure()

        self.assertEqual(sorted(set(_STOPS) - closure.used_stops), [], "stops no edge reaches")
        self.assertEqual(
            sorted(set(_DECLARED_EDGES) - closure.used_edges), [], "edges no walk meets"
        )
        self.assertEqual(sorted(set(_BINDINGS) - _USED_BINDINGS), [], "bindings no edge reads")

    def test_every_stop_names_a_category_from_the_closed_list(self) -> None:
        categories = sorted({stop.category for stop in _STOPS} - _STOP_CATEGORIES)

        self.assertEqual(categories, [])


# -- the retire stop's reason ------------------------------------------------------------------


def _get_shell_array(path: str, name: str) -> set[str]:
    match = re.search(rf"(?:^|\s){name}=\(\s*(.*?)\)", _read(path) or "", re.S)
    if match is None:
        raise AssertionError(f"{path}: no {name}=( … ) array")
    return {word for word in match.group(1).split() if not word.startswith("#")}


class RetireStopTest(unittest.TestCase):
    def test_the_retired_labels_share_none_with_the_running_or_rendered_jobs(self) -> None:
        retired = _get_shell_array("lib/ga-env.sh", "LAUNCHD_RETIRED_JOBS")
        running = _get_shell_array("lib/ga-env.sh", "LAUNCHD_JOBS")
        rendered = _get_shell_array("scripts/render-launchd-plists.sh", "JOBS")

        self.assertTrue(retired)
        self.assertEqual(retired & (running | rendered), set())

    def test_no_code_creates_a_retired_daemon_session(self) -> None:
        sessions = _get_shell_array("lib/ga-env.sh", "GA_DAEMON_SESSIONS")
        creators = [
            path
            for path in _get_code_files()
            if re.search(r"\btmux\s+(?:-\S+\s+)*new(?:-session)?\b", _read(path) or "")
        ]

        self.assertTrue(sessions)
        self.assertEqual(creators, [], "code that creates a tmux session")


if __name__ == "__main__":
    unittest.main()
