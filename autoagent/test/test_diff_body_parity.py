"""Parity + offender tests for the single diff body reading in ``daemon_cycle``.

The applier runs ``git apply --recount`` (``autoagent/daemon-apply.sh``), which
applies every ``+``/``-`` line after the first ``@@`` as body — ``+++ ``/``--- ``
included. The safety/count sites must read a diff the same way, so a raw line
starting ``+++``/``---`` can no longer slip past the safety tier or the auto cap.

Two contracts are pinned here:
  * offender rows — shapes HEAD ``becfb284`` misread; each asserts the strict verdict;
  * parity rows — the shared fixture replayed against the HEAD baseline below; the
    new reading may only be STRICTER (safety kept, counts never lower, frontmatter
    identical, an F2 rejection kept), apart from the rows tagged in
    ``_LOOSENING_ROWS`` with one of the two allowed loosenings.

Run: python3 -m unittest autoagent.test.test_diff_body_parity -v
"""

from __future__ import annotations

import itertools
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
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


def _aux_rows() -> dict[str, str]:
    """Header/auxiliary-site shapes: quoted and hook headers, file deletes, a ``-- `` removal."""
    headers = f"--- a/{_TARGET}\n+++ b/{_TARGET}\n"
    return {
        "aux_quoted_target_header": f'--- "a/{_TARGET}"\n+++ "b/{_TARGET}"\n'
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n",
        "aux_quoted_hook_header": '--- "a/hooks/x y.sh"\n+++ "b/hooks/x y.sh"\n'
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n",
        "aux_body_hook_line": headers + "@@ -1,1 +1,2 @@\n ctx\n+++ hooks/x.sh\n",
        "aux_delete_whole_file": f"--- a/{_TARGET}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
        "aux_delete_later_section": headers
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n"
        + f"--- a/{_TARGET}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n",
        "aux_dash_content_removal": headers + "@@ -1,3 +1,2 @@\n ctx\n--- old dash rule\n ctx\n",
        # Escapes git's unquote_c_style rejects: git apply then reads the header raw, quotes kept.
        "aux_quoted_octal_out_of_range": '--- "a/agents/x\\777.md"\n+++ "b/agents/x\\777.md"\n'
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n",
        "aux_quoted_truncated_escape_hook": '--- "a/hooks/x\\1.sh"\n+++ "b/hooks/x\\1.sh"\n'
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n",
        "aux_quoted_trailing_backslash_hook": '--- "a/hooks/x.sh\\"\n+++ "b/hooks/x.sh\\"\n'
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n",
        "aux_quoted_unknown_escape_target": f'--- "a/{_TARGET[:-2]}\\md"\n+++ "b/{_TARGET[:-2]}\\md"\n'
        + "@@ -1,1 +1,2 @@\n ctx\n+line\n",
    }


# Rows whose HEAD verdict the new reading loosens, each by an allowed loosening.
_LOOSENING_ROWS: dict[str, str] = {
    "aux_quoted_target_header": "f2-basename-quoted-path-correction",
    "aux_quoted_hook_header": "hook-touch-true-reduces-prose-only-add-warning",
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
    rows.update(_aux_rows())
    return rows


def _site_results(diff: str) -> dict[str, object]:
    """Every body-reading and header-site verdict over one diff (pure functions, no model call)."""
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
        **_recount_totals(dc._recount_hunk_header(diff)),
        "f2_reject": _is_f2_rejected(diff),
        "hook_touch": dc._diff_touches_hook_file(diff, _TARGET),
        "landed_added": _count_landed_pieces(diff),
        "reference_added": len(dc._iter_added_reference_lines(diff)),
    }


def _recount_totals(diff: str) -> dict[str, int]:
    """Old/new line totals over every recounted ``@@`` header (git's omitted length = 1)."""
    old = new = 0
    for line in diff.splitlines():
        match = dc._UNIFIED_HUNK_CAPTURE_RE.match(line)
        if match:
            old += int(match.group(2) or 1)
            new += int(match.group(4) or 1)
    return {"recount_old": old, "recount_new": new}


def _is_f2_rejected(diff: str) -> bool:
    """The F2 gate's header verdicts, run before any git apply: a file delete or a wrong target."""
    declared = dc._diff_header_target_basename(diff)
    return dc._diff_deletes_file(diff) or declared not in (None, Path(_TARGET).name)


def _count_landed_pieces(diff: str) -> int:
    rendered = dc._render_landed_history_block([("parity", diff)])
    return 0 if "(no added lines recorded)" in rendered else rendered.count(" / ") + 1


# HEAD becfb284 verdicts over _fixture_rows(), recorded before the body-reading change.
# `counts_valid` is recorded only: it follows the recount columns, which carry the verdict.
# HEAD had no file-delete rejection, so its `f2_reject` column is the basename verdict alone.
_BASELINE_KEYS: tuple[str, ...] = ('safety', 'sensitive_hit', 'added', 'removed', 'split_added', 'split_removed', 'added_content', 'frontmatter', 'replace_shape', 'counts_valid', 'recount_old', 'recount_new', 'f2_reject', 'hook_touch', 'landed_added', 'reference_added')
_HEAD_BASELINE: dict[str, tuple[object, ...]] = {
    'git:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'git:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'git:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'git:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'git:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'git:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'git:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'git:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'git:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'git:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'git:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'git:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'git:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'git:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'git:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'git:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'git:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'git:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'git:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'git:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'git:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'git:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'git:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'git:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'git:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'gitmeta:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'gitmeta:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'gitmeta:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'gitmeta:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'gitmeta:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'gitmeta:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'gitmeta:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'gitmeta:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'gitmeta:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'gitmeta:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'gitmeta:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'gitmeta:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'gitmeta:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'gitmeta:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'gitmeta:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'gitmeta:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'gitmeta:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'gitmeta:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'gitmeta:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'gitmeta:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'gitmeta:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'gitmeta:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'gitmeta:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'gitmeta:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'gitmeta:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'twohunk:add:sensitive:valid': ('safety', True, 2, 1, 2, 1, 2, False, True, True, 3, 4, False, False, 2, 2),
    'twohunk:add:sensitive:skewed': ('safety', True, 2, 1, 2, 1, 2, False, True, False, 3, 4, False, False, 2, 2),
    'twohunk:add:benign:valid': ('', False, 2, 1, 2, 1, 2, False, True, True, 3, 4, False, False, 2, 2),
    'twohunk:add:benign:skewed': ('', False, 2, 1, 2, 1, 2, False, True, False, 3, 4, False, False, 2, 2),
    'twohunk:remove:sensitive:valid': ('', False, 1, 2, 1, 2, 1, False, True, True, 4, 3, False, False, 1, 1),
    'twohunk:remove:sensitive:skewed': ('', False, 1, 2, 1, 2, 1, False, True, False, 4, 3, False, False, 1, 1),
    'twohunk:remove:benign:valid': ('', False, 1, 2, 1, 2, 1, False, True, True, 4, 3, False, False, 1, 1),
    'twohunk:remove:benign:skewed': ('', False, 1, 2, 1, 2, 1, False, True, False, 4, 3, False, False, 1, 1),
    'twohunk:context:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, True, 4, 4, False, False, 1, 1),
    'twohunk:context:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 4, 4, False, False, 1, 1),
    'twohunk:context:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, True, 4, 4, False, False, 1, 1),
    'twohunk:context:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 4, 4, False, False, 1, 1),
    'twohunk:add2:sensitive:valid': ('safety', True, 2, 1, 2, 1, 2, False, True, True, 3, 4, False, False, 2, 2),
    'twohunk:add2:sensitive:skewed': ('safety', True, 2, 1, 2, 1, 2, False, True, False, 3, 4, False, False, 2, 2),
    'twohunk:add2:benign:valid': ('', False, 2, 1, 2, 1, 2, False, True, True, 3, 4, False, False, 2, 2),
    'twohunk:add2:benign:skewed': ('', False, 2, 1, 2, 1, 2, False, True, False, 3, 4, False, False, 2, 2),
    'twohunk:add3:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:add3:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:add3:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:add3:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:remove3:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:remove3:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:remove3:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:remove3:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 2, 2, False, False, 1, 1),
    'twohunk:add3nospace:sensitive:valid': ('', False, 1, 1, 1, 1, 1, False, True, True, 3, 4, False, False, 1, 1),
    'twohunk:add3nospace:sensitive:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 3, 4, False, False, 1, 1),
    'twohunk:add3nospace:benign:valid': ('', False, 1, 1, 1, 1, 1, False, True, True, 3, 4, False, False, 1, 1),
    'twohunk:add3nospace:benign:skewed': ('', False, 1, 1, 1, 1, 1, False, True, False, 3, 4, False, False, 1, 1),
    'twohunk:addfm:sensitive:valid': ('safety', True, 2, 1, 2, 1, 2, True, True, True, 3, 4, False, False, 2, 2),
    'twohunk:addfm:sensitive:skewed': ('safety', True, 2, 1, 2, 1, 2, True, True, False, 3, 4, False, False, 2, 2),
    'twohunk:addfm:benign:valid': ('safety', False, 2, 1, 2, 1, 2, True, True, True, 3, 4, False, False, 2, 2),
    'twohunk:addfm:benign:skewed': ('safety', False, 2, 1, 2, 1, 2, True, True, False, 3, 4, False, False, 2, 2),
    'fragment_hunk:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'fragment_hunk:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'fragment_hunk:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'fragment_hunk:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'fragment_hunk:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'fragment_hunk:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'fragment_hunk:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'fragment_hunk:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'fragment_hunk:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'fragment_hunk:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'fragment_hunk:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'fragment_hunk:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'fragment_hunk:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'fragment_hunk:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'fragment_hunk:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'fragment_hunk:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'fragment_hunk:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'fragment_hunk:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'fragment_hunk:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'fragment_hunk:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'fragment_hunk:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'fragment_hunk:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'fragment_hunk:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'fragment_hunk:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'fragment_hunk:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, True, False, 0, 0),
    'fragment_hunk:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, True, False, 0, 0),
    'fragment_hunk:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, True, False, 0, 0),
    'fragment_hunk:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, True, False, 0, 0),
    'fragment_hunk:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'fragment_hunk:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'fragment_hunk:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'fragment_hunk:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'fragment_bare:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, False, False, 0, 0),
    'fragment_bare:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, True, 0, 0, True, False, 0, 0),
    'fragment_bare:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 0, 0, False, False, 1, 1),
    'fragment_bare:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 0, 0, False, False, 1, 1),
    'crlf:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'crlf:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'crlf:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'crlf:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'crlf:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'crlf:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'crlf:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'crlf:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'crlf:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'crlf:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'crlf:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'crlf:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'crlf:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'crlf:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'crlf:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'crlf:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'crlf:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'crlf:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'crlf:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'crlf:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'crlf:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'crlf:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'crlf:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'crlf:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'crlf:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'devnull:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'devnull:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'devnull:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'devnull:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'devnull:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'devnull:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'devnull:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'devnull:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'devnull:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'devnull:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'devnull:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'devnull:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'devnull:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'devnull:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'devnull:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'devnull:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'devnull:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'devnull:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'devnull:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'devnull:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'devnull:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'devnull:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'devnull:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'devnull:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'devnull:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'quoted:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, True, False, 1, 1),
    'quoted:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, True, False, 1, 1),
    'quoted:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, True, False, 1, 1),
    'quoted:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, True, False, 1, 1),
    'quoted:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, True, False, 0, 0),
    'quoted:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, True, False, 0, 0),
    'quoted:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, True, False, 0, 0),
    'quoted:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, True, False, 0, 0),
    'quoted:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, True, False, 0, 0),
    'quoted:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, True, False, 0, 0),
    'quoted:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, True, False, 0, 0),
    'quoted:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, True, False, 0, 0),
    'quoted:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, True, False, 1, 1),
    'quoted:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, True, False, 1, 1),
    'quoted:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, True, False, 1, 1),
    'quoted:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, True, False, 1, 1),
    'quoted:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, True, False, 0, 0),
    'quoted:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, True, False, 0, 0),
    'quoted:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, True, False, 0, 0),
    'quoted:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, True, False, 0, 0),
    'quoted:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, True, False, 0, 0),
    'quoted:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, True, False, 1, 1),
    'quoted:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, True, False, 1, 1),
    'quoted:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, True, False, 1, 1),
    'quoted:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, True, False, 1, 1),
    'nonewline:add:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'nonewline:add:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'nonewline:add:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'nonewline:add:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'nonewline:remove:sensitive:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'nonewline:remove:sensitive:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'nonewline:remove:benign:valid': ('', False, 0, 1, 0, 1, 0, False, False, True, 3, 2, False, False, 0, 0),
    'nonewline:remove:benign:skewed': ('', False, 0, 1, 0, 1, 0, False, False, False, 3, 2, False, False, 0, 0),
    'nonewline:context:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'nonewline:context:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'nonewline:context:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 3, 3, False, False, 0, 0),
    'nonewline:context:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 3, 3, False, False, 0, 0),
    'nonewline:add2:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'nonewline:add2:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'nonewline:add2:benign:valid': ('', False, 1, 0, 1, 0, 1, False, False, True, 2, 3, False, False, 1, 1),
    'nonewline:add2:benign:skewed': ('', False, 1, 0, 1, 0, 1, False, False, False, 2, 3, False, False, 1, 1),
    'nonewline:add3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:add3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:add3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:add3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:remove3:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:remove3:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:remove3:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:remove3:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'nonewline:add3nospace:sensitive:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'nonewline:add3nospace:sensitive:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'nonewline:add3nospace:benign:valid': ('', False, 0, 0, 0, 0, 0, False, False, True, 2, 3, False, False, 0, 0),
    'nonewline:add3nospace:benign:skewed': ('', False, 0, 0, 0, 0, 0, False, False, False, 2, 3, False, False, 0, 0),
    'nonewline:addfm:sensitive:valid': ('safety', True, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'nonewline:addfm:sensitive:skewed': ('safety', True, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'nonewline:addfm:benign:valid': ('safety', False, 1, 0, 1, 0, 1, True, False, True, 2, 3, False, False, 1, 1),
    'nonewline:addfm:benign:skewed': ('safety', False, 1, 0, 1, 0, 1, True, False, False, 2, 3, False, False, 1, 1),
    'offender_add3_rm': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'offender_add3_force_push': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'offender_add3_eight_lines': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'offender_inhunk_header_u0': ('', False, 1, 1, 1, 1, 1, False, True, False, 1, 1, False, False, 1, 1),
    'offender_inhunk_header_counts_valid': ('', False, 1, 1, 1, 1, 1, False, True, False, 3, 3, False, False, 1, 1),
    'offender_inhunk_header_counts_wrong': ('', False, 1, 1, 1, 1, 1, False, True, False, 3, 3, False, False, 1, 1),
    'aux_quoted_target_header': ('', False, 1, 0, 1, 0, 1, False, False, True, 1, 2, True, False, 1, 1),
    'aux_quoted_hook_header': ('', False, 1, 0, 1, 0, 1, False, False, True, 1, 2, True, False, 1, 1),
    'aux_body_hook_line': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, True, 0, 0),
    'aux_delete_whole_file': ('', False, 0, 2, 0, 2, 0, False, False, True, 2, 0, True, False, 0, 0),
    'aux_delete_later_section': ('', False, 1, 1, 1, 1, 1, False, True, True, 2, 2, False, False, 1, 1),
    'aux_dash_content_removal': ('', False, 0, 0, 0, 0, 0, False, False, False, 1, 1, False, False, 0, 0),
    'aux_quoted_octal_out_of_range': ('', False, 1, 0, 1, 0, 1, False, False, True, 1, 2, True, False, 1, 1),
    'aux_quoted_truncated_escape_hook': ('', False, 1, 0, 1, 0, 1, False, False, True, 1, 2, True, False, 1, 1),
    'aux_quoted_trailing_backslash_hook': ('', False, 1, 0, 1, 0, 1, False, False, True, 1, 2, True, False, 1, 1),
    'aux_quoted_unknown_escape_target': ('', False, 1, 0, 1, 0, 1, False, False, True, 1, 2, True, False, 1, 1),
}


def _is_not_looser(column: str, head_row: dict[str, object], new_row: dict[str, object], row_id: str) -> bool:
    """One column's verdict against HEAD: equal where exact, monotone only where 결정 3 lets counts grow."""
    loosening = _LOOSENING_ROWS.get(row_id)
    head, new = head_row[column], new_row[column]
    is_reading_changed = any(_get_count(new_row, c) != _get_count(head_row, c) for c in ("added", "removed"))
    match column:
        case "safety":
            return head != "safety" or new == "safety"
        case "sensitive_hit" | "replace_shape":
            return not head or bool(new)
        case "added" | "removed" | "split_added" | "split_removed" | "added_content":
            return _get_count(new_row, column) >= _get_count(head_row, column)
        case "landed_added" | "reference_added":
            # Other readers of the added lines — they move in lockstep with `added`.
            growth = _get_count(new_row, "added") - _get_count(head_row, "added")
            return _get_count(new_row, column) - _get_count(head_row, column) == growth
        case "recount_old" | "recount_new":
            return head == new or (is_reading_changed and _get_count(new_row, column) >= _get_count(head_row, column))
        case "counts_valid":
            # Follows the recount, so it may flip only where the body reading itself changed.
            return head == new or is_reading_changed
        case "f2_reject":
            return not head or bool(new) or loosening == "f2-basename-quoted-path-correction"
        case "hook_touch":
            return bool(head) or not new or loosening == "hook-touch-true-reduces-prose-only-add-warning"
        case "frontmatter":
            return head == new
    raise KeyError(column)


def _get_count(row: dict[str, object], column: str) -> int:
    value = row[column]
    assert isinstance(value, int), f"{column} is not a count: {value!r}"
    return value


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
            head_row = dict(zip(_BASELINE_KEYS, _HEAD_BASELINE[row_id], strict=True))
            for column in _BASELINE_KEYS:
                with self.subTest(row=row_id, column=column):
                    self.assertTrue(
                        _is_not_looser(column, head_row, results, row_id),
                        msg=f"HEAD={head_row[column]!r} new={results[column]!r}",
                    )

    def test_should_tag_only_rows_the_new_reading_actually_loosens(self) -> None:
        self.assertLessEqual(set(_LOOSENING_ROWS.values()), _ALLOWED_LOOSENINGS)
        rows = _fixture_rows()
        for row_id in _LOOSENING_ROWS:
            with self.subTest(row_id):
                results = _site_results(rows[row_id])
                head = dict(zip(_BASELINE_KEYS, _HEAD_BASELINE[row_id], strict=True))
                self.assertTrue(
                    any(
                        not _is_not_looser(column, head, results, "")
                        for column in _BASELINE_KEYS
                    ),
                    msg="tagged row no longer loosens a HEAD verdict — drop its tag",
                )

    def test_should_allow_only_the_two_header_site_loosenings(self) -> None:
        self.assertEqual(
            _ALLOWED_LOOSENINGS,
            {
                "f2-basename-quoted-path-correction",
                "hook-touch-true-reduces-prose-only-add-warning",
            },
        )


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class HeaderSitesReadBodyLines(unittest.TestCase):
    """The recount, reference, landed-history and F2 sites share the one body reading."""

    def setUp(self) -> None:
        self.rows = {**_offender_rows(), **_aux_rows()}

    def test_should_keep_valid_counts_when_a_hunk_carries_dash_or_plus_content_lines(self) -> None:
        for row_id in ("aux_dash_content_removal", "offender_inhunk_header_counts_valid"):
            with self.subTest(row_id):
                diff = self.rows[row_id]
                self.assertEqual(dc._recount_hunk_header(diff), diff)
                self.assertTrue(dc._unified_diff_counts_valid(diff))

    def test_should_end_a_hunk_body_at_the_next_git_file_section(self) -> None:
        diff = (
            "diff --git a/one.md b/one.md\nindex 1111111..2222222 100644\n"
            "--- a/one.md\n+++ b/one.md\n@@ -1,2 +1,2 @@\n ctx\n--- old\n+++ new\n"
            "diff --git a/two.md b/two.md\nindex 3333333..4444444 100644\n"
            "--- a/two.md\n+++ b/two.md\n@@ -1,1 +1,1 @@\n-a\n+b\n"
        )
        self.assertEqual(dc._recount_hunk_header(diff), diff)

    def test_should_collect_raw_triple_plus_lines_as_added_references_and_landed_text(self) -> None:
        diff = self.rows["offender_add3_eight_lines"]
        self.assertEqual(dc._iter_added_reference_lines(diff), [f"++ i{n}" for n in range(1, 9)])
        self.assertEqual(_count_landed_pieces(diff), 8)

    def test_should_count_a_column_zero_at_sign_body_line_as_context_as_git_recount_does(self) -> None:
        # git's recount_diff ends a hunk body only at "@@ " or "diff ", never at "@@x".
        diff = f"--- a/{_TARGET}\n+++ b/{_TARGET}\n@@ -1,4 +1,4 @@\n ctx\n@@x\n-a\n+b\n ctx\n"
        self.assertEqual(dc._recount_hunk_header(diff), diff)

    def test_should_read_an_in_hunk_dash_plus_pair_with_no_hunk_after_it_as_body_not_a_header(self) -> None:
        diff = f"--- a/{_TARGET}\n+++ b/{_TARGET}\n@@ -1,2 +1,2 @@\n ctx\n--- a/hooks/x.sh\n+++ /dev/null\n"
        self.assertFalse(dc._diff_deletes_file(diff))
        self.assertFalse(dc._diff_touches_hook_file(diff, _TARGET))

    def test_should_read_a_header_git_cannot_unquote_as_raw_text_at_every_header_site(self) -> None:
        budget = '--- "a/scoped/shared-turn-budget.md\\777"\n+++ "b/scoped/shared-turn-budget.md\\777"\n'
        self.assertIsNone(dc.match_turn_budget_site(_TARGET, budget + "@@ -1,1 +1,2 @@\n ctx\n+line\n"))
        self.assertEqual(dc._diff_header_target_basename(self.rows["aux_quoted_octal_out_of_range"]), 'x\\777.md"')
        self.assertFalse(dc._diff_touches_hook_file(self.rows["aux_quoted_truncated_escape_hook"], _TARGET))

    def test_should_reject_a_diff_that_deletes_a_file_in_any_header_section(self) -> None:
        for row_id in ("aux_delete_whole_file", "aux_delete_later_section"):
            with self.subTest(row_id):
                self.assertTrue(dc._diff_deletes_file(self.rows[row_id]))
        self.assertFalse(dc._diff_deletes_file(self.rows["aux_dash_content_removal"]))


def _commit_work_tree(name: str, body: str) -> tuple[Path, Path]:
    work_tree = Path(tempfile.mkdtemp(prefix="parity-normalizer-"))
    target = work_tree / name
    target.write_text(body, encoding="utf-8")
    for args in (
        ["init", "-q"],
        ["add", "-A"],
        ["-c", "user.email=p@test", "-c", "user.name=p", "commit", "-qm", "fixture"],
    ):
        subprocess.run(["git", "-C", str(work_tree), *args], check=True)
    return work_tree, target


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class NormalizerKeepsMarkdownDashAndPlusLines(unittest.TestCase):
    """A benign body edit whose content starts ``-- ``/``++ `` survives normalize → gate → apply."""

    _BEFORE = "# Agent\n\n## Rules\n\n- keep\n-- old dash rule\n- tail\n"
    _AFTER = "# Agent\n\n## Rules\n\n- keep\n++ new plus rule\n- tail\n"
    # `git diff` output for _BEFORE → _AFTER, its `diff --git`/`index` lines dropped.
    _DIFF = (
        "--- a/glass-atrium-dev-x.md\n+++ b/glass-atrium-dev-x.md\n@@ -3,5 +3,5 @@\n"
        " ## Rules\n \n - keep\n--- old dash rule\n+++ new plus rule\n - tail\n"
    )

    def setUp(self) -> None:
        self.work_tree, self.target = _commit_work_tree("glass-atrium-dev-x.md", self._BEFORE)
        self.addCleanup(shutil.rmtree, self.work_tree, ignore_errors=True)

    def test_should_pass_the_edit_through_normalize_unchanged(self) -> None:
        with redirect_stderr(StringIO()):
            normalized = dc._normalize_to_unified_diff(self._DIFF, self.target)
        self.assertEqual(normalized, self._DIFF)

    def test_should_store_a_diff_that_applies_to_the_intended_body(self) -> None:
        with redirect_stderr(StringIO()):
            stored = dc._gate_validated_diff(
                dc._normalize_to_unified_diff(self._DIFF, self.target),
                self.target,
                self.work_tree,
            )
        self.assertNotEqual(stored, "")
        subprocess.run(
            ["git", "-C", str(self.work_tree), "apply", "-"],
            input=stored, text=True, check=True, capture_output=True,
        )
        self.assertEqual(self.target.read_text(encoding="utf-8"), self._AFTER)
