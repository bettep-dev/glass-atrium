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
#   T3 upsert    — the same file resolved repeatedly on one day yields ONE row whose
#                  status tracks the LAST outcome, in BOTH directions (a same-day
#                  decline-then-accept must not leave rejected on landed content).
#   T4 outage    — a non-zero CLI exit produces one warning and returns 0 (a database
#                  write failure must never abort a deploy).
#   T5 no helper — an absent dual-write helper warns and returns 0.
#   T6 rejected  — a file that did NOT land records classification reject / status
#                  rejected (nothing was discarded, so the row must not read applied).
#   T7 rationale — the rationale carries the hunk count, the dropped/added line
#                  counts and a bounded excerpt of the dropped daemon lines.
#   T9 multi-row — a run of two rows splits landed per row and stamps BOTH with one
#                  cycle date: the date is forked once per run, so a midnight
#                  crossing can never split one run's rows across two days.
#   T11 gated    — EVERY row records the improvement-verify gate that ran, never
#                  skipped:no-model-call, and stays outside every LIKE 'ok%'
#                  apply-eligibility gate. An invariant rather than one fixture:
#                  the arbiter verdict has no non-gated complement to contrast.
#   T10 no ledger — an empty or absent ledger PATH records rejected and still
#                  returns 0 (an unreadable ledger must not abort the deploy).
#   T12 roster   — the landed lookup keys on the row's manifest-relative target, so a
#                  path that is not an agent body splits landed by the same rule.
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

  # The resolver's sidecar: ONLY the lines a conflicting gap discarded, which is
  # what makes the excerpt daemon-authored rather than whatever the diff removed.
  DROPPED_TEXT="${WORK}/agent.candidate.dropped"
  cat >"${DROPPED_TEXT}" <<'DROPPED'
- MUST checkpoint tool_use progress at 70% of the estimate
- MUST NOT retry a denied Edit
DROPPED

  RELEASE="${WORK}/release-body.md"
  printf 'release body\n' >"${RELEASE}"

  # The per-run outcome ledger: the commit callback appends a manifest-relative
  # path on GIT_TXN_OK, which is how the emitter learns a file actually landed. The
  # emitter reads the row's target field against it, so a fixture line here is the
  # same string the row carries.
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
# Tick-counting date shim, opt-in so the Postgres tests keep the real date their
# DATE column stores. The tick lives on DISK because `date` runs inside a command
# substitution: a shell-variable counter is lost with the subshell and would return
# the same value every call, making the once-per-run assertion pass either way.
if [[ -n "${DATE_TICKS:-}" ]]; then
  date() {
    printf 'x\n' >>"${DATE_TICKS}"
    printf '2026-01-%02d\n' "$(wc -l <"${DATE_TICKS}" | tr -d ' ')"
  }
fi
update_emit_resolved_records "${ROOT}" "${TSV}" "${LEDGER}"
DRV
  chmod +x "${DRIVER}"

  # Stub CLI: APPENDS one envelope line per row (JSONL) — the emitter runs it once
  # per TSV row, so a write-mode capture would keep only the last envelope and a
  # multi-row assertion would silently read row N alone. Exits with STUB_RC.
  cat >"${WORK}/stub-helper.py" <<'PY'
import os, sys
with open(os.environ["CAPTURE"], "a", encoding="utf-8") as fh:
    fh.write(sys.stdin.read())
sys.exit(int(os.environ.get("STUB_RC", "0")))
PY
}

teardown() {
  [[ -n "${WORK:-}" ]] && rm -rf -- "${WORK}"
  return 0
}

# One resolved-file row: base, target, release, hunks, dropped, added, regions,
# diff, dropped-text sidecar, needs_llm. $2 overrides the sidecar path (an absent
# one exercises the diff fallback); $3 overrides the file-level needs_llm, whose
# default True is what the resolver reports for every arbiter-resolved file.
write_tsv() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${1:-ga-rec-probe.md}" "agents/${1:-ga-rec-probe.md}" "${RELEASE}" \
    2 2 1 "0,3" "${DIFF_FILE}" "${2-${DROPPED_TEXT}}" "${3:-True}" >"${TSV}"
}

run_driver() {
  UPDATE_SH="${UPDATE_SH}" ROOT="${ROOT}" TSV="${TSV}" LEDGER="${LEDGER}" \
    CAPTURE="${CAPTURE}" STUB_RC="${STUB_RC:-0}" DATE_TICKS="${DATE_TICKS:-}" \
    ATRIUM_UPDATE_PG_HELPER="${ATRIUM_UPDATE_PG_HELPER:-${WORK}/stub-helper.py}" \
    bash "${DRIVER}"
}

# $1 = envelope arg name · $2 = 1-based row, defaulting to the LAST captured
# envelope (the only one a single-row run produces).
envelope_field() {
  python3 -c '
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
idx = int(sys.argv[3])
print(rows[idx - 1 if idx else -1]["args"][sys.argv[2]])
' "${CAPTURE}" "$1" "${2:-0}"
}

db_available() {
  command -v psql >/dev/null 2>&1 || return 1
  psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc 'select 1' >/dev/null 2>&1
}

@test "T1 envelope carries the auto tier, the constant label and a non-empty cost guard state" {
  write_tsv
  printf 'agents/ga-rec-probe.md\n' >"${LEDGER}"
  run run_driver
  [ "$status" -eq 0 ]
  [ -s "${CAPTURE}" ]

  run envelope_field pattern_label
  [ "$output" = "editable-region-arbiter-resolved" ]

  run envelope_field approval_tier
  [ "$output" = "auto" ]

  # The legacy llm tier folds into the safety bucket in both the tier-count fold
  # and the query builder, inflating the awaiting-decision count.
  refute_equals_llm="$output"
  [ "${refute_equals_llm}" != "llm" ]

  run envelope_field cost_guard_state
  [ -n "$output" ]

  # A LIKE 'ok%' apply-eligibility gate must never match this row — the whole
  # apply-ineligibility safety case rests on this one literal, so it is asserted
  # through an explicit `return 1`: a bare mid-body `[[ ]]` does NOT fail a bats
  # test (only its LAST command and the simple-command forms gate), which is what
  # made the earlier form of this pin pass with haiku_status="ok".
  run envelope_field haiku_status
  if [[ "$output" == ok* ]]; then
    echo "haiku_status satisfies a LIKE 'ok%' apply-eligibility gate: ${output}"
    return 1
  fi
  if [[ "$output" != verified:improvement-gate ]]; then
    echo "haiku_status must name the gate the candidate passed: ${output}"
    return 1
  fi

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
  [[ "$rationale" == *"improvement-verify gate ran"* ]]
  # The excerpt comes from the resolver's dropped-line sidecar, so it is
  # daemon-authored text and is attributed as such.
  [[ "$rationale" == *"Dropped daemon-authored excerpt"* ]]
  [[ "$rationale" == *"checkpoint tool_use progress"* ]]
  # Bounded: an excerpt, never the whole region.
  [ "${#rationale}" -lt 800 ]
}

@test "T11 every row records the gate that ran, never no-model-call" {
  # An INVARIANT over the rows this emitter writes, not a property of one
  # fixture: the arbiter verdict is in the model-required set, so a row whose
  # plan line claims otherwise is two processes disagreeing rather than a
  # deterministic landing. Both plan-line values are driven for that reason —
  # the row reads the same either way, and the disagreeing one says so aloud.
  for needs_llm in True False; do
    write_tsv ga-rec-probe.md "${DROPPED_TEXT}" "${needs_llm}"
    printf 'agents/ga-rec-probe.md\n' >"${LEDGER}"
    run run_driver
    [ "$status" -eq 0 ] || return 1
    driver_out="${output}"

    run envelope_field haiku_status
    [ "$output" = "verified:improvement-gate" ] || return 1
    # Apply-ineligibility is unconditional: the provenance token may never
    # satisfy a LIKE 'ok%' gate.
    [[ "$output" != ok* ]] || return 1

    rationale="$(envelope_field rationale)"
    [[ "$rationale" != *"no model call"* ]] || return 1
    [[ "$rationale" == *"improvement-verify gate ran"* ]] || return 1
    [[ "$rationale" == *"judged by the arbiter"* ]] || return 1
    [[ "$rationale" == *"2 gap(s)"* ]] || return 1

    if [ "${needs_llm}" = "False" ]; then
      [[ "${driver_out}" == *"disagrees with the resolver"* ]] || return 1
    fi
  done
}

@test "T8 without the resolver sidecar the excerpt falls back to the diff and says so" {
  # An older resolver (or an unreadable sidecar) still records — but a removed
  # diff line may be vendor prose the release restructured, so the rationale must
  # NOT claim the excerpt is daemon-authored.
  write_tsv ga-rec-probe.md "${WORK}/absent.dropped"
  run run_driver
  [ "$status" -eq 0 ]
  rationale="$(envelope_field rationale)"
  [[ "$rationale" == *"Excerpt of lines the candidate drops"* ]]
  [[ "$rationale" != *"Dropped daemon-authored excerpt"* ]]
  [[ "$rationale" == *"2 gap(s)"* ]]
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
  [[ "$rationale" == *"not applied"* ]] || return 1
  # The screening claim is per OUTCOME, not per label: only a LANDED candidate is one
  # the improvement-verify gate read and passed. An unlanded one was rolled back, so a
  # row asserting a gate verdict for it would credit a screening that never concluded.
  [[ "$rationale" == *"no gate verdict stands behind it"* ]] || return 1
  [[ "$rationale" != *"gate ran over the candidate and passed"* ]] || return 1
}

@test "T9 a multi-row run splits landed per row and stamps both with ONE cycle date" {
  # The landed split is a characterization pin — the pre-hoist per-row ledger read
  # produced the same split. The shared date is the discriminating one: a per-row
  # `date` fork splits one run's rows across two days on a midnight crossing.
  : >"${TSV}"
  local name
  for name in ga-rec-first.md ga-rec-second.md; do
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${name}" "agents/${name}" "${RELEASE}" 2 2 1 "0,3" \
      "${DIFF_FILE}" "${DROPPED_TEXT}" False >>"${TSV}"
  done
  printf 'agents/ga-rec-first.md\n' >"${LEDGER}" # only the first row's transaction landed

  DATE_TICKS="${WORK}/date.ticks" run run_driver
  [ "$status" -eq 0 ]
  [[ "$output" == *"(agents/ga-rec-first.md, landed=1)"* ]]
  [[ "$output" == *"(agents/ga-rec-second.md, landed=0)"* ]]

  [ "$(envelope_field cycle_date 1)" = "$(envelope_field cycle_date 2)" ]
  # One tick == one fork for the whole run, whatever the row count.
  [ "$(wc -l <"${WORK}/date.ticks" | tr -d ' ')" -eq 1 ]
}

# Read the declared roster paths in a contained subshell. A literal list here would
# be a second declaration of the fact the single declaration exists to hold.
roster_paths() {
  bash -c '
    set -Eeuo pipefail
    # shellcheck source=/dev/null
    source "$1"
    spine_get_roster_paths
  ' _ "${GA}/scripts/lib/apply-spine.sh"
}

@test "T12 a landed roster path stamps landed and an unlanded one does not" {
  # The lookup key is the row's target, so a path that is not an agent body resolves
  # by the same rule and at any depth. Both directions ride one run: a probe phrased
  # only as "this does not stamp landed" is satisfied by a fixture that matches
  # nothing at all.
  # The landed side must be NESTED: a top-level path's basename equals its path, so
  # it cannot tell the two key forms apart and would stamp landed either way.
  # Every assertion is gated `|| return 1`: this bats version fails a test only on
  # the LAST command's status, so a bare mid-body test would be silently ignored.
  local landed_rel unlanded_rel
  landed_rel="$(roster_paths | grep / | sed -n 1p)"
  unlanded_rel="$(roster_paths | grep -v -F -x "${landed_rel}" | sed -n 1p)"
  [ -n "${landed_rel}" ] || return 1
  [ -n "${unlanded_rel}" ] || return 1

  : >"${TSV}"
  local rel
  for rel in "${landed_rel}" "${unlanded_rel}"; do
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${rel##*/}" "${rel}" "${RELEASE}" 2 2 1 "0,3" \
      "${DIFF_FILE}" "${DROPPED_TEXT}" False >>"${TSV}"
  done
  printf '%s\n' "${landed_rel}" >"${LEDGER}"

  run run_driver
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"(${landed_rel}, landed=1)"* ]] || return 1
  [[ "$output" == *"(${unlanded_rel}, landed=0)"* ]] || return 1
}

@test "T10 an empty or absent ledger path records rejected and still returns 0" {
  # The guard's not-taken branch. Neither shape may abort: the emitter runs after
  # the merge landed and before the base-content capture, so an abort here strands
  # the merge at the old base.
  write_tsv
  LEDGER="" run run_driver
  [ "$status" -eq 0 ]
  [ "$(envelope_field status)" = "rejected" ]

  LEDGER="${WORK}/never-written.ledger" run run_driver
  [ "$status" -eq 0 ]
  [ "$(envelope_field status)" = "rejected" ]
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
  printf 'agents/%s\n' "${target}" >"${LEDGER}"
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]
  [[ "$output" == *"resolved-gap discard recorded"* ]]

  row="$(psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc \
    "SELECT approval_tier || '|' || status || '|' || haiku_status || '|' || cost_guard_state
       FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-arbiter-resolved'
        AND target_file = 'agents/${target}'")"
  # This runs against the PRODUCTION database, and pattern_label is the one real rows
  # carry — the pid-unique target is the ONLY thing separating this cleanup from live
  # accountability records. Never widen the predicate to the label alone.
  psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -qc \
    "DELETE FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-arbiter-resolved'
        AND target_file = 'agents/${target}'" >/dev/null

  [ "${row}" = "auto|applied|verified:improvement-gate|ok" ]
}

@test "T3 the same file resolved twice on one day lands ONE row that tracks the LAST outcome" {
  db_available || skip "postgres unavailable"
  [[ -f "${PG_HELPER}" ]] || skip "dual-write helper missing"
  python3 -c 'import psycopg' 2>/dev/null || skip "psycopg unavailable"

  target="ga-rec-upsert-$$.md"
  write_tsv "${target}"

  # Both re-runs carry a DIFFERENT ledger state, so the row's status has to
  # transition: upserting twice from one state pins the row count alone and can
  # never observe a preserved-terminal clobber. The row is one per body per day,
  # so a same-day decline-then-accept is a legitimate operator sequence — and the
  # accept must not keep reading rejected on content that landed.
  status_now() {
    psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc \
      "SELECT status FROM core.autoagent_proposals
        WHERE pattern_label = 'editable-region-arbiter-resolved'
          AND target_file = 'agents/${target}'"
  }

  : >"${LEDGER}" # declined at the confirm gate → nothing landed
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]
  first="$(status_now)"

  printf 'agents/%s\n' "${target}" >"${LEDGER}" # same-day re-run, accepted
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]
  second="$(status_now)"

  : >"${LEDGER}" # and a later same-day decline: the reverse direction
  ATRIUM_UPDATE_PG_HELPER="${PG_HELPER}" run run_driver
  [ "$status" -eq 0 ]
  third="$(status_now)"

  count="$(psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -tAc \
    "SELECT count(*) FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-arbiter-resolved'
        AND target_file = 'agents/${target}'")"
  # Same production-database caveat as T2: the pid-unique target is the whole guard.
  psql -d "${ATRIUM_UPDATE_DB_NAME:-glass_atrium}" -qc \
    "DELETE FROM core.autoagent_proposals
      WHERE pattern_label = 'editable-region-arbiter-resolved'
        AND target_file = 'agents/${target}'" >/dev/null

  [ "${count}" = "1" ]
  [ "${first}" = "rejected" ]
  [ "${second}" = "applied" ]
  [ "${third}" = "rejected" ]
}
