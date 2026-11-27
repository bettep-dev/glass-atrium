"""The ephemeral-cluster connect in ``_pg_seal``: only a timed-out attempt is retried, bounded.

Every row stubs ``psycopg.connect`` (the database boundary), so no row opens a connection and the
module runs with or without a cluster; psycopg must be importable for its error classes.

Run with either runner:
    python3 -m unittest autoagent.test.test_pg_seal -v
    uv run --with pytest pytest autoagent/test/test_pg_seal.py -v
"""

from __future__ import annotations

import contextlib
import os
import sys
import unittest
from collections.abc import Iterator
from pathlib import Path
from unittest import mock

_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))

import _pg_seal  # noqa: E402 — test dir anchored above

try:
    import psycopg
except ImportError:
    psycopg = None  # type: ignore[assignment]

_SOCKDIR = "/var/empty/eph-seal-sock"
# more failures than any bound → only the helper's own bound can stop the retries
_ENDLESS = 50


@unittest.skipIf(psycopg is None, "psycopg not importable: its error classes are the contract")
class _ConnectFixture(unittest.TestCase):
    @contextlib.contextmanager
    def _patch_connect(self, failures: list[Exception]) -> Iterator[list[dict[str, object]]]:
        """Connect raises ``failures`` in turn, then opens; yields each attempt's kwargs."""
        pending, attempts = list(failures), []

        def connect(**kwargs: object) -> mock.Mock:
            attempts.append(kwargs)
            if pending:
                raise pending.pop(0)
            return mock.Mock(name="connection")

        with mock.patch.object(psycopg, "connect", connect):
            yield attempts

    def _get_timeout(self) -> Exception:
        return psycopg.errors.ConnectionTimeout("connection timeout expired")

    def _get_refusal(self) -> Exception:
        return psycopg.OperationalError("connection refused")


class GetConnectionTest(_ConnectFixture):
    """The shared connect: a stalled attempt is retried, any other refusal is not."""

    def test_a_connect_that_times_out_once_opens_on_the_retry_with_the_same_wide_budget(
        self,
    ) -> None:
        with self._patch_connect([self._get_timeout()]) as attempts:
            _pg_seal.get_connection("glass_atrium", autocommit=True)

        expected = {
            "dbname": "glass_atrium",
            "connect_timeout": _pg_seal.CONNECT.TIMEOUT_S,
            "autocommit": True,
        }
        self.assertEqual(attempts, [expected, expected])

    def test_a_failing_connect_raises_at_once_unless_it_timed_out_and_then_at_the_attempt_bound(
        self,
    ) -> None:
        rows = (
            ("a refusal other than a timeout", self._get_refusal, psycopg.OperationalError, 1),
            (
                "an attempt that times out every time",
                self._get_timeout,
                psycopg.errors.ConnectionTimeout,
                _pg_seal.CONNECT.ATTEMPTS,
            ),
        )
        for name, get_error, raised, attempt_count in rows:
            failures = [get_error() for _ in range(_ENDLESS)]
            with self.subTest(name), self._patch_connect(failures) as attempts:
                with self.assertRaises(psycopg.OperationalError) as caught:
                    _pg_seal.get_connection("glass_atrium")

                self.assertIs(type(caught.exception), raised)
                self.assertEqual(len(attempts), attempt_count)


class GetEphemeralConnectionTest(_ConnectFixture):
    """The live classes' probe: a stalled attempt is retried before the class may skip."""

    def setUp(self) -> None:
        cluster = {"EPH_SOCKDIR": _SOCKDIR, "PGHOST": _SOCKDIR, "EPH_PORT": "55451"}
        patcher = mock.patch.dict(os.environ, cluster)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("PGHOSTADDR", "PGSERVICE"):
            os.environ.pop(name, None)

    def test_a_probe_that_times_out_once_connects_on_the_retry_instead_of_skipping(self) -> None:
        with self._patch_connect([self._get_timeout()]) as attempts:
            try:
                _pg_seal.get_ephemeral_connection()
            except unittest.SkipTest as skip:
                self.fail(f"a single timed-out probe skipped the class: {skip}")

        self.assertEqual([attempt["host"] for attempt in attempts], [_SOCKDIR, _SOCKDIR])

    def test_a_probe_skips_on_a_refusal_at_once_and_on_timeouts_at_the_attempt_bound(
        self,
    ) -> None:
        rows = (
            ("a refusal other than a timeout", self._get_refusal, 1),
            ("an attempt that times out every time", self._get_timeout, _pg_seal.CONNECT.ATTEMPTS),
        )
        for name, get_error, attempt_count in rows:
            failures = [get_error() for _ in range(_ENDLESS)]
            with self.subTest(name), self._patch_connect(failures) as attempts:
                with self.assertRaises(unittest.SkipTest) as caught:
                    _pg_seal.get_ephemeral_connection()

                self.assertIn("ephemeral cluster unreachable", str(caught.exception))
                self.assertEqual(len(attempts), attempt_count)


if __name__ == "__main__":
    unittest.main()
