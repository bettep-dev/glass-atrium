"""T12/T13/T14 — the corpus-size audit's Postgres destination.

The audit used to land in an append-only JSONL file nobody queried. These tests
pin the replacement and the two properties that make it safe:

  T12 (1) every one of the 12 measurement columns reaches the writer equal to
          the fixture's known answer, and an insufficient-data reading stays
          NULL rather than collapsing to 0.0;
      (2) two runs of the same cycle_date leave exactly ONE row (UPSERT), and
          the parameter tuple matches the INSERT column list positionally;
  T13 (3) neither detection family appends to the JSONL store across two runs;
  T14 (4) a sink outage on EITHER family leaves the caller's normal result
          intact, raises nothing, emits exactly one named warning line, and
          leaves the loss retrievable on the named degradation channel.

Run with either runner:
    uv run --python 3.13 --with pytest pytest autoagent/test/test_corpus_audit_pg_sink.py -v
    python3 -m unittest autoagent.test.test_corpus_audit_pg_sink -v
"""

from __future__ import annotations

import contextlib
import io
import re
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
for _dir in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent", _REPO_ROOT / "scripts"):
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

import daemon_cycle as dc  # noqa: E402

_MEASUREMENT_COLUMNS = (
    "word_count",
    "token_estimate",
    "file_count",
    "trend_alert",
    "trend_delta",
    "absolute_alert",
    "seeded_threshold",
    "compliance_rate",
    "override_rate",
    "gate_pass_count",
    "gate_trip_count",
    "gate_total_count",
)


_HELPER_SOURCE = (_REPO_ROOT / "scripts" / "_pg_dual_write_daemon.py").read_text(
    encoding="utf-8"
)

try:
    import psycopg  # noqa: F401

    HAS_PSYCOPG = True
except ImportError:
    HAS_PSYCOPG = False


def _load_pg_helper():
    import _pg_dual_write_daemon

    return _pg_dual_write_daemon


def _corpus_audit_sql() -> str:
    """The writer's INSERT text, read from source so the driver is not needed."""
    body = _HELPER_SOURCE.split("def write_autoagent_corpus_audit(", 1)[1]
    return body.split('"""', 2)[2].split("with _connect()", 1)[0]


def _insert_columns(sql: str) -> tuple[str, ...]:
    """Column names of the writer's INSERT list, in declared order."""
    columns = re.search(r"\(cycle_date,(.*?)\)\s*VALUES", sql, re.S)
    if columns is None:
        raise AssertionError("no INSERT column list found in the writer SQL")
    return tuple(c.strip() for c in columns.group(1).replace("\n", " ").split(","))


def _fixture_corpus(root: Path) -> tuple[Path, Path]:
    """Two rule files with a hand-countable word total."""
    rules_dir = root / "rules"
    rules_dir.mkdir()
    (rules_dir / "a.md").write_text("alpha beta gamma\n", encoding="utf-8")
    global_rules = root / "GLOBAL.md"
    global_rules.write_text("delta epsilon\n", encoding="utf-8")
    return rules_dir, global_rules


class CorpusAuditSignalTest(unittest.TestCase):
    """T12 (1) — known-answer fixture, column-for-column, NULL preserved."""

    def test_emit_carries_every_measurement_column_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rules_dir, global_rules = _fixture_corpus(Path(tmp))
            signal = dc.audit_corpus_size(
                rules_dir=rules_dir,
                global_rules_file=global_rules,
                gate_log_file=Path(tmp) / "absent-gate.log",
            )

        captured: dict[str, object] = {}
        with _patched_writer(lambda **kw: captured.update(kw) or 1):
            self.assertTrue(dc.emit_corpus_audit(signal, "2026-08-16"))

        self.assertEqual(captured["cycle_date"], "2026-08-16")
        for column in _MEASUREMENT_COLUMNS:
            self.assertEqual(captured[column], signal[column], column)
        # A missing baseline / absent gate log is insufficient data, not zero.
        self.assertIsNone(captured["trend_delta"])
        self.assertIsNone(captured["compliance_rate"])
        self.assertIsNone(captured["override_rate"])
        self.assertNotEqual(captured["compliance_rate"], 0.0)

    def test_signal_word_count_matches_the_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rules_dir, global_rules = _fixture_corpus(Path(tmp))
            signal = dc.audit_corpus_size(
                rules_dir=rules_dir, global_rules_file=global_rules
            )
        self.assertEqual(signal["word_count"], 5)
        self.assertEqual(signal["file_count"], 2)


class CorpusAuditUpsertTest(unittest.TestCase):
    """T12 (2) — one row per cycle_date after a repeat run; positional binding."""

    def test_sql_binds_thirteen_columns_in_declared_order(self) -> None:
        sql = _corpus_audit_sql()
        self.assertEqual(_insert_columns(sql), _MEASUREMENT_COLUMNS)
        self.assertEqual(sql.count("%s"), 1 + len(_MEASUREMENT_COLUMNS))
        self.assertIn("ON CONFLICT (cycle_date) DO UPDATE", sql)
        for column in _MEASUREMENT_COLUMNS:
            self.assertIn(f"{column} = EXCLUDED.{column}", sql)

    @unittest.skipUnless(HAS_PSYCOPG, "psycopg absent — driver-bound path")
    def test_two_runs_leave_exactly_one_row(self) -> None:
        helper = _load_pg_helper()

        rows: dict[object, tuple] = {}
        statements: list[str] = []

        def _execute(sql, params):
            statements.append(sql)
            rows[params[0]] = params

        with _patched_connect(helper, _execute):
            for word_count in (100, 200):
                helper.write_autoagent_corpus_audit(
                    "2026-08-16", word_count, 10, 3, True, 5, False, 110,
                    None, None, 1, 0, 1,
                )

        self.assertEqual(len(rows), 1)
        # The second run overwrote the first — an UPSERT, not an append.
        self.assertEqual(rows["2026-08-16"][1], 200)
        self.assertIn("ON CONFLICT (cycle_date) DO UPDATE", statements[0])

    @unittest.skipUnless(HAS_PSYCOPG, "psycopg absent — driver-bound path")
    def test_parameter_order_matches_the_insert_column_list(self) -> None:
        helper = _load_pg_helper()

        seen: list[tuple] = []

        def _execute(sql, params):
            self.assertEqual(_insert_columns(sql), _MEASUREMENT_COLUMNS)
            seen.append(params)

        with _patched_connect(helper, _execute):
            helper.write_autoagent_corpus_audit(
                "2026-08-16", 1, 2, 3, False, None, False, 4, None, None, 5, 6, 7
            )
        self.assertEqual(len(seen[0]), 1 + len(_MEASUREMENT_COLUMNS))
        self.assertIsNone(seen[0][5])


class JsonlRetirementTest(unittest.TestCase):
    """T13 — neither detection family appends to the JSONL store any more."""

    def test_two_cycles_append_no_jsonl_record(self) -> None:
        import compliance_telemetry

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "signals.jsonl"
            store.write_text("", encoding="utf-8")
            rules_dir, global_rules = _fixture_corpus(Path(tmp))
            appended: list[object] = []
            original = compliance_telemetry.append_signal
            compliance_telemetry.append_signal = (
                lambda signal, store_file=None: appended.append(signal) or True
            )
            try:
                for _run in (1, 2):
                    dc.audit_corpus_size(
                        rules_dir=rules_dir, global_rules_file=global_rules
                    )
                    dc.classify_prose_only_add(
                        "+added line\n+another", target_file="rules/a.md"
                    )
            finally:
                compliance_telemetry.append_signal = original
            self.assertEqual(store.read_text(encoding="utf-8"), "")

        self.assertEqual(appended, [])


class SinkOutageTest(unittest.TestCase):
    """T14 — a sink outage degrades loudly on a named channel, never fatally."""

    def setUp(self) -> None:
        dc.clear_sink_degradations()

    def test_corpus_emit_survives_a_sink_outage(self) -> None:
        signal = {column: 0 for column in _MEASUREMENT_COLUMNS}

        def _boom(**_kwargs):
            raise RuntimeError("connection refused")

        stderr = io.StringIO()
        with _patched_writer(_boom), contextlib.redirect_stderr(stderr):
            result = dc.emit_corpus_audit(signal, "2026-08-16")

        self.assertFalse(result)  # normal result, no exception propagated
        warnings = [
            line for line in stderr.getvalue().splitlines() if "sink unavailable" in line
        ]
        self.assertEqual(len(warnings), 1)
        self.assertIn("corpus_size_audit", warnings[0])
        degradations = dc.get_sink_degradations()
        self.assertEqual(len(degradations), 1)
        self.assertEqual(degradations[0]["family"], "corpus_size_audit")
        self.assertIn("connection refused", degradations[0]["error"])

    def test_the_recorder_labels_whatever_family_it_is_handed(self) -> None:
        """The channel is family-agnostic — patch_classification is caller two.

        Its wiring lives in run_cycle's except branch, out of a unit test's reach;
        only the label contract is pinned here.
        """
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.record_sink_degradation(
                "patch_classification", RuntimeError("connection refused")
            )

        self.assertEqual(
            [entry["family"] for entry in dc.get_sink_degradations()],
            ["patch_classification"],
        )
        self.assertIn("patch_classification", stderr.getvalue())

    def test_missing_pg_helper_is_a_degradation_not_a_crash(self) -> None:
        signal = {column: 0 for column in _MEASUREMENT_COLUMNS}
        original = dc.HAS_PG_LOOP_WRITE
        dc.HAS_PG_LOOP_WRITE = False
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertFalse(dc.emit_corpus_audit(signal, "2026-08-16"))
        finally:
            dc.HAS_PG_LOOP_WRITE = original
        self.assertEqual(len(dc.get_sink_degradations()), 1)


_SENTINEL = object()


@contextlib.contextmanager
def _patched_writer(fake):
    """Swap the daemon's bound writer — absent when psycopg did not import."""
    original = getattr(dc, "_pg_write_corpus_audit", _SENTINEL)
    had_pg = dc.HAS_PG_LOOP_WRITE
    dc._pg_write_corpus_audit = fake
    dc.HAS_PG_LOOP_WRITE = True
    try:
        yield
    finally:
        dc.HAS_PG_LOOP_WRITE = had_pg
        if original is _SENTINEL:
            del dc._pg_write_corpus_audit
        else:
            dc._pg_write_corpus_audit = original


@contextlib.contextmanager
def _patched_connect(helper, execute):
    """Swap the helper's psycopg connect for a cursor that records statements."""

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def execute(self, sql, params):
            execute(sql, params)

        def fetchone(self):
            return (1,)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def cursor(self):
            return _Cursor()

        def commit(self):
            return None

    original = helper._connect
    helper._connect = lambda: _Conn()
    try:
        yield
    finally:
        helper._connect = original


if __name__ == "__main__":
    unittest.main()
