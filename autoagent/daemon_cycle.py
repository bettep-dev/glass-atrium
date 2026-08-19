"""AutoAgent daemon — proposal generation, classification, and pre-verify core logic.

Responsibilities:
    Generate: For each user-pending pattern in PG core.learning_log, sample related
        outcome records and ask Haiku to draft a concrete patch proposal for the
        target agent's `~/.claude/agents/<agent>.md` body.
    Classify: Sort each proposal into one of:
            - 'body-auto'           — small body-only edit (auto-apply candidate)
            - 'frontmatter-dryrun'  — touches identity fields (skills/tools/...)
            - 'reject'              — out-of-scope / unsafe / conflicting
    Pre-verify:
        Check body-auto patches against 4 axes (compliance-matrix /
        GLOBAL_RULES / scope-* / target self-consistency). Verified patches
        keep `body-auto` for auto-apply; unverified patches downgrade to a
        user-pending state that the PG emit layer routes to monitor.

This module ONLY generates and classifies. Application (write+commit) is a
downstream stage.

The bash entry point (daemon-cycle.sh) wires CLI args, then delegates everything
below to the `run_cycle()` function.

No third-party dependencies — stdlib only (subprocess, json, pathlib,
dataclasses, typing). Python 3.12+ idioms.
"""

from __future__ import annotations

import contextlib
import difflib
import io
import json
import os
import random
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, NamedTuple

# -- Constants --------------------------------------------------------------

HOME = Path(os.environ.get("HOME", str(Path.home())))
# Legacy MD learning log — NOT the intake. Pattern intake reads PG
# core.learning_log (the aggregator's UPSERT target — see
# read_user_pending_patterns); the file stays on disk untouched and the
# constant survives only for run_cycle/--log-path call compatibility.
# Intentionally kept LEGACY (~/.claude): learning-log.md was NOT part of the
# Tier-A data migration (only the data/learning/ DIR moved), and the daemon
# neither reads nor writes it — repointing would strand a stray empty file.
DEFAULT_LEARNING_LOG = HOME / ".claude" / "data" / "learning-log.md"
# agents/ is the harness agent farm, not a migrated data store — stays legacy.
DEFAULT_AGENTS_DIR = HOME / ".claude" / "agents"
# DEFAULT_OUTCOMES_DIR / DEFAULT_REPORTS_DIR now derive from the ga_paths seam —
# defined below, AFTER the hooks-dir sys.path insert that makes ga_paths importable.

# PG read source — _pg_learning_dualwrite is the single helper SoT (same import
# path + fallback policy as learning-aggregator.py). Missing psycopg →
# HAS_PG_OUTCOME_READ=False → automatic file-system fallback for outcomes;
# pattern intake has NO file fallback (PG is the intake SoT — a stale MD read
# would regenerate proposals from fossil signals) → 0 patterns + loud WARN.
_PG_HOOKS_DIR = HOME / ".claude" / "hooks"
# Repo-relative hooks dir resolved from THIS file's own location — lets
# daemon_config (+ _pg_learning_dualwrite) self-locate in a CI checkout (repo at
# $GITHUB_WORKSPACE, no ~/.claude present) regardless of $HOME / install location.
# Repo-relative is inserted last so it lands FIRST (priority); the $HOME entry is
# retained as an author-install fallback. In a ~/.claude install the two paths
# coincide → the not-in-path guard dedups them (no double entry, no behavior change).
_REPO_HOOKS_DIR = Path(__file__).resolve().parent.parent / "hooks"
for _hooks_dir in (_PG_HOOKS_DIR, _REPO_HOOKS_DIR):
    if str(_hooks_dir) not in sys.path:
        sys.path.insert(0, str(_hooks_dir))
import ga_paths  # noqa: E402 — hooks dir pinned by the loop above

# Negative-signal SoT. UNGUARDED unlike the _pg_learning_dualwrite import below:
# _outcome_signal is stdlib-only by contract (zero import statements), so it has no
# psycopg SystemExit path and writes no stderr — the silent bare-CLI-import contract
# holds without a try/except, and the predicate stays defined on the psycopg-absent path.
from _outcome_signal import (  # noqa: E402 — hooks dir pinned by the loop above
    ATTRIBUTION_STRUCTUREDOUTPUT_DERIVED,
    is_negative_signal_outcome,
    _is_synthesized_measurement_gap as _shared_is_synthesized_measurement_gap,
)

# Runtime data roots via the shared ga_paths seam (.glass-atrium default,
# GA_DATA_ROOT-overridable) — the SAME store project_key.py / learning-aggregator.py
# resolve after the .claude→.glass-atrium data migration.
# data/outcomes/ holds only the legacy `.md` fallback path — new records sink to
# core.outcomes. fetch_related_outcomes() does PG-first + file-fallback. Directory
# kept for residual `.md` + revision_count lookup (track-outcome.sh).
DEFAULT_OUTCOMES_DIR = ga_paths.get_data_root() / "outcomes"
DEFAULT_REPORTS_DIR = ga_paths.get_data_root() / "daemon-reports"
# Optional-dependency import degradation is CAPTURED here, NOT written to stderr
# at import time: a bare CLI import of this module (autoagent/lib/sensitive_patterns.py
# shells out and imports it purely to reach the compiled refusal patterns) MUST
# stay silent — the CliExitContract clean path asserts stderr == "". The PG helper
# itself writes a JSON `import_error` line to stderr AND re-raises on missing
# psycopg, so the redirect_stderr below swallows THAT import-time line too; it is
# scoped to this single import (stderr is restored on block exit — never globally
# silenced). The daemon re-surfaces the degradation LOUDLY at runtime instead
# (run_cycle() start + read_user_pending_patterns pattern-intake WARN), so a real
# daemon is never silently broken (shared-self-improve-hygiene Precondition Loud-Fail).
_PG_OUTCOME_IMPORT_EXC: Exception | None = None
try:
    with contextlib.redirect_stderr(io.StringIO()):
        from _pg_learning_dualwrite import (
            count_outcomes_since as _pg_count_outcomes_since,
            read_outcomes_since as _pg_read_outcomes_since,
            read_pending_learning_patterns as _pg_read_pending_patterns,
            reject_learning_pattern as _pg_reject_learning_pattern,
            discharge_learning_pattern as _pg_discharge_learning_pattern,
            is_negative_signal_outcome as _pg_is_negative_signal_outcome,
            DischargeResult,
            DISCHARGE_APPLIED,
            DISCHARGE_NOT_MATCHED,
            DISCHARGE_FAILED,
        )
    HAS_PG_OUTCOME_READ = True
    HAS_PG_PATTERN_READ = True
except Exception as _pg_import_exc:  # noqa: BLE001 — psycopg or helper itself
    HAS_PG_OUTCOME_READ = False
    HAS_PG_PATTERN_READ = False
    _PG_OUTCOME_IMPORT_EXC = _pg_import_exc

    # Discharge vocabulary must exist even on the degraded path — the stage
    # below names these outcomes in its report, and a NameError there would
    # convert a driver-absent environment into a crash.
    class DischargeResult(NamedTuple):  # type: ignore[no-redef]
        outcome: str
        row_id: int | None

    DISCHARGE_APPLIED = "applied"
    DISCHARGE_NOT_MATCHED = "not_matched"
    DISCHARGE_FAILED = "failed"

    def _pg_discharge_learning_pattern(pattern_id: int, reason: str) -> DischargeResult:
        return DischargeResult(DISCHARGE_FAILED, None)

# PG outcome lookback window — PG is the single sink, so 90 days yields enough
# history to sample 100+ rows per agent (cost: WHERE record_ts > now()-N index
# scan on agent_ts_idx).
PG_OUTCOME_LOOKBACK_DAYS = 90

# Loop events are a PG single sink (no JSONL append) — UPSERT core.autoagent_loop_events
# via direct module-import call into _pg_dual_write_daemon.py. Missing psycopg /
# helper import failure keeps the backward-compat subprocess fallback.
PG_DUAL_WRITE_HELPER = HOME / ".claude" / "scripts" / "_pg_dual_write_daemon.py"
# Helper-call timeout — subprocess-fallback path only (N/A for module-import path).
PG_HELPER_TIMEOUT_SEC = 10
# eval_result varchar(32) schema column-length limit.
EVAL_RESULT_MAX_LEN = 32

# Module import — same pattern as the _pg_learning_dualwrite peer. Missing psycopg /
# helper import failure → HAS_PG_LOOP_WRITE=False → automatic subprocess fallback.
_PG_SCRIPTS_DIR = HOME / ".claude" / "scripts"
# Repo-relative scripts dir — same self-location rationale as the hooks dir above.
# Lets _pg_dual_write_daemon resolve in a CI checkout (no ~/.claude) so the
# loop-event write path imports cleanly instead of emitting a loud degradation WARN
# to stderr — that WARN would otherwise break the silent-clean CLI exit-contract
# test (test_path_clean_exits_0_silent shells out to the helper, which imports this
# module). Repo-relative inserted last → priority; $HOME retained as fallback; the
# not-in-path guard dedups when the two coincide in a ~/.claude install.
_REPO_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
for _scripts_dir in (_PG_SCRIPTS_DIR, _REPO_SCRIPTS_DIR):
    if str(_scripts_dir) not in sys.path:
        sys.path.insert(0, str(_scripts_dir))
# Same optional-dependency policy as the _pg_learning_dualwrite peer above: this
# helper ALSO writes a JSON `import_error` line to stderr and re-raises on missing
# psycopg, so redirect_stderr swallows that import-time line (scoped to this one
# import — stderr restored on block exit, never globally silenced). Stay SILENT at
# import time (CLI clean-path contract); surface the degradation LOUDLY at daemon
# runtime — run_cycle() start plus the emit_loop_events path=subprocess marker
# (Precondition Loud-Fail).
_PG_LOOP_IMPORT_EXC: Exception | None = None
try:
    with contextlib.redirect_stderr(io.StringIO()):
        from _pg_dual_write_daemon import (
            _connect as _pg_connect,
            write_autoagent_loop_event as _pg_write_loop_event,
            write_autoagent_corpus_audit as _pg_write_corpus_audit,
        )
    HAS_PG_LOOP_WRITE = True
except Exception as _pg_loop_import_exc:  # noqa: BLE001 — psycopg or helper itself
    HAS_PG_LOOP_WRITE = False
    _PG_LOOP_IMPORT_EXC = _pg_loop_import_exc

# CLI binary — overridable for tests
CLAUDE_BIN = os.environ.get("AUTOAGENT_CLAUDE_BIN", "claude")

# Cost guard (per cycle) — per-AGENT cap. One cycle processes up to N agents;
# 1 agent = 1 Haiku call (multiple signals merged into a single multi-hunk diff).
# default = ALL agents (every agent with 1+ prior-day failure signal).
# Override via AUTOAGENT_AGENT_LIMIT env or --limit.
DEFAULT_PATTERN_LIMIT = int(os.environ.get("AUTOAGENT_AGENT_LIMIT", "0") or "0")
# 0 = unlimited (ALL agents). _resolve_agent_limit() maps 0/negative → unlimited sentinel.
# Per-call Haiku CLI timeout (seconds). 180 ≈ 2.1x the worst healthy generation
# (84.2s; median ~79s), so a slow-but-healthy call finishes on attempt 1 instead
# of dying at the subprocess kill. Env-overridable like the backoff/threshold vars.
HAIKU_TIMEOUT_SEC = int(os.environ.get("AUTOAGENT_HAIKU_TIMEOUT_SEC", "180") or "180")
# Timeout-class escalated retry bound — also the in-cycle discriminator ceiling:
# a call that completes here was slow generation, one that times out here is a
# true stall.
HAIKU_ESCALATED_TIMEOUT_SEC = int(
    os.environ.get("AUTOAGENT_HAIKU_ESCALATED_TIMEOUT_SEC", "300") or "300"
)
if HAIKU_ESCALATED_TIMEOUT_SEC < HAIKU_TIMEOUT_SEC:
    # An escalated bound below the base would DE-escalate the retry — clamp loudly
    # rather than absorb (the daemon must still run, so no raise).
    sys.stderr.write(
        "[daemon-cycle] WARN: AUTOAGENT_HAIKU_ESCALATED_TIMEOUT_SEC="
        f"{HAIKU_ESCALATED_TIMEOUT_SEC}s < AUTOAGENT_HAIKU_TIMEOUT_SEC="
        f"{HAIKU_TIMEOUT_SEC}s — clamping escalated to base\n"
    )
    HAIKU_ESCALATED_TIMEOUT_SEC = HAIKU_TIMEOUT_SEC
# Budget ceiling + model id read from the daemon-config.json SoT via the shared
# loader (hooks/daemon_config.py), which degrades to validated literals
# ('0.50' / the unpinned 'haiku' alias) on missing/corrupt file — NEVER raises (test
# modules import at collection time). Live-verified: 0.10 is too low (immediate
# EXIT 1); 0.50 passes (Anthropic minimum call cost ~$0.02-0.10). Cost ceiling:
# agents-per-cycle × 0.50.
from daemon_config import (  # noqa: E402 — hooks dir prepended above (repo-relative + $HOME)
    HAIKU_MAX_BUDGET_USD,
    HAIKU_MODEL,
    PRE_VERIFY_MAX_BUDGET_USD,
)

# Per-cycle agent cap sentinel — 0/negative/None → unlimited (ALL agents).
# Positive int → ceiling. cost_guard is informational only (not a gate).
UNLIMITED_AGENTS = 1_000_000

# Outcome sampling cap — bounds LLM-context-sized samples only (the posterior's
# recency sample + fetch_related_outcomes), NEVER evidence volume: the promotion
# ladder's observation_count comes from _count_outcome_signals (uncapped
# COUNT(*) over the same window), so this cap cannot starve the n>=10
# candidate floor. The GENERATION path switched to prior-day-all.
OUTCOME_SAMPLE_LIMIT = 5

# Chronic Haiku-timeout back-off (generation side) -------------------------
#
# A candidate (target_file) whose Haiku dry-run keeps timing out re-selects from
# core.learning_log EVERY cycle (read_user_pending_patterns has no memory of
# prior generation failures), burning the base+escalated timeout ladder
# (HAIKU_TIMEOUT_SEC + HAIKU_ESCALATED_TIMEOUT_SEC) + emitting an
# `error` that flips the whole cycle to 'partial'. The apply-side stale-drain
# (daemon-apply.sh mark_stale_attempt) bounds APPLY-side stale diffs, but the
# GENERATION-side chronic timeout had NO back-off at all. This threshold bounds
# it: after N CONSECUTIVE Haiku-timeouts on the SAME target_file (counted from the
# persisted core.autoagent_proposals rows), the generation path STOPS re-invoking
# Haiku for that target and instead emits a loud, observable 'snoozed' reject row
# (no Haiku spend, no `error` → no spurious 'partial'). A single non-timeout row
# (e.g. an 'ok' generation) breaks the streak and re-arms the candidate, so a
# transiently-flaky-but-occasionally-generatable target recovers on its own.
# Default 3 mirrors AUTOAGENT_STALE_DRAIN_THRESHOLD; env-overridable.
TIMEOUT_BACKOFF_THRESHOLD = int(
    os.environ.get("AUTOAGENT_TIMEOUT_BACKOFF_THRESHOLD", "3") or "3"
)
# Rationale prefix written by _invoke_haiku_cli on TimeoutExpired — the durable,
# queryable signal that a proposal row was a Haiku timeout. MUST stay in sync with
# BOTH emitters: the TimeoutExpired branch in _invoke_haiku_cli and the true-stall
# exhaustion rationale in _run_haiku_with_retry (single SoT for the timeout marker).
HAIKU_TIMEOUT_RATIONALE_PREFIX = "haiku timeout after"
# Every timeout emitter writes the ceiling it was measured against right after the
# prefix, so a stored row's own regime is recoverable from its text alone.
_RECORDED_CEILING_RE = re.compile(
    rf"^{re.escape(HAIKU_TIMEOUT_RATIONALE_PREFIX)}\s+(\d+)s"
)
# Rationale stamped on a back-off skip row (observable, grep-able). N filled in.
TIMEOUT_BACKOFF_RATIONALE_PREFIX = "chronic haiku-timeout back-off"
TIMEOUT_BACKOFF_RATIONALE_TEMPLATE = (
    TIMEOUT_BACKOFF_RATIONALE_PREFIX + ": {n} consecutive timeouts on this target "
    "(threshold {thr}) — generation snoozed to stop burning budget; recovers on "
    "the next non-timeout generation. Resolve the candidate or raise the timeout."
)
TIMEOUT_BACKOFF_PROBE_ENV = "AUTOAGENT_TIMEOUT_BACKOFF_PROBE_CYCLES"
# Self-lock guard: the documented recovery ("a non-timeout row breaks the streak")
# names an actor the closed gate suppresses, so the state is unreachable from
# inside itself. After this many CONSECUTIVE back-off cycles the gate opens for
# exactly one cycle — that probe is the missing actor. Clamped at 1: a bound below
# it probes every cycle, silently disabling the protection.
TIMEOUT_BACKOFF_PROBE_CYCLES = max(
    1, int(os.environ.get(TIMEOUT_BACKOFF_PROBE_ENV, "3") or "3")
)

# Haiku failure-class de-conflation (kill-streak root-cause fix) ------------
#
# A Haiku invocation can fail two structurally distinct ways:
#   - QUALITY reject — the model produced a genuine parsed candidate
#     (parse_mode strict/fuzzy) that the pre-verify / review side REFUSED.
#     This is real adjudication → it advances the kill streak.
#   - NON-ADJUDICATION — the candidate was never genuinely adjudicated
#     (infra non-zero exit, quota cap, local budget cap, transient overload,
#     chronic timeout, empty/error output, mechanical supersede). No quality
#     verdict was ever rendered → it MUST NOT advance the kill streak.
# consecutive_reject_count historically de-conflated ONLY supersede + timeout
# by rationale.startswith(...), so structurally-identical infra rationales
# ('haiku non-zero exit {rc}', 'haiku quota limit detected', budget/transient)
# silently advanced the streak → healthy patterns terminalized on infra nights.
# classify_failure_rationale is the SINGLE SoT mapping a persisted rationale
# string → a failure class; the same taxonomy labels the in-cycle structured
# failure_class (FIX #1) so the two cannot diverge.
FAILURE_CLASS_QUALITY = "quality"            # genuine strict/fuzzy reject → advance
FAILURE_CLASS_SKIPPED = "skipped"            # empty / error / file-missing / generic non-zero
FAILURE_CLASS_QUOTA = "quota-limit"          # external usage / quota ceiling
FAILURE_CLASS_BUDGET = "budget-too-low"      # local --max-budget-usd ceiling
FAILURE_CLASS_TRANSIENT = "transient-overload"  # Overloaded / 529 / reset blip
FAILURE_CLASS_TIMEOUT = "chronic-timeout"    # Haiku call timed out
FAILURE_CLASS_SUPERSEDE = "supersede"        # mechanical cross-day supersede
FAILURE_CLASS_AUTH = "auth-failure"          # 401/credential — expired OAuth token
# ADJUDICATING (advances the streak, like quality) but named apart from it so an
# operator can filter the pattern rows a removal refusal terminalizes: a pattern
# whose only expressible fix needs a removal the loop cannot evidence is one the
# loop should stop regenerating.
FAILURE_CLASS_REMOVAL_REFUSAL = "removal-refusal"

# Non-adjudication classes the kill streak looks PAST. A class NOT in this set
# (notably FAILURE_CLASS_QUALITY and any unrecognized rationale) advances the
# streak — default-to-advance on unknown keeps the kill mechanism armed for
# genuine quality rejects; only a POSITIVELY-matched infra signature is skipped.
_NON_ADJUDICATION_CLASSES = frozenset(
    {
        FAILURE_CLASS_SKIPPED,
        FAILURE_CLASS_QUOTA,
        FAILURE_CLASS_BUDGET,
        FAILURE_CLASS_TRANSIENT,
        FAILURE_CLASS_TIMEOUT,
        FAILURE_CLASS_SUPERSEDE,
        # Auth/401 is INFRA — the kill streak must look PAST it so a credential
        # outage never advances the reject streak (fossilizing healthy agents
        # like dev-shell / dev-front on a credential-expired night).
        FAILURE_CLASS_AUTH,
    }
)
# FAILURE_CLASS_REMOVAL_REFUSAL is deliberately ABSENT from the set above — the
# refusal is evidence-based adjudication, so the streak must advance on it.

# Rationale prefix stamped on a proposal the add-only rebuild sites refused
# because its diff carried removed lines. Load-bearing: classify_failure_rationale
# prefix-matches this literal to separate a refusal row from a quality reject.
REMOVAL_REFUSAL_REASON_PREFIX = "removal-preserving refusal"

# Per-call Haiku failure logs — one NON-overwritten file per (date, agent,
# attempt) so the NEXT 04:30 failure carries the full untruncated streams that
# the raw_response[:400] collapse currently destroys.
HAIKU_FAILURE_LOG_DIR = ga_paths.get_log_root() / "autoagent-haiku-failures"
# Bounded FAIL-OPEN reachability probe budget (LLM10 / Loud-Fail): a probe error
# must never fail or block the cycle.
HAIKU_PROBE_HOST = "api.anthropic.com"
HAIKU_PROBE_PORT = 443
HAIKU_PROBE_TIMEOUT_SEC = 2.0

# Cycle-level all-reject alert ----------------------------------------------
#
# N CONSECUTIVE cycles in which EVERY proposal was rejected means the generation
# pipeline yields nothing actionable — a systemic gate regression, not N
# independent quality rejects (the R1 containment break presented exactly this
# way: a layout change silently rejected 100% of proposals every cycle).
# run_cycle counts the CURRENT in-memory cycle plus the leading run of persisted
# all-reject cycle_dates; any cycle with >=1 non-rejected proposal breaks the
# streak. Default 3 mirrors TIMEOUT_BACKOFF_THRESHOLD; env-overridable.
ALL_REJECT_ALERT_THRESHOLD = int(
    os.environ.get("AUTOAGENT_ALL_REJECT_ALERT_THRESHOLD", "3") or "3"
)
# eval_result stamped on the alert loop event (grep-able, monitor-surfaced).
ALL_REJECT_ALERT_EVAL_RESULT = "all-reject-alert"

# Post-apply regression watch (C1, DETECTION-ONLY) --------------------------
#
# Next-cycle step beside is_systemic_regression: per APPLIED proposal, the
# target agent's post-apply soft-negative outcome rate is compared to the
# pre-apply rate (both windows share the learning-signal exclusion scope of
# the PG helper — attribution failures + poisoned_window excluded).
# Degradation → ONE WARN loop event naming the proposal id + its agents-bak
# before-image path. NO auto-revert / agent-file write / safety-queue insert —
# a weeks-latency revert would clobber intervening user edits, and the safety
# queue is reserved for irreversible external-effect triggers.
POST_APPLY_REGRESSION_EVAL_RESULT = "post-apply-regression"

# Days-since-last-applied corroborating crit (FIX #4) -----------------------
#
# Secondary signal CONJOINED with the all-reject-streak leg: a slow-bleed
# regression where occasional non-rejected-but-never-applied rows keep resetting
# the all-reject streak yet nothing ever lands. Widens detection without firing
# alone — it is AND-gated behind "this cycle ingested input and all of it
# rejected", so a legitimately quiet (patches=[]) night never trips it.
# Default 14 days; env-overridable.
DAYS_SINCE_APPLIED_CRIT_THRESHOLD = int(
    os.environ.get("AUTOAGENT_DAYS_SINCE_APPLIED_THRESHOLD", "14") or "14"
)
# Named non-clean _main exit code for a systemic zero-output regression. The
# launchd wrapper (daemon-cycle.sh) folds any non-zero rc into a DEGRADED run,
# so this stops an unattended regression reporting clean exit 0.
CYCLE_REGRESSION_EXIT_CODE = 6
# Named non-clean _main exit code for a PG failure during the auth-mislabel
# backfill (P2c). Loud-fail per shared-self-improve-hygiene: a backfill PG error
# surfaces a distinct code (NOT silent absorption) so the operator/monitor can
# tell a backfill DB fault apart from a generation regression.
BACKFILL_PG_EXIT_CODE = 7

# Intra-cycle Haiku spacing (FIX #5) ----------------------------------------
#
# Bounded inter-call sleep between per-agent Haiku calls in the run_cycle loop
# so the cycle does not self-contend its shared OAuth/usage window. Applied only
# after a real call (not skip_haiku / not back-off). Small enough never to
# materially lengthen a healthy cycle; env-overridable / 0 disables.
INTER_CALL_SPACING_SEC = float(
    os.environ.get("AUTOAGENT_INTER_CALL_SPACING_SEC", "2.0") or "2.0"
)

# Generation-side pattern lifecycle (anti-fossil) ---------------------------
#
# Two intake gates stop a core.learning_log pattern from regenerating proposals
# forever once the live evidence stopped supporting it:
#   1) reject-streak snooze — N CONSECUTIVE genuinely-rejected proposals for the
#      same pattern+agent transition the learning_log row to terminal 'rejected'
#      ("LearningStatus" has no 'snoozed' value; a re-arm must first clear or
#      scope that reject evidence — a bare status reset re-derives the streak
#      and re-parks in the same cycle, see REJECT_STREAK_REASON_TEMPLATE).
#   2) staleness skip — the pattern's rate recomputed from a rolling LIVE
#      outcomes window (poisoned_window rows excluded inside read_outcomes_since)
#      no longer meets the aggregator's emit threshold → skip this cycle only
#      (transient: the pattern re-arms by itself when the live rate returns).
# Default 3 mirrors TIMEOUT_BACKOFF_THRESHOLD; env-overridable.
REJECT_STREAK_THRESHOLD = int(
    os.environ.get("AUTOAGENT_REJECT_STREAK_THRESHOLD", "3") or "3"
)
# last_transition_reason stamped on a reject-streak snooze (grep-able audit trail).
# Structurally the repeat-apply cap, and its tail is sized the same way (see
# APPLY_CAP_REASON_TEMPLATE below): consecutive_reject_count is recomputed each
# cycle from the same _fetch_proposal_history rows, and the streak breaks ONLY on
# a covering 'applied'/'approved' row — which a parked pattern can never produce,
# because intake selects 'identified' only and a rejected row proposes nothing.
# So the streak is frozen and a manual status reset re-derives it and re-parks in
# the same cycle. The "re-arms by itself when the live rate returns" clause in the
# block comment above belongs to gate (2) staleness skip, NOT to this gate.
REJECT_STREAK_REASON_TEMPLATE = (
    "reject-streak snooze: {n} consecutive rejected proposals (threshold {thr}) "
    "— NOT self re-arming: a status reset to 'identified' does not re-arm it — "
    "the streak is recomputed each cycle from this agent's proposal history and "
    "breaks only on a covering applied/approved row, which a parked pattern can "
    "never produce, so the row re-parks next run, overwriting its park time and "
    "reason. A real re-arm must first clear or scope that reject evidence; until "
    "then leave the status alone."
)
# last_transition_reason stamped on a non-auto-fixable (out-of-region MODIFY)
# terminalization (RC3). The add-only synthesis pipeline can never express a
# removal, so a proposal that MODIFIES a line outside every editable region is
# rejected by the landing-zone guard EVERY cycle — re-deriving it is wasted work
# and the generator re-selects it forever. Terminalize so intake stops selecting
# it; re-arm only after the target is wrapped in an EDITABLE region.
NON_AUTO_FIXABLE_REASON = (
    "non-auto-fixable: proposal modifies a line OUTSIDE every editable region "
    "(structural — add-only synthesis cannot express the removal) — re-arm by "
    "wrapping the target in an EDITABLE region then resetting status to 'identified'"
)
# last_transition_reason stamped on a reverted-pattern snooze: a human/CLI
# back-out of an APPLIED proposal (status 'reverted') is the strongest terminal
# verdict — regenerating from the same pattern would re-propose the exact
# change a human just backed out.
# Same tail correction and the same sizing discipline as APPLY_CAP_REASON_TEMPLATE
# below: the head is fixed here (no substitution), so the budget is simply
# LEARNING_LOG_REASON_MAX minus its length. Pinned by test_reason_tail_budget.py.
REVERTED_SNOOZE_REASON = (
    "reverted snooze: a covering applied proposal was reverted (human/CLI "
    "back-out) — pattern excluded from re-application; NOT self re-arming: a "
    "status reset to 'identified' does not re-arm it — the snooze is re-derived "
    "each cycle from the reverted proposal rows in the same history window, so "
    "the row re-parks next run, overwriting its park time and reason. A real "
    "re-arm must first clear or scope that reverted-apply evidence; until then "
    "leave the status alone."
)
# Repeat-apply cap. Non-redundant with the reject-streak gate precisely because
# an 'applied' row RESETS that streak (consecutive_reject_count breaks on it), so
# an apply/reject alternation regenerates forever and every apply stacks another
# prose rule onto the same LIVE agent body — the observed fossil landed four
# budget thresholds on one agent where the 65% rule makes the 70%/80% rules
# structurally unreachable. The harm is ACCUMULATION of contradictory rules, not
# proposal rate, so this is a hard cap (no self re-arm) rather than a cooldown:
# a rate limiter would leave the accumulation path open.
# Default 3 mirrors REJECT_STREAK_THRESHOLD / ALL_REJECT_ALERT_THRESHOLD, and
# stays well inside _fetch_proposal_history's LIMIT 50 window (~45 days at the
# observed per-agent proposal rate) so the cap cannot silently un-arm as older
# applies scroll off — a materially larger cap would forfeit that guarantee.
APPLY_CAP_THRESHOLD = int(os.environ.get("AUTOAGENT_APPLY_CAP_THRESHOLD", "3") or "3")
# last_transition_reason stamped on a repeat-apply cap. The wording is
# load-bearing: terminal 'rejected' means STOP PROPOSING and NOTHING else. The
# targeted signal is still live (the overage counters keep recording it), so this
# row is an OPEN item awaiting a human design decision. Never restate this
# transition as resolved / fixed / closed, and never route it through the
# applied-discharge path — that would claim a resolution the evidence refutes.
# The tail is sized, not transcribed: everything through "another patch — " is
# the head the monitor's parked count and the lifecycle test key on, and the
# write path silently slices the whole reason to LEARNING_LOG_REASON_MAX, so the
# tail's budget is that ceiling minus the WIDEST formatted head (the {n}/{thr}
# substitution moves it). test_reason_tail_budget.py derives both sides and
# fails if a future edit outgrows the budget.
APPLY_CAP_REASON_TEMPLATE = (
    "repeat-apply cap: {n} applied proposals (cap {thr}) did NOT abate the "
    "signal — STOP PROPOSING; the underlying problem is UNRESOLVED and needs a "
    "human design decision, not another patch — NOT self re-arming: a status "
    "reset to 'identified' does not re-arm it — the cap is recomputed each "
    "cycle from this agent's applied-proposal history, so the row re-parks next "
    "run, overwriting its park time and reason. A real re-arm must first clear "
    "or scope that apply evidence; until then leave the status alone."
)
# Rolling live-rate window. 14d = 2× the 7-day promotion sustain window — long
# enough to smooth weekday gaps, short enough that a stale failure burst decays.
STALE_WINDOW_DAYS = int(os.environ.get("AUTOAGENT_STALE_WINDOW_DAYS", "14") or "14")
# Live-rate floors MIRROR the learning-aggregator.py emit conditions (pattern 1:
# negative-signal count >= 3 · pattern 5: total >= 3 AND negative/total >= 0.5).
# The OR-term predicate itself is IMPORTED (is_negative_signal_outcome), so the
# emit and the recompute cannot drift on signal definition; only these floors
# can drift, and a LOOSER floor fails open (status-quo regeneration) while a
# TIGHTER one suppresses live patterns — keep them <= the aggregator's
# AUTO_FAILURE_THRESHOLD / RATE_MIN_SAMPLE / RATE_FAILURE_FLOOR.
STALE_MIN_LIVE_TRIGGERS = 3
STALE_MIN_SAMPLE = 3
STALE_FAILURE_RATE_FLOOR = 0.5
# Mirrors learning-aggregator.py _NUMERIC_RE (pattern-signature normalization).
# The proposal-history match must strip the SAME volatile numerics the aggregator
# strips when computing pattern_signature, or legacy numeric proposal labels
# ("failure rate 62%") never match their stripped signature ("failure rate "). Keep in sync;
# drift fails OPEN (missed match → no snooze).
_PATTERN_NUMERIC_RE = re.compile(
    r"\d[\d.]*%?|\d{4}-\d{2}-\d{2}|avg [\d.]+|score \d+|\d+/\d+"
)
# Pattern-1 FAIL literals — the stable pattern_signature core (G2: never remapped).
# Defined here as the single in-file source of truth so _FAIL_COUNT_LABEL_PREFIXES
# references them directly; the SOFT display labels + full decouple rationale follow
# below (kept in sync with PATTERN1_FAIL_LABEL / PATTERN1_SOFT_LABEL in
# learning-aggregator.py, which daemon_cycle.py does not import).
PATTERN1_FAIL_LABEL_EN = "repeated failure by same agent"
PATTERN1_FAIL_LABEL_KO = "동일 에이전트 반복 실패"
# Label families the staleness recompute understands — current English emit +
# the legacy Korean rows still live in core.learning_log. Unknown families are
# never skipped (fail-open). Labels were deliberately kept verbatim through the
# AP-3 multi-signal re-key (pattern_signature stability), so these prefixes
# match both pre- and post-re-key rows.
_FAIL_COUNT_LABEL_PREFIXES = (
    PATTERN1_FAIL_LABEL_EN,
    PATTERN1_FAIL_LABEL_KO,
)
_FAIL_RATE_LABEL_PREFIXES = (
    "agent instruction-improvement candidate",
    "에이전트 지침 개선 후보",
)

# Pattern-1 DISPLAY label decouple (mirror of learning-aggregator.py P3a). The
# title "repeated failure by same agent" / "동일 에이전트 반복 실패" is a FACTUAL
# MISLABEL under the fleet-wide result=fail=0 regime: the trigger is keyed on a SOFT
# negative-signal OR-superset (review_flag / done_with_concerns / blocked /
# revision_count>=2), NOT result=fail. The displayed/persisted pattern_label is
# remapped to the accurate SOFT label, while the pattern_signature CORE stays the
# FAIL literal so _FAIL_COUNT_LABEL_PREFIXES startswith-matching + the accumulated
# core.learning_log rows survive (G2 — NO signature/prefix rename here).
#
# daemon_cycle.py does NOT import learning-aggregator.py, so the literals are copied
# verbatim (keep in sync with PATTERN1_FAIL_LABEL / PATTERN1_SOFT_LABEL there).
#
# The remap is UNCONDITIONAL (always SOFT), valid ONLY under the fail=0 invariant —
# has_actual_fail is unpersisted, so it cannot be recomputed at display time without
# re-reading live outcomes (that would be R3, rejected for window-SoT drift). The R2
# trigger (persist a soft/hard marker keyed on the first genuine result=fail
# pattern-1) is documented but NOT built — premature for a signal that has never
# once fired (0 result=fail across 4160 outcomes).
PATTERN1_SOFT_LABEL_EN = "recurring negative-signal concentration"
PATTERN1_SOFT_LABEL_KO = "반복적 부정 신호 집중"
# Forward DISPLAY map (FAIL literal → SOFT literal): applied to the persisted
# proposal pattern_label only. Inverse CANON map (SOFT literal → FAIL literal):
# applied to BOTH sides of _covers_pattern_label so the FAIL-anchored intake label
# (reconstructed from the stable signature, never remapped per G2) still covers the
# remapped SOFT stored proposal_label. Both maps key on the stable FAIL literals.
_DISPLAY_SOFT_MAP: dict[str, str] = {
    PATTERN1_FAIL_LABEL_EN: PATTERN1_SOFT_LABEL_EN,
    PATTERN1_FAIL_LABEL_KO: PATTERN1_SOFT_LABEL_KO,
}
_COVERS_CANON_MAP: dict[str, str] = {soft: fail for fail, soft in _DISPLAY_SOFT_MAP.items()}


def _apply_label_map(label: str, mapping: dict[str, str]) -> str:
    """Apply a literal-substring substitution map to ``label``.

    ``str.replace`` is already a no-op when the source literal is absent, so no
    pre-membership guard is needed (the guard would be dead code).
    """
    for src, dst in mapping.items():
        label = label.replace(src, dst)
    return label


def _remap_display_label(label: str) -> str:
    """Remap the pattern-1 FAIL display literal (EN+KO) to the accurate SOFT label
    in a persisted/displayed proposal label.

    Substring replace (the label may be the bare literal OR embedded in a
    multi-signal ``... (a / b)`` join). The pattern_signature core is untouched —
    the intake-side Pattern.label (signature-derived) stays FAIL (G2), so the
    anti-fossil gates keep matching on the stable prefix.
    """
    return _apply_label_map(label, _DISPLAY_SOFT_MAP)


def _canon_cover_label(label: str) -> str:
    """Canonicalize a label to its FAIL signature core (SOFT→FAIL substring replace)
    before coverage containment.

    Without this, after the display remap (T1/T2) + the data relabel (T3) the
    FAIL-anchored intake label no longer covers the now-SOFT stored proposal_label,
    so the reject-streak / non-auto-fixable gates stop terminalizing pattern-1 rows
    → systemic re-emit. Keyed on the stable FAIL literals (G2-compliant).
    """
    return _apply_label_map(label, _COVERS_CANON_MAP)

# Classification thresholds
BODY_AUTO_LINE_LIMIT = 5

# Frontmatter identity fields — touching any of these forces dry-run.
FRONTMATTER_IDENTITY_FIELDS = frozenset(
    {"name", "description", "tools", "skills", "scope", "model", "maxTurns"}
)

Classification = Literal["body-auto", "frontmatter-dryrun", "reject"]

# 2-tier approval (auto/safety). 'safety' fires only on irreversible/external
# effects per core-security.md "High-impact actions"; quality issues are
# auto-rejected (the impl-retry absorbs the recoverable subset upstream).

ApprovalTier = Literal["auto", "safety", ""]

# Sensitive target-path patterns (filename basenames / suffix matches).
# Match against `Path(target_file).name` AND any parent component to catch
# absolute paths like ~/Library/LaunchAgents/com.claude.monitor.plist.
# Rationale per core-security.md "High-impact actions" + orchestrator-role.md
# "Self-Improvement User-Approval Trigger":
#   - GLOBAL_RULES / scope-security.md: absolute-rule weakening
#   - core-security.md: the cross-cutting security rules — absolute-rule
#     weakening on the real manifest row (rules/glass-atrium/core-security.md)
#   - core-learning-log.md: home of the Tier-2 trigger clause list itself, so a
#     proposal rewriting the definition of Tier-2 cannot route as Tier-1 auto
#   - .env: credential file (LLM02 Sensitive Information)
#   - com.claude.*.plist / com.glass-atrium.*.plist: launchctl bootstrap
#     surface (TCC / agent loop) — this project's live LaunchAgents are named
#     com.glass-atrium.* (autoagent-daemon, monitor, daemon-daily-restart, ...)
_SAFETY_SENSITIVE_PATH_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(^|/)GLASS_ATRIUM_GLOBAL_RULES\.md$"),
    re.compile(r"(^|/)core-security\.md$"),
    re.compile(r"(^|/)scope-security\.md$"),
    re.compile(r"(^|/)core-learning-log\.md$"),
    re.compile(r"(^|/)\.env(\.|$)"),
    re.compile(r"(^|/)com\.claude\.[^/]+\.plist$"),
    re.compile(r"(^|/)com\.glass-atrium\.[^/]+\.plist$"),
)

# Sync-path exemptions — EXACT normalized manifest relpaths, never a regex. The
# updater's changed-file partition normalizes with update_normalize_relpath
# (which resolves `.`/`..` and fail-closes on anything it cannot normalize)
# before shelling out, so an exact set cannot over-match the way the tuple's own
# `core-security.md` pattern does.
#
# NARROW by design — this is the ONLY entry, and every other sensitive path stays
# refused on every consumer. The charter is exempted because it is the one
# sensitive row NO deploy path can reach: the updater is the sole live write
# seam, its partition refuses the charter, and ga-doctor advertises that same
# updater as the remedy for the drift the refusal causes — a warning the operator
# cannot clear. Weighed against that, the charter's own refusal buys little: it
# is vendor-owned prose with no EDITABLE region and no live-only frontmatter pin.
#
# The SYMLINK row (rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md -> the entry
# below) is DELIBERATELY absent: the spine stages with a dereferencing `cp -p`
# and commits by rename, so routing the link through the byte-swap would replace
# it with a regular file and let the two manifest rows drift apart. Syncing the
# real file alone clears BOTH rows, because the link resolves through it.
_SYNC_EXEMPT_RELPATHS: frozenset[str] = frozenset(
    {
        "agents/GLASS_ATRIUM_GLOBAL_RULES.md",
    }
)

# Sensitive diff-body patterns (word-boundary regex — avoid `farm`/`confirm`
# false positives that triggered the original 3-tier user-queue inflation).
# Per core-security.md High-impact actions (file deletion / external network /
# git push / chmod / TCC / launchctl daemon lifecycle) + dev-db DROP TABLE.
_SAFETY_SENSITIVE_DIFF_PATTERNS: tuple[re.Pattern[str], ...] = (
    # File deletion — rm plus a short-flag cluster of only r/R/f/F
    # a mixed cluster (`-rfv`, `-fq`) is an accepted gap the trailing `\b` denies
    # Residual: the Tier-2 clause line in core-learning-log.md fires here — its
    # own flag spelling precedes the DB row that also matches that same line
    re.compile(r"\brm\s+-[rRfF]+\b"),
    # Permission / ACL changes
    re.compile(r"\bchmod\b"),
    re.compile(r"\bchown\b"),
    # macOS TCC reset
    re.compile(r"\btccutil\b"),
    # launchctl daemon lifecycle — modern verbs + still-functional legacy load/unload
    re.compile(r"\blaunchctl\s+(bootstrap|bootout|kickstart|load|unload)\b"),
    # git force-push — force flag anywhere later on a `git push` line; the `.*`
    # spans the line, so a chained line's unrelated force flag fires too
    # pair kept split so the loud WARN still names the matched flag
    # bundled short-flag cluster (`-fq`) = accepted gap, the trailing `\b` denies it
    # Residual: two non-fixture rule-prose lines fire here (git-workflow, learning-log)
    # Pre-existing: the flag-adjacent form these rows widened fired on both too
    # Reachable route targets agents/<name>.md, so the path axis reads that path
    # → no rules-file path pattern backstops those fires; the diff axis routes them
    re.compile(r"\bgit\s+push\b.*\s--force\b"),
    re.compile(r"\bgit\s+push\b.*\s-f\b"),
    # DB drop
    re.compile(r"\bDROP\s+TABLE\b", re.IGNORECASE),
    re.compile(r"\bDROP\s+DATABASE\b", re.IGNORECASE),
    # Dynamic-execution constructs (LLM05 Improper Output Handling)
    re.compile(r"\beval\s*\("),
    # Optional `Sync` group → the bare and execSync call forms both fire
    # Fail-closed cost, accepted: a live dev-nestjs guardrail bullet mentions it
    # → a proposal re-adding that bullet routes to safety
    # Cleaning that live copy is an operator follow-up, outside this branch
    # execFile / execFileSync stay uncovered — named as a limit, not a claim
    re.compile(r"\bexec(?:Sync)?\s*\("),
    # Inherited-tree baseline hazards (a body recipe prescribing a raw working-
    # tree reset). A bare `git stash` (incl. `git stash && ...`) discards the
    # tree onto a shared, session-crossing stash stack with no restore guarantee;
    # `git stash pop` compounds it (silently drops the entry on a conflict). The
    # negative lookahead keeps the SAFE tagged-stash recipe — `git stash push` /
    # `apply` / `list` — clean, and defers the destructive `clear` / `drop`
    # subcommands to their own pattern below (so each is a live, distinct match).
    re.compile(r"\bgit\s+stash\b(?!\s+(?:push|apply|list|clear|drop))"),
    # `git stash clear` wipes ALL stashes; `git stash drop [stash@{N}]` deletes
    # one — both irreversible.
    re.compile(r"\bgit\s+stash\s+(?:clear|drop)\b"),
    # `git reset --hard` discards uncommitted work + moves HEAD irreversibly.
    re.compile(r"\bgit\s+reset\s+--hard\b"),
    # `git checkout .` / `git checkout -- .` (bare-dot pathspec, optional `--`
    # separator) discard ALL unstaged tree changes. Bare-dot only: a single-path
    # checkout (`git checkout .gitignore` / `-- .gitignore` / `./src`) and a
    # branch checkout (`git checkout feature`) stay clean.
    re.compile(r"\bgit\s+checkout\s+(?:--\s+)?\.(?=\s|$)"),
    # `git restore .` / `git restore --worktree .` are the modern equivalent of
    # `git checkout .` — both discard ALL working-tree changes. Bare-dot only: a
    # specific-file restore (`git restore path/to/file.ts`) and a `--staged`-only
    # unstage (`git restore --staged .`, working tree preserved) stay clean.
    re.compile(r"\bgit\s+restore\s+(?:--worktree\s+)?\.(?=\s|$)"),
    # `git clean -f` / `--force` (force flag in any short-flag cluster) deletes
    # untracked files irreversibly; a dry-run (`-n`, no `f`) stays clean.
    re.compile(r"\bgit\s+clean\s+(?:-\S+\s+)*(?:-[a-zA-Z]*f|--force\b)"),
    # Published-history rewrite → backs the Tier-2 clause "rebase published branch"
    # Fires on the plain `git-rebase` spelling: bare operand, `-i`, `--onto`
    # Fail-closed over-escalation: `--abort` / `--continue` / `--skip` fire too
    # A `rebase-<suffix>` token fires as well — a hyphen satisfies the trailing `\b`
    # Accepted gaps: the `-c` / `-C` prefixed and aliased spellings split the pair
    # Residual: the clause text stays narrower — "published" is not regex-decidable
    re.compile(r"\bgit\s+rebase\b"),
)


# -- shared sensitive-match primitives (single compiled source) -------------
# These two pure functions are the ONE matching implementation over the
# compiled tuples above. classify_safety_tier (the daemon path) calls them, and
# the update skill's python helper (lib/sensitive_patterns.py) imports them, so
# the daemon and the shell updater refuse the SAME path/diff set with zero regex
# re-implementation (T15 / gate G7 — a shell-ERE data file is forbidden).


def match_sensitive_path(path: str) -> str | None:
    """Return the source of the first sensitive-path pattern matching ``path``,
    else ``None``. Matches ``Path(target_file).name`` AND any parent component
    (the patterns are ``(^|/)...`` anchored) so absolute paths like
    ``~/Library/LaunchAgents/com.claude.monitor.plist`` are caught.
    """
    for pat in _SAFETY_SENSITIVE_PATH_PATTERNS:
        if pat.search(path or ""):
            return pat.pattern
    return None


def match_sensitive_path_for_sync(path: str) -> str | None:
    """``match_sensitive_path`` minus the ``_SYNC_EXEMPT_RELPATHS`` carve-out —
    the matcher for ONE consumer: the updater's CHANGED-FILE partition
    (``update_partition_sensitive_sync``, reached from the preview and apply
    stages of scripts/update.sh via lib/sensitive_patterns.py's ``path-sync``
    mode).

    Every OTHER consumer keeps calling the bare ``match_sensitive_path`` and so
    stays strict on the exempt set:
      * the updater's VENDOR-REMOVAL sweep — a vendor-dropped harness file is
        reported, never auto-Trashed, so its partition must not be relaxed;
      * ``classify_safety_tier`` — the daemon's 2-tier approval routing;
      * ``editable_merge.build_merge_candidate`` — the agent-body merge refusal,
        which imports the bare matcher directly and never traverses this path.

    The exemption is keyed on an EXACT normalized relpath, so a spelling the
    caller could not normalize never reaches a match (the shell fails closed
    upstream) and no near-miss basename is silently swept in.
    """
    if (path or "") in _SYNC_EXEMPT_RELPATHS:
        return None
    return match_sensitive_path(path)


def match_sensitive_diff(diff: str) -> str | None:
    """Return the source of the first sensitive-diff pattern matching an ADDED
    line of ``diff``, else ``None``. Only ``+``-prefixed lines are inspected
    (excluding the ``+++`` file header) — context lines are current file state,
    not the patch's introduction.
    """
    for line in (diff or "").splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        body = line[1:]  # strip leading '+'
        for pat in _SAFETY_SENSITIVE_DIFF_PATTERNS:
            if pat.search(body):
                return pat.pattern
    return None


# -- pre-verify config ------------------------------------------------------

# Verification budget per patch — the verifier prompt is small (≤4KB) and the
# rule excerpts are also bounded, so $0.02 is a generous cap (Haiku 4.5 input
# at ~$1/MTok + output ~$5/MTok → typical call ≈ $0.005).
# PRE_VERIFY_MAX_BUDGET_USD is imported from the daemon-config.json SoT (unified
# at 0.50, same as HAIKU — lower caps cause systematic 5/5 reject).
PRE_VERIFY_TIMEOUT_SEC = 90

# AD-9 evaluator independence (GOAL precedent from CALM self-preference; the CALM
# mapping is inferred, not code-verified — mechanism independently designed here): the
# patch generator runs on HAIKU_MODEL; an evaluator systematically favors output from
# its own model class, so the verifier SHOULD run on a different class where
# feasible. AUTOAGENT_PRE_VERIFY_MODEL overrides the verifier model id; when
# absent it defaults to HAIKU_MODEL (same class as the author) and the run
# proceeds under a loud advisory — never blocking (ADVISORY-FIRST rollout).
PRE_VERIFY_MODEL = os.environ.get("AUTOAGENT_PRE_VERIFY_MODEL", "").strip() or HAIKU_MODEL

# Compliance source files — the verifier reads excerpts and must check
# the patch against all 4 axes independently.
DEFAULT_RULES_DIR = HOME / ".claude" / "rules" / "glass-atrium"
COMPLIANCE_MATRIX_FILE = DEFAULT_RULES_DIR / "core-compliance-matrix.md"
GLOBAL_RULES_FILE = HOME / ".claude" / "agents" / "GLASS_ATRIUM_GLOBAL_RULES.md"

# The compliance axis key set — exactly these four. Any other key in a
# pre_verify_axes payload is a non-compliance passenger (see
# PROSE_ONLY_ADD_AXIS_KEY) and MUST NOT reach the failed-axis renderer, which
# feeds its output back to the generator as "axes you failed".
COMPLIANCE_AXIS_KEYS = ("C1", "C2", "C3", "C4")

# Non-compliance passenger sharing the pre_verify_axes payload: the per-proposal
# prose-only-add verdict (detection-only, never a gate). Absent ≠ false — the key
# is written only when a diff existed to classify, so a reader treats absence as
# UNCLASSIFIED. The verdict inherits the classifier's DIFF_EXCERPT_CHAR_CAP
# truncation sensitivity: removals past the cut read as prose-only-add.
PROSE_ONLY_ADD_AXIS_KEY = "prose_only_add"

# Runaway bounds for the verifier prompt's rule/target excerpts — NOT content
# caps. The excerpts are composed of WHOLE heading blocks, so a bound below the
# corpus size blinds the verifier to every block past it (the canonical Turn
# Budget section of GLOBAL_RULES.md sits well past 6000 chars). Sized above the
# generator-view headroom floor — twice the 51,401-char maximum
# first-editable-region-to-end span over the registry agent corpus — so no live
# body reaches it.
RULE_EXCERPT_CHAR_CAP = 120_000
TARGET_AGENT_EXCERPT_CHAR_CAP = 120_000
DIFF_EXCERPT_CHAR_CAP = 4000

# Optimizer-side memory (SkillOpt R2): the consolidated generation prompt
# prepends this agent's recent pre_verify-FAILED diff shapes so the generator
# learns to avoid known-bad patterns. HARD char cap (mirrors the 6000-char
# excerpt caps above) keeps the prepended block from pushing prompt cost past
# PRE_VERIFY_MAX_BUDGET_USD — truncation is loud, never advisory.
PRE_VERIFY_FAILURES_CHAR_CAP = 4000
PRE_VERIFY_FAILURES_LIMIT = 8

# The other half of that memory: what this agent successfully LANDED. Without it
# the generator recalls only a slice of its failures and nothing of its
# successes, and re-proposes what is already in the body. Same HARD cap
# discipline as the failure block — the two share one prompt's budget.
LANDED_HISTORY_CHAR_CAP = 4000
LANDED_HISTORY_LIMIT = 5
LANDED_HISTORY_ENTRY_CHAR_CAP = 400

# Agent → scope mapping (from core-compliance-matrix.md Scope Legend).
# Used to pick the correct scope-*.md file for axis C3.
_AGENT_SCOPE_MAP: dict[str, str] = {
    # DEV scope
    "glass-atrium-dev-front": "scope-dev.md",
    "glass-atrium-dev-react": "scope-dev.md",
    "glass-atrium-dev-angular": "scope-dev.md",
    "glass-atrium-dev-gsap": "scope-dev.md",
    "glass-atrium-dev-android": "scope-dev.md",
    "glass-atrium-dev-nestjs": "scope-dev.md",
    "glass-atrium-dev-node": "scope-dev.md",
    "glass-atrium-dev-python": "scope-dev.md",
    "glass-atrium-dev-db": "scope-dev.md",
    "glass-atrium-dev-rag": "scope-dev.md",
    "glass-atrium-dev-animator": "scope-dev.md",
    "glass-atrium-dev-shell": "scope-dev.md",
    "glass-atrium-dev-swift": "scope-dev.md",
    # META scope
    "glass-atrium-meta-prompt-engineer": "scope-meta.md",
    "glass-atrium-meta-agent": "scope-meta.md",
    # DESIGN scope
    "glass-atrium-design-designer": "scope-design.md",
    # RESEARCH / PLANNING / REPORT
    "glass-atrium-intel-researcher": "scope-research.md",
    "glass-atrium-intel-planner": "scope-planning.md",
    "glass-atrium-intel-reporter": "scope-report.md",
    # QA scope
    "glass-atrium-qa-code-reviewer": "scope-qa.md",
    "glass-atrium-qa-debugger": "scope-qa.md",
    # SECURITY / WIKI
    "glass-atrium-sec-guard": "scope-security.md",
    "glass-atrium-wiki-curator": "scope-wiki.md",
}


# Named signal for an unresolvable C3 scope file, carried on BOTH the stderr
# channel and the prompt body. A neutral "(file not available)" excerpt reads to
# the verifier as an axis it inspected and cleared, so the miss needs a name the
# log side and the verifier can each key on (Precondition Loud-Fail).
SCOPE_UNRESOLVED_SIGNAL = "SCOPE-FILE-UNRESOLVED"


def _get_scoped_dir() -> Path:
    """Resolve the live scope-*.md store (``<base>/scoped``).

    Distinct from DEFAULT_RULES_DIR, which carries the core-* and orchestrator
    rules only — no scope-*.md is reachable there.
    """
    return ga_paths.get_base_root() / "scoped"


def _scope_file_for_agent(agent: str) -> Path | None:
    """Return the scope-*.md path for the target agent, or None if unresolved.

    Both miss kinds — agent absent from the map, and mapped path not a readable
    file — are loud, because a blind C3 axis is indistinguishable from a
    verified one at every downstream surface. The readability half uses the same
    ``is_file`` test as the C4 sibling ``_get_target_path``: an ``exists`` test
    admits a directory, whose read error reaches C3 as a neutral excerpt with no
    verdict attached — the exact blind axis this signal exists to eliminate.
    """
    relative = _AGENT_SCOPE_MAP.get(agent)
    if not relative:
        sys.stderr.write(
            f"[daemon-cycle] WARN: {SCOPE_UNRESOLVED_SIGNAL} — agent {agent!r} has no "
            "agent→scope map entry; C3 has no scope file to judge against\n"
        )
        return None

    scoped_dir = _get_scoped_dir()
    candidate = scoped_dir / relative
    if not candidate.is_file():
        sys.stderr.write(
            f"[daemon-cycle] WARN: {SCOPE_UNRESOLVED_SIGNAL} — {relative} absent from "
            f"{scoped_dir} (agent {agent!r}); C3 has no scope file to judge against\n"
        )
        return None
    return candidate


# Named signal for an unresolvable C4 target file, carried on BOTH channels for
# the same reason C3 carries one.
TARGET_UNRESOLVED_SIGNAL = "TARGET-FILE-UNRESOLVED"


def _get_target_path(target_file: str) -> Path | None:
    """Resolve the C4 target agent file, independent of process cwd.

    The updater hands a repo-relative ``agents/<name>.md``. Resolved against cwd
    that yields two wrong outcomes: the not-available placeholder from an
    unrelated cwd, and — worse — the RELEASE copy whenever cwd happens to be a
    repo root, which renders a plausible excerpt of a file that is not the live
    target. A relative path therefore anchors on the ga_paths base root, the
    same seam C3 resolves through, and a miss is loud rather than neutral.
    """
    candidate = Path(target_file)
    if not candidate.is_absolute():
        candidate = ga_paths.get_base_root() / candidate
    if not candidate.is_file():
        sys.stderr.write(
            f"[daemon-cycle] WARN: {TARGET_UNRESOLVED_SIGNAL} — {target_file!r} resolved "
            f"to {candidate}, which is not a readable file; C4 has no target body to "
            "judge against\n"
        )
        return None
    return candidate


# -- Promotion ladder config ------------------------------------------------
#
# Confidence-weighted learning loop — a Beta-Binomial posterior gate atop the
# binary threshold (5+ occurrences → Tier-1 Auto), promoting mention → candidate
# → proposal → instruction|skill. Wires in lib/confidence.py + lib/project_key.py.
#
# Thresholds:
#   candidate : confidence_observed >= 0.7  AND n >= 10
#   proposal  : confidence_observed >= 0.85 AND 7-day sustain
#   terminal  : instruction-edit (Tier-1 Auto, body edit)
#               OR skill-candidate (Tier-2 user_pending, frontmatter identity)

# Add lib/ to sys.path — the daemon runs from autoagent root, where lib/ may not
# be on the path automatically.
_AUTOAGENT_LIB_DIR = Path(__file__).resolve().parent / "lib"
if str(_AUTOAGENT_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_LIB_DIR))
try:
    from confidence import (  # noqa: E402
        OutcomeSignal,
        POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS,
        POST_APPLY_REGRESSION_RATE_DELTA,
        beta_smoothed_rate,
        compute_confidence_observed,
    )
    from project_key import resolve_project_key  # noqa: E402

    HAS_CONFIDENCE_LIB = True
except Exception as _conf_import_exc:  # noqa: BLE001 — lib missing → graceful skip
    HAS_CONFIDENCE_LIB = False
    sys.stderr.write(
        f"[daemon-cycle] WARN: confidence/project_key lib import failed — "
        f"promotion ladder disabled: "
        f"{type(_conf_import_exc).__name__}: {_conf_import_exc}\n"
    )

# Cooperative update pause-flag honor (T10) — the python twin of
# scripts/lib/update-pause-flag.sh. While a Glass Atrium update swaps files it
# holds a flag; the daemon cooperatively SUSPENDS its decision-to-run so a cycle
# write never races the update's file swap. A STALE flag (crashed updater) is
# TTL-cleared inside is_pause_active. DAEMON SAFETY: a missing lib degrades to a
# loud WARN + proceed (never break the launchd-live daemon over an absent helper).
try:
    from autoagent_pause import is_pause_active as _update_is_pause_active  # noqa: E402

    HAS_PAUSE_LIB = True
except Exception as _pause_import_exc:  # noqa: BLE001 — lib missing → graceful skip
    HAS_PAUSE_LIB = False
    sys.stderr.write(
        f"[daemon-cycle] WARN: pause-flag lib import failed — update-pause gate "
        f"disabled: {type(_pause_import_exc).__name__}: {_pause_import_exc}\n"
    )

# Feature-flag file — confidence_filter_enabled toggle (3-state):
#   true → active (posterior gate ON) · false → bypass (floorless, operator OFF)
#   · missing/malformed/unset → floor (fail-CLOSED — every row floored to 'mention').
FEATURE_FLAGS_FILE = ga_paths.get_data_root() / "learning" / "feature-flags.json"
_CONFIDENCE_FLAG_KEY = "confidence_filter_enabled"

# Promotion ladder thresholds. The n>=MIN_OBSERVATIONS candidate floor gates on
# the TRUE qualifying-outcome count (_count_outcome_signals — uncapped COUNT(*)
# over the lookback window), NOT on the capped posterior sample length: tying
# n to a sample cap below the floor would silently disable candidate promotion
# and with it every unattended auto-apply (user-approved to be live; the
# apply-side quality floor — 'mention' excluded — still gates each apply).
PROMOTION_CANDIDATE_CONFIDENCE = 0.7
PROMOTION_CANDIDATE_MIN_OBSERVATIONS = 10
PROMOTION_PROPOSAL_CONFIDENCE = 0.85
PROMOTION_SUSTAIN_DAYS = 7

# Promotion tier label — core.autoagent_proposals.promotion_tier column value.
PromotionTier = Literal[
    "mention", "candidate", "proposal", "instruction-edit", "skill-candidate"
]

# Apply-eligible promotion tiers — the SINGLE SoT shared with the apply-side
# allowlist (daemon-apply.sh extract_backlog_patches). A row whose promotion_tier
# is NOT in this set (only 'mention', the floor rung) is PERMANENTLY excluded by
# auto-apply. Generation MUST NOT emit such a row as approval_tier='auto' +
# status='pending' — that produces the auto+pending+mention limbo that fossilizes
# as a standing "New suggestions" pile (apply excludes it; auto-tier is not a
# human-approval candidate either). is_apply_eligible_promotion_tier() lets
# generation terminalize a floor row to 'rejected' instead, so GENERATION and
# APPLY can never disagree on a single row's eligibility.
#   NULL/None → legacy pre-feature rows (eligible) · "" → operator BYPASS,
#   floorless (eligible) · the four above-floor tiers → eligible · "mention" →
#   the ONLY excluded value (apply-side floor).
APPLY_ELIGIBLE_PROMOTION_TIERS = frozenset(
    {"", "candidate", "proposal", "instruction-edit", "skill-candidate"}
)
# Rationale persisted on a floor row terminalized at generation (vs. emitted as
# auto-pending limbo). Distinct from a quality reject so the board reads true.
# Stable head of the confidence-floor reject reason. classify_failure_rationale
# prefix-matches THIS literal to map a floor-terminalized 'rejected' row to a
# non-adjudication class (so consecutive_reject_count looks past it) — keep the
# reason string below derived from this prefix so the two cannot drift.
_BELOW_FLOOR_REJECT_PREFIX = "deferred: below confidence floor"
_BELOW_FLOOR_REJECT_REASON = (
    f"{_BELOW_FLOOR_REJECT_PREFIX} (promotion_tier='mention') — observed only, "
    "auto-apply ineligible this cycle; resurfaces when the pattern clears the floor"
)


def is_apply_eligible_promotion_tier(promotion_tier: str | None) -> bool:
    """Whether a promotion_tier passes the apply-side auto-apply allowlist.

    Single SoT mirroring daemon-apply.sh extract_backlog_patches' positive
    allowlist (NULL / '' / candidate / proposal / instruction-edit /
    skill-candidate). Only 'mention' (the floor rung) is excluded.

    Args:
        promotion_tier: the row's promotion_tier (None = legacy/pre-feature row).

    Returns:
        True when auto-apply may act on the row; False only for 'mention'.
    """
    if promotion_tier is None:
        return True
    return promotion_tier in APPLY_ELIGIBLE_PROMOTION_TIERS


# Apply-eligible haiku_status prefix — the SINGLE SoT for the haiku-skip gate the
# apply-side auto-apply path enforces (daemon-apply.sh, dev-shell scope). The
# Tier-1 auto-apply contract (core-learning-log.md Instruction Improvement
# Approval Tier) requires haiku_status=='ok*' IN ADDITION to classification=
# 'body-auto' + approval_tier=='auto'. A Haiku-skipped row (skipped:auth /
# skipped:empty-or-error / NULL) must NOT auto-apply. A LITERAL '== "ok"' would
# wrongly reject the legitimate variants ok:retried / ok:fuzzy-parsed, so the
# gate is a PREFIX match (the SQL `LIKE 'ok%'` equivalent), fail-CLOSED on a
# missing/empty value (NULL is excluded, not silently admitted).
HAIKU_APPLY_ELIGIBLE_PREFIX = "ok"


def is_apply_eligible_haiku_status(haiku_status: str | None) -> bool:
    """Whether a haiku_status passes the apply-side haiku-skip gate.

    Single SoT mirroring the apply-side `LIKE 'ok%'` predicate: the legitimate
    variants ok / ok:retried / ok:fuzzy-parsed pass; every skipped:* / error:*
    value and a missing/empty status FAIL (fail-CLOSED — a Haiku-skipped row is
    never auto-applied).
    """
    return bool(haiku_status) and haiku_status.startswith(HAIKU_APPLY_ELIGIBLE_PREFIX)


# Timeout escalation is an axis ORTHOGONAL to the parse path (strict / fuzzy /
# retried) — composing it as a trailing suffix keeps both facts readable, where
# folding it into parse_mode destroyed whichever axis was written second.
ESCALATED_HAIKU_STATUS_SUFFIX = ":escalated"


def build_escalated_haiku_status(base: str, *, escalated_timeout: bool) -> str:
    """Compose the escalation axis onto an ok-arm haiku_status.

    Suffix-only so the 'ok' prefix keeps leading — is_apply_eligible_haiku_status
    (and the apply-side `LIKE 'ok%'` mirror) gate on that prefix. A non-ok base
    is returned untouched: decorating a skipped:*/error: row would forge
    apply-eligibility it never earned.
    """
    if not escalated_timeout:
        return base
    if not base.startswith(HAIKU_APPLY_ELIGIBLE_PREFIX):
        return base
    if base.endswith(ESCALATED_HAIKU_STATUS_SUFFIX):
        return base
    return base + ESCALATED_HAIKU_STATUS_SUFFIX


def is_apply_eligible_patch_dict(patch: dict[str, object]) -> bool:
    """Tested reference spec for the JSON-fallback auto-apply eligibility rule.

    The today-only JSON-report fallback (daemon-apply.sh extract_body_auto_patches)
    selects auto-apply patches from the serialized cycle report. This predicate has
    ZERO production callers — the runtime selector is the python3 heredoc inside
    that bash function. This function is the tested REFERENCE spec for the DEFAULT
    (carve-out-off) fail-closed haiku-skip eligibility rule only: the daemon-apply.sh
    heredoc mirrors THIS default branch, then additionally layers the operator
    carve-out (AUTOAGENT_ALLOW_HAIKU_SKIP — a loud-WARN force-admit of haiku-skipped
    patches) on top, which is OUT of this predicate's scope. So the lockstep is
    partial: it holds for the default gate (a non-'ok' haiku_status row cannot reach
    auto-apply, P3b), not for the carve-out-engaged path the bash heredoc adds.
    A patch dict is auto-apply eligible iff ALL hold:
      - approval_tier == 'auto'   (safety tier stays a human-approval candidate),
      - classification == 'body-auto' (JSON-side label for a pre-verified edit),
      - pre_verify_passed is True (the 4-axis pre-verify gate; fail-CLOSED when the
        key is absent/None/False — a report row without the flag is NOT auto-applied,
        mirroring the backlog SELECT's `pre_verify_passed = true`, DF-17),
      - haiku_status starts with 'ok' (the Haiku-skip gate; fail-CLOSED when the
        key is absent — a report row missing haiku_status is NOT auto-applied).

    Presence-tolerant: `.get(..., "")` defaults make a malformed/partial patch
    dict ineligible rather than raising. `approval_tier` MUST be carried on the
    dict (asdict(PatchResult) always emits it) — its absence is treated as
    ineligible (fail-closed), never as an implicit 'auto'.
    """
    if str(patch.get("approval_tier", "")) != "auto":
        return False
    if str(patch.get("classification", "")) != "body-auto":
        return False
    # pre_verify_passed is bool|None on PatchResult; strict True match (NULL/False/
    # absent excluded) mirrors the backlog SELECT `pre_verify_passed = true`.
    if patch.get("pre_verify_passed") is not True:
        return False
    return is_apply_eligible_haiku_status(str(patch.get("haiku_status", "")))


@dataclass(frozen=True)
class FloorTerminalization:
    """Resolved status of an auto candidate against the apply-side floor.

    `terminalized` is True only when an auto+pending candidate's promotion_tier
    is apply-ineligible — in that case the other fields carry the rewritten
    terminal-reject values; otherwise they echo the inputs unchanged.
    """

    classification: str
    approval_tier: str
    status_value: str
    rationale: str
    terminalized: bool


def resolve_floor_terminalization(
    classification: str,
    approval_tier: str,
    status_value: str,
    promotion_tier: str,
    rationale: str,
) -> FloorTerminalization:
    """Terminalize an apply-ineligible auto candidate at the generation source.

    Closes the auto+pending+mention limbo: an auto candidate whose promotion_tier
    the apply gate permanently excludes ('mention') would otherwise sit pending
    forever — auto-apply never acts on it AND auto-tier is not a safety-queue
    candidate. GENERATION and APPLY must agree on ONE acceptance predicate
    (is_apply_eligible_promotion_tier), so an ineligible auto row is rewritten to
    a terminal reject here rather than emitted as auto-pending.

    Only the (approval_tier='auto', status='pending', ineligible-tier) shape is
    rewritten. Safety tier (approval_tier='safety') and already-terminal rows
    (rejected / snoozed) pass through unchanged — the human approval queue and the
    existing reject/back-off paths are preserved.

    Args:
        classification: JSON-side label ('body-auto' for an auto candidate).
        approval_tier: 'auto' / 'safety' / '' as resolved upstream.
        status_value: 'pending' / 'rejected' / 'snoozed' as resolved upstream.
        promotion_tier: the resolved promotion tier ('mention' = floor rung).
        rationale: the candidate's current rationale.

    Returns:
        FloorTerminalization — rewritten reject values when terminalized, else the
        inputs echoed unchanged.
    """
    should_terminalize = (
        approval_tier == "auto"
        and status_value == "pending"
        and not is_apply_eligible_promotion_tier(promotion_tier)
    )
    if not should_terminalize:
        return FloorTerminalization(
            classification=classification,
            approval_tier=approval_tier,
            status_value=status_value,
            rationale=rationale,
            terminalized=False,
        )
    return FloorTerminalization(
        classification="reject",
        approval_tier="",
        status_value="rejected",
        rationale=_BELOW_FLOOR_REJECT_REASON,
        terminalized=True,
    )

# Confidence-filter resolution — 3-state, fail-CLOSED on default/failure.
#   active : explicit flag True  → run classify_promotion_tier (floor applies).
#   bypass : explicit flag False → floorless (operator OFF — promotion_tier="",
#            apply-side `IS DISTINCT FROM 'mention'` passes the row).
#   floor  : lib-import failure OR flags.json absent / malformed / key-unset
#            (default+failure states) → conservative floor: promotion_tier='mention'
#            for every row, so the apply-side EXCLUDES them. Absent-config = safe.
ConfidenceFilterState = Literal["active", "bypass", "floor"]


def confidence_filter_state(flags_path: Path | None = None) -> ConfidenceFilterState:
    """Resolve the confidence-filter 3-state from feature-flags.json (fail-CLOSED).

    Three distinct states (default/failure are SAFE, not bypass):
      - ``"active"`` : key explicitly ``True``  → posterior gate ON, floor applies.
      - ``"bypass"`` : key explicitly ``False`` → operator OFF, floorless (preserved).
      - ``"floor"``  : lib-import failure OR file absent / malformed / not-a-dict /
        key-unset / non-bool value (all default+failure states) → conservative
        floor (every row floored to 'mention' → apply-side auto-apply excludes them).

    Only a literal JSON ``true`` activates and only a literal ``false`` bypasses;
    every other shape collapses to ``"floor"`` (absent-config is the safe state).
    Deterministic read-only — no side effects.

    Args:
        flags_path: feature-flags.json path (None → dynamic module-global
            FEATURE_FLAGS_FILE lookup — avoids def-time binding for monkeypatch).

    Returns:
        ConfidenceFilterState — one of "active" / "bypass" / "floor".
    """
    if not HAS_CONFIDENCE_LIB:
        # lib import failure = failure state → floor conservatively (fail-CLOSED).
        return "floor"
    # None → dynamic module-global lookup (honors test monkeypatch of FEATURE_FLAGS_FILE).
    if flags_path is None:
        flags_path = FEATURE_FLAGS_FILE
    if not flags_path.exists():
        # Absent config = default state → floor (the day-1 floorless gap).
        return "floor"
    try:
        flags = json.loads(flags_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(
            f"[daemon-cycle] WARN: feature-flags.json read failed — "
            f"confidence filter FLOOR (fail-closed): {type(exc).__name__}: {exc}\n"
        )
        return "floor"
    if not isinstance(flags, dict):
        return "floor"
    value = flags.get(_CONFIDENCE_FLAG_KEY)
    if value is True:
        return "active"
    if value is False:
        # Explicit operator OFF — legitimate bypass, floorless (NOT a default state).
        return "bypass"
    # Key unset / non-bool (e.g. "true", 1) = absent-config → floor (fail-CLOSED).
    return "floor"


def confidence_filter_enabled(flags_path: Path | None = None) -> bool:
    """Whether the posterior gate runs ``classify_promotion_tier`` (active state).

    Thin backward-compatible wrapper over :func:`confidence_filter_state` — True
    only in the ``"active"`` state. ``"bypass"`` and ``"floor"`` both return False
    (no classifier run), but they diverge in promotion_tier downstream: bypass→"",
    floor→"mention". Use :func:`confidence_filter_state` when that distinction
    matters; use this only for the boolean "should the classifier run?" question.

    Args:
        flags_path: feature-flags.json path (None → module-global lookup).

    Returns:
        bool — True only when the resolved state is ``"active"``.
    """
    return confidence_filter_state(flags_path) == "active"


def _fetch_outcome_signals(
    agent: str,
    *,
    limit: int = OUTCOME_SAMPLE_LIMIT,
) -> list[OutcomeSignal]:
    """PG core.outcomes → list[OutcomeSignal] (empirical signal tuple).

    Input for the confidence.py posterior — the writer self-report ``confidence``
    enum is deliberately excluded; only the PG row's revision_count / result /
    evaluative_signal are used (read via the raw helper dict, not the lossy
    Outcome dataclass which drops those fields).

    - PG unavailable → empty list → cold-start posterior 0.5 (fails the 0.7 gate
      → stays at mention, safe).
    - filesystem `.md` fallback has incomplete revision_count/evaluative_signal
      frontmatter → PG-only path (empirical-signal integrity first).

    Args:
        agent: pattern target agent.
        limit: most recent N records (default OUTCOME_SAMPLE_LIMIT).

    Returns:
        list[OutcomeSignal] (record_ts DESC, up to limit).
    """
    if not HAS_PG_OUTCOME_READ or not agent:
        return []

    since_epoch = time.time() - PG_OUTCOME_LOOKBACK_DAYS * 86400
    try:
        rows = _pg_read_outcomes_since(
            since_epoch,
            agent=agent,
            task_type=None,
            limit=limit,
            order="DESC",
        )
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        sys.stderr.write(
            f"[daemon-cycle] WARN: PG outcome-signal read failed "
            f"(promotion gate degrades to cold-start): "
            f"{type(exc).__name__}: {exc}\n"
        )
        return []

    signals: list[OutcomeSignal] = []
    for row in rows:
        # Preserve record_ts (time-decay input). PG returns a tz-aware datetime;
        # absent → None → compute treats as legacy.
        signals.append(
            OutcomeSignal(
                revision_count=int(row.get("revision_count") or 0),
                result=row.get("result", "") or "",
                evaluative_signal=int(row.get("evaluative_signal") or 0),
                record_ts=row.get("record_ts"),
            )
        )
    return signals


def _count_outcome_signals(agent: str) -> int | None:
    """True qualifying-outcome count — the promotion ladder's observation_count.

    Same window + filters as _fetch_outcome_signals (90-day lookback, agent
    scope, learning-signal exclusions incl. poisoned_window — WHERE shared
    inside the PG helper), with no LIMIT: OUTCOME_SAMPLE_LIMIT bounds the
    posterior's sample, never the evidence volume the n>=10 floor gates on.

    Returns:
        int — qualifying-row count · None on PG-off / read failure (caller
        degrades to the capped sample length → n stays below the candidate
        floor → 'mention', fail-closed).
    """
    if not HAS_PG_OUTCOME_READ or not agent:
        return None

    since_epoch = time.time() - PG_OUTCOME_LOOKBACK_DAYS * 86400
    try:
        return _pg_count_outcomes_since(since_epoch, agent=agent, task_type=None)
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        sys.stderr.write(
            f"[daemon-cycle] WARN: PG outcome-count read failed "
            f"(observation_count degrades to capped sample length): "
            f"{type(exc).__name__}: {exc}\n"
        )
        return None


def _fetch_promotion_stats(agent: str) -> tuple[list[OutcomeSignal], int]:
    """(posterior sample, observation_count) for the promotion ladder — decoupled.

    The sample (capped at OUTCOME_SAMPLE_LIMIT, most-recent-first) feeds the
    Beta-Binomial posterior via α/β accumulation — compute_confidence_observed
    never divides by the sample length, so a capped sample cannot corrupt the
    posterior. observation_count is the uncapped COUNT(*) of the same window,
    so the n>=10 candidate floor measures real evidence volume. Count
    unavailable → degrade to the capped sample length (n<=cap stays below the
    floor → 'mention', fail-closed).
    """
    signals = _fetch_outcome_signals(agent, limit=OUTCOME_SAMPLE_LIMIT)
    true_count = _count_outcome_signals(agent)
    if true_count is None:
        return signals, len(signals)
    return signals, true_count


def _is_sustained(pattern_date: str, *, sustain_days: int = PROMOTION_SUSTAIN_DAYS) -> bool:
    """7-day rolling sustain check against the pattern's first-observed date.

    - core.learning_log discovered_date (YYYY-MM-DD) = first-observed date.
    - today - date >= sustain_days → sustained.
    - date parse failure → False (conservative — blocks proposal promotion).

    Args:
        pattern_date: Pattern.date (discovered_date as YYYY-MM-DD).
        sustain_days: sustain threshold in days (default 7).

    Returns:
        bool — whether sustain is met.
    """
    try:
        observed = datetime.strptime(pattern_date.strip(), "%Y-%m-%d").replace(
            tzinfo=timezone.utc
        )
    except (ValueError, AttributeError):
        return False
    elapsed_days = (datetime.now(timezone.utc) - observed).days
    return elapsed_days >= sustain_days


def classify_promotion_tier(
    *,
    confidence_observed: float,
    observation_count: int,
    sustained: bool,
    touches_frontmatter: bool,
) -> PromotionTier:
    """Beta-Binomial posterior + observation count + sustain → promotion tier.

    Promotion ladder:
      - mention   : default (observed only, raw log)
      - candidate : confidence_observed >= 0.7  AND observation_count >= 10
      - proposal  : (candidate) AND confidence_observed >= 0.85 AND sustained
      - terminal  : on reaching proposal —
          * touches_frontmatter=True  → skill-candidate (Tier-2 user_pending)
          * touches_frontmatter=False → instruction-edit (Tier-1 Auto)

    Skill graduation (frontmatter-identity change) is always Tier-2 user_pending
    (the "frontmatter identity field change" safety trigger).

    Args:
        confidence_observed: posterior mean in (0,1).
        observation_count: pattern outcome observation count (n).
        sustained: whether 7-day sustain is met.
        touches_frontmatter: whether the proposal diff touches frontmatter identity.

    Returns:
        PromotionTier — one of the 5 stages.
    """
    candidate_ok = (
        confidence_observed >= PROMOTION_CANDIDATE_CONFIDENCE
        and observation_count >= PROMOTION_CANDIDATE_MIN_OBSERVATIONS
    )
    if not candidate_ok:
        return "mention"

    proposal_ok = confidence_observed >= PROMOTION_PROPOSAL_CONFIDENCE and sustained
    if not proposal_ok:
        return "candidate"

    # Reached proposal → terminal-stage branch.
    if touches_frontmatter:
        return "skill-candidate"
    return "instruction-edit"


# -- Data models ------------------------------------------------------------




@dataclass(frozen=True)
class Pattern:
    """One intake row from core.learning_log (status='identified', intake tier band)."""

    date: str
    label: str
    frequency: str  # raw text — may be "23", "≥40", "10/16", "9141" etc.
    agent: str
    status: str
    tier: str
    raw_line: str
    # core.learning_log id (0 = synthetic, e.g. FU-3 regen). Lifecycle transitions
    # key on id — renamed rows keep a legacy signature suffix (…|nodejs-dev with
    # agent='dev-node'), so a "label|agent" reconstruction silently misses them.
    row_id: int = 0

    @property
    def freq_int(self) -> int:
        """Best-effort numeric frequency for sorting (returns 0 on failure)."""
        match = re.search(r"\d+", self.frequency)
        return int(match.group(0)) if match else 0


@dataclass(frozen=True)
class Outcome:
    """A single outcome record sampled from data/outcomes/."""

    path: str
    agent: str
    task_type: str
    result: str
    confidence: str
    metric_pass: str
    summary: str  # truncated to 240 chars
    lesson: str   # truncated to 240 chars
    # Polarity signals — defaulted so every pre-existing Outcome(...) call site
    # stays valid (frozen dataclass; defaults trail the required fields). Absent
    # source value → NEUTRAL (0), never silently bucketed as success.
    revision_count: int = 0       # >=2 marks a correction (core-learning-log.md)
    evaluative_signal: int = 0    # -1/0/+1; -1 = user-corrected, preserve verbatim
    # Write-time provenance — carved out of FAILURE polarity for the synthesized
    # measurement gap (completion-synthesized done_with_concerns). Absent → "".
    attribution_source: str = ""


def _coerce_evaluative_signal(raw: object) -> int:
    """Normalize an evaluative_signal source value to the -1/0/+1 ternary.

    None / missing / unparseable / out-of-range → 0 (NEUTRAL). A missing signal
    is NOT coerced into +1 — that would mis-bucket legacy records as success and
    poison the optimizer (core-outcome-record.md: absent and 0 are both neutral
    here, only -1 carries failure polarity).
    """
    if raw is None:
        return 0
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return value if value in (-1, 0, 1) else 0


def _coerce_revision_count(raw: object) -> int:
    """Normalize a revision_count source value to a non-negative-safe int.

    None / missing / unparseable → 0; a valid int is preserved as-is. Unifies the
    PG-row and filesystem-frontmatter coercion idioms onto one sibling helper.
    """
    if raw is None:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


# -- AD-10 Pareto variant retention (Solution History, GEPA precedent) -------

# GEPA min-occurrence floor per (agent, task_type) cell — a cell with fewer
# attempts than this carries insufficient evidence to retain any winner.
SOLUTION_HISTORY_MIN_OCCURRENCE = 5


@dataclass(frozen=True)
class SolutionAttempt:
    """One instruction-improvement attempt in Solution History.

    OPRO 3-tuple (score / applied_date + the instruction cell) plus the
    reflective mutation signal (lesson + directive_hint) that GEPA feeds into
    the next optimization cycle. `score` is a 1-5 scalar; `applied_date` is an
    ISO 'YYYY-MM-DD' string (lexical order == chronological).
    """

    agent: str
    task_type: str
    score: float
    applied_date: str
    lesson: str = ""
    directive_hint: str = ""


def _solution_dominates(a: SolutionAttempt, b: SolutionAttempt) -> bool:
    """Pareto domination over (score, recency).

    `a` dominates `b` iff `a` is >= on BOTH objectives (higher score, newer
    date) AND strictly greater on at least one. Ties are non-dominating, so
    equally-good variants are BOTH retained — the diversity AD-10 preserves.
    """
    at_least = a.score >= b.score and a.applied_date >= b.applied_date
    strictly = a.score > b.score or a.applied_date > b.applied_date
    return at_least and strictly


def retain_pareto_winners(
    attempts: list[SolutionAttempt],
    *,
    min_occurrence: int = SOLUTION_HISTORY_MIN_OCCURRENCE,
) -> dict[tuple[str, str], list[SolutionAttempt]]:
    """Retain the per-(agent, task_type) Pareto-nondominated winner set.

    AD-10 (GEPA): Solution History keeps MULTIPLE winners per cell — the
    non-dominated frontier over (score, recency) — NOT a single scalar-best, so a
    newer-but-lower-score variant survives alongside an older-but-higher one and
    their lesson+directive_hint diversity feeds the next reflective mutation. A
    cell is retained ONLY when it has >= `min_occurrence` attempts (GEPA
    min-occurrence floor); thinner cells are dropped.

    Returns dict[(agent, task_type)] -> winners, each list sorted score-desc then
    date-desc (deterministic).
    """
    if min_occurrence < 1:
        raise ValueError(f"min_occurrence must be >= 1, got {min_occurrence}")

    cells: dict[tuple[str, str], list[SolutionAttempt]] = defaultdict(list)
    for attempt in attempts:
        cells[(attempt.agent, attempt.task_type)].append(attempt)

    winners: dict[tuple[str, str], list[SolutionAttempt]] = {}
    for cell_key, cell_attempts in cells.items():
        if len(cell_attempts) < min_occurrence:
            continue  # GEPA min-occurrence: insufficient evidence → drop cell
        frontier = [
            attempt
            for attempt in cell_attempts
            if not any(
                _solution_dominates(other, attempt)
                for other in cell_attempts
                if other is not attempt
            )
        ]
        # Stable-chain sort: date-desc first, then score-desc (score primary).
        frontier.sort(key=lambda a: a.applied_date, reverse=True)
        frontier.sort(key=lambda a: a.score, reverse=True)
        winners[cell_key] = frontier
    return winners


def solution_attempt_from_outcome(
    outcome: Outcome,
    applied_date: str,
    *,
    directive_hint: str = "",
) -> SolutionAttempt:
    """Bridge an Outcome record into a SolutionAttempt (score from polarity).

    Score derivation mirrors the loop's existing polarity signals: a passing
    metric is the base, a user correction (evaluative_signal == -1 or a
    revision) pulls it down, explicit praise (+1) lifts it. directive_hint is
    passed in because it is not carried on the Outcome dataclass.
    """
    metric_true = str(outcome.metric_pass).strip().lower() == "true"
    base = 4.0 if metric_true else 2.0
    if outcome.evaluative_signal == 1:
        base += 1.0
    elif outcome.evaluative_signal == -1 or outcome.revision_count >= 2:
        base -= 1.0
    score = max(1.0, min(5.0, base))
    return SolutionAttempt(
        agent=outcome.agent,
        task_type=outcome.task_type,
        score=score,
        applied_date=applied_date,
        lesson=outcome.lesson,
        directive_hint=directive_hint,
    )


@dataclass(frozen=True)
class PatchProposal:
    """Haiku output describing a proposed edit to a single agent .md file."""

    target_file: str            # absolute path
    rationale: str              # 1-2 sentence reason from Haiku
    proposed_diff: str          # unified-diff text (best-effort)
    touched_frontmatter: bool   # classification hint
    estimated_added_lines: int  # for body-auto threshold
    raw_response: str           # full Haiku stdout (truncated for storage)
    # '-' line count from the FULL (pre-truncation) diff, symmetric with
    # estimated_added_lines: proposed_diff is capped at 4000 chars, so a count
    # re-derived from it under-reports exactly the large patches the subtraction
    # ratchet is measured by.
    estimated_removed_lines: int = 0
    # Parse-path indicator (observability honesty):
    #   'strict'  — both RATIONALE/DIFF markers parsed via canonical regex
    #   'fuzzy'   — recovered via case-insensitive / unanchored fallback regex
    #               (NOT silent — caller records this as ok:fuzzy-parsed)
    #   'failed'  — both strict + fuzzy missed → JSONL parse-failure log emitted
    #   'skipped' — generation bypassed (skip_haiku / file missing / timeout /
    #               non-zero exit without quota signal)
    #   'quota-limit' — claude CLI hit an EXTERNAL rate / usage / quota ceiling
    #               (returncode != 0 with a quota-specific stderr/stdout pattern).
    #               Surfaces as haiku_status='skipped:quota-limit'.
    #   'budget-too-low' — LOCAL --max-budget-usd ceiling too low (self-inflicted
    #               config failure, NOT external quota). Split out so a budget bug
    #               never masquerades as an external quota signal. Surfaces as
    #               haiku_status='skipped:budget-too-low'.
    #   'transient-overload' — TRANSIENT infra blip (Overloaded / HTTP 529 /
    #               connection reset / timeout) whose bounded retries
    #               (MAX_TRANSIENT_RETRIES) were exhausted. Distinct from generic
    #               'skipped' so an infra blip is told apart from a genuinely
    #               empty/parse-failed output. Surfaces as haiku_status='skipped:transient'.
    #   'escalated' — LEGACY tag, no longer produced (escalated_timeout carries
    #               the fact now); the derivation switch still maps it so a
    #               persisted or out-of-tree shape keeps its status.
    parse_mode: str = "skipped"
    # Whether the call that produced this proposal ran at HAIKU_ESCALATED_TIMEOUT_SEC.
    # ORTHOGONAL to parse_mode: escalation is a timing fact, the parse path is a
    # parsing fact, and one enum cannot carry both without destroying the other.
    # Default-off — only the two clean-parse return sites in _run_haiku_with_retry
    # set it, so every other producer stays zero-touch.
    escalated_timeout: bool = False
    # Structured failure discriminator (Loud-Fail instrumentation) — set on ANY
    # Haiku failure boundary from the classify_failure_rationale taxonomy so the
    # in-cycle class cannot diverge from the persisted-history classifier (FIX #2
    # SoT). Empty when no failure was captured (happy path). The remaining fields
    # carry the per-call evidence the raw_response[:400] collapse used to destroy.
    failure_class: str = ""
    failure_returncode: int | None = None     # subprocess returncode (None on timeout)
    failure_signal: str = ""                  # decoded signal name when rc<0 (e.g. SIGKILL)
    failure_duration_ms: int | None = None    # wall-clock call duration
    failure_attempt: int | None = None        # 0-based transient-retry attempt index
    failure_probe_result: str = ""            # bounded fail-open reachability verdict
    failure_log_path: str = ""                # per-call untruncated stderr+stdout sink
    # Wall-clock duration of a SUCCESSFUL generation call, in ms.
    # Distinct field, never failure_duration_ms — that one documents failure evidence.
    # Makes budget tightness (slow but under timeout) measurable with no failure row.
    generation_duration_ms: int | None = None


@dataclass(frozen=True)
class PreVerifyResult:
    """4-axis verification verdict for a patch.

    Axes:
        C1: compliance-matrix — Tier 1/2/3 loading policy not subverted.
        C2: GLOBAL_RULES — ALL-scope absolute rules (Korean reply / security /
                           position bias / etc.) not violated.
        C3: scope-* — target agent's scope file Absolute Rules not violated.
        C4: self-consistency — patch does not contradict the target agent's
                               own existing Absolute Rules.

    `passed` is True iff ALL 4 axes pass.

    `axes` is a per-axis bool dict — keys are exactly {"C1","C2","C3","C4"}.

    `status` is the verifier health: 'ok' (LLM responded with parseable verdict)
    | 'skipped:<reason>' (skipped before LLM call) | 'error:<short>' (LLM call
    failed; conservative fallback applied → passed=False).
    """

    passed: bool
    rationale: str
    axes: dict[str, bool]
    status: str
    latency_ms: int


@dataclass
class PatchResult:
    """One row in the cycle report — combines pattern + proposal + classification + pre-verify."""

    pattern_label: str
    pattern_agent: str
    pattern_frequency: str
    target_file: str
    classification: Classification
    rationale: str
    proposed_diff: str
    outcomes_sampled: int
    # 'ok' | 'skipped:<reason>' | 'error:<short>'; updater-origin rows add
    # 'verified:<gate>' for a gate that ran without a model call.
    haiku_status: str
    # Accurate '+' line count from the FULL (pre-truncation) diff. proposed_diff
    # is capped at 4000 chars, so re-deriving the count from it under-reports any
    # patch whose diff exceeds the cap → carry the proposal's count instead. Default
    # 0 keeps historical rows / partial constructions backward-compatible.
    estimated_added_lines: int = 0
    # Symmetric '-' count, same full-diff provenance as estimated_added_lines.
    estimated_removed_lines: int = 0
    error: str = ""
    # Pre-verify outcome — None when not run (patch was reject/frontmatter-dryrun,
    # or pre-verify itself was skipped).
    pre_verify_passed: bool | None = None
    pre_verify_status: str = ""  # mirrors PreVerifyResult.status
    pre_verify_rationale: str = ""
    # The four compliance axes (C1-C4) when pre-verify ran, PLUS the
    # PROSE_ONLY_ADD_AXIS_KEY passenger when the proposal carried a diff. The
    # passenger is a detection verdict, not a compliance axis — the four-axis
    # contract is unchanged for every C* key, and the failed-axis renderer is
    # constrained to COMPLIANCE_AXIS_KEYS so the passenger never renders as a
    # failed axis. Composed by _compose_pre_verify_axes (both paths, including
    # the no-pre-verify one).
    pre_verify_axes: dict[str, bool] = field(default_factory=dict)
    pre_verify_latency_ms: int = 0
    # Routing hints consumed by _pg_push_autoagent_cycle.py — empty string
    # when pre-verify did not run, "auto" when verified, "user" when not.
    approval_tier: str = ""
    status: str = ""
    # Confidence-weighted promotion ladder — filled in run_cycle when
    # confidence_filter_enabled; left at defaults otherwise (JSON + PG push stay
    # backward-compatible).
    #   confidence_observed: Beta-Binomial posterior mean; None when the flag is off.
    #   project_key: resolve_project_key().key (12 hex) for project isolation.
    #   promotion_tier: mention/candidate/proposal/instruction-edit/skill-candidate.
    confidence_observed: float | None = None
    project_key: str = ""
    promotion_tier: str = ""
    # Structured Haiku-failure evidence mirrored from the proposal (Loud-Fail
    # instrumentation). Empty/None on the happy path; carries the discriminator +
    # per-call evidence into the cycle report JSON so a failure is diagnosable
    # without re-running. failure_class follows the classify_failure_rationale
    # taxonomy (single SoT shared with the persisted-history de-conflation).
    failure_class: str = ""
    failure_returncode: int | None = None
    failure_signal: str = ""
    failure_duration_ms: int | None = None
    failure_attempt: int | None = None
    failure_probe_result: str = ""
    failure_log_path: str = ""
    # Redacted head of the proposal's raw_response — a bounded, credential-scrubbed
    # window of the failure stream carried into the cycle report JSON so a failure
    # (notably auth/401) is diagnosable from the row alone. Empty on the happy path.
    # MUST stay redacted (redact_secrets) — a 401 stream may echo a token.
    failure_raw_head: str = ""
    # Mirror of the proposal's successful-call duration (None on every failure path).
    generation_duration_ms: int | None = None


@dataclass
class CycleReport:
    """Top-level JSON shape written to daemon-reports/."""

    cycle_date: str           # YYYY-MM-DD (UTC)
    generated_at: str         # ISO8601 UTC ms
    patterns_processed: int
    cost_guard: dict[str, str | int]
    patches: list[PatchResult] = field(default_factory=list)
    # 'ok' (default) or 'regression' — set in run_cycle when a systemic
    # zero-output regression is detected (this cycle ingested input and rejected
    # all of it, plus a corroborating crit). _main reads this and exits non-clean
    # so an unattended launchd run STOPS reporting a clean exit 0. A quiet night
    # (patches=[]) leaves this 'ok'.
    cycle_status: str = "ok"
    # AD-10 Solution History: the per-(agent, task_type) Pareto winner frontier
    # retained THIS cycle (retain_pareto_winners over the generation outcomes).
    # In-memory only — tuple keys are not JSON-serializable, so _report_to_dict
    # emits a serializable count summary rather than this dict. Feeds the next
    # reflective-mutation cycle once a durable cross-cycle store lands (deferred).
    solution_winners: dict[tuple[str, str], list[SolutionAttempt]] = field(
        default_factory=dict
    )


# -- generation step 1: intake user-pending patterns (PG) -------------------


_TIER_USER_PENDING = "user-pending"
# The intake predicate (status='identified' + tier band 'user-pending'/'llm')
# lives in the PG helper SQL (_pg_learning_dualwrite._PENDING_PATTERNS_SELECT_SQL)
# next to the aggregator's UPSERT — one module owns both sides of the pattern
# hand-off. Daemon-side, every accepted row normalizes to 'user-pending' (the
# legacy 'llm' band folds into the same downstream flow — nothing branches on tier).


def _agent_roster(agents_dir: Path) -> frozenset[str]:
    """Real agent names = stems of `agents/*.md` (single SoT for the roster).

    Intake validates the `agent` column against this set so a task_type value
    (e.g. 'bug-fix') accidentally written into the agent column never yields a
    doomed proposal targeting a non-existent 'bug-fix.md'. Glob failure (missing
    dir / perm) → empty set → caller skips validation (fail-open: never drop
    legitimate patterns).
    """
    try:
        return frozenset(p.stem for p in agents_dir.glob("*.md"))
    except OSError:
        return frozenset()


# Canonical roster stems carry this prefix (agents/glass-atrium-<bare>.md).
_ROSTER_STEM_PREFIX = "glass-atrium-"


def _get_roster_alias(agent: str, roster: frozenset[str]) -> str | None:
    """Roster stem the bare/prefixed alias `agent` resolves to, or None.

    Accumulated learning_log rows carry the same logical agent in bare form
    ('dev-shell') while the live roster stem is the prefixed form
    ('glass-atrium-dev-shell') — and vice versa on a bare-stem checkout.
    Alias-trying both directions lets the caller rewrite Pattern.agent to the
    REAL stem so downstream target_file resolution (agents/<stem>.md) hits the
    file; no hit in either direction → None (caller keeps the loud-fail path).
    """
    prefixed = _ROSTER_STEM_PREFIX + agent
    if prefixed in roster:
        return prefixed
    if agent.startswith(_ROSTER_STEM_PREFIX):
        bare = agent[len(_ROSTER_STEM_PREFIX):]
        if bare in roster:
            return bare
    return None


def read_user_pending_patterns(
    log_path: Path,
    limit: int,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
) -> list[Pattern]:
    """Read intake rows from PG core.learning_log, sorted by frequency desc.

    Intake SoT is PG — the aggregator UPSERTs patterns into core.learning_log
    (learning-aggregator.py → upsert_learning_pattern), so any other read
    source splits writer and reader. `log_path` (the legacy
    data/learning-log.md) is intentionally neither read nor written: the file
    stays on disk untouched; the parameter survives for call compatibility.
    PG unavailable → 0 patterns + loud WARN (a stale MD fallback would
    regenerate proposals from fossil signals).

    Skips:
        - rows targeting agent='전체' or 'ALL' (cross-cutting → not patchable here)
        - roster-mismatch rows — agent is not an agents/*.md stem: stderr WARN
          + loop-event emit, never a silent drop (Precondition Loud-Fail)

    Returns at most `limit` entries, tier-normalized to 'user-pending'.
    """
    if not HAS_PG_PATTERN_READ:
        sys.stderr.write(
            "[daemon-cycle] WARN: PG pattern intake unavailable (helper import "
            "failed) — 0 patterns this cycle; learning-log.md is not a fallback\n"
        )
        return []

    rows = _pg_read_pending_patterns()
    # Roster for intake-side agent validation. Empty set (glob failure) →
    # validation skipped (fail-open, no legitimate drop).
    roster = _agent_roster(agents_dir)
    # Day-truncated event_ts — same-day re-runs UPSERT the same
    # (event_ts, agent, eval_result) loop-event row instead of accumulating.
    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")

    patterns: list[Pattern] = []
    for row in rows:
        agent = row["agent"]
        # Skip cross-cutting "전체"/ALL — not actionable per agent file.
        if agent in {"전체", "ALL", "all", ""}:
            continue
        # Intake defense-in-depth — when the roster is known (glob succeeded), an
        # `agent` value that is not a real agents/*.md stem (e.g. a task_type
        # 'bug-fix' leaked into the column) cannot produce a landable patch →
        # WARN + loop event, then skip. roster empty (glob failed) → no
        # validation (fail-open).
        if roster and agent not in roster:
            # Bare↔prefixed alias resolution before the loud-fail skip — a row
            # keyed on the bare stem must not dead-end as roster-mismatch when
            # the real agents/<stem>.md exists under the canonical prefix.
            alias = _get_roster_alias(agent, roster)
            if alias is None:
                _warn_roster_mismatch(agent, row["pattern_signature"], event_ts)
                continue
            agent = alias
        discovered = row["discovered_date"]
        signature = row["pattern_signature"]
        patterns.append(
            Pattern(
                date=discovered.isoformat() if discovered else "",
                # signature = "<label>|<agent>" (aggregator UPSERT contract).
                label=signature.rsplit("|", 1)[0],
                frequency=str(row["frequency"]),
                agent=agent,
                status=row["status"],
                tier=_TIER_USER_PENDING,
                raw_line=f"pg:learning_log:{row['id']}:{signature}",
                row_id=row["id"],
            )
        )

    patterns.sort(key=lambda p: p.freq_int, reverse=True)
    return patterns[:limit]


def _warn_roster_mismatch(agent: str, signature: str, event_ts: str) -> None:
    """Roster-mismatch intake row → stderr WARN + loop-event emit, then skip.

    A dropped intake row must stay observable (Precondition Loud-Fail):
    eval_result='roster-mismatch' rows in core.autoagent_loop_events surface
    the drop to the monitor; the stderr line names the offending agent value
    for log-side triage.
    """
    sys.stderr.write(
        f"[daemon-cycle] WARN: intake roster mismatch — agent {agent!r} is not "
        f"an agents/*.md stem (signature: {signature[:80]!r}); pattern skipped, "
        "loop event emitted\n"
    )
    _invoke_pg_helper(
        {
            "op": "write_autoagent_loop_event",
            "args": {
                "event_ts": event_ts,
                "agent": agent[:64],  # varchar(64) guard — mirrors the aggregator
                "eval_result": "roster-mismatch",
                "changes_added": 0,
                "changes_removed": 0,
                "rice": None,
            },
        }
    )


# -- Generation window: previous calendar day (local tz) --------------------
#
# The GENERATION path uses prior-day-all (no 90-day rolling sample / 5-sample
# cap), via an explicit day-boundary rather than trailing-24h epoch subtraction.
# The promotion-stats path (_fetch_outcome_signals) is separate — not this function.


def _local_day_bounds(
    now: datetime | None = None,
) -> tuple[float, float]:
    """[start, end) epoch bounds of the previous calendar day, LOCAL timezone.

    D = cycle run date (local). Returns [start_of(D-1), start_of(D)).
    - lower: yesterday 00:00:00 (local) → epoch
    - upper: today 00:00:00 (local) → epoch (exclusive)

    Args:
        now: reference time (test injection). None → datetime.now() (naive local).

    Returns:
        (yesterday_start_epoch, today_start_epoch) — both float epoch seconds.
    """
    base = now if now is not None else datetime.now()
    # tz-aware input → convert to local naive so the local-midnight boundary
    # is computed consistently.
    if base.tzinfo is not None:
        base = base.astimezone().replace(tzinfo=None)
    today_start = base.replace(hour=0, minute=0, second=0, microsecond=0)
    # timestamp() of the shifted datetime, NOT today_start - 86400: a fixed
    # second offset misses yesterday's local midnight on DST-change days.
    yesterday_start = today_start - timedelta(days=1)
    return yesterday_start.timestamp(), today_start.timestamp()


def _resolve_agent_limit(limit: int | None) -> int:
    """Normalize the per-cycle agent cap — 0/negative/None → unlimited sentinel.

    Receives DEFAULT_PATTERN_LIMIT (=AUTOAGENT_AGENT_LIMIT env) or --limit. Only
    positive ints are treated as a ceiling; everything else → UNLIMITED_AGENTS.
    """
    if limit is None:
        return UNLIMITED_AGENTS
    if limit <= 0:
        return UNLIMITED_AGENTS
    return limit


# -- generation step 2: sample related outcome records ----------------------


def fetch_related_outcomes(
    agent: str,
    task_type: str | None,
    limit: int = OUTCOME_SAMPLE_LIMIT,
    outcomes_dir: Path = DEFAULT_OUTCOMES_DIR,
) -> list[Outcome]:
    """Sample the most-recent N outcome records for the given agent (and task_type).

    - PRIMARY: core.outcomes SELECT via the _pg_read_outcomes_since helper (PG is
      the single source). Server-side agent + optional task_type filter,
      record_ts DESC, top-N.
    - FALLBACK: file-system glob (residual pre-cutover `.md`). PG 0 AND file 0 →
      empty list (normal). PG 1+ → skip file fallback (PG is the single truth).

    Filename convention for fallback:
        YYYY-MM-DD-HHMM_<agent>_<task_type>.md
    Sorting by filename = timestamp DESC (lex order works — fixed-width prefix).
    """
    pg_outcomes = _fetch_outcomes_from_pg(agent, task_type, limit)
    if pg_outcomes:
        # PG is the single truth — skip the file fallback (mixed-source ambiguity).
        return pg_outcomes

    return _fetch_outcomes_from_filesystem(agent, task_type, limit, outcomes_dir)


def _fetch_outcomes_from_pg(
    agent: str,
    task_type: str | None,
    limit: int,
) -> list[Outcome]:
    """PG core.outcomes → Outcome dataclass mapping.

    The read_outcomes_since helper takes agent/task_type/limit/order kwargs →
    server-side WHERE/ORDER BY/LIMIT eliminates ~1500× over-fetch (38MB → ~25KB
    per cycle), using the outcomes_agent_ts_idx (agent, record_ts) index. No
    client-side filter/sort/slice. PG unavailable → empty list (caller does the
    file fallback).
    """
    if not HAS_PG_OUTCOME_READ:
        return []
    if not agent:
        return []

    # 90-day lookback — enough per-agent sample + agent_ts_idx index scan.
    since_epoch = time.time() - PG_OUTCOME_LOOKBACK_DAYS * 86400
    try:
        rows = _pg_read_outcomes_since(
            since_epoch,
            agent=agent,
            task_type=task_type,
            limit=limit,
            order="DESC",
        )
    except Exception as exc:  # noqa: BLE001 — read fallback is silent + safe
        sys.stderr.write(
            f"[daemon-cycle] WARN: PG outcome read failed, falling back to "
            f"file system: {type(exc).__name__}: {exc}\n"
        )
        return []

    outcomes: list[Outcome] = []
    for row in rows:
        record_ts = row.get("record_ts")
        # PG record identifier — pg_audit_ref for grep traceability (helper convention).
        pg_path = row.get("pg_audit_ref") or (
            f"pg:{record_ts.isoformat(timespec='seconds') if record_ts else ''}"
            f":{row.get('agent', '')}:{row.get('task_type', '')}"
        )
        metric_pass_value = row.get("metric_pass")
        if metric_pass_value is None:
            metric_pass_str = ""
        elif isinstance(metric_pass_value, bool):
            metric_pass_str = "true" if metric_pass_value else "false"
        else:
            metric_pass_str = str(metric_pass_value)

        outcomes.append(
            Outcome(
                path=pg_path,
                agent=row.get("agent", ""),
                task_type=row.get("task_type", ""),
                result=row.get("result", ""),
                confidence=row.get("confidence", ""),
                metric_pass=metric_pass_str,
                summary=(row.get("summary") or "")[:240],
                lesson=(row.get("lesson") or "")[:240],
                # provenance for the synthesized-measurement-gap FAILURE carve-out
                attribution_source=str(row.get("attribution_source") or ""),
            )
        )
    return outcomes


def _fetch_outcomes_from_filesystem(
    agent: str,
    task_type: str | None,
    limit: int,
    outcomes_dir: Path,
) -> list[Outcome]:
    """Legacy file-system path (pre-Phase-5 `.md` records).

    Filename convention (set by pre-Phase-5 track-outcome.sh):
        YYYY-MM-DD-HHMM_<agent>_<task_type>.md
    """
    if not outcomes_dir.exists():
        return []

    # Filter by filename token to avoid reading 2000+ files.
    matches: list[Path] = []
    needle_agent = f"_{agent}_"
    needle_tt = f"_{task_type}." if task_type else ""

    # listdir is faster than rglob for a flat dir of ~2.5k files.
    for name in os.listdir(outcomes_dir):
        if not name.endswith(".md"):
            continue
        if needle_agent not in name:
            continue
        if needle_tt and needle_tt not in name:
            continue
        matches.append(outcomes_dir / name)

    matches.sort(key=lambda p: p.name, reverse=True)
    matches = matches[:limit]

    outcomes: list[Outcome] = []
    for path in matches:
        try:
            outcomes.append(_parse_outcome_file(path))
        except OSError as exc:
            # Log silently to stderr — one bad file shouldn't kill the cycle.
            print(
                f"[daemon-cycle] WARN: outcome read failed: {path.name}: {exc}",
                file=sys.stderr,
            )
    return outcomes


def fetch_generation_outcomes(
    agent: str,
    *,
    day_bounds: tuple[float, float] | None = None,
    outcomes_dir: Path = DEFAULT_OUTCOMES_DIR,
) -> list[Outcome]:
    """GENERATION path — return ALL of an agent's previous-calendar-day outcomes.

    Window = [start_of(D-1), start_of(D)) (LOCAL tz, _local_day_bounds), no sample
    cap (all of yesterday feeds the analysis).

    - The PG read helper supports only a LOWER bound (since_epoch), no UPPER bound,
      so over-fetch with since=yesterday_start and CLIENT-SIDE drop rows with
      record_ts >= today_start. Over-fetch spans only 2 days → negligible cost.
    - PG 0 AND file 0 → empty list. PG 1+ → skip file fallback (single truth).
    - file fallback matches yesterday's YYYY-MM-DD filename prefix.

    Args:
        agent: target agent.
        day_bounds: (yesterday_start, today_start) epoch — test injection.
                    None → computed via _local_day_bounds().
        outcomes_dir: file-fallback directory.

    Returns:
        list[Outcome] (record_ts DESC, all of yesterday — no cap).
    """
    if not agent:
        return []
    y_start, t_start = day_bounds if day_bounds is not None else _local_day_bounds()

    pg_outcomes = _fetch_generation_outcomes_from_pg(agent, y_start, t_start)
    if pg_outcomes:
        return pg_outcomes

    return _fetch_generation_outcomes_from_filesystem(
        agent, y_start, t_start, outcomes_dir
    )


def _fetch_generation_outcomes_from_pg(
    agent: str,
    yesterday_start: float,
    today_start: float,
) -> list[Outcome]:
    """PG core.outcomes → all of yesterday's Outcomes (no cap, today excluded).

    read_outcomes_since(since=yesterday_start, limit=None) fetches yesterday+today,
    then client-side drops record_ts >= today_start. limit=None → helper omits the
    LIMIT clause (over-fetch bounded to 2 days).
    """
    if not HAS_PG_OUTCOME_READ or not agent:
        return []

    try:
        rows = _pg_read_outcomes_since(
            yesterday_start,
            agent=agent,
            task_type=None,
            limit=None,  # no cap — all of yesterday
            order="DESC",
        )
    except Exception as exc:  # noqa: BLE001 — read fallback is logged + safe
        sys.stderr.write(
            f"[daemon-cycle] WARN: PG generation-outcome read failed for "
            f"{agent}, falling back to file system: "
            f"{type(exc).__name__}: {exc}\n"
        )
        return []

    outcomes: list[Outcome] = []
    for row in rows:
        record_ts = row.get("record_ts")
        # Exclude today (D) — helper has no UPPER bound, so cap client-side.
        if record_ts is not None and record_ts.timestamp() >= today_start:
            continue
        pg_path = row.get("pg_audit_ref") or (
            f"pg:{record_ts.isoformat(timespec='seconds') if record_ts else ''}"
            f":{row.get('agent', '')}:{row.get('task_type', '')}"
        )
        metric_pass_value = row.get("metric_pass")
        if metric_pass_value is None:
            metric_pass_str = ""
        elif isinstance(metric_pass_value, bool):
            metric_pass_str = "true" if metric_pass_value else "false"
        else:
            metric_pass_str = str(metric_pass_value)
        outcomes.append(
            Outcome(
                path=pg_path,
                agent=row.get("agent", ""),
                task_type=row.get("task_type", ""),
                result=row.get("result", ""),
                confidence=row.get("confidence", ""),
                metric_pass=metric_pass_str,
                summary=(row.get("summary") or "")[:240],
                lesson=(row.get("lesson") or "")[:240],
                # revision_count: None/missing/unparseable → neutral 0.
                # evaluative_signal: preserve -1/0/+1 (None → neutral 0); do NOT
                # coerce a missing signal into success polarity.
                revision_count=_coerce_revision_count(row.get("revision_count")),
                evaluative_signal=_coerce_evaluative_signal(
                    row.get("evaluative_signal")
                ),
                # provenance for the synthesized-measurement-gap FAILURE carve-out
                attribution_source=str(row.get("attribution_source") or ""),
            )
        )
    return outcomes


def _fetch_generation_outcomes_from_filesystem(
    agent: str,
    yesterday_start: float,
    today_start: float,
    outcomes_dir: Path,
) -> list[Outcome]:
    """Legacy file fallback — match yesterday only via the YYYY-MM-DD filename token.

    filename: YYYY-MM-DD-HHMM_<agent>_<task_type>.md. Yesterday's date string is
    computed in the same LOCAL tz as _local_day_bounds for prefix matching.
    """
    if not outcomes_dir.exists():
        return []
    # Yesterday's date string (LOCAL tz) — the day before today_start.
    yesterday_date = datetime.fromtimestamp(yesterday_start).strftime("%Y-%m-%d")
    needle_agent = f"_{agent}_"

    matches: list[Path] = []
    for name in os.listdir(outcomes_dir):
        if not name.endswith(".md"):
            continue
        if needle_agent not in name:
            continue
        if not name.startswith(yesterday_date):
            continue
        matches.append(outcomes_dir / name)

    matches.sort(key=lambda p: p.name, reverse=True)
    outcomes: list[Outcome] = []
    for path in matches:
        try:
            outcomes.append(_parse_outcome_file(path))
        except OSError as exc:
            print(
                f"[daemon-cycle] WARN: outcome read failed: {path.name}: {exc}",
                file=sys.stderr,
            )
    return outcomes


_OUTCOME_FRONTMATTER_RE = re.compile(
    r"^---\s*\n(.*?)\n---", re.DOTALL | re.MULTILINE
)


def _parse_outcome_file(path: Path) -> Outcome:
    """Lightweight YAML frontmatter parser — enough for our known fields.

    Polarity signals (revision_count / evaluative_signal) are parsed WHEN PRESENT
    in the frontmatter; when ABSENT they default to NEUTRAL (0) — a legacy record
    with no signal is treated as neutral polarity, never coerced into success.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    m = _OUTCOME_FRONTMATTER_RE.match(text)
    fields: dict[str, str] = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" not in line:
                continue
            k, _, v = line.partition(":")
            fields[k.strip()] = v.strip().strip('"').strip("'")

    body_after = text[m.end():] if m else text

    # Best-effort summary/lesson extraction from markdown body.
    summary = _extract_field(body_after, ["summary"])
    lesson = _extract_field(body_after, ["lesson", "Lesson"])

    # revision_count: absent/unparseable → 0. evaluative_signal: absent → 0
    # (neutral); 0 and absent are both neutral here, only -1 is failure polarity.
    revision_count = _coerce_revision_count(fields.get("revision_count"))
    evaluative_signal = (
        _coerce_evaluative_signal(fields["evaluative_signal"])
        if "evaluative_signal" in fields
        else 0
    )

    return Outcome(
        path=str(path),
        agent=fields.get("agent", ""),
        task_type=fields.get("task_type", ""),
        result=fields.get("result", ""),
        confidence=fields.get("confidence", ""),
        metric_pass=fields.get("metric_pass", ""),
        summary=summary[:240],
        lesson=lesson[:240],
        revision_count=revision_count,
        evaluative_signal=evaluative_signal,
        # absent in legacy frontmatter → "" (neutral provenance)
        attribution_source=fields.get("attribution_source", ""),
    )


def _extract_field(body: str, keys: list[str]) -> str:
    """Return the first non-empty content under a Markdown heading matching any key."""
    for key in keys:
        # Match e.g. "## summary\n..." until next heading or blank-line block.
        pat = re.compile(
            rf"^#{{1,6}}\s+{re.escape(key)}\s*\n(.+?)(?=\n#{{1,6}}\s|\Z)",
            re.MULTILINE | re.DOTALL,
        )
        match = pat.search(body)
        if match:
            return match.group(1).strip().replace("\n", " ")[:1000]
    return ""


# -- generation step 3: ask Haiku for a patch proposal ----------------------


_PROMPT_TEMPLATE = """You are an instruction-tuning assistant for AutoAgent.

A learning pattern has been observed and queued for user review:

PATTERN:
- date: {pattern_date}
- agent: {pattern_agent}
- label: {pattern_label}
- frequency: {pattern_freq}

RECENT OUTCOMES for this agent (most-recent first):
{outcomes_block}

CURRENT AGENT INSTRUCTION FILE (target for patch):
path: {agent_path}
---
{agent_excerpt}
---

YOUR TASK:
Propose a SMALL, targeted patch (≤ 5 added lines) to the BODY (after the YAML
frontmatter, i.e. after the second '---') that addresses the observed failure
pattern. The patch should add a concrete guardrail, work-rule, or pre-execution
check that prevents recurrence. DO NOT touch the frontmatter (name/description/
tools/skills/scope). Where the file ALREADY carries a rule addressing this
signal, you MAY propose a diff that REPLACES that one rule in place (remove its
lines and add the superseding lines in the same hunk); where it does not, the
diff MUST be a pure ADD. Never rewrite unrelated rules.

Output STRICT format. The DIFF section MUST be raw unified-diff text with the
following exact headers (no ```diff fences, no ``` of any kind, no surrounding
prose). Use ONLY the bare filename as in this example:

RATIONALE: <one or two sentences explaining why this patch helps>
TOUCHES_FRONTMATTER: false
ADDED_LINES: <integer count of new lines>
DIFF:
--- a/{agent_basename}
+++ b/{agent_basename}
@@ -<line>,<count> +<line>,<count> @@
 <one or two context lines copied EXACTLY from the file above>
+<your new line(s) — '+' prefix on each>
 <one or two context lines copied EXACTLY from the file above>

Critical rules for the DIFF block:
- NO markdown fences (no ```, no ```diff). Raw lines only.
- Context lines MUST start with a single space and match the file byte-for-byte.
- New lines MUST start with '+' and NOT be wrapped in quotes.
- Place additions inside an `<!-- EDITABLE:BEGIN -->` / `<!-- EDITABLE:END -->`
  section when one exists for the topic — never edit outside editable regions.
"""


# Consolidated per-AGENT prompt — takes all of an agent's prior-day failure
# signals and authors one multi-hunk unified diff. All hunks share a single
# current-file snapshot, so one `git apply` applies them atomically (no intra-run
# cascade). Output format identical to the single-pattern _PROMPT_TEMPLATE.
_CONSOLIDATED_PROMPT_TEMPLATE = """You are an instruction-tuning assistant for AutoAgent.

Multiple learning signals for ONE agent have been observed over the previous
calendar day and queued for review. Author ONE consolidated patch.

TARGET AGENT: {pattern_agent}

OBSERVED LEARNING SIGNALS (patterns flagged for this agent):
{signals_block}
{avoid_patterns_block}{landed_history_block}
PRIOR-DAY OUTCOMES for this agent (most-recent first — ALL of yesterday):
{outcomes_block}

CURRENT AGENT INSTRUCTION FILE (target for patch):
path: {agent_path}
---
{agent_excerpt}
---

YOUR TASK:
Propose ONE coherent patch to the BODY (after the YAML frontmatter, i.e. after
the second '---') that addresses the observed failure signals. The patch MAY
contain MULTIPLE hunks (one per distinct location/signal) — author them ALL in a
SINGLE unified diff computed against the file shown above, so every hunk applies
atomically via one `git apply`. Each hunk adds a concrete guardrail, work-rule,
or pre-execution check that prevents recurrence. DO NOT touch the frontmatter
(name/description/tools/skills/scope). Where the file ALREADY carries a rule
addressing a signal, you MAY propose a diff that REPLACES that one rule in place
(remove its lines and add the superseding lines in the same hunk); where it does
not, that hunk MUST be a pure ADD. Never rewrite unrelated rules.
Keep the TOTAL added lines small (≤ 5 across all hunks).

Output STRICT format. The DIFF section MUST be raw unified-diff text with the
following exact headers (no ```diff fences, no ``` of any kind, no surrounding
prose). Use ONLY the bare filename as in this example:

RATIONALE: <one or two sentences explaining why this consolidated patch helps>
TOUCHES_FRONTMATTER: false
ADDED_LINES: <integer count of new lines across ALL hunks>
DIFF:
--- a/{agent_basename}
+++ b/{agent_basename}
@@ -<line>,<count> +<line>,<count> @@
 <one or two context lines copied EXACTLY from the file above>
+<your new line(s) — '+' prefix on each>
@@ -<line>,<count> +<line>,<count> @@
 <context line for the SECOND location, copied EXACTLY>
+<your new line(s) for the second hunk>

Critical rules for the DIFF block:
- NO markdown fences (no ```, no ```diff). Raw lines only.
- Context lines MUST start with a single space and match the file byte-for-byte.
- New lines MUST start with '+' and NOT be wrapped in quotes.
- Multiple hunks are encouraged when signals point to different sections — each
  hunk needs its own `@@ -L,N +L,N @@` header with context from THAT location.
- Place additions inside an `<!-- EDITABLE:BEGIN -->` / `<!-- EDITABLE:END -->`
  section when one exists for the topic — never edit outside editable regions.
"""

# Prompt-token guard for the consolidated outcomes block. With no sample cap,
# yesterday may hold many outcomes — every signal's compact 1-line summary is
# always included, but if the verbatim summary/lesson BODY total exceeds budget,
# only the BODY is truncated with an explicit (loud) note (never silent-drop).
GENERATION_OUTCOMES_BODY_BUDGET_CHARS = 8000


# IANA tz first components (+ legacy slash-bearing links like US/Pacific) — an
# allowlist keeps the tz-stamped reset notice detectable for ANY user timezone
# ([meta].timezone is free-form IANA), while generic "(word/word)" error text
# stays unmatched: a quota false-positive once masked a real failure, so
# precision is load-bearing here.
_IANA_TZ_REGIONS = (
    r"Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe"
    r"|Indian|Pacific|Etc|US|Canada|Mexico|Brazil|Chile"
)

# Quota-limit detection patterns. When the claude CLI exits non-zero, inspect
# (stderr + stdout) for budget / rate / usage ceiling signals. Match →
# parse_mode='quota-limit' (distinct from generic 'skipped') so run_cycle can
# surface haiku_status='skipped:quota-limit'. The quota check runs BEFORE
# _parse_haiku_response and short-circuits the retry.
_HAIKU_QUOTA_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Claude CLI session-cap message — "5-hour limit reached" / "Limit reached"
    re.compile(r"Limit\s+reached", re.IGNORECASE),
    # Claude CLI usage warning — "Usage ⚠ Limit" (Unicode warn sign variant)
    re.compile(r"Usage\s+.{0,3}\s*Limit", re.IGNORECASE),
    # NOTE: "Exceeded USD budget" is excluded here — a local --max-budget-usd
    # failure is a self-inflicted config error, not an external quota/rate cap,
    # so it routes to _detect_budget_too_low() (a quota false-positive once masked
    # a budget=0.005 bug).
    # Generic API quota signal — "quota exceeded" / "quota_exceeded"
    re.compile(r"quota[\s_-]*exceeded", re.IGNORECASE),
    # API rate-limit (anthropic 429 / openrouter throttle)
    re.compile(r"rate[\s_-]*limit", re.IGNORECASE),
    # Subscription cap message — "You're out of extra usage"
    re.compile(r"out\s+of\s+extra\s+usage", re.IGNORECASE),
    # CLI hint URL path — "/rate-limit-options" (explicit semantic intent)
    re.compile(r"/rate-limit-options", re.IGNORECASE),
    # tz-stamped reset notice — "resets ... (<IANA Region/City>)"
    re.compile(rf"\((?:{_IANA_TZ_REGIONS})/[A-Za-z0-9_+\-/]+\)", re.IGNORECASE),
)


def _detect_quota_limit(stderr: str, stdout: str) -> bool:
    """Return True iff the CLI output exhibits a quota-limit signature.

    Searches the concatenated (stderr + stdout) — quota messages appear in
    either stream depending on CLI version. Compiled patterns module-level
    avoid per-call recompile cost.
    """
    combined = (stderr or "") + "\n" + (stdout or "")
    return any(pat.search(combined) for pat in _HAIKU_QUOTA_PATTERNS)


# Local --max-budget-usd ceiling signal — a self-inflicted config failure,
# distinct from external quota. Split out of the quota set (the false-positive was
# the root cause of disguising it as external quota).
_BUDGET_TOO_LOW_PATTERN: re.Pattern[str] = re.compile(
    r"Exceeded\s+USD\s+budget", re.IGNORECASE
)


def _detect_budget_too_low(stderr: str, stdout: str) -> bool:
    """Return True iff the CLI tripped the LOCAL --max-budget-usd ceiling.

    Distinct from ``_detect_quota_limit`` — this is a self-inflicted local
    budget-config failure, NOT an external Anthropic quota/rate cap.
    """
    combined = (stderr or "") + "\n" + (stdout or "")
    return bool(_BUDGET_TOO_LOW_PATTERN.search(combined))


# Auth-failure detection patterns. The launchd 04:30 `claude -p` Haiku call runs
# in a non-interactive session that cannot refresh an expired Keychain OAuth
# token → returncode 1 + "API Error: 401 Invalid authentication credentials".
# This is INFRA (credential), NOT a quality reject and NOT a usage/quota cap —
# misclassifying it as quota mislabels the cost-guard chip as a "Spending guard"
# warning. The auth check runs BEFORE quota/budget so a 401 routes to
# parse_mode='auth-failure' → haiku_status='skipped:auth'.
#
# PRECISION-CONSTRAINED (auth runs before quota → an over-broad pattern would
# STEAL a genuine quota signal):
#   - NO bare "unauthorized" token — it matches the quota string
#     "unauthorized region blocked by rate-limit" (which must still → quota).
#   - 403 ONLY anchored as "API Error: 403" / "HTTP 403" — a bare \b403\b would
#     match path tokens like /v1/403-foo.
# The "401 The socket connection was closed unexpectedly" variant is caught ONLY
# when the CLI prefixes it with "API Error: 401" (the realistic shape). A BARE
# "401 The socket..." string (no prefix) falls through to the generic non-zero
# branch — acceptable: no misclassification, no quota theft. A bare \b401\b is
# deliberately NOT added (it would match path/version tokens).
_HAIKU_AUTH_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"Invalid\s+authentication\s+credentials", re.IGNORECASE),
    re.compile(r"Failed\s+to\s+authenticate", re.IGNORECASE),
    re.compile(r"API\s+Error:\s*401", re.IGNORECASE),
    re.compile(r"HTTP\s*401", re.IGNORECASE),
    re.compile(r"API\s+Error:\s*403", re.IGNORECASE),
    re.compile(r"HTTP\s*403", re.IGNORECASE),
)


def _detect_auth_failure(stderr: str, stdout: str) -> bool:
    """Return True iff the CLI output exhibits an AUTH/credential signature.

    Searches concatenated (stderr + stdout) for 401/403 credential-failure
    signals (expired non-interactive OAuth token). Distinct from
    ``_detect_quota_limit`` (external usage cap) and ``_detect_budget_too_low``
    (local config). PRECISION-CONSTRAINED so the quota string "unauthorized
    region blocked by rate-limit" never matches here (it must still → quota).
    """
    combined = (stderr or "") + "\n" + (stdout or "")
    return any(pat.search(combined) for pat in _HAIKU_AUTH_PATTERNS)


# Credential/token-shaped substrings that MUST be scrubbed before a failure
# stream head is persisted into the cycle report row. A 401 error stream can echo
# the rejected token; the serialized row is a stored, broadly-read artifact (PG +
# monitor dashboard), so it MUST NOT carry a live-looking credential.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),         # Anthropic API key
    re.compile(r"sk-[A-Za-z0-9]{20,}"),                # generic sk- key
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]{12,}", re.IGNORECASE),  # bearer token
    re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),  # JWT
)
_SECRET_PLACEHOLDER = "[REDACTED]"


def redact_secrets(text: str) -> str:
    """Scrub credential/token-shaped substrings from a failure stream head.

    Security (LLM02 / core-security Secret Management): the failure_raw_head field
    is persisted into the cycle report JSON + PG, which the monitor dashboard
    reads. A 401 stream may echo the rejected token, so credential-shaped
    substrings are replaced with a placeholder before storage. Bounded, pure, no
    side effects.
    """
    if not text:
        return ""
    scrubbed = text
    for pat in _SECRET_PATTERNS:
        scrubbed = pat.sub(_SECRET_PLACEHOLDER, scrubbed)
    return scrubbed


def flatten_log_field(value: object, *, default: str = "") -> str:
    """Collapse one interpolated value into a single line of a log record.

    Security (LLM05 Improper Output Handling): the pre-verify status, axis keys
    and rationale are LLM-authored — the rationale is parsed with ``re.DOTALL``
    and is routinely multi-line — yet they are interpolated into one-line stderr
    records an operator reads as update-log entries. An embedded line terminator
    ends the record early and starts a fresh one that reads as a genuine entry,
    so a rejection can forge an acceptance. Treat every interpolated field as
    untrusted DATA, not as text being formatted.

    ``str.split()`` with no argument splits on every ``str.isspace()`` character,
    so one definition covers \\n, \\r, \\t, U+0085 NEL, U+2028 LINE SEPARATOR and
    U+2029 — the set a log file, a terminal, an editor and a JS-based viewer may
    each break on. Content is preserved in full (whitespace runs collapse to a
    single space); nothing is truncated or dropped, so a multi-line rationale
    arrives as ONE legible record instead of several forgeable ones.

    Bounded, pure, no side effects. Scope limit, stated so it is not assumed
    wider: this guarantees one record per event. It does NOT address field
    confusion WITHIN a record — a rationale may still contain the text
    ``status=`` — which is tolerable while these records are read by humans and
    parsed by nothing.
    """
    # `value or ""` would fold a falsy non-None value (0, False) into the default,
    # dropping content the docstring above promises to preserve.
    text = " ".join(("" if value is None else str(value)).split())
    return text or default


# Transient-infra detection patterns. A non-zero CLI exit (or a timeout) whose
# output exhibits a TRANSIENT signature — Overloaded / HTTP 529 / connection reset
# / temporary unavailability — is an ephemeral infra blip (the fixed 04:30 KST run
# coincides with a backend overload window). Unlike quota / budget-too-low (which
# are FUTILE to retry — the cap is real), a transient failure is recoverable by a
# short bounded backoff retry → parse_mode='transient-overload' on exhaustion →
# haiku_status='skipped:transient'. The transient check MUST run BEFORE
# budget-too-low / quota so those keep their no-retry short-circuit (re-calling a
# real cap is wasted spend, LLM10). Compiled module-level → no per-call recompile.
_TRANSIENT_OVERLOAD_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"overloaded_error", re.IGNORECASE),
    re.compile(r"Overloaded", re.IGNORECASE),
    re.compile(r"API\s+Error:\s*529", re.IGNORECASE),
    re.compile(r"(?<!\d)529(?!\d)"),
    re.compile(r"(?<!\d)503(?!\d)"),
    re.compile(r"service\s+unavailable", re.IGNORECASE),
    re.compile(r"temporarily\s+unavailable", re.IGNORECASE),
    re.compile(r"fetch\s+failed", re.IGNORECASE),
    re.compile(r"request\s+(?:timed\s+out|timeout)", re.IGNORECASE),
    re.compile(r"ECONNRESET", re.IGNORECASE),
    re.compile(r"connection\s+reset", re.IGNORECASE),
    re.compile(r"network\s+error", re.IGNORECASE),
)


def _detect_transient_overload(stderr: str, stdout: str) -> bool:
    """Return True iff the CLI output exhibits a TRANSIENT infra signature.

    Searches concatenated (stderr + stdout) for ephemeral backend-overload /
    network-blip signals (Overloaded, HTTP 529/503, connection reset, fetch
    failed, request timeout). Distinct from ``_detect_quota_limit`` /
    ``_detect_budget_too_low`` — those are real caps (no retry), this class is
    recoverable by a short bounded backoff retry.
    """
    combined = (stderr or "") + "\n" + (stdout or "")
    return any(pat.search(combined) for pat in _TRANSIENT_OVERLOAD_PATTERNS)


# Bounded transient-overload retry budget (LLM10 unbounded-consumption guard).
# MAX = 2 retries → 3 attempts total. Each retry re-invokes _invoke_haiku_cli,
# which re-passes --max-budget-usd so per-call USD spend stays CLI-bounded; the
# retry count itself is bounded here. Exponential backoff base (seconds) + jitter
# ceiling spread the retries off the synchronized 04:30 overload window.
MAX_TRANSIENT_RETRIES = 2
_TRANSIENT_BACKOFF_BASE_SEC = 2.0
_TRANSIENT_BACKOFF_JITTER_SEC = 1.0
# Timeout-class backoff — FLAT (constant + jitter), not the exponential ladder.
# A timeout already burned HAIKU_TIMEOUT_SEC → a 2s wait retries into the stall.
# Flat over exponential: doubling the 2nd wait buys no extra stall clearance.
# Band 30-60s; env-overridable (a chronically slower backend wants the top).
# Orthogonal to the escalated retry bound — the wait clears the stall, the bound
# sizes the call.
_TRANSIENT_TIMEOUT_BACKOFF_SEC = float(
    os.environ.get("AUTOAGENT_TRANSIENT_TIMEOUT_BACKOFF_SEC", "45.0") or "45.0"
)


# Strict re-prompt suffix for retry-on-parse-failure. Appended to the original
# prompt on retry; the rest of the prompt (PATTERN / OUTCOMES / CURRENT AGENT
# FILE) is identical to preserve idempotency. Header format is the canonical
# contract that `_parse_haiku_response` strict regex expects.
_HAIKU_STRICT_RETRY_SUFFIX = """

CRITICAL — STRICT FORMAT REQUIRED (retry attempt):
Your previous response did not include the required `RATIONALE:` and `DIFF:`
header markers. Output MUST start with these exact tokens on their own lines,
no preamble, no markdown, no commentary:

RATIONALE: <one paragraph — single line — explaining why this patch helps>
TOUCHES_FRONTMATTER: false
ADDED_LINES: <integer>
DIFF:
<unified-diff text — raw lines, no fences>

Failure to emit these EXACT headers will cause the patch to be auto-rejected.
"""


def _probe_anthropic_reachable() -> str:
    """Bounded FAIL-OPEN DNS/TCP reachability probe to the Anthropic API host.

    LLM10 / Loud-Fail: this is diagnostic instrumentation only — it MUST NEVER
    raise, fail, or block the cycle. A probe error is itself a captured datum
    ('probe-error'), not a fault. Bounded to HAIKU_PROBE_TIMEOUT_SEC (~2s) so a
    network stall cannot stretch the failure boundary.

    Returns one of: 'reachable' | 'unreachable' | 'probe-error'. DNS/TCP only —
    no TLS handshake, no HTTP request (the goal is "could we reach the host",
    distinguishing a network outage from an API-side failure).
    """
    try:
        with socket.create_connection(
            (HAIKU_PROBE_HOST, HAIKU_PROBE_PORT), timeout=HAIKU_PROBE_TIMEOUT_SEC
        ):
            return "reachable"
    except (OSError, socket.timeout):
        # Network unreachable / DNS failure / connection refused / timeout — a
        # genuine "host not reachable" verdict (still fail-open, never raises).
        return "unreachable"
    except Exception:  # noqa: BLE001 — fail-open: a probe must never break the cycle
        return "probe-error"


@dataclass(frozen=True)
class HaikuFailureEvidence:
    """Structured per-call Haiku-failure evidence (Loud-Fail instrumentation).

    The six failure_* fields are spread explicitly onto the PatchProposal in
    _build_failure_proposal so the discriminator + per-call evidence survive
    in-process and into the cycle report JSON. failure_class is supplied
    separately by the caller (the classify_failure_rationale taxonomy — the
    single SoT).
    """

    failure_returncode: int | None
    failure_signal: str
    failure_duration_ms: int | None
    failure_attempt: int | None
    failure_probe_result: str
    failure_log_path: str


def _capture_haiku_failure(
    *,
    agent: str,
    attempt: int,
    returncode: int | None,
    duration_ms: int | None,
    stderr: str,
    stdout: str,
) -> HaikuFailureEvidence:
    """Capture structured Haiku-failure evidence BEFORE the raw_response collapse.

    Returns the structured fields (decoded signal, bounded reachability probe,
    per-call untruncated log path) that the PatchProposal failure_* fields carry.
    Every side effect (network probe, log write) is FAIL-OPEN per LLM10 / Loud-
    Fail — an instrumentation error must NEVER raise or block the cycle. The
    caller supplies failure_class separately (the classify_failure_rationale
    taxonomy) so the in-cycle class stays the single SoT.

    The per-call log filename is <cycle_date>-<agent>-<attempt>.log and is NEVER
    overwritten across calls — it preserves the FULL untruncated stderr+stdout
    that the rationale's raw_response[:400] collapse destroys (the evidence whose
    absence made the 04:30 failures undiagnosable).
    """
    # Decode a signal-terminated subprocess (negative returncode → signal name)
    # so a SIGKILL/SIGTERM is told apart from an ordinary non-zero exit.
    signal_name = ""
    if returncode is not None and returncode < 0:
        try:
            signal_name = signal.Signals(-returncode).name
        except (ValueError, AttributeError):
            signal_name = f"signal-{-returncode}"

    probe_result = _probe_anthropic_reachable()

    cycle_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_path = HAIKU_FAILURE_LOG_DIR / f"{cycle_date}-{agent}-{attempt}.log"
    written_path = ""
    try:
        HAIKU_FAILURE_LOG_DIR.mkdir(parents=True, exist_ok=True)
        body = (
            f"cycle_date={cycle_date} agent={agent} attempt={attempt}\n"
            f"returncode={returncode} signal={signal_name or '-'} "
            f"duration_ms={duration_ms} probe={probe_result}\n"
            f"--- stderr ---\n{stderr or ''}\n"
            f"--- stdout ---\n{stdout or ''}\n"
        )
        log_path.write_text(body, encoding="utf-8")
        written_path = str(log_path)
    except OSError as exc:
        # Log-write failure is captured, NOT fatal (fail-open). The structured
        # fields below still survive in-process + in the cycle report JSON.
        sys.stderr.write(
            f"[daemon-cycle] haiku-failure-log write failed for "
            f"{agent} attempt={attempt}: {type(exc).__name__}: {str(exc)[:200]}\n"
        )

    return HaikuFailureEvidence(
        failure_returncode=returncode,
        failure_signal=signal_name,
        failure_duration_ms=duration_ms,
        failure_attempt=attempt,
        failure_probe_result=probe_result,
        failure_log_path=written_path,
    )


def _build_failure_proposal(
    *,
    target_file: Path,
    rationale: str,
    raw_response: str,
    parse_mode: str,
    attempt: int,
    duration_ms: int | None,
    completed: subprocess.CompletedProcess[str] | None,
) -> PatchProposal:
    """Build a failure PatchProposal with structured Loud-Fail evidence attached.

    Single boilerplate site for the 5 Haiku failure branches — captures the
    structured evidence (signal / duration / attempt / bounded probe / per-call
    untruncated log) and derives failure_class from classify_failure_rationale so
    the in-cycle class is the same single SoT the persisted-history de-conflation
    keys on. completed=None covers the timeout/CLI-missing early-exit paths.
    """
    evidence = _capture_haiku_failure(
        agent=target_file.stem,
        attempt=attempt,
        returncode=(completed.returncode if completed is not None else None),
        duration_ms=duration_ms,
        stderr=(completed.stderr if completed is not None else ""),
        stdout=(completed.stdout if completed is not None else ""),
    )
    return PatchProposal(
        target_file=str(target_file),
        rationale=rationale,
        proposed_diff="",
        touched_frontmatter=False,
        estimated_added_lines=0,
        raw_response=raw_response,
        parse_mode=parse_mode,
        failure_class=classify_failure_rationale(rationale),
        **asdict(evidence),
    )


def _invoke_haiku_cli(
    *,
    prompt: str,
    claude_bin: str,
    timeout_sec: int,
) -> tuple[subprocess.CompletedProcess[str] | None, PatchProposal | None, int]:
    """Run one Haiku CLI invocation. Returns (completed, None, duration_ms) on
    success, or (None, error_proposal_partial, duration_ms) when an early-exit
    PatchProposal must be returned to the caller.

    `duration_ms` is the wall-clock call duration (perf_counter delta) measured
    around the SINGLE subprocess.run call site — captured for ALL paths (success,
    timeout, CLI-missing) so the failure boundary can record it.

    The `error_proposal_partial` is partial — caller fills `target_file` field
    based on its scope. Returned with empty target_file/parse_mode='skipped'.
    """
    started = time.perf_counter()
    try:
        completed = subprocess.run(  # nosec — list form, no shell=True
            [
                claude_bin,
                "-p", prompt,
                "--output-format", "text",
                "--max-budget-usd", HAIKU_MAX_BUDGET_USD,
                "--model", HAIKU_MODEL,
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
            env={**os.environ, "OTEL_METRICS_EXPORTER": "none"},
        )
        duration_ms = int((time.perf_counter() - started) * 1000)
        return completed, None, duration_ms
    except subprocess.TimeoutExpired as exc:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return None, PatchProposal(
            target_file="",
            rationale=f"{HAIKU_TIMEOUT_RATIONALE_PREFIX} {timeout_sec}s",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response=str(exc)[:200],
            parse_mode="skipped",
        ), duration_ms
    except FileNotFoundError as exc:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return None, PatchProposal(
            target_file="",
            rationale=f"claude CLI not found: {claude_bin}",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response=str(exc)[:200],
            parse_mode="skipped",
        ), duration_ms


def generate_patch_proposal(
    pattern: Pattern,
    outcomes: list[Outcome],
    agents_dir: Path = DEFAULT_AGENTS_DIR,
    *,
    claude_bin: str = CLAUDE_BIN,
    timeout_sec: int = HAIKU_TIMEOUT_SEC,
    skip_haiku: bool = False,
) -> PatchProposal:
    """Invoke Haiku via `claude -p` to produce a patch proposal for `pattern.agent`.

    `skip_haiku=True` returns an empty proposal — useful for unit tests and when
    the cost guard or preflight has tripped.

    On first-attempt parse failure (parse_mode='failed'), retry ONCE with a
    strict header-emphasis suffix appended. Retry budget: 1 attempt — cost
    ceiling stays at 5 patterns × 2 calls × $0.50 = $5.00/cycle worst case.
    Idempotency: retry prompt body is identical except for the strict suffix
    (same PATTERN / OUTCOMES / AGENT FILE inputs → same expectations).
    """
    target_file = agents_dir / f"{pattern.agent}.md"
    if not target_file.exists():
        return PatchProposal(
            target_file=str(target_file),
            rationale=f"target agent file not found: {target_file.name}",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="skipped",
        )

    if skip_haiku:
        return PatchProposal(
            target_file=str(target_file),
            rationale="skip_haiku=True (test/preflight)",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="skipped",
        )

    # Whole body: a head slice hides the editable regions the model must edit into.
    agent_text = target_file.read_text(encoding="utf-8")

    outcomes_block = _render_outcomes_block(outcomes) or "(no recent outcomes sampled)"
    base_prompt = _PROMPT_TEMPLATE.format(
        pattern_date=pattern.date,
        pattern_agent=pattern.agent,
        pattern_label=_neutralize_field(pattern.label),
        pattern_freq=pattern.frequency,
        outcomes_block=outcomes_block,
        agent_path=str(target_file),
        agent_excerpt=agent_text,
        agent_basename=target_file.name,
    )

    return _run_haiku_with_retry(
        base_prompt=base_prompt,
        target_file=target_file,
        label_hint=pattern.label,
        claude_bin=claude_bin,
        timeout_sec=timeout_sec,
    )


def generate_consolidated_proposal(
    agent: str,
    patterns: list[Pattern],
    outcomes: list[Outcome],
    agents_dir: Path = DEFAULT_AGENTS_DIR,
    *,
    claude_bin: str = CLAUDE_BIN,
    timeout_sec: int = HAIKU_TIMEOUT_SEC,
    skip_haiku: bool = False,
) -> PatchProposal:
    """Author ONE consolidated multi-hunk proposal from all of an agent's signals.

    The per-TARGET (not per-PATTERN) core. `patterns` = all Patterns grouped for
    that agent (≥1). `outcomes` = all of yesterday (no cap). Single current-file
    snapshot diff → all hunks apply atomically via one `git apply` (no intra-run
    cascade).

    `skip_haiku=True` → empty proposal (test/preflight). The Haiku
    invoke+parse+retry core is shared with generate_patch_proposal via
    _run_haiku_with_retry.

    Args:
        agent: target agent.
        patterns: Pattern list grouped for that agent (≥1).
        outcomes: all of yesterday's outcomes.
        agents_dir: agent .md directory.
        claude_bin / timeout_sec / skip_haiku: invoke options.

    Returns:
        PatchProposal — target_file = <agent>.md.
    """
    target_file = agents_dir / f"{agent}.md"
    if not target_file.exists():
        return PatchProposal(
            target_file=str(target_file),
            rationale=f"target agent file not found: {target_file.name}",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="skipped",
        )

    if skip_haiku:
        return PatchProposal(
            target_file=str(target_file),
            rationale="skip_haiku=True (test/preflight)",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="skipped",
        )

    # Whole body: a head slice hides the editable regions the model must edit into.
    agent_text = target_file.read_text(encoding="utf-8")
    signals_block = _render_signals_block(patterns)
    outcomes_block = _render_generation_outcomes_block(outcomes)

    # Optimizer-side memory (SkillOpt R2): prepend this agent's known-bad
    # diff shapes. PG-off / empty-history → "" → block omitted cleanly.
    failures = _fetch_pre_verify_failures(agent)
    failures_body = _render_pre_verify_failures_block(failures) if failures else ""
    avoid_patterns_block = (
        "diff types that previously failed pre_verify for this agent "
        "(patterns to avoid):\n" + failures_body + "\n"
        if failures_body
        else ""
    )

    # Feedback half of that memory: what this agent already landed.
    landed = _fetch_landed_proposals(agent)
    landed_body = _render_landed_history_block(landed) if landed else ""
    landed_history_block = (
        "rules that previously LANDED for this agent "
        "(already in the body — build on them, never re-propose them):\n"
        + landed_body
        + "\n"
        if landed_body
        else ""
    )

    base_prompt = _CONSOLIDATED_PROMPT_TEMPLATE.format(
        pattern_agent=agent,
        signals_block=signals_block,
        avoid_patterns_block=avoid_patterns_block,
        landed_history_block=landed_history_block,
        outcomes_block=outcomes_block,
        agent_path=str(target_file),
        agent_excerpt=agent_text,
        agent_basename=target_file.name,
    )

    label_hint = patterns[0].label if patterns else agent
    return _run_haiku_with_retry(
        base_prompt=base_prompt,
        target_file=target_file,
        label_hint=label_hint,
        claude_bin=claude_bin,
        timeout_sec=timeout_sec,
    )


def _run_haiku_with_retry(
    *,
    base_prompt: str,
    target_file: Path,
    label_hint: str,
    claude_bin: str,
    timeout_sec: int,
) -> PatchProposal:
    """Shared Haiku invoke → parse → (on parse-fail) one strict-suffix retry core.

    Both generate_patch_proposal and generate_consolidated_proposal route through
    this helper, guaranteeing identical quota-limit / non-zero-exit / fuzzy /
    retried branch semantics.

    Two distinct retry mechanisms, by failure class:
      - TRANSIENT infra failure: bounded backoff retry loop on Attempt 1 — the
        transient check runs BEFORE the budget-too-low / quota branches so those
        real caps still short-circuit with NO retry. The loop splits by class:
          * TIMEOUT → exactly 2 attempts, the second at HAIKU_ESCALATED_TIMEOUT_SEC.
            Re-running an identical bound that already killed the call is futile,
            so the escalation doubles as the discriminator: completing at the
            longer bound was slow generation (escalated_timeout=True → an
            ':escalated' haiku_status suffix), timing out again is a true stall
            (parse_mode='timeout-stall' → haiku_status='skipped:timeout-stall').
          * OVERLOAD (529 / Overloaded / connection reset) → unchanged exponential
            ladder, MAX_TRANSIENT_RETRIES (3 attempts) → parse_mode=
            'transient-overload' → haiku_status='skipped:transient'.
      - parse failure (parse_mode='failed' after a clean returncode==0): one
        strict-suffix retry (Attempt 2), unchanged.
    """
    # -- Attempt 1 (+ bounded transient-overload retries) -------------------
    # Wrap the original-prompt invocation in a bounded retry loop. A TRANSIENT
    # infra failure (Overloaded / 529 / connection reset / timeout) is the only
    # class that retries here — it is ephemeral, so a short backoff often
    # recovers. Budget-too-low / quota are NOT transient (real caps), so they
    # fall through below with NO retry (re-calling is wasted spend, LLM10).
    # Bound: MAX_TRANSIENT_RETRIES (2 → 3 attempts total); each retry re-passes
    # --max-budget-usd so per-call USD spend stays CLI-bounded.
    completed: subprocess.CompletedProcess[str] | None = None
    early_exit: PatchProposal | None = None
    last_transient_raw: str = ""
    last_transient_was_timeout = False
    last_attempt = 0
    last_duration_ms = 0
    timeout_attempts = 0
    effective_timeout_sec = timeout_sec
    for attempt in range(MAX_TRANSIENT_RETRIES + 1):
        completed, early_exit, last_duration_ms = _invoke_haiku_cli(
            prompt=base_prompt, claude_bin=claude_bin, timeout_sec=effective_timeout_sec
        )
        last_attempt = attempt

        # A TimeoutExpired early-exit is treated as transient (an ephemeral
        # backend stall). FileNotFoundError (CLI missing) is NOT transient — its
        # rationale lacks the timeout prefix, so it falls through unchanged.
        is_timeout_transient = (
            early_exit is not None
            and early_exit.rationale.startswith(HAIKU_TIMEOUT_RATIONALE_PREFIX)
        )
        is_exit_transient = (
            early_exit is None
            and completed is not None
            and completed.returncode != 0
            and _detect_transient_overload(completed.stderr, completed.stdout)
        )

        if not (is_timeout_transient or is_exit_transient):
            break  # not a transient failure → leave the loop, handle below

        # Record this transient attempt so exhaustion can report it.
        last_transient_was_timeout = is_timeout_transient
        if is_timeout_transient:
            assert early_exit is not None
            last_transient_raw = early_exit.raw_response
        else:
            assert completed is not None
            last_transient_raw = (completed.stderr or completed.stdout or "")[:400]

        if is_timeout_transient and timeout_attempts >= 1:
            # The escalated attempt itself stalled → a TRUE stall, not slow
            # generation. Exhaust here: the discriminator already answered, so a
            # third identical attempt buys nothing (LLM10 bounded consumption).
            sys.stderr.write(
                f"[daemon-cycle] WARN: haiku true stall for {target_file.name} "
                f"(pattern={label_hint!r}) — base {timeout_sec}s + escalated "
                f"{effective_timeout_sec}s both timed out, giving up\n"
            )
            return _build_failure_proposal(
                target_file=target_file,
                rationale=(
                    f"{HAIKU_TIMEOUT_RATIONALE_PREFIX} {timeout_sec}s + escalated "
                    f"{effective_timeout_sec}s — true stall (escalated retry also "
                    "timed out)"
                ),
                raw_response=last_transient_raw,
                parse_mode="timeout-stall",
                attempt=attempt,
                duration_ms=last_duration_ms,
                completed=completed,
            )

        if attempt >= MAX_TRANSIENT_RETRIES:
            # Retries exhausted — surface a distinct transient-overload proposal
            # so run_cycle maps haiku_status='skipped:transient' (an infra blip,
            # NOT a genuinely empty/parse-failed output).
            #
            # Rationale-prefix preservation: when the exhausted class was a
            # TIMEOUT, the rationale MUST still begin with
            # HAIKU_TIMEOUT_RATIONALE_PREFIX so the unchanged chronic-timeout
            # back-off counter (consecutive_timeout_count) still recognizes the
            # persisted row. A non-timeout transient (529 / Overloaded / reset)
            # carries the transient-overload rationale (no prefix collision).
            sys.stderr.write(
                f"[daemon-cycle] WARN: haiku transient overload for "
                f"{target_file.name} (pattern={label_hint!r}) — "
                f"{MAX_TRANSIENT_RETRIES} retries exhausted, giving up\n"
            )
            if last_transient_was_timeout:
                exhausted_rationale = (
                    f"{HAIKU_TIMEOUT_RATIONALE_PREFIX} {timeout_sec}s "
                    f"(transient — {MAX_TRANSIENT_RETRIES + 1} attempts exhausted)"
                )
            else:
                exhausted_rationale = (
                    "haiku transient overload — "
                    f"{MAX_TRANSIENT_RETRIES + 1} attempts exhausted "
                    "(Overloaded / 529 / network blip); not retried further"
                )
            return _build_failure_proposal(
                target_file=target_file,
                rationale=exhausted_rationale,
                raw_response=last_transient_raw,
                parse_mode="transient-overload",
                attempt=attempt,
                duration_ms=last_duration_ms,
                completed=completed,
            )

        # Backoff before the next attempt — class-aware, re-decided each attempt.
        # Overload → exponential 2s ladder (spreads off the 04:30 overload window).
        # Timeout → flat band, since the stall already consumed the whole timeout_sec.
        # Not sticky — a mixed timeout→overload ladder keeps overload fast.
        # Timeout-class worst case: base 180s + flat 45s wait + escalated 300s
        # = ~525s wall clock, then the chronic-streak skip caps the repeat.
        if is_timeout_transient:
            # One escalation per call, MONOTONIC — a slow generation needs the
            # longer bound on every remaining attempt, including a mixed
            # timeout → overload tail.
            timeout_attempts = 1
            effective_timeout_sec = HAIKU_ESCALATED_TIMEOUT_SEC
            base = _TRANSIENT_TIMEOUT_BACKOFF_SEC
        else:
            base = _TRANSIENT_BACKOFF_BASE_SEC * (2 ** attempt)
        backoff = base + random.uniform(0.0, _TRANSIENT_BACKOFF_JITTER_SEC)
        sys.stderr.write(
            f"[daemon-cycle] WARN: haiku transient overload for "
            f"{target_file.name} (attempt {attempt + 1}/"
            f"{MAX_TRANSIENT_RETRIES + 1}) — retrying in {backoff:.1f}s\n"
        )
        time.sleep(backoff)

    if early_exit is not None:
        # Non-transient early-exit (CLI not found, or a non-transient timeout that
        # cannot occur here). Fix target_file field which _invoke_haiku_cli left
        # blank, and attach structured evidence (completed is None on this path —
        # there is no returncode/stream to capture, so the evidence carries the
        # duration + bounded probe + class only).
        return _build_failure_proposal(
            target_file=target_file,
            rationale=early_exit.rationale,
            raw_response=early_exit.raw_response,
            parse_mode=early_exit.parse_mode,
            attempt=last_attempt,
            duration_ms=last_duration_ms,
            completed=None,
        )

    assert completed is not None  # narrowed by early_exit branch above
    if completed.returncode != 0:
        # Detect AUTH/401 failure FIRST (before budget/quota/generic). The
        # launchd 04:30 non-interactive session cannot refresh an expired
        # Keychain OAuth token → "API Error: 401 Invalid authentication
        # credentials". This is INFRA (credential), NOT a usage/quota cap —
        # routing it to quota mislabels the cost-guard chip as a spending
        # warning. parse_mode='auth-failure' → haiku_status='skipped:auth'.
        # No retry: a 401 already broke the transient loop above
        # (is_exit_transient=False), and re-calling an expired credential is
        # futile. The precision-constrained patterns never steal a quota signal.
        if _detect_auth_failure(completed.stderr, completed.stdout):
            return _build_failure_proposal(
                target_file=target_file,
                rationale=(
                    f"haiku auth failure (401/credential) "
                    f"(returncode={completed.returncode})"
                ),
                raw_response=(completed.stderr or completed.stdout or "")[:400],
                parse_mode="auth-failure",
                attempt=last_attempt,
                duration_ms=last_duration_ms,
                completed=completed,
            )
        # Detect local budget-config failure (before quota). A local
        # --max-budget-usd ceiling miss is a self-inflicted config error, not
        # external quota → parse_mode='budget-too-low' → haiku_status=
        # 'skipped:budget-too-low'. Retry skipped — re-calling a config bug is futile.
        if _detect_budget_too_low(completed.stderr, completed.stdout):
            return _build_failure_proposal(
                target_file=target_file,
                rationale=(
                    f"local --max-budget-usd ceiling too low "
                    f"(HAIKU_MAX_BUDGET_USD={HAIKU_MAX_BUDGET_USD}, "
                    f"returncode={completed.returncode}); NOT an external quota cap"
                ),
                raw_response=(completed.stderr or completed.stdout or "")[:400],
                parse_mode="budget-too-low",
                attempt=last_attempt,
                duration_ms=last_duration_ms,
                completed=completed,
            )
        # Split quota-limit from generic exit error.
        # Quota detected → distinct parse_mode='quota-limit' so run_cycle
        # surfaces haiku_status='skipped:quota-limit' (monitor #improvement
        # dashboard can flag exhausted budget vs. generic CLI failure).
        # Retry skipped — pointless to re-invoke when budget exhausted.
        is_quota = _detect_quota_limit(completed.stderr, completed.stdout)
        if is_quota:
            return _build_failure_proposal(
                target_file=target_file,
                rationale=(
                    f"haiku quota limit detected "
                    f"(returncode={completed.returncode})"
                ),
                raw_response=(completed.stderr or completed.stdout or "")[:400],
                parse_mode="quota-limit",
                attempt=last_attempt,
                duration_ms=last_duration_ms,
                completed=completed,
            )
        return _build_failure_proposal(
            target_file=target_file,
            rationale=f"haiku non-zero exit {completed.returncode}",
            raw_response=(completed.stderr or completed.stdout or "")[:400],
            parse_mode="skipped",
            attempt=last_attempt,
            duration_ms=last_duration_ms,
            completed=completed,
        )

    first_proposal = _parse_haiku_response(completed.stdout, target_file)

    # Happy path — strict or fuzzy parsed clean.
    if first_proposal.parse_mode in ("strict", "fuzzy"):
        # Attach the successful call's wall clock; _parse_haiku_response never sees it.
        # An escalated attempt that parses clean = slow generation, not a stall —
        # recorded on the orthogonal flag so strict-vs-fuzzy still reaches the
        # payload (haiku_status='ok:escalated' / 'ok:fuzzy-parsed:escalated').
        return replace(
            first_proposal,
            escalated_timeout=bool(timeout_attempts),
            generation_duration_ms=last_duration_ms,
        )

    # -- Attempt 2: retry with strict header suffix ------------------------
    # Triggered ONLY on parse_mode='failed' — fuzzy + strict both missed.
    sys.stderr.write(
        f"[daemon-cycle] WARN: first Haiku response unparseable for "
        f"{target_file.name} (signal={label_hint!r}) — retrying with "
        f"strict header suffix\n"
    )
    retry_prompt = base_prompt + _HAIKU_STRICT_RETRY_SUFFIX
    retry_completed, retry_early_exit, retry_duration_ms = _invoke_haiku_cli(
        prompt=retry_prompt, claude_bin=claude_bin, timeout_sec=effective_timeout_sec
    )
    if retry_early_exit is not None or retry_completed is None:
        # Retry crashed (timeout / CLI not found) — keep first failure record.
        return first_proposal
    if retry_completed.returncode != 0:
        # Retry non-zero exit — preserve first attempt's failure trail.
        return first_proposal

    retry_proposal = _parse_haiku_response(retry_completed.stdout, target_file)

    # If retry parsed cleanly, prefer retry result with explicit 'retried' tag
    # (NOT 'strict') — caller (run_cycle) detects this via parse_mode and
    # records haiku_status='ok:retried'. Per C2: no silent coerce.
    # The retry inherits the ladder's bound (effective_timeout_sec), so it also
    # inherits the escalation fact — otherwise an escalated-bound retry reads as
    # a normal-bound one.
    if retry_proposal.parse_mode in ("strict", "fuzzy"):
        return PatchProposal(
            target_file=retry_proposal.target_file,
            rationale=retry_proposal.rationale,
            proposed_diff=retry_proposal.proposed_diff,
            touched_frontmatter=retry_proposal.touched_frontmatter,
            estimated_added_lines=retry_proposal.estimated_added_lines,
            estimated_removed_lines=retry_proposal.estimated_removed_lines,
            raw_response=retry_proposal.raw_response,
            parse_mode="retried",
            escalated_timeout=bool(timeout_attempts),
            generation_duration_ms=retry_duration_ms,
        )

    # Both attempts failed — return first failure (already logged by
    # _parse_haiku_response → _log_haiku_parse_failure).
    return first_proposal


def _neutralize_field(text: str, *, cap: int = 160) -> str:
    """Flatten newlines then repr-quote agent-authored free-text for prompt injection.

    Agent-authored summary/lesson/label originate from [COMPLETION] blocks that are
    influenceable by tool outputs / fetched URLs / file content (untrusted relay).
    Flattening embedded newlines collapses any line-start RATIONALE:/DIFF:/'--- a/'
    /'+++ b/'/@@ marker so no fake diff/response anchor survives at line-start, and
    the repr-quote (mirroring the adjacent confidence!r/metric_pass!r) delimits the
    value — preserving every semantic word the generation-Haiku needs (LLM01).
    """
    return repr(" ".join((text or "")[:cap].splitlines()))


def _render_outcomes_block(outcomes: list[Outcome]) -> str:
    if not outcomes:
        return ""
    lines: list[str] = []
    for i, o in enumerate(outcomes, start=1):
        lines.append(
            f"{i}. result={o.result} confidence={o.confidence!r} "
            f"metric_pass={o.metric_pass!r} task={o.task_type}"
        )
        if o.summary:
            lines.append(f"   summary: {_neutralize_field(o.summary)}")
        if o.lesson:
            lines.append(f"   lesson: {_neutralize_field(o.lesson)}")
    return "\n".join(lines)


def _render_signals_block(patterns: list[Pattern]) -> str:
    """OBSERVED LEARNING SIGNALS block — 1-line summary of the agent's pattern signals.

    Each signal is always a compact 1-line (date/frequency/label) — all included
    regardless of sample cap.
    """
    if not patterns:
        return "(no patterns flagged)"
    lines: list[str] = []
    for i, p in enumerate(patterns, start=1):
        lines.append(
            f"{i}. [{p.date}] freq={p.frequency} — {_neutralize_field(p.label)}"
        )
    return "\n".join(lines)


# -- generation outcome polarity partition ----------------------------------
#
# Negative-signal definition is the IMPORTED shared SoT
# (_outcome_signal.is_negative_signal_outcome), unconditionally — the module is
# stdlib-only, so the predicate stays bound on the psycopg-absent path and no
# hand-mirrored copy exists to drift from it. The grader_verdict / review_flag
# OR-terms are NOT carried by Outcome, so the shared predicate sees them absent
# over this row shape — a strict subset of its definition, never a divergent one.


def _is_synthesized_measurement_gap(o: Outcome) -> bool:
    """True for a synthesized Outcome whose result is a synthesis artifact, not an
    agent-emitted signal: completion-synthesized done_with_concerns (the synthesis
    DEFAULT) and structuredoutput-derived done (schema-validated emit,
    writer-unverified). Scoped to those exact provenance+result pairs so a real
    agent's done_with_concerns still counts.

    The structuredoutput-derived arm is checked HERE rather than delegated: the shared
    predicate deliberately omits it (its docstring hands that success-side exclusion to
    daemon_cycle), and without it such a row carrying revision_count>=2 would flip
    NEUTRAL → FAILURE. Its attribution is disjoint from the shared arms, so checking it
    first is order-safe; every other arm — including the budget-truncation
    keep-clusterable guard — is the shared SoT's."""
    if (
        o.attribution_source == ATTRIBUTION_STRUCTUREDOUTPUT_DERIVED
        and o.result == "done"
    ):
        return True
    return _shared_is_synthesized_measurement_gap(_outcome_signal_row(o))


def _outcome_signal_row(o: Outcome) -> dict[str, object]:
    """Map an Outcome onto the dict shape is_negative_signal_outcome consumes."""
    return {
        "agent": o.agent,
        "task_type": o.task_type,
        "result": o.result,
        "revision_count": o.revision_count,
        # carries the synthesized marker so the imported SoT carve-out fires
        "attribution_source": o.attribution_source,
    }


def _is_failure_outcome(o: Outcome) -> bool:
    """FAILURE polarity: shared negative-signal predicate OR evaluative_signal==-1.

    Synthesized-measurement-gap carve-out runs FIRST: a completion-synthesized
    done_with_concerns row is never FAILURE polarity (it has no agent-emitted
    evaluative_signal either, so the -1 short-circuit below never fires for it).
    """
    if _is_synthesized_measurement_gap(o):
        return False
    if o.evaluative_signal == -1:
        return True
    return bool(is_negative_signal_outcome(_outcome_signal_row(o)))


def _is_success_outcome(o: Outcome) -> bool:
    """SUCCESS polarity: clean first-try done — never an absent/missing signal.

    structuredoutput-derived carve-out: that row's done is synthesis-assigned
    (writer-unverified, lesson-less) → NEUTRAL, never a SUCCESS exemplar."""
    if o.attribution_source == ATTRIBUTION_STRUCTUREDOUTPUT_DERIVED:
        return False
    return (
        o.result == "done"
        and o.revision_count == 0
        # Defensive for standalone/test callers: the partition loop buckets
        # failures first, so a -1 outcome never reaches here in normal flow.
        and o.evaluative_signal != -1
    )


def _outcome_header(index: int, o: Outcome) -> str:
    return (
        f"{index}. result={o.result} confidence={o.confidence!r} "
        f"metric_pass={o.metric_pass!r} task={o.task_type} "
        f"revision_count={o.revision_count} "
        f"evaluative_signal={o.evaluative_signal}"
    )


def _render_outcome_section(
    outcomes: list[Outcome],
    *,
    body_chars_so_far: int,
    body_budget: int,
) -> tuple[list[str], int, int]:
    """Render one polarity section's lines (header always kept, body budget-aware).

    Returns (lines, updated body_chars, bodies_truncated). The body budget is
    shared ACROSS sections (passed in / accumulated out) so the total prompt
    body never exceeds body_budget regardless of how records split.
    """
    lines: list[str] = []
    body_chars = body_chars_so_far
    bodies_truncated = 0
    for i, o in enumerate(outcomes, start=1):
        lines.append(_outcome_header(i, o))  # header always — preserve count
        body_pieces: list[str] = []
        if o.summary:
            body_pieces.append(f"   summary: {_neutralize_field(o.summary)}")
        if o.lesson:
            body_pieces.append(f"   lesson: {_neutralize_field(o.lesson)}")
        body_text = "\n".join(body_pieces)
        if body_text and body_chars + len(body_text) <= body_budget:
            lines.append(body_text)
            body_chars += len(body_text)
        elif body_text:
            # Over budget — drop BODY only (keep header), count the loud note.
            bodies_truncated += 1
    return lines, body_chars, bodies_truncated


def _render_generation_outcomes_block(
    outcomes: list[Outcome],
    *,
    body_budget: int = GENERATION_OUTCOMES_BODY_BUDGET_CHARS,
) -> str:
    """PRIOR-DAY OUTCOMES block — partitioned by polarity, budget-aware.

    Records split into THREE labeled sections so the optimizer reads failure vs
    success as distinct prompt signal (SkillOpt R3):
      - FAILURE  = is_negative_signal_outcome(...) OR evaluative_signal == -1
      - SUCCESS  = result == "done" AND revision_count == 0 AND signal != -1
      - NEUTRAL  = everything else, incl. missing-signal legacy records — NEVER
                   silently counted as success.

    Each outcome's 1-line header is always included (lossless signal count); once
    the verbatim summary/lesson BODY total exceeds body_budget (chars, shared
    across all sections), later BODY text is dropped with an explicit loud note.
    Sequential rendering — sample size is small (no ThreadPoolExecutor).
    """
    if not outcomes:
        return "(no prior-day outcomes sampled)"

    failures: list[Outcome] = []
    successes: list[Outcome] = []
    neutrals: list[Outcome] = []
    for o in outcomes:
        if _is_failure_outcome(o):
            failures.append(o)
        elif _is_success_outcome(o):
            successes.append(o)
        else:
            neutrals.append(o)

    lines: list[str] = []
    body_chars = 0
    bodies_truncated = 0
    sections = (
        ("FAILURE / CORRECTED OUTCOMES", failures),
        ("SUCCESS OUTCOMES (clean first-try done)", successes),
        ("NEUTRAL OUTCOMES (no clear polarity / missing signal)", neutrals),
    )
    for label, bucket in sections:
        lines.append(f"== {label} ({len(bucket)}) ==")
        if not bucket:
            lines.append("   (none)")
            continue
        section_lines, body_chars, section_truncated = _render_outcome_section(
            bucket, body_chars_so_far=body_chars, body_budget=body_budget
        )
        lines.extend(section_lines)
        bodies_truncated += section_truncated

    if bodies_truncated:
        lines.append(
            f"   [NOTE: {bodies_truncated} outcome bodies omitted to fit the "
            f"{body_budget}-char prompt budget — headers above are complete; "
            f"only verbatim summary/lesson text was truncated]"
        )
    return "\n".join(lines)


_HAIKU_RATIONALE_RE = re.compile(r"^RATIONALE:\s*(.+)$", re.MULTILINE)
_HAIKU_TOUCHES_RE = re.compile(r"^TOUCHES_FRONTMATTER:\s*(\S+)", re.MULTILINE)
_HAIKU_LINES_RE = re.compile(r"^ADDED_LINES:\s*(\d+)", re.MULTILINE)
_HAIKU_DIFF_RE = re.compile(r"^DIFF:\s*\n(.+)\Z", re.MULTILINE | re.DOTALL)

# Fuzzy fallback regex — case-insensitive + tolerant of partial markers.
# Triggered ONLY when strict regex misses; result tagged parse_mode='fuzzy'
# (explicit status — NO silent coerce).
#   - Rationale fuzzy: first paragraph after `rationale[:\s]+` until \n\n or DIFF/end
#   - DIFF fuzzy: prefer `diff:\s*\n` anchor; fall back to first --- a/ ... +++ b/
#     block (raw unified-diff hunk emitted without DIFF: header)
_HAIKU_RATIONALE_FUZZY_RE = re.compile(
    r"rationale[:\s]+(.+?)(?=\n\s*\n|\n\s*diff[:\s]|\Z)",
    re.IGNORECASE | re.DOTALL,
)
_HAIKU_DIFF_FUZZY_HEADER_RE = re.compile(
    r"diff[:\s]*\n(.+?)\Z",
    re.IGNORECASE | re.DOTALL,
)
_HAIKU_DIFF_FUZZY_ANCHOR_RE = re.compile(
    r"(^---\s+a/.+?\Z)",
    re.MULTILINE | re.DOTALL,
)

# -- Diff normalization -----------------------------------------------------
#
# Background:
#   Raw Haiku output carries markdown fences (```diff / ```) and may omit
#   unified-diff headers (--- a/path / +++ b/path / @@ -L,N +L,N @@), which
#   makes `git apply --check` return rc=128 ("No valid patches in input")
#   and funnels the patch into the pending-resolver target_drift bucket.
#   Normalization below repairs the diff before it reaches `git apply`.
#
# Strategy (hybrid — strip fences + server-side difflib reconstruction):
#   1) Strip ```diff / ``` markdown fences (LLM keeps emitting them despite
#      the "no fences" instruction in the prompt).
#   2) If the stripped body is already a valid unified diff (has --- and +++
#      headers + at least one @@ hunk), keep it as-is.
#   3) Otherwise, treat the body as a fragment of context+'+' lines:
#        - Find an anchor by matching the first context line against the
#          target file; compute real line numbers.
#        - Emit synthetic --- / +++ / @@ headers + the body.
#        - If no anchor found, fall back to a difflib-generated patch that
#          appends to the end of the last <!-- EDITABLE:END --> region (or
#          EOF) — always produces a syntactically valid unified diff.
#   4) Validate the final output with `git apply --check`; on rc=128 (parser
#      reject), log a WARN to stderr and return the original raw text so the
#      pending-resolver still records target_drift instead of vacuous-zero.

_FENCE_OPEN_RE = re.compile(r"^\s*```(?:diff|patch|unified|udiff)?\s*$", re.MULTILINE)
_FENCE_CLOSE_RE = re.compile(r"^\s*```\s*$", re.MULTILINE)
_UNIFIED_HEADER_RE = re.compile(r"^---\s+[ab]/.+$", re.MULTILINE)
_UNIFIED_HUNK_RE = re.compile(r"^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@", re.MULTILINE)
# Capturing variant — group(start_old, len_old, start_new, len_new, trailer).
# Trailer = optional `@@ section heading` suffix git emits after the second @@.
_UNIFIED_HUNK_CAPTURE_RE = re.compile(
    r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$"
)


def _strip_markdown_fences(raw: str) -> str:
    """Drop any ```diff / ``` opening + closing fences from LLM output.

    Tolerates: lone opening fence, lone closing fence, paired fences, fences
    indented by whitespace, fences with optional language tag (diff/patch/
    unified/udiff). Removes the fence LINES entirely (not just the backticks)
    so subsequent parsing sees clean diff content.
    """
    if "```" not in raw:
        return raw
    text = _FENCE_OPEN_RE.sub("", raw)
    text = _FENCE_CLOSE_RE.sub("", text)
    # Collapse the extra blank lines the substitution left behind.
    return re.sub(r"\n{3,}", "\n\n", text).strip("\n") + "\n"


def _has_unified_diff_headers(text: str) -> bool:
    """True iff `text` has both --- a/+++ b/ headers AND at least one @@ hunk."""
    if not text:
        return False
    has_minus = bool(_UNIFIED_HEADER_RE.search(text))
    # +++ shares the same line pattern shape — check separately to avoid false +
    has_plus = bool(re.search(r"^\+\+\+\s+[ab]/.+$", text, re.MULTILINE))
    has_hunk = bool(_UNIFIED_HUNK_RE.search(text))
    return has_minus and has_plus and has_hunk


def _recount_hunk_header(diff_text: str) -> str:
    """Recompute every `@@ -a,b +c,d @@` length from the actual hunk body.

    LLM-authored diffs systematically miscount the hunk lengths (b/d), yielding
    `git apply` rc=128 parser-reject. This helper walks each hunk and rewrites
    b = (context + removed) line count, d = (context + added) line count —
    leaving start offsets (a, c) and the body bytes untouched. The start offsets
    are NOT re-derived here (they depend on file position, not body shape);
    count-only repair is the in-place fix for the dominant corruption mode.
    Start-offset drift is handled by the full difflib re-derivation against the
    current file.

    Line classification per hunk body (mirrors unified-diff semantics):
      - ' ' prefix  → context  → counts toward BOTH old (b) and new (d)
      - '-' prefix  → removed  → counts toward old (b) only
      - '+' prefix  → added    → counts toward new (d) only
      - file headers (---/+++) and nested @@ end the current hunk body
      - '\\ No newline at end of file' markers are ignored (not a content line)

    FU-3 reuses this helper to re-stamp difflib output defensively.

    Returns the diff with corrected headers; idempotent on already-correct input.
    Non-hunk text (preamble, file headers) is preserved verbatim.
    """
    if not diff_text:
        return diff_text

    lines = diff_text.splitlines(keepends=True)
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        m = _UNIFIED_HUNK_CAPTURE_RE.match(line.rstrip("\n"))
        if m is None:
            out.append(line)
            i += 1
            continue

        start_old, _, start_new, _, trailer = m.groups()
        # Scan the body following this hunk header until the next hunk / header.
        body: list[str] = []
        j = i + 1
        while j < n:
            bl = lines[j]
            stripped_bl = bl.rstrip("\n")
            if _UNIFIED_HUNK_CAPTURE_RE.match(stripped_bl):
                break
            if stripped_bl.startswith("--- ") or stripped_bl.startswith("+++ "):
                break
            body.append(bl)
            j += 1

        old_count = 0
        new_count = 0
        for bl in body:
            if bl.startswith("\\"):
                # "\ No newline at end of file" — not a content line.
                continue
            if bl.startswith("+"):
                new_count += 1
            elif bl.startswith("-"):
                old_count += 1
            else:
                # ' ' context OR a prefix-less line difflib never emits but the
                # LLM sometimes does — count as context (both sides).
                old_count += 1
                new_count += 1

        eol = "\n" if line.endswith("\n") else ""
        out.append(
            f"@@ -{start_old},{old_count} +{start_new},{new_count} @@{trailer}{eol}"
        )
        out.extend(body)
        i = j

    return "".join(out)


def _stamp_implied_lengths(diff_text: str) -> str:
    """Expand `@@ -a +c @@` shorthand to `@@ -a,1 +c,1 @@` without touching body.

    Used only by `_unified_diff_counts_valid` to compare apples-to-apples: git's
    single-line shorthand is semantically len=1, so the validity check must not
    flag it as a mismatch against a recomputed explicit form.
    """
    if not diff_text:
        return diff_text
    out: list[str] = []
    for line in diff_text.splitlines(keepends=True):
        m = _UNIFIED_HUNK_CAPTURE_RE.match(line.rstrip("\n"))
        if m is None:
            out.append(line)
            continue
        start_old, len_old, start_new, len_new, trailer = m.groups()
        len_old = len_old if len_old is not None else "1"
        len_new = len_new if len_new is not None else "1"
        eol = "\n" if line.endswith("\n") else ""
        out.append(
            f"@@ -{start_old},{len_old} +{start_new},{len_new} @@{trailer}{eol}"
        )
    return "".join(out)


def _unified_diff_counts_valid(diff_text: str) -> bool:
    """True iff every `@@ -a,b +c,d @@` count matches its hunk body.

    F2 gate companion to `_recount_hunk_header`: a pure predicate that reports
    whether the stored counts already agree with the body, so the caller can
    distinguish "already correct" from "repaired". Single-line hunks that omit
    the `,len` form (git's `@@ -1 +1 @@` shorthand) imply len=1 — expanded on
    both sides before comparison so shorthand never reads as a mismatch.
    """
    if not diff_text:
        return True
    # Expand shorthand on the original, then compare against the body-recomputed
    # form (also shorthand-expanded since _recount_hunk_header emits explicit
    # `,len`). Equality ⟺ stored counts already agree with the body.
    original_expanded = _stamp_implied_lengths(diff_text)
    recomputed = _recount_hunk_header(original_expanded)
    return original_expanded == recomputed


def _split_fragment_lines(body: str) -> tuple[list[str], list[str], list[str]]:
    """Partition a diff fragment body into (context, added, removed) lines.

    - Context lines: start with single space OR are plain text lines (no prefix).
    - Added lines: start with '+' (NOT '+++').
    - Removed lines: start with '-' (NOT '---').
    - Lines starting with '@@' or that look like markdown decorations are dropped.

    Returns raw line content WITH prefix preserved — caller decides how to use.
    """
    context: list[str] = []
    added: list[str] = []
    removed: list[str] = []
    for raw_line in body.splitlines():
        if raw_line.startswith("+++") or raw_line.startswith("---"):
            continue
        if raw_line.startswith("@@"):
            continue
        if raw_line.startswith("+"):
            added.append(raw_line)
        elif raw_line.startswith("-"):
            removed.append(raw_line)
        elif raw_line.startswith(" "):
            context.append(raw_line)
        elif raw_line.strip() == "":
            # Blank line = legitimate context (file blank line).
            context.append(" ")
        else:
            # Plain text without prefix — treat as context (LLM forgot space).
            context.append(" " + raw_line)
    return context, added, removed


def _diff_is_replace_shape(diff_text: str) -> bool:
    """True iff the fragment carries BOTH added and removed lines.

    The REPLACE shape is the one the add-only rebuilders convert into a silent
    append: the removals bind to a throwaway and the rebuild uses the added lines
    alone, so the subtraction lands as an absence nobody reads. A pure-add rebuild
    is lossless and a pure-removal diff already rejects visibly at generation, so
    neither is refused — this predicate is the single SoT for that boundary.
    """
    _context, added, removed = _split_fragment_lines(diff_text)
    return bool(added) and bool(removed)


def _warn_removal_refusal(*, site: str, target_file: Path, removed_count: int) -> None:
    """Loud-fail line for a refused add-only rebuild — countable, not inferable.

    Emitted in the file's established stderr shape so a refusal shows up in the
    daemon log as its own record rather than as a missing append.
    """
    sys.stderr.write(
        f"[daemon-cycle] REMOVAL REFUSAL: {site} would rebuild "
        f"{target_file.name} from added lines only, discarding {removed_count} "
        f"removed line(s) — refusing (stored empty)\n"
    )


def _find_anchor_line(target_lines: list[str], context_lines: list[str]) -> int | None:
    """Locate the 1-indexed line number in target_lines where context anchors.

    Uses the FIRST non-empty context line as the anchor needle. Returns None
    if the needle isn't found (or matches >1 location, which is ambiguous).
    """
    needle: str | None = None
    for ctx in context_lines:
        stripped = ctx[1:] if ctx.startswith(" ") else ctx
        if stripped.strip():
            needle = stripped.rstrip("\n")
            break
    if needle is None:
        return None
    matches: list[int] = []
    for idx, line in enumerate(target_lines, start=1):
        if line.rstrip("\n") == needle:
            matches.append(idx)
    # Unique match required — multiple anchors = ambiguous → fall back.
    if len(matches) == 1:
        return matches[0]
    return None


def _normalize_to_unified_diff(raw_diff: str, target_file: Path) -> str:
    """Convert LLM-emitted diff (possibly fenced/fragmentary) to a valid patch.

    Strategy:
      1. Strip markdown fences.
      2. Headers present → F2 count gate: validate @@ counts; repair in-place
         via `_recount_hunk_header` when they disagree with the body (the LLM
         systematically miscounts), else pass through. Never returns a diff
         with known-wrong counts (the rc=128 root cause pre-F2).
      3. Parse fragment → try anchor-based header synthesis.
      4. Anchor failed → synthesize a difflib append-to-EOF patch (always valid).

    Failure mode: if `target_file` doesn't exist on disk, return the stripped
    text unchanged + a stderr WARN (preserves backwards-compat; validation
    layer will catch broken output later).
    """
    if not raw_diff.strip():
        return ""

    stripped = _strip_markdown_fences(raw_diff)

    if _has_unified_diff_headers(stripped):
        trimmed = stripped.rstrip() + "\n"
        # Presence of headers does not imply correctness — the dominant
        # corruption is wrong @@ lengths. Validate; repair in-place when the
        # stored counts disagree with the body.
        if _unified_diff_counts_valid(trimmed):
            return trimmed
        repaired = _recount_hunk_header(trimmed)
        sys.stderr.write(
            f"[daemon-cycle] F2: repaired wrong @@ counts for "
            f"{target_file.name} — headers present but hunk lengths "
            f"disagreed with body (recomputed from line content)\n"
        )
        return repaired

    if not target_file.exists():
        sys.stderr.write(
            f"[daemon-cycle] WARN: cannot normalize diff — target missing: "
            f"{target_file.name}\n"
        )
        return stripped

    try:
        target_text = target_file.read_text(encoding="utf-8")
    except OSError as exc:
        sys.stderr.write(
            f"[daemon-cycle] WARN: cannot read target for diff normalization: "
            f"{target_file.name}: {exc}\n"
        )
        return stripped

    target_lines = target_text.splitlines(keepends=True)
    rel_name = target_file.name

    context_lines, added_lines, removed_lines = _split_fragment_lines(stripped)

    # Anchor-based synthesis path — constrained to EDITABLE regions. The
    # synthetic builder only yields a guard-passing (verdict=ok) hunk when its
    # anchor + trailing context land inside an editable region. A uniquely-matched
    # anchor OUTSIDE every region (the dev-front.md:49 fossil class) is
    # RE-ANCHORED onto a safe in-region content line; a region-less file falls
    # through to the EOF append (which the apply-time guard legitimately rejects).
    spans = _editable_spans(target_lines)
    synthetic_anchor: int | None = None
    if added_lines and not removed_lines:
        synthetic_anchor = _resolve_in_region_anchor(target_lines, context_lines, spans)
    if synthetic_anchor is not None:
        return _build_synthetic_diff_at_anchor(
            rel_name=rel_name,
            target_lines=target_lines,
            anchor_idx=synthetic_anchor,
            context_lines=context_lines,
            added_lines=added_lines,
        )

    # Fallback: difflib append-to-EOF (or last EDITABLE:END region). A REPLACE
    # fragment cannot go through it — the builder takes added lines only, so the
    # removal would land as a silent append instead of a subtraction.
    if added_lines and removed_lines:
        _warn_removal_refusal(
            site="normalization fallback",
            target_file=target_file,
            removed_count=len(removed_lines),
        )
        return ""
    return _build_difflib_append_diff(
        rel_name=rel_name,
        target_lines=target_lines,
        added_lines=added_lines,
    )


def _build_synthetic_diff_at_anchor(
    *,
    rel_name: str,
    target_lines: list[str],
    anchor_idx: int,  # 1-indexed
    context_lines: list[str],
    added_lines: list[str],
) -> str:
    """Build a unified-diff with proper @@ headers using the located anchor.

    Layout:
        --- a/<rel_name>
        +++ b/<rel_name>
        @@ -<anchor>,<ctx_count> +<anchor>,<ctx_count+added_count> @@
         <context lines verbatim from target>
        +<added line 1>
        +<added line 2>

    Context lines after the anchor are pulled FROM THE FILE (not from the LLM),
    so byte-for-byte match against `git apply --check` is guaranteed. We use a
    single anchor line of context before AND after to keep the hunk minimal.
    """
    ctx_before_count = 1  # the anchor line itself
    ctx_after_count = 1 if anchor_idx < len(target_lines) else 0
    old_count = ctx_before_count + ctx_after_count
    new_count = old_count + len(added_lines)

    body: list[str] = []
    # Anchor line (1-indexed → 0-indexed slice).
    body.append(" " + target_lines[anchor_idx - 1].rstrip("\n"))
    # Insert added lines (strip the '+' if doubled; ensure single '+').
    for line in added_lines:
        # `line` already starts with '+'; preserve as-is.
        body.append(line.rstrip("\n"))
    # Trailing context line (if available).
    if ctx_after_count:
        body.append(" " + target_lines[anchor_idx].rstrip("\n"))

    header = (
        f"--- a/{rel_name}\n"
        f"+++ b/{rel_name}\n"
        f"@@ -{anchor_idx},{old_count} +{anchor_idx},{new_count} @@\n"
    )
    return header + "\n".join(body) + "\n"


def _editable_spans(target_lines: list[str]) -> list[tuple[int, int]]:
    """Return [(begin_idx, end_idx)] 1-indexed marker line numbers per region.

    Each tuple pairs an `<!-- EDITABLE:BEGIN -->` marker line with the NEXT
    `<!-- EDITABLE:END -->` marker (document order). The CONTENT of a region is
    the lines strictly between them (begin_idx+1 .. end_idx-1) — the marker
    lines themselves are NOT in-region, matching the apply-side landing-zone
    guard (`daemon-apply.sh` `_editable_regions`, which slices the text BETWEEN
    the markers). An unpaired trailing BEGIN is ignored (no region), and a
    second BEGIN before its END is folded into the open region (guard parity).
    """
    begin_tag = "<!-- EDITABLE:BEGIN -->"
    end_tag = "<!-- EDITABLE:END -->"
    spans: list[tuple[int, int]] = []
    begin: int | None = None
    for idx, line in enumerate(target_lines, start=1):
        if begin is None and begin_tag in line:
            begin = idx
        elif begin is not None and end_tag in line:
            spans.append((begin, idx))
            begin = None
    return spans


def _anchor_in_editable_region(anchor_idx: int, spans: list[tuple[int, int]]) -> bool:
    """Whether a 1-indexed line sits strictly inside any editable region.

    A line ON a marker line (begin_idx or end_idx) is NOT in-region — only the
    content lines between the markers count, mirroring the apply-side guard.
    """
    return any(begin < anchor_idx < end for begin, end in spans)


_MD_HEADING_RE = re.compile(r"^#{1,6}\s")


def _heading_level(line: str) -> int:
    """Markdown ATX heading level (1-6), or 0 when the line is not a heading."""
    if not _MD_HEADING_RE.match(line):
        return 0
    return len(line) - len(line.lstrip("#"))


# -- Removal evidence gate --------------------------------------------------
# The loop may only delete a line it can POINT AT. Every declared removal must
# match exactly one line of the target, that line must sit inside an editable
# region, and it must not be a protected line. Anything else — no match, several
# matches, out of region, protected — rejects the WHOLE diff: partial application
# of a replace is the failure this gate exists to design out.
#
# An addition defect is visible in the file; a removal defect is an absence
# nobody reads, on a loop that writes live bodies unattended — so every
# ambiguous input refuses rather than admits.

# Opt-in for LIVE removal. Read at CALL time, not captured as an import-time
# constant like the tuning knobs above: the apply path invokes this module per
# patch, so a call-time read lets an operator arm and disarm the capability
# without a daemon restart.
REMOVAL_LIVE_ENV = "AUTOAGENT_REMOVAL_LIVE"

REMOVAL_VERDICT_OK = "ok"
REMOVAL_VERDICT_NO_REMOVAL = "no_removal"          # nothing declared, nothing implied
REMOVAL_VERDICT_NO_MATCH = "no_match"
REMOVAL_VERDICT_MULTIPLE_MATCH = "multiple_match"
REMOVAL_VERDICT_OUT_OF_REGION = "out_of_region"
REMOVAL_VERDICT_PROTECTED = "protected"
REMOVAL_VERDICT_AMBIGUOUS = "ambiguous_removal_set"
REMOVAL_VERDICT_UNREADABLE = "unreadable"


class RemovalEvidence(NamedTuple):
    """Verdict of the evidence rule plus the removal set it was derived from."""

    ok: bool
    verdict: str
    declared: tuple[str, ...]
    detail: str


def get_removal_live() -> bool:
    """Whether LIVE removal is armed (default OFF — dry-run reports only)."""
    return os.environ.get(REMOVAL_LIVE_ENV, "").strip().lower() in {"1", "true", "yes"}


def _get_declared_removals(diff_text: str) -> tuple[tuple[str, ...], bool]:
    """Removal set declared by a stored diff, plus whether it LOOKS removal-bearing.

    Enumerated from the RAW hunk lines — every line after an `@@` header — rather
    than through `_split_fragment_lines`, which drops any `---`-prefixed line as a
    file header. That partition cannot see the two removals that matter most here:
    a deleted frontmatter delimiter (`---` → the diff line `----`) and a deleted
    `-- `-prefixed line (→ `--- `). Inside a hunk those ARE removals, so the file
    header is recognised only in the pre-hunk preamble.

    The second element is the AMBIGUITY probe: a diff whose preamble carries a
    removal-shaped line while no hunk exists to declare it (a header-less
    fragment) is removal-bearing with an EMPTY declared set — unreadable intent,
    which the caller refuses rather than admits.
    """
    declared: list[str] = []
    preamble_removal = False
    in_hunk = False
    for raw in diff_text.splitlines():
        if raw.startswith("@@"):
            in_hunk = True
            continue
        if not in_hunk:
            # Pre-hunk preamble: `--- a/x` / `+++ b/x` / `diff --git` / `index`
            # are headers; anything else starting with '-' is a stray removal
            # the hunk enumeration below can never see.
            if raw.startswith(("--- ", "+++ ", "diff --git", "index ")):
                continue
            if raw.startswith("-"):
                preamble_removal = True
            continue
        if raw.startswith("diff --git"):
            in_hunk = False  # next file's preamble
            continue
        if raw.startswith("-"):
            declared.append(raw[1:])
    return tuple(declared), preamble_removal or bool(declared)


def _get_protected_kind(line: str) -> str | None:
    """Name the protected class of a line, or None when it is ordinary content.

    Every member here is structure the body's readers depend on: deleting one is
    not an edit but a change to what the later guards can still reason about. The
    blank member is protected because a blank line carries no identity — it can
    never be evidenced as "exactly one" anything.
    """
    body = line.rstrip("\n")
    if not body.strip():
        return "blank"
    if body.strip() == "---":
        return "frontmatter-delimiter"
    if body.startswith("> Rules:"):
        return "rules-anchor"
    if "<!-- EDITABLE:BEGIN -->" in body or "<!-- EDITABLE:END -->" in body:
        return "region-marker"
    if _heading_level(body) > 0:
        return "heading"
    return None


def verify_removal_evidence(diff_text: str, target_text: str) -> RemovalEvidence:
    """Does this diff's removal set satisfy the evidence rule?

    The declared set is derived HERE, from the stored diff about to be applied —
    never transported from the generation side. One source of truth that cannot
    desync from what lands, and it covers the majority path: a removal that never
    entered the repair path at all.
    """
    declared, removal_bearing = _get_declared_removals(diff_text)
    if not removal_bearing:
        return RemovalEvidence(True, REMOVAL_VERDICT_NO_REMOVAL, (), "")
    if not declared:
        return RemovalEvidence(
            False,
            REMOVAL_VERDICT_AMBIGUOUS,
            (),
            "diff carries removal-shaped lines but declares an empty removal set",
        )
    if not target_text:
        return RemovalEvidence(
            False, REMOVAL_VERDICT_UNREADABLE, declared, "target body empty or unreadable"
        )

    target_lines = target_text.splitlines()
    spans = _editable_spans(target_lines)
    for removed in declared:
        protected = _get_protected_kind(removed)
        if protected is not None:
            return RemovalEvidence(
                False, REMOVAL_VERDICT_PROTECTED, declared, f"{protected}: {removed[:60]}"
            )
        hits = [idx for idx, line in enumerate(target_lines, start=1) if line == removed]
        if not hits:
            return RemovalEvidence(
                False, REMOVAL_VERDICT_NO_MATCH, declared, removed[:60]
            )
        if len(hits) > 1:
            return RemovalEvidence(
                False,
                REMOVAL_VERDICT_MULTIPLE_MATCH,
                declared,
                f"{len(hits)} matches: {removed[:60]}",
            )
        if not _anchor_in_editable_region(hits[0], spans):
            return RemovalEvidence(
                False,
                REMOVAL_VERDICT_OUT_OF_REGION,
                declared,
                f"line {hits[0]}: {removed[:60]}",
            )
    return RemovalEvidence(True, REMOVAL_VERDICT_OK, declared, "")


def _emit_removal_evidence(diff_text: str, target_file: Path) -> int:
    """CLI arm: print `verdict<TAB>live<TAB>count` then one declared line each.

    Line-oriented rather than JSON because the apply script consumes it directly:
    a removal line can never contain a newline, so the framing is unambiguous and
    the shell needs no parser. A read failure is reported as the UNREADABLE
    verdict rather than raised — the caller fails closed on it either way.
    """
    try:
        target_text = target_file.read_text(encoding="utf-8")
    except OSError as exc:
        evidence = RemovalEvidence(
            False, REMOVAL_VERDICT_UNREADABLE, (), f"{type(exc).__name__}"
        )
    else:
        evidence = verify_removal_evidence(diff_text, target_text)
    live = "1" if get_removal_live() else "0"
    sys.stdout.write(f"{evidence.verdict}\t{live}\t{len(evidence.declared)}\n")
    for line in evidence.declared:
        sys.stdout.write(line + "\n")
    if evidence.detail:
        sys.stderr.write(
            f"[daemon-cycle] removal evidence {evidence.verdict} "
            f"({target_file.name}): {evidence.detail}\n"
        )
    return 0


def _is_gfm_table_delimiter(line: str) -> bool:
    """Whether a line is a GFM table delimiter row (`| --- | :-: |`, `|---|`).

    Requires a pipe so a thematic break (`---`) or setext underline is NOT
    misread as a table; requires a dash so a plain pipe-bearing data row is not.
    """
    stripped = line.strip()
    if "-" not in stripped or "|" not in stripped:
        return False
    return all(ch in "|-: \t" for ch in stripped)


def _gfm_table_line_set(target_lines: list[str]) -> set[int]:
    """1-indexed line numbers that form a GFM table block (header+delimiter+rows).

    A regenerated diff must never insert a non-pipe line BETWEEN two of these
    rows — that splits the table (the qa-code-reviewer.md RC1 corruption: a
    re-anchor landed on the Error Recovery table interior). A block is anchored
    on a delimiter row whose immediately-preceding line is a pipe-bearing header,
    and extends through the contiguous run of pipe-bearing data rows below it.
    """
    table_lines: set[int] = set()
    n = len(target_lines)
    for i in range(1, n):  # a delimiter cannot be the first line (needs a header)
        if not _is_gfm_table_delimiter(target_lines[i].rstrip("\n")):
            continue
        header = target_lines[i - 1].rstrip("\n")
        if "|" not in header or not header.strip():
            continue  # a delimiter with no pipe-bearing header above is not a table
        table_lines.add(i)      # 1-indexed header   = (i-1)+1
        table_lines.add(i + 1)  # 1-indexed delimiter = i+1
        for j in range(i + 1, n):  # 0-indexed data rows below the delimiter
            row = target_lines[j].rstrip("\n")
            if not row.strip() or "|" not in row:
                break  # a blank / non-pipe line terminates the table block
            table_lines.add(j + 1)
    return table_lines


def _splits_gfm_table(anchor: int, table_lines: set[int]) -> bool:
    """Whether a post-`anchor` insertion point splits a GFM table block.

    True when both the 1-indexed `anchor` line and its successor are table rows —
    landing a synthetic-diff insertion there breaks the table (qa-code-reviewer.md
    RC1). Shared by `_safe_reanchor_candidate` and `_resolve_in_region_anchor`.
    """
    return anchor in table_lines and (anchor + 1) in table_lines


def _safe_reanchor_candidate(
    anchor: int,
    target_lines: list[str],
    spans: list[tuple[int, int]],
    table_lines: set[int],
) -> bool:
    """Whether a 1-indexed line is a SAFE synthetic-diff anchor.

    Safe = a non-blank content line whose post-anchor insertion point neither
    SPLITS a GFM table block (both `anchor` and its successor are table rows) nor
    drags an out-of-region trailing-context line into the hunk. A blank trailing
    context (guard-skipped) or EOF (no trailing context emitted) is also safe.
    """
    n = len(target_lines)
    if anchor < 1 or anchor > n:
        return False
    if not target_lines[anchor - 1].strip():
        return False  # need a non-blank needle for git apply to land
    # NEVER land inside a GFM table — an insertion whose split point sits between
    # two table rows breaks the table (qa-code-reviewer.md RC1).
    if _splits_gfm_table(anchor, table_lines):
        return False
    if anchor >= n:
        return True  # last file line → no trailing context emitted
    trailing = target_lines[anchor]  # 0-indexed anchor = (anchor+1)th line
    if not trailing.strip():
        return True  # blank trailing context is skipped by the guard
    return _anchor_in_editable_region(anchor + 1, spans)


def _enclosing_heading_index(target_lines: list[str], anchor_idx: int) -> int | None:
    """1-indexed line of the nearest markdown heading at or before `anchor_idx`."""
    start = min(anchor_idx, len(target_lines))
    for idx in range(start, 0, -1):
        if _MD_HEADING_RE.match(target_lines[idx - 1]):
            return idx
    return None


def _section_end_index(target_lines: list[str], heading_idx: int) -> int:
    """1-indexed line before the NEXT heading of level <= the section's, else EOF."""
    level = _heading_level(target_lines[heading_idx - 1])
    n = len(target_lines)
    for idx in range(heading_idx + 1, n + 1):
        lvl = _heading_level(target_lines[idx - 1])
        if lvl and lvl <= level:
            return idx - 1
    return n


def _intended_section_heading_anchor(
    target_lines: list[str],
    spans: list[tuple[int, int]],
    intended_anchor: int | None,
    table_lines: set[int],
) -> int | None:
    """Re-target the editable region of the section that OWNS `intended_anchor`.

    The original (out-of-region) anchor identifies the section the proposal MEANT
    to edit; the deterministic last-region fall-back instead flattened EVERY such
    proposal into the file's final editable region (the qa-code-reviewer.md RC1
    misclassify into Error Recovery). When that section exposes its own editable
    region, anchor at its FIRST safe content line so the regenerated diff lands in
    the intended section. Returns None when there is no intended anchor / no owning
    region / no safe content line — the caller then runs the last-region fall-back.
    """
    if intended_anchor is None:
        return None
    heading_idx = _enclosing_heading_index(target_lines, intended_anchor)
    if heading_idx is None:
        return None
    section_end = _section_end_index(target_lines, heading_idx)
    for begin, end in spans:  # document order: the section's own region opens first
        if heading_idx < begin <= section_end:
            for anchor in range(begin + 1, end):  # content lines, top-down
                if _safe_reanchor_candidate(anchor, target_lines, spans, table_lines):
                    return anchor
            return None  # the owning region exposes no safe content line
    return None


def _reanchor_index(
    target_lines: list[str],
    spans: list[tuple[int, int]],
    intended_anchor: int | None = None,
    table_lines: set[int] | None = None,
) -> int | None:
    """Pick a 1-indexed in-region content line safe for synthetic-diff anchoring.

    The synthetic builder (`_build_synthetic_diff_at_anchor`) emits the anchor
    line as leading context AND the FOLLOWING file line as trailing context. The
    apply-time landing-zone guard rejects a hunk (`out_of_region`) when ANY
    context line the file contains sits outside every editable region — so a
    naive re-anchor onto a region's LAST content line fails: its trailing
    context is the `<!-- EDITABLE:END -->` marker (on-disk, out-of-region).
    This is the exact reason the difflib-append fallback was empirically refused
    in review (its n=3 trailing context dragged in the END marker). A "safe"
    anchor is therefore a non-blank content line whose trailing context is also
    in-region (or blank, which the guard skips, or absent at EOF) AND whose
    insertion point does not split a GFM table block (RC1).

    Resolution order:
      1. PREFER the editable region of the section that owns `intended_anchor` so
         the regenerated diff re-targets its INTENDED section (Absolute-Rules-like)
         rather than being flattened into the file's last editable region.
      2. Fall back to the LAST region, latest content line first (mirrors
         `_build_difflib_append_diff`'s append-near-the-end placement) — TABLE-AWARE:
         a table-interior line is skipped, NEVER selected.
      3. No safe non-table in-region anchor → None: the caller falls through to a
         guard-rejected landing rather than silently splitting a table.
    """
    if table_lines is None:
        table_lines = _gfm_table_line_set(target_lines)
    heading_anchor = _intended_section_heading_anchor(
        target_lines, spans, intended_anchor, table_lines
    )
    if heading_anchor is not None:
        return heading_anchor
    for begin, end in reversed(spans):
        # Content lines are (begin+1 .. end-1) 1-indexed; prefer the latest.
        for anchor in range(end - 1, begin, -1):
            if _safe_reanchor_candidate(anchor, target_lines, spans, table_lines):
                return anchor
    return None


def _resolve_in_region_anchor(
    target_lines: list[str],
    context_lines: list[str],
    spans: list[tuple[int, int]],
) -> int | None:
    """Resolve a 1-indexed synthetic anchor constrained to an editable region.

    Shared by `_normalize_to_unified_diff` and `_rederive_diff_against_file`:
    locate the context anchor, keep it when it already sits inside an editable
    region (and does not split a GFM table), otherwise re-anchor onto a safe
    in-region, non-table content line — preferring the intended section. Returns
    None when no anchor resolves or the file exposes no editable region — the
    caller then falls through to the difflib-append fallback. The `added_lines` /
    `removed_lines` admission guards stay at the call site (they differ per site).
    """
    anchor = _find_anchor_line(target_lines, context_lines) if context_lines else None
    if anchor is None or not spans:
        return None
    # Keep an in-region anchor ONLY when its insertion point does not split a GFM
    # table; a table-interior anchor (even in-region) is re-anchored so the
    # regenerated diff never lands between two table rows (RC1).
    table_lines = _gfm_table_line_set(target_lines)
    splits_table = _splits_gfm_table(anchor, table_lines)
    if _anchor_in_editable_region(anchor, spans) and not splits_table:
        return anchor
    return _reanchor_index(
        target_lines, spans, intended_anchor=anchor, table_lines=table_lines
    )


def _find_last_editable_end(target_lines: list[str]) -> int | None:
    """Return the 1-indexed line number of the LAST <!-- EDITABLE:END --> tag.

    Used as the safest deterministic insertion point — agents define these
    regions explicitly to mark mutation-safe zones.
    """
    last: int | None = None
    needle = "<!-- EDITABLE:END -->"
    for idx, line in enumerate(target_lines, start=1):
        if needle in line:
            last = idx
    return last


def _build_difflib_append_diff(
    *,
    rel_name: str,
    target_lines: list[str],
    added_lines: list[str],
) -> str:
    """Construct a syntactically-valid unified diff via difflib.

    Inserts `added_lines` either:
      - Just BEFORE the last <!-- EDITABLE:END --> tag (preserves agent's
        editable-region convention), OR
      - At end of file if no such tag exists.

    difflib.unified_diff guarantees correct @@ line numbers and context, so
    the result is always parseable by `git apply --check` (rc=0 or rc=1, but
    never rc=128 parser-reject).

    If `added_lines` is empty, returns "" (caller already filtered, but be safe).
    """
    if not added_lines:
        return ""

    # Strip the '+' prefix; we're constructing the AFTER state, not a diff.
    addition_text_lines = [line[1:] if line.startswith("+") else line for line in added_lines]
    # Ensure each addition ends with a newline (matches splitlines(keepends=True) shape).
    addition_text_lines = [
        (line if line.endswith("\n") else line + "\n") for line in addition_text_lines
    ]

    insertion_point = _find_last_editable_end(target_lines)
    if insertion_point is None:
        # Append to EOF.
        before = target_lines
        after = target_lines + addition_text_lines
    else:
        # Insert BEFORE the EDITABLE:END line (so the new content stays inside
        # the editable region).
        before = target_lines
        after = (
            target_lines[: insertion_point - 1]
            + addition_text_lines
            + target_lines[insertion_point - 1 :]
        )

    diff_iter = difflib.unified_diff(
        before,
        after,
        fromfile=f"a/{rel_name}",
        tofile=f"b/{rel_name}",
        n=3,
        lineterm="\n",
    )
    return "".join(diff_iter)


# git apply --check rc=1 stderr fragments that mean "header path did not
# resolve to a real file" (the GA-monorepo prefix-mismatch class), as opposed
# to a genuine "patch content conflicts with the on-disk file" rejection.
# Matching the apply stage's GIT_ROOT + --directory keeps these distinguishable:
# a path miss is a HARD reject (the diff can NEVER apply), whereas a content
# conflict is still a parseable diff the downstream gate may repair/rebuild.
_GIT_FILE_NOT_FOUND_RE = re.compile(
    r"no such file or directory"
    r"|does not exist in index"
    r"|new file .* depends on old contents",
    re.IGNORECASE,
)


def _resolve_apply_git_scope(agents_dir: Path) -> tuple[str, str]:
    """Mirror daemon-apply.sh's GIT_ROOT + --directory resolution.

    The apply stage runs `git -C <GIT_ROOT> apply --directory=<dir>` where
    GIT_ROOT is the worktree toplevel and <dir> is AGENTS_DIR's path relative to
    it (the GA monorepo: root=~/.glass-atrium, dir=agents). The cycle gate MUST
    validate against the SAME scope or it green-lights diffs the apply rejects.

    Returns (git_root, apply_directory):
      - GA monorepo → ("~/.glass-atrium", "agents")
      - standalone repo / --agents-dir / Bats (AGENTS_DIR IS the toplevel) →
        (str(agents_dir), "") — empty directory == byte-identical legacy scope.

    Production short-circuits on the env overrides (daemon-cycle.sh always
    exports AUTOAGENT_GIT_ROOT / _GIT_PATHSPEC), so the `git rev-parse` fallback
    runs only when env is unset (standalone repo / Bats / direct invocation) —
    not in the hot per-diff gate path. On any git failure, falls back to
    (str(agents_dir), "") — the legacy whole-dir behavior.
    """
    env_root = os.environ.get("AUTOAGENT_GIT_ROOT", "").strip()
    if env_root:
        env_pathspec = os.environ.get("AUTOAGENT_GIT_PATHSPEC", "").strip()
        return (env_root, env_pathspec.rstrip("/"))
    agents_dir_str = str(agents_dir)
    try:
        out = {
            flag: subprocess.run(  # nosec — list form, no shell=True
                ["git", "-C", agents_dir_str, "rev-parse", flag],
                capture_output=True, text=True, check=False, timeout=15,
            )
            for flag in ("--show-toplevel", "--show-prefix")
        }
    except (OSError, subprocess.TimeoutExpired):
        return (agents_dir_str, "")
    root = (out["--show-toplevel"].stdout or "").strip()
    if not root:
        # Not a git repo (or git missing) → legacy whole-dir scope.
        return (agents_dir_str, "")
    return (root, (out["--show-prefix"].stdout or "").strip().rstrip("/"))


def _validate_unified_diff(
    diff_text: str,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
) -> tuple[bool, str]:
    """Run `git apply --check` against the diff; report parseability.

    Runs against the SAME GIT_ROOT + `--directory` the apply stage uses (via
    `_resolve_apply_git_scope`), so the gate reflects apply reality — a bare-
    basename diff header (GA monorepo migration) resolves to <root>/agents/<f>
    exactly as `daemon-apply.sh` resolves it, instead of the old bare
    `~/.claude/agents` scope that masked the path-prefix bug.

    Returns (is_parseable, stderr_excerpt).
      - rc=0   → clean apply possible → True
      - rc=1, file-not-found (path miss) → HARD reject → False
      - rc=1, genuine content conflict (file drift) → True (still parseable)
      - rc=128 → "No valid patches in input" → False (parser reject)
      - other  → treat as parseable but log
    """
    if not diff_text.strip():
        return (False, "empty diff")
    # Ensure trailing newline (git apply prerequisite — also enforced by resolver).
    payload = diff_text if diff_text.endswith("\n") else diff_text + "\n"
    git_root, apply_dir = _resolve_apply_git_scope(agents_dir)
    cmd = ["git", "-C", git_root, "apply", "--check"]
    if apply_dir:
        cmd.append(f"--directory={apply_dir}")
    fd, tmp_path = tempfile.mkstemp(prefix="daemon-validate-", suffix=".diff")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        try:
            result = subprocess.run(  # nosec — list form, no shell=True
                [*cmd, tmp_path],
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return (False, f"subprocess failure: {type(exc).__name__}: {exc}")
        stderr_excerpt = (result.stderr or "")[:240].strip()
        if result.returncode == 128:
            return (False, stderr_excerpt)
        # rc=1 splits two ways: a path-resolution miss (header target absent
        # under the apply scope — the prefix-mismatch class) is a HARD reject
        # (the diff can never apply), but a genuine content conflict stays
        # parseable so the downstream gate may recount/rebuild it.
        if result.returncode == 1 and _GIT_FILE_NOT_FOUND_RE.search(
            result.stderr or ""
        ):
            return (False, stderr_excerpt)
        return (True, stderr_excerpt)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _diff_header_target_basename(diff: str) -> str | None:
    """Return the basename declared by the diff's first ``+++`` header, or None.

    None is returned when the diff carries no ``+++`` header (a header-less
    append-only fragment asserts no target file — valid by construction). Strips
    a leading ``a/``/``b/`` prefix and any trailing tab-separated timestamp, then
    returns the final path component.
    """
    for line in diff.splitlines():
        if line.startswith("+++"):
            rest = line[3:].strip().split("\t", 1)[0].strip()
            if rest.startswith(("a/", "b/")):
                rest = rest[2:]
            return rest.rsplit("/", 1)[-1] if rest else None
    return None


def _gate_validated_diff(
    diff: str,
    target_file: Path,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
) -> str:
    """F2 GATE: return a parseable diff or "" (reject) — never a broken one.

    Promotes the former WARN-only `_validate_unified_diff` call to a repair-or-
    reject gate. Pipeline (loud-fail at every step — no silent swallow):

      1. `git apply --check` passes (rc != 128) → return diff unchanged.
      2. rc=128 → recompute @@ counts via `_recount_hunk_header`, re-check.
         Repair succeeded → return repaired diff (logs what was repaired).
      3. Repair still rc=128 AND target on disk → rebuild from scratch against
         the CURRENT file via the difflib append builder (always-parseable),
         re-check. Success → return rebuilt diff.
      4. All paths exhausted → log the final stderr excerpt + return "" so the
         caller stores an EMPTY diff (caught downstream as nothing-to-apply)
         rather than a known-broken one that funnels to rc=128 on every drain.

    Step 3 refuses a REPLACE diff outright: its builder takes added lines only,
    so rebuilding one drops the removal silently.

    C2 constraint: every branch emits a stderr line; nothing is dropped silently.

    `agents_dir` is the applicability-check seam — it resolves the git scope the
    inner `_validate_unified_diff` calls run under, so a test can point the gate
    at a temporary work tree instead of the live install. The module default
    keeps production callers unchanged.
    """
    if not diff.strip():
        return diff

    # Basename-match assertion — a '+++' header declares the file the diff
    # targets. If its basename diverges from target_file, `git apply` (run under
    # GIT_ROOT with --directory path resolution) could land the diff on ANOTHER
    # agent body; the apply-side before-image/verify (bound to target_file) would
    # neither catch nor restore that wrong-file mutation. Reject BEFORE any
    # repair/apply. A header-less fragment (None) asserts no target → passes.
    declared = _diff_header_target_basename(diff)
    if declared is not None and declared != target_file.name:
        sys.stderr.write(
            f"[daemon-cycle] F2 GATE: diff '+++' header targets {declared!r} but "
            f"proposal target is {target_file.name!r} — wrong-file diff rejected "
            f"(stored empty)\n"
        )
        return ""

    parseable, stderr_excerpt = _validate_unified_diff(diff, agents_dir)
    if parseable:
        return diff

    # Step 2 — count repair.
    repaired = _recount_hunk_header(diff)
    if repaired != diff:
        re_parseable, re_stderr = _validate_unified_diff(repaired, agents_dir)
        if re_parseable:
            sys.stderr.write(
                f"[daemon-cycle] F2 GATE: recount-repaired diff now passes "
                f"git apply --check for {target_file.name}\n"
            )
            return repaired
        stderr_excerpt = re_stderr

    # Step 3 — full rebuild against the current file (added-only lines).
    if target_file.exists():
        try:
            target_lines = target_file.read_text(encoding="utf-8").splitlines(
                keepends=True
            )
        except OSError as exc:
            sys.stderr.write(
                f"[daemon-cycle] F2 GATE: cannot read target for rebuild "
                f"{target_file.name}: {exc} — rejecting diff\n"
            )
            return ""
        _, added_lines, removed_lines = _split_fragment_lines(diff)
        if added_lines and removed_lines:
            _warn_removal_refusal(
                site="F2 GATE rebuild",
                target_file=target_file,
                removed_count=len(removed_lines),
            )
            return ""
        if added_lines:
            rebuilt = _build_difflib_append_diff(
                rel_name=target_file.name,
                target_lines=target_lines,
                added_lines=added_lines,
            )
            rb_parseable, rb_stderr = _validate_unified_diff(rebuilt, agents_dir)
            if rb_parseable:
                sys.stderr.write(
                    f"[daemon-cycle] F2 GATE: rebuilt diff from current file "
                    f"for {target_file.name} (counts unrecoverable in-place)\n"
                )
                return rebuilt
            stderr_excerpt = rb_stderr

    # Step 4 — reject (store empty, never broken).
    sys.stderr.write(
        f"[daemon-cycle] F2 GATE: diff unrepairable for {target_file.name} "
        f"— rejecting (stored empty) — last stderr={stderr_excerpt!r}\n"
    )
    return ""


def _log_haiku_parse_failure(
    *,
    target_agent: str,
    target_file: str,
    pattern_label: str,
    raw_response: str,
    parse_failure_reason: str,
    reports_dir: Path = DEFAULT_REPORTS_DIR,
) -> None:
    """Append parse-failure observability record to autoagent-haiku-debug JSONL.

    When `_parse_haiku_response` enters the failed branch (strict + fuzzy both
    miss), capture raw stdout for post-mortem analysis. Truncates raw_response
    to 4000 chars.

    Daemon flow MUST NOT be blocked by logging failure → IOError is captured +
    emitted as stderr WARN, NOT raised.
    """
    try:
        reports_dir.mkdir(parents=True, exist_ok=True)
    except (OSError, IOError) as exc:
        sys.stderr.write(
            f"[daemon-cycle] WARN: cannot create haiku-debug dir "
            f"{reports_dir}: {exc}\n"
        )
        return

    now = datetime.now(timezone.utc)
    cycle_date = now.strftime("%Y-%m-%d")
    log_path = reports_dir / f"autoagent-haiku-debug-{cycle_date}.jsonl"
    payload: dict[str, str] = {
        "ts": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "cycle_date": cycle_date,
        "target_agent": target_agent,
        "target_file": target_file,
        "pattern_label": pattern_label,
        "raw_response_first_4000_chars": raw_response[:4000],
        "parse_failure_reason": parse_failure_reason,
    }
    try:
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except (OSError, IOError) as exc:
        # C2: silent ignore but stderr-trace — never raise into daemon flow.
        sys.stderr.write(
            f"[daemon-cycle] WARN: haiku-debug log write failed "
            f"({log_path}): {exc}\n"
        )


def _try_fuzzy_parse(raw: str) -> tuple[str | None, str | None]:
    """Fuzzy fallback for RATIONALE / DIFF extraction.

    Returns (rationale, raw_diff) where each element is None when the fuzzy
    regex also missed. Callers MUST set parse_mode='fuzzy' when ANY non-None
    value is returned — explicit status, no silent coerce.
    """
    rationale_m = _HAIKU_RATIONALE_FUZZY_RE.search(raw)
    rationale = rationale_m.group(1).strip()[:400] if rationale_m else None

    # Try DIFF: header anchor first (any case); fall back to bare --- a/ block.
    diff_m = _HAIKU_DIFF_FUZZY_HEADER_RE.search(raw)
    if diff_m:
        raw_diff: str | None = diff_m.group(1).strip()
    else:
        anchor_m = _HAIKU_DIFF_FUZZY_ANCHOR_RE.search(raw)
        raw_diff = anchor_m.group(1).strip() if anchor_m else None

    return rationale, raw_diff


def _parse_haiku_response(stdout: str, target_file: Path) -> PatchProposal:
    """Parse Haiku's structured response — be forgiving but report failures.

    The DIFF section is passed through `_normalize_to_unified_diff` before
    storage, which:
      - Strips ```diff / ``` markdown fences the LLM keeps emitting,
      - Detects whether the LLM-emitted body is already a valid unified diff,
      - Otherwise synthesizes proper --- / +++ / @@ headers via anchor-matching
        or difflib append-to-EOF.
    This eliminates the rc=128 "No valid patches in input" funnel that routes
    a malformed patch into the pending-resolver target_drift bucket.

    Resilience:
      - Observability: parse-failure paths emit JSONL log via
        `_log_haiku_parse_failure`.
      - Fuzzy fallback: when strict regex misses RATIONALE/DIFF markers,
        try case-insensitive + unanchored regex before falling back.
        parse_mode tag ('strict' | 'fuzzy' | 'failed') propagates
        explicit status — NO silent coerce.
    """
    raw = stdout.strip()

    rationale_m = _HAIKU_RATIONALE_RE.search(raw)
    touches_m = _HAIKU_TOUCHES_RE.search(raw)
    lines_m = _HAIKU_LINES_RE.search(raw)
    diff_m = _HAIKU_DIFF_RE.search(raw)

    # parse_mode tracking — 'strict' if both rationale + diff parsed via canonical
    # regex; 'fuzzy' if fuzzy fallback recovered either; 'failed' if both missed.
    strict_rationale_hit = rationale_m is not None
    strict_diff_hit = diff_m is not None

    rationale: str
    raw_diff: str
    parse_mode: str

    if strict_rationale_hit and strict_diff_hit:
        # Happy path — canonical markers present.
        rationale = rationale_m.group(1).strip()
        raw_diff = diff_m.group(1).strip()
        parse_mode = "strict"
    else:
        # Fuzzy fallback — case-insensitive + unanchored markers.
        fuzzy_rationale, fuzzy_diff = _try_fuzzy_parse(raw)
        # Prefer strict hits where present; fill the missing side with fuzzy.
        rationale_str = (
            rationale_m.group(1).strip()
            if strict_rationale_hit
            else (fuzzy_rationale or "")
        )
        diff_str = (
            diff_m.group(1).strip()
            if strict_diff_hit
            else (fuzzy_diff or "")
        )
        if rationale_str and diff_str:
            # At least one side came from fuzzy — explicit status, no silent coerce.
            rationale = rationale_str
            raw_diff = diff_str
            parse_mode = "fuzzy"
        else:
            # Both strict + fuzzy missed → failure path.
            rationale = rationale_str or "(no rationale parsed)"
            raw_diff = diff_str
            parse_mode = "failed"
            # Observability log on parse failure.
            _log_haiku_parse_failure(
                target_agent=target_file.stem,
                target_file=str(target_file),
                pattern_label="",  # caller scope — pattern label not visible here
                raw_response=raw,
                parse_failure_reason=(
                    f"strict_rationale={strict_rationale_hit} "
                    f"strict_diff={strict_diff_hit} "
                    f"fuzzy_rationale={fuzzy_rationale is not None} "
                    f"fuzzy_diff={fuzzy_diff is not None}"
                ),
            )

    # Normalize: strip fences + synthesize headers if missing (the count gate
    # applies inside _normalize_to_unified_diff for the headers-present path).
    diff = _normalize_to_unified_diff(raw_diff, target_file)

    # A REPLACE fragment that came back empty was refused by one of the add-only
    # rebuild sites rather than rebuilt into a silent append. The flag is read
    # below to stamp the rationale, so the pattern rows this class terminalizes
    # are filterable apart from a quality reject.
    is_removal_refused = not diff.strip() and _diff_is_replace_shape(
        _strip_markdown_fences(raw_diff)
    )

    # Validation gate — repair-or-reject: recount → rebuild → reject, never
    # store a diff that fails git apply --check. Every branch logs (no silent
    # drop).
    if diff.strip():
        gate_input = diff
        diff = _gate_validated_diff(diff, target_file)
        # Scoped past the gate's wrong-file arm, which also returns "" but is a
        # basename verdict rather than a refusal.
        is_removal_refused = (
            not diff.strip()
            and _diff_is_replace_shape(gate_input)
            and _diff_header_target_basename(gate_input)
            in (None, target_file.name)
        )

    if is_removal_refused:
        rationale = f"{REMOVAL_REFUSAL_REASON_PREFIX}: {rationale}"

    touches = False
    if touches_m and touches_m.group(1).strip().lower() in {"true", "yes", "1"}:
        touches = True
    # Also detect frontmatter touches by scanning the diff itself for identity field changes.
    # A '+' line containing 'name:' or 'tools:' etc. at column ≤4 signals frontmatter.
    if not touches and diff:
        touches = _diff_touches_frontmatter(diff)

    added = int(lines_m.group(1)) if lines_m else _count_added_lines(diff)

    return PatchProposal(
        target_file=str(target_file),
        rationale=rationale[:400],
        proposed_diff=diff[:4000],
        touched_frontmatter=touches,
        estimated_added_lines=added,
        estimated_removed_lines=_count_removed_lines(diff),
        raw_response=raw[:4000],
        parse_mode=parse_mode,
    )


def _count_marker_lines(diff: str, marker: str) -> int:
    """Count lines starting with `marker`, skipping the `marker * 3` file header."""
    if not diff:
        return 0
    header = marker * 3
    return sum(
        1
        for line in diff.splitlines()
        if line.startswith(marker) and not line.startswith(header)
    )


def _count_added_lines(diff: str) -> int:
    return _count_marker_lines(diff, "+")


def _count_removed_lines(diff: str) -> int:
    return _count_marker_lines(diff, "-")


def _diff_touches_frontmatter(diff: str) -> bool:
    """Heuristic: any '+'/'-' line whose value side starts with a known identity key."""
    pattern = re.compile(
        rf"^[+-]\s*({'|'.join(re.escape(k) for k in FRONTMATTER_IDENTITY_FIELDS)})\s*:"
    )
    return any(pattern.match(line) for line in diff.splitlines())


# -- T3/T4: corpus-size telemetry + prose-only-add detection ----------------
#
# DETECTION-ONLY. These helpers NEVER block, reject, or alter cycle flow — they
# compute a signal and hand it to the caller for persistence. The governing plan
# (doc 57031) tasks T3/T4 mandate honest DETECTION labels: a growing rule corpus or an append-only patch produces a
# WARNING, never a fail-closed reject (false-blocking the learning loop is the
# worse failure than a missed warning).

# The compliance-rate computation lives in ONE shared module
# (hooks/compliance_telemetry.py) so the formula exists once (plan T3/T4 DRY
# requirement); its JSONL writer half is retired. The hooks dir is already on
# sys.path (added at module top for _pg_learning_dualwrite). Fail-soft: a missing shared module
# disables telemetry (detection-only) rather than crashing the cycle.
try:
    import compliance_telemetry as _compliance_telemetry
except Exception as _ct_import_exc:  # noqa: BLE001 — telemetry is non-critical
    # _compliance_telemetry is None is the SOLE disabled-state flag consulted.
    _compliance_telemetry = None  # type: ignore[assignment]
    sys.stderr.write(
        "[daemon-cycle] WARN: compliance_telemetry import failed — corpus/compliance "
        f"telemetry disabled (detection-only): {type(_ct_import_exc).__name__}: "
        f"{_ct_import_exc}\n"
    )

# T3 absolute-threshold seed multiplier — the day-one absolute alert threshold is
# the measured corpus size * this factor, so the alert is NOT red on the day the
# baseline is captured (alert-fatigue mitigation, plan T3 acceptance (b)).
CORPUS_THRESHOLD_SEED_FACTOR = 1.10

# Rough chars→tokens divisor (English prose ≈ 4 chars/token). The audit reports
# BOTH an exact word count and this token ESTIMATE — neither is a billing figure,
# only a relative growth signal, so a coarse divisor is sufficient.
_CHARS_PER_TOKEN = 4


def _corpus_files(
    rules_dir: Path = DEFAULT_RULES_DIR,
    global_rules_file: Path = GLOBAL_RULES_FILE,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
) -> list[Path]:
    """The prompt corpus: every ``*.md`` under rules_dir, the agent bodies
    directly under agents_dir, and GLOBAL_RULES.md.

    Agent bodies glob non-recursively, mirroring ``_agent_roster`` — an archived
    or template body under a subdirectory is not corpus the loop appends to.
    GLOBAL_RULES.md itself lives in agents_dir; the set de-duplicates it.

    Returns a sorted, de-duplicated path list. A missing directory yields an
    empty list (detection-only — never raises into the cycle).
    """
    found: set[Path] = set()
    if rules_dir.is_dir():
        found.update(p for p in rules_dir.rglob("*.md") if p.is_file())
    if agents_dir.is_dir():
        found.update(p for p in agents_dir.glob("*.md") if p.is_file())
    if global_rules_file.is_file():
        found.add(global_rules_file)
    return sorted(found)


def compute_corpus_telemetry(
    rules_dir: Path = DEFAULT_RULES_DIR,
    global_rules_file: Path = GLOBAL_RULES_FILE,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
) -> dict[str, int]:
    """Total word + estimated-token count across the prompt corpus (detection-only).

    Returns ``{"word_count", "token_estimate", "file_count"}``. An unreadable
    file is skipped (counted as zero, logged to stderr) so one bad file cannot
    poison the audit. NEVER raises into the cycle.
    """
    word_count = 0
    char_count = 0
    file_count = 0
    for path in _corpus_files(rules_dir, global_rules_file, agents_dir):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            print(
                f"[corpus-telemetry] skip unreadable corpus file {path.name}: {exc}",
                file=sys.stderr,
            )
            continue
        word_count += len(text.split())
        char_count += len(text)
        file_count += 1
    return {
        "word_count": word_count,
        "token_estimate": char_count // _CHARS_PER_TOKEN,
        "file_count": file_count,
    }


# --- Detection-only sink degradation channel --------------------------------

# Named channel for a detection-only measurement lost to a sink outage. The
# cycle MUST continue when the sink is down, so a skip has to leave a
# retrievable trace somewhere other than the cycle's exit status.
_SINK_DEGRADATIONS: list[dict[str, str]] = []


def get_sink_degradations() -> list[dict[str, str]]:
    """Degradations recorded so far — one entry per lost detection measurement."""
    return list(_SINK_DEGRADATIONS)


def clear_sink_degradations() -> None:
    _SINK_DEGRADATIONS.clear()


def record_sink_degradation(family: str, error: BaseException) -> None:
    """Record one lost detection-only measurement + emit its named warning.

    Named warning + named channel together are what separate this from silent
    absorption: the operator sees the line, and a later reader can enumerate
    exactly which measurements the outage cost.
    """
    detail = f"{type(error).__name__}: {str(error)[:160]}"
    _SINK_DEGRADATIONS.append({"family": family, "error": detail})
    sys.stderr.write(
        f"[daemon-cycle] WARN: sink unavailable — {family} measurement not "
        f"persisted: {detail}\n"
    )


def emit_corpus_audit(signal: dict[str, object], cycle_date: str) -> bool:
    """UPSERT one corpus-size audit signal into core.autoagent_corpus_audits.

    Returns True when the row was written. A sink outage returns False after
    recording the degradation — never raises into the cycle.
    """
    if not HAS_PG_LOOP_WRITE:
        record_sink_degradation(
            "corpus_size_audit", RuntimeError("PG helper import unavailable")
        )
        return False
    try:
        _pg_write_corpus_audit(
            cycle_date=cycle_date,
            word_count=signal["word_count"],
            token_estimate=signal["token_estimate"],
            file_count=signal["file_count"],
            trend_alert=signal["trend_alert"],
            trend_delta=signal["trend_delta"],
            absolute_alert=signal["absolute_alert"],
            seeded_threshold=signal["seeded_threshold"],
            compliance_rate=signal["compliance_rate"],
            override_rate=signal["override_rate"],
            gate_pass_count=signal["gate_pass_count"],
            gate_trip_count=signal["gate_trip_count"],
            gate_total_count=signal["gate_total_count"],
        )
        return True
    except Exception as exc:  # noqa: BLE001 — branched below, never absorbed
        record_sink_degradation("corpus_size_audit", exc)
        return False


def audit_corpus_size(
    *,
    rules_dir: Path = DEFAULT_RULES_DIR,
    global_rules_file: Path = GLOBAL_RULES_FILE,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
    prev_word_count: int | None = None,
    absolute_threshold: int | None = None,
    gate_log_file: Path | None = None,
) -> dict[str, object]:
    """Corpus-size trend audit (DETECTION-ONLY — NEVER blocks).

    Computes the current word/token count, then decides whether to ALERT on
    EITHER axis (plan T3 acceptance (b)):

      * TREND-delta — when ``prev_word_count`` (last week's baseline) is supplied,
        alert when the corpus GREW week-over-week (current > prev).
      * Absolute — when ``absolute_threshold`` is supplied, alert when the current
        count exceeds it. A threshold SEEDED at ``current * 1.10`` (see
        ``CORPUS_THRESHOLD_SEED_FACTOR``) is NOT red on day one.

    Also records the TRUE COMPLIANCE-RATE (plan Principle 7 Goodhart guard: the
    proxy metric is compliance rate, NEVER rule-count or patch-count). The rate
    is ``pass / total`` over REAL gate encounters parsed from the durable
    workflow-gate trace log — a genuine rate in ``[0.0, 1.0]``, not the former
    degenerate ``1 - (trip)/(trip)`` 0/1 flag. When the log is absent/empty the
    rate is ``None`` (honest insufficient-data, never a fabricated value); the
    override dimension has no durable store, so ``override_rate`` is always
    ``None``.

    ONE-TIME SERIES STEP — for the Tier-3 reader of the multi-week series: the
    first reading taken after the corpus widened to the agent bodies jumps by
    the agents-directory word count. That step is a change of what is measured,
    not growth of what was already measured — read it as a new baseline and
    compare later readings against it, not across it. Harmless on the alert
    axes: the live call passes no ``prev_word_count``, so ``trend_delta`` stays
    null and no trend alert fires on the step.

    Returns the signal dict. Persistence is the caller's step (``emit_corpus_audit``
    → core.autoagent_corpus_audits); this function is pure measurement.
    """
    telemetry = compute_corpus_telemetry(rules_dir, global_rules_file, agents_dir)
    current_words = telemetry["word_count"]

    trend_alert = False
    trend_delta: int | None = None
    if prev_word_count is not None:
        trend_delta = current_words - int(prev_word_count)
        trend_alert = trend_delta > 0

    absolute_alert = False
    seeded_threshold = int(current_words * CORPUS_THRESHOLD_SEED_FACTOR)
    if absolute_threshold is not None:
        absolute_alert = current_words > int(absolute_threshold)

    # TRUE compliance rate from the shared SoT (gate-trace event source). When the
    # shared module is unavailable, degrade to insufficient-data (None) — never a
    # fabricated 0.0/1.0.
    if _compliance_telemetry is not None:
        compliance = _compliance_telemetry.compute_compliance_rate(log_file=gate_log_file)
    else:
        # Module absent → the same insufficient-data shape, hand-built here so the
        # disabled path stays self-contained (the shared factory is unreachable).
        compliance = {
            "compliance_rate": None,
            "gate_pass_count": 0,
            "gate_trip_count": 0,
            "gate_total_count": 0,
            "override_rate": None,
            "compliance_source": None,
        }

    signal: dict[str, object] = {
        "signal_type": "corpus_size_audit",
        "detection_only": True,
        "word_count": current_words,
        "token_estimate": telemetry["token_estimate"],
        "file_count": telemetry["file_count"],
        "trend_alert": trend_alert,
        "trend_delta": trend_delta,
        "absolute_alert": absolute_alert,
        "seeded_threshold": seeded_threshold,
        # Real rate (None when insufficient data) + the raw counts behind it.
        "compliance_rate": compliance["compliance_rate"],
        "override_rate": compliance["override_rate"],
        "gate_pass_count": compliance["gate_pass_count"],
        "gate_trip_count": compliance["gate_trip_count"],
        "gate_total_count": compliance["gate_total_count"],
    }
    return signal


def classify_prose_only_add(
    diff: str,
    *,
    target_file: str = "",
) -> dict[str, object]:
    """Prose-only-ADD patch classifier (DETECTION-ONLY — NEVER rejects).

    Emits a ``prose-only-add`` WARNING verdict when a proposed
    patch is added-lines>0 AND removed-lines==0 AND touches NO hook file (plan
    T4). It returns the verdict but NEVER rejects the patch — a converted-from-
    fail-closed warning, because false-blocking the learning loop is the worse
    failure (plan Risk note on T4).

    A patch that REMOVES lines (a conversion / subtraction) OR touches a hook
    file does NOT warn. The verdict is persisted on the proposal row by the
    caller; this function is pure classification.
    """
    _context, added, removed = _split_fragment_lines(diff or "")
    # The hook check can only flip the verdict in the added-only case, so skip its
    # full diff walk for every conversion/subtraction patch (removed non-empty).
    touches_hook = (
        _diff_touches_hook_file(diff or "", target_file)
        if (added and not removed)
        else False
    )

    is_prose_only_add = bool(added) and not removed and not touches_hook

    signal: dict[str, object] = {
        "signal_type": "patch_classification",
        "detection_only": True,
        "classification": "prose-only-add" if is_prose_only_add else "ok",
        "warning": is_prose_only_add,
        "added_lines": len(added),
        "removed_lines": len(removed),
        "touches_hook_file": touches_hook,
        "target_file": target_file,
    }
    return signal


def _compose_pre_verify_axes(
    axes: dict[str, bool] | None,
    prose_only_add: bool | None,
) -> dict[str, bool]:
    """Build the persisted ``pre_verify_axes`` payload for one proposal row.

    Carries the prose-only-add verdict on BOTH paths — including the one where
    pre-verify did not run (``axes`` None/empty), which is why the verdict is a
    parameter here rather than an injection into the pre-verify result: a row
    that skipped pre-verify still has a classified diff and must not vanish from
    the rolling count.

    ``prose_only_add`` None (no diff → nothing classified) writes NO key, so a
    reader can tell unclassified from a negative verdict.
    """
    payload: dict[str, bool] = dict(axes) if axes else {}
    if prose_only_add is not None:
        payload[PROSE_ONLY_ADD_AXIS_KEY] = bool(prose_only_add)
    return payload


# Hook files live under hooks/ and end in .sh/.py/.bats — a patch touching one is
# a MECHANICAL change, exempt from the prose-only-add warning (the warning targets
# append-only DECLARATIVE prose growth, not hook logic).
_HOOK_PATH_RE = re.compile(r"(^|/)hooks/.*\.(sh|py|bats)$")


def _diff_touches_hook_file(diff: str, target_file: str) -> bool:
    """True iff the patch target OR any diff ``+++``/``---`` header is a hook file."""
    if target_file and _HOOK_PATH_RE.search(target_file):
        return True
    for line in diff.splitlines():
        if line.startswith(("+++", "---")):
            # strip the 'a/'/'b/' diff prefix before matching
            path = line[3:].strip()
            path = re.sub(r"^[ab]/", "", path)
            if _HOOK_PATH_RE.search(path):
                return True
    return False


# -- reference-resolution guard ---------------------------------------------
#
# run_pre_verify delegates entirely to an LLM over 4 semantic axes (C1-C4) with
# NO mechanical on-disk existence check on path/rule pointers a diff INTRODUCES,
# so a plausible-but-DEAD pointer (a since-moved rule path — e.g. the pre-move
# `~/.claude/rules/core-*.md` form that lost its `glass-atrium/` segment) sails
# through. This deterministic pass resolves every in-scope pointer token added by
# the diff against the filesystem and WARNS on a miss. It is DETECTION-ONLY —
# never a hard reject (per shared-self-improve-hygiene.md Prose-Only-Add: false-
# blocking the learning loop is the worse failure than a missed warning).

# The harness root under which a bare `rules/...` reference resolves.
_HARNESS_ROOT = HOME / ".claude"

# A path token ending in `.md`. The char class deliberately admits glob `*` and
# `<var>` chars so a globbed / placeholder token is captured WHOLE — then excluded
# below — instead of matching only its literal prefix.
_MD_POINTER_RE = re.compile(r"[~\w.][\w./~<>*-]*\.md\b")

# An illustrative line (example / e.g. / i.e.) cites a form, not a live reference.
# NB: `e.g.` / `i.e.` end in a period (non-word char) so a trailing `\b` would
# never match after them — the word-boundary anchor rides only the word forms.
_EXAMPLE_CONTEXT_RE = re.compile(
    r"(?:\be\.g\.|\bi\.e\.|\bexamples?\b|\bfor instance\b)", re.IGNORECASE
)


def _iter_added_reference_lines(diff: str) -> list[str]:
    """Added ('+') diff lines OUTSIDE any fenced code block, diff-prefix stripped.

    A ``` fence toggles collection off: fenced content is an illustrative snippet
    (a rule QUOTE / worked example), not a live pointer. Fence state is tracked
    across context AND added lines so a fence opened on a context line still
    suppresses the added lines inside it.
    """
    out: list[str] = []
    in_fence = False
    for raw_line in (diff or "").splitlines():
        if raw_line.startswith(("+++", "---", "@@")):
            continue
        marker = raw_line[:1]
        content = raw_line[1:] if marker in "+- " else raw_line
        if content.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if marker == "+":
            out.append(content)
    return out


def _resolve_reference_token(token: str) -> Path | None:
    """Map an in-scope pointer token to the on-disk Path to check, else None.

    In-scope forms (conservative — only these resolve): tilde-absolute
    `~/.claude/...`, bare `.claude/...` (the /-lookbehind-blindspot form), and
    relative `rules/...` (resolved under the harness root). Any other token
    (a bare filename, a non-harness path) is out of scope → None.
    """
    if token.startswith("~/.claude/"):
        return Path(token).expanduser()
    if token.startswith(".claude/"):
        return HOME / token
    if token.startswith("rules/"):
        return _HARNESS_ROOT / token
    return None


def classify_dead_reference(
    diff: str,
    *,
    target_file: str = "",
    record: bool = True,
) -> dict[str, object]:
    """Deterministic dead-reference detector for ADDED pointer tokens (DETECTION-ONLY).

    For each `+` added line (outside fenced code / example context) it extracts
    every in-scope `.md` pointer token, EXCLUDES any carrying a glob `*` or a
    `<var>` placeholder, then resolves the rest on disk (``.exists()`` follows
    symlinks). A token that does NOT resolve is a DEAD reference → collected.

    Emits a ``reference_resolution`` WARNING as a loud stderr note when ≥1 dead
    reference is found (``record`` gates it). It NEVER rejects the patch.
    """
    dead: list[str] = []
    checked_count = 0
    for line in _iter_added_reference_lines(diff):
        if _EXAMPLE_CONTEXT_RE.search(line):
            continue
        for token in _MD_POINTER_RE.findall(line):
            # Glob / placeholder tokens describe a FORM, not a real file.
            if "*" in token or "<" in token or ">" in token:
                continue
            resolved = _resolve_reference_token(token)
            if resolved is None:
                continue
            checked_count += 1
            if not resolved.exists():
                dead.append(token)

    is_dead = bool(dead)
    signal: dict[str, object] = {
        "signal_type": "reference_resolution",
        "detection_only": True,
        "classification": "dead-reference" if is_dead else "ok",
        "warning": is_dead,
        "dead_references": dead,
        "checked_count": checked_count,
        "target_file": target_file,
    }
    if record and is_dead:
        sys.stderr.write(
            "[daemon-cycle] WARN: dead-reference — added line(s) cite "
            f"unresolved pointer(s) {dead} in target={target_file or '<unknown>'} "
            "→ DETECTION-ONLY warning (patch NOT rejected).\n"
        )
    return signal


# -- M4: area classification gate -------------------------------------------


def _target_in_agents_dir(target: Path, agents_dir: Path) -> bool:
    """True iff ``target`` is a member of ``agents_dir`` under a symlink-farm layout.

    The live layout makes a strict ``target.resolve().relative_to(agents_dir
    .resolve())`` reject EVERY legitimate member: agents_dir is a REAL directory
    whose ``*.md`` entries are per-FILE symlinks into another tree, so resolving
    the member jumps trees while resolving the directory does not. Containment
    therefore accepts ANY of:
      1. lexical — the non-symlink-resolved absolute path is under agents_dir
         (``normpath`` collapses ``..`` escapes, so traversal still rejects);
      2. canonical — realpath(target) under realpath(agents_dir) (covers an
         agents_dir that is ITSELF a symlink);
      3. member identity — realpath(target) equals the realpath of the
         same-named agents_dir entry (covers a target given directly as a
         member symlink's destination path).
    """
    target_lex = Path(os.path.abspath(str(target)))
    agents_lex = Path(os.path.abspath(str(agents_dir)))
    if target_lex.is_relative_to(agents_lex):
        return True
    target_real = Path(os.path.realpath(str(target)))
    if target_real.is_relative_to(Path(os.path.realpath(str(agents_dir)))):
        return True
    return target_real == Path(os.path.realpath(str(agents_lex / target_lex.name)))


def classify_patch_area(
    patch: PatchProposal,
    target_agent_path: Path,
    *,
    seen_targets: set[str] | None = None,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
) -> Classification:
    """Apply-area gate — body-auto / frontmatter-dryrun / reject.

    WHY this ordering:
        1. Reject FIRST — out-of-scope / conflict checks must short-circuit
           before we look at content (no point classifying a patch that
           targets a non-agent file).
        2. Frontmatter SECOND — identity fields are sensitive. Even a
           single-line skills change deserves dry-run human review.
        3. Body-auto LAST — only patches that survived the above two
           checks AND fit the small-edit budget reach auto-apply.
    """
    abs_path = target_agent_path.resolve()

    # --- reject path ------------------------------------------------------

    # R1: target outside agents/ (e.g. ~/.claude/rules/*.md, /tmp/anything).
    # Dual lexical/canonical check — the per-file symlink-farm layout breaks a
    # strict resolve()+relative_to (see _target_in_agents_dir).
    if not _target_in_agents_dir(target_agent_path, agents_dir):
        return "reject"

    # R2: target file does not exist → would be a NEW agent (out of scope here)
    if not target_agent_path.exists():
        return "reject"

    # R3: empty diff = nothing to classify (Haiku failed / skipped)
    if not patch.proposed_diff.strip():
        return "reject"

    # R4: same target already queued in this cycle (conflict guard)
    if seen_targets is not None and str(abs_path) in seen_targets:
        return "reject"

    # --- frontmatter dry-run ----------------------------------------------

    if patch.touched_frontmatter:
        return "frontmatter-dryrun"

    # --- body-auto (final gate) -------------------------------------------

    if patch.estimated_added_lines > BODY_AUTO_LINE_LIMIT:
        # Body-only but too large → still defer to dry-run so a human eyes it.
        return "frontmatter-dryrun"

    return "body-auto"


# -- safety tier classification (2-tier model) ------------------------------


def classify_safety_tier(patch: PatchProposal) -> str:
    """Return 'safety' when patch matches an irreversible/external-effect rule,
    else empty string. The empty case is auto-eligible (body-auto-bound, not
    a safety override).

    Three triggers per core-security.md High-impact actions:
      1. target_file path matches a sensitive-file regex (GLOBAL_RULES,
         core-security.md, scope-security.md, core-learning-log.md, .env,
         com.claude.*.plist / com.glass-atrium.*.plist).
         This tier ALWAYS calls the bare matcher, never the updater's
         sync-exempt variant — the charter classifies safety-sensitive here.
      2. proposed_diff body contains a sensitive-token regex. The tuple
         _SAFETY_SENSITIVE_DIFF_PATTERNS is the authority for the row set —
         forced deletion, permission/ACL, TCC reset, launchctl lifecycle,
         force-push, destructive-git recovery forms, DB drop, dynamic
         execution — and each row carries its own scope comment there.
      3. touched_frontmatter=True (name/tools/scope/etc. — identity surface)

    Empty diff → no safety classification (downstream classify_patch_area
    already routes empty-diff to 'reject').

    Idempotent — same input → same verdict. Word-boundary regex protects
    against `farm`/`confirm` false positives.
    """
    # Empty diff is benign — downstream classify_patch_area handles reject.
    if not patch.proposed_diff.strip():
        return ""

    # Trigger 3: frontmatter identity touched (already implied by
    # touched_frontmatter flag; classify_patch_area defers to dry-run, but
    # we still surface 'safety' for downstream user-approval routing).
    if patch.touched_frontmatter:
        return "safety"

    # Trigger 1: sensitive target path. Shared primitive — same matcher the
    # update skill's python helper imports (T15, single compiled source).
    if match_sensitive_path(patch.target_file or "") is not None:
        return "safety"

    # Trigger 2: sensitive diff body content (ADDED lines only). Shared
    # primitive — see match_sensitive_diff.
    if match_sensitive_diff(patch.proposed_diff) is not None:
        return "safety"

    return ""


# -- pre-verify (4-axis meta-prompt-engineer review) ---------------------------


_PRE_VERIFY_PROMPT_TEMPLATE = """You are meta-prompt-engineer acting as a compliance verifier for AutoAgent.

A patch has been proposed for a target agent's instruction file. Your job is
to evaluate the patch against 4 independent compliance axes and emit a
strict, parseable verdict.

PATCH METADATA:
- target_agent: {target_agent}
- target_file: {target_file}
- pattern_label: {pattern_label}

PROPOSED DIFF (unified-diff fragment):
---
{diff}
---

RATIONALE FROM PATCH GENERATOR:
{patch_rationale}

COMPLIANCE SOURCES (excerpts):

[C1 core-compliance-matrix.md — Tier 1/2/3 loading policy]
---
{compliance_matrix_excerpt}
---

[C2 GLOBAL_RULES.md — ALL-scope absolute rules]
---
{global_rules_excerpt}
---

[C3 {scope_file_name} — target agent's scope rules]
---
{scope_excerpt}
---

[C4 target agent file — current state, body section]
---
{target_agent_excerpt}
---

VERIFICATION TASK:

For each of the 4 axes, decide PASS or FAIL:
  C1: Does the patch subvert / remove / weaken any Tier-1, Tier-2, or Tier-3
      rule loading policy in compliance-matrix? (FAIL if it removes a rule
      reference the target agent's scope must load.)
  C2: Does the patch violate any GLOBAL_RULES absolute rule (Korean reply
      requirement / secret protection / Position Bias / System Prompt
      Protection / etc.)?
  C3: Does the patch violate any Absolute Rule in the target agent's
      scope file?
  C4: Does the patch CONTRADICT (not merely add to) the target agent's
      OWN existing Absolute Rules / Guardrails / Prohibitions sections?
      (Adding a NEW guardrail consistent with existing ones = PASS.
       Reversing or weakening an existing rule = FAIL.)

OUTPUT STRICT FORMAT (no preamble, no markdown fences, exactly these lines):
C1: PASS|FAIL
C2: PASS|FAIL
C3: PASS|FAIL
C4: PASS|FAIL
VERDICT: verified|unverified
RATIONALE: <one or two sentences in English explaining the overall verdict
            and citing the specific failed axis if any>
"""


_PRE_VERIFY_AXIS_RE = re.compile(r"^(C[1-4]):\s*(PASS|FAIL)\s*$", re.MULTILINE | re.IGNORECASE)
_PRE_VERIFY_VERDICT_RE = re.compile(r"^VERDICT:\s*(verified|unverified)\s*$", re.MULTILINE | re.IGNORECASE)
_PRE_VERIFY_RATIONALE_RE = re.compile(r"^RATIONALE:\s*(.+?)(?=\n[A-Z]+:|\Z)", re.MULTILINE | re.DOTALL)


_MD_HEADING_RE = re.compile(r"^#{1,6} ")


def _split_heading_blocks(text: str) -> list[str]:
    """Split markdown into whole heading blocks — leading preamble, then one per heading."""
    blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines(keepends=True):
        if current and _MD_HEADING_RE.match(line):
            blocks.append("".join(current))
            current = []
        current.append(line)
    if current:
        blocks.append("".join(current))
    return blocks


def _read_sections(path: Path | None, cap: int) -> str:
    """Read a text file as WHOLE markdown heading blocks bounded by `cap` chars.

    A character slice cuts mid-section, and a section the verifier sees only the
    head of reads as a section carrying no rule to violate. Blocks are taken in
    file order until the next would cross `cap`; an oversized FIRST block is kept
    whole, because an excerpt of nothing is worse than one over the bound. Either
    departure is loud on stderr and inside the excerpt itself.

    An empty file returns "" so the caller's emptiness check still fires.
    """
    if path is None or not path.exists():
        return "(file not available)"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"(read error: {exc})"
    if len(text) <= cap:
        return text

    blocks = _split_heading_blocks(text)
    kept: list[str] = []
    used = 0
    for block in blocks:
        if kept and used + len(block) > cap:
            break
        kept.append(block)
        used += len(block)

    dropped = len(blocks) - len(kept)
    if dropped:
        note = (
            f"[TRUNCATED: {dropped} whole heading block(s) dropped at the "
            f"{cap}-char excerpt bound]"
        )
    else:
        note = f"[OVERSIZED: one heading block exceeds the {cap}-char excerpt bound; kept whole]"
    sys.stderr.write(f"[daemon-cycle] WARN: {note} — {path}\n")
    return "".join(kept) + f"\n{note}\n"


# Named signal for an axis file that RESOLVED but carries no content. Distinct
# from the unresolved signals — the path is fine, the miss is content-side — and
# loud for the same reason: an empty excerpt reads to the verifier as an axis it
# inspected and found nothing to violate (Precondition Loud-Fail).
SCOPE_EMPTY_SIGNAL = "SCOPE-FILE-EMPTY"
TARGET_EMPTY_SIGNAL = "TARGET-FILE-EMPTY"


def _empty_excerpt_directive(signal: str, axis: str, subject: str, path: Path) -> str:
    """Warn on stderr and return the directed-FAIL excerpt for an empty axis file."""
    sys.stderr.write(
        f"[daemon-cycle] WARN: {signal} — {path} is empty ({subject}); "
        f"{axis} has no content to judge against\n"
    )
    return (
        f"{signal}: {subject} resolved to {path}, which is empty. "
        f"{axis} cannot be judged from this prompt — answer {axis}: FAIL."
    )


def _build_pre_verify_prompt(
    patch: PatchProposal,
    pattern: Pattern,
) -> str:
    """Compose the 4-axis verification prompt with rule excerpts injected.

    Idempotent — same inputs (patch, pattern, on-disk rule files) produce the
    same prompt text. Excerpts are deterministic (whole heading blocks taken in
    file order under a fixed bound), so retries against the same diff hit
    identical bytes.
    """
    target_path = _get_target_path(patch.target_file)
    if target_path is None:
        # Same reasoning as the C3 slot: an excerpt-missing note reads to the
        # verifier as an axis it inspected and cleared.
        target_file_name = f"{TARGET_UNRESOLVED_SIGNAL} ({patch.target_file})"
        target_agent_excerpt = (
            f"{TARGET_UNRESOLVED_SIGNAL}: no target agent file resolved for "
            f"{patch.target_file}. C4 cannot be judged from this prompt — answer "
            "C4: FAIL."
        )
    else:
        target_file_name = str(target_path)
        target_agent_excerpt = _read_sections(target_path, TARGET_AGENT_EXCERPT_CHAR_CAP)
        if not target_agent_excerpt.strip():
            target_file_name = f"{TARGET_EMPTY_SIGNAL} ({patch.target_file})"
            target_agent_excerpt = _empty_excerpt_directive(
                TARGET_EMPTY_SIGNAL, "C4", "target agent file", target_path
            )

    scope_path = _scope_file_for_agent(pattern.agent)
    if scope_path is None:
        # Directing the verdict is the point: told only that the excerpt is
        # missing, a verifier reports "no violation found" and PASSes an axis it
        # never read.
        scope_file_name = f"{SCOPE_UNRESOLVED_SIGNAL} ({pattern.agent})"
        scope_excerpt = (
            f"{SCOPE_UNRESOLVED_SIGNAL}: no scope file resolved for {pattern.agent}. "
            "C3 cannot be judged from this prompt — answer C3: FAIL."
        )
    else:
        scope_file_name = scope_path.name
        scope_excerpt = _read_sections(scope_path, RULE_EXCERPT_CHAR_CAP)
        if not scope_excerpt.strip():
            scope_file_name = f"{SCOPE_EMPTY_SIGNAL} ({pattern.agent})"
            scope_excerpt = _empty_excerpt_directive(
                SCOPE_EMPTY_SIGNAL, "C3", "scope file", scope_path
            )

    return _PRE_VERIFY_PROMPT_TEMPLATE.format(
        target_agent=pattern.agent,
        target_file=target_file_name,
        pattern_label=_neutralize_field(pattern.label),
        diff=patch.proposed_diff[:DIFF_EXCERPT_CHAR_CAP],
        patch_rationale=patch.rationale[:400],
        compliance_matrix_excerpt=_read_sections(COMPLIANCE_MATRIX_FILE, RULE_EXCERPT_CHAR_CAP),
        global_rules_excerpt=_read_sections(GLOBAL_RULES_FILE, RULE_EXCERPT_CHAR_CAP),
        scope_file_name=scope_file_name,
        scope_excerpt=scope_excerpt,
        target_agent_excerpt=target_agent_excerpt,
    )


def _parse_pre_verify_response(stdout: str) -> tuple[dict[str, bool], bool, str]:
    """Parse the verifier's strict-format response.

    Returns (axes_dict, verdict_from_explicit_field, rationale).

    Conservative parsing: any axis the verifier omitted is treated as FAIL
    (axis missing from response = no PASS evidence = fail).
    """
    raw = stdout.strip()
    axes: dict[str, bool] = {"C1": False, "C2": False, "C3": False, "C4": False}
    for match in _PRE_VERIFY_AXIS_RE.finditer(raw):
        key = match.group(1).upper()
        verdict = match.group(2).upper()
        axes[key] = verdict == "PASS"

    verdict_m = _PRE_VERIFY_VERDICT_RE.search(raw)
    explicit_verified = bool(verdict_m and verdict_m.group(1).lower() == "verified")

    rationale_m = _PRE_VERIFY_RATIONALE_RE.search(raw)
    rationale = rationale_m.group(1).strip() if rationale_m else "(verifier did not emit a rationale)"
    return axes, explicit_verified, rationale[:600]


def _model_class(model_id: str) -> str:
    """Extract the model family token from an id — 'claude-haiku-4-5' → 'haiku'.

    Unknown shapes collapse to the lowercased id so a non-matching pair is never
    falsely reported as evaluator-independent.
    """
    lowered = model_id.strip().lower()
    for family in ("haiku", "sonnet", "opus"):
        if family in lowered:
            return family
    return lowered


def resolve_verifier_model(
    author_model: str = HAIKU_MODEL,
    verifier_model: str = PRE_VERIFY_MODEL,
) -> str:
    """Return the verifier model, warning when it shares the author's class.

    AD-9 evaluator independence: prefer a verifier whose model class differs from
    the proposal author's (CALM self-preference precedent). Feasibility gate —
    when no distinct verifier model is configured the classes match; that is
    surfaced as a loud ADVISORY (stderr WARN, Precondition Loud-Fail) but NEVER
    blocks the loop (advisory-first rollout). Axis order in the verify prompt is
    fixed and the 4 axes are independent PASS/FAIL checks (not ranked
    candidates), so no self-preference-via-ordering applies — order randomization
    is intentionally kept out here, the class-independence axis is the mitigation.
    """
    if _model_class(verifier_model) == _model_class(author_model):
        sys.stderr.write(
            "[daemon-cycle] WARN: evaluator independence not satisfied — verifier "
            f"class {_model_class(verifier_model)!r} == proposal-author class "
            "(self-preference risk, CALM); set AUTOAGENT_PRE_VERIFY_MODEL to a "
            "different class to enable independent verification\n"
        )
    return verifier_model


def run_pre_verify(
    patch: PatchProposal,
    pattern: Pattern,
    *,
    claude_bin: str = CLAUDE_BIN,
    timeout_sec: int = PRE_VERIFY_TIMEOUT_SEC,
    skip_pre_verify: bool = False,
) -> PreVerifyResult:
    """Invoke meta-prompt-engineer (Haiku) to verify a single patch against 4 axes.

    Conservative-by-default semantics:
      - claude CLI failure / timeout / non-zero exit → passed=False (fail-safe).
      - missing rule file → still call verifier (it sees "(file not available)"
        and will FAIL the affected axis).
      - skip_pre_verify=True → skipped (axes empty, passed=False) so the caller
        keeps the patch off the auto-apply path.

    Idempotent: same patch + same on-disk rule files → same prompt → Haiku
    output may vary slightly token-wise but the strict-format axis grid
    parsing collapses noise; identical inputs typically yield identical axes.
    """
    start_ns = time.monotonic_ns()

    if skip_pre_verify:
        return PreVerifyResult(
            passed=False,
            rationale="skip_pre_verify=True (test/preflight)",
            axes={},
            status="skipped:flag",
            latency_ms=0,
        )

    if not patch.proposed_diff.strip():
        return PreVerifyResult(
            passed=False,
            rationale="empty proposed_diff — nothing to verify",
            axes={},
            status="skipped:empty-diff",
            latency_ms=(time.monotonic_ns() - start_ns) // 1_000_000,
        )

    prompt = _build_pre_verify_prompt(patch, pattern)
    # AD-9: resolve the verifier model (warns on same-class-as-author, advisory).
    verifier_model = resolve_verifier_model()

    try:
        completed = subprocess.run(  # nosec — list form, no shell=True
            [
                claude_bin,
                "-p", prompt,
                "--output-format", "text",
                "--max-budget-usd", PRE_VERIFY_MAX_BUDGET_USD,
                "--model", verifier_model,
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
            env={**os.environ, "OTEL_METRICS_EXPORTER": "none"},
        )
    except subprocess.TimeoutExpired:
        return PreVerifyResult(
            passed=False,
            rationale=f"pre-verify timeout after {timeout_sec}s — conservative fail",
            axes={},
            status=f"error:timeout-{timeout_sec}s",
            latency_ms=timeout_sec * 1000,
        )
    except FileNotFoundError:
        return PreVerifyResult(
            passed=False,
            rationale=f"claude CLI not found: {claude_bin} — conservative fail",
            axes={},
            status="error:cli-not-found",
            latency_ms=(time.monotonic_ns() - start_ns) // 1_000_000,
        )

    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000

    if completed.returncode != 0:
        snippet = (completed.stderr or completed.stdout or "")[:200].replace("\n", " ")
        return PreVerifyResult(
            passed=False,
            rationale=f"pre-verify CLI exit={completed.returncode}: {snippet}",
            axes={},
            status=f"error:exit-{completed.returncode}",
            latency_ms=elapsed_ms,
        )

    axes, explicit_verified, rationale = _parse_pre_verify_response(completed.stdout)
    # passed iff: all 4 axes PASS AND explicit verdict == verified.
    # The dual gate (axes + verdict) protects against the verifier emitting
    # PASS on every axis but writing "VERDICT: unverified" or vice versa.
    all_axes_pass = all(axes.get(k, False) for k in ("C1", "C2", "C3", "C4"))
    passed = all_axes_pass and explicit_verified

    return PreVerifyResult(
        passed=passed,
        rationale=rationale,
        axes=axes,
        status="ok",
        latency_ms=elapsed_ms,
    )


# -- Report emission --------------------------------------------------------


def emit_report(report: CycleReport, out_path: Path) -> None:
    """Atomic JSON write — mktemp + os.replace within the same directory."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(_report_to_dict(report), ensure_ascii=False, indent=2)
    fd, tmp_name = tempfile.mkstemp(
        prefix=out_path.name + ".",
        suffix=".tmp",
        dir=str(out_path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.write("\n")
        os.replace(tmp_name, out_path)
    except OSError:
        # Best-effort cleanup of the tempfile on failure.
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _report_to_dict(report: CycleReport) -> dict:
    return {
        "cycle_date": report.cycle_date,
        "generated_at": report.generated_at,
        "patterns_processed": report.patterns_processed,
        "cost_guard": report.cost_guard,
        "patches": [asdict(p) for p in report.patches],
        # AD-10 Solution History runtime observability — tuple-keyed
        # solution_winners is not JSON-serializable, so emit its count summary.
        "solution_history": {
            "cells_retained": len(report.solution_winners),
            "winners_retained": sum(
                len(v) for v in report.solution_winners.values()
            ),
        },
    }


def render_report_json(report: CycleReport) -> str:
    """Convenience: return the JSON string (used by --stdout mode)."""
    return json.dumps(_report_to_dict(report), ensure_ascii=False, indent=2)


# -- Loop-event emission (PG single sink) ----------------------------------
#
# At each cycle end, the module maps PatchResult → loop_event row and UPSERTs it
# directly via the _pg_dual_write_daemon.py helper. File append is forbidden
# (file-sink elimination doctrine).


def _coerce_eval_result(patch: PatchResult) -> str:
    """PatchResult → eval_result varchar(32) mapping.

    Priority:
      1) reject classification → 'reject' (Haiku empty diff / missing target / scope breach)
      2) frontmatter-dryrun → 'frontmatter_dryrun' (user review queue)
      3) body-auto + pre-verify pass → 'verified'
      4) body-auto + pre-verify fail → 'unverified'
      5) body-auto + pre-verify skip (skip_haiku/preflight) → 'skipped'
      6) unknown classification → 'unknown' (defensive)

    eval_result is varchar(32) — must not exceed 32 chars.
    """
    classification = patch.classification
    if classification == "reject":
        return "reject"
    if classification == "frontmatter-dryrun":
        return "frontmatter_dryrun"
    if classification == "body-auto":
        # pre_verify_passed=None → pre-verify did not run (skip path).
        if patch.pre_verify_passed is True:
            return "verified"
        if patch.pre_verify_passed is False:
            # Distinguish skipped:* from error:* — skipped is a normal skip.
            if patch.pre_verify_status.startswith("skipped:"):
                return "skipped"
            return "unverified"
        return "skipped"
    return "unknown"


def _aggregate_loop_events(report: CycleReport) -> list[dict[str, object]]:
    """CycleReport → list of loop_event envelopes.

    When multiple patches share the same (event_ts, agent, eval_result) key,
    pre-aggregate and emit a single envelope to avoid UNIQUE-INDEX collision
    (UPSERT overwrite) data loss.

    Aggregation rules:
      - changes_added: sum of patches[].estimated_added_lines for the same key.
        That count is taken from the FULL pre-truncation diff (proposed_diff is
        capped at 4000 chars, so re-deriving from it under-reports any larger patch).
      - changes_removed: sum of patches[].estimated_removed_lines for the same key,
        taken from the same FULL pre-truncation diff as changes_added.
      - rice: None — the daemon does not compute RICE.

    Empty patches[] (patterns_processed=0) → empty list.
    """
    if not report.patches:
        return []

    # Per-(agent, eval_result) accumulators within one cycle.
    added_by_key: dict[tuple[str, str], int] = defaultdict(int)
    removed_by_key: dict[tuple[str, str], int] = defaultdict(int)
    for patch in report.patches:
        agent = (patch.pattern_agent or "").strip()
        if not agent:
            continue  # pre-empt a helper NOT NULL violation
        eval_result = _coerce_eval_result(patch)[:EVAL_RESULT_MAX_LEN]
        # Use the accurate counts carried from the full (pre-truncation) diff;
        # re-deriving from proposed_diff would under-report >4000-char patches.
        key = (agent, eval_result)
        added_by_key[key] += max(0, int(patch.estimated_added_lines))
        removed_by_key[key] += max(0, int(patch.estimated_removed_lines))

    envelopes: list[dict[str, object]] = []
    for (agent, eval_result), changes_added in added_by_key.items():
        changes_removed = removed_by_key[(agent, eval_result)]
        envelopes.append(
            {
                "op": "write_autoagent_loop_event",
                "args": {
                    "event_ts": report.generated_at,
                    "agent": agent,
                    "eval_result": eval_result,
                    "changes_added": int(changes_added),
                    "changes_removed": int(changes_removed),
                    "rice": None,  # daemon does not compute RICE
                },
            }
        )
    return envelopes


def _invoke_pg_helper(envelope: dict[str, object]) -> bool:
    """Invoke the helper — module import first, subprocess fallback.

      - HAS_PG_LOOP_WRITE=True  → direct function call (no subprocess fork, ~100-170ms saved/envelope)
      - HAS_PG_LOOP_WRITE=False → subprocess call (psycopg-missing backward-compat)

    fail-loud-and-skip:
      - module-call exception → stderr log + False (never abort the cycle)
      - subprocess exception (timeout, FileNotFoundError, …) → stderr log + False
      - the helper records PG failures in hook_failures itself, so returncode is
        not a success signal → True means only that the call itself completed.
    """
    if HAS_PG_LOOP_WRITE:
        return _invoke_pg_helper_module(envelope)
    return _invoke_pg_helper_subprocess(envelope)


def _invoke_pg_helper_module(envelope: dict[str, object]) -> bool:
    """Module-import path — call write_autoagent_loop_event directly.

    envelope shape: {"op": "write_autoagent_loop_event", "args": {...}}
    args maps 1:1 to the write_autoagent_loop_event(**kwargs) signature.
    """
    op = envelope.get("op")
    if op != "write_autoagent_loop_event":
        # emit_loop_events currently calls only write_autoagent_loop_event (defensive).
        sys.stderr.write(
            f"[daemon-cycle] WARN: module-import path unsupported op: {op}\n"
        )
        return False
    args = envelope.get("args", {})
    if not isinstance(args, dict):
        sys.stderr.write(
            f"[daemon-cycle] WARN: envelope.args not dict: {type(args).__name__}\n"
        )
        return False
    try:
        _pg_write_loop_event(**args)
        return True
    except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
        # Never abort the cycle — daemon status reporting must not break.
        sys.stderr.write(
            "[daemon-cycle] WARN: loop_event module call failed: "
            f"{type(exc).__name__}: {str(exc)[:160]}\n"
        )
        return False


def _invoke_pg_helper_subprocess(envelope: dict[str, object]) -> bool:
    """Subprocess fallback — backward-compat path on module-import failure.

    Same pattern as the _pg_push_autoagent_cycle.py peer — preserves
    fail-loud-and-skip in psycopg-missing environments.
    """
    try:
        subprocess.run(  # nosec — list form, no shell=True
            ["python3", str(PG_DUAL_WRITE_HELPER)],
            input=json.dumps(envelope),
            text=True,
            timeout=PG_HELPER_TIMEOUT_SEC,
            check=False,
        )
        return True
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        # Never abort the cycle — daemon status reporting must not break.
        sys.stderr.write(
            "[daemon-cycle] WARN: loop_event helper subprocess failed: "
            f"{type(exc).__name__}: {str(exc)[:160]}\n"
        )
        return False


def emit_loop_events(report: CycleReport) -> int:
    """CycleReport → core.autoagent_loop_events UPSERT (PG direct, no JSONL).

    Idempotent: the helper's ON CONFLICT (event_ts, agent, eval_result) DO UPDATE
    turns a same-cycle re-run into an UPDATE, not a duplicate INSERT (0 row growth).

    The module-import path (HAS_PG_LOOP_WRITE=True) calls the already-loaded
    function regardless of helper-file existence; only the subprocess fallback
    needs the PG_DUAL_WRITE_HELPER.exists() check.

    Returns: count of successfully-called envelopes (verification/metrics).
    """
    envelopes = _aggregate_loop_events(report)
    if not envelopes:
        return 0
    if not HAS_PG_LOOP_WRITE and not PG_DUAL_WRITE_HELPER.exists():
        sys.stderr.write(
            f"[daemon-cycle] WARN: PG helper missing AND module unavailable — "
            f"skip loop emit: {PG_DUAL_WRITE_HELPER}\n"
        )
        return 0
    succeeded = 0
    for envelope in envelopes:
        if _invoke_pg_helper(envelope):
            succeeded += 1
    sys.stderr.write(
        f"[daemon-cycle] loop_events emitted={succeeded}/{len(envelopes)} "
        f"event_ts={report.generated_at} "
        f"path={'module' if HAS_PG_LOOP_WRITE else 'subprocess'}\n"
    )
    return succeeded


# -- cycle-level all-reject alert --------------------------------------------


def _prior_all_reject_cycle_count(current_cycle_date: str) -> int:
    """Leading run of persisted cycles whose proposals were ALL rejected.

    Groups core.autoagent_proposals by cycle_date STRICTLY BEFORE the current
    cycle (the current cycle is judged from the in-memory report — excluding it
    here prevents a same-day re-run from double-counting today) and counts how
    many of the most recent cycle_dates carry zero non-rejected rows. Stops at
    the first cycle with >=1 non-rejected proposal. Bounded LIMIT mirrors
    consecutive_timeout_count. PG unavailable / read error → 0 (fail-open: a
    read failure must never fabricate an alert).
    """
    if not HAS_PG_LOOP_WRITE or not current_cycle_date:
        return 0

    select_sql = (
        "SELECT count(*) FILTER (WHERE status::text <> 'rejected') "
        "FROM core.autoagent_proposals "
        "WHERE cycle_date < %s::date "
        "GROUP BY cycle_date "
        "ORDER BY cycle_date DESC "
        # LIMIT high enough not to flatten a long real streak — the prior
        # LIMIT 10 capped a 20-day regression at a misreported 10. The walk
        # still short-circuits at the first non-rejected cycle, so this only
        # bounds the worst case (a genuinely long all-reject run).
        "LIMIT 400"
    )
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, (current_cycle_date,))
                rows = cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not alert
        sys.stderr.write(
            f"[daemon-cycle] all-reject alert: PG read failed — "
            f"fail-open (count=0): {type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return 0

    streak = 0
    for (non_rejected,) in rows:
        if int(non_rejected or 0) > 0:
            break
        streak += 1
    return streak


def _days_since_last_applied(current_cycle_date: str | None) -> int:
    """Whole days between the most recent APPLIED proposal and the current cycle.

    Corroborating crit for the systemic-regression check: a large gap since
    anything actually landed. Queries MAX(cycle_date) over status='applied' rows
    in core.autoagent_proposals. No applied row ever (fresh DB) → 0 (fail-open:
    absence of history must never fabricate a regression alert). PG unavailable
    / read error / no current date → 0 (same fail-open contract as
    _prior_all_reject_cycle_count).
    """
    if not HAS_PG_LOOP_WRITE or not current_cycle_date:
        return 0

    select_sql = (
        "SELECT max(cycle_date) "
        "FROM core.autoagent_proposals "
        "WHERE status::text = 'applied' AND cycle_date <= %s::date"
    )
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, (current_cycle_date,))
                row = cur.fetchone()
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not alert
        sys.stderr.write(
            f"[daemon-cycle] days-since-applied: PG read failed — "
            f"fail-open (days=0): {type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return 0

    last_applied = row[0] if row else None
    if last_applied is None:
        return 0
    try:
        current = date.fromisoformat(str(current_cycle_date))
        last = (
            last_applied
            if isinstance(last_applied, date)
            else date.fromisoformat(str(last_applied))
        )
    except (ValueError, TypeError):
        return 0
    return max((current - last).days, 0)


def _all_rejected_this_cycle(report: CycleReport) -> bool:
    """Shared discriminator: this cycle INGESTED input and rejected ALL of it.

    True iff report.patches is non-empty AND every patch is terminal-negative.
    A quiet night (patches=[]) is False — the single SoT for the
    "all-reject-this-cycle" precondition both alert_all_reject_streak and
    is_systemic_regression gate on (a 'snoozed'/'pending'/'applied' row is
    non-rejected pipeline output → False). 'reverted' counts as
    rejected-equivalent: a backed-out apply is terminal-non-resurrectable, NOT
    live pipeline output, so it must never resurrect the healthy-output claim.
    """
    if not report.patches:
        return False
    return all(
        patch.status in ("rejected", "reverted") for patch in report.patches
    )


def is_systemic_regression(report: CycleReport) -> bool:
    """True only for a systemic zero-output regression, never a quiet night.

    The discriminator is unchanged from alert_all_reject_streak: this cycle must
    have INGESTED input (report.patches non-empty) AND produced zero non-rejected
    output (every patch 'rejected'). A legitimately quiet night yields
    patches=[] → False here (caller stays clean exit 0). On top of that, ONE of
    two corroborating crits must hold: the all-reject streak reached
    ALL_REJECT_ALERT_THRESHOLD, OR the days-since-last-applied gap exceeds
    DAYS_SINCE_APPLIED_CRIT_THRESHOLD (the slow-bleed leg). The days leg widens
    detection but is AND-gated behind the all-reject-this-cycle precondition, so
    it can NEVER fire on its own during a patches=[] quiet stretch.
    """
    if not _all_rejected_this_cycle(report):
        return False
    streak = _prior_all_reject_cycle_count(report.cycle_date) + 1
    if streak >= ALL_REJECT_ALERT_THRESHOLD:
        return True
    return _days_since_last_applied(report.cycle_date) > DAYS_SINCE_APPLIED_CRIT_THRESHOLD


def alert_all_reject_streak(report: CycleReport) -> None:
    """3-consecutive-all-reject-cycle WARN — stderr + loop event, never silent.

    Fires only when the CURRENT cycle produced >=1 proposal and ALL of them are
    'rejected' AND the prior persisted cycles extend the streak to
    ALL_REJECT_ALERT_THRESHOLD. 'snoozed'/'pending' rows count as non-rejected
    (a back-off or queued proposal is still pipeline output) and break the
    streak. Precondition Loud-Fail: the alert is the observable surface for a
    systemic reject regression that individual reject rows cannot convey.
    """
    if not _all_rejected_this_cycle(report):
        return

    streak = _prior_all_reject_cycle_count(report.cycle_date) + 1
    if streak < ALL_REJECT_ALERT_THRESHOLD:
        return

    sys.stderr.write(
        f"[daemon-cycle] WARN: all-reject streak — {streak} consecutive cycles "
        f"(threshold {ALL_REJECT_ALERT_THRESHOLD}) produced 0 non-rejected "
        "proposals; the generation pipeline yields nothing actionable (check "
        "classify_patch_area containment + pre-verify); loop event emitted\n"
    )
    _invoke_pg_helper(
        {
            "op": "write_autoagent_loop_event",
            "args": {
                "event_ts": report.generated_at,
                "agent": "daemon-cycle",
                "eval_result": ALL_REJECT_ALERT_EVAL_RESULT,
                "changes_added": 0,
                "changes_removed": 0,
                "rice": None,
            },
        }
    )


# -- post-apply regression watch (C1, detection-only) ------------------------


def _is_soft_negative_outcome(row: dict) -> bool:
    """Soft-negative for the post-apply regression watch — the shared trigger SoT.

    Thin named wrapper over _pg_learning_dualwrite.is_negative_signal_outcome,
    the same predicate the aggregator emits on and _live_failure_stats
    recomputes with (the generation polarity partition's sync mandate). Beyond
    the retired hand-built composite this inherits the synthesized-measurement-
    gap carve-out (a completion-synthesized done_with_concerns row is a
    measurement artifact, not a regression signal), the structural review_flag
    carve-out, and the grader_verdict=verified_fail term. Soft keying stays
    deliberate: 0 result=fail rows across 4160 lifetime outcomes make
    hard-failure keying dead. Reachable only under HAS_PG_OUTCOME_READ (the
    alert gate), where the imported alias is bound.
    """
    return _pg_is_negative_signal_outcome(row)


def _smoothed_soft_negative_rate(rows: list[dict]) -> float:
    """Beta(1,1)-smoothed posterior mean of a window's soft-negative rate.

    Smoothing delegates to confidence.beta_smoothed_rate (prior parity with
    compute_confidence_observed): an empty window degrades to the Beta(1,1)
    mean 0.5 instead of 0-division.
    """
    negative_count = sum(1 for row in rows if _is_soft_negative_outcome(row))
    return beta_smoothed_rate(negative_count, len(rows))


def _split_outcome_windows(
    rows: list[dict],
    applied_ts: datetime,
) -> tuple[list[dict], list[dict]]:
    """Partition agent outcome rows into (pre, post) windows around the apply.

    A naive record_ts borrows applied_ts's tzinfo (PG returns tz-aware —
    mirrors confidence._decay_weight); a row without record_ts cannot be
    placed on either side → skipped.
    """
    pre_rows: list[dict] = []
    post_rows: list[dict] = []
    for row in rows:
        record_ts = row.get("record_ts")
        if record_ts is None:
            continue
        if record_ts.tzinfo is None and applied_ts.tzinfo is not None:
            record_ts = record_ts.replace(tzinfo=applied_ts.tzinfo)
        if record_ts > applied_ts:
            post_rows.append(row)
        else:
            pre_rows.append(row)
    return pre_rows, post_rows


def _fetch_applied_proposals() -> list[tuple] | None:
    """Recently APPLIED proposal rows for the regression watch, newest-first.

    reviewed_at is the apply-side status-flip timestamp (daemon-apply.sh
    update_db_status) — the pre/post window boundary. Bounded to the outcome
    lookback window (an older apply has no comparable outcome history) with
    LIMIT 50 mirroring _fetch_proposal_history. PG off / read error → None
    (fail-OPEN: a read failure must never fabricate a regression alert).
    """
    if not HAS_PG_LOOP_WRITE:
        return None

    select_sql = (
        "SELECT id, target_agent, cycle_date, reviewed_at "
        "FROM core.autoagent_proposals "
        "WHERE status::text = 'applied' AND reviewed_at IS NOT NULL "
        "AND target_agent IS NOT NULL "
        "AND reviewed_at > now() - make_interval(days => %s) "
        "ORDER BY reviewed_at DESC "
        "LIMIT 50"
    )
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, (PG_OUTCOME_LOOKBACK_DAYS,))
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not alert
        sys.stderr.write(
            f"[daemon-cycle] post-apply watch: PG read failed — fail-open "
            f"(no rows): {type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def _backup_subdir_path(cycle_date: object, proposal_id: object) -> Path:
    """Per-proposal agents-bak before-image dir for an applied proposal.

    Derivation parity with daemon-apply.sh: BACKUP_DIR
    (${AUTOAGENT_BACKUP_DIR:-<root>/agents-bak}) + '<cycle>_p<id>'. Existence
    is NOT checked — retention prune may already have dropped the subdir; the
    WARN names the recorded rollback anchor either way.
    """
    backup_root = os.environ.get("AUTOAGENT_BACKUP_DIR") or str(
        Path(__file__).resolve().parent.parent / "agents-bak"
    )
    return Path(backup_root) / f"{cycle_date}_p{proposal_id}"


def alert_post_apply_regression() -> None:
    """Post-apply regression watch — DETECTION-ONLY WARN, never a revert (C1).

    Next-cycle step: for each recently applied proposal, the target agent's
    Beta(1,1)-smoothed soft-negative outcome rate BEFORE the apply is compared
    to the rate AFTER it. Both windows read through _pg_read_outcomes_since —
    the same shared learning-signal exclusion scope as _count_outcome_signals
    (attribution failures + poisoned_window excluded inside the PG helper).
    Degradation (post rate exceeding pre by >= POST_APPLY_REGRESSION_RATE_DELTA
    with post n >= POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS) emits ONE WARN
    loop event whose stderr line names the proposal id + agents-bak
    before-image path. event_ts keys on the proposal's apply timestamp, so the
    loop-event UPSERT natural key (event_ts, agent, eval_result) dedups a
    same-cycle re-run and every later re-detection into a single row.

    Detection-only invariant: zero agent-file writes, zero proposal-status
    mutations, zero safety-queue inserts — the only write is the loop event.
    A human/CLI revert (status 'reverted') is the follow-up the WARN enables,
    never an automatic action — the stderr line names the concrete path
    (before-image restore + the status='reverted' UPDATE), since no setter
    exists anywhere in the pipeline. Once set, _fetch_applied_proposals'
    status='applied' predicate drops the row, so the WARN stops re-firing.
    """
    if not HAS_PG_LOOP_WRITE or not HAS_PG_OUTCOME_READ or not HAS_CONFIDENCE_LIB:
        return

    applied_rows = _fetch_applied_proposals()
    if not applied_rows:
        return

    lookback_seconds = PG_OUTCOME_LOOKBACK_DAYS * 86400
    for proposal_id, agent, cycle_date, applied_ts in applied_rows:
        if not agent or applied_ts is None:
            continue
        window_rows = _pg_read_outcomes_since(
            applied_ts.timestamp() - lookback_seconds, agent=agent
        )
        pre_rows, post_rows = _split_outcome_windows(window_rows, applied_ts)
        if len(post_rows) < POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS:
            continue
        pre_rate = _smoothed_soft_negative_rate(pre_rows)
        post_rate = _smoothed_soft_negative_rate(post_rows)
        if post_rate - pre_rate < POST_APPLY_REGRESSION_RATE_DELTA:
            continue

        backup_subdir = _backup_subdir_path(cycle_date, proposal_id)
        sys.stderr.write(
            f"[daemon-cycle] WARN: post-apply regression — proposal "
            f"id={proposal_id} agent={agent} soft-negative rate "
            f"pre={pre_rate:.3f} → post={post_rate:.3f} "
            f"(delta >= {POST_APPLY_REGRESSION_RATE_DELTA}, "
            f"post n={len(post_rows)}); before-image: {backup_subdir}; "
            "DETECTION-ONLY — no auto-revert, no status mutation, no "
            "safety-queue insert; loop event emitted; revert path (human/CLI): "
            "restore the agent file from the before-image, then psql: "
            "UPDATE core.autoagent_proposals SET status='reverted' "
            f"WHERE id={proposal_id}\n"
        )
        _invoke_pg_helper(
            {
                "op": "write_autoagent_loop_event",
                "args": {
                    # Apply-timestamp key → stable dedup across re-runs (the
                    # UPSERT's (event_ts, agent, eval_result) natural key).
                    "event_ts": applied_ts.isoformat(),
                    "agent": (agent or "")[:64],  # varchar(64) guard
                    "eval_result": POST_APPLY_REGRESSION_EVAL_RESULT,
                    "changes_added": 0,
                    "changes_removed": 0,
                    "rice": None,
                },
            }
        )


# -- stale pending-proposal regeneration ------------------------------------
#
# A pending proposal's stored diff carries @@ start offsets + context lines
# referencing the agent file as it was when authored. Later file drift shifts
# line numbers, so the stored diff applies at the wrong location — or fails —
# even after count-fixups, because the start offset is now stale. Re-derive the
# diff against the current file via difflib so the drain applies it mid-file,
# not at EOF.


def _diff_context_lines(diff_text: str) -> list[str]:
    """Extract context-line CONTENT (no ' ' prefix) from a unified diff body.

    Context = ' '-prefixed lines inside hunks, excluding file headers, @@ hunk
    headers, +added, -removed, and `\\ No newline` markers. These are the lines
    that MUST exist verbatim in the current file for the stored diff to still
    anchor correctly — the staleness probe.
    """
    out: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("--- ") or line.startswith("+++ "):
            continue
        if line.startswith("@@") or line.startswith("\\"):
            continue
        if line.startswith("+") or line.startswith("-"):
            continue
        if line.startswith(" "):
            out.append(line[1:])
    return out


def _diff_applies_to_file(diff_text: str, target_file: Path) -> bool:
    """True iff `git apply --check` returns rc 0 against the CURRENT target file.

    Runs `git -C <target_file.parent> apply --recount --check <tmp>` so the
    diff's relative `+++ b/<basename>` path resolves to THIS file in ITS repo —
    not the daemon's default agents dir. `--recount` lets git tolerate stale @@
    line counts and judge applicability purely on hunk content + offsets, so the
    verdict isolates the "does the patch fit the current file" question (offset
    collision, context drift) from the orthogonal @@-count-syntax question that
    `_validate_unified_diff` / the F2 gate already own.

    Return semantics (stale ⇔ NOT applies):
      - rc 0   → patch applies cleanly here → applies=True
      - rc 1   → "patch does not apply" (context/offset collision — e.g. a
                 sibling proposal already occupies the same @@ region) → False
      - rc 128 → parser-reject / no such file → False
      - other  → conservative non-apply → False

    Edge cases:
      - empty diff → False (nothing applies)
      - target missing → False (caller short-circuits missing→stale upstream)
      - subprocess failure (OSError / timeout) → False (loud-fail: logged here,
        treated as non-applying so the caller re-derives rather than trusting a
        diff we could not verify)
    """
    if not diff_text.strip() or not target_file.exists():
        return False
    repo_dir = target_file.parent
    payload = diff_text if diff_text.endswith("\n") else diff_text + "\n"
    fd, tmp_path = tempfile.mkstemp(prefix="daemon-applycheck-", suffix=".diff")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        try:
            result = subprocess.run(  # nosec — list form, no shell=True
                ["git", "-C", str(repo_dir), "apply", "--recount", "--check", tmp_path],
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            # Loud-fail per self-improve-hygiene: log the named failure, treat as
            # non-applying (→ stale → re-derive) rather than silently swallowing.
            sys.stderr.write(
                f"[daemon-cycle] FU-3 apply-check subprocess failure for "
                f"{target_file.name}: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
            return False
        return result.returncode == 0
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _proposal_diff_is_stale(diff_text: str, target_file: Path) -> bool:
    """True iff the stored diff cannot apply cleanly to the CURRENT file.

    Two independent staleness signals (either ⇒ stale):

      1. Context drift (FU-3 spec, anchor-match < 100%): a context line in the
         stored diff no longer appears verbatim in the current file → the line
         offsets have drifted, so the diff would apply at the wrong location.
      2. Apply failure: the stored diff fails `git apply --check` against the
         CURRENT target file (rc != 0). This catches BOTH:
           - rc=128 — wrong @@ counts / parser-reject authored on an earlier
             cycle (the F2 corruption class, ids 174/184 pattern), AND
           - rc=1   — "patch does not apply": context lines still present but a
             sibling proposal already occupies the same @@ region, so the hunk
             collides (the #173-vs-#178 pattern). Context-match alone (Signal 1)
             does NOT catch this — only an actual apply-check does.
         Either way difflib re-derivation against the current file is the fix.

    Signal (2) is a REAL apply-check (`_diff_applies_to_file`, rc 0 ⇔
    applies) against `target_file`'s own repo — NOT the syntax-only
    `_validate_unified_diff` parser-reject gate, which returns True for rc=1
    and so masks the collision-stale case. The invariant is:
    stale ⇔ NOT (git apply --check rc 0 against the current file).

    Edge cases:
      - target file missing → stale=True (cannot apply against absent file)
      - diff has NO context lines (pure-append at EOF) → context-drift signal
        skipped; apply-check signal still evaluated
      - file read error → stale=True (conservative; surfaced by caller logging)
    """
    if not target_file.exists():
        return True

    # Signal 1 — context drift.
    context = _diff_context_lines(diff_text)
    if context:
        try:
            file_lines = {
                ln.rstrip("\n")
                for ln in target_file.read_text(encoding="utf-8").splitlines()
            }
        except OSError:
            return True
        if any(ctx.rstrip("\n") not in file_lines for ctx in context):
            return True

    # Signal 2 — non-applyable against the CURRENT file (rc != 0 ⇒ stale):
    # rc=1 collision (sibling proposal owns the @@ region) OR rc=128 parser
    # reject (wrong counts). stale ⇔ NOT applies.
    return not _diff_applies_to_file(diff_text, target_file)


def _diff_modifies_out_of_region(diff_text: str, target_file: Path) -> bool:
    """True iff the diff REMOVES a line that lives OUTSIDE every editable region.

    RC3 structural-reachability: a pure-add proposal (no removed lines) is
    in-region-fixable by re-anchoring, but a MODIFY (remove + replace) can only be
    expressed where the removed line actually sits. When that line is outside
    every `<!-- EDITABLE -->` region the landing-zone guard correctly rejects the
    proposal FOREVER (the dev-shell `--external-sources=true` fossil) — the
    add-only synthesis pipeline can never relocate a removal — so the pattern is
    structurally non-auto-fixable, not transiently stale.

    Conservative: returns True only when a removed line UNIQUELY matches an
    out-of-region file line. An ambiguous (multi-match), in-region, or absent
    match is NOT decisive evidence (→ False) so a re-anchorable add is never
    mis-flagged. Missing / unreadable file → False (no evidence).
    """
    _context, _added, removed = _split_fragment_lines(diff_text)
    removed_needles = [r[1:].rstrip("\n") for r in removed if r[1:].strip()]
    if not removed_needles:
        return False  # pure add → re-anchorable, not a structural MODIFY

    if not target_file.exists():
        return False
    try:
        target_lines = target_file.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        return False

    spans = _editable_spans(target_lines)
    for needle in removed_needles:
        positions = [
            idx
            for idx, line in enumerate(target_lines, start=1)
            if line.rstrip("\n") == needle
        ]
        if len(positions) != 1:
            continue  # ambiguous / absent → not decisive evidence
        if not _anchor_in_editable_region(positions[0], spans):
            return True  # a removal targets a NON-editable line → structural
    return False


def _rederive_diff_against_file(diff_text: str, target_file: Path) -> str:
    """Re-synthesize a stale diff's ADDED lines against the CURRENT file.

    Reuses the existing fragment→diff machinery (`_split_fragment_lines` +
    anchor synthesis + difflib append) but keyed to today's file content, so
    the resulting @@ offsets + context are correct for the current file.

    Path selection (mirrors `_normalize_to_unified_diff`):
      - context anchor still uniquely present + added-only → anchor synthesis
      - otherwise → difflib insert before last EDITABLE:END (or EOF append)

    Returns "" when the file is missing/unreadable or there are no added lines
    (caller treats "" as "cannot regenerate — leave pending diff untouched").
    The output is passed through `_recount_hunk_header` defensively (F2 reuse).
    """
    if not target_file.exists():
        return ""
    try:
        target_lines = target_file.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        return ""

    context_lines, added_lines, removed_lines = _split_fragment_lines(diff_text)
    if not added_lines:
        return ""
    # A REPLACE diff re-derived through either builder below comes back as a pure
    # append — both take added lines only — so the removal it was written to make
    # disappears. Refuse instead; the caller's existing unrecoverable arm handles "".
    if removed_lines:
        _warn_removal_refusal(
            site="stale re-derivation",
            target_file=target_file,
            removed_count=len(removed_lines),
        )
        return ""

    rel_name = target_file.name
    # Mirror _normalize_to_unified_diff's EDITABLE-region membership guard so a
    # regenerated diff cannot re-fossilize an out-of-region anchor (the FU-3
    # reuse path that reproduced dev-front.md:49). Out-of-region or no resolved
    # anchor → difflib append; region-less file → append (the guard rejects it).
    spans = _editable_spans(target_lines)
    synthetic_anchor = _resolve_in_region_anchor(target_lines, context_lines, spans)
    if synthetic_anchor is not None:
        rebuilt = _build_synthetic_diff_at_anchor(
            rel_name=rel_name,
            target_lines=target_lines,
            anchor_idx=synthetic_anchor,
            context_lines=context_lines,
            added_lines=added_lines,
        )
    else:
        rebuilt = _build_difflib_append_diff(
            rel_name=rel_name,
            target_lines=target_lines,
            added_lines=added_lines,
        )
    # Defensive recount — builders already emit correct counts; this guards
    # against any future builder regression.
    return _recount_hunk_header(rebuilt)


def regenerate_stale_proposals(
    *,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
    dry_run: bool = False,
) -> list[dict[str, object]]:
    """FU-3: re-derive every stale pending proposal's diff against today's file.

    For each `core.autoagent_proposals` row with status='pending' whose stored
    diff context no longer 100%-exact-matches its target agent file:
      1. re-derive a correct diff via `_rederive_diff_against_file` (difflib),
      2. validate it through the F2 GATE (`_gate_validated_diff`),
      3. UPDATE only `proposed_diff` (id / pattern_label / cycle_date untouched).

    Does NOT apply the patch — daemon-apply.sh drains pending rows on its own
    next tick. `dry_run=True` performs detection + re-derivation but skips the
    UPDATE (returns the would-be changes for inspection / tests).

    Loud-fail contract (shared-self-improve-hygiene.md): PG errors are NOT swallowed —
    they are logged with a named exception type and re-raised so the caller /
    monitor surfaces the failure (no silent `2>/dev/null` absorption). Per-row
    re-derivation failures (file missing, unrecoverable diff) are logged and
    SKIPPED (row left pending) — one bad row must not abort the whole sweep.

    Returns a list of per-row result dicts:
        {id, target_file, action, ...}  where action ∈
        {"regenerated", "skipped-fresh", "skipped-unrecoverable", "dry-run"}.
    """
    if not HAS_PG_LOOP_WRITE:
        # _pg_connect import rides on the same try-block as the loop-write helper.
        sys.stderr.write(
            "[daemon-cycle] FU-3: PG unavailable (psycopg/helper import failed) "
            "— cannot regenerate stale proposals\n"
        )
        raise RuntimeError("FU-3 requires PG (psycopg.connect dbname=glass_atrium)")

    select_sql = (
        "SELECT id, target_file, proposed_diff "
        "FROM core.autoagent_proposals "
        "WHERE status = 'pending' AND proposed_diff IS NOT NULL "
        "ORDER BY id"
    )
    update_sql = (
        "UPDATE core.autoagent_proposals SET proposed_diff = %s WHERE id = %s"
    )

    results: list[dict[str, object]] = []
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql)
                rows = cur.fetchall()
            for row in rows:
                proposal_id, target_file_str, stored_diff = row[0], row[1], row[2]
                if not stored_diff or not str(stored_diff).strip():
                    results.append(
                        {"id": proposal_id, "target_file": target_file_str,
                         "action": "skipped-fresh", "reason": "empty diff"}
                    )
                    continue
                target_file = Path(target_file_str)
                if not _proposal_diff_is_stale(stored_diff, target_file):
                    results.append(
                        {"id": proposal_id, "target_file": target_file_str,
                         "action": "skipped-fresh"}
                    )
                    continue

                rederived = _rederive_diff_against_file(stored_diff, target_file)
                gated = _gate_validated_diff(rederived, target_file) if rederived else ""
                if not gated.strip():
                    sys.stderr.write(
                        f"[daemon-cycle] FU-3: id={proposal_id} "
                        f"{target_file.name} stale but unrecoverable — left "
                        f"pending (no valid re-derivation)\n"
                    )
                    results.append(
                        {"id": proposal_id, "target_file": target_file_str,
                         "action": "skipped-unrecoverable"}
                    )
                    continue

                if dry_run:
                    results.append(
                        {"id": proposal_id, "target_file": target_file_str,
                         "action": "dry-run", "new_diff": gated}
                    )
                    continue

                # UPDATE proposed_diff only — id / pattern_label / cycle_date
                # / status all untouched (still pending for the next drain).
                with conn.cursor() as cur:
                    cur.execute(update_sql, (gated, proposal_id))
                results.append(
                    {"id": proposal_id, "target_file": target_file_str,
                     "action": "regenerated"}
                )
                sys.stderr.write(
                    f"[daemon-cycle] FU-3: id={proposal_id} {target_file.name} "
                    f"diff regenerated against current file (was stale)\n"
                )
            if not dry_run:
                conn.commit()
    except Exception as exc:  # noqa: BLE001 — loud-fail: log named + re-raise
        sys.stderr.write(
            f"[daemon-cycle] FU-3 ERROR (PG): {type(exc).__name__}: "
            f"{str(exc)[:200]}\n"
        )
        raise

    regenerated = sum(1 for r in results if r["action"] in {"regenerated", "dry-run"})
    sys.stderr.write(
        f"[daemon-cycle] FU-3 sweep: {regenerated}/{len(results)} stale "
        f"proposals re-derived{' (dry-run)' if dry_run else ''}\n"
    )
    return results


# -- P2c: auth-failure mislabel backfill ------------------------------------
#
# The auth classifier (FAILURE_CLASS_AUTH / parse_mode='auth-failure') landed in
# the codebase AFTER the 06-20..23 cycles persisted, so a 401 that day fell
# through the GENERIC non-zero branch → haiku_status='skipped:empty-or-error',
# rationale='haiku non-zero exit 1'. Forward detection is already correct (no
# detection-code change); this is a one-shot, EVIDENCE-GATED, IDEMPOTENT backfill
# of the historically mislabeled rows ONLY.

# The mislabel state to repair + the generic-non-zero rationale prefix that the
# pre-classifier 401 fell through to (the prefix excludes timeout/quota rows).
_MISLABELED_AUTH_HAIKU_STATUS = "skipped:empty-or-error"
_GENERIC_NONZERO_RATIONALE_PREFIX = "haiku non-zero exit"
# Post-backfill values written TOGETHER (haiku_status + rationale prefix is
# load-bearing for the kill-streak consumer; cost_guard_state flags infra fault).
_BACKFILL_AUTH_HAIKU_STATUS = "skipped:auth"
_BACKFILL_AUTH_COST_GUARD = "infra_fault"
# Haiku-failure-log header parse (see the failure-log writer's body shape:
# `cycle_date=<d> agent=<a> attempt=<n>` then `returncode=<rc> ...`).
_LOG_META_RE = re.compile(r"cycle_date=(?P<date>\S+)\s+agent=(?P<agent>\S+)\s+attempt=")
_LOG_RC_RE = re.compile(r"returncode=(?P<rc>-?\d+)")


def _parse_haiku_failure_log_meta(content: str) -> tuple[str, str, str]:
    """Extract (cycle_date, agent, returncode) from a haiku-failure log header.

    Each component is '' when unparseable. Pure, no side effects.
    """
    meta = _LOG_META_RE.search(content)
    cycle_date = meta.group("date") if meta else ""
    agent = meta.group("agent") if meta else ""
    rc_match = _LOG_RC_RE.search(content)
    returncode = rc_match.group("rc") if rc_match else ""
    return cycle_date, agent, returncode


def _collect_auth_failure_evidence(
    log_dir: Path,
) -> dict[tuple[str, str], list[tuple[Path, str]]]:
    """Map (cycle_date, agent) → matched 401 failure-log (path, returncode) list.

    ONLY logs whose body carries a 401/credential signature (`_detect_auth_failure`)
    are recorded — a quota ('Limit reached') or transient (529 Overloaded) log for
    the same agent/day is correctly EXCLUDED, so the backfill never relabels a
    non-auth failure. Uses the ACTUAL matched file paths (no '2x' glob placeholder).
    A per-file read error is logged (loud, named) and skipped — one unreadable log
    must not abort the scan.
    """
    evidence: dict[tuple[str, str], list[tuple[Path, str]]] = defaultdict(list)
    if not log_dir.is_dir():
        return {}
    for log_path in sorted(log_dir.glob("*.log")):
        try:
            content = log_path.read_text(encoding="utf-8")
        except OSError as exc:
            sys.stderr.write(
                f"[daemon-cycle] P2c: cannot read failure log {log_path.name}: "
                f"{type(exc).__name__}: {str(exc)[:160]}\n"
            )
            continue
        if not _detect_auth_failure(content, ""):
            continue
        cycle_date, agent, returncode = _parse_haiku_failure_log_meta(content)
        if not cycle_date or not agent:
            continue
        evidence[(cycle_date, agent)].append((log_path, returncode))
    return dict(evidence)


def _auth_backfill_decision(
    *,
    haiku_status: str,
    rationale: str,
    cycle_date: str,
    target_agent: str,
    evidence: dict[tuple[str, str], list[tuple[Path, str]]],
) -> list[tuple[Path, str]] | None:
    """Decide whether a proposal row is an auth-mislabel backfill target.

    Returns the matched 401 log evidence when the row qualifies, else None.
    IDEMPOTENT BY CONSTRUCTION: a row already carrying the post-backfill
    haiku_status ('skipped:auth') fails the mislabel gate, so a second pass is a
    no-op. Strict, conservative gating — ALL must hold:
      - currently the GENERIC-non-zero MISLABEL state (haiku_status ==
        'skipped:empty-or-error' AND rationale starts with 'haiku non-zero exit'
        — the branch that swallowed the 401; excludes timeout/quota rationales), AND
      - per-row 401 log evidence exists for this exact (cycle_date, agent).
    """
    if haiku_status != _MISLABELED_AUTH_HAIKU_STATUS:
        return None
    if not rationale.startswith(_GENERIC_NONZERO_RATIONALE_PREFIX):
        return None
    return evidence.get((cycle_date, target_agent))


def _build_auth_backfill_rationale(evidence_paths: list[tuple[Path, str]]) -> str:
    """Construct the post-backfill rationale (auth-prefixed, redacted).

    MUST start with 'haiku auth failure' so `classify_failure_rationale` maps the
    row to FAILURE_CLASS_AUTH (the prefix is load-bearing for the kill-streak
    consumer). The matched 401-log basenames are cited for provenance; the whole
    string is run through `redact_secrets` defensively (a 401 stream can echo a
    token).
    """
    returncode = next((rc for _, rc in evidence_paths if rc), "")
    rc_suffix = f" (returncode={returncode})" if returncode else ""
    names = ", ".join(p.name for p, _ in evidence_paths) or "n/a"
    rationale = (
        f"haiku auth failure (401/credential){rc_suffix}; backfilled (P2c) from "
        f"per-row 401 log evidence: {names}"
    )
    return redact_secrets(rationale)


def backfill_auth_mislabeled_proposals(
    *,
    log_dir: Path = HAIKU_FAILURE_LOG_DIR,
    dry_run: bool = False,
) -> list[dict[str, object]]:
    """P2c: relabel auth-mislabeled proposal rows from per-row 401 log evidence.

    For each row in the generic-non-zero MISLABEL state that has a matching 401
    failure log (per-row (cycle_date, agent) evidence), set TOGETHER:
      haiku_status     → 'skipped:auth'
      rationale        → auth-prefixed + redacted (classify_failure_rationale →
                         FAILURE_CLASS_AUTH; the prefix is load-bearing)
      cost_guard_state → 'infra_fault'
    Rows WITHOUT 401 evidence (06-20/21 and older empty-or-error / timeout rows)
    are left UNTOUCHED (conservative — evidence-gated, not a defect). Re-run-safe:
    the SELECT gates on the mislabel haiku_status, so a second run selects 0 rows
    (and `_auth_backfill_decision` is itself idempotent).

    Loud-fail (shared-self-improve-hygiene): a PG error is logged with a named
    type and re-raised (NO 2>/dev/null / || true absorption); `_main` maps it to
    BACKFILL_PG_EXIT_CODE. `dry_run=True` performs evidence collection + row
    selection but skips the UPDATE (returns the would-be changes for inspection).

    Returns per-row before/after result dicts for reporting.
    """
    evidence = _collect_auth_failure_evidence(log_dir)
    if not evidence:
        sys.stderr.write(
            "[daemon-cycle] P2c: no 401 failure-log evidence found under "
            f"{log_dir} — nothing to backfill\n"
        )
        return []

    if not HAS_PG_LOOP_WRITE:
        sys.stderr.write(
            "[daemon-cycle] P2c: PG unavailable (psycopg/helper import failed) "
            "— cannot backfill auth-mislabeled proposals\n"
        )
        raise RuntimeError(
            "P2c backfill requires PG (psycopg.connect dbname=glass_atrium)"
        )

    select_sql = (
        "SELECT id, cycle_date, target_agent, haiku_status, rationale, "
        "cost_guard_state "
        "FROM core.autoagent_proposals "
        "WHERE haiku_status = %s AND rationale LIKE %s "
        "ORDER BY cycle_date, target_agent, id"
    )
    update_sql = (
        "UPDATE core.autoagent_proposals "
        "SET haiku_status = %s, rationale = %s, cost_guard_state = %s "
        "WHERE id = %s"
    )

    results: list[dict[str, object]] = []
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    select_sql,
                    (
                        _MISLABELED_AUTH_HAIKU_STATUS,
                        f"{_GENERIC_NONZERO_RATIONALE_PREFIX}%",
                    ),
                )
                rows = cur.fetchall()
            for row in rows:
                pid, cycle_date_val, agent = row[0], row[1], row[2]
                before_status, before_rationale, before_guard = row[3], row[4], row[5]
                cycle_date_str = (
                    cycle_date_val.isoformat()
                    if isinstance(cycle_date_val, date)
                    else str(cycle_date_val)
                )
                matched = _auth_backfill_decision(
                    haiku_status=str(before_status or ""),
                    rationale=str(before_rationale or ""),
                    cycle_date=cycle_date_str,
                    target_agent=str(agent or ""),
                    evidence=evidence,
                )
                if not matched:
                    # No per-row 401 evidence → leave untouched (conservative).
                    continue
                new_rationale = _build_auth_backfill_rationale(matched)
                results.append(
                    {
                        "id": pid,
                        "cycle_date": cycle_date_str,
                        "target_agent": str(agent or ""),
                        "before_haiku_status": str(before_status or ""),
                        "after_haiku_status": _BACKFILL_AUTH_HAIKU_STATUS,
                        "before_cost_guard_state": str(before_guard or ""),
                        "after_cost_guard_state": _BACKFILL_AUTH_COST_GUARD,
                        "before_rationale": str(before_rationale or ""),
                        "after_rationale": new_rationale,
                        "evidence_logs": [p.name for p, _ in matched],
                        "action": "dry-run" if dry_run else "backfilled",
                    }
                )
                if not dry_run:
                    with conn.cursor() as cur:
                        cur.execute(
                            update_sql,
                            (
                                _BACKFILL_AUTH_HAIKU_STATUS,
                                new_rationale,
                                _BACKFILL_AUTH_COST_GUARD,
                                pid,
                            ),
                        )
                sys.stderr.write(
                    f"[daemon-cycle] P2c: id={pid} {cycle_date_str}/{agent} "
                    f"{before_status} → {_BACKFILL_AUTH_HAIKU_STATUS} "
                    f"(evidence: {', '.join(p.name for p, _ in matched)})"
                    f"{' [dry-run]' if dry_run else ''}\n"
                )
            if not dry_run:
                conn.commit()
    except Exception as exc:  # noqa: BLE001 — loud-fail: log named + re-raise
        sys.stderr.write(
            f"[daemon-cycle] P2c ERROR (PG): {type(exc).__name__}: "
            f"{str(exc)[:200]}\n"
        )
        raise

    sys.stderr.write(
        f"[daemon-cycle] P2c backfill: {len(results)} row(s) "
        f"{'would be ' if dry_run else ''}relabeled skipped:auth\n"
    )
    return results


# -- single-proposal regen + validity gate (accept path) --------------------
#
# Accept path: user-accept → regen stale diff → validity check (pre_verify) →
# apply. Where regenerate_stale_proposals sweeps everything, this regenerates +
# re-verifies only the id=N proposal and reports what daemon-apply.sh should act on.
#
# 4-way action (orchestrator/daemon-apply.sh branches on it):
#   regenerated     — re-derived diff + pre_verify PASS (apply target)
#   already_applied — change already present in the current file (pre-committed)
#                     → caller marks the row applied (avoids pending fossilization)
#   invalid         — re-derived but pre_verify FAIL (do not apply, report failure)
#   unrecoverable   — Haiku/difflib produced no landable diff / file missing / no rows

# Added-line noise ignored in the already_applied check — pure whitespace adds are meaningless.
_REGEN_BLANK_ADDED_RE = re.compile(r"^\+\s*$")


def _added_content_lines(diff_text: str) -> list[str]:
    """Non-blank content lines from the stored diff's ADDED lines, '+' stripped.

    Takes the added result of `_split_fragment_lines` (prefix '+' retained) and
    keeps only meaningful added content. Pure whitespace adds are excluded as
    already_applied noise — blank adds must not sway the 'already applied' verdict.
    """
    _, added, _ = _split_fragment_lines(diff_text)
    out: list[str] = []
    for line in added:
        if _REGEN_BLANK_ADDED_RE.match(line):
            continue
        # Strip only one '+' ('+++' added lines already filtered by _split).
        out.append(line[1:] if line.startswith("+") else line)
    return out


def _stored_diff_already_applied(diff_text: str, target_file: Path) -> bool:
    """True iff the stored diff's added content is ALREADY present in the file.

    If the same change was previously applied+committed and is already in the file,
    re-deriving is pointless → caller should mark the row applied, not fossilize it
    at pending. Verdict:

      - 1+ added content line (whitespace excluded) exists AND
      - every added content line is present verbatim in the current file

    Edge:
      - file missing → False (not already_applied — that's the unrecoverable area)
      - 0 added content lines (pure delete/whitespace) → False (undecidable)
      - file read failure → False (conservative; caller logs)
    """
    if not target_file.exists():
        return False
    added = _added_content_lines(diff_text)
    if not added:
        return False
    try:
        file_lines = {
            ln.rstrip("\n")
            for ln in target_file.read_text(encoding="utf-8").splitlines()
        }
    except OSError:
        return False
    return all(line.rstrip("\n") in file_lines for line in added)


@dataclass(frozen=True)
class SingleRegenResult:
    """Single-proposal regen+validate result (source-of-truth for the stdout JSON)."""

    proposal_id: int
    action: Literal["regenerated", "already_applied", "unrecoverable", "invalid"]
    preverify_passed: bool | None
    preverify_axes: dict[str, bool] | None
    reason: str
    # Diff to UPDATE (filled only when regenerated + not dry_run — internal use).
    new_diff: str = ""

    def to_payload(self) -> dict[str, object]:
        """Machine payload for the orchestrator (daemon-apply.sh). Excludes new_diff."""
        return {
            "proposal_id": self.proposal_id,
            "action": self.action,
            "preverify_passed": self.preverify_passed,
            "preverify_axes": self.preverify_axes,
            "reason": self.reason,
        }


def _classify_single_regen(
    *,
    proposal_id: int,
    stored_diff: str,
    target_file: Path,
    pattern: Pattern,
    skip_pre_verify: bool,
    claude_bin: str,
) -> SingleRegenResult:
    """Pure-ish classifier: stored diff + current file → SingleRegenResult.

    PG-independent — decides the action from fetched row data only (testability).
    Only run_pre_verify is an external call (Haiku), monkeypatched in unit tests.

    Classification order (early-return):
      1. file missing → unrecoverable
      2. stored diff's added content already in file → already_applied
      3. re-derive (difflib) + F2 GATE → empty → unrecoverable
      4. run_pre_verify on the re-derived diff → PASS → regenerated / FAIL → invalid
    """
    if not target_file.exists():
        return SingleRegenResult(
            proposal_id=proposal_id,
            action="unrecoverable",
            preverify_passed=None,
            preverify_axes=None,
            reason=f"target file missing: {target_file}",
        )

    # already_applied — change already in the current file (no re-derive needed).
    if _stored_diff_already_applied(stored_diff, target_file):
        return SingleRegenResult(
            proposal_id=proposal_id,
            action="already_applied",
            preverify_passed=None,
            preverify_axes=None,
            reason="added content already present in current file (applied earlier)",
        )

    # Re-derive + count gate — unrecoverable if no landable diff results.
    rederived = _rederive_diff_against_file(stored_diff, target_file)
    gated = _gate_validated_diff(rederived, target_file) if rederived else ""
    if not gated.strip():
        return SingleRegenResult(
            proposal_id=proposal_id,
            action="unrecoverable",
            preverify_passed=None,
            preverify_axes=None,
            reason="no landable diff after difflib re-derivation + F2 gate",
        )

    # Validity check on the re-derived diff (4-axis C1-C4 gate).
    patch = PatchProposal(
        target_file=str(target_file),
        rationale=f"FU-3 single-regen for proposal {proposal_id} ({pattern.label})",
        proposed_diff=gated,
        touched_frontmatter=False,
        estimated_added_lines=len(_added_content_lines(gated)),
        raw_response="",
        parse_mode="strict",
    )
    verdict = run_pre_verify(
        patch, pattern, claude_bin=claude_bin, skip_pre_verify=skip_pre_verify
    )
    if verdict.passed:
        return SingleRegenResult(
            proposal_id=proposal_id,
            action="regenerated",
            preverify_passed=True,
            preverify_axes=dict(verdict.axes) if verdict.axes else None,
            reason="re-derived diff passed pre-verify (C1-C4)",
            new_diff=gated,
        )
    return SingleRegenResult(
        proposal_id=proposal_id,
        action="invalid",
        preverify_passed=False,
        preverify_axes=dict(verdict.axes) if verdict.axes else None,
        # The second sink of the same LLM-authored rationale: `reason` reaches an
        # operator through a one-line stderr record in run_single_regen (the
        # to_payload JSON path escapes for itself). Flatten BEFORE the 200-char
        # slice so the budget buys content rather than whitespace.
        reason=(
            f"re-derived diff FAILED pre-verify: "
            f"{flatten_log_field(verdict.status, default='(unreported)')} — "
            f"{flatten_log_field(verdict.rationale, default='(none reported)')[:200]}"
        ),
    )


def regenerate_single_proposal(
    proposal_id: int,
    *,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
    dry_run: bool = False,
    skip_pre_verify: bool = False,
    claude_bin: str = CLAUDE_BIN,
) -> SingleRegenResult:
    """FU-3 single-proposal: regen + validate ONE pending/rejected proposal by id.

    Accept-path foundation — re-derives only the id=N proposal against the current
    file, checks validity via pre_verify, and returns what daemon-apply.sh should
    act on. Reuses the sweep's per-row logic (staleness/re-derive/gate) for one id.

    Steps:
      1. Fetch the id=N row from PG (id/target_file/target_agent/pattern_label/
         cycle_date/proposed_diff) — row absent → unrecoverable.
      2. _classify_single_regen decides the action (already_applied/regenerated/
         invalid/unrecoverable).
      3. action=regenerated AND not dry_run → UPDATE proposed_diff only
         (status/pattern_label/cycle_date unchanged — daemon-apply.sh drains the apply).
         already_applied/invalid/unrecoverable → no UPDATE.

    `dry_run=True` → detection + verdict only, skip the PG UPDATE.

    Loud-fail: PG errors are logged via named exception + re-raised. PG unavailable
    → RuntimeError (no silent absorption).

    Returns:
        SingleRegenResult — .to_payload() is the stdout JSON.
    """
    if not HAS_PG_LOOP_WRITE:
        sys.stderr.write(
            "[daemon-cycle] FU-3 single: PG unavailable (psycopg/helper import "
            f"failed) — cannot regenerate proposal {proposal_id}\n"
        )
        raise RuntimeError("FU-3 single requires PG (psycopg.connect dbname=glass_atrium)")

    select_sql = (
        "SELECT id, target_file, target_agent, pattern_label, cycle_date, "
        "proposed_diff FROM core.autoagent_proposals WHERE id = %s"
    )
    update_sql = (
        "UPDATE core.autoagent_proposals SET proposed_diff = %s WHERE id = %s"
    )

    try:
        # Short read-tx — fetch the row, then RELEASE the connection before the
        # ~90s LLM subprocess so the conn never sits idle-in-transaction holding
        # the SELECT's ACCESS SHARE lock / pinning the snapshot horizon.
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, (proposal_id,))
                row = cur.fetchone()

        if row is None:
            sys.stderr.write(
                f"[daemon-cycle] FU-3 single: id={proposal_id} not found\n"
            )
            return SingleRegenResult(
                proposal_id=proposal_id,
                action="unrecoverable",
                preverify_passed=None,
                preverify_axes=None,
                reason=f"proposal id {proposal_id} not found in PG",
            )

        target_file_str = row[1]
        target_agent = row[2] or Path(str(target_file_str)).stem
        pattern_label = row[3] or ""
        cycle_date = row[4]
        stored_diff = row[5] or ""
        target_file = Path(str(target_file_str))

        # Minimal Pattern required by run_pre_verify (only agent/label used in the prompt).
        pattern = Pattern(
            date=str(cycle_date) if cycle_date else "",
            label=pattern_label,
            frequency="",
            agent=target_agent,
            status="",
            tier="",
            raw_line="",
        )

        # No-conn LLM call — _classify_single_regen is PG-independent (the ~90s
        # Haiku pre-verify subprocess runs here with no open transaction).
        result = _classify_single_regen(
            proposal_id=proposal_id,
            stored_diff=stored_diff,
            target_file=target_file,
            pattern=pattern,
            skip_pre_verify=skip_pre_verify,
            claude_bin=claude_bin,
        )

        if result.action == "regenerated" and not dry_run:
            # Short write-tx — reopen for the UPDATE only.
            with _pg_connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(update_sql, (result.new_diff, proposal_id))
                conn.commit()
            sys.stderr.write(
                f"[daemon-cycle] FU-3 single: id={proposal_id} "
                f"{target_file.name} diff regenerated + pre-verify PASS → "
                f"proposed_diff UPDATEd (pending for drain)\n"
            )
        else:
            sys.stderr.write(
                f"[daemon-cycle] FU-3 single: id={proposal_id} "
                f"{target_file.name} action={result.action} "
                f"(no UPDATE{' — dry-run' if dry_run else ''}) — {result.reason}\n"
            )
    except Exception as exc:  # noqa: BLE001 — loud-fail: log named + re-raise
        sys.stderr.write(
            f"[daemon-cycle] FU-3 single ERROR (PG) id={proposal_id}: "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        raise

    return result


# -- Same-agent supersede (prior cycle, and same-cycle label drift) --------


# Head of every supersede rationale. classify_failure_rationale prefix-tests
# against this name and the monitor reject-bucket route stores it as a LIKE
# marker, so a variant tail is composed ONTO the head, never substituted for it.
_SUPERSEDE_REASON = "superseded by fresher per-agent proposal"

_SUPERSEDE_REASON_CROSS_DAY = (
    f"{_SUPERSEDE_REASON} (current-file-anchored, previous calendar day data)"
)
# A same-cycle row is superseded because its label drifted, not because its data
# is a day old — the cross-day tail would be a false claim on it.
_SUPERSEDE_REASON_SAME_CYCLE = (
    f"{_SUPERSEDE_REASON} (current-file-anchored, same-cycle label drift)"
)


def supersede_prior_pending_for_agent(
    target_agent: str,
    target_file: str,
    *,
    cycle_date: str,
    pattern_label: str,
) -> int:
    """Terminate the same agent's OTHER pending proposals → 'rejected'.

    One proposal per agent per cycle — but a leftover same-agent PENDING row
    re-accumulates backlog across multiple rows. The new proposal has fresher
    data + current-file anchoring, so supersede (transition to rejected) the
    others to block same-agent duplicate accumulation.

    The run's OWN row is excluded by the (cycle_date, pattern_label, target_file)
    identity its push will update. The FU-1 dedup key cannot do that work: this
    statement never touches cycle_date, so two runs sharing a cycle_date would
    otherwise terminalize each other's still-pending row — a proposal that should
    have applied. Everything else still transitions, including a same-cycle row
    under a drifted label.

    monitor has no dedicated supersede enum, so this is marked 'rejected' +
    rationale (ProposalStatus enum preserved — no schema change). The stamp is
    per row: the run's own cycle date carries the same-cycle tail, an older row
    the cross-day tail.

    Loud-fail: PG errors logged via named exception + re-raised. PG unavailable →
    return 0 (supersede skipped — the new proposal still emits normally).

    Args:
        target_agent: target agent (core.autoagent_proposals.target_agent column).
        target_file: target agent .md absolute path.
        cycle_date: the run's own cycle date (YYYY-MM-DD), date-cast in the
            statement because the column is date-typed.
        pattern_label: the consolidated label the run's own push will own.

    Returns:
        count of other pending rows terminated (transitioned to rejected).
    """
    if not HAS_PG_LOOP_WRITE:
        sys.stderr.write(
            "[daemon-cycle] supersede: PG unavailable (psycopg/helper import "
            f"failed) — skipped for agent={target_agent}\n"
        )
        return 0
    if not target_agent or not target_file:
        return 0
    if not cycle_date or not pattern_label:
        # Without the run's own identity the exclusion cannot be expressed, and
        # superseding without it terminalizes the very row this run will push.
        sys.stderr.write(
            "[daemon-cycle] supersede: missing run identity "
            f"(cycle_date={cycle_date!r} pattern_label={pattern_label!r}) — "
            f"skipped for agent={target_agent}\n"
        )
        return 0

    # The excluded triple IS the FU-1 dedup key — the identity the run's own push
    # will update, so it must survive its own supersede.
    update_sql = (
        "UPDATE core.autoagent_proposals "
        "SET status = 'rejected', "
        "rationale = CASE WHEN cycle_date = %s::date THEN %s ELSE %s END "
        "WHERE status = 'pending' "
        "AND target_agent = %s AND target_file = %s "
        "AND NOT (cycle_date = %s::date AND pattern_label = %s "
        "AND target_file = %s) "
        "RETURNING id"
    )
    update_params = (
        cycle_date,
        _SUPERSEDE_REASON_SAME_CYCLE,
        _SUPERSEDE_REASON_CROSS_DAY,
        target_agent,
        target_file,
        cycle_date,
        pattern_label,
        target_file,
    )
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(update_sql, update_params)
                superseded_ids = [row[0] for row in cur.fetchall()]
            conn.commit()
    except Exception as exc:  # noqa: BLE001 — loud-fail: log named + re-raise
        sys.stderr.write(
            f"[daemon-cycle] supersede ERROR (PG) for agent={target_agent}: "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        raise

    if superseded_ids:
        sys.stderr.write(
            f"[daemon-cycle] supersede: agent={target_agent} terminated "
            f"{len(superseded_ids)} other pending row(s) ids={superseded_ids} "
            f"→ rejected (fresher per-agent proposal)\n"
        )
    return len(superseded_ids)


# -- Chronic Haiku-timeout back-off (generation side) -----------------------


class BackoffState(NamedTuple):
    """One target's back-off standing — a held hold is never a silent one."""

    streak: int  # consecutive timeouts recorded under the CURRENT ceiling
    held_cycles: int  # consecutive back-off skip cycles at the head
    superseded_skipped: int  # timeouts looked past as measured under another ceiling
    probe_due: bool


def get_recorded_timeout_ceiling(rationale: str) -> int | None:
    """Recover the ceiling a timeout row was measured against, or None."""
    match = _RECORDED_CEILING_RE.match((rationale or "").strip())
    return int(match.group(1)) if match else None


def build_backoff_state(
    rationales: "list[str]",
    *,
    ceiling_sec: int | None = None,
    probe_cycles: int | None = None,
) -> BackoffState:
    """Evaluate a target's back-off standing from its newest-first rationales.

    Three row classes, each answering a different question:

    * A timeout recorded under the CURRENT ceiling is evidence and advances the
      streak. One recorded under a SUPERSEDED ceiling is evidence about a regime
      that no longer exists — it is looked past, neither advancing nor breaking.
      An UNPARSEABLE ceiling counts as not-superseded, so an unreadable value
      keeps the back-off rather than releasing it.
    * A back-off skip row is not itself a timeout, so it is looked past for the
      streak — but counted separately, because that count IS "held for N cycles"
      and nothing else in the history carries it.
    * Any other row is a genuine adjudication and breaks the run, unchanged.

    Args:
        rationales: proposal rationales for one target, newest first.
        ceiling_sec: ceiling to evaluate against (default HAIKU_TIMEOUT_SEC).
        probe_cycles: hold bound (default TIMEOUT_BACKOFF_PROBE_CYCLES).

    Returns:
        BackoffState — streak, held cycles, superseded count, probe verdict.
    """
    ceiling = HAIKU_TIMEOUT_SEC if ceiling_sec is None else ceiling_sec
    bound = TIMEOUT_BACKOFF_PROBE_CYCLES if probe_cycles is None else probe_cycles
    streak = 0
    held_cycles = 0
    superseded_skipped = 0
    in_head_run = True
    for rationale in rationales:
        text = (rationale or "").strip()
        if text.startswith(TIMEOUT_BACKOFF_RATIONALE_PREFIX):
            if in_head_run:
                held_cycles += 1
            continue
        in_head_run = False
        if not text.startswith(HAIKU_TIMEOUT_RATIONALE_PREFIX):
            break
        recorded = get_recorded_timeout_ceiling(text)
        if recorded is not None and recorded != ceiling:
            superseded_skipped += 1
            continue
        streak += 1
    return BackoffState(
        streak=streak,
        held_cycles=held_cycles,
        superseded_skipped=superseded_skipped,
        probe_due=held_cycles >= bound,
    )


def read_backoff_state(target_file: str) -> BackoffState:
    """Read one target's proposal history and evaluate its back-off standing.

    Keyed on ``target_file`` ALONE — one consolidated proposal is emitted per agent
    per cycle, so "consecutive" is a per-TARGET aggregate across that agent's
    patterns, not strictly per-pattern. Slightly more eager back-off, but any single
    'ok' still resets it → no suppression risk.

    PG unavailable (HAS_PG_LOOP_WRITE False) or any read error → an all-zero state
    (fail-OPEN: a read failure must never silently snooze a healthy candidate).
    Empty target_file → the same.

    Args:
        target_file: target agent .md absolute path (core.autoagent_proposals.target_file).

    Returns:
        BackoffState — all-zero, probe_due False, when nothing could be read.
    """
    empty = BackoffState(
        streak=0, held_cycles=0, superseded_skipped=0, probe_due=False
    )
    if not HAS_PG_LOOP_WRITE or not target_file:
        return empty

    # Bounded window — only the recent history matters for a back-off decision;
    # LIMIT keeps the scan cheap and avoids walking years of rows.
    select_sql = (
        "SELECT rationale FROM core.autoagent_proposals "
        "WHERE target_file = %s "
        "ORDER BY cycle_date DESC, id DESC "
        "LIMIT 50"
    )
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, (target_file,))
                rows = cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not snooze
        sys.stderr.write(
            f"[daemon-cycle] timeout-backoff: PG read failed for "
            f"target={target_file} — fail-open (count=0): "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return empty

    return build_backoff_state([(row[0] or "") for row in rows])


def consecutive_timeout_count(target_file: str) -> int:
    """Length of the leading consecutive-timeout run for a target.

    The gate's own seam, kept as the run_cycle entry point. A single non-timeout
    row resets it to 0 (the candidate re-arms automatically; this is the recovery
    path for a transiently-flaky-but-generatable target) — but that row can only
    be produced by the Haiku call a closed gate suppresses, which is why
    ``BackoffState.probe_due`` exists beside this count.

    Args:
        target_file: target agent .md absolute path.

    Returns:
        int — 0 when none, on read error, or when PG is unavailable.
    """
    return read_backoff_state(target_file).streak


def backoff_skip_proposal(target_file: str, streak: int) -> PatchProposal:
    """Build the observable 'skipped' PatchProposal for a backed-off target.

    No Haiku call was made — this is the loud, persisted record of the back-off
    decision (per shared-self-improve-hygiene Precondition Loud-Fail: the skip is
    surfaced in the proposal row, never silent). Empty diff + a back-off rationale
    + parse_mode='skipped'. run_cycle maps this to a 'snoozed'/reject row whose
    `error` field stays EMPTY, so the cycle does not flip to 'partial'.

    Args:
        target_file: target agent .md absolute path.
        streak: the consecutive-timeout count that tripped the threshold.

    Returns:
        PatchProposal — empty-diff skip record.
    """
    return PatchProposal(
        target_file=target_file,
        rationale=TIMEOUT_BACKOFF_RATIONALE_TEMPLATE.format(
            n=streak, thr=TIMEOUT_BACKOFF_THRESHOLD
        ),
        proposed_diff="",
        touched_frontmatter=False,
        estimated_added_lines=0,
        raw_response="",
        parse_mode="skipped",
    )


# -- Generation-side pattern lifecycle gates (anti-fossil) -------------------


def _terminalize_pattern(
    agent: str,
    pattern: Pattern,
    event_ts: str,
    *,
    reason: str,
    log_label: str,
    eval_result: str,
) -> None:
    """Shared terminal action for every pattern-drop gate — deliberately unenumerated
    so adding a gate needs no docstring edit (grep the callers for the current set).

    Transitions a fossil pattern's core.learning_log row to terminal 'rejected'
    (the intake predicate stops selecting it next cycle on), then loudly records
    the drop (fail-on-None stderr WARN + loop-event emit). The gates differ
    only in WHICH patterns reach here (their own predicate) plus the reason /
    log_label / eval_result strings — this tail MUST stay in lockstep, so it lives
    once. A failed transition (PG write error) still drops for this cycle.
    """
    transitioned = _pg_reject_learning_pattern(pattern.row_id, reason)
    if transitioned is None:
        sys.stderr.write(
            f"[daemon-cycle] {log_label}: learning_log id={pattern.row_id} "
            "transition matched no row (already terminal or PG write failed) "
            "— pattern still skipped this cycle\n"
        )
    _warn_pattern_skip(
        agent,
        pattern.raw_line,
        event_ts,
        eval_result=eval_result,
        reason=reason,
    )


def drop_reject_streak_patterns(
    agent: str,
    patterns: list[Pattern],
    rows: list[tuple[str, str, str]] | None = None,
) -> list[Pattern]:
    """Reject-streak gate — snooze patterns whose proposals keep getting rejected.

    A pattern whose last REJECT_STREAK_THRESHOLD adjudicated proposals were ALL
    genuine rejects is a fossil: the generator re-proposes every cycle from a
    signal the review side keeps refusing. Transition its core.learning_log row
    to terminal 'rejected' (the intake predicate stops selecting it from the
    next cycle on) and drop it from THIS cycle's generation. The drop is loud
    (stderr WARN + eval_result='reject-streak-snooze' loop event), never silent.

    Fail-open: proposal-history read failure / synthetic row_id → pattern kept.
    A failed transition (PG write error) still drops for this cycle — the
    streak evidence stands — and retries naturally on the next cycle.

    Args:
        agent: pattern target agent (group key).
        patterns: the agent's intake patterns (freq DESC).
        rows: pre-fetched _fetch_proposal_history result — run_cycle shares one
            fetch across both proposal-history gates (read-only here). None →
            self-fetch (backward-compatible for direct callers).

    Returns:
        surviving patterns, input order preserved.
    """
    if rows is None:
        rows = _fetch_proposal_history(agent)
    if rows is None:
        return patterns

    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")
    kept: list[Pattern] = []
    for pattern in patterns:
        if pattern.row_id <= 0:
            kept.append(pattern)
            continue
        streak = consecutive_reject_count(pattern.label, rows)
        if streak < REJECT_STREAK_THRESHOLD:
            kept.append(pattern)
            continue
        reason = REJECT_STREAK_REASON_TEMPLATE.format(
            n=streak, thr=REJECT_STREAK_THRESHOLD
        )
        _terminalize_pattern(
            agent,
            pattern,
            event_ts,
            reason=reason,
            log_label="reject-streak",
            eval_result="reject-streak-snooze",
        )
    return kept


def drop_reverted_patterns(
    agent: str,
    patterns: list[Pattern],
    rows: list[tuple[str, str, str]] | None = None,
) -> list[Pattern]:
    """Reverted-proposal gate — snooze patterns whose applied change was reverted.

    A 'reverted' proposal row records a human/CLI back-out of an APPLIED
    change — the strongest terminal verdict a pattern can receive.
    Regenerating from the same pattern would re-propose the exact change a
    human just backed out, so the covering pattern's core.learning_log row is
    transitioned to terminal 'rejected' (the intake predicate stops selecting
    it) and dropped from THIS cycle's generation. Loud (stderr WARN +
    eval_result='reverted-snooze' loop event), never silent. The proposal row
    itself is NOT mutated — 'reverted' stays 'reverted', and the apply-side
    backlog SELECT already excludes it via its pending/snoozed predicates.

    Fail-open: proposal-history read failure / synthetic row_id → pattern kept.
    ``rows`` mirrors drop_reject_streak_patterns — a pre-fetched
    _fetch_proposal_history result (None → self-fetch).
    """
    if rows is None:
        rows = _fetch_proposal_history(agent)
    if rows is None:
        return patterns

    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")
    kept: list[Pattern] = []
    for pattern in patterns:
        if pattern.row_id <= 0:
            kept.append(pattern)
            continue
        covered = any(
            status == "reverted"
            and _covers_pattern_label(pattern.label, proposal_label)
            for status, proposal_label, _rationale in rows
        )
        if not covered:
            kept.append(pattern)
            continue
        _terminalize_pattern(
            agent,
            pattern,
            event_ts,
            reason=REVERTED_SNOOZE_REASON,
            log_label="reverted-snooze",
            eval_result="reverted-snooze",
        )
    return kept


def drop_apply_capped_patterns(
    agent: str,
    patterns: list[Pattern],
    rows: list[tuple[str, str, str]] | None = None,
) -> list[Pattern]:
    """Repeat-apply cap — stop proposing once N patches failed to fix the problem.

    A pattern that has already landed APPLY_CAP_THRESHOLD patches and is STILL
    being selected has had its remedy disproven N times: each apply stacked
    another prose rule onto the live agent body without retiring the previous
    one, which is how one agent accumulated four mutually-unreachable budget
    thresholds. Cap it — transition the covering core.learning_log row to
    terminal 'rejected' (the intake predicate stops selecting it from the next
    cycle on) and drop it from THIS cycle. Loud (stderr WARN +
    eval_result='repeat-apply-cap' loop event), never silent.

    NAMING BOUNDARY — do not collapse this into a resolution. Terminal
    'rejected' means STOP PROPOSING and nothing more. The targeted signal is
    still live; the cap only stops the loop from stacking an (N+1)th
    contradictory rule on top of it, and the capped row is an OPEN item needing
    a human design decision. It MUST NOT be renamed, aliased or documented as
    resolved / fixed / closed, MUST NOT write the 'applied' terminal status, and
    MUST NOT route through discharge_learning_pattern — that path claims the
    underlying problem is discharged, which the still-accumulating live signal
    refutes. Pinned by TestApplyCapNamingBoundary.

    Evidence caveat: selection-implies-emission holds only while the staleness
    gate can actually run (drop_stale_patterns fails OPEN on unreadable live
    stats and on an unknown label family), so a high apply count is strong
    evidence of non-abatement, NOT proof of it. The cap is deliberately sized so
    a false positive costs one manual status reset.

    Fail-open: proposal-history read failure / synthetic row_id → pattern kept.
    A failed transition (PG write error) still drops for this cycle — the apply
    evidence stands — and retries naturally on the next cycle.

    Args:
        agent: pattern target agent (group key).
        patterns: the agent's intake patterns (freq DESC).
        rows: pre-fetched _fetch_proposal_history result — run_cycle shares one
            fetch across every proposal-history gate (read-only here). None →
            self-fetch (backward-compatible for direct callers).

    Returns:
        surviving patterns, input order preserved.
    """
    if rows is None:
        rows = _fetch_proposal_history(agent)
    if rows is None:
        return patterns

    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")
    kept: list[Pattern] = []
    for pattern in patterns:
        if pattern.row_id <= 0:
            kept.append(pattern)
            continue
        applies = covering_apply_count(pattern.label, rows)
        if applies < APPLY_CAP_THRESHOLD:
            kept.append(pattern)
            continue
        reason = APPLY_CAP_REASON_TEMPLATE.format(n=applies, thr=APPLY_CAP_THRESHOLD)
        _terminalize_pattern(
            agent,
            pattern,
            event_ts,
            reason=reason,
            log_label="repeat-apply-cap",
            eval_result="repeat-apply-cap",
        )
    return kept


def _pattern_has_out_of_region_modify(
    pattern_label: str,
    rows: list[tuple[str, str, str]],
) -> bool:
    """Whether any pending proposal COVERING the pattern is an out-of-region MODIFY.

    Walks the agent's recent pending proposals (newest-first) and returns True on
    the first one whose proposal label covers ``pattern_label`` AND whose stored diff
    REMOVES a line outside every editable region (``_diff_modifies_out_of_region``).
    A covering pure-add proposal is re-anchorable, not structural → keep scanning.
    Empty diff / target_file → skipped (no evidence).
    """
    for proposal_label, proposed_diff, target_file in rows:
        if not _covers_pattern_label(pattern_label, proposal_label):
            continue
        if not proposed_diff.strip() or not target_file.strip():
            continue
        if _diff_modifies_out_of_region(proposed_diff, Path(target_file)):
            return True
    return False


def drop_non_auto_fixable_patterns(
    agent: str,
    patterns: list[Pattern],
) -> list[Pattern]:
    """Non-auto-fixable gate — terminalize out-of-region MODIFY patterns (RC3).

    A MODIFY proposal (it REMOVES a line) whose removed line sits OUTSIDE every
    editable region can never be expressed by the add-only synthesis pipeline, so
    the apply-side landing-zone guard rejects it EVERY cycle and the generator
    re-selects the pattern forever (the dev-shell ``--external-sources`` fossil).
    Detect such a pattern from its latest pending proposal diff and transition the
    ``core.learning_log`` row to terminal 'rejected' (the intake predicate stops
    selecting it from the next cycle on), then drop it from THIS cycle. The drop is
    loud (stderr WARN + ``eval_result='non-auto-fixable-skip'`` loop event).

    Shares the terminal action (``_terminalize_pattern``) with
    ``drop_reject_streak_patterns`` — the sibling that also TERMINALIZES (vs.
    ``drop_stale_patterns``, which only snoozes for a cycle).

    Fail-open: proposal-diff read failure / synthetic row_id / no covering
    out-of-region MODIFY → pattern kept. A failed transition (PG write error) still
    drops for this cycle — the structural evidence stands — and retries naturally
    on the next cycle.

    Args:
        agent: pattern target agent (group key).
        patterns: the agent's intake patterns (freq DESC).

    Returns:
        surviving patterns, input order preserved.
    """
    rows = _fetch_pending_modify_diffs(agent)
    if rows is None:
        return patterns

    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")
    kept: list[Pattern] = []
    for pattern in patterns:
        if pattern.row_id <= 0:
            kept.append(pattern)
            continue
        if not _pattern_has_out_of_region_modify(pattern.label, rows):
            kept.append(pattern)
            continue
        _terminalize_pattern(
            agent,
            pattern,
            event_ts,
            reason=NON_AUTO_FIXABLE_REASON,
            log_label="non-auto-fixable",
            eval_result="non-auto-fixable-skip",
        )
    return kept


def drop_stale_patterns(agent: str, patterns: list[Pattern]) -> list[Pattern]:
    """Staleness gate — skip patterns the LIVE outcome window no longer supports.

    core.learning_log frequency accumulates forever, so a pattern can outlive
    its evidence (the '62%' fossil regenerated proposals weeks after the live
    rate normalized). Recompute the rate from the rolling window and skip
    below-threshold patterns with a logged reason. No lifecycle transition —
    the pattern re-arms by itself once the live rate crosses the floor again.

    Fail-open: stats unavailable (PG off / read error) or unknown label family
    → pattern kept.

    Args:
        agent: pattern target agent (group key).
        patterns: the agent's intake patterns (freq DESC).

    Returns:
        surviving patterns, input order preserved.
    """
    stats = _live_failure_stats(agent)
    if stats is None:
        return patterns

    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")
    kept: list[Pattern] = []
    for pattern in patterns:
        reason = _stale_reason(pattern.label, stats)
        if not reason:
            kept.append(pattern)
            continue
        _warn_pattern_skip(
            agent,
            pattern.raw_line,
            event_ts,
            eval_result="stale-pattern-skip",
            reason=reason,
        )
    return kept


def classify_failure_rationale(rationale: str) -> str:
    """Map a persisted proposal rationale → its failure class (the single SoT).

    The de-conflation root-cause fix: consecutive_reject_count must distinguish a
    GENUINE QUALITY reject (a strict/fuzzy candidate the review side refused) from
    a NON-ADJUDICATION failure (infra non-zero exit, quota cap, local budget cap,
    transient overload, chronic timeout, mechanical supersede). The persisted
    history row carries ONLY (status, pattern_label, rationale) — parse_mode is
    NOT a PG column — so the discriminator MUST key on the rationale text emitted
    at the Haiku failure boundary. Anchoring on the LITERAL infra prefixes (the
    f-string heads at the non-zero/quota/budget/transient/timeout branches +
    _SUPERSEDE_REASON) gives one place to teach a future infra-rationale variant.

    Default-to-advance on unknown: an unrecognized rationale is treated as a
    genuine QUALITY reject (FAILURE_CLASS_QUALITY) so the kill mechanism stays
    armed — only a POSITIVELY-matched infra signature is looked past. This is the
    over-skip guard: a true quality reject must still advance the streak.
    """
    text = (rationale or "").strip()
    if not text:
        # Empty rationale carries no quality verdict → non-adjudication.
        return FAILURE_CLASS_SKIPPED
    if text.startswith(REMOVAL_REFUSAL_REASON_PREFIX):
        # ADJUDICATING: the diff was refused on its own evidence, so the streak
        # MUST advance (a pattern the loop cannot express should stop being
        # regenerated). Named apart from quality only so the rows are filterable.
        return FAILURE_CLASS_REMOVAL_REFUSAL
    if text.startswith(_SUPERSEDE_REASON):
        return FAILURE_CLASS_SUPERSEDE
    if text.startswith(HAIKU_TIMEOUT_RATIONALE_PREFIX):
        return FAILURE_CLASS_TIMEOUT
    if text.startswith("haiku auth failure"):
        # 401/credential — INFRA, looked PAST by the kill streak (must precede
        # the generic non-zero branch so an auth failure is not mislabeled).
        return FAILURE_CLASS_AUTH
    if text.startswith("haiku non-zero exit"):
        return FAILURE_CLASS_SKIPPED
    if text.startswith("haiku quota limit detected"):
        return FAILURE_CLASS_QUOTA
    if text.startswith("local --max-budget-usd ceiling too low"):
        return FAILURE_CLASS_BUDGET
    if text.startswith("haiku transient overload"):
        return FAILURE_CLASS_TRANSIENT
    if text.startswith(_BELOW_FLOOR_REJECT_PREFIX):
        # Confidence-floor terminalization (resolve_floor_terminalization) — a
        # MECHANICAL, explicitly-recoverable reject ("resurfaces when the pattern
        # clears the floor"), NOT a quality verdict. It persists status='rejected'
        # but no review side ever adjudicated the candidate, so it MUST NOT advance
        # the kill streak (the exact de-conflation class for a new reject variant).
        return FAILURE_CLASS_SKIPPED
    if text.startswith("claude CLI not found"):
        # CLI-missing is an infra/environment failure, not a quality verdict.
        return FAILURE_CLASS_SKIPPED
    if text.startswith("target agent file not found"):
        return FAILURE_CLASS_SKIPPED
    if text.startswith("skip_haiku=True"):
        return FAILURE_CLASS_SKIPPED
    # Unrecognized → a genuine quality reject (default-to-advance, armed).
    return FAILURE_CLASS_QUALITY


def derive_cost_guard_state(report: CycleReport) -> str:
    """Derive the cost-guard state enum from the cycle's per-patch failure classes.

    The cost_guard dict carries POLICY params (caps/budgets), not a state enum —
    so the state is computed at cycle end from the aggregate failure_class set:
      - any auth-failure → 'infra_fault'  (a 401/credential outage, NOT spend —
        the monitor chip must show "Auth fault", never a "Spending guard" warning);
      - a genuine quota/budget cap → 'warn' (real spend signal);
      - otherwise → 'ok' (clean / quality-only / quiet night).
    Precedence: infra_fault > warn > ok — a credential outage is the most
    actionable signal and MUST NOT be masked by a co-occurring quota row.

    _pg_push_autoagent_cycle.py reads cost_guard['state'] as the explicit_state
    override (its accepted set includes 'infra_fault').
    """
    classes = {(p.failure_class or "") for p in report.patches}
    if FAILURE_CLASS_AUTH in classes:
        return "infra_fault"
    if FAILURE_CLASS_QUOTA in classes or FAILURE_CLASS_BUDGET in classes:
        return "warn"
    return "ok"


def is_infra_pre_verify_status(status: str) -> bool:
    """Whether a pre-verify status marks an INFRA non-adjudication (not a verdict).

    ``run_pre_verify`` stamps ``error:*`` (``error:timeout-*`` / ``error:cli-not-
    found`` / ``error:exit-*``) when the VERIFIER itself failed — a verifier
    OUTAGE, not a quality verdict on the (already generated) candidate. Recording
    such a candidate as a terminal quality ``rejected`` carries the GENERATOR
    rationale, which ``classify_failure_rationale`` reads as FAILURE_CLASS_QUALITY
    → the consecutive_reject kill streak advances on an infra night (DF-6). Route
    these to ``pending`` instead (re-verified next cycle). ``skipped:*`` (flag /
    empty-diff) is a normal skip handled on its own path, so it is NOT infra here.
    """
    return status.startswith("error:")


def route_failed_pre_verify(
    classification: str, verify_status: str
) -> tuple[str, str, str]:
    """Route a non-safety, pre-verify-FAILED body-auto candidate to its persisted state.

    Returns ``(classification, approval_tier, status_value)``. Two structurally
    distinct pre-verify failures:
      - INFRA non-adjudication (``is_infra_pre_verify_status`` — verifier timeout
        / CLI-missing / non-zero exit): the candidate was never adjudicated →
        leave it ``pending`` (classification unchanged) so it is re-verified next
        cycle and the consecutive_reject kill streak is NOT advanced by an outage.
        approval_tier='' + pre_verify_passed=False keep it off the auto-apply
        SELECT, so no unverified diff is ever applied.
      - GENUINE quality verdict (verifier ran + refused): auto-reject — persist
        ``rejected`` so the row does not fossilize at pending.
    """
    if is_infra_pre_verify_status(verify_status):
        return classification, "", "pending"
    return "reject", "", "rejected"


def consecutive_reject_count(
    pattern_label: str,
    proposal_rows: list[tuple[str, str, str]],
) -> int:
    """Count the leading run of genuine QUALITY rejects covering one pattern label.

    proposal_rows: (status, pattern_label, rationale) newest-first — one shared
    per-agent fetch (_fetch_proposal_history) serves every pattern in the group.

    Walk semantics (newest → oldest):
      - row whose label does not cover this pattern → looked past (no verdict);
      - 'rejected' whose rationale classifies as a NON-ADJUDICATION class
        (supersede / chronic-timeout / generic non-zero exit / quota-limit /
        budget-too-low / transient-overload / empty-or-error) → looked past:
        the candidate was never genuinely adjudicated, so it MUST NOT advance
        the kill streak (the de-conflation root-cause fix);
      - 'rejected' classifying as a genuine QUALITY reject → streak += 1;
      - 'snoozed' (back-off, stale-drain) / 'pending' (not yet adjudicated) /
        'reverted' (human/CLI back-out — terminal-non-resurrectable: it must
        NOT re-arm the candidate the way an accepted change does; pattern
        exclusion is owned by drop_reverted_patterns) → looked past;
      - anything else ('applied' / 'approved') → break — an accepted change
        re-arms the candidate, mirroring consecutive_timeout_count recovery.

    The non-adjudication discrimination is delegated to classify_failure_rationale
    (the single SoT) so a future infra-rationale variant has exactly one place to
    be taught — never re-introduce a parallel rationale.startswith(...) test here.
    """
    streak = 0
    for status, proposal_label, rationale in proposal_rows:
        if not _covers_pattern_label(pattern_label, proposal_label):
            continue
        if status == "rejected":
            if classify_failure_rationale(rationale) in _NON_ADJUDICATION_CLASSES:
                continue
            streak += 1
            continue
        if status in ("snoozed", "pending", "reverted"):
            continue
        break
    return streak


def covering_apply_count(
    pattern_label: str,
    proposal_rows: list[tuple[str, str, str]],
) -> int:
    """Count APPLIED proposals in the window whose label covers one pattern.

    proposal_rows: (status, pattern_label, rationale) newest-first — the SAME
    shared per-agent fetch consecutive_reject_count walks
    (_fetch_proposal_history), so the cap costs no extra read and needs no new
    observation channel.

    TOTAL, not consecutive, by design: the harm is the ACCUMULATION of stacked
    rules on one live agent body, and an intervening reject does not un-stack an
    already-landed one. That is also exactly what makes this gate non-redundant
    with the reject-streak gate, whose streak an 'applied' row RESETS.

    A 'reverted' row is deliberately NOT discounted here: a human back-out is
    owned by drop_reverted_patterns, which terminalizes first and outranks every
    generation-side verdict, so such a pattern never reaches this counter.
    """
    return sum(
        1
        for status, proposal_label, _rationale in proposal_rows
        if status == "applied"
        and _covers_pattern_label(pattern_label, proposal_label)
    )


def _fetch_proposal_rows(
    target_agent: str,
    select_sql: str,
    params: tuple[object, ...],
    log_label: str,
) -> list[tuple] | None:
    """Shared PG fetch + fail-OPEN plumbing for the per-agent proposal readers.

    Owns the ``HAS_PG_LOOP_WRITE``/``target_agent`` gate, the connect + execute +
    ``fetchall``, and the broad-except fail-OPEN stderr — returning the RAW
    ``cur.fetchall()`` rows for the caller to normalize. Each caller keeps its OWN
    ``select_sql`` + ``params``; the projection is NEVER widened here. PG off /
    read error → ``None`` (a read failure must never snooze or terminalize a
    healthy pattern).
    """
    if not HAS_PG_LOOP_WRITE or not target_agent:
        return None
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, params)
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not snooze/terminalize
        sys.stderr.write(
            f"[daemon-cycle] {log_label}: PG read failed for "
            f"agent={target_agent} — fail-open: "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def _fetch_proposal_history(
    target_agent: str,
) -> list[tuple[str, str, str]] | None:
    """Recent proposal adjudication history for one agent, newest-first.

    Bounded LIMIT 50 mirrors consecutive_timeout_count (only recent history
    matters for a back-off decision). PG unavailable / read error → None
    (fail-OPEN: a read failure must never snooze a healthy pattern).

    This LIMIT also bounds every count stamped into a reason template ({n} in
    the reject-streak and apply-cap reasons), which is what lets
    test_reason_tail_budget.py check those budgets at a three-digit width.
    Raising it past 999 means widening _WIDEST_SUBSTITUTION there in the same
    change, or an over-long reason gets sliced silently with the test green.
    """
    select_sql = (
        "SELECT status::text, pattern_label, rationale "
        "FROM core.autoagent_proposals "
        "WHERE target_agent = %s "
        "ORDER BY cycle_date DESC, id DESC "
        "LIMIT 50"
    )
    rows = _fetch_proposal_rows(
        target_agent, select_sql, (target_agent,), "reject-streak"
    )
    if rows is None:
        return None
    return [
        (status or "", label or "", rationale or "")
        for status, label, rationale in rows
    ]


def _fetch_pending_modify_diffs(
    target_agent: str,
) -> list[tuple[str, str, str]] | None:
    """Recent PENDING proposal diffs for one agent, newest-first.

    Feeds the non-auto-fixable gate (``drop_non_auto_fixable_patterns``): the gate
    matches each intake pattern against these rows via ``_covers_pattern_label`` and
    probes the diff with ``_diff_modifies_out_of_region``. SEPARATE projection from
    the shared ``_fetch_proposal_history`` (do NOT widen that one — its docstring
    forbids it): this SELECTs ``proposed_diff`` + ``target_file`` and filters on
    ``status='pending'``.

    Mirrors ``_fetch_proposal_history``'s connection + fail-OPEN discipline:
    ``HAS_PG_LOOP_WRITE`` gate and PG off / read error → ``None`` (a read failure
    must never terminalize a healthy pattern).

    Returns:
        ``[(pattern_label, proposed_diff, target_file), ...]`` newest-first (≤ 50),
        ``[]`` when PG holds no pending rows, ``None`` on PG-off / read error.
    """
    select_sql = (
        "SELECT pattern_label, proposed_diff, target_file "
        "FROM core.autoagent_proposals "
        "WHERE target_agent = %s AND status = 'pending' "
        "AND proposed_diff IS NOT NULL "
        "ORDER BY cycle_date DESC, id DESC "
        "LIMIT 50"
    )
    rows = _fetch_proposal_rows(
        target_agent, select_sql, (target_agent,), "non-auto-fixable"
    )
    if rows is None:
        return None
    return [
        (label or "", diff or "", target_file or "")
        for label, diff, target_file in rows
    ]


def _fetch_pre_verify_failures(
    target_agent: str,
    limit: int = PRE_VERIFY_FAILURES_LIMIT,
) -> list[tuple[dict, str]] | None:
    """Recent pre_verify-FAILED proposal shapes for one agent, newest-first.

    Optimizer-side memory (SkillOpt R2): the generator prepends these known-bad
    diff shapes into its prompt so it learns to avoid them. SEPARATE from the
    shared ``_fetch_proposal_history`` projection (do NOT widen that one) — this
    SELECTs the pre-verify detail (``pre_verify_axes`` JSONB + ``rationale``)
    and filters on ``pre_verify_passed = false``.

    Mirrors ``_fetch_proposal_history``'s connection + fail-OPEN discipline:
    ``HAS_PG_LOOP_WRITE`` gate (``_pg_connect`` is unbound when psycopg is
    absent — same import as the proposal-history reader) and PG off / read
    error → ``None`` (never raise — a memory miss must never block generation).

    Returns:
        ``[(pre_verify_axes_dict, rationale), ...]`` newest-first (≤ ``limit``),
        ``[]`` when PG holds no failed rows, ``None`` on PG-off / read error.
    """
    if not HAS_PG_LOOP_WRITE or not target_agent:
        return None

    select_sql = (
        "SELECT pre_verify_axes, rationale "
        "FROM core.autoagent_proposals "
        "WHERE target_agent = %s AND pre_verify_passed = false "
        "ORDER BY cycle_date DESC, id DESC "
        "LIMIT %s"
    )
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, (target_agent, limit))
                return [
                    (axes if isinstance(axes, dict) else {}, rationale or "")
                    for axes, rationale in cur.fetchall()
                ]
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not block generation
        sys.stderr.write(
            f"[daemon-cycle] avoid-memory: pre-verify-failure read failed for "
            f"agent={target_agent} — fail-open: "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def _render_pre_verify_failures_block(
    rows: list[tuple[dict, str]],
    *,
    char_cap: int = PRE_VERIFY_FAILURES_CHAR_CAP,
) -> str:
    """Render the 'avoid these known-bad diff shapes' block, HARD char-capped.

    Each row → a compact line naming the failed compliance axes (the C1-C4
    keys whose value is false in ``pre_verify_axes``) plus the verifier's
    rationale. The assembled block is HARD-truncated at ``char_cap`` with a
    loud truncation marker (never advisory) so the prepended memory cannot push
    prompt cost past ``PRE_VERIFY_MAX_BUDGET_USD``.

    Returns ``""`` for empty input so the caller omits the block cleanly (no
    empty-header noise).
    """
    if not rows:
        return ""

    lines: list[str] = []
    for axes, rationale in rows:
        # Constrained to the four compliance axes: the payload also carries the
        # prose-only-add passenger, and a false verdict there is NOT a failed
        # compliance axis — rendering it would tell the generator it failed an
        # axis that does not exist.
        failed_axes = sorted(
            k for k, v in axes.items() if v is False and k in COMPLIANCE_AXIS_KEYS
        )
        axes_text = ", ".join(failed_axes) if failed_axes else "unspecified-axis"
        # Converged on the shared sanitizer: this site already flattened by hand,
        # and a second definition is how one sink drifts out of step with another.
        rationale_text = flatten_log_field(rationale, default="(no rationale recorded)")
        lines.append(f"- failed axes [{axes_text}]: {rationale_text}")

    block = "\n".join(lines)
    if len(block) > char_cap:
        marker = f"\n[TRUNCATED: avoid-pattern memory capped at {char_cap} chars]"
        block = block[: char_cap - len(marker)] + marker
    return block


def _fetch_landed_proposals(
    target_agent: str,
    limit: int = LANDED_HISTORY_LIMIT,
) -> list[tuple[str, str]] | None:
    """Recently APPLIED proposals for one agent, newest-first.

    The feedback half of the optimizer-side memory: the generator is told what it
    already landed so it builds on those rules instead of re-proposing them.
    SEPARATE projection from the sibling readers (do NOT widen theirs) — this one
    SELECTs the patch text and filters on the terminal ``applied`` status.

    Mirrors the sibling fail-OPEN discipline: PG off / read error → ``None``
    (a memory miss must never block generation).

    Returns:
        ``[(pattern_label, proposed_diff), ...]`` newest-first (≤ ``limit``),
        ``[]`` when PG holds no applied rows, ``None`` on PG-off / read error.
    """
    select_sql = (
        "SELECT pattern_label, proposed_diff "
        "FROM core.autoagent_proposals "
        "WHERE target_agent = %s AND status::text = 'applied' "
        "AND proposed_diff IS NOT NULL "
        "ORDER BY cycle_date DESC, id DESC "
        "LIMIT %s"
    )
    rows = _fetch_proposal_rows(
        target_agent, select_sql, (target_agent, limit), "landed-history"
    )
    if rows is None:
        return None
    return [(label or "", diff or "") for label, diff in rows]


def _render_landed_history_block(
    rows: list[tuple[str, str]],
    *,
    char_cap: int = LANDED_HISTORY_CHAR_CAP,
) -> str:
    """Render the 'already landed for this agent' block, HARD char-capped.

    Each row → its pattern label plus the lines the patch ADDED; those lines are
    what now sits in the body, and the context lines around them are already
    visible in the whole-file excerpt further down the prompt. Model-authored
    patch text re-entering a prompt is an LLM trust boundary, so every field goes
    through the shared ``_neutralize_field`` sanitizer (LLM01).

    Returns ``""`` for empty input so the caller omits the block cleanly.
    """
    if not rows:
        return ""

    lines: list[str] = []
    for label, diff in rows:
        added = [
            line[1:].strip()
            for line in (diff or "").splitlines()
            if line.startswith("+") and not line.startswith("+++")
        ]
        added_text = " / ".join(text for text in added if text)
        rendered = (
            _neutralize_field(added_text, cap=LANDED_HISTORY_ENTRY_CHAR_CAP)
            if added_text
            else "(no added lines recorded)"
        )
        lines.append(f"- [{_neutralize_field(label)}] {rendered}")

    block = "\n".join(lines)
    if len(block) > char_cap:
        marker = f"\n[TRUNCATED: landed-history memory capped at {char_cap} chars]"
        block = block[: char_cap - len(marker)] + marker
    return block


def _live_failure_stats(agent: str) -> tuple[int, int] | None:
    """(negative-signal rows, total) for the agent over the rolling live window.

    A row counts when it trips ANY trigger OR-term (is_negative_signal_outcome —
    the same predicate the aggregator emits on, imported from the shared helper).
    read_outcomes_since applies the learning-signal exclusions server-side
    (attribution failures + poisoned_window rows), so the recompute never
    re-learns quarantined mis-measurements. None on PG-off / read error
    (fail-OPEN — caller keeps the patterns).
    """
    if not HAS_PG_OUTCOME_READ or not agent:
        return None

    since_epoch = time.time() - STALE_WINDOW_DAYS * 86400
    try:
        rows = _pg_read_outcomes_since(since_epoch, agent=agent)
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not skip
        sys.stderr.write(
            f"[daemon-cycle] staleness: PG read failed for agent={agent} — "
            f"fail-open: {type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None

    triggers = sum(1 for row in rows if _pg_is_negative_signal_outcome(row))
    return triggers, len(rows)


def _stale_reason(pattern_label: str, stats: tuple[int, int]) -> str:
    """'' when the live window still supports the pattern, else the skip reason.

    Families mirror the learning-aggregator.py emit conditions (current English
    labels + the legacy Korean rows still live in core.learning_log), both
    recomputed over the shared negative-signal trigger:
      - fail-count family (aggregator pattern 1) → live iff triggers >= 3;
      - fail-rate family (aggregator pattern 5)  → live iff total >= 3 AND
        triggers/total >= 0.5.
    Unknown family → '' (fail-open — never skip what we cannot recompute).
    """
    triggers, total = stats
    label = (pattern_label or "").strip()
    if label.startswith(_FAIL_COUNT_LABEL_PREFIXES):
        if triggers >= STALE_MIN_LIVE_TRIGGERS:
            return ""
        return (
            f"live negative-signal count {triggers} < {STALE_MIN_LIVE_TRIGGERS} "
            f"in last {STALE_WINDOW_DAYS}d (window total {total})"
        )
    if label.startswith(_FAIL_RATE_LABEL_PREFIXES):
        if total < STALE_MIN_SAMPLE:
            return (
                f"live sample {total} < {STALE_MIN_SAMPLE} in last "
                f"{STALE_WINDOW_DAYS}d"
            )
        rate = triggers / total
        if rate >= STALE_FAILURE_RATE_FLOOR:
            return ""
        return (
            f"live negative-signal rate {rate:.0%} < {STALE_FAILURE_RATE_FLOOR:.0%} "
            f"in last {STALE_WINDOW_DAYS}d ({triggers}/{total})"
        )
    return ""


def _covers_pattern_label(pattern_label: str, proposal_label: str) -> bool:
    """Numeric-stripped containment — matches legacy numeric proposal labels and
    the consolidated multi-signal label ("<agent> multi-signal consolidation (a / b)").

    Both sides are first canonicalized to the FAIL signature core (SOFT→FAIL) so the
    FAIL-anchored intake ``pattern_label`` and a remapped SOFT stored
    ``proposal_label`` still cover each other after the display decouple + data
    relabel (without it the reject-streak / non-auto-fixable gates would stop
    terminalizing pattern-1 rows → re-emit regression). G2-compliant: keyed on the
    stable FAIL literals, no signature rename.
    """
    canon_pattern = _canon_cover_label(pattern_label or "")
    needle = _PATTERN_NUMERIC_RE.sub("", canon_pattern).strip()
    if not needle:
        needle = canon_pattern.strip()
    if not needle:
        return False
    hay = _PATTERN_NUMERIC_RE.sub("", _canon_cover_label(proposal_label or ""))
    return needle in hay


def _warn_pattern_skip(
    agent: str,
    signature: str,
    event_ts: str,
    *,
    eval_result: str,
    reason: str,
) -> None:
    """Skipped/snoozed pattern → stderr WARN + loop-event emit, never silent.

    Same observability contract as _warn_roster_mismatch (Precondition
    Loud-Fail): eval_result rows in core.autoagent_loop_events surface the drop
    to the monitor; the stderr line carries the recompute / streak detail.
    """
    sys.stderr.write(
        f"[daemon-cycle] WARN: pattern {eval_result} — agent={agent} "
        f"({signature[:80]!r}): {reason}\n"
    )
    _invoke_pg_helper(
        {
            "op": "write_autoagent_loop_event",
            "args": {
                "event_ts": event_ts,
                "agent": agent[:64],  # varchar(64) guard — mirrors the aggregator
                "eval_result": eval_result,
                "changes_added": 0,
                "changes_removed": 0,
                "rice": None,
            },
        }
    )


# -- Applied-proposal discharge (pattern-first coverage resolution) ----------
#
# An applied proposal's patch lands but the core.learning_log rows it was
# generated from stay 'identified', so their frequency keeps growing and the
# same prose rule re-fires stricter every cycle. This stage resolves an applied
# proposal to the rows it covers and discharges them to terminal 'applied'.
#
# Resolution is PATTERN-FIRST: iterate the agent's stored rows (row ids already
# in hand) and ask _covers_pattern_label whether the proposal label covers each.
# Nothing is reconstructed from the label, so a constituent's nested parentheses
# sit inside the haystack instead of being parsed.

# Live transitioning is opt-in; dry-run is the default (file env convention).
DISCHARGE_LIVE_ENV = "AUTOAGENT_DISCHARGE_LIVE"
# Apply-side status-flip window. 2 days against a daily cycle = one cycle of
# overlap; a re-discharge is a no-op (the SQL terminal guard reports not-matched).
DISCHARGE_WINDOW_DAYS = int(
    os.environ.get("AUTOAGENT_DISCHARGE_WINDOW_DAYS", "2") or "2"
)

_APPLIED_FOR_DISCHARGE_SELECT_SQL = (
    "SELECT id, target_agent, pattern_label "
    "FROM core.autoagent_proposals "
    "WHERE status::text = 'applied' AND reviewed_at IS NOT NULL "
    "AND target_agent IS NOT NULL AND pattern_label IS NOT NULL "
    "AND reviewed_at > now() - make_interval(days => %s) "
    "ORDER BY reviewed_at DESC"
)


class DischargeReport(NamedTuple):
    """Outcome of one discharge stage — an outage is never an empty result."""

    outage: bool
    would_discharge: list[int]
    discharged: list[int]
    failed: list[int]
    unresolved: list[int]


def _canon_agent_key(agent: str) -> str:
    """Bare-stem key for an agent alias.

    Accumulated learning_log rows carry the bare stem ('dev-shell') while a
    proposal carries the prefixed one — the same bare↔prefixed alias resolution
    _get_roster_alias performs, minus the roster read. Narrowing on the raw
    string instead would silently drop the legacy bare-form rows.
    """
    stem = (agent or "").strip()
    if stem.startswith(_ROSTER_STEM_PREFIX):
        return stem[len(_ROSTER_STEM_PREFIX):]
    return stem


def get_pattern_rows_by_agent() -> dict[str, list[dict]] | None:
    """Untruncated core.learning_log intake rows indexed by bare agent key.

    Read ONCE per cycle and shared across every proposal in the window: several
    proposals commonly target the same agent, and a per-proposal read multiplies
    the query for no new information.

    Deliberately NOT read_user_pending_patterns' result — that list is
    roster-filtered (cross-cutting and roster-mismatch rows skipped) and
    agent-capped downstream, so a covered row outside it would never discharge,
    its frequency would keep growing, and it would re-fire.

    Helper import absent → None, reported by the caller as an OUTAGE. A read
    ERROR degrades upstream to [] (the intake module's own fail-open), so the
    applied-proposal read — which does return None — is the outage canary.
    """
    if not HAS_PG_PATTERN_READ:
        return None
    rows = _pg_read_pending_patterns()
    if rows is None:
        return None
    index: dict[str, list[dict]] = {}
    for row in rows:
        index.setdefault(_canon_agent_key(row.get("agent") or ""), []).append(row)
    return index


def find_covered_pattern_rows(
    proposal_label: str,
    agent: str,
    rows_by_agent: dict[str, list[dict]],
) -> list[int]:
    """Row ids of `agent`'s stored pattern rows that `proposal_label` covers.

    Reuses the shipped _covers_pattern_label matcher by name — the matcher
    already handles both the legacy numeric form and the consolidated
    multi-signal form, and already canonicalizes a display-remapped constituent
    back to its stored signature core.

    Resolution is PER-AGENT, which is what absorbs the forked legacy signature
    core: each agent's label was generated from that agent's own rows, so needle
    and haystack are always on the same side of the fork. Cross-fork containment
    is false in both directions by design — the shared matcher is NOT loosened
    to bridge it, because its three other consumers all terminalize on a match.

    A shape the matcher cannot resolve yields an empty list, never a guess.
    """
    covered: list[int] = []
    for row in rows_by_agent.get(_canon_agent_key(agent), ()):
        signature = row.get("pattern_signature") or ""
        # signature = "<label>|<agent>" (aggregator UPSERT contract).
        if _covers_pattern_label(signature.rsplit("|", 1)[0], proposal_label):
            covered.append(row["id"])
    return covered


def discharge_live_enabled() -> bool:
    """True only on an explicit opt-in — dry-run is the default."""
    return os.environ.get(DISCHARGE_LIVE_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _fetch_applied_for_discharge() -> list[tuple] | None:
    """(id, target_agent, pattern_label) for proposals applied inside the window.

    Deliberately not _fetch_applied_proposals: that one carries LIMIT 50 and the
    90-day outcome-read horizon, so reusing it would re-import on the proposal
    side the same silent truncation the untruncated pattern read exists to avoid.

    PG off / read error → None, which the caller reports as an OUTAGE, never as
    "nothing to discharge".
    """
    if not HAS_PG_LOOP_WRITE:
        return None
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_APPLIED_FOR_DISCHARGE_SELECT_SQL, (DISCHARGE_WINDOW_DAYS,))
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — outage, reported as such by caller
        sys.stderr.write(
            f"[daemon-cycle] discharge: applied-proposal read failed — "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def discharge_applied_patterns(
    applied_rows: list[tuple] | None,
    rows_by_agent: dict[str, list[dict]] | None,
    *,
    live: bool = False,
) -> DischargeReport:
    """Discharge the pattern rows covered by each proposal applied this window.

    Ambiguity discharges NOTHING: an unreadable input is an outage and an
    unresolvable label is a loud skip, so the stage can never fall back to
    terminalizing an agent's whole row set.
    """
    if applied_rows is None or rows_by_agent is None:
        sys.stderr.write(
            "[daemon-cycle] WARN: discharge SKIPPED this cycle — read outage "
            "(applied-proposal or pattern read unavailable); this is NOT "
            "'nothing to discharge', and no row was transitioned\n"
        )
        return DischargeReport(True, [], [], [], [])

    event_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000Z")
    would: list[int] = []
    discharged: list[int] = []
    failed: list[int] = []
    unresolved: list[int] = []

    for proposal_id, agent, label in applied_rows:
        covered = find_covered_pattern_rows(label or "", agent or "", rows_by_agent)
        if not covered:
            unresolved.append(proposal_id)
            _warn_pattern_skip(
                agent or "",
                label or "",
                event_ts,
                eval_result="discharge-unresolved",
                reason=(
                    f"applied proposal id={proposal_id} covers no stored pattern "
                    "row — label shape unrecognized, nothing discharged"
                ),
            )
            continue
        if not live:
            would.extend(covered)
            continue
        for row_id in covered:
            result = _pg_discharge_learning_pattern(
                row_id, f"discharged by applied proposal id={proposal_id}"
            )
            if result.outcome == DISCHARGE_APPLIED:
                discharged.append(row_id)
            elif result.outcome == DISCHARGE_FAILED:
                failed.append(row_id)
                sys.stderr.write(
                    f"[daemon-cycle] WARN: discharge transition failed — "
                    f"learning_log id={row_id} (proposal id={proposal_id}); the "
                    "call never completed, retried next cycle\n"
                )

    if live:
        sys.stderr.write(
            f"[daemon-cycle] discharge: {len(discharged)} row(s) transitioned "
            f"{sorted(discharged)}, {len(failed)} failed {sorted(failed)}, "
            f"{len(unresolved)} proposal(s) unresolved {sorted(unresolved)}\n"
        )
    else:
        sys.stderr.write(
            f"[daemon-cycle] discharge (dry-run, {DISCHARGE_LIVE_ENV} unset): "
            f"would-discharge {len(would)} row(s) {sorted(would)}; "
            f"{len(unresolved)} proposal(s) unresolved {sorted(unresolved)}\n"
        )
    return DischargeReport(False, would, discharged, failed, unresolved)


# -- Post-apply regression gate ---------------------------------------------
#
# alert_post_apply_regression() emits a 'post-apply-regression' loop event and
# stops there; the verdict had no consumer. This is that consumer: while a
# warning is live, the pattern rows the regressing proposal covered may not
# re-fire for that agent.
#
# The warning row carries only (event_ts, agent, eval_result) — no pattern and
# no proposal identity. Per-pattern granularity comes from the join the detector
# deliberately built: event_ts IS the proposal's own apply timestamp, so the
# warning resolves to its proposal by (timestamp, agent) and then to that
# proposal's covered rows through R4's resolver. Blocking by agent instead would
# be the whole-agent lockout this gate exists to avoid.

REGRESSION_LIVENESS_ENV = "AUTOAGENT_REGRESSION_LIVENESS_DAYS"
# How long ONE degradation observation still binds a decision — deliberately not
# PG_OUTCOME_LOOKBACK_DAYS, which is a data-read horizon sized so a rate sample
# has rows behind it. 14 days mirrors STALE_WINDOW_DAYS (2x the 7-day sustain
# window) and, against a daily cycle, is 14 chances for a fresh apply to re-raise
# a warning that still deserves to bind.
REGRESSION_LIVENESS_DAYS = int(
    os.environ.get(REGRESSION_LIVENESS_ENV, "14") or "14"
)
# Live exclusion is opt-in; dry-run is the default (file env convention).
REGRESSION_GATE_LIVE_ENV = "AUTOAGENT_REGRESSION_GATE_LIVE"

_REGRESSION_WARNINGS_SELECT_SQL = (
    "SELECT event_ts, agent "
    "FROM core.autoagent_loop_events "
    "WHERE eval_result = %s AND event_ts IS NOT NULL AND agent IS NOT NULL "
    "AND event_ts > now() - make_interval(days => %s) "
    "ORDER BY event_ts DESC"
)

# status 'reverted' is SELECTed, not filtered out: a human back-out releases the
# gate early, and the release is decided in python so it is testable.
_REGRESSION_PROPOSALS_SELECT_SQL = (
    "SELECT id, target_agent, reviewed_at, pattern_label, status::text "
    "FROM core.autoagent_proposals "
    "WHERE status::text IN ('applied', 'reverted') AND reviewed_at IS NOT NULL "
    "AND target_agent IS NOT NULL AND pattern_label IS NOT NULL "
    "AND reviewed_at > now() - make_interval(days => %s) "
    "ORDER BY reviewed_at DESC"
)


class RegressionGateReport(NamedTuple):
    """Gate verdict for one cycle — an indeterminate read is never an empty set."""

    indeterminate: bool
    blocked_rows: frozenset[int]
    entries: tuple[tuple[str, int, int], ...]  # (agent, row_id, warning_age_days)


def _as_utc(value: object) -> datetime | None:
    """UTC-aware datetime from a stored timestamp, or None when unparseable."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def find_regression_blocked_rows(
    warnings: list[tuple] | None,
    applied_rows: list[tuple] | None,
    rows_by_agent: dict[str, list[dict]] | None,
    *,
    now: datetime | None = None,
) -> RegressionGateReport:
    """Pattern rows bound by a LIVE regression warning, with each warning's age.

    Args:
        warnings: ``[(event_ts, agent), ...]`` post-apply-regression loop events.
        applied_rows: ``[(id, target_agent, reviewed_at, pattern_label, status), ...]``.
        rows_by_agent: the untruncated per-agent pattern index (R4's read).
        now: liveness reference instant (injected by tests).

    The fail direction is SPLIT and the split is the point: an INDETERMINATE
    verdict — an unreadable input or an unparseable timestamp — reports
    ``indeterminate`` and blocks every candidate that cycle, because there is no
    per-pattern verdict to key on. A CLEANLY ABSENT verdict (read succeeded, no
    warning) admits; absence is the normal state for most rows, so conflating
    the two would halt the loop entirely.

    A warning binds only while its proposal is inside REGRESSION_LIVENESS_DAYS,
    so the block is self-releasing without any actor having to act. A 'reverted'
    status releases earlier — an accelerator, never the only path.
    """
    if warnings is None or applied_rows is None or rows_by_agent is None:
        return RegressionGateReport(True, frozenset(), ())

    reference = now or datetime.now(timezone.utc)
    live_window_seconds = REGRESSION_LIVENESS_DAYS * 86400

    proposals: dict[tuple[datetime, str], list[tuple[str, str]]] = {}
    for _proposal_id, agent, reviewed_at, label, status in applied_rows:
        applied_ts = _as_utc(reviewed_at)
        if applied_ts is None:
            return RegressionGateReport(True, frozenset(), ())
        key = (applied_ts, _canon_agent_key(agent or ""))
        proposals.setdefault(key, []).append((label or "", status or ""))

    blocked: set[int] = set()
    entries: list[tuple[str, int, int]] = []
    for event_ts, agent in warnings:
        warned_at = _as_utc(event_ts)
        if warned_at is None:
            return RegressionGateReport(True, frozenset(), ())
        age_seconds = (reference - warned_at).total_seconds()
        if age_seconds >= live_window_seconds:
            continue
        age_days = int(age_seconds // 86400)
        for label, status in proposals.get(
            (warned_at, _canon_agent_key(agent or "")), ()
        ):
            if status != "applied":
                continue
            for row_id in find_covered_pattern_rows(label, agent or "", rows_by_agent):
                if row_id in blocked:
                    continue
                blocked.add(row_id)
                entries.append((agent or "", row_id, age_days))

    return RegressionGateReport(False, frozenset(blocked), tuple(entries))


def regression_gate_live_enabled() -> bool:
    """True only on an explicit opt-in — dry-run is the default."""
    return os.environ.get(REGRESSION_GATE_LIVE_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _fetch_regression_warnings() -> list[tuple] | None:
    """Post-apply regression loop events inside the liveness window, newest-first.

    PG off / read error → None, reported by the caller as INDETERMINATE.
    """
    if not HAS_PG_LOOP_WRITE:
        return None
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _REGRESSION_WARNINGS_SELECT_SQL,
                    (POST_APPLY_REGRESSION_EVAL_RESULT, REGRESSION_LIVENESS_DAYS),
                )
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — fail-CLOSED, reported by caller
        sys.stderr.write(
            f"[daemon-cycle] regression gate: warning read failed — "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def _fetch_proposals_for_regression_gate() -> list[tuple] | None:
    """Applied/reverted proposals inside the liveness window, newest-first.

    Deliberately not _fetch_applied_proposals: that one carries LIMIT 50 and the
    90-day outcome-read horizon, so a truncated read would silently un-block.
    PG off / read error → None, reported by the caller as INDETERMINATE.
    """
    if not HAS_PG_LOOP_WRITE:
        return None
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _REGRESSION_PROPOSALS_SELECT_SQL, (REGRESSION_LIVENESS_DAYS,)
                )
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — fail-CLOSED, reported by caller
        sys.stderr.write(
            f"[daemon-cycle] regression gate: proposal read failed — "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def build_regression_gate_report(
    rows_by_agent: dict[str, list[dict]] | None,
) -> RegressionGateReport:
    """Read this cycle's verdict once and publish its would-block set loudly."""
    report = find_regression_blocked_rows(
        _fetch_regression_warnings(),
        _fetch_proposals_for_regression_gate(),
        rows_by_agent,
    )
    live = regression_gate_live_enabled()
    if report.indeterminate:
        sys.stderr.write(
            "[daemon-cycle] WARN: regression gate INDETERMINATE — verdict read "
            "failed or returned an unparseable row. FAIL-CLOSED (this file's "
            "only inverted read: over-proposing is the disease, so a one-cycle "
            "pause errs safely): every candidate is blocked for THIS cycle "
            f"only{'' if live else ' (dry-run: nothing excluded)'}; the next "
            "cycle re-reads and admits normally\n"
        )
        return report

    members = ", ".join(
        f"agent={agent} row={row_id} warning_age={age}d"
        for agent, row_id, age in report.entries
    )
    sys.stderr.write(
        f"[daemon-cycle] regression gate "
        f"({'live' if live else f'dry-run, {REGRESSION_GATE_LIVE_ENV} unset'}): "
        f"would-block {len(report.blocked_rows)} row(s) [{members}]"
        f"{'' if live else '; nothing excluded this cycle'}\n"
    )
    return report


def drop_regression_blocked_patterns(
    agent: str,
    patterns: list[Pattern],
    report: RegressionGateReport,
    *,
    live: bool,
) -> list[Pattern]:
    """Drop this agent's patterns bound by a live regression warning.

    Dry-run keeps everything — the report is still published, since the deploy
    gate is checked against that would-block set. Nothing is terminalized: the
    block lapses when the warning ages out of the liveness window, so a pattern
    suppressed here returns on its own.
    """
    if not live:
        return patterns
    if report.indeterminate:
        sys.stderr.write(
            f"[daemon-cycle] WARN: regression gate blocked all {len(patterns)} "
            f"candidate(s) for agent={agent} — indeterminate verdict, THIS cycle "
            "only\n"
        )
        return []
    kept = [p for p in patterns if p.row_id not in report.blocked_rows]
    if len(kept) != len(patterns):
        sys.stderr.write(
            f"[daemon-cycle] regression gate: {len(patterns) - len(kept)} "
            f"pattern(s) blocked for agent={agent} — covered by a live "
            "post-apply regression warning\n"
        )
    return kept


# -- Attribution-confound signature -----------------------------------------
#
# "Patches applied, budget-overage rate unchanged" is the observable consequence
# of a signal that cannot name its actor: core.budget_overages carries the agent,
# the tool-use count, the budget and the crossing percentage, so an over-packed
# delegation and an undisciplined agent produce literally the same row. This
# makes that consequence computable per agent instead of invisible.
#
# Row shape follows the sibling regression detector exactly (Decision 6): the
# event table has no text payload and one decimal column, so the verdict rides
# the row while both rates ride the daemon log line.
#
# DETECTION-ONLY — it owns no gate and no transition, so no lockout is reachable
# from here; the only write is the loop event.

CONFOUND_SIGNATURE_EVAL_RESULT = "attribution-confound"  # VARCHAR(32) verdict
CONFOUND_WINDOW_ENV = "AUTOAGENT_CONFOUND_WINDOW_DAYS"
# Apply-window AND pre-window span. 14 days = 2x the 7-day sustain window, the
# same proportion the stale window uses, and enough days for a daily-cycle rate
# to have rows behind it on both sides of an apply.
CONFOUND_WINDOW_DAYS = int(os.environ.get(CONFOUND_WINDOW_ENV, "14") or "14")
# Relative fall in the per-day overage rate that counts as the patch working.
CONFOUND_MATERIAL_DROP = 0.20
# Below this much elapsed post-apply time a rate is an artifact of its divisor.
CONFOUND_MIN_POST_DAYS = 1.0

_APPLIED_FOR_CONFOUND_SELECT_SQL = (
    "SELECT target_agent, reviewed_at "
    "FROM core.autoagent_proposals "
    "WHERE status::text = 'applied' AND reviewed_at IS NOT NULL "
    "AND target_agent IS NOT NULL "
    "AND reviewed_at > now() - make_interval(days => %s) "
    "ORDER BY reviewed_at DESC"
)

_OVERAGE_ROWS_SELECT_SQL = (
    "SELECT agent_type, ts "
    "FROM core.budget_overages "
    "WHERE agent_type IS NOT NULL "
    "AND ts > now() - make_interval(days => %s)"
)


class ConfoundSignature(NamedTuple):
    """One agent's "patches landed, overage rate did not move" observation."""

    agent: str
    event_ts: datetime  # the agent's latest apply in the window — the dedup key
    applied_count: int
    pre_rate: float  # overage crossings per day before that apply
    post_rate: float  # overage crossings per day after it


def find_confound_signatures(
    applied_rows: list[tuple] | None,
    overage_rows: list[tuple] | None,
    *,
    now: datetime | None = None,
) -> tuple[ConfoundSignature, ...]:
    """Agents whose patches landed without a material fall in the overage rate.

    Args:
        applied_rows: ``[(target_agent, reviewed_at), ...]`` applied proposals.
        overage_rows: ``[(agent_type, ts), ...]`` core.budget_overages crossings.
        now: post-window end instant (injected by tests).

    An unreadable input yields NO signature: a detector that fabricates on a
    failed read manufactures the very evidence it exists to collect. An agent
    with no pre-apply crossing yields none either — there was nothing to reduce.
    """
    if applied_rows is None or overage_rows is None:
        return ()

    reference = now or datetime.now(timezone.utc)
    boundaries: dict[str, datetime] = {}
    applied_counts: dict[str, int] = {}
    display: dict[str, str] = {}
    for agent, reviewed_at in applied_rows:
        applied_ts = _as_utc(reviewed_at)
        if applied_ts is None:
            continue
        key = _canon_agent_key(agent or "")
        applied_counts[key] = applied_counts.get(key, 0) + 1
        display.setdefault(key, agent or "")
        latest = boundaries.get(key)
        if latest is None or applied_ts > latest:
            boundaries[key] = applied_ts

    crossings: dict[str, list[datetime]] = {}
    for agent, ts in overage_rows:
        crossed_at = _as_utc(ts)
        if crossed_at is None:
            continue
        crossings.setdefault(_canon_agent_key(agent or ""), []).append(crossed_at)

    found: list[ConfoundSignature] = []
    for key, boundary in boundaries.items():
        post_days = (reference - boundary).total_seconds() / 86400
        if post_days < CONFOUND_MIN_POST_DAYS:
            continue
        pre_start = boundary - timedelta(days=CONFOUND_WINDOW_DAYS)
        agent_crossings = crossings.get(key, ())
        pre_count = sum(1 for ts in agent_crossings if pre_start <= ts < boundary)
        post_count = sum(1 for ts in agent_crossings if boundary <= ts <= reference)
        pre_rate = pre_count / CONFOUND_WINDOW_DAYS
        post_rate = post_count / post_days
        if pre_rate <= 0:
            continue
        if post_rate < pre_rate * (1 - CONFOUND_MATERIAL_DROP):
            continue
        found.append(
            ConfoundSignature(
                display.get(key, key),
                boundary,
                applied_counts.get(key, 0),
                pre_rate,
                post_rate,
            )
        )
    return tuple(found)


def _fetch_applied_for_confound() -> list[tuple] | None:
    """(target_agent, reviewed_at) for proposals applied inside the window.

    Deliberately not _fetch_applied_proposals: that one carries LIMIT 50 and the
    90-day outcome-read horizon, so a truncated read would silently under-report
    which agents actually received a patch. PG off / read error → None, reported
    by the caller as an OUTAGE.
    """
    if not HAS_PG_LOOP_WRITE:
        return None
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_APPLIED_FOR_CONFOUND_SELECT_SQL, (CONFOUND_WINDOW_DAYS,))
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — outage, reported as such by caller
        sys.stderr.write(
            f"[daemon-cycle] confound signature: applied-proposal read failed — "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def _fetch_overage_rows() -> list[tuple] | None:
    """(agent_type, ts) budget crossings spanning both sides of the apply window.

    2x the window: an apply at the far edge still needs a full pre-window behind
    it. PG off / read error → None, reported by the caller as an OUTAGE.
    """
    if not HAS_PG_LOOP_WRITE:
        return None
    try:
        with _pg_connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_OVERAGE_ROWS_SELECT_SQL, (2 * CONFOUND_WINDOW_DAYS,))
                return cur.fetchall()
    except Exception as exc:  # noqa: BLE001 — outage, reported as such by caller
        sys.stderr.write(
            f"[daemon-cycle] confound signature: overage read failed — "
            f"{type(exc).__name__}: {str(exc)[:200]}\n"
        )
        return None


def alert_attribution_confound(*, now: datetime | None = None) -> None:
    """Emit one loop event per agent showing patches applied and the rate flat.

    Verdict on the row, both rates on the log line — the sibling detector's
    convention, and the only split the event table's columns can hold.
    """
    if not HAS_PG_LOOP_WRITE:
        return

    applied_rows = _fetch_applied_for_confound()
    overage_rows = _fetch_overage_rows()
    if applied_rows is None or overage_rows is None:
        sys.stderr.write(
            "[daemon-cycle] WARN: confound signature SKIPPED this cycle — read "
            "outage (applied-proposal or budget-overage read unavailable); this "
            "is NOT 'the rate did not move', and no event was emitted\n"
        )
        return

    for signature in find_confound_signatures(applied_rows, overage_rows, now=now):
        sys.stderr.write(
            f"[daemon-cycle] WARN: attribution confound — agent="
            f"{signature.agent} applied={signature.applied_count} patch(es) in "
            f"{CONFOUND_WINDOW_DAYS}d; budget-overage crossings per day "
            f"pre={signature.pre_rate:.3f} → post={signature.post_rate:.3f} "
            f"(no material reduction, threshold {CONFOUND_MATERIAL_DROP:.0%}); "
            "the overage row cannot name WHICH actor crossed the budget — an "
            "over-packed delegation and an undisciplined agent write the same "
            "row; DETECTION-ONLY — no gate, no transition, no status mutation\n"
        )
        _invoke_pg_helper(
            {
                "op": "write_autoagent_loop_event",
                "args": {
                    # Apply-timestamp key → the (event_ts, agent, eval_result)
                    # UPSERT lands every re-detection on the SAME row.
                    "event_ts": signature.event_ts.isoformat(),
                    "agent": signature.agent[:64],  # varchar(64) guard
                    "eval_result": CONFOUND_SIGNATURE_EVAL_RESULT,
                    "changes_added": 0,
                    "changes_removed": 0,
                    "rice": None,
                },
            }
        )


# -- Per-channel weekly done_with_concerns share watch ----------------------
#
# The emitter-criterion incident stepped both writer channels' weekly DWC share
# within one deploy day on an unchanged workload, and nothing in the loop could
# see it: the post-apply watch is keyed per applied proposal / per agent, so a
# contract-text change affecting EVERY writer at once falls between its windows.
# This watch is channel-keyed instead — the same grain as the tracking query in
# the remediation plan.
#
# DETECTION-ONLY, and deliberately on its OWN eval_result token: the post-apply
# token is consumed by the regression gate, so reusing it would silently turn a
# channel observation into a proposal-application block.

DWC_SHARE_ALARM_EVAL_RESULT = "dwc-share-regression"  # VARCHAR(32) verdict
# Writer-emitted provenance only — synthesized channels are DWC by construction.
DWC_SHARE_WRITER_CHANNELS = ("structuredoutput-completion", "hook-input")
DWC_SHARE_TRAILING_WEEKS = 4
DWC_SHARE_RELATIVE_MULTIPLE = 2.0
DWC_SHARE_ABSOLUTE_FLOOR = 0.25
# Per-week denominator floor, playing the role
# POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS plays in the sibling watch: a
# 1-row channel-week is a rate artifact, not a regression.
DWC_SHARE_MIN_WEEK_OBSERVATIONS = 5
# Trailing mean below which the doubling term is meaningless — 2x a near-zero
# baseline fires on noise, so only the absolute term applies down there.
DWC_SHARE_RELATIVE_MIN_BASELINE = 0.03


class DwcShareAlarm(NamedTuple):
    """One writer channel's weekly done_with_concerns share crossing a trigger."""

    channel: str
    week_start: datetime  # ISO-Monday bucket — the dedup key
    share: float
    baseline: float  # trailing-window mean, 0.0 when no week met the floor
    total: int
    dwc: int
    trigger: str  # "relative", "absolute", or "relative+absolute"


def _week_start(moment: datetime) -> datetime:
    """ISO-Monday midnight bucket, matching the tracking query's date_trunc('week')."""
    midnight = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight - timedelta(days=midnight.weekday())


def find_dwc_share_alarms(
    rows: list[dict] | None,
    *,
    now: datetime | None = None,
) -> tuple[DwcShareAlarm, ...]:
    """Writer channels whose current-week DWC share broke out of its own trend.

    Args:
        rows: outcome row dicts (attribution_source, record_ts, result), the
            shape _pg_read_outcomes_since returns.
        now: instant inside the week under test (injected by tests).

    Trigger: current-week share >= DWC_SHARE_RELATIVE_MULTIPLE x the trailing
    4-week mean, OR >= DWC_SHARE_ABSOLUTE_FLOOR. Both terms are denominator-
    guarded — a week below DWC_SHARE_MIN_WEEK_OBSERVATIONS is excluded from the
    current test and from the baseline, and the relative term needs a baseline
    of at least DWC_SHARE_RELATIVE_MIN_BASELINE. A naive record_ts borrows the
    reference tzinfo; a row without one cannot be bucketed and is skipped.
    """
    if not rows:
        return ()

    reference = now or datetime.now(timezone.utc)
    current_week = _week_start(reference)
    totals: dict[tuple[str, datetime], int] = {}
    concerned: dict[tuple[str, datetime], int] = {}
    for row in rows:
        channel = (row.get("attribution_source") or "").strip()
        if channel not in DWC_SHARE_WRITER_CHANNELS:
            continue
        record_ts = row.get("record_ts")
        if not isinstance(record_ts, datetime):
            continue
        if record_ts.tzinfo is None and reference.tzinfo is not None:
            record_ts = record_ts.replace(tzinfo=reference.tzinfo)
        key = (channel, _week_start(record_ts))
        totals[key] = totals.get(key, 0) + 1
        if (row.get("result") or "") == "done_with_concerns":
            concerned[key] = concerned.get(key, 0) + 1

    found: list[DwcShareAlarm] = []
    for channel in DWC_SHARE_WRITER_CHANNELS:
        total = totals.get((channel, current_week), 0)
        if total < DWC_SHARE_MIN_WEEK_OBSERVATIONS:
            continue
        dwc = concerned.get((channel, current_week), 0)
        share = dwc / total
        trailing: list[float] = []
        for weeks_back in range(1, DWC_SHARE_TRAILING_WEEKS + 1):
            past = (channel, current_week - timedelta(weeks=weeks_back))
            past_total = totals.get(past, 0)
            if past_total < DWC_SHARE_MIN_WEEK_OBSERVATIONS:
                continue
            trailing.append(concerned.get(past, 0) / past_total)
        baseline = sum(trailing) / len(trailing) if trailing else 0.0
        fired = [
            name
            for name, hit in (
                (
                    "relative",
                    baseline >= DWC_SHARE_RELATIVE_MIN_BASELINE
                    and share >= baseline * DWC_SHARE_RELATIVE_MULTIPLE,
                ),
                ("absolute", share >= DWC_SHARE_ABSOLUTE_FLOOR),
            )
            if hit
        ]
        if not fired:
            continue
        found.append(
            DwcShareAlarm(
                channel,
                current_week,
                share,
                baseline,
                total,
                dwc,
                "+".join(fired),
            )
        )
    return tuple(found)


def alert_dwc_share_regression(*, now: datetime | None = None) -> None:
    """Emit one loop event per writer channel whose weekly DWC share broke out.

    The event table has no channel column, so the channel rides `agent` as
    `channel:<provenance>` — a NON-agent use of that column the monitor surface
    will render as written.

    Denominator caveat: _pg_read_outcomes_since excludes attribution failures and
    poisoned-window rows inside the PG helper, so this share is NOT expected to
    equal the raw core.outcomes tracking query's percentage. It is a relative /
    absolute breakout watch, not a reproduction of that band.
    """
    if not HAS_PG_LOOP_WRITE or not HAS_PG_OUTCOME_READ:
        return

    reference = now or datetime.now(timezone.utc)
    # Trailing window + the partial current week, plus one bucket of slack.
    span_days = (DWC_SHARE_TRAILING_WEEKS + 2) * 7
    try:
        rows = _pg_read_outcomes_since(reference.timestamp() - span_days * 86400)
    except Exception as exc:  # noqa: BLE001 — fail-OPEN: read error must not alert
        sys.stderr.write(
            f"[daemon-cycle] WARN: DWC-share watch SKIPPED — outcome read failed "
            f"({type(exc).__name__}: {str(exc)[:160]}); this is NOT 'the share is "
            "flat', and no event was emitted\n"
        )
        return

    for alarm in find_dwc_share_alarms(rows, now=reference):
        sys.stderr.write(
            f"[daemon-cycle] WARN: done_with_concerns share regression — channel="
            f"{alarm.channel} week={alarm.week_start.date()} "
            f"share={alarm.share:.1%} ({alarm.dwc}/{alarm.total}) vs trailing "
            f"{DWC_SHARE_TRAILING_WEEKS}-week mean {alarm.baseline:.1%} "
            f"(trigger={alarm.trigger}; thresholds "
            f"{DWC_SHARE_RELATIVE_MULTIPLE:g}x mean OR "
            f"{DWC_SHARE_ABSOLUTE_FLOOR:.0%} absolute); the emitter's result "
            "criterion or its contract text is the first place to look; "
            "DETECTION-ONLY — no gate, no transition, no status mutation\n"
        )
        _invoke_pg_helper(
            {
                "op": "write_autoagent_loop_event",
                "args": {
                    # Week-bucket key → the (event_ts, agent, eval_result) UPSERT
                    # lands every re-detection of the same week on ONE row.
                    "event_ts": alarm.week_start.isoformat(),
                    "agent": f"channel:{alarm.channel}"[:64],  # varchar(64) guard
                    "eval_result": DWC_SHARE_ALARM_EVAL_RESULT,
                    "changes_added": 0,
                    "changes_removed": 0,
                    "rice": None,
                },
            }
        )


# -- Per-agent grouping -----------------------------------------------------


def _group_patterns_by_agent(
    patterns: list[Pattern],
    *,
    agent_cap: int,
) -> list[tuple[str, list[Pattern]]]:
    """Group patterns by .agent → list of (agent, [patterns]), agent cap applied.

    Group order = each agent's first-appearance order (input is freq DESC, so the
    highest-frequency agent comes first — high-freq priority when agent_cap < total
    agents). Within-group pattern order also preserves the input (freq DESC).

    Args:
        patterns: read_user_pending_patterns result (freq DESC).
        agent_cap: max agents to process (UNLIMITED_AGENTS = unlimited).

    Returns:
        list of (agent, patterns) tuples — at most agent_cap.
    """
    grouped: dict[str, list[Pattern]] = {}
    order: list[str] = []
    for p in patterns:
        if p.agent not in grouped:
            grouped[p.agent] = []
            order.append(p.agent)
        grouped[p.agent].append(p)
    capped = order if agent_cap >= UNLIMITED_AGENTS else order[:agent_cap]
    return [(agent, grouped[agent]) for agent in capped]


def _consolidated_pattern_label(agent: str, patterns: list[Pattern]) -> str:
    """Compute the consolidated proposal's pattern_label (schema/dedup/monitor compatible).

    - single pattern → that pattern's label as-is (preserve the simple case).
    - multiple patterns → "<agent> multi-signal consolidation (<distinct label join>)".
      distinct labels preserve input order (freq DESC), dedup, joined by ' / '.
      Truncated at 200 chars (PG column + monitor display protection).

    pattern_label is part of the dedup key (cycle_date, pattern_label,
    target_file), so one proposal per agent per cycle → key stable.
    """
    if not patterns:
        return f"{agent} multi-signal consolidation"
    # _remap_display_label is the SOLE display/persist mutation (D1): the persisted
    # pattern_label carries the accurate SOFT label when the pattern-1 FAIL literal
    # (EN+KO) is present, while Pattern.label itself stays FAIL for the anti-fossil
    # gates. Dedup keys on the RAW label so two FAIL-literal patterns collapse before
    # the single remap.
    if len(patterns) == 1:
        return _remap_display_label(patterns[0].label)
    seen: set[str] = set()
    distinct: list[str] = []
    for p in patterns:
        if p.label not in seen:
            seen.add(p.label)
            distinct.append(_remap_display_label(p.label))
    joined = " / ".join(distinct)
    label = f"{agent} multi-signal consolidation ({joined})"
    return label[:200]


# -- Top-level cycle --------------------------------------------------------


def _pg_import_degradation_lines() -> list[str]:
    """Loud degradation notices for any optional-PG import that failed at load.

    Returns one WARN line per failed optional import (empty list when both
    imported cleanly). Emitted once at run_cycle() start — the daemon's real
    entry — so a degraded PG layer is reported LOUDLY where it matters
    (Precondition Loud-Fail), while a bare CLI import of this module (which never
    calls run_cycle) stays silent per the CliExitContract clean-path contract.
    The captured exception carries the cause (e.g. missing psycopg) that the
    removed import-time stderr writes used to surface.
    """
    lines: list[str] = []
    if _PG_OUTCOME_IMPORT_EXC is not None:
        exc = _PG_OUTCOME_IMPORT_EXC
        lines.append(
            "[daemon-cycle] WARN: PG outcome/pattern read disabled (optional "
            f"dependency import failed): {type(exc).__name__}: {exc}\n"
        )
    if _PG_LOOP_IMPORT_EXC is not None:
        exc = _PG_LOOP_IMPORT_EXC
        lines.append(
            "[daemon-cycle] WARN: PG loop-event write disabled (optional "
            "dependency import failed; falling back to subprocess): "
            f"{type(exc).__name__}: {exc}\n"
        )
    return lines


def run_cycle(
    *,
    limit: int = DEFAULT_PATTERN_LIMIT,
    log_path: Path = DEFAULT_LEARNING_LOG,
    outcomes_dir: Path = DEFAULT_OUTCOMES_DIR,
    agents_dir: Path = DEFAULT_AGENTS_DIR,
    skip_haiku: bool = False,
    skip_pre_verify: bool = False,
    skip_loop_emit: bool = False,
) -> CycleReport:
    """Full generation + pre-verify cycle — pattern → outcomes → patch proposal →
    classification → pre-verify (4-axis) → routing hints.

    Returns the in-memory CycleReport. Caller decides where to persist it.

    Pre-verify:
    Each patch classified as `body-auto` is routed through `run_pre_verify`.
    The verdict is attached to PatchResult and used to fill `approval_tier` /
    `status` so the PG emit layer can route unverified patches to the user
    pending queue without needing its own LLM call.
    """
    now = datetime.now(timezone.utc)
    # Optional-PG import degradation — surfaced LOUDLY once at daemon-cycle start
    # (Precondition Loud-Fail). The import-time stderr writes were removed so a
    # bare CLI import of this module stays silent; run_cycle() is the daemon's
    # real entry, so a degraded PG layer is reported here, before the first PG op.
    for _warn_line in _pg_import_degradation_lines():
        sys.stderr.write(_warn_line)
    # GENERATION window = previous calendar day (LOCAL tz), shared by all agents in
    # the cycle — computed once outside the loop (cycle-invariant). Distinct from
    # the promotion-stats window.
    gen_day_bounds = _local_day_bounds()
    agent_cap = _resolve_agent_limit(limit)
    report = CycleReport(
        cycle_date=now.strftime("%Y-%m-%d"),
        generated_at=now.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        patterns_processed=0,
        cost_guard={
            # Per-target: 1 Haiku call per agent → max_haiku_calls = agent cap.
            # Informational only (not a gate).
            "max_haiku_calls": agent_cap,
            "agent_cap": agent_cap,
            "haiku_max_budget_usd_per_call": HAIKU_MAX_BUDGET_USD,
            "pre_verify_max_budget_usd_per_call": PRE_VERIFY_MAX_BUDGET_USD,
            "skip_haiku": str(skip_haiku),
            "skip_pre_verify": str(skip_pre_verify),
        },
    )

    # per-TARGET (agent) flow: 1) read all user-pending patterns (agent cap applies
    # to agents, not patterns, so no slicing here) → 2) group by .agent → 3) apply
    # agent cap → 4) one consolidated multi-hunk proposal per agent.
    # Discharge first: a pattern whose patch already landed must not seed this
    # cycle's intake. Dry-run by default — live transitioning is opt-in.
    # One untruncated pattern read serves both consumers — the discharge and the
    # regression gate ask the same coverage question of the same rows.
    pattern_rows_by_agent = get_pattern_rows_by_agent()
    discharge_applied_patterns(
        _fetch_applied_for_discharge(),
        pattern_rows_by_agent,
        live=discharge_live_enabled(),
    )
    regression_gate = build_regression_gate_report(pattern_rows_by_agent)
    patterns = read_user_pending_patterns(
        log_path, UNLIMITED_AGENTS, agents_dir=agents_dir
    )
    report.patterns_processed = len(patterns)
    agent_groups = _group_patterns_by_agent(patterns, agent_cap=agent_cap)

    # Confidence-weighted promotion ladder gate, 3-state (fail-CLOSED).
    # active → run classify_promotion_tier (floor applies).
    # bypass (explicit flag false) → floorless (promotion_tier="" — operator OFF
    # preserved). floor (lib-fail / flags absent — default+failure states) → set
    # promotion_tier='mention' so the apply-side `IS DISTINCT FROM 'mention'`
    # EXCLUDES every row (absent-config = safe). project_key is
    # cycle-invariant — resolve once outside the loop (active state only).
    promotion_state = confidence_filter_state()
    promotion_enabled = promotion_state == "active"
    cycle_project_key = resolve_project_key().key if promotion_enabled else ""

    # Loud-fail visibility (shared-self-improve-hygiene Precondition Loud-Fail) —
    # once per cycle, outside the per-agent loop. Distinguish BYPASS (explicit
    # operator OFF → genuinely floorless) from FLOOR (default/failure → rows
    # floored to 'mention', apply-side excludes them) so the operator sees which.
    if promotion_state == "bypass":
        sys.stderr.write(
            "[daemon-cycle] WARN: confidence floor BYPASS "
            f"({_CONFIDENCE_FLAG_KEY} explicitly false) — low-confidence patterns "
            "are NOT floored; the apply-side promotion_tier='mention' gate passes "
            "all rows this cycle (explicit operator opt-out)\n"
        )
    elif promotion_state == "floor":
        sys.stderr.write(
            "[daemon-cycle] WARN: confidence floor FLOOR "
            f"({_CONFIDENCE_FLAG_KEY} unset / flags absent / lib unavailable) — "
            "fail-CLOSED: every row floored to promotion_tier='mention'; the "
            "apply-side gate EXCLUDES all rows from auto-apply this cycle\n"
        )

    # T3 corpus/compliance telemetry — DETECTION-ONLY, fired ONCE per cycle.
    # Fully wrapped: any failure is swallowed so it can NEVER block or raise into
    # the cycle (established fail-soft policy). Skipped under skip_loop_emit
    # (no-PG-write / unit-test mode) like the other observation emits below.
    if not skip_loop_emit:
        try:
            corpus_signal = audit_corpus_size(
                rules_dir=DEFAULT_RULES_DIR,
                global_rules_file=GLOBAL_RULES_FILE,
                agents_dir=DEFAULT_AGENTS_DIR,
            )
        except Exception as exc:  # noqa: BLE001 — telemetry must never break the cycle
            sys.stderr.write(
                "[daemon-cycle] WARN: audit_corpus_size raised — corpus telemetry "
                f"lost: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
        else:
            # Sink status is BRANCHED on, not absorbed: a False routes the loss
            # through record_sink_degradation (named WARN + named channel) and the
            # cycle continues.
            emit_corpus_audit(corpus_signal, report.cycle_date)

    seen_targets: set[str] = set()
    # AD-10 Solution History accumulator — one SolutionAttempt per generation
    # outcome, pruned to the Pareto frontier after the loop (retain_pareto_winners).
    solution_attempts: list[SolutionAttempt] = []
    for agent, agent_patterns in agent_groups:
        # Anti-fossil lifecycle gates — BEFORE any outcome fetch / Haiku spend.
        # All five gates write PG (learning_log transition + skip loop events),
        # so they run only in full-real mode: skip_haiku (test/preflight) bypasses
        # them like the timeout back-off below, skip_loop_emit (no-PG-write
        # mode) bypasses them like the supersede. Order matters — the four
        # terminalizing gates (reverted, reject-streak, repeat-apply-cap,
        # non-auto-fixable) run before the transient staleness snooze; reverted
        # runs FIRST (a human back-out outranks every generation-side verdict).
        # repeat-apply-cap follows reject-streak because an 'applied' row RESETS
        # that streak: the alternating apply/reject fossil is invisible to the
        # streak gate and is exactly what the cap exists to catch.
        if not skip_haiku and not skip_loop_emit:
            # One shared fetch serves both proposal-history gates (neither
            # mutates rows). None (PG off / read error) → skip both, matching
            # each gate's own fail-open branch without a doomed re-fetch.
            history_rows = _fetch_proposal_history(agent)
            if history_rows is not None:
                agent_patterns = drop_reverted_patterns(
                    agent, agent_patterns, rows=history_rows
                )
                agent_patterns = drop_reject_streak_patterns(
                    agent, agent_patterns, rows=history_rows
                )
                agent_patterns = drop_apply_capped_patterns(
                    agent, agent_patterns, rows=history_rows
                )
            agent_patterns = drop_non_auto_fixable_patterns(agent, agent_patterns)
            agent_patterns = drop_stale_patterns(agent, agent_patterns)
            # Non-terminalizing and reversible: the block lapses with the warning.
            agent_patterns = drop_regression_blocked_patterns(
                agent,
                agent_patterns,
                regression_gate,
                live=regression_gate_live_enabled(),
            )
            if not agent_patterns:
                continue
        # GENERATION outcomes = all of yesterday (no sample cap) — separate from promotion stats.
        outcomes = fetch_generation_outcomes(
            agent,
            day_bounds=gen_day_bounds,
            outcomes_dir=outcomes_dir,
        )
        # AD-10 Solution History: bridge each generation outcome into a
        # SolutionAttempt (OPRO 3-tuple + reflective signal). applied_date is the
        # cycle day — the outcomes share the generation window, so recency is a
        # per-cycle constant here; cross-cycle recency spread arrives with the
        # durable store (deferred, see below). directive_hint is not on the
        # Outcome dataclass, so it defaults empty.
        solution_attempts.extend(
            solution_attempt_from_outcome(outcome, report.cycle_date)
            for outcome in outcomes
        )
        # Chronic Haiku-timeout back-off (generation side) — BEFORE the Haiku call.
        # A target that already timed out TIMEOUT_BACKOFF_THRESHOLD consecutive
        # times re-selects from core.learning_log every cycle with no memory of
        # those failures; without this gate it burns a fresh HAIKU_TIMEOUT_SEC call
        # and re-emits the 'partial'-causing error indefinitely. Skip the Haiku call
        # entirely and emit a loud, persisted back-off record instead. skip_haiku
        # (test/preflight) bypasses the gate — no real generation happens there.
        target_md = agents_dir / f"{agent}.md"
        timeout_streak = (
            0 if skip_haiku else consecutive_timeout_count(str(target_md))
        )
        is_backoff_skip = timeout_streak >= TIMEOUT_BACKOFF_THRESHOLD
        if is_backoff_skip:
            # Self-lock guard: the streak's own break condition is produced only
            # by the call this branch suppresses, so a bounded hold opens for one
            # cycle and lets that call happen. Read only here — the rare path.
            backoff_state = read_backoff_state(str(target_md))
            if backoff_state.probe_due:
                is_backoff_skip = False
                sys.stderr.write(
                    f"[daemon-cycle] timeout-backoff: agent={agent} held "
                    f"{backoff_state.held_cycles} consecutive cycles "
                    f"(bound {TIMEOUT_BACKOFF_PROBE_CYCLES}) — admitting ONE probe "
                    f"generation (streak {timeout_streak}, "
                    f"{backoff_state.superseded_skipped} row(s) looked past as "
                    f"recorded under a superseded ceiling).\n"
                )
        if is_backoff_skip:
            sys.stderr.write(
                f"[daemon-cycle] timeout-backoff: agent={agent} target={target_md.name} "
                f"reached {timeout_streak} consecutive haiku timeouts "
                f"(threshold {TIMEOUT_BACKOFF_THRESHOLD}) — SKIP generation "
                f"(no Haiku call, snoozed). Recovers on the next non-timeout cycle.\n"
            )
            proposal = backoff_skip_proposal(str(target_md), timeout_streak)
        else:
            proposal = generate_consolidated_proposal(
                agent,
                agent_patterns,
                outcomes,
                agents_dir=agents_dir,
                skip_haiku=skip_haiku,
            )
            # Intra-cycle spacing (FIX #5): a small sleep after each REAL Haiku
            # call so the per-agent loop does not self-contend its shared
            # OAuth/usage window (effective concurrency cap of 1 with a gap).
            # Bounded + cheap; skipped on test/preflight (skip_haiku) and the
            # back-off branch (no real call there). 0 disables.
            if not skip_haiku and INTER_CALL_SPACING_SEC > 0:
                time.sleep(INTER_CALL_SPACING_SEC)
        # Lead pattern = group head (freq DESC) — feeds the date / single-pattern
        # context for pre-verify / promotion (the label is computed separately).
        lead_pattern = agent_patterns[0]
        consolidated_label = _consolidated_pattern_label(agent, agent_patterns)

        target_path = Path(proposal.target_file)
        classification = classify_patch_area(
            proposal,
            target_path,
            seen_targets=seen_targets,
            agents_dir=agents_dir,
        )
        # Track only successfully-resolved targets for conflict detection.
        if classification != "reject" or proposal.proposed_diff.strip():
            seen_targets.add(str(target_path.resolve()))

        # Map proposal.parse_mode to haiku_status so cycle JSON shows the
        # explicit recovery path. NO silent coerce — fuzzy/retried states
        # surface distinctly from strict happy path.
        #
        # parse_mode='quota-limit' → haiku_status='skipped:quota-limit'. Branch
        # ordering: quota check comes BEFORE empty-diff fallback because quota
        # always yields empty diff (would otherwise collapse to empty-or-error
        # and lose the budget-exhaustion signal in monitor dashboard).
        if skip_haiku:
            haiku_status = "skipped:test"
        elif is_backoff_skip:
            # Chronic-timeout back-off — distinct status so the monitor dashboard
            # can flag a backed-off candidate vs. a generic empty/error. Branch
            # FIRST among the non-test cases (it always yields an empty diff and
            # must not collapse into 'skipped:empty-or-error').
            haiku_status = "skipped:chronic-timeout-backoff"
        elif proposal.parse_mode == "budget-too-low":
            # Local budget-config failure — distinct from external quota. Like quota,
            # it always yields an empty diff, so branch before empty-or-error to
            # preserve the signal.
            haiku_status = "skipped:budget-too-low"
        elif proposal.parse_mode == "quota-limit":
            haiku_status = "skipped:quota-limit"
        elif proposal.parse_mode == "transient-overload":
            # Transient infra blip (Overloaded / 529 / connection reset / timeout)
            # whose bounded retries were exhausted. Always an empty diff, so branch
            # before empty-or-error to keep the infra-blip signal distinct from a
            # genuinely empty / parse-failed output in the monitor dashboard.
            haiku_status = "skipped:transient"
        elif proposal.parse_mode == "auth-failure":
            # 401/credential failure (expired non-interactive OAuth token). Always
            # an empty diff, so branch before empty-or-error to keep the auth
            # signal distinct from a genuinely empty / parse-failed output — the
            # monitor cost-guard chip reads this to show "Auth fault", not a
            # spending warning.
            haiku_status = "skipped:auth"
        elif proposal.parse_mode == "timeout-stall":
            # Escalated-retry timeout — a TRUE stall (even the longer bound
            # produced nothing), distinct from a slow generation that completed.
            # Always an empty diff → branch before empty-or-error so the stall
            # stays queryable.
            haiku_status = "skipped:timeout-stall"
        elif not proposal.proposed_diff:
            haiku_status = "skipped:empty-or-error"
        elif proposal.parse_mode == "escalated":
            # Legacy tag — no longer produced, kept so a persisted or out-of-tree
            # shape still resolves instead of collapsing into the plain 'ok' else.
            haiku_status = "ok:escalated"
        elif proposal.parse_mode == "retried":
            haiku_status = "ok:retried"
        elif proposal.parse_mode == "fuzzy":
            haiku_status = "ok:fuzzy-parsed"
        else:
            haiku_status = "ok"

        # Second axis: a clean parse at the escalated bound is slow generation,
        # not a stall. Suffix-composed so the parse path above survives it.
        haiku_status = build_escalated_haiku_status(
            haiku_status, escalated_timeout=proposal.escalated_timeout
        )

        # Pre-verify gate. Only body-auto candidates pay the LLM cost;
        # frontmatter-dryrun is already user-bound, reject is a no-op.
        #
        # 2-tier (auto/safety) branch logic:
        #   - safety match           → approval_tier='safety', status='pending'
        #   - verified non-safety    → approval_tier='auto',   status='pending'
        #   - unverified non-safety  → classification flipped to 'reject',
        #                              approval_tier='', status='' (auto-reject;
        #                              quality issue absorbed by the impl-retry
        #                              upstream — user queue is NOT a fallback)
        #
        # A pre-verify fail without a safety match signals a quality issue, not an
        # authorization gap.
        if classification == "body-auto":
            verify = run_pre_verify(
                proposal,
                lead_pattern,
                skip_pre_verify=skip_pre_verify or skip_haiku,
            )
            safety_flag = classify_safety_tier(proposal)
            if safety_flag == "safety":
                # Safety override — always queue for explicit user approval,
                # regardless of pre-verify verdict (security-first per
                # core-security.md High-impact actions).
                approval_tier = "safety"
                status_value = "pending"
                # Loud WARN when a diff-embedded hazard recipe reached the safety
                # gate (Precondition Loud-Fail — never silent). Only a diff trigger
                # warns: a path/frontmatter safety hit is self-evident from the
                # target, whereas the diff pattern that caught the hazard is not.
                diff_hit = match_sensitive_diff(proposal.proposed_diff)
                if diff_hit is not None:
                    sys.stderr.write(
                        f"[daemon-cycle] WARN: safety-diff match — agent={agent} "
                        f"target={proposal.target_file} pattern=/{diff_hit}/ → "
                        "routed to Tier-2 user-approval queue (NOT auto-applied).\n"
                    )
            elif verify.passed:
                approval_tier = "auto"
                status_value = "pending"  # apply stage flips this to 'applied'
            else:
                # Pre-verify did NOT pass. Distinguish a GENUINE quality verdict
                # (the verifier ran and refused the candidate → auto-reject) from
                # an INFRA non-adjudication (verifier timeout / CLI-missing /
                # non-zero exit → the candidate was never adjudicated). Recording
                # an infra OUTAGE as a terminal 'rejected' carries the GENERATOR
                # rationale, which the kill-streak classifier reads as a quality
                # reject → the consecutive_reject streak fossilizes healthy agents
                # on an infra night (DF-6). Route infra failures to 'pending'
                # (re-verified next cycle) so the streak is untouched.
                #
                # For a genuine quality reject: persist 'rejected' explicitly — an
                # empty sentinel was coerced to 'pending' downstream, fossilizing
                # auto-reject rows at pending. The Haiku retry already absorbed the
                # recoverable subset upstream, so this residual should NOT block
                # user attention (the user queue is NOT a quality fallback).
                classification, approval_tier, status_value = route_failed_pre_verify(
                    classification, verify.status
                )
                if status_value == "pending":
                    sys.stderr.write(
                        "[daemon-cycle] WARN: pre-verify INFRA failure "
                        f"(status={verify.status}) for agent={agent} "
                        f"target={proposal.target_file} — row left pending, NOT a "
                        "quality reject (consecutive_reject streak untouched)\n"
                    )
        elif classification == "frontmatter-dryrun":
            # Frontmatter identity (name / tools / scope / etc.) is a safety trigger
            # (LLM06 Excessive Agency). Surface as safety tier; pre-verify is
            # skipped since the dryrun bucket already gates on human review.
            verify = None
            approval_tier = "safety"
            status_value = "pending"
        elif is_backoff_skip:
            # Chronic-timeout back-off — persist as 'snoozed' (reusing the existing
            # ProposalStatus enum, same terminal-but-recoverable semantics as the
            # apply-side stale-drain). 'snoozed' (not 'rejected') keeps the row
            # visible as a backed-off candidate distinct from a quality reject. The
            # auto-batch apply path (daemon-apply.sh extract_backlog_patches) excludes
            # this row because it fails ALL THREE of that SELECT's predicates:
            # approval_tier='auto' / pre_verify_passed=true / status='pending' — the
            # back-off row carries approval_tier='', pre_verify_passed=NULL,
            # status='snoozed', so no empty diff is ever auto-applied.
            verify = None
            approval_tier = ""
            status_value = "snoozed"
        else:
            # 'reject' classification — no further gating. Persist 'rejected'
            # explicitly (an empty sentinel was coerced to 'pending' → fossilized).
            verify = None
            approval_tier = ""
            status_value = "rejected"

        # Confidence-weighted promotion ladder. Gate-OFF (flag false / lib missing)
        # → defaults preserve the pre-feature behavior. Gate-ON → Beta-Binomial
        # posterior (empirical signal) + observation count + 7-day sustain →
        # promotion tier. project_key tags the row for per-project isolation.
        #
        # The promotion-stats window is separate from the GENERATION window — the
        # Beta-Binomial ladder needs historical depth, so it is NOT moved to
        # yesterday-only. _fetch_promotion_stats keeps its own 90-day lookback:
        # posterior sample capped at OUTCOME_SAMPLE_LIMIT, observation_count
        # uncapped (decoupled — a capped n could never reach the candidate
        # floor, silently disabling unattended auto-apply).
        # 3-state promotion_tier (fail-CLOSED):
        #   active → classify_promotion_tier (posterior-derived tier; floor applies).
        #   floor  → 'mention' (default/failure → apply-side `IS DISTINCT FROM
        #            'mention'` EXCLUDES the row → nothing low-confidence auto-applies).
        #   bypass → "" (operator OFF → apply-side passes the row, floorless).
        confidence_observed: float | None = None
        if promotion_state == "active":
            signals, observation_count = _fetch_promotion_stats(agent)
            # record_ts is preserved in signals, but time-decay activation
            # (lambda_per_day<1) is DEFERRED → default λ=1.0 = legacy posterior.
            confidence_observed = compute_confidence_observed(signals)
            promotion_tier = classify_promotion_tier(
                confidence_observed=confidence_observed,
                observation_count=observation_count,
                sustained=_is_sustained(lead_pattern.date),
                touches_frontmatter=proposal.touched_frontmatter,
            )
        elif promotion_state == "floor":
            promotion_tier = "mention"
        else:  # bypass — explicit operator OFF, floorless (preserved pre-feature).
            promotion_tier = ""

        # Floor terminalization — close the auto+pending+mention limbo at the
        # SOURCE so every auto-tier candidate reaches a terminal state this cycle.
        # An apply-ineligible auto candidate ('mention') would otherwise sit
        # pending forever (apply excludes it; auto-tier is not a safety-queue
        # candidate), fossilizing as a standing "New suggestions" pile. Safety tier
        # is untouched (approval_tier='safety' → gate is auto-only) — the human
        # queue is preserved.
        terminalize = resolve_floor_terminalization(
            classification=classification,
            approval_tier=approval_tier,
            status_value=status_value,
            promotion_tier=promotion_tier,
            rationale=proposal.rationale,
        )
        classification = terminalize.classification
        approval_tier = terminalize.approval_tier
        status_value = terminalize.status_value
        effective_rationale = terminalize.rationale
        if terminalize.terminalized:
            sys.stderr.write(
                "[daemon-cycle] INFO: floor terminalize — auto candidate for "
                f"agent={agent} target={proposal.target_file} resolved to "
                f"promotion_tier='{promotion_tier}' (auto-apply ineligible); "
                "persisted status='rejected' instead of auto-pending limbo\n"
            )

        # T4 prose-only-add detection — DETECTION-ONLY WARNING per candidate patch
        # diff (added>0, removed==0, no hook file touched). It NEVER rejects the
        # patch; it only produces a warning verdict, PERSISTED on the proposal row.
        prose_only_add: bool | None = None
        if proposal.proposed_diff:
            try:
                prose_only_add = bool(
                    classify_prose_only_add(
                        proposal.proposed_diff,
                        target_file=str(proposal.target_file),
                    )["warning"]
                )
            except Exception as exc:  # noqa: BLE001 — branched below, never absorbed
                # Same named-channel treatment as the corpus-audit emit: the lost
                # measurement is enumerable afterwards, and the cycle continues.
                record_sink_degradation("patch_classification", exc)
        if not skip_loop_emit and proposal.proposed_diff:
            # Deterministic reference-resolution guard — WARNS on an added line
            # that cites an unresolved ~/.claude/*.md or rules/*.md pointer (the
            # C1-C4 LLM verifier does no on-disk existence check). Detection-only.
            try:
                classify_dead_reference(
                    proposal.proposed_diff, target_file=str(proposal.target_file)
                )
            except Exception as exc:  # noqa: BLE001 — detection must never break the cycle
                sys.stderr.write(
                    "[daemon-cycle] WARN: classify_dead_reference raised — reference "
                    f"resolution lost: {type(exc).__name__}: {str(exc)[:160]}\n"
                )

        # Same-agent supersede — only when the new proposal is an actual emit
        # target (pending), terminate the agent's OTHER pending rows (block
        # backlog re-accumulation). The skip_loop_emit (test/preflight) path does
        # not touch PG → supersede also skipped. A floor-terminalized row is now
        # 'rejected', so it correctly does NOT trigger supersede as a fresh emit.
        # The cycle date + consolidated label are the identity this run's own push
        # will update, so they are what the supersede must spare.
        if status_value == "pending" and not skip_loop_emit:
            supersede_prior_pending_for_agent(
                agent,
                proposal.target_file,
                cycle_date=report.cycle_date,
                pattern_label=consolidated_label,
            )

        report.patches.append(
            PatchResult(
                pattern_label=consolidated_label,
                pattern_agent=agent,
                pattern_frequency=lead_pattern.frequency,
                target_file=proposal.target_file,
                classification=classification,
                rationale=effective_rationale,
                proposed_diff=proposal.proposed_diff,
                outcomes_sampled=len(outcomes),
                haiku_status=haiku_status,
                # Accurate count from the FULL diff (proposed_diff is truncated
                # to 4000 chars → cannot be re-derived without under-reporting).
                estimated_added_lines=proposal.estimated_added_lines,
                estimated_removed_lines=proposal.estimated_removed_lines,
                # error drives the cycle 'partial' status (_pg_push_autoagent_cycle.py
                # saw_error). A chronic-timeout back-off is an INTENTIONAL bounded
                # skip, NOT a cycle error — leave error empty so a backed-off
                # candidate stops flipping every cycle to 'partial' (the rationale is
                # still persisted on the proposal row + emitted to stderr for
                # observability). The non-backoff timeout (streak < threshold) keeps
                # surfacing as an error so the first N timeouts remain visible.
                error=(
                    ""
                    if proposal.proposed_diff or skip_haiku or is_backoff_skip
                    else proposal.rationale
                ),
                pre_verify_passed=verify.passed if verify is not None else None,
                pre_verify_status=verify.status if verify is not None else "",
                pre_verify_rationale=verify.rationale if verify is not None else "",
                pre_verify_axes=_compose_pre_verify_axes(
                    verify.axes if verify is not None else None, prose_only_add
                ),
                pre_verify_latency_ms=verify.latency_ms if verify is not None else 0,
                approval_tier=approval_tier,
                status=status_value,
                confidence_observed=confidence_observed,
                project_key=cycle_project_key,
                promotion_tier=promotion_tier,
                # Carry the structured Haiku-failure evidence from the proposal
                # into the SERIALIZED row. Without this copy the dataclass
                # defaults ('' / None) reach PG → failure_class stays empty and
                # the cost-guard badge never lights (the live failure_class=['','']
                # symptom). raw_response head is redacted (a 401 stream may echo a
                # token) and bounded to 400 chars.
                failure_class=proposal.failure_class,
                failure_returncode=proposal.failure_returncode,
                failure_signal=proposal.failure_signal,
                failure_duration_ms=proposal.failure_duration_ms,
                failure_attempt=proposal.failure_attempt,
                failure_probe_result=proposal.failure_probe_result,
                failure_log_path=proposal.failure_log_path,
                failure_raw_head=redact_secrets(proposal.raw_response[:400]),
                # Same explicit-copy duty as the failure_* block above — an omitted
                # mirror silently reaches PG as the dataclass default.
                generation_duration_ms=proposal.generation_duration_ms,
            )
        )

    # Just before cycle end, UPSERT the loop_event row directly to PG.
    # skip_loop_emit=True → block the PG call in unit-test / preflight paths.
    # patches=[] (patterns_processed=0) → _aggregate_loop_events returns [] → no-op.
    if not skip_loop_emit:
        try:
            alert_all_reject_streak(report)
        except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
            sys.stderr.write(
                "[daemon-cycle] WARN: alert_all_reject_streak raised — alert "
                f"lost: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
        # Loud-Fail compliance: a systemic zero-output regression must NOT exit
        # clean. is_systemic_regression keeps the quiet-night discriminator
        # (patches=[] → ok), so only a real regression flips the status →
        # _main returns CYCLE_REGRESSION_EXIT_CODE.
        try:
            if is_systemic_regression(report):
                report.cycle_status = "regression"
                sys.stderr.write(
                    "[daemon-cycle] CRIT: systemic zero-output regression — this "
                    "cycle ingested input and rejected ALL of it, with a "
                    "corroborating crit (all-reject streak >= "
                    f"{ALL_REJECT_ALERT_THRESHOLD} OR days-since-applied > "
                    f"{DAYS_SINCE_APPLIED_CRIT_THRESHOLD}); cycle marked "
                    "'regression' → non-clean exit\n"
                )
        except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
            sys.stderr.write(
                "[daemon-cycle] WARN: is_systemic_regression raised — regression "
                f"status not set: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
        # C1 post-apply regression watch — DETECTION-ONLY sibling of the
        # systemic check above: same next-cycle observability family, opposite
        # target (this one watches proposals that DID land). Emits its own
        # loop events, so it rides the same skip_loop_emit gate.
        try:
            alert_post_apply_regression()
        except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
            sys.stderr.write(
                "[daemon-cycle] WARN: alert_post_apply_regression raised — "
                f"watch lost: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
        # Second-order sibling: the regression watch above asks whether a landed
        # patch made things worse; this one asks whether it changed anything at
        # all on the signal that drove it.
        try:
            alert_attribution_confound()
        except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
            sys.stderr.write(
                "[daemon-cycle] WARN: alert_attribution_confound raised — "
                f"signature lost: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
        # Third sibling, channel-keyed rather than proposal-keyed: a contract-text
        # change moves every writer at once, which the per-proposal windows above
        # cannot see.
        try:
            alert_dwc_share_regression()
        except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
            sys.stderr.write(
                "[daemon-cycle] WARN: alert_dwc_share_regression raised — "
                f"watch lost: {type(exc).__name__}: {str(exc)[:160]}\n"
            )
        try:
            emit_loop_events(report)
        except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
            # Return the cycle result to the caller normally — an emit failure is
            # only observation loss, not the report/apply stage's responsibility.
            sys.stderr.write(
                "[daemon-cycle] WARN: emit_loop_events raised — observation lost: "
                f"{type(exc).__name__}: {str(exc)[:160]}\n"
            )

    # AD-10 Solution History Pareto retention — prune this cycle's accumulated
    # attempts to the per-(agent, task_type) non-dominated frontier (GEPA
    # min-occurrence 5 floor). Runs unconditionally (pure computation, no PG
    # write) so the AC is observable even on skip_loop_emit/skip_haiku preflight.
    #
    # DEFERRAL NOTE (AD-10 durable store): Solution History is designed as a
    # cross-cycle accumulation feeding the next optimizer's OPRO context. That
    # persistence layer does not exist yet — a within-cycle window shares one
    # applied_date, so the recency objective is constant and cells rarely reach
    # the 5+ floor. This wiring makes retention run + observable at runtime
    # (report.solution_winners + the serialized count); durable persistence of the
    # frontier across cycles is the follow-up once the store lands.
    report.solution_winners = retain_pareto_winners(solution_attempts)
    if report.solution_winners:
        winner_total = sum(len(v) for v in report.solution_winners.values())
        sys.stderr.write(
            "[daemon-cycle] INFO: Solution History Pareto retention — "
            f"{len(report.solution_winners)} cell(s), {winner_total} winner(s) "
            f"retained from {len(solution_attempts)} attempt(s) "
            f"(min-occurrence {SOLUTION_HISTORY_MIN_OCCURRENCE})\n"
        )

    # Derive the cost-guard state from the aggregate per-patch failure classes so
    # the serialized cost_guard carries an explicit 'state' (_pg_push reads it as
    # explicit_state). An auth-failure night → 'infra_fault' (NOT a spending warn).
    report.cost_guard["state"] = derive_cost_guard_state(report)

    return report


# -- CLI entry --------------------------------------------------------------


def _main(argv: list[str]) -> int:
    """CLI shim — exists primarily for `python -m daemon_cycle` debugging.

    Production entry is daemon-cycle.sh which calls run_cycle() via this shim.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="daemon_cycle")
    parser.add_argument("--limit", type=int, default=DEFAULT_PATTERN_LIMIT)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-haiku", action="store_true")
    parser.add_argument(
        "--skip-pre-verify",
        action="store_true",
        help="Skip Phase 3 pre-verify (test/preflight). Implied by --skip-haiku/--dry-run.",
    )
    parser.add_argument(
        "--skip-loop-emit",
        action="store_true",
        help="Skip Phase 5 PG loop-event UPSERT (test/preflight). Implied by --dry-run.",
    )
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--log-path", type=Path, default=DEFAULT_LEARNING_LOG)
    parser.add_argument("--agents-dir", type=Path, default=DEFAULT_AGENTS_DIR)
    parser.add_argument("--outcomes-dir", type=Path, default=DEFAULT_OUTCOMES_DIR)
    parser.add_argument(
        "--regenerate-stale",
        action="store_true",
        help="FU-3 standalone: re-derive stale pending-proposal diffs against "
        "current agent files, UPDATE proposed_diff in PG, then exit (no cycle). "
        "Honors --dry-run (detect + re-derive, skip the UPDATE).",
    )
    parser.add_argument(
        "--proposal-id",
        type=int,
        default=None,
        help="FU-3 single-proposal mode (requires --regenerate-stale): regen + "
        "pre-verify ONLY this proposal id. Emits a single-result JSON to stdout "
        "and routes the verdict (regenerated/already_applied/invalid/"
        "unrecoverable) for the accept-path. Honors --dry-run.",
    )
    parser.add_argument(
        "--skip-pre-verify-single",
        action="store_true",
        help="FU-3 single-proposal: skip the pre-verify Haiku call (test only); "
        "any re-derivable diff reports action=invalid (skip ⇒ not passed).",
    )
    parser.add_argument(
        "--backfill-auth-mislabel",
        action="store_true",
        help="P2c standalone: relabel historically auth-mislabeled proposal rows "
        "(haiku_status='skipped:empty-or-error' + 'haiku non-zero exit' rationale) "
        "to 'skipped:auth' when a per-row 401 failure log exists, then exit (no "
        "cycle). Evidence-gated + idempotent. Honors --dry-run.",
    )
    parser.add_argument(
        "--removal-evidence",
        action="store_true",
        help="Removal gate query (requires --target): read a stored diff on "
        "stdin and print `verdict<TAB>live<TAB>count` plus the declared removal "
        "set. Read-only; the apply path calls it per patch.",
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=None,
        help="Agent body the --removal-evidence query resolves its removal set "
        "against.",
    )
    args = parser.parse_args(argv)

    if args.removal_evidence:
        # Answered BEFORE the pause gate below: this arm is a read-only query
        # that writes nothing, and returning the gate's clean exit 0 here would
        # hand the apply path an empty verdict it would (correctly, but for the
        # wrong reason) fail closed on.
        if args.target is None:
            parser.error("--removal-evidence requires --target")
        return _emit_removal_evidence(sys.stdin.read(), args.target)

    # Decision-to-run gate (T10): an in-flight Glass Atrium update holds the
    # pause flag while it swaps files — cooperatively SUSPEND ALL daemon work
    # (generate / regenerate-stale / backfill) for this invocation so nothing
    # races the file swap. A clean exit 0 (NOT a failure — daemon-cycle.sh folds
    # only non-zero into a DEGRADED run). A stale flag is TTL-cleared inside
    # is_pause_active so a crashed updater can never freeze the daemon forever.
    if HAS_PAUSE_LIB and _update_is_pause_active():
        sys.stderr.write(
            "[daemon-cycle] update in progress (pause flag held) — "
            "skipping this invocation (exit 0)\n"
        )
        return 0

    if args.backfill_auth_mislabel:
        try:
            backfilled = backfill_auth_mislabeled_proposals(dry_run=args.dry_run)
        except Exception as exc:  # noqa: BLE001 — loud-fail: named exit code
            sys.stderr.write(
                f"[daemon-cycle] P2c backfill aborted: {type(exc).__name__}: "
                f"{str(exc)[:200]}\n"
            )
            return BACKFILL_PG_EXIT_CODE
        sys.stdout.write(json.dumps(backfilled, ensure_ascii=False, indent=2) + "\n")
        return 0

    if args.proposal_id is not None and not args.regenerate_stale:
        parser.error("--proposal-id requires --regenerate-stale")

    if args.regenerate_stale and args.proposal_id is not None:
        # Single-proposal: one structured JSON object to stdout (machine),
        # human text already went to stderr. Exit code: 0 on a clean
        # determination (regenerated/already_applied), non-zero only on
        # invalid/unrecoverable (caller branches on action + exit code).
        single = regenerate_single_proposal(
            args.proposal_id,
            agents_dir=args.agents_dir,
            dry_run=args.dry_run,
            skip_pre_verify=args.skip_pre_verify_single,
        )
        sys.stdout.write(
            json.dumps(single.to_payload(), ensure_ascii=False, indent=2) + "\n"
        )
        return 0 if single.action in {"regenerated", "already_applied"} else 1

    if args.regenerate_stale:
        results = regenerate_stale_proposals(
            agents_dir=args.agents_dir, dry_run=args.dry_run
        )
        sys.stdout.write(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
        return 0

    report = run_cycle(
        limit=args.limit,
        log_path=args.log_path,
        outcomes_dir=args.outcomes_dir,
        agents_dir=args.agents_dir,
        skip_haiku=args.skip_haiku or args.dry_run,
        skip_pre_verify=args.skip_pre_verify or args.skip_haiku or args.dry_run,
        skip_loop_emit=args.skip_loop_emit or args.dry_run,
    )

    payload = render_report_json(report)

    if args.out is not None:
        emit_report(report, args.out)
        sys.stderr.write(f"[daemon-cycle] wrote {args.out}\n")
    else:
        sys.stdout.write(payload + "\n")

    # Non-clean exit on a systemic zero-output regression (Loud-Fail). The
    # daemon-cycle.sh wrapper folds any non-zero rc into a DEGRADED run, so an
    # unattended launchd run no longer masks a multi-day regression as success.
    if report.cycle_status == "regression":
        return CYCLE_REGRESSION_EXIT_CODE

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main(sys.argv[1:]))
