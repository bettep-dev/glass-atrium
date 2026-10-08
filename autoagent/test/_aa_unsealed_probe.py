"""One unsealed ``run_aa_stage``, as a building agent's test would run it — nothing patched, nothing
sealed. Not a test module (no ``test_`` prefix): ``test_aa_harness.AaUnsealedRunTest`` runs it in a
child whose HOME and PGHOST are decoys, once per runner. Never run it directly.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

for _anchor in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent"):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import daemon_cycle as dc


class AaStageUnsealedProbe(unittest.TestCase):
    def test_run_aa_stage_unsealed(self) -> None:
        # set only by the instrument check: a decoy install the stage acts from
        install_root = os.environ.get("AA_PROBE_INSTALL_ROOT")
        if install_root:
            dc._INSTALL_ROOT = Path(install_root)
        dc.run_aa_stage("2026-10-09")


if __name__ == "__main__":
    unittest.main()
