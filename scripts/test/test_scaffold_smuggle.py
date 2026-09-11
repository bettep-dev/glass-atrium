"""Behavioral tests for the scaffold body structure gate.

Covers `scaffold.assert_body_no_smuggled_structure` — the ADD-path input gate
that refuses an authored body carrying a frontmatter-shaped guarded key, a
leading frontmatter fence, or the retired `> Rules:` header line:

  - quoted key spellings (`"tools":` / `'tools':`) are recognized exactly like
    the bare spelling — the host YAML parser folds the quotes, so a quote-blind
    gate would let a shadowing key through.
  - the bare spelling and the leading-`---` fence keep blocking (non-regression).
  - a guarded key is refused WHEREVER it appears, a heading above it included —
    the scan covers the whole body, so there is no position that tolerates one.
  - the guarded WORD mid-sentence in prose stays ordinary prose (containment).

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
    BodyAnchorError,
    BodyFrontmatterError,
    assert_body_no_smuggled_structure,
)

_RETIRED_ANCHOR = "> Rules: GLASS_ATRIUM_GLOBAL_RULES.md (ALL + DEV)"


def _body(head: str) -> str:
    """An authored body opening with `head`."""
    return f"{head}\n\n# dev-x\n\nAuthored body.\n"


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
def test_when_quoted_guarded_key_then_halts(head: str) -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_structure(_body(head))


def test_when_quoted_key_indented_then_halts() -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_structure(_body('  "tools": [Bash]'))


def test_when_both_quoted_duplicate_keys_then_halts() -> None:
    # Duplicate spelling of a guarded key: the gate refuses ANY occurrence, so
    # the second one needs no separate seen-set — pinned so a later relaxation
    # of the single-occurrence rule cannot silently reopen the duplicate vector.
    head = '"tools": [Read]\n"tools": [Read, Bash]'
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_structure(_body(head))


def test_when_quoted_key_reported_then_message_names_the_key() -> None:
    with pytest.raises(BodyFrontmatterError, match="'tools'"):
        assert_body_no_smuggled_structure(_body('"tools": [Bash]'))


def test_when_guarded_key_below_a_heading_then_halts() -> None:
    # The pin this gate change buys: a heading no longer opens a tolerated zone,
    # so a guarded key under one is refused exactly like one at the top.
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_structure('# dev-x\n\n"tools": [Read, Bash]\n')


# --- non-regression: shapes that already blocked ---------------------------


def test_when_bare_guarded_key_then_halts() -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_structure(_body("tools: [Read, Bash]"))


def test_when_body_starts_with_fence_then_halts() -> None:
    with pytest.raises(BodyFrontmatterError):
        assert_body_no_smuggled_structure("---\ntools: [Bash]\n---\n\n# dev-x\n")


# --- containment: the same tokens as ordinary prose ------------------------


def test_when_guarded_word_in_prose_then_passes() -> None:
    body = '# dev-x\n\nThe "tools" allowlist is frozen at spawn.\n'
    assert_body_no_smuggled_structure(body)


# --- the retired `> Rules:` header line ------------------------------------


def test_when_body_carries_retired_anchor_then_halts() -> None:
    # Refusal, not a silent strip: the line claims a rule membership the registry
    # row now owns, so a body reused from before the retirement needs an operator.
    with pytest.raises(BodyAnchorError):
        assert_body_no_smuggled_structure(_body(_RETIRED_ANCHOR))


def test_when_retired_anchor_sits_below_a_heading_then_halts() -> None:
    with pytest.raises(BodyAnchorError):
        assert_body_no_smuggled_structure(f"# dev-x\n\n{_RETIRED_ANCHOR}\n")


def test_when_quote_opens_a_non_guarded_key_then_passes() -> None:
    assert_body_no_smuggled_structure(_body('"domains": [a, b]'))


def test_when_plain_body_then_passes() -> None:
    assert_body_no_smuggled_structure(_body("# dev-x"))
