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
# Compatibility: Python 3 (stdlib only — json/os, no third-party).

import json as _srm_json
import os as _srm_os


def collect_read_paths(transcript_path):
    """Enumerate Read tool_use file_path values from a transcript jsonl file.

    Returns a list of file_path strings (may be empty). Raises OSError/IOError on
    an unreadable transcript — the caller decides fail-open behavior.
    """
    paths = []
    with open(transcript_path, "r", encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
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
            for chunk in content:
                if not isinstance(chunk, dict):
                    continue
                if chunk.get("type") != "tool_use":
                    continue
                if chunk.get("name") != "Read":
                    continue
                tool_input = chunk.get("input", {})
                if not isinstance(tool_input, dict):
                    continue
                fpath = tool_input.get("file_path", "")
                if isinstance(fpath, str) and fpath:
                    paths.append(fpath)
    return paths


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
