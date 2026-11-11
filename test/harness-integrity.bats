#!/usr/bin/env bats
# Harness integrity detector (lib/ga-doctor.sh): install files vs manifest.json, the vendor-owned
# part of merge-claimed rows vs their base@install anchor, surplus agent/hook files, the manifest vs
# the applied-release record, and the Atrium hook bindings vs EXPECTED_HOOK_BINDINGS.
# Detection only: every function reports and counts, none blocks or fails its caller.
#
# Hermetic: a scratch install (mktemp) as GA_ROOT, a scratch HOME/settings, a scratch update-state
# dir; the real engine is sourced in its own strict-mode subprocess.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || skip "shasum/sha256sum required"
  SANDBOX="$(mktemp -d)"
  ROOT="${SANDBOX}/ga"
  FAKE_HOME="${SANDBOX}/home"
  STATE="${SANDBOX}/state"
  mkdir -p "${ROOT}/agents" "${ROOT}/hooks" "${FAKE_HOME}/.claude" "${STATE}/base-agents" "${STATE}/base-roster/hooks"
  seed_release
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

sha_hex() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# A release as shipped: one agent body, two roster files, one plain hook, the manifest over them,
# and the base@install anchors an update leaves behind.
seed_release() {
  cat >"${ROOT}/agents/dev-a.md" <<'MD'
---
name: dev-a
tools: Read, Grep
scope: dev
---
# Dev A
<!-- EDITABLE:BEGIN -->
- learned bullet one
<!-- EDITABLE:END -->
Vendor rule text.
MD
  printf '%s\n' '{' '  "agents": {' '    "dev-a": {' '      "rules": {' '        "scope": "dev"' '      }' '    }' '  }' '}' >"${ROOT}/agent-registry.json"
  printf '%s\n' '#!/usr/bin/env bash' 'readonly DEV_AGENTS=" dev-a "' 'printf "%s\n" "${DEV_AGENTS}"' >"${ROOT}/hooks/inject-scope-rules.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"${ROOT}/hooks/hook-a.sh"
  write_manifest agents/dev-a.md agent-registry.json hooks/inject-scope-rules.sh hooks/hook-a.sh
  cp "${ROOT}/agents/dev-a.md" "${STATE}/base-agents/dev-a.md"
  cp "${ROOT}/agent-registry.json" "${STATE}/base-roster/agent-registry.json"
  cp "${ROOT}/hooks/inject-scope-rules.sh" "${STATE}/base-roster/hooks/inject-scope-rules.sh"
  cp "${ROOT}/manifest.json" "${STATE}/baseline-manifest.json"
}

write_manifest() {
  local rel files hashes
  files="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  hashes="$(for rel in "$@"; do printf '%s\t%s\n' "${rel}" "$(sha_hex "${ROOT}/${rel}")"; done \
    | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}')"
  jq -n --argjson files "${files}" --argjson hashes "${hashes}" '{version:"1.0.0", files:$files, hashes:$hashes}' >"${ROOT}/manifest.json"
}

# Run one detector function against the scratch install; stdout = its count, stderr = its report.
run_detector() {
  run --separate-stderr env GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${STATE}" \
    GA_TARGET_HOME="${FAKE_HOME}/.claude" GA_MANIFEST="${ROOT}/manifest.json" \
    bash -c 'set -Eeuo pipefail; source "$1/lib/ga-core.sh"; ga_init_env "$2"; shift 2; "$@"' _ "${GA}" "${ROOT}" "$@"
}

run_file_drift() {
  # shellcheck disable=SC2046  # the resolver line is the sha command's words
  run_detector manifest_hash_drift $(if command -v shasum >/dev/null 2>&1; then echo shasum -a 256; else echo sha256sum; fi)
}

@test "a merge-claimed row reads as drift exactly when its vendor-owned part changes" {
  local row name edit want
  local -a rows=(
    "untouched release|true|0"
    "learned bullet inside an EDITABLE region|perl -pi -e 's/^- learned bullet one/- learned bullet two/' agents/dev-a.md|0"
    "live-only model pin|perl -pi -e 's/^scope: dev\$/scope: dev\nmodel: opus/' agents/dev-a.md|0"
    "tools allowlist widened|perl -pi -e 's/^tools: Read, Grep/tools: Read, Grep, Bash/' agents/dev-a.md|1"
    "scope identity key changed|perl -pi -e 's/^scope: dev/scope: qa/' agents/dev-a.md|1"
    "vendor text outside the EDITABLE regions changed|perl -pi -e 's/^Vendor rule text\./Rewritten rule./' agents/dev-a.md|1"
    "live agent added to the registry|jq '.agents[\"dev-b\"]={\"rules\":{\"scope\":\"dev\"}}' agent-registry.json >r.tmp && mv r.tmp agent-registry.json|0"
    "vendor registry row altered|jq '.agents[\"dev-a\"].rules.scope=\"qa\"' agent-registry.json >r.tmp && mv r.tmp agent-registry.json|1"
    "live agent added to a roster array|perl -pi -e 's/\" dev-a \"/\" dev-a dev-b \"/' hooks/inject-scope-rules.sh|0"
    "injection hook code changed outside its arrays|printf 'exit 7\n' >>hooks/inject-scope-rules.sh|1"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name edit want <<<"${row}"
    seed_release
    (cd "${ROOT}" && eval "${edit}")
    run_file_drift
    [[ "${status}" -eq 0 && "${output}" == "${want}" ]] || {
      echo "${name}: status ${status}, drift '${output}', expected ${want}: ${stderr}"
      return 1
    }
  done
}

@test "a changed identity key is named in the drift report" {
  perl -pi -e 's/^tools: Read, Grep/tools: Read, Grep, Bash/' "${ROOT}/agents/dev-a.md"

  run_file_drift

  [[ "${stderr}" == *"vendor-owned part changed: agents/dev-a.md (frontmatter identity key(s) changed: tools)"* ]] || {
    echo "${stderr}"
    return 1
  }
}

@test "a changed claimed row with no base@install anchor at the release hash reads as unverified drift" {
  printf -- '- live bullet\n' >>"${ROOT}/agents/dev-a.md"
  printf 'stale base\n' >"${STATE}/base-agents/dev-a.md"

  run_file_drift

  [[ "${output}" == "1" && "${stderr}" == *"vendor-owned part unverified: agents/dev-a.md"* ]] || {
    echo "drift '${output}': ${stderr}"
    return 1
  }
}

@test "file hashing forks one sha process however many rows the manifest lists" {
  local stub="${SANDBOX}/count-sha.sh" calls line
  printf '%s\n' '#!/usr/bin/env bash' 'printf x >>"${COUNT_FILE}"' 'exec shasum -a 256 "$@"' >"${stub}"
  chmod +x "${stub}"
  command -v shasum >/dev/null 2>&1 || skip "shasum required for the counting stub"
  export COUNT_FILE="${SANDBOX}/calls"
  for line in b c d; do printf 'exit 0\n' >"${ROOT}/hooks/hook-${line}.sh"; done
  write_manifest agents/dev-a.md agent-registry.json hooks/inject-scope-rules.sh hooks/hook-a.sh hooks/hook-b.sh hooks/hook-c.sh hooks/hook-d.sh

  run_detector manifest_hash_drift "${stub}"

  calls="$(wc -c <"${COUNT_FILE}")"
  [[ "${output}" == "0" && "${calls// /}" == "1" ]] || {
    echo "drift '${output}', sha calls ${calls}: ${stderr}"
    return 1
  }
}

@test "agent bodies and top-level hooks on disk but absent from the manifest are reported as surplus" {
  printf -- '---\nname: rogue\n---\n' >"${ROOT}/agents/rogue.md"
  printf '#!/usr/bin/env bash\n' >"${ROOT}/hooks/rogue.sh"
  mkdir -p "${ROOT}/agents/references"
  printf 'nested\n' >"${ROOT}/agents/references/note.md"

  run_detector get_surplus_file_drift

  [[ "${output}" == "2" && "${stderr}" == *"surplus file: agents/rogue.md"* && "${stderr}" == *"surplus file: hooks/rogue.sh"* ]] || {
    echo "surplus '${output}': ${stderr}"
    return 1
  }
}

@test "a manifest whose hash table differs from the applied-release record reads as drift" {
  local row name edit want
  local -a rows=(
    "manifest as applied|true|0"
    "hash row rewritten in the live manifest|jq '.hashes[\"hooks/hook-a.sh\"]=\"00\"' manifest.json >m.tmp && mv m.tmp manifest.json|1"
    "no applied-release record yet|rm -f -- \"\${STATE:?}/baseline-manifest.json\"|0"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name edit want <<<"${row}"
    seed_release
    (cd "${ROOT}" && STATE="${STATE}" eval "${edit}")
    run_detector get_manifest_anchor_drift
    [[ "${output}" == "${want}" ]] || {
      echo "${name}: drift '${output}', expected ${want}: ${stderr}"
      return 1
    }
  done
}

# settings.json with the given (event, basename, matcher) Atrium bindings plus one foreign user hook.
write_settings() {
  local -a args=()
  local row
  for row in "$@"; do args+=("${row}"); done
  printf '%s\n' "${args[@]}" | jq -R --arg dir "${FAKE_HOME}/.glass-atrium/hooks/" 'split("\t")' \
    | jq -s --arg dir "${FAKE_HOME}/.glass-atrium/hooks/" '
      reduce .[] as $b ({hooks: {}};
        .hooks[$b[0]] += [{matcher: ($b[2] // ""), hooks: [{type: "command", command: ($dir + $b[1])}]}])
      | .hooks.PreToolUse += [{matcher: "Bash", hooks: [{type: "command", command: "/usr/local/bin/my-hook.sh"}]}]' \
      >"${FAKE_HOME}/.claude/settings.json"
}

# Every expected binding, read from the engine itself.
get_expected_bindings() {
  env GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" bash -c 'source "$1/lib/ga-env.sh"; ga_init_env "$2"; printf "%s\n" "${EXPECTED_HOOK_BINDINGS[@]}"' _ "${GA}" "${ROOT}"
}

@test "hook bindings report missing, altered and surplus Atrium bindings and ignore foreign hooks" {
  local -a expected=() live=()
  local line first
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  first="${expected[0]}"
  live=("${expected[@]:2}")
  live+=("${first%$'\t'*}"$'\t'"Write")
  live+=($'PreToolUse\trogue.sh\tBash')
  write_settings "${live[@]}"

  run_detector get_hook_binding_drift all

  [[ "${stderr}" == *"binding missing:"*"${expected[1]%%$'\t'*}"* ]] || {
    echo "missing row: ${stderr}"
    return 1
  }
  [[ "${stderr}" == *"binding altered:"* ]] || {
    echo "altered row: ${stderr}"
    return 1
  }
  [[ "${stderr}" == *"binding surplus: PreToolUse rogue.sh"* ]] || {
    echo "surplus row: ${stderr}"
    return 1
  }
  [[ "${stderr}" != *"my-hook.sh"* && "${output}" == "3" ]] || {
    echo "count '${output}': ${stderr}"
    return 1
  }
}

@test "the expected binding set wired exactly reads clean" {
  local -a expected=()
  local line
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  write_settings "${expected[@]}"

  run_detector get_hook_binding_drift all

  [[ "${output}" == "0" ]] || {
    echo "count '${output}': ${stderr}"
    return 1
  }
}

@test "the integrity run records a verdict the session-start line reads" {
  local -a expected=()
  local line
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  write_settings "${expected[@]}"
  printf 'tampered\n' >>"${ROOT}/hooks/hook-a.sh"

  run_detector get_integrity_drift

  [[ "${status}" -eq 0 && "${output}" == "1" ]] || {
    echo "status ${status}, count '${output}': ${stderr}"
    return 1
  }
  IFS=$'\t' read -r _ line _ <"${SANDBOX}/data/data/integrity/last-verdict"
  [[ "${line}" == "1" ]] || {
    echo "verdict count '${line}'"
    return 1
  }
}
