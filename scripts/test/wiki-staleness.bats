#!/usr/bin/env bats
# wiki-staleness.bats — pins the three staleness buckets and the oldest-N enumeration cap.
#
# Every fixture note is generated under BATS_TEST_TMPDIR and the script is pointed at it with
# --notes-dir, so the live wiki store is neither read nor written by this suite.

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../wiki-staleness.sh"
  NOTES="${BATS_TEST_TMPDIR}/notes"
  mkdir -p "${NOTES}"
}

# BSD `date -v` vs GNU `date -d`: the suite runs on both.
days_ago() {
  local days="${1}" fmt="${2}"
  if date -v-1d '+%Y' >/dev/null 2>&1; then
    date -v-"${days}"d "${fmt}"
  else
    date -d "${days} days ago" "${fmt}"
  fi
}

write_note() {
  local name="${1}" frontmatter="${2}"
  printf -- '---\n%s\n---\n\nbody\n' "${frontmatter}" >"${NOTES}/${name}"
}

set_mtime() {
  local name="${1}" days="${2}" stamp
  stamp="$(days_ago "${days}" '+%Y%m%d')0000"
  touch -t "${stamp}" "${NOTES}/${name}"
}

seed_five_notes() {
  write_note a-fresh.md "updated: $(days_ago 89 '+%Y-%m-%d')"
  write_note b-stale-updated.md "updated: $(days_ago 91 '+%Y-%m-%d')"
  write_note c-stale-created.md "created: $(days_ago 100 '+%Y-%m-%d')"
  write_note d-no-date.md "title: no date field"
  set_mtime d-no-date.md 100
  write_note e-malformed.md "updated: not-a-date"
}

# Extracts one `## <title>` section body out of the report.
section() {
  awk -v want="## ${1}" 'index($0, want) == 1 { on = 1; next } /^## / { on = 0 } on { print }' <<<"${output}"
}

assert_has() {
  local haystack="${1}" needle="${2}"
  [[ "${haystack}" == *"${needle}"* ]] || { printf 'expected to contain %s in:\n%s\n' "${needle}" "${haystack}"; return 1; }
}

assert_lacks() {
  local haystack="${1}" needle="${2}"
  [[ "${haystack}" != *"${needle}"* ]] || { printf 'expected NOT to contain %s in:\n%s\n' "${needle}" "${haystack}"; return 1; }
}

@test "stale bucket lists exactly the frontmatter-dated notes past the threshold" {
  seed_five_notes
  run "${SCRIPT}" --notes-dir "${NOTES}"
  local body
  body="$(section 'Stale')"
  [ "${status}" -eq 0 ] &&
    assert_has "${body}" 'count: 2' &&
    assert_has "${body}" 'b-stale-updated.md' &&
    assert_has "${body}" 'c-stale-created.md' &&
    assert_lacks "${body}" 'a-fresh.md' &&
    assert_lacks "${body}" 'd-no-date.md' &&
    assert_lacks "${body}" 'e-malformed.md'
}

@test "mtime-derived bucket holds only the note with no date field" {
  seed_five_notes
  run "${SCRIPT}" --notes-dir "${NOTES}"
  local body
  body="$(section 'mtime-derived')"
  [ "${status}" -eq 0 ] &&
    assert_has "${body}" 'count: 1' &&
    assert_has "${body}" 'd-no-date.md' &&
    assert_lacks "${body}" 'a-fresh.md' &&
    assert_lacks "${body}" 'b-stale-updated.md' &&
    assert_lacks "${body}" 'e-malformed.md'
}

@test "unknown-age bucket holds only the note whose date field will not parse" {
  seed_five_notes
  run "${SCRIPT}" --notes-dir "${NOTES}"
  local body
  body="$(section 'unknown age')"
  [ "${status}" -eq 0 ] &&
    assert_has "${body}" 'count: 1' &&
    assert_has "${body}" 'e-malformed.md' &&
    assert_lacks "${body}" 'd-no-date.md' &&
    assert_lacks "${body}" 'b-stale-updated.md'
}

@test "oldest-N cap enumerates 10 entries and reports the remainder as a count" {
  local age
  for age in 100 101 102 103 104 105 106 107 108 109 110 111; do
    write_note "stale-${age}.md" "updated: $(days_ago "${age}" '+%Y-%m-%d')"
  done
  run "${SCRIPT}" --notes-dir "${NOTES}"
  local body listed
  body="$(section 'Stale')"
  listed="$(grep -c '\.md$' <<<"${body}" || true)"
  [ "${status}" -eq 0 ] &&
    assert_has "${body}" 'count: 12' &&
    [ "${listed}" -eq 10 ] &&
    assert_has "${body}" '2 more not listed' &&
    assert_has "${body}" 'stale-111.md' &&
    assert_has "${body}" 'stale-102.md' &&
    assert_lacks "${body}" 'stale-101.md' &&
    assert_lacks "${body}" 'stale-100.md'
}
