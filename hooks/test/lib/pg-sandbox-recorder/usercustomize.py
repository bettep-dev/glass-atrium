"""Bats PG sandbox recorder: logs the target of every psycopg connection and refuses one outside the sandbox.

Imported at interpreter start as usercustomize from PYTHONPATH (hooks/test/lib/ephemeral-pg.bash).
Inert unless GA_BATS_PG_SANDBOX names the sandbox socket dir and GA_BATS_PG_RECORD the log file.
The target is resolved before connecting, so a refused attempt never reaches a server.
"""

import os

_TARGET_KEYS = ("host", "port", "dbname", "hostaddr", "service")


def _install():
    sandbox = os.environ.get("GA_BATS_PG_SANDBOX", "")
    record = os.environ.get("GA_BATS_PG_RECORD", "")
    if not sandbox or not record:
        return
    try:
        import psycopg
        from psycopg import conninfo, pq
    except ImportError:
        return
    connect_original = psycopg.Connection.connect.__func__

    # libpq precedence: explicit conninfo/kwargs > environment > compiled default (empty host = default socket)
    def get_target(conninfo_text, kwargs):
        explicit = conninfo.conninfo_to_dict(conninfo_text, **kwargs)
        defaults = {
            option.keyword.decode(): option.val.decode()
            for option in pq.Conninfo.get_defaults()
            if option.val is not None
        }
        target = {}
        for key in _TARGET_KEYS:
            value = explicit.get(key)
            target[key] = str(value) if value not in (None, "") else defaults.get(key, "")
        return target

    def connect(cls, conninfo_text="", **kwargs):
        target = get_target(conninfo_text, kwargs)
        is_sandbox = target["host"] == sandbox and not target["hostaddr"] and not target["service"]
        line = "%s %s" % (
            "allow" if is_sandbox else "refuse",
            " ".join("%s=%s" % (key, target[key]) for key in _TARGET_KEYS),
        )
        with open(record, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        if not is_sandbox:
            raise psycopg.OperationalError("refused by the bats PG sandbox recorder: " + line)
        return connect_original(cls, conninfo_text, **kwargs)

    connect.ga_bats_pg_recorder = True
    psycopg.Connection.connect = classmethod(connect)
    psycopg.connect = psycopg.Connection.connect


_install()
