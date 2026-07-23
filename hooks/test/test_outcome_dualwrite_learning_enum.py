"""Regression test for the outcome-dualwrite learning-log enum cast (DF-2).

``hooks/_pg_outcome_dualwrite.py`` UPSERTs a learning-hint row whose ``status``
column is cast ``::core."LearningStatus"``. The cast literal was ``'pending'``,
a value ABSENT from the ``LearningStatus`` enum defined in the squashed baseline
migration. Because the whole outcome write runs in ONE BEGIN/COMMIT covering
outcomes + signals + learning_hint, the invalid cast raised at execute time and
aborted the ENTIRE transaction — so the FIRST non-null ``learning_hint`` silently
dropped the outcome record it travelled with.

Protected invariants (no database needed — a live insert would need psycopg + a
running PG; this cross-checks the SQL literal against the migration enum SoT,
which is exactly the defect surface and the AC's "cross-checked vs squashed
migration"):

(1) the status literal cast in ``_LEARNING_LOG_UPSERT_SQL`` is a MEMBER of the
    ``LearningStatus`` enum declared in the squashed baseline migration;
(2) the retired invalid value ``'pending'`` never reappears in that cast;
(3) the fix uses the valid member ``'identified'`` (the "newly discovered,
    not yet proposed" state).

Run with either runner:
    uv run --with pytest pytest hooks/test/test_outcome_dualwrite_learning_enum.py -v
    python3 -m unittest hooks.test.test_outcome_dualwrite_learning_enum -v
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

_HOOKS_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _HOOKS_ROOT.parent
_MIGRATION = (
    _REPO_ROOT
    / "monitor"
    / "prisma"
    / "migrations"
    / "20260611000000_init_squashed"
    / "migration.sql"
)

if str(_HOOKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HOOKS_ROOT))

# The module hard-exits (module-level sys.exit) when psycopg is absent, so SystemExit
# must be caught alongside ImportError — this suite only reads the SQL literal, no DB.
try:
    import _pg_outcome_dualwrite as dw  # noqa: E402 — sys.path insert immediately above

    _IMPORT_ERROR: BaseException | None = None
except (SystemExit, Exception) as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dw = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

# The cast literal fed to core."LearningStatus" in the learning-log UPSERT — the
# defect site. Captures the single-quoted value immediately preceding the cast.
_STATUS_CAST_RE = re.compile(
    r"'([a-z_]+)'::core\.\"LearningStatus\"", re.IGNORECASE
)

# CREATE TYPE "core"."LearningStatus" AS ENUM ('a', 'b', ...) — the enum SoT.
_ENUM_DECL_RE = re.compile(
    r'CREATE TYPE "core"\."LearningStatus" AS ENUM \(([^)]*)\)',
    re.IGNORECASE,
)


def _migration_enum_members() -> set[str]:
    text = _MIGRATION.read_text(encoding="utf-8")
    match = _ENUM_DECL_RE.search(text)
    assert match is not None, "LearningStatus enum declaration not found in migration"
    return set(re.findall(r"'([a-z_]+)'", match.group(1), re.IGNORECASE))


def _cast_literal() -> str:
    match = _STATUS_CAST_RE.search(dw._LEARNING_LOG_UPSERT_SQL)
    assert match is not None, "LearningStatus cast literal not found in UPSERT SQL"
    return match.group(1)


@unittest.skipIf(dw is None, f"import failed: {_IMPORT_ERROR}")
class LearningStatusEnumCastTest(unittest.TestCase):
    def test_cast_literal_is_a_migration_enum_member(self) -> None:
        members = _migration_enum_members()
        # Sanity — the migration parse actually yielded the known members.
        self.assertIn("identified", members)
        self.assertNotIn("pending", members)
        self.assertIn(
            _cast_literal(),
            members,
            "learning-log status cast must be a valid LearningStatus member "
            "or the whole outcome transaction aborts on the first non-null hint",
        )

    def test_retired_pending_literal_is_gone(self) -> None:
        self.assertNotEqual(
            _cast_literal(),
            "pending",
            "'pending' is absent from the LearningStatus enum — a regression",
        )

    def test_fix_uses_identified(self) -> None:
        self.assertEqual(_cast_literal(), "identified")


if __name__ == "__main__":
    unittest.main()
