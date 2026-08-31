#!/usr/bin/env bash
# Glass Atrium monitor — prune orphaned client bundles from the esbuild outdir.
#
# WHY THIS EXISTS: esbuild never cleans its --outdir; it only writes the entry
# points it was given. So when a screen is deleted, `build:jsx` simply stops
# emitting that bundle and the previously-built file stays in public/dist
# forever — still served by @fastify/static. The updater cannot see it either:
# the manifest's `retired` map only carries manifest MEMBERS, and public/dist is
# gitignored, so a build product can never enter that map. Measured case: a
# deleted screen's source was correctly retired to Trash while
# GET /dist/screens/<name>.js kept returning 200 with the stale 32 KB bundle.
#
# THE RULE: public/dist mirrors public/src. A built `<rel>.js` is orphaned when
# neither `<rel>.jsx` nor `<rel>.js` exists under public/src. Keying on the
# SOURCE tree (rather than on the entry list in package.json) keeps a single
# source of truth and needs no parsing of the build command.
#
# WHY AFTER THE BUILD, NOT A PRE-BUILD CLEAN: a clean-then-build leaves the
# install with NO bundles if the build then fails. Chained after esbuild, a
# failed build stops the chain and the previous bundles stay in place; and
# because the prune keys on source presence, it removes exactly the orphans and
# never a file the build was about to write.
#
# `rm` (not a Trash move) is deliberate and sanctioned: public/dist is a
# gitignored build artifact, fully regenerable by `npm run build:jsx`, and
# pruning runs on every build — a Trash move would grow ~1 MB of residue per
# build. Only regular files directly under the resolved outdir are touched.
#
# Idempotent: a second run finds no orphan and exits 0 silently.
#
# Run from the monitor/ project root (npm sets that cwd), or standalone:
#   $ scripts/prune-dist.sh
set -Eeuo pipefail
IFS=$'\n\t'

# Exit-code semantics (for wrapper-script branching):
#   3 = source tree missing — REFUSED to prune (pruning against an absent
#       public/src would delete every bundle; loud-fail instead)
readonly EXIT_NO_SRC=3

_prune_log() { printf 'prune-dist: %s\n' "$1" >&2; }

main() {
  local script_dir monitor_dir src_root dist_root
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  # ATRIUM_MONITOR_DIR is the test seam (mirrors ATRIUM_UPDATE_MONITOR_DIR in
  # scripts/update.sh); unset in production, where the layout resolves from here.
  monitor_dir="${ATRIUM_MONITOR_DIR:-$(dirname -- "${script_dir}")}"
  src_root="${monitor_dir}/public/src"
  dist_root="${monitor_dir}/public/dist"

  # Never built (fresh clone, or a source-only install): nothing to prune.
  if [[ ! -d "${dist_root}" ]]; then
    return 0
  fi
  # A missing source tree is NOT "everything is orphaned" — it is a broken
  # layout, and pruning would wipe the whole outdir. Refuse loudly.
  if [[ ! -d "${src_root}" ]]; then
    _prune_log "REFUSING to prune — source tree absent (${src_root}); ${dist_root} left untouched"
    return "${EXIT_NO_SRC}"
  fi

  # Resolve both roots so the containment assertion below compares real paths.
  src_root="$(cd -- "${src_root}" && pwd)"
  dist_root="$(cd -- "${dist_root}" && pwd)"

  local file rel base removed=0
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
    # A bundle is orphaned only when NEITHER source extension backs it: .jsx is
    # the esbuild entry shape, .js covers a plain source copied through as-is.
    if [[ -e "${src_root}/${base}.jsx" || -e "${src_root}/${base}.js" ]]; then
      continue
    fi
    if rm -f -- "${file}"; then
      _prune_log "removed orphaned bundle (source deleted): ${rel}"
      removed=$((removed + 1))
    else
      _prune_log "WARN: failed to remove orphaned bundle — ${rel}"
    fi
    # A walk failure yields an empty stream, so the prune degrades to a no-op
    # (never a wipe) — but it degrades LOUDLY rather than silently. SC2312 flags
    # any command inside a process substitution on --enable=all; the `|| ...`
    # below IS the handling it asks for, so the note is disabled, not absorbed.
  done < <(find "${dist_root}" -type f -name '*.js' -print0 \
    || _prune_log "WARN: walk of ${dist_root} failed — prune incomplete, orphans may remain")

  # Stay silent on the overwhelmingly common no-op so a normal build is quiet;
  # speak only when the outdir actually changed.
  if ((removed > 0)); then
    _prune_log "pruned ${removed} orphaned bundle(s) from ${dist_root}"
  fi
  return 0
}

main "$@"
