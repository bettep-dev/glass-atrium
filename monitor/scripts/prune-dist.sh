#!/usr/bin/env bash
# Glass Atrium monitor — prune orphaned build products from the compiled outdirs.
#
# WHY THIS EXISTS: neither compiler cleans its outdir. esbuild writes only the entry
# points it was given, tsc only the sources it found. So when a module is deleted the
# build simply stops emitting it and the previously-built file stays behind forever —
# still served by @fastify/static on the client side, still loadable on the server
# side. The updater cannot see it either: the manifest's `retired` map carries only
# manifest MEMBERS, and both dist trees are gitignored, so a build product can never
# enter that map. Measured twice: a deleted screen's source was correctly retired to
# Trash while GET /dist/screens/<name>.js kept returning 200 with the stale 32 KB
# bundle; and two compiled server modules outlived their deleted `.ts` sources.
#
# THE RULE: each dist tree mirrors ONE source tree, and a built `<rel>.js` is orphaned
# when no accepted source extension backs it under that tree's source root:
#   public/dist ← public/src  (.jsx esbuild entry · .js plain source copied as-is)
#   dist/server ← src/server  (.ts · .tsx, compiled by tsc)
# Keying on the SOURCE tree (rather than on the entry list in package.json) keeps a
# single source of truth and needs no parsing of the build command.
#
# WHY THE PAIRS ARE NAMED, NOT `dist` AGAINST `src`: dist/generated holds the compiled
# prisma client, whose source (src/generated) is gitignored and exists only after
# `prisma generate`. A walk keyed on the tree ROOTS would read every compiled client
# module as an orphan wherever generate has not run, and unlink the whole client.
#
# WHY THE MAP TRAVELS WITH ITS MODULE: tsc emits `<rel>.js.map` beside every module
# (sourceMap true, declaration false). The walk matches `*.js` only, so the orphan
# decision is always made on the MODULE and the map follows it — a map whose module
# survives can therefore never be stranded.
#
# WHY AFTER THE BUILD, NOT A PRE-BUILD CLEAN: a clean-then-build leaves the install
# with NO output if the build then fails. Chained at the END of `npm run build`, a
# failed tsc or esbuild stops the chain and the previous output stays in place; and
# because the prune keys on source presence, it removes exactly the orphans and never
# a file the build was about to write.
#
# A missing source tree is NOT "everything is orphaned" — it is a broken layout, so
# BOTH pairs are validated before ANY unlink and a half-broken layout prunes nothing.
#
# `rm` (not a Trash move) is deliberate and sanctioned: both dist trees match the
# gitignore entry `monitor/**/dist/`, are fully regenerable by `npm run build`, and
# pruning runs on every build — a Trash move would grow residue per build. Only
# regular `.js` files (plus the matching `.js.map`) are ever unlinked, and each walk
# RECURSES on purpose: screen bundles land at dist/screens/<name>.js and server
# modules at dist/server/<subdir>/<name>.js, so a depth-1 walk would exempt exactly
# the stale files that motivated this script. Containment comes from the
# resolved-prefix check at the unlink site below, never from walk depth.
#
# Idempotent: a second run finds no orphan and exits 0 silently.
#
# Run from the monitor/ project root (npm sets that cwd), or standalone:
#   $ scripts/prune-dist.sh
set -Eeuo pipefail
IFS=$'\n\t'

# Exit-code semantics (for wrapper-script branching):
#   3 = a source tree is absent while its dist tree exists — REFUSED to prune
#       (pruning against an absent source root would delete that whole dist
#       tree; loud-fail instead). One code covers both pairs: same condition,
#       same remedy, and the message names which pair refused.
readonly EXIT_NO_SRC=3

_prune_log() { printf 'prune-dist: %s\n' "$1" >&2; }

# Single-sited refusal text — the bats suite pins the `REFUSING to prune` prefix.
_prune_refuse() {
  _prune_log "REFUSING to prune — source tree absent (${1}); ${2} left untouched"
}

# One dist tree against its source tree: unlink every `<rel>.js` that no accepted
# source extension backs, together with its `.js.map`.
# Args: <src_root> <dist_root> <noun for the log> <accepted source extension>...
_prune_tree() {
  local src_root="$1" dist_root="$2" noun="$3"
  shift 3
  local exts=("$@")

  # Never built (fresh clone, or a source-only install): nothing to prune.
  if [[ ! -d "${dist_root}" ]]; then
    return 0
  fi

  # Resolve both roots so the containment assertion below compares real paths.
  src_root="$(cd -- "${src_root}" && pwd)"
  dist_root="$(cd -- "${dist_root}" && pwd)"

  local file rel base ext backed removed=0
  # SC2312 (see the note at the `done` line) — the directive must sit in front of
  # the complete compound command, so it lives here rather than on the walk itself.
  # shellcheck disable=SC2312
  # -type f excludes symlinks (find reports those as -type l) and find does not
  # descend into symlinked dirs without -L, so the walk cannot leave dist_root.
  while IFS= read -r -d '' file; do
    # Defense in depth: only ever unlink strictly inside the resolved outdir.
    case "${file}" in
      "${dist_root}"/*) ;;
      *)
        _prune_log "WARN: skipping path outside the outdir — ${file}"
        continue
        ;;
    esac
    rel="${file#"${dist_root}/"}"
    base="${rel%.js}"
    backed=0
    for ext in "${exts[@]}"; do
      if [[ -e "${src_root}/${base}.${ext}" ]]; then
        backed=1
        break
      fi
    done
    if ((backed == 1)); then
      continue
    fi
    if rm -f -- "${file}"; then
      # The map follows its module. `rm -f` on an absent map is a silent success,
      # so this stays correct for the client tree, which emits none.
      rm -f -- "${file}.map"
      _prune_log "removed orphaned ${noun} (source deleted): ${rel}"
      removed=$((removed + 1))
    else
      _prune_log "WARN: failed to remove orphaned ${noun} — ${rel}"
    fi
    # A walk failure yields an empty stream, so the prune degrades to a no-op
    # (never a wipe) — but it degrades LOUDLY rather than silently. SC2312 flags
    # any command inside a process substitution on --enable=all; the `|| ...`
    # below IS the handling it asks for, so the note is disabled, not absorbed.
  done < <(find "${dist_root}" -type f -name '*.js' -print0 \
    || _prune_log "WARN: walk of ${dist_root} failed — prune incomplete, orphans may remain")

  # Stay silent on the overwhelmingly common no-op so a normal build is quiet;
  # speak only when the tree actually changed.
  if ((removed > 0)); then
    _prune_log "pruned ${removed} orphaned ${noun}(s) from ${dist_root}"
  fi
  return 0
}

main() {
  local script_dir monitor_dir client_src client_dist server_src server_dist
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  # ATRIUM_MONITOR_DIR is the test seam (mirrors ATRIUM_UPDATE_MONITOR_DIR in
  # scripts/update.sh); unset in production, where the layout resolves from here.
  monitor_dir="${ATRIUM_MONITOR_DIR:-$(dirname -- "${script_dir}")}"
  client_src="${monitor_dir}/public/src"
  client_dist="${monitor_dir}/public/dist"
  server_src="${monitor_dir}/src/server"
  server_dist="${monitor_dir}/dist/server"

  # Validate BOTH pairs up front: no unlink happens until every pair checks out.
  if [[ -d "${client_dist}" && ! -d "${client_src}" ]]; then
    _prune_refuse "${client_src}" "${client_dist}"
    return "${EXIT_NO_SRC}"
  fi
  if [[ -d "${server_dist}" && ! -d "${server_src}" ]]; then
    _prune_refuse "${server_src}" "${server_dist}"
    return "${EXIT_NO_SRC}"
  fi

  _prune_tree "${client_src}" "${client_dist}" bundle jsx js
  _prune_tree "${server_src}" "${server_dist}" module ts tsx
  return 0
}

main "$@"
