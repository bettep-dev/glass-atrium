#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2034,SC2154,SC2312  # per-@test subshell env + engine globals read by the sourced lib; probe substitutions intended
# config-binary-paths.bats — the binary paths config.toml carries into the launchd definitions.
#
# A path through a package manager's version-free prefix survives that manager's upgrade; a versioned
# Homebrew Cellar path does not. Each row builds a real symlinked tree in the sandbox, so the physical
# and logical forms of a path genuinely differ.
#
# Hermetic: a throwaway config.toml (GA_CONFIG_TOML / ATRIUM_CONFIG_TOML) and stub binaries only; no
# real config.toml, Homebrew tree or node is read.
#
# Run via: bats test/config-binary-paths.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  # physical sandbox root: /var/folders is itself a symlink, which would blur every row below
  SANDBOX="$(cd -P -- "$(mktemp -d -t ga-config-bins-bats.XXXXXX)" && pwd)"
  BREW="${SANDBOX}/brew"
  seed_homebrew_tree
  seed_fnm_tree
  export GA_CONFIG_TOML="${SANDBOX}/config.toml" ATRIUM_CONFIG_TOML="${SANDBOX}/config.toml"
  export GA_DATA_ROOT="${SANDBOX}/data" AUTOAGENT_REPORTS_DIR="${SANDBOX}/data/reports"
  export GA_PG_SOCKET="${SANDBOX}"
  trap - ERR
  # shellcheck source=/dev/null
  source "${GA}/lib/ga-core.sh"
  ga_init_env "${GA}"
  DRY_RUN=false
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# put_stub_bin <path> — an executable stand-in binary.
put_stub_bin() {
  mkdir -p -- "$(dirname -- "$1")"
  printf '#!/bin/sh\n' >"$1"
  chmod +x "$1"
}

# Homebrew layout: <prefix>/Cellar/<formula>/<version> holds the files; <prefix>/opt/<formula> and
# <prefix>/bin/<tool> are the version-free symlinks. `legacy` has a Cellar keg and no opt link.
seed_homebrew_tree() {
  put_stub_bin "${BREW}/Cellar/node@22/22.11.0/bin/node"
  put_stub_bin "${BREW}/Cellar/legacy/1.0/bin/node"
  mkdir -p -- "${BREW}/opt" "${BREW}/bin"
  ln -s ../Cellar/node@22/22.11.0 "${BREW}/opt/node@22"
  ln -s ../Cellar/node@22/22.11.0/bin/node "${BREW}/bin/node"
}

# fnm layout: a per-shell symlink dir that dies with its shell, pointing at the installed version.
seed_fnm_tree() {
  put_stub_bin "${SANDBOX}/fnm/node-versions/v22/installation/bin/node"
  mkdir -p -- "${SANDBOX}/fnm/multishells"
  ln -s ../node-versions/v22/installation "${SANDBOX}/fnm/multishells/4711"
}

# write_paths_config <node_bin> — a config whose [paths] holds the given node_bin and a working claude_bin.
write_paths_config() {
  put_stub_bin "${SANDBOX}/claude/bin/claude"
  printf '[paths]\nnode_bin = "%s"\nclaude_bin = "%s"\n' "$1" "${SANDBOX}/claude/bin/claude" >"${GA_CONFIG_TOML}"
}

@test "ga_resolve_bin keeps a Homebrew version-free path and canonicalizes any other" {
  local row label input want got
  local -a rows=(
    "keg-only opt path kept|${BREW}/opt/node@22/bin/node|${BREW}/opt/node@22/bin/node"
    "prefix bin path kept|${BREW}/bin/node|${BREW}/bin/node"
    "Cellar path moves to its opt twin|${BREW}/Cellar/node@22/22.11.0/bin/node|${BREW}/opt/node@22/bin/node"
    "Cellar path without an opt twin kept|${BREW}/Cellar/legacy/1.0/bin/node|${BREW}/Cellar/legacy/1.0/bin/node"
    "per-shell fnm symlink resolved to its install|${SANDBOX}/fnm/multishells/4711/bin/node|${SANDBOX}/fnm/node-versions/v22/installation/bin/node"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r label input want <<<"${row}"
    got="$(ga_resolve_bin "${input}")"
    [[ "${got}" == "${want}" ]] || {
      echo "${label}: got ${got}, want ${want}"
      return 1
    }
  done
}

@test "resolve_config_binaries keeps a working stable node_bin of an existing config and repairs any other" {
  local row label mode current path_dir want got
  local -a rows=(
    "existing stable value kept over another PATH node|existing|${BREW}/opt/node@22/bin/node|${SANDBOX}/fnm/multishells/4711/bin|${BREW}/opt/node@22/bin/node"
    "existing Cellar value moves to its twin|existing|${BREW}/Cellar/node@22/22.11.0/bin/node|${SANDBOX}/fnm/multishells/4711/bin|${BREW}/opt/node@22/bin/node"
    "existing missing value takes the PATH node in stable form|existing|${SANDBOX}/gone/bin/node|${BREW}/opt/node@22/bin|${BREW}/opt/node@22/bin/node"
    "fresh template value takes the PATH node|template|${BREW}/bin/node|${BREW}/opt/node@22/bin|${BREW}/opt/node@22/bin/node"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r label mode current path_dir want <<<"${row}"
    write_paths_config "${current}"
    PATH="${path_dir}:${SANDBOX}/claude/bin:/usr/bin:/bin" resolve_config_binaries "${mode}" 2>/dev/null
    got="$(atrium_toml_get '[paths]' 'node_bin')"
    [[ "${got}" == "${want}" ]] || {
      echo "${label}: got ${got}, want ${want}"
      return 1
    }
  done
}

@test "resolve_config_binaries leaves an existing config byte-identical when nothing changes" {
  write_paths_config "${BREW}/opt/node@22/bin/node"
  # an atomic rewrite renames a new file into place, so an unchanged inode means no write
  local before
  before="$(ls -i -- "${GA_CONFIG_TOML}")"
  PATH="${BREW}/opt/node@22/bin:${SANDBOX}/claude/bin:/usr/bin:/bin" resolve_config_binaries existing 2>/dev/null
  [[ "$(ls -i -- "${GA_CONFIG_TOML}")" == "${before}" ]] || {
    echo "config rewritten"
    return 1
  }
}
