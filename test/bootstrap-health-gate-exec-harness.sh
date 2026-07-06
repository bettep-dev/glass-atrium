#!/usr/bin/env bash
# bootstrap-health-gate-exec-harness.sh — HEADLESS EXECUTION harness for the monitor
# bootstrap health gate DB-field fix (STEP 5/6). Sources ./glass-atrium as a library, then
# drives the REAL bootstrap_health_gate against a one-shot python HTTP responder (stood up
# via a `node` PATH stub that exec's the responder, so the gate's own
# `node dist/server/main.js` background start becomes our controllable listener). Proves:
#   (probe) the per-request curl is bounded by --connect-timeout/--max-time against an
#           accept-then-never-reply socket (returns within the max-time, no wedge).
#   (ii)    a 200 {"db":"closed"} monitor => the DB-field gate LOUD-FAILS with the distinct
#           "db is not open" message and exits BOOTSTRAP_EXIT_HEALTH (21) — an http-200-only
#           gate would have FALSE-PASSED it.
#   (iii)   a 200 {"db":"open"} monitor => the gate PASSES (return 0) — the db-field gate does
#           not falsely fail a healthy monitor (positive control).
#
# NOTHING system-level is mutated: no real node/monitor/DB, only a throwaway python socket on a
# free localhost port, killed by the gate itself (kill, never launchctl).
#
# ShellCheck note: BOOTSTRAP_EXIT_HEALTH is assigned by the sourced launcher (SC2154 false-positive);
# SC2312 return-masking sits only in display-only command subs.
# shellcheck disable=SC2154,SC2312
set -uo pipefail

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GA_DIR_ROOT="$(cd -- "${HARNESS_DIR}/.." && pwd)"

# shellcheck source=/dev/null
source "${GA_DIR_ROOT}/glass-atrium"
set +e
trap - ERR EXIT INT TERM

FAILS=0
PASSES=0
SKIPS=0
pass() {
  PASSES=$((PASSES + 1))
  printf '    PASS  %s\n' "$1"
}
fail() {
  FAILS=$((FAILS + 1))
  printf '    FAIL  %s\n' "$1"
}
# unmet precondition (gate's port already held by an EXTERNAL listener, e.g. a live
# launchd monitor): the D-ii/D-iii assertions need the port free to run the REAL gate.
# Not a failure — report + keep exit 0, mirroring the bats skip-on-precondition idiom.
skip() {
  SKIPS=$((SKIPS + 1))
  printf '    SKIP  %s\n' "$1"
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ga-gate.XXXXXX")"
cleanup_all() {
  [[ -n "${NEVER_PID:-}" ]] && kill "${NEVER_PID}" 2>/dev/null
  rm -rf "${WORK}"
}
trap cleanup_all EXIT

# === the HTTP responder (modes: dbclosed | dbopen) ====================================
cat >"${WORK}/responder.py" <<'PY'
import sys, http.server
port = int(sys.argv[1]); mode = sys.argv[2]
BODY = b'{"db":"closed","ok":true}' if mode == "dbclosed" else b'{"db":"open","ok":true}'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PY

# === the accept-then-never-reply socket (for the direct probe bound) ==================
cat >"${WORK}/never.py" <<'PY'
import sys, socket
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(8)
conns = []
while True:
    c, _ = s.accept()  # accept, keep open, NEVER reply — the wedge the --max-time bound must cut
    conns.append(c)
PY

# === node stub that exec's the responder (becomes the gate's monitor listener) ========
make_node_stub() { # $1=port $2=mode  -> echoes the stub dir
  local d="${WORK}/nodebin.$2"
  mkdir -p "${d}"
  cat >"${d}/node" <<EOF
#!/usr/bin/env bash
# ignore the "dist/server/main.js" arg; BE the monitor listener on the gate's port.
exec python3 "${WORK}/responder.py" "$1" "$2"
EOF
  chmod +x "${d}/node"
  printf '%s' "${d}"
}

# Mirror the gate's own port derivation (lib/ga-db.sh): ${GA_ROOT}/monitor/.env
# ATRIUM_MONITOR_PORT else 7842, so this precondition check targets the port the gate
# will actually bind (incl. a CI env whose rendered .env pins a different one). GA_ROOT
# is readonly (ga_init_env, source time), so the gate cannot be redirected onto a
# throwaway free port here — an externally-held port is instead an unmet precondition,
# skipped below rather than failed.
GATE_PORT=7842
if [[ -f "${GA_ROOT}/monitor/.env" ]]; then
  gate_env_port="$(grep -E '^ATRIUM_MONITOR_PORT=[0-9]+$' -- "${GA_ROOT}/monitor/.env" | tail -1 | cut -d= -f2)"
  [[ -n "${gate_env_port}" ]] && GATE_PORT="${gate_env_port}"
fi

echo "============================================================================"
echo "(D-probe) per-request curl bound vs an accept-then-never-reply socket"
echo "============================================================================"
NEVER_PORT=17842
python3 "${WORK}/never.py" "${NEVER_PORT}" &
NEVER_PID=$!
sleep 1
t0=$(date +%s)
# the EXACT poll idiom from bootstrap_health_gate (lib/ga-core.sh).
resp="$(curl -s --connect-timeout 2 --max-time 5 -w '\n%{http_code}' \
  "http://127.0.0.1:${NEVER_PORT}/api/health" 2>/dev/null || true)"
t1=$(date +%s)
code="$(printf '%s\n' "${resp}" | tail -n1)"
elapsed=$((t1 - t0))
printf '  curl vs never-reply: elapsed=%ss code=[%s]\n' "${elapsed}" "${code}"
if [[ "${elapsed}" -le 7 ]]; then
  pass "curl returned within the --max-time bound (${elapsed}s <= ~5s+margin) — no wedge"
else
  fail "curl was NOT bounded (${elapsed}s)"
fi
if [[ "${code}" != "200" ]]; then
  pass "never-reply yields a non-200 code ([${code}]) — the poll would continue, not false-pass"
else
  fail "never-reply unexpectedly returned 200"
fi
kill "${NEVER_PID}" 2>/dev/null
NEVER_PID=""

# === helper: run the REAL gate in a subprocess, capture exit + stderr =================
run_gate() { # $1=mode ; sets GATE_RC + GATE_ERR
  local mode="$1" stub
  stub="$(make_node_stub "${GATE_PORT}" "${mode}")"
  local errf="${WORK}/gate.${mode}.err"
  # subshell: the gate's `exit BOOTSTRAP_EXIT_HEALTH` becomes the subshell's exit code.
  (
    set +e
    trap - ERR
    PATH="${stub}:${PATH}"
    bootstrap_health_gate
  ) >"${errf}" 2>&1
  GATE_RC=$?
  GATE_ERR="$(cat "${errf}")"
}

echo ""
echo "============================================================================"
echo "(D-ii) 200 {\"db\":\"closed\"} => loud-fail + exit BOOTSTRAP_EXIT_HEALTH (${BOOTSTRAP_EXIT_HEALTH})"
echo "============================================================================"
if lsof -ti "tcp:${GATE_PORT}" >/dev/null 2>&1; then
  skip ":${GATE_PORT} held by an external listener (live monitor?) — D-ii/D-iii need it free; run in a clean/CI env"
else
  run_gate dbclosed
  printf '  gate rc=%s\n' "${GATE_RC}"
  printf '  gate stderr (tail): %s\n' "$(printf '%s' "${GATE_ERR}" | grep -iE 'FATAL|db is not' | head -2 | tr '\n' '|')"
  if [[ "${GATE_RC}" -eq "${BOOTSTRAP_EXIT_HEALTH}" ]]; then
    pass "gate exited BOOTSTRAP_EXIT_HEALTH (${BOOTSTRAP_EXIT_HEALTH}) on db:closed"
  else
    fail "gate exit was ${GATE_RC}, expected ${BOOTSTRAP_EXIT_HEALTH}"
  fi
  case "${GATE_ERR}" in
    *'db is not "open"'*) pass "loud-fail message names the DB-not-open cause" ;;
    *) fail "missing the distinct 'db is not open' loud-fail message" ;;
  esac
fi

echo ""
echo "============================================================================"
echo "(D-iii) 200 {\"db\":\"open\"} => gate PASSES (return 0) [positive control]"
echo "============================================================================"
# ensure the D-ii listener is fully gone before rebinding the port.
for _ in 1 2 3 4 5; do
  lsof -ti "tcp:${GATE_PORT}" >/dev/null 2>&1 || break
  sleep 1
done
if lsof -ti "tcp:${GATE_PORT}" >/dev/null 2>&1; then
  skip ":${GATE_PORT} held by an external listener (live monitor?) — positive control needs it free; run in a clean/CI env"
else
  run_gate dbopen
  printf '  gate rc=%s\n' "${GATE_RC}"
  if [[ "${GATE_RC}" -eq 0 ]]; then
    pass "gate returned 0 (PASS) on db:open — db-field gate does not falsely fail a healthy monitor"
  else
    printf '  gate stderr (tail): %s\n' "$(printf '%s' "${GATE_ERR}" | tail -4 | tr '\n' '|')"
    fail "gate rc=${GATE_RC}, expected 0 on db:open"
  fi
fi

echo ""
echo "============================================================================"
printf 'HEALTH-GATE HARNESS RESULT: %s passed, %s skipped, %s failed\n' "${PASSES}" "${SKIPS}" "${FAILS}"
echo "============================================================================"
[[ "${FAILS}" -eq 0 ]]
