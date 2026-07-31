#!/usr/bin/env python3
# S1 (clauded-docs/762) — the add-only rebuild sites must REFUSE a replace-shaped
# diff instead of rebuilding it from its added lines alone. Three sites shared the
# defect: the normalization fallback, the F2 gate's full rebuild, and the stale
# re-derivation. Each returned a pure append, so the removal the patch was written
# to make became an absence nobody reads — on a loop that writes live agent bodies
# unattended. The pure-removal generation path is deliberately untouched: it already
# rejects visibly.
#
# Every fixture below is a REAL stored proposal diff, frozen verbatim, and every
# site binding was taken from an observed run rather than from the code's shape.
# Tests are database-free and run against a temporary git work tree — the agents-dir
# seam threaded through the gate is what makes the gate site hermetic at all.
#
# Run: python3 -m unittest autoagent.test.test_removal_discard_refusal
#   (or, from autoagent/test/) python3 -m unittest test_removal_discard_refusal

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

import daemon_cycle as dc  # noqa: E402 — autoagent dir prepended above

# -- Frozen fixtures --------------------------------------------------------
#
# Captured as stored in core.autoagent_proposals.proposed_diff, never tidied.
# Sibling task S4 consumes PROPOSAL_318_DIFF / PROPOSAL_314_DIFF from here.

# Proposal 318 — THE KEYSTONE. Recorded applied, targets the dev-db body, one
# removed line and two added lines. The removed line is truncated mid-token
# ("nee"), so it can never match any line in the target: applicability fails, a
# rebuild runs, and the removal is dropped. The live dev-db body today carries two
# budget-checkpointing bullets at two thresholds — neither the one this intended.
PROPOSAL_318_DIFF = """--- a/glass-atrium-dev-db.md
+++ b/glass-atrium-dev-db.md
@@ -90,5 +90,6 @@ - **Transactions**: PG Read Committed / MySQL Repeatable Read · Deadlock: consi
 ## Work Rules
 <!-- EDITABLE:BEGIN -->

 - Schema changes → **migration files** (no direct DDL)
-- **Budget checkpointing**: Estimate scope before starting (count migrations/DDL units); emit `[COMPLETION]: nee
+- **Budget checkpointing**: Estimate scope before starting; on budget approach (>70% spent) defer performance tuning — focus migration correctness only.
+- **Scope gate**: If request spans schema + index audit + optimization, partition at request-time — compound work must split before execution.
"""

# Proposal 314 — an APPLIED pure-removal diff. Removals already reach production
# without the repair path, which is why the refusal is scoped to the replace shape.
PROPOSAL_314_DIFF = """--- a/glass-atrium-qa-debugger.md
+++ b/glass-atrium-qa-debugger.md
@@ -40,6 +40,4 @@
 - **Systemic-gap escalation**: a root cause recurring across recent investigations of the same upstream agent → surface in the conclusion as ONE systemic guardrail recommendation (e.g., "add X to dev-nestjs guardrails"), not N isolated diagnoses.
-- **Cycle 3 early checkpoint**: After cycle 3 completes, if budget ≥60% consumed, emit [COMPLETION] `needs_context` immediately (prioritize staying under budget over cycles 4–5 risk).
 - **Tested-hypothesis tracking**: Maintain an explicit list of tested hypotheses per cycle; never re-test a previously disproven hypothesis. Review prior-cycle findings before each technique selection.
-- **Budget-checkpoint at cycle 4**: After cycle 4 completes, if budget ≥70% consumed, emit [COMPLETION] `needs_context` instead of continuing — prioritize staying under budget over reaching the 5-cycle limit.
 - **Diagnosis specificity gate**: final conclusion MUST name file/module/function · exact behavior + line/region · concrete fix vector (recommendation phrasing OK); vague conclusions ("likely state issue") → rework before emission.
 - **Override: Absolute 45% Budget Checkpoint**: If `budget.remaining() / budget_baseline ≤ 0.45` after cycle ≥ 3, immediately emit [COMPLETION] `needs_context` with checkpoint payload — this overrides all cycle-count gates to prevent exhaustion.
"""

# Proposal 360 — a two-hunk pure-removal diff sitting in a rejected status. Status
# is not an assertion key here; the reject-arm criterion is keyed on the gate's
# RETURN VALUE.
PROPOSAL_360_DIFF = """--- a/glass-atrium-qa-debugger.md
+++ b/glass-atrium-qa-debugger.md
@@ -38,3 +38,2 @@
 - **Systemic-gap escalation**: a root cause recurring across recent investigations of the same upstream agent → surface in the conclusion as ONE systemic guardrail recommendation (e.g., "add X to dev-nestjs guardrails"), not N isolated diagnoses.
-- **Cycle 3 early checkpoint**: After cycle 3 completes, if budget ≥60% consumed, emit [COMPLETION] `needs_context` immediately (prioritize staying under budget over cycles 4–5 risk).
 - **Tested-hypothesis tracking**: Maintain an explicit list of tested hypotheses per cycle; never re-test a previously disproven hypothesis. Review prior-cycle findings before each technique selection.
@@ -41,3 +40,2 @@
 - **Tested-hypothesis tracking**: Maintain an explicit list of tested hypotheses per cycle; never re-test a previously disproven hypothesis. Review prior-cycle findings before each technique selection.
-- **Budget-checkpoint at cycle 4**: After cycle 4 completes, if budget ≥70% consumed, emit [COMPLETION] `needs_context` instead of continuing — prioritize staying under budget over reaching the 5-cycle limit.
 - **Diagnosis specificity gate**: final conclusion MUST name file/module/function · exact behavior + line/region · concrete fix vector (recommendation phrasing OK); vague conclusions ("likely state issue") → rework before emission.
"""

# The Work Rules region of the LIVE dev-db body, captured verbatim. It is the
# landed artifact of the 318 conversion: two budget-checkpointing bullets at 65%
# and 60%, and no trace of the 70% the proposal meant to leave.
DEV_DB_WORK_RULES = """
## Work Rules
<!-- EDITABLE:BEGIN -->

- Schema changes → **migration files** (no direct DDL)
  Checkpoint after each migration file or EXPLAIN ANALYZE pass; if scope expands mid-task → emit `[COMPLETION]: needs_context` to split.
- **Scope gate**: Multi-migration (>2 files) + complex EXPLAIN (>10M rows) requires upfront confirmation; never pack in one delegation.
- **Budget checkpointing**: Estimate scope before starting (count migrations/DDL units); emit `[COMPLETION]: needs_context` gracefully when approaching 65% of maxTurns.
- **Schema targeted reading**: For schema.prisma > 200 lines, Grep specific tables/columns first; load full schema only after scoping to relevant sections to reduce context bloat
- **Checkpoint compound work**: On tasks combining schema analysis + optimization + migration, emit [COMPLETION] checkpoint after each major phase to preserve progress within turns limit
- Large data → **batch** + progress tracking
- Queries → **explicit SELECT fields** (no SELECT *)
- **Batch verification checks**: Group FK impact, index impact, reverse-rename validation, and schema drift detection into single schema-inspection pass per task to stay within budget
- **Budget checkpointing**: Estimate scope before starting (count migrations/DDL units). On ≥60% budget usage, emit `[COMPLETION]: needs_context` with checkpoint summary.
- **Pre-work scope verification**: Before writing DDL/migrations, list affected tables and unit count. If >5 tables or >10 units, request orchestrator scope split.
- **Comments/Logs**: SQL `--` / Prisma `///` why-only (no restating DDL) · TODO(owner/TICKET) format · Migration intent commented (purpose + rollback note) · No stale comments referencing dropped columns
<!-- EDITABLE:END -->
"""

# THE REGRESSION WITNESS. Observed output of `_rederive_diff_against_file` at
# f5c4883 for PROPOSAL_318_DIFF against DEV_DB_WORK_RULES: a pure append at a
# shifted hunk header, both added bullets landed at the end of the editable
# region, the removal gone. Frozen so the fix is measured against a recorded
# observation rather than against a description of one.
HEAD_318_REDERIVE_APPEND = """--- a/glass-atrium-dev-db.md
+++ b/glass-atrium-dev-db.md
@@ -16,4 +16,6 @@
 - **Budget checkpointing**: Estimate scope before starting (count migrations/DDL units). On ≥60% budget usage, emit `[COMPLETION]: needs_context` with checkpoint summary.
 - **Pre-work scope verification**: Before writing DDL/migrations, list affected tables and unit count. If >5 tables or >10 units, request orchestrator scope split.
 - **Comments/Logs**: SQL `--` / Prisma `///` why-only (no restating DDL) · TODO(owner/TICKET) format · Migration intent commented (purpose + rollback note) · No stale comments referencing dropped columns
+- **Budget checkpointing**: Estimate scope before starting; on budget approach (>70% spent) defer performance tuning — focus migration correctness only.
+- **Scope gate**: If request spans schema + index audit + optimization, partition at request-time — compound work must split before execution.
 <!-- EDITABLE:END -->
"""

# A header-less replace fragment — the ONLY shape that reaches the normalization
# fallback, since a fragment carrying headers with valid counts returns early.
HEADERLESS_REPLACE_FRAGMENT = (
    "- **Scope gate**: Multi-migration (>2 files) + complex EXPLAIN (>10M rows) "
    "requires upfront confirmation; never pack in one delegation.\n"
    "+- **Scope gate**: rewritten in place\n"
)

# A replace diff whose @@ header cannot be parsed OR recounted, so the F2 gate
# falls past its recount step into the full rebuild. A genuine CONTENT conflict
# would not reach it — the gate treats that as parseable and returns first.
PARSER_REJECT_REPLACE_DIFF = (
    "--- a/glass-atrium-dev-db.md\n"
    "+++ b/glass-atrium-dev-db.md\n"
    "@@ -x,y +x,y @@\n"
    " - Schema changes → **migration files** (no direct DDL)\n"
    "-- **Scope gate**: Multi-migration (>2 files) + complex EXPLAIN (>10M rows) "
    "requires upfront confirmation; never pack in one delegation.\n"
    "+- **Scope gate**: rewritten in place\n"
)

ADD_ONLY_FRAGMENT = "+- **Retention window**: keep 14 days of migration artefacts\n"

_REFUSAL_MARKER = "REMOVAL REFUSAL"


def _write_work_tree(name: str, body: str) -> tuple[Path, Path]:
    """Create a committed temporary git work tree holding one agent body.

    Returns (work_tree_dir, target_file). The directory is a real git repo because
    the gate resolves its apply scope through `git rev-parse` — a bare temp dir
    would silently fall back to the operator's tree resolution.
    """
    work_tree = Path(tempfile.mkdtemp(prefix="s1-refusal-"))
    target = work_tree / name
    target.write_text(body, encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(work_tree)], check=True)
    subprocess.run(["git", "-C", str(work_tree), "add", "-A"], check=True)
    subprocess.run(
        [
            "git", "-C", str(work_tree),
            "-c", "user.email=s1@test", "-c", "user.name=s1",
            "commit", "-qm", "fixture",
        ],
        check=True,
    )
    return work_tree, target


def _capture(fn, *args, **kwargs) -> tuple[object, str]:
    """Run `fn`, returning (result, captured stderr)."""
    buf = io.StringIO()
    with redirect_stderr(buf):
        result = fn(*args, **kwargs)
    return result, buf.getvalue()


class _WorkTreeCase(unittest.TestCase):
    """Shared dev-db work tree — every test here is database-free and hermetic."""

    def setUp(self) -> None:
        self.work_tree, self.target = _write_work_tree(
            "glass-atrium-dev-db.md", DEV_DB_WORK_RULES
        )


class TestStaleRederivationRefusal(_WorkTreeCase):
    """The keystone site: the ONLY one observed to convert proposal 318."""

    def test_when_keystone_318_rederived_then_empty_not_append(self) -> None:
        result, err = _capture(
            dc._rederive_diff_against_file, PROPOSAL_318_DIFF, self.target
        )
        self.assertEqual(result, "")
        self.assertIn(_REFUSAL_MARKER, err)

    def test_when_head_witness_then_it_is_the_append_the_fix_prevents(self) -> None:
        # The witness is an append: two '+' lines, zero '-' lines, shifted header.
        witness_lines = HEAD_318_REDERIVE_APPEND.splitlines()
        removed = [
            ln for ln in witness_lines
            if ln.startswith("-") and not ln.startswith("---")
        ]
        added = [
            ln for ln in witness_lines
            if ln.startswith("+") and not ln.startswith("+++")
        ]
        self.assertEqual(removed, [])
        self.assertEqual(len(added), 2)
        self.assertIn("@@ -16,4 +16,6 @@", HEAD_318_REDERIVE_APPEND)
        current, _err = _capture(
            dc._rederive_diff_against_file, PROPOSAL_318_DIFF, self.target
        )
        self.assertNotEqual(current, HEAD_318_REDERIVE_APPEND)

    def test_when_add_only_rederived_then_append_still_built(self) -> None:
        add_only = (
            "--- a/glass-atrium-dev-db.md\n"
            "+++ b/glass-atrium-dev-db.md\n"
            "@@ -1,1 +1,2 @@\n"
            " ## Work Rules\n"
            + ADD_ONLY_FRAGMENT
        )
        result, err = _capture(
            dc._rederive_diff_against_file, add_only, self.target
        )
        self.assertIn("Retention window", str(result))
        self.assertNotIn(_REFUSAL_MARKER, err)


class TestNormalizationFallbackRefusal(_WorkTreeCase):
    """Reached only by a header-less fragment."""

    def test_when_headerless_replace_then_empty_not_append(self) -> None:
        result, err = _capture(
            dc._normalize_to_unified_diff, HEADERLESS_REPLACE_FRAGMENT, self.target
        )
        self.assertEqual(result, "")
        self.assertIn(_REFUSAL_MARKER, err)

    def test_when_headerless_add_only_then_append_still_built(self) -> None:
        result, err = _capture(
            dc._normalize_to_unified_diff, ADD_ONLY_FRAGMENT, self.target
        )
        self.assertIn("Retention window", str(result))
        self.assertNotIn(_REFUSAL_MARKER, err)


class TestValidationGateRebuildRefusal(_WorkTreeCase):
    """The gate's step-3 rebuild — reached only by a PARSER reject."""

    def test_when_fixture_then_it_reaches_the_rebuild_step(self) -> None:
        # Arrival asserted, not assumed: step 1 must fail and step 2 must be a
        # no-op, else the fixture never gets as far as the rebuild.
        parseable, _stderr = dc._validate_unified_diff(
            PARSER_REJECT_REPLACE_DIFF, self.work_tree
        )
        self.assertFalse(parseable)
        self.assertEqual(
            dc._recount_hunk_header(PARSER_REJECT_REPLACE_DIFF),
            PARSER_REJECT_REPLACE_DIFF,
        )
        self.assertTrue(self.target.exists())

    def test_when_parser_reject_replace_then_empty_not_append(self) -> None:
        result, err = _capture(
            dc._gate_validated_diff,
            PARSER_REJECT_REPLACE_DIFF,
            self.target,
            self.work_tree,
        )
        self.assertEqual(result, "")
        self.assertIn(_REFUSAL_MARKER, err)

    def test_when_parser_reject_add_only_then_append_still_built(self) -> None:
        add_only = (
            "--- a/glass-atrium-dev-db.md\n"
            "+++ b/glass-atrium-dev-db.md\n"
            "@@ -x,y +x,y @@\n"
            " - Schema changes → **migration files** (no direct DDL)\n"
            + ADD_ONLY_FRAGMENT
        )
        result, err = _capture(
            dc._gate_validated_diff, add_only, self.target, self.work_tree
        )
        self.assertIn("Retention window", str(result))
        self.assertNotIn(_REFUSAL_MARKER, err)


class TestPureRemovalPathUntouched(unittest.TestCase):
    """A removal-only diff keeps its existing arm — asserted on the RETURN VALUE."""

    def setUp(self) -> None:
        # The qa-debugger BEFORE state, reconstructed from the applied proposal
        # 314 hunk itself (context + removed lines, as stored).
        before = "<!-- EDITABLE:BEGIN -->\n"
        for line in PROPOSAL_314_DIFF.splitlines()[3:]:
            before += line[1:] + "\n"
        before += "<!-- EDITABLE:END -->\n"
        self.work_tree, self.target = _write_work_tree(
            "glass-atrium-qa-debugger.md", before
        )

    def test_when_removal_only_gated_then_no_refusal_and_no_append(self) -> None:
        result, err = _capture(
            dc._gate_validated_diff, PROPOSAL_360_DIFF, self.target, self.work_tree
        )
        self.assertNotIn(_REFUSAL_MARKER, err)
        # Either passed through untouched or rejected empty — never a rebuilt
        # append, which is the only outcome this task is closing.
        self.assertIn(result, ("", PROPOSAL_360_DIFF))

    def test_when_applied_pure_removal_rederived_then_no_refusal(self) -> None:
        result, err = _capture(
            dc._rederive_diff_against_file, PROPOSAL_314_DIFF, self.target
        )
        self.assertEqual(result, "")
        self.assertNotIn(_REFUSAL_MARKER, err)


class TestReplaceShapePredicate(unittest.TestCase):
    """The single SoT for which shape is refused."""

    def test_when_replace_then_true(self) -> None:
        self.assertTrue(dc._diff_is_replace_shape(PROPOSAL_318_DIFF))

    def test_when_pure_removal_then_false(self) -> None:
        self.assertFalse(dc._diff_is_replace_shape(PROPOSAL_314_DIFF))

    def test_when_add_only_then_false(self) -> None:
        self.assertFalse(dc._diff_is_replace_shape(ADD_ONLY_FRAGMENT))


class TestRefusalLineNamesSiteAndTarget(_WorkTreeCase):
    """A refusal is countable in the daemon log, not inferable from an absence."""

    def test_when_each_site_refuses_then_line_names_site_and_target(self) -> None:
        cases = {
            "stale re-derivation": (
                dc._rederive_diff_against_file, (PROPOSAL_318_DIFF, self.target)
            ),
            "normalization fallback": (
                dc._normalize_to_unified_diff,
                (HEADERLESS_REPLACE_FRAGMENT, self.target),
            ),
            "F2 GATE rebuild": (
                dc._gate_validated_diff,
                (PARSER_REJECT_REPLACE_DIFF, self.target, self.work_tree),
            ),
        }
        seen: list[str] = []
        for site, (fn, args) in cases.items():
            _result, err = _capture(fn, *args)
            self.assertIn(site, err)
            self.assertIn(self.target.name, err)
            seen.append(site)
        self.assertEqual(len(set(seen)), 3)


class TestRefusalReasonIsFilterable(unittest.TestCase):
    """The stored row must separate a refusal from a quality reject."""

    def test_when_refusal_rationale_then_own_failure_class(self) -> None:
        rationale = f"{dc.REMOVAL_REFUSAL_REASON_PREFIX}: tighten the budget bullet"
        self.assertEqual(
            dc.classify_failure_rationale(rationale),
            dc.FAILURE_CLASS_REMOVAL_REFUSAL,
        )
        self.assertNotEqual(
            dc.FAILURE_CLASS_REMOVAL_REFUSAL, dc.FAILURE_CLASS_QUALITY
        )

    def test_when_refusal_then_streak_still_advances(self) -> None:
        # Terminalization is the INTENDED disposition, so the refusal class must
        # NOT be looked past the way an infra class is.
        self.assertNotIn(
            dc.FAILURE_CLASS_REMOVAL_REFUSAL, dc._NON_ADJUDICATION_CLASSES
        )
        rows = [
            ("rejected", "budget-overage concentration",
             f"{dc.REMOVAL_REFUSAL_REASON_PREFIX}: attempt {n}")
            for n in range(3)
        ]
        self.assertEqual(
            dc.consecutive_reject_count("budget-overage concentration", rows), 3
        )

    def test_when_three_refusals_then_pattern_terminalizes_with_reason(self) -> None:
        pattern = dc.Pattern(
            date="2026-07-31",
            label="budget-overage concentration",
            frequency="12",
            agent="dev-db",
            status="identified",
            tier="body-auto",
            raw_line="pg:learning_log:9001:budget-overage concentration|dev-db",
            row_id=9001,
        )
        rows = [
            ("rejected", pattern.label,
             f"{dc.REMOVAL_REFUSAL_REASON_PREFIX}: attempt {n}")
            for n in range(dc.REJECT_STREAK_THRESHOLD)
        ]
        captured: list[str] = []
        original = dc._terminalize_pattern
        dc._terminalize_pattern = (  # type: ignore[assignment]
            lambda *a, **kw: captured.append(str(kw.get("reason", "")))
        )
        try:
            survivors = dc.drop_reject_streak_patterns("dev-db", [pattern], rows)
        finally:
            dc._terminalize_pattern = original  # type: ignore[assignment]
        self.assertEqual(survivors, [])
        self.assertEqual(len(captured), 1)
        self.assertIn(str(dc.REJECT_STREAK_THRESHOLD), captured[0])


class TestCallerAbsorbsEmptyReturn(_WorkTreeCase):
    """No caller learns a new outcome shape — "" is the existing reject shape."""

    def test_when_haiku_emits_replace_then_proposal_carries_refusal_reason(
        self,
    ) -> None:
        stdout = (
            "RATIONALE: tighten the budget checkpoint bullet\n"
            "DIFF:\n"
            + HEADERLESS_REPLACE_FRAGMENT
        )
        proposal, err = _capture(dc._parse_haiku_response, stdout, self.target)
        self.assertEqual(proposal.proposed_diff, "")
        self.assertTrue(
            proposal.rationale.startswith(dc.REMOVAL_REFUSAL_REASON_PREFIX)
        )
        self.assertIn(_REFUSAL_MARKER, err)
        # The existing empty-diff arm classifies it, unchanged.
        self.assertEqual(proposal.estimated_added_lines, 0)

    def test_when_haiku_emits_add_only_then_no_refusal_reason(self) -> None:
        stdout = (
            "RATIONALE: add a retention window rule\n"
            "DIFF:\n"
            + ADD_ONLY_FRAGMENT
        )
        proposal, err = _capture(dc._parse_haiku_response, stdout, self.target)
        self.assertIn("Retention window", proposal.proposed_diff)
        self.assertFalse(
            proposal.rationale.startswith(dc.REMOVAL_REFUSAL_REASON_PREFIX)
        )
        self.assertNotIn(_REFUSAL_MARKER, err)


class TestAgentsDirSeam(_WorkTreeCase):
    """The gate's applicability check must be steerable off the live install."""

    def test_when_no_argument_then_module_default_preserved(self) -> None:
        import inspect

        default = inspect.signature(dc._gate_validated_diff).parameters[
            "agents_dir"
        ].default
        self.assertEqual(default, dc.DEFAULT_AGENTS_DIR)

    def test_when_work_tree_passed_then_gate_resolves_against_it(self) -> None:
        git_root, _prefix = dc._resolve_apply_git_scope(self.work_tree)
        self.assertEqual(
            Path(git_root).resolve(), self.work_tree.resolve()
        )
        self.assertNotIn(str(dc.DEFAULT_AGENTS_DIR), git_root)
        add_only = (
            "--- a/glass-atrium-dev-db.md\n"
            "+++ b/glass-atrium-dev-db.md\n"
            "@@ -x,y +x,y @@\n"
            " - Schema changes → **migration files** (no direct DDL)\n"
            + ADD_ONLY_FRAGMENT
        )
        result, _err = _capture(
            dc._gate_validated_diff, add_only, self.target, self.work_tree
        )
        self.assertIn("Retention window", str(result))


if __name__ == "__main__":
    unittest.main()
