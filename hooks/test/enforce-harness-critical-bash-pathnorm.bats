#!/usr/bin/env bats
# enforce-harness-critical.sh — Bash-arm protected-path normalisation (clauded-docs/774 T1-1).
#
# The Bash arm recognised a protected path by matching the RAW command text, so one
# redundant separator defeated every block class while the Write arm — which already
# routes through the classifier's normalize_path — still blocked. This suite pins the
# repaired behaviour in BOTH polarities: the varied spellings that must now block, and
# the legitimate traffic plus sibling roots that must keep passing.
#
# Reporting contract: this file carries the Bash-arm path-normalisation set ONLY. The
# Write-arm A-set lives in enforce-harness-critical-pathnorm.bats, which also owns the
# classifier/shell normaliser parity corpus this repair depends on.
#
# Run via: bats hooks/test/enforce-harness-critical-bash-pathnorm.bats
# Requires: bats, bash 3.2+, python3, jq. Hermetic FAKE_HOME, DIRECT hook invocation
# (an interpreter prefix would bypass the executable bit).

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  # Protected roots, plus the sibling and adjacent roots the widened patterns must
  # keep out: the before-image store the apply-rollback contract reads, a dotted
  # sibling, a suffixed sibling, and this repository's own development checkout.
  mkdir -p \
    "${FAKE_HOME}/.claude/hooks" "${FAKE_HOME}/.claude/agents" "${FAKE_HOME}/.claude/todos" \
    "${FAKE_HOME}/.glass-atrium/hooks" "${FAKE_HOME}/.glass-atrium/agents" \
    "${FAKE_HOME}/.glass-atrium/autoagent" "${FAKE_HOME}/.glass-atrium/scripts" \
    "${FAKE_HOME}/.glass-atrium/skills" "${FAKE_HOME}/.glass-atrium/wiki" \
    "${FAKE_HOME}/.glass-atrium/agents-bak" "${FAKE_HOME}/.glass-atrium/agents.old" \
    "${FAKE_HOME}/.glass-atrium/hooksx" \
    "${BATS_TEST_TMPDIR}/git/glass-atrium/hooks"
}

bash_hook() {
  local envelope
  envelope="$(jq -cn --arg c "${1}" '{tool_name: "Bash", tool_input: {command: $c}}')"
  run env "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

# ── T1-1.a — a redirect target in every varied spelling blocks ───────────────

@test "T1-1.a redirect: double separator into the settings file → block" {
  bash_hook "printf x > ${FAKE_HOME}/.claude//settings.json"
  [ "${status}" -eq 2 ]
}

@test "T1-1.a redirect: dot segment into the settings file → block" {
  bash_hook "printf x > ${FAKE_HOME}/.claude/./settings.json"
  [ "${status}" -eq 2 ]
}

@test "T1-1.a redirect: triple separator into the settings file → block" {
  bash_hook "printf x > ${FAKE_HOME}/.claude///settings.json"
  [ "${status}" -eq 2 ]
}

@test "T1-1.a redirect: dot-dot backtrack into the settings file → block" {
  bash_hook "printf x > ${FAKE_HOME}/.claude/todos/../settings.json"
  [ "${status}" -eq 2 ]
}

# ── T1-1.b — the other block classes, including the two command-text sites ──

@test "T1-1.b copy verb with a double separator (command-text site) → block" {
  bash_hook "cp /tmp/e.sh ${FAKE_HOME}/.glass-atrium//scripts/gen.sh"
  [ "${status}" -eq 2 ]
}

@test "T1-1.b permission verb with a double separator (command-text site) → block" {
  bash_hook "chmod 644 ${FAKE_HOME}/.glass-atrium//hooks/a.sh"
  [ "${status}" -eq 2 ]
}

@test "T1-1.b python code-flag write with a double separator → block" {
  bash_hook "python3 -c 'open(\"${FAKE_HOME}/.glass-atrium//hooks/a.sh\", \"w\").write(\"x\")'"
  [ "${status}" -eq 2 ]
}

@test "T1-1.b node code-flag write with a dot segment → block" {
  bash_hook "node -e 'require(\"fs\").writeFileSync(\"${FAKE_HOME}/.claude/./settings.json\", \"x\")'"
  [ "${status}" -eq 2 ]
}

@test "T1-1.b nested shell code flag with a double separator → block" {
  bash_hook "bash -c 'printf x > ${FAKE_HOME}/.claude//settings.json'"
  [ "${status}" -eq 2 ]
}

@test "T1-1.b dd output operand with a double separator → block" {
  bash_hook "dd if=/tmp/e.sh of=${FAKE_HOME}/.glass-atrium//hooks/a.sh"
  [ "${status}" -eq 2 ]
}

@test "T1-1.b awk redirect target with a double separator → block" {
  bash_hook "awk '{print > \"${FAKE_HOME}/.glass-atrium//hooks/a.sh\"}' /tmp/in"
  [ "${status}" -eq 2 ]
}

# ── T1-1.c — the cwd-arming site, the seventh recognition site ───────────────

@test "T1-1.c cwd arming with a double separator, then a relative write → block" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium//hooks && printf x > z.sh"
  [ "${status}" -eq 2 ]
}

@test "T1-1.c cwd arming with a dot segment, then a relative write → block" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium/./hooks && printf x > z.sh"
  [ "${status}" -eq 2 ]
}

@test "T1-1.c cwd arming through a dot-dot intermediate, then a relative write → block" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium/wiki/../hooks && printf x > z.sh"
  [ "${status}" -eq 2 ]
}

# ── T1-1.d — the fourteen-command legitimate baseline (negative polarity) ────

@test "T1-1.d baseline 01: read the settings file → pass" {
  bash_hook "cat ${FAKE_HOME}/.claude/settings.json"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 02: recursive search across the live hooks dir → pass" {
  bash_hook "grep -r foo ${FAKE_HOME}/.glass-atrium/hooks"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 03: directory listing of the agents dir → pass" {
  bash_hook "ls -la ${FAKE_HOME}/.glass-atrium/agents"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 04: read a protected file into a temporary path → pass" {
  bash_hook "cat ${FAKE_HOME}/.claude/settings.json > /tmp/out"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 05: enter a protected dir and write elsewhere → pass" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium/hooks && grep x f > /tmp/out"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 06: line count over a scheduled script → pass" {
  bash_hook "wc -l ${FAKE_HOME}/.glass-atrium/autoagent/daemon-apply.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 07: modification-time search → pass" {
  bash_hook "find ${FAKE_HOME}/.glass-atrium/hooks -mtime -1"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 08: two-file comparison inside the protected tree → pass" {
  bash_hook "diff ${FAKE_HOME}/.glass-atrium/hooks/a.sh ${FAKE_HOME}/.glass-atrium/hooks/b.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 09: repository status query rooted in a protected dir → pass" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium/agents && git status --porcelain"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 10: non-in-place stream edit → pass" {
  bash_hook "sed 's/a/b/' ${FAKE_HOME}/.glass-atrium/hooks/a.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 11: awk read → pass" {
  bash_hook "awk '{print}' ${FAKE_HOME}/.glass-atrium/hooks/a.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 12: execute a script that lives in the protected tree → pass" {
  bash_hook "${FAKE_HOME}/.glass-atrium/scripts/wiki-query.sh keyword"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 13: pipe a protected read into a temporary path → pass" {
  bash_hook "cat ${FAKE_HOME}/.claude/settings.json | tee /tmp/out"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d baseline 14: double-separator write to an unprotected path → pass" {
  bash_hook "printf x > /tmp//out"
  [ "${status}" -eq 0 ]
}

@test "T1-1.d known false positive: copying a protected file to a backup stays blocked" {
  # Documented in the hook header and deliberately uncorrected — the copy verbs match
  # segment-wide and cannot tell a source from a target. Asserted UNCHANGED, so a
  # silent repair here would surface as a failing row rather than as a quiet widening.
  bash_hook "cp ${FAKE_HOME}/.claude/settings.json /tmp/backup"
  [ "${status}" -eq 2 ]
}

# ── T1-1.e / T1-1.f — the two measured false-positive reductions ─────────────

@test "T1-1.e redirect resolving OUT of the protected tree → pass" {
  bash_hook "printf x > ${FAKE_HOME}/.glass-atrium/hooks/../../work/z"
  [ "${status}" -eq 0 ]
}

@test "T1-1.f cwd arming that resolves to an unprotected parent → pass" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium/hooks/.. && printf x > z.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.f cwd arming that resolves OUT of the protected tree → pass" {
  bash_hook "cd ${FAKE_HOME}/.glass-atrium/hooks/../../work && printf x > z.sh"
  [ "${status}" -eq 0 ]
}

# ── T1-1.i — case folding survives every recompiled pattern ──────────────────

@test "T1-1.i case-varied file form with a double separator → block" {
  bash_hook "printf x > ${FAKE_HOME}/.Claude//Settings.json"
  [ "${status}" -eq 2 ]
}

@test "T1-1.i case-varied directory form at a command-text site → block" {
  bash_hook "cp /tmp/e.sh ${FAKE_HOME}/.Glass-Atrium//HOOKS/a.sh"
  [ "${status}" -eq 2 ]
}

@test "T1-1.i case-varied cwd arming with a dot segment → block" {
  bash_hook "cd ${FAKE_HOME}/.Glass-Atrium/./Hooks && printf x > z.sh"
  [ "${status}" -eq 2 ]
}

# ── T1-1.j — the sibling and adjacent roots the widening must not swallow ────

@test "T1-1.j this repository's own development checkout → pass" {
  bash_hook "printf x > ${BATS_TEST_TMPDIR}/git/glass-atrium/hooks/a.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.j the live rollback before-image store → pass" {
  bash_hook "printf x > ${FAKE_HOME}/.glass-atrium/agents-bak/glass-atrium-dev-shell.md"
  [ "${status}" -eq 0 ]
}

@test "T1-1.j a dotted sibling of a protected directory → pass" {
  bash_hook "printf x > ${FAKE_HOME}/.glass-atrium/agents.old/x.md"
  [ "${status}" -eq 0 ]
}

@test "T1-1.j a suffixed sibling of a protected directory → pass" {
  bash_hook "printf x > ${FAKE_HOME}/.glass-atrium/hooksx/a.sh"
  [ "${status}" -eq 0 ]
}

@test "T1-1.j a copy verb naming the before-image store → pass" {
  # The command-text site sees the whole segment, so the widened pattern is what
  # keeps this row passing — the token normaliser never reaches it.
  bash_hook "cp /tmp/e.md ${FAKE_HOME}/.glass-atrium/agents-bak/x.md"
  [ "${status}" -eq 0 ]
}

@test "T1-1.j a copy verb naming the development checkout → pass" {
  bash_hook "cp /tmp/e.sh ${BATS_TEST_TMPDIR}/git/glass-atrium/hooks/a.sh"
  [ "${status}" -eq 0 ]
}

# ── residual — the class the repair explicitly does NOT close ────────────────

@test "T1-1.h the header's residual paragraph states what the repair does and does not cover" {
  # The one criterion in this set that cannot be stated behaviourally: a header claiming
  # coverage the gate lacks is the same defect class as the gate itself, so the residual
  # sentence is pinned here rather than trusted to survive the next edit.
  grep -qF 'a `..` backtrack spelled inside a COMMAND-TEXT' "${HOOK_SH}" || {
    echo "header no longer names the command-text backtrack residual" >&2
    return 1
  }
  grep -qF 'resolve it through' "${HOOK_SH}" && grep -qF 'normalize_path before matching' "${HOOK_SH}"
}

@test "residual: a dot-dot form inside a mutation-verb argument region still blocks" {
  # The command-text sites hold no single path token, so no normaliser can resolve
  # this spelling. Pin 8: the out-of-tree reduction is scoped to the redirect form,
  # and this deliberate over-block is asserted rather than assumed.
  bash_hook "cp /tmp/e.sh ${FAKE_HOME}/.glass-atrium/hooks/../../work/z"
  [ "${status}" -eq 2 ]
}
