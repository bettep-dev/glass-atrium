"""Writer pin for scripts/autoagent-status-backfill.py → _apply_updates.

The backfill flips a pending row to `applied` from an apply record, not a review
verdict, so it stamps its own actor and leaves reviewed_at as found (column
contract: monitor/prisma/schema.prisma → AutoagentProposal.reviewedAt). The loop
runs through the shared psycopg stand-in, so the script's real UPDATE text is
evaluated by a real SQL engine.

Run with:
    python3 -m pytest scripts/test/test_autoagent_status_backfill.py -v
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from types import ModuleType, SimpleNamespace

import _pg_stub_backend as stub
import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "autoagent-status-backfill.py"

# ISO text, not a date: the stub cannot see the date-typed column, and sqlite's
# default date adapter is deprecated.
_KEY = ("2026-09-14", "완료 보고 전 검증 누락", "agents/glass-atrium-dev-python.md")
_COLUMNS = ("status", "reviewed_by", "reviewed_at")


@pytest.fixture
def backfill(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
    """The backfill script imported against the stand-in psycopg surface."""
    psycopg = SimpleNamespace(Error=stub.Error, OperationalError=stub.OperationalError)
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)
    monkeypatch.setenv("GA_DATA_ROOT", str(tmp_path / "data"))

    spec = importlib.util.spec_from_file_location("status_backfill_writer_pin", _SCRIPT)
    assert spec is not None and spec.loader is not None, _SCRIPT
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _seed_pending(
    db_path: Path, reviewed_by: str | None, reviewed_at: str | None
) -> None:
    stub.create_proposals_table(db_path)
    with closing(sqlite3.connect(db_path)) as db:
        db.execute(
            "INSERT INTO autoagent_proposals (id, cycle_date, pattern_label, target_file,"
            " target_agent, status, reviewed_by, reviewed_at)"
            " VALUES (4210, ?, ?, ?, 'glass-atrium-dev-python', 'pending', ?, ?)",
            (*_KEY, reviewed_by, reviewed_at),
        )
        db.commit()


@pytest.mark.parametrize(
    ("prior_reviewed_by", "prior_reviewed_at"),
    [
        pytest.param(None, None, id="row-never-reviewed"),
        pytest.param(
            "monitor-user", "2026-09-13 21:07:44", id="row-carrying-an-earlier-review"
        ),
    ],
)
def test_applied_row_names_the_backfill_actor_and_keeps_its_reviewed_at(
    backfill: ModuleType,
    tmp_path: Path,
    prior_reviewed_by: str | None,
    prior_reviewed_at: str | None,
) -> None:
    db_path = tmp_path / "proposals.sqlite"
    _seed_pending(db_path, prior_reviewed_by, prior_reviewed_at)
    applied = {
        "cycle_date": _KEY[0],
        "pattern_label": _KEY[1],
        "target_file": _KEY[2],
        "source_file": "autoagent-applied-2026-09-14.jsonl",
        "source_line": 3,
    }

    with stub.create_connection(db_path) as conn:
        stats = backfill._apply_updates(conn, [applied], dry_run=False, verbose=False)
        conn.commit()
        assert stats["rows_updated"] == 1, stats
        assert stub.read_proposal(db_path, _KEY, _COLUMNS) == {
            "status": "applied",
            "reviewed_by": backfill._BACKFILL_ACTOR,
            "reviewed_at": prior_reviewed_at,
        }
