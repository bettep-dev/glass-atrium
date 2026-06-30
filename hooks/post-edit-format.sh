#!/usr/bin/env bash
# PostToolUse(Edit/Write) — auto-formatting
# Run after detecting Biome or Prettier
#
# emit_error EXEMPT: this hook is a pure side-effect (formatter) and absorbs all
# tool stderr to /dev/null by design so it never blocks the workflow (non-blocking policy).
# No error signal exists, so emit_error adoption does not apply.
set -Eeuo pipefail
IFS=$'\n\t'

INPUT=$(cat 2>/dev/null) || exit 0
FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null \
  || echo "${INPUT}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[ -z "${FILE_PATH}" ] && exit 0

# Target JS/TS files only
case "${FILE_PATH}" in
  *.js | *.jsx | *.ts | *.tsx | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ -f "${PROJECT_ROOT}/biome.json" ] || [ -f "${PROJECT_ROOT}/biome.jsonc" ]; then
  npx @biomejs/biome format --write "${FILE_PATH}" 2>/dev/null
elif [ -f "${PROJECT_ROOT}/.prettierrc" ] || [ -f "${PROJECT_ROOT}/.prettierrc.json" ] || [ -f "${PROJECT_ROOT}/prettier.config.js" ]; then
  npx prettier --write "${FILE_PATH}" 2>/dev/null
fi
exit 0
