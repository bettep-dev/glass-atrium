#!/usr/bin/env bats
# python-deps-parity.bats — binds the DECLARED python dependency set (requirements.txt)
# to the EXECUTED one (the GA_PYTHON_IMPORTS array in lib/ga-deps.sh), and keeps tracked
# prose from re-claiming that requirements.txt is read at runtime or is the install source.
#
# Execution-surface split (deliberate):
#   * parity + control-group existence run UNGUARDED — every file they read is a manifest
#     member that exists in a consumer install, so paths resolve from GA_ROOT rather than
#     from a repo-checkout assumption.
#   * the prose assertion is repo-wide over TRACKED files (`git grep`), which is undefined
#     in a consumer install (no .git there) → work-tree guard + a skip carrying its reason.
#
# The prose assertion's evaluation unit is a SENTENCE, not a line: in three of the corrected
# regions the literal and the predicate sit on different lines, so a line-unit implementation
# would be permanently inert there.

setup() {
  GA_ROOT="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
}

# PEP-508 → PEP-503 normalization: drop environment markers, version specifiers and extras,
# then case-fold and collapse -_. runs, so a legitimate version pin is never banned.
_dist_names() {
  # SC2259: a heredoc would OWN stdin and starve the piped package list — capture the
  # program first, then let stdin carry the data.
  local py_src
  py_src="$(cat <<'PY'
import re, sys
out = set()
for line in sys.stdin:
    line = line.split('#', 1)[0].strip()
    if not line or line.startswith('-'):
        continue
    line = line.split(';', 1)[0]
    line = re.split(r'[<>=!~]', line, maxsplit=1)[0]
    line = re.sub(r'\[.*?\]', '', line)
    name = line.strip()
    if name:
        out.add(re.sub(r'[-_.]+', '-', name).lower())
print('\n'.join(sorted(out)))
PY
)"
  python3 -c "${py_src}"
}

_array_pip_names() {
  (
    # shellcheck source=/dev/null
    source "${GA_ROOT}/lib/ga-deps.sh"
    printf '%s\n' "${GA_PYTHON_IMPORTS[@]}"
  ) | sed 's/^[^:]*://'
}

_prose_claim_scan() {
  python3 - "${GA_ROOT}" "$@" <<'PY'
import os, re, sys

root, paths = sys.argv[1], sys.argv[2:]
ANCHOR = 'requirements.txt'
DECL = {'requirements.txt', 'requirements-dev.txt'}
CLAIM = re.compile(
    r'(\bSoT\b)'
    r'|(consumed\s+in\s+place)'
    r'|(bootstrap\s+manifest)'
    r'|(\binstalled\s+by\b)'
    r'|(-r\s+`?requirements\.txt)'
    r'|(\breads?\s+`?(the\s+)?requirements\.txt)'
    r'|(\b(python-deps|package|dependency|runtime)\s+source\b)'
    r'|(\bread\s+at\s+runtime\b)',
    re.I)


def regions(path, lines):
    """(lines, is_comment) tuples — a maximal comment run, a markdown list item or
    paragraph, or a bare code line."""
    out, cur = [], []
    if path.endswith('.md'):
        for i, raw in enumerate(lines, 1):
            s = raw.strip()
            if not s:
                if cur:
                    out.append((cur, False))
                    cur = []
                continue
            if cur and re.match(r'^\s*([-*+]|\d+[.)])\s', raw):
                out.append((cur, False))
                cur = []
            cur.append((i, s))
        if cur:
            out.append((cur, False))
        return out
    for i, raw in enumerate(lines, 1):
        s = raw.strip()
        if s.startswith('#'):
            cur.append((i, s.lstrip('#').strip()))
            continue
        if cur:
            out.append((cur, True))
            cur = []
        if s:
            out.append(([(i, s)], False))
    if cur:
        out.append((cur, True))
    return out


def sentences(reg):
    parts, lmap = [], []
    for ln, txt in reg:
        if parts:
            parts.append(' ')
            lmap.append(ln)
        parts.append(txt)
        lmap.extend([ln] * len(txt))
    text = ''.join(parts)
    spans, start = [], 0
    for m in re.finditer(r'[.;](?=\s|$)', text):
        spans.append((start, text[start:m.end()]))
        start = m.end()
    if start < len(text):
        spans.append((start, text[start:]))
    out = []
    for i, s in spans:
        if not s.strip():
            continue
        while i < len(text) and text[i].isspace():
            i += 1
        out.append((lmap[i] if i < len(lmap) else lmap[-1], s.strip()))
    return out


rc = 0
for path in paths:
    full = os.path.join(root, path)
    try:
        with open(full, encoding='utf-8', errors='replace') as fh:
            lines = fh.read().splitlines()
    except OSError:
        continue
    base = os.path.basename(path)
    for reg, is_comment in regions(path, lines):
        for ln, sent in sentences(reg):
            anchored = ANCHOR in sent or (base in DECL and is_comment)
            if anchored and CLAIM.search(sent):
                print('%s:%d: %s' % (path, ln, sent[:150]))
                rc = 1
sys.exit(rc)
PY
}

@test "parity: requirements.txt declaration set == GA_PYTHON_IMPORTS executed set" {
  local declared executed
  declared="$(_dist_names <"${GA_ROOT}/requirements.txt")"
  executed="$(_array_pip_names | _dist_names)"
  if [[ "${declared}" != "${executed}" ]]; then
    printf 'declared (requirements.txt):\n%s\n' "${declared}" >&2
    printf 'executed (GA_PYTHON_IMPORTS):\n%s\n' "${executed}" >&2
    return 1
  fi
}

@test "prose: no tracked file claims requirements.txt is read at runtime or is the install source" {
  git -C "${GA_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "Repo-only: the scan is \`git grep\` over tracked files, so a consumer install skips"
  local -a files=()
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] && files+=("${rel}")
  done < <({ git -C "${GA_ROOT}" grep -lF 'requirements.txt' -- .; printf 'requirements.txt\nrequirements-dev.txt\n'; } | sort -u)
  run _prose_claim_scan "${files[@]}"
  if [[ "${status}" -ne 0 ]]; then
    printf 'runtime-consumption claims still present:\n%s\n' "${output}" >&2
    return 1
  fi
}

@test "control group: the four upper-bound mentions still exist at their sites" {
  grep -qF '"requirements.txt"' "${GA_ROOT}/lib/ga-env.sh"
  grep -qF 'the tracked root `requirements.txt`' "${GA_ROOT}/LICENSES-THIRD-PARTY.md"
  grep -qF 'install requirements.txt on this leg' "${GA_ROOT}/scripts/test/sync-registry-tools.bats"
  grep -qF 'manifest entry not installed: requirements.txt' "${GA_ROOT}/test/doctor-consumer-install.bats"
}
