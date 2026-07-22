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
(4) the values are STRINGS preserving the trailing zero ('0.50', not 0.5) —
    the CLI consumes the decimal as-is, so a float re-serialize would drift;
(5) the module-level constants (HAIKU_MAX_BUDGET_USD / PRE_VERIFY_MAX_BUDGET_USD
    / HAIKU_MODEL) — the names the daemon binds to — equal the loaded values.

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
import re
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

_CONTRACT_KEYS = ("haiku_max_budget_usd", "pre_verify_max_budget_usd", "haiku_model")

# A pinned/dated model version, e.g. claude-haiku-4-5 — the shape T13 bars from the
# automation module (the daemon reads its model from config; the absent-config
# fallback is an unpinned family alias, never a dated pin).
_PINNED_MODEL = re.compile(r"claude-[a-z]+-\d")


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
        for key in ("haiku_max_budget_usd", "pre_verify_max_budget_usd"):
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
                "haiku_max_budget_usd": "1.25",
                "pre_verify_max_budget_usd": "1.25",
                # haiku_model intentionally absent
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["haiku_max_budget_usd"], "1.25")
        self.assertEqual(out["pre_verify_max_budget_usd"], "1.25")
        self.assertEqual(out["haiku_model"], dc._FALLBACK["haiku_model"])

    def test_non_string_value_degrades_to_fallback(self) -> None:
        # A JSON number (the most likely human mistake) must NOT be accepted —
        # it would break the verbatim-string CLI contract.
        path = _write_config(
            {
                "haiku_max_budget_usd": 0.5,  # number, not "0.50"
                "pre_verify_max_budget_usd": "0.75",
                "haiku_model": "claude-haiku-4-5",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["haiku_max_budget_usd"], dc._FALLBACK["haiku_max_budget_usd"])
        self.assertEqual(out["pre_verify_max_budget_usd"], "0.75")

    def test_empty_string_value_degrades_to_fallback(self) -> None:
        path = _write_config(
            {
                "haiku_max_budget_usd": "",
                "pre_verify_max_budget_usd": "0.60",
                "haiku_model": "claude-haiku-4-5",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertEqual(out["haiku_max_budget_usd"], dc._FALLBACK["haiku_max_budget_usd"])
        self.assertEqual(out["pre_verify_max_budget_usd"], "0.60")

    def test_comment_key_is_ignored(self) -> None:
        path = _write_config(
            {
                "_comment": "documentation only",
                "haiku_max_budget_usd": "0.50",
                "pre_verify_max_budget_usd": "0.50",
                "haiku_model": "claude-haiku-4-5",
            }
        )
        out = dc.load_daemon_config(path=path)
        self.assertNotIn("_comment", out)
        self.assertEqual(set(out.keys()), set(_CONTRACT_KEYS))


class ConsumerBindingTest(unittest.TestCase):
    """The module constants the daemon imports must equal the loaded values."""

    def test_module_constants_match_loaded_config(self) -> None:
        loaded = dc.load_daemon_config()
        self.assertEqual(dc.HAIKU_MAX_BUDGET_USD, loaded["haiku_max_budget_usd"])
        self.assertEqual(dc.PRE_VERIFY_MAX_BUDGET_USD, loaded["pre_verify_max_budget_usd"])
        self.assertEqual(dc.HAIKU_MODEL, loaded["haiku_model"])

    def test_module_constants_are_non_empty_strings(self) -> None:
        for value in (dc.HAIKU_MAX_BUDGET_USD, dc.PRE_VERIFY_MAX_BUDGET_USD, dc.HAIKU_MODEL):
            self.assertIsInstance(value, str)
            self.assertTrue(value)


class ModelTierDescopeTest(unittest.TestCase):
    """T13 — honest de-scope of the daemon model constant.

    AC2: the automation module holds no pinned/dated model version — the model is
    read from configuration (``load_daemon_config`` → ``haiku_model``).
    AC3: an absent config falls back to the unpinned session default (a family
    alias), never a dated version pin.
    """

    def test_source_holds_no_pinned_model_version(self) -> None:
        # AC2 grep: the constant's absence — no dated claude-<family>-<n> pin in
        # the automation module (the fallback is now a family alias).
        src = Path(dc.__file__).read_text(encoding="utf-8")
        self.assertIsNone(
            _PINNED_MODEL.search(src),
            "daemon_config.py must not hardcode a dated model version — read from config",
        )

    def test_absent_config_falls_back_to_session_default_not_pinned(self) -> None:
        # AC3: missing config → the session-default family alias, not a dated pin.
        missing = Path(tempfile.mkdtemp()) / "does-not-exist.json"
        model = dc.load_daemon_config(path=missing)["haiku_model"]
        self.assertNotRegex(model, r"\d", "fallback must not be a dated version pin")
        self.assertIn(
            model, {"haiku", "sonnet", "opus"}, "fallback must be an unpinned family alias"
        )

    def test_config_present_model_is_honored(self) -> None:
        # The config lookup still wins when present — the daemon reads from config.
        path = _write_config(
            {
                "haiku_max_budget_usd": "0.50",
                "pre_verify_max_budget_usd": "0.50",
                "haiku_model": "claude-haiku-4-5",
            }
        )
        self.assertEqual(dc.load_daemon_config(path=path)["haiku_model"], "claude-haiku-4-5")


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
