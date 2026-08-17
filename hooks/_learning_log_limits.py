#!/usr/bin/env python3
# Column limits for core.learning_log, in a stdlib-only module.
#
# Same extraction rationale as _outcome_signal: _pg_learning_dualwrite imports
# psycopg unguarded and dies without it, so anything a psycopg-free caller needs
# to read out of that module has to live beside it rather than in it. The budget
# test for the daemon's reason templates is exactly such a caller — it runs in CI,
# where psycopg is not installed, and a test that skipped itself there would pin
# nothing.
#
# The write path imports this and applies the slice; nobody restates the number.

# Width of core.learning_log.last_transition_reason (varchar(500)).
#
# The slice the write path applies with it is SILENT: an over-long reason is
# stored truncated with no error and no warning, surfacing only as a stored row
# ending mid-word. Callers that build a reason from a template are expected to
# import this and check their widest formatted case against it — the daemon's
# templates are static, so autoagent/test/test_reason_tail_budget.py does that
# check once for all of them.
LEARNING_LOG_REASON_MAX = 500
