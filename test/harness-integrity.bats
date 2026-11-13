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
  load 'lib/bats-db-seal'
  ga_bats_db_seal
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

@test "a listed file that is missing or unreadable on disk reads as one drift" {
  local row name edit report
  local -a rows=(
    "listed hook missing on disk|mv hooks/hook-a.sh \"\${SANDBOX:?}/hook-a.moved\"|listed file missing on disk: hooks/hook-a.sh"
    "listed agent body missing on disk|mv agents/dev-a.md \"\${SANDBOX:?}/dev-a.moved\"|listed file missing on disk: agents/dev-a.md"
    "listed hook not readable|chmod 000 hooks/hook-a.sh|listed file not readable: hooks/hook-a.sh"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name edit report <<<"${row}"
    chmod 644 "${ROOT}/hooks/hook-a.sh" 2>/dev/null || true
    seed_release
    (cd "${ROOT}" && SANDBOX="${SANDBOX}" eval "${edit}")
    run_file_drift
    [[ "${status}" -eq 0 && "${output}" == "1" && "${stderr}" == *"${report}"* ]] || {
      echo "${name}: status ${status}, drift '${output}': ${stderr}"
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
    "no applied-release record yet|mv -- \"\${STATE}/baseline-manifest.json\" \"\${STATE}/baseline-manifest.json.gone\"|0"
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

# settings.json with the given (event, basename, matcher) Atrium bindings, each carrying the options the engine
# declares for it as wire_hooks writes them, plus one foreign user hook.
write_settings() {
  local -a args=()
  local row options
  for row in "$@"; do args+=("${row}"); done
  options="$(get_expected_option_rows | jq -R 'split("\t") | {key: (.[0] + "\t" + .[1]), value: (.[2] | fromjson)}' \
    | jq -s 'from_entries')"
  printf '%s\n' "${args[@]}" | jq -R --arg dir "${FAKE_HOME}/.glass-atrium/hooks/" 'split("\t")' \
    | jq -s --arg dir "${FAKE_HOME}/.glass-atrium/hooks/" --argjson options "${options}" '
      reduce .[] as $b ({hooks: {}};
        .hooks[$b[0]] += [{matcher: ($b[2] // ""),
          hooks: [{type: "command", command: ($dir + $b[1])} + ($options[$b[0] + "\t" + $b[1]] // {})]}])
      | .hooks.PreToolUse += [{matcher: "Bash", hooks: [{type: "command", command: "/usr/local/bin/my-hook.sh"}]}]' \
      >"${FAKE_HOME}/.claude/settings.json"
}

# Every declared binding-options row, read from the engine itself.
get_expected_option_rows() {
  env GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" GA_DATA_ROOT="${SANDBOX}/data" bash -c 'source "$1/lib/ga-env.sh"
    ga_init_env "$2"; source "$1/lib/ga-config-hooks.sh"; get_expected_binding_option_rows' _ "${GA}" "${ROOT}"
}

# Every expected binding, read from the engine itself.
get_expected_bindings() {
  env GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" GA_DATA_ROOT="${SANDBOX}/data" bash -c 'source "$1/lib/ga-env.sh"; ga_init_env "$2"; printf "%s\n" "${EXPECTED_HOOK_BINDINGS[@]}"' _ "${GA}" "${ROOT}"
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
  # the moved binding counts twice — its expected matcher missing, its live matcher altered — as the doctor counts it
  [[ "${stderr}" != *"my-hook.sh"* && "${output}" == "4" ]] || {
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

# Run one detector with the binding-options table replaced by $1 (rows, one per line).
run_detector_with_options() {
  local rows="$1"
  shift
  run --separate-stderr env GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${STATE}" \
    GA_TARGET_HOME="${FAKE_HOME}/.claude" GA_MANIFEST="${ROOT}/manifest.json" \
    bash -c 'set -Eeuo pipefail; source "$1/lib/ga-core.sh"; ga_init_env "$2"
      option_rows="$3"
      get_expected_binding_option_rows() { printf "%s\n" "${option_rows}"; }
      shift 3; "$@"' _ "${GA}" "${ROOT}" "${rows}" "$@"
}

@test "a declared binding option the live command lacks reads as drift, and an undeclared user key never does" {
  local -a expected=()
  local line settings="${FAKE_HOME}/.claude/settings.json"
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  write_settings "${expected[@]}"
  jq '(.hooks.Stop[].hooks[] | select(.command | endswith("/cost-tracker.sh"))) += {timeout: 1200}
    | (.hooks.Stop[].hooks[] | select(.command | endswith("/advisory-preedit-facts.sh"))) += {timeout: 5}' \
    "${settings}" >"${settings}.next" || return 1
  mv -f "${settings}.next" "${settings}"

  run_detector_with_options $'Stop\tcost-tracker.sh\t{"asyncRewake":true,"timeout":1200}' get_hook_binding_drift all

  [[ "${stderr}" == *"binding options: Stop cost-tracker.sh"*"asyncRewake"* ]] || {
    echo "options row: ${stderr}"
    return 1
  }
  [[ "${output}" == "1" && "${stderr}" != *"advisory-preedit-facts.sh"* ]] || {
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

@test "a profile branch whose settings.json is not a link to the target settings reads as drift" {
  local row name setup want branch="${FAKE_HOME}/.claude-work"
  local -a rows=(
    "branch linked to the target settings|ln -s \"\${FAKE_HOME}/.claude/settings.json\" settings.json|0"
    "branch holding its own settings file|printf '{}\n' >settings.json|1"
    "branch linked elsewhere|printf '{}\n' >other.json && ln -s \"\${PWD}/other.json\" settings.json|1"
    "branch with no settings.json|true|1"
    "never-launched dir without .claude.json|mv .claude.json claude.json.gone && printf '{}\n' >settings.json|0"
  )
  printf '{}\n' >"${FAKE_HOME}/.claude/settings.json"
  for row in "${rows[@]}"; do
    IFS='|' read -r name setup want <<<"${row}"
    if ga_guard_path "${branch}"; then rm -rf -- "${branch:?}"; fi
    mkdir -p "${branch}" && printf '{}\n' >"${branch}/.claude.json"
    (cd "${branch}" && FAKE_HOME="${FAKE_HOME}" eval "${setup}")
    run_detector get_profile_settings_drift
    [[ "${status}" -eq 0 && "${output}" == "${want}" ]] || {
      echo "${name}: status ${status}, drift '${output}', expected ${want}: ${stderr}"
      return 1
    }
  done
}

@test "the doctor records the same verdict count as the update preflight for one install state" {
  local -a expected=() live=()
  local row name dropped want doctor preflight line
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  # dropped = one expected row left unwired; the secret-scan hook stays wired under its other matcher
  local -a rows=(
    "bindings as expected||0"
    "one matcher facet of a two-matcher hook unwired|PreToolUse	validate-secret-scan.sh	Bash|1"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name dropped want <<<"${row}"
    live=()
    for line in "${expected[@]}"; do [[ "${line}" == "${dropped}" ]] || live+=("${line}"); done
    [[ -z "${dropped}" || "${#live[@]}" -eq $((${#expected[@]} - 1)) ]] || {
      echo "${name}: '${dropped}' is not an expected binding row"
      return 1
    }
    write_settings "${live[@]}"
    run_detector _doctor_report_integrity 0 0
    IFS=$'\t' read -r _ doctor _ <"${SANDBOX}/data/data/integrity/last-verdict"
    run_detector get_integrity_drift
    IFS=$'\t' read -r _ preflight _ <"${SANDBOX}/data/data/integrity/last-verdict"
    [[ "${doctor}" == "${want}" && "${preflight}" == "${want}" ]] || {
      echo "${name}: doctor recorded '${doctor}', preflight recorded '${preflight}', expected ${want}"
      return 1
    }
  done
}

# A sha256 stub that fails every call, prepended to PATH so the doctor's resolver picks it.
seed_failing_shasum() {
  mkdir -p "${SANDBOX}/stub-bin"
  printf '%s\n' '#!/bin/sh' 'echo "stub-shasum: refused" >&2' 'exit 1' >"${SANDBOX}/stub-bin/shasum"
  chmod +x "${SANDBOX}/stub-bin/shasum"
}

# Run the real run_doctor against the scratch install; extra `env` assignments come first.
run_whole_doctor() {
  run --separate-stderr env GA_MANIFEST="${ROOT}/manifest.json" "$@" ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-1}" \
    GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${STATE}" \
    GA_TARGET_HOME="${FAKE_HOME}/.claude" bash -c 'set -Eeuo pipefail; source "$1/lib/ga-core.sh"; ga_init_env "$2"; run_doctor' \
    _ "${GA}" "${ROOT}"
}

@test "a doctor run whose file comparison could not run records the verdict unread" {
  load 'lib/bats-db-seal'
  ga_bats_db_seal
  local row name assign setup line verdict
  local verdict_file="${SANDBOX}/data/data/integrity/last-verdict"
  local -a expected=()
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  seed_failing_shasum
  local -a rows=(
    "the sha256 tool fails over the manifest rows|PATH=${SANDBOX}/stub-bin:${PATH}|:"
    "a consumer install whose manifest is absent|GA_MANIFEST=${SANDBOX}/no-manifest.json|:"
    "a source tree whose manifest generator is not executable|GA_ROW=generator|mkdir .git"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name assign setup <<<"${row}"
    if ga_guard_path "${ROOT}"; then rm -rf -- "${ROOT:?}/.git"; fi
    seed_release
    write_settings "${expected[@]}"
    (cd "${ROOT}" && eval "${setup}")
    mkdir -p "${verdict_file%/*}" && printf '0\tstale\n' >"${verdict_file}"

    run_whole_doctor "${assign}"

    IFS=$'\t' read -r _ verdict _ <"${verdict_file}"
    [[ "${verdict}" == "unread" ]] || {
      echo "${name}: verdict '${verdict}', status ${status}: ${output} ${stderr}"
      return 1
    }
  done
}

# Run update.sh's integrity report for stage $1 against the scratch install.
run_update_report() {
  run --separate-stderr env GA_ROOT="${ROOT}" GA_LIB_DIR="${GA}/scripts/lib" HOME="${FAKE_HOME}" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${STATE}" GA_TARGET_HOME="${FAKE_HOME}/.claude" \
    bash -c 'set -Eeuo pipefail; source "$1/scripts/update.sh"; update_report_integrity "$2"' _ "${GA}" "$1"
}

@test "the update integrity report logs each finding and its count" {
  local -a expected=()
  local line
  while IFS= read -r line; do expected+=("${line}"); done < <(get_expected_bindings)
  write_settings "${expected[@]}"
  ln -s "${GA}/lib" "${ROOT}/lib"
  ln -s "${GA}/scripts" "${ROOT}/scripts"
  ln -s "${GA}/autoagent" "${ROOT}/autoagent"
  printf 'tampered\n' >>"${ROOT}/hooks/hook-a.sh"

  run_update_report before

  [[ "${status}" -eq 0 ]] || {
    echo "status ${status}: ${stderr}"
    return 1
  }
  [[ "${stderr}" == *"integrity before update: warn : manifest DRIFT — content hash mismatch: hooks/hook-a.sh"* ]] || {
    echo "${stderr}"
    return 1
  }
  [[ "${stderr}" == *"integrity before update: 1 finding(s)"* ]] || {
    echo "${stderr}"
    return 1
  }
}

@test "an update integrity report that cannot run is one log line and never fails the update" {
  local row name engine want
  local -a rows=(
    "engine absent from the install root|none|lib/ga-core.sh absent"
    "engine fails to load|return 1|the check could not run"
    "engine init fails|ga_init_env() { return 1; }|the check could not run"
    "report ends in no count|ga_init_env() { :; }; get_integrity_drift() { echo garbage; }|the check could not run"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name engine want <<<"${row}"
    if ga_guard_path "${ROOT}"; then rm -rf -- "${ROOT:?}/lib"; fi
    if [[ "${engine}" != "none" ]]; then
      mkdir -p "${ROOT}/lib" && printf '%s\n' "${engine}" >"${ROOT}/lib/ga-core.sh"
    fi
    run_update_report after
    [[ "${status}" -eq 0 && "${stderr}" == *"integrity after update: "*"${want}"* ]] || {
      echo "${name}: status ${status}: ${stderr}"
      return 1
    }
  done
}
