"""Behavioral tests for the inject-scope-rules.sh 2-tracked-array sync (plan T4 / AC1-AC4).

Covers the `agent_lifecycle.inject_sync` transactional reconcile + the
`sync-inject` CLI verb against a disposable `--ga-root` temp fixture (never the
live ~/.glass-atrium tree):

  - insert-when-missing: a missing DEV name lands in every tracked array its
    predicate covers (AC1).
  - BUDGET_DEV_AGENTS: reconciles to DEV roster − the shared
    _BUDGET_DAEMON_CARRIERS exclusions; a carrier is never inserted and is
    pruned when present. The untracked BUDGET_ANALYSIS_AGENTS line stays
    byte-identical across a reconcile run.
  - idempotent no-op: a clean tree leaves the hook file byte- AND mtime-identical
    (AC2).
  - STYLEREF specifically: a single-array drift is detected AND fixed in
    isolation (AC4).
  - retired arrays: a stale live hook still carrying a retired roster line is
    neither parsed nor rewritten, so it cannot break the reconcile.
  - round-trip rejects a corrupting edit: an insert that would drop a prior member
    raises rather than landing a lossy write.
  - rollback restores from .bak: a forced mid-transaction failure leaves the live
    file byte-identical to the pre-run original (AC3) and exits non-zero.
  - bidirectional reconcile: plan_removes flags stale names, apply() removes a
    stale name from every tracked array + inserts and removes in one tx, the no-op
    short-circuit covers "no inserts AND no removes", remove-rollback restores
    byte-identical, and the round-trip rejects a write keeping a removed name (AC7/AC8).
  - delete-side stanza prune: run_delete drops the DEV name from the scope-dev.md
    roster (AC11) so the bidirectional sync then prunes every tracked array (AC12). Both
    real-`run_delete` tests redirect ~/.Trash into their tmp dir and assert the
    .md landed there, so the shipped mv-to-Trash step is exercised and asserted
    without depositing a file in the operator's Trash on every suite run.
  - orphan-scan stays lint-only: detection without the sync verb writes nothing.

Run with:
    uv run --python 3.13 --with pytest pytest scripts/test/test_inject_sync.py -v

CID: 2026-06-18T_skill-reconcile-impl_e3c7
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle import gate_roster_sync, inject_sync, readers  # noqa: E402
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

# The DEV roster the live scope-dev.md brace list carries. The fixture builder
# appends extra names per test.
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
# The untracked, manual-curated analysis roster — written into every fixture so
# tests can prove the reconcile leaves it byte-identical (D5: not roster-derivable).
_BUDGET_ANALYSIS = [
    "glass-atrium-intel-planner",
    "glass-atrium-intel-reporter",
    "glass-atrium-qa-code-reviewer",
    "glass-atrium-design-designer",
    "glass-atrium-meta-agent",
    "glass-atrium-wiki-curator",
]


def _budget_dev_expected(roster: list[str]) -> list[str]:
    """BUDGET_DEV_AGENTS in-sync membership: roster − the SHARED carrier constant.

    Derives from the production `inject_sync._BUDGET_DAEMON_CARRIERS` so the
    predicate has exactly one home; the literal 4-name governance pin lives in
    test_budget_daemon_carriers_pin.
    """
    return [n for n in roster if n not in inject_sync._BUDGET_DAEMON_CARRIERS]


def _array_line(var: str, names: list[str]) -> str:
    """A `readonly VAR=" a b c "` line mirroring the live space-padded format."""
    return f'readonly {var}="{" " + " ".join(names) + " " if names else " "}"'


def _write_fixture(
    root: Path,
    *,
    styleref: list[str],
    roster: list[str],
    budget_dev: list[str] | None = None,
) -> StorePaths:
    """Build a minimal but valid GA store under `root` (disposable temp tree).

    Writes the stores `run_scan(['inject-list-mismatch'])` + inject_sync touch:
    the inject hook (the tracked BUDGET_DEV array plus the untracked
    BUDGET_ANALYSIS line), the roster lib (the tracked STYLEREF
    array), scope-dev.md (roster brace list), and the registry + manifest JSON
    (load_json raises on a missing manifest). `budget_dev=None` defaults to the
    in-sync roster − carriers set.

    The untracked line is written deliberately: a fixture carrying only the
    tracked arrays could not catch a reconcile that reached past its own set.
    """
    (root / "hooks").mkdir(parents=True, exist_ok=True)
    (root / "scoped").mkdir(parents=True, exist_ok=True)

    if budget_dev is None:
        budget_dev = _budget_dev_expected(roster)

    hook = root / "hooks" / "inject-scope-rules.sh"
    hook.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"{_array_line('BUDGET_DEV_AGENTS', budget_dev)}\n"
        f"{_array_line('BUDGET_ANALYSIS_AGENTS', _BUDGET_ANALYSIS)}\n",
        encoding="utf-8",
    )

    # STYLEREF_AGENTS is the one tracked array declared outside the hook — the
    # declaration-only roster lib the hook and the flag predicate both source.
    roster_lib = root / "hooks" / "lib" / "styleref-roster.sh"
    roster_lib.parent.mkdir(parents=True, exist_ok=True)
    roster_lib.write_text(
        "#!/usr/bin/env bash\n"
        f"{_array_line('STYLEREF_AGENTS', styleref)}\n",
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


def _declaration_text(hook: Path) -> str:
    """The parse surface the reconcile reads: both declaration files, joined."""
    roster_lib = hook.parent / "lib" / "styleref-roster.sh"
    return (
        hook.read_text(encoding="utf-8")
        + "\n"
        + roster_lib.read_text(encoding="utf-8")
    )


def _members(hook: Path, var: str) -> list[str]:
    """Token members of a TRACKED array, re-parsed through the production reader."""
    return inject_sync.parse_inject_text(_declaration_text(hook))[var]


_RAW_ARRAY_RE_TMPL = r'^\s*readonly {var}="(?P<body>[^"]*)"\s*$'


def _raw_members(hook: Path, var: str) -> list[str]:
    """Token members of an UNTRACKED array, read WITHOUT the production reader.

    The production reader parses only the tracked set, so an untracked array has
    to be read some other way or a test could not assert that the reconcile left
    it alone.
    """
    match = re.search(
        _RAW_ARRAY_RE_TMPL.format(var=var), _declaration_text(hook), re.MULTILINE
    )
    assert match is not None, f"{var} array not present in the fixture"
    return match.group("body").split()


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


def _redirect_trash(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point ~/.Trash into this test's tmp dir and return the redirected dir.

    run_delete moves the real .md to ~/.Trash by design (GLOBAL_RULES forbids `rm`
    on source files), and `delete._trash_path` composes that target from
    `Path.home()`, which reads $HOME. Redirecting the VARIABLE rather than patching
    the composer keeps the shipped composition — the `.al-deleted-<ts>` tag included
    — under test, while stopping every run of this suite from depositing a file in
    the operator's real Trash. Blast radius is one path: the only other
    `Path.home()` in the package (`subproc.target_home`) is reached solely when
    ga_root IS the default root, and these tests run against a tmp root.
    """
    home = tmp_path / "trash-home"
    trash = home / ".Trash"
    trash.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    return trash


def _assert_trashed(trash: Path, paths: StorePaths, name: str) -> None:
    """The .md left agents/ and landed in the redirected Trash under its delete tag."""
    landed = sorted(trash.glob(f"{name}.md.al-deleted-*"))
    assert len(landed) == 1, (
        f"expected exactly one trashed {name}.md, found {[p.name for p in landed]}"
    )
    assert not paths.agent_md(name).exists()


def test_insert_when_missing_dev_lands_in_every_tracked_array(tmp_path: Path) -> None:
    """A roster DEV name absent from every array is inserted into each tracked one (AC1).

    glass-atrium-dev-newkid is not a daemon carrier, so it is expected in
    BUDGET_DEV_AGENTS as well as STYLEREF_AGENTS. The untracked
    governance roster is equally short of the name and MUST stay that way — the
    reconcile's reach is its tracked set, not every array it can see.
    """
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
        budget_dev=_budget_dev_expected(_DEV_ROSTER),
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    result = inject_sync.apply(paths)

    assert result.changed
    hook = paths.inject_scope_rules
    for tracked in readers._TRACKED_INJECT_ARRAYS:
        assert "glass-atrium-dev-newkid" in _members(hook, tracked)
        assert result.inserted[tracked] == ["glass-atrium-dev-newkid"]
    assert set(result.inserted) == set(readers._TRACKED_INJECT_ARRAYS)
    assert "glass-atrium-dev-newkid" not in _raw_members(hook, "BUDGET_ANALYSIS_AGENTS")


def test_idempotent_noop_leaves_file_unchanged(tmp_path: Path) -> None:
    """A clean tree is a no-op: same bytes AND same mtime, no .bak written (AC2)."""
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
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


def test_styleref_specifically_detected_and_fixed(tmp_path: Path) -> None:
    """STYLEREF drift is detected AND fixed in isolation, the other one intact (AC4).

    STYLEREF_AGENTS is the roster the style_ref omission flag holds responsible,
    so a DEV name missing from it escapes that flag — the scan reports that name
    specifically and the write repairs only that array.
    """
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER[:-1],  # only STYLEREF is missing glass-atrium-dev-shell
        roster=_DEV_ROSTER,
    )
    hook = paths.inject_scope_rules

    # Detection: the read-only scan reports the STYLEREF-specific miss.
    findings = run_scan(paths, ["inject-list-mismatch"]).by_mode("inject-list-mismatch")
    assert any(
        f.name == "glass-atrium-dev-shell" and "STYLEREF_AGENTS" in f.detail for f in findings
    ), (
        f"expected a STYLEREF glass-atrium-dev-shell miss, got {[(f.name, f.detail) for f in findings]}"
    )

    # Fix: only STYLEREF changes; the other one was already in sync.
    result = inject_sync.apply(paths)
    assert result.inserted["STYLEREF_AGENTS"] == ["glass-atrium-dev-shell"]
    assert result.inserted["BUDGET_DEV_AGENTS"] == []
    assert result.removed["BUDGET_DEV_AGENTS"] == []
    assert "glass-atrium-dev-shell" in _members(hook, "STYLEREF_AGENTS")


def test_retired_array_line_is_neither_parsed_nor_rewritten(tmp_path: Path) -> None:
    """A stale hook still carrying a retired roster line cannot break the reconcile.

    The retired INJECT_AGENTS line is written out of sync with the roster on
    purpose (a stale name, a missing DEV name): a reconcile that still parsed it
    would report or rewrite it. A real rewrite of the tracked arrays must leave
    that line byte-identical and name it in no plan entry.
    """
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],  # forces a real rewrite
    )
    hook = paths.inject_scope_rules
    retired_line = _array_line(
        "INJECT_AGENTS", _DEV_ROSTER[:-1] + ["glass-atrium-dev-gone"]
    )
    hook.write_text(hook.read_text(encoding="utf-8") + retired_line + "\n", encoding="utf-8")

    parsed = inject_sync.parse_inject_text(_declaration_text(hook))
    assert set(parsed) == set(readers._TRACKED_INJECT_ARRAYS)
    assert "INJECT_AGENTS" not in parsed

    result = inject_sync.apply(paths)

    assert result.changed
    assert retired_line in hook.read_text(encoding="utf-8").splitlines()
    assert "INJECT_AGENTS" not in result.inserted
    assert "INJECT_AGENTS" not in result.removed


def test_round_trip_rejects_when_array_missing() -> None:
    """The insert core raises (not silently no-ops) when its array is unparseable."""
    # Documented round-trip guard: an array assignment the regex cannot locate
    # after the edit is a hard InjectSyncError, never a silent skip.
    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.insert_name_in_array("# no arrays here\n", "STYLEREF_AGENTS", "dev-x")
    with pytest.raises(inject_sync.InjectSyncError):
        inject_sync.insert_name_in_array("anything", "BOGUS_AGENTS", "dev-x")


def test_round_trip_rejects_a_corrupting_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """apply()'s post-write round-trip rejects a write that dropped a planned name (AC3)."""
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
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
        styleref=_DEV_ROSTER,
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
        styleref=_DEV_ROSTER,
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
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        budget_dev=_budget_dev_expected(_DEV_ROSTER) + ["glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,  # glass-atrium-dev-gone NOT in the roster -> stale in every tracked array
    )
    text = (
        paths.inject_scope_rules.read_text(encoding="utf-8")
        + "\n"
        + paths.styleref_roster.read_text(encoding="utf-8")
    )

    removes = inject_sync.plan_removes(text, set(_DEV_ROSTER))

    for tracked in readers._TRACKED_INJECT_ARRAYS:
        assert removes[tracked] == ["glass-atrium-dev-gone"]
    # the untracked governance roster yields no plan entry, whatever it holds.
    assert set(removes) == set(readers._TRACKED_INJECT_ARRAYS)


def test_apply_removes_stale_dev_name_from_every_tracked_array(tmp_path: Path) -> None:
    """A name absent from the roster is pruned from every TRACKED array (AC7/AC12)."""
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        budget_dev=_budget_dev_expected(_DEV_ROSTER) + ["glass-atrium-dev-gone"],
        roster=_DEV_ROSTER,
    )

    result = inject_sync.apply(paths)

    assert result.changed
    hook = paths.inject_scope_rules
    for tracked in readers._TRACKED_INJECT_ARRAYS:
        assert "glass-atrium-dev-gone" not in _members(hook, tracked)
        assert result.removed[tracked] == ["glass-atrium-dev-gone"]
    # roster members survive — only the stale name left.
    assert "glass-atrium-dev-shell" in _members(hook, "STYLEREF_AGENTS")


def test_apply_inserts_and_removes_in_one_transaction(tmp_path: Path) -> None:
    """A single apply() both inserts a missing member AND removes a stale one (AC7)."""
    paths = _write_fixture(
        tmp_path,
        # glass-atrium-dev-newkid missing everywhere; glass-atrium-dev-gone stale everywhere.
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
        budget_dev=_budget_dev_expected(_DEV_ROSTER) + ["glass-atrium-dev-gone"],
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],
    )

    result = inject_sync.apply(paths)

    hook = paths.inject_scope_rules
    assert "glass-atrium-dev-newkid" in _members(hook, "STYLEREF_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "STYLEREF_AGENTS")
    assert result.inserted["STYLEREF_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.removed["STYLEREF_AGENTS"] == ["glass-atrium-dev-gone"]
    # BUDGET_DEV reconciles in the same transaction, in the other file.
    assert "glass-atrium-dev-newkid" in _members(hook, "BUDGET_DEV_AGENTS")
    assert "glass-atrium-dev-gone" not in _members(hook, "BUDGET_DEV_AGENTS")
    assert result.inserted["BUDGET_DEV_AGENTS"] == ["glass-atrium-dev-newkid"]
    assert result.removed["BUDGET_DEV_AGENTS"] == ["glass-atrium-dev-gone"]
    # one transaction -> one backup.
    assert result.backup_path is not None
    assert result.backup_path.exists()


def test_budget_daemon_carriers_pin() -> None:
    """Governance pin: the shared carrier constant is exactly the 4 daemon-owned
    in-body bullet carriers (D2) — edited only when the daemon adds/removes one."""
    assert inject_sync._BUDGET_DAEMON_CARRIERS == {
        "glass-atrium-dev-nestjs",
        "glass-atrium-dev-python",
        "glass-atrium-dev-react",
        "glass-atrium-dev-shell",
    }


def test_budget_dev_carrier_never_inserted_and_pruned_when_present(
    tmp_path: Path,
) -> None:
    """Predicate honesty (D5): BUDGET_DEV = roster − carriers — a daemon carrier
    in the roster is never inserted, and one sitting in the array is pruned as
    stale, while the carrier-inclusive arrays keep it."""
    # BUDGET_DEV drifts twice: missing dev-front (a member) + carrying dev-react
    # (a carrier — in the roster, but excluded by the predicate).
    drifted = [
        n for n in _budget_dev_expected(_DEV_ROSTER) if n != "glass-atrium-dev-front"
    ]
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
        budget_dev=drifted + ["glass-atrium-dev-react"],
        roster=_DEV_ROSTER,
    )

    result = inject_sync.apply(paths)

    hook = paths.inject_scope_rules
    assert result.inserted["BUDGET_DEV_AGENTS"] == ["glass-atrium-dev-front"]
    assert result.removed["BUDGET_DEV_AGENTS"] == ["glass-atrium-dev-react"]
    assert not (
        set(_members(hook, "BUDGET_DEV_AGENTS")) & inject_sync._BUDGET_DAEMON_CARRIERS
    )
    # the carrier stays a member of STYLEREF, which carries the roster whole.
    assert "glass-atrium-dev-react" in _members(hook, "STYLEREF_AGENTS")
    assert result.inserted["STYLEREF_AGENTS"] == []
    assert result.removed["STYLEREF_AGENTS"] == []


def test_budget_analysis_untracked_stays_byte_identical(tmp_path: Path) -> None:
    """The manual-curated BUDGET_ANALYSIS_AGENTS array is never reconciled: a run
    that rewrites tracked arrays leaves its line byte-identical and reports no
    plan entry for it (D5 regression pin)."""
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
        budget_dev=_budget_dev_expected(_DEV_ROSTER),
        roster=_DEV_ROSTER + ["glass-atrium-dev-newkid"],  # forces a real rewrite
    )
    analysis_line = _array_line("BUDGET_ANALYSIS_AGENTS", _BUDGET_ANALYSIS)
    hook = paths.inject_scope_rules
    assert analysis_line in hook.read_text(encoding="utf-8")

    result = inject_sync.apply(paths)

    assert result.changed
    # a naive roster predicate would have pruned every analysis name (none are in
    # the DEV roster) — the line surviving byte-identical proves it is untracked.
    assert analysis_line in hook.read_text(encoding="utf-8")
    assert "BUDGET_ANALYSIS_AGENTS" not in result.inserted
    assert "BUDGET_ANALYSIS_AGENTS" not in result.removed


def test_apply_noop_when_nothing_to_insert_or_remove(tmp_path: Path) -> None:
    """A clean tree (no inserts AND no removes) is byte+mtime identical, no .bak (AC8)."""
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
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
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
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
        styleref=_DEV_ROSTER + ["glass-atrium-dev-gone"],
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
        styleref=_DEV_ROSTER + [target],
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
    trash = _redirect_trash(monkeypatch, tmp_path)

    run_delete(paths, DeleteRequest(name=target, confirm=target, dry_run=False))

    # Step 1 of the delete is a real mv-to-Trash, asserted against the redirected
    # target — the move is now proven rather than merely landing in the operator's
    # Trash unobserved.
    _assert_trashed(trash, paths, target)

    # AC11 — the name left the scope-dev.md roster.
    roster_after = inject_sync.parse_scope_dev_roster(paths)
    assert target not in roster_after

    # AC12 — the now-pruned roster makes the bidirectional sync drop the stale
    # name from both tracked arrays end-to-end (the fixture's default budget_dev
    # derives from the pre-delete roster, so it carried the target too).
    result = inject_sync.apply(paths)
    hook = paths.inject_scope_rules
    assert target not in _members(hook, "STYLEREF_AGENTS")
    assert target not in _members(hook, "BUDGET_DEV_AGENTS")
    assert result.removed["STYLEREF_AGENTS"] == [target]
    assert result.removed["BUDGET_DEV_AGENTS"] == [target]


def test_orphan_scan_is_lint_only_no_write(tmp_path: Path) -> None:
    """orphan-scan detects the mismatch but writes nothing — only sync-inject mutates."""
    paths = _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER[:-1],
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
        styleref=_DEV_ROSTER + [target],
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
    trash = _redirect_trash(monkeypatch, tmp_path)

    run_delete(paths, DeleteRequest(name=target, confirm=target, dry_run=False))

    _assert_trashed(trash, paths, target)

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


# ── D03 second placement — the reconcile step's registry ↔ Scope Legend assertion ──
#
# The predicate itself lives in hooks/validate-compliance-matrix.sh (--roster-check),
# tested in hooks/test/validate-compliance-matrix.bats. These cases pin the LIFECYCLE
# half: sync-inject invokes it as a subprocess, branches on its exit status, and stays
# non-blocking (a doc-row is a manual governance update; gating here would strand an
# already-committed transaction).

_VALIDATOR_SRC = _SCRIPTS_ROOT.parent / "hooks" / "validate-compliance-matrix.sh"

# The roster layer fails OPEN without jq, so a jq-less runner would prove nothing.
_NEEDS_JQ = pytest.mark.skipif(shutil.which("jq") is None, reason="jq not on PATH")


def _install_matrix_fixture(paths: StorePaths, legend_agents: list[str]) -> None:
    """Copy the real validator into the temp root + write a matrix it can parse."""
    dst = paths.compliance_validator
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(_VALIDATOR_SRC.read_text(encoding="utf-8"), encoding="utf-8")
    dst.chmod(0o755)

    matrix = paths.compliance_matrix
    matrix.parent.mkdir(parents=True, exist_ok=True)
    matrix.write_text(
        "# Rule-to-Agent Compliance Matrix\n\n"
        "## Scope Legend\n\n"
        "| Scope | Agents |\n"
        "|-------|--------|\n"
        "| ALL | All agents |\n"
        f"| DEV | {', '.join(legend_agents)} |\n",
        encoding="utf-8",
    )


def _sync_inject(paths: StorePaths) -> int:
    return cli_main(["--ga-root", str(paths.ga_root), "sync-inject"])


def _clean_fixture(tmp_path: Path) -> StorePaths:
    """An already-in-sync array fixture: the reconcile is a no-op, so only the
    post-commit roster assertion can produce output."""
    return _write_fixture(
        tmp_path,
        styleref=_DEV_ROSTER,
        roster=_DEV_ROSTER,
    )


@_NEEDS_JQ
def test_sync_inject_warns_on_scope_legend_roster_drift(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A registered agent missing from the Scope Legend is NAMED; the exit stays OK."""
    paths = _clean_fixture(tmp_path)
    # Legend lists every roster name but the last one -> registered-but-unlisted.
    _install_matrix_fixture(paths, _DEV_ROSTER[:-1])
    missing = _DEV_ROSTER[-1]

    code = _sync_inject(paths)
    err = capsys.readouterr().err

    assert code == EXIT_OK, "the doc assertion must not gate the reconcile"
    assert "roster drift" in err, err
    assert missing in err, err


@_NEEDS_JQ
def test_sync_inject_quiet_when_roster_agrees(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Registry and Scope Legend in agreement -> no warning at all."""
    paths = _clean_fixture(tmp_path)
    _install_matrix_fixture(paths, _DEV_ROSTER)

    code = _sync_inject(paths)
    err = capsys.readouterr().err

    assert code == EXIT_OK
    assert "roster drift" not in err, err


def test_sync_inject_skips_roster_assertion_when_validator_absent(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """No validator in the tree -> the assertion is a silent no-op (fail-open)."""
    paths = _clean_fixture(tmp_path)
    assert not paths.compliance_validator.exists()

    code = _sync_inject(paths)
    err = capsys.readouterr().err

    assert code == EXIT_OK
    assert "roster drift" not in err, err
