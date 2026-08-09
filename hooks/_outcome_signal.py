#!/usr/bin/env python3
# Pure outcome-signal rules — the SINGLE definition of the negative-signal
# predicate (learning-aggregator pattern emit + lesson-bucket routing,
# daemon_cycle staleness recompute) and of the Role → Allowed task_types
# allowlist that predicate depends on.
#
# STDLIB-ONLY BY CONTRACT, psycopg-free in particular. learning-aggregator imports
# these rules OUTSIDE the guard that degrades it when the DB driver is missing, and
# the driver-absent path is exactly where a second hand-written copy of the
# predicate used to drift. The allowlist's former home _pg_outcome_dualwrite calls
# sys.exit() at MODULE SCOPE on a missing psycopg: SystemExit derives from
# BaseException, so an `except Exception` fail-open guard around that import does
# NOT catch it and the importing process dies instead of degrading. Any import with
# a driver dependency added here re-opens that kill path.

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
# Every learning consumer keys on this ONE definition: the learning-aggregator
# pattern emit (patterns 1/5) and lesson-bucket routing, plus the daemon_cycle
# staleness recompute — so the emit condition, the EPM route and the live-window
# recompute cannot drift apart (drift = live patterns mis-skipped as stale, or a
# row routed to failure memory by one consumer and not the other). Defined over the
# row dict _pg_learning_dualwrite.read_outcomes_since returns.

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
# track-outcome.sh now sets review_flag on it for degraded-row visibility, and that
# OR-term is excluded by _is_visibility_flag_row so the count stays neutral.
# Polarity handling (NEUTRAL, never a SUCCESS exemplar) lives in daemon_cycle's
# partition, which keys on this token.
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
    what D1 suppresses and silently drops those two live signals out of both memory
    buckets."""
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
    done_with_concerns measurement gap. Its SUCCESS-side exclusion (NEUTRAL
    polarity) lives in daemon_cycle._is_success_outcome."""
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
