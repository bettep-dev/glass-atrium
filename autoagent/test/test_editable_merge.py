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
  * three_way_merge_hunks pure-function gap behavior (one-sided / identical
    collapse / divergent conflict).

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_editable_merge.py -v
    python3 -m unittest autoagent.test.test_editable_merge -v
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

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


_SUITE_ENV_RESTORE: dict[str, str | None] = {}
_SUITE_CLAUDE_BIN_RESTORE: str | None = None
_SUITE_KWDEFAULT_RESTORE: str | None = None
_SUITE_SANDBOX_DIR: str | None = None


def _pin_model_seam(stub: str) -> None:
    """Point every in-process arbiter call at ``stub``, both bindings of it.

    ``daemon_cycle.CLAUDE_BIN`` reads ``AUTOAGENT_CLAUDE_BIN`` once, at ITS import,
    and ``gap_arbiter.get_decision`` copies that value into a keyword default at
    ITS import. Discovery imports every module before the first setUpModule runs,
    so a sibling module importing gap_arbiter freezes that copy at a bare
    ``claude`` — which is why rebinding the constant alone leaves exactly one
    PATH invocation in a whole-root run and none when this file runs alone.
    """
    global _SUITE_CLAUDE_BIN_RESTORE, _SUITE_KWDEFAULT_RESTORE
    _SUITE_CLAUDE_BIN_RESTORE = em.dc.CLAUDE_BIN
    em.dc.CLAUDE_BIN = stub
    import gap_arbiter as ga  # noqa: PLC0415 — mirrors editable_merge's lazy seam load

    kwdefaults = ga.get_decision.__kwdefaults__ or {}
    if "claude_bin" in kwdefaults:
        _SUITE_KWDEFAULT_RESTORE = kwdefaults["claude_bin"]
        kwdefaults["claude_bin"] = stub


def _unpin_model_seam() -> None:
    if _SUITE_CLAUDE_BIN_RESTORE is not None:
        em.dc.CLAUDE_BIN = _SUITE_CLAUDE_BIN_RESTORE
    if _SUITE_KWDEFAULT_RESTORE is not None:
        import gap_arbiter as ga  # noqa: PLC0415 — restore the binding pinned above

        kwdefaults = ga.get_decision.__kwdefaults__ or {}
        if "claude_bin" in kwdefaults:
            kwdefaults["claude_bin"] = _SUITE_KWDEFAULT_RESTORE


def setUpModule() -> None:
    """Redirect the state root and the model seam into a module-scoped sandbox.

    ``state_root`` falls back to ``$HOME/.claude/data/update`` whenever
    ``ATRIUM_UPDATE_STATE_DIR`` is unset, so a test reaching the arbiter without
    naming a state directory writes a decision record under the operator's real
    state root. Pinning it HERE covers every test in the module, including one
    added later whose fixture happens to route to the arbiter — which the
    per-test ``--state-dir`` arguments, correct where they appear, cannot.

    The model seam needs the export AND the two in-process bindings
    ``_pin_model_seam`` covers: the export reaches the subprocess drives, the
    rebindings reach the in-process ones. The stub exits non-zero — the arbiter's
    unavailable arm, so contested gaps keep local and every decline this module
    asserts is unchanged.
    """
    global _SUITE_SANDBOX_DIR
    _SUITE_SANDBOX_DIR = tempfile.mkdtemp(prefix="ga-editable-merge-suite-")
    root = Path(_SUITE_SANDBOX_DIR)
    stub = root / "claude-stub"
    stub.write_text(
        '#!/bin/sh\necho "arbiter model seam stubbed in unittest" >&2\nexit 1\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    state = root / "state"
    state.mkdir()
    for key, value in (
        ("ATRIUM_UPDATE_STATE_DIR", str(state)),
        ("AUTOAGENT_CLAUDE_BIN", str(stub)),
    ):
        _SUITE_ENV_RESTORE[key] = os.environ.get(key)
        os.environ[key] = value
    if em is not None:
        _pin_model_seam(str(stub))


def tearDownModule() -> None:
    if em is not None:
        _unpin_model_seam()
    for key, prior in _SUITE_ENV_RESTORE.items():
        if prior is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prior
    _SUITE_ENV_RESTORE.clear()
    if _SUITE_SANDBOX_DIR:
        shutil.rmtree(_SUITE_SANDBOX_DIR, ignore_errors=True)


def _doc(*, top: str, region: str, bottom: str) -> str:
    """Build an agent .md body with a single EDITABLE region."""
    return (
        f"{top}\n<!-- EDITABLE:BEGIN -->\n{region}\n<!-- EDITABLE:END -->\n{bottom}\n"
    )


class _StubVerify:
    """Injectable stand-in for daemon_cycle.run_pre_verify — records calls."""

    def __init__(
        self,
        passed: bool,
        *,
        status: str = "ok",
        axes: dict[str, bool] | None = None,
        rationale: str = "",
    ) -> None:
        self.passed = passed
        self.status = status
        self.axes = axes if axes is not None else {}
        self.rationale = rationale
        self.calls = 0

    def __call__(self, patch, pattern, *, skip_pre_verify=False):  # noqa: ANN001
        self.calls += 1

        class _R:
            passed = self.passed
            status = self.status
            axes = self.axes
            rationale = self.rationale

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

    def test_live_only_effort_pin_survives_a_release_without_one(self) -> None:
        # P0-1 AC1, and the regression this phase exists for: an `effort:` tier the
        # release does not carry was dropped on the first successful merge, exactly
        # as `model:` was before it joined the allowlist.
        release = self._body(self._FM, "base goal", "vendor rules v2")
        local = self._body(f"{self._FM}effort: xhigh\n", "learned", "old")

        res = em.resolve_file("qa-debugger.md", local, release, release)

        self.assertIn("effort: xhigh\n", res.candidate_text)
        self.assertIn("vendor rules v2", res.candidate_text)

    def test_live_effort_pin_wins_over_a_release_carried_one(self) -> None:
        # P0-1 AC3 — NOT vacuous the way the `model:` twin is: the release really
        # does ship `effort:` for some agents, so live-wins is exercised in the wild.
        release = self._body(f"{self._FM}effort: high\n", "base goal", "v2")
        local = self._body(f"{self._FM}effort: xhigh\n", "learned", "old")

        res = em.resolve_file("qa-debugger.md", local, release, release)

        self.assertIn("effort: xhigh\n", res.candidate_text)
        self.assertNotIn("effort: high", res.candidate_text)

    def test_both_allowlisted_pins_survive_together(self) -> None:
        release = self._body(self._FM, "base goal", "v2")
        local = self._body(f"{self._FM}model: claude-opus-5\neffort: xhigh\n", "l", "o")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertIn("model: claude-opus-5\n", res.candidate_text)
        self.assertIn("effort: xhigh\n", res.candidate_text)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class UnallowlistedFrontmatterAdvisoryTest(unittest.TestCase):
    """P0-1 AC2 — name the live-only keys the merge drops, never block on them."""

    _FM = "name: dev-x\ntools: Read, Write\n"

    def _body(self, frontmatter: str) -> str:
        return _doc(top=f"---\n{frontmatter}---\n\n# X\n", region="r", bottom="b")

    def _candidate(self, local: str, release: str, base: str | None = None) -> str:
        """The body the merge would WRITE — the artifact the advisory reads."""
        return em.resolve_file("dev-x.md", local, release, base).candidate_text

    def test_live_only_unallowlisted_key_is_named(self) -> None:
        release = self._body(self._FM)
        local = self._body(f"{self._FM}maxTurns: 40\n")

        self.assertEqual(
            em.dropped_local_frontmatter_keys(local, self._candidate(local, release)),
            ["maxTurns"],
        )

    def test_allowlisted_and_release_carried_keys_are_not_named(self) -> None:
        release = self._body(f"{self._FM}maxTurns: 12\n")
        local = self._body(f"{self._FM}maxTurns: 40\nmodel: m\neffort: xhigh\n")

        self.assertEqual(
            em.dropped_local_frontmatter_keys(local, self._candidate(local, release)),
            [],
        )

    def test_multiple_dropped_keys_keep_local_order(self) -> None:
        release = self._body(self._FM)
        local = self._body(f"{self._FM}zeta: 1\nalpha: 2\n")

        self.assertEqual(
            em.dropped_local_frontmatter_keys(local, self._candidate(local, release)),
            ["zeta", "alpha"],
        )

    def test_absent_frontmatter_names_nothing(self) -> None:
        # fail-open, mirroring _keep_local_frontmatter: no block, no divergence.
        plain = _doc(top="# plain", region="r", bottom="b")

        self.assertEqual(em.dropped_local_frontmatter_keys(plain, plain), [])
        self.assertEqual(
            em.dropped_local_frontmatter_keys(plain, self._body(self._FM)), []
        )

    def test_advisory_does_not_change_the_candidate(self) -> None:
        # The advisory REPORTS the drop; it must not resurrect the key.
        release = self._body(self._FM)
        local = self._body(f"{self._FM}maxTurns: 40\n")

        res = em.resolve_file("dev-x.md", local, release, release)

        self.assertNotIn("maxTurns: 40", res.candidate_text)

    def test_base_aware_key_a_release_lacks_is_named_when_equal_to_base(self) -> None:
        # The carry pass leaves a base-aware key UNCHANGED since install to the
        # release, so a release that ships no such key drops it outright. Derived
        # from the release skeleton the key read as carried and the drop went
        # unannounced; read off the candidate the merge writes, it is named.
        base = self._body(f"{self._FM}effort: high\n")
        local = base
        release = self._body(self._FM)

        candidate = self._candidate(local, release, base)

        self.assertNotIn("effort:", candidate)
        self.assertEqual(
            em.dropped_local_frontmatter_keys(local, candidate), ["effort"]
        )

    def _plan_line(self, local: str, release: str) -> str:
        with tempfile.TemporaryDirectory() as raw:
            d = Path(raw)
            (d / "local.md").write_text(local, encoding="utf-8")
            (d / "release.md").write_text(release, encoding="utf-8")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = em.main(
                    [
                        "plan",
                        "--target", "agents/dev-x.md",
                        "--local", str(d / "local.md"),
                        "--release", str(d / "release.md"),
                        "--base", str(d / "local.md"),
                        "--out", str(d / "candidate.md"),
                        "--state-dir", str(d / "state"),
                    ]
                )
            self.assertEqual(rc, em.EXIT_OK)
            return buf.getvalue()

    def test_plan_line_always_carries_the_field(self) -> None:
        # ALWAYS present: the updater's up-to-next-space extractor returns a
        # neighbouring field's value, not an empty string, for an absent token.
        body = self._body(f"{self._FM}model: m\n")

        line = self._plan_line(body, self._body(self._FM))

        self.assertIn("fm_unallowlisted=none ", line)

    def test_plan_line_names_the_dropped_key(self) -> None:
        line = self._plan_line(
            self._body(f"{self._FM}maxTurns: 40\n"), self._body(self._FM)
        )

        self.assertIn("fm_unallowlisted=maxTurns ", line)
        # space-free single token: the shell extractor reads up to the next space.
        self.assertIn(" out=", line)


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
class NoBaseArbitratedRegionTest(unittest.TestCase):
    """A8 — the base-less differing region is judged, with the decline behind it.

    Both arms drive the model seam as a stub: the live headless CLI is the one
    thing a merge fixture must never reach.
    """

    _LOCAL = _doc(top="# A", region="local learned", bottom="z")
    _RELEASE = _doc(top="# A", region="vendor variant", bottom="z")
    _TARGET = "dev-rag.md"

    def _build(self, seam) -> tuple[em.MergeCandidate, str]:
        """Resolve the fixture with no base entry, deriving through ``seam``."""
        err = io.StringIO()
        with tempfile.TemporaryDirectory() as state, contextlib.redirect_stderr(err):
            with mock.patch.object(em.dc, "_invoke_haiku_cli", **seam):
                cand = em.build_merge_candidate(
                    self._TARGET,
                    self._LOCAL,
                    self._RELEASE,
                    base_text=None,
                    agent="dev-rag",
                    arbiter_mode=em.ARBITER_PLAN,
                    state_dir=state,
                    verify_fn=_StubVerify(True),
                )
        return cand, err.getvalue()

    @staticmethod
    def _answer(text: str) -> dict:
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=text, stderr=""
        )
        return {"return_value": (completed, None, None)}

    def test_when_the_arbiter_answers_then_the_region_is_judged_not_declined(
        self,
    ) -> None:
        cand, _rows = self._build(self._answer("CHOICE: RELEASE\nRATIONALE: fixture"))

        res = cand.resolution
        self.assertFalse(res.base_available)
        self.assertEqual(res.regions[0].verdict, em.MERGE_ARBITER_RESOLVED)
        self.assertFalse(res.has_conflict)
        self.assertIn("vendor variant", res.candidate_text)
        self.assertNotIn("local learned", res.candidate_text)

    def test_when_an_interleave_drops_a_line_then_clause_four_reaches_it(self) -> None:
        # The empty base slot is what makes this fail: no line of either side is
        # base-present, so an answer naming only one of the two drops a novel line.
        cand, rows = self._build(
            self._answer("CHOICE: INTERLEAVE\nLINES: L1\nRATIONALE: fixture")
        )

        self.assertEqual(cand.resolution.regions[0].verdict, em.GATED_2WAY)
        self.assertIn("clause=no-drop-of-novel", rows)

    def test_when_the_arbiter_answers_nothing_then_the_present_both_decline_stands(
        self,
    ) -> None:
        # A present CLI exiting non-zero — the live quota-exhausted shape.
        completed = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="quota"
        )
        cand, rows = self._build({"return_value": (completed, None, None)})

        res = cand.resolution
        self.assertEqual(res.regions[0].verdict, em.GATED_2WAY)
        self.assertTrue(res.has_conflict)
        self.assertIn("local learned", res.candidate_text)
        self.assertIn("vendor variant", res.candidate_text)
        self.assertIn("budget-exceeded", rows)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / self._TARGET
            self.assertEqual(cand.apply(str(p)), em.APPLY_MALFORMED)
            self.assertFalse(p.exists())


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

    def test_haiku_reject_reports_status_axes_and_rationale(self) -> None:
        # The rejection the updater sees is an exit code; without this line the
        # reason the result already carries never reaches the update log.
        base = _doc(top="# A", region="b1\nb2", bottom="z")
        local = _doc(top="# A", region="LOCAL\nb1\nb2", bottom="z")
        release = _doc(top="# A", region="b1\nb2\nVENDOR", bottom="z")
        stub = _StubVerify(
            passed=False,
            status="ok",
            axes={"C1": True, "C2": True, "C3": False, "C4": False},
            rationale="patch contradicts an existing guardrail",
        )
        cand = em.build_merge_candidate(
            "dev-python.md", local, release, base_text=base, verify_fn=stub
        )

        captured = io.StringIO()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            cand.apply(str(p))
            with contextlib.redirect_stderr(captured):
                self.assertEqual(cand.verify(str(p)), 1)
        line = captured.getvalue()

        self.assertIn("status=ok", line)
        self.assertIn(stub.rationale, line)
        # Named membership over the axes the result carries — the failed keys are
        # present, the passed ones are not.
        failed = [key for key, ok in stub.axes.items() if not ok]
        passed = [key for key, ok in stub.axes.items() if ok]
        axis_field = line.split("failed_axes=[", 1)[1].split("]", 1)[0]
        for key in failed:
            self.assertIn(key, axis_field)
        for key in passed:
            self.assertNotIn(key, axis_field)

    def test_haiku_pass_emits_no_failure_line(self) -> None:
        base = _doc(top="# A", region="b1\nb2", bottom="z")
        local = _doc(top="# A", region="LOCAL\nb1\nb2", bottom="z")
        release = _doc(top="# A", region="b1\nb2\nVENDOR", bottom="z")
        stub = _StubVerify(passed=True, axes={"C1": True, "C2": True, "C3": True, "C4": True})
        cand = em.build_merge_candidate(
            "dev-python.md", local, release, base_text=base, verify_fn=stub
        )

        captured = io.StringIO()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            cand.apply(str(p))
            with contextlib.redirect_stderr(captured):
                self.assertEqual(cand.verify(str(p)), 0)
        self.assertNotIn("pre-verify REJECTED", captured.getvalue())

    def _reject_line(self, stub: "_StubVerify") -> str:
        base = _doc(top="# A", region="b1\nb2", bottom="z")
        local = _doc(top="# A", region="LOCAL\nb1\nb2", bottom="z")
        release = _doc(top="# A", region="b1\nb2\nVENDOR", bottom="z")
        cand = em.build_merge_candidate(
            "dev-python.md", local, release, base_text=base, verify_fn=stub
        )
        captured = io.StringIO()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dev-python.md"
            cand.apply(str(p))
            with contextlib.redirect_stderr(captured):
                self.assertEqual(cand.verify(str(p)), 1)
        return captured.getvalue()

    def test_reject_line_is_one_record_when_rationale_carries_terminators(self) -> None:
        # The rationale is LLM-authored and reaches an operator-facing log where
        # structure carries meaning: a line terminator inside it ends the record
        # and starts a fresh one that reads as a genuine update-log entry. Before
        # the flatten this emitted 2+ records, the second an ACCEPTED forgery.
        forged = "editable_merge: pre-verify ACCEPTED - agents/dev-shell.md status=ok"
        for label, terminator in (
            ("newline", "\n"),
            ("carriage-return", "\r"),
            ("crlf", "\r\n"),
            ("u2028-line-separator", "\u2028"),
            ("u0085-next-line", "\u0085"),
        ):
            with self.subTest(terminator=label):
                line = self._reject_line(
                    _StubVerify(
                        passed=False,
                        status="ok",
                        axes={"C3": False},
                        rationale=f"real reason{terminator}{forged}",
                    )
                )
                # splitlines() breaks on the WIDER set a viewer/editor/JS reader
                # may honour, so it is the strict assertion; the trailing \n the
                # writer itself appends is the sole record terminator.
                self.assertEqual(len(line.splitlines()), 1)
                self.assertEqual(len([x for x in line.split("\n") if x]), 1)
                self.assertTrue(line.endswith("\n"))
                # Contained, not dropped: the text is still reported, inert.
                self.assertIn("real reason", line)
                self.assertIn(forged, line)

    def test_reject_line_keeps_a_multiline_rationale_whole_and_legible(self) -> None:
        # Containment must not cost the reason its content — the point of the
        # line is that a rejection is diagnosable without re-running the call.
        rationale = (
            "C3 fails: the patch adds a rule that contradicts an\n"
            "existing guardrail.\n"
            "\n"
            "C4 fails: the target already carries an equivalent clause."
        )
        line = self._reject_line(
            _StubVerify(
                passed=False,
                status="ok",
                axes={"C1": True, "C3": False, "C4": False},
                rationale=rationale,
            )
        )
        self.assertEqual(len(line.splitlines()), 1)
        for sentence in (
            "C3 fails: the patch adds a rule that contradicts an existing guardrail.",
            "C4 fails: the target already carries an equivalent clause.",
        ):
            self.assertIn(sentence, line)
        # Field order stays scannable for a human reading the update log.
        self.assertLess(line.index("status="), line.index("failed_axes=["))
        self.assertLess(line.index("failed_axes=["), line.index("rationale="))

    def test_reject_line_flattens_status_and_axis_keys_too(self) -> None:
        # status and the C[1-4] axis keys are code-authored today, but they reach
        # this line off a duck-typed result via getattr — the closed-set guarantee
        # lives in daemon_cycle's parser, not at this boundary. Pinned so a future
        # verify_fn cannot reopen the window through a neighbouring field.
        line = self._reject_line(
            _StubVerify(
                passed=False,
                status="ok\nforged via status",
                axes={"C3\nforged via axis key": False},
                rationale="short",
            )
        )
        self.assertEqual(len(line.splitlines()), 1)
        self.assertIn("forged via status", line)
        self.assertIn("forged via axis key", line)

    def test_flatten_log_field_covers_every_python_whitespace_terminator(self) -> None:
        # Unit-level pin for the shared sanitizer. It is defined in daemon_cycle
        # (beside redact_secrets, its peer boundary scrubber) and tested here,
        # beside the consumer whose forging window motivated it.
        flatten = em.dc.flatten_log_field
        for terminator in ("\n", "\r", "\r\n", "\v", "\f", "\u2028", "\u2029", "\u0085"):
            with self.subTest(terminator=repr(terminator)):
                out = flatten(f"a{terminator}b")
                self.assertEqual(out, "a b")
        self.assertEqual(flatten("  a \n\n  b  "), "a b")
        self.assertEqual(flatten(""), "")
        self.assertEqual(flatten(None), "")
        self.assertEqual(flatten("", default="(none)"), "(none)")
        self.assertEqual(flatten("   \n  ", default="(none)"), "(none)")
        # Falsy non-None values are CONTENT, not an absent field: a `or ""` default
        # test collapsed 0 and False to the empty string, contradicting the
        # preserve-everything contract on the one axis a reader cannot recover.
        self.assertEqual(flatten(0), "0")
        self.assertEqual(flatten(False), "False")
        self.assertEqual(flatten(0, default="(none)"), "0")
        # Non-whitespace content is never altered or truncated.
        self.assertEqual(flatten("keeps — em dash, [brackets] and status=x"),
                         "keeps — em dash, [brackets] and status=x")

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
    """T21 — ``three_way_merge_hunks``: one-sided gaps, identical collapse, conflict."""

    def test_only_one_side_changed_gap_taken_without_conflict(self) -> None:
        base = ["a\n", "b\n", "c\n"]
        local = ["a\n", "LOCAL\n", "b\n", "c\n"]  # local inserted a line
        release = ["a\n", "b\n", "c\n"]  # release untouched
        merged, hunks = em.three_way_merge_hunks(base, local, release)
        self.assertEqual(hunks, [])
        self.assertEqual(merged, local)

    def test_both_sides_identical_change_collapses_to_one(self) -> None:
        base = ["a\n", "b\n"]
        local = ["a\n", "SAME\n", "b\n"]
        release = ["a\n", "SAME\n", "b\n"]
        merged, hunks = em.three_way_merge_hunks(base, local, release)
        self.assertEqual(hunks, [])
        self.assertEqual(merged.count("SAME\n"), 1)  # not duplicated

    def test_divergent_change_emits_conflict_markers(self) -> None:
        base = ["x\n"]
        local = ["LOCAL\n"]
        release = ["RELEASE\n"]
        # arbitrate stays OFF (the default) — the marker assertions below
        # only hold on the reporting path.
        merged, hunks = em.three_way_merge_hunks(base, local, release)
        self.assertTrue(hunks)
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
                        "--state-dir", str(d / "state"),
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


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class GapPolicyTest(unittest.TestCase):
    """Contested-gap routing: neither side emitted, marker-free, judgment pending."""

    _BASE = _doc(top="# A", region="same-old", bottom="z")
    _LOCAL = _doc(top="# A", region="LOCAL rewrite", bottom="z")
    _RELEASE = _doc(top="# A", region="VENDOR rewrite", bottom="z")

    def _resolve(self, *, resolve_gaps: bool = True) -> em.FileResolution:
        """The class fixtures under one mode setting; the default is the library's."""
        return em.resolve_file(
            "dev-android.md",
            self._LOCAL,
            self._RELEASE,
            self._BASE,
            resolve_conflicting_gaps=resolve_gaps,
        )

    def test_when_arbitration_on_then_contested_gap_keeps_local_marker_free(self) -> None:
        res = self._resolve(resolve_gaps=True)

        self.assertEqual(res.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertFalse(res.has_conflict)
        self.assertFalse(res.regions[0].had_conflict)
        self.assertFalse(em.has_conflict_markers(res.candidate_text))
        self.assertIn("LOCAL rewrite", res.candidate_text)
        self.assertNotIn("VENDOR rewrite", res.candidate_text)

    def test_when_the_candidate_equals_local_then_it_is_not_reported_as_a_no_op(
        self,
    ) -> None:
        """A no-op lets the updater advance the base entry, retiring the gap unjudged.

        This fixture's release differs from local only INSIDE the region, so the
        emitted local gap makes the candidate byte-identical to the local body —
        the shape that would otherwise take the no-op collapse.
        """
        res = self._resolve(resolve_gaps=True)

        self.assertEqual(res.candidate_text, self._LOCAL)
        self.assertEqual(res.verdict, em.MERGE_PENDING_ARBITRATION)

    def test_when_policy_on_then_region_carries_its_hunks_forward(self) -> None:
        res = self._resolve(resolve_gaps=True)

        (hunk,) = res.regions[0].hunks
        self.assertEqual(hunk.base, ("same-old\n",))
        self.assertEqual(hunk.local, ("LOCAL rewrite\n",))
        self.assertEqual(hunk.release, ("VENDOR rewrite\n",))

    def test_when_rederived_from_same_anchors_then_candidate_is_byte_identical(self) -> None:
        first = self._resolve(resolve_gaps=True)
        second = self._resolve(resolve_gaps=True)

        self.assertEqual(first.candidate_text, second.candidate_text)
        self.assertEqual(first.verdict, second.verdict)

    def test_when_policy_off_then_output_matches_the_reporting_default(self) -> None:
        res = self._resolve(resolve_gaps=False)

        self.assertEqual(res.verdict, em.MERGE_CONFLICT)
        self.assertTrue(res.has_conflict)
        self.assertTrue(em.has_conflict_markers(res.candidate_text))
        self.assertIn("LOCAL rewrite", res.candidate_text)
        # Report-only asks for no judgment: the marker block IS the report.
        self.assertEqual(res.regions[0].requests, ())

    def test_when_no_mode_named_then_the_default_arbitrates(self) -> None:
        # The mode selector is the parameter alone. Nothing in the environment can
        # reach it, so the retired switch is set here at its former OFF value and the
        # default must still arbitrate — the pin on resolving the mode in-library.
        prior = os.environ.get("ATRIUM_UPDATE_MERGE_RESOLVE_GAPS")
        try:
            os.environ["ATRIUM_UPDATE_MERGE_RESOLVE_GAPS"] = "0"
            defaulted = self._resolve()
        finally:
            if prior is None:
                os.environ.pop("ATRIUM_UPDATE_MERGE_RESOLVE_GAPS", None)
            else:
                os.environ["ATRIUM_UPDATE_MERGE_RESOLVE_GAPS"] = prior

        self.assertEqual(defaulted.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertEqual(self._resolve(resolve_gaps=False).verdict, em.MERGE_CONFLICT)

    def test_when_arbitration_on_then_the_library_refuses_nothing_and_calls_no_gate(
        self,
    ) -> None:
        # A pending candidate carries no marker, so no library-side guard stops it:
        # the refusal is the updater's verdict routing and lives THERE alone, which
        # is why apply reports a no-op rather than the pre-write refusal a
        # marker-bearing candidate takes. The stub FAILS and counts its calls, so
        # verifying green proves the gate was never reached rather than agreed with.
        stub = _StubVerify(passed=False)
        cand = em.build_merge_candidate(
            "dev-android.md",
            self._LOCAL,
            self._RELEASE,
            base_text=self._BASE,
            verify_fn=stub,
            resolve_conflicting_gaps=True,
        )

        self.assertEqual(cand.resolution.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertFalse(cand.resolution.needs_llm)  # no merged wording to screen
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dev-android.md"
            target.write_text(self._LOCAL, encoding="utf-8")
            self.assertEqual(cand.apply(str(target)), em.APPLY_NOOP)
            self.assertEqual(cand.verify(str(target)), 0)
            self.assertEqual(stub.calls, 0)  # the gate was never reached
            self.assertFalse(
                em.has_conflict_markers(target.read_text(encoding="utf-8"))
            )

    def test_when_gap_is_non_conflicting_then_no_hunk_and_release_lands(self) -> None:
        base, local, release = ["A\n"], ["A\n"], ["R\n"]

        merged, hunks = em.three_way_merge_hunks(base, local, release, arbitrate=True)

        self.assertEqual(hunks, [])
        self.assertEqual(merged, ["R\n"])

    def test_when_region_has_many_conflicting_gaps_then_one_hunk_each_in_order(self) -> None:
        base = ["A\n", "s\n", "B\n"]
        local = ["LA\n", "s\n", "LB\n"]
        release = ["RA\n", "s\n", "RB\n"]

        merged, hunks = em.three_way_merge_hunks(base, local, release, arbitrate=True)

        self.assertEqual(merged, ["LA\n", "s\n", "LB\n"])
        self.assertEqual([h.local for h in hunks], [("LA\n",), ("LB\n",)])
        self.assertEqual([h.out_index for h in hunks], [0, 2])

    def test_when_gap_is_clean_beside_a_conflicting_one_then_it_is_untouched(self) -> None:
        base = ["A\n", "s\n", "B\n"]
        local = ["LOCAL1\n", "s\n", "B\n"]
        release = ["REL1\n", "s\n", "B-REL\n"]

        merged, hunks = em.three_way_merge_hunks(base, local, release, arbitrate=True)

        self.assertEqual(len(hunks), 1)
        self.assertEqual(merged, ["LOCAL1\n", "s\n", "B-REL\n"])


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ResolvedGapStatsTest(unittest.TestCase):
    """The richer-local fixture: two local lines against one release line.

    It is the shape that shows a whole-side rule discarding content, so it drives
    both what a contested gap asks for and what the recording caller reads back
    from a resolution that discarded nothing.
    """

    _BASE = _doc(top="# A", region="same-old", bottom="z")
    _LOCAL = _doc(top="# A", region="LOCAL one\nLOCAL two", bottom="z")
    _RELEASE = _doc(top="# A", region="VENDOR rewrite", bottom="z")

    def _resolve(self, release: str) -> em.FileResolution:
        """The class fixtures with the policy ON; the release side is the variable."""
        return em.resolve_file(
            "dev-android.md",
            self._LOCAL,
            release,
            self._BASE,
            resolve_conflicting_gaps=True,
        )

    def test_when_the_gap_is_contested_then_one_request_names_it_and_no_side_wins(
        self,
    ) -> None:
        res = self._resolve(self._RELEASE)

        (request,) = res.regions[0].requests
        self.assertEqual(request.region_index, 0)
        self.assertEqual(request.gap.base, ("same-old\n",))
        self.assertEqual(request.gap.local, ("LOCAL one\n", "LOCAL two\n"))
        self.assertEqual(request.gap.release, ("VENDOR rewrite\n",))
        # The judge reads the gap inside the region the candidate is assembled
        # from, so the context is the release side's region content.
        self.assertEqual(request.context, ("VENDOR rewrite\n",))
        self.assertNotIn("VENDOR rewrite", res.candidate_text)

    def test_when_the_gap_is_contested_then_no_gap_counts_as_resolved(self) -> None:
        """The recording caller's counts describe a discard; a pending gap discards
        nothing, so it contributes none."""
        res = self._resolve(self._RELEASE)

        stats = em.resolved_gap_stats(res)
        self.assertEqual(stats["hunks"], 0)
        self.assertEqual(stats["regions"], "")

    def test_when_a_region_resolved_to_release_then_stats_count_both_line_sides(
        self,
    ) -> None:
        """The counting shape itself, driven over a resolution built to carry it."""
        hunk = em.ConflictHunk(
            out_index=0,
            base=("same-old\n",),
            local=("LOCAL one\n", "LOCAL two\n"),
            release=("VENDOR rewrite\n",),
        )
        resolution = em.FileResolution(
            target_file="dev-android.md",
            verdict=em.MERGE_ARBITER_RESOLVED,
            candidate_text="",
            local_text="",
            regions=[
                em.RegionResolution(
                    0,
                    em.MERGE_ARBITER_RESOLVED,
                    list(hunk.release),
                    hunks=(hunk,),
                    decisions=(em.GapOutcome(hunk.release, "RELEASE", "fixture"),),
                )
            ],
        )

        stats = em.resolved_gap_stats(resolution)
        self.assertEqual(stats["hunks"], 1)
        self.assertEqual(stats["dropped_lines"], 2)
        self.assertEqual(stats["added_lines"], 1)
        self.assertEqual(stats["regions"], "0")

    def test_when_a_clean_region_accompanies_a_contested_gap_then_needs_llm_is_true(
        self,
    ) -> None:
        """The mixed file: a contested gap does not suppress the file-level gate.

        Every other contested-gap fixture is single-region, so needs_llm is False
        throughout and a reader could take the pending verdict to mean the file
        needs no model. A production body carries several EDITABLE regions: one
        contested gap beside one both-changed region reports the pending verdict
        for the file while the both-changed region still requires the Haiku
        improvement-verify gate. The updater keys its provenance fields on this
        flag, so the two facts are independent and both are read.
        """
        two_region = (
            "# T\n<!-- EDITABLE:BEGIN -->\n{r0}\n<!-- EDITABLE:END -->\n"
            "mid\n<!-- EDITABLE:BEGIN -->\n{r1}\n<!-- EDITABLE:END -->\ntail\n"
        )
        # Region 0: both sides changed, non-overlapping -> merge-clean (LLM-required).
        # Region 1: both sides changed the SAME lines -> the conflicting gap.
        base = two_region.format(r0="a1\na2\na3\na4\na5\na6\na7\na8", r1="same-old")
        local = two_region.format(
            r0="LOCAL\na2\na3\na4\na5\na6\na7\na8", r1="LOCAL one\nLOCAL two"
        )
        release = two_region.format(
            r0="a1\na2\na3\na4\na5\na6\na7\nVENDOR", r1="VENDOR rewrite"
        )

        res = em.resolve_file(
            "dev-android.md", local, release, base, resolve_conflicting_gaps=True
        )

        self.assertEqual(
            [r.verdict for r in res.regions],
            [em.MERGE_CLEAN, em.MERGE_PENDING_ARBITRATION],
        )
        self.assertEqual(res.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertTrue(res.needs_llm)

    def test_when_no_gap_resolved_then_stats_are_zero_and_regions_empty(self) -> None:
        res = self._resolve(self._LOCAL)

        stats = em.resolved_gap_stats(res)
        self.assertEqual(stats["hunks"], 0)
        self.assertEqual(stats["dropped_lines"], 0)
        self.assertEqual(stats["added_lines"], 0)
        # No resolved region, no index list — the updater's extractor reads an
        # empty value as empty now that it guards on the key being present.
        self.assertEqual(stats["regions"], "")
        # An unchanged region asks for no judgment, so the arbitration channel is
        # empty alongside the stats.
        self.assertEqual([r.requests for r in res.regions], [()])

    def test_when_plan_runs_on_a_contested_file_then_it_reports_no_drop(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "local.md").write_text(self._LOCAL, encoding="utf-8")
            (root / "release.md").write_text(self._RELEASE, encoding="utf-8")
            (root / "base.md").write_text(self._BASE, encoding="utf-8")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), _stub_model():
                rc = em.main(
                    [
                        "plan",
                        "--target",
                        "agents/dev-android.md",
                        "--local",
                        str(root / "local.md"),
                        "--release",
                        str(root / "release.md"),
                        "--base",
                        str(root / "base.md"),
                        "--out",
                        str(root / "cand.md"),
                        "--agent",
                        "dev-android",
                        "--state-dir",
                        str(root / "state"),
                    ]
                )

            # The sidecar exists to hand the recording caller text that a gap
            # discarded. This answer re-emits the local lines, so writing one
            # would offer lines that are still in the body as if they were gone.
            sidecar_written = (root / "cand.md.dropped").exists()

        self.assertEqual(rc, em.EXIT_OK)
        self.assertFalse(sidecar_written)
        line = buf.getvalue()
        # The gap WAS answered, so the file is arbiter-resolved and counted —
        # what the answer chose is what makes the two line counts zero.
        self.assertIn(f"verdict={em.MERGE_ARBITER_RESOLVED} ", line)
        self.assertIn("resolved_hunks=1 ", line)
        self.assertIn("resolved_dropped_lines=0 ", line)
        self.assertIn("resolved_added_lines=0 ", line)
        self.assertIn("resolved_regions=0 ", line)

    def test_when_diff_out_given_then_it_holds_the_libs_own_diff(self) -> None:
        # The recording caller reads THIS file rather than shelling out to
        # `diff -u`: one diff implementation in the loop, and the text is the one
        # the candidate was validated against.
        #
        # The release also revises prose OUTSIDE the region, which is what makes
        # the candidate differ from the local body at all: the contested gap keeps
        # the local side, so a release confined to the region would diff to
        # nothing and the comparison would hold vacuously.
        release = _doc(top="# A", region="VENDOR rewrite", bottom="z revised")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "local.md").write_text(self._LOCAL, encoding="utf-8")
            (root / "release.md").write_text(release, encoding="utf-8")
            (root / "base.md").write_text(self._BASE, encoding="utf-8")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), _stub_model():
                rc = em.main(
                    [
                        "plan",
                        "--target",
                        "agents/dev-android.md",
                        "--local",
                        str(root / "local.md"),
                        "--release",
                        str(root / "release.md"),
                        "--base",
                        str(root / "base.md"),
                        "--out",
                        str(root / "cand.md"),
                        "--diff-out",
                        str(root / "cand.diff"),
                        "--agent",
                        "dev-android",
                        "--state-dir",
                        str(root / "state"),
                    ]
                )
            written = (root / "cand.diff").read_text(encoding="utf-8")
            expected = em.build_merge_candidate(
                "agents/dev-android.md",
                self._LOCAL,
                release,
                base_text=self._BASE,
                skip_pre_verify=True,
                arbiter_mode=em.ARBITER_REPLAY,
                state_dir=str(root / "state"),
            ).diff

        self.assertEqual(rc, em.EXIT_OK)
        self.assertEqual(written, expected)
        self.assertIn("--- a/agents/dev-android.md", written)


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
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


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ContestedRegionKeepsLivePinsTest(unittest.TestCase):
    """The union behavior NEITHER phase has alone: a live pin on a WRITABLE conflict.

    The frontmatter carry and the region resolution are separate steps, and the
    carry is only proven once a pin survives the write rather than the assembly.
    A contested region is what puts both in one candidate: it is marker-free, so
    apply accepts it, and the pin has to ride the release skeleton's frontmatter
    the whole way to disk.
    """

    _TOOLS = "name: glass-atrium-dev-python\ntools: Read, Write\n"

    def _body(self, frontmatter: str, region: str) -> str:
        return _doc(
            top=f"---\n{frontmatter}---\n\n# Agent",
            region=region,
            bottom="tail",
        )

    def _anchors(self, *, release_effort: str | None) -> tuple[str, str, str]:
        """base / local / release, conflicting in the region, pinned locally."""
        release_fm = self._TOOLS + (
            f"effort: {release_effort}\n" if release_effort else ""
        )
        return (
            self._body(f"{self._TOOLS}effort: high\n", "shared baseline rule"),
            self._body(
                f"{self._TOOLS}model: claude-opus-5\neffort: xhigh\n",
                "LOCAL daemon-learned rule",
            ),
            self._body(release_fm, "VENDOR revised rule"),
        )

    def test_both_pins_survive_a_pending_arbitration_write_on_disk(self) -> None:
        base, local, release = self._anchors(release_effort="max")
        stub = _StubVerify(passed=True)

        cand = em.build_merge_candidate(
            "dev-python.md",
            local,
            release,
            base_text=base,
            agent="dev-python",
            verify_fn=stub,
        )

        # Phase 1 half: the contested region emits no marker, so apply accepts it.
        self.assertEqual(cand.resolution.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertFalse(cand.resolution.has_conflict)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "dev-python.md"
            self.assertEqual(cand.apply(str(path)), em.APPLY_OK)
            self.assertEqual(cand.verify(str(path)), 0)
            landed = path.read_text(encoding="utf-8")

        # Phase 0 half: read back from DISK, not from the in-memory candidate — the
        # carry is only proven once it survives the write.
        self.assertIn("model: claude-opus-5\n", landed)  # live-only, live-wins
        self.assertIn("effort: xhigh\n", landed)  # base-aware pin, differs from base
        self.assertNotIn("effort: max\n", landed)  # the release value loses to the pin
        self.assertIn("LOCAL daemon-learned rule", landed)  # the gap chose no side
        self.assertNotIn("VENDOR revised rule", landed)

    def test_a_release_without_effort_still_lands_the_pin_unnamed(self) -> None:
        # The advisory must consult BOTH allowlists: effort is absent from the
        # release here, yet re-attaches by the base-aware live-wins fallback, so
        # naming it would report a drop that did not happen.
        base, local, release = self._anchors(release_effort=None)

        res = em.resolve_file("dev-python.md", local, release, base)

        self.assertEqual(res.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertIn("effort: xhigh\n", res.candidate_text)
        self.assertIn("model: claude-opus-5\n", res.candidate_text)
        self.assertEqual(
            em.dropped_local_frontmatter_keys(local, res.candidate_text), []
        )

    def test_in_report_only_mode_the_pin_path_is_unreachable(self) -> None:
        # The control the union rests on: in report-only mode this same file is a
        # marker-bearing report that apply refuses, so no pin can survive because
        # nothing is written at all.
        base, local, release = self._anchors(release_effort="max")

        cand = em.build_merge_candidate(
            "dev-python.md",
            local,
            release,
            base_text=base,
            agent="dev-python",
            verify_fn=_StubVerify(passed=True),
            resolve_conflicting_gaps=False,
        )

        self.assertEqual(cand.resolution.verdict, em.MERGE_CONFLICT)
        self.assertTrue(cand.resolution.has_conflict)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "dev-python.md"
            self.assertEqual(cand.apply(str(path)), em.APPLY_MALFORMED)
            self.assertFalse(path.exists())  # zero bytes written


@contextlib.contextmanager
def _stub_model(answer: str = "CHOICE: LOCAL\nRATIONALE: fixture"):
    """Pin the model seam in-process, so no drive can reach the headless CLI."""
    completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=answer, stderr="")
    with mock.patch.object(
        em.dc, "_invoke_haiku_cli", return_value=(completed, None, None)
    ) as seam:
        yield seam


# A stub whose SECOND arbiter invocation answers differently from its first: the
# record is what must make that difference unobservable. One binary now serves
# BOTH model seams — the arbiter and the compliance gate the resolved verdict
# pulls in — so it routes on the answer format each prompt asks for and counts
# them apart. A gate call answered with an arbiter answer would fail the axes and
# veto the transaction, which is how a mis-routed prompt shows up.
_TWO_ANSWER_STUB = """#!/bin/sh
case "$*" in
  *"CHOICE: LOCAL|RELEASE|INTERLEAVE"*)
    n=0
    if [ -s "$ARB_STUB_COUNT" ]; then n=$(wc -c < "$ARB_STUB_COUNT"); fi
    printf 'x' >> "$ARB_STUB_COUNT"
    if [ "$n" -eq 0 ]; then printf '%s\\n' "$ARB_STUB_ANSWER1"; else printf '%s\\n' "$ARB_STUB_ANSWER2"; fi
    ;;
  *)
    printf 'x' >> "$ARB_STUB_GATE_COUNT"
    printf 'C1: PASS\\nC2: PASS\\nC3: PASS\\nC4: PASS\\nVERDICT: verified\\nRATIONALE: stub\\n'
    ;;
esac
"""


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ArbiterRecordReplayTest(unittest.TestCase):
    """The per-gap decision is derived once, recorded, and replayed (A2b).

    The contested fixture's two novel lines make an interleave the answer the
    five clauses admit, so a replay that fell back to either whole side — or
    re-derived through a stub that has changed its mind — is visible in the
    candidate bytes rather than only in an internal flag.
    """

    _BASE = _doc(top="# A", region="same-old", bottom="z")
    _LOCAL = _doc(top="# A", region="LOCAL rewrite", bottom="z")
    _RELEASE = _doc(top="# A", region="VENDOR rewrite", bottom="z")
    _TARGET = "dev-android.md"
    _INTERLEAVE = "CHOICE: INTERLEAVE\nLINES: L1, R1\nRATIONALE: independent edits"

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / "state"
        store = em.base_store_dir(str(self.state))
        store.mkdir(parents=True)
        (store / self._TARGET).write_text(self._BASE, encoding="utf-8")
        self.local_p = self.root / "local.md"
        self.local_p.write_text(self._LOCAL, encoding="utf-8")
        self.release_p = self.root / "release.md"
        self.release_p.write_text(self._RELEASE, encoding="utf-8")
        self.record_dir = em.arbiter_record_dir(str(self.state))
        self.record_path = self.record_dir / em.build_gap_key(self._TARGET, 0, 0)

    # -- helpers -------------------------------------------------------------

    def _plan(self, answer: str = None) -> em.MergeCandidate:
        """Derive in-process under the plan mode, with the seam stubbed."""
        with _stub_model(answer or self._INTERLEAVE):
            return em.build_merge_candidate(
                self._TARGET,
                self._LOCAL,
                self._RELEASE,
                base_text=self._BASE,
                agent="dev-android",
                arbiter_mode=em.ARBITER_PLAN,
                state_dir=str(self.state),
            )

    def _replay(self) -> tuple[em.MergeCandidate, str]:
        """Replay in the default mode, with the model seam armed to fail loudly."""
        err = io.StringIO()
        with contextlib.redirect_stderr(err), mock.patch.object(
            em.dc,
            "_invoke_haiku_cli",
            side_effect=AssertionError("the replay reached the model seam"),
        ):
            cand = em.build_merge_candidate(
                self._TARGET,
                self._LOCAL,
                self._RELEASE,
                base_text=self._BASE,
                agent="dev-android",
                state_dir=str(self.state),
            )
        return cand, err.getvalue()

    # -- the record ----------------------------------------------------------

    def test_when_plan_derives_then_the_record_names_lines_and_carries_no_text(
        self,
    ) -> None:
        self._plan()

        record = json.loads(self.record_path.read_text(encoding="utf-8"))
        self.assertEqual(record["choice"], "INTERLEAVE")
        self.assertEqual(record["refs"], ["L1", "R1"])
        self.assertEqual(set(record["fingerprints"]), {"base", "local", "release"})
        body = self.record_path.read_text(encoding="utf-8")
        for anchor in ("same-old", "LOCAL rewrite", "VENDOR rewrite"):
            self.assertNotIn(anchor, body)

    def test_when_the_gap_falls_to_the_ladder_then_its_class_is_recorded(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            cand = self._plan(answer="not an answer at all")

        record = json.loads(self.record_path.read_text(encoding="utf-8"))
        self.assertIsNone(record["choice"])
        self.assertEqual(record["failure_class"], "unparseable-answer")
        self.assertEqual(cand.resolution.candidate_text, self._LOCAL)

    # -- the replay ----------------------------------------------------------

    def test_when_replayed_then_the_candidate_is_the_derived_one_and_no_model_runs(
        self,
    ) -> None:
        planned = self._plan()

        replayed, rows = self._replay()

        self.assertIn("LOCAL rewrite", planned.resolution.candidate_text)
        self.assertIn("VENDOR rewrite", planned.resolution.candidate_text)
        self.assertEqual(
            replayed.resolution.candidate_text, planned.resolution.candidate_text
        )
        self.assertEqual(rows, "")

    def test_when_a_fingerprint_is_corrupted_then_the_gap_falls_closed_to_local(
        self,
    ) -> None:
        self._plan()
        record = json.loads(self.record_path.read_text(encoding="utf-8"))
        record["fingerprints"]["local"] = "0" * 64
        self.record_path.write_text(json.dumps(record), encoding="utf-8")

        replayed, rows = self._replay()

        self.assertEqual(replayed.resolution.candidate_text, self._LOCAL)
        self.assertIn("record-fingerprint-mismatch", rows)
        self.assertIn("agent=dev-android", rows)

    def test_when_no_record_exists_then_the_gap_keeps_local_with_a_named_row(
        self,
    ) -> None:
        replayed, rows = self._replay()

        self.assertFalse(self.record_path.exists())
        self.assertEqual(replayed.resolution.candidate_text, self._LOCAL)
        self.assertIn("record-absent", rows)

    def test_when_the_reference_list_is_malformed_then_the_gap_keeps_local(
        self,
    ) -> None:
        self._plan()
        record = json.loads(self.record_path.read_text(encoding="utf-8"))
        record["refs"] = ["L1", "R9"]  # R9 resolves to no release line
        self.record_path.write_text(json.dumps(record), encoding="utf-8")

        replayed, rows = self._replay()

        self.assertEqual(replayed.resolution.candidate_text, self._LOCAL)
        self.assertIn("record-malformed", rows)

    # -- the two-process path ------------------------------------------------

    def _write_two_answer_stub(self) -> dict[str, str]:
        stub = self.root / "claude-stub"
        stub.write_text(_TWO_ANSWER_STUB, encoding="utf-8")
        stub.chmod(0o755)
        return {
            **os.environ,
            # What the updater's own run exports: the plan option and the
            # environment leg carry the SAME root, which is how the verify
            # process — handed the state dir for the base store alone — reaches
            # the record directory without a second argv slot.
            em._STATE_DIR_ENV: str(self.state),
            "AUTOAGENT_CLAUDE_BIN": str(stub),
            "ARB_STUB_COUNT": str(self.root / "count"),
            "ARB_STUB_GATE_COUNT": str(self.root / "gate-count"),
            "ARB_STUB_ANSWER1": self._INTERLEAVE,
            "ARB_STUB_ANSWER2": "CHOICE: RELEASE\nRATIONALE: a different mind",
        }

    def test_when_the_stub_changes_its_answer_then_the_verify_process_is_unmoved(
        self,
    ) -> None:
        """The acceptance drive: two real processes, one invocation between them.

        The verify process is launched with exactly the eight arguments the
        updater's own callback passes — read out of ``scripts/update.sh`` rather
        than paraphrased — so the candidate path it never receives cannot leak
        in, and the scratch directory holding that candidate is removed before
        it runs.
        """
        env = self._write_two_answer_stub()
        scratch = self.root / "scratch"
        scratch.mkdir()
        candidate = scratch / "cand.md"

        plan = subprocess.run(
            [
                sys.executable,
                str(_REPO_ROOT / "autoagent" / "lib" / "editable_merge.py"),
                "plan",
                "--target", self._TARGET,
                "--local", str(self.local_p),
                "--release", str(self.release_p),
                "--out", str(candidate),
                "--agent", "dev-android",
                "--state-dir", str(self.state),
            ],
            capture_output=True, text=True, env=env, check=False,
        )
        self.assertEqual(plan.returncode, em.EXIT_OK, plan.stderr)
        planned_text = candidate.read_text(encoding="utf-8")
        live = self.root / self._TARGET
        live.write_text(planned_text, encoding="utf-8")
        shutil.rmtree(scratch)

        verify = subprocess.run(
            [
                sys.executable, "-c", _get_verify_shell_out(),
                str(_REPO_ROOT / "autoagent" / "lib"),
                self._TARGET,
                str(self.local_p),
                str(self.release_p),
                "",
                "dev-android",
                str(self.state),
                str(live),
            ],
            capture_output=True, text=True, env=env, check=False,
        )

        self.assertIn("LOCAL rewrite", planned_text)
        self.assertIn("VENDOR rewrite", planned_text)  # the first answer landed
        self.assertTrue(self.record_path.is_file())  # outlived the scratch dir
        self.assertEqual(verify.returncode, 0, verify.stderr)
        self.assertEqual(
            (self.root / "count").read_text(encoding="utf-8"),
            "x",  # one ARBITER invocation across BOTH processes
        )
        # The verify process makes the one model call A6 adds: the compliance
        # gate over the candidate. It is a different seam from the arbiter, so
        # the two counters move independently.
        self.assertEqual(
            (self.root / "gate-count").read_text(encoding="utf-8"), "x"
        )
        self.assertNotIn("record-", verify.stderr)

    # -- the seam the two modules share --------------------------------------

    def test_when_two_targets_sanitise_alike_then_their_keys_still_differ(self) -> None:
        collide = ("agents/dev-x.md", "agents_dev-x.md")

        keys = [em.build_gap_key(target, 0, 0) for target in collide]

        self.assertEqual(*(re.sub(r"-[0-9a-f]{12}\.", ".", key) for key in keys))
        self.assertNotEqual(*keys)

    def test_when_the_arbiter_is_unreachable_then_the_gap_keeps_local_with_a_row(
        self,
    ) -> None:
        """Both unreachable arms: the import fails, and the judge itself raises."""
        import gap_arbiter as ga

        arms = (
            mock.patch.dict(sys.modules, {"gap_arbiter": None}),
            mock.patch.object(ga, "get_decision", side_effect=RuntimeError("judge")),
        )
        for arm in arms:
            with self.subTest(arm=arm), arm:
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    cand = em.build_merge_candidate(
                        self._TARGET,
                        self._LOCAL,
                        self._RELEASE,
                        base_text=self._BASE,
                        agent="dev-android",
                        arbiter_mode=em.ARBITER_PLAN,
                        state_dir=str(self.state),
                    )

                self.assertEqual(cand.resolution.candidate_text, self._LOCAL)
                self.assertIn("arbiter-unreachable", err.getvalue())

    def test_when_a_recorded_choice_is_unknown_then_the_gap_keeps_local(self) -> None:
        self._plan()
        record = json.loads(self.record_path.read_text(encoding="utf-8"))
        record["choice"] = "BOTH"
        self.record_path.write_text(json.dumps(record), encoding="utf-8")

        replayed, rows = self._replay()

        self.assertEqual(replayed.resolution.candidate_text, self._LOCAL)
        self.assertIn("record-malformed", rows)

    def test_when_the_same_gap_is_derived_twice_then_one_record_holds_it(self) -> None:
        self._plan()
        self._plan()

        self.assertEqual([p.name for p in self.record_dir.glob("*.json")],
                         [self.record_path.name])

    def test_when_a_region_holds_two_gaps_then_each_lands_where_it_was_recorded(
        self,
    ) -> None:
        """The splice: two gaps in one region, resolved forward, spliced backward.

        A back-to-front splice is what keeps the first gap's replacement from
        moving the index the second one recorded, and the resolution order is
        what decides which gap a per-run ceiling would cut.
        """
        import gap_arbiter as ga

        base = _doc(top="# A", region="A\ns\nB", bottom="z")
        local = _doc(top="# A", region="LA\ns\nLB", bottom="z")
        release = _doc(top="# A", region="RA\ns\nRB", bottom="z")
        seen: list[tuple[str, ...]] = []

        def _interleave(request, **_kwargs):
            seen.append(request.local_lines)
            return ga.Decision(
                lines=request.local_lines + request.release_lines,
                choice="INTERLEAVE",
                rationale="both edits stand",
                failure_class=None,
                clause=None,
                discarded_novel=0,
                rejected_stale=0,
                row="",
                refs=(ga.LineRef("L", 1), ga.LineRef("R", 1)),
            )

        with mock.patch.object(ga, "get_decision", side_effect=_interleave):
            planned = em.build_merge_candidate(
                self._TARGET, local, release,
                base_text=base, agent="dev-android",
                arbiter_mode=em.ARBITER_PLAN, state_dir=str(self.state),
            )
        with mock.patch.object(
            ga, "get_decision", side_effect=AssertionError("replay derived again")
        ):
            replayed = em.build_merge_candidate(
                self._TARGET, local, release,
                base_text=base, agent="dev-android", state_dir=str(self.state),
            )

        self.assertEqual(seen, [("LA\n",), ("LB\n",)])  # document order
        self.assertIn("LA\nRA\ns\nLB\nRB\n", planned.resolution.candidate_text)
        self.assertEqual(
            replayed.resolution.candidate_text, planned.resolution.candidate_text
        )

    def test_the_state_root_precedence_matches_the_spines(self) -> None:
        """Argument, then environment, then the home default — the spine's order.

        A plan process is handed the root as an argument and a verify process
        derives it from the environment; they land on the same directory only
        while this order is the one ``spine_baseline_dir`` uses.
        """
        with mock.patch.dict(os.environ, {em._STATE_DIR_ENV: "/env/root"}):
            self.assertEqual(em.state_root("/arg/root"), "/arg/root")
            self.assertEqual(em.state_root(), "/env/root")
            self.assertEqual(
                em.arbiter_record_dir(), Path("/env/root/arbiter-decisions")
            )
        with mock.patch.dict(os.environ, {em._STATE_DIR_ENV: ""}):
            self.assertEqual(
                em.state_root(), str(Path.home() / ".claude" / "data" / "update")
            )
        self.assertEqual(
            em.arbiter_record_dir("/arg/root").parent,
            em.base_store_dir("/arg/root").parent,
        )

    def test_the_replay_tokens_match_the_arbiter_answer_contract(self) -> None:
        import gap_arbiter as ga

        self.assertEqual(em._ARBITER_CHOICES, ga.CHOICES)

    def test_the_verify_shell_out_reaches_no_arbiter_module(self) -> None:
        shell_out = _get_verify_shell_out()

        self.assertIn("build_merge_candidate", shell_out)
        self.assertNotIn("gap_arbiter", shell_out)
        self.assertNotIn("get_decision", shell_out)

    def test_when_a_record_ages_past_retention_then_the_next_write_prunes_it(
        self,
    ) -> None:
        self.record_dir.mkdir(parents=True)
        stale = self.record_dir / "stale-000000000000.r0.g0.json"
        stale.write_text("{}", encoding="utf-8")
        aged = time.time() - (em._ARBITER_RETENTION_DAYS + 1) * 86400
        os.utime(stale, (aged, aged))

        self._plan()

        self.assertFalse(stale.exists())
        self.assertTrue(self.record_path.is_file())


@unittest.skipIf(em is None, f"editable_merge import failed: {_IMPORT_ERROR}")
class ArbiterResolvedGateTest(unittest.TestCase):
    """A6: the answered gap is the candidate class the compliance gate reads.

    The two rungs below differ in ONE input — whether the arbiter reached an
    answer — so the call counter reports the verdict's coupling rather than a
    property of the fixture.
    """

    _BASE = _doc(top="# A", region="same-old", bottom="z")
    _LOCAL = _doc(top="# A", region="LOCAL rewrite", bottom="z")
    _RELEASE = _doc(top="# A", region="VENDOR rewrite", bottom="z")
    _ANSWER = "CHOICE: RELEASE\nRATIONALE: fixture"

    class _GateResult:
        """The duck-typed shape the gate reads off its verifier."""

        def __init__(self, passed: bool) -> None:
            self.passed = passed
            self.axes: dict[str, bool] = {}
            self.status = "ok"
            self.rationale = "fixture"

    def _drive(self, answer: str, *, passed: bool = True):
        """Resolve, apply and verify one contested file against a counting gate."""
        calls: list[object] = []

        def verify_fn(patch, pattern, skip_pre_verify=False):  # noqa: ARG001
            calls.append(patch)
            return self._GateResult(passed)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            live = root / "dev-android.md"
            live.write_text(self._LOCAL, encoding="utf-8")
            with _stub_model(answer):
                cand = em.build_merge_candidate(
                    "agents/dev-android.md",
                    self._LOCAL,
                    self._RELEASE,
                    base_text=self._BASE,
                    agent="dev-android",
                    verify_fn=verify_fn,
                    arbiter_mode=em.ARBITER_PLAN,
                    state_dir=str(root / "state"),
                )
            applied = cand.apply(str(live))
            gate = cand.verify(str(live))
            return cand, calls, applied, gate

    def test_when_the_gap_is_answered_then_the_gate_runs_exactly_once(self) -> None:
        cand, calls, applied, gate = self._drive(self._ANSWER)

        self.assertEqual(cand.resolution.verdict, em.MERGE_ARBITER_RESOLVED)
        self.assertTrue(cand.resolution.needs_llm)
        self.assertEqual(applied, em.APPLY_OK)
        self.assertEqual(gate, 0)
        self.assertEqual(len(calls), 1)

    def test_when_no_answer_is_reached_then_the_gate_never_runs(self) -> None:
        """The arbiter-unavailable rung — the shape every contested file had
        before A6, and the live one while the model CLI is exhausted."""
        cand, calls, applied, gate = self._drive("not an answer")

        self.assertEqual(cand.resolution.verdict, em.MERGE_PENDING_ARBITRATION)
        self.assertFalse(cand.resolution.needs_llm)
        self.assertEqual(calls, [])

    def test_when_the_gate_vetoes_then_the_candidate_fails_its_transaction(
        self,
    ) -> None:
        """A veto is a transaction failure, which is what returns the target to
        its before-image — the restore itself is driven over the real
        transaction by "T19: a failed per-file transaction summarizes as
        rolled-back/unapplied" in scripts/test/glass-atrium-update.bats."""
        cand, calls, applied, gate = self._drive(self._ANSWER, passed=False)

        self.assertEqual(len(calls), 1)
        self.assertEqual(gate, 1)


def _get_verify_shell_out() -> str:
    """Read the updater's verify shell-out source, the text the callback runs."""
    text = (_REPO_ROOT / "scripts" / "update.sh").read_text(encoding="utf-8")
    match = re.search(r"_UPDATE_VERIFY_PY='\n(.*?)\n'\n", text, re.DOTALL)
    assert match is not None, "the verify shell-out constant moved"
    return match.group(1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
