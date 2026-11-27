#!/usr/bin/env bash
# scan-approval.sh — the hook side of an owner-approved secret-scan write: the line hash the monitor binds an
# approval to. One canonical spec, the monitor's (monitor/src/server/queue/scan-approvals.ts → getLineHash);
# both sides are pinned by hooks/test/fixtures/scan-approval-vectors.json.
# Bash 3.2+ (macOS stock); python3, which the secret-scan hook already requires.

# shellcheck disable=SC2317  # source-context-unaware false positive on this double-source guard
if [[ -n "${_SCAN_APPROVAL_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _SCAN_APPROVAL_LOADED=1

# raw bytes, split on LF only → a CR, a NUL or any other byte stays part of its line; nothing added, nothing normalized
# shellcheck disable=SC2034  # read by the sourcing hook and its suite
readonly SCAN_APPROVAL_HASH_PY='import hashlib
def get_lines(data):
    return data.split(b"\n")
def get_line_hash(line):
    return hashlib.sha256(line).hexdigest()'
