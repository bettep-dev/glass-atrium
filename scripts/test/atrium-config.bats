#!/usr/bin/env bats
# atrium-config.sh unit suite — pins the shared config.toml accessor contract:
#   * defaults when the config file or key is absent (fresh-clone safety)
#   * table-scoped extraction (same key in another section never collides)
#   * quote + trailing-comment stripping
#   * port guard — non-integer / out-of-range configured value → rc 1 (loud)
#   * ATRIUM_CONFIG_TOML override selects the config file
#   * atrium_ere_escape — metachar value embeds literally under grep -E
#
# Run via: bats scripts/test/atrium-config.bats
# Hermetic: fixtures live under mktemp WORK; the lib is sourced read-only.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "atrium-config.sh not found: ${REAL_LIB}"
  WORK="$(mktemp -d -t atrium-config-bats.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

write_fixture() {
  cat >"${WORK}/config.toml" <<'TOML'
[meta]
timezone = "America/New_York" # trailing comment
[ports]
monitor = 16145
wiki_fakechat = 18788
[paths]
monitor = "/some/path"
TOML
}

# Runs one lib function in a fresh bash with ATRIUM_CONFIG_TOML pinned.
# Args: $1 = config path · $2... = function + args.
lib_call() {
  local cfg="$1"
  shift
  run env ATRIUM_CONFIG_TOML="${cfg}" bash -c '
    source "$1"
    shift
    "$@"
  ' _ "${REAL_LIB}" "$@"
}

@test "missing config file: default echoed, rc 0" {
  lib_call "${WORK}/nonexistent.toml" atrium_config_get '[meta]' timezone Asia/Seoul
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "Asia/Seoul" ]]
}

@test "present key: configured value wins (quotes + trailing comment stripped)" {
  write_fixture
  lib_call "${WORK}/config.toml" atrium_config_get '[meta]' timezone Asia/Seoul
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "America/New_York" ]]
}

@test "table-scoped: [paths].monitor never collides with [ports].monitor" {
  write_fixture
  lib_call "${WORK}/config.toml" atrium_toml_get '[ports]' monitor
  [[ "${output}" == "16145" ]]
  lib_call "${WORK}/config.toml" atrium_toml_get '[paths]' monitor
  [[ "${output}" == "/some/path" ]]
}

@test "absent key: atrium_config_port passes the default through" {
  write_fixture
  lib_call "${WORK}/config.toml" atrium_config_port '[ports]' autoagent_fakechat 8787
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "8787" ]]
}

@test "configured port honored; non-integer / out-of-range port: rc 1 + stderr" {
  write_fixture
  lib_call "${WORK}/config.toml" atrium_config_port '[ports]' wiki_fakechat 8788
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "18788" ]]
  printf '[ports]\nwiki_fakechat = "oops"\n' >"${WORK}/bad.toml"
  lib_call "${WORK}/bad.toml" atrium_config_port '[ports]' wiki_fakechat 8788
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"invalid [ports].wiki_fakechat"* ]]
  printf '[ports]\nwiki_fakechat = 70000\n' >"${WORK}/bad.toml"
  lib_call "${WORK}/bad.toml" atrium_config_port '[ports]' wiki_fakechat 8788
  [[ "${status}" -eq 1 ]]
}

@test "atrium_ere_escape: metachar tz embeds literally in grep -E" {
  run bash -c '
    source "$1"
    esc="$(atrium_ere_escape "Etc/GMT+9")"
    printf "resets June 12 at 11pm (Etc/GMT+9)\n" | grep -qE "resets .* \(${esc}\)"
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]]
}

# --- atrium_monitor_port resolver (ADR-1 precedence chain, AC-S1.1) ---------

# Runs atrium_monitor_port in a fresh bash with the resolver inputs pinned.
# Args: $1 = ATRIUM_MONITOR_ENV path · $2 = ATRIUM_CONFIG_TOML path.
# ATRIUM_MONITOR_PORT is explicitly UNSET so only the .env/config/default
# branches are exercised (the env-prefer branch has its own tests below).
resolver_call() {
  run env -u ATRIUM_MONITOR_PORT \
    ATRIUM_MONITOR_ENV="$1" ATRIUM_CONFIG_TOML="$2" \
    bash -c 'source "$1"; atrium_monitor_port' _ "${REAL_LIB}"
}

@test "resolver: exported ATRIUM_MONITOR_PORT wins over .env and config" {
  write_fixture
  printf 'ATRIUM_MONITOR_PORT=23456\n' >"${WORK}/.env"
  run env ATRIUM_MONITOR_PORT=25000 \
    ATRIUM_MONITOR_ENV="${WORK}/.env" ATRIUM_CONFIG_TOML="${WORK}/config.toml" \
    bash -c 'source "$1"; atrium_monitor_port' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "25000" ]]
}

@test "resolver: rendered monitor/.env value wins over config.toml" {
  write_fixture
  printf 'DATABASE_URL=postgres:///x\nATRIUM_MONITOR_PORT=23456\n' >"${WORK}/.env"
  resolver_call "${WORK}/.env" "${WORK}/config.toml"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "23456" ]]
}

@test "resolver: config.toml [ports].monitor when no env and no .env" {
  printf '[ports]\nmonitor = 19999\n' >"${WORK}/config.toml"
  resolver_call "${WORK}/nonexistent.env" "${WORK}/config.toml"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "19999" ]]
}

@test "resolver: terminal default 16145 when env, .env and config all absent" {
  resolver_call "${WORK}/nonexistent.env" "${WORK}/nonexistent.toml"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "16145" ]]
}

@test "resolver: invalid exported port → rc 1 + loud stderr" {
  run env ATRIUM_MONITOR_PORT=notaport \
    ATRIUM_MONITOR_ENV="${WORK}/nonexistent.env" ATRIUM_CONFIG_TOML="${WORK}/nonexistent.toml" \
    bash -c 'source "$1"; atrium_monitor_port' _ "${REAL_LIB}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"invalid ATRIUM_MONITOR_PORT=notaport"* ]]
}

@test "resolver: out-of-range .env port → rc 1 + loud stderr" {
  printf 'ATRIUM_MONITOR_PORT=70000\n' >"${WORK}/.env"
  resolver_call "${WORK}/.env" "${WORK}/nonexistent.toml"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"invalid ATRIUM_MONITOR_PORT=70000"* ]]
}

@test "resolver default 16145 is the sole shell terminal literal (AC-S1.3a)" {
  # The default DEFAULT literal is the quoted arg form "'16145'"; it appears in
  # exactly one code location (the resolver terminal default). Prose comments
  # mention 16145 unquoted and are not counted.
  run grep -cF "'16145'" "${REAL_LIB}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "1" ]]
}
