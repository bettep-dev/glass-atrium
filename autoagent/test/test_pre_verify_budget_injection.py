"""Behavioral tests for the injected turn-budget excerpt in pre-verify assembly.

The four compliance slots resolve the matrix, GLOBAL_RULES, one ``scope-*.md``
and the target body, so the turn-budget text the SubagentStart injector delivers
reaches none of them and a patch duplicating it reads to C4 as a clean add.
``daemon_cycle`` closes that with a fifth source, attached for budget-family
patches only. Covered here:
  (a) the marker literals this reader uses are the ones
      ``hooks/inject-scope-rules.sh`` declares, derived from that file rather
      than restated, and the extraction agrees with the hook's own shell
      extractor over the live source;
  (b) the extractor's boundary + fail-open semantics — between-lines only, absent
      file / absent start marker empty, start-without-end running to EOF;
  (c) the budget-family predicate fires on EITHER leg and on neither for a
      neighbouring non-budget proposal, and never on the forbidden
      operational-counter literal;
  (d) the site leg reads diff file headers the way the header reader defines
      them — a ``+++ `` body line names no file, a quoted path does;
  (e) delivery is judged per block against the hook's own roster declarations:
      a roster member gets only its block, an agent in no roster gets no block
      text and a not-injected line, a non-agent target gets both blocks labelled
      by receiving roster, an unreadable roster gets a delivery-unverified line —
      and assembly stays byte-idempotent on every branch;
  (f) the live hook rosters still classify the agents these cases rely on.

Both roots are temporary — the source is bound through ``GA_DATA_ROOT`` (the
ga_paths seam) — so no case depends on an installed ``~/.glass-atrium``.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pre_verify_budget_injection.py -v
    python3 -m unittest autoagent.test.test_pre_verify_budget_injection -v
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_AGENT = "glass-atrium-dev-python"
_RELATIVE_TARGET = f"agents/{_AGENT}.md"
# One agent per delivery branch; RosterDriftTest holds the live hook to these.
_CARRIER = "glass-atrium-dev-nestjs"
_DEV_MEMBER = "glass-atrium-dev-node"
_ANALYSIS_MEMBER = "glass-atrium-intel-planner"
_ROSTER_OF = {"BUDGET-DEV": _DEV_MEMBER, "BUDGET-ANALYSIS": _ANALYSIS_MEMBER}
_INJECT_HOOK = _HOOKS_DIR / "inject-scope-rules.sh"
_LIVE_BUDGET_SRC = _REPO_ROOT / "scoped" / "shared-turn-budget.md"
# The operational-counter literal the predicate must never key on: it rides a
# different axis and its exclusion set drops the row before generation.
_FORBIDDEN_CORE = "budget-overage concentration"
_NEIGHBOUR_LABEL = "agent instruction-improvement candidate (failure rate 62%)"


def _base_root(path: Path):
    """Point the ga_paths seam at `path` — resolution is per-call, so this binds."""
    return mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(path)})


def _budget_core() -> str:
    """The one signature core the label leg keys on, read from the implementation."""
    return sorted(dc.BUDGET_FAMILY_SIGNATURE_CORES)[0]


def _pattern(label: str, agent: str = _AGENT):
    return dc.Pattern(
        date="2026-09-16",
        label=label,
        frequency="3/5",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:1:{label}|{agent}",
    )


def _patch_proposal(target_file: str, diff: str = "+ a line"):
    return dc.PatchProposal(
        target_file=target_file,
        rationale="test rationale",
        proposed_diff=diff,
        touched_frontmatter=False,
        estimated_added_lines=1,
        raw_response="",
    )


def _write_source(root: Path, body: str) -> Path:
    """Write a scoped/shared-turn-budget.md under `root`, returning its path."""
    src = root / "scoped" / dc.TURN_BUDGET_SRC_NAME
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(body, encoding="utf-8")
    return src


def _write_agent(root: Path, agent: str = _AGENT) -> Path:
    target = root / "agents" / f"{agent}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"# {agent}\n\nbody line\n", encoding="utf-8")
    return target


def _write_roster_hook(root: Path) -> None:
    """Copy the live injector hook under `root`, so fixture rosters are the real ones."""
    dest = root / "hooks" / _INJECT_HOOK.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(_INJECT_HOOK, dest)


def _fixture_source() -> str:
    """A source carrying both real marker pairs, each around a unique sentinel."""
    lines = ["# fixture turn-budget source", ""]
    for name, start, end in dc.BUDGET_BLOCK_MARKERS:
        lines += [f"## {name}", "prose that is NOT injected", start,
                  f"**{name} sentinel body 9c31ad**", f"- {name} bullet", end, ""]
    return "\n".join(lines) + "\n"


def _get_prompt(label: str, target_file: str = _RELATIVE_TARGET, diff: str = "+ a line"):
    """Assemble the pre-verify prompt; return (prompt, stderr)."""
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        prompt = dc._build_pre_verify_prompt(
            _patch_proposal(target_file, diff), _pattern(label)
        )
    return prompt, captured.getvalue()


def _get_block_label(prompt: str, name: str) -> str:
    """The label line an attached block opens with."""
    return next(line for line in prompt.splitlines() if line.startswith(f"[{name} "))


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class MarkerContractTest(unittest.TestCase):
    """(a) the second reader of the marker contract agrees with the first."""

    def test_when_hook_declares_markers_then_this_reader_uses_the_same_literals(self):
        if not _INJECT_HOOK.is_file():
            self.skipTest(f"injector hook not readable: {_INJECT_HOOK}")
        hook_text = _INJECT_HOOK.read_text(encoding="utf-8")
        for _name, start, end in dc.BUDGET_BLOCK_MARKERS:
            # Derived on the hook side: the literal must appear there verbatim,
            # so a rename in either file reds this rather than silently halving
            # the contract's readership.
            self.assertIn(f"'{start}'", hook_text)
            self.assertIn(f"'{end}'", hook_text)

    def test_when_live_source_read_then_every_declared_block_is_non_empty(self):
        if not _LIVE_BUDGET_SRC.is_file():
            self.skipTest(f"live turn-budget source absent: {_LIVE_BUDGET_SRC}")
        for name, start, end in dc.BUDGET_BLOCK_MARKERS:
            block = dc._read_marker_block(_LIVE_BUDGET_SRC, start, end)
            self.assertTrue(block.strip(), f"{name} block extracted empty")
            self.assertNotIn(start, block)
            self.assertNotIn(end, block)

    def test_when_live_source_read_then_extraction_matches_the_shell_extractor(self):
        if not _LIVE_BUDGET_SRC.is_file():
            self.skipTest(f"live turn-budget source absent: {_LIVE_BUDGET_SRC}")
        if not all(shutil.which(tool) for tool in ("bash", "sed", "grep")):
            self.skipTest("shell extractor tools unavailable")

        for name, start, end in dc.BUDGET_BLOCK_MARKERS:
            # The hook's own pipeline, run verbatim against the same file: the
            # relationship asserted is agreement between the two readers, not a
            # copied expected value.
            shell = subprocess.run(
                ["bash", "-c",
                 'sed -n "/$2/,/$3/p" "$1" | grep -vxF "$2" | grep -vxF "$3"',
                 "_", str(_LIVE_BUDGET_SRC), start, end],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(
                dc._read_marker_block(_LIVE_BUDGET_SRC, start, end).splitlines(),
                shell.stdout.splitlines(),
                f"{name}: python and shell extractors disagree",
            )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class MarkerExtractionTest(unittest.TestCase):
    """(b) boundary and fail-open semantics of the extractor."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.name, self.start, self.end = dc.BUDGET_BLOCK_MARKERS[0]

    def test_when_markers_present_then_only_the_lines_between_survive(self):
        src = _write_source(self.root, _fixture_source())
        block = dc._read_marker_block(src, self.start, self.end)
        self.assertIn(f"**{self.name} sentinel body 9c31ad**", block)
        self.assertNotIn("prose that is NOT injected", block)
        self.assertNotIn(self.start, block)
        self.assertNotIn(self.end, block)

    def test_when_file_absent_then_extraction_is_empty(self):
        self.assertEqual(
            dc._read_marker_block(self.root / "absent.md", self.start, self.end), ""
        )

    def test_when_start_marker_absent_then_extraction_is_empty(self):
        src = _write_source(self.root, "# no markers here\nbody\n")
        self.assertEqual(dc._read_marker_block(src, self.start, self.end), "")

    def test_when_end_marker_absent_then_extraction_runs_to_eof(self):
        src = _write_source(self.root, f"head\n{self.start}\nkept a\nkept b\n")
        self.assertEqual(
            dc._read_marker_block(src, self.start, self.end), "kept a\nkept b"
        )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class BudgetFamilyPredicateTest(unittest.TestCase):
    """(c) each leg fires on its own, and neither over-fires."""

    def test_when_label_carries_the_signature_core_then_the_label_leg_fires(self):
        core = _budget_core()
        # The live emit shape: stable core + free-text tail. Matching the tail
        # would miss this; matching the core does not.
        for label in (core, f"{core} (avg overrun +7 tool_uses)",
                      f"multi-signal ({_NEIGHBOUR_LABEL} / {core})"):
            with self.subTest(label=label):
                leg = dc.match_budget_family(label, _RELATIVE_TARGET, "+ a line")
                self.assertEqual(leg, f"label:{core}")

    def test_when_diff_touches_a_budget_site_then_the_site_leg_fires(self):
        diff = (
            "--- a/scoped/shared-turn-budget.md\n"
            "+++ b/scoped/shared-turn-budget.md\n"
            "@@ -1 +1,2 @@\n+ a budget bullet\n"
        )
        leg = dc.match_budget_family(_NEIGHBOUR_LABEL, _RELATIVE_TARGET, diff)
        self.assertIsNotNone(leg)
        self.assertTrue(leg.startswith("site:"), leg)

    def test_when_target_file_is_a_budget_site_then_the_site_leg_fires(self):
        leg = dc.match_budget_family(
            _NEIGHBOUR_LABEL, "hooks/inject-scope-rules.sh", "+ a line"
        )
        self.assertIsNotNone(leg)
        self.assertTrue(leg.startswith("site:"), leg)

    def test_when_neighbouring_proposal_then_no_leg_fires(self):
        self.assertIsNone(
            dc.match_budget_family(
                _NEIGHBOUR_LABEL,
                _RELATIVE_TARGET,
                f"--- a/{_RELATIVE_TARGET}\n+++ b/{_RELATIVE_TARGET}\n+ a line\n",
            )
        )

    def test_when_label_is_the_operational_counter_then_no_leg_fires(self):
        # Reusing that literal would suppress the very patterns this source
        # serves — it lives in the intake EXCLUSION set, a different axis.
        self.assertNotIn(_FORBIDDEN_CORE, dc.BUDGET_FAMILY_SIGNATURE_CORES)
        self.assertIsNone(
            dc.match_budget_family(_FORBIDDEN_CORE, _RELATIVE_TARGET, "+ a line")
        )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class HeaderSiteTest(unittest.TestCase):
    """(d) the site leg keys on header paths, never on body lines shaped like headers."""

    _HOOK = "hooks/inject-scope-rules.sh"

    def test_when_a_header_names_the_site_then_the_site_leg_fires(self):
        prefix = "--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n"
        for diff in (
            f"{prefix}--- a/{self._HOOK}\n+++ b/{self._HOOK}\n@@ -1 +1 @@\n+x\n",
            f'--- "a/{self._HOOK}"\n+++ "b/{self._HOOK}"\n@@ -1 +1 @@\n+x\n',
            f"--- a/{self._HOOK}\t2026-01-01\r\n+++ b/{self._HOOK}\t2026-01-01\r\n@@ -1 +1 @@\n",
        ):
            with self.subTest(diff=diff):
                self.assertIsNotNone(dc.match_turn_budget_site(_RELATIVE_TARGET, diff))

    def test_when_only_a_body_line_names_the_site_then_no_site_leg_fires(self):
        for diff in (
            f"--- a/x.md\n+++ b/x.md\n@@ -1 +1,2 @@\n-a\n+++ b/{self._HOOK}\n+b\n",
            f"--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n--- a/{self._HOOK}\n+++ b/{self._HOOK}\n",
            f"---a/{self._HOOK}\n+++b/{self._HOOK}\n",
        ):
            with self.subTest(diff=diff):
                self.assertIsNone(dc.match_turn_budget_site(_RELATIVE_TARGET, diff))

    def test_when_header_paths_read_then_prefix_tab_quote_and_dev_null_resolve(self):
        diff = (
            '--- /dev/null\n+++ "b/d\\303\\251 \\"q\\".md"\t2026\n@@ -0,0 +1 @@\n+x\n'
            "diff --git a/a/y.md b/a/y.md\n--- a/a/y.md\n+++ b/a/y.md\n"
        )
        self.assertEqual(
            dc._get_diff_header_paths(diff), ['dé "q".md', "a/y.md", "a/y.md"]
        )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class RosterDeliveryTest(unittest.TestCase):
    """(e) each block's delivery claim follows the hook rosters, on every branch."""

    def setUp(self):
        if not _INJECT_HOOK.is_file():
            self.skipTest(f"injector hook not readable: {_INJECT_HOOK}")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        for agent in (_AGENT, _CARRIER, _DEV_MEMBER, _ANALYSIS_MEMBER):
            _write_agent(self.root, agent)
        self.src = _write_source(self.root, _fixture_source())
        _write_roster_hook(self.root)
        self.budget_label = f"{_budget_core()} (avg overrun +7 tool_uses)"

    def _block(self, name: str) -> str:
        _name, start, end = next(m for m in dc.BUDGET_BLOCK_MARKERS if m[0] == name)
        return dc._read_marker_block(self.src, start, end)

    def _get_agent_prompt(self, agent: str) -> tuple[str, str]:
        with _base_root(self.root):
            return _get_prompt(self.budget_label, f"agents/{agent}.md")

    def test_when_target_is_a_roster_member_then_only_its_block_is_attached(self):
        for name, agent in _ROSTER_OF.items():
            with self.subTest(block=name):
                prompt, _ = self._get_agent_prompt(agent)
                for other in dc.BUDGET_BLOCK_ROSTERS:
                    if other == name:
                        self.assertIn(self._block(other), prompt)
                    else:
                        self.assertNotIn(self._block(other), prompt)
                label = _get_block_label(prompt, name)
                self.assertIn(agent, label)
                self.assertIn(dc.BUDGET_BLOCK_ROSTERS[name], label)
                self.assertNotIn(dc.TURN_BUDGET_NOT_INJECTED_SIGNAL, prompt)

    def test_when_target_is_in_no_roster_then_no_block_text_and_a_not_injected_line(self):
        prompt, _ = self._get_agent_prompt(_CARRIER)
        for name in dc.BUDGET_BLOCK_ROSTERS:
            self.assertNotIn(self._block(name), prompt)
        line = next(ln for ln in prompt.splitlines() if dc.TURN_BUDGET_NOT_INJECTED_SIGNAL in ln)
        self.assertIn(_CARRIER, line)
        live = _LIVE_BUDGET_SRC.read_text(encoding="utf-8") if _LIVE_BUDGET_SRC.is_file() else ""
        for block_line in (ln.strip() for ln in live.splitlines()):
            # The line may cite no block wording, live source included.
            if len(block_line) > 12:
                self.assertNotIn(block_line, line)

    def test_when_target_is_not_an_agent_body_then_every_block_names_its_roster(self):
        for target in ("scoped/shared-turn-budget.md", "agents/GLASS_ATRIUM_GLOBAL_RULES.md"):
            with self.subTest(target=target), _base_root(self.root):
                prompt, _ = _get_prompt(self.budget_label, target)
                for name, roster in dc.BUDGET_BLOCK_ROSTERS.items():
                    self.assertIn(self._block(name), prompt)
                    self.assertIn(roster, _get_block_label(prompt, name))

    def test_when_roster_unreadable_then_delivery_is_unverified_on_both_channels(self):
        hook = self.root / "hooks" / _INJECT_HOOK.name
        for body in (None, "#!/usr/bin/env bash\nreadonly OTHER=\" x \"\n"):
            with self.subTest(hook_body=body):
                if body is None:
                    hook.unlink()
                else:
                    hook.write_text(body, encoding="utf-8")
                prompt, stderr = self._get_agent_prompt(_DEV_MEMBER)
                self.assertIn(dc.TURN_BUDGET_DELIVERY_UNVERIFIED_SIGNAL, prompt)
                self.assertIn(dc.TURN_BUDGET_DELIVERY_UNVERIFIED_SIGNAL, stderr)
                for name in dc.BUDGET_BLOCK_ROSTERS:
                    self.assertNotIn(self._block(name), prompt)

    def test_when_patch_is_not_budget_family_then_no_block_reaches_the_prompt(self):
        with _base_root(self.root):
            prompt, _ = _get_prompt(_NEIGHBOUR_LABEL, f"agents/{_DEV_MEMBER}.md")
        for name in dc.BUDGET_BLOCK_ROSTERS:
            self.assertNotIn(self._block(name), prompt)
        self.assertIn(dc.TURN_BUDGET_NOT_APPLICABLE, prompt)

    def test_when_source_unreadable_then_the_named_signal_is_loud_on_both_channels(self):
        self.src.unlink()
        prompt, stderr = self._get_agent_prompt(_DEV_MEMBER)
        self.assertIn(dc.TURN_BUDGET_UNREADABLE_SIGNAL, stderr)
        self.assertIn(dc.TURN_BUDGET_UNREADABLE_SIGNAL, prompt)

    def test_when_assembled_twice_then_the_prompt_is_byte_identical_on_every_branch(self):
        cases = [(self.budget_label, f"agents/{a}.md") for a in (_CARRIER, _DEV_MEMBER, _ANALYSIS_MEMBER)]
        cases += [(self.budget_label, "scoped/shared-turn-budget.md"), (_NEIGHBOUR_LABEL, _RELATIVE_TARGET)]
        for label, target in cases:
            with self.subTest(target=target), _base_root(self.root):
                self.assertEqual(_get_prompt(label, target)[0], _get_prompt(label, target)[0])
        (self.root / "hooks" / _INJECT_HOOK.name).unlink()
        with _base_root(self.root):
            first = _get_prompt(self.budget_label, f"agents/{_DEV_MEMBER}.md")[0]
            self.assertEqual(first, _get_prompt(self.budget_label, f"agents/{_DEV_MEMBER}.md")[0])


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class RosterDriftTest(unittest.TestCase):
    """(f) the live hook arrays still put each test agent on the branch it stands for."""

    def test_when_live_hook_read_then_rosters_match_bash_and_the_test_agents(self):
        if not _INJECT_HOOK.is_file() or not shutil.which("bash"):
            self.skipTest("injector hook or bash unavailable")
        with _base_root(_REPO_ROOT):
            rosters = dc._get_budget_rosters()
        self.assertIsNotNone(rosters)
        for roster, members in rosters.items():
            # bash evaluates the declaration itself — the parser must agree with it.
            shell = subprocess.run(
                ["bash", "-c", f'eval "$(grep -E "^readonly {roster}=" "$1")"; echo ${roster}',
                 "_", str(_INJECT_HOOK)],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(members, frozenset(shell.stdout.split()), roster)
        for name, agent in _ROSTER_OF.items():
            self.assertEqual(
                {r for r, m in rosters.items() if agent in m}, {dc.BUDGET_BLOCK_ROSTERS[name]}
            )
        self.assertFalse(any(_CARRIER in m for m in rosters.values()))


if __name__ == "__main__":
    unittest.main()
