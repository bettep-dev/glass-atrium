#!/usr/bin/env bash
# SC2034: worktree_lock_state / _other / _root_out / _dir_out / _holder_id_out are RESULT globals
# consumed by the sourcing hooks (advisory-worktree-writer-lock.sh acquire arm + agent-tracker.sh
# release arm), not by this lib — the same structural false positive apply-lock.sh documents for
# apply_lock_acquired.
# The waiver names EXACTLY the externally-read globals and no more: the previous blanket list also
# covered two globals with no reader anywhere, which is precisely how they survived. _key_out and
# _holder_out are deliberately ABSENT — both are read inside this file, so they need no waiver, and
# a name that stops being read must surface as a finding rather than sit inside the waiver.
# shellcheck disable=SC2034
#
# worktree-lock.sh — per-worktree writer lock, shared by the PreToolUse acquire arm
# (advisory-worktree-writer-lock.sh) and the SubagentStop release arm (agent-tracker.sh).
#
# Sourced, not executable; the sourcing hook owns strict mode + its own fail-open ERR trap.
#
# PRIMITIVE REUSE, IDENTITY REWRITE. The mutual-exclusion primitive is scripts/lib/apply-lock.sh's
# atomic-mkdir lock dir, and the staleness half (apply_lock_age_secs + the single-winner mv-aside
# _apply_lock_reclaim) is reused VERBATIM. The identity half is NOT reusable and is rewritten here:
# apply-lock keys ownership on `$$` + a ps-lstart fingerprint, but a hook's pid dies milliseconds
# after acquire and the releasing SubagentStop is a DIFFERENT process, so apply_lock_release's
# `held == $$` ownership test would make every release a silent no-op. Ownership here is the OPAQUE
# agent_id from the PreToolUse envelope, compared by EQUALITY — which needs no sidecar resolution
# and therefore cannot fail open the way agent_type recovery does.
#
# LOCK-DIR NAMING IS LOAD-BEARING, NOT COSMETIC: every removal path in apply-lock.sh is gated on
# _apply_lock_path_guard's `*/.apply-lock` suffix, so the leaf MUST stay `.apply-lock` or reclaim
# becomes a silent no-op. Layout: <root>/worktree-locks/<key-of-worktree-root>/.apply-lock.
#
# TTL IS DOMINANT, liveness is not a veto: an agent_id has no kill -0 analog, and the live-children
# marker cannot substitute because a truncated agent fires no SubagentStop at all (measured on this
# machine's corpus: ~5.6% of workflow agents and ~2.9% of manual agents never record a Stop). A
# liveness veto would therefore wedge that worktree's lock permanently on exactly the tail the TTL
# exists to cover. Our lock dir carries no `pid` file, so apply-lock's _apply_lock_holder_live always
# reports not-live and its `not-live AND aged` gate degenerates to age alone — by construction.
#
# HONEST BOUNDARY (restate it wherever this lock is described): it covers Write/Edit-family TOOL
# CALLS only. A Bash-authored write (`sed -i`, `cat >`, `tee`) never reaches the PreToolUse arm, a
# NotebookEdit carries notebook_path rather than file_path, and the TTL window bounds — never
# excludes — a crashed holder. This is a protection floor, never total containment.

if [[ -n "${_WORKTREE_LOCK_LOADED:-}" ]]; then
  return 0
fi
readonly _WORKTREE_LOCK_LOADED=1

# Store root — GA_DATA_ROOT-anchored like every other hook data dir (hook-utils.sh HOOK_DATA_DIR),
# which is also the seam every bats harness sandboxes. WORKTREE_LOCK_DIR overrides the whole root.
readonly WORKTREE_LOCK_ROOT="${WORKTREE_LOCK_DIR:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/worktree-locks}"

# 360 min — the staleness convention already in force for the live-child markers
# (enforce-commit-guard.sh LIVE_CHILD_TTL_MIN). Deliberately NOT apply-lock's 1800s default: measured
# manual-agent hold times reach a p99 of ~6692s, so a 1800s TTL would reclaim locks out from under
# live holders. WORKTREE_LOCK_TTL_SECS overrides.
readonly WORKTREE_LOCK_TTL_DEFAULT=21600

readonly _WORKTREE_LOCK_SELF_DIR="${BASH_SOURCE%/*}"

worktree_lock_key_out=""
worktree_lock_root_out=""
worktree_lock_dir_out=""
worktree_lock_holder_out=""
worktree_lock_state=""
worktree_lock_other=""
worktree_lock_holder_id_out=""

# Canonicalize a RAW envelope agent_id into the holder identity. BOTH arms MUST route through this:
# ownership is decided by string EQUALITY, so a holder stored under one spelling and looked up under
# another is never released and over-warns every other writer until the TTL.
#
# TWO spellings of "no agent_id" exist and both mean the main session: the PreToolUse envelope simply
# omits the field (empty here), while agent-tracker.sh's parse pass has already substituted its own
# `unknown` sentinel by the time the release arm runs. Folding both onto the DEFINED singleton
# `orchestrator` is what makes an id-less acquire releasable — mapping only the empty form leaves the
# release arm looking up `unknown` against a lock stamped `orchestrator`.
# Collision note, TWO cases — the second is the reachable one and the reason this note exists:
#   (1) UNLIKELY: a real agent_id spelled literally `unknown` aliases onto the singleton. Pre-existing
#       (the tracker already collapses the absent field to that word) and not worth a second sentinel
#       — agent ids are `a<uuid>`-shaped.
#   (2) REACHABLE, BY CONSTRUCTION: `orchestrator` is not one actor's identity, it is every id-less
#       caller folded together, and the main session fires Stop rather than SubagentStop. So EVERY
#       early release of an `orchestrator` lock necessarily comes from a DIFFERENT actor's id-less
#       SubagentStop. Concretely: main acquires worktree W as `orchestrator`; subagent X fires an
#       id-less SubagentStop; the fold matches, the lock is removed while main is still writing;
#       agent Y then enters W cleanly and NO LOCK-ADV-001 fires though two writers are really there.
#       That is a FALSE NEGATIVE — the advisory goes silent on a real collision.
#       DELIBERATE, NOT AN OVERSIGHT: the alternative (do not fold `unknown`) makes an id-less
#       acquire unreleasable, so every such lock sits until the 6 h TTL and warns every later writer
#       — a systematic FALSE POSITIVE. This hook's promotion gate is keyed on zero false positives,
#       so a rare false negative is the cheaper failure and the fold stays. Do not "fix" this by
#       unfolding; closing it properly needs a Stop-wired release arm for the main session.
# Whitespace folds because the holder record is read back one LINE at a time and the tracker splits
# its log tuple on TAB, so either character would store one spelling and look up another.
# Args: $1=raw agent_id (may be empty) · result: worktree_lock_holder_id_out (never empty).
worktree_lock_holder_id() {
  local id="${1:-}"
  id="${id//$'\n'/ }"
  id="${id//$'\t'/ }"
  case "${id}" in
    '' | unknown) id="orchestrator" ;;
    *) ;;
  esac
  worktree_lock_holder_id_out="${id}"
}

# Transform an absolute path into ONE path-safe directory segment. `_`->`__` then `/`->`_` is
# injective (a lone `_` in the output can only have come from a `/`), so two distinct worktree roots
# can never share a lock dir — a lossy transform would cross-warn between unrelated trees. Pure
# parameter expansion: this runs on every Write/Edit, so it must not fork (no `tr`). The output holds
# no `/`, so no traversal is expressible; `.`/`..` are rejected anyway as defense in depth.
# Args: $1=absolute path · result: worktree_lock_key_out · rc 1 = unusable key.
worktree_lock_key() {
  local p="${1}"
  worktree_lock_key_out=""
  p="${p//_/__}"
  p="${p//\//_}"
  case "${p}" in
    '' | '.' | '..') return 1 ;;
    *) ;;
  esac
  worktree_lock_key_out="${p}"
}

# Walk up from a target file to the nearest ancestor holding a `.git` entry. A linked worktree
# carries a `.git` FILE and a main checkout a `.git` DIR, so `-e` matches both and the nearest match
# wins — a file inside a worktree resolves to that worktree, never to the enclosing main repo. Pure
# bash: no `git` fork on the write hot path, and the target file need not exist yet.
# Args: $1=absolute normalized path · result: worktree_lock_root_out · rc 1 = not under a repo.
worktree_lock_find_root() {
  local dir="${1}" depth=0
  worktree_lock_root_out=""
  case "${dir}" in
    /*) ;;
    *) return 1 ;;
  esac
  dir="${dir%/*}" # start at the containing directory
  while [[ -n "${dir}" && "${depth}" -lt 64 ]]; do
    if [[ -e "${dir}/.git" ]]; then
      worktree_lock_root_out="${dir}"
      return 0
    fi
    dir="${dir%/*}"
    depth=$((depth + 1))
  done
  return 1
}

# Args: $1=worktree root · result: worktree_lock_dir_out · rc 1 = unusable key.
worktree_lock_dir_for() {
  worktree_lock_dir_out=""
  worktree_lock_key "${1}" || return 1
  worktree_lock_dir_out="${WORKTREE_LOCK_ROOT}/${worktree_lock_key_out}/.apply-lock"
}

# Args: $1=lock dir · result: worktree_lock_holder_out · rc 1 = no readable holder id.
worktree_lock_read_holder() {
  local record="${1}/holder" holder=""
  worktree_lock_holder_out=""
  [[ -r "${record}" ]] || return 1
  IFS= read -r holder <"${record}" || true # GA-ABSORB[benign]: read rc1 on a newline-less record; the empty holder falls to the rc-1 verdict below
  worktree_lock_holder_out="${holder}"
  [[ -n "${holder}" ]]
}

# Stamp the just-created lock dir with its holder id (temp + rename, so a contending reader gets an
# all-or-nothing record instead of a half-written id that would read as a DIFFERENT writer). A write
# failure removes the partial dir rather than leaving an owner-less lock nobody can ever release.
# Args: $1=lock dir $2=holder id.
_worktree_lock_stamp() {
  local lock_dir="${1}" holder="${2}" tmp="${1}/.holder.tmp.$$"
  # GA-ABSORB[handled@_worktree_lock_stamp-failure-branch]: a temp-write failure falls to the partial-dir teardown below
  if printf '%s\n' "${holder}" >"${tmp}" 2>/dev/null \
    && mv -f -- "${tmp}" "${lock_dir}/holder" 2>/dev/null; then # GA-ABSORB[handled@_worktree_lock_stamp-failure-branch]: a rename failure falls to the partial-dir teardown below
    return 0
  fi
  rm -f -- "${tmp}" 2>/dev/null || true      # GA-ABSORB[benign]: teardown of our own temp; absent is the normal case
  rmdir -- "${lock_dir}" 2>/dev/null || true # GA-ABSORB[benign]: a foreign-populated dir must survive this failure path
  return 1
}

# Load the apply-lock primitive on demand. Lazy because the RELEASE arm (agent-tracker.sh, whose
# 2-python3-per-fire budget is pinned by agent-tracker.bats) needs none of it.
# rc 1 = primitive unavailable (partial install) -> reclaim is simply skipped, never a hard failure.
_worktree_lock_load_applylock() {
  if [[ -n "${_WORKTREE_LOCK_APPLYLOCK:-}" ]]; then
    return 0
  fi
  local lib="${_WORKTREE_LOCK_SELF_DIR}/../../scripts/lib/apply-lock.sh"
  [[ -r "${lib}" ]] || return 1
  # shellcheck source-path=SCRIPTDIR source=../../scripts/lib/apply-lock.sh
  source "${lib}" || return 1
  _WORKTREE_LOCK_APPLYLOCK=1
}

# Reclaim a lock whose holder is presumed gone: age-gated only (see the TTL-IS-DOMINANT note in the
# header), then apply-lock's single-winner mv-aside takeover so two racing reclaimers can never both
# win. rc 0 = the stale dir is gone and the caller may mkdir fresh.
# Args: $1=lock dir.
_worktree_lock_reclaim() {
  local lock_dir="${1}" ttl age
  _worktree_lock_load_applylock || return 1
  ttl="${WORKTREE_LOCK_TTL_SECS:-${WORKTREE_LOCK_TTL_DEFAULT}}"
  case "${ttl}" in
    '' | *[!0-9]*) ttl="${WORKTREE_LOCK_TTL_DEFAULT}" ;;
    *) ;;
  esac
  # _apply_lock_reclaim re-verifies staleness with apply_lock_ttl_secs; aligning that env var keeps
  # both gates on ONE number. Process-local: this hook never acquires the shared apply lock itself.
  ATRIUM_APPLY_LOCK_TTL_SECS="${ttl}"
  age="$(apply_lock_age_secs "${lock_dir}")" || return 1
  [[ "${age}" -gt "${ttl}" ]] || return 1
  _apply_lock_reclaim "${lock_dir}" || return 1
}

# Acquire the per-worktree write lock for one holder.
# Args: $1=lock dir $2=holder id.
# Result: worktree_lock_state ∈ acquired | reentrant | reclaimed | contended | error
#         worktree_lock_other = the other holder's id on contention ("" = record unreadable)
# Always rc 0 — the caller decides what to do with the state (this arm never blocks).
worktree_lock_acquire() {
  local lock_dir="${1}" holder="${2}"
  worktree_lock_state="error"
  worktree_lock_other=""

  # Both mkdirs are skipped once the lock exists, which is the STEADY state: an agent writing
  # repeatedly into its own worktree hits this on every write after the first, and there the pair
  # was two guaranteed fork+execs per Write — the second one existing only to fail. Same reason this
  # file already refuses a `tr` fork (worktree_lock_key) and a second python3 (the lazy apply-lock
  # load): the acquire arm sits on the Write/Edit hot path.
  # The TOCTOU is benign in BOTH directions: a dir appearing inside the window makes the inner mkdir
  # fail into the contended path below, which is exactly today's behaviour, and a dir vanishing
  # inside the window sends us to the contended path with an unreadable holder — also today's
  # behaviour (the empty other-holder never matches, so the reclaim chain decides it).
  if [[ ! -d "${lock_dir}" ]]; then
    mkdir -p -- "${lock_dir%/*}" 2>/dev/null || return 0 # GA-ABSORB[handled@worktree_lock_acquire-error-state]: an unwritable store leaves state=error and the caller stays silent

    # Fast path — uncontended (mkdir is atomic on POSIX).
    if mkdir -- "${lock_dir}" 2>/dev/null; then # GA-ABSORB[benign]: mkdir rc1 IS the contended verdict, decided below
      if _worktree_lock_stamp "${lock_dir}" "${holder}"; then
        worktree_lock_state="acquired"
      fi
      return 0
    fi
  fi

  # Contended. SAME-holder equality is the FIRST branch on purpose: an agent writing repeatedly into
  # its own worktree is the common case, and it must cost no age check and no python3 fork.
  worktree_lock_read_holder "${lock_dir}" || true # GA-ABSORB[handled@same-holder-branch-below]: an unreadable record leaves an empty other-holder, which never matches
  worktree_lock_other="${worktree_lock_holder_out}"
  if [[ -n "${worktree_lock_other}" && "${worktree_lock_other}" == "${holder}" ]]; then
    worktree_lock_state="reentrant"
    return 0
  fi

  # GA-ABSORB[handled@contended-fallthrough]: any failed step in this chain falls through to the contended verdict below
  if _worktree_lock_reclaim "${lock_dir}" \
    && mkdir -- "${lock_dir}" 2>/dev/null \
    && _worktree_lock_stamp "${lock_dir}" "${holder}"; then
    worktree_lock_state="reclaimed"
    return 0
  fi

  worktree_lock_state="contended"
}

# Release every lock held by one agent — the SubagentStop arm. Pure bash plus one `rm` per actual
# match: agent-tracker.bats pins that hook to exactly 2 python3 subprocesses per fire, so nothing
# here may reach for the interpreter (which is also why the TTL is checked at ACQUIRE, not here).
# Args: $1=holder id · rc 1 = a removal failed (caller reports it loudly; a stale lock would
# otherwise over-warn silently until its TTL). Deliberately reports NO released count: the only
# caller branches on rc alone, and the previous count global was read by nothing anywhere.
worktree_lock_release_by_holder() {
  local holder="${1}" lock_dir rc=0
  [[ -n "${holder}" ]] || return 0             # GA-ABSORB[benign]: no holder id = nothing this agent can own
  [[ -d "${WORKTREE_LOCK_ROOT}" ]] || return 0 # GA-ABSORB[benign]: no lock store yet = nothing to release
  for lock_dir in "${WORKTREE_LOCK_ROOT}"/*/.apply-lock; do
    [[ -d "${lock_dir}" ]] || continue # unmatched glob expands literally on bash 3.2 (no nullglob)
    worktree_lock_read_holder "${lock_dir}" || continue
    [[ "${worktree_lock_holder_out}" == "${holder}" ]] || continue
    # SECURITY: the rm -rf escape guard, twin of apply-lock's _apply_lock_path_guard — a mis-derived
    # dir must never let the removal walk onto an unrelated path.
    case "${lock_dir}" in
      */.apply-lock) ;;
      *) continue ;;
    esac
    if rm -rf -- "${lock_dir}" 2>/dev/null; then    # GA-ABSORB[handled@rc-1-return-below]: a removal failure sets rc 1 for the caller's loud warn
      rmdir -- "${lock_dir%/*}" 2>/dev/null || true # GA-ABSORB[benign]: prune the now-empty key dir; a non-empty one legitimately stays
    else
      rc=1
    fi
  done
  return "${rc}"
}
