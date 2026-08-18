"""Composition pin for compose_daemon_run_apply_status in _pg_dual_write_daemon.py.

The op folds an apply-stage verdict INTO a row whose status already carries patch
generation's own verdict. The whole point is COMPOSITION: an apply outcome must
never erase a generation verdict. A plain `SET status = <apply_status>` overwrite
would satisfy the driver, pass every other suite, and silently reintroduce that
erasure — so the semantics need a test that goes red on exactly that edit.

Two shapes beyond that erasure are pinned here, both of which read green on every
other surface while the operator sees a stale status. A token the swap does not
compose leaves the row untouched yet still matches it, so the matched-nothing
guard stays silent and the driver logs a clean end — pinned by the refusal cases.
And a token declared in one place only (constant, SQL, docstring or CLI header)
makes the contract lie about itself — pinned by the declaration-parity case.

The preserving arm's SILENCE is pinned separately from its behaviour, and the two
must not be confused: preserving the generation verdict is the contract, while
reporting nothing when it happens is the defect. The row is selected by key, so
the CASE matches on both arms — the matched-row count reports a hit, the
matched-nothing guard stays quiet, and apply health is dropped unrecorded. Both
polarities are therefore pinned: a decline names itself durably, on stdout and on
stderr, AND the status it declined to overwrite still survives untouched.

Why a shim instead of a live database: the op's SQL is PG-specific (schema-
qualified table, `::core."DaemonStatus"` casts) and the 'apply_failed' enum label
ships as an unapplied migration, so a live run fails for reasons unrelated to the
CASE. The shared psycopg stand-in (scripts/test/_pg_stub_backend.py, reached here
through the same PYTHONPATH mechanism as the exit-contract suite) hands the
helper's REAL SQL text to sqlite3 after two mechanical rewrites. The
CASE arms are therefore evaluated by a real SQL engine, never re-implemented here
— which is what keeps the pin failable.

Run with:
    python3 -m pytest scripts/test/test_pg_dual_write_compose_apply_status.py -v

CID: 2026-08-02T2200_round6-fixes_e1a7
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

import _pg_stub_backend as stub

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
_HELPER = _SCRIPTS_ROOT / "_pg_dual_write_daemon.py"

_TIMEOUT_S = 30
_DAEMON = "autoagent"
_RUN_DATE = "2026-08-02"
# Apply-script unavailability (absent or non-executable) — the third composable token.
_UNAVAILABLE = "apply_unavailable"
# Named CLI code for a token the enum cannot store (helper header exit-semantics table).
_EXIT_UNSUPPORTED_TOKEN = 6
# Provenance vocabulary — stated here independently of the helper and pinned against it, so a
# rename in one place goes red instead of silently agreeing with itself.
_COMPOSED = "composed:"
_DECLINED = "declined:"
_PROVENANCE_COLUMN = "apply_status_provenance"

def _make_env(tmp_path: Path, *, provenance_column: bool) -> dict[str, str]:
    stub.create_psycopg_package(tmp_path)

    db_path = tmp_path / "daemon_runs.sqlite"
    columns = "run_date TEXT, daemon_name TEXT, status TEXT"
    if provenance_column:
        columns += ", apply_status_provenance TEXT"
    with closing(sqlite3.connect(db_path)) as db:
        db.execute("CREATE TABLE daemon_runs (%s)" % columns)
        db.commit()

    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(tmp_path), env["PYTHONPATH"]] if env.get("PYTHONPATH") else [str(tmp_path)]
    )
    env[stub.SQLITE_PATH_ENV] = str(db_path)
    return env


@pytest.fixture
def pg_shim(tmp_path: Path) -> dict[str, str]:
    """PYTHONPATH-prepended psycopg stand-in plus the sqlite file it writes to."""
    return _make_env(tmp_path, provenance_column=True)


@pytest.fixture
def pg_shim_premigration(tmp_path: Path) -> dict[str, str]:
    """The same stand-in over a daemon_runs that predates the provenance migration.

    The state every install holds between a release bundle landing and its migration being
    applied — and the update path applies none, so it is reachable on every machine.
    """
    return _make_env(tmp_path, provenance_column=False)


def _seed(env: dict[str, str], status: str) -> None:
    with closing(sqlite3.connect(env[stub.SQLITE_PATH_ENV])) as db:
        db.execute(
            "INSERT INTO daemon_runs (run_date, daemon_name, status) VALUES (?, ?, ?)",
            (_RUN_DATE, _DAEMON, status),
        )
        db.commit()


def _get_status(env: dict[str, str]) -> str | None:
    with closing(sqlite3.connect(env[stub.SQLITE_PATH_ENV])) as db:
        row = db.execute(
            "SELECT status FROM daemon_runs WHERE run_date = ? AND daemon_name = ?",
            (_RUN_DATE, _DAEMON),
        ).fetchone()
    return row[0] if row else None


def _get_provenance(env: dict[str, str]) -> str | None:
    with closing(sqlite3.connect(env[stub.SQLITE_PATH_ENV])) as db:
        row = db.execute(
            "SELECT apply_status_provenance FROM daemon_runs "
            "WHERE run_date = ? AND daemon_name = ?",
            (_RUN_DATE, _DAEMON),
        ).fetchone()
    return row[0] if row else None


def _stdout_provenance(result) -> str | None:
    """The trailer line's value, or None when the run reported no provenance."""
    for line in result.stdout.splitlines()[1:]:
        if line.startswith("provenance="):
            return line.split("=", 1)[1]
    return None


def _compose(env: dict[str, str], apply_status: str):
    envelope = json.dumps(
        {
            "op": "compose_daemon_run_apply_status",
            "args": {
                "daemon_name": _DAEMON,
                "run_date": _RUN_DATE,
                "apply_status": apply_status,
            },
        }
    )
    return subprocess.run(
        [sys.executable, str(_HELPER)],
        input=envelope,
        text=True,
        capture_output=True,
        timeout=_TIMEOUT_S,
        env=env,
        check=False,
    )


_GENERATION_VERDICTS = ["quota_exceeded", "partial", "error", "missing", "stale"]


@pytest.mark.parametrize("generation_verdict", _GENERATION_VERDICTS)
def test_when_generation_failed_then_apply_failure_preserves_its_verdict(
    pg_shim: dict[str, str], generation_verdict: str
):
    # The erasure this op exists to prevent: a plain overwrite reports the apply
    # stage's verdict over a generation verdict that is strictly more informative.
    _seed(pg_shim, generation_verdict)

    result = _compose(pg_shim, "apply_failed")

    assert result.returncode == 0
    assert _get_status(pg_shim) == generation_verdict


@pytest.mark.parametrize("generation_verdict", _GENERATION_VERDICTS)
def test_when_generation_failed_then_clean_apply_preserves_its_verdict(
    pg_shim: dict[str, str], generation_verdict: str
):
    _seed(pg_shim, generation_verdict)

    result = _compose(pg_shim, "ok")

    assert result.returncode == 0
    assert _get_status(pg_shim) == generation_verdict


def test_when_row_is_ok_then_apply_failure_composes_in(pg_shim: dict[str, str]):
    _seed(pg_shim, "ok")

    result = _compose(pg_shim, "apply_failed")

    assert result.returncode == 0
    assert _get_status(pg_shim) == "apply_failed"


def test_when_row_is_apply_failed_then_clean_apply_clears_it(pg_shim: dict[str, str]):
    # The reverse swap keeps a same-date re-run from inheriting a stale verdict.
    _seed(pg_shim, "apply_failed")

    result = _compose(pg_shim, "ok")

    assert result.returncode == 0
    assert _get_status(pg_shim) == "ok"


def test_when_no_run_row_exists_then_nothing_is_inserted_and_silence_is_reported(
    pg_shim: dict[str, str],
):
    result = _compose(pg_shim, "apply_failed")

    assert result.returncode == 0
    assert _get_status(pg_shim) is None
    assert "matched no run row" in result.stderr


def test_when_row_is_ok_then_unavailability_composes_in(pg_shim: dict[str, str]):
    # The third arm. Against the two-arm swap this token changed nothing while the
    # matched-row count still reported a hit — deployed, green everywhere, inert.
    _seed(pg_shim, "ok")

    result = _compose(pg_shim, _UNAVAILABLE)

    assert result.returncode == 0
    assert _get_status(pg_shim) == _UNAVAILABLE


@pytest.mark.parametrize("generation_verdict", _GENERATION_VERDICTS)
def test_when_generation_failed_then_unavailability_preserves_its_verdict(
    pg_shim: dict[str, str], generation_verdict: str
):
    _seed(pg_shim, generation_verdict)

    result = _compose(pg_shim, _UNAVAILABLE)

    assert result.returncode == 0
    assert _get_status(pg_shim) == generation_verdict


@pytest.mark.parametrize(
    ("seeded", "composed"),
    [
        (_UNAVAILABLE, "ok"),          # the script came back → the stale warn clears
        (_UNAVAILABLE, "apply_failed"),  # executable again, then aborted
        ("apply_failed", _UNAVAILABLE),  # executable bit lost after an abort
    ],
)
def test_when_row_carries_an_apply_verdict_then_the_latest_one_replaces_it(
    pg_shim: dict[str, str], seeded: str, composed: str
):
    # Every apply-owned status swaps to every other in both directions, so a same-date
    # re-run never inherits a verdict from the run before it.
    _seed(pg_shim, seeded)

    result = _compose(pg_shim, composed)

    assert result.returncode == 0
    assert _get_status(pg_shim) == composed


@pytest.mark.parametrize("token", ["apply_skipped", "OK", "", "ok; DROP TABLE core"])
def test_when_token_is_unsupported_then_row_unchanged_and_refusal_is_named(
    pg_shim: dict[str, str], token: str
):
    # The enum cannot store these, and the matched-row count cannot detect them: a CASE
    # fall-through matches the row, reports a hit and exits clean. Refusal must be loud.
    _seed(pg_shim, "ok")

    result = _compose(pg_shim, token)

    assert result.returncode == _EXIT_UNSUPPORTED_TOKEN
    assert _get_status(pg_shim) == "ok"
    assert "pg_write=refused" in result.stderr
    assert "apply health NOT recorded" in result.stderr
    assert "pg_write=ok" not in result.stderr


@pytest.mark.parametrize("generation_verdict", _GENERATION_VERDICTS)
def test_when_the_compose_is_declined_then_the_decline_names_itself_on_every_channel(
    pg_shim: dict[str, str], generation_verdict: str
):
    # The silence this task removes. The row matches on the preserving arm too, so the
    # matched-nothing guard cannot fire and a driver reading only the exit code sees a clean
    # compose that recorded nothing. Durable row, driver-read stdout, operator-read stderr.
    _seed(pg_shim, generation_verdict)

    result = _compose(pg_shim, "ok")

    assert result.returncode == 0
    assert _get_provenance(pg_shim) == "%s%s" % (_DECLINED, generation_verdict)
    assert _stdout_provenance(result) == "%s%s" % (_DECLINED, generation_verdict)
    assert "declined apply_status=ok" in result.stderr
    assert generation_verdict in result.stderr
    assert "apply health NOT recorded" in result.stderr
    # The other polarity, restated where the decline is asserted: naming the decline must not
    # start overwriting the verdict it declined.
    assert _get_status(pg_shim) == generation_verdict


@pytest.mark.parametrize("apply_status", ["ok", "apply_failed", _UNAVAILABLE])
def test_when_the_compose_lands_then_provenance_names_the_composed_token(
    pg_shim: dict[str, str], apply_status: str
):
    # The opposite polarity: a composed row must be distinguishable from a never-composed one,
    # which is the half of the finding an absent column leaves open.
    _seed(pg_shim, "ok")

    result = _compose(pg_shim, apply_status)

    assert result.returncode == 0
    assert _get_provenance(pg_shim) == "%s%s" % (_COMPOSED, apply_status)
    assert _stdout_provenance(result) == "%s%s" % (_COMPOSED, apply_status)
    assert "declined" not in result.stderr


@pytest.mark.parametrize("seeded", ["ok", "partial"])
def test_when_provenance_is_reported_then_the_first_stdout_line_stays_a_bare_integer(
    pg_shim: dict[str, str], seeded: str
):
    # Every caller of every op parses stdout line 1 positionally as elapsed_ms, so provenance
    # is a trailer or it is a breaking change to callers unrelated to this op.
    _seed(pg_shim, seeded)

    result = _compose(pg_shim, "ok")

    lines = result.stdout.splitlines()
    assert result.returncode == 0
    assert int(lines[0]) >= 0
    assert lines[1].startswith("provenance=")


def test_when_no_run_row_exists_then_no_provenance_is_reported(pg_shim: dict[str, str]):
    # An absent row composed nothing; reporting provenance for it would invent a cycle outcome.
    result = _compose(pg_shim, "ok")

    assert result.returncode == 0
    assert _stdout_provenance(result) is None
    assert "matched no run row" in result.stderr


def test_when_the_token_is_unsupported_then_no_provenance_is_written(pg_shim: dict[str, str]):
    # The refusal precedes the connection, so a refused call must leave the column as absent —
    # a provenance value here would report apply health the cycle never recorded.
    _seed(pg_shim, "ok")

    result = _compose(pg_shim, "apply_skipped")

    assert result.returncode == _EXIT_UNSUPPORTED_TOKEN
    assert _get_provenance(pg_shim) is None
    assert _stdout_provenance(result) is None


def test_when_provenance_is_declared_then_source_column_and_schema_name_the_same_thing():
    # A prefix or column name that drifts between the SQL, the schema and the migration leaves
    # the write silently landing nowhere — the same contract-lying-about-itself shape the token
    # declaration case pins, on the surface this task adds.
    source = _HELPER.read_text(encoding="utf-8")

    assert 'COMPOSED_PREFIX = "%s"' % _COMPOSED in source
    assert 'DECLINED_PREFIX = "%s"' % _DECLINED in source
    assert "'%s' || " % _COMPOSED in source
    assert "'%s' || " % _DECLINED in source

    # Every CASE arm must read the same composable set — the status arm, the provenance arm and
    # the degraded statement's status arm. A widened one and a stale one would compose a status
    # while reporting it declined, or compose different sets on either side of the migration.
    arms = re.findall(r"WHEN status IN \(([^)]*)\)", source)
    assert len(arms) == 3
    assert len({frozenset(re.findall(r"'([^']+)'", arm)) for arm in arms}) == 1

    schema = (_SCRIPTS_ROOT.parent / "monitor" / "prisma" / "schema.prisma").read_text(
        encoding="utf-8"
    )
    migrations = _SCRIPTS_ROOT.parent / "monitor" / "prisma" / "migrations"
    migration_sql = "\n".join(
        path.read_text(encoding="utf-8") for path in migrations.rglob("migration.sql")
    )
    assert _PROVENANCE_COLUMN in source
    assert '@map("%s")' % _PROVENANCE_COLUMN in schema
    assert _PROVENANCE_COLUMN in migration_sql

    # The degradation notice names a migration by directory name; a rename would leave the one
    # stderr line an operator acts on pointing at nothing.
    named = re.search(r'PROVENANCE_MIGRATION = "([^"]+)"', source)
    assert named, "PROVENANCE_MIGRATION declaration not found"
    assert (migrations / named.group(1)).is_dir()
    assert _PROVENANCE_COLUMN in (migrations / named.group(1) / "migration.sql").read_text(
        encoding="utf-8"
    )


@pytest.mark.parametrize(
    ("seeded", "composed", "expected"),
    [
        ("ok", "apply_failed", "apply_failed"),   # the composing arm still composes
        ("apply_failed", "ok", "ok"),
        ("partial", "ok", "partial"),             # the preserving arm still preserves
        ("quota_exceeded", "apply_failed", "quota_exceeded"),
    ],
)
def test_when_the_provenance_column_is_absent_then_the_status_composition_is_unchanged(
    pg_shim_premigration: dict[str, str], seeded: str, composed: str, expected: str
):
    # The inversion this degradation exists to prevent: an unconditional provenance write turns a
    # WORKING compose into a hard failure every cycle on any install whose DB predates the
    # migration — and the update path runs none. Pre-migration is old behaviour plus a notice.
    _seed(pg_shim_premigration, seeded)

    result = _compose(pg_shim_premigration, composed)

    assert result.returncode == 0
    assert _get_status(pg_shim_premigration) == expected
    assert "pg_write=ok" in result.stderr


def test_when_the_provenance_column_is_absent_then_the_notice_names_the_migration(
    pg_shim_premigration: dict[str, str],
):
    # Degrading QUIETLY would be the same defect one layer down: the operator would read a clean
    # compose and never learn that provenance is unrecorded. One line, naming what to apply.
    _seed(pg_shim_premigration, "ok")

    result = _compose(pg_shim_premigration, "ok")

    assert result.returncode == 0
    assert "DEGRADED" in result.stderr
    assert _PROVENANCE_COLUMN in result.stderr
    assert "20260803000001_add_daemon_run_apply_status_provenance" in result.stderr


@pytest.mark.parametrize("seeded", ["ok", "partial"])
def test_when_the_provenance_column_is_absent_then_no_provenance_is_reported(
    pg_shim_premigration: dict[str, str], seeded: str
):
    # The degraded statement returns the composed STATUS; reporting it as provenance would hand
    # the driver a value indistinguishable from a stored one. Line 1 stays the bare integer.
    _seed(pg_shim_premigration, seeded)

    result = _compose(pg_shim_premigration, "ok")

    assert result.returncode == 0
    assert _stdout_provenance(result) is None
    assert int(result.stdout.splitlines()[0]) >= 0


def test_when_the_provenance_column_is_absent_and_no_row_exists_then_silence_is_still_reported(
    pg_shim_premigration: dict[str, str],
):
    # The degraded statement keeps a RETURNING clause, so the matched-nothing guard still reads
    # rows. A degradation that dropped it would trade the provenance silence for that one.
    result = _compose(pg_shim_premigration, "ok")

    assert result.returncode == 0
    assert "matched no run row" in result.stderr
    assert "DEGRADED" in result.stderr


def test_when_the_column_is_absent_then_an_unrelated_fault_is_not_degraded_away(
    pg_shim_premigration: dict[str, str],
):
    # The scoped arm's whole justification: only SQLSTATE 42703 takes the degraded path. A fault
    # the helper must still fail on — here the run row's table missing entirely — stays a named
    # failure exit, so the degradation cannot mask a broken install as a clean cycle.
    with closing(sqlite3.connect(pg_shim_premigration[stub.SQLITE_PATH_ENV])) as db:
        db.execute("DROP TABLE daemon_runs")
        db.commit()

    result = _compose(pg_shim_premigration, "ok")

    assert result.returncode != 0
    assert "pg_write=fail" in result.stderr
    assert "DEGRADED" not in result.stderr


def test_when_tokens_are_declared_then_every_declaration_names_the_same_set():
    # A third arm landing in one place only leaves the contract lying about itself —
    # the CLI header and the docstring are what a caller and a reader actually read.
    source = _HELPER.read_text(encoding="utf-8")

    declared = re.search(r"APPLY_STATUS_TOKENS = \(([^)]*)\)", source)
    assert declared, "APPLY_STATUS_TOKENS declaration not found"
    tokens = set(re.findall(r'"([^"]+)"', declared.group(1)))
    assert _UNAVAILABLE in tokens

    sql_arm = re.search(r"WHEN status IN \(([^)]*)\)", source)
    assert sql_arm, "composable-set SQL membership list not found"
    assert set(re.findall(r"'([^']+)'", sql_arm.group(1))) == tokens

    header = re.search(r'"apply_status": "([^"]+)"', source)
    assert header, "CLI-contract header apply_status line not found"
    assert set(header.group(1).split("|")) == tokens

    docstring = re.search(
        r'def compose_daemon_run_apply_status\([^)]*\):\n    """(.*?)"""',
        source,
        re.DOTALL,
    )
    assert docstring, "compose docstring not found"
    for token in tokens:
        assert "'%s'" % token in docstring.group(1)
