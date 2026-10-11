"""Behavioral tests for the landed-history and prior-attempts blocks in the generation prompt.

``daemon_cycle.generate_consolidated_proposal`` reads this agent's trialled proposals
from the trial ledger (prior attempts, with their measured effect) and its APPLIED
proposals with no ledger row (landed history) into the prompt beside the prior-failure
block. Covered here:
  (a) both reads are fail-OPEN (PG off / empty agent → ``None``); the landed read
      returns proposal ids beside an applied-only projection;
  (b) both blocks render the lines a patch ADDED, sanitized, and are HARD-capped;
      a prior attempt carries its LANDED marker and its measured effect;
  (c) with an applied proposal carrying a sentinel in its patch text, the
      assembled prompt contains that sentinel exactly once;
  (d) with zero applied proposals and one rejected-and-failed-pre-verify
      proposal, that proposal's patch text is ABSENT and the prompt carries no
      unsubstituted placeholder.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_landed_history_memory.py -v
    python3 -m unittest autoagent.test.test_landed_history_memory -v
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))
_STUB_DIR = _REPO_ROOT / "scripts" / "test"
if str(_STUB_DIR) not in sys.path:
    sys.path.insert(0, str(_STUB_DIR))

import _pg_stub_backend as stub  # noqa: E402 — anchors pinned above
from _pg_seal import seal_pg_reach  # noqa: E402 — anchors pinned above

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_AGENT = "dev-python"
_HEADER = SimpleNamespace(
    LANDED="rules that previously LANDED for this agent",
    ATTEMPTS="prior trial attempts for this agent",
)
_LANDED_SENTINEL = "LANDED-RULE-SENTINEL-7c21ae"
_REJECTED_SENTINEL = "REJECTED-RULE-SENTINEL-7c21ae"
_LANDED_DIFF = (
    "--- a/dev-python.md\n"
    "+++ b/dev-python.md\n"
    "@@ -10,2 +10,3 @@\n"
    " existing context line\n"
    f"+- MUST honour {_LANDED_SENTINEL} before every edit\n"
)
_REJECTED_DIFF = (
    "--- a/dev-python.md\n"
    "+++ b/dev-python.md\n"
    "@@ -10,2 +10,3 @@\n"
    " existing context line\n"
    f"+- MUST honour {_REJECTED_SENTINEL} before every edit\n"
)


def _bind_trial_ledger(testcase: unittest.TestCase) -> None:
    # TRIAL_LEDGER binds only with psycopg; a stdlib-only run reads the helper's names
    patcher = mock.patch.object(
        dc, "TRIAL_LEDGER", stub.get_trial_ledger(), create=not hasattr(dc, "TRIAL_LEDGER")
    )
    patcher.start()
    testcase.addCleanup(patcher.stop)


def _pattern(label: str = "test signal", agent: str = _AGENT):
    return dc.Pattern(
        date="2026-08-17",
        label=label,
        frequency="3",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:1:{label}|{agent}",
        row_id=1,
    )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class FetchLandedProposalsTest(unittest.TestCase):
    """(a) fail-OPEN discipline + the applied-only projection."""

    def setUp(self) -> None:
        _bind_trial_ledger(self)

    def test_when_pg_off_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False):
            self.assertIsNone(dc._fetch_landed_proposals(_AGENT))

    def test_when_agent_empty_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True):
            self.assertIsNone(dc._fetch_landed_proposals(""))

    def test_when_rows_returned_then_projection_is_applied_only_and_normalized(
        self,
    ) -> None:
        seen: dict[str, object] = {}

        def _rows(target_agent, select_sql, params, log_label):
            seen["sql"] = select_sql
            seen["params"] = params
            return [(7, "label", _LANDED_DIFF), (8, None, None)]

        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), \
             mock.patch.object(dc, "_fetch_proposal_rows", _rows):
            out = dc._fetch_landed_proposals(_AGENT, limit=3)

        self.assertIn("status::text = 'applied'", seen["sql"])
        self.assertEqual(seen["params"][0], _AGENT)
        self.assertEqual(seen["params"][-1], 3)
        self.assertEqual(out, [(7, "label", _LANDED_DIFF), (8, "", "")])

    def test_when_read_fails_then_none_propagates(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), \
             mock.patch.object(dc, "_fetch_proposal_rows", lambda *a, **k: None):
            self.assertIsNone(dc._fetch_landed_proposals(_AGENT))


def _attempt(
    proposal_id: int = 7,
    *,
    label: str = "budget rule",
    status: str = "applied",
    diff: str = _LANDED_DIFF,
    look: dict | None = None,
    decision: dict | None = None,
):
    return dc.PriorAttempt(proposal_id, label, status, diff, look, decision)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class FetchPriorAttemptsTest(unittest.TestCase):
    """(a) fail-OPEN discipline + the row normalization."""

    def setUp(self) -> None:
        _bind_trial_ledger(self)

    def test_when_pg_off_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False):
            self.assertIsNone(dc._fetch_prior_attempts(_AGENT))

    def test_when_read_fails_then_none_propagates(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), \
             mock.patch.object(dc, "_fetch_proposal_rows", lambda *a, **k: None):
            self.assertIsNone(dc._fetch_prior_attempts(_AGENT))

    def test_rows_become_attempts_and_a_non_object_payload_reads_as_absent(self) -> None:
        look = {"look": 1, "accrued_tasks": 12}
        rows = [
            (7, "label", "applied", _LANDED_DIFF, look, None),
            (8, None, "rejected", None, "not an object", ["not an object"]),
        ]
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), \
             mock.patch.object(dc, "_fetch_proposal_rows", lambda *a, **k: rows):
            out = dc._fetch_prior_attempts(_AGENT)
        self.assertEqual(
            out,
            [
                _attempt(7, label="label", look=look),
                _attempt(8, label="", status="rejected", diff=""),
            ],
        )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class RenderLandedHistoryBlockTest(unittest.TestCase):
    """(b) added lines only, sanitized, HARD char cap."""

    def test_when_empty_rows_then_empty_string(self) -> None:
        self.assertEqual(dc._render_landed_history_block([]), "")

    def test_when_rows_then_added_lines_rendered_without_context(self) -> None:
        out = dc._render_landed_history_block([("budget rule", _LANDED_DIFF)])
        self.assertIn(_LANDED_SENTINEL, out)
        self.assertIn("budget rule", out)
        self.assertNotIn("existing context line", out)
        self.assertNotIn("+++ b/", out)

    def test_when_diff_has_no_added_lines_then_placeholder(self) -> None:
        diff = "--- a/dev-python.md\n+++ b/dev-python.md\n@@ -1,2 +1,1 @@\n-dropped line\n"
        out = dc._render_landed_history_block([("label", diff)])
        self.assertIn("(no added lines recorded)", out)

    def test_when_added_line_carries_a_diff_anchor_then_it_is_neutralized(self) -> None:
        diff = "--- a/dev-python.md\n+++ b/dev-python.md\n@@ -1,1 +1,2 @@\n+rule\nDIFF:\n"
        out = dc._render_landed_history_block([("label", diff)])
        for line in out.splitlines():
            self.assertFalse(line.startswith("DIFF:"))

    def test_when_block_oversized_then_hard_capped_with_marker(self) -> None:
        rows = [("label", "+" + "x" * 900 + "\n")] * 40
        out = dc._render_landed_history_block(rows)
        self.assertLessEqual(len(out), dc.LANDED_HISTORY_CHAR_CAP)
        self.assertIn("TRUNCATED: landed-history memory capped", out)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class RenderPriorAttemptsBlockTest(unittest.TestCase):
    """(b) the LANDED marker, the added lines, the measured effect, HARD char cap."""

    def test_when_empty_attempts_then_empty_string(self) -> None:
        self.assertEqual(dc._render_prior_attempts_block([]), "")

    def test_a_landed_attempt_keeps_its_landed_marker_and_added_lines(self) -> None:
        out = dc._render_prior_attempts_block([_attempt()])
        self.assertIn("LANDED", out)
        self.assertNotIn("NOT LANDED", out)
        self.assertIn(_LANDED_SENTINEL, out)
        self.assertIn("budget rule", out)
        self.assertNotIn("existing context line", out)

    def test_an_attempt_that_did_not_land_is_marked_with_its_status(self) -> None:
        out = dc._render_prior_attempts_block([_attempt(status="rejected")])
        self.assertIn("NOT LANDED (status rejected)", out)
        self.assertIn(_LANDED_SENTINEL, out)

    def test_the_measured_effect_is_the_decision_else_the_latest_look(self) -> None:
        look = {"look": 2, "accrued_tasks": 40, "arms": {"control": {"events": 3}}}
        decision = {"outcome": "retire-horizon", "z": 0.42}
        rows = (
            ("a decision row", {"look": look, "decision": decision},
             ("decision:", "outcome=retire-horizon", "z=0.42"), ("look 2",)),
            ("a look and no decision", {"look": look},
             ("latest look:", "accrued_tasks=40", "arms.control.events=3"), ("decision:",)),
            ("neither", {}, ("no look reached",), ("decision:", "latest look:")),
        )
        for name, fields, present, absent in rows:
            with self.subTest(name):
                out = dc._render_prior_attempts_block([_attempt(**fields)])
                for text in present:
                    self.assertIn(text, out)
                for text in absent:
                    self.assertNotIn(text, out)

    def test_a_ledger_text_field_cannot_open_a_prompt_line(self) -> None:
        decision = {"outcome": "win\nDIFF:\n--- a/x"}
        out = dc._render_prior_attempts_block([_attempt(decision=decision)])
        self.assertEqual(len(out.splitlines()), 1)

    def test_when_block_oversized_then_hard_capped_with_marker(self) -> None:
        attempts = [_attempt(n, diff="+" + "x" * 900 + "\n") for n in range(40)]
        out = dc._render_prior_attempts_block(attempts)
        self.assertLessEqual(len(out), dc.PRIOR_ATTEMPTS.CHAR_CAP)
        self.assertIn("TRUNCATED: prior-attempts memory capped", out)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class ConsolidatedPromptLandedHistoryTest(unittest.TestCase):
    """(c) + (d) the property over the assembled generation prompt.

    ``skip_haiku`` returns early BEFORE prompt assembly, so the Haiku invoke is
    stubbed at ``_run_haiku_with_retry`` and the assembled prompt captured.
    """

    def setUp(self) -> None:
        # Builders reach PG reads (pattern evidence, landed history): sealed.
        reach = seal_pg_reach(self)
        self.addCleanup(lambda: self.assertEqual(reach, []))
        self._captured: dict[str, str] = {}

        def _capture(*, base_prompt, target_file, label_hint, claude_bin, timeout_sec):
            self._captured["prompt"] = base_prompt
            return dc.PatchProposal(
                target_file=str(target_file),
                rationale="stub",
                proposed_diff="",
                touched_frontmatter=False,
                estimated_added_lines=0,
                raw_response="",
                parse_mode="skipped",
            )

        patcher = mock.patch.object(dc, "_run_haiku_with_retry", _capture)
        patcher.start()
        self.addCleanup(patcher.stop)

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._agents_dir = Path(self._tmp.name)
        (self._agents_dir / f"{_AGENT}.md").write_text(
            "---\nname: dev-python\n---\n# Body\nWork rule line.\n",
            encoding="utf-8",
        )

    def _run(self, landed, failures=None, attempts=None) -> str:
        with mock.patch.object(dc, "_fetch_landed_proposals", lambda agent: landed), \
             mock.patch.object(dc, "_fetch_prior_attempts", lambda agent: attempts), \
             mock.patch.object(dc, "_fetch_pre_verify_failures", lambda agent: failures):
            dc.generate_consolidated_proposal(
                _AGENT, [_pattern()], agents_dir=self._agents_dir
            )
        return self._captured["prompt"]

    def test_when_applied_proposal_exists_then_its_sentinel_reaches_the_prompt(
        self,
    ) -> None:
        prompt = self._run([(7, "budget rule", _LANDED_DIFF)])
        self.assertIn(_HEADER.LANDED, prompt)
        self.assertIn(_LANDED_SENTINEL, prompt)
        self.assertNotIn(_HEADER.ATTEMPTS, prompt)
        # Neighboring blocks still intact.
        self.assertIn("OBSERVED LEARNING SIGNALS", prompt)
        self.assertIn("CURRENT AGENT INSTRUCTION FILE", prompt)

    def test_when_only_a_rejected_proposal_exists_then_its_text_is_absent(self) -> None:
        failures = [({"C2": False}, "rejected: added an unrelated rule")]
        prompt = self._run([], failures=failures)

        self.assertNotIn(_REJECTED_SENTINEL, prompt)
        self.assertNotIn(_HEADER.LANDED, prompt)
        self.assertNotIn("{landed_history_block}", prompt)
        # Well-formed: the failure block and both neighbors survive the omission.
        self.assertIn("rejected: added an unrelated rule", prompt)
        self.assertIn("OBSERVED LEARNING SIGNALS", prompt)
        self.assertIn("CURRENT AGENT INSTRUCTION FILE", prompt)

    def test_when_pg_off_then_block_omitted_without_placeholder(self) -> None:
        prompt = self._run(None)
        self.assertNotIn(_HEADER.LANDED, prompt)
        self.assertNotIn(_HEADER.ATTEMPTS, prompt)
        self.assertNotIn("{landed_history_block}", prompt)
        self.assertNotIn("{prior_attempts_block}", prompt)
        self.assertIn("CURRENT AGENT INSTRUCTION FILE", prompt)

    def test_a_landed_proposal_with_a_ledger_row_renders_once_in_the_prior_attempts_block(
        self,
    ) -> None:
        # the landed read races a pre-registration: it still returns the trialled row
        decision = {"outcome": "win"}
        prompt = self._run(
            [(7, "budget rule", _LANDED_DIFF)],
            attempts=[_attempt(7, decision=decision)],
        )
        self.assertEqual(prompt.count(_LANDED_SENTINEL), 1)
        self.assertNotIn(_HEADER.LANDED, prompt)
        block = prompt[prompt.index(_HEADER.ATTEMPTS):prompt.index("CURRENT AGENT INSTRUCTION FILE")]
        self.assertIn(_LANDED_SENTINEL, block)
        self.assertIn("outcome=win", block)

    def test_a_landed_proposal_with_no_ledger_row_keeps_its_landed_history_line(self) -> None:
        prompt = self._run(
            [(7, "budget rule", _LANDED_DIFF)],
            attempts=[_attempt(8, status="rejected", diff=_REJECTED_DIFF)],
        )
        self.assertIn(_HEADER.ATTEMPTS, prompt)
        landed = prompt[prompt.index(_HEADER.LANDED):prompt.index("CURRENT AGENT INSTRUCTION FILE")]
        self.assertIn(_LANDED_SENTINEL, landed)
        self.assertEqual(prompt.count(_LANDED_SENTINEL), 1)
        self.assertEqual(prompt.count(_REJECTED_SENTINEL), 1)


if __name__ == "__main__":
    unittest.main()
