"""Behavioral tests for the observation_count / sample-cap decoupling (F1).

The promotion ladder's ``observation_count`` previously was ``len(signals)``
of the OUTCOME_SAMPLE_LIMIT-capped posterior sample — structurally pinned
below PROMOTION_CANDIDATE_MIN_OBSERVATIONS, so ``promotion_tier`` could never
reach 'candidate' and the daemon-apply.sh allowlist blocked every unattended
auto-apply. With the user-approved re-enable, ``observation_count`` is the
TRUE qualifying-row count (``count_outcomes_since`` — COUNT(*) sharing
``read_outcomes_since``'s WHERE, poisoned_window excluded) while the posterior
sample stays capped. Protected invariants:

(1) ``count_outcomes_since`` runs an uncapped COUNT(*) over the SAME window
    predicate as the row read (shared ``_learning_window_where``);
(2) for an agent with >=10 qualifying outcomes the sample stays capped at 5
    while ``daemon_cycle._fetch_promotion_stats`` reports the true count;
(3) a capped-sample posterior + true n>=10 classifies as 'candidate'
    (the old capped-n regression stays 'mention');
(4) the daemon-apply.sh backlog gate (live SQL, executed verbatim from the
    script) accepts a 'candidate' row and still rejects 'mention'
    (the deleted daemon-apply bats no longer cover this — commit c9cce51).

Live-PG classes insert fixtures in an open, never-committed transaction
(rolled back on teardown — the database is left byte-identical; no DELETE
needed). The SQL-shape class needs no database.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_observation_count_decouple.py -v
    python3 -m unittest autoagent.test.test_observation_count_decouple -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import re
import sys
import time
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

# The helper MUST enter sys.modules before daemon_cycle imports it, so both the
# test and the daemon bind to ONE module object and a single psycopg patch
# covers the count and the row read.
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import _pg_learning_dualwrite as pgdw
    import daemon_cycle as dc
    from confidence import OutcomeSignal, compute_confidence_observed

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    pgdw = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_PROBE_AGENT = "f1-obscount-probe"
_QUALIFYING_ROWS = 12
_SAMPLE_CAP = 5

_APPLY_SH = _AUTOAGENT_DIR / "daemon-apply.sh"
_GATE_CANDIDATE_LABEL = "f1-gate-candidate-fixture"
_GATE_MENTION_LABEL = "f1-gate-mention-fixture"


class _RecordingCursor:
    def __init__(self, log: list[tuple[str, tuple]]) -> None:
        self._log = log

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: tuple = ()) -> None:
        self._log.append((sql, params))

    def fetchall(self) -> list:
        return []

    def fetchone(self) -> tuple:
        return (0,)


class _RecordingConn:
    def __init__(self, log: list[tuple[str, tuple]]) -> None:
        self._log = log

    def __enter__(self) -> "_RecordingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _RecordingCursor:
        return _RecordingCursor(self._log)


class _NonCommittingConn:
    """Hand the helper an already-open transaction; swallow its context exit so
    neither commit nor close fires — the owning test rolls back instead.
    """

    def __init__(self, conn: object) -> None:
        self._conn = conn

    def __enter__(self) -> "_NonCommittingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self):  # noqa: ANN201 — real psycopg cursor, type lives upstream
        return self._conn.cursor()


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestCountSqlSharesRowReadWindow(unittest.TestCase):
    """COUNT(*) carries the exact row-read WHERE — uncapped, same exclusions."""

    def setUp(self) -> None:
        self._log: list[tuple[str, tuple]] = []
        stub = SimpleNamespace(connect=lambda *a, **k: _RecordingConn(self._log))
        patcher = mock.patch.object(pgdw, "psycopg", stub)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_when_counting_then_sql_is_uncapped_count_star(self) -> None:
        pgdw.count_outcomes_since(0.0, agent=_PROBE_AGENT)
        self.assertEqual(len(self._log), 1)
        sql = self._log[0][0]
        self.assertIn("SELECT count(*)", sql)
        self.assertNotIn("LIMIT", sql)
        self.assertIn("COALESCE(poisoned_window, false) = false", sql)

    def test_when_counting_then_where_matches_row_read_where(self) -> None:
        pgdw.count_outcomes_since(0.0, agent=_PROBE_AGENT)
        pgdw.read_outcomes_since(0.0, agent=_PROBE_AGENT, limit=5, order="DESC")
        count_sql, count_params = self._log[0]
        read_sql, _ = self._log[1]
        count_where = count_sql.split("WHERE", 1)[1].strip()
        read_where = read_sql.split("WHERE", 1)[1].split("ORDER BY", 1)[0].strip()
        self.assertEqual(count_where, read_where)
        # count params == read params minus the trailing LIMIT bind.
        self.assertEqual(tuple(count_params), tuple(self._log[1][1][:-1]))


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestTrueCountWithCappedSample(unittest.TestCase):
    """An agent with 12 qualifying outcomes: sample stays 5, count reports 12."""

    conn = None

    @classmethod
    def setUpClass(cls) -> None:
        import psycopg

        try:
            cls.conn = psycopg.connect("dbname=glass_atrium", connect_timeout=2)
        except Exception as exc:  # noqa: BLE001 — no PG → skip the live class
            raise unittest.SkipTest(f"PG unreachable: {type(exc).__name__}: {exc}")
        cls.addClassCleanup(cls._rollback_and_close)

        now = time.time()
        with cls.conn.cursor() as cur:
            # 12 qualifying rows + 1 poisoned row (must count for nothing).
            for idx in range(_QUALIFYING_ROWS + 1):
                poisoned = idx == _QUALIFYING_ROWS
                cur.execute(
                    "INSERT INTO core.outcomes "
                    "(record_ts, agent, task_type, result, revision_count, "
                    " attribution_source, summary, cid, poisoned_window) "
                    'VALUES (to_timestamp(%s), %s, %s::core."TaskType", '
                    '        %s::core."OutcomeResult", %s, %s, %s, %s, %s)',
                    (
                        now - 60.0 * (idx + 1),
                        _PROBE_AGENT,
                        "feature",
                        "done",
                        0,
                        "hook-input",
                        "f1 observation-count fixture",
                        f"f1-obscount-{idx}",
                        poisoned,
                    ),
                )

        stub = SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(cls.conn))
        cls._patcher = mock.patch.object(pgdw, "psycopg", stub)
        cls._patcher.start()
        cls.addClassCleanup(cls._patcher.stop)

    @classmethod
    def _rollback_and_close(cls) -> None:
        if cls.conn is not None:
            cls.conn.rollback()
            cls.conn.close()

    def test_when_row_read_capped_then_sample_length_stays_at_cap(self) -> None:
        rows = pgdw.read_outcomes_since(
            time.time() - 3600, agent=_PROBE_AGENT, limit=_SAMPLE_CAP, order="DESC"
        )
        self.assertEqual(len(rows), _SAMPLE_CAP)

    def test_when_counting_then_true_count_excludes_poisoned(self) -> None:
        count = pgdw.count_outcomes_since(time.time() - 3600, agent=_PROBE_AGENT)
        self.assertEqual(count, _QUALIFYING_ROWS)

    def test_when_fetching_promotion_stats_then_count_decoupled_from_sample(
        self,
    ) -> None:
        signals, observation_count = dc._fetch_promotion_stats(_PROBE_AGENT)
        self.assertEqual(len(signals), _SAMPLE_CAP)
        self.assertEqual(observation_count, _QUALIFYING_ROWS)
        self.assertGreaterEqual(
            observation_count, dc.PROMOTION_CANDIDATE_MIN_OBSERVATIONS
        )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestCandidateTierReachable(unittest.TestCase):
    """Capped-sample posterior + true n >= 10 → 'candidate' (ladder unblocked)."""

    @staticmethod
    def _capped_success_posterior() -> float:
        # 5/5-success sample → Beta(6,1) mean = 6/7 ≈ 0.857. The α/β accumulation
        # never divides by the sample length, so the capped sample cannot
        # depress the posterior below the 0.7 candidate threshold.
        sample = [
            OutcomeSignal(revision_count=0, result="done", evaluative_signal=0)
            for _ in range(_SAMPLE_CAP)
        ]
        return compute_confidence_observed(sample)

    def test_when_true_n_meets_floor_then_candidate(self) -> None:
        posterior = self._capped_success_posterior()
        self.assertGreaterEqual(posterior, dc.PROMOTION_CANDIDATE_CONFIDENCE)
        tier = dc.classify_promotion_tier(
            confidence_observed=posterior,
            observation_count=_QUALIFYING_ROWS,
            sustained=False,
            touches_frontmatter=False,
        )
        self.assertEqual(tier, "candidate")

    def test_when_n_stuck_at_capped_length_then_mention(self) -> None:
        # Regression pin for the old coupling: n == sample cap < 10 → mention.
        tier = dc.classify_promotion_tier(
            confidence_observed=self._capped_success_posterior(),
            observation_count=_SAMPLE_CAP,
            sustained=False,
            touches_frontmatter=False,
        )
        self.assertEqual(tier, "mention")


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestApplyGateAllowlist(unittest.TestCase):
    """The backlog SELECT (verbatim from daemon-apply.sh) passes 'candidate'
    and excludes 'mention'."""

    conn = None
    candidate_id: int = -1
    mention_id: int = -1

    @classmethod
    def _backlog_sql(cls) -> str:
        text = _APPLY_SH.read_text(encoding="utf-8")
        segments = re.findall(r"<<'PSQL'\n(.*?)\nPSQL\n", text, flags=re.DOTALL)
        matches = [
            s
            for s in segments
            if "FROM core.autoagent_proposals" in s and "promotion_tier IN" in s
        ]
        if len(matches) != 1:
            raise AssertionError(
                f"expected exactly 1 backlog heredoc, found {len(matches)}"
            )
        return matches[0]

    @classmethod
    def setUpClass(cls) -> None:
        import psycopg

        try:
            cls.conn = psycopg.connect("dbname=glass_atrium", connect_timeout=2)
        except Exception as exc:  # noqa: BLE001 — no PG → skip the live class
            raise unittest.SkipTest(f"PG unreachable: {type(exc).__name__}: {exc}")
        cls.addClassCleanup(cls._rollback_and_close)

        with cls.conn.cursor() as cur:
            for label, tier, attr in (
                (_GATE_CANDIDATE_LABEL, "candidate", "candidate_id"),
                (_GATE_MENTION_LABEL, "mention", "mention_id"),
            ):
                cur.execute(
                    "INSERT INTO core.autoagent_proposals "
                    "(cycle_date, pattern_label, target_file, target_agent, "
                    " classification, approval_tier, status, proposed_diff, "
                    " pre_verify_passed, source_file, source_file_mtime, "
                    " promotion_tier) "
                    'VALUES (%s, %s, %s, %s, %s::core."ProposalClassification", '
                    '        %s::core."ApprovalTier", %s::core."ProposalStatus", '
                    "        %s, %s, %s, %s, %s) "
                    "RETURNING id",
                    (
                        date.today(),
                        label,
                        f"/tmp/{label}.md",
                        _PROBE_AGENT,
                        "apply",
                        "auto",
                        "pending",
                        "f1 gate fixture diff",
                        True,
                        "f1-gate-fixture",
                        0,
                        tier,
                    ),
                )
                setattr(cls, attr, cur.fetchone()[0])

    @classmethod
    def _rollback_and_close(cls) -> None:
        if cls.conn is not None:
            cls.conn.rollback()
            cls.conn.close()

    def test_when_gate_runs_then_candidate_passes_and_mention_is_blocked(
        self,
    ) -> None:
        with self.conn.cursor() as cur:
            cur.execute(self._backlog_sql())
            selected_ids = {row[0] for row in cur.fetchall()}
        self.assertIn(self.candidate_id, selected_ids)
        self.assertNotIn(self.mention_id, selected_ids)


if __name__ == "__main__":
    unittest.main(verbosity=2)
