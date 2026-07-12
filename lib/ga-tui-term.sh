# shellcheck shell=bash
# shellcheck disable=SC2154  # reads shared TTY global assigned by the loader at runtime; unresolvable standalone
# Glass Atrium launcher — terminal-lifecycle + input module. SOURCED (never executed):
# shebang/strict-mode/IFS/traps/TTY_SAVED/RAW_ACTIVE stubs stay loader-owned so
# re-sourcing never re-arms. Enters/leaves raw + alt-screen (ui_init/restore_terminal,
# the latter via the loader's cleanup trap) + reads one decoded key (read_key).

# terminal lifecycle
# Capture stty, enter raw + alt-screen, hide cursor. Restore trap armed IMMEDIATELY
# after the stty snapshot so any later failure unwinds cleanly.
ui_init() {
  TTY_SAVED="$(stty -g <"${TTY}")"
  stty -echo -icanon <"${TTY}" # raw-ish: no echo, char-at-a-time
  tp smcup                     # enter alternate screen
  tp civis                     # hide cursor
  tp clear
  RAW_ACTIVE=true
}

# Unconditional restore — runs on EXIT/INT/TERM/error via cleanup(). Idempotent:
# safe to call even if ui_init never engaged raw mode (RAW_ACTIVE false -> skip).
restore_terminal() {
  [[ "${RAW_ACTIVE}" != "true" ]] && return 0
  RAW_ACTIVE=false
  tp cnorm # show cursor
  tp sgr0  # reset all SGR
  tp rmcup # leave alternate screen
  [[ -n "${TTY_SAVED}" ]] && stty "${TTY_SAVED}" <"${TTY}" 2>/dev/null || true
}

# input
# Read one key from /dev/tty. Decode arrow keys (ESC [ A/B) and j/k/Enter/q.
# Returns one of: up down enter quit none. bash-3.2: no fractional read -t, so
# on ESC the CSI tail read carries a 1s integer timeout — a bare ESC resolves to
# 'none' within 1s instead of blocking, and a tilde-terminated tail (ESC [ N ~)
# is drained so its '~' isn't misread as the next key.
read_key() {
  local key rest
  IFS= read -rsn1 key <"${TTY}" || {
    printf 'quit'
    return 0
  }
  case "${key}" in
    $'\x1b') # ESC — possible arrow CSI sequence
      # 1s integer timeout: a bare ESC has no CSI tail, so an unbounded read here
      # blocks forever — the timeout lets it fall through to 'none' within 1s.
      IFS= read -rsn2 -t 1 rest <"${TTY}" || rest=""
      case "${rest}" in
        '[A') printf 'up' ;;
        '[B') printf 'down' ;;
        '['[0-9])
          # Tilde-terminated CSI (Home/End/PgUp = ESC [ N ~): drain the trailing
          # '~' so it isn't consumed as the next keypress; still an unhandled key.
          IFS= read -rsn1 -t 1 _ <"${TTY}" || true
          printf 'none'
          ;;
        *) printf 'none' ;; # bare ESC or unknown sequence
      esac
      ;;
    $'\n' | $'\r' | '') printf 'enter' ;;
    k | K) printf 'up' ;;
    j | J) printf 'down' ;;
    q | Q) printf 'quit' ;;
    *) printf 'none' ;;
  esac
}
