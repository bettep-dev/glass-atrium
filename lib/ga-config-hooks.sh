# shellcheck shell=bash
# shellcheck disable=SC2154  # shared globals (SETTINGS_JSON/CONFIG_TOML/CONFIG_TOML_EXAMPLE/EXPECTED_HOOK_BINDINGS/DRY_RUN/RE_RENDER) set by ga_init_env in ga-env.sh — unresolvable when linted standalone
# Glass Atrium — config.toml render + settings.json hook wiring domain. Sourced in-process by lib/ga-core.sh; no file-scope strict mode / traps (owned by the entry point).

# settings.json hook-binding query (read-only, D-5) — echo "yes"/"no" for <hook-basename> under <event> (optionally <matcher>); basename compare tolerates the ~/.claude/hooks/ vs absolute prefix.
# Read-ONLY: NEVER writes settings.json (mutation-free doctor contract).
# Matcher-scoped (command-WITHIN-matcher): a non-empty 3rd arg counts only hook-groups whose matcher EQUALS it, tracking each (event, matcher, basename) tuple independently — REQUIRED so one hook binds under two matchers (validate-secret-scan.sh on Write|Edit AND Bash). Absent matcher key ≡ empty-string matcher; empty 3rd arg → legacy event+basename match (matcher ignored).
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
  # collect command basenames under the event (matcher-scoped), then match the requested one; jq failure (malformed json) → empty → "no" (loud-fail).
  # --arg everywhere → matcher/event never interpolated into the jq program (injection-safe).
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

# config.toml render — expand ONLY the ${HOME} placeholder in config.toml.example (tracked template) into config.toml (git-ignored); every other literal stays verbatim.
# ORDERING CONTRACT (load-bearing): MUST complete BEFORE any render-monitor-env.sh call — that script reads config.toml VERBATIM and validates [paths].monitor_docs_html_root as an EXISTING ABSOLUTE dir (exit 9 on unexpanded ${HOME}), so render-before-validate is mandatory.
# IDEMPOTENT: no-op when config.toml has ZERO unexpanded ${HOME} tokens; --re-render forces a fresh render. Renders the EXAMPLE, never edits a hand-tuned config; a backup is taken first.
# BINARY-PATH RESOLUTION (E1): after expansion, [paths].node_bin/claude_bin are rewritten to the REAL host binaries (resolve_config_binaries; a hardcoded /opt/homebrew/bin/node breaks nvm/fnm), on EVERY render path INCLUDING the idempotency early-return so a re-render never leaves the template default.
# Substitution via awk (NOT sed): sed's replacement interprets `&`/`\`, so a HOME containing them (legal on macOS, e.g. /Users/a&b) would corrupt the config; awk's ENVIRON[] reads byte-for-byte, only the literal ${HOME} token touched.
render_config() {
  [[ -f "${CONFIG_TOML_EXAMPLE}" ]] || die "config template missing: ${CONFIG_TOML_EXAMPLE}"

  # idempotency: existing config with no unexpanded ${HOME} → skip (unless forced).
  # grep -c zero-match trap: `|| true` keeps set -e quiet (grep exit 1 = no match), empty-guard normalizes a blank count to 0 (`grep -c ... || echo 0` would print "0\n0").
  if [[ -f "${CONFIG_TOML}" ]] && ! "${RE_RENDER}"; then
    local unexpanded
    # single-quoted BRE: literal ${HOME} is the grep PATTERN, \$ escapes the BRE anchor — SC2016 intentional.
    # shellcheck disable=SC2016
    unexpanded="$(grep -c '\${HOME}' -- "${CONFIG_TOML}" || true)"
    [[ -z "${unexpanded}" ]] && unexpanded=0
    if [[ "${unexpanded}" -eq 0 ]]; then
      log "render_config: ${CONFIG_TOML} already fully expanded — skip \${HOME} expansion (use --re-render to force)"
      # E1: binary-path resolution MUST run on this early-return too, else a re-render leaves node_bin/claude_bin at the template default; this path bypasses the DRY_RUN check below, so DRY_RUN is guarded explicitly here.
      if "${DRY_RUN}"; then
        log "dry-run: would resolve absolute node_bin/claude_bin in ${CONFIG_TOML}"
      else
        # pre-write backup: this early-return skipped the full-render backup, so resolve_config_binaries would rewrite a possibly hand-tuned config with NO safety copy — mirror the full-render backup before resolving.
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

  # atomic write: render to a temp then mv over the target (never a half file); RENDER_TMP-tracked so an INT/TERM during the awk>tmp is trap-swept (F-7).
  RENDER_TMP="${CONFIG_TOML}.ga-render.$$"
  # awk replaces the literal ${HOME} with ENVIRON["GA_RENDER_HOME"] byte-for-byte (no `&`/`\` interpretation, unlike sed); the token is a fixed internal constant → safe via -v, HOME (untrusted charset) goes through ENVIRON[] only.
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

  # E1: resolve host-real node_bin/claude_bin into the freshly-rendered [paths] (DRY_RUN already returned above → real render only).
  resolve_config_binaries
}

# E1 binary-path resolver helpers (Stepdown: callees of render_config).
# ga_resolve_bin — echo a binary's directory-canonicalized absolute path, macOS-portable (NO GNU realpath / readlink -f): canonicalizes the CONTAINING dir via `cd … && pwd -P` while PRESERVING the basename — deliberately NOT dereferencing a final bin/<tool> symlink, because Homebrew's stable /opt/homebrew/bin/<tool> symlink survives a minor upgrade whereas the Cellar target does not. Returns 1 (caller falls back to the literal input) when the dir is absent.
ga_resolve_bin() {
  local p="$1" dir base
  [[ -n "${p}" ]] || return 1
  dir="$(cd -- "$(dirname -- "${p}")" >/dev/null 2>&1 && pwd -P)" || return 1
  base="$(basename -- "${p}")"
  printf '%s/%s' "${dir}" "${base}"
}

# resolve_config_binaries — rewrite [paths].node_bin/claude_bin in CONFIG_TOML with the REAL host binaries (node_bin: `command -v node` absolute; claude_bin: `command -v claude` else the native-installer ${HOME}/.local/bin/claude absolute).
# Idempotent + atomic (temp + mv, RENDER_TMP-tracked for the trap sweep); a missing claude_bin line (older configs) is INSERTED after node_bin, a present one replaced.
# node absent on PATH leaves node_bin untouched (loud log, never a blank value); never replaces a non-empty config with an empty file.
resolve_config_binaries() {
  [[ -f "${CONFIG_TOML}" ]] || return 0

  local node_src claude_src node_bin claude_bin
  node_src="$(command -v node 2>/dev/null || true)"
  claude_src="$(command -v claude 2>/dev/null || true)"
  # native-installer location when claude is not yet on PATH (~/.local/bin/claude).
  [[ -n "${claude_src}" ]] || claude_src="${HOME}/.local/bin/claude"

  node_bin=""
  if [[ -n "${node_src}" ]]; then
    # `|| printf` fallback degrades an unresolvable path to the PATH-absolute source instead of aborting; the cmd-sub + `||` intentionally masks set -e (same stdout-verdict idiom as the is_* helpers).
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
  # awk rewrite, table-scoped to [paths]: only node_bin/claude_bin touched — a non-empty var replaces its line, an empty var preserves it; has_claude==0 inserts claude_bin after node_bin.
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

# wire repoint primitive: migrate old-dir hook commands to the new dir.
# WHY: an established install wired hooks under ${HOME}/.claude/hooks/<hook>; after the command-template repoint (wire_hooks now emits ${HOME}/.glass-atrium/hooks) is_hook_bound() still matches those stale bindings BY BASENAME, so the add-loop would treat them as already-wired and SKIP → silent no-op. This pass REWRITES every command under the OLD Atrium dir to the NEW one (basename + suffix preserved) before the idempotency check runs.
# DATA-SAFETY (same "only Atrium commands" property as unwire_hooks): only a command whose tilde-normalized path startswith ${HOME}/.claude/hooks/ is rewritten — a foreign user hook at any other path is preserved byte-for-byte. MERGE (every other key flows through `.`), ATOMIC (temp + jq-revalidate + mv, RENDER_TMP trap-swept), BACKED-UP (lazy, distinct suffix so it never clobbers wire_hooks' own backup), injection-safe (--arg everywhere → no path value reaches the jq program text).
rewrite_hook_paths() {
  local old_dir="${HOME}/.claude/hooks/"
  local new_dir="${HOME}/.glass-atrium/hooks/"

  # count commands resolving under the old dir (tilde-aware); jq failure (malformed json already ruled out by the caller) → 0 → clean no-op.
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

  # back up ONCE before the rewrite — distinct suffix from wire_hooks' backup so a same-second wire backup cannot overwrite this pre-rewrite image.
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

# settings.json hook-binding MERGE (idempotent upsert — owns ONLY the Atrium hook commands, never any other key).
# Upserts each EXPECTED_HOOK_BINDINGS entry under its event with the declared matcher + the "$HOME/.glass-atrium/hooks/<basename>" command.
# SAFETY CONTRACT (why this cannot clobber user config):
#   * MERGE not overwrite — the jq transform reads the FULL existing object and only APPENDS a hook-group to one .hooks.<event>; every other key (permissions, env, model, statusLine, user hook entries) flows through `.` unchanged — no key ever deleted, replaced, or reordered.
#   * IDEMPOTENT — is_hook_bound() (basename compare within the event) checked first; an already-present command is a no-op (the 8 pre-wired hooks skip).
#   * ATOMIC — each upsert writes a temp, re-validates with `jq .`, then mv over settings.json (never a half-written file).
#   * BACKED UP — settings.json copied to a timestamped backup before the FIRST mutation; the backup path is printed for rollback.
#   * LOUD-FAIL — absent settings.json → create a minimal {} skeleton (clean install still wires); a malformed (unparseable) settings.json ABORTS rather than risk corrupting user config.
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

  # REPOINT existing bindings BEFORE the idempotency loop: is_hook_bound compares by BASENAME, so an established install still pointing at the OLD ${HOME}/.claude/hooks dir would look "already wired" and be SKIPPED → silent no-op. rewrite_hook_paths migrates old-dir commands to the new dir first so the repoint lands.
  rewrite_hook_paths

  # back up ONCE before the FIRST mutation — timestamped, user-recoverable; taken lazily (only when a binding is about to be written) so a fully-wired re-run stays a true no-op (zero writes), not an accumulating backup.
  local backup=""

  local binding event hook matcher cmd added=0 already=0
  for binding in "${EXPECTED_HOOK_BINDINGS[@]}"; do
    IFS=$'\t' read -r event hook matcher <<<"${binding}"
    # command template → in-place ~/.glass-atrium/hooks consumer (the ~/.claude/hooks farm is dropped; hooks fire from the install root).
    cmd="${HOME}/.glass-atrium/hooks/${hook}"

    # idempotency: already bound under this event+matcher (command-within-matcher compare) → no-op; matcher-scoped so the same hook wires under two matchers (validate-secret-scan.sh on Write|Edit AND Bash) without the first masking the second.
    # is_hook_bound returns 0 by contract (stdout verdict) → masking intentional (SC2311 = the sourced-lib analog of SC2310; no file-scope set -e here).
    # shellcheck disable=SC2310,SC2311,SC2312
    if [[ "$(is_hook_bound "${event}" "${hook}" "${matcher}")" == "yes" ]]; then
      log "  skip (already wired): ${event} -> ${hook} (matcher=${matcher:-<none>})"
      already=$((already + 1))
      continue
    fi

    # build the new hook-group object: a matcher key when non-empty, omitted for unmatched events (SessionStart/Stop). --arg everywhere → no command/matcher value interpolated into the jq program (injection-safe). RENDER_TMP-tracked so an INT/TERM during the jq>tmp is trap-swept (F-7).
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

    # re-validate the transform output before swapping it in — a malformed temp (jq partial write / disk error) must never replace the live file.
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

# settings.json un-wire (remove ALL Atrium hook bindings).
# Removes EVERY hook-group whose command resolves into EITHER Atrium hooks dir — the legacy farm (~/.claude/hooks) or the in-place consumer (~/.glass-atrium/hooks) — across ALL events. DELIBERATELY independent of EXPECTED_HOOK_BINDINGS: that array lists the install-wired set, but the deployed farm can carry bindings outside it (a user may hand-wire an Atrium hook, or the array may drift), and iterating the array would leave the surplus bound (dead links after uninstall). Both dirs are Atrium-owned (legacy farm removed on uninstall; ~/.glass-atrium/hooks is the release tree the repointed wire template binds), so ANY binding into either is dead and must go; foreign user hooks survive.
# PATH-TOLERANT match (mirrors the doctor check's tilde-vs-absolute tolerance): after normalizing a leading '~' to $HOME, a command matches on the "$HOME/.claude/hooks/" OR "$HOME/.glass-atrium/hooks/" prefix — the tilde form (what real settings.json stores), the ${HOME}-expanded absolute, and the literal absolute ALL match, while a user hook elsewhere (~/my-hooks/x.sh) is preserved. Basename-independent — keys on the hooks DIR, not the (stale/partial) expected-basename list.
# SAFETY CONTRACT (why this cannot remove user config):
#   * SCOPED removal — a hook-group is deleted ONLY when it holds a command resolving into an Atrium hooks dir; a user's own hook (ANY other path, e.g. ~/my-hooks/x.sh) is never matched, so it survives.
#   * BACKED UP — settings.json copied to a timestamped backup before the FIRST mutation; the backup path is printed for rollback.
#   * ATOMIC — each per-event edit writes a temp, re-validates with `jq .`, then mv over settings.json (never a half-written file).
#   * KEY-PRUNE symmetry — wire_hooks CREATES an event key via `.hooks[$ev] //= []`, so un-wire prunes a key IT emptied (before>0 && after==0) to restore the user's original byte-identically; a pre-existing user-owned empty array (before==0) is left untouched.
#   * INJECTION-SAFE — event/dir/home flow through --arg only; no value is ever interpolated into the jq program.
#   * LOUD-FAIL — a malformed settings.json ABORTS rather than risk corrupting user config; an absent one is a no-op.
#   * IDEMPOTENT — a re-run after a clean un-wire removes nothing.
unwire_hooks() {
  command -v jq >/dev/null 2>&1 || die "jq required to un-wire hooks from ${SETTINGS_JSON}"

  if [[ ! -f "${SETTINGS_JSON}" ]]; then
    log "unwire_hooks: settings.json absent (${SETTINGS_JSON}) — nothing to un-wire"
    return 0
  fi
  if ! jq -e . -- "${SETTINGS_JSON}" >/dev/null 2>&1; then
    die "unwire_hooks: ${SETTINGS_JSON} is not valid JSON — refusing to edit (fix or restore it first)"
  fi

  # DRY_RUN log-and-skip: skip ALL settings.json mutation including the backup cp (itself a write) — a dry-run reports intent only, no edit, no backup.
  if "${DRY_RUN}"; then
    log "dry-run: skipping settings.json un-wire (${SETTINGS_JSON})"
    return 0
  fi

  # back up ONCE before the first mutation — timestamped, user-recoverable.
  local backup
  backup="${SETTINGS_JSON}.ga-backup.$(date +%Y%m%d-%H%M%S)"
  cp -p -- "${SETTINGS_JSON}" "${backup}"
  log "unwire_hooks: backed up settings.json -> ${backup}"

  # Atrium hooks dirs (absolute, current $HOME) — DUAL: the legacy farm (${HOME}/.claude/hooks/) AND the in-place consumer (${HOME}/.glass-atrium/hooks/) the repointed wire template emits. A binding whose command resolves under EITHER is Atrium-owned (matched path-tolerantly — a leading '~' is normalized to $HOME below); foreign user hooks elsewhere survive.
  local hooks_dir="${HOME}/.claude/hooks/"
  local hooks_dir_new="${HOME}/.glass-atrium/hooks/"

  # iterate EVERY event under .hooks (SoT-INDEPENDENT — NOT EXPECTED_HOOK_BINDINGS) so all deployed + future Atrium hooks are covered. Key list is snapshotted from the pre-mutation file; we only ever DELETE keys, so it stays a valid superset as the loop mutates settings.json (a pruned key is never revisited). Non-object/absent .hooks yields no keys (safe no-op).
  local removed=0 event
  # jq output streamed via process substitution → loop stays in the current shell.
  # shellcheck disable=SC2312
  while IFS= read -r event; do
    [[ -n "${event}" ]] || continue

    local tmp
    tmp="${SETTINGS_JSON}.ga-unwire.$$"
    # DROP every hook-group under this event holding a command that resolves into EITHER Atrium dir. into_hooksdir normalizes a leading '~' to $HOME via string slicing — NEVER regex, so a $HOME with regex/replacement metachars is byte-safe — then tests the "$HOME/.claude/hooks/" AND "$HOME/.glass-atrium/hooks/" prefixes; a user hook at any other path fails both and is preserved. --arg everywhere → injection-safe; editing over an absent/non-array .hooks[event] is a safe no-op (`else .` returns input).
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

    # symmetric-inverse: wire_hooks CREATES an event key via `.hooks[$ev] //= []`, so un-wire MUST prune the key it just emptied to restore the user's original byte-identically. Guard `before > 0` → only delete a key WE emptied; a pre-existing user-owned empty array (before == 0) is left untouched.
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

# settings.json TARGETED hook-binding retirement (#13) — retire the binding for ONE
# specific vendor-REMOVED hook basename, across ALL events. The `glass-atrium update`
# vendor-removal sweep Trashes a dropped hook FILE, but its settings.json event->hook
# BINDING lingers and still points at the now-absent file, so the hook ERRORS when its
# event fires. wire_hooks only ADDS bindings and unwire_hooks removes ALL of them (too
# broad for an update) — this retires EXACTLY the dropped hook's binding. Arg: $1 = hook
# basename (e.g. "foo-hook.sh").
# SCOPE (surgical — narrower than unwire_hooks' remove-ALL): a hook-GROUP is dropped ONLY
# when it holds a command that, tilde-normalized, EQUALS "$HOME/.claude/hooks/<basename>"
# OR "$HOME/.glass-atrium/hooks/<basename>" — the exact command wire_hooks emitted for
# that basename in EITHER Atrium dir. A same-basename hook at a FOREIGN path, and every
# OTHER Atrium binding, is preserved byte-for-byte.
# SAFETY CONTRACT (same as unwire_hooks): MERGE not overwrite (every other key flows
# through `.`) · ATOMIC (temp + jq-revalidate + mv) · BACKED-UP once, LAZILY, before the
# FIRST real write (a no-op retire stays a true zero-write) · KEY-PRUNE symmetry (prune a
# key WE emptied, leave a pre-existing user-owned empty []) · INJECTION-SAFE (--arg only)
# · LOUD-FAIL on malformed JSON · IDEMPOTENT (a re-run retires nothing) · DRY_RUN skip.
retire_hook_binding() {
  local hook="${1:-}"
  [[ -n "${hook}" ]] || die "retire_hook_binding: a hook basename argument is required"
  command -v jq >/dev/null 2>&1 || die "jq required to retire a hook binding from ${SETTINGS_JSON}"

  if [[ ! -f "${SETTINGS_JSON}" ]]; then
    log "retire_hook_binding: settings.json absent (${SETTINGS_JSON}) — nothing to retire for ${hook}"
    return 0
  fi
  if ! jq -e . -- "${SETTINGS_JSON}" >/dev/null 2>&1; then
    die "retire_hook_binding: ${SETTINGS_JSON} is not valid JSON — refusing to edit (fix or restore it first)"
  fi

  # DRY_RUN log-and-skip: no mutation, no backup (report intent only).
  if "${DRY_RUN}"; then
    log "dry-run: skipping settings.json retire of ${hook} (${SETTINGS_JSON})"
    return 0
  fi

  # Atrium hooks dirs (absolute, current $HOME) — DUAL: the legacy farm AND the in-place
  # consumer the repointed wire template emits; a binding under EITHER is Atrium-owned.
  local hooks_dir="${HOME}/.claude/hooks/"
  local hooks_dir_new="${HOME}/.glass-atrium/hooks/"

  # iterate EVERY event under .hooks; the key list is snapshotted from the pre-mutation
  # file (process sub runs ONCE) and stays a valid superset since we only ever DELETE.
  local backup="" removed=0 event
  # jq output streamed via process substitution → loop stays in the current shell.
  # shellcheck disable=SC2312
  while IFS= read -r event; do
    [[ -n "${event}" ]] || continue

    local tmp
    tmp="${SETTINGS_JSON}.ga-retire.$$"
    # DROP every hook-group under this event whose command, tilde-normalized, EQUALS the
    # exact wire_hooks command for this basename in EITHER Atrium dir. is_target normalizes
    # a leading '~' to $HOME via string slicing (NEVER regex — a $HOME with metachars stays
    # byte-safe), then exact-matches $dir+$base OR $dir2+$base; a foreign-path or
    # different-basename command fails both and is preserved. --arg only → injection-safe;
    # an absent/non-array .hooks[event] is a safe no-op (`else .` returns input).
    jq --arg ev "${event}" --arg dir "${hooks_dir}" --arg dir2 "${hooks_dir_new}" \
      --arg home "${HOME}" --arg base "${hook}" '
      def is_target:
        (. // "")
        | (if startswith("~/") then $home + .[1:] else . end)
        | (. == ($dir + $base)) or (. == ($dir2 + $base));
      if (.hooks[$ev] | type) == "array" then
        .hooks[$ev] |= map(
          select(
            ([ (.hooks // [])[]? | .command | is_target ] | any) | not
          )
        )
      else . end
    ' -- "${SETTINGS_JSON}" >"${tmp}"

    if ! jq -e . -- "${tmp}" >/dev/null 2>&1; then
      rm -f -- "${tmp}"
      die "retire_hook_binding: edit produced invalid JSON for event ${event} — backup: ${backup:-(none taken — no mutation occurred)}"
    fi

    # group count before/after for this event — the real-removal delta.
    local before after
    before="$(jq --arg ev "${event}" '(.hooks[$ev] // []) | length' -- "${SETTINGS_JSON}")"
    after="$(jq --arg ev "${event}" '(.hooks[$ev] // []) | length' -- "${tmp}")"

    # no change under this event → discard the temp WITHOUT a write/backup (keep the
    # no-op zero-write property; a basename bound under no event leaves settings.json
    # byte-identical, no backup file).
    if [[ "${before}" -eq "${after}" ]]; then
      rm -f -- "${tmp}"
      continue
    fi

    # KEY-PRUNE symmetry: wire_hooks CREATES an event key via `.hooks[$ev] //= []`, so a
    # retire that empties it MUST prune the key (before>0 && after==0) to restore the
    # user's original byte-identically; a pre-existing user-owned empty [] (before==0) is
    # left untouched.
    if [[ "${after}" -eq 0 && "${before}" -gt 0 ]]; then
      local pruned
      pruned="${SETTINGS_JSON}.ga-retire-prune.$$"
      jq --arg ev "${event}" 'del(.hooks[$ev])' -- "${tmp}" >"${pruned}"
      if ! jq -e . -- "${pruned}" >/dev/null 2>&1; then
        rm -f -- "${pruned}" "${tmp}"
        die "retire_hook_binding: prune produced invalid JSON for event ${event} — backup: ${backup:-(none taken — no mutation occurred)}"
      fi
      mv -f -- "${pruned}" "${tmp}"
    fi

    # lazy backup: taken EXACTLY once, immediately before the first real write. Every
    # prior iteration was a before==after no-op (no write), so settings.json is still
    # the pre-mutation original here → the backup captures it faithfully.
    if [[ -z "${backup}" ]]; then
      backup="${SETTINGS_JSON}.ga-backup.$(date +%Y%m%d-%H%M%S)"
      cp -p -- "${SETTINGS_JSON}" "${backup}"
      log "retire_hook_binding: backed up settings.json -> ${backup}"
    fi

    mv -f -- "${tmp}" "${SETTINGS_JSON}"
    local delta=$((before - after))
    log "  retired: ${event} — ${delta} binding-group(s) for ${hook}"
    removed=$((removed + delta))
  done < <(jq -r 'if (.hooks | type) == "object" then (.hooks | keys[]) else empty end' -- "${SETTINGS_JSON}")

  log "retire_hook_binding: ${removed} binding-group(s) retired for ${hook} (backup: ${backup:-none — no mutation})"
}

# config.toml purge (opt-in, mv-to-Trash — never rm a config)
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
