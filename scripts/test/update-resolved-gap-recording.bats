#!/usr/bin/env bats
# update-resolved-gap-recording.bats — pins the self-improvement-history row that
# scripts/update.sh writes when a body's conflicting EDITABLE gaps resolve to the
# release side (update_emit_resolved_records + _UPDATE_PROPOSAL_PY).
#
# Why this record exists: the resolved-gap path discards daemon-authored content
# with no model call and no per-file operator judgment, so the recorded row IS the
# accountability surface a human reviews afterwards. If it silently fails to write,
# the loop deletes learned content leaving no trace.
#
# Contracts pinned:
#   T1 envelope  — one envelope per resolved file carrying the constant pattern
#                  label, approval_tier=auto (never the legacy llm tier, which the
#                  monitor folds into the safety bucket), a NON-EMPTY
#                  cost_guard_state (a required positional parameter of
#                  write_autoagent_proposal — omitting it raises inside the CLI on
#                  both retries and the row never lands), and a haiku_status that
#                  cannot satisfy any LIKE 'ok%' apply-eligibility gate.
#   T2 landed    — the row is OBSERVED present in core.autoagent_proposals after the
#                  real dual-write CLI runs. An emit-level assertion passes even when
#                  the CLI rejects the envelope, so the landed row is the assertion.
#   T3 upsert    — the same file resolved twice on one day yields ONE row.
#   T4 outage    — a non-zero CLI exit produces one warning and returns 0 (a database
#                  write failure must never abort a deploy).
#   T5 no helper — an absent dual-write helper warns and returns 0.
#   T6 rejected  — a file that did NOT land records classification reject / status
#                  rejected (nothing was discarded, so the row must not read applied).
#   T7 rationale — the rationale carries the hunk count, the dropped/added line
#                  counts and a bounded excerpt of the dropped daemon lines.
#
# T2/T3 need Postgres and skip without it; every other test is hermetic (update.sh is
# SOURCED, the CLI is stubbed, all paths stay in a temp dir).
#
# Run via: bats scripts/test/update-resolved-gap-recording.bats
# Requires: bats 1.5+, bash 3.2+, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
UPDATE_SH="${GA}/scripts/update.sh"
PG_HELPER="${GA}/scripts/_pg_dual_write_daemon.py"

setup() {
  [[ -f "${UPDATE_SH}" ]] || skip "update.sh not found: ${UPDATE_SH}"
  WORK="$(cd -- "$(mktemp -d -t ga-resolved-rec.XXXXXX)" && pwd -P)"
  ROOT="${WORK}/install"
  mkdir -p "${ROOT}/scripts"

  # A resolved candidate's captured live-to-candidate diff: two daemon lines
  # dropped, one release line taken.
  DIFF_FILE="${WORK}/agent.resolved.diff"
  cat >"${DIFF_FILE}" <<'DIFF'
--- a/agents/ga-rec-probe.md
+++ b/agents/ga-rec-probe.md
@@ -1,4 +1,3 @@
 - MUST keep the shared preamble
-- MUST checkpoint tool_use progress at 70% of the estimate
-- MUST NOT retry a denied Edit
+- MUST size the work before the first Edit
DIFF

  RELEASE="${WORK}/release-body.md"
  printf 'release body\n' >"${RELEASE}"

  # The per-run outcome ledger: the commit callback appends a basename on
  # GIT_TXN_OK, which is how the emitter learns a file actually landed.
  LEDGER="${WORK}/agent-outcomes.ledger"
  : >"${LEDGER}"

  TSV="${WORK}/resolved.tsv"
  CAPTURE="${WORK}/envelope.json"

  DRIVER="${WORK}/driver.sh"
  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck disable=SC1090
source "${UPDATE_SH}"
update_log() { printf '%s\n' "$*"; }
_update_agent_outcomes_file="${LEDGER}"
update_emit_resolved_records "${ROOT}" "${TSV}"
DRV
  chmod +x "${DRIVER}"

  # Stub CLI: captures the envelope, exits with STUB_RC (default 0).
  cat >"${WORK}/stub-helper.py" <<'PY'
import os, sys
open(os.environ["CAPTURE"], "w", encoding="utf-8").write(sys.stdin.read())
sys.exit(int(os.environ.get("STUB_RC", "0")))
PY
}

teardown() {
  [[ -n "${WORK:-}" ]] && rm -rf -- "${WORK}"
  return 0
}

# One resolved-file row: base, target, release, hunks, dropped, added, regions, diff.
write_tsv() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${1:-ga-rec-probe.md}" "agents/${1:-ga-rec-probe.md}" "${RELEASE}" \
    2 2 1 "0,3" "${DIFF_FILE}" >"${TSV}"
}

run_driver() {
  UPDATE_SH="${UPDATE_SH}" ROOT="${ROOT}" TSV="${TSV}" LEDGER="${LEDGER}" \
    CAPTURE="${CAPTURE}" STUB_RC="${STUB_RC:-0}" \
    ATRIUM_UPDATE_PG_HELPER="${ATRIUM_UPDATE_PG_HELPER:-${WORK}/stub-helper.py}" \
    bash "${DRIVER}"
}

envelope_field() {
  python3 -c '
import json, sys
print(json.load(open(sys.argv[1]))["args"][sys.argv[2]])
' "${CAPTURE}" "$1"
}

db_available() {
  command -v psql >/dev/null 2>&1 || return 1
  psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc 'select 1' >/dev/null 2>&1
}

@test "T1 envelope carries the auto tier, the constant label and a non-empty cost guard state" {
  write_tsv
  printf 'ga-rec-probe.md\n' >"${LEDGER}"
  run run_driver
  [ "$status" -eq 0 ]
  [ -s "${CAPTURE}" ]

  run envelope_field pattern_label
  [ "$output" = "editable-region-resolved-release" ]

  run envelope_field approval_tier
  [ "$output" = "auto" ]

  # The legacy llm tier folds into the safety bucket in both the tier-count fold
  # and the query builder, inflating the awaiting-decision count.
  refute_equals_llm="$(envelope_field approval_tier)"
  [ "${refute_equals_llm}" != "llm" ]

  run envelope_field cost_guard_state
  [ -n "$output" ]

  # A LIKE 'ok%' apply-eligibility gate must never match this row.
  run envelope_field haiku_status
  [[ "$output" != ok* ]]
  [[ "$output" == skipped:* ]]

  # body-auto is the label the dispatcher maps to the apply enum; a bare "apply"
  # is unknown to it and coerces to reject.
  run envelope_field classification
  [ "$output" = "body-auto" ]

  run envelope_field status
  [ "$output" = "applied" ]

  run envelope_field target_agent
  [ "$output" = "ga-rec-probe" ]

  # source_file_mtime is NOT NULL in the schema.
  run envelope_field source_file_mtime
  [ "$output" -gt 0 ]
}

@test "T7 rationale names the hunk count, the line deltas and a bounded dropped excerpt" {
  write_tsv
  run run_driver
  [ "$status" -eq 0 ]
  rationale="$(envelope_field rationale)"
  [[ "$rationale" == *"2 gap(s)"* ]]
  [[ "$rationale" == *"region(s) 0,3"* ]]
  [[ "$rationale" == *"dropped 2 daemon-authored line(s)"* ]]
  [[ "$rationale" == *"added 1 release line(s)"* ]]
  [[ "$rationale" == *"no model call"* ]]
  [[ "$rationale" == *"checkpoint tool_use progress"* ]]
  # Bounded: an excerpt, never the whole region.
  [ "${#rationale}" -lt 800 ]
}

@test "T6 a file that did not land records reject / rejected" {
  write_tsv
  : >"${LEDGER}" # no GIT_TXN_OK entry → the transaction never landed
  run run_driver
  [ "$status" -eq 0 ]

  run envelope_field classification
  [ "$output" = "reject" ]

  run envelope_field status
  [ "$output" = "rejected" ]

  rationale="$(envelope_field rationale)"
  [[ "$rationale" == *"not applied"* ]]
}

@test "T4 a non-zero CLI exit warns once and continues the update" {
  write_tsv
  STUB_RC=7 run run_driver
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN: could not record the resolved-gap discard"* ]]
  [[ "$output" == *"deploy continues"* ]]
}

@test "T5 an absent dual-write helper warns and continues" {
  write_tsv
  ATRIUM_UPDATE_PG_HELPER="${WORK}/nope.py" run run_driver
  [ "$status" -eq 0 ]
  [[ "$output" == *"no dual-write helper"* ]]
}

@test "T2 the row LANDS in core.autoagent_proposals through the real dual-write CLI" {
  db_available || skip "postgres unavailable"
  [[ -f "${PG_HELPER}" ]] || skip "dual-write helper missing"
  python3 -c 'import psycopg' 2>/dev/null || skip "psycopg unavailable"

  target="ga-rec-landed-$$.md"
  write_tsv "${target}"
  printf '%s\n' "${target}" >"${LEDGER}"
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]
  [[ "$output" == *"resolved-gap discard recorded"* ]]

  row="$(psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc \
    "SELECT approval_tier || '|' || status || '|' || haiku_status || '|' || cost_guard_state
       FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-resolved-release'
        AND target_file = 'agents/${target}'")"
  psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -qc \
    "DELETE FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-resolved-release'
        AND target_file = 'agents/${target}'" >/dev/null

  [ "${row}" = "auto|applied|skipped:no-model-call|ok" ]
}

@test "T3 the same file resolved twice on one day lands ONE row" {
  db_available || skip "postgres unavailable"
  [[ -f "${PG_HELPER}" ]] || skip "dual-write helper missing"
  python3 -c 'import psycopg' 2>/dev/null || skip "psycopg unavailable"

  target="ga-rec-upsert-$$.md"
  write_tsv "${target}"
  printf '%s\n' "${target}" >"${LEDGER}"
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]

  count="$(psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc \
    "SELECT count(*) FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-resolved-release'
        AND target_file = 'agents/${target}'")"
  psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -qc \
    "DELETE FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-resolved-release'
        AND target_file = 'agents/${target}'" >/dev/null

  [ "${count}" = "1" ]
}
