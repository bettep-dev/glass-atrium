#!/usr/bin/env bash
# inject-scope-rules.sh — SubagentStart hook: inject scope-rule cores + a budget
# meter + the [COMPLETION] emit-format contract into subagents.
#
# On a DEV(13)/QA(2) spawn, extracts the AGENT-INJECT block from
# shared-comment-logging.md and delivers it as hookSpecificOutput.additionalContext
# (the subagent otherwise gets only the comment-logging pointer token, not the body).
# DEV(13) ONLY (excludes QA) also gets two blocks from
# scope-dev.md — STYLE-REF (style_ref DEV-scoped; the pointer token alone left it
# ~0% emitted) and MINIMALISM (the DEV-scoped minimalism reflex the pointer did not
# deliver). The NAMING block (glass-atrium-dev-naming
# SKILL.md) goes to the 13 agents whose frontmatter declares that skill — DEV(12,
# excl dev-swift) + qa-code-reviewer (the enforcement surface). Its NAMING_AGENTS
# roster is DELIBERATELY narrower than INJECT_AGENTS (no qa-debugger, no dev-swift)
# and is AUTO-RECONCILED by agent_lifecycle inject_sync as a 4th tracked array — a
# new DEV agent is wired into naming injection automatically.
#
# Two NON-DROPPABLE universal blocks (ALL subagents, not DEV/QA-scoped), INDEPENDENT
# of each other and of the scope blocks:
#   * [COMPLETION] emit-format (ALWAYS-ON, assembled FIRST — the PRIMARY fix):
#     schema-mode/workflow spawns emit the block as a SINGLE inline line, which
#     track-outcome.sh (anchors every parse tier on a newline after the tag) matches
#     no tier → fields discarded → outcome synthesized (done_with_concerns/low).
#     Delivered to EVERY agent_type, INDEPENDENT of SUBAGENT_BUDGET_METER_OFF +
#     maxTurns; FIRST so it survives the ~2KB preview.
#   * Budget-meter (subagents with a maxTurns frontmatter): a subagent has NO runtime
#     turn meter, so the "stop at ~80% of maxTurns" rule is dead text — it runs to the
#     hard-cap, dies mid-tool-use → no [COMPLETION] → orchestrator SendMessage-recover.
#     This block supplies the meter (maxTurns N + checkpoint-at-80%).
#
# fail-open: SubagentStart cannot block; every failure (file/marker/jq absent, empty
# extraction) → exit 0 + 1 stderr diagnostic, injecting whatever IS available (a
# missing block must NOT suppress the others).

set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# fail-open ERR trap — no internal error must break subagent spawn.
trap 'printf "[inject-scope-rules] internal error at line %d: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Instant kill switch for the budget-meter block ONLY (scope-rule injection unaffected):
# non-empty suppresses the meter without removing the hook — the meter is the newest,
# least-proven block, so an operator may want it off while keeping the rest live.
SUBAGENT_BUDGET_METER_OFF="${SUBAGENT_BUDGET_METER_OFF:-}"

# Agents-dir root — frontmatter source for the maxTurns lookup. Env-overridable for the Bats
# sandbox (the test points it at a fixture dir). Canonical SoT root = ~/.glass-atrium/agents.
readonly AGENTS_DIR="${INJECT_SCOPE_RULES_AGENTS_DIR:-${HOME}/.glass-atrium/agents}"

# Comment-logging source rule file — env-overridable (test fail-open branch). scoped/ is
# consumed IN PLACE from ~/.glass-atrium/scoped (not the ~/.claude farm), so the DEFAULT
# constant carries the new path (these client-fired hooks have no env block).
readonly SRC_FILE="${INJECT_SCOPE_RULES_SRC:-${HOME}/.glass-atrium/scoped/shared-comment-logging.md}"

# style_ref source rule file — DEV-only injection; same env-override + ~/.glass-atrium/scoped default.
readonly STYLEREF_SRC_FILE="${INJECT_SCOPE_RULES_STYLEREF_SRC:-${HOME}/.glass-atrium/scoped/scope-dev.md}"

# naming source SKILL file — DEV(12)+qa-code-reviewer. UNLIKE SRC_FILE/STYLEREF_SRC_FILE
# (relocated to ~/.glass-atrium/scoped), skills STAY FARMED into ~/.claude/skills, so this
# default keeps that path (a symlink into the canonical ~/.glass-atrium store).
readonly NAMING_SRC_FILE="${INJECT_SCOPE_RULES_NAMING_SRC:-${HOME}/.claude/skills/glass-atrium-dev-naming/SKILL.md}"

# Comment-logging AGENT-INJECT block boundaries — literal anchors (stable across file edits).
readonly MARKER_START='<!-- AGENT-INJECT:START -->'
readonly MARKER_END='<!-- AGENT-INJECT:END -->'

# style_ref AGENT-INJECT block boundaries — DISTINCT marker name so the two blocks never collide.
readonly STYLEREF_MARKER_START='<!-- AGENT-INJECT:STYLE-REF:START -->'
readonly STYLEREF_MARKER_END='<!-- AGENT-INJECT:STYLE-REF:END -->'

# minimalism AGENT-INJECT block boundaries — DISTINCT marker name so the blocks never collide.
readonly MINIMALISM_MARKER_START='<!-- AGENT-INJECT:MINIMALISM:START -->'
readonly MINIMALISM_MARKER_END='<!-- AGENT-INJECT:MINIMALISM:END -->'

# naming AGENT-INJECT block boundaries — DISTINCT marker name (NEVER the plain AGENT-INJECT marker;
# that sed-range would collide with the comment-logging block).
readonly NAMING_MARKER_START='<!-- AGENT-INJECT:NAMING:START -->'
readonly NAMING_MARKER_END='<!-- AGENT-INJECT:NAMING:END -->'

# Comment-logging scope-match — DEV + QA (core-compliance-matrix.md Scope Legend SoT).
# Space-padded to block partial matches. Update when DEV/QA agents are added.
readonly INJECT_AGENTS=" glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-qa-code-reviewer glass-atrium-qa-debugger glass-atrium-dev-swift "

# style_ref scope-match — DEV ONLY (style_ref is DEV-scoped; QA excluded). Space-padded.
readonly STYLEREF_AGENTS=" glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-dev-swift "

# minimalism scope-match — DEV ONLY (minimalism reflex is DEV-scoped; QA excluded). Space-padded.
readonly MINIMALISM_AGENTS=" glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-dev-swift "

# naming scope-match — the 13 agents whose frontmatter declares glass-atrium-dev-naming:
# DEV(12, EXCLUDING dev-swift) + qa-code-reviewer. Space-padded. DELIBERATELY NOT
# INJECT_AGENTS, which wrongly adds qa-debugger + dev-swift (neither declares the skill,
# frontmatter-verified). AUTO-RECONCILED by agent_lifecycle inject_sync as a 4th tracked
# array via a dedicated predicate (dev_roster − {dev-swift} ∪ {qa-code-reviewer}) — a new
# DEV agent is wired in automatically.
readonly NAMING_AGENTS=" glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-qa-code-reviewer "

# Universal byte ceiling for the assembled additionalContext (byte-accurate via wc -c).
# WHY: the engine persists any SubagentStart additionalContext larger than ~10KB (10240
# bytes) to a file and delivers only a ~2KB preview — so an oversized assembly silently
# strips the meter (the exact failure this hook repairs). 8192 stays clear of the 10KB
# trigger, and the ~800B meter fits even the 2KB preview, so meter delivery holds in every
# degradation mode. UNIVERSAL: the envelope carries no spawn-mode discriminator, so
# engine/schema-mode spawns are bounded identically to manual ones.
readonly INJECT_CTX_MAX_BYTES=8192

INPUT="$(hook_read_input)"
[[ "${INPUT}" == "{}" ]] && exit 0

AGENT_TYPE="$(hook_get_field "${INPUT}" "agent_type")"
[[ -z "${AGENT_TYPE}" ]] && exit 0

# Absent jq = system misconfiguration — fail-open.
if ! command -v jq >/dev/null 2>&1; then
  printf '[inject-scope-rules] jq not found on PATH; skipping injection (agent=%s)\n' "${AGENT_TYPE}" >&2
  exit 0
fi

# Extract a marked block from a rule file, dropping the two marker lines (must not reach the
# child). sed range + grep -vxF (not awk flag-range) for BSD/GNU portability. Empty on any
# failure (file/markers absent) — the caller treats empty as "block unavailable", not an error.
# Args: $1=src_file $2=marker_start $3=marker_end · stdout: block text (may be empty).
extract_block() {
  local src="${1}" start="${2}" end="${3}"
  [[ -f "${src}" ]] || return 0
  sed -n "/${start}/,/${end}/p" "${src}" 2>/dev/null \
    | grep -vxF "${start}" | grep -vxF "${end}" || true
}

# Extract a droppable scope block WHEN AGENT_TYPE is in the roster, emitting one fail-open
# diagnostic on an empty extraction (markers/file absent). Consolidates the four scope-block
# sites; blocks stay independent — an empty one self-skips (a non-matching roster yields empty
# with no diagnostic). Args: $1=roster $2=src_file $3=marker_start $4=marker_end $5=label.
extract_scope_block() {
  local roster="${1}" src="${2}" start="${3}" end="${4}" label="${5}" block=""
  if [[ "${roster}" == *" ${AGENT_TYPE} "* ]]; then
    block="$(extract_block "${src}" "${start}" "${end}")"
    if [[ -z "${block}" ]]; then
      printf '[inject-scope-rules] %s block empty or markers absent in %s (agent=%s)\n' "${label}" "${src}" "${AGENT_TYPE}" >&2
    fi
  fi
  printf '%s' "${block}"
}

# Read the maxTurns integer from an agent's frontmatter. fail-open: un-derivable agent_type,
# file absent, or field missing/non-integer → empty stdout (caller treats empty as "no meter").
# agent_type is sanitized to a path-safe basename before interpolation (LLM01 — the SubagentStart
# envelope is external payload; a forged agent_type must not escape AGENTS_DIR via "../").
# Args: $1=agent_type · stdout: maxTurns integer (may be empty).
read_max_turns() {
  local agent_type="${1}" safe_type frontmatter_file raw
  safe_type="$(hook_path_safe_key "${agent_type}")"
  [[ -z "${safe_type}" ]] && return 0
  frontmatter_file="${AGENTS_DIR}/${safe_type}.md"
  [[ -f "${frontmatter_file}" ]] || return 0
  # First maxTurns: line only; strip the value to digits (rejects a non-integer frontmatter value).
  raw="$(grep -m1 '^maxTurns:' "${frontmatter_file}" 2>/dev/null | tr -cd '0-9' || true)"
  [[ -z "${raw}" ]] && return 0
  printf '%s\n' "${raw}"
}

# Build the budget-meter advisory for a known maxTurns budget. The 80%-checkpoint figure is
# the documented working-ceiling (GLOBAL_RULES Turn Budget & Graceful Exit), stated in TURNS
# (maxTurns is a turn cap, not a tool_use cap) — the meter the agent otherwise lacks at runtime.
# Args: $1=max_turns (integer) · stdout: the meter block text.
build_meter_block() {
  local max_turns="${1}" ceiling=0
  # 80% working ceiling, integer floor (e.g. 40→32, 25→20, 3→2). max_turns is already digit-
  # stripped to a non-empty positive integer by read_max_turns; ceiling is default-initialized
  # above so no arithmetic edge leaves it unbound under set -u. Force base-10: a leading-zero
  # value like 040 re-reads as OCTAL under a bare $(( 040 )); 10# keeps it decimal (consistency
  # with advisory-subagent-budget.sh).
  ceiling=$((10#${max_turns} * 8 / 10))
  printf '%s\n' \
    "**Turn-budget meter (auto-injected · GLOBAL_RULES Turn Budget & Graceful Exit)**" \
    "- Your maxTurns hard cap is ${max_turns} TURNS (a TURN cap, not a tool_use cap). The hard cap kills you mid-tool-use → no [COMPLETION] block → costly orchestrator recovery." \
    "- Working ceiling = ${ceiling} turns (80% of cap). As you APPROACH ${ceiling}: STOP, do NOT push to the hard cap." \
    "- On approach: finish the current write to a valid state (no partial files), checkpoint done/remaining to memory/progress-{task}.md, then emit a terminal [COMPLETION] block with result: needs_context and a 1-line resume point in summary. (schema-mode/workflow agents: STILL call StructuredOutput as the terminal action even on a needs_context exit — print this [COMPLETION] block first, then emit StructuredOutput; ending on the prose block alone throws.)" \
    "- Splitting > truncation: a clean needs_context handoff resumes cleanly; a hard-cap kill does not."
}

# Build the always-on [COMPLETION] emit-format directive. Static text (no args) for EVERY
# subagent, INDEPENDENT of SUBAGENT_BUDGET_METER_OFF + maxTurns (NOT folded into build_meter_block
# / read_max_turns, whose kill-switch + maxTurns coupling would leave workflow subagents
# uncovered). WHY: schema-mode spawns emit the block as a SINGLE inline line, which the recorder
# (parse tiers anchored on a newline after the tag) cannot match → fields discarded → synthesized.
# This delivers the strict multi-line contract the recorder can parse. stdout: block text.
build_emit_format_block() {
  printf '%s\n' \
    "**[COMPLETION] emit format (auto-injected · REQUIRED by the outcome recorder)**" \
    "- Print the [COMPLETION] block MULTI-LINE: the [COMPLETION] tag ALONE on its own line, EACH field (result / task_type / metric_pass / confidence / summary / …) on its OWN line, closed by a [/COMPLETION] sentinel ALONE on its own line." \
    "- The single-line inline form ([COMPLETION] k: v | k: v | …, all fields on ONE line) is DISCARDED by the recorder — its fields are lost and the outcome is synthesized as done_with_concerns / confidence=low. Schema-mode / workflow (ultracode) spawns MUST use the multi-line form." \
    "- SCHEMA-MODE / WORKFLOW (ultracode) agents: your StructuredOutput call IS the terminal deliverable — you MUST call StructuredOutput as the LAST action. Print this multi-line [COMPLETION] block as a dedicated text turn IMMEDIATELY BEFORE the StructuredOutput call (print-block-then-emit). Do NOT treat printing the prose [COMPLETION] block as \"done\" and stop — a schema-mode run that ends without calling StructuredOutput is a hard engine error (the run throws), not a graceful finish."
}

# Byte length of a string (wc -c counts bytes, locale-independent); tr strips BSD wc's leading
# whitespace to a bare integer. Used to enforce INJECT_CTX_MAX_BYTES byte-accurately.
# Args: $1=string · stdout: byte count integer.
byte_len() {
  printf '%s' "${1}" | wc -c | tr -cd '0-9'
}

# Join two context fragments with a blank-line delimiter, tolerating an empty left side (so the
# first present block seeds the context without a leading blank line).
# Args: $1=existing ctx $2=block to append · stdout: joined text (no trailing newline).
join_block() {
  if [[ -n "${1}" ]]; then
    printf '%s\n\n%s' "${1}" "${2}"
  else
    printf '%s' "${2}"
  fi
}

# Assemble additionalContext: the two NON-DROPPABLE blocks first (EMIT-FORMAT, then METER),
# followed by the four droppable scope blocks in display order (comment-logging, style_ref,
# minimalism, naming), each gated by its keep-flag. Reads the module-level *_BLOCK variables.
# Emit-first/meter-second is load-bearing: both must survive the 2KB preview, so neither may sit
# behind a larger droppable block. Emit leads as the PRIMARY fix.
# Args: $1=keep_comment $2=keep_styleref $3=keep_minimalism $4=keep_naming (each 0/1)
# stdout: the assembled context (no trailing newline).
assemble_ctx() {
  local keep_comment="${1}" keep_styleref="${2}" keep_minimalism="${3}" keep_naming="${4}"
  local ctx=""
  if [[ -n "${EMIT_BLOCK}" ]]; then
    ctx="${EMIT_BLOCK}"
  fi
  if [[ -n "${METER_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${METER_BLOCK}")"
  fi
  if [[ "${keep_comment}" -eq 1 && -n "${COMMENT_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${COMMENT_BLOCK}")"
  fi
  if [[ "${keep_styleref}" -eq 1 && -n "${STYLEREF_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${STYLEREF_BLOCK}")"
  fi
  if [[ "${keep_minimalism}" -eq 1 && -n "${MINIMALISM_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${MINIMALISM_BLOCK}")"
  fi
  if [[ "${keep_naming}" -eq 1 && -n "${NAMING_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${NAMING_BLOCK}")"
  fi
  printf '%s' "${ctx}"
}

# Four droppable scope blocks — each extracted only when AGENT_TYPE is in that block's roster (an
# empty extraction self-skips with a fail-open diagnostic; see extract_scope_block). Rosters DIFFER:
# comment-logging = DEV+QA · style_ref/minimalism = DEV-only (shared scope-dev.md source) · naming =
# DEV(12)+qa-code-reviewer. Blocks are independent — a missing one never suppresses the others (see
# the *_AGENTS definitions above for exact rosters + rationale).
COMMENT_BLOCK="$(extract_scope_block "${INJECT_AGENTS}" "${SRC_FILE}" "${MARKER_START}" "${MARKER_END}" "comment-logging")"
STYLEREF_BLOCK="$(extract_scope_block "${STYLEREF_AGENTS}" "${STYLEREF_SRC_FILE}" "${STYLEREF_MARKER_START}" "${STYLEREF_MARKER_END}" "style_ref")"
MINIMALISM_BLOCK="$(extract_scope_block "${MINIMALISM_AGENTS}" "${STYLEREF_SRC_FILE}" "${MINIMALISM_MARKER_START}" "${MINIMALISM_MARKER_END}" "minimalism")"
NAMING_BLOCK="$(extract_scope_block "${NAMING_AGENTS}" "${NAMING_SRC_FILE}" "${NAMING_MARKER_START}" "${NAMING_MARKER_END}" "naming")"

# Emit-format block — ALL subagents (universal, ALWAYS-ON), assembled FIRST. Unconditional:
# independent of SUBAGENT_BUDGET_METER_OFF + read_max_turns (the two coupling holes that would
# leave workflow/schema subagents uncovered). Static text → never fails to build, NEVER a drop
# candidate.
EMIT_BLOCK="$(build_emit_format_block)"

# Budget-meter block — ALL subagents (universal), independent of the four scope blocks above.
# Kill-switch + un-derivable maxTurns → empty (no meter). A missing meter must not suppress a
# scope block, and vice-versa.
METER_BLOCK=""
if [[ -z "${SUBAGENT_BUDGET_METER_OFF}" ]]; then
  METER_MAX_TURNS="$(read_max_turns "${AGENT_TYPE}")"
  if [[ -n "${METER_MAX_TURNS}" ]]; then
    METER_BLOCK="$(build_meter_block "${METER_MAX_TURNS}")"
  else
    printf '[inject-scope-rules] maxTurns un-derivable for budget meter (agent=%s)\n' "${AGENT_TYPE}" >&2
  fi
fi

# Combine blocks (EMIT-FORMAT first, METER second), then enforce the byte ceiling. assemble_ctx
# places the two non-droppable blocks first + appends the kept droppable blocks; the drop loop
# below removes the lowest-value blocks in the PINNED order naming → style-ref → minimalism →
# comment-logging until the total fits INJECT_CTX_MAX_BYTES. Neither emit-format nor meter is a
# drop candidate, so under extreme pressure only those two survive.
keep_comment=1
keep_styleref=1
keep_minimalism=1
keep_naming=1
CTX="$(assemble_ctx "${keep_comment}" "${keep_styleref}" "${keep_minimalism}" "${keep_naming}")"
ctx_bytes="$(byte_len "${CTX}")"
for drop_block in naming styleref minimalism comment; do
  [[ "${ctx_bytes}" -le "${INJECT_CTX_MAX_BYTES}" ]] && break
  case "${drop_block}" in
    naming) keep_naming=0 ;;
    styleref) keep_styleref=0 ;;
    minimalism) keep_minimalism=0 ;;
    comment) keep_comment=0 ;;
    *) ;; # unreachable — the loop iterates a fixed literal set; present only to satisfy SC2249.
  esac
  CTX="$(assemble_ctx "${keep_comment}" "${keep_styleref}" "${keep_minimalism}" "${keep_naming}")"
  ctx_bytes="$(byte_len "${CTX}")"
  printf '[inject-scope-rules] injected context exceeded %d bytes; dropped %s block (agent=%s)\n' "${INJECT_CTX_MAX_BYTES}" "${drop_block}" "${AGENT_TYPE}" >&2
done

# All blocks empty → nothing to inject, fail-open exit.
if [[ -z "${CTX}" ]]; then
  printf '[inject-scope-rules] no injectable block available; skipping injection (agent=%s)\n' "${AGENT_TYPE}" >&2
  exit 0
fi

# Assemble JSON — jq --arg escapes the combined context. additionalContext = the child injection point.
OUTPUT_JSON=""
OUTPUT_JSON="$(jq -nc \
  --arg ctx "${CTX}" \
  '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: $ctx}}' 2>/dev/null)" || OUTPUT_JSON=""

# JSON assembly failure → fail-open, no injection.
if [[ -z "${OUTPUT_JSON}" ]]; then
  printf '[inject-scope-rules] JSON assembly failed; skipping injection (agent=%s)\n' "${AGENT_TYPE}" >&2
  exit 0
fi

printf '%s\n' "${OUTPUT_JSON}"
exit 0
