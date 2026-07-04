#!/usr/bin/env bash
# inject-scope-rules.sh — SubagentStart hook: inject scope-rule cores + a budget meter into subagents.
#
# On a DEV(12)/QA(2) spawn, extracts the AGENT-INJECT block from shared-comment-logging.md and
# delivers it as hookSpecificOutput.additionalContext (the subagent otherwise gets only the
# comment-logging pointer token, not the body). Beyond comment-logging, THREE additional scope
# blocks are appended: for DEV(12) ONLY (excludes QA), two blocks from scope-dev.md — the
# AGENT-INJECT:STYLE-REF block (style_ref is DEV-scoped, and the pointer token alone left the emit
# obligation unfollowed — PG core.outcomes style_ref ~0% emit) and the AGENT-INJECT:MINIMALISM block
# (the minimalism reflex, likewise a DEV-scoped per-response behavior the pointer token alone did not
# deliver); plus the AGENT-INJECT:NAMING block (next paragraph) for DEV(12, excluding dev-swift) +
# qa-code-reviewer.
#
# Also appends the AGENT-INJECT:NAMING block (from the glass-atrium-dev-naming SKILL.md) for the 13
# agents whose frontmatter declares that skill: DEV(12, excluding dev-swift) + qa-code-reviewer.
# This block raises recall of the user-specific naming convention (review-side qa-code-reviewer is
# the enforcement surface). Its NAMING_AGENTS roster is DELIBERATELY narrower than INJECT_AGENTS
# (no qa-debugger, no dev-swift). Under the HYBRID design NAMING_AGENTS is now AUTO-RECONCILED by the
# agent_lifecycle inject_sync tooling as a 4th tracked array (alongside INJECT_AGENTS / STYLEREF /
# MINIMALISM rosters) — a newly created DEV agent is wired into naming injection automatically, no
# manual edit of this array required.
#
# Budget-meter block (ALL subagents with a maxTurns frontmatter — universal, not DEV/QA-scoped):
# a subagent has NO runtime turn meter, so the documented "stop at ~80% of maxTurns" rule is dead
# text — the agent runs to the maxTurns hard-cap, which kills it mid-tool-use → no [COMPLETION]
# block → the orchestrator must SendMessage-recover. This block SUPPLIES the meter the rule assumes
# the agent already has: it states the agent's maxTurns budget N (read from its own frontmatter) and
# the checkpoint-at-80% instruction. It is INDEPENDENT of the four scope blocks above (a non-DEV/QA
# agent still receives the meter; a missing meter must not suppress a scope block, vice-versa).
#
# Other agents → no injection, exit 0.
# fail-open: SubagentStart cannot block; every failure (file/marker/jq absent, empty extraction)
# → exit 0 + 1 stderr diagnostic line, injecting whatever IS available (the five blocks are
# independent — a missing block must NOT suppress the others).

set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# fail-open ERR trap — no internal error must break subagent spawn.
trap 'printf "[inject-scope-rules] internal error at line %d: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Instant kill switch for the budget-meter block ONLY (the scope-rule injection is unaffected) —
# set a non-empty value to suppress the meter without removing the hook. WHY a per-block switch:
# the meter is the newest, least-proven block; an operator may want it off while keeping the
# established comment-logging / style_ref injection live.
SUBAGENT_BUDGET_METER_OFF="${SUBAGENT_BUDGET_METER_OFF:-}"

# Agents-dir root — frontmatter source for the maxTurns lookup. Env-overridable for the Bats
# sandbox (the test points it at a fixture dir). Canonical SoT root = ~/.glass-atrium/agents.
readonly AGENTS_DIR="${INJECT_SCOPE_RULES_AGENTS_DIR:-${HOME}/.glass-atrium/agents}"

# Comment-logging source rule file — env-overridable (test fail-open branch), ${HOME}-relative.
readonly SRC_FILE="${INJECT_SCOPE_RULES_SRC:-${HOME}/.claude/scoped/shared-comment-logging.md}"

# style_ref source rule file — DEV-only injection; same env-override pattern as SRC_FILE.
readonly STYLEREF_SRC_FILE="${INJECT_SCOPE_RULES_STYLEREF_SRC:-${HOME}/.claude/scoped/scope-dev.md}"

# naming source SKILL file — DEV(12)+qa-code-reviewer injection; same env-override + ${HOME}/.claude
# pattern. The ${HOME}/.claude path is a symlink into the canonical ~/.glass-atrium store (verified);
# the hook uses ${HOME}/.claude consistently with SRC_FILE/STYLEREF_SRC_FILE rather than the raw store.
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

# naming scope-match — the 13 agents whose frontmatter declares glass-atrium-dev-naming: DEV(12,
# EXCLUDING dev-swift) + qa-code-reviewer. Space-padded. DELIBERATELY NOT INJECT_AGENTS: that set
# wrongly adds qa-debugger + dev-swift, neither of which declares the naming skill (frontmatter-
# verified). Under HYBRID this array is AUTO-RECONCILED by agent_lifecycle inject_sync as a 4th
# tracked array (it parses all 4 named arrays, naming included) — a new DEV agent is wired in
# automatically; the narrower roster is enforced by a dedicated naming membership predicate
# (dev_roster − {dev-swift} ∪ {qa-code-reviewer}), NOT the generic DEV/QA rosters.
readonly NAMING_AGENTS=" glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-qa-code-reviewer "

INPUT="$(hook_read_input)"
[[ "${INPUT}" == "{}" ]] && exit 0

AGENT_TYPE="$(hook_get_field "${INPUT}" "agent_type")"
[[ -z "${AGENT_TYPE}" ]] && exit 0

# Scope match — exact-token on space boundaries. Recorded as a flag (not an early exit): the
# budget meter applies to ALL subagents, so a non-DEV/QA agent must still proceed to the meter
# block. Only the comment-logging / style_ref blocks gate on this flag.
IS_INJECT_AGENT=0
if [[ "${INJECT_AGENTS}" == *" ${AGENT_TYPE} "* ]]; then
  IS_INJECT_AGENT=1
fi

# Absent jq = system misconfiguration — fail-open.
if ! command -v jq >/dev/null 2>&1; then
  printf '[inject-scope-rules] jq not found on PATH; skipping injection (agent=%s)\n' "${AGENT_TYPE}" >&2
  exit 0
fi

# Extract a marked block from a rule file, dropping the two marker lines (must not reach the child).
# sed range + grep -vxF (not awk flag-range) for BSD/GNU portability. Returns empty on any failure
# (file/markers absent) — the caller treats empty as "this block unavailable", never as a hard error.
# Args: $1=src_file $2=marker_start $3=marker_end · stdout: block text (may be empty).
extract_block() {
  local src="${1}" start="${2}" end="${3}"
  [[ -f "${src}" ]] || return 0
  sed -n "/${start}/,/${end}/p" "${src}" 2>/dev/null \
    | grep -vxF "${start}" | grep -vxF "${end}" || true
}

# Read the maxTurns integer from an agent's frontmatter. fail-open: agent_type un-derivable,
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

# Build the budget-meter advisory text for a known maxTurns budget. The 80%-checkpoint figure is
# the documented working-ceiling (GLOBAL_RULES Turn Budget & Graceful Exit) — stated in TURNS
# (the meter's honest unit; maxTurns is a turn cap, not a tool_use cap). The injected line is the
# meter the agent otherwise lacks at runtime.
# Args: $1=max_turns (integer) · stdout: the meter block text.
build_meter_block() {
  local max_turns="${1}" ceiling=0
  # 80% working ceiling, integer floor (e.g. 40→32, 25→20, 3→2). Native integer math (max_turns is
  # already digit-stripped to a non-empty positive integer by read_max_turns). Layer 2: ceiling is
  # default-initialized above so no arithmetic edge leaves it unbound under set -u. Layer 1: force
  # base-10 — a leading-zero frontmatter value like 040 is a valid digit string but a bare $(( 040 ))
  # re-reads as OCTAL; 10# keeps it decimal (consistency with advisory-subagent-budget.sh).
  ceiling=$((10#${max_turns} * 8 / 10))
  printf '%s\n' \
    "**Turn-budget meter (auto-injected · GLOBAL_RULES Turn Budget & Graceful Exit)**" \
    "- Your maxTurns hard cap is ${max_turns} TURNS (a TURN cap, not a tool_use cap). The hard cap kills you mid-tool-use → no [COMPLETION] block → costly orchestrator recovery." \
    "- Working ceiling = ${ceiling} turns (80% of cap). As you APPROACH ${ceiling}: STOP, do NOT push to the hard cap." \
    "- On approach: finish the current write to a valid state (no partial files), checkpoint done/remaining to memory/progress-{task}.md, then emit a terminal [COMPLETION] block with result: needs_context and a 1-line resume point in summary." \
    "- Splitting > truncation: a clean needs_context handoff resumes cleanly; a hard-cap kill does not."
}

# Comment-logging block — DEV + QA only (gated on the scope flag).
COMMENT_BLOCK=""
if [[ "${IS_INJECT_AGENT}" -eq 1 ]]; then
  COMMENT_BLOCK="$(extract_block "${SRC_FILE}" "${MARKER_START}" "${MARKER_END}")"
  if [[ -z "${COMMENT_BLOCK}" ]]; then
    printf '[inject-scope-rules] comment-logging block empty or markers absent in %s (agent=%s)\n' "${SRC_FILE}" "${AGENT_TYPE}" >&2
  fi
fi

# style_ref block — DEV only (QA excluded). Independent of the comment block: its absence must
# NOT suppress the comment block, and vice-versa.
STYLEREF_BLOCK=""
if [[ "${STYLEREF_AGENTS}" == *" ${AGENT_TYPE} "* ]]; then
  STYLEREF_BLOCK="$(extract_block "${STYLEREF_SRC_FILE}" "${STYLEREF_MARKER_START}" "${STYLEREF_MARKER_END}")"
  if [[ -z "${STYLEREF_BLOCK}" ]]; then
    printf '[inject-scope-rules] style_ref block empty or markers absent in %s (agent=%s)\n' "${STYLEREF_SRC_FILE}" "${AGENT_TYPE}" >&2
  fi
fi

# minimalism block — DEV only (QA excluded). Sourced from the same scope-dev.md file as the
# style_ref block. Independent of the other blocks: its absence must NOT suppress them, vice-versa.
MINIMALISM_BLOCK=""
if [[ "${MINIMALISM_AGENTS}" == *" ${AGENT_TYPE} "* ]]; then
  MINIMALISM_BLOCK="$(extract_block "${STYLEREF_SRC_FILE}" "${MINIMALISM_MARKER_START}" "${MINIMALISM_MARKER_END}")"
  if [[ -z "${MINIMALISM_BLOCK}" ]]; then
    printf '[inject-scope-rules] minimalism block empty or markers absent in %s (agent=%s)\n' "${STYLEREF_SRC_FILE}" "${AGENT_TYPE}" >&2
  fi
fi

# naming block — DEV(12)+qa-code-reviewer (gated on NAMING_AGENTS membership). Sourced from the
# naming SKILL.md. Independent of the other blocks: its absence must NOT suppress them, vice-versa.
NAMING_BLOCK=""
if [[ "${NAMING_AGENTS}" == *" ${AGENT_TYPE} "* ]]; then
  NAMING_BLOCK="$(extract_block "${NAMING_SRC_FILE}" "${NAMING_MARKER_START}" "${NAMING_MARKER_END}")"
  if [[ -z "${NAMING_BLOCK}" ]]; then
    printf '[inject-scope-rules] naming block empty or markers absent in %s (agent=%s)\n' "${NAMING_SRC_FILE}" "${AGENT_TYPE}" >&2
  fi
fi

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

# Combine available blocks — blank-line delimited so each block stays readable to the child.
# All empty → nothing to inject, fail-open exit.
CTX=""
if [[ -n "${COMMENT_BLOCK}" ]]; then
  CTX="${COMMENT_BLOCK}"
fi
if [[ -n "${STYLEREF_BLOCK}" ]]; then
  if [[ -n "${CTX}" ]]; then
    CTX="${CTX}"$'\n\n'"${STYLEREF_BLOCK}"
  else
    CTX="${STYLEREF_BLOCK}"
  fi
fi
if [[ -n "${MINIMALISM_BLOCK}" ]]; then
  if [[ -n "${CTX}" ]]; then
    CTX="${CTX}"$'\n\n'"${MINIMALISM_BLOCK}"
  else
    CTX="${MINIMALISM_BLOCK}"
  fi
fi
if [[ -n "${NAMING_BLOCK}" ]]; then
  if [[ -n "${CTX}" ]]; then
    CTX="${CTX}"$'\n\n'"${NAMING_BLOCK}"
  else
    CTX="${NAMING_BLOCK}"
  fi
fi
if [[ -n "${METER_BLOCK}" ]]; then
  if [[ -n "${CTX}" ]]; then
    CTX="${CTX}"$'\n\n'"${METER_BLOCK}"
  else
    CTX="${METER_BLOCK}"
  fi
fi
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
