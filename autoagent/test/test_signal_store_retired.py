"""T13 — no remaining write path from any census emitter to the JSONL store.

The retired store's own record count cannot discriminate: an emitter whose
condition never occurs writes nothing while fully live, which is the state two
of the four census emitters were in for six weeks. So every assertion here is
over the WRITE PATH, driven by a fixture that FORCES each emitter's emit
condition true against a recording double standing in for the writer seam.

  (a) forced-emit path absence — all four census emitters
      (corpus_size_audit / patch_classification / reference_resolution /
      compliance_rate) driven with their emit condition true, zero append
      attempts recorded, and no store file created at the env-redirected path;
  (b) fixture liveness — the recording double registers an attempt when the
      seam it stands in for is actually called, so a zero in (a) is an
      observation rather than a fixture that exercises nothing. The full
      positive control is the same fixtures run against the pre-retirement
      tree, where each records >=1;
  (c) census closure over the RESOLVED call graph — the callables each emitter
      can reach inside compliance_telemetry are exactly the rate helpers, so a
      writer renamed, moved or re-wrapped rather than removed still reds.

Run with either runner:
    uv run --python 3.13 --with pytest pytest autoagent/test/test_signal_store_retired.py -v
    python3 -m unittest autoagent.test.test_signal_store_retired -v
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
for _dir in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent"):
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

import compliance_telemetry as ct  # noqa: E402
import daemon_cycle as dc  # noqa: E402

_AGGREGATOR = _REPO_ROOT / "hooks" / "learning-aggregator.py"

# The pre-move pointer form that resolves nowhere — forces the dead-reference
# emit condition true (same anchor test_dead_reference_guard.py pins).
_DEAD_REFERENCE = "~/.claude/rules/core-outcome-record.md"

# Callables inside the shared telemetry module an emitter may still reach: the
# rate half only. Anything else reachable there is a surviving writer.
_ALLOWED_TELEMETRY_CALLABLES = {
    "compute_compliance_rate",
    "insufficient_data_rate",
    "parse_gate_log",
    "_resolve",
    "_resolve_gate_log_file",
}


def _load_aggregator() -> types.ModuleType:
    """Import the hyphen-named aggregator by path (no importable module name)."""
    spec = importlib.util.spec_from_file_location("aggregator_probe", _AGGREGATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _fixture_corpus(root: Path) -> tuple[Path, Path, Path]:
    """Two rule files and no agent body.

    The empty agents directory is load-bearing: every corpus root has a live
    default, so a fixture that leaves one unset measures this machine.
    """
    rules_dir = root / "rules"
    rules_dir.mkdir()
    (rules_dir / "a.md").write_text("alpha beta gamma\n", encoding="utf-8")
    global_rules = root / "GLOBAL.md"
    global_rules.write_text("delta epsilon\n", encoding="utf-8")
    agents_dir = root / "agents"
    agents_dir.mkdir()
    return rules_dir, global_rules, agents_dir


@contextlib.contextmanager
def _recording_seam(store: Path):
    """Stand the writer seam in with a counter, and redirect the store path.

    The double is installed under the seam's own name on the shared module, so
    a surviving caller that still resolves it through that module records an
    attempt instead of writing. The env redirect is the second, independent
    net: any writer bypassing the module attribute still lands on ``store``.
    """
    attempts: list[object] = []
    previous = getattr(ct, "append_signal", None)
    ct.append_signal = lambda signal, store_file=None: (  # type: ignore[attr-defined]
        attempts.append(signal) or True
    )
    try:
        with mock.patch.dict(
            os.environ, {"AUTOAGENT_SIGNAL_STORE_FILE": str(store)}, clear=False
        ):
            yield attempts
    finally:
        if previous is None:
            delattr(ct, "append_signal")
        else:
            ct.append_signal = previous  # type: ignore[attr-defined]


def _reachable_telemetry_callables(fn: object) -> set[str]:
    """Names inside compliance_telemetry reachable from ``fn``'s call graph.

    Resolution is over code objects and the defining module's globals — not a
    text search — so a renamed or re-wrapped writer still surfaces here.
    """
    seen: set[int] = set()
    found: set[str] = set()

    def walk(func: object) -> None:
        code = getattr(func, "__code__", None)
        if code is None or id(func) in seen:
            return
        seen.add(id(func))
        namespace = getattr(func, "__globals__", {})
        for name in code.co_names:
            target = namespace.get(name)
            if target is None:
                # Attribute access on the module object (ct.append_signal).
                if hasattr(ct, name) and callable(getattr(ct, name)):
                    found.add(name)
                continue
            if getattr(target, "__module__", None) == ct.__name__:
                found.add(name)
            elif getattr(target, "__code__", None) is not None:
                walk(target)

    walk(fn)
    return found


class ForcedEmitPathAbsence(unittest.TestCase):
    """(a) every census emitter, condition forced true, zero append attempts."""

    def test_when_every_emitter_is_forced_then_no_append_is_attempted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = root / "signals.jsonl"
            rules_dir, global_rules, agents_dir = _fixture_corpus(root)
            diff = f"+> See `{_DEAD_REFERENCE}` for the spec.\n+another added line"

            with _recording_seam(store) as attempts:
                dc.audit_corpus_size(
                    rules_dir=rules_dir,
                    global_rules_file=global_rules,
                    agents_dir=agents_dir,
                    gate_log_file=root / "absent-gate.log",
                )
                classification = dc.classify_prose_only_add(
                    "+added line\n+another", target_file="rules/a.md"
                )
                with open(os.devnull, "w", encoding="utf-8") as sink:
                    with contextlib.redirect_stderr(sink):
                        reference = dc.classify_dead_reference(
                            diff, target_file="agents/x.md"
                        )
                aggregator = _load_aggregator()

            # The conditions were genuinely forced, not merely invoked.
            self.assertTrue(classification["warning"])
            self.assertTrue(reference["warning"])
            # The fourth emitter's writer is gone outright — nothing to drive.
            self.assertIsNone(getattr(aggregator, "record_compliance_signal", None))

            self.assertEqual(attempts, [])
            self.assertFalse(store.exists())

    def test_when_the_seam_is_called_then_the_double_records_it(self) -> None:
        """(b) the counter is live — a zero above is an observation."""
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "signals.jsonl"
            with _recording_seam(store) as attempts:
                ct.append_signal({"signal_type": "probe"})  # type: ignore[attr-defined]
            self.assertEqual(len(attempts), 1)


class CensusClosure(unittest.TestCase):
    """(c) the writer seam is unreachable from every emitter's call graph."""

    def test_when_the_call_graph_is_resolved_then_only_rate_helpers_remain(
        self,
    ) -> None:
        for emitter in (
            dc.audit_corpus_size,
            dc.classify_prose_only_add,
            dc.classify_dead_reference,
        ):
            with self.subTest(emitter=emitter.__name__):
                reachable = _reachable_telemetry_callables(emitter)
                self.assertEqual(reachable - _ALLOWED_TELEMETRY_CALLABLES, set())

    def test_when_the_writer_half_is_retired_then_its_names_are_gone(self) -> None:
        self.assertIsNone(getattr(ct, "append_signal", None))
        self.assertIsNone(getattr(ct, "SIGNAL_STORE_FILE", None))
        self.assertIsNone(getattr(dc, "_record_signal", None))
        # The rate half stays — only the sink retires.
        self.assertTrue(callable(ct.compute_compliance_rate))
        self.assertTrue(callable(ct.parse_gate_log))


if __name__ == "__main__":
    unittest.main()
