"""Static guard: no daemon-side file names the operator EDITABLE-reset request surface.

The reset request is operator-only, so the only files allowed to name it are the
merge module, the validating reader, the updater and their tests. The scan reads
every tracked or untracked-but-not-ignored file under the repository root.

``manifest.json`` is exempt only for path strings in ``files``/``hashes``/``modes`` that equal an
allowed path; any mention under ``retired`` or ``version`` fails, because ``retired`` drives the
updater's removal behaviour.

Limit: it matches literal names only — a path or call assembled from string pieces
(``"editable" + "-reset"``), or a name split by JSON escaping inside ``manifest.json``, escapes it.

Run: python3 -m unittest test_editable_reset_isolation -v   (from autoagent/test)
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from collections import Counter
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

# Positional, not whole-file: `retired` keys drive the updater's removals, so only allowed path strings pass.
_MANIFEST = "manifest.json"
_MANIFEST_PATH_SECTIONS = ("files", "hashes", "modes")


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
        if not any(needle in text for needle in _NEEDLES):
            continue
        if rel == _MANIFEST and is_manifest_exempt(text):
            continue
        hits.add(rel)
    return hits


def is_manifest_exempt(text: str) -> bool:
    """True only when every needle occurrence in the raw text sits at an allowed manifest position.

    The raw-count reconciliation fails any mention the walk did not credit, including one hidden
    behind a duplicate key or altered by JSON escaping.
    """
    try:
        manifest = json.loads(text, object_pairs_hook=_get_unique_object)
    except ValueError:  # parse failure or duplicate key
        return False
    counts = get_allowed_mention_counts(manifest)
    if counts is None:
        return False
    return all(text.count(needle) == counts[needle] for needle in _NEEDLES)


def get_allowed_mention_counts(manifest: object) -> Counter[str] | None:
    """Needle counts credited at allowed positions; None when a needle sits at a forbidden one."""
    if not isinstance(manifest, dict):
        return None
    counts: Counter[str] = Counter()
    for section, value in manifest.items():
        if section not in _MANIFEST_PATH_SECTIONS:
            continue  # version, retired, any other key: reconciliation fails every mention there
        if not isinstance(value, (list, dict)):
            continue
        if isinstance(value, dict) and _has_needle(json.dumps(list(value.values()), ensure_ascii=False)):
            return None  # hashes/modes values are hex/octal, never a path
        for path in value:
            if isinstance(path, str) and _has_needle(path):
                if path not in _ALLOWED:
                    return None
                counts.update({needle: path.count(needle) for needle in _NEEDLES})
    return counts


def _has_needle(text: str) -> bool:
    return any(needle in text for needle in _NEEDLES)


def _get_unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError(f"duplicate JSON key among {sorted(keys)}")
    return dict(pairs)


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
        self.assertEqual(sorted(_ALLOWED - hits), [])


_E4_RETIRED_KEY = "../../.claude/data/update/editable-reset/pending.json"


def get_manifest_text(**overrides: object) -> str:
    manifest: dict[str, object] = {
        "version": "1.0.0",
        "files": sorted(_ALLOWED),
        "hashes": dict.fromkeys(sorted(_ALLOWED), "0" * 64),
        "modes": dict.fromkeys(sorted(_ALLOWED), "644"),
        "retired": {},
    }
    return json.dumps({**manifest, **overrides}, indent=2)


def get_scan_hits(manifest_text: str) -> set[str]:
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        subprocess.run(["git", "-C", scratch, "init", "-q"], check=True)
        (root / _MANIFEST).write_text(manifest_text, encoding="utf-8")
        return find_naming_files(root, get_listed_files(root))


class ManifestPositionalExemptionTest(unittest.TestCase):
    def test_should_exempt_manifest_when_mentions_are_allowed_paths_in_path_sections(self) -> None:
        self.assertEqual(get_scan_hits(get_manifest_text()), set())

    def test_should_flag_manifest_when_a_mention_sits_outside_allowed_positions(self) -> None:
        offenders = {
            "E4 retired key": get_manifest_text(retired={_E4_RETIRED_KEY: ["0" * 64]}),
            "retired value": get_manifest_text(retired={"scripts/gone.sh": ["editable_reset"]}),
            "version": get_manifest_text(version="1.0.0-editable-reset"),
            "unallowed files path": get_manifest_text(files=[*sorted(_ALLOWED), "lib/editable-reset.sh"]),
            "hashes value": get_manifest_text(hashes={"scripts/update.sh": "editable-reset"}),
            "duplicate key hides retired": '{"retired": {"'
            + _E4_RETIRED_KEY
            + '": []},'
            + get_manifest_text()[1:],
            "top level not an object": json.dumps(["editable-reset"]),
            "parse failure": get_manifest_text()[:-1],
        }
        for name, text in offenders.items():
            with self.subTest(name):
                self.assertEqual(get_scan_hits(text), {_MANIFEST})

    def test_should_not_exempt_a_nested_manifest_when_it_names_the_surface(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            subprocess.run(["git", "-C", scratch, "init", "-q"], check=True)
            (root / "sub").mkdir()
            (root / "sub" / _MANIFEST).write_text(get_manifest_text(), encoding="utf-8")
            self.assertEqual(find_naming_files(root, get_listed_files(root)), {"sub/manifest.json"})


if __name__ == "__main__":
    unittest.main()
