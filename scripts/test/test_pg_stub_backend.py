"""Column contract of the shared psycopg stand-in (scripts/test/_pg_stub_backend.py).

A stub table is built from the Prisma model's columns, so a relation field read as a
column gives the stand-in a column the migrated table does not have.

Run with:
    python3 -m pytest scripts/test/test_pg_stub_backend.py -v
"""

from __future__ import annotations

import _pg_stub_backend as stub
import pytest

# (model, relation field's column-cased name, a real column of the same model)
_RELATION_ROWS = [
    pytest.param(
        "AutoagentProposal", "learning_pattern", "learning_pattern_id",
        id="singular relation side carrying @relation",
    ),
    pytest.param("DaemonRun", "payload", "run_date", id="singular back-relation side"),
    pytest.param("LearningLog", "proposals", "metric_key", id="list back-relation side"),
]


@pytest.mark.parametrize(("model", "relation", "column"), _RELATION_ROWS)
def test_model_columns_exclude_relation_fields_and_keep_real_columns(
    model: str, relation: str, column: str
) -> None:
    columns = stub._get_model_columns(model)

    assert relation not in columns, "%s relation field read as a column" % model
    assert column in columns, "%s lost its real column %s" % (model, column)
