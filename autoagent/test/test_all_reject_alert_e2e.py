"""End-to-end live-persistence test for the all-reject alert (AP-1 closure).

The unit suite (``test_all_reject_alert.py``) proves the threshold semantics with
``_invoke_pg_helper`` and ``_pg_connect`` MOCKED — so the alert's actual persisted
emit (a real ``core.autoagent_loop_events`` row with
``eval_result='all-reject-alert'``) was never observed in a queryable table. This
module closes that observability gap: it drives the UNMOCKED production chain
``alert_all_reject_streak`` -> real ``_invoke_pg_helper`` -> real
``write_autoagent_loop_event`` -> real INSERT, then SELECTs the row back.

Isolation contract: every write lands in a THROWAWAY sandbox database created
under ``$CLAUDE_JOB_DIR/tmp`` and dropped on teardown. The production db ``glass_atrium``
is NEVER opened — both connection seams (``daemon_cycle._pg_connect`` and the
helper module's ``_connect``) are repointed at the sandbox DSN. The sandbox
schema mirrors the live ``core.autoagent_loop_events`` columns + the
``autoagent_loop_events_dedup`` unique index (so the real UPSERT's ON CONFLICT
clause is genuinely exercised) and a minimal ``core.autoagent_proposals``
(cycle_date + status) that the prior-streak read query walks.

Run with either runner (skips cleanly when psycopg / a local PG server is absent):
    uv run --with pytest --with psycopg pytest \
        autoagent/test/test_all_reject_alert_e2e.py -v
    python3 -m unittest autoagent.test.test_all_reject_alert_e2e -v

CID: 2026-06-13T0500_session-test-audit_e9b4
"""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_PG_SCRIPTS_DIR = Path.home() / ".claude" / "scripts"

for _p in (_HOOKS_DIR, _AUTOAGENT_DIR, _PG_SCRIPTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

try:
    import psycopg

    import _pg_dual_write_daemon as pgdw
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg / helper absent → skip, not error
    psycopg = None  # type: ignore[assignment]
    pgdw = None  # type: ignore[assignment]
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_CYCLE_DATE = "2026-06-13"
_GENERATED_AT = "2026-06-13T00:00:00.000Z"

# Sandbox schema: the live autoagent_loop_events columns + dedup index, plus the
# two proposal columns the prior-streak read walks (status kept as text so the
# `status::text <> 'rejected'` predicate works without recreating the live enum).
_SANDBOX_DDL = """
CREATE SCHEMA IF NOT EXISTS core;
CREATE TABLE core.autoagent_loop_events (
    id              bigserial PRIMARY KEY,
    event_ts        timestamptz   NOT NULL,
    agent           varchar(64)   NOT NULL,
    rice            numeric(8,3),
    eval_result     varchar(32)   NOT NULL,
    changes_added   integer       NOT NULL,
    changes_removed integer       NOT NULL
);
CREATE UNIQUE INDEX autoagent_loop_events_dedup
    ON core.autoagent_loop_events (event_ts, agent, eval_result);
CREATE TABLE core.autoagent_proposals (
    id         bigserial PRIMARY KEY,
    cycle_date date NOT NULL,
    status     text NOT NULL
);
"""


def _patch_result(status: str) -> "dc.PatchResult":
    return dc.PatchResult(
        pattern_label="e2e probe pattern",
        pattern_agent="probe-agent",
        pattern_frequency="3",
        target_file="/tmp/probe-agent.md",
        classification="reject" if status == "rejected" else "body-auto",
        rationale="",
        proposed_diff="",
        outcomes_sampled=0,
        haiku_status="ok",
        status=status,
    )


def _report(statuses: list[str]) -> "dc.CycleReport":
    return dc.CycleReport(
        cycle_date=_CYCLE_DATE,
        generated_at=_GENERATED_AT,
        patterns_processed=len(statuses),
        cost_guard={},
        patches=[_patch_result(s) for s in statuses],
    )


@unittest.skipIf(
    dc is None or psycopg is None,
    f"import failed: {_IMPORT_ERROR}",
)
class TestAllRejectAlertLivePersist(unittest.TestCase):
    """The production write chain lands a real all-reject-alert row in PG."""

    sandbox_db: str | None = None
    _dsn: str | None = None

    @classmethod
    def setUpClass(cls) -> None:
        job_dir = os.environ.get("CLAUDE_JOB_DIR")
        sandbox_root = Path(job_dir) / "tmp" if job_dir else None
        if sandbox_root is not None:
            sandbox_root.mkdir(parents=True, exist_ok=True)

        cls.sandbox_db = f"atrium_sbx_{uuid.uuid4().hex[:12]}"
        # Hard guard: a throwaway sandbox name can NEVER collide with production.
        assert cls.sandbox_db != "glass_atrium", "refusing to target the production db"

        try:
            subprocess.run(  # nosec — list form, no shell; fixed sandbox name
                ["createdb", cls.sandbox_db],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (subprocess.CalledProcessError, FileNotFoundError, OSError) as exc:
            detail = getattr(exc, "stderr", "") or str(exc)
            raise unittest.SkipTest(f"createdb unavailable: {detail}")

        cls._dsn = f"dbname={cls.sandbox_db}"
        try:
            with psycopg.connect(cls._dsn, connect_timeout=2) as conn:
                with conn.cursor() as cur:
                    cur.execute(_SANDBOX_DDL)
                conn.commit()
        except Exception as exc:  # noqa: BLE001 — surface as a clean skip + cleanup
            cls._drop_sandbox()
            raise unittest.SkipTest(f"sandbox provisioning failed: {exc}")

        cls.addClassCleanup(cls._drop_sandbox)

    @classmethod
    def _drop_sandbox(cls) -> None:
        if not cls.sandbox_db:
            return
        with contextlib.suppress(Exception):
            subprocess.run(  # nosec — list form, no shell; sandbox name only
                ["dropdb", "--if-exists", cls.sandbox_db],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
        cls.sandbox_db = None

    def _sandbox_connect(self) -> "psycopg.Connection":
        return psycopg.connect(self._dsn, connect_timeout=2)

    def setUp(self) -> None:
        # Repoint BOTH connection seams at the sandbox so neither the prior-streak
        # read (daemon_cycle._pg_connect) nor the loop-event write
        # (_pg_dual_write_daemon._connect) can reach the production db.
        for module, attr in ((dc, "_pg_connect"), (pgdw, "_connect")):
            patcher = mock.patch.object(module, attr, self._sandbox_connect)
            patcher.start()
            self.addCleanup(patcher.stop)
        # The streak threshold is env-driven at import time; pin it for the test.
        threshold = mock.patch.object(dc, "ALL_REJECT_ALERT_THRESHOLD", 3)
        threshold.start()
        self.addCleanup(threshold.stop)
        # HAS_PG_LOOP_WRITE gates the module-import write path; force it on so the
        # real write_autoagent_loop_event runs in-process (no subprocess fork).
        has_pg = mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True)
        has_pg.start()
        self.addCleanup(has_pg.stop)
        self.addCleanup(self._truncate_sandbox)

    def _truncate_sandbox(self) -> None:
        with self._sandbox_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "TRUNCATE core.autoagent_loop_events, core.autoagent_proposals"
                )
            conn.commit()

    def _seed_prior_cycles(self, rows: list[tuple[str, str]]) -> None:
        with self._sandbox_connect() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO core.autoagent_proposals (cycle_date, status) "
                    "VALUES (%s, %s)",
                    rows,
                )
            conn.commit()

    def _fetch_alert_rows(self) -> list[tuple]:
        with self._sandbox_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT agent, eval_result, changes_added, changes_removed "
                    "FROM core.autoagent_loop_events "
                    "WHERE eval_result = %s ORDER BY id",
                    (dc.ALL_REJECT_ALERT_EVAL_RESULT,),
                )
                return cur.fetchall()

    def test_when_live_streak_reaches_threshold_then_alert_row_persisted(self) -> None:
        # Two persisted all-reject prior cycles + the current all-reject cycle = 3.
        self._seed_prior_cycles(
            [
                ("2026-06-11", "rejected"),
                ("2026-06-12", "rejected"),
            ]
        )
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.alert_all_reject_streak(_report(["rejected", "rejected"]))

        self.assertIn("all-reject streak", stderr.getvalue())
        rows = self._fetch_alert_rows()
        self.assertEqual(
            len(rows), 1, f"expected exactly one persisted alert, got {rows}"
        )
        agent, eval_result, added, removed = rows[0]
        self.assertEqual(agent, "daemon-cycle")
        self.assertEqual(eval_result, "all-reject-alert")
        self.assertEqual(added, 0)
        self.assertEqual(removed, 0)

    def test_when_live_streak_below_threshold_then_no_row_persisted(self) -> None:
        # Only the current all-reject cycle; one prior cycle had a non-rejected row.
        self._seed_prior_cycles(
            [
                ("2026-06-11", "applied"),
                ("2026-06-12", "rejected"),
            ]
        )
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.alert_all_reject_streak(_report(["rejected"]))

        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(self._fetch_alert_rows(), [])

    def test_when_alert_re_emitted_then_dedup_index_holds_single_row(self) -> None:
        # ON CONFLICT (event_ts, agent, eval_result) → a same-cycle re-run UPDATEs
        # in place; no duplicate row, proving the real dedup index is exercised.
        self._seed_prior_cycles(
            [
                ("2026-06-11", "rejected"),
                ("2026-06-12", "rejected"),
            ]
        )
        report = _report(["rejected", "rejected"])
        with contextlib.redirect_stderr(io.StringIO()):
            dc.alert_all_reject_streak(report)
            dc.alert_all_reject_streak(report)

        self.assertEqual(
            len(self._fetch_alert_rows()),
            1,
            "dedup index must collapse the re-emit into a single row",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
