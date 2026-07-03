#!/usr/bin/env bats
# TUI-vs-engine step-plan sync guard (glass-atrium build_step_plan ⇄ ga-core.sh).
#
# The interactive menu drives the install/uninstall ENGINE (lib/ga-core.sh) via
# three PARALLEL index-aligned arrays (STEP_LABEL / STEP_LABEL_ACTIVE / STEP_FN)
# hand-mirrored per action in glass-atrium's build_step_plan. Because that mirror
# is maintained by hand and NO test pinned it to the engine, a step added to the
# engine could silently go missing from the TUI — which is exactly how BOTH the
# uninstall and the install (capture_install_baseline) drifts slipped in.
#
# This guard closes that blind spot. For each action it:
#   * DERIVES the authoritative engine call order LIVE from ga-core.sh (grep/awk
#     over the real function bodies — NOT a hardcoded list — so a future engine
#     step is picked up automatically);
#   * SOURCES glass-atrium and reads the REAL build_step_plan arrays;
#   * asserts STEP_FN == the derived engine order, element-for-element;
#   * asserts the three parallel arrays are equal-length.
#
# Engine ⇄ TUI order:
#   install   = run_install body (steps 1-9) ++ run_bootstrap tail (monitor build
#               → health gate → launchd load)
#   uninstall = run_uninstall's UNCONDITIONAL engine calls
#
# Two DELIBERATE divergences are normalized so the guard does not false-alarm:
#   1. install's load step is menu_load_launchd_jobs (a TUI wrapper that flips
#      LOAD_LAUNCHD=true) where the engine tail calls load_launchd_jobs — intended.
#   2. uninstall's purge_config is intentionally EXCLUDED from the base plan (it is
#      a separate typed-confirm step in dispatch_action). It lives inside the
#      `if "${PURGE_CONFIG}"` block, so the top-level extractor drops it naturally.
# Plus two TUI wrapper renames for engine-INLINE boundaries (behavior-identical
# mirrors, not semantic divergences): run_doctor "preflight" → run_doctor_preflight
# and the inline `npm run build` phase → build_monitor.
#
# Run via: bats test/step-plan-sync.bats
# Requires: bats (brew install bats-core), awk, bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CORE="${GA}/lib/ga-core.sh"
TUI="${GA}/glass-atrium"

setup() {
  [[ -f "${CORE}" ]] || skip "ga-core.sh not found: ${CORE}"
  [[ -f "${TUI}" ]] || skip "glass-atrium not found: ${TUI}"
  command -v awk >/dev/null 2>&1 || skip "awk required"
}

# === engine side — derive the authoritative order LIVE from ga-core.sh =======

# Print the body lines of a shell function (strictly between the "<name>() {"
# header and the column-0 "}" that closes it). Nested blocks stay indented, so a
# column-0 "}" only ever terminates the function itself.
func_body() {
  awk -v fn="$1() {" '
    $0 == fn { inside = 1; next }
    inside && $0 == "}" { inside = 0 }
    inside { print }
  ' "${CORE}"
}

# From a function body on stdin, emit the ordered TOP-LEVEL (2-space-indent)
# engine step calls, one per line, verbatim (command + args). Top-level indent
# isolates the real steps: comments, keywords/builtins, assignments, compound
# openers, and brace/paren closers are dropped; anything inside an `if`/subshell
# (deeper indent) is out of scope by design (e.g. uninstall's gated purge_config).
#
# mode=tail (run_bootstrap only): additionally skips everything up to and
# including the run_install splice line, and maps the inline `npm run build`
# phase to the TUI's build_monitor wrapper token.
engine_calls() {
  awk -v mode="${1:-plain}" '
    /^  [^ ]/ {
      line = $0
      sub(/^  /, "", line)                              # strip the top-level indent
      if (line ~ /^#/) next                             # comment
      if (line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) next       # assignment
      word = line; sub(/[ \t].*$/, "", word)            # first token
      if (word ~ /^(local|set|trap|return|if|then|fi|else|elif|for|while|do|done|case|esac|log|die|command|printf|echo|cd|exit|export|readonly|shift|unset|mkdir|rm|cp|mv|ln|eval|wait|read|continue|break|declare|source)$/) next
      if (mode == "tail" && !started) {                 # skip the spliced-in run_install
        if (word == "run_install") started = 1
        next
      }
      if (mode == "tail" && line ~ /npm run build/) { print "build_monitor"; next }
      if (line ~ /^(\[\[|\(\(|\(|\{|\}|\))/) next        # compound opener / block closer
      print line
    }
  '
}

# Map an engine token to its TUI STEP_FN spelling. Strips arg quotes, then applies
# the two documented wrapper renames / divergences (see file header).
normalize_token() {
  local tok="${1//\"/}"
  case "${tok}" in
    "run_doctor preflight") tok="run_doctor_preflight" ;;
    "load_launchd_jobs") tok="menu_load_launchd_jobs" ;;
  esac
  printf '%s\n' "${tok}"
}

# Derive the normalized engine order (one token per line) for an action.
derive_engine_order() {
  local raw tok
  case "$1" in
    install)
      raw="$(
        func_body run_install | engine_calls plain
        func_body run_bootstrap | engine_calls tail
      )"
      ;;
    uninstall)
      raw="$(func_body run_uninstall | engine_calls plain)"
      ;;
    *) return 1 ;;
  esac
  while IFS= read -r tok; do
    [[ -n "${tok}" ]] && normalize_token "${tok}"
  done <<<"${raw}"
}

# === TUI side — read the REAL build_step_plan arrays =========================

# Source glass-atrium in an isolated subprocess and dump the plan for an action.
# Emits tagged lines so any stray subprocess chatter is ignored by the parsers:
#   CNT|<n_label> <n_active> <n_fn>
#   FN|<step_fn>            (one per STEP_FN entry, in order)
# The source-guard skips main() when sourced; we clear the inherited EXIT/INT/TERM
# traps so glass-atrium's terminal-restore cleanup cannot scribble escapes here.
tui_plan_dump() {
  bash -c '
    set -Eeuo pipefail
    source "$1" >/dev/null 2>&1
    trap - EXIT INT TERM ERR
    build_step_plan "$2"
    printf "CNT|%s %s %s\n" "${#STEP_LABEL[@]}" "${#STEP_LABEL_ACTIVE[@]}" "${#STEP_FN[@]}"
    printf "FN|%s\n" "${STEP_FN[@]}"
  ' _ "${TUI}" "$1"
}

tui_step_fn() { tui_plan_dump "$1" | sed -n 's/^FN|//p'; }
tui_counts() { tui_plan_dump "$1" | sed -n 's/^CNT|//p'; }

# === install ================================================================

@test "install: TUI STEP_FN matches the live engine order (run_install + bootstrap tail)" {
  local derived tui
  derived="$(derive_engine_order install)"
  tui="$(tui_step_fn install)"
  [[ -n "${derived}" ]] # extraction must not silently collapse to empty
  if [[ "${derived}" != "${tui}" ]]; then
    printf 'engine (derived):\n%s\n---\nTUI (build_step_plan):\n%s\n' "${derived}" "${tui}" >&2
    false
  fi
}

@test "install: STEP_LABEL / STEP_LABEL_ACTIVE / STEP_FN are equal-length" {
  local n_label n_active n_fn
  read -r n_label n_active n_fn <<<"$(tui_counts install)"
  [[ "${n_label}" -gt 0 ]]
  [[ "${n_label}" -eq "${n_active}" ]]
  [[ "${n_active}" -eq "${n_fn}" ]]
}

@test "install: capture_install_baseline is BOTH a run_install step and a TUI step (regression)" {
  derive_engine_order install | grep -qxF "capture_install_baseline"
  tui_step_fn install | grep -qxF "capture_install_baseline"
}

# === uninstall ==============================================================

@test "uninstall: TUI STEP_FN matches the live engine order (run_uninstall body)" {
  local derived tui
  derived="$(derive_engine_order uninstall)"
  tui="$(tui_step_fn uninstall)"
  [[ -n "${derived}" ]]
  if [[ "${derived}" != "${tui}" ]]; then
    printf 'engine (derived):\n%s\n---\nTUI (build_step_plan):\n%s\n' "${derived}" "${tui}" >&2
    false
  fi
}

@test "uninstall: STEP_LABEL / STEP_LABEL_ACTIVE / STEP_FN are equal-length" {
  local n_label n_active n_fn
  read -r n_label n_active n_fn <<<"$(tui_counts uninstall)"
  [[ "${n_label}" -gt 0 ]]
  [[ "${n_label}" -eq "${n_active}" ]]
  [[ "${n_active}" -eq "${n_fn}" ]]
}

@test "uninstall: purge_config is a run_uninstall call but is EXCLUDED from the base plan" {
  # purge_config lives inside the gated `if PURGE_CONFIG` block in run_uninstall
  # (separate typed-confirm), so it must NOT appear in the base build_step_plan.
  grep -qF "purge_config" "${CORE}" # the engine still owns the gated call
  ! tui_step_fn uninstall | grep -qxF "purge_config"
}
