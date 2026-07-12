#!/usr/bin/env bats
# track-outcome-parent-tail-read.bats — PERF-INVARIANT + CORRECTNESS for the bounded reverse
# tail-read of the PARENT transcript on the regex correction-fallback path (T9 block,
# find_last_user_message / resolve_last_user_message).
#
# WAS: find_last_user_message() did a full readlines() of the parent transcript to locate the
# LAST (most recent) user message that drives the correction verdict. NOW: the last user message
# sits near EOF, so a bounded reverse tail window is scanned first (no full read of a large
# transcript). CORRECTNESS: a window that does not cover the whole file AND yields no user message
# falls back to the full read — so the resolved message (and thus the evaluative_signal/-1 +
# revision_count + directive_hint correction verdict) is byte-identical to the full-read baseline.
#
# Method: the REAL T9 python block is extracted from the live track-outcome.sh at setup (so this
# tests production code, not a copy) and driven directly with a controlled env. A sitecustomize.py
# shim on PYTHONPATH wraps builtins.open and tallies the bytes returned by .read() for the parent
# transcript basename, so a full read (bytes ~= file size) is distinguishable from a bounded tail
# read (bytes <= window). The T9 python emits @@stage1_matched@@ / @@last_user_text@@ on stdout —
# the resolved message + correction verdict are read straight off that surface (no DB needed).
#
# Assertions: (1) tail read resolves identically to the full-read baseline (correction near EOF);
# (2) window-MISS falls back to the full read (correction before the window) — still resolved;
# (3) the common path does NOT fully read the parent transcript (bounded read); (4) the per-session
# cache reuses a prior resolve (second fire reads ZERO transcript bytes).

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"

  TR_TMP="$(mktemp -d)"
  SANDBOX_HOME="${TR_TMP}/home"
  CACHE_TMP="${TR_TMP}/cache"
  SHIM_DIR="${TR_TMP}/pyshim"
  READ_LOG="${TR_TMP}/read_bytes.log"
  T9_PY="${TR_TMP}/t9.py"
  mkdir -p "${SANDBOX_HOME}" "${CACHE_TMP}" "${SHIM_DIR}"

  # Extract the REAL T9 python block (between its heredoc markers) from the live hook.
  awk '
    /T9_PY_FILE" <</ { grab = 1; next }
    grab && $0 == "PYEOF" { grab = 0 }
    grab { print }
  ' "${HOOK_SH}" >"${T9_PY}"
  [[ -s "${T9_PY}" ]] || skip "could not extract T9 python block (heredoc markers changed?)"

  # sitecustomize read-byte counter (auto-imported by CPython's site machinery when on PYTHONPATH).
  cat >"${SHIM_DIR}/sitecustomize.py" <<'PY'
import builtins
import os

_real_open = builtins.open
_counter = os.environ.get("READ_BYTES_FILE", "")
_target = os.environ.get("READ_TARGET", "")


class _CountingFile:
    def __init__(self, f):
        self._f = f

    def read(self, *a, **k):
        data = self._f.read(*a, **k)
        try:
            if _counter:
                with _real_open(_counter, "a", encoding="utf-8") as cf:
                    cf.write(str(len(data)) + "\n")
        except Exception:
            pass
        return data

    def __getattr__(self, name):
        return getattr(self._f, name)

    def __enter__(self):
        self._f.__enter__()
        return self

    def __exit__(self, *a):
        return self._f.__exit__(*a)

    def __iter__(self):
        return iter(self._f)


def _counting_open(file, *a, **k):
    f = _real_open(file, *a, **k)
    if _target and isinstance(file, str) and file.endswith(_target):
        return _CountingFile(f)
    return f


builtins.open = _counting_open
PY
}

teardown() {
  if [[ -n "${TR_TMP:-}" && -d "${TR_TMP}" ]]; then
    rm -rf "${TR_TMP}"
  fi
}

# Build a transcript whose LAST (most recent) user message is a correction near EOF, preceded by
# `pad_pairs` large assistant/tool_result pairs (so the file is far larger than the tail window).
make_transcript_msg_at_eof() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
path, pad_pairs = sys.argv[1], int(sys.argv[2])
with open(path, "w", encoding="utf-8") as f:
    f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "initial delegation prompt"}}) + "\n")
    blob = "pad " * 40
    for i in range(pad_pairs):
        f.write(json.dumps({"type": "assistant", "message": {"role": "assistant",
                "content": [{"type": "text", "text": blob + str(i)}]}}) + "\n")
        f.write(json.dumps({"type": "user", "message": {"role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "t", "content": "ok " * 40}]}}) + "\n")
    # Most-recent USER message = the correction (KOR redo-verb binding → stage1 match).
    f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "다시 해줘 please redo this"}}) + "\n")
PY
}

# Build a transcript whose last user message is a correction FIRST, followed by `pad` large
# assistant lines — so the last user message is BEFORE any small tail window (forces the fallback).
make_transcript_msg_before_window() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
path, pad = sys.argv[1], int(sys.argv[2])
with open(path, "w", encoding="utf-8") as f:
    f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "try again redo this approach"}}) + "\n")
    blob = "z" * 200
    for i in range(pad):
        f.write(json.dumps({"type": "assistant", "message": {"role": "assistant",
                "content": [{"type": "text", "text": blob + str(i)}]}}) + "\n")
PY
}

# Drive the extracted T9 python with a controlled env. $1=transcript $2=window_bytes $3=session_id.
# HOME is sandboxed (no real outcome/cache reads), TMPDIR isolates the per-session cache, PGHOST is
# irrelevant (T9 python has no DB path). READ_TARGET/READ_BYTES_FILE arm the read-byte shim.
run_t9() {
  : >"${READ_LOG}"
  run env \
    HOME="${SANDBOX_HOME}" \
    PYTHONPATH="${SHIM_DIR}" \
    TMPDIR="${CACHE_TMP}" \
    READ_TARGET="${1##*/}" \
    READ_BYTES_FILE="${READ_LOG}" \
    T9_TRANSCRIPT="${1}" \
    T9_TAIL_WINDOW_BYTES="${2}" \
    T9_SESSION_ID="${3}" \
    T9_CWD="${SANDBOX_HOME}" \
    T9_TASK_TYPE="feature" \
    python3 "${T9_PY}"
}

# Extract an @@key@@ field from the captured T9 stdout (${output}).
t9_field() {
  printf '%s\n' "${output}" | sed -n "s/^@@${1}@@//p" | head -1
}

# Sum the bytes recorded by the read-byte shim (one integer per .read() on the parent basename).
read_bytes() {
  local sum=0 n
  if [[ -f "${READ_LOG}" ]]; then
    while IFS= read -r n; do
      case "${n}" in
        '' | *[!0-9]*) continue ;;
      esac
      sum=$((sum + n))
    done <"${READ_LOG}"
  fi
  printf '%s\n' "${sum}"
}

@test "tail-read resolves the last user message identically to the full-read baseline (correction near EOF)" {
  TR="${TR_TMP}/at_eof.jsonl"
  make_transcript_msg_at_eof "${TR}" 5000
  local fsize
  fsize=$(wc -c <"${TR}")
  [ "${fsize}" -gt 200000 ] || return 1 # fixture must be far larger than the tail window

  # Bounded tail read (session disabled → no cache, pure live resolve).
  run_t9 "${TR}" 65536 ""
  [ "${status}" -eq 0 ] || return 1
  local tail_stage1 tail_text
  tail_stage1=$(t9_field stage1_matched)
  tail_text=$(t9_field last_user_text)

  # Full-read baseline: an oversized window forces whole_file=True (the prior readlines() behavior).
  run_t9 "${TR}" 100000000 ""
  [ "${status}" -eq 0 ] || return 1
  local base_stage1 base_text
  base_stage1=$(t9_field stage1_matched)
  base_text=$(t9_field last_user_text)

  # Byte-identical resolution + identical correction verdict (stage1 match) between tail and baseline.
  [ "${tail_stage1}" = "1" ] || return 1
  [ "${base_stage1}" = "1" ] || return 1
  [ "${tail_text}" = "${base_text}" ] || return 1
  [[ "${tail_text}" == *"다시 해줘 please redo this"* ]] || return 1
}

@test "bounded-window MISS falls back to the full read (correction before the window)" {
  TR="${TR_TMP}/before_window.jsonl"
  make_transcript_msg_before_window "${TR}" 4000
  local fsize
  fsize=$(wc -c <"${TR}")
  [ "${fsize}" -gt 300000 ] || return 1 # padding after the last user message exceeds the tiny window

  # Tiny 4KB window → the tail holds only padding (no user message) → fallback to full read.
  run_t9 "${TR}" 4096 ""
  [ "${status}" -eq 0 ] || return 1
  local stage1 text bytes
  stage1=$(t9_field stage1_matched)
  text=$(t9_field last_user_text)
  bytes=$(read_bytes)

  # Correctness: the correction is STILL resolved despite the window miss.
  [ "${stage1}" = "1" ] || return 1
  [[ "${text}" == *"try again redo this approach"* ]] || return 1
  # Fallback proof: both the bounded window read AND the full read ran, so bytes read exceed file size.
  [ "${bytes}" -gt "${fsize}" ] || return 1
}

@test "common path does NOT fully read the parent transcript (bounded read)" {
  TR="${TR_TMP}/perf.jsonl"
  make_transcript_msg_at_eof "${TR}" 5000
  local fsize
  fsize=$(wc -c <"${TR}")
  [ "${fsize}" -gt 500000 ] || return 1

  # Bounded 64KB window, message near EOF, session disabled (no cache short-circuit).
  run_t9 "${TR}" 65536 ""
  [ "${status}" -eq 0 ] || return 1
  local stage1 bytes
  stage1=$(t9_field stage1_matched)
  bytes=$(read_bytes)

  [ "${stage1}" = "1" ] || return 1              # correct resolution on the bounded path
  [ "${bytes}" -le 70000 ] || return 1           # read stayed within the ~64KB window (+ small slack)
  [ "${bytes}" -lt "${fsize}" ] || return 1      # provably NOT a full read of the large transcript
}

@test "per-session cache reuses a prior resolve (second fire reads zero transcript bytes)" {
  TR="${TR_TMP}/cached.jsonl"
  make_transcript_msg_at_eof "${TR}" 3000
  local sess="sess-cache-$$"

  # First fire (cache miss) → resolves via tail read → reads transcript bytes.
  run_t9 "${TR}" 65536 "${sess}"
  [ "${status}" -eq 0 ] || return 1
  local first_stage1 first_text first_bytes
  first_stage1=$(t9_field stage1_matched)
  first_text=$(t9_field last_user_text)
  first_bytes=$(read_bytes)
  [ "${first_stage1}" = "1" ] || return 1
  [ "${first_bytes}" -gt 0 ] || return 1

  # Second fire (unchanged transcript → same fingerprint) → served from cache → zero transcript reads.
  run_t9 "${TR}" 65536 "${sess}"
  [ "${status}" -eq 0 ] || return 1
  local second_stage1 second_text second_bytes
  second_stage1=$(t9_field stage1_matched)
  second_text=$(t9_field last_user_text)
  second_bytes=$(read_bytes)

  [ "${second_stage1}" = "1" ] || return 1        # identical verdict served from cache
  [ "${second_text}" = "${first_text}" ] || return 1
  [ "${second_bytes}" -eq 0 ] || return 1         # cache hit → the parent transcript was not re-read
}
