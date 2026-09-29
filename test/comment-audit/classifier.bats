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

# --- baseline scratch cleanup ----------------------------------------------

# Throwaway repo with one file per build_surface root: the live install ships neither
# install.sh nor build-glass-atrium.sh, so baseline cannot run against the real root there.
make_baseline_repo() {
  local repo="$1" rel
  for rel in lib/ga-x.sh hooks/x.sh hooks/lib/x.sh scripts/x.sh scripts/lib/x.sh \
    monitor/scripts/oss-db-setup.sh build-glass-atrium.sh install.sh \
    hooks/test/x.bats scripts/test/x.bats monitor/src/server/x.ts; do
    mkdir -p -- "$(dirname -- "${repo}/${rel}")"
    printf '# c\n:\n' >"${repo}/${rel}"
  done
  mkdir -p -- "${repo}/test/comment-audit"
  cp -- "${CL}" "${BATS_TEST_DIRNAME}/classify.awk" "${repo}/test/comment-audit/"
  cp -- "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh" "${repo}/scripts/lib/"
}

@test "baseline removes both scratch files it creates and leaves only the --out artifact" {
  local root="${BATS_TEST_TMPDIR:?}" real path count
  local repo="${root}/repo" shim="${root}/shim" out="${root}/baseline.tsv" log="${root}/mktemp.log"
  real="$(command -v mktemp)"
  make_baseline_repo "${repo}"
  mkdir -p -- "${shim}"
  # Records each path mktemp hands out: macOS `mktemp -t` ignores TMPDIR, so a scratch TMPDIR proves nothing.
  cat >"${shim}/mktemp" <<SHIM
#!/usr/bin/env bash
p="\$("${real}" "\$@")" || exit
printf '%s\n' "\${p}" >>"${log}"
printf '%s\n' "\${p}"
SHIM
  chmod +x "${shim}/mktemp"

  run env PATH="${shim}:${PATH}" bash "${repo}/test/comment-audit/comment-classifier.sh" baseline --out "${out}"

  [[ "${status}" -eq 0 ]] || {
    echo "baseline rc=${status}: ${output}"
    return 1
  }
  [[ -s "${out}" ]] || {
    echo "no artifact at ${out}"
    return 1
  }
  count="$(wc -l <"${log}")"
  [[ "${count// /}" -eq 2 ]] || {
    echo "expected 2 scratch files, got ${count// /}:"
    cat -- "${log}"
    return 1
  }
  while IFS= read -r path; do
    [[ ! -e "${path}" ]] || {
      echo "scratch left behind: ${path}"
      return 1
    }
  done <"${log}"
}
