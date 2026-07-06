# shellcheck shell=bash
# shellcheck disable=SC2154  # references shared globals (SETTINGS_JSON/CONFIG_TOML/CONFIG_TOML_EXAMPLE/EXPECTED_HOOK_BINDINGS/DRY_RUN/RE_RENDER) assigned by ga_init_env in ga-env.sh — present at runtime after lib/ga-core.sh sources every domain, unresolvable when linted standalone
# Glass Atrium — config.toml render + settings.json hook wiring domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# --- settings.json hook-binding query (read-only — D-5) ---------------------
# Echo "yes" when settings.json binds <hook-basename> under <event> (optionally
# scoped to <matcher>), else "no".
# Read-ONLY: this NEVER writes settings.json (mutation-free doctor contract).
# Basename compare tolerates the ~/.claude/hooks/ vs absolute path prefix.
#
# Matcher scoping (command-WITHIN-matcher key) — REQUIRED for the same hook bound
# under two different matchers (e.g. validate-secret-scan.sh on Write|Edit AND on
# Bash): with a non-empty 3rd arg, only hook-groups whose matcher EQUALS it are
# considered, so each (event, matcher, basename) tuple is tracked independently.
# An absent matcher key and an empty-string matcher are normalized as equivalent
# ("no matcher" — the SessionStart/Stop/validate-output shape). When the 3rd arg
# is empty (omitted), the legacy event+basename-only match is used (matcher
# ignored) — kept for any caller that does not need matcher granularity.
# Always exits 0 (stdout verdict, like is_never_touch) so the ERR trap is inert.
is_hook_bound() {
  local event="$1" hook="$2" matcher="${3:-}"
  # absent settings.json or jq → "no" (caller surfaces the gap loudly)
  command -v jq >/dev/null 2>&1 || {
    printf 'no\n'
    return 0
  }
  [[ -f "${SETTINGS_JSON}" ]] || {
    printf 'no\n'
    return 0
  }
  local found
  # collect every command basename bound under the event (matcher-scoped when a
  # non-empty matcher is supplied), then match the requested basename.
  # jq failure (malformed json) → empty → "no" (loud-fail, not silent-pass).
  # --arg everywhere → matcher/event are never interpolated into the jq program.
  if [[ -n "${matcher}" ]]; then
    found="$(
      jq -r --arg ev "${event}" --arg m "${matcher}" \
        '(.hooks[$ev] // [])[]
           | select((.matcher // "") == $m)
           | (.hooks // [])[]? | .command' \
        -- "${SETTINGS_JSON}" 2>/dev/null \
        | sed 's#.*/##' \
        | grep -Fxq -- "${hook}" && printf 'yes' || printf 'no'
    )"
  else
    found="$(
      jq -r --arg ev "${event}" \
        '(.hooks[$ev] // [])[]
           | select((.matcher // "") == "")
           | (.hooks // [])[]? | .command' \
        -- "${SETTINGS_JSON}" 2>/dev/null \
        | sed 's#.*/##' \
        | grep -Fxq -- "${hook}" && printf 'yes' || printf 'no'
    )"
  fi
  printf '%s\n' "${found}"
}

# --- config.toml render ----------------------------------------------------
# Render config.toml.example (tracked, ${HOME}-placeholder template) into
# config.toml (git-ignored) by expanding ONLY the ${HOME} placeholder; every
# other literal stays verbatim.
#
# ORDERING CONTRACT (load-bearing): MUST complete BEFORE any render-monitor-env.sh
# call — that script reads config.toml VERBATIM and validates
# [paths].monitor_docs_html_root as an EXISTING ABSOLUTE dir (exit 9 otherwise),
# which an unexpanded "${HOME}/..." fails. So render-before-validate is mandatory.
#
# IDEMPOTENT: no-op when config.toml exists with ZERO unexpanded ${HOME} tokens;
# --re-render forces a fresh render. Renders the EXAMPLE, never edits a hand-tuned
# config; a backup is taken first so a tuned config is recoverable.
#
# BINARY-PATH RESOLUTION (E1): after expansion, [paths].node_bin/claude_bin are
# rewritten to the REAL host binaries (resolve_config_binaries) so the plists bake
# host-correct paths — a hardcoded /opt/homebrew/bin/node breaks nvm/fnm users.
# Runs on EVERY render path INCLUDING the idempotency early-return, so a re-render
# never leaves the template default in place.
#
# Substitution via awk (NOT sed): sed's replacement interprets `&` and `\`, so a
# HOME containing them (legal on macOS, e.g. /Users/a&b) would corrupt the config;
# awk's ENVIRON[] is read byte-for-byte. Only the literal ${HOME} token is touched.
render_config() {
  [[ -f "${CONFIG_TOML_EXAMPLE}" ]] || die "config template missing: ${CONFIG_TOML_EXAMPLE}"

  # idempotency: existing config with no unexpanded ${HOME} → skip (unless forced).
  # grep -c zero-match trap: `|| true` keeps set -e quiet (grep exit 1 = no match),
  # then the empty-guard normalizes a blank count to 0 (`grep -c ... || echo 0`
  # would print "0\n0").
  if [[ -f "${CONFIG_TOML}" ]] && ! "${RE_RENDER}"; then
    local unexpanded
    # single-quoted BRE: the literal ${HOME} is the grep PATTERN, \$ escapes the BRE
    # anchor. SC2016 intentional.
    # shellcheck disable=SC2016
    unexpanded="$(grep -c '\${HOME}' -- "${CONFIG_TOML}" || true)"
    [[ -z "${unexpanded}" ]] && unexpanded=0
    if [[ "${unexpanded}" -eq 0 ]]; then
      log "render_config: ${CONFIG_TOML} already fully expanded — skip \${HOME} expansion (use --re-render to force)"
      # E1: binary-path resolution MUST run even on this early-return, else a re-render
      # leaves node_bin/claude_bin at the template default. This early return bypasses
      # the DRY_RUN check below, so guard DRY_RUN explicitly here.
      if "${DRY_RUN}"; then
        log "dry-run: would resolve absolute node_bin/claude_bin in ${CONFIG_TOML}"
      else
        # pre-write backup: this early-return skipped the full render (and its backup),
        # so resolve_config_binaries would rewrite a possibly hand-tuned config with NO
        # safety copy. Mirror the full-render backup idiom before the resolve.
        local backup
        backup="${CONFIG_TOML}.ga-backup.$(date +%Y%m%d-%H%M%S)"
        cp -p -- "${CONFIG_TOML}" "${backup}"
        log "render_config: backed up existing config -> ${backup}"
        resolve_config_binaries
      fi
      return 0
    fi
    log "render_config: ${CONFIG_TOML} has ${unexpanded} unexpanded \${HOME} line(s) — re-rendering"
  fi

  if "${DRY_RUN}"; then
    log "dry-run: would render ${CONFIG_TOML_EXAMPLE} -> ${CONFIG_TOML} (\${HOME}=${HOME})"
    return 0
  fi

  # back up an existing (possibly hand-tuned) config before overwriting it.
  if [[ -f "${CONFIG_TOML}" ]]; then
    local backup
    backup="${CONFIG_TOML}.ga-backup.$(date +%Y%m%d-%H%M%S)"
    cp -p -- "${CONFIG_TOML}" "${backup}"
    log "render_config: backed up existing config -> ${backup}"
  fi

  mkdir -p -- "$(dirname -- "${CONFIG_TOML}")"

  # atomic write: render to a temp, then mv over the target (never a half file).
  # RENDER_TMP-tracked so an INT/TERM during the awk>tmp is trap-swept (F-7).
  RENDER_TMP="${CONFIG_TOML}.ga-render.$$"
  # awk replaces the literal ${HOME} with ENVIRON["GA_RENDER_HOME"] byte-for-byte
  # (no `&`/`\` interpretation, unlike sed). The token is a fixed internal constant
  # → safe via -v; HOME (untrusted charset) goes through ENVIRON[] only.
  GA_RENDER_HOME="${HOME}" awk -v tok='${HOME}' '
    {
      line = $0
      out = ""
      while ((p = index(line, tok)) > 0) {
        out = out substr(line, 1, p - 1) ENVIRON["GA_RENDER_HOME"]
        line = substr(line, p + length(tok))
      }
      print out line
    }
  ' "${CONFIG_TOML_EXAMPLE}" >"${RENDER_TMP}"

  # post-render assertion: zero unexpanded ${HOME} must remain (loud-fail).
  local remain
  # single-quoted BRE (literal ${HOME} token, not a shell expansion).
  # shellcheck disable=SC2016
  remain="$(grep -c '\${HOME}' -- "${RENDER_TMP}" || true)"
  [[ -z "${remain}" ]] && remain=0
  if [[ "${remain}" -ne 0 ]]; then
    rm -f -- "${RENDER_TMP}"
    RENDER_TMP=""
    die "render_config: ${remain} \${HOME} token(s) survived render — aborting (template malformed?)"
  fi

  mv -f -- "${RENDER_TMP}" "${CONFIG_TOML}"
  RENDER_TMP=""
  log "render_config: rendered ${CONFIG_TOML} (\${HOME} expanded)"

  # E1: resolve the host-real node_bin/claude_bin into the freshly-rendered [paths].
  # DRY_RUN already returned above, so this only runs on a real render.
  resolve_config_binaries
}

# --- E1 binary-path resolver helpers (Stepdown: callees of render_config) ----
# ga_resolve_bin — echo the directory-canonicalized absolute path of a binary,
# macOS-portable (NO GNU realpath / readlink -f). Canonicalizes the CONTAINING dir
# via `cd … && pwd -P` while PRESERVING the basename — deliberately NOT dereferencing
# a final bin/<tool> symlink: Homebrew's stable /opt/homebrew/bin/<tool> symlink
# survives a minor-version upgrade whereas the Cellar target does not. Returns 1
# (caller falls back to the literal input) when the dir is absent.
ga_resolve_bin() {
  local p="$1" dir base
  [[ -n "${p}" ]] || return 1
  dir="$(cd -- "$(dirname -- "${p}")" >/dev/null 2>&1 && pwd -P)" || return 1
  base="$(basename -- "${p}")"
  printf '%s/%s' "${dir}" "${base}"
}

# resolve_config_binaries — rewrite [paths].node_bin/claude_bin in CONFIG_TOML with
# the REAL host binaries. node_bin: `command -v node` absolute. claude_bin: `command
# -v claude` else the native-installer location (${HOME}/.local/bin/claude) absolute.
# Idempotent + atomic (temp + mv, RENDER_TMP-tracked for the trap sweep). A missing
# claude_bin line (older configs) is INSERTED after node_bin; a present one replaced.
# node absent on PATH leaves node_bin untouched (loud log, never a blank value).
# Never replaces a non-empty config with an empty file.
resolve_config_binaries() {
  [[ -f "${CONFIG_TOML}" ]] || return 0

  local node_src claude_src node_bin claude_bin
  node_src="$(command -v node 2>/dev/null || true)"
  claude_src="$(command -v claude 2>/dev/null || true)"
  # native-installer location when claude is not yet on PATH (~/.local/bin/claude).
  [[ -n "${claude_src}" ]] || claude_src="${HOME}/.local/bin/claude"

  node_bin=""
  if [[ -n "${node_src}" ]]; then
    # `|| printf` fallback degrades an unresolvable path to the PATH-absolute source
    # instead of aborting; the command-substitution + `||` intentionally masks set -e
    # (same stdout-verdict idiom as the is_* helpers).
    # shellcheck disable=SC2310,SC2311,SC2312
    node_bin="$(ga_resolve_bin "${node_src}" 2>/dev/null || printf '%s' "${node_src}")"
  else
    log "resolve_config_binaries: node not on PATH — leaving existing node_bin untouched"
  fi
  # same `|| printf` fallback + set -e masking idiom as above.
  # shellcheck disable=SC2310,SC2311,SC2312
  claude_bin="$(ga_resolve_bin "${claude_src}" 2>/dev/null || printf '%s' "${claude_src}")"

  # claude_bin line already present? older configs lack it → insert vs replace.
  # grep -c zero-match trap: `|| true` keeps set -e quiet, empty-guard normalizes to 0.
  local has_claude
  has_claude="$(grep -c '^[[:space:]]*claude_bin[[:space:]]*=' -- "${CONFIG_TOML}" || true)"
  [[ -z "${has_claude}" ]] && has_claude=0

  # RENDER_TMP-tracked so an INT/TERM during the awk>tmp is trap-swept.
  RENDER_TMP="${CONFIG_TOML}.ga-bin.$$"
  # awk rewrite, table-scoped to [paths]. Only node_bin/claude_bin are touched; a
  # non-empty var replaces its line, an empty var preserves it. has_claude==0 inserts
  # claude_bin after node_bin.
  awk -v node_bin="${node_bin}" -v claude_bin="${claude_bin}" -v has_claude="${has_claude}" '
    /^[[:space:]]*\[/ {
      hdr = $0
      gsub(/[[:space:]]/, "", hdr)
      in_paths = (hdr == "[paths]")
      print
      next
    }
    in_paths && $0 ~ /^[[:space:]]*node_bin[[:space:]]*=/ {
      if (node_bin != "") { print "node_bin = \"" node_bin "\"" } else { print }
      if (has_claude == 0 && claude_bin != "") { print "claude_bin = \"" claude_bin "\"" }
      next
    }
    in_paths && $0 ~ /^[[:space:]]*claude_bin[[:space:]]*=/ {
      if (claude_bin != "") { print "claude_bin = \"" claude_bin "\"" } else { print }
      next
    }
    { print }
  ' "${CONFIG_TOML}" >"${RENDER_TMP}"

  # guard: never replace a non-empty config with an empty file (awk catastrophe).
  if [[ ! -s "${RENDER_TMP}" ]]; then
    rm -f -- "${RENDER_TMP}"
    RENDER_TMP=""
    die "resolve_config_binaries: rewrite produced an empty ${CONFIG_TOML} — aborting"
  fi

  mv -f -- "${RENDER_TMP}" "${CONFIG_TOML}"
  RENDER_TMP=""
  log "resolve_config_binaries: node_bin=${node_bin:-<unchanged>} claude_bin=${claude_bin}"
}

# --- wire repoint primitive: migrate old-dir hook commands to the new dir ------
# An EXISTING install wired its hooks under ${HOME}/.claude/hooks/<hook>. After
# the command-template repoint (wire_hooks now emits ${HOME}/.glass-atrium/hooks),
# is_hook_bound() still matches those stale bindings BY BASENAME, so the wire
# add-loop would treat them as already-wired and SKIP → the repoint would be a
# silent no-op on an established install. This pass REWRITES every hook command
# resolving under the OLD Atrium hooks dir to the NEW one (basename + any suffix
# preserved), so the repoint actually lands before the idempotency check runs.
#
# DATA-SAFETY — same "only Atrium commands" property as unwire_hooks: only a
# command whose (tilde-normalized) path startswith ${HOME}/.claude/hooks/ is
# rewritten; a foreign user hook at any other path fails the prefix and is
# preserved byte-for-byte. MERGE (every other key flows through `.`), ATOMIC
# (temp + jq-revalidate + mv, RENDER_TMP trap-swept), BACKED-UP (lazy, distinct
# suffix so it never clobbers wire_hooks' own backup), injection-safe (--arg
# everywhere → no path value ever reaches the jq program text).
rewrite_hook_paths() {
  local old_dir="${HOME}/.claude/hooks/"
  local new_dir="${HOME}/.glass-atrium/hooks/"

  # count commands currently resolving under the old dir (tilde-aware). jq failure
  # (malformed json already ruled out by the caller) → 0 → clean no-op.
  local pending
  pending="$(
    jq -r --arg old "${old_dir}" --arg home "${HOME}" '
      def norm:
        (. // "")
        | (if startswith("~/") then $home + .[1:] else . end);
      [ (.hooks // {}) | to_entries[] | .value[]? | (.hooks // [])[]? | .command | norm
        | select(startswith($old)) ] | length
    ' -- "${SETTINGS_JSON}" 2>/dev/null || printf '0'
  )"
  [[ -z "${pending}" ]] && pending=0
  if [[ "${pending}" -eq 0 ]]; then
    return 0
  fi

  # back up ONCE before the rewrite — distinct suffix from wire_hooks' backup so a
  # same-second wire backup cannot overwrite this pre-rewrite image.
  local backup
  backup="${SETTINGS_JSON}.ga-repoint-backup.$(date +%Y%m%d-%H%M%S)"
  cp -p -- "${SETTINGS_JSON}" "${backup}"
  log "rewrite_hook_paths: backed up settings.json -> ${backup}"

  RENDER_TMP="${SETTINGS_JSON}.ga-repoint.$$"
  jq --arg old "${old_dir}" --arg new "${new_dir}" --arg home "${HOME}" '
    def repoint:
      (. // "") as $c
      | (if ($c | startswith("~/")) then $home + $c[1:] else $c end) as $abs
      | (if ($abs | startswith($old)) then $new + $abs[($old | length):] else $c end);
    if (.hooks | type) == "object" then
      .hooks |= map_values(
        if type == "array" then
          map(
            if (.hooks | type) == "array" then
              .hooks |= map(
                if (.command | type) == "string" then .command |= repoint else . end
              )
            else . end
          )
        else . end
      )
    else . end
  ' -- "${SETTINGS_JSON}" >"${RENDER_TMP}"

  if ! jq -e . -- "${RENDER_TMP}" >/dev/null 2>&1; then
    rm -f -- "${RENDER_TMP}"
    RENDER_TMP=""
    die "rewrite_hook_paths: repoint produced invalid JSON — backup preserved at ${backup}"
  fi
  mv -f -- "${RENDER_TMP}" "${SETTINGS_JSON}"
  RENDER_TMP=""
  log "rewrite_hook_paths: repointed ${pending} hook command(s) ${old_dir} -> ${new_dir} (backup: ${backup})"
}

# --- settings.json hook-binding MERGE (idempotent upsert — owns ONLY the Atrium
#     hook commands, never any other key) -------------------------------------
# Upserts each EXPECTED_HOOK_BINDINGS entry into settings.json under its event,
# attaching the declared matcher + the "$HOME/.glass-atrium/hooks/<basename>" command.
#
# SAFETY CONTRACT (why this cannot clobber user config):
#   * MERGE not overwrite — the jq transform reads the FULL existing object and
#     only APPENDS a hook-group to one .hooks.<event> array; every other key
#     (permissions, env, model, statusLine, the user's own hook entries) flows
#     through `.` unchanged. No key is ever deleted, replaced, or reordered.
#   * IDEMPOTENT — is_hook_bound() (basename compare within the event) is checked
#     first; an already-present command is a no-op (the 8 pre-wired hooks skip).
#   * ATOMIC — each upsert writes a temp file, is re-validated with `jq .`, then
#     mv-renamed over settings.json (never a half-written file).
#   * BACKED UP — settings.json is copied to a timestamped backup before the
#     FIRST mutation; the backup path is printed for user rollback.
#   * LOUD-FAIL — absent settings.json → create a minimal {} skeleton (so a clean
#     install still wires); a malformed (unparseable) settings.json ABORTS rather
#     than risk corrupting user config.
wire_hooks() {
  command -v jq >/dev/null 2>&1 || die "jq required to wire hooks into ${SETTINGS_JSON}"

  if "${DRY_RUN}"; then
    log "dry-run: skipping settings.json hook merge (no mutation in staging)"
    return 0
  fi

  # absent settings.json → minimal skeleton so a clean install can still wire.
  if [[ ! -f "${SETTINGS_JSON}" ]]; then
    log "wire_hooks: settings.json absent — creating minimal skeleton ${SETTINGS_JSON}"
    mkdir -p -- "$(dirname -- "${SETTINGS_JSON}")"
    printf '%s\n' '{}' >"${SETTINGS_JSON}"
  fi

  # malformed settings.json → ABORT (never silently corrupt user config).
  if ! jq -e . -- "${SETTINGS_JSON}" >/dev/null 2>&1; then
    die "wire_hooks: ${SETTINGS_JSON} is not valid JSON — refusing to merge (fix or restore it first)"
  fi

  # REPOINT existing bindings BEFORE the idempotency loop. is_hook_bound compares
  # by BASENAME, so an established install whose commands still point at the OLD
  # ${HOME}/.claude/hooks dir would be seen as "already wired" and the add-loop
  # would SKIP them → the template repoint below would be a silent no-op. The
  # rewrite pass first migrates any old-dir command to the new dir so a repoint
  # actually lands (see rewrite_hook_paths).
  rewrite_hook_paths

  # back up ONCE before the FIRST mutation — timestamped, user-recoverable. Taken
  # lazily (only when a binding is actually about to be written) so a fully-wired
  # re-run stays a true no-op (zero filesystem writes), not an accumulating backup.
  local backup=""

  local binding event hook matcher cmd added=0 already=0
  for binding in "${EXPECTED_HOOK_BINDINGS[@]}"; do
    IFS=$'\t' read -r event hook matcher <<<"${binding}"
    # command template repointed to the in-place ~/.glass-atrium/hooks consumer
    # (the ~/.claude/hooks farm is dropped; hooks fire from the install root).
    cmd="${HOME}/.glass-atrium/hooks/${hook}"

    # idempotency: already bound under this event+matcher (command-within-matcher
    # compare) → no-op. Matcher-scoped so the same hook can be wired under two
    # distinct matchers (e.g. validate-secret-scan.sh on Write|Edit AND on Bash)
    # without the first wiring masking the second.
    # is_hook_bound returns 0 by contract (stdout verdict) → masking is intentional
    # (SC2311 = the sourced-lib analog of SC2310; no file-scope set -e here)
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_hook_bound "${event}" "${hook}" "${matcher}")" == "yes" ]]; then
      log "  skip (already wired): ${event} -> ${hook} (matcher=${matcher:-<none>})"
      already=$((already + 1))
      continue
    fi

    # build the new hook-group object: with a matcher key when non-empty, without
    # one for unmatched events (SessionStart/Stop). --arg everywhere → no command
    # or matcher value is ever interpolated into the jq program (injection-safe).
    # RENDER_TMP-tracked so an INT/TERM during the jq>tmp is trap-swept (F-7).
    RENDER_TMP="${SETTINGS_JSON}.ga-wire.$$"
    if [[ -n "${matcher}" ]]; then
      jq --arg ev "${event}" --arg m "${matcher}" --arg c "${cmd}" '
        .hooks //= {}
        | .hooks[$ev] //= []
        | .hooks[$ev] += [ { "matcher": $m, "hooks": [ { "type": "command", "command": $c } ] } ]
      ' -- "${SETTINGS_JSON}" >"${RENDER_TMP}"
    else
      jq --arg ev "${event}" --arg c "${cmd}" '
        .hooks //= {}
        | .hooks[$ev] //= []
        | .hooks[$ev] += [ { "hooks": [ { "type": "command", "command": $c } ] } ]
      ' -- "${SETTINGS_JSON}" >"${RENDER_TMP}"
    fi

    # re-validate the transform output before swapping it in — a malformed temp
    # file (jq partial write / disk error) must never replace the live file.
    if ! jq -e . -- "${RENDER_TMP}" >/dev/null 2>&1; then
      rm -f -- "${RENDER_TMP}"
      RENDER_TMP=""
      die "wire_hooks: merge produced invalid JSON for ${event} -> ${hook} — backup: ${backup:-(none taken — no mutation occurred)}"
    fi

    # lazy backup: take it exactly once, immediately before the FIRST real write.
    if [[ -z "${backup}" ]]; then
      backup="${SETTINGS_JSON}.ga-backup.$(date +%Y%m%d-%H%M%S)"
      cp -p -- "${SETTINGS_JSON}" "${backup}"
      log "wire_hooks: backed up settings.json -> ${backup}"
    fi

    mv -f -- "${RENDER_TMP}" "${SETTINGS_JSON}"
    RENDER_TMP=""
    log "  wired: ${event} -> ${hook} (matcher=${matcher:-<none>})"
    added=$((added + 1))
  done

  log "wire_hooks: ${added} binding(s) added, ${already} already wired (backup: ${backup:-none — no mutation})"
}

# --- settings.json un-wire (remove ALL Atrium hook bindings) ----------------
# Removes EVERY hook-group in settings.json whose command resolves into EITHER
# Atrium hooks directory — the legacy farm dir (~/.claude/hooks) or the in-place
# consumer dir (~/.glass-atrium/hooks) — across ALL events. This is
# DELIBERATELY independent of the EXPECTED_HOOK_BINDINGS enumeration: that array
# lists the complete install-wired binding set (42 entries), whereas the deployed
# symlink farm can carry bindings outside that set (a user may hand-wire an Atrium
# hook, or the array may drift from the physically deployed set) — iterating the
# array would leave the
# surplus bound (dead links after uninstall). Both dirs are Atrium-owned —
# ~/.claude/hooks IS the Atrium-managed legacy symlink farm (removed on
# uninstall) and ~/.glass-atrium/hooks IS the release tree the repointed wire
# template binds — so ANY binding pointing into either becomes dead: it must go.
#
# PATH-TOLERANT match (mirrors the doctor check's tilde-vs-absolute tolerance):
# a command matches when, after normalizing a leading '~' to $HOME, it carries
# the "$HOME/.claude/hooks/" OR "$HOME/.glass-atrium/hooks/" prefix. So the
# tilde form ('~/.claude/hooks/<x>',
# the shape real settings.json stores), the ${HOME}-expanded absolute form, and
# the literal absolute form ALL match, while a user hook elsewhere (e.g.
# '~/my-hooks/x.sh') is preserved. Basename-independent — it keys on the hooks
# DIR, not on the (stale/partial) list of expected basenames.
#
# SAFETY CONTRACT (why this cannot remove user config):
#   * SCOPED removal — a hook-group is deleted ONLY when it holds a command that
#     resolves into the Atrium hooks dir. A user's own hook entry (ANY other
#     path, e.g. ~/my-hooks/x.sh) is never matched, so it survives.
#   * BACKED UP — settings.json is copied to a timestamped backup before the
#     FIRST mutation; the backup path is printed for rollback.
#   * ATOMIC — each per-event edit writes a temp file, is re-validated with
#     `jq .`, then mv-renamed over settings.json (never a half-written file).
#   * KEY-PRUNE symmetry — wire_hooks CREATES an event key via `.hooks[$ev] //= []`,
#     so un-wire prunes a key IT emptied (before>0 && after==0) to restore the
#     user's original byte-identically; a pre-existing user-owned empty array
#     (before==0) is left untouched.
#   * INJECTION-SAFE — event/dir/home flow through --arg only; no value is ever
#     interpolated into the jq program.
#   * LOUD-FAIL — a malformed (unparseable) settings.json ABORTS rather than
#     risk corrupting user config; an absent settings.json is a no-op.
#   * IDEMPOTENT — a re-run after a clean un-wire removes nothing (no-op).
unwire_hooks() {
  command -v jq >/dev/null 2>&1 || die "jq required to un-wire hooks from ${SETTINGS_JSON}"

  if [[ ! -f "${SETTINGS_JSON}" ]]; then
    log "unwire_hooks: settings.json absent (${SETTINGS_JSON}) — nothing to un-wire"
    return 0
  fi
  if ! jq -e . -- "${SETTINGS_JSON}" >/dev/null 2>&1; then
    die "unwire_hooks: ${SETTINGS_JSON} is not valid JSON — refusing to edit (fix or restore it first)"
  fi

  # DRY_RUN log-and-skip: skip ALL settings.json mutation (including the backup cp,
  # which is itself a write). A dry-run reports intent only — no edit, no backup.
  if "${DRY_RUN}"; then
    log "dry-run: skipping settings.json un-wire (${SETTINGS_JSON})"
    return 0
  fi

  # back up ONCE before the first mutation — timestamped, user-recoverable.
  local backup
  backup="${SETTINGS_JSON}.ga-backup.$(date +%Y%m%d-%H%M%S)"
  cp -p -- "${SETTINGS_JSON}" "${backup}"
  log "unwire_hooks: backed up settings.json -> ${backup}"

  # Atrium hooks dirs (absolute, current $HOME) — DUAL: the legacy farm dir
  # (${HOME}/.claude/hooks/) AND the in-place consumer dir (${HOME}/.glass-atrium/
  # hooks/) that the repointed wire template now emits. Any binding whose command
  # resolves under EITHER is Atrium-owned — matched path-tolerantly (a leading '~'
  # is normalized to $HOME below, so tilde + absolute forms both match). Both
  # prefixes are Atrium-owned, so the "foreign user hooks survive" property holds.
  local hooks_dir="${HOME}/.claude/hooks/"
  local hooks_dir_new="${HOME}/.glass-atrium/hooks/"

  # iterate EVERY event under .hooks (SoT-INDEPENDENT — NOT EXPECTED_HOOK_BINDINGS)
  # so all deployed + future Atrium hooks are covered. The key list is snapshotted
  # from the pre-mutation file; we only ever DELETE keys, so it stays a valid
  # superset as the loop mutates settings.json (a pruned key is simply never
  # revisited). Non-object/absent .hooks yields no keys (safe no-op).
  local removed=0 event
  # jq output streamed via process substitution → loop stays in the current shell.
  # shellcheck disable=SC2312
  while IFS= read -r event; do
    [[ -n "${event}" ]] || continue

    local tmp
    tmp="${SETTINGS_JSON}.ga-unwire.$$"
    # DROP every hook-group under this event that holds a command resolving into
    # EITHER Atrium hooks dir. into_hooksdir normalizes a leading '~' to $HOME (via
    # string slicing — never regex, so a $HOME with regex/replacement metachars is
    # byte-safe), then tests the "$HOME/.claude/hooks/" AND "$HOME/.glass-atrium/
    # hooks/" prefixes. A user hook at any other path fails both and is preserved.
    # --arg everywhere → no value is interpolated into the jq program (injection-
    # safe). Editing over an absent / non-array .hooks[event] is a safe no-op (the
    # `else .` branch returns input).
    jq --arg ev "${event}" --arg dir "${hooks_dir}" --arg dir2 "${hooks_dir_new}" --arg home "${HOME}" '
      def into_hooksdir:
        (. // "")
        | (if startswith("~/") then $home + .[1:] else . end)
        | (startswith($dir) or startswith($dir2));
      if (.hooks[$ev] | type) == "array" then
        .hooks[$ev] |= map(
          select(
            ([ (.hooks // [])[]? | .command | into_hooksdir ] | any) | not
          )
        )
      else . end
    ' -- "${SETTINGS_JSON}" >"${tmp}"

    if ! jq -e . -- "${tmp}" >/dev/null 2>&1; then
      rm -f -- "${tmp}"
      die "unwire_hooks: edit produced invalid JSON for event ${event} — backup preserved at ${backup}"
    fi

    # count real removals — group count before/after for this event.
    local before after
    before="$(jq --arg ev "${event}" '(.hooks[$ev] // []) | length' -- "${SETTINGS_JSON}")"
    after="$(jq --arg ev "${event}" '(.hooks[$ev] // []) | length' -- "${tmp}")"

    # symmetric-inverse contract: install's wire_hooks CREATES an event key via
    # `.hooks[$ev] //= []` when binding the first Atrium hook for that event, so
    # un-wire MUST prune the key it just emptied to restore the user's original
    # byte-identically. Guard on `before > 0` → only delete a key WE emptied;
    # a pre-existing user-owned empty array (before == 0) is left untouched.
    if [[ "${after}" -eq 0 && "${before}" -gt 0 ]]; then
      local pruned
      pruned="${SETTINGS_JSON}.ga-prune.$$"
      jq --arg ev "${event}" 'del(.hooks[$ev])' -- "${tmp}" >"${pruned}"
      if ! jq -e . -- "${pruned}" >/dev/null 2>&1; then
        rm -f -- "${pruned}" "${tmp}"
        die "unwire_hooks: prune produced invalid JSON for event ${event} — backup preserved at ${backup}"
      fi
      mv -f -- "${pruned}" "${tmp}"
    fi

    mv -f -- "${tmp}" "${SETTINGS_JSON}"
    local delta=$((before - after))
    if [[ "${delta}" -gt 0 ]]; then
      log "  un-wired: ${event} — ${delta} Atrium binding-group(s) removed"
      removed=$((removed + delta))
    fi
  done < <(jq -r 'if (.hooks | type) == "object" then (.hooks | keys[]) else empty end' -- "${SETTINGS_JSON}")

  log "unwire_hooks: ${removed} Atrium binding-group(s) removed across all events (backup: ${backup})"
}

# --- config.toml purge (opt-in, mv-to-Trash — never rm a config) -----------
purge_config() {
  if "${DRY_RUN}"; then
    log "dry-run: skipping config.toml purge (would mv ${CONFIG_TOML} -> Trash)"
    return 0
  fi
  if [[ ! -f "${CONFIG_TOML}" ]]; then
    log "purge_config: ${CONFIG_TOML} absent — nothing to purge"
    return 0
  fi
  local trash="${HOME}/.Trash"
  mkdir -p -- "${trash}"
  # timestamp the moved name to avoid clobbering a prior purge in the Trash.
  # separated decl/assign (SC2155 — `local x=$(cmd)` masks the cmd exit code).
  local dest
  dest="${trash}/config.toml.ga-purged.$(date +%Y%m%d-%H%M%S)"
  mv -f -- "${CONFIG_TOML}" "${dest}"
  log "purge_config: moved ${CONFIG_TOML} -> ${dest} (Trash; never rm'd)"
}
