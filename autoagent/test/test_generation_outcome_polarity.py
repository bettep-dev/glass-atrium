"""Behavioral tests for the generation-outcome read path's polarity fields.

Covered here:
  (a) PG path maps revision_count + evaluative_signal from a stub row;
  (b) filesystem path with BOTH signals ABSENT → neutral defaults, never coerced
      into success polarity.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_generation_outcome_polarity.py -v
    python3 -m unittest autoagent.test.test_generation_outcome_polarity -v
"""

from __future__ import annotations

import contextlib
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

# The helper MUST enter sys.modules before daemon_cycle imports it (same
# contract as test_pg_pattern_intake.py) — daemon_cycle prepends
# ~/.claude/hooks (live install) to sys.path, which would otherwise shadow the
# repo copy for every later test module in a combined run. psycopg absent →
# suppress; daemon_cycle still imports with its fallback predicates.
with contextlib.suppress(Exception):
    import _pg_learning_dualwrite  # noqa: F401 — sys.modules pre-bind only

# Same pre-bind contract, unsuppressed: the shared signal SoT is stdlib-only, so a
# failure here is a real breakage rather than a psycopg-absent degradation.
import _outcome_signal  # noqa: F401 — sys.modules pre-bind only

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestEvaluativeSignalCoercion(unittest.TestCase):
    """_coerce_evaluative_signal normalizes to the -1/0/+1 ternary, neutral-default."""

    def test_when_none_then_neutral_zero(self) -> None:
        self.assertEqual(dc._coerce_evaluative_signal(None), 0)

    def test_when_unparseable_then_neutral_zero(self) -> None:
        self.assertEqual(dc._coerce_evaluative_signal("not-an-int"), 0)

    def test_when_out_of_range_then_neutral_zero(self) -> None:
        # A missing/garbled signal is NEVER coerced into success polarity (+1).
        self.assertEqual(dc._coerce_evaluative_signal(7), 0)

    def test_when_valid_ternary_then_preserved(self) -> None:
        for raw, expected in (("-1", -1), ("0", 0), ("1", 1), (-1, -1), (1, 1)):
            with self.subTest(raw=raw):
                self.assertEqual(dc._coerce_evaluative_signal(raw), expected)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestPgPathFieldMapping(unittest.TestCase):
    """(a) PG path maps revision_count + evaluative_signal from a stub row."""

    def _stub_pg_outcomes(self, dc_mod, rows):
        """Drive _fetch_generation_outcomes_from_pg with stub PG rows.

        Patches HAS_PG_OUTCOME_READ on + the read helper to return the stub rows,
        bypassing any real DB. When psycopg is absent the helper symbol is never
        bound at module scope (it lives inside the guarded import), so use a
        sentinel + delattr to restore that unbound state on teardown.
        """
        _UNSET = object()

        def fake_read(*_args, **_kwargs):
            return rows

        orig_flag = dc_mod.HAS_PG_OUTCOME_READ
        orig_read = getattr(dc_mod, "_pg_read_outcomes_since", _UNSET)
        dc_mod.HAS_PG_OUTCOME_READ = True
        dc_mod._pg_read_outcomes_since = fake_read  # type: ignore[attr-defined]
        try:
            return dc_mod._fetch_generation_outcomes_from_pg(
                "dev-python", yesterday_start=0.0, today_start=1e18
            )
        finally:
            dc_mod.HAS_PG_OUTCOME_READ = orig_flag
            if orig_read is _UNSET:
                delattr(dc_mod, "_pg_read_outcomes_since")
            else:
                dc_mod._pg_read_outcomes_since = orig_read  # type: ignore[attr-defined]

    def test_when_row_has_both_signals_then_mapped(self) -> None:
        row = {
            "record_ts": None,  # None → today-exclusion skipped, row kept
            "agent": "dev-python",
            "task_type": "bug-fix",
            "result": "done",
            "confidence": "high",
            "metric_pass": True,
            "summary": "fixed",
            "lesson": "learned",
            "revision_count": 2,
            "evaluative_signal": -1,
        }
        outcomes = self._stub_pg_outcomes(dc, [row])
        self.assertEqual(len(outcomes), 1)
        o = outcomes[0]
        self.assertEqual(o.revision_count, 2)
        self.assertEqual(o.evaluative_signal, -1)

    def test_when_row_signals_none_then_neutral_zero(self) -> None:
        # None revision_count → int(x or 0) = 0; None signal → neutral 0.
        row = {
            "record_ts": None,
            "agent": "dev-python",
            "task_type": "feature",
            "result": "done",
            "confidence": "high",
            "metric_pass": True,
            "summary": "",
            "lesson": "",
            "revision_count": None,
            "evaluative_signal": None,
        }
        outcomes = self._stub_pg_outcomes(dc, [row])
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0].revision_count, 0)
        self.assertEqual(outcomes[0].evaluative_signal, 0)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestFilesystemPathMissingSignal(unittest.TestCase):
    """(b) filesystem path, signals ABSENT → neutral defaults, NOT success."""

    def _parse(self, frontmatter: str) -> object:
        md = f"---\n{frontmatter}\n---\n\n## summary\nlegacy record\n"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "2026-06-14-0900_dev-python_feature.md"
            p.write_text(md, encoding="utf-8")
            return dc._parse_outcome_file(p)

    def test_when_signals_absent_then_neutral_defaults(self) -> None:
        o = self._parse(
            "agent: dev-python\n"
            "task_type: feature\n"
            "result: needs_context\n"
            "confidence: medium\n"
            "metric_pass: false"
        )
        self.assertEqual(o.revision_count, 0)
        self.assertEqual(o.evaluative_signal, 0)

    def test_when_signals_present_then_parsed(self) -> None:
        o = self._parse(
            "agent: dev-python\n"
            "task_type: feature\n"
            "result: done\n"
            "confidence: high\n"
            "metric_pass: true\n"
            "revision_count: 3\n"
            "evaluative_signal: -1"
        )
        self.assertEqual(o.revision_count, 3)
        self.assertEqual(o.evaluative_signal, -1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
