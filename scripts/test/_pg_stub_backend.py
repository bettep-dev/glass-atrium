"""In-process stdlib backend for the _pg_dual_write_daemon.py statements.

Why this exists: no merge-gating CI leg gives Postgres — or psycopg — to Python,
so a criterion that needs a live database cannot fail the gate. The helper
re-raises ImportError when psycopg is absent, so on those legs it does not even
import and there is no module-global connection name left to substitute. This
module fabricates the psycopg surface in sys.modules FIRST, so the helper
imports, and its `psycopg.connect` resolves to a sqlite3-backed stand-in.

Two delivery modes, ONE engine: an in-process consumer takes the fabricated
sys.modules surface, and a subprocess consumer — which cannot be handed
sys.modules — takes an on-disk package that re-exports this module. Neither
restates the other, so they cannot drift.

Every table here is read, never declared: columns come from the Prisma model and
index DDL from the migration SQL, so a key that leaves the model for a raw-SQL
predicate is still the key a pin conflicts on.

The helper's SQL text is never re-implemented here: two mechanical rewrites
(PG cast suffixes, pyformat placeholders) hand the REAL statement to a real SQL
engine, so the conditional arms under test are the ones that ship. The attached
file database is aliased as `core`, so the schema-qualified table name and the
conflict arm's self-referencing `core.autoagent_proposals.<column>` run verbatim.

What it cannot see, so nothing here may claim it: the date-typed cycle_date
column and its cast, the driver's type adaptation, and real concurrency. Those
stay live-Postgres verification steps, not acceptance criteria.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sqlite3
import sys
from contextlib import closing, contextmanager
from pathlib import Path
from types import ModuleType

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
_HELPER = _SCRIPTS_ROOT / "_pg_dual_write_daemon.py"
_SCHEMA = _SCRIPTS_ROOT.parent / "monitor" / "prisma" / "schema.prisma"
_MIGRATIONS = _SCRIPTS_ROOT.parent / "monitor" / "prisma" / "migrations"

# The schema a table-creating connection opens its file as — sqlite takes the
# qualifier on the index NAME, where Postgres puts it on the table.
_TABLE_SCHEMA = "main"

# The subprocess consumer names its sqlite file here; it cannot be handed one.
SQLITE_PATH_ENV = "GA_PIN_SQLITE"

_PROPOSALS_TABLE = "autoagent_proposals"
_PROPOSALS_KEY = ("cycle_date", "pattern_label", "target_file")
_LOOP_EVENTS_TABLE = "autoagent_loop_events"

_CAST = re.compile(r'::(?:\w+\.)?"?\w+"?')
_NAMED = re.compile(r"%\((\w+)\)s")
_MODEL_BLOCK = r"^model %s \{$(.*?)^\}$"
_FIELD = re.compile(r"^\s+(\w+)\s+(\w+)(\?)?(\[\])?(.*)$")
_MAPPED = re.compile(r'@map\("(\w+)"\)')
# One alternation, so CREATE and DROP keep their relative order within a file.
_INDEX_STMT = re.compile(
    r'DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:"\w+"\.)?"(?P<dropped>\w+)"\s*;'
    r'|CREATE\s+(?P<unique>UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?'
    r'(?:"\w+"\.)?"(?P<name>\w+)"\s+ON\s+(?:"\w+"\.)?"(?P<table>\w+)"'
    r'(?P<tail>[^;]*);',
    re.I,
)


def _rewrite(sql: str) -> str:
    """Cast-stripped, qmark-parameterised copy of the caller's own statement."""
    return _NAMED.sub(r":\1", _CAST.sub("", sql)).replace("%s", "?")


class _Cursor:
    def __init__(self, inner: sqlite3.Cursor) -> None:
        self._inner = inner
        self.rowcount = -1

    def __enter__(self) -> "_Cursor":
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        try:
            self._inner.execute(_rewrite(sql), params if params is not None else ())
        except sqlite3.OperationalError as exc:
            # PG signals a missing column as SQLSTATE 42703, which psycopg raises as
            # UndefinedColumn; sqlite signals it in the message text only. Translating
            # that ONE message is what puts a caller's degradation arm under a real
            # engine — every other sqlite fault surfaces unchanged, so this cannot
            # green a failure the caller was supposed to see.
            if "no such column" in str(exc):
                raise UndefinedColumn(str(exc)) from exc
            raise
        self.rowcount = self._inner.rowcount

    def fetchone(self):
        return self._inner.fetchone()

    def fetchall(self):
        return self._inner.fetchall()


class _Connection:
    def __init__(self, db_path: Path) -> None:
        self._db = sqlite3.connect(":memory:")
        # ATTACH aliases the file as schema `core` → a caller's schema-qualified
        # `core.<table>` runs verbatim, with no table-name rewrite.
        self._db.execute("ATTACH DATABASE ? AS core", (str(db_path),))

    def __enter__(self) -> "_Connection":
        return self

    def __exit__(self, *exc_info: object) -> bool:
        self._db.close()
        return False

    def cursor(self) -> _Cursor:
        return _Cursor(self._db.cursor())

    def commit(self) -> None:
        self._db.commit()

    def rollback(self) -> None:
        self._db.rollback()


class Error(Exception):
    pass


class OperationalError(Error):
    pass


class IntegrityError(Error):
    pass


class UndefinedColumn(Error):
    pass


class Jsonb:
    """Adapter placeholder — the stdlib engine cannot bind it, so tests pass None."""

    def __init__(self, obj: object) -> None:
        self.obj = obj


def create_connection(db_path: Path) -> _Connection:
    """A psycopg-shaped connection over one sqlite file — the in-process seam."""
    return _Connection(db_path)


def connect(conninfo: object = None, **kwargs: object) -> _Connection:
    """psycopg.connect for a subprocess consumer: the file named by SQLITE_PATH_ENV."""
    return _Connection(Path(os.environ[SQLITE_PATH_ENV]))


_PACKAGE_INIT = '''"""psycopg stand-in for a subprocess consumer — the shared backend, re-exported.

Generated by _pg_stub_backend.create_psycopg_package. The SQL engine is defined
once, in that module, and never restated here.
"""

import sys

sys.path.insert(0, {backend_dir!r})

from _pg_stub_backend import (  # noqa: E402 — anchored by the insert above
    Error,
    IntegrityError,
    OperationalError,
    UndefinedColumn,
    connect,
)
'''

_ERRORS_MODULE = '''"""psycopg.errors surface: the classes a caller's degradation arm branches on."""

from _pg_stub_backend import Error, IntegrityError, OperationalError, UndefinedColumn

__all__ = ["Error", "IntegrityError", "OperationalError", "UndefinedColumn"]
'''

_JSON_MODULE = '''"""psycopg.types.json surface: the adapter placeholder, re-exported."""

from _pg_stub_backend import Jsonb

__all__ = ["Jsonb"]
'''


def create_psycopg_package(root: Path) -> Path:
    """Materialise an importable `psycopg` package under root, and return its path.

    For a consumer the caller reaches by subprocess: it cannot be handed a
    sys.modules surface, so it gets one on disk that re-exports this module.
    """
    pkg = root / "psycopg"
    (pkg / "types").mkdir(parents=True)
    (pkg / "__init__.py").write_text(
        _PACKAGE_INIT.format(backend_dir=str(Path(__file__).resolve().parent)),
        encoding="utf-8",
    )
    (pkg / "errors.py").write_text(_ERRORS_MODULE, encoding="utf-8")
    (pkg / "types" / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "types" / "json.py").write_text(_JSON_MODULE, encoding="utf-8")
    return pkg


def _build_stub_modules(db_path: Path) -> dict[str, object]:
    """The psycopg surface the helper touches at import time, and nothing more."""
    psycopg = ModuleType("psycopg")
    psycopg.connect = lambda conninfo, **kwargs: create_connection(db_path)

    errors = ModuleType("psycopg.errors")
    for name in ("Error", "OperationalError", "IntegrityError", "UndefinedColumn"):
        surface = globals()[name]
        setattr(psycopg, name, surface)
        setattr(errors, name, surface)
    psycopg.errors = errors

    types_pkg = ModuleType("psycopg.types")
    json_mod = ModuleType("psycopg.types.json")
    json_mod.Jsonb = Jsonb
    types_pkg.json = json_mod
    psycopg.types = types_pkg

    return {
        "psycopg": psycopg,
        "psycopg.errors": errors,
        "psycopg.types": types_pkg,
        "psycopg.types.json": json_mod,
    }


def _get_model_columns(model: str) -> list[str]:
    """Column names of one Prisma model's table, read off the model block.

    Read rather than remembered: a hand-copied list agrees with itself forever
    and drifts on the next migration.
    """
    block = re.search(
        _MODEL_BLOCK % model, _SCHEMA.read_text(encoding="utf-8"), re.M | re.S
    )
    if block is None:
        raise AssertionError("%s model not found in %s" % (model, _SCHEMA))

    columns: list[str] = []
    for line in block.group(1).splitlines():
        field = _FIELD.match(line)
        if field is None or line.lstrip().startswith(("//", "@@")):
            continue
        name, _type, _optional, is_list, tail = field.groups()
        if is_list:
            continue  # relation field, not a column
        mapped = _MAPPED.search(tail)
        columns.append(
            mapped.group(1)
            if mapped
            else re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
        )
    return columns


def create_proposals_table(db_path: Path) -> None:
    """Create core.autoagent_proposals with the dedup key the ON CONFLICT names."""
    columns = _get_model_columns("AutoagentProposal")
    missing = [c for c in _PROPOSALS_KEY if c not in columns]
    if missing:
        raise AssertionError("schema parse lost the dedup key columns: %s" % missing)

    declared = ", ".join(
        "id INTEGER PRIMARY KEY" if column == "id" else "%s TEXT" % column
        for column in columns
    )
    with closing(sqlite3.connect(db_path)) as db:
        db.execute(
            "CREATE TABLE %s (%s, UNIQUE(%s))"
            % (_PROPOSALS_TABLE, declared, ", ".join(_PROPOSALS_KEY))
        )
        db.commit()


def _get_index_ddl(stmt: re.Match) -> str:
    """One CREATE INDEX statement respelled for sqlite, predicate included.

    sqlite takes `[schema.]index-name ON table-name`, so the Postgres spelling
    `INDEX "x" ON "core"."t"` is a syntax error there — the qualifier moves to the
    index name and the column list and any WHERE predicate are handed over untouched.
    """
    return 'CREATE %sINDEX "%s"."%s" ON "%s"%s' % (
        "UNIQUE " if stmt.group("unique") else "",
        _TABLE_SCHEMA,
        stmt.group("name"),
        stmt.group("table"),
        stmt.group("tail"),
    )


def _get_table_indexes(table: str) -> dict[str, str]:
    """Live index DDL for one table, replayed over the migrations in order.

    Read from the migration SQL, not from `@@unique`: a predicate-bearing index
    cannot be spelled in the Prisma model at all, so a model-sourced key goes
    blind the day one lands. DROP INDEX is replayed too — a replaced key that
    outlived its own replacement here would pin the wrong identity.
    """
    live: dict[str, str] = {}
    for migration in sorted(_MIGRATIONS.glob("*/migration.sql")):
        for stmt in _INDEX_STMT.finditer(migration.read_text(encoding="utf-8")):
            if stmt.group("dropped") is not None:
                live.pop(stmt.group("dropped"), None)
            elif stmt.group("table") == table:
                live[stmt.group("name")] = _get_index_ddl(stmt)
    return live


def create_loop_events_table(db_path: Path) -> None:
    """Create core.autoagent_loop_events under the indexes the migrations declare."""
    columns = _get_model_columns("AutoagentLoopEvent")
    indexes = _get_table_indexes(_LOOP_EVENTS_TABLE)
    if not any(ddl.startswith("CREATE UNIQUE") for ddl in indexes.values()):
        raise AssertionError(
            "no live UNIQUE index for %s under %s — an upsert arm would have no key"
            " to conflict on" % (_LOOP_EVENTS_TABLE, _MIGRATIONS)
        )

    declared = ", ".join(
        "id INTEGER PRIMARY KEY" if column == "id" else "%s TEXT" % column
        for column in columns
    )
    with closing(sqlite3.connect(db_path)) as db:
        db.execute("CREATE TABLE %s (%s)" % (_LOOP_EVENTS_TABLE, declared))
        for ddl in indexes.values():
            db.execute(ddl)
        db.commit()


def read_loop_events(
    db_path: Path,
    columns: tuple[str, ...] = ("event_ts", "agent", "eval_result"),
) -> list[dict[str, str]]:
    """Every stored loop-event row, insertion order, in the caller's projection."""
    with closing(sqlite3.connect(db_path)) as db:
        rows = db.execute(
            "SELECT %s FROM %s ORDER BY id" % (", ".join(columns), _LOOP_EVENTS_TABLE)
        ).fetchall()
    return [dict(zip(columns, row)) for row in rows]


def read_proposal(
    db_path: Path,
    key: tuple[str, str, str],
    columns: tuple[str, ...] = ("status", "rationale"),
) -> dict[str, str] | None:
    """The stored `columns` for one identity triple, or None.

    Default projection is the verdict pair; a caller pinning provenance widens it
    rather than reaching past this reader into raw sqlite.
    """
    with closing(sqlite3.connect(db_path)) as db:
        row = db.execute(
            "SELECT %s FROM %s WHERE %s"
            % (
                ", ".join(columns),
                _PROPOSALS_TABLE,
                " AND ".join("%s = ?" % c for c in _PROPOSALS_KEY),
            ),
            key,
        ).fetchone()
    return None if row is None else dict(zip(columns, row))


@contextmanager
def load_helper(db_path: Path):
    """Yield _pg_dual_write_daemon imported against the stdlib backend.

    Loaded under a private module name from its own path, so a real psycopg
    elsewhere in the environment can neither satisfy the import nor open a live
    connection — the backend is the same one on every machine and every leg.
    """
    stubs = _build_stub_modules(db_path)
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location(
            "_pg_dual_write_daemon__stub_backend", _HELPER
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        yield module
    finally:
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
