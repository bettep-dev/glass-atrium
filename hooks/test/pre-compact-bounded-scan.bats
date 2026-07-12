#!/usr/bin/env bats
# pre-compact-bounded-scan.bats — pins the O(1)-fork outcome scan in pre-compact.sh. A naive scan
# fans out UNBOUNDED over the outcomes dir: a `stat` fork PER candidate for the sort, and an `awk`
# fork PER file for the summary (newest-5) AND the correlation scan. The scan now runs a CONSTANT
# number of processes: one `find | xargs stat | sort`, then ONE `awk` pass over the full sorted
# corpus. The summary is windowed to the newest SUMMARY_LIMIT rows; the correlation scan covers the
# FULL corpus by default, with an OPTIONAL operator bound (PRECOMPACT_CORRELATION_LIMIT) that windows
# the active-CID scan ONLY — never the summary.
#
# Four proofs:
#   (a) OUTPUT byte-identical for a small corpus — summary rows + active-correlation lines.
#   (b) PERF-INVARIANT — stat/awk fork count is INDEPENDENT of corpus size (a revert to the per-file
#       form would spawn N stat + ~N awk and fail both the equality and the absolute-bound asserts).
#   (c) FULL correlation coverage by default (an active CID older than the summary window still
#       surfaces) + the operator K windows the correlation scan ONLY, leaving the summary newest-5.
#   (d) EMPTY outcomes dir degrades cleanly ((none) summary + correlation, exit 0).
#
# Method for (b): `stat`/`awk` PATH shims append one byte per invocation to a per-run counter file,
# then exec the REAL binary (absolute path baked in — no recursion). The hook's bare `stat` (via
# xargs execvp) + `awk` resolve through the shim; `find`/`sort`/`head`/`jq`/`cp`/`mv` are unshimmed.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/pre-compact.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "pre-compact.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  REAL_STAT="$(command -v stat)"
  REAL_AWK="$(command -v awk)"
  [[ -n "${REAL_STAT}" && -n "${REAL_AWK}" ]] || skip "stat/awk required"

  PC_TMP="$(mktemp -d -t pre-compact-bounded.XXXXXX)"
  SHIM_DIR="${PC_TMP}/shim"
  mkdir -p "${SHIM_DIR}"
  make_shim stat "${REAL_STAT}" STAT_COUNT_FILE
  make_shim awk "${REAL_AWK}" AWK_COUNT_FILE
}

teardown() {
  [[ -n "${PC_TMP:-}" && -d "${PC_TMP}" ]] && rm -rf -- "${PC_TMP}" || true
}

# A shim that counts invocations (one byte per call, gated on the env var) then execs the real binary.
make_shim() { # name real_bin count_env_var
  local name="$1" real="$2" var="$3"
  {
    printf '#!/bin/sh\n'
    printf '[ -n "${%s:-}" ] && printf x >> "${%s}"\n' "${var}" "${var}"
    printf 'exec %s "$@"\n' "${real}"
  } >"${SHIM_DIR}/${name}"
  chmod +x "${SHIM_DIR}/${name}"
}

# Write one outcome .md with a distinct mtime so the newest-first sort is deterministic.
seed_outcome() { # dir name result cid mtime
  local f="${1}/${2}.md"
  {
    printf -- '---\n'
    printf 'result: %s\n' "${3}"
    [[ -n "${4}" ]] && printf 'correlation_id: %s\n' "${4}"
    printf 'agent: x\n---\n\nbody\n'
  } >"${f}"
  touch -t "${5}" "${f}"
}

# Build a HOME sandbox with an outcomes dir + a transcript; echo the HOME path.
make_home() { # home_root
  local home="${1}"
  mkdir -p "${home}/.claude/data/outcomes"
  printf '{"line":1}\n' >"${home}/transcript.jsonl"
}

# Drive the hook: cwd forced to a clean dir (no ./memory/outcomes leakage), shims on PATH, counters
# routed to the given files. Populates $status / $output via bats `run`.
run_hook() { # home  stat_count_file  awk_count_file  [k]
  local home="${1}" scf="${2}" acf="${3}" k="${4:-}"
  local payload
  payload="$(jq -nc --arg t "${home}/transcript.jsonl" \
    '{session_id:"sesPC", trigger:"auto", transcript_path:$t}')"
  : >"${scf}"
  : >"${acf}"
  run env \
    HOME="${home}" \
    PATH="${SHIM_DIR}:${PATH}" \
    STAT_COUNT_FILE="${scf}" \
    AWK_COUNT_FILE="${acf}" \
    PRECOMPACT_CORRELATION_LIMIT="${k}" \
    bash -c 'cd "$1" && exec bash "$2" <<<"$3"' _ "${home}" "${HOOK_SH}" "${payload}"
}

count_of() { # file -> byte count (one byte per shim invocation)
  local n=0
  [[ -f "${1}" ]] && n="$(wc -c <"${1}")"
  printf '%s\n' "$((n))"
}

# Extract the survival packet from "## Recent outcomes" to EOF (summary + correlation sections).
packet_tail() { # home
  "${REAL_AWK}" '/## Recent outcomes/{p=1} p' "${1}/.claude/compact-backups/"*_survival.md
}

@test "(a) corpus <= K: summary rows + correlation lines byte-identical to the per-file scan" {
  HOME_A="${PC_TMP}/a"
  make_home "${HOME_A}"
  local OUT="${HOME_A}/.claude/data/outcomes"
  # o1 oldest … o4 newest. o3 is done+cid (active-status filter must EXCLUDE it); o1 has no cid.
  seed_outcome "${OUT}" o1 done "" 202607120801
  seed_outcome "${OUT}" o2 needs_context cid-2 202607120802
  seed_outcome "${OUT}" o3 done cid-3 202607120803
  seed_outcome "${OUT}" o4 blocked cid-4 202607120804

  run_hook "${HOME_A}" "${PC_TMP}/sa" "${PC_TMP}/aa"
  [ "${status}" -eq 0 ] || return 1

  local got expected
  got="$(packet_tail "${HOME_A}")"
  expected="$(
    cat <<EOF
## Recent outcomes (newest 5)

| result | path |
|--------|------|
| blocked | ${OUT}/o4.md |
| done | ${OUT}/o3.md |
| needs_context | ${OUT}/o2.md |
| done | ${OUT}/o1.md |

## Active correlation IDs
- cid-4 (status: blocked)
- cid-2 (status: needs_context)
EOF
  )"
  if [[ "${got}" != "${expected}" ]]; then
    printf 'GOT:\n%s\n---\nEXPECTED:\n%s\n' "${got}" "${expected}" >&2
    return 1
  fi
}

@test "(b) perf-invariant: stat/awk fork count is independent of corpus size (no per-file fork)" {
  # Small corpus (3).
  HOME_S="${PC_TMP}/small"
  make_home "${HOME_S}"
  seed_outcome "${HOME_S}/.claude/data/outcomes" s1 done cid-s1 202607120801
  seed_outcome "${HOME_S}/.claude/data/outcomes" s2 blocked cid-s2 202607120802
  seed_outcome "${HOME_S}/.claude/data/outcomes" s3 done cid-s3 202607120803
  run_hook "${HOME_S}" "${PC_TMP}/s_stat" "${PC_TMP}/s_awk"
  [ "${status}" -eq 0 ] || return 1
  local stat_small awk_small
  stat_small="$(count_of "${PC_TMP}/s_stat")"
  awk_small="$(count_of "${PC_TMP}/s_awk")"

  # Bigger corpus (8) — identical non-corpus state (transcript present, fresh backup dir).
  HOME_B="${PC_TMP}/big"
  make_home "${HOME_B}"
  local i
  for i in 1 2 3 4 5 6 7 8; do
    seed_outcome "${HOME_B}/.claude/data/outcomes" "b${i}" done "cid-b${i}" "20260712080${i}"
  done
  run_hook "${HOME_B}" "${PC_TMP}/b_stat" "${PC_TMP}/b_awk"
  [ "${status}" -eq 0 ] || return 1
  local stat_big awk_big
  stat_big="$(count_of "${PC_TMP}/b_stat")"
  awk_big="$(count_of "${PC_TMP}/b_awk")"

  # Invariant: fork count MUST NOT grow with corpus size (per-file would give 3 vs 8 stat).
  [ "${stat_small}" -eq "${stat_big}" ] || {
    printf 'stat forks differ by corpus: small=%s big=%s\n' "${stat_small}" "${stat_big}" >&2
    return 1
  }
  [ "${awk_small}" -eq "${awk_big}" ] || {
    printf 'awk forks differ by corpus: small=%s big=%s\n' "${awk_small}" "${awk_big}" >&2
    return 1
  }
  # Absolute bound: for the 8-file corpus the counts stay well under N (per-file would be >= 8).
  [ "${stat_big}" -lt 8 ] || return 1
  [ "${awk_big}" -lt 8 ] || return 1
}

@test "(c) full correlation coverage by default; operator K windows correlation only, not the summary" {
  HOME_C="${PC_TMP}/c"
  make_home "${HOME_C}"
  local OUT="${HOME_C}/.claude/data/outcomes"
  # 2 OLD active outcomes, then 5 NEWER done — the actives sit BELOW the newest-5 summary window AND
  # below a small correlation window (K=3).
  seed_outcome "${OUT}" old_a blocked cid-old-a 202607120801
  seed_outcome "${OUT}" old_b needs_context cid-old-b 202607120802
  seed_outcome "${OUT}" n1 done "" 202607120901
  seed_outcome "${OUT}" n2 done "" 202607120902
  seed_outcome "${OUT}" n3 done "" 202607120903
  seed_outcome "${OUT}" n4 done "" 202607120904
  seed_outcome "${OUT}" n5 done "" 202607120905

  # Default (unbounded): FULL correlation coverage — both active CIDs surface though they are OLDER
  # than the newest-5 summary window, proving the correlation scan is not summary-bounded.
  run_hook "${HOME_C}" "${PC_TMP}/c_stat1" "${PC_TMP}/c_awk1"
  [ "${status}" -eq 0 ] || return 1
  local full
  full="$(packet_tail "${HOME_C}")"
  [[ "${full}" == *"- cid-old-a (status: blocked)"* ]] || return 1
  [[ "${full}" == *"- cid-old-b (status: needs_context)"* ]] || return 1
  # Summary stays newest-5: header derived from SUMMARY_LIMIT, 5 data rows + 1 header row, old excluded.
  [[ "${full}" == *"## Recent outcomes (newest 5)"* ]] || return 1
  [ "$(printf '%s\n' "${full}" | grep -c '^| ')" -eq 6 ] || return 1
  [[ "${full}" != *"old_a.md"* ]] || return 1
  rm -f "${HOME_C}/.claude/compact-backups/"*_survival.md

  # Operator K=3 (< corpus): the newest 3 are all `done` → the older active CIDs are windowed OUT of
  # the CORRELATION scan (documented operator bound) — NOT a silent full drop.
  run_hook "${HOME_C}" "${PC_TMP}/c_stat2" "${PC_TMP}/c_awk2" 3
  [ "${status}" -eq 0 ] || return 1
  local bounded
  bounded="$(packet_tail "${HOME_C}")"
  [[ "${bounded}" == *"## Active correlation IDs"* ]] || return 1
  [[ "${bounded}" != *"cid-old-a"* ]] || return 1
  [[ "${bounded}" != *"cid-old-b"* ]] || return 1
  [[ "${bounded}" == *"- (none)"* ]] || return 1
  # DECOUPLING: a small correlation K MUST NOT truncate the summary — still newest-5, header unchanged.
  [[ "${bounded}" == *"## Recent outcomes (newest 5)"* ]] || return 1
  [ "$(printf '%s\n' "${bounded}" | grep -c '^| ')" -eq 6 ] || return 1
}

@test "(d) empty outcomes dir degrades cleanly: (none) summary + correlation, exit 0" {
  HOME_D="${PC_TMP}/d"
  make_home "${HOME_D}" # creates an EMPTY .claude/data/outcomes
  run_hook "${HOME_D}" "${PC_TMP}/d_stat" "${PC_TMP}/d_awk"
  [ "${status}" -eq 0 ] || return 1
  local pkt
  pkt="$(packet_tail "${HOME_D}")"
  [[ "${pkt}" == *"## Recent outcomes (newest 5)"* ]] || return 1
  [[ "${pkt}" == *"| (none) | - |"* ]] || return 1
  [[ "${pkt}" == *"## Active correlation IDs"* ]] || return 1
  [[ "${pkt}" == *"- (none)"* ]] || return 1
}
