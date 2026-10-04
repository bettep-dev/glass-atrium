"""Daemon-owned MANIFEST ingest: every hook MANIFEST line lands in core.spawn_manifest once.

``daemon_cycle.ingest_manifest_log`` renames the live log into a contract-named spool,
re-reads that spool on the next cycle and unlinks it only after the re-read commits;
(spool, line offset) is the only position. The unit classes run the real ingest over a
temp log root with an in-memory table standing in for the database boundary; the live
class runs the real writer SQL on the ephemeral cluster (``live-pg-ephemeral.bats``).

Run with either runner:
    python3 -m unittest autoagent.test.test_manifest_ingest -v
    uv run --with pytest pytest autoagent/test/test_manifest_ingest.py -v
"""

from __future__ import annotations

import contextlib
import fcntl
import io
import os
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
_HOOK_SH = _HOOKS_DIR / "inject-scope-rules.sh"

for _anchor in (_HOOKS_DIR, _AUTOAGENT_DIR, _SCRIPTS_DIR, Path(__file__).resolve().parent):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

from _pg_seal import get_ephemeral_connection, seal_pg_reach  # noqa: E402 — anchors above

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — an unimportable daemon skips, not errors
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_CYCLE_1 = datetime(2026, 10, 5, 3, 0, 0, tzinfo=timezone.utc)
_CYCLE_2 = datetime(2026, 10, 6, 3, 0, 0, tzinfo=timezone.utc)
_CYCLE_3 = datetime(2026, 10, 7, 3, 0, 0, tzinfo=timezone.utc)


def _get_line(agent_id: str = "a41f0c2e9b", session_id: str | None = "e0e449e3-7b17") -> str:
    """One hook MANIFEST line; session_id None = a line written before the session field."""
    session_field = "" if session_id is None else f" session_id={session_id}"
    return (
        f"2026-10-05T17:00:00Z [inject-scope-rules] MANIFEST agent_id={agent_id}{session_field}"
        " agent=glass-atrium-dev-python ctx_bytes=1166 digest=9f2c blocks=emit,meter,budget-dev\n"
    )


class _SpawnManifestTable:
    """In-memory core.spawn_manifest: unique on (spool, line_offset), DO NOTHING on conflict."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, int], tuple[object, ...]] = {}
        self.is_insert_failing = False
        self.is_unreachable = False

    def write(self, spool: str, rows: list[tuple[object, ...]]) -> int:
        if self.is_unreachable or self.is_insert_failing:
            raise RuntimeError('relation "core.spawn_manifest" does not exist')
        for row in rows:
            self.rows.setdefault((spool, int(row[0])), row)
        return self.count(spool)

    def count(self, spool: str) -> int:
        if self.is_unreachable:
            raise RuntimeError("connection to server on socket failed")
        return sum(1 for key in self.rows if key[0] == spool)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class _IngestCase(unittest.TestCase):
    """A temp log root, the seal, then the database seams replaced by one in-memory table."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base_root = Path(tmp.name)
        self.log_root = self.base_root / "logs"
        self.log_root.mkdir()
        self.live_log = self.log_root / dc.MANIFEST_LOG_NAME
        self.pg_reach = seal_pg_reach(self)
        self.table = _SpawnManifestTable()
        self.events: list[dict[str, object]] = []
        # Fakes go on after the seal: each replaces one seam the seal already covers.
        for name, value in (
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_write_spawn_manifest", self.table.write),
            ("_pg_count_spawn_manifest", self.table.count),
            ("_pg_write_loop_event", self._record_event),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _record_event(self, **args: object) -> int:
        self.events.append(args)
        return 0

    def _ingest(self, now: datetime) -> object:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            ingest = dc.ingest_manifest_log(self.live_log, now=now)
        self.stderr = stderr.getvalue()
        self.assertEqual(self.pg_reach, [])
        return ingest

    def _get_spools(self) -> list[Path]:
        return sorted(self.log_root.glob(f"{dc.MANIFEST_LOG_NAME}.*.spool"))

    def _append(self, path: Path, text: str) -> None:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(text)


class TestManifestRotation(_IngestCase):
    def test_a_line_appended_to_a_spool_after_its_first_ingest_lands_on_the_next_cycle(
        self,
    ) -> None:
        self._append(self.live_log, _get_line() * 2)
        self._ingest(_CYCLE_1)
        (spool,) = self._get_spools()
        self.assertFalse(self.live_log.exists(), "the live log was not renamed into a spool")
        self.assertEqual(self.table.count(spool.name), 2)

        self._append(spool, _get_line("late-append"))  # a hook descriptor opened before the rename
        self._append(self.live_log, _get_line("next-cycle"))
        ingest = self._ingest(_CYCLE_2)

        self.assertFalse(spool.exists(), "the re-read spool was not unlinked")
        self.assertEqual(self.table.count(spool.name), 3)
        self.assertEqual(len(self.table.rows), 4, "a line written across the rotation was lost")
        self.assertEqual(ingest.rotated_to, self._get_spools()[0].name)

    def test_an_unterminated_last_line_waits_for_the_re_read(self) -> None:
        self._append(self.live_log, _get_line() + _get_line("mid-write").rstrip("\n"))
        self._ingest(_CYCLE_1)
        (spool,) = self._get_spools()
        self.assertEqual(self.table.count(spool.name), 1)

        self._append(spool, "\n")
        self._ingest(_CYCLE_2)
        self.assertEqual(self.table.count(spool.name), 2)

    def test_a_crash_between_insert_and_unlink_re_ingests_without_a_duplicate_row(self) -> None:
        self._append(self.live_log, _get_line() * 2)
        self._ingest(_CYCLE_1)
        (spool,) = self._get_spools()

        with mock.patch.object(Path, "unlink", side_effect=OSError("killed before unlink")):
            self._ingest(_CYCLE_2)
        self.assertTrue(spool.exists())
        self._ingest(_CYCLE_3)

        self.assertFalse(spool.exists())
        self.assertEqual(len(self.table.rows), 2)

    def test_unknown_ids_give_one_row_each_with_null_agent_and_session_ids(self) -> None:
        self._append(
            self.live_log,
            _get_line("unknown", "unknown") + _get_line("unknown", None) + _get_line("a41f0c2e9b"),
        )
        self._ingest(_CYCLE_1)

        stored = [(row[1], row[3]) for _, row in sorted(self.table.rows.items())]
        self.assertEqual(stored, [(None, None), (None, None), ("a41f0c2e9b", "e0e449e3-7b17")])

    def test_an_insert_failure_keeps_the_spool_and_skips_the_rename(self) -> None:
        self._append(self.live_log, _get_line())
        self._ingest(_CYCLE_1)
        (spool,) = self._get_spools()
        self._append(self.live_log, _get_line("next-cycle"))

        self.table.is_insert_failing = True
        ingest = self._ingest(_CYCLE_2)
        self.assertEqual(
            self._get_spools(), [spool], "a spool was unlinked before its re-read committed"
        )
        self.assertTrue(self.live_log.exists(), "the live log was renamed past a pending spool")
        self.assertTrue(ingest.status.startswith("skipped:"), ingest.status)
        self.assertIn(f"spool {spool.name} kept", self.stderr)

        self.table.is_insert_failing = False
        self._ingest(_CYCLE_3)
        self.assertFalse(spool.exists(), "the lock or the spool stayed held after a failed cycle")
        self.assertFalse(self.live_log.exists())

    def test_pg_unreachable_leaves_the_log_root_untouched(self) -> None:
        self._append(self.live_log, _get_line())
        self.table.is_unreachable = True

        ingest = self._ingest(_CYCLE_1)

        self.assertEqual([p.name for p in self.log_root.iterdir()], [dc.MANIFEST_LOG_NAME])
        self.assertTrue(ingest.status.startswith("skipped:"), ingest.status)
        self.assertIn("WARN: manifest ingest skipped", self.stderr)

    def test_a_held_lock_skips_the_ingest_and_unlinks_nothing(self) -> None:
        self._append(self.live_log, _get_line())
        self._ingest(_CYCLE_1)
        (spool,) = self._get_spools()
        self._append(self.live_log, _get_line("next-cycle"))
        before = dict(self.table.rows)

        with dc.get_manifest_ingest_lock_path(self.live_log).open("a", encoding="utf-8") as other:
            fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)  # the concurrent cycle
            ingest = self._ingest(_CYCLE_2)

        self.assertTrue(spool.exists(), "the non-holder unlinked a spool")
        self.assertTrue(self.live_log.exists(), "the non-holder renamed the live log")
        self.assertEqual(self.table.rows, before)
        self.assertTrue(ingest.status.startswith("skipped:"), ingest.status)
        self.assertIn("held by another cycle", self.stderr)


class TestManifestCloseRecord(_IngestCase):
    def test_a_closed_spool_reports_lines_read_against_rows_present_and_no_rule_line_change(
        self,
    ) -> None:
        self._append(self.live_log, _get_line() + "not a manifest line\n" + _get_line("b77"))
        self._ingest(_CYCLE_1)
        (spool,) = self._get_spools()

        ingest = self._ingest(_CYCLE_2)

        (close,) = ingest.closed
        self.assertEqual((close.spool, close.lines_read, close.rows_present), (spool.name, 3, 2))
        (event,) = self.events
        self.assertEqual(
            (
                event["eval_result"],
                event["subject"],
                event["changes_added"],
                event["changes_removed"],
            ),
            ("manifest-spool-closed", spool.name, 0, 0),
        )
        self.assertIn("1 line(s) without a row", self.stderr)


class TestManifestCoverageAfterRotation(_IngestCase):
    def test_manifest_coverage_counts_the_rotated_lines(self) -> None:
        self._append(self.live_log, _get_line() * 3)
        self._ingest(_CYCLE_1)
        self.assertFalse(self.live_log.exists())
        home = self.base_root / "home"
        home.mkdir()

        result = subprocess.run(
            ["bash", str(_HOOK_SH), "--manifest-coverage"],
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(home),
                "GA_DATA_ROOT": str(self.base_root),
            },
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("records=3 agents=1", result.stdout)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class TestManifestIngestCycleWiring(unittest.TestCase):
    """run_cycle ingests the install log root first, except in the no-write mode."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.live_log = self.root / "logs" / dc.MANIFEST_LOG_NAME
        self.live_log.parent.mkdir()
        self.live_log.write_text(_get_line(), encoding="utf-8")
        (self.root / "agents").mkdir()
        env = mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        self.pg_reach = seal_pg_reach(self)

    def _run(self, *, skip_loop_emit: bool) -> tuple[object, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            report = dc.run_cycle(
                log_path=self.root / "learning-log.md",
                outcomes_dir=self.root,
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=skip_loop_emit,
            )
        self.assertEqual(self.pg_reach, [])
        return report, stderr.getvalue()

    def _open_db_boundary(self) -> list[str]:
        """Manifest writes + the pattern read answer, other PG calls refuse; all logged."""
        calls: list[str] = []
        table = _SpawnManifestTable()

        def write(spool: str, rows: list[tuple[object, ...]]) -> int:
            calls.append(f"manifest-write:{spool}")
            return table.write(spool, rows)

        def read_pending_patterns() -> list[dict[str, object]]:
            calls.append("pattern-read")
            return []

        def get_unreachable(name: str) -> Callable[..., None]:
            def refuse(*_args: object, **_kwargs: object) -> None:
                calls.append(name)
                raise ConnectionRefusedError(f"{name}: no database in this test")

            return refuse

        # After the seal: each replaces one seam the seal already covers.
        for name, value in (
            ("HAS_PG_LOOP_WRITE", True),
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_count_spawn_manifest", table.count),
            ("_pg_write_spawn_manifest", write),
            ("_pg_read_pending_patterns", read_pending_patterns),
            ("_pg_connect", get_unreachable("pg-connect")),
            ("_pg_write_corpus_audit", get_unreachable("corpus-audit-write")),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        return calls

    def test_a_no_write_cycle_neither_renames_nor_ingests(self) -> None:
        report, stderr = self._run(skip_loop_emit=True)

        self.assertEqual(
            sorted(p.name for p in self.live_log.parent.iterdir()), [dc.MANIFEST_LOG_NAME]
        )
        self.assertIsNone(report.manifest_ingest)
        self.assertIn("manifest ingest skipped — no-write mode", stderr)

    def test_a_writing_cycle_ingests_the_install_log_root_before_its_first_metric_read(
        self,
    ) -> None:
        calls = self._open_db_boundary()

        report, _ = self._run(skip_loop_emit=False)

        spool = report.manifest_ingest.rotated_to
        self.assertEqual(report.manifest_ingest.status, "ok")
        self.assertTrue((self.live_log.parent / spool).is_file(), "spool not in the log root")
        self.assertFalse(self.live_log.exists(), "the install live log was not rotated")
        self.assertIn("pattern-read", calls)
        self.assertEqual(calls[: calls.index("pattern-read")], [f"manifest-write:{spool}"])


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class TestSpawnManifestWriterLivePg(unittest.TestCase):
    """The writer's real SQL on the ephemeral cluster; skips anywhere else."""

    _SPOOL = "inject-scope-rules.manifest.log.20261005T030000Z.4242.spool"

    def setUp(self) -> None:
        self.conn = get_ephemeral_connection()
        self.addCleanup(self.conn.close)
        import _pg_dual_write_daemon as writer

        self.writer = writer
        self.addCleanup(self._delete_rows)

    def _delete_rows(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM core.spawn_manifest WHERE spool = %s", (self._SPOOL,))
        self.conn.commit()

    def _get_rows(self, data: str, *, is_final: bool) -> list[tuple[object, ...]]:
        rows, _ = dc._get_manifest_rows(data.encode("utf-8"), is_final=is_final)
        return rows

    def test_a_re_read_adds_only_lines_appended_since_and_counts_every_row(self) -> None:
        first = _get_line() * 2
        self.assertEqual(
            self.writer.write_spawn_manifest_rows(
                self._SPOOL, self._get_rows(first, is_final=False)
            ),
            2,
        )
        reread = self._get_rows(first + _get_line("late-append"), is_final=True)

        self.assertEqual(self.writer.write_spawn_manifest_rows(self._SPOOL, reread), 3)
        self.assertEqual(self.writer.write_spawn_manifest_rows(self._SPOOL, reread), 3)
        self.assertEqual(self.writer.get_spawn_manifest_row_count(self._SPOOL), 3)

    def test_unknown_id_lines_store_null_ids_on_separate_rows(self) -> None:
        rows = self._get_rows(_get_line("unknown", "unknown") * 2, is_final=True)
        self.writer.write_spawn_manifest_rows(self._SPOOL, rows)

        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT line_offset, agent_id, session_id, agent_type, ctx_bytes, blocks"
                " FROM core.spawn_manifest WHERE spool = %s ORDER BY line_offset",
                (self._SPOOL,),
            )
            stored = cur.fetchall()
        self.assertEqual(
            stored,
            [
                (0, None, None, "glass-atrium-dev-python", 1166, "emit,meter,budget-dev"),
                (1, None, None, "glass-atrium-dev-python", 1166, "emit,meter,budget-dev"),
            ],
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
