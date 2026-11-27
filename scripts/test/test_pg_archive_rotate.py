"""Retention pin for scripts/_pg_archive_rotate.py → rotate_audit_log.

Relay records (refusals, sends, redactions) stay in monitor.audit_log for tracing; every other
aged row still moves to the archive. The retention rows run the real statements on a migrated test
database named by MONITOR_TEST_DATABASE_URL — the stdlib stand-in cannot run the interval and array
SQL; the label row reads the monitor's route map and needs no database.

Run with:
    MONITOR_TEST_DATABASE_URL=<test database URL> python3 -m pytest scripts/test/test_pg_archive_rotate.py -v
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "_pg_archive_rotate.py"
_AUDIT_ROUTES = Path(__file__).resolve().parents[2] / "monitor/src/server/middleware/audit-log.ts"
_TEST_URL = os.environ.get("MONITOR_TEST_DATABASE_URL")
_NEEDS_TEST_DB = pytest.mark.skipif(_TEST_URL is None, reason="MONITOR_TEST_DATABASE_URL names no test database")
# the monitor routes whose audit rows are relay records: relay refusals and sends, owner redactions
_RELAY_ROUTES = ("/api/queue/relay", "/api/queue/owner/items/:id/redact")

_AGED = datetime.now(timezone.utc) - timedelta(days=181)
_RECENT = datetime.now(timezone.utc) - timedelta(days=179)


def _load_rotate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("archive_rotate_retention_pin", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def conn():
    """A connection to the test database only; rows written under one actor are removed from both tables after."""
    psycopg = pytest.importorskip("psycopg")
    with psycopg.connect(_TEST_URL, connect_timeout=2) as connection:
        name = connection.execute("SELECT current_database()").fetchone()[0]
        assert name.startswith("glass_atrium_test"), f"refusing a non-test database: {name}"
        actor = f"rotate-pin-{uuid.uuid4().hex[:12]}"
        connection.actor = actor
        yield connection
        connection.rollback()
        connection.execute("DELETE FROM monitor.audit_log WHERE actor = %s", (actor,))
        connection.execute("DELETE FROM monitor.audit_log_archive WHERE actor = %s", (actor,))
        connection.commit()


def _insert(conn, event_ts: datetime, action_kind: str, target_table: str | None, result: str) -> int:
    row = conn.execute(
        """
        INSERT INTO monitor.audit_log (event_ts, actor, action_kind, target_table, result_code)
        VALUES (%s, %s, %s, %s, %s::monitor."AuditResultCode")
        RETURNING id
        """,
        (event_ts, conn.actor, action_kind, target_table, result),
    ).fetchone()
    conn.commit()
    return row[0]


def _is_in(conn, table: str, row_id: int) -> bool:
    query = f"SELECT EXISTS (SELECT 1 FROM monitor.{table} WHERE id = %s)"
    return conn.execute(query, (row_id,)).fetchone()[0]


@pytest.mark.parametrize("route", _RELAY_ROUTES)
def test_rotation_keeps_the_resource_label_the_monitor_audits_relay_routes_under(route, monkeypatch):
    # a stand-in only where psycopg is absent: the script exits at import without it, and no row here connects
    monkeypatch.setitem(sys.modules, "psycopg", sys.modules.get("psycopg") or ModuleType("psycopg"))
    source = _AUDIT_ROUTES.read_text(encoding="utf-8")
    labels = re.findall(r'\[\s*"' + re.escape(route) + r'"\s*,\s*"([^"]+)"\s*\]', source)

    assert labels == [_load_rotate().RELAY_RESOURCE], f"ROUTE_RESOURCE label of {route}: {labels}"


@_NEEDS_TEST_DB
@pytest.mark.parametrize(
    ("event_ts", "action_kind", "target_table", "result", "is_moved"),
    [
        pytest.param(_AGED, "queue-relay.relay", "queue-relay", "blocked", False, id="aged relay refusal stays"),
        pytest.param(_AGED, "queue-relay.redact", "queue-relay", "success", False, id="aged redaction stays"),
        pytest.param(_AGED, "queue-relay.relay", "queue-relay", "success", False, id="aged relay send stays"),
        pytest.param(_AGED, "queue-item.answer", "queue-item", "success", True, id="aged owner answer moves"),
        pytest.param(_AGED, "agents.update", "agents", "blocked", True, id="aged refusal of another resource moves"),
        pytest.param(_AGED, "remote.event", None, "success", True, id="aged row with no resource moves"),
        pytest.param(_RECENT, "queue-item.answer", "queue-item", "success", False, id="recent row stays"),
    ],
)
def test_rotation_keeps_relay_records_and_moves_other_aged_rows(conn, event_ts, action_kind, target_table, result, is_moved):
    row_id = _insert(conn, event_ts, action_kind, target_table, result)

    _load_rotate().rotate_audit_log(conn)

    assert (_is_in(conn, "audit_log", row_id), _is_in(conn, "audit_log_archive", row_id)) == (not is_moved, is_moved)
