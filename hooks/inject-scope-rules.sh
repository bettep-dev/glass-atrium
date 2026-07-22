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
# new DEV agent is wired into naming injection automatically. Two BUDGET-SIZING blocks
# (shared-turn-budget.md — injection-text SoT; policy SoT = GLOBAL_RULES Turn Budget &
# Graceful Exit) ride DISJOINT rosters: BUDGET-DEV (sizing-only — the non-droppable
# meter block already owns the 80%-ceiling half) → BUDGET_DEV_AGENTS, DEV(13) minus the
# four daemon-carrier agents whose bodies keep daemon-evolved budget bullets,
# AUTO-RECONCILED by inject_sync as a 5th tracked array; BUDGET-ANALYSIS →
# BUDGET_ANALYSIS_AGENTS, 6 curated analysis consumers, UNTRACKED-manual (membership is
# a governance decision, not roster-derivable).
#
# Two NON-DROPPABLE universal blocks (ALL subagents, not DEV/QA-scoped), INDEPENDENT
# of each other and of the scope blocks:
#   * [COMPLETION] emit-format (ALWAYS-ON, assembled FIRST — the PRIMARY fix):
#     schema-mode/workflow spawns emit NO text-channel block (the engine consumes only
#     StructuredOutput); track-outcome.sh recovers the writer fields from the SO input's
#     completion_block field. This directive names that field for schema-mode + delivers the
#     strict multi-line contract to the text-channel (manual) path.
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
#
# T8 — membership vs. delivery (roster disclaimer): this hook injects a FIXED set of extracted
# AGENT-INJECT MARKER blocks (comment-logging · style_ref · minimalism · naming · budget-dev ·
# budget-analysis) against the HARDCODED rosters below (INJECT_AGENTS, STYLEREF_AGENTS,
# MINIMALISM_AGENTS, NAMING_AGENTS, BUDGET_DEV_AGENTS, BUDGET_ANALYSIS_AGENTS). It performs NO
# per-agent Tier-2 scope-file SELECTION and injects NO Tier-2 scope-file BODY — a subagent's
# scope-rule body reaches it through the HOST project-instructions context channel, which is
# UNCEILINGED and UNMEASURED (unlike this hook's byte-accurate 9984-byte SubagentStart budget). So
# Tier-2 MEMBERSHIP (core-compliance-matrix.md) is NOT the same as delivery through this hook, and
# the corpus this hook budgets carefully is the MINOR channel. (Matrix SoT: core-compliance-matrix.md
# → "Membership vs. Delivery".)

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

# turn-budget source rule file — BOTH budget blocks (BUDGET-DEV + BUDGET-ANALYSIS) live in this
# single scoped/ file; same env-override + ~/.glass-atrium/scoped default as SRC_FILE/STYLEREF_SRC_FILE.
readonly BUDGET_SRC_FILE="${INJECT_SCOPE_RULES_BUDGET_SRC:-${HOME}/.glass-atrium/scoped/shared-turn-budget.md}"

# AD-3 lesson store — the CTM/EPM JSON the learning-aggregator writes (default under
# ~/.claude/data). Env-overridable for the Bats sandbox. Absent file → no lesson block
# (fail-open, universal). Read with jq (already required above); a PG read from this <1s
# hook is impractical, so the store is a local JSON file the aggregator maintains.
readonly LESSON_SRC_FILE="${INJECT_SCOPE_RULES_LESSONS_SRC:-${HOME}/.claude/data/lessons.json}"
# Hard per-block byte cap — the lesson block is the LOWEST-priority (first-dropped) block, so
# it must stay small; this bounds it independent of the assembly ceiling. Lessons are English
# (Outcome-record language invariant), so a byte truncation cannot split a multibyte char.
readonly LESSON_MAX_BYTES=1200
# top-K CTM lessons + top-K EPM warnings per matched agent (AD-3: 3-5 range).
readonly LESSON_TOP_K=5
# CTM injectability floor — mirrors the aggregator CTM_MIN_SCORE / core-learning-log.md score>=4.
readonly LESSON_MIN_SCORE=4

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

# budget AGENT-INJECT block boundaries — two DISTINCT marker names (one per roster variant), so
# neither sed range collides with the other nor with any other block.
readonly BUDGET_DEV_MARKER_START='<!-- AGENT-INJECT:BUDGET-DEV:START -->'
readonly BUDGET_DEV_MARKER_END='<!-- AGENT-INJECT:BUDGET-DEV:END -->'
readonly BUDGET_ANALYSIS_MARKER_START='<!-- AGENT-INJECT:BUDGET-ANALYSIS:START -->'
readonly BUDGET_ANALYSIS_MARKER_END='<!-- AGENT-INJECT:BUDGET-ANALYSIS:END -->'

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

# budget-dev scope-match — DEV(13) MINUS the four daemon-carrier agents (dev-nestjs, dev-python,
# dev-react, dev-shell) whose BODIES keep daemon-evolved in-body budget bullets (the daemon
# rewrites agent bodies, never hook sources) — injecting on top would double-deliver. Space-padded.
# AUTO-RECONCILED by agent_lifecycle inject_sync as a 5th tracked array via the predicate
# dev_roster − _BUDGET_DAEMON_CARRIERS — a new DEV agent is wired in automatically; the carrier
# constant changes ONLY when the daemon adds/removes an in-body budget bullet (a manual
# governance change, like NAMING's exclusions).
readonly BUDGET_DEV_AGENTS=" glass-atrium-dev-front glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-node glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-swift "

# budget-analysis scope-match — 6 curated analysis consumers. UNTRACKED-manual (no inject_sync
# reconcile): the set is not roster-derivable (meta-agent IN / meta-prompt-engineer OUT /
# intel-researcher OUT as a daemon carrier; qa-debugger + sec-guard never recipients) — a
# derivation predicate would be a second copy of the array = false confidence, so membership
# stays a curated governance decision. Space-padded.
readonly BUDGET_ANALYSIS_AGENTS=" glass-atrium-intel-planner glass-atrium-intel-reporter glass-atrium-qa-code-reviewer glass-atrium-design-designer glass-atrium-meta-agent glass-atrium-wiki-curator "

# Universal byte ceiling for the assembled additionalContext (byte-accurate via wc -c).
# WHY: the engine persists any SubagentStart additionalContext larger than ~10KB (10240
# bytes) to a file and delivers only a ~2KB preview — so an oversized assembly silently
# strips the meter (the exact failure this hook repairs). 9984 stays clear of the 10240
# trigger (256B margin — halved from 512B to admit the byte-contracted BUDGET-DEV block, still
# clear), and the ~900B meter fits even the 2KB preview, so meter delivery
# holds in every degradation mode. The six AGENT-INJECT source blocks are compressed so the
# worst-case DEV assembly (all seven blocks, <=9935B measured) fits under this ceiling with
# >=49B headroom — a ceiling
# raise ALONE cannot fit the pre-compression ~11540B sum, since no compliant ceiling can hold
# it under the 10240 persist threshold; the fit is compression + ceiling together. The zero-
# drop invariant is pinned by hooks/test/inject-scope-rules-nodrop.bats against the real repo
# sources. UNIVERSAL: the envelope carries no spawn-mode discriminator, so engine/schema-mode
# spawns are bounded identically to manual ones.
readonly INJECT_CTX_MAX_BYTES="${INJECT_SCOPE_RULES_CTX_MAX_BYTES:-9984}"

# T16 in-context drop marker reserve — a FIXED byte reserve subtracted from the ceiling the drop
# loop compares against, applied CONDITIONALLY (only after the first shed; an under-ceiling spawn
# keeps the full ceiling and grows no marker). Sized to the engine SAFETY MARGIN: the 9984 ceiling
# sits 256B below the ~10240 engine persist threshold (see INJECT_CTX_MAX_BYTES), so a 256B reserve
# guarantees that even when the widened marker overflows the reserve, the total stays below the
# engine threshold (the overflow rule's "emit + accept" is absorbed by this margin, never triggering
# the file-persist that strips the meter). The reserve is FIXED (not marker-length-derived) and the
# ceiling lowers exactly ONCE, so a widening marker can never re-trigger a shed — the byte arithmetic
# converges because each named shed just freed a whole block (hundreds-to-1200B) while its name+path
# costs ~40-60B (net negative). A larger reserve would needlessly shed blocks that fit the margin.
readonly INJECT_MARKER_RESERVE=256

# Persisted drop marker — a dropped block is a SILENT regression: Claude Code DISCARDS
# SubagentStart hook stderr, so the drop-loop diagnostic below never reaches an operator. Mirror
# track-outcome.sh's _append_diag_log — a bounded append (1 MiB truncate-on-exceed soft rotation)
# under a HOME-relative logs dir (the Bats HOME override redirects it clear of the real
# ~/.claude/logs). `glass-atrium doctor` (§10) surfaces the count. Env-overridable for the Bats sandbox.
readonly INJECT_DROP_LOG="${INJECT_SCOPE_RULES_DROP_LOG:-${HOME}/.claude/logs/inject-scope-rules.diag.log}"
readonly INJECT_DROP_LOG_MAX_BYTES=1048576 # 1 MiB soft cap → truncate-on-exceed

# Injection-attempted spawn counter — the DENOMINATOR of the drop-rate aggregation (rate = drops /
# spawns-with-injection-attempted). A SEPARATE artifact from the drop sink so a no-drop spawn writes
# NO drop record yet the denominator still advances; the drop sink stays numerator-only. A monotonic
# integer (not an append log), so it never grows in size and never needs rotation. Env-overridable
# for the Bats sandbox. An absent counter reads as 0 (first run), NOT as missing data.
readonly INJECT_SPAWN_COUNTER="${INJECT_SCOPE_RULES_SPAWN_COUNTER:-${HOME}/.claude/logs/inject-scope-rules.spawns.count}"

# Budget-meter maxTurns floor — below this the meter is SKIPPED. An 80% working ceiling of a <=3
# maxTurns budget (glass-atrium-sec-guard's maxTurns:3 → ceiling 2) is a self-contradictory "stop
# after 2 of 3 turns" advisory for the verdict-only agent GLOBAL_RULES already EXEMPTS from the
# ceiling mechanic (Turn Budget & Graceful Exit → Exempt). Requiring maxTurns >= 4 keeps the meter
# meaningful (ceiling >= 3, a real gap) and leaves the sec-guard spawn context meter-free.
readonly METER_MIN_MAX_TURNS=4

# Named aggregation query over the drop sink — reports the block-drop count (numerator, from the drop
# sink) against spawns-with-injection-attempted (denominator, from the spawn counter) plus the drop
# rate. Read-only: never writes, never touches injected content. Absent sink OR absent counter reads
# as 0 (a first run is 0 drops over 0 attempts → rate 0), NOT missing data. jq-free (awk/grep/tr only),
# so it works even where the injection path would fail-open on absent jq.
aggregate_drop_rate() {
  local drops=0 attempts=0 rate="0"
  if [[ -f "${INJECT_DROP_LOG}" ]]; then
    # grep -c prints "0" AND exits 1 on zero matches — capture with `|| true`, never `|| echo 0`
    # (the latter yields "0\n0"); the empty-guard then covers a read error.
    drops="$(grep -c ' DROP ' "${INJECT_DROP_LOG}" 2>/dev/null || true)"
    [[ -z "${drops}" ]] && drops=0
  fi
  if [[ -f "${INJECT_SPAWN_COUNTER}" ]]; then
    attempts="$(tr -cd '0-9' <"${INJECT_SPAWN_COUNTER}" 2>/dev/null || true)"
    [[ -z "${attempts}" ]] && attempts=0
  fi
  # awk float division; denominator 0 → rate 0 (absent sink counts as 0, not missing data).
  rate="$(awk -v n="${drops}" -v d="${attempts}" 'BEGIN { if (d > 0) printf "%.4f", n / d; else printf "0" }' 2>/dev/null || printf '0')"
  printf 'inject-scope-rules drop-rate: drops=%s injection_attempted=%s drop_rate=%s\n' "${drops}" "${attempts}" "${rate}"
}

# Operator/doctor aggregation-query mode — dispatched BEFORE reading the SubagentStart envelope so
# `inject-scope-rules.sh --drop-rate` never blocks on hook_read_input's cat. The hook path is invoked
# with NO args, so ${1:-} is empty and this is skipped there.
if [[ "${1:-}" == "--drop-rate" ]]; then
  aggregate_drop_rate
  exit 0
fi

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
# diagnostic on an empty extraction (markers/file absent). Consolidates the six scope-block
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
# uncovered). WHY: schema-mode spawns emit NO text-channel [COMPLETION] block (the engine consumes
# only StructuredOutput); the recorder recovers the writer fields from the SO input's completion_block
# field, so this directive names that field for schema-mode + delivers the strict multi-line contract
# to the text-channel (manual) path. The manual path keeps the print-block-then-emit discipline;
# schema-mode supersedes it with the completion_block field. stdout: block text.
# BYTE-BUDGET: this printf'd block is byte-budgeted — redteam-#24 9984B injection ceiling
# (worst-case DEV seven-block assembly <=9935B, >=49B headroom; drop order sheds lesson, then
# the two budget blocks, before the proven four) + the EMIT+METER 2048B ~2KB-preview cap. Any
# rewording MUST re-run hooks/test/inject-scope-rules-nodrop.bats
# and hooks/test/inject-scope-rules.bats before commit.
build_emit_format_block() {
  printf '%s\n' \
    "**[COMPLETION] emit format (auto-injected · REQUIRED by the outcome recorder)**" \
    "- Print the [COMPLETION] block MULTI-LINE: the [COMPLETION] tag ALONE on its own line, EACH field (result / task_type / metric_pass / confidence / summary / …) on its OWN line, closed by a [/COMPLETION] sentinel ALONE on its own line." \
    "- The inline single-line form ([COMPLETION] k: v | k: v | …) is NOT sanctioned — multi-line stays REQUIRED — but a well-formed inline emit is salvaged (parse_tier=1 fallback), not discarded; only a truly unparseable emit is synthesized (done_with_concerns / low). Schema/workflow (ultracode) spawns MUST use multi-line." \
    "- SCHEMA-MODE / WORKFLOW (ultracode) agents: your StructuredOutput call IS the terminal deliverable — you MUST call StructuredOutput as the LAST action. When the schema has a completion_block string field, put the full multi-line [COMPLETION] block there — the recorder recovers it (the RELIABLE path; a printed text turn does NOT survive the engine). A schema-mode run that ends without calling StructuredOutput is a hard engine error (the run throws), not a graceful finish."
}

# Byte length of a string (wc -c counts bytes, locale-independent); tr strips BSD wc's leading
# whitespace to a bare integer. Used to enforce INJECT_CTX_MAX_BYTES byte-accurately.
# Args: $1=string · stdout: byte count integer.
byte_len() {
  printf '%s' "${1}" | wc -c | tr -cd '0-9'
}

# AD-3: build the spawn-time lesson-recall block (Reflexion / LangMem procedural memory).
# Selects the current AGENT_TYPE's top-K CTM lessons (score >= LESSON_MIN_SCORE, live) +
# top-K EPM warnings (live) from the lesson store, sorted by score then frequency, formatted
# as a compact advisory. Empty when the store is absent OR no lesson matches this agent (a
# no-match spawn is left unchanged). Hard-capped at LESSON_MAX_BYTES.
#
# task_type NOTE: the SubagentStart envelope carries ONLY agent_type — task_type is not known
# until the agent acts — so matching is agent-keyed and each line carries its task_type tag as
# metadata (the AD-3 "agent + task_type match" collapses to agent-key + per-line task_type tag).
# stdout: the lesson block text (may be empty).
build_lesson_block() {
  [[ -f "${LESSON_SRC_FILE}" ]] || return 0
  local ctm epm body=""
  ctm="$(jq -r --arg a "${AGENT_TYPE}" --argjson k "${LESSON_TOP_K}" --argjson min "${LESSON_MIN_SCORE}" '
    (.ctm // [])
    | map(select(.agent == $a and (.tombstoned != true) and ((.score // 0) >= $min)))
    | sort_by(-(.score // 0), -(.frequency // 0))
    | .[:$k][]
    | "- [\(.task_type // "any")] \(.text)"
  ' "${LESSON_SRC_FILE}" 2>/dev/null || true)"
  epm="$(jq -r --arg a "${AGENT_TYPE}" --argjson k "${LESSON_TOP_K}" '
    (.epm // [])
    | map(select(.agent == $a and (.tombstoned != true)))
    | sort_by(-(.frequency // 0), -(.score // 0))
    | .[:$k][]
    | "- AVOID [\(.task_type // "any")] \(.text)"
  ' "${LESSON_SRC_FILE}" 2>/dev/null || true)"

  [[ -z "${ctm}" && -z "${epm}" ]] && return 0

  body="**Prior-lesson recall (auto-injected · CTM success + EPM warnings, agent-matched)**"
  if [[ -n "${ctm}" ]]; then
    body="$(printf '%s\nApply (worked before):\n%s' "${body}" "${ctm}")"
  fi
  if [[ -n "${epm}" ]]; then
    body="$(printf '%s\nAvoid (failed before):\n%s' "${body}" "${epm}")"
  fi

  # Hard byte cap — the block is the first-dropped candidate but this bounds its size at the
  # source too. head -c is byte-safe here (lessons are English per the Outcome-record invariant).
  local body_bytes
  body_bytes="$(byte_len "${body}")"
  if [[ "${body_bytes}" -gt "${LESSON_MAX_BYTES}" ]]; then
    body="$(printf '%s' "${body}" | head -c "${LESSON_MAX_BYTES}")"
  fi
  printf '%s' "${body}"
}

# Append a persisted drop-marker line. Fail-open: EVERY statement is guarded (|| true / || return 0
# / if-then) so a logging glitch can NEVER trip set -e → the ERR trap → a spawn-suppressing exit
# (a logging failure must not cost the injection). Bounded: the log is removed once it crosses
# INJECT_DROP_LOG_MAX_BYTES (cheap soft rotation). Args: $1=dropped block label $2=pre-drop byte
# size (DF-15: the OFFENDING over-ceiling total that prompted the drop, NOT the shrunk post-drop size).
append_drop_log() {
  local block="${1}" pre_drop_bytes="${2}" log_dir="${INJECT_DROP_LOG%/*}" sz="" ts="" pdb="" overage=0
  mkdir -p "${log_dir}" 2>/dev/null || return 0
  if [[ -f "${INJECT_DROP_LOG}" ]]; then
    sz="$(wc -c <"${INJECT_DROP_LOG}" 2>/dev/null | tr -cd '0-9' || true)"
    if [[ -n "${sz}" && "${sz}" -gt "${INJECT_DROP_LOG_MAX_BYTES}" ]]; then
      rm -f "${INJECT_DROP_LOG}" 2>/dev/null || true
    fi
  fi
  # Byte overage = how far the pre-drop assembly exceeded the ceiling (the record names it explicitly,
  # not only the raw sizes). Sanitize pre_drop_bytes to digits first so a non-numeric arg can never
  # trip the arithmetic → the fail-open ERR trap → a spawn-suppressing exit.
  pdb="$(printf '%s' "${pre_drop_bytes}" | tr -cd '0-9')"
  [[ -z "${pdb}" ]] && pdb=0
  overage=$((10#${pdb} - INJECT_CTX_MAX_BYTES))
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  printf '%s [inject-scope-rules] DROP agent=%s block=%s pre_drop_bytes=%s ceiling=%s overage_bytes=%s\n' \
    "${ts}" "${AGENT_TYPE}" "${block}" "${pre_drop_bytes}" "${INJECT_CTX_MAX_BYTES}" "${overage}" \
    >>"${INJECT_DROP_LOG}" 2>/dev/null || true
  return 0
}

# AM-T16: map a shed block label to its Read-resolvable rule-doc source path. Returns the SAME
# *_SRC_FILE constant the block was extracted from, so a marker path can never drift from the real
# source. The lesson block is the ONE runtime-derived exception (sourced at runtime from a JSON store
# via jq, NOT a rule document) — it has no Read-resolvable path, so it returns empty and the caller
# tags it instead. Args: $1=block label · stdout: source path (empty for lesson / unknown).
marker_source_path() {
  case "${1}" in
    comment) printf '%s' "${SRC_FILE}" ;;
    styleref | minimalism) printf '%s' "${STYLEREF_SRC_FILE}" ;;
    naming) printf '%s' "${NAMING_SRC_FILE}" ;;
    budget-dev | budget-analysis) printf '%s' "${BUDGET_SRC_FILE}" ;;
    *) : ;; # lesson (runtime-derived) + any unknown → no path
  esac
}

# AM-T16: append one shed-block entry to the running (semicolon-joined, single-line) marker-entry
# list. A rule-doc-sourced block carries its resolvable source path; the lesson block is tagged
# EXACTLY "runtime-derived, no source path — recovers via re-spawn, not Read" and carries NO path
# (its most-frequent-shed blind spot would otherwise pass the path-existence criterion vacuously, or
# worse point at the all-agent JSON store). Args: $1=existing entries $2=block label · stdout: joined.
append_marker_entry() {
  local existing="${1}" label="${2}" entry="" src_path
  if [[ "${label}" == "lesson" ]]; then
    entry="lesson: runtime-derived, no source path — recovers via re-spawn, not Read"
  else
    src_path="$(marker_source_path "${label}")"
    entry="${label}: ${src_path}"
  fi
  if [[ -z "${existing}" ]]; then
    printf '%s' "${entry}"
  else
    printf '%s; %s' "${existing}" "${entry}"
  fi
}

# T16: build the single-line, post-loop drop marker naming each shed block. The count field is
# fixed-width (%02d padded) so a variable count can never nudge the marker across the reserve
# boundary. AM-T16: the header states ONCE that a listed source path MAY be Read to recover the
# dropped guidance (per-rule-doc-block paths carried in the entries). Args: $1=shed count $2=entries.
build_drop_marker() {
  local count="${1}" entries="${2}" padded
  # count is shed_count — an integer accumulated only via $((shed_count + 1)) — so the width format
  # cannot fail; no error fallback needed.
  printf -v padded '%02d' "${count}"
  printf '**Injection shed %s (auto-injected — you MAY Read a listed source path to recover it):** %s.' \
    "${padded}" "${entries}"
}

# T16: was the block for a shed label ACTUALLY present (non-empty) in the assembly? Reads the
# module-level *_BLOCK variables (set before the loop). Only a present-then-shed block is a REAL
# shed the marker should name — naming an absent block would claim a phantom drop + phantom AM-T16
# path. Each branch ends on the [[ ]] so the function returns its truth value (set -e safe in an
# `if` condition). Args: $1=block label · returns: 0 if present, 1 otherwise.
block_is_present() {
  case "${1}" in
    lesson) [[ -n "${LESSON_BLOCK}" ]] ;;
    budget-analysis) [[ -n "${BUDGET_ANALYSIS_BLOCK}" ]] ;;
    budget-dev) [[ -n "${BUDGET_DEV_BLOCK}" ]] ;;
    naming) [[ -n "${NAMING_BLOCK}" ]] ;;
    styleref) [[ -n "${STYLEREF_BLOCK}" ]] ;;
    minimalism) [[ -n "${MINIMALISM_BLOCK}" ]] ;;
    comment) [[ -n "${COMMENT_BLOCK}" ]] ;;
    *) return 1 ;;
  esac
}

# Increment the injection-attempted spawn counter — the drop-rate DENOMINATOR. Separate from the drop
# sink so a no-drop spawn advances the denominator WITHOUT writing a drop record. Fail-open on every
# statement (a counter glitch must never break the spawn nor alter injected content — AC4). Read-
# modify-write races are acceptable for an approximate observability rate (drops are rare).
increment_spawn_attempts() {
  local dir="${INJECT_SPAWN_COUNTER%/*}" cur="" next=0
  mkdir -p "${dir}" 2>/dev/null || return 0
  if [[ -f "${INJECT_SPAWN_COUNTER}" ]]; then
    cur="$(tr -cd '0-9' <"${INJECT_SPAWN_COUNTER}" 2>/dev/null || true)"
  fi
  [[ -z "${cur}" ]] && cur=0
  next=$((10#${cur} + 1))
  printf '%s\n' "${next}" >"${INJECT_SPAWN_COUNTER}" 2>/dev/null || return 0
  return 0
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
# followed by the six droppable scope blocks in display order (comment-logging, style_ref,
# minimalism, naming, budget-dev, budget-analysis), each gated by its keep-flag. Reads the
# module-level *_BLOCK variables. Emit-first/meter-second is load-bearing: both must survive the
# 2KB preview, so neither may sit behind a larger droppable block. Emit leads as the PRIMARY fix.
# Args: $1=keep_comment $2=keep_styleref $3=keep_minimalism $4=keep_naming $5=keep_budget_dev
# $6=keep_budget_analysis $7=keep_lesson (each 0/1)
# stdout: the assembled context (no trailing newline). The AD-3 lesson block is appended LAST
# (lowest priority) so it is the FIRST block the drop loop sheds under ceiling pressure; the two
# budget blocks shed next-after-lesson (newest, least proven — their DISJOINT rosters make their
# mutual order inert), so the proven four (worst-case DEV seven-block assembly <=9935B, >=49B
# headroom under 9984) always win over best-effort recall.
assemble_ctx() {
  local keep_comment="${1}" keep_styleref="${2}" keep_minimalism="${3}" keep_naming="${4}"
  local keep_budget_dev="${5}" keep_budget_analysis="${6}" keep_lesson="${7}"
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
  if [[ "${keep_budget_dev}" -eq 1 && -n "${BUDGET_DEV_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${BUDGET_DEV_BLOCK}")"
  fi
  if [[ "${keep_budget_analysis}" -eq 1 && -n "${BUDGET_ANALYSIS_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${BUDGET_ANALYSIS_BLOCK}")"
  fi
  if [[ "${keep_lesson}" -eq 1 && -n "${LESSON_BLOCK}" ]]; then
    ctx="$(join_block "${ctx}" "${LESSON_BLOCK}")"
  fi
  printf '%s' "${ctx}"
}

# Six droppable scope blocks — each extracted only when AGENT_TYPE is in that block's roster (an
# empty extraction self-skips with a fail-open diagnostic; see extract_scope_block). Rosters DIFFER:
# comment-logging = DEV+QA · style_ref/minimalism = DEV-only (shared scope-dev.md source) · naming =
# DEV(12)+qa-code-reviewer · budget-dev = DEV(9, minus daemon carriers) · budget-analysis = 6
# curated analysis consumers (shared shared-turn-budget.md source). Blocks are independent — a
# missing one never suppresses the others (see the *_AGENTS definitions above for exact rosters +
# rationale).
COMMENT_BLOCK="$(extract_scope_block "${INJECT_AGENTS}" "${SRC_FILE}" "${MARKER_START}" "${MARKER_END}" "comment-logging")"
STYLEREF_BLOCK="$(extract_scope_block "${STYLEREF_AGENTS}" "${STYLEREF_SRC_FILE}" "${STYLEREF_MARKER_START}" "${STYLEREF_MARKER_END}" "style_ref")"
MINIMALISM_BLOCK="$(extract_scope_block "${MINIMALISM_AGENTS}" "${STYLEREF_SRC_FILE}" "${MINIMALISM_MARKER_START}" "${MINIMALISM_MARKER_END}" "minimalism")"
NAMING_BLOCK="$(extract_scope_block "${NAMING_AGENTS}" "${NAMING_SRC_FILE}" "${NAMING_MARKER_START}" "${NAMING_MARKER_END}" "naming")"
BUDGET_DEV_BLOCK="$(extract_scope_block "${BUDGET_DEV_AGENTS}" "${BUDGET_SRC_FILE}" "${BUDGET_DEV_MARKER_START}" "${BUDGET_DEV_MARKER_END}" "budget-dev")"
BUDGET_ANALYSIS_BLOCK="$(extract_scope_block "${BUDGET_ANALYSIS_AGENTS}" "${BUDGET_SRC_FILE}" "${BUDGET_ANALYSIS_MARKER_START}" "${BUDGET_ANALYSIS_MARKER_END}" "budget-analysis")"

# AD-3 lesson-recall block — universal (any agent_type), self-skipping on no store / no match
# (a no-match spawn is unchanged). NOT a roster gate: build_lesson_block returns empty unless
# THIS agent has matching lessons.
LESSON_BLOCK="$(build_lesson_block)"

# Emit-format block — ALL subagents (universal, ALWAYS-ON), assembled FIRST. Unconditional:
# independent of SUBAGENT_BUDGET_METER_OFF + read_max_turns (the two coupling holes that would
# leave workflow/schema subagents uncovered). Static text → never fails to build, NEVER a drop
# candidate.
EMIT_BLOCK="$(build_emit_format_block)"

# Budget-meter block — ALL subagents (universal), independent of the six scope blocks above.
# Kill-switch + un-derivable maxTurns → empty (no meter). A missing meter must not suppress a
# scope block, and vice-versa.
METER_BLOCK=""
if [[ -z "${SUBAGENT_BUDGET_METER_OFF}" ]]; then
  METER_MAX_TURNS="$(read_max_turns "${AGENT_TYPE}")"
  if [[ -z "${METER_MAX_TURNS}" ]]; then
    printf '[inject-scope-rules] maxTurns un-derivable for budget meter (agent=%s)\n' "${AGENT_TYPE}" >&2
  elif [[ "$((10#${METER_MAX_TURNS}))" -lt "${METER_MIN_MAX_TURNS}" ]]; then
    # DF-20: maxTurns below the floor (sec-guard's 3) → meter skipped, not contradictory.
    printf '[inject-scope-rules] maxTurns %s below meter floor %d; meter skipped (agent=%s)\n' "${METER_MAX_TURNS}" "${METER_MIN_MAX_TURNS}" "${AGENT_TYPE}" >&2
  else
    METER_BLOCK="$(build_meter_block "${METER_MAX_TURNS}")"
  fi
fi

# Combine blocks (EMIT-FORMAT first, METER second), then enforce the byte ceiling. assemble_ctx
# places the two non-droppable blocks first + appends the kept droppable blocks; the drop loop
# below removes the lowest-value blocks in the PINNED order lesson → budget-analysis → budget-dev
# → naming → style-ref → minimalism → comment-logging until the total fits INJECT_CTX_MAX_BYTES.
# Neither emit-format nor meter is a drop candidate, so under extreme pressure only those two
# survive.
keep_comment=1
keep_styleref=1
keep_minimalism=1
keep_naming=1
keep_budget_dev=1
keep_budget_analysis=1
keep_lesson=1
CTX="$(assemble_ctx "${keep_comment}" "${keep_styleref}" "${keep_minimalism}" "${keep_naming}" "${keep_budget_dev}" "${keep_budget_analysis}" "${keep_lesson}")"
ctx_bytes="$(byte_len "${CTX}")"
# lesson FIRST — AD-3 best-effort recall yields before any scope block; the two budget blocks
# (newest, least proven — DISJOINT rosters, mutual order inert) shed next, before the proven four
# (worst-case DEV seven-block assembly <=9935B under 9984 → a full-DEV spawn sheds lessons first;
# lighter agents keep them).
#
# T16: the loop compares against effective_ceiling (starts FULL; lowers ONCE by INJECT_MARKER_RESERVE
# on the first shed, then never again — a widening marker can never lower it a second time) and
# accumulates a marker entry for every ACTUALLY-PRESENT block it sheds. The post-loop marker is
# NON-DROPPABLE by placement (appended after the loop, never re-size-checked).
effective_ceiling="${INJECT_CTX_MAX_BYTES}"
marker_entries=""
shed_count=0
for drop_block in lesson budget-analysis budget-dev naming styleref minimalism comment; do
  [[ "${ctx_bytes}" -le "${effective_ceiling}" ]] && break
  # DF-15: the OFFENDING size is the over-ceiling total that PROMPTED this drop — captured BEFORE
  # the block is removed. The post-drop reassembly below shrinks ctx_bytes, so logging that would
  # under-report the size that actually breached the ceiling.
  pre_drop_bytes="${ctx_bytes}"
  # T16 conditional reserve: the FIRST shed lowers the ceiling ONCE (a marker exists only once a shed
  # occurred, so an under-full-ceiling spawn never reserves and grows no marker). The reserve is a
  # nonzero constant, so "still at the full ceiling" is the derivable "not yet lowered" guard →
  # lowers at most once per invocation.
  if [[ "${effective_ceiling}" -eq "${INJECT_CTX_MAX_BYTES}" ]]; then
    effective_ceiling=$((INJECT_CTX_MAX_BYTES - INJECT_MARKER_RESERVE))
    printf '[inject-scope-rules] injection ceiling lowered to %d bytes to reserve room for the drop marker (agent=%s)\n' "${effective_ceiling}" "${AGENT_TYPE}" >&2
  fi
  # T16 marker accumulation — name only a block that was ACTUALLY present (block_is_present); an
  # absent block is not a real shed, so naming it would claim a phantom drop + phantom AM-T16 path.
  # Pure predicate → the if-condition disabling set -e (SC2310) is intended.
  # shellcheck disable=SC2310
  if block_is_present "${drop_block}"; then
    marker_entries="$(append_marker_entry "${marker_entries}" "${drop_block}")"
    shed_count=$((shed_count + 1))
  fi
  case "${drop_block}" in
    lesson) keep_lesson=0 ;;
    budget-analysis) keep_budget_analysis=0 ;;
    budget-dev) keep_budget_dev=0 ;;
    naming) keep_naming=0 ;;
    styleref) keep_styleref=0 ;;
    minimalism) keep_minimalism=0 ;;
    comment) keep_comment=0 ;;
    *) ;; # unreachable — the loop iterates a fixed literal set; present only to satisfy SC2249.
  esac
  CTX="$(assemble_ctx "${keep_comment}" "${keep_styleref}" "${keep_minimalism}" "${keep_naming}" "${keep_budget_dev}" "${keep_budget_analysis}" "${keep_lesson}")"
  ctx_bytes="$(byte_len "${CTX}")"
  printf '[inject-scope-rules] injected context exceeded %d bytes; dropped %s block (agent=%s)\n' "${INJECT_CTX_MAX_BYTES}" "${drop_block}" "${AGENT_TYPE}" >&2
  append_drop_log "${drop_block}" "${pre_drop_bytes}"
done

# T16 in-context drop marker — appended AFTER the loop, so it is NON-DROPPABLE by placement (no shed
# can remove it). Emitted only when >=1 actually-present block was shed, and never re-size-checked:
# the OVERFLOW RULE accepts the pathological case where the two non-droppable blocks plus the marker
# exceed the reduced ceiling (emit + accept, NEVER loop). The byte arithmetic otherwise converges —
# each named shed freed a whole block (hundreds-to-1200B) while its name+path costs ~40-60B.
if [[ "${shed_count}" -gt 0 ]]; then
  drop_marker="$(build_drop_marker "${shed_count}" "${marker_entries}")"
  CTX="$(join_block "${CTX}" "${drop_marker}")"
fi

# All blocks empty → nothing to inject, fail-open exit.
if [[ -z "${CTX}" ]]; then
  printf '[inject-scope-rules] no injectable block available; skipping injection (agent=%s)\n' "${AGENT_TYPE}" >&2
  exit 0
fi

# Injection is attempted (non-empty CTX proceeding to emit) → advance the drop-rate denominator. Placed
# AFTER the empty-CTX skip so a no-inject spawn does not count. Fail-open (never alters CTX / the exit).
increment_spawn_attempts

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
