#!/usr/bin/env python3
# Pure outcome-signal rules — the SINGLE definition of the negative-signal
# predicate (learning-aggregator pattern emit; daemon_cycle post-apply
# regression watch), of the Role → Allowed task_types
# allowlist that predicate depends on, and of the per-pattern metric
# (pair windows, spawn half, occurrence floor).
#
# STDLIB-ONLY BY CONTRACT, psycopg-free in particular. learning-aggregator imports
# these rules OUTSIDE the guard that degrades it when the DB driver is missing, and
# the driver-absent path is exactly where a second hand-written copy of the
# predicate used to drift. The allowlist's former home _pg_outcome_dualwrite calls
# sys.exit() at MODULE SCOPE on a missing psycopg: SystemExit derives from
# BaseException, so an `except Exception` fail-open guard around that import does
# NOT catch it and the importing process dies instead of degrading. Any import with
# a driver dependency added here re-opens that kill path.

# daemon imports this unguarded on an install's python3 3.9 → no 3.10+ construct at import
from __future__ import annotations

import hashlib
import os
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timedelta, timezone
from types import MappingProxyType, SimpleNamespace
from typing import NamedTuple

# ---------------------------------------------------------------------------
# Role → Allowed task_types allowlist
# ---------------------------------------------------------------------------
#
# LAYER-3 mis-classification guard. SINGLE SoT alignment with the
# core-outcome-record.md Role → Allowed task_types table and the track-outcome.sh
# role_task_type_allowed mirror. A 9-set-valid task_type is still OFF-ROLE when
# outside its agent's allowlist (e.g. intel-planner emitting "bug-fix") —
# _pg_outcome_dualwrite._norm_task_type reclassifies such a value to the role
# default so the grader never runs a code check on a non-code deliverable, and
# _is_structural_polar_mismatch below treats it as a definitionally-expected
# mismatch rather than a failure signal. A role absent from this map (dev-* /
# unknown) has no constraining allowlist → any 9-set value is accepted (the DEV
# allowlist is broad).
# Keys prefix-match the lowercased agent name.
_AGENT_ROLE_ALLOWED_TASK_TYPES = {
    "glass-atrium-qa-code-reviewer": {"review"},
    "glass-atrium-qa-debugger": {"diagnosis"},
    "glass-atrium-sec-guard": {"review", "diagnosis"},
    "glass-atrium-intel-reporter": {"doc"},
    "glass-atrium-intel-planner": {"plan", "doc"},
    "glass-atrium-wiki-curator": {"doc"},
    "glass-atrium-design-designer": {"doc", "review"},
    "glass-atrium-meta-prompt-engineer": {"doc", "cleanup", "refactor"},
}


def _role_task_type_allowed(agent, task_type):
    """Is `task_type` within `agent`'s Role → Allowed allowlist? An agent role absent
    from _AGENT_ROLE_ALLOWED_TASK_TYPES (dev-* / unknown / unidentifiable) has no
    constraining allowlist → returns True (any 9-set value accepted). Matches the
    agent name by prefix so a versioned/suffixed id resolves."""
    name = (agent or "").strip().lower()
    if not name:
        return True
    for role_prefix, allowed in _AGENT_ROLE_ALLOWED_TASK_TYPES.items():
        if name == role_prefix or name.startswith(role_prefix):
            return task_type in allowed
    return True


# ---------------------------------------------------------------------------
# Negative-signal trigger predicate (AP-3)
# ---------------------------------------------------------------------------
# One definition → aggregator pattern emit (1/5) + daemon_cycle._is_soft_negative_outcome
# Input: a row dict of _pg_learning_dualwrite.read_outcomes_since

# done_with_concerns stays negative by PAIRED CONTRACT with the Result-selection
# criterion in core-outcome-record.md: that criterion admits the result only for the
# agent's OWN incomplete/unverified/follow-up-needed deliverable, so membership here
# matches the emitted meaning. Polarity is NOT conditioned on metric_pass or any other
# writer self-report. Either side moves → both move in the same meaning-unit commit.
NEGATIVE_SIGNAL_RESULTS = frozenset({"fail", "blocked", "done_with_concerns"})
# Provenance marker track-outcome.sh stamps on a [COMPLETION]-absent + tool_use≥1
# turn (the SubagentStop synthesis path). A synthesized row's result is itself
# synthesized, so its result polarity is NOT an agent-emitted signal.
ATTRIBUTION_SYNTHESIZED = "completion-synthesized"
# Sibling synthesized-provenance marker track-outcome.sh stamps when a subagent is
# hard-killed at its tool_use/turn budget ceiling BEFORE emitting [COMPLETION]. A
# budget-kill IS an agent-relevant negative (the truncated subagent's own
# instructions should improve), so — unlike the pure measurement gap above — it is
# DELIBERATELY left on the CLUSTERABLE side of _is_synthesized_measurement_gap.
# Accepted-scope REACHABILITY limit: pattern-1 clustering needs 3+ same-agent
# negatives within ONE daily watermark batch, so 1-2 truncations/day never form a
# pattern (cross-batch accumulation is a deferred follow-on, out of scope here).
ATTRIBUTION_BUDGET_TRUNCATION = "budget-truncation"
# Third synthesized-provenance sibling track-outcome.sh stamps when a schema-mode
# subagent's TERMINAL StructuredOutput was successfully consumed: result=done +
# confidence=low + metric_pass=false, writer-unverified. 'done' is not in
# NEGATIVE_SIGNAL_RESULTS, so the row's RESULT contributes nothing — but
# track-outcome.sh sets review_flag on it for degraded-row visibility, and that
# OR-term is excluded by _is_visibility_flag_row so the count stays neutral.
# Also a member of _EMIT_FAILURE_ATTRIBUTIONS (emit-failure metric).
ATTRIBUTION_STRUCTUREDOUTPUT_DERIVED = "structuredoutput-derived"
# Per-row floor mirroring the core-learning-log.md "revision_count 2+" process-
# improvement bar — 1 rework request is normal iteration, 2+ marks a correction.
NEGATIVE_REVISION_MIN = 2
GRADER_VERDICT_FAIL = "verified_fail"
# Agent-emitted user correction (core-outcome-record.md: -1 = the user corrected,
# rejected or asked to redo this work) — a first-class learning signal per
# core-learning-log.md, so it is an OR-term of its own rather than something the
# result/revision terms are assumed to cover.
NEGATIVE_EVALUATIVE_SIGNAL = -1
# Hard-bar task_type set — EXACTLY {bug-fix, feature}, the SAME 2-element SoT as
# track-outcome.sh::task_type_has_hard_test_bar and lib/code-based-grader.sh. The
# no-test-bar set is the COMPLEMENT (NOT a re-listed 7-element list) so no new
# task_type list exists to drift — membership is derived as "not bug-fix and not
# feature", mirroring the grader's check structure.
HARD_TEST_BAR_TASK_TYPES = frozenset({"bug-fix", "feature"})
# Dead-signal universe — the aggregator's detector iterates this fixed tuple so
# a metric that NEVER fires still gets reported (a hit-derived dict would omit it).
NEGATIVE_SIGNAL_NAMES = (
    "result=fail",
    "result=blocked",
    "result=done_with_concerns",
    "grader_verdict=verified_fail",
    "review_flag=true",
    "revision_count>=2",
    "evaluative_signal=%d" % NEGATIVE_EVALUATIVE_SIGNAL,
)


def _is_structural_row(row: dict) -> bool:
    """True when the row is a no-test-bar task_type OR an off-role write:
        STRUCTURAL == (task_type_has_hard_test_bar == 0) OR (off-role)
    That is the STRUCTURAL conjunct alone of the track-outcome.sh D1 branch, not the
    whole branch — D1 also requires confidence=high + metric_pass=false, so being
    structural does NOT by itself make a metric_pass=false / review_flag=true
    definitionally expected (see _is_structural_polar_mismatch, which carries the
    full branch and is what the carve-out keys on).
    Off-role reuses the role SoT above (_role_task_type_allowed); the hard-bar
    set is the 2-element {bug-fix, feature} SoT (complement = no-test-bar). NO new
    task_type list is introduced. Tolerates missing keys (synthetic rows)."""
    task_type = (row.get("task_type") or "").strip()
    no_test_bar = task_type not in HARD_TEST_BAR_TASK_TYPES
    off_role = not _role_task_type_allowed(row.get("agent"), task_type)
    return no_test_bar or off_role


def _flag_literal(value) -> str:
    """A tri-state flag value as its emit-side literal: "true" / "false" / "" when ABSENT.

    The absent case must stay distinct from "false" — track-outcome.sh routes the two
    through DIFFERENT review_flag branches and D1 gates only the false one. A bool
    column and a frontmatter string both reach the predicates below, hence the widening;
    bool identity is tested FIRST so an int can never pass as a literal (and so the
    boolean column the DB actually yields skips the string path)."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return ""
    return str(value).strip().lower()


def _is_structural_polar_mismatch(row: dict) -> bool:
    """True for the EXACT row shape track-outcome.sh D1 stopped flagging: a structural
    row (no-test-bar task_type OR off-role) carrying confidence=high + metric_pass=false.

    Mirrors the D1 BRANCH, not merely its structural predicate. D1 gates that one arm;
    the underconfidence (low+true) and ABSENT-metric_pass arms still set review_flag on
    structural rows, so a carve-out keyed on _is_structural_row alone is a SUPERSET of
    what D1 suppresses and silently drops those two live signals from the negative
    predicate."""
    # Cheap conjuncts first: all three are pure and total (every access is
    # row.get(...) or ""), so the order is verdict-identical and skips the
    # frozenset-plus-prefix-loop structural test on the common non-mismatch row.
    return (
        str(row.get("confidence") or "").strip().lower() == "high"
        and _flag_literal(row.get("metric_pass")) == "false"
        and _is_structural_row(row)
    )


def _is_synthesized_measurement_gap(row: dict) -> bool:
    """True when the row is a SubagentStop-synthesized done_with_concerns — i.e. the
    agent finished but emitted no [COMPLETION] block, so track-outcome.sh synthesized
    the outcome with attribution_source=completion-synthesized. Such a row is a
    MEASUREMENT GAP, not an agent failure: its done_with_concerns result is the
    synthesis DEFAULT, not an agent-emitted signal, so it must contribute ZERO
    negative hits. Scoped to done_with_concerns ONLY — a synthesized fail/blocked
    (should not occur from this path) is left to normal evaluation. Tolerates
    missing keys (synthetic test rows).

    budget-truncation shares the synthesized provenance but is a real negative, not
    a measurement gap — the explicit guard keeps it clusterable and holds that
    invariant even if the completion-synthesized match is ever broadened.

    structuredoutput-derived (result=done, writer-unverified) is the third sibling
    provenance: its result contributes no OR-term, but its review_flag does — that
    term is excluded by _is_visibility_flag_row, not here, because the row is not a
    done_with_concerns measurement gap."""
    if (row.get("attribution_source") or "") == ATTRIBUTION_BUDGET_TRUNCATION:
        return False
    return (
        (row.get("attribution_source") or "") == ATTRIBUTION_SYNTHESIZED
        and (row.get("result") or "") == "done_with_concerns"
    )


def _is_visibility_flag_row(row: dict) -> bool:
    """True when the row's review_flag was set purely for degraded-row VISIBILITY by
    track-outcome.sh (writer-absent provenance), not as a writer-side ambiguity signal —
    so that OR-term must not count. Scoped to structuredoutput-derived alone: the sibling
    completion-synthesized provenance pairs with done_with_concerns, which
    _is_synthesized_measurement_gap already short-circuits to zero hits. The two flag-side
    literals are the SAME allowlist track-outcome.sh sets the flag on; budget-truncation and
    truncated_completion are never flagged, so no exclusion exists for them here."""
    src = row.get("attribution_source") or ""
    return src == ATTRIBUTION_STRUCTUREDOUTPUT_DERIVED


def negative_signal_hits(row: dict) -> tuple[str, ...]:
    """Names (subset of NEGATIVE_SIGNAL_NAMES) of the OR-terms this outcome trips.

    A row with ANY hit counts ONCE toward the per-agent trigger (the caller
    keys on truthiness, never on len() — one bad outcome must not be
    double-counted); the per-name breakdown feeds the dead-signal detector.
    Tolerates missing keys (synthetic test rows carry only 'result').

    Three carve-outs suppress a term here, each argued in full at the predicate that
    implements it: the synthesized measurement gap zeroes EVERY hit
    (_is_synthesized_measurement_gap), while the D2 structural and degraded-row
    visibility carve-outs each suppress the review_flag term ALONE
    (_is_structural_polar_mismatch · _is_visibility_flag_row) — every other OR-term on
    such a row is a genuine failure and still counts.

    evaluative_signal carries NO carve-out: a user correction is agent-emitted by
    definition, so it counts on every provenance that reaches this point."""
    if _is_synthesized_measurement_gap(row):
        return ()
    hits: list[str] = []
    result = row.get("result") or ""
    if result in NEGATIVE_SIGNAL_RESULTS:
        hits.append("result=%s" % result)
    if (row.get("grader_verdict") or "") == GRADER_VERDICT_FAIL:
        hits.append("grader_verdict=verified_fail")
    # Parsed by value, not truthiness: read_outcomes_since yields the boolean column
    # while a string-carrying row would make the literal "false" trip a bare bool().
    if (
        _flag_literal(row.get("review_flag")) == "true"
        and not _is_structural_polar_mismatch(row)
        and not _is_visibility_flag_row(row)
    ):
        hits.append("review_flag=true")
    try:
        revision = int(row.get("revision_count") or 0)
    except (TypeError, ValueError):
        revision = 0
    if revision >= NEGATIVE_REVISION_MIN:
        hits.append("revision_count>=2")
    # Compared as text on purpose: read_outcomes_since yields the integer column
    # while the aggregator's record dicts carry the frontmatter string, and an
    # int-only or str-only test silently drops one call site's signal.
    if str(row.get("evaluative_signal") or "").strip() == str(NEGATIVE_EVALUATIVE_SIGNAL):
        hits.append("evaluative_signal=%d" % NEGATIVE_EVALUATIVE_SIGNAL)
    return tuple(hits)


def is_negative_signal_outcome(row: dict) -> bool:
    """True when the row counts toward the per-agent negative-signal trigger."""
    return bool(negative_signal_hits(row))


# Per-pattern metric → aggregator status, intake re-check, roster writer, power check, replay
# Input: _pg_learning_dualwrite.read_pattern_floors / read_pattern_floor, or a replay-local read

METRIC_BUDGET_OVERAGE = "budget_overage"
METRIC_EMIT_FAILURE = "emit_failure"
METRIC_KEYS = frozenset({METRIC_BUDGET_OVERAGE, METRIC_EMIT_FAILURE})
# emit failure's cut-off leg (quota stop, user interrupt, kill): a guardrail, never a pattern key
METRIC_NO_SUBAGENT_STOP = "no_subagent_stop"
# A/A design-effect row key per metric definition; a row counts only for the definition it was
# measured under → the pre-split union-event row, keyed `emit_failure`, sizes no key here
DESIGN_EFFECT_ROW_KEYS = MappingProxyType({
    METRIC_BUDGET_OVERAGE: METRIC_BUDGET_OVERAGE,
    METRIC_EMIT_FAILURE: "emit_failure_attribution",
    METRIC_NO_SUBAGENT_STOP: METRIC_NO_SUBAGENT_STOP,
})
# Recorder-written outcome provenance: the agent emitted no [COMPLETION] of its own.
ATTRIBUTION_TRUNCATED_COMPLETION = "truncated_completion"
_EMIT_FAILURE_ATTRIBUTIONS = frozenset({
    ATTRIBUTION_SYNTHESIZED,
    ATTRIBUTION_STRUCTUREDOUTPUT_DERIVED,
    ATTRIBUTION_BUDGET_TRUNCATION,
    ATTRIBUTION_TRUNCATED_COMPLETION,
})
# = track-outcome.sh TOOL_USE_LINE, whole line, group 1 = actual (test_size_est_underestimate.py)
TOOL_USE_LINE_PATTERN = (
    r"^- [*][*]Tool use[*][*]: actual=([0-9]+)(?: declared=[0-9]+)?$"
)

PAIR_WINDOW = timedelta(days=7)
BASELINE = SimpleNamespace(
    SPAN=timedelta(days=84),  # look-back cap
    MIN_COVERED=timedelta(days=28),  # the power check's projected-units window
)
FLOOR_MIN_SESSIONS = 5
# a no-SubagentStop spawn younger than this at evaluation may still be running
PENDING_GRACE = timedelta(hours=6)
# advisory-subagent-budget.sh → DEFAULT_TOOL_BUDGET, the budget its SUBAGENT_TOOL_BUDGET overrides
DEFAULT_TOOL_BUDGET = 40

VERDICT_PASS = "pass"
VERDICT_FAIL = "fail"
VERDICT_INSUFFICIENT_BASELINE = "insufficient-baseline"


class WindowStarts(NamedTuple):
    baseline: datetime
    detection: datetime
    confirmation: datetime


class PairWindows(NamedTuple):
    """Half-open UTC windows: baseline [start.baseline, start.detection) · detection
    [start.detection, start.confirmation) · confirmation [start.confirmation, end)."""

    start: WindowStarts
    end: datetime


class SpawnFacts(NamedTuple):
    """One spawn unit — every core.spawn_manifest row of one agent_id, each row one activation
    (first start or resume) — plus the daemon-recorded facts joined by that agent_id.

    The earliest row fixes session_id, started_at, arm and salt_id; an `unknown` id row is a
    unit of its own."""

    agent_id: str | None  # None = an `unknown` MANIFEST id → unjoinable
    session_id: str | None
    started_at: datetime
    overage_rows: int  # core.budget_overages rows for agent_id
    has_subagent_stop: bool
    outcomes: tuple[Mapping[str, object], ...]  # core.outcomes rows for agent_id
    stopped_at: datetime | None = None  # earliest SubagentStop; None → no continuation follows
    tool_use_actual: int | None = None  # recorder's header line; None = unrecorded
    # canary exposure (core.spawn_manifest column comments); all None = older line or schema
    arm: int | None = None  # 1 = treatment, 0 = control
    salt_id: int | None = None
    is_delivered: bool | None = None  # every activation delivered, all with one hash
    delivered_hash: str | None = None  # the one hash its activations carried; None = none or several
    is_any_delivered: bool | None = None  # at least one activation delivered
    activations: int = 1


class WindowCount(NamedTuple):
    spawns: int  # tasks under budget_overage (one per spawn at W = 0)
    events: int
    sessions: int  # distinct non-NULL session ids among the event spawns


class FloorResult(NamedTuple):
    verdict: str
    detection: WindowCount
    confirmation: WindowCount
    baseline: WindowCount  # floor half of the provenance-covered baseline
    unjoinable: int
    pending: int  # spawns that may still be running at evaluation


class OutcomeFacts(NamedTuple):
    verified_fail_rows: int
    tool_use_actual: int | None  # None = no tool_use line recorded


class TriggeringSpawn(NamedTuple):
    """Machine facts of one triggering spawn — daemon-recorded, never agent-emitted."""

    agent_id: str
    started_at: datetime
    overage_rows: int
    attribution_sources: tuple[str, ...]
    verified_fail_rows: int
    tool_use_actual: int | None


class PatternEvidence(NamedTuple):
    floor: FloorResult
    triggering: tuple[TriggeringSpawn, ...]  # newest first


def get_pair_windows(now: datetime) -> PairWindows:
    """Windows anchored on D, the most recent UTC midnight at or before `now`.

    Raises ValueError on a naive `now` — a guessed zone shifts D by up to a day."""
    if now.utcoffset() is None:
        raise ValueError("get_pair_windows: `now` must be timezone-aware")
    end = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    detection_start = end - 2 * PAIR_WINDOW
    start = WindowStarts(
        baseline=detection_start - BASELINE.SPAN,
        detection=detection_start,
        confirmation=end - PAIR_WINDOW,
    )
    return PairWindows(start=start, end=end)


def is_new_pair(windows: PairWindows, last_transition_at: datetime) -> bool:
    """Does this pair count toward a `dormant` row's re-entry? Only when its detection
    starts at or after the row's last transition — a row stays dormant ≥ 14 days."""
    return windows.start.detection >= last_transition_at


def is_floor_half(agent_id: str) -> bool:
    """Floor half = even parity of sha256(agent_id); the reference half is the complement.

    sha256, never hash(): the builtin is salted per process (PYTHONHASHSEED)."""
    return hashlib.sha256(agent_id.encode("utf-8")).digest()[-1] % 2 == 0


def is_metric_event(spawn: SpawnFacts, metric_key: str) -> bool:
    """Is this spawn an event of `metric_key`? Daemon-recorded facts only — no
    agent-emitted outcome field (result, revision_count, …) can move it."""
    if metric_key == METRIC_BUDGET_OVERAGE:
        return spawn.overage_rows > 0
    if metric_key == METRIC_EMIT_FAILURE:
        return any(
            (row.get("attribution_source") or "") in _EMIT_FAILURE_ATTRIBUTIONS
            for row in spawn.outcomes
        )
    if metric_key == METRIC_NO_SUBAGENT_STOP:
        return not spawn.has_subagent_stop
    raise ValueError(f"is_metric_event: unknown metric key {metric_key!r}")


def is_pending(spawn: SpawnFacts, evaluated_at: datetime) -> bool:
    """May this spawn still be running? No SubagentStop yet, started within
    PENDING_GRACE before `evaluated_at`."""
    return not spawn.has_subagent_stop and spawn.started_at > evaluated_at - PENDING_GRACE


def get_tool_budget(environ: Mapping[str, str]) -> int:
    """One spawn's TOOL_USE budget as advisory-subagent-budget.sh resolves it from `environ`:
    SUBAGENT_TOOL_BUDGET when a base-10 digit string above zero, else DEFAULT_TOOL_BUDGET."""
    value = environ.get("SUBAGENT_TOOL_BUDGET", "")
    if value.isascii() and value.isdigit() and int(value, 10) > 0:
        return int(value, 10)
    return DEFAULT_TOOL_BUDGET


def get_tasks(
    spawns: Iterable[SpawnFacts], redelegation_window: timedelta
) -> list[tuple[SpawnFacts, ...]]:
    """One agent type's spawns grouped into tasks, each ordered from its first spawn.

    A spawn continues a task when it shares the parent session of the task's last member and
    starts in [that member's SubagentStop, + `redelegation_window`); of several such tasks, the
    one whose last member stopped latest. W = 0 → one task per spawn."""
    tasks: list[list[SpawnFacts]] = []
    open_tasks: defaultdict[str, list[list[SpawnFacts]]] = defaultdict(list)
    for spawn in sorted(spawns, key=lambda s: (s.started_at, s.agent_id or "")):
        candidates = open_tasks.get(spawn.session_id or "", ())
        continued = [t for t in candidates if _is_continuation(t[-1], spawn, redelegation_window)]
        if continued:
            max(continued, key=lambda t: t[-1].stopped_at).append(spawn)
            continue
        task = [spawn]
        tasks.append(task)
        if spawn.session_id is not None:
            open_tasks[spawn.session_id].append(task)
    return [tuple(task) for task in tasks]


def _is_continuation(prior: SpawnFacts, spawn: SpawnFacts, redelegation_window: timedelta) -> bool:
    return (
        prior.stopped_at is not None
        and prior.session_id == spawn.session_id
        and prior.stopped_at <= spawn.started_at < prior.stopped_at + redelegation_window
    )


def is_task_overrun(task: Sequence[SpawnFacts], tool_budget: int) -> bool:
    """Any member records an overage, or the members' combined tool_use reaches one spawn's
    budget — the 100% crossing advisory-subagent-budget.sh records as an overage; an unrecorded
    member adds nothing, so the sum is a lower bound."""
    return any(s.overage_rows > 0 for s in task) or (
        sum(s.tool_use_actual or 0 for s in task) >= tool_budget
    )


class _Unit(NamedTuple):
    members: tuple[SpawnFacts, ...]  # its task under budget_overage, else the spawn alone
    is_event: bool

    @property
    def first(self) -> SpawnFacts:  # its started_at, agent_id half and session place the unit
        return self.members[0]


class _Units(NamedTuple):
    counted: list[_Unit]
    unjoinable: int
    pending: int


def get_floor_verdict(
    spawns: Iterable[SpawnFacts],
    metric_key: str,
    windows: PairWindows,
    provenance_start: datetime | None,
    evaluated_at: datetime,
    *,
    redelegation_window: timedelta = timedelta(0),
    tool_budget: int | None = None,
) -> FloorResult:
    """Occurrence floor over windows, never over a batch.

    Pass: ≥ 5 event sessions in detection and in confirmation, confirmation rate above
    the floor-half baseline rate. `insufficient-baseline`, never a pass, while the
    provenance-covered baseline spans < 28 days or its floor half holds no spawn; a None
    `provenance_start` covers nothing. Spawns before it count nowhere. NULL-agent_id
    spawns and spawns pending at `evaluated_at` count on no side and are returned as
    `unjoinable` and `pending`.

    `budget_overage` counts complete tasks (`get_tasks` over `redelegation_window`), each in
    its first spawn's window and half; a task open at `evaluated_at` counts on no side, its
    spawns in `pending`. `emit_failure` counts spawns. A spawn outside
    [windows.start.baseline, windows.end) is a task member only. `tool_budget` None → the
    budget this process's environment resolves (`get_tool_budget`)."""
    if metric_key not in METRIC_KEYS:
        raise ValueError(f"get_floor_verdict: unknown metric key {metric_key!r}")
    units = _get_counted_units(
        list(spawns), metric_key, windows, provenance_start, evaluated_at,
        redelegation_window, tool_budget,
    )
    start = windows.end if provenance_start is None else provenance_start
    covered_start = max(windows.start.baseline, start)
    floor_half = [u for u in units.counted if is_floor_half(u.first.agent_id)]
    baseline = _get_window_count(floor_half, covered_start, windows.start.detection)
    detection = _get_window_count(
        units.counted, windows.start.detection, windows.start.confirmation
    )
    confirmation = _get_window_count(units.counted, windows.start.confirmation, windows.end)
    is_covered = windows.start.detection - covered_start >= BASELINE.MIN_COVERED
    verdict = _get_verdict(detection, confirmation, baseline, is_covered=is_covered)
    return FloorResult(
        verdict, detection, confirmation, baseline, units.unjoinable, units.pending
    )


def get_confirmation_events(
    spawns: Iterable[SpawnFacts],
    metric_key: str,
    windows: PairWindows,
    provenance_start: datetime | None,
    evaluated_at: datetime,
    *,
    redelegation_window: timedelta = timedelta(0),
    tool_budget: int | None = None,
) -> list[tuple[SpawnFacts, ...]]:
    """The events `get_floor_verdict` counts in the confirmation window, each with every
    member — a task under `budget_overage`, the spawn alone otherwise."""
    if metric_key not in METRIC_KEYS:
        raise ValueError(f"get_confirmation_events: unknown metric key {metric_key!r}")
    units = _get_counted_units(
        list(spawns), metric_key, windows, provenance_start, evaluated_at,
        redelegation_window, tool_budget,
    )
    return [
        unit.members
        for unit in units.counted
        if unit.is_event and windows.start.confirmation <= unit.first.started_at < windows.end
    ]


def _get_counted_units(
    spawns: list[SpawnFacts],
    metric_key: str,
    windows: PairWindows,
    provenance_start: datetime | None,
    evaluated_at: datetime,
    redelegation_window: timedelta,
    tool_budget: int | None,
) -> _Units:
    joinable = [s for s in spawns if s.agent_id is not None]
    if metric_key == METRIC_BUDGET_OVERAGE:
        budget = get_tool_budget(os.environ) if tool_budget is None else tool_budget
        units, pending = _get_task_units(
            joinable, windows, evaluated_at, redelegation_window, budget
        )
    else:
        units, pending = _get_spawn_units(joinable, metric_key, windows, evaluated_at)
    start = windows.end if provenance_start is None else provenance_start
    counted = [u for u in units if u.first.started_at >= start]
    unjoinable = sum(1 for s in spawns if s.agent_id is None and _is_in_windows(s, windows))
    return _Units(counted, unjoinable, pending)


def _get_task_units(
    joinable: list[SpawnFacts],
    windows: PairWindows,
    evaluated_at: datetime,
    redelegation_window: timedelta,
    tool_budget: int,
) -> tuple[list[_Unit], int]:
    tasks = [
        task
        for task in get_tasks(joinable, redelegation_window)
        if _is_in_windows(task[0], windows)
    ]
    closed = [t for t in tasks if not _is_task_open(t, evaluated_at, redelegation_window)]
    pending = sum(len(t) for t in tasks) - sum(len(t) for t in closed)
    return [_Unit(t, is_task_overrun(t, tool_budget)) for t in closed], pending


def _get_spawn_units(
    joinable: list[SpawnFacts], metric_key: str, windows: PairWindows, evaluated_at: datetime
) -> tuple[list[_Unit], int]:
    in_windows = [s for s in joinable if _is_in_windows(s, windows)]
    settled = [s for s in in_windows if not is_pending(s, evaluated_at)]
    units = [_Unit((s,), is_metric_event(s, metric_key)) for s in settled]
    return units, len(in_windows) - len(settled)


def _is_in_windows(spawn: SpawnFacts, windows: PairWindows) -> bool:
    return windows.start.baseline <= spawn.started_at < windows.end


def _is_task_open(
    task: Sequence[SpawnFacts], evaluated_at: datetime, redelegation_window: timedelta
) -> bool:
    """A member may still be running, or a continuation may still start at or after
    `evaluated_at` — before the last member's stop + W."""
    last_stop = task[-1].stopped_at
    return any(is_pending(s, evaluated_at) for s in task) or (
        last_stop is not None
        and redelegation_window > timedelta(0)
        and evaluated_at < last_stop + redelegation_window
    )


def _get_window_count(units: list[_Unit], start: datetime, end: datetime) -> WindowCount:
    in_window = [u for u in units if start <= u.first.started_at < end]
    events = [u.first for u in in_window if u.is_event]
    sessions = {s.session_id for s in events if s.session_id is not None}
    return WindowCount(len(in_window), len(events), len(sessions))


def _get_verdict(
    detection: WindowCount, confirmation: WindowCount, baseline: WindowCount, *, is_covered: bool
) -> str:
    if not is_covered or baseline.spawns == 0:
        return VERDICT_INSUFFICIENT_BASELINE
    if min(detection.sessions, confirmation.sessions) < FLOOR_MIN_SESSIONS:
        return VERDICT_FAIL
    # rates compared by cross-multiplication → exact on integer counts
    if confirmation.events * baseline.spawns > baseline.events * confirmation.spawns:
        return VERDICT_PASS
    return VERDICT_FAIL
