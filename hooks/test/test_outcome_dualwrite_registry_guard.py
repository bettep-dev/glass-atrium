"""Registry-membership guard at the outcome dual-write seam (W1-C, AC-3.5 — AC-3.9).

Teammate-class spawns reached the recorder carrying an ephemeral instance name, and the
write seam applied a length clamp and an unknown-fallback only — so an unregistered identity
persisted silently and the ingest allowlist then dropped the row's lesson. The guard DETECTS
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
        self.assertIn("review_flag_reasons", dw._INSERT_SQL_BY_SCHEMA[(True, True)])
        for key in ((True, False), (False, False)):
            sql = dw._INSERT_SQL_BY_SCHEMA[key]
            self.assertNotIn("review_flag_reasons", sql)
            self.assertNotIn(",\n)", sql)
            self.assertNotIn(",\nRETURNING", sql)


if __name__ == "__main__":
    unittest.main()
