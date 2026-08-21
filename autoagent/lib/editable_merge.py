"""Three-anchor EDITABLE-region merge-candidate module (T17 + T18).

The glass-atrium-update skill (E4) must, for each agent ``*.md`` file, replace
the structure OUTSIDE the ``<!-- EDITABLE:BEGIN/END -->`` regions from the
incoming vendor release while PRESERVING the locally-learned content INSIDE those
regions. A region is merged ONLY when BOTH the vendor release AND the local file
changed it relative to the base@install anchor (a true 3-anchor decision); when
the release never touched a region the local content is kept byte-identical.

This module builds the merge CANDIDATE only. It is import-driven (T19 wires it
into the daemon's hardened ``git_txn_apply`` transaction; the deterministic
non-agent file sync is a separate concern). It does NOT edit
``scripts/update.sh`` (T20) nor ``lib/ga-core.sh`` (E5).

Reuse (NOT re-implemented here — imported from the daemon):
  * ``daemon_cycle._editable_spans``  — the canonical EDITABLE marker pairing.
  * ``daemon_cycle.match_sensitive_path`` / ``match_sensitive_diff`` — the single
    compiled sensitive-refusal source (GLOBAL_RULES / security rules / .env /
    ``com.glass-atrium.*.plist`` / irreversible-command diffs).
  * ``daemon_cycle.run_pre_verify`` (+ ``PatchProposal`` / ``Pattern``) — the
    Haiku improvement-verify dry-run that gates a both-changed merge candidate.
  * ``daemon_cycle.flatten_log_field`` — the single line-record sanitizer applied
    to every field of the pre-verify rejection line (LLM-authored text reaching
    an operator-facing log; see its docstring for the forging window).

==============================================================================
KEY DESIGN DECISION (flagged per task) — base@install region CONTENT provenance
==============================================================================
The apply-spine baseline (``spine_set_baseline`` / ``spine_get_baseline``) stores
``baseline-manifest.json`` — per-file SHA-256 HASHES, NOT file CONTENT. A hash
proves "this file changed since base", but a region-level 3-way merge needs the
ACTUAL base region TEXT to diff against. There is no way to reconstruct content
from a hash.

Resolution (chosen, not faked):
  1. PRIMARY (true 3-way) — a base-content STORE retains the base@install agent
     ``*.md`` bodies at install/update time (separate from the hash manifest;
     ``load_base_text`` reads it). T24's install/post-apply wiring POPULATES this
     store; this module CONSUMES it. With base content present the resolver does a
     real diff3 (base / vendor / local).
  2. FALLBACK (gated 2-way present-both) — when base content is UNAVAILABLE
     (``base_text is None``: a baseline predating the content store, or a
     relocated install without retained bodies) the resolver does NOT fabricate a
     base anchor. It compares vendor-region vs local-region only:
       * identical  -> keep-local (unambiguous, no merge, no LLM).
       * different  -> routed to the arbiter with the base slot marked
                       unavailable; an ANSWERED region resolves like any judged
                       gap, and an unanswered one falls to the GATED_2WAY
                       verdict: a present-both REPORT surfacing BOTH sides,
                       routed to the manual ceremony — never silently
                       auto-picked, never a faked 3-way.

So a missing base-content store DEGRADES safety-conservatively (more human
gating), it never silently corrupts a learned region.

==============================================================================
CONFLICT-MARKER TRIPWIRE — a marker-bearing candidate NEVER lands
==============================================================================
Conflict markers are a REPORT format, not a file format: literal ``<<<<<<<`` /
``>>>>>>>`` lines inside a live agent body are corruption (a stale merge base
re-conflicts an already-merged region and the markers land in the agent). So a
resolution carrying markers (MERGE_CONFLICT / GATED_2WAY / any ``had_conflict``
region) is refused at BOTH transaction seats: ``MergeCandidate.apply`` returns
APPLY_MALFORMED pre-write (zero bytes written), and ``MergeCandidate.verify``
re-scans the ON-DISK file post-write so any marker that reached the target from
any other source fails the transaction into the git_txn before-image restore.
The scan is line-anchored on the EXACT updater-authored markers below — never a
bare ``<<<<<<<``, so an agent body documenting git conflicts is not a hit.

Consequence (deliberate, not incidental): MERGE_CONFLICT and GATED_2WAY lose
their write path entirely and become report-only verdicts the caller routes to
the manual ceremony, exactly like STRUCTURAL.

No third-party dependencies — stdlib only (difflib, dataclasses, pathlib).
Bash-callback seam for git_txn_apply (T19): see ``MergeCandidate.apply`` /
``MergeCandidate.verify`` + the thin CLI at the bottom.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

# daemon_cycle.py lives in the autoagent root, one level up from this lib/ dir —
# the same path-insert idiom as the sibling lib/sensitive_patterns.py, so the
# compiled patterns + helpers import cleanly regardless of the caller's CWD.
_AUTOAGENT_ROOT = Path(__file__).resolve().parent.parent
if str(_AUTOAGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_ROOT))

import daemon_cycle as dc  # noqa: E402 — must follow the sys.path insert above

# -- Verdicts ----------------------------------------------------------------
# Per-region and overall file outcome. One verb per purpose: each names exactly
# what the resolver decided for a region's content.
KEEP_LOCAL = "keep-local"  # release region == base -> local kept verbatim
TAKE_RELEASE = "take-release"  # local region == base -> vendor region taken
MERGE_CLEAN = "merge-clean"  # both changed, diff3 merged without conflict
MERGE_CONFLICT = "merge-conflict"  # both changed with an overlapping conflict
MERGE_ARBITER_RESOLVED = "merge-arbiter-resolved"  # contested gap the arbiter answered
MERGE_PENDING_ARBITRATION = "merge-pending-arbitration"  # contested gap emits the local side
GATED_2WAY = "gated-2way-present-both"  # base content unavailable, sides differ
STRUCTURAL = "structural-change"  # region-count mismatch -> manual ceremony
REFUSED = "sensitive-refused"  # target path / diff matched a sensitive pattern
NO_OP = "no-op"  # candidate identical to current local file

# MERGE_ARBITER_RESOLVED and MERGE_PENDING_ARBITRATION split the contested-gap
# branch by whether an answer was reached, not by how the gap looked: an answered
# gap emits the arbiter's run and carries its choice and rationale in the region's
# GapOutcome list, while an unanswered one emits the local run and leaves the
# region pending. Every failure path lands in the pending half, which is what
# keeps a file nobody judged out of the write path.

# Verdicts that REQUIRE the Haiku improvement-verify gate (an ambiguous,
# net-new-merged region). KEEP_LOCAL / TAKE_RELEASE / NO_OP are deterministic and
# make NO LLM call (T18 AC: "only-local or only-vendor changes make NO LLM call").
#
# MERGE_PENDING_ARBITRATION is OUT: the gap emits the local side and the updater
# declines the file, so no merged wording reaches a write for the gate to screen.
#
# MERGE_ARBITER_RESOLVED is IN: its candidate carries wording a model chose
# between two human-authored sides, which is the one candidate class no anchor
# rule vouches for, so the gate is the only reader that sees it before it lands.
_LLM_REQUIRED = frozenset(
    {MERGE_CLEAN, MERGE_CONFLICT, GATED_2WAY, MERGE_ARBITER_RESOLVED}
)

# Verdicts whose candidate carries conflict markers BY CONSTRUCTION — report-only,
# never writable to a live agent file (see the module header's tripwire section).
#
# MERGE_PENDING_ARBITRATION is OUT: an arbitrated gap emits the local lines
# verbatim, so its candidate is marker-free and the tripwire has nothing to
# refuse. Membership here turns on markers alone — the updater declines the file
# either way, so this is not a statement that such a candidate lands.
# MERGE_ARBITER_RESOLVED is OUT for the same reason: an answered gap emits lines
# taken verbatim from an anchor, so no marker is ever written into its candidate.
_MARKER_VERDICTS = frozenset({MERGE_CONFLICT, GATED_2WAY})

# git_txn_apply apply-callback contract (mirrors daemon-apply.sh apply_diff):
#   0 = applied · 3 = located-diff-won't-land (no bytes written) · other = malformed.
APPLY_OK = 0
APPLY_NOOP = 3
APPLY_MALFORMED = 2

# Frontmatter keys the LIVE install may own as an operator override — never
# ported to git (orchestrator-role.md Cost-Tier Selection: a live `model:` pin is
# "local-only config, NEVER ported to git"). The candidate's frontmatter comes
# verbatim from the release skeleton, so without this allowlist every merge
# silently strips such a pin.
# This tuple is the UNCONDITIONAL live-wins half: the release ships none of these
# keys, so a live value can only be an operator pin. A key the release DOES ship
# belongs in _BASE_AWARE_FRONTMATTER_KEYS below instead — `effort` is exactly that
# case, so it lives there rather than here.
# NARROW by design — NOT "preserve all live-only keys": the identity keys
# {name, tools, scope} stay vendor-owned (hooks/enforce-harness-critical.sh
# protects those and explicitly excludes model). A live-only key outside BOTH
# tuples is still dropped ON PURPOSE — inverting the default would retain a key
# the vendor removed deliberately — so dropped_local_frontmatter_keys() reports
# it on the plan line, which the updater's update_warn_dropped_frontmatter turns
# into a run-log advisory rather than letting the drop vanish unannounced. Tuple,
# not set → the append order below is deterministic across runs.
_LOCAL_ONLY_FRONTMATTER_KEYS = ("model",)

# A top-level frontmatter key line, anchored at column 0 so an indented list item
# or continuation line belongs to its parent key rather than counting as one.
_FRONTMATTER_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):")

# Frontmatter keys the release DOES ship, so live-wins cannot be unconditional: a
# release bump would be reverted on every install. The live line is carried only
# when it DIFFERS from base@install — that difference is what distinguishes an
# operator pin from a stale copy of a value the vendor has since moved. With no
# base anchor the difference is unknowable, so the key falls back to live-wins
# rather than dropping a pin it cannot adjudicate.
_BASE_AWARE_FRONTMATTER_KEYS = ("effort",)

# Conflict markers for an overlapping both-changed region (diff3 / git style).
_C_LOCAL = "<<<<<<< LOCAL (learned)\n"
_C_BASE = "||||||| BASE (base@install)\n"
_C_REL = "=======\n"
_C_END = ">>>>>>> RELEASE (vendor)\n"

# Tripwire scan set — the three DISTINCTIVE updater-authored markers. `_C_REL`
# ("=======") is deliberately EXCLUDED: a bare separator collides with markdown
# setext rules and table borders in real agent bodies.
_CONFLICT_MARKER_LINES = frozenset(m.rstrip("\n") for m in (_C_LOCAL, _C_BASE, _C_END))


def has_conflict_markers(text: str) -> bool:
    """Whether ``text`` carries an updater-authored conflict-marker line.

    Line-anchored EXACT matching against ``_CONFLICT_MARKER_LINES`` — a bare
    ``<<<<<<<`` never matches, so an agent body that documents git conflicts (or
    quotes this module's own literals) is not a false positive.
    """
    return any(line in _CONFLICT_MARKER_LINES for line in text.splitlines())


@dataclass(frozen=True)
class GapOutcome:
    """What one contested gap resolved to, and on whose authority.

    ``choice`` is None for every path that reached no answer. Those paths emit the
    local run too, so the lines alone cannot tell a judged LOCAL from a failure —
    the token is the only thing that separates them.
    """

    lines: tuple[str, ...]
    choice: str | None = None
    rationale: str = ""


@dataclass(frozen=True)
class RegionResolution:
    """Outcome for a single EDITABLE region (document order ``index``)."""

    index: int
    verdict: str
    content: list[str]  # resolved region content lines (kept endings)
    had_conflict: bool = False
    reason: str = ""
    hunks: tuple[ConflictHunk, ...] = ()  # conflicting gaps, document order
    requests: tuple[ArbitrationRequest, ...] = ()  # gaps awaiting judgment, same order
    decisions: tuple[GapOutcome, ...] = ()  # per answered gap, same order as hunks


@dataclass
class FileResolution:
    """Whole-file three-anchor resolution (T17) — pure, no LLM call made here."""

    target_file: str
    verdict: str  # overall verdict (worst-case across regions)
    candidate_text: str  # assembled candidate (release structure + resolved regions)
    local_text: str
    regions: list[RegionResolution] = field(default_factory=list)
    needs_llm: bool = False  # any region in _LLM_REQUIRED
    needs_ceremony: bool = False  # STRUCTURAL roster/region-count mismatch
    base_available: bool = True
    reason: str = ""

    @property
    def is_changed(self) -> bool:
        """Whether the candidate differs from the current local file."""
        return self.candidate_text != self.local_text

    @property
    def has_conflict(self) -> bool:
        """Whether the candidate is marker-bearing (report-only, never landable).

        Keys on the VERDICT plus each region's own ``had_conflict`` flag, so a
        marker-bearing region still trips the tripwire when a lower-severity
        sibling verdict wins the overall severity pick.
        """
        return self.verdict in _MARKER_VERDICTS or any(
            region.had_conflict for region in self.regions
        )


# -- Region extraction -------------------------------------------------------


def _split_lines(text: str) -> list[str]:
    """Split keeping line endings so candidate bytes round-trip exactly."""
    return text.splitlines(keepends=True)


def _region_contents(text: str) -> tuple[list[str], list[tuple[int, int, list[str]]]]:
    """Return (lines, [(begin_idx, end_idx, content_lines), ...]).

    Marker pairing is delegated to the daemon's ``_editable_spans`` (the single
    source). ``begin_idx`` / ``end_idx`` are 1-indexed marker line numbers; the
    content is the lines STRICTLY between them (markers excluded), matching the
    apply-side landing-zone guard.
    """
    lines = _split_lines(text)
    spans = dc._editable_spans(lines)
    regions: list[tuple[int, int, list[str]]] = []
    for begin_idx, end_idx in spans:
        # 1-indexed marker -> 0-indexed content slice [begin_idx : end_idx-1].
        content = lines[begin_idx : end_idx - 1]
        regions.append((begin_idx, end_idx, content))
    return lines, regions


# -- Net-new diff3 (the daemon has NO existing 3-way merge) -------------------


def _find_sync_regions(
    base: list[str], a: list[str], b: list[str]
) -> list[tuple[int, int, int, int, int, int]]:
    """Synchronization regions where base, a (local) and b (release) all agree.

    Each tuple is (base_start, base_end, a_start, a_end, b_start, b_end). Built by
    intersecting the base<->local and base<->release matching blocks over the base
    index — the standard diff3 synchronization step (a sentinel zero-length match
    closes the final gap).
    """
    a_matches = difflib.SequenceMatcher(
        None, base, a, autojunk=False
    ).get_matching_blocks()
    b_matches = difflib.SequenceMatcher(
        None, base, b, autojunk=False
    ).get_matching_blocks()
    ia = ib = 0
    sync: list[tuple[int, int, int, int, int, int]] = []
    while ia < len(a_matches) and ib < len(b_matches):
        a_base, a_off, a_len = a_matches[ia]
        b_base, b_off, b_len = b_matches[ib]
        start = max(a_base, b_base)
        end = min(a_base + a_len, b_base + b_len)
        if start < end:
            sync.append(
                (
                    start,
                    end,
                    start - a_base + a_off,
                    end - a_base + a_off,
                    start - b_base + b_off,
                    end - b_base + b_off,
                )
            )
        if (a_base + a_len) < (b_base + b_len):
            ia += 1
        else:
            ib += 1
    sync.append((len(base), len(base), len(a), len(a), len(b), len(b)))
    return sync


@dataclass(frozen=True)
class ConflictHunk:
    """One gap both sides changed DIFFERENTLY, with its three anchor texts.

    ``out_index`` is where the gap's emitted content begins in the merged output,
    which differs by mode: the marker block's opening line under the reporting
    default, the first local line under the arbitration mode. The three
    anchors are tuples so the record is immutable alongside its sibling
    ``RegionResolution`` — a caller reasoning about a resolution's hunks can never
    mutate the merge's own view of them.
    """

    out_index: int
    base: tuple[str, ...]
    local: tuple[str, ...]
    release: tuple[str, ...]


@dataclass(frozen=True)
class ArbitrationRequest:
    """One contested gap routed to a judgment call, with what the judge must read.

    ``region_index`` is the containing region's document-order ordinal.
    ``context`` is that region's RELEASE-side content in full, vendor wording of
    the contested gap included — NOT the merged region the candidate carries, and
    not a neighbourhood slice around the gap. The gap's three anchors ride in
    ``gap`` rather than being copied out of it, so the request and the merge cannot
    disagree about what the gap was.
    """

    region_index: int
    gap: ConflictHunk
    context: tuple[str, ...]


def three_way_merge_hunks(
    base: list[str],
    local: list[str],
    release: list[str],
    *,
    arbitrate: bool = False,
) -> tuple[list[str], list[ConflictHunk]]:
    """diff3-style line merge of one region. Returns (merged_lines, hunks).

    A gap changed by only one side is taken from that side; a gap both sides
    changed identically collapses to one copy. A gap both sides changed
    DIFFERENTLY is recorded as a ``ConflictHunk`` either way, and its emitted
    content is what ``arbitrate`` selects:

      * False (the reporting default) — git-style conflict markers, so the
        candidate is report-only: ``apply`` refuses it pre-write
        (APPLY_MALFORMED, zero bytes) and ``verify``'s on-disk marker scan fails
        the transaction into the before-image restore.
      * True — the LOCAL gap verbatim, so the candidate is marker-free by
        construction while no side has been chosen: which wording supersedes is a
        judgment this function does not make, and the local body is the only copy
        of locally accumulated content, whereas the release side is recoverable by
        re-running the update. ``_resolve_region`` pairs the emission with a
        request per gap and a verdict the updater declines on.

    Hunks are returned in document order — one per conflicting gap.
    """
    sync = _find_sync_regions(base, local, release)
    iz = ia = ib = 0
    out: list[str] = []
    hunks: list[ConflictHunk] = []
    for z_start, z_end, a_off, a_end, b_off, b_end in sync:
        base_gap = base[iz:z_start]
        local_gap = local[ia:a_off]
        rel_gap = release[ib:b_off]

        if local_gap == base_gap and rel_gap == base_gap:
            pass  # nothing changed in this gap
        elif local_gap == base_gap:
            out.extend(rel_gap)  # only release changed
        elif rel_gap == base_gap:
            out.extend(local_gap)  # only local changed
        elif local_gap == rel_gap:
            out.extend(local_gap)  # both changed identically
        else:
            hunks.append(
                ConflictHunk(
                    out_index=len(out),
                    base=tuple(base_gap),
                    local=tuple(local_gap),
                    release=tuple(rel_gap),
                )
            )
            if arbitrate:
                out.extend(local_gap)
            else:
                out.append(_C_LOCAL)
                out.extend(local_gap)
                out.append(_C_BASE)
                out.extend(base_gap)
                out.append(_C_REL)
                out.extend(rel_gap)
                out.append(_C_END)

        # the synchronized (all-agree) block
        if z_end > z_start:
            out.extend(base[z_start:z_end])
        iz, ia, ib = z_end, a_end, b_end
    return out, hunks


# -- Per-region three-anchor resolution (T17 / T18 candidate) ----------------


def _resolve_region(
    index: int,
    base: list[str] | None,
    local: list[str],
    release: list[str],
    *,
    arbitrate: bool = False,
    arbiter: GapArbiter | None = None,
    region_count: int = 1,
) -> RegionResolution:
    """Classify one region against the three anchors and resolve its content.

    ``arbitrate`` selects what a gap both sides changed differently emits —
    see ``three_way_merge_hunks``. It defaults OFF so this private helper keeps
    its reporting behavior for a caller that names no policy; the two entry
    points ``resolve_file`` and ``build_merge_candidate`` default it ON instead,
    so every production path arbitrates and report-only is opt-in.

    ``arbiter`` is what turns the emitted local gap into a judged one. Absent it
    the emission stays local: a caller that supplies no arbiter has asked for no
    judgment, which is the shape every deterministic path relies on.
    """
    if base is None:
        # FALLBACK: base content unavailable — the arbiter first, then the gate.
        if local == release:
            return RegionResolution(
                index, KEEP_LOCAL, local, reason="2way: sides identical"
            )
        # With no base run to synchronize against, the region IS one contested
        # gap and its base slot is empty: no line of either side is base-present,
        # so clause four reaches every one of them and clause five is vacuous.
        hunk = ConflictHunk(
            out_index=0, base=(), local=tuple(local), release=tuple(release)
        )
        if arbiter is not None:
            outcome = arbiter.get_gap_outcome(
                region_index=index,
                region_count=region_count,
                gap_index=0,
                hunk=hunk,
                context="".join(release),
            )
            if outcome.choice is not None:
                return RegionResolution(
                    index,
                    MERGE_ARBITER_RESOLVED,
                    list(outcome.lines),
                    reason="base content unavailable; arbiter judged the region",
                    hunks=(hunk,),
                    decisions=(outcome,),
                )
        merged = [_C_LOCAL, *local, _C_REL, *release, _C_END]
        return RegionResolution(
            index,
            GATED_2WAY,
            merged,
            had_conflict=True,
            reason="base content unavailable; present-both, human/LLM-gated",
        )

    release_changed = release != base
    local_changed = local != base

    if not release_changed:
        # Release never touched the region -> keep local verbatim. No LLM.
        return RegionResolution(index, KEEP_LOCAL, local, reason="release == base")
    if not local_changed:
        # Only vendor changed -> take the vendor region. No LLM.
        return RegionResolution(index, TAKE_RELEASE, release, reason="local == base")
    if local == release:
        # Both changed but to the SAME text -> unambiguous, no merge ambiguity.
        return RegionResolution(
            index, KEEP_LOCAL, local, reason="both changed identically"
        )

    # Both changed differently -> net-new 3-way merge candidate (Haiku-gated).
    merged, hunks = three_way_merge_hunks(base, local, release, arbitrate=arbitrate)
    requests: tuple[ArbitrationRequest, ...] = ()
    decisions: tuple[GapOutcome, ...] = ()
    if not hunks:
        verdict = MERGE_CLEAN
    elif arbitrate:
        verdict = MERGE_PENDING_ARBITRATION
        # One request per contested gap, carrying the region's release side in full.
        requests = tuple(
            ArbitrationRequest(index, hunk, tuple(release)) for hunk in hunks
        )
        if arbiter is not None:
            spliced, decisions = _splice_arbitrated(
                merged,
                hunks,
                arbiter,
                region_index=index,
                region_count=region_count,
                release=release,
            )
            # EVERY gap of the region, not merely one: a landed region retires the
            # gaps it contains — the next run's base equals this release and the
            # contest is gone — so a sibling left unanswered would be decided by
            # the landing rather than by a judge. Short of that the region stays
            # pending and emits the diff3 output, whose runs are the local lines,
            # which is the decline the whole-file rule already describes.
            if decisions and all(outcome.choice is not None for outcome in decisions):
                merged = spliced
                verdict = MERGE_ARBITER_RESOLVED
    else:
        verdict = MERGE_CONFLICT
    # had_conflict is derived from _MARKER_VERDICTS membership rather than set per
    # branch, so a verdict later added to that set carries this site with it.
    # An arbitrated gap therefore CLEARS the flag: every emitted line is verbatim
    # from an anchor and no marker was written, so the apply refusal and the on-disk
    # rescan pass on their own terms rather than by exemption.
    return RegionResolution(
        index,
        verdict,
        merged,
        had_conflict=verdict in _MARKER_VERDICTS,
        reason="both changed; net-new diff3 candidate",
        hunks=tuple(hunks),
        requests=requests,
        decisions=decisions,
    )


def _gap_line_split(
    hunk: ConflictHunk, outcome: GapOutcome
) -> tuple[list[str], list[str]]:
    """One gap's local lines the answer left out, and its lines drawn elsewhere.

    Matching is by line VALUE, one occurrence at a time: an answer that re-emits a
    local line has not dropped it, whichever run the arbiter named it from.
    """
    unmatched = list(outcome.lines)
    dropped: list[str] = []
    for line in hunk.local:
        if line in unmatched:
            unmatched.remove(line)
        else:
            dropped.append(line)
    return dropped, unmatched


def _answered_gaps(
    resolution: "FileResolution",
) -> list[tuple[RegionResolution, ConflictHunk, GapOutcome]]:
    """Every contested gap of every arbiter-resolved region, in document order."""
    return [
        (region, hunk, outcome)
        for region in resolution.regions
        if region.verdict == MERGE_ARBITER_RESOLVED
        for hunk, outcome in zip(region.hunks, region.decisions, strict=True)
    ]


def dropped_gap_lines(resolution: "FileResolution") -> list[str]:
    """Local lines the answers discarded — the only copy left once spliced.

    A gap answered LOCAL contributes nothing: its lines are still in the candidate,
    so quoting them as discarded would attribute a loss to a resolution that took
    none.
    """
    return [
        line
        for _, hunk, outcome in _answered_gaps(resolution)
        for line in _gap_line_split(hunk, outcome)[0]
    ]


def resolved_gap_stats(resolution: "FileResolution") -> dict[str, str | int]:
    """Shape of the contested gaps this file resolved through the arbiter.

    Says WHAT the answers displaced without pasting whole regions. Counts only —
    the excerpt comes from the live-to-candidate diff the caller already composes.

    ``regions`` is a comma-joined index list (space-free, so it survives the
    updater's up-to-next-space plan-line extractor), empty when no gap resolved.
    """
    answered = _answered_gaps(resolution)
    splits = [_gap_line_split(hunk, outcome) for _, hunk, outcome in answered]
    indices = sorted({region.index for region, _, _ in answered})
    return {
        "hunks": len(answered),
        "dropped_lines": sum(len(dropped) for dropped, _ in splits),
        "added_lines": sum(len(added) for _, added in splits),
        "regions": ",".join(str(index) for index in indices),
    }


def _assemble(
    release_lines: list[str],
    release_regions: list[tuple[int, int, list[str]]],
    resolutions: list[RegionResolution],
) -> str:
    """Rebuild the file from the RELEASE structure, substituting resolved regions.

    Outside-EDITABLE content (and the markers themselves) comes from the release
    skeleton; each Nth region's content is swapped for its resolved content.
    Iterating in reverse keeps the earlier slice indices valid.
    """
    out = list(release_lines)
    for (begin_idx, end_idx, _), res in zip(
        reversed(release_regions), reversed(resolutions), strict=True
    ):
        out[begin_idx : end_idx - 1] = res.content
    return "".join(out)


def _frontmatter_span(lines: list[str]) -> tuple[int, int] | None:
    """Return (first_key_idx, closing_fence_idx) of a byte-0 YAML frontmatter block.

    Anchored at byte 0 (a ``---`` opening line) and closed by the NEXT line that is
    exactly ``---``, so a mid-body horizontal rule is never mistaken for a fence.
    No such block -> None.
    """
    if not lines or lines[0].rstrip("\n") != "---":
        return None
    for idx in range(1, len(lines)):
        if lines[idx].rstrip("\n") == "---":
            return 1, idx
    return None


def _find_frontmatter_line(
    lines: list[str], span: tuple[int, int], prefix: str
) -> str | None:
    """First line inside ``span`` starting with ``prefix``, or None."""
    begin, close = span
    return next((line for line in lines[begin:close] if line.startswith(prefix)), None)


def _keep_local_frontmatter(
    candidate_text: str, local_text: str, base_text: str | None = None
) -> str:
    """Carry the LIVE-only frontmatter keys of ``local_text`` into the candidate.

    Runs at candidate-assembly time (upstream of the diff, the sensitive re-scan,
    the Haiku gate and the no-op comparison) so every downstream channel sees one
    pin-stable file — never a post-merge re-write.

    Two key sets with different precedence. ``_LOCAL_ONLY_FRONTMATTER_KEYS`` is
    LIVE-WINS unconditionally: the release ships none of them, so a live value can
    only be an operator pin. ``_BASE_AWARE_FRONTMATTER_KEYS`` names keys the release
    DOES ship, where unconditional live-wins would revert every vendor bump — the
    live line is carried only when it differs from base@install, and a live value
    equal to base is left to the release. With no base anchor that comparison is
    impossible, so those keys fall back to live-wins rather than dropping a pin
    they cannot adjudicate.

    Each carried key REPLACES its candidate line, or is
    APPENDED as the block's last line when the candidate lacks it (a fixed
    position keeps re-runs byte-stable). The local line is copied VERBATIM
    (spacing / trailing comment preserved). Either side lacking a frontmatter
    block -> candidate returned unchanged (fail-open, never fabricate one).
    """
    local_lines = _split_lines(local_text)
    out = _split_lines(candidate_text)
    local_span = _frontmatter_span(local_lines)
    if local_span is None or _frontmatter_span(out) is None:
        return candidate_text

    base_lines = _split_lines(base_text) if base_text is not None else None
    base_span = _frontmatter_span(base_lines) if base_lines is not None else None
    for key in (*_LOCAL_ONLY_FRONTMATTER_KEYS, *_BASE_AWARE_FRONTMATTER_KEYS):
        prefix = f"{key}:"
        local_line = _find_frontmatter_line(local_lines, local_span, prefix)
        # absent locally -> nothing to keep; a release-carried value lands normally.
        if local_line is None:
            continue
        if key in _BASE_AWARE_FRONTMATTER_KEYS and base_span is not None:
            # unchanged since install -> not an operator pin; the release value lands.
            if _find_frontmatter_line(base_lines, base_span, prefix) == local_line:
                continue
        # re-read the span each pass — a prior append shifted the closing fence.
        span = _frontmatter_span(out)
        if span is None:
            break
        begin, close = span
        hit = next((i for i in range(begin, close) if out[i].startswith(prefix)), None)
        if hit is None:
            out.insert(close, local_line)
        else:
            out[hit] = local_line
    return "".join(out)


def _frontmatter_keys(text: str) -> list[str]:
    """Ordered, de-duplicated top-level keys of a byte-0 frontmatter block.

    No frontmatter block -> empty list (the same fail-open posture as
    ``_keep_local_frontmatter``: absence is never treated as a divergence).
    """
    lines = _split_lines(text)
    span = _frontmatter_span(lines)
    if span is None:
        return []
    begin, close = span
    keys: list[str] = []
    for line in lines[begin:close]:
        match = _FRONTMATTER_KEY_RE.match(line)
        if match is not None and match.group(1) not in keys:
            keys.append(match.group(1))
    return keys


def dropped_local_frontmatter_keys(
    local_text: str, candidate_text: str
) -> list[str]:
    """Live frontmatter keys the ASSEMBLED candidate does not carry, in local order.

    Read off the real artifact — the body this merge will write — so the advisory
    reports what the carry pass actually did rather than re-deriving its policy.
    A key present locally and absent from the candidate is dropped whatever the
    route: no release line, no allowlist carry, or a base-aware key the carry pass
    left to the release. Re-deriving from the release skeleton instead states the
    policy a second time, and the two have already disagreed — a base-aware key
    equal to base and absent from the release IS dropped by the carry pass, yet a
    set-membership check reads it as carried and names nothing.

    ADVISORY ONLY. The caller warns and proceeds: a live-only key is a benign
    divergence, and aborting the merge on one would block on a non-problem.
    """
    carried = set(_frontmatter_keys(candidate_text))
    return [key for key in _frontmatter_keys(local_text) if key not in carried]


def resolve_file(
    target_file: str,
    local_text: str,
    release_text: str,
    base_text: str | None = None,
    *,
    resolve_conflicting_gaps: bool = True,
    arbiter: GapArbiter | None = None,
) -> FileResolution:
    """T17 three-anchor resolver — pure, makes NO LLM call.

    ``resolve_conflicting_gaps`` has exactly two settings — arbiter (the default)
    and report-only — and no environment reads it. A mode carried in the process
    environment would be settable on one side only, and `plan` and the verify
    shell-out are separate processes reconstructing the candidate from the same
    anchors: a mode resolved at plan time and re-conflicting at verify time fails
    every transaction into a restore.

    Pairs the Nth EDITABLE region across base/local/release, classifies each, and
    assembles a candidate (release structure + resolved region content). A
    region-count mismatch between local and release is a STRUCTURAL change routed
    to the foreground ``agent_lifecycle`` ceremony rather than auto-merged.
    """
    _, local_regions = _region_contents(local_text)
    release_lines, release_regions = _region_contents(release_text)
    base_regions: list[tuple[int, int, list[str]]] | None = None
    if base_text is not None:
        _, base_regions = _region_contents(base_text)

    base_available = base_text is not None

    # Structural guard: region counts must align for a safe Nth-pairing. (Base
    # may legitimately have a different count if the layout changed since install;
    # we only HARD-block on a local<->release mismatch — that breaks assembly.)
    if len(local_regions) != len(release_regions):
        return FileResolution(
            target_file=target_file,
            verdict=STRUCTURAL,
            candidate_text=release_text,
            local_text=local_text,
            regions=[],
            needs_llm=False,
            needs_ceremony=True,
            base_available=base_available,
            reason=(
                f"EDITABLE region count differs (local={len(local_regions)} "
                f"release={len(release_regions)}); route to agent_lifecycle ceremony"
            ),
        )

    resolve_gaps = resolve_conflicting_gaps
    resolutions: list[RegionResolution] = []
    for idx, ((_, _, local_c), (_, _, release_c)) in enumerate(
        zip(local_regions, release_regions, strict=True)
    ):
        base_c: list[str] | None = None
        if base_regions is not None and idx < len(base_regions):
            base_c = base_regions[idx][2]
        resolutions.append(
            _resolve_region(
                idx,
                base_c,
                local_c,
                release_c,
                arbitrate=resolve_gaps,
                arbiter=arbiter if resolve_gaps else None,
                region_count=len(release_regions),
            )
        )

    candidate = _assemble(release_lines, release_regions, resolutions)
    candidate = _keep_local_frontmatter(candidate, local_text, base_text)
    needs_llm = any(r.verdict in _LLM_REQUIRED for r in resolutions)

    # Overall verdict = the worst-case region verdict (severity order).
    # MERGE_PENDING_ARBITRATION sits ahead of MERGE_CLEAN so a file carrying one
    # such region and several clean ones still reports it — the routing, deletion
    # advisory and recording paths all key on seeing it. It also sits ahead of
    # MERGE_ARBITER_RESOLVED: a file with one unanswered gap declines whole rather
    # than landing its answered siblings while the unanswered one waits.
    severity = [
        MERGE_CONFLICT,
        GATED_2WAY,
        MERGE_PENDING_ARBITRATION,
        MERGE_ARBITER_RESOLVED,
        MERGE_CLEAN,
        TAKE_RELEASE,
        KEEP_LOCAL,
    ]
    present = {r.verdict for r in resolutions}
    overall = next((level for level in severity if level in present), KEEP_LOCAL)
    # A pending gap is exempt from the no-op collapse: its candidate equals the
    # local body precisely BECAUSE no side was chosen, and reporting that as a
    # no-op would tell the updater the file resolved stably and let its base entry
    # advance, which retires the contested gap without anyone judging it.
    pending = overall == MERGE_PENDING_ARBITRATION
    if candidate == local_text and not needs_llm and not pending:
        overall = NO_OP

    return FileResolution(
        target_file=target_file,
        verdict=overall,
        candidate_text=candidate,
        local_text=local_text,
        regions=resolutions,
        needs_llm=needs_llm,
        base_available=base_available,
        reason="three-anchor resolution complete",
    )


# -- base-content store (the chosen provenance for base region CONTENT) ------


# Default location of the retained base@install agent bodies. SEPARATE from the
# hash-only baseline manifest; populated by T24's install/post-apply wiring.
_STATE_DIR_ENV = "ATRIUM_UPDATE_STATE_DIR"


def state_root(state_dir: str | None = None) -> str:
    """Echo the update state root, at the precedence ``spine_baseline_dir`` uses.

    The environment leg is what lets a caller that was never handed the state
    directory reach the same root as one that was — the verify shell-out passes
    it to the base-store reader and nowhere else, so a second argv slot would be
    a value held on one side and reconstructed on the other.
    """
    return (
        state_dir
        or os.environ.get(_STATE_DIR_ENV, "").strip()
        or str(Path.home() / ".claude" / "data" / "update")
    )


def base_store_dir(state_dir: str | None = None) -> Path:
    """Echo the base-content store dir (mirrors ``spine_baseline_dir`` layout)."""
    return Path(state_root(state_dir)) / "base-agents"


def load_base_text(target_file: str, state_dir: str | None = None) -> str | None:
    """Read the retained base@install body for ``target_file`` (basename-keyed).

    Returns the content, or ``None`` when the base-content store has no entry
    (the documented fallback trigger -> gated 2-way present-both). The baseline
    MANIFEST cannot supply this (it stores hashes, not content).
    """
    candidate = base_store_dir(state_dir) / Path(target_file).name
    if candidate.is_file():
        return candidate.read_text(encoding="utf-8")
    return None


# -- Contested-gap arbitration: derive once, record, replay (A2b) ------------

# The two process modes. Replay is the DEFAULT because the verify shell-out
# names no mode: a caller that does not ask to derive must not be able to reach
# a model, and the update's verify process is exactly that caller.
ARBITER_PLAN = "plan"
ARBITER_REPLAY = "replay"

_ARBITER_RECORD_DIR = "arbiter-decisions"
_ARBITER_RETENTION_DAYS = 14

# The arbiter's three answer tokens, duplicated rather than imported: the record
# is the seam BETWEEN the two processes, and replay reads it without importing
# the module that holds the model seam. ``test_editable_merge`` pins this tuple
# against ``gap_arbiter.CHOICES`` so the duplication cannot drift unnoticed.
_ARBITER_CHOICES = ("LOCAL", "RELEASE", "INTERLEAVE")
_ARBITER_REF_RE = re.compile(r"^([LR])([0-9]+)$")

_REPLAY_ABSENT = "record-absent"
_REPLAY_MALFORMED = "record-malformed"
_REPLAY_MISMATCH = "record-fingerprint-mismatch"
_ARBITER_UNREACHABLE = "arbiter-unreachable"


def arbiter_record_dir(state_dir: str | None = None) -> Path:
    """Echo the per-gap decision dir — the base-content store's own sibling."""
    return base_store_dir(state_dir).with_name(_ARBITER_RECORD_DIR)


def build_gap_key(target: str, region_index: int, gap_index: int) -> str:
    """Name one gap's record file from the three fields that identify it.

    The digest is what keeps two targets whose sanitised stems collide apart;
    the readable stem is what makes the directory answerable by eye.
    """
    stem = re.sub(r"[^A-Za-z0-9._-]", "_", target)
    digest = hashlib.sha256(target.encode("utf-8")).hexdigest()[:12]
    return f"{stem}-{digest}.r{region_index}.g{gap_index}.json"


def build_gap_fingerprints(hunk: ConflictHunk) -> dict[str, str]:
    """Digest each anchor run, so a replay can tell it holds the same gap."""
    return {
        name: hashlib.sha256("\x00".join(lines).encode("utf-8")).hexdigest()
        for name, lines in (
            ("base", hunk.base),
            ("local", hunk.local),
            ("release", hunk.release),
        )
    }


class GapArbiter:
    """One file's contested gaps, resolved in one of the two process modes.

    Under ``ARBITER_PLAN`` each gap is derived through the arbiter module and
    the decision is recorded; under ``ARBITER_REPLAY`` the record is read and
    its references are resolved against the anchors the fingerprints pin. Every
    path that cannot produce a decision returns the local run with a named row,
    so a gap is never left to a caller to interpret.
    """

    def __init__(
        self,
        target: str,
        agent: str,
        *,
        mode: str = ARBITER_REPLAY,
        state_dir: str | None = None,
    ) -> None:
        self.target = target
        self.agent = agent
        self.mode = mode
        self.record_dir = arbiter_record_dir(state_dir)
        self._run_state = None
        self._pruned = False

    def get_gap_outcome(
        self,
        *,
        region_index: int,
        region_count: int,
        gap_index: int,
        hunk: ConflictHunk,
        context: str,
    ) -> GapOutcome:
        """Resolve one contested gap to the lines the candidate emits for it."""
        if self.mode == ARBITER_PLAN:
            return self._get_derived_outcome(
                region_index=region_index,
                region_count=region_count,
                gap_index=gap_index,
                hunk=hunk,
                context=context,
            )
        return self._get_replayed_outcome(
            region_index=region_index,
            region_count=region_count,
            gap_index=gap_index,
            hunk=hunk,
        )

    # -- plan side -----------------------------------------------------------

    def _get_derived_outcome(
        self,
        *,
        region_index: int,
        region_count: int,
        gap_index: int,
        hunk: ConflictHunk,
        context: str,
    ) -> GapOutcome:
        try:
            import gap_arbiter as ga  # noqa: PLC0415 — the model seam loads here only
        except Exception as exc:  # noqa: BLE001 — any import failure keeps local
            self._write_row(region_index, region_count, _ARBITER_UNREACHABLE, repr(exc))
            return GapOutcome(tuple(hunk.local))

        request = ga.GapRequest(
            agent=self.agent,
            region_index=region_index,
            region_count=region_count,
            region_context=context,
            base_lines=hunk.base,
            local_lines=hunk.local,
            release_lines=hunk.release,
        )
        if self._run_state is None:
            self._run_state = ga.RunState()
        try:
            decision = ga.get_decision(request, run_state=self._run_state)
        except Exception as exc:  # noqa: BLE001 — a raising judge keeps local
            self._write_row(region_index, region_count, _ARBITER_UNREACHABLE, repr(exc))
            return GapOutcome(tuple(hunk.local))

        self._set_record(
            region_index=region_index,
            region_count=region_count,
            gap_index=gap_index,
            hunk=hunk,
            decision=decision,
        )
        if decision.row:
            sys.stderr.write(f"{decision.row}\n")
        return GapOutcome(tuple(decision.lines), decision.choice, decision.rationale)

    def _set_record(
        self,
        *,
        region_index: int,
        region_count: int,
        gap_index: int,
        hunk: ConflictHunk,
        decision,
    ) -> None:
        """Persist one gap's outcome where the verify process can read it."""
        record = {
            "target": self.target,
            "agent": self.agent,
            "region_index": region_index,
            "region_count": region_count,
            "gap_index": gap_index,
            "choice": decision.choice,
            "refs": [f"{ref.source}{ref.ordinal}" for ref in decision.refs],
            "rationale": decision.rationale,
            "failure_class": decision.failure_class,
            "clause": decision.clause,
            "fingerprints": build_gap_fingerprints(hunk),
        }
        path = self.record_dir / build_gap_key(self.target, region_index, gap_index)
        try:
            self.record_dir.mkdir(parents=True, exist_ok=True)
            self._prune_records()
            path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            # An unrecorded decision is not a wrong one: the verify replay finds
            # no record and keeps local, which is what a failed derivation does.
            self._write_row(region_index, region_count, _REPLAY_ABSENT, repr(exc))

    def _prune_records(self) -> None:
        """Drop records older than the retention window, once per process.

        Age, not count: a gap's record is overwritten under its own key, so what
        accumulates is the records of gaps that stopped occurring.
        """
        if self._pruned:
            return
        self._pruned = True
        cutoff = time.time() - _ARBITER_RETENTION_DAYS * 86400
        for path in self.record_dir.glob("*.json"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError as exc:
                # Retention is best-effort and retried next run; a record that
                # cannot be pruned costs disk, whereas failing the merge here
                # would cost the update.
                sys.stderr.write(f"[arbiter] prune-skipped path={path} {exc!r}\n")

    # -- verify side (no import that can reach a model) ----------------------

    def _get_replayed_outcome(
        self,
        *,
        region_index: int,
        region_count: int,
        gap_index: int,
        hunk: ConflictHunk,
    ) -> GapOutcome:
        path = self.record_dir / build_gap_key(self.target, region_index, gap_index)
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self._write_row(region_index, region_count, _REPLAY_ABSENT, str(path))
            return GapOutcome(tuple(hunk.local))
        except (OSError, ValueError) as exc:
            self._write_row(region_index, region_count, _REPLAY_MALFORMED, repr(exc))
            return GapOutcome(tuple(hunk.local))

        if (
            not isinstance(record, dict)
            or record.get("fingerprints") != build_gap_fingerprints(hunk)
        ):
            # Fail CLOSED: a record made against other anchors describes another
            # gap, and consuming it would land text nobody judged for this one.
            self._write_row(region_index, region_count, _REPLAY_MISMATCH, str(path))
            return GapOutcome(tuple(hunk.local))

        choice = record.get("choice")
        rationale = str(record.get("rationale") or "")
        if choice is None:
            # The plan process reached no answer and wrote its own row there.
            return GapOutcome(tuple(hunk.local))
        if choice == "LOCAL":
            return GapOutcome(tuple(hunk.local), choice, rationale)
        if choice == "RELEASE":
            return GapOutcome(tuple(hunk.release), choice, rationale)
        if choice != "INTERLEAVE":
            self._write_row(region_index, region_count, _REPLAY_MALFORMED, str(choice))
            return GapOutcome(tuple(hunk.local))

        lines = self._find_referenced_lines(record.get("refs"), hunk)
        if lines is None:
            self._write_row(region_index, region_count, _REPLAY_MALFORMED, str(path))
            return GapOutcome(tuple(hunk.local))
        return GapOutcome(lines, choice, rationale)

    @staticmethod
    def _find_referenced_lines(
        refs: object, hunk: ConflictHunk
    ) -> tuple[str, ...] | None:
        """Resolve a recorded reference list to anchor lines, or None if it cannot.

        The record names lines and never carries their text, so an interleave's
        wording comes from the anchors the fingerprint check has already pinned.
        """
        if not isinstance(refs, list) or not refs:
            return None
        runs = {"L": hunk.local, "R": hunk.release}
        resolved: list[str] = []
        for ref in refs:
            match = _ARBITER_REF_RE.match(ref) if isinstance(ref, str) else None
            if match is None:
                return None
            run = runs[match.group(1)]
            ordinal = int(match.group(2))
            if not 1 <= ordinal <= len(run):
                return None
            resolved.append(run[ordinal - 1])
        return tuple(resolved)

    def _write_row(
        self, region_index: int, region_count: int, failure_class: str, detail: str
    ) -> None:
        """Write one named row in the grammar the arbiter's own rows use."""
        sys.stderr.write(
            f"[arbiter] {failure_class} agent={self.agent} "
            f"region={region_index}/{region_count} detail={detail}\n"
        )


def _splice_arbitrated(
    merged: list[str],
    hunks: list[ConflictHunk],
    arbiter: GapArbiter,
    *,
    region_index: int,
    region_count: int,
    release: list[str],
) -> tuple[list[str], tuple[GapOutcome, ...]]:
    """Replace each emitted local gap with what the arbiter resolved it to.

    Gaps resolve in document order, so a per-run call ceiling cuts the later
    ones; the splice then runs back to front, so an earlier splice cannot move
    the index a later gap recorded.
    """
    context = "".join(release)
    resolved = [
        arbiter.get_gap_outcome(
            region_index=region_index,
            region_count=region_count,
            gap_index=gap_index,
            hunk=hunk,
            context=context,
        )
        for gap_index, hunk in enumerate(hunks)
    ]
    out = list(merged)
    for gap_index in reversed(range(len(hunks))):
        hunk = hunks[gap_index]
        out[hunk.out_index : hunk.out_index + len(hunk.local)] = resolved[
            gap_index
        ].lines
    return out, tuple(resolved)


# -- Sensitive refusal + Haiku verify gate (T18) -----------------------------


def _unified_diff(a_text: str, b_text: str, target: str) -> str:
    """Unified diff a_text->b_text, for sensitive-diff scan + Haiku verify input."""
    return "".join(
        difflib.unified_diff(
            _split_lines(a_text),
            _split_lines(b_text),
            fromfile=f"a/{target}",
            tofile=f"b/{target}",
        )
    )


# Verify-callback type: (PatchProposal, Pattern, *, skip_pre_verify) -> result
VerifyFn = Callable[..., object]


@dataclass
class MergeCandidate:
    """T18 candidate + the apply/verify callbacks suitable for git_txn_apply.

    ``apply`` writes the candidate to the target (apply_fn contract: 0/3/other).
    ``verify`` runs the sensitive refusal + (when needed) the daemon's Haiku
    improvement-verify dry-run (verify_fn contract: 0 ok / non-0 fail). T19 wraps
    these as the two callback NAMES handed to ``git_txn_apply``.
    """

    resolution: FileResolution
    diff: str
    sensitive_hit: str | None
    agent: str
    verify_fn: VerifyFn
    skip_pre_verify: bool = False

    @property
    def target_file(self) -> str:
        return self.resolution.target_file

    @property
    def refused(self) -> bool:
        return self.sensitive_hit is not None

    def apply(self, target_path: str | None = None) -> int:
        """git_txn apply callback: write the candidate. 0 applied / 3 no-op / 2 malformed."""
        if self.refused:
            return APPLY_MALFORMED  # never write a sensitive-refused candidate
        if self.resolution.verdict == STRUCTURAL:
            return APPLY_MALFORMED  # roster/region mismatch is not an in-band apply
        if self.resolution.has_conflict:
            return APPLY_MALFORMED  # tripwire: markers are a report, never a file
        if not self.resolution.is_changed:
            return APPLY_NOOP  # located diff won't land (candidate == local)
        dst = Path(target_path or self.target_file)
        try:
            dst.write_text(self.resolution.candidate_text, encoding="utf-8")
        except OSError:
            return APPLY_MALFORMED
        return APPLY_OK

    def verify(self, target_path: str | None = None) -> int:
        """git_txn verify callback: 0 ok / non-0 fail.

        Re-runs the sensitive-diff refusal against the on-disk patched file, then
        — only when the resolution needs the LLM gate — the Haiku improvement-
        verify dry-run. Deterministic keep-local / take-release / no-op candidates
        pass WITHOUT any LLM call.
        """
        if self.refused:
            return 1
        if self.resolution.verdict == STRUCTURAL:
            return 1
        if self.resolution.has_conflict:
            return 1
        # Re-scan the actually-written file (defends against an unexpected on-disk
        # state introducing a sensitive added line).
        dst = Path(target_path or self.target_file)
        try:
            on_disk = dst.read_text(encoding="utf-8")
        except OSError:
            return 1
        # Tripwire BACKSTOP — markers on disk from ANY source (a stale base, a
        # restored backup, a crash window) fail the transaction into the git_txn
        # before-image restore rather than leaving a corrupted live agent body.
        if has_conflict_markers(on_disk):
            return 1
        post_diff = _unified_diff(self.resolution.local_text, on_disk, self.target_file)
        if dc.match_sensitive_diff(post_diff) is not None:
            return 1
        if not self.resolution.needs_llm:
            return 0  # deterministic candidate — NO LLM call
        return 0 if self._haiku_pass(on_disk) else 1

    def _haiku_pass(self, candidate_text: str) -> bool:
        """Run the daemon's Haiku improvement-verify dry-run over the candidate."""
        diff = _unified_diff(
            self.resolution.local_text, candidate_text, self.target_file
        )
        patch = dc.PatchProposal(
            target_file=self.target_file,
            rationale="glass-atrium-update EDITABLE-region 3-way merge candidate",
            proposed_diff=diff,
            touched_frontmatter=False,
            estimated_added_lines=diff.count("\n+"),
            raw_response="",
        )
        pattern = dc.Pattern(
            date="",
            label="editable-region-vendor-merge",
            frequency="0",
            agent=self.agent,
            status="identified",
            tier="update-skill",
            raw_line="editable-region-vendor-merge",
        )
        result = self.verify_fn(  # type: ignore[call-arg]
            patch, pattern, skip_pre_verify=self.skip_pre_verify
        )
        if bool(getattr(result, "passed", False)):
            return True
        # The reason exists on the result and died at this boolean: the updater
        # reduces the return to an exit code, so a rejection reached the log as a
        # bare rollback. stderr already flows into the update log — no plumbing.
        #
        # Every interpolated field goes through dc.flatten_log_field, not just the
        # LLM-authored rationale: they all arrive off a duck-typed result via
        # getattr, so the closed-set guarantee for `status` and for the C[1-4] axis
        # keys lives in daemon_cycle's parser rather than at this boundary. Guarding
        # one field and trusting its neighbours leaves the next author to guess
        # which were checked.
        axes = getattr(result, "axes", None) or {}
        failed = ", ".join(
            sorted(dc.flatten_log_field(key) for key, ok in axes.items() if not ok)
        )
        target = dc.flatten_log_field(self.target_file, default="(unnamed)")
        status = dc.flatten_log_field(
            getattr(result, "status", ""), default="(unreported)"
        )
        rationale = dc.flatten_log_field(
            getattr(result, "rationale", ""), default="(none reported)"
        )
        sys.stderr.write(
            f"editable_merge: pre-verify REJECTED — {target} "
            f"status={status} "
            f"failed_axes=[{failed or '(none reported)'}] "
            f"rationale={rationale}\n"
        )
        return False


def build_merge_candidate(
    target_file: str,
    local_text: str,
    release_text: str,
    *,
    base_text: str | None = None,
    agent: str | None = None,
    verify_fn: VerifyFn | None = None,
    skip_pre_verify: bool = False,
    resolve_conflicting_gaps: bool = True,
    arbiter_mode: str = ARBITER_REPLAY,
    state_dir: str | None = None,
) -> MergeCandidate:
    """T18 entry — produce the candidate + its apply/verify callbacks.

    Sensitive refusal fires FIRST on the target PATH (GLOBAL_RULES / security
    rules / ``com.glass-atrium.*.plist`` / .env), then on the candidate DIFF's
    added lines. A refused candidate exposes apply()/verify() that hard-fail so the
    git_txn transaction rolls back. ``verify_fn`` defaults to the daemon's
    ``run_pre_verify`` (injectable for tests).

    ``arbiter_mode`` defaults to replay so the verify shell-out — which names no
    mode and receives no candidate path — consumes the plan process's record
    instead of deriving a second decision from the same anchors.
    """
    agent_name = agent or Path(target_file).stem
    resolution = resolve_file(
        target_file,
        local_text,
        release_text,
        base_text,
        resolve_conflicting_gaps=resolve_conflicting_gaps,
        arbiter=GapArbiter(
            target_file, agent_name, mode=arbiter_mode, state_dir=state_dir
        ),
    )
    diff = _unified_diff(local_text, resolution.candidate_text, target_file)

    sensitive_hit = dc.match_sensitive_path(target_file)
    if sensitive_hit is None:
        sensitive_hit = dc.match_sensitive_diff(diff)

    return MergeCandidate(
        resolution=resolution,
        diff=diff,
        sensitive_hit=sensitive_hit,
        agent=agent_name,
        verify_fn=verify_fn or dc.run_pre_verify,
        skip_pre_verify=skip_pre_verify,
    )


# -- Thin CLI (git_txn bash-callback seam for T19) ---------------------------
# Exit codes are loud-fail per shared-self-improve-hygiene Precondition Loud-Fail.
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_REFUSED = 3


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def _cmd_plan(args: argparse.Namespace) -> int:
    """Resolve + write the candidate file; print the verdict line for the skill."""
    base_text = (
        _read(args.base) if args.base else load_base_text(args.target, args.state_dir)
    )
    local_text = _read(args.local)
    release_text = _read(args.release)
    cand = build_merge_candidate(
        args.target,
        local_text,
        release_text,
        base_text=base_text,
        agent=args.agent,
        skip_pre_verify=True,  # planning is structural only; verify runs in the txn
        arbiter_mode=ARBITER_PLAN,  # the one process permitted to reach the model
        state_dir=args.state_dir,
    )
    if cand.refused:
        sys.stderr.write(
            f"editable_merge: REFUSED — {args.target} matched /{cand.sensitive_hit}/\n"
        )
        return EXIT_REFUSED
    Path(args.out).write_text(cand.resolution.candidate_text, encoding="utf-8")
    if args.diff_out:
        # The SAME live-to-candidate diff the candidate was validated against (the
        # sensitive scan and the Haiku gate read this text). Handing it to the
        # recording caller keeps one diff implementation in the loop: a caller
        # re-deriving it with `diff -u` would record text this merge never saw.
        Path(args.diff_out).write_text(cand.diff, encoding="utf-8")
    # Key names are regex-constrained to be space-free, so the comma-joined value
    # stays a single plan-line token; the literal `none` says "nothing dropped"
    # explicitly rather than as an empty one.
    dropped = dropped_local_frontmatter_keys(
        local_text, cand.resolution.candidate_text
    )
    gaps = resolved_gap_stats(cand.resolution)
    # The discarded local lines cannot ride the plan line — it is free text and the
    # updater's extractor reads only up to the next space — and they exist nowhere
    # else once the answers have replaced them. The sidecar keeps the recording
    # caller's excerpt to text a gap actually discarded; a diff-derived excerpt
    # would also quote vendor lines the release restructured, which the record
    # would then misattribute to the daemon.
    dropped_lines = dropped_gap_lines(cand.resolution)
    if dropped_lines:
        Path(f"{args.out}.dropped").write_text(
            "".join(dropped_lines), encoding="utf-8"
        )
    sys.stdout.write(
        f"verdict={cand.resolution.verdict} needs_llm={cand.resolution.needs_llm} "
        f"base_available={cand.resolution.base_available} "
        f"changed={cand.resolution.is_changed} "
        f"fm_unallowlisted={','.join(dropped) if dropped else 'none'} "
        f"resolved_hunks={gaps['hunks']} "
        f"resolved_dropped_lines={gaps['dropped_lines']} "
        f"resolved_added_lines={gaps['added_lines']} "
        f"resolved_regions={gaps['regions']} "
        f"out={args.out}\n"
    )
    return EXIT_OK


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="editable_merge.py",
        description="Three-anchor EDITABLE-region merge candidate (T17/T18).",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_plan = sub.add_parser("plan", help="resolve anchors + write a candidate file")
    p_plan.add_argument("--target", required=True, help="agent file logical path")
    p_plan.add_argument("--local", required=True, help="current local file")
    p_plan.add_argument("--release", required=True, help="incoming release file")
    p_plan.add_argument("--base", help="explicit base@install file (else base store)")
    p_plan.add_argument("--out", required=True, help="candidate output path")
    p_plan.add_argument(
        "--diff-out", help="write the live-to-candidate unified diff to this path"
    )
    p_plan.add_argument("--agent", help="agent name (default: target stem)")
    p_plan.add_argument("--state-dir", help="update state dir override")
    args = parser.parse_args(argv)
    if args.command == "plan":
        return _cmd_plan(args)
    parser.print_usage(sys.stderr)
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
