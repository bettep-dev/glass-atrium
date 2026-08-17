"""T12/T14 — the corpus-size audit's Postgres destination.

The audit used to land in an append-only JSONL file nobody queried. These tests
pin the replacement and the two properties that make it safe (the JSONL
retirement itself is pinned by test_signal_store_retired.py, which drives all
four census emitters rather than the two populated ones):

  T12 (1) every one of the 12 measurement columns reaches the writer equal to
          the fixture's known answer, and an insufficient-data reading stays
          NULL rather than collapsing to 0.0;
      (2) two runs of the same cycle_date leave exactly ONE row (UPSERT), and
          the parameter tuple matches the INSERT column list positionally;
  T14 (3) a sink outage on EITHER family leaves the caller's normal result
          intact, raises nothing, emits exactly one named warning line, and
          leaves the loss retrievable on the named degradation channel.

T4's widened file set is pinned here too, against the same sink: the enumerated
set gains every agent body while keeping every rules file and GLOBAL_RULES.md,
and the widened reading rides the delivered columns with no schema touch.

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

# indexed_at trails the measurements in the INSERT list: it is written from a
# SQL literal rather than a bound parameter, so it carries no %s of its own.
_WRITTEN_COLUMNS = _MEASUREMENT_COLUMNS + ("indexed_at",)


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
    """Column names of the writer's INSERT list after cycle_date, in order."""
    columns = re.search(r"\(cycle_date,(.*?)\)\s*VALUES", sql, re.S)
    if columns is None:
        raise AssertionError("no INSERT column list found in the writer SQL")
    return tuple(c.strip() for c in columns.group(1).replace("\n", " ").split(","))


def _all_insert_columns(sql: str) -> tuple[str, ...]:
    return ("cycle_date",) + _insert_columns(sql)


def _values_expressions(sql: str) -> tuple[str, ...]:
    """The VALUES(...) expressions in order, split at parenthesis depth 0."""
    after = sql.split("VALUES", 1)[1]
    opened = after.index("(")
    depth = 0
    inner = None
    for offset, char in enumerate(after[opened:], opened):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                inner = after[opened + 1 : offset]
                break
    if inner is None:
        raise AssertionError("unterminated VALUES list in the writer SQL")
    parts: list[str] = []
    depth = 0
    current = ""
    for char in inner:
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        current += char
    parts.append(current)
    return tuple(" ".join(part.split()) for part in parts)


def _conflict_key(sql: str) -> str | None:
    """The UPSERT key column — None when the statement is a plain INSERT."""
    match = re.search(r"ON CONFLICT\s*\(([^)]*)\)\s*DO UPDATE", sql)
    return None if match is None else match.group(1).strip()


def _conflict_update_columns(sql: str) -> tuple[str, ...]:
    """Columns the DO UPDATE SET clause refreshes from the proposed row."""
    if "DO UPDATE SET" not in sql:
        return ()
    clause = sql.split("DO UPDATE SET", 1)[1].split("RETURNING", 1)[0]
    return tuple(m.group(1) for m in re.finditer(r"(\w+)\s*=\s*EXCLUDED\.", clause))


class _UpsertTable:
    """Executes the writer's own statement as row semantics, no live driver.

    The conflict key, the column list and the DO UPDATE SET assignments are
    read out of the SQL the writer actually issued, then applied. A writer that
    issued a plain INSERT appends a second row here; a writer whose update set
    omits a column leaves that column at the first write's value. Both are
    visible to the assertions, which is what a dict keyed on params[0] could
    never see.
    """

    def __init__(self) -> None:
        self.rows: list[dict[str, object]] = []
        self.clock = 0  # stands in for CURRENT_TIMESTAMP, one tick per statement

    def _bind(self, sql: str, params) -> list[object]:
        supplied = list(params)
        bound: list[object] = []
        for expression in _values_expressions(sql):
            if expression == "%s":
                bound.append(supplied.pop(0))
            elif expression == "CURRENT_TIMESTAMP":
                bound.append(self.clock)
            else:
                raise AssertionError(f"unsupported VALUES expression: {expression}")
        if supplied:
            raise AssertionError("more parameters than VALUES placeholders")
        return bound

    def execute(self, sql: str, params) -> None:
        self.clock += 1
        columns = _all_insert_columns(sql)
        values = self._bind(sql, params)
        if len(columns) != len(values):
            raise AssertionError("INSERT column list and VALUES list disagree")
        incoming = dict(zip(columns, values))
        key_column = _conflict_key(sql)
        if key_column is not None:
            for stored in self.rows:
                if stored[key_column] == incoming[key_column]:
                    for column in _conflict_update_columns(sql):
                        stored[column] = incoming[column]
                    return
        self.rows.append(incoming)


def _fixture_corpus(root: Path) -> tuple[Path, Path, Path]:
    """Two rule files with a hand-countable word total, and no agent body.

    The empty agents directory is load-bearing: every corpus root has a live
    default, so a fixture that leaves one unset measures this machine.
    """
    rules_dir = root / "rules"
    rules_dir.mkdir()
    (rules_dir / "a.md").write_text("alpha beta gamma\n", encoding="utf-8")
    global_rules = root / "GLOBAL.md"
    global_rules.write_text("delta epsilon\n", encoding="utf-8")
    agents_dir = root / "agents"
    agents_dir.mkdir()
    return rules_dir, global_rules, agents_dir


class CorpusAuditSignalTest(unittest.TestCase):
    """T12 (1) — known-answer fixture, column-for-column, NULL preserved."""

    def test_emit_carries_every_measurement_column_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rules_dir, global_rules, agents_dir = _fixture_corpus(Path(tmp))
            signal = dc.audit_corpus_size(
                rules_dir=rules_dir,
                global_rules_file=global_rules,
                agents_dir=agents_dir,
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
            rules_dir, global_rules, agents_dir = _fixture_corpus(Path(tmp))
            signal = dc.audit_corpus_size(
                rules_dir=rules_dir,
                global_rules_file=global_rules,
                agents_dir=agents_dir,
            )
        self.assertEqual(signal["word_count"], 5)
        self.assertEqual(signal["file_count"], 2)


def _fixture_widened_corpus(root: Path) -> tuple[Path, Path, Path]:
    """A tree carrying rules files, agent bodies and GLOBAL_RULES.md.

    The archived body is the discrimination control — a recursive agents glob
    sweeps it in, and it is not corpus the loop appends to.
    """
    rules_dir = root / "rules"
    (rules_dir / "nested").mkdir(parents=True)
    (rules_dir / "core.md").write_text("alpha beta\n", encoding="utf-8")
    (rules_dir / "nested" / "scope.md").write_text("gamma\n", encoding="utf-8")
    agents_dir = root / "agents"
    (agents_dir / "archive").mkdir(parents=True)
    (agents_dir / "dev-python.md").write_text("delta epsilon zeta\n", encoding="utf-8")
    (agents_dir / "qa-reviewer.md").write_text("eta\n", encoding="utf-8")
    (agents_dir / "archive" / "retired.md").write_text("theta\n", encoding="utf-8")
    global_rules = agents_dir / "GLASS_ATRIUM_GLOBAL_RULES.md"
    global_rules.write_text("iota kappa\n", encoding="utf-8")
    return rules_dir, global_rules, agents_dir


class CorpusFileSetTest(unittest.TestCase):
    """T4 — the enumerated set gained the agent bodies and lost no rules file."""

    def test_widened_set_adds_agent_bodies_and_keeps_the_rules_corpus(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rules_dir, global_rules, agents_dir = _fixture_widened_corpus(Path(tmp))
            returned = set(dc._corpus_files(rules_dir, global_rules, agents_dir))
            agent_bodies = set(agents_dir.glob("*.md"))
            pre_widening = set(rules_dir.rglob("*.md")) | {global_rules}

            self.assertEqual(agent_bodies - returned, set())
            self.assertEqual(pre_widening - returned, set())
            self.assertNotIn(agents_dir / "archive" / "retired.md", returned)

    def test_the_returned_list_carries_no_duplicate(self) -> None:
        """GLOBAL_RULES.md sits inside agents_dir, so both sources find it."""
        with tempfile.TemporaryDirectory() as tmp:
            rules_dir, global_rules, agents_dir = _fixture_widened_corpus(Path(tmp))
            files = dc._corpus_files(rules_dir, global_rules, agents_dir)
            self.assertIn(global_rules, files)
        self.assertEqual(len(files), len(set(files)))

    def test_the_widened_measurement_reaches_the_writer_unchanged(self) -> None:
        """Zero schema touch — the widened reading rides the delivered columns."""
        with tempfile.TemporaryDirectory() as tmp:
            rules_dir, global_rules, agents_dir = _fixture_widened_corpus(Path(tmp))
            enumerated = dc._corpus_files(rules_dir, global_rules, agents_dir)
            expected_words = sum(
                len(path.read_text(encoding="utf-8").split()) for path in enumerated
            )
            signal = dc.audit_corpus_size(
                rules_dir=rules_dir,
                global_rules_file=global_rules,
                agents_dir=agents_dir,
                gate_log_file=Path(tmp) / "absent-gate.log",
            )

        captured: dict[str, object] = {}
        with _patched_writer(lambda **kw: captured.update(kw) or 1):
            self.assertTrue(dc.emit_corpus_audit(signal, "2026-08-17"))

        self.assertEqual(signal["word_count"], expected_words)
        self.assertEqual(signal["file_count"], len(enumerated))
        for column in _MEASUREMENT_COLUMNS:
            self.assertEqual(captured[column], signal[column], column)
        # The one-time step is not an alert: no baseline is passed, so the trend
        # axis stays insufficient-data rather than firing on the jump.
        self.assertIsNone(captured["trend_delta"])
        self.assertFalse(captured["trend_alert"])


class CorpusAuditUpsertTest(unittest.TestCase):
    """T12 (2) — one row per cycle_date after a repeat run; positional binding."""

    def test_sql_binds_thirteen_columns_in_declared_order(self) -> None:
        sql = _corpus_audit_sql()
        self.assertEqual(_insert_columns(sql), _WRITTEN_COLUMNS)
        self.assertEqual(sql.count("%s"), 1 + len(_MEASUREMENT_COLUMNS))
        self.assertIn("ON CONFLICT (cycle_date) DO UPDATE", sql)
        for column in _WRITTEN_COLUMNS:
            self.assertIn(f"{column} = EXCLUDED.{column}", sql)

    @unittest.skipUnless(HAS_PSYCOPG, "psycopg absent — driver-bound path")
    def test_two_runs_leave_exactly_one_row(self) -> None:
        """The fake applies the writer's own upsert clause, not a keyed dict.

        A plain INSERT would append and leave two cycle_date entries below; an
        update set missing indexed_at would leave the row's stamp at the first
        write's tick while its values came from the second.
        """
        helper = _load_pg_helper()
        table = _UpsertTable()

        with _patched_connect(helper, table.execute):
            for word_count in (100, 200):
                helper.write_autoagent_corpus_audit(
                    "2026-08-16", word_count, 10, 3, True, 5, False, 110,
                    None, None, 1, 0, 1,
                )

        # One reading per cycle_date, whatever the writer issued.
        self.assertEqual([row["cycle_date"] for row in table.rows], ["2026-08-16"])
        stored = table.rows[0]
        # Every measurement carries the second run's value...
        self.assertEqual(stored["word_count"], 200)
        # ...and so does the timestamp — a row of second-run values must not
        # read as of the first run.
        self.assertEqual(stored["indexed_at"], table.clock)

    @unittest.skipUnless(HAS_PSYCOPG, "psycopg absent — driver-bound path")
    def test_parameter_order_matches_the_insert_column_list(self) -> None:
        helper = _load_pg_helper()

        seen: list[tuple] = []

        def _execute(sql, params):
            self.assertEqual(_insert_columns(sql), _WRITTEN_COLUMNS)
            seen.append(params)

        with _patched_connect(helper, _execute):
            helper.write_autoagent_corpus_audit(
                "2026-08-16", 1, 2, 3, False, None, False, 4, None, None, 5, 6, 7
            )
        self.assertEqual(len(seen[0]), 1 + len(_MEASUREMENT_COLUMNS))
        self.assertIsNone(seen[0][5])


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
