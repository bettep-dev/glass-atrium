"""Repo-wide portability guard: no pathlib text helper may take ``newline``.

``Path.read_text`` / ``Path.write_text`` grew the ``newline`` parameter only in
Python 3.13, but the CI matrix runs the autoagent suites on 3.11 and 3.12, so a
call site passing it raises ``TypeError`` on every supported interpreter below
3.13 — a production break invisible on a 3.13+ dev machine. ``Path.open``
carries ``newline`` on every supported version and is byte-identical (both
delegate to ``io.open`` with the same encoding/errors/newline triple), so it is
the portable spelling.

The check is deliberately VERSION-INDEPENDENT: a runtime test would only fail on
the interpreters that lack the parameter, so it could not demonstrate the defect
at all on a newer local interpreter. Scanning the source AST fails identically
everywhere, which makes it a real gate rather than a matrix-luck gate.

Run with either runner:
    uv run --with pytest pytest scripts/test/test_python_portability.py -v
    python3 -m unittest scripts.test.test_python_portability -v

CID: 2026-07-27T2115_round5-cifix_d19f
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

# scripts/test/<this> → scripts/ → repo root. The scan is repo-wide because the
# incompatibility is a language-level one, not a scripts/ concern.
_REPO_ROOT = Path(__file__).resolve().parents[2]

# Vendored / generated trees carry third-party sources this repo does not own.
_SKIP_DIRS = frozenset({".git", "__pycache__", "node_modules", ".venv", "venv"})

_TEXT_HELPERS = frozenset({"read_text", "write_text"})


def _find_python_sources(root: Path) -> list[Path]:
    """Return every owned ``*.py`` under ``root``, vendored trees excluded."""
    return sorted(
        path
        for path in root.rglob("*.py")
        if not _SKIP_DIRS.intersection(path.relative_to(root).parts)
    )


def _find_newline_kwarg_sites(source: str) -> list[tuple[int, str]]:
    """Return ``(lineno, helper)`` for each ``read_text``/``write_text`` call
    passing a ``newline`` keyword.
    """
    hits: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr not in _TEXT_HELPERS:
            continue
        if any(kw.arg == "newline" for kw in node.keywords):
            hits.append((node.lineno, func.attr))
    return hits


class NewlineKwargPortability(unittest.TestCase):
    def test_no_source_passes_newline_to_a_pathlib_text_helper(self) -> None:
        offenders: list[str] = []
        for path in _find_python_sources(_REPO_ROOT):
            # errors="replace": a decode failure must not mask the scan — an
            # unparseable file is reported below, never silently skipped.
            text = path.read_text(encoding="utf-8", errors="replace")
            try:
                hits = _find_newline_kwarg_sites(text)
            except SyntaxError as exc:
                offenders.append(f"{path.relative_to(_REPO_ROOT)}: unparseable ({exc})")
                continue
            offenders.extend(
                f"{path.relative_to(_REPO_ROOT)}:{lineno}: Path.{helper}(newline=...)"
                for lineno, helper in hits
            )

        self.assertEqual(
            offenders,
            [],
            "Path.read_text/write_text accept newline only from Python 3.13, but "
            "CI runs 3.11 and 3.12 — use Path.open(..., newline=...) + .read()/"
            ".write() instead:\n  " + "\n  ".join(offenders),
        )

    def test_scan_reaches_the_repo(self) -> None:
        """A silently empty file list would make the guard above vacuously green."""
        sources = _find_python_sources(_REPO_ROOT)
        self.assertGreater(len(sources), 20)
        self.assertIn(
            Path("scripts/wiki_daemon_cycle.py"),
            [path.relative_to(_REPO_ROOT) for path in sources],
        )


if __name__ == "__main__":
    unittest.main()
