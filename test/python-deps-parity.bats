#!/usr/bin/env bats
# python-deps-parity.bats — binds the DECLARED python dependency set (requirements.txt) to the
# EXECUTED one (the GA_PYTHON_IMPORTS array in lib/ga-deps.sh).
#
# Runs UNGUARDED: every file it reads is a manifest member that exists in a consumer install, so
# paths resolve from GA_ROOT rather than from a repo-checkout assumption.

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

@test "parity: requirements.txt declaration set == GA_PYTHON_IMPORTS executed set" {
  command -v python3 >/dev/null 2>&1 \
    || skip "python3 absent — the PEP-503 normalization has no runner"
  local declared executed
  declared="$(_dist_names <"${GA_ROOT}/requirements.txt")"
  executed="$(_array_pip_names | _dist_names)"
  if [[ "${declared}" != "${executed}" ]]; then
    printf 'declared (requirements.txt):\n%s\n' "${declared}" >&2
    printf 'executed (GA_PYTHON_IMPORTS):\n%s\n' "${executed}" >&2
    return 1
  fi
}
