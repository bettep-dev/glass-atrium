#!/usr/bin/env bats
# pg-detect-connect-deadline.bats — falsifiable coverage for the connect-deadline fix (the "blank work box hang after
# Resolving PostgreSQL"), split into its two fixes:
#
#   Bounded connect deadline (PRIMARY/durable): every psql detect connect is bounded by a PGCONNECT_TIMEOUT
#     deadline exported at the top of each detect/wait function (local -x → reaches the $(...)
#     psql child, auto-unsets on return). Covers all SIX known connect sites via the four
#     function-level exports: ga_detect_postgres (SELECT 1), ga_detect_postgres_role (rolname
#     query + SELECT-1 re-probe), ga_detect_postgres_utc (SELECT 1 + SET timezone), and
#     ga_pg_wait_ready (SELECT-1 fallback). An UNTIMED libpq connect on a starting/half-dead
#     cluster blocks unbounded → the render-loop hang. The behavioral tests model libpq
#     FAITHFULLY: a psql stub blocks for PGCONNECT_TIMEOUT seconds on a connect (unset ⇒
#     effectively unbounded), so the fix's export is exactly what turns an unbounded block into
#     a bounded one — fail-before (killed at the ceiling) / pass-after (self-completes bounded).
#
#   Per-detect idle brackets (COSMETIC): each blocking pg detect substitution in _run_dependency_preflight_boxed
#     runs inside its OWN start_idle_spinner…stop_idle_spinner bracket (per-detect, never one pair
#     spanning the cluster — the framed panel steps self-paint the same body row and would fight a
#     cluster-wide idle child). Static-scan of the launcher.
#
# Run via: bats test/pg-detect-connect-deadline.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Machine-safe: no real psql/postgres/launchd. The behavioral tests PATH-stub psql and run the
# detect in a throwaway `bash -c` (a fresh shell → no stale command hash) under the repo's
# background+poll+kill hang guard (mirrors deps-preflight-noninteractive.bats:30/795/1002 —
# NOT macOS-absent `timeout`). The idle-bracket assertions are STATIC (awk/grep the launcher text).

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
DEPS_SH="${GA}/lib/ga-deps.sh"
LAUNCHER="${GA}/glass-atrium"

setup() {
  [[ -f "${DEPS_SH}" ]] || skip "lib not found: ${DEPS_SH}"
  [[ -f "${LAUNCHER}" ]] || skip "launcher not found: ${LAUNCHER}"
  # the lib is not strict-mode, but suspend any inherited ERR trap defensively.
  trap - ERR
  # shellcheck source=/dev/null
  source "${DEPS_SH}"
  SANDBOX="$(mktemp -d -t ga-conn-deadline.XXXXXX)"
}

teardown() {
  # best-effort reap of any stub psql/sleep a fail-before revert-check might have orphaned
  # (the green suite never reaches the kill path — the fixed code self-completes bounded).
  [[ -n "${SANDBOX:-}" ]] && pkill -f "${SANDBOX}" 2>/dev/null || true
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# mk_slow_psql — write a PATH psql stub that FAITHFULLY models libpq's connect timeout: --version
# answers instantly (so the >=14 floor is passed), but any CONNECT probe blocks for
# PGCONNECT_TIMEOUT seconds then FAILS. Unset PGCONNECT_TIMEOUT ⇒ effectively unbounded (30s),
# reproducing the original untimed-connect hang; the fix exports 2 ⇒ a ~2s bounded abandon.
mk_slow_psql() {
  local stub="$1"
  mkdir -p "${stub}"
  cat >"${stub}/psql" <<'PSQL'
#!/bin/bash
if [[ "$1" == "--version" ]]; then
  printf 'psql (PostgreSQL) 16.1\n'
  exit 0
fi
sleep "${PGCONNECT_TIMEOUT:-30}"
exit 1
PSQL
  chmod +x "${stub}/psql"
}

# run_bounded — run `bash -c "$1"` in the BACKGROUND (fresh shell, no stale command hash), poll
# for self-completion under a $2-second integer ceiling. Sets BOUNDED=1 when the command
# self-completed inside the ceiling, 0 when it had to be killed (the unbounded-block proof);
# DETECT_OUT = captured stdout. The repo background+poll+kill idiom — no macOS-absent `timeout`.
run_bounded() {
  local script="$1" ceiling="$2"
  local out="${SANDBOX}/detect.out"
  : >"${out}"
  bash -c "${script}" >"${out}" 2>/dev/null &
  local pid=$! waited=0
  while kill -0 "${pid}" 2>/dev/null && [[ "${waited}" -lt "${ceiling}" ]]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "${pid}" 2>/dev/null; then
    BOUNDED=0
    kill "${pid}" 2>/dev/null || true
  else
    BOUNDED=1
  fi
  wait "${pid}" 2>/dev/null || true
  DETECT_OUT="$(cat "${out}")"
}

# === Bounded connect deadline (behavioral, fail-before/pass-after) =============

@test "connect-deadline(behavioral): ga_detect_postgres abandons a hung connect within the deadline (not unbounded)" {
  local stub="${SANDBOX}/bin"
  mk_slow_psql "${stub}"
  # unset ambient PGCONNECT_TIMEOUT so the ONLY deadline the stub can see is the fn's own export —
  # that makes the assertion genuinely falsifiable (revert the export ⇒ unbounded ⇒ killed here).
  run_bounded "PATH='${stub}:${PATH}'; unset PGCONNECT_TIMEOUT; source '${DEPS_SH}'; PG_SOCKET=/tmp ga_detect_postgres" 5
  [[ "${BOUNDED}" -eq 1 ]]                     # self-completed inside the ceiling (fail-before: killed)
  [[ "${DETECT_OUT}" == "present-but-down" ]]  # returned the down verdict, never blocked unbounded
}

@test "connect-deadline(behavioral): ga_detect_postgres_role bounds the FIRST role-path connect (site 308) too" {
  local stub="${SANDBOX}/bin"
  mk_slow_psql "${stub}"
  # role path opens TWO connects (rolname query @308 then the SELECT-1 re-probe @314); if 308 were
  # untimed it would block before 314 is ever reached. Both bounded ⇒ ~2s each, well under the ceiling.
  run_bounded "PATH='${stub}:${PATH}'; unset PGCONNECT_TIMEOUT; source '${DEPS_SH}'; PG_SOCKET=/tmp ga_detect_postgres_role" 8
  [[ "${BOUNDED}" -eq 1 ]]
  [[ "${DETECT_OUT}" == "present-but-down" ]]
}

@test "connect-deadline(no-regression): a healthy-fast cluster still reads 'present' (the bound is connect-phase only)" {
  local stub="${SANDBOX}/bin"
  mkdir -p "${stub}"
  # psql answers every probe instantly (SELECT 1 exit 0) → the ~2s connect bound is never spent.
  cat >"${stub}/psql" <<'PSQL'
#!/bin/bash
if [[ "$1" == "--version" ]]; then
  printf 'psql (PostgreSQL) 16.1\n'
  exit 0
fi
exit 0
PSQL
  chmod +x "${stub}/psql"
  run env PATH="${stub}:${PATH}" bash -c "source '${DEPS_SH}'; PG_SOCKET=/tmp ga_detect_postgres"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "present" ]]
}

@test "connect-deadline(static): all FOUR pg detect/wait fns export PGCONNECT_TIMEOUT=2 (the 6 connect sites, bounded)" {
  local fn body
  # the four function-level exports cover all six known connect sites at once (each fn's connects
  # inherit the local -x); value is exactly 2 — libpq's effective floor (it silently bumps <2 to 2).
  for fn in ga_detect_postgres ga_detect_postgres_role ga_detect_postgres_utc ga_pg_wait_ready; do
    body="$(declare -f "${fn}")"
    [[ -n "${body}" ]]
    [[ "${body}" == *'local -x PGCONNECT_TIMEOUT=2'* ]]
  done
  # exactly four export lines in the lib — no stray global leak, no over-broad injection.
  run grep -cE '^[[:space:]]*local -x PGCONNECT_TIMEOUT=2$' "${DEPS_SH}"
  [[ "${output}" -eq 4 ]]
}

# === Per-detect idle brackets across the boxed detect cluster (static) =========

@test "idle-bracket(static): each pg detect substitution runs inside its OWN idle bracket (no blank-body window)" {
  local boxed
  boxed="$(awk '/^_run_dependency_preflight_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${boxed}" ]]
  # verdicts are captured via SEPARATED declare/assign (SC2155-safe), never combined into one line.
  [[ "${boxed}" == *'local pg_verdict'* ]]
  [[ "${boxed}" == *'pg_verdict="$(ga_detect_postgres)"'* ]]
  [[ "${boxed}" == *'local pg_role_verdict'* ]]
  [[ "${boxed}" == *'pg_role_verdict="$(ga_detect_postgres_role)"'* ]]
  [[ "${boxed}" != *'local pg_verdict="$(ga_detect_postgres)"'* ]]
  [[ "${boxed}" != *'local pg_role_verdict="$(ga_detect_postgres_role)"'* ]]
  # walk the body: every BLOCKING pg detect substitution MUST run while an idle spinner is active
  # (idle==1). An un-bracketed detect (idle==0) is exactly the blank-body symptom this fix removes.
  run awk '
    /start_idle_spinner/            { idle = 1 }
    /stop_idle_spinner/             { idle = 0 }
    /\$\(ga_detect_postgres\)/      { if (idle != 1) bad++ }
    /\$\(ga_detect_postgres_role\)/ { if (idle != 1) bad++ }
    END { print bad + 0 }
  ' <<<"${boxed}"
  [[ "${output}" -eq 0 ]]
}

@test "idle-bracket(static): no single idle bracket spans a self-painting panel step (per-detect, not cluster-wide)" {
  local boxed
  boxed="$(awk '/^_run_dependency_preflight_boxed\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${LAUNCHER}" "${GA}"/lib/ga-tui-*.sh)"
  [[ -n "${boxed}" ]]
  # a framed panel step painting the SAME body row while an idle child animates it = the fight the
  # per-detect bracketing avoids. Assert ZERO panel steps run inside an open idle bracket.
  run awk '
    /start_idle_spinner/           { idle = 1 }
    /preflight_panel_step_or_bail/ { if (idle == 1) span++ }
    /stop_idle_spinner/            { idle = 0 }
    END { print span + 0 }
  ' <<<"${boxed}"
  [[ "${output}" -eq 0 ]]
}

# === pg_utc_guard failure bail across the boxed path (behavioral) ==============

# The boxed path CAPTURES the guard rc (`preflight_pg_utc_guard || pg_guard_rc=$?`) and then CONSUMES
# it (`[[ "${pg_guard_rc}" -eq 0 ]] || return "${pg_guard_rc}"`). Those are two separate contracts and
# only the first is pinned elsewhere: deps-preflight-noninteractive.bats pins the CAPTURE, and the
# exec harness D4 block drives preflight_pg_utc_guard DIRECTLY (rc=1), never through the boxed path.
# So the CONSUMPTION is pinned here and nowhere else. Losing it means a failed guard — the D4
# unmanaged-orphan loud-fail — is captured into pg_guard_rc and then silently ignored, and the boxed
# preflight goes on installing against the very cluster the guard just refused to trust.
#
# DRIVEN, not grep'd: a static text pin passes on a semantically equivalent rewrite and reds on a
# behaviour-preserving one, which is exactly how the case this replaces went vacuous. This sources the
# launcher as a library (the main-guard skips main — the deps-preflight-exec-harness.sh idiom), stubs
# ONLY the scaffolding needed to reach the guard, and asserts the OBSERVED return code plus the
# absence of any install step past the failure. It asserts NO ordering: swapping the stop past the
# bail leaves it green, because the ordering claim is genuinely unfalsifiable at this seam.

@test "pg-guard-bail(behavioral): a FAILED pg_utc_guard aborts the boxed preflight with the guard's own rc" {
  local driver="${SANDBOX}/guard-bail.sh"
  cat >"${driver}" <<'DRV'
#!/bin/bash
# shellcheck source=/dev/null
source "$1"
# match run_gate_quiet's runtime: the real preflight executes with -e off and no ERR trap.
set +e
trap - ERR EXIT INT TERM

REC=""
_r() { REC="${REC} $1"; }

# --- scaffolding ONLY (inert), so the sole LIVE code on the path is the guard bail ---
preflight_count_and_gate() {
  STEP_TOTAL=1
  PREFLIGHT_GROUP1_RUNNABLE=1
  PREFLIGHT_GROUP2_RUNNABLE=0
}
ga_detect_xcode_clt() { printf 'present\n'; }
preflight_has_auto_work() { printf 'yes\n'; }
preflight_bracket() { "$@"; }
preflight_grouped_consent() { return 0; }
ga_detect_homebrew() { printf 'present\n'; }
ga_cmd_brew_batch() { return 0; } # empty command => the brew batch panel step is skipped
enter_run_state() { :; }
build_run_bar() { :; }
start_idle_spinner() { :; }
stop_idle_spinner() { :; }
preflight_keg_path_inject() { :; }
preflight_keg_path_inject_pg() { :; }
redraw_frame_inplace() { :; }
draw_workbox() { :; }
c() { printf '%s' "${2:-}"; }
tp() { :; }
tty_line() { :; }
tty_out() { :; }
preflight_line() { :; }
preflight_out() { :; }
TTY="/dev/null"
PREFLIGHT_TTY_OWNED="false"
PREFLIGHT_SUMMARY="scripted-auto-work"

# --- the failure under test: a guard that loud-fails with a DISTINCTIVE rc ---
# 42, not 1: a regression that bails on a FLATTENED code (`return 1`) instead of propagating the
# guard's own rc is caught here too, which a 1 would silently pass.
preflight_pg_utc_guard() { return 42; }
# every framed install step past the guard records itself — on a live bail there are ZERO of them.
# Recorded from a DIRECT call, never a $(...) substitution, so the write survives to the parent.
preflight_panel_step_or_bail() {
  _r "step:$1"
  return 0
}

rc=0
_run_dependency_preflight_boxed </dev/null >/dev/null 2>&1 || rc=$?
printf 'rc=%s\n' "${rc}"
printf 'past_guard_steps=%s\n' "$(printf '%s' "${REC}" | tr ' ' '\n' | grep -c '^step:' || true)"
DRV
  run bash "${driver}" "${LAUNCHER}"
  [[ "${status}" -eq 0 ]]
  local rc_observed steps_past
  rc_observed="$(awk -F= '/^rc=/{print $2}' <<<"${output}")"
  steps_past="$(awk -F= '/^past_guard_steps=/{print $2}' <<<"${output}")"
  # surface the observed pair on a red: bats attributes the failing line imprecisely across the
  # embedded heredoc, so the numbers themselves are what make the failure readable.
  echo "observed: rc=${rc_observed} past_guard_steps=${steps_past} (want rc=42 steps=0)"
  # the guard's OWN rc reaches the caller, and nothing installed past the failure.
  [[ "${rc_observed}" -eq 42 ]] && [[ "${steps_past}" -eq 0 ]]
}
