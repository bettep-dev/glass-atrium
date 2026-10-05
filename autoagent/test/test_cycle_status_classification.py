"""Behavioral tests for the autoagent cycle status classifier (T4).

``_pg_push_autoagent_cycle._aggregate`` derives the ``core.daemon_runs.status``
enum from the cycle report. The protected invariant is 3-branch fidelity plus a
loud-fail fallback:
  (1) every error-bearing patch carries failure_class 'quota-limit' → the cycle
      is an external usage ceiling, NOT a code fault → 'quota_exceeded';
  (2) mixed / other failure classes → 'partial';
  (3) no error-bearing patch → 'ok';
  (4) malformed / absent failure_class on a failing patch → 'partial', never a
      silent 'ok' (pipeline loud-fail hygiene).
Successful patches (empty error) are excluded from the failing-class set, so a
cycle with successes alongside all-quota failures still reads 'quota_exceeded'.
A chronic-timeout back-off row rides branch (3) for the same reason: the
generation unit leaves its error empty because the skip is intentional, not a cycle fault.

The same writer sends each patch's proposal status: a status the patch carries is
forwarded as-is, and only an absent one falls back — `rejected` for a reject
classification (a gate verdict, never `unadjudicated`), `pending` otherwise. The
patch's pattern link and generator-input version reach the envelope as the patch
carries them, and an absent one is sent as None.

The report file the cycle writes for that writer carries no Solution History key,
and a reported patch carries no prior-day outcome sample count.

Run with either runner:
    python3 -m unittest autoagent.test.test_cycle_status_classification -v
    uv run --python 3.13 --with pytest pytest \\
        autoagent/test/test_cycle_status_classification.py -v
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_TEST_DIR = Path(__file__).resolve().parent
for _path in (_REPO_ROOT / "scripts", _REPO_ROOT / "hooks", _REPO_ROOT / "autoagent", _TEST_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import _pg_push_autoagent_cycle as writer  # noqa: E402
from _pg_seal import seal_pg_reach  # noqa: E402

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_PROBE_AGENT = "pattern-link-probe-agent"


def _patch(**overrides: object) -> dict:
    base = {
        "pattern_label": "p",
        "target_file": "f",
        "classification": "reject",
        "error": "",
        "failure_class": "",
    }
    base.update(overrides)
    return base


def _fail(failure_class: str, error: str = "boom") -> dict:
    return _patch(error=error, failure_class=failure_class)


class CycleStatusClassification(unittest.TestCase):
    def test_when_all_failures_quota_limit_then_quota_exceeded(self) -> None:
        payload = {"patches": [_fail("quota-limit"), _fail("quota-limit")]}
        self.assertEqual(writer._aggregate(payload)["status"], "quota_exceeded")

    def test_when_quota_alongside_successful_patch_then_quota_exceeded(self) -> None:
        # A clean apply (empty error) is excluded from the failing-class set.
        payload = {
            "patches": [
                _patch(classification="body-tweak", error=""),
                _fail("quota-limit"),
            ]
        }
        self.assertEqual(writer._aggregate(payload)["status"], "quota_exceeded")

    def test_when_mixed_failure_classes_then_partial(self) -> None:
        payload = {"patches": [_fail("quota-limit"), _fail("quality")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")

    def test_when_non_quota_failure_then_partial(self) -> None:
        payload = {"patches": [_fail("chronic-timeout")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")

    def test_when_chronic_backoff_skip_row_then_ok(self) -> None:
        # Back-off skip shape as the generation unit emits it: empty error (the
        # skip is intentional, not a cycle fault) carried alongside the
        # distinguishing haiku_status/status. Pairs with the fresh-timeout pin above — the
        # first N timeouts stay 'partial', only the backed-off row reads 'ok'.
        payload = {
            "patches": [
                _patch(
                    error="",
                    failure_class="",
                    haiku_status="skipped:chronic-timeout-backoff",
                    status="unadjudicated",
                )
            ]
        }
        self.assertEqual(writer._aggregate(payload)["status"], "ok")

    def test_when_no_error_bearing_patch_then_ok(self) -> None:
        payload = {"patches": [_patch(classification="body-tweak", error="")]}
        self.assertEqual(writer._aggregate(payload)["status"], "ok")

    def test_when_empty_patches_then_ok(self) -> None:
        self.assertEqual(writer._aggregate({"patches": []})["status"], "ok")

    def test_when_failing_patch_failure_class_absent_then_partial(self) -> None:
        # Malformed/absent failure_class on an error-bearing patch must not
        # collapse to quota_exceeded nor to a silent ok.
        payload = {"patches": [_fail("quota-limit"), _patch(error="boom")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")

    def test_when_failing_patch_failure_class_absent_alone_then_partial(self) -> None:
        payload = {"patches": [_patch(error="boom", failure_class="")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")


class ProposalStatusSent(unittest.TestCase):
    def _get_sent_args(self, patch: dict) -> dict:
        sent: list[dict] = []

        def record(envelope: dict) -> bool:
            sent.append(envelope)
            return True

        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "autoagent-2026-10-03.json"
            report.write_text(json.dumps({"patches": [patch]}), encoding="utf-8")
            with (
                mock.patch.object(writer, "OUT_PATH", str(report)),
                mock.patch.object(writer, "CYCLE_DATE", "2026-10-03"),
                mock.patch.object(writer, "_invoke_helper", side_effect=record),
            ):
                self.assertEqual(writer.main(), 0)
        (proposal,) = [e for e in sent if e["op"] == "write_autoagent_proposal"]
        return proposal["args"]

    def test_a_carried_status_is_sent_and_only_an_absent_one_falls_back(self) -> None:
        rows = [
            ("reject without status", _patch(), "rejected"),
            ("reject with empty status", _patch(status=""), "rejected"),
            ("apply without status", _patch(classification="body-tweak"), "pending"),
            ("reject carrying unadjudicated", _patch(status="unadjudicated"), "unadjudicated"),
            ("apply carrying snoozed", _patch(classification="body-tweak", status="snoozed"), "snoozed"),
        ]
        for name, patch, expected in rows:
            with self.subTest(name):
                self.assertEqual(self._get_sent_args(patch)["status"], expected)

    def test_the_pattern_link_and_input_version_are_sent_as_the_patch_carries_them(
        self,
    ) -> None:
        rows = [
            (
                "both carried",
                _patch(learning_pattern_id=4127, generator_input_version="gen-inputs-2"),
                (4127, "gen-inputs-2"),
            ),
            ("both absent", _patch(), (None, None)),
        ]
        for name, patch, expected in rows:
            with self.subTest(name):
                args = self._get_sent_args(patch)
                self.assertEqual(
                    (args["learning_pattern_id"], args["generator_input_version"]),
                    expected,
                )

    @unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
    def test_the_generation_unit_links_its_lead_pattern_through_the_report(self) -> None:
        # Report JSON built by the cycle's own serializer, so a field the dataclass
        # drops never reaches the envelope; a synthetic pattern (row_id 0) links nothing.
        pg_reach = seal_pg_reach(self)
        for name, row_id, expected in (
            ("stored pattern", 4127, 4127),
            ("synthetic pattern", 0, None),
        ):
            with self.subTest(name):
                patch = self._build_report_patch(row_id)
                args = self._get_sent_args(patch)
                self.assertEqual(args["learning_pattern_id"], expected)
                self.assertIsNone(args["generator_input_version"])
        self.assertEqual(pg_reach, [])

    @unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
    def test_a_reported_patch_carries_no_outcome_sample_count(self) -> None:
        pg_reach = seal_pg_reach(self)
        patch = self._build_report_patch(4127)
        self.assertEqual(patch["pattern_agent"], _PROBE_AGENT)
        self.assertNotIn("outcomes_sampled", patch)
        self.assertEqual(pg_reach, [])

    def _build_report_patch(self, lead_row_id: int) -> dict:
        lead, trailing = (
            dc.Pattern(
                date="2026-10-02",
                label=label,
                frequency=frequency,
                agent=_PROBE_AGENT,
                status="identified",
                tier="user-pending",
                raw_line=f"pg:learning_log:{row_id}:{label}|{_PROBE_AGENT}",
                row_id=row_id,
            )
            for label, frequency, row_id in (
                ("lead pattern", "9", lead_row_id),
                ("trailing pattern", "3", 5000),
            )
        )
        with tempfile.TemporaryDirectory() as tmp:
            agents_dir = Path(tmp)
            (agents_dir / f"{_PROBE_AGENT}.md").write_text("# probe\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                result = dc.build_patch_result(
                    _PROBE_AGENT,
                    [lead, trailing],
                    [],
                    cycle_date="2026-10-03",
                    agents_dir=agents_dir,
                    seen_targets=set(),
                    skip_haiku=True,
                    skip_pre_verify=True,
                    skip_loop_emit=True,
                )
        report = dc.CycleReport(
            cycle_date="2026-10-03",
            generated_at="2026-10-03T02:00:00.000Z",
            patterns_processed=2,
            cost_guard={},
            patches=[result],
        )
        (patch,) = dc._report_to_dict(report)["patches"]
        return patch


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class CycleReportJson(unittest.TestCase):
    def test_the_written_report_carries_no_solution_history(self) -> None:
        report = dc.CycleReport(
            cycle_date="2026-10-03",
            generated_at="2026-10-03T02:00:00.000Z",
            patterns_processed=0,
            cost_guard={},
        )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "autoagent-2026-10-03.json"
            dc.emit_report(report, out)
            written = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(written["cycle_date"], "2026-10-03")
        self.assertNotIn("solution_history", written)


if __name__ == "__main__":
    unittest.main()
