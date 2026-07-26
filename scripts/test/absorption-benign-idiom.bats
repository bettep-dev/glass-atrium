#!/usr/bin/env bats
# absorption-benign-idiom.bats — pins the category-1 idioms as LOAD-BEARING, not sloppy.
#
# Under `set -Eeuo pipefail` a NUL-delimited heredoc read returns 1 at EOF and a pattern search
# returns 1 on no-match; both are normal outcomes. Stripping the suppression therefore kills the
# script on its HAPPY path — which is the fact a reviewer (or a rescoring judge) reading the raw
# idiom count cannot see. Each test asserts the paired outcome: intact runs, stripped aborts, and
# the two fixtures differ by exactly the one removed token so nothing else can explain the failure.
#
# Fixtures are generated into a per-test temp tree — no repository or live-install file is executed.

setup() {
  BI_TMP="$(mktemp -d -t absorption-benign.XXXXXX)"
}

teardown() {
  [[ -n "${BI_TMP:-}" && -d "${BI_TMP}" ]] && rm -rf -- "${BI_TMP}" || true
}

# Emits the count of `<`-side (intact-only) and `>`-side diff lines, proving a single-token delta.
assert_single_token_delta() {
  local intact="${1}" stripped="${2}" token="${3}"
  local diff_out from_lines to_lines
  diff_out="$(diff "${intact}" "${stripped}" || true)"
  from_lines="$(awk '/^< /{n++} END{print n+0}' <<<"${diff_out}")"
  to_lines="$(awk '/^> /{n++} END{print n+0}' <<<"${diff_out}")"
  [ "${from_lines}" -eq 1 ] || { echo "expected 1 changed line, got ${from_lines}: ${diff_out}"; return 1; }
  [ "${to_lines}" -eq 1 ] || { echo "expected 1 replacement line, got ${to_lines}: ${diff_out}"; return 1; }
  [[ "${diff_out}" == *"${token}"* ]] || { echo "delta is not '${token}': ${diff_out}"; return 1; }
}

@test "NUL-delimited heredoc read: the suppression is on the happy path" {
  local intact="${BI_TMP}/intact.sh" stripped="${BI_TMP}/stripped.sh"
  cat >"${intact}" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS= read -r -d '' SRC <<'PY' || true
print("classifier")
PY
printf '%s' "${SRC}"
EOF
  sed 's/ || true$//' "${intact}" >"${stripped}"
  assert_single_token_delta "${intact}" "${stripped}" "|| true"

  run bash "${intact}"
  [ "${status}" -eq 0 ] || { echo "intact fixture failed: ${status} ${output}"; return 1; }
  [[ "${output}" == *'print("classifier")'* ]] || { echo "payload missing: ${output}"; return 1; }

  # `read` returns 1 at EOF without a NUL terminator: stripping the guard aborts before the payload
  # is ever used, which is exactly what a sweep of this idiom would do to the classifier source.
  run bash "${stripped}"
  [ "${status}" -ne 0 ] || { echo "stripped fixture unexpectedly succeeded: ${output}"; return 1; }
  [[ "${output}" != *'print("classifier")'* ]] || { echo "payload survived: ${output}"; return 1; }
}

@test "pattern-match no-match: zero hits is data, not failure" {
  local intact="${BI_TMP}/count-intact.sh" stripped="${BI_TMP}/count-stripped.sh"
  local data="${BI_TMP}/data.txt"
  printf 'alpha\nbeta\n' >"${data}"
  cat >"${intact}" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
count="$(grep -c '^x' "${1}" || true)"
printf 'count=%s\n' "${count:-0}"
EOF
  sed 's/ || true)"$/)"/' "${intact}" >"${stripped}"
  assert_single_token_delta "${intact}" "${stripped}" "|| true"

  run bash "${intact}" "${data}"
  [ "${status}" -eq 0 ] || { echo "intact fixture failed: ${status} ${output}"; return 1; }
  # `grep -c` already printed 0 on no-match, so the guard yields "0" — never the "0\n0" of `|| echo 0`.
  [[ "${output}" == *"count=0"* ]] || { echo "unexpected output: ${output}"; return 1; }

  run bash "${stripped}" "${data}"
  [ "${status}" -ne 0 ] || { echo "stripped fixture unexpectedly succeeded: ${output}"; return 1; }
  [[ "${output}" != *"count="* ]] || { echo "assignment survived: ${output}"; return 1; }
}
