"""Composition pin for compose_daemon_run_apply_status in _pg_dual_write_daemon.py.

The op folds an apply-stage verdict INTO a row whose status already carries patch
generation's own verdict. The whole point is COMPOSITION: an apply outcome must
never erase a generation verdict. A plain `SET status = <apply_status>` overwrite
would satisfy the driver, pass every other suite, and silently reintroduce that
erasure — so the semantics need a test that goes red on exactly that edit.

Why a shim instead of a live database: the op's SQL is PG-specific (schema-
qualified table, `::core."DaemonStatus"` casts) and the 'apply_failed' enum label
ships as an unapplied migration, so a live run fails for reasons unrelated to the
CASE. The psycopg stand-in (same PYTHONPATH mechanism as the exit-contract suite)
hands the helper's REAL SQL text to sqlite3 after two mechanical rewrites. The
CASE arms are therefore evaluated by a real SQL engine, never re-implemented here
— which is what keeps the pin failable.

Run with:
    python3 -m pytest scripts/test/test_pg_dual_write_compose_apply_status.py -v

CID: 2026-08-02T2200_round6-fixes_e1a7
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
_HELPER = _SCRIPTS_ROOT / "_pg_dual_write_daemon.py"

_TIMEOUT_S = 30
_DAEMON = "autoagent"
_RUN_DATE = "2026-08-02"

_PSYCOPG_SHIM = r'''"""Minimal psycopg stand-in that executes the caller's SQL through sqlite3.

Only the surface _pg_dual_write_daemon.py touches is implemented. SQL text is
never interpreted here — two mechanical rewrites (pyformat params, PG cast
suffixes) hand it to a real SQL engine, so the caller's semantics stay under test.
"""

import os
import re
import sqlite3


class Error(Exception):
    pass


class OperationalError(Error):
    pass


class IntegrityError(Error):
    pass


_CAST = re.compile(r'::(?:\w+\.)?"?\w+"?')
_PYFORMAT = re.compile(r"%\((\w+)\)s")


def _rewrite(sql):
    return _PYFORMAT.sub(r":\1", _CAST.sub("", sql))


class _Cursor:
    def __init__(self, inner):
        self._inner = inner
        self.rowcount = -1

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def execute(self, sql, params=None):
        self._inner.execute(_rewrite(sql), params or {})
        self.rowcount = self._inner.rowcount


class _Connection:
    def __init__(self, path):
        self._db = sqlite3.connect(":memory:")
        # ATTACH aliases the file as schema `core` → the helper's qualified
        # `core.daemon_runs` runs verbatim, with no table-name rewrite.
        self._db.execute("ATTACH DATABASE ? AS core", (path,))

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self._db.close()
        return False

    def cursor(self):
        return _Cursor(self._db.cursor())

    def commit(self):
        self._db.commit()


def connect(conninfo, **kwargs):
    return _Connection(os.environ["GA_PIN_SQLITE"])
'''

_ERRORS_SHIM = '''"""psycopg.errors surface: the classes _classify_error branches on."""

from psycopg import Error, IntegrityError, OperationalError

__all__ = ["Error", "IntegrityError", "OperationalError"]
'''

_JSON_SHIM = '''"""psycopg.types.json surface: imported at module scope, unused by this op."""


class Jsonb:
    def __init__(self, obj):
        self.obj = obj
'''


@pytest.fixture
def pg_shim(tmp_path: Path) -> dict[str, str]:
    """PYTHONPATH-prepended psycopg stand-in plus the sqlite file it writes to."""
    pkg = tmp_path / "psycopg"
    (pkg / "types").mkdir(parents=True)
    (pkg / "__init__.py").write_text(_PSYCOPG_SHIM, encoding="utf-8")
    (pkg / "errors.py").write_text(_ERRORS_SHIM, encoding="utf-8")
    (pkg / "types" / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "types" / "json.py").write_text(_JSON_SHIM, encoding="utf-8")

    db_path = tmp_path / "daemon_runs.sqlite"
    with closing(sqlite3.connect(db_path)) as db:
        db.execute(
            "CREATE TABLE daemon_runs (run_date TEXT, daemon_name TEXT, status TEXT)"
        )
        db.commit()

    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(tmp_path), env["PYTHONPATH"]] if env.get("PYTHONPATH") else [str(tmp_path)]
    )
    env["GA_PIN_SQLITE"] = str(db_path)
    return env


def _seed(env: dict[str, str], status: str) -> None:
    with closing(sqlite3.connect(env["GA_PIN_SQLITE"])) as db:
        db.execute(
            "INSERT INTO daemon_runs (run_date, daemon_name, status) VALUES (?, ?, ?)",
            (_RUN_DATE, _DAEMON, status),
        )
        db.commit()


def _get_status(env: dict[str, str]) -> str | None:
    with closing(sqlite3.connect(env["GA_PIN_SQLITE"])) as db:
        row = db.execute(
            "SELECT status FROM daemon_runs WHERE run_date = ? AND daemon_name = ?",
            (_RUN_DATE, _DAEMON),
        ).fetchone()
    return row[0] if row else None


def _compose(env: dict[str, str], apply_status: str):
    envelope = json.dumps(
        {
            "op": "compose_daemon_run_apply_status",
            "args": {
                "daemon_name": _DAEMON,
                "run_date": _RUN_DATE,
                "apply_status": apply_status,
            },
        }
    )
    return subprocess.run(
        [sys.executable, str(_HELPER)],
        input=envelope,
        text=True,
        capture_output=True,
        timeout=_TIMEOUT_S,
        env=env,
        check=False,
    )


@pytest.mark.parametrize("generation_verdict", ["quota_exceeded", "partial", "error"])
def test_when_generation_failed_then_apply_failure_preserves_its_verdict(
    pg_shim: dict[str, str], generation_verdict: str
):
    # The erasure this op exists to prevent: a plain overwrite reports the apply
    # stage's verdict over a generation verdict that is strictly more informative.
    _seed(pg_shim, generation_verdict)

    result = _compose(pg_shim, "apply_failed")

    assert result.returncode == 0
    assert _get_status(pg_shim) == generation_verdict


@pytest.mark.parametrize("generation_verdict", ["quota_exceeded", "partial", "error"])
def test_when_generation_failed_then_clean_apply_preserves_its_verdict(
    pg_shim: dict[str, str], generation_verdict: str
):
    _seed(pg_shim, generation_verdict)

    result = _compose(pg_shim, "ok")

    assert result.returncode == 0
    assert _get_status(pg_shim) == generation_verdict


def test_when_row_is_ok_then_apply_failure_composes_in(pg_shim: dict[str, str]):
    _seed(pg_shim, "ok")

    result = _compose(pg_shim, "apply_failed")

    assert result.returncode == 0
    assert _get_status(pg_shim) == "apply_failed"


def test_when_row_is_apply_failed_then_clean_apply_clears_it(pg_shim: dict[str, str]):
    # The reverse swap keeps a same-date re-run from inheriting a stale verdict.
    _seed(pg_shim, "apply_failed")

    result = _compose(pg_shim, "ok")

    assert result.returncode == 0
    assert _get_status(pg_shim) == "ok"


def test_when_no_run_row_exists_then_nothing_is_inserted_and_silence_is_reported(
    pg_shim: dict[str, str],
):
    result = _compose(pg_shim, "apply_failed")

    assert result.returncode == 0
    assert _get_status(pg_shim) is None
    assert "matched no run row" in result.stderr
