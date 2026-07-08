#!/usr/bin/env bats
# T0 golden-fixture correctness suite (Track B stage 0, plan §7 U2). Each fixture is a
# small file with KNOWN, hand-labeled comment/code/preserve counts; the classifier output
# MUST equal the labels exactly. Every downstream gate (ratio, no-code-change, preserve
# floor, banner) reduces to this classifier being correct, so T0 is not accepted until
# all of these pass. The hand labels are derived from the §7 contract, never from the
# classifier output (no fudging to mask a bug).
#
# Run via: bats test/comment-audit/classifier.bats

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export CL="${BATS_TEST_DIRNAME}/comment-classifier.sh"
export FX="${BATS_TEST_DIRNAME}/fixtures"

setup() {
  [[ -f "${CL}" ]] || skip "classifier not found: ${CL}"
  [[ -d "${FX}" ]] || skip "fixtures not found: ${FX}"
  command -v awk >/dev/null 2>&1 || skip "awk required"
}

# Classify one fixture and split its single TSV row into the CMT/COD/RAT/SHC/SEC/XRF/BNR
# globals used by the assertions below.
classify_cols() {
  local row
  row="$("${CL}" classify "${FX}/$1")"
  CMT="$(printf '%s' "${row}" | cut -f2)"
  COD="$(printf '%s' "${row}" | cut -f3)"
  RAT="$(printf '%s' "${row}" | cut -f4)"
  SHC="$(printf '%s' "${row}" | cut -f5)"
  SEC="$(printf '%s' "${row}" | cut -f6)"
  XRF="$(printf '%s' "${row}" | cut -f7)"
  BNR="$(printf '%s' "${row}" | cut -f8)"
}

# --- D1 parameter-expansion hash -------------------------------------------

@test "fx-param-expand: every hash is an operator, none a comment" {
  classify_cols fx-param-expand.sh
  [ "${CMT}" -eq 0 ]
  [ "${COD}" -eq 7 ]
  [ "${XRF}" -eq 0 ]
  [ "${BNR}" -eq 0 ]
}

@test "fx-param-plus-comment: operator hash ignored, trailing comment counted (mixed line)" {
  classify_cols fx-param-plus-comment.sh
  [ "${CMT}" -eq 3 ]
  [ "${COD}" -eq 3 ]
  [ "${SHC}" -eq 0 ]
  [ "${SEC}" -eq 0 ]
}

# --- D2 heredoc state machine ----------------------------------------------

@test "fx-heredoc-quoted: <<'EOF' body hash lines are body, not comments" {
  classify_cols fx-heredoc-quoted.sh
  [ "${CMT}" -eq 0 ]
  [ "${COD}" -eq 6 ]
}

@test "fx-heredoc-tabstrip: <<-EOF tab-stripped body hash lines are not comments" {
  classify_cols fx-heredoc-tabstrip.sh
  [ "${CMT}" -eq 0 ]
  [ "${COD}" -eq 5 ]
}

@test "fx-heredoc-nested: stacked heredocs track depth, no premature close" {
  classify_cols fx-heredoc-nested.sh
  [ "${CMT}" -eq 0 ]
  [ "${COD}" -eq 7 ]
}

# --- D3 baseline consistency (classifier vs naive) -------------------------

@test "fx-baseline-consistency: classifier differs from naive by exactly the heredoc-body delta" {
  classify_cols fx-baseline-consistency.sh
  [ "${CMT}" -eq 1 ]
  [ "${COD}" -eq 7 ]
  local naive
  naive="$(grep -c '^[[:space:]]*#' "${FX}/fx-baseline-consistency.sh")"
  [ "${naive}" -eq 4 ]
  [ "$((naive - CMT))" -eq 3 ]
}

# --- preserve counters (shellcheck / SECURITY) -----------------------------

@test "fx-shellcheck-security: shellcheck/security exact, ordinary comment not miscounted" {
  classify_cols fx-shellcheck-security.sh
  [ "${CMT}" -eq 5 ]
  [ "${COD}" -eq 2 ]
  [ "${SHC}" -eq 2 ]
  [ "${SEC}" -eq 2 ]
  [ "${XRF}" -eq 0 ]
  [ "${BNR}" -eq 0 ]
}

# --- extref regex (string-aware) -------------------------------------------

@test "fx-extref.sh: real refs counted, in-string URL not counted" {
  classify_cols fx-extref.sh
  [ "${CMT}" -eq 6 ]
  [ "${COD}" -eq 2 ]
  [ "${XRF}" -eq 6 ]
  [ "${SEC}" -eq 0 ]
}

@test "fx-extref.ts: real refs counted, in-string URL/A01 not counted" {
  classify_cols fx-extref.ts
  [ "${CMT}" -eq 4 ]
  [ "${COD}" -eq 2 ]
  [ "${XRF}" -eq 4 ]
  [ "${SEC}" -eq 0 ]
}

# --- TS block comment span + in-string opener ------------------------------

@test "fx-block-comment.ts: block-span counted, in-string /* not counted" {
  classify_cols fx-block-comment.ts
  [ "${CMT}" -eq 5 ]
  [ "${COD}" -eq 3 ]
  [ "${XRF}" -eq 0 ]
  [ "${BNR}" -eq 0 ]
}

# --- banner detection (exclusion-aware) ------------------------------------

@test "fx-banner-exclusions: true banners only; pragmas/regions/sentinels/in-string excluded" {
  classify_cols fx-banner-exclusions.sh
  [ "${CMT}" -eq 7 ]
  [ "${COD}" -eq 3 ]
  [ "${BNR}" -eq 3 ]
  [ "${SHC}" -eq 1 ]
}

# --- robustness (zero-preserve + div-by-zero) ------------------------------

@test "fx-zero-preserve: every preserve counter reads integer 0 (not blank, no double-line)" {
  classify_cols fx-zero-preserve.sh
  [ "${CMT}" -eq 1 ]
  [ "${COD}" -eq 4 ]
  # Exact string "0" (not "" and not a two-line "0\n0" grep-trap value).
  [ "${SHC}" = "0" ]
  [ "${SEC}" = "0" ]
  [ "${XRF}" = "0" ]
  [ "${BNR}" = "0" ]
  [ "${SHC}" -eq 0 ]
  [ "${SEC}" -eq 0 ]
  [ "${XRF}" -eq 0 ]
  [ "${BNR}" -eq 0 ]
}

@test "fx-zero-code: code_lines=0 emits comment-only sentinel, no division" {
  classify_cols fx-zero-code.sh
  [ "${CMT}" -eq 3 ]
  [ "${COD}" -eq 0 ]
  [ "${RAT}" = "comment-only" ]
}

# --- artifact / surface sanity ---------------------------------------------

@test "classifier is bash -n clean and its GA root resolves" {
  [[ -n "${GA}" && -d "${GA}" ]]
  run bash -n "${CL}"
  [ "${status}" -eq 0 ]
}
