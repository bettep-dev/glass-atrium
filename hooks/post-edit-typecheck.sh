#!/usr/bin/env bash
# post-edit-typecheck.sh — TS type check, run once at turn end.
#   - PostToolUse(Edit|Write): on .ts/.tsx edit, append PROJECT_ROOT to the per-session marker
#     only (no tsc) — keeps every edit sub-second (marker append, not a full recompile).
#   - Stop / SubagentStop: marker present → run tsc --noEmit once per recorded root, then remove.
# Non-blocking: type error → exit 0 + stderr only (Stop is observe-only — exit 2 cannot reverse an
# ended turn). Marker key = session_id (Stop payload carries no file_path). emit_error EXEMPT: raw
# tsc output IS the error display. tsc resolution: ${root}/node_modules/.bin/tsc, else npx tsc.
# Env (testing): TYPECHECK_MARKER_DIR (marker dir) · TYPECHECK_DRY_RUN=1 (print plan, no tsc).

set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

# fail-open ERR trap — an internal error must not cut the session.
trap 'printf "[post-edit-typecheck] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

readonly DEFAULT_MARKER_DIR="${HOME}/.claude/data"
marker_dir="${TYPECHECK_MARKER_DIR:-${DEFAULT_MARKER_DIR}}"

INPUT="$(hook_read_input)"
# Single-pass extraction of the two always-read top-level fields (one python3, not two).
{
  IFS= read -r -d '' EVENT
  IFS= read -r -d '' SESSION_ID
} \
  < <(hook_get_fields "${INPUT}" hook_event_name session_id || true)

# session_id absent → marker key impossible → fail-open.
if [[ -z "${SESSION_ID}" ]]; then
  exit 0
fi

marker_path="${marker_dir}/typecheck-pending_${SESSION_ID}.json"

# PROJECT_ROOT = git top-level from the file's directory; empty on failure.
resolve_project_root() {
  local file_path="${1}" dir
  dir="$(dirname -- "${file_path}")"
  [[ -d "${dir}" ]] || {
    printf '%s\n' ""
    return 0
  }
  git -C "${dir}" rev-parse --show-toplevel 2>/dev/null || printf '%s\n' ""
}

# PostToolUse(Edit|Write): only record a marker, no tsc run.
record_marker() {
  local file_path
  file_path="$(hook_get_tool_input "${INPUT}" "file_path")"
  [[ -z "${file_path}" ]] && return 0

  case "${file_path}" in
    *.ts | *.tsx) ;;
    *) return 0 ;;
  esac

  local project_root
  project_root="$(resolve_project_root "${file_path}")"
  # PROJECT_ROOT unresolved (non-git) → no tsconfig context → skip.
  [[ -z "${project_root}" ]] && return 0

  # python3 read-merge-writes the marker (idempotent set accumulation); absent → fail-open.
  command -v python3 >/dev/null 2>&1 || return 0

  printf '%s' "${project_root}" | TYPECHECK_MARKER_PATH="${marker_path}" \
    TYPECHECK_SESSION_ID="${SESSION_ID}" python3 -c '
import json, os, sys

root = sys.stdin.read().strip()
mp = os.environ["TYPECHECK_MARKER_PATH"]
sid = os.environ["TYPECHECK_SESSION_ID"]
roots = []
if os.path.isfile(mp):
    try:
        with open(mp, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
        if isinstance(prev, dict):
            pr = prev.get("roots", [])
            if isinstance(pr, list):
                roots = [r for r in pr if isinstance(r, str)]
    except Exception:
        roots = []
if root and root not in roots:
    roots.append(root)
os.makedirs(os.path.dirname(mp), exist_ok=True)
with open(mp, "w", encoding="utf-8") as fh:
    json.dump({"session_id": sid, "roots": roots}, fh)
' 2>/dev/null || return 0

  return 0
}

# Stop / SubagentStop: marker present → run tsc once then remove.
run_typecheck_for_root() {
  local project_root="${1}"
  [[ -d "${project_root}" ]] || return 0
  [[ -f "${project_root}/tsconfig.json" ]] || return 0

  # Direct binary preferred, otherwise npx fallback.
  local tsc_bin
  if [[ -x "${project_root}/node_modules/.bin/tsc" ]]; then
    tsc_bin="${project_root}/node_modules/.bin/tsc"
  else
    tsc_bin="npx tsc"
  fi

  # Project references → --build, otherwise -p tsconfig.json.
  if grep -q '"references"' "${project_root}/tsconfig.json" 2>/dev/null; then
    if [[ "${TYPECHECK_DRY_RUN:-}" == "1" ]]; then
      printf '[post-edit-typecheck] DRY-RUN: %s --build --noEmit (root=%s)\n' "${tsc_bin}" "${project_root}"
    else
      # shellcheck disable=SC2086  # tsc_bin is intentionally split (npx tsc) — safe even as a single token.
      (cd -- "${project_root}" && ${tsc_bin} --build --noEmit 2>&1 | head -20) || true
    fi
  else
    if [[ "${TYPECHECK_DRY_RUN:-}" == "1" ]]; then
      printf '[post-edit-typecheck] DRY-RUN: %s --noEmit -p tsconfig.json (root=%s)\n' "${tsc_bin}" "${project_root}"
    else
      # shellcheck disable=SC2086  # tsc_bin is intentionally split (npx tsc) — safe even as a single token.
      (cd -- "${project_root}" && ${tsc_bin} --noEmit -p "${project_root}/tsconfig.json" 2>&1 | head -20) || true
    fi
  fi
}

run_pending_typechecks() {
  # No marker → no TS edit this session.
  [[ -f "${marker_path}" ]] || return 0

  command -v python3 >/dev/null 2>&1 || {
    rm -f "${marker_path}"
    return 0
  }

  # Extract the PROJECT_ROOT list (newline-separated).
  local roots
  roots="$(TYPECHECK_MARKER_PATH="${marker_path}" python3 -c '
import json, os, sys

mp = os.environ["TYPECHECK_MARKER_PATH"]
try:
    with open(mp, "r", encoding="utf-8") as fh:
        rec = json.load(fh)
    pr = rec.get("roots", []) if isinstance(rec, dict) else []
    for r in pr:
        if isinstance(r, str) and r:
            print(r)
except Exception:
    pass
' 2>/dev/null)" || roots=""

  # Remove the marker first (self-cleaning) — prevents next-turn leak even if tsc is slow.
  rm -f "${marker_path}"

  [[ -z "${roots}" ]] && return 0

  while IFS= read -r root; do
    [[ -z "${root}" ]] && continue
    run_typecheck_for_root "${root}"
  done <<<"${roots}"

  return 0
}

# Event branch — hook_event_name first, file_path presence as fallback.
case "${EVENT}" in
  Stop | SubagentStop)
    run_pending_typechecks
    ;;
  PostToolUse)
    record_marker
    ;;
  *)
    # hook_event_name absent → file_path present = PostToolUse, else Stop family.
    fallback_file_path="$(hook_get_tool_input "${INPUT}" "file_path")"
    if [[ -n "${fallback_file_path}" ]]; then
      record_marker
    else
      run_pending_typechecks
    fi
    ;;
esac

exit 0
