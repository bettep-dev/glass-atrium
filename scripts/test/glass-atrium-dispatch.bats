#!/usr/bin/env bats
# glass-atrium-dispatch suite — pins the T08 `glass-atrium update` subcommand
# dispatch contract on the BINARY side (updater engine-function side lives in
# glass-atrium-update.bats): dispatch to the updater (ATRIUM_UPDATE_SCRIPT test
# override) forwarding args VERBATIM + propagating its exit code; `--help` forwarded
# to the updater, NOT consumed by ga_parse_args (the installer parser loud-dies on an
# unknown flag); a missing / non-executable updater loud-fails (die → rc 1);
# manifest-hash consistency (doctor §8): tracked hash for `glass-atrium` == live
# sha256, update.sh listed at its post-P1-T0 scripts/ path, --check reports no drift.
# Hermetic: dispatch tests run the REAL binary against a per-test mktemp fake updater
# (ATRIUM_UPDATE_SCRIPT) — gh / /dev/tty / the live skill are never touched; manifest
# tests read the tracked manifest read-only.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
BIN="${GA}/glass-atrium"
MANIFEST="${GA}/manifest.json"
GEN_MANIFEST="${GA}/scripts/generate-manifest.sh"

setup() {
  [[ -f "${BIN}" ]] || skip "glass-atrium binary not found: ${BIN}"
  WORK="$(cd -- "$(mktemp -d -t ga-dispatch-bats.XXXXXX)" && pwd -P)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# shasum (macOS / CI) preferred, coreutils sha256sum as the Linux fallback.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
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

# manifest-hash consistency (doctor §8)

@test "manifest records the live binary sha256 (binary content == hashes[glass-atrium])" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local manifest_hash actual_hash
  manifest_hash="$(jq -r '.hashes["glass-atrium"]' "${MANIFEST}")"
  actual_hash="$(sha256_of "${BIN}")"
  [[ "${manifest_hash}" == "${actual_hash}" ]]
}

@test "manifest lists update.sh at its scripts/ path (moved from the skill dir; subcommand target deployed)" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  # P1-T0 moved update.sh from skills/glass-atrium-update/ to scripts/; the manifest
  # must list the NEW path and drop the retired skill-dir path. Goes GREEN only AFTER
  # the PHASE-end manifest regen — pre-regen the tracked manifest still carries the old
  # skill path, so both assertions below are expected RED.
  run jq -e '.files | index("scripts/update.sh")' "${MANIFEST}"
  [ "$status" -eq 0 ]                                                  # new path present
  run jq -e '.files | index("skills/glass-atrium-update/update.sh")' "${MANIFEST}"
  [ "$status" -ne 0 ]                                                  # retired skill path absent
}

@test "generate-manifest --check reports no source-vs-manifest drift (doctor §8 clean)" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v git >/dev/null 2>&1 || skip "git required"
  # Mirrors the generator's own precondition probe verbatim: a consumer install
  # is not a git work tree, where the generator loud-fails (git ls-files is the
  # file-list SoT) — skip is exactly equivalent to that loud-fail.
  git -C "${GA}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || skip "not a git work tree: ${GA} (consumer install — drift check is repo-only)"
  run bash "${GEN_MANIFEST}" --check
  [ "$status" -eq 0 ]
}
