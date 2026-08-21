"""Base-aware three-way merge for the roster files that mix vendor and live rows.

Takes the release skeleton everywhere outside the member-bearing slots and
resolves each slot's member set from three anchors — base@install, live,
release — keyed on member identity. Three shapes share that one contract
through per-shape slot adapters: the registry key map, the markdown
brace-delimited loading list, and the space-padded shell arrays.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_VOCABULARY = 3
EXIT_SHAPE = 4

SHAPE_REGISTRY = "registry"
SHAPE_MARKDOWN = "markdown"
SHAPE_SHELL = "shell"


class RosterMergeError(Exception):
    """Base for every loud refusal this module raises."""


class ShapeError(RosterMergeError):
    """A roster file did not parse in the shape its suffix declares."""


class VocabularyError(RosterMergeError):
    """A resolved member lies outside the closed vocabulary."""


# -- shape selection ---------------------------------------------------------


_SHAPE_BY_SUFFIX = {
    ".json": SHAPE_REGISTRY,
    ".md": SHAPE_MARKDOWN,
    ".sh": SHAPE_SHELL,
}


def get_shape(roster_path: str) -> str:
    """Echo the slot shape a roster path's suffix declares."""
    shape = _SHAPE_BY_SUFFIX.get(Path(roster_path).suffix)
    if shape is None:
        raise ShapeError(f"no roster slot shape for {roster_path}")
    return shape


# -- base@install content store (the roster namespace) -----------------------


# Sibling directory of the flat agent store, mirroring the write side in
# update.sh::update_roster_base_store_dir; the flat basename read side in
# editable_merge stays untouched.
def roster_base_store_dir(state_dir: str | None = None) -> Path:
    """Echo the roster base-content store dir (mirrors ``spine_baseline_dir``)."""
    root = state_dir or str(Path.home() / ".claude" / "data" / "update")
    return Path(root) / "base-roster"


def load_roster_base_text(roster_path: str, state_dir: str | None = None) -> str | None:
    """Read one roster path's base entry, or ``None`` on first sight of the path.

    The key is the manifest-relative path the caller already holds, so no
    namespace predicate and no second declaration of the roster path set enters
    this module.
    """
    candidate = roster_base_store_dir(state_dir) / roster_path
    if candidate.is_file():
        return candidate.read_text(encoding="utf-8")
    return None


def set_roster_base_text(
    roster_path: str, text: str, state_dir: str | None = None
) -> Path:
    """Write one roster path's base entry, creating the key's leading dirs."""
    target = roster_base_store_dir(state_dir) / roster_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


# -- registry adapter (no per-field policy is authored; OD-2) ----------------


_REGISTRY_SLOT = "agents"
_REGISTRY_INDENT = 2


def _load_registry(text: str) -> dict[str, object]:
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ShapeError(f"registry is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise ShapeError("registry root is not an object")
    return doc


def _get_registry_slots(text: str) -> dict[str, dict[str, object]]:
    agents = _load_registry(text).get(_REGISTRY_SLOT)
    if not isinstance(agents, dict):
        raise ShapeError(f"registry carries no '{_REGISTRY_SLOT}' object")
    return {_REGISTRY_SLOT: dict(agents)}


def _set_registry_slots(release_text: str, slots: dict[str, dict[str, object]]) -> str:
    doc = _load_registry(release_text)
    doc[_REGISTRY_SLOT] = dict(slots[_REGISTRY_SLOT])
    return json.dumps(doc, indent=_REGISTRY_INDENT, ensure_ascii=False) + "\n"


# -- markdown brace-list adapter ---------------------------------------------


_MARKDOWN_SLOT = "agent_scope"
_MARKDOWN_LIST_RE = re.compile(r"(?P<open>∈\s*\{)(?P<body>[^{}]*)(?P<close>\})")


def _get_markdown_slots(text: str) -> dict[str, dict[str, object]]:
    matches = list(_MARKDOWN_LIST_RE.finditer(text))
    if len(matches) != 1:
        raise ShapeError(
            f"expected exactly one brace-delimited loading list, found {len(matches)}"
        )
    members = [name.strip() for name in matches[0].group("body").split(",")]
    return {_MARKDOWN_SLOT: {name: name for name in members if name}}


def _set_markdown_slots(release_text: str, slots: dict[str, dict[str, object]]) -> str:
    members = ", ".join(slots[_MARKDOWN_SLOT])
    return _MARKDOWN_LIST_RE.sub(
        lambda m: m.group("open") + members + m.group("close"),
        release_text,
        count=1,
    )


# -- shell array adapter ------------------------------------------------------


# A slot is a space-padded single-string readonly declaration. The padding is
# what selects it: in both live roster shell files every roster array carries the
# padding and no other readonly declaration does, so no list of array names is
# restated here.
_SHELL_ARRAY_RE = re.compile(
    r'^(?P<open>readonly[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)=")'
    r'(?P<body> [^"\n]* )'
    r'(?P<close>"[ \t]*)$',
    re.M,
)


def _get_shell_slots(text: str) -> dict[str, dict[str, object]]:
    slots: dict[str, dict[str, object]] = {}
    for match in _SHELL_ARRAY_RE.finditer(text):
        members = match.group("body").split()
        slots[match.group("name")] = {name: name for name in members}
    if not slots:
        raise ShapeError("no space-padded roster array declared")
    return slots


def _set_shell_slots(release_text: str, slots: dict[str, dict[str, object]]) -> str:
    def _rewrite(match: re.Match[str]) -> str:
        members = slots.get(match.group("name"))
        if members is None:
            return match.group(0)
        # The replacement carries no newline, so the array stays one physical
        # line however many members it resolved to.
        return match.group("open") + " " + " ".join(members) + " " + match.group("close")

    return _SHELL_ARRAY_RE.sub(_rewrite, release_text)


# -- the per-shape reader and writer ------------------------------------------


_ADAPTERS = {
    SHAPE_REGISTRY: (_get_registry_slots, _set_registry_slots),
    SHAPE_MARKDOWN: (_get_markdown_slots, _set_markdown_slots),
    SHAPE_SHELL: (_get_shell_slots, _set_shell_slots),
}


def get_slot_members(text: str, shape: str) -> dict[str, dict[str, object]]:
    """Echo every slot of one roster shape as member identity -> member payload.

    A name-only shape carries the name as its own payload; the registry carries
    the agent's row, which the resolver then decides field by field through the
    same rule the slot uses.
    """
    return _get_adapter(shape)[0](text)


def set_slot_members(
    release_text: str, slots: dict[str, dict[str, object]], shape: str
) -> str:
    """Rebuild the release skeleton with each slot's resolved members substituted."""
    return _get_adapter(shape)[1](release_text, slots)


def _get_adapter(shape: str):
    try:
        return _ADAPTERS[shape]
    except KeyError as exc:
        raise ShapeError(f"unknown roster shape {shape!r}") from exc


# -- the three-anchor resolution rule -----------------------------------------


def _resolve_members(
    base: dict[str, object], live: dict[str, object], release: dict[str, object]
) -> dict[str, object]:
    """Resolve one slot to release ∪ (live − base), release ordering first.

    Identity is the member name in every shape, so the three cases fall out of
    membership alone: a member the base carried and the release dropped is
    removed, a member present live and absent from base is a live addition and
    is kept, and a member the release added arrives with the release's payload.
    """
    resolved: dict[str, object] = {}
    for name, release_value in release.items():
        if name in live:
            resolved[name] = _resolve_value(base.get(name), live[name], release_value)
        else:
            resolved[name] = release_value
    for name, live_value in live.items():
        if name not in release and name not in base:
            resolved[name] = live_value
    return resolved


def _resolve_value(
    base_value: object, live_value: object, release_value: object
) -> object:
    """Resolve one member's payload, recursing through maps and identity lists.

    No per-field rule is written anywhere: a mapping recurses into the slot
    rule, a list resolves by member identity, and a scalar takes the release
    only where the release moved it off the base.
    """
    if isinstance(release_value, dict) and isinstance(live_value, dict):
        base_map = base_value if isinstance(base_value, dict) else {}
        return _resolve_members(base_map, live_value, release_value)
    if isinstance(release_value, list) and isinstance(live_value, list):
        base_list = base_value if isinstance(base_value, list) else []
        return _resolve_list(base_list, live_value, release_value)
    if release_value != base_value:
        return release_value
    return live_value


def _resolve_list(base: list, live: list, release: list) -> list:
    base_keys = {_get_member_key(value) for value in base}
    release_keys = {_get_member_key(value) for value in release}
    resolved = list(release)
    for value in live:
        key = _get_member_key(value)
        if key not in release_keys and key not in base_keys:
            resolved.append(value)
    return resolved


def _get_member_key(value: object) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


# -- closed-vocabulary validation ---------------------------------------------


def _assert_vocabulary(
    resolved: dict[str, dict[str, object]],
    release: dict[str, dict[str, object]],
    agent_names: object,
) -> None:
    """Refuse a resolved member outside the release roster ∪ the on-disk bodies.

    Membership is the whole of a member's identity in every shape, so a
    fabricated or mistyped name is shaped exactly like a real one; this is the
    only site in the merge that can raise on one.
    """
    allowed = set(agent_names)
    for members in release.values():
        allowed |= set(members)
    for slot, members in resolved.items():
        for name in members:
            if name not in allowed:
                raise VocabularyError(
                    f"{slot}: resolved member {name!r} is outside the release "
                    "roster united with the on-disk agent bodies"
                )


# -- entry point ---------------------------------------------------------------


@dataclass(frozen=True)
class RosterCandidate:
    """One roster file's merged text, with whatever the merge had to say."""

    path: str
    text: str
    bootstrapped: bool
    notices: tuple[str, ...]


def build_roster_candidate(
    roster_path: str,
    local_text: str,
    release_text: str,
    agent_names: object,
    base_text: str | None = None,
    state_dir: str | None = None,
) -> RosterCandidate:
    """Merge one roster file from its three anchors, seeding a missing base.

    ``roster_path`` is the manifest-relative path, which selects both the shape
    and the base entry's key. ``base_text`` overrides the store lookup.
    """
    shape = get_shape(roster_path)
    notices: list[str] = []
    bootstrapped = False
    if base_text is None:
        base_text = load_roster_base_text(roster_path, state_dir)
    if base_text is None:
        # Seed the base from the release on first sight rather than declining
        # forever or unioning silently. The cost is named where it is paid: the
        # seeded base equals the release, so a release-side removal cannot be
        # honoured on this run, and the entry left behind honours one on the next.
        base_text = release_text
        set_roster_base_text(roster_path, release_text, state_dir)
        bootstrapped = True
        notices.append(
            f"ROSTER BOOTSTRAP: {roster_path} had no base entry — base seeded from "
            "the release; a release-side removal is not honoured on this run"
        )
    base_slots = get_slot_members(base_text, shape)
    live_slots = get_slot_members(local_text, shape)
    release_slots = get_slot_members(release_text, shape)
    resolved = {
        slot: _resolve_members(
            base_slots.get(slot, {}), live_slots.get(slot, {}), members
        )
        for slot, members in release_slots.items()
    }
    _assert_vocabulary(resolved, release_slots, agent_names)
    return RosterCandidate(
        path=roster_path,
        text=set_slot_members(release_text, resolved, shape),
        bootstrapped=bootstrapped,
        notices=tuple(notices),
    )


def withhold_members(
    roster_path: str, candidate_text: str, names: object
) -> tuple[str, tuple[str, ...]]:
    """Drop each named member from every slot of one already-merged candidate.

    The candidate is the skeleton here rather than the release, so everything
    outside the slots stays the text the merge resolved and only membership
    moves. Echoes the reduced text with the names that were actually present.
    """
    shape = get_shape(roster_path)
    withheld = set(names)
    slots = get_slot_members(candidate_text, shape)
    removed = {name for members in slots.values() for name in members} & withheld
    reduced = {
        slot: {name: value for name, value in members.items() if name not in withheld}
        for slot, members in slots.items()
    }
    return set_slot_members(candidate_text, reduced, shape), tuple(sorted(removed))


# -- thin CLI (mirrors the editable_merge invocation seam) ---------------------


def _get_agent_names(agents_dir: str | None) -> list[str]:
    if not agents_dir:
        return []
    return sorted(path.stem for path in Path(agents_dir).glob("*.md"))


def _cmd_plan(args: argparse.Namespace) -> int:
    try:
        candidate = build_roster_candidate(
            args.target,
            Path(args.local).read_text(encoding="utf-8"),
            Path(args.release).read_text(encoding="utf-8"),
            _get_agent_names(args.agents_dir),
            base_text=(
                Path(args.base).read_text(encoding="utf-8") if args.base else None
            ),
            state_dir=args.state_dir,
        )
    except VocabularyError as exc:
        print(f"ROSTER REFUSED: {args.target}: {exc}", file=sys.stderr)
        return EXIT_VOCABULARY
    except ShapeError as exc:
        print(f"ROSTER REFUSED: {args.target}: {exc}", file=sys.stderr)
        return EXIT_SHAPE
    for notice in candidate.notices:
        print(notice, file=sys.stderr)
    Path(args.out).write_text(candidate.text, encoding="utf-8")
    print(f"verdict=ok path={candidate.path} bootstrap={int(candidate.bootstrapped)}")
    return EXIT_OK


def _cmd_withhold(args: argparse.Namespace) -> int:
    try:
        text, removed = withhold_members(
            args.target, Path(args.candidate).read_text(encoding="utf-8"), args.name
        )
    except ShapeError as exc:
        print(f"ROSTER WITHHOLD REFUSED: {args.target}: {exc}", file=sys.stderr)
        return EXIT_SHAPE
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"withheld={','.join(removed)} path={args.target}")
    return EXIT_OK


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="roster_merge.py",
        description="Base-aware three-way roster merge candidate (D3).",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_plan = sub.add_parser("plan", help="resolve anchors + write a candidate file")
    p_plan.add_argument("--target", required=True, help="manifest-relative roster path")
    p_plan.add_argument("--local", required=True, help="current local file")
    p_plan.add_argument("--release", required=True, help="incoming release file")
    p_plan.add_argument("--base", help="explicit base@install file (else base store)")
    p_plan.add_argument("--out", required=True, help="candidate output path")
    p_plan.add_argument("--agents-dir", help="live agent body dir (closed vocabulary)")
    p_plan.add_argument("--state-dir", help="update state dir override")
    p_withhold = sub.add_parser(
        "withhold", help="drop named members from a generated candidate"
    )
    p_withhold.add_argument(
        "--target", required=True, help="manifest-relative roster path"
    )
    p_withhold.add_argument("--candidate", required=True, help="generated candidate")
    p_withhold.add_argument("--out", required=True, help="reduced candidate output")
    p_withhold.add_argument(
        "--name", action="append", default=[], help="member to drop (repeatable)"
    )
    args = parser.parse_args(argv)
    if args.command == "plan":
        return _cmd_plan(args)
    if args.command == "withhold":
        return _cmd_withhold(args)
    parser.print_usage(sys.stderr)
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
