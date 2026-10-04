"""Behavioral tests for the C1 post-apply regression watch (detection-only).

``run_cycle`` now ends with ``alert_post_apply_regression``: for each recently
APPLIED proposal, the target agent's Beta(1,1)-smoothed soft-negative outcome
rate BEFORE the apply is compared to the rate AFTER it; degradation (delta >=
``POST_APPLY_REGRESSION_RATE_DELTA`` with post-window n >=
``POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS``) emits exactly one WARN loop
event (``eval_result='post-apply-regression'``) naming the proposal id + its
agents-bak before-image path, or saying it was pruned — and NOTHING else (no
revert, no status mutation, no safety-queue insert). A proposal whose added
lines are all gone from the target body is skipped. The 'reverted' proposal status is
terminal-non-resurrectable: neither status-classification branch re-arms it
and ``drop_reverted_patterns`` excludes the covering pattern from
re-application. No test writes PG — every PG surface is mocked or sealed.

Run with either runner:
    uv run --with pytest --with psycopg pytest autoagent/test/test_post_apply_regression.py -v
    python3 -m unittest autoagent.test.test_post_apply_regression -v

CID: 2026-07-20T2330_harness-improve_d8f2
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _IMPORT_ERROR = exc

from _pg_seal import seal_pg_reach  # noqa: E402 — test dir anchored above

_APPLIED_TS = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
_PROBE_AGENT = "post-apply-probe-agent"
_PROBE_LABEL = "post-apply probe pattern"
_PROPOSAL_ID = 123
_LATER_AGENT = "post-apply-later-agent"
_LATER_PROPOSAL_ID = 456
_CYCLE_DATE = date(2026, 6, 30)
# Unrecognized by classify_failure_rationale → a genuine QUALITY reject. The
# cycle-level discriminators set a rejected row aside on its rationale class, so
# a blank one here would silently drop the row the case under test needs.
_QUALITY_RATIONALE = "quality reject — pre-verify failed"
_ADDED_RULE = "- Keep each synthesis section under five bullets."
_SECOND_ADDED_RULE = "- Name the source of every figure."
_BODY = SimpleNamespace(RULE="- Cite the file a finding comes from.")
_BODY.WITH_EDIT = f"# Probe agent\n\n{_BODY.RULE}\n{_ADDED_RULE}\n{_SECOND_ADDED_RULE}\n"


def _added_diff(*added: str) -> str:
    """Stored proposed_diff shape: one hunk appending ``added`` after the body rule."""
    hunk = f"@@ -3,1 +3,{1 + len(added)} @@\n {_BODY.RULE}\n"
    return "--- a/probe.md\n+++ b/probe.md\n" + hunk + "".join(f"+{line}\n" for line in added)


def _marker_row() -> tuple[str, str, str]:
    """(haiku_status, rationale, status) a production back-off marker row persists."""
    return (
        dc.TIMEOUT_BACKOFF_HAIKU_STATUS,
        dc.TIMEOUT_BACKOFF_RATIONALE_TEMPLATE.format(n=3, thr=3),
        "unadjudicated",
    )


# Full watch dependency set — every name the alert touches must be bound.
_WATCH_READY = dc is not None and all(
    getattr(dc, flag, False)
    for flag in ("HAS_PG_LOOP_WRITE", "HAS_PG_OUTCOME_READ", "HAS_CONFIDENCE_LIB")
)


def _outcome_row(
    offset_days: float,
    *,
    result: str = "done",
    review_flag: bool = False,
    revision_count: int = 0,
    task_type: str = "bug-fix",
    attribution_source: str | None = None,
    grader_verdict: str | None = None,
    confidence: str | None = None,
    metric_pass: bool | str | None = None,
) -> dict:
    # task_type defaults to a hard-test-bar code type so review_flag stays a
    # REAL negative under the shared predicate's structural carve-out.
    row = {
        "record_ts": _APPLIED_TS + timedelta(days=offset_days),
        "result": result,
        "review_flag": review_flag,
        "revision_count": revision_count,
        "evaluative_signal": 0,
        "task_type": task_type,
    }
    if attribution_source is not None:
        row["attribution_source"] = attribution_source
    if grader_verdict is not None:
        row["grader_verdict"] = grader_verdict
    # Set only when supplied: the structural review_flag carve-out keys on the
    # polar PAIR (high + literal false), so an ABSENT metric_pass must stay absent
    # rather than acquire a default that would silently satisfy the gate.
    if confidence is not None:
        row["confidence"] = confidence
    if metric_pass is not None:
        row["metric_pass"] = metric_pass
    return row


def _windows(pre_negatives: int, pre_n: int, post_negatives: int, post_n: int) -> list[dict]:
    """Combined pre+post rows — the alert partitions them around _APPLIED_TS."""
    rows = [
        _outcome_row(-30 + i, review_flag=i < pre_negatives) for i in range(pre_n)
    ]
    rows += [
        _outcome_row(1 + i, review_flag=i < post_negatives) for i in range(post_n)
    ]
    return rows


@unittest.skipIf(
    dc is None
    or not getattr(dc, "HAS_CONFIDENCE_LIB", False)
    or not getattr(dc, "HAS_PG_OUTCOME_READ", False),
    f"import failed: {_IMPORT_ERROR}"
    if dc is None
    else "psycopg / confidence lib absent: shared predicate or smoothing unbound",
)
class TestSoftNegativeComposite(unittest.TestCase):
    """Soft-negative delegates to the shared is_negative_signal_outcome SoT.

    Pins the terms the watch inherits by delegating (hooks/_pg_learning_dualwrite):
    the classic OR-terms PLUS the grader_verdict=verified_fail term, the
    synthesized-measurement-gap carve-out, and the structural review_flag
    carve-out — synthesis/structural artifacts must never fire the WARN.
    """

    def test_when_review_flag_then_negative(self) -> None:
        self.assertTrue(dc._is_soft_negative_outcome(_outcome_row(0, review_flag=True)))

    def test_when_done_with_concerns_then_negative(self) -> None:
        self.assertTrue(
            dc._is_soft_negative_outcome(_outcome_row(0, result="done_with_concerns"))
        )

    def test_when_blocked_then_negative(self) -> None:
        self.assertTrue(dc._is_soft_negative_outcome(_outcome_row(0, result="blocked")))

    def test_when_revision_count_reaches_failure_threshold_then_negative(self) -> None:
        self.assertTrue(dc._is_soft_negative_outcome(_outcome_row(0, revision_count=2)))

    def test_when_grader_verified_fail_then_negative(self) -> None:
        # grader_verdict OR-term gained by delegating to the shared predicate.
        self.assertTrue(
            dc._is_soft_negative_outcome(_outcome_row(0, grader_verdict="verified_fail"))
        )

    def test_when_clean_done_then_not_negative(self) -> None:
        self.assertFalse(dc._is_soft_negative_outcome(_outcome_row(0)))

    def test_when_needs_context_then_not_negative(self) -> None:
        # needs_context is outside the composite (neutral, not soft-negative).
        self.assertFalse(
            dc._is_soft_negative_outcome(_outcome_row(0, result="needs_context"))
        )

    def test_when_synthesized_done_with_concerns_then_not_negative(self) -> None:
        # Synthesized-measurement-gap carve-out: a completion-synthesized
        # done_with_concerns row is a measurement artifact (agent emitted no
        # [COMPLETION]; the result is the synthesis DEFAULT), so it must not
        # count toward a post-apply regression.
        self.assertFalse(
            dc._is_soft_negative_outcome(
                _outcome_row(
                    0,
                    result="done_with_concerns",
                    attribution_source="completion-synthesized",
                )
            )
        )

    def test_when_review_flag_on_structural_polar_mismatch_then_not_negative(self) -> None:
        # Structural carve-out: review_flag on a no-test-bar task_type carrying the
        # high+false polar pair is the definitionally-expected artifact, not a failure.
        self.assertFalse(
            dc._is_soft_negative_outcome(
                _outcome_row(
                    0,
                    review_flag=True,
                    task_type="doc",
                    confidence="high",
                    metric_pass=False,
                )
            )
        )

    def test_when_review_flag_on_structural_underconfidence_then_negative(self) -> None:
        # The carve-out is BRANCH-scoped, not shape-scoped: track-outcome.sh still
        # flags low+true and ABSENT metric_pass on a structural row, so the regression
        # watch must keep seeing both.
        for over in ({"confidence": "low", "metric_pass": True}, {}):
            with self.subTest(over=over):
                self.assertTrue(
                    dc._is_soft_negative_outcome(
                        _outcome_row(0, review_flag=True, task_type="doc", **over)
                    )
                )

    def test_when_window_empty_then_rate_is_beta_prior_mean(self) -> None:
        self.assertAlmostEqual(dc._smoothed_soft_negative_rate([]), 0.5)

    def test_when_one_negative_of_one_then_rate_is_smoothed(self) -> None:
        rows = [_outcome_row(0, review_flag=True)]
        # Beta(1,1): (1 + 1) / (2 + 1) — never 1.0 on a single observation.
        self.assertAlmostEqual(dc._smoothed_soft_negative_rate(rows), 2 / 3)


@unittest.skipIf(
    dc is None or not getattr(dc, "HAS_CONFIDENCE_LIB", False),
    f"import failed: {_IMPORT_ERROR}" if dc is None else "confidence lib absent",
)
class TestBetaSmoothedRate(unittest.TestCase):
    """confidence.beta_smoothed_rate — public Beta(1,1) smoothing helper.

    Runs without psycopg (confidence lib is stdlib-only), keeping the smoothing
    pinned even when the shared-predicate class above skips.
    """

    def test_when_empty_window_then_prior_mean(self) -> None:
        self.assertAlmostEqual(dc.beta_smoothed_rate(0, 0), 0.5)

    def test_when_one_negative_of_one_then_two_thirds(self) -> None:
        self.assertAlmostEqual(dc.beta_smoothed_rate(1, 1), 2 / 3)


@unittest.skipIf(
    not _WATCH_READY,
    f"import failed: {_IMPORT_ERROR}"
    if dc is None
    else "psycopg / confidence lib absent: watch dependencies unbound",
)
class TestAlertPostApplyRegression(unittest.TestCase):
    """AC1-1..AC1-3: one dedup-keyed WARN loop event, detection-only, n-floor.

    Sealed: every PG seam refuses and records, then the flags the alert gates on
    are re-armed and its two reads are faked; every run asserts nothing reached PG.
    """

    def setUp(self) -> None:
        self.emitted: list[dict] = []
        self.window_rows: list[dict] = []
        self.later_rows: list[tuple] = []
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.target_path = Path(scratch.name) / "probe.md"
        self.target_path.write_text(_BODY.WITH_EDIT, encoding="utf-8")
        self.target_file = str(self.target_path)
        self.diff_text = _added_diff(_ADDED_RULE)
        self.backup_root = Path(scratch.name) / "agents-bak"
        self.before_image = self.backup_root / f"{_CYCLE_DATE}_p{_PROPOSAL_ID}"
        self.before_image.mkdir(parents=True)
        env = mock.patch.dict(
            os.environ,
            {"AUTOAGENT_BACKUP_DIR": str(self.backup_root), "GA_DATA_ROOT": scratch.name},
        )
        env.start()
        self.addCleanup(env.stop)
        self.pg_reach = seal_pg_reach(self)
        for target, repl in (
            ("HAS_PG_LOOP_WRITE", True),
            ("HAS_PG_OUTCOME_READ", True),
            ("_invoke_pg_helper", lambda env: self.emitted.append(env) or True),
            (
                "_fetch_applied_proposals",
                lambda: [
                    (
                        _PROPOSAL_ID,
                        _PROBE_AGENT,
                        _CYCLE_DATE,
                        _APPLIED_TS,
                        self.target_file,
                        self.diff_text,
                    ),
                    *self.later_rows,
                ],
            ),
            ("_pg_read_outcomes_since", lambda since_epoch, **kw: self.window_rows),
        ):
            patcher = mock.patch.object(dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self) -> str:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.alert_post_apply_regression()
        self.assertEqual(self.pg_reach, [])
        return stderr.getvalue()

    def _add_later_watched_row(self) -> None:
        """Queue a later applied row with its edit intact — its event proves the watch went on."""
        later_path = self.target_path.with_name("later.md")
        later_path.write_text(_BODY.WITH_EDIT, encoding="utf-8")
        self.later_rows = [
            (
                _LATER_PROPOSAL_ID,
                _LATER_AGENT,
                _CYCLE_DATE,
                _APPLIED_TS,
                str(later_path),
                _added_diff(_ADDED_RULE),
            )
        ]

    def test_when_post_window_degrades_then_one_event_names_id(self) -> None:
        # pre 1/10 negative (rate .167) → post 3/5 negative (rate .571): fires.
        self.window_rows = _windows(1, 10, 3, 5)
        err = self._run()

        self.assertEqual(len(self.emitted), 1)
        args = self.emitted[0]["args"]
        self.assertEqual(args["eval_result"], "post-apply-regression")
        self.assertEqual(args["agent"], _PROBE_AGENT)
        self.assertEqual(args["event_ts"], _APPLIED_TS.isoformat())
        self.assertIn(f"id={_PROPOSAL_ID}", err)
        self.assertIn("DETECTION-ONLY", err)

    def test_warn_names_the_before_image_only_while_it_exists(self) -> None:
        # Retention prunes before-images long before the watch window ends
        # Pruned before-image → named as pruned, never offered as a restore path
        rows = (
            ("before-image on disk", True),
            ("before-image pruned", False),
        )
        for name, is_kept in rows:
            with self.subTest(name):
                self.emitted.clear()
                if not is_kept:
                    self.before_image.rmdir()
                self.window_rows = _windows(1, 10, 3, 5)
                err = self._run()

                self.assertEqual(len(self.emitted), 1)
                self.assertEqual(str(self.before_image) in err, is_kept)
                self.assertEqual("restore the agent file from the before-image" in err, is_kept)
                self.assertEqual("pruned" in err, not is_kept)

    def test_proposal_whose_added_lines_all_left_the_body_raises_no_warn(self) -> None:
        # WARN subject = the applied edit → no added line left in the body, nothing to point at
        # Any surviving added line keeps the row watched
        # A skipped row never ends the watch → the later applied row still fires
        both = (_PROBE_AGENT, _LATER_AGENT)
        later_only = (_LATER_AGENT,)
        absolute = str(self.target_path)
        rows = (
            (
                "every added line in the body",
                _added_diff(_ADDED_RULE, _SECOND_ADDED_RULE),
                absolute,
                both,
            ),
            (
                "one added line gone, one still in the body",
                _added_diff(_ADDED_RULE, "- Gone."),
                absolute,
                both,
            ),
            (
                "every added line gone from the body",
                _added_diff("- Gone.", "- Also gone."),
                absolute,
                later_only,
            ),
            ("diff adds no content line", _added_diff(""), absolute, both),
            (
                "relative target_file read under the base root, edit intact",
                _added_diff(_ADDED_RULE),
                self.target_path.name,
                both,
            ),
        )
        self._add_later_watched_row()
        for name, diff_text, target_file, warned_agents in rows:
            with self.subTest(name):
                self.emitted.clear()
                self.diff_text = diff_text
                self.target_file = target_file
                self.window_rows = _windows(1, 10, 3, 5)
                err = self._run()

                self.assertEqual(tuple(env["args"]["agent"] for env in self.emitted), warned_agents)
                self.assertEqual(f"id={_PROPOSAL_ID} agent=" in err, _PROBE_AGENT in warned_agents)

    def test_when_target_body_unreadable_then_skipped_with_named_line(self) -> None:
        # One unreadable body skips only its own row, never the whole watch.
        rows = (
            ("target file missing", lambda: self.target_path.unlink()),
            ("target body not UTF-8", lambda: self.target_path.write_bytes(b"- \xff\xfe rule\n")),
        )
        self._add_later_watched_row()
        for name, make_unreadable in rows:
            with self.subTest(name):
                self.emitted.clear()
                make_unreadable()
                self.window_rows = _windows(1, 10, 3, 5)
                err = self._run()

                self.assertEqual([env["args"]["agent"] for env in self.emitted], [_LATER_AGENT])
                self.assertIn(f"id={_LATER_PROPOSAL_ID} agent=", err)
                self.assertNotIn(f"id={_PROPOSAL_ID} agent=", err)
                self.assertIn(str(self.target_path), err)

    def test_when_same_cycle_rerun_then_dedup_key_is_identical(self) -> None:
        # The loop-event UPSERT keys on (event_ts, agent, eval_result); the
        # apply-timestamp event_ts makes a re-run land on the SAME row →
        # 0 duplicate rows persisted (AC1-1 same-cycle re-run clause).
        self.window_rows = _windows(1, 10, 3, 5)
        self._run()
        self._run()

        self.assertEqual(len(self.emitted), 2)
        keys = [
            (env["args"]["event_ts"], env["args"]["agent"], env["args"]["eval_result"])
            for env in self.emitted
        ]
        self.assertEqual(keys[0], keys[1])

    def test_when_regression_detected_then_zero_side_effect_calls(self) -> None:
        # AC1-2: detection-only — the ONLY write op is the loop event.
        self.window_rows = _windows(1, 10, 3, 5)
        self._run()

        # Seal refuses _pg_connect + _pg_reject_learning_pattern → _run asserts neither reached
        self.assertEqual(
            {env.get("op") for env in self.emitted}, {"write_autoagent_loop_event"}
        )

    def test_when_post_window_below_floor_then_silent(self) -> None:
        # AC1-3: 4 post outcomes (all negative) < floor 5 → no event.
        self.window_rows = _windows(0, 10, 4, 4)
        err = self._run()

        self.assertEqual(self.emitted, [])
        self.assertEqual(err, "")

    def test_when_delta_below_threshold_then_silent(self) -> None:
        # pre (1+5)/12 = .5 → post (1+3)/7 ≈ .571: delta ≈ .07 < 0.15.
        self.window_rows = _windows(5, 10, 3, 5)
        err = self._run()

        self.assertEqual(self.emitted, [])
        self.assertEqual(err, "")

    def test_when_no_applied_proposals_then_silent(self) -> None:
        with mock.patch.object(dc, "_fetch_applied_proposals", lambda: []):
            err = self._run()
        self.assertEqual(self.emitted, [])
        self.assertEqual(err, "")

    def test_when_applied_read_fails_then_fail_open_silent(self) -> None:
        # _fetch_applied_proposals → None (PG off / read error) → no alert.
        with mock.patch.object(dc, "_fetch_applied_proposals", lambda: None):
            err = self._run()
        self.assertEqual(self.emitted, [])
        self.assertEqual(err, "")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestRevertedStatusBranches(unittest.TestCase):
    """AC1-4: neither status-classification branch resurrects a reverted row."""

    def _report(self, statuses: list[str]) -> "dc.CycleReport":
        return dc.CycleReport(
            cycle_date="2026-07-01",
            generated_at="2026-07-01T00:00:00.000Z",
            patterns_processed=len(statuses),
            cost_guard={},
            patches=[
                dc.PatchResult(
                    pattern_label=_PROBE_LABEL,
                    pattern_agent=_PROBE_AGENT,
                    pattern_frequency="3",
                    target_file="/tmp/probe-agent.md",
                    classification="reject" if status == "rejected" else "body-auto",
                    # A quality-shaped rationale, so the rejected row is a real
                    # rejection to the discriminator: a blank one classifies as
                    # skipped and would drop out, leaving the reverted-beside-
                    # rejected case passing on the reverted row alone.
                    rationale=_QUALITY_RATIONALE,
                    proposed_diff="",
                    outcomes_sampled=0,
                    haiku_status="ok",
                    status=status,
                )
                for status in statuses
            ],
        )

    def test_when_reverted_beside_rejected_then_all_reject_discriminator_holds(
        self,
    ) -> None:
        # 'reverted' is terminal-negative, NOT live pipeline output — it must
        # not break the all-reject discriminator the way 'applied' does.
        self.assertTrue(dc._all_rejected_this_cycle(self._report(["rejected", "reverted"])))

    def test_when_applied_row_then_all_reject_discriminator_still_breaks(self) -> None:
        self.assertFalse(dc._all_rejected_this_cycle(self._report(["rejected", "applied"])))

    def test_when_reverted_row_then_reject_streak_not_rearmed(self) -> None:
        # Walk (newest → oldest): reverted is looked past — the streak keeps
        # counting instead of breaking (an accepted change would break/re-arm).
        rows = [
            ("reverted", _PROBE_LABEL, ""),
            ("rejected", _PROBE_LABEL, "quality reject — pre-verify failed"),
            ("rejected", _PROBE_LABEL, "quality reject — pre-verify failed"),
        ]
        self.assertEqual(dc.consecutive_reject_count(_PROBE_LABEL, rows), 2)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestBackoffMarkerCycleRegression(unittest.TestCase):
    """A back-off marker is neither output nor a rejection for the regression exit.

    Each fixture row carries the haiku_status, rationale and status a production
    row persists — the marker is set aside by its 'unadjudicated' status, the
    quality row counted by its rationale class.
    """

    def _is_regression(self, rows: list[tuple[str, str, str]]) -> bool:
        report = dc.CycleReport(
            cycle_date="2026-07-01",
            generated_at="2026-07-01T00:00:00.000Z",
            patterns_processed=len(rows),
            cost_guard={},
            patches=[
                dc.PatchResult(
                    pattern_label=_PROBE_LABEL,
                    pattern_agent=_PROBE_AGENT,
                    pattern_frequency="3",
                    target_file="/tmp/probe-agent.md",
                    classification="reject",
                    rationale=rationale,
                    proposed_diff="",
                    outcomes_sampled=0,
                    haiku_status=haiku_status,
                    status=status,
                )
                for haiku_status, rationale, status in rows
            ],
        )
        with mock.patch.object(
            dc, "_prior_all_reject_cycle_count", return_value=10
        ), mock.patch.object(dc, "_days_since_last_applied", return_value=999):
            return dc.is_systemic_regression(report)

    def test_when_cycle_holds_only_markers_then_not_a_regression(self) -> None:
        self.assertFalse(self._is_regression([_marker_row()] * 2))

    def test_when_markers_beside_all_rejected_patches_then_still_a_regression(
        self,
    ) -> None:
        self.assertTrue(
            self._is_regression([_marker_row(), ("ok", _QUALITY_RATIONALE, "rejected")])
        )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestDropRevertedPatterns(unittest.TestCase):
    """AC1-4: a covering reverted proposal excludes the pattern from re-application."""

    def setUp(self) -> None:
        self.emitted: list[dict] = []
        self.transitions: list[tuple[int, str]] = []

        def _record_event(envelope: dict) -> bool:
            self.emitted.append(envelope)
            return True

        def _record_transition(pattern_id: int, reason: str) -> int:
            self.transitions.append((pattern_id, reason))
            return pattern_id

        # create=True: _pg_reject_learning_pattern is a CONDITIONAL import
        # (daemon_cycle try-block alias — absent when psycopg is missing, the
        # CI condition). This class is pure-mock and must keep running PG-less
        # (unlike test_pattern_lifecycle_gates, which co-imports the PG helper
        # and skips wholesale because its live-PG classes need psycopg anyway);
        # the gate reaches the alias only through the mocked
        # _fetch_proposal_history, so patching it into existence is sound.
        for target, repl in (
            ("_invoke_pg_helper", _record_event),
            ("_pg_reject_learning_pattern", _record_transition),
        ):
            patcher = mock.patch.object(dc, target, repl, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _pattern(self, row_id: int = 15) -> "dc.Pattern":
        return dc.Pattern(
            date="2026-07-01",
            label=_PROBE_LABEL,
            frequency="3",
            agent=_PROBE_AGENT,
            status="identified",
            tier="user-pending",
            raw_line=f"pg:learning_log:{row_id}:{_PROBE_LABEL}|{_PROBE_AGENT}",
            row_id=row_id,
        )

    def _drop(self, history, patterns):
        with mock.patch.object(dc, "_fetch_proposal_history", lambda agent: history):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                kept = dc.drop_reverted_patterns(_PROBE_AGENT, patterns)
        return kept, stderr.getvalue()

    def test_when_covering_reverted_row_then_pattern_terminalized(self) -> None:
        history = [("reverted", _PROBE_LABEL, "")]
        kept, stderr_text = self._drop(history, [self._pattern(row_id=15)])

        self.assertEqual(kept, [])
        self.assertEqual(len(self.transitions), 1)
        row_id, reason = self.transitions[0]
        self.assertEqual(row_id, 15)
        self.assertIn("reverted snooze", reason)
        self.assertIn(
            "reverted-snooze",
            [
                env["args"]["eval_result"]
                for env in self.emitted
                if env.get("op") == "write_autoagent_loop_event"
            ],
        )
        self.assertIn("WARN: pattern reverted-snooze", stderr_text)

    def test_when_reverted_row_not_covering_then_pattern_survives(self) -> None:
        pattern = self._pattern()
        kept, _ = self._drop([("reverted", "some unrelated pattern label", "")], [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])
        self.assertEqual(self.emitted, [])

    def test_when_history_has_no_reverted_row_then_pattern_survives(self) -> None:
        pattern = self._pattern()
        history = [
            ("applied", _PROBE_LABEL, "landed"),
            ("rejected", _PROBE_LABEL, "quality reject"),
        ]
        kept, _ = self._drop(history, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])

    def test_when_history_unavailable_then_fail_open(self) -> None:
        pattern = self._pattern()
        kept, _ = self._drop(None, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])

    def test_when_row_id_synthetic_then_no_transition(self) -> None:
        pattern = self._pattern(row_id=0)
        kept, _ = self._drop([("reverted", _PROBE_LABEL, "")], [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])


if __name__ == "__main__":
    unittest.main()
