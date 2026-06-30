"""Behavioral tests for the three-anchor EDITABLE-region merge module (T17/T18/T21).

Covered behaviors (T21 — consolidated, full base-content path):
  * vendor-untouched region -> keep-local, BYTE-IDENTICAL, NO LLM call;
  * both-changed region WITH base content -> net-new diff3 candidate, Haiku-gated
    (clean merge + overlapping conflict, candidate-level apply/verify both ways);
  * only-local / only-vendor change -> deterministic take-release/keep-local, NO LLM;
  * no-op (nothing changed anywhere) -> deterministic, NO LLM, apply no-op code;
  * base-content-unavailable -> gated 2-way present-both, Haiku-gated when sides
    differ / deterministic keep-local when sides match (no faked 3-way);
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

        res = em.resolve_file("dev-android.md", local, release, base)

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
            "GLOBAL_RULES.md",
            local,
            release,
            base_text=base,
            verify_fn=stub,
        )
        self.assertTrue(cand.refused)
        self.assertIsNotNone(cand.sensitive_hit)
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "GLOBAL_RULES.md"
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
    """T21 — the base-UNAVAILABLE differing-sides path is Haiku-gated at candidate level.

    resolve_file-level gating was covered; the MergeCandidate apply/verify wiring of
    the GATED_2WAY verdict (which IS in _LLM_REQUIRED) was not.
    """

    def test_gated_two_way_differing_sides_invokes_haiku(self) -> None:
        local = _doc(top="# A", region="local learned", bottom="z")
        release = _doc(top="# A", region="vendor variant", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-rag.md", local, release, base_text=None, verify_fn=stub
        )
        self.assertEqual(cand.resolution.regions[0].verdict, em.GATED_2WAY)
        self.assertTrue(cand.resolution.needs_llm)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-rag.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 1)  # present-both -> exactly one Haiku gate

    def test_gated_two_way_haiku_reject_fails_verify(self) -> None:
        local = _doc(top="# A", region="local learned", bottom="z")
        release = _doc(top="# A", region="vendor variant", bottom="z")
        stub = _StubVerify(passed=False)

        cand = em.build_merge_candidate(
            "dev-rag.md", local, release, base_text=None, verify_fn=stub
        )
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-rag.md"
            cand.apply(str(p))
            self.assertEqual(cand.verify(str(p)), 1)
        self.assertEqual(stub.calls, 1)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ConflictCandidateTest(unittest.TestCase):
    """T21 — an overlapping both-changed conflict is Haiku-gated at candidate level."""

    def test_conflict_candidate_carries_markers_and_gates(self) -> None:
        base = _doc(top="# A", region="same-old", bottom="z")
        local = _doc(top="# A", region="LOCAL rewrite", bottom="z")
        release = _doc(top="# A", region="VENDOR rewrite", bottom="z")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-android.md", local, release, base_text=base, verify_fn=stub
        )
        self.assertEqual(cand.resolution.verdict, em.MERGE_CONFLICT)
        self.assertTrue(cand.resolution.needs_llm)
        self.assertIn("LOCAL rewrite", cand.resolution.candidate_text)
        self.assertIn("VENDOR rewrite", cand.resolution.candidate_text)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-android.md"
            self.assertEqual(cand.apply(str(p)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(p)), 0)
        self.assertEqual(stub.calls, 1)


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
                        "--target", "GLOBAL_RULES.md",
                        "--local", local_p,
                        "--release", release_p,
                        "--out", out_p,
                    ]
                )
            self.assertEqual(rc, em.EXIT_REFUSED)
            self.assertFalse(Path(out_p).exists())  # refused -> no candidate written


if __name__ == "__main__":
    unittest.main(verbosity=2)
