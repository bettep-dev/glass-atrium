#!/usr/bin/env bash
# pg-report-drop.sh — terminal drop sink for the converted PG reporting channel,
# shared by the unattended daemons that write core.daemon_runs rows
# (daemon-daily-restart.sh, wiki-daily-compile.sh). Sourced, not executable.
#
# The sink is the last channel by design: it never recurses into the PG channel
# that just failed and never aborts its caller, so every write here is
# best-effort. The record format and the rotation ceiling are a durable contract
# (pinned by scripts/test/absorption-conversion.bats) — a single definition keeps
# the two daemons from drifting apart on it.
#
# PG_DROP_TAG identifies the emitting script in both channels; sourcing scripts
# set it BEFORE the source (it is bound here, not at call time).
: "${PG_DROP_TAG:=unknown}"
PG_DROP_LOG="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/pg-report-drops.log"
PG_DROP_LOG_MAX_BYTES=65536

# Caller-facing handler for a failed PG report: the loud stderr channel plus the
# durable record, so a lost first failure cannot fossilize into a silent backlog.
drop_pg_report() {
  local site="${1}" status="${2}"
  echo "[${PG_DROP_TAG}] WARN: PG daemon-run report failed (site=${site}, exit=${status}) — run record not persisted" >&2
  append_pg_drop "${site}" "${status}"
}

append_pg_drop() {
  local site="${1}" status="${2}" dir="${PG_DROP_LOG%/*}" sz="" ts=""
  mkdir -p "${dir}" 2>/dev/null || return 0 # GA-ABSORB[handled@stderr-note-in-caller-branch]: terminal sink; no further channel by design
  if [[ -f "${PG_DROP_LOG}" ]]; then
    sz="$(wc -c <"${PG_DROP_LOG}" 2>/dev/null | tr -cd '0-9' || true)" # GA-ABSORB[handled@stderr-note-in-caller-branch]: terminal sink; no further channel by design
    if [[ -n "${sz}" ]] && [[ "${sz}" -gt "${PG_DROP_LOG_MAX_BYTES}" ]]; then
      rm -f "${PG_DROP_LOG}" 2>/dev/null || true # GA-ABSORB[handled@stderr-note-in-caller-branch]: terminal sink; no further channel by design
    fi
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" # GA-ABSORB[handled@stderr-note-in-caller-branch]: terminal sink; no further channel by design
  printf '%s [%s] PG_REPORT_DROP site=%s exit=%s\n' "${ts}" "${PG_DROP_TAG}" "${site}" "${status}" \
    >>"${PG_DROP_LOG}" 2>/dev/null || true # GA-ABSORB[handled@stderr-note-in-caller-branch]: terminal sink; no further channel by design
}
