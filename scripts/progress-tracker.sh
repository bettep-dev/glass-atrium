#!/usr/bin/env bash
# progress-tracker.sh — Cross-session progress file management.
#
# Why: GLOBAL_RULES "Cross-Session Continuity" mandates that long tasks
# (3+ turns) maintain a memory/progress-{slug}.md file. This library
# centralises slug derivation, atomic init, status updates, completion
# marking, and listing of open files so hooks and scripts share one
# implementation.
#
# Interface (functions exported when sourced):
#   progress_init       <task_name> [slug_override]
#                       Creates the progress file if missing. Idempotent —
#                       never overwrites an existing in_progress file.
#                       Echoes the resulting absolute path on stdout.
#   progress_update     <slug>
#                       Refreshes the last_updated frontmatter field.
#   progress_complete   <slug>
#                       Flips status to "completed" and updates last_updated.
#                       No-op if the file is missing or already completed.
#   progress_list_open  Prints absolute paths of all status: in_progress
#                       files, newest first (mtime sort). Silent if none.
#
# CLI dispatcher: same names as positional first arg.
#
# Compatibility: Bash 3.2+ (macOS stock), no external deps beyond hook-utils.sh
# (python3 is reused for safe YAML writes — same dep already required).

set -Eeuo pipefail
IFS=$'\n\t'

# Guard double-sourcing — safe even when invoked as a CLI.
if [[ -n "${_PROGRESS_TRACKER_LOADED:-}" ]]; then
  # `return` works only when sourced; `|| true` keeps `set -e` happy when
  # this file is executed directly (rare, but valid).
  # shellcheck disable=SC2317
  return 0 2>/dev/null || true
fi
readonly _PROGRESS_TRACKER_LOADED=1

# Resolve script directory portably (no readlink -f on macOS BSD).
_PROGRESS_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Source shared hook utilities (provides hook_read_input/get_field/emit_error).
# hook-utils.sh lives in ~/.claude/hooks/, our directory is ~/.claude/scripts/.
# shellcheck source=/dev/null
source "${_PROGRESS_SCRIPT_DIR}/../hooks/hook-utils.sh"

# Progress files live alongside MEMORY.md in the user's auto-memory project.
# This path is fixed by GLOBAL_RULES Cross-Session Continuity rule.
# Claude-Code project-dir cwd encoding: $HOME with '/' -> '-' (leading '-').
_proj_dir="-${HOME#/}"
_proj_dir="${_proj_dir//\//-}"
readonly PROGRESS_DIR="${HOME}/.claude-personal/projects/${_proj_dir}/memory"
readonly PROGRESS_TEMPLATE="${HOME}/.claude/agents/templates/progress.md"

# ----------------------------------------------------------------------------
# Slug derivation — sanitize a free-form task name into [a-z0-9-]+.
# Rules (matches spec convention progress-{slug}.md):
#   1. Lowercase
#   2. Replace any run of non-alnum with a single hyphen
#   3. Strip leading/trailing hyphens
#   4. Cap at 60 chars (longer slugs harm readability and shell argv limits)
#   5. Empty result falls back to "task-<epoch>" so callers always get a slug
# ----------------------------------------------------------------------------
progress_slug_from_name() {
  local raw="${1:-}"
  local slug
  # tr handles ASCII; LANG=C avoids locale-specific lower/upper mappings.
  # Pipe order: lower → strip non-alnum runs → collapse hyphens → trim
  slug="$(
    LANG=C printf '%s' "${raw}" \
      | tr '[:upper:]' '[:lower:]' \
      | LANG=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
  )"
  # Cap length (cut by char, not byte — slug is ASCII so they coincide).
  if [[ ${#slug} -gt 60 ]]; then
    slug="${slug:0:60}"
    # Re-strip any trailing hyphen exposed by the cut.
    slug="${slug%-}"
  fi
  if [[ -z "${slug}" ]]; then
    slug="task-$(date +%s)"
  fi
  printf '%s\n' "${slug}"
}

# ----------------------------------------------------------------------------
# Path helper — absolute progress file path for a slug.
# ----------------------------------------------------------------------------
progress_path_for_slug() {
  local slug="${1:?slug required}"
  printf '%s/progress-%s.md\n' "${PROGRESS_DIR}" "${slug}"
}

# ----------------------------------------------------------------------------
# Atomic write helper — writes content to dest via .tmp + mv (POSIX atomic
# rename within the same FS). Permissions: rely on umask (typically 0644).
# ----------------------------------------------------------------------------
_progress_atomic_write() {
  local dest="${1:?dest required}"
  local content="${2:-}"
  local tmp
  tmp="$(mktemp -t "progress-XXXXXX")"
  # Cleanup tmp on any failure path. Trap is local to the function via
  # subshell discipline at the call site (functions inherit caller traps,
  # so we install a one-shot trap that restores RETURN behaviour).
  printf '%s' "${content}" >"${tmp}"
  if ! mv -f -- "${tmp}" "${dest}"; then
    rm -f -- "${tmp}" 2>/dev/null || true
    return 1
  fi
  return 0
}

# ----------------------------------------------------------------------------
# progress_init — create progress file when absent, no-op when present.
# Args: $1=task_name (required, free-form), $2=slug (optional override)
# Echoes absolute path on stdout. Returns 0 always (idempotency contract).
# ----------------------------------------------------------------------------
progress_init() {
  local task_name="${1:-}"
  if [[ -z "${task_name}" ]]; then
    hook_log "progress_init: task_name is required"
    return 64
  fi

  local slug="${2:-}"
  if [[ -z "${slug}" ]]; then
    slug="$(progress_slug_from_name "${task_name}")"
  fi

  local path
  path="$(progress_path_for_slug "${slug}")"

  # Idempotent: if file already exists (regardless of status), keep it.
  # Spec contract: "never overwrite an existing in_progress file."
  if [[ -e "${path}" ]]; then
    printf '%s\n' "${path}"
    return 0
  fi

  mkdir -p -- "${PROGRESS_DIR}"

  # Read template — single source of truth for both frontmatter and body.
  # Fall back to a minimal inline skeleton (with the same placeholders) if
  # the template file is unreadable, to keep the script self-contained.
  local rendered
  if [[ -r "${PROGRESS_TEMPLATE}" ]]; then
    rendered="$(cat -- "${PROGRESS_TEMPLATE}")"
  else
    rendered=$'---\ntask: "{task_name}"\nslug: "{slug}"\nstarted: {timestamp}\nstatus: in_progress\nlast_updated: {timestamp}\n---\n# Progress: {task_name}\n\n## Current Status\n- [ ] In progress\n'
  fi

  local now_iso
  now_iso="$(date +%Y-%m-%dT%H:%M)"

  # YAML safety: task_name may contain " or \, which would break the
  # double-quoted scalar in the template. Escape via python3 (already a
  # required dep for hook-utils.sh) — bash parameter expansion alone
  # cannot handle backslash-then-quote ordering reliably.
  local task_name_escaped
  if ! task_name_escaped="$(
    PROGRESS_TASK="${task_name}" python3 -c '
import os, sys
v = os.environ.get("PROGRESS_TASK", "")
sys.stdout.write(
    v.replace("\\", "\\\\")
     .replace("\"", "\\\"")
     .replace("\n", "\\n")
     .replace("\r", "\\r")
     .replace("\t", "\\t")
)
'
  )"; then
    hook_log "progress_init: failed to escape task_name"
    return 1
  fi

  # Substitute the four template placeholders. Bash parameter expansion
  # avoids sed escaping pitfalls (task_name may legitimately contain /, &).
  # Order matters only for {task_name} (used both bare in body and quoted
  # in frontmatter); the escaped form is identical in both contexts since
  # the body sits inside a markdown heading and any escape sequence is
  # printed literally — acceptable trade-off for a single substitution path.
  rendered="${rendered//\{task_name\}/${task_name_escaped}}"
  rendered="${rendered//\{slug\}/${slug}}"
  rendered="${rendered//\{timestamp\}/${now_iso}}"

  # shellcheck disable=SC2310  # intentional: act on _progress_atomic_write failure
  if ! _progress_atomic_write "${path}" "${rendered}"; then
    hook_log "progress_init: atomic write failed for ${path}"
    return 1
  fi

  printf '%s\n' "${path}"
  return 0
}

# ----------------------------------------------------------------------------
# Frontmatter mutation helper — replaces a single key's value within the
# top YAML block. Atomic via tmp+mv. Used by update/complete.
# Args: $1=path, $2=key, $3=new_value
# ----------------------------------------------------------------------------
_progress_set_field() {
  local path="${1:?path required}"
  local key="${2:?key required}"
  local value="${3:-}"

  if [[ ! -f "${path}" ]]; then
    return 1
  fi

  # python3 is the safest tool for YAML mutation — sed regex on multi-line
  # frontmatter is brittle (delimiters, escaping). We rewrite only the
  # frontmatter block, never the body.
  local updated
  if ! updated="$(
    PROGRESS_FILE="${path}" \
      PROGRESS_KEY="${key}" \
      PROGRESS_VALUE="${value}" \
      python3 - <<'PYEOF'
import os
import sys

path = os.environ["PROGRESS_FILE"]
key = os.environ["PROGRESS_KEY"]
value = os.environ.get("PROGRESS_VALUE", "")

with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()

# Frontmatter must be the first --- ... --- block on its own lines.
if not text.startswith("---\n"):
    sys.stdout.write(text)
    sys.exit(0)

end = text.find("\n---\n", 4)
if end == -1:
    sys.stdout.write(text)
    sys.exit(0)

front = text[4:end]
body = text[end + 5:]

# Decide quoting: identifiers/booleans/timestamps stay bare, everything else
# gets double-quoted to match the format produced by progress_init.
SAFE_BARE = {"in_progress", "completed", "true", "false"}

def emit(k, v):
    bare_ok = (
        v in SAFE_BARE
        or (v and all(c.isalnum() or c in "-:T" for c in v))
    )
    if bare_ok:
        return f"{k}: {v}"
    escaped = (
        v.replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f"{k}: \"{escaped}\""

new_lines = []
replaced = False
for line in front.split("\n"):
    stripped = line.lstrip()
    if stripped.startswith(f"{key}:"):
        new_lines.append(emit(key, value))
        replaced = True
    else:
        new_lines.append(line)

if not replaced:
    # Append before closing fence so the field is always present.
    new_lines.append(emit(key, value))

sys.stdout.write("---\n" + "\n".join(new_lines) + "\n---\n" + body)
PYEOF
  )"; then
    hook_log "_progress_set_field: python rewrite failed for ${path}"
    return 1
  fi

  _progress_atomic_write "${path}" "${updated}"
}

# ----------------------------------------------------------------------------
# progress_update — bump last_updated to now. Used to keep ordering signal
# fresh during long sessions.
# ----------------------------------------------------------------------------
progress_update() {
  local slug="${1:?slug required}"
  local path
  path="$(progress_path_for_slug "${slug}")"
  if [[ ! -f "${path}" ]]; then
    return 0
  fi
  local now_iso
  now_iso="$(date +%Y-%m-%dT%H:%M)"
  _progress_set_field "${path}" "last_updated" "${now_iso}"
}

# ----------------------------------------------------------------------------
# progress_complete — flip status: completed and refresh last_updated.
# Returns 0 on success or no-op (file missing / already completed).
# ----------------------------------------------------------------------------
progress_complete() {
  local slug="${1:?slug required}"
  local path
  path="$(progress_path_for_slug "${slug}")"
  if [[ ! -f "${path}" ]]; then
    return 0
  fi

  # Skip work when already completed — keeps the function cheap to call
  # repeatedly from PostToolUse hooks.
  if grep -qE '^status:[[:space:]]*completed' "${path}" 2>/dev/null; then
    return 0
  fi

  local now_iso
  now_iso="$(date +%Y-%m-%dT%H:%M)"
  # shellcheck disable=SC2310  # intentional: bubble _progress_set_field failure
  _progress_set_field "${path}" "status" "completed" || return 1
  # shellcheck disable=SC2310
  _progress_set_field "${path}" "last_updated" "${now_iso}" || return 1
  return 0
}

# ----------------------------------------------------------------------------
# progress_list_open — print absolute paths of in_progress files, newest
# first by mtime. Silent (no output, exit 0) when none exist.
# ----------------------------------------------------------------------------
progress_list_open() {
  if [[ ! -d "${PROGRESS_DIR}" ]]; then
    return 0
  fi

  # nullglob: empty glob expands to zero args (avoids literal pattern).
  # Bash 3.2 supports shopt -s nullglob.
  local prev_nullglob
  prev_nullglob="$(shopt -p nullglob 2>/dev/null || printf '%s' '')"
  shopt -s nullglob

  local -a files=()
  local f
  for f in "${PROGRESS_DIR}"/progress-*.md; do
    # Cheap filter: only files whose status field is in_progress.
    if grep -qE '^status:[[:space:]]*in_progress' "${f}" 2>/dev/null; then
      files+=("${f}")
    fi
  done

  # Restore nullglob to caller state before any return path.
  if [[ -n "${prev_nullglob}" ]]; then
    eval "${prev_nullglob}" || true
  fi

  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi

  # Sort by mtime, newest first. ls -t is the portable choice on macOS BSD.
  # We pass paths via NUL boundaries to survive spaces (none expected, but
  # cheap insurance).
  local f2
  for f2 in "${files[@]}"; do
    printf '%s\0' "${f2}"
  done | xargs -0 ls -t 2>/dev/null
}

# ----------------------------------------------------------------------------
# CLI dispatcher — only runs when the script is executed directly,
# not when sourced.
# ----------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ $# -lt 1 ]]; then
    cat >&2 <<'USAGE'
Usage:
  progress-tracker.sh progress_init <task_name> [slug]
  progress-tracker.sh progress_update <slug>
  progress-tracker.sh progress_complete <slug>
  progress-tracker.sh progress_list_open
  progress-tracker.sh progress_slug_from_name <task_name>
USAGE
    exit 64
  fi
  cmd="${1}"
  shift
  case "${cmd}" in
    progress_init | progress_update | progress_complete | progress_list_open | progress_slug_from_name)
      "${cmd}" "$@"
      ;;
    *)
      printf 'progress-tracker: unknown command %s\n' "${cmd}" >&2
      exit 64
      ;;
  esac
fi
