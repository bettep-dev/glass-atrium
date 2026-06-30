#!/usr/bin/env bash
# apply-gate.sh — the foreground diff-preview + explicit-confirm gate for the
# Glass Atrium update system (plan E3 / design C, task T12 / gate G3). Pure,
# sourced library: function definitions ONLY, no top-level side effects, no
# executable entry point — the same convention as scripts/lib/apply-spine.sh
# and scripts/lib/atrium-config.sh.
#
# IMPORTANT — strict mode is the CALLER's responsibility (sourced-lib convention)
# This file deliberately does NOT run `set -Eeuo pipefail`: a sourced file must
# not mutate the caller's shell options. Every function here is written to be
# SAFE under a caller that has already set `set -Eeuo pipefail` + `IFS=$'\n\t'`
# (separated local declarations, explicit `|| …` where a non-zero status is
# expected, bash-3.2-safe C-style loops + array expansions for the macOS stock
# shell). The bats suite sources this lib under full strict mode to prove that.
#
# Role (plan S2 / T12 → T17): this is the SINGLE confirmation gate every apply
# path MUST pass through — BOTH the deterministic non-agent file sync (T13,
# proposed bytes = the verified new-release tree) AND the agent EDITABLE-region
# three-anchor merge (T17/T18/T19, proposed bytes = the merged result). It is
# deliberately agnostic to HOW the proposed content was produced: it consumes a
# uniform change-record stream (label / current-file / proposed-file) so both
# producers feed the same gate.
#
# Contract (the G3 guarantee):
#   * a per-file UNIFIED DIFF preview is rendered for every change BEFORE any
#     write,
#   * the gate HALTS for explicit user confirmation on the controlling TTY,
#   * declining performs ZERO writes — and the higher-order `gate_apply_confirmed`
#     makes that STRUCTURAL (the write callback is never invoked on decline),
#   * the flow is FOREGROUND only — there is no background mass-replace path.
#
# Loud-fail contract (shared-self-improve-hygiene Precondition Loud-Fail): a
# missing proposed-content file is a non-zero return with an explicit stderr
# line, never a silent skip. Fail-closed: when no controlling TTY is available
# and no answer is injected, the gate DECLINES (zero writes), never assumes yes.
#
# Change-record stream format (one record per line, TAB-separated):
#   <label>\t<current_path>\t<proposed_path>
#     label         — the relative path / human identifier shown in the preview
#     current_path  — the live file being replaced; EMPTY when none exists yet
#                     (rendered as a brand-new file, diffed against /dev/null)
#     proposed_path — the file holding the content that WOULD be written
#
# Test / non-interactive seam: ATRIUM_UPDATE_CONFIRM_ANSWER, when SET (even to
# an empty string), is used verbatim as the typed answer instead of reading
# /dev/tty — the only injection point, so production interactive behavior is
# never silently bypassed.

# ---------------------------------------------------------------------------
# Diff preview
# ---------------------------------------------------------------------------

# Render a single file's unified-diff preview. Args: $1 = label · $2 = current
# file path (empty/absent → treated as a new file, diffed against /dev/null) ·
# $3 = proposed-content file path (MUST exist — loud-fail rc 1 otherwise).
# `diff -u` returns 1 when the files differ; that is the EXPECTED outcome for a
# change set, not an error, so it is explicitly absorbed (`|| true`). Portable
# across BSD (macOS) and GNU diff.
gate_render_diff() {
  local label="$1" current="$2" proposed="$3" old_src
  if [[ ! -f "${proposed}" ]]; then
    printf 'apply-gate: proposed content missing for %s: %s\n' \
      "${label}" "${proposed}" >&2
    return 1
  fi
  printf '=== %s ===\n' "${label}"
  if [[ -z "${current}" || ! -f "${current}" ]]; then
    printf '(new file — no current version)\n'
    old_src="/dev/null"
  else
    old_src="${current}"
  fi
  diff -u -- "${old_src}" "${proposed}" || true
  printf '\n'
}

# ---------------------------------------------------------------------------
# Confirmation read (TTY / injected)
# ---------------------------------------------------------------------------

# Echo the user's typed answer. Precedence: ATRIUM_UPDATE_CONFIRM_ANSWER env
# (the test/non-interactive injection seam — used verbatim, even when empty) →
# a readable /dev/tty → fail-closed empty string (no TTY, no injection → the
# caller treats empty as a decline, never an implicit yes). Reads from /dev/tty
# (NOT stdin) because stdin carries the change-record stream.
gate_read_answer() {
  local answer=""
  if [[ -n "${ATRIUM_UPDATE_CONFIRM_ANSWER+x}" ]]; then
    printf '%s\n' "${ATRIUM_UPDATE_CONFIRM_ANSWER}"
    return 0
  fi
  if [[ -r /dev/tty ]]; then
    IFS= read -r answer </dev/tty || answer=""
  fi
  printf '%s\n' "${answer}"
}

# Prompt for explicit confirmation and map the answer to a return code. Only
# `y`/`yes` (case-insensitive) confirm; EVERYTHING else — including an empty
# answer — declines (fail-closed). Arg: $1 = change count (for the prompt).
# rc 0 = confirmed · rc 1 = declined.
gate_prompt_confirm() {
  local count="$1" answer
  printf '\n%s file(s) will be changed. Apply these updates? [y/N] ' \
    "${count}" >&2
  answer="$(gate_read_answer)"
  case "${answer}" in
    y | Y | yes | Yes | YES) return 0 ;;
    *)
      printf 'apply-gate: declined — no files written\n' >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Change-record building (non-agent sync bridge)
# ---------------------------------------------------------------------------

# Bridge spine_find_changed_files output → gate change-record stream for the
# NON-AGENT sync path. Reads relative paths (one per line) from STDIN; emits a
# TAB-separated record per path. current = install_root/path (EMPTY field when
# the file is absent locally → previewed as a new file); proposed = new_dir/path.
# Args: $1 = new-release tree root · $2 = live install root.
gate_build_nonagent_records() {
  local new_dir="$1" install_root="$2" path current proposed
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    proposed="${new_dir}/${path}"
    if [[ -f "${install_root}/${path}" ]]; then
      current="${install_root}/${path}"
    else
      current=""
    fi
    printf '%s\t%s\t%s\n' "${path}" "${current}" "${proposed}"
  done
}

# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------

# Render every change's diff preview then prompt ONCE for confirmation. Reads
# the change-record stream (TSV: label\tcurrent\tproposed) from STDIN. This is
# the decision-only callable: it performs NO writes — it returns a verdict the
# caller acts on. rc 0 = confirmed (caller MAY now write) · rc 1 = declined
# (caller MUST write nothing) · rc 2 = empty change set (nothing to confirm).
gate_confirm_changes() {
  local -a labels=() currents=() proposeds=()
  local label current proposed n i
  while IFS=$'\t' read -r label current proposed; do
    [[ -n "${label}" ]] || continue
    labels+=("${label}")
    currents+=("${current}")
    proposeds+=("${proposed}")
  done
  n="${#labels[@]}"
  if [[ "${n}" -eq 0 ]]; then
    printf 'apply-gate: no changes to apply\n' >&2
    return 2
  fi
  for ((i = 0; i < n; i++)); do
    gate_render_diff "${labels[i]}" "${currents[i]}" "${proposeds[i]}" || return 1
  done
  gate_prompt_confirm "${n}"
}

# Structural zero-write-on-decline wrapper — the callable the skill (T09) wraps.
# Buffers the change-record stream from STDIN (freeing stdin for the callback),
# renders + confirms it, and ONLY on explicit confirmation invokes the apply
# callback "$@". On decline (rc 1) or an empty set (rc 2) the callback is NEVER
# called, so "zero writes on decline" is guaranteed by control flow rather than
# by caller discipline. rc: 0 = applied (callback rc 0) · 1 = declined · 2 =
# nothing to do · otherwise the callback's own non-zero rc (apply failure).
gate_apply_confirmed() {
  local changeset rc=0
  changeset="$(cat)"
  printf '%s\n' "${changeset}" | gate_confirm_changes || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    return "${rc}"
  fi
  "$@"
}
