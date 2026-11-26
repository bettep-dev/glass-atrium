"""Connect-tolerance tests for the hook database writer (hooks/_pg-write.py).

The writer runs inside a synchronous PreToolUse hook, so its connect timeout trades a
slow Postgres backend start against how long it can stall a tool call. A fake Postgres
on a private Unix socket (real libpq client, never the live database) delays its
startup reply; the writer runs through its own CLI.

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

_WRITER = Path(__file__).resolve().parent.parent / "_pg-write.py"
# private port → a libpq that ignored PGHOST would find no /tmp socket and fail fast
_FAKE_PORT = 59321
# a hook write never stalls a tool call longer than this (stated worst case + interpreter start)
_HOOK_STALL_CEILING_SEC = 11.0
_ROW = {
    "event_ts": "2026-11-26T19:35:12.481+09:00",
    "event_name": "SubagentStart",
    "agent_id": "a7f3c2e91b",
    "agent_type": "glass-atrium-dev-python",
}

try:
    import psycopg2  # noqa: F401 — the writer's driver; absent → the writer exits before any connect

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
    _HAS_DRIVER, "psycopg2 not installed — the writer cannot connect at all"
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

    def _run_writer(self) -> tuple[subprocess.CompletedProcess, float]:
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("PGSERVICE", "PGSERVICEFILE", "PGHOSTADDR", "PGPASSFILE")
        }
        env.update(PGHOST=str(self.socket_dir), PGPORT=str(_FAKE_PORT))
        started = time.monotonic()
        result = subprocess.run(
            [sys.executable, str(_WRITER), "pg-write-test", "core.agent_events"],
            check=False,
            input=json.dumps(_ROW),
            capture_output=True,
            text=True,
            env=env,
            timeout=_HOOK_STALL_CEILING_SEC * 2,
        )
        return result, time.monotonic() - started

    def test_a_slow_backend_start_still_writes_the_row(self) -> None:
        fake = self._start_fake(delay=2.0)
        result, _ = self._run_writer()
        self.assertEqual(result.returncode, 0, result.stderr)
        inserts = [
            q for q in fake.queries if q.startswith("INSERT INTO core.agent_events")
        ]
        self.assertEqual(len(inserts), 1, f"row lost; writer stderr: {result.stderr}")
        self.assertNotIn("error_kind", result.stderr)

    def test_an_unreachable_database_fails_within_the_hook_stall_ceiling(self) -> None:
        rows = [("hung: accepts, never answers", True), ("absent: no listener", False)]
        for name, is_listening in rows:
            with self.subTest(name):
                fake = self._start_fake(delay=None) if is_listening else None
                result, elapsed = self._run_writer()
                if fake is not None:
                    fake.close()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('"error_kind"', result.stderr)
                self.assertLess(
                    elapsed, _HOOK_STALL_CEILING_SEC, f"{name}: {elapsed:.1f}s"
                )


if __name__ == "__main__":
    unittest.main()
