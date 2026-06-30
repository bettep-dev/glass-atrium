"""Behavioral tests for scope-driven `model:` frontmatter auto-population.

Covers the auto-model-fetch feature added to `agent_lifecycle`:

  - scaffold.render_agent_md: `model=None` omits the line (byte-identical to the
    historical scaffold, for both the stub and authored-body paths); a set model
    emits `model: <id>` immediately after `maxTurns:`.
  - db_utils.resolve_model_for_scope: DEV/RESEARCH map to their config keys, the
    'inherit' sentinel + empty/whitespace + unmapped scope all collapse to None,
    case-insensitively, with unmapped scopes performing NO DB read.
  - db_utils.get_model_config: fail-soft — a raising psycopg connect degrades to
    None rather than propagating (agent creation must never crash on a DB fault).

Self-contained: inserts the scripts root on sys.path (no live store touched).

Run with:
    PYTHONPATH=scripts uv run --python 3.13 --with pytest pytest \
        scripts/test/test_agent_model_frontmatter.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle import db_utils  # noqa: E402
from agent_lifecycle.scaffold import render_agent_md  # noqa: E402

# --- render_agent_md: model line presence / placement ----------------------


def test_when_model_none_stub_then_no_model_line() -> None:
    out = render_agent_md(name="dev-x", scope="DEV", domains=["a"], model=None)
    assert "model:" not in out
    # frontmatter closes directly after maxTurns when no model is injected.
    assert "maxTurns: 40\n---\n" in out


def test_when_model_omitted_then_byte_identical_to_explicit_none() -> None:
    # The new keyword defaults to None, so omitting it must equal passing None.
    with_default = render_agent_md(name="dev-x", scope="DEV", domains=["a"])
    explicit_none = render_agent_md(
        name="dev-x", scope="DEV", domains=["a"], model=None
    )
    assert with_default == explicit_none


def test_when_model_set_stub_then_line_right_after_maxturns() -> None:
    out = render_agent_md(
        name="dev-x", scope="DEV", domains=["a"], model="claude-opus-4-8"
    )
    # model line lands immediately after maxTurns and before the closing fence.
    assert "maxTurns: 40\nmodel: claude-opus-4-8\n---\n" in out


def test_when_model_set_with_authored_body_then_line_present() -> None:
    body = "> Rules: GLOBAL_RULES.md (ALL + DEV)\n\n# dev-x\n\nAuthored body.\n"
    out = render_agent_md(
        name="dev-x",
        scope="DEV",
        domains=["a"],
        body=body,
        model="claude-opus-4-8",
    )
    assert "maxTurns: 40\nmodel: claude-opus-4-8\n---\n" in out


def test_when_model_none_with_authored_body_then_no_model_line() -> None:
    body = "# dev-x\n\nAuthored body.\n"
    with_default = render_agent_md(name="dev-x", scope="DEV", domains=["a"], body=body)
    explicit_none = render_agent_md(
        name="dev-x", scope="DEV", domains=["a"], body=body, model=None
    )
    assert "model:" not in with_default
    assert with_default == explicit_none


def test_when_research_scope_model_set_then_line_present() -> None:
    out = render_agent_md(
        name="intel-researcher", scope="RESEARCH", domains=["a"], model="sonnet"
    )
    assert "maxTurns: 40\nmodel: sonnet\n---\n" in out


# --- resolve_model_for_scope: scope -> key mapping + sentinels -------------


def test_when_scope_dev_then_queries_model_dev_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    def fake(config_key: str) -> str | None:
        seen.append(config_key)
        return "claude-opus-4-8"

    monkeypatch.setattr(db_utils, "get_model_config", fake)
    assert db_utils.resolve_model_for_scope("DEV") == "claude-opus-4-8"
    assert seen == ["model.dev"]


def test_when_scope_research_then_queries_model_research_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    def fake(config_key: str) -> str | None:
        seen.append(config_key)
        return "sonnet"

    monkeypatch.setattr(db_utils, "get_model_config", fake)
    assert db_utils.resolve_model_for_scope("RESEARCH") == "sonnet"
    assert seen == ["model.research"]


def test_when_scope_lowercase_then_mapped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_utils, "get_model_config", lambda _k: "claude-opus-4-8")
    assert db_utils.resolve_model_for_scope("dev") == "claude-opus-4-8"


def test_when_value_inherit_then_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_utils, "get_model_config", lambda _k: "inherit")
    assert db_utils.resolve_model_for_scope("DEV") is None


def test_when_value_inherit_mixed_case_then_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(db_utils, "get_model_config", lambda _k: "Inherit")
    assert db_utils.resolve_model_for_scope("DEV") is None


def test_when_value_blank_then_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_utils, "get_model_config", lambda _k: "   ")
    assert db_utils.resolve_model_for_scope("DEV") is None


def test_when_get_model_config_returns_none_then_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Simulates the fail-soft DB path (unreachable / missing row -> None).
    monkeypatch.setattr(db_utils, "get_model_config", lambda _k: None)
    assert db_utils.resolve_model_for_scope("DEV") is None


def test_when_unmapped_scope_then_none_without_db_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(_config_key: str) -> str | None:
        raise AssertionError("get_model_config must not be called for unmapped scope")

    monkeypatch.setattr(db_utils, "get_model_config", boom)
    for scope in (
        "META",
        "PLANNING",
        "DESIGN",
        "SECURITY",
        "QA",
        "WIKI",
        "ORCHESTRATOR",
    ):
        assert db_utils.resolve_model_for_scope(scope) is None


# --- get_model_config: fail-soft + happy path (psycopg-presence-agnostic) --
#
# db_utils imports psycopg lazily INSIDE get_model_config, so these tests stub
# `psycopg` in sys.modules (or block its import) — exercising every branch
# regardless of whether the real psycopg / monitor DB is reachable in the test
# environment (the uv ephemeral runner has neither).


class _FakeCursor:
    """Minimal DB-API cursor honoring the context-manager + fetchone contract."""

    def __init__(self, row: tuple[object, ...] | None) -> None:
        self._row = row
        self.executed: tuple[str, tuple[object, ...]] | None = None

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def execute(self, sql: str, params: tuple[object, ...]) -> None:
        self.executed = (sql, params)

    def fetchone(self) -> tuple[object, ...] | None:
        return self._row


class _FakeConn:
    """Minimal connection honoring the context-manager + cursor() contract."""

    def __init__(self, row: tuple[object, ...] | None) -> None:
        self._cursor = _FakeCursor(row)

    def __enter__(self) -> _FakeConn:
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return self._cursor


def _install_fake_psycopg(
    monkeypatch: pytest.MonkeyPatch,
    *,
    row: tuple[object, ...] | None = None,
    raise_on_connect: bool = False,
) -> None:
    import types

    fake = types.ModuleType("psycopg")

    def connect(*_args: object, **_kwargs: object) -> _FakeConn:
        if raise_on_connect:
            raise RuntimeError("simulated socket failure")
        return _FakeConn(row)

    fake.connect = connect  # type: ignore[attr-defined]  # test stub module
    monkeypatch.setitem(sys.modules, "psycopg", fake)


def test_when_connect_raises_then_get_model_config_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_psycopg(monkeypatch, raise_on_connect=True)
    assert db_utils.get_model_config("model.dev") is None


def test_when_psycopg_unimportable_then_get_model_config_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import builtins

    real_import = builtins.__import__

    def blocking_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "psycopg":
            raise ModuleNotFoundError("No module named 'psycopg'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocking_import)
    assert db_utils.get_model_config("model.dev") is None


def test_when_row_present_then_get_model_config_returns_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_psycopg(monkeypatch, row=("claude-opus-4-8",))
    assert db_utils.get_model_config("model.dev") == "claude-opus-4-8"


def test_when_row_value_padded_then_get_model_config_strips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_psycopg(monkeypatch, row=("  sonnet  ",))
    assert db_utils.get_model_config("model.research") == "sonnet"


def test_when_no_row_then_get_model_config_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_psycopg(monkeypatch, row=None)
    assert db_utils.get_model_config("model.dev") is None


def test_when_row_value_null_then_get_model_config_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_psycopg(monkeypatch, row=(None,))
    assert db_utils.get_model_config("model.dev") is None


def test_when_resolve_over_failing_connect_then_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # End-to-end fail-soft: a DB fault must not propagate out of resolve.
    _install_fake_psycopg(monkeypatch, raise_on_connect=True)
    assert db_utils.resolve_model_for_scope("DEV") is None


def test_when_resolve_over_live_value_then_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Full path: scope -> key -> stubbed DB row -> resolved id.
    _install_fake_psycopg(monkeypatch, row=("claude-opus-4-8",))
    assert db_utils.resolve_model_for_scope("DEV") == "claude-opus-4-8"
