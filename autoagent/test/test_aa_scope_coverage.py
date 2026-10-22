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
import collections
import functools
import itertools
import posixpath
import re
import subprocess
import sys
import tempfile
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
    sites: int = 1  # the walk must meet it exactly this often; a new site fails the row


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
_DECLARED_EDGES: tuple[DeclaredEdge, ...] = (
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
        2,
    ),
    DeclaredEdge(
        "autoagent/daemon_cycle.py",
        "claude_bin",
        None,
        "the claude CLI (LLM setup), not a repo file",
        2,
    ),
    DeclaredEdge(
        "autoagent/daemon-cycle.sh",
        "export AUTOAGENT_CLAUDE_BIN",
        None,
        "the claude CLI daemon_cycle.py runs (LLM setup): command -v or a fixed install path",
    ),
    DeclaredEdge(
        "autoagent/daemon-cycle.sh",
        'CLAUDE_BIN="${AUTOAGENT_CLAUDE_BIN}"',
        None,
        "the claude CLI (LLM setup), not a repo file",
    ),
    DeclaredEdge(
        "autoagent/daemon_cycle.py",
        "env=env",
        None,
        "_get_tier_call's os.environ plus data knobs (OTEL_METRICS_EXPORTER, output-token cap)",
        2,
    ),
    DeclaredEdge(
        "autoagent/daemon_cycle.py",
        "ps_bin",
        None,
        "ps or its AUTOAGENT_PS_BIN override, not a repo file",
    ),
)
# env hand-offs the row cannot evaluate; each passes data, never a code path
_DATA_HANDOFFS = {
    "hooks/track-outcome.sh": (
        ('T9_TRANSCRIPT="${T9_TRANSCRIPT_PATH}"', "the transcript the T9 program reads"),
        ('T9_TASK_TYPE="${TASK_TYPE}"', "the outcome's task_type"),
        ('T9_SESSION_ID="${SESSION_ID}"', "the session id"),
        ("export GRADER_BODY_TEXT", "the completion body the grader reads"),
        ("export GRADER_FILES_FIELD", "the completion's files field"),
        ("export GRADER_WRITE_SCAN", "a closed scan token: verifiable, unverifiable or empty"),
        ("export GRADER_WRITE_PATHS", "the transcript's Write/Edit paths"),
        ("export GRADER_CROSSCHECK_STATE_FILE", "a mktemp file the grader writes its token to"),
    ),
    "hooks/enforce-harness-critical.sh": (
        ('HARNESS_CANARY_DIR="${CANARY_DIR}"', "the live canary data dir the guard matches"),
    ),
    "hooks/agent-tracker.sh": (
        ('TIMESTAMP="${TIMESTAMP}"', "the event timestamp"),
        ("IFS=$'\\t'", "a tab field separator for read"),
    ),
    "hooks/advisory-subagent-budget.sh": tuple(
        (f'{name}="${{{value}}}"', "a field of the overage row")
        for name, value in (
            ("AID", "a_id"),
            ("ATYPE", "a_type"),
            ("CNT", "count"),
            ("BUD", "budget"),
            ("PCT", "pct"),
        )
    ),
    "autoagent/daemon-cycle.sh": (
        (
            'AUTOAGENT_AGENTS_DIR="${AUTOAGENT_AGENTS_DIR:-${HOME}/.glass-atrium/agents}"',
            "the roster dir, agents/ in AA.SCOPE.DIRS",
        ),
        ('AUTOAGENT_GIT_ROOT="${AUTOAGENT_GIT_ROOT:-${HOME}/.glass-atrium}"', "the git root dir"),
        ('AUTOAGENT_GIT_PATHSPEC="${AUTOAGENT_GIT_PATHSPEC:-agents/}"', "a git pathspec"),
        ('OUT_PATH="${OUT_PATH}"', "the cycle report's output file"),
        ('CYCLE_DATE="${CYCLE_DATE}"', "the cycle date"),
        ('CYCLE_STARTED_AT="${CYCLE_STARTED_AT}"', "the cycle start time"),
    ),
}
_DECLARED_EDGES += tuple(
    DeclaredEdge(source, raw, None, reason)
    for source, rows in _DATA_HANDOFFS.items()
    for raw, reason in rows
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
    return _get_tracked_in(_REPO_ROOT)


def _get_tracked_in(root: Path) -> frozenset[str]:
    """The tracked set; a root with no ``.git`` of its own skips the asking test."""
    if not (root / ".git").exists():  # a worktree's .git is a file, a clone's a dir
        raise unittest.SkipTest(
            f"not a git work tree: {root} (consumer install — the tracked set needs the GA repo)"
        )
    listing = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        text=True,
        check=True,  # a broken checkout of the repo fails, never skips
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
_EXPORT_VERBS = _DECLARATION_WORDS - {"readonly"}
_ENV_FLAGS = frozenset({"-", "-i", "--ignore-environment", "-v", "--"})
_RESERVED_WORDS = frozenset(
    {"if", "then", "else", "elif", "do", "while", "until", "!", "time", "{"}
)
_NAME = re.compile(r"[A-Za-z_]\w*")
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


def _is_self_reference(match: re.Match[str]) -> bool:
    name = match.group(1)
    return not match.group(2) and _get_raw_value(match.group(3)) in {f"${{{name}}}", f"${name}"}


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
            words = _get_command_start(_get_unredirected(words))
            declared = bool(words) and words[0] in _DECLARATION_WORDS
            for word in words[1:] if declared else words:
                if declared and word.startswith(("-", "+")):
                    continue
                match = _get_assignment_match(word) if declared else _ASSIGNMENT.match(word)
                if match is None and declared:
                    continue  # a bare NAME operand
                if match is None:
                    break
                if _is_self_reference(match):
                    continue  # NAME="${NAME}" re-passes the value it already holds
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
    """A value a child's environment receives; one the row cannot evaluate is unresolved."""
    words = _get_command_start(_get_unredirected(words))
    if words[:1] == ["set"]:
        allexport = _is_allexport(scope, words)
        return [Edge(scope.path, " ".join(words), None, None)] if allexport else []
    if words[:1] and words[0] in _EXPORT_VERBS:
        return _get_export_edges(scope, words)
    return _get_prefix_edges(scope, words)


def _is_allexport(scope: _ShellScope, words: list[str]) -> bool:
    """``set`` turns allexport on: ``-…a…``, ``o`` naming it, or an unreadable operand."""
    rest = iter(words[1:])
    for operand in rest:
        word = scope.evaluate(operand) if "$" in operand else operand
        if word is None:
            return True  # an expansion bash may read as flags
        if word in {"", "-", "--"} or word[0] not in "-+":
            return False  # the rest are positional parameters
        for letter in word[1:]:
            option = next(rest, "") if letter == "o" else letter
            if "$" in option:
                option = scope.evaluate(option) or "allexport"
            if word[0] == "-" and option in {"a", "allexport"}:
                return True
    return False


def _get_command_start(words: list[str]) -> list[str]:
    """Words past reserved words, a ``function NAME`` header and ``time -p``."""
    index = 0
    while index < len(words):
        if words[index] == "function":
            index += 2
        elif words[index] in _RESERVED_WORDS or words[index - 1 : index + 1] == ["time", "-p"]:
            index += 1
        else:
            break
    return words[index:]


def _get_prefix_edges(scope: _ShellScope, words: list[str]) -> list[Edge]:
    """Assignments before the command word, and the operands of ``env`` wherever it runs."""
    handed = list(itertools.takewhile(_ASSIGNMENT.match, words))
    rest = words[len(handed) :]
    if not rest:
        return []
    if _is_eval(rest):
        return [Edge(scope.path, " ".join(words), None, None)]  # its text is no parsed command
    env = next((i for i, word in enumerate(rest) if _is_env(word)), None)
    unread: list[Edge] = []
    if env is not None:
        env_handed, unread = _get_env_operands(scope, rest[env + 1 :])
        handed += env_handed
    return [edge for word in handed for edge in _get_assignment_edges(scope, word)] + unread


def _is_eval(words: list[str]) -> bool:
    command = list(itertools.dropwhile({"command", "builtin"}.__contains__, words))
    return command[:1] == ["eval"]


def _is_env(word: str) -> bool:
    return posixpath.basename(_get_raw_value(word)) == "env"


def _get_env_operands(scope: _ShellScope, words: list[str]) -> tuple[list[str], list[Edge]]:
    """``env``'s assignments up to its command; an unreadable option or expansion is unresolved."""
    handed: list[str] = []
    edges: list[Edge] = []
    rest = iter(words)
    for word in rest:
        if _get_assignment_match(word):
            handed.append(word)
        elif word == "-u":
            next(rest, None)
        elif word.startswith("-") and word not in _ENV_FLAGS:
            edges.append(Edge(scope.path, f"env {word}", None, None))  # -S, -C … reshape argv
            if word in {"-S", "-C", "-P"}:
                next(rest, None)  # the option's own argument
        elif word.startswith(("$", '"$')):
            value = scope.evaluate(word)  # env reads an expanded NAME=value as an assignment
            if value is None or _ASSIGNMENT.match(value) is None:
                edges += [] if value is not None else [Edge(scope.path, f"env {word}", None, None)]
                break
            assigned = _get_assignment_edges(scope, value)
            edges += [edge._replace(raw=f"env {word}") for edge in assigned]
        elif word not in _ENV_FLAGS:
            break
    return handed, edges


def _get_export_edges(scope: _ShellScope, words: list[str]) -> list[Edge]:
    """``export`` operands, or ``declare``/``typeset``/``local`` operands under ``-x``."""
    flags = list(itertools.takewhile(lambda word: word[0] in "-+", words[1:]))
    letters = "".join(flag for flag in flags if flag.startswith("-"))
    if (words[0] != "export" and "x" not in letters) or set(letters) & {"n", "f", "p"}:
        return []  # not exported, export removed, a function of this file, or a listing
    verb = " ".join(words[: 1 + len(flags)])
    edges: list[Edge] = []
    for word in words[1 + len(flags) :]:
        if _get_assignment_match(word):
            edges.extend(_get_assignment_edges(scope, word))
        elif _NAME.fullmatch(word):
            edges.extend(_get_value_edges(scope, f"{verb} {word}", f"${{{word}}}"))
        else:
            edges.append(Edge(scope.path, word, None, None))
    return edges


def _get_assignment_match(word: str) -> re.Match[str] | None:
    """``NAME=value`` as a builtin or ``env`` reads it, quotes around the name or ``=`` removed."""
    return _ASSIGNMENT.match(word) or _ASSIGNMENT.match(_get_unquoted_assignment(word) or "")


def _get_unquoted_assignment(word: str) -> str | None:
    name = ""
    quote = ""
    index = 0
    while index < len(word):
        char = word[index]
        if char == "\\" and quote != "'":
            if word[index + 1 : index + 2] == "=":
                index += 1
                break
            name, index = name + word[index + 1 : index + 2], index + 2
        elif char in "\"'" and quote in {"", char}:
            quote, index = ("" if quote else char), index + 1
        elif char == "=":
            break
        else:
            name, index = name + char, index + 1
    else:
        return None
    return f"{name}={quote}{word[index + 1 :]}" if _NAME.fullmatch(name) else None


def _get_assignment_edges(scope: _ShellScope, word: str) -> list[Edge]:
    match = _get_assignment_match(word)
    if match is None or match.group(2):
        return [Edge(scope.path, word, None, None)]  # += hands off a value the row never sees
    return _get_value_edges(scope, word, match.group(3))


def _get_value_edges(scope: _ShellScope, raw: str, word: str) -> list[Edge]:
    value = scope.evaluate(word)
    if value is None:
        return [Edge(scope.path, raw, None, None)]
    return _get_handed_value_edges(scope.path, raw, value)


def _get_handed_value_edges(source: str, raw: str, value: str) -> list[Edge]:
    """A known value a child receives: code is an edge; a dir or bare code name unresolved."""
    if "/" not in value:
        bare = value.endswith(_CODE_SUFFIXES)  # resolved against the child's cwd, never known
        return [Edge(source, raw, None, None)] if bare else []
    if value.endswith(_CODE_SUFFIXES):
        return [Edge(source, raw, _get_repo_path(value), None)]
    path = _get_repo_path(f"{value.rstrip('/')}/")
    if path in _get_tracked():
        return [Edge(source, raw, path, None)] if _get_language(path) else []
    if path is not None and (path == "." or any(t.startswith(f"{path}/") for t in _get_tracked())):
        return [Edge(source, raw, None, None)]  # a dir: the child may load any file in it
    return []


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


def _get_unredirected(words: list[str]) -> list[str]:
    """Words with redirections and a redirection's separate target dropped."""
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
        kept.append(word)
    return kept


def _get_command_words(words: list[str]) -> list[str]:
    """Words of a command with redirections and leading assignments or prefix words dropped."""
    words = _get_unredirected(words)
    kept: list[str] = []
    for word in words:
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
_ENVIRONS = frozenset({"os.environ", "environ"})
_ENV_POSITIONS = {  # the argument an os process call takes its child's environment from
    **dict.fromkeys(("execve", "execvpe", "posix_spawn", "posix_spawnp"), 2),
    **dict.fromkeys(("spawnve", "spawnvpe"), 3),
    **dict.fromkeys(("execle", "execlpe", "spawnle", "spawnlpe"), -1),
}


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
        edges.extend(_get_python_handoff_edges(scope, node))
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
    if not _is_run_call(node):
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


def _is_run_call(node: ast.Call) -> bool:
    name = ast.unparse(node.func)
    tail = name.rsplit(".", 1)[-1]
    return tail in _RUN_CALLS and (name.startswith(("subprocess.", "asyncio.")) or name == tail)


def _get_python_handoff_edges(scope: _PythonScope, node: ast.AST) -> list[Edge]:
    """Values a child's environment receives: ``env=``, ``os.environ`` writes, ``putenv``."""
    match node:
        case ast.Call(func=func, args=args, keywords=keywords):
            name = ast.unparse(func)
            env = next((k.value for k in keywords if k.arg == "env"), None)
            if env is not None and _is_run_call(node):
                return _get_mapping_edges(scope, "env", env)
            position = _ENV_POSITIONS.get(name.removeprefix("os."))
            if env is not None and position is not None:
                return _get_mapping_edges(scope, name, env)
            if position is not None and len(args) > max(position, 2):
                return _get_mapping_edges(scope, name, args[position])
            if name in {f"{e}.update" for e in _ENVIRONS}:
                pairs = [*args, *(ast.Dict([ast.Constant(k.arg)], [k.value]) for k in keywords)]
                return [edge for arg in pairs for edge in _get_mapping_edges(scope, name, arg)]
            if name in {"os.putenv", *(f"{e}.setdefault" for e in _ENVIRONS)} and len(args) > 1:
                return _get_python_value_edges(scope, ast.unparse(node), args[1])
        case ast.Assign(targets=targets, value=value):
            return [
                edge
                for target in targets
                if isinstance(target, ast.Subscript) and ast.unparse(target.value) in _ENVIRONS
                for edge in _get_python_value_edges(scope, ast.unparse(target), value)
            ]
        case ast.AugAssign(target=target, value=value) if ast.unparse(target) in _ENVIRONS:
            return _get_mapping_edges(scope, ast.unparse(target), value)
    return []


def _get_mapping_edges(scope: _PythonScope, prefix: str, node: ast.expr) -> list[Edge]:
    """Items of a mapping handed to a child; ``**os.environ`` passes the inherited env through."""
    if ast.unparse(node) in _ENVIRONS:
        return []
    if not isinstance(node, ast.Dict):
        return [Edge(scope.path, f"{prefix}={ast.unparse(node)}", None, None)]
    edges: list[Edge] = []
    for key, value in zip(node.keys, node.values, strict=True):
        if key is None:
            edges.extend(_get_mapping_edges(scope, f"{prefix}**", value))
        else:
            edges.extend(_get_python_value_edges(scope, f"{prefix}[{ast.unparse(key)}]", value))
    return edges


def _get_python_value_edges(scope: _PythonScope, raw: str, node: ast.expr) -> list[Edge]:
    value = scope.evaluate(node)
    if value is None:
        return [Edge(scope.path, raw, None, None)]
    return _get_handed_value_edges(scope.path, raw, value)


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
    used_edges: collections.Counter[DeclaredEdge]
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
    closure = Closure([], set(), collections.Counter(), set())
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


def _get_site_mismatches(
    used: collections.Counter[DeclaredEdge],
) -> dict[tuple[str, str], tuple[int, int]]:
    """Declared edges the walk meets at a site count other than the declared one."""
    return {
        (edge.source, edge.raw): (edge.sites, used[edge])
        for edge in _DECLARED_EDGES
        if used[edge] != edge.sites
    }


def _get_resolved_target(closure: Closure, edge: Edge) -> str | None:
    if edge.target is not None:
        return edge.target
    declared = _get_declared_edge(edge)
    if declared is None:
        closure.failures.append(f"{edge.source}: unresolved edge {edge.raw!r}")
        return None
    closure.used_edges[declared] += 1
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
        self.assertEqual(_get_site_mismatches(closure.used_edges), {}, "edges met off count")
        self.assertEqual(sorted(set(_BINDINGS) - _USED_BINDINGS), [], "bindings no edge reads")

    def test_every_aa_scope_file_is_reached_by_the_walk(self) -> None:
        unreached = sorted(dc.AA.SCOPE.FILES - _get_closure().walked)

        self.assertEqual(unreached, [], "members only the hand list holds")

    def test_every_reader_the_walk_starts_from_is_aa_scoped(self) -> None:
        unscoped = [path for path in _READERS if not _is_scoped(path)]

        self.assertEqual(unscoped, [])

    def test_every_stop_names_a_category_from_the_closed_list(self) -> None:
        categories = sorted({stop.category for stop in _STOPS} - _STOP_CATEGORIES)

        self.assertEqual(categories, [])


_UNKNOWN = '"$(pick)"'
_CODE_VALUE = '"${HOME}/.glass-atrium/hooks/lib/style_ref_match.py"'
_HANDOFF_ROWS = (
    ("command-prefix assignment", f"A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    (
        "prefix after a reserved word",
        f"if A={_UNKNOWN} ./run.sh; then :; fi",
        [(f"A={_UNKNOWN}", None)],
    ),
    ("export with its assignment", f"export A={_UNKNOWN}", [(f"A={_UNKNOWN}", None)]),
    ("bare export of an earlier assignment", f"A={_UNKNOWN}\nexport A", [("export A", None)]),
    (
        "bare export resolves the assigned code path",
        f"LIB={_CODE_VALUE}\nexport LIB",
        [("export LIB", "hooks/lib/style_ref_match.py")],
    ),
    (
        "one export of several names",
        f"A={_UNKNOWN}\nB={_UNKNOWN}\nexport A B",
        [("export A", None), ("export B", None)],
    ),
    ("env operand", f"env A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    ("env operand after an option", f"env -i A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    ("env option the row cannot read", "env -S 'A=1 ./run.sh'", [("env -S", None)]),
    ("declare -x", f"declare -x A={_UNKNOWN}", [(f"A={_UNKNOWN}", None)]),
    ("local -x", f"local -x A={_UNKNOWN}", [(f"A={_UNKNOWN}", None)]),
    ("typeset -x", f"typeset -x A={_UNKNOWN}", [(f"A={_UNKNOWN}", None)]),
    ("combined -gx flags", f"declare -gx A={_UNKNOWN}", [(f"A={_UNKNOWN}", None)]),
    (
        "bare declare -x of an earlier assignment",
        f"A={_UNKNOWN}\ndeclare -x A",
        [("declare -x A", None)],
    ),
    (
        "a suffixless tracked file",
        'export E="${HOME}/.glass-atrium/glass-atrium"',
        [('E="${HOME}/.glass-atrium/glass-atrium"', "glass-atrium")],
    ),
    (
        "a tracked directory a child may load any file from",
        'export D="${HOME}/.glass-atrium/hooks/lib"',
        [('D="${HOME}/.glass-atrium/hooks/lib"', None)],
    ),
    ("a data path outside the tree", 'export F="${HOME}/.glass-atrium/data/x.json"', []),
    ("a plain word value", "LC_ALL=C sort", []),
    ("set -a exports every later assignment", "set -a", [("set -a", None)]),
    ("set -o allexport", "set -o allexport", [("set -o allexport", None)]),
    ("env behind exec", f"exec env A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    ("env behind command", f"command env A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    ("env behind nohup", f"nohup env A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    ("env behind timeout", f"timeout 5 env A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    ("env by absolute path", f"/usr/bin/env A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    (
        "redirect before the assignment",
        f"2>/dev/null A={_UNKNOWN} ./run.sh",
        [(f"A={_UNKNOWN}", None)],
    ),
    (
        "redirect target as its own word",
        f"2> /dev/null A={_UNKNOWN} ./run.sh",
        [(f"A={_UNKNOWN}", None)],
    ),
    (
        "one-line function keyword body",
        f"function f {{ A={_UNKNOWN} ./run.sh; }}",
        [(f"A={_UNKNOWN}", None)],
    ),
    ("one-line f() body", f"f() {{ A={_UNKNOWN} ./run.sh; }}", [(f"A={_UNKNOWN}", None)]),
    ("time -p", f"time -p A={_UNKNOWN} ./run.sh", [(f"A={_UNKNOWN}", None)]),
    (
        "eval runs text the row cannot read",
        f'eval "export A={_UNKNOWN}"',
        [(f'eval "export A={_UNKNOWN}"', None)],
    ),
    (
        "an install root",
        'export R="${HOME}/.glass-atrium"',
        [('R="${HOME}/.glass-atrium"', None)],
    ),
    (
        "a tracked data file",
        'export B="${HOME}/.glass-atrium/agents/glass-atrium-qa-code-reviewer.md"',
        [],
    ),
    ("an assignment after a wrapper is its command name", f"exec A={_UNKNOWN} ./run.sh", []),
    ("env as a plain argument", "grep env notes.txt", []),
    ("set +o allexport", "set +o allexport", []),
    (
        "prefix self-assignment re-passes the file value",
        'LIB="${BASH_SOURCE%/*}/lib/style_ref_match.py"\nLIB="${LIB}" python3 x.py',
        [('LIB="${LIB}"', "hooks/lib/style_ref_match.py")],
    ),
    (
        "bare export of conditional assignments",
        f'if c; then\n  B={_UNKNOWN}\nelse\n  B="/opt/homebrew/bin/claude"\nfi\nexport B',
        [("export B", None)],
    ),
    (
        "an assignment after a reserved word is a second value",
        f"B={_CODE_VALUE}\nif c; then B={_UNKNOWN}; fi\nexport B",
        [("export B", None)],
    ),
    (
        "an assignment after a redirect is a second value",
        f"B={_CODE_VALUE}\n2>/dev/null B={_UNKNOWN}\nexport B",
        [("export B", None)],
    ),
    ("env operand from an array", 'env "${ARR[@]}" ./run.sh', [('env "${ARR[@]}"', None)]),
    (
        "env operand from a variable holding an assignment",
        'PAIR="LIB=${HOME}/.glass-atrium/hooks/lib/style_ref_match.py"\nenv "${PAIR}" ./run.sh',
        [('env "${PAIR}"', "hooks/lib/style_ref_match.py")],
    ),
    ("env operand from a variable naming the command", 'CMD="./run.sh"\nenv "${CMD}" -x', []),
    ("set -euo allexport", "set -euo allexport", [("set -euo allexport", None)]),
    ("set -eo allexport", "set -eo allexport", [("set -eo allexport", None)]),
    ("set -euo pipefail", "set -euo pipefail", []),
    ("set -o pipefail", "set -o pipefail", []),
    ("set -- after which -a is an argument", "set -- -a", []),
    (
        "a tracked JS file",
        'export M="${HOME}/.glass-atrium/monitor/public/src/app.jsx"',
        [('M="${HOME}/.glass-atrium/monitor/public/src/app.jsx"', "monitor/public/src/app.jsx")],
    ),
    ("a bare code filename the child resolves", "export L=helper.py", [("L=helper.py", None)]),
    ("env operand quoted whole", 'env "A=$(pick)" ./run.sh', [('"A=$(pick)"', None)]),
    (
        "env operand quoted whole with an unknown name",
        'env "A=${X}" ./run.sh',
        [('"A=${X}"', None)],
    ),
    (
        "env operand quoted whole after --",
        'env -- "LIB=${HOME}/.glass-atrium/hooks/lib/style_ref_match.py" ./run.sh',
        [
            (
                '"LIB=${HOME}/.glass-atrium/hooks/lib/style_ref_match.py"',
                "hooks/lib/style_ref_match.py",
            ),
        ],
    ),
    (
        "env operand single-quoted whole",
        "env 'LIB=hooks/lib/style_ref_match.py' ./run.sh",
        [("'LIB=hooks/lib/style_ref_match.py'", "hooks/lib/style_ref_match.py")],
    ),
    ("env operand with a quoted name", 'env "A"=$(pick) ./run.sh', [('"A"=$(pick)', None)]),
    ("env operand with an escaped =", "env A\\=$(pick) ./run.sh", [("A\\=$(pick)", None)]),
    ("env operand in ANSI-C quotes", "env $'A=1' ./run.sh", [("env $'A=1'", None)]),
    ("export operand quoted whole", f'export "A=$(pick)"', [('"A=$(pick)"', None)]),
    (
        "export operand single-quoted code path",
        "export 'LIB=hooks/lib/style_ref_match.py'",
        [("'LIB=hooks/lib/style_ref_match.py'", "hooks/lib/style_ref_match.py")],
    ),
    ("export operand single-quoted data", "export 'A=1'", []),
    ("export operand with an escaped =", "export A\\=1", []),
    ("declare -x operand with a quoted name", 'declare -x "A"=$(pick)', [('"A"=$(pick)', None)]),
    (
        "a quoted declare operand is a second value",
        f'B={_CODE_VALUE}\ndeclare "B=$(pick)"\nexport B',
        [("export B", None)],
    ),
    (
        "an assignment after a bare declared name is a second value",
        f"B={_CODE_VALUE}\nlocal x B={_UNKNOWN}\nexport B",
        [("export B", None)],
    ),
    (
        "a quoted prefix word is the command",
        'A="$(pick)" "B=$(pick)" ./run.sh',
        [('A="$(pick)"', None)],
    ),
    ("an escaped = in a prefix word is the command", "A\\=$(pick) ./run.sh", []),
    ("set -o with an unreadable name", 'set -o "$MODE"', [('set -o "$MODE"', None)]),
    ("set with an unreadable flag word", 'set "$FLAGS"', [('set "$FLAGS"', None)]),
    ("set -o with a readable name", 'OPT=pipefail\nset -o "${OPT}"', []),
    ("set -- before an expansion", 'set -- "$@"', []),
    ("plain assignment", f"A={_UNKNOWN}", []),
    ("local without -x", f"local A={_UNKNOWN}", []),
    ("export -n removes the export", f"A={_UNKNOWN}\nexport -n A", []),
    ("declare +x removes the export", f"A={_UNKNOWN}\ndeclare +x A", []),
    ("export -f hands off a function of this file", "export -f helper", []),
    ("set +a", "set +a", []),
)

_PYTHON_HANDOFF_ROWS = (
    ("env= value unknown", 'subprocess.run(["x"], env={"A": pick()})', [("env['A']", None)]),
    (
        "env= value a code path",
        'subprocess.run(["x"], env={"LIB": "hooks/lib/style_ref_match.py"})',
        [("env['LIB']", "hooks/lib/style_ref_match.py")],
    ),
    (
        "env= carrying os.environ and data",
        'subprocess.run(["x"], env={**os.environ, "A": "1"})',
        [],
    ),
    (
        "env= a mapping the row cannot read",
        'tier_argv, env = _get_tier_call("worker")\nsubprocess.run(tier_argv, env=env)',
        [("env=env", None)],
    ),
    ("os.environ item write", 'os.environ["A"] = pick()', [("os.environ['A']", None)]),
    (
        "os.environ.update",
        'os.environ.update({"A": pick()}, B=pick())',
        [("os.environ.update['A']", None), ("os.environ.update['B']", None)],
    ),
    (
        "os.environ.setdefault",
        'os.environ.setdefault("A", pick())',
        [("os.environ.setdefault('A', pick())", None)],
    ),
    ("os.putenv", 'os.putenv("A", pick())', [("os.putenv('A', pick())", None)]),
    ("os.execve", 'os.execve("/bin/sh", ["sh"], {"A": pick()})', [("os.execve['A']", None)]),
    ("os.execvpe", 'os.execvpe("sh", ["sh"], child_env)', [("os.execvpe=child_env", None)]),
    (
        "os.execle",
        'os.execle("/bin/sh", "sh", "-c", ":", child_env)',
        [("os.execle=child_env", None)],
    ),
    (
        "os.spawnve",
        'os.spawnve(os.P_WAIT, "/bin/sh", ["sh"], {"A": pick()})',
        [("os.spawnve['A']", None)],
    ),
    (
        "os.spawnlpe",
        'os.spawnlpe(os.P_WAIT, "sh", "sh", child_env)',
        [("os.spawnlpe=child_env", None)],
    ),
    (
        "os.posix_spawn",
        'os.posix_spawn("/bin/sh", ["sh"], child_env)',
        [("os.posix_spawn=child_env", None)],
    ),
    ("os.execv takes no env", 'os.execv("/bin/sh", ["sh"])', []),
    (
        "os.execve env= keyword",
        'os.execve("/bin/sh", ["sh"], env=child_env)',
        [("os.execve=child_env", None)],
    ),
    (
        "os.execvpe env= keyword",
        'os.execvpe("sh", ["sh"], env={"A": pick()})',
        [("os.execvpe['A']", None)],
    ),
    (
        "os.spawnve env= keyword",
        'os.spawnve(os.P_WAIT, "/bin/sh", ["sh"], env=child_env)',
        [("os.spawnve=child_env", None)],
    ),
    ("an environ read", 'value = os.environ["A"]', []),
    ("a run call with no env=", 'subprocess.run(["x"])', []),
    ("env= on a call that runs no child", 'render(env={"A": pick()})', []),
)


class HandoffShapeTest(unittest.TestCase):
    def test_every_value_a_child_environment_receives_is_an_edge_and_an_unknown_one_unresolved(
        self,
    ) -> None:
        for name, text, expected in _HANDOFF_ROWS:
            with self.subTest(name):
                scope = _ShellScope("hooks/fixture.sh", text)
                edges = [
                    (edge.raw, edge.target)
                    for words in scope.commands
                    for edge in _get_handoff_edges(scope, words)
                ]

                self.assertEqual(edges, expected)

    def test_a_declared_edge_met_at_any_other_site_count_is_reported(self) -> None:
        declared = {edge: edge.sites for edge in _DECLARED_EDGES}
        env = next(edge for edge in _DECLARED_EDGES if edge.raw == "env=env")
        rows = (
            ("every declared site met", {}, {}),
            ("a third site of a two-site declaration", {env: 3}, {(env.source, env.raw): (2, 3)}),
            ("a declared site no walk meets", {env: 0}, {(env.source, env.raw): (2, 0)}),
        )
        for name, change, expected in rows:
            with self.subTest(name):
                used = collections.Counter({**declared, **change})

                self.assertEqual(_get_site_mismatches(used), expected)

    def test_every_value_a_python_child_environment_receives_is_an_edge(self) -> None:
        for name, text, expected in _PYTHON_HANDOFF_ROWS:
            with self.subTest(name):
                tree = ast.parse(text)
                scope = _PythonScope("hooks/fixture.py", tree)
                edges = [
                    (edge.raw, edge.target)
                    for node in ast.walk(tree)
                    for edge in _get_python_handoff_edges(scope, node)
                ]

                self.assertEqual(edges, expected)


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


class TrackedTreeTest(unittest.TestCase):
    """Every fixture is scratch-built: the real tree's layout differs per install."""

    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name)

    def test_a_root_without_its_own_git_dir_skips_with_the_reason(self) -> None:
        repo = self._get_repo("repo")
        (repo / "sub").mkdir()
        (self.scratch / "plain").mkdir()
        rows = (
            ("a directory outside any work tree", self.scratch / "plain"),
            ("a subdirectory of a work tree", repo / "sub"),
        )
        for name, root in rows:
            with self.subTest(name):
                with self.assertRaises(unittest.SkipTest) as raised:
                    _get_tracked_in(root)

                self.assertIn("not a git work tree", str(raised.exception))

    def test_a_root_with_its_own_git_dir_lists_its_index(self) -> None:
        repo = self._get_repo("repo")
        (repo / "kept.sh").write_text("true\n", encoding="utf-8")
        (repo / "untracked.sh").write_text("true\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "kept.sh"], check=True)

        self.assertEqual(_get_tracked_in(repo), {"kept.sh"})

    def test_a_root_whose_own_git_dir_is_broken_fails_loudly(self) -> None:
        repo = self._get_repo("broken")
        (repo / ".git" / "HEAD").write_text("not a ref\n", encoding="utf-8")

        with self.assertRaises(subprocess.CalledProcessError):
            self._get_tracked_unskipped(repo)

    def _get_repo(self, name: str) -> Path:
        repo = self.scratch / name
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        return repo

    def _get_tracked_unskipped(self, root: Path) -> frozenset[str]:
        try:
            return _get_tracked_in(root)
        except unittest.SkipTest as skipped:
            self.fail(f"a broken checkout skipped as a consumer install: {skipped}")


if __name__ == "__main__":
    unittest.main()
