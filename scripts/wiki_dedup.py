"""Duplicate note detection and merge proposal generator.

Responsibilities:
    Scan all wiki/notes/*.md, apply heuristic pre-filter (Jaccard title +
    sentence overlap), then invoke Haiku (≤5 calls/cycle) to verify candidate
    clusters and emit structured merge proposals to the daily JSON report.

    ALL proposals go to dry-run — zero auto-writes.  User decision only.

No third-party dependencies — stdlib only (difflib, re, json, pathlib,
subprocess, hashlib, dataclasses).  Python 3.12+ idioms.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

# -- Constants ---------------------------------------------------------------

HOME = Path(os.environ.get("HOME", str(Path.home())))
# WIKI_ROOT env is the single source of truth for the wiki data root. Default =
# the glass-atrium store. This is the LIVE default — the bash wrapper does not pass
# --wiki-root by default, so the env read MUST live on this constant.
DEFAULT_WIKI_ROOT = Path(os.environ.get("WIKI_ROOT") or os.path.join(os.path.expanduser("~"), ".glass-atrium", "wiki"))
DEFAULT_NOTES_DIR = DEFAULT_WIKI_ROOT / "notes"

CLAUDE_BIN = os.environ.get("WIKI_DAEMON_CLAUDE_BIN", "claude")

# Read budget/model literals from the shared JSON SoT (daemon-config.json).
# hooks/ self-located from THIS file (store: ~/.glass-atrium/{scripts,hooks} siblings;
# CI checkout: repo/{scripts,hooks}) — ~/.claude/hooks is no longer farmed, so a
# HOME-anchored insert breaks fresh installs. resolve() dereferences the scripts facade symlink.
_HOOKS_DIR = Path(__file__).resolve().parent.parent / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
from daemon_config import HAIKU_MAX_BUDGET_USD, HAIKU_MODEL  # noqa: E402

# Cost guard: max 5 Haiku calls per cycle.
MAX_LLM_CALLS = 5
HAIKU_TIMEOUT_SEC = 90
# HAIKU_MAX_BUDGET_USD is read from the daemon_config SoT (SoT default '0.50').
# HAIKU_MODEL is also from SoT.

# Heuristic thresholds.
JACCARD_TITLE_THRESHOLD = 0.5     # token overlap on slug titles
SENTENCE_OVERLAP_THRESHOLD = 0.50  # fraction of sentences shared
NOTE_EXCERPT_CHARS = 4000          # chars fed to Haiku per note

# Similarity threshold for LLM skip (already same cluster, heuristic enough).
NEAR_IDENTICAL_THRESHOLD = 0.90

# -- Data models -------------------------------------------------------------


@dataclass(frozen=True)
class NoteFile:
    """One compiled note under wiki/notes/."""
    abs_path: Path
    slug: str
    tags: list[str]
    title: str


@dataclass(frozen=True)
class DedupProposal:
    """A dry-run merge proposal for a duplicate cluster."""
    target_slug: str            # slug to keep (canonical note)
    source_slugs: list[str]     # slugs to merge IN (will become redirects)
    similarity_score: float     # heuristic score [0.0, 1.0]
    llm_verdict: str            # 'duplicate' | 'not-duplicate' | 'skipped' | 'error:<msg>'
    llm_rationale: str          # Haiku's one-sentence rationale
    suggested_action: str       # human-readable merge instruction
    cluster_hash: str           # deterministic ID for idempotency


@dataclass
class DedupResult:
    """Dedup stage outcome appended to the daily JSON report."""
    scanned_notes: int
    candidate_clusters: int
    llm_calls_used: int
    proposals: list[DedupProposal] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    # Pairs still awaiting LLM verification after this cycle's budget
    # (monotonically drains across cycles via verified-hash persistence).
    not_verified: int = 0


# -- Note scanning -----------------------------------------------------------


def _parse_frontmatter_title(text: str, slug: str) -> str:
    """Extract title from YAML frontmatter block; fall back to slug."""
    fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if fm_match:
        fm_block = fm_match.group(1)
        title_m = re.search(r"^title:\s*(.+)$", fm_block, re.MULTILINE)
        if title_m:
            return title_m.group(1).strip().strip('"\'')
    # Fall back: first H1
    h1_m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if h1_m:
        return h1_m.group(1).strip()
    return slug


def _parse_frontmatter_tags(text: str) -> list[str]:
    """Extract tags list from frontmatter."""
    fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not fm_match:
        return []
    fm_block = fm_match.group(1)
    # Inline: tags: [a, b, c]
    inline_m = re.search(r"^tags:\s*\[([^\]]*)\]", fm_block, re.MULTILINE)
    if inline_m:
        raw = inline_m.group(1)
        return [t.strip().strip('"\'') for t in raw.split(",") if t.strip()]
    # Block style:
    # tags:
    #   - a
    #   - b
    block_m = re.search(r"^tags:\s*\n((?:\s+-\s*.+\n?)*)", fm_block, re.MULTILINE)
    if block_m:
        lines = block_m.group(1).strip().splitlines()
        return [re.sub(r"^\s*-\s*", "", l).strip() for l in lines if l.strip()]
    return []


def scan_notes(notes_dir: Path) -> list[NoteFile]:
    """Return all .md files under notes_dir (excluding .gitkeep and hidden)."""
    results: list[NoteFile] = []
    if not notes_dir.is_dir():
        return results
    for entry in sorted(notes_dir.iterdir()):
        if not entry.is_file():
            continue
        if not entry.name.endswith(".md"):
            continue
        if entry.name.startswith("."):
            continue
        if entry.name == ".gitkeep":
            continue
        try:
            text = entry.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        slug = entry.stem
        title = _parse_frontmatter_title(text, slug)
        tags = _parse_frontmatter_tags(text)
        results.append(NoteFile(abs_path=entry, slug=slug, tags=tags, title=title))
    return results


# -- Heuristic similarity ----------------------------------------------------


def _tokenize_slug(slug: str) -> set[str]:
    """Split kebab-case slug into lowercase tokens; skip short stop tokens.

    Single-char DIGIT tokens (version pins 4/7/8, etc.) are preserved. Dropping
    version digits would give opus-4-7 vs opus-4-8 identical token sets → jaccard
    1.0 → an LLM skip + a proposal to delete the newer document. Digit tokens are
    preserved regardless of length.
    """
    stops = {"the", "a", "an", "and", "or", "of", "in", "to", "for", "with",
              "on", "at", "by", "from", "is", "are", "was", "be", "as"}
    parts = re.split(r"[-_\s]+", slug.lower())
    return {
        p for p in parts
        if p and p not in stops and (len(p) > 1 or p.isdigit())
    }


def jaccard_similarity(a: str, b: str) -> float:
    """Jaccard index on slug token sets."""
    ta, tb = _tokenize_slug(a), _tokenize_slug(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


_VERSION_TOKEN_RE = re.compile(r"^v?\d[\d.]*$|^\d+$")


def _is_version_token(token: str) -> bool:
    """True iff token is a bare version/number (e.g. '4', '7', '8', 'v2', '4.7')."""
    return bool(_VERSION_TOKEN_RE.match(token))


def slug_diff_is_version_only(slug_a: str, slug_b: str) -> bool:
    """True iff two slugs differ ONLY in version/number tokens (data-safety).

    Guards the near-identical heuristic short-circuit: when the symmetric token
    difference consists entirely of version/number tokens AND the non-version
    token sets are identical, the slugs are different *versions* of a concept
    (opus-4-7 vs opus-4-8) — NOT duplicates. Such pairs MUST take the LLM path
    so the newer doc is never auto-proposed for deletion.
    """
    ta, tb = _tokenize_slug(slug_a), _tokenize_slug(slug_b)
    sym_diff = ta ^ tb
    if not sym_diff:
        return False  # identical token sets — not a version-only difference
    if not all(_is_version_token(t) for t in sym_diff):
        return False  # some non-version token differs → genuine surface diff
    # Non-version tokens must match exactly for this to be a pure version delta.
    return {t for t in ta if not _is_version_token(t)} == {
        t for t in tb if not _is_version_token(t)
    }


def _extract_sentences(text: str) -> list[str]:
    """Rough sentence tokenizer — split on '. ', '.\n', '! ', '? '."""
    # Strip frontmatter and code blocks first (they inflate overlap artificially).
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.DOTALL)
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)
    # Normalize whitespace.
    text = re.sub(r"\s+", " ", text).strip()
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return [s.strip() for s in sentences if len(s.strip()) > 20]


def sentence_overlap(text_a: str, text_b: str) -> float:
    """Fraction of text_a sentences that appear verbatim (normalized) in text_b."""
    sents_a = _extract_sentences(text_a)
    if not sents_a:
        return 0.0
    normalized_b = {re.sub(r"\s+", " ", s.lower().strip()) for s in _extract_sentences(text_b)}
    count = sum(
        1 for s in sents_a
        if re.sub(r"\s+", " ", s.lower().strip()) in normalized_b
    )
    return count / len(sents_a)


def heuristic_similarity(
    slug_a: str, text_a: str,
    slug_b: str, text_b: str,
) -> float:
    """Combined heuristic: max(jaccard_slug, sentence_overlap)."""
    j = jaccard_similarity(slug_a, slug_b)
    so = max(sentence_overlap(text_a, text_b), sentence_overlap(text_b, text_a))
    return max(j, so)


# -- Cluster building --------------------------------------------------------


def build_candidate_clusters(
    notes: list[NoteFile],
    *,
    jaccard_threshold: float = JACCARD_TITLE_THRESHOLD,
    overlap_threshold: float = SENTENCE_OVERLAP_THRESHOLD,
) -> list[tuple[NoteFile, NoteFile, float]]:
    """Return pairs (a, b, score) where score >= max(thresholds).

    O(n^2) is fine for typical vault sizes (<200 notes). For n=200 that's
    ~20K comparisons, each <1ms → <20s total.
    """
    pairs: list[tuple[NoteFile, NoteFile, float]] = []
    texts: dict[str, str] = {}

    def _text(note: NoteFile) -> str:
        if note.slug not in texts:
            try:
                texts[note.slug] = note.abs_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                texts[note.slug] = ""
        return texts[note.slug]

    for i, a in enumerate(notes):
        for b in notes[i + 1 :]:
            j = jaccard_similarity(a.slug, b.slug)
            if j >= jaccard_threshold:
                score = j
            else:
                ta, tb = _text(a), _text(b)
                so = max(sentence_overlap(ta, tb), sentence_overlap(tb, ta))
                if so < overlap_threshold:
                    continue
                score = so
            pairs.append((a, b, score))

    # Sort descending by score — most likely duplicates first.
    pairs.sort(key=lambda t: t[2], reverse=True)
    return pairs


# -- Cluster hash (idempotency) ----------------------------------------------


def _cluster_hash(slug_a: str, slug_b: str) -> str:
    """Deterministic 12-char hash for a (slug_a, slug_b) pair (sorted)."""
    key = "|".join(sorted([slug_a, slug_b]))
    return hashlib.sha256(key.encode()).hexdigest()[:12]


# -- Cross-cycle verified-hash persistence (backlog drain) -------------------

# State file storing cluster hashes already LLM-verified in PRIOR cycles, so the
# fixed-5 per-cycle budget skips them and reaches the sub-0.90 tail (otherwise
# starved, with llm_calls_used pinned at 5).
DEFAULT_VERIFIED_HASHES_PATH = HOME / ".claude" / "data" / "wiki-dedup-verified-hashes.json"


def load_verified_hashes(path: Path = DEFAULT_VERIFIED_HASHES_PATH) -> set[str]:
    """Return cluster hashes LLM-verified in prior cycles. Never raises.

    Missing / corrupt / wrong-shape state → empty set (degrades to legacy
    every-cycle-top-5 behavior, no crash). Accepts a top-level JSON array of
    strings or an object with a "verified" array.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set()
    except (OSError, ValueError):
        # Corrupt state is non-fatal — surface on stderr, fall back to empty.
        sys.stderr.write(
            f"[wiki-dedup] WARN: unreadable verified-hash state → ignoring ({path})\n"
        )
        return set()
    items = raw.get("verified") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return set()
    return {h for h in items if isinstance(h, str) and h}


def save_verified_hashes(
    hashes: set[str],
    path: Path = DEFAULT_VERIFIED_HASHES_PATH,
) -> bool:
    """Persist verified cluster hashes atomically (mktemp + os.replace).

    Returns True on success, False on any I/O error (caller treats persistence
    as best-effort — a failed save just re-verifies next cycle, no data loss).
    """
    payload = {"verified": sorted(hashes)}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except (FileNotFoundError, NameError):
            pass
        return False
    return True


# -- LLM verification --------------------------------------------------------


_DEDUP_PROMPT = """You are a wiki duplicate detector.

Two wiki notes from the same Atrium wiki are shown below. Determine if they
are genuine duplicates (same concept, just expressed differently) or legitimately
distinct notes that happen to share surface-level similarity.

NOTE A (slug: {slug_a}):
---
{excerpt_a}
---

NOTE B (slug: {slug_b}):
---
{excerpt_b}
---

Respond with EXACTLY three lines, NO preamble, NO markdown:
VERDICT: <duplicate|not-duplicate>
RATIONALE: <one sentence explaining why>
MERGE_TARGET: <slug_a|slug_b|either>   (only relevant when VERDICT=duplicate; prefer the note with richer content)
"""


def _call_haiku_dedup(
    slug_a: str, excerpt_a: str,
    slug_b: str, excerpt_b: str,
    *,
    claude_bin: str = CLAUDE_BIN,
    skip_llm: bool = False,
) -> tuple[str, str, str]:
    """Returns (verdict, rationale, merge_target).

    verdict: 'duplicate' | 'not-duplicate' | 'skipped' | 'error:<msg>'
    """
    if skip_llm:
        return "skipped", "LLM call skipped (dry-run/test mode)", "either"

    prompt = _DEDUP_PROMPT.format(
        slug_a=slug_a,
        excerpt_a=excerpt_a[:NOTE_EXCERPT_CHARS],
        slug_b=slug_b,
        excerpt_b=excerpt_b[:NOTE_EXCERPT_CHARS],
    )

    try:
        completed = subprocess.run(  # noqa: S603
            [
                claude_bin,
                "-p", prompt,
                "--output-format", "text",
                "--max-budget-usd", HAIKU_MAX_BUDGET_USD,
                "--model", HAIKU_MODEL,
            ],
            capture_output=True,
            text=True,
            timeout=HAIKU_TIMEOUT_SEC,
            check=False,
            env={**os.environ, "OTEL_METRICS_EXPORTER": "none"},
        )
    except subprocess.TimeoutExpired:
        return "error:haiku-timeout", "Haiku call timed out", "either"
    except FileNotFoundError:
        return f"error:claude-cli-missing:{claude_bin}", "claude CLI not found", "either"

    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "")[:200]
        return f"error:haiku-exit-{completed.returncode}", tail, "either"

    text = completed.stdout.strip()
    verdict_m = re.search(r"^VERDICT:\s*(duplicate|not-duplicate)\b", text, re.MULTILINE | re.IGNORECASE)
    rationale_m = re.search(r"^RATIONALE:\s*(.+)$", text, re.MULTILINE)
    target_m = re.search(r"^MERGE_TARGET:\s*(\S+)", text, re.MULTILINE)

    verdict = verdict_m.group(1).lower() if verdict_m else "error:no-verdict"
    rationale = rationale_m.group(1).strip() if rationale_m else text[:200]
    merge_target = target_m.group(1).strip() if target_m else "either"

    return verdict, rationale, merge_target


# -- Main --------------------------------------------------------------------


def run_dedup(
    *,
    wiki_root: Path = DEFAULT_WIKI_ROOT,
    notes_dir: Path | None = None,
    skip_llm: bool = False,
    max_llm_calls: int = MAX_LLM_CALLS,
    verified_hashes_path: Path | None = DEFAULT_VERIFIED_HASHES_PATH,
) -> DedupResult:
    """Full pass — scan notes, heuristic filter, LLM verify, emit proposals.

    When `notes_dir` is provided, it is used directly as the scan target
    (overrides `wiki_root / "notes"`). This enables synthetic-fixture testing.

    Cross-cycle verified-hash persistence: pairs LLM-verified in prior cycles
    are skipped (no re-spend), so the fixed per-cycle budget reaches the
    otherwise-starved sub-0.90 tail and the backlog drains monotonically.
    Pass ``verified_hashes_path=None`` to disable persistence (test isolation).
    """
    # Honor explicit notes_dir end-to-end; otherwise derive from wiki_root.
    effective_notes_dir = notes_dir if notes_dir is not None else (wiki_root / "notes")
    notes = scan_notes(effective_notes_dir)

    result = DedupResult(
        scanned_notes=len(notes),
        candidate_clusters=0,
        llm_calls_used=0,
    )

    if len(notes) < 2:
        return result

    pairs = build_candidate_clusters(notes)
    result.candidate_clusters = len(pairs)

    # Prior-cycle verified hashes (skip them to free budget for the tail).
    prior_verified: set[str] = (
        load_verified_hashes(verified_hashes_path)
        if verified_hashes_path is not None and not skip_llm
        else set()
    )
    newly_verified: set[str] = set()

    llm_calls = 0
    seen_cluster_hashes: set[str] = set()
    not_verified = 0

    for note_a, note_b, score in pairs:
        ch = _cluster_hash(note_a.slug, note_b.slug)
        if ch in seen_cluster_hashes:
            continue
        seen_cluster_hashes.add(ch)

        # When the slug difference is purely version/number tokens
        # (opus-4-7 vs opus-4-8), the near-identical short-circuit MUST NOT
        # fire: those are different *versions*, not duplicates → force LLM so
        # the newer doc is never auto-proposed for deletion.
        version_only = slug_diff_is_version_only(note_a.slug, note_b.slug)

        # Near-identical by heuristic alone → skip LLM, emit direct proposal.
        if score >= NEAR_IDENTICAL_THRESHOLD and not version_only:
            verdict = "duplicate"
            rationale = f"heuristic similarity {score:.2f} ≥ {NEAR_IDENTICAL_THRESHOLD} (near-identical; LLM skipped)"
            merge_target = note_a.slug  # keep first alphabetically
        else:
            # Already LLM-verified in a prior cycle → don't re-spend budget.
            if ch in prior_verified:
                continue

            if llm_calls >= max_llm_calls:
                # Cost guard: count remaining unverified pairs (drains next cycle).
                not_verified += 1
                continue

            try:
                excerpt_a = note_a.abs_path.read_text(encoding="utf-8", errors="replace")
                excerpt_b = note_b.abs_path.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                result.errors.append(f"read-error for cluster {ch}: {exc}")
                continue

            verdict, rationale, merge_target = _call_haiku_dedup(
                note_a.slug, excerpt_a,
                note_b.slug, excerpt_b,
                skip_llm=skip_llm,
            )
            llm_calls += 1
            # Record real LLM verdicts (not skipped/error) for cross-cycle skip.
            if verdict in ("duplicate", "not-duplicate"):
                newly_verified.add(ch)

        # Only emit proposal when LLM-confirmed or heuristic near-identical.
        emit_heuristic = score >= NEAR_IDENTICAL_THRESHOLD and not version_only
        if verdict == "duplicate" or emit_heuristic:
            # Resolve target vs source slugs from merge_target.
            if merge_target == note_b.slug:
                target_slug, source_slugs = note_b.slug, [note_a.slug]
            else:
                target_slug, source_slugs = note_a.slug, [note_b.slug]

            result.proposals.append(DedupProposal(
                target_slug=target_slug,
                source_slugs=source_slugs,
                similarity_score=round(score, 4),
                llm_verdict=verdict,
                llm_rationale=rationale[:400],
                suggested_action=(
                    f"Merge content of notes/{'/notes/'.join(source_slugs)}.md "
                    f"into notes/{target_slug}.md, "
                    f"then delete source note(s). All wikilinks to source slug(s) "
                    f"need updating. DRY-RUN — requires user approval."
                ),
                cluster_hash=ch,
            ))

    result.llm_calls_used = llm_calls
    result.not_verified = not_verified
    if not_verified:
        result.errors.append(
            f"cost-guard: LLM call limit {max_llm_calls} reached; "
            f"{not_verified} pairs not LLM-verified (drain next cycle)"
        )

    # Persist this cycle's new verifications (best-effort; merge with prior).
    if verified_hashes_path is not None and not skip_llm and newly_verified:
        save_verified_hashes(prior_verified | newly_verified, verified_hashes_path)

    return result


# -- Serialization -----------------------------------------------------------


def dedup_result_to_dict(result: DedupResult) -> dict:
    return {
        "scanned_notes": result.scanned_notes,
        "candidate_clusters": result.candidate_clusters,
        "llm_calls_used": result.llm_calls_used,
        "not_verified": result.not_verified,
        # Stage-scoped budget ceiling so the per-cycle report surfaces the
        # dedup --max-budget-usd. Always the daemon_config SoT value (field
        # had no per-result variability).
        "cost_guard": {
            "dedup_max_budget_usd_per_call": HAIKU_MAX_BUDGET_USD,
            "max_llm_calls": result.llm_calls_used,
        },
        "proposals": [asdict(p) for p in result.proposals],
        "errors": result.errors,
    }


# -- CLI (used by wiki-dedup.sh) ---------------------------------------------


def _main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="wiki_dedup")
    parser.add_argument("--wiki-root", type=Path, default=DEFAULT_WIKI_ROOT)
    parser.add_argument("--notes-dir", type=Path, default=None,
                        help="Override wiki/notes/ path (for testing)")
    parser.add_argument("--skip-llm", action="store_true",
                        help="Skip Haiku calls (dry-run / test mode)")
    parser.add_argument("--max-llm-calls", type=int, default=MAX_LLM_CALLS)
    parser.add_argument("--out-json", type=Path, default=None,
                        help="Append dedup_proposals key to this JSON file")
    parser.add_argument("--self-test", action="store_true",
                        help="Run inline heuristic unit tests")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    # Pass notes_dir directly when provided so run_dedup honors the override.
    result = run_dedup(
        wiki_root=args.wiki_root,
        notes_dir=args.notes_dir,
        skip_llm=args.skip_llm,
        max_llm_calls=args.max_llm_calls,
    )

    payload = dedup_result_to_dict(result)

    if args.out_json:
        # Merge into existing JSON file under 'dedup_proposals' key.
        existing: dict = {}
        if args.out_json.exists():
            try:
                existing = json.loads(args.out_json.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                existing = {}
        existing["dedup_proposals"] = payload

        fd, tmp = tempfile.mkstemp(
            prefix=args.out_json.name + ".",
            suffix=".tmp",
            dir=str(args.out_json.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(existing, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.replace(tmp, args.out_json)
        except OSError:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        sys.stderr.write(
            f"[wiki-dedup] dedup_proposals written to {args.out_json} "
            f"({len(result.proposals)} proposals)\n"
        )
    else:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    return 0


# -- Inline self-tests -------------------------------------------------------


def _self_test() -> int:
    failures: list[str] = []

    # identical slugs → high Jaccard.
    score = jaccard_similarity("apple-fruit-guide", "apple-fruit-overview")
    if score < JACCARD_TITLE_THRESHOLD:
        failures.append(f"T1 FAIL: jaccard {score:.3f} < threshold {JACCARD_TITLE_THRESHOLD}")
    else:
        print(f"T1 PASS: jaccard {score:.3f} ≥ {JACCARD_TITLE_THRESHOLD}")

    # completely different slugs → low Jaccard.
    score2 = jaccard_similarity("zustand-ssr-hydration-nextjs", "python-package-managers-2026")
    if score2 >= JACCARD_TITLE_THRESHOLD:
        failures.append(f"T2 FAIL: expected low jaccard, got {score2:.3f}")
    else:
        print(f"T2 PASS: low jaccard {score2:.3f} < {JACCARD_TITLE_THRESHOLD}")

    # high sentence overlap. Sentences MUST exceed the 20-char _extract filter
    # AND genuinely overlap (sentences under 20 chars get filtered out, which
    # would mask real overlap and fail this check).
    text_a = (
        "The apple tree is a deciduous fruit-bearing plant. "
        "Apples are cultivated worldwide in temperate climates. "
        "They come in red, green, and yellow varieties."
    )
    text_b = (
        "The apple tree is a deciduous fruit-bearing plant. "
        "Apples are cultivated worldwide in temperate climates. "
        "Cider is one common product made from them."
    )
    so = sentence_overlap(text_a, text_b)
    if so < SENTENCE_OVERLAP_THRESHOLD:
        failures.append(f"T3 FAIL: sentence_overlap {so:.3f} < {SENTENCE_OVERLAP_THRESHOLD}")
    else:
        print(f"T3 PASS: sentence_overlap {so:.3f} ≥ {SENTENCE_OVERLAP_THRESHOLD}")

    # zero overlap.
    so2 = sentence_overlap("Completely different content here.", text_b)
    if so2 >= SENTENCE_OVERLAP_THRESHOLD:
        failures.append(f"T4 FAIL: expected low overlap, got {so2:.3f}")
    else:
        print(f"T4 PASS: zero-ish overlap {so2:.3f}")

    # cluster_hash is deterministic + order-independent.
    h1 = _cluster_hash("note-a", "note-b")
    h2 = _cluster_hash("note-b", "note-a")
    if h1 != h2:
        failures.append(f"T5 FAIL: cluster_hash not symmetric ({h1!r} vs {h2!r})")
    else:
        print(f"T5 PASS: cluster_hash symmetric ({h1})")

    # run_dedup honors notes_dir override.
    import tempfile as _tf
    with _tf.TemporaryDirectory() as tmp:
        synth = Path(tmp) / "synth-notes"
        synth.mkdir()
        (synth / "alpha-fruit-guide.md").write_text(
            "---\ntitle: Alpha Fruit Guide\n---\nApples are red. Apples are sweet.\n",
            encoding="utf-8",
        )
        (synth / "alpha-fruit-overview.md").write_text(
            "---\ntitle: Alpha Fruit Overview\n---\nApples are red. Apples are tasty.\n",
            encoding="utf-8",
        )
        # wiki_root points to a nonexistent path; notes_dir override MUST win.
        bogus_root = Path(tmp) / "nonexistent-wiki-root"
        r = run_dedup(wiki_root=bogus_root, notes_dir=synth, skip_llm=True)
        if r.scanned_notes != 2:
            failures.append(
                f"T6 FAIL: expected 2 scanned notes from synth dir, got {r.scanned_notes}"
            )
        else:
            print(f"T6 PASS: run_dedup honored --notes-dir (scanned={r.scanned_notes})")

    # version digit tokens are preserved → opus-4-7 vs opus-4-8 are NOT
    # identical token sets → jaccard < 1.0 (else 1.0 would trigger an LLM skip).
    j_ver = jaccard_similarity(
        "anthropic-claude-opus-4-7-prompting-best-practices",
        "anthropic-claude-opus-4-8-prompting-best-practices",
    )
    if j_ver >= 1.0:
        failures.append(f"T7 FAIL: version slugs still jaccard 1.0 ({j_ver:.4f})")
    else:
        print(f"T7 PASS: version slugs jaccard {j_ver:.4f} < 1.0 (digit tokens kept)")

    # slug_diff_is_version_only detects pure-version delta vs genuine.
    if not slug_diff_is_version_only("opus-4-7-guide", "opus-4-8-guide"):
        failures.append("T8 FAIL: version-only pair not detected as version-only")
    elif slug_diff_is_version_only("opus-4-guide", "sonnet-4-guide"):
        failures.append("T8 FAIL: genuine-diff pair mis-flagged as version-only")
    else:
        print("T8 PASS: slug_diff_is_version_only discriminates version vs genuine")

    # version-only pair MUST NOT auto-emit a heuristic 'duplicate' proposal
    # (skip_llm path → LLM unavailable → zero proposals).
    with _tf.TemporaryDirectory() as tmp9:
        synth9 = Path(tmp9) / "ver-notes"
        synth9.mkdir()
        body = "Prompting best practices for the model. Use clear instructions and examples.\n"
        (synth9 / "anthropic-claude-opus-4-7-prompting-best-practices.md").write_text(
            "---\ntitle: Opus 4.7 Prompting\n---\n" + body, encoding="utf-8",
        )
        (synth9 / "anthropic-claude-opus-4-8-prompting-best-practices.md").write_text(
            "---\ntitle: Opus 4.8 Prompting\n---\n" + body, encoding="utf-8",
        )
        r9 = run_dedup(
            wiki_root=Path(tmp9) / "nope", notes_dir=synth9,
            skip_llm=True, verified_hashes_path=None,
        )
        auto_dups = [p for p in r9.proposals if p.llm_verdict == "duplicate"]
        if auto_dups:
            failures.append(
                f"T9 FAIL: version-only pair auto-proposed for merge: {auto_dups[0].source_slugs}"
            )
        else:
            print("T9 PASS: version-only pair NOT auto-proposed (LLM gate enforced)")

    # cross-cycle verified-hash persistence drains the sub-0.90 tail.
    # Stub the LLM to a deterministic 'not-duplicate' so no real CLI runs; with
    # max_llm_calls=1 and 2 sub-0.90 pairs, cycle 1 verifies pair-1 (not_verified
    # =1), cycle 2 skips the persisted pair-1 and verifies pair-2 (not_verified=0).
    import wiki_dedup as _self_mod
    orig_haiku = _self_mod._call_haiku_dedup
    try:
        _self_mod._call_haiku_dedup = lambda *a, **k: ("not-duplicate", "stub", "either")  # type: ignore[assignment]
        with _tf.TemporaryDirectory() as tmp10:
            synth10 = Path(tmp10) / "tail-notes"
            synth10.mkdir()
            # 3 notes sharing one slug token → 3 sub-0.90 pairs (jaccard 1/3≈0.33);
            # force the LLM path. Bodies differ so sentence overlap stays low.
            for i, extra in enumerate(["alpha unique line one here please", "beta unique line two here please", "gamma unique line three here please"]):
                (synth10 / f"shared-concept-{['xx','yy','zz'][i]}.md").write_text(
                    f"---\ntitle: Note {i}\n---\n{extra}. {extra} again differently.\n",
                    encoding="utf-8",
                )
            state10 = Path(tmp10) / "verified.json"
            r10a = run_dedup(
                wiki_root=Path(tmp10) / "nope", notes_dir=synth10,
                skip_llm=False, max_llm_calls=1, verified_hashes_path=state10,
            )
            r10b = run_dedup(
                wiki_root=Path(tmp10) / "nope", notes_dir=synth10,
                skip_llm=False, max_llm_calls=1, verified_hashes_path=state10,
            )
            # not_verified MUST strictly decrease cycle-over-cycle (tail drains).
            if not (r10a.not_verified > r10b.not_verified):
                failures.append(
                    f"T10 FAIL: not_verified did not drain ({r10a.not_verified} → {r10b.not_verified})"
                )
            elif not state10.exists():
                failures.append("T10 FAIL: verified-hash state file not persisted")
            else:
                print(f"T10 PASS: tail drains across cycles ({r10a.not_verified} → {r10b.not_verified})")
    finally:
        _self_mod._call_haiku_dedup = orig_haiku  # type: ignore[assignment]

    # dedup_result_to_dict surfaces the stage budget from the SoT.
    d11 = dedup_result_to_dict(DedupResult(scanned_notes=0, candidate_clusters=0, llm_calls_used=0))
    cg = d11.get("cost_guard", {})
    if cg.get("dedup_max_budget_usd_per_call") != HAIKU_MAX_BUDGET_USD:
        failures.append(
            f"T11 FAIL: cost_guard budget {cg.get('dedup_max_budget_usd_per_call')!r} != SoT {HAIKU_MAX_BUDGET_USD!r}"
        )
    else:
        print(f"T11 PASS: cost_guard surfaces dedup budget {HAIKU_MAX_BUDGET_USD} (I12)")

    if failures:
        for f in failures:
            print(f, file=sys.stderr)
        return 1
    print("\nAll 11 wiki_dedup self-tests PASSED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
