#!/usr/bin/env bats
# glass-atrium-dispatch suite — pins the T08 `glass-atrium update` subcommand
# dispatch contract on the BINARY side (updater engine-function side lives in
# glass-atrium-update.bats): dispatch to the updater (ATRIUM_UPDATE_SCRIPT test
# override) forwarding args VERBATIM + propagating its exit code; `--help` forwarded
# to the updater, NOT consumed by ga_parse_args (the installer parser loud-dies on an
# unknown flag); a missing / non-executable updater loud-fails (die → rc 1); the
# RETIRED skill-dir update.sh path never returns to the shipped manifest maps.
# Hermetic: dispatch tests run the REAL binary against a per-test mktemp fake updater
# (ATRIUM_UPDATE_SCRIPT) — gh / /dev/tty / the live skill are never touched; the
# manifest assertion reads the tracked manifest read-only.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
BIN="${GA}/glass-atrium"
MANIFEST="${GA}/manifest.json"

setup() {
  [[ -f "${BIN}" ]] || skip "glass-atrium binary not found: ${BIN}"
  WORK="$(cd -- "$(mktemp -d -t ga-dispatch-bats.XXXXXX)" && pwd -P)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Write an executable fake updater at $1 that echoes its args and exits $2. The
# heredoc is unquoted ONLY for ${code}; the args expansion is escaped (\$*) so it
# survives into the generated script verbatim.
make_fake_updater() {
  local path="$1" code="$2"
  cat >"${path}" <<EOF
#!/usr/bin/env bash
printf 'FAKE_UPDATER args=[%s]\n' "\$*"
exit ${code}
EOF
  chmod +x "${path}"
}

# subcommand dispatch

@test "glass-atrium update dispatches to the updater, forwards args, propagates the exit code" {
  local fake="${WORK}/fake-update.sh"
  make_fake_updater "${fake}" 42
  run env ATRIUM_UPDATE_SCRIPT="${fake}" bash "${BIN}" update --foo bar
  [ "$status" -eq 42 ]                                   # updater rc propagated verbatim
  [[ "$output" == *"FAKE_UPDATER args=[--foo bar]"* ]]   # args forwarded verbatim
}

@test "glass-atrium update --help is forwarded to the updater (not ga_parse_args)" {
  local fake="${WORK}/fake-update.sh"
  make_fake_updater "${fake}" 0
  run env ATRIUM_UPDATE_SCRIPT="${fake}" bash "${BIN}" update --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"FAKE_UPDATER args=[--help]"* ]]
  # the updater owns --help — the installer flag parser must NEVER see it (it dies
  # with "unknown argument" on an unrecognized flag).
  [[ "$output" != *"unknown argument"* ]]
}

@test "glass-atrium update loud-fails when the updater is missing" {
  run env ATRIUM_UPDATE_SCRIPT="${WORK}/does-not-exist.sh" bash "${BIN}" update
  [ "$status" -eq 1 ]
  [[ "$output" == *"updater not found"* ]]
}

@test "glass-atrium update loud-fails when the updater is not executable" {
  local nonexec="${WORK}/nonexec-update.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${nonexec}" # deliberately NOT chmod +x
  run env ATRIUM_UPDATE_SCRIPT="${nonexec}" bash "${BIN}" update
  [ "$status" -eq 1 ]
  [[ "$output" == *"not executable"* ]]
}

# manifest: the retired updater path never returns to the shipped set

@test "the retired skill-dir update.sh path stays out of the shipped manifest maps" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  # P1-T0 moved update.sh from skills/glass-atrium-update/ to scripts/. That the NEW
  # path is listed is covered by manifest-check-clean.bats AC-17 (--check's MISSING
  # direction); this pins the other half, which --check structurally CANNOT decide.
  # Re-add the retired path as a git-tracked file and it becomes legitimately
  # tracked: a regeneration puts it back into files[] and, by the generator's
  # files[]/retired[] disjointness rule, DROPS its retired[] removal row — so the
  # path silently re-ships and consumers never delete it, while --check stays clean.
  # All three shipped maps are checked so a hand-edit of any one of them is caught.
  run jq -e --arg p "skills/glass-atrium-update/update.sh" \
    '(.files | index($p)) == null and (.hashes | has($p) | not) and (.modes | has($p) | not)' \
    "${MANIFEST}"
  [ "$status" -eq 0 ]
}
