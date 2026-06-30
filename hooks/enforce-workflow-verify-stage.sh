#!/usr/bin/env bash
# enforce-workflow-verify-stage.sh — PreToolUse(Workflow) static verify-stage gate.
#
# WHY: under ultracode the Workflow engine's internal agent() spawns fire NO PreToolUse(Agent)
# event, so enforce-verification-gate.sh
# is bypassed and the {qa-code-reviewer, DEV} Plan Direction Verification (Stage-2) gate is
# honor-system only on that path. This hook closes that gap with a MECHANICAL check on the OUTER
# Workflow tool invocation: it statically scans tool_input.script and BLOCKS (exit 2) when the
# script spawns DEV-implementation agents (agentType dev-*) but contains NO qa-code-reviewer
# verify-stage preceding them — the clear "missing verify-stage" omission.
#
# SECOND DETECTION PASS (doc-routing-leak, the WEAKEST layer — must NOT be the confidence anchor):
# the same static scan ALSO flags an intel-reporter / intel-planner spawn whose prompt hardcodes a
# local filesystem path as a Target/destination AND carries NO monitor-POST / clauded-docs routing
# instruction. This is the Workflow-script mirror of the runtime PreToolUse(Write) block
# (block-doc-routing-leak.sh) — a weak, write-time-prevention complement, NOT a primary guard. It
# reuses the SAME comment-strip helper and the SAME fail-open-dominant posture: every uncertainty
# (no doc-agent spawn · no hardcoded path shape · any monitor-POST signal present · helper error)
# resolves to PASS. The string-heuristic limits are IDENTICAL to the verify-stage scan's (a naive
# path-shape match cannot prove intent, a missed leak is preferred over a false BLOCK of a
# legitimate workflow) and are documented inline at the doc-routing helper. This layer's value is
# defense-in-depth, not detection confidence.
#
# HONEST SCOPE — this is a STATIC HEURISTIC (string/pattern scan of the JS script), NOT a full
# parse. It catches the clear omission via a string-aware, comment-stripped scan:
#   - JS comments (`//`, `/* */`) are STRIPPED before the qa-code-reviewer token is scanned, so a
#     comment-only mention no longer satisfies the gate (string-aware: a // or /* inside a string
#     literal is preserved — see the F3 helper).
#   - ASYMMETRIC SCAN (P0): only spawn/agentType tokens (qa-code-reviewer, dev-*, doc-agent) and the
#     leak TRIGGER (local Target shape) scan the comment-stripped source — a commented spawn/target is
#     not a real one (this is the anti-gaming property the strip exists for). The author
#     self-attestation / suppressor tokens ([ENTRY-CLASS], plan-ref, monitor-POST routing note) scan
#     RAW src instead, matching the manual gate's raw grep: their evidentiary weight is identical in a
#     comment or a string, so stripping them only false-BLOCKs a legitimate workflow.
#   - BEST-EFFORT ordering: the reviewer verify-spawn must appear BEFORE the first DEV
#     implementation spawn; a reviewer appearing ONLY after the DEV spawn is treated as missing.
#   - The gate enforces ONLY when a DEV agentType is actually spawned (no DEV impl → exempt).
#   - DEV-verifier co-location HEURISTIC (R5, NOT DEV-verdict enforcement): the canonical
#     Stage-2 verify-stage is `parallel(agent('qa-code-reviewer',…), agent('dev-*',…))` — the
#     verify-DEV and the reviewer sit in the SAME parallel(...) group, while the implementation
#     DEV is a LATER bare agent('dev-*',…). Both halves use the IDENTICAL dev-* agentType token,
#     so they are NOT distinguishable by token name. The ONLY sound static signal is CO-LOCATION:
#     a verify-DEV exists iff a dev-* token shares the reviewer's enclosing parallel(...) group
#     (proximity-window fallback when group bounds are unparseable). When a reviewer is present
#     (ordering OK) but NO co-located dev-* verifier is found, the gate BLOCKS — catching the
#     "reviewer present, DEV hard-gate absent" omission. This is a PRESENCE/CO-LOCATION HEURISTIC,
#     NOT a check that the DEV emitted a `feasible` verdict (that value does not exist statically).
# It still does NOT validate gating-expression correctness or DEV-verdict presence — those remain
# the orchestrator's authoring obligation. Scoped to clear violations + fail-OPEN DOMINANT on ANY
# ambiguity (python3 absent · helper error · non-"BLOCK" output → exit 0): a false-block of a
# legitimate workflow is worse than a missed bypass, so every uncertainty resolves to allow.
#
# CONDITIONAL ACTIVATION (unverified binding): whether the harness fires PreToolUse(Workflow) with
# tool_input.script exposed is NOT empirically confirmed. This
# hook is fail-open by design, so wiring it is SAFE even if the event never fires — it simply
# no-ops on any envelope mismatch. Verify firing with a runtime probe after wiring.
#
# FIRING INSTRUMENTATION (passive probe): on EVERY invocation that reaches the Workflow-tool
# decision point, a one-line trace is appended to ${HOME}/.claude/data/workflow-gate-fired.log
# (timestamp · tool_name · verdict · script-length). The orchestrator cannot trigger a Workflow
# call (no ultracode opt-in), so this is a passive probe: the NEXT real ultracode workflow run
# self-records firing. Two honest interpretation branches of the log:
#   (a) a trace line APPEARS after a real workflow run → PreToolUse(Workflow) DOES fire with
#       tool_input.script exposed → this gate is a REAL active mechanism (the ultracode verify-gap
#       is closed mechanically at the hook layer).
#   (b) NO trace line ever, despite ultracode workflows having run → the event does NOT fire →
#       the ultracode verify-gap is structurally UNCLOSED at the hook layer, and the in-script
#       verify-stage (honor-system, orchestrator-role.md "### Ultracode / Workflow-tool Mode")
#       remains the SOLE backstop. Do NOT claim mechanical enforcement in this branch.
# How to check: `cat ~/.claude/data/workflow-gate-fired.log`.
# The trace is fail-SAFE — an unwritable log dir / any logging error NEVER changes the verdict or
# the exit code (the verdict is decided first, the trace is best-effort and swallowed).
#
# Exit codes: 0 = pass / fail-open (default) · 2 = BLOCK. Three independent exit-2 verdicts share the
#   block channel: missing-verify-stage (clear case) · doc-routing leak (weakest, string heuristic) ·
#   entry-miss (DEV spawn with NO plan-ref AND NO [ENTRY-CLASS] simple-task token — the ultracode
#   equivalent of enforce-verification-gate.sh's entry-miss block; decoupled from the verify-stage
#   verdict, never fires when a plan-ref/token is present or on a non-DEV workflow).
# Channel: STDERR for the block reason (PreToolUse block surface) · exit 2 signals the block.
# fail-open: script absent/empty/unparseable · no DEV spawn (simple workflow, Stage-2 exempt) ·
#            qa-code-reviewer present · wrong tool_name · any internal error → exit 0.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — a gate that errors MUST NOT block a legitimate workflow.
trap 'printf "[enforce-workflow-verify-stage] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# DEV-set — core-compliance-matrix.md Scope Legend canonical DEV agents. Space-separated tokens for
# bash 3.2 (no declare -A). AUTO-SYNCED from the scope-dev.md DEV roster by agent_lifecycle (the
# add/delete transaction + `python -m agent_lifecycle sync-gate-roster`) — do NOT hand-edit. Mirrors
# the DEV_SET in enforce-verification-gate.sh.
readonly DEV_SET="dev-front dev-react dev-angular dev-gsap dev-android dev-nestjs dev-node dev-python dev-db dev-rag dev-animator dev-shell dev-swift"

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

# emit_trace VERDICT SCRIPT_LEN — append one firing-trace line, FAIL-SAFE.
# The verdict is ALWAYS decided before this runs; every failure mode here (unwritable dir, mkdir
# refusal, printf error) is swallowed so the trace can NEVER alter the hook's exit code or verdict.
# Subshell + `|| true` isolates the ERR trap: a logging error must not trip the fail-open trap and
# must not leak a non-zero status into `set -e`. Best-effort only.
emit_trace() {
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
# all three exit-2 verdicts (entry-miss · doc-routing leak · missing-verify-stage) — only the reason
# text and the trace tag differ. ${script_len} is read from the global set after the script decode.
#
# CENTRALIZED ENTRY ADDENDUM (message-only; was the inline F1 block on the verify-stage path) — when
# the block is one that SUPPRESSES the dedicated entry-miss nudge (both the verify-stage "block" and
# the docroute "block-docroute" verdicts pre-empt the entry-miss block) AND the entry signal is
# missing (${entry_marker:-} == ENTRY_ADVISORY), append the entry-format requirement to the SAME
# message so the author resolves both needs in one pass. ALLOWLIST gate (ADR-2): only "block" and
# "block-docroute" carry the addendum; "block-entry" is EXCLUDED (it already prints full entry
# guidance), and a future 4th block path must opt IN deliberately (fail-safe vs silent scope-creep).
# Reads the GLOBAL entry_marker via ${entry_marker:-} — NO `local entry_marker` (a local would shadow
# the global with an empty value and silently disable the addendum on every path); the :- default is
# mandatory for set -u safety because this function runs under the line-87 fail-open ERR trap (an
# unbound-var error would fail-open to exit 0 and silently drop a legitimate block). The addendum is
# a single-quoted heredoc (no expansion -> injection-safe). MESSAGE-ONLY: verdict logic, branch
# conditions, the exit code (always 2), and emit_trace tag semantics are all unchanged.
block_and_exit() {
  local reason="${1}"
  if [[ "${2}" == "block" || "${2}" == "block-docroute" ]] && [[ "${entry_marker:-}" == "ENTRY_ADVISORY" ]]; then
    reason="${reason}"$'\n\n'"$(
      cat <<'EOF'
ADDITIONALLY (entry classification / plan-reference also required): beyond the block above, this Workflow script spawns DEV agent(s) with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification — so once the issue above is fixed it will STILL be blocked for a missing entry signal. Resolve BOTH in one pass. Two ways to supply the entry signal: (1) PERSIST the plan to the monitor (POST /api/clauded-docs) and reference the minted clauded-docs/<N> id in the workflow script (=> plan-reference token); (2) if GENUINELY simple (none of the sizable criteria hold — see scope-dev.md Sprint Contract Gate), record an [ENTRY-CLASS] simple-task: <reason> classification in the workflow script. CAUTION: do NOT mint a throwaway token-doc purely to harvest a clauded-docs id — persist a REAL plan. Placement is not enforced (these tokens are raw-scanned), so a commented token also satisfies it.
EOF
    )"
  fi
  printf '%s\n' "${reason}" >&2
  emit_trace "${2}" "${script_len}"
  exit 2
}

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
  emit_trace "pass" "0"
  exit 0
fi

script_src=""
script_src="$(printf '%s' "${script_b64}" | base64 --decode 2>/dev/null)" || script_src=""
# Empty/unparseable script → nothing to inspect → fail-open.
if [[ -z "${script_src}" ]]; then
  emit_trace "pass" "0"
  exit 0
fi

# Script body is known from here — length feeds the trace's script_len field.
script_len="${#script_src}"

# F3 hardened heuristic (string-aware, fail-open dominant)
# Three adversarially-confirmed bypasses of the prior presence-only scan are closed:
#   (a) a `qa-code-reviewer` token in a COMMENT used to satisfy the gate → comments are
#       STRIPPED (string-aware: `//` and `/* */` only outside string literals) before the
#       reviewer token is scanned, so a comment-only mention no longer counts.
#   (b) NO ordering check (reviewer-after-dev passed) → the reviewer verify-spawn must appear
#       BEFORE the first DEV implementation spawn; a reviewer that appears ONLY after the DEV
#       spawn does not gate that implementation and is treated as missing.
#   (c) the gate fired heuristics even with no DEV spawn → already exempt (still is).
#
# R5 — DEV-verifier co-location / co-group HEURISTIC, NOT DEV-verdict enforcement. The DEV half
# of the {qa-code-reviewer, DEV} verify team is required, but the verify-DEV and the impl-DEV
# share the IDENTICAL dev-* agentType token, so they are token-indistinguishable. The two sound
# static signals that a dev-* is the verify-DEV are: (1) CO-LOCATION — within COLOCATION_WINDOW
# chars of ANY reviewer span (generalized over ALL reviewers via finditer, not just the first
# match); and (2) CO-MEMBERSHIP — sharing a balanced-paren parallel(...) group with a reviewer,
# DISTANCE-INDEPENDENT so a long inline goal string cannot break detection. The helper partitions
# the dev-* tokens into the verify-DEV (either signal holds) and the implementation dev-* tokens
# (everything else), then decides:
#   - reviewer(s) present but NO co-located / co-grouped dev-* verifier → reviewer is alone → DEV
#     hard-gate absent → BLOCK.
#   - a verify-DEV present AND every implementation dev-* is preceded by SOME reviewer → PASS.
#     Because the verify-DEV is EXCLUDED from the implementation set, the verify pair is
#     ORDER-INDEPENDENT: both parallel(reviewer, dev) and parallel(dev, reviewer) pass.
#   - an implementation dev-* that NO reviewer precedes → it ran un-gated → BLOCK.
#
# TWO FALSE-POSITIVE FIXES (both bypass-free per the Stage-2 red-team):
#   (FP1, multi-reviewer) keying the verify-DEV check on EVERY reviewer (finditer), not the FIRST
#     match, so a leading audit/Phase-1 reviewer no longer determines the verdict for a genuine
#     later {qa,dev} pair.
#   (FP2, window-blowout) recognizing the verify pair STRUCTURALLY via parallel(...) group bounds,
#     so a multi-sentence goal string pushing the genuine qa+dev pair past COLOCATION_WINDOW does
#     not break detection. NO precede-fallback is used: the red team proved a "absorb the first
#     impl dev as a phantom verify-DEV when dev-*>=2 and a reviewer precedes" fallback OPENS A
#     BYPASS (audit reviewer + 2+ scattered impl devs + no genuine parallel(qa,dev) pair would
#     wrongly PASS), so it is deliberately NOT present — the verify-DEV signal is co-location /
#     group-bounds ONLY. The fix only WIDENS the PASS set for genuine verify-stages; it NEVER
#     admits a zero-genuine-verify-pair DEV-impl workflow.
# A presence/co-location heuristic only — it NEVER inspects a runtime feasible verdict (which does
# not exist at static-scan time) and is labeled HEURISTIC, not enforcement. A wide window plus the
# fail-open-biased group scan keep it FAIL-OPEN DOMINANT.
#
# KNOWN LIMITATION (reported honestly): because verify-DEV and impl-DEV are the same token, this
# heuristic cannot prove the co-located DEV is acting as a verifier rather than an implementer.
# A compact script that places a lone dev-* within COLOCATION_WINDOW chars of the reviewer reads
# as a verify-DEV (so a verify-only stage with no separate implementation, OR a dev-then-reviewer
# pair with nothing after, both PASS). That is an accepted fail-open false-negative: a missed
# bypass is preferred over a false BLOCK of a legitimate workflow. The DEV-verdict correctness
# itself remains the orchestrator's honor-system authoring obligation.
#
# The detection + comment-strip + co-location + ordering runs in ONE python3 helper that emits a
# single verdict token (BLOCK | PASS) on stdout. CRITICAL — FAIL-OPEN DOMINANT: python3 absent,
# the helper erroring, OR any stdout that is not exactly "BLOCK" → treated as PASS (exit 0). This
# is a heuristic backstop; a false-BLOCK on a legitimate workflow is worse than a missed bypass,
# so every uncertainty resolves to allow. Only a confident "BLOCK" (DEV spawned AND no non-comment
# qa-code-reviewer anywhere, OR reviewer present but NO co-located dev-* verifier, OR an
# implementation dev-* the reviewer does not precede) blocks.
#
# String-awareness rationale: a naive `//` strip would corrupt a URL inside a goal string
# (`'http://x'`) and could erase a real reviewer token sharing that line → false BLOCK. The
# helper tracks `'`/`"`/backtick string state (with `\` escapes) so `//` and `/*` inside a
# string literal are NOT treated as comment starts.
#
# python3 absent is a system misconfiguration — fail-open (never block on a tooling gap).
if ! command -v python3 >/dev/null 2>&1; then
  emit_trace "pass" "${script_len}"
  exit 0
fi

# Verdict helper. Reads DEV_SET (arg 1) + the script (stdin). Prints exactly BLOCK or PASS.
# Any internal exception → the helper itself prints PASS (belt-and-suspenders fail-open), and
# the bash side ALSO treats a non-"BLOCK" / errored helper as PASS.
verdict_py="$(
  cat <<'PY'
import sys, re

# Proximity-window half-width in chars for the DEV-verifier co-location heuristic. A dev-* token
# within this many chars of the reviewer token counts as the DEV half of the verify team. Generous
# on purpose: a wider window reads MORE workflows as having a co-located DEV verifier, so it yields
# FEWER BLOCKs and stays fail-open dominant. Sized to comfortably span the canonical verify stage
# parallel block holding qa-code-reviewer plus the primary-domain dev agent side by side, INCLUDING
# a realistic multi-sentence reviewer goal string (~500+ chars) between the co-located pair.
COLOCATION_WINDOW = 1000

# Inline copy of enforce-verification-gate.sh references_plan()'s structured regex (Path A predicate);
# keep in sync. Scanned RAW (attestation_src) for the ADDITIVE entry-advisory signal — see alias defs.
PLAN_REF_RE = re.compile(
    r"clauded-docs/[0-9]+"
    r"|[A-Za-z0-9_./-]*plan[A-Za-z0-9_-]*\.html"
    r"|documents/[A-Za-z0-9_./-]+\.html"
    r"|plan-[0-9]+"
    r"|[0-9]+-plan"
)
# Entry-classification literal — the orchestrator's conscious "this DEV task is simple/exempt" signal.
# Anchored bracketed literal (substring, not a bare 'simple') — mirrors has_simple_task_token().
ENTRY_CLASS_LITERAL = "[ENTRY-CLASS] simple-task"

# Document-authoring agentTypes whose Workflow spawn prompts route to the monitor clauded-docs store
# by default. A hardcoded local FS Target in one of these spawns, with no monitor-POST instruction,
# is the doc-routing leak this SECOND (weakest) pass flags. Keep in sync with the REPORT/PLANNING
# scope agents in core-compliance-matrix.md.
DOC_AGENT_SET = ("intel-reporter", "intel-planner")

# Generic local-FS-path SHAPE signals — username-agnostic by construction (NO baked-in user dir).
# A doc-routing leak hardcodes a local path as the deliverable destination; these match the SHAPE,
# never a specific username. Run on the comment-stripped source so a path inside a comment does not
# trip the heuristic.
#   - "Target file:" / "target file" — the forensic leak phrasing ("Target file: WRITE the report
#     to <abs path>").
#   - mkdir-then-Write — the "mkdir -p <dir> && Write" / "mkdir -p ... then Write" leak shape.
#   - a $HOME / ~ / leading-slash absolute path ending in a doc extension used as a write target.
# Each alternative is deliberately broad on the SHAPE and narrow on intent (a doc extension or an
# explicit Target/WRITE verb must accompany the path) so a bare URL or arg path does not match.
LOCAL_TARGET_RE = re.compile(
    r"target\s+file\s*:"                                  # "Target file:" destination phrasing
    r"|mkdir\s+-p[^\n]{0,200}?(?:&&|;|then)[^\n]{0,80}?\bwrite\b"  # mkdir -p ... && Write shape
    r"|\bwrite\b[^\n]{0,80}?\bto\b[^\n]{0,80}?(?:~|\$HOME|/)[^\s'\"]*\.(?:md|markdown|html|yaml|yml|json|txt)"  # WRITE ... to <local path>.<doc ext>
    r"|(?:~|\$HOME|\$\{HOME\}|/)[A-Za-z0-9_./-]*\.(?:md|markdown|html)\b",  # bare local doc path (md/markdown/html)
    re.IGNORECASE,
)

# Monitor-POST / clauded-docs routing SIGNALS — presence of ANY one means the spawn DID instruct
# monitor routing, so the local path is a staging buffer (the intel-planner /tmp-then-curl normal
# pattern), NOT a leak → fail-open to PASS. Broad on purpose (any one signal suppresses the flag).
MONITOR_POST_RE = re.compile(
    r"clauded-docs"                                       # the API path / store name
    r"|/api/clauded-docs"
    r"|monitor[- ]?post"
    r"|POST[^\n]{0,40}?(?:monitor|clauded)"               # "POST to the monitor" / "POST ... clauded"
    r"|127\.0\.0\.1:7842"                                 # monitor base URL (port from convention)
    r"|html_body"                                         # the PUT/POST body field name
    r"|doc_status",                                       # the clauded-docs lifecycle field
    re.IGNORECASE,
)

def strip_comments(src):
    # String-aware removal of // line comments and /* */ block comments. Tracks single/double/
    # backtick string state with backslash escapes so a // or /* inside a string is preserved.
    out = []
    i, n = 0, len(src)
    in_str = None          # active string quote char, or None
    in_line_c = False      # inside a // comment
    in_block_c = False     # inside a /* */ comment
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
            i += 1
            continue
        if in_str is not None:
            out.append(c)
            if c == '\\':            # escape — copy next char verbatim
                if nxt:
                    out.append(nxt)
                    i += 2
                    continue
            elif c == in_str:
                in_str = None
            i += 1
            continue
        # not in a string or comment
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
        out.append(c)
        i += 1
    return ''.join(out)

def is_colocated(rev_start, rev_end, dev_start):
    # Is a dev-* token within COLOCATION_WINDOW chars of the reviewer token? Co-location is the one
    # sound static signal that a dev-* is the verify-DEV: in the canonical verify stage the reviewer
    # and its primary-domain dev agent sit side by side inside the same parallel verify block, and
    # parallel() is order-independent so the dev may precede OR follow the reviewer. A wide window
    # keeps the heuristic fail-open biased.
    lo = rev_start - COLOCATION_WINDOW
    hi = rev_end + COLOCATION_WINDOW
    return lo <= dev_start <= hi

def is_colocated_any(rev_spans, dev_start):
    # Generalized co-location: a dev-* is a verify-DEV if it is within COLOCATION_WINDOW of ANY
    # reviewer span, not just the FIRST. Keying on every reviewer (finditer) is what kills the
    # multi-reviewer FP — a leading audit/Phase-1 qa-code-reviewer no longer determines the verdict
    # for a genuine {qa,dev} pair that appears later in the script.
    return any(is_colocated(rs, re_, dev_start) for (rs, re_) in rev_spans)

def parallel_group_spans(stripped):
    # Find the balanced-paren bounds of every `parallel( ... )` group. Returns a list of (start, end)
    # half-open char ranges covering the parenthesized argument list of each parallel call. Used for
    # the DISTANCE-INDEPENDENT verify-pair signal: a parallel group containing BOTH a qa-code-reviewer
    # AND a dev-* spawn is the canonical verify stage REGARDLESS of how long the inline goal strings
    # are. This is the structural fix for the window-blowout FP (a multi-sentence goal string pushing
    # the genuine qa+dev pair past COLOCATION_WINDOW must NOT break detection). String-aware: a `(` or
    # `)` inside a string literal does not move the depth counter, so a paren inside a goal string
    # cannot mis-bound a group. Runs on the already comment-stripped source.
    spans = []
    n = len(stripped)
    for m in re.finditer(r"\bparallel\s*\(", stripped):
        # Start scanning at the char AFTER the opening paren of `parallel(`.
        depth = 1
        i = m.end()
        body_start = i
        in_str = None
        while i < n and depth > 0:
            c = stripped[i]
            if in_str is not None:
                if c == '\\':
                    i += 2          # escape — skip the next char verbatim
                    continue
                if c == in_str:
                    in_str = None
                i += 1
                continue
            if c in ("'", '"', '`'):
                in_str = c
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    spans.append((body_start, i))
                    break
            i += 1
        else:
            # Unbalanced (truncated script) → the group runs to EOF. Fail-open biased: a wider span
            # reads MORE devs as co-grouped verify-DEVs, yielding fewer BLOCKs.
            if depth > 0:
                spans.append((body_start, n))
    return spans

def in_verify_parallel_group(group_spans, has_rev_in_group, pos):
    # Is `pos` inside a parallel() group that ALSO contains a reviewer? group_spans is the list of
    # (start, end) parallel bounds; has_rev_in_group is the parallel-aligned bool list.
    for idx, (gs, ge) in enumerate(group_spans):
        if has_rev_in_group[idx] and gs <= pos <= ge:
            return True
    return False

def detect_docroute_leak(antigaming_src, attestation_src):
    # SECOND (weakest) detection pass — doc-routing leak. Raw-vs-stripped per source arg — see alias
    # defs. Returns True ONLY when ALL hold:
    #   (1) an intel-reporter / intel-planner spawn token is present (antigaming_src),
    #   (2) a hardcoded local-FS-path SHAPE used as a Target/destination is present (antigaming_src;
    #       username-agnostic — LOCAL_TARGET_RE matches the shape, never a specific user dir), AND
    #   (3) NO monitor-POST / clauded-docs routing signal anywhere (attestation_src suppressor).
    # FAIL-OPEN DOMINANT: any one condition unmet → False (PASS). A monitor-POST signal suppresses the
    # flag (the local path is then a staging buffer, not a leak — the intel-planner /tmp-then-curl
    # normal pattern). STRING HEURISTIC, defense-in-depth NOT a confidence anchor — the runtime
    # PreToolUse(Write) hook (block-doc-routing-leak.sh) is the primary guard; a missed leak beats a
    # false BLOCK of a legitimate workflow.
    doc_re = re.compile(
        r"['\"](" + '|'.join(re.escape(a) for a in DOC_AGENT_SET) + r")['\"]"
    )
    if not doc_re.search(antigaming_src):
        return False                       # no doc-agent spawn → out of scope → PASS
    if MONITOR_POST_RE.search(attestation_src):
        return False                       # monitor routing instructed (raw) → local path is staging → PASS
    if not LOCAL_TARGET_RE.search(antigaming_src):
        return False                       # no hardcoded local Target shape → PASS
    return True

# Two-line output contract: line 1 = the verdict token (BLOCK|BLOCK_DOCROUTE|BLOCK_ENTRY|PASS),
# consumed by the bash side for the exit code. line 2 = the entry marker (ENTRY_OK|ENTRY_ADVISORY),
# read by the bash side ONLY for the STDERR entry-advisory text selection on non-block paths — it
# NEVER influences the exit code (the verdict token is the sole exit driver). Both are emitted once
# at the end so the verdict line is always first.
def emit(verdict, entry_marker):
    print(verdict)
    print(entry_marker)
    sys.exit(0)

try:
    dev_set = sys.argv[1].split()
    src = sys.stdin.read()
    stripped = strip_comments(src)

    # ASYMMETRIC SCAN (P0) — SINGLE home of the raw-vs-stripped policy + rationale. Two source aliases
    # name the two evidentiary classes so every call site reads its INTENT, not a bare stripped/src
    # choice. The aliases ARE literally stripped/src, so behavior is unchanged:
    #   antigaming_src (comment-STRIPPED) — tokens where a comment must NOT count, because a commented
    #     spawn/target is not a real one: the dev-*/qa-code-reviewer/doc-agent spawn tokens, the
    #     LOCAL_TARGET leak TRIGGER, and the parallel(...) group machinery. Stripping IS the anti-gaming
    #     property — a commented-out spawn can neither satisfy nor trip the gate.
    #   attestation_src (RAW src) — author self-attestation / suppressor tokens whose evidentiary weight
    #     is IDENTICAL in a comment or a string: [ENTRY-CLASS], the plan-ref (PLAN_REF_RE), and the
    #     monitor-POST suppressor (MONITOR_POST_RE). Raw-scanned to MATCH the raw grep of the manual gate
    #     (enforce-verification-gate.sh references_plan greps the raw prompt, which has no comment
    #     concept) — stripping them would only false-BLOCK a legitimate workflow.
    antigaming_src = stripped
    attestation_src = src

    dev_alt = '|'.join(re.escape(d) for d in dev_set if d)
    # Quote-bounded DEV agentType token (antigaming_src — see alias defs).
    dev_re = re.compile(r"['\"](" + dev_alt + r")['\"]")
    rev_re = re.compile(r"['\"]qa-code-reviewer['\"]")
    dev_starts = [m.start() for m in dev_re.finditer(antigaming_src)]
    dev_present = bool(dev_starts)

    # Entry signal (attestation_src raw — see alias defs): a DEV-spawning script carrying NEITHER a
    # plan-reference NOR the entry literal is the silent entry-miss case. entry_ok is OR-composed so
    # either affirmative entry-token silences it. DEV-GATED — a non-DEV (doc-only) workflow can never
    # be an entry-miss, so its marker is forced ENTRY_OK regardless of plan-ref/token. The marker is
    # the SOLE input to the BLOCK_ENTRY promotion below; gating it on dev_present keeps a non-DEV
    # workflow from ever being entry-blocked.
    plan_ref_found = bool(PLAN_REF_RE.search(attestation_src))
    entry_token_found = ENTRY_CLASS_LITERAL in attestation_src
    entry_ok = (not dev_present) or plan_ref_found or entry_token_found
    entry_marker = "ENTRY_OK" if entry_ok else "ENTRY_ADVISORY"

    # SECOND detection pass (doc-routing leak) — INDEPENDENT of the verify-stage check below and run
    # FIRST so it can fire on a doc-only workflow that spawns no DEV agent. A leak emits its OWN
    # verdict token (BLOCK_DOCROUTE) so the bash side prints a distinct stderr reason while keeping
    # the SAME exit-2 block channel. When no leak is detected, control falls through to the
    # pre-existing verify-stage logic unchanged (the docroute pass is order-independent of entry).
    if detect_docroute_leak(antigaming_src, attestation_src):
        emit("BLOCK_DOCROUTE", entry_marker)

    if not dev_starts:
        # No DEV spawn at all → simple workflow → Stage-2 exempt → pass.
        emit("PASS", entry_marker)
    rev_matches = list(rev_re.finditer(antigaming_src))
    if not rev_matches:
        # DEV spawn present, NO non-comment qa-code-reviewer anywhere → clear omission → block.
        # ZERO-REVIEWER HARD GUARANTEE — preserved verbatim across the FP fix.
        emit("BLOCK", entry_marker)
    # Span of EVERY reviewer token (finditer, not the first match only). Keying on all reviewers is
    # what kills the multi-reviewer FP — a leading audit/Phase-1 qa-code-reviewer no longer decides
    # the verdict for a genuine {qa,dev} pair that appears later in the script.
    rev_spans = [(m.start(), m.end()) for m in rev_matches]
    rev_starts = [s for (s, _) in rev_spans]

    # parallel(...) group bounds + whether each group also holds a reviewer. This is the DISTANCE-
    # INDEPENDENT verify-pair signal: a parallel group containing BOTH a reviewer AND a dev-* is the
    # canonical verify stage no matter how long the inline goal strings are — the structural fix for
    # the window-blowout FP that a wide char-window alone cannot cover.
    group_spans = parallel_group_spans(antigaming_src)
    has_rev_in_group = [
        any(gs <= rs <= ge for rs in rev_starts) for (gs, ge) in group_spans
    ]

    # A dev-* is a verify-DEV (the DEV half of the {qa-code-reviewer, DEV} team) iff EITHER signal
    # holds: (1) it is co-located with ANY reviewer span (generalized R5 window), OR (2) it shares a
    # parallel(...) group with a reviewer (group-bounds — distance-independent). Co-location is the
    # only sound static discriminator because the verify-DEV and the impl-DEV use the IDENTICAL
    # dev-* agentType token. NO precede-fallback: the red team proved the "absorb the first impl dev
    # as a phantom verify-DEV" fallback OPENS A BYPASS (audit reviewer + 2+ impl devs + no genuine
    # parallel pair would wrongly PASS), so the verify-DEV signal is co-location/group-bounds ONLY.
    def is_verify_dev(d):
        return is_colocated_any(rev_spans, d) or in_verify_parallel_group(
            group_spans, has_rev_in_group, d
        )

    impl_dev_starts = [d for d in dev_starts if not is_verify_dev(d)]
    has_verify_dev = len(impl_dev_starts) < len(dev_starts)
    if not has_verify_dev:
        # Reviewer(s) present but NO co-located / co-grouped dev-* verifier → reviewer is alone → DEV
        # hard-gate absent → block. This is the case the red-team bypass (stray audit reviewer + 2+
        # scattered impl devs, NO genuine parallel(qa,dev) pair) lands in → BLOCK, no phantom absorb.
        emit("BLOCK", entry_marker)
    if not impl_dev_starts:
        # Every dev-* is a verify-DEV (verify-only, no separate implementation dev) → nothing to gate
        # → pass (fail-open; finer gating correctness stays an author obligation).
        emit("PASS", entry_marker)
    # Ordering on the IMPLEMENTATION dev-* (NOT the verify-DEV): SOME reviewer verify-spawn must
    # precede the first implementation dev-*. Order-independent within the verify parallel block —
    # parallel(reviewer, dev) and parallel(dev, reviewer) both pass because the verify-DEV is excluded
    # from impl_dev_starts. An implementation dev-* that NO reviewer precedes ran un-gated → block.
    if min(rev_starts) < min(impl_dev_starts):
        emit("PASS", entry_marker)
    emit("BLOCK", entry_marker)
except SystemExit:
    raise
except Exception:
    # Any parse/regex error → fail-open. Emit a conservative entry marker too: ENTRY_OK suppresses
    # the advisory so an internal error never produces a spurious entry nudge (advisory stays quiet
    # on the same uncertainty the verdict fails open on).
    emit("PASS", "ENTRY_OK")
PY
)"

# Run the helper. It prints TWO lines: line 1 = verdict token (BLOCK|PASS), line 2 = entry marker
# (ENTRY_OK|ENTRY_ADVISORY). A non-zero exit OR unparseable output → fail-open (PASS + ENTRY_OK).
helper_out="$(printf '%s' "${script_src}" | python3 -c "${verdict_py}" "${DEV_SET}" 2>/dev/null)" || helper_out=$'PASS\nENTRY_OK'

# Verdict = FIRST line only (byte-for-byte the same decision input as before the entry marker was
# added). Parameter expansion can never fail, so it cannot trip the set -e ERR trap.
verdict="${helper_out%%$'\n'*}"
# Entry marker = SECOND line (everything after the first newline). When the helper emitted only one
# line (legacy / truncated output), entry_marker collapses to the verdict token and the ENTRY_ADVISORY
# equality test below simply never matches → no advisory (fail-safe-to-silent). Pure expansion, no
# command → set -e safe by construction.
entry_marker="${helper_out#*$'\n'}"
[[ "${entry_marker}" == "${helper_out}" ]] && entry_marker="ENTRY_OK"

# ENTRY-MISS BLOCK (channel-a: stderr reason + exit 2) — promoted from the former advisory. Fires
# ONLY when the verify-stage verdict is NOT already a BLOCK of either kind (fully DECOUPLED — when a
# verify-stage / docroute BLOCK already holds, that block's own stderr + exit 2 below subsumes this)
# AND the entry signal is ENTRY_ADVISORY (DEV spawn with no plan-ref AND no [ENTRY-CLASS] token). It
# can NEVER fire when entry_ok holds: ENTRY_OK (non-DEV / plan-ref / token) never reaches here. The
# fail-open posture is preserved — any python helper error yields PASS + ENTRY_OK (the except clause),
# so an internal error never produces a spurious entry-block.
if [[ "${verdict}" != "BLOCK" && "${verdict}" != "BLOCK_DOCROUTE" && "${entry_marker}" == "ENTRY_ADVISORY" ]]; then
  entry_reason="$(
    cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (entry-miss): this Workflow script spawns DEV agent(s) with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification. Sizable DEV work MUST enter the Document-Driven Workflow (author a plan first). INLINE-PLAN note: a plan authored INLINE in this script (a one-shot author+verify+implement workflow) does NOT clear this gate, and the right fix is to PERSIST the plan first — not to widen the gate — because (i) this is a STATIC pre-execution scan that can NEVER see a runtime-minted clauded-docs id, so an inline one-shot plan is structurally invisible to the gate; (ii) the downstream Document-Driven lifecycle (plan↔implementation coverage reconciliation; doc_status completion) NEEDS the persisted plan artifact; (iii) the Stage-2 revision loop requires plan/implementation SEPARATION that a one-shot author+verify+implement workflow defeats. Two ways to clear this gate: (1) PERSIST the inline plan to the monitor (POST /api/clauded-docs) and reference the minted clauded-docs/<N> id in the workflow script (=> plan-ref token); (2) if GENUINELY simple — i.e. NONE of these sizable criteria hold (multi-file blast radius — ~3+ COORDINATED target files; 3+ files is a STRONG sizable signal, borderline → SIZABLE / cross-module / >=3 turns / public-contract — see scope-dev.md Sprint Contract Gate -> Sizable-task definition) — record an [ENTRY-CLASS] simple-task: <reason> classification in the workflow script (canonical form: a string, e.g. log('[ENTRY-CLASS] simple-task: <reason>'), or in meta.description). CAUTION: do NOT mint a throwaway token-doc purely to harvest a clauded-docs id — that is a NEW 편법 (a fresh loophole, not a fix); persist a REAL plan. Placement is not enforced (the entry / plan tokens are raw-scanned), so a commented token also satisfies this gate.

COPY-PASTE SCAFFOLD (the compliant path is fewer keystrokes than overriding — fill the <…> placeholders, persist the plan, then paste path (1) OR (2) into the script):

  --- path (1): persisted plan (sizable DEV work — the DEFAULT) ---
  // 1. POST the plan body to the monitor, capture the minted id:
  //    DOC_ID=$(curl -sf -X POST http://127.0.0.1:7842/api/clauded-docs \
  //      -H 'content-type: application/json' \
  //      --data "$(jq -n --arg b '<plan markdown body>' '{html_body:$b, doc_status:"progress"}')" \
  //      | jq -r '.id')
  // 2. reference the minted id in the workflow script (any placement — raw-scanned):
  log('plan-ref: clauded-docs/<DOC_ID>');

  --- path (2): genuinely simple, none of the sizable criteria hold ---
  log('[ENTRY-CLASS] simple-task: <one-line reason none of the sizable criteria hold>');
EOF
  )"
  block_and_exit "${entry_reason}" "block-entry"
fi

# SECOND-PASS VIOLATION (doc-routing leak): an intel-reporter / intel-planner spawn hardcodes a
# local-FS-path Target AND carries no monitor-POST / clauded-docs routing instruction. Distinct
# stderr reason, SAME exit-2 block channel. This is the WEAKEST layer (string heuristic) — the
# stderr names the runtime PreToolUse(Write) hook as the primary guard so the block reason does not
# read as a confidence anchor. Checked BEFORE the verify-stage pass branch so BLOCK_DOCROUTE never
# falls through to exit 0.
if [[ "${verdict}" == "BLOCK_DOCROUTE" ]]; then
  docroute_reason="$(
    cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (doc-routing leak): this Workflow script spawns an intel-reporter / intel-planner agent whose prompt hardcodes a LOCAL filesystem path as the deliverable Target AND contains NO monitor-POST / clauded-docs routing instruction. A document deliverable defaults to the monitor clauded-docs store (POST /api/clauded-docs) unless the user explicitly requested a local/other format — do NOT frame "Write-then-StructuredOutput to <local path>" as the deliverable. Route the document to the monitor clauded-docs API instead; if a local path is only a /tmp staging buffer cat-piped into a monitor POST, include the monitor-POST instruction so this static check recognizes the routing.

HONEST LIMIT — this is a STRING HEURISTIC (the WEAKEST of the defense-in-depth layers), NOT the primary guard: the runtime PreToolUse(Write) hook (block-doc-routing-leak.sh) is the mechanical write-time backstop. A path-shape match cannot prove intent, and this scan fail-opens on any uncertainty (no doc-agent spawn / no hardcoded path shape / any monitor-POST signal present). Do NOT treat the absence of this block as proof the routing is correct.
EOF
  )"
  block_and_exit "${docroute_reason}" "block-docroute"
fi

if [[ "${verdict}" != "BLOCK" ]]; then
  emit_trace "pass" "${script_len}"
  exit 0
fi

# VIOLATION (clear case): DEV-implementation spawn present AND the {qa-code-reviewer, DEV} verify
# team is incomplete — no qa-code-reviewer anywhere, OR a reviewer with NO co-located dev-*
# verifier (DEV hard-gate omitted), OR an implementation dev-* the reviewer does not precede
# (verify stage does not gate that implementation). All are missing-verify-stage omissions.
reason="$(
  cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED: this Workflow script spawns DEV-implementation agent(s) (agentType dev-*) but is missing its mandatory {qa-code-reviewer, DEV} verify-stage — either NO qa-code-reviewer verify-spawn precedes the first DEV implementation, OR a qa-code-reviewer is present but has NO co-located dev-* verifier (the DEV hard-gate half of the verify team is absent). A complex-plan workflow MUST encode a {qa-code-reviewer, DEV} Plan Direction Verification stage BEFORE the first DEV implementation stage, with implementation gated on the combined pass+feasible verdict (orchestrator-role.md Stage-2 gate; skills/glass-atrium-ops-orchestrator.md "In-script verify-stage" skeleton). Note: this is a presence/co-location HEURISTIC, not DEV-verdict enforcement.

How to fix — insert a verify stage ahead of the DEV implementation agent(), e.g.:

  pipeline(
    agent('intel-planner', { goal: 'author plan' }),
    parallel(
      agent('qa-code-reviewer', { goal: 'judge implementation/test-feasibility -> pass|revise' }),
      agent('dev-nestjs',       { goal: 'judge technical validity/approach -> feasible|infeasible' }),
    ),
    agent('dev-nestjs', { goal: 'implement per verified plan' }),  // gated on pass+feasible
  )

If this is a SIMPLE workflow (typo/import/config — no real implementation), the gate is exempt; this static heuristic fires only on a DEV-spawn-without-any-qa-code-reviewer script. Add a qa-code-reviewer verify-stage and retry.
EOF
)"

block_and_exit "${reason}" "block"
