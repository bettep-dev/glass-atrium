#!/usr/bin/env bash
# code-based-grader.sh — Code-Based tier of the 3-Tier Eval grader. Declaration-only,
# sourced by track-outcome.sh (single SoT, no per-caller drift). Bash 3.2+ (macOS stock).
#
# code_based_grader_check → per-task-type deterministic 3-state verdict
#   (verified_pass | unverified | verified_fail) — advisory: never overwrites the writer
#   self-reported metric_pass (core-outcome-record.md T1).

# Double-source guard.
# shellcheck disable=SC2317
#   SC2317-unreachable is a source-context-unaware false-positive on this return-after-||-true guard.
if [[ -n "${_CODE_BASED_GRADER_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
readonly _CODE_BASED_GRADER_LOADED=1

# code_based_grader_check — deterministic 3-state verdict on the author-side metric_pass.
#
# Inputs (all caller-scope, set in track-outcome.sh — SC2154 silenced below):
#   TASK_TYPE, METRIC_PASS, RESULT, ATTRIBUTION_SOURCE, GRADER_BODY_TEXT, GRADER_FILES_FIELD.
#   The files-evidence rule additionally reads HOME (env) to expand a leading ~ in a
#   files entry before stat — live rows carry the ~ form.
#   The Step 4-5 transcript cross-check additionally reads GRADER_WRITE_SCAN
#   (verifiable | unverifiable | '') + GRADER_WRITE_PATHS (newline-separated Write/Edit
#   history from the subagent's OWN transcript). Both are OPTIONAL — an unwired ('')
#   scan preserves the pure files-evidence path (backward-compatible; the direct unit test).
#
# Outputs (stdout, single token — 3-state per core-outcome-record.md T1):
#   verified_pass — metric_pass=true claim corroborated by block-resident evidence.
#   unverified    — no verification applicable (infra / non-success / non-code / metric_pass≠true /
#                   off-surface / absent signal — the DEFAULT for every code type).
#   verified_fail — narrow LLM09 zero-evidence guard ONLY: result=done + metric_pass=true + ZERO
#                   deliverable evidence of ANY kind. Off-surface-heading absence is NOT this case.
#
# Input-surface invariant (core-outcome-record.md grader_verdict guide): the grader reads ONLY
#   block-resident text + files: paths — NEVER the off-surface deliverable (plan/research doc,
#   diff/test files). So plan/research/refactor default to unverified by task_type alone, and the
#   per-type marker regexes that keyed on off-surface artifacts are REMOVED (structurally
#   guaranteed false-fails). Every retained check gates on a STRUCTURED field; prose never signals.
#
# Contract: function always exits 0 (verdict on stdout), READs caller-scope only (no mutation);
#   the verdict is ADVISORY (a SEPARATE column) — the caller MUST NOT overwrite metric_pass from it.
#   Infra attribution → unconditional unverified; the 4 non-code task_types (review/diagnosis/doc/
#   cleanup) → explicit skip → unverified (no test artifact expected, NOT a fail). No LLM/external call.
#
# shellcheck disable=SC2154
#   TASK_TYPE / METRIC_PASS / RESULT / ATTRIBUTION_SOURCE / GRADER_BODY_TEXT / GRADER_FILES_FIELD /
#   GRADER_WRITE_SCAN / GRADER_WRITE_PATHS are caller-scope — set in track-outcome.sh
#   (Bats test uses the same setup).
code_based_grader_check() {
  # 1) infra attribution → unverified (author-side only).
  case "${ATTRIBUTION_SOURCE:-}" in
    subagent-stop-missing | agent-id-missing | completion-missing | conversation-only)
      printf 'unverified\n'
      return 0
      ;;
    *) ;;
  esac

  # 2) non-success-family result → unverified (nothing to verify).
  case "${RESULT:-}" in
    done | done_with_concerns) ;;
    *)
      printf 'unverified\n'
      return 0
      ;;
  esac

  # 3) non-code task_types → explicit skip → unverified (no test artifact expected, NOT a fail).
  case "${TASK_TYPE:-}" in
    review | diagnosis | doc | cleanup)
      printf 'unverified\n'
      return 0
      ;;
    *) ;;
  esac

  # 4) writer did not claim metric_pass=true → unverified.
  if [[ "${METRIC_PASS:-}" != "true" ]]; then
    printf 'unverified\n'
    return 0
  fi

  local body="${GRADER_BODY_TEXT:-}"
  local files="${GRADER_FILES_FIELD:-}"

  # 5) narrow LLM09 zero-evidence guard — the SINGLE verified_fail path (all task_types):
  # result=done + metric_pass=true + ZERO evidence of ANY kind. Off-surface-heading absence is NOT this.
  if _cbg_zero_evidence "${body}" "${files}"; then
    printf 'verified_fail\n'
    return 0
  fi

  # 6) per-task-type verified_pass check. DEFAULT = unverified (off-surface / no structured signal).
  # Only a block-resident structured field promotes; absence → unverified, NEVER verified_fail (step 5 only).
  case "${TASK_TYPE:-}" in
    bug-fix)
      # W1 files-evidence rule, same promotion signal as the feature arm: ≥1 EXISTING test/spec-shaped
      # path in files:. Body phrasing NEVER promotes — prose is writer-authored free text (Gaming-the-
      # Judge), and a prose-only promotion carries no path for the Step 4-5 cross-check (track-outcome.sh
      # gates the write-scan on a non-empty files: field), so it would land unchecked. Empty files: →
      # no promotion → unverified. _cbg_gated_verdict then applies the shared Step 4-5 cross-check
      # routing (contradicted → verified_fail; withhold → unverified).
      local promote=0
      if _cbg_files_test_evidence "${files}"; then
        promote=1
      fi
      _cbg_gated_verdict "${promote}" "${files}"
      ;;
    feature)
      # W1 files-evidence (Step 1-3): promotion requires ≥1 EXISTING test/spec-shaped path. A
      # non-existent / glob / no-path-shaped field resolves to unverified, NEVER verified_fail (W2 —
      # a deleted file is indistinguishable from fabrication at this tier; live data shows 0
      # verified_fail in 2081 rows). _cbg_gated_verdict then applies the shared Step 4-5 cross-check
      # routing (contradicted → verified_fail; withhold → unverified).
      local promote=0
      if _cbg_files_test_evidence "${files}"; then
        promote=1
      fi
      _cbg_gated_verdict "${promote}" "${files}"
      ;;
    refactor | plan | research)
      # No reliable block-resident structured signal → unverified by task_type ALONE:
      #   refactor — the gameable free-text "existing tests pass" check is DROPPED (Gaming-the-Judge avoidance).
      #   plan/research — their markers live off-surface in the separate doc, invisible to the grader.
      printf 'unverified\n'
      ;;
    *)
      # unknown task_type → unverified. LOCKSTEP SoT: off-role reclassification runs upstream in
      # track-outcome.sh (role default) before this grader sees TASK_TYPE. Third consumer of the
      # shared Role → Allowed contract — must agree with guess_task_type + _norm_task_type.
      printf 'unverified\n'
      ;;
  esac
}

# _cbg_zero_evidence — true when the deliverable carries ZERO evidence of ANY kind: blank files:
# field AND no source/URL AND empty body (any one present → false). Drives the single verified_fail
# path (narrow LLM09 misinformation guard); reads its two positional args, no caller-scope var.
_cbg_zero_evidence() {
  local body="${1:-}"
  local files="${2:-}"
  if [[ -n "${files//[[:space:]]/}" ]]; then
    return 1
  fi
  if [[ "${body}" =~ [Ss]ources?: ]] || [[ "${body}" =~ https?:// ]]; then
    return 1
  fi
  if [[ -n "${body//[[:space:]]/}" ]]; then
    return 1
  fi
  return 0
}

# _cbg_classify_entry — SINGLE owner of the per-entry gradeability rules shared by the grounding
# (files-evidence) and cross-check loops: trim surrounding whitespace, flag a glob metacharacter
# (* ? [ { } → the whole field is non-gradeable), expand a leading ~ to $HOME, and flag path-shape
# (a path separator OR any dot-extension). Reads its one positional arg (a raw comma-split entry).
# Bash 3.2 dynamic scope, no subshell — sets three caller-declared vars:
#   _cbg_entry   — trimmed + ~-expanded entry (empty when the raw entry was blank OR a glob)
#   _cbg_is_glob — 1 when a glob metacharacter is present
#   _cbg_is_path — 1 when the entry is path-shaped
# Centralizing here makes the "gradeability is identical between grounding and cross-check"
# invariant STRUCTURAL, not a comment two divergent copies had to honor by hand.
# shellcheck disable=SC2034
#   _cbg_entry / _cbg_is_glob / _cbg_is_path are output vars consumed via dynamic scope in the
#   callers — shellcheck cannot see the cross-function read.
_cbg_classify_entry() {
  local entry="${1}"
  _cbg_entry=""
  _cbg_is_glob=""
  _cbg_is_path=""
  # trim surrounding whitespace (Bash 3.2 safe).
  entry="${entry#"${entry%%[![:space:]]*}"}"
  entry="${entry%"${entry##*[![:space:]]}"}"
  [[ -z "${entry}" ]] && return 0
  # glob metacharacter anywhere → non-gradeable.
  case "${entry}" in
    *'*'* | *'?'* | *'['* | *'{'* | *'}'*)
      _cbg_is_glob=1
      return 0
      ;;
    *) ;;
  esac
  # leading ~ → $HOME (live entries use this form). SC2088 is a false positive: the '~/'* pattern
  # DETECTS a literal leading ~/ to expand it ourselves — not a tilde meant for shell expansion.
  # shellcheck disable=SC2088
  if [[ "${entry}" == '~' ]]; then
    entry="${HOME}"
  elif [[ "${entry}" == '~/'* ]]; then
    entry="${HOME}/${entry#\~/}"
  fi
  # path-shaped: a path separator OR any dot-extension (independent predicate).
  if [[ "${entry}" == */* ]] || [[ "${entry}" =~ \.[[:alnum:]]+$ ]]; then
    _cbg_is_path=1
  fi
  _cbg_entry="${entry}"
}

# _cbg_files_test_evidence — the files-evidence rule (plan Step 1-3, W1/W2) for the
# code arms (bug-fix / feature). Reads its single positional arg (the files field);
# returns 0 when the field carries at least one EXISTING test/spec-shaped path
# (→ promote), 1 otherwise (→ unverified). The result is BINARY: a non-promote is
# ALWAYS unverified — this rule NEVER mints verified_fail (W2: a resolution/existence
# failure is indistinguishable from a legitimate deletion). Reads HOME for ~ expansion.
#
# Per-entry parse (trim / glob-detect / ~-expand / path-shape) is delegated to
# _cbg_classify_entry so it stays identical to the cross-check. This arm keeps only:
#   Step 1 a glob anywhere → non-gradeable → no promote.
#   Step 2 no path-shaped entry → indeterminate → no promote.
#   Step 3 promotion requires ≥1 EXISTING test/spec-shaped path (unrelated files promote nothing).
# Manual comma-split (no unquoted expansion) so a literal glob entry is never
# pathname-expanded against the real filesystem. Bash 3.2 safe.
_cbg_files_test_evidence() {
  local rest="${1:-}"
  local entry base saw_path_shaped="" found_test=""
  local _cbg_entry _cbg_is_glob _cbg_is_path
  while [[ -n "${rest}" ]]; do
    if [[ "${rest}" == *,* ]]; then
      entry="${rest%%,*}"
      rest="${rest#*,}"
    else
      entry="${rest}"
      rest=""
    fi
    _cbg_classify_entry "${entry}"
    # a glob makes the WHOLE field non-gradeable → unverified.
    [[ -n "${_cbg_is_glob}" ]] && return 1
    [[ -n "${_cbg_is_path}" ]] || continue
    saw_path_shaped=1
    # test/spec-shaped basename gated on existence (W1). Covers .test./.spec./*.bats/
    # test_*.<ext>/<name>_test.<ext>/<name>_spec.<ext> — the common live forms.
    base="${_cbg_entry##*/}"
    case "${base}" in
      *.test.* | *.spec.* | *.bats | test_*.* | *_test.* | *_spec.*)
        [[ -e "${_cbg_entry}" ]] && found_test=1
        ;;
      *) ;;
    esac
  done
  [[ -n "${saw_path_shaped}" ]] || return 1
  [[ -n "${found_test}" ]] && return 0
  return 1
}

# _cbg_path_matches_writes — true when the claimed path ($1) matches any newline-
# separated write-history entry ($2). Mirrors style_ref_match.py::style_ref_matches:
# bidirectional substring containment OR basename equality — lenient by design so a
# repo-root-relative claim still matches its ABSOLUTE write-history entry (never a false
# contradiction). $1 is already ~-expanded and glob-free (the caller filters globs), so
# the quoted case patterns match literally. Bash 3.2 safe.
_cbg_path_matches_writes() {
  local claimed="${1:-}" writes="${2:-}" wp cbase
  [[ -z "${claimed}" ]] && return 1
  cbase="${claimed##*/}"
  while IFS= read -r wp; do
    [[ -z "${wp}" ]] && continue
    case "${wp}" in *"${claimed}"*) return 0 ;; *) ;; esac
    case "${claimed}" in *"${wp}"*) return 0 ;; *) ;; esac
    [[ -n "${cbase}" && "${cbase}" == "${wp##*/}" ]] && return 0
  done <<<"${writes}"
  return 1
}

# _cbg_write_crosscheck — Step 4-5 transcript Write/Edit cross-check (plan T2, ADR-6).
# Reads the files field ($1) plus two caller-scope inputs set by track-outcome.sh from
# the subagent's OWN transcript via style_ref_match.py::collect_write_paths:
#   GRADER_WRITE_SCAN  = verifiable | unverifiable | '' (unwired)
#   GRADER_WRITE_PATHS = newline-separated Write/Edit file_path history (verifiable only)
# Emits ONE state token on stdout:
#   na           — cross-check inapplicable: unwired ('' scan, e.g. the direct grader unit
#                  test), OR a glob / no-path-shaped files field (indeterminate per Step 1).
#                  The caller falls back to the files-evidence verdict (held Steps 1-3).
#   verified     — every claimed path-shaped entry matched the write-history.
#   contradicted — >=1 claimed path-shaped entry demonstrably ABSENT from a NON-EMPTY
#                  write-history (AC 264). The ONLY transcript-cross-check verified_fail.
#   withhold     — unverifiable transcript (main-session / unreadable / missing lib) OR an
#                  EMPTY write-history (AC 265). Withhold promotion → unverified, NEVER a
#                  verified_fail: an empty history cannot DEMONSTRATE absence (Write/Edit is
#                  blind to Bash-authored writes), so absence rests at unverified (W2 spirit).
# Parse delegated to _cbg_classify_entry (comma-split stays local; trim / glob-detect / ~-expand /
# path-shape live in the shared classifier) so gradeability stays consistent between grounding and
# cross-check.
_cbg_write_crosscheck() {
  local files="${1:-}"
  local scan="${GRADER_WRITE_SCAN:-}"
  local writes="${GRADER_WRITE_PATHS:-}"
  # unwired → files-evidence only (backward-compatible default).
  [[ -z "${scan}" ]] && {
    printf 'na\n'
    return 0
  }
  # attempted but degraded → withhold promotion (AC 265).
  if [[ "${scan}" != "verifiable" ]]; then
    printf 'withhold\n'
    return 0
  fi
  local rest="${files}" entry saw_path_shaped="" any_unmatched="" glob_seen=""
  local _cbg_entry _cbg_is_glob _cbg_is_path
  while [[ -n "${rest}" ]]; do
    if [[ "${rest}" == *,* ]]; then
      entry="${rest%%,*}"
      rest="${rest#*,}"
    else
      entry="${rest}"
      rest=""
    fi
    _cbg_classify_entry "${entry}"
    # a glob makes the whole field non-gradeable → indeterminate (Step 1).
    if [[ -n "${_cbg_is_glob}" ]]; then
      glob_seen=1
      break
    fi
    if [[ -n "${_cbg_is_path}" ]]; then
      saw_path_shaped=1
      _cbg_path_matches_writes "${_cbg_entry}" "${writes}" || any_unmatched=1
    fi
  done
  # glob present OR no path-shaped entry → indeterminate → na (Step 1 → unverified).
  if [[ -n "${glob_seen}" ]] || [[ -z "${saw_path_shaped}" ]]; then
    printf 'na\n'
    return 0
  fi
  # empty write-history → cannot demonstrate absence → withhold (never verified_fail).
  if [[ -z "${writes//[[:space:]]/}" ]]; then
    printf 'withhold\n'
    return 0
  fi
  if [[ -n "${any_unmatched}" ]]; then
    printf 'contradicted\n'
  else
    printf 'verified\n'
  fi
}

# _cbg_gated_verdict — the Step 4-5 cross-check routing shared by the bug-fix + feature arms. Each
# arm computes its own promotion decision ($1: 1=promote, 0=not) from its distinct evidence rule;
# this owns only the routing that is identical between them: contradicted → verified_fail, withhold
# → unverified, else → (promote ? verified_pass : unverified). Args: $1=promote(0|1) · $2=files field.
_cbg_gated_verdict() {
  local promote="${1}" files="${2}"
  case "$(_cbg_write_crosscheck "${files}")" in
    contradicted) printf 'verified_fail\n' ;;
    withhold) printf 'unverified\n' ;;
    *)
      if [[ "${promote}" -eq 1 ]]; then
        printf 'verified_pass\n'
      else
        printf 'unverified\n'
      fi
      ;;
  esac
}
