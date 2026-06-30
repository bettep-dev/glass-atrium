#!/usr/bin/env bash
# sync-registry-tools.sh — propagate `tools:` from agent .md frontmatter to agent-registry.json
# Usage: sync-registry-tools.sh [--dry-run]
#
# Purpose:
#   Mirror each agent's authoritative frontmatter `tools:` array (in
#   ~/.claude/agents/<name>.md) into the matching entry under the `agents` dict of
#   ~/.claude/agent-registry.json. The orchestrator-role.md Decision-phase
#   Capability Probe reads `frontmatter tools:` at delegation time, but the
#   registry mirror is consumed by tooling that prefers the JSON form (avoids
#   re-parsing 23 markdown files). Drift between the two surfaces breaks the
#   probe contract for any consumer that picks the JSON path.
#
# When to re-run:
#   1. After editing any agent's frontmatter `tools:` array.
#   2. After adding/removing an agent (.md file).
#   3. As a periodic drift check (`--dry-run` then inspect diff).
#
# Key-order preservation:
#   `tools` is inserted at index 1 (between `domains` and `phase`) to match the
#   convention already established by the `design-designer` entry. JSON output uses
#   2-space indent + trailing newline + ensure_ascii=false to match existing
#   formatting (verified against current file: 402 lines, 2-space indent).
#
# Source-of-truth policy:
#   Agent .md frontmatter is the SoT. On mismatch with the registry, the .md
#   value overwrites — the script does NOT touch any .md file.
#
# Reporting:
#   stdout single line:  synced=N updated=N skipped=N orphans=N missing=N
#     synced   = entries already matching .md (no-op)
#     updated  = entries written with new/changed tools value
#     skipped  = active .md files lacking a `tools:` field (reported by name)
#     orphans  = registry entries with no matching .md file (reported, NOT removed)
#     missing  = active .md files with no registry entry (reported, NOT added)
#
# Exit codes:
#   0 = success (zero or more updates applied)
#   1 = JSON parse / write error (registry malformed or unwritable)
#   2 = frontmatter parse error on at least one .md file
#
# Idempotency:
#   Re-running on a clean tree must produce `updated=0` and zero file changes.
#   The script computes the post-merge JSON in memory and compares against the
#   on-disk bytes — write skipped when identical.
set -Eeuo pipefail
IFS=$'\n\t'

readonly REGISTRY_PATH="${HOME}/.claude/agent-registry.json"
readonly AGENTS_DIR="${HOME}/.claude/agents"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--dry-run]\n' "$(basename "$0")" >&2
  exit 1
fi

# Capture the python source up-front (NOT inlined into `python3 -c` alongside a
# heredoc — SC2259: stdin would be overwritten, blocking pipe input). We pass
# the registry path + dry-run flag via env vars so the script body stays clean.
PY_SRC="$(
  cat <<'PY'
import json
import os
import re
import sys
from pathlib import Path

import yaml

registry_path = Path(os.environ["REGISTRY_PATH"])
agents_dir = Path(os.environ["AGENTS_DIR"])
dry_run = os.environ.get("DRY_RUN") == "true"

# 1. Load current registry — preserve dict order via standard json.load
#    (Python 3.7+ dicts preserve insertion order).
try:
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    print(f"ERROR: registry load failed: {exc}", file=sys.stderr)
    sys.exit(1)

if "agents" not in registry or not isinstance(registry["agents"], dict):
    print("ERROR: registry has no `agents` dict at top level", file=sys.stderr)
    sys.exit(1)

# 2. Enumerate active .md agents (exclude GLOBAL_RULES.md + archive/ subdir).
#    GLOBAL_RULES.md is the system charter, not an agent file.
fs_agents = {}
parse_errors = []
for md_path in sorted(agents_dir.glob("*.md")):
    if md_path.name == "GLOBAL_RULES.md":
        continue
    text = md_path.read_text(encoding="utf-8")
    # frontmatter delimited by lines containing only '---' — split on first two
    parts = text.split("---", 2)
    if len(parts) < 3:
        parse_errors.append(md_path.name)
        continue
    try:
        fm = yaml.safe_load(parts[1])
    except yaml.YAMLError as exc:
        print(f"ERROR: yaml parse failed for {md_path.name}: {exc}", file=sys.stderr)
        parse_errors.append(md_path.name)
        continue
    name = fm.get("name") if isinstance(fm, dict) else None
    if not name:
        # fall back to filename stem when frontmatter lacks `name`
        name = md_path.stem
    fs_agents[name] = fm.get("tools") if isinstance(fm, dict) else None

if parse_errors:
    print(f"ERROR: frontmatter parse failed: {parse_errors}", file=sys.stderr)
    sys.exit(2)

# 3. Diff sets — orphans (registry-only) and missing (fs-only) are reported,
#    not auto-acted-on. Tool sync only touches the intersection.
registry_names = set(registry["agents"].keys())
fs_names = set(fs_agents.keys())
orphans = sorted(registry_names - fs_names)
missing_entries = sorted(fs_names - registry_names)

# 4. Reconcile tools field — .md is SoT; insert at index 1 to match design-designer
#    convention ([domains, tools, phase, dual_phase]).
synced = 0
updated = 0
skipped = []
updates: list[tuple[str, list, list | None]] = []  # (name, new, old)

for name in sorted(registry_names & fs_names):
    md_tools = fs_agents[name]
    if md_tools is None:
        skipped.append(name)
        continue
    # YAML loader produces list of strings; preserve order
    if not isinstance(md_tools, list):
        print(
            f"ERROR: {name} .md `tools` is not a list "
            f"(got {type(md_tools).__name__})",
            file=sys.stderr,
        )
        sys.exit(2)

    entry = registry["agents"][name]
    current = entry.get("tools")
    if current == md_tools:
        synced += 1
        continue

    # Rebuild entry dict with tools inserted between `domains` and `phase`.
    new_entry: dict = {}
    inserted = False
    for k, v in entry.items():
        if k == "tools":
            continue  # we will re-insert below
        new_entry[k] = v
        if k == "domains" and not inserted:
            new_entry["tools"] = md_tools
            inserted = True
    if not inserted:
        # `domains` missing — append `tools` at end as fallback
        new_entry["tools"] = md_tools
    registry["agents"][name] = new_entry
    updates.append((name, md_tools, current))
    updated += 1

# 5. Emit summary BEFORE writing — orphan/missing/skipped detail goes to stderr
#    so stdout stays the single canonical metric line.
if orphans:
    print(f"ORPHANS (registry entries with no .md): {orphans}", file=sys.stderr)
if missing_entries:
    print(f"MISSING ENTRIES (.md files with no registry): {missing_entries}",
          file=sys.stderr)
if skipped:
    print(f"SKIPPED (no `tools` in frontmatter): {skipped}", file=sys.stderr)
if updates and dry_run:
    print("PLANNED UPDATES:", file=sys.stderr)
    for name, new, old in updates:
        old_repr = "MISSING" if old is None else repr(old)
        print(f"  - {name}: {old_repr} -> {new!r}", file=sys.stderr)

# 6. Serialize back — preserve formatting (2-space indent, ensure_ascii=false,
#    trailing newline). Compare against on-disk bytes; skip write on no-op.
new_text = json.dumps(registry, indent=2, ensure_ascii=False) + "\n"
current_text = registry_path.read_text(encoding="utf-8")

write_needed = new_text != current_text
if write_needed and not dry_run:
    registry_path.write_text(new_text, encoding="utf-8")

print(
    f"synced={synced} updated={updated} "
    f"skipped={len(skipped)} orphans={len(orphans)} missing={len(missing_entries)}"
)
PY
)"

# Export env for the python invocation. The python source reads them.
export REGISTRY_PATH AGENTS_DIR
export DRY_RUN="${DRY_RUN}"

python3 -c "${PY_SRC}"
