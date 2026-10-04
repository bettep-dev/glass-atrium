"""Registry-membership guard at the outcome dual-write seam (W1-C, AC-3.5 — AC-3.9).

Teammate-class spawns reached the recorder carrying an ephemeral instance name, and the
write seam applied a length clamp and an unknown-fallback only — so an unregistered identity
persisted silently and the aggregator's registry allowlist then dropped its patterns. The guard DETECTS
that at the single write seam: it raises the advisory review flag and stamps its reason token,
and it never drops or rewrites the row. The agent value is part of the ON CONFLICT key, so a
rewrite would additionally convert the upsert into a duplicate row.

Protected invariants (no database needed — the assertions run over the assembled envelope
dict, which is exactly the defect surface):

(1) a non-registry agent value persists UNCHANGED, with review_flag true and the token
    stamped (AC-3.5);
(2) an absent / unreadable / malformed registry skips validation, raising nothing and
    leaving the flag and carrier untouched (AC-3.6, fail-open);
(3) a registry member's envelope is unchanged apart from the additive empty carrier (AC-3.7);
(4) the agent value is never rewritten, on any fixture (AC-3.9).
(5) the spawn-provenance fields reach the row as sent, NULL when absent, independent of the
    agent-emitted correction fields.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_outcome_dualwrite_registry_guard.py -v
    python3 -m unittest hooks.test.test_outcome_dualwrite_registry_guard -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_HOOKS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_HOOKS_ROOT))

# The module hard-exits (module-level sys.exit) when psycopg is absent, so SystemExit
# must be caught alongside ImportError — this suite asserts over the assembled envelope
# dict, no DB, so a driver-less runner skips rather than failing discovery.
try:
    import _pg_outcome_dualwrite as dw  # noqa: E402 — sys.path insert immediately above

    _IMPORT_ERROR: BaseException | None = None
except (SystemExit, Exception) as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dw = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_REGISTERED = "glass-atrium-dev-shell"
_EPHEMERAL = "ashell-impl-opus-980cfc838657ba29"
_PROVENANCE_COLS = ("agent_id", "session_id", "user_correction_detected")


def _outcome(agent, **kw):
    base = {
        "agent": agent,
        "task_type": "bug-fix",
        "result": "done",
        "confidence": "high",
        "metric_pass": "true",
        "summary": "did the work",
        "review_flag": "false",
    }
    base.update(kw)
    return base


@unittest.skipIf(dw is None, f"import failed: {_IMPORT_ERROR}")
class RegistryGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._prev = os.environ.get("CLAUDE_AGENT_REGISTRY_FILE")
        self.registry = os.path.join(self._tmp.name, "agent-registry.json")
        with open(self.registry, "w", encoding="utf-8") as f:
            json.dump({"version": "1", "agents": {_REGISTERED: {"scope": "DEV"}}}, f)
        os.environ["CLAUDE_AGENT_REGISTRY_FILE"] = self.registry

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop("CLAUDE_AGENT_REGISTRY_FILE", None)
        else:
            os.environ["CLAUDE_AGENT_REGISTRY_FILE"] = self._prev
        self._tmp.cleanup()

    # AC-3.5 — detect, never drop
    def test_non_registry_agent_flagged_and_stamped(self) -> None:
        row = dw._build_outcome_row(_outcome(_EPHEMERAL))
        self.assertEqual(row["agent"], _EPHEMERAL)
        self.assertIs(row["review_flag"], True)
        self.assertIn("non-registry-agent-at-write", row["review_flag_reasons"])

    # AC-3.7 — a registered agent is untouched apart from the additive carrier
    def test_registry_member_untouched(self) -> None:
        row = dw._build_outcome_row(_outcome(_REGISTERED))
        self.assertEqual(row["agent"], _REGISTERED)
        self.assertFalse(row["review_flag"])
        self.assertEqual(row["review_flag_reasons"], [])

    # AC-3.5 — an already-flagged row keeps its own tokens, the guard appends
    def test_guard_appends_to_existing_carrier(self) -> None:
        row = dw._build_outcome_row(
            _outcome(_EPHEMERAL, review_flag="true", review_flag_reasons="overconfidence"))
        self.assertEqual(
            row["review_flag_reasons"], ["overconfidence", "non-registry-agent-at-write"])

    # AC-3.6 — fail-open on every unreadable registry shape
    def test_unreadable_registry_skips_validation(self) -> None:
        malformed = os.path.join(self._tmp.name, "malformed.json")
        with open(malformed, "w", encoding="utf-8") as f:
            f.write("{not json")
        rootless = os.path.join(self._tmp.name, "rootless.json")
        with open(rootless, "w", encoding="utf-8") as f:
            json.dump({"version": "1"}, f)
        for path in (os.path.join(self._tmp.name, "absent.json"), malformed, rootless):
            os.environ["CLAUDE_AGENT_REGISTRY_FILE"] = path
            row = dw._build_outcome_row(_outcome(_EPHEMERAL))
            self.assertEqual(row["agent"], _EPHEMERAL, path)
            self.assertFalse(row["review_flag"], path)
            self.assertEqual(row["review_flag_reasons"], [], path)

    # AC-3.9 — the conflict-key value is never rewritten, on any fixture
    def test_agent_never_rewritten(self) -> None:
        for agent in (_REGISTERED, _EPHEMERAL, "orchestrator", "subagent_stop_missing"):
            self.assertEqual(dw._build_outcome_row(_outcome(agent))["agent"], agent)

    # The carrier reaches the write path on every schema variant, and the pre-migration
    # variants stay well-formed — a named column on an unmigrated DB is a total write outage.
    def test_insert_variants_cover_the_carrier(self) -> None:
        # Keys are (qa_score, review_flag_reasons, grader_crosscheck, effort pair, provenance
        # triple) presence.
        for key, sql in dw._INSERT_SQL_BY_SCHEMA.items():
            _qa, reasons, crosscheck, effort, provenance = key
            self.assertEqual(reasons, "review_flag_reasons" in sql)
            self.assertEqual(crosscheck, "grader_crosscheck" in sql)
            self.assertEqual(effort, "has_mixed_effort" in sql)
            for col in _PROVENANCE_COLS:
                self.assertEqual(provenance, col in sql, (key, col))
            # A strip that shears its own separator leaves a dangling comma — malformed SQL
            # on exactly the unmigrated DB the variant exists to serve.
            self.assertNotIn(",\n)", sql)
            self.assertNotIn(",\nRETURNING", sql)
            self.assertNotIn("EXCLUDED.review_flag_reasons = ", sql)


class _CatalogCursor:
    """Answers the column probe from a fixed schema, filtered by the columns it asks for."""

    def __init__(self, schema_cols):
        self._schema_cols = schema_cols
        self._asked = []

    def execute(self, _sql, params):
        self._asked = params["cols"]

    def fetchall(self):
        return [(col,) for col in self._schema_cols if col in self._asked]


@unittest.skipIf(dw is None, f"import failed: {_IMPORT_ERROR}")
class ProvenanceFieldsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        absent = os.path.join(self._tmp.name, "absent.json")
        patcher = mock.patch.dict(os.environ, {"CLAUDE_AGENT_REGISTRY_FILE": absent})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_provenance_fields_sent_by_the_recorder_reach_the_row(self) -> None:
        row = dw._build_outcome_row(_outcome(
            _REGISTERED,
            agent_id="a3f2c1d4e5b6f708",
            session_id="e0e449e3-7b17-4aa8-974d-62fcbbc8b541",
            user_correction_detected=True,
        ))
        self.assertEqual(row["agent_id"], "a3f2c1d4e5b6f708")
        self.assertEqual(row["session_id"], "e0e449e3-7b17-4aa8-974d-62fcbbc8b541")
        self.assertIs(row["user_correction_detected"], True)

    def test_detector_verdict_keeps_its_truth_value_false_included(self) -> None:
        for sent, want in ((True, True), (False, False), ("true", True), ("false", False)):
            with self.subTest(sent=sent):
                row = dw._build_outcome_row(_outcome(_REGISTERED, user_correction_detected=sent))
                self.assertIs(row["user_correction_detected"], want)

    def test_absent_or_unusable_provenance_inputs_give_null(self) -> None:
        rows = (
            ("keys absent", {}),
            ("empty strings", {"agent_id": "", "session_id": "", "user_correction_detected": ""}),
            ("whitespace", {"agent_id": "  ", "session_id": "\t", "user_correction_detected": " "}),
            ("non-string ids, non-boolean verdict",
             {"agent_id": 123, "session_id": ["s"], "user_correction_detected": "maybe"}),
            ("numeric verdict", {"user_correction_detected": 1}),
        )
        for name, fields in rows:
            with self.subTest(name):
                row = dw._build_outcome_row(_outcome(_REGISTERED, **fields))
                for col in _PROVENANCE_COLS:
                    self.assertIsNone(row[col], col)

    def test_emitted_correction_fields_persist_unchanged_beside_an_independent_verdict(
            self) -> None:
        rows = (
            ("emitted correction, detector silent",
             {"revision_count": "2", "evaluative_signal": "-1",
              "directive_hint": "User wanted the API gate moved, not the regex removed",
              "user_correction_detected": False},
             (2, -1, "User wanted the API gate moved, not the regex removed", False)),
            ("nothing emitted, detector fired",
             {"user_correction_detected": True},
             (0, None, None, True)),
        )
        for name, fields, want in rows:
            with self.subTest(name):
                row = dw._build_outcome_row(_outcome(_REGISTERED, **fields))
                got = (row["revision_count"], row["evaluative_signal"],
                       row["directive_hint"], row["user_correction_detected"])
                self.assertEqual(got, want)

    def test_column_probe_writes_the_provenance_columns_only_where_the_schema_has_them(
            self) -> None:
        migrated = set(dw._ADDITIVE_OUTCOME_COLS)
        rows = (
            ("migrated schema", migrated, True),
            ("schema without the provenance columns",
             migrated - set(_PROVENANCE_COLS), False),
        )
        for name, schema_cols, want in rows:
            with self.subTest(name), mock.patch.multiple(
                    dw, _qa_score_col_present=None, _review_flag_reasons_col_present=None,
                    _grader_crosscheck_col_present=None, _effort_cols_present=None,
                    _provenance_cols_present=None):
                sql = dw._outcomes_insert_sql(_CatalogCursor(schema_cols))
                for col in _PROVENANCE_COLS:
                    self.assertEqual(col in sql, want, col)
                self.assertIn("has_mixed_effort", sql)


if __name__ == "__main__":
    unittest.main()
