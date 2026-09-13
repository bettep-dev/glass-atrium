"""Operator EDITABLE-reset request — the single owner of the request file format.

An operator records which agent bodies must have their EDITABLE regions reset to
the release; the next update's merge resolves exactly those bodies with the
``reset-to-release`` verdict. The plan and verify processes both read the request
here, through the same state root, so neither can resolve a body the other does
not.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import editable_merge as em

_REQUEST_DIR = "editable-reset"
_PENDING_FILE = "pending.json"

# The id rides a space-delimited plan line, so it must stay one token.
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_TARGET_RE = re.compile(r"^agents/[^/]+\.md$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class ResetRequestError(Exception):
    """A pending request exists but cannot be read or does not match the format."""


def get_request_dir(state_dir: str | None = None) -> Path:
    """Echo the request directory under the update state root."""
    return Path(em.state_root(state_dir)) / _REQUEST_DIR


def get_pending_path(state_dir: str | None = None) -> Path:
    """Echo the pending request file path."""
    return get_request_dir(state_dir) / _PENDING_FILE


def get_pending_request(target_file: str, state_dir: str | None = None) -> str | None:
    """Request id marking ``target_file`` for a reset, or None when unmarked.

    ``target_file`` is the full logical target (``agents/<name>.md``) and matches
    exactly: a bare basename would let a same-named file elsewhere ride a request
    the operator scoped to one agent body.

    Raises ``ResetRequestError`` on an unreadable or malformed request rather than
    returning None — an unreadable request read as "none pending" would land the
    daemon lines the operator asked to remove, silently.
    """
    pending = get_pending_path(state_dir)
    if not pending.exists():
        return None
    try:
        request = json.loads(pending.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResetRequestError(f"{pending}: unreadable reset request ({exc})") from exc
    targets = _get_validated_targets(request, pending)
    return request["request_id"] if target_file in targets else None


def _get_validated_targets(request: object, pending: Path) -> set[str]:
    """Marked targets of a parsed request; raises on any format violation."""
    if not isinstance(request, dict):
        raise ResetRequestError(f"{pending}: reset request is not a JSON object")
    request_id = request.get("request_id")
    if not isinstance(request_id, str) or not _REQUEST_ID_RE.match(request_id):
        raise ResetRequestError(f"{pending}: request_id missing or not one token")
    bodies = request.get("bodies")
    if not isinstance(bodies, list) or not bodies:
        raise ResetRequestError(f"{pending}: bodies missing or empty")
    targets: set[str] = set()
    for body in bodies:
        if not isinstance(body, dict):
            raise ResetRequestError(f"{pending}: body entry is not an object")
        target = body.get("target")
        if not isinstance(target, str) or not _TARGET_RE.match(target):
            raise ResetRequestError(f"{pending}: target is not agents/<name>.md")
        live_sha256 = body.get("live_sha256")
        if not isinstance(live_sha256, str) or not _SHA256_RE.match(live_sha256):
            raise ResetRequestError(f"{pending}: {target} live_sha256 is not a digest")
        targets.add(target)
    return targets
