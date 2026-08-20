#!/usr/bin/env bats
# glass-atrium-update suite — pins the E3 T09 update-skill adapter contract:
# resolution helpers (GA_ROOT / reports-dir / .apply-lock / release slug); .apply-lock
# serialize — a mid-apply daemon is signalled by .apply-lock CONTENTION (the retired
# update_head_is_wip / [WIP-AUTO]-HEAD detector is gone): a stale/dead lock is
# reclaimed, a live one blocks; the changed-file set — no path-pattern refusal holds a
# row back from it; update_serialize_begin / update_cleanup — lock acquired,
# contention loud-fails, stale lock reclaimed, trap releases it; end-to-end
# run via the ATRIUM_UPDATE_SRC_DIR seam (verify → deterministic non-agent sync →
# baseline — every changed file applies, the run asks nothing); boundary asserts — NOT a merge engine
# (agent md excluded), and core.autoagent_proposals reachable through the single
# sanctioned resolved-gap envelope channel only (no raw SQL, one emitter, one pipe).
# git is deliberately NOT required — the flow is git-free end to end, proving it runs
# on a git-less no-.git consumer host.
# Hermetic: every test runs in a per-test mktemp sandbox with GA_ROOT /
# AUTOAGENT_REPORTS_DIR / ATRIUM_UPDATE_STATE_DIR redirected
# into it; libs are sourced from the REAL install (REAL_LIB_ROOT). The download is
# bypassed via ATRIUM_UPDATE_SRC_DIR — /dev/tty and gh are never touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Exported so the `declare -f load_skill`-injected helper resolves them inside the
# fresh `bash -c` children that tests 4-6 spawn: a non-exported var is unbound
# under the strict-mode `set -u` load_skill enables → spurious rc1.
export SKILL="${GA}/scripts/update.sh"
export REAL_LIB_ROOT="${GA}"
export GEN_MANIFEST="${GA}/scripts/generate-manifest.sh"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-bats.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT (the live install under test)
  NEWSRC="${WORK}/newsrc"   # the staged new-release tree (test seam source)
  STATE="${WORK}/state"     # reports / baseline sandbox
  mkdir -p "${INSTALL}" "${NEWSRC}" "${STATE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Write file $2 (relative) with content $3 under root $1, creating parent dirs.
seed_file() {
  local root="$1" rel="$2" content="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  printf '%s' "${content}" >"${root}/${rel}"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Build a manifest.json at $1 listing relative paths $2.. rooted at the NEWSRC tree.
write_manifest() {
  local out="$1"
  shift
  local p hashes="" files=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${p}" | jq -R .):$(sha256_of "${NEWSRC}/${p}" | jq -R .),"
  done
  printf '{"version":"1.0.0","files":[%s],"hashes":{%s}}\n' \
    "${files%,}" "${hashes%,}" >"${out}"
}

# Seed the charter pair as the live tree carries it: a real file plus the link row
# pointing at it. Args: $1 = root · $2 = charter content.
seed_charter_pair() {
  local root="$1" content="$2"
  seed_file "${root}" "agents/GLASS_ATRIUM_GLOBAL_RULES.md" "${content}"
  mkdir -p -- "${root}/rules/glass-atrium"
  ln -sfn "../../agents/GLASS_ATRIUM_GLOBAL_RULES.md" \
    "${root}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"
}

# write_manifest plus a modes map (644 per row, as the shipped manifest records a
# link row too) — the mode reconciler's symlink arm needs a row to skip.
write_manifest_with_modes() {
  local out="$1"
  shift
  local p hashes="" files="" modes=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${p}" | jq -R .):$(sha256_of "${NEWSRC}/${p}" | jq -R .),"
    modes="${modes}$(printf '%s' "${p}" | jq -R .):\"644\","
  done
  printf '{"version":"1.0.0","files":[%s],"hashes":{%s},"modes":{%s}}\n' \
    "${files%,}" "${hashes%,}" "${modes%,}" >"${out}"
}

# Source the skill (functions only — the `if BASH_SOURCE==$0` guard prevents
# update_main from running) then source its libs, under full strict mode.
load_skill() {
  set -Eeuo pipefail
  IFS=$'\n\t'
  export GA_ROOT="${INSTALL}"
  export AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports"
  export ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state"
  # shellcheck source=/dev/null
  source "${SKILL}"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/atrium-config.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-spine.sh"
  # The git-free serialize path (update_serialize_begin / update_cleanup) resolves
  # apply_lock_acquire / apply_lock_release from this lib; update_main sources it at
  # runtime, so the function-only test seam must source it here too.
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-lock.sh"
}

# resolution helpers

@test "resolution helpers anchor on GA_ROOT and the daemon reports dir" {
  run bash -c '
    source "'"${SKILL}"'"
    GA_ROOT="/x" update_ga_root
    AUTOAGENT_REPORTS_DIR="/r" update_apply_lock_dir
  '
  [ "$status" -eq 0 ]
  [[ "${lines[0]}" == "/x" ]]
  [[ "${lines[1]}" == "/r/.apply-lock" ]]
}

@test "release slug prefers ATRIUM_RELEASE_REPO over config" {
  run bash -c '
    source "'"${SKILL}"'"
    source "'"${REAL_LIB_ROOT}"'/scripts/lib/atrium-config.sh"
    ATRIUM_RELEASE_REPO="owner/repo" update_release_slug
  '
  [ "$status" -eq 0 ]
  [[ "$output" == "owner/repo" ]]
}

# changed-file set — no path-pattern refusal holds a row back

@test "a release changing every formerly-refused harness row lands all of them" {
  # The rows the changed-file partition used to hold back: a credential example, a
  # launchd plist, the charter and three rule files. Each is seeded old in the
  # install and new in the release, and each must carry the release bytes after a
  # driven run — an empty held-back set, observed through the apply rather than
  # through a predicate.
  local rel
  local -a rows=(
    "monitor/.env.example"
    "launchd/com.glass-atrium.autoagent-cycle.plist"
    "agents/GLASS_ATRIUM_GLOBAL_RULES.md"
    "scoped/scope-security.md"
    "rules/glass-atrium/core-security.md"
    "rules/glass-atrium/core-learning-log.md"
  )
  for rel in "${rows[@]}"; do
    seed_file "${INSTALL}" "${rel}" "old ${rel}"
    seed_file "${NEWSRC}" "${rel}" "new ${rel}"
  done
  write_manifest "${WORK}/manifest.json" "${rows[@]}"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"
  [ "$status" -eq 0 ]
  for rel in "${rows[@]}"; do
    [ "$(cat "${INSTALL}/${rel}")" = "new ${rel}" ] || return 1
  done
  [[ "$output" != *"REFUSED to auto-sync"* ]] || return 1
}

@test "a full run syncs the charter and leaves the link row a link (preservation, not exemption)" {
  # The charter ships as a real file plus a link row pointing at it. Both rows are
  # replaced like any other; the link survives because staging and the swap
  # reproduce a link as a link, so syncing the real file clears BOTH manifest rows.
  seed_charter_pair "${INSTALL}" "old charter"
  seed_charter_pair "${NEWSRC}" "new charter"
  write_manifest_with_modes "${WORK}/manifest.json" \
    "agents/GLASS_ATRIUM_GLOBAL_RULES.md" "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"

  [ -L "${INSTALL}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md" ]

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"
  [ "$status" -eq 0 ]

  [ "$(cat "${INSTALL}/agents/GLASS_ATRIUM_GLOBAL_RULES.md")" = "new charter" ] || return 1
  [ -L "${INSTALL}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md" ]
  [ "$(cat "${INSTALL}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md")" = "new charter" ] || return 1
  # both manifest rows reconcile: the link resolves through the real file
  [ "$(sha256_of "${INSTALL}/agents/GLASS_ATRIUM_GLOBAL_RULES.md")" \
    = "$(jq -r '.hashes["agents/GLASS_ATRIUM_GLOBAL_RULES.md"]' "${WORK}/manifest.json")" ] || return 1
  [ "$(sha256_of "${INSTALL}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md")" \
    = "$(jq -r '.hashes["rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"]' "${WORK}/manifest.json")" ] || return 1
}

# serialize begin + cleanup unwind

@test "serialize_begin acquires the apply-lock; cleanup releases it" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    update_serialize_begin
    lock="$(update_apply_lock_dir)"
    [[ -d "${lock}" ]] && echo "LOCK_HELD"
    update_cleanup
    [[ ! -d "${lock}" ]] && echo "LOCK_RELEASED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"LOCK_HELD"* ]] && [[ "$output" == *"LOCK_RELEASED"* ]]
}

@test "serialize_begin loud-fails when the .apply-lock is already held" {
  mkdir -p "${STATE}/daemon-reports/.apply-lock" # pre-existing held lock
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    update_serialize_begin
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"another apply is in progress"* ]]
}

@test "serialize_begin RECLAIMS a stale dead .apply-lock (retired [WIP-AUTO] mid-apply detector)" {
  # The OLD mid-apply-daemon signal (update_head_is_wip / a [WIP-AUTO] HEAD) is
  # DELETED; a mid-apply daemon is now signalled by .apply-lock CONTENTION. A daemon
  # that was SIGKILLed leaves a stranded lock (no EXIT trap) — the shared stale-reclaim
  # acquire must let the updater PROCEED (reclaim) rather than loud-fail forever, so
  # this is the git-free replacement for the retired WIP-HEAD detector.
  mkdir -p "${STATE}/daemon-reports/.apply-lock" # stranded lock, no pid = not-live
  # Backdate the lock dir mtime well past the (tiny) TTL so it reads as crashed
  # residue, not a fresh mid-acquire racer (mtime via python3 os.utime — the portable
  # idiom, never BSD/GNU-divergent stat -f / stat -c).
  python3 -c 'import os,sys,time; t=time.time()-3600; os.utime(sys.argv[1], (t, t))' \
    "${STATE}/daemon-reports/.apply-lock"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    export ATRIUM_APPLY_LOCK_TTL_SECS=1
    load_skill
    update_serialize_begin && echo "ACQUIRED"
    update_cleanup && echo "RELEASED"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ACQUIRED"* ]]                  # reclaimed the stale lock (no permanent wedge)
  [[ "$output" == *"RELEASED"* ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]] # cleanup released the reclaimed lock
}

# end-to-end apply via the test seam

@test "full run applies a non-agent change and captures a baseline" {
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]]
  # baseline anchor captured under the update-state dir
  [[ -f "${STATE}/update-state/baseline-manifest.json" ]]
  # lock cleaned up by the trap
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "full run is a clean no-op (rc0, trap unwound) when nothing changed" {
  # install == new release (identical content + matching manifest hashes) → the
  # spine selects zero changed files → update_run returns 0 BEFORE the apply step,
  # and the trap still releases the flag + lock. Pins the "already up to date"
  # orchestration branch (previously untested).
  seed_file "${INSTALL}" "scripts/tool.sh" "same content"
  seed_file "${NEWSRC}" "scripts/tool.sh" "same content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "same content" ]]
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "boundary: an agents/**/*.md change is EXCLUDED from the deterministic sync" {
  seed_file "${INSTALL}" "agents/foo.md" "old agent"
  seed_file "${NEWSRC}" "agents/foo.md" "new agent"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  write_manifest "${WORK}/manifest.json" "agents/foo.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]] # non-agent → deterministic sync
  # agents/*.md is EXCLUDED from the deterministic sync (spine_is_excluded_path); it
  # flows through the SEPARATE git-free E4 merge instead, which take-releases this
  # region-less vendor file. The distinct "agent merged + applied" log line proves it
  # went through the E4 path, not the tar sync (whose diff lists only scripts/tool.sh).
  [[ "$output" == *"agent merged + applied: agents/foo.md"* ]]
  [[ "$(cat "${INSTALL}/agents/foo.md")" == "new agent" ]]
}

# post-apply hook-binding reconciliation (wire-hooks)
#
# ROOT FIX: update_run applied the new FILES + refreshed the ~/.claude farm but never
# ran wire_hooks, so a release adding/changing a hook binding left settings.json on the
# OLD set (the new hook shipped DORMANT until the next full install). update_run now
# shells out to `glass-atrium wire-hooks` AFTER the verified apply + farm refresh (the
# SAME idempotent timestamped-backup MERGE install uses). Tests pin (1) post-apply
# invocation + install-parity ordering, (2) loud-fail exit 12 with NO rollback of the
# applied files, (3) end-to-end: a settings.json missing the bindings gains them.

# Install a stub glass-atrium launcher at <root> that appends each invocation's
# argv (one line per call) to <calls> and exits 0 — lets a full update_run prove
# WHICH post-apply subcommands it shelled out to (agents-only + wire-hooks)
# without the real 209KB launcher's side effects. The `wire-hooks` line is the
# one under test; `agents-only` (farm) proves the ordering.
seed_stub_launcher() {
  local root="$1" calls="$2"
  cat >"${root}/glass-atrium" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${calls}"
exit 0
STUB
  chmod +x "${root}/glass-atrium"
}

@test "post-apply: update_run invokes 'glass-atrium wire-hooks' AFTER the apply + farm refresh (install parity)" {
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"
  mkdir -p "${WORK}/facade" # a present facade home so the farm actually shells out
  seed_stub_launcher "${INSTALL}" "${WORK}/launcher-calls.log"

  run env \
    GA_ROOT="${INSTALL}" \
    GA_TARGET_HOME="${WORK}/facade" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]] # apply happened first
  [[ -f "${WORK}/launcher-calls.log" ]]
  # wire-hooks was invoked, and it ran AFTER the farm's agents-only (install
  # ordering: run_symlink_farm -> wire_hooks). The LAST recorded call is wire-hooks.
  [[ "$(grep -c '^wire-hooks$' "${WORK}/launcher-calls.log")" -ge 1 ]]
  [[ "$(grep -c '^agents-only$' "${WORK}/launcher-calls.log")" -ge 1 ]]
  [[ "$(tail -n 1 "${WORK}/launcher-calls.log")" == "wire-hooks" ]]
}

@test "post-apply: a FAILING wire-hooks loud-fails exit 12 and does NOT roll back the applied files" {
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"
  mkdir -p "${WORK}/facade"
  # stub that succeeds for the farm (agents-only / prune) but FAILS on wire-hooks
  cat >"${INSTALL}/glass-atrium" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *wire-hooks*) exit 3 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${INSTALL}/glass-atrium"

  run env \
    GA_ROOT="${INSTALL}" \
    GA_TARGET_HOME="${WORK}/facade" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 12 ]                                          # named loud-fail code
  [[ "$output" == *"hook-binding wiring failed"* ]]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]]  # files APPLIED, not rolled back
  # the trap still released the writer-serialization state on the failure path
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "post-apply: the wire step MERGES the new bindings into a settings.json that lacks them (real launcher)" {
  # Real glass-atrium launcher at the sandbox GA_ROOT; GA_TARGET_HOME points
  # SETTINGS_JSON at a throwaway target. update_wire_hooks_post_apply shells out to
  # the canonical `wire-hooks`, so a settings.json MISSING the Atrium bindings gains
  # them through the update path — the end-to-end proof of the root fix.
  [[ -f "${GA}/glass-atrium" ]] || skip "real glass-atrium launcher not found"
  cp "${GA}/glass-atrium" "${INSTALL}/glass-atrium"
  chmod +x "${INSTALL}/glass-atrium"
  # The launcher's `wire-hooks` passthrough is a fresh subprocess that self-resolves
  # its own dir (INSTALL) and sources its engine libs from beside itself + scripts/lib
  # (ga-core.sh -> the E5 libs). A real update applies that whole tree into GA_ROOT, so
  # the sandbox must mirror it or the launcher dies before ever reaching wire_hooks.
  mkdir -p "${INSTALL}/scripts"
  ln -s "${GA}/lib" "${INSTALL}/lib"
  ln -s "${GA}/scripts/lib" "${INSTALL}/scripts/lib"
  mkdir -p "${WORK}/target"
  printf '%s\n' '{ "hooks": {} }' >"${WORK}/target/settings.json"

  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    export GA_TARGET_HOME="'"${WORK}"'/target"
    load_skill
    update_wire_hooks_post_apply
  '
  [ "$status" -eq 0 ]
  # settings.json is still valid JSON and now carries a known Atrium binding it lacked
  jq -e . "${WORK}/target/settings.json" >/dev/null
  run jq '[ .hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command
           | select(endswith("/advisory-spawn-budget.sh")) ] | length' \
    "${WORK}/target/settings.json"
  [ "$status" -eq 0 ]
  [[ "$output" -ge 1 ]]
}

# roster-migration gate (T20 / gate G8)

# Seed a minimal agent-registry.json at $1 listing the agent keys $2.. so the
# roster comparison has a registry signal alongside the file-set signal.
seed_registry() {
  local root="$1"
  shift
  local k objs=""
  for k in "$@"; do
    objs="${objs}$(printf '%s' "${k}" | jq -R .):{},"
  done
  mkdir -p -- "${root}"
  printf '{"version":"1.0.0","agents":{%s}}\n' "${objs%,}" >"${root}/agent-registry.json"
}

# Seed a prior-vendor baseline manifest at <state-dir>/baseline-manifest.json
# (what spine_get_baseline reads) listing the file paths $2.. in `.files[]`. This
# is the PRIOR-VENDOR roster provenance the T20 fix scopes removals against: only
# an agent in THIS baseline that the new release drops is a vendor removal — a
# user-local agent never recorded here is not. $1 = update-state dir.
seed_baseline() {
  local statedir="$1"
  shift
  local p files=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
  done
  mkdir -p -- "${statedir}"
  printf '{"version":"1.0.0","files":[%s],"hashes":{}}\n' \
    "${files%,}" >"${statedir}/baseline-manifest.json"
}

# Seed a prior-vendor baseline manifest with REAL hashes computed from the LIVE
# install tree, so a dropped file reads as still pristine (unmodified vs the vendor
# body) to anything that hash-checks it. Unlike seed_baseline (empty hashes;
# agent-only roster tests), this is for NON-agent drops. $1 = update-state dir, $2
# = install root, $3.. = relative paths (hashed from ${install}/<path>).
seed_baseline_hashed() {
  local statedir="$1" install_root="$2"
  shift 2
  local p files="" hashes=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${p}" | jq -R .):$(sha256_of "${install_root}/${p}" | jq -R .),"
  done
  mkdir -p -- "${statedir}"
  printf '{"version":"1.0.0","files":[%s],"hashes":{%s}}\n' \
    "${files%,}" "${hashes%,}" >"${statedir}/baseline-manifest.json"
}

@test "roster gate REFUSES an update that ADDS an agent (file-set signal)" {
  # The release introduces a brand-new agent file (dev-new) absent locally — a
  # roster ADD. The gate must refuse/defer BEFORE any sync and write nothing.
  seed_file "${INSTALL}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-new.md" "new agent body"
  write_manifest "${WORK}/manifest.json" "agents/dev-existing.md" "agents/dev-new.md"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]                                # gated → non-zero
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"add dev-new"* ]]
  [[ "$output" == *"agent_lifecycle"* ]]             # directs to the ceremony
  [[ ! -f "${INSTALL}/agents/dev-new.md" ]]          # nothing written
  [[ ! -f "${STATE}/update-state/baseline-manifest.json" ]]
  # the trap still releases the lock on the refused exit
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "roster gate REFUSES an update that REMOVES a VENDOR agent (registry signal)" {
  # GENUINE vendor removal: dev-b was a PRIOR-VENDOR agent (recorded in the
  # base@install baseline) that the new release drops. Local registry carries
  # dev-a + dev-b; the release registry drops dev-b. The T20 fix scopes removals
  # against the prior-vendor baseline (not the full local set), so seeding the
  # baseline with dev-b is what makes this a vendor removal that MUST gate.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md" "agents/dev-b.md"
  seed_registry "${INSTALL}" "dev-a" "dev-b"
  seed_registry "${NEWSRC}" "dev-a"
  write_manifest "${WORK}/manifest.json" "agent-registry.json"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"remove dev-b"* ]]
  # registry NOT silently swapped — local still carries dev-b
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" == *"dev-b"* ]]
}

@test "roster gate PASSES THROUGH a content-only edit (same roster both sides)" {
  # dev-a is present on BOTH sides (a content EDIT, not a roster change) and a
  # plain non-agent file changes. The gate must NOT fire; the non-agent sync runs
  # and the agent md is merged via the SEPARATE git-free E4 path.
  seed_file "${INSTALL}" "agents/dev-a.md" "old agent body"
  seed_file "${NEWSRC}" "agents/dev-a.md" "new agent body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" != *"ROSTER CHANGE DETECTED"* ]]      # gate stayed silent
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]   # non-agent synced
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "new agent body" ]] # agent md merged via the git-free E4 path
}

@test "roster gate PASSES a content update on a CUSTOMIZED install (T20 fix: user-local agent does NOT block)" {
  # THE T20 FALSE-POSITIVE REGRESSION GUARD. The prior-vendor baseline holds only
  # dev-a. The user added dev-custom via agent_lifecycle (present locally — file +
  # registry — but in NO vendor release). The new release is a pure content change
  # (dev-a edited, a non-agent file changed) and its registry still lists only the
  # vendor roster {dev-a}. Before the fix the remove side compared release-vs-local
  # and flagged `remove dev-custom`, killing EVERY update on a customized install.
  # The provenance fix scopes removals to prior-vendor\release, so dev-custom — a
  # user-local agent never in the baseline — is NOT a vendor removal and the
  # content update flows through. agent-registry.json is absent from the manifest,
  # so the deterministic sync never clobbers the user's dev-custom registry entry.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "old agent body"
  seed_file "${INSTALL}" "agents/dev-custom.md" "user added via agent_lifecycle"
  seed_registry "${INSTALL}" "dev-a" "dev-custom"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "agents/dev-a.md" "new agent body"
  seed_registry "${NEWSRC}" "dev-a"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" != *"ROSTER CHANGE DETECTED"* ]]               # gate stayed silent
  [[ "$output" != *"remove dev-custom"* ]]                    # no false removal
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]   # content update applied
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "new agent body" ]] # agent md merged via the git-free E4 path
  # the user's local-only agent is preserved on every layer
  [[ -f "${INSTALL}/agents/dev-custom.md" ]]
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" == *"dev-custom"* ]]
}

@test "roster gate REFUSES a genuine vendor remove even on a customized install (file-set signal)" {
  # Provenance still gates a REAL vendor drop alongside a user-local agent. Baseline
  # (prior vendor) = {dev-a, dev-b}; the new release ships only dev-a (dev-b dropped
  # by the vendor). dev-custom is user-local. The gate must flag `remove dev-b`
  # (vendor drop) while NEVER flagging dev-custom.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md" "agents/dev-b.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "a"
  seed_file "${INSTALL}" "agents/dev-b.md" "b"
  seed_file "${INSTALL}" "agents/dev-custom.md" "user added"
  seed_file "${NEWSRC}" "agents/dev-a.md" "a"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -ne 0 ]                                  # genuine vendor remove gates
  [[ "$output" == *"ROSTER CHANGE DETECTED"* ]]
  [[ "$output" == *"remove dev-b"* ]]                  # vendor-dropped agent flagged
  [[ "$output" != *"remove dev-custom"* ]]             # user-local agent NOT flagged
}

@test "T24: a successful apply captures the new-release agent bodies into the base-content store" {
  # After a confirmed apply the new (= base@install) agent *.md bodies are persisted
  # BASENAME-keyed under <state>/base-agents, exactly where editable_merge.load_base_text
  # reads them, so the NEXT update can do a true 3-way merge instead of the gated
  # 2-way fallback. dev-a is present on both sides (content edit, no roster gate).
  seed_baseline "${STATE}/update-state" "agents/dev-a.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "old local body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "agents/dev-a.md" "new vendor body"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  # base-content store populated with the NEW (base@install) body, basename-keyed
  [[ -f "${STATE}/update-state/base-agents/dev-a.md" ]]
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "new vendor body" ]]

  # cross-check the store path/key the Python reader resolves matches what we wrote
  run python3 -c '
import sys
sys.path.insert(0, "'"${REAL_LIB_ROOT}"'/autoagent/lib")
import editable_merge as em
print(em.load_base_text("agents/dev-a.md", state_dir="'"${STATE}/update-state"'"))
'
  [ "$status" -eq 0 ]
  [[ "$output" == *"new vendor body"* ]]
}

@test "roster gate OVERRIDE (ATRIUM_UPDATE_ALLOW_ROSTER) proceeds past an add" {
  # The explicit, non-silent opt-in downgrades the refusal to a warning and lets
  # the update proceed (agent md still excluded from the deterministic sync).
  seed_file "${INSTALL}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-new.md" "new agent body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" \
    "agents/dev-existing.md" "agents/dev-new.md" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_ALLOW_ROSTER="1" \
    bash "${SKILL}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ATRIUM_UPDATE_ALLOW_ROSTER set"* ]]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]  # non-agent synced
  [[ ! -f "${INSTALL}/agents/dev-new.md" ]]                  # agent md still E4-excluded
}

@test "boundary: the only core.autoagent_proposals write is the sanctioned resolved-gap envelope" {
  # The boundary MOVED. It used to read "never writes that table"; the updater now
  # records one apply-INELIGIBLE accountability row per body whose conflicting
  # EDITABLE gaps took the release side, in every entry mode. What is pinned here is
  # the CHANNEL SET, not SQL syntax: the predecessor grepped for a SQL keyword next
  # to the table name and therefore could never see this write, which leaves as a
  # JSON envelope piped to _pg_dual_write_daemon.py.
  #
  # Fixtures/helpers used below (seed_base_store, run_update, write_mock_psql) are
  # defined further down the file — bats defines every top-level function before the
  # first test runs.

  # Leg 1 — no raw SQL. Anchored on the table NAME alone, so it does not depend on a
  # preceding keyword: every mention must be prose (a # comment) or a log string,
  # which a raw statement would not be.
  run grep -n 'autoagent_proposals' "${SKILL}"
  [ "$status" -eq 0 ] # the boundary note names it; zero hits means the note moved
  local line text
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    text="${line#*:}"
    if [[ ! "${text}" =~ ^[[:space:]]*# ]] && [[ "${text}" != *update_log* ]]; then
      echo "core.autoagent_proposals named outside a comment/log line: ${line}"
      return 1
    fi
  done <<<"${output}"

  # Leg 2 — one envelope op, one emitter, one helper pipe. A SECOND write site added
  # anywhere trips this while emitting no SQL at all.
  local op_line py_line emit_line
  op_line="$(grep -n 'write_autoagent_proposal' "${SKILL}" | grep -vE ':[[:space:]]*#' | cut -d: -f1)"
  py_line="$(grep -n "^_UPDATE_PROPOSAL_PY='" "${SKILL}" | cut -d: -f1)"
  emit_line="$(grep -n '^update_emit_resolved_records() {' "${SKILL}" | cut -d: -f1)"
  [ "$(printf '%s\n' "${op_line}" | grep -c .)" -eq 1 ]
  [ "${op_line}" -gt "${py_line}" ]  # the op literal sits INSIDE the envelope composer
  [ "${op_line}" -lt "${emit_line}" ]
  # Non-comment occurrences only: the header seam list names the env var in prose.
  [ "$(grep -n 'ATRIUM_UPDATE_PG_HELPER' "${SKILL}" | grep -cvE ':[[:space:]]*#')" -eq 1 ]
  [ "$(grep -cF 'python3 "${helper}"' "${SKILL}")" -eq 1 ]

  # Leg 3 — observe the write channels on a real INTERACTIVE run. All three anchors
  # of the EDITABLE region differ, so the gap is contested; the dual-write CLI is
  # replaced by a spy that records what it was piped. This is the leg a source grep
  # structurally cannot supply.
  #
  # The observation is of SILENCE. The queue that feeds the emitter is gated on the
  # verdict merge-resolved-release (grepped for below, so the gate cannot move
  # without this leg noticing), and a contested gap emits merge-pending-arbitration
  # instead, which the routing declines. So this run composes no envelope, and the
  # leg pins that neither channel carries anything a declined body did not earn.
  local gap_base gap_local gap_release
  gap_base='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
vendor rules'
  gap_local='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
local learned goal
<!-- EDITABLE:END -->
## Rules
vendor rules'
  gap_release='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
release rewritten goal
<!-- EDITABLE:END -->
## Rules
vendor rules'
  seed_file "${INSTALL}" "agents/dev-a.md" "${gap_local}"
  seed_base_store "dev-a.md" "${gap_base}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${gap_release}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"
  cat >"${WORK}/spy-helper.py" <<'PY'
import os, sys
with open(os.environ["ENVELOPE_LOG"], "a", encoding="utf-8") as fh:
    fh.write(sys.stdin.read())
PY
  write_mock_psql "${WORK}/psql"
  export ENVELOPE_LOG="${WORK}/envelopes.jsonl"
  export ATRIUM_UPDATE_PG_HELPER="${WORK}/spy-helper.py"
  export ATRIUM_UPDATE_PSQL="${WORK}/psql"
  export PSQL_LOG="${WORK}/psql.log"

  run_update
  [ "$status" -eq 0 ]
  # Explicit `return 1` rather than a bare `[[ ]]`: a mid-body `[[ ]]` does NOT fail
  # a bats test, so it would assert nothing here.
  if [[ "$output" != *"CONFLICT (merge-pending-arbitration)"* ]]; then
    echo "the contested body did not decline: ${output}"
    return 1
  fi

  # The gate this leg's silence rests on, read from the source rather than assumed:
  # the queue writes the resolved-record row only for merge-resolved-release.
  run grep -cF "== 'merge-resolved-release' ]]" "${SKILL}"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]

  # Neither channel carried anything. Absence of the FILE, not an empty one, keeps
  # "the spy was never piped" distinguishable from "the spy ran and wrote nothing".
  [ ! -e "${ENVELOPE_LOG}" ]
  [ ! -s "${PSQL_LOG}" ]

  # Leg 4 — every DML statement in the file targets core.update_job. Extended to the
  # `UPDATE <table>` form the predecessor's own comment claimed but its grep omitted;
  # line-anchored so the WARN strings that merely contain the word are not scanned.
  run grep -nE '^[[:space:]]*(INSERT[[:space:]]+INTO|DELETE[[:space:]]+FROM|UPDATE)[[:space:]]+(core\.)?[a-z_]+' "${SKILL}"
  [ "$status" -eq 0 ]
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    if [[ "${line}" != *"core.update_job"* ]]; then
      echo "unexpected DML target: ${line}"
      return 1
    fi
  done <<<"${output}"
}

# agent EDITABLE-region merge (E4 / T19)
#
# These pin the LIVE merge integration: each changed agents/<name>.md flows through
# editable_merge `plan` → git_txn_apply. The transaction is
# git-FREE (before-image copy → apply → verify → atomic restore on fail; no git repo, no
# rev-parse — proven by autoagent/test/git-txn-gitfree.bats), so these fixtures run in a
# NON-git INSTALL sandbox and the merge PROCEEDS whether or not a .git repo is present.

# Seed the base@install body for agents/<name>.md into the base-content store
# (basename-keyed at <state>/base-agents/<name>.md) — the provenance the resolver
# reads via editable_merge.load_base_text for a true 3-way merge. $1 = name, $2 = body.
seed_base_store() {
  mkdir -p -- "${STATE}/update-state/base-agents"
  printf '%s' "$2" >"${STATE}/update-state/base-agents/$1"
}

# Standard three-anchor agent fixture for dev-a: a Goal region the user learned
# locally + a Rules section the vendor owns. base region == release region (vendor
# never touched the protected region) so the resolver KEEPS the local learned
# region while TAKING the new vendor structure.
GOAL_BASE='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
GOAL_LOCAL='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
local learned goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
GOAL_RELEASE='# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
NEW vendor rules'

# U-A fixture: the same three-anchor shape PLUS frontmatter, where the LIVE body
# carries an operator `model:` pin the release does NOT ship. Everything outside the
# EDITABLE regions is rebuilt from the release skeleton, so the pin is exactly what a
# naive merge drops (orchestrator-role.md Cost-Tier Selection sanctions it as
# local-only config that is NEVER ported to git).
PIN_BASE='---
name: dev-a
tools: Read, Write
---

# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
PIN_LOCAL='---
name: dev-a
tools: Read, Write
model: claude-opus-4-8
---

# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
local learned goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
PIN_RELEASE='---
name: dev-a
tools: Read, Write
---

# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
base goal
<!-- EDITABLE:END -->
## Rules
NEW vendor rules'

run_update() {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"
}

@test "T19: keep-local region preserved + release structure applied through git_txn (agent-only change)" {
  # Pure agent change (no non-agent file) → update_run hits the early-return branch
  # but STILL runs the merge. base==release region → keep-local; vendor structure
  # changed → take-release structure. needs_llm=False → no Haiku call in verify.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  # local learned region kept, vendor Rules structure taken
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" != *"base goal"* ]]
  # git-free transaction: git_txn_apply applies via a before-image copy + verify and
  # runs NO git op, so the on-disk content above IS the applied-state proof. The merge
  # created no repo — a plain non-git INSTALL sandbox stays git-free end to end.
  [[ ! -d "${INSTALL}/.git" ]]
}

@test "T19/U-A: a live-only operator model: pin survives the merge (release ships none)" {
  # The applied INSTALL body must hold the NEW vendor rules AND still carry the
  # operator pin — the release frontmatter has no model: key, so the pin is
  # keep-local by doctrine, not vendor-owned content.
  seed_file "${INSTALL}" "agents/dev-a.md" "${PIN_LOCAL}"
  seed_base_store "dev-a.md" "${PIN_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${PIN_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"model: claude-opus-4-8"* ]] # pin kept
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]       # structure taken
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]]     # region kept
}

@test "T19/U-A: a pin-only delta is a no-op (nothing to apply, live body untouched)" {
  # Release == local except for the pin the release lacks → the candidate collapses
  # to the local body, so the merge reports no net change and writes nothing.
  local pin_only_release='---
name: dev-a
tools: Read, Write
---

# dev-a
## Goal
<!-- EDITABLE:BEGIN -->
local learned goal
<!-- EDITABLE:END -->
## Rules
old vendor rules'
  seed_file "${INSTALL}" "agents/dev-a.md" "${PIN_LOCAL}"
  seed_base_store "dev-a.md" "${PIN_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${pin_only_release}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${PIN_LOCAL}" ]] # byte-identical
}

@test "T19: STRUCTURAL region-count mismatch routes to the agent_lifecycle ceremony (not applied)" {
  # local has TWO EDITABLE regions, the release ONE → region-count mismatch. The
  # resolver returns structural-change; the skill must NOT auto-apply it.
  local two_region='# dev-a
<!-- EDITABLE:BEGIN -->
region one
<!-- EDITABLE:END -->
<!-- EDITABLE:BEGIN -->
region two
<!-- EDITABLE:END -->'
  local one_region='# dev-a
<!-- EDITABLE:BEGIN -->
region one vendor
<!-- EDITABLE:END -->'
  seed_file "${INSTALL}" "agents/dev-a.md" "${two_region}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${one_region}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"STRUCTURAL"* ]]
  [[ "$output" == *"agent_lifecycle"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${two_region}" ]] # local kept verbatim
}

@test "T19: a sensitive diff in an agent merge is REFUSED (not applied)" {
  # The release introduces an irreversible command (rm -rf) inside the region. The
  # candidate diff matches the compiled sensitive-diff source → plan rc 3 → the
  # skill refuses the file and writes nothing.
  local local_body='# dev-a
<!-- EDITABLE:BEGIN -->
safe local line
<!-- EDITABLE:END -->'
  local danger_body='# dev-a
<!-- EDITABLE:BEGIN -->
rm -rf /tmp/everything
<!-- EDITABLE:END -->'
  seed_file "${INSTALL}" "agents/dev-a.md" "${local_body}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${danger_body}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  [[ "$output" == *"REFUSED sensitive"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${local_body}" ]] # untouched
}

@test "T19: non-git install still MERGES the agent file (git-free transaction, no SKIP)" {
  # No git repo in the INSTALL sandbox. Post-P2-T2 the merge is git-FREE (git_txn_apply
  # captures a before-image copy + restores atomically — proven by git-txn-gitfree.bats),
  # so it PROCEEDS and applies the region rather than loud-skipping. Regression guard for
  # the retired update_git_root "requires git" premise (the DC-1 review finding).
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  [[ "$output" != *"not a git repo"* ]]                                 # no SKIP path
  [[ "$output" != *"SKIPPED"* ]]
  [[ ! -d "${INSTALL}/.git" ]]                                          # stayed git-free
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]] # region kept
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]   # structure taken
}

@test "T19: agent merge coexists with the non-agent sync (both apply in one run)" {
  # A non-agent file AND an agent file both change. The non-agent sync applies via
  # the spine; the agent merge applies via git_txn — both gated by the same y.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md" "scripts/tool.sh"

  run_update
  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]]            # non-agent synced
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]] # region kept
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]   # structure taken
}

@test "T19/P2-T2: the pre-merge local body lands in the PERSISTENT agents-bak (single authoritative before-image)" {
  # The transaction's before-image is the SAME per-run agents-bak copy that
  # --restore-agents reads AND that the merge verify anchors on — no ephemeral
  # merge-dir localbak duplicate exists anymore (P2-T2 AC3).
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"

  run_update
  [ "$status" -eq 0 ]
  # the merge applied — proof the verify PASSED while anchored on the agents-bak copy
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"local learned goal"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == *"NEW vendor rules"* ]]
  # the persistent per-run before-image holds the pre-merge local body byte-for-byte
  # (glob over the <cycle_date>_update-<version> dir — date computed in the child)
  local bak
  bak="$(printf '%s\n' "${INSTALL}/agents-bak/"*"_update-1.0.0/dev-a.md.bak" | head -1)"
  [[ -f "${bak}" ]]
  [[ "$(cat "${bak}")" == "${GOAL_LOCAL}" ]]
}

@test "T19: a failed per-file transaction summarizes as rolled-back/unapplied" {
  # A run whose single agent transaction fails (read-only target → the apply cp
  # cannot write → GIT_TXN_APPLY_FAIL) must reach the rolled-back summary branch
  # rather than reporting the merge as applied.
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  write_manifest "${WORK}/manifest.json" "agents/dev-a.md"
  chmod a-w "${INSTALL}/agents/dev-a.md" # plan/diff still read it; the apply cp loud-fails

  run_update
  [ "$status" -eq 0 ] # the agent merge stays best-effort / non-fatal
  [[ "$output" == *"rolled-back or unapplied file(s)"* ]]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "${GOAL_LOCAL}" ]] # untouched
}

# P3-T2: headless / web-triggered orchestration
#
# These pin the P3 headless layer added ON TOP of the E3 interactive flow:
#   * core.update_job DB status tracking (in-progress → heartbeat → completed/failed)
#     via the ATRIUM_UPDATE_PSQL seam — a mock psql that logs argv+SQL and returns a
#     RETURNING id, so NO live Postgres is touched
#   * single-active enforcement (partial unique index violation → loud-fail exit 8)
#   * the DB heartbeat on a long-stage tick
#   * the EXIT-trap in-progress→failed marking (abort/crash recovery) + WHERE-guarded
#     terminal writes (a stale-swept row is never resurrected)
#   * install-parity post-step (mock npm build + launchctl kickstart/bootstrap probe)
#   * the decoupled one-shot launchd plist render
#   * the claude -p precondition (resolve ok / unresolvable → exit 7 / plist PATH miss)
#   * agents-bak restore mode (--restore-agents) + 14-day retention prune
#
# All external effects are seamed to mocks (ATRIUM_UPDATE_PSQL / _NPM / _LAUNCHCTL /
# _CLAUDE_BIN / _MONITOR_DIR / _RENDER_*): no real build, launchctl, claude, or DB.

# A mock psql: logs "$*" + the stdin SQL to $PSQL_LOG, returns a fake RETURNING id,
# and (when $PSQL_FAIL=unique|dberr) simulates a unique-violation / connection error.
write_mock_psql() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
sql="$(cat)"
{ printf 'ARGS:%s\n' "$*"; printf 'SQL:%s\n' "${sql}"; } >>"${PSQL_LOG:-/dev/null}"
case "${PSQL_FAIL:-}" in
  unique) printf 'ERROR: duplicate key value violates unique constraint "update_job_single_active_uniq"\n' >&2; exit 1 ;;
  dberr) printf 'ERROR: could not connect to server\n' >&2; exit 2 ;;
esac
[[ "${sql}" == *"RETURNING id"* ]] && printf '42\n'
exit 0
MOCK
  chmod +x "$1"
}

# A mock npm: logs "$*" to $NPM_LOG, exits $NPM_RC (default 0).
write_mock_npm() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${NPM_LOG:-/dev/null}"
exit "${NPM_RC:-0}"
MOCK
  chmod +x "$1"
}

# A mock launchctl: logs "$*" to $LAUNCHCTL_LOG. `print` returns 0 when
# $LAUNCHCTL_LOADED=1 (loaded) else non-zero — driving the kickstart-vs-bootstrap probe.
write_mock_launchctl() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${LAUNCHCTL_LOG:-/dev/null}"
if [[ "$1" == "print" ]]; then
  [[ "${LAUNCHCTL_LOADED:-1}" == "1" ]] && exit 0 || exit 1
fi
exit 0
MOCK
  chmod +x "$1"
}

# A mock claude binary — presence + executability is all the precondition checks.
write_mock_claude() {
  cat >"$1" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  chmod +x "$1"
}

# A minimal, plutil-parseable launchd plist whose EnvironmentVariables.PATH = $2.
write_plist_path() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$2</string>
	</dict>
</dict>
</plist>
PLIST
}

@test "P3 headless: update_job transitions in-progress INSERT → heartbeat → completed (psql seam)" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    update_job_begin
    echo "ID=${_update_job_id}"
    update_job_heartbeat
    update_job_complete
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ID=42"* ]] # RETURNING id captured from the INSERT
  grep -q "INSERT INTO core.update_job" "${WORK}/psql.log"
  grep -q "status = 'completed'" "${WORK}/psql.log"
  grep -q "heartbeat_at = now()" "${WORK}/psql.log"
  # heartbeat + completion are WHERE-guarded on the in-progress row
  grep -q "status = 'in-progress'" "${WORK}/psql.log"
}

@test "P3 headless: update_job_fail records status='failed' + failure_reason (WHERE-guarded)" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    _update_job_id=42
    update_job_fail "boom reason"
  '
  [ "$status" -eq 0 ]
  grep -q "status = 'failed'" "${WORK}/psql.log"
  grep -q "failure_reason = :'fr'" "${WORK}/psql.log" # bound, not concatenated (injection-safe)
  grep -q "fr=boom reason" "${WORK}/psql.log"         # the reason rides a psql -v bind
  grep -q "status = 'in-progress'" "${WORK}/psql.log" # WHERE-guard (never clobber a swept row)
}

@test "P3 headless: a 2nd concurrent in-progress INSERT (partial unique index violation) loud-fails exit 8" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    export PSQL_FAIL=unique
    _update_headless=1
    update_job_begin
  '
  [ "$status" -eq 8 ] # single-active DB guard → named exit 8
  [[ "$output" == *"another update is already in-progress"* ]]
}

@test "P3 headless: ATRIUM_UPDATE_JOB_ID adopts the route-created row (no INSERT, heartbeat only)" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    export ATRIUM_UPDATE_JOB_ID=777
    _update_headless=1
    update_job_begin
    echo "ID=${_update_job_id}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"ID=777"* ]]                              # adopted the pre-created row id
  ! grep -q "INSERT INTO core.update_job" "${WORK}/psql.log" # adopted, never re-INSERTed
  grep -q "heartbeat_at = now()" "${WORK}/psql.log"          # heartbeated the adopted row
}

@test "P3: ATRIUM_UPDATE_DB=off (and interactive mode) performs ZERO psql calls" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    export ATRIUM_UPDATE_DB=off
    _update_headless=1
    update_job_begin; update_job_heartbeat; update_job_complete
    _update_headless=0
    update_job_begin # interactive path never touches the DB
  '
  [ "$status" -eq 0 ]
  [[ ! -s "${WORK}/psql.log" ]] # no psql process was ever invoked
}

@test "P3 headless: update_heartbeat fires the DB heartbeat at a long-stage boundary" {
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    update_serialize_begin
    _update_job_id=42
    update_heartbeat
    update_cleanup
  '
  [ "$status" -eq 0 ]
  grep -q "heartbeat_at = now()" "${WORK}/psql.log"
}

@test "P3 headless: the EXIT trap marks an unfinalized in-progress row 'failed' (abort/crash recovery)" {
  # A headless run that dies mid-flight (update_die, a declined gate, a crash caught by
  # the trap) leaves an in-progress row → update_cleanup marks it 'failed' with the exit
  # code so the P3-T3 stale sweep + the web UI never see a phantom-active job.
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    _update_job_id=42
    _update_job_final=0 # not yet completed → the trap must fail it
    update_cleanup      # simulates the EXIT trap firing on an abnormal exit
  '
  [ "$status" -eq 0 ]
  grep -q "status = 'failed'" "${WORK}/psql.log"
  grep -q "fr=aborted (exit=" "${WORK}/psql.log" # failure_reason carries the exit code
}

@test "P3 headless: terminal writes are WHERE-guarded (a stale-swept row is never resurrected)" {
  # complete + fail both carry `WHERE ... status = 'in-progress'`, so a P3-T3 stale
  # sweep that already flipped the row to 'failed' can never be clobbered back by a
  # late terminal write from the (crashed) running process.
  write_mock_psql "${WORK}/psql"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export PSQL_LOG="'"${WORK}"'/psql.log"
    export ATRIUM_UPDATE_PSQL="'"${WORK}"'/psql"
    _update_headless=1
    _update_job_id=42
    update_job_complete
    _update_job_final=0
    update_job_fail "late"
  '
  [ "$status" -eq 0 ]
  run grep -c "AND status = 'in-progress'" "${WORK}/psql.log"
  [ "$output" -ge 2 ] # both terminal writes name the in-progress guard
}

@test "P3 headless: a confirmed apply drives in-progress→completed and runs the install-parity post-step" {
  # Full headless success e2e with every external effect seamed to a mock: psql (DB
  # tracking), claude (precondition), npm (monitor rebuild), launchctl (launchd refresh).
  # No real build/restart/claude/DB is touched; the monitor stays live.
  local claude="${WORK}/claude"
  write_mock_claude "${claude}"
  write_mock_psql "${WORK}/psql"
  write_mock_npm "${WORK}/npm"
  write_mock_launchctl "${WORK}/launchctl"
  mkdir -p "${WORK}/monitor" # a monitor dir so the build step runs
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_PSQL="${WORK}/psql" \
    PSQL_LOG="${WORK}/psql.log" \
    ATRIUM_UPDATE_CLAUDE_BIN="${claude}" \
    ATRIUM_UPDATE_MONITOR_PLIST="${WORK}/nonexistent-monitor.plist" \
    ATRIUM_UPDATE_ONESHOT_PLIST="${WORK}/oneshot.plist" \
    ATRIUM_UPDATE_MONITOR_DIR="${WORK}/monitor" \
    ATRIUM_UPDATE_NPM="${WORK}/npm" \
    NPM_LOG="${WORK}/npm.log" \
    ATRIUM_UPDATE_LAUNCHCTL="${WORK}/launchctl" \
    LAUNCHCTL_LOG="${WORK}/launchctl.log" \
    LAUNCHCTL_LOADED=1 \
    ATRIUM_UPDATE_RENDER_LAUNCHD="${WORK}/nonexistent-render-launchd.sh" \
    ATRIUM_UPDATE_RENDER_MONITOR_ENV="${WORK}/nonexistent-render-env.sh" \
    bash "${SKILL}" --headless

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]]       # applied
  grep -q "INSERT INTO core.update_job" "${WORK}/psql.log"           # opened in-progress
  grep -q "status = 'completed'" "${WORK}/psql.log"                  # closed completed
  grep -q "run build" "${WORK}/npm.log"                              # monitor rebuilt (npm run build)
  grep -q "kickstart -k" "${WORK}/launchctl.log"                     # loaded → kickstart -k
  [[ -f "${WORK}/oneshot.plist" ]]                                   # one-shot plist rendered
  grep -q "com.glass-atrium.update-oneshot" "${WORK}/oneshot.plist"  # correct decoupled label
}

@test "P3: install-parity post-step is idempotent (loaded→kickstart -k, unloaded→bootstrap; mock npm/launchctl)" {
  write_mock_npm "${WORK}/npm"
  write_mock_launchctl "${WORK}/launchctl"
  mkdir -p "${WORK}/monitor"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export NPM_LOG="'"${WORK}"'/npm.log" LAUNCHCTL_LOG="'"${WORK}"'/lc.log"
    export ATRIUM_UPDATE_NPM="'"${WORK}"'/npm" ATRIUM_UPDATE_LAUNCHCTL="'"${WORK}"'/launchctl"
    export ATRIUM_UPDATE_MONITOR_DIR="'"${WORK}"'/monitor"
    export ATRIUM_UPDATE_MONITOR_PLIST="'"${WORK}"'/mon.plist"
    # loaded: the print probe returns 0 → kickstart -k, run twice (idempotent verb)
    export LAUNCHCTL_LOADED=1
    update_build_monitor && echo "BUILD_OK"
    update_refresh_monitor_launchd
    update_refresh_monitor_launchd
    # unloaded: the print probe returns non-zero → bootstrap (kickstart -k is
    # non-idempotent when unloaded, so the probe picks the correct verb)
    export LAUNCHCTL_LOADED=0
    update_refresh_monitor_launchd
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"BUILD_OK"* ]]
  grep -q "run build" "${WORK}/npm.log"                            # build ran through the npm seam
  [[ "$(grep -c 'kickstart -k' "${WORK}/lc.log")" -eq 2 ]]         # loaded → kickstart -k, both times
  grep -q "bootstrap" "${WORK}/lc.log"                            # unloaded → bootstrap
}

@test "P3: the decoupled one-shot launchd plist renders with the update-oneshot label + --headless args" {
  local claude="${WORK}/bin/claude"
  mkdir -p "${WORK}/bin"
  write_mock_claude "${claude}"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_CLAUDE_BIN="'"${claude}"'"
    export ATRIUM_UPDATE_ONESHOT_PLIST="'"${WORK}"'/oneshot.plist"
    out="$(update_render_oneshot_plist)"
    echo "OUT=${out}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"OUT=${WORK}/oneshot.plist"* ]]
  [[ -f "${WORK}/oneshot.plist" ]]
  grep -q "<string>com.glass-atrium.update-oneshot</string>" "${WORK}/oneshot.plist"
  grep -q "<string>--headless</string>" "${WORK}/oneshot.plist" # runs headless update.sh
  grep -q "<key>RunAtLoad</key>" "${WORK}/oneshot.plist"        # one-shot: runs on bootstrap
  if command -v plutil >/dev/null 2>&1; then
    run plutil -lint -s "${WORK}/oneshot.plist"
    [ "$status" -eq 0 ] # the rendered plist is valid
  fi
}

@test "P3 headless: claude precondition PASSES when the binary resolves and each plist PATH contains it" {
  local claude="${WORK}/bin/claude"
  mkdir -p "${WORK}/bin"
  write_mock_claude "${claude}"
  write_plist_path "${WORK}/ok.plist" "${WORK}/bin:/usr/bin:/bin"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_CLAUDE_BIN="'"${claude}"'"
    update_verify_claude_precondition "'"${WORK}"'/ok.plist" && echo "PRECOND_OK"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"PRECOND_OK"* ]]
  [[ "$output" == *"claude precondition ok"* ]]
}

@test "P3 headless: claude precondition LOUD-FAILS exit 7 when the binary is unresolvable" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    # a bogus BASENAME resolves nowhere (not on PATH, not in the common install dirs)
    export ATRIUM_UPDATE_CLAUDE_BIN="claude-nonexistent-xyztest"
    update_verify_claude_precondition
  '
  [ "$status" -eq 7 ] # named loud-fail exit 7 (the merge stage would fail)
  [[ "$output" == *"claude binary NOT resolvable"* ]]
}

@test "P3 headless: claude precondition LOUD-FAILS exit 7 when a plist PATH omits claude" {
  local claude="${WORK}/bin/claude"
  mkdir -p "${WORK}/bin"
  write_mock_claude "${claude}"
  write_plist_path "${WORK}/bad.plist" "/usr/bin:/bin" # PATH lacks the claude dir
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_CLAUDE_BIN="'"${claude}"'" # resolves in the process env
    update_verify_claude_precondition "'"${WORK}"'/bad.plist"
  '
  [ "$status" -eq 7 ]
  [[ "$output" == *"claude NOT resolvable on the launchd plist PATH"* ]]
}

@test "P3: --restore-agents restores agent bodies from the agents-bak before-image (git-revert replacement)" {
  local cyc="2026-07-01_update-1.0.0"
  mkdir -p "${WORK}/agents-bak/${cyc}"
  printf 'BEFORE IMAGE BODY' >"${WORK}/agents-bak/${cyc}/dev-a.md.bak"
  seed_file "${INSTALL}" "agents/dev-a.md" "corrupted-by-a-bad-update"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    AUTOAGENT_BACKUP_DIR="${WORK}/agents-bak" \
    bash "${SKILL}" --restore-agents "${cyc}"

  [ "$status" -eq 0 ]
  [[ "$(cat "${INSTALL}/agents/dev-a.md")" == "BEFORE IMAGE BODY" ]] # reverted to the before-image
  [[ "$output" == *"agents-bak restore complete"* ]]
  # the restore serializes via the same apply-lock; the trap releases it
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]]
}

@test "P3: --restore-agents rejects a cycle-id with path separators / traversal (exit 10)" {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    AUTOAGENT_BACKUP_DIR="${WORK}/agents-bak" \
    bash "${SKILL}" --restore-agents "../etc/evil"
  [ "$status" -eq 10 ] # SECURITY: request-supplied id cannot escape the base dir
  [[ "$output" == *"invalid cycle-id"* ]]
}

@test "P3: --restore-agents loud-fails (exit 10) on a missing snapshot dir" {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    AUTOAGENT_BACKUP_DIR="${WORK}/agents-bak" \
    bash "${SKILL}" --restore-agents "2099-01-01_update-9.9.9"
  [ "$status" -eq 10 ]
  [[ "$output" == *"no agents-bak snapshot"* ]]
}

@test "P3: agents-bak retention prune drops before-image dirs past the 14-day window, keeps fresh ones" {
  mkdir -p "${WORK}/agents-bak/old_cycle" "${WORK}/agents-bak/fresh_cycle"
  printf 'x' >"${WORK}/agents-bak/old_cycle/dev-a.md.bak"
  printf 'x' >"${WORK}/agents-bak/fresh_cycle/dev-a.md.bak"
  # backdate the old dir 20 days (> the 14-day retention); fresh stays at now
  python3 -c 'import os,sys,time; t=time.time()-20*86400; os.utime(sys.argv[1],(t,t))' \
    "${WORK}/agents-bak/old_cycle"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export AUTOAGENT_BACKUP_DIR="'"${WORK}"'/agents-bak"
    update_prune_agents_bak
  '
  [ "$status" -eq 0 ]
  [[ ! -d "${WORK}/agents-bak/old_cycle" ]] # pruned (aged past 14d)
  [[ -d "${WORK}/agents-bak/fresh_cycle" ]] # kept (within retention)
}

# ---------------------------------------------------------------------------
# finding #7 — the EXIT-trap workdir cleanup must NOT destroy the pre-swap
# snapshot on a failed/interrupted apply (its sole rollback source). The
# committing callback drops a `.commit-ok` FILE marker on a clean swap (a shell
# var would be lost to the pipe-RHS subshell the gate runs the callback in); its
# ABSENCE beside a non-empty snapshot means preserve, not destroy.
# ---------------------------------------------------------------------------

@test "finding#7: cleanup PRESERVES the pre-swap snapshot when the apply did NOT commit cleanly" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    # Simulate a failed/interrupted apply: a POPULATED snapshot, NO .commit-ok marker.
    work="'"${WORK}"'/wk"; mkdir -p "${work}/snapshot/scripts"
    printf "pre-swap body\n" >"${work}/snapshot/scripts/tool.sh"
    _update_workdir="${work}"; _update_snapshot="${work}/snapshot"
    update_cleanup
    [[ ! -d "${work}" ]] && echo "WORKDIR_REMOVED"
    base="$(update_agents_bak_base "'"${INSTALL}"'")"; parent="$(dirname -- "${base}")"
    found="$(find "${parent}/update-failed-snapshots" -name tool.sh -print -quit 2>/dev/null || true)"
    [[ -n "${found}" ]] && echo "PRESERVED"
    [[ -n "${found}" && "$(cat "${found}")" == "pre-swap body" ]] && echo "CONTENT_OK"
  '
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WORKDIR_REMOVED"* ]] || return 1 # workdir torn down as before
  [[ "$output" == *"PRESERVED"* ]] || return 1       # but the snapshot survived beside agents-bak
  [[ "$output" == *"CONTENT_OK"* ]] || return 1      # with its exact pre-swap content
}

@test "finding#7: cleanup DELETES the snapshot when the apply committed cleanly (.commit-ok present)" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    work="'"${WORK}"'/wk"; mkdir -p "${work}/snapshot/scripts"
    printf "pre-swap body\n" >"${work}/snapshot/scripts/tool.sh"
    : >"${work}/.commit-ok" # clean-apply marker
    _update_workdir="${work}"; _update_snapshot="${work}/snapshot"
    update_cleanup
    base="$(update_agents_bak_base "'"${INSTALL}"'")"; parent="$(dirname -- "${base}")"
    found="$(find "${parent}/update-failed-snapshots" -name tool.sh -print -quit 2>/dev/null || true)"
    [[ -z "${found}" ]] && echo "NO_PRESERVE"
    [[ ! -d "${work}" ]] && echo "WORKDIR_REMOVED"
  '
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"NO_PRESERVE"* ]] || return 1 # clean apply → no forensic snapshot left behind
  [[ "$output" == *"WORKDIR_REMOVED"* ]] || return 1
}

# ---------------------------------------------------------------------------
# finding #9 — base-content capture must key to per-file merge OUTCOMES. Only a
# merge that actually LANDED (applied GIT_TXN_OK / byte-identical / no net
# change) advances the base store; a declined/refused/rolled-back merge KEEPS its
# prior base entry, else the next 3-way merge silently swallows the un-applied
# vendor change forever. This single fixture proves BOTH sides in one run.
# ---------------------------------------------------------------------------

@test "finding#9: base-content advances ONLY the landed merge, keeps the REFUSED one at prior base" {
  local ref_local='# dev-ref
<!-- EDITABLE:BEGIN -->
safe local line
<!-- EDITABLE:END -->'
  local ref_release='# dev-ref
<!-- EDITABLE:BEGIN -->
rm -rf /tmp/everything
<!-- EDITABLE:END -->'
  # dev-a: a clean, applied merge (region kept local, vendor structure taken).
  seed_file "${INSTALL}" "agents/dev-a.md" "${GOAL_LOCAL}"
  seed_base_store "dev-a.md" "${GOAL_BASE}"
  seed_file "${NEWSRC}" "agents/dev-a.md" "${GOAL_RELEASE}"
  # dev-ref: a sensitive diff → REFUSED (never applied).
  seed_file "${INSTALL}" "agents/dev-ref.md" "${ref_local}"
  seed_base_store "dev-ref.md" "REF PRIOR BASE"
  seed_file "${NEWSRC}" "agents/dev-ref.md" "${ref_release}"
  # a non-agent change so update_run reaches the base-content capture step.
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new"
  write_manifest "${WORK}/manifest.json" \
    "agents/dev-a.md" "agents/dev-ref.md" "scripts/tool.sh"

  run_update
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"REFUSED sensitive"* ]] || return 1
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new" ]] || return 1            # non-agent applied
  [[ "$(cat "${INSTALL}/agents/dev-ref.md")" == "${ref_local}" ]] || return 1 # refused file untouched
  # the LANDED merge advanced the base to the new (= base@install) release body …
  [[ "$(cat "${STATE}/update-state/base-agents/dev-a.md")" == "${GOAL_RELEASE}" ]] || return 1
  # … while the REFUSED file kept its prior base entry (NOT the un-accepted body).
  [[ "$(cat "${STATE}/update-state/base-agents/dev-ref.md")" == "REF PRIOR BASE" ]] || return 1
}

# Same-release idempotency (second-run no-op · conflict routing) lives in
# scripts/test/glass-atrium-update-idempotency.bats —
# a separate file so it gets its own CI per-file parallel timeout slot.

# ---------------------------------------------------------------------------
# finding #8 — a rolled-back NON-agent commit must reach the caller as a failure.
# update_commit_callback returns non-zero on any spine failure, so update_run dies
# with "apply failed — rolled back" and drops no clean-apply marker.
# ---------------------------------------------------------------------------

@test "finding#8: a rolled-back non-agent commit dies 'apply failed'/rolled-back" {
  # Force spine_commit_staged to fail: the target's parent dir is read-only, so the
  # atomic-swap sibling-temp write loud-fails → rollback (spine rc 1).
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh"
  chmod a-w "${INSTALL}/scripts" # the swap's sibling-temp write into this dir loud-fails

  run_update
  chmod u+w "${INSTALL}/scripts" 2>/dev/null || true # restore BEFORE teardown rm -rf

  # NOTE: every assertion is `|| return 1` — bats-core only enforces the LAST command
  # of a test body, so a bare mid-body `[[ ]]` would be silently ignored.
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"apply failed"* ]] || return 1
  [[ "$output" == *"rolled back"* ]] || return 1
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "old" ]] || return 1 # never left half-swapped
}

@test "finding#8: update_commit_callback reports a spine rollback non-zero + no .commit-ok" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    work="'"${WORK}"'/wk"; mkdir -p "${work}/staging" "${work}/snapshot"
    _update_workdir="${work}"; _update_staging="${work}/staging"; _update_snapshot="${work}/snapshot"
    _update_apply_paths="scripts/tool.sh" # NO staged src for it → spine_commit_staged rc 1
    rc=0; update_commit_callback || rc=$?
    echo "RC=${rc}"
    [[ ! -f "${work}/.commit-ok" ]] && echo "NO_MARKER"
  '
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"RC=1"* ]] || return 1      # the spine failure reaches the caller
  [[ "$output" == *"NO_MARKER"* ]] || return 1 # a failed commit never drops the clean-apply marker
}

# ---------------------------------------------------------------------------
# finding #12 — the agents-bak retention prune must PROTECT the newest before-image
# subdir (the most-recent rollback anchor --restore-agents reads) even when an idle
# install has aged every dir past the retention window (daemon-apply.sh parity).
# ---------------------------------------------------------------------------

@test "finding#12: prune KEEPS the newest before-image anchor even when every dir is past retention" {
  mkdir -p "${WORK}/agents-bak/older_cycle" "${WORK}/agents-bak/newer_cycle"
  printf 'x' >"${WORK}/agents-bak/older_cycle/dev-a.md.bak"
  printf 'x' >"${WORK}/agents-bak/newer_cycle/dev-a.md.bak"
  # BOTH aged past the 14-day retention; newer_cycle (18d) is the newest by mtime.
  python3 -c 'import os,sys,time; t=time.time()-30*86400; os.utime(sys.argv[1],(t,t))' \
    "${WORK}/agents-bak/older_cycle"
  python3 -c 'import os,sys,time; t=time.time()-18*86400; os.utime(sys.argv[1],(t,t))' \
    "${WORK}/agents-bak/newer_cycle"
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export AUTOAGENT_BACKUP_DIR="'"${WORK}"'/agents-bak"
    update_prune_agents_bak
  '
  [ "$status" -eq 0 ] || return 1
  [[ ! -d "${WORK}/agents-bak/older_cycle" ]] || return 1 # aged AND not newest → pruned
  [[ -d "${WORK}/agents-bak/newer_cycle" ]] || return 1   # newest anchor → protected despite age
}

# ---------------------------------------------------------------------------
# finding #16 — ATRIUM_UPDATE_ALLOW_ROSTER must NOT leave a half-applied roster. The
# E4 merge SKIPS a release-only ADD's agents/<name>.md, so syncing the release
# agent-registry.json alone would register an agent whose body never landed (masked
# forever by the union-based local roster). Fail-closed: withhold the registry sync
# while its referenced .md is absent, keeping files + registry consistent.
# ---------------------------------------------------------------------------

@test "finding#16: ALLOW_ROSTER WITHHOLDS agent-registry.json when the added agent body is not installed" {
  seed_file "${INSTALL}" "agents/dev-existing.md" "x"
  seed_registry "${INSTALL}" "dev-existing"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-new.md" "new agent body"
  seed_registry "${NEWSRC}" "dev-existing" "dev-new"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" \
    "agents/dev-existing.md" "agents/dev-new.md" "agent-registry.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_ALLOW_ROSTER="1" \
    bash "${SKILL}"

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WITHHOLDING agent-registry.json"* ]] || return 1
  [[ "$output" == *"dev-new"* ]] || return 1
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new tool" ]] || return 1 # the legit non-agent file still synced
  [[ ! -f "${INSTALL}/agents/dev-new.md" ]] || return 1                 # the added body is still absent
  # the live registry did NOT gain the orphan dev-new key (files ∪ registry stays consistent)
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" == "dev-existing" ]] || return 1
}

@test "finding#16: ALLOW_ROSTER SYNCS agent-registry.json normally when the added body IS present locally" {
  # Guard against over-withholding: when every new-registry agent has a live .md
  # (dev-new was installed out-of-band), the registry sync must proceed unchanged.
  seed_file "${INSTALL}" "agents/dev-existing.md" "x"
  seed_file "${INSTALL}" "agents/dev-new.md" "already here"
  seed_registry "${INSTALL}" "dev-existing"
  seed_file "${NEWSRC}" "agents/dev-existing.md" "x"
  seed_file "${NEWSRC}" "agents/dev-new.md" "already here"
  seed_registry "${NEWSRC}" "dev-existing" "dev-new"
  write_manifest "${WORK}/manifest.json" \
    "agents/dev-existing.md" "agents/dev-new.md" "agent-registry.json"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_ALLOW_ROSTER="1" \
    bash "${SKILL}"

  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"WITHHOLDING agent-registry.json"* ]] || return 1 # no orphan → no withhold
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" == *"dev-new"* ]] || return 1 # registry synced to include dev-new (its body is present)
}

@test "finding#16: ALLOW_ROSTER WARNS about a vendor-dropped agent whose .md lingers on disk" {
  # Symmetric REMOVE-direction orphan (the ADD guard's mirror). dev-b was a
  # PRIOR-VENDOR agent (in the baseline) whose body is still on disk; the new
  # release DROPS it from the registry. agents/*.md is USER-EDITABLE and excluded
  # from the vendor sweep, so the body lingers with no registry key — a silent
  # orphan. Under the override the registry drop is CORRECT (intended) but a loud
  # WARN must surface the leftover agents/dev-b.md for manual review, and the body
  # must NOT be auto-removed.
  seed_baseline "${STATE}/update-state" "agents/dev-a.md" "agents/dev-b.md"
  seed_file "${INSTALL}" "agents/dev-a.md" "x"
  seed_file "${INSTALL}" "agents/dev-b.md" "dropped vendor body still here"
  seed_registry "${INSTALL}" "dev-a" "dev-b"
  seed_file "${INSTALL}" "scripts/tool.sh" "old tool"
  seed_file "${NEWSRC}" "agents/dev-a.md" "x"
  seed_registry "${NEWSRC}" "dev-a"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new tool"
  write_manifest "${WORK}/manifest.json" \
    "agents/dev-a.md" "agent-registry.json" "scripts/tool.sh"

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_ALLOW_ROSTER="1" \
    bash "${SKILL}"

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"WARN"* ]] || return 1               # loud WARN emitted
  [[ "$output" == *"agents/dev-b.md"* ]] || return 1    # names the lingering orphan body
  [[ -f "${INSTALL}/agents/dev-b.md" ]] || return 1     # NOT auto-removed (USER-EDITABLE)
  [[ "$(cat "${INSTALL}/agents/dev-b.md")" == "dropped vendor body still here" ]] || return 1
  # the intended registry drop still applied (dev-b key gone), files+registry aside
  run jq -r '.agents | keys[]' "${INSTALL}/agent-registry.json"
  [[ "$output" != *"dev-b"* ]] || return 1
}

# vendor drops (Rule 1: the release replaces, it never deletes)

# A file the release stops shipping is LEFT IN PLACE. The prior code selected a
# still-pristine dropped file and moved it to a Trash sink; that sweep is gone, so
# the accepted residue is pinned here rather than discovered on a live install.
@test "a vendor-dropped file is LEFT IN PLACE and no removal is reported" {
  # baseline (prior vendor) ships hooks/old.sh; the new release DROPS it while
  # changing scripts/tool.sh. hooks/old.sh live-hash == baseline-hash, which is
  # exactly the provenance-clean case the removed sweep acted on.
  seed_file "${INSTALL}" "hooks/old.sh" "vendor-body"
  seed_file "${INSTALL}" "scripts/tool.sh" "old"
  seed_baseline_hashed "${STATE}/update-state" "${INSTALL}" "hooks/old.sh" "scripts/tool.sh"
  seed_file "${NEWSRC}" "scripts/tool.sh" "new content"
  write_manifest "${WORK}/manifest.json" "scripts/tool.sh" # hooks/old.sh DROPPED

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    bash "${SKILL}"

  [ "$status" -eq 0 ] || return 1
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]] || return 1 # sync still applied
  [[ "$(cat "${INSTALL}/hooks/old.sh")" == "vendor-body" ]] || return 1    # dropped file untouched
  [[ "$output" != *"vendor-dropped file removed"* ]] || return 1           # nothing reported
}
