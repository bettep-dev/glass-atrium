#!/usr/bin/env bash
# wiki-sync.sh — incremental sync from wiki/{notes,raw}/*.md -> wiki.sqlite.
#
# Pipeline:
#   1. Ensure DB exists (delegates to wiki-init-db.sh).
#   2. Acquire wiki-lock (name: wiki-sync) to avoid concurrent compile races.
#   3. Walk wiki/notes/*.md and wiki/raw/*.md. For each file:
#        - parse frontmatter (title, tags, type, source_url)
#        - compare mtime against notes.mtime
#        - UPSERT if new/changed (triggers sync FTS tables)
#   4. Prune: delete rows whose path no longer exists on disk.
#   5. If dirty_flag.dirty=1, regenerate master-index.md, clear flag.
#   6. Release lock.
#
# Design decisions:
#   * Idempotent: re-running is a no-op if nothing changed.
#   * O(delta): only changed files write to DB (mtime comparison).
#   * Python does the frontmatter parsing + DB I/O in one process for speed
#     (avoids per-file sqlite3 fork overhead; macOS sqlite3 supports stdin
#      but a single Python process is cleaner for UPSERT + param binding).
#   * master-index.md is written atomically via temp + mv.
#
# Usage:
#   wiki-sync.sh                # sync + regenerate master-index if dirty
#   wiki-sync.sh --force-index  # force master-index regen even if clean

set -Eeuo pipefail
IFS=$'\n\t'

# wiki SQLite writes (notes/dirty_flag/FTS5) are PRESERVED because wiki-query.sh
# BM25 still depends on them. The dual-write blocks below mirror SQLite ops to
# PG (wiki.notes + wiki.dirty_flag) and remain active. The
# master-index.md write at regenerate_master_index() is the wikilink-format
# browse index (LLM-only store, no Obsidian app), not a data sink — also
# preserved.
# WIKI_ROOT: single source of truth for the wiki data root. Default = the
# glass-atrium store. WIKI_BASE is preserved as the alias the inner python
# heredoc env block reads (export WIKI_BASE below) — no python edits required,
# only the bash resolver.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
readonly WIKI_ROOT
readonly WIKI_BASE="${WIKI_ROOT}"
readonly DB_PATH="${WIKI_ROOT}/index/wiki.sqlite"
readonly MASTER_INDEX="${WIKI_ROOT}/index/master-index.md"

# SCRIPT_DIR: resolve sibling helpers relative to this script so a moved/symlinked
# checkout finds its own wiki-lock.sh / wiki-init-db.sh (mirror wiki-init-db.sh).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
readonly SCRIPT_DIR
# Prefer the sibling helper; fall back to the store copy (scripts/ is consumed
# in place from ~/.glass-atrium — the ~/.claude/scripts farm is gone).
if [[ -x "${SCRIPT_DIR}/wiki-lock.sh" ]]; then
  readonly LOCK_HELPER="${SCRIPT_DIR}/wiki-lock.sh"
else
  readonly LOCK_HELPER="${HOME}/.glass-atrium/scripts/wiki-lock.sh"
fi
if [[ -x "${SCRIPT_DIR}/wiki-init-db.sh" ]]; then
  readonly INIT_SCRIPT="${SCRIPT_DIR}/wiki-init-db.sh"
else
  readonly INIT_SCRIPT="${HOME}/.glass-atrium/scripts/wiki-init-db.sh"
fi

FORCE_INDEX=0
if [[ "${1:-}" == "--force-index" ]]; then
  FORCE_INDEX=1
fi

log() { printf '[wiki-sync] %s\n' "$*" >&2; }
die() { printf '[wiki-sync] ERROR: %s\n' "$*" >&2; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not in PATH"
command -v python3  >/dev/null 2>&1 || die "python3 not in PATH"

# 1. Ensure DB
if [[ ! -f "${DB_PATH}" ]]; then
  log "DB missing; bootstrapping"
  "${INIT_SCRIPT}"
fi

run_sync() {
  local force_index="$1"

  WIKI_BASE="${WIKI_BASE}" \
  DB_PATH="${DB_PATH}" \
  MASTER_INDEX="${MASTER_INDEX}" \
  FORCE_INDEX="${force_index}" \
  PG_HELPER_DIR="${SCRIPT_DIR}" \
  python3 - <<'PYEOF'
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

WIKI_BASE    = Path(os.environ["WIKI_BASE"])
DB_PATH      = Path(os.environ["DB_PATH"])
MASTER_INDEX = Path(os.environ["MASTER_INDEX"])
FORCE_INDEX  = os.environ.get("FORCE_INDEX", "0") == "1"

# Dual-write: import shared helper. Failure to import (psycopg missing,
# helper renamed) MUST NOT block SQLite writes — set a sentinel and proceed
# SQLite-only per fail-loud-and-skip.
# Sibling-of-this-script dir (scripts/ consumed in place from the store) passed
# via env — __file__ is absent under a `python3 -` stdin heredoc.
sys.path.insert(0, os.environ["PG_HELPER_DIR"])
try:
    import _pg_dual_write_daemon as _pg
    _PG_AVAILABLE = True
except Exception as _exc:  # noqa: BLE001
    sys.stderr.write(
        "[wiki-sync] PG dual-write helper unavailable: %s (continuing SQLite-only)\n"
        % str(_exc).replace('"', "'")
    )
    _PG_AVAILABLE = False


def _pg_safe(fn_name, **kwargs):
    """Call helper function; swallow any exception so SQLite writes never block."""
    if not _PG_AVAILABLE:
        return
    try:
        getattr(_pg, fn_name)(**kwargs)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(
            '[wiki-sync] pg_%s failed: %s\n'
            % (fn_name, str(e).replace('"', "'").replace('\n', ' ')[:200])
        )

NOTES_DIR = WIKI_BASE / "notes"
RAW_DIR   = WIKI_BASE / "raw"

# \A: strict file-start; BOM stripped upstream by errors='replace'
FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


def parse_frontmatter(text: str):
    """Return (meta_dict, body_str). Minimal YAML: scalars + inline lists.

    Not a full YAML parser. Handles:
        key: value
        key: "quoted value"
        key: [a, b, c]
        key:
          - a
          - b
    """
    m = FM_RE.match(text)
    if not m:
        return {}, text
    fm_raw, body = m.group(1), m.group(2)
    meta: dict[str, object] = {}
    current_list_key: str | None = None
    for line in fm_raw.splitlines():
        if not line.strip():
            current_list_key = None
            continue
        if current_list_key and re.match(r"\s*-\s+", line):
            item = re.sub(r"^\s*-\s+", "", line).strip().strip("'\"")
            meta.setdefault(current_list_key, []).append(item)  # type: ignore[union-attr]
            continue
        mm = re.match(r"^([A-Za-z0-9_\-]+)\s*:\s*(.*)$", line)
        if not mm:
            current_list_key = None
            continue
        key, val = mm.group(1), mm.group(2).strip()
        if val == "":
            current_list_key = key
            meta[key] = []
            continue
        current_list_key = None
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            if not inner:
                meta[key] = []
            else:
                meta[key] = [
                    x.strip().strip("'\"") for x in inner.split(",") if x.strip()
                ]
        else:
            meta[key] = val.strip("'\"")
    return meta, body


def normalize_tags(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, list):
        return " ".join(str(x) for x in raw if x)
    return str(raw)


def infer_type(meta: dict, relpath: str) -> str:
    t = meta.get("type")
    if isinstance(t, str) and t:
        return t
    if relpath.startswith("raw/"):
        return "raw"
    return "concept"


def scan_files():
    for base in (NOTES_DIR, RAW_DIR):
        if not base.is_dir():
            continue
        for md in sorted(base.rglob("*.md")):
            if md.name.startswith("."):
                continue
            yield md


def ensure_schema(conn: sqlite3.Connection) -> None:
    # Schema is applied by wiki-init-db.sh; this is a belt-and-suspenders check.
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE name='notes'"
    ).fetchone()
    if not row or row[0] == 0:
        sys.stderr.write("[wiki-sync] FATAL: schema missing; run wiki-init-db.sh\n")
        sys.exit(2)


def sync(conn: sqlite3.Connection) -> tuple[int, int, int]:
    """Return (upserted, skipped, deleted)."""
    upserted = skipped = deleted = 0
    now = int(time.time())

    seen_paths: set[str] = set()

    for md in scan_files():
        relpath = str(md.relative_to(WIKI_BASE))
        seen_paths.add(relpath)

        try:
            st = md.stat()
        except FileNotFoundError:
            continue
        mtime = int(st.st_mtime)

        row = conn.execute(
            "SELECT id, mtime FROM notes WHERE path = ?", (relpath,)
        ).fetchone()
        if row and row[1] == mtime:
            skipped += 1
            continue

        try:
            text = md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        meta, body = parse_frontmatter(text)
        title = str(meta.get("title") or md.stem)
        tags = normalize_tags(meta.get("tags"))
        type_ = infer_type(meta, relpath)
        source_url = str(meta.get("source_url") or "")

        if row:
            conn.execute(
                """
                UPDATE notes
                   SET title=?, tags=?, type=?, source_url=?,
                       content=?, mtime=?, indexed_at=?
                 WHERE id=?
                """,
                (title, tags, type_, source_url, body, mtime, now, row[0]),
            )
        else:
            conn.execute(
                """
                INSERT INTO notes(path, title, tags, type, source_url,
                                  content, mtime, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (relpath, title, tags, type_, source_url, body, mtime, now),
            )
        # Mirror the same payload to wiki.notes (UPSERT keyed by path). The
        # `ts` tsvector column is GENERATED ALWAYS — auto-populated by PG.
        # `bump_wiki_dirty` mirrors SQLite's notes_ai/au triggers.
        _pg_safe(
            "write_wiki_note",
            path=relpath, title=title, tags=tags, type_=type_,
            source_url=source_url, content=body, mtime=mtime, indexed_at=now,
        )
        _pg_safe("bump_wiki_dirty")
        upserted += 1

    # Prune rows for files that no longer exist on disk.
    existing = {
        r[0] for r in conn.execute("SELECT path FROM notes").fetchall()
    }
    orphaned = existing - seen_paths
    for path in orphaned:
        conn.execute("DELETE FROM notes WHERE path = ?", (path,))
        # Mirror DELETE to PG + bump dirty (mirrors SQLite notes_ad trigger).
        try:
            if _PG_AVAILABLE:
                with _pg._connect() as _del_conn:  # noqa: SLF001
                    with _del_conn.cursor() as _cur:
                        _cur.execute("DELETE FROM wiki.notes WHERE path = %s", (path,))
                    _del_conn.commit()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(
                '[wiki-sync] pg delete failed: %s\n'
                % str(e).replace('"', "'").replace('\n', ' ')[:200]
            )
        _pg_safe("bump_wiki_dirty")
        deleted += 1

    return upserted, skipped, deleted


def regenerate_master_index(conn: sqlite3.Connection) -> None:
    total_notes = conn.execute(
        "SELECT COUNT(*) FROM notes WHERE type != 'raw'"
    ).fetchone()[0]
    total_raws = conn.execute(
        "SELECT COUNT(*) FROM notes WHERE type = 'raw'"
    ).fetchone()[0]

    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    lines: list[str] = []
    lines.append("---")
    lines.append("type: index")
    lines.append(f"generated: {ts}")
    lines.append(f"total_notes: {total_notes}")
    lines.append(f"total_raws: {total_raws}")
    lines.append("---")
    lines.append("")
    lines.append("# Wiki Master Index")
    lines.append("")
    lines.append(
        "> Auto-generated. Do not edit manually. "
        "wiki-sync.sh regenerates this from wiki.sqlite."
    )
    lines.append("")

    # Notes by tag
    lines.append("## Notes (by tag)")
    lines.append("")
    if total_notes == 0:
        lines.append("_No notes yet._")
        lines.append("")
    else:
        tag_bucket: dict[str, list[tuple[str, str]]] = {}
        rows = conn.execute(
            "SELECT path, title, tags FROM notes "
            "WHERE type != 'raw' ORDER BY title COLLATE NOCASE"
        ).fetchall()
        for path, title, tags in rows:
            tag_list = [t for t in (tags or "").split() if t] or ["(untagged)"]
            for tag in tag_list:
                tag_bucket.setdefault(tag, []).append((title, path))
        for tag in sorted(tag_bucket.keys(), key=str.lower):
            lines.append(f"### {tag}")
            lines.append("")
            for title, path in tag_bucket[tag]:
                lines.append(f"- [{title}]({path})")
            lines.append("")

    # Raw sources by collected date (mtime fallback)
    lines.append("## Raw Sources (by collected date)")
    lines.append("")
    raw_rows = conn.execute(
        "SELECT path, title, source_url, mtime FROM notes "
        "WHERE type = 'raw' ORDER BY mtime DESC"
    ).fetchall()
    if not raw_rows:
        lines.append("_No raw sources yet._")
        lines.append("")
    else:
        # Python 3.12+ deprecates utcfromtimestamp; use timezone-aware fromtimestamp
        from datetime import datetime as _dt
        for path, title, source_url, mtime in raw_rows:
            date_s = _dt.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%d")
            url_s = f" — <{source_url}>" if source_url else ""
            lines.append(f"- {date_s} [{title}]({path}){url_s}")
        lines.append("")

    content = "\n".join(lines)
    tmp = MASTER_INDEX.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, MASTER_INDEX)


def main() -> int:
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        ensure_schema(conn)

        with conn:
            upserted, skipped, deleted = sync(conn)

        dirty_row = conn.execute(
            "SELECT dirty FROM dirty_flag WHERE id = 1"
        ).fetchone()
        dirty = bool(dirty_row and dirty_row[0])

        if dirty or FORCE_INDEX:
            regenerate_master_index(conn)
            with conn:
                conn.execute("UPDATE dirty_flag SET dirty = 0 WHERE id = 1")
            # Mirror dirty_flag clear (id=1, dirty=false) into wiki.dirty_flag.
            _pg_safe("clear_wiki_dirty")
            regen_note = "regenerated"
        else:
            regen_note = "skipped (clean)"

        sys.stderr.write(
            f"[wiki-sync] upserted={upserted} skipped={skipped} "
            f"deleted={deleted} master_index={regen_note}\n"
        )
    finally:
        conn.close()
    return 0


sys.exit(main())
PYEOF
}

# 2. Run under wiki-lock
# Export so the nested bash -c subshell sees them.
export WIKI_BASE DB_PATH MASTER_INDEX

if [[ -x "${LOCK_HELPER}" ]]; then
  "${LOCK_HELPER}" with wiki-sync 60 -- \
    bash -c "$(declare -f run_sync); run_sync ${FORCE_INDEX}"
else
  log "lock helper missing; running without lock"
  run_sync "${FORCE_INDEX}"
fi
