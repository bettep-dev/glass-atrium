#!/usr/bin/env bats
# post-edit-format.bats — behavior suite for the PostToolUse(Edit|Write) formatter
# hook's binary-resolution change (doc#4 T5): prefer the project-local
# node_modules/.bin binary (direct exec) over `npx <pkg>` (wrapper spawn).
#
# Core proof (the fix): on the hot path (local binary present) the per-edit npx
# WRAPPER spawn count drops from 1 (old npx-always hook) to 0, while the SAME file
# is formatted with the SAME result — outcome preserved. The npx fallback (local
# binary absent) is verified to still run so nothing regresses.
#
# TDD note: the "ZERO npx wrapper spawn" assertions are RED against the pre-fix
# npx-always hook (which always spawned npx → count 1) and GREEN after. The
# fallback + outcome cases are GREEN before AND after.
#
# Hermetic: a throwaway git repo under mktemp is the PROJECT_ROOT; mock formatter
# binaries (node_modules/.bin) + a mock npx (on PATH) record every invocation to a
# calls log and perform a deterministic format, so no real Biome/Prettier/npm is
# needed. Each invocation appends its identity tag; spawn counts read the log.

HOOK_SH="${BATS_TEST_DIRNAME}/../post-edit-format.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "post-edit-format.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v git >/dev/null 2>&1 || skip "git required"
  WORK="$(mktemp -d -t post-edit-format-bats.XXXXXX)"
  # Physical path so git's realpath toplevel matches the dir we create files under.
  WORK="$(cd -- "${WORK}" && pwd -P)"
  # A throwaway repo shadows any ancestor repo → PROJECT_ROOT is deterministically WORK.
  git init -q "${WORK}"
  mkdir -p "${WORK}/mockbin" "${WORK}/node_modules/.bin" "${WORK}/src"
  : >"${WORK}/calls.log"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Create a mock binary that records one identity line per invocation and formats
# its last argument (the target file) deterministically — the SAME transform for
# both the local-binary and npx paths, so "outcome preserved" holds either way.
make_shim() {
  local dest="${1}" tag="${2}"
  cat >"${dest}" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "${tag}" >>"${WORK}/calls.log"
target=""
for a in "\$@"; do target="\$a"; done
[[ -n "\$target" && -f "\$target" ]] && printf 'const x = 1;\n' >"\$target"
exit 0
SHIM
  chmod +x "${dest}"
}

# Drive the hook: CWD=WORK (→ PROJECT_ROOT), mock npx first on PATH, JSON on stdin.
run_hook() {
  local fp="${1}" payload
  payload="$(jq -n --arg f "${fp}" '{tool_input:{file_path:$f}}')"
  run env PATH="${WORK}/mockbin:${PATH}" \
    bash -c 'cd -- "$1" && printf "%s" "$2" | bash "$3"' _ "${WORK}" "${payload}" "${HOOK_SH}"
}

# Exact-line count of an identity tag in the calls log (grep -c zero-match safe form).
count_tag() {
  local n
  n="$(grep -cx "${1}" "${WORK}/calls.log" || true)"
  [[ -z "${n}" ]] && n=0
  printf '%s\n' "${n}"
}

# --- Core proof: hot path eliminates the per-edit npx wrapper spawn -----------

@test "biome local binary present → direct exec, ZERO npx wrapper spawns" {
  printf '{}\n' >"${WORK}/biome.json"
  make_shim "${WORK}/node_modules/.bin/biome" "LOCAL_BIOME"
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'const x=1;\n' >"${WORK}/src/app.ts"

  run_hook "${WORK}/src/app.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_tag LOCAL_BIOME)" == "1" ]] || return 1
  [[ "$(count_tag NPX)" == "0" ]] || return 1
}

@test "biome local binary present → formatting outcome unchanged (same result)" {
  printf '{}\n' >"${WORK}/biome.json"
  make_shim "${WORK}/node_modules/.bin/biome" "LOCAL_BIOME"
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'const x=1;\n' >"${WORK}/src/app.ts"

  run_hook "${WORK}/src/app.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${WORK}/src/app.ts")" == "const x = 1;" ]] || return 1
}

@test "prettier local binary present → direct exec, ZERO npx wrapper spawns, outcome kept" {
  printf '{}\n' >"${WORK}/.prettierrc"
  make_shim "${WORK}/node_modules/.bin/prettier" "LOCAL_PRETTIER"
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'const x=1;\n' >"${WORK}/src/app.tsx"

  run_hook "${WORK}/src/app.tsx"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_tag LOCAL_PRETTIER)" == "1" ]] || return 1
  [[ "$(count_tag NPX)" == "0" ]] || return 1
  [[ "$(cat "${WORK}/src/app.tsx")" == "const x = 1;" ]] || return 1
}

# --- Fallback preserved: local binary absent → npx still runs -----------------

@test "biome config but local binary absent → npx fallback runs (outcome kept)" {
  printf '{}\n' >"${WORK}/biome.json"
  # No node_modules/.bin/biome → must fall back to npx.
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'const x=1;\n' >"${WORK}/src/app.ts"

  run_hook "${WORK}/src/app.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_tag NPX)" == "1" ]] || return 1
  [[ "$(cat "${WORK}/src/app.ts")" == "const x = 1;" ]] || return 1
}

@test "prettier config but local binary absent → npx fallback runs" {
  printf '{}\n' >"${WORK}/.prettierrc"
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'const x=1;\n' >"${WORK}/src/app.ts"

  run_hook "${WORK}/src/app.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_tag NPX)" == "1" ]] || return 1
}

# --- Guards: no spurious spawn -------------------------------------------------

@test "non-JS/TS file (.py) → neither local binary nor npx runs" {
  printf '{}\n' >"${WORK}/biome.json"
  make_shim "${WORK}/node_modules/.bin/biome" "LOCAL_BIOME"
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'x=1\n' >"${WORK}/src/app.py"

  run_hook "${WORK}/src/app.py"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_tag LOCAL_BIOME)" == "0" ]] || return 1
  [[ "$(count_tag NPX)" == "0" ]] || return 1
}

@test "no formatter config → neither local binary nor npx runs" {
  # No biome.json / .prettierrc present.
  make_shim "${WORK}/node_modules/.bin/biome" "LOCAL_BIOME"
  make_shim "${WORK}/mockbin/npx" "NPX"
  printf 'const x=1;\n' >"${WORK}/src/app.ts"

  run_hook "${WORK}/src/app.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(count_tag LOCAL_BIOME)" == "0" ]] || return 1
  [[ "$(count_tag NPX)" == "0" ]] || return 1
  [[ "$(cat "${WORK}/src/app.ts")" == "const x=1;" ]] || return 1
}
