#!/usr/bin/env bash
# shellcheck shell=bash
# File-wide: SC2312 (command substitution / pipeline masks a return value) is an
# --enable=all INFO check flagging the deliberate stream-then-hash pipeline below;
# the sourcing script owns strict mode, where a sha failure still fails the pipe.
# shellcheck disable=SC2312
#
# vendor-digest.sh — the VENDOR-REGION digest: a second content digest over the
# parts of an agent body the VENDOR owns, i.e. everything OUTSIDE the
# `<!-- EDITABLE:BEGIN/END -->` regions and outside the live-only frontmatter
# pins. Sourced by BOTH scripts/generate-manifest.sh (producer: manifest
# `vendor_hashes`) and lib/ga-doctor.sh (consumer: §8 drift reconciliation), so
# the region boundary has ONE definition here — two readings of "where a region
# begins" would replace a loud false warning with a silent wrong one.
#
# Why a second digest at all. `manifest.hashes` is a whole-file digest, so on a
# deployed install every SANCTIONED local evolution reads as content drift: the
# daemon writes learned bullets INSIDE the EDITABLE regions and the operator pins
# `model:` in the frontmatter (live-only by rule, 0 in the repo). §8 warned on
# each one and prescribed a re-release, which cannot clear it — regenerating on
# the source tree is a no-op there, and making live match the whole-file hash
# means overwriting the very pins the rule protects. The vendor digest carries
# the designed-vs-vendor split as DATA instead: local evolution stops reading as
# drift while a single altered character of vendor-owned prose still does.
#
# Boundary SoT MIRRORED here (not re-invented) — autoagent/lib/editable_merge.py:
#   * region pairing  = daemon_cycle._editable_spans: a line CONTAINING
#     `<!-- EDITABLE:BEGIN -->` opens, the next line CONTAINING
#     `<!-- EDITABLE:END -->` closes, content is the lines STRICTLY between (the
#     marker lines themselves are vendor structure and stay IN the digest, so a
#     moved/deleted/injected marker is still drift). An unpaired trailing BEGIN
#     opens no region; a second BEGIN inside an open region folds into it.
#   * frontmatter span = editable_merge._frontmatter_span: a byte-0 `---` line
#     closed by the NEXT line that is exactly `---` (a mid-body horizontal rule
#     is never a fence). NO closing fence -> NO frontmatter, so nothing is
#     dropped anywhere — the two-pass scan below exists for exactly that case.
#   * live-only keys   = editable_merge._LOCAL_ONLY_FRONTMATTER_KEYS ("model").
#     NARROW by design: the identity keys {name, tools, scope} stay vendor-owned
#     and remain inside the digest.
#
# Scope is PATH-based (is_vendor_digest_target): `agents/*.md`, the daemon's own
# evolvable surface (autoagent/daemon-apply.sh AGENTS_DIR + its "target inside
# agents/" sanity). Every other file — including source files that merely MENTION
# the marker strings — has no vendor digest and keeps the whole-file gate
# byte-unchanged, so the carve-out cannot become blindness outside agents/.
#
# HARD CONSTRAINT: bash 3.2 (macOS /bin/bash 3.2.57) + BSD awk. No associative
# arrays, no mapfile.

# The frontmatter keys the LIVE install owns exclusively (mirror of
# editable_merge._LOCAL_ONLY_FRONTMATTER_KEYS). Space-separated, matched as
# `<key>:` line prefixes INSIDE the frontmatter span only.
# Idempotent re-source guard: a second source must not re-fire the readonly.
if [[ -z "${VENDOR_DIGEST_INITED:-}" ]]; then
  readonly VENDOR_LOCAL_ONLY_KEYS="model"
  readonly VENDOR_DIGEST_INITED=1
fi

# Whether manifest-relative path $1 is an agent body carrying a vendor digest.
# `agents/<name>.md` only — a nested path (agents/archive/x.md) is out of the
# daemon's write scope, so it keeps the whole-file gate.
is_vendor_digest_target() {
  [[ "$1" == agents/*.md && "$1" != agents/*/* ]]
}

# Emit file $1's VENDOR-OWNED lines: every line except (a) the content strictly
# inside a PAIRED EDITABLE region and (b) a live-only frontmatter pin. Two passes
# over the file (`awk … f f`, NR==FNR): pass 1 resolves BOTH the closing
# frontmatter fence and the paired region spans, pass 2 filters by line number.
# Both resolutions need lookahead, which is why a single streaming pass cannot do
# it: an unterminated `---` would drop `model:` lines from the whole BODY, and an
# unpaired trailing BEGIN would swallow every line after it — each a blind spot
# rather than a tolerance. Deferring to line numbers mirrors _editable_spans
# (which pairs by index) exactly instead of approximating it with a running flag.
# The file is passed positionally without `--`: BSD awk has no end-of-options
# marker (it opens `--` as a file), and every caller passes a root-anchored path.
#
# TRAILING-NEWLINE FIDELITY. `print` appends ORS to EVERY record, so a body whose
# last line carries no terminator and the same body with one would emit
# byte-identical streams — the ONE byte-class the whole-file hash catches that a
# record-rebuilt stream cannot, and the one axis where this emitter diverged from
# the Python SoT. POSIX awk cannot observe the state (RT is a gawk extension), so
# it is resolved from the newline COUNT: an unterminated last line leaves the file
# one newline SHORT of its record count, and pass 2 then emits that final record
# through printf (no ORS). This is exact rather than approximate — only a file's
# LAST line can lack a terminator, and the filter can never drop it (in-region
# content needs a following END line, a live-only pin a following fence), so
# preserving the final terminator preserves every surviving line's terminator.
# LC_ALL=C counts BYTES, never a locale's decoded characters: an agent body may
# hold invalid UTF-8 and the newline tally must stay byte-exact there too.
emit_vendor_lines() {
  local newlines
  newlines=$(($(LC_ALL=C wc -l <"$1")))
  awk -v keys="${VENDOR_LOCAL_ONLY_KEYS}" -v newlines="${newlines}" '
    BEGIN {
      BEGIN_TAG = "<!-- EDITABLE:BEGIN -->"
      END_TAG   = "<!-- EDITABLE:END -->"
      nkeys = split(keys, key, " ")
    }
    # pass 1 — frontmatter fence (0 = no frontmatter block at all) + the paired
    # region spans. The BEGIN/END branch order mirrors _editable_spans line for
    # line: a line CONTAINING BEGIN opens only while no region is open, and only
    # then does a line CONTAINING END close one. So a second BEGIN inside an open
    # region folds into it, a stray END outside one is inert, and a trailing BEGIN
    # that never closes marks NOTHING in-region — its tail stays vendor-owned.
    NR == FNR {
      last = FNR
      if (FNR == 1 && $0 == "---") { opened = 1 }
      else if (opened && !fence && $0 == "---") { fence = FNR }
      if (!begin && index($0, BEGIN_TAG)) { begin = FNR }
      else if (begin && index($0, END_TAG)) {
        for (i = begin + 1; i < FNR; i++) { inregion[i] = 1 }
        begin = 0
      }
      next
    }
    # pass 2 — filter. Marker lines are never in-region (the span covers strictly
    # between them), so they survive here as the vendor structure they are.
    {
      if (inregion[FNR]) { next }
      if (fence && FNR > 1 && FNR < fence) {
        for (i = 1; i <= nkeys; i++) {
          if (index($0, key[i] ":") == 1) { next }
        }
      }
      # records outnumbering newlines ⇒ the final line arrived unterminated, so it
      # leaves unterminated too.
      if (FNR == last && last > newlines) { printf "%s", $0 }
      else { print }
    }
  ' "$1" "$1"
}

# Echo the lowercase 64-hex vendor digest of file $1. $2.. = the sha256 command
# (`shasum -a 256` / `sha256sum`), resolved by the CALLER so this lib stays tool
# agnostic; only the first whitespace field (the digest) is echoed.
vendor_digest_of() {
  local file="$1"
  shift
  emit_vendor_lines "${file}" | "$@" | awk '{print $1}'
}
