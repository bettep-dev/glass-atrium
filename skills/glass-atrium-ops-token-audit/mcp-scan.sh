#!/usr/bin/env bash
# mcp-scan.sh — MCP-server token-cost scan for the glass-atrium-ops-token-audit skill (Phase-3 P5)
# Usage: mcp-scan.sh [--out <path>]
#
# Behavior:
#   1. Read connected/configured MCP servers from `claude mcp list` (authoritative source)
#   2. Estimate per-server token cost (tool_count * per-tool baseline) for connected servers
#   3. Flag servers wrapping an otherwise-free CLI + classify each into {keep,lazy-load,remove}
#   4. Merge an `mcp_servers` block into the daily audit JSON (default = shared audit file)
#   5. Emit a compact stdout summary + threshold verdict vs thresholds.yaml
#
# Self-consistency (AC-P5-1): scanned-server count == count parsed from `claude mcp list`
#   (the SAME source the scan reads) — no hardcoded server count.
#
# Exit codes (aligned with audit-context.sh):
#   0 = mcp_server_total_tokens under warn
#   1 = mcp_server_total_tokens >= alert (breach)
#   2 = measurement failure (missing dep, IO error, MCP source unreadable)
#
# Thresholds: ~/.claude/skills/glass-atrium-ops-token-audit/thresholds.yaml (SSoT)
# Token heuristic: ECC C4 citation (~500 tok/tool-schema) — implementation independent
set -Eeuo pipefail
IFS=$'\n\t'

readonly CLAUDE_ROOT="${HOME}/.claude"
readonly SKILL_DIR="${CLAUDE_ROOT}/skills/glass-atrium-ops-token-audit"
readonly THRESHOLDS="${SKILL_DIR}/thresholds.yaml"
readonly AUDIT_DIR="${CLAUDE_ROOT}/data/audit"
DATE_TAG="$(date +%Y-%m-%d)"
readonly DATE_TAG
# default = the SAME daily file audit-context.sh writes (multi-stage shared output)
DEFAULT_OUT="${AUDIT_DIR}/${DATE_TAG}-context-budget.json"

# 1. argument parse — single optional --out override (mirrors audit-context.sh)
OUT_PATH="${DEFAULT_OUT}"
if [[ "${1:-}" == "--out" ]]; then
  if [[ -z "${2:-}" ]]; then
    printf 'ERROR: --out requires path argument\n' >&2
    exit 2
  fi
  OUT_PATH="${2}"
fi

# 2. precondition probe — fail loud on missing dep (Precondition Loud-Fail principle)
if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR: python3 not found (mcp-scan requires Python interpreter)\n' >&2
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  printf 'ERROR: claude CLI not found (mcp-scan reads the claude mcp list output)\n' >&2
  exit 2
fi
if [[ ! -f "${THRESHOLDS}" ]]; then
  printf 'ERROR: thresholds.yaml missing at %s\n' "${THRESHOLDS}" >&2
  exit 2
fi

mkdir -p "${AUDIT_DIR}"

# 3. capture MCP source — `claude mcp list` is the authoritative resolver across
#    top-level / per-project / plugin scopes (top-level mcpServers alone is incomplete).
#    Captured ONCE so scanned_count is self-consistent with this exact snapshot
#    (MCP health is time-dependent — two separate invocations can disagree).
#    CLAUDE_MCP_LIST_FIXTURE (optional): a file path overriding the live call —
#    enables deterministic verification + offline runs (additive testability hook).
#    Tolerate non-zero exit (CLI returns 1 when some servers are unhealthy) — the
#    listing text is still emitted + parseable; empty capture is the loud-fail case.
if [[ -n "${CLAUDE_MCP_LIST_FIXTURE:-}" ]]; then
  if [[ ! -f "${CLAUDE_MCP_LIST_FIXTURE}" ]]; then
    printf 'ERROR: CLAUDE_MCP_LIST_FIXTURE not found at %s\n' "${CLAUDE_MCP_LIST_FIXTURE}" >&2
    exit 2
  fi
  MCP_RAW="$(cat -- "${CLAUDE_MCP_LIST_FIXTURE}")"
else
  MCP_RAW="$(claude mcp list 2>/dev/null || true)"
fi
if [[ -z "${MCP_RAW}" ]]; then
  printf 'ERROR: claude mcp list produced no output (MCP source unreadable)\n' >&2
  exit 2
fi

# 4. measurement Python — heredoc-stored to a var to avoid SC2259 (heredoc-vs-stdin
#    conflict); MCP listing is piped on stdin, paths passed via env.
py_src="$(
  cat <<'PY'
import json, os, re, sys, statistics
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except Exception:
    print("ERROR: PyYAML not available", file=sys.stderr)
    sys.exit(2)

THRESHOLDS = Path(os.environ["CLAUDE_MCP_THRESHOLDS"])
OUT_PATH = Path(os.environ["CLAUDE_MCP_OUT_PATH"])

# --- token-estimation heuristic ---------------------------------------------
# ECC C4 reference baseline: a single MCP tool-schema costs ~500 ingestion tokens.
# Exact per-server tool counts require spawning each server (slow + needs network
# auth for remote HTTP servers), so tool count is a documented estimate: an override
# map for servers whose toolkit size is known, a conservative default otherwise.
TOK_PER_TOOL = 500
TOOL_COUNT_DEFAULT = 8
TOOL_COUNT_OVERRIDE = {
    "chrome-devtools": 26,
    "plugin:playwright:playwright": 21,
    "plugin:context7:context7": 2,
    "figma-mcp-go": 8,
    "claude.ai Atlassian": 25,
    "plugin:github:github": 30,
    "claude.ai Gmail": 10,
    "claude.ai Google Calendar": 8,
    "claude.ai Google Drive": 6,
    "claude.ai Notion": 12,
    "plugin:figma:figma": 8,
    "plugin:vercel:vercel": 10,
    "plugin:fakechat:fakechat": 4,
}
# A local-cmd server whose name/transport invokes a tool with a first-class CLI
# wraps an otherwise-free capability (reachable via the Bash tool at zero context cost).
CLI_NAME_HINTS = ("github", "vercel", "git ")

ANSI = re.compile(r"\x1b\[[0-9;]*m")  # strip color codes from CLI output


def parse_servers(raw: str):
    # line shape: "<name>: <transport> - <status_marker> <status_text>"
    # name may itself contain ':' (e.g. plugin:context7:context7) -> split name on
    # FIRST ': ', split status on LAST ' - ' (transport URLs contain '://' + ' - '-free)
    rows = []
    clean = ANSI.sub("", raw)
    for line in clean.splitlines():
        line = line.rstrip()
        if not line or "Checking MCP server health" in line:
            continue
        if " - " not in line or ": " not in line:
            continue
        head, status = line.rsplit(" - ", 1)
        if ": " not in head:
            continue
        name, transport = head.split(": ", 1)
        status = status.strip()
        connected = status.startswith("✓")  # ✓ Connected
        is_http = "http" in transport.lower()
        tool_count = TOOL_COUNT_OVERRIDE.get(name, TOOL_COUNT_DEFAULT)
        est_tokens = tool_count * TOK_PER_TOOL if connected else 0
        nl, tl = name.lower(), transport.lower()
        wraps_cli = (not is_http) and any(h in tl or h in nl for h in CLI_NAME_HINTS)
        rows.append({
            "name": name,
            "transport": transport,
            "status": status,
            "connected": connected,
            "is_http": is_http,
            "tool_count_estimate": tool_count,
            "est_tokens": est_tokens,
            "wraps_free_cli": wraps_cli,
        })
    return rows


def assign_bucket(row, lazy_threshold: int) -> str:
    # remove   = not connected (configured-but-inert) OR wraps an otherwise-free CLI
    # lazy-load = connected + heavy (>= median connected cost) -> defer via ToolSearch
    # keep     = connected + light, core workflow
    if not row["connected"]:
        return "remove"
    if row["wraps_free_cli"]:
        return "remove"
    return "lazy-load" if row["est_tokens"] >= lazy_threshold else "keep"


def main():
    raw = sys.stdin.read()
    servers = parse_servers(raw)
    if not servers:
        print("ERROR: parsed 0 MCP servers from `claude mcp list`", file=sys.stderr)
        sys.exit(2)

    connected = [s for s in servers if s["connected"]]
    conn_tokens = [s["est_tokens"] for s in connected]
    # lazy threshold = median connected cost (splits the connected set into keep/lazy)
    lazy_threshold = int(statistics.median(conn_tokens)) if conn_tokens else 0
    for s in servers:
        s["bucket"] = assign_bucket(s, lazy_threshold)

    buckets = {"keep": 0, "lazy-load": 0, "remove": 0}
    for s in servers:
        buckets[s["bucket"]] += 1

    total_connected_tokens = sum(conn_tokens)
    worst = max(servers, key=lambda s: s["est_tokens"]) if servers else None

    mcp_block = {
        "source": "claude mcp list",
        "token_heuristic": f"tool_count_estimate * {TOK_PER_TOOL} tok/tool (ECC C4 baseline)",
        "scanned_count": len(servers),          # AC-P5-1 self-consistency anchor
        "connected_count": len(connected),
        "bucket_counts": buckets,
        "lazy_load_split_tokens": lazy_threshold,
        "total_connected_tokens": total_connected_tokens,
        "servers": servers,
    }

    # 5. merge into the shared daily audit JSON (additive — preserve existing keys).
    #    If the file is absent (mcp-scan run standalone), create a minimal wrapper.
    if OUT_PATH.is_file():
        try:
            doc = json.loads(OUT_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            doc = {}
    else:
        doc = {}
    if not isinstance(doc, dict):
        doc = {}
    doc["mcp_servers"] = mcp_block
    # extend summary with mcp roll-up when the audit summary exists
    summary = doc.get("summary")
    if isinstance(summary, dict):
        summary["mcp_servers_count"] = len(servers)
        summary["mcp_connected_count"] = len(connected)
        summary["mcp_total_connected_tokens"] = total_connected_tokens
    doc.setdefault("generated_at_mcp", datetime.now(timezone.utc).isoformat())

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False))

    # threshold verdict — mcp_server_total_tokens compares the WORST single server
    # (same semantic as agent_total_tokens in audit-context.sh)
    with THRESHOLDS.open() as f:
        thr = yaml.safe_load(f)
    mcp_thr = thr.get("mcp_server_total_tokens", {})
    warn_t = mcp_thr.get("warn", 0)
    alert_t = mcp_thr.get("alert", 0)
    worst_v = worst["est_tokens"] if worst else 0
    worst_name = worst["name"] if worst else "n/a"

    level = "ok"
    if alert_t and worst_v >= alert_t:
        level = "alert"
    elif warn_t and worst_v >= warn_t:
        level = "warn"

    # compact stdout summary (< 1000 tokens)
    print(f"mcp-scan -> {OUT_PATH}")
    print(f"Scanned MCP servers: {len(servers)} (connected={len(connected)}) "
          f"-> keep={buckets['keep']} lazy-load={buckets['lazy-load']} remove={buckets['remove']}")
    print(f"Total connected MCP tokens: {total_connected_tokens:,} "
          f"(per-server warn={warn_t:,} alert={alert_t:,})")
    # per connected server line (AC-P5-1: per-server token cost + cli-wrap flag)
    for s in sorted(servers, key=lambda r: r["est_tokens"], reverse=True):
        if not s["connected"] and s["bucket"] == "remove":
            continue  # collapse the inert tail for stdout brevity (full set in JSON)
        flag = " [CLI-WRAP]" if s["wraps_free_cli"] else ""
        print(f"  [{s['bucket']:9}] {s['name']}={s['est_tokens']} "
              f"(tools~{s['tool_count_estimate']}){flag}")
    print(f"Verdict (mcp worst-server): [{level.upper()}] {worst_name}={worst_v}")

    if level == "alert":
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
PY
)"

# 6. execute — env-pass paths (avoid arg quoting fragility), MCP listing via stdin
export CLAUDE_MCP_THRESHOLDS="${THRESHOLDS}"
export CLAUDE_MCP_OUT_PATH="${OUT_PATH}"
printf '%s\n' "${MCP_RAW}" | python3 -c "${py_src}"
