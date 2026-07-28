"""Behavioral tests for the scaffold body frontmatter-smuggle gate.

Covers `scaffold.assert_body_no_smuggled_frontmatter` — the ADD-path input gate
that refuses an authored body carrying a frontmatter-shaped guarded key above
the `> Rules:` anchor:

  - quoted key spellings (`"tools":` / `'tools':`) are recognized exactly like
    the bare spelling — the host YAML parser folds the quotes, so a quote-blind
    gate would let a shadowing key through.
  - the bare spelling and the leading-`---` fence keep blocking (non-regression).
  - the same tokens BELOW the anchor stay ordinary prose (containment).

Self-contained: inserts the scripts root on sys.path (no live store touched).

Run with:
    PYTHONPATH=scripts uv run --python 3.13 --with pytest pytest \
        scripts/test/test_scaffold_smuggle.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle.scaffold import (  # noqa: E402
    BodyFrontmatterError,
    assert_body_no_smuggled_frontmatter,
)

_ANCHOR = "> Rules: GLASS_ATRIUM_GLOBAL_RULES.md (ALL + DEV)"


def _body(head: str) -> str:
    """An authored body with `head` above the canonical anchor."""
    return f"{head}\n\n{_ANCHOR}\n\n# dev-x\n\nAuthored body.\n"


# --- quoted guarded keys: the quote-blind bypass ---------------------------


@pytest.mark.parametrize(
    "head",
    [
        '"tools": [Read, Glob, Grep, Edit, Write, Bash]',
        "'tools': [Read, Glob, Grep, Edit, Write, Bash]",
        '"name": glass-atrium-dev-x',
        '"scope": DEV',
        "'maxTurns': 400",
    ],
)
def test_when_quoted_guarded_key_above_anchor_then_halts(head: str) -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_frontmatter(_body(head))


def test_when_quoted_key_indented_then_halts() -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_frontmatter(_body('  "tools": [Bash]'))


def test_when_both_quoted_duplicate_keys_then_halts() -> None:
    # Duplicate spelling of a guarded key: the gate refuses ANY occurrence, so
    # the second one needs no separate seen-set — pinned so a later relaxation
    # of the single-occurrence rule cannot silently reopen the duplicate vector.
    head = '"tools": [Read]\n"tools": [Read, Bash]'
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_frontmatter(_body(head))


def test_when_quoted_key_reported_then_message_names_the_key() -> None:
    with pytest.raises(BodyFrontmatterError, match="'tools'"):
        assert_body_no_smuggled_frontmatter(_body('"tools": [Bash]'))


def test_when_body_has_no_anchor_then_quoted_key_still_halts() -> None:
    # No anchor -> the whole body is the pre-anchor head (render injects the
    # canonical anchor above it), so the key would still land above the content.
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_frontmatter('"tools": [Bash]\n\n# dev-x\n')


# --- non-regression: shapes that already blocked ---------------------------


def test_when_bare_guarded_key_above_anchor_then_halts() -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_frontmatter(_body("tools: [Read, Bash]"))


def test_when_body_starts_with_fence_then_halts() -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_frontmatter("---\ntools: [Bash]\n---\n\n# dev-x\n")


# --- containment: the same tokens as ordinary prose ------------------------


def test_when_quoted_key_below_anchor_then_passes() -> None:
    body = f'{_ANCHOR}\n\n# dev-x\n\n"tools": [Read, Bash]\n'
    assert_body_no_smuggled_frontmatter(body)


def test_when_guarded_word_in_prose_then_passes() -> None:
    body = f'{_ANCHOR}\n\n# dev-x\n\nThe "tools" allowlist is frozen at spawn.\n'
    assert_body_no_smuggled_frontmatter(body)


def test_when_quote_opens_a_non_guarded_key_then_passes() -> None:
    assert_body_no_smuggled_frontmatter(_body('"domains": [a, b]'))


def test_when_plain_body_then_passes() -> None:
    assert_body_no_smuggled_frontmatter(_body("# dev-x"))
