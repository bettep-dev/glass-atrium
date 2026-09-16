#!/usr/bin/env bats
# run-bats-parallel.bats — stage + exit-code contract of scripts/run-bats-parallel.sh.
#
# The self-improvement daemon reaches the test suite ONLY through this runner and
# consumes only its exit code (autoagent/daemon-apply.sh green-suite gate), so the
# runner's rc IS the gate's verdict. This suite pins the three properties that make
# that verdict trustworthy:
#   - the stages RUN rather than `exec`, so a later stage can still be reached and
#     the rc folds to the MAXIMUM stage rc, never to the last one;
#   - the two unittest roots BOTH run — hooks/test and autoagent/test — because
#     `unittest discover` takes a single -s and a root left out of the runner is a
#     root the daemon's green gate never sees;
#   - stage 4 is conditional on pytest being importable, and its absence is loud
#     (one stderr line) rather than silent;
#   - the bytecode-suppression variable is exported into every child, so a
#     daemon-driven run leaves no __pycache__ for the live recovery-repo snapshot
#     screen to refuse;
#   - every stage banner carries its own duration, which is the ONLY thing that makes
#     the doubled cost of the gate's one flaky-retry visible in the daemon log.
#
# Hermetic: the runner is COPIED into a sandbox, so its REPO_ROOT resolves to that
# sandbox and never to this checkout — no real suite is ever shelled. bats, GNU
# parallel and python3 are stubbed on PATH; the stubs read their behaviour from
# exported STUB_* variables at run time, which keeps every heredoc fully quoted.
# The one exception is the scenario-6 probe, which deliberately calls the REAL
# python3 by absolute path: only a real interpreter can demonstrate that no
# __pycache__ appears.
#
# The seventh test covers the OTHER half of the same bytecode decision. Suppressing
# production in the runner's children (above) misses every interpreter that does not
# come from the runner — an operator running a module by hand, and the daemon cycle,
# which runs its python modules directly. A per-corpus ignore file catches what the
# env misses, and the two legs are pinned together because neither is sufficient alone.
# The eighth then pins those ignore files as manifest-eligible, so they actually ship.
#
# The ninth pins ALL THREE python stages' environment. Redirecting HOME does not sandbox
# a python suite on its own — ga_paths.get_base_root PREFERS GA_DATA_ROOT — so each stage
# scrubs that variable and its update-side twin, and the stub records what it actually
# inherited. A sandbox HOME is asserted for the two unittest stages, and they must be
# DISTINCT: a shared one would hand stage 3 whatever stage 2's suites left behind. Stage 4
# deliberately keeps the caller's HOME, because psycopg lives in the user site-packages dir
# under $HOME and a redirect there silently turns pinned exit-contract branches into skips.
# That asymmetry is left UNPINNED rather than frozen — pinning the caller's HOME would red
# the day someone fixes it. Dropping any asserted leg from the runner reds this test.
#
# The eleventh pins the toolchain preflight probe. git being ON PATH is not git being
# USABLE — an unaccepted Xcode licence answers `git --version` and fails every `git init`
# — and the daemon consumes only this runner's rc, so the distinction survives to it only
# as a RESERVED exit code. Both halves are pinned: the VALUE (a later move into a
# WORST_RC-folding position could otherwise promote it silently) and the PLACEMENT ahead
# of stage 1 (asserted by stage 1 never having run), against the healthy leg in the same
# scenario, which is what makes the probe's no-op claim falsifiable.
#
# The tenth pins the daemon-exported env out of EVERY stage, stage 1 included.
# daemon-cycle.sh exports its apply-scope trio and the resolved claude binary before
# daemon-apply.sh shells this runner, so an unscrubbed stage verifies the suite under the
# daemon's ambient config instead of each suite's own fixture. That is measured on
# AUTOAGENT_GIT_ROOT, which daemon_cycle._resolve_apply_git_scope short-circuits on by
# documented design. The per-root suite-hermeticity.bats probes scrub the same set on their
# identical discover runs, so no probe can read green under conditions its stage lacks.

bats_require_minimum_version 1.5.0

REAL_RUNNER="${BATS_TEST_DIRNAME}/../run-bats-parallel.sh"
GA_ROOT_DIR="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
GENERATOR="${GA_ROOT_DIR}/scripts/generate-manifest.sh"

# The four corpora that produce bytecode, each its OWN git repository on the live
# install. autoagent/ is the one the runner env cannot reach.
CORPUS_IGNORE_FILES=(
  "test/.gitignore"
  "hooks/test/.gitignore"
  "scripts/test/.gitignore"
  "autoagent/.gitignore"
)

# The variables autoagent/daemon-cycle.sh exports on the way to this runner, and the
# python3 env-log field each lands in. Two parallel arrays rather than one associative
# array: bash 3.2 has no `declare -A`.
DAEMON_ENV_NAMES=(
  AUTOAGENT_GIT_ROOT
  AUTOAGENT_GIT_PATHSPEC
  AUTOAGENT_AGENTS_DIR
  AUTOAGENT_CLAUDE_BIN
  CLAUDE_BIN
)
DAEMON_ENV_PY_FIELDS=(6 7 8 5 9)

# Writes stdin to an executable stub of the given name in the stub bin dir.
write_stub() {
  local name="${1}"
  cat >"${STUB_BIN}/${name}"
  chmod +x "${STUB_BIN}/${name}"
}

# Runs the sandboxed runner under the stub PATH and asserts its exit status, dumping the
# runner's stderr on a mismatch. `run --separate-stderr` assigns ${status} and ${stderr}
# in the caller's scope, so a scenario goes on asserting against them after this returns.
# Call it as `run_runner_expecting N || return 1` — the explicit `|| return 1` is what
# gates the test, matching every other assertion here rather than leaning on set -e.
run_runner_expecting() {
  local want="${1}"
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -eq "${want}" ]] || {
    printf 'runner rc=%s (want %s) stderr:\n%s\n' "${status}" "${want}" "${stderr}" >&2
    return 1
  }
}

# Prints one TAB-separated field of the row a stage recorded, identifying the stage by a
# substring of its argv. Empty output means no such row, which every caller checks.
# $1 = argv substring identifying the stage · $2 = 1-based field index
stage_env_field() {
  local row
  row="$(grep -m1 -- "${1}" "${STUB_LOG_DIR}/python3-env.log" || true)"
  [[ -n "${row}" ]] || return 0
  printf '%s\n' "${row}" | cut -f"${2}"
}

# Asserts one python stage recorded every named variable as unset, identifying the stage
# by a substring of its argv. Call it as `assert_stage_unset … || return 1`, matching the
# gating discipline of every other assertion here.
# $1 = argv substring identifying the stage · $2 = human label for the failure message ·
# $3.. = NAME:FIELD pairs, FIELD being the 1-based python3 env-log field NAME lands in
assert_stage_unset() {
  local pattern="${1}" label="${2}" row pair name seen
  shift 2
  row="$(grep -m1 -- "${pattern}" "${STUB_LOG_DIR}/python3-env.log" || true)"
  [[ -n "${row}" ]] || {
    printf 'no %s row in the python3 env log:\n%s\n' "${label}" \
      "$(cat "${STUB_LOG_DIR}/python3-env.log" 2>/dev/null)" >&2
    return 1
  }

  for pair in "$@"; do
    name="${pair%%:*}"
    seen="$(printf '%s\n' "${row}" | cut -f"${pair##*:}")"
    [[ "${seen}" == "__UNSET__" ]] || {
      printf '%s inherited %s=%s; the scrub is missing\n' "${label}" "${name}" "${seen}" >&2
      return 1
    }
  done
}

# Asserts one stage inherited NEITHER data-root variable.
# $1 = argv substring identifying the stage · $2 = human label for the failure message
assert_stage_scrubbed() {
  assert_stage_unset "${1}" "${2}" GA_DATA_ROOT:2 ATRIUM_UPDATE_STATE_DIR:3
}

# Gives every daemon-exported variable an ambient value, so a runner that scrubbed NOTHING
# is distinguishable from one that scrubbed correctly — with them unset the two look alike.
export_daemon_env() {
  export AUTOAGENT_GIT_ROOT="${TMPROOT}/ambient-git-root"
  export AUTOAGENT_GIT_PATHSPEC=ambient-pathspec/
  export AUTOAGENT_AGENTS_DIR="${TMPROOT}/ambient-agents"
  export AUTOAGENT_CLAUDE_BIN="${TMPROOT}/ambient-claude"
  export CLAUDE_BIN="${TMPROOT}/ambient-claude-bin"
}

# Asserts one PYTHON stage inherited none of DAEMON_ENV_NAMES.
# $1 = argv substring identifying the stage · $2 = human label for the failure message
assert_daemon_env_scrubbed() {
  local pairs=() i=0
  while [[ "${i}" -lt "${#DAEMON_ENV_NAMES[@]}" ]]; do
    pairs+=("${DAEMON_ENV_NAMES[${i}]}:${DAEMON_ENV_PY_FIELDS[${i}]}")
    i=$((i + 1))
  done
  assert_stage_unset "${1}" "${2}" "${pairs[@]}"
}

# The stage-1 twin. It reads the bats stub's log because stage 1 makes no python3 call at
# all.
assert_stage1_daemon_env_scrubbed() {
  local log="${STUB_LOG_DIR}/bats-daemon-env.log" name
  [[ -s "${log}" ]] || {
    printf 'no stage 1 env record — the bats stub never ran\n' >&2
    return 1
  }

  for name in "${DAEMON_ENV_NAMES[@]}"; do
    grep -qx -- "${name}=__UNSET__" "${log}" || {
      printf 'stage 1 inherited %s; its env wrapper is missing or incomplete:\n%s\n' \
        "${name}" "$(cat "${log}")" >&2
      return 1
    }
  done
}

setup() {
  if [[ ! -f "${REAL_RUNNER}" ]]; then
    echo "broken tree: run-bats-parallel.sh missing at ${REAL_RUNNER}" >&2
    return 1
  fi
  REAL_PYTHON3="$(command -v python3)" || skip "python3 not found"
  export REAL_PYTHON3

  TMPROOT="$(mktemp -d -t run-bats-parallel-bats.XXXXXX)"
  SANDBOX="${TMPROOT}/repo"
  STUB_BIN="${TMPROOT}/bin"
  STUB_LOG_DIR="${TMPROOT}/log"
  RUNNER="${SANDBOX}/scripts/run-bats-parallel.sh"
  STUB_PATH="${STUB_BIN}:${PATH}"
  export STUB_LOG_DIR
  mkdir -p "${STUB_BIN}" "${STUB_LOG_DIR}/pyprobe" "${SANDBOX}/scripts" \
    "${SANDBOX}/test" "${SANDBOX}/hooks/test" "${SANDBOX}/scripts/test" \
    "${SANDBOX}/autoagent/test"
  cp -- "${REAL_RUNNER}" "${RUNNER}"
  chmod +x "${RUNNER}"

  # The module scenario 6 imports through the REAL interpreter. Its mere import is
  # what would produce __pycache__ next to it.
  printf 'GA_PROBE = 1\n' >"${STUB_LOG_DIR}/pyprobe/ga_probe_mod.py"

  # Records its argv and the bytecode-suppression value it INHERITED, then exits
  # with the rc the scenario asked for. The import probe runs only when armed.
  write_stub bats <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_LOG_DIR}/bats-args.log"
printf '%s\n' "${PYTHONDONTWRITEBYTECODE-__UNSET__}" >>"${STUB_LOG_DIR}/bats-env.log"
# Stage 1 makes no python3 call, so this stub is the only recorder of its environment.
# A separate log because scenario 1 asserts bats-env.log as a whole file.
for n in AUTOAGENT_GIT_ROOT AUTOAGENT_GIT_PATHSPEC AUTOAGENT_AGENTS_DIR AUTOAGENT_CLAUDE_BIN CLAUDE_BIN; do
  printf '%s=%s\n' "${n}" "${!n-__UNSET__}"
done >>"${STUB_LOG_DIR}/bats-daemon-env.log"
if [[ -n "${STUB_BATS_IMPORT_PROBE:-}" ]]; then
  cd -- "${STUB_LOG_DIR}/pyprobe" && "${REAL_PYTHON3}" -c 'import ga_probe_mod'
fi
exit "${STUB_BATS_RC:-0}"
STUB

  # One stub serving all three python3 call shapes. The pytest IMPORT probe is
  # matched first: its argv also contains the word "pytest".
  write_stub python3 <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_LOG_DIR}/python3-args.log"
# One TAB-separated row per call: the argv is what identifies the stage, and the rest are
# what the python stages claim to control. The sentinel distinguishes "unset" from "set to
# empty", which is the whole distinction `env -u` makes. Field order is APPEND-ONLY —
# DAEMON_ENV_PY_FIELDS indexes into it by position.
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$*" "${GA_DATA_ROOT-__UNSET__}" \
  "${ATRIUM_UPDATE_STATE_DIR-__UNSET__}" "${HOME-__UNSET__}" \
  "${AUTOAGENT_CLAUDE_BIN-__UNSET__}" "${AUTOAGENT_GIT_ROOT-__UNSET__}" \
  "${AUTOAGENT_GIT_PATHSPEC-__UNSET__}" "${AUTOAGENT_AGENTS_DIR-__UNSET__}" \
  "${CLAUDE_BIN-__UNSET__}" \
  >>"${STUB_LOG_DIR}/python3-env.log"
case "$*" in
  *'import pytest'*) exit "${STUB_PYTEST_IMPORT_RC:-0}" ;;
  *unittest*) exit "${STUB_UNITTEST_RC:-0}" ;;
  *pytest*) exit "${STUB_PYTEST_RC:-0}" ;;
esac
exit 0
STUB

  # Present only so the runner's `command -v parallel` hard dependency check passes.
  write_stub parallel <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  # A suppression value inherited from the ambient shell would make the export
  # assertions pass without the runner exporting anything.
  unset PYTHONDONTWRITEBYTECODE
}

teardown() {
  [[ -n "${TMPROOT:-}" && -d "${TMPROOT}" ]] && rm -rf -- "${TMPROOT}" || true
}

@test "(1) the child inherits bytecode suppression and each stage banner carries its duration" {
  run_runner_expecting 0 || return 1

  local seen
  seen="$(cat "${STUB_LOG_DIR}/bats-env.log")"
  [[ "${seen}" == "1" ]] || {
    printf 'child PYTHONDONTWRITEBYTECODE=%s (want 1)\n' "${seen}" >&2
    return 1
  }

  # The daemon's green gate re-runs the WHOLE runner once on a first failure, so the
  # python stages are paid TWICE on a red cycle and the per-stage duration is what makes
  # that cost visible in the daemon log. The pattern matches the banner's FULL shape, so
  # dropping only the `(Ns)` fails here as loudly as dropping the banner itself would —
  # without it, the narrower regression is silent. All four stages run in this scenario
  # (the stub pytest import returns 0), hence 4 — and the count is what catches a unittest
  # root silently dropped back out of the runner. `grep -c` prints 0 AND exits 1 on zero
  # matches, so `|| true` (never `|| echo 0`, which would append a second zero to grep's own).
  local banners
  banners="$(printf '%s\n' "${stderr}" \
    | grep -cE '^run-bats-parallel: \[stage [0-9]+/4 [^]]+\] rc=[0-9]+ \([0-9]+s\)$' || true)"
  if [[ -z "${banners}" ]]; then
    banners=0
  fi
  [[ "${banners}" -eq 4 ]] || {
    printf 'duration-carrying stage banners=%s (want 4, one per stage) stderr:\n%s\n' \
      "${banners}" "${stderr}" >&2
    return 1
  }
}

@test "(2) a bats rc of 3 becomes the runner rc while later stages still run" {
  export STUB_BATS_RC=3
  # Folded to the MAXIMUM, not to the last stage: stages 2 and 3 return 0 here.
  run_runner_expecting 3 || return 1

  # An `exec bats` tail would end the process at stage 1 and never reach python3.
  grep -q -- '-m unittest discover' "${STUB_LOG_DIR}/python3-args.log" || {
    printf 'stage 2 never ran; recorded python3 calls:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/python3-args.log" 2>/dev/null)" >&2
    return 1
  }
}

@test "(3) a failing unittest stage fails the runner even when bats passes" {
  export STUB_BATS_RC=0
  export STUB_UNITTEST_RC=1
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -ne 0 ]] || {
    printf 'runner rc=0 despite a failing unittest stage; stderr:\n%s\n' "${stderr}" >&2
    return 1
  }
}

# The gap this closes: `unittest discover` takes ONE -s, so a root omitted from the runner
# is simply never discovered — the run stays green and says nothing. CI loops over both
# roots; the runner is what the daemon's green gate and the pre-merge deploy gate reach,
# so a root missing HERE is a regression those two gates cannot see. Asserted per ROOT
# rather than by call count: a count would pass on the same root discovered twice.
@test "(3b) both unittest roots are discovered, each as its own stage" {
  run_runner_expecting 0 || return 1

  local root
  for root in hooks/test autoagent/test; do
    grep -q -- "-m unittest discover -s ${root} " "${STUB_LOG_DIR}/python3-args.log" || {
      printf 'no unittest discover recorded for %s; recorded python3 calls:\n%s\n' \
        "${root}" "$(cat "${STUB_LOG_DIR}/python3-args.log" 2>/dev/null)" >&2
      return 1
    }
  done
}

@test "(4) an unimportable pytest skips stage 4 loudly on one line and keeps rc 0" {
  export STUB_PYTEST_IMPORT_RC=1
  run_runner_expecting 0 || return 1

  if grep -q -- '-m pytest' "${STUB_LOG_DIR}/python3-args.log"; then
    printf 'stage 4 ran despite an unimportable pytest:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/python3-args.log")" >&2
    return 1
  fi
  local skips
  # `grep -c` prints 0 AND exits 1 on zero matches, so `|| true` (never `|| echo 0`,
  # which would append a second zero to grep's own).
  skips="$(printf '%s\n' "${stderr}" | grep -c 'SKIP' || true)"
  if [[ -z "${skips}" ]]; then
    skips=0
  fi
  [[ "${skips}" -eq 1 ]] || {
    printf 'SKIP lines=%s (want exactly 1) stderr:\n%s\n' "${skips}" "${stderr}" >&2
    return 1
  }
}

@test "(5) an importable pytest runs stage 4 against scripts/test" {
  run_runner_expecting 0 || return 1

  grep -q -- '-m pytest.*scripts/test' "${STUB_LOG_DIR}/python3-args.log" || {
    printf 'no scripts/test pytest call recorded; recorded python3 calls:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/python3-args.log" 2>/dev/null)" >&2
    return 1
  }
}

@test "(6) a child importing a module leaves no __pycache__ behind" {
  export STUB_BATS_IMPORT_PROBE=1
  run_runner_expecting 0 || return 1

  [[ ! -e "${STUB_LOG_DIR}/pyprobe/__pycache__" ]] || {
    printf 'bytecode cache written next to the imported module:\n%s\n' \
      "$(ls -a "${STUB_LOG_DIR}/pyprobe")" >&2
    return 1
  }
}

# Each corpus is its OWN git repository on the live install, so the monorepo root
# .gitignore never reaches it. The recovery snapshot screens `git status --porcelain
# --untracked-files=all` per repo and refuses the WHOLE run on an untracked __pycache__,
# which is the refusal the live install carries today. The sandbox repo shape mirrors
# that: the ignore file sits at the repo ROOT, which is what a corpus directory becomes
# once it is git-init'd.
#
# Both rules are exercised against REAL artefacts — the interpreter's own __pycache__
# tree, and a stray sibling .pyc that the directory rule alone would leave visible.
@test "(7) each corpus ignore file hides the bytecode its suites produce" {
  local rel src repo dirty
  for rel in "${CORPUS_IGNORE_FILES[@]}"; do
    src="${GA_ROOT_DIR}/${rel}"
    [[ -f "${src}" ]] || {
      printf 'missing corpus ignore file: %s\n' "${rel}" >&2
      return 1
    }

    repo="${TMPROOT}/ignore-repo-${rel//\//-}"
    mkdir -p "${repo}"
    cp -- "${src}" "${repo}/.gitignore"
    printf 'GA_CORPUS = 1\n' >"${repo}/mod.py"
    git -C "${repo}" init -q
    git -C "${repo}" config user.email bats@test.local
    git -C "${repo}" config user.name bats
    git -C "${repo}" add .gitignore mod.py
    git -C "${repo}" commit -qm init

    # setup() unsets PYTHONDONTWRITEBYTECODE, so production is ON here — this is the
    # interpreter run that happens OUTSIDE the runner, which the env leg cannot cover.
    (cd -- "${repo}" && "${REAL_PYTHON3}" -c 'import mod') || {
      printf '%s: the probe module would not import\n' "${rel}" >&2
      return 1
    }
    (cd -- "${repo}" && "${REAL_PYTHON3}" -c \
      'import py_compile; py_compile.compile("mod.py", cfile="stray.pyc")') || {
      printf '%s: could not produce a stray .pyc\n' "${rel}" >&2
      return 1
    }
    [[ -d "${repo}/__pycache__" && -f "${repo}/stray.pyc" ]] || {
      printf '%s: expected bytecode artefacts absent under %s\n' "${rel}" "${repo}" >&2
      return 1
    }

    git -C "${repo}" check-ignore -q -- __pycache__ || {
      printf '%s: __pycache__ is not ignored\n' "${rel}" >&2
      return 1
    }
    git -C "${repo}" check-ignore -q -- stray.pyc || {
      printf '%s: a stray .pyc is not ignored — the *.pyc rule is missing\n' "${rel}" >&2
      return 1
    }

    dirty="$(git -C "${repo}" status --porcelain --untracked-files=all)"
    [[ -z "${dirty}" ]] || {
      printf '%s: the snapshot screen would refuse — status is not clean:\n%s\n' \
        "${rel}" "${dirty}" >&2
      return 1
    }
  done
}

# The barrier task regenerates manifest.json; what a regeneration cannot tell you
# afterwards is whether a path was ELIGIBLE or merely happened to be picked up. Membership
# is `git ls-files` narrowed by the generator's SCOPE_PATHS and filtered by its EXCLUDE_RE,
# and both are READ FROM the generator here rather than copied — a copy would drift the
# moment either changed, which is the failure this guard exists to catch.
@test "(8) the four corpus ignore paths are manifest-eligible" {
  [[ -f "${GENERATOR}" ]] || {
    printf 'broken tree: generate-manifest.sh missing at %s\n' "${GENERATOR}" >&2
    return 1
  }

  local scope_entries exclude_line exclude_re
  scope_entries="$(sed -n \
    '/^readonly -a SCOPE_PATHS=(/,/^)/{ s/^[[:space:]]*"\([^"]*\)".*/\1/p; }' \
    "${GENERATOR}")"
  [[ -n "${scope_entries}" ]] || {
    printf 'could not read SCOPE_PATHS out of %s\n' "${GENERATOR}" >&2
    return 1
  }

  # Unwrapped by parameter expansion rather than a sed script: the value is single-quoted
  # in the source and contains backslashes, which a nested quoting layer would mangle.
  exclude_line="$(grep -m1 '^readonly EXCLUDE_RE=' "${GENERATOR}")"
  exclude_re="${exclude_line#*=}"
  exclude_re="${exclude_re#\'}"
  exclude_re="${exclude_re%\'}"
  [[ -n "${exclude_re}" ]] || {
    printf 'could not read EXCLUDE_RE out of %s\n' "${GENERATOR}" >&2
    return 1
  }

  local rel entry covered
  for rel in "${CORPUS_IGNORE_FILES[@]}"; do
    [[ -f "${GA_ROOT_DIR}/${rel}" ]] || {
      printf 'missing corpus ignore file: %s\n' "${rel}" >&2
      return 1
    }

    covered=0
    while IFS= read -r entry; do
      if [[ "${rel}" == "${entry}" || "${rel}" == "${entry}/"* ]]; then
        covered=1
        break
      fi
    done <<<"${scope_entries}"
    [[ "${covered}" -eq 1 ]] || {
      printf '%s: outside every generator SCOPE_PATHS entry\n' "${rel}" >&2
      return 1
    }

    if printf '%s\n' "${rel}" | grep -qE "${exclude_re}"; then
      printf '%s: dropped by the generator EXCLUDE_RE\n' "${rel}" >&2
      return 1
    fi
  done
}

# Stage 2's sandbox is THREE variables, not one. ga_paths.get_base_root reads GA_DATA_ROOT
# first and only falls back to $HOME/.glass-atrium, so a HOME-only redirect leaves an
# ambient GA_DATA_ROOT — a sandbox install, an outer harness — steering a module that
# forgot its own sandbox into the live data root, while the redirected HOME reads clean.
# hooks/test/suite-hermeticity.bats scrubs the pair on the identical discover run; this
# pins the runner to the same environment, so the probe cannot pass under conditions the
# stage it stands for does not share. The ambient values below are set deliberately: with
# them unset, a runner that scrubbed nothing would look identical.
#
# Stage 3 carries the same scrub and is asserted the same way. What it does NOT carry is
# the sandbox HOME, deliberately: psycopg is reachable only through the user site-packages
# dir under $HOME, so a redirect drops it from the interpreter
# test_pg_dual_write_exit_contract.py probes for and three pinned exit branches become
# skips (measured 2026-09-01). Its HOME is therefore left unasserted rather than pinned to
# the caller's — pinning the status quo would red the day that dependency is solved, which
# is the opposite of what this test is for.
@test "(9) every python stage runs data-root-scrubbed; each unittest stage is sandboxed" {
  export GA_DATA_ROOT="${TMPROOT}/ambient-data-root"
  export ATRIUM_UPDATE_STATE_DIR="${TMPROOT}/ambient-update-state"
  run_runner_expecting 0 || return 1

  # Each stage is identified by its OWN root, never by `-m unittest discover` alone: with
  # two unittest stages that substring matches whichever ran first and the second would go
  # unasserted. `-m pytest` identifies stage 4 alone — the import probe's argv is
  # `-c import pytest`.
  assert_stage_scrubbed 'discover -s hooks/test' 'stage 2' || return 1
  assert_stage_scrubbed 'discover -s autoagent/test' 'stage 3' || return 1
  assert_stage_scrubbed '-m pytest' 'stage 4' || return 1

  # The redirect is the third leg of each unittest stage's claim: scrubbing the two
  # variables while leaving HOME at the operator's own would put the fallback root back on
  # the live install. The two sandboxes must also DIFFER — sharing one would hand stage 3
  # whatever stage 2's suites wrote, which is the isolation the separate dirs exist for.
  local hooks_home autoagent_home
  hooks_home="$(stage_env_field 'discover -s hooks/test' 4)"
  autoagent_home="$(stage_env_field 'discover -s autoagent/test' 4)"
  local label seen
  for label in "stage 2:${hooks_home}" "stage 3:${autoagent_home}"; do
    seen="${label#*:}"
    [[ -n "${seen}" && "${seen}" != "__UNSET__" && "${seen}" != "${HOME}" ]] || {
      printf '%s ran under HOME=%s (want a sandbox, not the caller HOME and not unset)\n' \
        "${label%%:*}" "${seen}" >&2
      return 1
    }
  done
  [[ "${hooks_home}" != "${autoagent_home}" ]] || {
    printf 'both unittest stages shared HOME=%s; each needs its own sandbox\n' \
      "${hooks_home}" >&2
    return 1
  }
}

# Asserted per STAGE rather than once over the whole log: stage 1 has its own env wrapper,
# so a whole-log check could pass on a stage-1 leak.
@test "(10) every stage runs with the daemon-exported env scrubbed" {
  export_daemon_env
  run_runner_expecting 0 || return 1

  assert_stage1_daemon_env_scrubbed || return 1
  assert_daemon_env_scrubbed 'discover -s hooks/test' 'stage 2' || return 1
  assert_daemon_env_scrubbed 'discover -s autoagent/test' 'stage 3' || return 1
  assert_daemon_env_scrubbed '-m pytest' 'stage 4' || return 1
}

# The value is a LITERAL here on purpose: this is the contract that DEFINES it, so reading
# it out of the runner would assert only that the runner agrees with itself. The daemon's
# mirror of the same number is pinned against the runner's source separately
# (autoagent/test/daemon-apply-preflight.bats).
@test "(11) an unusable git exits the reserved toolchain rc before stage 1, and is a no-op otherwise" {
  # Exit 69 is what the Xcode licence gate itself returns; any non-zero reproduces the
  # condition, since the probe reads only whether `git init` succeeded.
  write_stub git <<'STUB'
#!/usr/bin/env bash
printf 'You have not agreed to the Xcode license agreements\n' >&2
exit 69
STUB

  run_runner_expecting 17 || return 1
  [[ "${stderr}" == *"toolchain precondition FAILED"* ]] || {
    printf 'no toolchain clause on stderr:\n%s\n' "${stderr}" >&2
    return 1
  }
  # Placement: the probe sits in main's preflight block, so NO stage ran. The bats stub
  # writes this log on every invocation, which makes its absence the placement assertion.
  [[ ! -e "${STUB_LOG_DIR}/bats-args.log" ]] || {
    printf 'stage 1 ran before the toolchain probe:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/bats-args.log")" >&2
    return 1
  }

  # The healthy leg, in the SAME scenario: with the real git back, the probe changes
  # nothing. Asserted here rather than left to the other scenarios so that a probe which
  # ALWAYS refused would fail this test rather than pass its own half.
  rm -f -- "${STUB_BIN}/git"
  run_runner_expecting 0 || return 1
  grep -q -- '--no-parallelize-within-files' "${STUB_LOG_DIR}/bats-args.log" || {
    printf 'stage 1 did not run on a healthy toolchain; recorded bats calls:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/bats-args.log" 2>/dev/null)" >&2
    return 1
  }
}
