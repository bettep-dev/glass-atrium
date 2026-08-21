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
# THIRD ADVISORY PASS (schema-cap, PRESENCE-ONLY, advisory — NEVER exit 2): flags the StructuredOutput
# schema cap shapes that drive the engine's "retry cap (5) exceeded" collapse loop. Three scoped rules
# over a comment-stripped + string-masked operand (the mask computed over the ALREADY-stripped text, so
# a cap inside a comment stays inert): (R1) maxLength on a completion-block field, (R2) maxLength /
# maxItems inside an `items` object literal, (R3) maxLength strictly between 64 and 300. The per-rule
# one-edit remediations, the published non-flag list, and the honest scan limits ship IN the message
# (print_schema_cap_advisory). VERDICT ISOLATION: the scan is its own top-level python function with
# its own internal except -> False, so a scan failure can never reach the module-level handler (which
# emits PASS) and silently convert a real BLOCK into a fail-open pass.
#
# FOURTH ADVISORY PASS (scope declaration, PRESENCE-ONLY, advisory — NEVER exit 2): flags a DEV
# workflow carrying no [SCOPE] declaration. Decided in bash off the raw script (the helper's fixed
# output-line contract is untouched) and emitted on the PASS arm only, so it can mask no verdict.
# Advisory-first is a ceiling, not a stage: a raw scan cannot separate a declaration from a mention of
# one, so promotion needs accumulated false-positive data plus an explicit user decision.
#
# FIFTH ADVISORY PASS (completion channel, advisory — NEVER exit 2): flags a script declaring a
# schema-mode spawn while the reserved completion-channel property is absent from that script.
# WHY → a schema-mode StructuredOutput emit is engine-guaranteed while the text channel is
# honor-system, and measured non-emission on the text channel runs 16-25% depending on the window
# (population = outcome rows attributed to the direct hook input or to one of the two synthesis arms;
# non-emission = the two synthesis arms). A schema omitting the reserved property therefore drops the
# writer signal SILENTLY → the recorder falls to derived synthesis and no lesson is recorded.
# MEASUREMENT SoT for that range — rules/glass-atrium/orchestrator-role.md → "Completion-channel
# non-emission": it carries the dated measurement, the re-derivation recipe, and the population stated
# as attribution-token membership rather than the prose form above. This block QUOTES the range; the
# two shipped advisory messages below quote it too. Re-derive and change it there, then propagate.
# PREDICATE (completion_block_advisory_needed, verdict-isolated with its own except -> False):
#   site half  → comment-stripped + string-MASKED operand, bare-word match, key-position ABSENT value
#                EXCLUDED (undefined / null / void <any operand>), scanned SCRIPT-WIDE.
#   token half → the UNMASKED comment-stripped text.
#   Opposite operands on purpose: site detection is block-ENABLING (over-detection would false-block →
#   precision), token detection is block-SUPPRESSING (over-detection merely fails open → recall).
#   Script-wide rather than span-scoped: the mandated idiom routes schema-mode spawns through the
#   resilience wrapper, so a span-scoped scan would see only the text-mode fallback line.
# PRECEDENCE SPLIT (the chosen position, split on the DEV predicate — no single position serves both):
#   non-DEV → decided immediately BEFORE the non-DEV early PASS, the only position reaching the
#             non-DEV analysis fan-outs (docroute still pre-empts it).
#   DEV     → folded into the TERMINAL emit, so every attestation gate keeps precedence and no
#             message-asserting fixture moves. Consequence, stated rather than implied: a DEV script
#             blocked earlier carries NO completion-channel tag — the block is the louder signal.
# ADDENDUM-ALLOWLIST MEMBERSHIP (decided here, not deferred): EXCLUDED. This is an advisory VALUE on
# the multiplexed flag line and never reaches block_and_exit's tag argument, so an entry would be
# inert; a promotion to a block cause decides membership at that time.
# KNOWN FALSE POSITIVES — the FULL measured list, not a sample, because this text is what a promotion
# decision reads (each remediable by declaring the property inline): a schema bound in ANOTHER module
# (invisible to the scan → site visible, token absent); ANY member read or write of the property
# (opts.schema); an assignment binding the bare word to undefined or null (the exclusion is key-position
# only); an import, a destructuring bind, or a parameter named schema; and the bare word inside a REGEX
# LITERAL. Every one was measured against its candidate exclusion before being left in: the member form
# is the one case where excluding it would blank a REAL site, the bind forms are cases where excluding
# them is inert because the bind's USE is itself a site, and the regex-literal form is a lexical-class
# problem whose fix belongs in the shared _string_mask. Per-shape verdicts sit at the predicate.
# KNOWN FALSE NEGATIVE: a QUOTED schema key, blanked by the mask — fail-open, the safe direction.
# WHERE THE CLAIM STOPS: this raises the floor from "channel structurally ABSENT" to "channel
# structurally PRESENT" and no further. It does NOT reach whether the prompt instructs the fill
# (unfilled → empty string → the same lost signal) or whether a filled block parses. A schema dropped
# ENTIRELY yields no site at all, so it is out of THIS value's reach and stays out of BLOCKING reach
# for good — forcing schema everywhere would trade the non-emit failure class for the crash-on-non-emit
# class — and is carried, as a nudge only, by the schema-absent value below. A second bare site behind a
# compliant one is likewise out of THIS value's reach — one declaration satisfies its token half for the
# whole file — and is carried by the per-site value below. Above that floor everything stays honor-system.
#
# PER-SITE GAP (the SECOND value on the same multiplexed line, advisory — NEVER exit 2, no promotion
# staging of its own): flags the property declared on ONE schema-mode site and omitted from ANOTHER, the
# shape no script-wide read can see. PREDICATE (completion_per_site_advisory_needed, verdict-isolated,
# own except -> False): the same opposite-polarity operands, applied INSIDE a site span, not across the
# file. ADJUDICABLE SITES ONLY — a site counts only when its own schema is an INLINE OBJECT LITERAL; a
# constant, builder call, spread or shorthand is SKIPPED rather than judged, so firing needs BOTH halves
# in-file and a file of only those shapes stays silent (false NEGATIVE, the safe direction). DISJOINT by
# construction (token absent script-wide vs present on some site); residuals sit at the predicate.
#
# SCHEMA ABSENT (the THIRD value on the same multiplexed line, advisory — NEVER exit 2, and no promotion
# staging is even available to it): flags an analysis-class NON-DEV spawn in a script carrying NO
# schema-mode site anywhere. This is THE MEASURED INCIDENT SHAPE — the recorded outage was a schema
# DROPPED from the spawn call — and it is the one shape neither sibling value can reach, since both
# require a site to exist. PREDICATE (completion_schema_absent_advisory_needed, verdict-isolated, own
# except -> False): non-DEV script AND no site (the SHARED site test, _has_schema_site, so the value that
# fires on a site and the value that fires on none can never disagree about what a site is) AND a spawn
# literal on the roster the analysis-size advisory already uses (non-DEV BY EXCLUSION from the runtime
# dev_set, via the shared _non_dev_analysis_spawn_present — never a second roster). DISJOINT from both
# siblings by the site half alone, so the single-value contract stays structural.
# ACCEPTED OVER-NUDGE, not a defect to be tuned away: an analysis spawn whose deliverable is GENUINELY
# prose has no schema to declare and nudges anyway. Whether a deliverable is structured is not statically
# decidable, so a suppression heuristic here could only re-introduce the false-NEGATIVE direction this
# value exists to cover; blocking this shape is a stated NON-GOAL, and one ignorable stderr line is the
# whole cost. DEV scripts are excluded for a measured reason, not for symmetry with the sibling: a
# canonical DEV workflow carries a reviewer verify-stage that is deliberately text-mode, so including
# them would fire on nearly every copy-verbatim skeleton.
#
# SIXTH ADVISORY PASS ([SIZE-EST] plausibility bounds, advisory — NEVER exit 2): bounds the DECLARED
# DEV-mode tool_uses~ value against the implementation-slot count the gate already computes — below
# slots x 4.5 (the empirical per-file calibration) fires `:low`, above ~40 (the split trigger ahead of
# the measured 46-52 truncation band) fires `:high`. Both anchors are DERIVED from orchestrator-role.md
# -> Spawn Budget, not counts maintained here. Fires ONLY where a DEV-mode token exists: the
# token-absent case is the BLOCK_SIZEEST gate's, and advising it too would double-advise one miss.
# The value rides its OWN output line rather than the completion-channel multiplex — that line's trace
# tag names the completion channel, and the two decisions can co-occur on one invocation.
#
# SEVENTH ADVISORY PASS (first-link question on a REVISION cycle, advisory — NEVER exit 2): flags a DEV
# workflow that EXECUTES a revised plan while its text carries no first-link question. Decided in bash
# off the raw script plus a LIVE monitor read, on the PASS arm only (siting rationale at the emitter).
# PREDICATE, four conjuncts in cost order so the compliant case pays nothing:
#   (1) a DEV workflow (dev=yes) — the question is the Stage-2 DEV participant's verdict-gating job;
#   (2) FIRST_LINK_LITERAL absent from the RAW script — raw, not comment-stripped, because the literal's
#       one legitimate home is a verify-stage GOAL STRING (attestation-token weighting, not spawn-token);
#   (3) a plan-ref clauded-docs/<N> id present in the raw script — the same id shape the upstream verify
#       clause parses, re-read in bash so the helper's fixed output-line contract stays untouched;
#   (4) get_supersede_chain resolves that id to a chain of DEPTH >= 1 — the revision test, derived by
#       WALKING the live chain at evaluation time (GET .supersedes_id per hop up to a root), never from a
#       stored cycle counter and never from anything the script itself asserts.
# FAIL-OPEN ON EVERY UNCERTAINTY (an advisory that fires on infrastructure trouble is the inversion this
# codebase forbids): curl or jq absent · unresolvable monitor port · GET failure or monitor down · a
# non-integer or absent id · a chain still unterminated at the GET cap (too deep, or a supersedes_id
# cycle) — each yields NO nudge. Silence therefore means "not established as a revision", never "checked
# and clean". A depth-0 chain (an original plan) is a real negative, not a fail-open.
# COST: zero GETs unless all three cheap conjuncts hold; then at most WORKFLOW_GATE_CHAIN_MAX_HOPS
# loopback GETs at WORKFLOW_GATE_CURL_TIMEOUT each. A down monitor refuses instantly; only a HUNG
# monitor pays the timeout, which is why the per-hop budget is 1s rather than the sibling hook's 2s.
# WHERE THE CLAIM STOPS: presence of the QUESTION in the delegation text, and nothing beyond it. Whether
# the DEV answers it, and whether the answer is honest, is unreachable here — an honest DOWNGRADE from
# the withdrawn schema-required-key shape (a required key would have forced an ANSWER into the emitted
# payload; the canonical verify stage declares no schema, so no required array exists to attach one to).
# The literal is quoted from ONE canonical home — scoped/scope-dev.md -> "Plan Direction Verification
# Gate [DEV+QA]", first-link question — and the advisory MESSAGE interpolates that same constant rather
# than restating it, so no second maintained copy exists in this file. A paraphrase in either place
# disables the scan silently, which is why the canonical fixes the sentence as a quotable literal.
# KNOWN FALSE NEGATIVES, stated rather than tuned away: a workflow carrying no plan-ref (the entry gate's
# concern, not this one); a plan persisted as a fresh document instead of a supersede-POST (no chain, so
# no revision is observable — the honor-system persist-path residual recorded in the rule text); and a
# paraphrased question. KNOWN FALSE POSITIVE: the literal quoted in a script that is NOT the delegation
# text silences it, the same string-residency ceiling every attestation token carries.
# PROMOTION: advisory-first is a ceiling here, not a staging step. A raw scan cannot separate a
# delegation's goal text from a mention of one, and the decision additionally rests on a live network
# read, so promotion to exit 2 would let a monitor outage block correct work. It waits on accumulated
# false-positive data plus an explicit user decision.
#
# MULTIPLEXED ADVISORY LINE (the helper's TENTH output line, COMPLETION_FLAG): the completion-channel
# decisions share ONE flag line carrying a value suffix (COMPLETION_ADVISE:<value>), so the output-arity
# seam is paid ONCE and each further decision adds a value plus a message case arm, never a line — the
# per-site and schema-absent values each cost exactly that and no seam edit, as designed. Values today:
# `property-absent`, `per-site-gap` and `schema-absent`. The shell-side normalizer admits the suffix by SHAPE, never by
# enumerating today's values: a value falling through an enumeration would collapse to SILENT, so its
# advisory would stop printing AND stop being traced with no error anywhere — the identical trap
# recorded for the schema-cap `:R<n>` suffix.
#
# PROMOTION CONDITION (verbatim — this header is the referenced SoT; the authoring guidance points here
# rather than restating it):
#   Promotion of the schema-cap advisory to blocking requires, verbatim: zero adjudicated false
#   positives across a full rolling firing-log window, the copy-verbatim skeletons in
#   skills/glass-atrium-ops-orchestrator.md passing the check unmodified, and a named one-edit
#   remediation in the advisory text for each of the three scoped rules.
#   Promotion of the completion-channel advisory to blocking requires, verbatim: zero adjudicated false
#   positives across a full rolling firing-log window; every copy-verbatim declaration-bearing skeleton
#   in skills/glass-atrium-ops-orchestrator.md passing unmodified; and the remediation round-trip green
#   with a paired negative control.
#
# ROLLBACK LEVER (the operator-reversible counterpart of the promotion condition above): while a MARKER
# FILE exists at WORKFLOW_GATE_COMPLETION_ROLLBACK_MARKER, the completion-channel property-absent value
# is DEMOTED — its message is not printed. Stage A carries no blocking verdict for this cause, so today
# the lever silences one message and moves nothing else; the obligation it places on the promoting
# commit is that a Stage-B blocking verdict route through this same marker read before it can exit 2.
# A FILE rather than an environment variable because the hook is a fresh process per tool call yet
# inherits the session's SNAPSHOTTED environment, so only a per-invocation file read is reversible
# mid-session; the path takes its own env override mirroring the trace-log variable, so a suite never
# reads live-install state. The data dir is writable and outside harness protection scope, so the lever
# needs no approval.
# DEMOTION SCOPE, pinned rather than left to the reader: the PROPERTY-ABSENT cause ONLY. The per-site-gap
# and schema-absent values, the schema-cap advisory and the [SIZE-EST]-bounds pass are UNCHANGED by the
# marker — demoting the whole multiplexed line would silence the schema-absent nudge, which is the only
# signal on the measured incident shape. And the TRACE is never demoted: the tag is accumulated PAST the
# message dispatch, so a rollback period keeps recording its firings and the promotion window stays
# adjudicable instead of going vacuously quiet.
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
# ACTIVATION (binding live): the harness fires PreToolUse(Workflow) with tool_input.script exposed —
# the rolling firing log below (cap 1000 lines) shows the gate firing AND blocking in production
# (observed 2026-07: ~130 exit-2 blocks among 1000 recorded firings; counts roll with the log).
# Honest residual: pass-noscript rows — Workflow envelopes arriving WITHOUT .tool_input.script pass
# uninspected (fail-open); no full-coverage claim. Measured 53 of 1000 recorded firings (~5.3%) as of
# 2026-07-21. The figure is a ROLLING-BUFFER reading, not a lifetime rate: the log caps at 1000 lines,
# so it ages out and this count drifts — re-derive rather than trust the date, via
# `grep -c pass-noscript ~/.glass-atrium/data/workflow-gate-fired.log`.
#
# FIRING INSTRUMENTATION (passive probe): on EVERY invocation reaching the Workflow decision point, a
# one-line trace is appended to ${HOME}/.glass-atrium/data/workflow-gate-fired.log (timestamp · tool_name ·
# verdict · script-length · advisory · dev · impl_slots). Trace verdict tags: pass · pass-noscript · block-nodecl · block-grammar ·
# block-norev · block-noverifydev · block-declspawn · block-undecl · block-computed · block-order ·
# block-upstream · block-docroute · block-entry · block-sizeest; python3-absent / helper-error
# fallbacks emit bare "pass". How to check: `cat ~/.glass-atrium/data/workflow-gate-fired.log`. The trace is
# fail-SAFE (a logging error NEVER changes the verdict/exit code — the verdict is decided first).
#
# ADVISORY FIELD (presence-only, positioned after the original four fields — append-only, backward
# compatible): `advisory=` records WHICH advisories
# fired on that invocation and, for the two suffixed advisories, WHICH value matched — the schema-cap
# rule (`advisory=schema-cap:R1`) and the multiplexed completion-channel value
# (`advisory=completion-channel:property-absent`, `:per-site-gap` or `:schema-absent`);
# the revision-cycle nudge records as `advisory=first-link`, unsuffixed (it carries one decision);
# several tags join with a comma; none fired →
# `advisory=none`. This exists so
# the promotion condition's first clause (zero adjudicated false positives across a rolling firing-log
# window) is MEASURABLE at all — before it, the record carried no advisory signal of any kind and no
# window could be constructed. It records only that a firing happened, NEVER whether it was correct:
# adjudication stays human, and this field neither promotes the advisory nor touches a verdict or exit
# code. The field is APPENDED after those four so a reader keyed on the existing positions is unaffected
# (hooks/compliance_telemetry.py parse_gate_log splits on TAB and reads `verdict=` by key).
#
# MEASUREMENT FIELDS (`dev=`, `impl_slots=`, appended AFTER `advisory=` — same append-only contract):
# `dev=yes|no` records whether any Tier-A dev literal was present, so a firing-log denominator can
# exclude the non-DEV scripts that return PASS before any attestation machinery runs — without it the
# recorded rate is computed over a population a third of which never touches the surface being rated.
# `impl_slots=N` records the implementation-slot count defined at impl_slot_count(): a total function
# over BOTH terminal PASS branches, counting static spawn positions of declared literal impl types
# (minus the greedy-earliest verify slot per verify-dev type) plus one slot per declared computed
# type, and floored at one wherever a static dev spawn exists so the verify-team-only shape stops
# reporting zero on a script that demonstrably spawns a DEV agent. Neither field reaches a verdict or
# an exit code; the slot count additionally feeds the ADVISORY [SIZE-EST] lower bound (see
# sizeest_bounds()), which is why its zero reading was worth repairing rather than tolerating.
# Two cardinality advisory tags ride the existing `advisory=` field and likewise decide nothing:
# `size-map` (the [SIZE-EST] occurrence count differs from the slot count, either direction) and
# `entry-cardinality` (an [ENTRY-CLASS] simple-task classification alongside 4+ implementation slots).
# HONESTY: only the COUNT is mechanical. Which sizing entry corresponds to which call site is
# author-assigned and unverifiable — the same honor-system trust class as declaration role
# truthfulness above — and the count is blind to a loop fan-out, which spawns N runtime instances from
# ONE static position and so reads as one slot. That residual is unrepaired and stated at the counter.
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
WORKFLOW_GATE_FIRED_LOG="${WORKFLOW_GATE_FIRED_LOG:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/workflow-gate-fired.log}"

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

# Rollback-marker path for the completion-channel PROPERTY-ABSENT value (header → ROLLBACK LEVER, which
# is the scope SoT: this value only, and never the trace). Same override shape as the trace-log variable
# above, so a suite points it at a temp path and never reads live-install state. The file is READ per
# invocation (the hook is a fresh process per tool call) and never written here, so touching or removing
# it takes effect on the next Workflow call with no session restart.
WORKFLOW_GATE_COMPLETION_ROLLBACK_MARKER="${WORKFLOW_GATE_COMPLETION_ROLLBACK_MARKER:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/workflow-gate-completion-rollback}"

# --- first-link advisory: the question literal + the live-chain read's knobs ------------------------
# The first-link question, quoted BYTE-EXACT from its ONE canonical home — scoped/scope-dev.md ->
# "## Plan Direction Verification Gate [DEV+QA]", the backticked sentence under "First-link question".
# Cross-read against that line rather than edited here: the canonical fixes it as a quotable literal
# precisely so this scan and the verify-stage skeleton can match it, and a paraphrase on either side
# disables the mechanical half with no visible failure. The advisory message interpolates THIS constant,
# so the file holds exactly one copy.
readonly FIRST_LINK_LITERAL='name the earliest decision in the chain, state how many current tasks survive its replacement, give the cheaper replacement if one exists'

# Monitor-read knobs for the chain walk, mirroring validate-scope-drift.sh's precedent: a full-URL
# override wins outright (test isolation), otherwise the loopback default derives from the shared port
# wrapper — NO literal port here, the single default lives in the resolver. The per-hop budget is 1s
# because only a HUNG monitor pays it (a down one refuses instantly) and the cap multiplies it.
WORKFLOW_GATE_CURL_TIMEOUT="${WORKFLOW_GATE_CURL_TIMEOUT:-1}"
# Maximum monitor GETs per walk — bounds latency AND terminates a supersedes_id cycle in malformed data.
WORKFLOW_GATE_CHAIN_MAX_HOPS="${WORKFLOW_GATE_CHAIN_MAX_HOPS:-8}"
# Non-integer / zero overrides fall back to the defaults (a bad knob must not disable the bound).
[[ "${WORKFLOW_GATE_CURL_TIMEOUT}" =~ ^[1-9][0-9]*$ ]] || WORKFLOW_GATE_CURL_TIMEOUT=1
[[ "${WORKFLOW_GATE_CHAIN_MAX_HOPS}" =~ ^[1-9][0-9]*$ ]] || WORKFLOW_GATE_CHAIN_MAX_HOPS=8

# advisory_trace — parent-scope accumulator of the advisory tags fired on this invocation, read by
# emit_trace for the trailing `advisory=` field. Every advisory emitter runs BEFORE the pass-path trace
# emit and before block_and_exit, so a tag set here is always visible inside emit_trace's subshell and
# nothing needs to escape it. Empty (no advisory fired, or a path that never reaches the advisory
# printers such as pass-noscript) records as `none`.
advisory_trace=""

# dev_flag / impl_slots — the two instrumentation-only trace fields appended after `advisory=`. Both
# carry a safe default so every pre-helper exit path (pass-noscript, python3 absent, helper crash)
# still emits a well-formed line. They decide NOTHING: no verdict, no exit code, no advisory text
# reads them — the DEV flag exists so the firing log's denominator can exclude non-DEV scripts (which
# never reach the attestation surface), and the slot count is the measured quantity a later decision
# is meant to rest on.
dev_flag="no"
impl_slots=0

# add_advisory TAG — append one advisory tag to the accumulator. Never fails (the trace must never be
# able to alter a verdict).
add_advisory() {
  advisory_trace="${advisory_trace:+${advisory_trace},}${1}"
  return 0
}

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
    printf '%s\ttool_name=%s\tverdict=%s\tscript_len=%s\tadvisory=%s\tdev=%s\timpl_slots=%s\n' \
      "${ts}" "Workflow" "${verdict}" "${script_len}" "${advisory_trace:-none}" \
      "${dev_flag:-no}" "${impl_slots:-0}" \
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

# print_schema_cap_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit code). The
# DECISION fires INSIDE the python3 verdict helper (get_schema_cap_rule) and arrives as a
# SCHEMA_CAP_ADVISE[:R<n>] / SCHEMA_CAP_SILENT flag on its FIFTH output line. The `:R<n>` suffix is
# TRACE instrumentation only (it names the matched rule for the per-rule promotion window); the message
# itself stays PRESENCE-ONLY, enumerating all three rules and their one-edit fixes rather than naming
# the matched rule or field — deliberate, and stated in the text so silence on a detail is not
# read as a clean bill. Shipping the per-rule remediations + the published non-flag list from day one
# is required by the promotion condition in the header (building them at promotion time would block
# promotion on a message rewrite).
print_schema_cap_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY (schema-cap, non-blocking): this workflow declares a StructuredOutput schema cap matching at least one of three scoped rules. An over-tight cap is the dominant 'StructuredOutput schema retry cap (5) exceeded' cause — told only to emit, the model SHRINKS its prose on each internal retry instead of fixing the shape, so the loop never converges. PRESENCE-ONLY: this nudge does NOT name which rule or field matched, and it NEVER judges whether a cap fits its realistic content. The three rules, each with its ONE-EDIT fix: (R1) a maxLength on a completion-block field — DROP the cap entirely (measured real blocks run 285/284/1224 chars against caps of 600/900/1200, and the standing rule mandates the FULL multi-line block, so schema compliance and rule compliance are mutually exclusive under ANY such cap). (R2) a maxLength/maxItems inside an items object — remove the per-element caps and keep a single top-level item-count cap (per-element caps MULTIPLY the constraint count, so shrinking one element re-balances and overflows another). (R3) a maxLength strictly between 64 and 300 — raise the cap to the realistic worst case, or hand the bulk to a FILE and return a path plus a compact summary. DELIBERATE NON-FLAGS (published so silence is not mistaken for a clean bill): maxLength >= 300 on a non-completion non-item field; maxLength <= 64 (enum / verdict / identifier shapes); maxItems on a TOP-LEVEL array (one non-multiplying constraint on inherently multi-item content); the observed 500-char cap on a top-level free-text field; caps of EXACTLY 300 (excluded by R3's strict upper edge, a consistency choice against the guidance's own per-row floor — the largest accepted miss); and any cap notation carrying no numeric literal (a quoted shorthand type descriptor or a chained-builder form). HONEST LIMITS: raw-text scan over a comment-stripped + string-masked operand, no JS parse — a schema assembled by a helper / spread / variable / import, a variable-valued cap, and a fully-quoted JSON-style schema (where the cap TOKEN itself is string-resident) are all invisible; the items span is a brace-scan heuristic. ADVISORY ONLY, this check NEVER blocks — promotion condition recorded verbatim in this hook's header." >&2
  return 0
}

# print_scope_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit code). Decided in
# bash off the raw script text rather than in the verdict helper, so the helper's fixed output-line
# contract is untouched. Advisory-first is deliberate and not a staging step: a raw scan cannot tell a
# declaration from a mention of one, so promotion to exit 2 waits on false-positive data plus an
# explicit user decision.
# print_sizeest_low_advisory / print_sizeest_high_advisory — ADVISORY-ONLY (stderr, NEVER blocks /
# NEVER alters the exit code). The DECISION fires inside the verdict helper (sizeest_bounds) and
# arrives as a value on the eleventh output line; these only render it. Both bounds are DERIVED from
# orchestrator-role.md -> Spawn Budget (the `ceil(files x 4.5)` empirical tool_use calibration and the
# ~40 split trigger ahead of the measured 46-52 truncation band), never a count maintained here.
print_sizeest_low_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY ([SIZE-EST] plausibility, non-blocking): the declared tool_uses~ value is BELOW the slot-count floor (implementation slots x 4.5, the empirical per-file tool_use calibration in orchestrator-role.md -> Spawn Budget). Under-declaring is the DANGEROUS direction: it smuggles an oversized delegation past the split discipline, and the sub-agent then truncates mid-work with no [COMPLETION]. Re-estimate UP against the files x 4.5 floor and, if the honest estimate exceeds ~30, SPLIT the delegation instead of re-declaring it smaller. PLAUSIBILITY-ONLY, never estimate correctness — parity with the presence-only [SIZE-EST] gate. ADVISORY ONLY, this check NEVER blocks." >&2
}

print_sizeest_high_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY ([SIZE-EST] plausibility, non-blocking): the declared tool_uses~ value EXCEEDS the ~40 delegation ceiling (the HARD SECONDARY split trigger in orchestrator-role.md -> Spawn Budget, set ahead of the measured 46-52 truncation band). A delegation this size is expected to run out of budget before its terminal emit: SPLIT it into sequential checkpointed sub-delegations, keeping each implementation together with its NEW tests and peeling off run-full-suite / report-consolidation instead. PLAUSIBILITY-ONLY, never estimate correctness. ADVISORY ONLY, this check NEVER blocks." >&2
}

print_scope_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY (scope declaration, non-blocking): this workflow spawns DEV agent(s) but carries NO [SCOPE] declaration. Fix the delegation's literal scope in text before the work starts, in the canonical middot-separated grammar: log('[SCOPE] files=path/one, path/two · deliverable=<type> · out=none') (grammar SoT: orchestrator-role.md → Context Handoff Size). Declare the paths that travel WITH the implementation too — its companion tests and any mandatory co-deliverable — so a compliant edit is not read as excess later. PRESENCE-ONLY, parity with [ENTRY-CLASS] / [SIZE-EST]: whether the declaration matches the user's instruction is never checked here. ADVISORY ONLY, this check NEVER blocks." >&2
  return 0
}

# get_monitor_docs_url — the clauded-docs collection URL for the chain walk, or rc 1 when no URL can be
# resolved (which fails the walk open). A full WORKFLOW_GATE_MONITOR_URL override wins outright so a
# suite never touches live-install state; otherwise the port comes from the shared hook wrapper, sourced
# LAZILY here so a non-DEV or already-compliant workflow never loads the lib at all.
get_monitor_docs_url() {
  if [[ -n "${WORKFLOW_GATE_MONITOR_URL:-}" ]]; then
    printf '%s' "${WORKFLOW_GATE_MONITOR_URL}"
    return 0
  fi
  local lib port
  lib="${BASH_SOURCE%/*}/lib/hook-utils.sh"
  [[ -r "${lib}" ]] || return 1
  # shellcheck source=lib/hook-utils.sh
  source "${lib}" || return 1
  # shellcheck disable=SC2310
  #   As above — a resolver miss degrades to an empty port, which the integer test below rejects.
  port="$(hook_monitor_port 2>/dev/null || true)"
  [[ "${port}" =~ ^[0-9]+$ ]] || return 1
  printf 'http://127.0.0.1:%s/api/clauded-docs' "${port}"
}

# get_supersede_chain ID — walk the LIVE supersede chain upward from ID and derive its revision depth
# AT EVALUATION TIME. Each hop GETs the doc and follows .supersedes_id; the walk ends at the root (the
# first doc with no predecessor). Sets CHAIN_DEPTH (hops taken; 0 = an original plan) and CHAIN_ROOT_ID,
# then returns 0. Returns 1 — no measurement, caller nudges nothing — on every uncertainty: curl or jq
# absent, no resolvable URL, a failed or empty GET, a non-integer predecessor id, or a chain still
# unterminated at the GET cap (too deep to price, or a supersedes_id cycle in the data; the cap is what
# terminates the latter). Deliberately NOT cached: a per-session cache would answer from the state at
# first read, and the revision this predicate exists to see is created mid-session.
get_supersede_chain() {
  local id="${1}" base json next gets=0
  CHAIN_DEPTH=0
  CHAIN_ROOT_ID=""
  [[ "${id}" =~ ^[0-9]+$ ]] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1
  # shellcheck disable=SC2310
  #   Predicate call — an unresolvable URL is this walk's fail-open answer, not an error to propagate.
  base="$(get_monitor_docs_url)" || return 1
  [[ -n "${base}" ]] || return 1

  while ((gets < WORKFLOW_GATE_CHAIN_MAX_HOPS)); do
    gets=$((gets + 1))
    json="$(curl -sf --max-time "${WORKFLOW_GATE_CURL_TIMEOUT}" "${base}/${id}" 2>/dev/null || true)"
    [[ -n "${json}" ]] || return 1
    # `// empty` collapses BOTH a null and an absent key to the root signal — a root doc reports either.
    next="$(printf '%s' "${json}" | jq -r '.supersedes_id // empty' 2>/dev/null || true)"
    if [[ -z "${next}" ]]; then
      CHAIN_ROOT_ID="${id}"
      return 0
    fi
    [[ "${next}" =~ ^[0-9]+$ ]] || return 1
    id="${next}"
    CHAIN_DEPTH=$((CHAIN_DEPTH + 1))
  done
  return 1
}

# print_first_link_advisory DEPTH ROOT_ID — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit
# code). The literal is INTERPOLATED from FIRST_LINK_LITERAL, never retyped, so the remediation a reader
# copies is the same bytes the scan looks for.
print_first_link_advisory() {
  printf '%s\n' "[enforce-workflow-verify-stage] ADVISORY (first-link question, non-blocking): this DEV workflow executes a REVISED plan (live supersede chain depth ${1}, chain root clauded-docs/${2}) but its text carries NO first-link question. Each link of a chained plan is justified against the state its predecessor established, so a per-link check passes at every step while the chain as a whole leaves what was asked; the earliest decision is the only one whose replacement re-prices everything built on it, and it is the one nobody re-opens. ONE-EDIT FIX — quote this sentence VERBATIM into the {glass-atrium-qa-code-reviewer, DEV} verify stage's goal text (a paraphrase silences this scan with no visible failure): ${FIRST_LINK_LITERAL}. Canonical duty text + the three-part answer shape: scoped/scope-dev.md -> 'Plan Direction Verification Gate [DEV+QA]', first-link question; copy-verbatim skeleton: skills/glass-atrium-ops-orchestrator.md -> 'Pipeline Acceptance Criteria'. HONEST CEILING: presence of the QUESTION only — the canonical verify stage is text-mode and declares no schema, so nothing can force an ANSWER into a payload, and whether the DEV answers is honor-system (a stated DOWNGRADE from the withdrawn schema-required-key shape, not a swap of equals). The revision test is a LIVE chain read: monitor down, curl absent, no plan-ref or a chain too deep to walk all yield SILENCE, so no nudge never means checked-and-clean. ADVISORY ONLY, this check NEVER blocks." >&2
  return 0
}

# print_completion_channel_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit
# code). The DECISION fires inside the verdict helper (completion_block_advisory_needed) and arrives as
# the COMPLETION_ADVISE:property-absent value on the multiplexed TENTH output line.
# Authored as a SINGLE-QUOTED heredoc → zero expansion: a workflow script is untrusted tool input, and
# this text is the one destined to become a block reason if the advisory is ever promoted.
# Message content is fixed by the promotion condition rather than by taste → the one-edit remediation,
# the published false-positive list and the honest scope boundary all ship from day one, because
# building them at promotion time would block promotion on a message rewrite.
print_completion_channel_advisory() {
  cat <<'EOF' >&2
[enforce-workflow-verify-stage] ADVISORY (completion channel, non-blocking): this workflow script carries a schema-mode site but never mentions the reserved completion-channel property, so a StructuredOutput payload has nowhere to carry the [COMPLETION] block. A schema-mode emit is engine-guaranteed while the text channel is honor-system — measured non-emission on the text channel runs 16-25% depending on the window (population = outcome rows attributed to the direct hook input or to one of the two synthesis arms; non-emission = the two synthesis arms) — so a schema omitting the property drops the writer signal SILENTLY: the recorder falls to derived synthesis and the run records no lesson. ONE-EDIT FIX — add this property to the schema you already declare:
  completion_block: { type: 'string', description: 'the FULL multi-line [COMPLETION] block: the tag alone on its line, each field on its own line, closed by [/COMPLETION] alone on its line' }
and instruct the agent in its delegation prompt to FILL it — that half is prompt-side and is NOT checked here (an unfilled property yields an empty string and the same lost signal). WHERE THIS CHECK STOPS: it raises the floor from "channel structurally absent" to "channel structurally present" and no further. It does not reach whether the block is filled, whether a filled block parses, a second bare site behind a compliant one, or a spawn passing no schema at all — that last shape is deliberately out of reach, because forcing schema everywhere would trade the non-emit failure class for the crash-on-non-emit class. WHAT COUNTS AS A SITE, stated exactly so this nudge is not read as narrower than it is: the BARE WORD schema anywhere in the comment-stripped, string-masked script — not only a spawn argument. A key-position ABSENT value is the only exclusion (schema: undefined, schema: null, schema: void <anything>); everything else that spells the bare word is a site. KNOWN FALSE POSITIVES, published in FULL so a firing is adjudicable rather than mysterious, each measured against its candidate exclusion rather than assumed: a schema bound in ANOTHER module is invisible to this raw scan (site visible, property absent); ANY member read or write of the property (opts.schema) is a site, and excluding it is the one case that would blank a REAL site, since opts.schema = S followed by agent(t, opts) is a genuine schema-mode configuration; an assignment binding the bare word to undefined or null is a site, because the exclusion covers the key position only; an import, a destructuring bind, or a parameter named schema is a site, and excluding those is inert — the bind gets USED at a spawn and that use is itself a site, so only a bind with no use would fall silent; the bare word inside a REGEX LITERAL is a site, a lexical-class limit of the shared string mask rather than a value one. A quoted schema key is the mirror false NEGATIVE (the string mask blanks it) and fails open by design. MEASUREMENT SoT for the 16-25% range quoted above: rules/glass-atrium/orchestrator-role.md, section "Completion-channel non-emission" — dated measurement, re-derivation recipe, and the population stated as attribution-token membership. This message quotes that range; re-derive it there rather than editing the figure here. ADVISORY ONLY, this check NEVER blocks — promotion condition recorded verbatim in this hook's header.
EOF
  return 0
}

# print_completion_per_site_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit
# code). The DECISION fires inside the verdict helper (completion_per_site_advisory_needed) and arrives
# as the COMPLETION_ADVISE:per-site-gap value on the SAME multiplexed TENTH output line — a value, not a
# line, which is what keeps the output-arity seam paid once.
# Authored as a SINGLE-QUOTED heredoc → zero expansion: a workflow script is untrusted tool input.
# NO promotion staging of its own: the header records a promotion condition for the property-absent
# value only, and this shape stays advisory.
print_completion_per_site_advisory() {
  cat <<'EOF' >&2
[enforce-workflow-verify-stage] ADVISORY (completion channel per-site, non-blocking): this workflow declares the reserved completion-channel property on one schema-mode site and omits it from another, so the script-wide check reads the file as compliant while a second StructuredOutput payload still has nowhere to carry the [COMPLETION] block. One compliant site MASKS the bare one: a single declaration satisfies the script-wide token half for the whole file, and the run behind the bare site records no lesson because the recorder falls to derived synthesis. ONE-EDIT FIX — add the same property to the schema on the site that omits it:
  completion_block: { type: 'string', description: 'the FULL multi-line [COMPLETION] block: the tag alone on its line, each field on its own line, closed by [/COMPLETION] alone on its line' }
and instruct that agent in its delegation prompt to FILL it — prompt-side, and NOT checked here. WHICH SITES THIS READS, stated exactly so silence is not mistaken for a clean bill: only a site whose schema is an INLINE OBJECT LITERAL, the one span in which presence and absence are both decidable from this file. A site whose schema is a named constant, a builder call, a spread or the object shorthand is SKIPPED rather than judged — its declaration lives elsewhere or nowhere, so calling it bare would report a gap this scan never saw. A file whose sites are all of that kind therefore stays silent: a false NEGATIVE, the safe direction, and the same polarity every residual in this pass takes. KNOWN FALSE POSITIVE: a site whose inline literal spreads a shared base carrying the property reads as bare, because the spread is a reference and the property is not inside the span — remediable by the same one-edit fix above. ADVISORY ONLY, this check NEVER blocks.
EOF
  return 0
}

# print_completion_schema_absent_advisory — ADVISORY-ONLY (stderr, NEVER blocks / NEVER alters the exit
# code). The DECISION fires inside the verdict helper (completion_schema_absent_advisory_needed) and
# arrives as the COMPLETION_ADVISE:schema-absent value on the SAME multiplexed TENTH output line.
# Authored as a SINGLE-QUOTED heredoc → zero expansion: a workflow script is untrusted tool input.
# NO promotion staging is available to this value at all, by design rather than by deferral: the shape
# is not statically separable from a legitimately prose deliverable, so a nudge is its ceiling.
print_completion_schema_absent_advisory() {
  cat <<'EOF' >&2
[enforce-workflow-verify-stage] ADVISORY (completion channel absent, non-blocking): this workflow spawns a NON-DEV analysis/research/audit agent (researcher/planner/reporter/reviewer — anything off the DEV roster) but declares NO schema-mode site ANYWHERE in the script, so there is no StructuredOutput payload to carry the [COMPLETION] block at all. THIS IS THE MEASURED INCIDENT SHAPE: the recorded outage was a schema DROPPED from the spawn call, and that shape leaves nothing for the two sibling completion-channel checks to see, since both require a site to exist. WHY IT MATTERS: a schema-mode emit is engine-guaranteed while the text channel is honor-system — measured non-emission on the text channel runs 16-25% depending on the window (population = outcome rows attributed to the direct hook input or to one of the two synthesis arms; non-emission = the two synthesis arms) — so a spawn with no schema at all drops the writer signal SILENTLY: the recorder falls to derived synthesis and the run records no lesson. ONE-EDIT FIX — give the spawn a bounded schema carrying the reserved property, and instruct the agent in its delegation prompt to FILL it (prompt-side, NOT checked here):
  schema: { type: 'object', properties: { findings: { type: 'string' }, completion_block: { type: 'string', description: 'the FULL multi-line [COMPLETION] block: the tag alone on its line, each field on its own line, closed by [/COMPLETION] alone on its line' } } }
KNOWN AND ACCEPTED OVER-NUDGE, published so it is not mistaken for a defect: an analysis spawn whose deliverable is GENUINELY prose has no schema to declare and fires this line anyway. Whether a deliverable is structured is not statically decidable, and forcing a schema onto every spawn would trade the non-emit failure class for the crash-on-non-emit class — so this shape is reachable by a nudge and nothing stronger, and blocking it is a stated NON-GOAL. If the deliverable really is prose, this line is noise: ignore it. WHAT SILENCES IT, stated exactly, all three: (a) any schema-mode site anywhere in the comment-stripped, string-masked script (a key-position ABSENT value — schema: undefined, schema: null, schema: void <anything> — is not a site); (b) any DEV agent literal in the script, because a DEV workflow carries a reviewer verify-stage that is deliberately text-mode and nudging it would fire on nearly every canonical skeleton; (c) a spawn whose agent name reaches the call through a WRAPPER instead of a spawn position — the roster half reads agent('<name>') and agentType: '<name>' only, so robustAgent('<name>', ...), the very shape the pre-flight guidance recommends for schema-mode spawns, is never seen and this line stays quiet on it. (c) is INHERITED rather than a property of this check: the roster half is the same shared predicate the analysis-size advisory reads, and that sibling is equally blind to the same shape, so widening it is a plan-level decision and not a defect in this line. Proportion, so the gap is neither hidden nor inflated: robustAgent exists to retry schema-mode NULLS, so the author writing the schema-ABSENT shape is the one least likely to be reaching for it. MEASUREMENT SoT for the 16-25% range quoted above: rules/glass-atrium/orchestrator-role.md, section "Completion-channel non-emission" — dated measurement, re-derivation recipe, and the population stated as attribution-token membership. This message quotes that range; re-derive it there rather than editing the figure here. ADVISORY ONLY, this check NEVER blocks.
EOF
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
#
# FOURTH SECTION (completion channel) — CONDITIONAL, and the intro says so: the schema scaffold applies
# to a schema-mode spawn only. A DEV verify stage returns a prose verdict and is deliberately text-mode
# (D7), so a copy-verbatim DEV skeleton declares no schema and owes this section nothing. Its declared
# property line is kept BYTE-EQUAL to the one-edit snippet the two completion-channel advisory messages
# already ship, so the taught scaffold and the shipped remediation cannot drift apart.
print_lint_template() {
  cat <<'EOF'
[enforce-workflow-verify-stage] --lint --template: canonical author self-attestation scaffold for a DEV-spawning Workflow script. Paste ONE [AGENT-COMPOSITION] form into a /* */ block comment, plus ONE entry token and the [SIZE-EST] token, then preview with: enforce-workflow-verify-stage.sh --lint <file> (exit 0 = will pass the gate). The fourth section is CONDITIONAL rather than universal — it applies to a schema-mode spawn only, and a DEV verify stage is deliberately text-mode, declares no schema and needs none of it.

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

Completion channel (schema-mode spawns ONLY — a DEV verify stage is text-mode by design and skips this):
  --- (a) declare the reserved property on EVERY schema-mode site (the gate reads presence only) ---
  completion_block: { type: 'string', description: 'the FULL multi-line [COMPLETION] block: the tag alone on its line, each field on its own line, closed by [/COMPLETION] alone on its line' }
  --- (b) instruct that agent to FILL it — prompt-side, and NOT checked here ---
  goal: '<the delegation> ... Put the FULL multi-line [COMPLETION] block into completion_block: the
  recorder reads it from the StructuredOutput input, and a printed text turn does NOT survive the engine.'
  --- (c) route the spawn through the resilience wrapper (compact sketch of the shipped helper) ---
  async function robustAgent(agentType, opts) {
    const run = (extra) => agent(opts.goal, { ...opts, ...extra, agentType }).catch(() => null);
    let result = await run();
    if (result == null || result === '') result = await run({ /* PERMISSIVE re-schema, keep completion_block */ });
    if (result == null || result === '') await agent(opts.goal, { ...opts, agentType, schema: undefined }).catch(() => null);
    return result; // caller .filter(Boolean)s a surviving null out
  }
  GATE both times on null OR the EMPTY STRING: an empty structured result is a silent non-deliverable that
  .filter(Boolean) drops unretried, and a loose == null misses it.
  GATE NOTE: robustAgent's FIRST argument is INVISIBLE here — this gate reads agent() first-args and
  agentType: field values only — so a DECLARED type must ALSO appear as an opts agentType: string literal
  (keep both literals identical), else the gate reads it un-spawned → block-declspawn.
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
  # EDITING THE PYTHON BELOW — keep apostrophes PAIRED, in comments as much as in code. The heredoc is
  # nested inside this "$( … )" substitution, through which bash still tracks quote state, so a single
  # unpaired apostrophe shifts that state and fails the parse at EOF, hundreds of lines from the cause.
  # bash -n is the only check that catches it; run it after ANY edit in here, comment-only edits included.
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
    # parse uncertainty returns False (silent). A site is schema-mode per the SHARED site test
    # (_schema_site_in_span) applied to its raw call arguments — the pinned string-mention eagerness is
    # kept, and the key-position absent value (schema: undefined | null | void <x>) is excluded here as
    # it already is script-wide, so the two can no longer co-emit at opposite polarity on one fixture. A site is HANDLED when [a] a .catch member is chained onto its
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
            if not _schema_site_in_span(stripped[open_idx + 1:close_idx]):
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


def _non_dev_analysis_spawn_present(stripped, dev_set):
    # THE analysis roster, single-sited: is there a spawn-position literal naming an agent that is NOT a
    # dev_set member? Both advisories keyed on the analysis roster read THIS function, so neither can
    # drift into rating a different population than the other.
    # No handler of its own — every caller is a verdict-isolated predicate whose terminal
    # except -> False already owns this failure.
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
        return _non_dev_analysis_spawn_present(stripped, dev_set)
    except Exception:
        return False


# Schema-cap token shape + the completion-block key shape (R1). The key shape admits an underscore or
# hyphen separator (and none), matched case-insensitively.
SCHEMA_CAP_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_$])(maxLength|maxItems)(?![A-Za-z0-9_$])")
COMPLETION_KEY_RE = re.compile(r"completion[_-]?block", re.IGNORECASE)


def get_schema_cap_rule(stripped):
    # Returns the FIRST matched scoped rule tag ("R1" / "R2" / "R3") or "" when none matched — the tag
    # rides the SCHEMA_CAP_ADVISE flag so the firing trace can name the matched rule and a promotion
    # window is adjudicable PER RULE rather than in aggregate. The advisory MESSAGE stays presence-only.
    # ADVISORY-ONLY presence scan for the StructuredOutput cap shapes that drive the engine-internal
    # "retry cap (5) exceeded" collapse loop. Three scoped rules: R1 a maxLength on a completion-block
    # field (unconditional — the standing rule mandates the FULL block, so schema compliance and rule
    # compliance are mutually exclusive at any cap); R2 a maxLength/maxItems inside an `items` object
    # literal (per-element caps MULTIPLY the constraint count, so shrinking one element overflows
    # another — the non-converging shape); R3 a maxLength strictly between 64 and 300.
    # VERDICT ISOLATION (blocking requirement): this is a TOP-LEVEL function with its OWN terminal
    # except -> False. Inlining it at module scope would put the scan inside the module-level handler
    # whose recovery path emits PASS, so an index/pattern/brace-walk failure would silently convert a
    # real BLOCK into a fail-open pass — a gate WEAKENING, not a tidiness point.
    # OPERAND (blocking requirement): the comment-stripped source with every string-literal position
    # blanked, the mask computed over the ALREADY-comment-stripped text. Order is load-bearing —
    # _string_mask deliberately leaves comment interiors unmasked, so masking raw source first would
    # re-expose caps living inside comments. Consequence by construction: a cap inside a commented-out
    # example and a cap word quoted inside a delegation template literal are both INERT, which is what
    # lets the canonical skeletons in this repository pass unmodified.
    # KEY tokens resolve from `stripped` at the SAME offsets (the mask is offset-preserving) while the
    # cap-token and colon/paren anchors resolve from the masked operand: a QUOTED key has its interior
    # blanked, so reading the key off the masked text would silently miss every quoted-key schema.
    # HONEST LIMITS (also published in the advisory text): no JS parse, so a schema built by a helper /
    # spread / import, a variable-valued cap, and a fully-quoted JSON-style schema (the cap TOKEN itself
    # string-resident) are all invisible; the `items` span stays a brace-scan text heuristic.
    try:
        if "maxLength" not in stripped and "maxItems" not in stripped:
            return ""
        smask = _string_mask(stripped)
        struct = "".join(" " if smask[k] else ch for k, ch in enumerate(stripped))
        caps = [(m.start(), m.end(), m.group(1)) for m in SCHEMA_CAP_TOKEN_RE.finditer(struct)]
        if not caps:
            return ""
        n = len(struct)
        obrace, cbrace, oparen = chr(123), chr(125), chr(40)
        ws = " \t\r\n\f\v"
        walk_limit = 200

        def skip_ws_left(j, stop):
            # Whitespace is read from `stripped`: a masked string interior is a SPACE in struct, so
            # skipping over struct here would walk straight through a quoted key.
            while j > stop and j >= 0 and stripped[j] in ws:
                j -= 1
            return j

        def enclosing_brace(idx):
            # Innermost UNCLOSED opening brace left of idx, bounded so the scan stays linear.
            depth = 0
            j = idx - 1
            stop = idx - walk_limit
            while j > stop and j >= 0:
                c = struct[j]
                if c == cbrace:
                    depth += 1
                elif c == obrace:
                    if depth == 0:
                        return j
                    depth -= 1
                j -= 1
            return None

        def brace_key(brace_idx):
            # The property key owning the object literal that opens at brace_idx, or None when
            # unresolvable — unresolvable NEVER fires. Walking left from the brace: whitespace, then
            # OPTIONALLY one opening paren preceded by an identifier or dotted-identifier chain, then
            # a colon, then the key token, bare or quoted. The optional paren step covers a
            # builder-style property declaration alongside a plain object-literal one.
            stop = brace_idx - walk_limit
            j = skip_ws_left(brace_idx - 1, stop)
            if j < 0 or j <= stop:
                return None
            if struct[j] == oparen:
                j = skip_ws_left(j - 1, stop)
                while j > stop and j >= 0 and (struct[j].isalnum() or struct[j] in "_$."):
                    j -= 1
                j = skip_ws_left(j, stop)
            if j < 0 or j <= stop or struct[j] != ":":
                return None
            j = skip_ws_left(j - 1, stop)
            if j < 0 or j <= stop:
                return None
            ch = stripped[j]
            if ch in (chr(39), chr(34), chr(96)):
                k = j - 1
                while k > stop and k >= 0 and stripped[k] != ch:
                    k -= 1
                if k < 0 or k <= stop:
                    return None
                return stripped[k + 1:j] or None
            k = j
            while k > stop and k >= 0 and (stripped[k].isalnum() or stripped[k] in "_$"):
                k -= 1
            return stripped[k + 1:j + 1] or None

        def cap_value(end_idx):
            # The numeric literal a cap token binds to, or None (a variable-valued cap is unreadable).
            k = end_idx
            while k < n and struct[k] in ws:
                k += 1
            if k >= n or struct[k] != ":":
                return None
            k += 1
            while k < n and struct[k] in ws:
                k += 1
            d = k
            while d < n and struct[d].isdigit():
                d += 1
            if d == k:
                return None
            return int(struct[k:d])

        for (start, end, token) in caps:
            if token != "maxLength":
                continue
            # R1 — completion-block field.
            brace = enclosing_brace(start)
            if brace is not None:
                key = brace_key(brace)
                if key is not None and COMPLETION_KEY_RE.fullmatch(key):
                    return "R1"
            # R3 — numeric literal strictly inside the risk band (both edges exclusive). maxItems is
            # deliberately OUT of the R3 scope.
            value = cap_value(end)
            if value is not None and 64 < value < 300:
                return "R3"

        # R2 — any cap inside the lexical span of an `items` object literal. A top-level array
        # maxItems is excluded on its own merits: one constraint that does not multiply across
        # elements cannot produce the re-balance loop that defines the observed failure.
        bi = struct.find(obrace)
        while bi != -1:
            key = brace_key(bi)
            if key is not None and key.lower() == "items":
                depth = 0
                k = bi
                end_span = None
                while k < n:
                    c = struct[k]
                    if c == obrace:
                        depth += 1
                    elif c == cbrace:
                        depth -= 1
                        if depth == 0:
                            end_span = k
                            break
                    k += 1
                if end_span is not None:
                    for (start, _end, _token) in caps:
                        if bi < start < end_span:
                            return "R2"
            bi = struct.find(obrace, bi + 1)
        return ""
    except Exception:
        return ""


# Reserved completion-channel property — the literal the recorder keys on, mirroring the constant of the
# same value in track-outcome.sh. That literal IS the channel, so the token half keys on it, never on a
# paraphrase.
SO_COMPLETION_FIELD = "completion_block"
# Site match: the BARE WORD, not a colon test.
# Rejected alternative → a colon test loses the object-shorthand form, which the authoring exemplar uses.
# Documented FALSE NEGATIVE → a QUOTED key is blanked by the mask and never matches.
# The same blind spot INVERTS for the schema-ABSENT consumer, whose value fires when NO site is found:
# a JSON-style spawn — agent('x', { "schema": {...} }) — is a genuine site this test cannot see, so
# that consumer emits a false POSITIVE on it. Worse, the analysis-size advisory gates on an UNMASKED
# 'schema' substring rather than on this test, so the quoted-key shape co-emits the two lines at
# opposite polarity in one run ("spawns a schema-mode agent" beside "declares NO schema-mode site").
# Both are advisory, so the cost is contradictory stderr, never a wrong exit code. NOT tightened here:
# a pre-mask quoted-key test would match the same text inside an ordinary prose string literal, trading
# this contradiction for the false-BLOCK direction the mask exists to keep closed.
SCHEMA_SITE_RE = re.compile(r"(?<![A-Za-z0-9_$])schema(?![A-Za-z0-9_$])")
# Value exclusion, KEY POSITION ONLY: a value denoting ABSENCE disables schema mode → not a site.
# Admitted by SHAPE rather than by the spellings in use today: the alternation is the CLOSED set of
# surface forms the language gives for the absent value — the `undefined` global, the `null` literal,
# and the `void` operator, whose result is `undefined` for EVERY operand, so no operand is enumerated
# (`void 0`, `void(0)`, `void x` all exclude alike). `void` is a reserved word, so the form is never an
# identifier; the shared trailing lookahead keeps `voidness` / `nullish` / `undefinedish` as sites.
# BOUNDARY, stated rather than left implicit: merely FALSY values (0, '', false, NaN) are NOT excluded.
# They are not absent-value denotations, no authoring idiom disables a schema with one, and admitting
# them would trade a named false positive for an unnamed false negative.
# Scope limit → an occurrence in any other position stays a site (the published residuals below).
SCHEMA_DISABLED_RE = re.compile(r"\s*:\s*(?:undefined|null|void)(?![A-Za-z0-9_$])")


def _schema_site_in_span(span):
    # Site test over a comment-stripped text span (the whole script, or one call argument list).
    # Single-sited so the script-wide consumers and the per-site resilience scan can never disagree
    # about what a site is — a key-position absent value (schema: undefined | null | void <x>) is not one.
    # Masking is the CALLER decision: the script-wide consumers pass MASKED text (precision), while the
    # resilience scan passes the raw span, keeping its pinned string-mention eagerness for a nudge that
    # can only over-advise.
    for m in SCHEMA_SITE_RE.finditer(span):
        if SCHEMA_DISABLED_RE.match(span, m.end()):
            continue
        return True
    return False


def _has_schema_site(stripped):
    # THE site test, single-sited: is there a schema-mode site anywhere in the comment-stripped script?
    # The value that fires when a site EXISTS and the value that fires when NONE does both read this
    # function, so the two can never drift into disagreeing about what a site is — and that shared
    # definition is what makes their disjointness structural rather than a coincidence of two scans.
    # Operand is the MASKED, value-excluded text: site detection is the precision half.
    # No handler of its own — every caller is a verdict-isolated predicate whose terminal
    # except -> False already owns this failure.
    # A masked site implies the same substring in the unmasked text, so the early-out is exact.
    if "schema" not in stripped:
        return False
    smask = _string_mask(stripped)
    struct = "".join(" " if smask[k] else ch for k, ch in enumerate(stripped))
    return _schema_site_in_span(struct)


def completion_block_advisory_needed(stripped):
    # ADVISORY-ONLY (never a verdict, never exit 2): True when a schema-mode site exists anywhere in the
    # script AND the reserved completion-channel property is absent.
    # Consequence of that shape → the recorder falls to derived synthesis and the writer signal is lost.
    # FAIL-OPEN → no site, token present, or any parse uncertainty returns False (silent).
    #
    # TWO OPERANDS OF OPPOSITE POLARITY — the asymmetry is the design, not an inconsistency:
    #   site half  = block-ENABLING → over-detection would FALSE-BLOCK → precision → the MASKED,
    #                value-excluded operand, so a prose mention inside a string cannot mint a site.
    #   token half = block-SUPPRESSING → over-detection merely fails open → recall → the UNMASKED,
    #                comment-stripped text, because masking would blank a quoted property name.
    # Both residuals therefore point fail-open.
    #
    # SCRIPT-WIDE SCOPE, deliberately not span-scoped: the mandated authoring idiom routes every
    # schema-mode spawn through the resilience wrapper, so the schema never appears inside a direct
    # spawn-call span and a span-scoped scan would see only the text-mode fallback line.
    # Price → precision: a schema declared for some other purpose is a site.
    # Bound on that price → the token half must ALSO be absent before anything fires.
    #
    # PUBLISHED RESIDUALS — every non-spawn shape MEASURED to classify as a site, listed so a firing is
    # adjudicable rather than mysterious, and each one-line remediable by declaring the property inline.
    # The per-shape verdict below is why each stays a site rather than joining the exclusion; each was
    # decided by running the candidate exclusion, not by reasoning about it:
    #   a schema bound in ANOTHER module → invisible to the scan (site visible, token absent). No
    #     exclusion is even available: the evidence is outside the file.
    #   a member read or write of the property (opts.schema) → a dot-preceded exclusion is UNSOUND, the
    #     only measured case where one would blank a REAL site: `opts.schema = S; agent(t, opts)` is a
    #     genuine schema-mode configuration whose sole occurrence is dot-preceded.
    #   an assignment binding the bare word to undefined or null → the exclusion is key-position only,
    #     and widening it to `=` would blank `const schema = S` feeding a shorthand spawn.
    #   an import, a destructuring bind, or a parameter named schema → excluding these is measurably
    #     INERT: the binding is used at a spawn, and that use is itself a site, so the verdict is
    #     unchanged for every script that uses what it binds. The exclusion would silence only a bind
    #     with no use, which is dead code — bought at the price of one more place a real site is lost.
    #     The parameter form is additionally PARTIAL: a `function`-anchored pattern misses arrow params.
    #   the bare word inside a REGEX LITERAL (/schema/) → a lexical-class problem, not a value one.
    #     Deciding regex-literal from division needs a parse, and the fix would belong in _string_mask,
    #     which three other passes share — blast radius far outside this advisory.
    #
    # VERDICT ISOLATION: a top-level function with its OWN terminal except → False. Inlined at module
    # scope the scan would sit inside the module-level handler whose recovery path emits PASS, so an
    # index or pattern failure would silently convert a real BLOCK into a fail-open pass.
    try:
        if SO_COMPLETION_FIELD in stripped:
            return False
        return _has_schema_site(stripped)
    except Exception:
        return False


def completion_per_site_advisory_needed(stripped):
    # ADVISORY-ONLY (never a verdict, never exit 2): True when the reserved property is declared on at
    # least ONE schema-mode site and absent from at least one OTHER — the shape the script-wide check
    # above cannot see, because one compliant site satisfies its token half for the whole file and
    # silences it while a second payload still has nowhere to carry the block.
    # DISJOINT from that check by construction: it requires the token ABSENT script-wide, this one
    # requires it PRESENT, so the two can never contend for the single multiplexed value.
    #
    # ADJUDICABLE SITES ONLY — the deliberate narrowing that keeps a per-site read sound. A site counts
    # here only when its own schema is an INLINE object literal, because that literal is the only span
    # in which presence and absence are both decidable from the file. A site whose schema is a named
    # constant, a builder call, a spread or the object shorthand has no such span: its declaration lives
    # elsewhere or nowhere, and reading absence off the spawn would report a bare site for a schema the
    # scan never saw. Those sites are SKIPPED, so a script of only such sites stays silent — a false
    # NEGATIVE, the safe direction, and the same polarity every residual in this pass takes.
    # Consequence stated rather than implied: BOTH halves must be demonstrated in-file before anything
    # fires, which is exactly what the criterion asks for — one compliant site AND one bare site.
    #
    # OPERAND POLARITY, unchanged from the sibling: the SITE half reads the MASKED, value-excluded
    # struct (block-enabling → precision), the TOKEN half reads the UNMASKED span at the same offsets
    # (block-suppressing → recall, so a quoted property name still counts as compliant).
    #
    # KNOWN FALSE POSITIVE: a site whose inline literal spreads a shared base carrying the property
    # reads as bare, since the spread is a reference and the property is not in the span. One nudge is
    # its whole cost, and the one-edit fix — declare the property inline on that site too — is the same
    # remediation the message already names.
    # VERDICT ISOLATION: a top-level function with its OWN terminal except -> False, for the reason
    # recorded at the sibling predicate.
    try:
        if SO_COMPLETION_FIELD not in stripped:
            return False
        if "schema" not in stripped:
            return False
        smask = _string_mask(stripped)
        struct = "".join(" " if smask[k] else ch for k, ch in enumerate(stripped))
        n = len(struct)
        obrace, cbrace = chr(123), chr(125)
        ws = " \t\r\n\f\v"
        compliant = False
        bare = False
        for m in SCHEMA_SITE_RE.finditer(struct):
            if SCHEMA_DISABLED_RE.match(struct, m.end()):
                continue
            k = m.end()
            while k < n and struct[k] in ws:
                k += 1
            if k < n and struct[k] == ":":
                k += 1
                while k < n and struct[k] in ws:
                    k += 1
            if k >= n or struct[k] != obrace:
                continue
            depth = 0
            end = None
            j = k
            while j < n:
                if struct[j] == obrace:
                    depth += 1
                elif struct[j] == cbrace:
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
                j += 1
            if end is None:
                continue
            if SO_COMPLETION_FIELD in stripped[k:end + 1]:
                compliant = True
            else:
                bare = True
        return compliant and bare
    except Exception:
        return False


def completion_schema_absent_advisory_needed(stripped, dev_present, dev_set):
    # ADVISORY-ONLY (never a verdict, never exit 2): True when an analysis-class NON-DEV spawn exists in
    # a script carrying NO schema-mode site anywhere — the MEASURED INCIDENT SHAPE, a schema dropped
    # from the spawn call. Neither sibling value can reach it: both require a site to exist, and this
    # one requires that none does, which is also what makes all three disjoint by the site half alone.
    #
    # THE TWO CONDITIONS ARE BOTH BORROWED, deliberately — nothing new is defined here:
    #   site half   -> _has_schema_site, the SAME test the sibling values use.
    #   roster half -> _non_dev_analysis_spawn_present, the SAME roster the analysis-size advisory uses
    #                  (non-DEV BY EXCLUSION from the runtime dev_set, never a second hardcoded list).
    #
    # DEV SCRIPTS EXCLUDED, for a measured reason rather than symmetry with the sibling: a canonical DEV
    # workflow carries a reviewer verify-stage whose spawns are deliberately text-mode, and the reviewer
    # is itself off the DEV roster — so admitting DEV scripts would fire on nearly every copy-verbatim
    # skeleton, which is a false-positive floor breach rather than a nudge.
    #
    # ACCEPTED OVER-NUDGE, first of TWO residuals (this one is not the whole set — see the second
    # below, which the earlier wording wrongly excluded): an analysis spawn whose
    # deliverable is GENUINELY prose has no schema to declare and fires anyway. Structuredness is not
    # statically decidable, so any suppression heuristic added here could only re-open the
    # false-NEGATIVE direction this value exists to cover. One ignorable stderr line is its full cost,
    # which is exactly why blocking this shape is a stated NON-GOAL.
    #
    # SECOND OVER-NUDGE — a STRUCTURED schema this value cannot see: a JSON-style spawn whose key is
    # quoted — agent('x', { "schema": {...} }) — is masked away by the borrowed site half, so this line
    # fires on a spawn that DOES carry a schema. Because the analysis-size advisory gates on an unmasked
    # substring instead, the same script emits both lines at opposite polarity. Inherited from the site
    # half and documented at SCHEMA_SITE_RE rather than patched here, for the reason recorded there.
    # VERDICT ISOLATION: a top-level function with its OWN terminal except -> False, for the reason
    # recorded at the sibling predicates.
    try:
        if dev_present:
            return False
        if _has_schema_site(stripped):
            return False
        return _non_dev_analysis_spawn_present(stripped, dev_set)
    except Exception:
        return False


# RESIL_FLAG — resilience advisory decision, printed as the THIRD helper output line by emit(). Default
# SILENT so a fail-open exit (an exception before the scan) never fires a spurious advisory.
RESIL_FLAG = "RESIL_SILENT"

# ANALYSIS_SIZE_FLAG — schema-mode NON-DEV analysis-spawn size-attestation advisory, printed as the
# FOURTH helper output line by emit(). Default SILENT so a fail-open exit never fires a spurious nudge.
# The DEV [SIZE-EST] gate (BLOCK_SIZEEST) is UNCHANGED — this is the parallel non-DEV advisory branch.
ANALYSIS_SIZE_FLAG = "ANALYSIS_SIZE_SILENT"

# SCHEMA_CAP_FLAG — presence-only StructuredOutput cap advisory, printed as the FIFTH helper output
# line by emit(). Default SILENT so a fail-open exit never fires a spurious nudge.
SCHEMA_CAP_FLAG = "SCHEMA_CAP_SILENT"

# DEV_FLAG / IMPL_SLOTS — instrumentation-only, printed as the SIXTH and SEVENTH helper output lines.
# Defaults are the non-DEV / zero-slot reading so every early emit path (docroute, the non-DEV PASS,
# the declaration blocks that exit before a declaration exists) still carries a well-formed value.
DEV_FLAG = "DEV_NO"
IMPL_SLOTS = 0

# SIZE_MAP_FLAG / ENTRY_CARD_FLAG — the two cardinality ADVISORIES, printed as the EIGHTH and NINTH
# output lines. Both are trace-only: no stderr nudge, no verdict, no exit code. They are computed at
# the two terminal PASS points ONLY, where the declaration has been parsed and the slot count exists;
# every earlier emit leaves them SILENT rather than reporting a count nobody computed.
SIZE_MAP_FLAG = "SIZE_MAP_SILENT"
ENTRY_CARD_FLAG = "ENTRY_CARD_SILENT"

# SIZEEST_BOUNDS_FLAG — plausibility bounds on the DECLARED DEV-mode [SIZE-EST] tool_uses~ value,
# printed as the ELEVENTH output line. Value-suffixed on the same shape contract as the schema-cap and
# completion-channel flags, so a value added later costs a message arm and no seam edit.
# SEPARATE LINE, not a value on the completion-channel multiplex: that line carries completion-channel
# decisions whose trace tag names that channel, and a sizing value there would mis-report itself; the
# two can also fire on one invocation, which a single-value multiplex cannot express.
# ADVISORY ONLY — no verdict, no exit code, promotable later on this file's advisory-then-promote
# precedent. The two anchors are DERIVED, not maintained here: the per-file floor is the
# `ceil(files x 4.5)` empirical tool_use calibration and the ceiling is the ~40 split trigger ahead of
# the measured 46-52 truncation band, both from orchestrator-role.md -> Spawn Budget
# ("Empirical tool_use calibration" + the HARD SECONDARY split rule).
SIZEEST_BOUNDS_FLAG = "SIZEEST_BOUNDS_SILENT"
SIZEEST_BOUNDS_LOW = "SIZEEST_BOUNDS_ADVISE:low"
SIZEEST_BOUNDS_HIGH = "SIZEEST_BOUNDS_ADVISE:high"
# DEV-mode token only: the analysis-mode form declares `reads~=` and no `tool_uses~=`, so keying the
# capture on `tool_uses~=` excludes it by shape rather than by a second mode test.
SIZE_EST_TOOLUSES_RE = re.compile(r"\[SIZE-EST\][^\n]{0,400}?tool_uses~=\s*(\d+)")
SIZEEST_BOUNDS_CEILING = 40

# COMPLETION_FLAG — the MULTIPLEXED completion-channel advisory, printed as the TENTH output line.
# Value-suffixed (COMPLETION_ADVISE:<value>) so the later per-site-gap and schema-absent nudges add a
# VALUE rather than a line → the output-arity seam across emit() / the fail-open literal / the read
# group is paid exactly once.
# Default SILENT so a fail-open exit never fires a spurious nudge.
COMPLETION_FLAG = "COMPLETION_SILENT"
# The values defined today, each a literal here plus a message case arm on the shell side; the shell
# normalizer admits the suffix by SHAPE, so neither cost a seam edit.
COMPLETION_PROPERTY_ABSENT = "COMPLETION_ADVISE:property-absent"
COMPLETION_PER_SITE_GAP = "COMPLETION_ADVISE:per-site-gap"
COMPLETION_SCHEMA_ABSENT = "COMPLETION_ADVISE:schema-absent"


def impl_slot_count(dev_spawns, verify_types, impl_types, computed_types):
    # Implementation-slot count — a TOTAL function over BOTH dispatch branches, deliberately: the
    # upstream verify form terminates at its own PASS with no verify types bound, so a definition
    # scoped to the in-script branch would raise there and the fail-open handler would convert the
    # raise into a silent pass. Verify slots are the earliest Tier-B position of each declared
    # verify-dev type (empty by construction under upstream); implementation slots are every other
    # position of a declared literal impl type, plus exactly ONE slot per declared computed type.
    # ZERO-POSITION CARVE-OUT: a computed type has no discoverable spawn position (the ordering check
    # already skips it for that reason), so it contributes one slot and no ordinal — asserting more
    # would be a number the gate cannot check.
    # DEV-PRESENCE FLOOR: a script whose ONLY declared dev-* spawn is the verify-team member scores
    # zero implementation slots by the definition above, yet a real DEV agent runs and spends a real
    # budget. That shape is not an edge case — it is the dominant `dev=yes impl_slots=0` reading in
    # the trace log, and against a zero count every slot-derived floor is vacuously satisfied. So a
    # statically observed dev spawn floors the count at one. This is a FLOOR, not a recount: it
    # asserts only what the static evidence supports — at least one DEV agent runs — and never
    # promotes a verify slot into an implementation slot or otherwise inflates a count above zero.
    # SCOPE LIMIT (honest, no static fix available): the count sees STATIC spawn positions only. A
    # loop fan-out spawning N runtime instances from one token is one position and one slot, and a
    # wrapper-indirected type declared `impl-computed:` likewise contributes exactly one. Both remain
    # under-sized whenever N > 1; the floor above fixes the zero case only, and asserting a runtime
    # fan-out width would be a number this gate cannot check.
    try:
        pos_by_type = {}
        for (p, t) in dev_spawns:
            pos_by_type.setdefault(t, []).append(p)
        for t in pos_by_type:
            pos_by_type[t].sort()
        verify_slots = set()
        for t in verify_types:
            if pos_by_type.get(t):
                verify_slots.add(pos_by_type[t][0])
        n = 0
        for t in impl_types:
            for p in pos_by_type.get(t, []):
                if p not in verify_slots:
                    n += 1
        n += len(set(computed_types))
        if n == 0 and dev_spawns:
            n = 1
        return n
    except Exception:
        return 0


def sizeest_bounds(attestation_src, slots):
    # Plausibility bounds on the DECLARED DEV-mode tool_uses~ value against the slot count the gate
    # already computes. TOTAL function: any surprise returns SILENT, so a parse accident can never
    # manufacture a nudge. Fires only where a DEV-mode token EXISTS — the token-absent case is already
    # the BLOCK_SIZEEST gate's, and advising it too would double-advise the same miss.
    # LOW takes precedence over HIGH: under-declaring is the DANGEROUS direction (it smuggles an
    # oversized delegation past the split discipline), over-declaring is the safe one.
    try:
        declared = [int(m.group(1)) for m in SIZE_EST_TOOLUSES_RE.finditer(attestation_src)]
        if not declared:
            return "SIZEEST_BOUNDS_SILENT"
        # floor = slots x 4.5, in integer arithmetic so no float rounding decides a nudge.
        if slots > 0 and any(d * 2 < slots * 9 for d in declared):
            return SIZEEST_BOUNDS_LOW
        if any(d > SIZEEST_BOUNDS_CEILING for d in declared):
            return SIZEEST_BOUNDS_HIGH
        return "SIZEEST_BOUNDS_SILENT"
    except Exception:
        return "SIZEEST_BOUNDS_SILENT"


def emit(verdict, entry_marker):
    print(verdict)
    print(entry_marker)
    print(RESIL_FLAG)
    print(ANALYSIS_SIZE_FLAG)
    print(SCHEMA_CAP_FLAG)
    print(DEV_FLAG)
    print("IMPL_SLOTS=" + str(IMPL_SLOTS))
    print(SIZE_MAP_FLAG)
    print(ENTRY_CARD_FLAG)
    print(COMPLETION_FLAG)
    print(SIZEEST_BOUNDS_FLAG)
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

    # Schema-cap advisory decision — computed here so EVERY emit path carries it on line 5, including
    # the early non-DEV pass. The scan owns its internal guard, so a failure inside it can never reach
    # the module-level handler below (which emits PASS) and disarm a real block.
    schema_cap_rule = get_schema_cap_rule(antigaming_src)
    if schema_cap_rule:
        SCHEMA_CAP_FLAG = "SCHEMA_CAP_ADVISE:" + schema_cap_rule

    dev_alt = '|'.join(re.escape(d) for d in dev_set if d)

    # TIER A — broad quoted-literal presence. Feeds dev_present / reviewer-existence / entry / size,
    # AND supplies the Tier-A dev TYPE SET consumed by consistency check (b-prime).
    dev_re_present = re.compile(r"['\"](" + dev_alt + r")['\"]")
    rev_re_present = re.compile(r"['\"]" + REVIEWER_LITERAL + r"['\"]")
    tier_a_dev_types = set(m.group(1) for m in dev_re_present.finditer(antigaming_src))
    dev_present = bool(tier_a_dev_types)
    # Instrumentation: set BEFORE the first emit that can follow (docroute / the non-DEV PASS) so the
    # DEV flag is correct on every recorded firing, which is the whole point of the denominator fix.
    DEV_FLAG = "DEV_YES" if dev_present else "DEV_NO"

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

    # Completion-channel decision — computed ONCE here, as the VALUE the multiplexed line will carry.
    # POSITION: after dev_present exists, because the schema-absent value reads it, and still before
    # EVERY emit that can carry the flag. The docroute emit above deliberately carries none.
    # The ASSIGNMENT is deliberately SPLIT on the DEV predicate (PRECEDENCE SPLIT, this file header).
    # Why no single position serves both halves → reaching a non-DEV analysis fan-out needs a position
    # before the non-DEV early PASS, and that same position would pre-empt every DEV attestation gate.
    # ONE LINE, ONE VALUE: the three predicates are disjoint by their SITE conditions (a site with the
    # token absent script-wide, a site with it present on some site, and no site at all), so the chain
    # below never has to choose between two live values — the single-value contract is structural
    # rather than incidental, and the ordering here expresses that rather than a precedence.
    completion_value = ""
    if completion_block_advisory_needed(antigaming_src):
        completion_value = COMPLETION_PROPERTY_ABSENT
    elif completion_per_site_advisory_needed(antigaming_src):
        completion_value = COMPLETION_PER_SITE_GAP
    elif completion_schema_absent_advisory_needed(antigaming_src, dev_present, dev_set):
        completion_value = COMPLETION_SCHEMA_ABSENT

    def pass_or_size():
        return "BLOCK_SIZEEST" if size_est_missing else "PASS"

    # Sizing-entry channel = the EXISTING raw-scanned [SIZE-EST] literal, counted for the first time.
    # One occurrence is one sizing entry, which is the standing "a token at EVERY DEV spawn" rule read
    # as a cardinality. No new key, no grammar change — KNOWN_KEYS stays closed.
    size_est_count = attestation_src.count(SIZE_EST_LITERAL)

    def wave_a_signals(verify_types, impl_types, computed_types):
        # Returns the (slot count, size-map flag, entry-cardinality flag) triple for a terminal PASS
        # point. HONESTY: only the COUNT is mechanical. Which sizing entry belongs to which call site
        # is author-assigned and unverifiable — the same trust class as role truthfulness in the
        # declaration itself. Both flags are advisory: nothing below reads them for a verdict.
        n = impl_slot_count(dev_spawns, verify_types, impl_types, computed_types)
        size_map = "SIZE_MAP_ADVISE" if size_est_count != n else "SIZE_MAP_SILENT"
        entry_card = "ENTRY_CARD_ADVISE" if (entry_literal_found and n >= 4) else "ENTRY_CARD_SILENT"
        return (n, size_map, entry_card, sizeest_bounds(attestation_src, n))

    # SECOND detection pass (doc-routing leak) — independent, runs first.
    if detect_docroute_leak(antigaming_src, attestation_src):
        emit("BLOCK_DOCROUTE", entry_marker)

    # No DEV literal anywhere (Tier A) → simple workflow → Stage-2 exempt.
    if not dev_present:
        # NON-DEV half of the split: the last position before the early PASS, so the analysis fan-outs
        # this advisory exists for are reached at all. docroute above keeps precedence deliberately.
        if completion_value:
            COMPLETION_FLAG = completion_value
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
        # Terminal PASS point 1 — the upstream branch. Verify types are empty by construction here,
        # which is exactly what makes the slot definition total rather than branch-specific.
        IMPL_SLOTS, SIZE_MAP_FLAG, ENTRY_CARD_FLAG, SIZEEST_BOUNDS_FLAG = wave_a_signals(
            declared_verify_dev_types, declared_impl_dev_types, declared_computed_types)
        # DEV half of the split: folded into the terminal emit, so every attestation gate above keeps
        # precedence and a DEV script blocked earlier carries no completion-channel tag.
        if completion_value:
            COMPLETION_FLAG = completion_value
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
    # Terminal PASS point 2 — the in-script branch.
    IMPL_SLOTS, SIZE_MAP_FLAG, ENTRY_CARD_FLAG, SIZEEST_BOUNDS_FLAG = wave_a_signals(
        declared_verify_dev_types, declared_impl_dev_types, declared_computed_types)
    # DEV half of the split — same reason as terminal PASS point 1.
    if completion_value:
        COMPLETION_FLAG = completion_value
    emit(pass_or_size(), entry_marker)
except SystemExit:
    raise
except Exception:
    emit("PASS", "ENTRY_OK")
PY
  )"

  # Run the helper. It prints TEN lines: line 1 = verdict token, line 2 = entry marker
  # (ENTRY_OK|ENTRY_ADVISORY), line 3 = resilience flag (RESIL_ADVISE|RESIL_SILENT), line 4 =
  # analysis-size flag (ANALYSIS_SIZE_ADVISE|ANALYSIS_SIZE_SILENT), line 5 = schema-cap flag
  # (SCHEMA_CAP_ADVISE[:R<n>]|SCHEMA_CAP_SILENT), line 6 = DEV flag, line 7 = IMPL_SLOTS=<n>, line 8 =
  # size-map flag, line 9 = entry-cardinality flag, line 10 = the MULTIPLEXED completion-channel flag
  # (COMPLETION_ADVISE[:<value>]|COMPLETION_SILENT), line 11 = the [SIZE-EST] plausibility-bounds flag
  # (SIZEEST_BOUNDS_ADVISE[:<value>]|SIZEEST_BOUNDS_SILENT).
  # A non-zero exit OR unparseable output → fail-open (PASS + ENTRY_OK + all flags SILENT).
  # The fallback literal below MUST gain a token in LOCKSTEP with emit()
  # and the read group — pinned by a source-structural arity assertion in the bats suite, because a
  # stale literal is byte-identical in observable behaviour (pre-seeded defaults + swallowed EOF).
  # The inner `|| true` keeps a verdict-engine CRASH (python3 interpreter failure — its PRESENCE was
  # already checked upstream at ~L320) from tripping the errtrace ERR trap INSIDE this command
  # substitution; such a crash then yields EMPTY output, which the T12 branch below detects. A
  # successful helper always prints >=1 line (even its own except-branch emits PASS), so empty ⇔ crash.
  helper_out="$(printf '%s' "${script_src}" | python3 -c "${verdict_py}" "${DEV_SET}" 2>/dev/null || true)"
  if [[ -z "${helper_out}" ]]; then
    # T12 manifest site (gate-evaluation): the verdict engine could NOT run, so the gate silently falls
    # open to PASS without evaluating the verify-stage. Surface the disarm with a named code; the
    # fail-open verdict + exit stay UNCHANGED (advisory — stderr only).
    printf '[enforce-workflow-verify-stage] WFG-VERDICT-FAILOPEN: verdict helper produced no output (python3 crash / interpreter failure) — gate defaulted to fail-open PASS, verify-stage NOT evaluated\n' >&2
    helper_out=$'PASS\nENTRY_OK\nRESIL_SILENT\nANALYSIS_SIZE_SILENT\nSCHEMA_CAP_SILENT\nDEV_NO\nIMPL_SLOTS=0\nSIZE_MAP_SILENT\nENTRY_CARD_SILENT\nCOMPLETION_SILENT\nSIZEEST_BOUNDS_SILENT'
  fi

  # Parse the ten helper lines with sequential reads. Pre-seeded defaults + a group-level `|| true` keep an
  # EOF on a short (legacy / fail-open) output from tripping the fail-open ERR trap; each field is then
  # normalized to a known value so a stray/absent line collapses to the safe default.
  verdict="PASS"
  entry_marker="ENTRY_OK"
  resil_flag="RESIL_SILENT"
  analysis_size_flag="ANALYSIS_SIZE_SILENT"
  schema_cap_flag="SCHEMA_CAP_SILENT"
  local dev_flag_raw="DEV_NO" impl_slots_raw="IMPL_SLOTS=0"
  local size_map_flag="SIZE_MAP_SILENT" entry_card_flag="ENTRY_CARD_SILENT"
  local completion_flag="COMPLETION_SILENT"
  local sizeest_bounds_flag="SIZEEST_BOUNDS_SILENT"
  {
    IFS= read -r verdict
    IFS= read -r entry_marker
    IFS= read -r resil_flag
    IFS= read -r analysis_size_flag
    IFS= read -r schema_cap_flag
    IFS= read -r dev_flag_raw
    IFS= read -r impl_slots_raw
    IFS= read -r size_map_flag
    IFS= read -r entry_card_flag
    IFS= read -r completion_flag
    IFS= read -r sizeest_bounds_flag
  } <<<"${helper_out}" || true
  [[ -z "${verdict}" ]] && verdict="PASS"
  [[ "${entry_marker}" == "ENTRY_ADVISORY" ]] || entry_marker="ENTRY_OK"
  [[ "${resil_flag}" == "RESIL_ADVISE" ]] || resil_flag="RESIL_SILENT"
  [[ "${analysis_size_flag}" == "ANALYSIS_SIZE_ADVISE" ]] || analysis_size_flag="ANALYSIS_SIZE_SILENT"
  # The schema-cap flag carries the matched scoped rule as a `:R<n>` suffix (trace instrumentation); a
  # bare SCHEMA_CAP_ADVISE stays admitted so a legacy/short helper output is not silently re-classified.
  # Admitted by SHAPE, never by an enumeration of today's rule tags: a fourth scoped rule added to
  # get_schema_cap_rule would fall through an enumeration to SILENT, so its advisory would stop printing
  # AND stop being traced with no error anywhere — silently under-counting the very per-rule promotion
  # window the suffix exists to build. Strictness over the seam is unchanged: an unanchored or
  # non-`R<digits>` suffix still collapses to SILENT.
  if [[ ! "${schema_cap_flag}" =~ ^SCHEMA_CAP_ADVISE(:R[0-9]+)?$ ]]; then
    schema_cap_flag="SCHEMA_CAP_SILENT"
  fi

  # The multiplexed completion-channel flag carries its decision as a value suffix. Admitted by SHAPE —
  # an identifier-shaped value — and NEVER by an enumeration of today's values: an enumeration would
  # silently swallow a value added later, collapsing it to SILENT so its advisory stops printing AND
  # stops being traced with no error anywhere, which is the exact trap the schema-cap suffix records.
  # A bare COMPLETION_ADVISE stays admitted so a legacy/short helper output is not re-classified.
  # The comma is deliberately OUT of the shape: the trace joins tags with commas, so a comma inside a
  # value would destroy the tag boundary a reader splits on.
  if [[ ! "${completion_flag}" =~ ^COMPLETION_ADVISE(:[A-Za-z0-9][A-Za-z0-9_-]*)?$ ]]; then
    completion_flag="COMPLETION_SILENT"
  fi

  # The [SIZE-EST] bounds flag carries its decision as a value suffix, admitted by the SAME shape
  # contract (identifier-shaped value, comma excluded so the trace tag boundary survives) and never by
  # an enumeration of today's values — same trap the two sibling suffixes record.
  if [[ ! "${sizeest_bounds_flag}" =~ ^SIZEEST_BOUNDS_ADVISE(:[A-Za-z0-9][A-Za-z0-9_-]*)?$ ]]; then
    sizeest_bounds_flag="SIZEEST_BOUNDS_SILENT"
  fi

  # INSTRUMENTATION FIELDS (never a verdict input) — normalize to the safe reading on any stray or
  # short helper output, mirroring the flag normalization above. A non-integer slot count records as
  # 0 rather than poisoning the field with unparsed text.
  if [[ "${dev_flag_raw}" == "DEV_YES" ]]; then
    dev_flag="yes"
  else
    dev_flag="no"
  fi
  impl_slots="${impl_slots_raw#IMPL_SLOTS=}"
  [[ "${impl_slots}" =~ ^[0-9]+$ ]] || impl_slots=0

  # RESILIENCE ADVISORY (fail-open, stderr-only) — the helper decided per-site whether >=1 unhandled
  # schema-mode agent spawn remains; print the nudge here so it rides along with ANY verdict (PASS or a
  # BLOCK below). This NEVER alters the exit code.
  if [[ "${resil_flag}" == "RESIL_ADVISE" ]]; then
    print_resilience_advisory
    add_advisory "resilience"
  fi

  # ANALYSIS-SIZE ADVISORY (fail-open, stderr-only) — the helper decided a schema-mode NON-DEV analysis
  # spawn lacks a [SIZE-EST] token; nudge here so it rides ANY verdict. NEVER alters the exit code (the
  # DEV BLOCK_SIZEEST hard-block path stays exit 2 and is decided independently in the case dispatch).
  if [[ "${analysis_size_flag}" == "ANALYSIS_SIZE_ADVISE" ]]; then
    print_analysis_size_advisory
    add_advisory "analysis-size"
  fi

  # SCHEMA-CAP ADVISORY (fail-open, stderr-only) — the helper's isolated scan matched one of the three
  # scoped cap rules; nudge here so it rides ANY verdict. Placed BEFORE the entry-miss block and the
  # verdict case dispatch, so it can NEVER alter an exit code — a flagged cap on a hard-blocking script
  # still exits 2 (pinned by the disarm-regression fixture).
  if [[ "${schema_cap_flag}" == SCHEMA_CAP_ADVISE* ]]; then
    print_schema_cap_advisory
    # Trace tag carries the matched rule when the helper supplied one (`SCHEMA_CAP_ADVISE:R1`); a bare
    # flag records as plain `schema-cap` rather than inventing a rule it never reported.
    add_advisory "schema-cap${schema_cap_flag#SCHEMA_CAP_ADVISE}"
  fi

  # COMPLETION-CHANNEL ADVISORY (fail-open, stderr-only) — the helper's isolated scans decided the
  # reserved completion-channel property is missing from a payload that needs it, or that no payload
  # exists at all; nudge here so it rides ANY verdict. Placed with the other advisory emitters, before
  # the entry-miss block and the verdict case dispatch, so it can NEVER alter an exit code.
  # MULTIPLEXED DISPATCH: the MESSAGE keys on the value, the TRACE TAG does not. A value added later is
  # therefore recorded from the moment it exists, and only its message waits on a new case arm — which
  # is what keeps the seam paid once.
  # ROLLBACK LEVER (header → ROLLBACK LEVER, the scope SoT) — the marker demotes the property-absent arm
  # ONLY: the two sibling arms below are deliberately UNGUARDED, and the tag accumulation past this case
  # is untouched, so a rollback period silences one message and keeps every other signal, trace included.
  # A bare existence test read inline — an unreadable or otherwise odd path reads as ARMED, the
  # fail-safe direction for a lever whose other failure mode is a check silently disarmed by accident.
  case "${completion_flag}" in
    COMPLETION_ADVISE:property-absent)
      [[ -e "${WORKFLOW_GATE_COMPLETION_ROLLBACK_MARKER}" ]] || print_completion_channel_advisory
      ;;
    COMPLETION_ADVISE:per-site-gap) print_completion_per_site_advisory ;;
    COMPLETION_ADVISE:schema-absent) print_completion_schema_absent_advisory ;;
    # SILENT, or a value whose message this build does not carry yet: print nothing. The trace below
    # is value-agnostic, so such a value still records and loses no adjudication window.
    *) ;;
  esac
  if [[ "${completion_flag}" == COMPLETION_ADVISE* ]]; then
    # A bare flag records as plain `completion-channel` rather than inventing a value it never reported.
    add_advisory "completion-channel${completion_flag#COMPLETION_ADVISE}"
  fi

  # [SIZE-EST] PLAUSIBILITY ADVISORY (fail-open, stderr-only) — the helper bounded the DECLARED
  # DEV-mode tool_uses~ value against the slot count it already computes; nudge here so it rides ANY
  # verdict. Placed with the other advisory emitters, before the entry-miss block and the verdict case
  # dispatch, so it can NEVER alter an exit code. Same multiplexed dispatch shape as the
  # completion-channel arm: the MESSAGE keys on the value, the TRACE TAG does not.
  case "${sizeest_bounds_flag}" in
    SIZEEST_BOUNDS_ADVISE:low) print_sizeest_low_advisory ;;
    SIZEEST_BOUNDS_ADVISE:high) print_sizeest_high_advisory ;;
    *) ;;
  esac
  if [[ "${sizeest_bounds_flag}" == SIZEEST_BOUNDS_ADVISE* ]]; then
    add_advisory "sizeest-bounds${sizeest_bounds_flag#SIZEEST_BOUNDS_ADVISE}"
  fi

  # CARDINALITY ADVISORIES (trace-only — no stderr nudge, deliberately). These record a measurement;
  # they do NOT nudge, do not name a fix, and NOTHING below reads them. Placed with the other advisory
  # emitters so the tag is set before any trace emit or block_and_exit, and after the flags are read.
  # size-map fires when the [SIZE-EST] occurrence count differs from the implementation-slot count in
  # EITHER direction; entry-cardinality fires when an [ENTRY-CLASS] simple-task classification
  # co-occurs with 4 or more implementation slots. Whether either is worth acting on is unknown —
  # which is why this wave only counts.
  if [[ "${size_map_flag}" == "SIZE_MAP_ADVISE" ]]; then
    add_advisory "size-map"
  fi
  if [[ "${entry_card_flag}" == "ENTRY_CARD_ADVISE" ]]; then
    add_advisory "entry-cardinality"
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
      # SCOPE ADVISORY — on the PASS arm only, so a fault in this newest check can never mask one of
      # the block verdicts above. Ordered before emit_trace so the tag rides the pass trace line.
      if [[ "${dev_flag}" == "yes" ]] && ! printf '%s' "${script_src}" | grep -qF '[SCOPE]'; then
        print_scope_advisory
        add_advisory "scope"
      fi
      # FIRST-LINK ADVISORY — PASS arm only, for the scope advisory's reason AND one of its own: this is
      # the only check here that reads the network, so a blocked script never pays a loopback GET. The
      # three cheap conjuncts are ordered ahead of the walk, so a compliant or plan-ref-less workflow
      # issues zero GETs. Predicate + full fail-open list: header -> SEVENTH ADVISORY PASS.
      if [[ "${dev_flag}" == "yes" ]] && ! printf '%s' "${script_src}" | grep -qF "${FIRST_LINK_LITERAL}"; then
        local plan_refs first_link_plan_id
        # First plan-ref in file order. No `head` in the pipe: a SIGPIPE'd grep under pipefail would
        # trip the fail-open ERR trap, so the whole match set is captured and sliced in bash.
        plan_refs="$(printf '%s' "${script_src}" | grep -oE 'clauded-docs/[0-9]+' || true)"
        first_link_plan_id="${plan_refs%%$'\n'*}"
        first_link_plan_id="${first_link_plan_id##*/}"
        # shellcheck disable=SC2310
        #   Predicate call — the exit status IS the answer (chain resolved vs fail-open).
        if [[ -n "${first_link_plan_id}" ]] && get_supersede_chain "${first_link_plan_id}" \
          && ((CHAIN_DEPTH >= 1)); then
          print_first_link_advisory "${CHAIN_DEPTH}" "${CHAIN_ROOT_ID}"
          add_advisory "first-link"
        fi
      fi
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
