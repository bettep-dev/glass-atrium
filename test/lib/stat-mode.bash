#!/usr/bin/env bash
# mode_of — the octal permission bits of a path, portable across GNU coreutils and
# BSD/macOS stat. Shared by every suite that asserts a creation mask.
#
# WHY IT IS SHARED: a `stat -f … || stat -c …` fallback chain between the two SPELLINGS
# is NOT a platform branch, and three copies of that chain went red on Linux together.
# `-f` is a FORMAT flag on BSD but --file-system on GNU, so `stat -f '%Lp' -- /path` on
# GNU prints the STATFS block of /path to stdout and exits non-zero only because '%Lp'
# is not a file; the fallback then appends the GNU mode and the caller compares a
# multi-line block against "700". `stat --version` succeeds on GNU and fails on BSD, so
# it settles the flavour BEFORE either spelling is attempted — the same discriminator
# scripts/test/apply-spine.bats uses for inode_of. lib/ga-env.sh routes stat_perms to the
# same two spellings but decides between them differently, from a `uname -s` memo warmed
# at load; either discriminator is sound, and neither is a fallback chain.
#
# GNU `%a` prepends the setuid/setgid/sticky nibble only when it is non-zero, so a 0700
# directory reads "700" on both platforms; a sticky one reads "1777" on GNU and "777"
# under BSD `%Lp`. Every caller asserts owner-only modes, where the two agree.

mode_of() {
  if stat --version >/dev/null 2>&1; then
    stat -c '%a' -- "$1" # GNU coreutils
  else
    stat -f '%Lp' -- "$1" # BSD / macOS
  fi
}
