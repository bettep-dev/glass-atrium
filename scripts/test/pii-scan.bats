#!/usr/bin/env bats
# pii-scan.sh 릴리스 게이트 스캐너 테스트 (T10 AC).
#
# AC 고정: 의도적 위반 fixture 는 잡히고(exit 1) clean 트리는 0 hit(exit 0),
#   전제조건 불충족은 exit 2. 패턴은 실행 머신에서 유도되므로 ($HOME · $USER ...)
#   fixture 내용도 전부 런타임에 합성한다 — 테스트 파일에 개인 문자열을
#   하드코딩하면 그 자체가 추적 대상 PII 가 되므로 금지.
#
# Run via: bats scripts/test/pii-scan.bats
# Requires: bats (brew install bats-core), bash 3.2+

SCANNER="${BATS_TEST_DIRNAME}/../pii-scan.sh"

setup() {
  [[ -f "${SCANNER}" ]] || skip "pii-scan.sh not found: ${SCANNER}"
  # 호스트 독립 합성 USER (P0 Wave 3): 스캐너는 PII 패턴 #3 을 $USER(단어 경계)에서
  #   유도한다. CI 호스트의 사용자명이 추적 소스(ci.yml/문서)에 등장하는 토큰이면
  #   worktree-clean 오탐 FAIL 을 유발한다. 고정 합성 토큰을 주입해 유도 패턴을
  #   결정적으로 만들고 어떤 호스트(CI/개발기)에서도 실제 저장소 내용과 매치되지
  #   않게 한다. 아래 fixture 도 동일한 $USER 로 dirty 내용을 합성하므로 dir 모드
  #   단어 경계 테스트가 정렬된다. 확장값이 이 추적 파일에 연속 리터럴로 등장하지
  #   않도록 조각으로 조립한다 — 그렇지 않으면 tracked 모드 스캔이 fixture 이름을
  #   자기 매치해 제거하려던 FAIL 을 다시 유발한다.
  local u_head="ga-fixture" u_tail="user"
  export USER="${u_head}-${u_tail}"
  WORK="$(mktemp -d -t pii-scan-bats.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
}

# ---------------------------------------------------------------------------
# dir mode (artifact-tree scan)
# ---------------------------------------------------------------------------

@test "dir mode: clean tree -> exit 0" {
  printf 'port = 16145\npath = "/usr/local/share"\n' >"${WORK}/clean.toml"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"worktree-clean: PASS"* ]]
}

@test "dir mode: HOME path literal in a file -> exit 1 + hit line names the file" {
  printf 'log_root = "%s/logs"\n' "${HOME}" >"${WORK}/pii-fixture.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"pii-fixture.txt"* ]]
  [[ "${output}" == *"FAIL"* ]]
}

@test "dir mode: bare USER token -> exit 1 (word-boundary match)" {
  printf 'owner: %s\n' "${USER}" >"${WORK}/owner.md"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"owner.md"* ]]
}

@test "dir mode: USER embedded inside a longer token -> no false positive" {
  # 단어 경계 플래그 검증 — 짧은 토큰의 부분 일치는 hit 가 아니어야 한다.
  printf 'token: x%sx\n' "${USER}" >"${WORK}/embedded.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 0 ]]
}

@test "dir mode: PII under node_modules/ is excluded -> exit 0" {
  mkdir -p "${WORK}/node_modules/pkg"
  printf 'home = "%s"\n' "${HOME}" >"${WORK}/node_modules/pkg/cfg.txt"
  run bash "${SCANNER}" "${WORK}"
  [[ "${status}" -eq 0 ]]
}

@test "dir mode: missing directory argument -> exit 2 (precondition loud-fail)" {
  run bash "${SCANNER}" "${WORK}/does-not-exist"
  [[ "${status}" -eq 2 ]]
}

# ---------------------------------------------------------------------------
# tracked mode (release gate — two independent checks)
# ---------------------------------------------------------------------------

@test "tracked mode: worktree is clean (release-gate invariant — no PII in HEAD tree)" {
  # 두 검사를 분리해 worktree 단독 깨끗함을 단언 — history 는 컷오버 전까지 dirty.
  run bash "${SCANNER}" --worktree-only
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"worktree-clean: PASS"* ]]
}

@test "tracked mode: --worktree-only skips history and exits 0" {
  run bash "${SCANNER}" --worktree-only
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"history-clean SKIPPED"* ]]
}

@test "tracked mode: full scan reports worktree + history as two distinct labeled checks" {
  run bash "${SCANNER}"
  [[ "${output}" == *"check 1/2: worktree-clean"* ]]
  [[ "${output}" == *"check 2/2: history-clean"* ]]
}

@test "tracked mode: history-FAIL sets exit bit 4 independently of worktree bit 1" {
  # 컷오버 전 본 GA 저장소는 식별 문자열을 히스토리에 보유 → history-clean FAIL.
  #   exit-bit 결합을 단언 (환경 결합 최소화): history FAIL 이면 비트4 ON, worktree
  #   PASS 이면 비트1 OFF → 두 검사의 독립 보고를 검증. 컷오버 후 history clean
  #   상태에서도 결합 단언은 유지된다 (FAIL 분기일 때만 비트 확인).
  run bash "${SCANNER}"
  if [[ "${output}" == *"history-clean: FAIL"* ]]; then
    # bit 4 set
    [[ $((status & 4)) -eq 4 ]]
  else
    [[ "${output}" == *"history-clean: PASS"* ]]
  fi
  # worktree is clean either way → bit 1 must be clear
  [[ $((status & 1)) -eq 0 ]]
}

@test "tracked mode: --worktree-only rejects directory arguments (exit 2 loud-fail)" {
  run bash "${SCANNER}" --worktree-only "${WORK}"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"--worktree-only is tracked-mode only"* ]]
}

# ---------------------------------------------------------------------------
# history-scan mechanism (isolated repo — GA-state-independent contract)
# ---------------------------------------------------------------------------

@test "history scan: PII removed from worktree but present in history -> worktree PASS + history FAIL (exit 4)" {
  # 격리 저장소에서 history-only 유출을 합성 — 워크트리는 깨끗하나 히스토리에는
  #   $HOME 가 남아 worktree(bit1) clear + history(bit4) set 을 단언. 패턴은 실행
  #   머신에서 유도되므로 fixture 도 런타임 $HOME 로 합성 (하드코딩 금지).
  command -v git >/dev/null 2>&1 || skip "git not found"
  local repo="${WORK}/hist-repo"
  mkdir -p "${repo}"
  git -C "${repo}" init -q
  git -C "${repo}" config user.email "test@example.invalid"
  git -C "${repo}" config user.name "Test"
  # commit 1: introduce the PII into a tracked file
  printf 'log_root = "%s/logs"\n' "${HOME}" >"${repo}/cfg.txt"
  git -C "${repo}" add cfg.txt
  git -C "${repo}" commit -qm "add cfg with home path"
  # commit 2: scrub the PII from the worktree (history still retains it)
  printf 'log_root = "/var/log/app"\n' >"${repo}/cfg.txt"
  git -C "${repo}" add cfg.txt
  git -C "${repo}" commit -qm "scrub home path"

  # GA_ROOT 는 스크립트 위치(dirname/..) 기준이라 cwd 와 무관 — 격리 저장소를
  #   GA_ROOT 로 주입하려면 스크립트를 ${repo}/scripts/ 에 복사해 실행한다.
  mkdir -p "${repo}/scripts"
  cp "${SCANNER}" "${repo}/scripts/pii-scan.sh"
  run bash "${repo}/scripts/pii-scan.sh"
  [[ "${output}" == *"worktree-clean: PASS"* ]]
  [[ "${output}" == *"history-clean: FAIL"* ]]
  [[ $((status & 4)) -eq 4 ]]
  [[ $((status & 1)) -eq 0 ]]
}
