"""Behavioral tests for the EXTEND --append-section body gate.

`extend --append-section` used to read the operator's file and append it with no
screening at all, while a BYTE-IDENTICAL file on the `add --body-file` path
HALTed at the shared gates. These pin the closed bypass:

  - the shared gated read (missing / empty / whitespace-only / credential) now
    refuses a section exactly as it refuses a body;
  - the two append-specific structural terms (a `---` fence, a second `> Rules:`
    anchor) refuse post-hoc breakage of invariants only render-time asserts;
  - a section carrying frontmatter-shaped prose is ACCEPTED — the ADD-path
    smuggle gate is deliberately NOT reused (it would read an anchorless section
    as pre-anchor head and refuse prose the ADD path tolerates below the anchor);
  - every refusal exits EXIT_HALT with the target .md byte-unchanged.

Self-contained: every write lands in an isolated `--ga-root` temp (conftest.py
anchors scripts/ on sys.path; no live store is touched).

Run with:
    uv run --python 3.13 --with pytest pytest \
        scripts/test/test_extend_section_gate.py -v
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_lifecycle.cli import EXIT_HALT, EXIT_OK, main

_AGENT = "glass-atrium-dev-fixture"
_ANCHOR = "> Rules: GLASS_ATRIUM_GLOBAL_RULES.md (ALL + DEV)"
_FIXTURE_MD = (
    "---\n"
    f"name: {_AGENT}\n"
    "description: fixture agent (extend section gate).\n"
    "tools: [Read, Glob, Grep, Edit, Write, Bash]\n"
    "maxTurns: 40\n"
    "---\n"
    "\n"
    f"{_ANCHOR}\n"
    "\n"
    f"# {_AGENT}\n"
)

# Composed at runtime, never written as one literal: a whole credential shape in
# the source would trip the repo's own Write/Edit secret hooks on this very file.
_AWS_KEY_SHAPE = "AKIA" + "IOSFODNN7EXAMPLE"
_SK_KEY_SHAPE = "sk-" + "abcdefghijklmnopqrstuvwx"


def _seed_store(root: Path) -> Path:
    """Seed an isolated GA root (registry + agents/<fixture>.md); return the .md."""
    (root / "agents").mkdir(parents=True, exist_ok=True)
    (root / "agent-registry.json").write_text(
        json.dumps(
            {
                "version": "1.1",
                "agents": {_AGENT: {"domains": ["fixtures"], "origin": "user"}},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    md = root / "agents" / f"{_AGENT}.md"
    md.write_text(_FIXTURE_MD, encoding="utf-8")
    return md


def _extend(root: Path, section: Path, *extra: str) -> int:
    """Run `extend --append-section` against the temp root; return the exit code."""
    return main(
        [
            "--ga-root",
            str(root),
            "extend",
            _AGENT,
            "--append-section",
            str(section),
            *extra,
        ]
    )


# --- refusals: exit EXIT_HALT, target .md byte-unchanged -------------------


@pytest.mark.parametrize(
    ("case", "section"),
    [
        ("aws_key", f"## Probe\n\nkey = {_AWS_KEY_SHAPE}\n"),
        ("sk_key", f"## Probe\n\nOPENAI={_SK_KEY_SHAPE}\n"),
        ("empty", ""),
        ("whitespace_only", "   \n\t\n"),
        ("fence", "## Probe\n\n---\n\nname: attacker\n"),
        ("lone_thematic_break", "## Probe\n\n---\n"),
        ("second_anchor", f"{_ANCHOR}\n\n## Probe\n"),
    ],
)
def test_when_section_fails_a_gate_then_halts_and_md_unchanged(
    tmp_path: Path, case: str, section: str
) -> None:
    md = _seed_store(tmp_path)
    before = md.read_bytes()
    section_file = tmp_path / f"section-{case}.md"
    section_file.write_text(section, encoding="utf-8")

    assert _extend(tmp_path, section_file) == EXIT_HALT
    assert md.read_bytes() == before


def test_when_section_is_a_directory_then_halts_and_md_unchanged(tmp_path: Path) -> None:
    # exists() passes for a directory, so the refusal has to come from the read itself:
    # IsADirectoryError is a builtin no caller's except tuple names.
    md = _seed_store(tmp_path)
    before = md.read_bytes()
    section_dir = tmp_path / "section-dir"
    section_dir.mkdir()

    assert _extend(tmp_path, section_dir) == EXIT_HALT
    assert md.read_bytes() == before


def test_when_section_is_not_utf8_then_halts_and_md_unchanged(tmp_path: Path) -> None:
    md = _seed_store(tmp_path)
    before = md.read_bytes()
    section_file = tmp_path / "section-latin1.md"
    section_file.write_bytes(b"## Probe\n\n\xff\xfe not utf-8\n")

    assert _extend(tmp_path, section_file) == EXIT_HALT
    assert md.read_bytes() == before


def test_when_section_file_missing_then_halts_and_md_unchanged(tmp_path: Path) -> None:
    md = _seed_store(tmp_path)
    before = md.read_bytes()

    assert _extend(tmp_path, tmp_path / "absent.md") == EXIT_HALT
    assert md.read_bytes() == before


def test_when_section_refused_then_paired_domain_op_also_writes_nothing(
    tmp_path: Path,
) -> None:
    # The gate lives in run_extend's PRE-FLIGHT, so a bad section must abort the
    # whole extend before the transaction opens — not leave the domains half-applied.
    md = _seed_store(tmp_path)
    before = md.read_bytes()
    section_file = tmp_path / "section.md"
    section_file.write_text(f"## Probe\n\n{_AWS_KEY_SHAPE}\n", encoding="utf-8")

    assert _extend(tmp_path, section_file, "--add-domain", "probes") == EXIT_HALT
    assert md.read_bytes() == before
    registry = json.loads(
        (tmp_path / "agent-registry.json").read_text(encoding="utf-8")
    )
    assert registry["agents"][_AGENT]["domains"] == ["fixtures"]


# --- acceptance -----------------------------------------------------------


def test_when_section_is_clean_then_appends_below_existing_bytes(
    tmp_path: Path,
) -> None:
    md = _seed_store(tmp_path)
    section_file = tmp_path / "section.md"
    section_file.write_text("## Probe\n\nA clean appended section.\n", encoding="utf-8")

    assert _extend(tmp_path, section_file) == EXIT_OK
    after = md.read_text(encoding="utf-8")
    assert after.startswith(_FIXTURE_MD)
    assert after.endswith("## Probe\n\nA clean appended section.\n")


def test_when_section_carries_frontmatter_shaped_prose_then_appends(
    tmp_path: Path,
) -> None:
    # Containment pin for the deliberate non-reuse of the ADD smuggle gate: the
    # section lands BELOW the anchor, where these tokens are ordinary prose, so
    # refusing them here would make EXTEND stricter than ADD rather than equal.
    md = _seed_store(tmp_path)
    section_file = tmp_path / "section.md"
    section_file.write_text(
        "## Tool policy\n\ntools: the allowlist is frozen at spawn.\n", encoding="utf-8"
    )

    assert _extend(tmp_path, section_file) == EXIT_OK
    assert "tools: the allowlist is frozen at spawn." in md.read_text(encoding="utf-8")
