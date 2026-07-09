#!/usr/bin/env bash
# pii-scan.sh — PII 릴리스 게이트 스캐너 (개인 경로·이메일·호스트네임).
#
# 배포 산출물에 발행자 개인 식별 문자열이 섞이는 것을 차단한다.
#   release-gate(T62) PII 단계가 호출하고, artifact 트리 검사(T01)는 디렉터리 모드를 재사용.
# 패턴은 실행 시점에 머신 식별 정보($HOME·$USER·git user.email·hostname)에서 유도 —
#   하드코딩하면 그 자체가 추적 대상 PII 가 되므로 금지.
# tracked 모드는 두 검사를 별개로 보고: worktree-clean(git grep)·history-clean(git log -S 픽액스).
#   워크트리가 깨끗해도 히스토리에는 남을 수 있어 fresh-history 컷오버 전까지 history-clean 은 의도적 FAIL.
#
# Usage:
#   pii-scan.sh                  git TRACKED set 검사 (worktree + history, release-gate)
#   pii-scan.sh --worktree-only  history 검사 생략 (워크트리만)
#   pii-scan.sh <dir>...         임의 트리 재귀 검사 (artifact 모드, .git/node_modules 제외)
#
# Exit (비트 OR 합성 — tracked 모드에서 두 검사를 구분):
#   0 = 전부 clean
#   1 = worktree hit (워크트리 PII — 게이트 FAIL, 즉시 수정 대상)
#   2 = precondition 불충족 (git 없음 / 비 git 저장소 / 잘못된 인자)
#   4 = history hit (히스토리 PII — fresh-history 컷오버로만 해소, 별도 표시)
#   5 = worktree(1) + history(4) 동시 hit · dir 모드는 0/1/2 만.
set -Eeuo pipefail
IFS=$'\n\t'

GA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly GA_ROOT

trap 'echo "[pii-scan] ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

log() { printf '[pii-scan] %s\n' "$*"; }
fail() {
  printf '[pii-scan] ERROR: %s\n' "$*" >&2
  exit 2
}

# 패턴 유도
# 두 배열 병행 (bash 3.2 — 연관배열 불가): PATTERNS[i] = 고정 문자열,
# WORD_FLAGS[i] = "w"(단어 경계 매치 — 짧은 토큰의 부분 일치 오탐 억제) 또는 "".
PATTERNS=()
WORD_FLAGS=()

add_pattern() {
  # $1 = 고정 문자열 · $2 = "w" | "" — 공백/중복 패턴은 무시 (스캔 1회 보장)
  local pat="$1" flag="${2:-}" existing
  [[ -n "${pat}" ]] || return 0
  for existing in "${PATTERNS[@]+"${PATTERNS[@]}"}"; do
    [[ "${existing}" == "${pat}" ]] && return 0
  done
  PATTERNS+=("${pat}")
  WORD_FLAGS+=("${flag}")
}

collect_patterns() {
  local email host local_host user
  # USER 미설정 환경(루트 컨테이너/cron/launchd/bash -lc)에서 set -u 중단 방지 —
  #   USER 우선, 없으면 id -un 으로 1회 유도해 두 패턴에 동일 적용.
  user="${USER:-$(id -un)}"
  add_pattern "${HOME}" ""
  add_pattern "/Users/${user}" ""
  add_pattern "${user}" "w"
  email="$(git -C "${GA_ROOT}" config user.email 2>/dev/null || true)"
  if [[ -n "${email}" ]]; then
    add_pattern "${email}" ""
  else
    log "note: git user.email unset — email pattern skipped"
  fi
  host="$(hostname -s 2>/dev/null || true)"
  add_pattern "${host}" "w"
  if command -v scutil >/dev/null 2>&1; then
    local_host="$(scutil --get LocalHostName 2>/dev/null || true)"
    add_pattern "${local_host}" "w"
  fi
}

# 공개 식별자 정밀도 필터
# "<user>-dev" = 프로젝트의 공개 GitHub org 토큰 — 배포 URL(README · install.sh ·
#   pricing.json 갱신 endpoint)에 의도적으로 공개된 식별자. grep -w 는 하이픈을
#   단어 경계로 취급해 org 토큰 내부의 username 부분 문자열을 오탐한다.
# 범위 한정 (게이트 전역 완화 아님): 단어 경계(w) 패턴에만 적용 + 라인 통째
#   허용이 아니라 org 토큰만 제거 후 재검사 — 같은 라인에 org 토큰 밖의 실제
#   username 이 남아 있으면 계속 FAIL. 토큰은 런타임 $USER 에서 유도한다
#   (여기 하드코딩하면 그 자체가 추적 대상 PII).
filter_public_org() {
  # $1 = 패턴 · stdin = hit 라인 → 허용 토큰 제거 후에도 매치가 남는 라인만 통과
  local pat="$1" line stripped
  while IFS= read -r line; do
    stripped="${line//"${pat}-dev"/}"
    if printf '%s\n' "${stripped}" | grep -q -w -F -e "${pat}"; then
      printf '%s\n' "${line}"
    fi
  done
}

# 스캔 (모드별)
# 출력 = 매치 라인 (file:line:content) → 호출부가 hit 존재 여부로 게이트 판정.
# grep exit 1(무매치)은 정상 → || true. 패턴 매치는 전부 -F 고정 문자열.
scan_tracked() {
  local pat="$1" flag="$2"
  if [[ "${flag}" == "w" ]]; then
    git -C "${GA_ROOT}" grep -I -n -w -F -e "${pat}" -- ':!node_modules' || true
  else
    git -C "${GA_ROOT}" grep -I -n -F -e "${pat}" -- ':!node_modules' || true
  fi
}

scan_tree() {
  local pat="$1" flag="$2" dir="$3"
  if [[ "${flag}" == "w" ]]; then
    grep -R -I -n -w -F -e "${pat}" \
      --exclude-dir=.git --exclude-dir=node_modules -- "${dir}" || true
  else
    grep -R -I -n -F -e "${pat}" \
      --exclude-dir=.git --exclude-dir=node_modules -- "${dir}" || true
  fi
}

# 추적 HISTORY 픽액스 — 패턴이 HEAD 도달 가능 커밋에 한 번이라도 등장했는지.
# -S(substring) 사용: 단어 경계 플래그는 워크트리 오탐 억제용이며, 히스토리에서는
#   부분 일치라도 실제 유출이므로 substring 이 올바른 신호. --all 제외 — git grep
#   워크트리 모드와 동일한 HEAD 히스토리 범위로 한정. 출력 = 해당 커밋 oneline.
scan_history() {
  local pat="$1"
  git -C "${GA_ROOT}" log -S "${pat}" --oneline -- ':!node_modules' || true
}

# 검사 함수는 hit 패턴 수를 전역 CHECK_HITS 로 반환한다 — 사람용 hit 라인은
#   stdout 으로 출력하므로 명령 치환으로 카운트만 캡처하면 출력이 섞인다.
#   bash 3.2 호환(name-ref 불가) + 직렬 daemon 가정으로 전역 1슬롯이 안전.
CHECK_HITS=0

# worktree 검사 — git grep(tracked 모드) 또는 grep -R(dir 모드).
# CHECK_HITS = hit 한 패턴 수 (>0 이면 worktree FAIL). dir 인자는 위치 인자로 전달.
scan_worktree_check() {
  local mode="$1"
  shift
  local i pat flag hits dir
  CHECK_HITS=0
  for i in "${!PATTERNS[@]}"; do
    pat="${PATTERNS[${i}]}"
    flag="${WORD_FLAGS[${i}]}"
    if [[ "${mode}" == "tracked" ]]; then
      hits="$(scan_tracked "${pat}" "${flag}")"
    else
      hits=""
      for dir in "$@"; do
        hits+="$(scan_tree "${pat}" "${flag}" "${dir}")"
      done
    fi
    if [[ -n "${hits}" && "${flag}" == "w" ]]; then
      hits="$(printf '%s\n' "${hits}" | filter_public_org "${pat}")"
    fi
    if [[ -n "${hits}" ]]; then
      # 패턴 자체(개인 정보)는 로그에 마스킹 — hit 라인만으로 위치 특정 가능
      log "WORKTREE HIT pattern #$((i + 1)) (${#pat} chars):"
      printf '%s\n' "${hits}"
      CHECK_HITS=$((CHECK_HITS + 1))
    fi
  done
}

# history 검사 (tracked 모드 전용) — 패턴별 픽액스 커밋 수 합산.
# CHECK_HITS = hit 한 패턴 수 (>0 이면 history FAIL — fresh-history 컷오버로만 해소).
scan_history_check() {
  local i pat hits commit_count
  CHECK_HITS=0
  for i in "${!PATTERNS[@]}"; do
    pat="${PATTERNS[${i}]}"
    hits="$(scan_history "${pat}")"
    if [[ -n "${hits}" ]]; then
      commit_count="$(printf '%s\n' "${hits}" | grep -c '' || true)"
      [[ -z "${commit_count}" ]] && commit_count=0
      log "HISTORY HIT pattern #$((i + 1)) (${#pat} chars) — ${commit_count} commit(s):"
      printf '%s\n' "${hits}"
      CHECK_HITS=$((CHECK_HITS + 1))
    fi
  done
}

main() {
  command -v git >/dev/null 2>&1 || fail "git not found"

  local worktree_only=""
  if [[ "${1:-}" == "--worktree-only" ]]; then
    worktree_only="1"
    shift
  fi

  local mode
  if [[ $# -eq 0 ]]; then
    mode="tracked"
    git -C "${GA_ROOT}" rev-parse --git-dir >/dev/null 2>&1 \
      || fail "not a git repo: ${GA_ROOT} (tracked-set mode needs the GA repo)"
  else
    mode="dir"
    [[ -z "${worktree_only}" ]] || fail "--worktree-only is tracked-mode only (no dir args allowed)"
    local dir
    for dir in "$@"; do
      [[ -d "${dir}" ]] || fail "not a directory: ${dir}"
    done
  fi

  collect_patterns
  log "patterns: ${#PATTERNS[@]} (derived from HOME/USER/email/hostname)"

  # 검사 1: worktree-clean
  local exit_code=0
  log "check 1/2: worktree-clean (${mode} mode)"
  scan_worktree_check "${mode}" "$@"
  if [[ "${CHECK_HITS}" -gt 0 ]]; then
    log "worktree-clean: FAIL — ${CHECK_HITS}/${#PATTERNS[@]} pattern(s) hit (publication halt — fix the worktree)"
    exit_code=$((exit_code | 1))
  else
    log "worktree-clean: PASS — 0 hits across ${#PATTERNS[@]} patterns"
  fi

  # 검사 2: history-clean (tracked 모드 + non --worktree-only)
  if [[ "${mode}" == "tracked" && -z "${worktree_only}" ]]; then
    log "check 2/2: history-clean (tracked HISTORY via git log -S)"
    scan_history_check
    if [[ "${CHECK_HITS}" -gt 0 ]]; then
      log "history-clean: FAIL — ${CHECK_HITS}/${#PATTERNS[@]} pattern(s) present in history"
      log "  → worktree is independent of this; clearing it needs a fresh-history cutover (user-only)"
      exit_code=$((exit_code | 4))
    else
      log "history-clean: PASS — 0 patterns present in tracked history"
    fi
  else
    log "check 2/2: history-clean SKIPPED (${mode} mode or --worktree-only)"
  fi

  if [[ "${exit_code}" -eq 0 ]]; then
    log "ALL CLEAN — worktree + history (or scoped to worktree)"
  else
    log "GATE RESULT exit=${exit_code} (1=worktree, 4=history, 5=both)"
  fi
  exit "${exit_code}"
}

main "$@"
