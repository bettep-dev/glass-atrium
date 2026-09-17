"""Behavioral tests for the parked-pattern apply guard mode (plan clauded-docs/39762, Q1/Q2).

``daemon_cycle.py --parked-pattern-guard`` reads the apply stage's selected proposals as
JSON lines on stdin and prints one JSON verdict line. A proposal is guarded when its label
covers at least one stored pattern row and every covered row is terminal. Only
``--reject-parked`` writes, and a guard failure leaves stdout empty behind a named exit.

Database-free: the status-agnostic read, the proposal connection and the loop-event writer
are sealed for the whole module; each test patches the read or the write it drives.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_apply_parked_guard.py -v
    python3 -m unittest autoagent.test.test_apply_parked_guard -v

CID: 2026-09-17T2000_apply-guard-impl_3f9a
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

import daemon_cycle as dc  # noqa: E402

_SEALS: list = []


def _refuse(*_args: object, **_kwargs: object):
    raise AssertionError("unsealed PG reach from test_apply_parked_guard")


def setUpModule() -> None:
    """A missed per-test patch fails loudly instead of reading or writing live PG."""
    _SEALS.extend(
        [
            mock.patch.object(dc, "_invoke_pg_helper", _refuse),
            mock.patch.object(dc, "_pg_connect", _refuse, create=True),
            mock.patch.object(dc, "_pg_read_coverage_patterns", _refuse, create=True),
        ]
    )
    for seal in _SEALS:
        seal.start()


def tearDownModule() -> None:
    for seal in reversed(_SEALS):
        seal.stop()
    _SEALS.clear()


# Row 3384's stored core and proposal 7497's label (verbatim); the other rows reuse
# real stored cores under the bare-stem agent key learning_log rows carry.
_SIZE_EST_CORE = "size-est under-estimate concentration (avg overrun + tool_uses)"
_BUDGET_CORE = "budget-overage concentration"
_FAIL_CORE = "repeated failure by same agent"
_AGENT = "glass-atrium-dev-nestjs"
_BARE_AGENT = "dev-nestjs"
_CONSOLIDATION_LABEL = (
    f"{_AGENT} multi-signal consolidation ({_BUDGET_CORE} / {_FAIL_CORE})"
)


def _row(row_id: int, core: str, status: str, agent: str = _BARE_AGENT) -> dict:
    return {
        "id": row_id,
        "agent": agent,
        "pattern_signature": f"{core}|{agent}",
        "status": status,
    }


def _patch_line(proposal_id: int, label: str, agent: str = _AGENT) -> str:
    """One PATCH_ROWS element as the apply script holds it (extra keys included)."""
    return json.dumps(
        {
            "pattern_label": label,
            "pattern_agent": agent,
            "target_file": f"/agents/{agent}.md",
            "proposed_diff": "--- a\n+++ b\n",
            "cycle_date": "2026-09-16",
            "proposal_id": str(proposal_id),
        }
    )


def _run_guard(
    argv: list[str],
    stdin_text: str,
    *,
    coverage: dict | None,
    rejected_ids: list[int] | None = None,
    write_error: Exception | None = None,
) -> tuple[int, str, str, mock.Mock]:
    write = mock.Mock(side_effect=write_error, return_value=rejected_ids or [])
    stdout, stderr = io.StringIO(), io.StringIO()
    with (
        mock.patch.object(dc, "get_coverage_rows_by_agent", return_value=coverage),
        mock.patch.object(dc, "update_parked_proposal_status", write),
        mock.patch.object(sys, "stdin", io.StringIO(stdin_text)),
        contextlib.redirect_stdout(stdout),
        contextlib.redirect_stderr(stderr),
    ):
        rc = dc._main(argv)
    return rc, stdout.getvalue(), stderr.getvalue(), write


def _verdict(stdout: str) -> dict:
    lines = stdout.splitlines()
    assert len(lines) == 1, f"expected one verdict line, got {stdout!r}"
    return json.loads(lines[0])


class GuardVerdictRuleTest(unittest.TestCase):
    """Guarded ⇔ the covered row set is non-empty AND every covered row is terminal."""

    def test_should_guard_only_proposals_whose_covered_rows_are_all_terminal(self) -> None:
        cases = (
            # (name, label, stored rows, expected covered row ids or None = not guarded)
            ("all-terminal", _SIZE_EST_CORE, [_row(3384, _SIZE_EST_CORE, "rejected")], [3384]),
            (
                "consolidation label, all terminal",
                _CONSOLIDATION_LABEL,
                [_row(8, _BUDGET_CORE, "rejected"), _row(3, _FAIL_CORE, "applied")],
                [8, 3],
            ),
            (
                "prefixed row agent keys like the bare stem",
                _SIZE_EST_CORE,
                [_row(3384, _SIZE_EST_CORE, "rejected", agent=_AGENT)],
                [3384],
            ),
            (
                "mixed",
                _CONSOLIDATION_LABEL,
                [_row(8, _BUDGET_CORE, "rejected"), _row(3, _FAIL_CORE, "identified")],
                None,
            ),
            ("non-terminal only", _SIZE_EST_CORE, [_row(3384, _SIZE_EST_CORE, "identified")], None),
            ("no covering row", _SIZE_EST_CORE, [_row(8, _BUDGET_CORE, "rejected")], None),
        )
        for name, label, rows, expected_ids in cases:
            with self.subTest(name):
                rc, stdout, _, _ = _run_guard(
                    ["--parked-pattern-guard"],
                    _patch_line(7497, label) + "\n",
                    coverage=dc._index_rows_by_agent(rows),
                )
                self.assertEqual(rc, 0)
                guarded = _verdict(stdout)["guarded"]
                if expected_ids is None:
                    self.assertEqual(guarded, [])
                    continue
                self.assertEqual([entry["proposal_id"] for entry in guarded], [7497])
                self.assertEqual(
                    sorted(row["id"] for row in guarded[0]["rows"]), sorted(expected_ids)
                )
                self.assertTrue(
                    all(row["status"] in dc.PATTERN_TERMINAL_STATUSES for row in guarded[0]["rows"])
                )

    def test_should_judge_each_selected_proposal_independently(self) -> None:
        rows = [_row(3384, _SIZE_EST_CORE, "rejected"), _row(3, _FAIL_CORE, "identified")]
        stdin_text = "\n".join(
            [_patch_line(7497, _SIZE_EST_CORE), _patch_line(7501, _FAIL_CORE)]
        )
        rc, stdout, stderr, _ = _run_guard(
            ["--parked-pattern-guard"], stdin_text, coverage=dc._index_rows_by_agent(rows)
        )
        self.assertEqual(rc, 0)
        self.assertEqual([entry["proposal_id"] for entry in _verdict(stdout)["guarded"]], [7497])
        self.assertIn("id=7497", stderr)


class GuardWriteFlagTest(unittest.TestCase):
    """The guarded-reject write runs only under --reject-parked, and only for guarded rows."""

    _ROWS = [_row(3384, _SIZE_EST_CORE, "rejected")]

    def test_should_write_iff_the_explicit_flag_is_passed(self) -> None:
        for argv, expect_write in (
            (["--parked-pattern-guard"], False),
            (["--parked-pattern-guard", "--dry-run"], False),
            (["--parked-pattern-guard", "--reject-parked"], True),
        ):
            with self.subTest(argv=argv):
                rc, stdout, _, write = _run_guard(
                    argv,
                    _patch_line(7497, _SIZE_EST_CORE),
                    coverage=dc._index_rows_by_agent(self._ROWS),
                    rejected_ids=[7497],
                )
                self.assertEqual(rc, 0)
                verdict = _verdict(stdout)
                self.assertEqual(write.called, expect_write)
                self.assertEqual(verdict["rejected"], [7497] if expect_write else [])
                self.assertEqual([entry["proposal_id"] for entry in verdict["guarded"]], [7497])
                if expect_write:
                    self.assertEqual(write.call_args.args[0], verdict["guarded"])

    def test_should_refuse_the_write_flag_outside_guard_mode(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            dc._main(["--reject-parked"])

    def test_should_open_no_connection_when_nothing_is_guarded(self) -> None:
        # The module seal on _pg_connect raises, so a connect would surface as a failure exit.
        self.assertEqual(dc.update_parked_proposal_status([]), [])


class GuardedRejectWriteTest(unittest.TestCase):
    """The write is status-guarded to pending/snoozed and stamps the Python-owned head."""

    def test_should_reject_only_actionable_rows_with_the_parked_rationale(self) -> None:
        executed: list[tuple[str, tuple]] = []
        returning = {7497: [(7497,)], 7501: []}  # 7501 turned non-actionable before the write

        cursor = mock.MagicMock()
        cursor.execute.side_effect = lambda sql, params: executed.append((sql, params))
        cursor.fetchall.side_effect = lambda: returning[executed[-1][1][-1]]
        conn = mock.MagicMock()
        conn.cursor.return_value.__enter__.return_value = cursor
        connect = mock.MagicMock()
        connect.return_value.__enter__.return_value = conn

        parked = [
            {"proposal_id": 7497, "rows": [{"id": 3384, "status": "rejected"}]},
            {
                "proposal_id": 7501,
                "rows": [{"id": 8, "status": "rejected"}, {"id": 3, "status": "applied"}],
            },
        ]
        with (
            mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True),
            mock.patch.object(dc, "_pg_connect", connect, create=True),
        ):
            rejected = dc.update_parked_proposal_status(parked)

        self.assertEqual(rejected, [7497])
        self.assertEqual(len(executed), 2)
        conn.commit.assert_called_once()
        for (sql, params), entry in zip(executed, parked):
            self.assertIn("status IN ('pending', 'snoozed')", sql)
            self.assertIn("SET status = 'rejected'", sql)
            rationale = params[0]
            self.assertTrue(rationale.startswith(dc._PARKED_PATTERN_REASON))
            for row in entry["rows"]:
                self.assertIn(f"{row['id']}:{row['status']}", rationale)
            self.assertEqual(params[-1], entry["proposal_id"])

    def test_should_raise_when_the_proposal_write_helper_is_absent(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False), self.assertRaises(RuntimeError):
            dc.update_parked_proposal_status(
                [{"proposal_id": 7497, "rows": [{"id": 3384, "status": "rejected"}]}]
            )


class GuardFailureTest(unittest.TestCase):
    """Any guard failure → named exit, empty stdout, stderr naming the interpreter."""

    def test_should_fail_closed_and_name_the_interpreter(self) -> None:
        index = dc._index_rows_by_agent([_row(3384, _SIZE_EST_CORE, "rejected")])
        cases = (
            ("read None", ["--parked-pattern-guard"], _patch_line(7497, _SIZE_EST_CORE), None, None),
            ("malformed line", ["--parked-pattern-guard"], "{not json", index, None),
            (
                "line without proposal id",
                ["--parked-pattern-guard"],
                json.dumps({"pattern_label": "x"}),
                index,
                None,
            ),
            (
                "write raises",
                ["--parked-pattern-guard", "--reject-parked"],
                _patch_line(7497, _SIZE_EST_CORE),
                index,
                RuntimeError("PG write failed"),
            ),
        )
        for name, argv, stdin_text, coverage, write_error in cases:
            with self.subTest(name):
                rc, stdout, stderr, write = _run_guard(
                    argv, stdin_text, coverage=coverage, write_error=write_error
                )
                self.assertEqual(rc, dc.PARKED_GUARD_FAILURE_EXIT_CODE)
                self.assertNotEqual(rc, 0)
                self.assertEqual(stdout, "")
                self.assertIn(sys.executable, stderr)
                if write_error is None:
                    write.assert_not_called()

    def test_should_answer_while_the_update_pause_flag_is_held(self) -> None:
        with (
            mock.patch.object(dc, "HAS_PAUSE_LIB", True),
            mock.patch.object(dc, "_update_is_pause_active", return_value=True, create=True),
        ):
            rc, stdout, _, _ = _run_guard(
                ["--parked-pattern-guard"],
                _patch_line(7497, _SIZE_EST_CORE),
                coverage=dc._index_rows_by_agent([_row(3384, _SIZE_EST_CORE, "rejected")]),
            )
        self.assertEqual(rc, 0)
        self.assertEqual([entry["proposal_id"] for entry in _verdict(stdout)["guarded"]], [7497])


class GuardedRejectClassifierTest(unittest.TestCase):
    """A guarded reject is non-adjudicating: the kill streak looks past it."""

    def test_should_not_advance_the_reject_streak_on_a_guarded_reject(self) -> None:
        guarded_rationale = f"{dc._PARKED_PATTERN_REASON} (rows 3384:rejected)"
        self.assertIn(
            dc.classify_failure_rationale(guarded_rationale), dc._NON_ADJUDICATION_CLASSES
        )
        guarded_history = [("rejected", _SIZE_EST_CORE, guarded_rationale)]
        quality_history = [("rejected", _SIZE_EST_CORE, "diff restates an existing rule")]
        self.assertEqual(dc.consecutive_reject_count(_SIZE_EST_CORE, guarded_history), 0)
        self.assertEqual(dc.consecutive_reject_count(_SIZE_EST_CORE, quality_history), 1)


if __name__ == "__main__":
    unittest.main()
