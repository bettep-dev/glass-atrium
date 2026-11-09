#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2312  # BATS_* and run results are set by bats; a masked status fails its comparison
# The owner-run queue setup script on a pseudo-terminal. Protects the TTY-only refusal, the 0600 secret
# files in the 0700 secrets dir, a passphrase record the monitor's scrypt check accepts, no secret on any
# output or on a child's argv or env, keep-unless-rotated, and nothing written on a refused entry.
#
# Run via: bats scripts/test/atrium-queue-setup.bats
# Requires: bats, bash 3.2+, node, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
SETUP="${GA}/scripts/atrium-queue-setup.sh"
PASSPHRASE="correct horse battery staple 42"
OTHER_PASSPHRASE="a different passphrase 7"

setup() {
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  SECRETS="${GA_ROOT}/secrets"
  mkdir -p "${BATS_TEST_TMPDIR}/bin"
  # node shim: records each child's argv and env, then runs the real node unchanged
  cat >"${BATS_TEST_TMPDIR}/bin/node" <<SHIM
#!/usr/bin/env bash
{ printf 'argv: %s\n' "\$*"; env; } >>"${BATS_TEST_TMPDIR}/node-calls.log"
exec "$(command -v node)" "\$@"
SHIM
  chmod 755 "${BATS_TEST_TMPDIR}/bin/node"
  export PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
  : >"${BATS_TEST_TMPDIR}/node-calls.log"
}

# <passphrase entry...> -- <setup args...> → status and ${output} from the terminal session
run_on_tty() {
  local answers="${BATS_TEST_TMPDIR}/answers"
  : >"${answers}"
  while (($# > 0)) && [[ "$1" != "--" ]]; do
    printf '%s\n' "$1" >>"${answers}"
    shift
  done
  (($# == 0)) || shift
  run python3 -I "${BATS_TEST_DIRNAME}/_pty_drive.py" "${answers}" "assphrase" \
    "${BATS_TEST_TMPDIR}/tty-output" "${SETUP}" "$@"
  output="$(cat "${BATS_TEST_TMPDIR}/tty-output")"
}

# the monitor's derivation (passphrase.ts deriveKey) over the stored record → "match" or "mismatch"
check_passphrase() {
  printf '%s' "$1" | node -e '
    const { scryptSync, timingSafeEqual } = require("node:crypto");
    const record = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const passphrase = require("node:fs").readFileSync(0, "utf8");
    const derived = scryptSync(passphrase, Buffer.from(record.salt, "base64"), record.keyLength,
      { N: record.N, r: record.r, p: record.p, maxmem: 128 * record.r * (record.N + record.p + 2) });
    process.stdout.write(timingSafeEqual(derived, Buffer.from(record.hash, "base64")) ? "match" : "mismatch");
  ' "${SECRETS}/owner-passphrase.json"
}

mode_of() {
  local listing
  listing="$(ls -ld -- "$1")"
  printf '%s\n' "${listing:0:10}"
}

@test "a stdin that is not a terminal is refused with exit 64 and nothing written" {
  run --separate-stderr "${SETUP}" </dev/null
  [[ "${status}" -eq 64 && "${stderr}" == *"not a terminal"* ]] || {
    echo "status=${status} ${stderr}"
    return 1
  }
  [[ ! -e "${GA_ROOT}" ]] || {
    echo "wrote under ${GA_ROOT}"
    return 1
  }
}

@test "setup on a terminal writes both secrets as 0600 files in a 0700 dir, in the shapes the monitor reads" {
  run_on_tty "${PASSPHRASE}" "${PASSPHRASE}"
  [[ "${status}" -eq 0 ]] || {
    echo "status=${status} ${output}"
    return 1
  }
  [[ "$(mode_of "${SECRETS}")" == drwx------ && "$(mode_of "${SECRETS}/queue-key")" == -rw------- &&
  "$(mode_of "${SECRETS}/owner-passphrase.json")" == -rw------- ]] || {
    ls -la "${SECRETS}"
    return 1
  }
  grep -qE '^[A-Za-z0-9_-]{16,255}$' "${SECRETS}/queue-key" || {
    echo "queue key shape"
    return 1
  }
  jq -e 'keys == ["N", "algorithm", "hash", "keyLength", "p", "r", "salt"] and .algorithm == "scrypt"' \
    "${SECRETS}/owner-passphrase.json" >/dev/null || {
    echo "record keys: $(jq -c 'keys' "${SECRETS}/owner-passphrase.json")"
    return 1
  }
  [[ "$(check_passphrase "${PASSPHRASE}")" == match && "$(check_passphrase "${OTHER_PASSPHRASE}")" == mismatch ]] || {
    echo "the record does not verify the entered passphrase alone"
    return 1
  }
}

@test "no secret reaches the terminal output or any child's argv or env" {
  run_on_tty "${PASSPHRASE}" "${PASSPHRASE}"
  [[ "${status}" -eq 0 ]] || {
    echo "status=${status} ${output}"
    return 1
  }
  local key secret
  key="$(cat "${SECRETS}/queue-key")"
  for secret in "${PASSPHRASE}" "${key}"; do
    [[ "${output}" != *"${secret}"* ]] || {
      echo "a secret reached the terminal output"
      return 1
    }
    ! grep -qF -- "${secret}" "${BATS_TEST_TMPDIR}/node-calls.log" || {
      echo "a secret reached a child's argv or env"
      return 1
    }
  done
  grep -q '^argv: ' "${BATS_TEST_TMPDIR}/node-calls.log" || {
    echo "the node shim recorded no call"
    return 1
  }
}

@test "an entry that is refused writes nothing and exits 1" {
  local row
  local row name first second reason
  for row in "entries differ|${PASSPHRASE}|${OTHER_PASSPHRASE}|entries differ" \
    "too short|short pass|short pass|12 to 1024 characters"; do
    IFS='|' read -r name first second reason <<<"${row}"
    run_on_tty "${first}" "${second}"
    [[ "${status}" -eq 1 && "${output}" == *"${reason}"* && ! -e "${SECRETS}/queue-key" &&
      ! -e "${SECRETS}/owner-passphrase.json" ]] || {
      echo "row ${name}: status=${status} ${output}"
      ls -la "${SECRETS}"
      return 1
    }
  done
}

@test "an existing secret is kept unless rotated, and a rotate replaces only its own secret" {
  run_on_tty "${PASSPHRASE}" "${PASSPHRASE}"
  local row name rotated key_before record_before replaced restart
  for row in "plain rerun|" "rotate key|key" "rotate passphrase|passphrase"; do
    IFS='|' read -r name rotated <<<"${row}"
    key_before="$(cat "${SECRETS}/queue-key")"
    record_before="$(cat "${SECRETS}/owner-passphrase.json")"
    case "${rotated}" in
      key) run_on_tty -- --rotate key ;;
      passphrase) run_on_tty "${OTHER_PASSPHRASE}" "${OTHER_PASSPHRASE}" -- --rotate passphrase ;;
      *) run_on_tty ;;
    esac
    replaced=""
    if [[ "$(cat "${SECRETS}/queue-key")" != "${key_before}" ]]; then replaced+="key"; fi
    if [[ "$(cat "${SECRETS}/owner-passphrase.json")" != "${record_before}" ]]; then replaced+="passphrase"; fi
    restart=""
    if [[ "${output}" == *"Restart the monitor"* ]]; then restart="${rotated}"; fi
    [[ "${status}" -eq 0 && "${replaced}" == "${rotated}" && "${restart}" == "${rotated}" ]] || {
      echo "row ${name}: status=${status} replaced=${replaced} ${output}"
      return 1
    }
  done
  [[ "$(check_passphrase "${OTHER_PASSPHRASE}")" == match ]] || {
    echo "the rotated record does not verify the new passphrase"
    return 1
  }
}
