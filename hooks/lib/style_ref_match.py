# style_ref_match.py — shared style_ref ↔ Read-history matcher (single SoT).
#
# Consumed by:
#   - ~/.claude/hooks/style-ref-verify.sh   (Stop/SubagentStop warn-not-block hook)
#   - ~/.claude/hooks/track-outcome.sh      (SubagentStop outcome pipeline → style_ref_verified)
#
# Both embed this file via exec() (path passed in STYLE_REF_MATCH_LIB env var) so
# the relative-vs-absolute reconciliation rule lives in ONE place — no drift
# between the standalone warn-hook and the integrated verdict path.
#
# Matching rule (style_ref is emitted RELATIVE, Read file_path is typically
# ABSOLUTE): basename equality OR bidirectional substring containment. Identical
# to style-ref-verify.sh's original inline rule — do not diverge.
#
# collect_read_paths uses a per-session INCREMENTAL cache (below): a repeated fire
# on the SAME growing transcript reuses the path set accumulated from earlier bytes
# instead of re-reading the whole file. Correctness invariant — the returned set is
# ALWAYS the full-scan set: the cache only supplies the already-scanned [0, consumed)
# prefix, and the [consumed, EOF) tail is scanned fresh every fire. A bounded
# TAIL-read accessor is deliberately NOT used: it would drop early-session tool_uses
# and produce FALSE Gaming-the-Judge WARNs. Any cache miss / fingerprint mismatch /
# truncation / cache-layer error falls open to a full scan.
#
# Tool-filter: the scanner selects tool_use entries by a NAME-SET (default {"Read"}
# for style_ref verification; {"Write","Edit"} for the grader's write-history
# cross-check). Two distinct collectors run against the SAME transcript, so the cache
# is namespaced by the tool-filter in BOTH the cache FILENAME and the fingerprint
# check — otherwise the write collector would read the read collector's cached paths
# (a schema-version bump alone does NOT fix this: the filename keys on schema+path,
# so both collectors at one schema still hit one file).
#
# Compatibility: Python 3 (stdlib only — json/os/hashlib, no third-party).

import hashlib as _srm_hashlib
import json as _srm_json
import os as _srm_os

# Cache format version — bump on any stored-schema change so stale entries are
# rejected by fingerprint validation (→ safe full rescan).
_SRM_CACHE_SCHEMA = 1

# Bytes of the file head hashed as an in-place-rewrite guard (append-only logs keep
# their head byte-stable; a changed head invalidates the incremental prefix).
_SRM_HEADER_FP_BYTES = 512


def _srm_sha(data_bytes):
    return _srm_hashlib.sha1(data_bytes).hexdigest()


def _srm_normalize_tool_names(tool_names):
    """Normalize the tool-name filter to a stable (frozenset, tag) pair. The tag is a
    lowercased, sorted, hyphen-joined string used to namespace the cache — {"Read"} →
    'read', {"Write","Edit"} → 'edit-write'. Empty / None falls back to {"Read"}."""
    if not tool_names:
        tool_names = ("Read",)
    if isinstance(tool_names, str):
        tool_names = (tool_names,)
    name_set = frozenset(tool_names)
    tag = "-".join(sorted(n.lower() for n in name_set)) or "read"
    return name_set, tag


def _srm_cache_enabled():
    """False when the kill switch STYLE_REF_READCACHE_OFF is set (any non-empty)."""
    return not _srm_os.environ.get("STYLE_REF_READCACHE_OFF", "").strip()


def _srm_cache_dir():
    """Resolve the incremental read-path cache dir. Precedence:
    STYLE_REF_READCACHE_DIR override (empty → caching off) → TMPDIR fallback.
    The tmp fallback keeps runtime writes out of ~/.claude while still giving the
    two consumer processes (track-outcome.sh + style-ref-verify.sh) a shared key.
    """
    override = _srm_os.environ.get("STYLE_REF_READCACHE_DIR", None)
    if override is not None:
        return override.strip()
    tmp = _srm_os.environ.get("TMPDIR", "").strip() or "/tmp"
    return _srm_os.path.join(tmp, "glass-atrium-style-ref-readcache")


def _srm_cache_file(cache_dir, transcript_path, filter_tag):
    """Cache filename namespaced by schema, tool-filter tag, AND transcript-path hash,
    so the read and write collectors never share one file."""
    digest = _srm_sha(transcript_path.encode("utf-8", "replace"))
    return _srm_os.path.join(
        cache_dir, "v%d-%s-%s.json" % (_SRM_CACHE_SCHEMA, filter_tag, digest)
    )


def _srm_load_cache(cache_file):
    """Return the prior cache dict, or None on missing/corrupt (→ full rescan)."""
    try:
        with open(cache_file, "r", encoding="utf-8") as fh:
            obj = _srm_json.load(fh)
    except (OSError, IOError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None


def _srm_store_cache(cache_file, obj):
    """Atomic best-effort persist (temp + os.replace, same dir → same FS). A write
    failure only costs a re-scan next fire, so all errors are swallowed."""
    try:
        _srm_os.makedirs(_srm_os.path.dirname(cache_file), exist_ok=True)
        tmp = "%s.tmp.%d" % (cache_file, _srm_os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            _srm_json.dump(obj, fh)
        _srm_os.replace(tmp, cache_file)
    except (OSError, IOError, ValueError):
        pass


def _srm_fingerprint_offset(prev, st, header_fp, filter_tag):
    """Validated `consumed` byte offset when prev matches the current file for an
    incremental scan, else None (→ full scan). Conservative: ANY mismatch → None.
    Guards: schema · tool-filter tag (a read-cache is never reused for a write scan)
    · device+inode (file replaced) · size monotonicity (truncation) · header hash
    (in-place rewrite of an append-only log)."""
    try:
        if int(prev.get("schema", -1)) != _SRM_CACHE_SCHEMA:
            return None
        if prev.get("filter") != filter_tag:
            return None
        if int(prev.get("dev", -1)) != int(st.st_dev):
            return None
        if int(prev.get("ino", -1)) != int(st.st_ino):
            return None
        consumed = int(prev.get("consumed", -1))
    except (TypeError, ValueError):
        return None
    if consumed < 0 or consumed > st.st_size:
        return None
    if prev.get("header_fp") != header_fp:
        return None
    return consumed


def _srm_split_committed(chunk):
    """Split raw bytes at the LAST newline → (committed_bytes, tail_bytes).
    committed = complete lines safe to cache + advance past; tail = the trailing
    newline-less segment, parsed fresh each fire but never advanced past (a later
    append completing it is re-read without loss)."""
    nl = chunk.rfind(b"\n")
    if nl == -1:
        return b"", chunk
    return chunk[: nl + 1], chunk[nl + 1:]


def _srm_read_paths_from_bytes(chunk, name_set):
    """Extract tool_use file_path values from a bytes chunk of jsonl, selecting only
    tool_uses whose name is in `name_set` (e.g. {"Read"} or {"Write","Edit"}).

    Faithful to a text-mode per-line scan: decode (errors=replace), normalize
    universal newlines, strip each line, skip blanks + unparseable JSON. Returns a
    list in file order (duplicates preserved) so committed+tail concatenation is
    byte-identical to a full-file scan of the same bytes.
    """
    text = chunk.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    paths = []
    for raw_line in text.split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            entry = _srm_json.loads(raw_line)
        except (ValueError, _srm_json.JSONDecodeError):
            continue
        content = entry.get("content")
        if content is None:
            msg_obj = entry.get("message")
            content = msg_obj.get("content") if isinstance(msg_obj, dict) else None
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "tool_use":
                continue
            if item.get("name") not in name_set:
                continue
            tool_input = item.get("input", {})
            if not isinstance(tool_input, dict):
                continue
            fpath = tool_input.get("file_path", "")
            if isinstance(fpath, str) and fpath:
                paths.append(fpath)
    return paths


def _srm_collect_incremental(transcript_path, name_set, filter_tag):
    """Cache-assisted collection for the given tool-filter. Returns a list, or None
    when caching is disabled (caller does the plain full scan). Transcript read
    errors (OSError/IOError) propagate — the caller's fail-open contract is preserved.
    Cache-layer errors are contained here → they degrade to a within-function full
    scan, never a partial set. The cache file + fingerprint are namespaced by
    filter_tag, so a read scan and a write scan of one transcript never collide."""
    if not _srm_cache_enabled():
        return None
    cache_dir = _srm_cache_dir()
    if not cache_dir:
        return None

    # stat OSError = genuine transcript error → propagate (matches original open()).
    st = _srm_os.stat(transcript_path)

    cache_file = _srm_cache_file(cache_dir, transcript_path, filter_tag)
    prev = _srm_load_cache(cache_file)

    # Single transcript open. open() OSError = genuine transcript error → propagate.
    with open(transcript_path, "rb") as fh:
        header = fh.read(_SRM_HEADER_FP_BYTES)
        header_fp = _srm_sha(header)

        consumed = 0
        base_paths = []
        if prev is not None:
            offset = _srm_fingerprint_offset(prev, st, header_fp, filter_tag)
            if offset is not None:
                prior = prev.get("paths", [])
                if isinstance(prior, list):
                    consumed = offset
                    base_paths = prior

        fh.seek(consumed)
        chunk = fh.read()

    committed, tail = _srm_split_committed(chunk)
    all_committed = base_paths + _srm_read_paths_from_bytes(committed, name_set)
    tail_paths = _srm_read_paths_from_bytes(tail, name_set)

    _srm_store_cache(
        cache_file,
        {
            "schema": _SRM_CACHE_SCHEMA,
            "filter": filter_tag,
            "path": transcript_path,
            "dev": st.st_dev,
            "ino": st.st_ino,
            "consumed": consumed + len(committed),
            "header_fp": header_fp,
            "paths": all_committed,
        },
    )

    # all_committed + tail_paths == full-file order (dups + order preserved).
    return all_committed + tail_paths


def collect_read_paths(transcript_path, tool_names=("Read",)):
    """Enumerate tool_use file_path values from a transcript jsonl file, selecting
    only the tool_uses named in `tool_names` (default {"Read"} for style_ref).

    Returns a list of file_path strings (may be empty). Raises OSError/IOError on
    an unreadable transcript — the caller decides fail-open behavior.

    Backed by the per-session incremental cache above, NAMESPACED by the tool-filter;
    the returned set is always the full-scan set (a cache miss / mismatch / any
    cache-layer defect falls open to a full scan — never a partial set, never a false
    Gaming-the-Judge WARN, never the other collector's cached paths).
    """
    name_set, filter_tag = _srm_normalize_tool_names(tool_names)
    try:
        cached = _srm_collect_incremental(transcript_path, name_set, filter_tag)
    except (OSError, IOError):
        # Genuine transcript read error → preserve the raise contract.
        raise
    except Exception:  # noqa: BLE001 — any CACHE-layer defect → fall open to full scan
        cached = None
    if cached is not None:
        return cached

    # Cache disabled/unavailable → plain full scan (may raise OSError/IOError).
    with open(transcript_path, "rb") as fh:
        data = fh.read()
    return _srm_read_paths_from_bytes(data, name_set)


def collect_write_paths(transcript_path):
    """Enumerate Write/Edit tool_use file_path values — the grader's write-history
    cross-check collector. A thin alias over collect_read_paths with the {"Write",
    "Edit"} filter; the cache is namespaced away from the read collector's."""
    return collect_read_paths(transcript_path, ("Write", "Edit"))


def style_ref_matches(style_ref, read_paths):
    """True when style_ref corresponds to any path in read_paths.

    Rule: basename equality OR bidirectional substring containment — handles the
    relative(style_ref)-vs-absolute(Read file_path) emission divergence.
    """
    if not style_ref:
        return False
    style_basename = _srm_os.path.basename(style_ref)
    for rp in read_paths:
        if not rp:
            continue
        if style_ref in rp or rp in style_ref:
            return True
        if style_basename and style_basename == _srm_os.path.basename(rp):
            return True
    return False
