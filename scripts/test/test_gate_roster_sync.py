"""Behavioral tests for the DEV-roster gate sync (T7 / Delivery 1).

Covers `agent_lifecycle.gate_roster_sync` (the 3-gate-site transactional rebuild)
+ the `sync-gate-roster` CLI verb + the run_add auto-wire, against a disposable
`--ga-root` temp fixture (never the live ~/.glass-atrium tree):

  - insert: a roster name absent from all 3 sites lands in each, in the EXACT
    format the gate reads (unpadded DEV_SET bash str + the 5/line SQL IN-list).
  - remove: a name dropped from the roster is rebuilt out of all 3 sites.
  - idempotent no-op: a clean tree leaves each file byte- AND mtime-identical,
    writes no `.bak`.
  - round-trip re-parse rejects a corrupting write (clean rollback from `.bak`).
  - clean rollback on a mid-write failure restores byte-identically + the CLI
    maps it to EXIT_TX_FAILED.
  - cross-file rollback: file 3 fails -> files 1-2 restored byte-identically.
  - the two gate-audit.sh SQL lists stay byte-identical to each other.
  - charset loud-fail: a malformed roster name raises ValidationError pre-write.
  - detection mode: orphan-scan gate-roster-mismatch reports drift, writes nothing.
  - auto-wire e2e: a fixture run_add of a DEV agent makes its name appear in all 3
    sites (the T6 integration proof).
  - inject 5-tuple widening: parse_inject_text returns the 5-tracked-array tuple
    (BUDGET_DEV_AGENTS 5th) and loud-fails when it is absent; orphan_scan's
    inject drift-lint keys BUDGET_DEV on the SHARED
    inject_sync._BUDGET_DAEMON_CARRIERS predicate (readers/orphan_scan
    consumption paths).

Run with:
    uv run --python 3.13 --with pytest pytest scripts/test/test_gate_roster_sync.py -v

CID: 2026-06-28T1552_roster-autosync_9174
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle import gate_roster_sync, inject_sync, orphan_scan  # noqa: E402
from agent_lifecycle.cli import (  # noqa: E402
    EXIT_OK,
    EXIT_ROLLBACK_FAILED,
    EXIT_TX_FAILED,
    main as cli_main,
)
from agent_lifecycle.orphan_scan import run_scan  # noqa: E402
from agent_lifecycle.paths import StorePaths  # noqa: E402
from agent_lifecycle.readers import (  # noqa: E402
    ReaderError,
    parse_dev_set_text,
    parse_inject_text,
    parse_sql_in_list_text,
)
from agent_lifecycle.validation import ValidationError  # noqa: E402

# The live scope-dev.md DEV roster (13 names incl. glass-atrium-dev-swift). Per test, the
# fixture roster appends or omits a name to drive the sync.
_DEV_ROSTER = [
    "glass-atrium-dev-front",
    "glass-atrium-dev-react",
    "glass-atrium-dev-angular",
    "glass-atrium-dev-gsap",
    "glass-atrium-dev-android",
    "glass-atrium-dev-nestjs",
    "glass-atrium-dev-node",
    "glass-atrium-dev-python",
    "glass-atrium-dev-db",
    "glass-atrium-dev-rag",
    "glass-atrium-dev-animator",
    "glass-atrium-dev-shell",
    "glass-atrium-dev-swift",
]


def _verification_gate_text(dev_set_names: list[str]) -> str:
    """A minimal enforce-verification-gate.sh carrying the unpadded DEV_SET line."""
    body = gate_roster_sync.render_dev_set_body(dev_set_names)
    return (
        "#!/usr/bin/env bash\n"
        "set -Eeuo pipefail\n"
        "# DEV-set — keep in sync with the roster.\n"
        f'readonly DEV_SET="{body}"\n'
        'echo "verification gate"\n'
    )


def _workflow_gate_text(dev_set_names: list[str]) -> str:
    """A minimal enforce-workflow-verify-stage.sh carrying the DEV_SET mirror."""
    body = gate_roster_sync.render_dev_set_body(dev_set_names)
    return (
        "#!/usr/bin/env bash\n"
        "set -Eeuo pipefail\n"
        "# DEV-set — byte-identical mirror of enforce-verification-gate.sh.\n"
        f'readonly DEV_SET="{body}"\n'
        'echo "workflow verify stage"\n'
    )


def _gate_audit_text(sql_names: list[str]) -> str:
    """A minimal gate-audit.sh carrying TWO byte-identical `agent IN (...)` lists.

    Reproduces the live scaffolding (9-space `bool_or(agent IN (` open, the
    11-space-indented body, the 9-space `)) AS has_dev` close) so the parser +
    renderer exercise the real shape. Both occurrences share ONE rendered body.
    """
    body = gate_roster_sync.render_sql_in_list_body(sql_names)
    block = f"         bool_or(agent IN (\n{body}\n         )) AS has_dev"
    return (
        "#!/usr/bin/env bash\n"
        "set -Eeuo pipefail\n"
        "read -r -d '' AUDIT_SQL <<SQL || true\n"
        "WITH grp AS (\n"
        "  SELECT coalesce(cid, correlation_id) AS gid,\n"
        f"{block},\n"
        "         count(*) AS n\n"
        "  FROM core.outcomes\n"
        ")\n"
        "SELECT gid FROM grp;\n"
        "SQL\n"
        "read -r -d '' SUMMARY_SQL <<SQL || true\n"
        "WITH grp AS (\n"
        "  SELECT coalesce(cid, correlation_id) AS gid,\n"
        f"{block}\n"
        "  FROM core.outcomes\n"
        ")\n"
        "SELECT count(*) FROM grp;\n"
        "SQL\n"
    )


def _write_fixture(
    root: Path,
    *,
    dev_set: list[str],
    sql: list[str],
    roster: list[str],
) -> StorePaths:
    """Build a minimal but valid GA store under `root` (disposable temp tree).

    Writes the stores gate_roster_sync.apply + the gate-roster-mismatch scan
    touch: the 3 gate sites (2 hook DEV_SET + gate-audit.sh SQL), scope-dev.md
    (roster brace list), and the registry + manifest JSON.
    """
    (root / "hooks").mkdir(parents=True, exist_ok=True)
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scoped").mkdir(parents=True, exist_ok=True)
    (root / "agents").mkdir(parents=True, exist_ok=True)

    paths = StorePaths.for_root(root)
    paths.enforce_verification_gate.write_text(
        _verification_gate_text(dev_set), encoding="utf-8"
    )
    paths.enforce_workflow_verify_stage.write_text(
        _workflow_gate_text(dev_set), encoding="utf-8"
    )
    paths.gate_audit.write_text(_gate_audit_text(sql), encoding="utf-8")

    roster_csv = ", ".join(roster)
    paths.scope_dev.write_text(
        "# DEV Scope\n"
        f"> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {{{roster_csv}}}\n",
        encoding="utf-8",
    )
    paths.registry.write_text(
        json.dumps({"agents": {name: {} for name in roster}}), encoding="utf-8"
    )
    paths.manifest.write_text(json.dumps({"files": []}), encoding="utf-8")
    return paths


def _bash_members(path: Path) -> list[str]:
    return parse_dev_set_text(path.read_text(encoding="utf-8"))


def _sql_occurrences(path: Path) -> list[list[str]]:
    return parse_sql_in_list_text(path.read_text(encoding="utf-8"))


def test_insert_lands_in_all_three_sites_in_gate_format(tmp_path: Path) -> None:
    """A roster name absent from all 3 sites is rebuilt into each (exact format)."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    result = gate_roster_sync.apply(paths)

    assert result.did_change
    assert "glass-atrium-dev-newkid" in _bash_members(paths.enforce_verification_gate)
    assert "glass-atrium-dev-newkid" in _bash_members(paths.enforce_workflow_verify_stage)
    for occ in _sql_occurrences(paths.gate_audit):
        assert "glass-atrium-dev-newkid" in occ
    # exact format the gate reads: the bash line stays a single unpadded string.
    text = paths.enforce_verification_gate.read_text(encoding="utf-8")
    assert f'readonly DEV_SET="{" ".join(_DEV_ROSTER + ["glass-atrium-dev-newkid"])}"' in text


def test_remove_drops_name_from_all_three_sites(tmp_path: Path) -> None:
    """A name dropped from the roster is rebuilt out of all 3 sites."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        sql=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,  # glass-atrium-dev-gone NOT in the roster -> pruned everywhere
    )

    result = gate_roster_sync.apply(paths)

    assert result.did_change
    assert "glass-atrium-dev-gone" not in _bash_members(paths.enforce_verification_gate)
    assert "glass-atrium-dev-gone" not in _bash_members(paths.enforce_workflow_verify_stage)
    for occ in _sql_occurrences(paths.gate_audit):
        assert "glass-atrium-dev-gone" not in occ
    # roster members survive.
    assert "glass-atrium-dev-shell" in _bash_members(paths.enforce_verification_gate)


def test_idempotent_noop_leaves_files_unchanged(tmp_path: Path) -> None:
    """A clean tree is a no-op: same bytes AND mtime, no `.bak` written."""
    paths = _write_fixture(
        tmp_path, dev_set=_DEV_ROSTER, sql=_DEV_ROSTER, roster=_DEV_ROSTER
    )
    targets = [
        paths.enforce_verification_gate,
        paths.enforce_workflow_verify_stage,
        paths.gate_audit,
    ]
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in targets}

    result = gate_roster_sync.apply(paths)

    assert not result.did_change
    assert result.backups == {}
    for p in targets:
        assert p.read_bytes() == before[p][0]
        assert p.stat().st_mtime_ns == before[p][1]
        assert not p.with_suffix(p.suffix + ".bak").exists()


def test_two_sql_lists_stay_byte_identical(tmp_path: Path) -> None:
    """After a sync the two gate-audit.sql IN-lists are byte-identical to each other."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    gate_roster_sync.apply(paths)

    occurrences = _sql_occurrences(paths.gate_audit)
    assert len(occurrences) == 2
    assert occurrences[0] == occurrences[1]
    # raw blocks byte-identical too (the canonical renderer fed both).
    body = gate_roster_sync.render_sql_in_list_body(_DEV_ROSTER + ["glass-atrium-dev-newkid"])
    assert paths.gate_audit.read_text(encoding="utf-8").count(body) == 2


def test_round_trip_rejects_a_corrupting_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """apply()'s post-write round-trip rejects a write that did not land the roster."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )
    first = paths.enforce_verification_gate
    original = first.read_bytes()

    # Hand the round-trip validator a temp file with the STALE (pre-sync) content,
    # so the parsed names != roster and _assert_roundtrip raises -> clean rollback.
    def _writes_stale(target: Path, _text: str, *, before_replace=None) -> None:
        stale = target.with_suffix(target.suffix + ".tmp-stale")
        stale.write_text(target.read_text(encoding="utf-8"), encoding="utf-8")
        if before_replace is not None:
            before_replace(stale)

    monkeypatch.setattr(gate_roster_sync, "_atomic_replace", _writes_stale)

    with pytest.raises(gate_roster_sync.GateRosterSyncError):
        gate_roster_sync.apply(paths)

    assert first.read_bytes() == original


def test_clean_rollback_restores_byte_identical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A forced mid-write failure restores every site byte-identically."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )
    targets = [
        paths.enforce_verification_gate,
        paths.enforce_workflow_verify_stage,
        paths.gate_audit,
    ]
    before = {p: p.read_bytes() for p in targets}

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated atomic-replace failure")

    monkeypatch.setattr(gate_roster_sync, "_atomic_replace", _boom)

    with pytest.raises(gate_roster_sync.GateRosterSyncError):
        gate_roster_sync.apply(paths)

    for p in targets:
        assert p.read_bytes() == before[p]


def test_cross_file_rollback_restores_earlier_sites(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """File 3 failing mid-write rolls back files 1-2 to byte-identical originals."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],  # all 3 sites need the new name
    )
    targets = [
        paths.enforce_verification_gate,
        paths.enforce_workflow_verify_stage,
        paths.gate_audit,
    ]
    before = {p: p.read_bytes() for p in targets}

    real_replace = gate_roster_sync._atomic_replace
    call_count = 0

    def _fail_on_third(target: Path, text: str, *, before_replace=None) -> None:
        nonlocal call_count
        call_count += 1
        if call_count == 3:
            raise OSError("simulated failure writing the 3rd gate site")
        real_replace(target, text, before_replace=before_replace)

    monkeypatch.setattr(gate_roster_sync, "_atomic_replace", _fail_on_third)

    with pytest.raises(gate_roster_sync.GateRosterSyncError):
        gate_roster_sync.apply(paths)

    # files 1-2 were written then restored from `.bak`; file 3 never landed.
    for p in targets:
        assert p.read_bytes() == before[p]


def test_charset_loud_fail_on_malformed_roster_name(tmp_path: Path) -> None:
    """A roster name failing validation.NAME_RE raises ValidationError pre-write."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["dev_bad_underscore"],  # underscore fails ^[a-z0-9-]+$
    )
    targets = [
        paths.enforce_verification_gate,
        paths.enforce_workflow_verify_stage,
        paths.gate_audit,
    ]
    before = {p: p.read_bytes() for p in targets}

    with pytest.raises(ValidationError):
        gate_roster_sync.apply(paths)

    # loud-fail happens in the plan phase — nothing written, no `.bak`.
    for p in targets:
        assert p.read_bytes() == before[p]
        assert not p.with_suffix(p.suffix + ".bak").exists()


def test_detection_mode_reports_drift_no_write(tmp_path: Path) -> None:
    """orphan-scan gate-roster-mismatch reports the drift but writes nothing."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER[:-1],  # DEV_SET missing glass-atrium-dev-swift
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER,
    )
    gate = paths.enforce_verification_gate
    before_bytes = gate.read_bytes()
    before_mtime = gate.stat().st_mtime_ns

    code = cli_main(
        [
            "--ga-root",
            str(paths.ga_root),
            "orphan-scan",
            "--mode",
            "gate-roster-mismatch",
        ]
    )
    report = run_scan(paths, ["gate-roster-mismatch"])
    findings = report.by_mode("gate-roster-mismatch")

    assert code == EXIT_OK
    assert any(
        f.name == "glass-atrium-dev-swift" and "enforce-verification-gate.sh" in f.detail
        for f in findings
    ), f"expected a glass-atrium-dev-swift miss, got {[(f.name, f.detail) for f in findings]}"
    # lint-only — no mutation, no `.bak`.
    assert gate.read_bytes() == before_bytes
    assert gate.stat().st_mtime_ns == before_mtime
    assert not gate.with_suffix(gate.suffix + ".bak").exists()


def test_cli_rollback_maps_to_exit_tx_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sync-gate-roster verb maps a cleanly-rolled-back failure to EXIT_TX_FAILED."""
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated atomic-replace failure")

    monkeypatch.setattr("agent_lifecycle.gate_roster_sync._atomic_replace", _boom)

    code = cli_main(["--ga-root", str(paths.ga_root), "sync-gate-roster"])
    assert code == EXIT_TX_FAILED


def test_cli_sync_gate_roster_clean_tree_is_ok_noop(tmp_path: Path) -> None:
    """The verb on a clean tree exits 0 and writes nothing."""
    paths = _write_fixture(
        tmp_path, dev_set=_DEV_ROSTER, sql=_DEV_ROSTER, roster=_DEV_ROSTER
    )
    gate = paths.enforce_verification_gate
    before = gate.read_bytes()

    code = cli_main(["--ga-root", str(paths.ga_root), "sync-gate-roster"])

    assert code == EXIT_OK
    assert gate.read_bytes() == before
    assert not gate.with_suffix(gate.suffix + ".bak").exists()


def test_run_add_auto_wires_gate_roster_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A DEV run_add inserts the new name into the roster AND all 3 gate sites (T6).

    The request carries a BARE name on purpose: run_add must normalize it to the
    glass-atrium- fleet prefix (born-prefixed mandate), so every assertion below
    checks the PREFIXED name — a bare-name birth would fail them all.
    """
    from agent_lifecycle import add as add_mod
    from agent_lifecycle.add import AddRequest, run_add

    bare = "dev-newbie"
    target = "glass-atrium-dev-newbie"  # the name run_add must actually write
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER,  # target NOT yet in roster (pre-flight must pass)
    )

    # Mock the subprocess-backed derived-chain steps (no git / manifest / farm in
    # the temp fixture); the scope-dev stanza + gate roster sync run for real.
    monkeypatch.setattr(add_mod, "git_add", lambda *_a, **_k: None)
    monkeypatch.setattr(add_mod, "git_unstage", lambda *_a, **_k: None)
    monkeypatch.setattr(add_mod, "regenerate_manifest", lambda *_a, **_k: None)
    monkeypatch.setattr(add_mod, "swap_symlinks", lambda *_a, **_k: None)

    req = AddRequest(
        name=bare,  # bare in, prefixed out — the born-prefixed proof
        scope="DEV",
        origin="user",
        domains=[],  # empty -> no Q3 overlap
        q1_verdict="pass",
        q2_verdict="pass",
    )
    run_add(paths, req)

    # The stanza inserted the name into the roster...
    from agent_lifecycle.readers import parse_scope_dev_roster

    assert target in parse_scope_dev_roster(paths)
    # ...and the auto-wired gate sync put it into all 3 gate sites.
    assert target in _bash_members(paths.enforce_verification_gate)
    assert target in _bash_members(paths.enforce_workflow_verify_stage)
    for occ in _sql_occurrences(paths.gate_audit):
        assert target in occ


def test_rollback_failed_raises_and_cli_returns_exit_6(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A restore failure during _rollback raises GateRosterRollbackFailedError (exit 6).

    Patches _atomic_replace to succeed on call 1 then fail on call 2 — triggering
    _rollback with one entry in `written`.  Simultaneously patches Path.write_text
    to raise OSError on non-.bak live-path targets (the restore call) once the
    primary failure arms the block.  Asserts that:
      (A) apply() raises GateRosterRollbackFailedError directly, AND
      (B) the sync-gate-roster CLI verb maps it to EXIT_ROLLBACK_FAILED (6).
    """
    paths = _write_fixture(
        tmp_path,
        dev_set=_DEV_ROSTER,
        sql=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],  # all 3 sites differ — each needs a write
    )

    real_replace = gate_roster_sync._atomic_replace
    real_write_text = Path.write_text
    # Shared mutable state: atomic_n tracks _atomic_replace invocations so the
    # patch can fail deterministically on call 2; block_restore is armed by the
    # primary failure right before the OSError so only the restore call is blocked.
    state = {"atomic_n": 0, "block_restore": False}

    def _patched_replace(target: Path, text: str, *, before_replace=None) -> None:
        state["atomic_n"] += 1
        if state["atomic_n"] == 2:
            state["block_restore"] = True  # arm BEFORE raising
            raise OSError("simulated primary-write failure on site 2")
        real_replace(target, text, before_replace=before_replace)

    def _patched_write_text(
        self: Path, data: str, *args: object, **kwargs: object
    ) -> None:
        # Block only the restore write (non-.bak live-path) when armed.
        # .bak backup writes in apply() target .bak paths and must succeed so
        # the backup file exists when _rollback tries to read it.
        if state["block_restore"] and not str(self).endswith(".bak"):
            raise OSError("simulated restore failure")
        real_write_text(self, data, *args, **kwargs)

    monkeypatch.setattr(gate_roster_sync, "_atomic_replace", _patched_replace)
    monkeypatch.setattr(Path, "write_text", _patched_write_text)

    # Part A: apply() must bubble GateRosterRollbackFailedError (not the plain base).
    with pytest.raises(gate_roster_sync.GateRosterRollbackFailedError):
        gate_roster_sync.apply(paths)

    # Part B: CLI maps the error to EXIT_ROLLBACK_FAILED.
    # Reset counters and re-seed the gate sites (state["block_restore"] is False
    # so the write_text patch allows these seeding writes through).
    state["atomic_n"] = 0
    state["block_restore"] = False
    paths.enforce_verification_gate.write_text(
        _verification_gate_text(_DEV_ROSTER), encoding="utf-8"
    )
    paths.enforce_workflow_verify_stage.write_text(
        _workflow_gate_text(_DEV_ROSTER), encoding="utf-8"
    )
    paths.gate_audit.write_text(_gate_audit_text(_DEV_ROSTER), encoding="utf-8")

    code = cli_main(["--ga-root", str(paths.ga_root), "sync-gate-roster"])
    assert code == EXIT_ROLLBACK_FAILED


def _inject_hook_text(budget_dev: list[str]) -> str:
    """A minimal inject-scope-rules.sh: all 5 tracked arrays in-sync for the
    13-name roster except a caller-driven BUDGET_DEV_AGENTS membership."""

    def line(var: str, names: list[str]) -> str:
        return f'readonly {var}=" {" ".join(names)} "'

    qa = ["glass-atrium-qa-code-reviewer", "glass-atrium-qa-debugger"]
    naming = [n for n in _DEV_ROSTER if n != "glass-atrium-dev-swift"] + [
        "glass-atrium-qa-code-reviewer"
    ]
    return (
        "\n".join(
            [
                "#!/usr/bin/env bash",
                line("INJECT_AGENTS", _DEV_ROSTER + qa),
                line("STYLEREF_AGENTS", _DEV_ROSTER),
                line("MINIMALISM_AGENTS", _DEV_ROSTER),
                line("NAMING_AGENTS", naming),
                line("BUDGET_DEV_AGENTS", budget_dev),
            ]
        )
        + "\n"
    )


def test_parse_inject_text_returns_five_tuple_in_documented_order() -> None:
    """readers 5-tuple widening: (inject, styleref, minimalism, naming, budget_dev)."""
    expected_budget = [
        n for n in _DEV_ROSTER if n not in inject_sync._BUDGET_DAEMON_CARRIERS
    ]
    text = _inject_hook_text(expected_budget)

    inject, styleref, minimalism, naming, budget_dev = parse_inject_text(text)

    assert inject == _DEV_ROSTER + [
        "glass-atrium-qa-code-reviewer",
        "glass-atrium-qa-debugger",
    ]
    assert styleref == _DEV_ROSTER
    assert minimalism == _DEV_ROSTER
    assert naming[-1] == "glass-atrium-qa-code-reviewer"
    assert "glass-atrium-dev-swift" not in naming
    assert budget_dev == expected_budget


def test_parse_inject_text_loud_fails_without_budget_dev_array() -> None:
    """A hook missing the 5th tracked array raises ReaderError (loud, not a 4-tuple)."""
    text = _inject_hook_text(["glass-atrium-dev-front"])
    without_budget = (
        "\n".join(
            ln for ln in text.splitlines() if "BUDGET_DEV_AGENTS" not in ln
        )
        + "\n"
    )

    with pytest.raises(ReaderError, match="BUDGET_DEV_AGENTS"):
        parse_inject_text(without_budget)


def test_orphan_scan_budget_dev_lint_uses_shared_carrier_predicate(
    tmp_path: Path,
) -> None:
    """orphan_scan flags BUDGET_DEV deviations from roster − carriers via the
    SHARED inject_sync constant — identity-pinned so a re-hardcoded local copy
    fails even when equal (a second carrier list is forbidden)."""
    assert orphan_scan._BUDGET_DAEMON_CARRIERS is inject_sync._BUDGET_DAEMON_CARRIERS

    paths = _write_fixture(
        tmp_path, dev_set=_DEV_ROSTER, sql=_DEV_ROSTER, roster=_DEV_ROSTER
    )
    expected_budget = [
        n for n in _DEV_ROSTER if n not in inject_sync._BUDGET_DAEMON_CARRIERS
    ]
    # drift both directions: drop dev-front (a member) + add dev-shell (a carrier).
    drifted = [n for n in expected_budget if n != "glass-atrium-dev-front"] + [
        "glass-atrium-dev-shell"
    ]
    paths.inject_scope_rules.write_text(_inject_hook_text(drifted), encoding="utf-8")

    report = run_scan(paths, ["inject-list-mismatch"])
    findings = report.by_mode("inject-list-mismatch")

    budget_findings = {
        (f.name, f.detail) for f in findings if "BUDGET_DEV_AGENTS" in f.detail
    }
    assert ("glass-atrium-dev-front", "missing from BUDGET_DEV_AGENTS") in budget_findings
    assert (
        "glass-atrium-dev-shell",
        "BUDGET_DEV_AGENTS name not expected",
    ) in budget_findings
    # no carrier is ever EXPECTED in BUDGET_DEV: none is flagged as missing.
    assert not any(
        f.name in inject_sync._BUDGET_DAEMON_CARRIERS
        and f.detail == "missing from BUDGET_DEV_AGENTS"
        for f in findings
    )
