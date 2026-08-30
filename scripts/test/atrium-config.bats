#!/usr/bin/env bats
# atrium-config.sh unit suite — pins the shared config.toml accessor contract:
# fresh-clone default safety (missing file/key → default), table-scoped extraction
# (same key in another section never collides), quote + trailing-comment stripping,
# port guard (non-integer / out-of-range → rc 1 loud), ATRIUM_CONFIG_TOML override,
# atrium_ere_escape (metachar value embeds literally under grep -E).
# Hermetic: fixtures live under mktemp WORK; the lib is sourced read-only.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "atrium-config.sh not found: ${REAL_LIB}"
  # CANONICAL fixture root. macOS `mktemp -d` hands back /var/folders/..., a symlink
  # to /private/var/folders/..., and the ADR-6 resolver now resolves the value it
  # adopts (CWE-59). Without this the adoption tests would compare a resolved path
  # against an unresolved fixture and fail on the platform rather than on the rule.
  # It hides no behaviour: the symlink resolution has its own test below, which builds
  # its link deliberately instead of inheriting one from the temp directory.
  WORK="$(cd -P -- "$(mktemp -d -t atrium-config-bats.XXXXXX)" && pwd -P)"
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

# atrium_monitor_port resolver (ADR-1 precedence chain, AC-S1.1)

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

# --- atrium_toml_keys(): key enumeration + two-consumer round-trip ---

TEMPLATE="${GA}/config.toml.example"

# Emits the template's (section literal, key) pairs, one TAB-separated pair per line.
template_keys() {
  run bash -c 'source "$1"; atrium_toml_keys "$2"' _ "${REAL_LIB}" "${TEMPLATE}"
}

# Resolves every enumerated pair through one consumer parser and prints the
# pairs that come back empty. $1 = get|plist — "plist" reuses the extractor
# lifted verbatim from render-launchd-plists.sh (never a copy of its awk).
resolve_all() {
  local mode="$1" fn_src=""
  [[ "${mode}" == "plist" ]] \
    && fn_src="$(sed -n '/^extract_toml_value() {$/,/^}$/p' "${GA}/scripts/render-launchd-plists.sh")"
  cat >"${WORK}/resolve.sh" <<'DRIVER'
#!/usr/bin/env bash
set -Eeuo pipefail
source "${REAL_LIB}"
if [[ "${MODE}" == "plist" ]]; then
  eval "${PLIST_FN_SRC}"
  reader() { extract_toml_value "$1" "$2"; }
else
  reader() { atrium_toml_get "$1" "$2"; }
fi
count=0
tab="$(printf '\t')"
while IFS="${tab}" read -r section key; do
  count=$((count + 1))
  [[ -n "$(reader "${section}" "${key}")" ]] \
    || printf 'UNRESOLVED %s %s\n' "${section}" "${key}"
done < <(atrium_toml_keys "${TEMPLATE}")
((count > 0)) || printf 'NO_PAIRS_EMITTED\n'
DRIVER
  run env REAL_LIB="${REAL_LIB}" MODE="${mode}" PLIST_FN_SRC="${fn_src}" \
    TEMPLATE="${TEMPLATE}" CONFIG_TOML="${TEMPLATE}" ATRIUM_CONFIG_TOML="${TEMPLATE}" \
    bash "${WORK}/resolve.sh"
}

@test "atrium_toml_keys: emits sorted TAB-separated (section literal, key) pairs" {
  template_keys
  [[ "${status}" -eq 0 ]]
  [[ -n "${output}" ]]
  [[ "${output}" == "$(printf '%s\n' "${output}" | LC_ALL=C sort -u)" ]]
}

@test "atrium_toml_keys: dotted section keeps its bracket literal (no flattening)" {
  template_keys
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"[daemon.pg-backup]"$'\t'"time"* ]]
  [[ "${output}" != *"daemon.pg-backup.time"* ]]
}

@test "atrium_toml_keys: a comment line carrying '=' emits no phantom key" {
  template_keys
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"[release]"$'\t'"time"* ]]
  [[ "${output}" != *"[release]"$'\t'"mode"* ]]
}

@test "atrium_toml_keys: quoted value containing '=' does not split the key" {
  cat >"${WORK}/config.toml" <<'TOML'
[meta]
# banner = "not a key"
project = "a=b"
TOML
  run bash -c 'source "$1"; atrium_toml_keys "$2"' _ "${REAL_LIB}" "${WORK}/config.toml"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "[meta]"$'\t'"project" ]]
}

@test "round-trip: every template pair resolves non-empty via atrium_toml_get" {
  resolve_all get
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

@test "round-trip: every template pair resolves non-empty via the plist extractor" {
  resolve_all plist
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
}

# --- atrium_backup_dir: ADR-6 adoption rule (AC-C2) --------------------------
#
# The resolver adopts [paths].backup_dir on the FILESYSTEM STATE the value
# describes, so each case below differs from its neighbour in exactly one piece of
# state and no two can pass by the same code path:
#
#   case 1  value = the default          -> default,    silent
#   case 2  destination EXISTS           -> configured, silent  (dumps at the
#                                           default, so ONLY the existence arm
#                                           can adopt here)
#   case 3  absent, creatable, 0 dumps   -> configured, silent
#   case 4  absent, creatable, dumps > 0 -> default + WARN, nothing created or moved
#   case 5  relative / empty             -> default + WARN
#
# Cases 3 and 4 differ ONLY in the dump census, which is what makes the population
# check independently red-able: drop it and 4 adopts the configured value.
#
# NO LIVE PATH LITERAL: test/db-backup-path-consistency.bats greps every tracked
# file for the stale backup path string, so case 4 reproduces the live SHAPE
# (absolute, elsewhere, directory absent, dumps already at the default) out of
# sandbox paths and never spells the live value.
#
# SEAM HYGIENE: GA_DB_BACKUP_DIR is unset inside every call (except the test that
# asserts its precedence) so an exported value in the developer's shell cannot mask
# the rule under test, and GA_DATA_ROOT is pinned into WORK so "the default
# location" is a directory these tests own.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate the verdict, so every
# assertion below `return 1`s with its own message and fails independently.

BK_CFG_ABSENT="__no_key__"

# Write a [paths] fixture. Args: $1 = backup_dir value, or BK_CFG_ABSENT to declare
# no such key at all (the fresh-clone shape, which must stay silent).
backup_fixture() {
  local value="$1"
  {
    printf '[paths]\n'
    printf 'target_home = "%s"\n' "${WORK}/facade"
    if [[ "${value}" != "${BK_CFG_ABSENT}" ]]; then
      printf 'backup_dir = "%s"\n' "${value}"
    fi
  } >"${WORK}/config.toml"
}

# The default location these tests resolve against.
backup_default_dir() {
  printf '%s\n' "${WORK}/ga/backups/postgres"
}

# Create $2 dump files in $1. The names stay inside pg-backup.sh's rotation glob
# unless a test deliberately steps outside it.
seed_dumps() {
  local dir="$1" want="$2" i=1
  mkdir -p -- "${dir}"
  while [[ "${i}" -le "${want}" ]]; do
    : >"${dir}/glass_atrium-2026010${i}-000000.dump"
    i=$((i + 1))
  done
}

# Resolve once, stdout and stderr captured separately so the WARN can be asserted
# without polluting the resolved path.
backup_resolve() {
  run --separate-stderr env -u GA_DB_BACKUP_DIR \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash -c 'source "$1"; atrium_backup_dir' _ "${REAL_LIB}"
}

@test "AC-C2(1) fresh install: the value IS the default -> default location, silent" {
  backup_fixture "$(backup_default_dir)"
  backup_resolve
  [[ "${status}" -eq 0 ]] || {
    printf 'resolver failed: %s\n' "${stderr}" >&2
    return 1
  }
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'want %s, got %s\n' "$(backup_default_dir)" "${output}" >&2
    return 1
  }
  [[ -z "${stderr}" ]] || {
    printf 'a config that agrees with the default must not warn: %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2(2) a customization in use: destination EXISTS -> configured value, silent" {
  # Dumps sit at the DEFAULT here, so the creatable+empty arm cannot adopt: only
  # the existence arm can, which is what makes that arm independently red-able.
  seed_dumps "$(backup_default_dir)" 2
  mkdir -p -- "${WORK}/custom-live"
  backup_fixture "${WORK}/custom-live"
  backup_resolve
  [[ "${output}" == "${WORK}/custom-live" ]] || {
    printf 'an existing destination must be adopted; got %s\n' "${output}" >&2
    return 1
  }
  [[ -z "${stderr}" ]] || {
    printf 'adopting an existing destination must not warn: %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2(3) a customization not yet created, 0 dumps at the default -> configured value, silent" {
  mkdir -p -- "${WORK}/ga"
  backup_fixture "${WORK}/custom-new"
  backup_resolve
  [[ "${output}" == "${WORK}/custom-new" ]] || {
    printf 'a creatable destination with nothing left behind must be adopted; got %s\n' "${output}" >&2
    return 1
  }
  [[ -z "${stderr}" ]] || {
    printf 'case 3 must not warn: %s\n' "${stderr}" >&2
    return 1
  }
  [[ ! -e "${WORK}/custom-new" ]] || {
    printf 'the resolver created %s — resolution must never touch the filesystem\n' "${WORK}/custom-new" >&2
    return 1
  }
}

@test "AC-C2(4) live shape: absolute, elsewhere, absent, dumps at the default -> default + WARN, nothing created" {
  # The ONLY difference from case 3 is the census: the parent exists, so the
  # destination is creatable and the creatability probe cannot be what rejects it.
  mkdir -p -- "${WORK}/stale-render"
  seed_dumps "$(backup_default_dir)" 3
  backup_fixture "${WORK}/stale-render/postgres"
  backup_resolve

  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a value nobody acted on must NOT relocate the dumps; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"${WORK}/stale-render/postgres"* ]] || {
    printf 'the WARN must name the configured path: %s\n' "${stderr}" >&2
    return 1
  }
  [[ "${stderr}" == *"$(backup_default_dir)"* ]] || {
    printf 'the WARN must name the resolved path: %s\n' "${stderr}" >&2
    return 1
  }
  [[ "${stderr}" == *"configured=0"* && "${stderr}" == *"resolved=3"* ]] || {
    printf 'the WARN must carry both dump censuses: %s\n' "${stderr}" >&2
    return 1
  }
  # NON-DESTRUCTIVE PROBE: `mkdir -p` here would create the configured path, and
  # the existence arm would then adopt it on the very next run.
  [[ ! -e "${WORK}/stale-render/postgres" ]] || {
    printf 'the resolver created the configured path — the next run would adopt it\n' >&2
    return 1
  }
  # NO RELOCATION: every dump is still where it was.
  local remaining
  remaining="$(find "$(backup_default_dir)" -maxdepth 1 -name '*.dump' | wc -l | tr -d ' ')"
  [[ "${remaining}" == "3" ]] || {
    printf 'dumps moved: %s left at the default location\n' "${remaining}" >&2
    return 1
  }
}

@test "AC-C2(4b) the populated census is *.dump, wider than the rotation glob" {
  # A directory holding only hand-kept dumps — outside pg-backup.sh's
  # glass_atrium-[0-9]*.dump rotation — must still read as populated, or the
  # resolver would abandon exactly the archive nobody can regenerate.
  mkdir -p -- "${WORK}/stale-render" "$(backup_default_dir)"
  : >"$(backup_default_dir)/keep-forever.dump"
  backup_fixture "${WORK}/stale-render/postgres"
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a non-rotation dump must still count as populated; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"resolved=1"* ]] || {
    printf 'the census missed the non-rotation dump: %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2(5a) a relative value -> default + WARN naming the reason" {
  mkdir -p -- "${WORK}/ga"
  backup_fixture "relative/backups"
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a relative value must never be adopted; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"not an absolute path"* ]] || {
    printf 'the WARN must name the reason: %s\n' "${stderr}" >&2
    return 1
  }
  [[ ! -e "${WORK}/relative" && ! -e "relative/backups" ]] || {
    printf 'a relative value produced a directory somewhere — resolution must not write\n' >&2
    return 1
  }
}

@test "AC-C2(5b) a declared-but-empty value -> default + WARN naming ITS OWN reason" {
  mkdir -p -- "${WORK}/ga"
  backup_fixture ""
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'want the default, got %s\n' "${output}" >&2
    return 1
  }
  [[ -n "${stderr}" ]] || {
    printf 'a declared-but-empty value is a misconfiguration and must warn\n' >&2
    return 1
  }
  # The reason has to name the shape the operator actually has. An empty value is not
  # "not an absolute path" — that reason sends them looking for a path to fix, and the
  # reconciler and doctor rows quote this same classification back at them.
  [[ "${stderr}" == *"declared with an empty value"* ]] || {
    printf 'the WARN must give the empty declaration its own reason: %s\n' "${stderr}" >&2
    return 1
  }
  [[ "${stderr}" != *"not an absolute path"* ]] || {
    printf 'an empty value must not be reported as a relative path: %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2(5c) an UNDECLARED key -> default, silent (fresh-clone safety)" {
  mkdir -p -- "${WORK}/ga"
  backup_fixture "${BK_CFG_ABSENT}"
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'want the default, got %s\n' "${output}" >&2
    return 1
  }
  [[ -z "${stderr}" ]] || {
    printf 'an absent key is the stock shape and must stay silent: %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2 the WARN is emitted once per shell, not once per resolution" {
  mkdir -p -- "${WORK}/stale-render"
  seed_dumps "$(backup_default_dir)" 1
  backup_fixture "${WORK}/stale-render/postgres"
  run --separate-stderr env -u GA_DB_BACKUP_DIR \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash -c 'source "$1"; atrium_backup_dir >/dev/null; atrium_backup_dir >/dev/null' \
    _ "${REAL_LIB}"
  local warns
  warns="$(printf '%s\n' "${stderr}" | grep -c 'backup_dir=' || true)"
  [[ -n "${warns}" ]] || warns=0
  [[ "${warns}" -eq 1 ]] || {
    printf 'want exactly 1 WARN across two resolutions, got %s:\n%s\n' "${warns}" "${stderr}" >&2
    return 1
  }
}

@test "AC-C2 GA_DB_BACKUP_DIR outranks the config and never warns" {
  # The seam names a destination the caller is acting on right now, which is the
  # state the adoption rule has to infer — so it is taken verbatim.
  seed_dumps "$(backup_default_dir)" 2
  backup_fixture "${WORK}/stale-render/postgres"
  run --separate-stderr env GA_DB_BACKUP_DIR="${WORK}/seam-target" \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash -c 'source "$1"; atrium_backup_dir' _ "${REAL_LIB}"
  [[ "${output}" == "${WORK}/seam-target" ]] || {
    printf 'the seam must win verbatim; got %s\n' "${output}" >&2
    return 1
  }
  [[ -z "${stderr}" ]] || {
    printf 'the seam path must not warn: %s\n' "${stderr}" >&2
    return 1
  }
}

# --- atrium_backup_dir: case-6 adoption guardrails (CWE-59 / CWE-377) ---------
#
# The adoption rule decides on filesystem STATE, and every probe it runs follows
# symlinks — so the value has to be RESOLVED before it is judged, and the directory
# that would actually be written has to be the operator's own. Each test below is red
# on the unguarded resolver: drop the dot-segment arm and 6a adopts, drop the
# canonicalizer and 6b reports the link instead of its target, drop the safety
# predicate and 6c/6d/6e adopt a directory a second local user can write.
#
# BATS GATING NOTE (as above): a bare non-final `[[ ]]` does NOT gate the verdict, so
# every assertion `return 1`s with its own message.

@test "AC-C2(6a) a '..' or '.' segment is declined with its own reason" {
  local value
  for value in "${WORK}/real/../evil" "${WORK}/./real"; do
    backup_fixture "${value}"
    backup_resolve
    [[ "${output}" == "$(backup_default_dir)" ]] || {
      printf '%s must not be adopted; got %s\n' "${value}" "${output}" >&2
      return 1
    }
    [[ "${stderr}" == *"'.' or '..' path segment"* ]] || {
      printf 'the decline must name the dot-segment reason for %s; got %s\n' "${value}" "${stderr}" >&2
      return 1
    }
  done
}

@test "AC-C2(6b) a symlinked destination resolves to its TARGET before adoption" {
  # The consumers open what the link points at, so the resolver has to report that
  # path — reporting the link would have the WARN, doctor and the reconciler all
  # naming a location no dump is written to.
  mkdir -p -- "${WORK}/real-target"
  ln -sfn "${WORK}/real-target" "${WORK}/link-dir"
  backup_fixture "${WORK}/link-dir"
  backup_resolve
  [[ "${output}" == "${WORK}/real-target" ]] || {
    printf 'want the resolved target %s, got %s\n' "${WORK}/real-target" "${output}" >&2
    return 1
  }
  [[ -z "${stderr}" ]] || {
    printf 'a safe symlinked destination must adopt silently: %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2(6c) a world-writable non-sticky PARENT is declined (creatable arm)" {
  # The creatable arm is the only one that leads to a directory being created, so the
  # parent decides who could have pre-placed the dump's name there.
  mkdir -p -- "${WORK}/open-parent"
  chmod 0777 "${WORK}/open-parent"
  backup_fixture "${WORK}/open-parent/dumps"
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a world-writable parent must not be adopted; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"parent directory is not owned"* ]] || {
    printf 'the decline must name the parent reason; got %s\n' "${stderr}" >&2
    return 1
  }
  [[ ! -e "${WORK}/open-parent/dumps" ]] || {
    printf 'the probe must stay read-only — it created %s\n' "${WORK}/open-parent/dumps" >&2
    return 1
  }
}

@test "AC-C2(6d) a world-writable non-sticky EXISTING destination is declined" {
  mkdir -p -- "${WORK}/open-dir"
  chmod 0777 "${WORK}/open-dir"
  backup_fixture "${WORK}/open-dir"
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a 0777 destination must not be adopted; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"directory is not owned"* ]] || {
    printf 'the decline must name the destination reason; got %s\n' "${stderr}" >&2
    return 1
  }
}

@test "AC-C2(6e) the sticky bit alone does not admit a FOREIGN-owned parent" {
  # A genuine owner mismatch, constructible without root: /tmp is root-owned and 1777
  # on both platforms this runs on. Sticky stops one local user REPLACING another's
  # entry, not creating a name first, so ownership is the test that has to hold.
  # Nothing is created here — the resolver declines, and its probes are read-only.
  [[ ! -O /tmp ]] || skip "this runner owns /tmp, so no owner mismatch is available"
  backup_fixture "/tmp/atrium-config-bats-never-created"
  backup_resolve
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a foreign-owned sticky parent must not be adopted; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"parent directory is not owned"* ]] || {
    printf 'the decline must name the parent reason; got %s\n' "${stderr}" >&2
    return 1
  }
  [[ ! -e "/tmp/atrium-config-bats-never-created" ]] || {
    printf 'the probe must stay read-only — it created a directory under /tmp\n' >&2
    return 1
  }
}

@test "AC-C2(6f) canonicalization never rescues a RELATIVE value" {
  # Ordering contract: the shape arms run BEFORE the canonicalizer, which resolves
  # against the current directory. Reverse the two and a relative value becomes an
  # absolute one under whatever cwd the nightly job happens to have.
  mkdir -p -- "${WORK}/cwd-here/relative-dumps"
  backup_fixture "relative-dumps"
  run --separate-stderr env -u GA_DB_BACKUP_DIR \
    ATRIUM_CONFIG_TOML="${WORK}/config.toml" GA_DATA_ROOT="${WORK}/ga" \
    bash -c 'cd "$2" || exit 1; source "$1"; atrium_backup_dir' \
    _ "${REAL_LIB}" "${WORK}/cwd-here"
  [[ "${output}" == "$(backup_default_dir)" ]] || {
    printf 'a relative value must stay declined; got %s\n' "${output}" >&2
    return 1
  }
  [[ "${stderr}" == *"not an absolute path"* ]] || {
    printf 'the decline must keep the relative reason; got %s\n' "${stderr}" >&2
    return 1
  }
}
