#!/usr/bin/env bats
# source_raw collision-immune identity logic in wiki-daily-compile.sh.
#
# source_raw is a note's stable back-reference to its originating raw basename.
# It is the only identity that survives a slug-rename + source_url drop, so a
# colliding raw (source_url shared by 2+ raws) is matched by source_raw without
# any collision guard. These tests pin three functions:
#   * _extract_source_raw  — ASCII-deterministic frontmatter parse (CRLF / lone
#     CR / trailing-tab / nbsp-preserve / body-line-ignored / first-wins).
#   * _classify_raw         — source_raw primary path is collision-immune; the
#     basename + non-collision source_url fallbacks still classify (no regress).
#   * _inject_source_raw    — idempotent, CRLF-preserving, frontmatter-only stamp.
#
# Run via: bats scripts/test/wiki-source-raw.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy: the functions are extracted from wiki-daily-compile.sh into a
# lib-only shim (the script's main flow is never executed) and sourced. NOTES_DIR
# — the one global the functions read — is pointed at a throwaway temp dir, so the
# real functions run against crafted fixtures without touching the live wiki store.

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/wiki-daily-compile.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "wiki-daily-compile.sh not found: ${REAL_SCRIPT}"
  WORK="$(mktemp -d -t wiki-srcraw-bats.XXXXXX)"
  RAW_DIR="${WORK}/raw"
  NOTES_DIR="${WORK}/notes"
  mkdir -p "${RAW_DIR}" "${NOTES_DIR}"

  # Extract the consecutive function-definition block (first function start →
  # last line before the main flow's first executable statement) into a shim so
  # sourcing it defines the functions without running the cron pipeline.
  SHIM="${WORK}/lib.sh"
  awk '
    /^_extract_source_url\(\) \{/ { capture=1 }
    capture && /^if \[ ! -d "\$RAW_DIR" \]/ { exit }
    capture { print }
  ' "${REAL_SCRIPT}" >"${SHIM}"
  [[ -s "${SHIM}" ]] || skip "function block extraction yielded an empty shim"

  # NOTES_DIR is the single global _classify_raw reads; export so the sourced
  # functions resolve it.
  export NOTES_DIR
  # shellcheck source=/dev/null
  source "${SHIM}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Write bytes verbatim (no trailing-newline coercion) so CRLF / lone-CR fixtures
# survive into the file exactly as authored.
write_raw_bytes() {
  printf '%b' "$2" >"$1"
}

# Portable file checksum — macOS ships `md5 -q`, Linux/CI ships `md5sum`. Only
# equality of two checksums matters here, so any stable hash works; kept as md5
# to preserve intent. The tool is selected once at load time so each call skips
# the repeated PATH search.
if command -v md5 >/dev/null 2>&1; then
  _file_md5() { md5 -q "$1"; }
else
  _file_md5() { md5sum "$1" | awk '{print $1}'; }
fi

# ---------------------------------------------------------------------------
# _extract_source_raw — byte-parity with _extract_source_url
# ---------------------------------------------------------------------------

@test "_extract_source_raw: a CRLF frontmatter block still opens and the value is CR-stripped" {
  write_raw_bytes "${WORK}/note.md" '---\r\nsource_raw: my-raw.md\r\n---\r\nbody\r\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ "${output}" == "my-raw.md" ]]
}

@test "_extract_source_raw: a lone CR mid-value is stripped from the result" {
  write_raw_bytes "${WORK}/note.md" '---\nsource_raw: my-\rraw.md\n---\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ "${output}" == "my-raw.md" ]]
}

@test "_extract_source_raw: a trailing tab is trimmed (ASCII trailing-trim)" {
  write_raw_bytes "${WORK}/note.md" '---\nsource_raw: my-raw.md\t\n---\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ "${output}" == "my-raw.md" ]]
}

@test "_extract_source_raw: an nbsp inside the value is PRESERVED (ASCII-only trim)" {
  # U+00A0 (0xC2 0xA0 in UTF-8) is not ASCII space/tab, so it stays in the value.
  printf '%b' '---\nsource_raw: a\xc2\xa0b.md\n---\n' >"${WORK}/note.md"
  run _extract_source_raw "${WORK}/note.md"
  [[ "${output}" == "$(printf 'a\xc2\xa0b.md')" ]]
}

@test "_extract_source_raw: a source_raw line in the BODY (after the block) is ignored" {
  write_raw_bytes "${WORK}/note.md" '---\ntitle: t\n---\nsource_raw: body-raw.md\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ -z "${output}" ]]
}

@test "_extract_source_raw: a missing source_raw key yields empty" {
  write_raw_bytes "${WORK}/note.md" '---\ntitle: t\nsource_url: http://x\n---\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ -z "${output}" ]]
}

@test "_extract_source_raw: an empty value yields empty" {
  write_raw_bytes "${WORK}/note.md" '---\nsource_raw:\n---\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ -z "${output}" ]]
}

@test "_extract_source_raw: with multiple source_raw lines the FIRST wins" {
  write_raw_bytes "${WORK}/note.md" '---\nsource_raw: first.md\nsource_raw: second.md\n---\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ "${output}" == "first.md" ]]
}

@test "_extract_source_raw: a file with no opening delimiter yields empty" {
  write_raw_bytes "${WORK}/note.md" 'source_raw: no-block.md\ntitle: t\n'
  run _extract_source_raw "${WORK}/note.md"
  [[ -z "${output}" ]]
}

# ---------------------------------------------------------------------------
# _classify_raw — source_raw primary path is collision-immune; fallbacks intact
# ---------------------------------------------------------------------------

# Re-export NOTES_DIR for the helper that builds the note source_raw / url sets.
note_raws() { _collect_note_source_raws "${NOTES_DIR}"; }
note_urls() { _collect_note_source_urls "${NOTES_DIR}"; }
collisions() { _collect_collision_source_urls "${RAW_DIR}"; }

@test "_classify_raw: a raw whose FULL basename is some note's source_raw is processed" {
  write_raw_bytes "${RAW_DIR}/2026-01-01-topic.md" '---\nsource_url: http://a\n---\n'
  # the compiled note carries the raw's full basename (incl .md) as source_raw,
  # under a slug-renamed filename that no longer matches the raw basename.
  write_raw_bytes "${NOTES_DIR}/topic.md" '---\nsource_raw: 2026-01-01-topic.md\n---\n'
  run _classify_raw "${RAW_DIR}/2026-01-01-topic.md" "$(note_urls)" "$(collisions)" "$(note_raws)"
  [[ "${output}" == "processed" ]]
}

@test "_classify_raw: source_raw match holds even when the raw's source_url collides" {
  # two raws share one source_url (a collision) — yet a source_raw note pins the
  # first one as processed with NO collision guard needed (collision-immune).
  write_raw_bytes "${RAW_DIR}/raw-a.md" '---\nsource_url: http://dup\n---\n'
  write_raw_bytes "${RAW_DIR}/raw-b.md" '---\nsource_url: http://dup\n---\n'
  write_raw_bytes "${NOTES_DIR}/note-a.md" '---\nsource_raw: raw-a.md\nsource_url: http://dup\n---\n'
  run _classify_raw "${RAW_DIR}/raw-a.md" "$(note_urls)" "$(collisions)" "$(note_raws)"
  [[ "${output}" == "processed" ]]
}

@test "_classify_raw: a colliding raw with NO matching source_raw note stays unprocessed" {
  # raw-b shares the collision url but no note back-references raw-b.md — the
  # collision guard blocks the url fallback, so it is correctly still backlog.
  write_raw_bytes "${RAW_DIR}/raw-a.md" '---\nsource_url: http://dup\n---\n'
  write_raw_bytes "${RAW_DIR}/raw-b.md" '---\nsource_url: http://dup\n---\n'
  write_raw_bytes "${NOTES_DIR}/note-a.md" '---\nsource_raw: raw-a.md\nsource_url: http://dup\n---\n'
  run _classify_raw "${RAW_DIR}/raw-b.md" "$(note_urls)" "$(collisions)" "$(note_raws)"
  [[ "${output}" == "unprocessed" ]]
}

@test "_classify_raw: the basename fallback still classifies a legacy note as processed" {
  # legacy note lacks source_raw but lives at notes/<raw-slug>.md — the basename
  # path must still mark the raw processed (additive non-regression).
  write_raw_bytes "${RAW_DIR}/legacy.md" '---\nsource_url: http://b\n---\n'
  write_raw_bytes "${NOTES_DIR}/legacy.md" '---\ntitle: legacy\n---\n'
  run _classify_raw "${RAW_DIR}/legacy.md" "$(note_urls)" "$(collisions)" "$(note_raws)"
  [[ "${output}" == "processed" ]]
}

@test "_classify_raw: the non-collision source_url fallback still classifies as processed" {
  # no source_raw, no basename match, but a unique source_url shared with a note
  # — the guarded url fallback must still classify processed (non-regression).
  write_raw_bytes "${RAW_DIR}/2026-renamed.md" '---\nsource_url: http://unique\n---\n'
  write_raw_bytes "${NOTES_DIR}/slug.md" '---\nsource_url: http://unique\n---\n'
  run _classify_raw "${RAW_DIR}/2026-renamed.md" "$(note_urls)" "$(collisions)" "$(note_raws)"
  [[ "${output}" == "processed" ]]
}

@test "_classify_raw: a raw with no match on any path is unprocessed" {
  write_raw_bytes "${RAW_DIR}/orphan.md" '---\nsource_url: http://nowhere\n---\n'
  run _classify_raw "${RAW_DIR}/orphan.md" "$(note_urls)" "$(collisions)" "$(note_raws)"
  [[ "${output}" == "unprocessed" ]]
}

# ---------------------------------------------------------------------------
# _inject_source_raw — idempotent, CRLF-preserving, frontmatter-only stamp
# ---------------------------------------------------------------------------

@test "_inject_source_raw: a second run is byte-identical to the first (idempotent)" {
  write_raw_bytes "${NOTES_DIR}/note.md" '---\ntitle: t\n---\nbody\n'
  _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  local first_sum
  first_sum="$(_file_md5 "${NOTES_DIR}/note.md")"
  _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  [[ "$(_file_md5 "${NOTES_DIR}/note.md")" == "${first_sum}" ]]
}

@test "_inject_source_raw: the injected source_raw line is readable back after stamping" {
  write_raw_bytes "${NOTES_DIR}/note.md" '---\ntitle: t\n---\nbody\n'
  _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  run _extract_source_raw "${NOTES_DIR}/note.md"
  [[ "${output}" == "the-raw.md" ]]
}

@test "_inject_source_raw: an existing CRLF record keeps its CRLF while the injected line is LF" {
  # the pre-existing 'title:' record stays CRLF; the newly injected source_raw
  # line is emitted LF — assert the injected line specifically, not the whole file.
  write_raw_bytes "${NOTES_DIR}/note.md" '---\r\ntitle: t\r\n---\r\nbody\r\n'
  _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  # the original title record retains its CR
  run grep -c $'title: t\r$' "${NOTES_DIR}/note.md"
  [[ "${output}" -eq 1 ]]
  # the injected source_raw line is LF-terminated (no CR before the newline)
  run grep -c $'source_raw: the-raw.md\r$' "${NOTES_DIR}/note.md"
  [[ "${output}" -eq 0 ]]
  run grep -c '^source_raw: the-raw.md$' "${NOTES_DIR}/note.md"
  [[ "${output}" -eq 1 ]]
}

@test "_inject_source_raw: a file with no opening delimiter is left unchanged (no-op)" {
  write_raw_bytes "${NOTES_DIR}/note.md" 'title: t\nbody\n'
  local before_sum
  before_sum="$(_file_md5 "${NOTES_DIR}/note.md")"
  _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  [[ "$(_file_md5 "${NOTES_DIR}/note.md")" == "${before_sum}" ]]
}

@test "_inject_source_raw: an already-present source_raw is NOT overwritten with a different value" {
  write_raw_bytes "${NOTES_DIR}/note.md" '---\nsource_raw: original.md\n---\nbody\n'
  _inject_source_raw "${NOTES_DIR}/note.md" "different.md" "http://u"
  run _extract_source_raw "${NOTES_DIR}/note.md"
  [[ "${output}" == "original.md" ]]
}

@test "_inject_source_raw: the stamp lands after the FIRST delimiter only, never into a second block" {
  # a second '---' block exists in the body; injection must touch only the first.
  write_raw_bytes "${NOTES_DIR}/note.md" '---\ntitle: t\n---\nbody\n---\nsecond: block\n'
  _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  # exactly one source_raw line, and it sits on line 2 (right after the first ---)
  run grep -c '^source_raw: the-raw.md$' "${NOTES_DIR}/note.md"
  [[ "${output}" -eq 1 ]]
  run sed -n '2p' "${NOTES_DIR}/note.md"
  [[ "${output}" == "source_raw: the-raw.md" ]]
}
