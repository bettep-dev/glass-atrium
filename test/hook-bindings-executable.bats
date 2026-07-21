#!/usr/bin/env bats
# Guard: every WIRED hook (EXPECTED_HOOK_BINDINGS in lib/ga-env.sh) is git-tracked
# at index mode 100755 AND ships in manifest.json .files. Claude Code exec()s the
# wired command directly, so a wired-but-644 hook is silently inert (fail-open,
# never fires) — the defect this file locks down: enforce-harness-critical.sh and
# validate-edit-syntax.sh shipped wired at git mode 100644 and never ran.
#
# Why the GIT INDEX mode and not `test -x`: every prior check piped envelopes
# through `bash hook.sh`, bypassing the exec bit entirely, and a filesystem
# `[[ -x ]]` is the flaky variant — it breaks under core.fileMode=false / CI
# checkouts and passes VACUOUSLY on a locally chmod-ed tree (exactly the live
# state that masked this defect). The index mode is the load-bearing signal: the
# release bundle is tarred from the working tree, and with core.fileMode=true a
# fresh checkout materializes the index mode on disk.
#
# Scoping rationale (wired roster, NOT a hooks/**/*.sh glob): keying on
# EXPECTED_HOOK_BINDINGS deliberately excludes legitimately-644 sourced libs
# (hooks/lib/hook-utils.sh, style-ref-consts.sh, code-based-grader.sh) that a
# naive glob would false-flag. A wired basename with NO tracked file FAILS
# loudly — wired-but-untracked is a worse defect than wired-but-non-exec.
#
# Run via: bats test/hook-bindings-executable.bats
# Requires: bats (brew install bats-core), git, awk, sed, jq, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CORE="${GA}/lib/ga-env.sh"
MANIFEST="${GA}/manifest.json"

setup() {
  [[ -f "${CORE}" ]] || skip "ga-env.sh not found: ${CORE}"
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "not a git work tree (bundle/fixture run) — index-mode assertion N/A"
}

# emit each EXPECTED_HOOK_BINDINGS row body as "event<TAB>basename<TAB>matcher",
# the array indent + surrounding double-quotes stripped.
# Copied VERBATIM from test/hook-bindings-complete.bats::array_rows — this suite
# has no shared-helper (load) convention, so the parser is duplicated byte-for-byte
# instead of diverging; keep both copies in lockstep on any array-format change
# (each file's count>0 / leaf-count guards fail loudly on drift either way).
array_rows() {
  awk '
    /^[[:space:]]*EXPECTED_HOOK_BINDINGS=\(/ { f = 1; next }
    f && /^[[:space:]]*\)[[:space:]]*$/      { f = 0 }
    f                                        { print }
  ' "${CORE}" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//'
}

# unique wired basenames (2nd TAB-split field); blank fields dropped so a
# malformed row surfaces via the count>0 guard, not a phantom "hooks/" lookup.
wired_basenames() {
  array_rows | awk -F'\t' 'NF >= 2 && $2 != "" { print $2 }' | LC_ALL=C sort -u
}

@test "every wired hook basename is git-tracked at index mode 100755" {
  local name line mode count=0 offenders=""
  while IFS= read -r name; do
    count=$((count + 1))
    line="$(git -C "${GA}" ls-files -s -- "hooks/${name}")"
    if [[ -z "${line}" ]]; then
      offenders="${offenders}
  hooks/${name}: NOT TRACKED in git (wired but absent — worse than non-exec)"
      continue
    fi
    mode="${line%% *}"
    if [[ "${mode}" != "100755" ]]; then
      offenders="${offenders}
  hooks/${name}: git index mode ${mode}, expected 100755"
    fi
  done < <(wired_basenames)
  # count>0 guard: a reformatted array must fail LOUDLY, never pass vacuously.
  if [[ "${count}" -eq 0 ]]; then
    echo "parsed 0 wired basenames from EXPECTED_HOOK_BINDINGS — parser/format drift"
    return 1
  fi
  if [[ -n "${offenders}" ]]; then
    echo "wired hooks failing the git-index exec-bit invariant (${count} checked):${offenders}"
    return 1
  fi
}

@test "every wired hook basename ships in manifest.json .files" {
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  if [[ ! -f "${MANIFEST}" ]]; then
    echo "manifest.json not found: ${MANIFEST} (tracked repo artifact — must exist)"
    return 1
  fi
  jq -e '(.files | type) == "array"' "${MANIFEST}" >/dev/null || {
    echo "manifest.json .files is not an array"
    return 1
  }
  local manifest_files name count=0 offenders=""
  manifest_files="$(jq -r '.files[]' "${MANIFEST}")"
  while IFS= read -r name; do
    count=$((count + 1))
    if ! grep -qxF "hooks/${name}" <<<"${manifest_files}"; then
      offenders="${offenders}
  hooks/${name}: wired but absent from manifest.json .files (never bundled)"
    fi
  done < <(wired_basenames)
  if [[ "${count}" -eq 0 ]]; then
    echo "parsed 0 wired basenames from EXPECTED_HOOK_BINDINGS — parser/format drift"
    return 1
  fi
  if [[ -n "${offenders}" ]]; then
    echo "wired hooks missing from the release manifest (${count} checked):${offenders}"
    return 1
  fi
}
