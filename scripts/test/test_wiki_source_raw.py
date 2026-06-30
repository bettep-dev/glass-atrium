"""Permanent regression test for the collision-immune ``source_raw`` identity.

``source_raw`` is the only raw-note back-reference that survives a slug-rename:
a raw basename is unique (1 URL = 1 file, immutable), so a note keyed by it
cannot be confused with another raw the way a shared ``source_url`` can. Two
detectors must agree on every raw — the Python ``_extract_source_raw`` /
``detect_unprocessed_raw`` in ``wiki_daemon_cycle.py`` and the bash
``_extract_source_raw`` (awk) in ``wiki-daily-compile.sh``. A drift between them
re-detects an already-compiled raw as backlog forever, so the protected
invariants are: (1) the ASCII-only trim discipline that preserves nbsp and CR
edge cases, (2) the collision-immune primary match in the detector, and (3)
byte-for-byte cross-language parity of the two extractors.

The bash extractor's awk program is read verbatim from ``wiki-daily-compile.sh``
and run via subprocess on the SAME fixture file — sourcing the script is unsafe
(it acquires a lock and runs the whole pipeline on load), so the awk literal is
the parity surface. This guards against future divergence in either language.

Mirrors the deleted scripts/test conventions (unittest, ``sys.path`` insertion).
Run with either runner:
    uv run --with pytest pytest scripts/test/test_wiki_source_raw.py -v
    python3 -m unittest scripts.test.test_wiki_source_raw -v

CID: 2026-06-07T1550_srcraw-pytest_b9k5
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# scripts/test/<this> → scripts/ holds wiki_daemon_cycle.py. The module guards
# its entry point under ``if __name__ == "__main__"``, so import runs no cycle.
_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import wiki_daemon_cycle as wdc  # noqa: E402

_COMPILE_SH = _SCRIPTS_ROOT / "wiki-daily-compile.sh"

# nbsp (U+00A0) is the discriminator between ASCII ``[ \t]`` trim and ``.strip()``:
# the ASCII-only trim leaves a surrounding nbsp in place, so a fixture carrying it
# proves neither detector silently widened to Unicode whitespace.
_NBSP = " "


def _write_fixture(content: bytes) -> Path:
    """Persist raw bytes to a temp ``.md`` so a lone ``\\r`` reaches both
    extractors as a value byte (no universal-newline rewrite).
    """
    handle = tempfile.NamedTemporaryFile(suffix=".md", delete=False)
    try:
        handle.write(content)
    finally:
        handle.close()
    return Path(handle.name)


def _extract_bash_awk_program(func_name: str) -> str:
    """Read the awk program literal from a bash extractor in wiki-daily-compile.sh.

    The script runs its full pipeline on source (lock acquire, ``set -euo
    pipefail``), so the awk literal is lifted out and run standalone — the parity
    surface is the awk program byte-identical to what production executes.
    """
    src = _COMPILE_SH.read_text(encoding="utf-8")
    body_match = re.search(
        rf"{re.escape(func_name)}\(\)\s*\{{(.*?)\n\}}", src, re.DOTALL
    )
    if body_match is None:
        raise AssertionError(f"{func_name} not found in {_COMPILE_SH}")
    awk_match = re.search(r"awk '(.*?)' \"\$file\"", body_match.group(1), re.DOTALL)
    if awk_match is None:
        raise AssertionError(f"awk program not found inside {func_name}")
    return awk_match.group(1)


def _run_bash_extract(awk_program: str, fixture: Path) -> str:
    """Run the lifted bash awk on a fixture, normalizing the single trailing
    newline awk's ``print`` appends so the value compares to the Python return.
    """
    result = subprocess.run(
        ["awk", awk_program, str(fixture)],
        capture_output=True,
        text=True,
        check=False,
    )
    out = result.stdout
    return out[:-1] if out.endswith("\n") else out


class TestExtractSourceRaw(unittest.TestCase):
    """``_extract_source_raw`` honors the same frontmatter rigor as source_url."""

    def setUp(self) -> None:
        self._fixtures: list[Path] = []

    def tearDown(self) -> None:
        for path in self._fixtures:
            path.unlink(missing_ok=True)

    def _extract(self, content: bytes) -> str:
        fixture = _write_fixture(content)
        self._fixtures.append(fixture)
        return wdc._extract_source_raw(fixture)

    def test_crlf_frontmatter_opens_and_value_is_cr_stripped(self) -> None:
        # A fully-CRLF file must still open the block (the per-line \r\n→\n
        # normalize) and return a CR-free value.
        value = self._extract(
            b"title: x\r\n---\r\nsource_raw: my-slug-2026.md\r\n---\r\nbody\r\n"
        )
        self.assertEqual(value, "my-slug-2026.md")

    def test_lone_cr_mid_value_is_removed_not_a_line_break(self) -> None:
        # A bare \r inside the value is a value byte (awk splits on \n only); the
        # shared \r-strip discipline removes it rather than truncating the line.
        value = self._extract(b"---\nsource_raw: a\rb.md\n---\n")
        self.assertEqual(value, "ab.md")

    def test_trailing_tab_is_trimmed(self) -> None:
        value = self._extract(b"---\nsource_raw: slug.md\t\n---\n")
        self.assertEqual(value, "slug.md")

    def test_nbsp_is_preserved_ascii_trim_not_strip(self) -> None:
        # ASCII [ \t] trim must leave a surrounding nbsp — .strip() would eat it
        # and diverge from the bash awk under a UTF-8 locale.
        value = self._extract(f"---\nsource_raw:{_NBSP}slug.md{_NBSP}\n---\n".encode())
        self.assertEqual(value, f"{_NBSP}slug.md{_NBSP}")

    def test_body_source_raw_after_close_is_ignored(self) -> None:
        # A source_raw: line past the closing --- is outside the block (HR-rule
        # contamination guard) and must never match.
        value = self._extract(b"---\ntitle: t\n---\nsource_raw: ignored.md\n")
        self.assertEqual(value, "")

    def test_missing_key_returns_empty(self) -> None:
        value = self._extract(b"---\nsource_url: http://x\n---\n")
        self.assertEqual(value, "")

    def test_empty_value_returns_empty(self) -> None:
        value = self._extract(b"---\nsource_raw:\n---\n")
        self.assertEqual(value, "")

    def test_first_of_multiple_wins(self) -> None:
        # Only the first source_raw: inside the block is honored (awk exits on it).
        value = self._extract(
            b"---\nsource_raw: first.md\nsource_raw: second.md\n---\n"
        )
        self.assertEqual(value, "first.md")

    def test_no_opening_delimiter_returns_empty(self) -> None:
        # Without an opening ---, no block opens, so even a source_raw: line is
        # never read.
        value = self._extract(b"source_raw: orphan.md\nbody\n")
        self.assertEqual(value, "")


class TestDetectUnprocessedSourceRaw(unittest.TestCase):
    """``detect_unprocessed_raw`` keys the primary match on source_raw and stays
    collision-immune where the source_url fast-path is not.
    """

    def setUp(self) -> None:
        self._root = Path(tempfile.mkdtemp(prefix="srcraw-detect-"))
        (self._root / "raw").mkdir()
        (self._root / "notes").mkdir()

    def tearDown(self) -> None:
        for sub in ("raw", "notes"):
            for entry in (self._root / sub).iterdir():
                entry.unlink()
            (self._root / sub).rmdir()
        self._root.rmdir()

    def _write_raw(self, slug: str, *, source_url: str = "") -> None:
        url_line = f"source_url: {source_url}\n" if source_url else ""
        (self._root / "raw" / f"{slug}.md").write_text(
            f"---\n{url_line}---\nbody for {slug}\n", encoding="utf-8"
        )

    def _write_note(
        self, name: str, *, source_raw: str = "", source_url: str = ""
    ) -> None:
        lines = ""
        if source_raw:
            lines += f"source_raw: {source_raw}\n"
        if source_url:
            lines += f"source_url: {source_url}\n"
        (self._root / "notes" / name).write_text(
            f"---\n{lines}---\nnote {name}\n", encoding="utf-8"
        )

    def _unprocessed_slugs(self) -> set[str]:
        return {r.slug for r in wdc.detect_unprocessed_raw(self._root, limit=0)}

    def test_raw_processed_when_full_basename_is_a_note_source_raw(self) -> None:
        # The note back-references the raw by its FULL basename (<slug>.md), the
        # primary identity — the raw is processed even though its basename and the
        # note basename differ.
        self._write_raw("upstage-pricing-2026")
        self._write_note(
            "upstage-solar-overview.md", source_raw="upstage-pricing-2026.md"
        )
        self.assertNotIn("upstage-pricing-2026", self._unprocessed_slugs())

    def test_source_raw_match_holds_when_source_url_collides(self) -> None:
        # Two raws share a source_url; only alpha has a compiled note that
        # back-references it by source_raw. alpha is processed (source_raw), beta
        # stays unprocessed — the collision cannot mask beta.
        shared = "https://example.com/shared"
        self._write_raw("alpha-2026", source_url=shared)
        self._write_raw("beta-2026", source_url=shared)
        self._write_note(
            "alpha-renamed.md", source_raw="alpha-2026.md", source_url=shared
        )
        unprocessed = self._unprocessed_slugs()
        self.assertNotIn("alpha-2026", unprocessed)
        self.assertIn("beta-2026", unprocessed)

    def test_colliding_raw_without_matching_source_raw_stays_unprocessed(
        self,
    ) -> None:
        # A shared source_url alone cannot mark a raw processed (the note may
        # belong to a sibling raw), so a colliding raw with no source_raw note of
        # its own remains backlog.
        shared = "https://example.com/dup"
        self._write_raw("one-2026", source_url=shared)
        self._write_raw("two-2026", source_url=shared)
        self._write_note("one-renamed.md", source_raw="one-2026.md", source_url=shared)
        self.assertIn("two-2026", self._unprocessed_slugs())

    def test_basename_fallback_still_marks_processed(self) -> None:
        # The additive change must not regress the basename identity: a note whose
        # basename equals the raw slug marks it processed even without source_raw.
        self._write_raw("legacy-basename-2026")
        self._write_note("legacy-basename-2026.md")
        self.assertNotIn("legacy-basename-2026", self._unprocessed_slugs())

    def test_non_colliding_source_url_fallback_still_marks_processed(self) -> None:
        # A unique (non-colliding) source_url present in a note still marks a
        # legacy raw lacking source_raw as processed.
        unique = "https://example.com/unique-legacy"
        self._write_raw("legacy-url-2026", source_url=unique)
        self._write_note("legacy-url-renamed.md", source_url=unique)
        self.assertNotIn("legacy-url-2026", self._unprocessed_slugs())

    def test_unmatched_raw_is_unprocessed(self) -> None:
        # No identity matches → the raw is backlog.
        self._write_raw("fresh-2026", source_url="https://example.com/fresh")
        self.assertIn("fresh-2026", self._unprocessed_slugs())


class TestBashPythonByteParity(unittest.TestCase):
    """The bash and Python ``_extract_source_raw`` return byte-identical values.

    This is the load-bearing guard: the two detectors key membership on the
    extracted string, so any cross-language drift silently breaks the processed
    check. Each fixture is run through both extractors on the same file.
    """

    # Adversarial battery — each entry stresses one edge of the shared trim /
    # block-scan discipline (CRLF, lone \r, trailing tab, nbsp, body line,
    # missing, empty, first-of-many).
    _FIXTURES: dict[str, bytes] = {
        "crlf": b"title: x\r\n---\r\nsource_raw: my-slug-2026.md\r\n---\r\nbody\r\n",
        "lone_cr": b"---\nsource_raw: a\rb.md\n---\n",
        "trailing_tab": b"---\nsource_raw: slug.md\t\n---\n",
        "nbsp": f"---\nsource_raw:{_NBSP}slug.md{_NBSP}\n---\n".encode(),
        "body_line": b"---\ntitle: t\n---\nsource_raw: ignored.md\n",
        "missing": b"---\nsource_url: http://x\n---\n",
        "empty": b"---\nsource_raw:\n---\n",
        "multi_first_wins": b"---\nsource_raw: first.md\nsource_raw: second.md\n---\n",
    }

    @classmethod
    def setUpClass(cls) -> None:
        cls._awk_program = _extract_bash_awk_program("_extract_source_raw")

    def setUp(self) -> None:
        self._fixtures: list[Path] = []

    def tearDown(self) -> None:
        for path in self._fixtures:
            path.unlink(missing_ok=True)

    def test_every_fixture_matches_byte_for_byte(self) -> None:
        for name, content in self._FIXTURES.items():
            with self.subTest(fixture=name):
                fixture = _write_fixture(content)
                self._fixtures.append(fixture)
                python_value = wdc._extract_source_raw(fixture)
                bash_value = _run_bash_extract(self._awk_program, fixture)
                self.assertEqual(
                    python_value,
                    bash_value,
                    f"cross-language drift on {name!r}: "
                    f"python={python_value!r} bash={bash_value!r}",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
