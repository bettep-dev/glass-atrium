#!/usr/bin/env bats
# roster-claim-shape suite — the EXIT GATE on a deploy that ships a claimed file.
#
# The failure it guards: `update_dispatch_roster_merge` runs roster_merge.py over
# every path `spine_get_roster_paths` claims. A claimed file whose release copy
# carries no parseable slot raises ShapeError, the plan exits non-zero, the row is
# DECLINED and the LIVE file is kept — while the rest of the deploy succeeds. A
# release that dropped the last space-padded array from inject-scope-rules.sh
# would therefore land every new rule body and every new wrapper and leave the one
# file that decides what is injected at its old version, with a single update_log
# line as the only symptom.
#
# Every case below reads the TREE, not a fixture: the point is to refuse a release
# whose own files cannot be merged, so a fixture would assert nothing about it.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
SPINE="${GA}/scripts/lib/apply-spine.sh"
MERGE="${GA}/autoagent/lib/roster_merge.py"

setup() {
  [[ -f "${SPINE}" ]] || skip "apply-spine.sh not found: ${SPINE}"
  [[ -f "${MERGE}" ]] || skip "roster_merge.py not found: ${MERGE}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
}

# Echo the claimed paths, one per line, from the ONE list both the predicate and
# the dispatch read.
claimed_paths() {
  # shellcheck disable=SC1090
  (set -Eeuo pipefail; source "${SPINE}"; spine_get_roster_paths)
}

# Parse one tree file through the slot loader its suffix selects. Prints the slot
# names it found; a ShapeError exits non-zero with the message on stderr.
parse_slots() {
  local rel="${1}"
  GA_ROOT="${GA}" GA_REL="${rel}" python3 - <<'PY'
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(os.environ["GA_ROOT"]) / "autoagent" / "lib"))
import roster_merge as rm

rel = os.environ["GA_REL"]
path = pathlib.Path(os.environ["GA_ROOT"]) / rel
text = path.read_text(encoding="utf-8")
loader = {
    rm.SHAPE_REGISTRY: rm._get_registry_slots,
    rm.SHAPE_MARKDOWN: rm._get_markdown_slots,
    rm.SHAPE_SHELL: rm._get_shell_slots,
}[rm.get_shape(rel)]
try:
    slots = loader(text)
except rm.ShapeError as exc:
    print(f"{rel}: {exc}", file=sys.stderr)
    raise SystemExit(1)
print(" ".join(sorted(slots)))
PY
}

@test "every claimed roster path exists in the tree" {
  run claimed_paths
  [ "${status}" -eq 0 ]
  [ -n "${output}" ]
  local rel
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    [ -f "${GA}/${rel}" ] || {
      echo "claimed path absent from the tree: ${rel}" >&2
      return 1
    }
  done <<<"${output}"
}

@test "every claimed roster path parses under its slot shape" {
  local rel
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    run parse_slots "${rel}"
    [ "${status}" -eq 0 ] || {
      echo "claimed path would be DECLINED at deploy: ${rel} — ${output}" >&2
      return 1
    }
    [ -n "${output}" ]
  done < <(claimed_paths)
}

@test "scope-dev.md declares exactly one brace list" {
  # _get_markdown_slots raises unless there is EXACTLY one, so a second `∈ {…}`
  # anywhere in the file — a quoted example included — declines the row.
  run parse_slots "scoped/scope-dev.md"
  [ "${status}" -eq 0 ]
  [ "${output}" = "agent_scope" ]
}

@test "each claimed shell file keeps at least one space-padded array" {
  local rel
  while IFS= read -r rel; do
    [[ "${rel}" == *.sh ]] || continue
    run parse_slots "${rel}"
    [ "${status}" -eq 0 ]
    [ -n "${output}" ]
  done < <(claimed_paths)
}

@test "the slot wrappers and the chunk library declare no roster array" {
  # A wrapper computes its chunk assignment from the registry; it declares no
  # membership. `_SHELL_ARRAY_RE` selects on the PADDING alone, so any
  # `readonly X=" a b "` added to one would make it a slot — and an unclaimed
  # file carrying a slot is a live operator edit the byte-swap silently discards.
  local f found=0
  for f in "${GA}"/hooks/inject-scope-part-*.sh "${GA}"/hooks/lib/inject-chunk.sh; do
    [[ -f "${f}" ]] || continue
    found=1
    run parse_slots "${f#"${GA}/"}"
    [ "${status}" -ne 0 ] || {
      echo "unclaimed file declares a roster slot: ${f}" >&2
      return 1
    }
  done
  [ "${found}" -eq 1 ]
}

@test "the slot wrappers and the chunk library are not claimed" {
  run claimed_paths
  [ "${status}" -eq 0 ]
  # ONE compound expression, deliberately: a bats body runs under errexit, but a mid-body
  # bare `[[ ]]` is exempt from it on bash 3.2, so a leading `[[ ]]` on its own line gates
  # on CI and silently does not gate on a stock-bash host. The `&&` chain makes the pair
  # the body's LAST command, which gates on both.
  [[ "${output}" != *"inject-scope-part-"* ]] && [[ "${output}" != *"inject-chunk"* ]]
}

@test "styleref-roster.sh survives because a non-injection consumer reads it" {
  # The STYLE-REF injected block is retired and the injector no longer sources this
  # lib, but the FILE must not retire with the block: style-ref-consts.sh still
  # sources it and tests STYLEREF_AGENTS for the style_ref review_flag predicate.
  # Deleting it would also drop a claimed path.
  [ -f "${GA}/hooks/lib/styleref-roster.sh" ]
  run grep -qF "styleref-roster.sh" "${GA}/hooks/lib/style-ref-consts.sh"
  [ "${status}" -eq 0 ]
  run grep -qF "STYLEREF_AGENTS" "${GA}/hooks/lib/style-ref-consts.sh"
  [ "${status}" -eq 0 ]
}
