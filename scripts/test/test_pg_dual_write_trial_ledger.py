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
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parents[2]
for _path in (
    _REPO_ROOT / "scripts",
    _REPO_ROOT / "autoagent",
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


# A verified non-safety auto candidate in the push's envelope shape.
_LIVE_PROPOSAL = {
    "cycle_date": "2026-10-11",
    "pattern_label": "budget overage recurs",
    "target_file": "agents/glass-atrium-dev-python.md",
    "target_agent": _AGENT,
    "classification": "apply",
    "rationale": "pattern recurred across 9 outcomes",
    "haiku_status": "ok",
    "approval_tier": "auto",
    "status": "pending",
    "reviewed_by": "daemon-cycle-push",
    "proposed_diff": "+keep the budget line",
    "cost_guard_state": "ok",
    "source_file": "autoagent-2026-10-11.json",
    "source_file_mtime": 1,
    "generator_input_version": "gen-inputs-2",
}
_METRIC_KEY = "budget_overage"
_DETECTION_START = datetime(2026, 9, 27, tzinfo=timezone.utc)
_PAYLOAD = SimpleNamespace(
    # an A/A arm-difference design-effect row in the writer's shape
    DESIGN_EFFECT={
        "metric_key": _METRIC_KEY,
        **trial_design.ArmDesignEffect(1.1, 33, 1061, 0.8, 1.6, 2000)._asdict(),
    },
    # the cycle's pre-registration body (daemon_cycle.get_preregistration_payload's shape)
    PREREGISTRATION={
        "metric_key": _METRIC_KEY,
        "detection_start": _DETECTION_START.isoformat(),
        "baseline": {"events": 40, "spawns": 1061},
        "maximum_per_arm": 512,
        "design_effect": 1.1,
        "required_units": 1126,
        "boundaries": [3.9, 2.9, 2.3, 2.0],
        "looks": [{"fraction": 0.25, "milestone": 281.5, "boundary": 3.9}],
        "task_window_seconds": 3600.0,
    },
)
_TRIAL_LEDGER_MIGRATION = "20261008000000_add_trial_ledger_and_cycle_verdicts"


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
                    {k: v for k, v in _PAYLOAD.DESIGN_EFFECT.items() if k != "metric_key"},
                ),
                (
                    "design-effect payload with an extra key",
                    design_effect,
                    ledger.ACTOR.AA,
                    {**_PAYLOAD.DESIGN_EFFECT, "selected": 2.1},
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

    def test_a_preregistration_payload_that_is_no_object_is_refused_before_connecting(
        self,
    ) -> None:
        # The push adds the proposal id to the body, so only an object can carry it.
        rows = (
            ("array (a serialized NamedTuple)", [0.25, 40]),
            ("empty array", []),
            ("text", "looks"),
            ("number", 3),
            ("false", False),
        )
        with _load_helper() as helper:
            for name, payload in rows:
                with (
                    self.subTest(name),
                    mock.patch.object(helper, "_connect") as connect,
                ):
                    with self.assertRaises(helper.PreregistrationPayloadNotObject):
                        helper.write_autoagent_proposal_preregistration(
                            payload, **_LIVE_PROPOSAL
                        )
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

    def test_the_live_trial_rows_pass_the_closed_sets_with_any_payload_and_reach_the_connection(
        self,
    ) -> None:
        # Live payloads stay free-form until their key set is declared: any shape is written.
        live_actor = "daemon-cycle-live"
        rows = (
            (
                "pre-registration",
                "live-preregistration",
                {"proposal_id": 4127, "looks": [{"fraction": 0.25, "milestone": 40}]},
            ),
            (
                "pre-registration, other keys",
                "live-preregistration",
                {"metric_key": "budget_overage"},
            ),
            ("look", "live-look", {"look": 1, "accrued": 40}),
            ("look, empty object", "live-look", {}),
            ("decision", "live-decision", {"outcome": "win"}),
            ("decision, no object", "live-decision", ["horizon"]),
        )
        with _load_helper() as helper:
            for name, event, payload in rows:
                with (
                    self.subTest(name),
                    mock.patch.object(helper, "_connect") as connect,
                ):
                    helper.write_trial_ledger_row(event, live_actor, payload)
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
            _PAYLOAD.DESIGN_EFFECT,
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
                    _PAYLOAD.DESIGN_EFFECT,
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

    def _seed_pattern(self) -> int:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.learning_log (discovered_date, pattern_signature, frequency,"
                " agent, status, approval_tier, last_updated)"
                " VALUES ('2026-10-04', %s, 9, %s, 'identified', 'user-pending', now())"
                " RETURNING id",
                (f"budget overage recurs|{_AGENT}", _AGENT),
            )
            return cur.fetchone()[0]

    def _write_bound(self, payload: object = None, **overrides: object) -> None:
        self.writer.write_autoagent_proposal_preregistration(
            _PAYLOAD.PREREGISTRATION if payload is None else payload,
            **{**_LIVE_PROPOSAL, "learning_pattern_id": self.pattern_id, **overrides},
        )

    def _get_proposal_ids(self) -> list[int]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT id FROM core.autoagent_proposals ORDER BY id")
            return [row[0] for row in cur.fetchall()]

    def _use_bound_database(self, template: str) -> None:
        self._use_database(template)
        self.pattern_id = self._seed_pattern()

    def test_one_commit_writes_the_proposal_row_and_its_live_preregistration_keyed_by_its_id(
        self,
    ) -> None:
        self._use_bound_database(self._TEMPLATE.FULL)

        self._write_bound()

        (proposal_id,) = self._get_proposal_ids()
        key = self.writer.get_live_trial_key(proposal_id)
        self.assertEqual(
            self._get_rows(),
            [
                (
                    key,
                    _AGENT,
                    self.pattern_id,
                    "live-preregistration",
                    "daemon-cycle-live",
                    {**_PAYLOAD.PREREGISTRATION, "proposal_id": proposal_id},
                    key,
                )
            ],
        )

    def test_the_written_preregistration_keys_are_the_cycle_body_keys_and_the_proposal_id(
        self,
    ) -> None:
        # Live readers' keys: the trial-to-proposal join reads proposal_id, the look writer looks.
        self._use_bound_database(self._TEMPLATE.FULL)

        self._write_bound()

        (row,) = self._get_rows()
        self.assertEqual(
            sorted(row[5]),
            [
                "baseline",
                "boundaries",
                "design_effect",
                "detection_start",
                "looks",
                "maximum_per_arm",
                "metric_key",
                "proposal_id",
                "required_units",
                "task_window_seconds",
            ],
        )

    def test_a_stored_shadow_preregistration_of_the_same_pair_never_takes_the_live_row_key(
        self,
    ) -> None:
        import daemon_cycle

        self._use_bound_database(self._TEMPLATE.FULL)
        ledger = self.writer.TRIAL_LEDGER
        pattern = daemon_cycle.Pattern(
            date="2026-10-04",
            label="budget overage recurs",
            frequency="9",
            agent=_AGENT,
            status="identified",
            tier="user-pending",
            raw_line=f"pg:learning_log:{self.pattern_id}:budget overage recurs|{_AGENT}",
            row_id=self.pattern_id,
            metric_key=_METRIC_KEY,
        )
        shadow_key = daemon_cycle.get_trial_key(pattern, _DETECTION_START)
        self.writer.write_trial_ledger_row(
            ledger.EVENT.SHADOW_PREREGISTRATION,
            ledger.ACTOR.SHADOW,
            _PAYLOAD.PREREGISTRATION,
            trial_key=shadow_key,
            agent=_AGENT,
            learning_pattern_id=self.pattern_id,
            dedupe_key=shadow_key,
        )

        self._write_bound()

        (proposal_id,) = self._get_proposal_ids()
        self.assertEqual(
            [(row[3], row[6]) for row in self._get_rows()],
            [
                ("shadow-preregistration", shadow_key),
                ("live-preregistration", self.writer.get_live_trial_key(proposal_id)),
            ],
        )

    def test_the_same_pairs_proposal_on_another_day_gets_its_own_live_preregistration(
        self,
    ) -> None:
        self._use_bound_database(self._TEMPLATE.FULL)

        for cycle_date in ("2026-10-11", "2026-10-12"):
            self._write_bound(cycle_date=cycle_date)

        proposal_ids = self._get_proposal_ids()
        self.assertEqual(len(proposal_ids), 2)
        self.assertEqual(
            [row[6] for row in self._get_rows()],
            [
                self.writer.get_live_trial_key(proposal_id)
                for proposal_id in proposal_ids
            ],
        )

    def test_a_ledger_fault_writes_neither_row_and_propagates_naming_an_absent_table_by_its_migration(
        self,
    ) -> None:
        # (name, template, body, the writer's named fault class | None = the driver's error)
        rows = (
            (
                "ledger table absent",
                self._TEMPLATE.ABSENT,
                _PAYLOAD.PREREGISTRATION,
                "TrialLedgerAbsent",
            ),
            (
                "body the ledger rejects as JSON",
                self._TEMPLATE.FULL,
                {**_PAYLOAD.PREREGISTRATION, "design_effect": float("nan")},
                None,
            ),
        )
        for name, template, payload, fault_name in rows:
            with self.subTest(name):
                self._use_bound_database(template)
                fault = (
                    getattr(self.writer, fault_name)
                    if fault_name
                    else self.psycopg.Error
                )

                with self.assertRaises(fault) as raised:
                    self._write_bound(payload)

                self.assertEqual(self._get_proposal_ids(), [])
                if fault_name:
                    self.assertIn(_TRIAL_LEDGER_MIGRATION, str(raised.exception))
                else:
                    self.assertEqual(self._get_rows(), [])

    def test_a_frozen_proposal_row_gets_no_live_preregistration(self) -> None:
        self._use_bound_database(self._TEMPLATE.FULL)
        self.writer.write_autoagent_proposal(
            **{**_LIVE_PROPOSAL, "learning_pattern_id": self.pattern_id}
        )
        with self._connect() as conn:
            conn.execute(
                "UPDATE core.autoagent_proposals"
                " SET status = 'rejected', reviewed_at = now()"
            )

        with contextlib.redirect_stderr(io.StringIO()):
            self._write_bound()

        self.assertEqual(self._get_rows(), [])

    def test_a_same_key_recall_keeps_one_proposal_row_and_its_first_preregistration(
        self,
    ) -> None:
        self._use_bound_database(self._TEMPLATE.FULL)
        recall = {**_PAYLOAD.PREREGISTRATION, "required_units": 2048}

        self._write_bound()
        self._write_bound(recall)

        (proposal_id,) = self._get_proposal_ids()
        self.assertEqual(
            [row[5] for row in self._get_rows()],
            [{**_PAYLOAD.PREREGISTRATION, "proposal_id": proposal_id}],
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
