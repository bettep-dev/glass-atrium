"""Static guard: no daemon-side file names the operator EDITABLE-reset request surface.

The reset request is operator-only, so the only files allowed to name it are the
merge module, the validating reader, the updater and their tests. The scan reads
every tracked or untracked-but-not-ignored file under the repository root.

Limit: it matches literal names only — a path or call assembled from string pieces
(``"editable" + "-reset"``) escapes it.

Run: python3 -m unittest test_editable_reset_isolation -v   (from autoagent/test)
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]

_ALLOWED = frozenset(
    {
        "autoagent/lib/editable_merge.py",
        "autoagent/lib/editable_reset.py",
        "scripts/update.sh",
        "autoagent/test/test_editable_merge.py",
        "autoagent/test/test_editable_reset_isolation.py",
        "scripts/test/update-editable-reset.bats",
        "scripts/test/update-deletion-shape-tripwire.bats",
    }
)

# "record-editable-reset" is covered by "editable-reset"; listed so the set reads as the surface.
_NEEDLES = (
    "editable-reset",
    "editable_reset",
    "record-editable-reset",
    "get_pending_request",
    "editable-resets",
)


def get_listed_files(root: Path) -> list[str]:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        capture_output=True,
        check=True,
    )
    return sorted({p for p in result.stdout.decode("utf-8").split("\0") if p})


def find_naming_files(root: Path, paths: list[str]) -> set[str]:
    hits: set[str] = set()
    for rel in paths:
        path = root / rel
        if not path.is_file():
            continue  # listed in the index but deleted in the working tree
        text = path.read_bytes().decode("utf-8", errors="replace")
        if any(needle in text for needle in _NEEDLES):
            hits.add(rel)
    return hits


class EditableResetIsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        probe = subprocess.run(
            ["git", "-C", str(_ROOT), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode != 0 or Path(probe.stdout.strip()).resolve() != _ROOT:
            self.skipTest(
                f"{_ROOT} is not a git work-tree root; the scan needs the repository listing"
            )

    def test_should_confine_request_surface_names_to_allowlist_when_scanning_repo(
        self,
    ) -> None:
        hits = find_naming_files(_ROOT, get_listed_files(_ROOT))

        # A listing that missed the updater would make an empty offender set meaningless.
        self.assertIn("scripts/update.sh", hits)
        self.assertEqual(sorted(hits - _ALLOWED), [])


if __name__ == "__main__":
    unittest.main()
