"""Seam test for the home-anchored runtime-path module (hooks/ga_paths.py).

ga_paths is the single python definition of the Atrium runtime-state roots
(data / logs), the twin of the shell seam ``${GA_DATA_ROOT:-$HOME/.glass-atrium}``.
The plan's T2a AC: with NO override the data root resolves to
``$HOME/.glass-atrium/data`` (HEAD resolved to ``$HOME/.claude/data``). Protected
invariants:

(1) default resolution (no GA_DATA_ROOT) anchors every root on ``$HOME/.glass-atrium``
    — the ``.glass-atrium`` relocation, NOT the legacy ``.claude``;
(2) HOME drives the anchor via ``os.environ['HOME']`` so a HOME-mangling test
    harness (bats sandbox) redirects the root without a dedicated override;
(3) GA_DATA_ROOT overrides the base for all three roots (shell-seam parity);
(4) resolution is per-call — an env change applied AFTER import still redirects
    (no import-time caching).

No database needed; every case manipulates os.environ in isolation.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_ga_paths.py -v
    python3 -m unittest hooks.test.test_ga_paths -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

_HOOKS_ROOT = Path(__file__).resolve().parent.parent

# ga_paths lives in the hooks dir under a plain (non-dashed) importable name —
# direct import once the hooks dir is on sys.path, matching daemon_config's insert.
if str(_HOOKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HOOKS_ROOT))

import ga_paths  # noqa: E402 — sys.path insert immediately above


class DefaultResolutionTest(unittest.TestCase):
    """No GA_DATA_ROOT override — the anchored default the daemons/hooks hit."""

    def test_base_root_defaults_to_glass_atrium_under_home(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": "/tmp/ga-home"}, clear=False):
            import os as _os

            # A stale GA_DATA_ROOT from the real env would mask the default.
            _os.environ.pop("GA_DATA_ROOT", None)
            self.assertEqual(
                ga_paths.get_base_root(), Path("/tmp/ga-home/.glass-atrium")
            )

    def test_data_root_defaults_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": "/tmp/ga-home"}, clear=False):
            import os as _os

            _os.environ.pop("GA_DATA_ROOT", None)
            self.assertEqual(
                ga_paths.get_data_root(),
                Path("/tmp/ga-home/.glass-atrium/data"),
            )

    def test_log_root_defaults_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": "/tmp/ga-home"}, clear=False):
            import os as _os

            _os.environ.pop("GA_DATA_ROOT", None)
            self.assertEqual(
                ga_paths.get_log_root(),
                Path("/tmp/ga-home/.glass-atrium/logs"),
            )

    def test_default_is_not_the_legacy_claude_path(self) -> None:
        # The relocation guard — the whole point of the seam is to leave .claude.
        with mock.patch.dict("os.environ", {"HOME": "/tmp/ga-home"}, clear=False):
            import os as _os

            _os.environ.pop("GA_DATA_ROOT", None)
            self.assertNotIn(".claude", str(ga_paths.get_data_root()))


class OverrideResolutionTest(unittest.TestCase):
    """GA_DATA_ROOT redirects the base — shell-seam parity + test isolation."""

    def test_ga_data_root_overrides_every_root(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"GA_DATA_ROOT": "/var/atrium-alt", "HOME": "/tmp/ga-home"},
            clear=False,
        ):
            self.assertEqual(ga_paths.get_base_root(), Path("/var/atrium-alt"))
            self.assertEqual(ga_paths.get_data_root(), Path("/var/atrium-alt/data"))
            self.assertEqual(ga_paths.get_log_root(), Path("/var/atrium-alt/logs"))


class PerCallResolutionTest(unittest.TestCase):
    """Env read happens per call, not once at import — a late override redirects."""

    def test_override_applied_after_import_redirects(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": "/tmp/ga-home"}, clear=False):
            import os as _os

            _os.environ.pop("GA_DATA_ROOT", None)
            self.assertEqual(
                ga_paths.get_base_root(), Path("/tmp/ga-home/.glass-atrium")
            )
        with mock.patch.dict(
            "os.environ", {"GA_DATA_ROOT": "/late/override"}, clear=False
        ):
            self.assertEqual(ga_paths.get_base_root(), Path("/late/override"))


if __name__ == "__main__":
    unittest.main()
