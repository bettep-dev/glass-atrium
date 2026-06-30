"""Scope-driven `model:` frontmatter resolution from the monitor DB (fail-soft).

A new agent's frontmatter `model:` line is auto-populated from the monitor
"Model & Budget" SAVED TARGET that matches the agent's scope:

    DEV      -> monitor.model_config row  config_key = 'model.dev'
    RESEARCH -> monitor.model_config row  config_key = 'model.research'
    others   -> no row exists -> no saved target -> omit the model line

The lookup is FAIL-SOFT BY CONTRACT: agent creation MUST NEVER crash because the
model could not be resolved. Every failure mode — psycopg not importable, the
monitor DB unreachable, the Unix socket absent, a missing/empty row, or the
sentinel value 'inherit' — collapses to ``None``, which the scaffold renders as
"omit the `model:` line" (i.e. inherit from settings.json). Only the live DB
value is trusted (the monitor validates it at write time), so no client-side
model-id allowlist is duplicated here.

Connection mirrors `_pg_dual_write_daemon.py`: Unix-socket only via
``psycopg.connect("dbname=glass_atrium")`` — never -h / -p / host= / 127.0.0.1 /
localhost. The monitor server need NOT be running for the read to succeed.
"""

from __future__ import annotations

import sys

# The monitor "Model & Budget" SAVED TARGET is persisted per config_key in the
# monitor.model_config key-value table; these are the only two scopes that carry
# a row (every other scope inherits from settings.json -> no model line).
# SoT mirror: monitor/src/server/model-config-consts.ts MODEL_DOMAINS
# (surface = frontmatter-dev / frontmatter-research) + INHERIT_VALUE. Python
# cannot import the TS const, so keep this map and the sentinel below in sync
# whenever a new frontmatter scope/key is added there.
_SCOPE_TO_CONFIG_KEY = {
    "DEV": "model.dev",
    "RESEARCH": "model.research",
}

# Sentinel SAVED TARGET meaning "do not pin a model" — rendered as an omitted
# frontmatter line (inherit from settings.json), identical to a missing row.
_INHERIT_SENTINEL = "inherit"

# Parameterized binding (never string-concatenated user input — injection guard).
_MODEL_CONFIG_SQL = (
    "SELECT config_value FROM monitor.model_config WHERE config_key = %s"
)


def get_model_config(config_key: str) -> str | None:
    """Return the monitor.model_config value for `config_key`, else None (fail-soft).

    Reads the single TEXT `config_value` cell for the given key over the fixed
    Unix-socket connection. Returns the stored (stripped, non-empty) value, or
    None when the key is absent / NULL / blank. ANY failure — psycopg absent
    (ImportError), DB or socket unreachable (OperationalError), or any other
    error — is caught and degraded to None so the caller never raises. The broad
    catch is deliberate: this is a best-effort enrichment read, not a
    correctness-critical operation, and agent creation must survive its failure.
    """
    try:
        import psycopg  # local import: psycopg-absence must degrade, not hard-fail

        with psycopg.connect("dbname=glass_atrium", connect_timeout=2) as conn:
            with conn.cursor() as cur:
                cur.execute(_MODEL_CONFIG_SQL, (config_key,))
                row = cur.fetchone()
    except Exception as exc:  # noqa: BLE001 — fail-soft: any error => omit model line
        sys.stderr.write(
            f"[agent_lifecycle.db_utils] model-config lookup for {config_key!r} "
            f"unavailable ({type(exc).__name__}); omitting model line\n"
        )
        return None

    if row is None or row[0] is None:
        return None
    value = str(row[0]).strip()
    return value or None


def resolve_model_for_scope(scope: str) -> str | None:
    """Return the SAVED TARGET model id for `scope`, or None to omit the line.

    Maps the agent scope to its monitor.model_config key (DEV -> 'model.dev',
    RESEARCH -> 'model.research', case-insensitive); every other scope has no
    saved target and returns None without any DB read. A resolved value of None,
    the 'inherit' sentinel, or an empty/whitespace string all collapse to None —
    the scaffold then omits the frontmatter `model:` line (inherit from
    settings.json).
    """
    config_key = _SCOPE_TO_CONFIG_KEY.get(scope.strip().upper())
    if config_key is None:
        return None

    value = get_model_config(config_key)
    if value is None:
        return None
    value = value.strip()
    if not value or value.lower() == _INHERIT_SENTINEL:
        return None
    return value
