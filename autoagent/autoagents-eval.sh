#!/bin/bash
# autoagents-eval.sh — agent-instruction regression eval (5-point scale)
# Modes:
#   (1) default (manual): regression-eval uncommitted .md changes → verdict logged, no commit
#   (2) --unstaged <file>: runner.js flow — eval one uncommitted file; never rollback/commit
#       → emits RESULT: PASS|FAIL on stdout, exit 0/1
#   (3) --post-commit <file>: legacy-compat alias
# Exit codes (autoagents-eval.sh-scoped; daemon-apply.sh owns a different 4/5):
#   0 = PASS or nothing to eval · 1 = FAIL (eval verdict, preflight, or claude run)
#   4 = claude binary not found · 5 = git status failed on the default-mode scan
#
# why this arg combo (the headless `claude -p` eval invocation further below) — plan pin E1:
#   --tools "Read,Glob,Grep" → Write-less by design: a read-only eval needs no write tool
#   cwd "$AGENTS_DIR" → an OWNED dir, never /tmp: --setting-sources project,local resolves against cwd
#   a world-writable cwd would let any local user plant .claude settings into the run — vector absent here
#   --permission-mode bypassPermissions → accepted: it unloads the hook layer
#   residual risk stays bounded by the Write-less read-only tool set above
#   headless cron has no user to answer a permission prompt, so a prompt-stall is the worse failure

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

AGENTS_DIR="$HOME/.claude/agents"

# claude CLI resolution: AUTOAGENTS_EVAL_CLAUDE_BIN (Bats/CI stub override) →
# PATH → Homebrew Apple Silicon → Homebrew Intel. Mirrors daemon-cycle.sh's
# fallback chain — portable across runners that lack /opt/homebrew on PATH.
# Loud-fail with the same exit 4 ("claude binary not found") as siblings.
if [ -n "${AUTOAGENTS_EVAL_CLAUDE_BIN:-}" ]; then
  CLAUDE="$AUTOAGENTS_EVAL_CLAUDE_BIN"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE="$(command -v claude)"
elif [ -x /opt/homebrew/bin/claude ]; then
  CLAUDE="/opt/homebrew/bin/claude"
elif [ -x /usr/local/bin/claude ]; then
  CLAUDE="/usr/local/bin/claude"
else
  echo "[autoagents-eval] FATAL: claude binary not found (AUTOAGENTS_EVAL_CLAUDE_BIN, PATH, /opt/homebrew/bin, /usr/local/bin)" >&2
  exit 4
fi

LOG_FILE="/tmp/autoagents-eval-$(date +%Y-%m-%d).log"

log() { echo "[$(date +%H:%M:%S)] $1" >> "$LOG_FILE"; }

diagnose_failure() {
  local file_list="$1" issues_text="$2"
  local delta_pct=0 delta_class="minimal_delta" recommendation="FIX_AND_RETRY"
  for raw_file in $(echo "$file_list" | tr ',' '\n'); do
    local file
    file=$(echo "$raw_file" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$file" ] && continue
    local filepath="${AGENTS_DIR}/${file}"
    [ ! -f "$filepath" ] && continue
    local total_lines
    total_lines=$(wc -l < "$filepath" | tr -d ' ')
    [ "$total_lines" -eq 0 ] && total_lines=1
    local numstat
    numstat=$(cd "$AGENTS_DIR" && git diff --numstat -- "$file" 2>/dev/null || true) # GA-ABSORB[handled@empty-numstat-continue-guard-next-line]: no diff is data — the guard skips the file
    [ -z "$numstat" ] && continue
    local added removed
    added=$(echo "$numstat" | awk '{print $1}')
    removed=$(echo "$numstat" | awk '{print $2}')
    [ "$added" = "-" ] && continue
    local changed=$((added + removed))
    delta_pct=$((changed * 100 / total_lines))
    [ "$delta_pct" -gt 20 ] && delta_class="major_rewrite"
    echo "DIAG: ${file} — +${added}/-${removed} (${delta_pct}% delta) → ${delta_class}"
  done
  echo "$issues_text" | grep -qi "Korean" && echo "DIAG-FIX: language → Translate to English"
  echo "$issues_text" | grep -qi "frontmatter\|YAML" && echo "DIAG-FIX: YAML → Fix structure"
  [ "$delta_class" = "major_rewrite" ] && recommendation="ROLLBACK"
  echo "RECOMMENDATION: ${recommendation}"
}

POST_COMMIT_MODE=0
POST_COMMIT_FILE=""
# --post-commit <file>: legacy-compat (evals an already-committed file)
# --unstaged <file>:    runner.js flow — evals uncommitted (unstaged) changes
if { [ "${1:-}" = "--post-commit" ] || [ "${1:-}" = "--unstaged" ]; } && [ -n "${2:-}" ]; then
  POST_COMMIT_MODE=1
  POST_COMMIT_FILE="$2"
fi

cd "$AGENTS_DIR"

if [ "$POST_COMMIT_MODE" -eq 1 ]; then
  FILE_LIST="$POST_COMMIT_FILE"
  FILE_COUNT=1
  # Branch on tracked status first (untracked new files are valid targets too)
  if ! git ls-files --error-unmatch -- "$POST_COMMIT_FILE" >/dev/null 2>&1; then
    log "untracked new file confirmed — ${POST_COMMIT_FILE}"
  elif git diff --quiet -- "$POST_COMMIT_FILE" 2>/dev/null; then # GA-ABSORB[handled@post-commit-if-elif-else-chain]: exit status IS the branch selector; every branch logs
    log "warn: no unstaged diff on ${POST_COMMIT_FILE} (committed or unchanged)"
  else
    log "unstaged diff confirmed — ${POST_COMMIT_FILE}"
  fi
  log "single-file eval mode — ${FILE_LIST}"
else
  # unstaged + untracked .md files (archive/ excluded)
  # D(staged or worktree deletion) excluded: eval LLM cannot read deleted files -> false-positive FAIL
  # git is split OUT of the filter pipeline: under pipefail a substitution reports the RIGHTMOST
  # status, so a trailing grep no-match (1) and a git failure (128) both collapsed into the same
  # empty string and the same affirmative-false "no changes" success below.
  GIT_ERR_FILE="$(mktemp)"
  trap 'rm -f "${GIT_ERR_FILE}"' EXIT
  GIT_RC=0
  GIT_OUT="$(git status --porcelain -- '*.md' 2>"${GIT_ERR_FILE}")" || GIT_RC=$?
  GIT_ERR_TEXT="$(cat "${GIT_ERR_FILE}")"
  if [[ "${GIT_RC}" -ne 0 ]]; then # GA-CONVERTED: git-status failure loud-fails (captured git stderr + named exit 5) instead of collapsing into the empty no-changes path
    printf '%s\n' "[autoagents-eval] FATAL: git status failed (exit ${GIT_RC}) in ${AGENTS_DIR}" >&2
    if [[ -n "${GIT_ERR_TEXT}" ]]; then
      printf '%s\n' "${GIT_ERR_TEXT}" >&2
    fi
    log "FATAL: git status failed (exit ${GIT_RC}) — ${GIT_ERR_TEXT}"
    exit 5
  fi
  CHANGED=$(printf '%s\n' "${GIT_OUT}" | grep -E '^\s*[MAR\?]' | grep -v '^.D' | grep -v 'archive/' || true) # GA-ABSORB[benign]: grep exit 1 = no match — zero rows is data

  if [ -z "$CHANGED" ]; then
    log "no changes — exit"
    exit 0
  fi

  FILE_LIST=$(echo "$CHANGED" | awk '{print $NF}' | tr '\n' ', ' | sed 's/,$//')
  FILE_COUNT=$(echo "$CHANGED" | wc -l | tr -d ' ')
fi

log "changes detected: ${FILE_COUNT} — ${FILE_LIST}"

# ── 1.5 LLM preflight ──────────────────────────────
# shellcheck source=/dev/null
source "$HOME/.glass-atrium/scripts/llm-preflight.sh"
PREFLIGHT_REASON=$(llm_preflight 10.00) || {
  log "LLM preflight failed: $PREFLIGHT_REASON"
  echo "RESULT: FAIL"
  echo "REASON: LLM preflight failed — $PREFLIGHT_REASON"
  exit 1
}
log "LLM preflight passed"

# Background-worker model id from the daemon-config.json SoT, via atrium_resolve_worker_model
# (lib/atrium-config.sh) — the same resolver every other daemon path uses. Sourced explicitly
# rather than leaning on llm-preflight.sh's own source of it: that script's contract is a cost
# gate, not a model provider. DAEMON_CONFIG override hook → canonical default when empty.
# shellcheck source=/dev/null
source "$HOME/.glass-atrium/scripts/lib/atrium-config.sh"
WORKER_MODEL="$(atrium_resolve_worker_model "${DAEMON_CONFIG:-}")"
log "eval model resolved: ${WORKER_MODEL}"

# ── 2. run regression eval via claude -p ────────────────────────

EVAL_PROMPT="You are reviewing agent instruction files in ~/.claude/agents/.

You must read GLASS_ATRIUM_GLOBAL_RULES.md first, then read every changed file in ${FILE_LIST}.
Do not guess. If a file cannot be read, treat that as FAIL.

Evaluate each file on these 5 checks:
1. Consistency with GLASS_ATRIUM_GLOBAL_RULES.md
2. No role boundary violations between agents
3. Frontmatter is valid YAML and carries both name and description
4. A skills key, where the file carries one, is a well-formed list
5. Instruction content is written in English, outside the carve-outs named below

A changed file is an agent instruction file only when it opens with a YAML frontmatter
block carrying a name key. Checks 3 and 4 apply to those files alone — a shared rule doc,
a reference or a template under the same directory is still checked on 1, 2 and 5.

Body section headings are a ceiling, not a floor. Do not require any heading to
be present, and do not fail a file for a heading another agent file happens to carry.

FAIL conditions:
- Any one of the 5 checks fails for any file
- GLASS_ATRIUM_GLOBAL_RULES.md or any target file is not readable
- Frontmatter is unparseable, or name or description is absent
- A skills key is present but is not a well-formed list
- Korean text appears outside the carve-outs of the Output Language rule you read in
  GLASS_ATRIUM_GLOBAL_RULES.md. Read that list there and apply it as written — it is
  wider than \"file paths and proper nouns\", and it exempts text the file REPRODUCES
  rather than authors. Never flag against a paraphrase of it.

When checking role boundary violations:
- Mark FAIL only for explicit responsibility overlap, explicit instruction conflict, or explicit scope leakage
- Do not fail based on weak implication alone

Output format rules:
- Start with exactly one line: RESULT: PASS or RESULT: FAIL
- Second line: FILES_CHECKED: comma-separated list
- Third line onward: ISSUES:
- Final line: SUMMARY:
- If PASS, write \"None\" after ISSUES:
- All descriptions, issues, and summary must be written in English
- Do not include any preamble before RESULT"

# Telemetry + debug output suppressed; stdout only captured.
# Bare-harness pattern: minimal Read/Glob/Grep tool whitelist (read-only eval — no Write/Edit/Bash needed).
# --setting-sources project,local: load agents-dir project rules so eval has GLASS_ATRIUM_GLOBAL_RULES.md context.
EVAL_RESULT=$(OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none CLAUDE_CODE_ENABLE_TELEMETRY=0 \
  "$CLAUDE" -p \
  --model "$WORKER_MODEL" \
  --setting-sources project,local \
  --tools "Read,Glob,Grep" \
  --permission-mode bypassPermissions \
  --max-budget-usd 2.00 \
  --output-format text \
  "$EVAL_PROMPT" 2>/dev/null | sed '/^{$/,/^}$/d' || echo "EVAL_ERROR") # GA-ABSORB[handled@EVAL_ERROR-sentinel-branch]: a failed run yields the sentinel that the branch below turns into RESULT: FAIL

log "eval result: $(echo "$EVAL_RESULT" | head -5)"

# ── 3. post-commit mode: emit eval result on stdout then exit ─
if [ "$POST_COMMIT_MODE" -eq 1 ]; then
  if echo "$EVAL_RESULT" | grep -q "EVAL_ERROR"; then
    echo "RESULT: FAIL"
    echo "REASON: claude -p execution failed"
    log "post-commit FAIL (claude execution failed)"
    exit 1
  fi
  ISSUES_LINES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:\|^$' | head -10 || true) # GA-ABSORB[handled@empty-ISSUES_LINES-PASS-branch]: on PASS grep -v filters everything → exit 1; the -z test on the next line is the real signal
  if echo "$EVAL_RESULT" | grep -qi "RESULT: PASS" || [ -z "$ISSUES_LINES" ]; then
    echo "RESULT: PASS"
    SUMMARY=$(echo "$EVAL_RESULT" | sed -n 's/^SUMMARY:[[:space:]]*//p' | head -1)
    [ -n "$SUMMARY" ] && echo "SUMMARY: $SUMMARY"
    log "post-commit PASS"
    exit 0
  else
    ISSUES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:' | head -15)
    DIAGNOSIS=$(diagnose_failure "$FILE_LIST" "$ISSUES")
    echo "RESULT: FAIL"
    echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | head -20
    if [ -n "$DIAGNOSIS" ]; then
      echo ""
      echo "DIAGNOSIS:"
      echo "$DIAGNOSIS"
    fi
    log "post-commit FAIL — $(echo "$DIAGNOSIS" | grep RECOMMENDATION || true)" # GA-ABSORB[benign]: a missing RECOMMENDATION line degrades the message only — exit 1 fires regardless
    exit 1
  fi
fi

# ── 4. default mode: verdict + commit/report ──────────────────

if echo "$EVAL_RESULT" | grep -q "EVAL_ERROR"; then
  log "claude -p execution failed"
  exit 1
fi

# PASS when "RESULT: PASS" or ISSUES is effectively empty
ISSUES_LINES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:\|^$' | head -10 || true) # GA-ABSORB[handled@empty-ISSUES_LINES-PASS-branch]: on PASS grep -v filters everything → exit 1; the -z test on the next line is the real signal
if echo "$EVAL_RESULT" | grep -qi "RESULT: PASS" || [ -z "$ISSUES_LINES" ]; then
  # pass → no commit (user manual-commit policy)
  log "PASS — awaiting commit (manual policy)"
  exit 0

else
  # fail → diagnose + log, await approval
  ISSUES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:' | head -15)
  DIAGNOSIS=$(diagnose_failure "$FILE_LIST" "$ISSUES")
  log "FAIL — awaiting approval — $(echo "$DIAGNOSIS" | grep RECOMMENDATION || true)" # GA-ABSORB[benign]: a missing RECOMMENDATION line degrades the message only — exit 1 fires regardless
  exit 1
fi
