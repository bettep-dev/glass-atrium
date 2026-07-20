#!/usr/bin/env bash
# enforce-workflow-verify-stage.sh — PreToolUse(Workflow) static composition-declaration gate.
#
# WHY: under ultracode the Workflow engine's internal agent() spawns fire NO PreToolUse(Agent)
# event, so enforce-verification-gate.sh is bypassed and the {qa-code-reviewer, DEV} Plan Direction
# Verification (Stage-2) gate is honor-system only on that path. This hook closes that gap on the
# OUTER Workflow tool invocation with a SELF-ATTESTATION mechanism (mechanism parity with the
# [ENTRY-CLASS] / [SIZE-EST] / [DOC-ROUTE] / plan-ref tokens): a DEV-spawning workflow MUST carry an
# [AGENT-COMPOSITION] declaration block; the gate consistency-checks that declaration against the
# code. Truthfulness of the declaration is NOT mechanically verifiable — identical honor-system
# trust model as the sibling attestation tokens. This REPLACES the prior shape-inference machinery
# (co-location window / parallel-group pairing / pipeline stage-adjacency): role information (which
# dev is the verify partner vs the gated implementation dev) does NOT exist in the code, so any
# inference was a guess. The author declares; the hook checks presence + consistency.
#
# DECLARATION GRAMMAR (raw-scanned, but the opening sentinel must NOT sit inside a string literal so
# an incidental prompt/goal mention is not mistaken for a declaration; canonical home = a /* */
# block comment):
#   [AGENT-COMPOSITION]
#   verify: <glass-atrium-qa-code-reviewer AND exactly one glass-atrium-dev-*>  (in-script Stage-2 pair)
#           | upstream clauded-docs/<N>                                         (executes a verified plan)
#   impl: <literal dev agentType spawn(s)>            (comma-separated) | none
#   impl-computed: <dev agentType(s) spawned indirectly, e.g. agentType: b.agent over a config array>
#   [/AGENT-COMPOSITION]
# STRICT LINE GRAMMAR (the Stage-2 DEV hard-gate lives HERE): key set {verify, impl, impl-computed};
# ONE line per key; agent names validated against the runtime DEV_SET argument (never a second
# roster) plus the reviewer literal; free text admitted only after a spaced-dash delimiter; a
# well-formed sentinel pair whose lines are garbage (unknown/duplicate key, unknown name, unterminated
# block, 2+ blocks, a verify team naming 2+ dev types) is a DECIDABLE author error → BLOCK_GRAMMAR. A
# team-form verify clause that names NO dev-* partner → BLOCK_NOVERIFYDEV (the DEV hard-gate).
# Consistency checks (all fail-OPEN on any parse uncertainty):
#   (a) every declared literal role (verify reviewer/dev + impl dev) maps to a Tier-B spawn-position
#       token in the code                                                        -> else BLOCK_DECLSPAWN
#   (b) every Tier-B dev spawn in the code is covered by the declaration         -> else BLOCK_UNDECL
#   (b-prime) every Tier-A quoted dev literal type appears in the declaration (closes the undeclared
#        config-array fan-out hole AND the prose-mention case)                   -> else BLOCK_UNDECL
#   (c) every declared impl-computed agentType has a Tier-A data-literal presence -> else BLOCK_COMPUTED
#   (d) declared verify spawn positions precede declared impl positions, on the GREEDY-EARLIEST
#       same-type dual-role binding (computed spawns -> declared-order honor-system) -> else BLOCK_ORDER
#   (e) an upstream clauded-docs/<N> verify clause requires the SAME id cited by a plan-ref token in
#       the script BODY (outside the declaration)                                -> else BLOCK_UPSTREAM
# UPSTREAM SCOPE (decision codified): the upstream form waives the in-script verify pair-mapping AND
# ordering ONLY — the BLOCK_NOREV zero-reviewer hard guarantee is evaluated INDEPENDENTLY of the
# declaration form and SURVIVES upstream (a fake upstream line can NEVER delete reviewer presence).
# RETAINED verbatim: Tier-A/Tier-B token classification (Tier-B is the code-side operand of the
# consistency check), the BLOCK_NOREV zero-reviewer hard guarantee, the entry-miss gate, the
# [SIZE-EST] size-attestation gate, the doc-routing-leak pass (BLOCK_DOCROUTE, the WEAKEST layer),
# the fail-open ERR-trap posture, and the two-line emit contract.
#
# SECOND DETECTION PASS (doc-routing-leak, the WEAKEST layer — NOT the confidence anchor): flags an
# intel-reporter / intel-planner spawn hardcoding a local FS path as a Target with NO monitor-POST /
# clauded-docs routing instruction. Workflow-script mirror of the runtime PreToolUse(Write) hook
# (block-doc-routing-leak.sh); defense-in-depth, fail-open dominant. Details at the doc-routing helper.
#
# HONEST SCOPE — STATIC HEURISTIC (string/pattern scan), NOT a full parse and NOT DEV-verdict
# enforcement. It verifies the declaration is PRESENT and CONSISTENT with the code's spawns; it does
# NOT verify a feasible verdict was emitted or that a gating expression consumes it (those stay the
# orchestrator's honor-system authoring obligation). ASYMMETRIC SCAN (P0): spawn/target tokens scan
# the comment-STRIPPED source (a commented spawn is not a real one); author self-attestation tokens
# ([ENTRY-CLASS], [SIZE-EST], plan-ref, monitor-POST) scan RAW src (identical weight in a comment or
# a string). The [AGENT-COMPOSITION] block scans RAW-but-not-inside-a-string. FAIL-OPEN DOMINANT: any
# ambiguity (python3 absent · helper error · output outside the enumerated BLOCK_* tokens) → exit 0.
#
# KNOWN LIMITATION / ACCEPTED FALSE-NEGATIVE (reported honestly): a fully-COMPUTED spawn whose
# agentType resolves only at runtime (e.g. agent('x', {agentType: chosen})) with ZERO dev-* literals
# ANYWHERE is invisible to Tier A, so the script reads as non-DEV → Stage-2 EXEMPT → PASS. This is a
# PRE-EXISTING blind spot (Tier-A-blind by construction), retained UNCHANGED by the declaration
# contract and accepted as a fail-open false-negative (a missed bypass beats a false BLOCK of a
# legitimate workflow); pinned by the F7 accepted-FN bats fixture. The prior "co-located DEV cannot be
# proven a verifier" false-negative is GONE — roles are DECLARED now, not inferred from layout.
# DEV-verdict correctness itself stays the orchestrator honor-system authoring obligation.
#
# STRICTNESS-SWITCH BOUNDARY: fail-open protects an honest author from HOOK/ENVIRONMENT uncertainty
# (tooling absent, undecodable envelope, parser crash) — those stay PASS. A well-formed sentinel pair
# containing garbage is NOT hook uncertainty; it is a broken contract artifact, fully decidable, with
# a deterministic fix → strict BLOCK. The switch lives INSIDE the found-sentinel branch, so a crash
# BEFORE a non-string opening sentinel is detected stays fail-open (accepted residual).
#
# CONDITIONAL ACTIVATION (unverified binding): whether the harness fires PreToolUse(Workflow) with
# tool_input.script exposed is NOT empirically confirmed. Fail-open by design, so wiring is SAFE even
# if the event never fires — it no-ops on any envelope mismatch. Verify firing with a runtime probe.
#
# FIRING INSTRUMENTATION (passive probe): on EVERY invocation reaching the Workflow decision point, a
# one-line trace is appended to ${HOME}/.claude/data/workflow-gate-fired.log (timestamp · tool_name ·
# verdict · script-length). Trace verdict tags: pass · pass-noscript · block-nodecl · block-grammar ·
# block-norev · block-noverifydev · block-declspawn · block-undecl · block-computed · block-order ·
# block-upstream · block-docroute · block-entry · block-sizeest; python3-absent / helper-error
# fallbacks emit bare "pass". How to check: `cat ~/.claude/data/workflow-gate-fired.log`. The trace is
# fail-SAFE (a logging error NEVER changes the verdict/exit code — the verdict is decided first).
#
# Exit codes: 0 = pass / fail-open (default) · 2 = BLOCK. The exit-2 verdicts share the block channel:
#   missing-declaration (block-nodecl) · malformed-declaration (block-grammar) · the five
#   consistency-check causes above · zero-reviewer (block-norev) · verify-team-lacks-DEV
#   (block-noverifydev) · doc-routing leak (block-docroute) · entry-miss (block-entry) ·
#   size-attestation-miss (block-sizeest).
# Channel: STDERR for the block reason (PreToolUse block surface) · exit 2 signals the block.
# fail-open: script absent/empty/unparseable · no DEV spawn (simple workflow, Stage-2 exempt) ·
#            wrong tool_name · any internal error → exit 0.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — a gate that errors MUST NOT block a legitimate workflow.
trap 'printf "[enforce-workflow-verify-stage] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# DEV-set — core-compliance-matrix.md Scope Legend canonical DEV agents. Space-separated tokens for
# bash 3.2 (no declare -A). AUTO-SYNCED from the scope-dev.md DEV roster by agent_lifecycle (the
# add/delete transaction + `python -m agent_lifecycle sync-gate-roster`) — do NOT hand-edit. Mirrors
# the DEV_SET in enforce-verification-gate.sh. The declaration grammar validates agent names against
# THIS single runtime roster (never a second hardcoded list) so a newly created dev agent is accepted
# the moment sync-gate-roster runs.
readonly DEV_SET="glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-dev-swift"

# Firing-trace log path (passive probe). Lives in the live runtime data dir alongside
# session-spawns/. WORKFLOW_GATE_FIRED_LOG override exists for Bats fail-safe testing only —
# default resolves to the real runtime path.
WORKFLOW_GATE_FIRED_LOG="${WORKFLOW_GATE_FIRED_LOG:-${HOME}/.claude/data/workflow-gate-fired.log}"

# Firing-trace line cap. emit_trace appends one line per Workflow firing with no rotation, so a
# long-lived install grows the log unboundedly (no SessionStart reaper sweeps it). The trace is
# observability-only — never read for a verdict — so the prune is verdict-safe BY CONSTRUCTION
# (no line carries decision signal; bounding to the most-recent N lines changes nothing the gate
# reads). Mirrors enforce-verification-gate.sh's marker cap.
readonly DEFAULT_TRACE_LINE_CAP=1000
trace_line_cap="${WORKFLOW_GATE_FIRED_LOG_CAP:-${DEFAULT_TRACE_LINE_CAP}}"
# Non-integer / zero override → default (fail-safe: a bad cap must never disable trace pruning).
if [[ ! "${trace_line_cap}" =~ ^[1-9][0-9]*$ ]]; then
  trace_line_cap="${DEFAULT_TRACE_LINE_CAP}"
fi

# LINT_MODE — 0 = the real PreToolUse(Workflow) envelope path (default) · 1 = the offline --lint preview
# path (--lint flag set below). The offline path reuses the IDENTICAL verdict helper + dispatch, but MUST
# have NO side effects: LINT_MODE=1 makes emit_trace a no-op so a preview never appends to the firing log.
LINT_MODE=0

# emit_trace VERDICT SCRIPT_LEN — append one firing-trace line, FAIL-SAFE.
# The verdict is ALWAYS decided before this runs; every failure mode here (unwritable dir, mkdir
# refusal, printf error) is swallowed so the trace can NEVER alter the hook's exit code or verdict.
# Subshell + `|| true` isolates the ERR trap: a logging error must not trip the fail-open trap and
# must not leak a non-zero status into `set -e`. Best-effort only.
emit_trace() {
  # LINT preview path is side-effect-free: never append to the firing log (verdict/exit stay identical).
  [[ "${LINT_MODE:-0}" == "1" ]] && return 0
  local verdict="${1}" script_len="${2}"
  (
    local log_dir ts
    log_dir="$(dirname -- "${WORKFLOW_GATE_FIRED_LOG}")"
    mkdir -p -- "${log_dir}" 2>/dev/null || exit 0
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || ts="unknown"
    printf '%s\ttool_name=%s\tverdict=%s\tscript_len=%s\n' \
      "${ts}" "Workflow" "${verdict}" "${script_len}" \
      >>"${WORKFLOW_GATE_FIRED_LOG}" 2>/dev/null || exit 0
    # Fail-safe prune — bound the trace log to trace_line_cap lines (most-recent retention). The
    # log is observability-only, so this can NEVER alter a verdict; any error here is swallowed
    # (the log stays as-is) so pruning never breaks the trace it bounds. Empty-pattern grep -c
    # counts lines without the `|| echo 0` "0\n0" trap.
    local line_count
    line_count="$(grep -c '' "${WORKFLOW_GATE_FIRED_LOG}" 2>/dev/null || true)"
    [[ -z "${line_count}" ]] && line_count=0
    [[ "${line_count}" =~ ^[0-9]+$ ]] || exit 0
    ((line_count <= trace_line_cap)) && exit 0
    # Over cap: keep the most recent trace_line_cap lines via an atomic sibling-temp swap.
    local tmp_path
    tmp_path="$(mktemp "${WORKFLOW_GATE_FIRED_LOG}.prune.XXXXXX" 2>/dev/null)" || exit 0
    if tail -n "${trace_line_cap}" "${WORKFLOW_GATE_FIRED_LOG}" >"${tmp_path}" 2>/dev/null; then
      mv -f "${tmp_path}" "${WORKFLOW_GATE_FIRED_LOG}" 2>/dev/null || rm -f "${tmp_path}" 2>/dev/null || true
    else
      rm -f "${tmp_path}" 2>/dev/null || true
    fi
  ) 2>/dev/null || true
}

# block_and_exit REASON TRACE_TAG — terminal block: stderr reason + firing trace + exit 2. Shared by
# every exit-2 verdict — only the reason text and the trace tag differ. ${script_len} is read from
# the global set after the script decode.
#
# CENTRALIZED ENTRY ADDENDUM (message-only) — when the block is one that SUPPRESSES the dedicated
# entry-miss nudge (a composition/verify cause tag or the docroute verdict all pre-empt the entry-miss
# block) AND the entry signal is missing (${entry_marker:-} == ENTRY_ADVISORY), append the entry-format
# requirement to the SAME message so the author resolves both needs in one pass. ALLOWLIST gate
# (ADR-2): explicit enumeration — NO block-* glob; "block-entry" is EXCLUDED (it already prints full
# entry guidance) and "block-sizeest" is EXCLUDED (deliberate ADR-2 opt-OUT: block-sizeest fires ONLY
# under ENTRY_OK — the entry-miss block above has already exited on ENTRY_ADVISORY — so the entry
# addendum is structurally inert on it), and a future block path must opt IN deliberately (fail-safe
# vs silent scope-creep). block-grammar is opt-IN: a malformed declaration on an entry-missing DEV
# workflow needs both fixes surfaced together.
# Reads the GLOBAL entry_marker via ${entry_marker:-} — NO `local entry_marker` (a local would shadow
# the global with an empty value and silently disable the addendum on every path); the :- default is
# mandatory for set -u safety because this function runs under the fail-open ERR trap (an unbound-var
# error would fail-open to exit 0 and silently drop a legitimate block). The addendum is a
# single-quoted heredoc (no expansion -> injection-safe). MESSAGE-ONLY: verdict logic, branch
# conditions, the exit code (always 2), and emit_trace tag semantics are all unchanged.
block_and_exit() {
  local reason="${1}"
  local addendum_allowed
  case "${2}" in
    block-nodecl | block-grammar | block-norev | block-noverifydev | block-declspawn | block-undecl | block-computed | block-order | block-upstream | block-docroute) addendum_allowed=true ;;
    *) addendum_allowed=false ;;
  esac
  if [[ "${addendum_allowed}" == true && "${entry_marker:-}" == "ENTRY_ADVISORY" ]]; then
    reason="${reason}"$'\n\n'"$(
      cat <<'EOF'
ADDITIONALLY (entry classification / plan-reference also required): beyond the block above, this Workflow script spawns DEV agent(s) with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification — so once the issue above is fixed it will STILL be blocked for a missing entry signal. Resolve BOTH in one pass. Two ways to supply the entry signal: (1) PERSIST the plan to the monitor (POST /api/clauded-docs) and reference the minted clauded-docs/<N> id in the workflow script (=> plan-reference token); (2) if GENUINELY simple (none of the sizable criteria hold — see scope-dev.md Sprint Contract Gate), record an [ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line> classification in the workflow script. CAUTION: do NOT mint a throwaway token-doc purely to harvest a clauded-docs id — persist a REAL plan. Placement is not enforced (these tokens are raw-scanned), so a commented token also satisfies it.
EOF
    )"
  fi
  printf '%s\n' "${reason}" >&2
  emit_trace "${2}" "${script_len}"
  exit 2
}

# print_resilience_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit code). The
# DECISION of whether to fire moved INTO the python3 verdict helper (#45): the helper runs a PER-CALL-SITE
# scan (a schema-mode agent spawn whose call is NOT .catch-chained, NOT inside a try block, NOT routed
# through a robustAgent-style wrapper, and NOT inside a custom-named wrapper whose own call is
# .catch-chained counts as UNHANDLED) and returns a RESIL_ADVISE / RESIL_SILENT flag on its THIRD output
# line. This function only PRINTS the nudge when the caller read RESIL_ADVISE. The scan applies to ANY
# schema-mode workflow (DEV or non-DEV — the dev-gate was removed since the crashed runs were non-DEV
# researcher/reporter fan-outs). Moving the scan into the helper closes the prior WHOLE-SCRIPT
# false-negative where ONE robustAgent/catch token ANYWHERE silenced the advisory for N still-bare schema
# spawns. Per-site residual undecidability (Promise.allSettled, deeper indirection) stays uncredited —
# which is exactly why this remains advisory-only, fail-open (a surviving advisory MAY be a false alarm,
# and it NEVER blocks).
print_resilience_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY (resilience, non-blocking): this workflow spawns a schema-mode agent() with at least one UNHANDLED spawn site (not .catch-chained, not inside a try{}, not routed through a robustAgent or custom .catch-chained wrapper). A schema-mode agent() THROWS on non-emit (uncaught → crashes the run) — wrap every schema-mode agent() in robustAgent so .catch(() => null) converts the throw to a handled null, via the retry-once-on-null + .catch(() => null) + .filter(Boolean) idiom (copy-verbatim skeleton: skills/glass-atrium-ops-orchestrator.md '### Resilient Workflow Authoring' + the '### Pipeline Acceptance Criteria' in-script verify-stage). PER-SITE scan with residual undecidability: Promise.allSettled + custom-helper indirection remain uncredited, so a surviving advisory MAY be a false alarm — ADVISORY ONLY, this check NEVER blocks." >&2
  return 0
}

# print_analysis_size_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit code). The
# DECISION fires INSIDE the python3 verdict helper: a schema-mode NON-DEV analysis/research/audit spawn
# (an agent()/agentType literal NOT in the sync-gate-roster-fed DEV_SET) with NO [SIZE-EST] token, on a
# NON-DEV workflow (a DEV workflow is already hard-blocked by BLOCK_SIZEEST, unchanged). It returns an
# ANALYSIS_SIZE_ADVISE / ANALYSIS_SIZE_SILENT flag on its FOURTH output line. Advisory (not exit 2) is
# deliberate: the analysis roster is exclusion-derived + broad, so a nudge cannot false-block a legit
# workflow — matching the resilience-advisory posture + the plan (clauded-docs/279 D2) fail-open floor.
print_analysis_size_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY (analysis size-attestation, non-blocking): this workflow spawns a schema-mode NON-DEV analysis/research/audit agent (researcher/planner/reporter/reviewer) but carries NO [SIZE-EST] delegation-size token. A single broad-read + high-effort + 3-4-field schema agent exhausts the turn budget before the terminal StructuredOutput (the non-emit failure class). RIGHT-SIZE at Decision time: emit the analysis-mode token log('[SIZE-EST] reads~=N fields=N effort=<medium|high> scope=<allowlist|bounded> — <reason>'), and if reads~ > ~20 OR fields > 3 OR (broad scope AND effort:high) SPLIT by domain into N narrow agents up front (never one broad agent then a reactive split). Bound each track: a file/dir read allowlist (NOT a repo sweep), effort matched to depth (default medium for broad reads; high only for narrow deep reasoning), <=2-3 output fields, and a HARD BUDGET guard ('STOP and EMIT partial when approaching ~N tool uses'). Presence-only, never estimate correctness — parity with the DEV [SIZE-EST]. ADVISORY ONLY, this check NEVER blocks (fail-open on ambiguous shapes)." >&2
  return 0
}

# ==== author-facing scaffold emitters (single SoT — reused by both a BLOCK remediation AND --template) ===
# Keeping the copy-paste examples in ONE function each guarantees the block-reason stderr the gate emits
# and the --lint --template preview can NEVER drift apart. Single-quoted heredocs = no expansion (the
# <…> placeholders + $HOME-style paths stay literal, injection-safe).

# emit_composition_scaffold — the two canonical [AGENT-COMPOSITION] declaration forms (in-script verify
# team + upstream). SoT reused by the BLOCK_NODECL remediation and print_lint_template.
emit_composition_scaffold() {
  cat <<'EOF'
  --- in-script verify form (the Stage-2 {qa-code-reviewer, DEV} pair lives in THIS script) ---
  /* [AGENT-COMPOSITION]
  verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
  impl: glass-atrium-dev-nestjs
  [/AGENT-COMPOSITION] */

  --- upstream form (this workflow EXECUTES an already-verified persisted plan; waives the in-script pair) ---
  /* [AGENT-COMPOSITION]
  verify: upstream clauded-docs/<N>
  impl: glass-atrium-dev-shell
  impl-computed: glass-atrium-dev-node
  [/AGENT-COMPOSITION] */
  NOTE: impl-computed is OPTIONAL — include it ONLY for indirect/computed spawns; with none, OMIT the line
  entirely. `impl-computed: none` is malformed (only impl: accepts the `none` literal) and blocks as block-grammar.
EOF
}

# emit_entry_token_scaffold — the plan-ref (path 1) / [ENTRY-CLASS] (path 2) entry-signal tokens. SoT
# reused by the entry-miss remediation and print_lint_template.
emit_entry_token_scaffold() {
  cat <<'EOF'
  --- path (1): persisted plan (sizable DEV work — the DEFAULT) ---
  log('plan-ref: clauded-docs/<DOC_ID>');

  --- path (2): genuinely simple, none of the sizable criteria hold ---
  log('[ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line>');
EOF
}

# print_lint_template — --lint --template output: the full author self-attestation scaffold assembled
# from the SAME scaffold emitters the gate's block remediations use (so the taught template is exactly
# what the gate accepts). The [SIZE-EST] line mirrors the BLOCK_SIZEEST remediation format.
print_lint_template() {
  cat <<'EOF'
[enforce-workflow-verify-stage] --lint --template: canonical author self-attestation scaffold for a DEV-spawning Workflow script. Paste ONE [AGENT-COMPOSITION] form into a /* */ block comment, plus ONE entry token and the [SIZE-EST] token, then preview with: enforce-workflow-verify-stage.sh --lint <file> (exit 0 = will pass the gate).

[AGENT-COMPOSITION] declaration (pick ONE form):
EOF
  emit_composition_scaffold
  cat <<'EOF'

Entry signal (pick ONE path):
EOF
  emit_entry_token_scaffold
  cat <<'EOF'

Delegation-size self-attestation (at EVERY DEV spawn — ONE [SIZE-EST] token, two modes):
  --- DEV mode ---
  log('[SIZE-EST] bundles=N tool_uses~=N — <reason>');
  --- analysis mode (schema-mode NON-DEV researcher/planner/reporter/reviewer spawn) ---
  log('[SIZE-EST] reads~=N fields=N effort=<medium|high> scope=<allowlist|bounded> — <reason>');
  RIGHT-SIZE the analysis spawn: reads~ > ~20 OR fields > 3 OR (broad scope AND effort:high) → SPLIT by
  domain into N narrow agents up front. Default effort=medium for broad reads; high only for narrow deep
  reasoning. Bound the read scope to a file/dir allowlist (never a repo sweep) and cap output fields <=3.
EOF
}

# run_verdict_and_dispatch — the shared decode-to-dispatch TAIL, called by BOTH the hook envelope path
# and the --lint preview path. It operates on the globals script_src + script_len (set by the caller)
# and reuses the IDENTICAL verdict helper + DEV_SET + verdict dispatch, so a --lint preview verdict is
# the gate verdict BY CONSTRUCTION (never a drift-prone reimplementation). emit_trace is LINT_MODE-guarded
# so the preview writes zero trace lines; every verdict / exit path is otherwise unchanged.
run_verdict_and_dispatch() {
  # python3 absent is a system misconfiguration — fail-open (never block on a tooling gap). In lint mode
  # emit_trace no-ops, so this is a clean "will pass" exit 0.
  if ! command -v python3 >/dev/null 2>&1; then
    emit_trace "pass" "${script_len}"
    exit 0
  fi

  # Verdict helper. Reads DEV_SET (arg 1) + the script (stdin). Prints exactly a verdict token + marker.
  # Any internal exception → the helper itself prints PASS (belt-and-suspenders fail-open), and the bash
  # side ALSO treats a non-enumerated / errored helper as PASS.
  local verdict_py
  verdict_py="$(
    cat <<'PY'
import sys, re

# --- retained: plan-ref / attestation literals (entry + size + docroute) ---
PLAN_REF_RE = re.compile(
    r"clauded-docs/[0-9]+"
    r"|[A-Za-z0-9_./-]*plan[A-Za-z0-9_-]*\.html"
    r"|documents/[A-Za-z0-9_./-]+\.html"
    r"|(^|[^A-Za-z0-9_])plan-[0-9]+([^A-Za-z0-9]|$)"
    r"|(^|[^A-Za-z0-9_])[0-9]+-plan([^A-Za-z0-9]|$)"
)
ENTRY_CLASS_LITERAL = "[ENTRY-CLASS] simple-task"
SIZE_EST_LITERAL = "[SIZE-EST]"
DOC_ROUTE_LOCAL_LITERAL = "[DOC-ROUTE] user-requested-local:"
LOCAL_PATH_SHAPE = r"(?:~|\$HOME|\$\{HOME\}|/)[A-Za-z0-9_./-]*"
LEFT_BOUNDARY = r"(?<![A-Za-z0-9_.-])"
# NOTE bash-3.2 $(...)-scan constraint: comments in this heredoc must keep quote chars in immediate
# balanced pairs (no bare apostrophes) and parens balanced, or the outer command substitution
# mis-parses on stock macOS bash.
TOKEN_LINE_RE = re.compile(
    re.escape(DOC_ROUTE_LOCAL_LITERAL) + r"\s*(" + LOCAL_PATH_SHAPE + r"\.[A-Za-z0-9]+)"
)
DOC_AGENT_SET = ("glass-atrium-intel-reporter", "glass-atrium-intel-planner")
LOCAL_TARGET_RE = re.compile(
    r"target\s+file\s*:"
    + r"|mkdir\s+-p[^\n]{0,200}?(?:&&|;|then)[^\n]{0,80}?\bwrite\b"
    + r"|\b(?:write|output)\b[^\n]{0,80}?\bto\b[^\n]{0,80}?" + LEFT_BOUNDARY + r"(?:~|\$HOME|/)[^\s'\"]*\.(?:md|markdown|html|yaml|yml|json|txt)"
    + r"|\b(?:save|deliver|store|persist)\b[^\n]{0,80}?\b(?:to|into|under|as)\b[^\n]{0,60}?" + LEFT_BOUNDARY + LOCAL_PATH_SHAPE + r"\.md\b"
    + r"|" + LOCAL_PATH_SHAPE + r"\.(?:html|markdown)\b"
    + r"|\b(?:deliverable|destination|final\s+location)\s*:[^\n]{0,120}?" + LOCAL_PATH_SHAPE + r"\.md\b",
    re.IGNORECASE,
)
MONITOR_POST_RE = re.compile(
    r"clauded-docs" r"|/api/clauded-docs" r"|monitor[- ]?post"
    r"|POST[^\n]{0,40}?(?:monitor|clauded)" r"|127\.0\.0\.1:16145"
    r"|html_body" r"|doc_status",
    re.IGNORECASE,
)

# --- [AGENT-COMPOSITION] declaration grammar ---
COMPOSITION_RE = re.compile(r"\[AGENT-COMPOSITION\](.*?)\[/AGENT-COMPOSITION\]", re.DOTALL)
OPEN_SENTINEL_RE = re.compile(r"\[AGENT-COMPOSITION\]")
UPSTREAM_RE = re.compile(r"^upstream\s+(clauded-docs/[0-9]+|plan-ref)$", re.IGNORECASE)
REVIEWER_LITERAL = "glass-atrium-qa-code-reviewer"
# Strict key set. impl-computed BEFORE impl so the longer prefix wins the startswith scan.
KNOWN_KEYS = ("verify", "impl-computed", "impl")
# Free-text delimiter: a spaced dash (em-dash / en-dash / hyphen) — agent-name hyphens are never
# spaced, so this never mis-splits an agent list. — / – keep the source ASCII.
FREE_TEXT_RE = re.compile(r"\s[—–-]\s")

# --- JS regex-literal disambiguation (shared by strip_comments AND _string_mask, kept in parity) ---
# A slash begins a regex literal only in an expression-start context; after a value it is division.
# The bracket glyphs are injected via chr() so this heredoc stays balanced for the bash-3.2 $(...)-scan
# (mirrors the chr(40) note below): chr(40)=open-paren, chr(91)=open-bracket, chr(123)/chr(125)=braces.
_REGEX_PREV_CHARS = frozenset("=,:;!&|?+-*%^~<>" + chr(40) + chr(91) + chr(123) + chr(125))
_REGEX_PREV_KEYWORDS = frozenset((
    "return", "typeof", "instanceof", "in", "of", "new",
    "delete", "void", "case", "do", "else", "yield", "await",
))


def _regex_allowed_before(src, i):
    # Decide whether a slash at index i begins a JS regex literal (True) or is a division operator
    # (False), from the last significant context before i. Regex-permitting: after an operator or an
    # open bracket/paren/brace, after a regex-context keyword word, or at start-of-line/input. Division:
    # after an identifier, a number, a close bracket/paren, or a string/regex end. Any division context
    # returns False so the slash falls back to the pre-existing behavior (no NEW false positive).
    j = i - 1
    # Skip horizontal whitespace only; a newline (or input start) is a line boundary => regex-permitting.
    while j >= 0 and src[j] in " \t\r\f\v":
        j -= 1
    if j < 0:
        return True
    ch = src[j]
    if ch == "\n":
        return True
    if ch in _REGEX_PREV_CHARS:
        return True
    if ch.isalnum() or ch == "_" or ch == "$":
        k = j
        while k >= 0 and (src[k].isalnum() or src[k] == "_" or src[k] == "$"):
            k -= 1
        return src[k + 1:j + 1] in _REGEX_PREV_KEYWORDS
    return False


def _regex_literal_end(src, i):
    # Shared JS-regex-literal span scanner for strip_comments AND _string_mask; keeping ONE scanner
    # guarantees the two lexers stay in parity (the #29 requirement) so the sentinel-extraction mask
    # never desyncs from the antigaming token scan. Precondition: src[i] is the opening regex slash.
    # Returns the end index -- one past the unescaped closing slash, OR the terminating newline / EOF
    # index (a JS regex literal cannot span a raw newline, so any mis-detection is bounded to one line).
    # Escapes are honored; a slash inside a [...] character class does NOT terminate.
    n = len(src)
    j = i + 1
    in_class = False
    while j < n:
        rc = src[j]
        if rc == '\n':
            break
        if rc == '\\':
            if j + 1 < n and src[j + 1] != '\n':
                j += 2
                continue
            j += 1
            continue
        if rc == '[':
            in_class = True
        elif rc == ']':
            in_class = False
        elif rc == '/' and not in_class:
            j += 1
            break
        j += 1
    return j


def strip_comments(src):
    # String-aware removal of // line comments and /* */ block comments. Newlines are preserved inside
    # BOTH comment kinds so the output keeps source-line identity (the [DOC-ROUTE] suppressor is
    # line-scoped and must never see two source lines merged).
    out = []
    i, n = 0, len(src)
    in_str = None
    in_line_c = False
    in_block_c = False
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if in_line_c:
            if c == '\n':
                in_line_c = False
                out.append(c)
            i += 1
            continue
        if in_block_c:
            if c == '*' and nxt == '/':
                in_block_c = False
                i += 2
                continue
            if c == '\n':
                out.append(c)
            i += 1
            continue
        if in_str is not None:
            out.append(c)
            if c == '\\':
                if nxt:
                    out.append(nxt)
                    i += 2
                    continue
            elif c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', '`'):
            in_str = c
            out.append(c)
            i += 1
            continue
        if c == '/' and nxt == '/':
            in_line_c = True
            i += 2
            continue
        if c == '/' and nxt == '*':
            in_block_c = True
            i += 2
            continue
        if c == '/' and _regex_allowed_before(src, i):
            # JS regex literal (division ruled out by the context check; nxt is neither / nor * here,
            # those two branches already consumed). Emit VERBATIM so an inner // or /* or quote is NOT
            # mis-lexed as a comment/string. Span + termination come from the shared _regex_literal_end
            # (the single source of truth kept in parity with _string_mask).
            end = _regex_literal_end(src, i)
            out.append(src[i:end])
            i = end
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def _string_mask(src):
    # True at char positions INSIDE a JS string literal (single/double/backtick, backslash-aware).
    # Comment content is NOT masked, so a sentinel inside a /* */ comment stays extractable while a
    # sentinel inside a string literal is masked out (inert). This is the provenance discriminator: a
    # worked example quoted into a delegation prompt lives in a string and can never bind.
    mask = bytearray(len(src))
    i, n = 0, len(src)
    in_str = None
    in_line_c = in_block_c = False
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if in_line_c:
            if c == '\n':
                in_line_c = False
            i += 1
            continue
        if in_block_c:
            if c == '*' and nxt == '/':
                in_block_c = False
                i += 2
                continue
            i += 1
            continue
        if in_str is not None:
            mask[i] = 1
            if c == '\\' and nxt:
                mask[i + 1] = 1
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', '`'):
            in_str = c
            i += 1
            continue
        if c == '/' and nxt == '/':
            in_line_c = True
            i += 2
            continue
        if c == '/' and nxt == '*':
            in_block_c = True
            i += 2
            continue
        if c == '/' and _regex_allowed_before(src, i):
            # JS regex literal — leave UNMASKED (mask stays 0, the default) so a slash-heavy regex is NOT
            # read as an opening string quote. Span + termination come from the shared _regex_literal_end
            # (parity is load-bearing: the two lexers must agree, or the sentinel-extraction masked_src
            # diverges from the antigaming_src token scan).
            i = _regex_literal_end(src, i)
            continue
        i += 1
    return mask


def extract_composition(raw_src):
    # Extract the [AGENT-COMPOSITION] body with a string-literal guard. String-masked characters are
    # BLANKED to spaces BEFORE any sentinel scan — masked_src is offset-preserving, so match spans
    # stay valid against raw_src for downstream position use. Scanning RAW src with post-hoc start
    # filtering let a string-resident OPENING sentinel steal a non-greedy DOTALL match through the
    # REAL block closing sentinel, mis-reading a genuine declaration as unterminated; BOTH the block
    # finditer AND the stray-open fallback therefore run over the SAME masked_src. Comment interiors
    # are never masked, so a comment-resident body is byte-identical. Returns (body, status, span):
    #   "ok"           -> body is the declaration text between the sentinels; span = its (start, end)
    #                     offsets in raw_src.
    #   "none"         -> no non-string opening sentinel -> caller BLOCK_NODECL on a DEV workflow.
    #   "unterminated" -> a non-string opening sentinel with NO matching close -> BLOCK_GRAMMAR
    #                     (the author opted INTO the contract; fail-opening would silently void it).
    #   "duplicate"    -> 2+ non-string complete blocks -> BLOCK_GRAMMAR (ambiguous authority).
    # A sentinel that opens INSIDE a string literal is treated as absent (an incidental prompt/goal
    # mention is not a declaration).
    mask = _string_mask(raw_src)
    masked_src = "".join(" " if mask[i] else c for i, c in enumerate(raw_src))
    blocks = list(COMPOSITION_RE.finditer(masked_src))
    if len(blocks) >= 2:
        return None, "duplicate", None
    if len(blocks) == 1:
        return blocks[0].group(1), "ok", blocks[0].span()
    if OPEN_SENTINEL_RE.search(masked_src):
        return None, "unterminated", None
    return None, "none", None


def parse_composition(body, dev_set):
    # STRICT line-grammar validator. Returns (decl, err): decl is the structured roles dict on success,
    # err is None on success or a short reason string on a decidable author error (caller BLOCK_GRAMMAR).
    # Every non-empty line MUST start with a known key + colon; ONE line per key; names validated
    # against dev_set + the reviewer literal; free text only after a spaced-dash delimiter.
    dev_valid = set(d for d in dev_set if d)
    seen = set()
    verify_reviewers = []
    verify_devs = []
    impl_devs = []
    impl_computed = []
    upstream = False
    upstream_ref_text = None
    verify_seen = False
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        low = line.lower()
        this_key = None
        for k in KNOWN_KEYS:
            if low.startswith(k + ":"):
                this_key = k
                break
        if this_key is None:
            return None, "unknown-or-malformed-line"
        if this_key in seen:
            return None, "duplicate-key"
        seen.add(this_key)
        val = line.split(":", 1)[1]
        agents_part = FREE_TEXT_RE.split(val, 1)[0].strip()
        if this_key == "verify":
            verify_seen = True
            um = UPSTREAM_RE.match(agents_part)
            if um:
                upstream = True
                upstream_ref_text = um.group(0)
                continue
            if agents_part.lower().startswith("upstream"):
                return None, "malformed-upstream"
            names = [t.strip() for t in agents_part.split(",") if t.strip()]
            if not names:
                return None, "empty-verify"
            for t in names:
                if t == REVIEWER_LITERAL:
                    verify_reviewers.append(t)
                elif t in dev_valid:
                    verify_devs.append(t)
                else:
                    return None, "unknown-name"
            if len(set(verify_devs)) > 1:
                return None, "verify-multiple-dev-types"
        elif this_key == "impl-computed":
            names = [t.strip() for t in agents_part.split(",") if t.strip()]
            for t in names:
                if t in dev_valid:
                    impl_computed.append(t)
                else:
                    return None, "unknown-name"
        elif this_key == "impl":
            names = [t.strip() for t in agents_part.split(",") if t.strip()]
            for t in names:
                if t.lower() == "none":
                    continue
                if t in dev_valid:
                    impl_devs.append(t)
                else:
                    return None, "unknown-name"
    if not verify_seen:
        return None, "missing-verify"
    return {
        "upstream": upstream,
        "upstream_ref_text": upstream_ref_text,
        "verify_reviewers": verify_reviewers,
        "verify_devs": verify_devs,
        "impl_devs": impl_devs,
        "impl_computed": impl_computed,
    }, None


def detect_docroute_leak(antigaming_src, attestation_src):
    # SECOND (weakest) detection pass — doc-routing leak. Returns True ONLY when a doc-agent spawn is
    # present, a hardcoded local-FS Target shape is present, NO monitor-POST signal exists, and the
    # leak line is NOT covered by a [DOC-ROUTE] user-requested-local stamp. FAIL-OPEN DOMINANT.
    doc_re = re.compile(r"['\"](" + '|'.join(re.escape(a) for a in DOC_AGENT_SET) + r")['\"]")
    if not doc_re.search(antigaming_src):
        return False
    if MONITOR_POST_RE.search(attestation_src):
        return False
    scan_src = antigaming_src
    stamped_paths = [p for p in TOKEN_LINE_RE.findall(attestation_src) if len(p) >= 4]
    if stamped_paths:
        scan_src = "\n".join(
            line for line in antigaming_src.splitlines()
            if not any(p in line for p in stamped_paths)
        )
    if not LOCAL_TARGET_RE.search(scan_src):
        return False
    return True


def _chained_catch(struct, close_idx, n):
    # Scan forward from the char after close_idx for a chained .then / .catch member; return True if a
    # .catch member appears in the chain before the statement continuation. struct has string interiors
    # blanked, so a member call arg list is paren-matched cleanly. Caller wraps this fail-open.
    i = close_idx + 1
    while i < n:
        while i < n and struct[i] in " \t\r\n\f\v":
            i += 1
        if i >= n or struct[i] != ".":
            return False
        i += 1
        j = i
        while j < n and (struct[j].isalnum() or struct[j] == "_" or struct[j] == "$"):
            j += 1
        if struct[i:j] == "catch":
            return True
        k = j
        while k < n and struct[k] in " \t\r\n\f\v":
            k += 1
        if k < n and struct[k] == chr(40):
            depth = 0
            while k < n:
                if struct[k] == chr(40):
                    depth += 1
                elif struct[k] == chr(41):
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            if k >= n:
                return False
            i = k + 1
        else:
            i = j
    return False


def resilience_advisory_needed(stripped):
    # ADVISORY-ONLY per-site schema-spawn resilience scan (never alters the verdict; the caller only
    # prints a stderr nudge). Returns True when at least ONE UNHANDLED schema-mode agent-call site
    # remains in ANY workflow (DEV or non-DEV). The DEV gate is GONE (#widen): the crashed runs were
    # non-DEV researcher/reporter fan-outs, so a schema-mode agent() throws-on-non-emit crash is not a
    # DEV-only failure mode — every schema-mode workflow is in scope. FAIL-OPEN: no schema site OR any
    # parse uncertainty returns False (silent). A site is schema-mode when the literal token schema
    # appears within its call arguments. A site is HANDLED when [a] a .catch member is chained onto its
    # call, [b] it sits inside a try block, [c] it sits inside a robustAgent-style wrapper body, or
    # [d] it sits inside a CUSTOM-named wrapper whose OWN invocation is .catch-chained at the join (the
    # qa-named false-positive guard: a bare agent({schema}) inside such a wrapper is already handled at
    # the wrapper call site, so it must NOT be flagged). A spawn routed THROUGH the wrapper [callee
    # robustAgent, not agent] is not an agent-call site at all, so it is never counted.
    try:
        # No schema token anywhere -> no per-site match is possible -> skip the full _string_mask scan
        # (the docstring already lists no-schema-site as a fail-open False; advisory-only, verdict intact).
        if "schema" not in stripped:
            return False
        smask = _string_mask(stripped)
        # struct = stripped with string interiors blanked, so paren/brace matching ignores in-string
        # delimiters. Positions align 1:1 with stripped, so the schema test reads stripped, not struct.
        struct = "".join(" " if smask[k] else ch for k, ch in enumerate(stripped))
        n = len(struct)

        def match_close(open_idx, opench, closech):
            depth = 0
            k = open_idx
            while k < n:
                if struct[k] == opench:
                    depth += 1
                elif struct[k] == closech:
                    depth -= 1
                    if depth == 0:
                        return k
                k += 1
            return None

        # HANDLED-region spans: try blocks + robustAgent-style wrapper bodies, brace-matched over struct.
        # chr(123)/chr(125) keep the heredoc balanced for the bash-3.2 dollar-paren scan.
        handled_spans = []
        for tm in re.finditer(r"(?<![A-Za-z0-9_$])try\b", struct):
            k = tm.end()
            while k < n and struct[k] in " \t\r\n\f\v":
                k += 1
            if k < n and struct[k] == chr(123):
                end = match_close(k, chr(123), chr(125))
                if end is not None:
                    handled_spans.append((k, end))
        for wm in re.finditer(r"(?<![A-Za-z0-9_$])robustAgent(?![A-Za-z0-9_$])", struct):
            brace = struct.find(chr(123), wm.end())
            if brace != -1:
                end = match_close(brace, chr(123), chr(125))
                if end is not None:
                    handled_spans.append((brace, end))

        # FALSE-POSITIVE GUARD [d] (qa-named) — a CUSTOM-named wrapper (any name, not just robustAgent)
        # containing a bare agent({schema}) whose OWN invocation is .catch-chained at the join is HANDLED.
        # Step 1: collect the set of callee identifiers invoked as NAME(...) with a trailing .catch chain
        # (the join is handled there). Step 2: treat the body of any function DEFINITION whose name is in
        # that set as a handled region (same effect as the robustAgent span, generalized to an arbitrary
        # wrapper name). FAIL-OPEN by construction: any paren/brace mismatch simply omits the span (a
        # missed handled region can only make the advisory MORE eager, never block — advisory-only).
        catch_callees = set()
        # NAME(...) callee, excluding a member access (leading dot) so a.b() records nothing here.
        for cm in re.finditer(r"(?<![A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*" + "\\" + chr(40), struct):
            copen = cm.end() - 1
            cclose = match_close(copen, chr(40), chr(41))
            if cclose is None:
                continue
            if _chained_catch(struct, cclose, n):
                catch_callees.add(cm.group(1))
        if catch_callees:
            # function NAME (...) { ... }
            for fm in re.finditer(r"(?<![A-Za-z0-9_$])function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*" + "\\" + chr(40), struct):
                if fm.group(1) not in catch_callees:
                    continue
                pclose = match_close(fm.end() - 1, chr(40), chr(41))
                if pclose is None:
                    continue
                brace = struct.find(chr(123), pclose)
                if brace != -1:
                    end = match_close(brace, chr(123), chr(125))
                    if end is not None:
                        handled_spans.append((brace, end))
            # const|let|var NAME = (...) => { ... } | = function (...) { ... } — first brace after '=' is
            # the arrow/function body (NAME is in catch_callees, so it is invoked, i.e. a function value).
            for fm in re.finditer(r"(?<![A-Za-z0-9_$])(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=", struct):
                if fm.group(1) not in catch_callees:
                    continue
                brace = struct.find(chr(123), fm.end())
                if brace == -1:
                    continue
                end = match_close(brace, chr(123), chr(125))
                if end is not None:
                    handled_spans.append((brace, end))

        unhandled = False
        # The literal open paren is injected as an ESCAPED regex atom via "\\" + chr(40) (yielding the
        # regex fragment for an escaped paren), so the source string carries no unbalanced open paren for
        # the bash-3.2 dollar-paren scan (mirrors the _agent_open idiom below the try block).
        for am in re.finditer(r"(?<![A-Za-z0-9_$])agent\s*" + "\\" + chr(40), struct):
            open_idx = am.end() - 1
            close_idx = match_close(open_idx, chr(40), chr(41))
            if close_idx is None:
                continue
            if "schema" not in stripped[open_idx + 1:close_idx]:
                continue
            call_start = am.start()
            if any(s <= call_start < e for (s, e) in handled_spans):
                continue
            if _chained_catch(struct, close_idx, n):
                continue
            unhandled = True
        return unhandled
    except Exception:
        return False


# Agent-name shape for a spawn-position literal. NON-DEV is defined BY EXCLUSION from the runtime
# dev_set (the sync-gate-roster-fed roster) — NEVER a second hardcoded analysis list. The reviewer +
# intel-researcher/planner/reporter analysis agents are all caught because none is a dev_set member.
ANALYSIS_AGENT_SHAPE = r"glass-atrium-[a-z0-9-]+"


def analysis_size_advisory_needed(stripped, attestation_src, dev_present, dev_set):
    # ADVISORY-ONLY (never a verdict, never exit 2): True when a schema-mode NON-DEV analysis/research/
    # audit spawn exists AND no [SIZE-EST] token is present AND this is NOT already a DEV workflow. The
    # DEV BLOCK_SIZEEST gate (dev_present) already models the same missing token, so a DEV workflow is
    # excluded here to avoid a double-signal — the DEV exit-2 semantics stay UNCHANGED. Heuristic for a
    # schema-mode non-DEV spawn = a schema token in the script + an agent(…)/agentType spawn literal whose
    # name matches the agent shape and is NOT a dev_set member. FAIL-OPEN: [SIZE-EST] present, no schema
    # token, no non-DEV spawn, OR any parse uncertainty → False (silent). Presence-only, never estimate
    # correctness — parity with the DEV [SIZE-EST] honesty floor. Advisory posture (a stderr nudge, not a
    # block) is deliberate: the analysis roster is exclusion-derived + broad, so a nudge cannot false-block
    # a legitimate workflow (matches the resilience-advisory precedent).
    # Known-benign false-POSITIVE (never false-BLOCK) edge cases, deliberately accepted under the
    # fail-open advisory posture: (a) the 'schema' membership test is a whole-script substring scan,
    # and (b) it is decoupled from the per-spawn-site match — so a non-schema-mode non-DEV spawn
    # inside a script that merely mentions 'schema' elsewhere can fire a spurious ADVISORY. Not
    # tightened on purpose: a per-call-site parse adds complexity for a nudge that can only
    # over-advise, never wrongly exit 2.
    try:
        if dev_present:
            return False
        # The [SIZE-EST] token silences BOTH the DEV gate and this analysis advisory (one token, D1).
        if SIZE_EST_LITERAL in attestation_src:
            return False
        # No schema token anywhere → not a schema-mode workflow → out of scope (fail-open silent).
        if "schema" not in stripped:
            return False
        dev_members = set(d for d in dev_set if d)
        # Spawn-position literal: agent(<lit>) OR agentType: <lit>. The literal open paren is injected via
        # chr(40) so the source stays balanced for the bash-3.2 dollar-paren scan (mirrors _agent_open).
        spawn_re = re.compile(
            r"agent" + "\\" + chr(40) + r"\s*['\"](" + ANALYSIS_AGENT_SHAPE + r")['\"]"
            + r"|agentType\s*:\s*['\"](" + ANALYSIS_AGENT_SHAPE + r")['\"]"
        )
        for m in spawn_re.finditer(stripped):
            name = next((g for g in m.groups() if g is not None), None)
            if name is not None and name not in dev_members:
                return True
        return False
    except Exception:
        return False


# RESIL_FLAG — resilience advisory decision, printed as the THIRD helper output line by emit(). Default
# SILENT so a fail-open exit (an exception before the scan) never fires a spurious advisory.
RESIL_FLAG = "RESIL_SILENT"

# ANALYSIS_SIZE_FLAG — schema-mode NON-DEV analysis-spawn size-attestation advisory, printed as the
# FOURTH helper output line by emit(). Default SILENT so a fail-open exit never fires a spurious nudge.
# The DEV [SIZE-EST] gate (BLOCK_SIZEEST) is UNCHANGED — this is the parallel non-DEV advisory branch.
ANALYSIS_SIZE_FLAG = "ANALYSIS_SIZE_SILENT"


def emit(verdict, entry_marker):
    print(verdict)
    print(entry_marker)
    print(RESIL_FLAG)
    print(ANALYSIS_SIZE_FLAG)
    sys.exit(0)


try:
    dev_set = sys.argv[1].split()
    src = sys.stdin.read()
    stripped = strip_comments(src)
    antigaming_src = stripped   # spawn/target tokens: a commented spawn is not a real one
    attestation_src = src       # author self-attestation: same weight in comment or string

    # Resilience advisory decision (#45) — computed early so EVERY emit path carries it on line 3. The
    # scan is decoupled from the verdict: it only sets the advisory flag the bash side prints.
    if resilience_advisory_needed(antigaming_src):
        RESIL_FLAG = "RESIL_ADVISE"

    dev_alt = '|'.join(re.escape(d) for d in dev_set if d)

    # TIER A — broad quoted-literal presence. Feeds dev_present / reviewer-existence / entry / size,
    # AND supplies the Tier-A dev TYPE SET consumed by consistency check (b-prime).
    dev_re_present = re.compile(r"['\"](" + dev_alt + r")['\"]")
    rev_re_present = re.compile(r"['\"]" + REVIEWER_LITERAL + r"['\"]")
    tier_a_dev_types = set(m.group(1) for m in dev_re_present.finditer(antigaming_src))
    dev_present = bool(tier_a_dev_types)

    # TIER B — spawn-position (agent-call first-arg OR agentType field value). The code-side operand
    # of the declaration consistency check. Captures (position, agent-type). bash-3.2 $(...)-scan
    # constraint: the literal open paren is injected via chr(40) so the source stays balanced.
    _agent_open = r"agent" + "\\" + chr(40) + r"\s*"
    _agenttype = r"agentType\s*:\s*"
    _dev_tok = r"['\"](" + dev_alt + r")['\"]"
    _rev_tok = r"['\"](" + REVIEWER_LITERAL + r")['\"]"
    dev_re = re.compile(_agent_open + _dev_tok + r"|" + _agenttype + _dev_tok)
    rev_re = re.compile(_agent_open + _rev_tok + r"|" + _agenttype + _rev_tok)

    def _typed_starts(rx):
        out = []
        for m in rx.finditer(antigaming_src):
            g = next((x for x in m.groups() if x is not None), None)
            out.append((m.start(), g))
        return out

    dev_spawns = _typed_starts(dev_re)          # [(pos, type)]
    rev_spawns = _typed_starts(rev_re)
    rev_starts = [p for (p, _) in rev_spawns]

    # Entry + size-est (Tier-A gated) — retained verbatim.
    plan_ref_found = bool(PLAN_REF_RE.search(attestation_src))
    entry_literal_found = ENTRY_CLASS_LITERAL in attestation_src
    entry_ok = (not dev_present) or plan_ref_found or entry_literal_found
    entry_marker = "ENTRY_OK" if entry_ok else "ENTRY_ADVISORY"
    size_est_missing = dev_present and entry_ok and (SIZE_EST_LITERAL not in attestation_src)

    # ANALYSIS-SIZE advisory (parallel NON-DEV branch) — computed BEFORE the first emit (incl. the
    # `if not dev_present` early PASS at the top of the DEV block) so EVERY emit path carries it on line
    # 4. Advisory-only: it rides the helper output, never a verdict, so the DEV BLOCK_SIZEEST exit-2 path
    # is untouched. dev_present workflows are excluded inside the helper (the DEV gate covers them).
    if analysis_size_advisory_needed(antigaming_src, attestation_src, dev_present, dev_set):
        ANALYSIS_SIZE_FLAG = "ANALYSIS_SIZE_ADVISE"

    def pass_or_size():
        return "BLOCK_SIZEEST" if size_est_missing else "PASS"

    # SECOND detection pass (doc-routing leak) — independent, runs first.
    if detect_docroute_leak(antigaming_src, attestation_src):
        emit("BLOCK_DOCROUTE", entry_marker)

    # No DEV literal anywhere (Tier A) → simple workflow → Stage-2 exempt.
    if not dev_present:
        emit("PASS", entry_marker)

    # DEV workflow → a declaration is REQUIRED. Distinguish ABSENT (nodecl) from a MALFORMED /
    # unterminated / duplicated block (grammar). The strictness switch lives HERE — inside the
    # found-sentinel branch — so a crash before this point stays fail-open.
    body, status, decl_span = extract_composition(attestation_src)
    if status == "none":
        emit("BLOCK_NODECL", entry_marker)
    if status in ("unterminated", "duplicate"):
        emit("BLOCK_GRAMMAR", entry_marker)
    decl, gerr = parse_composition(body, dev_set)
    if gerr is not None:
        emit("BLOCK_GRAMMAR", entry_marker)

    # ZERO-REVIEWER HARD GUARANTEE — evaluated INDEPENDENTLY of declaration form, BEFORE the
    # upstream/in-script split, so the upstream form can NEVER waive it (R1). dev_present (Tier A) +
    # zero Tier-A reviewer literal anywhere → block.
    if not rev_re_present.search(antigaming_src):
        emit("BLOCK_NOREV", entry_marker)

    # Plan-ref evidence OUTSIDE the declaration span (so an upstream clauded-docs/N verify clause
    # cannot self-satisfy check (e) with its own text). Excise EXACTLY the extracted block span from
    # RAW attestation_src: a raw-src COMPOSITION_RE.sub can be stolen by a string-resident opening
    # sentinel (over-deleting code between it and the real block), and subbing over masked_src would
    # drop string-resident plan-ref evidence, which legitimately counts (raw-scanned attestation).
    body_only_src = attestation_src[:decl_span[0]] + "\n" + attestation_src[decl_span[1]:]

    # Code-side spawn type maps + declared type sets.
    dev_types_present = set(t for (_, t) in dev_spawns)
    declared_verify_dev_types = set(decl["verify_devs"])
    declared_impl_dev_types = set(decl["impl_devs"])
    declared_computed_types = set(decl["impl_computed"])
    declared_all_dev_types = declared_verify_dev_types | declared_impl_dev_types | declared_computed_types

    def check_tier_a_coverage():
        # (b-prime) every Tier-A quoted dev literal type must appear in the declaration. Closes the
        # undeclared config-array fan-out hole (R3) AND the prose-mention case (an exact-quoted dev-*
        # name in a goal/prose string with zero Tier-B spawns). No new FP class — Tier-A presence
        # already activates the current gates. Positioned AFTER the per-branch hard-gate so the DEV-less
        # verify team (adv4) still resolves to BLOCK_NOVERIFYDEV, not BLOCK_UNDECL.
        for t in tier_a_dev_types:
            if t not in declared_all_dev_types:
                emit("BLOCK_UNDECL", entry_marker)

    if decl["upstream"]:
        # UPSTREAM form — waives the in-script verify pair-mapping + ordering ONLY (NOREV already
        # enforced above via Tier-A presence). ADDITIONAL zero-reviewer hard guarantee under upstream:
        # require a REAL Tier-B reviewer spawn (rev_spawns non-empty). The Tier-A presence check at
        # BLOCK_NOREV above is satisfied by a mere quote-bounded reviewer literal (a prose mention in a
        # goal string), which under the upstream form would otherwise slip through with ZERO real
        # reviewer spawn — the in-script form already forbids this via the (a) rev_spawns check below,
        # so this restores symmetry. Emits BLOCK_NOREV (the guarantee cause), not BLOCK_DECLSPAWN.
        if not rev_spawns:
            emit("BLOCK_NOREV", entry_marker)
        # (e) the referenced plan id must be cited by a plan-ref token in the BODY.
        ref = decl["upstream_ref_text"] or ""
        idm = re.search(r"clauded-docs/([0-9]+)", ref)
        if idm:
            upstream_ok = ("clauded-docs/" + idm.group(1)) in body_only_src
        else:
            upstream_ok = bool(PLAN_REF_RE.search(body_only_src))
        if not upstream_ok:
            emit("BLOCK_UPSTREAM", entry_marker)
        # (a) declared literal impl devs must map to a Tier-B spawn.
        for t in declared_impl_dev_types:
            if t not in dev_types_present:
                emit("BLOCK_DECLSPAWN", entry_marker)
        # (c) declared computed devs must have Tier-A presence.
        for t in declared_computed_types:
            if not re.search(r"['\"]" + re.escape(t) + r"['\"]", antigaming_src):
                emit("BLOCK_COMPUTED", entry_marker)
        # (b) every Tier-B dev spawn covered by the declaration.
        for (_, t) in dev_spawns:
            if t not in declared_all_dev_types:
                emit("BLOCK_UNDECL", entry_marker)
        # (b-prime) Tier-A coverage — closes the config-array fan-out behind an honest upstream facade.
        check_tier_a_coverage()
        # ordering waived under upstream (verify happened upstream).
        emit(pass_or_size(), entry_marker)

    # IN-SCRIPT verify form. NOREV already guaranteed above.
    # DEV hard-gate moved INTO the validator: verify team MUST name qa-code-reviewer AND a dev-*.
    if not decl["verify_reviewers"] or not declared_verify_dev_types:
        emit("BLOCK_NOVERIFYDEV", entry_marker)
    # (a) every declared literal role (verify reviewer + verify dev + impl dev) → a Tier-B spawn.
    if not rev_spawns:
        emit("BLOCK_DECLSPAWN", entry_marker)
    for t in (declared_verify_dev_types | declared_impl_dev_types):
        if t not in dev_types_present:
            emit("BLOCK_DECLSPAWN", entry_marker)
    # (c) declared computed devs → Tier-A presence.
    for t in declared_computed_types:
        if not re.search(r"['\"]" + re.escape(t) + r"['\"]", antigaming_src):
            emit("BLOCK_COMPUTED", entry_marker)
    # (b) every Tier-B dev spawn covered.
    for (_, t) in dev_spawns:
        if t not in declared_all_dev_types:
            emit("BLOCK_UNDECL", entry_marker)
    # (b-prime) Tier-A coverage — after the DEV hard-gate + (a)/(b) so adv4 keeps BLOCK_NOVERIFYDEV.
    check_tier_a_coverage()
    # (d) ordering — GREEDY-EARLIEST same-type dual-role binding. Allocate one earliest Tier-B
    # position per verify-dev type as the verify slot; the rest of the declared-impl-type positions
    # are impl slots; SOME reviewer must precede the first impl slot. Computed impls have no positions
    # → declared-order honor-system (skipped).
    dev_pos_by_type = {}
    for (p, t) in dev_spawns:
        dev_pos_by_type.setdefault(t, []).append(p)
    for t in dev_pos_by_type:
        dev_pos_by_type[t].sort()
    # (a-count) SAME-TYPE DUAL-ROLE phantom check — the count facet of check (a). A type declared in
    # BOTH verify: and impl: (literal impl only; impl-computed types have no Tier-B positions and stay
    # honor-system) is filling TWO distinct roles: the verify partner AND the implementer are separate
    # spawns, so that type MUST have at least 2 Tier-B spawn positions. A single spawn provably leaves
    # one declared role unspawned (the greedy binding would absorb the lone spawn as the verify slot,
    # leaving zero impl positions, so ordering check (d) below would vacuously pass — the bypass). This
    # is the count generalization of check (a) declared-role-never-spawned, the one place a declaration
    # is falsifiable against code. Honest 2-spawn dual-role teams (verify slot + impl slot) pass.
    for t in (declared_verify_dev_types & declared_impl_dev_types):
        if len(dev_pos_by_type.get(t, [])) < 2:
            emit("BLOCK_DECLSPAWN", entry_marker)
    verify_slot_positions = set()
    for t in declared_verify_dev_types:
        if dev_pos_by_type.get(t):
            verify_slot_positions.add(dev_pos_by_type[t][0])
    impl_positions = []
    for t in declared_impl_dev_types:
        for p in dev_pos_by_type.get(t, []):
            if p not in verify_slot_positions:
                impl_positions.append(p)
    if impl_positions and rev_starts:
        if not (min(rev_starts) < min(impl_positions)):
            emit("BLOCK_ORDER", entry_marker)
    emit(pass_or_size(), entry_marker)
except SystemExit:
    raise
except Exception:
    emit("PASS", "ENTRY_OK")
PY
  )"

  # Run the helper. It prints THREE lines: line 1 = verdict token, line 2 = entry marker
  # (ENTRY_OK|ENTRY_ADVISORY), line 3 = resilience flag (RESIL_ADVISE|RESIL_SILENT). A non-zero exit OR
  # unparseable output → fail-open (PASS + ENTRY_OK + RESIL_SILENT).
  helper_out="$(printf '%s' "${script_src}" | python3 -c "${verdict_py}" "${DEV_SET}" 2>/dev/null)" || helper_out=$'PASS\nENTRY_OK\nRESIL_SILENT\nANALYSIS_SIZE_SILENT'

  # Parse the four lines with sequential reads. Pre-seeded defaults + a group-level `|| true` keep an
  # EOF on a short (legacy / fail-open) output from tripping the fail-open ERR trap; each field is then
  # normalized to a known value so a stray/absent line collapses to the safe default.
  verdict="PASS"
  entry_marker="ENTRY_OK"
  resil_flag="RESIL_SILENT"
  analysis_size_flag="ANALYSIS_SIZE_SILENT"
  {
    IFS= read -r verdict
    IFS= read -r entry_marker
    IFS= read -r resil_flag
    IFS= read -r analysis_size_flag
  } <<<"${helper_out}" || true
  [[ -z "${verdict}" ]] && verdict="PASS"
  [[ "${entry_marker}" == "ENTRY_ADVISORY" ]] || entry_marker="ENTRY_OK"
  [[ "${resil_flag}" == "RESIL_ADVISE" ]] || resil_flag="RESIL_SILENT"
  [[ "${analysis_size_flag}" == "ANALYSIS_SIZE_ADVISE" ]] || analysis_size_flag="ANALYSIS_SIZE_SILENT"

  # RESILIENCE ADVISORY (fail-open, stderr-only) — the helper decided per-site whether >=1 unhandled
  # schema-mode agent spawn remains; print the nudge here so it rides along with ANY verdict (PASS or a
  # BLOCK below). This NEVER alters the exit code.
  if [[ "${resil_flag}" == "RESIL_ADVISE" ]]; then
    print_resilience_advisory
  fi

  # ANALYSIS-SIZE ADVISORY (fail-open, stderr-only) — the helper decided a schema-mode NON-DEV analysis
  # spawn lacks a [SIZE-EST] token; nudge here so it rides ANY verdict. NEVER alters the exit code (the
  # DEV BLOCK_SIZEEST hard-block path stays exit 2 and is decided independently in the case dispatch).
  if [[ "${analysis_size_flag}" == "ANALYSIS_SIZE_ADVISE" ]]; then
    print_analysis_size_advisory
  fi

  # ENTRY-MISS BLOCK (channel-a) — promoted from the former advisory. Fires ONLY when the verdict is
  # NOT already a BLOCK_* (unquoted BLOCK* glob — fully DECOUPLED) AND the entry signal is
  # ENTRY_ADVISORY (DEV spawn with no plan-ref AND no [ENTRY-CLASS] token). It can NEVER fire when
  # entry_ok holds. Any python helper error yields PASS + ENTRY_OK (fail-open), so an internal error
  # never produces a spurious entry-block.
  if [[ "${verdict}" != BLOCK* && "${entry_marker}" == "ENTRY_ADVISORY" ]]; then
    entry_reason="$(
      cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (entry-miss): this Workflow script spawns DEV agent(s) with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification. Sizable DEV work MUST enter the Document-Driven Workflow (author a plan first). Two ways to clear this gate: (1) PERSIST the plan to the monitor (POST /api/clauded-docs) and reference the minted clauded-docs/<N> id in the workflow script (=> plan-ref token); (2) if GENUINELY simple (none of the sizable criteria hold — see scope-dev.md Sprint Contract Gate) record an [ENTRY-CLASS] simple-task: <reason> classification in the workflow script. ENTRY-CLASS NEGATIVE: `simple-task` is the ONLY recognized [ENTRY-CLASS] literal — sizable work has NO [ENTRY-CLASS] form (its entry signal is the plan-ref token, path 1); any other [ENTRY-CLASS] variant (e.g. [ENTRY-CLASS] sizable / complex / feature) is UNRECOGNIZED and does NOT clear this gate. Placement is not enforced (raw-scanned), so a commented token also satisfies this gate.

COPY-PASTE SCAFFOLD (fill the <…> placeholders, persist the plan, then paste path (1) OR (2) into the script):

EOF
      emit_entry_token_scaffold
    )"
    block_and_exit "${entry_reason}" "block-entry"
  fi

  # Verdict-token → (trace_tag, reason) dispatch. Each BLOCK_* token carries its own dedicated stderr
  # remediation. Default (PASS / any unenumerated token) → fail-open: emit_trace "pass" + exit 0. The
  # `*)` default is the VERDICT-PLUMBING TRAP guard's other half: every python-side BLOCK token MUST
  # have a case arm here (AND a block_and_exit ADR-2 allowlist entry AND a trace tag) or it silently
  # falls to PASS — the enumerated arms below cover the identical token set the helper can emit.
  trace_tag=""
  reason=""
  case "${verdict}" in
    BLOCK_NODECL)
      trace_tag="block-nodecl"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (missing composition declaration): this Workflow script spawns DEV agent(s) but carries NO [AGENT-COMPOSITION] declaration block. Like [ENTRY-CLASS] / [SIZE-EST], the composition declaration is a MANDATORY author self-attestation — its ABSENCE on a DEV workflow is a hard block (presence parity). It declares the verify team + the implementation spawns so the gate can consistency-check them against the code. STRING-RESIDENCY NOTE: if your block IS present but sits INSIDE a string literal (e.g. quoted in a goal/prompt template), it is treated as ABSENT on purpose (a worked example quoted into a prompt must stay inert) — move it into a real /* */ block comment. HONESTY: declaration truthfulness is NOT mechanically verified — same honor-system trust model as the sibling attestation tokens; only PRESENCE + CONSISTENCY are checked.

COPY-PASTE SCAFFOLD — pick ONE form (canonical home: a /* */ block comment):

EOF
        emit_composition_scaffold
        cat <<'EOF'

Clause grammar (ONE line per key): verify: (a) glass-atrium-qa-code-reviewer AND exactly ONE glass-atrium-dev-* (the DEV hard-gate is enforced HERE) OR (b) upstream clauded-docs/<N>. impl: <literal dev agentType spawn(s)> | none. impl-computed: <dev agentType(s) spawned indirectly, e.g. agentType: b.agent over a config array> — verified via data-literal presence. IMPL-COMPUTED NEGATIVE: when there are NO computed/indirect spawns, OMIT the impl-computed line entirely — `impl-computed: none` is MALFORMED (only impl: accepts the `none` literal) and BLOCKS as block-grammar (unknown-name). The upstream <N> MUST also be cited by a plan-ref token in the script body. TYPE vs INSTANCE: the block declares agent TYPES and ROLES; a fan-out that spawns N runtime instances from one token declares the TYPE once (instance cardinality is never checked).
EOF
      )"
      ;;
    BLOCK_GRAMMAR)
      trace_tag="block-grammar"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (malformed composition declaration): this Workflow script carries an [AGENT-COMPOSITION] block, but its contents are not well-formed. A well-formed sentinel pair means you opted INTO the contract, so a decidable author error is a hard block (NOT fail-open) — silently ignoring a typo would run unvalidated DEV work while you believe the gate validated it. One of these decidable errors was detected: an unterminated block (opening sentinel with no [/AGENT-COMPOSITION] close); 2+ comment-resident blocks (ambiguous authority); a line that does not begin with a known key + colon; a duplicate key; an unknown agent name (validated against the runtime DEV_SET + the reviewer literal — NOTE names must be COMMA-separated: a space-separated pair like `verify: glass-atrium-qa-code-reviewer glass-atrium-dev-nestjs` reads as ONE unknown name and blocks here); a malformed `verify: upstream …` clause; or a team-form verify clause naming MORE THAN ONE dev-* type. Fix the block to the strict grammar below, then retry. HONESTY: only presence + grammar + code-consistency are mechanical; role truthfulness is honor-system.

STRICT GRAMMAR — exactly ONE comment-resident block, ONE line per key, keys drawn from {verify, impl, impl-computed}; agent names must be the reviewer literal or a runtime-DEV_SET dev-*; free text is admitted ONLY after a spaced-dash delimiter (e.g. `impl-computed: glass-atrium-dev-node — over the BATCHES array`):

  /* [AGENT-COMPOSITION]
  verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
  impl: glass-atrium-dev-nestjs
  [/AGENT-COMPOSITION] */

  --- upstream form ---
  /* [AGENT-COMPOSITION]
  verify: upstream clauded-docs/<N>
  impl: glass-atrium-dev-shell
  [/AGENT-COMPOSITION] */

verify team form = glass-atrium-qa-code-reviewer + EXACTLY ONE dev-* type (the Stage-2 team of two roles). impl := comma-separated dev-* type list | none. impl-computed := comma-separated dev-* type list (indirect/computed spawns) — OMIT this line entirely when there are no computed spawns; `impl-computed: none` is malformed (only impl: accepts the `none` literal) and blocks here as block-grammar.
EOF
      )"
      ;;
    BLOCK_NOREV)
      trace_tag="block-norev"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (no reviewer, zero-reviewer hard guarantee): this DEV workflow contains NO glass-atrium-qa-code-reviewer spawn token ANYWHERE. This guarantee is UNCONDITIONAL — it is evaluated independently of the declaration form, so the upstream form does NOT waive it: even a workflow executing an already-verified plan must still carry a real reviewer spawn somewhere. Either add the reviewer verify spawn (in-script verify form), OR — if this workflow only EXECUTES an already-verified persisted plan AND still spawns a reviewer — keep the reviewer and use the upstream form (verify: upstream clauded-docs/<N>, cited by a plan-ref token in the body).
EOF
      )"
      ;;
    BLOCK_NOVERIFYDEV)
      trace_tag="block-noverifydev"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (verify team lacks the DEV half — Stage-2 DEV hard-gate): the [AGENT-COMPOSITION] verify clause does NOT name BOTH glass-atrium-qa-code-reviewer AND a glass-atrium-dev-* partner. The Plan Direction Verification (Stage-2) gate REQUIRES a DEV verdict (feasible|infeasible) alongside the reviewer verdict — a reviewer-only verify team is rejected. Fix the declaration: verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-<domain>. If there is NO genuine in-script verify DEV (e.g. a lone audit reviewer plus scattered implementation devs), this is the correct block — add a real {qa, dev} verify pair, or use the upstream form if executing an already-verified plan. HONESTY: this checks the DECLARATION names a DEV; it does NOT verify a feasible verdict was emitted (honor-system, same as the attestation tokens).
EOF
      )"
      ;;
    BLOCK_DECLSPAWN)
      trace_tag="block-declspawn"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (declared role never spawned): a literal agent role declared in [AGENT-COMPOSITION] (a verify-team member or an impl: spawn) has NO matching spawn-position token in the code (agent('<type>', …) first-arg OR agentType: '<type>'). The declaration must describe the ACTUAL spawns — a phantom verify team is falsifiable against code and blocks. Either add the missing spawn, correct the declared agentType, or (if the spawn is computed/indirect) move it to an impl-computed: line so it is checked via data-literal presence instead.
EOF
      )"
      ;;
    BLOCK_UNDECL)
      trace_tag="block-undecl"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (undeclared DEV spawn): a glass-atrium-dev-* type appears in the code whose agentType is NOT covered by any verify / impl / impl-computed clause in [AGENT-COMPOSITION]. Every DEV type MUST be declared (so a silently-added implementation dev cannot bypass the verify contract). This fires on TWO shapes: (1) a real Tier-B spawn (agent('glass-atrium-dev-*', …) OR agentType: '…') that is undeclared — add its agentType to an impl: (or impl-computed:) line, or remove the spawn; (2) PROSE-MENTION / config-array coverage (b-prime): an exact-quoted dev-* name that is NOT a real spawn — e.g. a dev-* name quoted inside a goal/prose string, or a dev literal parked in a data config array (agentType: b.agent over a BATCHES array) with ZERO agent() spawn positions. ONE-EDIT remediation for shape (2): if the quoted name is merely a MENTION, reword it so the dev-* name is NOT a quote-bounded literal (drop the quotes / paraphrase); if it IS a real (computed) spawn, declare its type on an impl-computed: line.
EOF
      )"
      ;;
    BLOCK_COMPUTED)
      trace_tag="block-computed"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (declared computed spawn absent): an impl-computed: agentType declared in [AGENT-COMPOSITION] does NOT appear as a data-literal anywhere in the code (e.g. inside the config array the computed agentType selects over). A computed/indirect spawn (agentType: b.agent / a ternary) is verified by the presence of its declared agent-type literals in the data. Add the agent-type literal to the config data, or correct the declared type.
EOF
      )"
      ;;
    BLOCK_ORDER)
      trace_tag="block-order"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (ordering): a declared implementation dev-* spawn textually precedes EVERY glass-atrium-qa-code-reviewer spawn, so the implementation is not gated by the verify stage. On the greedy-earliest same-type binding (the first Tier-B spawn of a declared verify-dev type is the verify slot; the rest of the declared impl-type positions are implementation slots), some reviewer MUST precede the first implementation slot. Reorder so the {qa-code-reviewer, DEV} verify stage runs BEFORE the implementation agent(); OR, if the earlier dev-* is a pre-verify Discovery/Design step, use a NON-DEV agent for it (glass-atrium-intel-researcher / glass-atrium-intel-planner) so no dev-* precedes the reviewer; OR front-load a genuine reviewer-first {qa-code-reviewer, DEV} Contract verify phase BEFORE any Discovery dev-*. (Computed/indirect impl spawns have no static position → ordering is honor-system for those.)
EOF
      )"
      ;;
    BLOCK_UPSTREAM)
      trace_tag="block-upstream"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (upstream plan not cited): the [AGENT-COMPOSITION] verify clause uses the upstream form (verify: upstream clauded-docs/<N>) but the referenced plan id is NOT cited by a plan-ref token in the script BODY (outside the declaration). The upstream form waives the in-script {qa, dev} verify PAIR-MAPPING and ORDERING ONLY — it does NOT waive the zero-reviewer hard guarantee, and it is honest ONLY for a workflow that genuinely executes an already-verified persisted plan. So the script must reference that plan. Add a plan-ref citation, e.g. log('plan-ref: clauded-docs/<N>'), matching the declared id; or switch to the in-script verify form. CAUTION: do NOT mint a throwaway token-doc purely to harvest a clauded-docs id — reference a REAL, already-verified persisted plan (same honor-system floor as a fake plan-ref).
EOF
      )"
      ;;
    BLOCK_DOCROUTE)
      trace_tag="block-docroute"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (doc-routing leak): this Workflow spawns an intel-reporter / intel-planner agent whose prompt hardcodes a LOCAL filesystem path as the deliverable Target AND contains NO monitor-POST / clauded-docs routing instruction. Route the document to the monitor clauded-docs API (POST /api/clauded-docs); if a local path is only a /tmp staging buffer piped into a monitor POST, include the monitor-POST instruction so this static check recognizes the routing. USER-REQUESTED LOCAL: stamp log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>') (path/line-scoped; concrete dotted path required). HONEST LIMIT: this is the WEAKEST string-heuristic layer; the runtime PreToolUse(Write) hook (block-doc-routing-leak.sh) is the primary guard.
EOF
      )"
      ;;
    BLOCK_SIZEEST)
      trace_tag="block-sizeest"
      reason="$(
        cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (size-attestation miss): this Workflow spawns DEV agent(s) but carries NO [SIZE-EST] delegation-size self-attestation token. Record the pre-spawn size estimate at EVERY DEV spawn: log('[SIZE-EST] bundles=N tool_uses~=N — <reason>'). Under-estimating is the DANGEROUS error (it masks an oversized delegation past the split discipline); on a borderline count round UP. Placement is not enforced (raw-scanned); existence-only — the estimate correctness is never checked.
EOF
      )"
      ;;
    *)
      emit_trace "pass" "${script_len}"
      exit 0
      ;;
  esac

  block_and_exit "${reason}" "${trace_tag}"
}

# ==== entry point — arg parse MUST precede the unconditional stdin drain =============================
# --lint [script-file] : OFFLINE preview (the verified prevention). Reads RAW script text from a file arg
#   OR stdin (no JSON envelope, no jq/tool_name stage) and runs the IDENTICAL verdict helper + dispatch,
#   so `exit 0 = will pass the gate` by construction. Side-effect-free: LINT_MODE guards emit_trace (no
#   trace line written). --lint --template : print the canonical author-attestation scaffold and exit 0.
if [[ "${1:-}" == "--lint" ]]; then
  LINT_MODE=1
  shift
  if [[ "${1:-}" == "--template" ]]; then
    print_lint_template
    exit 0
  fi
  script_src=""
  if [[ -n "${1:-}" ]]; then
    # Explicit file arg — a missing/unreadable path MUST fail LOUD (exit 2), not swallow the read
    # error into an empty script that reads as a clean "exit 0 = will pass". Only the stdin path and
    # a readable-but-empty file mirror the hook no-script exit-0 (nothing to lint).
    if [[ ! -r "${1}" ]]; then
      printf '[lint] cannot read %s\n' "${1}" >&2
      exit 2
    fi
    script_src="$(cat -- "${1}" 2>/dev/null)" || script_src=""
  elif [[ ! -t 0 ]]; then
    script_src="$(cat 2>/dev/null)" || script_src=""
  fi
  # Empty (readable-but-empty file, or empty stdin) → nothing to lint → exit 0 (a clean "will pass";
  # mirrors the hook no-script path).
  [[ -z "${script_src}" ]] && exit 0
  script_len="${#script_src}"
  # run_verdict_and_dispatch always terminates via exit (helper dispatch or python3-absent fail-open).
  run_verdict_and_dispatch
fi

# ==== hook mode — PreToolUse(Workflow) envelope path (verdict path UNCHANGED) ========================
# stdin non-interactive → drain once, otherwise fail-open.
input=""
if [[ ! -t 0 ]]; then
  input="$(cat 2>/dev/null)" || input=""
fi
[[ -z "${input}" ]] && exit 0

# Absent jq is a system misconfiguration — fail-open (never block on tooling gaps).
if ! command -v jq >/dev/null 2>&1; then
  printf '[enforce-workflow-verify-stage] jq not found on PATH; skipping (fail-open)\n' >&2
  exit 0
fi

# tool_name gate — only the Workflow tool is in scope. In-pipe `|| true` absorbs jq failure on
# corrupted JSON so the ERR trap fires only on genuine errors.
tool_name=""
tool_name="$(printf '%s' "${input}" | jq -r '.tool_name // ""' 2>/dev/null || true)" || tool_name=""
# tool_name != Workflow → out of scope → NO trace (this gate only records actual Workflow firings).
[[ "${tool_name}" != "Workflow" ]] && exit 0

# Past this point the harness HAS fired PreToolUse(Workflow) — every subsequent exit emits a trace.

# Extract tool_input.script. base64-wrap so a multi-line JS script with arbitrary control chars
# passes through safely (the script body is the heuristic target).
script_b64=""
script_b64="$(printf '%s' "${input}" | jq -r '(.tool_input.script // "") | @base64' 2>/dev/null || true)" || script_b64=""
if [[ -z "${script_b64}" ]]; then
  emit_trace "pass-noscript" "0"
  exit 0
fi

script_src=""
script_src="$(printf '%s' "${script_b64}" | base64 --decode 2>/dev/null)" || script_src=""
# Empty/unparseable script → nothing to inspect → fail-open.
if [[ -z "${script_src}" ]]; then
  emit_trace "pass-noscript" "0"
  exit 0
fi

# Script body is known from here — length feeds the trace's script_len field.
script_len="${#script_src}"

# Shared decode-to-dispatch tail (identical to the --lint path above).
run_verdict_and_dispatch
