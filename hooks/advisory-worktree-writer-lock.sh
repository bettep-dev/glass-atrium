#!/usr/bin/env bash
# advisory-worktree-writer-lock.sh — PreToolUse(Write|Edit) per-worktree writer-lock acquire arm.
#
# Claims a per-worktree lock for the writing agent on its first write into that worktree, and warns
# on STDERR when a DIFFERENT agent already holds it. The release arm lives in agent-tracker.sh's
# SubagentStop branch; the lock primitive itself lives in lib/worktree-lock.sh.
#
# ADVISORY-FIRST — exits 0 on EVERY path, including contention. There is no block path and therefore
# no retry contract in this version: promotion to exit 2 is a LATER, EXPLICIT step, gated on a clean
# advisory measurement window (zero false positives), the same deferred-then-promote pattern
# scripts/audit-absorption.sh followed. Until then the value is measurement: disjoint-ownership
# fan-outs should NEVER contend, so an observed contention is a real race the prose rule was masking.
#
# WHY a lock rather than prose: one worktree has exactly ONE git index, so two concurrent writers
# there is a race that file-set partitioning cannot prevent (orchestrator-role.md, Automatic
# Parallelization guardrail (a)). That rule is honor-system today; this makes a violation visible.
#
# IDENTITY IS FAIL-CLOSED: the holder is the OPAQUE agent_id from the envelope, compared by
# EQUALITY. No sidecar resolution is involved, so the fail-open agent_type recovery other hooks use
# cannot weaken the decision. An envelope with NO agent_id (the main session) maps to the DEFINED
# singleton holder "orchestrator" — a distinct comparable identity that CONTENDS with any agent,
# never an unresolvable case that passes through.
#
# BLIND SPOTS (repeated in the advisory text itself, so the signal can never read as enforcement):
#   * Bash-authored writes (sed -i / cat > / tee) never reach the Write|Edit arm.
#   * NotebookEdit carries notebook_path rather than file_path and is uncovered.
#   * A crashed holder is TTL-bounded, not excluded — inside the window a free worktree still warns.
#   * ~5.6% of workflow agents / ~2.9% of manual agents never fire SubagentStop (measured on this
#     machine's sidecar corpus joined to core.agent_events), so the TTL is the sole release path for
#     that tail.
#   * WHICH lock a path resolves to is decided TEXTUALLY. hook_normalize_path never touches the
#     filesystem, so two spellings of one file take two independent verdicts: on this machine
#     ~/.claude/agents/*.md are symlinks into ~/.glass-atrium/agents/, which HAS a .git while
#     ~/.claude does not — a write through the symlink finds no repo and takes no lock at all, while
#     the same file by its real path locks the agents repo (a genuine concurrent-write surface: the
#     lifecycle CLI and the updater both write it). The same textual walk collapses every tree under
#     a repo-rooted ancestor onto ONE lock, so on a machine whose $HOME is itself a git repo the
#     whole home directory would contend as a single worktree (not the case here — measured: no
#     ~/.git).
#   * The "orchestrator" singleton is released only by an id-less SubagentStop. The main session
#     fires Stop, and agent-tracker.sh is wired on SubagentStart/SubagentStop only, so a lock the
#     main session itself takes has NO release arm and is TTL-only. Closing that needs a Stop-wired
#     release, which is a separate decision, not an oversight in this file.
#
# WIRED as of this commit: `PreToolUse<TAB>advisory-worktree-writer-lock.sh<TAB>Write|Edit` in
# EXPECTED_HOOK_BINDINGS (lib/ga-env.sh), so wire_hooks registers the acquire arm and the advisory
# measurement window its promotion gate depends on can accumulate. The release arm was already live
# (agent-tracker.sh). Two caveats on when firing actually STARTS: settings.json is written by
# wire_hooks (an install/update run), and Claude Code snapshots the hook config at SESSION START — so
# the first data point comes from a fresh session after the next release lands, not from this commit.
# MultiEdit is deliberately NOT in the matcher: it has zero registrations on the recorded host
# (test/hook-matcher-shape-invariant.bats), so binding it would add a dead token — that file's
# one-token legacy allowlist exists precisely to stop the set widening. Re-check before relying on
# any of this: `grep advisory-worktree-writer-lock lib/ga-env.sh`.
#
# Fail-open on EVERYTHING else: absent python3, unwritable lock store, unparseable envelope, missing
# apply-lock primitive → exit 0 silently. Worst case is a missing or spurious advisory line.

set -Eeuo pipefail
IFS=$'\n\t'

# Instant kill switch — the other disable is dropping this hook's EXPECTED_HOOK_BINDINGS row
# (lib/ga-env.sh) and re-running wire_hooks, which needs an install run plus a session restart to
# take effect; this env var needs neither. See WIRED above.
[[ -n "${WORKTREE_WRITER_LOCK_OFF:-}" ]] && exit 0

# fail-open ERR trap — never interfere with the tool call.
trap 'printf "[worktree-writer-lock] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# shellcheck source-path=SCRIPTDIR source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"
# shellcheck source-path=SCRIPTDIR source=lib/worktree-lock.sh
source "${BASH_SOURCE%/*}/lib/worktree-lock.sh"

INPUT="$(hook_read_input)"
[[ "${INPUT}" == "{}" ]] && exit 0

# ONE interpreter pass for all three envelope reads (agent_id + cwd are top-level, file_path lives
# INSIDE tool_input) — this runs on every Write/Edit, so a second python3 cold start would be pure
# hot-path cost. `state` mirrors hook_probe_tool_input's 3-state contract so an envelope RENAME
# fails loud instead of silently resolving to "no path, no lock". A python3 failure degrades to
# `empty`, NOT `unrecognized`: a missing interpreter is not envelope drift (hook-utils.sh AC4).
# SC2312: the parse pass's own exit status is deliberately unread — the in-band NUL-framed `state`
# field carries the verdict, and the fallback below covers the interpreter-failure case.
# shellcheck disable=SC2312
{
  IFS= read -r -d '' TI_STATE
  IFS= read -r -d '' FILE_PATH
  IFS= read -r -d '' AGENT_ID
  IFS= read -r -d '' CWD
} < <(python3 -c '
import sys, json
state, file_path, agent_id, cwd = "unrecognized", "", "", ""
try:
    d = json.load(sys.stdin)
except Exception:
    d = None
if isinstance(d, dict):
    agent_id = str(d.get("agent_id", "") or "").rstrip("\n").replace("\x00", "")
    cwd = str(d.get("cwd", "") or "").rstrip("\n").replace("\x00", "")
    tool_input = d.get("tool_input")
    if isinstance(tool_input, dict):
        file_path = str(tool_input.get("file_path", "") or "").rstrip("\n").replace("\x00", "")
        state = "present" if file_path else "empty"
out = sys.stdout
for field in (state, file_path, agent_id, cwd):
    out.write(field)
    out.write("\0")
' <<<"${INPUT}" 2>/dev/null || printf 'empty\0\0\0\0') # GA-ABSORB[handled@TI_STATE-empty-fallback]: an absent interpreter degrades to the empty state, which exits silently

if [[ "${TI_STATE}" == "unrecognized" ]]; then
  emit_error "LOCK-ADV-002" "warn" \
    "PreToolUse envelope shape unrecognized — the worktree writer lock was skipped for this call" \
    "Check whether tool_input/file_path was renamed upstream; hooks/advisory-worktree-writer-lock.sh reads both" \
    '{}'
  exit 0
fi
[[ -z "${FILE_PATH}" ]] && exit 0

# Normalize FIRST (enforce-harness-critical.sh precedent): a "../" form must never dodge the
# exemptions below, and a relative path is only meaningful against the envelope cwd.
case "${FILE_PATH}" in
  /* | '~'*) ;;
  *) [[ -n "${CWD}" ]] && FILE_PATH="${CWD}/${FILE_PATH}" ;;
esac
TARGET="$(hook_normalize_path "${FILE_PATH}")"

# memory/progress-*.md is the checkpoint path a NON-index-owner agent is INSTRUCTED to write while
# sharing a worktree (core-git-workflow.md), so locking it would warn on exactly the prescribed
# behaviour. The three basenames are the harness-write exemption enforce-delegation.sh already
# carries; keeping the two exemption sets aligned avoids contradicting a sanctioned write.
#
# The seven-arm carve-out is enforce-delegation.sh's, mirrored VERBATIM (its step 3) rather than
# approximated: a "memory" segment nested directly under a protected harness dir is not a
# session-state root, which is why that gate BLOCKS those forms. Exempting them here would have been
# the opposite of the alignment this comment claims — and would have hidden concurrent writes to
# agents/memory/ and rules/memory/, which are real shared surfaces, behind a rule written for a
# checkpoint file. The "/${TARGET}/" wrapping is that gate's form too, so the two read the same.
case "/${TARGET}/" in
  */agents/memory/* | */rules/memory/* | */hooks/memory/* | */skills/memory/* | \
    */autoagent/memory/* | */monitor/memory/* | */scripts/memory/*) ;;
  */memory/*) exit 0 ;;
  *) ;;
esac
case "${TARGET##*/}" in
  CLAUDE.md | MEMORY.md | GLASS_ATRIUM_GLOBAL_RULES.md) exit 0 ;;
  *) ;;
esac

# A write outside any repo cannot race a git index — the hot-path exit for non-repo writes.
# SC2310: both are pure predicates whose rc-1 branch IS the silent-exit path; the set -e disable
# under `||` is intended.
# shellcheck disable=SC2310
worktree_lock_find_root "${TARGET}" || exit 0
WORKTREE_ROOT="${worktree_lock_root_out}"
# shellcheck disable=SC2310
worktree_lock_dir_for "${WORKTREE_ROOT}" || exit 0
LOCK_DIR="${worktree_lock_dir_out}"

# Both arms canonicalize through the lib so an id-less acquire here and an id-less release in
# agent-tracker.sh land on the SAME identity — see worktree_lock_holder_id.
worktree_lock_holder_id "${AGENT_ID}"
HOLDER="${worktree_lock_holder_id_out}"

worktree_lock_acquire "${LOCK_DIR}" "${HOLDER}"
[[ "${worktree_lock_state}" == "contended" ]] || exit 0

TTL_SECS="${WORKTREE_LOCK_TTL_SECS:-${WORKTREE_LOCK_TTL_DEFAULT}}"
OTHER="${worktree_lock_other:-unknown}"
CTX="$(jq -cn --arg wt "${WORKTREE_ROOT}" --arg holder "${OTHER}" --arg writer "${HOLDER}" \
  '{worktree:$wt,holder:$holder,writer:$writer}' 2>/dev/null || printf '{}')" # GA-ABSORB[handled@empty-object-fallback]: jq absent or a quoting edge degrades ctx to {}, never drops the advisory

emit_error "LOCK-ADV-001" "warn" \
  "a second writer is entering a worktree another agent already holds" \
  "Serialize the two tracks, or give this one its own worktree" \
  "${CTX}"

printf '%s\n' \
  "[worktree-writer-lock] ADVISORY ONLY — this hook never blocks (exit 0); promotion to a block is a later explicit step." \
  "  worktree : ${WORKTREE_ROOT}" \
  "  holder   : ${OTHER}" \
  "  writer   : ${HOLDER}" \
  "  Blind spots this signal cannot see — it is a protection floor, NOT full enforcement:" \
  "    - Bash-authored writes (sed -i / cat > / tee) never reach the Write|Edit arm." \
  "    - NotebookEdit carries notebook_path, not file_path, and is uncovered." \
  "    - A crashed holder is TTL-bounded (${TTL_SECS}s), not excluded: inside that window a free" \
  "      worktree still warns, and past it a live holder's lock can be reclaimed." \
  "    - ~5.6% of workflow agents and ~2.9% of manual agents never fire SubagentStop, so the" \
  "      release arm misses that tail and the TTL is its only release path." \
  "    - Which lock a path resolves to is decided TEXTUALLY, never by resolving the filesystem: a" \
  "      symlinked spelling and a real path take two independent verdicts, and every tree under a" \
  "      repo-rooted ancestor collapses onto one lock." \
  "    - A lock held by \"orchestrator\" is released only by an id-less SubagentStop; the main" \
  "      session fires Stop, which is not a release arm, so its own lock is TTL-only." \
  >&2

exit 0
