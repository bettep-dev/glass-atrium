#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats; GA_BATS_DB_CLIENTS from the loaded helper
# shellcheck disable=SC2030,SC2031  # each @test body is its own subshell, so a PATH change stays in it
# Live-DB seal (test/lib/bats-db-seal.bash): a sealed shell reaches no postgres client behind the
# seal, a sandbox seal reaches only its own socket dir, and every suite that runs a real postgres
# client is sealed — the doctor's DB checks run `psql -h /tmp`, and an ephemeral-cluster suite
# drives psycopg hooks and psql, either of which an unsealed run could send to the live server.
# A suite driving a DB-writing hook runs on a sandbox or on the hermetic baseline's dead PGHOST
# (test/lib/bats-hermetic-env.bash), which a host-less psycopg connection follows. On a sandbox, a
# fire that strips PGHOST runs behind the psycopg recorder, and an eph_assert_isolated follows it.
# Suites that reach only their own scripted client stubs are not members.

setup() {
  load 'lib/bats-db-seal'
  load 'lib/bats-hermetic-env'
}

# A non-comment line runs the doctor: a run_doctor call, or the launcher's doctor subcommand.
drives_doctor() {
  awk '/^[[:space:]]*#/ { next }
    /(^|[^A-Za-z0-9_])run_doctor($|[^A-Za-z0-9_])|["}] doctor($|[^A-Za-z0-9_-])/ { found = 1; exit }
    END { exit !found }' "$1"
}

# A non-comment line loads the ephemeral-cluster helper (hooks/test/lib/ephemeral-pg.bash).
loads_ephemeral_pg() {
  awk '/^[[:space:]]*#/ { next }
    /(^|[[:space:]])(source|load|\.)[[:space:]].*ephemeral-pg/ { found = 1; exit }
    END { exit !found }' "$1"
}

# A non-comment eph_pg_start or `ga_bats_db_seal <sandbox>` call binds the sandbox seal only outside
# every `( … )` / `$( … )` subshell, where its exported PATH would die. Depth rises on a statement
# leaving `(` unclosed and falls only on one opening with `)` — a case pattern never closes a subshell.
# A backslash-continued statement is read as one; heredoc bodies are not shell and are skipped.
binds_ephemeral_seal() {
  awk 'heredoc != "" { if ($0 ~ "^\t*" heredoc "$") heredoc = ""; next }
    /^[[:space:]]*#/ { next }
    stmt != "" { $0 = stmt " " $0 }
    /\\$/ { stmt = substr($0, 1, length($0) - 1); next }
    { stmt = "" }
    depth == 0 && match($0, /(^|[^A-Za-z0-9_])(eph_pg_start|ga_bats_db_seal[[:space:]]+[^[:space:]|;&)])($|[^A-Za-z0-9_])/) \
      && substr($0, 1, RSTART) !~ /\(/ { found = 1; exit }
    { line = $0; net = gsub(/\(/, "", line) - gsub(/\)/, "", line) }
    net > 0 { depth += net }
    net < 0 && /^[[:space:]]*\)/ { depth = (depth + net > 0) ? depth + net : 0 }
    match($0, /(^|[^<])<<-?[[:space:]]*["'"'"'\\]?[A-Za-z_][A-Za-z0-9_]*/) {
      heredoc = substr($0, RSTART, RLENGTH)
      sub(/^[^<]*<<-?[[:space:]]*["'"'"'\\]?/, "", heredoc)
    }
    END { exit !found }' "$1"
}

# Basenames of the hooks whose own non-comment text runs a _pg_ helper or psycopg — derived from the
# tree, so a new DB-writing hook joins the pin with no list edit. Arg: $1=hooks dir.
list_db_hooks() {
  local hook
  for hook in "$1"/*.sh "$1"/*.py; do
    awk '/^[[:space:]]*#/ { next } /_pg[_-][A-Za-z_]+\.py|psycopg/ { found = 1; exit }
      END { exit !found }' "${hook}" && printf '%s\n' "${hook##*/}"
  done
  return 0
}

# A non-comment line names one of the DB-writing hooks listed in $2 as a path or word.
runs_db_hook() {
  awk 'NR == FNR { names[$0] = 1; next }
    /^[[:space:]]*#/ { next }
    { for (name in names) if (index($0, name)) {
        line = $0; at = index(line, name)
        before = substr(line, at - 1, 1); after = substr(line, at + length(name), 1)
        if ((at == 1 || before ~ /[\/"'"'"'[:space:]]/) && after !~ /[A-Za-z0-9_.-]/) { found = 1; exit }
      } }
    END { exit !found }' "$2" "$1"
}

# awk strips(s): s drops or reroutes the inherited dead PGHOST — `env -i` or a bare `env -`, an unset,
# -u or --unset of PGHOST, PGHOST set empty or to the live default (quoted or not), or PGHOSTADDR /
# PGSERVICE set to a value. One declaration for both strip detectors below.
STRIPS_PGHOST_AWK='function strips(s) {
  return s ~ /(^|[^A-Za-z0-9_-])env[[:space:]]+-i?([[:space:]]|$)/ \
    || s ~ /(-u[[:space:]]*|--unset[=[:space:]][[:space:]]*)PGHOST([^A-Za-z0-9_]|$)/ \
    || s ~ /(^|[^A-Za-z0-9_])unset[[:space:]][^#]*PGHOST([^A-Za-z0-9_]|$)/ \
    || s ~ /(^|[^A-Za-z0-9_])PGHOST=(""|'"''"'|["'"'"']?(\/tmp|\/private\/tmp|localhost|127\.)|[[:space:]]|$)/ \
    || s ~ /(^|[^A-Za-z0-9_])PG(HOSTADDR|SERVICE)="?[^"[:space:]]/
}'

# A non-comment line strips the dead PGHOST (STRIPS_PGHOST_AWK).
strips_dead_pghost() {
  awk "${STRIPS_PGHOST_AWK}"'
    /^[[:space:]]*#/ { next }
    strips($0) { found = 1; exit }
    END { exit !found }' "$1"
}

# On a sandbox, a statement stripping PGHOST is guarded only when the psycopg recorder is on its
# PYTHONPATH — named in it, or in a body-local array it expands — and an eph_assert_isolated follows it
# in the same body. A backslash-continued statement is read as one. Status 0 = an unguarded strip.
strips_pghost_unguarded() {
  awk "${STRIPS_PGHOST_AWK}"'
    function records(s) { return s ~ /PYTHONPATH=[^[:space:]]*(EPH_PG_RECORDER_DIR|pg-sandbox-recorder)/ }
    function guarded(s, name) {
      if (records(s)) return 1
      for (name in arrays) if (index(s, "${" name "[@]}")) return 1
      return 0
    }
    /^[[:space:]]*#/ { next }
    /^(@test[[:space:]]|[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{)/ { split("", arrays); array = ""; owed = 0 }
    stmt != "" { $0 = stmt " " $0 }
    /\\$/ { stmt = substr($0, 1, length($0) - 1); next }
    { stmt = "" }
    match($0, /[A-Za-z_][A-Za-z0-9_]*=\(/) { array = substr($0, RSTART, RLENGTH - 2) }
    array != "" && records($0) { arrays[array] = 1 }
    array != "" && /\)/ { array = "" }
    strips($0) { if (!guarded($0)) { found = 1; exit } owed = 1 }
    /(^|[^A-Za-z0-9_])eph_assert_isolated([^A-Za-z0-9_]|$)/ { owed = 0 }
    /^\}/ && owed { found = 1; exit }
    END { exit !(found || owed) }' "$1"
}

# ga_bats_hermetic_env, run over hostile ambient values, leaves PGHOST naming a path that does not
# exist and every libpq routing name unset. Runs in a subshell: the baseline cds and exports.
provides_dead_pghost() {
  (
    export PGHOST=/tmp PGPORT=5432 PGHOSTADDR=127.0.0.1 PGSERVICE=live PGDATABASE=glass_atrium \
      PGPASSFILE=/dev/null
    ga_bats_hermetic_env >/dev/null 2>&1 || exit 1
    [[ "${PGHOST}" == /* && "${PGHOST}" != /tmp && ! -e "${PGHOST}" ]] || exit 1
    local name
    for name in "${GA_BATS_PG_ROUTING_NAMES[@]}"; do
      [[ -z "${!name+set}" ]] || exit 1
    done
  )
}

# The setup() body holds a non-comment ga_bats_db_seal call.
seals_in_setup() {
  awk '/^setup\(\) \{$/ { inside = 1; next }
    inside && /^\}/ { exit }
    inside && /^[[:space:]]*ga_bats_db_seal[[:space:]]*$/ { found = 1 }
    END { exit !found }' "$1"
}

@test "a sealed child shell refuses every postgres client and never reaches one later on PATH" {
  local later="${BATS_TEST_TMPDIR:?}/later-bin" reached="${BATS_TEST_TMPDIR:?}/reached.log" client
  mkdir -p "${later}"
  for client in "${GA_BATS_DB_CLIENTS[@]}"; do
    # shellcheck disable=SC2016  # $0 expands when the stub runs, not here
    printf '#!/bin/sh\necho "$0" >>"%s"\n' "${reached}" >"${later}/${client}"
    chmod +x "${later}/${client}"
  done
  PATH="${later}:${PATH}"

  ga_bats_db_seal

  for client in "${GA_BATS_DB_CLIENTS[@]}"; do
    run bash -c '"$1" -h /tmp -d postgres' _ "${client}"
    [[ "${status}" -eq 2 && "${output}" == *"refused by the bats live-DB seal"* ]] || {
      printf '%s: status %s, output: %s\n' "${client}" "${status}" "${output}"
      return 1
    }
  done
  [[ ! -e "${reached}" ]] || {
    echo "a client behind the seal was reached:"
    cat -- "${reached}"
    return 1
  }
}

@test "the doctor-suite detector counts a doctor run only on a non-comment line" {
  # shellcheck disable=SC2016  # fixture rows hold suite source text, never expanded here
  local rows=(
    'launcher doctor subcommand|  run "${REAL_GA}" doctor|0'
    "run_doctor inside a child shell|  bash -c 'source lib/ga-core.sh; run_doctor'|0"
    'run_doctor named only in a comment|# run_doctor §6 binding check|1'
    'a run_doctor-prefixed helper name only|  run_doctor_sandbox|1'
  )
  local row name body want fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  for row in "${rows[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    printf '%s\n' "${body}" >"${fixture}"
    run drives_doctor "${fixture}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "the seal detector accepts only a non-comment call inside setup" {
  local rows=(
    'called in setup|setup() {\n  ga_bats_db_seal\n}|0'
    'called only in a test body|setup() {\n  true\n}\n@test "x" {\n  ga_bats_db_seal\n}|1'
    'named only in a setup comment|setup() {\n  # ga_bats_db_seal\n}|1'
  )
  local row name body want fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  for row in "${rows[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    printf '%b\n' "${body}" >"${fixture}"
    run seals_in_setup "${fixture}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "a sandbox seal runs the real client only for a call that provably targets its socket dir" {
  local real="${BATS_TEST_TMPDIR:?}/real-bin" sandbox="${BATS_TEST_TMPDIR:?}/sock"
  local reached="${BATS_TEST_TMPDIR:?}/reached.log"
  mkdir -p "${real}" "${sandbox}"
  # shellcheck disable=SC2016  # $* expands when the fake client runs, not here
  printf '#!/bin/sh\necho "$*" >>"%s"\n' "${reached}" >"${real}/psql"
  chmod +x "${real}/psql"
  PATH="${real}:${PATH}"
  ga_bats_db_seal "${sandbox}"

  # name|PGHOST (- = unset)|extra env (- = none)|want status|comma-separated client args
  local rows=(
    "explicit -h to the sandbox|-|-|0|-h,${sandbox},-d,x"
    "--host= to the sandbox|-|-|0|--host=${sandbox},-d,x"
    "attached -h to the sandbox|-|-|0|-h${sandbox},-d,x"
    "PGHOST names the sandbox, no host flag|${sandbox}|-|0|-d,x"
    "URI whose host= query is the sandbox|${sandbox}|-|0|-d,postgresql://u@localhost:1/db?host=${sandbox}"
    "--dbname= URI to the sandbox|${sandbox}|-|0|--dbname=postgresql:///db?host=${sandbox}"
    "attached -d URI to the sandbox|${sandbox}|-|0|-dpostgresql:///db?host=${sandbox}"
    "psql \\copy is not the connect meta-command|${sandbox}|-|0|-c,\\copy t to stdout"
    "no host flag and PGHOST unset: the default socket|-|-|2|-d,x"
    "explicit -h /tmp over a sandbox PGHOST|${sandbox}|-|2|-h,/tmp,-d,x"
    "abbreviated --ho= host option|${sandbox}|-|2|--ho=/tmp,-d,x"
    "abbreviated --hos host option with a separate value|${sandbox}|-|2|--hos,/tmp,-d,x"
    "host flag inside a short-option cluster|${sandbox}|-|2|-qh,/tmp,-d,x"
    "connection string naming /tmp|${sandbox}|-|2|-d,host=/tmp dbname=x"
    "connection-string routing keyword after blanks|${sandbox}|-|2|-d,dbname=x host = /tmp"
    "URI with no host= query|${sandbox}|-|2|-d,postgresql://u@localhost:5432/db"
    "--dbname= URI naming its host in the authority|${sandbox}|-|2|--dbname=postgresql://%2Ftmp/db"
    "attached -d URI to a TCP host|${sandbox}|-|2|-dpostgres://127.0.0.1:5432/x"
    "URI attached to -d inside a short-option cluster|${sandbox}|-|2|-qdpostgres://127.0.0.1:5432/x"
    "URI repeating host= with the last one elsewhere|${sandbox}|-|2|-d,postgresql:///db?host=${sandbox}&host=/tmp"
    "URI naming hostaddr after its sandbox host|${sandbox}|-|2|-d,postgresql:///db?host=${sandbox}&hostaddr=127.0.0.1"
    "URI naming service after its sandbox host|${sandbox}|-|2|-d,postgresql:///db?host=${sandbox}&service=live"
    "sandbox URI over the default socket host|-|-|2|-d,postgresql:///db?host=${sandbox}"
    "sandbox URI in a non-dbname slot over a foreign -h|-|-|2|-h,/tmp,-d,x,-U,postgresql:///x?host=${sandbox}"
    "psql connect meta-command in -c|${sandbox}|-|2|-c,\\connect db - /tmp"
    "PGHOSTADDR routes past the socket host|${sandbox}|PGHOSTADDR=127.0.0.1|2|-d,x"
    "-U takes an attached -h<sandbox> as its user name|-|-|2|-U,-h${sandbox},-d,x"
    "-U takes a bare -h as its user name before a sandbox operand|-|-|2|-U,-h,${sandbox},-d,x"
    "-- ends options before a -h<sandbox> operand|-|-|2|--,-h${sandbox}"
    "POSIXLY_CORRECT stops option parsing at the first operand|-|POSIXLY_CORRECT=1|2|x,-h,${sandbox}"
    "an option the seal does not model for the client|${sandbox}|-|2|--no-such-option,-d,x"
    "a host flag ending a short-option cluster takes the next argument|-|-|0|-qh,${sandbox},-d,x"
    "a cluster ending in a value option takes the next argument as its value|${sandbox}|-|0|-tAqc,select 1"
  )
  local row name pghost extra want argstr
  local -a args env_args
  for row in "${rows[@]}"; do
    IFS='|' read -r name pghost extra want argstr <<<"${row}"
    IFS=',' read -r -a args <<<"${argstr}"
    env_args=(-u PGHOST -u PGHOSTADDR -u PGSERVICE -u POSIXLY_CORRECT)
    [[ "${pghost}" == "-" ]] || env_args+=(PGHOST="${pghost}")
    [[ "${extra}" == "-" ]] || env_args+=("${extra}")
    : >"${reached}"
    run env "${env_args[@]}" psql "${args[@]}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
    if [[ "${want}" -eq 0 ]]; then
      [[ -s "${reached}" ]] || {
        echo "${name}: passed the seal but never reached the real client"
        return 1
      }
    else
      [[ ! -s "${reached}" && "${output}" == *"refused by the bats live-DB seal"* ]] || {
        printf '%s: reached the real client or refused silently, output: %s\n' "${name}" "${output}"
        return 1
      }
    fi
  done
}

@test "the ephemeral-suite detectors count only a non-comment load or eph_pg_start call" {
  # shellcheck disable=SC2016  # fixture rows hold suite source text, never expanded here
  local rows=(
    'helper sourced|loads_ephemeral_pg|source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"|0'
    'helper named only in a comment|loads_ephemeral_pg|# source lib/ephemeral-pg.bash|1'
    'cluster started|binds_ephemeral_seal|  eph_pg_start "${D}" "${S}" "${P}" "${DB}"|0'
    'sandbox seal re-applied after a subshell|binds_ephemeral_seal|  (\n    eph_pg_start a b c d\n  )\n  ga_bats_db_seal "${S}"|0'
    'cluster started only inside a ( ) subshell|binds_ephemeral_seal|  (\n    eph_pg_start a b c d\n  )|1'
    'cluster started inside a one-line subshell|binds_ephemeral_seal|  ( eph_pg_start a b c d )|1'
    'refusing seal with no sandbox dir|binds_ephemeral_seal|  ga_bats_db_seal|1'
    'eph_pg_start named only in a comment|binds_ephemeral_seal|  # eph_pg_start seals the file|1'
    'an eph_pg_start-prefixed helper name only|binds_ephemeral_seal|  eph_pg_start_extra|1'
    'cluster started inside a multi-line command substitution|binds_ephemeral_seal|  out="$(\n    eph_pg_start a b c d\n  )"|1'
    'cluster started inside a subshell opened with a command|binds_ephemeral_seal|  ( cd "${D}" &&\n    eph_pg_start a b c d\n  )|1'
    'a case pattern inside a subshell does not close it|binds_ephemeral_seal|  (\n    case "${x}" in\n      a) true ;;\n    esac\n    eph_pg_start a b c d\n  )|1'
    'cluster started after a balanced command substitution|binds_ephemeral_seal|  d="$(mktemp -d)"\n  eph_pg_start a b c d|0'
    'a command substitution closed on a continued line|binds_ephemeral_seal|  x="$(psql -c \\\n    "select 1")"\n  eph_pg_start a b c d|0'
    "a heredoc body never opens a subshell|binds_ephemeral_seal|  cat <<'EOF' >f.js\nconfig({\nEOF\n  eph_pg_start a b c d|0"
  )
  local row name detector body want fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  for row in "${rows[@]}"; do
    IFS='|' read -r name detector body want <<<"${row}"
    printf '%b\n' "${body}" >"${fixture}"
    run "${detector}" "${fixture}"
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "the hermetic baseline sends a host-less libpq connection to a socket path that never exists" {
  run provides_dead_pghost
  [[ "${status}" -eq 0 ]] || {
    echo "ga_bats_hermetic_env left PGHOST live or a routing name set over hostile ambient values: ${output}"
    return 1
  }
  # this corpus's setup_suite applied the same baseline to the running test
  [[ "${PGHOST:-}" == "${BATS_RUN_TMPDIR:?}/"* && ! -e "${PGHOST}" ]] || {
    echo "the running test did not inherit the dead PGHOST: ${PGHOST:-<unset>}"
    return 1
  }
}

@test "the DB-hook detectors count a named hook, a stripped PGHOST and an unguarded sandbox strip only on a non-comment line" {
  local names="${BATS_TEST_TMPDIR:?}/db-hooks.txt" fixture="${BATS_TEST_TMPDIR:?}/suite.bats"
  printf '%s\n' agent-tracker.sh _pg_dual_write.py >"${names}"
  # shellcheck disable=SC2016  # fixture rows hold suite source text, never expanded here
  local rows=(
    'hook path assigned|runs_db_hook|HOOK_SH="${BATS_TEST_DIRNAME}/../agent-tracker.sh"|0'
    'helper run by name|runs_db_hook|  python3 _pg_dual_write.py <<<"${x}"|0'
    'hook named only in a comment|runs_db_hook|# agent-tracker.sh owns the write contract|1'
    'a longer name sharing the prefix|runs_db_hook|  HOOK="${D}/agent-tracker.sh.bak"|1'
    'env -i drops PGHOST|strips_dead_pghost|  run env -i PATH="${P}" bash "${H}"|0'
    'env -u PGHOST|strips_dead_pghost|  env -u PGHOST -u PGPORT bash "${H}"|0'
    'unset PGHOST|strips_dead_pghost|  unset PGPORT PGHOST|0'
    'PGHOST set to the live default|strips_dead_pghost|  PGHOST=/tmp bash "${H}"|0'
    'PGHOSTADDR set to a value|strips_dead_pghost|  PGHOSTADDR=127.0.0.1 bash "${H}"|0'
    'only the reroute names unset|strips_dead_pghost|  unset PGHOSTADDR PGSERVICE PGDATABASE|1'
    'PGHOST pointed at a dead dir|strips_dead_pghost|  PGHOST="/nonexistent-socket-xyzzy" bash "${H}"|1'
    'env -u PGHOST named only in a comment|strips_dead_pghost|# never env -u PGHOST here|1'
    'PGHOST double-quoted to the live default|strips_dead_pghost|  PGHOST="/tmp" bash "${H}"|0'
    "PGHOST single-quoted to the live default|strips_dead_pghost|  PGHOST='/tmp' bash hook.sh|0"
    'PGHOST exported double-quoted as localhost|strips_dead_pghost|  export PGHOST="localhost"|0'
    'PGHOST double-quoted to a TCP loopback|strips_dead_pghost|  PGHOST="127.0.0.1" bash "${H}"|0'
    'env --unset=PGHOST|strips_dead_pghost|  env --unset=PGHOST bash "${H}"|0'
    'env -uPGHOST attached|strips_dead_pghost|  env -uPGHOST bash "${H}"|0'
    'bare env - drops the environment|strips_dead_pghost|  env - PATH="${P}" bash "${H}"|0'
    'PGHOST double-quoted to a sandbox variable|strips_dead_pghost|  PGHOST="${EPH_SOCKDIR}" bash "${H}"|1'
    'strip behind the recorder with an isolation check after it|strips_pghost_unguarded|@test "x" {\n  env -u PGHOST PYTHONPATH="${EPH_PG_RECORDER_DIR}" bash "${H}"\n  eph_assert_isolated 0\n}|1'
    'strip whose recorder rides a body-local array|strips_pghost_unguarded|@test "x" {\n  local e=(HOME="${E}"\n    PYTHONPATH="${EPH_PG_RECORDER_DIR}:${S}")\n  env -u PGHOST "${e[@]}" \\\n    bash "${H}"\n  run eph_assert_isolated 0\n}|1'
    'strip with no recorder on PYTHONPATH|strips_pghost_unguarded|@test "x" {\n  env -u PGHOST PYTHONPATH="${S}" bash "${H}"\n  eph_assert_isolated 0\n}|0'
    'strip with no isolation check after it|strips_pghost_unguarded|@test "x" {\n  env -u PGHOST PYTHONPATH="${EPH_PG_RECORDER_DIR}" bash "${H}"\n}|0'
    'isolation check only before the strip|strips_pghost_unguarded|@test "x" {\n  eph_assert_isolated 0\n  env -u PGHOST PYTHONPATH="${EPH_PG_RECORDER_DIR}" bash "${H}"\n}|0'
    'recorder array defined in another test body|strips_pghost_unguarded|@test "a" {\n  local e=(PYTHONPATH="${EPH_PG_RECORDER_DIR}")\n}\n@test "b" {\n  env -u PGHOST "${e[@]}" bash "${H}"\n  eph_assert_isolated 0\n}|0'
  )
  local row name detector body want
  for row in "${rows[@]}"; do
    IFS='|' read -r name detector body want <<<"${row}"
    printf '%b\n' "${body}" >"${fixture}"
    if [[ "${detector}" == runs_db_hook ]]; then
      run runs_db_hook "${fixture}" "${names}"
    else
      run "${detector}" "${fixture}"
    fi
    [[ "${status}" -eq "${want}" ]] || {
      printf '%s: status %s, want %s, output: %s\n' "${name}" "${status}" "${want}" "${output}"
      return 1
    }
  done
}

@test "every suite that runs a real postgres client applies the live-DB seal" {
  local root file members=0 unsealed=() suites="${BATS_TEST_TMPDIR:?}/suites"
  local db_hooks="${BATS_TEST_TMPDIR:?}/db-hooks.txt" dead_default=0
  root="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
  list_db_hooks "${root}/hooks" >"${db_hooks}"
  [[ -s "${db_hooks}" ]] || {
    echo "no DB-writing hook found under ${root}/hooks — the hook clause would pass vacuously"
    return 1
  }
  provides_dead_pghost && dead_default=1
  find "${root}/test" "${root}/hooks/test" "${root}/scripts/test" "${root}/autoagent/test" \
    -name '*.bats' -type f -print0 >"${suites}"
  while IFS= read -r -d '' file; do
    # this file names the doctor and the helper only in detector fixture rows
    [[ "${file}" == "${BATS_TEST_FILENAME}" ]] && continue
    if drives_doctor "${file}"; then
      members=$((members + 1))
      seals_in_setup "${file}" || unsealed+=("drives the doctor without ga_bats_db_seal in setup(): ${file#"${root}/"}")
    fi
    if loads_ephemeral_pg "${file}"; then
      members=$((members + 1))
      seals_in_setup "${file}" || binds_ephemeral_seal "${file}" \
        || unsealed+=("loads ephemeral-pg but binds no seal outside a subshell: ${file#"${root}/"}")
    fi
    # a DB-writing hook runs on a sandbox, else on the inherited dead PGHOST, which it must not strip;
    # on a sandbox a strip stays behind the recorder with an isolation check after it
    if runs_db_hook "${file}" "${db_hooks}"; then
      members=$((members + 1))
      if binds_ephemeral_seal "${file}"; then
        if strips_pghost_unguarded "${file}"; then
          unsealed+=("strips PGHOST on a sandbox without the recorder or a later eph_assert_isolated: ${file#"${root}/"}")
        fi
      else
        [[ "${dead_default}" -eq 1 ]] \
          || unsealed+=("runs a DB-writing hook with no sandbox and no dead PGHOST baseline: ${file#"${root}/"}")
        if strips_dead_pghost "${file}"; then
          unsealed+=("runs a DB-writing hook and strips the dead PGHOST with no sandbox: ${file#"${root}/"}")
        fi
      fi
    fi
  done <"${suites}"

  [[ "${members}" -gt 0 ]] || {
    echo "no suite matched either detector — the pin would pass vacuously"
    return 1
  }
  [[ "${#unsealed[@]}" -eq 0 ]] || {
    printf '%s\n' "${unsealed[@]}"
    return 1
  }
}
