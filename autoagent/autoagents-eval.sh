#!/bin/bash
# autoagents-eval.sh — agent-instruction regression eval (5-point scale)
# Modes:
#   (1) default (manual): regression-eval uncommitted .md changes → verdict logged, no commit
#   (2) --unstaged <file>: runner.js flow — eval one uncommitted file; never rollback/commit
#       → emits RESULT: PASS|FAIL on stdout, exit 0/1
#   (3) --post-commit <file>: legacy-compat alias

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
    numstat=$(cd "$AGENTS_DIR" && git diff --numstat -- "$file" 2>/dev/null || true)
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
  echo "$issues_text" | grep -qi "section" && echo "DIAG-FIX: section → Restore from git HEAD"
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
  elif git diff --quiet -- "$POST_COMMIT_FILE" 2>/dev/null; then
    log "warn: no unstaged diff on ${POST_COMMIT_FILE} (committed or unchanged)"
  else
    log "unstaged diff confirmed — ${POST_COMMIT_FILE}"
  fi
  log "single-file eval mode — ${FILE_LIST}"
else
  # unstaged + untracked .md files (archive/ excluded)
  # D(staged or worktree deletion) excluded: eval LLM cannot read deleted files -> false-positive FAIL
  CHANGED=$(git status --porcelain -- '*.md' 2>/dev/null | grep -E '^\s*[MAR\?]' | grep -v '^.D' | grep -v 'archive/' || true)

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

# ── 2. run regression eval via claude -p ────────────────────────

EVAL_PROMPT="You are reviewing agent instruction files in ~/.claude/agents/.

You must read GLASS_ATRIUM_GLOBAL_RULES.md first, then read every changed file in ${FILE_LIST}.
Do not guess. If a file cannot be read, treat that as FAIL.

Evaluate each file on these 5 checks:
1. Consistency with GLASS_ATRIUM_GLOBAL_RULES.md
2. No role boundary violations between agents
3. Required sections present exactly: Goal, Guardrails, Prohibitions
4. skills array matches the agent group (DEV / QA / non-DEV)
5. All instruction content is written in English only

FAIL conditions:
- Any one of the 5 checks fails for any file
- GLASS_ATRIUM_GLOBAL_RULES.md or any target file is not readable
- The agent group cannot be determined confidently
- The skills array is missing or ambiguous
- A required section heading is missing exactly as written
- Korean text appears anywhere in agent instructions except file paths, code, or proper nouns

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
  --model claude-sonnet-4-6 \
  --setting-sources project,local \
  --tools "Read,Glob,Grep" \
  --permission-mode bypassPermissions \
  --max-budget-usd 2.00 \
  --output-format text \
  "$EVAL_PROMPT" 2>/dev/null | sed '/^{$/,/^}$/d' || echo "EVAL_ERROR")

log "eval result: $(echo "$EVAL_RESULT" | head -5)"

# ── 3. post-commit mode: emit eval result on stdout then exit ─
if [ "$POST_COMMIT_MODE" -eq 1 ]; then
  if echo "$EVAL_RESULT" | grep -q "EVAL_ERROR"; then
    echo "RESULT: FAIL"
    echo "REASON: claude -p execution failed"
    log "post-commit FAIL (claude execution failed)"
    exit 1
  fi
  # On PASS, grep -v filters everything → exit 1; guard so pipefail+set -e don't silently kill the script
  ISSUES_LINES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:\|^$' | head -10 || true)
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
    log "post-commit FAIL — $(echo "$DIAGNOSIS" | grep RECOMMENDATION || true)"
    exit 1
  fi
fi

# ── 4. default mode: verdict + commit/report ──────────────────

if echo "$EVAL_RESULT" | grep -q "EVAL_ERROR"; then
  log "claude -p execution failed"
  exit 1
fi

# PASS when "RESULT: PASS" or ISSUES is effectively empty
ISSUES_LINES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:\|^$' | head -10 || true)
if echo "$EVAL_RESULT" | grep -qi "RESULT: PASS" || [ -z "$ISSUES_LINES" ]; then
  # pass → no commit (user manual-commit policy)
  log "PASS — awaiting commit (manual policy)"
  exit 0

else
  # fail → diagnose + log, await approval
  ISSUES=$(echo "$EVAL_RESULT" | sed -n '/^ISSUES:/,$p' | tail -n +2 | grep -v '^SUMMARY:\|^FILES_CHECKED:\|^RESULT:' | head -15)
  DIAGNOSIS=$(diagnose_failure "$FILE_LIST" "$ISSUES")
  log "FAIL — awaiting approval — $(echo "$DIAGNOSIS" | grep RECOMMENDATION || true)"
  exit 1
fi
