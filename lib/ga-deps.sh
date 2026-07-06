# shellcheck shell=bash
# Glass Atrium — bare-Mac dependency-bootstrap DETECTION + command-string layer.
#
# SOURCED ONLY by the entry point (glass-atrium), after ga_init_env. Pure: every
# function is either a read-only DETECT (stdout status verdict, always exit 0) or an
# install-COMMAND-string BUILDER (echoes the command line for the entry point to run
# after its own consent gate). No TUI here (no prompts, run_step, /dev/tty) — consent
# orchestration and interactive chrome live in the entry point.
#
# Detect contract (mirrors ga-core.sh is_never_touch): each ga_detect_* echoes ONE
# status token and ALWAYS exits 0, so the entry point's ERR trap never fires on an
# expected "absent" and no set +e bracketing is needed at the call site. Tokens:
#   present          — installed + usable as-is (SKIP it)
#   absent           — not installed (install candidate)
#   wrong-version    — installed but fails the version gate (e.g. node major != 24)
#   present-but-down — installed but a required runtime is not live (e.g. pg server)
#
# FAIL-SAFE-SKIP: on UNCERTAIN detection, return 'present' so the entry point skips it
# (never auto-install over an uncertain-but-likely-present dep). Non-present verdicts
# fire only on a POSITIVE absence/mismatch signal.
#
# HARD CONSTRAINT: bash 3.2 (macOS /bin/bash 3.2.57). No associative arrays, mapfile,
# fractional read -t, or ${var^^}. BSD stat/date only.
#
# SC2312 is disabled file-wide by design (mirrors the entry point + ga-core.sh): the
# ga_detect_*/ga_*_present helpers always exit 0 by contract, so consuming them as
# `[[ "$(ga_detect_x)" == "absent" ]]` masks the (always-0) return on purpose.
# shellcheck disable=SC2312

# PG_SOCKET — the peer-auth Unix-socket dir, single SoT in ga-core.sh (the engine's
# setup_database probes the same value, so detect + setup never diverge). Always set at
# call time (sourced after ga_init_env); the /tmp default only matters when this file is
# sourced standalone (keeps it independently sourceable + linter-clean).
: "${PG_SOCKET:=/tmp}"

# === [1] generic binary / version primitives ==============================

# ga_major_version — echo the major component of the first integer in a version string
# on stdin (e.g. "v24.3.1" -> 24, "psql (PostgreSQL) 14.11" -> 14), empty when none.
# Feeds the version-gated detects (node major == 24, postgres major >= 14 floor).
ga_major_version() {
  local raw major
  raw="$(cat)"
  # first numeric token anywhere in the line
  major="$(printf '%s' "${raw}" | sed -n 's/[^0-9]*\([0-9][0-9]*\).*/\1/p' | head -n1)"
  printf '%s' "${major}"
}

# ga_join_lines — read a newline-separated list on stdin, echo it space-joined (blanks
# skipped, no trailing space). The single bash-3.2-safe join idiom (no mapfile/arrays)
# shared by every missing-set command builder, so the semantics live in one place.
ga_join_lines() {
  local line joined=""
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    joined="${joined:+${joined} }${line}"
  done
  printf '%s' "${joined}"
}

# === [2] Xcode Command Line Tools (GUIDE-USER) ============================

# ga_detect_xcode_clt — 'present' when the active developer dir is set + exists.
# FAIL-SAFE-SKIP: emit 'absent' ONLY on the clear not-installed signal (xcode-select -p
# exits 2 with the "unable to get active developer directory" / "not found" marker, OR
# the resolved path is missing); any other/ambiguous failure → 'present' so the installer
# never auto-triggers over a likely-present toolchain. No version gate (CLT is binary).
ga_detect_xcode_clt() {
  local devdir status stderr
  # capture stderr (not-installed marker) separately from stdout (the path) + status.
  stderr="$(xcode-select -p 2>&1 1>/dev/null)" || true
  devdir="$(xcode-select -p 2>/dev/null)" && status=0 || status=$?
  if [[ "${status}" -eq 0 && -n "${devdir}" && -d "${devdir}" ]]; then
    # real, existing developer directory — definitively present.
    printf 'present\n'
  elif [[ "${devdir}" != "" && ! -d "${devdir}" ]]; then
    # path reported but missing on disk — stale/absent CLT.
    printf 'absent\n'
  elif [[ "${stderr}" == *"unable to get active developer directory"* ||
    "${stderr}" == *"not found"* || "${status}" -eq 2 ]]; then
    # canonical bare-Mac not-installed signal (error 2 + the marker line).
    printf 'absent\n'
  else
    # ambiguous → present (fail-safe-skip).
    printf 'present\n'
  fi
}

# ga_cmd_xcode_clt — opens the macOS CLT install dialog. GUIDE-USER dep: it starts a
# GUI installer the user clicks through, so the entry point prints this then polls
# ga_detect_xcode_clt until 'present'.
ga_cmd_xcode_clt() {
  printf 'xcode-select --install\n'
}

# === [3] Homebrew (AUTO-WITH-CONSENT, dual-prefix probe) ==================

# ga_brew_prefix — echo the active Homebrew prefix, probing both /opt/homebrew (Apple
# Silicon) and /usr/local (Intel). Prefers a brew on PATH (its --prefix is authoritative),
# then falls back to the two well-known prefixes via bin/brew; empty when none. Separate
# from the detect so the entry point can `eval "$(brew shellenv)"` after a fresh install.
ga_brew_prefix() {
  local p
  if command -v brew >/dev/null 2>&1; then
    p="$(brew --prefix 2>/dev/null || true)"
    if [[ -n "${p}" && -x "${p}/bin/brew" ]]; then
      printf '%s' "${p}"
      return 0
    fi
  fi
  for p in /opt/homebrew /usr/local; do
    if [[ -x "${p}/bin/brew" ]]; then
      printf '%s' "${p}"
      return 0
    fi
  done
  printf ''
}

# ga_detect_homebrew — 'present' when a brew binary is discoverable (PATH or either
# prefix), else 'absent'. FAIL-SAFE-SKIP: any discoverable brew counts as present.
ga_detect_homebrew() {
  local prefix
  prefix="$(ga_brew_prefix)"
  if [[ -n "${prefix}" ]]; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# ga_homebrew_install — install Homebrew IN-PROCESS via the official one-liner. The
# $(curl ...) command substitution is expanded HERE, in this function's own shell, so the
# downloaded installer script actually RUNS. Emitted as the single function token
# ga_homebrew_install by ga_cmd_homebrew_install below (same in-process pattern as
# ga_claude_install / ga_pg_ensure_role): a $(curl ...) substitution CANNOT survive the
# entry point's word-split argv runner — preflight_run_cmd word-splits the command string
# WITHOUT eval and execs "$@", so an emitted `/bin/bash -c "$(curl …)"` STRING splits into
# a broken argv and the substitution never expands. Housing the substitution in a real
# function that run_step invokes in-process is the only word-split-safe expression of it.
# The installer prompts for sudo + (interactively) a RETURN pause: the grouped consent
# gate fronts it, NONINTERACTIVE=1 (exported by the consented preflight block) drops the
# RETURN pause, and the user clears the script's own LIVE sudo prompt (this step is kept
# OFF the framed install-capture path so that prompt stays visible).
# SECURITY: curl|bash from the official Homebrew install URL is the vendor-documented
# install path (HTTPS, -f fails on 4xx/5xx; no secrets read or echoed).
ga_homebrew_install() {
  # real execution: the $(curl ...) is expanded in THIS shell, not emitted as text.
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
}

# ga_cmd_homebrew_install — emit the single function token ga_homebrew_install (a one-word
# builder token the entry point runs in-process via run_step, exactly like
# ga_cmd_claude_cli_install -> ga_claude_install). The actual work — a $(curl ...)
# substitution the word-split argv runner cannot express — lives in ga_homebrew_install
# above; the consent/summary print substitutes a human-readable label, never this token.
ga_cmd_homebrew_install() {
  printf 'ga_homebrew_install\n'
}

# ga_cmd_brew_shellenv — the eval line that puts a freshly-installed brew on PATH for the
# rest of the bootstrap (Apple Silicon installs to /opt/homebrew, NOT on a stock PATH).
# The entry point runs `eval "$(...)"` after install.
ga_cmd_brew_shellenv() {
  local prefix
  prefix="$(ga_brew_prefix)"
  # default to the Apple-Silicon prefix when none discovered yet (bare post-install hint).
  [[ -z "${prefix}" ]] && prefix="/opt/homebrew"
  printf '%s/bin/brew shellenv\n' "${prefix}"
}

# === [4] brew formula detection + batch builder ==========================

# ga_brew_formula_present — 'yes' if a brew formula is installed (brew list --versions is
# the cheap idempotent probe), 'no' when brew itself is absent (caller then treats the
# formula as a brew-batch candidate once brew exists).
ga_brew_formula_present() {
  local formula="$1"
  if ! command -v brew >/dev/null 2>&1; then
    printf 'no\n'
    return 0
  fi
  if brew list --versions "${formula}" >/dev/null 2>&1; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

# GA_PG14_EOL_WARNED — module-global one-shot guard so a preflight probing postgres
# several times shows the PG14 EOL note at most once. Persists reliably because the
# advisory fires from a DIRECT main-shell call (ga_warn_postgres_version), NOT from the
# always-subshelled ga_detect_postgres where a $(...) copy could never dedupe.
GA_PG14_EOL_WARNED=""

# ga_warn_pg14_eol — emit the PostgreSQL 14 EOL advisory ONCE to STDERR. PG14 stays a
# PRESENT dep (no block/reinstall/new daemon); a pure note → stderr only, never the
# stdout status token (the detect's single-token contract).
ga_warn_pg14_eol() {
  [[ -n "${GA_PG14_EOL_WARNED}" ]] && return 0
  GA_PG14_EOL_WARNED=1
  printf 'NOTE: PostgreSQL 14 reaches end-of-life 2026-11-12 — migrate to PostgreSQL 15+ (pg_dumpall | psql, or pg_upgrade) before then.\n' >&2
}

# GA_PG_TOO_OLD_WARNED — module-global one-shot guard for the too-old-PG upgrade GUIDE,
# same persistence rationale as GA_PG14_EOL_WARNED (fired from the DIRECT main-shell
# ga_warn_postgres_version, not the subshelled ga_detect_postgres).
GA_PG_TOO_OLD_WARNED=""

# ga_warn_pg_too_old — emit the unsupported (major < 14) PostgreSQL UPGRADE GUIDE once to
# STDERR. The major<14 'wrong-version' verdict is GUIDE-only: postgres auto-install is
# absent-only, so a too-old PG is never auto-replaced — GA will NOT stack a second
# postgresql@17 daemon (port 5432 collision); the user upgrades the existing cluster
# first. Pure note → STDERR only, never the stdout status token. No missing-set add, no block.
ga_warn_pg_too_old() {
  [[ -n "${GA_PG_TOO_OLD_WARNED}" ]] && return 0
  GA_PG_TOO_OLD_WARNED=1
  printf 'GUIDE: PostgreSQL <14 detected (unsupported) — upgrade to 17 before continuing.\n' >&2
  printf '       GA will not auto-install a second daemon over it (port 5432 collision);\n' >&2
  printf '       migrate the existing cluster first (pg_dumpall | psql, or pg_upgrade), then re-run.\n' >&2
}

# ga_warn_postgres_version — emit the ONE-SHOT PostgreSQL version advisory for the
# installed psql, dispatching on numeric major: < 14 → too-old UPGRADE guide, == 14 → EOL
# note, >= 15 → nothing. MUST be called DIRECTLY in a main-shell context
# (preflight_build_summary), never via $(...) — the ga_warn_* once-guards are module
# globals a subshell call could not persist across the several detects one preflight runs.
# STDERR-only (the two leaf warns own the output); the verdict token stays ga_detect_postgres'.
ga_warn_postgres_version() {
  command -v psql >/dev/null 2>&1 || return 0
  local major
  major="$(psql --version 2>/dev/null | ga_major_version)"
  if [[ -z "${major}" ]]; then
    return 0
  fi
  # NUMERIC compare (octal-safe on the guaranteed-digit major), mirroring the floor in
  # ga_detect_postgres so the dispatch boundary stays a single SoT.
  if [[ "${major}" -lt 14 ]]; then
    ga_warn_pg_too_old
  elif [[ "${major}" -eq 14 ]]; then
    ga_warn_pg14_eol
  fi
  return 0
}

# ga_detect_postgres — PostgreSQL presence verdict with a NUMERIC major FLOOR (>= 14):
#   absent           — no psql binary
#   wrong-version    — psql present but major < 14 (truly-old → GUIDE-only, never auto-reinstalled)
#   present-but-down — psql (>= 14) present but the server is not answering
#   present          — psql (>= 14) present AND the live-server probe passes
# PURE verdict (stdout-token only, NO warning side-effect): the < 14 upgrade guide + the
# == 14 EOL note fire ONCE from the main-shell layer (ga_warn_postgres_version), because
# this detect is always $(...)-invoked where an in-detect once-guard could not persist.
# Probe order: binary -> major floor -> live server on ${PG_SOCKET} (the engine's
# setup_database probes the same SoT, so detect + setup agree).
ga_detect_postgres() {
  if ! command -v psql >/dev/null 2>&1; then
    printf 'absent\n'
    return 0
  fi
  local major
  major="$(psql --version 2>/dev/null | ga_major_version)"
  if [[ -z "${major}" ]]; then
    # unparseable version — FAIL-SAFE-SKIP: assume present rather than reinstall over a
    # working psql we just could not version-string.
    printf 'present\n'
    return 0
  fi
  if [[ "${major}" -lt 14 ]]; then
    # only truly-old majors (< 14) fail the gate, and the verdict is GUIDE-only (postgres
    # add is absent-only) — the user upgrades the existing cluster, GA never stacks a
    # second daemon. The upgrade GUIDE is emitted from the main-shell layer, not here.
    printf 'wrong-version\n'
    return 0
  fi
  # major >= 14 (incl. 14) is PRESENT — no reinstall/new daemon (a second pg collides on
  # port 5432). PG14's one-time EOL advisory fires from the main-shell layer, not here.
  # Fall through to the live-server probe.
  if ! psql -h "${PG_SOCKET}" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    printf 'present-but-down\n'
    return 0
  fi
  printf 'present\n'
}

# ga_detect_postgres_role — superuser peer-auth ROLE verdict, a SEPARATE probe from the
# server one (a live server can still lack the OS-user superuser role the monitor's
# createdb path needs):
#   present          — a superuser role named `id -un` exists
#   absent           — server live but the OS-user superuser role is missing
#   present-but-down — server not answering (cannot evaluate the role yet)
# Gated on a live server; reads catalog membership only, never credentials.
ga_detect_postgres_role() {
  if ! command -v psql >/dev/null 2>&1; then
    printf 'present-but-down\n'
    return 0
  fi
  local osuser exists
  osuser="$(id -un)"
  # rolsuper = the superuser bit; rolname must equal the OS user for peer auth.
  # SECURITY: bind the name via a psql VARIABLE (-v) + the :'rolename' quoted-substitution
  # form (safely single-quotes the value, so an apostrophe in the name never breaks out of
  # the SQL literal — parameterized binding, never concatenation; core-security.md).
  # Fed via STDIN (heredoc), NOT -c: psql does :'var' substitution only for SQL from
  # stdin/-f. A -c string is sent verbatim → literal ':' → syntax error → swallowed → a
  # false 'absent' for an existing role. Stdin keeps the parameterized binding executing.
  exists="$(
    psql -h "${PG_SOCKET}" -d postgres -v rolename="${osuser}" -tA 2>/dev/null <<'SQL' || true
SELECT 1 FROM pg_roles WHERE rolname=:'rolename' AND rolsuper
SQL
  )"
  if [[ -z "${exists}" ]]; then
    # distinguish "server down" from "role absent" via a trivial re-probe.
    if psql -h "${PG_SOCKET}" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      printf 'absent\n'
    else
      printf 'present-but-down\n'
    fi
    return 0
  fi
  printf 'present\n'
}

# ga_detect_node — node@24 verdict (MAJOR == 24 gate; engines >=24 <25):
#   absent        — no node binary
#   wrong-version — node present but major != 24 (node 25 FAILS the gate, never silently
#                   accepted — the entry point offers node@24)
#   present       — node major == 24
ga_detect_node() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'absent\n'
    return 0
  fi
  local major
  major="$(node --version 2>/dev/null | ga_major_version)"
  if [[ -z "${major}" ]]; then
    # unparseable version — FAIL-SAFE-SKIP rather than reinstall over a working node.
    printf 'present\n'
    return 0
  fi
  if [[ "${major}" != "24" ]]; then
    printf 'wrong-version\n'
    return 0
  fi
  printf 'present\n'
}

# ga_detect_cli_tool — generic single-CLI presence verdict ('present'/'absent',
# exit 0). $1 = command name. The single binary-presence probe body; every other
# no-version-gate detect (bun, claude CLI) is a named wrapper over THIS, so the
# present/absent vocabulary + probe technique live in exactly one place.
ga_detect_cli_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# ga_detect_bun — 'present'/'absent' bun-binary probe (greppable wrapper over
# ga_detect_cli_tool). No version gate (bun is install-or-not for this harness).
ga_detect_bun() {
  ga_detect_cli_tool bun
}

# ga_detect_sqlite_fts5 — sqlite3 CAPABILITY verdict, gated on the FTS5 extension (NOT
# bare binary presence): the wiki depends on sqlite3 + FTS5 full-text search, and a
# stock-macOS sqlite3 can ship WITHOUT the FTS5 module compiled in. Verdict:
#   absent        — no sqlite3 binary at all
#   wrong-version — sqlite3 present but the FTS5 module is not compiled in
#   present       — sqlite3 present AND FTS5 is available
# The probe is a CHEAP, read-only, in-memory capability test: create a throwaway FTS5
# virtual table in a `:memory:` database (no file, no disk mutation, no server). It
# exits 0 only when FTS5 is compiled in. Both non-present verdicts route the brew
# `sqlite` formula (built WITH FTS5) into the missing-set; a system sqlite3 that already
# has FTS5 is left untouched (no needless brew install over a working capability).
ga_detect_sqlite_fts5() {
  if ! command -v sqlite3 >/dev/null 2>&1; then
    printf 'absent\n'
    return 0
  fi
  # in-memory FTS5 probe — no file, no mutation; exit 0 only when FTS5 is compiled in.
  if sqlite3 :memory: 'CREATE VIRTUAL TABLE t USING fts5(x)' >/dev/null 2>&1; then
    printf 'present\n'
    return 0
  fi
  # sqlite3 exists but lacks the FTS5 module — the wiki needs it, so the FTS5-enabled
  # brew formula is the fix. GUIDE the capability failure via the same missing-set path
  # a version gate uses (add on wrong-version), never a silent 'present' that would skip.
  printf 'wrong-version\n'
}

# GA_BREW_CLI_TOOLS — the CLI-tools set the brew batch may install. Each entry maps
# a probe COMMAND to its brew FORMULA via the "cmd:formula" form (most are 1:1; the
# split lets a future cmd!=formula case stay declarative). bash 3.2: plain indexed
# array (NO associative array). postgresql@17 / node@24 / bun are version-gated and
# sqlite is FTS5-CAPABILITY-gated (ga_detect_sqlite_fts5) above — all handled
# separately; this list is the genuinely-missing bare-presence utility set.
GA_BREW_CLI_TOOLS=(
  "tmux:tmux"
  "jq:jq"
  "git:git"
  "curl:curl"
  "lsof:lsof"
  "rsync:rsync"
)

# ga_brew_missing_set — echo (newline-separated) the brew FORMULA names that are
# genuinely missing, scanning the version-gated trio + the CLI-tools set. This is
# the EXACT missing-set the single grouped-consent brew batch installs. FAIL-SAFE:
# a tool already present (command -v) is NEVER added, so the batch only ever adds
# absent formulae. A version-gated dep (postgres/node) is added on absent OR
# wrong-version (the gate failed → reinstall the pinned formula).
ga_brew_missing_set() {
  local missing="" entry cmd formula verdict

  # postgresql@17 — fresh-install pin, added to the missing-set ONLY when postgres is
  # truly ABSENT. ABSENT-ONLY (not absent||wrong-version): a present-but-old (major <
  # 14 → 'wrong-version') or present-but-down PG must NOT auto-get a second @17 daemon
  # — that collides on port 5432. Those cases route to the GUIDE path (later group),
  # not this auto-install set. Contrast node@24 below, which keeps absent||wrong-version
  # (keg-only node is parallel-installable; a postgres daemon is not).
  verdict="$(ga_detect_postgres)"
  if [[ "${verdict}" == "absent" ]]; then
    missing="${missing}postgresql@17"$'\n'
  fi

  # node@24 — add on absent OR wrong-version (a present node 25 fails the major gate).
  verdict="$(ga_detect_node)"
  if [[ "${verdict}" == "absent" || "${verdict}" == "wrong-version" ]]; then
    missing="${missing}node@24"$'\n'
  fi

  # bun — add when absent.
  if [[ "$(ga_detect_bun)" == "absent" ]]; then
    missing="${missing}bun"$'\n'
  fi

  # sqlite — FTS5-CAPABILITY gate (NOT bare presence): add the brew formula (built WITH
  # FTS5) on absent OR wrong-version (sqlite3 present but no FTS5 module). A system
  # sqlite3 that already HAS FTS5 is 'present' and NEVER added — do not silently force
  # brew sqlite over a working capability. The wiki requires sqlite3 + FTS5.
  verdict="$(ga_detect_sqlite_fts5)"
  if [[ "${verdict}" == "absent" || "${verdict}" == "wrong-version" ]]; then
    missing="${missing}sqlite"$'\n'
  fi

  # CLI-tools set — add each genuinely-missing utility by its brew formula name.
  for entry in "${GA_BREW_CLI_TOOLS[@]}"; do
    cmd="${entry%%:*}"
    formula="${entry##*:}"
    if [[ "$(ga_detect_cli_tool "${cmd}")" == "absent" ]]; then
      missing="${missing}${formula}"$'\n'
    fi
  done

  # emit trimmed (strip a trailing newline so the caller gets a clean list)
  printf '%s' "${missing}"
}

# ga_cmd_brew_batch — the single `brew install` line for the missing-set, or empty
# when nothing is missing (the entry point then skips the brew step entirely). The
# formulae are space-joined onto one install invocation = one grouped consent.
ga_cmd_brew_batch() {
  local set_list joined
  set_list="$(ga_brew_missing_set)"
  if [[ -z "${set_list}" ]]; then
    printf ''
    return 0
  fi
  # join the newline set into a space-separated formula list (shared join idiom).
  joined="$(
    ga_join_lines <<EOF
${set_list}
EOF
  )"
  [[ -z "${joined}" ]] && {
    printf ''
    return 0
  }
  printf 'brew install %s\n' "${joined}"
}

# === [5] PostgreSQL service + peer-auth role command strings ==============

# ga_pg_installed_major — resolve the installed PostgreSQL major at RUNTIME so the
# service-start builder names the actual formula (PG14 present-but-down → 14, a fresh
# postgresql@17 → 17) instead of a hardcoded pin. Order mirrors ga_detect_postgres'
# own probe: the psql client major first (authoritative for a present-but-down server
# the detect already version-gated), then the HIGHEST brew-installed postgresql@N
# formula (covers a freshly-installed keg-only @N whose psql is not yet on PATH). Empty
# only when neither resolves (the caller then defaults to the fresh-install pin).
ga_pg_installed_major() {
  local major brew_major
  if command -v psql >/dev/null 2>&1; then
    major="$(psql --version 2>/dev/null | ga_major_version)"
    if [[ -n "${major}" ]]; then
      printf '%s' "${major}"
      return 0
    fi
  fi
  if command -v brew >/dev/null 2>&1; then
    # highest installed postgresql@N major (newest keg wins when several coexist).
    brew_major="$(brew list --versions 2>/dev/null | sed -n 's/^postgresql@\([0-9][0-9]*\).*/\1/p' | sort -rn | head -n1 || true)"
    printf '%s' "${brew_major}"
    return 0
  fi
  printf ''
}

# ga_cmd_pg_service_start — start (idempotent) the installed postgresql@N brew service,
# N resolved at runtime (ga_pg_installed_major) — never a hardcoded @14 — so a
# present-but-down PG14 emits @14 and a freshly-installed @17 emits @17. `brew services
# start` is a no-op when already running, so it is safe to emit on present-but-down.
ga_cmd_pg_service_start() {
  local major
  major="$(ga_pg_installed_major)"
  # default to the fresh-install pin (B1) when nothing resolves — the post-consent
  # install just added postgresql@17 but its keg-only psql is not yet on PATH.
  [[ -z "${major}" ]] && major="17"
  printf 'brew services start postgresql@%s\n' "${major}"
}

# ga_pg_wait_ready — BOUNDED in-process poll for a live PostgreSQL server on the peer-auth
# socket, run AFTER an attempted service start (a purely-'present' cluster needs no wait).
# `brew services start` returns BEFORE the postmaster finishes accepting connections, so the
# downstream role detect + the engine's setup_database would race a not-yet-ready server and
# spuriously read 'present-but-down' / fail their first connect. This polls until the server
# answers or a HARD counter ceiling (~15s) elapses, returning non-zero on timeout. The ceiling
# is MANDATORY — an unbounded until-loop would itself be a NEW infinite-hang path (the very
# class of bug the preflight is being hardened against). pg_isready is the purpose-built cheap
# probe; a psql SELECT 1 on ${PG_SOCKET} is the authoritative fallback for a minimal libpq that
# ships without the pg_isready helper (same socket + verdict boundary as ga_detect_postgres, so
# readiness here == the detect's 'present' boundary). Same in-process pattern as ga_pg_ensure_role
# (never an emitted command string). Bash 3.2 clean (integer counter, no fractional read -t).
ga_pg_wait_ready() {
  local waited=0
  local ceiling=15
  while [[ "${waited}" -lt "${ceiling}" ]]; do
    if command -v pg_isready >/dev/null 2>&1; then
      if pg_isready -h "${PG_SOCKET}" >/dev/null 2>&1; then
        return 0
      fi
    elif psql -h "${PG_SOCKET}" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ga_pg_ensure_role — IDEMPOTENT create of the OS-user superuser peer-auth role.
# createuser exits 1 on an already-existing role (no --if-not-exists flag), which
# would block the install; this guard is a clean no-op when the role exists.
# Mechanism: a stdin-fed query interpolates :'rolename' (the -c path does NOT — see
# ga_detect_postgres_role), then \gexec runs the generated CREATE ROLE only when the
# SELECT yields a row, i.e. only when the role is ABSENT. format('%I', …) server-side
# quote-idents the name (injection-safe; the role name = `id -un` so peer auth on the
# Unix socket maps the OS user in). ON_ERROR_STOP=1 makes a genuine psql/SQL error a
# real non-zero exit (loud-fail — no swallowed failure).
ga_pg_ensure_role() {
  local osuser
  osuser="$(id -un)"
  # -h ${PG_SOCKET}: the same peer-auth socket dir the detect probes (single SoT).
  psql -h "${PG_SOCKET}" -d postgres -v ON_ERROR_STOP=1 -v rolename="${osuser}" -q <<'SQL'
SELECT format('CREATE ROLE %I LOGIN SUPERUSER', :'rolename')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'rolename')
\gexec
SQL
}

# ga_cmd_pg_create_role — emit the idempotent ensure-role step as a single bare token
# (the function name). preflight_run_cmd word-splits the command string into argv and
# run_step invokes "$@", so a one-word function name is called directly in-process —
# keeping the single-builder pattern while the actual work (an idempotent stdin-fed
# psql, which cannot be a word-split one-line argv) lives in ga_pg_ensure_role above.
ga_cmd_pg_create_role() {
  printf 'ga_pg_ensure_role\n'
}

# === [6] claude CLI binary (AUTO-WITH-CONSENT, npm -g) ====================

# ga_detect_claude_cli — 'present'/'absent' claude-binary probe. 'present' when claude
# is on PATH (npm-global install) OR at the native-installer location
# (~/.local/bin/claude), which a bare ga_detect_cli_tool PATH probe alone misses. No
# version gate; single-token stdout + exit-0 contract preserved.
ga_detect_claude_cli() {
  if command -v claude >/dev/null 2>&1 || [[ -x "${HOME}/.local/bin/claude" ]]; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# ga_claude_install — install the claude CLI in-process: PRIMARY the official native
# installer (curl | sh, which drops the binary at ~/.local/bin/claude), FALLBACK the
# global npm package when the native installer fails. Runs IN-PROCESS (emitted as a
# single function token by ga_cmd_claude_cli_install, exactly like ga_pg_ensure_role):
# a `curl | sh` pipe CANNOT survive the entry point's word-split argv command runner,
# so the pipe lives here as a real shell pipeline. The native installer is the official
# method (https://claude.ai/install.sh); `npm i -g` is the documented fallback. Runs
# under the entry point's run_step (set +e there), so a failed PRIMARY is captured, not
# a set -e abort. SECURITY: curl|sh from the official Anthropic install URL is the
# vendor-documented install path (no secrets read/echoed; HTTPS, -f fails on 4xx/5xx).
ga_claude_install() {
  # PRIMARY — official native installer. A real pipeline (not a word-split argv), so it
  # MUST run inside this function, never as an emitted command string. pipefail makes a
  # curl failure (empty stdin to sh) surface as a non-zero pipe status → fallback fires.
  if curl -fsSL https://claude.ai/install.sh | sh; then
    return 0
  fi
  # FALLBACK — global npm package (node@24's npm is on PATH by this point in preflight).
  npm i -g @anthropic-ai/claude-code
}

# ga_cmd_claude_cli_install — emit the single function token ga_claude_install (a one-
# word builder token the entry point runs in-process via run_step, exactly like
# ga_cmd_pg_create_role -> ga_pg_ensure_role). The actual work (native-installer-first,
# npm fallback, a real curl|sh pipe) lives in ga_claude_install above, because a curl|sh
# pipe cannot be expressed as the entry point's word-split single-line argv command.
ga_cmd_claude_cli_install() {
  printf 'ga_claude_install\n'
}

# === [7] claude AUTH (GUIDE-USER HARD GATE) ===============================

# ga_detect_claude_auth — authentication verdict via TWO independent signals,
# NEITHER of which reads the credentials file contents (a NEVER-TOUCH path):
#   1. ~/.claude/.credentials.json PRESENCE only (test -e — never cat/read/parse).
#   2. a classified non-interactive `claude` probe (the binary self-reports auth
#      state with a fast non-interactive subcommand; exit 0 = authenticated).
# Verdict:
#   present — credentials file exists OR the probe classifies as authenticated
#   absent  — no credentials file AND the probe classifies as unauthenticated
#   present-but-down — the claude binary itself is missing (cannot evaluate auth)
# SECURITY: the credentials file is read-presence-only via test -e; its bytes are
# NEVER opened. The probe is the corroborating signal, not a contents read.
ga_detect_claude_auth() {
  if ! command -v claude >/dev/null 2>&1; then
    printf 'present-but-down\n'
    return 0
  fi
  # PRESENCE-ONLY probe of the NEVER-TOUCH credentials path — test -e never reads
  # the file's contents.
  local creds="${HOME}/.claude/.credentials.json"
  if [[ -e "${creds}" ]]; then
    printf 'present\n'
    return 0
  fi
  # corroborating non-interactive probe: a fast, non-prompting subcommand that
  # exits 0 only when authenticated. Output is DISCARDED (classification by exit
  # code only) so no credential text enters context — the status JSON carries
  # account/subscription fields, so exit-code-only classification keeps it out.
  # 'claude auth status' exits 0 for a Keychain/GUI-authenticated session in
  # ~0.2s (non-interactive, no credentials-file side-effect), non-zero when truly
  # unauthenticated. stdin is pinned to /dev/null (this runs inside a command
  # substitution) so it can never block on a prompt.
  if claude auth status </dev/null >/dev/null 2>&1; then
    printf 'present\n'
    return 0
  fi
  printf 'absent\n'
}

# ga_cmd_claude_auth_guide — the user-facing login instruction (a GUIDE string, not
# an auto-runnable mutation). Printed at the HARD GATE; the entry point confirms
# auth is established (re-running ga_detect_claude_auth) before proceeding.
ga_cmd_claude_auth_guide() {
  # OAuth-only Atrium — the single login instruction (no token-string alternative).
  printf 'claude login\n'
}

# === [8] fakechat plugin (AUTO-NO-CONSENT, post-auth) =====================

# ga_marketplace_present — 'yes' when the official plugin marketplace is registered.
# An unauthenticated / marketplace-absent claude cannot resolve the plugin, so the
# entry point runs the marketplace-add FIRST when this returns 'no'. Output is
# classification-only (the plugin list is matched for the marketplace slug).
ga_marketplace_present() {
  if ! command -v claude >/dev/null 2>&1; then
    printf 'no\n'
    return 0
  fi
  if claude plugin marketplace list 2>/dev/null | grep -q 'claude-plugins-official'; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

# ga_detect_fakechat — 'present' when the fakechat plugin is installed, else 'absent'.
# present-but-down when claude itself is missing (cannot evaluate the plugin set).
ga_detect_fakechat() {
  if ! command -v claude >/dev/null 2>&1; then
    printf 'present-but-down\n'
    return 0
  fi
  if claude plugin list 2>/dev/null | grep -q 'fakechat'; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# ga_marketplace_add — register the official plugin marketplace IN-PROCESS, working around a
# live hang: a COLD `claude plugin marketplace add` (like the plugin install below) can print
# success and register the marketplace WITHOUT the process exiting, so a foreground run_step
# would block forever. We background the add — its stdout/stderr redirected to /dev/null
# (MANDATORY hygiene: the backgrounded claude must not write into run_step's STEP_LOG, where a
# post-kill flush could corrupt the classify read, matching the homebrew/claude token fd
# hygiene) — then POLL ga_marketplace_present: the moment the marketplace registers we kill+reap
# the (possibly stuck) process and return success; a 120s ceiling reaps it and returns failure.
# Emitted as the single function token ga_marketplace_add by ga_cmd_marketplace_add (same
# in-process pattern as ga_claude_install), because the background+poll cannot survive the entry
# point's word-split argv runner. Single-pid kill is adequate (the live repro spawns no surviving
# children). NON-FATAL: the caller treats a non-zero rc as warn-and-continue. Bash 3.2 clean.
ga_marketplace_add() {
  local pid waited=0
  claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 &
  pid=$!
  while [[ "${waited}" -lt 120 ]]; do
    if [[ "$(ga_marketplace_present)" == "yes" ]]; then
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  # timeout — reap the stuck adder and report failure (NON-FATAL to the caller).
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  return 1
}

# ga_cmd_marketplace_add — emit the single function token ga_marketplace_add (a one-word builder
# token the entry point runs in-process via run_step, exactly like ga_cmd_claude_cli_install ->
# ga_claude_install). The actual work — a background+poll+kill hang guard the word-split argv
# runner cannot express — lives in ga_marketplace_add above. Emitted only when
# ga_marketplace_present returned 'no'.
ga_cmd_marketplace_add() {
  printf 'ga_marketplace_add\n'
}

# ga_fakechat_install — install the fakechat plugin IN-PROCESS, working around a live hang
# (confirmed on a cold Mac): `claude plugin install fakechat@claude-plugins-official` prints
# "Successfully installed" and registers the plugin, but the process does NOT exit (an
# already-installed re-run exits fast). A foreground run_step would therefore block forever on a
# fresh install. Same mechanism as ga_marketplace_add: background the install with fds redirected
# to /dev/null (MANDATORY hygiene — keep the backgrounded claude out of run_step's STEP_LOG),
# then POLL ga_detect_fakechat, kill+reap on registration (success) or on the 120s ceiling
# (failure). Emitted as the single function token ga_fakechat_install by ga_cmd_fakechat_install.
# NON-FATAL to the caller. Bash 3.2 clean.
ga_fakechat_install() {
  local pid waited=0
  claude plugin install fakechat@claude-plugins-official >/dev/null 2>&1 &
  pid=$!
  while [[ "${waited}" -lt 120 ]]; do
    if [[ "$(ga_detect_fakechat)" == "present" ]]; then
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  # timeout — reap the stuck installer and report failure (NON-FATAL to the caller).
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  return 1
}

# ga_cmd_fakechat_install — emit the single function token ga_fakechat_install (run in-process by
# run_step). The actual work (background+poll+kill hang guard) lives in ga_fakechat_install above.
# The entry point runs ga_cmd_marketplace_add FIRST when the marketplace is absent.
ga_cmd_fakechat_install() {
  printf 'ga_fakechat_install\n'
}

# === [9] python libraries (AUTO-WITH-CONSENT, PEP-668 aware) ==============

# GA_PYTHON_IMPORTS — the import-NAME : pip-PACKAGE pairs the python libs step needs.
# The import name (what `python3 -c "import X"` uses) often differs from the pip
# package name, so the pair is explicit. psycopg2-binary is paired with the
# `import psycopg2` probe (hooks/_pg-write.py uses psycopg2); psycopg (v3) is paired
# with `import psycopg` (the daemons use v3); PyYAML installs the `yaml` module.
# bash 3.2: plain indexed array (NO associative array).
GA_PYTHON_IMPORTS=(
  "psycopg:psycopg"
  "psycopg2:psycopg2-binary"
  "yaml:PyYAML"
)

# ga_python_import_present — 'yes' when `python3 -c "import <mod>"` succeeds, else
# 'no'. Returns 'no' when python3 itself is absent (the caller surfaces that as a
# guide note; python3 ships on stock macOS via the CLT, not assumed unmanaged).
ga_python_import_present() {
  local mod="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'no\n'
    return 0
  fi
  if python3 -c "import ${mod}" >/dev/null 2>&1; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

# ga_python_missing_set — echo (newline-separated) the pip PACKAGE names whose
# import probe failed. This is the exact set the pip install line targets. A module
# already importable is NEVER reinstalled (FAIL-SAFE-SKIP).
ga_python_missing_set() {
  local missing="" entry mod pkg
  for entry in "${GA_PYTHON_IMPORTS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if [[ "$(ga_python_import_present "${mod}")" == "no" ]]; then
      missing="${missing}${pkg}"$'\n'
    fi
  done
  printf '%s' "${missing}"
}

# ga_detect_python_libs — aggregate verdict for the python libs step:
#   present — every required module imports
#   absent  — at least one module is missing (install candidate)
# present-but-down is N/A (no running service); python3 absence still yields
# 'absent' (its modules cannot import) and the entry point notes python3 is needed.
ga_detect_python_libs() {
  local set_list
  set_list="$(ga_python_missing_set)"
  if [[ -z "${set_list}" ]]; then
    printf 'present\n'
  else
    printf 'absent\n'
  fi
}

# ga_python_packages_joined — internal: space-join the missing pip-package set onto
# one line, or empty when nothing is missing. Shared by the --user + --break-system
# command builders so both target the identical package set.
ga_python_packages_joined() {
  local set_list
  set_list="$(ga_python_missing_set)"
  [[ -z "${set_list}" ]] && {
    printf ''
    return 0
  }
  # space-join the missing pip-package set (shared bash-3.2 join idiom).
  ga_join_lines <<EOF
${set_list}
EOF
}

# ga_cmd_python_libs_user — the PRIMARY pip install line (--user, no system mutation).
# Sources the package set from requirements.txt is the SoT, but the install line
# targets only the genuinely-missing subset so a re-run is a fast no-op. Empty when
# nothing is missing.
ga_cmd_python_libs_user() {
  local pkgs
  pkgs="$(ga_python_packages_joined)"
  [[ -z "${pkgs}" ]] && {
    printf ''
    return 0
  }
  printf 'python3 -m pip install --user %s\n' "${pkgs}"
}

# ga_cmd_python_libs_break_system — the PEP-668 FALLBACK line. Emitted only after
# the --user line failed on an externally-managed-environment (PEP-668) marker AND
# the user consented to the override. Adds --break-system-packages to the same set.
ga_cmd_python_libs_break_system() {
  local pkgs
  pkgs="$(ga_python_packages_joined)"
  [[ -z "${pkgs}" ]] && {
    printf ''
    return 0
  }
  printf 'python3 -m pip install --user --break-system-packages %s\n' "${pkgs}"
}
