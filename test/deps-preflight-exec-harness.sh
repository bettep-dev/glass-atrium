#!/usr/bin/env bash
# deps-preflight-exec-harness.sh — HEADLESS STUB EXECUTION harness for the dependency
# preflight fixes. Unlike the bats suite (which proves the fixes with STATIC grep/awk
# assertions on the launcher text), this harness SOURCES ./glass-atrium as a library
# (the main-guard `[[ BASH_SOURCE == $0 ]]` skips main on source) and then OVERRIDES
# every detect / render / interactive / install-command function so it can ACTUALLY
# EXECUTE _run_dependency_preflight_boxed AND _run_dependency_preflight_scroll end to
# end across four machine scenarios — catching functional regressions a structural
# assertion cannot (the earlier round shipped on bats-structure alone and a regression
# slipped through).
#
# Faithful to production: the real preflight runs under `set +e; trap - ERR` (run_gate_quiet
# wraps it — see preflight_bracket's own comment), so this harness runs it identically.
#
# NOTHING real is mutated: every ga_cmd_* builder emits a RECORDER token, every underlying
# tool (brew/pip/claude/psql/createdb/pg_isready/brew-services) is stubbed, confirm_typed
# returns 0 WITHOUT reading, and every render fn is a no-op. Detect probes echo scripted
# per-scenario verdicts. run_step / preflight_panel_step / preflight_count_and_gate /
# ga_pg_wait_ready (in scenario A the wait step is recorded) / the != present role gate /
# the version-agnostic keg-inject remain the REAL code under test.
#
# Exit 0 iff every scenario × path assertion passes.
#
# ShellCheck note: this harness sources a 4500-line library and OVERRIDES its symbols, so several
# checks are inherent false-positives of static analysis against dynamically-sourced code —
#   SC2034 vars (TTY / PREFLIGHT_* / STEP_SUPPRESSED_COUNT) are read by the sourced launcher fns,
#   SC2312 return-masking sits in display-only command subs, SC2016 is a literal stub-script body,
#   SC2329 (sleep) is invoked indirectly by the real ga_pg_wait_ready.
# shellcheck disable=SC2034,SC2312,SC2016,SC2329
set -uo pipefail

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GA_DIR_ROOT="$(cd -- "${HARNESS_DIR}/.." && pwd)"
LAUNCHER="${GA_DIR_ROOT}/glass-atrium"

# --- source the launcher as a library (main skipped by the source-guard) --------------
# shellcheck source=/dev/null
source "${LAUNCHER}"
# match run_gate_quiet's runtime: the preflight executes with -e off + no ERR trap.
set +e
trap - ERR EXIT INT TERM

# === recorder =========================================================================
GA_REC="$(mktemp "${TMPDIR:-/tmp}/ga-exec-rec.XXXXXX")"
_rec() { printf '%s\n' "$1" >>"${GA_REC}"; }
_rec_reset() { : >"${GA_REC}"; }
_rec_dump() { cat "${GA_REC}"; }

FAILS=0
PASSES=0
pass() {
  PASSES=$((PASSES + 1))
  printf '    PASS  %s\n' "$1"
}
fail() {
  FAILS=$((FAILS + 1))
  printf '    FAIL  %s\n' "$1"
}
assert_eq() { # $1=label $2=expected $3=actual
  if [[ "$2" == "$3" ]]; then pass "$1 (= $3)"; else fail "$1 (expected [$2] got [$3])"; fi
}
assert_contains() { # $1=label $2=needle $3=haystack
  case "$3" in
    *"$2"*) pass "$1 (found '$2')" ;;
    *) fail "$1 (missing '$2' in [$3])" ;;
  esac
}
assert_absent() { # $1=label $2=needle $3=haystack
  case "$3" in
    *"$2"*) fail "$1 (unexpected '$2')" ;;
    *) pass "$1 (correctly absent)" ;;
  esac
}

# === scenario state (set by each scenario before invocation) ==========================
SC_MISSING="" # ga_brew_missing_set output (newline list)
SC_HOMEBREW="present"
SC_PG="present"     # ga_detect_postgres verdict
SC_ROLE="present"   # ga_detect_postgres_role verdict
SC_KEG=""           # ga_pg_keg_major (empty => real default @18)
SC_CLAUDE="present" # ga_detect_claude_cli
SC_AUTH="present"   # ga_detect_claude_auth
SC_FAKECHAT="present"
SC_MARKET="yes"     # ga_marketplace_present
SC_PYTHON="present" # ga_detect_python_libs
# R3/R1 defaults for the (A) scenario loop: a non-broken UTC verdict (the guard is a no-op)
# and an already-initialized data dir (the initdb step is skipped), so the four scenarios'
# counter/role assertions stay unchanged. The (D) block below overrides these directly to
# exercise the broken-pg guard + the initdb fires/skips branches.
SC_PG_UTC="down" # ga_detect_postgres_utc: ok|broken|down (down => guard no-op)
SC_PG_INIT="yes" # ga_pg_data_dir_initialized: yes|no (yes => initdb skipped)

# === detect stubs (scripted verdicts) =================================================
ga_detect_xcode_clt() { printf 'present\n'; }
ga_detect_homebrew() { printf '%s\n' "${SC_HOMEBREW}"; }
ga_detect_node() { printf 'present\n'; }
ga_detect_bun() { printf 'present\n'; }
ga_detect_cli_tool() { printf 'present\n'; }
ga_detect_sqlite_fts5() { printf 'present\n'; }
ga_detect_postgres() { printf '%s\n' "${SC_PG}"; }
ga_detect_postgres_role() { printf '%s\n' "${SC_ROLE}"; }
ga_detect_claude_cli() { printf '%s\n' "${SC_CLAUDE}"; }
ga_detect_claude_auth() { printf '%s\n' "${SC_AUTH}"; }
ga_detect_fakechat() { printf '%s\n' "${SC_FAKECHAT}"; }
ga_marketplace_present() { printf '%s\n' "${SC_MARKET}"; }
ga_detect_python_libs() { printf '%s\n' "${SC_PYTHON}"; }
ga_detect_postgres_utc() { printf '%s\n' "${SC_PG_UTC}"; }
ga_pg_data_dir_initialized() { printf '%s\n' "${SC_PG_INIT}"; }
ga_brew_missing_set() {
  [[ -n "${SC_MISSING}" ]] && printf '%s\n' "${SC_MISSING}"
  return 0
}
ga_python_missing_set() { printf 'psycopg\n'; }
ga_pg_keg_major() { printf '%s' "${SC_KEG}"; } # empty => preflight_keg_path_inject_pg defaults to 18

# === install-COMMAND builders → recorder tokens (nothing real runs) ===================
# Emptiness is preserved where the orchestrator branches on it (brew batch / python).
ga_cmd_homebrew_install() { printf 'rec_homebrew_install\n'; }
ga_cmd_brew_batch() {
  [[ -n "${SC_MISSING}" ]] && printf 'rec_brew_batch\n'
  return 0
}
ga_cmd_pg_service_start() { printf 'rec_pg_service\n'; }
ga_cmd_pg_service_restart() { printf 'rec_pg_restart\n'; }
ga_cmd_pg_initdb() { printf 'rec_pg_initdb\n'; }
ga_cmd_pg_create_role() { printf 'rec_pg_create_role\n'; }
ga_cmd_claude_cli_install() { printf 'rec_claude_cli\n'; }
ga_cmd_fakechat_install() { printf 'rec_fakechat_install\n'; }
ga_cmd_marketplace_add() { printf 'rec_marketplace_add\n'; }
ga_cmd_python_libs_user() { printf 'rec_python_user\n'; }
ga_cmd_python_libs_break_system() { printf 'rec_python_break\n'; }

# recorder token functions (executed in-process by run_step "$@") — record + return rc.
rec_homebrew_install() {
  _rec 'homebrew_install'
  return 0
}
rec_brew_batch() {
  _rec 'brew_batch'
  return 0
}
rec_pg_service() {
  _rec 'pg_service'
  return 0
}
rec_pg_initdb() {
  _rec 'pg_initdb'
  return 0
}
# rec_pg_restart models a brew restart that CLEARS the broken state: record the action
# and flip the UTC verdict to 'ok' so the guard's post-restart re-check passes.
rec_pg_restart() {
  _rec 'pg_restart'
  SC_PG_UTC="ok"
  return 0
}
rec_pg_create_role() {
  _rec 'pg_create_role'
  return 0
}
rec_claude_cli() {
  _rec 'claude_cli'
  return 0
}
rec_fakechat_install() {
  _rec 'fakechat_install'
  return 0
}
rec_marketplace_add() {
  _rec 'marketplace_add'
  return 0
}
rec_python_user() {
  _rec 'python_user'
  return 0
}
rec_python_break() {
  _rec 'python_break'
  return 0
}
# the wait step token is a REAL function name (ga_pg_wait_ready) placed in the orchestrator
# literally; in scenario-A flow we record it + return ready (0). The REAL bounded ga_pg_wait_ready
# is exercised separately in the STEP-2 execution block below.
ga_pg_wait_ready() {
  _rec 'pg_wait_ready'
  return 0
}

# === keg-inject capture (drives the real preflight_keg_path_inject_pg default logic) ===
# preflight_keg_path_inject_pg stays REAL (computes major via ga_pg_keg_major, defaults @18);
# only the terminal preflight_keg_path_inject is captured so we see the resolved formula.
preflight_keg_path_inject() {
  _rec "keg_inject:$1"
  return 0
}

# === interactive gates → scripted non-blocking =======================================
confirm_typed() { return 0; } # return 0 WITHOUT reading (no <"${TTY}")
preflight_guide_xcode_clt() { return 0; }
preflight_grouped_consent() { return 0; }
preflight_guide_claude_auth() { return 0; }
preflight_provision_headless_token() { return 0; }
token_already_provisioned() { return 0; }
_preflight_python_break_consent() { return 0; }
preflight_install_fakechat() {
  _rec 'scroll_fakechat'
  return 0
}
preflight_install_python_libs() {
  _rec 'scroll_python'
  return 0
}
# preflight_bracket: run the gate directly, NO alt-screen/stty (those need a real TTY).
preflight_bracket() { "$@"; }

# === render / TTY fns → no-op (nothing blocks, nothing paints) =======================
enter_run_state() { _rec 'enter_run_state'; }
redraw_frame_inplace() { :; }
draw_workbox() { _rec "counter:${STEP_INDEX:-}/${STEP_TOTAL:-}"; } # capture the DISPLAYED clamped counter
build_run_bar() { :; }
build_counter_str() { printf ''; }
build_install_progress_body() { printf ''; }
redraw_install_progress() { :; }
paint_workbox_body_inner() { :; }
start_step_spinner() { :; }
stop_step_spinner() { :; }
classify_step_log() { STEP_SUPPRESSED_COUNT=0; }
_dump_step_log() { :; }
c() { printf '%s' "${2:-}"; }
tp() { :; }
tty_line() { :; }
tty_out() { :; }
preflight_line() { :; }
preflight_out() { :; }
preflight_eval_brew_shellenv() { :; }
preflight_path_prepend() { :; }
preflight_persist_rc_line() { :; }
preflight_release_tty() { :; }

# TTY must be a writable path (run_step install/scroll rows do `>"${TTY}"`); /dev/null sinks them.
TTY="/dev/null"
PREFLIGHT_TTY_OWNED="false"
PREFLIGHT_SUMMARY="scripted-auto-work" # non-empty => preflight_has_auto_work == yes

# === scenario runner ==================================================================
# $1=path fn · returns rc; the recorder holds the observed step + counter + keg sequence.
run_scenario_path() {
  local pathfn="$1" rc=0
  # run_step internally flips `set -e` back ON + re-arms the ERR trap at its end, so reset
  # the ambient state to run_gate_quiet's contract (-e off, no ERR trap) before EACH path.
  set +e
  trap - ERR
  _rec_reset
  STEP_INDEX=""
  STEP_TOTAL=""
  # invoke with stdin closed: ANY stray blocking read would EOF-fail fast, never hang.
  # `|| rc=$?` keeps run_step's re-armed set -e from ABORTING the whole harness on an
  # EXPECTED non-zero path return (the || list is a set -e-exempt context); mirrors the
  # production preflight_run_cmd `|| rc=$?` capture.
  "${pathfn}" </dev/null || rc=$?
  # run_step flips set -e back ON + re-arms the ERR trap at its tail; reset the ambient
  # state to run_gate_quiet's contract (-e off, no ERR trap) before returning to the caller.
  set +e
  trap - ERR
  return "${rc}"
}

# counters_ok — verify the recorded counter:i/N sequence is monotonic, never overflows N,
# and finishes AT N (no stuck N-1/N). Only meaningful for the boxed path (shared counter).
# echoes "OK <total> <finalindex>" or "BAD <reason>".
counters_ok() {
  local rec="$1" total="" prev=0 final=0 line idx tot bad=""
  while IFS= read -r line; do
    case "${line}" in
      counter:*) ;;
      *) continue ;;
    esac
    idx="${line#counter:}"
    tot="${idx#*/}"
    idx="${idx%/*}"
    [[ -z "${idx}" ]] && continue # pre-first-step empty index (should not render)
    total="${tot}"
    if [[ "${idx}" -gt "${tot}" ]]; then bad="overflow ${idx}>${tot}"; fi
    if [[ "${idx}" -lt "${prev}" ]]; then bad="non-monotonic ${idx}<${prev}"; fi
    prev="${idx}"
    final="${idx}"
  done <<<"${rec}"
  if [[ -n "${bad}" ]]; then
    printf 'BAD %s\n' "${bad}"
    return
  fi
  if [[ -z "${total}" ]]; then
    printf 'OK 0 0\n'
    return
  fi # no panel steps (all-present)
  if [[ "${final}" -ne "${total}" ]]; then
    printf 'BAD stuck %s/%s\n' "${final}" "${total}"
    return
  fi
  printf 'OK %s %s\n' "${total}" "${final}"
}

# scenario_assert — shared assertions for one (scenario,path) run.
#   $1=name $2=path-label $3=rc $4=rec $5=expect_role(fires|skips) $6=expect_keg $7=path-kind(boxed|scroll)
scenario_assert() {
  local name="$1" plabel="$2" rc="$3" rec="$4" role="$5" keg="$6" kind="$7"
  printf '  [%s / %s]\n' "${name}" "${plabel}"
  assert_eq "returns 0" "0" "${rc}"
  assert_contains "keg-inject targets resolved major" "keg_inject:${keg}" "${rec}"
  assert_contains "keg-inject node@24 present" "keg_inject:node@24" "${rec}"
  if [[ "${role}" == "fires" ]]; then
    assert_contains "role-create FIRES (role != present)" "pg_create_role" "${rec}"
  else
    assert_absent "role-create SKIPS (role == present)" "pg_create_role" "${rec}"
  fi
  # readiness wait must precede role-create whenever a service start occurred.
  if printf '%s' "${rec}" | grep -q '^pg_service$'; then
    local svc_ln wait_ln role_ln seq
    seq="$(printf '%s' "${rec}" | grep -nE '^(pg_service|pg_wait_ready|pg_create_role)$')"
    svc_ln="$(printf '%s\n' "${seq}" | grep ':pg_service$' | head -1 | cut -d: -f1)"
    wait_ln="$(printf '%s\n' "${seq}" | grep ':pg_wait_ready$' | head -1 | cut -d: -f1)"
    if [[ -n "${wait_ln}" && "${svc_ln}" -lt "${wait_ln}" ]]; then
      pass "readiness wait runs AFTER service start"
    else
      fail "readiness wait ordering (svc=${svc_ln} wait=${wait_ln})"
    fi
    if [[ "${role}" == "fires" ]]; then
      role_ln="$(printf '%s\n' "${seq}" | grep ':pg_create_role$' | head -1 | cut -d: -f1)"
      if [[ -n "${role_ln}" && -n "${wait_ln}" && "${wait_ln}" -lt "${role_ln}" ]]; then
        pass "role-create runs AFTER readiness wait"
      else
        fail "role-after-wait ordering (wait=${wait_ln} role=${role_ln})"
      fi
    fi
  fi
  if [[ "${kind}" == "boxed" ]]; then
    local co
    co="$(counters_ok "${rec}")"
    case "${co}" in
      OK*) pass "counter consistent (no overflow, no stuck N-1/N) [${co}]" ;;
      *) fail "counter ${co}" ;;
    esac
  fi
}

# apply_scenario — set the per-scenario detect verdicts.
apply_scenario() {
  case "$1" in
    S1)
      SC_MISSING="" SC_HOMEBREW="present" SC_PG="present-but-down" SC_ROLE="present-but-down"
      SC_KEG="16" SC_CLAUDE="present" SC_AUTH="present" SC_FAKECHAT="present" SC_MARKET="yes" SC_PYTHON="present"
      ;;
    S2)
      SC_MISSING="postgresql@18
node@24
bun
sqlite" SC_HOMEBREW="absent" SC_PG="present-but-down" SC_ROLE="absent"
      SC_KEG="18" SC_CLAUDE="absent" SC_AUTH="present" SC_FAKECHAT="absent" SC_MARKET="no" SC_PYTHON="absent"
      ;;
    S3)
      SC_MISSING="" SC_HOMEBREW="present" SC_PG="present-but-down" SC_ROLE="absent"
      SC_KEG="14" SC_CLAUDE="present" SC_AUTH="present" SC_FAKECHAT="present" SC_MARKET="yes" SC_PYTHON="present"
      ;;
    S4)
      SC_MISSING="postgresql@18" SC_HOMEBREW="present" SC_PG="present-but-down" SC_ROLE="present-but-down"
      SC_KEG="18" SC_CLAUDE="present" SC_AUTH="present" SC_FAKECHAT="present" SC_MARKET="yes" SC_PYTHON="present"
      ;;
    *)
      printf 'unknown scenario: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

declare -a SCEN_NAMES=(S1 S2 S3 S4)
declare -a SCEN_DESC=(
  "postgres present-but-down + role present-but-down (warm)"
  "fresh bare-Mac all-absent"
  "manual pg-14 cluster (present-but-down + role absent)"
  "postgres absent->installed present-but-down + role present-but-down (current live)"
)
# expected keg formula + role behaviour per scenario.
declare -a SCEN_KEG=("postgresql@16" "postgresql@18" "postgresql@14" "postgresql@18")
declare -a SCEN_ROLE=("fires" "fires" "fires" "fires")

echo "============================================================================"
echo "(A) EXECUTE _run_dependency_preflight_boxed + _run_dependency_preflight_scroll"
echo "============================================================================"
i=0
for s in "${SCEN_NAMES[@]}"; do
  echo ""
  echo ">>> ${s}: ${SCEN_DESC[${i}]}"
  apply_scenario "${s}"

  # --- boxed path ---
  run_scenario_path _run_dependency_preflight_boxed
  rc=$?
  rec_boxed="$(_rec_dump)"
  echo "    observed(boxed): $(printf '%s' "${rec_boxed}" | tr '\n' ' ')"
  scenario_assert "${s}" "boxed" "${rc}" "${rec_boxed}" "${SCEN_ROLE[${i}]}" "${SCEN_KEG[${i}]}" "boxed"

  # --- scroll path ---
  run_scenario_path _run_dependency_preflight_scroll
  rc=$?
  rec_scroll="$(_rec_dump)"
  echo "    observed(scroll): $(printf '%s' "${rec_scroll}" | tr '\n' ' ')"
  scenario_assert "${s}" "scroll" "${rc}" "${rec_scroll}" "${SCEN_ROLE[${i}]}" "${SCEN_KEG[${i}]}" "scroll"

  i=$((i + 1))
done

# === (B) STEP 1 — run_step pins the captured exec's stdin to /dev/null =================
echo ""
echo "============================================================================"
echo "(B) STEP 1 — run_step stdin-pin proof (RENDER_MODE=install)"
echo "============================================================================"
# a step fn that BLOCKS on stdin: under run_step it must EOF-fail fast (rc!=0), never hang.
_stdin_reader_step() {
  local line
  IFS= read -r line || return 7 # EOF => 7 (proves it did not block)
  printf '%s' "${line}"
  return 0
}
set +e
trap - ERR
STEP_INDEX="" STEP_TOTAL=""
t0=$(date +%s)
rc=0
# `|| rc=$?` mirrors production (preflight_run_cmd) and suppresses set -e on run_step's
# EXPECTED non-zero (EOF) return — run_step re-arms set -e internally at its own tail.
RENDER_MODE="install" run_step "stdin-reader" _stdin_reader_step || rc=$?
set +e
trap - ERR
t1=$(date +%s)
elapsed=$((t1 - t0))
printf '  run_step(_stdin_reader_step) rc=%s elapsed=%ss\n' "${rc}" "${elapsed}"
if [[ "${rc}" -ne 0 && "${elapsed}" -lt 3 ]]; then
  pass "run_step captured exec got EOF (rc=${rc}) within ${elapsed}s — no block"
else
  fail "run_step stdin-pin (rc=${rc} elapsed=${elapsed}s — expected fast non-zero)"
fi
# control: a reader fed from a redirected fd (mirrors a real prompt reading <"${TTY}") gets its value.
_control_reader() {
  local line
  IFS= read -r line <"${GA_CTL_TTY}" || return 9
  printf '%s' "${line}"
}
GA_CTL_TTY="$(mktemp "${TMPDIR:-/tmp}/ga-ctl.XXXXXX")"
printf 'typed-value\n' >"${GA_CTL_TTY}"
ctl_out="$(_control_reader)"
ctl_rc=$?
printf '  control reader (reads a DIFFERENT fd) rc=%s out=[%s]\n' "${ctl_rc}" "${ctl_out}"
assert_eq "control: a redirected-fd read still returns its value" "typed-value" "${ctl_out}"
rm -f "${GA_CTL_TTY}"

# === (C) STEP 2 — ga_pg_wait_ready bounded (real function) ============================
echo ""
echo "============================================================================"
echo "(C) STEP 2 — REAL ga_pg_wait_ready bounded readiness poll"
echo "============================================================================"
# re-extract the REAL bounded ga_pg_wait_ready from the lib (the scenario-A recorder stub
# above replaced it; bash function defs do not stack, so unset -f cannot restore it).
eval "$(awk '/^ga_pg_wait_ready\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${GA_DIR_ROOT}/lib/ga-deps.sh")"
STEP2_BIN="$(mktemp -d "${TMPDIR:-/tmp}/ga-step2.XXXXXX")"
# PG_SOCKET is already readonly "/tmp" (set by ga_init_env at source time) — the value we want.
# (i) ready after N failures then success — a pg_isready that fails 3x then succeeds.
printf '#!/usr/bin/env bash\nf="%s/n"; c=$(cat "$f" 2>/dev/null||echo 0); c=$((c+1)); echo "$c">"$f"; [[ "$c" -ge 4 ]] && exit 0; exit 1\n' \
  "${STEP2_BIN}" >"${STEP2_BIN}/pg_isready"
printf '#!/usr/bin/env bash\nexit 1\n' >"${STEP2_BIN}/psql"
chmod +x "${STEP2_BIN}/pg_isready" "${STEP2_BIN}/psql"
: >"${STEP2_BIN}/n"
_orig_sleep_c=1
sleep() { return 0; } # collapse the 1s poll interval to instant
t0=$(date +%s)
PATH="${STEP2_BIN}:${PATH}" ga_pg_wait_ready
rc=$?
t1=$(date +%s)
printf '  ga_pg_wait_ready (ready on 4th probe) rc=%s wall=%ss probes=%s\n' "${rc}" "$((t1 - t0))" "$(cat "${STEP2_BIN}/n")"
assert_eq "returns 0 once the server answers" "0" "${rc}"
# (ii) never ready — must hit the ceiling and return non-zero (no infinite loop).
printf '#!/usr/bin/env bash\nexit 1\n' >"${STEP2_BIN}/pg_isready"
chmod +x "${STEP2_BIN}/pg_isready"
t0=$(date +%s)
PATH="${STEP2_BIN}:${PATH}" ga_pg_wait_ready
rc=$?
t1=$(date +%s)
printf '  ga_pg_wait_ready (never ready) rc=%s wall=%ss\n' "${rc}" "$((t1 - t0))"
if [[ "${rc}" -ne 0 ]]; then
  pass "returns non-zero at the ceiling (bounded, no infinite loop)"
else
  fail "ga_pg_wait_ready did not bound (rc=${rc})"
fi
unset -f sleep
rm -rf "${STEP2_BIN}"

# RESTORE the scenario-flow recorder stub: the (C) block above re-extracted the REAL
# bounded ga_pg_wait_ready, and bash function defs do NOT stack. The (D) block drives the
# full boxed path again — without this re-stub the real 15s poll would fire against a dead
# /tmp socket, return 1, and the panel step would bail (a false D-block failure).
ga_pg_wait_ready() {
  _rec 'pg_wait_ready'
  return 0
}

echo ""
echo "============================================================================"
echo "(D) R1 initdb fallback + R3 foreign/broken-pg UTC guard"
echo "============================================================================"

# --- D1: initdb FIRES on an UNINITIALIZED fresh cluster, ordered BEFORE service-start ---
set +e
trap - ERR
apply_scenario S2 # fresh bare-Mac all-absent (postgresql@18 in the missing-set)
SC_PG_INIT="no"   # data dir uninitialized ("@18 install 중단") => initdb must fire
SC_PG_UTC="down"  # no live server yet => guard is a no-op
run_scenario_path _run_dependency_preflight_boxed
rc=$?
rec_d1="$(_rec_dump)"
echo "    observed(D1): $(printf '%s' "${rec_d1}" | tr '\n' ' ')"
assert_eq "D1 boxed path returns 0" "0" "${rc}"
assert_contains "D1 initdb step FIRES (uninitialized data dir)" "pg_initdb" "${rec_d1}"
# initdb MUST precede the service start (a cluster must exist before it can be started).
init_ln="$(printf '%s' "${rec_d1}" | grep -nE '^pg_initdb$' | head -1 | cut -d: -f1)"
svc_ln="$(printf '%s' "${rec_d1}" | grep -nE '^pg_service$' | head -1 | cut -d: -f1)"
if [[ -n "${init_ln}" && -n "${svc_ln}" && "${init_ln}" -lt "${svc_ln}" ]]; then
  pass "D1 initdb runs BEFORE service start (init=${init_ln} svc=${svc_ln})"
else
  fail "D1 initdb ordering (init=${init_ln} svc=${svc_ln})"
fi

# --- D2: initdb is SKIPPED on an already-initialized cluster ---
set +e
trap - ERR
apply_scenario S2
SC_PG_INIT="yes" # PG_VERSION present => initdb must NOT run
SC_PG_UTC="down"
run_scenario_path _run_dependency_preflight_boxed
rc=$?
rec_d2="$(_rec_dump)"
echo "    observed(D2): $(printf '%s' "${rec_d2}" | tr '\n' ' ')"
assert_eq "D2 boxed path returns 0" "0" "${rc}"
assert_absent "D2 initdb step SKIPPED (initialized data dir)" "pg_initdb" "${rec_d2}"

# --- D3: broken-pg guard SELF-HEALS a brew-managed keg (restart clears the UTC rejection) ---
set +e
trap - ERR
_rec_reset
SC_PG_UTC="broken" # answers SELECT 1 but rejects SET timezone='UTC'
SC_KEG="18"        # brew-managed keg present => guard restarts + re-verifies
preflight_pg_utc_guard
rc=$?
rec_d3="$(_rec_dump)"
echo "    observed(D3): $(printf '%s' "${rec_d3}" | tr '\n' ' ')"
assert_eq "D3 guard returns 0 after a clearing restart" "0" "${rc}"
assert_contains "D3 restart step FIRES (brew-managed keg)" "pg_restart" "${rec_d3}"

# --- D4: broken-pg guard LOUD-FAILS an UNMANAGED orphan (no brew keg to restart) ---
set +e
trap - ERR
_rec_reset
SC_PG_UTC="broken" # broken squatter
SC_KEG=""          # no brew keg => unmanaged orphan => loud-fail, never restart
preflight_pg_utc_guard
rc=$?
rec_d4="$(_rec_dump)"
echo "    observed(D4): $(printf '%s' "${rec_d4}" | tr '\n' ' ')"
assert_eq "D4 guard LOUD-FAILS on an unmanaged orphan" "1" "${rc}"
assert_absent "D4 no restart attempted (no brew keg)" "pg_restart" "${rec_d4}"

echo ""
echo "============================================================================"
printf 'HARNESS RESULT: %s passed, %s failed\n' "${PASSES}" "${FAILS}"
echo "============================================================================"
rm -f "${GA_REC}"
[[ "${FAILS}" -eq 0 ]]
