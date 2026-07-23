#!/usr/bin/env bats
# daemon-apply-preservation-verify.bats — T1c fail-at-HEAD coverage for T20
# (Post-apply verification by preservation semantics). This suite is the
# ACCEPTANCE SPEC the T20 DEV implements against, driving the verify_patched
# predicate in isolation.
#
# THE DEFECT (HEAD a627de7): verify_patched is two checks — non-empty AND
# contains one line starting with a hash (daemon-apply.sh:1321-1327). A
# semantically wrong patch (frontmatter stripped, anchor removed, body gutted)
# passes, the transaction reports success, and the atomic restore never fires.
#
# CONTRACT DEFINED HERE (the T20 DEV conforms to this name):
#   VERIFY_BEFORE_IMAGE   GLOBAL path to the captured before-image the predicate
#                         compares the post-apply target against. Set by the
#                         caller BEFORE the transaction (the pattern the update
#                         script already uses). The callback stays ONE-argument
#                         (target) and reads this global — the signature is NOT
#                         widened (a second caller injects its own 1-arg callback).
#   GIT_TXN_BEFORE_IMAGE  PREFERRED anchor — the exact captured path git_txn_apply
#                         (lib/git-txn.sh) publishes the moment capture succeeds;
#                         VERIFY_BEFORE_IMAGE stays as the caller-set fallback.
#                         A missing/unreadable anchor fails CLOSED (loud stderr +
#                         non-0 → the atomic restore fires) — the preservation
#                         layer is never silently skipped (Precondition Loud-Fail).
#
# PRESERVATION SEMANTICS (present-before ⇒ present-after — NOT unconditional
# presence, which would self-reject the rules files that never had frontmatter):
#   * frontmatter present in the before-image but absent after → FAIL (restore).
#   * a `> Rules:` anchor present before but absent after → FAIL.
#   * the target shrinks past a proportional floor relative to the before-image → FAIL.
#   * a target that NEVER had frontmatter is not penalized for its continued absence.
#
# FAIL-AT-HEAD (RED against a627de7, GREEN after T20):
#   * removed-frontmatter after-image → predicate FAILS (HEAD passes: has a heading).
#   * removed-`> Rules:`-anchor after-image → predicate FAILS (HEAD passes).
#   * gutted (shrunk-past-floor) after-image → predicate FAILS (HEAD passes).
#   * the predicate reads the VERIFY_BEFORE_IMAGE global (HEAD ignores it entirely).
#   * the doc header names a defect class it cannot detect (HEAD says only "basic").
# REGRESSION GUARDS (GREEN at HEAD and after):
#   * a never-had-frontmatter target is not penalized (rules-file / global-rules shape).
#   * a semantically valid patch still succeeds.
#   * an empty target still fails (the retained non-empty base check).
# STRUCTURAL GUARDS (GREEN at HEAD and after):
#   * the callback signature stays one-argument (no `$2`).
#   * the predicate makes no network / LLM call.
#
# EXTRACTION NOTE: daemon-apply.sh runs top-level code and is NOT sourceable, so
# verify_patched is extracted (header → column-0 close brace) into a snippet and
# sourced in isolation — the standard technique for a function in a non-sourceable
# script. This assumes the predicate stays self-contained (no external helper),
# consistent with T20's "cheap, no external deps, no LLM/network" constraint; if
# the DEV factors a helper out, widen the extraction accordingly.
#
# Run via: bats autoagent/test/daemon-apply-preservation-verify.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
DAEMON_APPLY="${GA}/autoagent/daemon-apply.sh"

setup() {
  [[ -f "${DAEMON_APPLY}" ]] || skip "daemon-apply.sh not found: ${DAEMON_APPLY}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-preservation.XXXXXX)" && pwd -P)"

  # Extract verify_patched (header line through the first column-0 close brace).
  SNIPPET="${WORK}/verify_patched.sh"
  awk '/^verify_patched\(\)[[:space:]]*\{/{f=1} f{print} f&&/^\}/{exit}' \
    "${DAEMON_APPLY}" >"${SNIPPET}"
  [[ -s "${SNIPPET}" ]] || skip "could not extract verify_patched from daemon-apply.sh"

  # Before-image fixtures.
  BEFORE_FM="${WORK}/before_fm.md"       # frontmatter + heading + body
  BEFORE_RULES="${WORK}/before_rules.md" # frontmatter + heading + > Rules: + body
  BEFORE_BIG="${WORK}/before_big.md"     # large body (for the shrink floor)
  BEFORE_NO_FM="${WORK}/before_no_fm.md" # a rules-file shape: NEVER had frontmatter
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' 'a meaningful body line'
  } >"${BEFORE_FM}"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' '> Rules: comment-logging' 'a body line'
  } >"${BEFORE_RULES}"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent'
    local i
    for i in $(seq 1 60); do printf 'substantial body line number %s with content\n' "${i}"; done
  } >"${BEFORE_BIG}"
  {
    printf '%s\n' '# Agent Global Rules' 'This file never had frontmatter.' 'a body line'
  } >"${BEFORE_NO_FM}"

  # After-image (post-apply target) fixtures.
  AFTER_NO_FM="${WORK}/after_no_fm.md"       # frontmatter STRIPPED (heading kept)
  AFTER_NO_RULES="${WORK}/after_no_rules.md" # > Rules: anchor REMOVED (fm + heading kept)
  AFTER_SHRUNK="${WORK}/after_shrunk.md"     # gutted to a lone heading
  AFTER_FM_OK="${WORK}/after_fm_ok.md"       # a valid patch: preserves fm + heading + body
  AFTER_NO_FM_OK="${WORK}/after_no_fm_ok.md" # never-had-fm target, still no fm (valid)
  {
    printf '%s\n' '# Probe Agent' 'a meaningful body line, frontmatter gone'
  } >"${AFTER_NO_FM}"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' 'a body line, anchor gone'
  } >"${AFTER_NO_RULES}"
  {
    printf '%s\n' '# Probe Agent'
  } >"${AFTER_SHRUNK}"
  {
    printf '%s\n' '---' 'name: probe-agent' '---' '# Probe Agent' 'an edited but intact body line'
  } >"${AFTER_FM_OK}"
  {
    printf '%s\n' '# Agent Global Rules' 'This file still never had frontmatter.' 'an edited body line'
  } >"${AFTER_NO_FM_OK}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Drive the extracted predicate: $1=before-image, $2=after (target). status is
# verify_patched's return (0 = pass/preserved, non-0 = fail/restore).
verify() {
  run env VBI="$1" TGT="$2" SNIP="${SNIPPET}" bash -c '
    source "${SNIP}"
    VERIFY_BEFORE_IMAGE="${VBI}"
    verify_patched "${TGT}"
  '
}

# --- FAIL-AT-HEAD: preservation violations must FAIL the predicate ---

@test "removed-frontmatter after-image → predicate FAILS [FAIL-AT-HEAD: HEAD passes on the heading]" {
  verify "${BEFORE_FM}" "${AFTER_NO_FM}"
  [[ "${status}" -ne 0 ]] || { echo "stripping present-before frontmatter must fail the predicate" >&2; return 1; }
}

@test "removed-\`> Rules:\`-anchor after-image → predicate FAILS [FAIL-AT-HEAD]" {
  verify "${BEFORE_RULES}" "${AFTER_NO_RULES}"
  [[ "${status}" -ne 0 ]] || { echo "removing a present-before > Rules: anchor must fail the predicate" >&2; return 1; }
}

@test "gutted (shrunk past the proportional floor) after-image → predicate FAILS [FAIL-AT-HEAD]" {
  verify "${BEFORE_BIG}" "${AFTER_SHRUNK}"
  [[ "${status}" -ne 0 ]] || { echo "shrinking past the proportional floor must fail the predicate" >&2; return 1; }
}

@test "the predicate reads the VERIFY_BEFORE_IMAGE global [FAIL-AT-HEAD: HEAD ignores it]" {
  # With the SAME after-image, a before-image that HAD frontmatter must fail while
  # a before-image that NEVER had it must pass — a difference observable ONLY if the
  # predicate actually consults VERIFY_BEFORE_IMAGE. HEAD returns 0 for both.
  verify "${BEFORE_FM}" "${AFTER_NO_FM}"
  local had_fm="${status}"
  verify "${BEFORE_NO_FM}" "${AFTER_NO_FM}"
  local never_fm="${status}"
  [[ "${had_fm}" -ne "${never_fm}" ]] || { echo "verdict does not depend on VERIFY_BEFORE_IMAGE (had=${had_fm} never=${never_fm})" >&2; return 1; }
}

@test "doc header names a defect class it cannot detect [FAIL-AT-HEAD: HEAD says only 'basic']" {
  # T20 AC: "The header shall name the defect classes it cannot detect."
  # Match the defect-class framing specifically — avoid the incidental "cannot see
  # the call site" phrasing already in the shellcheck-disable comment at HEAD.
  run bash -c 'sed -n "/^# verify_patched/,/^verify_patched()/p" "$1" | grep -Eiq "defect|semantic|cannot detect|does not detect|undetect"' _ "${DAEMON_APPLY}"
  [[ "${status}" -eq 0 ]] || { echo "verify_patched doc header does not name an undetectable defect class" >&2; return 1; }
}

# --- REGRESSION GUARDS (GREEN at HEAD and after) ---

@test "a never-had-frontmatter target is not penalized for its continued absence" {
  verify "${BEFORE_NO_FM}" "${AFTER_NO_FM_OK}"
  [[ "${status}" -eq 0 ]] || { echo "a file that never had frontmatter must not be penalized, got ${status}" >&2; return 1; }
}

@test "a semantically valid patch (frontmatter + heading + body preserved) still succeeds" {
  verify "${BEFORE_FM}" "${AFTER_FM_OK}"
  [[ "${status}" -eq 0 ]] || { echo "a valid preserving patch must succeed, got ${status}" >&2; return 1; }
}

@test "an empty target still fails (the retained non-empty base check)" {
  local empty="${WORK}/empty.md"
  : >"${empty}"
  verify "${BEFORE_FM}" "${empty}"
  [[ "${status}" -ne 0 ]] || { echo "an empty target must fail the predicate" >&2; return 1; }
}

# --- ANCHOR CONTRACT (P1-4): precedence + fail-CLOSED + transaction wiring ---

@test "GIT_TXN_BEFORE_IMAGE takes precedence over VERIFY_BEFORE_IMAGE" {
  # Same after-image; the two globals point at DIFFERENT before-images. The
  # verdict must follow GIT_TXN_BEFORE_IMAGE: had-frontmatter there → FAIL,
  # never-had-frontmatter there → PASS (regardless of VERIFY_BEFORE_IMAGE).
  run env TXN="${BEFORE_FM}" VBI="${BEFORE_NO_FM}" TGT="${AFTER_NO_FM}" SNIP="${SNIPPET}" bash -c '
    source "${SNIP}"
    GIT_TXN_BEFORE_IMAGE="${TXN}"
    VERIFY_BEFORE_IMAGE="${VBI}"
    verify_patched "${TGT}"
  '
  [[ "${status}" -ne 0 ]] || {
    echo "predicate keyed on VERIFY_BEFORE_IMAGE, not the published GIT_TXN_BEFORE_IMAGE" >&2
    return 1
  }
  run env TXN="${BEFORE_NO_FM}" VBI="${BEFORE_FM}" TGT="${AFTER_NO_FM}" SNIP="${SNIPPET}" bash -c '
    source "${SNIP}"
    GIT_TXN_BEFORE_IMAGE="${TXN}"
    VERIFY_BEFORE_IMAGE="${VBI}"
    verify_patched "${TGT}"
  '
  [[ "${status}" -eq 0 ]] || {
    echo "a never-had-frontmatter GIT_TXN_BEFORE_IMAGE anchor must win over the fallback" >&2
    return 1
  }
}

@test "forced-empty anchor fails CLOSED with a loud stderr line" {
  run env TGT="${AFTER_FM_OK}" SNIP="${SNIPPET}" bash -c '
    source "${SNIP}"
    GIT_TXN_BEFORE_IMAGE=""
    VERIFY_BEFORE_IMAGE=""
    verify_patched "${TGT}"
  '
  [[ "${status}" -ne 0 ]] || {
    echo "an empty anchor must FAIL the predicate (fail-closed), got 0" >&2
    return 1
  }
  [[ "${output}" == *"preservation anchor missing/unreadable"* ]] || {
    echo "missing the loud anchor stderr line: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"caller-wiring gap"* ]] || {
    echo "stderr line must name the caller-wiring gap: ${output}" >&2
    return 1
  }
}

@test "unreadable (nonexistent) anchor fails CLOSED with the same loud stderr line" {
  run env VBI="${WORK}/no-such-before-image.bak" TGT="${AFTER_FM_OK}" SNIP="${SNIPPET}" bash -c '
    source "${SNIP}"
    VERIFY_BEFORE_IMAGE="${VBI}"
    verify_patched "${TGT}"
  '
  [[ "${status}" -ne 0 ]] || {
    echo "an unreadable anchor must FAIL the predicate (fail-closed), got 0" >&2
    return 1
  }
  [[ "${output}" == *"preservation anchor missing/unreadable"* ]] || {
    echo "missing the loud anchor stderr line: ${output}" >&2
    return 1
  }
}

@test "transaction: forced-empty anchor → verify fails closed and the atomic restore fires" {
  local tree="${WORK}/txn-tree"
  mkdir -p -- "${tree}"
  local tgt="${tree}/probe.md"
  cp -p -- "${BEFORE_FM}" "${tgt}"
  run env SNIP="${SNIPPET}" LIB="${GA}/autoagent/lib/git-txn.sh" \
    TGT="${tgt}" BAK="${WORK}/txn-bak" bash -c '
    source "${LIB}"
    source "${SNIP}"
    _apply_mut() { printf "%s\n" "mutated line" >>"$1"; }
    _verify_forced_empty() {
      GIT_TXN_BEFORE_IMAGE=""
      VERIFY_BEFORE_IMAGE=""
      verify_patched "$1"
    }
    git_txn_apply "${TGT%/*}" "${TGT}" "${TGT}" "the-diff" "${BAK}" _apply_mut _verify_forced_empty
    [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_VERIFY_FAIL}" ]]
  '
  [[ "${status}" -eq 0 ]] || {
    echo "expected GIT_TXN_VERIFY_FAIL on a forced-empty anchor: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"preservation anchor missing/unreadable"* ]] || {
    echo "missing the loud anchor stderr line: ${output}" >&2
    return 1
  }
  # restore fired: target back to pristine pre-apply bytes
  cmp -s "${BEFORE_FM}" "${tgt}" || {
    echo "atomic restore did not fire (target still mutated)" >&2
    return 1
  }
  ! grep -q 'mutated line' "${tgt}" || {
    echo "applied bytes survived the restore" >&2
    return 1
  }
}

@test "transaction: SYMLINK target (agent-file scenario) — anchor readable, preserving patch verifies OK" {
  # Daemon wiring mirrored: target = facade symlink, real_target = resolved GA
  # file, VERIFY_BEFORE_IMAGE convention-derived from the REAL basename (:2038).
  # Fail-closed makes an OK verdict PROOF the anchor was readable mid-verify.
  local ga_agents="${WORK}/ga-agents" facade="${WORK}/facade"
  mkdir -p -- "${ga_agents}" "${facade}"
  local real="${ga_agents}/probe.md"
  cp -p -- "${BEFORE_FM}" "${real}"
  ln -s "${real}" "${facade}/probe.md"
  run env SNIP="${SNIPPET}" LIB="${GA}/autoagent/lib/git-txn.sh" \
    LINK="${facade}/probe.md" REAL="${real}" BAK="${WORK}/sym-bak" bash -c '
    source "${LIB}"
    source "${SNIP}"
    _apply_edit() { printf "%s\n" "an appended body line" >>"$1"; }
    VERIFY_BEFORE_IMAGE="${BAK}/${REAL##*/}.bak"
    git_txn_apply "${REAL%/*}" "${LINK}" "${REAL}" "the-diff" "${BAK}" _apply_edit verify_patched
    [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_OK}" ]]
  '
  [[ "${status}" -eq 0 ]] || {
    echo "symlink-target transaction did not verify OK: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"preservation anchor missing/unreadable"* ]] || {
    echo "anchor unreadable for a symlink target: ${output}" >&2
    return 1
  }
  # the apply landed through the symlink on the real file and was kept
  grep -q 'an appended body line' "${real}" || {
    echo "applied bytes missing from the real file" >&2
    return 1
  }
}

# --- STRUCTURAL GUARDS (GREEN at HEAD and after) ---

@test "the callback signature stays one-argument (no positional \$2)" {
  run grep -nE '\$\{?2\}?' "${SNIPPET}"
  [[ "${status}" -ne 0 ]] || { echo "verify_patched must not take a second positional (before-image is a global): ${output}" >&2; return 1; }
}

@test "the predicate makes no network / LLM call" {
  run grep -nEi 'curl|wget|anthropic|https?://|/v1/messages|llm' "${SNIPPET}"
  [[ "${status}" -ne 0 ]] || { echo "verify_patched must make no network/LLM call: ${output}" >&2; return 1; }
}
