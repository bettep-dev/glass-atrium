#!/usr/bin/env bash
# style-ref-verify.sh — Stop / SubagentStop style_ref cross-verification.
#
# Warns (never blocks) when a [COMPLETION] style_ref path is absent from the
# session's Read history — surfacing the Gaming-the-Judge content-based
# false-positive risk.
#
# DEFERRED — not yet wired in settings.json; staged rollout ships the hook first
# as a deployed-but-inactive measurement layer (user decides when to register).
# Suggested registration form (USER REFERENCE ONLY — do NOT auto-edit settings.json):
#     {
#       "hooks": {
#         "SubagentStop": [
#           {
#             "matcher": "",
#             "hooks": [
#               { "type": "command",
#                 "command": "~/.glass-atrium/hooks/style-ref-verify.sh" }
#             ]
#           }
#         ]
#       }
#     }
#
# exit 0 — pass / silent skip / warning (warn-not-block preserves Gaming-the-Judge
#          honesty without breaking the session).
# exit 5 — loud-fail precondition (transcript unreadable). Named exit code per
#          shared-self-improve-hygiene.md "Precondition Loud-Fail Principle" —
#          silent fail absorption FORBIDDEN.
# exit 6 — loud-fail precondition (python3 missing).

set -Eeuo pipefail
IFS=$'\n\t'

# Fail-open ERR trap (stderr only) — never break the session on internal error.
trap 'printf "[style-ref-verify] internal error at line %d: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Drain stdin. Empty payload → nothing to verify, exit silently.
INPUT=""
if [[ ! -t 0 ]]; then
  INPUT="$(cat 2>/dev/null)" || INPUT=""
fi
if [[ -z "${INPUT}" ]]; then
  exit 0
fi

# Loud-fail precondition: python3 required for JSON + transcript parsing.
if ! command -v python3 >/dev/null 2>&1; then
  printf '[style-ref-verify] LOUD-FAIL: python3 not found on PATH (exit 6)\n' >&2
  exit 6
fi

# All parsing stays inside python3 to avoid the multi-line shell extraction trap
# (sed + head -1 collapses multi-line message bodies). Emits @@verdict@@<token>:
#   skip_silent     — no [COMPLETION] / style_ref absent / greenfield literal
#   loud_fail_tpath — transcript_path absent or unreadable (caller exits 5)
#   match           — style_ref found in Read history (pass)
#   no_match        — style_ref not found (caller emits WARN, exits 0)
#   error           — unrecoverable internal error (caller exits 0 fail-open)
PIPELINE_PY=$(
  cat <<'PY'
import json
import os
import re
import sys

# Single SoT matcher: collect_read_paths + style_ref_matches live in
# lib/style_ref_match.py, shared with track-outcome.sh's style_ref_verified path
# (no rule divergence). STYLE_REF_MATCH_LIB is exported by the bash wrapper below.
_LIB_PATH = os.environ.get("STYLE_REF_MATCH_LIB", "")
if not _LIB_PATH or not os.path.isfile(_LIB_PATH):
    # Lib missing → fail-open: emit error so the caller exits 0 (warn-not-block).
    sys.stdout.write("@@verdict@@error\n@@reason@@style_ref_match lib unavailable\n")
    sys.exit(0)
with open(_LIB_PATH, "r", encoding="utf-8") as _lf:
    exec(compile(_lf.read(), _LIB_PATH, "exec"))  # noqa: S102 — trusted in-repo lib, fixed path


def emit(verdict, **extras):
    """Single-line verdict + optional kv pairs on stdout."""
    sys.stdout.write(f"@@verdict@@{verdict}\n")
    for k, v in extras.items():
        sys.stdout.write(f"@@{k}@@{v}\n")


def parse_completion_style_ref(msg):
    """Extract style_ref from [COMPLETION] block (Tier-1 closed + Tier-2 open)."""
    if not msg:
        return ""
    t1 = re.compile(
        r"^[ \t]*\[COMPLETION\][ \t]*\n(.*?)\n[ \t]*\[/COMPLETION\][ \t]*$",
        re.DOTALL | re.MULTILINE,
    )
    t2 = re.compile(
        r"^[ \t]*\[COMPLETION\][ \t]*\n(.*?)(?=\n#|\Z)",
        re.DOTALL | re.MULTILINE,
    )
    body = ""
    m1 = t1.search(msg)
    if m1:
        body = m1.group(1)
    else:
        m2 = t2.search(msg)
        if m2:
            body = m2.group(1)
    if not body:
        return ""
    for line in body.split("\n"):
        stripped = line.strip()
        if not stripped or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        if key.strip().lower() == "style_ref":
            return value.strip()
    return ""


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, json.JSONDecodeError):
        emit("skip_silent")
        return

    msg = payload.get("last_assistant_message", "") or ""
    tpath = payload.get("transcript_path", "") or ""

    style_ref = parse_completion_style_ref(msg)

    # style_ref absence + greenfield exemption → silent skip.
    # 'greenfield' literal — mirrors bash STYLE_REF_GREENFIELD constant in
    # ~/.glass-atrium/hooks/lib/style-ref-consts.sh. 3-layer manual sync obligation
    # (bash/python/TS) — value change requires updating all 3 layers in same cycle.
    if not style_ref or style_ref == "greenfield":
        emit("skip_silent")
        return

    # Loud-fail precondition: transcript reachable.
    if not tpath:
        emit("loud_fail_tpath", reason="absent")
        return
    if not os.access(tpath, os.R_OK):
        emit("loud_fail_tpath", reason="unreadable", tpath=tpath)
        return

    try:
        read_paths = collect_read_paths(tpath)  # noqa: F821 — provided by exec'd lib
    except (OSError, IOError):
        emit("loud_fail_tpath", reason="io_error", tpath=tpath)
        return

    if style_ref_matches(style_ref, read_paths):  # noqa: F821 — provided by exec'd lib
        emit("match")
        return

    emit("no_match", style_ref=style_ref)


try:
    main()
except Exception as exc:  # noqa: BLE001 — fail-open, never block on parse bug
    sys.stdout.write(f"@@verdict@@error\n@@reason@@{exc}\n")
PY
)

# Shared matcher (single SoT with track-outcome.sh), resolved from this script's
# own dir so the sibling lib resolves regardless of the invocation path.
STYLE_REF_MATCH_LIB="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/style_ref_match.py"

PIPELINE_OUT=""
PIPELINE_OUT="$(printf '%s' "${INPUT}" | STYLE_REF_MATCH_LIB="${STYLE_REF_MATCH_LIB}" python3 -c "${PIPELINE_PY}" 2>/dev/null)" || PIPELINE_OUT=""

extract_field() {
  printf '%s\n' "${PIPELINE_OUT}" | sed -n "s/^@@${1}@@//p" | head -1
}

VERDICT="$(extract_field verdict)"

case "${VERDICT}" in
  match | skip_silent | "")
    exit 0
    ;;
  no_match)
    reported_ref="$(extract_field style_ref)"
    printf '[style-ref-verify] WARN: style_ref="%s" not found in session Read history (Gaming-the-Judge candidate)\n' "${reported_ref}" >&2
    exit 0
    ;;
  loud_fail_tpath)
    reason="$(extract_field reason)"
    tpath_reported="$(extract_field tpath)"
    printf '[style-ref-verify] LOUD-FAIL: transcript precondition unmet (reason=%s, tpath=%s) (exit 5)\n' "${reason:-unknown}" "${tpath_reported:-<empty>}" >&2
    exit 5
    ;;
  error)
    reason="$(extract_field reason)"
    printf '[style-ref-verify] internal error: %s — fail-open (exit 0)\n' "${reason:-unknown}" >&2
    exit 0
    ;;
  *)
    # Unknown verdict — fail-open.
    exit 0
    ;;
esac
