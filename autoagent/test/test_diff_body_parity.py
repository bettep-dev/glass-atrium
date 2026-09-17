"""Parity + offender tests for the single diff body reading in ``daemon_cycle``.

The applier runs ``git apply --recount`` (``autoagent/daemon-apply.sh``), which
applies every ``+``/``-`` line after the first ``@@`` as body — ``+++ ``/``--- ``
included. The safety/count sites must read a diff the same way, so a raw line
starting ``+++``/``---`` can no longer slip past the safety tier or the auto cap.

Two contracts are pinned here:
  * offender rows — shapes HEAD ``becfb284`` misread; each asserts the strict verdict;
  * parity rows — the shared fixture replayed against the HEAD baseline below; the
    new reading may only be STRICTER (safety kept, counts never lower, frontmatter
    identical, a removal refusal kept).

Run: python3 -m unittest autoagent.test.test_diff_body_parity -v
"""

from __future__ import annotations

import itertools
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

# Tokens split so this file never embeds a literal dangerous command
# (test_sensitive_patterns.py convention).
_RM = "r" "m"
_SENSITIVE = f"{_RM} -rf /tmp/x"
_FORCE_PUSH = "git push --force origin main"
_BENIGN = "plain note"
_TARGET = "agents/glass-atrium-dev-x.md"

# The only loosenings the body-reading change may introduce, both owned by the
# header/auxiliary sites. No stream-1 site (safety, counts, fragment split) is on it.
_ALLOWED_LOOSENINGS: frozenset[str] = frozenset(
    {
        "f2-basename-quoted-path-correction",
        "hook-touch-true-reduces-prose-only-add-warning",
    }
)

_PROBE_KINDS: dict[str, tuple[str, str]] = {
    # kind → (raw prefix, side) — side decides the hunk count bookkeeping
    "add": ("+", "new"),
    "remove": ("-", "old"),
    "context": (" ", "both"),
    "add2": ("++ ", "new"),
    "add3": ("+++ ", "new"),
    "remove3": ("--- ", "old"),
    "add3nospace": ("+++", "new"),
    "addfm": ("+name: ", "new"),
}
_CONTENTS: dict[str, str] = {"sensitive": _SENSITIVE, "benign": _BENIGN}


def _hunk(probe_prefix: str, side: str, content: str, *, valid: bool) -> str:
    old = 2 + (side in ("old", "both"))
    new = 2 + (side in ("new", "both"))
    skew = 0 if valid else 1
    return (
        f"@@ -1,{old + skew} +1,{new + skew} @@\n"
        f" ctx top\n{probe_prefix}{content}\n ctx bottom\n"
    )


def _build_diff(shape: str, hunk: str) -> str:
    headers = f"--- a/{_TARGET}\n+++ b/{_TARGET}\n"
    match shape:
        case "git":
            return headers + hunk
        case "gitmeta":
            return f"diff --git a/{_TARGET} b/{_TARGET}\nindex 1111111..2222222 100644\n" + headers + hunk
        case "twohunk":
            return headers + hunk + "@@ -10,1 +10,1 @@\n-a\n+b\n"
        case "fragment_hunk":
            return hunk
        case "fragment_bare":
            return "".join(line + "\n" for line in hunk.splitlines()[1:])
        case "crlf":
            return (headers + hunk).replace("\n", "\r\n")
        case "devnull":
            return f"--- /dev/null\n+++ b/{_TARGET}\n" + hunk
        case "quoted":
            return '--- "a/agents/dev x.md"\n+++ "b/agents/dev x.md"\n' + hunk
        case "nonewline":
            return headers + hunk + "\\ No newline at end of file\n"
    raise ValueError(shape)


_SHAPES: tuple[str, ...] = (
    "git", "gitmeta", "twohunk", "fragment_hunk", "fragment_bare",
    "crlf", "devnull", "quoted", "nonewline",
)


def _offender_rows() -> dict[str, str]:
    """Shapes HEAD misread: a raw '+++'/'---' line read as a file header."""
    headers = f"--- a/{_TARGET}\n+++ b/{_TARGET}\n"
    return {
        "offender_add3_rm": headers + f"@@ -1,1 +1,2 @@\n ctx\n+++ {_SENSITIVE}\n",
        "offender_add3_force_push": headers + f"@@ -1,1 +1,2 @@\n ctx\n+++ {_FORCE_PUSH}\n",
        "offender_add3_eight_lines": headers
        + "@@ -1,1 +1,9 @@\n ctx\n"
        + "".join(f"+++ i{n}\n" for n in range(1, 9)),
        "offender_inhunk_header_u0": headers
        + f"@@ -3 +3 @@\n--- old\n+++ {_SENSITIVE}\n@@ -9 +9 @@\n-a\n+b\n",
        "offender_inhunk_header_counts_valid": headers
        + f"@@ -1,3 +1,3 @@\n ctx\n--- old\n+++ {_SENSITIVE}\n ctx\n"
        + "@@ -10,2 +10,2 @@\n ctx\n-a\n+b\n",
        "offender_inhunk_header_counts_wrong": headers
        + f"@@ -1,7 +1,1 @@\n ctx\n--- old\n+++ {_SENSITIVE}\n ctx\n"
        + "@@ -10,5 +10,9 @@\n ctx\n-a\n+b\n",
    }


def _fixture_rows() -> dict[str, str]:
    rows: dict[str, str] = {}
    for shape, kind, content_name, valid in itertools.product(
        _SHAPES, _PROBE_KINDS, _CONTENTS, (True, False)
    ):
        prefix, side = _PROBE_KINDS[kind]
        hunk = _hunk(prefix, side, _CONTENTS[content_name], valid=valid)
        row_id = f"{shape}:{kind}:{content_name}:{'valid' if valid else 'skewed'}"
        rows[row_id] = _build_diff(shape, hunk)
    rows.update(_offender_rows())
    return rows


def _site_results(diff: str) -> dict[str, object]:
    """Every stream-1 site's verdict over one diff (pure functions, no model call)."""
    touches = dc._diff_touches_frontmatter(diff)
    patch = dc.PatchProposal(
        target_file=_TARGET,
        rationale="parity",
        proposed_diff=diff,
        touched_frontmatter=touches,
        estimated_added_lines=0,
        raw_response="",
    )
    _context, added, removed = dc._split_fragment_lines(diff)
    return {
        "safety": dc.classify_safety_tier(patch),
        "sensitive_hit": dc.match_sensitive_diff(diff) is not None,
        "added": dc._count_added_lines(diff),
        "removed": dc._count_removed_lines(diff),
        "split_added": len(added),
        "split_removed": len(removed),
        "added_content": len(dc._added_content_lines(diff)),
        "frontmatter": touches,
        "replace_shape": dc._diff_is_replace_shape(diff),
        "counts_valid": dc._unified_diff_counts_valid(diff),
    }


# HEAD becfb284 verdicts over _fixture_rows(), recorded before the body-reading change.
# `counts_valid` is recorded only — `_unified_diff_counts_valid` belongs to the recount site.
_BASELINE_KEYS: tuple[str, ...] = ('safety', 'sensitive_hit', 'added', 'removed', 'split_added', 'split_removed', 'added_content', 'frontmatter', 'replace_shape', 'counts_valid')
_HEAD_BASELINE: dict[str, tuple[object, ...]] = {
    'git:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'git:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'git:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'git:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'git:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'git:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'git:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'git:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'git:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'git:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'git:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'git:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'git:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'git:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'git:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'git:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'git:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'git:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'git:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'git:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'git:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'gitmeta:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'gitmeta:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'gitmeta:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'gitmeta:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'gitmeta:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'gitmeta:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'gitmeta:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'gitmeta:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'gitmeta:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'gitmeta:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'gitmeta:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'gitmeta:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'gitmeta:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'gitmeta:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'gitmeta:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'gitmeta:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'gitmeta:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'gitmeta:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'gitmeta:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'gitmeta:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'gitmeta:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'twohunk:add:sensitive:valid': ('safety', True, 2, 1, 2, 1, 2, False, True, True),
    'twohunk:add:sensitive:skewed': ('safety', True, 2, 1, 2, 1, 2, False, True, False),
    'twohunk:add:benign:valid': ('', False, 2, 1, 2, 1, 2, False, True, True),
    'twohunk:add:benign:skewed': ('', False, 2, 1, 2, 1, 2, False, True, False),
    'twohunk:remove:sensitive:valid': ('', False, 1, 2, 1, 2, 1, False, True, True),
    'twohunk:remove:sensitive:skewed': ('', False, 1, 2, 1, 2, 1, False, True, False),
    'twohunk:remove:benign:valid': ('', False, 1, 2, 1, 2, 1, False, True, True),
    'twohunk:remove:benign:skewed': ('', False, 1, 2, 1, 2, 1, False, True, False),
    'twohunk:context:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, True),
    'twohunk:context:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:context:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, True),
    'twohunk:context:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:add2:sensitive:valid': ('safety', True, 2, 1, 2, 1, 2, False, True, True),
    'twohunk:add2:sensitive:skewed': ('safety', True, 2, 1, 2, 1, 2, False, True, False),
    'twohunk:add2:benign:valid': ('', False, 2, 1, 2, 1, 2, False, True, True),
    'twohunk:add2:benign:skewed': ('', False, 2, 1, 2, 1, 2, False, True, False),
    'twohunk:add3:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:add3:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:add3:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:add3:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:remove3:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:remove3:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:remove3:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:remove3:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:add3nospace:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, True),
    'twohunk:add3nospace:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:add3nospace:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, True),
    'twohunk:add3nospace:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'twohunk:addfm:sensitive:valid': ('safety', True, 2, 1, 2, 1, 2, True, True, True),
    'twohunk:addfm:sensitive:skewed': ('safety', True, 2, 1, 2, 1, 2, True, True, False),
    'twohunk:addfm:benign:valid': ('safety', False, 2, 1, 2, 1, 2, True, True, True),
    'twohunk:addfm:benign:skewed': ('safety', False, 2, 1, 2, 1, 2, True, True, False),
    'fragment_hunk:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'fragment_hunk:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'fragment_hunk:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'fragment_hunk:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'fragment_hunk:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'fragment_hunk:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'fragment_hunk:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'fragment_hunk:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'fragment_hunk:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_hunk:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_hunk:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'fragment_hunk:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'fragment_hunk:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'fragment_hunk:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'fragment_hunk:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_hunk:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_hunk:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'fragment_hunk:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'fragment_hunk:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'fragment_hunk:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'fragment_hunk:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'fragment_bare:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'fragment_bare:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'fragment_bare:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'fragment_bare:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'fragment_bare:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'fragment_bare:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'fragment_bare:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'fragment_bare:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'fragment_bare:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'fragment_bare:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'crlf:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'crlf:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'crlf:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'crlf:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'crlf:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'crlf:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'crlf:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'crlf:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'crlf:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'crlf:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'crlf:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'crlf:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'crlf:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'crlf:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'crlf:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'crlf:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'crlf:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'crlf:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'crlf:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'crlf:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'crlf:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'devnull:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'devnull:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'devnull:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'devnull:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'devnull:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'devnull:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'devnull:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'devnull:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'devnull:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'devnull:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'devnull:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'devnull:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'devnull:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'devnull:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'devnull:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'devnull:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'devnull:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'devnull:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'devnull:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'devnull:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'devnull:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'quoted:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'quoted:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'quoted:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'quoted:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'quoted:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'quoted:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'quoted:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'quoted:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'quoted:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'quoted:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'quoted:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'quoted:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'quoted:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'quoted:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'quoted:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'quoted:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'quoted:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'quoted:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'quoted:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'quoted:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'quoted:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'nonewline:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'nonewline:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'nonewline:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'nonewline:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'nonewline:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'nonewline:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'nonewline:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True),
    'nonewline:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False),
    'nonewline:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'nonewline:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'nonewline:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True),
    'nonewline:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False),
    'nonewline:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True),
    'nonewline:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False),
    'nonewline:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'nonewline:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True),
    'nonewline:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'nonewline:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True),
    'nonewline:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False),
    'nonewline:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True),
    'nonewline:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False),
    'offender_add3_rm': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'offender_add3_force_push': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'offender_add3_eight_lines': ('', False, 0, 0, 0, 0, 0, False, False, False),
    'offender_inhunk_header_u0': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'offender_inhunk_header_counts_valid': ('', False, 1, 1, 1, 1, 1, False, True, False),
    'offender_inhunk_header_counts_wrong': ('', False, 1, 1, 1, 1, 1, False, True, False),
}


def _is_not_looser(column: str, head: object, new: object) -> bool:
    match column:
        case "safety":
            return head != "safety" or new == "safety"
        case "sensitive_hit" | "replace_shape":
            return not head or bool(new)
        case "added" | "removed" | "split_added" | "split_removed" | "added_content":
            return int(new) >= int(head)  # type: ignore[call-overload]
        case "frontmatter":
            return head == new
        case "counts_valid":
            return True
    raise KeyError(column)


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class OffenderRowsReadAsBody(unittest.TestCase):
    """Raw '+++'/'---' lines inside a hunk are body, exactly as git apply --recount applies them."""

    def setUp(self) -> None:
        self.rows = _offender_rows()

    def _results(self, row_id: str) -> dict[str, object]:
        return _site_results(self.rows[row_id])

    def test_should_classify_safety_when_raw_triple_plus_line_carries_a_sensitive_command(self) -> None:
        for row_id in ("offender_add3_rm", "offender_add3_force_push"):
            with self.subTest(row_id):
                self.assertEqual(self._results(row_id)["safety"], "safety")
                self.assertTrue(self._results(row_id)["sensitive_hit"])

    def test_should_count_every_raw_triple_plus_line_as_added(self) -> None:
        results = self._results("offender_add3_eight_lines")
        for column in ("added", "split_added", "added_content"):
            with self.subTest(column):
                self.assertEqual(results[column], 8)

    def test_should_classify_safety_and_count_when_a_header_shape_sits_inside_a_hunk(self) -> None:
        for row_id in (
            "offender_inhunk_header_u0",
            "offender_inhunk_header_counts_valid",
            "offender_inhunk_header_counts_wrong",
        ):
            with self.subTest(row_id):
                results = self._results(row_id)
                self.assertEqual(results["safety"], "safety")
                self.assertEqual((results["added"], results["removed"]), (2, 2))
                self.assertEqual((results["split_added"], results["split_removed"]), (2, 2))


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class BodyReadingNeverLoosensHeadVerdicts(unittest.TestCase):
    """Every fixture row: the new reading is at least as strict as HEAD becfb284."""

    def test_should_cover_the_whole_fixture_in_the_baseline(self) -> None:
        self.assertEqual(set(_HEAD_BASELINE), set(_fixture_rows()))

    def test_should_keep_every_head_verdict_or_tighten_it(self) -> None:
        for row_id, diff in _fixture_rows().items():
            results = _site_results(diff)
            for column, head in zip(_BASELINE_KEYS, _HEAD_BASELINE[row_id], strict=True):
                with self.subTest(row=row_id, column=column):
                    self.assertTrue(
                        _is_not_looser(column, head, results[column]),
                        msg=f"HEAD={head!r} new={results[column]!r}",
                    )

    def test_should_allow_only_the_two_header_site_loosenings(self) -> None:
        self.assertEqual(
            _ALLOWED_LOOSENINGS,
            {
                "f2-basename-quoted-path-correction",
                "hook-touch-true-reduces-prose-only-add-warning",
            },
        )
