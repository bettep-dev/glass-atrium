"""Behavioral tests for the inject-scope-rules.sh 3-array sync (plan T4 / AC1-AC4).

Covers the `agent_lifecycle.inject_sync` transactional reconcile + the
`sync-inject` CLI verb against a disposable `--ga-root` temp fixture (never the
live ~/.glass-atrium tree):

  - insert-when-missing, per scope: a missing DEV name lands in ALL THREE arrays
    (INJECT + STYLEREF + MINIMALISM), a missing QA name lands in INJECT only (AC1).
  - idempotent no-op: a clean tree leaves the hook file byte- AND mtime-identical
    (AC2).
  - MINIMALISM specifically: the previously-unparsed third array is detected AND
    fixed (AC4 — verified 0-hit unparsed before this revision).
  - round-trip rejects a corrupting edit: an insert that would drop a prior member
    raises rather than landing a lossy write.
  - rollback restores from .bak: a forced mid-transaction failure leaves the live
    file byte-identical to the pre-run original (AC3) and exits non-zero.
  - bidirectional reconcile: plan_removes flags stale names, apply() removes a
    stale name from all 3 arrays + inserts and removes in one tx, the no-op
    short-circuit covers "no inserts AND no removes", remove-rollback restores
    byte-identical, and the round-trip rejects a write keeping a removed name (AC7/AC8).
  - delete-side stanza prune: run_delete drops the DEV name from the scope-dev.md
    roster (AC11) so the bidirectional sync then prunes all 3 arrays (AC12).
  - orphan-scan stays lint-only: detection without the sync verb writes nothing.

Run with:
    uv run --python 3.13 --with pytest pytest scripts/test/test_inject_sync.py -v

CID: 2026-06-18T_skill-reconcile-impl_e3c7
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle import gate_roster_sync, inject_sync  # noqa: E402
from agent_lifecycle.cli import (  # noqa: E402
    EXIT_OK,
    EXIT_TX_FAILED,
    main as cli_main,
)
from agent_lifecycle.orphan_scan import run_scan  # noqa: E402
from agent_lifecycle.paths import StorePaths  # noqa: E402
from agent_lifecycle.readers import (  # noqa: E402
    parse_dev_set_text,
    parse_sql_in_list_text,
)

# The DEV roster the live scope-dev.md brace list carries; INJECT also
# carries the two QA names. The fixture builder appends extra names per test.
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
]
_QA_NAMES = ["glass-atrium-qa-code-reviewer", "glass-atrium-qa-debugger"]
# NAMING_AGENTS is the narrower 4th array: the DEV roster MINUS glass-atrium-dev-swift, PLUS
# glass-atrium-qa-code-reviewer, and EXCLUDING glass-atrium-qa-debugger. The fixture _DEV_ROSTER above does
# NOT include glass-atrium-dev-swift, so the in-sync naming list is just _DEV_ROSTER plus the
# review name. Tests append extra names per scenario.
_NAMING_QA_NAME = "glass-atrium-qa-code-reviewer"


def _array_line(var: str, names: list[str]) -> str:
    """A `readonly VAR=" a b c "` line mirroring the live space-padded format."""
    return f'readonly {var}="{" " + " ".join(names) + " " if names else " "}"'


def _write_fixture(
    root: Path,
    *,
    inject: list[str],
    styleref: list[str],
    minimalism: list[str],
    naming: list[str],
    roster: list[str],
) -> StorePaths:
    """Build a minimal but valid GA store under `root` (disposable temp tree).

    Writes the stores `run_scan(['inject-list-mismatch'])` + inject_sync touch:
    the inject hook (4 arrays: INJECT/STYLEREF/MINIMALISM/NAMING), scope-dev.md
    (roster brace list), and the registry + manifest JSON (load_json raises on a
    missing manifest).
    """
    (root / "hooks").mkdir(parents=True, exist_ok=True)
    (root / "scoped").mkdir(parents=True, exist_ok=True)

    hook = root / "hooks" / "inject-scope-rules.sh"
    hook.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"{_array_line('INJECT_AGENTS', inject)}\n"
        f"{_array_line('STYLEREF_AGENTS', styleref)}\n"
        f"{_array_line('MINIMALISM_AGENTS', minimalism)}\n"
        f"{_array_line('NAMING_AGENTS', naming)}\n",
        encoding="utf-8",
    )

    roster_csv = ", ".join(roster)
    (root / "scoped" / "scope-dev.md").write_text(
        "# DEV Scope\n"
        f"> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {{{roster_csv}}}\n",
        encoding="utf-8",
    )

    (root / "agent-registry.json").write_text(
        json.dumps({"agents": {name: {} for name in roster}}), encoding="utf-8"
    )
    (root / "manifest.json").write_text(json.dumps({"files": []}), encoding="utf-8")

    return StorePaths.for_root(root)


def _members(hook: Path, var: str) -> list[str]:
    """Re-parse the live hook file and return the named array's token members."""
    inject, styleref, minimalism, naming = inject_sync.parse_inject_text(
        hook.read_text(encoding="utf-8")
    )
    return {
        "INJECT_AGENTS": inject,
        "STYLEREF_AGENTS": styleref,
        "MINIMALISM_AGENTS": minimalism,
        "NAMING_AGENTS": naming,
    }[var]


def _write_gate_sites(paths: StorePaths, names: list[str]) -> None:
    """Write the 3 gate sites run_add/run_delete now auto-sync (gate_roster_sync).

    run_delete gained a DEV-gated gate-roster-sync step that rebuilds these files
    from the (post-prune) roster, so a delete fixture must provide them — an
    absent gate site is a real loud-fail (the gates are safety gates that always
    exist live), not a no-op.
    """
    paths.gate_audit.parent.mkdir(parents=True, exist_ok=True)
    dev_set = gate_roster_sync.render_dev_set_body(names)
    sql_body = gate_roster_sync.render_sql_in_list_body(names)
    line = f'readonly DEV_SET="{dev_set}"\n'
    paths.enforce_verification_gate.write_text(line, encoding="utf-8")
    paths.enforce_workflow_verify_stage.write_text(line, encoding="utf-8")
    block = f"         bool_or(agent IN (\n{sql_body}\n         )) AS has_dev"
    paths.gate_audit.write_text(
        f"read -r -d '' AUDIT_SQL <<SQL || true\n{block}\nSQL\n"
        f"read -r -d '' SUMMARY_SQL <<SQL || true\n{block}\nSQL\n",
        encoding="utf-8",
    )


def test_insert_when_missing_dev_lands_in_all_three_arrays(tmp_path: Path) -> None:
    """A roster DEV name absent from every array is inserted into all 4 (AC1).

    glass-atrium-dev-newkid is a non-swift DEV name, so it is expected in NAMING_AGENTS too.
    """
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    result = inject_sync.apply(paths)

    assert result.changed
    hook = paths.inject_scope_rules
    assert "glass-atrium-dev-newkid" in _members(hook, "INJECT_AGENTS")
    assert "glass-atrium-dev-newkid" in _members(hook, "STYLEREF_AGENTS")
    assert "glass-atrium-dev-newkid" in _members(hook, "MINIMALISM_AGENTS")
    assert "glass-atrium-dev-newkid" in _members(hook, "NAMING_AGENTS")
    assert result.inserted["INJECT_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.inserted["STYLEREF_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.inserted["MINIMALISM_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.inserted["NAMING_AGENTS"] == ["glass-atrium-dev-newkid"]


def test_insert_when_missing_qa_lands_in_inject_only(tmp_path: Path) -> None:
    """A missing QA name goes into INJECT only — STYLEREF/MINIMALISM/NAMING never
    take glass-atrium-qa-debugger (NAMING carries glass-atrium-qa-code-reviewer only) (AC1)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + ["glass-atrium-qa-code-reviewer"],  # glass-atrium-qa-debugger missing from INJECT
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER,
    )

    result = inject_sync.apply(paths)

    hook = paths.inject_scope_rules
    assert "glass-atrium-qa-debugger" in _members(hook, "INJECT_AGENTS")
    assert "glass-atrium-qa-debugger" not in _members(hook, "STYLEREF_AGENTS")
    assert "glass-atrium-qa-debugger" not in _members(hook, "MINIMALISM_AGENTS")
    assert "glass-atrium-qa-debugger" not in _members(hook, "NAMING_AGENTS")
    assert result.inserted["INJECT_AGENTS"] == ["glass-atrium-qa-debugger"]
    assert result.inserted["STYLEREF_AGENTS"] == []
    assert result.inserted["MINIMALISM_AGENTS"] == []
    assert result.inserted["NAMING_AGENTS"] == []


def test_idempotent_noop_leaves_file_unchanged(tmp_path: Path) -> None:
    """A clean tree is a no-op: same bytes AND same mtime, no .bak written (AC2)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER,
    )
    hook = paths.inject_scope_rules
    before_bytes = hook.read_bytes()
    before_mtime = hook.stat().st_mtime_ns

    result = inject_sync.apply(paths)

    assert not result.changed
    assert result.backup_path is None
    assert hook.read_bytes() == before_bytes
    assert hook.stat().st_mtime_ns == before_mtime
    backup = hook.with_suffix(hook.suffix + ".bak")
    assert not backup.exists()


def test_minimalism_specifically_detected_and_fixed(tmp_path: Path) -> None:
    """MINIMALISM (the formerly-unparsed array) is detected AND fixed in isolation (AC4)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER[:-1],  # only MINIMALISM is missing glass-atrium-dev-shell
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER,
    )

    # Detection: the read-only scan reports the MINIMALISM-specific miss.
    report = run_scan(paths, ["inject-list-mismatch"])
    findings = report.by_mode("inject-list-mismatch")
    assert any(
        f.name == "glass-atrium-dev-shell" and "MINIMALISM_AGENTS" in f.detail for f in findings
    ), (
        f"expected a MINIMALISM glass-atrium-dev-shell miss, got {[(f.name, f.detail) for f in findings]}"
    )

    # Fix: only MINIMALISM changes; INJECT/STYLEREF/NAMING were already in sync.
    result = inject_sync.apply(paths)
    assert result.inserted["MINIMALISM_AGENTS"] == ["glass-atrium-dev-shell"]
    assert result.inserted["INJECT_AGENTS"] == []
    assert result.inserted["STYLEREF_AGENTS"] == []
    assert result.inserted["NAMING_AGENTS"] == []
    assert "glass-atrium-dev-shell" in _members(paths.inject_scope_rules, "MINIMALISM_AGENTS")


def test_round_trip_rejects_when_array_missing() -> None:
    """The insert core raises (not silently no-ops) when its array is unparseable."""
    # Documented round-trip guard: an array assignment the regex cannot locate
    # after the edit is a hard InjectSyncError, never a silent skip.
    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.insert_name_in_array("# no arrays here\n", "INJECT_AGENTS", "dev-x")
    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.insert_name_in_array("anything", "BOGUS_AGENTS", "dev-x")


def test_round_trip_rejects_a_corrupting_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """apply()'s post-write round-trip rejects a write that dropped a planned name (AC3)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )
    hook = paths.inject_scope_rules
    original_bytes = hook.read_bytes()

    # Corrupt the write: hand _atomic_replace's before_replace validator a temp
    # file whose content drops the planned name, so the round-trip re-parse in
    # apply() finds it still missing and raises -> clean rollback from .bak.
    def _writes_stale(target: Path, _text: str, *, before_replace=None) -> None:
        stale = target.with_suffix(target.suffix + ".tmp-stale")
        stale.write_text(original_bytes.decode("utf-8"), encoding="utf-8")
        if before_replace is not None:
            before_replace(stale)  # the round-trip validator runs here and raises

    monkeypatch.setattr(inject_sync, "_atomic_replace", _writes_stale)

    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.apply(paths)

    # The corrupting write never landed — the live file is restored byte-identically.
    assert hook.read_bytes() == original_bytes


def test_rollback_restores_from_bak(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A forced mid-transaction failure restores the file byte-identically + exits 5 (AC3)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )
    hook = paths.inject_scope_rules
    original_bytes = hook.read_bytes()

    # Force the atomic write to fail AFTER the .bak backup is taken, exercising
    # the except-branch rollback (hook.write_text(original) restore path).
    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated atomic-replace failure")

    monkeypatch.setattr(inject_sync, "_atomic_replace", _boom)

    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.apply(paths)

    # The live file is restored byte-for-byte from the original (clean rollback).
    assert hook.read_bytes() == original_bytes


def test_rollback_maps_to_exit_tx_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The CLI maps a cleanly-rolled-back sync failure to EXIT_TX_FAILED=5 (AC3)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated atomic-replace failure")

    monkeypatch.setattr("agent_lifecycle.inject_sync._atomic_replace", _boom)

    code = cli_main(["--ga-root", str(paths.ga_root), "sync-inject"])
    assert code == EXIT_TX_FAILED


def test_plan_removes_flags_stale_array_names(tmp_path: Path) -> None:
    """plan_removes returns names present in an array but absent from the roster."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES + ["glass-atrium-dev-gone"],
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        minimalism=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, "glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,  # glass-atrium-dev-gone NOT in the roster -> stale in all 4 arrays
    )
    text = paths.inject_scope_rules.read_text(encoding="utf-8")

    removes = inject_sync.plan_removes(text, set(_DEV_ROSTER))

    assert removes["INJECT_AGENTS"] == ["glass-atrium-dev-gone"]
    assert removes["STYLEREF_AGENTS"] == ["glass-atrium-dev-gone"]
    assert removes["MINIMALISM_AGENTS"] == ["glass-atrium-dev-gone"]
    assert removes["NAMING_AGENTS"] == ["glass-atrium-dev-gone"]


def test_apply_removes_stale_dev_name_from_all_four_arrays(tmp_path: Path) -> None:
    """A name absent from the roster is pruned from every array it sits in (AC7/AC12)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES + ["glass-atrium-dev-gone"],
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        minimalism=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, "glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,
    )

    result = inject_sync.apply(paths)

    assert result.changed
    hook = paths.inject_scope_rules
    assert "glass-atrium-dev-gone" not in _members(hook, "INJECT_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "STYLEREF_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "MINIMALISM_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "NAMING_AGENTS")
    assert result.removed["INJECT_AGENTS"] == ["glass-atrium-dev-gone"]
    assert result.removed["STYLEREF_AGENTS"] == ["glass-atrium-dev-gone"]
    assert result.removed["MINIMALISM_AGENTS"] == ["glass-atrium-dev-gone"]
    assert result.removed["NAMING_AGENTS"] == ["glass-atrium-dev-gone"]
    # roster members survive — only the stale name left.
    assert "glass-atrium-dev-shell" in _members(hook, "STYLEREF_AGENTS")


def test_apply_inserts_and_removes_in_one_transaction(tmp_path: Path) -> None:
    """A single apply() both inserts a missing member AND removes a stale one (AC7)."""
    paths = _write_fixture(
        tmp_path,
        # glass-atrium-dev-newkid missing everywhere; glass-atrium-dev-gone stale everywhere.
        inject=_DEV_ROSTER + _QA_NAMES + ["glass-atrium-dev-gone"],
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        minimalism=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, "glass-atrium-dev-gone"],
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    result = inject_sync.apply(paths)

    hook = paths.inject_scope_rules
    assert "glass-atrium-dev-newkid" in _members(hook, "STYLEREF_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "STYLEREF_AGENTS")
    assert result.inserted["STYLEREF_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.removed["STYLEREF_AGENTS"] == ["glass-atrium-dev-gone"]
    # NAMING (the narrower 4th array) reconciles in the same transaction.
    assert "glass-atrium-dev-newkid" in _members(hook, "NAMING_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "NAMING_AGENTS")
    assert result.inserted["NAMING_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.removed["NAMING_AGENTS"] == ["glass-atrium-dev-gone"]
    # one transaction -> one backup.
    assert result.backup_path is not None
    assert result.backup_path.exists()


def test_apply_noop_when_nothing_to_insert_or_remove(tmp_path: Path) -> None:
    """A clean tree (no inserts AND no removes) is byte+mtime identical, no .bak (AC8)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER,
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER,
    )
    hook = paths.inject_scope_rules
    before_bytes = hook.read_bytes()
    before_mtime = hook.stat().st_mtime_ns

    result = inject_sync.apply(paths)

    assert not result.changed
    assert result.backup_path is None
    assert hook.read_bytes() == before_bytes
    assert hook.stat().st_mtime_ns == before_mtime
    assert not hook.with_suffix(hook.suffix + ".bak").exists()


def test_apply_remove_rollback_restores_byte_identical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A forced failure on a remove-only plan restores the file byte-identically (AC7)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES + ["glass-atrium-dev-gone"],
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        minimalism=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, "glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,
    )
    hook = paths.inject_scope_rules
    original_bytes = hook.read_bytes()

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated atomic-replace failure")

    monkeypatch.setattr(inject_sync, "_atomic_replace", _boom)

    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.apply(paths)

    assert hook.read_bytes() == original_bytes


def test_revalidate_rejects_a_write_that_kept_a_removed_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """apply()'s round-trip rejects a write where a planned-removed name lingers (AC7)."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES + ["glass-atrium-dev-gone"],
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        minimalism=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, "glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,
    )
    hook = paths.inject_scope_rules
    original_bytes = hook.read_bytes()

    # Hand the round-trip validator a temp file that still carries the removed
    # name, so the removed-absent assertion fires -> clean rollback from .bak.
    def _writes_stale(target: Path, _text: str, *, before_replace=None) -> None:
        stale = target.with_suffix(target.suffix + ".tmp-stale")
        stale.write_text(original_bytes.decode("utf-8"), encoding="utf-8")
        if before_replace is not None:
            before_replace(stale)

    monkeypatch.setattr(inject_sync, "_atomic_replace", _writes_stale)

    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.apply(paths)

    assert hook.read_bytes() == original_bytes


def test_run_delete_prunes_scope_dev_roster_stanza(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A DEV delete drops the name from the scope-dev.md roster (AC11), so the
    bidirectional sync then sees it as stale and prunes the arrays (AC12)."""
    from agent_lifecycle import delete as delete_mod
    from agent_lifecycle.delete import DeleteRequest, run_delete

    target = "glass-atrium-dev-doomed"
    roster = _DEV_ROSTER + [target]
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES + [target],
        styleref=_DEV_ROSTER + [target],
        minimalism=_DEV_ROSTER + [target],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, target],
        roster=roster,
    )
    # run_delete now auto-syncs the 3 gate sites after the stanza prune — seed them
    # with the pre-delete roster so the DEV-gated gate-roster-sync step can rebuild.
    _write_gate_sites(paths, roster)

    # The target must be a deletable DEV/user registry row + have a live .md.
    registry = json.loads(paths.registry.read_text(encoding="utf-8"))
    registry["agents"][target] = {"scope": "DEV", "origin": "user", "domains": []}
    paths.registry.write_text(json.dumps(registry), encoding="utf-8")
    (paths.agents_dir).mkdir(parents=True, exist_ok=True)
    paths.agent_md(target).write_text("# stub agent\n", encoding="utf-8")

    # Mock the subprocess-backed cleanup steps at the boundary (no git / scripts
    # in the temp fixture); the scope-dev stanza prune runs for real.
    monkeypatch.setattr(delete_mod, "git_add", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "git_unstage", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "regenerate_manifest", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "swap_symlinks", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "prune_farm_symlink", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "restore_farm_symlink", lambda *_a, **_k: None)

    run_delete(paths, DeleteRequest(name=target, confirm=target, dry_run=False))

    # AC11 — the name left the scope-dev.md roster.
    roster_after = inject_sync.parse_scope_dev_roster(paths)
    assert target not in roster_after

    # AC12 — the now-pruned roster makes the bidirectional sync drop the stale
    # name from all 4 arrays end-to-end.
    result = inject_sync.apply(paths)
    hook = paths.inject_scope_rules
    assert target not in _members(hook, "INJECT_AGENTS")
    assert target not in _members(hook, "STYLEREF_AGENTS")
    assert target not in _members(hook, "MINIMALISM_AGENTS")
    assert target not in _members(hook, "NAMING_AGENTS")
    assert result.removed["INJECT_AGENTS"] == [target]
    assert result.removed["NAMING_AGENTS"] == [target]


def test_orphan_scan_is_lint_only_no_write(tmp_path: Path) -> None:
    """orphan-scan detects the mismatch but writes nothing — only sync-inject mutates."""
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES,
        styleref=_DEV_ROSTER,
        minimalism=_DEV_ROSTER[:-1],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME],
        roster=_DEV_ROSTER,
    )
    hook = paths.inject_scope_rules
    before_bytes = hook.read_bytes()
    before_mtime = hook.stat().st_mtime_ns

    # The orphan-scan CLI path (no sync verb) only reports — exit 0, no mutation.
    code = cli_main(
        [
            "--ga-root",
            str(paths.ga_root),
            "orphan-scan",
            "--mode",
            "inject-list-mismatch",
        ]
    )

    assert code == EXIT_OK
    assert hook.read_bytes() == before_bytes
    assert hook.stat().st_mtime_ns == before_mtime
    assert not hook.with_suffix(hook.suffix + ".bak").exists()


def test_run_delete_auto_wires_gate_roster_sync(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A DEV run_delete auto-wires gate-roster-sync: deleted name is absent from the
    DEV_SET bash strings in both hook files AND from every SQL IN-list in gate-audit.sh
    immediately after the delete (no manual gate_roster_sync.apply() call needed).
    """
    from agent_lifecycle import delete as delete_mod
    from agent_lifecycle.delete import DeleteRequest, run_delete

    target = "glass-atrium-dev-doomed"
    roster = _DEV_ROSTER + [target]
    paths = _write_fixture(
        tmp_path,
        inject=_DEV_ROSTER + _QA_NAMES + [target],
        styleref=_DEV_ROSTER + [target],
        minimalism=_DEV_ROSTER + [target],
        naming=_DEV_ROSTER + [_NAMING_QA_NAME, target],
        roster=roster,
    )
    # Seed the 3 gate sites with the pre-delete roster so gate-roster-sync can
    # find and rebuild them (an absent gate file is a loud-fail in production).
    _write_gate_sites(paths, roster)

    # The target must be a deletable DEV/user registry row + have a live .md.
    registry = json.loads(paths.registry.read_text(encoding="utf-8"))
    registry["agents"][target] = {"scope": "DEV", "origin": "user", "domains": []}
    paths.registry.write_text(json.dumps(registry), encoding="utf-8")
    paths.agents_dir.mkdir(parents=True, exist_ok=True)
    paths.agent_md(target).write_text("# stub agent\n", encoding="utf-8")

    # Mock subprocess-backed boundary steps (no git / scripts in the temp fixture).
    monkeypatch.setattr(delete_mod, "git_add", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "git_unstage", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "regenerate_manifest", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "swap_symlinks", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "prune_farm_symlink", lambda *_a, **_k: None)
    monkeypatch.setattr(delete_mod, "restore_farm_symlink", lambda *_a, **_k: None)

    run_delete(paths, DeleteRequest(name=target, confirm=target, dry_run=False))

    # Both DEV_SET bash strings must no longer carry the deleted name.
    vg_names = parse_dev_set_text(
        paths.enforce_verification_gate.read_text(encoding="utf-8")
    )
    wv_names = parse_dev_set_text(
        paths.enforce_workflow_verify_stage.read_text(encoding="utf-8")
    )
    assert target not in vg_names, (
        f"deleted name still in enforce-verification-gate DEV_SET: {vg_names}"
    )
    assert target not in wv_names, (
        f"deleted name still in enforce-workflow-verify-stage DEV_SET: {wv_names}"
    )

    # Both SQL IN-list occurrences in gate-audit.sh must no longer carry the name.
    sql_occurrences = parse_sql_in_list_text(
        paths.gate_audit.read_text(encoding="utf-8")
    )
    for occ in sql_occurrences:
        assert target not in occ, (
            f"deleted name still in gate-audit.sh SQL IN-list: {occ}"
        )
