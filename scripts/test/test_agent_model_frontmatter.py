"""Behavioral tests for the frontmatter a new agent is born with.

A new agent arrives unpinned: its frontmatter carries no `model:` line, so it is
pinned only from the monitor's agent list (the one writer of that line).

Self-contained: inserts the scripts root on sys.path; every write stays inside a
pytest temp root (no live store touched).

Run with:
    uv run --python 3.13 --with pytest pytest \
        scripts/test/test_agent_model_frontmatter.py -v
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle import add as add_mod  # noqa: E402
from agent_lifecycle.add import AddRequest, run_add  # noqa: E402
from agent_lifecycle.paths import StorePaths  # noqa: E402
from agent_lifecycle.scaffold import render_agent_md  # noqa: E402


def _frontmatter(md_text: str) -> str:
    _, frontmatter, _ = md_text.split("---\n", 2)
    return frontmatter


def test_when_agent_added_then_frontmatter_carries_no_model_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "agents").mkdir()
    paths = StorePaths.for_root(tmp_path)
    paths.registry.write_text(json.dumps({"agents": {}}), encoding="utf-8")
    # subprocess-backed derived-chain steps: no git / manifest / symlink farm here
    monkeypatch.setattr(add_mod, "git_add", lambda *_a, **_k: None)
    monkeypatch.setattr(add_mod, "regenerate_manifest", lambda *_a, **_k: None)
    monkeypatch.setattr(add_mod, "swap_symlinks", lambda *_a, **_k: None)

    run_add(
        paths,
        AddRequest(
            name="intel-scout",
            scope="RESEARCH",
            origin="user",
            domains=["field-scouting"],
            q1_verdict="pass",
            q2_verdict="pass",
        ),
    )

    md_text = (paths.agents_dir / "glass-atrium-intel-scout.md").read_text(
        encoding="utf-8"
    )
    assert "model:" not in _frontmatter(md_text)


def test_when_rendered_then_no_rules_header_emitted() -> None:
    # Per-agent rule membership lives on the registry row, so a rendered body
    # carries no header claiming it — on the stub branch and the authored one.
    stub = render_agent_md(name="dev-x", domains=["a"])
    authored = render_agent_md(name="dev-x", domains=["a"], body="# dev-x\n")
    assert "> Rules:" not in stub
    assert "> Rules:" not in authored
