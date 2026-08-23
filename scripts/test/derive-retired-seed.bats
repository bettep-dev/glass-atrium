#!/usr/bin/env bats
# derive-retired-seed.sh suite — pins the four selection rules the seed derivation
# and the generator must agree on, since the fixture this script prints is what
# seeds the generator's map once: a path shipped then dropped carries EVERY hash
# history recorded for it, a still-shipped path is not seeded, and the two barred
# families (applied Prisma migrations, merge-claimed paths) never enter.
# Hermetic: a synthetic three-revision repo under a pwd -P temp root, with COPIES
# of the real script and the spine library at <sandbox>/scripts/ so the script's
# BASH_SOURCE-derived GA_ROOT resolves to the sandbox, never the live tree.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/derive-retired-seed.sh"
REAL_SPINE="${GA}/scripts/lib/apply-spine.sh"

# Hashes are fixed literals, not computed: the derivation copies whatever the
# historical manifest recorded, so a literal makes the expected output exact.
# H1 sorts before H2, which is what the sorted-append assertion reads.
H1="1111111111111111111111111111111111111111111111111111111111111111"
H2="2222222222222222222222222222222222222222222222222222222222222222"
HP2="3333333333333333333333333333333333333333333333333333333333333333"
HM1="4444444444444444444444444444444444444444444444444444444444444444"
HA1="5555555555555555555555555555555555555555555555555555555555555555"

P1="scripts/lib/p1.sh"
P2="rules/p2.md"
M1="monitor/prisma/migrations/20260101000000_x/migration.sql"
A1="agents/a1.md"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "derive-retired-seed.sh not found: ${REAL_SCRIPT}"
  [[ -f "${REAL_SPINE}" ]] || skip "apply-spine.sh not found: ${REAL_SPINE}"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  WORK="$(cd -- "$(mktemp -d -t derive-seed-bats.XXXXXX)" && pwd -P)"
  SCRIPT="${WORK}/scripts/derive-retired-seed.sh"
  mkdir -p "${WORK}/scripts/lib" "${WORK}/rules" "${WORK}/agents" \
    "${WORK}/monitor/prisma/migrations/20260101000000_x"
  cp "${REAL_SCRIPT}" "${SCRIPT}"
  cp "${REAL_SPINE}" "${WORK}/scripts/lib/apply-spine.sh"

  git -C "${WORK}" init -q
  git -C "${WORK}" config user.email bats@test.local
  git -C "${WORK}" config user.name bats
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Write manifest.json with the given `<path>=<hash>` pairs and commit it.
write_manifest_revision() {
  local msg="$1" pair path hash
  shift
  : >"${WORK}/pairs"
  for pair in "$@"; do
    path="${pair%%=*}"
    hash="${pair#*=}"
    printf '%s\t%s\n' "${path}" "${hash}" >>"${WORK}/pairs"
  done
  jq -Rn --rawfile raw "${WORK}/pairs" '
    ($raw | split("\n") | map(select(length > 0) | split("\t")) ) as $p
    | {version: "1.0.1",
       files: ($p | map(.[0])),
       hashes: ($p | map({key: .[0], value: .[1]}) | from_entries),
       modes: ($p | map({key: .[0], value: "644"}) | from_entries)}
  ' >"${WORK}/manifest.json"
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm "${msg}"
}

# Three manifest revisions: p1 shipped at H1 then H2 then dropped; p2 shipped
# throughout; m1 (migrations family) and a1 (merge-claimed) shipped then dropped.
seed_history() {
  printf 'one\n' >"${WORK}/${P1}"
  printf 'two\n' >"${WORK}/${P2}"
  printf 'CREATE TABLE t();\n' >"${WORK}/${M1}"
  printf '# agent a1\n' >"${WORK}/${A1}"
  write_manifest_revision 'r1' "${P1}=${H1}" "${P2}=${HP2}" "${M1}=${HM1}" "${A1}=${HA1}"

  printf 'one changed\n' >"${WORK}/${P1}"
  write_manifest_revision 'r2' "${P1}=${H2}" "${P2}=${HP2}" "${M1}=${HM1}" "${A1}=${HA1}"

  git -C "${WORK}" rm -q "${P1}" "${M1}" "${A1}"
  write_manifest_revision 'r3' "${P2}=${HP2}"
}

@test "derive: seeds only the dropped, unbarred path — with every hash it ever shipped" {
  seed_history
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  local expected
  expected="$(jq -cn --arg p "${P1}" --arg h1 "${H1}" --arg h2 "${H2}" '{($p): [$h1, $h2]}')"
  [[ "$(printf '%s' "${output}" | jq -cS .)" == "$(printf '%s' "${expected}" | jq -cS .)" ]] || return 1
}

@test "derive: a dropped path still present on disk is not seeded" {
  seed_history
  # the vendor stopped tracking it, but a copy survives in the tree — the same
  # second arm the generator applies, so an untracked-in-place file is never a
  # removal candidate.
  mkdir -p "${WORK}/scripts/lib"
  printf 'one changed\n' >"${WORK}/${P1}"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(printf '%s' "${output}" | jq -c .)" == "{}" ]] || return 1
}

@test "derive: rejects an argument (exit 2)" {
  seed_history
  run "${SCRIPT}" --anything
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"usage:"* ]] || return 1
}

@test "derive: refuses outside a git work tree (exit 3)" {
  # Without a repository the walk has no history to read at all, so the refusal
  # must be the named one rather than an empty map that reads as "nothing dropped".
  rm -rf -- "${WORK}/.git"
  run "${SCRIPT}"
  [[ "${status}" -eq 3 ]] || return 1
  [[ "${output}" == *"not a git work tree"* ]] || return 1
}
