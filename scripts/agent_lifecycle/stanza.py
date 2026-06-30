"""scope-dev.md Tier-2 loading-stanza editor (B4 / AC8 / dev-note 1).

Responsibilities:
    Insert (and reverse-remove) a DEV agent NAME inside the prose brace list
    `agent_scope ∈ {dev-front, dev-react, ...}` in scope-dev.md. This roster is
    the DEV SoT (the matrix scope map + inject-scope-rules.sh arrays key on it);
    a DEV agent absent from it is a load-orphan (spawnable but no Tier-2 rules).

The roster is brace-list-in-prose, NOT a clean array (dev-note 1) — so the edit
is an ANCHORED regex insert, validated by re-parsing the brace list after the
edit (round-trip), and idempotent: inserting a name already present is a no-op
(dedup), so a clean-tree re-run does not double-add. Removal is the symmetric
reverse-op for rollback.

This module operates on TEXT and returns new text; the caller does the atomic
file write (text store, not JSON — written with a temp+replace helper here).
"""

from __future__ import annotations

from pathlib import Path

from .atomic import _atomic_replace
from .readers import _ROSTER_STANZA_RE, parse_roster_text


class StanzaError(RuntimeError):
    """The stanza could not be located or the post-edit round-trip failed."""


def insert_name_in_text(text: str, name: str) -> str:
    """Return scope-dev.md text with `name` inserted into the roster brace list.

    Anchored on `agent_scope ∈ {...}`. Idempotent: if `name` is already a roster
    member the text is returned UNCHANGED (dedup — clean-tree re-run = no-op).
    Appends `, name` after the last existing member, preserving the original
    brace-list spacing convention (`{a, b, c}`). Round-trip-validates the result
    by re-parsing the edited brace list and asserting `name` is now present and
    no prior member was lost.
    """
    match = _ROSTER_STANZA_RE.search(text)
    if match is None:
        raise StanzaError(
            "DEV roster stanza (agent_scope ∈ {...}) not found in scope-dev.md text"
        )

    before = parse_roster_text(text)
    if name in before:
        return text  # idempotent — already a member, no-op

    roster_body = match.group("roster")
    # Append after the last member, matching the existing `, ` separator style.
    new_body = f"{roster_body.rstrip()}, {name}"
    start, end = match.span("roster")
    new_text = text[:start] + new_body + text[end:]

    after = parse_roster_text(new_text)
    if name not in after:
        raise StanzaError(f"round-trip check failed: {name!r} absent after insert")
    if set(before) - set(after):
        raise StanzaError(
            f"round-trip check failed: insert dropped member(s) "
            f"{sorted(set(before) - set(after))}"
        )
    return new_text


def remove_name_in_text(text: str, name: str) -> str:
    """Return scope-dev.md text with `name` removed from the roster (rollback op).

    Idempotent: removing a name not present returns the text unchanged. Rebuilds
    the brace list from the parsed members minus `name`, preserving the leading
    member's original spacing. Round-trip-validates the result.
    """
    match = _ROSTER_STANZA_RE.search(text)
    if match is None:
        raise StanzaError(
            "DEV roster stanza (agent_scope ∈ {...}) not found in scope-dev.md text"
        )

    members = parse_roster_text(text)
    if name not in members:
        return text  # idempotent — not a member, no-op

    kept = [m for m in members if m != name]
    new_body = ", ".join(kept)
    start, end = match.span("roster")
    new_text = text[:start] + new_body + text[end:]

    after = parse_roster_text(new_text)
    if name in after:
        raise StanzaError(
            f"round-trip check failed: {name!r} still present after remove"
        )
    return new_text


def atomic_write_text(path: Path, text: str) -> None:
    """Atomically write `text` to `path` (temp + os.replace), like the JSON helper.

    scope-dev.md is a text store, so json re-validation does not apply; instead
    the CALLER round-trip-parses the new text before writing (insert/remove do
    that). This guarantees no half-written stanza file replaces the live one.
    Delegates to the shared atomic.atomic_write_json temp+replace core.
    """
    _atomic_replace(Path(path), text)
