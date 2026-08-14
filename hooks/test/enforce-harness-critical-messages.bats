#!/usr/bin/env bats
# enforce-harness-critical.sh — block PAYLOAD suite (clauded-docs/2112 R1 + R2).
#
# Scope split from the envelope suites: this file asserts the emitted JSON
# `message` / `suggestion` per block class, plus the source-position classifier
# refinement. Verdicts themselves stay pinned by the four sibling suites; the
# verdict-matrix rows here only pin that R1/R2 WEAKENED nothing (block stays
# block, pass stays pass) on a representative envelope per class.
#
# Run via: bats hooks/test/enforce-harness-critical-messages.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq.
#
# Hermetic strategy + INVOCATION CONVENTION follow the main suite: every protected
# path lives under a per-test FAKE_HOME, and the hook is executed DIRECTLY as a
# command, never interpreter-prefixed (`bash hook.sh`) — an interpreter prefix
# bypasses the executable bit, so a mode-644 hook would still pass a green suite.
# Helpers are re-declared here because bats sources only lib/*.bash across files.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  AGENTS="${FAKE_HOME}/.glass-atrium/agents"
  mkdir -p "${FAKE_HOME}/.claude/hooks" "${FAKE_HOME}/.claude/agents" \
    "${FAKE_HOME}/.glass-atrium/hooks" "${AGENTS}" \
    "${FAKE_HOME}/.glass-atrium/scripts"

  cat >"${AGENTS}/glass-atrium-dev-shell.md" <<'MD'
---
name: glass-atrium-dev-shell
tools: [Read, Bash]
scope: DEV
model: claude-model-a
---
# Body

Body paragraph.
MD

  cat >"${AGENTS}/unterminated.md" <<'MD'
---
name: unterminated
tools: [Read]
scope: DEV
MD

  cat >"${AGENTS}/nested.md" <<'MD'
---
name: nested
tools:
  inner: [Read]
scope: DEV
---
# Body
MD
}

run_hook() {
  local tool="${1}" tin="${2}" envelope
  envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" \
    '{tool_name: $t, tool_input: $ti}')"
  run env "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
}

bash_input() { jq -cn --arg c "${1}" '{command: $c}'; }
write_input() { jq -cn --arg p "${1}" --arg c "${2}" '{file_path: $p, content: $c}'; }
read_input() { jq -cn --arg p "${1}" '{file_path: $p}'; }
edit_input() {
  jq -cn --arg p "${1}" --arg o "${2}" --arg n "${3}" \
    '{file_path: $p, old_string: $o, new_string: $n}'
}

payload_field() { jq -r ".${1} // \"\"" <<<"${output}"; }

# One representative envelope per block class. Args: $1=class label.
emit_class() {
  local prot="${FAKE_HOME}/.claude/settings.json"
  case "${1}" in
    live-settings) run_hook "Write" "$(write_input "${prot}" "x")" ;;
    live-hooks-dir) run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/hooks/x.sh" "x")" ;;
    scheduled-exec-dir) run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/scripts/x.sh" "x")" ;;
    new-agent-creation) run_hook "Write" "$(write_input "${AGENTS}/brand-new.md" "x")" ;;
    identity-frontmatter-write)
      run_hook "Write" "$(write_input "${AGENTS}/glass-atrium-dev-shell.md" \
        "---
name: renamed
tools: [Read, Bash]
scope: DEV
---
# Body")"
      ;;
    identity-frontmatter-edit)
      run_hook "Edit" "$(edit_input "${AGENTS}/glass-atrium-dev-shell.md" \
        "name: glass-atrium-dev-shell" "name: renamed")"
      ;;
    frontmatter-fence-edit)
      run_hook "Edit" "$(edit_input "${AGENTS}/glass-atrium-dev-shell.md" \
        "---
name: glass-atrium-dev-shell" "name: glass-atrium-dev-shell")"
      ;;
    unterminated-frontmatter)
      run_hook "Edit" "$(edit_input "${AGENTS}/unterminated.md" "name: unterminated" "name: x")"
      ;;
    frontmatter-unparseable)
      run_hook "Edit" "$(edit_input "${AGENTS}/nested.md" "name: nested" "name: x")"
      ;;
    edit-create-shape)
      run_hook "Edit" "$(edit_input "${AGENTS}/glass-atrium-dev-shell.md" "" "x")"
      ;;
    unreadable-edit-payload)
      run_hook "Edit" "$(jq -cn --arg p "${AGENTS}/glass-atrium-dev-shell.md" '{file_path: $p}')"
      ;;
    bash-mutation) run_hook "Bash" "$(bash_input "cp /tmp/x ${prot}")" ;;
    bash-interp-write)
      run_hook "Bash" "$(bash_input "python3 -c \"open('${prot}','w').write('x')\"")"
      ;;
    bash-cwd-relative-write)
      run_hook "Bash" "$(bash_input "cd ${FAKE_HOME}/.claude/hooks && cp /tmp/x y.sh")"
      ;;
    bash-source-position) run_hook "Bash" "$(bash_input "cp -p ${prot} /tmp/bak")" ;;
    *) return 1 ;;
  esac
}

# ── R2 acceptance (doc 2112 §8) ────────────────────────────────────────────────

@test "R2 AC1 cp source-position: still blocks, no 'write blocked', read-respelling remedy" {
  run_hook "Bash" "$(bash_input "cp -p ${FAKE_HOME}/.claude/settings.json /tmp/bak")"
  [ "${status}" -eq 2 ]
  [ "$(payload_field 'context.class')" = "bash-source-position" ]
  local msg sug
  msg="$(payload_field message)"
  sug="$(payload_field suggestion)"
  [[ "${msg}" != *"write blocked"* ]] && [[ "${msg}" == *"SOURCE position"* ]]
  [[ "${sug}" == *"Read tool"* ]] && [[ "${sug}" == *"cat <protected>"* ]] && [[ "${sug}" == *"of=<dest>"* ]]
  [[ "${sug}" != *"agent_lifecycle"* ]] && [[ "${sug}" != *"frontmatter"* ]]
}

@test "R2 AC2 re-spelling: the Read tool passes" {
  run_hook "Read" "$(read_input "${FAKE_HOME}/.claude/settings.json")"
  [ "${status}" -eq 0 ]
}

@test "R2 AC2 re-spelling: cat redirect to an unprotected dest passes" {
  run_hook "Bash" "$(bash_input "cat ${FAKE_HOME}/.claude/settings.json > /tmp/bak")"
  [ "${status}" -eq 0 ]
}

@test "R2 AC2 re-spelling: dd reading the protected path passes" {
  run_hook "Bash" "$(bash_input "dd if=${FAKE_HOME}/.claude/settings.json of=/tmp/bak")"
  [ "${status}" -eq 0 ]
}

@test "R2 AC3 direction pair: source position vs target position" {
  local prot="${FAKE_HOME}/.claude/settings.json"
  run_hook "Bash" "$(bash_input "cp ${prot} /tmp/x")"
  [ "${status}" -eq 2 ] && [ "$(payload_field 'context.class')" = "bash-source-position" ]
  run_hook "Bash" "$(bash_input "cp /tmp/x ${prot}")"
  [ "${status}" -eq 2 ] && [ "$(payload_field 'context.class')" = "bash-mutation" ]
}

@test "R2 AC4 ambiguous grammar falls back to bash-mutation, never to a pass" {
  local prot="${FAKE_HOME}/.claude/settings.json" cmd
  local cmds=(
    "cp -t ${prot} /tmp/x"
    "cp --preserve=mode ${prot} /tmp/bak"
    "cp -- ${prot} /tmp/bak"
    "cp \${SRC} ${prot}"
    "cp ${FAKE_HOME}/.claude/hooks/* /tmp/bak"
    "cp -p ${prot}"
    "cp ${prot} ${FAKE_HOME}/.claude/hooks/bak"
    "rsync -e ssh ${FAKE_HOME}/.glass-atrium/hooks/ host:/tmp"
    "ln -s ${prot} /tmp/l"
    "tee ${prot}"
    "truncate -s 0 ${prot}"
    "chmod 644 ${prot}"
    "install -d ${FAKE_HOME}/.claude/hooks/new"
  )
  for cmd in "${cmds[@]}"; do
    run_hook "Bash" "$(bash_input "${cmd}")"
    [ "${status}" -eq 2 ] || {
      echo "expected block for: ${cmd}"
      return 1
    }
    [ "$(payload_field 'context.class')" = "bash-mutation" ] || {
      echo "expected bash-mutation for: ${cmd} (got $(payload_field 'context.class'))"
      return 1
    }
  done
}

@test "R2 source-position also recognised for mv / install / rsync" {
  local cmd
  local cmds=(
    "mv ${FAKE_HOME}/.claude/hooks/a.sh /tmp/bak"
    "install -p ${FAKE_HOME}/.claude/settings.json /tmp/bak"
    "rsync -av ${FAKE_HOME}/.glass-atrium/hooks/ /tmp/bak"
  )
  for cmd in "${cmds[@]}"; do
    run_hook "Bash" "$(bash_input "${cmd}")"
    [ "${status}" -eq 2 ] || {
      echo "expected block for: ${cmd}"
      return 1
    }
    [ "$(payload_field 'context.class')" = "bash-source-position" ] || {
      echo "expected bash-source-position for: ${cmd} (got $(payload_field 'context.class'))"
      return 1
    }
  done
}

# ── R1 per-class wording ───────────────────────────────────────────────────────

@test "R1 every block class: expected verdict, distinct suggestion, frontmatter-sentence rule" {
  local label cls sug seen=""
  local labels=(
    live-settings live-hooks-dir scheduled-exec-dir new-agent-creation
    identity-frontmatter-write identity-frontmatter-edit frontmatter-fence-edit
    unterminated-frontmatter frontmatter-unparseable edit-create-shape
    unreadable-edit-payload bash-mutation bash-interp-write
    bash-cwd-relative-write bash-source-position
  )
  for label in "${labels[@]}"; do
    emit_class "${label}"
    [ "${status}" -eq 2 ] || {
      echo "expected block for class ${label} (status ${status})"
      return 1
    }
    cls="$(payload_field 'context.class')"
    [ "${cls}" = "${label}" ] || {
      echo "class mismatch: wanted ${label}, got ${cls}"
      return 1
    }
    sug="$(payload_field suggestion)"
    [ -n "${sug}" ] || {
      echo "empty suggestion for ${label}"
      return 1
    }
    case "${label}" in
      unterminated-frontmatter | frontmatter-unparseable)
        [[ "${sug}" == *"Unparseable agent frontmatter"* ]] || {
          echo "missing frontmatter-repair sentence on ${label}"
          return 1
        }
        ;;
      *)
        [[ "${sug}" != *"Unparseable agent frontmatter"* ]] || {
          echo "frontmatter-repair sentence leaked onto ${label}"
          return 1
        }
        ;;
    esac
    seen="${seen}${sug}"$'\n'
  done
  [ "$(printf '%s' "${seen}" | sort | uniq -d | wc -l | tr -d ' ')" = "0" ]
}

@test "R1 live-settings suggestion omits update.sh and the frontmatter sentence" {
  emit_class "live-settings"
  [ "${status}" -eq 2 ]
  local sug
  sug="$(payload_field suggestion)"
  [[ "${sug}" != *"update.sh"* ]] && [[ "${sug}" != *"frontmatter"* ]]
}

@test "R1 bash classes never carry the frontmatter sentence" {
  local label sug
  for label in bash-mutation bash-interp-write bash-cwd-relative-write bash-source-position; do
    emit_class "${label}"
    sug="$(payload_field suggestion)"
    [[ "${sug}" != *"frontmatter"* ]] || {
      echo "frontmatter wording on ${label}"
      return 1
    }
  done
}

@test "R1 classifier-failure: fail-closed wording, no deployment remedies" {
  local bindir
  bindir="${BATS_TEST_TMPDIR}/pybroken"
  mkdir -p "${bindir}"
  local tool src
  for tool in env bash jq basename cat grep tr sed mktemp dirname; do
    if src="$(command -v "${tool}")"; then ln -sf "${src}" "${bindir}/${tool}"; fi
  done
  printf '#!/usr/bin/env bash\nexit 9\n' >"${bindir}/python3"
  chmod +x "${bindir}/python3"
  local envelope
  envelope="$(jq -cn --arg p "${FAKE_HOME}/.claude/settings.json" \
    '{tool_name: "Write", tool_input: {file_path: $p, content: "x"}}')"
  run env "PATH=${bindir}" "HOME=${FAKE_HOME}" "${HOOK_SH}" <<<"${envelope}"
  [ "${status}" -eq 2 ]
  [ "$(payload_field 'context.class')" = "classifier-failure" ]
  local msg sug
  msg="$(payload_field message)"
  sug="$(payload_field suggestion)"
  [[ "${msg}" == *"failing closed"* ]]
  [[ "${sug}" == *"python3"* ]]
  [[ "${sug}" != *"update.sh"* ]] && [[ "${sug}" != *"agent_lifecycle"* ]] && [[ "${sug}" != *"frontmatter"* ]]
}

# ── Verdict matrix: nothing that passes today may start blocking ───────────────

@test "no verdict weakened: representative passing envelopes still pass" {
  local cmd
  local cmds=(
    "cat ${FAKE_HOME}/.claude/settings.json"
    "grep -n name ${AGENTS}/glass-atrium-dev-shell.md"
    "cp /tmp/a /tmp/b"
    "cp -p /tmp/a ${FAKE_HOME}/notes.txt"
    "sed -n 1p ${FAKE_HOME}/.claude/settings.json"
    "dd if=${FAKE_HOME}/.glass-atrium/hooks/x.sh of=/tmp/bak"
  )
  for cmd in "${cmds[@]}"; do
    run_hook "Bash" "$(bash_input "${cmd}")"
    [ "${status}" -eq 0 ] || {
      echo "expected pass for: ${cmd} (status ${status}, ${output})"
      return 1
    }
  done
  run_hook "Write" "$(write_input "${FAKE_HOME}/notes.txt" "x")"
  [ "${status}" -eq 0 ]
  run_hook "Edit" "$(edit_input "${AGENTS}/glass-atrium-dev-shell.md" "Body paragraph." "Edited body.")"
  [ "${status}" -eq 0 ]
}

@test "no verdict weakened: HARNESS_PROTECTION_APPROVE=1 still grants the source-position class" {
  local envelope
  envelope="$(jq -cn --arg c "cp -p ${FAKE_HOME}/.claude/settings.json /tmp/bak" \
    '{tool_name: "Bash", tool_input: {command: $c}}')"
  run env "HOME=${FAKE_HOME}" "HARNESS_PROTECTION_APPROVE=1" "${HOOK_SH}" <<<"${envelope}"
  [ "${status}" -eq 0 ]
}
