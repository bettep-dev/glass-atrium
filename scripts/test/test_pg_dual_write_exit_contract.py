"""Behavioral tests for the _pg_dual_write_daemon.py CLI exit-code contract.

Every case runs the REAL helper as a subprocess (never a stub, never the live DB
write path) and pins one named exit code from the header semantics table:

  - 0 stays reserved for a committed write (not asserted here — needs a live DB).
  - 2 envelope parse failure: stdin is not a JSON envelope.
  - 3 unknown op: a well-formed envelope naming an op outside OP_TABLE.
  - 4 PG write failure after the retry: PGHOST points at a nonexistent socket
    dir, so libpq fails deterministically through _connect -> retry -> the
    structured JSON stderr emit.
  - 5 psycopg absent in CLI mode, paired with the import-mode contract that the
    SAME absence still raises a catchable ImportError for an importer
    (daemon_cycle.py + wiki-sync.sh depend on the re-raise).

Run with:
    uv run --python 3.13 --with pytest pytest scripts/test/test_pg_dual_write_exit_contract.py -v

CID: 2026-07-27T0540_fix-pg-failopen_3f7b
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
_HELPER = _SCRIPTS_ROOT / "_pg_dual_write_daemon.py"

_TIMEOUT_S = 30


def _get_python():
    """Interpreter that reaches the helper's post-import branches.

    Production callers invoke plain `python3`, but a pytest run under an isolated
    env (uv/venv) shadows it with an interpreter lacking psycopg — every branch
    would then collapse to exit 5 and pin nothing. So probe the candidates and
    prefer one that can import psycopg.
    """
    candidates = [
        shutil.which("python3"),
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    for candidate in candidates:
        if not candidate or not Path(candidate).exists():
            continue
        probe = subprocess.run(
            [candidate, "-c", "import psycopg"],
            capture_output=True,
            timeout=_TIMEOUT_S,
            check=False,
        )
        if probe.returncode == 0:
            return candidate, True
    return "python3", False


_PYTHON, _HAS_PSYCOPG = _get_python()

_needs_psycopg = pytest.mark.skipif(
    not _HAS_PSYCOPG,
    reason="no interpreter with psycopg — the CLI takes the exit-5 branch first",
)


def _run_helper(envelope: str, env: dict[str, str] | None = None):
    return subprocess.run(
        [_PYTHON, str(_HELPER)],
        input=envelope,
        text=True,
        capture_output=True,
        timeout=_TIMEOUT_S,
        env=env,
        check=False,
    )


@pytest.fixture
def psycopg_shim(tmp_path: Path) -> dict[str, str]:
    """PYTHONPATH-prepended package whose import always fails.

    Shadows any real psycopg so the absent-dependency branch is reachable even
    on a machine where psycopg IS installed.
    """
    pkg = tmp_path / "psycopg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text('raise ImportError("shim")\n', encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(tmp_path), env["PYTHONPATH"]] if env.get("PYTHONPATH") else [str(tmp_path)]
    )
    return env


@_needs_psycopg
def test_when_envelope_is_not_json_then_exit_2():
    result = _run_helper("not-json")

    assert result.returncode == 2
    assert "envelope parse failed" in result.stderr
    assert result.stdout.strip() == ""


@_needs_psycopg
def test_when_op_is_unknown_then_exit_3():
    result = _run_helper('{"op":"no_such_op"}')

    assert result.returncode == 3
    assert "unknown op: no_such_op" in result.stderr
    assert result.stdout.strip() == ""


@_needs_psycopg
def test_when_pg_unreachable_then_exit_4_after_retry():
    # A nonexistent socket dir is the deterministic connect failure: the
    # "dbname=glass_atrium" conninfo leaves host unset, so libpq consults PGHOST.
    env = dict(os.environ)
    env["PGHOST"] = "/nonexistent-pg-socket-dir"

    result = _run_helper('{"op":"bump_wiki_dirty","args":{}}', env=env)

    assert result.returncode == 4
    assert result.stdout.strip() == ""
    assert "pg_write=fail" in result.stderr
    assert '"error_kind"' in result.stderr


def test_when_psycopg_absent_in_cli_mode_then_exit_5(psycopg_shim: dict[str, str]):
    result = _run_helper('{"op":"bump_wiki_dirty","args":{}}', env=psycopg_shim)

    assert result.returncode == 5
    assert '"error_kind":"import_error"' in result.stderr


def test_when_psycopg_absent_in_import_mode_then_raises_import_error(
    psycopg_shim: dict[str, str],
):
    # The CLI exit code must NOT leak into the import path: an importer catches
    # ImportError, whereas a module-scope sys.exit would raise SystemExit past it.
    result = subprocess.run(
        [
            _PYTHON,
            "-c",
            "import sys; sys.path.insert(0, %r); import _pg_dual_write_daemon"
            % str(_SCRIPTS_ROOT),
        ],
        capture_output=True,
        text=True,
        timeout=_TIMEOUT_S,
        env=psycopg_shim,
        check=False,
    )

    assert result.returncode != 0
    assert "ImportError" in result.stderr
