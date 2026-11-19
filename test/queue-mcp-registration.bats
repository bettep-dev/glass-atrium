#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2154,SC2312  # engine bodies expand in their own shell; each test is a subshell → its exports are its own; run results are set by bats; a masked status fails its comparison
# The owner queue's MCP registration: the one writer of every profile's user-scope entry and the shared allow lines,
# and the doctor's read of them. Protects: a dry run and an unapproved run print each write and write nothing; an
# approved run writes exactly the printed set, once; a removal restores every file it wrote to; the doctor reports
# each gap and the project-server auto-approval switch and never writes.
#
# Hermetic: HOME, the target home and every profile are temp dirs; `claude` is a stand-in that records its argv and
# edits the config file the host would, so no real profile and no real registration command is touched.
#
# Run via: bats test/queue-mcp-registration.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

# physical path, as the launcher resolves its own root → an install under a symlinked directory names the same adapter
GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd -P)"
ADAPTER="${GA}/scripts/atrium-queue-mcp.sh"
TOOLS=(post claim record sessions relay)

setup() {
  unset CLAUDE_CONFIG_DIR CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CODE_ENTRYPOINT
  export HOME="${BATS_TEST_TMPDIR}/home"
  export GA_TARGET_HOME="${HOME}/.claude"
  export GA_DATA_ROOT="${BATS_TEST_TMPDIR}/data"
  mkdir -p "${GA_TARGET_HOME}" "${HOME}/.claude-work" "${HOME}/.claude-personal" "${BATS_TEST_TMPDIR}/bin"
  # jq's own layout: the stand-in host and the writer rewrite a file in it, so a round trip compares bytes
  jq -n '{numStartups: 3}' >"${HOME}/.claude.json"
  jq -n '{mcpServers: {own: {command: "own-server"}}}' >"${HOME}/.claude-work/.claude.json"
  jq -n '{}' >"${HOME}/.claude-personal/.claude.json"
  jq -n '{permissions: {allow: ["Bash(ls:*)"]}, model: "opus"}' >"${GA_TARGET_HOME}/settings.json"
  : >"${BATS_TEST_TMPDIR}/claude.log"
  write_claude_stub
  export PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
}

# a stand-in for the host's `claude mcp add|remove --scope user`: logs "<config dir>|<home>|<argv>" and edits the
# file the host edits — <config dir>/.claude.json, or ~/.claude.json with no config dir — leaving the key set the host
# leaves for every stdio server (type, command, args, env)
write_claude_stub() {
  cat >"${BATS_TEST_TMPDIR}/bin/claude" <<STUB
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s|%s|%s\n' "\${CLAUDE_CONFIG_DIR:-}" "\${HOME}" "\$*" >>"${BATS_TEST_TMPDIR}/claude.log"
file="\${CLAUDE_CONFIG_DIR:-\${HOME}}/.claude.json"
case "\$2" in
  add) jq --arg n "\$5" --arg c "\$7" --arg a "\$8" '.mcpServers[\$n] = {type: "stdio", command: \$c, args: [\$a], env: {}}' "\${file}" >"\${file}.t" ;;
  remove) jq --arg n "\$5" 'del(.mcpServers[\$n]) | if .mcpServers == {} then del(.mcpServers) else . end' "\${file}" >"\${file}.t" ;;
esac
mv "\${file}.t" "\${file}"
STUB
  chmod +x "${BATS_TEST_TMPDIR}/bin/claude"
}

# <mode> <flag…> → the real writer in a fresh strict-mode engine shell with the launcher's ERR trap, --dry-run and
# --approve-profile-writes set as the launcher's ga_parse_args sets them; ROOT = the install root, default this tree;
# IS_TERMINAL=true|false stands in for the terminal test, ANSWER is the typed reply on stdin
run_writer() {
  local mode="$1"
  shift
  run --separate-stderr bash -c '
    set -Eeuo pipefail
    trap '\''echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2'\'' ERR
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    mode="$2"
    shift 2
    for flag in "$@"; do
      case "${flag}" in
        --dry-run) DRY_RUN=true ;;
        --approve-profile-writes) APPROVE_PROFILE_WRITES=true ;;
        *) exit 64 ;;
      esac
    done
    [[ -z "${IS_TERMINAL:-}" ]] || ga_remote_is_terminal() { "${IS_TERMINAL}"; }
    put_queue_mcp_registration "${mode}"
  ' _ "${ROOT:-${GA}}" "${mode}" "$@" <<<"${ANSWER:-}"
}

run_doctor_row() {
  run --separate-stderr bash -c '
    set -Eeuo pipefail
    trap '\''echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2'\'' ERR
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    _doctor_report_queue_mcp
  ' _ "${ROOT:-${GA}}"
}

# → every profile file and the settings file, with their bytes, in one comparable text
get_snapshot() {
  local file
  for file in "${HOME}/.claude.json" "${HOME}/.claude-work/.claude.json" "${HOME}/.claude-personal/.claude.json" \
    "${GA_TARGET_HOME}/settings.json"; do
    printf '== %s\n' "${file}"
    cat -- "${file}"
  done
}

@test "a dry run and an unapproved run print every profile file, its entry and each allow line, and write nothing" {
  local before row flags
  before="$(get_snapshot)"
  for flags in --dry-run ""; do
    run_writer add ${flags:+"${flags}"}
    [[ "${status}" -eq 0 ]] || {
      echo "flags=${flags} ${output} ${stderr}"
      return 1
    }
    for row in "${HOME}/.claude.json: mcpServers.atrium-queue = {\"type\":\"stdio\",\"command\":\"/bin/bash\",\"args\":[\"${ADAPTER}\"],\"env\":{}}" \
      "${HOME}/.claude-work/.claude.json: mcpServers.atrium-queue" "${HOME}/.claude-personal/.claude.json: mcpServers.atrium-queue" \
      "${GA_TARGET_HOME}/settings.json: permissions.allow + mcp__atrium-queue__relay"; do
      [[ "${stderr}" == *"${row}"* ]] || {
        echo "flags=${flags} missing row: ${row}"
        echo "${stderr}"
        return 1
      }
    done
    [[ "${stderr}" == *"nothing written"* ]] || {
      echo "flags=${flags} ${stderr}"
      return 1
    }
  done
  [[ ! -s "${BATS_TEST_TMPDIR}/claude.log" ]] || {
    cat "${BATS_TEST_TMPDIR}/claude.log"
    return 1
  }
  [[ "$(get_snapshot)" == "${before}" ]]
}

@test "an approved run registers each profile through the host's command and adds the five allow lines, once" {
  local tool
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  [[ "$(cat "${BATS_TEST_TMPDIR}/claude.log")" == "$(printf '%s\n' \
    "|${HOME}|mcp add --scope user atrium-queue -- /bin/bash ${ADAPTER}" \
    "${HOME}/.claude-personal|${HOME}|mcp add --scope user atrium-queue -- /bin/bash ${ADAPTER}" \
    "${HOME}/.claude-work|${HOME}|mcp add --scope user atrium-queue -- /bin/bash ${ADAPTER}")" ]] \
    || {
      cat "${BATS_TEST_TMPDIR}/claude.log"
      return 1
    }
  for tool in "${TOOLS[@]}"; do
    [[ "$(jq --arg l "mcp__atrium-queue__${tool}" '[.permissions.allow[] | select(. == $l)] | length' \
      "${GA_TARGET_HOME}/settings.json")" == 1 ]] || {
      echo "tool ${tool}"
      cat "${GA_TARGET_HOME}/settings.json"
      return 1
    }
  done
  [[ "$(jq -c '[.permissions.allow[0], .model]' "${GA_TARGET_HOME}/settings.json")" == '["Bash(ls:*)","opus"]' ]]
}

@test "an approved removal after an approved add leaves every file as it was, and an entry pointing elsewhere stays" {
  local before
  jq '.mcpServers["atrium-queue"] = {command: "/bin/bash", args: ["/elsewhere/adapter.sh"]}' \
    "${HOME}/.claude-personal/.claude.json" >"${BATS_TEST_TMPDIR}/p" && mv "${BATS_TEST_TMPDIR}/p" "${HOME}/.claude-personal/.claude.json"
  before="$(get_snapshot)"
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  jq '.mcpServers["atrium-queue"] = {command: "/bin/bash", args: ["/elsewhere/adapter.sh"]}' \
    "${HOME}/.claude-personal/.claude.json" >"${BATS_TEST_TMPDIR}/p" && mv "${BATS_TEST_TMPDIR}/p" "${HOME}/.claude-personal/.claude.json"
  run_writer remove --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  [[ "$(get_snapshot)" == "${before}" ]] || {
    diff <(printf '%s\n' "${before}") <(get_snapshot)
    return 1
  }
}

# <file> <preview> → the entry JSON the preview shows for that profile file
get_previewed_entry() {
  local line
  line="$(grep -F -- "$1: mcpServers.atrium-queue = " <<<"$2")" || return 1
  line="${line#*mcpServers.atrium-queue = }"
  printf '%s\n' "${line%% (*}"
}

@test "the preview shows each profile entry and the settings backup exactly as an approved write leaves them" {
  local preview file want got backups
  run_writer add --dry-run
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  preview="${stderr}"
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  for file in "${HOME}/.claude.json" "${HOME}/.claude-work/.claude.json" "${HOME}/.claude-personal/.claude.json"; do
    want="$(get_previewed_entry "${file}" "${preview}" | jq -cS .)" || want="(no preview line)"
    got="$(jq -cS '.mcpServers["atrium-queue"]' "${file}")"
    [[ "${got}" == "${want}" ]] || {
      echo "${file}: previewed ${want}, written ${got}"
      echo "${preview}"
      return 1
    }
  done
  backups=("${GA_TARGET_HOME}"/settings.json.ga-backup.*)
  [[ "${#backups[@]}" -eq 1 && -f "${backups[0]}" &&
    "${preview}" == *"${GA_TARGET_HOME}/settings.json: backed up first to ${GA_TARGET_HOME}/settings.json.ga-backup."* ]] || {
    ls -A "${GA_TARGET_HOME}"
    echo "${preview}"
    return 1
  }
}

@test "on a terminal an unflagged add shows the writes and asks, default No, and only a typed y makes them" {
  local before row name answer want
  local rows=('empty answer||no' 'n|n|no' 'y|y|yes')
  before="$(get_snapshot)"
  for row in "${rows[@]}"; do
    IFS='|' read -r name answer want <<<"${row}"
    IS_TERMINAL=true ANSWER="${answer}" run_writer add
    [[ "${status}" -eq 0 && "${stderr}" == *"${HOME}/.claude-work/.claude.json: mcpServers.atrium-queue = "* &&
      "${stderr}" == *"[y/N]"* ]] || {
      echo "${name}: ${status} ${stderr}"
      return 1
    }
    if [[ "${want}" == no ]]; then
      [[ "$(get_snapshot)" == "${before}" && ! -s "${BATS_TEST_TMPDIR}/claude.log" ]] || {
        echo "${name}: wrote"
        return 1
      }
    else
      [[ "$(jq -r '.mcpServers["atrium-queue"].args[0]' "${HOME}/.claude-work/.claude.json")" == "${ADAPTER}" &&
      "$(jq '[.permissions.allow[] | select(startswith("mcp__atrium-queue__"))] | length' \
        "${GA_TARGET_HOME}/settings.json")" == 5 ]] || {
        echo "${name}: not written"
        return 1
      }
    fi
  done
}

@test "on a terminal an unflagged removal warns of the failed server, asks default No, and only a typed y removes" {
  local before row name answer want
  local rows=('empty answer||no' 'y|y|yes')
  before="$(get_snapshot)"
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  for row in "${rows[@]}"; do
    IFS='|' read -r name answer want <<<"${row}"
    IS_TERMINAL=true ANSWER="${answer}" run_writer remove
    [[ "${status}" -eq 0 && "${stderr}" == *"failed MCP server"* && "${stderr}" == *"[y/N]"* ]] || {
      echo "${name}: ${status} ${stderr}"
      return 1
    }
    if [[ "${want}" == no ]]; then
      [[ "$(jq -r '.mcpServers["atrium-queue"].args[0]' "${HOME}/.claude-work/.claude.json")" == "${ADAPTER}" ]] || {
        echo "${name}: removed"
        return 1
      }
    else
      [[ "$(get_snapshot)" == "${before}" ]] || {
        echo "${name}: not removed"
        diff <(printf '%s\n' "${before}") <(get_snapshot)
        return 1
      }
    fi
  done
}

@test "with no claude CLI on PATH a terminal run says so in one line, asks nothing and writes nothing" {
  local before
  before="$(get_snapshot)"
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" IS_TERMINAL=true ANSWER=y run_writer add
  [[ "${status}" -eq 0 && "${stderr}" == *"no claude CLI on PATH"* && "${stderr}" != *"[y/N]"* && "${stderr}" != *"ERROR:"* ]] || {
    echo "${status} ${stderr}"
    return 1
  }
  [[ "$(get_snapshot)" == "${before}" ]]
}

@test "the doctor reports each unregistered profile, each missing allow line and the project-server switch, and writes nothing" {
  local before row
  jq '.enableAllProjectMcpServers = true' "${GA_TARGET_HOME}/settings.json" >"${BATS_TEST_TMPDIR}/s" \
    && mv "${BATS_TEST_TMPDIR}/s" "${GA_TARGET_HOME}/settings.json"
  jq '.mcpServers["atrium-queue"] = {command: "/bin/bash", args: ["/elsewhere/adapter.sh"]}' \
    "${HOME}/.claude-personal/.claude.json" >"${BATS_TEST_TMPDIR}/p" && mv "${BATS_TEST_TMPDIR}/p" "${HOME}/.claude-personal/.claude.json"
  before="$(get_snapshot)"
  run_doctor_row
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  for row in "${HOME}/.claude.json has no atrium-queue entry" "${HOME}/.claude-personal/.claude.json: atrium-queue points elsewhere" \
    "missing mcp__atrium-queue__post" "enableAllProjectMcpServers"; do
    [[ "${stderr}" == *"${row}"* ]] || {
      echo "missing row: ${row}"
      echo "${stderr}"
      return 1
    }
  done
  [[ "${stderr}" != *"ok   : queue MCP"* ]] || {
    echo "${stderr}"
    return 1
  }
  [[ "$(get_snapshot)" == "${before}" ]]
}

@test "the doctor reads a registered install as registered and the switch off as no finding" {
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  run_doctor_row
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  [[ "${stderr}" == *"ok   : queue MCP atrium-queue registered in 3 profile(s), its 5 allow line(s) present"* ]] \
    || {
      echo "${stderr}"
      return 1
    }
  [[ "${stderr}" != *"note : queue MCP"* ]] || {
    echo "${stderr}"
    return 1
  }
}

@test "the launcher's queue-mcp step prints the writes and writes nothing on a dry run, and makes them on approval" {
  local before
  before="$(get_snapshot)"
  run --separate-stderr "${GA}/glass-atrium" queue-mcp --dry-run
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  [[ "${stderr}" == *"${HOME}/.claude-work/.claude.json: mcpServers.atrium-queue"* &&
    "${stderr}" == *"permissions.allow + mcp__atrium-queue__post"* && "$(get_snapshot)" == "${before}" ]] || {
    echo "${stderr}"
    return 1
  }
  run --separate-stderr "${GA}/glass-atrium" queue-mcp --approve-profile-writes
  [[ "${status}" -eq 0 ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  [[ "$(jq -r '.mcpServers["atrium-queue"].args[0]' "${HOME}/.claude-work/.claude.json")" == "${ADAPTER}" &&
  "$(jq '[.permissions.allow[] | select(startswith("mcp__atrium-queue__"))] | length' \
    "${GA_TARGET_HOME}/settings.json")" == 5 ]]
}

@test "with no adapter to answer, the installer and the doctor each skip with one note and raise no error" {
  local before
  # an install root without the adapter: the engine libs alone
  ROOT="${BATS_TEST_TMPDIR}/root"
  mkdir -p "${ROOT}/scripts"
  ln -s "${GA}/lib" "${ROOT}/lib"
  ln -s "${GA}/hooks" "${ROOT}/hooks"
  ln -s "${GA}/scripts/lib" "${ROOT}/scripts/lib"
  before="$(get_snapshot)"
  run_writer add --approve-profile-writes
  [[ "${status}" -eq 0 && "${stderr}" == *"queue MCP registration (add): warn: skipped"* && "${stderr}" != *"ERROR:"* ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  run_doctor_row
  [[ "${status}" -eq 0 && "${stderr}" == *"note : queue MCP: check skipped"* && "${stderr}" != *"ERROR:"* ]] || {
    echo "${output} ${stderr}"
    return 1
  }
  [[ "$(get_snapshot)" == "${before}" ]]
}
