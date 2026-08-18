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

# The subprocess consumer names its sqlite file here; it cannot be handed one.
SQLITE_PATH_ENV = "GA_PIN_SQLITE"

_PROPOSALS_TABLE = "autoagent_proposals"
_PROPOSALS_KEY = ("cycle_date", "pattern_label", "target_file")

_CAST = re.compile(r'::(?:\w+\.)?"?\w+"?')
_NAMED = re.compile(r"%\((\w+)\)s")
_MODEL_BLOCK = re.compile(r"^model AutoagentProposal \{$(.*?)^\}$", re.M | re.S)
_FIELD = re.compile(r"^\s+(\w+)\s+(\w+)(\?)?(\[\])?(.*)$")
_MAPPED = re.compile(r'@map\("(\w+)"\)')


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


def _get_proposal_columns() -> list[str]:
    """Column names of core.autoagent_proposals, read off the Prisma model.

    Read rather than remembered: a hand-copied list agrees with itself forever
    and drifts on the next migration.
    """
    block = _MODEL_BLOCK.search(_SCHEMA.read_text(encoding="utf-8"))
    if block is None:
        raise AssertionError("AutoagentProposal model not found in %s" % _SCHEMA)

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
    columns = _get_proposal_columns()
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


def read_proposal(db_path: Path, key: tuple[str, str, str]) -> dict[str, str] | None:
    """The stored status and rationale for one identity triple, or None."""
    with closing(sqlite3.connect(db_path)) as db:
        row = db.execute(
            "SELECT status, rationale FROM %s WHERE %s"
            % (_PROPOSALS_TABLE, " AND ".join("%s = ?" % c for c in _PROPOSALS_KEY)),
            key,
        ).fetchone()
    return None if row is None else {"status": row[0], "rationale": row[1]}


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
