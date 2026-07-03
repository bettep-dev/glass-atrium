#!/usr/bin/env bats
# daemon-apply.sh — coverage for the two P1a/P3b branches added to the SINGLE-
# proposal (--proposal-id) path:
#
#   P1a — landing_zone_reject now WIRES the bounded-retry stale-drain. An
#         out_of_region single/backlog row drives mark_stale_attempt (enforce=1)
#         BEFORE the trailing `continue` leaves the row pending (git-free: the
#         reject runs before any apply, so no bytes were written and there is
#         nothing to restore), emits a needs_regen/stale_drain_<verdict> log,
#         and prints the drained / no_column operator WARN. Gated on
#         AUTO_REGEN -ne 1 && PATCH_SOURCE in {backlog,single}. DRY_RUN reaches
#         NO DB write (short-circuits before the guard).
#
#   P3b — extract_single_proposal's SELECT now admits a row ONLY when
#         haiku_status LIKE 'ok%' (NULL/skipped/error excluded → fail-closed),
#         UNLESS the operator carve-out AUTOAGENT_ALLOW_HAIKU_SKIP=1 is engaged
#         (loud WARN). ok / ok:retried / ok:fuzzy-parsed all pass; ='ok' is NOT
#         used (variants preserved).
#
# Run via: bats autoagent/test/daemon-apply-stale-drain-haiku-guard.bats
# Requires: bats >= 1.5.0, bash 3.2+, git, python3, base64
#
# Hermetic strategy: a per-test standalone git repo fixture under a realpath-
# resolved temp root, plus a stub PATH whose `psql` is a FAITHFUL PG stand-in.
# The stub dispatches on the SQL it receives + the -v bindings, logs every
# invocation for assertions, and (for the single SELECT) honors the haiku-skip
# predicate exactly (admit iff allow_haiku_skip=1 OR STUB_HAIKU matches ok*).
# The SQL predicate TEXT itself is independently pinned by the shape-assertion
# test below — so the stub re-implementing the predicate is not the sole guard.
# No live PG, no live agents/ dir is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"

# build_full_stub — symlink every real command into $1 EXCEPT psql. The whole-PATH
# mirror (vs a hand-maintained allowlist) keeps the fixture robust as the git-free
# daemon's command set shifts; psql is skipped so install_psql_stub can drop its
# faithful PG stand-in in cleanly (a fresh file, not a symlink onto real psql).
build_full_stub() {
  local stub="$1" d f name
  local IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      [[ "${name}" == "psql" ]] && continue
      [[ -e "${stub}/${name}" ]] || ln -sf "${f}" "${stub}/${name}"
    done
  done
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-sd-bats.XXXXXX)" && pwd -P)"
  STUB="${WORK}/bin"
  AGENTS="${WORK}/agents"
  REPORTS="${WORK}/reports"
  PSQL_LOG="${WORK}/psql-invocations.log"
  mkdir -p "${STUB}" "${AGENTS}" "${REPORTS}"

  # Stub bin = a whole-PATH mirror of every real command EXCEPT psql (which the
  # faithful stand-in below supplies). The mirror replaces the former hand-
  # maintained allowlist: the git-free daemon + its sourced libs (git-txn.sh /
  # apply-lock.sh) call a broad, evolving coreutils set (basename/mv/stat/cp/…),
  # and an allowlist that misses one makes the daemon exit 127 before the guard,
  # failing every test opaquely. psql is skipped (never mirrored) so the install_
  # psql_stub `cat >` below writes a FRESH file rather than following a symlink
  # onto the real psql binary.
  build_full_stub "${STUB}"
  install_psql_stub

  git -C "${AGENTS}" init -q
  git -C "${AGENTS}" config user.email bats@test.local
  git -C "${AGENTS}" config user.name bats
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# install_psql_stub — write the faithful PG stand-in into the stub bin.
install_psql_stub() {
  cat >"${STUB}/psql" <<'STUB'
#!/usr/bin/env bash
# Faithful PG stand-in for daemon-apply single-mode tests. Dispatches on the SQL
# received on stdin + the -v bindings, logs every invocation, and emits canned
# rows / verdicts driven by STUB_* env vars.
set -u
log="${STUB_PSQL_LOG:?stub needs STUB_PSQL_LOG}"

args=("$@")
n=${#args[@]}
allow=""
for ((i = 0; i < n; i++)); do
  if [[ "${args[i]}" == "-v" ]] && ((i + 1 < n)); then
    case "${args[i + 1]}" in
      allow_haiku_skip=*) allow="${args[i + 1]#allow_haiku_skip=}" ;;
    esac
  fi
done

sql="$(cat)"
{
  printf '=== psql invocation ===\n'
  printf 'argv: %s\n' "$*"
  printf 'allow_haiku_skip=%s\n' "${allow}"
  printf 'sql<<<\n%s\n>>>\n' "${sql}"
} >>"${log}"

case "${sql}" in
  *"translate(encode(convert_to"*)
    # extract_single_proposal SELECT — honor the haiku-skip predicate faithfully.
    haiku="${STUB_HAIKU:-ok}"
    if [[ "${allow}" == "1" ]] || [[ "${haiku}" == ok* ]]; then
      printf '%s|%s|%s|%s|%s|%s\n' \
        "${STUB_ROW_ID:?}" "${STUB_CYCLE:?}" "${STUB_LABEL:?}" \
        "${STUB_AGENT:?}" "${STUB_TARGET:?}" "${STUB_DIFF_B64:?}"
    fi
    ;;
  *"stale_attempt_count"*)
    # mark_stale_attempt CTE — emit the canned verdict token.
    printf '%s\n' "${STUB_STALE_VERDICT:-incremented}"
    ;;
  *) : ;;
esac
exit 0
STUB
  chmod +x "${STUB}/psql"
}

# make_probe — write the probe.md fixture (protected Absolute-Rules section +
# one editable Goal region) and commit it as the initial fixture state.
make_probe() {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' \
    '- MUST NOT do the dangerous thing' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  git -C "${AGENTS}" add -A
  git -C "${AGENTS}" commit -qm fixture
}

# oor_diff_b64 — base64 (newline-stripped, PG convention) of an out_of_region
# diff anchored on the PROTECTED Absolute-Rules lines.
oor_diff_b64() {
  printf '%s\n' \
    '--- a/probe.md' \
    '+++ b/probe.md' \
    '@@ -5,2 +5,3 @@' \
    ' - MUST NOT do the dangerous thing' \
    '+- injected protected rule' \
    ' - protected rule line alpha' | base64 | tr -d '\n'
}

# run_single — invoke daemon-apply in single mode with the stub PATH + STUB_*
# row fixture. Extra args ($2..) are forwarded (e.g. --dry-run, --auto-regen).
# $1 = haiku_status the stub reports for the row.
run_single() {
  local haiku="$1"
  shift
  run env PATH="${STUB}" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    STUB_PSQL_LOG="${PSQL_LOG}" \
    STUB_ROW_ID="1022" \
    STUB_CYCLE="2026-06-26" \
    STUB_LABEL="probe-stale" \
    STUB_AGENT="probe" \
    STUB_TARGET="${AGENTS}/probe.md" \
    STUB_DIFF_B64="$(oor_diff_b64)" \
    STUB_HAIKU="${haiku}" \
    ${STUB_STALE_VERDICT:+STUB_STALE_VERDICT="${STUB_STALE_VERDICT}"} \
    ${ALLOW:+AUTOAGENT_ALLOW_HAIKU_SKIP="${ALLOW}"} \
    bash "${REAL_SCRIPT}" --proposal-id 1022 --agents-dir "${AGENTS}" "$@"
}

applied_log_path() {
  printf '%s/autoagent-applied-%s.jsonl' "${REPORTS}" "$(date -u +%Y-%m-%d)"
}

# ---------------------------------------------------------------------------
# P1a (a) — out_of_region single row WIRES stale-drain (verdict: incremented)
# ---------------------------------------------------------------------------

@test "P1a: landing_zone_reject drives mark_stale_attempt (incremented) and emits stale_drain log" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok"

  # Single-mode apply-fail → exit 9 (could not apply, left pending).
  [[ "${status}" -eq 9 ]]
  # Loud landing-zone reject recorded (the row anchored outside every region).
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  grep -q '"verdict":"out_of_region"' "$(applied_log_path)"
  # The stale-drain wiring fired with the mirrored needs_regen log line. The
  # reason composes the full 'stale_drain_<verdict>' value then json-encodes it
  # ONCE (RC2 fix) → one clean JSON string, no nested quotes (json.loads-valid).
  grep -q '"status":"needs_regen"' "$(applied_log_path)"
  grep -q '"reason":"stale_drain_incremented"' "$(applied_log_path)"
  # The mark_stale_attempt CTE actually reached psql (enforce path).
  grep -q 'stale_attempt_count' "${PSQL_LOG}"
}

# ---------------------------------------------------------------------------
# P1a (b) — drained verdict prints the operator "drained to snoozed" WARN
# ---------------------------------------------------------------------------

@test "P1a: drained verdict emits the operator drain WARN + stale_drain_drained log" {
  make_probe
  STUB_STALE_VERDICT="drained"
  run_single "ok"

  [[ "${status}" -eq 9 ]]
  grep -q '"reason":"stale_drain_drained"' "$(applied_log_path)"
  # Operator-facing WARN on stderr (captured by bats in $output).
  [[ "${output}" == *"drained to snoozed"* ]]
}

# ---------------------------------------------------------------------------
# P1a (c) — no_column verdict prints the migration-pending WARN (tolerant degrade)
# ---------------------------------------------------------------------------

@test "P1a: no_column verdict emits the column-absent WARN (fossil NOT drained)" {
  make_probe
  STUB_STALE_VERDICT="no_column"
  run_single "ok"

  [[ "${status}" -eq 9 ]]
  grep -q '"reason":"stale_drain_no_column"' "$(applied_log_path)"
  [[ "${output}" == *"stale_attempt_count column absent"* ]]
}

# ---------------------------------------------------------------------------
# P1a (d) — AUTO_REGEN gate: --auto-regen SKIPS the stale-drain (regen owns it)
# ---------------------------------------------------------------------------

@test "P1a: --auto-regen skips stale-drain (no mark_stale CTE, no stale_drain log)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok" --auto-regen

  # Still a landing-zone reject, but the stale-drain block is gated OFF.
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  run grep -q '"reason":"stale_drain' "$(applied_log_path)"
  [[ "${status}" -ne 0 ]]
  # mark_stale_attempt CTE must NOT have reached psql under --auto-regen.
  run grep -q 'stale_attempt_count' "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# P1a (e) — DRY_RUN reaches NO DB write (short-circuits before the guard)
# ---------------------------------------------------------------------------

@test "P1a: --dry-run short-circuits before the landing-zone guard (no mark_stale CTE)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok" --dry-run

  [[ "${status}" -eq 0 ]]
  # The single SELECT still ran (row fetched) ...
  grep -q 'translate(encode(convert_to' "${PSQL_LOG}"
  # ... but NO mark_stale_attempt CTE was sent (dry-run never reaches the guard).
  run grep -q 'stale_attempt_count' "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]]
  # Dry-run "would_commit" record went to the dry-run log, not a stale_drain line.
  grep -q '"status":"dryrun"' "/tmp/autoagent-applied-$(date -u +%Y-%m-%d).dryrun.jsonl"
}

# ---------------------------------------------------------------------------
# P3b (f) — haiku_status skipped/empty/error is BLOCKED by default (fail-closed)
# ---------------------------------------------------------------------------

@test "P3b: a haiku-skipped row is NOT selected by default (exit 8 no-op, fail-closed)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "skipped:empty-or-error"

  # 0 rows selected → single-mode "not actionable" no-op exit 8 (NOT an apply).
  [[ "${status}" -eq 8 ]]
  # The row never reached the landing-zone guard (it was filtered at SELECT).
  [[ ! -f "$(applied_log_path)" ]] || run grep -q 'landing_zone_reject' "$(applied_log_path)"
  [[ "${status}" -ne 0 ]]
}

# ---------------------------------------------------------------------------
# P3b (g) — operator carve-out admits a haiku-skipped row + prints the loud WARN
# ---------------------------------------------------------------------------

@test "P3b: AUTOAGENT_ALLOW_HAIKU_SKIP=1 admits a haiku-skipped row with a loud WARN" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  ALLOW="1" run_single "skipped:empty-or-error"

  # Carve-out admitted the row → it flowed to the landing-zone reject (exit 9).
  [[ "${status}" -eq 9 ]]
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
  # Loud operator bypass WARN on stderr.
  [[ "${output}" == *"haiku-skip guard BYPASSED by operator"* ]]
  # The SELECT carried allow_haiku_skip=1.
  grep -q 'allow_haiku_skip=1' "${PSQL_LOG}"
}

# ---------------------------------------------------------------------------
# P3b (h) — ok-variant (ok:retried) is preserved by LIKE 'ok%' (not ='ok')
# ---------------------------------------------------------------------------

@test "P3b: ok:retried is admitted (LIKE 'ok%' preserves the variant)" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok:retried"

  # Admitted → reaches the landing-zone reject (exit 9), proving the variant passes.
  [[ "${status}" -eq 9 ]]
  grep -q '"reason":"landing_zone_reject"' "$(applied_log_path)"
}

# ---------------------------------------------------------------------------
# P3b (i) — SQL-shape + default-flag pin (predicate text is independently fixed)
# ---------------------------------------------------------------------------

@test "P3b: single SELECT carries haiku_status LIKE 'ok%' + carve-out, never ='ok', default flag 0" {
  make_probe
  STUB_STALE_VERDICT="incremented"
  run_single "ok"

  # The exact predicate text reached psql (independent of the stub's own logic).
  grep -q "haiku_status LIKE 'ok%'" "${PSQL_LOG}"
  grep -q ":'allow_haiku_skip' = '1' OR" "${PSQL_LOG}"
  # The brittle exact-match form is NOT used (would drop ok:retried / ok:fuzzy-parsed).
  run grep -qE "haiku_status[[:space:]]*=[[:space:]]*'ok'" "${PSQL_LOG}"
  [[ "${status}" -ne 0 ]]
  # Default (no env) → carve-out OFF.
  grep -q 'allow_haiku_skip=0' "${PSQL_LOG}"
}
