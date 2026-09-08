#!/usr/bin/env bats
# read-key-esc-timeout.bats — falsifiable coverage for the read_key ESC-tail bug (a bare ESC
# keypress blocked read_key indefinitely, and >2-byte CSI tails leaked their terminator).
#
# ROOT CAUSE: on ESC, read_key did an UNBOUNDED `read -rsn2 rest <"${TTY}"`. A bare ESC (no CSI
# tail) left that read waiting for two bytes that never arrive — a permanent hang. Tilde-terminated
# CSI sequences (Home/End/PgUp = ESC [ N ~) delivered 3 bytes; reading only 2 left the trailing '~'
# in the input stream to be misread as the next keypress.
#
# FIX: bound the tail read with a bash-3.2-safe integer timeout (`read -rsn2 -t 1`) so a bare ESC
# falls through to 'none' within 1s, and drain the trailing byte when the tail is `[` + digit so the
# '~' of a tilde-terminated sequence is swallowed. The normal arrow path (ESC [ A/B) is unchanged.
#
# Run via: bats test/read-key-esc-timeout.bats
# Hermetic: extracts ONLY read_key into the test shell and drives it through a held-open FIFO that
# emulates the /dev/tty byte stream (each `read <"${TTY}"` reopen consumes the next buffered bytes).
# A foreground-poll watchdog bounds every drive so a regressed (unbounded) read FAILS instead of
# hanging the suite — this macOS bats has no coreutils `timeout`, so BATS_TEST_TIMEOUT is inert.
#
# ShellCheck: TTY is read by the dynamically-eval'd read_key, not this file (SC2154/SC2034); the
# $(...) captures in assertions deliberately mask return values (SC2312). Same dynamic-code class the
# sibling spinner-cursor-visibility.bats carries.
# shellcheck disable=SC2034,SC2154,SC2312

setup() {
  GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  TERM_LIB="${GA}/lib/ga-tui-term.sh"
  [[ -f "${TERM_LIB}" ]] || skip "term lib not found: ${TERM_LIB}"
  # the lib is strict-mode; suspend any inherited ERR trap defensively before eval.
  trap - ERR
  # eval ONLY read_key into the test shell (the terminal `}` is column-0; inner `  }` is indented).
  eval "$(awk 'index($0, "read_key() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${TERM_LIB}")"
  FIFO="${BATS_TEST_TMPDIR}/tty.fifo"
  mkfifo "${FIFO}"
  TTY="${FIFO}"
}

# _capture_bounded — run read_key in the background against the FIFO, polling for completion up to
# DEADLINE seconds. On overrun it TERM-kills read_key so a regressed unbounded read yields empty
# output (a failing assertion) rather than hanging the suite. Prints read_key's decoded output.
_capture_bounded() {
  local deadline="$1" outfile="${BATS_TEST_TMPDIR}/rk.out" rk i=0
  : >"${outfile}"
  read_key >"${outfile}" 2>/dev/null &
  rk=$!
  while kill -0 "${rk}" 2>/dev/null; do
    i=$((i + 1))
    if ((i > deadline * 5)); then
      kill -TERM "${rk}" 2>/dev/null || true
      break
    fi
    sleep 0.2
  done
  wait "${rk}" 2>/dev/null || true
  cat "${outfile}"
}

# _drive — feed BYTES into a held-open FIFO (fd 9 keeps the write end open across read_key's
# per-read reopens), then decode one key under the DEADLINE watchdog.
_drive() {
  local bytes="$1" deadline="${2:-3}" out
  exec 9<>"${FIFO}"
  printf '%b' "${bytes}" >&9
  out="$(_capture_bounded "${deadline}")"
  exec 9>&-
  printf '%s' "${out}"
}

# === dynamic — the arrow CSI path is unchanged (ESC [ A/B still decode) =================

@test "dynamic: arrow-up (ESC [ A) still decodes to 'up'" {
  [[ "$(_drive '\x1b[A')" == "up" ]] || return 1
}

@test "dynamic: arrow-down (ESC [ B) still decodes to 'down'" {
  [[ "$(_drive '\x1b[B')" == "down" ]] || return 1
}

# === dynamic — a bare ESC resolves to 'none' WITHIN the timeout (the core fix) ==========

@test "dynamic: a bare ESC resolves to 'none' within the timeout (no infinite block)" {
  # With the -t 1 bound this returns 'none'; a regressed unbounded read is killed by the
  # watchdog and yields empty output → this assertion fails (falsifiable, hang-safe).
  [[ "$(_drive '\x1b' 4)" == "none" ]] || return 1
}

# === dynamic — a tilde-terminated CSI drains its trailing '~' (no leak to next key) =====

@test "dynamic: tilde-terminated CSI (ESC [ 1 ~) decodes to 'none'" {
  [[ "$(_drive '\x1b[1~')" == "none" ]] || return 1
}

@test "dynamic: the trailing '~' is drained — a following key is read cleanly, not the '~'" {
  # ESC [ 3 ~ then 'q': if '~' leaked it would be consumed as the next read (→ 'none') and 'q'
  # would still be pending. A clean 'quit' proves the '~' was drained.
  exec 9<>"${FIFO}"
  printf '%b' '\x1b[3~' >&9
  local first second
  first="$(_capture_bounded 3)"
  printf '%b' 'q' >&9
  second="$(_capture_bounded 3)"
  exec 9>&-
  [[ "${first}" == "none" ]] || return 1
  [[ "${second}" == "quit" ]] || return 1
}

# === dynamic — the drain read is TIME-BOUND (unterminated ESC [ N tail) ================

@test "dynamic: an unterminated 'ESC [ 5' tail resolves to 'none' — the drain read is time-bound" {
  # ESC [ 5 with no '~' terminator. The tail matches '['[0-9] so read_key enters the drain
  # read, but the terminator byte never arrives. With the `-t 1` bound the drain times out and
  # 'none' is printed; strip that bound and the drain blocks until the watchdog kills read_key,
  # yielding empty output → this assertion fails. Every other row supplies the '~' the drain
  # consumes immediately, so this is the only case that reaches the drain read's timeout.
  [[ "$(_drive '\x1b[5' 4)" == "none" ]] || return 1
}

# === dynamic — non-ESC keys are untouched by the change ================================

@test "dynamic: j/k/Enter/q decode unchanged" {
  [[ "$(_drive 'k')" == "up" ]] || return 1
  [[ "$(_drive 'j')" == "down" ]] || return 1
  [[ "$(_drive 'q')" == "quit" ]] || return 1
  [[ "$(_drive '\r')" == "enter" ]] || return 1
}
