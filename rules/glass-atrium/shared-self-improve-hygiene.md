# Self-Improvement Pipeline Hygiene Rules (Cross-Cutting Concern)

Applies to two audiences, each with its own load trigger:

- **ORCHESTRATOR scope** (main session / global coordinator) — loaded automatically.
- **DEV agents that touch the autoagent self-improvement pipeline** (`~/.glass-atrium/autoagent/daemon-apply.sh`, `daemon_cycle.py`, `daemon-cycle.sh`, related launchd plists) — loaded when the change scope includes any path under `~/.glass-atrium/autoagent/` or the loop's launchd configuration.

## Working Tree Hygiene Contract [ORCHESTRATOR+DEV]

- **Each apply runs as a git-FREE file-copy transaction** (`autoagent/lib/git-txn.sh`):
  - a before-image copy of the single target is captured into a per-proposal `agents-bak` subdir BEFORE apply;
  - a verify failure atomically restores the target from that before-image;
  - net effect: 100% user-edit preservation on the target.
- **The serial-writer assumption is enforced by the shared `.apply-lock`** — both writers (daemon-apply.sh + update.sh) acquire it via `scripts/lib/apply-lock.sh` (pid liveness + TTL stale-reclaim; a live holder always blocks).
- **On a restore-stage failure**, the before-image is preserved in `agents-bak` for user inspection — automatic resolution FORBIDDEN · manual recovery from the per-proposal before-image required.
- **Backup retention**: the retention prune (default 14 days, `AUTOAGENT_BACKUP_TTL_DAYS`) never removes the newest cycle subdir.
- **On a multi-file cascade** → meaning-unit commit obligation (aligns with `core-git-workflow.md`); the loop is trustworthy only from an accumulated dirty state.
  - Autonomous mode (user absent): orchestrator auto-commit + per-file diff record.
  - Interactive sessions: prefer a manual user commit.

## Precondition Loud-Fail Principle [DEV+ORCHESTRATOR]

- **Silent-fail absorption of a pipeline stage entry condition is FORBIDDEN.** Entry conditions are things like git repo exists / TCC permission / launchd active / API endpoint reachability; the forbidden absorption patterns are `2>/dev/null` / `|| true` / `|| return 0`.
- **An unmet precondition gets the remedy triad — all three legs, not a choice**: a named exit code · an explicit stderr message · an automatic log-aggregator surface. ("Remedy triad" elsewhere in this file means exactly these three.)
- **Exit codes are PER-SCRIPT, never a shared table** — the same number carries unrelated meanings in different scripts:
  - `daemon-apply.sh` — exit 4 = "another apply in progress" · exit 5 = "apply-lock lib missing"
  - `autoagents-eval.sh` — exit 4 = "claude binary not found" · exit 5 = "git status failed on the default-mode scan"
  - Read each script's own header Modes block before reusing a number.
- **An exit-code semantics spec is required** — the wrapper script can branch on it + automatically triggers monitor dashboard alerting.
- **Cascade cost (the loud-fail cost-benefit asymmetry)**: on the launchd 1-day unattended cycle, a lost first-failure visibility fossilizes into a multi-day `status=pending` backlog amplified across days × N-agents.

### Absorption Taxonomy & Annotation Convention [DEV+ORCHESTRATOR]

A grep count of the absorption idioms is a POPULATION, not a defect set: the large majority of occurrences are load-bearing shell idioms or explicitly-handled failure paths, and driving the count down is the failure mode, not the fix. Classify before judging, and classify BLOCK-scoped — never line-local.

- **Category 1 — benign idiom**: the non-zero status is a normal outcome, and removing the suppression breaks the script under `set -Eeuo pipefail`. Anchor the worked shapes below by SHAPE and by function-relative description, never by a raw line number. This anchoring rule, the `handled@<where>` field-content rule and the physical-placement rule (both under "Annotation convention" below) govern different objects and do not collapse into one rule about line numbers. Worked shapes:
  - a NUL-delimited heredoc read reaching EOF without a NUL terminator (the critical hook loads its own classifier source this way);
  - a pattern search exiting 1 because nothing matched (`grep`/`find` — zero hits is data);
  - trap or teardown cleanup of a file that may already be gone.
- **Category 2 — explicitly handled** (the opposite of silent): the suppression covers the stderr stream only, or a redundant channel only, while the status is captured, branched on, or defaulted. Worked shapes:
  - the critical hook's classifier invocation whose captured status routes a failure to a named fail-closed block (the PR #88 contract — untouchable);
  - the wiki-compile FATAL-echo whose suppressed log append is redundant, because the very next line emits the same notice unsuppressed to stderr, a status row records the error, and the block ends in a non-zero exit. Judging that FATAL-echo line without reading its block gets it wrong.
- **Category 3 — genuine silent absorption**: no branch, no captured status, no loud channel anywhere in the block. This is the only category the Precondition Loud-Fail Principle above forbids, and it is CONVERTED, never annotated — the located family is the daemon-run reporting channel, which absorbed the third leg of the very remedy triad this rule mandates.

#### Enforced surface (unattended execution)

The principle's cascade-cost rationale is about failures nobody is watching, so the enforced scope is the unattended surface:

- **In scope**: the autoagent pipeline (its declared scope, kept) · the launchd-driven `scripts/*.sh` · the `scripts/lib/*.sh` libraries those depend on.
- **The scope SoT is the `SCOPE_FILES` list carried by `scripts/audit-absorption.sh`** — the enforced scope is exactly that list. Read the list itself, never a count quoted in prose.
- **EXPLICITLY DEFERRED, not forgotten** — the hooks directory and the non-daemon scripts: a synchronous pre-tool hook fails in front of an operator within seconds, which is the opposite profile.
- **Coverage extends to a deferred surface through the promotion path below** (advisory coverage first, then promote), never by re-litigating the scope decision.

#### Annotation convention

Every sanctioned suppression in the enforced scope carries an adjacent annotation. The rules below govern different objects — the label, the `<where>` field, the physical placement, the reason text — and they do not collapse into one rule about line numbers:

- **Labels — the vocabulary is CLOSED at two**: `# GA-ABSORB[benign]: <reason>` — category 1 · `# GA-ABSORB[handled@<where>]: <reason>` — category 2. No third label exists: a category-3 site is converted, and a converted site carries `# GA-CONVERTED: <note>` instead.
- **`<where>` field content**: it NAMES the handling (function, sentinel, or relative location) and is never a bare line number, because line numbers drift on the next edit.
- **Placement**: an end-of-line trailing comment on the same physical line as the idiom (canonical, zero drift). Own-line-immediately-above is permitted ONLY when the trailing form is forced out — that is, only when one of the following three holds:
  - the line would exceed 120 columns;
  - the site sits on a `\`-continued line;
  - a trailing comment is illegal inside a multi-line pipeline segment.
- **Placement inside a `\`-continued statement** — a rule fixing where the token goes, never a further trigger for the exception above: when the site and its predecessor are both `\`-continued, the token sits on the first physical line of the continued statement.
- **Reason text**: non-empty one-line English prose. Presence and grammar are mechanical; truthfulness is the annotator's — the same trust model the orchestration attestation tokens use.

#### Auditor

- `scripts/audit-absorption.sh` is **presence-only**: it reports unannotated sites and grammar rejects on stdout.
- **It never adjudicates a category**, because the disambiguating evidence is block-scoped and a tool confident enough to classify mislabels exactly the category-2 sites that matter most.
- **Annotation and conversion counts are reported as DISTINCT fields**, so an annotation-only outcome is visibly incomplete.
- **Exit codes named here**: exit 2 = usage error · exit 3 = a scope-listed file missing or unreadable. These two are a partial list — the full exit contract, including the blocking exit 1, is in the promotion record below.
- **Promotion to blocking requires, verbatim**: *"coverage complete, auditor false-positive rate zero across the scope, and the conversion set landed."*

#### Promotion record (executed 2026-07-27 for the `SCOPE_FILES`-listed enforced scope)

The condition above was confirmed met under the WIDENED terminator pattern (all four terminator-bearing alternatives share the `([^[:alnum:]_]|$)` class). What was confirmed:

- The scope run reported `unannotated=0 quality_reject=0`, and those two fields — re-confirmed by the latest live scope run — are the ONLY standing acceptance criteria.
- Every closer-shaped site surfaced by the widening was block-scope adjudicated with zero false positives (six in-quotes hits are executed `$( )` command substitutions, none in inert literals or comments, none left unadjudicated).
- The conversion set landed: the eight-site reporting-channel family plus the `autoagents-eval.sh` git-status conversion at named exit 5.

A standing rule on the census fields — not part of what that run confirmed:

- **The `annotated=` / `converted=` totals are deliberately NOT quoted here**: they track whatever the scope currently holds and move with any later dedup or scope addition (the shared sink extraction into `scripts/lib/pg-report-drop.sh` has since folded the duplicated sink and the six wiki reporting sites into one definition each, dropping both totals well below their promotion-day values). Read them from an actual `scripts/audit-absorption.sh` run rather than from prose — a hand-copied census re-drifts on the next edit exactly as a hand-copied file count does.

The contract now in force:

- **Exit semantics**: a scope-list run FAILS with exit 1 on any finding (unannotated site or grammar reject); a clean scope exits 0. `--advisory` reports without failing anywhere, `--strict` extends blocking to a `--path` run, and the two flags are mutually exclusive (exit 2).
- **Surface split**: only the default scope-list run blocks. The DEFERRED hooks surface and any ad-hoc `--path` probe stay advisory, so the deferred path cannot red the build by accident — the deferred-then-promote path for that surface is unchanged.
- **CI**: a blocking auditor step runs on the `scripts/test` leg of the `test-bash` matrix, ordered BEFORE the bats step (a step-level `if:` defaults to `success()`, so an appended step would skip exactly when the leg is already red).
  - RESIDUAL, stated not overstated: `test-bash` is gated on the `detect-changes` bash filter, so a PR touching no shell file skips the auditor — the scope is shell-only, so no non-shell change can introduce a site, but the gate is change-conditional rather than unconditional.
- **Rollback**: the promotion is a revertable meaning-unit set (exit semantics + usage line + CI step + this record). Reverting it — or passing `--advisory` in CI — restores advisory mode with the verbatim condition text above intact.

## Prose-Only-Add Patch Classification (DETECTION, not reject) [DEV+ORCHESTRATOR]

- **Classification trigger**: a self-improvement patch is classified `prose-only-add` when `added > 0 AND removed == 0 AND no hook file touched`.
- **Action on a match**: emit a WARNING into the signal store; do NOT fail-closed-reject — false-blocking the learning loop is the worse failure.
- **Negative case**: a conversion/subtraction patch (removes prose OR touches a hook) does NOT warn.
- **Ownership**: the detector lives in `daemon_cycle.py` (DEV-owned); this record is the criteria SoT.

## Apply-Side Rollback Contract [DEV]

- `backup_capture_failed` path (`GIT_TXN_BACKUP_CAPTURE_FAIL`) → hard PRE-apply abort + emit_log — nothing was applied, so there is nothing to restore
- Verification failure after apply (`GIT_TXN_VERIFY_FAIL`) → atomic restore of the target from the `agents-bak` before-image (sibling temp + `mv -f` rename, same-FS) → keeps a user-retryable state
- In-place `cp` restore FORBIDDEN — a crash mid-copy truncates the target; only the atomic temp+rename swap is permitted
- Bats test coverage required for the apply / atomic-restore / lock-reclaim branches (`autoagent/test/git-txn-gitfree.bats` — bundled into the live install per the release manifest)

## Harness Git Track Status

Each path below is DESIGNED to be its own independent git repository — one repository per path, not one repository covering the group:

| Independent repository, one per path | Initialized by |
|---|---|
| `~/.glass-atrium/autoagent/` · `~/.glass-atrium/rules/` · `~/.glass-atrium/agents/` · `~/.glass-atrium/monitor/` | the audit/install operation |
| the three test corpora — `~/.glass-atrium/test/` · `~/.glass-atrium/hooks/test/` · `~/.glass-atrium/scripts/test/` | `scripts/init-test-repos.sh` (idempotent) |

- Once initialized, change history is git-preserved for the self-improvement core code (daemon-apply.sh / daemon_cycle.py / daemon-cycle.sh) AND for every rule file under `~/.glass-atrium/rules/` (including this document) — prior-version recovery via `git log` / `git restore`
- **Where a dir HAS been git-initialized**, git history is its recovery mechanism → pre-change local-backup duplication is redundant
- **Where a `.git` is ABSENT** (not yet initialized on this machine), git recovery does NOT exist → a pre-change backup is REQUIRED and MUST NOT be skipped on the strength of this doc
- **Remaining untracked surface** — `~/.glass-atrium/skills/`, `~/.glass-atrium/hooks/`, `~/.glass-atrium/scripts/` (each excluding its `test/` corpus repo listed above), and the `~/.glass-atrium/` root itself (excluding `test/`) are NOT git repos → no recovery for changes confined to those paths. Rule-change recovery is covered by the rules repo where initialized; this residual surface is lower-stakes (no self-improvement core code, no rule SoT)

## Cross-References

| Reference | What it covers |
|---|---|
| `core-git-workflow.md` | commit message rules · `--no-verify` / `--no-gpg-sign` prohibition · dangerous commands procedure |
| `orchestrator-role.md` | Harness Path Protection |
| `skills/glass-atrium-ops-orchestrator.md` | Self-Improvement User-Approval Trigger (safety-only) |
| `core-learning-log.md` | Instruction Improvement Approval Tier (Tier 1 Auto + Tier 2 Safety) · CTM/EPM bucket |
| `core-security.md` | LLM06 Agent Tool Authorization · reuses the High-impact actions definition |
| monitor `/api/improvement` | SoT routes (routes/improvement.ts + types/improvement.ts + screens/improvement.jsx) |
