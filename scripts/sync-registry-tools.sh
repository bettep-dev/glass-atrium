#!/usr/bin/env bash
# sync-registry-tools.sh — propagate `tools:` from agent .md frontmatter to agent-registry.json
# Usage: sync-registry-tools.sh [--root <dir>] [--dry-run | --check]
#
# Mirror each agent's authoritative frontmatter `tools:` array (<root>/agents/<name>.md)
# into the matching `agents` entry of <root>/agent-registry.json. The
# orchestrator-role.md Decision-phase Capability Probe reads frontmatter `tools:` at
# delegation time, but tooling that prefers the JSON form consumes this mirror
# (avoids re-parsing 23 markdown files); drift between the two breaks the probe.
#
# Root resolution (three steps, FIRST match wins) — the three consumers want
# different roots: a CI checkout (`--root`), a sandbox (`GA_ROOT`), and the live
# install (the default):
#   1. `--root <dir>`   2. `${GA_ROOT}`   3. `${HOME}/.glass-atrium`
# AGENTS_DIR and REGISTRY_PATH are DERIVED from the resolved root. Setting either
# variable directly in the environment overrides its derived value — that is a
# TEST SEAM, not a supported interface; callers pass `--root`/`GA_ROOT` instead.
#
# Re-run after editing any `tools:` array, adding/removing an agent, or as a
# periodic drift check (`--check` for an exit code, `--dry-run` to read the
# planned updates on stderr).
#
# Key-order: `tools` inserted at index 1 (between `domains` and `phase`) to match
# the `design-designer` entry. JSON output = 2-space indent + trailing newline +
# ensure_ascii=false to match existing formatting.
#
# SoT: agent frontmatter is authoritative — on mismatch the frontmatter value
# overwrites the registry; the script NEVER writes any agent file.
#
# Reporting (stdout one line): synced=N updated=N skipped=N orphans=N missing=N —
#   synced=already matching · updated=written · skipped=active file lacking `tools:` ·
#   orphans=registry entry with no file (reported, NOT removed) · missing=active file
#   with no registry entry (reported, NOT added).
#
# DRY_RUN contract — the shell PRESERVES an inherited value (it does not
# overwrite it), and the verdict is an exclusion rule, not an equality test:
#   unset · empty · `false` · `0` → write mode (an explicit, exact-case opt-out)
#   any other value               → dry-run, nothing written
#   `--dry-run`                   → dry-run, overrides whatever env said
#   `--check`                     → dry-run + exit 3 on drift, NEVER writes
# The comparison is exact-case on purpose: an unrecognised spelling (`False`)
# selects dry-run, so a misread errs toward not writing.
#
# Exit codes: 0=success · 1=JSON parse/write error · 2=frontmatter parse error
#   (includes a DUPLICATE frontmatter key — last-wins would let a second
#   `tools:` line pick the mirrored value; the mirror refuses instead) ·
#   3=`--check` found drift (registry differs from frontmatter; nothing written).
#
# Idempotency: re-run on a clean tree yields `updated=0` + zero file changes
# (post-merge JSON computed in memory, compared to on-disk bytes, write skipped if equal).
#
# Write path: the registry is read live by routing and the monitor, so the write
# goes through the shared atomic helper (`agent_lifecycle.atomic`) — sibling temp
# file, re-parse, structure check, then one `os.replace`. A crash or a rejected
# payload leaves the live file untouched and removes the temp. The direct
# `write_text` this used to call could leave a half-written registry in place.
#
# Test seam: a NON-EMPTY `SYNC_REGISTRY_FAIL_VALIDATE` makes the post-write
# validator reject, so the helper raises just before the rename — the write path
# fails (exit 1) with the registry byte-identical and no temp left behind. It is
# a test seam, not an interface; the public `validate=` argument is the only
# failure point a caller can reach (`before_replace` is bound inside the helper).
set -Eeuo pipefail
IFS=$'\n\t'

# The atomic helper ships beside this script (scripts/agent_lifecycle/). Resolve
# it from the SCRIPT's own location, never from the resolved ROOT: a `--root` run
# targets a different tree and must still use the helper it was shipped with.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

usage() {
  local self
  self="$(basename -- "${0}")"
  printf 'usage: %s [--root <dir>] [--dry-run | --check]\n' "${self}" >&2
}

# Preserve any INHERITED DRY_RUN — assigning a default here unconditionally is
# what made `DRY_RUN=1 sync-registry-tools.sh` silently write. Unset and empty
# both mean write mode, so `:-` collapsing them is the documented behaviour.
DRY_RUN="${DRY_RUN:-}"
CHECK_MODE=false
ROOT=""

while [[ $# -gt 0 ]]; do
  case "${1}" in
    --root)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        printf '%s\n' 'ERROR: --root requires a directory argument' >&2
        usage
        exit 1
      fi
      ROOT="${2}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --check)
      # `--check` is a dry-run that reports drift through its exit code.
      CHECK_MODE=true
      DRY_RUN=1
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

# Root resolution: --root > GA_ROOT > the live install. An empty GA_ROOT falls
# through to the default rather than resolving paths against "/".
if [[ -z "${ROOT}" ]]; then
  ROOT="${GA_ROOT:-${HOME}/.glass-atrium}"
fi
readonly ROOT

# Derived from the resolved root; a direct env value wins as a TEST SEAM only.
REGISTRY_PATH="${REGISTRY_PATH:-${ROOT}/agent-registry.json}"
AGENTS_DIR="${AGENTS_DIR:-${ROOT}/agents}"

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


class DuplicateKeyRejectingLoader(yaml.SafeLoader):
    """SafeLoader that REFUSES a duplicate mapping key instead of taking the last.

    `tools:` and `"tools":` resolve to the SAME scalar, so a second guarded key
    silently becomes the mirrored value under PyYAML's default last-wins rule —
    a widening smuggle the mirror would then write into the registry. A mirror
    that cannot tell which value was intended must refuse: ConstructorError is a
    YAMLError, so it lands on the existing parse-error exit-2 path, before any
    write. Keys are collected in a list (not a set) so an unhashable key falls
    through to SafeLoader's own "found unhashable key" error.
    """

    def construct_mapping(self, node, deep: bool = False) -> dict:
        seen: list = []
        for key_node, _value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    f"duplicate key {key!r} — refused (last-wins would hide the "
                    "first value; the frontmatter is the tools SoT)",
                    key_node.start_mark,
                )
            seen.append(key)
        return super().construct_mapping(node, deep=deep)


registry_path = Path(os.environ["REGISTRY_PATH"])
agents_dir = Path(os.environ["AGENTS_DIR"])
# Exclusion rule, NOT an equality test against one magic spelling: unset, empty,
# `false` and `0` are the write-mode opt-outs; every other value is a dry run.
# An equality test here is what let `DRY_RUN=1` fall through to writing.
DRY_RUN_WRITE_MODE_VALUES = ("", "false", "0")
dry_run = os.environ.get("DRY_RUN", "") not in DRY_RUN_WRITE_MODE_VALUES
check_mode = os.environ.get("CHECK_MODE") == "true"

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

# 2. Enumerate active .md agents (exclude GLASS_ATRIUM_GLOBAL_RULES.md + archive/ subdir).
#    GLASS_ATRIUM_GLOBAL_RULES.md is the system charter, not an agent file.
fs_agents = {}
parse_errors = []
for md_path in sorted(agents_dir.glob("*.md")):
    if md_path.name == "GLASS_ATRIUM_GLOBAL_RULES.md":
        continue
    text = md_path.read_text(encoding="utf-8")
    # frontmatter delimited by lines containing only '---' — split on first two
    parts = text.split("---", 2)
    if len(parts) < 3:
        parse_errors.append(md_path.name)
        continue
    try:
        # load() over a SafeLoader SUBCLASS — same safety as safe_load(), plus
        # the duplicate-key refusal.
        fm = yaml.load(parts[1], Loader=DuplicateKeyRejectingLoader)
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

def write_registry(payload) -> None:
    """Replace the registry through the shared atomic helper (temp + rename).

    The helper is imported HERE rather than at module scope so `--check` and
    `--dry-run` — the modes CI and doctor run — keep working on a tree where it
    is absent; only the write path depends on it, and there a missing helper is
    a broken tree that must fail loudly rather than fall back to a direct write.
    Bytecode is disabled before the import: it would otherwise drop a
    `__pycache__` into scripts/agent_lifecycle/, which the live recovery
    snapshot refuses as an untracked path.
    """
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.environ["SYNC_LIB_DIR"])
    try:
        from agent_lifecycle.atomic import (
            AtomicWriteError,
            atomic_write_json,
            has_agents_dict,
        )
    except ImportError as exc:
        print(
            f"ERROR: atomic write helper unavailable ({exc}) — refusing to "
            "write the registry through an unsafe direct path",
            file=sys.stderr,
        )
        sys.exit(1)

    def validate(reparsed) -> bool:
        # TEST SEAM: a non-empty SYNC_REGISTRY_FAIL_VALIDATE makes the PUBLIC
        # `validate=` callback reject, so the helper raises immediately before
        # the rename — the one failure point a caller can reach, since
        # `before_replace` is bound inside atomic_write_json.
        if os.environ.get("SYNC_REGISTRY_FAIL_VALIDATE"):
            return False
        return has_agents_dict(reparsed)

    try:
        atomic_write_json(registry_path, payload, validate=validate)
    except AtomicWriteError as exc:
        print(f"ERROR: registry write failed: {exc}", file=sys.stderr)
        sys.exit(1)


# 6. Serialize back — the helper re-serializes with the SAME format this
#    comparison assumes (2-space indent, ensure_ascii=false, trailing newline),
#    so comparing against on-disk bytes still skips the write on a no-op.
new_text = json.dumps(registry, indent=2, ensure_ascii=False) + "\n"
current_text = registry_path.read_text(encoding="utf-8")

write_needed = new_text != current_text
if write_needed and not dry_run:
    write_registry(registry)

print(
    f"synced={synced} updated={updated} "
    f"skipped={len(skipped)} orphans={len(orphans)} missing={len(missing_entries)}"
)

# 7. `--check`: report drift through the exit code. The metric line above is
#    emitted first so a checking caller still gets the counts.
if check_mode and write_needed:
    print(
        "DRIFT: registry does not match frontmatter — re-run without --check to write",
        file=sys.stderr,
    )
    sys.exit(3)
PY
)"

# Export env for the python invocation. The python source reads them.
export REGISTRY_PATH AGENTS_DIR
export DRY_RUN="${DRY_RUN}"
export CHECK_MODE="${CHECK_MODE}"
export SYNC_LIB_DIR="${SCRIPT_DIR}"

python3 -c "${PY_SRC}"
