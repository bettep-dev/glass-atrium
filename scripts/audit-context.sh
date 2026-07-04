#!/usr/bin/env bash
# audit-context.sh — static token-cost audit for ~/.claude/ ecosystem
# Usage: audit-context.sh [--out <path>]
#
# Behavior:
#   1. Scan agents/ rules/ skills/ + agent-registry.json + settings*.json
#   2. Count tokens via tiktoken cl100k_base (approx, ~10% error vs Anthropic count_tokens)
#   3. Write per-file JSON to ~/.claude/data/audit/YYYY-MM-DD-context-budget.json
#   4. Emit compact stdout summary (top-5 per dimension + threshold verdict)
#
# Exit codes:
#   0 = all dimensions under warn
#   1 = any dimension >= alert (breach)
#   2 = measurement failure (missing dep, IO error)
#
# Thresholds: ~/.claude/skills/glass-atrium-ops-token-audit/thresholds.yaml (SSoT)
# Methodology: ECC C4 audit citation only — implementation independent
set -Eeuo pipefail
IFS=$'\n\t'

readonly CLAUDE_ROOT="${HOME}/.claude"
readonly SKILL_DIR="${CLAUDE_ROOT}/skills/glass-atrium-ops-token-audit"
readonly THRESHOLDS="${SKILL_DIR}/thresholds.yaml"
readonly AUDIT_DIR="${CLAUDE_ROOT}/data/audit"
DATE_TAG="$(date +%Y-%m-%d)"
readonly DATE_TAG
DEFAULT_OUT="${AUDIT_DIR}/${DATE_TAG}-context-budget.json"

# 1. argument parse — single optional --out override
OUT_PATH="${DEFAULT_OUT}"
if [[ "${1:-}" == "--out" ]]; then
  if [[ -z "${2:-}" ]]; then
    printf 'ERROR: --out requires path argument\n' >&2
    exit 2
  fi
  OUT_PATH="${2}"
fi

# 2. precondition probe — fail loud on missing dep (self-improve-hygiene Precondition Loud-Fail)
if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR: python3 not found (audit requires Python interpreter)\n' >&2
  exit 2
fi
if [[ ! -f "${THRESHOLDS}" ]]; then
  printf 'ERROR: thresholds.yaml missing at %s\n' "${THRESHOLDS}" >&2
  exit 2
fi

# 3. output directory — auto-mkdir under data/
mkdir -p "${AUDIT_DIR}"

# 4. capture measurement Python — heredoc-stored to avoid SC2259 stdin conflict
py_src="$(
  cat <<'PY'
import json, os, re, sys, statistics
from datetime import datetime, timezone
from pathlib import Path

# tokenizer fallback — tiktoken preferred, char/4 approximation if unavailable
try:
    import tiktoken
    _enc = tiktoken.get_encoding("cl100k_base")
    def count_tokens(text: str) -> int:
        return len(_enc.encode(text))
    tokenizer_name = "tiktoken_cl100k_base_approx"
except Exception:
    def count_tokens(text: str) -> int:
        return max(1, len(text) // 4)
    tokenizer_name = "char_div_4_fallback"

try:
    import yaml
except Exception:
    print("ERROR: PyYAML not available", file=sys.stderr)
    sys.exit(2)

ROOT = Path(os.environ.get("CLAUDE_AUDIT_ROOT", str(Path.home() / ".claude")))
THRESHOLDS = Path(os.environ["CLAUDE_AUDIT_THRESHOLDS"])
OUT_PATH = Path(os.environ["CLAUDE_AUDIT_OUT_PATH"])

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
DESCR_RE = re.compile(r"^description:\s*(.+?)(?=^\w|\Z)", re.MULTILINE | re.DOTALL)


def split_frontmatter(text: str):
    m = FRONTMATTER_RE.match(text)
    if not m:
        return "", text
    return m.group(0), text[m.end():]


def extract_description_words(frontmatter: str) -> int:
    if not frontmatter:
        return 0
    m = DESCR_RE.search(frontmatter)
    if not m:
        return 0
    raw = m.group(1).strip().strip("'\"")
    return len(raw.split())


def scan_dir(dir_path: Path, suffix: str, capture_frontmatter: bool):
    rows = []
    if not dir_path.is_dir():
        return rows
    for p in sorted(dir_path.glob(f"*{suffix}")):
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        fm, body = split_frontmatter(text) if capture_frontmatter else ("", text)
        row = {
            "path": str(p),
            "name": p.stem,
            "tokens": count_tokens(text),
            "line_count": text.count("\n") + (0 if text.endswith("\n") else 1),
        }
        if capture_frontmatter:
            row["frontmatter_tokens"] = count_tokens(fm) if fm else 0
            row["body_tokens"] = count_tokens(body)
            row["description_words"] = extract_description_words(fm)
        rows.append(row)
    return rows


def scan_skills(skills_root: Path):
    rows = []
    if not skills_root.is_dir():
        return rows
    # top-level .md files (e.g. glass-atrium-ops-orchestrator.md, SKILL-od-extension-pattern.md)
    for p in sorted(skills_root.glob("*.md")):
        text = p.read_text(encoding="utf-8", errors="replace")
        rows.append({
            "path": str(p),
            "name": p.stem,
            "tokens": count_tokens(text),
            "line_count": text.count("\n"),
        })
    # nested <skill>/SKILL.md
    for child in sorted(skills_root.iterdir()):
        if not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        text = skill_md.read_text(encoding="utf-8", errors="replace")
        rows.append({
            "path": str(skill_md),
            "name": child.name,
            "tokens": count_tokens(text),
            "line_count": text.count("\n"),
        })
    return rows


def rule_tier(name: str) -> str:
    tier1 = {"git-workflow", "learning-log", "outcome-record", "security", "wiki-reference"}
    tier3 = {"comment-logging", "performance", "search-first", "testing", "type-safety",
             "design-token-consumption", "self-improve-hygiene"}
    if name == "compliance-matrix":
        return "meta"
    if name.startswith("scope-") or name == "orchestrator-role":
        return "2"
    if name in tier1:
        return "1"
    if name in tier3:
        return "3"
    return "unknown"


def scan_settings(root: Path):
    rows = []
    for fname in ("settings.json", "settings.local.json"):
        p = root / fname
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        rows.append({
            "path": str(p),
            "tokens": count_tokens(text),
            "line_count": text.count("\n"),
        })
    return rows


def scan_registry(root: Path):
    p = root / "agent-registry.json"
    if not p.is_file():
        return {"path": str(p), "total_tokens": 0, "per_agent_description_words": {}}
    text = p.read_text(encoding="utf-8", errors="replace")
    per_agent = {}
    try:
        data = json.loads(text)
        for agent_id, meta in (data.get("agents") or {}).items():
            descr = (meta or {}).get("description") or ""
            per_agent[agent_id] = len(descr.split())
    except json.JSONDecodeError:
        pass
    return {
        "path": str(p),
        "total_tokens": count_tokens(text),
        "per_agent_description_words": per_agent,
    }


def main():
    agents = scan_dir(ROOT / "agents", ".md", capture_frontmatter=True)
    # add description to rule rows
    # scan_dir is NON-recursive — rules live foldered under rules/glass-atrium/
    rules = scan_dir(ROOT / "rules" / "glass-atrium", ".md", capture_frontmatter=False)
    for r in rules:
        r["tier"] = rule_tier(r["name"])
    skills = scan_skills(ROOT / "skills")
    registry = scan_registry(ROOT)
    settings = scan_settings(ROOT)

    # ecosystem total
    total = sum(r["tokens"] for r in agents) \
          + sum(r["tokens"] for r in rules) \
          + sum(r["tokens"] for r in skills) \
          + registry["total_tokens"] \
          + sum(s["tokens"] for s in settings)

    top_agents = sorted(agents, key=lambda r: r["tokens"], reverse=True)[:5]
    top_rules = sorted(rules, key=lambda r: r["tokens"], reverse=True)[:5]

    output = {
        "tool": "glass-atrium-ops-token-audit",
        "version": "0.2.0-phase4",
        "tokenizer": tokenizer_name,
        "tokenizer_caveat": "~10% error vs Anthropic count_tokens; trend-only, not absolute",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "agents": agents,
        "rules": rules,
        "skills": skills,
        "agent_registry": registry,
        "settings": settings,
        "summary": {
            "total_ecosystem_tokens": total,
            "agents_count": len(agents),
            "rules_count": len(rules),
            "skills_count": len(skills),
            "top_5_agents_by_tokens": [{"name": a["name"], "tokens": a["tokens"]} for a in top_agents],
            "top_5_rules_by_tokens": [{"name": r["name"], "tokens": r["tokens"], "tier": r["tier"]} for r in top_rules],
        },
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False))

    # threshold verdict
    with THRESHOLDS.open() as f:
        thr = yaml.safe_load(f)

    breaches = []  # (dim, level, value, threshold)
    # agent description words
    descr_vals = [a["description_words"] for a in agents if a["description_words"] > 0]
    if descr_vals:
        worst_agent = max(agents, key=lambda a: a["description_words"])
        v = worst_agent["description_words"]
        if v >= thr["agent_description_words"]["alert"]:
            breaches.append(("agent_description_words", "alert", v, thr["agent_description_words"]["alert"], worst_agent["name"]))
        elif v >= thr["agent_description_words"]["warn"]:
            breaches.append(("agent_description_words", "warn", v, thr["agent_description_words"]["warn"], worst_agent["name"]))
    # agent total tokens
    worst_agent_tok = max(agents, key=lambda a: a["tokens"])
    v = worst_agent_tok["tokens"]
    if v >= thr["agent_total_tokens"]["alert"]:
        breaches.append(("agent_total_tokens", "alert", v, thr["agent_total_tokens"]["alert"], worst_agent_tok["name"]))
    elif v >= thr["agent_total_tokens"]["warn"]:
        breaches.append(("agent_total_tokens", "warn", v, thr["agent_total_tokens"]["warn"], worst_agent_tok["name"]))
    # rule line count
    worst_rule = max(rules, key=lambda r: r["line_count"])
    v = worst_rule["line_count"]
    if v >= thr["rule_line_count"]["alert"]:
        breaches.append(("rule_line_count", "alert", v, thr["rule_line_count"]["alert"], worst_rule["name"]))
    elif v >= thr["rule_line_count"]["warn"]:
        breaches.append(("rule_line_count", "warn", v, thr["rule_line_count"]["warn"], worst_rule["name"]))
    # ecosystem total
    if total >= thr["ecosystem_total_tokens"]["alert"]:
        breaches.append(("ecosystem_total_tokens", "alert", total, thr["ecosystem_total_tokens"]["alert"], "ecosystem"))
    elif total >= thr["ecosystem_total_tokens"]["warn"]:
        breaches.append(("ecosystem_total_tokens", "warn", total, thr["ecosystem_total_tokens"]["warn"], "ecosystem"))

    alert_n = sum(1 for b in breaches if b[1] == "alert")
    warn_n = sum(1 for b in breaches if b[1] == "warn")

    # compact stdout summary (< 1000 tokens)
    print(f"glass-atrium-ops-token-audit -> {OUT_PATH}")
    print(f"Ecosystem total: {total:,} tokens (warn={thr['ecosystem_total_tokens']['warn']:,} alert={thr['ecosystem_total_tokens']['alert']:,})")
    print("Top agents (tokens): " + " ".join(f"{a['name']}={a['tokens']}" for a in top_agents))
    print("Top rules   (lines): " + " ".join(f"{r['name']}={r['line_count']}" for r in sorted(rules, key=lambda r: r['line_count'], reverse=True)[:5]))
    if breaches:
        for dim, lvl, val, thr_v, who in breaches:
            print(f"  [{lvl.upper()}] {dim}={val} (>= {thr_v}) source={who}")
    print(f"Verdict: {alert_n} alert / {warn_n} warn breached")

    if alert_n > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
PY
)"

# 5. execute measurement — env-pass paths (avoid arg quoting fragility)
#    distinct env-var names from readonly parents to bypass bash readonly export quirk
export CLAUDE_AUDIT_ROOT="${CLAUDE_ROOT}"
export CLAUDE_AUDIT_THRESHOLDS="${THRESHOLDS}"
export CLAUDE_AUDIT_OUT_PATH="${OUT_PATH}"
python3 -c "${py_src}"
