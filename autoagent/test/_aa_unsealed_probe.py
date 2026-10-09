"""The cycle entries that reach the ledger and the canary files, unsealed, as a
building agent's test would run them — nothing patched, nothing sealed. Not a test
module (no ``test_`` prefix): ``test_aa_harness.AaUnsealedRunTest`` copies it into a
code tree it sets up and runs it there, in a child whose HOME and PGHOST are decoys,
once per runner. Anywhere else it skips.
"""

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_NOW = datetime(2026, 10, 9, 4, 30, tzinfo=timezone.utc)

for _anchor in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent"):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import daemon_cycle as dc  # noqa: E402 — anchors above


# a direct run at an install would act on its live ledger and canary files
@unittest.skipUnless(
    os.environ.get("AA_PROBE_CODE_ROOT") == str(_REPO_ROOT),
    "run only by test_aa_harness.AaUnsealedRunTest, from the code tree it copies",
)
class AaUnsealedProbe(unittest.TestCase):
    def test_run_aa_stage_unsealed(self) -> None:
        dc.run_aa_stage(f"{_NOW:%Y-%m-%d}")

    def test_ingest_manifest_log_unsealed(self) -> None:
        dc.ingest_manifest_log(dc.get_manifest_log_path(), now=_NOW)


if __name__ == "__main__":
    unittest.main()
