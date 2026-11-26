"""Connect-tolerance tests for the hook database writers (hooks/_pg_connect.py).

Every writer runs inside a synchronous hook, so the shared connect timeout trades a
slow Postgres backend start against how long it can stall the session. A fake Postgres
on a private Unix socket (real libpq client, never the live database) delays its
startup reply; each writer runs through the entry point its hook calls.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_pg_write.py -v
    python3 -m unittest hooks.test.test_pg_write -v
"""

from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import ClassVar

_HOOKS_DIR = Path(__file__).resolve().parent.parent
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))

from _pg_connect import CONNECT_TIMEOUT_SEC, RETRY_BACKOFF_SEC

_WRITER = _HOOKS_DIR / "_pg-write.py"
# private port → a libpq that ignored PGHOST would find no /tmp socket and fail fast
_FAKE_PORT = 59321
# above the 1 s connect that lost rows, half a timeout below the shared one
_SLOW_START_SEC = CONNECT_TIMEOUT_SEC / 2
# hung database → two write connects, one backoff, then the failure-record connect
_HUNG_CONNECTS = 3
_HUNG_WAIT_SEC = _HUNG_CONNECTS * CONNECT_TIMEOUT_SEC
_HUNG_WORST_SEC = _HUNG_WAIT_SEC + RETRY_BACKOFF_SEC
# slack = loaded-runner interpreter start + driver import; the connect count pins the attempts
_HOOK_STALL_CEILING_SEC = _HUNG_WORST_SEC + CONNECT_TIMEOUT_SEC
_ROW = {
    "event_ts": "2026-11-26T19:35:12.481+09:00",
    "event_name": "SubagentStart",
    "agent_id": "a7f3c2e91b",
    "agent_type": "glass-atrium-dev-python",
}
_OUTCOME = {
    "timestamp": "2026-11-26T19:35:40.112+09:00",
    "agent": "glass-atrium-dev-python",
    "task_type": "bug-fix",
    "result": "done",
    "agent_id": "a7f3c2e91b",
}
# each writer as its hook calls it: (row name, argv, stdin)
_WRITERS = [
    (
        "_pg-write.py (advisory-subagent-budget)",
        [str(_WRITER), "pg-write-test", "core.agent_events"],
        json.dumps(_ROW),
    ),
    (
        "_pg_dual_write.py single row (agent-tracker)",
        [str(_HOOKS_DIR / "_pg_dual_write.py")],
        json.dumps(
            {
                "hook_name": "agent-tracker",
                "target_table": "core.agent_events",
                "payload_ref": _ROW["agent_id"],
                "row": _ROW,
            }
        ),
    ),
    (
        "_pg_dual_write.py batch (cost-tracker)",
        [str(_HOOKS_DIR / "_pg_dual_write.py")],
        json.dumps(
            {
                "hook_name": "cost-tracker",
                "target_table": "core.agent_events",
                "payload_ref": _ROW["agent_id"],
                "rows": [_ROW],
            }
        ),
    ),
    (
        "_pg_outcome_dualwrite.py (track-outcome)",
        [str(_HOOKS_DIR / "_pg_outcome_dualwrite.py")],
        json.dumps({"outcome": _OUTCOME}),
    ),
    (
        "_pg_learning_dualwrite.py (learning-aggregator)",
        [
            "-c",
            (
                "import sys; sys.path.insert(0, sys.argv[1]); import _pg_learning_dualwrite as w; "
                "w.update_aggregator_state('learning-aggregator', None)"
            ),
            str(_HOOKS_DIR),
        ],
        "",
    ),
]

try:
    import psycopg  # noqa: F401 — the sibling writers' driver
    import psycopg2  # noqa: F401 — _pg-write.py's driver; absent → a writer exits before any connect

    _HAS_DRIVER = True
except ImportError:
    _HAS_DRIVER = False


def _recv_exact(conn: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise ConnectionError("client closed")
        data += chunk
    return data


def _message(kind: bytes, body: bytes) -> bytes:
    return kind + struct.pack("!i", len(body) + 4) + body


class _FakePostgres:
    """Postgres wire server answering each startup after `delay` seconds (None = never)."""

    _PARAMS: ClassVar[dict[str, str]] = {
        "server_version": "18.1",
        "client_encoding": "UTF8",
        "DateStyle": "ISO, MDY",
        "integer_datetimes": "on",
        "standard_conforming_strings": "on",
    }

    def __init__(self, socket_dir: Path, delay: float | None) -> None:
        self.delay = delay
        self.connects = 0
        self.queries: list[str] = []
        self._stopped = threading.Event()
        self._path = socket_dir / f".s.PGSQL.{_FAKE_PORT}"
        self._server = socket.socket(socket.AF_UNIX)
        self._server.bind(str(self._path))
        self._server.listen(8)
        self._server.settimeout(0.2)
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def close(self) -> None:
        self._stopped.set()
        self._server.close()
        self._path.unlink(missing_ok=True)

    def _accept_loop(self) -> None:
        while not self._stopped.is_set():
            try:
                conn, _ = self._server.accept()
            except OSError:  # accept poll timeout, or the socket closed by close()
                continue
            self.connects += 1
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        conn.settimeout(None)
        with conn:
            try:
                self._read_startup(conn)
                if self.delay is None or self._stopped.wait(self.delay):
                    self._stopped.wait()
                    return
                self._send_ready(conn)
                self._answer_queries(conn)
            except OSError:
                return  # client gave up first (its timeout) → broken pipe, as on a real backend

    @staticmethod
    def _read_startup(conn: socket.socket) -> None:
        while True:
            (length,) = struct.unpack("!i", _recv_exact(conn, 4))
            (code,) = struct.unpack("!i", _recv_exact(conn, length - 4)[:4])
            if code not in (
                80877103,
                80877104,
            ):  # SSL / GSS encryption request → refuse, await startup
                return
            conn.sendall(b"N")

    def _send_ready(self, conn: socket.socket) -> None:
        params = b"".join(
            _message(b"S", k.encode() + b"\0" + v.encode() + b"\0")
            for k, v in self._PARAMS.items()
        )
        conn.sendall(
            _message(b"R", struct.pack("!i", 0))
            + params
            + _message(b"K", struct.pack("!ii", 1, 1))
            + _message(b"Z", b"I")
        )

    def _answer_queries(self, conn: socket.socket) -> None:
        status = b"I"
        while True:
            kind = _recv_exact(conn, 1)
            (length,) = struct.unpack("!i", _recv_exact(conn, 4))
            body = _recv_exact(conn, length - 4)
            if kind != b"Q":
                return
            query = body.rstrip(b"\0").decode()
            self.queries.append(query)
            verb = query.split()[0].upper()
            status = {"BEGIN": b"T", "COMMIT": b"I", "ROLLBACK": b"I"}.get(verb, status)
            tag = "INSERT 0 1" if verb == "INSERT" else verb
            conn.sendall(_message(b"C", tag.encode() + b"\0") + _message(b"Z", status))


@unittest.skipUnless(
    _HAS_DRIVER, "psycopg / psycopg2 not installed — a writer cannot connect at all"
)
class ConnectTolerance(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.socket_dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _start_fake(self, delay: float | None) -> _FakePostgres:
        fake = _FakePostgres(self.socket_dir, delay)
        self.addCleanup(fake.close)
        return fake

    def _run_writer(
        self, argv: list[str] | None = None, stdin: str | None = None
    ) -> tuple[subprocess.CompletedProcess, float]:
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGPASSFILE")
        }
        env.update(PGHOST=str(self.socket_dir), PGPORT=str(_FAKE_PORT))
        started = time.monotonic()
        _, default_argv, default_stdin = _WRITERS[0]
        result = subprocess.run(
            [sys.executable, *(argv or default_argv)],
            check=False,
            input=default_stdin if stdin is None else stdin,
            capture_output=True,
            text=True,
            env=env,
            timeout=_HOOK_STALL_CEILING_SEC * 2,
        )
        return result, time.monotonic() - started

    def test_a_slow_backend_start_still_writes_the_row(self) -> None:
        fake = self._start_fake(delay=_SLOW_START_SEC)
        result, _ = self._run_writer()
        self.assertEqual(result.returncode, 0, result.stderr)
        inserts = [
            q for q in fake.queries if q.startswith("INSERT INTO core.agent_events")
        ]
        self.assertEqual(len(inserts), 1, f"row lost; writer stderr: {result.stderr}")
        self.assertNotIn("error_kind", result.stderr)

    def test_an_absent_database_fails_within_the_hook_stall_ceiling(self) -> None:
        result, elapsed = self._run_writer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"error_kind"', result.stderr)
        self.assertLess(elapsed, _HOOK_STALL_CEILING_SEC, f"{elapsed:.1f}s")

    def test_every_writer_waits_out_the_shared_connect_timeout_on_a_hung_database(
        self,
    ) -> None:
        for name, argv, stdin in _WRITERS:
            with self.subTest(name):
                fake = self._start_fake(delay=None)
                result, elapsed = self._run_writer(argv, stdin)
                fake.close()
                self.assertIn('"error_kind"', result.stderr)
                self.assertEqual(fake.connects, _HUNG_CONNECTS, result.stderr)
                self.assertGreaterEqual(
                    elapsed, _HUNG_WAIT_SEC, f"{name}: {elapsed:.1f}s"
                )
                self.assertLess(
                    elapsed, _HOOK_STALL_CEILING_SEC, f"{name}: {elapsed:.1f}s"
                )


if __name__ == "__main__":
    unittest.main()
