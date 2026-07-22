#!/usr/bin/env bash
# apply-gate.sh — foreground diff-preview + explicit-confirm gate for the Glass
# Atrium update system. Pure sourced library: function defs only, no top-level
# side effects (same convention as apply-spine.sh / atrium-config.sh).
#
# Strict mode is the CALLER's responsibility — a sourced lib must not mutate the
# caller's shell options; every fn is safe under `set -Eeuo pipefail` (the bats
# suite sources it under strict mode to prove that).
#
# Role: the SINGLE confirmation gate every apply path passes through (both the
# deterministic non-agent sync and the agent EDITABLE-region merge), agnostic to
# HOW the proposed content was produced — both producers feed one uniform
# change-record stream.
#
# G3 contract: per-file unified-diff preview BEFORE any write · HALT for explicit
# TTY confirmation · decline performs ZERO writes, made STRUCTURAL by
# gate_apply_confirmed (the callback is never invoked on decline). Foreground
# only — no background mass-replace path.
#
# Loud-fail + fail-closed (shared-self-improve-hygiene Precondition Loud-Fail):
# a missing proposed file is a non-zero return + stderr, never a silent skip; no
# TTY and no injected answer → DECLINE (zero writes), never an implicit yes.
#
# Change-record stream (one record/line, fields joined by ASCII Unit Separator
# 0x1f): <label>\x1f<current>\x1f<proposed> — current EMPTY when no live file
# exists (previewed as new vs /dev/null), proposed holds the bytes that WOULD be
# written. The separator MUST be non-whitespace: an IFS-whitespace delimiter (tab)
# collapses the empty <current> field of a new-file record, shifting proposed into
# current and leaving proposed empty → fail-closes the whole gate (no new file ever
# deploys). 0x1f never appears in a path, so every field round-trips intact.
#
# ATRIUM_UPDATE_CONFIRM_ANSWER, when SET (even empty), is the ONLY injection seam
# (used verbatim instead of /dev/tty) — prod interactive is never silently bypassed.

# Diff preview

# Render one file's unified-diff preview. Args: $1 label · $2 current (empty/absent
# → new file vs /dev/null) · $3 proposed file (MUST exist — loud-fail rc 1).
# `diff -u` rc 1 = files differ = EXPECTED for a change set, absorbed via `|| true`.
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

# Confirmation read (TTY / injected)

# Echo the typed answer. Precedence: ATRIUM_UPDATE_CONFIRM_ANSWER (injection seam,
# verbatim even when empty) → readable /dev/tty → fail-closed empty (caller treats
# empty as decline, never implicit yes). Reads /dev/tty NOT stdin (stdin carries
# the change-record stream).
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

# Prompt for confirmation → return code. Only `y`/`yes` (case-insensitive) confirm;
# everything else including empty declines (fail-closed). Arg $1 = change count.
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

# Change-record building (non-agent sync bridge)

# Bridge spine_find_changed_files → change-record stream (NON-AGENT sync path).
# Reads relative paths from STDIN, emits a TSV record each: current =
# install_root/path (EMPTY when absent locally → new file), proposed = new_dir/path.
# Args: $1 new-release root · $2 live install root.
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
    printf '%s\x1f%s\x1f%s\n' "${path}" "${current}" "${proposed}"
  done
}

# The gate

# Render every diff preview then prompt ONCE. Reads the TSV change-record stream
# from STDIN. Decision-only — performs NO writes, returns a verdict: rc 0 confirmed
# · rc 1 declined · rc 2 empty change set.
gate_confirm_changes() {
  local -a labels=() currents=() proposeds=()
  local label current proposed n i
  while IFS=$'\x1f' read -r label current proposed; do
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

# Structural zero-write-on-decline wrapper. Buffers the STDIN change-record stream
# (freeing stdin for the callback), renders + confirms, and invokes the apply
# callback "$@" ONLY on confirmation — on decline/empty the callback is NEVER
# called, so zero-writes-on-decline holds by control flow, not caller discipline.
# rc: 0 applied · 1 declined · 2 nothing to do · else the callback's own non-zero rc.
gate_apply_confirmed() {
  local changeset rc=0
  changeset="$(cat)"
  printf '%s\n' "${changeset}" | gate_confirm_changes || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    return "${rc}"
  fi
  "$@"
}
