#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_TEST_DIRNAME / BATS_TEST_TMPDIR are assigned by the bats runtime
# doc-status-vocabulary-pin.bats — every doc_status literal the harness writes is a stage of the monitor's
#   DOC_STAGES list (monitor/src/server/routes/clauded-docs.ts, read-only; never WRITE_DOC_STATUSES, which
#   still accepts the retired alias).
#
# SLOTS — a token is a status literal only in one of these; free single-word prose is not recognizable at
# usable precision, so the retired stage keeps its own regression row:
#   binding        doc_status followed by : = == → -> (JSON body, jq, query list, arrow prose)
#   enumeration    2+ backticked tokens joined by · , / or and — one of them a stage
#   table column   2+ cells of one column led by backticked tokens — one of them a stage
#   list siblings  2+ same-indent list items led by backticked tokens — one of them a stage
#   `done` never anchors a slot — it doubles as a [COMPLETION] result value.
# SCAN SET: the eight shipped harness roots minus their test dirs — test fixtures carry the retired stage on
#   purpose, pinning that readers ignore it.

HARNESS_ROOT="${BATS_TEST_DIRNAME}/../.."
ROUTE_TS="${HARNESS_ROOT}/monitor/src/server/routes/clauded-docs.ts"
US=$'\x1f'

# read -d '' rather than $(cat <<'PY') — bash 3.2 mis-parses a backtick inside a heredoc inside $().
IFS= read -r -d '' EXTRACTOR_PY <<'PY' || true
import os
import re
import sys

TOKEN = r"[a-z][a-z0-9_]*"
ROOTS = ("agents", "rules", "scoped", "skills", "hooks", "scripts", "lib", "autoagent")
SKIPPED = ("hooks/test", "scripts/test", "autoagent/test")
AMBIGUOUS_STAGE = "done"
BINDING = re.compile(r"doc_status[\"']?\s*(?:==|=|:|→|->)\s*[\"'`]?(" + TOKEN + r"(?:," + TOKEN + r")*)")
SPAN = re.compile(r"`(" + TOKEN + r")`")
LIST_SEP = re.compile(r"\s*(?:·|,|/|or|and|,\s*or|,\s*and)\s*")
CELL_LEAD = re.compile(r"\s*(?:\*\*)?`(" + TOKEN + r")`")
LIST_ITEM = re.compile(r"\s*(?:[-*]|\d+\.)\s")
ITEM_LEAD = re.compile(r"(\s*)(?:[-*]|\d+\.)\s+(?:\*\*)?`(" + TOKEN + r")`")


def get_stages(route):
    if not os.path.isfile(route):
        return []
    with open(route, encoding="utf-8") as handle:
        match = re.search(r"\bDOC_STAGES\b[^=\n]*=\s*\[(.*?)\]", handle.read(), re.S)
    return re.findall(r'"([^"]+)"', match.group(1)) if match else []


def get_texts(root):
    for base in ROOTS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(root, base)):
            rel = os.path.relpath(dirpath, root)
            dirnames[:] = sorted(d for d in dirnames if os.path.join(rel, d) not in SKIPPED and d != "__pycache__")
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                try:
                    with open(path, encoding="utf-8") as handle:
                        yield os.path.relpath(path, root), handle.read().splitlines()
                except (UnicodeDecodeError, OSError):
                    continue


def get_anchored(group, anchors):
    if len(group) >= 2 and any(token in anchors for _, token in group):
        yield from group


def find_bound(lines, _anchors):
    for number, line in enumerate(lines, 1):
        for match in BINDING.finditer(line):
            for token in match.group(1).split(","):
                yield number, token


def find_enumerated(lines, anchors):
    for number, line in enumerate(lines, 1):
        runs, previous = [], None
        for span in SPAN.finditer(line):
            if previous is None or not LIST_SEP.fullmatch(line[previous.end():span.start()]):
                runs.append([])
            runs[-1].append((number, span.group(1)))
            previous = span
        for run in runs:
            yield from get_anchored(run, anchors)


def get_column_leads(block, column):
    for number, cells in block:
        match = CELL_LEAD.match(cells[column]) if column < len(cells) else None
        if match:
            yield number, match.group(1)


def find_tabulated(lines, anchors):
    block = []
    for number, line in enumerate(lines + [""], 1):
        if line.lstrip().startswith("|"):
            block.append((number, line.strip().strip("|").split("|")))
            continue
        for column in range(max((len(cells) for _, cells in block), default=0)):
            yield from get_anchored(list(get_column_leads(block, column)), anchors)
        block = []


def find_listed(lines, anchors):
    groups, block = {}, 0
    for number, line in enumerate(lines, 1):
        if not LIST_ITEM.match(line) and not (line.strip() and line[:1].isspace()):
            block += 1
            continue
        lead = ITEM_LEAD.match(line)
        if lead:
            groups.setdefault((block, len(lead.group(1))), []).append((number, lead.group(2)))
    for group in groups.values():
        yield from get_anchored(group, anchors)


def check_vocabulary(root, route):
    stages = get_stages(route)
    if not stages:
        print(f"no DOC_STAGES list readable in {route}")
        return 2
    anchors = set(stages) - {AMBIGUOUS_STAGE}
    count, outside = 0, []
    for path, lines in get_texts(root):
        found = set()
        for slot in (find_bound, find_enumerated, find_tabulated, find_listed):
            found.update(slot(lines, anchors))
        count += len(found)
        outside += [f"{path}:{number}: {token}" for number, token in sorted(found) if token not in stages]
    print("\n".join(outside + [f"{count} status literals checked against DOC_STAGES {stages}"]))
    return 1 if outside or count == 0 else 0


def check_retired(root, token):
    hits = [f"{path}:{number}" for path, lines in get_texts(root)
            for number, line in enumerate(lines, 1) if f"`{token}`" in line]
    print("\n".join(hits))
    return 1 if hits else 0


if __name__ == "__main__":
    mode, root, operand = sys.argv[1:4]
    sys.exit(check_vocabulary(root, operand) if mode == "vocabulary" else check_retired(root, operand))
PY

setup() {
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
}

# find_outside_literals ROOT ROUTE — prints each status literal outside DOC_STAGES; non-zero on any,
# on an unreadable DOC_STAGES list, or when no literal is recognized at all.
find_outside_literals() {
  python3 -c "${EXTRACTOR_PY}" vocabulary "${1}" "${2}"
}

# find_retired_mentions ROOT TOKEN — prints each backticked TOKEN in the scan set; non-zero on any.
find_retired_mentions() {
  python3 -c "${EXTRACTOR_PY}" retired "${1}" "${2}"
}

# build_root DIR CONTENT — a one-file harness under DIR holding CONTENT (printf %b escapes expanded).
build_root() {
  mkdir -p "${1}/skills"
  printf '%b\n' "${2}" >"${1}/skills/planted.md"
}

@test "every status literal in the harness is a stage of the monitor's DOC_STAGES list" {
  run find_outside_literals "${HARNESS_ROOT}" "${ROUTE_TS}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}

@test "no harness text names the retired progress stage" {
  run find_retired_mentions "${HARNESS_ROOT}" progress
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}

@test "each slot reports a stage-shaped token DOC_STAGES lacks" {
  local row name content index=0
  local rows=(
    "binding, JSON body${US}{\"doc_status\":\"in_progress\"}"
    "binding, jq select${US}jq '.rows[] | select(.doc_status == \"in_progress\")'"
    "binding, query list${US}curl \"\${URL}?doc_status=implementing,in_progress&limit=200\""
    "binding, arrow prose${US}transition \`doc_status → in_progress\` once built"
    "enumeration${US}stages: \`doc_review\` · \`in_progress\` · \`done\`"
    "table column${US}| \`implementing\` | started |\n| \`in_progress\` | stray |"
    "list siblings${US}- \`impl_review\` while gaps remain\n- \`in_progress\` while building"
  )
  for row in "${rows[@]}"; do
    IFS="${US}" read -r name content <<<"${row}"
    index=$((index + 1))
    build_root "${BATS_TEST_TMPDIR}/${index}" "${content}"
    run find_outside_literals "${BATS_TEST_TMPDIR}/${index}" "${ROUTE_TS}"
    [[ "${status}" -eq 1 && "${output}" == *"skills/planted.md:"*": in_progress"* ]] || {
      echo "${name}: ${output}"
      return 1
    }
  done
}

@test "shapes outside every slot are not reported" {
  local row name content index=0 member='\n{"doc_status":"done"}'
  local rows=(
    "result-value table anchored only by done${US}| \`done\` | complete |\n| \`done_with_concerns\` | caveats |${member}"
    "binding to a variable${US}jq -n '{doc_status: \$s}'${member}"
    "backticked key before prose${US}- \`doc_status\`: one of \`doc_review\` · \`done\`"
    "identifier enumeration without a stage${US}\`folder_id\` · \`supersedes_id\` · \`expected_hash\`${member}"
    "list items without a stage${US}- \`folder_id\` first\n- \`supersedes_id\` second${member}"
  )
  for row in "${rows[@]}"; do
    IFS="${US}" read -r name content <<<"${row}"
    index=$((index + 1))
    build_root "${BATS_TEST_TMPDIR}/${index}" "${content}"
    run find_outside_literals "${BATS_TEST_TMPDIR}/${index}" "${ROUTE_TS}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: ${output}"
      return 1
    }
  done
}

@test "the pin fails closed when it cannot read the stage list or recognizes no literal" {
  local row name route content index=0
  local rows=(
    "route without DOC_STAGES${US}declared${US}{\"doc_status\":\"done\"}"
    "route file missing${US}missing${US}{\"doc_status\":\"done\"}"
    "no literal recognized${US}real${US}prose only"
  )
  printf '%s\n' 'export const OTHER_STAGES = ["done"];' >"${BATS_TEST_TMPDIR}/declared.ts"
  for row in "${rows[@]}"; do
    IFS="${US}" read -r name route content <<<"${row}"
    index=$((index + 1))
    build_root "${BATS_TEST_TMPDIR}/${index}" "${content}"
    case "${route}" in
      declared) route="${BATS_TEST_TMPDIR}/declared.ts" ;;
      missing) route="${BATS_TEST_TMPDIR}/absent.ts" ;;
      *) route="${ROUTE_TS}" ;;
    esac
    run find_outside_literals "${BATS_TEST_TMPDIR}/${index}" "${route}"
    [[ "${status}" -ne 0 ]] || {
      echo "${name}: ${output}"
      return 1
    }
  done
}
