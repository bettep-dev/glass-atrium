#!/usr/bin/env python3
"""Behavioral tests for T1 lesson-store integrity — D1 staleness sweep, D2/D3 registry
allowlist at ingest, D4 corroboration-tier CTM admission, plus the doc-lockstep grep.

Every code AC drives the REAL production entry (ingest_outcome_lessons) — never a direct
helper call — so the tests prove the WIRING fires, not just that the helpers work.
Deterministic: dates are seeded relative to now (no sleeping), thresholds injected via the
stale_days parameter, registry via the registry_path parameter.

    python3 -m unittest hooks.test.test_lesson_store_integrity -v
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))


def _load_aggregator():
    """Import learning-aggregator.py despite the dashed filename (main() is __main__-guarded
    and the PG import is try/except-wrapped, so loading runs no PG code)."""
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator_integrity", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


agg = _load_aggregator()

_AGENT = "glass-atrium-dev-shell"  # present in every fixture registry below


def _iso(days_ago: int) -> str:
    return (datetime.now() - timedelta(days=days_ago)).strftime("%Y-%m-%d")


def _row(text, agent=_AGENT, task_type="feature", score=5, updated=None):
    row = {
        "agent": agent, "task_type": task_type, "text": text,
        "score": score, "frequency": 1, "tombstoned": False,
    }
    if updated is not None:
        row["updated"] = updated
    return row


def _record(lesson, agent=_AGENT, confidence="high", **extra):
    rec = {
        "agent": agent, "task_type": "feature", "result": "done",
        "metric_pass": True, "confidence": confidence, "lesson": lesson,
    }
    rec.update(extra)
    return rec


def _injectable(store: dict, agent: str = _AGENT) -> list[str]:
    """Mirror of the AD-3 injector CTM selection (inject-scope-rules.sh build_lesson_block):
    agent match + not tombstoned + score >= LESSON_MIN_SCORE (4)."""
    return [
        e["text"] for e in store.get("ctm", [])
        if e.get("agent") == agent
        and not e.get("tombstoned")
        and int(e.get("score", 0) or 0) >= 4
    ]


class IngestFixture(unittest.TestCase):
    """Temp store + temp registry; every ingest goes through the production entry."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store_path = os.path.join(self._tmp.name, "lessons.json")
        self.registry_path = os.path.join(self._tmp.name, "agent-registry.json")
        Path(self.registry_path).write_text(
            json.dumps({"agents": {_AGENT: {}, "glass-atrium-dev-python": {}}}),
            encoding="utf-8",
        )

    def _seed(self, ctm=(), epm=()):
        Path(self.store_path).write_text(
            json.dumps({"ctm": list(ctm), "epm": list(epm)}), encoding="utf-8"
        )

    def _ingest(self, records, **kw):
        kw.setdefault("registry_path", self.registry_path)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            ops = agg.ingest_outcome_lessons(records, path=self.store_path, **kw)
        return ops, stderr.getvalue()

    def _store(self):
        return json.loads(Path(self.store_path).read_text(encoding="utf-8"))


class StalenessSweep(IngestFixture):
    """D1 / FB-1a — the ingest entry fires the sweep; a direct tombstone_lesson call is
    deliberately never made here (the AC binds the wiring, not the helper)."""

    def test_when_ingest_runs_then_aged_row_tombstoned_and_fresh_row_live(self):
        self._seed(ctm=[_row("aged advice", updated=_iso(31)),
                        _row("fresh advice", updated=_iso(0))])
        ops, _ = self._ingest([])
        by_text = {e["text"]: e for e in self._store()["ctm"]}
        self.assertTrue(by_text["aged advice"]["tombstoned"])
        self.assertFalse(by_text["fresh advice"]["tombstoned"])
        self.assertEqual(ops.get("TOMBSTONE"), 1)

    def test_when_updated_missing_or_empty_then_treated_stale(self):
        self._seed(epm=[_row("no anchor"), _row("empty anchor", updated="")])
        self._ingest([])
        self.assertTrue(all(e["tombstoned"] for e in self._store()["epm"]))

    def test_when_updated_unparseable_then_treated_stale(self):
        self._seed(ctm=[_row("bad anchor", updated="not-a-date")])
        self._ingest([])
        self.assertTrue(self._store()["ctm"][0]["tombstoned"])

    def test_when_threshold_injected_then_boundary_respected(self):
        self._seed(ctm=[_row("aged advice", updated=_iso(31))])
        self._ingest([], stale_days=60)  # 31d row survives a 60d window
        self.assertFalse(self._store()["ctm"][0]["tombstoned"])

    def test_when_lesson_ingested_same_pass_then_never_swept(self):
        # fresh ingests stamp updated=today → the same-pass sweep must not touch them
        self._ingest([_record("brand new insight")])
        self.assertFalse(self._store()["ctm"][0]["tombstoned"])


class RegistryAllowlist(IngestFixture):
    """D2/D3 / FB-1b — lesson keys ⊆ injectable registry keys; fail-open on no registry."""

    def test_when_agent_unregistered_then_rejected_with_one_skip_line(self):
        ops, err = self._ingest(
            [_record("orphan lesson", agent="glass-atrium-ephemeral-spawn-slug")]
        )
        store = self._store()
        self.assertEqual(store["ctm"], [])
        self.assertEqual(store["epm"], [])
        self.assertEqual(err.count("lesson skip (unregistered agent"), 1)
        self.assertEqual(ops.get("SKIP_UNREGISTERED"), 1)

    def test_when_agent_registered_then_ingested_normally(self):
        ops, err = self._ingest([_record("quote every expansion")])
        self.assertEqual(ops.get("ADD"), 1)
        self.assertNotIn("lesson skip", err)

    def test_when_bare_stem_then_canonical_key_matches_registry(self):
        # reconcile with _canonical_agent — bare 'dev-shell' canonicalizes to the registry key
        ops, err = self._ingest([_record("bare stem ok", agent="dev-shell")])
        self.assertEqual(ops.get("ADD"), 1)
        self.assertNotIn("lesson skip", err)

    def test_when_registry_missing_then_fail_open_with_one_warning(self):
        ops, err = self._ingest(
            [_record("still ingested", agent="glass-atrium-not-in-any-registry")],
            registry_path=os.path.join(self._tmp.name, "absent.json"),
        )
        self.assertEqual(ops.get("ADD"), 1)  # validation skipped, ingest not blocked
        self.assertEqual(err.count("agent registry unavailable"), 1)

    def test_when_registry_malformed_then_fail_open_with_one_warning(self):
        bad = os.path.join(self._tmp.name, "bad.json")
        Path(bad).write_text("{not json", encoding="utf-8")
        ops, err = self._ingest([_record("still ingested")], registry_path=bad)
        self.assertEqual(ops.get("ADD"), 1)
        self.assertEqual(err.count("agent registry unavailable"), 1)


class CorroborationTier(IngestFixture):
    """FB-1d — NON-code task_types only (code arms follow T19, tested in test_ctm_admission_polarity):
    high immediate; medium provisional until frequency >= 2; low never; verified_fail never admits."""

    def test_when_medium_first_observed_then_provisional_not_injectable(self):
        self._ingest([_record("medium insight", confidence="medium", task_type="review")])
        store = self._store()
        self.assertEqual(len(store["ctm"]), 1)
        self.assertEqual(store["ctm"][0]["score"], 3)  # stored sub-floor
        self.assertEqual(_injectable(store), [])

    def test_when_medium_reobserved_then_promoted_to_injectable(self):
        self._ingest([_record("medium insight", confidence="medium", task_type="review")])
        self.assertEqual(_injectable(self._store()), [])  # frequency 1 → excluded
        ops, _ = self._ingest([_record("medium insight", confidence="medium", task_type="review")])
        store = self._store()
        self.assertEqual(store["ctm"][0]["frequency"], 2)
        self.assertGreaterEqual(store["ctm"][0]["score"], 4)
        self.assertEqual(_injectable(store), ["medium insight"])
        # Promotion is the score-bump side-effect of the surviving inline ingest corroboration
        # (returns UPDATE); the score >= 4 + injectable assertions above prove it fired.
        self.assertEqual(ops.get("UPDATE"), 1)

    def test_when_high_then_immediate_injectable_admission_unchanged(self):
        self._ingest([_record("high insight", confidence="high", task_type="review")])
        self.assertEqual(_injectable(self._store()), ["high insight"])

    def test_when_low_then_never_admitted(self):
        self._ingest([_record("low insight", confidence="low", task_type="review")])
        self.assertEqual(self._store()["ctm"], [])

    def test_when_grader_verified_fail_then_ctm_never_admitted(self):
        # non-code + verified_fail (review_flag unset) — the FB-1d branch verified_fail gate rejects
        ops, _ = self._ingest(
            [_record("bogus win", grader_verdict="verified_fail", task_type="review")]
        )
        store = self._store()
        self.assertEqual(store["ctm"], [])
        self.assertEqual(store["epm"], [])  # excluded entirely, not rerouted
        self.assertFalse(any(op in ops for op in ("ADD", "UPDATE", "MERGE")))


class DocLockstep(unittest.TestCase):
    """AC8 — the repo doc states the tiered admission rule at all four contract positions
    and carries zero stale 'score >= 4 → CTM' phrasings."""

    _DOC = _REPO_ROOT / "rules" / "glass-atrium" / "core-learning-log.md"
    _ANCHORS = (
        "Successful patches",
        "**CTM** (Correct-Template Memory)",
        "machine-readable lesson store",
        "AD-3 — spawn-time lesson injection",
    )
    _STALE = ("(score ≥ 4) → CTM", "achieved score ≥ 4", "score ≥ 4 success)")

    def test_when_t1_merged_then_tiered_rule_replaces_score4_contract(self):
        text = self._DOC.read_text(encoding="utf-8")
        for stale in self._STALE:
            self.assertNotIn(stale, text, f"stale phrasing remains: {stale}")
        lines = text.splitlines()
        for anchor in self._ANCHORS:
            matches = [ln for ln in lines if anchor in ln]
            self.assertTrue(matches, f"anchor line missing: {anchor}")
            self.assertTrue(
                any("provisional" in ln and "frequency ≥ 2" in ln for ln in matches),
                f"tiered rule absent at anchor: {anchor}",
            )


if __name__ == "__main__":
    unittest.main()
