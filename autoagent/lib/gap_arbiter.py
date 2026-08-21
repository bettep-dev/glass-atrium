"""Model judgment over one contested gap of an agent instruction file (D1).

Assembles the D1.5 prompt from the three gap anchors with numbered lines,
invokes the model through the daemon cycle's own CLI helper, parses the strict
two-part answer, and asserts the selection against the five line-provenance
clauses of D1.4 before the resolved lines are handed back. Every failure class
terminates at the local run with a named row.

The module declares no model id and no per-call budget: both are imported from
the daemon config loader, as is the config path the per-run call ceiling is read
from.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# The daemon cycle lives one directory up and pins the hooks dir itself, so this
# insert is the only path setup either import needs.
_AUTOAGENT_DIR = str(Path(__file__).resolve().parent.parent)
if _AUTOAGENT_DIR not in sys.path:
    sys.path.insert(0, _AUTOAGENT_DIR)

import daemon_cycle  # noqa: E402 — sys.path insert immediately above
from daemon_config import (  # noqa: E402 — reached via the daemon cycle's hooks-dir pin
    HAIKU_MAX_BUDGET_USD,
    HAIKU_MODEL,
    CONFIG_PATH,
)

CHOICE_LOCAL = "LOCAL"
CHOICE_RELEASE = "RELEASE"
CHOICE_INTERLEAVE = "INTERLEAVE"
CHOICES = (CHOICE_LOCAL, CHOICE_RELEASE, CHOICE_INTERLEAVE)

SOURCE_LOCAL = "L"
SOURCE_RELEASE = "R"

FAILURE_TIMEOUT = "timeout"
FAILURE_UNAVAILABLE = "model-unavailable"
FAILURE_BUDGET = "budget-exceeded"
FAILURE_RUN_CEILING = "run-ceiling-exceeded"
FAILURE_UNPARSEABLE = "unparseable-answer"
FAILURE_ASSERTION = "assertion-failed"

CLAUSE_RESOLVABLE = "resolvable"
CLAUSE_NO_REPETITION = "no-repetition"
CLAUSE_MONOTONE = "monotone"
CLAUSE_NO_DROP_OF_NOVEL = "no-drop-of-novel"
CLAUSE_NO_STALE = "no-stale"

# Per-run call ceiling. Read from the daemon config loader's own path so no
# second configuration surface appears; the literal is the absent-key floor,
# mirroring the loader's per-key fallback policy.
RUN_CEILING_KEY = "arbiter_max_calls_per_run"
_RUN_CEILING_FALLBACK = 24


@dataclass(frozen=True)
class GapRequest:
    """One contested gap plus the read-only context the model judges it in."""

    agent: str
    region_index: int
    region_count: int
    region_context: str
    base_lines: tuple[str, ...]
    local_lines: tuple[str, ...]
    release_lines: tuple[str, ...]


@dataclass(frozen=True)
class LineRef:
    """One anchor line named by source letter and 1-based ordinal."""

    source: str
    ordinal: int


@dataclass(frozen=True)
class Answer:
    """The model's parsed answer. ``refs`` is empty for a whole-side choice."""

    choice: str
    refs: tuple[LineRef, ...]
    rationale: str


@dataclass(frozen=True)
class Decision:
    """What the gap resolves to, and why, whether or not a model answered.

    ``refs`` carries the interleave selection so a recording caller can persist
    the decision as references rather than as text — ``lines`` is text, and text
    written to a record is text a later reader could take for an author's.
    """

    lines: tuple[str, ...]
    choice: str | None
    rationale: str
    failure_class: str | None
    clause: str | None
    discarded_novel: int
    rejected_stale: int
    row: str
    refs: tuple[LineRef, ...] = ()


@dataclass
class RunState:
    """Per-run call accounting. One instance spans every gap of one run."""

    ceiling: int = field(default_factory=lambda: get_run_ceiling())
    calls: int = 0
    ceiling_reported: bool = False


def get_run_ceiling(path: Path | None = None) -> int:
    """Echo the per-run arbiter call ceiling the daemon config file names."""
    config_path = path if path is not None else CONFIG_PATH
    try:
        raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _RUN_CEILING_FALLBACK
    if not isinstance(raw, dict):
        return _RUN_CEILING_FALLBACK
    value = raw.get(RUN_CEILING_KEY)
    return value if isinstance(value, int) and value > 0 else _RUN_CEILING_FALLBACK


# -- prompt assembly (D1.5) --------------------------------------------------


_PROMPT = """You are resolving one contested passage in an agent instruction file during a software update.

Two independent editors changed the SAME passage since a common ancestor. One is the released vendor text. The other is a locally accumulated edit that exists in no other copy. Your job is to decide what that passage should say now.

AGENT: {agent}
REGION: editable region {region_index} of {region_count}

COMMON ANCESTOR — what the passage said before either editor touched it. Each line is numbered B1, B2, … :
---
{base_numbered}
---

LOCAL — the live text, locally accumulated. Each line is numbered L1, L2, … :
---
{local_numbered}
---

RELEASE — the vendor text shipped by this update. Each line is numbered R1, R2, … :
---
{release_numbered}
---

SURROUNDING CONTEXT (read-only, not editable here):
---
{region_context}
---

Decide which of these three outcomes gives the better instruction file:

LOCAL — the local text supersedes: the release text is a weaker restatement of it, or says nothing the local text does not already say better.
RELEASE — the release text supersedes: it corrects, generalises or replaces the local text.
INTERLEAVE — the two edits are INDEPENDENT and both must survive. You then list the exact lines to keep, in the order they should appear, by their L and R numbers.

Choose INTERLEAVE whenever the two edits address different things and merely landed next to each other. That case is common, and discarding one of them is the failure this step exists to prevent. Do NOT choose INTERLEAVE where the two say the same thing twice, or where one contradicts the other — choose the side that should win instead.

When you choose INTERLEAVE, every L line and every R line whose text does NOT also appear in the COMMON ANCESTOR must be in your list. Lines that DO also appear in the COMMON ANCESTOR are stale and must NOT be listed; list only lines that appear on one side and not in the ancestor. Never list the same line twice, and keep each source's own lines in their original relative order.

Do NOT evaluate rule compliance, safety, or whether either text is permitted. A separate compliance verifier owns that question and runs after you. Judge only which wording produces the better instruction file.

Do NOT write new text. Your answer names lines that already exist; it does not author.

OUTPUT STRICT FORMAT (no preamble, no markdown fences, exactly these lines):
CHOICE: LOCAL|RELEASE|INTERLEAVE
LINES: <omit this line unless CHOICE is INTERLEAVE; otherwise a comma-separated list such as L1, R2>
RATIONALE: <one or two sentences in English naming what decided it>"""

_STRICT_RETRY_SUFFIX = (
    "\n\nYour previous answer did not match the output format. Emit ONLY the "
    "CHOICE, LINES and RATIONALE lines above, with no preamble, no explanation "
    "and no markdown fences."
)


def build_numbered(prefix: str, lines: tuple[str, ...]) -> str:
    """Number one anchor's run so the answer can reference it instead of quoting it."""
    if not lines:
        return "(empty)"
    return "\n".join(f"{prefix}{i}: {line}" for i, line in enumerate(lines, start=1))


def build_prompt(request: GapRequest) -> str:
    """Assemble the D1.5 prompt for one contested gap."""
    return _PROMPT.format(
        agent=request.agent,
        region_index=request.region_index,
        region_count=request.region_count,
        base_numbered=build_numbered("B", request.base_lines),
        local_numbered=build_numbered("L", request.local_lines),
        release_numbered=build_numbered("R", request.release_lines),
        region_context=request.region_context,
    )


# -- strict answer contract (A3) ---------------------------------------------


_CHOICE_RE = re.compile(r"^CHOICE: (LOCAL|RELEASE|INTERLEAVE)$")
_LINES_RE = re.compile(r"^LINES: (.+)$")
_RATIONALE_RE = re.compile(r"^RATIONALE: (.+)$")
_REF_RE = re.compile(r"^([LR])([0-9]+)$")


def parse_answer(text: str) -> Answer | None:
    """Parse the strict answer grid, or None for every malformed shape.

    None is the sole rejection channel: no shape falls through to a default
    choice, because a silently defaulted answer is indistinguishable from a
    judged one downstream.
    """
    lines = text.strip().splitlines()
    if not lines:
        return None
    choice_match = _CHOICE_RE.match(lines[0].rstrip())
    if choice_match is None:
        return None
    choice = choice_match.group(1)

    rest = [line.rstrip() for line in lines[1:]]
    refs: tuple[LineRef, ...] = ()
    if rest and rest[0].startswith("LINES: "):
        lines_match = _LINES_RE.match(rest[0])
        if lines_match is None:
            return None
        parsed = _parse_refs(lines_match.group(1))
        if parsed is None:
            return None
        refs = parsed
        rest = rest[1:]

    if (choice == CHOICE_INTERLEAVE) != bool(refs):
        return None
    if len(rest) != 1:
        return None
    rationale_match = _RATIONALE_RE.match(rest[0])
    if rationale_match is None:
        return None
    return Answer(choice=choice, refs=refs, rationale=rationale_match.group(1).strip())


def _parse_refs(payload: str) -> tuple[LineRef, ...] | None:
    """Parse a comma-separated reference list, or None if any member is malformed."""
    tokens = [token.strip() for token in payload.split(",")]
    if not tokens or any(not token for token in tokens):
        return None
    refs: list[LineRef] = []
    for token in tokens:
        match = _REF_RE.match(token)
        if match is None:
            return None
        refs.append(LineRef(source=match.group(1), ordinal=int(match.group(2))))
    return tuple(refs)


# -- line-provenance assertion (A4, five clauses) ----------------------------


def find_clause_failure(request: GapRequest, answer: Answer) -> str | None:
    """Name the first provenance clause the answer breaks, or None if it holds.

    A whole-side choice carries no references and so breaks no clause: its run
    identity is guaranteed by construction, since the resolved run is read from
    the anchor rather than from the answer.
    """
    if answer.choice != CHOICE_INTERLEAVE:
        return None

    runs = {SOURCE_LOCAL: request.local_lines, SOURCE_RELEASE: request.release_lines}
    for ref in answer.refs:
        run = runs.get(ref.source)
        if run is None or not 1 <= ref.ordinal <= len(run):
            return CLAUSE_RESOLVABLE

    seen: set[tuple[str, int]] = set()
    for ref in answer.refs:
        key = (ref.source, ref.ordinal)
        if key in seen:
            return CLAUSE_NO_REPETITION
        seen.add(key)

    for source in runs:
        ordinals = [ref.ordinal for ref in answer.refs if ref.source == source]
        if ordinals != sorted(ordinals):
            return CLAUSE_MONOTONE

    base = set(request.base_lines)
    for source, run in runs.items():
        for ordinal, line in enumerate(run, start=1):
            if line not in base and (source, ordinal) not in seen:
                return CLAUSE_NO_DROP_OF_NOVEL

    for ref in answer.refs:
        if runs[ref.source][ref.ordinal - 1] in base:
            return CLAUSE_NO_STALE
    return None


def build_gap_lines(request: GapRequest, answer: Answer) -> tuple[str, ...]:
    """Resolve the answer to anchor lines. The answer carries no text of its own."""
    if answer.choice == CHOICE_LOCAL:
        return request.local_lines
    if answer.choice == CHOICE_RELEASE:
        return request.release_lines
    runs = {SOURCE_LOCAL: request.local_lines, SOURCE_RELEASE: request.release_lines}
    return tuple(runs[ref.source][ref.ordinal - 1] for ref in answer.refs)


def count_discarded_novel(request: GapRequest, choice: str) -> int:
    """Count the novel lines a whole-side choice throws away — the D1.4 residual."""
    if choice == CHOICE_LOCAL:
        discarded = request.release_lines
    elif choice == CHOICE_RELEASE:
        discarded = request.local_lines
    else:
        return 0
    base = set(request.base_lines)
    return sum(1 for line in discarded if line not in base)


def count_rejected_stale(request: GapRequest) -> int:
    """Count the base-present anchor lines clause five keeps out of an interleave."""
    base = set(request.base_lines)
    both = request.local_lines + request.release_lines
    return sum(1 for line in both if line in base)


# -- failure ladder and loud rows (A5) ---------------------------------------


def build_row(
    request: GapRequest,
    failure_class: str,
    ceiling: str,
    *,
    clause: str | None = None,
) -> str:
    """Build the named row a terminal failure writes."""
    row = (
        f"[arbiter] {failure_class} agent={request.agent} "
        f"region={request.region_index}/{request.region_count} ceiling={ceiling}"
    )
    return f"{row} clause={clause}" if clause else row


def _build_local_decision(
    request: GapRequest,
    failure_class: str,
    ceiling: str,
    *,
    clause: str | None = None,
    row: str | None = None,
) -> Decision:
    return Decision(
        lines=request.local_lines,
        choice=None,
        rationale="",
        failure_class=failure_class,
        clause=clause,
        discarded_novel=0,
        rejected_stale=0,
        row=build_row(request, failure_class, ceiling, clause=clause) if row is None else row,
    )


def get_decision(
    request: GapRequest,
    *,
    run_state: RunState,
    claude_bin: str = daemon_cycle.CLAUDE_BIN,
    timeout_sec: int = daemon_cycle.HAIKU_TIMEOUT_SEC,
    escalated_timeout_sec: int = daemon_cycle.HAIKU_ESCALATED_TIMEOUT_SEC,
) -> Decision:
    """Judge one contested gap, or land on the local run with a named row.

    Retries split by failure class: a timeout takes one attempt at the escalated
    ceiling, an unparseable answer takes one strict-format retry, and the four
    remaining classes take none because each is a real cap or a contract breach
    rather than a transient.
    """
    if run_state.calls >= run_state.ceiling:
        # An ENTRY check: a gap admitted on the last slot still takes its retry,
        # so a run overshoots the ceiling by at most that one further call.
        # Every subsequent gap of an over-ceiling run takes the ladder, but only
        # the first writes a row: one summary row per run, not one per gap.
        row = (
            build_row(request, FAILURE_RUN_CEILING, str(run_state.ceiling))
            if not run_state.ceiling_reported
            else ""
        )
        run_state.ceiling_reported = True
        return _build_local_decision(
            request, FAILURE_RUN_CEILING, str(run_state.ceiling), row=row
        )

    prompt = build_prompt(request)
    completed, early_exit, _ = _invoke(prompt, claude_bin, timeout_sec, run_state)

    if early_exit is not None and _is_timeout(early_exit):
        completed, early_exit, _ = _invoke(
            prompt, claude_bin, escalated_timeout_sec, run_state
        )
        if early_exit is not None and _is_timeout(early_exit):
            return _build_local_decision(
                request, FAILURE_TIMEOUT, f"{escalated_timeout_sec}s"
            )
    if early_exit is not None:
        return _build_local_decision(request, FAILURE_UNAVAILABLE, claude_bin)
    assert completed is not None
    if completed.returncode != 0:
        # A CLI that RAN and refused classifies here, a quota-exhausted one
        # included; unavailable is the early exit above, which is a missing binary.
        return _build_local_decision(request, FAILURE_BUDGET, HAIKU_MAX_BUDGET_USD)

    answer = parse_answer(completed.stdout)
    if answer is None:
        completed, early_exit, _ = _invoke(
            prompt + _STRICT_RETRY_SUFFIX, claude_bin, timeout_sec, run_state
        )
        if early_exit is not None or completed is None or completed.returncode != 0:
            return _build_local_decision(request, FAILURE_UNPARSEABLE, "1 strict retry")
        answer = parse_answer(completed.stdout)
        if answer is None:
            return _build_local_decision(request, FAILURE_UNPARSEABLE, "1 strict retry")

    clause = find_clause_failure(request, answer)
    if clause is not None:
        return _build_local_decision(
            request, FAILURE_ASSERTION, "5 clauses", clause=clause
        )

    return Decision(
        lines=build_gap_lines(request, answer),
        choice=answer.choice,
        rationale=answer.rationale,
        failure_class=None,
        clause=None,
        discarded_novel=count_discarded_novel(request, answer.choice),
        rejected_stale=(
            count_rejected_stale(request) if answer.choice == CHOICE_INTERLEAVE else 0
        ),
        row=build_row(request, f"resolved:{answer.choice}", HAIKU_MODEL),
        refs=answer.refs,
    )


def _invoke(prompt: str, claude_bin: str, timeout_sec: int, run_state: RunState):
    """Spend one call through the daemon's own CLI helper, which carries the model and cap."""
    run_state.calls += 1
    return daemon_cycle._invoke_haiku_cli(
        prompt=prompt, claude_bin=claude_bin, timeout_sec=timeout_sec
    )


def _is_timeout(early_exit) -> bool:
    """Discriminate the helper's timeout early-exit from its missing-binary one."""
    return early_exit.rationale.startswith(daemon_cycle.HAIKU_TIMEOUT_RATIONALE_PREFIX)
