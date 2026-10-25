"""Trial-ledger writer in _pg_dual_write_daemon.py: its closed sets and its once-only insert.

The ledger is append-only, so a misspelled event or actor, or a duplicate once-only
event, can never be corrected or removed once stored. The closed-set rows run on every
leg through the stdlib backend: the refusal happens before any connection. The insert
rows need real PostgreSQL (``ON CONFLICT`` on the unique ``dedupe_key``, the append-only
trigger) and run only under ``autoagent/test/live-pg-ephemeral.bats``; elsewhere they skip.
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
for _path in (
    _REPO_ROOT / "scripts",
    _REPO_ROOT / "autoagent" / "test",
    _REPO_ROOT / "autoagent" / "lib",
):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import _pg_stub_backend as backend  # noqa: E402 — anchors above
import trial_design  # noqa: E402
from _pg_seal import get_ephemeral_connection  # noqa: E402

_TRIAL_KEY = "a" * 64
_AGENT = "glass-atrium-dev-python"
# an A/A arm-difference design-effect row in the writer's shape
_DESIGN_EFFECT_PAYLOAD = {
    "metric_key": "budget_overage",
    **trial_design.ArmDesignEffect(1.1, 33, 1061, 0.8, 1.6, 2000)._asdict(),
}
# Declared width of the event and actor columns in the ledger migration.
_TOKEN_COLUMN_CHARS = 64
_SPOOL = "inject-scope-rules.manifest.log.20261005T030000Z.spool"
# A canary delivery the daemon bound to no trial; its key makes a spool re-read add no row.
_UNBOUND_DELIVERY = SimpleNamespace(
    EVENT="canary-unbound-delivery",
    PAYLOAD={
        "agent": _AGENT,
        "spool": _SPOOL,
        "line_offset": 0,
        "salt_id": None,
        "delivered_hash": "c" * 64,
    },
)


@contextlib.contextmanager
def _load_helper():
    with (
        tempfile.TemporaryDirectory() as scratch,
        backend.load_helper(Path(scratch) / "stub.sqlite") as helper,
    ):
        yield helper


class TestTrialLedgerClosedSets(unittest.TestCase):
    """Every leg: a value outside the declared sets is refused before a connection."""

    def test_a_value_outside_the_declared_sets_is_refused_before_connecting(
        self,
    ) -> None:
        with _load_helper() as helper:
            ledger = helper.TRIAL_LEDGER
            design_effect = ledger.EVENT.AA_ARM_DESIGN_EFFECT
            rows = (
                ("undeclared event", "shadow-decision", ledger.ACTOR.SHADOW, {}),
                ("undeclared actor", ledger.EVENT.SHADOW_LOOK, "daemon-cycle-push", {}),
                (
                    "design-effect payload missing its metric key",
                    design_effect,
                    ledger.ACTOR.AA,
                    {k: v for k, v in _DESIGN_EFFECT_PAYLOAD.items() if k != "metric_key"},
                ),
                (
                    "design-effect payload with an extra key",
                    design_effect,
                    ledger.ACTOR.AA,
                    {**_DESIGN_EFFECT_PAYLOAD, "selected": 2.1},
                ),
                (
                    "design-effect payload that is no object",
                    design_effect,
                    ledger.ACTOR.AA,
                    [1.4, 2.1],
                ),
                (
                    "instrument verdict missing the verdict",
                    ledger.EVENT.AA_INSTRUMENT_VERDICT,
                    ledger.ACTOR.AA,
                    {"start_id": 7, "metric_key": "budget_overage", "agents": {}},
                ),
                (
                    "aa-start payload missing the duration rule",
                    ledger.EVENT.AA_START,
                    ledger.ACTOR.AA,
                    {"fingerprint": {}, "started_at": "2026-10-07T00:00:00+00:00"},
                ),
                (
                    "aa-restart payload missing the reason",
                    ledger.EVENT.AA_RESTART,
                    ledger.ACTOR.AA,
                    {"start_id": 7, "fingerprint": None},
                ),
                (
                    "unbound-delivery payload missing the salt",
                    _UNBOUND_DELIVERY.EVENT,
                    ledger.ACTOR.AA,
                    {k: v for k, v in _UNBOUND_DELIVERY.PAYLOAD.items() if k != "salt_id"},
                ),
                (
                    "unbound-delivery payload with an extra key",
                    _UNBOUND_DELIVERY.EVENT,
                    ledger.ACTOR.AA,
                    {**_UNBOUND_DELIVERY.PAYLOAD, "trial": None},
                ),
            )
            for name, event, actor, payload in rows:
                with (
                    self.subTest(name),
                    mock.patch.object(helper, "_connect") as connect,
                ):
                    with self.assertRaises(helper.TrialLedgerValueUndeclared):
                        helper.write_trial_ledger_row(event, actor, payload)
                    connect.assert_not_called()

    def test_the_aa_harness_rows_pass_the_closed_sets_and_reach_the_connection(
        self,
    ) -> None:
        # aa-start opens the A/A, aa-result closes it; a refused value never connects.
        rows = (
            (
                "aa-start",
                {
                    "fingerprint": {"agents/glass-atrium-dev-python.md": "b" * 64},
                    "started_at": "2026-10-07T00:00:00+00:00",
                    "duration": {"days": 14},
                },
            ),
            ("aa-result", {"overall": "pass"}),
            (
                "aa-restart",
                {
                    "start_id": 7,
                    "reason": "fingerprint-unreadable",
                    "fingerprint": None,
                },
            ),
            (_UNBOUND_DELIVERY.EVENT, _UNBOUND_DELIVERY.PAYLOAD),
            ("aa-invalidation", {"start_id": 2, "cause": "duplicate exposure"}),
        )
        with _load_helper() as helper:
            ledger = helper.TRIAL_LEDGER
            for event, payload in rows:
                with (
                    self.subTest(event),
                    mock.patch.object(helper, "_connect") as connect,
                ):
                    helper.write_trial_ledger_row(event, ledger.ACTOR.AA, payload)
                    connect.assert_called_once()

    def test_the_design_effect_payload_keys_are_the_metric_key_and_the_reading_fields(
        self,
    ) -> None:
        # The A/A writer stores the metric key plus ArmDesignEffect._asdict(); the power reader keys on both.
        with _load_helper() as helper:
            ledger = helper.TRIAL_LEDGER
            keys = ledger.PAYLOAD_KEYS[ledger.EVENT.AA_ARM_DESIGN_EFFECT]
        self.assertEqual(tuple(keys), ("metric_key", *trial_design.ArmDesignEffect._fields))

    def test_every_declared_token_fits_its_column(self) -> None:
        with _load_helper() as helper:
            ledger = helper.TRIAL_LEDGER
            tokens = [*vars(ledger.EVENT).values(), *vars(ledger.ACTOR).values()]
        for token in tokens:
            self.assertTrue(0 < len(token) <= _TOKEN_COLUMN_CHARS, token)


class TestTrialLedgerWriterLivePg(unittest.TestCase):
    """The writer's real SQL on the ephemeral cluster; skips anywhere else.

    Each test owns a database cloned from a template ``live-pg-ephemeral.bats`` builds —
    the ledger is append-only, so rows cannot be cleaned up.
    """

    _TEMPLATE = SimpleNamespace(
        FULL="trial_ledger_tpl", ABSENT="trial_ledger_absent_tpl"
    )

    def setUp(self) -> None:
        get_ephemeral_connection().close()
        import _pg_dual_write_daemon as writer
        import psycopg

        self.psycopg = psycopg
        self.writer = writer

    def _use_database(self, template: str) -> None:
        self.dbname = f"tl_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        self._run_admin(f'CREATE DATABASE "{self.dbname}" TEMPLATE "{template}"')
        self.addCleanup(self._run_admin, f'DROP DATABASE "{self.dbname}" WITH (FORCE)')
        patcher = mock.patch.object(self.writer, "_connect", self._connect)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run_admin(self, statement: str) -> None:
        with self.psycopg.connect(
            dbname="eph_bootstrap", connect_timeout=2, autocommit=True
        ) as admin:
            admin.execute(statement)

    def _connect(self):
        return self.psycopg.connect(dbname=self.dbname, connect_timeout=2)

    def _get_rows(self) -> list[tuple]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT trial_key, agent, learning_pattern_id, event, actor, payload, dedupe_key"
                " FROM core.autoagent_trial_ledger ORDER BY id"
            )
            return cur.fetchall()

    def test_an_insert_lands_with_every_column_it_was_given(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        ledger = self.writer.TRIAL_LEDGER

        inserted = self.writer.write_trial_ledger_row(
            ledger.EVENT.AA_ARM_DESIGN_EFFECT,
            ledger.ACTOR.AA,
            _DESIGN_EFFECT_PAYLOAD,
            trial_key=_TRIAL_KEY,
            agent=_AGENT,
            learning_pattern_id=42,
            dedupe_key=f"{_TRIAL_KEY}:look:1",
        )

        self.assertEqual(inserted, 1)
        self.assertEqual(
            self._get_rows(),
            [
                (
                    _TRIAL_KEY,
                    _AGENT,
                    42,
                    "aa-arm-design-effect",
                    "daemon-cycle-aa",
                    _DESIGN_EFFECT_PAYLOAD,
                    f"{_TRIAL_KEY}:look:1",
                )
            ],
        )

    def test_a_repeat_with_a_taken_dedupe_key_adds_no_row_and_keeps_the_first(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        ledger = self.writer.TRIAL_LEDGER
        first, repeat = ({"pass_count": 3}, {"pass_count": 5})

        counts = [
            self.writer.write_trial_ledger_row(
                ledger.EVENT.POWER_PASS_COUNT,
                ledger.ACTOR.SHADOW,
                payload,
                dedupe_key="power-pass-count:2026-10-07",
            )
            for payload in (first, repeat)
        ]

        self.assertEqual(counts, [1, 0])
        self.assertEqual([row[5] for row in self._get_rows()], [first])

    def test_an_unbound_delivery_row_lands_once_per_spool_line(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        ledger = self.writer.TRIAL_LEDGER
        event = _UNBOUND_DELIVERY.EVENT
        second_line = {**_UNBOUND_DELIVERY.PAYLOAD, "line_offset": 1, "salt_id": 7}

        counts = [
            self.writer.write_trial_ledger_row(
                event,
                ledger.ACTOR.AA,
                payload,
                agent=_AGENT,
                dedupe_key=f"{event}:{_SPOOL}:{payload['line_offset']}",
            )
            for payload in (_UNBOUND_DELIVERY.PAYLOAD, _UNBOUND_DELIVERY.PAYLOAD, second_line)
        ]

        self.assertEqual(counts, [1, 0, 1])
        self.assertEqual(
            [(row[1], row[3], row[4], row[5], row[6]) for row in self._get_rows()],
            [
                (_AGENT, event, "daemon-cycle-aa", payload, f"{event}:{_SPOOL}:{offset}")
                for offset, payload in enumerate((_UNBOUND_DELIVERY.PAYLOAD, second_line))
            ],
        )

    def test_an_invalidation_row_lands_once_per_start_id_and_keeps_the_first_cause(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        ledger = self.writer.TRIAL_LEDGER
        event = ledger.EVENT.AA_INVALIDATION
        first = {"start_id": 2, "cause": "duplicate exposure in the shared spawn read"}

        counts = [
            self.writer.write_trial_ledger_row(
                event, ledger.ACTOR.AA, payload, dedupe_key=f"{event}:2"
            )
            for payload in (first, {**first, "cause": "a later cause"})
        ]

        self.assertEqual(counts, [1, 0])
        self.assertEqual(
            [(row[3], row[5], row[6]) for row in self._get_rows()],
            [(event, first, f"{event}:2")],
        )

    def test_rows_without_a_dedupe_key_each_land(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        ledger = self.writer.TRIAL_LEDGER

        for _ in range(2):
            self.writer.write_trial_ledger_row(
                ledger.EVENT.AA_RESTART,
                ledger.ACTOR.AA,
                {
                    "start_id": 7,
                    "reason": "fingerprint-unreadable",
                    "fingerprint": None,
                },
            )

        self.assertEqual(
            [row[3] for row in self._get_rows()], ["aa-restart", "aa-restart"]
        )

    def test_without_the_ledger_table_the_write_skips_with_the_migration_named(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.ABSENT)
        ledger = self.writer.TRIAL_LEDGER
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            inserted = self.writer.write_trial_ledger_row(
                ledger.EVENT.AA_RESTART,
                ledger.ACTOR.AA,
                {
                    "start_id": 7,
                    "reason": "fingerprint-unreadable",
                    "fingerprint": None,
                },
            )

        self.assertEqual(inserted, 0)
        self.assertIn("WARN", stderr.getvalue())
        self.assertIn(
            "20261008000000_add_trial_ledger_and_cycle_verdicts", stderr.getvalue()
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
