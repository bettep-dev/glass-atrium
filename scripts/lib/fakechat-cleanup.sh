#!/usr/bin/env bash
# shellcheck shell=bash
# fakechat-cleanup.sh — shared, STRICTLY PORT-SCOPED reap of the orphan bun MCP
# child that squats a daemon's fakechat HTTP port after its tmux session dies.
#
# The confirmed failure: rapidly restarting the autoagent/wiki daemons leaves the
# bun fakechat server reparented to PID 1, still bound to 127.0.0.1:<port>
# (autoagent 8787 / wiki 8788, config.toml [ports].{autoagent,wiki}_fakechat). The
# next `claude --channels plugin:fakechat` session's own bun child then hits
# EADDRINUSE and never binds within the cold-start budget. This lib reaps that
# squatter so the fresh child can bind.
#
# WHY port-scoped (the load-bearing safety property): both daemons run the
# IDENTICAL command line `claude --channels plugin:fakechat@claude-plugins-official`
# — the per-role port is injected via the tmux `-e FAKECHAT_PORT=` ENV, NOT argv. So
# a `pgrep -f 'plugin:fakechat@'` match is PORT-BLIND and would TERM the LIVE HEALTHY
# PEER daemon on every restart. This lib NEVER does a plugin:fakechat@ cmdline match:
# it reaches the owner DIRECTLY by port (lsof -iTCP), and its only cmdline match (the
# spawn-unix helper) is port-keyed.
#
# STRICT-MODE SAFE (sourced BOTH under the daemon bootstrap's `set -Eeuo pipefail` +
# ERR trap AND under the non-strict ga install/uninstall domain): every lsof/pgrep/
# kill is `|| true`-guarded, the settle-poll uses the `[[ $((...)) ]]` wall-clock
# idiom (never a bare `(( ))` whose 0-result would exit a `set -e` caller), and PID
# lists are consumed via the `while read <<EOF` here-doc idiom. It NEVER toggles
# `set -e` (that would corrupt the caller's shell mode) and uses NO arrays (a bash
# 3.2 `set -u` empty-array expansion aborts "unbound").

# _fakechat_log MSG… — route through the caller's log() when present (daemon
# bootstrap: role-tagged; ga domain: stderr), else a plain stderr line so the lib is
# self-contained when sourced standalone.
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

# fakechat_free_port PORT — reap whatever squats fakechat PORT: the lsof-identified
# listener owner + its descendant tree + the port-keyed spawn-unix helper debris.
# Escalates TERM → settle-poll → KILL → re-lsof race-closer. Best-effort: ALWAYS
# returns 0 (a teardown / bootstrap reclaim must never abort on a reap hiccup).
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
  local pid
  _fakechat_log "freeing fakechat port ${port} — TERM: ${uniq_pids//$'\n'/ }"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -TERM "${pid}" 2>/dev/null || true
  done <<EOF
${uniq_pids}
EOF

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
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -KILL "${pid}" 2>/dev/null || true
  done <<EOF
${uniq_pids}
EOF

  # 5. Race-closer: re-lsof for the CURRENT owner and KILL it — a SO_REUSEADDR
  #    re-binder can grab the socket between the TERM and now.
  local survivor
  survivor="$(lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${survivor}" ]]; then
    _fakechat_log "fakechat port ${port} still held after settle — KILL: ${survivor//$'\n'/ }"
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] || continue
      kill -KILL "${pid}" 2>/dev/null || true
    done <<EOF
${survivor}
EOF
  fi
  return 0
}
