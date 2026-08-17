#!/usr/bin/env bats
# LICENSES-THIRD-PARTY.md drift gate — the license audit states per-license
# bucket counts and an installed-package total whose operands both live inside
# the document. This gate fails the moment those internal figures disagree with
# each other, so an audit that contradicts itself can never ship green.
#
# Scope is deliberately confined to within-document arithmetic: nothing here
# recomputes a figure against the tree, so an unrelated repository change can
# never red this suite.
#
# Run via: bats test/licenses-audit-gate.bats
# Requires: bats (brew install bats-core), awk, grep
#
# Pure read-only: reads the doc's own named lists and bucket table; touches no
# DB, no network, no node_modules.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
DOC="${GA}/LICENSES-THIRD-PARTY.md"

setup() {
  [[ -f "${DOC}" ]] || skip "audit doc not found: ${DOC}"
}

# The per-license bucket counts must sum to the claimed installed-package total
# ("= **359 installed packages**"). A new dependency that shifts a bucket but
# not the total (or vice-versa) trips this.
@test "license bucket counts sum to the claimed installed-package total" {
  local total
  total="$(grep -oE '= \*\*[0-9]+ installed packages\*\*' "${DOC}" \
    | grep -oE '[0-9]+' | head -1)"
  [[ -n "${total}" && "${total}" -gt 0 ]] || {
    echo "installed-package total not found in ${DOC}" >&2
    return 1
  }

  # sum the count column ($3) of the "| License | Count | Verdict |" bucket
  # table. The verdict cell ($4) is the discriminator: only the bucket table
  # carries a permissive/public-domain/elected verdict there — this excludes the
  # Python version table (whose 'compatible' verdict sits in a different column
  # and whose version strings like '3.3.3' would otherwise be summed).
  local sum
  sum="$(awk -F'|' '
    $4 ~ /permissive|public-domain|elected/ {
      n = $3
      gsub(/[^0-9]/, "", n)
      if (n ~ /^[0-9]+$/) s += n
    }
    END { print s + 0 }
  ' "${DOC}")"

  [[ "${sum}" -eq "${total}" ]] || {
    echo "license bucket counts sum to ${sum}, claimed total is ${total}" >&2
    return 1
  }
}

# Each named-list bucket (BSD-3-Clause / BSD-2-Clause / BlueOak-1.0.0) must list
# exactly as many packages as its bucket-table count — a named entry added
# without bumping the count (or vice-versa) is caught here.
@test "named license lists match their bucket counts" {
  _bucket_count() {
    # count for "| <name> | <N> | ..." in the bucket table.
    grep -E "^\| ${1} \| [0-9]+ \|" "${DOC}" | head -1 \
      | awk -F'|' '{ n=$3; gsub(/[^0-9]/,"",n); print n+0 }'
  }
  _named_count() {
    # count backtick-wrapped pkg@version tokens in the "**<name>**:" bullet
    # block (one bullet, may wrap across lines until the next bullet).
    awk -v label="$1" '
      $0 ~ ("^- \\*\\*" label "\\*\\*:") { collecting=1 }
      collecting && /^- \*\*/ && $0 !~ ("^- \\*\\*" label "\\*\\*:") { collecting=0 }
      collecting { line = line $0 " " }
      END {
        n = gsub(/`[^`]+@[0-9][^`]*`/, "&", line)
        print n + 0
      }
    ' "${DOC}"
  }

  local name
  for name in "BSD-3-Clause" "BSD-2-Clause" "BlueOak-1.0.0"; do
    local bc nc
    bc="$(_bucket_count "${name}")"
    nc="$(_named_count "${name}")"
    [[ -n "${bc}" && "${bc}" -gt 0 ]] || {
      echo "${name}: bucket count not found" >&2
      return 1
    }
    [[ "${nc}" -eq "${bc}" ]] || {
      echo "${name}: named list has ${nc} entries, bucket count is ${bc}" >&2
      return 1
    }
  done
}
