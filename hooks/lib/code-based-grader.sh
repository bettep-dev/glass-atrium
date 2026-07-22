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
      # Step 4-5 transcript cross-check (plan T2, ADR-6) gates the promotion. A claimed
      # path demonstrably absent from a non-empty Write/Edit history → verified_fail
      # (AC 264); an unverifiable transcript or empty write-history → withhold → unverified
      # (AC 265); unwired ('' scan) → the pure files-evidence/body path below (held Steps 1-3).
      case "$(_cbg_write_crosscheck "${files}")" in
        contradicted) printf 'verified_fail\n' ;;
        withhold) printf 'unverified\n' ;;
        *)
          # Either signal promotes: (a) block-resident test/spec (word-bounded, common
          # inflections) co-occurring with pass / green / "exit 0" — the existing
          # body-attested signal; boundaries stop bare-substring false promotes
          # ("laTEST passWORD" no longer matches). (b) the W1 files-evidence rule — ≥1
          # EXISTING test/spec-shaped path, so a bug-fix naming a real test artifact
          # promotes even without the body phrasing.
          if { [[ "${body}" =~ (^|[^[:alpha:]])(test|spec)(s|ed|ing)?([^[:alpha:]]|$) ]] &&
            [[ "${body}" =~ (^|[^[:alpha:]])(pass(es|ed|ing)?|green|exit[[:space:]]0)([^[:alpha:]]|$) ]]; } ||
            _cbg_files_test_evidence "${files}"; then
            printf 'verified_pass\n'
          else
            printf 'unverified\n'
          fi
          ;;
      esac
      ;;
    feature)
      # W1 files-evidence (Step 1-3): promotion requires ≥1 EXISTING test/spec-shaped
      # path. The prior arm regex-matched the files STRING with no stat, so a
      # NON-EXISTENT test-shaped path promoted — weaker than the defect it fixed.
      # Glob / no-path-shaped / non-existent all resolve to unverified, NEVER
      # verified_fail (W2 — a deleted file is indistinguishable from fabrication at
      # this tier; live data shows 0 verified_fail in 2081 rows).
      # Step 4-5 transcript cross-check (plan T2, ADR-6) gates that promotion: a claimed
      # path absent from a non-empty write-history → verified_fail; unverifiable / empty
      # history → withhold; unwired → the files-evidence verdict stands.
      case "$(_cbg_write_crosscheck "${files}")" in
        contradicted) printf 'verified_fail\n' ;;
        withhold) printf 'unverified\n' ;;
        *)
          if _cbg_files_test_evidence "${files}"; then
            printf 'verified_pass\n'
          else
            printf 'unverified\n'
          fi
          ;;
      esac
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

# _cbg_files_test_evidence — the files-evidence rule (plan Step 1-3, W1/W2) for the
# code arms (bug-fix / feature). Reads its single positional arg (the files field);
# returns 0 when the field carries at least one EXISTING test/spec-shaped path
# (→ promote), 1 otherwise (→ unverified). The result is BINARY: a non-promote is
# ALWAYS unverified — this rule NEVER mints verified_fail (W2: a resolution/existence
# failure is indistinguishable from a legitimate deletion). Reads HOME for ~ expansion.
#
# Step 1 normalize + classify each comma-split entry: expand a leading ~ to $HOME; a
#   glob metacharacter (* ? [ { }) makes the WHOLE field non-gradeable → no promote;
#   path-shaped = contains a path separator OR any dot-extension (an INDEPENDENT shape
#   predicate — NOT the old feature-arm extension list, which omits md/json/html/diff).
# Step 2 no path-shaped entry → indeterminate → no promote.
# Step 3 promotion requires ≥1 EXISTING test/spec-shaped path (existence of unrelated
#   files promotes nothing).
# Manual comma-split (no unquoted expansion) so a literal glob entry is never
# pathname-expanded against the real filesystem. Bash 3.2 safe.
_cbg_files_test_evidence() {
  local rest="${1:-}"
  local entry base saw_path_shaped="" found_test=""
  while [[ -n "${rest}" ]]; do
    if [[ "${rest}" == *,* ]]; then
      entry="${rest%%,*}"
      rest="${rest#*,}"
    else
      entry="${rest}"
      rest=""
    fi
    # trim surrounding whitespace (Bash 3.2 safe).
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -z "${entry}" ]] && continue
    # glob metacharacter anywhere → non-gradeable → the whole field is unverified.
    case "${entry}" in
      *'*'* | *'?'* | *'['* | *'{'* | *'}'*) return 1 ;;
    esac
    # leading ~ → $HOME (live entries use this form). SC2088 is a false positive:
    # the '~/'* pattern DETECTS a literal leading ~/ to expand it ourselves — it is
    # not a tilde meant for shell expansion.
    # shellcheck disable=SC2088
    if [[ "${entry}" == '~' ]]; then
      entry="${HOME}"
    elif [[ "${entry}" == '~/'* ]]; then
      entry="${HOME}/${entry#\~/}"
    fi
    # path-shaped: a path separator OR any dot-extension (independent predicate).
    if [[ "${entry}" == */* ]] || [[ "${entry}" =~ \.[[:alnum:]]+$ ]]; then
      saw_path_shaped=1
    else
      continue
    fi
    # test/spec-shaped basename gated on existence (W1). Covers .test./.spec./*.bats/
    # test_*.<ext>/<name>_test.<ext>/<name>_spec.<ext> — the common live forms.
    base="${entry##*/}"
    case "${base}" in
      *.test.* | *.spec.* | *.bats | test_*.* | *_test.* | *_spec.*)
        [[ -e "${entry}" ]] && found_test=1
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
    case "${wp}" in *"${claimed}"*) return 0 ;; esac
    case "${claimed}" in *"${wp}"*) return 0 ;; esac
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
# Parse mirrors _cbg_files_test_evidence (comma-split, trim, glob-detect, ~-expand,
# path-shape predicate) so gradeability stays consistent between grounding and cross-check.
_cbg_write_crosscheck() {
  local files="${1:-}"
  local scan="${GRADER_WRITE_SCAN:-}"
  local writes="${GRADER_WRITE_PATHS:-}"
  # unwired → files-evidence only (backward-compatible default).
  [[ -z "${scan}" ]] && { printf 'na\n'; return 0; }
  # attempted but degraded → withhold promotion (AC 265).
  if [[ "${scan}" != "verifiable" ]]; then
    printf 'withhold\n'
    return 0
  fi
  local rest="${files}" entry saw_path_shaped="" any_unmatched="" glob_seen=""
  while [[ -n "${rest}" ]]; do
    if [[ "${rest}" == *,* ]]; then
      entry="${rest%%,*}"
      rest="${rest#*,}"
    else
      entry="${rest}"
      rest=""
    fi
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -z "${entry}" ]] && continue
    # a glob metacharacter makes the whole field non-gradeable → indeterminate (Step 1).
    case "${entry}" in
      *'*'* | *'?'* | *'['* | *'{'* | *'}'*)
        glob_seen=1
        break
        ;;
    esac
    # shellcheck disable=SC2088
    if [[ "${entry}" == '~' ]]; then
      entry="${HOME}"
    elif [[ "${entry}" == '~/'* ]]; then
      entry="${HOME}/${entry#\~/}"
    fi
    # path-shaped: a path separator OR any dot-extension (independent predicate).
    if [[ "${entry}" == */* ]] || [[ "${entry}" =~ \.[[:alnum:]]+$ ]]; then
      saw_path_shaped=1
      _cbg_path_matches_writes "${entry}" "${writes}" || any_unmatched=1
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
