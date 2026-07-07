# shellcheck shell=bash
# shellcheck disable=SC2154  # reads the shared TTY global assigned by the glass-atrium loader, present at runtime after the loader sources every TUI module, unresolvable when linted standalone
# Glass Atrium launcher — terminal-lifecycle + input module. SOURCED by the
# glass-atrium entry point (never executed): the shebang, strict mode, IFS, traps
# and the TTY_SAVED/RAW_ACTIVE state stubs stay loader-owned so re-sourcing never
# re-arms them. Enters/leaves raw + alternate-screen mode (ui_init / restore_terminal,
# the latter called from the loader's cleanup trap) and reads one decoded key from
# /dev/tty (read_key), mutating the loader's file-scope UI state at call time.

# === terminal lifecycle ====================================================
# Capture stty, enter raw + alt-screen, hide cursor. The restore trap is armed
# IMMEDIATELY after the stty snapshot so any later failure unwinds cleanly.
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

# === input =================================================================
# Read one key from /dev/tty. Decode arrow keys (ESC [ A/B) and j/k/Enter/q.
# Returns one of: up down enter quit none. bash-3.2: no fractional read -t, so
# we read 1 byte then, on ESC, read the 2-byte CSI tail in canonical chunks.
read_key() {
  local key rest
  IFS= read -rsn1 key <"${TTY}" || {
    printf 'quit'
    return 0
  }
  case "${key}" in
    $'\x1b') # ESC — possible arrow CSI sequence
      IFS= read -rsn2 rest <"${TTY}" || rest=""
      case "${rest}" in
        '[A') printf 'up' ;;
        '[B') printf 'down' ;;
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
