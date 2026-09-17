#!/usr/bin/env bats
# One manifest key rule, three implementations: the spine helper, install.sh's inline
# pre-verify copy (extracted verbatim, as test/deps-preflight-noninteractive.bats does)
# and the generator's jq definition. Each must match the expected verdict on every
# fixture, so a drift in any one of them reads red. Behaviour is compared, never text.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Parallel arrays: an empty key cannot ride a whitespace-delimited table.
KEYS=("" "/" "/abs" "//x" ".." "../x" "a/../b" "a/.." "a/b/.."
  "a" "scripts/lib/x.sh" "foo..bar" "a/.../b" ".hidden/x" "a//b" "./x" "." "a/" "...")
VERDICTS=(escaping escaping escaping escaping escaping escaping escaping escaping escaping
  contained contained contained contained contained contained contained contained contained contained)

setup() {
  # install.sh is a repo-only bootstrap, absent from a consumer install.
  [[ -f "${GA}/install.sh" ]] || skip "install.sh absent (consumer install — repo-only bootstrap)"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  SANDBOX="$(mktemp -d -t ga-key-parity.XXXXXX)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# rc 0 → escaping · rc 1 → contained · anything else (127 on a missing definition) → error
verdict_of_rc() {
  case "$1" in
    0) printf 'escaping' ;;
    1) printf 'contained' ;;
    *) printf 'error(rc=%s)' "$1" ;;
  esac
}

get_spine_verdict() {
  local rc=0
  env -i PATH="${PATH}" bash -c 'set -Eeuo pipefail; source "$1"; spine_is_escaping_key "$2"' _ \
    "${GA}/scripts/lib/apply-spine.sh" "$1" || rc=$?
  verdict_of_rc "${rc}"
}

# A clean env proves the extracted copy needs no other install.sh function or global.
get_inline_verdict() {
  local rc=0
  env -i PATH="${PATH}" bash -c 'set -Eeuo pipefail; source "$1"; is_escaping_manifest_key "$2"' _ \
    "${SANDBOX}/inline-fn.sh" "$1" || rc=$?
  verdict_of_rc "${rc}"
}

get_jq_verdict() {
  local count
  count="$(jq -n --arg k "$1" "$(cat "${SANDBOX}/shape.jq")"' {files: [$k]} | files_key_violations | length')" \
    || count="error"
  case "${count}" in
    1) printf 'escaping' ;;
    0) printf 'contained' ;;
    *) printf 'error(%s)' "${count}" ;;
  esac
}

@test "parity: spine helper, install.sh inline copy and generator jq agree with the key rule" {
  awk '$0 == "is_escaping_manifest_key() {" {f=1} f{print} f&&/^}/{exit}' \
    "${GA}/install.sh" >"${SANDBOX}/inline-fn.sh"
  [ -s "${SANDBOX}/inline-fn.sh" ] || {
    printf 'install.sh inline predicate not extracted\n'
    return 1
  }
  awk '$0 == "readonly MANIFEST_SHAPE_JQ_DEF='"'"'" {f=1; next} f&&$0 == "'"'"'" {exit} f{print}' \
    "${GA}/scripts/generate-manifest.sh" >"${SANDBOX}/shape.jq"
  grep -q 'def files_key_violations' "${SANDBOX}/shape.jq" \
    || {
      printf 'generator jq definition not extracted\n'
      return 1
    }

  [ "${#KEYS[@]}" -eq "${#VERDICTS[@]}" ] || {
    printf 'fixture arrays differ in length\n'
    return 1
  }
  local i key want got impl mismatches=""
  for ((i = 0; i < ${#KEYS[@]}; i++)); do
    key="${KEYS[i]}"
    want="${VERDICTS[i]}"
    for impl in spine inline jq; do
      got="$("get_${impl}_verdict" "${key}")"
      [ "${got}" = "${want}" ] || mismatches+="${impl} key='${key}' want=${want} got=${got}"$'\n'
    done
  done
  [ -z "${mismatches}" ] || {
    printf '%s' "${mismatches}"
    return 1
  }
}
