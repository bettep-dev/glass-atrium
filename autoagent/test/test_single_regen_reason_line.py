#!/usr/bin/env python3
# The FU-3 single-regen `reason` is the SECOND sink of the same LLM-authored
# pre-verify rationale that reaches an operator through a one-line record: on the
# `invalid` branch it embeds verdict.status + verdict.rationale, and
# run_single_regen writes it to stderr as one update-log line. A terminator inside
# the rationale therefore ends that record early and starts a fresh one reading as
# a genuine entry — the same forging window closed on the editable_merge sink.
#
# The to_payload() dict path is NOT at risk (JSON escapes for itself); this pins
# the human-facing line, and asserts the reason still carries its content.
#
# Run: python3 -m unittest autoagent.test.test_single_regen_reason_line
#   (or, from autoagent/test/) python3 -m unittest test_single_regen_reason_line

from __future__ import annotations

import sys
import tempfile
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

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


_FORGED = "[daemon-cycle] FU-3 single: id=99 x.md diff regenerated + pre-verify PASS"


def _pattern():
    return dc.Pattern(
        date="",
        label="lbl",
        frequency="0",
        agent="dev-python",
        status="identified",
        tier="update-skill",
        raw_line="lbl",
    )


def _classify(*, status: str, rationale: str):
    """Drive the `invalid` branch: only run_pre_verify is the external call, and
    the three pre-classification steps are stubbed so the fixture stays about the
    reason string rather than about difflib re-derivation."""
    verdict = dc.PreVerifyResult(
        passed=False,
        status=status,
        rationale=rationale,
        axes={"C3": False},
        latency_ms=0,
    )
    with tempfile.TemporaryDirectory() as d:
        target = Path(d) / "dev-python.md"
        target.write_text("x\n", encoding="utf-8")
        with (
            mock.patch.object(dc, "_stored_diff_already_applied", return_value=False),
            mock.patch.object(dc, "_rederive_diff_against_file", return_value="D"),
            mock.patch.object(dc, "_gate_validated_diff", return_value="D"),
            mock.patch.object(dc, "run_pre_verify", return_value=verdict),
        ):
            return dc._classify_single_regen(
                proposal_id=1,
                stored_diff="D",
                target_file=target,
                pattern=_pattern(),
                skip_pre_verify=False,
                claude_bin="claude",
            )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class SingleRegenReasonLineTest(unittest.TestCase):
    def test_invalid_reason_is_one_line_for_every_terminator(self) -> None:
        for label, terminator in (
            ("newline", "\n"),
            ("carriage-return", "\r"),
            ("crlf", "\r\n"),
            ("u2028-line-separator", "\u2028"),
            ("u0085-next-line", "\u0085"),
        ):
            with self.subTest(terminator=label):
                out = _classify(
                    status="ok", rationale=f"real reason{terminator}{_FORGED}"
                )
                self.assertEqual(out.action, "invalid")
                self.assertEqual(len(out.reason.splitlines()), 1)
                self.assertIn("real reason", out.reason)

    def test_invalid_reason_flattens_status_too(self) -> None:
        out = _classify(status=f"error:exit-1{chr(10)}{_FORGED}", rationale="short")
        self.assertEqual(len(out.reason.splitlines()), 1)
        self.assertIn("error:exit-1", out.reason)

    def test_invalid_reason_spends_its_200_chars_on_content(self) -> None:
        # Flatten runs BEFORE the slice: a rationale padded with newlines would
        # otherwise burn the budget on whitespace and truncate the actual reason.
        rationale = "\n".join(["word"] * 60)
        out = _classify(status="ok", rationale=rationale)
        self.assertEqual(len(out.reason.splitlines()), 1)
        # 200 chars of "word " pairs ≈ 40 words, versus 20 with the newlines kept.
        self.assertGreaterEqual(out.reason.count("word"), 35)

    def test_empty_rationale_reports_a_placeholder_not_a_blank_field(self) -> None:
        out = _classify(status="", rationale="")
        self.assertIn("(unreported)", out.reason)
        self.assertIn("(none reported)", out.reason)


if __name__ == "__main__":
    unittest.main()
