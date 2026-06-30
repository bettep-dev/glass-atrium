#!/usr/bin/env bats
# render-monitor-env.sh suite. Two contracts:
#   1. Upsert line-boundary hardening — a monitor/.env whose last line lacks a
#      trailing newline must not swallow an appended key onto that line (dotenv
#      loses BOTH keys); the S-1 cases pin metachar-safe in-place rewrites.
#   2. ATRIUM_TIMEZONE resolution — the rendered value is the RESOLVED
#      [meta].timezone: a 'auto' default (or an absent key) must become a
#      CONCRETE host IANA name via the shared atrium_resolve_timezone helper
#      (the literal 'auto' must never reach the .env), while an explicit IANA
#      value round-trips verbatim. Host detection is injected (readlink shadow)
#      so the auto/host path never depends on the runner's ambient tz.
#
# Hermetic: sandbox GA_ROOT + minimal config.toml.
# Run via: bats scripts/test/render-monitor-env.bats

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
RENDER_SH="${GA}/scripts/render-monitor-env.sh"

# Injected host zone for the auto-resolution cascade — deliberately != this
# repo's real host (Asia/Seoul) so a passing auto/host test proves the injection
# works, not that it coincidentally matched the ambient tz.
HOST_TZ="America/New_York"

setup() {
  [[ -f "${RENDER_SH}" ]] || skip "script not found: ${RENDER_SH}"
  SANDBOX="$(mktemp -d -t ga-renderenv-bats.XXXXXX)"
  STUB_BIN="${SANDBOX}/bin"
  mkdir -p "${SANDBOX}/monitor/data/documents"
  stub_host_tz "${HOST_TZ}"
  write_config "auto"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Write a minimal config.toml into the sandbox.
# Args: $1 = [meta].timezone value ('' → omit the key entirely) ·
#       $2 = monitor_docs_html_root (default: the standard sandbox docs dir) ·
#       $3 = [daemon.autoagent-cycle].time      (default 04:30) ·
#       $4 = [daemon.wiki-compile].time         (default 04:50 — the corrected value) ·
#       $5 = [daemon.daemon-daily-restart].time (default 05:30).
# The schedule defaults mirror config.toml.example so the tz/upsert tests render
# cleanly (the script loud-fails without all three [daemon.*].time keys). A
# schedule arg of the literal sentinel '__OMIT__' drops that section's `time`
# line (section header kept) to drive the missing-key loud-fail; any other value
# (incl. a malformed one like '0430' or '25:00') is written verbatim to exercise
# the malformed-time loud-fail.
write_config() {
  local tz="$1" docs="${2:-${SANDBOX}/monitor/data/documents}"
  local autoagent="${3:-04:30}" wiki="${4:-04:50}" daily="${5:-05:30}"
  {
    printf '[ports]\nmonitor = 17842\n\n[paths]\nmonitor_docs_html_root = "%s"\n' "${docs}"
    if [[ -n "${tz}" ]]; then
      printf '\n[meta]\ntimezone = "%s"\n' "${tz}"
    fi
    emit_daemon_section "daemon.autoagent-cycle" "${autoagent}"
    emit_daemon_section "daemon.wiki-compile" "${wiki}"
    emit_daemon_section "daemon.daemon-daily-restart" "${daily}"
  } >"${SANDBOX}/config.toml"
}

# Emit a [<header>] daemon block with a quoted `time` line, unless the value is
# the '__OMIT__' sentinel (header kept, `time` line dropped → missing-key path).
# Args: $1 = section header body (no brackets) · $2 = time value | '__OMIT__'.
emit_daemon_section() {
  local header="$1" sched_time="$2"
  printf '\n[%s]\n' "${header}"
  [[ "${sched_time}" == "__OMIT__" ]] || printf 'time = "%s"\n' "${sched_time}"
}

# Deterministic host-tz injection. The auto-resolution cascade's TZ-immune
# primary (lib/atrium-config.sh atrium_get_host_timezone) reads the
# /etc/localtime symlink target; shadow `readlink` so it resolves to a FIXED
# IANA zone regardless of the runner host. Non-/etc/localtime reads fall through
# to the real readlink (so the script's other readlink callers are untouched).
stub_host_tz() {
  local zone="$1"
  mkdir -p "${STUB_BIN}"
  cat >"${STUB_BIN}/readlink" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "/etc/localtime" ]]; then
  printf '/var/db/timezone/zoneinfo/${zone}\n'
  exit 0
fi
exec /usr/bin/readlink "\$@"
STUB
  chmod +x "${STUB_BIN}/readlink"
}

run_render() {
  run env -u ATRIUM_CONFIG_TOML GA_ROOT="${SANDBOX}" PATH="${STUB_BIN}:${PATH}" bash "${RENDER_SH}"
}

@test "append onto a newline-less .env keeps each key on its own line" {
  printf 'SHADOW_DATABASE_URL=postgresql:///glass_atrium_shadow?host=/tmp' >"${SANDBOX}/monitor/.env"
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q '^ATRIUM_MONITOR_PORT=17842$' "${SANDBOX}/monitor/.env"
  grep -q '^SHADOW_DATABASE_URL=postgresql:///glass_atrium_shadow?host=/tmp$' "${SANDBOX}/monitor/.env"
}

@test "fresh .env (absent) renders all three keys on own lines" {
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q '^ATRIUM_MONITOR_PORT=17842$' "${SANDBOX}/monitor/.env"
  grep -q "^CLAUDED_DOCS_HTML_ROOT=${SANDBOX}/monitor/data/documents$" "${SANDBOX}/monitor/.env"
  # tz key present + a CONCRETE resolved zone (the injected host), never 'auto'.
  grep -q "^ATRIUM_TIMEZONE=${HOST_TZ}$" "${SANDBOX}/monitor/.env"
  ! grep -q '^ATRIUM_TIMEZONE=auto$' "${SANDBOX}/monitor/.env"
}

@test "re-run upserts in place (idempotent, no duplicate keys)" {
  run_render
  [[ "${status}" -eq 0 ]]
  run_render
  [[ "${status}" -eq 0 ]]
  [[ "$(grep -c '^ATRIUM_MONITOR_PORT=' "${SANDBOX}/monitor/.env")" -eq 1 ]]
}

# ---------------------------------------------------------------------------
# ATRIUM_TIMEZONE resolution (atrium_resolve_timezone wiring)
# ---------------------------------------------------------------------------

@test "'auto' default resolves to a concrete host IANA name (literal 'auto' never rendered)" {
  # setup() wrote timezone='auto' + injected host=${HOST_TZ}.
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q "^ATRIUM_TIMEZONE=${HOST_TZ}$" "${SANDBOX}/monitor/.env"
  ! grep -q '^ATRIUM_TIMEZONE=auto$' "${SANDBOX}/monitor/.env"
}

@test "absent [meta].timezone defaults to auto → resolves to the host IANA name" {
  write_config "" # omit the [meta].timezone key entirely
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q "^ATRIUM_TIMEZONE=${HOST_TZ}$" "${SANDBOX}/monitor/.env"
  ! grep -q '^ATRIUM_TIMEZONE=auto$' "${SANDBOX}/monitor/.env"
}

@test "explicit IANA [meta].timezone round-trips verbatim (host stub does not override)" {
  # Injected host is ${HOST_TZ}; an explicit, DIFFERENT zone must win unchanged.
  write_config "Europe/Berlin"
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q '^ATRIUM_TIMEZONE=Europe/Berlin$' "${SANDBOX}/monitor/.env"
}

# S-1 (sed replacement-metachar injection): a docs-root path containing `&` (a
# legal macOS path char) was placed verbatim into a sed replacement string, where
# `&` is the whole-match backreference — corrupting/duplicating the line on the
# update-in-place branch. The fix uses an awk literal -v variable. Drive the
# update branch by pre-seeding the key.
@test "update-in-place with '&' in docs path renders the exact path (S-1)" {
  local docs="${SANDBOX}/a&b/documents"
  mkdir -p "${docs}"
  write_config "auto" "${docs}"
  # Pre-seed the key so render hits the update-in-place (awk) branch.
  printf 'CLAUDED_DOCS_HTML_ROOT=/stale/path\n' >"${SANDBOX}/monitor/.env"
  run_render
  [[ "${status}" -eq 0 ]]
  # Exact-line match: no `&` expansion, no duplication.
  grep -qxF "CLAUDED_DOCS_HTML_ROOT=${docs}" "${SANDBOX}/monitor/.env"
  [[ "$(grep -c '^CLAUDED_DOCS_HTML_ROOT=' "${SANDBOX}/monitor/.env")" -eq 1 ]]
}

@test "update-in-place with backslash in docs path renders the exact path (S-1)" {
  local docs="${SANDBOX}/a\\b/documents"
  mkdir -p "${docs}"
  write_config "auto" "${docs}"
  printf 'CLAUDED_DOCS_HTML_ROOT=/stale/path\n' >"${SANDBOX}/monitor/.env"
  run_render
  [[ "${status}" -eq 0 ]]
  grep -qxF "CLAUDED_DOCS_HTML_ROOT=${docs}" "${SANDBOX}/monitor/.env"
  [[ "$(grep -c '^CLAUDED_DOCS_HTML_ROOT=' "${SANDBOX}/monitor/.env")" -eq 1 ]]
}

# ---------------------------------------------------------------------------
# T4 — ATRIUM_SCHEDULE_* rendering ([daemon.*].time → three flat .env scalars)
#
# The shell owns the config-job-name → monitor-logical-env-key transform
# (autoagent-cycle→_AUTOAGENT, wiki-compile→_WIKI, daemon-daily-restart→
# _DAILY_RESTART). All three [daemon.*].time keys are read + validated BEFORE any
# upsert, so a missing/malformed time loud-fails non-zero with ZERO partial keys.
# ---------------------------------------------------------------------------

@test "fresh render writes all three ATRIUM_SCHEDULE_* keys from the config times" {
  # Distinctive non-default times prove the values are read from config, not
  # hardcoded in the script.
  write_config "auto" "" "01:05" "12:45" "23:15"
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q '^ATRIUM_SCHEDULE_AUTOAGENT=01:05$' "${SANDBOX}/monitor/.env"
  grep -q '^ATRIUM_SCHEDULE_WIKI=12:45$' "${SANDBOX}/monitor/.env"
  grep -q '^ATRIUM_SCHEDULE_DAILY_RESTART=23:15$' "${SANDBOX}/monitor/.env"
}

@test "default config renders the canonical schedule (autoagent 04:30, wiki 04:50, daily-restart 05:30)" {
  # OD-E backward-compat: autoagent + daily-restart stay byte-identical; wiki is
  # the intentional 04:30→04:50 correction. setup()'s write_config defaults
  # mirror config.toml, so the canonical values render without override.
  run_render
  [[ "${status}" -eq 0 ]]
  grep -q '^ATRIUM_SCHEDULE_AUTOAGENT=04:30$' "${SANDBOX}/monitor/.env"
  grep -q '^ATRIUM_SCHEDULE_WIKI=04:50$' "${SANDBOX}/monitor/.env"
  grep -q '^ATRIUM_SCHEDULE_DAILY_RESTART=05:30$' "${SANDBOX}/monitor/.env"
}

@test "missing [daemon.wiki-compile].time → non-zero exit, no .env (no partial keys)" {
  write_config "auto" "" "04:30" "__OMIT__" "05:30"
  run_render
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"wiki-compile"* ]]
  # Loud-fail fires before ANY upsert → .env is never created (zero partial keys,
  # not even the non-schedule port/html-root/tz keys).
  [[ ! -f "${SANDBOX}/monitor/.env" ]]
}

@test "missing schedule key leaves a pre-existing .env free of any schedule key" {
  printf 'SHADOW_DATABASE_URL=postgresql:///x\n' >"${SANDBOX}/monitor/.env"
  write_config "auto" "" "04:30" "__OMIT__" "05:30"
  run_render
  [[ "${status}" -ne 0 ]]
  # No ATRIUM_SCHEDULE_* key leaked into the pre-existing file (no partial render)
  ! grep -q '^ATRIUM_SCHEDULE_' "${SANDBOX}/monitor/.env"
  # The pre-existing unrelated key is left untouched.
  grep -q '^SHADOW_DATABASE_URL=postgresql:///x$' "${SANDBOX}/monitor/.env"
}

@test "malformed [daemon.autoagent-cycle].time (no colon) → non-zero exit, no .env" {
  write_config "auto" "" "0430" "04:50" "05:30"
  run_render
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"autoagent-cycle"* ]]
  [[ ! -f "${SANDBOX}/monitor/.env" ]]
}

@test "out-of-range [daemon.daemon-daily-restart].time (hour 25) → non-zero exit, no .env" {
  write_config "auto" "" "04:30" "04:50" "25:00"
  run_render
  [[ "${status}" -ne 0 ]]
  [[ "${output}" == *"daemon-daily-restart"* ]]
  [[ ! -f "${SANDBOX}/monitor/.env" ]]
}

@test "re-run upserts the schedule keys in place (idempotent, no duplicate keys)" {
  run_render
  [[ "${status}" -eq 0 ]]
  run_render
  [[ "${status}" -eq 0 ]]
  [[ "$(grep -c '^ATRIUM_SCHEDULE_AUTOAGENT=' "${SANDBOX}/monitor/.env")" -eq 1 ]]
  [[ "$(grep -c '^ATRIUM_SCHEDULE_WIKI=' "${SANDBOX}/monitor/.env")" -eq 1 ]]
  [[ "$(grep -c '^ATRIUM_SCHEDULE_DAILY_RESTART=' "${SANDBOX}/monitor/.env")" -eq 1 ]]
}

# ---------------------------------------------------------------------------
# T5 — config.toml.example template-drift guard
#
# Reuse the production parser (atrium_toml_get) against the REAL example so a
# future template edit that drops a [daemon.*].time key fails this guard.
# render-monitor-env.sh loud-fails without these keys, so a fresh install must
# ship them — this pins fresh-install render readiness.
# ---------------------------------------------------------------------------

# Read a [daemon.<job>].time from the real config.toml.example via the shared lib.
# Args: $1 = table header literal (e.g. "[daemon.wiki-compile]").
example_time() {
  run env ATRIUM_CONFIG_TOML="${GA}/config.toml.example" bash -c '
    source "$1"
    atrium_toml_get "$2" time
  ' _ "${GA}/scripts/lib/atrium-config.sh" "$1"
}

@test "config.toml.example carries [daemon.autoagent-cycle].time (HH:MM)" {
  example_time "[daemon.autoagent-cycle]"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ ^[0-9]{1,2}:[0-9]{2}$ ]]
}

@test "config.toml.example carries [daemon.wiki-compile].time = 04:50 (the corrected value)" {
  example_time "[daemon.wiki-compile]"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "04:50" ]]
}

@test "config.toml.example carries [daemon.daemon-daily-restart].time (HH:MM)" {
  example_time "[daemon.daemon-daily-restart]"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ ^[0-9]{1,2}:[0-9]{2}$ ]]
}
