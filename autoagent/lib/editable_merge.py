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
``skills/glass-atrium-update/`` (T20) nor ``lib/ga-core.sh`` (E5).

Reuse (NOT re-implemented here — imported from the daemon):
  * ``daemon_cycle._editable_spans``  — the canonical EDITABLE marker pairing.
  * ``daemon_cycle.match_sensitive_path`` / ``match_sensitive_diff`` — the single
    compiled sensitive-refusal source (GLOBAL_RULES / security rules / .env /
    ``com.glass-atrium.*.plist`` / irreversible-command diffs).
  * ``daemon_cycle.run_pre_verify`` (+ ``PatchProposal`` / ``Pattern``) — the
    Haiku improvement-verify dry-run that gates a both-changed merge candidate.

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
       * different  -> GATED_2WAY verdict: a present-both candidate surfacing BOTH
                       sides, forced through the Haiku verify + the foreground
                       confirm — never silently auto-picked, never a faked 3-way.

So a missing base-content store DEGRADES safety-conservatively (more human
gating), it never silently corrupts a learned region.

No third-party dependencies — stdlib only (difflib, dataclasses, pathlib).
Bash-callback seam for git_txn_apply (T19): see ``MergeCandidate.apply`` /
``MergeCandidate.verify`` + the thin CLI at the bottom.
"""

from __future__ import annotations

import argparse
import difflib
import sys
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
GATED_2WAY = "gated-2way-present-both"  # base content unavailable, sides differ
STRUCTURAL = "structural-change"  # region-count mismatch -> manual ceremony
REFUSED = "sensitive-refused"  # target path / diff matched a sensitive pattern
NO_OP = "no-op"  # candidate identical to current local file

# Verdicts that REQUIRE the Haiku improvement-verify gate (an ambiguous,
# net-new-merged region). KEEP_LOCAL / TAKE_RELEASE / NO_OP are deterministic and
# make NO LLM call (T18 AC: "only-local or only-vendor changes make NO LLM call").
_LLM_REQUIRED = frozenset({MERGE_CLEAN, MERGE_CONFLICT, GATED_2WAY})

# git_txn_apply apply-callback contract (mirrors daemon-apply.sh apply_diff):
#   0 = applied · 3 = located-diff-won't-land (no bytes written) · other = malformed.
APPLY_OK = 0
APPLY_NOOP = 3
APPLY_MALFORMED = 2

# Conflict markers for an overlapping both-changed region (diff3 / git style).
_C_LOCAL = "<<<<<<< LOCAL (learned)\n"
_C_BASE = "||||||| BASE (base@install)\n"
_C_REL = "=======\n"
_C_END = ">>>>>>> RELEASE (vendor)\n"


@dataclass(frozen=True)
class RegionResolution:
    """Outcome for a single EDITABLE region (document order ``index``)."""

    index: int
    verdict: str
    content: list[str]  # resolved region content lines (kept endings)
    had_conflict: bool = False
    reason: str = ""


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


def three_way_merge(
    base: list[str], local: list[str], release: list[str]
) -> tuple[list[str], bool]:
    """diff3-style line merge of one region. Returns (merged_lines, had_conflict).

    A gap changed by only one side is taken from that side; a gap both sides
    changed identically collapses to one copy; a gap both sides changed
    DIFFERENTLY emits git-style conflict markers and sets ``had_conflict`` — the
    candidate then routes through the Haiku verify + foreground confirm rather
    than being silently auto-applied.
    """
    sync = _find_sync_regions(base, local, release)
    iz = ia = ib = 0
    out: list[str] = []
    had_conflict = False
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
            had_conflict = True
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
    return out, had_conflict


# -- Per-region three-anchor resolution (T17 / T18 candidate) ----------------


def _resolve_region(
    index: int,
    base: list[str] | None,
    local: list[str],
    release: list[str],
) -> RegionResolution:
    """Classify one region against the three anchors and resolve its content."""
    if base is None:
        # FALLBACK: gated 2-way present-both (base content unavailable).
        if local == release:
            return RegionResolution(
                index, KEEP_LOCAL, local, reason="2way: sides identical"
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
    merged, conflict = three_way_merge(base, local, release)
    verdict = MERGE_CONFLICT if conflict else MERGE_CLEAN
    return RegionResolution(
        index,
        verdict,
        merged,
        had_conflict=conflict,
        reason="both changed; net-new diff3 candidate",
    )


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


def resolve_file(
    target_file: str,
    local_text: str,
    release_text: str,
    base_text: str | None = None,
) -> FileResolution:
    """T17 three-anchor resolver — pure, makes NO LLM call.

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

    resolutions: list[RegionResolution] = []
    for idx, ((_, _, local_c), (_, _, release_c)) in enumerate(
        zip(local_regions, release_regions, strict=True)
    ):
        base_c: list[str] | None = None
        if base_regions is not None and idx < len(base_regions):
            base_c = base_regions[idx][2]
        resolutions.append(_resolve_region(idx, base_c, local_c, release_c))

    candidate = _assemble(release_lines, release_regions, resolutions)
    needs_llm = any(r.verdict in _LLM_REQUIRED for r in resolutions)

    # Overall verdict = the worst-case region verdict (severity order).
    severity = [MERGE_CONFLICT, GATED_2WAY, MERGE_CLEAN, TAKE_RELEASE, KEEP_LOCAL]
    overall = KEEP_LOCAL
    for level in severity:
        if any(r.verdict == level for r in resolutions):
            overall = level
            break
    if candidate == local_text and not needs_llm:
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
def base_store_dir(state_dir: str | None = None) -> Path:
    """Echo the base-content store dir (mirrors ``spine_baseline_dir`` layout)."""
    root = state_dir or str(Path.home() / ".claude" / "data" / "update")
    return Path(root) / "base-agents"


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
        # Re-scan the actually-written file (defends against an unexpected on-disk
        # state introducing a sensitive added line).
        dst = Path(target_path or self.target_file)
        try:
            on_disk = dst.read_text(encoding="utf-8")
        except OSError:
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
        return bool(getattr(result, "passed", False))


def build_merge_candidate(
    target_file: str,
    local_text: str,
    release_text: str,
    *,
    base_text: str | None = None,
    agent: str | None = None,
    verify_fn: VerifyFn | None = None,
    skip_pre_verify: bool = False,
) -> MergeCandidate:
    """T18 entry — produce the candidate + its apply/verify callbacks.

    Sensitive refusal fires FIRST on the target PATH (GLOBAL_RULES / security
    rules / ``com.glass-atrium.*.plist`` / .env), then on the candidate DIFF's
    added lines. A refused candidate exposes apply()/verify() that hard-fail so the
    git_txn transaction rolls back. ``verify_fn`` defaults to the daemon's
    ``run_pre_verify`` (injectable for tests).
    """
    resolution = resolve_file(target_file, local_text, release_text, base_text)
    diff = _unified_diff(local_text, resolution.candidate_text, target_file)

    sensitive_hit = dc.match_sensitive_path(target_file)
    if sensitive_hit is None:
        sensitive_hit = dc.match_sensitive_diff(diff)

    return MergeCandidate(
        resolution=resolution,
        diff=diff,
        sensitive_hit=sensitive_hit,
        agent=agent or Path(target_file).stem,
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
    cand = build_merge_candidate(
        args.target,
        _read(args.local),
        _read(args.release),
        base_text=base_text,
        agent=args.agent,
        skip_pre_verify=True,  # planning is structural only; verify runs in the txn
    )
    if cand.refused:
        sys.stderr.write(
            f"editable_merge: REFUSED — {args.target} matched /{cand.sensitive_hit}/\n"
        )
        return EXIT_REFUSED
    Path(args.out).write_text(cand.resolution.candidate_text, encoding="utf-8")
    sys.stdout.write(
        f"verdict={cand.resolution.verdict} needs_llm={cand.resolution.needs_llm} "
        f"base_available={cand.resolution.base_available} "
        f"changed={cand.resolution.is_changed} out={args.out}\n"
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
    p_plan.add_argument("--agent", help="agent name (default: target stem)")
    p_plan.add_argument("--state-dir", help="update state dir override")
    args = parser.parse_args(argv)
    if args.command == "plan":
        return _cmd_plan(args)
    parser.print_usage(sys.stderr)
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
