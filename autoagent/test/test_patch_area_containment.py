"""Regression tests for the classify_patch_area R1 containment gate (AP-1).

The live layout is a symlink FARM — ``~/.claude/agents/`` is a real directory
whose ``*.md`` entries are per-file symlinks into ``~/.glass-atrium/agents/`` —
so the former ``target.resolve().relative_to(agents_dir.resolve())`` raised
ValueError for EVERY legitimate member and rejected all proposals.
``_target_in_agents_dir`` now accepts lexical containment, canonical
containment, and per-member symlink identity; traversal escapes still reject.

Run with either runner:
    uv run --with pytest --with psycopg pytest autoagent/test/test_patch_area_containment.py -v
    python3 -m unittest autoagent.test.test_patch_area_containment -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _IMPORT_ERROR = exc

_VALID_DIFF = (
    "--- a/probe-agent.md\n"
    "+++ b/probe-agent.md\n"
    "@@ -1 +1,2 @@\n"
    " # probe agent\n"
    "+- new body line\n"
)


def _proposal(target_file: str, *, touched_frontmatter: bool = False) -> "dc.PatchProposal":
    return dc.PatchProposal(
        target_file=target_file,
        rationale="containment probe",
        proposed_diff=_VALID_DIFF,
        touched_frontmatter=touched_frontmatter,
        estimated_added_lines=1,
        raw_response="",
        parse_mode="strict",
    )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class _SymlinkFarmFixture(unittest.TestCase):
    """tmp replica of the live layout — farm dir of per-file symlinks into a real tree."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="ap1-containment-")
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)

        self.real_agents = root / "glass-atrium" / "agents"
        self.real_agents.mkdir(parents=True)
        self.real_md = self.real_agents / "probe-agent.md"
        self.real_md.write_text("# probe agent\n", encoding="utf-8")

        self.farm_agents = root / "dot-claude" / "agents"
        self.farm_agents.mkdir(parents=True)
        self.farm_md = self.farm_agents / "probe-agent.md"
        self.farm_md.symlink_to(self.real_md)

        self.rules_dir = root / "dot-claude" / "rules"
        self.rules_dir.mkdir(parents=True)
        self.rules_md = self.rules_dir / "core-something.md"
        self.rules_md.write_text("# a rule\n", encoding="utf-8")


class TestSymlinkFarmContainment(_SymlinkFarmFixture):
    """The live failure mode: symlinked member must classify non-reject."""

    def test_when_target_is_symlinked_member_then_body_auto(self) -> None:
        result = dc.classify_patch_area(
            _proposal(str(self.farm_md)), self.farm_md, agents_dir=self.farm_agents
        )
        self.assertEqual(result, "body-auto")

    def test_when_target_is_symlink_destination_then_body_auto(self) -> None:
        # Member-identity check: the resolved glass-atrium path is the SAME file
        # as the same-named farm entry.
        result = dc.classify_patch_area(
            _proposal(str(self.real_md)), self.real_md, agents_dir=self.farm_agents
        )
        self.assertEqual(result, "body-auto")

    def test_when_agents_dir_itself_symlink_then_body_auto(self) -> None:
        link_dir = Path(self._tmp.name) / "agents-link"
        link_dir.symlink_to(self.real_agents, target_is_directory=True)
        target = link_dir / "probe-agent.md"
        result = dc.classify_patch_area(
            _proposal(str(target)), target, agents_dir=link_dir
        )
        self.assertEqual(result, "body-auto")

    def test_when_plain_real_dir_then_body_auto(self) -> None:
        result = dc.classify_patch_area(
            _proposal(str(self.real_md)), self.real_md, agents_dir=self.real_agents
        )
        self.assertEqual(result, "body-auto")

    def test_when_symlinked_member_touches_frontmatter_then_dryrun(self) -> None:
        # Containment passes; the downstream frontmatter gate must stay intact.
        result = dc.classify_patch_area(
            _proposal(str(self.farm_md), touched_frontmatter=True),
            self.farm_md,
            agents_dir=self.farm_agents,
        )
        self.assertEqual(result, "frontmatter-dryrun")


class TestOutsideTargetsStillReject(_SymlinkFarmFixture):
    """The gate's original purpose — non-agent targets keep rejecting."""

    def test_when_target_in_rules_dir_then_reject(self) -> None:
        result = dc.classify_patch_area(
            _proposal(str(self.rules_md)), self.rules_md, agents_dir=self.farm_agents
        )
        self.assertEqual(result, "reject")

    def test_when_dotdot_traversal_escape_then_reject(self) -> None:
        escape = self.farm_agents / ".." / "rules" / "core-something.md"
        result = dc.classify_patch_area(
            _proposal(str(escape)), escape, agents_dir=self.farm_agents
        )
        self.assertEqual(result, "reject")

    def test_when_same_basename_outside_then_reject(self) -> None:
        # Same NAME as a member but a DIFFERENT file — member identity must
        # compare realpaths, not basenames.
        impostor = self.rules_dir / "probe-agent.md"
        impostor.write_text("# impostor\n", encoding="utf-8")
        result = dc.classify_patch_area(
            _proposal(str(impostor)), impostor, agents_dir=self.farm_agents
        )
        self.assertEqual(result, "reject")

    def test_when_target_missing_then_reject(self) -> None:
        ghost = self.farm_agents / "nonexistent-agent.md"
        result = dc.classify_patch_area(
            _proposal(str(ghost)), ghost, agents_dir=self.farm_agents
        )
        self.assertEqual(result, "reject")


if __name__ == "__main__":
    unittest.main()
