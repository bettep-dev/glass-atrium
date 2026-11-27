"""Apply-time landing-zone guard: does a unified diff land inside the target's EDITABLE regions?

The one copy of the guard: daemon-apply.sh runs this file (diff on stdin, target path as
argv[1], verdict on stdout) and daemon_cycle imports get_verdict, so the trial gate and the
apply never diverge. Verdict contract: daemon-apply.sh → assert_diff_in_editable_region.
Stdlib only, on the install's python3 3.9 floor.
"""

from __future__ import annotations

import sys


def get_verdict(diff_text: str, target_path: str) -> str:
    """The guard's verdict on diff_text against the file at target_path."""
    # git apply breaks a diff and a body at "\n" alone
    # str.splitlines also breaks at FF, U+0085, U+2028 and a lone CR
    # a translating open rewrites a lone CR to "\n"
    lines = [ln.removesuffix("\r") for ln in diff_text.split("\n")]

    # Header-less Strategy-B fragment → EOF append, outside any region. Reject.
    has_minus_header = any(ln.startswith("--- ") for ln in lines)
    has_plus_header = any(ln.startswith("+++ ") for ln in lines)
    if not (has_minus_header and has_plus_header):
        return "header_less"

    try:
        with open(target_path, "r", encoding="utf-8", newline="") as fh:
            current = fh.read()
    except OSError:
        return "read_error"  # loud-fail: NEVER pass-through

    regions = _editable_regions(current)
    if not regions:
        return "no_marker"

    def in_some_region(needle):
        s = needle.strip()
        if not s:
            return True  # blank line carries no landing-zone signal
        return any(s in region for region in regions)

    # Hunk-aware scan. A unified diff lands each hunk by matching its ANCHOR
    # lines (context + removed) against the current file at one position; the
    # added lines are placed among those anchors. The landing zone of a hunk is
    # decided by where its anchors sit:
    #   1. Every removed/context line the file CONTAINS must sit inside an
    #      editable region — an anchor in a protected zone = reject.
    #   2. Each hunk MUST carry at least one anchor resolving inside a region.
    #      A pure-add hunk with no in-region anchor cannot be confirmed to land
    #      editable → reject (fail-closed).
    hunks = []
    current_hunk = None
    for raw in lines:
        if raw.startswith("@@"):
            current_hunk = []
            hunks.append(current_hunk)
            continue
        if current_hunk is None:
            continue  # pre-hunk header lines
        current_hunk.append(raw)

    if not hunks:
        return "out_of_region"  # headers but no hunk body = malformed

    for hunk in hunks:
        anchor_in_region = False
        for raw in hunk:
            if not raw:
                continue
            marker, body = raw[0], raw[1:]
            # Compute the landing-zone hit ONCE per line; both branches reuse it.
            region_hit = in_some_region(body)
            if marker == "-":
                # Removed text must currently exist inside an editable region.
                if body.strip() and not region_hit:
                    return "out_of_region"
                if body.strip() and region_hit:
                    anchor_in_region = True
            elif marker == " ":
                # Context anchor. If the file holds it OUTSIDE every region the
                # hunk sits in a protected zone → reject; inside → positive anchor.
                if body.strip():
                    if body in current and not region_hit:
                        return "out_of_region"
                    if region_hit:
                        anchor_in_region = True
            # Added lines carry no landing anchor of their own.
        if not anchor_in_region:
            return "out_of_region"  # no in-region anchor → fail-closed

    # Post-region structural integrity (RC1). Every hunk anchors in-region, but
    # an in-region insert can STILL split a GFM table by dropping a non-pipe line
    # between two table rows — invisible to the containment scan above. Reject on
    # the post-apply table-break view (fail-closed, same as out_of_region).
    if _breaks_table(hunks):
        return "table_break"

    return "ok"


def _editable_regions(text):
    """Body substrings between each EDITABLE BEGIN/END marker pair (doc order)."""
    begin = "<!-- EDITABLE:BEGIN -->"
    end = "<!-- EDITABLE:END -->"
    regions = []
    pos = 0
    while True:
        b = text.find(begin, pos)
        if b == -1:
            break
        e = text.find(end, b + len(begin))
        if e == -1:
            break  # unbalanced trailing BEGIN with no END → ignore (no region)
        regions.append(text[b + len(begin) : e])
        pos = e + len(end)
    return regions


def _row_is_pipe(body):
    """A GFM table row/separator (incl. the '|---|' header rule): the stripped
    line begins with '|'."""
    return body.strip().startswith("|")


def _breaks_table(hunks):
    """True when a hunk inserts a contiguous run of ADDED non-pipe lines directly
    between two GFM table rows (a pipe-row immediately before AND after the run).
    Reasons on the POST-APPLY (new-side) view of each hunk — context + added
    lines in document order, removed lines dropped — so it catches a diff that
    lands inside an editable region yet splits a table block. Mirrors RC1: two
    non-pipe lines relocated into an Error Recovery table interior. A pure
    table-row addition (the added line is itself '|...|') and any insert NOT
    bounded by pipe rows on both sides are admitted (no false positive on append-
    after-table, prepend-before-table, or text between two separate tables)."""
    return any(_has_bounded_insert(_get_new_side(hunk)) for hunk in hunks)


def _get_new_side(hunk):
    """The hunk's post-apply view: (is_added, body) per line, in document order."""
    new_side = []
    for raw in hunk:
        if not raw:
            new_side.append((False, ""))  # blank context line
            continue
        marker, body = raw[0], raw[1:]
        if marker == "-":
            continue  # removed → absent post-apply
        if marker == "+":
            new_side.append((True, body))
        elif marker == " ":
            new_side.append((False, body))
        # other markers ('\' no-newline-at-EOF) carry no table signal
    return new_side


def _has_bounded_insert(new_side):
    """True when a run of added non-pipe lines sits between two pipe rows."""
    n = len(new_side)
    i = 0
    while i < n:
        is_added, body = new_side[i]
        if is_added and not _row_is_pipe(body):
            # extend over a run of consecutive added non-pipe lines (RC1
            # inserted TWO) so the bounding pipe-rows are tested once.
            run_end = i
            while (
                run_end < n
                and new_side[run_end][0]
                and not _row_is_pipe(new_side[run_end][1])
            ):
                run_end += 1
            before_pipe = i - 1 >= 0 and _row_is_pipe(new_side[i - 1][1])
            after_pipe = run_end < n and _row_is_pipe(new_side[run_end][1])
            if before_pipe and after_pipe:
                return True
            i = run_end
        else:
            i += 1
    return False


if __name__ == "__main__":
    sys.stdout.write(get_verdict(sys.stdin.read(), sys.argv[1]))
