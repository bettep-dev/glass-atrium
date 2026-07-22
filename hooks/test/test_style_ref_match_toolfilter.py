#!/usr/bin/env python3
"""Tool-filter + cache-namespacing coverage for lib/style_ref_match.py (T2 matcher
half — the transcript cross-check collector absorbed from former T15).

Pins the corrections the plan calls out:
  * the byte scanner selects tool_uses by a NAME-SET, not a hardcoded single tool,
    so a write-history collector reads Write/Edit and the style_ref collector reads
    Read — over the SAME transcript.
  * the incremental cache is namespaced by the tool-filter in the FILENAME and the
    fingerprint check, so the write collector never returns the read collector's
    cached paths (the "populate via a read collection first, same process" fixture).
    A schema bump alone would NOT fix this — the filename keys on schema+path.

FAILS AT HEAD by construction: at HEAD collect_read_paths takes no tool_names arg and
collect_write_paths does not exist, so the write-collector + namespacing assertions
raise. GREEN after T2.

    python3 -m unittest hooks.test.test_style_ref_match_toolfilter -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

_LIB = Path(__file__).resolve().parent.parent / "lib" / "style_ref_match.py"


def _load_srm():
    spec = importlib.util.spec_from_file_location("style_ref_match", _LIB)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


srm = _load_srm()

READ_PATH = "/repo/src/read-one.ts"
WRITE_PATH = "/repo/src/write-one.ts"
EDIT_PATH = "/repo/src/edit-one.ts"


def _tool_line(name, fpath):
    return json.dumps(
        {"content": [{"type": "tool_use", "name": name, "input": {"file_path": fpath}}]}
    )


class ToolFilterTest(unittest.TestCase):
    def setUp(self):
        self._prev_env = {
            k: os.environ.get(k)
            for k in ("STYLE_REF_READCACHE_DIR", "STYLE_REF_READCACHE_OFF")
        }
        self.tmp = tempfile.mkdtemp(prefix="srm-toolfilter.")
        self.transcript = os.path.join(self.tmp, "agent.jsonl")
        with open(self.transcript, "w", encoding="utf-8") as fh:
            fh.write(_tool_line("Read", READ_PATH) + "\n")
            fh.write(_tool_line("Write", WRITE_PATH) + "\n")
            fh.write(_tool_line("Edit", EDIT_PATH) + "\n")
        self.cache_dir = os.path.join(self.tmp, "cache")

    def tearDown(self):
        for k, v in self._prev_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cache_on(self):
        os.environ.pop("STYLE_REF_READCACHE_OFF", None)
        os.environ["STYLE_REF_READCACHE_DIR"] = self.cache_dir

    def _cache_off(self):
        os.environ["STYLE_REF_READCACHE_OFF"] = "1"

    def test_read_filter_selects_only_read(self):
        self._cache_off()
        self.assertEqual(srm.collect_read_paths(self.transcript), [READ_PATH])

    def test_default_tool_names_is_read(self):
        # Backward compat: no tool_names arg behaves as the Read collector.
        self._cache_off()
        self.assertEqual(srm.collect_read_paths(self.transcript), [READ_PATH])

    def test_write_collector_selects_write_and_edit(self):
        self._cache_off()
        self.assertEqual(
            srm.collect_write_paths(self.transcript), [WRITE_PATH, EDIT_PATH]
        )

    def test_write_collector_does_not_return_read_history_same_process(self):
        # The load-bearing fixture: populate the READ cache first, then the write
        # collector must NOT surface the cached read path (cross-collector poisoning).
        self._cache_on()
        read_paths = srm.collect_read_paths(self.transcript)
        self.assertEqual(read_paths, [READ_PATH])
        write_paths = srm.collect_write_paths(self.transcript)
        self.assertEqual(write_paths, [WRITE_PATH, EDIT_PATH])
        self.assertNotIn(READ_PATH, write_paths)

    def test_cache_namespaced_by_tool_filter_in_filename(self):
        self._cache_on()
        srm.collect_read_paths(self.transcript)
        srm.collect_write_paths(self.transcript)
        files = sorted(os.listdir(self.cache_dir))
        # Two DISTINCT files — one per tool-filter tag (read vs edit-write).
        read_files = [f for f in files if "-read-" in f]
        write_files = [f for f in files if "-edit-write-" in f]
        self.assertEqual(len(read_files), 1, files)
        self.assertEqual(len(write_files), 1, files)

    def test_incremental_reuse_is_full_scan_after_append(self):
        # Namespaced incremental cache still returns the full-scan set after a growth.
        self._cache_on()
        self.assertEqual(srm.collect_write_paths(self.transcript), [WRITE_PATH, EDIT_PATH])
        with open(self.transcript, "a", encoding="utf-8") as fh:
            fh.write(_tool_line("Write", "/repo/src/write-two.ts") + "\n")
        self.assertEqual(
            srm.collect_write_paths(self.transcript),
            [WRITE_PATH, EDIT_PATH, "/repo/src/write-two.ts"],
        )


if __name__ == "__main__":
    unittest.main()
