#!/usr/bin/env bash
# install.sh — the one-line bootstrap for Glass Atrium.
#
#   curl -fsSL <raw-url>/install.sh | bash
#
# This script ONLY clones the repo into ~/.glass-atrium and hands off to the
# interactive launcher (./glass-atrium). It is a thin front door — every real
# install step (deps, symlink farm, hook wiring, DB, monitor build, health gate,
# launchd) stays inside the existing TUI, which owns its own consent + auth gates.
#
# Architecture preserved exactly: the clone IS the runtime. ~/.claude/<rel> files
# become per-file symlinks pointing INTO ~/.glass-atrium, and the harness updates
# itself in place via git — so the clone MUST live at ~/.glass-atrium and MUST NOT
# be moved or deleted afterwards.
#
# Safe both piped (curl|bash, where stdin is the script pipe, NOT the terminal)
# and run as a file. It does NOT depend on its own on-disk location, so a piped
# invocation (empty/garbage BASH_SOURCE) works identically to `bash install.sh`.
#
# SECURITY: handles NO tokens/secrets, reads no .env, echoes no credentials, and
# runs no third-party `curl | sh`. It clones + launches; nothing else.
#
# Environment overrides (all optional):
#   GA_REPO_URL   git URL to clone (REQUIRED — the shipped default is a loud
#                 placeholder so a mis-published copy fails clearly, never clones
#                 the wrong thing). The publish-time URL is filled in at release.
#   GA_REF        branch or tag to check out (default: main)
#   GA_DIR        clone target (default: ~/.glass-atrium — see the symlink-farm
#                 constraint above; only override for a sandbox/test)
#   GA_NO_RUN     when non-empty, clone only + print the run hint (CI / testing)
#
# Exit codes (named, loud-fail — no silent precondition absorption):
#   0   success (cloned and either handed off or printed the run hint)
#   10  not macOS
#   11  git not found on PATH
#   12  GA_REPO_URL is still the placeholder / empty
#   13  GA_DIR exists but is not this repo (refuse to clobber)
#   14  git clone failed
#   15  git pull --ff-only failed (existing clone diverged / dirty)
#   16  launcher missing or not executable after clone
#
# HARD CONSTRAINT: stock macOS bash 3.2 + BSD coreutils only (no mapfile, no
# associative arrays, no GNU-only flags).
set -Eeuo pipefail
IFS=$'\n\t'

# --- named exit codes ------------------------------------------------------
readonly EXIT_NOT_MACOS=10
readonly EXIT_NO_GIT=11
readonly EXIT_PLACEHOLDER_URL=12
readonly EXIT_DIR_CONFLICT=13
readonly EXIT_CLONE_FAILED=14
readonly EXIT_PULL_FAILED=15
readonly EXIT_NO_LAUNCHER=16

# --- parameters (env-overridable) ------------------------------------------
# The default URL is a DELIBERATE placeholder: a published copy with the URL
# unfilled must fail loud at preflight rather than clone an unintended source.
GA_REPO_URL="${GA_REPO_URL:-<repo-url>}"
GA_REF="${GA_REF:-main}"
GA_DIR="${GA_DIR:-${HOME}/.glass-atrium}"
GA_NO_RUN="${GA_NO_RUN:-}"

# --- leaf logging (stderr only; mirrors lib/ga-core.sh) --------------------
# Progress/diagnostics go to stderr so they never collide with a future exec of
# the launcher and stay visible under curl|bash.
log() { printf '%s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
# die <exit_code> <message...> — loud-fail with a NAMED exit code (Precondition
# Loud-Fail principle: every unmet precondition gets a distinct code + message).
die() {
  local code="$1"
  shift
  printf 'FATAL: %s\n' "$*" >&2
  exit "${code}"
}

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# --- preflight (loud-fail, no silent 2>/dev/null swallowing) ---------------
# Verify the three hard preconditions before touching the filesystem: macOS,
# git on PATH, and a real (non-placeholder) repo URL.
preflight() {
  # macOS only — the symlink farm, launchd jobs, and BSD coreutils assumptions
  # are macOS-specific; the launcher itself refuses elsewhere.
  local os
  os="$(uname -s)"
  [[ "${os}" == "Darwin" ]] \
    || die "${EXIT_NOT_MACOS}" "Glass Atrium requires macOS (detected: ${os})."

  # git is mandatory — the install IS a git clone (in-place self-updating repo).
  if ! command -v git >/dev/null 2>&1; then
    log "git is required but was not found on PATH. Install it with one of:"
    log "  xcode-select --install      # Xcode Command Line Tools (recommended)"
    log "  brew install git            # Homebrew"
    die "${EXIT_NO_GIT}" "git not found — install it (see above) and re-run."
  fi

  # The publish-time URL must be supplied. A real git URL never contains <...>,
  # so an angle-bracket token (or empty) means the placeholder is still in place.
  case "${GA_REPO_URL}" in
    '' | *'<'*'>'*)
      log "GA_REPO_URL is not configured (current value: '${GA_REPO_URL}')."
      log "Set it to the Glass Atrium repository URL and re-run, e.g.:"
      log "  GA_REPO_URL=https://github.com/<owner>/glass-atrium.git \\"
      log "    bash -c \"\$(curl -fsSL <raw-url>/install.sh)\""
      die "${EXIT_PLACEHOLDER_URL}" "GA_REPO_URL still a placeholder."
      ;;
    *) : ;; # configured URL — proceed
  esac
}

# --- idempotent clone-or-update --------------------------------------------
# Never clobber an existing GA_DIR. Three cases:
#   1. Same-origin git clone  -> git pull --ff-only (in-place update)
#   2. A different/foreign dir -> ERROR (refuse to overwrite; no rm -rf, ever)
#   3. Absent                  -> fresh git clone --branch GA_REF
clone_or_update() {
  if [[ -e "${GA_DIR}" ]]; then
    if [[ -d "${GA_DIR}/.git" ]]; then
      local existing_origin=""
      existing_origin="$(git -C "${GA_DIR}" remote get-url origin 2>/dev/null || true)"
      if [[ "${existing_origin}" == "${GA_REPO_URL}" ]]; then
        log "Existing Glass Atrium clone at ${GA_DIR} — updating (fast-forward only)."
        if ! git -C "${GA_DIR}" pull --ff-only; then
          die "${EXIT_PULL_FAILED}" \
            "git pull --ff-only failed in ${GA_DIR} (diverged or dirty tree) — resolve it manually."
        fi
      else
        log "${GA_DIR} is a git repo, but its origin does not match GA_REPO_URL:"
        log "  existing origin: ${existing_origin:-<none>}"
        log "  expected:        ${GA_REPO_URL}"
        log "Leaving it untouched. Move it aside, or set GA_DIR to a different path."
        die "${EXIT_DIR_CONFLICT}" "${GA_DIR} exists with a different origin."
      fi
    else
      log "${GA_DIR} already exists but is not a Glass Atrium git clone."
      log "Refusing to overwrite it. Move it aside, or set GA_DIR to a different path."
      die "${EXIT_DIR_CONFLICT}" "${GA_DIR} exists and is not a git repo."
    fi
  else
    log "Cloning Glass Atrium (ref: ${GA_REF}) into ${GA_DIR} ..."
    # git clone removes the target dir itself if the clone fails, so a failed
    # run never leaves a partial GA_DIR behind (no manual cleanup needed).
    if ! git clone --branch "${GA_REF}" "${GA_REPO_URL}" "${GA_DIR}"; then
      die "${EXIT_CLONE_FAILED}" \
        "git clone failed — check GA_REPO_URL, GA_REF (${GA_REF}), and network access."
    fi
  fi
}

# --- hand off to the interactive launcher ----------------------------------
# THE tricky part under curl|bash: stdin is the script pipe, so the menu cannot
# read keys from it. Reconnect to the controlling terminal (/dev/tty) and EXEC
# the launcher so the TUI owns the terminal directly. With no controlling tty
# (CI / non-interactive) or GA_NO_RUN set, do NOT launch a key-driven menu —
# print the run hint and exit 0.
handoff() {
  local launcher="${GA_DIR}/glass-atrium"
  [[ -x "${launcher}" ]] \
    || die "${EXIT_NO_LAUNCHER}" "Launcher missing or not executable: ${launcher}"

  if [[ -n "${GA_NO_RUN}" ]]; then
    log "Clone complete (GA_NO_RUN set). Launch the menu yourself:"
    log "  ${launcher}"
    return 0
  fi

  # Probe for a reachable controlling terminal. The 2>/dev/null here is NOT a
  # swallowed precondition: we branch on the result and print a clear message in
  # the no-tty case — it only hides the expected "Device not configured" noise.
  if [[ -e /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then
    log "Launching the Glass Atrium menu — choose Install."
    exec "${launcher}" </dev/tty
  fi

  log "Clone complete — no interactive terminal detected. Launch the menu yourself:"
  log "  ${launcher}"
}

main() {
  log "Glass Atrium installer"
  preflight
  clone_or_update
  handoff
}

main "$@"
