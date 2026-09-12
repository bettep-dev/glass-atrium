#!/usr/bin/env bats
# inject-scope-chunker.bats — the membership selector, the UTF-16 chunker and the shared
# slot library of the split SubagentStart scope-rule channel.
#
#   The channel replaces a single ceilinged injection with twelve bound slots: slot 1 keeps the
#   marker blocks, inject-scope-part-01.sh .. -11.sh carry parts 01..11. Every part must read
#   correctly ALONE (hook outputs arrive in completion order), must stay at or under the engine's
#   inclusive 10,000 UTF-16-unit cap WITH its wrapper, and must never shed silently.
#
#   WHICH CHANNELS A FAULT ACTUALLY REACHES (measured 2026-09-13, not assumed — an earlier
#   header claimed three channels for all four core tokens, which is true only per-token and
#   not per-part):
#     * the four CORE tokens (OVERSIZE / OVERFLOW / MISSINGSOURCE / NOMEMBERSHIP) each reach
#       stderr AND the sink AND an in-context marker naming a Read-able path;
#     * but not all on the SAME part — part 1 owns the warning channel (every slot computes
#       the same plan, so letting each warn would multiply one fault by the slot count), while
#       the OVERFLOW marker rides the LAST kept part. A probe of part 2 alone sees the marker
#       and neither the stderr line nor the sink row;
#     * SEAMFAULT (the shell seam) and the core's pre-emit suppression backstop reach stderr
#       and the sink ONLY — the seam has no rendered context to write into, and the backstop is
#       suppressing the very context a marker would ride.
#
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` is inert on bash
#   3.2.57 but GATES on CI's bash 5.3.9. Every assertion below is a helper that `return 1`s
#   on mismatch, so each one independently fails on both legs.

# `run --separate-stderr` keeps the core's JSON stdout parseable while the warning channel stays
# assertable on its own.
bats_require_minimum_version 1.5.0

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
CORE="${HOOKS_DIR}/lib/inject_chunk.py"
LIB="${HOOKS_DIR}/lib/inject-chunk.sh"
CAP=10000

setup() {
  # A vanished pin target is the most complete form of the drift this suite catches, and a
  # `skip` scores as ok — so an absent shipped file FAILS rather than going quiet.
  [[ -f "${CORE}" ]] || {
    printf 'chunker core absent: %s — the repository always ships it\n' "${CORE}" >&2
    return 1
  }
  [[ -f "${LIB}" ]] || {
    printf 'chunker library absent: %s — the repository always ships it\n' "${LIB}" >&2
    return 1
  }
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  ROOT="${BATS_TEST_TMPDIR}/root"
  SINK="${BATS_TEST_TMPDIR}/chunk.diag.log"
  mkdir -p "${ROOT}/scoped"
}

# Run the core against the fixture root. Args: the core's own flags.
run_core() {
  run --separate-stderr env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" \
    GA_CHUNK_SLOTS="${SLOTS_OVERRIDE:-11}" \
    python3 "${CORE}" "$@"
}

# The warning channel is stderr AND the sink AND an in-context marker; `run` merges stderr
# into $output, so stdout is kept parseable by asserting the stderr leg from its own log.
assert_err() {
  [[ "${stderr}" == *"${1}"* ]] || {
    printf 'expected stderr to carry %s\nGOT: %s\n' "${1}" "${stderr}" >&2
    return 1
  }
}

# Write a fixture rule file of N `##` sections, each padded to roughly $2 units.
mk_file() {
  local path="${ROOT}/scoped/${1}" count="${2}" size="${3}"
  python3 - "${path}" "${count}" "${size}" <<'PY'
import sys
path, count, size = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
out = ["# fixture\n"]
for i in range(count):
    out.append("## Section %02d\n\n%s\n" % (i, ("body line for section %02d. " % i) * max(1, size // 30)))
open(path, "w", encoding="utf-8").write("\n".join(out))
PY
}

# Write a registry with one agent. Args: $1=agent $2=json rules block
mk_registry() {
  printf '{"agents": {"%s": {"rules": %s}}}\n' "${1}" "${2}" >"${ROOT}/agent-registry.json"
}

json_field() {
  python3 -c 'import sys,json;print(json.load(sys.stdin)[sys.argv[1]])' "${1}"
}

ctx_of() {
  python3 -c 'import sys,json;print(json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"])'
}

u16_of() {
  python3 -c 'import sys;print(len(sys.stdin.read().rstrip("\n").encode("utf-16-le"))//2)'
}

assert_ok() {
  [[ "${status}" -eq 0 ]] || {
    printf 'expected exit 0, got %s: %s\n' "${status}" "${output}" >&2
    return 1
  }
}

assert_has() {
  [[ "${output}" == *"${1}"* ]] || {
    printf 'expected output to carry %s\nGOT: %s\n' "${1}" "${output:0:600}" >&2
    return 1
  }
}

assert_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    printf 'expected output NOT to carry %s\n' "${1}" >&2
    return 1
  }
}

assert_eq() {
  [[ "${1}" == "${2}" ]] || {
    printf 'expected %s, got %s (%s)\n' "${2}" "${1}" "${3:-}" >&2
    return 1
  }
}

# --- selection ---------------------------------------------------------------

@test "T-SEL-1: selection is registry-driven, in declared order, scoped/ members only" {
  mk_file a.md 2 200
  mk_file b.md 2 200
  mk_registry ag '{"scope":"scoped/a.md","shared":["rules/glass-atrium/core-security.md","scoped/b.md"],"conditional":[]}'
  run_core --agent ag --part 1
  assert_ok
  local ctx
  ctx="$(printf '%s' "${output}" | ctx_of)"
  [[ "${ctx}" == *"scoped/a.md"* && "${ctx}" == *"scoped/b.md"* ]] || {
    printf 'both scoped members expected in part 01: %s\n' "${ctx:0:400}" >&2
    return 1
  }
  # A rules/glass-atrium/ member already arrives on the host project-instructions channel;
  # selecting it here would deliver it twice.
  [[ "${ctx}" != *"core-security.md"* ]] || {
    printf 'rules/glass-atrium/ member must not be selected\n' >&2
    return 1
  }
  local a_at b_at
  a_at="$(printf '%s' "${ctx}" | grep -n 'scoped/a.md' | head -1 | cut -d: -f1)"
  b_at="$(printf '%s' "${ctx}" | grep -n 'scoped/b.md' | head -1 | cut -d: -f1)"
  [[ "${a_at}" -lt "${b_at}" ]] || {
    printf 'declared order not preserved (a@%s b@%s)\n' "${a_at}" "${b_at}" >&2
    return 1
  }
}

@test "T-SEL-2: an agent with no rules block warns NOMEMBERSHIP and is never silent-empty" {
  printf '{"agents": {"ag": {}}}\n' >"${ROOT}/agent-registry.json"
  run_core --agent ag --part 1
  assert_ok
  assert_has "no membership is recorded"
  grep -q 'NOMEMBERSHIP agent=ag' "${SINK}" || {
    printf 'NOMEMBERSHIP sink row absent\n' >&2
    return 1
  }
}

# --- the cap -----------------------------------------------------------------

@test "T-CAP-1: every part of every registry agent is at or under the cap, wrapper included" {
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  run env GA_CHUNK_RULES_ROOT="${REPO_ROOT}" GA_CHUNK_SINK="${SINK}" python3 - "${CORE}" "${CAP}" <<'PY'
import json, subprocess, sys, os
core, cap = sys.argv[1], int(sys.argv[2])
root = os.environ["GA_CHUNK_RULES_ROOT"]
agents = sorted(json.load(open(os.path.join(root, "agent-registry.json")))["agents"])
bad = []
for agent in agents:
    out = subprocess.run([sys.executable, core, "--agent", agent, "--plan"],
                         capture_output=True, text=True).stdout
    plan = json.loads(out)
    for index, units in enumerate(plan["units"], start=1):
        if units > cap:
            bad.append("%s part %d = %d" % (agent, index, units))
print("AGENTS=%d" % len(agents))
print("BAD=%s" % (";".join(bad) or "none"))
PY
  assert_ok
  assert_has "AGENTS=23"
  assert_has "BAD=none"
}

@test "T-CAP-2: a part sized to exactly the cap is emitted, not rejected" {
  mk_file a.md 1 40
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  run_core --agent ag --plan
  assert_ok
  local units
  units="$(printf '%s' "${output}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["units"][0])')"
  # Re-drive with the cap pinned to the measured size: an INCLUSIVE cap must still emit.
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" GA_CHUNK_MAX_UNITS="${units}" \
    GA_CHUNK_RESERVE=0 python3 "${CORE}" --agent ag --part 1
  assert_ok
  assert_has "additionalContext"
}

# --- multibyte ---------------------------------------------------------------

@test "T-U16-1: counting is UTF-16 units, and an astral character counts two" {
  python3 - "${ROOT}/scoped/a.md" <<'PY'
import sys
# One astral character per line: 4 UTF-8 bytes, 2 UTF-16 units — the case len(str) gets wrong.
body = "\n".join(["\U0001F600 · → — line %d" % i for i in range(400)])
open(sys.argv[1], "w", encoding="utf-8").write("# fixture\n\n## Multibyte\n\n" + body + "\n")
PY
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  run_core --agent ag --part 1
  assert_ok
  local ctx units bytes
  ctx="$(printf '%s' "${output}" | ctx_of)"
  units="$(printf '%s' "${ctx}" | u16_of)"
  bytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ "${units}" -le "${CAP}" ]] || {
    printf 'part exceeds the cap in units: %s\n' "${units}" >&2
    return 1
  }
  # The whole point of unit counting: the byte budget is conservative for this corpus, so a
  # byte-counted part of the same text would have been cut short of the real capacity.
  [[ "${bytes}" -gt "${units}" ]] || {
    printf 'expected bytes (%s) > units (%s) on a multibyte fixture\n' "${bytes}" "${units}" >&2
    return 1
  }
  # A JSON surrogate pair is the two-unit property made observable on the wire.
  assert_has '\ud83d\ude00'
  printf '%s' "${ctx}" | grep -q "$(printf '\xf0\x9f\x98\x80')" || {
    printf 'the astral character did not survive into the part\n' >&2
    return 1
  }
}

# --- cannot fit --------------------------------------------------------------

@test "T-CF-1: a section that cannot fit one part is excluded, named in part 01, and warned" {
  mk_file a.md 1 30000
  mk_file b.md 2 200
  mk_registry ag '{"scope":"scoped/a.md","shared":["scoped/b.md"],"conditional":[]}'
  run_core --agent ag --part 1
  assert_ok
  assert_has "exceeds one part"
  assert_has "Section 00"
  # The rest of the membership still lands: loud-and-degrade, never all-or-nothing.
  assert_has "scoped/b.md"
  grep -q "OVERSIZE agent=ag" "${SINK}" || {
    printf 'OVERSIZE sink row absent\n' >&2
    return 1
  }
  run_core --agent ag --plan
  assert_ok
  assert_has "OVERSIZE"
  assert_err "OVERSIZE"
}

@test "T-CF-2: an oversize H2 that splits at H3 is split, not warned" {
  python3 - "${ROOT}/scoped/a.md" <<'PY'
import sys
parts = ["# fixture\n", "## Big\n"]
for i in range(6):
    parts.append("### Sub %02d\n\n%s\n" % (i, ("filler for sub %02d. " % i) * 120))
open(sys.argv[1], "w", encoding="utf-8").write("\n".join(parts))
PY
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  run_core --agent ag --plan
  assert_ok
  assert_lacks "OVERSIZE"
  run_core --agent ag --part 1
  assert_ok
  assert_has "### Sub 00"
}

# --- overflow ----------------------------------------------------------------

@test "T-OVF-1: a chunk count above the slot count fills every slot and names the remainder" {
  mk_file a.md 60 4000
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  SLOTS_OVERRIDE=3
  run_core --agent ag --plan
  assert_ok
  local parts chunks
  parts="$(printf '%s' "${output}" | json_field parts)"
  chunks="$(printf '%s' "${output}" | json_field chunks)"
  assert_eq "${parts}" "3" "emitted parts must equal the slot count"
  [[ "${chunks}" -gt 3 ]] || {
    printf 'fixture did not overflow: chunks=%s\n' "${chunks}" >&2
    return 1
  }
  assert_has "OVERFLOW"
  assert_err "OVERFLOW"
  grep -q "OVERFLOW agent=ag" "${SINK}" || {
    printf 'OVERFLOW sink row absent\n' >&2
    return 1
  }
  # The last slot names what it could not carry, and stays under the cap with the marker in.
  run_core --agent ag --part 3
  assert_ok
  assert_has "beyond the 3 available parts"
  local units
  units="$(printf '%s' "${output}" | ctx_of | u16_of)"
  [[ "${units}" -le "${CAP}" ]] || {
    printf 'overflow marker pushed the last part over the cap: %s\n' "${units}" >&2
    return 1
  }
}

@test "T-OVF-2: a slot above the part count emits nothing at all" {
  mk_file a.md 2 200
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  run_core --agent ag --part 7
  assert_ok
  assert_eq "${output}" "" "a surplus slot must emit no JSON and no empty additionalContext"
}

# --- missing member ----------------------------------------------------------

@test "T-MISS-1: a member absent on this install degrades loudly and delivers the rest" {
  mk_file b.md 2 200
  mk_registry ag '{"scope":"scoped/absent.md","shared":["scoped/b.md"],"conditional":[]}'
  run_core --agent ag --part 1
  assert_ok
  assert_has "member file absent"
  assert_has "scoped/absent.md"
  assert_has "scoped/b.md"
  grep -q "MISSINGSOURCE agent=ag" "${SINK}" || {
    printf 'MISSINGSOURCE sink row absent\n' >&2
    return 1
  }
}

# --- read-alone, determinism, pointers ---------------------------------------

@test "T-SELF-1: every part carries the part header, the order-independence sentence and a band path" {
  mk_file a.md 20 2000
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  run_core --agent ag --plan
  assert_ok
  local parts
  parts="$(printf '%s' "${output}" | json_field parts)"
  [[ "${parts}" -ge 3 ]] || {
    printf 'fixture must produce several parts, got %s\n' "${parts}" >&2
    return 1
  }
  local i ctx
  for ((i = 1; i <= parts; i++)); do
    run_core --agent ag --part "${i}"
    assert_ok
    ctx="$(printf '%s' "${output}" | ctx_of)"
    [[ "${ctx}" == *"auto-injected at spawn for ag"* ]] || {
      printf 'part %s lacks its header\n' "${i}" >&2
      return 1
    }
    [[ "${ctx}" == *"Parts arrive in ANY order"* ]] || {
      printf 'part %s lacks the order-independence sentence\n' "${i}" >&2
      return 1
    }
    [[ "${ctx}" == *"${ROOT}/scoped/a.md"* ]] || {
      printf 'part %s lacks an absolute band path\n' "${i}" >&2
      return 1
    }
  done
}

@test "T-DET-1: a slot run alone produces the same part as the same slot of a full run" {
  mk_file a.md 20 2000
  mk_file b.md 10 2000
  mk_registry ag '{"scope":"scoped/a.md","shared":["scoped/b.md"],"conditional":[]}'
  run_core --agent ag --part 3
  assert_ok
  local first="${output}"
  run_core --agent ag --part 3
  assert_ok
  assert_eq "${output}" "${first}" "two independent runs must agree byte for byte"
}

@test "T-COND-1: conditional members are pointers in part 01 only, never bodies" {
  mk_file a.md 20 2000
  printf '# hook fixture\n\n## Hook Capability Contract\n\nbody\n' >"${ROOT}/scoped/hook.md"
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[{"file":"scoped/hook.md","when":"the task writes a hook"},{"file":"rules/glass-atrium/shared-self-improve-hygiene.md","when":"the change touches autoagent"}]}'
  run_core --agent ag --part 1
  assert_ok
  assert_has "the task writes a hook"
  assert_has "scoped/hook.md"
  # The pointer carries no body, and a rules/glass-atrium/ conditional is host-delivered.
  assert_lacks "Hook Capability Contract"
  assert_lacks "shared-self-improve-hygiene"
  run_core --agent ag --part 2
  assert_ok
  assert_lacks "the task writes a hook"
}

@test "T-EVT-1: the warning-token set has one definition, and the sink writes those tokens" {
  run env GA_CHUNK_RULES_ROOT="${ROOT}" python3 "${CORE}" --print-events
  assert_ok
  assert_has "OVERSIZE"
  assert_has "OVERFLOW"
  assert_has "MISSINGSOURCE"
  assert_has "NOMEMBERSHIP"
  assert_has "SEAMFAULT"
  # No token carries the word the drop-rate aggregation greps for, so an OVERSIZE or an
  # OVERFLOW can never inflate that numerator.
  assert_lacks " DROP "
  # SEAMFAULT is raised by the shell seam, which cannot import the core's constant (a missing
  # python3 is one of the states it raises in). The seam therefore mirrors the literal — so the
  # mirror is cross-read HERE against the definition above, and the two cannot drift silently.
  grep -q 'GA_CHUNK_SEAM_EVENT="SEAMFAULT"' "${LIB}" || {
    printf 'the seam does not mirror the SEAMFAULT token defined by the core\n' >&2
    return 1
  }
}

# --- the packing allowance ---------------------------------------------------
#
# The allowance decides which H2 sections get re-split at H3, so it is the one number that decides
# what a part can open with. It is asked of the producer's own get_allowance here: a fixture that
# recomputed it would agree only with itself, which is how it drifted in the first place.

# Ask the core for its allowance and budget against the fixture root. Args: $1=agent $2=member
# $3=index width · stdout: `<allowance> <budget>`.
core_allowance() {
  GA_CHUNK_RULES_ROOT="${ROOT}" python3 - "${CORE}" "${1}" "${2}" "${3}" <<'PY'
import sys
sys.path.insert(0, sys.argv[1].rsplit("/", 1)[0])
import inject_chunk as core
cfg = core.Config()
print("%d %d" % (core.get_allowance(cfg, sys.argv[2], [sys.argv[3]], int(sys.argv[4])), cfg.budget))
PY
}

@test "T-ALW-1: an atom at exactly the allowance renders inside the BUDGET, not into the reserve" {
  # pack() opens a part with the header and then charges TWO "\n\n" joins before the first atom —
  # one ahead of the band lead, one ahead of the atom. An allowance short by one join admits an
  # atom two units too large, and the part it opens is over budget by those two units. Nothing
  # breaks, because CHUNK_RESERVE absorbs them: that reserve is defensive slack against a later
  # wrapper growing the envelope the engine counts, so leaning on it here spends it in advance.
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  printf '# fixture\n' >"${ROOT}/scoped/a.md"
  local pair allowance budget rendered
  pair="$(core_allowance ag scoped/a.md 2)"
  allowance="${pair%% *}"
  budget="${pair##* }"
  [[ "${allowance}" -gt 0 && "${budget}" -gt 0 ]] || {
    printf 'the core reported no allowance/budget: %s\n' "${pair}" >&2
    return 1
  }
  # One H2 section measuring EXACTLY the allowance, so it is admitted unsplit and opens part 01.
  python3 - "${ROOT}/scoped/a.md" "${allowance}" <<'PY'
import sys
path, allowance = sys.argv[1], int(sys.argv[2])
head = "## Exactly one allowance\n"
pad = allowance - len(head.encode("utf-16-le")) // 2
open(path, "w", encoding="utf-8").write(head + ("x" * pad))
PY
  run_core --agent ag --part 1
  assert_ok
  rendered="$(printf '%s' "${output}" | ctx_of | u16_of)"
  [[ "${rendered}" -le "${budget}" ]] || {
    printf 'a part opened by an allowance-sized atom measures %s units, over the %s-unit budget — the allowance is spending CHUNK_RESERVE\n' \
      "${rendered}" "${budget}" >&2
    return 1
  }
  # and it must actually carry the section, or the row passes by delivering nothing
  assert_has "Exactly one allowance"
}

@test "T-ALW-2: the allowance charges the index width, so a wider index costs allowance" {
  # build_header zfills both indices, so a width-3 header is two units larger than a width-2 one.
  # An allowance computed at a fixed width is that much too generous for any agent that packs into
  # 100 parts or more — the same class of quiet overspend as the missing join, reached by a corpus
  # rather than by an edit.
  mk_file a.md 4 400
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  local narrow wide
  narrow="$(core_allowance ag scoped/a.md 2)"
  wide="$(core_allowance ag scoped/a.md 3)"
  assert_eq "$((${narrow%% *} - ${wide%% *}))" "2" "a wider index must cost the allowance exactly two units"
}

# --- the shipped wrappers ----------------------------------------------------

@test "T-SLOT-1: the wrappers present are one contiguous set matching the core's slot count" {
  # The wrappers, the binding rows and the core's constant are three independent declarations of
  # the same number, and only this row compares the first to the third. A gap in the sequence is
  # the quiet failure: nine wrappers numbered 01..08 and 10 leave part 09 addressed to nothing,
  # and every surviving part still reads correctly alone, so no agent can notice.
  local slots present_count n expected
  slots="$(python3 -c 'import sys;sys.path.insert(0,sys.argv[1]);import inject_chunk;print(inject_chunk.CHUNK_SLOTS)' "${HOOKS_DIR}/lib")"
  [[ "${slots}" -gt 0 ]] || {
    printf 'the core reports no slot count\n' >&2
    return 1
  }
  present_count=0
  for n in "${HOOKS_DIR}"/inject-scope-part-[0-9][0-9].sh; do
    [[ -f "${n}" ]] || continue
    present_count=$((present_count + 1))
    [[ -x "${n}" ]] || {
      printf 'wrapper not executable: %s — a bound command that is not executable never runs\n' "${n}" >&2
      return 1
    }
  done
  assert_eq "${present_count}" "${slots}" "wrappers present must equal the core's CHUNK_SLOTS"
  # contiguity: every index from 01 to CHUNK_SLOTS is present, so no part is addressed to a gap
  for ((n = 1; n <= slots; n++)); do
    expected="$(printf '%s/inject-scope-part-%02d.sh' "${HOOKS_DIR}" "${n}")"
    [[ -f "${expected}" ]] || {
      printf 'missing wrapper for part %02d: %s\n' "${n}" "${expected}" >&2
      return 1
    }
  done
}

@test "T-SLOT-2: each shipped wrapper resolves its OWN part from its own basename" {
  # The derivation is the producer's own ga_chunk_part, asked of each real file. A wrapper whose
  # basename stopped matching its binding would resolve to a different part — or to none — and
  # deliver another slot's content under this slot's binding.
  local file base want got
  for file in "${HOOKS_DIR}"/inject-scope-part-[0-9][0-9].sh; do
    [[ -f "${file}" ]] || continue
    base="${file##*/}"
    want="${base#inject-scope-part-}"
    want="${want%.sh}"
    got="$(GA_CHUNK_PART= bash -c 'source "$1"; ga_chunk_part "$2"' _ "${LIB}" "${file}")"
    assert_eq "${got}" "${want}" "wrapper ${base} resolved the wrong part"
  done
}

# --- the slot library seam ---------------------------------------------------

@test "T-SEAM-1: a wrapper's basename resolves its part, and an empty envelope emits nothing" {
  mk_file a.md 20 2000
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  local wrapper="${BATS_TEST_TMPDIR}/inject-scope-part-02.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -Eeuo pipefail\n'
    printf 'IFS=$%s\n' "'\\n\\t'"
    printf 'source "%s"\n' "${LIB}"
    printf 'ga_chunk_inject\n'
  } >"${wrapper}"
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" \
    bash "${wrapper}" <<<'{"agent_type":"ag"}'
  assert_ok
  assert_has "part 02 of"
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" bash "${wrapper}" <<<''
  assert_ok
  assert_eq "${output}" "" "an empty envelope must emit nothing"
}

# T-SEAM-2 pins the durable half of the seam's fail-open. The engine DISCARDS SubagentStart hook
# stderr, so a stderr-only abort is indistinguishable from a healthy spawn afterwards: an install
# missing python3 would hand every agent zero scope-rule bodies and leave nothing to find. Each
# abort must therefore land on the core's own sink, the same place a core fault lands.

@test "T-SEAM-2: a seam abort lands on the sink, not stderr alone" {
  mk_file a.md 4 500
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  local wrapper="${BATS_TEST_TMPDIR}/inject-scope-part-04.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -Eeuo pipefail\n'
    printf 'IFS=$%s\n' "'\\n\\t'"
    printf 'source "%s"\n' "${LIB}"
    printf 'ga_chunk_inject\n'
  } >"${wrapper}"

  # (a) core absent — the abort a partial install produces.
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" \
    GA_CHUNK_CORE="${BATS_TEST_TMPDIR}/no-such-core.py" \
    bash "${wrapper}" <<<'{"agent_type":"ag"}'
  assert_ok
  assert_eq "$(grep -c ' SEAMFAULT ' "${SINK}" || true)" "1" "core-absent abort wrote no sink row"
  grep -q 'core absent' "${SINK}" || {
    printf 'the sink row does not name the core-absent cause: %s\n' "$(cat "${SINK}")" >&2
    return 1
  }

  # (b) python3 unreachable — the abort a live install without the interpreter produces. The PATH is
  #     narrowed to a dir holding every tool the seam uses and NOT python3. The narrowing is no
  #     longer load-bearing (T-SEAM-3 drives the same abort on an EMPTY PATH), but it is kept as the
  #     realistic shape: an install missing only the interpreter, with the rest of userland intact.
  local nopybin="${BATS_TEST_TMPDIR}/nopybin" tool
  mkdir -p "${nopybin}"
  for tool in bash tr wc date mkdir rm cat grep sed; do
    ln -sf "$(command -v "${tool}")" "${nopybin}/${tool}"
  done
  command -v python3 >/dev/null 2>&1 && [[ ! -e "${nopybin}/python3" ]] || {
    printf 'the narrowed PATH would still resolve python3\n' >&2
    return 1
  }
  run env PATH="${nopybin}" GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" \
    bash "${wrapper}" <<<'{"agent_type":"ag"}'
  assert_ok
  grep -q 'python3 not on PATH' "${SINK}" || {
    printf 'the sink carries no python3-missing row: %s\n' "$(cat "${SINK}")" >&2
    return 1
  }

  # (c) part underivable — a wrapper whose basename carries no digits.
  local nodigits="${BATS_TEST_TMPDIR}/inject-scope-part-none.sh"
  cp "${wrapper}" "${nodigits}"
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" GA_CHUNK_PART="" \
    bash "${nodigits}" <<<'{"agent_type":"ag"}'
  assert_ok
  grep -q 'part index underivable' "${SINK}" || {
    printf 'the sink carries no underivable-part row: %s\n' "$(cat "${SINK}")" >&2
    return 1
  }

  # The seam's token can never inflate the injector drop-rate aggregation, which greps ' DROP '.
  ! grep -q ' DROP ' "${SINK}" || {
    printf 'a seam row carries the DROP aggregation token: %s\n' "$(cat "${SINK}")" >&2
    return 1
  }
}

@test "T-SEAM-4: an unhandled core fault reaches the sink and the seam records the exit status" {
  # An empty core stdout is the SANCTIONED no-op for a slot above the agent's part count, so a
  # fault that only wrote stderr — a channel the engine discards — was indistinguishable from a
  # healthy quiet slot. Both halves are asserted: the core's own durable row, and the seam's row
  # for the case where the core cannot write one.
  mk_file a.md 4 500
  # A registry whose top level is a LIST is a REAL unhandled path through the shipped core
  # (`data.get` on a list), not an injected raise — so the handler under test is the shipped one.
  printf '[]\n' >"${ROOT}/agent-registry.json"
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${SINK}" \
    python3 "${CORE}" --agent ag --part 1
  [[ "${status}" -ne 0 ]] || {
    printf 'an unhandled core fault exited 0 — the seam cannot tell it from a quiet slot\n' >&2
    return 1
  }
  grep -q ' INTERNAL agent=ag ' "${SINK}" || {
    printf 'the core fault left no INTERNAL sink row: %s\n' "$(cat "${SINK}" 2>&1)" >&2
    return 1
  }

  # The seam leg: a core that exits non-zero writing NOTHING anywhere (a signal, an
  # interpreter-level abort) still leaves the slot's own row, and the slot itself stays exit 0.
  local stub="${BATS_TEST_TMPDIR}/faulting-core.py" wrapper="${BATS_TEST_TMPDIR}/inject-scope-part-06.sh"
  printf 'import sys\nsys.exit(70)\n' >"${stub}"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -Eeuo pipefail\n'
    printf 'IFS=$%s\n' "'\\n\\t'"
    printf 'source "%s"\n' "${LIB}"
    printf 'ga_chunk_inject\n'
  } >"${wrapper}"
  local seam_sink="${BATS_TEST_TMPDIR}/seam-core-exit.log"
  run env GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${seam_sink}" GA_CHUNK_CORE="${stub}" \
    bash "${wrapper}" <<<'{"agent_type":"ag"}'
  assert_ok
  grep -q 'core exited 70 (part=06)' "${seam_sink}" || {
    printf 'the seam discarded the core exit status: %s\n' "$(cat "${seam_sink}" 2>&1)" >&2
    return 1
  }
  # Neither row may inflate the injector drop-rate aggregation, which greps ' DROP '.
  ! grep -q ' DROP ' "${SINK}" "${seam_sink}" || {
    printf 'a fault row carries the DROP aggregation token\n' >&2
    return 1
  }
}

@test "T-SEAM-3: an EMPTY PATH still records the abort, so no external stands before the guard" {
  # The abort that most needs a durable row is the one where the least is reachable. Before the
  # part index was derived in-shell, the seam ran `tr -cd` BEFORE its python3 guard, so an empty
  # PATH failed that pipeline under `set -Eeuo pipefail` and the wrapper exited with no row at all
  # — fail-open, but fail-silent, which is the state this sink exists to remove. Every external the
  # seam still uses sits behind a `|| true` or a `[[ -d ]]` test, so the append survives.
  mk_file a.md 4 500
  mk_registry ag '{"scope":"scoped/a.md","shared":[],"conditional":[]}'
  local wrapper="${BATS_TEST_TMPDIR}/inject-scope-part-05.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -Eeuo pipefail\n'
    printf 'IFS=$%s\n' "'\\n\\t'"
    printf 'source "%s"\n' "${LIB}"
    printf 'ga_chunk_inject\n'
  } >"${wrapper}"
  # The sink's directory is pre-created, since mkdir is one of the externals an empty PATH removes.
  local sink="${BATS_TEST_TMPDIR}/emptypath/chunk.diag.log"
  mkdir -p "${sink%/*}"
  # bash is invoked by ABSOLUTE path: with PATH emptied, env(1) cannot resolve the interpreter
  # itself, which would test env's lookup rather than the seam's.
  local bash_bin
  bash_bin="$(command -v bash)"
  run env PATH= GA_CHUNK_RULES_ROOT="${ROOT}" GA_CHUNK_SINK="${sink}" \
    "${bash_bin}" "${wrapper}" <<<'{"agent_type":"ag"}'
  assert_ok
  grep -q 'python3 not on PATH' "${sink}" || {
    printf 'an empty PATH left no sink row at all: %s\n' "$(cat "${sink}" 2>&1)" >&2
    return 1
  }
  # The row must still name the part, or an operator cannot tell which slot went quiet. The
  # zero-padded form is the wrapper's own basename digits: only the core's argument is decimal-
  # normalised, so `08` and `09` cannot be read as octal.
  grep -q 'part=05' "${sink}" || {
    printf 'the row does not name the part: %s\n' "$(cat "${sink}")" >&2
    return 1
  }
}
