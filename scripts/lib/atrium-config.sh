#!/usr/bin/env bash
# atrium-config.sh — read-only config.toml accessors shared by shell consumers
# (daemon bootstraps/healthchecks, inject, daily-restart, wiki-compile,
# render-monitor-env.sh). Sourced, not executable. config.toml is the upper SoT;
# every accessor takes a caller-supplied default, so a checkout without a rendered
# config.toml (or a missing key) preserves stock behavior (fresh-clone safety).
#
# Parsing: table-scoped awk (no TOML-parser dep) — a same-named key in another
# section can never collide ([ports].monitor vs [paths].monitor). Config path:
# ATRIUM_CONFIG_TOML (test override) → ${GA_ROOT:-$HOME/.glass-atrium}/config.toml.
#
# Two accessors are more than defaulted reads and carry their own contracts below:
# atrium_monitor_port (ADR-1 precedence, loud on a configured invalid) and
# atrium_backup_dir (ADR-6 existence/population adoption, loud fallback).

# Resolved config.toml path (may not exist — accessors degrade to defaults).
atrium_config_file() {
  printf '%s\n' "${ATRIUM_CONFIG_TOML:-${GA_ROOT:-${HOME}/.glass-atrium}/config.toml}"
}

# Raw table-scoped read: echoes the value (quotes + trailing comment stripped),
# empty when the file or key is absent. Args: $1 = table header literal
# (e.g. "[ports]") · $2 = key name.
atrium_toml_get() {
  local section="$1" key="$2" config_file
  config_file="$(atrium_config_file)"
  [[ -f "${config_file}" ]] || return 0
  awk -v want="${section}" -v key="${key}" '
    /^[[:space:]]*\[/ { cur = $0; gsub(/[[:space:]]/, "", cur) }
    cur == want && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      val = $0
      sub(/^[^=]*=[[:space:]]*/, "", val)
      sub(/[[:space:]]*(#.*)?$/, "", val)
      gsub(/^"|"$/, "", val) # strip surrounding double quotes (strings are quoted)
      print val
      exit
    }
  ' "${config_file}"
}

# Key enumeration: emits one sorted `<section literal><TAB><key>` pair per line
# for the TOML file in $1 (default: the resolved config.toml). The section stays
# a bracket literal because both consumer parsers take it verbatim as their
# first arg — a dot-flattened string cannot be turned back into that pair.
atrium_toml_keys() {
  local config_file="${1:-$(atrium_config_file)}"
  [[ -f "${config_file}" ]] || return 0
  _atrium_toml_scan_keys "${config_file}" 0
}

# Optional-key enumeration: same record format as atrium_toml_keys, restricted to the
# keys a bare `# ga:optional` line directly above them declares legitimately absent
# from a rendered config.toml. Kept beside the enumerator so a drift consumer never
# grows a second parser of the marker convention.
atrium_toml_optional_keys() {
  local config_file="${1:-$(atrium_config_file)}"
  [[ -f "${config_file}" ]] || return 0
  _atrium_toml_scan_keys "${config_file}" 1
}

# Private scanner behind both enumerators — one copy of the TOML grammar, so a
# widened key charclass can never make the all-keys and optional-keys views
# disagree (an optional key would then surface as drift). Args: $1 = file that
# exists · $2 = 1 to emit only `# ga:optional`-marked keys, 0 to emit every key.
# Comment lines are dropped whole: the template documents `time = "HH:MM"` in
# prose, and a `/=/` scan would emit that as a key of whatever section is open.
# The marker rule sits above the generic comment skip; a comment line always
# starts with '#' and never '[', so the section rule leads without ambiguity.
_atrium_toml_scan_keys() {
  local config_file="$1" marked_only="$2"
  # shellcheck disable=SC2312  # awk's status is irrelevant: no match is an empty key set, not an error
  awk -v marked_only="${marked_only}" '
    /^[[:space:]]*\[/ { cur = $0; gsub(/[[:space:]]/, "", cur); mark = 0; next }
    /^[[:space:]]*#[[:space:]]*ga:optional[[:space:]]*$/ { mark = 1; next }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*=/ {
      if (cur != "" && (!marked_only || mark)) {
        key = $0
        sub(/^[[:space:]]*/, "", key)
        sub(/[[:space:]]*=.*$/, "", key)
        printf "%s\t%s\n", cur, key
      }
      mark = 0
      next
    }
    { mark = 0 }
  ' "${config_file}" | LC_ALL=C sort -u
}

# Defaulted read: configured value when present, else $3 verbatim.
atrium_config_get() {
  local section="$1" key="$2" default="$3" val
  val="$(atrium_toml_get "${section}" "${key}")"
  if [[ -n "${val}" ]]; then
    printf '%s\n' "${val}"
  else
    printf '%s\n' "${default}"
  fi
}

# Port read: defaulted + bindable-integer guard. A CONFIGURED invalid is a user
# error — loud fail (rc 1), never a silent fallback that masks the misconfig.
atrium_config_port() {
  local section="$1" key="$2" default="$3" val
  val="$(atrium_config_get "${section}" "${key}" "${default}")"
  if ! [[ "${val}" =~ ^[0-9]+$ ]] || ((val < 1 || val > 65535)); then
    printf 'atrium-config: invalid %s.%s=%s in %s — must be an integer 1-65535\n' \
      "${section}" "${key}" "${val}" "$(atrium_config_file)" >&2
    return 1
  fi
  printf '%s\n' "${val}"
}

# Private bindable-port predicate — integer 1-65535. Returns 0/1, no output.
# Shared by atrium_monitor_port for the env / rendered-.env value guards
# (atrium_config_port keeps its own inline check untouched).
_atrium_port_is_valid() {
  local val="$1"
  [[ "${val}" =~ ^[0-9]+$ ]] && ((val >= 1 && val <= 65535))
}

# Resolved rendered monitor/.env path (may not exist — the resolver degrades to
# config.toml then the terminal default). ATRIUM_MONITOR_ENV env overrides for
# test/sandbox, mirroring the ATRIUM_CONFIG_TOML override on atrium_config_file.
atrium_monitor_env_file() {
  printf '%s\n' "${ATRIUM_MONITOR_ENV:-${GA_ROOT:-${HOME}/.glass-atrium}/monitor/.env}"
}

# Extract ATRIUM_MONITOR_PORT from a rendered monitor/.env (sibling idiom of
# lib/ga-db.sh). Echoes the value (empty when absent); last assignment wins
# (env-file override). Args: $1 = env file path (assumed to exist).
atrium_monitor_env_port() {
  local env_file="$1" val
  val="$(grep -E '^ATRIUM_MONITOR_PORT=[0-9]+$' -- "${env_file}" 2>/dev/null | tail -n 1 | cut -d= -f2 || true)"
  printf '%s\n' "${val}"
}

# Resolve the effective monitor port — the single shell SoT for the live port.
# Precedence (ADR-1): exported ATRIUM_MONITOR_PORT (the running monitor's bound
# value) → rendered monitor/.env → config.toml [ports].monitor → terminal default
# 16145. A CONFIGURED invalid (env or .env) is a user error → loud fail (rc 1),
# never a silent fallback. The literal 16145 lives HERE and NOWHERE else in shell.
atrium_monitor_port() {
  local val env_file
  # 1. exported env — the live monitor's bound value.
  if [[ -n "${ATRIUM_MONITOR_PORT:-}" ]]; then
    val="${ATRIUM_MONITOR_PORT}"
    if ! _atrium_port_is_valid "${val}"; then
      printf 'atrium-config: invalid ATRIUM_MONITOR_PORT=%s (env) — must be an integer 1-65535\n' \
        "${val}" >&2
      return 1
    fi
    printf '%s\n' "${val}"
    return 0
  fi
  # 2. rendered monitor/.env value.
  env_file="$(atrium_monitor_env_file)"
  if [[ -f "${env_file}" ]]; then
    val="$(atrium_monitor_env_port "${env_file}")"
    if [[ -n "${val}" ]]; then
      if ! _atrium_port_is_valid "${val}"; then
        printf 'atrium-config: invalid ATRIUM_MONITOR_PORT=%s in %s — must be an integer 1-65535\n' \
          "${val}" "${env_file}" >&2
        return 1
      fi
      printf '%s\n' "${val}"
      return 0
    fi
  fi
  # 3. config.toml [ports].monitor, terminal default 16145 (loud-fails invalids).
  atrium_config_port '[ports]' 'monitor' '16145'
}

# Escape ERE metacharacters so a config value embeds literally in a grep -E
# pattern (IANA tz ids may carry '+', e.g. Etc/GMT+9 — unescaped, detection
# would silently mismatch).
atrium_ere_escape() {
  printf '%s' "$1" | sed -e 's/[][\.^$|?*+(){}\\]/\\&/g'
}

# Detect the host IANA timezone from the /etc/localtime symlink, ANCHORED on the
# '/zoneinfo/' segment (zone = everything after it). Echoes the zone, empty on
# failure. The anchor is portable — macOS links under /var/db/timezone/zoneinfo/,
# Linux under /usr/share/zoneinfo/ — a fixed-prefix strip would break cross-OS.
# TZ-IMMUNE: a symlink read cannot be shadowed by the launchd TZ=UTC pin that
# fools runtime Intl, so this is the build-time PRIMARY host detector.
atrium_get_host_timezone() {
  local link zone
  # `|| true` absorbs a readlink failure INSIDE the substitution so a consumer
  # under `set -Eeuo pipefail` with an ERR trap gets no spurious error line.
  link="$(readlink /etc/localtime 2>/dev/null || true)"
  [[ -n "${link}" ]] || return 0
  case "${link}" in
    */zoneinfo/*) zone="${link##*/zoneinfo/}" ;; # everything after the anchor
    *) return 0 ;;                               # no anchor → no reliable zone
  esac
  [[ -n "${zone}" ]] || return 0
  printf '%s\n' "${zone}"
}

# Secondary host detection: Node's Intl-resolved timezone. Build-time only — a
# launchd-pinned TZ=UTC would make Intl echo 'UTC', so this runs ONLY as the
# fallback after the TZ-immune symlink read above. Absent node → empty (the
# resolver then drops to its last-resort; never a hard-fail).
atrium_get_node_timezone() {
  command -v node >/dev/null 2>&1 || return 0
  node -e 'const tz=Intl.DateTimeFormat().resolvedOptions().timeZone; if(tz)process.stdout.write(tz)' 2>/dev/null || true
}

# Host-tz detection cascade shared by both atrium_resolve_timezone branches:
# /etc/localtime symlink (TZ-immune primary) → Node Intl (secondary). Echoes the
# detected zone, empty on a full miss — NO last-resort here (the auto path
# appends Asia/Seoul, the explicit path uses the detected value only to warn).
_atrium_detect_host_tz() {
  local host_tz
  host_tz="$(atrium_get_host_timezone)"
  [[ -n "${host_tz}" ]] || host_tz="$(atrium_get_node_timezone)"
  printf '%s\n' "${host_tz}"
}

# Resolve a configured [meta].timezone to a CONCRETE IANA zone. 'auto'/empty →
# the host-detection cascade; an explicit value is returned verbatim. NEVER echoes
# literal 'auto' — downstream renders (.env, launchd plists) need a concrete zone
# (the monitor feeds it to Intl/PG, where 'auto' is invalid).
# Auto-path cascade: /etc/localtime symlink (TZ-immune primary) → Node Intl
# (secondary) → Asia/Seoul (last-resort, backward-compat); never hard-fails.
# An EXPLICIT value diverging from the detected host zone emits a one-line stderr
# WARNING (loud), then uses the explicit value; the auto path never warns.
# Args: $1 = configured value ('auto' | '' | explicit IANA name).
atrium_resolve_timezone() {
  local configured="${1:-}" host_tz
  if [[ -z "${configured}" || "${configured}" == "auto" ]]; then
    host_tz="$(_atrium_detect_host_tz)"
    [[ -n "${host_tz}" ]] || host_tz="Asia/Seoul"
    printf '%s\n' "${host_tz}"
    return 0
  fi
  # Explicit value: surface divergence (warn-only), then use it verbatim.
  host_tz="$(_atrium_detect_host_tz)"
  if [[ -n "${host_tz}" && "${host_tz}" != "${configured}" ]]; then
    printf 'atrium-config: WARNING: explicit [meta].timezone=%s differs from detected host tz %s — schedules/timestamps follow the explicit value\n' \
      "${configured}" "${host_tz}" >&2
  fi
  printf '%s\n' "${configured}"
}

# Resolve the effective ATRIUM_TIMEZONE for the quota-detection consumers
# (daemon-daily-restart.sh, wiki-daily-compile.sh): honor a pre-set ATRIUM_TIMEZONE
# verbatim, else resolve [meta].timezone (default 'auto') to a concrete host zone.
# WHY concrete: the REPL prints quota reset times in the HOST tz, so detection
# keys on the resolved zone — literal 'auto' never matches the quota greps, and a
# hardcoded Asia/Seoul silently breaks detection on non-KST deploys.
atrium_load_timezone() {
  printf '%s\n' "${ATRIUM_TIMEZONE:-$(atrium_resolve_timezone "$(atrium_config_get '[meta]' 'timezone' 'auto')")}"
}

# Resolve the daemon "haiku" cheap-model id from the daemon-config.json SoT.
# Echoes the configured .haiku_model when jq + the file + a non-empty key are all
# present; else the alias-literal fallback. ALWAYS echoes a non-empty id and
# returns 0 (safe under set -e / command substitution / an ERR trap).
# Arg $1 = config path — each caller passes its OWN seam var; empty/absent → the
# canonical default. daemon-config.json mirrors hooks/daemon_config.py (Python SoT).
atrium_resolve_haiku_model() {
  local config_path="${1:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-config.json}"
  local model="claude-haiku-4-5" cfg_model
  if command -v jq >/dev/null 2>&1 && [[ -f "${config_path}" ]]; then
    cfg_model="$(jq -r '.haiku_model // empty' "${config_path}" 2>/dev/null || true)"
    [[ -n "${cfg_model}" ]] && model="${cfg_model}"
  fi
  printf '%s\n' "${model}"
}

# --- postgres backup directory (ADR-6) ---------------------------------------
#
# The single resolver for the pg_dump backup directory, replacing three sites that
# each derived it themselves. It adopts [paths].backup_dir on the FILESYSTEM STATE
# the value describes, never on a string comparison against the template default.
#
# WHY state and not a string. The knob's promise is that an operator may relocate
# the dumps, so a configured value that differs from the default has to be able to
# win. But a RENDERED config also holds values no one ever acted on, and adopting
# one of those silently relocates the nightly job: dumps start landing in the new
# directory, the 14-dump rotation restarts there, and every dump already written is
# outside both the rotation and any restore search. An absolute-path check does not
# separate the two cases — a value nobody acted on is absolute too.
#
# Adoption rule. The configured value wins when its directory EXISTS, or when it is
# creatable AND the default location holds no dumps. Otherwise the default wins and
# the resolver says so, once, on stderr.
#
#   case                                    | dir      | default dumps | resolves to
#   1 fresh install (value = the default)   | absent   | 0             | default, silent
#   2 a customization in use                | exists   | any           | configured
#   3 a customization not yet created       | absent   | 0             | configured
#   4 a value nobody acted on               | absent   | >0            | default + WARN
#   5 relative, empty, or not a directory   | -        | any           | default + WARN
#
# Honest limit: 3 and 4 are separated ONLY by the dump census, so a NEW relocation
# configured on an install that already holds dumps reads as 4 and is not honored
# until the operator reconciles. That is the intended trade — a loud non-adoption
# is recoverable in one command, a silent relocation is not.
#
# The populated predicate is `*.dump`, deliberately BROADER than pg-backup.sh's
# rotation glob `glass_atrium-[0-9]*.dump`: pre-uninstall and hand-kept dumps are
# outside the rotation, and a directory holding only those must still read as
# populated or the resolver would abandon exactly the archive nobody can regenerate.
#
# WARN scope: once per shell. A caller that resolves through command substitution
# runs the function in a subshell, where the guard cannot propagate back, so resolve
# ONCE per process and reuse the value — which is what each consumer site does.

# The fallback backup directory. ONE spelling, shared by the resolver, its WARN and
# the reconciler, so "the default location" cannot mean two paths.
atrium_backup_dir_default() {
  printf '%s\n' "${GA_DATA_ROOT:-${HOME}/.glass-atrium}/backups/postgres"
}

# Count the `*.dump` files directly under $1; 0 when the directory is absent.
# Non-recursive: nested paths are not what either the rotation or a restore reads.
atrium_backup_dump_count() {
  local dir="$1" count=0 entry
  [[ -d "${dir}" ]] || {
    printf '0\n'
    return 0
  }
  # An unmatched glob expands to the pattern itself (nullglob is not assumed, since
  # this is a sourced library and must not change the caller's shell options), so
  # every candidate is confirmed to be a real file before it counts.
  for entry in "${dir}"/*.dump; do
    [[ -f "${entry}" ]] || continue
    count=$((count + 1))
  done
  printf '%s\n' "${count}"
}

# NON-DESTRUCTIVE creatability probe: the parent exists and is writable.
#
# It MUST stay non-destructive. `mkdir -p` is the idiom at the consumer sites this
# resolver feeds, and calling it here would create the configured directory — which
# is the existence arm's input, so the next run would adopt the value on the
# strength of a directory this code made. The rule would then be unconditional
# adoption wearing a state check.
_atrium_dir_is_creatable() {
  local dir="$1"
  local parent="${dir%/*}"
  [[ "${parent}" != "${dir}" ]] || parent="." # no slash at all -> relative to cwd
  [[ -n "${parent}" ]] || parent="/"          # "/x" -> the parent is the root
  [[ -d "${parent}" && -w "${parent}" ]]
}

# Whether the config file DECLARES a key at all, distinct from declaring it empty.
# An absent key is fresh-clone safety and resolves silently; a key present with an
# empty value is a misconfiguration and earns the WARN (case 5). Reuses the shared
# enumerator rather than adding a second reader of the TOML grammar.
# Args: $1 = table header literal · $2 = key name.
_atrium_config_has_key() {
  local section="$1" key="$2" needle keys
  needle="${section}"$'\t'"${key}" # the enumerator's record separator, spelled once
  keys="$(atrium_toml_keys)"
  grep -qxF -- "${needle}" <<<"${keys}"
}

# One-line stderr WARN naming both paths, both dump censuses and the reason, so the
# operator can see which location holds the data without running anything first.
# Args: $1 configured · $2 resolved · $3 dumps at configured · $4 dumps at resolved
#       · $5 reason.
_atrium_backup_dir_warn() {
  local configured="$1" resolved="$2" cand_dumps="$3" resolved_dumps="$4" reason="$5"
  local target_home facade_note=""
  if [[ -n "${_ATRIUM_BACKUP_DIR_WARNED:-}" ]]; then
    return 0
  fi
  _ATRIUM_BACKUP_DIR_WARNED=1
  # A value under the install facade root is worth naming: the facade is a symlink
  # farm the installer owns, so a backup destination there is very likely a stale
  # render rather than a deliberate choice. Extra context only — the adoption rule
  # above reads state, and a stale value pointing elsewhere is caught the same way.
  target_home="$(atrium_config_get '[paths]' 'target_home' "${HOME}/.claude")"
  if [[ -n "${target_home}" && "${configured}" == "${target_home}/"* ]]; then
    facade_note=" [under the install facade root ${target_home}]"
  fi
  printf 'atrium-config: WARNING: [paths].backup_dir=%s not adopted (%s)%s — resolving to %s. dumps: configured=%s resolved=%s. Nothing was moved or created; run scripts/reconcile-backup-dir.sh to reconcile.\n' \
    "${configured}" "${reason}" "${facade_note}" "${resolved}" "${cand_dumps}" "${resolved_dumps}" >&2
}

# Resolve the effective pg_dump backup directory (contract + case table above).
# Precedence: exported GA_DB_BACKUP_DIR → [paths].backup_dir when the adoption rule
# admits it → the default location. Always echoes a path and returns 0.
atrium_backup_dir() {
  local default_dir configured default_dumps cand_dumps

  # 1. explicit seam — the caller's own override (sandbox, test, one-off restore).
  #    It names a destination the caller is acting on RIGHT NOW, which is the state
  #    the rule below has to infer, so it is taken verbatim and never warns.
  if [[ -n "${GA_DB_BACKUP_DIR:-}" ]]; then
    printf '%s\n' "${GA_DB_BACKUP_DIR}"
    return 0
  fi

  default_dir="$(atrium_backup_dir_default)"
  configured="$(atrium_toml_get '[paths]' 'backup_dir')"
  while [[ "${configured}" == */ && "${configured}" != "/" ]]; do
    configured="${configured%/}"
  done

  # 2. undeclared key → default, silent (fresh-clone safety, as every accessor here).
  if [[ -z "${configured}" ]] && ! _atrium_config_has_key '[paths]' 'backup_dir'; then
    printf '%s\n' "${default_dir}"
    return 0
  fi
  # 3. declared AT the default → the two agree, nothing to adopt or warn about.
  if [[ "${configured}" == "${default_dir}" ]]; then
    printf '%s\n' "${default_dir}"
    return 0
  fi

  # 4. POPULATION FIRST. The census at the default location is taken before any
  #    probe of the configured path: it decides the creatable arm below, and it is
  #    what the WARN has to report, so it is never conditional on the probes.
  default_dumps="$(atrium_backup_dump_count "${default_dir}")"
  cand_dumps="$(atrium_backup_dump_count "${configured}")"

  # 5. adoption rule.
  if [[ "${configured}" != /* ]]; then
    _atrium_backup_dir_warn "${configured}" "${default_dir}" "${cand_dumps}" "${default_dumps}" \
      "not an absolute path"
  elif [[ -d "${configured}" ]]; then
    printf '%s\n' "${configured}" # case 2 — the destination is real and in use
    return 0
  elif [[ -e "${configured}" ]]; then
    _atrium_backup_dir_warn "${configured}" "${default_dir}" "${cand_dumps}" "${default_dumps}" \
      "exists but is not a directory"
  elif _atrium_dir_is_creatable "${configured}" && [[ "${default_dumps}" -eq 0 ]]; then
    printf '%s\n' "${configured}" # case 3 — creatable, and no dumps are left behind
    return 0
  elif [[ "${default_dumps}" -ne 0 ]]; then
    _atrium_backup_dir_warn "${configured}" "${default_dir}" "${cand_dumps}" "${default_dumps}" \
      "directory absent while the default location already holds dumps"
  else
    _atrium_backup_dir_warn "${configured}" "${default_dir}" "${cand_dumps}" "${default_dumps}" \
      "directory absent and its parent is missing or not writable"
  fi

  printf '%s\n' "${default_dir}"
}
