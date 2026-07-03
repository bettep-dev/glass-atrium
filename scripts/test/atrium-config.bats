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
monitor = 7842
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
  [[ "${output}" == "7842" ]]
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
