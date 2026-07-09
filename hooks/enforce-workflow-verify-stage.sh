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
#     self-attestation / suppressor tokens ([ENTRY-CLASS], [SIZE-EST], plan-ref, monitor-POST routing
#     note) scan RAW src instead, matching the manual gate's raw grep: their evidentiary weight is
#     identical in a comment or a string, so stripping them only false-BLOCKs a legitimate workflow.
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
# ambiguity (python3 absent · helper error · output outside the enumerated BLOCK_* tokens → exit 0):
# a false-block of a legitimate workflow is worse than a missed bypass, so every uncertainty
# resolves to allow.
#
# CONDITIONAL ACTIVATION (unverified binding): whether the harness fires PreToolUse(Workflow) with
# tool_input.script exposed is NOT empirically confirmed. This
# hook is fail-open by design, so wiring it is SAFE even if the event never fires — it simply
# no-ops on any envelope mismatch. Verify firing with a runtime probe after wiring.
#
# FIRING INSTRUMENTATION (passive probe): on EVERY invocation that reaches the Workflow-tool
# decision point, a one-line trace is appended to ${HOME}/.claude/data/workflow-gate-fired.log
# (timestamp · tool_name · verdict · script-length). Trace verdict tags: pass · pass-noscript
# (empty/undecodable-script fail-open) · block-norev / block-noverifydev / block-order (verify-stage
# cause split) · block-docroute · block-entry · block-sizeest; the python3-absent and helper-error fallbacks still
# emit bare "pass" (deliberately outside the pass-noscript split). The orchestrator cannot trigger a Workflow
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
# Exit codes: 0 = pass / fail-open (default) · 2 = BLOCK. Four independent exit-2 verdicts share the
#   block channel: missing-verify-stage (clear case) · doc-routing leak (weakest, string heuristic) ·
#   entry-miss (DEV spawn with NO plan-ref AND NO [ENTRY-CLASS] simple-task token — the ultracode
#   equivalent of enforce-verification-gate.sh's entry-miss block; decoupled from the verify-stage
#   verdict, never fires when a plan-ref/token is present or on a non-DEV workflow) · size-attestation-miss
#   (a would-be-PASS DEV spawn under ENTRY_OK carrying NO [SIZE-EST] delegation-size token in the RAW
#   source — DEV-gated AND ENTRY_OK-gated so entry-miss keeps priority, and decoupled from the
#   verify-stage verdict exactly like entry-miss; never fires on a non-DEV workflow).
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
# every exit-2 verdict (entry-miss · doc-routing leak · size-attestation-miss · the three
# missing-verify-stage cause tags) — only the reason text and the trace tag differ. ${script_len} is
# read from the global set after the script decode.
#
# CENTRALIZED ENTRY ADDENDUM (message-only; was the inline F1 block on the verify-stage path) — when
# the block is one that SUPPRESSES the dedicated entry-miss nudge (the verify-stage cause tags and
# the docroute "block-docroute" verdict all pre-empt the entry-miss block) AND the entry signal is
# missing (${entry_marker:-} == ENTRY_ADVISORY), append the entry-format requirement to the SAME
# message so the author resolves both needs in one pass. ALLOWLIST gate (ADR-2): explicit
# enumeration block-norev | block-noverifydev | block-order | block-docroute — NO block-* glob;
# "block-entry" is EXCLUDED (it already prints full entry guidance) and "block-sizeest" is EXCLUDED
# (deliberate ADR-2 opt-OUT: block-sizeest fires ONLY under ENTRY_OK — the entry-miss block above has
# already exited on ENTRY_ADVISORY — so the entry addendum is structurally inert on it), and a future
# block path must opt IN deliberately (fail-safe vs silent scope-creep).
# Reads the GLOBAL entry_marker via ${entry_marker:-} — NO `local entry_marker` (a local would shadow
# the global with an empty value and silently disable the addendum on every path); the :- default is
# mandatory for set -u safety because this function runs under the line-87 fail-open ERR trap (an
# unbound-var error would fail-open to exit 0 and silently drop a legitimate block). The addendum is
# a single-quoted heredoc (no expansion -> injection-safe). MESSAGE-ONLY: verdict logic, branch
# conditions, the exit code (always 2), and emit_trace tag semantics are all unchanged.
block_and_exit() {
  local reason="${1}"
  local addendum_allowed
  case "${2}" in
    block-norev | block-noverifydev | block-order | block-docroute) addendum_allowed=true ;;
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

# emit_resilience_advisory — ADVISORY-ONLY (exit 0, stderr, NEVER blocks). A schema-mode workflow
# agent() THROWS on non-emit (uncaught → crashes the run); the .catch(() => null) in robustAgent is the
# load-bearing catcher that converts the throw to a null the retry handles, so every schema-mode agent()
# MUST be wrapped in the robustAgent retry-once-on-null / isolated-failure idiom (copy-verbatim
# skeleton: skills/glass-atrium-ops-orchestrator.md "### Resilient Workflow Authoring"). A per-call-site
# "absence of convention" scan is NOT soundly decidable (unbounded valid idioms) AND a BLOCK would
# violate this file's fail-open-DOMINANT posture — so this is a decidable WHOLE-SCRIPT token-presence
# nudge: a DEV-spawning script carrying a 'schema' token but ZERO 'robustAgent'/'catch' tokens anywhere
# → one-line stderr advisory. It reads the GLOBAL script_src + DEV_SET, emits nothing out of scope, and
# NEVER exits / NEVER alters the verdict — the block/pass decisions below own the exit code. DECOUPLED
# from the [SIZE-EST] / entry / verify-stage / docroute verdicts (a separate, purely additive check).
emit_resilience_advisory() {
  # DEV-spawn gate — only a script referencing a dev-* agentType is in scope (mirrors the entry / size
  # attestation DEV-gating). local IFS=' ' splits the space-separated DEV_SET; the file-global IFS is
  # $'\n\t', which would NOT split on space, so the local override is load-bearing (restored on return).
  local dev_tok found_dev=false
  local IFS=' '
  for dev_tok in ${DEV_SET}; do
    if [[ "${script_src}" == *"${dev_tok}"* ]]; then
      found_dev=true
      break
    fi
  done
  if [[ "${found_dev}" != true ]]; then
    return 0
  fi
  # No schema-mode agent() → no null-on-truncation risk → nothing to advise.
  if [[ "${script_src}" != *schema* ]]; then
    return 0
  fi
  # Resilience idiom already present (robustAgent wrapper OR any .catch) → compliant → stay quiet.
  if [[ "${script_src}" == *robustAgent* || "${script_src}" == *catch* ]]; then
    return 0
  fi
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY (resilience, non-blocking): this DEV workflow spawns a schema-mode agent() but contains NO robustAgent / .catch() retry-on-null wrapper. A schema-mode agent() THROWS on non-emit (uncaught → crashes the run) — wrap every schema-mode agent() in robustAgent so .catch(() => null) converts the throw to a handled null, via the retry-once-on-null + .catch(() => null) + .filter(Boolean) idiom (copy-verbatim skeleton: skills/glass-atrium-ops-orchestrator.md '### Resilient Workflow Authoring' + the '### Pipeline Acceptance Criteria' in-script verify-stage). NOTE: this is a WHOLE-SCRIPT presence check — it cannot tell a fully-wrapped script from one carrying robustAgent in one stage and a bare agent({schema}) in another, so wrap EVERY schema-mode agent(), not just one stage. ADVISORY ONLY — this check NEVER blocks." >&2
  return 0
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

# RESILIENCE ADVISORY (fail-open, stderr-only) — runs BEFORE the verdict dispatch and NEVER changes
# the exit code. Emits a one-line nudge when a DEV workflow spawns a schema-mode agent() with no
# robustAgent / .catch resilience idiom; silent otherwise. Decoupled from every block/pass verdict.
emit_resilience_advisory

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
# CLASSIFIER SIGNAL SET (recognized-shape CLOSED SET) — a two-tier token model plus a small closed
# set of canonical verify-stage shapes, NOT DEV-verdict enforcement. The DEV half of the
# {qa-code-reviewer, DEV} verify team is required, but the verify-DEV and the impl-DEV share the
# IDENTICAL dev-* agentType token, so they are token-indistinguishable by name. TWO-TIER MODEL:
#   TIER A — broad quote-bounded scan feeds PRESENCE gates ONLY (dev_present → exemption / entry /
#     size-est; reviewer existence → BLOCK_NOREV). A data-array config field like agent:'dev-*' counts
#     here, so a data-literal-only script is NOT Stage-2 exempt and still BLOCK_NOREVs with no reviewer.
#   TIER B — spawn-position scan (agent-call first-arg OR agentType field-value) feeds impl-dev
#     membership + verify-pair candidacy + ordering ONLY; a data-field literal is DATA and excluded.
# A dev-* is the verify-DEV iff it matches one of the FOUR recognized shapes (the CLOSED SET):
#   (1) CO-LOCATION — a Tier-B dev within 2000 comment-stripped chars of ANY reviewer span
#       (generalized over all reviewers via finditer, not just the first match).
#   (2) PARALLEL CO-MEMBERSHIP — a Tier-B dev sharing a balanced-paren parallel(...) group with a
#       reviewer (DISTANCE-INDEPENDENT so a long inline goal string cannot break detection).
#   (3) PIPELINE STAGE-ADJACENCY — a reviewer-bearing pipeline stage IMMEDIATELY followed by a stage
#       holding a Tier-B dev spawn OR a NON-literal agentType (identifier / member / ternary); the
#       computed-agentType spawn is recognized in THAT adjacent stage ONLY. Canonical engine
#       pipeline(items, reviewerStage, devStage) signature.
#   (4) TWO-TIER DATA-FIELD EXCLUSION — the Tier-A/Tier-B split above: a dev literal parked in a data
#       config field is DATA, never an impl-dev or a pair operand.
# The helper partitions the Tier-B dev-* tokens into the verify-DEV (any recognized shape holds) and
# the implementation dev-* tokens (everything else), then decides:
#   - reviewer(s) present but NO verify-DEV by any recognized shape → DEV hard-gate absent → BLOCK.
#   - a verify-DEV present AND every implementation dev-* is preceded by SOME reviewer → PASS
#     (ORDER-INDEPENDENT within a pair: the verify-DEV is EXCLUDED from the implementation set).
#   - an implementation dev-* that NO reviewer precedes → it ran un-gated → BLOCK.
#
# STANDING REJECTION (phantom-absorption): NO precede-fallback — the red team proved a "absorb the
# first impl dev as a phantom verify-DEV when dev-*>=2 and a reviewer precedes" fallback OPENS A
# BYPASS (audit reviewer + 2+ scattered impl devs + no genuine pair would wrongly PASS). The
# sanctioned alternative is shape (3) adjacency, CONFINED to the reviewer-adjacent stage — a filler
# stage between the reviewer stage and a dev stage BREAKS the pair, and group-wide indirection
# pairing is deliberately NOT present. The fix only WIDENS the PASS set for genuine verify-stages;
# it NEVER admits a zero-genuine-verify-pair DEV-impl workflow. Multi-reviewer + window-blowout FPs
# are both covered (finditer over every reviewer + the parallel-group / pipeline-adjacency signals).
# A presence/co-location heuristic only — it NEVER inspects a runtime feasible verdict (which does
# not exist at static-scan time) and is labeled HEURISTIC, not enforcement. A wide window plus the
# fail-open-biased group scan keep it FAIL-OPEN DOMINANT.
#
# KNOWN LIMITATION / ACCEPTED FALSE-NEGATIVES (reported honestly): because verify-DEV and impl-DEV
# share the same token, this heuristic cannot prove a co-located DEV is a verifier rather than an
# implementer (a lone dev-* within the window, or a dev-then-reviewer pair with nothing after, both
# PASS). And a fully computed agentType with ZERO dev literals ANYWHERE is invisible to Tier A, so
# the script is Stage-2 exempt — a PRE-EXISTING blind spot, posture UNCHANGED by the two-tier fix.
# Both are accepted fail-open false-negatives: a missed bypass is preferred over a false BLOCK of a
# legitimate workflow. The DEV-verdict correctness itself remains the orchestrator honor-system
# authoring obligation.
#
# The detection + comment-strip + co-location + ordering runs in ONE python3 helper that emits a
# cause-split verdict token
# (BLOCK_NOREV | BLOCK_NOVERIFYDEV | BLOCK_ORDER | BLOCK_DOCROUTE | BLOCK_SIZEEST | PASS) on stdout.
# CRITICAL — FAIL-OPEN DOMINANT: python3 absent, the helper erroring, OR any stdout outside the
# enumerated BLOCK_* tokens → treated as PASS (exit 0). This is a heuristic backstop; a false-BLOCK
# on a legitimate workflow is worse than a missed bypass, so every uncertainty resolves to allow.
# Only a confident cause token blocks: BLOCK_NOREV (DEV spawned AND no non-comment qa-code-reviewer
# anywhere) · BLOCK_NOVERIFYDEV (reviewer present but NO co-located / co-grouped dev-* verifier) ·
# BLOCK_ORDER (an implementation dev-* the reviewer does not precede) · BLOCK_SIZEEST (a would-be-PASS
# DEV workflow under ENTRY_OK carrying NO [SIZE-EST] delegation-size token in the RAW source).
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

# String-literal opening quote chars (single / double / template backtick) — shared by every
# string-aware scanner so the backtick literal appears once.
_STR_QUOTES = ("'", '"', '`')

# Proximity-window half-width in chars for the DEV-verifier co-location heuristic. A dev-* token
# within this many chars of the reviewer token counts as the DEV half of the verify team. Generous
# on purpose: a wider window reads MORE workflows as having a co-located DEV verifier, so it yields
# FEWER BLOCKs and stays fail-open dominant. Sized to span the canonical verify stage parallel block
# holding qa-code-reviewer plus the primary-domain dev agent side by side INCLUDING a multi-sentence
# reviewer goal string, AND the sequential reviewer-to-dev distance of the real case-B fan-out shape.
# Validated safe band 1196-2849: a real case-B dev sits 1196-1617 chars from its trailing reviewer,
# while the red-team must-BLOCK fixture keeps its scattered devs ~2789-2850 chars out — so 2000
# admits case B while the red-team stays BLOCKED, with a disclosed ~789-char margin to that fixture.
# Widening past ~2850 reopens the red-team bypass; the durable fix for the residual case-B gap is the
# deferred assignment-taint signal, not a wider window.
COLOCATION_WINDOW = 2000

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
# Delegation-size self-attestation literal — the SIBLING of ENTRY_CLASS_LITERAL. Same P0 attestation
# class (author self-attestation — identical evidentiary weight in a comment or a string) so it is
# raw-scanned on attestation_src, NOT the comment-stripped source. Bracketed anchor only (presence-only,
# per the existence-only contract — the bundles=/tool_uses~= estimate CORRECTNESS is never checked, same
# boundary as [ENTRY-CLASS]): any [SIZE-EST] token counts. Canonical form:
# log('[SIZE-EST] bundles=N tool_uses~=N — <reason>'); contract SoT: orchestrator-role.md ### Spawn
# Budget -> Delegation-size discipline [SIZE-EST] bullet.
SIZE_EST_LITERAL = "[SIZE-EST]"

# Doc-routing local-destination attestation literal — the sanctioned carrier of the "user explicitly
# requested a local destination" exception (new file OR an edit of an existing user file). Canonical
# stamped form: log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>'). Same P0
# attestation class as ENTRY_CLASS_LITERAL / MONITOR_POST_RE (author self-attestation — identical
# evidentiary weight in a comment or a string) → raw-scanned on attestation_src.
DOC_ROUTE_LOCAL_LITERAL = "[DOC-ROUTE] user-requested-local:"
# Shared local-FS path SHAPE — single source for the four path-shape sites (TOKEN_LINE_RE +
# LOCAL_TARGET_RE A4a/A4b/A4c). A3 deliberately diverges (looser legacy charclass — see the A3 line).
LOCAL_PATH_SHAPE = r"(?:~|\$HOME|\$\{HOME\}|/)[A-Za-z0-9_./-]*"
# Shared left-boundary lookbehind (A3 + A4a): an inner slash of a RELATIVE path must not anchor a match.
LEFT_BOUNDARY = r"(?<![A-Za-z0-9_.-])"
# Stamped-path extractor for the [DOC-ROUTE] suppressor. A CONCRETE file path including a
# dot-extension is REQUIRED after the colon (no capture → nothing suppressed — a bare stamp never
# clears the gate; a bare tilde, a bare slash, or an extensionless directory extracts nothing,
# because a degenerate short capture would substring-match every tilde/slash scan line and
# reintroduce the forbidden blanket suppression through the capture group). Path/line-scoping safety
# semantics (what a stamp may and may not clear) live at the detect_docroute_leak suppressor comment.
# Honor-system limit (accepted, same class as [ENTRY-CLASS] / plan-ref): an honest and a dishonest
# stamp of the same path are statically indistinguishable. NOTE bash-3.2 $(...)-scan constraint:
# comments in this heredoc must keep quote chars in immediate balanced pairs (no bare apostrophes)
# or the outer command substitution mis-parses on stock macOS bash.
TOKEN_LINE_RE = re.compile(
    re.escape(DOC_ROUTE_LOCAL_LITERAL)
    + r"\s*(" + LOCAL_PATH_SHAPE + r"\.[A-Za-z0-9]+)"
)

# Document-authoring agentTypes whose Workflow spawn prompts route to the monitor clauded-docs store
# by default. A hardcoded local FS Target in one of these spawns, with no monitor-POST instruction,
# is the doc-routing leak this SECOND (weakest) pass flags. Keep in sync with the REPORT/PLANNING
# scope agents in core-compliance-matrix.md.
DOC_AGENT_SET = ("glass-atrium-intel-reporter", "glass-atrium-intel-planner")

# Generic local-FS-path SHAPE signals — username-agnostic by construction (NO baked-in user dir).
# A doc-routing leak hardcodes a local path as the deliverable DESTINATION; these match the SHAPE,
# never a specific username. Run on the comment-stripped source so a path inside a comment does not
# trip the heuristic. DESTINATION-GATED: a mere MENTION of a local doc path (an edit-existing target,
# a read-context reference) is NOT a leak — a bare-path .md alternative flags any mention, so every
# .md alternative requires destination framing (verb+preposition or a noun header).
#   - A1 "Target file:" — the forensic leak phrasing, SINGULAR ONLY: the plural "Target files:" is
#     the standard 6-element edit-delegation header of the orchestrator and stays a non-match.
#   - A2 mkdir-then-Write — the "mkdir -p <dir> && Write" / "mkdir -p ... then Write" leak shape.
#   - A3 write/output + "to" + local path, any doc ext. "output" is gated HERE (verb + "to"), NOT as
#     a bare A4a verb: output-as-noun is read-context vocabulary ("follow the Output Format Routing
#     in <path>") and must not anchor a match without the "to" preposition.
#   - A4a destination verb (save|deliver|store|persist) + preposition (to|into|under|as) + .md path.
#     EXCLUDED verbs — "target": the plural-header FP above (A1 stays singular-only for the same
#     reason) · "emit"/"place": harness-standard delegation vocabulary ("emit StructuredOutput" /
#     "edit in place"). EXCLUDED prepositions — "at"/"in": reference-mention framings ("the document
#     at <path>" / "Routing in <path>") whose inclusion would re-block the edit-existing + wiki-store
#     cases. Left-boundary lookbehind (?<![A-Za-z0-9_.-]) on A3 + A4a: an inner slash of a RELATIVE
#     path no longer anchors a match, so the GLOBAL_RULES-mandated checkpoint phrasing "save/write
#     your progress notes to memory/progress-x.md" passes. Preposition-less "save <path>" is an accepted
#     static FN — the runtime Write hook (block-doc-routing-leak.sh) is the primary guard for .md.
#   - A4b bare local path, .html/.markdown ONLY — deliberately lookbehind-FREE and verb-free (full
#     bare-path static strength). LAYER COUPLING: block-doc-routing-leak.sh covers only
#     {.md,.yaml,.yml,.json,.txt}, so .html/.markdown are runtime-BLIND. A4b may be narrowed to a
#     verb gate ONLY after that runtime extension set is widened to include .html/.markdown (the
#     deferred T4 ticket) — until then, narrowing static .html detection removes the sole mechanical
#     net for HTML document leaks. Known residual FP: an edit-existing MENTION of a .html/.markdown
#     path still blocks (relief: the [DOC-ROUTE] token when user-requested, else T4).
#   - A4c verb-free noun-header destination framing ("Deliverable:" / "Destination:" /
#     "final location:") + local .md path — html/markdown noun-headers ride the A4b bare-path match.
LOCAL_TARGET_RE = re.compile(
    r"target\s+file\s*:"                                  # A1 — "Target file:" (singular only)
    + r"|mkdir\s+-p[^\n]{0,200}?(?:&&|;|then)[^\n]{0,80}?\bwrite\b"  # A2 — mkdir -p ... && Write shape
    + r"|\b(?:write|output)\b[^\n]{0,80}?\bto\b[^\n]{0,80}?" + LEFT_BOUNDARY + r"(?:~|\$HOME|/)[^\s'\"]*\.(?:md|markdown|html|yaml|yml|json|txt)"  # A3 — write/output ... to <local path>.<doc ext>; deliberate looser charclass, NOT LOCAL_PATH_SHAPE — do not unify
    + r"|\b(?:save|deliver|store|persist)\b[^\n]{0,80}?\b(?:to|into|under|as)\b[^\n]{0,60}?" + LEFT_BOUNDARY + LOCAL_PATH_SHAPE + r"\.md\b"  # A4a — destination verb+prep, .md
    + r"|" + LOCAL_PATH_SHAPE + r"\.(?:html|markdown)\b"  # A4b — bare path, runtime-blind exts
    + r"|\b(?:deliverable|destination|final\s+location)\s*:[^\n]{0,120}?" + LOCAL_PATH_SHAPE + r"\.md\b",  # A4c — noun-header destination, .md only
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
    r"|127\.0\.0\.1:16145"                                # monitor base URL (port from convention)
    r"|html_body"                                         # the PUT/POST body field name
    r"|doc_status",                                       # the clauded-docs lifecycle field
    re.IGNORECASE,
)

def strip_comments(src):
    # String-aware removal of // line comments and /* */ block comments. Tracks single/double/
    # backtick string state with backslash escapes so a // or /* inside a string is preserved.
    # Newlines are preserved inside BOTH comment kinds so the output keeps source-line identity
    # (the [DOC-ROUTE] suppressor is line-scoped and must never see two source lines merged).
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
            if c == '\n':
                out.append(c)
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

def _balanced_call_bodies(stripped, open_re):
    # Balanced-paren body span of every call whose opening name-paren matches open_re — open_re MUST
    # end AT the opening paren. Returns a list of (start, end) half-open char ranges covering the
    # parenthesized argument list of each such call. String-aware: a paren inside a string literal
    # does not move the depth counter, so a paren inside a goal string cannot mis-bound a body.
    # Fail-open biased: an unbalanced/truncated call runs its body to EOF (a wider span reads MORE
    # devs as co-grouped verify-DEVs, yielding fewer BLOCKs). Shared by parallel_group_spans and the
    # pipeline stage splitter so both use the identical scanning discipline. Runs on comment-stripped
    # source.
    spans = []
    n = len(stripped)
    for m in re.finditer(open_re, stripped):
        # Start scanning at the char AFTER the opening paren.
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
            if c in _STR_QUOTES:
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
            if depth > 0:
                spans.append((body_start, n))
    return spans

def parallel_group_spans(stripped):
    # Balanced-paren bounds of every parallel( ... ) group — the DISTANCE-INDEPENDENT verify-pair
    # signal: a parallel group containing BOTH a qa-code-reviewer AND a dev-* spawn is the canonical
    # verify stage REGARDLESS of how long the inline goal strings are (the structural fix for the
    # window-blowout FP). Delegates the balanced-paren scan to _balanced_call_bodies.
    return _balanced_call_bodies(stripped, r"\bparallel\s*\(")

def split_top_level_args(stripped, body_start, body_end):
    # Split a call body from body_start up to body_end into top-level argument char-spans, cutting
    # ONLY at a comma at combined-bracket-depth 0 (string-aware). Any of open paren / bracket / brace
    # increases depth and its close decreases it, so a comma inside a nested call, array, or object
    # never splits. The top-level args of a pipeline call ARE its stages.
    args = []
    depth = 0
    in_str = None
    i = body_start
    arg_start = body_start
    while i < body_end:
        c = stripped[i]
        if in_str is not None:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in _STR_QUOTES:
            in_str = c
        elif c == '(' or c == '[' or c == '{':
            depth += 1
        elif c == ')' or c == ']' or c == '}':
            depth -= 1
        elif c == ',' and depth == 0:
            args.append((arg_start, i))
            arg_start = i + 1
        i += 1
    args.append((arg_start, body_end))
    return args

def pipeline_verify_pair_stages(stripped, rev_spawn_re, dev_spawn_re, nonlit_re):
    # Pipeline STAGE-ADJACENCY verify-pair recognition — the sound salvage of the canonical engine
    # composition signature pipeline(items, reviewerStage, devStage). For each pipeline call, split
    # its body into top-level stage args; a reviewer-bearing stage IMMEDIATELY followed by a stage
    # holding either a Tier-B dev spawn OR an agent-call with a NON-literal agentType value is a
    # verify pair. Returns the char-spans of each such dev-half stage.
    # CONFINED to the immediately-adjacent stage ONLY — NEVER whole-group co-membership: a phantom
    # indirect spawn anywhere inside a reviewer-bearing whole-script pipeline must NOT count, or the
    # recorded red-team bypass reopens. A filler stage between the reviewer stage and the dev stage
    # breaks the adjacency and the pair is not recognized.
    pair_dev_spans = []
    for bs, be in _balanced_call_bodies(stripped, r"\bpipeline\s*\("):
        args = split_top_level_args(stripped, bs, be)
        for idx in range(len(args) - 1):
            rs, r_end = args[idx]
            if rev_spawn_re.search(stripped[rs:r_end]):
                ns, n_end = args[idx + 1]
                nxt = stripped[ns:n_end]
                if dev_spawn_re.search(nxt) or nonlit_re.search(nxt):
                    pair_dev_spans.append((ns, n_end))
    return pair_dev_spans

def in_pipeline_pair_stage(pair_dev_spans, pos):
    # Is pos inside the dev-half stage of a pipeline adjacency verify pair? A Tier-B dev LITERAL there
    # is the verify-DEV, excluded from the implementation set exactly like a co-located / co-grouped
    # one.
    return any(ps <= pos <= pe for ps, pe in pair_dev_spans)

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
    #       username-agnostic — LOCAL_TARGET_RE matches the shape, never a specific user dir),
    #   (3) NO monitor-POST / clauded-docs routing signal anywhere (attestation_src suppressor), AND
    #   (4) the leak line is NOT covered by a [DOC-ROUTE] user-requested-local: <path> stamp
    #       (attestation_src, path/line-scoped — see TOKEN_LINE_RE).
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
    # [DOC-ROUTE] attestation suppressor — path/line-scoped, NEVER a blanket early-return: one stamp
    # must not clear the leak of a DIFFERENT spawn. Stamped paths are extracted from RAW attestation_src
    # (author self-attestation class — see alias defs); ONLY the scan-source lines carrying a stamped
    # path are dropped, then LOCAL_TARGET_RE re-runs on the residual. A bare stamp with no path after
    # the colon extracts nothing and suppresses nothing. Line identity holds: strip_comments preserves
    # newlines inside BOTH comment kinds, so splitlines() below maps 1:1 to source lines — a /* */
    # comment spanning from a stamped line onto a DIFFERENT spawn leak line can never merge them.
    # The min-length filter excludes the 3-char anchor-only captures the regex still admits
    # (e.g. ~.x); TOKEN_LINE_RE already guarantees a non-empty dotted capture, so length is the sole
    # residual constraint.
    scan_src = antigaming_src
    stamped_paths = [p for p in TOKEN_LINE_RE.findall(attestation_src) if len(p) >= 4]
    if stamped_paths:
        scan_src = "\n".join(
            line
            for line in antigaming_src.splitlines()
            if not any(p in line for p in stamped_paths)
        )
    if not LOCAL_TARGET_RE.search(scan_src):
        return False                       # no local destination shape on the residual → PASS
    return True

# Two-line output contract: line 1 = the verdict token
# (BLOCK_NOREV|BLOCK_NOVERIFYDEV|BLOCK_ORDER|BLOCK_DOCROUTE|BLOCK_SIZEEST|PASS) — this helper NEVER
# emits a BLOCK_ENTRY; the entry-miss block is promoted BASH-side from line 2. line 2 = the entry marker
# (ENTRY_OK|ENTRY_ADVISORY): on a PASS verdict it drives the bash entry-miss promotion (block-entry,
# exit 2); on a BLOCK_* verdict it only selects the entry addendum text (allowlisted trace tags).
# Both are emitted once at the end so the verdict line is always first.
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

    # TWO-TIER TOKEN MODEL (see the CLASSIFIER SIGNAL SET comment block above).
    #   TIER A — broad quote-bounded scan. Feeds PRESENCE gates ONLY: dev_present drives the Stage-2
    #     exemption + entry + size-est gating, and the reviewer-EXISTENCE guarantee drives BLOCK_NOREV.
    #     ANY quoted dev/reviewer literal counts here, INCLUDING a data-array config field such as
    #     agent: 'glass-atrium-dev-shell' — so a script whose dev literals are all data fields is NOT
    #     Stage-2 exempt, and BLOCK_NOREV still fires when its reviewer literal is absent. Byte-identical
    #     to the pre-two-tier scan.
    #   TIER B — spawn-position scan. Feeds impl-dev membership, verify-pair candidacy, and the ordering
    #     check ONLY. A dev/reviewer literal counts as a SPAWN iff it sits in an agent-call
    #     first-argument position OR an agentType field-value position; a data-field literal is DATA and
    #     excluded. The exemption branch and BLOCK_NOREV NEVER key on Tier B — exempt-on-Tier-B is
    #     forbidden: it would silently PASS a data-literal + reviewer + non-adjacent-indirection script
    #     that today correctly BLOCK_NOVERIFYDEVs.
    dev_re_present = re.compile(r"['\"](" + dev_alt + r")['\"]")
    rev_re_present = re.compile(r"['\"]glass-atrium-qa-code-reviewer['\"]")
    dev_starts_present = [m.start() for m in dev_re_present.finditer(antigaming_src)]
    dev_present = bool(dev_starts_present)

    # Tier-B spawn-position match: a dev/reviewer literal counts iff it sits right after an agent-call
    # open paren OR an agentType option value. Two full alternatives joined at the top level with a
    # bare pipe — NO non-capturing group — so the alternation needs no wrapping parens. bash-3.2
    # $(...)-scan constraint on this heredoc: a source-level escaped open paren unbalances the scanner,
    # so the literal open paren is injected via chr(40) — itself a balanced source token; the compiled
    # regex is identical to the escaped-paren form. _dev_tok / _rev_tok mirror the balanced group
    # parens of the Tier-A scan above.
    _agent_open = r"agent" + "\\" + chr(40) + r"\s*"
    _agenttype = r"agentType\s*:\s*"
    _dev_tok = r"['\"](" + dev_alt + r")['\"]"
    _rev_tok = r"['\"]glass-atrium-qa-code-reviewer['\"]"
    dev_re = re.compile(_agent_open + _dev_tok + r"|" + _agenttype + _dev_tok)
    rev_re = re.compile(_agent_open + _rev_tok + r"|" + _agenttype + _rev_tok)
    dev_starts = [m.start() for m in dev_re.finditer(antigaming_src)]

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

    # Delegation-size self-attestation (attestation_src RAW — same P0 author-self-attestation class as
    # [ENTRY-CLASS] / plan-ref: identical evidentiary weight in a comment or a string, so a commented
    # [SIZE-EST] token counts too). size_est_missing gates the BLOCK_SIZEEST promotion at the would-be
    # PASS emits below. THREE conjuncts:
    #   dev_present     — DEV-gated: a non-DEV (doc-only) workflow can never miss a delegation-size
    #                     token, so it is never block-sizeest;
    #   entry_ok        — ENTRY_OK-gated so entry-miss keeps PRIORITY: an entry-missing DEV script has
    #                     entry_ok False here, so it is NOT promoted to BLOCK_SIZEEST — it falls through
    #                     to PASS and the bash entry-miss block claims it (block-entry, not block-sizeest);
    #   SIZE-EST absent — the [SIZE-EST] delegation-size token is not in the RAW source.
    # Presence-only per the existence-only contract — the bundles=/tool_uses~= estimate CORRECTNESS is
    # never checked, same boundary as [ENTRY-CLASS]. Promotion happens ONLY on a would-be PASS
    # (decoupled from the verify-stage verdict exactly like the bash entry-miss block), so a
    # verify-stage BLOCK always keeps priority over block-sizeest.
    size_est_missing = dev_present and entry_ok and (SIZE_EST_LITERAL not in attestation_src)

    # SECOND detection pass (doc-routing leak) — INDEPENDENT of the verify-stage check below and run
    # FIRST so it can fire on a doc-only workflow that spawns no DEV agent. A leak emits its OWN
    # verdict token (BLOCK_DOCROUTE) so the bash side prints a distinct stderr reason while keeping
    # the SAME exit-2 block channel. When no leak is detected, control falls through to the
    # pre-existing verify-stage logic unchanged (the docroute pass is order-independent of entry).
    if detect_docroute_leak(antigaming_src, attestation_src):
        emit("BLOCK_DOCROUTE", entry_marker)

    if not dev_starts_present:
        # No DEV literal ANYWHERE (Tier A) → simple workflow → Stage-2 exempt → pass. Keys on Tier A:
        # a script whose only dev literals are data-array config fields is NOT exempt — Tier A sees
        # them — and falls through to the reviewer / pair logic. exempt-on-Tier-B is forbidden.
        emit("PASS", entry_marker)
    rev_matches = list(rev_re_present.finditer(antigaming_src))
    if not rev_matches:
        # DEV literal present (Tier A), NO non-comment qa-code-reviewer literal anywhere → clear
        # omission → block. ZERO-REVIEWER HARD GUARANTEE — keys on Tier A, preserved verbatim.
        emit("BLOCK_NOREV", entry_marker)

    # Tier-B reviewer SPAWNS (spawn-position) feed the co-location / pair / ordering logic — distinct
    # from the Tier-A rev_matches presence gate above: a reviewer literal in a data field satisfies
    # BLOCK_NOREV but cannot anchor a verify pair. finditer over EVERY Tier-B reviewer kills the
    # multi-reviewer FP: a leading audit reviewer no longer decides the verdict for a later pair.
    rev_spans = [(m.start(), m.end()) for m in rev_re.finditer(antigaming_src)]
    rev_starts = [s for (s, _) in rev_spans]

    # parallel(...) group bounds + whether each group also holds a Tier-B reviewer. DISTANCE-
    # INDEPENDENT verify-pair signal (the canonical parallel verify stage regardless of goal length).
    group_spans = parallel_group_spans(antigaming_src)
    has_rev_in_group = [
        any(gs <= rs <= ge for rs in rev_starts) for (gs, ge) in group_spans
    ]

    # pipeline STAGE-ADJACENCY verify pairs (T2) — the canonical engine pipeline(items, reviewer, dev)
    # signature. A reviewer-bearing stage immediately followed by a stage holding a Tier-B dev spawn
    # OR a non-literal agentType is the pair; its dev-half stage spans mark verify-DEVs. nonlit_re =
    # an agentType option whose value is NOT a quoted literal (identifier / member / ternary / paren)
    # — the computed-agentType dev spawn co-location cannot see. Confined to the adjacent stage.
    nonlit_re = re.compile(r"agentType\s*:\s*(?!['\"])")
    pair_dev_spans = pipeline_verify_pair_stages(antigaming_src, rev_re, dev_re, nonlit_re)
    pipeline_pair_found = bool(pair_dev_spans)

    # A dev-* is a verify-DEV (the DEV half of the team) iff ANY signal holds: co-located with a
    # Tier-B reviewer span, sharing a reviewer parallel(...) group, OR sitting in the dev-half stage
    # of a pipeline adjacency pair. All three anchor on Tier-B reviewers. NO precede-fallback (the
    # dropped absorb-first-impl-dev fallback opened a bypass); the pipeline-pair signal is confined to
    # the adjacent stage, so the gaming floor stays at a one-line lie.
    def is_verify_dev(d):
        return (
            is_colocated_any(rev_spans, d)
            or in_verify_parallel_group(group_spans, has_rev_in_group, d)
            or in_pipeline_pair_stage(pair_dev_spans, d)
        )

    # OPERAND-CONSISTENCY (load-bearing): impl_dev_starts and BOTH sides of the count comparison take
    # Tier-B spawn-position devs ONLY. Reusing the Tier-A broad count on either side would pass a
    # config-array + stray-reviewer + indirection script for the WRONG reason (a count mismatch, not a
    # recognized pair) and reopen a bypass. has_verify_dev is OR-ed with pipeline_pair_found so the
    # case-A shape (reviewer stage → non-literal-agentType stage, ZERO dev literals) flips even when
    # the Tier-B count comparison is 0 < 0.
    impl_dev_starts = [d for d in dev_starts if not is_verify_dev(d)]
    has_verify_dev = (len(impl_dev_starts) < len(dev_starts)) or pipeline_pair_found
    if not has_verify_dev:
        # Reviewer(s) present but NO verify-DEV by any signal → DEV hard-gate absent → block. The
        # recorded red-team bypass (stray audit reviewer + scattered impl devs separated by filler
        # stages, NO genuine pair) lands here → BLOCK, no phantom absorb.
        emit("BLOCK_NOVERIFYDEV", entry_marker)
    if not impl_dev_starts:
        # Every Tier-B dev is a verify-DEV (verify-only, no separate implementation) → would-be PASS.
        # The size-est promotion still applies (DEV + ENTRY_OK + no [SIZE-EST] → BLOCK_SIZEEST).
        emit("BLOCK_SIZEEST" if size_est_missing else "PASS", entry_marker)
    # Ordering on the IMPLEMENTATION dev-* (NOT the verify-DEV): SOME reviewer must precede the first
    # impl dev-*. Order-independent within a verify pair (the verify-DEV is excluded from impl). An
    # impl dev-* that NO reviewer precedes ran un-gated → block.
    if min(rev_starts) < min(impl_dev_starts):
        # Valid verify-stage ordering → would-be PASS, subject to the size-est promotion.
        emit("BLOCK_SIZEEST" if size_est_missing else "PASS", entry_marker)
    emit("BLOCK_ORDER", entry_marker)
except SystemExit:
    raise
except Exception:
    # Any parse/regex error → fail-open. Emit a conservative entry marker too: ENTRY_OK suppresses
    # the advisory so an internal error never produces a spurious entry nudge (advisory stays quiet
    # on the same uncertainty the verdict fails open on).
    emit("PASS", "ENTRY_OK")
PY
)"

# Run the helper. It prints TWO lines: line 1 = verdict token
# (BLOCK_NOREV|BLOCK_NOVERIFYDEV|BLOCK_ORDER|BLOCK_DOCROUTE|BLOCK_SIZEEST|PASS), line 2 = entry marker
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
# ONLY when the verify-stage verdict is NOT already a BLOCK_* of any kind (unquoted BLOCK* glob —
# fully DECOUPLED: when a verify-stage / docroute BLOCK already holds, that block's own stderr +
# exit 2 below subsumes this) AND the entry signal is ENTRY_ADVISORY (DEV spawn with no plan-ref AND
# no [ENTRY-CLASS] token). It can NEVER fire when entry_ok holds: ENTRY_OK (non-DEV / plan-ref /
# token) never reaches here. The fail-open posture is preserved — any python helper error yields
# PASS + ENTRY_OK (the except clause), so an internal error never produces a spurious entry-block.
if [[ "${verdict}" != BLOCK* && "${entry_marker}" == "ENTRY_ADVISORY" ]]; then
  entry_reason="$(
    cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (entry-miss): this Workflow script spawns DEV agent(s) with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification. Sizable DEV work MUST enter the Document-Driven Workflow (author a plan first). INLINE-PLAN note: a plan authored INLINE in this script (a one-shot author+verify+implement workflow) does NOT clear this gate, and the right fix is to PERSIST the plan first — not to widen the gate — because (i) this is a STATIC pre-execution scan that can NEVER see a runtime-minted clauded-docs id, so an inline one-shot plan is structurally invisible to the gate; (ii) the downstream Document-Driven lifecycle (plan↔implementation coverage reconciliation; doc_status completion) NEEDS the persisted plan artifact; (iii) the Stage-2 revision loop requires plan/implementation SEPARATION that a one-shot author+verify+implement workflow defeats. Two ways to clear this gate: (1) PERSIST the inline plan to the monitor (POST /api/clauded-docs) and reference the minted clauded-docs/<N> id in the workflow script (=> plan-ref token); (2) if GENUINELY simple — i.e. NONE of these sizable criteria hold (multi-file blast radius — ~3+ COORDINATED target files; 3+ files is a STRONG sizable signal, borderline → SIZABLE / cross-module / >=3 turns / public-contract — see scope-dev.md Sprint Contract Gate -> Sizable-task definition) — record an [ENTRY-CLASS] simple-task: <reason> classification in the workflow script (canonical form: a string, e.g. log('[ENTRY-CLASS] simple-task: <reason>'), or in meta.description). CAUTION: do NOT mint a throwaway token-doc purely to harvest a clauded-docs id — that is a NEW 편법 (a fresh loophole, not a fix); persist a REAL plan. Placement is not enforced (the entry / plan tokens are raw-scanned), so a commented token also satisfies this gate.

COPY-PASTE SCAFFOLD (the compliant path is fewer keystrokes than overriding — fill the <…> placeholders, persist the plan, then paste path (1) OR (2) into the script):

  --- path (1): persisted plan (sizable DEV work — the DEFAULT) ---
  // 1. POST the plan body to the monitor, capture the minted id:
  //    DOC_ID=$(curl -sf -X POST http://127.0.0.1:16145/api/clauded-docs \
  //      -H 'content-type: application/json' \
  //      --data "$(jq -n --arg b '<plan markdown body>' '{html_body:$b, doc_status:"progress"}')" \
  //      | jq -r '.id')
  // 2. reference the minted id in the workflow script (any placement — raw-scanned):
  log('plan-ref: clauded-docs/<DOC_ID>');

  --- path (2): genuinely simple, none of the sizable criteria hold ---
  log('[ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line>');
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

USER-REQUESTED LOCAL DESTINATION (escape hatch): when the USER explicitly requested this local destination — a NEW file OR an EDIT of an existing user file — stamp the workflow script with the canonical attestation form log('[DOC-ROUTE] user-requested-local: <path> — <1-line justification>'). The stamp is path/line-scoped: it clears ONLY the lines carrying the stamped path, and a bare stamp without a path clears nothing; the stamped path must be a CONCRETE file path including a dot-extension (a bare tilde, a bare slash, or an extensionless directory clears nothing). CAUTION: stamp ONLY when the user explicitly requested the local destination — stamping to silence this gate is a violation; the runtime Write hook (block-doc-routing-leak.sh) and Monitoring-phase verification remain in force; the token clears THIS STATIC GATE only.

HONEST LIMIT — this is a STRING HEURISTIC (the WEAKEST of the defense-in-depth layers), NOT the primary guard: the runtime PreToolUse(Write) hook (block-doc-routing-leak.sh) is the mechanical write-time backstop. A path-shape match cannot prove intent, and this scan fail-opens on any uncertainty (no doc-agent spawn / no hardcoded path shape / any monitor-POST signal present). Do NOT treat the absence of this block as proof the routing is correct.
EOF
  )"
  block_and_exit "${docroute_reason}" "block-docroute"
fi

# SIZE-ATTESTATION MISS (block-sizeest): a would-be-PASS DEV workflow under ENTRY_OK (the helper
# already cleared entry-miss via a plan-ref / [ENTRY-CLASS] token) that carries NO [SIZE-EST]
# delegation-size self-attestation token in the RAW source. DEV-gated + ENTRY_OK-gated + decoupled
# from the verify-stage verdict inside the helper (promoted only at a would-be PASS emit, so a
# verify-stage BLOCK keeps priority). Its OWN distinct remediation reason (mirrors the docroute
# dedicated block, NOT the shared verify-stage cause-split base reason), SAME exit-2 block channel;
# checked BEFORE the cause-split so BLOCK_SIZEEST never falls through to exit 0. The block_and_exit
# addendum is structurally inert here (block-sizeest fires only under ENTRY_OK, so entry_marker is
# never ENTRY_ADVISORY) — see the block_and_exit ADR-2 allowlist comment.
if [[ "${verdict}" == "BLOCK_SIZEEST" ]]; then
  sizeest_reason="$(
    cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED (size-attestation miss): this Workflow script spawns DEV agent(s) but carries NO [SIZE-EST] delegation-size self-attestation token. The orchestrator MUST record its own pre-spawn size estimate at EVERY DEV spawn so an oversized single delegation cannot slip past the split discipline (a truncation-then-no-[COMPLETION] failure). Add the token (canonical home: a top-of-script log() string or meta.description):

  log('[SIZE-EST] bundles=N tool_uses~=N — <1-line reason>');

where bundles = count of {implement, write-tests, run-full-suite, report-consolidation} categories packed into THIS delegation, and tool_uses~=N = your rough pre-spawn tool_use estimate. HONESTY (orchestrator-role.md Spawn Budget): under-estimating is the DANGEROUS error (it masks an oversized delegation past the split discipline) — on a borderline count, round UP and prefer the split-leaning call. Placement is not enforced (the token is raw-scanned), so a commented token also satisfies this gate. Existence-only contract: only presence is recorded; the estimate CORRECTNESS is never checked (same boundary as [ENTRY-CLASS]).
EOF
  )"
  block_and_exit "${sizeest_reason}" "block-sizeest"
fi

# Cause-split dispatch — map each verify-stage cause token → its trace tag + ONE PREPENDED cause
# line (the shared base reason below is NEVER rewritten; downstream asserts key on it). Case
# default = strict enumerated fail-open: any verdict outside the enumerated BLOCK_* tokens (PASS,
# unknown/future tokens) → emit_trace "pass" + exit 0. BLOCK_DOCROUTE never reaches here (handled
# above).
trace_tag=""
cause=""
case "${verdict}" in
  BLOCK_NOREV)
    trace_tag="block-norev"
    cause="no non-comment qa-code-reviewer token anywhere"
    ;;
  BLOCK_NOVERIFYDEV)
    trace_tag="block-noverifydev"
    cause="reviewer present but no dev-* verifier: none co-located (within ~2000 comment-stripped chars), none sharing a parallel() group with a reviewer, and no reviewer-stage to immediately-adjacent pipeline-stage pair — add the DEV verifier to the verify parallel(), OR place the dev spawn in the pipeline stage immediately adjacent to the reviewer stage (the canonical pipeline(items, reviewerStage, devStage) signature, computed agentType recognized there)"
    ;;
  BLOCK_ORDER)
    trace_tag="block-order"
    cause="a dev-* token textually precedes EVERY qa-code-reviewer (the min(rev_starts) < min(impl_dev_starts) ordering check fails), so the gate classifies it as an un-gated implementation dev-* — but the flagged token MAY be an earlier Discovery/Design analysis dev-*, NOT the implement stage. Two lawful fixes: (a) use a NON-DEV agent (glass-atrium-intel-researcher / glass-atrium-intel-planner / Explore) for the pre-verify Discovery/Design work so no dev-* precedes the reviewer; OR (b) front-load a genuine reviewer-first {qa-code-reviewer, DEV} Contract verify phase BEFORE any Discovery dev-* (a REAL {qa,dev} verify, not a lone reviewer placed only to satisfy ordering)"
    ;;
  *)
    emit_trace "pass" "${script_len}"
    exit 0
    ;;
esac

# VIOLATION (clear case): DEV-implementation spawn present AND the {qa-code-reviewer, DEV} verify
# team is incomplete — the cause token above names which omission. All are missing-verify-stage
# omissions sharing this base reason.
reason="$(
  cat <<'EOF'
[enforce-workflow-verify-stage] BLOCKED: this Workflow script spawns DEV-implementation agent(s) (agentType dev-*) but is missing its mandatory {qa-code-reviewer, DEV} verify-stage — either NO qa-code-reviewer verify-spawn precedes the first DEV implementation, OR a qa-code-reviewer is present but has NO co-located dev-* verifier (the DEV hard-gate half of the verify team is absent). A complex-plan workflow MUST encode a {qa-code-reviewer, DEV} Plan Direction Verification stage BEFORE the first DEV implementation stage, with implementation gated on the combined pass+feasible verdict (orchestrator-role.md Stage-2 gate; skills/glass-atrium-ops-orchestrator.md "In-script verify-stage" skeleton). Note: this is a presence/co-location HEURISTIC, not DEV-verdict enforcement.

How to fix — insert a verify stage ahead of the DEV implementation agent(), e.g.:

  pipeline(
    agent('glass-atrium-intel-planner', { goal: 'author plan' }),
    parallel(
      agent('glass-atrium-qa-code-reviewer', { goal: 'judge implementation/test-feasibility -> pass|revise' }),
      agent('glass-atrium-dev-nestjs',       { goal: 'judge technical validity/approach -> feasible|infeasible' }),
    ),
    agent('glass-atrium-dev-nestjs', { goal: 'implement per verified plan' }),  // gated on pass+feasible
  )

If this is a SIMPLE workflow (typo/import/config — no real implementation), the gate is exempt; this static heuristic fires only on a DEV-spawn-without-any-qa-code-reviewer script. Add a qa-code-reviewer verify-stage and retry.
EOF
)"

block_and_exit "[enforce-workflow-verify-stage] CAUSE (${trace_tag}): ${cause}"$'\n'"${reason}" "${trace_tag}"
