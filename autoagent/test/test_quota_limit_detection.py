"""Behavioral tests for the quota-limit tz-stamped reset-notice pattern (T22).

The protected invariant of ``_HAIKU_QUOTA_PATTERNS``' tz pattern is two-sided:
COVERAGE — the "resets ... (<tz>)" notice must be detected for EVERY IANA
timezone, not one pinned region (an Asia-pinned pattern silently loses quota
detection for any non-Asia ``[meta].timezone`` user); PRECISION — generic
parenthesized slash tokens in arbitrary CLI error text (e.g. ``(src/main)``)
must NOT match, because a quota false-positive once masked a real failure.
The ``_IANA_TZ_REGIONS`` allowlist carries both sides. Covered:
(1) default KST notice detected (defaults preserve behavior);
(2) non-default timezones detected — Europe / America / multi-component /
    Etc offset / legacy US-link forms (the T22 config-override smoke surface);
(3) generic "(word/word)" error text does not false-positive;
(4) local "Exceeded USD budget" still routes to ``_detect_budget_too_low``,
    never to the quota set.

Run with either runner:
    uv run --python 3.13 --with pytest pytest autoagent/test/test_quota_limit_detection.py -v
    python3 -m unittest autoagent.test.test_quota_limit_detection -v

CID: 2026-06-11T1900_oss-remaining_e7a3
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# daemon_cycle resolves daemon_config against $HOME/.claude/hooks at import
# time; the repo hooks/ dir is inserted as fallback so the test also collects
# on an uninstalled clone.
for _dir in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent"):
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

import daemon_cycle as dc  # noqa: E402

# Match ONLY the tz pattern — no other quota keyword (Limit reached / Usage /
# quota / rate limit / extra usage / rate-limit-options) appears in the fixture.
_TZ_ONLY_NOTICE = "Your session resets at 7pm ({tz})."


class QuotaLimitTzCoverage(unittest.TestCase):
    def test_when_default_kst_reset_notice_then_quota_detected(self) -> None:
        stderr = _TZ_ONLY_NOTICE.format(tz="Asia/Seoul")
        self.assertTrue(dc._detect_quota_limit(stderr, ""))

    def test_when_non_default_tz_reset_notice_then_quota_detected(self) -> None:
        non_default_tzs = (
            "Europe/Berlin",
            "America/New_York",
            "America/Argentina/Buenos_Aires",
            "Australia/Lord_Howe",
            "Pacific/Port_Moresby",
            "Etc/GMT+8",
            "US/Pacific",
        )
        for tz in non_default_tzs:
            with self.subTest(tz=tz):
                stderr = _TZ_ONLY_NOTICE.format(tz=tz)
                self.assertTrue(dc._detect_quota_limit(stderr, ""))

    def test_when_notice_arrives_on_stdout_then_quota_detected(self) -> None:
        stdout = _TZ_ONLY_NOTICE.format(tz="Europe/London")
        self.assertTrue(dc._detect_quota_limit("", stdout))


class QuotaLimitTzPrecision(unittest.TestCase):
    def test_when_generic_slash_token_then_no_false_positive(self) -> None:
        non_quota_errors = (
            "git apply failed in (src/main)",
            "model not found (anthropic/claude-haiku-4-5)",
            "permission denied (foo/bar)",
            "ENOENT (lib/utils/helpers)",
        )
        for text in non_quota_errors:
            with self.subTest(text=text):
                self.assertFalse(dc._detect_quota_limit(text, ""))

    def test_when_output_empty_then_no_quota(self) -> None:
        self.assertFalse(dc._detect_quota_limit("", ""))

    def test_when_local_budget_ceiling_then_budget_not_quota(self) -> None:
        stderr = "Error: Exceeded USD budget of 0.50"
        self.assertFalse(dc._detect_quota_limit(stderr, ""))
        self.assertTrue(dc._detect_budget_too_low(stderr, ""))

    def test_when_tz_notice_then_not_budget_too_low(self) -> None:
        stderr = _TZ_ONLY_NOTICE.format(tz="Asia/Seoul")
        self.assertFalse(dc._detect_budget_too_low(stderr, ""))


if __name__ == "__main__":
    unittest.main()
