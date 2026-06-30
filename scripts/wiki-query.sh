#!/usr/bin/env bash
# wiki-query.sh — SQLite FTS5 backend for wiki knowledge search.
#
# Queries wiki.sqlite with BM25 weighting (title x3, tags x2, content x1) and
# returns the top-5 results.
#
# Dispatch strategy:
#   * Query is pure ASCII printable  -> notes_fts (unicode61 tokenizer)
#   * Query contains any non-ASCII   -> notes_tri (trigram tokenizer, CJK)
#
# Usage:
#   wiki-query.sh "keyword phrase"           # full-text match
#   wiki-query.sh --tag <tag>                # filter by tag (exact, space-token)
#   wiki-query.sh --type concept             # filter by note type
#   wiki-query.sh --tag android --type concept
#
# Exit codes:
#   0  success (including "no results")
#   1  query error / DB error
#
# Output: one result per line
#   <n>. [<type>] <title> (<path>) — <snippet>

set -Eeuo pipefail
IFS=$'\n\t'

# WIKI_ROOT: single source of truth for the wiki data root. Default = the
# glass-atrium store; WIKI_ROOT env overrides for tests / alternate roots.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
readonly WIKI_ROOT
readonly WIKI_BASE="${WIKI_ROOT}"
readonly INDEX_DIR="${WIKI_BASE}/index"
readonly DB_PATH="${INDEX_DIR}/wiki.sqlite"
readonly TOP_K=5

log_err() { printf '[wiki-query] %s\n' "$*" >&2; }

# ---- Parse args -----------------------------------------------------------
QUERY=""
FILTER_TAG=""
FILTER_TYPE=""

while (( $# > 0 )); do
  case "$1" in
    --tag)
      [[ -n "${2:-}" ]] || { log_err "--tag requires value"; exit 1; }
      FILTER_TAG="$2"
      shift 2
      ;;
    --type)
      [[ -n "${2:-}" ]] || { log_err "--type requires value"; exit 1; }
      FILTER_TYPE="$2"
      shift 2
      ;;
    -h|--help)
      # BASH_SOURCE[0] points at this script regardless of $0 (symlink / PATH /
      # `sh -c` invocation can leave $0 non-readable). Lines 3-22 = the header
      # usage block, kept as the single source of truth.
      sed -n '3,22p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      if [[ -z "${QUERY}" ]]; then
        QUERY="$1"
      else
        QUERY="${QUERY} $1"
      fi
      shift
      ;;
  esac
done

if [[ -z "${QUERY}" && -z "${FILTER_TAG}" && -z "${FILTER_TYPE}" ]]; then
  echo '[wiki-query] usage: wiki-query.sh "keywords" | --tag <tag> | --type <type>'
  exit 0
fi

# ---- DB presence check ----------------------------------------------------
# Distinguish a legitimately-empty store from a relocation-miss (Precondition
# Loud-Fail): if the index/ dir exists but the .sqlite is absent, the configured
# WIKI_ROOT points at a store whose DB went missing (e.g. a botched cutover) —
# fail loud (exit 1) instead of silently reporting "empty". If index/ itself is
# absent, the store was never initialized → legitimately empty (exit 0).
if [[ ! -f "${DB_PATH}" ]]; then
  if [[ -d "${INDEX_DIR}" ]]; then
    log_err "index dir exists but DB is absent: ${DB_PATH}"
    log_err "WIKI_ROOT=${WIKI_ROOT} — possible relocation-miss; verify the configured wiki root"
    exit 1
  fi
  echo "[wiki-query] wiki is empty (DB not initialized: ${DB_PATH})"
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { log_err "python3 not in PATH"; exit 1; }

# ---- TTY color detection (passed to Python via env) -----------------------
if [[ -t 1 ]]; then
  export WIKI_QUERY_TTY=1
else
  export WIKI_QUERY_TTY=0
fi

export WIKI_QUERY_DB="${DB_PATH}"
export WIKI_QUERY_Q="${QUERY}"
export WIKI_QUERY_TAG="${FILTER_TAG}"
export WIKI_QUERY_TYPE="${FILTER_TYPE}"
export WIKI_QUERY_TOPK="${TOP_K}"

python3 - <<'PYEOF'
import os
import re
import sqlite3
import sys

DB       = os.environ["WIKI_QUERY_DB"]
QUERY    = os.environ.get("WIKI_QUERY_Q", "")
TAG      = os.environ.get("WIKI_QUERY_TAG", "")
TYPE_    = os.environ.get("WIKI_QUERY_TYPE", "")
TOPK     = int(os.environ.get("WIKI_QUERY_TOPK", "5"))
USE_TTY  = os.environ.get("WIKI_QUERY_TTY", "0") == "1"

if USE_TTY:
    C_DIM, C_BOLD, C_CYAN, C_RESET = "\033[2m", "\033[1m", "\033[36m", "\033[0m"
else:
    C_DIM = C_BOLD = C_CYAN = C_RESET = ""


def is_cjk(text: str) -> bool:
    return any(ord(ch) > 127 for ch in text)


def build_match_expr(raw: str) -> str:
    """Turn a user query into an FTS5 MATCH expression.

    Each whitespace-separated token is quoted and joined with implicit AND.
    Embedded double quotes are stripped to avoid breaking the quoted phrase.
    """
    tokens = [t.replace('"', "") for t in raw.split() if t.strip()]
    return " ".join(f'"{t}"' for t in tokens if t)


def render_snippet(snip: str) -> str:
    s = snip.replace("\n", " ").replace("\r", " ")
    return re.sub(r"\s+", " ", s).strip()


def run() -> int:
    conn = sqlite3.connect(DB)
    try:
        rows: list[tuple[str, str, str, str, float]] = []

        if QUERY:
            fts_table = "notes_tri" if is_cjk(QUERY) else "notes_fts"
            match_expr = build_match_expr(QUERY)
            if not match_expr:
                print("[wiki-query] empty query after tokenization")
                return 0

            sql = f"""
                SELECT
                    n.type,
                    n.title,
                    n.path,
                    snippet({fts_table}, 2, '[', ']', ' ... ', 12) AS snip,
                    bm25({fts_table}, 3.0, 2.0, 1.0) AS score
                FROM {fts_table}
                JOIN notes n ON n.id = {fts_table}.rowid
                WHERE {fts_table} MATCH ?
            """
            params: list[object] = [match_expr]
            if TAG:
                sql += "  AND (' ' || n.tags || ' ') LIKE ?\n"
                params.append(f"% {TAG} %")
            if TYPE_:
                sql += "  AND n.type = ?\n"
                params.append(TYPE_)
            sql += f"ORDER BY score ASC LIMIT {TOPK}"

            try:
                cur = conn.execute(sql, params)
            except sqlite3.OperationalError as exc:
                sys.stderr.write(f"[wiki-query] FTS error: {exc}\n")
                return 1
            rows = list(cur.fetchall())
        else:
            sql = (
                "SELECT n.type, n.title, n.path, "
                "       substr(n.content, 1, 140) AS snip, 0 AS score "
                "FROM notes n WHERE 1=1"
            )
            params = []
            if TAG:
                sql += " AND (' ' || n.tags || ' ') LIKE ?"
                params.append(f"% {TAG} %")
            if TYPE_:
                sql += " AND n.type = ?"
                params.append(TYPE_)
            sql += f" ORDER BY n.mtime DESC LIMIT {TOPK}"
            rows = list(conn.execute(sql, params).fetchall())

        label_parts = []
        if QUERY:
            label_parts.append(f'"{QUERY}"')
        if TAG:
            label_parts.append(f"tag:{TAG}")
        if TYPE_:
            label_parts.append(f"type:{TYPE_}")
        label = " ".join(label_parts) or "(empty)"

        if not rows:
            print(f"[wiki-query] {label} — no matching wiki documents")
            return 0

        print(
            f"{C_BOLD}[wiki-query] {label}{C_DIM} results "
            f"(top {TOPK}):{C_RESET}"
        )
        for idx, (type_, title, path, snip, _score) in enumerate(rows, 1):
            snippet_clean = render_snippet(snip or "")
            print(
                f"  {idx}. [{C_CYAN}{type_ or '?'}{C_RESET}] "
                f"{C_BOLD}{title}{C_RESET} ({path}) "
                f"{C_DIM}— {snippet_clean}{C_RESET}"
            )
        return 0
    finally:
        conn.close()


sys.exit(run())
PYEOF
