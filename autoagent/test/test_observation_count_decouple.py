"""Behavioral tests for the daemon-apply.sh backlog gate's promotion-tier allowlist.

Protected invariants:

(1) the backlog gate (live SQL, executed verbatim from the script) accepts a
    'candidate' row and still rejects 'mention'
    (the deleted daemon-apply bats no longer cover this — commit c9cce51);
(2) a safety-routed body-auto proposal, stored by the dual-write writer outside
    the 'auto' tier, is not selected by that gate.

The live-PG class runs only on the ephemeral cluster ``live-pg-ephemeral.bats``
builds (elsewhere it skips, never touching an install's live database) and
inserts fixtures in an open, never-committed transaction rolled back on teardown.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_observation_count_decouple.py -v
    python3 -m unittest autoagent.test.test_observation_count_decouple -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import re
import sys
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

# Repo hooks/ and autoagent/ first → this checkout's helper and daemon, never an install's.
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
# unittest discover and ``-m unittest`` from another cwd leave this directory off sys.path.
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from _pg_seal import get_ephemeral_connection

try:
    import _pg_learning_dualwrite as pgdw
    import daemon_cycle  # noqa: F401 — puts repo scripts/ on sys.path for the writer below

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    pgdw = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _IMPORT_ERROR = exc

# The writer daemon_cycle bound on import (repo scripts/ first on its sys.path).
try:
    import _pg_dual_write_daemon as dual_write

    _WRITER_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dual_write = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _WRITER_IMPORT_ERROR = exc

_PROBE_AGENT = "f1-obscount-probe"

_APPLY_SH = _AUTOAGENT_DIR / "daemon-apply.sh"
_GATE_LABEL = {
    "candidate": "f1-gate-candidate-fixture",
    "mention": "f1-gate-mention-fixture",
    "safety": "f1-gate-safety-routed-fixture",
}
# Columns of every backlog predicate other than approval_tier.
_BACKLOG_PREDICATE_COLUMNS = (
    "classification::text, pre_verify_passed, status::text, promotion_tier"
)


class _NonCommittingConn:
    """Hand the helper an already-open transaction; swallow its context exit and
    its commit so neither commit nor close fires — the owning test rolls back instead.
    """

    def __init__(self, conn: object) -> None:
        self._conn = conn

    def __enter__(self) -> "_NonCommittingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self):  # noqa: ANN201 — real psycopg cursor, type lives upstream
        return self._conn.cursor()

    def commit(self) -> None:
        return None


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
@unittest.skipIf(dual_write is None, f"import failed: {_WRITER_IMPORT_ERROR}")
class TestApplyGateAllowlist(unittest.TestCase):
    """The backlog SELECT (verbatim from daemon-apply.sh) passes 'candidate',
    excludes 'mention' and excludes the safety-routed row."""

    conn = None
    # Not `id`: that would shadow TestCase.id(), which the runner calls to name each test.
    proposal_id: dict[str, int]

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
        cls.conn = get_ephemeral_connection()
        cls.addClassCleanup(cls._rollback_and_close)

        cls.proposal_id = {}
        cycle_date = date.today()
        with cls.conn.cursor() as cur:
            # These two fixture classes are named after the promotion_tier they store.
            for tier in ("candidate", "mention"):
                label = _GATE_LABEL[tier]
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
                        cycle_date,
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
                cls.proposal_id[tier] = cur.fetchone()[0]
        cls.proposal_id["safety"] = cls._write_safety_routed_row(cycle_date)

    @classmethod
    def _write_safety_routed_row(cls, cycle_date: date) -> int:
        """Store a safety-routed body-auto proposal through the real writer, on the
        class transaction, eligible on every other backlog predicate."""
        label = _GATE_LABEL["safety"]
        patcher = mock.patch.object(
            dual_write, "_connect", lambda: _NonCommittingConn(cls.conn)
        )
        with patcher:
            dual_write.write_autoagent_proposal(
                cycle_date=cycle_date,
                pattern_label=label,
                target_file=f"/tmp/{label}.md",
                target_agent=_PROBE_AGENT,
                classification="body-auto",
                rationale="f1 gate fixture",
                haiku_status="ok",
                approval_tier="safety",
                status="pending",
                proposed_diff="f1 gate fixture diff",
                cost_guard_state="ok",
                source_file="f1-gate-fixture",
                source_file_mtime=0,
                pre_verify_passed=True,
                promotion_tier="candidate",
            )
        with cls.conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM core.autoagent_proposals WHERE pattern_label = %s",
                (label,),
            )
            return cur.fetchone()[0]

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
        self.assertIn(self.proposal_id["candidate"], selected_ids)
        self.assertNotIn(self.proposal_id["mention"], selected_ids)

    def test_when_gate_runs_then_safety_routed_row_is_not_selected(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                f"SELECT id, {_BACKLOG_PREDICATE_COLUMNS} "
                "FROM core.autoagent_proposals WHERE id IN (%s, %s)",
                (self.proposal_id["candidate"], self.proposal_id["safety"]),
            )
            predicate_values = {row[0]: row[1:] for row in cur.fetchall()}
            cur.execute(self._backlog_sql())
            selected_ids = {row[0] for row in cur.fetchall()}
        self.assertEqual(
            predicate_values[self.proposal_id["safety"]],
            predicate_values[self.proposal_id["candidate"]],
            "the safety row must differ from the candidate row only in approval_tier",
        )
        self.assertIn(self.proposal_id["candidate"], selected_ids)
        self.assertNotIn(self.proposal_id["safety"], selected_ids)


if __name__ == "__main__":
    unittest.main(verbosity=2)
