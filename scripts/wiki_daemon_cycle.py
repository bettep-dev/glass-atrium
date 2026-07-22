"""Wiki daemon — raw-file compilation proposal + classification core logic.

Responsibilities:
    Proposal: For each unprocessed raw file under ``wiki/raw/``, ask Haiku to
        draft a compilation proposal (proposed slug + initial markdown body
        shape + source-credibility judgment). Then call ``wiki-sync.sh
        --force-index`` once per cycle to refresh ``index/master-index.md``.
    Classify each proposal into one of:
            - 'notes-auto'    — clean structure (blog/README/talk transcript
                                with author + date), can be auto-applied later
                                by the dedup/deadlinks stages to wiki/notes/<slug>.md
            - 'notes-dryrun'  — Haiku flagged uncertainty (low source
                                credibility, format ambiguity, possible dup)
            - 'reject'        — out-of-scope (raw outside wiki/raw/, slug
                                collision with different content, or proposal
                                empty)

This module ONLY generates and classifies. **Actual writes to wiki/notes/ are
forbidden** — those happen in the dedup + deadlinks modules. The daemon-reports
JSON is the handoff contract for those later modules.

The bash entry point (wiki-daemon-cycle.sh) wires CLI args, then delegates
everything below to the ``run_cycle()`` function.

No third-party dependencies — stdlib only (subprocess, json, pathlib,
hashlib, dataclasses, typing). Python 3.12+ idioms (type Alias, PEP 695).
"""

from __future__ import annotations

import argparse
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

# -- Constants --------------------------------------------------------------

HOME = Path(os.environ.get("HOME", str(Path.home())))
# WIKI_ROOT env is the single source of truth for the wiki data root. Default =
# the glass-atrium store. This is the LIVE default — the bash wrappers do not pass
# --wiki-root by default, so the env read MUST live on this constant.
DEFAULT_WIKI_ROOT = Path(os.environ.get("WIKI_ROOT") or str(HOME / ".glass-atrium" / "wiki"))
# DEFAULT_REPORTS_DIR derives from the ga_paths seam — defined below, AFTER the
# hooks-dir sys.path insert that makes ga_paths importable.
DEFAULT_SYNC_SCRIPT = HOME / ".claude" / "scripts" / "wiki-sync.sh"

# CLI binary — overridable for tests (matches AutoAgent convention)
CLAUDE_BIN = os.environ.get("WIKI_DAEMON_CLAUDE_BIN", "claude")

# Raw-processing cap (per cycle) — 0 = unlimited (process all unprocessed raws).
# Overridable via WIKI_DAEMON_RAW_LIMIT env (same convention as WIKI_DAEMON_CLAUDE_BIN).
DEFAULT_RAW_LIMIT = int(os.environ.get("WIKI_DAEMON_RAW_LIMIT", "0") or "0")
HAIKU_TIMEOUT_SEC = 90
# Cost guard — per-CALL `--max-budget-usd` ceiling (not a daily token estimate).
# <0.10 → `claude -p --max-budget-usd` exits 1 immediately ("Exceeded USD budget").
# Anthropic minimum call cost ~$0.02-0.10 — 0.50 is the verified safe ceiling (measured ~$0.02-0.05/call).
# Budget ceiling + model id are read from the daemon-config.json SoT (shared loader
# hooks/daemon_config.py — the single fallback-policy SoT, degrades to verified literals if the file is
# absent/corrupt). wiki has no pre-verify budget, so it uses only haiku_max_budget_usd + haiku_model.
# hooks/ is not on this module's sys.path — self-locate it from THIS file (store:
# ~/.glass-atrium/{scripts,hooks} siblings; CI checkout: repo/{scripts,hooks}).
# ~/.claude/hooks is no longer farmed, so a HOME-anchored insert breaks fresh installs.
_HOOKS_DIR = Path(__file__).resolve().parent.parent / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
from daemon_config import (  # noqa: E402 — sys.path insert immediately above
    HAIKU_MAX_BUDGET_USD,
    HAIKU_MODEL,
)
import ga_paths  # noqa: E402 — hooks dir pinned by the insert above

# Cycle-report output root via the shared ga_paths seam (.glass-atrium default,
# GA_DATA_ROOT-overridable) — daemon-reports moved in the .claude→.glass-atrium
# data migration; matches the autoagent daemon_cycle.py DEFAULT_REPORTS_DIR.
DEFAULT_REPORTS_DIR = ga_paths.get_data_root() / "daemon-reports"

# Truncate raw file content fed to Haiku (keep prompt small + cost bounded).
RAW_EXCERPT_CHARS = 6000

# wiki-sync.sh timeout — empirically <5s for typical 50-note vaults.
SYNC_TIMEOUT_SEC = 60

# IANA tz first components (+ legacy slash-bearing links like US/Pacific) —
# mirrors autoagent daemon_cycle.py._IANA_TZ_REGIONS: any user timezone matches
# the reset-notice pattern, generic "(word/word)" error text does not
# (quota false-positive guard).
_IANA_TZ_REGIONS = (
    r"Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe"
    r"|Indian|Pacific|Etc|US|Canada|Mexico|Brazil|Chile"
)

# Quota-limit detection patterns. Mirrors autoagent
# daemon_cycle.py._HAIKU_QUOTA_PATTERNS. When claude CLI exits non-zero,
# inspect (stderr + stdout) for budget / rate / usage ceiling signals.
# Match → haiku_status='skipped:quota-limit' (distinct from the
# 'error:haiku-exit-N' fallback) so monitor #improvement dashboard can
# flag exhausted budget vs. generic CLI failure.
_HAIKU_QUOTA_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"Limit\s+reached", re.IGNORECASE),
    re.compile(r"Usage\s+.{0,3}\s*Limit", re.IGNORECASE),
    # NOTE: "Exceeded USD budget" is excluded here — a local --max-budget-usd
    # failure is a self-inflicted config error, not an external quota/rate cap,
    # so it routes to _detect_budget_too_low() (a quota false-positive masked it).
    re.compile(r"quota[\s_-]*exceeded", re.IGNORECASE),
    re.compile(r"rate[\s_-]*limit", re.IGNORECASE),
    # "You're out of extra usage" / "/rate-limit-options" / "(<IANA Region/City>)" tz
    re.compile(r"out\s+of\s+extra\s+usage", re.IGNORECASE),
    re.compile(r"/rate-limit-options", re.IGNORECASE),
    re.compile(rf"\((?:{_IANA_TZ_REGIONS})/[A-Za-z0-9_+\-/]+\)", re.IGNORECASE),
)


def _detect_quota_limit(stderr: str, stdout: str) -> bool:
    """Return True iff the CLI output exhibits a quota-limit signature.

    Searches the concatenated (stderr + stdout) — quota messages appear in
    either stream depending on CLI version. Compiled patterns module-level
    avoid per-call recompile cost.
    """
    combined = (stderr or "") + "\n" + (stdout or "")
    return any(pat.search(combined) for pat in _HAIKU_QUOTA_PATTERNS)


# Local --max-budget-usd ceiling signal — a self-inflicted config failure,
# distinct from external quota. Split out of the quota set (the false-positive
# masked a budget=0.005 100x-too-low bug).
_BUDGET_TOO_LOW_PATTERN: re.Pattern[str] = re.compile(
    r"Exceeded\s+USD\s+budget", re.IGNORECASE
)


def _detect_budget_too_low(stderr: str, stdout: str) -> bool:
    """Return True iff the CLI tripped the LOCAL --max-budget-usd ceiling.

    Distinct from ``_detect_quota_limit`` — this is a self-inflicted local
    budget-config failure, NOT an external Anthropic quota/rate cap.
    """
    combined = (stderr or "") + "\n" + (stdout or "")
    return bool(_BUDGET_TOO_LOW_PATTERN.search(combined))


# Type aliases (PEP 695 — Python 3.12+).
type Classification = Literal["notes-auto", "notes-dryrun", "reject"]
type SyncMode = Literal["real", "dry-run", "skipped"]


# -- Data models ------------------------------------------------------------


@dataclass(frozen=True)
class RawFile:
    """One raw markdown file under ``wiki/raw/`` awaiting compilation.

    ``rel_path`` is relative to ``wiki_root`` (e.g. ``raw/foo-bar.md``) and is
    what gets recorded in JSON for portability across machines.
    """

    abs_path: Path
    rel_path: str
    slug: str            # basename without ``.md`` — proposed default slug
    size_bytes: int
    mtime: int


@dataclass(frozen=True)
class CompilationProposal:
    """Haiku output describing a proposed compilation of one raw → one note.

    Fields populated even on Haiku failure (with empty content + ``haiku_status``
    capturing the reason) so downstream classification has a consistent shape.
    """

    raw_rel_path: str
    proposed_slug: str          # final slug after Haiku judgment (may differ from default)
    proposed_target: str        # relative path under wiki/, e.g. ``notes/foo.md``
    proposed_content: str       # initial markdown body (truncated)
    proposed_content_hash: str  # sha256 of proposed_content (collision detection)
    source_credibility: str     # 'high' | 'medium' | 'low' | 'unknown'
    format_clarity: str         # 'clean' | 'ambiguous' | 'malformed'
    duplicate_hint: str         # 'none' | 'possible-of:<slug>' | 'unknown'
    haiku_rationale: str        # 1-2 sentences (truncated)
    haiku_status: str           # 'ok' | 'skipped:<reason>' | 'error:<short>'
    raw_response: str           # full Haiku stdout (truncated for storage)


@dataclass
class CompilationResult:
    """One row in the cycle report — proposal + classification + reasoning."""

    raw_path: str               # rel_path
    proposed_slug: str
    proposed_target: str
    proposed_content_hash: str
    classification: Classification
    rationale: str              # WHY this classification (combines Haiku + classify logic)
    source_credibility: str
    format_clarity: str
    duplicate_hint: str
    haiku_status: str
    error: str = ""


@dataclass
class SyncResult:
    """Outcome of the once-per-cycle ``wiki-sync.sh --force-index`` invocation."""

    mode: SyncMode              # 'real' | 'dry-run' | 'skipped'
    exit_code: int              # -1 if not executed
    duration_sec: float
    stderr_tail: str            # last 400 chars (master-index regen log)


@dataclass
class CycleReport:
    """Top-level JSON shape written to daemon-reports/wiki-YYYY-MM-DD.json."""

    cycle_date: str             # YYYY-MM-DD (UTC)
    generated_at: str           # ISO8601 UTC ms
    raw_processed: int
    cost_guard: dict[str, str | int]
    # True hybrid unprocessed-raw count from detect_unprocessed_raw — the
    # authoritative backlog the monitor consumes (the FE reads this scalar; it
    # must not recompute rawCount − summaryCount).
    true_backlog: int = 0
    compilations: list[CompilationResult] = field(default_factory=list)
    force_index_result: SyncResult | None = None


# -- Step 1: detect unprocessed raw files -----------------------------------

# WHY this matches wiki-daily-compile.sh's HYBRID "unprocessed" definition:
#   A raw is unprocessed only when BOTH (a) no ``wiki/notes/<basename>.md``
#   exists AND (b) the raw's ``source_url`` does not already appear in any
#   existing note. wiki-curator normalizes the slug (strips date/hash), so a
#   raw like ``raw/upstage-pricing-api-2026-05-21.md`` compiles to a note
#   like ``notes/upstage-solar-api-overview-2026.md`` — the basenames differ
#   but the frontmatter ``source_url`` is shared. A basename-only check
#   would miss that mapping and re-propose the already-compiled raw forever
#   (the "phantom backlog"). This MUST mirror wiki-daily-compile.sh's
#   _extract_source_url + grep -qxF membership EXACTLY so the two detectors
#   agree on every raw.

# Frontmatter source_url extraction — mirrors wiki-daily-compile.sh's awk:
#   read only the FIRST ``source_url:`` line INSIDE the first ``---`` block.
# The opening ``---`` is the first line; a second ``---`` closes the block.
# ``[ \t]`` (ASCII space/tab only, not ``\s``) keeps the delimiter class
# locale-independent — ``\s`` would match nbsp/Unicode whitespace, diverging
# from the bash awk ``/^---[ \t]*$/`` under a UTF-8 locale.
_RE_FRONTMATTER_DELIM = re.compile(r"^---[ \t]*$")
_RE_SOURCE_URL = re.compile(r"^source_url:[ \t]*(.*?)[ \t]*$")
# source_raw is the collision-immune identity source_url cannot be: a raw
# basename is unique (1 URL = 1 file, immutable), so it survives a slug-rename
# that drops both the note's basename match and its source_url. Same delimiter
# class and trim discipline as _RE_SOURCE_URL — only the key differs.
_RE_SOURCE_RAW = re.compile(r"^source_raw:[ \t]*(.*?)[ \t]*$")


def _extract_source_url(file_path: Path) -> str:
    """Return the first frontmatter ``source_url`` value, or "" if absent.

    Matches the bash ``_extract_source_url`` (awk) on the canonical
    ``^---[ \\t]*$`` delimiter rule and on the ``\\r``-stripped, ASCII-trimmed
    (``[ \\t]`` only) source_url value: the value is read only while inside the
    first ``---`` … ``---`` block, and only the FIRST ``source_url:`` line within
    it is honored. The scan opens the block at the FIRST line matching the
    ``^---[ \\t]*$`` delimiter — preceding non-``---`` lines (a leading
    ``title:`` or intro paragraph) do not prevent opening it — and the next
    delimiter closes it. The function returns "" only when no such block opens
    or it holds no ``source_url:`` key; body ``source_url:`` lines after the
    closing delimiter fall outside the block and are never matched, avoiding
    HR-rule contamination.
    """
    try:
        # newline="" disables universal-newline translation so a lone \r reaches
        # the parser as a value byte, mirroring awk's \n-only record split — the
        # default translation would rewrite \r to \n and truncate the value here.
        text = file_path.read_text(encoding="utf-8", errors="replace", newline="")
    except OSError:
        return ""

    # awk (the bash SoT) splits records on \n only, so a lone \r inside a value
    # is a value byte, not a line break. Normalize CRLF→LF and split on \n so a
    # mid-value \r does not prematurely end a line (str.splitlines() would).
    in_block = False
    for line in text.replace("\r\n", "\n").split("\n"):
        if _RE_FRONTMATTER_DELIM.match(line):
            if not in_block:
                in_block = True
                continue
            # Second delimiter closes the block — stop, mirroring awk's exit.
            break
        if in_block:
            m = _RE_SOURCE_URL.match(line)
            if m:
                # Strip every \r from the value — the parity rule shared with
                # the bash awk's gsub(/\r/,""): the extracted value holds no \r,
                # so both detectors key membership on identical strings.
                # ASCII-only trim (" \t") — no-arg .strip() also removes Unicode
                # whitespace (nbsp U+00A0), but the bash awk trims [ \t] only, so
                # a value with a leading/trailing nbsp must survive to agree.
                return m.group(1).replace("\r", "").strip(" \t")
    return ""


def _extract_source_raw(file_path: Path) -> str:
    """Return the first frontmatter ``source_raw`` value, or "" if absent.

    source_raw stores the originating raw's FULL basename (``<slug>.md``), the
    only identity that stays stable across a slug-rename: a raw basename is
    unique (1 URL = 1 file, immutable), so a note keyed by it cannot be confused
    with another raw the way a shared source_url can. Byte-parity with the bash
    ``_extract_source_raw`` (awk) and with ``_extract_source_url`` here — the
    same ``^---[ \\t]*$`` delimiter rule, the same FIRST-line-only read inside
    the first ``---`` … ``---`` block, the same ``\\r`` strip and ASCII-only
    (``[ \\t]``) trim. Body ``source_raw:`` lines after the closing delimiter
    fall outside the block and are never matched, avoiding HR-rule contamination.
    """
    try:
        # newline="" disables universal-newline translation so a lone \r reaches
        # the parser as a value byte, mirroring awk's \n-only record split.
        text = file_path.read_text(encoding="utf-8", errors="replace", newline="")
    except OSError:
        return ""

    # CRLF→LF then split on \n only so a mid-value \r is a value byte, not a
    # line break — the awk SoT splits records on \n only.
    in_block = False
    for line in text.replace("\r\n", "\n").split("\n"):
        if _RE_FRONTMATTER_DELIM.match(line):
            if not in_block:
                in_block = True
                continue
            # Second delimiter closes the block — stop, mirroring awk's exit.
            break
        if in_block:
            m = _RE_SOURCE_RAW.match(line)
            if m:
                # \r strip + ASCII-only (" \t") trim — the parity rule shared
                # with the bash awk's gsub(/\r/,"") + [ \t] sub: a value with a
                # leading/trailing nbsp survives, so both detectors key
                # membership on byte-identical strings.
                return m.group(1).replace("\r", "").strip(" \t")
    return ""


def _collect_note_source_urls(notes_dir: Path) -> set[str]:
    """Build a one-time set of every ``source_url`` present across notes/*.md.

    O(notes) once per cycle — replaces the O(raws × notes) full re-grep the
    naive port would incur on the ~280-note corpus. Membership against this
    set is the daemon analogue of the bash ``grep -qxF`` whole-line test.
    """
    urls: set[str] = set()
    if not notes_dir.is_dir():
        return urls
    for entry in notes_dir.iterdir():
        if not entry.is_file() or not entry.name.endswith(".md"):
            continue
        if entry.name.startswith("."):
            continue
        url = _extract_source_url(entry)
        if url:
            urls.add(url)
    return urls


def _collect_note_source_raws(notes_dir: Path) -> set[str]:
    """Build a one-time set of every ``source_raw`` (a raw basename, ``.md``
    included) present across notes/*.md.

    This is the note-side set a raw's full basename is tested against for the
    collision-immune primary match. O(notes) once per cycle, the daemon analogue
    of the bash ``grep -qxF`` whole-line test against the collected source_raws.
    """
    raws: set[str] = set()
    if not notes_dir.is_dir():
        return raws
    for entry in notes_dir.iterdir():
        if not entry.is_file() or not entry.name.endswith(".md"):
            continue
        if entry.name.startswith("."):
            continue
        raw = _extract_source_raw(entry)
        if raw:
            raws.add(raw)
    return raws


def _iter_raw_md(raw_dir: Path):
    """Yield each ``raw/*.md`` file (non-hidden), the single SoT for the raw
    enumeration shared by the collision scan and the candidate loop.
    """
    if not raw_dir.is_dir():
        return
    for entry in raw_dir.iterdir():
        if not entry.is_file() or not entry.name.endswith(".md"):
            continue
        if entry.name.startswith("."):
            continue
        yield entry


def _collect_collision_source_urls(raw_dir: Path) -> dict[str, list[str]]:
    """Map each colliding ``source_url`` → the raw basenames sharing it.

    A collision is a source_url present on MORE THAN ONE raw. The source_url
    fast-path (a raw is processed when its url appears in a note) is UNSAFE for
    a colliding url: raw-alpha's compiled (slug-renamed) note carries the shared
    url, which would falsely mark raw-beta (same url, no note of its own) as
    processed → beta is never compiled = silent loss. Such raws fall back to
    the basename-only check instead.
    """
    url_to_raws: dict[str, list[str]] = {}
    for entry in _iter_raw_md(raw_dir):
        url = _extract_source_url(entry)
        if url:
            url_to_raws.setdefault(url, []).append(entry.name)
    return {url: raws for url, raws in url_to_raws.items() if len(raws) > 1}


def detect_unprocessed_raw(
    wiki_root: Path,
    *,
    limit: int = DEFAULT_RAW_LIMIT,
) -> list[RawFile]:
    """Return raw files that are unprocessed per the hybrid definition.

    A raw is processed when ANY of three identities matches, tried in this
    order:

    1. source_raw (PRIMARY, collision-immune): the raw's FULL basename
       (``<slug>.md``) appears as some note's ``source_raw`` value. A raw
       basename is unique, so this identity is unambiguous and needs NO
       collision guard — it is the only path that survives a slug-rename that
       drops both the note's basename match and its source_url.
    2. basename: ``notes/<slug>.md`` exists.
    3. source_url (guarded fallback for legacy notes lacking source_raw): the
       raw's non-empty ``source_url`` appears in some note's source_url set AND
       is NOT in the collision set.

    Collision-set guard (source_url path only): a source_url shared across MORE
    THAN ONE raw is unsafe — raw-alpha's compiled (slug-renamed) note carries
    the shared url, falsely marking raw-beta (same url, own note absent) as
    processed → beta never compiled = silent loss. A colliding raw therefore
    matches only by source_raw or basename, never by the shared url. source_raw
    needs no such guard because raw basenames never collide.

    Sorted by mtime descending — newest first. ``limit`` > 0 caps the count
    (a sudden raw/ dump won't blow the per-cycle Haiku budget); ``limit`` <= 0
    means UNBOUNDED — process every unprocessed raw.
    """
    raw_dir = wiki_root / "raw"
    notes_dir = wiki_root / "notes"

    if not raw_dir.is_dir():
        return []

    # One-time note indexes — built before the raw loop so each raw is a
    # set-membership test, not a fresh corpus scan (avoids O(raws × notes)).
    note_source_urls = _collect_note_source_urls(notes_dir)
    # Note-side basenames a raw's full basename is tested against — the
    # collision-immune primary identity (no collision guard: raw basenames are
    # unique).
    note_source_raws = _collect_note_source_raws(notes_dir)
    # source_urls shared across >1 raw — the source_url fast-path is disabled
    # for these (basename-only), preventing one raw's note from masking another.
    collision_source_urls = _collect_collision_source_urls(raw_dir)
    if collision_source_urls:
        for url in sorted(collision_source_urls):
            sys.stderr.write(
                "[wiki-daemon-cycle] WARN: source_url collision — "
                "%s shared by raws %s; source_url fast-path disabled for these "
                "(basename-only processed check)\n"
                % (url, ", ".join(sorted(collision_source_urls[url])))
            )

    candidates: list[RawFile] = []
    for entry in _iter_raw_md(raw_dir):
        slug = entry.stem
        # Primary, collision-immune match: a note back-references this raw by its
        # FULL basename (``<slug>.md``). Raw basenames are unique, so a match here
        # is unambiguous and survives a slug-rename + source_url drop that defeats
        # both fallbacks below. No collision guard is possible or needed.
        if f"{slug}.md" in note_source_raws:
            continue
        # Fallback: compiled note with matching basename already exists.
        if (notes_dir / f"{slug}.md").exists():
            continue
        # Guarded fallback for legacy notes lacking source_raw: source_url
        # mapped to a slug-normalized note → processed. Mirrors
        # wiki-daily-compile.sh grep -qxF membership. A colliding url is excluded
        # here — a shared url cannot prove THIS raw was compiled (the note may
        # belong to a sibling raw), so it defers to the checks above and stays
        # unprocessed when those miss.
        raw_url = _extract_source_url(entry)
        if (
            raw_url
            and raw_url in note_source_urls
            and raw_url not in collision_source_urls
        ):
            continue
        try:
            st = entry.stat()
        except OSError:
            continue
        rel_path = str(entry.relative_to(wiki_root))
        candidates.append(
            RawFile(
                abs_path=entry,
                rel_path=rel_path,
                slug=slug,
                size_bytes=st.st_size,
                mtime=int(st.st_mtime),
            )
        )

    candidates.sort(key=lambda r: r.mtime, reverse=True)
    # limit <= 0 → unlimited (return all). Only positive values slice — blocks the
    # regression where limit=0 returned an empty list.
    return candidates if limit <= 0 else candidates[:limit]


# -- Step 2: ask Haiku for a compilation proposal ---------------------------


_PROMPT_TEMPLATE = """You are a wiki-curator assistant for the Atrium wiki.

A raw source markdown file is awaiting compilation into wiki/notes/<slug>.md.

RAW FILE METADATA:
- relative path: {raw_rel_path}
- proposed default slug: {default_slug}
- size: {size_bytes} bytes
- modified (epoch UTC): {mtime}

RAW FILE CONTENT (truncated to {excerpt_chars} chars):
---
{raw_excerpt}
---

YOUR TASK:
Judge whether this raw file is suitable for compilation into wiki/notes/. Output
a STRUCTURED text response with the following fields, one per line, in order.
NO preamble, NO markdown fences, NO trailing prose.

PROPOSED_SLUG: <kebab-case slug, ASCII only, ≤60 chars; reuse default if fine>
SOURCE_CREDIBILITY: <high|medium|low|unknown>
  - high: clearly attributed (author/date/URL), reputable origin (blog post,
    GitHub README, conference talk transcript, official docs)
  - medium: mostly clear but missing one of (author, date, URL)
  - low: anonymous, undated, fragmentary, or AI-generated text
  - unknown: cannot determine
FORMAT_CLARITY: <clean|ambiguous|malformed>
  - clean: well-structured headings, paragraphs, lists
  - ambiguous: mixed formats, partial frontmatter
  - malformed: broken markdown, encoding issues, truncated mid-sentence
DUPLICATE_HINT: <none|possible-of:<slug>|unknown>
  - none: no obvious duplicate concept
  - possible-of:<slug>: likely overlaps with an existing note (your guess)
  - unknown: cannot judge without index lookup
RATIONALE: <one or two sentences explaining your credibility/clarity judgment>
PROPOSED_BODY:
<the initial markdown body for wiki/notes/<slug>.md — keep frontmatter minimal
(title, type: source-summary, sources: [raw/<basename>.md]); body ≤ 30 lines;
preserve original language; no wikilinks yet (W5 handles dedup, W6 handles
deadlinks); single H1 matching slug>
"""


def propose_compilation(
    raw: RawFile,
    *,
    claude_bin: str = CLAUDE_BIN,
    timeout_sec: int = HAIKU_TIMEOUT_SEC,
    skip_haiku: bool = False,
) -> CompilationProposal:
    """Invoke Haiku via ``claude -p`` to draft a compilation proposal.

    ``skip_haiku=True`` returns a synthetic proposal — used by ``--dry-run``
    and unit tests. The synthetic shape mirrors a successful Haiku response
    closely enough to exercise the classification gate.
    """
    if skip_haiku:
        # Synthetic proposal: marks credibility/clarity as 'unknown' so classify
        # routes it to notes-dryrun (safest default for unverified content).
        body = _synthesize_dryrun_body(raw)
        return CompilationProposal(
            raw_rel_path=raw.rel_path,
            proposed_slug=raw.slug,
            proposed_target=f"notes/{raw.slug}.md",
            proposed_content=body,
            proposed_content_hash=_sha256(body),
            source_credibility="unknown",
            format_clarity="ambiguous",
            duplicate_hint="unknown",
            haiku_rationale="skip_haiku=True (test/dry-run synthesis)",
            haiku_status="skipped:dry-run",
            raw_response="",
        )

    try:
        excerpt = raw.abs_path.read_text(encoding="utf-8", errors="replace")[
            :RAW_EXCERPT_CHARS
        ]
    except OSError as exc:
        return _failed_proposal(raw, f"read-failed: {exc}", "")

    prompt = _PROMPT_TEMPLATE.format(
        raw_rel_path=raw.rel_path,
        default_slug=raw.slug,
        size_bytes=raw.size_bytes,
        mtime=raw.mtime,
        excerpt_chars=RAW_EXCERPT_CHARS,
        raw_excerpt=excerpt,
    )

    try:
        completed = subprocess.run(  # noqa: S603 — list form, no shell=True
            [
                claude_bin,
                "-p", prompt,
                "--output-format", "text",
                "--max-budget-usd", HAIKU_MAX_BUDGET_USD,
                "--model", HAIKU_MODEL,
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
            env={**os.environ, "OTEL_METRICS_EXPORTER": "none"},
        )
    except subprocess.TimeoutExpired as exc:
        return _failed_proposal(raw, f"haiku-timeout-{timeout_sec}s", str(exc)[:200])
    except FileNotFoundError as exc:
        return _failed_proposal(raw, f"claude-cli-missing: {claude_bin}", str(exc)[:200])

    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "")[:400]
        # Detect local budget-config failure FIRST (before quota). A local
        # --max-budget-usd ceiling miss is a self-inflicted config error, not
        # external quota → haiku_status='skipped:budget-too-low' (a false-positive
        # was the root cause masking a budget=0.005 100x-too-low bug).
        if _detect_budget_too_low(completed.stderr, completed.stdout):
            return CompilationProposal(
                raw_rel_path=raw.rel_path,
                proposed_slug=raw.slug,
                proposed_target=f"notes/{raw.slug}.md",
                proposed_content="",
                proposed_content_hash="",
                source_credibility="unknown",
                format_clarity="malformed",
                duplicate_hint="unknown",
                haiku_rationale=(
                    f"local --max-budget-usd ceiling too low "
                    f"(HAIKU_MAX_BUDGET_USD={HAIKU_MAX_BUDGET_USD}, "
                    f"returncode={completed.returncode}); NOT an external quota cap"
                ),
                haiku_status="skipped:budget-too-low",
                raw_response=tail,
            )
        # Split quota-limit from generic exit error. Quota detected → distinct
        # haiku_status='skipped:quota-limit' so monitor #improvement dashboard
        # differentiates budget exhaustion from generic CLI failure.
        if _detect_quota_limit(completed.stderr, completed.stdout):
            return CompilationProposal(
                raw_rel_path=raw.rel_path,
                proposed_slug=raw.slug,
                proposed_target=f"notes/{raw.slug}.md",
                proposed_content="",
                proposed_content_hash="",
                source_credibility="unknown",
                format_clarity="malformed",
                duplicate_hint="unknown",
                haiku_rationale=(
                    f"haiku quota limit detected "
                    f"(returncode={completed.returncode})"
                ),
                haiku_status="skipped:quota-limit",
                raw_response=tail,
            )
        return _failed_proposal(raw, f"haiku-exit-{completed.returncode}", tail)

    return _parse_haiku_response(raw, completed.stdout)


def _failed_proposal(raw: RawFile, status: str, raw_response: str) -> CompilationProposal:
    """Build a failure-shaped proposal that the classify gate will route to ``reject``."""
    return CompilationProposal(
        raw_rel_path=raw.rel_path,
        proposed_slug=raw.slug,
        proposed_target=f"notes/{raw.slug}.md",
        proposed_content="",
        proposed_content_hash="",
        source_credibility="unknown",
        format_clarity="malformed",
        duplicate_hint="unknown",
        haiku_rationale=f"proposal failed: {status}",
        haiku_status=f"error:{status}",
        raw_response=raw_response,
    )


def _synthesize_dryrun_body(raw: RawFile) -> str:
    """Minimal stub body for dry-run mode — matches Haiku's PROPOSED_BODY shape."""
    return (
        f"---\n"
        f"title: {raw.slug}\n"
        f"type: source-summary\n"
        f"sources:\n"
        f"  - {raw.rel_path}\n"
        f"---\n\n"
        f"# {raw.slug}\n\n"
        f"_Dry-run proposal stub — no Haiku call made._\n"
    )


# Haiku response parsers — forgiving, prefer partial extraction over total failure.
_RE_SLUG = re.compile(r"^PROPOSED_SLUG:\s*(\S+)\s*$", re.MULTILINE)
_RE_CRED = re.compile(r"^SOURCE_CREDIBILITY:\s*(high|medium|low|unknown)", re.MULTILINE | re.IGNORECASE)
_RE_FMT = re.compile(r"^FORMAT_CLARITY:\s*(clean|ambiguous|malformed)", re.MULTILINE | re.IGNORECASE)
_RE_DUP = re.compile(r"^DUPLICATE_HINT:\s*(none|possible-of:\S+|unknown)", re.MULTILINE | re.IGNORECASE)
_RE_RATIONALE = re.compile(r"^RATIONALE:\s*(.+?)(?=\nPROPOSED_BODY:|\Z)", re.MULTILINE | re.DOTALL)
_RE_BODY = re.compile(r"^PROPOSED_BODY:\s*\n(.+)\Z", re.MULTILINE | re.DOTALL)


def _parse_haiku_response(raw: RawFile, stdout: str) -> CompilationProposal:
    """Extract structured fields from Haiku's response. Tolerate missing fields."""
    text = stdout.strip()

    slug_m = _RE_SLUG.search(text)
    cred_m = _RE_CRED.search(text)
    fmt_m = _RE_FMT.search(text)
    dup_m = _RE_DUP.search(text)
    rationale_m = _RE_RATIONALE.search(text)
    body_m = _RE_BODY.search(text)

    proposed_slug = (slug_m.group(1).strip() if slug_m else raw.slug)[:60]
    # Sanitize slug — strip non-kebab chars; fall back to default if mangled.
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", proposed_slug):
        proposed_slug = raw.slug

    body = body_m.group(1).strip() if body_m else ""
    body_truncated = body[:8000]  # storage cap

    return CompilationProposal(
        raw_rel_path=raw.rel_path,
        proposed_slug=proposed_slug,
        proposed_target=f"notes/{proposed_slug}.md",
        proposed_content=body_truncated,
        proposed_content_hash=_sha256(body_truncated) if body_truncated else "",
        source_credibility=(cred_m.group(1).lower() if cred_m else "unknown"),
        format_clarity=(fmt_m.group(1).lower() if fmt_m else "ambiguous"),
        duplicate_hint=(dup_m.group(1).lower() if dup_m else "unknown"),
        haiku_rationale=(rationale_m.group(1).strip() if rationale_m else "")[:400],
        haiku_status="ok" if body_truncated else "error:empty-body",
        raw_response=text[:4000],
    )


def _sha256(s: str) -> str:
    """Short SHA-256 hex digest — used for collision detection in the classify gate."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# -- Area classification gate -----------------------------------------------

# WHY this ordering (mirrors AutoAgent classify_patch_area):
#   1. Reject FIRST — out-of-scope checks (source not under wiki/raw/, slug
#      collision with different content) must short-circuit before we evaluate
#      content quality.
#   2. notes-dryrun SECOND — uncertainty signals (low credibility, ambiguous
#      format, unknown duplicate) deserve human review even if not rejected.
#   3. notes-auto LAST — only proposals that survived rejection AND satisfy
#      the credibility+clarity floor reach auto-apply candidacy.


def classify_compilation_area(
    proposal: CompilationProposal,
    *,
    seen_slugs: set[str] | None = None,
    existing_notes: set[str] | None = None,
) -> tuple[Classification, str]:
    """Apply-area gate — return (classification, rationale).

    Args:
        proposal: Haiku output to classify.
        seen_slugs: slugs already proposed earlier in THIS cycle (collision guard).
        existing_notes: set of basenames (without .md) already in wiki/notes/
            — if proposed_slug matches AND content_hash differs, that's a
            collision → reject. If basename match AND hash unknown → dryrun.

    Returns:
        (classification, rationale) — rationale explains the decision in
        one sentence, suitable for direct embedding in the JSON report.
    """
    seen_slugs = seen_slugs or set()
    existing_notes = existing_notes or set()

    # --- reject path ------------------------------------------------------

    # R1: empty proposed body → Haiku failed; nothing to classify.
    if not proposal.proposed_content.strip():
        return "reject", f"empty proposed body (haiku_status={proposal.haiku_status})"

    # R2: source must live under wiki/raw/ — anything else is out-of-scope.
    if not proposal.raw_rel_path.startswith("raw/"):
        return "reject", f"source path outside wiki/raw/: {proposal.raw_rel_path}"

    # R3: target must land in wiki/notes/ — never in raw/ or root.
    if not proposal.proposed_target.startswith("notes/"):
        return "reject", f"target outside wiki/notes/: {proposal.proposed_target}"

    # R4: slug collision in this cycle (two raws → same slug = ambiguous).
    if proposal.proposed_slug in seen_slugs:
        return "reject", f"slug already proposed in this cycle: {proposal.proposed_slug}"

    # R5: slug already exists in wiki/notes/ (different content). We can't
    #     know the existing content hash from the basename set alone, so any
    #     name match defers to the dedup module — classify as reject here.
    if proposal.proposed_slug in existing_notes:
        return "reject", (
            f"slug collides with existing note: notes/{proposal.proposed_slug}.md "
            f"(W5 dedup module will reconcile)"
        )

    # --- notes-dryrun (uncertainty floor) ---------------------------------

    if proposal.source_credibility == "low":
        return "notes-dryrun", "low source credibility — needs human review"
    if proposal.format_clarity == "ambiguous":
        return "notes-dryrun", "ambiguous format — needs human review"
    if proposal.format_clarity == "malformed":
        # Malformed but non-empty body — still dry-run rather than reject,
        # because Haiku may have salvaged a usable summary.
        return "notes-dryrun", "malformed source format — needs human review"
    if proposal.duplicate_hint.startswith("possible-of:"):
        return "notes-dryrun", f"possible duplicate flagged by Haiku: {proposal.duplicate_hint}"
    if proposal.source_credibility == "unknown":
        return "notes-dryrun", "credibility unknown — needs human review"

    # --- notes-auto (final gate) ------------------------------------------

    # Only reach here if: credibility ∈ {high, medium}, clarity == clean,
    # duplicate_hint ∈ {none, unknown-already-handled-above}.
    # We require credibility=high for auto. Medium → still dryrun (caution).
    if proposal.source_credibility == "high":
        return "notes-auto", (
            f"high credibility + clean format (slug={proposal.proposed_slug})"
        )

    return "notes-dryrun", (
        f"medium credibility (slug={proposal.proposed_slug}) — defer auto-apply"
    )


# -- Step 3: invoke wiki-sync.sh --force-index ------------------------------


def run_force_index_sync(
    *,
    sync_script: Path = DEFAULT_SYNC_SCRIPT,
    dry_run: bool = False,
    timeout_sec: int = SYNC_TIMEOUT_SEC,
) -> SyncResult:
    """Run ``wiki-sync.sh --force-index`` exactly once per cycle.

    In ``dry_run`` mode we record the intent without invoking the script —
    important because wiki-sync writes to the real wiki.sqlite + master-index.

    This CALL replaces the weekly-heartbeat Sunday force regen, so it MUST
    happen daily. Even if zero raws were processed, the sync still runs
    (catches manual edits made between cycles).
    """
    started = datetime.now(timezone.utc)

    if dry_run:
        return SyncResult(
            mode="dry-run",
            exit_code=-1,
            duration_sec=0.0,
            stderr_tail="[dry-run] would invoke: wiki-sync.sh --force-index",
        )

    if not sync_script.exists() or not os.access(sync_script, os.X_OK):
        return SyncResult(
            mode="skipped",
            exit_code=-1,
            duration_sec=0.0,
            stderr_tail=f"sync script missing or not executable: {sync_script}",
        )

    try:
        completed = subprocess.run(  # noqa: S603 — list form, no shell=True
            [str(sync_script), "--force-index"],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        return SyncResult(
            mode="real",
            exit_code=-1,
            duration_sec=elapsed,
            stderr_tail=f"timeout after {timeout_sec}s: {exc}"[:400],
        )

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    tail = (completed.stderr or completed.stdout or "")[-400:]
    return SyncResult(
        mode="real",
        exit_code=completed.returncode,
        duration_sec=elapsed,
        stderr_tail=tail,
    )


# -- Report emission --------------------------------------------------------


def emit_report(report: CycleReport, out_path: Path) -> None:
    """Atomic JSON write — mktemp + os.replace within the same directory.

    Idempotent: re-running on the same UTC day overwrites the file (latest
    cycle wins). The temp file is cleaned up on any error path.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(_report_to_dict(report), ensure_ascii=False, indent=2)
    fd, tmp_name = tempfile.mkstemp(
        prefix=out_path.name + ".",
        suffix=".tmp",
        dir=str(out_path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.write("\n")
        os.replace(tmp_name, out_path)
    except OSError:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _report_to_dict(report: CycleReport) -> dict:
    return {
        "cycle_date": report.cycle_date,
        "generated_at": report.generated_at,
        "raw_processed": report.raw_processed,
        "true_backlog": report.true_backlog,
        "cost_guard": report.cost_guard,
        "compilations": [asdict(c) for c in report.compilations],
        "force_index_result": (
            asdict(report.force_index_result) if report.force_index_result else None
        ),
    }


def render_report_json(report: CycleReport) -> str:
    """Convenience: return the JSON string (used by --stdout debug mode)."""
    return json.dumps(_report_to_dict(report), ensure_ascii=False, indent=2)


# -- Top-level cycle --------------------------------------------------------


def run_cycle(
    *,
    limit: int = DEFAULT_RAW_LIMIT,
    wiki_root: Path = DEFAULT_WIKI_ROOT,
    sync_script: Path = DEFAULT_SYNC_SCRIPT,
    skip_haiku: bool = False,
    skip_sync: bool = False,
) -> CycleReport:
    """Full cycle — detect → propose → classify → force-index.

    Returns the in-memory ``CycleReport``. Caller decides where to persist it.
    """
    now = datetime.now(timezone.utc)
    report = CycleReport(
        cycle_date=now.strftime("%Y-%m-%d"),
        generated_at=now.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        raw_processed=0,
        cost_guard={
            "max_haiku_calls": limit,
            "haiku_max_budget_usd_per_call": HAIKU_MAX_BUDGET_USD,
            "skip_haiku": str(skip_haiku),
            "skip_sync": str(skip_sync),
        },
    )

    # Pre-load existing notes basenames (for the slug-collision check).
    existing_notes: set[str] = set()
    notes_dir = wiki_root / "notes"
    if notes_dir.is_dir():
        for entry in notes_dir.iterdir():
            if entry.is_file() and entry.name.endswith(".md"):
                existing_notes.add(entry.stem)

    raws = detect_unprocessed_raw(wiki_root, limit=limit)
    report.raw_processed = len(raws)
    # For limit<=0 (unlimited), a literal 0 would mislead in the monitor payload →
    # report the actual raw count to process (len(raws)).
    report.cost_guard["max_haiku_calls"] = len(raws) if limit <= 0 else limit

    # true_backlog = the UNBOUNDED hybrid unprocessed count, independent of the
    # per-cycle Haiku `limit` cap. Reuse detect_unprocessed_raw (the single SoT
    # predicate) — never re-derive the hybrid test here. When unlimited, raws is
    # already the full set; only a positive limit needs the separate full scan.
    report.true_backlog = (
        len(raws) if limit <= 0 else len(detect_unprocessed_raw(wiki_root, limit=0))
    )

    seen_slugs: set[str] = set()
    for raw in raws:
        proposal = propose_compilation(raw, skip_haiku=skip_haiku)
        classification, rationale = classify_compilation_area(
            proposal,
            seen_slugs=seen_slugs,
            existing_notes=existing_notes,
        )
        # Reserve the slug only if it survived rejection — prevents a rejected
        # proposal from blocking a later valid raw with the same default slug.
        if classification != "reject":
            seen_slugs.add(proposal.proposed_slug)

        report.compilations.append(
            CompilationResult(
                raw_path=proposal.raw_rel_path,
                proposed_slug=proposal.proposed_slug,
                proposed_target=proposal.proposed_target,
                proposed_content_hash=proposal.proposed_content_hash,
                classification=classification,
                rationale=rationale,
                source_credibility=proposal.source_credibility,
                format_clarity=proposal.format_clarity,
                duplicate_hint=proposal.duplicate_hint,
                haiku_status=proposal.haiku_status,
                error=(
                    proposal.haiku_rationale
                    if classification == "reject" and not proposal.proposed_content
                    else ""
                ),
            )
        )

    # Force-index runs ONCE per cycle, AFTER proposals (so incremental sync
    # sees the latest disk state). Even with zero raws.
    report.force_index_result = run_force_index_sync(
        sync_script=sync_script,
        dry_run=skip_sync,
    )

    return report


# -- Inline unit tests ------------------------------------------------------

# WHY inline (not pytest): zero new dependencies, runnable as
# ``python3 wiki_daemon_cycle.py --self-test`` from the bash entry point's
# verification step. All three classify_compilation_area cases are covered.


def _self_test() -> int:
    """Run inline assertions for classify_compilation_area. Returns exit code."""
    failures: list[str] = []

    # --- blog-post raw → notes-auto --------------------------------------
    p_auto = CompilationProposal(
        raw_rel_path="raw/karpathy-deep-rl-blog.md",
        proposed_slug="karpathy-deep-rl-blog",
        proposed_target="notes/karpathy-deep-rl-blog.md",
        proposed_content="# Karpathy on Deep RL\n\nA well-attributed blog post...",
        proposed_content_hash=_sha256("# Karpathy on Deep RL\n\nA well-attributed blog post..."),
        source_credibility="high",
        format_clarity="clean",
        duplicate_hint="none",
        haiku_rationale="Author + date + URL clearly attributed; clean structure.",
        haiku_status="ok",
        raw_response="(truncated)",
    )
    cls, why = classify_compilation_area(p_auto, existing_notes=set(), seen_slugs=set())
    if cls != "notes-auto":
        failures.append(f"T1 FAIL: expected notes-auto, got {cls!r} ({why})")
    else:
        print(f"T1 PASS: notes-auto — {why}")

    # --- ambiguous source → notes-dryrun ---------------------------------
    p_dryrun = CompilationProposal(
        raw_rel_path="raw/anonymous-fragment.md",
        proposed_slug="anonymous-fragment",
        proposed_target="notes/anonymous-fragment.md",
        proposed_content="# Fragment\n\nSomething about transformers.",
        proposed_content_hash=_sha256("# Fragment\n\nSomething about transformers."),
        source_credibility="low",          # ← triggers dryrun
        format_clarity="clean",
        duplicate_hint="none",
        haiku_rationale="No author/date; cannot verify origin.",
        haiku_status="ok",
        raw_response="(truncated)",
    )
    cls, why = classify_compilation_area(p_dryrun, existing_notes=set(), seen_slugs=set())
    if cls != "notes-dryrun":
        failures.append(f"T2 FAIL: expected notes-dryrun, got {cls!r} ({why})")
    else:
        print(f"T2 PASS: notes-dryrun — {why}")

    # --- raw outside wiki/raw/ → reject ----------------------------------
    p_reject = CompilationProposal(
        raw_rel_path="notes/already-compiled.md",  # ← not under raw/ → R2
        proposed_slug="already-compiled",
        proposed_target="notes/already-compiled.md",
        proposed_content="# Already Compiled\n\nThis is not a raw source.",
        proposed_content_hash=_sha256("# Already Compiled\n\nThis is not a raw source."),
        source_credibility="high",
        format_clarity="clean",
        duplicate_hint="none",
        haiku_rationale="High quality but wrong source location.",
        haiku_status="ok",
        raw_response="(truncated)",
    )
    cls, why = classify_compilation_area(p_reject, existing_notes=set(), seen_slugs=set())
    if cls != "reject":
        failures.append(f"T3 FAIL: expected reject, got {cls!r} ({why})")
    else:
        print(f"T3 PASS: reject — {why}")

    # --- slug collision → reject -----------------------------------------
    p_collide = CompilationProposal(
        raw_rel_path="raw/duplicate-of-existing.md",
        proposed_slug="addyosmani-agent-skills-readme",  # exists in real wiki/notes/
        proposed_target="notes/addyosmani-agent-skills-readme.md",
        proposed_content="# Different Content",
        proposed_content_hash=_sha256("# Different Content"),
        source_credibility="high",
        format_clarity="clean",
        duplicate_hint="none",
        haiku_rationale="Looks fine in isolation.",
        haiku_status="ok",
        raw_response="(truncated)",
    )
    cls, why = classify_compilation_area(
        p_collide,
        existing_notes={"addyosmani-agent-skills-readme"},
        seen_slugs=set(),
    )
    if cls != "reject":
        failures.append(f"T4 FAIL: expected reject (collision), got {cls!r} ({why})")
    else:
        print(f"T4 PASS: reject — {why}")

    if failures:
        for f in failures:
            print(f, file=sys.stderr)
        return 1
    print(f"\nAll {4} classify_compilation_area tests PASSED.")
    return 0


# -- CLI entry --------------------------------------------------------------


def _main(argv: list[str]) -> int:
    """CLI shim — primarily for ``python3 -m wiki_daemon_cycle`` debugging.

    Production entry is wiki-daemon-cycle.sh which calls run_cycle() via this.
    """
    parser = argparse.ArgumentParser(prog="wiki_daemon_cycle")
    parser.add_argument("--limit", type=int, default=DEFAULT_RAW_LIMIT)
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip Haiku calls AND skip wiki-sync invocation")
    parser.add_argument("--skip-haiku", action="store_true")
    parser.add_argument("--skip-sync", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--wiki-root", type=Path, default=DEFAULT_WIKI_ROOT)
    parser.add_argument("--sync-script", type=Path, default=DEFAULT_SYNC_SCRIPT)
    parser.add_argument("--self-test", action="store_true",
                        help="Run inline classify_compilation_area assertions")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    report = run_cycle(
        limit=args.limit,
        wiki_root=args.wiki_root,
        sync_script=args.sync_script,
        skip_haiku=args.skip_haiku or args.dry_run,
        skip_sync=args.skip_sync or args.dry_run,
    )

    payload = render_report_json(report)

    if args.out is not None:
        emit_report(report, args.out)
        sys.stderr.write(f"[wiki-daemon-cycle] wrote {args.out}\n")
    else:
        sys.stdout.write(payload + "\n")

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main(sys.argv[1:]))
