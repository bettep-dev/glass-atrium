"""SoT-world pricing tests — pricing.json + pricing_loader + both consumers.

The former lockstep contract (two hand-mirrored PRICING dict copies held
byte-identical by this suite) is retired: cost-tracker.sh's embedded parser and
backfill-cost-events.py both import the shared hooks/lib/pricing_loader.py over
the hooks/pricing.json SoT (CID 2026-07-02T1055_pricing-sot_e7b2, plan P5).
Protected invariants:

(1) SoT load/validate — the production pricing.json parses + validates, two
    anchor rows (opus-4-8 / fable-5) are transcribed at their exact per-MTok
    rates (INVARIANTS + anchors only, deliberately NOT exact-set/tier-shape
    pins: a routine operator edit — new models row, rate change, new intro
    tier — stays a single-file edit), the fallback_model row dominates every
    other row (conservative unknown-model pricing), and remote_sources is the
    ordered own-repo (#1, format=sot) -> litellm (#2, format=litellm) array
    with the shared overlay config TOP-LEVEL; malformed fixtures loud-fail
    with PricingSotError, never a silent partial load.
(2) rate_for known rates — SoT hits resolve with label "sot" and ZERO network
    I/O (the fetch seam is trap-patched), reproducing the cost anchors:
    opus-4-8 1000in/500out = 0.0175, fable-5 = 0.035, dated haiku = 0.0035.
(3) tier-by-date boundaries (FIXTURE SoT — the production tier's eventual
    expiry/removal must not break loader-behavior tests) — intro 0.007 on
    2026-08-31 (inclusive), standard 0.0105 from 2026-09-01; BASE_RATE and
    malformed dates select standard.
(4) normalize_model_key — strips the "[1m]" context-variant and "-YYYYMMDD"
    snapshot suffixes; idempotent otherwise.
(5) fallback chain (MOCKED remote — zero live network) — overlay TTL
    fresh-vs-stale, ordered multi-source remote (own-repo #1 format=sot
    PASSTHROUGH vs litellm #2 per-token -> x1e6 conversion; first sane hit
    wins + short-circuits the rest; own-repo 404 fails open to litellm) +
    overlay persist recording the winning source name, kill-switch, sanity
    rejection PER source (negative / >=$1000/MTok / missing-field /
    non-numeric — loud, never persisted), per-source URL allowlist pin
    negative cases (fetch NEVER invoked, iteration continues), per-source
    per-process failed-fetch memo (loud once, then no further attempts for
    THAT source only), family-latest, conservative fallback.
(6) consumer posture — importing backfill-cost-events.py sets
    PRICING_REMOTE_DISABLE by default (deterministic network-free batch), its
    calc_cost is batch-quiet (no stderr) while still ALWAYS pricing unknown
    models, and pricing_loader.is_known gates the reprice path.
(7) F3 own-repo self-refresh (MOCKED remote, sandboxed fixture SoT — never
    the production pricing.json) — a fetched own-repo doc that validates as
    a FULL SoT, carries a strictly-newer last_verified within today+1d, and
    passes the whole-doc rate-sanity sweep atomically replaces the local
    SoT (loud advisory naming BOTH stamps, memo invalidated, re-lookup
    honors the caller's effective_date, steps 4-5 re-bind the refreshed
    doc); not-newer / future-bound / write-failed degrade to per-model use +
    overlay persist as before; a schema-invalid or rate-poisoned doc is
    rejected WHOLE (no write, no per-model use, chain continues); the
    kill-switch disables the refresh; the SoT-hit happy path never fetches
    or writes.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_cost_pricing.py -v
    python3 -m unittest hooks.test.test_cost_pricing -v

CID: 2026-07-02T1055_pricing-sot_e7b2
"""

from __future__ import annotations

import datetime
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

_HOOKS_ROOT = Path(__file__).resolve().parent.parent
_SOT_PATH = _HOOKS_ROOT / "pricing.json"
_LIB_DIR = _HOOKS_ROOT / "lib"
_BACKFILL = _HOOKS_ROOT / "backfill-cost-events.py"

# Same sys.path seam the consumers use (PRICING_LIB_DIR / Path(__file__)/lib).
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import pricing_loader  # noqa: E402 — sys.path insert immediately above

# Observing the backfill batch posture (its PRICING_REMOTE_DISABLE setdefault
# on import) requires the knob to be ABSENT before the import — clear any
# ambient value first, then capture what the import left behind.
os.environ.pop("PRICING_REMOTE_DISABLE", None)


def _load_backfill():
    """Import backfill-cost-events.py despite the dashed filename. The module
    guards its entry point under ``if __name__ == "__main__"``, so import runs
    no backfill."""
    spec = importlib.util.spec_from_file_location("backfill_cost_events", _BACKFILL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


backfill = _load_backfill()
_BACKFILL_IMPORT_REMOTE_DISABLE = os.environ.get("PRICING_REMOTE_DISABLE")

_OPUS_RATE = {"input": 5.0, "output": 25.0, "cache_read": 0.5, "cache_creation": 6.25}
_FABLE_RATE = {"input": 10.0, "output": 50.0, "cache_read": 1.0, "cache_creation": 12.5}
_SONNET_STANDARD = {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_creation": 3.75}
_SONNET5_INTRO = {"input": 2.0, "output": 10.0, "cache_read": 0.2, "cache_creation": 2.5}
_HAIKU_RATE = {"input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_creation": 1.25}

# The two committed remote_sources urls, in declared order (own-repo #1 is
# the PREDICTED post-merge raw address — 404s by design until pushed).
_OWN_REPO_REMOTE_URL = (
    "https://raw.githubusercontent.com/bettep-dev/glass-atrium/"
    "main/hooks/pricing.json"
)
_LITELLM_REMOTE_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/"
    "main/model_prices_and_context_window.json"
)

# The pinned per-source repo prefixes as https base URLs — the single home of
# the anchors the allowlist escape-rejection tests build attack paths on.
_PIN_BASES = {
    "own-repo": "https://raw.githubusercontent.com/bettep-dev/glass-atrium/",
    "litellm": "https://raw.githubusercontent.com/BerriAI/litellm/",
}

_RATE_FIELDS = ("input", "output", "cache_read", "cache_creation")


def _cost(rate, it=1000, ot=500, cr=0, cc=0):
    """USD cost from a per-MTok rate dict — the arithmetic both consumers use."""
    return (
        it * rate["input"]
        + ot * rate["output"]
        + cr * rate["cache_read"]
        + cc * rate["cache_creation"]
    ) / 1_000_000.0


def _base_fields(entry):
    """The 4 base rate fields of a models entry (drops tiers for comparison)."""
    return {field: entry[field] for field in _RATE_FIELDS}


def _fetch_dispatch(own_repo=None, litellm=None):
    """side_effect for the _fetch_remote_doc seam, keyed by source url.
    Per-source value semantics: an Exception instance is RAISED (fetch
    failure); a dict is returned as the fetched doc; None returns {} (a quiet
    plain miss in both formats). An unexpected url fails the test loudly."""
    docs = {_OWN_REPO_REMOTE_URL: own_repo, _LITELLM_REMOTE_URL: litellm}

    def fetch(url, timeout_seconds):
        if url not in docs:
            raise AssertionError("unexpected fetch url: %s" % url)
        value = docs[url]
        if isinstance(value, Exception):
            raise value
        return value if value is not None else {}

    return fetch


class _LoaderCase(unittest.TestCase):
    """Shared per-test hygiene: reset the loader's per-process memos (SoT cache
    + remote-failure memo) and pin the two env seams to a known state, restoring
    ambient values afterwards. Remote defaults to DISABLED here; remote-path
    tests flip PRICING_REMOTE_DISABLE to "0" explicitly."""

    def setUp(self):
        self._env_backup = {
            key: os.environ.get(key)
            for key in ("PRICING_SOT_PATH", "PRICING_REMOTE_DISABLE")
        }
        os.environ.pop("PRICING_SOT_PATH", None)
        os.environ["PRICING_REMOTE_DISABLE"] = "1"
        pricing_loader._reset_for_tests()

    def tearDown(self):
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        pricing_loader._reset_for_tests()

    def _fixture_doc(self, **overrides):
        """A minimal valid SoT doc (opus-4-5/opus-4-8 family pair + fable-5
        fallback), value-aligned with production rows for stable anchors."""
        doc = {
            "schema_version": 1,
            "last_verified": "2026-07-02",
            "stale_after_days": 90,
            "currency": "USD",
            "unit": "per_mtok",
            "fallback_model": "claude-fable-5",
            "remote_sources": [
                {
                    "name": "own-repo",
                    "url": _OWN_REPO_REMOTE_URL,
                    "format": "sot",
                    "timeout_seconds": 3,
                },
                {
                    "name": "litellm",
                    "url": _LITELLM_REMOTE_URL,
                    "format": "litellm",
                    "timeout_seconds": 3,
                },
            ],
            "overlay_cache_path": "data/pricing-remote-overlay.json",
            "overlay_ttl_hours": 24,
            "models": {
                "claude-opus-4-5": dict(_OPUS_RATE),
                "claude-opus-4-8": dict(_OPUS_RATE),
                "claude-fable-5": dict(_FABLE_RATE),
            },
        }
        doc.update(overrides)
        return doc

    def _tiered_sonnet_doc(self):
        """Fixture doc + a sonnet-5-shaped launch window (production-aligned
        values) — tier-behavior tests run on this fixture, not the production
        tier (see the ProductionSotTest pin policy)."""
        doc = self._fixture_doc()
        doc["models"]["claude-sonnet-5"] = dict(
            _SONNET_STANDARD, tiers=[dict(_SONNET5_INTRO, until="2026-08-31")]
        )
        return doc

    def _write_fixture(self, doc=None, raw_text=None):
        """Serialize a SoT doc (or raw corrupt text) into a throwaway dir,
        returning the fixture path. The dir is removed on test cleanup."""
        tmpdir = tempfile.mkdtemp(prefix="pricing-sot-test.")
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)
        path = os.path.join(tmpdir, "pricing.json")
        with open(path, "w", encoding="utf-8") as fh:
            if raw_text is not None:
                fh.write(raw_text)
            else:
                json.dump(doc if doc is not None else self._fixture_doc(), fh)
        return path

    @staticmethod
    def _overlay_path(sot_path):
        """Where the loader resolves the fixture's relative overlay_cache_path
        (relative to the SoT file's own directory — contract)."""
        return os.path.join(
            os.path.dirname(sot_path), "data", "pricing-remote-overlay.json"
        )


class BackfillImportPostureTest(unittest.TestCase):
    """P4 batch posture: the backfill import itself must gate off the remote
    step (deterministic network-free batch, operator opt-in via env)."""

    def test_import_disables_remote_by_default(self):
        self.assertEqual(_BACKFILL_IMPORT_REMOTE_DISABLE, "1")

    def test_backfill_shares_the_loader_module(self):
        # Single SoT, single resolver — both consumers see the same module
        # object (same memo state, same normalize source).
        self.assertIs(backfill.pricing_loader, pricing_loader)


class ProductionSotTest(_LoaderCase):
    """P1 INVARIANTS over the committed hooks/pricing.json (parses/validates,
    fallback dominance, allowlist config/code coherence) plus a TWO-ROW
    transcription anchor. Exact row-set / tier-shape pins live on fixture
    docs (TierBoundaryTest / FallbackChainTest / the .bats fixture SoT) so a
    routine operator edit — adding a models row, a rate change, a new intro
    tier — stays a single-file edit that never breaks this suite."""

    def _doc(self):
        return pricing_loader.load_pricing(str(_SOT_PATH))

    def test_schema_version_is_supported(self):
        self.assertEqual(self._doc()["schema_version"], 1)

    def test_anchor_rows_transcribed_at_exact_rates(self):
        # Transcription guard — deliberately NOT exact-set equality: two
        # anchor rows only, so other rows may be added/changed freely.
        models = self._doc()["models"]
        self.assertEqual(_base_fields(models["claude-opus-4-8"]), _OPUS_RATE)
        self.assertEqual(_base_fields(models["claude-fable-5"]), _FABLE_RATE)

    def test_fallback_model_dominates_every_row(self):
        doc = self._doc()
        fb_rate = doc["models"][doc["fallback_model"]]
        for model, entry in doc["models"].items():
            for field in _RATE_FIELDS:
                self.assertGreaterEqual(
                    fb_rate[field],
                    entry[field],
                    "fallback %s undercuts %s" % (field, model),
                )

    def test_last_verified_is_iso_and_window_positive(self):
        doc = self._doc()
        datetime.date.fromisoformat(doc["last_verified"])
        self.assertIsInstance(doc["stale_after_days"], int)
        self.assertGreater(doc["stale_after_days"], 0)

    def test_remote_sources_ordered_own_repo_then_litellm(self):
        # P1 AC: an ORDERED array — own-repo (#1, format=sot, the exact
        # predicted post-merge raw URL) before litellm (#2, format=litellm);
        # the shared overlay config sits TOP-LEVEL, not per-source.
        doc = self._doc()
        sources = doc["remote_sources"]
        self.assertEqual([source["name"] for source in sources], ["own-repo", "litellm"])
        self.assertEqual(sources[0]["format"], "sot")
        self.assertEqual(sources[0]["url"], _OWN_REPO_REMOTE_URL)
        self.assertEqual(sources[1]["format"], "litellm")
        self.assertEqual(sources[1]["url"], _LITELLM_REMOTE_URL)
        self.assertEqual(doc["overlay_cache_path"], "data/pricing-remote-overlay.json")
        self.assertEqual(doc["overlay_ttl_hours"], 24)

    def test_remote_urls_pass_the_per_source_allowlist_pin(self):
        # Config/code coherence: every committed remote_sources[].url must
        # satisfy the loader-side pin FOR ITS OWN source name, or that source
        # is dead on arrival. Doubles as the segment-EQUALITY regression guard
        # for the dot-segment rejection below — both committed paths end in a
        # dotted FILENAME (pricing.json / ...window.json) that must keep
        # passing.
        for source in self._doc()["remote_sources"]:
            with self.subTest(source=source["name"]):
                self.assertTrue(
                    pricing_loader._is_remote_url_allowed(source["url"], source["name"])
                )

    def test_dot_segment_escape_rejected_for_both_source_pins(self):
        # LLM04: urlsplit does NOT normalize '.'/'..' segments while the CDN
        # normalizes server-side — a '../' path passing the startswith prefix
        # pin would escape the pinned repo on the allowlisted host. Rejection
        # is by segment EQUALITY (dotted filenames keep passing, see the
        # clean-url test above). Pure unit calls: no network, no monkeypatch.
        suffixes = ("../../EvilOrg/evil/main/x.json", "./main/x.json")
        for name, base in _PIN_BASES.items():
            for suffix in suffixes:
                with self.subTest(source=name, suffix=suffix):
                    self.assertFalse(
                        pricing_loader._is_remote_url_allowed(base + suffix, name)
                    )

    def test_percent_encoded_dot_segment_escape_rejected_for_both_source_pins(self):
        # '%2e%2e' rides through urlsplit UNDECODED (a literal-segment check
        # alone would miss it) and normalizes server-side; any '%' in the raw
        # path is refused — neither pinned repo's raw path needs
        # percent-escapes. Upper/lowercase hex both covered (decode is
        # case-insensitive). Pure unit calls: no network, no monkeypatch.
        for encoded in ("%2e%2e", "%2E%2E"):
            for name, base in _PIN_BASES.items():
                url = "{0}{1}/{1}/EvilOrg/evil/main/x.json".format(base, encoded)
                with self.subTest(source=name, encoded=encoded):
                    self.assertFalse(
                        pricing_loader._is_remote_url_allowed(url, name)
                    )

    def test_load_is_memoized_per_path(self):
        self.assertIs(
            pricing_loader.load_pricing(str(_SOT_PATH)),
            pricing_loader.load_pricing(str(_SOT_PATH)),
        )


class SotValidationTest(_LoaderCase):
    """Loud-fail on malformed SoT input — never a silent partial load."""

    def _assert_rejects(self, fragment, doc=None, raw_text=None):
        path = self._write_fixture(doc=doc, raw_text=raw_text)
        with self.assertRaises(pricing_loader.PricingSotError) as ctx:
            pricing_loader.load_pricing(path)
        self.assertIn(fragment, str(ctx.exception))

    def test_missing_file_raises(self):
        path = self._write_fixture()
        with self.assertRaises(pricing_loader.PricingSotError) as ctx:
            pricing_loader.load_pricing(os.path.join(os.path.dirname(path), "absent.json"))
        self.assertIn("unreadable", str(ctx.exception))

    def test_invalid_json_raises(self):
        self._assert_rejects("not valid JSON", raw_text="{not json!!")

    def test_unsupported_schema_version_raises(self):
        self._assert_rejects("schema_version", doc=self._fixture_doc(schema_version=2))

    def test_wrong_currency_raises(self):
        self._assert_rejects("currency", doc=self._fixture_doc(currency="KRW"))

    def test_wrong_unit_raises(self):
        self._assert_rejects("unit", doc=self._fixture_doc(unit="per_tok"))

    def test_non_normalized_model_key_raises(self):
        # A dated key would be unreachable (the resolver looks up normalized
        # keys) — reject at load so the dead row is caught immediately.
        doc = self._fixture_doc()
        doc["models"]["claude-haiku-4-5-20251001"] = dict(_HAIKU_RATE)
        self._assert_rejects("not in normalized form", doc=doc)

    def test_missing_rate_field_raises(self):
        doc = self._fixture_doc()
        del doc["models"]["claude-opus-4-8"]["cache_read"]
        self._assert_rejects("must be numeric", doc=doc)

    def test_non_positive_rate_raises(self):
        doc = self._fixture_doc()
        doc["models"]["claude-opus-4-8"]["input"] = 0
        self._assert_rejects("must be positive", doc=doc)

    def test_malformed_tier_until_raises(self):
        doc = self._fixture_doc()
        doc["models"]["claude-opus-4-8"]["tiers"] = [
            dict(_OPUS_RATE, until="not-a-date")
        ]
        self._assert_rejects("not an ISO date", doc=doc)

    def test_fallback_model_absent_from_models_raises(self):
        self._assert_rejects(
            "fallback_model", doc=self._fixture_doc(fallback_model="claude-ghost-1")
        )

    def test_empty_remote_sources_raises(self):
        self._assert_rejects(
            "remote_sources", doc=self._fixture_doc(remote_sources=[])
        )

    def test_unknown_remote_source_format_raises(self):
        doc = self._fixture_doc()
        doc["remote_sources"][0]["format"] = "csv"
        self._assert_rejects("format", doc=doc)

    def test_absolute_overlay_cache_path_raises(self):
        # LLM04 write-redirection pin: the overlay is the loader's only write
        # target — a tampered ABSOLUTE path must never redirect the atomic
        # JSON writes off the SoT directory. Loud-fail at load, no honoring.
        self._assert_rejects(
            "overlay_cache_path",
            doc=self._fixture_doc(overlay_cache_path="/tmp/evil-overlay.json"),
        )

    def test_parent_escaping_overlay_cache_path_raises(self):
        # Same pin, the relative escape shape: '..' segments walk out of the
        # SoT directory just as effectively as an absolute path.
        self._assert_rejects(
            "overlay_cache_path",
            doc=self._fixture_doc(overlay_cache_path="../outside/overlay.json"),
        )

    def test_fallback_dominance_violation_warns_but_loads(self):
        # Non-fatal by design (fail-loud-but-degrade): pricing stays
        # operational, the conservative invariant violation is surfaced.
        doc = self._fixture_doc()
        doc["models"]["claude-pricey-9"] = {
            "input": 999.0, "output": 999.0, "cache_read": 999.0, "cache_creation": 999.0,
        }
        path = self._write_fixture(doc)
        err = io.StringIO()
        with redirect_stderr(err):
            loaded = pricing_loader.load_pricing(path)
        self.assertIn("does not dominate", err.getvalue())
        self.assertIn("claude-pricey-9", loaded["models"])

    def test_memoized_load_survives_on_disk_corruption(self):
        path = self._write_fixture()
        first = pricing_loader.load_pricing(path)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{corrupted after first load")
        self.assertIs(pricing_loader.load_pricing(path), first)


class NormalizeModelKeyTest(unittest.TestCase):
    """Suffix-stripping normalizer (single source now — no mirror to lockstep)."""

    def test_strips_1m_bracket_suffix(self):
        self.assertEqual(
            pricing_loader.normalize_model_key("claude-opus-4-8[1m]"), "claude-opus-4-8"
        )

    def test_strips_dated_suffix(self):
        self.assertEqual(
            pricing_loader.normalize_model_key("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5",
        )

    def test_strips_bracket_then_date(self):
        self.assertEqual(
            pricing_loader.normalize_model_key("claude-haiku-4-5-20251001[1m]"),
            "claude-haiku-4-5",
        )

    def test_plain_key_unchanged(self):
        self.assertEqual(
            pricing_loader.normalize_model_key("claude-opus-4-8"), "claude-opus-4-8"
        )

    def test_non_8_digit_numeric_suffix_unchanged(self):
        self.assertEqual(
            pricing_loader.normalize_model_key("claude-x-1234567"), "claude-x-1234567"
        )
        self.assertEqual(
            pricing_loader.normalize_model_key("claude-x-123456789"),
            "claude-x-123456789",
        )

    def test_falsy_passthrough(self):
        self.assertEqual(pricing_loader.normalize_model_key(""), "")
        self.assertIsNone(pricing_loader.normalize_model_key(None))


class CostUsdTest(unittest.TestCase):
    """The 4-term per-MTok arithmetic has ONE home (pricing_loader.cost_usd);
    both consumers delegate to it — this pins the formula itself."""

    def test_matches_the_reference_arithmetic(self):
        self.assertAlmostEqual(
            pricing_loader.cost_usd(_OPUS_RATE, 1000, 500, 0, 0), 0.0175, places=10
        )
        self.assertAlmostEqual(
            pricing_loader.cost_usd(_FABLE_RATE, 1000, 500, 2000, 100),
            _cost(_FABLE_RATE, 1000, 500, 2000, 100),
            places=12,
        )


class RateForSotTest(_LoaderCase):
    """Step-1 resolution over the production SoT: label "sot", zero network.

    Remote is ENABLED here and the fetch seam trap-patched — any network
    attempt on a SoT hit fails the test loudly (happy-path zero-network AC)."""

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"
        patcher = mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=AssertionError("network I/O attempted on a SoT hit"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _rate_for(self, model_key, effective_date=None):
        return pricing_loader.rate_for(
            model_key, effective_date=effective_date, sot_path=str(_SOT_PATH)
        )

    def test_known_model_resolves_sot_with_cost_anchor(self):
        record = self._rate_for("claude-opus-4-8")
        self.assertEqual(record["resolution"], "sot")
        self.assertEqual(record["matched_model"], "claude-opus-4-8")
        self.assertAlmostEqual(_cost(record["rate"]), 0.0175, places=10)

    def test_fable_5_is_first_class_at_exact_rates(self):
        record = self._rate_for("claude-fable-5")
        self.assertEqual(record["resolution"], "sot")
        self.assertEqual(record["rate"], _FABLE_RATE)
        self.assertAlmostEqual(_cost(record["rate"]), 0.035, places=10)

    def test_bracket_variant_resolves_to_base_row(self):
        record = self._rate_for("claude-fable-5[1m]")
        self.assertEqual(record["resolution"], "sot")
        self.assertEqual(record["normalized_key"], "claude-fable-5")
        self.assertAlmostEqual(_cost(record["rate"]), 0.035, places=10)

    def test_dated_haiku_resolves_to_haiku_rates(self):
        record = self._rate_for("claude-haiku-4-5-20251001")
        self.assertEqual(record["resolution"], "sot")
        self.assertEqual(record["matched_model"], "claude-haiku-4-5")
        # 1/10 of the fable-5 fallback — proves it is NOT fallback-priced.
        self.assertAlmostEqual(_cost(record["rate"]), 0.0035, places=10)

    def test_is_known_parity(self):
        # The reprice guard keys on the same membership (SoT after normalize).
        for key in ("claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-fable-5[1m]"):
            self.assertTrue(pricing_loader.is_known(key, sot_path=str(_SOT_PATH)), key)
        for key in ("claude-foobar-9-9", "", None):
            self.assertFalse(pricing_loader.is_known(key, sot_path=str(_SOT_PATH)), key)


class TierBoundaryTest(_LoaderCase):
    """Windowed-tier selection by effective_date (loader-side). Runs on a
    FIXTURE SoT carrying the sonnet-5-shaped launch window — the production
    tier's eventual expiry/removal must not break loader-behavior tests."""

    def setUp(self):
        super().setUp()
        self._path = self._write_fixture(self._tiered_sonnet_doc())

    def _sonnet(self, effective_date):
        return pricing_loader.rate_for(
            "claude-sonnet-5", effective_date=effective_date, sot_path=self._path
        )

    def test_intro_rate_on_last_window_day_inclusive(self):
        record = self._sonnet("2026-08-31")
        self.assertEqual(record["rate"], _SONNET5_INTRO)
        self.assertAlmostEqual(_cost(record["rate"]), 0.007, places=10)

    def test_standard_rate_on_first_post_window_day(self):
        record = self._sonnet("2026-09-01")
        self.assertEqual(record["rate"], _SONNET_STANDARD)
        self.assertAlmostEqual(_cost(record["rate"]), 0.0105, places=10)

    def test_date_object_accepted(self):
        record = self._sonnet(datetime.date(2026, 8, 31))
        self.assertEqual(record["rate"], _SONNET5_INTRO)

    def test_base_rate_sentinel_selects_standard(self):
        # First-class base-row selection (backfill dateless rows) — never the
        # live clock, never an intro discount.
        record = self._sonnet(pricing_loader.BASE_RATE)
        self.assertEqual(record["rate"], _SONNET_STANDARD)

    def test_malformed_date_selects_standard(self):
        # Documented DEFENSIVE rule: a malformed ISO string degrades to the
        # base (standard) row — never a silent intro discount. Deliberate
        # base-row selection is BASE_RATE (test above), not a bogus string.
        for bogus in ("not-a-date", "31/08/2026", "2026-13-99"):
            record = self._sonnet(bogus)
            self.assertEqual(record["rate"], _SONNET_STANDARD, bogus)


class FallbackChainTest(_LoaderCase):
    """Steps 4-5 with remote disabled: family-latest, then conservative
    fallback. Fixture SoT keeps the anchors production-aligned."""

    def test_unknown_family_resolves_conservative_fallback(self):
        path = self._write_fixture()
        record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(record["resolution"], "fallback")
        self.assertEqual(record["matched_model"], "claude-fable-5")
        self.assertEqual(record["rate"], _FABLE_RATE)
        self.assertAlmostEqual(_cost(record["rate"]), 0.035, places=10)

    def test_family_latest_picks_highest_same_family_version(self):
        # claude-opus-4-9 is absent; opus-4-5 and opus-4-8 exist — the highest
        # version tuple (4,8) must win.
        path = self._write_fixture()
        record = pricing_loader.rate_for("claude-opus-4-9", sot_path=path)
        self.assertEqual(record["resolution"], "family_latest")
        self.assertEqual(record["matched_model"], "claude-opus-4-8")
        self.assertEqual(record["normalized_key"], "claude-opus-4-9")
        self.assertAlmostEqual(_cost(record["rate"]), 0.0175, places=10)

    def test_no_family_member_falls_to_fallback(self):
        path = self._write_fixture()
        record = pricing_loader.rate_for("claude-zephyr-1", sot_path=path)
        self.assertEqual(record["resolution"], "fallback")
        self.assertEqual(record["matched_model"], "claude-fable-5")

    def test_kill_switch_skips_remote_entirely(self):
        # PRICING_REMOTE_DISABLE=1 (base setUp) → the fetch seam must never be
        # touched even on a SoT+overlay miss.
        path = self._write_fixture()
        with mock.patch.object(pricing_loader, "_fetch_remote_doc") as fetch:
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 0)
        self.assertEqual(record["resolution"], "fallback")


class RemoteResolutionTest(_LoaderCase):
    """Step 3 with a MOCKED remote doc (litellm shape): per-token -> per-MTok
    conversion, overlay persist, overlay short-circuit on the next lookup."""

    # 4e-06/tok -> 4.0/MTok etc. — the x1e6 conversion contract.
    _CONVERTED = {"input": 4.0, "output": 20.0, "cache_read": 0.4, "cache_creation": 5.0}

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"

    @staticmethod
    def _remote_doc(key="claude-foobar-9-9", **overrides):
        entry = {
            "input_cost_per_token": 4e-06,
            "output_cost_per_token": 2e-05,
            "cache_read_input_token_cost": 4e-07,
            "cache_creation_input_token_cost": 5e-06,
        }
        entry.update(overrides)
        return {key: entry}

    def test_remote_hit_converts_per_token_and_persists_overlay(self):
        path = self._write_fixture()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(litellm=self._remote_doc()),
        ) as fetch:
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["rate"], self._CONVERTED)
        self.assertEqual(record["source"], "litellm")
        # Declared order: own-repo (#1, a quiet miss here) then litellm (#2).
        self.assertEqual(
            fetch.call_args_list,
            [mock.call(_OWN_REPO_REMOTE_URL, 3), mock.call(_LITELLM_REMOTE_URL, 3)],
        )
        overlay_path = self._overlay_path(path)
        self.assertTrue(os.path.isfile(overlay_path))
        with open(overlay_path, "r", encoding="utf-8") as fh:
            overlay = json.load(fh)
        entry = overlay["claude-foobar-9-9"]
        self.assertEqual(_base_fields(entry), self._CONVERTED)
        # The winning source name is recorded alongside the rate (P2 AC).
        self.assertEqual(entry["source"], "litellm")
        # fetched_at must be a parseable timestamp (drives the TTL check).
        datetime.datetime.fromisoformat(entry["fetched_at"])

    def test_overlay_serves_second_lookup_without_refetch(self):
        path = self._write_fixture()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(litellm=self._remote_doc()),
        ) as fetch:
            first = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
            second = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(first["resolution"], "remote")
        self.assertEqual(second["resolution"], "overlay")
        self.assertEqual(second["rate"], self._CONVERTED)
        # The overlay hit propagates the recorded winning source name.
        self.assertEqual(second["source"], "litellm")
        self.assertEqual(fetch.call_count, 2, "each source once — no refetch")

    def test_plain_remote_miss_is_quiet_and_does_not_arm_the_memo(self):
        # The model being absent from BOTH remote docs is a MISS, not a
        # failure: no loud log, no memo — a later lookup may fetch again.
        # own-repo returns a VALID not-newer full SoT (F3 refresh SKIPPED
        # quietly) that simply lacks the model; litellm returns {}.
        path = self._write_fixture()
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(own_repo=self._fixture_doc()),
        ) as fetch, redirect_stderr(err):
            first = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
            second = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(first["resolution"], "fallback")
        self.assertEqual(second["resolution"], "fallback")
        self.assertEqual(fetch.call_count, 4, "2 sources x 2 lookups, no memo")
        self.assertEqual(err.getvalue(), "")


class FailedFetchMemoTest(_LoaderCase):
    """Per-SOURCE per-process negative memo: the first genuine fetch failure
    of a source logs loudly once, then THAT source is skipped for the
    remainder of the process (the other sources stay consulted)."""

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"

    def test_first_failure_loud_then_silent_skip(self):
        path = self._write_fixture()
        with mock.patch.object(
            pricing_loader, "_fetch_remote_doc", side_effect=OSError("timed out")
        ) as fetch:
            err_first = io.StringIO()
            with redirect_stderr(err_first):
                first = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
            err_second = io.StringIO()
            with redirect_stderr(err_second):
                second = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(first["resolution"], "fallback")
        self.assertEqual(second["resolution"], "fallback")
        self.assertEqual(
            fetch.call_count, 2, "one attempt per source; memos suppress the rest"
        )
        # Both sources failed and logged the distinct per-source advisory once.
        self.assertIn("remote own-repo unavailable", err_first.getvalue())
        self.assertIn("remote litellm unavailable", err_first.getvalue())
        self.assertEqual(err_second.getvalue(), "")

    def test_own_repo_memo_does_not_poison_litellm(self):
        # Plan contract: memoizing own-repo's failure must not poison litellm
        # — a LATER lookup skips own-repo without a fetch attempt while still
        # consulting (and here winning via) litellm.
        path = self._write_fixture()
        err = io.StringIO()
        with redirect_stderr(err):
            with mock.patch.object(
                pricing_loader,
                "_fetch_remote_doc",
                side_effect=_fetch_dispatch(own_repo=OSError("connection refused")),
            ) as fetch_first:
                first = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
            with mock.patch.object(
                pricing_loader,
                "_fetch_remote_doc",
                side_effect=_fetch_dispatch(
                    litellm=RemoteResolutionTest._remote_doc(key="claude-quux-2-2")
                ),
            ) as fetch_second:
                second = pricing_loader.rate_for("claude-quux-2-2", sot_path=path)
        self.assertEqual(first["resolution"], "fallback")
        self.assertEqual(fetch_first.call_count, 2)  # own-repo fail + litellm miss
        # Second lookup: own-repo memoized OUT, litellm still fetched and wins.
        self.assertEqual(
            fetch_second.call_args_list, [mock.call(_LITELLM_REMOTE_URL, 3)]
        )
        self.assertEqual(second["resolution"], "remote")
        self.assertEqual(second["source"], "litellm")


class MultiSourceRemoteTest(_LoaderCase):
    """P5 multi-source additions: declared-order iteration (own-repo #1 ->
    litellm #2), first-sane-hit short-circuit, own-repo-404 fallthrough,
    format=sot passthrough (contrasted against litellm conversion), and
    per-source sanity rejection."""

    # Per-MTok values as they appear in a format=sot payload — distinct from
    # every production row so a wrongly applied x1e6 conversion cannot hide.
    _SOT_PAYLOAD_RATE = {
        "input": 7.0, "output": 21.0, "cache_read": 0.7, "cache_creation": 8.75,
    }

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"

    def _own_repo_doc(self, key="claude-foobar-9-9", rate=None):
        """A format=sot remote payload: the own-repo copy IS a full
        pricing.json (the F3 refresh gate validates it as one), so it must be
        a VALID SoT doc; rates are already per-MTok. last_verified defaults
        to the local fixture's own stamp (EQUAL -> refresh SKIPPED), keeping
        these tests on the per-model path they exercise."""
        doc = self._fixture_doc()
        doc["models"][key] = dict(rate or self._SOT_PAYLOAD_RATE)
        return doc

    def test_sane_own_repo_hit_short_circuits_litellm(self):
        # Ordering contract: a sane own-repo (#1) hit means litellm (#2) is
        # NEVER fetched — the dispatch raises if the litellm url is touched.
        path = self._write_fixture()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=self._own_repo_doc(),
                litellm=AssertionError("litellm must not be fetched on an own-repo hit"),
            ),
        ) as fetch:
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_args_list, [mock.call(_OWN_REPO_REMOTE_URL, 3)])
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "own-repo")
        self.assertEqual(record["rate"], self._SOT_PAYLOAD_RATE)
        # The overlay records own-repo as the winning source.
        with open(self._overlay_path(path), "r", encoding="utf-8") as fh:
            overlay = json.load(fh)
        self.assertEqual(overlay["claude-foobar-9-9"]["source"], "own-repo")

    def test_sot_format_is_passthrough_litellm_is_converted(self):
        # Contrast contract: a format=sot payload is consumed VERBATIM (7.0
        # per-MTok stays 7.0 — no x1e6), while the same target rate arrives in
        # a litellm payload as 7e-06 per-token and IS converted to 7.0.
        path_sot = self._write_fixture()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(own_repo=self._own_repo_doc()),
        ):
            sot_record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path_sot)
        self.assertEqual(sot_record["source"], "own-repo")
        self.assertEqual(sot_record["rate"]["input"], 7.0)

        pricing_loader._reset_for_tests()
        path_litellm = self._write_fixture()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                litellm=RemoteResolutionTest._remote_doc(input_cost_per_token=7e-06)
            ),
        ):
            litellm_record = pricing_loader.rate_for(
                "claude-foobar-9-9", sot_path=path_litellm
            )
        self.assertEqual(litellm_record["source"], "litellm")
        self.assertEqual(litellm_record["rate"]["input"], 7.0)

    def test_own_repo_404_falls_through_to_litellm(self):
        # The own-repo URL is a PREDICTED post-merge address — its 404 is an
        # expected fail-open (distinct loud advisory), never an error path.
        path = self._write_fixture()
        not_found = urllib.error.HTTPError(
            _OWN_REPO_REMOTE_URL, 404, "Not Found", None, None
        )
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=not_found, litellm=RemoteResolutionTest._remote_doc()
            ),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "litellm")
        self.assertEqual(record["rate"], RemoteResolutionTest._CONVERTED)
        self.assertIn("remote own-repo unavailable", err.getvalue())
        with open(self._overlay_path(path), "r", encoding="utf-8") as fh:
            overlay = json.load(fh)
        self.assertEqual(overlay["claude-foobar-9-9"]["source"], "litellm")

    def test_own_repo_sanity_reject_falls_through_to_litellm(self):
        # Per-source sanity: an insane own-repo row is rejected loudly (and
        # memoized for own-repo ONLY) — litellm is then consulted and wins.
        # The row must be positive+numeric (so the full-doc F3 validation
        # passes; a negative rate would trip the whole-doc reject instead)
        # but over the _RATE_MAX_PER_MTOK ceiling — the per-model gate.
        path = self._write_fixture()
        insane = self._own_repo_doc(
            rate={"input": 5000.0, "output": 21.0, "cache_read": 0.7, "cache_creation": 8.75}
        )
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=insane, litellm=RemoteResolutionTest._remote_doc()
            ),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "litellm")
        self.assertIn("from own-repo failed sanity", err.getvalue())
        # The litellm rate (not the insane own-repo one) is what persisted.
        with open(self._overlay_path(path), "r", encoding="utf-8") as fh:
            overlay = json.load(fh)
        self.assertEqual(
            _base_fields(overlay["claude-foobar-9-9"]), RemoteResolutionTest._CONVERTED
        )


class SotSelfRefreshTest(_LoaderCase):
    """F3 own-repo whole-file self-refresh (invariant 7). Every case runs
    against a SANDBOXED tmpdir fixture SoT (never the production
    pricing.json) with a MOCKED fetch seam — zero live network."""

    # The row the fetched repo copy carries for the missing model —
    # per-MTok (format=sot), dominated by the fable-5 fallback (no warning).
    _NEW_ROW = {"input": 7.0, "output": 21.0, "cache_read": 0.7, "cache_creation": 8.75}

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"

    @staticmethod
    def _today():
        return datetime.date.today()

    def _local_path(self, age_days=30):
        """A local fixture SoT whose last_verified is age_days behind today
        (dynamic — the suite stays valid regardless of when it runs)."""
        stamp = (self._today() - datetime.timedelta(days=age_days)).isoformat()
        return self._write_fixture(self._fixture_doc(last_verified=stamp))

    def _fetched_doc(self, last_verified=None, row=True, **overrides):
        """A full VALID repo copy; last_verified defaults to today (strictly
        newer than any _local_path fixture, within the today+1d bound)."""
        doc = self._fixture_doc(
            last_verified=last_verified or self._today().isoformat(), **overrides
        )
        if row:
            doc["models"]["claude-foobar-9-9"] = dict(self._NEW_ROW)
        return doc

    @staticmethod
    def _read_bytes(path):
        with open(path, "rb") as fh:
            return fh.read()

    def _assert_no_orphan_tmp(self, path):
        leftovers = [
            name for name in os.listdir(os.path.dirname(path)) if ".tmp." in name
        ]
        self.assertEqual(leftovers, [], "orphaned sibling temp file left behind")

    def test_newer_valid_copy_replaces_file_and_re_lookup_hits(self):
        path = self._local_path(age_days=30)
        fetched = self._fetched_doc()
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=fetched,
                litellm=AssertionError("litellm must not be fetched on a refresh hit"),
            ),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_args_list, [mock.call(_OWN_REPO_REMOTE_URL, 3)])
        # Recorded distinctly: normal sot-tier logic under the remote label.
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "own-repo")
        self.assertTrue(record["refreshed"])
        self.assertEqual(record["rate"], self._NEW_ROW)
        # Whole-file replace: the on-disk doc IS the fetched copy (no merge).
        with open(path, "r", encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), fetched)
        self._assert_no_orphan_tmp(path)
        # Loud advisory names BOTH last_verified values.
        advisory = err.getvalue()
        self.assertIn("refreshed", advisory)
        self.assertIn(
            (self._today() - datetime.timedelta(days=30)).isoformat(), advisory
        )
        self.assertIn(self._today().isoformat(), advisory)
        # Refresh hit is served from the SoT — no overlay entry is written.
        self.assertFalse(os.path.exists(self._overlay_path(path)))
        # Memo invalidation + reload took: the next lookup is a plain SoT hit
        # with zero network I/O.
        with mock.patch.object(pricing_loader, "_fetch_remote_doc") as refetch:
            second = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(refetch.call_count, 0)
        self.assertEqual(second["resolution"], "sot")
        self.assertFalse(second["refreshed"])

    def test_refresh_re_lookup_honors_effective_date(self):
        # Windowed-tier contract: the post-refresh re-lookup tier-selects on
        # the CALLER's effective_date (backfill passes historical
        # event_dates) — today would select the standard row here, so an
        # intro-rate result proves eff was threaded through.
        path = self._local_path(age_days=100)
        until = (self._today() - datetime.timedelta(days=60)).isoformat()
        intro = {"input": 3.5, "output": 10.5, "cache_read": 0.35, "cache_creation": 4.375}
        fetched = self._fetched_doc()
        fetched["models"]["claude-foobar-9-9"]["tiers"] = [dict(intro, until=until)]
        eff = (self._today() - datetime.timedelta(days=90)).isoformat()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(own_repo=fetched),
        ):
            record = pricing_loader.rate_for(
                "claude-foobar-9-9", effective_date=eff, sot_path=path
            )
        self.assertTrue(record["refreshed"])
        self.assertEqual(record["rate"], intro, "re-lookup must honor eff, not today")

    def test_not_newer_copy_no_write_per_model_overlay_as_today(self):
        # older AND equal fetched stamps: NO file write; the own-repo doc
        # still serves the missing model per-model + overlay persist exactly
        # as before the F3 feature.
        for age_days in (0, 10):
            with self.subTest(fetched_age_days=age_days):
                pricing_loader._reset_for_tests()
                path = self._local_path(age_days=0)  # local == today
                before = self._read_bytes(path)
                stamp = (self._today() - datetime.timedelta(days=age_days)).isoformat()
                fetched = self._fetched_doc(last_verified=stamp)
                with mock.patch.object(
                    pricing_loader,
                    "_fetch_remote_doc",
                    side_effect=_fetch_dispatch(
                        own_repo=fetched,
                        litellm=AssertionError("per-model own-repo hit must short-circuit"),
                    ),
                ):
                    record = pricing_loader.rate_for(
                        "claude-foobar-9-9", sot_path=path
                    )
                self.assertEqual(self._read_bytes(path), before, "file must be untouched")
                self.assertEqual(record["resolution"], "remote")
                self.assertEqual(record["source"], "own-repo")
                self.assertFalse(record["refreshed"])
                self.assertEqual(record["rate"], self._NEW_ROW)
                with open(self._overlay_path(path), "r", encoding="utf-8") as fh:
                    overlay = json.load(fh)
                self.assertEqual(overlay["claude-foobar-9-9"]["source"], "own-repo")

    def test_invalid_fetched_doc_rejected_no_write_chain_continues(self):
        # A doc failing full _validate_sot is untrusted ENTIRELY: loud
        # reject, no write, no per-model use even though it carries a sane
        # row — the chain continues to litellm.
        path = self._local_path()
        before = self._read_bytes(path)
        partial = {"models": {"claude-foobar-9-9": dict(self._NEW_ROW)}}
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=partial, litellm=RemoteResolutionTest._remote_doc()
            ),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(self._read_bytes(path), before)
        self.assertIn("refresh rejected", err.getvalue())
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "litellm", "own-repo row must NOT be used")
        self.assertEqual(record["rate"], RemoteResolutionTest._CONVERTED)
        self.assertFalse(record["refreshed"])
        # Same memo posture as a per-model sanity reject: own-repo is out for
        # the process; litellm alone is consulted on the next lookup.
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                litellm=RemoteResolutionTest._remote_doc(key="claude-quux-2-2")
            ),
        ) as refetch:
            pricing_loader.rate_for("claude-quux-2-2", sot_path=path)
        self.assertEqual(refetch.call_args_list, [mock.call(_LITELLM_REMOTE_URL, 3)])

    def test_poisoned_full_doc_rejected_no_write_chain_continues(self):
        # LLM04 replace gate: a newer doc that PASSES _validate_sot
        # (numeric+positive) but carries a row at/over the
        # _RATE_MAX_PER_MTOK ceiling is rejected WHOLE by the rate-sanity
        # sweep — even though the requested model's own row is sane.
        path = self._local_path(age_days=30)
        before = self._read_bytes(path)
        poisoned = self._fetched_doc()
        poisoned["models"]["claude-evil-1"] = {
            "input": 5000.0, "output": 5000.0, "cache_read": 5000.0, "cache_creation": 5000.0,
        }
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=poisoned, litellm=RemoteResolutionTest._remote_doc()
            ),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(self._read_bytes(path), before, "poisoned doc must never be written")
        self.assertIn("fails rate sanity", err.getvalue())
        self.assertIn("claude-evil-1", err.getvalue())
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "litellm")
        self.assertFalse(record["refreshed"])

    def test_future_dated_last_verified_refused_no_write(self):
        # LLM04 lock-in defense: a far-future stamp accepted once would
        # permanently defeat the strictly-newer gate — refuse the write
        # loudly; the sane per-model row still serves as before.
        path = self._local_path(age_days=0)
        before = self._read_bytes(path)
        fetched = self._fetched_doc(last_verified="2099-01-01")
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=fetched,
                litellm=AssertionError("per-model own-repo hit must short-circuit"),
            ),
        ), redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(self._read_bytes(path), before)
        self.assertIn("beyond today+1d", err.getvalue())
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "own-repo")
        self.assertFalse(record["refreshed"])
        self.assertTrue(os.path.exists(self._overlay_path(path)))

    def test_replace_write_failure_degrades_to_per_model(self):
        # Same posture as _persist_overlay_rate: loud stderr, memo NOT
        # invalidated, per-model use + overlay persist from the
        # already-fetched doc; the orphaned sibling temp is cleaned up.
        path = self._local_path(age_days=30)
        before = self._read_bytes(path)
        fetched = self._fetched_doc()
        real_replace = os.replace

        def flaky_replace(src, dst):
            if dst == path:
                raise OSError(28, "No space left on device")
            return real_replace(src, dst)

        err = io.StringIO()
        with mock.patch.object(
            pricing_loader.os, "replace", side_effect=flaky_replace
        ), mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=fetched,
                litellm=AssertionError("per-model own-repo hit must short-circuit"),
            ),
        ), redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertIn("refresh write failed", err.getvalue())
        self.assertEqual(self._read_bytes(path), before)
        self._assert_no_orphan_tmp(path)
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "own-repo")
        self.assertFalse(record["refreshed"])
        self.assertEqual(record["rate"], self._NEW_ROW)
        # Memo NOT invalidated: the pre-refresh doc is still cached.
        self.assertIn(os.path.abspath(path), pricing_loader._SOT_CACHE)
        # Overlay persist (via the un-mocked path) succeeded — the degrade.
        with open(self._overlay_path(path), "r", encoding="utf-8") as fh:
            self.assertIn("claude-foobar-9-9", json.load(fh))

    def test_refreshed_but_still_missing_continues_to_litellm_no_memo(self):
        # Newer valid doc replaced but the model is absent from the refreshed
        # SoT (== fetched doc by definition): plain miss — chain continues to
        # litellm, NO failure-memo arming, no second own-repo fetch.
        path = self._local_path(age_days=30)
        fetched = self._fetched_doc(row=False)
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=fetched, litellm=RemoteResolutionTest._remote_doc()
            ),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(
            fetch.call_args_list,
            [mock.call(_OWN_REPO_REMOTE_URL, 3), mock.call(_LITELLM_REMOTE_URL, 3)],
        )
        self.assertIn("refreshed", err.getvalue())
        with open(path, "r", encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), fetched, "replace still happened")
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "litellm")
        self.assertTrue(record["refreshed"], "record flags the refresh in the trail")
        # No memo: a later lookup consults own-repo AGAIN (now equal-stamped
        # -> refresh skipped, plain per-model miss -> litellm).
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(
                own_repo=fetched,
                litellm=RemoteResolutionTest._remote_doc(key="claude-quux-2-2"),
            ),
        ) as refetch:
            second = pricing_loader.rate_for("claude-quux-2-2", sot_path=path)
        self.assertEqual(
            refetch.call_args_list,
            [mock.call(_OWN_REPO_REMOTE_URL, 3), mock.call(_LITELLM_REMOTE_URL, 3)],
        )
        self.assertEqual(second["source"], "litellm")
        self.assertFalse(second["refreshed"])

    def test_post_refresh_chain_rebinds_family_latest(self):
        # Step 4 must consult the REFRESHED doc: claude-opus-4-10 exists only
        # in the fetched copy, and it must win family-latest post-refresh.
        path = self._local_path(age_days=30)
        fetched = self._fetched_doc(row=False)
        fetched["models"]["claude-opus-4-10"] = dict(_OPUS_RATE)
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(own_repo=fetched),
        ):
            record = pricing_loader.rate_for("claude-opus-4-11", sot_path=path)
        self.assertEqual(record["resolution"], "family_latest")
        self.assertEqual(record["matched_model"], "claude-opus-4-10")
        self.assertTrue(record["refreshed"])

    def test_post_refresh_chain_rebinds_fallback(self):
        # Step 5 must consult the REFRESHED doc's fallback_model — the
        # fetched copy re-points it to a new dominating row.
        path = self._local_path(age_days=30)
        fetched = self._fetched_doc(row=False, fallback_model="claude-atlas-9")
        fetched["models"]["claude-atlas-9"] = {
            "input": 12.0, "output": 60.0, "cache_read": 1.2, "cache_creation": 15.0,
        }
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(own_repo=fetched),
        ):
            record = pricing_loader.rate_for("claude-zephyr-1", sot_path=path)
        self.assertEqual(record["resolution"], "fallback")
        self.assertEqual(record["matched_model"], "claude-atlas-9")
        self.assertTrue(record["refreshed"])

    def test_kill_switch_disables_refresh_and_all_remote_io(self):
        os.environ["PRICING_REMOTE_DISABLE"] = "1"
        path = self._local_path(age_days=30)
        before = self._read_bytes(path)
        with mock.patch.object(pricing_loader, "_fetch_remote_doc") as fetch:
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 0)
        self.assertEqual(self._read_bytes(path), before)
        self.assertEqual(record["resolution"], "fallback")
        self.assertFalse(record["refreshed"])

    def test_sot_hit_zero_fetch_zero_write(self):
        # Happy path stays zero-network and never rewrites anything, even
        # with remote enabled and a stale local stamp.
        path = self._local_path(age_days=300)
        before = self._read_bytes(path)
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=AssertionError("network I/O attempted on a SoT hit"),
        ):
            record = pricing_loader.rate_for("claude-opus-4-8", sot_path=path)
        self.assertEqual(record["resolution"], "sot")
        self.assertFalse(record["refreshed"])
        self.assertEqual(self._read_bytes(path), before)
        self.assertFalse(os.path.exists(self._overlay_path(path)))


class AllowlistPinTest(_LoaderCase):
    """LLM04 enforcement point: a non-allowlisted remote_sources[].url is
    refused BEFORE any network I/O — loud reject, THAT source skipped,
    iteration continues to the next source; with none left the chain falls
    through to family-latest. The pin is PER SOURCE (scheme + host + the
    source's OWN path prefix, keyed by its name)."""

    _BAD_URLS = (
        "http://raw.githubusercontent.com/BerriAI/litellm/main/x.json",  # scheme
        "https://evil.example.com/BerriAI/litellm/main/x.json",  # host
        "https://raw.githubusercontent.com/EvilOrg/litellm/main/x.json",  # path
        "https://raw.githubusercontent.com:8443/BerriAI/litellm/main/x.json",  # port
        # dot-segment escape: prefix-passing on own-repo, CDN-normalized off-repo
        _PIN_BASES["own-repo"] + "../../EvilOrg/evil/main/x.json",
        # percent-encoded twin — undecoded by urlsplit, normalized server-side
        _PIN_BASES["own-repo"] + "%2e%2e/%2e%2e/EvilOrg/evil/main/x.json",
    )

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"

    def _fixture_with_urls(self, own_repo_url, litellm_url):
        doc = self._fixture_doc()
        doc["remote_sources"][0]["url"] = own_repo_url
        doc["remote_sources"][1]["url"] = litellm_url
        return self._write_fixture(doc)

    def test_non_allowlisted_urls_never_fetched_falls_to_family_latest(self):
        # Every bad-url shape fails BOTH per-source pins (wrong scheme / host
        # / port everywhere; the path shape matches neither source prefix).
        for bad_url in self._BAD_URLS:
            with self.subTest(url=bad_url):
                pricing_loader._reset_for_tests()
                path = self._fixture_with_urls(bad_url, bad_url)
                err = io.StringIO()
                with mock.patch.object(
                    pricing_loader, "_fetch_remote_doc"
                ) as fetch, redirect_stderr(err):
                    record = pricing_loader.rate_for("claude-opus-4-9", sot_path=path)
                self.assertEqual(
                    fetch.call_count, 0, "non-allowlisted url must never be fetched"
                )
                self.assertIn("allowlist", err.getvalue())
                self.assertFalse(os.path.exists(self._overlay_path(path)))
                self.assertEqual(record["resolution"], "family_latest")
                self.assertEqual(record["matched_model"], "claude-opus-4-8")

    def test_tampered_own_repo_url_skipped_litellm_still_consulted(self):
        # Per-source negative (own-repo): rejecting source #1 must not kill
        # source #2 — iteration continues and litellm wins.
        path = self._fixture_with_urls(
            "https://evil.example.com/bettep-dev/glass-atrium/main/hooks/pricing.json",
            _LITELLM_REMOTE_URL,
        )
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(litellm=RemoteResolutionTest._remote_doc()),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_args_list, [mock.call(_LITELLM_REMOTE_URL, 3)])
        self.assertIn("allowlist", err.getvalue())
        self.assertEqual(record["resolution"], "remote")
        self.assertEqual(record["source"], "litellm")

    def test_tampered_litellm_url_skipped_after_own_repo_miss(self):
        # Per-source negative (litellm): own-repo is a quiet miss, then the
        # tampered litellm url is refused with no network I/O.
        path = self._fixture_with_urls(
            _OWN_REPO_REMOTE_URL,
            "https://raw.githubusercontent.com/EvilOrg/litellm/main/x.json",
        )
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader, "_fetch_remote_doc", side_effect=_fetch_dispatch()
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-opus-4-9", sot_path=path)
        self.assertEqual(fetch.call_args_list, [mock.call(_OWN_REPO_REMOTE_URL, 3)])
        self.assertIn("allowlist", err.getvalue())
        self.assertEqual(record["resolution"], "family_latest")

    def test_cross_source_url_fails_the_per_source_pin(self):
        # The litellm URL is allowlisted — but NOT for the own-repo source:
        # the pin keys on each source's OWN path prefix, so a swap is refused.
        path = self._fixture_with_urls(_LITELLM_REMOTE_URL, _LITELLM_REMOTE_URL)
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader, "_fetch_remote_doc", side_effect=_fetch_dispatch()
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-opus-4-9", sot_path=path)
        # own-repo (carrying the litellm url) refused; litellm itself fetched
        # normally (a quiet miss here) — then family-latest.
        self.assertEqual(fetch.call_args_list, [mock.call(_LITELLM_REMOTE_URL, 3)])
        self.assertIn("allowlist", err.getvalue())
        self.assertEqual(record["resolution"], "family_latest")


class RemoteSanityRejectionTest(_LoaderCase):
    """A fetched rate failing sanity (numeric, positive, <$1000/MTok, 4 fields)
    is rejected loudly, never persisted, and the chain falls through."""

    def setUp(self):
        super().setUp()
        os.environ["PRICING_REMOTE_DISABLE"] = "0"

    def _assert_rejected(self, remote_doc):
        path = self._write_fixture()
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "_fetch_remote_doc",
            side_effect=_fetch_dispatch(litellm=remote_doc),
        ) as fetch, redirect_stderr(err):
            record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(fetch.call_count, 2)  # own-repo quiet miss, then litellm
        self.assertEqual(record["resolution"], "fallback")
        self.assertEqual(record["rate"], _FABLE_RATE)
        self.assertIn("from litellm failed sanity", err.getvalue())
        self.assertFalse(
            os.path.exists(self._overlay_path(path)),
            "a rejected rate must never enter the overlay",
        )

    def test_negative_rate_rejected(self):
        self._assert_rejected(
            RemoteResolutionTest._remote_doc(input_cost_per_token=-4e-06)
        )

    def test_rate_at_or_above_1000_per_mtok_rejected(self):
        # 0.002/token -> 2000/MTok, over the corruption ceiling.
        self._assert_rejected(
            RemoteResolutionTest._remote_doc(input_cost_per_token=0.002)
        )

    def test_missing_field_rejected(self):
        doc = RemoteResolutionTest._remote_doc()
        del doc["claude-foobar-9-9"]["cache_creation_input_token_cost"]
        self._assert_rejected(doc)

    def test_non_numeric_field_rejected(self):
        self._assert_rejected(
            RemoteResolutionTest._remote_doc(input_cost_per_token="4e-06")
        )


class OverlayTtlTest(_LoaderCase):
    """Step-2 TTL contract: fresh (within overlay_ttl_hours) serves, stale is a
    MISS (never served). Time is pinned via the _get_now_utc seam."""

    _FIXED_NOW = datetime.datetime(2026, 7, 2, 12, 0, 0, tzinfo=datetime.timezone.utc)

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(
            pricing_loader, "_get_now_utc", return_value=self._FIXED_NOW
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _write_overlay(self, sot_path, age_hours):
        overlay_path = self._overlay_path(sot_path)
        os.makedirs(os.path.dirname(overlay_path), exist_ok=True)
        entry = dict(RemoteResolutionTest._CONVERTED)
        fetched = self._FIXED_NOW - datetime.timedelta(hours=age_hours)
        entry["fetched_at"] = fetched.isoformat()
        entry["source"] = "litellm"
        with open(overlay_path, "w", encoding="utf-8") as fh:
            json.dump({"claude-foobar-9-9": entry}, fh)

    def test_fresh_entry_serves_as_overlay_resolution(self):
        path = self._write_fixture()
        self._write_overlay(path, age_hours=1)
        record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(record["resolution"], "overlay")
        self.assertEqual(record["rate"], RemoteResolutionTest._CONVERTED)
        # The overlay entry's recorded winning source rides along.
        self.assertEqual(record["source"], "litellm")

    def test_entry_exactly_at_ttl_is_still_fresh(self):
        # Contract: stale means STRICTLY older than the TTL window.
        path = self._write_fixture()
        self._write_overlay(path, age_hours=24)
        record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(record["resolution"], "overlay")

    def test_stale_entry_is_a_miss_never_served(self):
        # Remote is disabled (base setUp) → the chain lands on fallback,
        # proving the stale rate was NOT served.
        path = self._write_fixture()
        self._write_overlay(path, age_hours=25)
        record = pricing_loader.rate_for("claude-foobar-9-9", sot_path=path)
        self.assertEqual(record["resolution"], "fallback")
        self.assertEqual(record["rate"], _FABLE_RATE)


class StalenessTest(_LoaderCase):
    """staleness_days: age of last_verified vs an injected today (the hook
    compares it against stale_after_days and owns the advisory)."""

    def test_age_zero_on_the_verification_day(self):
        path = self._write_fixture()
        self.assertEqual(
            pricing_loader.staleness_days(today="2026-07-02", sot_path=path), 0
        )

    def test_age_counts_days_past_last_verified(self):
        path = self._write_fixture()
        self.assertEqual(
            pricing_loader.staleness_days(today="2026-10-02", sot_path=path), 92
        )

    def test_future_last_verified_is_negative(self):
        path = self._write_fixture()
        self.assertEqual(
            pricing_loader.staleness_days(today="2026-07-01", sot_path=path), -1
        )

    def test_malformed_today_raises(self):
        path = self._write_fixture()
        with self.assertRaises(ValueError):
            pricing_loader.staleness_days(today="not-a-date", sot_path=path)


class BackfillCalcCostTest(_LoaderCase):
    """P4 consumer contract: calc_cost keys on the row's OWN event_date, is
    batch-quiet, and still ALWAYS prices unknown models (remote disabled).
    Runs on a fixture SoT (production-aligned values) via the PRICING_SOT_PATH
    env seam — the same routing the backfill itself uses; the production
    tier's expiry must not break the consumer contract."""

    def setUp(self):
        super().setUp()
        doc = self._tiered_sonnet_doc()
        doc["models"]["claude-haiku-4-5"] = dict(_HAIKU_RATE)
        os.environ["PRICING_SOT_PATH"] = self._write_fixture(doc)

    def test_cost_anchors_unchanged(self):
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-opus-4-8"), 0.0175, places=10
        )
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-fable-5"), 0.035, places=10
        )
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-fable-5[1m]"), 0.035, places=10
        )
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-haiku-4-5-20251001"),
            0.0035,
            places=10,
        )

    def test_event_dated_intro_boundary(self):
        # Last intro day (inclusive): (1000*2 + 500*10)/1e6 = 0.007.
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-sonnet-5", "2026-08-31"),
            0.007,
            places=10,
        )
        # First standard day: (1000*3 + 500*15)/1e6 = 0.0105.
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-sonnet-5", "2026-09-01"),
            0.0105,
            places=10,
        )

    def test_dateless_row_prices_standard(self):
        # No event_date (timestamp-less legacy row) → standard rate via
        # pricing_loader.BASE_RATE — never the live clock, never an intro
        # discount.
        self.assertAlmostEqual(
            backfill.calc_cost(1000, 500, 0, 0, "claude-sonnet-5"), 0.0105, places=10
        )

    def test_zero_cost_allowlist_mirrors_the_hook(self):
        # "<synthetic>" / empty / None are clean $0 rows — hook parity: the
        # resolution chain is never walked (no per-row overlay stat/parse in
        # a corpus-wide batch), and the batch stays quiet.
        err = io.StringIO()
        with mock.patch.object(
            pricing_loader,
            "rate_for",
            side_effect=AssertionError("resolution chain walked on a zero-cost row"),
        ), redirect_stderr(err):
            for model in (None, "", "<synthetic>"):
                self.assertEqual(backfill.calc_cost(1000, 500, 0, 0, model), 0.0)
        self.assertEqual(err.getvalue(), "")

    def test_unknown_model_priced_batch_quiet(self):
        # Batch rule: no per-row stderr — surfacing is the reprice is_known
        # guard; the row still prices at the conservative fallback (0.035).
        err = io.StringIO()
        with redirect_stderr(err):
            cost = backfill.calc_cost(1000, 500, 0, 0, "claude-foobar-9-9")
        self.assertAlmostEqual(cost, 0.035, places=10)
        self.assertEqual(err.getvalue(), "")

    def test_reprice_guard_membership(self):
        # reprice_stored_rows reprices ONLY is_known rows — never bakes a
        # fallback/family guess into history.
        self.assertTrue(pricing_loader.is_known("claude-opus-4-8"))
        self.assertTrue(pricing_loader.is_known("claude-haiku-4-5-20251001"))
        self.assertFalse(pricing_loader.is_known("claude-foobar-9-9"))
        self.assertFalse(pricing_loader.is_known(""))


if __name__ == "__main__":
    sys.exit(unittest.main())
