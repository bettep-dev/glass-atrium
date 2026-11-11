"""Parity pin between the curator body's category rule and the health check that applies it.

The spawned curator reads only its body, so the body's heading level is a copy of
``wiki_deadlinks._parse_topic_map_categories``; this test fails when the two differ.

Run with either runner:
    uv run --with pytest pytest scripts/test/test_wiki_deadlinks.py -v
    python3 -m unittest scripts.test.test_wiki_deadlinks -v
"""

from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import wiki_deadlinks  # noqa: E402  (sys.path set above)

_CURATOR_BODY = _SCRIPTS_ROOT.parent / "agents" / "glass-atrium-wiki-curator.md"
_CATEGORY_CLAIM = re.compile(r"`category` matches no H(\d) heading of `index/topic-map\.md`")


class TestCuratorCategoryParity(unittest.TestCase):
    def test_body_heading_level_is_the_level_the_health_check_reads_as_categories(self) -> None:
        claim = _CATEGORY_CLAIM.search(_CURATOR_BODY.read_text(encoding="utf-8"))
        self.assertIsNotNone(claim, f"no category heading-level claim in {_CURATOR_BODY}")
        assert claim is not None  # narrowed for the type checker; asserted above
        level = int(claim.group(1))
        with tempfile.TemporaryDirectory() as tmp:
            topic_map = Path(tmp) / "topic-map.md"
            topic_map.write_text(
                "".join(f"{'#' * n} level-{n}-topic\n\nbody\n\n" for n in range(1, 5)),
                encoding="utf-8",
            )
            categories = wiki_deadlinks._parse_topic_map_categories(topic_map)
        self.assertEqual(categories, {f"level-{level}-topic"})


if __name__ == "__main__":
    unittest.main()
