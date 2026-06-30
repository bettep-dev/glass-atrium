"""Dead wikilink detection + safe auto-fix + category mismatch report.

Responsibilities:
    1. Scan all wiki/notes/*.md for [[wikilinks]] and relative markdown links.
    2. For each link:
         - Resolve target; if exists → OK.
         - If missing: fuzzy-search all note slugs for a renamed match.
           * EXACTLY ONE match with similarity ≥ 0.85 → auto-fix the link.
           * 0 matches or 2+ matches → dry-run (report only, no write).
    3. Parse note frontmatter `category` field; compare to topic-map.md
       categories (if present). Mismatches → dry-run report.

Safety:
    - Auto-fixes write ONLY to wiki/notes/*.md.
    - NEVER touch wiki/raw/.
    - Auto-fix gate: fuzzy similarity ≥ 0.85 AND exactly one candidate.

No third-party dependencies — stdlib only (re, json, pathlib, difflib).
Python 3.12+.
"""

from __future__ import annotations

import json
import os
import re
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
DEFAULT_TOPIC_MAP = DEFAULT_WIKI_ROOT / "index" / "topic-map.md"

# Auto-fix gate: single fuzzy match must score ≥ this threshold.
AUTO_FIX_THRESHOLD = 0.85

# -- Data models -------------------------------------------------------------

FixStatus = Literal["auto-fixed", "dry-run-ambiguous", "dry-run-no-match"]


@dataclass(frozen=True)
class DeadlinkRecord:
    """One broken wikilink found in a note."""
    source_slug: str           # note containing the broken link
    broken_link: str           # the raw [[target]] or [text](path.md) text
    link_target: str           # extracted target slug
    fix_status: FixStatus
    resolved_to: str           # slug it was fixed to (empty if dry-run)
    candidates: list[str]      # fuzzy candidates (for dry-run ambiguous)
    similarity: float          # highest fuzzy match score found


@dataclass(frozen=True)
class CategoryMismatch:
    """Note whose frontmatter category doesn't match topic-map definition."""
    source_slug: str
    declared_category: str
    expected_categories: list[str]   # from topic-map.md (may be empty if map absent)


@dataclass
class DeadlinksResult:
    """Deadlinks stage outcome appended to the daily JSON report."""
    scanned_notes: int
    total_links_checked: int
    auto_fixed: list[DeadlinkRecord] = field(default_factory=list)
    dry_run: list[DeadlinkRecord] = field(default_factory=list)
    category_mismatches: list[CategoryMismatch] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# -- Note inventory ----------------------------------------------------------


def collect_note_slugs(notes_dir: Path) -> set[str]:
    """Return the set of existing note slugs (stems of *.md files)."""
    slugs: set[str] = set()
    if not notes_dir.is_dir():
        return slugs
    for entry in notes_dir.iterdir():
        if entry.is_file() and entry.name.endswith(".md") and not entry.name.startswith("."):
            if entry.name != ".gitkeep":
                slugs.add(entry.stem)
    return slugs


# -- Wikilink extraction -----------------------------------------------------

# [[slug]] | [[slug#heading]] | [[slug|alias]] | [[slug#heading|alias]]
# Group 1 (slug): everything up to the first '|', '#', or ']' — captured greedily
# but bounded by negated character class so it cannot leak past the closing ']]'.
# Optional '#heading' and '|alias' segments are consumed but discarded.
_RE_WIKILINK = re.compile(
    r"\[\["
    r"([^\]|#\n]+)"            # group 1: slug body
    r"(?:#[^\]|\n]*)?"          # optional #heading (no group)
    r"(?:\|[^\]\n]*)?"          # optional |alias (no group)
    r"\]\]"
)

# [text](relative-path.md) — catch relative markdown links (no http/https).
_RE_MD_LINK = re.compile(r"\[([^\]]*)\]\((?!https?://)([^)\n]+\.md)(?:#[^)]*)?\)")


def _strip_code_spans(text: str) -> str:
    """Remove fenced (```...```) and inline (`...`) code spans.

    bash test syntax like ``[[ -v var ]]`` / ``[[ -n "${x}" ]]`` inside code
    blocks would otherwise be mis-parsed by _RE_WIKILINK as broken wikilinks
    (re-reported every cycle). Mirrors wiki_dedup._extract_sentences fence-strip
    so the two scanners share one code-span convention.
    """
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)
    return text


def extract_links(text: str) -> list[tuple[str, str]]:
    """Return list of (raw_link_text, target_slug).

    raw_link_text: the full [[...]] or [...](...) match for replacement.
    target_slug: the slug portion (filename without .md extension).

    Code spans are stripped first so wikilink/md-link regexes never match
    inside fenced or inline code (bash [[ ]] test syntax is not a wikilink).
    """
    text = _strip_code_spans(text)
    links: list[tuple[str, str]] = []

    for m in _RE_WIKILINK.finditer(text):
        raw = m.group(0)
        target = m.group(1).strip()
        # Strip path separators (vault-relative paths like notes/foo → foo).
        slug = Path(target).stem
        links.append((raw, slug))

    for m in _RE_MD_LINK.finditer(text):
        raw = m.group(0)
        path_str = m.group(2).strip()
        slug = Path(path_str).stem
        links.append((raw, slug))

    return links


# -- Fuzzy slug matching (SequenceMatcher — stdlib difflib) ------------------


def _slug_similarity(a: str, b: str) -> float:
    """Normalized edit similarity between two slug strings."""
    from difflib import SequenceMatcher
    return SequenceMatcher(None, a, b).ratio()


def find_fuzzy_candidates(
    broken_slug: str,
    all_slugs: set[str],
    *,
    threshold: float = AUTO_FIX_THRESHOLD,
) -> list[tuple[str, float]]:
    """Return (slug, similarity) pairs where similarity >= threshold, sorted desc."""
    candidates: list[tuple[str, float]] = []
    for slug in all_slugs:
        sim = _slug_similarity(broken_slug, slug)
        if sim >= threshold:
            candidates.append((slug, sim))
    candidates.sort(key=lambda t: t[1], reverse=True)
    return candidates


# -- Auto-fix (write-safe) ---------------------------------------------------


def _apply_link_fix(
    note_path: Path,
    old_link: str,
    new_slug: str,
    *,
    dry_run: bool = False,
) -> bool:
    """Replace old_link with corrected wikilink in note_path.

    Returns True on success, False on any error.
    Writes atomically (mktemp + os.replace).
    """
    if dry_run:
        return True

    try:
        original = note_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False

    # Build replacement: always emit [[new_slug]] wikilink format.
    # If old_link had a display text (|...) preserve it.
    display_m = re.search(r"\[\[[^\]|]+\|([^\]]+)\]\]", old_link)
    if display_m:
        new_link = f"[[{new_slug}|{display_m.group(1)}]]"
    else:
        new_link = f"[[{new_slug}]]"

    updated = original.replace(old_link, new_link, 1)
    if updated == original:
        # Nothing changed (link not found verbatim — possibly already fixed).
        return True

    try:
        fd, tmp = tempfile.mkstemp(
            prefix=note_path.name + ".",
            suffix=".tmp",
            dir=str(note_path.parent),
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(updated)
        os.replace(tmp, note_path)
    except OSError:
        try:
            os.unlink(tmp)
        except (FileNotFoundError, NameError):
            pass
        return False

    return True


# -- Frontmatter category extraction -----------------------------------------


def _parse_category(text: str) -> str | None:
    """Extract 'category' field from YAML frontmatter."""
    fm_match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not fm_match:
        return None
    fm_block = fm_match.group(1)
    cat_m = re.search(r"^category:\s*(.+)$", fm_block, re.MULTILINE)
    if cat_m:
        return cat_m.group(1).strip().strip('"\'')
    return None


def _parse_topic_map_categories(topic_map_path: Path) -> set[str]:
    """Extract category names from topic-map.md (H2 headings treated as categories)."""
    if not topic_map_path.exists():
        return set()
    try:
        text = topic_map_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    categories: set[str] = set()
    for m in re.finditer(r"^##\s+(.+)$", text, re.MULTILINE):
        cat = m.group(1).strip()
        if cat:
            categories.add(cat)
    return categories


# -- Main --------------------------------------------------------------------


def run_deadlinks(
    *,
    wiki_root: Path = DEFAULT_WIKI_ROOT,
    dry_run_all: bool = False,
) -> DeadlinksResult:
    """Full pass — scan notes, detect broken links, auto-fix or report."""
    notes_dir = wiki_root / "notes"
    topic_map_path = wiki_root / "index" / "topic-map.md"

    all_slugs = collect_note_slugs(notes_dir)
    known_categories = _parse_topic_map_categories(topic_map_path)

    result = DeadlinksResult(
        scanned_notes=len(all_slugs),
        total_links_checked=0,
    )

    if not notes_dir.is_dir():
        return result

    for entry in sorted(notes_dir.iterdir()):
        if not entry.is_file():
            continue
        if not entry.name.endswith(".md"):
            continue
        if entry.name.startswith(".") or entry.name == ".gitkeep":
            continue

        source_slug = entry.stem
        try:
            text = entry.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            result.errors.append(f"read-error: {entry.name}: {exc}")
            continue

        links = extract_links(text)
        result.total_links_checked += len(links)

        for raw_link, target_slug in links:
            # Self-links are valid.
            if target_slug == source_slug:
                continue
            # Link target exists → healthy.
            if target_slug in all_slugs:
                continue

            # Dead link found. Try fuzzy match.
            candidates = find_fuzzy_candidates(target_slug, all_slugs)

            if len(candidates) == 1 and not dry_run_all:
                # Unambiguous rename → auto-fix.
                resolved_to, sim = candidates[0]
                ok = _apply_link_fix(entry, raw_link, resolved_to)
                status: FixStatus = "auto-fixed" if ok else "dry-run-no-match"
                if ok:
                    result.auto_fixed.append(DeadlinkRecord(
                        source_slug=source_slug,
                        broken_link=raw_link,
                        link_target=target_slug,
                        fix_status="auto-fixed",
                        resolved_to=resolved_to,
                        candidates=[resolved_to],
                        similarity=round(sim, 4),
                    ))
                else:
                    result.errors.append(
                        f"auto-fix write failed: {source_slug} → {raw_link}"
                    )
                    result.dry_run.append(DeadlinkRecord(
                        source_slug=source_slug,
                        broken_link=raw_link,
                        link_target=target_slug,
                        fix_status="dry-run-no-match",
                        resolved_to="",
                        candidates=[resolved_to],
                        similarity=round(sim, 4),
                    ))
            elif len(candidates) > 1:
                # Ambiguous — manual review.
                result.dry_run.append(DeadlinkRecord(
                    source_slug=source_slug,
                    broken_link=raw_link,
                    link_target=target_slug,
                    fix_status="dry-run-ambiguous",
                    resolved_to="",
                    candidates=[c for c, _ in candidates],
                    similarity=round(candidates[0][1], 4),
                ))
            else:
                # No fuzzy match found.
                result.dry_run.append(DeadlinkRecord(
                    source_slug=source_slug,
                    broken_link=raw_link,
                    link_target=target_slug,
                    fix_status="dry-run-no-match",
                    resolved_to="",
                    candidates=[],
                    similarity=0.0,
                ))

        # Category check (only if topic-map.md has categories defined).
        if known_categories:
            cat = _parse_category(text)
            if cat and cat not in known_categories:
                result.category_mismatches.append(CategoryMismatch(
                    source_slug=source_slug,
                    declared_category=cat,
                    expected_categories=sorted(known_categories),
                ))

    return result


# -- Serialization -----------------------------------------------------------


def deadlinks_result_to_dict(result: DeadlinksResult) -> dict:
    return {
        "scanned_notes": result.scanned_notes,
        "total_links_checked": result.total_links_checked,
        "deadlink_fixes": [asdict(r) for r in result.auto_fixed],
        "deadlink_dryrun": [asdict(r) for r in result.dry_run],
        "category_mismatches": [asdict(m) for m in result.category_mismatches],
        "errors": result.errors,
    }


# -- CLI (used by wiki-deadlinks.sh) -----------------------------------------


def _main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="wiki_deadlinks")
    parser.add_argument("--wiki-root", type=Path, default=DEFAULT_WIKI_ROOT)
    parser.add_argument("--notes-dir", type=Path, default=None,
                        help="Override wiki/notes/ path (for testing)")
    parser.add_argument("--dry-run-all", action="store_true",
                        help="Do not auto-fix any links — report only")
    parser.add_argument("--out-json", type=Path, default=None,
                        help="Merge deadlink results into this JSON file")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    wiki_root = args.wiki_root

    # If --notes-dir given, patch wiki_root to point there (test fixture support).
    if args.notes_dir:
        # Override: treat notes_dir as wiki_root/notes by creating a temp
        # wiki_root that has a 'notes' symlink.  Simpler: just run scan directly.
        # Since run_deadlinks uses wiki_root / "notes", temporarily monkeypatch.
        import types
        wiki_root = args.notes_dir.parent

    result = run_deadlinks(
        wiki_root=wiki_root,
        dry_run_all=args.dry_run_all,
    )

    payload = deadlinks_result_to_dict(result)

    if args.out_json:
        existing: dict = {}
        if args.out_json.exists():
            try:
                existing = json.loads(args.out_json.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                existing = {}
        existing["deadlink_fixes"] = payload["deadlink_fixes"]
        existing["deadlink_dryrun"] = payload["deadlink_dryrun"]
        existing["category_mismatches"] = payload["category_mismatches"]
        existing.setdefault("deadlink_errors", []).extend(payload["errors"])

        import sys
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
            f"[wiki-deadlinks] results written to {args.out_json}: "
            f"{len(result.auto_fixed)} auto-fixed, "
            f"{len(result.dry_run)} dry-run, "
            f"{len(result.category_mismatches)} category mismatches\n"
        )
    else:
        import sys
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    return 0


# -- Inline self-tests -------------------------------------------------------


def _self_test() -> int:
    import sys

    failures: list[str] = []

    # wikilink extraction.
    text = "See [[some-note]] for details. Also [[old-slug|display]] and [[note#heading]]."
    links = extract_links(text)
    slugs_found = [s for _, s in links]
    expected_slugs = {"some-note", "old-slug", "note"}
    if not expected_slugs.issubset(set(slugs_found)):
        failures.append(f"T1 FAIL: expected {expected_slugs}, got {slugs_found}")
    else:
        print(f"T1 PASS: wikilink extraction {slugs_found}")

    # regression guard for slug erosion by the alias group.
    bug2_cases: list[tuple[str, str]] = [
        ("[[abc]]", "abc"),
        ("[[abc-def]]", "abc-def"),
        ("[[abc|alias]]", "abc"),
        ("[[abc-def|some alias]]", "abc-def"),
        ("[[react-component-optimization-pattern]]",
         "react-component-optimization-pattern"),
    ]
    for raw, expected_slug in bug2_cases:
        extracted = extract_links(raw)
        if not extracted or extracted[0][1] != expected_slug:
            failures.append(
                f"T1b FAIL: {raw!r} → expected slug={expected_slug!r}, "
                f"got {extracted!r}"
            )
        else:
            print(f"T1b PASS: {raw} → slug={extracted[0][1]!r}")

    # markdown link extraction.
    text2 = "See [text](other-note.md) for more."
    links2 = extract_links(text2)
    if not any(s == "other-note" for _, s in links2):
        failures.append(f"T2 FAIL: markdown link not extracted: {links2}")
    else:
        print(f"T2 PASS: markdown link extraction {[s for _, s in links2]}")

    # fuzzy match hit.
    all_slugs = {"new-slug", "some-unrelated-note", "another-note"}
    # old-slug → new-slug: similarity should be above threshold.
    cands = find_fuzzy_candidates("old-slug", all_slugs, threshold=0.5)
    # At 0.5 threshold, new-slug (edit distance similar) might or might not match.
    # Use a known close pair.
    all_slugs2 = {"claude-code-cli-reference-flags", "langchain-js-perplexity-docs"}
    cands2 = find_fuzzy_candidates("claude-code-cli-reference-flag", all_slugs2, threshold=0.85)
    if not cands2:
        failures.append(f"T3 FAIL: expected fuzzy match for near-identical slug, got none")
    else:
        print(f"T3 PASS: fuzzy match found: {cands2[0]}")

    # fuzzy match miss (completely different slug).
    cands3 = find_fuzzy_candidates("totally-different-concept-xyz", all_slugs2, threshold=0.85)
    if cands3:
        failures.append(f"T4 FAIL: expected no match, got {cands3}")
    else:
        print(f"T4 PASS: no fuzzy match for dissimilar slug")

    # category parsing.
    text5 = "---\ntitle: Test\ncategory: agent-engineering\ntags: [a]\n---\n# Body"
    cat = _parse_category(text5)
    if cat != "agent-engineering":
        failures.append(f"T5 FAIL: expected 'agent-engineering', got {cat!r}")
    else:
        print(f"T5 PASS: category parsed: {cat}")

    # bash [[ ]] test syntax inside fenced/inline code is NOT extracted
    # as a wikilink.
    text6 = (
        "Real link: [[some-real-note]].\n\n"
        "```bash\n"
        'if [[ -v var ]]; then echo hi; fi\n'
        'if [[ -n "${prev_nullglob}" ]]; then :; fi\n'
        "```\n\n"
        "Inline `[[ -z $x ]]` example too.\n"
    )
    links6 = [s for _, s in extract_links(text6)]
    leaked = [s for s in links6 if s in {"-v var", "-n", "-z $x", "-v", "var"}]
    if leaked:
        failures.append(f"T6 FAIL: code-span bash test leaked as wikilinks: {leaked}")
    elif "some-real-note" not in links6:
        failures.append(f"T6 FAIL: real wikilink dropped by code-span strip: {links6}")
    else:
        print(f"T6 PASS: code spans stripped, real link kept ({links6})")

    if failures:
        for f in failures:
            print(f, file=sys.stderr)
        return 1
    print("\nAll 6 wiki_deadlinks self-tests PASSED.")
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(_main(sys.argv[1:]))
