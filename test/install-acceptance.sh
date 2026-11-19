#!/usr/bin/env bash
# Sandbox acceptance test for the Glass Atrium install refactor.
# Self-contained: seeds its own sandbox, runs install/uninstall, asserts AC1-AC7.
# NEVER touches the real ~/.claude or the real GA config.toml (uses GA_TARGET_HOME
# + GA_CONFIG_TOML overrides pointed at a mktemp sandbox).
# Real-HOME mode: HOME stays the user's, so doctor's read-only checks read the live machine —
# §26 OAuth token-leak check (tmux list-sessions + show-environment -g, launchctl getenv) and
# the monitor liveness GET; names and counts only, value never shown. Doctor's metered
# `claude -p` self-test runs a sandbox stub through GA_AUTH_CLAUDE_BIN, never the real CLI.
# STEP 1-5 run the launcher of a stub GA root (test/lib/remote-run-stub.bash → make_remote_stub_root): its
# lib/ga-remote.sh also sources the shared ga_remote_run shadow, so no remote-access row reads this machine's listener,
# Wi-Fi or launchd, and the result is the same whatever its remote access state.
# STEP 9 alone is a fresh install: the manifest's tree under a temp HOME, its questions answered at a pty, every
# machine-reaching tool a record-only stub — the deps preflight, monitor build, health gate and launchd load stay out.
# assertion-tally harness idiom: ok/no always return 0, so `assert && ok || no` is an exact if-then-else (SC2015,
# SC2310); substitutions inside evidence strings are display-only (SC2312); '\${HOME}' is a literal search (SC2016)
# shellcheck disable=SC2015,SC2016,SC2310,SC2312
set -uo pipefail

# Repo root = parent of this script's test/ dir (portable: no hardcoded $HOME path).
# Physical form: the launcher resolves GA_ROOT with pwd -P, and the -lname counts below match that form.
GA="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Single entry point — install/uninstall both dispatch through `glass-atrium
# <subcommand>` (the in-process engine passthrough), so the same binary drives
# every exec site below; the `install` / `uninstall` subcommand token selects
# the in-process engine path. install.sh is NOT a retired shim — it is the
# ACTIVE one-line bundle bootstrap (curl|bash downloads+extracts the release
# bundle, no .git, then hands off to `glass-atrium install`, the engine this
# test drives directly). uninstall.sh IS retired; `glass-atrium uninstall` now
# owns its former path.
RENDER_ENV="${GA}/scripts/render-monitor-env.sh"
REAL_CLAUDE="${HOME}/.claude"
REAL_CONFIG="${GA}/config.toml"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/tracked-paths.sh
source "${GA}/scripts/lib/tracked-paths.sh"
# shellcheck source-path=SCRIPTDIR source=lib/remote-run-stub.bash
source "${GA}/test/lib/remote-run-stub.bash"

PASS=0
FAIL=0
ok() {
  printf '  PASS: %s\n' "$1"
  PASS=$((PASS + 1))
}
no() {
  printf '  FAIL: %s\n' "$1"
  FAIL=$((FAIL + 1))
}
hdr() { printf '\n===== %s =====\n' "$1"; }

# Count manifest files[] entries absent from the git index of repo root $1.
untracked_listed_count() {
  local root="$1"
  LC_ALL=C comm -23 \
    <(jq -r '.files[]' "${root}/manifest.json" | LC_ALL=C sort) \
    <(ga_get_tracked_paths "${root}") | wc -l | tr -d ' '
}

# create_claude_stub — a `claude` stand-in at $1 that appends each call's argv as one line to $2 and answers OK;
# `mcp add|remove --scope user <name> [-- <command> <arg>]` edits the file the host's command edits
# (<CLAUDE_CONFIG_DIR or HOME>/.claude.json) with the keys it leaves on every stdio server: type, command, args, env
create_claude_stub() {
  cat >"$1" <<SH
#!/bin/bash
printf '%s\n' "\$*" >>'$2'
if [[ "\$1" == mcp ]]; then
  file="\${CLAUDE_CONFIG_DIR:-\${HOME}}/.claude.json"
  [[ -f "\${file}" ]] || printf '{}\n' >"\${file}"
  case "\$2" in
    add) jq --arg n "\$5" --arg c "\$7" --arg a "\$8" '.mcpServers[\$n] = {type: "stdio", command: \$c, args: [\$a], env: {}}' "\${file}" >"\${file}.t" ;;
    *) jq --arg n "\$5" 'del(.mcpServers[\$n])' "\${file}" >"\${file}.t" ;;
  esac
  mv "\${file}.t" "\${file}"
fi
echo OK
SH
  chmod +x "$1"
}

# create_record_stubs — in dir $1, a record-only stand-in for each tool a fresh install or uninstall can reach the
# machine with (launchd, tmux, process lookup and signal, postgres, the monitor's HTTP, keychain): argv to $2, rc 1
# = not loaded · no owner · refused, so no live job, session, pid, database or port is reached
create_record_stubs() {
  local tool
  for tool in launchctl tmux lsof pgrep pkill psql dropdb createdb pg_isready curl security osascript open; do
    printf '#!/bin/bash\nprintf "%%s %%s\\n" %s "$*" >>"%s"\nexit 1\n' "${tool}" "$2" >"$1/${tool}"
    chmod +x "$1/${tool}"
  done
}

# put_install_tree <repo root> <dest> — the manifest's files[] plus manifest.json, modes kept: the release bundle's
# members, laid out as install.sh extracts them at ~/.glass-atrium
put_install_tree() {
  mkdir -p "$2"
  { jq -r '.files[]' "$1/manifest.json" && printf 'manifest.json\n'; } >"${SANDBOX}/fresh-members.txt"
  (cd -- "$1" && tar -cf - -T "${SANDBOX}/fresh-members.txt") | tar -xpf - -C "$2"
}

# the pty behind run_fresh: stdin, stdout and stderr all a terminal, so the install asks its [y/N] questions; the
# answers are typed before any prompt (a terminal holds typed lines), the transcript is copied out, rc = the child's
PTY_DRIVER="$(
  cat <<'PY'
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
os.write(fd, sys.argv[1].encode())
while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk.replace(b"\r\n", b"\n"))
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
PY
)"

# run_fresh <answers> <launcher args…> — the fresh tree's launcher at a pty, env scrubbed to HOME = the fresh home,
# the record stubs first on PATH, the DB bootstrap gated off and the postgres socket dir in the sandbox
run_fresh() {
  local answers="$1"
  shift
  python3 -c "${PTY_DRIVER}" "${answers}" env -i HOME="${FRESH_HOME}" PATH="${FRESH_STUBS}:${PATH}" \
    USER="${USER}" LOGNAME="${LOGNAME:-${USER}}" TMPDIR="${TMPDIR:-/tmp}" TERM=dumb LANG=en_US.UTF-8 \
    GA_SKIP_DB_SETUP=1 GA_PG_SOCKET="${SANDBOX}/fresh-pg" GA_AUTH_CLAUDE_BIN="${FRESH_STUBS}/claude" \
    DOCTOR_AUTH_REPORTS_DIR="${SANDBOX}/empty-reports" "${FRESH_HOME}/.glass-atrium/glass-atrium" "$@"
}

# get_preview_entry <log> <profile file> → the "<name>\t<entry JSON>" the install's preview printed for that file
get_preview_entry() {
  sed -n "s|^.*${2}: mcpServers\.\([^ ]*\) = \({.*}\) (add;.*$|\1	\2|p" "$1" | head -1
}

# get_mcp_allow_lines <settings.json> → its mcp__ allow lines, sorted
get_mcp_allow_lines() {
  jq -r '.permissions.allow[]? | select(startswith("mcp__"))' "$1" 2>/dev/null | LC_ALL=C sort
}

# is_stub_reached — 0 iff the stub argv log $1 records a `claude -p` call
is_stub_reached() {
  grep -q '^-p ' "$1" 2>/dev/null
}

# --- safety guard snapshot ----------------------------------------------------
# leak detection (STEP 8) is content-hash + marker-anchored GA-artifact scoped:
# a whole-dir mtime compare on ~/.claude false-fails whenever the live harness
# rewrites a direct child (scheduled_tasks.lock etc.) during the run.
REAL_SETTINGS_HASH_BEFORE="$(shasum "${REAL_CLAUDE}/settings.json" 2>/dev/null | awk '{print $1}' || echo MISSING)"
REAL_CONFIG_HASH_BEFORE="$(shasum "${REAL_CONFIG}" 2>/dev/null | awk '{print $1}' || echo MISSING)"
# The base@install anchor is the one install-written path GA_TARGET_HOME does NOT
# redirect (spine_baseline_dir keys on ATRIUM_UPDATE_STATE_DIR), so it needs its own
# before/after guard — STEP 8's symlink+backup scan cannot see a rewrite of it.
REAL_BASELINE="${HOME}/.claude/data/update/baseline-manifest.json"
REAL_BASELINE_HASH_BEFORE="$(shasum "${REAL_BASELINE}" 2>/dev/null | awk '{print $1}' || echo MISSING)"

# --- sandbox setup ------------------------------------------------------------
SANDBOX="$(mktemp -d -t ga-accept.XXXXXX)"
TARGET="${SANDBOX}/.claude"
CONFIG_OUT="${SANDBOX}/config.toml"
mkdir -p "${TARGET}"
# leak-scan time anchor — STEP 8 flags only GA artifacts CREATED after this
START_MARKER="${SANDBOX}/.start-marker"
touch "${START_MARKER}"
export GA_TARGET_HOME="${TARGET}"
export GA_CONFIG_TOML="${CONFIG_OUT}"
# hermetic sandbox — DB bootstrap touches machine-global PostgreSQL, never run here
export GA_SKIP_DB_SETUP=1
# hermetic sandbox — rendered plists land here, never in the real repo's rendered/
export GA_PLIST_OUT="${SANDBOX}/launchd-plists"
# hermetic sandbox — run_install captures the base@install baseline anchor + seeds the
# base-agents content store into spine_baseline_dir, which resolves via
# ATRIUM_UPDATE_STATE_DIR and NOT GA_TARGET_HOME; without this override the sandbox run
# rewrites the REAL ~/.claude/data/update (a sandbox install of another release would
# rewind the machine's update baseline).
export ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/update-state"
# hermetic sandbox — doctor's daemon-reports scan defaults to the MACHINE's live data/daemon-reports
# a stale apply-abort row there → doctor FAIL → cascades through every install assertion below
# empty dir → trivial scan (the DOCTOR_AUTH_REPORTS_DIR seam the bats suites already use)
mkdir -p "${SANDBOX}/empty-reports"
export DOCTOR_AUTH_REPORTS_DIR="${SANDBOX}/empty-reports"
# metered-call seam — the stub logs each argv line so STEP 1 can prove the self-test ran it
CLAUDE_STUB_CALLS="${SANDBOX}/claude-stub.calls"
mkdir -p "${SANDBOX}/bin"
create_claude_stub "${SANDBOX}/bin/claude" "${CLAUDE_STUB_CALLS}"
export GA_AUTH_CLAUDE_BIN="${SANDBOX}/bin/claude"
# shellcheck disable=SC2329 # run by the EXIT trap; 0.11 misses a trap reached through the final exit
delete_sandbox() {
  if ga_guard_path "${SANDBOX}"; then rm -rf -- "${SANDBOX:?}"; fi
}
trap delete_sandbox EXIT

printf 'SANDBOX=%s\n' "${SANDBOX}"

# the stub GA root STEP 1-5 drive (header); physical, as the launcher resolves GA_ROOT and the -lname counts match it
STUB_GA="$(cd -P -- "${SANDBOX}" && pwd)/ga-stub-root"
# monitor/ a real dir of links, so the install's env render writes its .env here, never into the checkout's monitor/
mkdir -p "${STUB_GA}/monitor"
for entry in "${GA}"/monitor/* "${GA}"/monitor/.[!.]*; do
  [[ ! -e "${entry}" || "${entry##*/}" == .env ]] || ln -s "${entry}" "${STUB_GA}/monitor/${entry##*/}"
done
make_remote_stub_root "${STUB_GA}" "${GA}"
GA_BIN="${STUB_GA}/glass-atrium"

# tree-matched manifest: hermetic defense — drive install/uninstall against a
# manifest filtered to files that exist on THIS tree (via GA_MANIFEST, the
# sandbox override), so any future manifest/tree drift surfaces in the STEP 0
# SoT reconciliation gate instead of corrupting the install-mechanism
# assertions below.
SBX_MANIFEST="${SANDBOX}/manifest.tree-matched.json"
EXISTING="$(jq -r '.files[]' "${GA}/manifest.json" | while IFS= read -r r; do [[ -e "${GA}/${r}" ]] && printf '%s\n' "${r}"; done)"
printf '%s\n' "${EXISTING}" | jq -R . | jq -s '{files: .}' >"${SBX_MANIFEST}"
export GA_MANIFEST="${SBX_MANIFEST}"
MANIFEST_COUNT_RAW="$(jq '.files | length' "${GA}/manifest.json")"
# install is driven by GA_MANIFEST (the tree-matched sandbox manifest), so AC1
# MUST assert against THIS count — identical to the tracked manifest on a
# drift-free tree (STEP 0 guards that), hermetic against drift on principle.
SBX_MANIFEST_COUNT="$(jq '.files | length' "${SBX_MANIFEST}")"
printf 'tracked manifest=%s, tree-matched (sandbox) manifest=%s\n' \
  "${MANIFEST_COUNT_RAW}" "${SBX_MANIFEST_COUNT}"

# seed a realistic pre-existing user settings.json
cat >"${TARGET}/settings.json" <<'JSON'
{
  "model": "user-pinned-model",
  "permissions": { "allow": ["Bash(ls:*)", "Read"], "deny": ["Bash(rm:*)"] },
  "env": { "MY_USER_VAR": "keepme", "ANOTHER": "alsokeep" },
  "statusLine": { "type": "command", "command": "my-statusline.sh" },
  "fooTopLevelKey": { "nested": [1, 2, 3] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "~/.claude/hooks/my-own-hook.sh" } ] }
    ]
  }
}
JSON
cp -p "${TARGET}/settings.json" "${SANDBOX}/user-settings.ORIGINAL.json"

# seed a COLLIDING user-owned agent file (a real Atrium agent basename)
COLLIDE_REL="$(jq -r '.files[]' "${GA}/manifest.json" | grep '^agents/.*\.md$' | head -1)"
mkdir -p "${TARGET}/$(dirname "${COLLIDE_REL}")"
printf 'USER OWNED CONTENT — must survive\n' >"${TARGET}/${COLLIDE_REL}"
COLLIDE_HASH_BEFORE="$(shasum "${TARGET}/${COLLIDE_REL}" | awk '{print $1}')"
MANIFEST_COUNT="$(jq '.files | length' "${GA}/manifest.json")"
printf 'colliding user file: %s\nmanifest count: %s\n' "${COLLIDE_REL}" "${MANIFEST_COUNT}"

# =============================================================================
hdr "STEP 0 — manifest SoT reconciliation (AC0: generator --check, both directions)"
# manifest.json is generator-owned (scripts/generate-manifest.sh) — a hand edit
# or a tracked-file add/delete without regeneration must fail HERE, before the
# install-mechanism steps run against a drifted manifest.
"${GA}/scripts/generate-manifest.sh" --check >"${SANDBOX}/manifest-check.log" 2>&1
MCHECK_RC=$?
tail -2 "${SANDBOX}/manifest-check.log"
[[ "${MCHECK_RC}" -eq 0 ]] \
  && ok "generate-manifest --check clean (zero orphans + zero unlisted, both directions)" \
  || no "generate-manifest --check rc=${MCHECK_RC} (manifest diverged from git ls-files)"
# fresh-clone guarantee: every listed entry must be git-TRACKED — an untracked
# (gitignored/local-only) entry passes a LOCAL doctor but hard-fails doctor §4
# on a fresh clone. LC_ALL=C on comm is load-bearing (BSD comm collates by the
# session locale and mis-diffs C-sorted input otherwise).
UNTRACKED_LISTED="$(untracked_listed_count "${GA}")"
[[ "${UNTRACKED_LISTED}" -eq 0 ]] \
  && ok "zero manifest entries outside git ls-files (fresh-clone doctor safe)" \
  || no "${UNTRACKED_LISTED} manifest entries are not git-tracked"

# =============================================================================
hdr "STEP 1 — doctor preflight (sandbox)"
"${GA_BIN}" doctor >"${SANDBOX}/doctor1.log" 2>&1
DOCTOR_RC=$?
tail -3 "${SANDBOX}/doctor1.log"
[[ "${DOCTOR_RC}" -eq 0 ]] && ok "doctor exits 0 (PASS or PASS-with-warnings)" || no "doctor rc=${DOCTOR_RC}"
if is_stub_reached "${CLAUDE_STUB_CALLS}"; then
  ok "doctor's metered 'claude -p' self-test ran the sandbox stub, not the real CLI"
else
  no "doctor's 'claude -p' self-test never reached the sandbox stub (GA_AUTH_CLAUDE_BIN unrouted, or scripts/lib/claude-auth-env.sh absent so the self-test skipped)"
fi

# =============================================================================
hdr "STEP 2 — install run #1 (config render + symlink farm + wire_hooks)"
"${GA_BIN}" install >"${SANDBOX}/install1.log" 2>&1
INSTALL_RC=$?
[[ "${INSTALL_RC}" -eq 0 ]] && ok "install rc=0" || {
  no "install rc=${INSTALL_RC}"
  tail -20 "${SANDBOX}/install1.log"
}
# DB bootstrap gating honored — the hermetic opt-out (GA_SKIP_DB_SETUP) must be
# acknowledged in the log, proving setup_database ran its gate and never reached
# the machine-global PostgreSQL path.
grep -q 'DB bootstrap skipped (GA_SKIP_DB_SETUP set)' "${SANDBOX}/install1.log" \
  && ok "DB bootstrap gated off (GA_SKIP_DB_SETUP honored)" \
  || no "GA_SKIP_DB_SETUP skip message missing from install log"
# launchd plist render wired into run_install — one plist per active roster job
# (lib/ga-env.sh LAUNCHD_JOBS) in the sandboxed GA_PLIST_OUT dir (file-write only;
# launchctl never invoked by render_plists)
ROSTER_COUNT="$(
  # subshell: sourcing the engine arms readonly globals — keep them contained
  # shellcheck source=lib/ga-env.sh
  source "${GA}/lib/ga-env.sh" || exit 1
  ga_init_env "${GA}" >/dev/null 2>&1
  printf '%s\n' "${#LAUNCHD_JOBS[@]}"
)"
PLIST_COUNT="$(find "${GA_PLIST_OUT}" -name 'com.glass-atrium.*.plist' 2>/dev/null | wc -l | tr -d ' ')"
[[ "${ROSTER_COUNT}" =~ ^[0-9]+$ && "${ROSTER_COUNT}" -gt 0 && "${PLIST_COUNT}" -eq "${ROSTER_COUNT}" ]] \
  && ok "launchd plist render: ${PLIST_COUNT} plists in sandboxed GA_PLIST_OUT = active roster LAUNCHD_JOBS" \
  || no "launchd plist render: expected one plist per active roster job (LAUNCHD_JOBS count '${ROSTER_COUNT}'), found ${PLIST_COUNT}"

# --- AC2: config rendered with real $HOME, zero unexpanded ${HOME} ---
hdr "STEP 2 / AC2 — config.toml render"
if [[ -f "${CONFIG_OUT}" ]]; then
  ok "config.toml rendered at ${CONFIG_OUT}"
  UNEXP="$(grep -c '\${HOME}' "${CONFIG_OUT}" || true)"
  [[ -z "${UNEXP}" ]] && UNEXP=0
  [[ "${UNEXP}" -eq 0 ]] && ok "zero unexpanded \${HOME} in rendered config" || no "${UNEXP} unexpanded \${HOME} remain"
  if grep -qF "${HOME}/.glass-atrium/monitor/data/documents" "${CONFIG_OUT}"; then
    ok "real \$HOME substituted (monitor_docs_html_root = ${HOME}/.glass-atrium/...)"
  else
    no "real \$HOME not found in rendered monitor_docs_html_root"
  fi
else
  no "config.toml NOT rendered"
fi

# --- AC1: sandbox-manifest GA symlinks created (farmed subset minus 1 collision) ---
hdr "STEP 2 / AC1 — symlink farm"
# The farm is a SUBSET of the manifest: install-internal surfaces (lib/, monitor/,
# hooks/, scoped/, scripts/, autoagent/, config.toml.example,
# agent-registry.json, glass-atrium) are bundled + hash-verified but consumed in
# place from ~/.glass-atrium and NEVER symlinked into ~/.claude. requirements.txt rides
# that same exclusion as a declaration set with no runtime consumer. So the expectation
# is DERIVED — run every sandbox-manifest rel through the ENGINE's OWN filter
# (is_symlink_excluded), never a hardcoded count minus one; an inline mirror of
# SYMLINK_EXCLUDE_* would go stale as the exclusion set evolves. Mirrors the
# oss-e2e-bootstrap.sh engine-derivation precedent. Collision skip subtracts 1.
FARM_EXPECT="$(
  # subshell: sourcing the engine arms readonly globals — keep them contained
  # shellcheck source=lib/ga-core.sh
  source "${GA}/lib/ga-core.sh" || exit 1
  ga_init_env "${GA}" || exit 1
  expect=0
  while IFS= read -r rel; do
    [[ "$(is_symlink_excluded "${rel}")" == "no" ]] && expect=$((expect + 1))
  done < <(jq -r '.files[]' "${SBX_MANIFEST}")
  printf '%s\n' "$((expect - 1))"
)"
GA_LINKS="$(find "${TARGET}" -type l -lname "${STUB_GA}/*" 2>/dev/null | wc -l | tr -d ' ')"
printf '  GA-pointing symlinks: %s (sandbox manifest=%s, engine-derived farmed subset minus 1 collision=%s)\n' \
  "${GA_LINKS}" "${SBX_MANIFEST_COUNT}" "${FARM_EXPECT}"
[[ "${FARM_EXPECT}" =~ ^[0-9]+$ ]] || no "farm expectation derivation failed (got '${FARM_EXPECT}')"
[[ "${GA_LINKS}" -eq "${FARM_EXPECT}" ]] \
  && ok "symlink count = engine-derived farmed subset minus 1 collision (${GA_LINKS}/${FARM_EXPECT})" \
  || no "symlink count ${GA_LINKS} != engine-derived farmed subset minus 1 collision ${FARM_EXPECT}"

# --- AC4: collision — seeded user agent file survives byte-identical + warned ---
hdr "STEP 2 / AC4 — collision detection"
COLLIDE_HASH_AFTER="$(shasum "${TARGET}/${COLLIDE_REL}" | awk '{print $1}')"
[[ "${COLLIDE_HASH_AFTER}" == "${COLLIDE_HASH_BEFORE}" ]] \
  && ok "colliding user file survives byte-identical (${COLLIDE_REL})" \
  || no "colliding user file MUTATED"
[[ ! -L "${TARGET}/${COLLIDE_REL}" ]] && ok "colliding path is still a real file (not symlinked over)" || no "colliding path was symlinked over"
grep -q "COLLISION:" "${SANDBOX}/install1.log" && ok "collision warning logged" || no "no collision warning in log"

# --- AC3: settings.json additive — only .hooks grew, all other keys identical ---
hdr "STEP 2 / AC3 — settings additive merge"
# user-owned keys byte-identical
for key in model permissions env statusLine fooTopLevelKey; do
  ORIG="$(jq -Sc --arg k "${key}" '.[$k]' "${SANDBOX}/user-settings.ORIGINAL.json")"
  NOW="$(jq -Sc --arg k "${key}" '.[$k]' "${TARGET}/settings.json")"
  [[ "${ORIG}" == "${NOW}" ]] && ok "key '${key}' preserved byte-identical" || no "key '${key}' changed: ${ORIG} -> ${NOW}"
done
# user's own hook entry survives
MYHOOK="$(jq '[ .hooks.PreToolUse[]? | .hooks[]? | .command | select(endswith("/my-own-hook.sh")) ] | length' "${TARGET}/settings.json")"
[[ "${MYHOOK}" -eq 1 ]] && ok "user's own hook (my-own-hook.sh) preserved" || no "user hook lost (count=${MYHOOK})"
# all Atrium bindings added — expected count derived from the EXPECTED_HOOK_BINDINGS
# array (the SoT), which now lives in lib/ga-env.sh declared INSIDE ga_init_env
# (indented, two-step `ARR=(...)` then `readonly ARR` — the bash-3.2 cross-fn
# nounset-safe idiom). The awk range matches the indented `EXPECTED_HOOK_BINDINGS=(`
# open line through its closing `)` (the `^readonly -a` anchor no longer applies).
GACORE="${GA}/lib/ga-env.sh"
EXPECTED_BINDING_COUNT="$(awk '/EXPECTED_HOOK_BINDINGS=\(/,/^[[:space:]]*\)/' "${GACORE}" | grep -c "$(printf '\t')")"
# hook-repoint: wire_hooks now emits "$HOME/.glass-atrium/hooks/<basename>" (the in-place
# consumer), NOT the legacy ~/.claude/hooks farm — so the bound-command match keys on
# /.glass-atrium/hooks/ (canonical per test/wire-hooks-merge.bats). Pre-repoint /.claude/hooks/
# matched zero and false-failed this additive-merge assertion.
ATRIUM_BOUND="$(jq '[ .hooks[]?[]? | .hooks[]? | .command | select(contains("/.glass-atrium/hooks/")) | select(endswith("/my-own-hook.sh") | not) ] | length' "${TARGET}/settings.json")"
printf '  Atrium hook commands bound: %s (expect %s)\n' "${ATRIUM_BOUND}" "${EXPECTED_BINDING_COUNT}"
[[ "${ATRIUM_BOUND}" -eq "${EXPECTED_BINDING_COUNT}" ]] && ok "exactly ${EXPECTED_BINDING_COUNT} Atrium bindings added" || no "Atrium bindings = ${ATRIUM_BOUND} != ${EXPECTED_BINDING_COUNT}"
# backup taken
BK="$(find "${TARGET}" -name 'settings.json.ga-backup.*' | head -1)"
[[ -n "${BK}" ]] && ok "timestamped settings backup created" || no "no settings backup"

# =============================================================================
hdr "STEP 3 — render-monitor-env.sh ordering (AC2 — render precedes validation)"
# point render-monitor-env at the sandbox-rendered config; it validates the
# monitor_docs_html_root as an existing absolute dir → ensure that dir exists.
mkdir -p "${HOME}/.glass-atrium/monitor/data/documents" 2>/dev/null || true
# render-monitor-env reads GA_ROOT/config.toml; symlink the rendered config there
# via a sandbox GA_ROOT so we never touch the real config.toml.
SBX_GAROOT="${SANDBOX}/ga-root"
mkdir -p "${SBX_GAROOT}/monitor"
cp "${CONFIG_OUT}" "${SBX_GAROOT}/config.toml"
GA_ROOT="${SBX_GAROOT}" "${RENDER_ENV}" >"${SANDBOX}/renderenv.log" 2>&1
RENDERENV_RC=$?
tail -2 "${SANDBOX}/renderenv.log"
[[ "${RENDERENV_RC}" -eq 0 ]] \
  && ok "render-monitor-env.sh exits 0 on the rendered config (absolute-dir validation passed)" \
  || no "render-monitor-env.sh rc=${RENDERENV_RC} (ordering/validation issue)"

# =============================================================================
hdr "STEP 4 — install run #2 (AC7 idempotency)"
"${GA_BIN}" install >"${SANDBOX}/install2.log" 2>&1
INSTALL2_RC=$?
[[ "${INSTALL2_RC}" -eq 0 ]] && ok "second install rc=0" || no "second install rc=${INSTALL2_RC}"
# no NEW symlinks: every manifest entry logs "skip (already correct)" except the collision
SKIPS="$(grep -c 'skip (already correct)' "${SANDBOX}/install2.log" || true)"
[[ -z "${SKIPS}" ]] && SKIPS=0
NEWLINKS="$(grep -c '^linked: ' "${SANDBOX}/install2.log" || true)"
[[ -z "${NEWLINKS}" ]] && NEWLINKS=0
printf '  run#2: %s skip-already-correct, %s new links\n' "${SKIPS}" "${NEWLINKS}"
[[ "${NEWLINKS}" -eq 0 ]] && ok "idempotent: zero new symlinks on re-run" || no "${NEWLINKS} new symlinks on re-run"
grep -q 'already wired' "${SANDBOX}/install2.log" && ok "idempotent: hooks already wired (no dup)" || no "hooks re-wired on second run"
grep -q 'already fully expanded — skip' "${SANDBOX}/install2.log" && ok "idempotent: config render no-op on re-run" || no "config re-rendered on second run"
# count Atrium bindings still matches the SoT count (no duplicates) — repointed
# /.glass-atrium/hooks/ match (see the AC3 note above; pre-repoint /.claude/hooks/ counted 0).
ATRIUM_BOUND2="$(jq '[ .hooks[]?[]? | .hooks[]? | .command | select(contains("/.glass-atrium/hooks/")) | select(endswith("/my-own-hook.sh") | not) ] | length' "${TARGET}/settings.json")"
[[ "${ATRIUM_BOUND2}" -eq "${EXPECTED_BINDING_COUNT}" ]] && ok "still exactly ${EXPECTED_BINDING_COUNT} Atrium bindings (no duplicates)" || no "binding count drifted to ${ATRIUM_BOUND2}"

# =============================================================================
hdr "STEP 5 — malformed-settings loud-fail (AC6)"
MSAND="$(mktemp -d -t ga-malformed.XXXXXX)"
printf '%s\n' '{ this is not json' >"${MSAND}/settings.json"
MAL_HASH_BEFORE="$(shasum "${MSAND}/settings.json" | awk '{print $1}')"
GA_TARGET_HOME="${MSAND}" "${GA_BIN}" wire-hooks >"${MSAND}/wire.log" 2>&1
MAL_RC=$?
[[ "${MAL_RC}" -ne 0 ]] && ok "malformed settings aborts (rc=${MAL_RC})" || no "malformed settings did NOT abort"
grep -q 'not valid JSON' "${MSAND}/wire.log" && ok "loud-fail message emitted" || no "no loud-fail message"
MAL_HASH_AFTER="$(shasum "${MSAND}/settings.json" | awk '{print $1}')"
[[ "${MAL_HASH_BEFORE}" == "${MAL_HASH_AFTER}" ]] && ok "malformed settings left byte-identical (no partial merge)" || no "malformed settings was mutated"
if ga_guard_path "${MSAND}"; then rm -rf -- "${MSAND:?}"; fi

# =============================================================================
# STEP 6-7 — the DESTRUCTIVE full-uninstall path (AC5 + idempotency + --verify-clean
# + --purge-config) is intentionally NOT exercised here.
#
# WHY SKIPPED (hermeticity, not a real-uninstall regression): this harness is the
# LIGHT sandbox — it overrides only GA_TARGET_HOME (+ GA_CONFIG_TOML / GA_MANIFEST),
# reusing the REAL $HOME and $GA_ROOT. But `glass-atrium uninstall` (a) requires an
# explicit --yes (initial-commit destructive-consent gate — NOT a monitor-build/TUI-session change) and
# (b) its run_uninstall path calls drop_databases (REAL peer-auth socket + real DB
# name), remove_node_modules (rm -rf ${GA_ROOT}/monitor/node_modules — GA_ROOT is
# readonly + non-overridable, so this is the real worktree tree), and
# stop_detached_daemons — NONE of which the GA_TARGET_HOME seam redirects. The light
# sandbox therefore cannot isolate them, so on any live-install / built-worktree
# machine the full uninstall would touch real resources. Additionally the old AC5
# "settings.json restored byte-identical" assertion predates the ~/.claude/hooks ->
# ~/.glass-atrium/hooks command repoint (install now repoints a farm-dir binding),
# so it encodes a superseded model.
#
# COVERAGE LIVES ELSEWHERE: hermetic full-uninstall parity (symlinks gone, bindings
# un-wired, throwaway db dropped, launchd sandbox-guarded) is exercised by
# test/oss-e2e-bootstrap.sh — a FULL-$HOME sandbox with a throwaway db + --yes. The
# un-wire logic itself is unit-covered by test/unwire-hooks.bats. This harness owns
# the install-mechanism ACs (STEP 0-5) + the real-target safety guard (STEP 8).
hdr "STEP 6-7 — full uninstall (SKIPPED: requires a clean/hermetic machine)"
# GA-RM[not-executed]: printf text naming the skipped uninstall step, never run
printf '  SKIP: destructive uninstall (real db drop + %s/monitor/node_modules rm -rf +\n' "${GA}"
printf '        detached-daemon teardown) is not isolatable in this light GA_TARGET_HOME sandbox.\n'
printf '  SKIP: hermetic full-uninstall coverage — test/oss-e2e-bootstrap.sh (isolated HOME + throwaway db + --yes);\n'
printf '        un-wire unit coverage — test/unwire-hooks.bats.\n'

# =============================================================================
hdr "STEP 9 — fresh install into a temp HOME (questions at a pty, machine-reaching tools stubbed)"
FRESH_HOME="${SANDBOX}/fresh-home"
FRESH_GA="${FRESH_HOME}/.glass-atrium"
FRESH_STUBS="${SANDBOX}/fresh-stubs"
FRESH_CALLS="${SANDBOX}/fresh-stub.calls"
FRESH_CLAUDE_CALLS="${SANDBOX}/fresh-claude.calls"
FRESH_PROFILE="${FRESH_HOME}/.claude.json"
FRESH_SETTINGS="${FRESH_HOME}/.claude/settings.json"
QUEUE_ASK='Make the queue MCP writes listed above? [y/N]: '
REMOTE_ASK='Open the monitor to your own registered devices on a trusted Wi-Fi (HTTPS, local CA)? [y/N]: '
# the home a first `claude` run leaves: ~/.claude present and empty — doctor's target-home row needs it
mkdir -p "${FRESH_STUBS}" "${FRESH_HOME}/.claude" "${FRESH_HOME}/.Trash" "${SANDBOX}/fresh-pg"
put_install_tree "${GA}" "${FRESH_GA}"
# lib/ga-remote.sh reaches its system tools by absolute path, past the PATH stubs → the shared ga_remote_run shadow:
# this Mac's own monitor listener, Wi-Fi and launchd never decide or receive anything from the fresh install
mv -- "${FRESH_GA}/lib/ga-remote.sh" "${FRESH_GA}/lib/ga-remote.real.sh"
printf 'source %q && source %q\n' "${FRESH_GA}/lib/ga-remote.real.sh" "${GA}/test/lib/remote-run-stub.bash" \
  >"${FRESH_GA}/lib/ga-remote.sh"
create_record_stubs "${FRESH_STUBS}" "${FRESH_CALLS}"
create_claude_stub "${FRESH_STUBS}/claude" "${FRESH_CLAUDE_CALLS}"

# install #1: Enter at both questions (remote access, then the queue MCP writes) — the default No
run_fresh $'\n\n' install >"${SANDBOX}/fresh-install1.log" 2>&1
FRESH_RC=$?
[[ "${FRESH_RC}" -eq 0 ]] && ok "fresh install rc=0" || {
  no "fresh install rc=${FRESH_RC}"
  grep -E '^ *(FAIL|warn) *:|FATAL' "${SANDBOX}/fresh-install1.log"
}
[[ -f "${FRESH_HOME}/.claude/data/update/baseline-manifest.json" ]] \
  && ok "install ran to its last step (base@install baseline captured in the fresh home)" \
  || no "no base@install baseline in the fresh home — the install stopped before its last step"
NODE_BIN="$(sed -n 's/^node_bin = "\(.*\)"$/\1/p' "${FRESH_GA}/config.toml")"
[[ -x "${NODE_BIN}" && "${NODE_BIN}" != */Cellar/* ]] \
  && ok "config.toml node_bin is an executable, version-free path (${NODE_BIN})" \
  || no "config.toml node_bin '${NODE_BIN}' is not an executable version-free path"
ENV_MODE="$(stat -f '%Lp' "${FRESH_GA}/monitor/.env" 2>/dev/null || echo MISSING)"
[[ "${ENV_MODE}" == 600 ]] && ok "monitor/.env exists owner-only (600)" || no "monitor/.env mode ${ENV_MODE}, not 600"
grep -q '^ATRIUM_TIMEZONE=' "${FRESH_GA}/monitor/.env" 2>/dev/null && grep -q '^ATRIUM_SCHEDULE_' "${FRESH_GA}/monitor/.env" \
  && ok "monitor/.env carries the timezone and schedule keys" \
  || no "monitor/.env lacks ATRIUM_TIMEZONE or ATRIUM_SCHEDULE_* keys"
[[ ! -e "${FRESH_PROFILE}" && -z "$(get_mcp_allow_lines "${FRESH_SETTINGS}")" ]] && ! grep -q '^mcp ' "${FRESH_CLAUDE_CALLS}" \
  && ok "the default No writes nothing (no profile entry, no allow line, no claude mcp call)" \
  || no "the default No still wrote a queue MCP entry or allow line"

# install #2: Enter at the remote question, y at the queue MCP question
run_fresh $'\ny\n' install >"${SANDBOX}/fresh-install2.log" 2>&1
FRESH_RC=$?
[[ "${FRESH_RC}" -eq 0 ]] && ok "fresh re-install rc=0" || {
  no "fresh re-install rc=${FRESH_RC}"
  grep -E '^ *(FAIL|warn) *:|FATAL' "${SANDBOX}/fresh-install2.log"
}
PREVIEW="$(get_preview_entry "${SANDBOX}/fresh-install2.log" "${FRESH_PROFILE}")"
QUEUE_NAME="${PREVIEW%%$'\t'*}"
PREVIEW_LINES="$(sed -n "s|^.*${FRESH_SETTINGS}: permissions\.allow + ||p" "${SANDBOX}/fresh-install2.log" | LC_ALL=C sort)"
[[ -n "${PREVIEW}" && "$(jq -Sc --arg n "${QUEUE_NAME}" '.mcpServers[$n]' "${FRESH_PROFILE}" 2>/dev/null)" == "$(jq -Sc . <<<"${PREVIEW#*$'\t'}")" ]] \
  && ok "y writes the profile entry the preview showed (${QUEUE_NAME})" \
  || no "the profile entry differs from the preview ('${PREVIEW}')"
[[ -n "${PREVIEW_LINES}" && "$(get_mcp_allow_lines "${FRESH_SETTINGS}")" == "${PREVIEW_LINES}" ]] \
  && ok "y writes exactly the allow lines the preview listed" || no "the allow lines differ from the preview"
FRESH_BACKUP="$(sed -n 's|^.*(allow lines, add; backup: \(.*\))$|\1|p' "${SANDBOX}/fresh-install2.log")"
[[ -n "${FRESH_BACKUP}" && -f "${FRESH_BACKUP}" ]] \
  && ok "the settings backup the preview announced exists" || no "no settings backup at '${FRESH_BACKUP}'"

# uninstall --yes: y at the queue MCP removal question
run_fresh $'y\n' uninstall --yes >"${SANDBOX}/fresh-uninstall.log" 2>&1
FRESH_RC=$?
[[ "${FRESH_RC}" -eq 0 ]] && ok "fresh uninstall rc=0" || {
  no "fresh uninstall rc=${FRESH_RC}"
  grep -E '^ *(FAIL|warn) *:|FATAL' "${SANDBOX}/fresh-uninstall.log"
}
[[ "$(jq -c --arg n "${QUEUE_NAME}" '.mcpServers[$n]' "${FRESH_PROFILE}" 2>/dev/null)" == null && -z "$(get_mcp_allow_lines "${FRESH_SETTINGS}")" ]] \
  && ok "uninstall with y removes the profile entry and the allow lines" \
  || no "the queue MCP entry or allow lines survive the uninstall"
# each question once per transcript, so every typed answer reached the question it was typed for
for row in "fresh-install1:${REMOTE_ASK}" "fresh-install1:${QUEUE_ASK}" "fresh-install2:${REMOTE_ASK}" \
  "fresh-install2:${QUEUE_ASK}" "fresh-uninstall:${QUEUE_ASK}"; do
  ASKED="$(grep -oF "${row#*:}" "${SANDBOX}/${row%%:*}.log" | wc -l | tr -d ' ')"
  [[ "${ASKED}" -eq 1 ]] && ok "${row%%:*} asks '${row#*:}' once" || no "${row%%:*} asks '${row#*:}' ${ASKED} times"
done
printf '  stubbed (never run for real): %s\n' "$(cut -d' ' -f1 "${FRESH_CALLS}" | LC_ALL=C sort | uniq -c | tr -s ' \n' ' ')"
printf '  claude stub calls: %s\n' "$(cut -d' ' -f1-2 "${FRESH_CLAUDE_CALLS}" | LC_ALL=C sort | uniq -c | tr -s ' \n' ' ')"

# =============================================================================
hdr "STEP 8 — SAFETY GUARD: real ~/.claude + real config.toml UNTOUCHED"
REAL_SETTINGS_HASH_AFTER="$(shasum "${REAL_CLAUDE}/settings.json" 2>/dev/null | awk '{print $1}' || echo MISSING)"
[[ "${REAL_SETTINGS_HASH_AFTER}" == "${REAL_SETTINGS_HASH_BEFORE}" ]] \
  && ok "real settings.json UNCHANGED (sha ${REAL_SETTINGS_HASH_BEFORE})" \
  || no "real settings.json CHANGED ${REAL_SETTINGS_HASH_BEFORE} -> ${REAL_SETTINGS_HASH_AFTER}"
# any GA symlink/artifact CREATED in the REAL target during this run = override
# leak. Scan is scoped to the component dirs the install engine can write + the top
# level (a full-tree find would crawl the huge, never-touch projects/ tree).
LEAKS=0
for d in agents autoagent hooks rules scoped scripts skills; do
  [[ -d "${REAL_CLAUDE}/${d}" ]] || continue
  N_NEW="$(find "${REAL_CLAUDE}/${d}" -type l \( -lname "${GA}/*" -o -lname "${STUB_GA}/*" \) -newer "${START_MARKER}" 2>/dev/null | wc -l | tr -d ' ')"
  LEAKS=$((LEAKS + N_NEW))
done
TOP_NEW="$(find "${REAL_CLAUDE}" -maxdepth 1 \( -name '*.ga-backup.*' -o -name '*.ga-tmp.*' -o -name '*.ga-wire.*' \) -newer "${START_MARKER}" 2>/dev/null | wc -l | tr -d ' ')"
LEAKS=$((LEAKS + TOP_NEW))
[[ "${LEAKS}" -eq 0 ]] \
  && ok "zero GA symlinks/artifacts created in real ~/.claude during the run" \
  || no "${LEAKS} GA artifact(s) leaked into real ~/.claude"
REAL_BASELINE_HASH_AFTER="$(shasum "${REAL_BASELINE}" 2>/dev/null | awk '{print $1}' || echo MISSING)"
[[ "${REAL_BASELINE_HASH_AFTER}" == "${REAL_BASELINE_HASH_BEFORE}" ]] \
  && ok "real base@install baseline anchor UNCHANGED (sha ${REAL_BASELINE_HASH_BEFORE})" \
  || no "real baseline anchor REWRITTEN ${REAL_BASELINE_HASH_BEFORE} -> ${REAL_BASELINE_HASH_AFTER}"
REAL_CONFIG_HASH_AFTER="$(shasum "${REAL_CONFIG}" 2>/dev/null | awk '{print $1}' || echo MISSING)"
[[ "${REAL_CONFIG_HASH_AFTER}" == "${REAL_CONFIG_HASH_BEFORE}" ]] \
  && ok "real config.toml UNCHANGED (sha ${REAL_CONFIG_HASH_BEFORE})" \
  || no "real config.toml CHANGED"

hdr "RESULT"
printf 'PASS=%s  FAIL=%s\n' "${PASS}" "${FAIL}"
[[ "${FAIL}" -eq 0 ]] && printf 'ALL ACCEPTANCE CHECKS GREEN\n' || printf 'SOME CHECKS FAILED\n'
exit "${FAIL}"
