"""Behavioral tests for the three-anchor EDITABLE-region merge module (T17/T18/T21).

Covered behaviors (T21 — consolidated, full base-content path):
  * vendor-untouched region -> keep-local, BYTE-IDENTICAL, NO LLM call;
  * both-changed region WITH base content -> net-new diff3 candidate, Haiku-gated
    (clean merge + overlapping conflict, candidate-level apply/verify both ways);
  * only-local / only-vendor change -> deterministic take-release/keep-local, NO LLM;
  * no-op (nothing changed anywhere) -> deterministic, NO LLM, apply no-op code;
  * base-content-unavailable -> gated 2-way present-both REPORT when sides differ
    (never landed) / deterministic keep-local when sides match (no faked 3-way);
  * conflict-marker tripwire -> a marker-bearing candidate is refused at apply
    (zero bytes) and at verify (on-disk backstop), with prose about git conflicts
    excluded as a false positive;
  * same-release re-run -> no-op against an ADVANCED base, refused against a STALE
    one (the idempotency defect: markers landing in a live agent body);
  * sensitive refusal by PATH -> GLOBAL_RULES / security rule / com.glass-atrium plist
    AND by DIFF body -> an added irreversible command (rm -rf / DROP TABLE),
    each with hard-fail apply (never written) + hard-fail verify + NO LLM call;
  * verify() re-scan defends against post-write on-disk sensitive tampering;
  * structural region-count mismatch -> ceremony route, hard-fail apply/verify;
  * thin CLI `plan` -> verdict line + base-content-store integration + refusal exit;
  * three_way_merge pure-function gap behavior (one-sided / identical collapse).

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_editable_merge.py -v
    python3 -m unittest autoagent.test.test_editable_merge -v
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_LIB_DIR = _AUTOAGENT_DIR / "lib"

for _p in (_AUTOAGENT_DIR, _LIB_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

try:
    import editable_merge as em

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure -> skip, not error
    em = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


def _doc(*, top: str, region: str, bottom: str) -> str:
    """Build an agent .md body with a single EDITABLE region."""
    return (
        f"{top}\n<!-- EDITABLE:BEGIN -->\n{region}\n<!-- EDITABLE:END -->\n{bottom}\n"
    )


class _StubVerify:
    """Injectable stand-in for daemon_cycle.run_pre_verify — records calls."""

    def __init__(self, passed: bool) -> None:
        self.passed = passed
        self.calls = 0

    def __call__(self, patch, pattern, *, skip_pre_verify=False):  # noqa: ANN001
        self.calls += 1

        class _R:
            passed = self.passed

        return _R()


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ThreeAnchorResolverTest(unittest.TestCase):
    """T17 — three-anchor classification + candidate assembly."""

    def test_release_untouched_region_keeps_local_byte_identical(self) -> None:
        base = _doc(top="# Agent v1", region="local custom A", bottom="footer v1")
        # Local changed the region; release did NOT touch the region (== base region)
        # but DID update the surrounding structure.
        local = _doc(
            top="# Agent v1", region="local custom A EDITED", bottom="footer v1"
        )
        release = _doc(
            top="# Agent v2 NEW HEADER", region="local custom A", bottom="footer v2"
        )

        res = em.resolve_file("dev-python.md", local, release, base)

        self.assertEqual(res.regions[0].verdict, em.KEEP_LOCAL)
        self.assertFalse(res.needs_llm)
        # Learned region content preserved byte-identical to local's region.
        self.assertEqual(res.regions[0].content, ["local custom A EDITED\n"])
        # Outside-EDITABLE structure came from the release.
        self.assertIn("# Agent v2 NEW HEADER", res.candidate_text)
        self.assertIn("footer v2", res.candidate_text)
        self.assertIn("local custom A EDITED", res.candidate_text)

    def test_only_vendor_changed_takes_release_no_llm(self) -> None:
        base = _doc(top="# A", region="shared line", bottom="z")
        local = _doc(
            top="# A", region="shared line", bottom="z"
        )  # local == base region
        release = _doc(top="# A", region="vendor improved line", bottom="z")

        res = em.resolve_file("dev-node.md", local, release, base)

        self.assertEqual(res.regions[0].verdict, em.TAKE_RELEASE)
        self.assertFalse(res.needs_llm)
        self.assertIn("vendor improved line", res.candidate_text)

    def test_both_changed_non_overlapping_merges_clean(self) -> None:
        base = _doc(top="# A", region="line1\nline2\nline3", bottom="z")
        local = _doc(top="# A", region="LOCAL-TOP\nline1\nline2\nline3", bottom="z")
        release = _doc(
            top="# A", region="line1\nline2\nline3\nVENDOR-BOTTOM", bottom="z"
        )

        res = em.resolve_file("dev-react.md", local, release, base)

        self.assertEqual(res.regions[0].verdict, em.MERGE_CLEAN)
        self.assertTrue(res.needs_llm)
        self.assertIn("LOCAL-TOP", res.candidate_text)
        self.assertIn("VENDOR-BOTTOM", res.candidate_text)
        self.assertFalse(res.regions[0].had_conflict)

    def test_both_changed_overlapping_conflicts(self) -> None:
        base = _doc(top="# A", region="same-old-line", bottom="z")
        local = _doc(top="# A", region="LOCAL rewrite", bottom="z")
        release = _doc(top="# A", region="VENDOR rewrite", bottom="z")

        res = em.resolve_file(
            "dev-android.md", local, release, base, resolve_conflicting_gaps=False
        )

        self.assertEqual(res.regions[0].verdict, em.MERGE_CONFLICT)
        self.assertTrue(res.regions[0].had_conflict)
        self.assertIn("LOCAL rewrite", res.candidate_text)
        self.assertIn("VENDOR rewrite", res.candidate_text)

    def test_structural_region_count_mismatch_routes_to_ceremony(self) -> None:
        base = _doc(top="# A", region="r", bottom="z")
        local = _doc(top="# A", region="r", bottom="z")
        # Release has TWO editable regions; local has one.
        release = (
            "# A\n"
            "<!-- EDITABLE:BEGIN -->\nr1\n<!-- EDITABLE:END -->\n"
            "mid\n"
            "<!-- EDITABLE:BEGIN -->\nr2\n<!-- EDITABLE:END -->\n"
            "z\n"
        )
        res = em.resolve_file("dev-go.md", local, release, base)
        self.assertEqual(res.verdict, em.STRUCTURAL)
        self.assertTrue(res.needs_ceremony)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class LiveOnlyFrontmatterPinTest(unittest.TestCase):
    """U-A — a live-only operator ``model:`` pin survives the vendor merge.

    Everything outside the EDITABLE regions is rebuilt from the RELEASE skeleton,
    and the release ships NO ``model:`` key, so an operator pin was stripped on
    every merge. Precedence is LIVE-WINS (orchestrator-role.md Cost-Tier
    Selection: a live pin is local-only config, never ported to git).
    """

    _FM = "name: dev-x\ntools: Read, Write\n"

    def _body(self, frontmatter: str, region: str, bottom: str) -> str:
        return _doc(
            top=f"---\n{frontmatter}---\n\n# X\n", region=region, bottom=bottom
        )

    def test_live_only_pin_survives_release_without_one(self) -> None:
        release = self._body(self._FM, "base goal", "vendor rules v2")
        local = self._body(f"{self._FM}model: claude-opus-4-8\n", "learned", "old")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertEqual(res.verdict, em.KEEP_LOCAL)
        self.assertIn("model: claude-opus-4-8\n", res.candidate_text)
        # the vendor structure + the learned region both still land.
        self.assertIn("vendor rules v2", res.candidate_text)
        self.assertIn("learned", res.candidate_text)

    def test_live_pin_wins_over_a_release_carried_one(self) -> None:
        # Currently VACUOUS in practice — the release ships zero ^model: keys — but
        # pinned so the doctrine holds the day a vendor pin returns. Base-aware
        # refinement (live == base -> take-release) is deliberately NOT implemented:
        # an operator override outranks a vendor value unconditionally.
        release = self._body(f"{self._FM}model: vendor-y\n", "base goal", "v2")
        local = self._body(f"{self._FM}model: claude-opus-4-8\n", "learned", "old")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertIn("model: claude-opus-4-8\n", res.candidate_text)
        self.assertNotIn("model: vendor-y", res.candidate_text)

    def test_release_pin_lands_when_live_has_none(self) -> None:
        release = self._body(f"{self._FM}model: vendor-y\n", "base goal", "v2")
        local = self._body(self._FM, "learned", "old")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertIn("model: vendor-y\n", res.candidate_text)

    def test_pin_only_delta_collapses_to_a_zero_write_no_op(self) -> None:
        # The pin is the ONLY difference -> candidate == local -> no-op, so a
        # pure pin-preservation run writes nothing at all.
        release = self._body(self._FM, "same", "same")
        local = self._body(f"{self._FM}model: claude-opus-4-8\n", "same", "same")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertEqual(res.verdict, em.NO_OP)
        self.assertFalse(res.is_changed)

    def test_merge_is_idempotent_across_reruns(self) -> None:
        release = self._body(self._FM, "g", "v2")
        local = self._body(f"{self._FM}model: claude-opus-4-8\n", "g", "v1")

        first = em.resolve_file("dev-x.md", local, release, release).candidate_text
        second = em.resolve_file("dev-x.md", first, release, release).candidate_text

        self.assertEqual(first, second)
        self.assertIn("model: claude-opus-4-8\n", second)

    def test_no_frontmatter_on_either_side_is_left_unchanged(self) -> None:
        # fail-open: never fabricate a frontmatter block.
        local = _doc(top="# plain", region="x", bottom="v1")
        release = _doc(top="# plain", region="x", bottom="v2")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertEqual(res.candidate_text, release)

    def test_mid_body_horizontal_rule_is_not_read_as_a_fence(self) -> None:
        # A body '---' must never be mistaken for a frontmatter fence.
        body = _doc(top="# plain\n\n---\n", region="x", bottom="v1")

        res = em.resolve_file("dev-x.md", body, body, body)

        self.assertEqual(res.candidate_text, body)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class BaseUnavailableFallbackTest(unittest.TestCase):
    """T17 — gated 2-way present-both when base CONTENT is unavailable."""

    def test_base_none_identical_sides_keeps_local(self) -> None:
        local = _doc(top="# A", region="same", bottom="z")
        release = _doc(top="# A NEW", region="same", bottom="z")
        res = em.resolve_file("dev-db.md", local, release, base_text=None)
        self.assertFalse(res.base_available)
        self.assertEqual(res.regions[0].verdict, em.KEEP_LOCAL)
        self.assertFalse(res.needs_llm)

    def test_base_none_differing_sides_gated_present_both(self) -> None:
        local = _doc(top="# A", region="local learned", bottom="z")
        release = _doc(top="# A", region="vendor variant", bottom="z")
        res = em.resolve_file("dev-rag.md", local, release, base_text=None)
        self.assertEqual(res.regions[0].verdict, em.GATED_2WAY)
        self.assertTrue(res.needs_llm)
        # Present-both: NOT a faked 3-way — BOTH sides surfaced, no base anchor.
        self.assertIn("local learned", res.candidate_text)
        self.assertIn("vendor variant", res.candidate_text)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class MergeCandidateGateTest(unittest.TestCase):
    """T18 — candidate apply/verify callbacks + Haiku gate + sensitive refusal."""

    def test_both_changed_invokes_haiku_verify_and_passes(self) -> None:
        base = _doc(top="# A", region="b1\nb2", bottom="z")
        local = _doc(top="# A", region="LOCAL\nb1\nb2", bottom="z")
        release = _doc(top="# A", region="b1\nb2\nVENDOR", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-python.md",
            local,
            release,
            base_text=base,
            agent="dev-python",
            verify_fn=stub,
        )
        self.assertTrue(cand.resolution.needs_llm)
        self.assertFalse(cand.refused)
        # verify reads the on-disk patched file -> write candidate to a temp first.
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 1)  # exactly one Haiku call

    def test_haiku_reject_fails_verify(self) -> None:
        base = _doc(top="# A", region="b1\nb2", bottom="z")
        local = _doc(top="# A", region="LOCAL\nb1\nb2", bottom="z")
        release = _doc(top="# A", region="b1\nb2\nVENDOR", bottom="z")
        stub = _StubVerify(passed=False)
        cand = em.build_merge_candidate(
            "dev-python.md",
            local,
            release,
            base_text=base,
            agent="dev-python",
            verify_fn=stub,
        )
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            cand.apply(str(p))
            self.assertEqual(cand.verify(str(p)), 1)

    def test_keep_local_makes_no_llm_call(self) -> None:
        base = _doc(top="# A", region="keep", bottom="z")
        local = _doc(top="# A", region="keep EDITED", bottom="z")
        release = _doc(
            top="# A NEW", region="keep", bottom="z"
        )  # release region == base
        stub = _StubVerify(passed=True)
        cand = em.build_merge_candidate(
            "dev-python.md",
            local,
            release,
            base_text=base,
            verify_fn=stub,
        )
        self.assertFalse(cand.resolution.needs_llm)
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            cand.apply(str(p))
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 0)  # deterministic path -> NO Haiku call

    def test_sensitive_path_global_rules_refused(self) -> None:
        base = _doc(top="# R", region="rule a", bottom="z")
        local = _doc(top="# R", region="rule a local", bottom="z")
        release = _doc(top="# R", region="rule a vendor", bottom="z")
        stub = _StubVerify(passed=True)
        cand = em.build_merge_candidate(
            "GLASS_ATRIUM_GLOBAL_RULES.md",
            local,
            release,
            base_text=base,
            verify_fn=stub,
        )
        self.assertTrue(cand.refused)
        self.assertIsNotNone(cand.sensitive_hit)
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "GLASS_ATRIUM_GLOBAL_RULES.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)  # never written
            self.assertFalse(p.exists())
            self.assertEqual(cand.verify(str(p)), 1)
        self.assertEqual(stub.calls, 0)

    def test_sensitive_path_glass_atrium_plist_refused(self) -> None:
        base = _doc(top="# P", region="cfg", bottom="z")
        local = _doc(top="# P", region="cfg local", bottom="z")
        release = _doc(top="# P", region="cfg vendor", bottom="z")
        cand = em.build_merge_candidate(
            "com.glass-atrium.autoagent-cycle.plist",
            local,
            release,
            base_text=base,
            verify_fn=_StubVerify(passed=True),
        )
        self.assertTrue(cand.refused)

    def test_no_op_when_candidate_equals_local(self) -> None:
        base = _doc(top="# A", region="x", bottom="z")
        local = _doc(top="# A", region="x", bottom="z")
        release = _doc(top="# A", region="x", bottom="z")  # nothing changed anywhere
        cand = em.build_merge_candidate(
            "dev-python.md",
            local,
            release,
            base_text=base,
            verify_fn=_StubVerify(passed=True),
        )
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_NOOP)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class BaseStoreTest(unittest.TestCase):
    """load_base_text — base-content store (the chosen provenance, not the hash manifest)."""

    def test_load_base_text_present_and_absent(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            store = em.base_store_dir(d)
            store.mkdir(parents=True)
            (store / "dev-python.md").write_text("BASE BODY", encoding="utf-8")
            self.assertEqual(em.load_base_text("dev-python.md", d), "BASE BODY")
            self.assertIsNone(em.load_base_text("dev-missing.md", d))


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class CheapPathNoLLMTest(unittest.TestCase):
    """T21 — the deterministic ("cheap") paths make NO LLM call at the CANDIDATE level.

    The pre-existing suite asserted no-LLM only for keep-local; the take-release,
    no-op, and gated-identical-sides cheap paths were unguarded. needs_llm=False is
    necessary but NOT sufficient — assert the verify_fn stub is never invoked.
    """

    def test_take_release_candidate_makes_no_llm_call(self) -> None:
        base = _doc(top="# A", region="shared", bottom="z")
        local = _doc(top="# A", region="shared", bottom="z")  # local == base region
        release = _doc(top="# A", region="vendor upgrade", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-node.md", local, release, base_text=base, verify_fn=stub
        )
        self.assertEqual(cand.resolution.regions[0].verdict, em.TAKE_RELEASE)
        self.assertFalse(cand.resolution.needs_llm)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-node.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 0)  # deterministic vendor take -> NO Haiku

    def test_no_op_candidate_verify_passes_with_no_llm_call(self) -> None:
        base = _doc(top="# A", region="x", bottom="z")
        local = _doc(top="# A", region="x", bottom="z")
        release = _doc(top="# A", region="x", bottom="z")  # nothing changed anywhere
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-python.md", local, release, base_text=base, verify_fn=stub
        )
        self.assertFalse(cand.resolution.needs_llm)
        self.assertFalse(cand.resolution.is_changed)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            # Realistic flow: the target IS the existing local file already on disk;
            # a no-op apply leaves it untouched (returns NOOP, writes nothing).
            p.write_text(local, encoding="utf-8")
            self.assertEqual(cand.apply(str(p)), em.APPLY_NOOP)  # diff won't land
            self.assertEqual(p.read_text(encoding="utf-8"), local)  # left untouched
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 0)

    def test_gated_identical_sides_candidate_makes_no_llm_call(self) -> None:
        # base unavailable but vendor == local region -> keep-local, deterministic.
        local = _doc(top="# A", region="same body", bottom="z")
        release = _doc(top="# A NEW", region="same body", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-db.md", local, release, base_text=None, verify_fn=stub
        )
        self.assertFalse(cand.resolution.base_available)
        self.assertEqual(cand.resolution.regions[0].verdict, em.KEEP_LOCAL)
        self.assertFalse(cand.resolution.needs_llm)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-db.md"
            cand.apply(str(p))
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 0)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class GatedTwoWayCandidateTest(unittest.TestCase):
    """The base-UNAVAILABLE differing-sides path is a REPORT — it never lands.

    GATED_2WAY synthesizes present-both marker text, so the tripwire refuses it at
    both transaction seats; the caller routes it to the manual ceremony instead.
    """

    def test_gated_two_way_present_both_never_lands(self) -> None:
        local = _doc(top="# A", region="local learned", bottom="z")
        release = _doc(top="# A", region="vendor variant", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-rag.md", local, release, base_text=None, verify_fn=stub
        )
        self.assertEqual(cand.resolution.regions[0].verdict, em.GATED_2WAY)
        self.assertTrue(cand.resolution.has_conflict)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-rag.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)
            self.assertFalse(p.exists())  # zero bytes written
            self.assertEqual(cand.verify(str(p)), 1)
        self.assertEqual(stub.calls, 0)  # refused before any Haiku spend

    def test_gated_two_way_report_still_surfaces_both_sides(self) -> None:
        # The candidate is un-landable but remains the ceremony's report artifact:
        # both sides stay visible so a human can resolve them.
        local = _doc(top="# A", region="local learned", bottom="z")
        release = _doc(top="# A", region="vendor variant", bottom="z")

        cand = em.build_merge_candidate(
            "dev-rag.md", local, release, base_text=None, verify_fn=_StubVerify(True)
        )
        self.assertIn("local learned", cand.resolution.candidate_text)
        self.assertIn("vendor variant", cand.resolution.candidate_text)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ConflictCandidateTest(unittest.TestCase):
    """An overlapping both-changed conflict is a REPORT — it never lands."""

    def test_conflict_candidate_is_refused_and_writes_zero_bytes(self) -> None:
        base = _doc(top="# A", region="same-old", bottom="z")
        local = _doc(top="# A", region="LOCAL rewrite", bottom="z")
        release = _doc(top="# A", region="VENDOR rewrite", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-android.md",
            local,
            release,
            base_text=base,
            verify_fn=stub,
            resolve_conflicting_gaps=False,
        )
        self.assertEqual(cand.resolution.verdict, em.MERGE_CONFLICT)
        self.assertTrue(cand.resolution.has_conflict)
        self.assertIn("LOCAL rewrite", cand.resolution.candidate_text)
        self.assertIn("VENDOR rewrite", cand.resolution.candidate_text)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-android.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)
            self.assertFalse(p.exists())
            self.assertEqual(cand.verify(str(p)), 1)
        self.assertEqual(stub.calls, 0)  # a marker candidate never buys an LLM call

    def test_apply_leaves_an_existing_local_body_byte_identical(self) -> None:
        # The realistic seat: the target already holds the live body. A refused
        # apply must not touch it (git_txn then reports APPLY_FAIL, nothing lands).
        base = _doc(top="# A", region="same-old", bottom="z")
        local = _doc(top="# A", region="LOCAL rewrite", bottom="z")
        release = _doc(top="# A", region="VENDOR rewrite", bottom="z")

        cand = em.build_merge_candidate(
            "dev-android.md",
            local,
            release,
            base_text=base,
            verify_fn=_StubVerify(True),
            resolve_conflicting_gaps=False,
        )
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-android.md"
            p.write_text(local, encoding="utf-8")
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)
            self.assertEqual(p.read_text(encoding="utf-8"), local)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ConflictMarkerTripwireTest(unittest.TestCase):
    """The marker scan itself: polarity + false-positive safety."""

    def test_exact_updater_markers_are_detected(self) -> None:
        for marker in (
            "<<<<<<< LOCAL (learned)",
            "||||||| BASE (base@install)",
            ">>>>>>> RELEASE (vendor)",
        ):
            with self.subTest(marker=marker):
                self.assertTrue(em.has_conflict_markers(f"intro\n{marker}\ntail\n"))

    def test_prose_about_git_conflicts_is_not_a_false_positive(self) -> None:
        # An agent body may legitimately DOCUMENT conflict markers. Only the exact
        # updater-authored lines count — a bare marker or a separator does not.
        body = (
            "# dev-git\n"
            "Resolve a conflict by deleting the `<<<<<<<` and `>>>>>>>` lines.\n"
            "<<<<<<< HEAD\n"
            "=======\n"
            ">>>>>>> feature/x\n"
        )
        self.assertFalse(em.has_conflict_markers(body))

    def test_verify_rejects_markers_reaching_the_file_from_any_source(self) -> None:
        # BACKSTOP polarity: the candidate itself is clean (deterministic keep-local,
        # no LLM), yet the on-disk file carries markers — from a stale base, a
        # restored backup, a crash window. verify() must fail so git_txn restores.
        base = _doc(top="# A", region="learned", bottom="v1")
        local = _doc(top="# A", region="learned", bottom="v1")
        release = _doc(top="# A", region="learned", bottom="v2")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-python.md", local, release, base_text=base, verify_fn=stub
        )
        self.assertFalse(cand.resolution.has_conflict)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(p)), 0)  # clean landing passes
            p.write_text(
                _doc(
                    top="# A",
                    region="<<<<<<< LOCAL (learned)\nlearned\n>>>>>>> RELEASE (vendor)",
                    bottom="v2",
                ),
                encoding="utf-8",
            )
            self.assertEqual(cand.verify(str(p)), 1)  # tampered on-disk state fails


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class RerunIdempotencyTest(unittest.TestCase):
    """Same-release re-run behavior against an ADVANCED vs a STALE merge base.

    The live defect: after run 1 merged and the merged body was committed, run 2 with
    the SAME release re-diffed against the un-advanced base@install anchor and wrote
    literal conflict markers into the live agent file.
    """

    _BASE = _doc(top="# dev-react", region="b1\nb2", bottom="old rules")
    _LOCAL = _doc(top="# dev-react", region="LOCAL learned\nb1\nb2", bottom="old rules")
    _RELEASE = _doc(top="# dev-react", region="b1\nb2\nVENDOR", bottom="NEW rules")

    def test_advanced_base_rerun_is_a_zero_write_no_op(self) -> None:
        # Run 1: both changed, non-overlapping -> clean merge.
        merged = em.resolve_file(
            "dev-react.md", self._LOCAL, self._RELEASE, self._BASE
        ).candidate_text

        # The base ADVANCES to the RELEASE body (never to the merged result — see the
        # next test for why). Run 2 with the same release now sees release == base.
        rerun = em.resolve_file("dev-react.md", merged, self._RELEASE, self._RELEASE)

        self.assertEqual(rerun.verdict, em.NO_OP)
        self.assertFalse(rerun.is_changed)
        self.assertFalse(rerun.has_conflict)
        self.assertFalse(em.has_conflict_markers(rerun.candidate_text))
        self.assertIn("LOCAL learned", rerun.candidate_text)  # learned content intact

    def test_advanced_base_keeps_learned_content_on_the_next_release(self) -> None:
        # Why the base advances to the RELEASE body and NOT the merged result:
        # base := merged would make local == base, classifying the learned region as
        # TAKE_RELEASE and silently stripping it on the next real release.
        merged = em.resolve_file(
            "dev-react.md", self._LOCAL, self._RELEASE, self._BASE
        ).candidate_text
        release_v2 = _doc(
            top="# dev-react", region="b1\nb2\nVENDOR v2", bottom="NEWER rules"
        )

        correct = em.resolve_file("dev-react.md", merged, release_v2, self._RELEASE)
        inverted = em.resolve_file("dev-react.md", merged, release_v2, merged)

        self.assertIn("LOCAL learned", correct.candidate_text)
        self.assertIn("VENDOR v2", correct.candidate_text)
        self.assertNotIn("LOCAL learned", inverted.candidate_text)  # the anchor trap

    def test_stale_base_rerun_reconflicts_and_is_refused(self) -> None:
        # THE DEFECT, reproduced: run 1 conflicted, so run 2 against the un-advanced
        # base re-conflicts the already-merged region. The tripwire refuses the write.
        base = _doc(top="# dev-react", region="same-old", bottom="old rules")
        local = _doc(top="# dev-react", region="LOCAL rewrite", bottom="old rules")
        release = _doc(top="# dev-react", region="VENDOR rewrite", bottom="NEW rules")
        first = em.resolve_file(
            "dev-react.md", local, release, base, resolve_conflicting_gaps=False
        )
        self.assertEqual(first.verdict, em.MERGE_CONFLICT)

        # Simulate the pre-fix landed state (markers in the live body), then re-run
        # against the STILL-STALE base: the markers nest instead of resolving.
        rerun = em.build_merge_candidate(
            "dev-react.md",
            first.candidate_text,
            release,
            base_text=base,
            verify_fn=_StubVerify(True),
            resolve_conflicting_gaps=False,
        )
        self.assertTrue(rerun.resolution.has_conflict)
        self.assertGreaterEqual(
            rerun.resolution.candidate_text.count("<<<<<<< LOCAL (learned)"), 2
        )
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-react.md"
            p.write_text(first.candidate_text, encoding="utf-8")
            self.assertEqual(rerun.apply(str(p)), em.APPLY_MALFORMED)
            self.assertEqual(p.read_text(encoding="utf-8"), first.candidate_text)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class SensitiveDiffRefusalTest(unittest.TestCase):
    """T21 — refusal by sensitive DIFF BODY (distinct from the sensitive-PATH refusal).

    A region whose merged content INTRODUCES an irreversible/external-effect command
    (rm -rf / DROP TABLE / launchctl bootout / chmod) must refuse even when the path
    is a benign agent file — and must do so WITHOUT spending an LLM call.
    """

    def test_added_rm_rf_in_region_refuses(self) -> None:
        # only-vendor change carries `rm -rf` into the candidate region.
        base = _doc(top="# A", region="safe line", bottom="z")
        local = _doc(top="# A", region="safe line", bottom="z")
        release = _doc(top="# A", region="rm -rf /tmp/scratch", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-shell.md", local, release, base_text=base, verify_fn=stub
        )
        self.assertTrue(cand.refused)
        self.assertIsNotNone(cand.sensitive_hit)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-shell.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)
            self.assertFalse(p.exists())  # never written
            self.assertEqual(cand.verify(str(p)), 1)
        self.assertEqual(stub.calls, 0)  # refused before any Haiku spend

    def test_added_drop_table_in_region_refuses(self) -> None:
        base = _doc(top="# A", region="select 1", bottom="z")
        local = _doc(top="# A", region="select 1", bottom="z")
        release = _doc(top="# A", region="DROP TABLE users;", bottom="z")

        cand = em.build_merge_candidate(
            "dev-db.md", local, release, base_text=base, verify_fn=_StubVerify(True)
        )
        self.assertTrue(cand.refused)

    def test_verify_rescan_catches_post_write_sensitive_tampering(self) -> None:
        # A clean candidate that passes build-time scanning; the on-disk file is then
        # tampered to carry a sensitive line. verify() re-scans the WRITTEN file and
        # must refuse, defending the txn against unexpected on-disk state.
        base = _doc(top="# A", region="clean", bottom="z")
        local = _doc(top="# A", region="clean", bottom="z")
        release = _doc(top="# A", region="vendor clean", bottom="z")
        cand = em.build_merge_candidate(
            "dev-node.md", local, release, base_text=base, verify_fn=_StubVerify(True)
        )
        self.assertFalse(cand.refused)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-node.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(p)), 0)  # clean on-disk -> ok
            # Simulate out-of-band tampering introducing an irreversible command.
            p.write_text(
                _doc(top="# A", region="launchctl bootout gui/501", bottom="z"),
                encoding="utf-8",
            )
            self.assertEqual(cand.verify(str(p)), 1)  # re-scan refuses


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class StructuralApplyVerifyTest(unittest.TestCase):
    """T21 — a STRUCTURAL (region-count mismatch) candidate hard-fails apply + verify."""

    def _structural_candidate(self):  # noqa: ANN202
        base = _doc(top="# A", region="r", bottom="z")
        local = _doc(top="# A", region="r", bottom="z")
        release = (
            "# A\n"
            "<!-- EDITABLE:BEGIN -->\nr1\n<!-- EDITABLE:END -->\n"
            "mid\n"
            "<!-- EDITABLE:BEGIN -->\nr2\n<!-- EDITABLE:END -->\n"
            "z\n"
        )
        return em.build_merge_candidate(
            "dev-go.md", local, release, base_text=base, verify_fn=_StubVerify(True)
        )

    def test_structural_candidate_apply_is_malformed_and_unwritten(self) -> None:
        cand = self._structural_candidate()
        self.assertEqual(cand.resolution.verdict, em.STRUCTURAL)
        self.assertTrue(cand.resolution.needs_ceremony)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-go.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)
            self.assertFalse(p.exists())

    def test_structural_candidate_verify_hard_fails(self) -> None:
        cand = self._structural_candidate()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-go.md"
            # write directly so verify has a file to (refuse to) read
            p.write_text("placeholder\n", encoding="utf-8")
            self.assertEqual(cand.verify(str(p)), 1)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ThreeWayMergePureFunctionTest(unittest.TestCase):
    """T21 — the net-new diff3 primitive: one-sided gaps and identical-change collapse."""

    def test_only_one_side_changed_gap_taken_without_conflict(self) -> None:
        base = ["a\n", "b\n", "c\n"]
        local = ["a\n", "LOCAL\n", "b\n", "c\n"]  # local inserted a line
        release = ["a\n", "b\n", "c\n"]  # release untouched
        merged, conflict = em.three_way_merge(base, local, release)
        self.assertFalse(conflict)
        self.assertEqual(merged, local)

    def test_both_sides_identical_change_collapses_to_one(self) -> None:
        base = ["a\n", "b\n"]
        local = ["a\n", "SAME\n", "b\n"]
        release = ["a\n", "SAME\n", "b\n"]
        merged, conflict = em.three_way_merge(base, local, release)
        self.assertFalse(conflict)
        self.assertEqual(merged.count("SAME\n"), 1)  # not duplicated

    def test_divergent_change_emits_conflict_markers(self) -> None:
        base = ["x\n"]
        local = ["LOCAL\n"]
        release = ["RELEASE\n"]
        merged, conflict = em.three_way_merge(base, local, release)
        self.assertTrue(conflict)
        joined = "".join(merged)
        self.assertIn("LOCAL", joined)
        self.assertIn("RELEASE", joined)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class CliPlanTest(unittest.TestCase):
    """T21 — the thin `plan` CLI: base-content-store integration + refusal exit code."""

    def _write(self, d: Path, name: str, text: str) -> str:
        p = d / name
        p.write_text(text, encoding="utf-8")
        return str(p)

    def test_plan_uses_base_store_and_writes_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            d = Path(raw)
            base = _doc(top="# A", region="shared", bottom="z")
            local = _doc(top="# A", region="shared", bottom="z")
            release = _doc(top="# A", region="vendor upgrade", bottom="z")
            # Seed the base-content store keyed by basename (what load_base_text reads).
            store = em.base_store_dir(str(d / "state"))
            store.mkdir(parents=True)
            (store / "dev-node.md").write_text(base, encoding="utf-8")

            local_p = self._write(d, "local.md", local)
            release_p = self._write(d, "release.md", release)
            out_p = str(d / "candidate.md")

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = em.main(
                    [
                        "plan",
                        "--target", "dev-node.md",
                        "--local", local_p,
                        "--release", release_p,
                        "--out", out_p,
                        "--state-dir", str(d / "state"),
                    ]
                )
            self.assertEqual(rc, em.EXIT_OK)
            self.assertIn(f"verdict={em.TAKE_RELEASE}", buf.getvalue())
            self.assertIn("vendor upgrade", Path(out_p).read_text(encoding="utf-8"))

    def test_plan_refuses_sensitive_path_with_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            d = Path(raw)
            body = _doc(top="# R", region="rule", bottom="z")
            local_p = self._write(d, "local.md", body)
            release_p = self._write(
                d, "release.md", _doc(top="# R", region="rule vendor", bottom="z")
            )
            out_p = str(d / "candidate.md")
            buf = io.StringIO()
            with contextlib.redirect_stderr(buf):
                rc = em.main(
                    [
                        "plan",
                        "--target", "GLASS_ATRIUM_GLOBAL_RULES.md",
                        "--local", local_p,
                        "--release", release_p,
                        "--out", out_p,
                    ]
                )
            self.assertEqual(rc, em.EXIT_REFUSED)
            self.assertFalse(Path(out_p).exists())  # refused -> no candidate written


def _fm_doc(front: str, region: str) -> str:
    """Agent body with a byte-0 frontmatter block and one EDITABLE region."""
    return (
        "---\n"
        + front
        + "---\n\n# title\n\n<!-- EDITABLE:BEGIN -->\n"
        + region
        + "\n<!-- EDITABLE:END -->\n"
    )


class GapPolicyTest(unittest.TestCase):
    """Deterministic conflicting-gap resolution: the release side, marker-free."""

    _BASE = _doc(top="# A", region="same-old", bottom="z")
    _LOCAL = _doc(top="# A", region="LOCAL rewrite", bottom="z")
    _RELEASE = _doc(top="# A", region="VENDOR rewrite", bottom="z")

    def test_when_policy_on_then_conflicting_gap_takes_release_marker_free(self) -> None:
        res = em.resolve_file(
            "dev-android.md",
            self._LOCAL,
            self._RELEASE,
            self._BASE,
            resolve_conflicting_gaps=True,
        )

        self.assertEqual(res.verdict, em.MERGE_RESOLVED_RELEASE)
        self.assertFalse(res.has_conflict)
        self.assertFalse(res.regions[0].had_conflict)
        self.assertFalse(em.has_conflict_markers(res.candidate_text))
        self.assertIn("VENDOR rewrite", res.candidate_text)
        self.assertNotIn("LOCAL rewrite", res.candidate_text)

    def test_when_policy_on_then_region_carries_its_hunks_forward(self) -> None:
        res = em.resolve_file(
            "dev-android.md",
            self._LOCAL,
            self._RELEASE,
            self._BASE,
            resolve_conflicting_gaps=True,
        )

        (hunk,) = res.regions[0].hunks
        self.assertEqual(hunk.base, ("same-old\n",))
        self.assertEqual(hunk.local, ("LOCAL rewrite\n",))
        self.assertEqual(hunk.release, ("VENDOR rewrite\n",))

    def test_when_rederived_from_same_anchors_then_candidate_is_byte_identical(self) -> None:
        kwargs = {"resolve_conflicting_gaps": True}
        first = em.resolve_file(
            "dev-android.md", self._LOCAL, self._RELEASE, self._BASE, **kwargs
        )
        second = em.resolve_file(
            "dev-android.md", self._LOCAL, self._RELEASE, self._BASE, **kwargs
        )

        self.assertEqual(first.candidate_text, second.candidate_text)
        self.assertEqual(first.verdict, second.verdict)

    def test_when_policy_off_then_output_matches_the_reporting_default(self) -> None:
        res = em.resolve_file(
            "dev-android.md",
            self._LOCAL,
            self._RELEASE,
            self._BASE,
            resolve_conflicting_gaps=False,
        )

        self.assertEqual(res.verdict, em.MERGE_CONFLICT)
        self.assertTrue(res.has_conflict)
        self.assertTrue(em.has_conflict_markers(res.candidate_text))
        self.assertIn("LOCAL rewrite", res.candidate_text)

    def test_when_kill_switch_set_then_the_default_reverts_to_reporting(self) -> None:
        prior = os.environ.get(em._RESOLVE_GAPS_ENV)
        try:
            os.environ[em._RESOLVE_GAPS_ENV] = "0"
            off = em.resolve_file(
                "dev-android.md", self._LOCAL, self._RELEASE, self._BASE
            )
            os.environ.pop(em._RESOLVE_GAPS_ENV)
            on = em.resolve_file(
                "dev-android.md", self._LOCAL, self._RELEASE, self._BASE
            )
        finally:
            if prior is None:
                os.environ.pop(em._RESOLVE_GAPS_ENV, None)
            else:
                os.environ[em._RESOLVE_GAPS_ENV] = prior

        self.assertEqual(off.verdict, em.MERGE_CONFLICT)
        self.assertEqual(on.verdict, em.MERGE_RESOLVED_RELEASE)

    def test_when_policy_on_then_candidate_applies_and_verifies_through_the_gate(self) -> None:
        stub = _StubVerify(passed=True)
        cand = em.build_merge_candidate(
            "dev-android.md",
            self._LOCAL,
            self._RELEASE,
            base_text=self._BASE,
            verify_fn=stub,
            resolve_conflicting_gaps=True,
        )

        self.assertEqual(cand.resolution.verdict, em.MERGE_RESOLVED_RELEASE)
        self.assertTrue(cand.resolution.needs_llm)  # joined the model-gated set
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dev-android.md"
            target.write_text(self._LOCAL, encoding="utf-8")
            self.assertEqual(cand.apply(str(target)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(target)), 0)
            self.assertFalse(
                em.has_conflict_markers(target.read_text(encoding="utf-8"))
            )

    def test_when_gap_is_non_conflicting_then_no_hunk_and_lines_match_legacy(self) -> None:
        base, local, release = ["A\n"], ["A\n"], ["R\n"]

        merged, hunks = em.three_way_merge_hunks(
            base, local, release, resolve_release=True
        )

        self.assertEqual(hunks, [])
        self.assertEqual(merged, ["R\n"])
        self.assertEqual(em.three_way_merge(base, local, release), (["R\n"], False))

    def test_when_region_has_many_conflicting_gaps_then_one_hunk_each_in_order(self) -> None:
        base = ["A\n", "s\n", "B\n"]
        local = ["LA\n", "s\n", "LB\n"]
        release = ["RA\n", "s\n", "RB\n"]

        merged, hunks = em.three_way_merge_hunks(
            base, local, release, resolve_release=True
        )

        self.assertEqual(merged, ["RA\n", "s\n", "RB\n"])
        self.assertEqual([h.local for h in hunks], [("LA\n",), ("LB\n",)])
        self.assertEqual([h.out_index for h in hunks], [0, 2])

    def test_when_gap_is_clean_beside_a_conflicting_one_then_it_is_untouched(self) -> None:
        base = ["A\n", "s\n", "B\n"]
        local = ["LOCAL1\n", "s\n", "B\n"]
        release = ["REL1\n", "s\n", "B-REL\n"]

        merged, hunks = em.three_way_merge_hunks(
            base, local, release, resolve_release=True
        )

        self.assertEqual(len(hunks), 1)
        self.assertEqual(merged, ["REL1\n", "s\n", "B-REL\n"])


class BaseAwareFrontmatterTest(unittest.TestCase):
    """`effort` is release-shipped, so live-wins is conditional on base divergence."""

    def _resolve(self, base_front: str, local_front: str, release_front: str) -> str:
        return em.resolve_file(
            "glass-atrium-qa-debugger.md",
            _fm_doc(local_front, "kept"),
            _fm_doc(release_front, "kept"),
            _fm_doc(base_front, "kept"),
        ).candidate_text

    def test_when_live_effort_differs_from_base_then_the_pin_is_kept(self) -> None:
        out = self._resolve(
            "name: qa\neffort: high\n",
            "name: qa\neffort: xhigh\n",
            "name: qa\neffort: high\n",
        )

        self.assertIn("effort: xhigh\n", out)
        self.assertNotIn("effort: high\n", out)

    def test_when_live_effort_equals_base_then_the_release_value_lands(self) -> None:
        out = self._resolve(
            "name: qa\neffort: high\n",
            "name: qa\neffort: high\n",
            "name: qa\neffort: max\n",
        )

        self.assertIn("effort: max\n", out)
        self.assertNotIn("effort: high\n", out)

    def test_when_base_is_absent_then_effort_falls_back_to_live_wins(self) -> None:
        out = em.resolve_file(
            "glass-atrium-qa-debugger.md",
            _fm_doc("name: qa\neffort: xhigh\n", "kept"),
            _fm_doc("name: qa\neffort: high\n", "kept"),
        ).candidate_text

        self.assertIn("effort: xhigh\n", out)

    def test_when_model_is_live_only_then_it_is_kept_unconditionally(self) -> None:
        out = self._resolve("name: qa\n", "name: qa\nmodel: opus\n", "name: qa\n")

        self.assertIn("model: opus\n", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
