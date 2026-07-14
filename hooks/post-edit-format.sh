#!/usr/bin/env bash
# PostToolUse(Edit/Write) — auto-formatting
# Runs Biome or Prettier on the edited JS/TS file when the project configures one.
#
# Binary resolution: prefer the project-local node_modules/.bin binary (a direct
# exec) over `npx <pkg>`, which re-resolves the package and spawns an extra wrapper
# process (~0.3-1s) on EVERY edit — the local binary skips that per-edit wrapper
# cost while formatting the same file with the same result. npx stays as the
# fallback only when the local binary is absent (mirrors post-edit-typecheck.sh's
# tsc resolution).
#
# emit_error EXEMPT: this hook is a pure side-effect (formatter) and absorbs all
# tool stderr to /dev/null by design so it never blocks the workflow (non-blocking policy).
# No error signal exists, so emit_error adoption does not apply.
set -Eeuo pipefail
IFS=$'\n\t'

INPUT=$(cat 2>/dev/null) || exit 0
FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null \
  || echo "${INPUT}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[[ -z "${FILE_PATH}" ]] && exit 0

# Target JS/TS files only
case "${FILE_PATH}" in
  *.js | *.jsx | *.ts | *.tsx | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Run the project-local formatter binary directly when present, else npx.
# $1 = node_modules/.bin path · $2 = npx package spec · rest = formatter args.
# stderr → /dev/null preserves the non-blocking policy (same as the prior npx run).
run_formatter() {
  local local_bin="${1}" npx_pkg="${2}"
  shift 2
  if [[ -x "${local_bin}" ]]; then
    "${local_bin}" "$@" 2>/dev/null
  else
    npx "${npx_pkg}" "$@" 2>/dev/null
  fi
}

if [[ -f "${PROJECT_ROOT}/biome.json" ]] || [[ -f "${PROJECT_ROOT}/biome.jsonc" ]]; then
  run_formatter "${PROJECT_ROOT}/node_modules/.bin/biome" "@biomejs/biome" format --write "${FILE_PATH}"
elif [[ -f "${PROJECT_ROOT}/.prettierrc" ]] || [[ -f "${PROJECT_ROOT}/.prettierrc.json" ]] || [[ -f "${PROJECT_ROOT}/prettier.config.js" ]]; then
  run_formatter "${PROJECT_ROOT}/node_modules/.bin/prettier" "prettier" --write "${FILE_PATH}"
fi
exit 0
