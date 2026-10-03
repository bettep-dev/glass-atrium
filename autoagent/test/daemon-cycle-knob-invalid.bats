#!/usr/bin/env bats
# daemon-cycle-knob-invalid.bats — a rejected daemon-config.json tier knob fails the cycle loud
# through the real driver + the real daemon_cycle.py: named rc 9 on the cycle stage line, a FATAL
# line naming the key, no CLI call, and a degraded aggregate exit.
#
# Hermetic: the driver runs from a mktemp copy (its doctor / helper stages resolve to absent paths),
# HOME and the data root are fakes, the CLI is a recording stub, and psycopg is shadowed so even a
# regressed gate cannot reach a live database.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DRIVER="${GA}/autoagent/daemon-cycle.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  [[ -f "${REAL_DRIVER}" ]] || skip "daemon-cycle.sh not found: ${REAL_DRIVER}"
  WORK="$(cd -- "$(mktemp -d -t daemon-cycle-knob-invalid.XXXXXX)" && pwd -P)"
  mkdir -p -- "${WORK}/real/autoagent" "${WORK}/home" "${WORK}/data" "${WORK}/py" "${WORK}/pgsock"
  cp -p -- "${REAL_DRIVER}" "${WORK}/real/autoagent/daemon-cycle.sh"
  # daemon_cycle.py resolves its hooks/lib imports from its realpath, so a symlink runs the real one.
  ln -s -- "${GA}/autoagent/daemon_cycle.py" "${WORK}/real/autoagent/daemon_cycle.py"
  printf 'raise ImportError("psycopg shadowed by daemon-cycle-knob-invalid.bats")\n' \
    >"${WORK}/py/psycopg.py"
  cat >"${WORK}/claude-stub" <<EOF
#!/bin/sh
printf 'called\n' >>"${WORK}/claude-calls"
exit 0
EOF
  chmod +x "${WORK}/claude-stub"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

run_driver_with_config() {
  printf '%s\n' "$1" >"${WORK}/daemon-config.json"
  run env HOME="${WORK}/home" GA_DATA_ROOT="${WORK}/data" \
    DAEMON_CONFIG="${WORK}/daemon-config.json" \
    AUTOAGENT_CLAUDE_BIN="${WORK}/claude-stub" \
    AUTOAGENT_AGENTS_DIR="${WORK}/home/agents" \
    PYTHONPATH="${WORK}/py" PGHOST="${WORK}/pgsock" \
    bash "${WORK}/real/autoagent/daemon-cycle.sh" --cycle-only --dry-run --out "${WORK}/report.json"
}

@test "a rejected tier knob fails the cycle stage with rc 9, a FATAL line and no CLI call" {
  run_driver_with_config '{"worker_model": "claude-sonnet-5", "worker_effort": "ultra"}'
  [[ "${status}" -eq 1 ]] || { echo "${output}"; return 1; }
  grep -qF '[daemon-cycle] stage=cycle rc=9 FAILED' <<<"${output}" || { echo "${output}"; return 1; }
  grep -qF 'FATAL: daemon-config.json worker_effort="ultra"' <<<"${output}" \
    || { echo "${output}"; return 1; }
  [[ ! -e "${WORK}/claude-calls" ]] || { echo "the CLI stub ran"; return 1; }
}
