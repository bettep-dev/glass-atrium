"""Model ids an agents folder pins: each file's top-level frontmatter `model:` line.

Shared by scripts/check-pricing-roster.sh and hooks/test/test_cost_pricing.py, so the pin
read has one owner.
"""

from __future__ import annotations

import re
from pathlib import Path

_FRONTMATTER = re.compile(r"---\n(.*?)\n---", re.S)
_MODEL_LINE = re.compile(r"^model:\s*[\"']?([^\"'\s]+)", re.M)
# follows the session model → no id of its own to price
_SESSION_MODEL = "inherit"


def get_agent_pins(agents_dir: str | Path) -> set[str]:
    """Distinct pinned ids across `<agents_dir>/*.md`.

    Raises OSError / UnicodeDecodeError on an unreadable file — a caller must not read
    that as "no pin".
    """
    pins: set[str] = set()
    for path in sorted(Path(agents_dir).glob("*.md")):
        head = _FRONTMATTER.match(path.read_text(encoding="utf-8"))
        if head:
            pins.update(_MODEL_LINE.findall(head.group(1)))
    return pins - {_SESSION_MODEL}
