"""Atomic safe-write for JSON stores (AC7 / M2 — generate-manifest.sh pattern).

Responsibilities:
    Write a JSON object to a live path so a mid-write crash can never leave a
    half-written file in place: serialize to a sibling temp file, re-parse the
    temp to prove it is valid JSON (and satisfies an optional structure check),
    then os.replace() it over the target in one atomic rename.

Mirrors generate-manifest.sh L135-148 (temp -> jq re-validate -> mv -f), NOT
sync-registry-tools.sh's direct write_text (the unsafe path the plan flags).
The registry is read live by routing/monitor, so a half file is a real hazard.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any  # Any: arbitrary JSON object/array shapes are written


class AtomicWriteError(RuntimeError):
    """Serialization, validation, or rename failed — the live file is UNCHANGED."""


def _atomic_replace(
    path: Path,
    text: str,
    *,
    before_replace: Callable[[Path], None] | None = None,
) -> None:
    """Write `text` to a sibling temp file, then os.replace() it over `path`.

    The shared temp+rename core both the JSON and the scope-dev text store use:
    mkstemp in the target's dir -> fdopen(w) -> write -> (optional pre-replace
    hook against the temp path) -> os.replace -> cleanup the temp on any failure.
    `before_replace`, when supplied, runs against the written temp path and may
    raise to abort the swap (the JSON store re-parses + validates here). On any
    OSError the live file is untouched and the temp is removed.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name: str | None = None
    try:
        fd, tmp_name = tempfile.mkstemp(
            prefix=path.name + ".", suffix=".al-tmp", dir=str(path.parent)
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        if before_replace is not None:
            before_replace(Path(tmp_name))
        os.replace(tmp_name, path)
        tmp_name = None
    finally:
        if tmp_name is not None:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp_name)


def atomic_write_json(
    path: Path,
    data: Any,  # Any: arbitrary JSON-serializable payload (registry/manifest dict)
    *,
    validate: Callable[[Any], bool] | None = None,
    indent: int = 2,
) -> None:
    """Atomically write `data` as JSON to `path` (temp + re-parse + os.replace).

    The on-disk format mirrors the house registry style: 2-space indent,
    ensure_ascii=False, single trailing newline. `validate`, when supplied, runs
    against the RE-PARSED temp content and must return True before the rename —
    so a structurally wrong payload (e.g. missing the `agents` dict) never
    replaces the live file. Raises AtomicWriteError on any failure; the live
    file is left untouched and the temp is cleaned up.
    """
    path = Path(path)
    text = json.dumps(data, indent=indent, ensure_ascii=False) + "\n"

    def _revalidate(tmp_path: Path) -> None:
        # re-parse the temp before the swap — a malformed intermediate must
        # never replace the live store (the generate-manifest.sh re-validate).
        reparsed = json.loads(tmp_path.read_text(encoding="utf-8"))
        if validate is not None and not validate(reparsed):
            raise AtomicWriteError(
                f"post-write validation rejected the generated content for {path}"
            )

    try:
        _atomic_replace(path, text, before_replace=_revalidate)
    except (OSError, json.JSONDecodeError) as exc:
        raise AtomicWriteError(f"atomic JSON write to {path} failed: {exc}") from exc


def has_agents_dict(reparsed: Any) -> bool:  # Any: re-parsed registry JSON shape
    """AC7 structure check: the value is a dict with a top-level `agents` dict.

    The single post-write validator the ADD/extend (registry_ops) path passes to
    atomic_write_json so a structurally wrong payload never replaces the live
    registry.
    """
    return isinstance(reparsed, dict) and isinstance(reparsed.get("agents"), dict)


def load_json(path: Path) -> Any:  # Any: parsed JSON shape is store-specific
    """Read + parse a JSON store, raising AtomicWriteError on parse failure.

    Used to confirm a live registry/manifest is parseable before and after a
    transaction (the AC7 "always parseable" assertion).
    """
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AtomicWriteError(f"failed to read JSON from {path}: {exc}") from exc
