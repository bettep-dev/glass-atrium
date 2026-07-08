#!/usr/bin/env bash
# Build the Glass Atrium root project as a non-destructive copy of the ~/.claude
# harness (spec #6987: 8-item closed allowlist, nested .git removed by omission,
# single root git, monitor full migration).
# WHY non-destructive: only CREATES ~/.glass-atrium — real ~/.claude never
# moved/edited/deleted; user runtime paths out of the allowlist by construction.
set -Eeuo pipefail
IFS=$'\n\t'

# constants
readonly SRC_ROOT="${HOME}/.claude"
readonly DEST_ROOT="${HOME}/.glass-atrium"
# closed 8-item allowlist (7 dirs + 1 file) — spec #6987 RELOCATE allowlist
readonly -a DIRS=(agents rules hooks scripts skills autoagent monitor)
readonly EXTRA_FILE="agent-registry.json"

# error trap
trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# guards (abort if real ~/.claude is at risk)
[[ -d "${SRC_ROOT}" ]] || {
  echo "FATAL: source ${SRC_ROOT} missing" >&2
  exit 1
}
if [[ -e "${DEST_ROOT}" ]]; then
  echo "FATAL: ${DEST_ROOT} already exists — refusing to overwrite (re-run on a clean target)" >&2
  exit 1
fi
command -v rsync >/dev/null 2>&1 || {
  echo "FATAL: rsync not found" >&2
  exit 1
}
command -v git >/dev/null 2>&1 || {
  echo "FATAL: git not found" >&2
  exit 1
}

mkdir -p "${DEST_ROOT}"

# step 1: rsync copy (preserve symlinks, exclude nested .git + junk)
# -a preserves symlinks WITHOUT dereferencing (no -L). --exclude=.git/ omits the
# 6 nested repos. node_modules + monitor/data INCLUDED intentionally so the
# migrated monitor runs without npm ci.
rsync_one() {
  # $1 = relative path under SRC_ROOT (dir with trailing slash or a file)
  local rel="$1"
  rsync -a \
    --exclude='.git/' \
    --exclude='*.log' \
    --exclude='.DS_Store' \
    --exclude='.mypy_cache/' \
    --exclude='.pytest_cache/' \
    --exclude='.ruff_cache/' \
    --exclude='*.pyc' \
    --exclude='__pycache__/' \
    "${SRC_ROOT}/${rel}" "${DEST_ROOT}/"
}

echo "[1/4] rsync copy → ${DEST_ROOT}"
for d in "${DIRS[@]}"; do
  [[ -d "${SRC_ROOT}/${d}" ]] || {
    echo "FATAL: missing source dir ${d}" >&2
    exit 1
  }
  echo "  - ${d}/"
  # rsync of "src/agents" (no trailing slash) into DEST/ creates DEST/agents/
  rsync_one "${d}"
done
echo "  - ${EXTRA_FILE}"
[[ -f "${SRC_ROOT}/${EXTRA_FILE}" ]] || {
  echo "FATAL: missing ${EXTRA_FILE}" >&2
  exit 1
}
rsync_one "${EXTRA_FILE}"

# step 2: internal-symlink retarget
# Re-point every symlink whose target is an ABSOLUTE path into ${SRC_ROOT} to an
# equivalent relative path INSIDE the tree (self-contained root project).
echo "[2/4] retarget internal symlinks pointing into ${SRC_ROOT}"
RETARGETED_LIST=""
while IFS= read -r -d '' link; do
  tgt="$(readlink "${link}")"
  case "${tgt}" in
    "${SRC_ROOT}/"*)
      rel_inside="${tgt#"${SRC_ROOT}/"}" # e.g. agents/GLASS_ATRIUM_GLOBAL_RULES.md
      new_abs="${DEST_ROOT}/${rel_inside}"
      link_dir=""
      link_dir="$(cd -- "$(dirname -- "${link}")" && pwd)"
      # compute a relative link from the symlink's own dir to the new target
      rel_link=""
      rel_link="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "${new_abs}" "${link_dir}")"
      # replace: ln -sfn is fine here (target is brand-new, no live readers)
      ln -sfn "${rel_link}" "${link}"
      echo "  - ${link#"${DEST_ROOT}/"} : ${tgt} -> ${rel_link}"
      RETARGETED_LIST="${RETARGETED_LIST}${link#"${DEST_ROOT}/"}|${rel_link}"$'\n'
      ;;
    *)
      # symlink not pointing into ${SRC_ROOT} (relative intra-tree link) — leave as-is
      ;;
  esac
done < <(find "${DEST_ROOT}" -type l -print0 2>/dev/null || true)
[[ -n "${RETARGETED_LIST}" ]] || echo "  (none found)"

# step 3: git init + .gitignore + initial commit
echo "[3/4] git init + .gitignore + initial commit"
cat >"${DEST_ROOT}/.gitignore" <<'GITIGNORE'
# Glass Atrium root project — ignore runtime/regenerable artifacts
node_modules/

# monitor runtime state: keep the folder structure, ignore its contents
monitor/data/*
!monitor/data/.gitkeep

# logs, OS cruft, secrets
*.log
.DS_Store
.env

# python caches
__pycache__/
*.pyc
.mypy_cache/
.pytest_cache/
.ruff_cache/
GITIGNORE

# preserve monitor/data presence even though its contents are gitignored
mkdir -p "${DEST_ROOT}/monitor/data"
touch "${DEST_ROOT}/monitor/data/.gitkeep"

git -C "${DEST_ROOT}" init -q
# local signing config: disable gpgsign if no signing key configured (NEVER --no-verify/--no-gpg-sign)
if ! git -C "${DEST_ROOT}" config --get user.signingkey >/dev/null 2>&1; then
  git -C "${DEST_ROOT}" config commit.gpgsign false
fi
# ensure an author identity exists for the commit (local scope only)
git -C "${DEST_ROOT}" config user.name >/dev/null 2>&1 || git -C "${DEST_ROOT}" config user.name "Glass Atrium Build"
git -C "${DEST_ROOT}" config user.email >/dev/null 2>&1 || git -C "${DEST_ROOT}" config user.email "build@glass-atrium.local"

git -C "${DEST_ROOT}" add -A
git -C "${DEST_ROOT}" commit -q -m "초기 Glass Atrium 루트 프로젝트 이관

~/.claude 하니스 실파일(8-item allowlist)을 ~/.glass-atrium 단일 git 루트로
비파괴 복사 · 중첩 .git 6개 제외 · GLASS_ATRIUM_GLOBAL_RULES 심링크 트리내 상대링크 재타깃"

# step 4: verify
echo "[4/4] verify"
TOTAL_SIZE="$(du -sh "${DEST_ROOT}" 2>/dev/null | awk '{print $1}')"
echo "  size: ${TOTAL_SIZE}"

# count nested .git (must be 0; .gitignore is fine, we count directories)
nested_git=0
while IFS= read -r -d '' g; do
  # exclude the single root .git
  [[ "${g}" == "${DEST_ROOT}/.git" ]] && continue
  nested_git=$((nested_git + 1))
  echo "  NESTED-GIT: ${g}" >&2
done < <(find "${DEST_ROOT}" -name .git -print0 2>/dev/null || true)
echo "  nested .git (excluding root): ${nested_git}"

# confirm GLOBAL_RULES link resolves within the tree (link is relative now)
gr_link="${DEST_ROOT}/rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"
gr_ok="no"
if [[ -L "${gr_link}" ]]; then
  gr_tgt=""
  gr_tgt="$(readlink "${gr_link}")"
  gr_link_dir=""
  gr_link_dir="$(cd -- "$(dirname -- "${gr_link}")" && pwd)"
  # resolve the (relative) target dir relative to the link's own directory
  gr_resolved_dir=""
  if gr_resolved_dir="$(cd -- "${gr_link_dir}" && cd -- "$(dirname -- "${gr_tgt}")" && pwd)"; then
    gr_resolved="${gr_resolved_dir}/$(basename -- "${gr_tgt}")"
    # -f follows the link: true only if it points at a real file in the tree
    if [[ -f "${gr_link}" && "${gr_resolved}" == "${DEST_ROOT}/"* ]]; then
      gr_ok="yes"
    fi
  fi
fi
echo "  GLOBAL_RULES link resolves within tree: ${gr_ok}"

# emit a machine-readable summary block for the caller
echo "BUILD_RESULT_BEGIN"
printf 'size=%s\n' "${TOTAL_SIZE}"
printf 'nested_git=%s\n' "${nested_git}"
printf 'global_rules_ok=%s\n' "${gr_ok}"
commit_sha=""
commit_sha="$(git -C "${DEST_ROOT}" rev-parse --short HEAD)"
printf 'commit=%s\n' "${commit_sha}"
printf 'retargeted=%s' "${RETARGETED_LIST}"
echo "BUILD_RESULT_END"

if [[ "${nested_git}" -ne 0 || "${gr_ok}" != "yes" ]]; then
  echo "VERIFY FAILED" >&2
  exit 1
fi
echo "OK"
