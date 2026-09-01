"""Loader test for the daemon per-call budget-cap SoT (hooks/daemon_config.py).

The consumer end was previously untested: the autoagent loop and the wiki loop
both read the per-call ``--max-budget-usd`` ceiling + Haiku model id via
``load_daemon_config`` and pass the values VERBATIM to ``claude -p
--max-budget-usd <value>``. A regression in the fallback policy (raising on a
missing/corrupt file, dropping a key, or float-coercing the decimal string)
would either break import for the ~7 test modules that import daemon_cycle.py
at collection time, or silently mis-budget every Haiku call. Protected
invariants:

(1) the live config read yields exactly the 3 contract keys, all non-empty str;
(2) every degradation branch (missing file / corrupt JSON / non-dict payload /
    missing key / non-string value / empty-string value) falls back per-key
    WITHOUT raising — a partially-valid file still contributes its good keys;
(3) the ``_comment`` documentation key is ignored (never leaks into output);
(4) the values are STRINGS in 2-decimal form ('10.00', not 10 or 10.0) — the
    CLI consumes the decimal as-is, so a float re-serialize would drift;
(5) the module-level constants (WORKER_MAX_BUDGET_USD / PRE_VERIFY_MAX_BUDGET_USD
    / WORKER_MODEL) — the names the daemon binds to — equal the loaded values.

No database needed. Each error-branch case writes a throwaway config into a
TemporaryDirectory and passes it via the ``path`` injection arg.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_daemon_config_loader.py -v
    python3 -m unittest hooks.test.test_daemon_config_loader -v

CID: 2026-06-13T0500_session-test-audit_e9b4
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

_HOOKS_ROOT = Path(__file__).resolve().parent.parent

# daemon_config lives in the hooks dir under a plain (non-dashed) name — direct
# import once the hooks dir is on sys.path, matching the daemon's own insert.
if str(_HOOKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HOOKS_ROOT))

import daemon_config as dc  # noqa: E402 — sys.path insert immediately above

_CONTRACT_KEYS = ("worker_max_budget_usd", "pre_verify_max_budget_usd", "worker_model")


def _write_config(payload: object) -> Path:
    """Serialize ``payload`` to a throwaway config file, returning its path.

    Non-dict / non-JSON payloads are passed through json.dumps so the loader's
    own json.loads sees a valid-JSON-but-wrong-shape document; a raw corrupt
    string is written verbatim via the ``raw_text`` escape hatch below.
    """
    tmp = Path(tempfile.mkdtemp()) / "daemon-config.json"
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    return tmp


def _write_raw(raw_text: str) -> Path:
    tmp = Path(tempfile.mkdtemp()) / "daemon-config.json"
    tmp.write_text(raw_text, encoding="utf-8")
    return tmp


class LiveConfigReadTest(unittest.TestCase):
    """The default (live) read — the path the daemon actually exercises."""

    def test_live_read_yields_exactly_three_contract_keys(self) -> None:
        out = dc.load_daemon_config()
        self.assertEqual(set(out.keys()), set(_CONTRACT_KEYS))

    def test_live_values_are_non_empty_strings(self) -> None:
        out = dc.load_daemon_config()
        for key in _CONTRACT_KEYS:
            self.assertIsInstance(out[key], str, f"{key} must be str")
            self.assertTrue(out[key], f"{key} must be non-empty")

    def test_budget_values_are_string_decimals_not_floats(self) -> None:
        # The CLI consumes the decimal verbatim — a float-coerced value would
        # re-serialize without the trailing zero and drift from the contract.
        out = dc.load_daemon_config()
        for key in ("worker_max_budget_usd", "pre_verify_max_budget_usd"):
            self.assertIsInstance(out[key], str)
            # parseable as a float, yet retained as a string token
            float(out[key])
            self.assertNotIsInstance(out[key], float)


class FallbackBranchTest(unittest.TestCase):
    """Every degradation path returns the fallback literals without raising."""

    def test_missing_file_returns_full_fallback(self) -> None:
        missing = Path(tempfile.mkdtemp()) / "does-not-exist.json"
        out = dc.load_daemon_config(path=missing)
        self.assertEqual(out, dict(dc._FALLBACK))

    def test_corrupt_json_returns_full_fallback_and_warns(self) -> None:
        path = _write_raw("{ this is not json ")
        buf = io.StringIO()
        with redirect_stderr(buf):
            out = dc.load_daemon_config(path=path)
        self.assertEqual(out, dict(dc._FALLBACK))
        self.assertIn("daemon-config", buf.getvalue())

    def test_non_dict_payload_returns_full_fallback_and_warns(self) -> None:
        path = _write_config(["not", "a", "dict"])
        buf = io.StringIO()
        with redirect_stderr(buf):
            out = dc.load_daemon_config(path=path)
        self.assertEqual(out, dict(dc._FALLBACK))
        self.assertIn("daemon-config", buf.getvalue())

    def test_missing_key_degrades_only_that_key(self) -> None:
        # Two valid keys + one absent → the absent one falls back, others honored.
        path = _write_config(
            {
                "worker_max_budget_usd": "1.25",
                "pre_verify_max_budget_usd": "1.25",
                # worker_model intentionally absent
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["worker_max_budget_usd"], "1.25")
        self.assertEqual(out["pre_verify_max_budget_usd"], "1.25")
        self.assertEqual(out["worker_model"], dc._FALLBACK["worker_model"])

    def test_non_string_value_degrades_to_fallback(self) -> None:
        # A JSON number (the most likely human mistake) must NOT be accepted —
        # it would break the verbatim-string CLI contract.
        path = _write_config(
            {
                "worker_max_budget_usd": 0.5,  # number, not "0.50"
                "pre_verify_max_budget_usd": "0.75",
                "worker_model": "claude-haiku-4-5",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["worker_max_budget_usd"], dc._FALLBACK["worker_max_budget_usd"])
        self.assertEqual(out["pre_verify_max_budget_usd"], "0.75")

    def test_empty_string_value_degrades_to_fallback(self) -> None:
        path = _write_config(
            {
                "worker_max_budget_usd": "",
                "pre_verify_max_budget_usd": "0.60",
                "worker_model": "claude-haiku-4-5",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["worker_max_budget_usd"], dc._FALLBACK["worker_max_budget_usd"])
        self.assertEqual(out["pre_verify_max_budget_usd"], "0.60")

    def test_comment_key_is_ignored(self) -> None:
        path = _write_config(
            {
                "_comment": "documentation only",
                "worker_max_budget_usd": "0.50",
                "pre_verify_max_budget_usd": "0.50",
                "worker_model": "claude-haiku-4-5",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertNotIn("_comment", out)
        self.assertEqual(set(out.keys()), set(_CONTRACT_KEYS))


class ConsumerBindingTest(unittest.TestCase):
    """The module constants the daemon imports must equal the loaded values."""

    def test_module_constants_match_loaded_config(self) -> None:
        loaded = dc.load_daemon_config()
        self.assertEqual(dc.WORKER_MAX_BUDGET_USD, loaded["worker_max_budget_usd"])
        self.assertEqual(dc.PRE_VERIFY_MAX_BUDGET_USD, loaded["pre_verify_max_budget_usd"])
        self.assertEqual(dc.WORKER_MODEL, loaded["worker_model"])

    def test_module_constants_are_non_empty_strings(self) -> None:
        for value in (dc.WORKER_MAX_BUDGET_USD, dc.PRE_VERIFY_MAX_BUDGET_USD, dc.WORKER_MODEL):
            self.assertIsInstance(value, str)
            self.assertTrue(value)


class WorkerModelFallbackTest(unittest.TestCase):
    """The absent-config worker-model fallback.

    SUPERSEDES the former T13 alias-de-scope assertions, which required the
    fallback to be an UNPINNED family alias with no digit in it. That policy was
    retired together with haiku: the monitor rejects bare aliases on this very
    domain (REJECTED_ALIAS_VALUES), and a bare alias has no hooks/pricing.json row,
    so an alias fallback could never be costed. The requirement it is replaced by
    is strictly stronger than "contains no digit" — the fallback must be an id the
    pricing SoT can actually price, which a family alias never was.
    """

    def test_absent_config_falls_back_to_a_concrete_priceable_id(self) -> None:
        missing = Path(tempfile.mkdtemp()) / "does-not-exist.json"
        model = dc.load_daemon_config(path=missing)["worker_model"]
        self.assertNotIn(
            model,
            {"haiku", "sonnet", "opus"},
            "fallback must not be a bare alias — the monitor rejects those and "
            "pricing.json cannot price them",
        )
        pricing = json.loads(
            (Path(dc.__file__).parent / "pricing.json").read_text(encoding="utf-8")
        )
        models = pricing.get("models", pricing)
        self.assertIn(
            model,
            models,
            f"fallback {model!r} has no hooks/pricing.json row — the loop's spend "
            f"would be uncosted",
        )

    def test_absent_config_fallback_is_not_a_retired_haiku_id(self) -> None:
        # The point of the retirement: a fresh install must not land on haiku.
        missing = Path(tempfile.mkdtemp()) / "does-not-exist.json"
        model = dc.load_daemon_config(path=missing)["worker_model"]
        self.assertNotIn("haiku", model, "haiku is retired for the daemon loops")

    def test_shell_seam_fallback_matches_the_python_fallback(self) -> None:
        # The two seams read the SAME daemon-config.json, so a divergent literal
        # means the shell and Python halves of one cycle run different models —
        # the drift this pair actually carried before the retirement
        # (python 'haiku' vs shell 'claude-haiku-4-5').
        shell = (
            Path(dc.__file__).resolve().parents[1] / "scripts" / "lib" / "atrium-config.sh"
        ).read_text(encoding="utf-8")
        body = shell.split("atrium_resolve_worker_model() {", 1)[1].split("\n}", 1)[0]
        self.assertIn(
            f'local model="{dc._FALLBACK["worker_model"]}"',
            body,
            "shell resolver fallback literal must equal _FALLBACK['worker_model']",
        )

    def test_config_present_model_is_honored(self) -> None:
        # The config lookup still wins when present — the daemon reads from config.
        path = _write_config(
            {
                "worker_max_budget_usd": "0.50",
                "pre_verify_max_budget_usd": "0.50",
                "worker_model": "claude-opus-4-8",
            }
        )
        self.assertEqual(dc.load_daemon_config(path=path)["worker_model"], "claude-opus-4-8")


class BudgetFloorTest(unittest.TestCase):
    """The absent-config budget floor.

    The rest of this module asserts degradation branches AGAINST ``_FALLBACK``,
    which means the floor VALUE itself was pinned by nothing — it could drift to
    any string and every other test here would stay green. These pin it.
    """

    _EXPECTED_FLOOR = "10.00"
    _BUDGET_KEYS = ("worker_max_budget_usd", "pre_verify_max_budget_usd")

    def test_floor_is_the_expected_value(self) -> None:
        for key in self._BUDGET_KEYS:
            self.assertEqual(dc._FALLBACK[key], self._EXPECTED_FLOOR, key)

    def test_floor_is_two_decimal_string_form(self) -> None:
        # Passed verbatim to `claude -p --max-budget-usd`; the monitor validates
        # the same shape (BUDGET_VALUE_PATTERN). '10' or a float 10.0 would drift.
        for key in self._BUDGET_KEYS:
            value = dc._FALLBACK[key]
            self.assertIsInstance(value, str, key)
            self.assertRegex(value, r"^\d+\.\d{2}$", key)

    def test_floor_clears_the_cli_exit_1_threshold(self) -> None:
        # Below ~0.05 the CLI exits 1 immediately, whatever the model.
        for key in self._BUDGET_KEYS:
            self.assertGreaterEqual(float(dc._FALLBACK[key]), 0.05, key)

    def test_floor_matches_the_shipped_db_seed(self) -> None:
        # The floor's stated rationale is PARITY WITH THE DB SEED, so check it
        # against the seed rather than restating the number in prose. Raising one
        # side without the other re-opens the pre-Save/post-Save split this closes.
        migrations = (
            Path(dc.__file__).resolve().parents[1] / "monitor" / "prisma" / "migrations"
        )
        seeded = {
            value
            for sql in migrations.glob("*/migration.sql")
            for key, value in re.findall(
                r"\('(budget\.[a-z_]+)',\s*'([0-9]+\.[0-9]{2})'", sql.read_text(encoding="utf-8")
            )
        }
        self.assertTrue(seeded, "no budget seed literal found in any migration")
        self.assertEqual(
            seeded,
            {self._EXPECTED_FLOOR},
            f"DB budget seeds {sorted(seeded)} disagree with the in-code floor "
            f"{self._EXPECTED_FLOOR} — the two must move together",
        )


class LegacyKeyCompatTest(unittest.TestCase):
    """Read-side compatibility for a daemon-config.json written before the rename.

    Without this an existing install silently falls back to the in-code literals
    the moment its saved keys stop being read, discarding the operator's values.
    """

    def test_legacy_keys_are_read_when_current_keys_absent(self) -> None:
        path = _write_config(
            {
                "haiku_max_budget_usd": "1.25",
                "pre_verify_max_budget_usd": "0.50",
                "haiku_model": "claude-opus-4-8",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["worker_model"], "claude-opus-4-8")
        self.assertEqual(out["worker_max_budget_usd"], "1.25")

    def test_current_key_wins_over_legacy_key(self) -> None:
        path = _write_config(
            {
                "worker_model": "claude-sonnet-4-6",
                "haiku_model": "claude-haiku-4-5",
                "worker_max_budget_usd": "2.00",
                "haiku_max_budget_usd": "9.99",
                "pre_verify_max_budget_usd": "0.50",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["worker_model"], "claude-sonnet-4-6")
        self.assertEqual(out["worker_max_budget_usd"], "2.00")

    def test_legacy_read_warns_loudly(self) -> None:
        # Precondition Loud-Fail: a legacy read is a live misconfiguration, so it
        # must never be silent — the operator has to know to re-save.
        path = _write_config({"haiku_model": "claude-opus-4-8"})
        buf = io.StringIO()
        with redirect_stderr(buf):
            dc.load_daemon_config(path=path)
        self.assertIn("haiku_model", buf.getvalue())
        self.assertIn("WARN", buf.getvalue())

    def test_module_import_is_stderr_silent_on_a_legacy_config(self) -> None:
        # REGRESSION: the legacy WARN originally fired from the module-level
        # _CONFIG resolution, so merely IMPORTING this module printed to stderr.
        # That broke the sensitive-patterns guard CLI's byte-silent clean-path
        # contract (test_sensitive_patterns.CliExitContract), which imports this
        # transitively. Import must stay silent; the loud channel is the shell seam.
        path = _write_config({"haiku_model": "claude-opus-4-8"})
        res = subprocess.run(
            [sys.executable, "-c", "import daemon_config"],
            cwd=str(Path(dc.__file__).parent),
            env={**os.environ, "DAEMON_CONFIG": str(path)},
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stderr, "", "importing daemon_config must not write to stderr")

    def test_legacy_keys_in_use_is_exposed_for_callers(self) -> None:
        # The silent import still has to make the fact retrievable.
        path = _write_config({"haiku_model": "claude-opus-4-8"})
        dc.load_daemon_config(path=path, warn=False)
        self.assertIn("haiku_model", dc.LEGACY_KEYS_IN_USE)
        clean = _write_config(
            {
                "worker_model": "claude-sonnet-4-6",
                "worker_max_budget_usd": "0.50",
                "pre_verify_max_budget_usd": "0.50",
            }
        )
        dc.load_daemon_config(path=clean, warn=False)
        self.assertEqual(dc.LEGACY_KEYS_IN_USE, ())

    def test_no_warning_when_no_legacy_key_present(self) -> None:
        path = _write_config(
            {
                "worker_model": "claude-sonnet-4-6",
                "worker_max_budget_usd": "0.50",
                "pre_verify_max_budget_usd": "0.50",
            }
        )
        buf = io.StringIO()
        with redirect_stderr(buf):
            dc.load_daemon_config(path=path)
        self.assertEqual(buf.getvalue(), "")


class CostTierRuleTextTest(unittest.TestCase):
    """T13 AC1 — the Cost-Tier rule text is labeled a judgment heuristic and cites
    the daemon's configuration-read mechanism."""

    _RULE_PATH = _HOOKS_ROOT.parent / "rules" / "glass-atrium" / "orchestrator-role.md"

    @unittest.skipUnless(_RULE_PATH.exists(), "orchestrator-role.md not present in this tree")
    def test_cost_tier_section_labeled_heuristic_and_cites_mechanism(self) -> None:
        rule = self._RULE_PATH.read_text(encoding="utf-8")
        self.assertIn("### Cost-Tier Selection", rule)
        section = rule.split("### Cost-Tier Selection", 1)[1].split("###", 1)[0]
        self.assertIn(
            "judgment heuristic", section, "table must be labeled a judgment heuristic"
        )
        self.assertIn(
            "daemon_config.py", section, "must cite the daemon config-read mechanism"
        )
        self.assertIn(
            "session default", section, "must state the unpinned session-default fallback"
        )


if __name__ == "__main__":
    unittest.main()
