#!/usr/bin/env bash
# shellcheck shell=bash
# fakechat-cleanup.sh — frees a fakechat HTTP port: its listener owner's process tree + the
# port-keyed spawn-unix helper. Port-scoped by design — a fakechat channel's port rides an env
# var, not argv, so a `plugin:fakechat@` cmdline match would reach fakechat sessions on every port.
# Safe under a strict caller (`set -Eeuo pipefail` + ERR trap) or a non-strict one: probes +
# signals `|| true`-guarded, no bare `(( ))`, no arrays (bash 3.2 `set -u`), `set -e` never toggled.

# _fakechat_log MSG… — the caller's log() when defined, else a stderr line (standalone source).
_fakechat_log() {
  if declare -f log >/dev/null 2>&1; then
    log "$@"
  else
    printf '%s\n' "$*" >&2
  fi
}

# _fakechat_descendants PID — echo PID and its ENTIRE downward process subtree, one
# PID per line, via pgrep -P recursion. Snapshotted BEFORE any signal because
# children reparent to PID 1 the instant the parent is TERMed. `|| true` absorbs a
# no-child pgrep miss (exit 1) so a set -e / ERR-trap caller never trips.
_fakechat_descendants() {
  local pid="$1" children child
  printf '%s\n' "${pid}"
  children="$(pgrep -P "${pid}" 2>/dev/null || true)"
  [[ -n "${children}" ]] || return 0
  while IFS= read -r child; do
    [[ -n "${child}" ]] || continue
    _fakechat_descendants "${child}"
  done <<EOF
${children}
EOF
  return 0
}

# _fakechat_signal_pids SIGNAL PIDS — send SIGNAL (TERM/KILL) to each newline-separated
# PID; `|| true`-guarded so a dead pid never trips a set -e / ERR-trap caller, blank
# lines skipped, list consumed via the `while read <<EOF` here-doc idiom (no arrays).
_fakechat_signal_pids() {
  local signal="$1" pid
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill "-${signal}" "${pid}" 2>/dev/null || true
  done <<EOF
$2
EOF
}

# fakechat_free_port PORT — TERM → settle-poll → KILL → re-lsof race-closer over PORT's listener
# owner tree + its port-keyed spawn-unix helper. The owner is never identified → an ungated call
# signals any unrelated listener on PORT; callers gate it (uninstall, or observed retired residue).
# Best-effort: always returns 0, so a teardown never aborts on a reap hiccup.
fakechat_free_port() {
  local port="${1:-}"
  # a non-integer / out-of-range port is a caller bug — loud-log + no-op (NEVER
  # signal on a garbage port). Best-effort, so still return 0.
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    _fakechat_log "fakechat_free_port: invalid port '${port}' — skipping"
    return 0
  fi

  # 1. The listener owner(s), reached DIRECTLY by port (argv-independent — the bun
  #    child holds 127.0.0.1:<port>). lsof exits 1 on no-listener → || true.
  local owner
  owner="$(lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"

  # 2. Build the kill set (snapshot BEFORE signalling): each owner's whole subtree +
  #    the PORT-KEYED spawn-unix helper (port-keyed so a peer daemon's helper on a
  #    DIFFERENT port is never matched).
  local kill_set="" owner_pid helpers
  if [[ -n "${owner}" ]]; then
    while IFS= read -r owner_pid; do
      [[ -n "${owner_pid}" ]] || continue
      kill_set="${kill_set}$(_fakechat_descendants "${owner_pid}")"$'\n'
    done <<EOF
${owner}
EOF
  fi
  helpers="$(pgrep -f "spawn-unix-fd.py ${port} " 2>/dev/null || true)"
  [[ -n "${helpers}" ]] && kill_set="${kill_set}${helpers}"$'\n'

  # de-dup (owner subtree + helper can overlap), dropping blank lines.
  local uniq_pids
  uniq_pids="$(printf '%s\n' "${kill_set}" | awk 'NF && !seen[$0]++' || true)"
  if [[ -z "${uniq_pids}" ]]; then
    _fakechat_log "fakechat port ${port} already free (no listener, no spawn helper)"
    return 0
  fi

  # 3. TERM the whole set.
  _fakechat_log "freeing fakechat port ${port} — TERM: ${uniq_pids//$'\n'/ }"
  _fakechat_signal_pids TERM "${uniq_pids}"

  # settle-poll — bounded by a SECONDS-delta wall-clock ceiling (repo idiom, NOT a
  # bare (( )) that would exit a set -e caller on a 0 result). Re-snapshot the
  # listener each iteration; break the instant the port frees.
  local ceiling="${FAKECHAT_PORT_FREE_TIMEOUT_SECS:-5}" started="${SECONDS}"
  while [[ "$((SECONDS - started))" -lt "${ceiling}" ]]; do
    if [[ -z "$(lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)" ]]; then
      break
    fi
    sleep 1
  done

  # 4. KILL any of the set that ignored TERM (a helper/descendant holds no port, so a
  #    port re-probe can't catch it — force it here).
  _fakechat_signal_pids KILL "${uniq_pids}"

  # 5. Race-closer: re-lsof for the CURRENT owner and KILL it — a SO_REUSEADDR
  #    re-binder can grab the socket between the TERM and now.
  local survivor
  survivor="$(lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${survivor}" ]]; then
    _fakechat_log "fakechat port ${port} still held after settle — KILL: ${survivor//$'\n'/ }"
    _fakechat_signal_pids KILL "${survivor}"
  fi
  return 0
}
