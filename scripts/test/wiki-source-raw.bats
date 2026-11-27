#!/usr/bin/env bats
# source_raw collision-immune identity logic in wiki-daily-compile.sh.
#
# source_raw is a note's stable back-reference to its originating raw basename.
# It is the only identity that survives a slug-rename + source_url drop, so a
# colliding raw (source_url shared by 2+ raws) is matched by source_raw without
# any collision guard. These tests pin three functions:
#   * _extract_source_raw  — only the no-opening-delimiter shape; every other
#     trim / block-scan edge is pinned byte-for-byte against the Python
#     extractor in test_wiki_source_raw.py, which runs this same awk program.
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

# The extracted shim needs ga_guard_path too — the real script gets it from libs above the window.
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

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
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
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
# _extract_source_raw — the one shape absent from the Python parity battery
# ---------------------------------------------------------------------------

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

@test "_inject_source_raw: a stamp whose rename fails leaves the note untouched and no temp behind" {
  write_raw_bytes "${NOTES_DIR}/note.md" '---\ntitle: t\n---\nbody\n'
  local before_sum
  before_sum="$(_file_md5 "${NOTES_DIR}/note.md")"
  mv() { return 1; }
  run _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  unset -f mv
  [ "$(_file_md5 "${NOTES_DIR}/note.md")" = "${before_sum}" ]
  run find "${NOTES_DIR}" -name 'note.md.inject.*'
  [ -z "${output}" ]
}

@test "_inject_source_raw: a stamp whose rewrite fails leaves no temp behind" {
  [ "$(id -u)" -ne 0 ] || skip "root bypasses the mode bits this row depends on"
  write_raw_bytes "${NOTES_DIR}/note.md" '---\ntitle: t\n---\nbody\n'
  chmod 000 "${NOTES_DIR}/note.md"
  run _inject_source_raw "${NOTES_DIR}/note.md" "the-raw.md" "http://u"
  chmod 600 "${NOTES_DIR}/note.md"
  run find "${NOTES_DIR}" -name 'note.md.inject.*'
  [ -z "${output}" ]
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

# ---------------------------------------------------------------------------
# _classify_raw — a membership set past one pipe buffer keeps each verdict
# ---------------------------------------------------------------------------

@test "_classify_raw: a match heading a set past one pipe buffer keeps each verdict under pipefail" {
  local fill
  fill="$(awk 'BEGIN { for (i = 0; i < 60000; i++) printf "filler-%06d\n", i }')"
  write_raw_bytes "${RAW_DIR}/raw-a.md" '---\nsource_url: http://dup\n---\n'
  # set_of SPEC — "big:<line>" → <line> heading ~1 MB of filler; else the spec as written
  set_of() {
    case "$1" in
      big:*) printf '%s\n%s' "${1#big:}" "${fill}" ;;
      *) printf '%s' "$1" ;;
    esac
  }
  # name|note-url set|collision set|note source_raw set|expected
  local rows=(
    "source_raw primary|||big:raw-a.md|processed"
    "negated collision guard|http://dup|big:http://dup||unprocessed"
    "source_url fallback|big:http://dup|||processed"
  )
  local row name urls colls raws want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name urls colls raws want <<<"${row}"
    # the script's pipefail, scoped to a subshell so the test body keeps bats' own
    got="$(set -o pipefail && _classify_raw "${RAW_DIR}/raw-a.md" "$(set_of "${urls}")" \
      "$(set_of "${colls}")" "$(set_of "${raws}")")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: got '${got}', want '${want}'"
      return 1
    }
  done
}

# ---------------------------------------------------------------------------
# skip record — a batch-declined raw leaves the backlog until its line goes
# ---------------------------------------------------------------------------

@test "_classify_raw: the skip record moves exactly its listed, note-less raws out of the backlog" {
  write_raw_bytes "${RAW_DIR}/2026-02-01-declined.md" '---\nsource_url: http://declined\n---\n'
  write_raw_bytes "${RAW_DIR}/2026-02-01-compiled.md" '---\nsource_url: http://compiled\n---\n'
  write_raw_bytes "${NOTES_DIR}/compiled-renamed.md" '---\nsource_raw: 2026-02-01-compiled.md\n---\n'
  write_raw_bytes "${RAW_DIR}/2026-02-01-fresh.md" '---\nsource_url: http://fresh\n---\n'
  local record="${WORK}/index/compile-skips.tsv"
  _record_skip "${record}" "2026-02-01-declined.md"
  _record_skip "${record}" "2026-02-01-compiled.md"
  # name|raw basename|expected
  local rows=(
    "listed, no note|2026-02-01-declined.md|skipped"
    "listed, note present|2026-02-01-compiled.md|processed"
    "unlisted, no note|2026-02-01-fresh.md|unprocessed"
  )
  local row name base want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name base want <<<"${row}"
    got="$(_classify_raw "${RAW_DIR}/${base}" "$(note_urls)" "$(collisions)" "$(note_raws)" \
      "$(_collect_skipped_raws "${record}")")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: got '${got}', want '${want}'"
      return 1
    }
  done
}

@test "_record_skip: recording one raw twice leaves one line in the record" {
  local record="${WORK}/index/compile-skips.tsv"
  _record_skip "${record}" "2026-02-02-twice.md"
  _record_skip "${record}" "2026-02-02-twice.md"
  run _collect_skipped_raws "${record}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == "2026-02-02-twice.md" ]]
}

@test "_collect_skipped_raws: an absent record reads as an empty set" {
  run _collect_skipped_raws "${WORK}/index/compile-skips.tsv"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ -z "${output}" ]]
}

@test "_get_body_kind: an exact skip sentinel is a skip, the sentinel amid other text is garbled, anything else a note" {
  local nonce="0123456789abcdef0123456789abcdef"
  local sentinel="-----GA-WIKI-NOTE-SKIP nonce=${nonce}-----"
  # name|body bytes (printf %b)|expected kind
  local rows=(
    "the sentinel alone|${sentinel}\n|skip"
    "the sentinel with a CR line end|${sentinel}\r\n|skip"
    "the sentinel followed by a reason line|${sentinel}\nnot a source page\n|garbled-skip"
    "a blank line before the sentinel|\n${sentinel}\n|garbled-skip"
    "a space before the sentinel| ${sentinel}\n|garbled-skip"
    "another run's nonce|-----GA-WIKI-NOTE-SKIP nonce=fedcba9876543210fedcba9876543210-----\n|note"
    "a note body|---\ntitle: t\n---\n|note"
    "an empty body||note"
  )
  local row name bytes want got
  for row in "${rows[@]}"; do
    IFS='|' read -r name bytes want <<<"${row}"
    write_raw_bytes "${WORK}/body" "${bytes}"
    got="$(_get_body_kind "${WORK}/body" "${nonce}")" || {
      echo "${name}: _get_body_kind failed"
      return 1
    }
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: kind '${got}', want '${want}'"
      return 1
    }
  done
}

# ---------------------------------------------------------------------------
# curator body ↔ _classify_raw — the spawned curator's only copy of the tests
# ---------------------------------------------------------------------------

@test "every Unprocessed test in the curator body is a processed path _classify_raw takes" {
  local body="${GA}/agents/glass-atrium-wiki-curator.md"
  write_raw_bytes "${RAW_DIR}/2026-03-01-raw.md" '---\nsource_url: http://raw\n---\n'
  # body sub-bullet|note file|note bytes — each note alone satisfies only its own test
  local rows=(
    "  - Some note's \`source_raw\` equals the raw's basename.|renamed.md|---\nsource_raw: 2026-03-01-raw.md\n---\n"
    "  - \`notes/<raw basename>\` exists.|2026-03-01-raw.md|---\ntitle: t\n---\n"
    "  - Some note's \`source_url\` equals the raw's \`source_url\`, and no other raw carries that URL.|renamed.md|---\nsource_url: http://raw\n---\n"
  )
  local want="" i=0 row bullet note bytes got
  for row in "${rows[@]}"; do
    IFS='|' read -r bullet note bytes <<<"${row}"
    want="${want}${bullet}"$'\n'
    i=$((i + 1))
    NOTES_DIR="${WORK}/notes-${i}"
    mkdir -p "${NOTES_DIR}"
    write_raw_bytes "${NOTES_DIR}/${note}" "${bytes}"
    got="$(_classify_raw "${RAW_DIR}/2026-03-01-raw.md" "$(note_urls)" "$(collisions)" "$(note_raws)" "")"
    [[ "${got}" == "processed" ]] || {
      echo "${bullet}: the function says '${got}' for a raw this test alone covers"
      return 1
    }
  done
  # the body's sub-bullets under **Unprocessed**, in order
  got="$(awk '/^- \*\*Unprocessed\*\*:/ { on=1; next } on && /^  - / { print; next } on { exit }' "${body}")"$'\n'
  [[ "${got}" == "${want}" ]] || {
    printf 'body:\n%s\nwant:\n%s' "${got}" "${want}"
    return 1
  }
}

@test "the curator body cites the skip record at the path the script writes it" {
  local body="${GA}/agents/glass-atrium-wiki-curator.md" rel
  # shellcheck disable=SC2016  # $WIKI_ROOT is the literal text of the script line, not an expansion
  rel="$(sed -n 's|^SKIP_RECORD="\$WIKI_ROOT/\(.*\)"$|\1|p' "${REAL_SCRIPT}")"
  [[ -n "${rel}" ]] || {
    echo "no SKIP_RECORD assignment in ${REAL_SCRIPT}"
    return 1
  }
  grep -qF -- "\`${rel}\`" "${body}" || {
    echo "body does not cite \`${rel}\`"
    return 1
  }
}
