#!/usr/bin/env bats
# enforce-foreground-harness.bats — Bats suite for the PreToolUse(Agent) gate enforcing Harness Path
#   Protection Rule 2 (staged lane MANDATORY): an Agent prompt naming a non-exempt harness path is
#   blocked whatever run_in_background holds or omits.
#
# The hook reads each path the delegation prompt names through the filesystem (stat only) — it cannot
# tell a READ reference from a WRITE target. Exempt: the BASENAME files at a harness root, the runtime-DATA subdirs (data/,
# projects/, logs/, …), and a progress-*.md directly in a projects/<p>/memory/ dir. Every other memory
# file and every CONFIG path (agents/, hooks/, skills/, settings*.json) stays protected, and a `..`
# segment voids every exemption.
#
# Decision channel = exit code: 0 PASS (not blocked) / 2 BLOCK (Rule-2 violation).
# 격리: 합성 JSON 을 stdin 으로 주입, 라이브 hook input 미의존.

bats_require_minimum_version 1.5.0

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-foreground-harness.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-foreground-harness.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Drive the hook as an Agent PreToolUse call. jq -n builds the payload so the
# prompt (which carries backticks, ~ and $ path chars) is safely encoded.
# Args: $1 = prompt body · $2 = run_in_background: a JSON literal (true/false), `omit` (field absent)
#   or `string:<v>` (string-valued field). HOOK_BASH = interpreter running the hook (default: PATH bash).
run_agent() {
  local prompt="$1" bg="$2" payload
  case "${bg}" in
    omit)
      payload="$(jq -n --arg p "${prompt}" '{tool_name:"Agent", tool_input:{prompt:$p}}')"
      ;;
    string:*)
      payload="$(jq -n --arg p "${prompt}" --arg bg "${bg#string:}" \
        '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
      ;;
    *)
      payload="$(jq -n --arg p "${prompt}" --argjson bg "${bg}" \
        '{tool_name:"Agent", tool_input:{prompt:$p, run_in_background:$bg}}')"
      ;;
  esac
  run bash -c 'printf "%s" "$1" | "$3" "$2"' _ "${payload}" "${HOOK_SH}" "${HOOK_BASH:-bash}"
}

# Every distinct bash on this host — /bin/bash is 3.2 on macOS, the PATH bash is 5 in CI.
list_bashes() {
  local path_bash
  path_bash="$(command -v bash)"
  printf '%s\n' /bin/bash
  [[ "${path_bash}" == /bin/bash ]] || printf '%s\n' "${path_bash}"
}

# The field never decides: model-sent, so its presence and value prove nothing about the launch.

@test "a config path blocks whatever run_in_background holds or omits" {
  local row name bg
  for row in "field absent|omit" "string-valued field|string:false" "explicit false|false" "explicit true|true"; do
    IFS='|' read -r name bg <<<"${row}"
    run_agent 'Write ~/.claude/hooks/x.sh.' "${bg}"
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a literal-home config path blocks under every available bash" {
  local interp row name prompt
  while IFS= read -r interp; do
    for row in \
      'dollar HOME|Edit $HOME/.claude/agents/x.md now.' \
      'braced HOME|Edit ${HOME}/.claude/agents/x.md now.' \
      'quoted dollar HOME|Edit "$HOME"/.claude/agents/x.md now.' \
      'quoted braced HOME|Edit "${HOME}"/.claude/agents/x.md now.'; do
      IFS='|' read -r name prompt <<<"${row}"
      HOOK_BASH="${interp}" run_agent "${prompt}" omit
      [[ "${status}" -eq 2 ]] || {
        echo "row: ${name} under ${interp} · status ${status}: ${output}"
        return 1
      }
    done
  done < <(list_bashes)
}

@test "a home holding regex metacharacters matches as a fixed string" {
  local row name want prompt home='/tmp/a.b+c'
  for row in \
    "the home itself|2|Write ${home}/.claude/hooks/x.sh now." \
    'a path the home pattern would match as a regex|0|Write /tmp/aXbbc/.claude/hooks/x.sh now.'; do
    IFS='|' read -r name want prompt <<<"${row}"
    HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

# BASENAME and runtime-DATA exemptions: a root-level allowlisted file, or a read-only reference to a
#   runtime-data subdir, is not blocked in any root form.

@test "BASENAME and runtime-DATA references are not blocked in any root form" {
  local row name prompt
  for row in \
    'CLAUDE.md|Append the project note to ~/.claude/CLAUDE.md then stop.' \
    'MEMORY.md|Add the index line to ~/.claude/MEMORY.md and exit.' \
    'GLASS_ATRIUM_GLOBAL_RULES.md|Update ~/.claude/GLASS_ATRIUM_GLOBAL_RULES.md now.' \
    'data/|For context, read ~/.claude/data/outcomes/2026-07-07.md.' \
    'projects/ transcript|Analyze ~/.claude/projects/-Users-x/session.jsonl (read-only).' \
    'logs/|Tail ~/.claude/logs/daemon.log.' \
    "absolute-home data/|Read ${HOME}/.claude/data/learning-log.md for prior lessons." \
    'CWD-relative data/|From the repo root, read .claude/data/session-spawns/latest.json.' \
    'job tmp/ scratch on the base root|Read ~/.claude/jobs/25a65a54/tmp/out.txt.' \
    'job tmp/ scratch on a profile branch|Look at ~/.claude-work/jobs/64546714/tmp/clear-x.png for the capture.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 0 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

# CONFIG-write protection

@test "tilde ~/.claude-personal/<config> → STILL blocked" {
  run_agent 'Update ~/.claude-personal/agents/reviewer.md with the new domains.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/settings.json → STILL blocked (settings*.json protected)" {
  run_agent 'Add the hook entry to ~/.claude/settings.json.' true
  [[ "${status}" -eq 2 ]]
}

@test "tilde ~/.claude/skills/x/SKILL.md → STILL blocked (skills config)" {
  run_agent 'Edit ~/.claude/skills/foo/SKILL.md description field.' true
  [[ "${status}" -eq 2 ]]
}

# Path-form arms classify CONFIG correctly (case e)

@test "absolute-\$HOME /.claude/hooks/ config → STILL blocked (arm intact)" {
  run_agent "Write ${HOME}/.claude/hooks/new.sh and wire it." true
  [[ "${status}" -eq 2 ]]
}

@test "CWD-relative .claude/agents/ config → STILL blocked (arm intact)" {
  run_agent 'From the home dir, edit .claude/agents/custom.md frontmatter.' true
  [[ "${status}" -eq 2 ]]
}

# Memory dir under projects/: only a progress checkpoint the charter mandates is exempt.

@test "a progress file directly in a memory dir is the only memory file not blocked" {
  local row name want prompt
  for row in \
    'progress file|0|Persist ~/.claude/projects/-Users-x/memory/progress-foo.md now.' \
    'progress file on a profile branch|0|Persist ~/.claude-personal/projects/-Users-x/memory/progress-foo.md now.' \
    'MEMORY.md in the memory dir|2|Update ~/.claude/projects/-Users-x/memory/MEMORY.md now.' \
    'feedback file|2|Write ~/.claude-work/projects/-Users-x/memory/feedback_x.md now.' \
    'traversal that ends on a progress name|2|Write ~/.claude/projects/../memory/progress-x.md now.' \
    'progress file one dir deeper|2|Write ~/.claude/projects/-Users-x/memory/sub/progress-x.md now.' \
    'progress file under a memory dir nested deeper in projects|2|Write ~/.claude/projects/-Users-x/memory/sub/memory/progress-x.md now.' \
    'file inside a progress-named dir|2|Write ~/.claude/projects/-Users-x/memory/progress-x/MEMORY.md now.' \
    'non-md progress file|2|Write ~/.claude/projects/-Users-x/memory/progress-x.txt now.' \
    'progress file behind a wildcard project segment|0|Persist ~/.claude/projects/*/memory/progress-x.md now.'; do
    IFS='|' read -r name want prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

# A glob is expanded level by level, so its cost stops growing with depth once a level passes the match cap.
@test "a glob level matching more than 1024 paths is judged protected, and one at the cap is walked" {
  local wide="${BATS_TEST_TMPDIR}/wide"
  mkdir -p "${wide}"
  seq -f "${wide}/d%04g" 1 1024 | xargs mkdir
  run_agent "Edit ${wide}/*/.claude/x.md now." omit
  [[ "${status}" -eq 0 ]] || { echo "1024 matches: status ${status}: ${output}"; return 1; }
  mkdir "${wide}/d1025"
  run_agent "Edit ${wide}/*/.claude/x.md now." omit
  [[ "${status}" -eq 2 ]] || { echo "1025 matches: status ${status}: ${output}"; return 1; }
}

# A level past the cap decides by itself: expanding the whole pattern at once would see only the empty final level.
@test "a non-final glob level past the cap is judged protected though the final level is empty" {
  local wide="${BATS_TEST_TMPDIR}/wide"
  mkdir -p "${wide}"
  seq -f "${wide}/d%04g" 1 1024 | xargs mkdir
  run_agent "Edit ${wide}/*/nomatch*/.claude/y.md now." omit
  [[ "${status}" -eq 0 ]] || { echo "1024 at the wide level: status ${status}: ${output}"; return 1; }
  mkdir "${wide}/d1025"
  run_agent "Edit ${wide}/*/nomatch*/.claude/y.md now." omit
  [[ "${status}" -eq 2 ]] || { echo "1025 at the wide level: status ${status}: ${output}"; return 1; }
}

@test "the job tmp/ and progress-file exemptions hold only below a real id segment" {
  local row name prompt
  for row in \
    'dot segment in place of the job id|Read ~/.claude/jobs/./tmp/out.txt.' \
    'dot segment in place of the project|Write ~/.claude/projects/./memory/progress-x.md now.' \
    'job state file beside its tmp/|Write ~/.claude/jobs/25a65a54/state.json now.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a .. segment voids every exemption" {
  local row name prompt
  for row in \
    'projects traversal|Write ~/.claude/projects/../agents/x.md now.' \
    'data traversal|Write ~/.claude/data/../settings.json now.' \
    'BASENAME traversal|Write ~/.claude/CLAUDE.md/../hooks/x.sh now.'; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq 2 ]] || {
      echo "row: ${name} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "a .. ahead of the root blocks exactly when the path it resolves to is a harness root" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'tilde, a dir, then ..|Edit ~/x/../.claude/agents/a.md now.' \
    'home variable, a dir, then ..|Edit $HOME/x/../.claude/agents/a.md now.' \
    "literal home, a dir, then ..|Edit ${home}/x/../.claude/agents/a.md now." \
    'climb out of the home and back in|Edit ~/../u/.claude/agents/a.md now.' \
    'lookalike dir, then ..|Edit ~/.claudex/../.claude/agents/a.md now.' \
    'lookalike dotted dir, then ..|Edit ~/.claude.d/../.claude/agents/a.md now.' \
    'relative from home, then ..|From the home dir, edit x/../.claude/agents/a.md now.' \
    'traversal onto a progress name|Write ~/x/../.claude/projects/p/memory/progress-a.md now.'
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
    'resolves to a repo dot dir|Edit ~/x/../y/.claude/agents/a.md now.' \
    'lookalike dir climbed out of|Edit ~/.claudex/../notes/a.md now.' \
    'resolves to the global config file|Read ~/x/../.claude.json now.' \
    'climbs to another home|Edit ~/../v/.claude/agents/a.md now.'
}

# Spellings that name a harness path in plain text: each resolves to the live harness, so each blocks.

# Args: $1 = want (exit code) · $2.. = `name|prompt` rows. HOME may be set by the caller.
assert_rows() {
  local want="$1" row name prompt
  shift
  for row in "$@"; do
    IFS='|' read -r name prompt <<<"${row}"
    run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
  done
}

@test "an angle-bracket placeholder segment does not cut the path short" {
  assert_rows 2 \
    'MEMORY.md behind a placeholder|Edit ~/.claude/projects/<home-encoded>/memory/MEMORY.md now.' \
    'feedback file behind a placeholder|Write ~/.claude-personal/projects/<home-encoded>/memory/feedback_x.md now.' \
    'traversal behind a placeholder|Edit ~/.claude/projects/<p>/../../agents/x.md now.'
  assert_rows 0 \
    'the charter progress spelling|Persist ~/.claude/projects/<home-encoded>/memory/progress-{task-name}.md now.'
}

@test "a protected path joined onto an exempt path by a separator is still classified" {
  assert_rows 2 \
    'comma|Edit ~/.claude/data/a.json,~/.claude/settings.json now.' \
    'scope line|[SCOPE] files=~/.claude/data/report.json,~/.claude/agents/x.md · deliverable=edit · out=none' \
    'semicolon onto a branch|Edit ~/.claude/logs/a;~/.claude-work/settings.json now.' \
    'colon|Edit ~/.claude/projects/p/notes.md:~/.claude/hooks/x.sh now.' \
    'pipe|Edit ~/.claude/todos/a|~/.claude/settings.json now.' \
    'ampersands|Edit ~/.claude/data/a&&~/.claude/settings.json now.' \
    'relative after a comma|Edit ~/.claude/data/a,.claude/settings.json now.'
  assert_rows 0 \
    'two exempt paths in one list|[SCOPE] files=~/.claude/data/a.json,~/.claude/projects/-Users-x/memory/progress-x.md · deliverable=edit · out=none'
}

@test "a harness root named without a trailing slash still blocks" {
  assert_rows 2 \
    'cd into the root|cd ~/.claude && edit settings.json' \
    'root as a directory word|Rewrite the hooks in the ~/.claude directory.' \
    'bare root|Edit ~/.claude' \
    'bare branch root|Edit ~/.claude-work' \
    'quoted root|Edit "~/.claude"/settings.json now.' \
    'glob root|Edit ~/.claude*/settings.json now.' \
    'brace list of roots|Edit ~/{.claude,.claude-work}/settings.json now.' \
    'brace branch suffix|Edit ~/.claude-{work,personal}/settings.json now.'
  assert_rows 0 \
    'the global config file is no config dir|Read ~/.claude.json for the MCP server list.'
}

@test "a noisy spelling of the home dir still blocks" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'doubled slash after tilde|Edit ~//.claude/agents/x.md now.' \
    'dot segment after tilde|Edit ~/./.claude/agents/x.md now.' \
    "doubled slash after the home|Edit ${home}//.claude/agents/x.md now." \
    "dot segment after the home|Edit ${home}/./.claude/agents/x.md now." \
    "doubled slash inside the home|Edit ${BATS_TEST_TMPDIR}/home//u/.claude/agents/x.md now." \
    'tilde with a user name|Edit ~u/.claude/agents/x.md now.' \
    'dot-slash relative|cd ~ && edit ./.claude/agents/x.md' \
    'relative after an equals sign|Edit --file=.claude/agents/x.md now.' \
    'quote inside the path|Edit $HOME"/.claude/agents/x.md" now.' \
    "single quotes splitting the root|Edit ~/.cl'aude'/agents/x.md now." \
    'backslash before the root|Edit ~/\.claude/agents/x.md now.'
}

@test "trailing punctuation after a path does not change its class" {
  assert_rows 0 \
    'progress file ending a sentence|Checkpoint to ~/.claude/projects/-Users-x/memory/progress-foo.md.' \
    'progress file in bold|Checkpoint to **~/.claude/projects/-Users-x/memory/progress-foo.md**' \
    'progress file before an exclamation|Checkpoint to ~/.claude/projects/-Users-x/memory/progress-foo.md!' \
    'BASENAME file ending a sentence|Append the note to ~/.claude/CLAUDE.md.'
  assert_rows 2 \
    'traversal before punctuation|Read ~/.claude/data/..!'
}

@test "an empty home still blocks a harness path instead of rewriting every separator" {
  HOME='' assert_rows 2 \
    'tilde config path|Write ~/.claude/hooks/x.sh now.' \
    'home variable config path|Edit $HOME/.claude/agents/x.md now.' \
    'tilde traversal ahead of the root|Edit ~/x/../.claude/agents/x.md now.'
}

@test "a case variant of a harness root blocks, since the host filesystem folds case" {
  local upper_home
  upper_home="$(printf '%s' "${HOME}" | tr '[:lower:]' '[:upper:]')"
  assert_rows 2 \
    'capitalized root|Edit ~/.Claude/agents/x.md now.' \
    'upper-case branch root|Edit ~/.CLAUDE-work/settings.json now.' \
    'upper-case home|Edit '"${upper_home}"'/.claude/hooks/x.sh now.' \
    'capitalized relative root|From the home dir, edit .Claude/agents/x.md now.'
}

# Filesystem resolution: a spelling no text pattern reads as a root still blocks when the filesystem
#   resolves it into one, and a spelling that only looks like the home passes.

@test "a spelling the filesystem resolves into a harness root blocks" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}/.claude/agents" "${home}/.claude/projects/p.claude/memory" "${home}/proj" "${home}/repo/.claude"
  ln -s ../.claude "${home}/proj/.claude"
  ln -s ../.claude/agents "${home}/proj/.claude-agents"
  ln -s ../.claude/settings.json "${home}/proj/.claude-settings.json"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'glob star inside the root name|Edit ~/.cl*aude/agents/new.md now.' \
    'glob bracket inside the root name|Edit ~/.[c]laude/hooks/x.sh now.' \
    'option-joined relative path|Run tool -f.claude/agents/a.md now.' \
    'at-prefixed relative path|Attach @.claude/settings.json now.' \
    'tilde-plus form|Edit ~+/.claude/agents/a.md now.' \
    'tilde-minus form|Edit ~-/.claude/settings.json now.' \
    'directory symlink onto the root|Edit ~/proj/.claude/agents/a.md now.' \
    "absolute path through a directory symlink|Edit ${home}/proj/.claude/settings.json now." \
    'directory symlink onto a dir inside the root|Edit ~/proj/.claude-agents/a.md now.' \
    'file symlink onto a root file|Edit ~/proj/.claude-settings.json now.'
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
    "a repo's own .claude dir|Edit ~/repo/.claude/agents/a.md now." \
    "the home path inside another volume path|Edit /Volumes/x${home}/.claude/agents/a.md now." \
    'a glob match whose real name holds .claude text|Persist ~/.claude/projects/*/memory/progress-a.md now.'
}

@test "a symlink below an exempt runtime-DATA entry voids the exemption, and a plain path keeps it" {
  local home="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${home}/.claude/hooks" "${home}/.claude/projects/p" "${home}/.claude/jobs/a/tmp" "${home}/.claude/data"
  ln -s "${home}/.claude/hooks" "${home}/.claude/projects/p/l"
  ln -s ../../../hooks "${home}/.claude/jobs/a/tmp/l"
  ln -s "${home}/.claude/hooks" "${home}/.claude/data/l"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'link in a project dir|Edit ~/.claude/projects/p/l/x.sh now.' \
    'link in a job scratch dir|Edit ~/.claude/jobs/a/tmp/l/x.sh now.' \
    'link directly in a data dir|Edit ~/.claude/data/l/x.sh now.' \
    'the link itself|Rewrite ~/.claude/data/l now.'
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
    'plain path in a project dir|Read ~/.claude/projects/p/x.jsonl now.' \
    'plain path in a job scratch dir|Read ~/.claude/jobs/a/tmp/out.txt now.'
}

@test "text a walk cannot read voids an exemption, and a plainly written path keeps it" {
  local home="${BATS_TEST_TMPDIR}/home/u" interp
  mkdir -p "${home}/.claude/jobs/a/tmp/b" "${home}/.claude/logs/c" "${home}/.claude/projects/p/memory" "${home}/proj"
  : >"${home}/.claude/settings.json"
  ln -s "${home}/.claude/logs/../settings.json" "${home}/proj/.claude-l"
  while IFS= read -r interp; do
    HOOK_BASH="${interp}" HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
      'an unset variable spelling a traversal in job scratch|cp /tmp/x ~/.claude/jobs/a/tmp/.$x./.$x./.$x./settings.json' \
      'an unset variable spelling a traversal in runtime data|cp /tmp/x ~/.claude/logs/.$x./settings.json' \
      'a braced variable hiding the memory dir|Edit ~/.claude/projects/-Users-x/mem${y}ory/MEMORY.md now.' \
      'a quoted variable between dots|cp /tmp/x ~/.claude/logs/."$x"./settings.json' \
      'a star glob opening with a dot|cp /tmp/x ~/.claude/jobs/a/tmp/.*/.*/.*/settings.json' \
      'a one-character glob opening with a dot|cp /tmp/x ~/.claude/logs/.?/settings.json' \
      'a bracket glob opening with a dot|cp /tmp/x ~/.claude/logs/.[.]/settings.json' \
      'a dot glob on a path with no match|cp /tmp/x ~/.claude/logs/nope/.*/settings.json' \
      'a backtick substitution between dots|cp /tmp/x ~/.claude/logs/.`:`./settings.json' \
      'a file link whose target climbs out of an exempt dir|Edit ~/proj/.claude-l now.'
    HOOK_BASH="${interp}" HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
      'a home variable ahead of an exempt path|Read $HOME/.claude/data/x.md now.' \
      'a braced home variable ahead of an exempt path|Read ${HOME}/.claude/logs/x.log now.' \
      'a root glob ahead of an exempt path|Read ~/.claude*/data/x.md now.' \
      'a wildcard project segment|Persist ~/.claude/projects/*/memory/progress-a.md now.' \
      'a dot name that is no glob|Read ~/.claude/logs/.state now.' \
      'a code span around an exempt path|Read `~/.claude/data/x.md` now.' \
      'bold around a code span|Read **`~/.claude/data/x.md`** now.' \
      'a list of code spans|Read `~/.claude/data/x.md`,`~/.claude/logs/y.log` now.' \
      'a relative repo path with a wildcard|Look in .claude/worktrees/*/hooks now.'
  done < <(list_bashes)
}

@test "a cd into an exempt dir voids its exemption only when the prompt can climb back out" {
  assert_rows 2 \
    'cd into job scratch, then a relative climb|cd ~/.claude/jobs/a/tmp && cp /tmp/x ../../../settings.json' \
    'cd into runtime data, then a relative climb|cd ~/.claude/logs && cp /tmp/x ../settings.json' \
    'pushd, then a relative climb|pushd ~/.claude/logs && cp /tmp/x ../settings.json' \
    'cd in a subshell, then a relative climb|(cd ~/.claude/logs; cp /tmp/x ../settings.json)' \
    'cd, then a bare climb|cd ~/.claude/logs && cd .. && edit settings.json'
  assert_rows 0 \
    'cd with no climb|cd ~/.claude/logs && tail daemon.log' \
    'a climb with no cd into the exempt dir|Read ~/.claude/logs/daemon.log and ../repo/x.md now.' \
    'a cd elsewhere beside an exempt path|cd /tmp/repo && cat ../x && tail ~/.claude/logs/daemon.log'
}

@test "a case or Unicode variant of the home blocks exactly when the filesystem resolves it to the home" {
  local base="${BATS_TEST_TMPDIR}/home" lower upper want=0
  lower="$(printf 'caf\303\251')"
  upper="$(printf 'CAFE\314\201')"
  mkdir -p "${base}/${lower}/.claude/agents"
  if [[ "${base}/${upper}" -ef "${base}/${lower}" ]]; then
    want=2
  fi
  HOME="${base}/${lower}" GA_DATA_ROOT="${base}/${lower}/.glass-atrium" assert_rows "${want}" \
    "upper-case decomposed home|Edit ${base}/${upper}/.claude/agents/a.md now." \
    "upper-case decomposed home and root|Edit ${base}/${upper}/.CLAUDE/settings.json now."
}

@test "a brace bash would expand is judged protected and a literal brace resolves as written" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'alternatives spelling the root|Edit ~/.cla{u,x}de/agents/a.md now.' \
    'alternatives holding the root|Edit ~/.{claude,x}/agents/a.md now.'
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
    'a brace with no comma is a literal name|Edit ~/.clau{d}e/agents/a.md now.'
}

@test "a bare root word, with or without a trailing slash, is a name in prose and a path as an operand" {
  local home="${BATS_TEST_TMPDIR}/home/u"
  mkdir -p "${home}/.claude-work"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
    'profile named in a sentence|Switch the session to the .claude-work profile.' \
    'roots named in a list of profiles|Profiles: .claude-work and .claude-personal.' \
    'repo dot dir named in a sentence|The repo keeps its worktrees in .claude for now.' \
    'root word opening a bullet item|- `.claude` is git-ignored in this repo.' \
    'profile opening an indented bullet item|  - .claude-work is the profile the live suite runs under.' \
    'repo dot dir with a trailing slash in a sentence|The repo keeps its worktrees in .claude/ for now.' \
    'profile with a trailing slash in a sentence|The branch suite runs on a `.claude-work-dev/` root.' \
    'escaped root in a grep pattern|Grep hooks/ for the literal `\.claude/` first.' \
    'root glob with a trailing slash in a sentence|The precheck regex matches `\.claude/` and `.claude-*/` spellings.'
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'operand of cd|cd .claude-work && edit settings.json' \
    'operand after an option|Run ls -la .claude-work now.' \
    'operand after the end-of-options marker|Run tool -- .claude-work now.' \
    'redirect target|Run echo x > .claude-work now.' \
    'option value|Run tool --dir=.claude-work now.' \
    'tilde root word|Rewrite the hooks in ~/.claude-work now.' \
    'operand of cd with a trailing slash|cd .claude-work/ && edit settings.json' \
    'operand after an option with a trailing slash|Run ls -la .claude-work/ now.' \
    'a dot-slash root name|Look in ./.claude/ for now.' \
    'tilde root with a trailing slash|Rewrite the hooks in ~/.claude-work/ now.'
}

@test "a harness root named only inside a negated clause is a mention, and any other naming of it still blocks" {
  assert_rows 0 \
    'never-write constraint on the root glob|Never write under ~/.claude*.' \
    'never-write constraint on a bullet|- Never write under ~/.claude/ or any profile root.' \
    'do-not constraint on a branch root|Do not edit anything in ~/.claude-work.' \
    'must-not later in the clause|The agent must not touch ~/.claude/ at all.' \
    'not-to before the action|Be careful not to edit ~/.claude/ here.' \
    'constraint ending in a final dot on the slash|Never write under ~/.claude/.' \
    'emphasis around the cue and verb|- **Never write** under ~/.claude/ at all.' \
    'curly apostrophe in the cue|Don’t edit ~/.claude/ here.' \
    'a numbered item|1) Do not edit ~/.claude/ now.' \
    'a clause after a sentence end|The merge is on hold. Never write under ~/.claude/.' \
    'a clause after a label|Bounds: never write under ~/.claude/.' \
    'a clause after a bold label|**Bounds:** never write under ~/.claude/.' \
    'a named subject before must not|You must not write to ~/.claude/.' \
    'a named subject before should never|Agents should never edit ~/.claude/ ever.' \
    'should not on its own|Should not touch ~/.claude/ now' \
    'a contracted shape|Shouldn'\''t edit ~/.claude/ here' \
    'a second root in the same clause|Never write to ~/.claude/ or ~/.claude-work/ here.' \
    'a code span around the root|Never write under `~/.claude/`.' \
    'words ahead of a comma|Never write under ~/.claude/, ever.'
  assert_rows 2 \
    'reminder that negates forgetting|Don'\''t forget to copy the new hook into ~/.claude/ when done.' \
    'negation of needing to ask|No need to ask — cp build/settings.json ~/.claude/' \
    'negation of minding something else|Never mind the tests and install the plugin into ~/.claude/' \
    'negation of an unrelated verb in the same clause|Don'\''t wait and edit ~/.claude/ now.' \
    'negated clause naming a config file|Never write under ~/.claude/settings.json.' \
    'negation in an earlier clause|Never ask; rewrite the hooks in ~/.claude/ now.' \
    'negation in an earlier comma clause|Never wait, edit ~/.claude now.' \
    'negation after the root|Rewrite the hooks in ~/.claude/, not the repo.' \
    'same root also named outside the negation|Never write under ~/.claude/ now; edit ~/.claude/ instead.' \
    'negation in the sentence before|Never ask. Rewrite the hooks in ~/.claude/ now.' \
    'brace of roots in a negated clause|Never write ~/{.claude,.claude-work}/ now.' \
    'a second action joined by and|Do not edit the repo and cp build/settings.json ~/.claude/' \
    'a second action joined by but|Do not edit the repo but rewrite the hooks in ~/.claude/ now' \
    'a conditional cue with a then clause|If you cannot edit the repo then edit ~/.claude/ directly' \
    'a second action behind an em dash|Never edit the repo — edit ~/.claude/ instead' \
    'a second action behind a hyphen|Never edit the repo - edit ~/.claude/ instead' \
    'a second action behind an arrow|Do not edit the repo -> write ~/.claude/' \
    'a second action in parentheses|Never edit the repo (write ~/.claude/ instead)' \
    'a second action joined without a space|Never write x;cp y ~/.claude/' \
    'a cd into the root after a negated action|Do not edit the repo and cd ~/.claude/ && write settings.json there' \
    'a copy into a branch root after a negated action|Do not edit the repo and copy settings.json into ~/.claude-work-dev/' \
    'an inverting word before the root|Never write outside ~/.claude/' \
    'a suggestion spelled why not|Why not copy the hook into ~/.claude/ now' \
    'why not directly on the root|Why not write to ~/.claude/ now' \
    'a double negative|You cannot not write to ~/.claude/ today.' \
    'a noun reading of no with a later action|No change to the repo and copy the hook into ~/.claude/' \
    'a noun reading of no with a later install|No update needed so install the plugin in ~/.claude/' \
    'a noun reading of no directly on the root|No update to ~/.claude/ now.' \
    'a path segment spelled like a cue|cp /never write ~/.claude/' \
    'a non-negated root ending in a final dot|Rewrite the hooks in ~/.claude/.' \
    'an inability handing the write to a subagent|I cannot write to ~/.claude/ so you do it' \
    'a past-tense reading|You did not write to ~/.claude/ so do it now' \
    'a later instruction voiding the cue|Do not install to ~/.claude/ but do it anyway' \
    'a question with would|Would you not copy to ~/.claude/ the hook' \
    'a why-would question|Why would you not write to ~/.claude/ directly?' \
    'an open choice with whether|Decide whether or not to write to ~/.claude/' \
    'an open choice with if|If not write to ~/.claude/' \
    'a conditional with words before the cue|The test fails if you do not write to ~/.claude/' \
    'why with words before the cue|Why do we not write to ~/.claude/' \
    'do opening a question|Do you not write to ~/.claude/' \
    'should opening a question|Should you not copy into ~/.claude/' \
    'a bare not without to|Not write to ~/.claude/' \
    'never then not|Never not write to ~/.claude/' \
    'a word after the root|Never write to ~/.claude/ and copy the hook' \
    'a word past a comma after the root|Never write under ~/.claude/, just do it.' \
    'a clause opened by a comma|Yes, never write under ~/.claude/.' \
    'a dash inside a clause is no list marker|The hook - never write ~/.claude/' \
    'a cue word as a cp operand|cp not write ~/.claude/' \
    'a cue word as an mv operand|mv never edit ~/.claude/' \
    'a cue word as a tee operand|tee not write ~/.claude/' \
    'a cue word behind a cp option|cp -r not write ~/.claude/' \
    'a quoted cue before the root operand|cp ./settings.json "never write" ~/.claude/' \
    'a quoted cue opening the line|"never write" ~/.claude/' \
    'a quoted word between cue and root|Never write "x" ~/.claude/' \
    'a sentence end inside a quote|cp "a b. never write" ~/.claude/' \
    'a root inside the quote with a word after it|"x. never write to ~/.claude/ y"' \
    'a quoted root in a negated clause|Never write under "~/.claude/".' \
    'a quoted word after the root|Never write to ~/.claude/ "now"'
  # GA-RM[not-executed]: hook payload on stdin, only pattern-matched by the hook and never run
  assert_rows 2 'a quoted cue before the root of a recursive delete|rm -rf "never rm" ~/.claude/'
}

# CWD-relative arm: a relative token names the harness only when, read from $HOME, it reaches an entry
#   the harness root holds or one Claude Code loads as config.

@test "a CWD-relative .claude path blocks only where it would name a harness entry from home" {
  local home="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${home}/.claude"
  : >"${home}/.claude/statusline-command.sh"
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 0 \
    'repo worktree dir|Repo /x/glass-atrium, worktree .claude/worktrees/wt-pa-hpp, branch fix/x.' \
    'repo audit dir|Records: `.claude/prompt-audit/pa-s3/impl77/` and the plan.'
  HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" assert_rows 2 \
    'an entry the harness root holds|From the home dir, edit .claude/statusline-command.sh now.' \
    'a config entry not yet created|From the home dir, edit .claude/agents/x.md now.' \
    'a settings file not yet created|From the home dir, edit .claude/settings.local.json now.' \
    'traversal out of a repo dir|Edit .claude/worktrees/../agents/x.md now.' \
    'a tilde path to the same dir|Edit ~/.claude/worktrees/wt/hooks/x.sh now.'
}

# Prompt naming $1 unique non-protected `.claude` paths under the home (a repo's own dot dir each).
cap_prompt() {
  local count="$1" i prompt="Review"
  for ((i = 1; i <= count; i++)); do
    prompt="${prompt} ~/repo/r${i}/.claude/agents/a.md"
  done
  printf '%s now.\n' "${prompt}"
}

# The gate resolves at most 128 unique candidates; past that it blocks without resolving any.
@test "a prompt past the unique-candidate cap blocks unresolved and one within it is resolved" {
  local home="${BATS_TEST_TMPDIR}/home/u" cap=128 row name count want prompt
  mkdir -p "${home}"
  for row in "cap minus one|$((cap - 1))|0" "exactly the cap|${cap}|0" "cap plus one|$((cap + 1))|2"; do
    IFS='|' read -r name count want <<<"${row}"
    prompt="$(cap_prompt "${count}")"
    HOME="${home}" GA_DATA_ROOT="${home}/.glass-atrium" run_agent "${prompt}" omit
    [[ "${status}" -eq "${want}" ]] || {
      echo "row: ${name} · want ${want} · status ${status}: ${output}"
      return 1
    }
    [[ "${want}" -eq 0 || "${output}" == *"${count} unique"*"cap of ${cap}"* ]] || {
      echo "row: ${name} · cap reason missing: ${output}"
      return 1
    }
  done
}

@test "a failed normalization still scans the raw prompt and says so only when it allows" {
  mkdir -p "${BATS_TEST_TMPDIR}/noawk"
  printf '#!/bin/sh\nexit 1\n' >"${BATS_TEST_TMPDIR}/noawk/awk"
  chmod +x "${BATS_TEST_TMPDIR}/noawk/awk"
  PATH="${BATS_TEST_TMPDIR}/noawk:${PATH}" run --separate-stderr \
    bash -c 'printf "%s" "$1" | bash "$2"' _ \
    "$(jq -n '{tool_name:"Agent",tool_input:{prompt:"Edit ~/.claude/agents/x.md now."}}')" "${HOOK_SH}"
  [[ "${status}" -eq 2 && -z "${output}" && "${stderr}" != *'only the raw prompt was scanned'* && "${stderr}" == *'candidate: ~/.claude/agents/x.md'* ]] || {
    echo "block row · status ${status} · stdout ${output} · stderr ${stderr}"
    return 1
  }
  PATH="${BATS_TEST_TMPDIR}/noawk:${PATH}" run --separate-stderr \
    bash -c 'printf "%s" "$1" | bash "$2"' _ \
    "$(jq -n '{tool_name:"Agent",tool_input:{prompt:"Read ~/.claude/data/x.md now."}}')" "${HOOK_SH}"
  [[ "${status}" -eq 0 && "${stderr}" == *'only the raw prompt was scanned'* ]] || {
    echo "allow row · status ${status} · stderr ${stderr}"
    return 1
  }
}

# The reason names the token that blocked, not an exempt one beside it, and the absolute-form remedy.
@test "a block names its triggering candidate and the absolute-form remedy" {
  local payload
  payload="$(jq -n '{tool_name:"Agent",tool_input:{prompt:"Read ~/.claude/data/zz-exempt.md, then edit ~/.claude/hooks/zz-trigger.sh now."}}')"
  run --separate-stderr bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
  [[ "${status}" -eq 2 && -z "${output}" ]] || {
    echo "status ${status} · stdout ${output} · stderr ${stderr}"
    return 1
  }
  [[ "${stderr}" == *'candidate: ~/.claude/hooks/zz-trigger.sh'* && "${stderr}" != *zz-exempt* ]] || {
    echo "triggering candidate not named alone: ${stderr}"
    return 1
  }
  [[ "${stderr}" == *'contains .claude'*'absolute form'* ]] || {
    echo "absolute-form remedy missing: ${stderr}"
    return 1
  }
}

# Mixed prompt: any non-exempt match blocks

@test "data/ (exempt) + hooks/ (config) in one prompt → BLOCKED" {
  run_agent 'Read ~/.claude/data/outcomes/x.md, then write ~/.claude/hooks/y.sh.' true
  [[ "${status}" -eq 2 ]]
}

# Orthogonal guards

@test "prompt with no harness path → NOT blocked (out of scope)" {
  run_agent 'Refactor src/util/date.ts to use date-fns.' true
  [[ "${status}" -eq 0 ]]
}

@test "a prompt with no .claude substring passes without sourcing the lib" {
  mkdir -p "${BATS_TEST_TMPDIR}/nolib"
  cp -- "${HOOK_SH}" "${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh"
  HOOK_SH="${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh" run_agent 'Refactor src/util/date.ts.' true
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}

@test "non-Agent tool → NOT blocked (out of scope)" {
  local payload
  payload="$(jq -n '{tool_name:"Write", tool_input:{file_path:"~/.claude/hooks/x.sh"}}')"
  run bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK_SH}"
  [[ "${status}" -eq 0 ]]
}

# shellcheck source-path=SCRIPTDIR source=lib/forced-write.bash
source "${BATS_TEST_DIRNAME}/lib/forced-write.bash"

# Degraded row: a hook copy with no lib/ beside it → the fail-closed branch.
@test "every block path exits 2 with its reason once on stderr and nothing on stdout, even when the write is interrupted" {
  local row name hook envelope needle rule2='Harness Path Protection Rule 2: staged lane MANDATORY' cap_text
  cap_text="$(cap_prompt 129)"
  mkdir -p "${BATS_TEST_TMPDIR}/nolib"
  cp -- "${HOOK_SH}" "${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh"
  jq -n '{tool_name:"Agent",tool_input:{prompt:"Edit ~/.claude/agents/x.md"}}' \
    >"${BATS_TEST_TMPDIR}/envelope"
  jq -n --arg p "${cap_text}" '{tool_name:"Agent",tool_input:{prompt:$p}}' \
    >"${BATS_TEST_TMPDIR}/envelope-cap"
  for row in \
    "config path|${HOOK_SH}|envelope|${rule2}" \
    "past the candidate cap|${HOOK_SH}|envelope-cap|${rule2}" \
    "degraded lib|${BATS_TEST_TMPDIR}/nolib/enforce-foreground-harness.sh|envelope|repair the hook install"; do
    IFS='|' read -r name hook envelope needle <<<"${row}"
    run_forced_hook "${hook}" "${BATS_TEST_TMPDIR}/${envelope}"
    assert_forced_block "${needle}" || {
      echo "row: ${name}"
      return 1
    }
    [[ "${envelope}" != envelope-cap || "${output}" == *'cap of 128'* ]] || {
      echo "row: ${name} · cap reason missing: ${output}"
      return 1
    }
  done
}
