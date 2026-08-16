#!/usr/bin/env bats
# advisory-worktree-writer-lock.bats — pins the per-worktree writer lock: the PreToolUse acquire arm
# (advisory-worktree-writer-lock.sh) and the SubagentStop release arm (agent-tracker.sh).
#
# ADVISORY ONLY: every row asserts `status -eq 0` alongside the presence/absence of LOCK-ADV-001, so
# a change that promoted contention to a block fails here — which is the point. Promotion is a later
# explicit step, and it must land with these expectations rewritten rather than silently satisfied.
#
# Branches: uncontended acquire · same-holder re-entry · second-writer advisory · a missing agent_id
# contending as the "orchestrator" singleton · TTL reclaim · non-repo write · memory/ exemption ·
# envelope-shape drift · SubagentStop releasing only the stopping agent's lock.
#
# GA_DATA_ROOT sandboxes the lock store into BATS_TEST_TMPDIR; the fake worktrees carry a `.git`
# FILE, the shape a linked worktree actually has.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e` — only the LAST command gates the verdict, so
# every assertion carries `|| return 1`.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-worktree-writer-lock.sh"
TRACKER_SH="${BATS_TEST_DIRNAME}/../agent-tracker.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "advisory-worktree-writer-lock.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  unset WORKTREE_WRITER_LOCK_OFF WORKTREE_LOCK_DIR WORKTREE_LOCK_TTL_SECS ATRIUM_APPLY_LOCK_TTL_SECS
  GA_DATA="${BATS_TEST_TMPDIR}/ga"
  LOCK_ROOT="${GA_DATA}/data/worktree-locks"
  WT="${BATS_TEST_TMPDIR}/wt-one"
  WT2="${BATS_TEST_TMPDIR}/wt-two"
  mkdir -p "${WT}/src" "${WT2}/src"
  printf 'gitdir: /nonexistent/.git/worktrees/wt-one\n' >"${WT}/.git"
  printf 'gitdir: /nonexistent/.git/worktrees/wt-two\n' >"${WT2}/.git"
}

# Independent re-derivation of the lock path — deliberately NOT sourced from the lib, so a change to
# the key transform or the layout has to be made in both places on purpose.
lock_dir_for() {
  local key="${1//_/__}"
  key="${key//\//_s}"
  printf '%s\n' "${LOCK_ROOT}/${key}/.apply-lock"
}

holder_of() {
  cat "$(lock_dir_for "${1}")/holder" 2>/dev/null || printf ''
}

# $1=file_path $2=agent_id (empty → main-session envelope) $3=ttl override (optional)
fire_write() {
  local payload
  payload="$(jq -n --arg p "${1}" --arg a "${2:-}" \
    '{hook_event_name:"PreToolUse", tool_name:"Write", tool_input:{file_path:$p, content:"x"}}
     + (if $a == "" then {} else {agent_id:$a} end)')"
  run bash -c 'printf "%s" "$1" | GA_DATA_ROOT="$2" WORKTREE_LOCK_TTL_SECS="$4" bash "$3" 2>&1' \
    _ "${payload}" "${GA_DATA}" "${HOOK_SH}" "${3:-}"
}

# $1=raw JSON payload
fire_raw() {
  run bash -c 'printf "%s" "$1" | GA_DATA_ROOT="$2" bash "$3" 2>&1' \
    _ "${1}" "${GA_DATA}" "${HOOK_SH}"
}

# $1=agent_id (empty → an envelope with NO agent_id at all) — SubagentStop through the real tracker
# (its PG write is tolerated non-blocking).
fire_stop() {
  local payload
  payload="$(jq -n --arg a "${1}" \
    '{hook_event_name:"SubagentStop", agent_type:"glass-atrium-dev-shell"}
     + (if $a == "" then {} else {agent_id:$a} end)')"
  run bash -c 'printf "%s" "$1" | GA_DATA_ROOT="$2" bash "$3" 2>&1' \
    _ "${payload}" "${GA_DATA}" "${TRACKER_SH}"
}

@test "a first write into a worktree acquires the lock for the writing agent" {
  fire_write "${WT}/src/a.txt" "agent-A"
  [[ "${status}" -eq 0 ]] || {
    echo "acquire must not block (status ${status}): ${output}" >&2
    return 1
  }
  [[ "${output}" != *'LOCK-ADV-001'* ]] || {
    echo "false contention: ${output}" >&2
    return 1
  }
  [[ "$(holder_of "${WT}")" == "agent-A" ]] || {
    echo "holder record missing/wrong: $(holder_of "${WT}")" >&2
    return 1
  }
}

@test "the same agent writing again re-enters its own lock silently" {
  fire_write "${WT}/src/a.txt" "agent-A"
  fire_write "${WT}/src/b.txt" "agent-A"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'LOCK-ADV-001'* ]] || {
    echo "self-contention: ${output}" >&2
    return 1
  }
  [[ "$(holder_of "${WT}")" == "agent-A" ]] || return 1
}

@test "a second agent entering the held worktree warns, names the blind spots, and never blocks" {
  fire_write "${WT}/src/a.txt" "agent-A"
  fire_write "${WT}/src/b.txt" "agent-B"
  [[ "${status}" -eq 0 ]] || {
    echo "advisory must never block (status ${status})" >&2
    return 1
  }
  [[ "${output}" == *'LOCK-ADV-001'* ]] || {
    echo "no advisory in: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"${WT}"* ]] || {
    echo "advisory does not name the worktree: ${output}" >&2
    return 1
  }
  [[ "${output}" == *'Bash-authored writes'* ]] || {
    echo "advisory omits the Bash blind spot: ${output}" >&2
    return 1
  }
  [[ "${output}" == *'SubagentStop'* ]] || {
    echo "advisory omits the missed-Stop blind spot: ${output}" >&2
    return 1
  }
  [[ "$(holder_of "${WT}")" == "agent-A" ]] || {
    echo "the held lock was stolen by the second writer" >&2
    return 1
  }
}

@test "an envelope with no agent_id contends as the orchestrator singleton" {
  fire_write "${WT}/src/a.txt" "agent-A"
  fire_write "${WT}/src/b.txt" ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *'LOCK-ADV-001'* ]] || {
    echo "empty agent_id passed through instead of contending: ${output}" >&2
    return 1
  }
  [[ "${output}" == *'"writer":"orchestrator"'* ]] || {
    echo "empty id not mapped to the singleton: ${output}" >&2
    return 1
  }
}

@test "a lock aged past its TTL is reclaimed by the next writer without warning" {
  fire_write "${WT}/src/a.txt" "agent-A"
  local lock
  lock="$(lock_dir_for "${WT}")"
  [[ -d "${lock}" ]] || return 1
  # 10 minutes back, against a 1-second TTL override — the crashed-holder path.
  touch -t "$(date -v-10M +%Y%m%d%H%M 2>/dev/null || date -d '10 minutes ago' +%Y%m%d%H%M)" "${lock}"
  fire_write "${WT}/src/b.txt" "agent-B" 1
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'LOCK-ADV-001'* ]] || {
    echo "stale lock warned instead of reclaiming: ${output}" >&2
    return 1
  }
  [[ "$(holder_of "${WT}")" == "agent-B" ]] || {
    echo "reclaim did not re-stamp the holder: $(holder_of "${WT}")" >&2
    return 1
  }
}

@test "a write outside any repository takes no lock" {
  mkdir -p "${BATS_TEST_TMPDIR}/loose"
  fire_write "${BATS_TEST_TMPDIR}/loose/notes.txt" "agent-A"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -d "${LOCK_ROOT}" ]] || {
    echo "a non-repo write created a lock store" >&2
    return 1
  }
}

@test "a memory/ checkpoint write is exempt from the lock" {
  mkdir -p "${WT}/memory"
  fire_write "${WT}/memory/progress-task.md" "agent-A"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -d "${LOCK_ROOT}" ]] || {
    echo "the prescribed shared-worktree checkpoint path was locked" >&2
    return 1
  }
}

# The exemption's comment claims alignment with enforce-delegation.sh, which deliberately does NOT
# exempt a "memory" segment nested under a protected harness dir. A bare */memory/* here would have
# exempted all seven and silently contradicted that gate.
@test "a memory/ segment nested under a harness dir is NOT exempt (enforce-delegation parity)" {
  local sub
  for sub in agents rules hooks skills autoagent monitor scripts; do
    rm -rf "${LOCK_ROOT}"
    mkdir -p "${WT}/${sub}/memory"
    fire_write "${WT}/${sub}/memory/note.md" "agent-A"
    [[ "${status}" -eq 0 ]] || {
      echo "${sub}/memory write must not block (status ${status})" >&2
      return 1
    }
    [[ "$(holder_of "${WT}")" == "agent-A" ]] || {
      echo "${sub}/memory was exempted — it must take the lock like any harness write" >&2
      return 1
    }
  done
}

# The two arms compute the holder id independently unless both route through the lib helper: the
# acquire arm stamps an absent agent_id as "orchestrator" while the tracker's own parse had already
# substituted "unknown", so the release looked up a holder that was never stored and the lock sat
# until its 6h TTL, over-warning every other writer in that worktree.
@test "an id-less SubagentStop releases the id-less holder rather than leaving it to the TTL" {
  fire_write "${WT}/src/a.txt" ""
  [[ "$(holder_of "${WT}")" == "orchestrator" ]] || {
    echo "id-less acquire did not stamp the singleton: $(holder_of "${WT}")" >&2
    return 1
  }
  fire_stop ""
  [[ "${status}" -eq 0 ]] || {
    echo "the tracker must stay non-blocking: ${output}" >&2
    return 1
  }
  [[ ! -d "$(lock_dir_for "${WT}")" ]] || {
    echo "the id-less holder's lock survived an id-less SubagentStop — TTL-only regression" >&2
    return 1
  }
}

@test "an unrecognized envelope shape is LOUD (LOCK-ADV-002) and still non-blocking" {
  fire_raw '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":"not-an-object"}'
  [[ "${status}" -eq 0 ]] || {
    echo "drift must stay non-blocking" >&2
    return 1
  }
  [[ "${output}" == *'LOCK-ADV-002'* ]] || {
    echo "silent skip on envelope drift: ${output}" >&2
    return 1
  }
}

@test "SubagentStop releases only the stopping agent's lock" {
  fire_write "${WT}/src/a.txt" "agent-A"
  fire_write "${WT2}/src/a.txt" "agent-B"
  [[ -d "$(lock_dir_for "${WT}")" ]] || return 1
  [[ -d "$(lock_dir_for "${WT2}")" ]] || return 1
  fire_stop "agent-A"
  [[ "${status}" -eq 0 ]] || {
    echo "the tracker must stay non-blocking: ${output}" >&2
    return 1
  }
  [[ ! -d "$(lock_dir_for "${WT}")" ]] || {
    echo "the stopping agent's lock survived: ${output}" >&2
    return 1
  }
  [[ -d "$(lock_dir_for "${WT2}")" ]] || {
    echo "another agent's lock was released" >&2
    return 1
  }
}

# Injectivity of the key transform, end to end. The two roots below collide under the OLD
# `_`->`__` + `/`->`_` scheme (both encoded to a shared `_a___b` tail), which put two unrelated
# worktrees in one lock dir and cross-warned between them — a FALSE POSITIVE, the one failure the
# promotion gate cannot absorb. Asserted through the hook rather than against the transform so the
# row pins the observable behaviour, not the encoding of the day.
@test "distinct worktrees whose paths collided under the old key stay separate" {
  local wt_a="${BATS_TEST_TMPDIR}/a_/b" wt_b="${BATS_TEST_TMPDIR}/a/_b"
  mkdir -p "${wt_a}/src" "${wt_b}/src"
  printf 'gitdir: /nonexistent/.git/worktrees/a\n' >"${wt_a}/.git"
  printf 'gitdir: /nonexistent/.git/worktrees/b\n' >"${wt_b}/.git"

  fire_write "${wt_a}/src/f.txt" "agent-A"
  [[ "${output}" != *'LOCK-ADV-001'* ]] || return 1
  fire_write "${wt_b}/src/f.txt" "agent-B"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'LOCK-ADV-001'* ]] || {
    echo "cross-warn between unrelated worktrees (key collision): ${output}" >&2
    return 1
  }
  [[ "$(lock_dir_for "${wt_a}")" != "$(lock_dir_for "${wt_b}")" ]] || return 1
  [[ "$(holder_of "${wt_a}")" == "agent-A" ]] || return 1
  [[ "$(holder_of "${wt_b}")" == "agent-B" ]]
}
