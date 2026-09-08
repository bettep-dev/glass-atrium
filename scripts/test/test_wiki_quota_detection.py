"""Behavioral + mirror-parity tests for wiki quota-limit detection (T22).

``wiki_daemon_cycle`` declares itself a mirror of ``autoagent/daemon_cycle.py``
— one data-driven parity check walks every mirrored detection constant so the
two sets cannot drift apart silently. The behavioral cases protect the
same two-sided tz invariant as the autoagent suite: the reset notice is detected for ANY
IANA timezone (non-default ``[meta].timezone`` honored), while generic
"(word/word)" CLI error text never false-positives into
``haiku_status='skipped:quota-limit'``.

Run with either runner:
    uv run --python 3.13 --with pytest pytest scripts/test/test_wiki_quota_detection.py -v
    python3 -m unittest scripts.test.test_wiki_quota_detection -v

CID: 2026-06-11T1900_oss-remaining_e7a3
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _SCRIPTS_ROOT.parent
# Both daemon modules resolve daemon_config against $HOME/.claude/hooks at
# import time; the repo hooks/ dir is inserted as fallback so the test also
# collects on an uninstalled clone. autoagent/ is needed for the parity import.
for _dir in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent", _SCRIPTS_ROOT):
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

import daemon_cycle as dc  # noqa: E402
import wiki_daemon_cycle as wdc  # noqa: E402

# Match ONLY the tz pattern — no other quota keyword in the fixture.
_TZ_ONLY_NOTICE = "Your session resets at 7pm ({tz})."


# Every DETECTION constant wiki_daemon_cycle mirrors from autoagent/daemon_cycle.py
# (the SoT), with the reader that makes it comparable — compiled patterns carry no
# useful equality, so they are read as (source, flags). Both readers preserve
# declaration order: an alternation reordered is a different match precedence.
# Scoped to detection: DEFAULT_REPORTS_DIR is mirrored too but is path config,
# outside this module's subject.
_MIRRORED_CONSTANTS = (
    (
        "_HAIKU_QUOTA_PATTERNS",
        lambda m: [(p.pattern, p.flags) for p in m._HAIKU_QUOTA_PATTERNS],
    ),
    ("_IANA_TZ_REGIONS", lambda m: m._IANA_TZ_REGIONS),
)


class WikiQuotaPatternMirrorParity(unittest.TestCase):
    def test_every_mirrored_constant_matches_autoagent(self) -> None:
        for name, read in _MIRRORED_CONSTANTS:
            with self.subTest(constant=name):
                source = read(dc)
                # Two empty copies compare equal, so equality alone pins nothing.
                self.assertTrue(source, f"{name} is empty in autoagent (SoT)")
                self.assertEqual(read(wdc), source)


class WikiQuotaLimitTzBehavior(unittest.TestCase):
    def test_when_default_kst_reset_notice_then_quota_detected(self) -> None:
        stderr = _TZ_ONLY_NOTICE.format(tz="Asia/Seoul")
        self.assertTrue(wdc._detect_quota_limit(stderr, ""))

    def test_when_non_default_tz_reset_notice_then_quota_detected(self) -> None:
        non_default_tzs = (
            "Europe/Berlin",
            "America/New_York",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+8",
            "US/Pacific",
        )
        for tz in non_default_tzs:
            with self.subTest(tz=tz):
                stderr = _TZ_ONLY_NOTICE.format(tz=tz)
                self.assertTrue(wdc._detect_quota_limit(stderr, ""))

    def test_when_generic_slash_token_then_no_false_positive(self) -> None:
        non_quota_errors = (
            "git apply failed in (src/main)",
            "model not found (anthropic/claude-haiku-4-5)",
            "permission denied (foo/bar)",
        )
        for text in non_quota_errors:
            with self.subTest(text=text):
                self.assertFalse(wdc._detect_quota_limit(text, ""))

    def test_when_local_budget_ceiling_then_budget_not_quota(self) -> None:
        stderr = "Error: Exceeded USD budget of 0.50"
        self.assertFalse(wdc._detect_quota_limit(stderr, ""))
        self.assertTrue(wdc._detect_budget_too_low(stderr, ""))


if __name__ == "__main__":
    unittest.main()
