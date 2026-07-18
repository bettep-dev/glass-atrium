#!/usr/bin/env python3
# _pg_push_autoagent_cycle.py — invoked by daemon-cycle.sh after the cycle
# stage emits ~/.claude/data/daemon-reports/autoagent-YYYY-MM-DD.json.
#
# Reads the daily JSON (env OUT_PATH) and pushes:
#   * core.daemon_runs (daemon_name='autoagent', run_date=CYCLE_DATE) with
#     aggregate stats (cost_guard_state, patches_count, patches_apply_count,
#     patches_reject_count).
#   * core.daemon_run_payload (FK 1:1) with the full JSON blob.
#   * core.autoagent_proposals — one UPSERT per patches[] entry, keyed by
#     (cycle_date, pattern_label, target_file). cost_guard_state is the
#     cycle-level snapshot copied to every proposal row.
#
# All writes go through the sibling _pg_dual_write_daemon.py
# (subprocess) so retry / hook_failures / fail-loud-and-skip semantics
# match wiki-sync.sh and daemon-cycle.sh writes.
#
# Exit 0 always — the daemon must not block on PG failure.

import json
import os
import subprocess
import sys

OUT_PATH = os.environ.get("OUT_PATH", "")
CYCLE_DATE = os.environ.get("CYCLE_DATE", "")
CYCLE_STARTED_AT = os.environ.get("CYCLE_STARTED_AT", "")

# Daemon failure_class token (hyphen) ↔ core.daemon_runs status enum (underscore).
# Token SoT is daemon_cycle.FAILURE_CLASS_QUOTA; kept as a literal here to avoid
# importing daemon_cycle (heavy config resolution at import) into the writer.
_FAILURE_CLASS_QUOTA = "quota-limit"
_STATUS_QUOTA_EXCEEDED = "quota_exceeded"
# Sibling of this module — scripts/ is consumed in place from the store.
HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_pg_dual_write_daemon.py")


def _aggregate(payload):
    patches = payload.get("patches") or []
    apply_count = 0
    reject_count = 0
    for p in patches:
        if not isinstance(p, dict):
            continue
        cls = p.get("classification") or ""
        # Free-form daemon labels: anything starting with body-/frontmatter- is
        # an apply candidate; "reject" is a reject. See helper's
        # _CLASSIFICATION_TO_ENUM for the canonical mapping.
        if cls == "reject":
            reject_count += 1
        elif cls.startswith("body-") or cls.startswith("frontmatter-"):
            apply_count += 1
        else:
            # Unknown labels collapse to reject for the count (consistent
            # with the helper's defensive coercion).
            reject_count += 1
    cg = payload.get("cost_guard") or {}
    # cost_guard in the daemon JSON is a dict of policy params (max_haiku_calls
    # etc.), not a state enum. Derive a single ok/warn/block snapshot from
    # observable signals: if any patch has a non-empty error -> warn; otherwise
    # ok. The schema enum allows ok/warn/block — block is reserved for explicit
    # cost-guard tripwires which the current daemon cycle does not surface.
    saw_error = any(
        isinstance(p, dict) and (p.get("error") or "").strip() for p in patches
    )
    cost_guard_state = "warn" if saw_error else "ok"
    # If the policy dict explicitly has a state field, prefer it (the daemon now
    # emits it). 'infra_fault' is the auth/401 (credential outage) state — it MUST
    # be in the accepted set, else the new value is silently dropped and saw_error
    # forces 'warn', mislabeling a credential outage as a spending warning.
    explicit_state = cg.get("state") if isinstance(cg, dict) else None
    if explicit_state in ("ok", "warn", "block", "infra_fault"):
        cost_guard_state = explicit_state

    # Status accuracy: subdivide the former blanket 'partial' by the failure_class
    # of the error-bearing patches (same set that drives saw_error, so the ok vs
    # non-ok boundary is unchanged). A cycle whose failures are ALL quota-limit is
    # an external usage ceiling, not a code fault → 'quota_exceeded' (monitor
    # renders "Usage limit"). Mixed / other / malformed-or-absent failure_class
    # stays 'partial' — never a silent 'ok'.
    failing_classes = {
        (p.get("failure_class") or "").strip()
        for p in patches
        if isinstance(p, dict) and (p.get("error") or "").strip()
    }
    if not saw_error:
        status = "ok"
    elif failing_classes == {_FAILURE_CLASS_QUOTA}:
        status = _STATUS_QUOTA_EXCEEDED
    else:
        status = "partial"
    return {
        "patches_count": len(patches),
        "patches_apply_count": apply_count,
        "patches_reject_count": reject_count,
        "cost_guard_state": cost_guard_state,
        "status": status,
        "patches": patches,
    }


def _invoke_helper(envelope):
    try:
        subprocess.run(
            ["python3", HELPER],
            input=json.dumps(envelope),
            text=True,
            timeout=10,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001 — fail-loud-and-skip
        sys.stderr.write(
            "[autoagent-cycle-pg] helper invocation failed (op=%s): %s\n"
            % (envelope.get("op", "?"), str(exc).replace('"', "'"))
        )


def main():
    if not OUT_PATH or not CYCLE_DATE:
        sys.stderr.write("[autoagent-cycle-pg] missing OUT_PATH or CYCLE_DATE; skipping\n")
        return 0
    if not os.path.isfile(OUT_PATH):
        sys.stderr.write("[autoagent-cycle-pg] OUT_PATH missing: %s; skipping\n" % OUT_PATH)
        return 0
    # Skip 0-byte files (cycle stage failed before writing any content).
    try:
        if os.path.getsize(OUT_PATH) == 0:
            sys.stderr.write("[autoagent-cycle-pg] OUT_PATH 0-byte: %s; skipping\n" % OUT_PATH)
            return 0
    except OSError as exc:
        sys.stderr.write(
            "[autoagent-cycle-pg] stat failed: %s\n" % str(exc).replace('"', "'")
        )
        return 0

    try:
        with open(OUT_PATH, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(
            "[autoagent-cycle-pg] JSON parse failed: %s\n"
            % str(exc).replace('"', "'")
        )
        return 0

    stats = _aggregate(payload)
    ended_at = payload.get("generated_at") or CYCLE_STARTED_AT
    try:
        source_mtime = int(os.path.getmtime(OUT_PATH))
    except OSError:
        source_mtime = 0

    run_env = {
        "op": "write_daemon_run",
        "args": {
            "daemon_name": "autoagent",
            "run_date": CYCLE_DATE,
            "started_at": CYCLE_STARTED_AT,
            "ended_at": ended_at,
            "status": stats["status"],
            "cost_guard_state": stats["cost_guard_state"],
            "patches_count": stats["patches_count"],
            "patches_apply_count": stats["patches_apply_count"],
            "patches_reject_count": stats["patches_reject_count"],
        },
    }
    payload_env = {
        "op": "write_daemon_run_payload",
        "args": {
            "daemon_name": "autoagent",
            "run_date": CYCLE_DATE,
            "payload": payload,
        },
    }

    _invoke_helper(run_env)
    _invoke_helper(payload_env)

    # Per-patch UPSERT into core.autoagent_proposals.
    source_file_basename = os.path.basename(OUT_PATH)
    for patch in stats["patches"]:
        if not isinstance(patch, dict):
            continue
        pattern_label = patch.get("pattern_label") or ""
        target_file = patch.get("target_file") or ""
        if not pattern_label or not target_file:
            # Schema requires both NOT NULL — skip incomplete rows but log.
            sys.stderr.write(
                "[autoagent-cycle-pg] skip patch missing label/target: %s\n"
                % json.dumps(patch)[:200]
            )
            continue
        patch_classification = patch.get("classification") or "reject"
        # Status fallback derives from classification — a reject patch with an
        # absent/empty status settles as 'rejected', not the blanket 'pending'
        # (which would fossilize auto-reject rows).
        status_fallback = (
            "rejected" if patch_classification == "reject" else "pending"
        )
        proposal_env = {
            "op": "write_autoagent_proposal",
            "args": {
                "cycle_date": CYCLE_DATE,
                "pattern_label": pattern_label,
                "target_file": target_file,
                "target_agent": patch.get("pattern_agent"),
                "classification": patch_classification,
                "rationale": patch.get("rationale"),
                "haiku_status": patch.get("haiku_status"),
                # approval_tier is derived inside the helper from classification;
                # pass through any explicit override the daemon emits later.
                "approval_tier": patch.get("approval_tier") or "",
                "status": patch.get("status") or status_fallback,
                "proposed_diff": patch.get("proposed_diff"),
                "cost_guard_state": stats["cost_guard_state"],
                "source_file": source_file_basename,
                "source_file_mtime": source_mtime,
                # Pre-verify dual-write — daemon_cycle.py PatchResult emits
                # 4 fields (passed/status/rationale/axes); axes is dict.
                "pre_verify_passed": patch.get("pre_verify_passed"),
                "pre_verify_status": patch.get("pre_verify_status", ""),
                "pre_verify_rationale": patch.get("pre_verify_rationale", ""),
                "pre_verify_axes": patch.get("pre_verify_axes") or {},
                # Confidence-weighted promotion ladder. daemon_cycle.py
                # PatchResult emits 3 fields when the feature flag is on;
                # absent/None when off (helper treats NULL as no-op).
                "confidence_observed": patch.get("confidence_observed"),
                "project_key": patch.get("project_key") or "",
                "promotion_tier": patch.get("promotion_tier") or "",
            },
        }
        _invoke_helper(proposal_env)

    return 0


if __name__ == "__main__":
    sys.exit(main())
