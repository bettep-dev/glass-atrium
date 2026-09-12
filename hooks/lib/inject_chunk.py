#!/usr/bin/env python3
"""Membership selector and UTF-16 chunker for the split SubagentStart scope-rule channel.

One process per bound slot: select the agent's scoped/ member files from the registry,
split them at headings, pack them into capped parts, and render the part this slot owns.
Packing is a pure function of (registry order, file bytes, the constants below), so the
slots that run concurrently agree on the boundary set without sharing state.
"""

import argparse
import json
import os
import sys
import time

# Engine cap on one hook's additionalContext, in UTF-16 code units, INCLUSIVE.
# PROVENANCE: measured by the W1 channel probe on a SINGLE host build. No producer-side
# check can detect a real cap lower than this — a short cap makes the engine persist the
# chunk to file and hand the agent a preview, which is observable only at the consumer.
# The detector for that is W9(b), which spawns one agent per scope and asserts the
# transcript carries the member chunks in full.
#
# W9 OPERATOR NOTE — START WITH glass-atrium-meta-prompt-engineer. Across the 140 parts of the 23
# agents (measured 2026-09-13 on this corpus) it is the ONLY agent whose largest part exceeds 10,000
# BYTES: 10,009 bytes at 9,917 units, against at most 9,945 bytes for every other agent. So it is
# the single agent for which the cap's unit-ness is load-bearing — every other agent would still fit
# if the cap turned out to count bytes. Since the cap rests on ONE host build's probe, that agent is
# where a byte-counting cap would first show up as a truncated part, and it is the first the live
# check must cover.
#
# WHY THIS CHANNEL COUNTS UNITS, AND WHAT THAT DID NOT FIX (read before hunting a bug):
# counting units here is a CAPACITY decision, not an overflow repair. For the UTF-8 source /
# UTF-16 cap pair the corpus uses, a text's byte count is never FEWER than its unit count —
# ASCII is 1:1, and every multibyte character costs more bytes than units (Korean: 3 bytes,
# 1 unit). So a byte budget can only UNDER-spend the channel, never overflow it: slot 1's
# byte-budgeted assembly measures 9871 bytes for 9712 units, leaving 159 units unused.
# There is no multibyte overflow to find in the byte-budgeted path; on a Korean-heavy member
# a byte budget would waste roughly two thirds of the channel, and that waste is the whole
# reason this path measures units instead.
CHUNK_MAX_UNITS = 10000

# Defensive slack against a later wrapper edit growing the envelope the engine counts.
CHUNK_RESERVE = 64

CHUNK_BUDGET = CHUNK_MAX_UNITS - CHUNK_RESERVE

# Chunk-carrying slots. Twelve SubagentStart bindings ARE TO SHIP: slot 1 is inject-scope-rules.sh,
# which carries the kept marker blocks and no chunk, leaving eleven parts. Today three bindings are
# registered (monitor/src/server/architecture/arch-invariants.ts -> `SubagentStart: 3`) and NO
# wrapper exists — stage 2 authors the wrappers and moves that invariant. Until it does, this
# constant is the plan's slot count, not a count of bound slots.
CHUNK_SLOTS = 11

# Warning-token SoT. Both the chunker that writes these tokens and any scanner that looks
# for them read this one definition (`--print-events`); a scanner with its own copy can
# only ever report clean once the two drift.
EVENT_OVERSIZE = "OVERSIZE"
EVENT_OVERFLOW = "OVERFLOW"
EVENT_MISSINGSOURCE = "MISSINGSOURCE"
EVENT_NOMEMBERSHIP = "NOMEMBERSHIP"
# Raised by the shell seam (lib/inject-chunk.sh), never by this module: the seam aborts before this
# module can run — a missing python3 is exactly the case — so it mirrors the literal and the row
# format rather than importing them. The token lives HERE so the set still has one definition, and
# inject-scope-chunker.bats cross-reads the seam's copy against `--print-events`.
EVENT_SEAMFAULT = "SEAMFAULT"
CHUNK_EVENTS = (
    EVENT_OVERSIZE,
    EVENT_OVERFLOW,
    EVENT_MISSINGSOURCE,
    EVENT_NOMEMBERSHIP,
    EVENT_SEAMFAULT,
)

# No token contains the word DROP: aggregate_drop_rate greps ' DROP ' over its own sink and
# an existing dropsink case pins that numerator.
assert all(" DROP " not in (" %s " % e) for e in CHUNK_EVENTS)

SINK_MAX_BYTES = 1048576

MEMBER_PREFIX = "scoped/"

DEFAULT_ROOT = os.path.join(os.path.expanduser("~"), ".glass-atrium")


def u16(text):
    """UTF-16 code-unit count: an astral character counts 2, as the engine counts it."""
    return len(text.encode("utf-16-le")) // 2


def _env_int(name, fallback):
    raw = os.environ.get(name, "")
    if raw.strip().isdigit():
        return int(raw.strip())
    return fallback


class Config(object):
    """Resolved paths and budgets for one invocation; every field is sandbox-overridable."""

    def __init__(self):
        self.root = os.environ.get("GA_CHUNK_RULES_ROOT", "") or DEFAULT_ROOT
        self.registry = os.environ.get("GA_CHUNK_REGISTRY", "") or os.path.join(
            self.root, "agent-registry.json"
        )
        self.sink = os.environ.get("GA_CHUNK_SINK", "") or os.path.join(
            self.root, "logs", "inject-scope-chunk.diag.log"
        )
        self.max_units = _env_int("GA_CHUNK_MAX_UNITS", CHUNK_MAX_UNITS)
        self.reserve = _env_int("GA_CHUNK_RESERVE", CHUNK_RESERVE)
        self.slots = _env_int("GA_CHUNK_SLOTS", CHUNK_SLOTS)

    @property
    def budget(self):
        return self.max_units - self.reserve


# --- selection ---------------------------------------------------------------


def get_membership(cfg, agent):
    """Ordered scoped/ member paths plus conditional pointers, from the registry.

    Returns (members, conditionals, fault). `fault` is set when the registry cannot be
    read or the agent carries no rules block — never confused with a correctly-empty set.
    """
    try:
        with open(cfg.registry, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        return [], [], "registry unreadable: %s (%s)" % (cfg.registry, exc)

    entry = (data.get("agents") or {}).get(agent)
    if not isinstance(entry, dict):
        return [], [], "no registry entry for agent"
    rules = entry.get("rules")
    if not isinstance(rules, dict) or not rules:
        return [], [], "registry entry carries no rules block"

    ordered = []
    scope = rules.get("scope")
    if scope:
        ordered.append(scope)
    ordered.extend(rules.get("shared") or [])

    # rules/glass-atrium/ members and the Tier-1 ALL column already arrive on the host
    # project-instructions channel, so selecting them would deliver them twice.
    members = [p for p in ordered if p.startswith(MEMBER_PREFIX)]

    conditionals = []
    for item in rules.get("conditional") or []:
        if not isinstance(item, dict):
            continue
        path = item.get("file") or ""
        if path.startswith(MEMBER_PREFIX):
            conditionals.append((path, item.get("when") or ""))
    return members, conditionals, ""


# --- splitting ---------------------------------------------------------------


def split_sections(text, level):
    """Split markdown at `level` headings, keeping any pre-heading lead as its own atom."""
    marker = "#" * level + " "
    atoms = []
    current = []
    for line in text.split("\n"):
        if line.startswith(marker) and current:
            atoms.append("\n".join(current).strip("\n"))
            current = [line]
        else:
            current.append(line)
    if current:
        atoms.append("\n".join(current).strip("\n"))
    return [a for a in atoms if a.strip()]


def get_atoms(text, allowance):
    """Heading-split atoms, re-split at H3 when an H2 atom exceeds one part's allowance.

    Returns (atoms, oversize) — oversize atoms are never truncated and never packed.
    """
    atoms = []
    oversize = []
    for atom in split_sections(text, 2):
        if u16(atom) <= allowance:
            atoms.append(atom)
            continue
        for sub in split_sections(atom, 3):
            if u16(sub) <= allowance:
                atoms.append(sub)
            else:
                oversize.append(sub)
    return atoms, oversize


def get_heading(atom):
    for line in atom.split("\n"):
        if line.startswith("#"):
            return line.strip()
    return atom.split("\n")[0].strip()[:60]


# --- rendering ---------------------------------------------------------------


def build_header(agent, part, total, width):
    """Part header. Fixed-width indices keep its size independent of the packing it feeds."""
    return (
        "**Scope rules — part %s of %s · auto-injected at spawn for %s**\n"
        "- Parts arrive in ANY order and each is complete on its own: apply what THIS part "
        "carries, never wait for another part.\n"
        "- Sources are named per band below. Read a source in full only when you need a "
        "section this part does not carry."
        % (str(part).zfill(width), str(total).zfill(width), agent)
    )


def build_band(cfg, member):
    """Band lead naming the absolute source path, so an unreceived sibling section is Read-able."""
    return "**From `%s` — sections below are verbatim.**" % os.path.join(cfg.root, member)


def build_conditional_stanza(cfg, conditionals):
    if not conditionals:
        return ""
    lines = ["**Conditional rules (not delivered — Read them when the condition holds)**"]
    for path, when in conditionals:
        lines.append(
            "- `%s` — applies when: %s. Read it in full BEFORE your first matching edit."
            % (os.path.join(cfg.root, path), when)
        )
    return "\n".join(lines)


def build_oversize_marker(cfg, items):
    if not items:
        return ""
    lines = ["**Scope rules NOT delivered — Read the path to recover:**"]
    for member, heading, units in items:
        lines.append(
            "- section `%s` of `%s` is %d units and exceeds one part."
            % (heading, os.path.join(cfg.root, member), units)
        )
    return "\n".join(lines)


def build_missing_marker(cfg, members):
    if not members:
        return ""
    lines = ["**Scope rules NOT delivered — member file absent on this install:**"]
    for member in members:
        lines.append("- `%s` — membership names it; the file is not present." % os.path.join(cfg.root, member))
    return "\n".join(lines)


def build_overflow_marker(cfg, undelivered):
    """Names every section past the last slot, so an overflow is recoverable, never silent."""
    if not undelivered:
        return ""
    lines = [
        "**Scope rules NOT delivered — beyond the %d available parts; Read the paths to recover:**"
        % cfg.slots
    ]
    for member, headings in undelivered:
        lines.append("- `%s`: %s" % (os.path.join(cfg.root, member), " · ".join(headings)))
    return "\n".join(lines)


# --- packing -----------------------------------------------------------------


class Piece(object):
    """One renderable unit inside a part: a band lead or a whole section."""

    def __init__(self, text, member, heading, is_band):
        self.text = text
        self.member = member
        self.heading = heading
        self.is_band = is_band
        self.units = u16(text)


def pack(cfg, agent, pieces_by_member, prelude, width):
    """Greedy heading-boundary packing in declared member order.

    Deterministic by construction: no timestamp, no directory order, no cache. Every slot
    recomputes the same boundaries from the same inputs.
    """
    header_units = u16(build_header(agent, 1, 1, width))
    prelude_units = u16(prelude) + 2 if prelude else 0

    chunks = []
    current = []
    current_units = header_units + prelude_units
    current_member = None

    for member, atoms in pieces_by_member:
        band = build_band(cfg, member)
        band_units = u16(band)
        for atom in atoms:
            need = 2 + u16(atom)
            if current_member != member:
                need += 2 + band_units
            if current and current_units + need > cfg.budget:
                chunks.append(current)
                current = []
                current_units = header_units
                current_member = None
                need = 2 + u16(atom) + 2 + band_units
            if current_member != member:
                current.append(Piece(band, member, "", True))
                current_member = member
            current.append(Piece(atom, member, get_heading(atom), False))
            current_units += need
    if current:
        chunks.append(current)
    if not chunks and prelude:
        chunks.append([])
    return chunks


def render(cfg, agent, chunk, part, total, width, prelude, tail):
    body = [build_header(agent, part, total, width)]
    if part == 1 and prelude:
        body.append(prelude)
    body.extend(piece.text for piece in chunk)
    if tail:
        body.append(tail)
    return "\n\n".join(body)


# --- sink --------------------------------------------------------------------


def append_sink(cfg, event, agent, detail):
    """Bounded append to the chunker's own sink; every failure is swallowed (fail-open)."""
    try:
        directory = os.path.dirname(cfg.sink)
        if directory:
            os.makedirs(directory, exist_ok=True)
        if os.path.exists(cfg.sink) and os.path.getsize(cfg.sink) > SINK_MAX_BYTES:
            os.remove(cfg.sink)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(cfg.sink, "a", encoding="utf-8") as handle:
            handle.write(
                "%s [inject-scope-chunk] %s agent=%s %s\n" % (stamp, event, agent, detail)
            )
    except OSError:
        return


def warn(cfg, event, agent, detail):
    sys.stderr.write("[inject-scope-chunk] %s agent=%s %s\n" % (event, agent, detail))
    append_sink(cfg, event, agent, detail)


# --- plan --------------------------------------------------------------------


def get_plan(cfg, agent):
    """Full packing result for one agent: rendered parts plus every warning it raised."""
    members, conditionals, fault = get_membership(cfg, agent)
    warnings = []

    if fault:
        warnings.append((EVENT_NOMEMBERSHIP, "%s registry=%s" % (fault, cfg.registry)))

    present = []
    missing = []
    for member in members:
        path = os.path.join(cfg.root, member)
        if os.path.isfile(path):
            present.append((member, path))
        else:
            missing.append(member)
            warnings.append((EVENT_MISSINGSOURCE, "member=%s path=%s" % (member, path)))

    header_units = u16(build_header(agent, 1, 1, 2))
    # The band lead names the member's ABSOLUTE path, so its size is per-member. Derive the
    # allowance from the LONGEST band this selection will actually render: a fixed placeholder
    # shorter than the longest real member overstates the allowance, and an atom admitted on that
    # overstatement is packed into an empty chunk unconditionally (pack() has no second check for
    # the first atom of a part). The part would then rest on CHUNK_RESERVE absorbing the delta,
    # which is a defensive slack against wrapper growth, not an allowance correction.
    band_units = max(
        [u16(build_band(cfg, member)) for member, _ in present]
        or [u16(build_band(cfg, MEMBER_PREFIX))]
    )
    allowance = cfg.budget - header_units - band_units - 2

    pieces_by_member = []
    oversize = []
    for member, path in present:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError as exc:
            missing.append(member)
            warnings.append((EVENT_MISSINGSOURCE, "member=%s unreadable (%s)" % (member, exc)))
            continue
        atoms, too_big = get_atoms(text, allowance)
        for atom in too_big:
            heading = get_heading(atom)
            oversize.append((member, heading, u16(atom)))
            warnings.append(
                (
                    EVENT_OVERSIZE,
                    "member=%s section=%s units=%d allowance=%d"
                    % (member, heading, u16(atom), allowance),
                )
            )
        if atoms:
            pieces_by_member.append((member, atoms))

    prelude_parts = [
        build_missing_marker(cfg, missing),
        build_oversize_marker(cfg, oversize),
        build_conditional_stanza(cfg, conditionals),
    ]
    if fault:
        prelude_parts.insert(
            0,
            "**Scope rules NOT delivered — no membership is recorded for `%s` in `%s`.**"
            % (agent, cfg.registry),
        )
    prelude = "\n\n".join(p for p in prelude_parts if p)

    chunks = pack(cfg, agent, pieces_by_member, prelude, 2)
    width = max(2, len(str(len(chunks))))
    if width != 2:
        chunks = pack(cfg, agent, pieces_by_member, prelude, width)
        width = max(2, len(str(len(chunks))))

    total = len(chunks)
    tails = {}
    if total > cfg.slots:
        chunks, tails = apply_overflow(cfg, agent, chunks, width, prelude, total)
        warnings.append(
            (
                EVENT_OVERFLOW,
                "chunks=%d slots=%d undelivered=%d" % (total, cfg.slots, total - cfg.slots),
            )
        )

    parts = []
    for index, chunk in enumerate(chunks, start=1):
        text = render(cfg, agent, chunk, index, total, width, prelude, tails.get(index, ""))
        parts.append(text)
    return parts, warnings, total


def apply_overflow(cfg, agent, chunks, width, prelude, total):
    """Keep the first `slots` parts and let the last one name everything past them.

    The marker is budgeted INSIDE the last part: sections are displaced into the marker
    until it fits, so an overflow never produces an over-limit emit and never sheds silently.

    STAGE-2 DOCTOR INPUT (an observation about the header, not a defect in this function): the
    part header keeps the PRE-overflow total, so an overflowing agent reads "part 01 of 14" while
    only 11 parts ever arrive. The number is honest — 14 parts of content exist — but the same
    header tells the agent never to wait for another part, so it can see the gap and do nothing
    about it. The overflow marker below is the recovery path; the header arithmetic is the SIGNAL a
    doctor check should read, since a total above the slot count is exactly the overflow condition
    and is visible from a single delivered part.
    """
    kept = chunks[: cfg.slots]
    dropped = chunks[cfg.slots :]
    last = list(kept[-1]) if kept else []

    def undelivered_of(pieces_list):
        ordered = []
        index = {}
        for pieces in pieces_list:
            for piece in pieces:
                if piece.is_band:
                    continue
                if piece.member not in index:
                    index[piece.member] = []
                    ordered.append(piece.member)
                index[piece.member].append(piece.heading)
        return [(member, index[member]) for member in ordered]

    displaced = []
    while True:
        marker = build_overflow_marker(cfg, undelivered_of([displaced] + dropped))
        rendered = render(
            cfg, agent, last, len(kept), total, width, prelude, marker
        )
        if u16(rendered) <= cfg.max_units:
            break
        if not [p for p in last if not p.is_band]:
            last = []
            break
        displaced.insert(0, last.pop())
    if kept:
        kept[-1] = last
    return kept, {len(kept): build_overflow_marker(cfg, undelivered_of([displaced] + dropped))}


# --- entry -------------------------------------------------------------------


def main(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--agent", default="")
    parser.add_argument("--part", type=int, default=0)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--print-events", action="store_true")
    args = parser.parse_args(argv)

    if args.print_events:
        for event in CHUNK_EVENTS:
            print(event)
        return 0

    cfg = Config()
    if not args.agent:
        return 0

    parts, warnings, total = get_plan(cfg, args.agent)

    # Part 1 owns the warning channel: every slot computes the same plan, so letting each
    # one warn would multiply one fault by the slot count in the sink.
    if args.part <= 1:
        for event, detail in warnings:
            warn(cfg, event, args.agent, detail)

    if args.plan:
        print(
            json.dumps(
                {
                    "agent": args.agent,
                    "parts": len(parts),
                    "chunks": total,
                    "slots": cfg.slots,
                    "max_units": cfg.max_units,
                    "units": [u16(p) for p in parts],
                    "events": [e for e, _ in warnings],
                }
            )
        )
        return 0

    if args.part < 1 or args.part > len(parts):
        return 0

    text = parts[args.part - 1]
    # Re-measured immediately before emit: the packer's accumulator models the renderer,
    # and this is what proves the model right for THIS agent's rendered header.
    #
    # CHANNEL EXCEPTION, stated rather than left to be discovered: every other fault this module
    # closes reaches stderr, the sink AND an in-context marker naming a Read-able path. This one
    # reaches stderr and the sink ONLY — there is no in-context channel left to use, because the
    # thing being suppressed IS the context. It is a BACKSTOP, practically unreachable: the packer's
    # accumulator models render() exactly (same header width, same "\n\n" joins), so a part that
    # measures over the cap here means that model is wrong, which is a defect to fix rather than a
    # state to recover from. The agent loses the part silently; the operator does not lose the fact.
    if u16(text) > cfg.max_units:
        warn(
            cfg,
            EVENT_OVERSIZE,
            args.agent,
            "part=%d rendered=%d cap=%d — suppressed rather than emitted over-limit"
            % (args.part, u16(text), cfg.max_units),
        )
        return 0
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SubagentStart",
                    "additionalContext": text,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # fail-open: a SubagentStart hook must never break a spawn
        sys.stderr.write("[inject-scope-chunk] internal error: %s\n" % exc)
        sys.exit(0)
