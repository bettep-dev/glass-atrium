#!/usr/bin/env bats
# glass-atrium-dispatch suite — pins the T08 `glass-atrium update` subcommand
# dispatch contract on the BINARY side (the updater engine-function side lives in
# glass-atrium-update.bats):
#   * `glass-atrium update [args]` dispatches to the updater (ATRIUM_UPDATE_SCRIPT
#     test override), forwarding args VERBATIM and propagating the updater's exit code
#   * `--help` is forwarded to the updater, NOT consumed by ga_parse_args (the
#     installer flag parser, which loud-dies on an unknown flag)
#   * a missing / non-executable updater loud-fails (die → rc 1, no silent absorb)
#   * manifest-hash consistency (doctor §8): the tracked manifest hash for
#     `glass-atrium` equals the live file sha256, the new skill is listed, and
#     generate-manifest --check reports no source-vs-manifest drift
#
# Run via: bats scripts/test/glass-atrium-dispatch.bats
# Requires: bats >= 1.5.0, jq, git, shasum/sha256sum
#
# Hermetic strategy: the dispatch tests run the REAL binary against a per-test
# mktemp fake updater (ATRIUM_UPDATE_SCRIPT) — gh / /dev/tty / the live skill are
# never touched. The manifest tests read the tracked manifest read-only.

bats_require_minimum_version 1.5.0

BIN="${HOME}/.glass-atrium/glass-atrium"
MANIFEST="${HOME}/.glass-atrium/manifest.json"
GEN_MANIFEST="${HOME}/.glass-atrium/scripts/generate-manifest.sh"

setup() {
  [[ -f "${BIN}" ]] || skip "glass-atrium binary not found: ${BIN}"
  WORK="$(cd -- "$(mktemp -d -t ga-dispatch-bats.XXXXXX)" && pwd -P)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
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

# --- subcommand dispatch ---------------------------------------------------

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

# --- manifest-hash consistency (doctor §8) ---------------------------------

@test "manifest records the live binary sha256 (binary content == hashes[glass-atrium])" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local manifest_hash actual_hash
  manifest_hash="$(jq -r '.hashes["glass-atrium"]' "${MANIFEST}")"
  actual_hash="$(sha256_of "${BIN}")"
  [[ "${manifest_hash}" == "${actual_hash}" ]]
}

@test "manifest lists the glass-atrium-update skill (subcommand target is deployed)" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  run jq -e '.files | index("skills/glass-atrium-update/update.sh")' "${MANIFEST}"
  [ "$status" -eq 0 ]
}

@test "generate-manifest --check reports no source-vs-manifest drift (doctor §8 clean)" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v git >/dev/null 2>&1 || skip "git required"
  run bash "${GEN_MANIFEST}" --check
  [ "$status" -eq 0 ]
}
