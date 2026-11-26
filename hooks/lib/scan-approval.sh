#!/usr/bin/env bash
# scan-approval.sh — the hook side of an owner-approved secret-scan write: the line hash the monitor binds an
# approval to. One canonical spec, the monitor's (monitor/src/server/queue/scan-approvals.ts → getLineHash);
# both sides are pinned by monitor/test/fixtures/scan-approval-vectors.json.
# Bash 3.2+ (macOS stock); python3, which the secret-scan hook already requires.

# shellcheck disable=SC2317  # source-context-unaware false positive on this double-source guard
if [[ -n "${_SCAN_APPROVAL_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _SCAN_APPROVAL_LOADED=1

# raw bytes, split on LF only → a CR, a NUL or any other byte stays part of its line; nothing added, nothing normalized
readonly SCAN_APPROVAL_HASH_PY='import hashlib, sys
for line in sys.stdin.buffer.read().split(b"\n"):
    print(hashlib.sha256(line).hexdigest())'

# Text on stdin, never an argument → one lowercase SHA-256 hex per LF-separated line, in order.
# Takes bytes, not a shell variable: a variable cannot hold a NUL, so the line hashed would differ from the line written.
get_line_hashes() {
  python3 -I -c "${SCAN_APPROVAL_HASH_PY}"
}
