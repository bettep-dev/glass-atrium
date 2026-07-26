# Self-Improvement Pipeline Hygiene Rules (Cross-Cutting Concern)

Applies to ORCHESTRATOR scope (main session / global coordinator) + DEV agents that touch the autoagent self-improvement pipeline (`~/.glass-atrium/autoagent/daemon-apply.sh`, `daemon_cycle.py`, `daemon-cycle.sh`, related launchd plists). Loaded automatically for ORCHESTRATOR; loaded for DEV when the change scope includes any path under `~/.glass-atrium/autoagent/` or the loop's launchd configuration.

## Working Tree Hygiene Contract [ORCHESTRATOR+DEV]

- Each apply runs as a git-FREE file-copy transaction (`autoagent/lib/git-txn.sh`): a before-image copy of the single target is captured into a per-proposal `agents-bak` subdir BEFORE apply → verify failure atomically restores the target from it → 100% user-edit preservation on the target. The serial-writer assumption is enforced by the shared `.apply-lock` — both writers (daemon-apply.sh + update.sh) acquire via `scripts/lib/apply-lock.sh` (pid liveness + TTL stale-reclaim; a live holder always blocks).
- On a restore-stage failure, the before-image is preserved in `agents-bak` for user inspection — automatic resolution FORBIDDEN · manual recovery from the per-proposal before-image required. Retention prune (default 14 days, `AUTOAGENT_BACKUP_TTL_DAYS`) never removes the newest cycle subdir.
- On a multi-file cascade → meaning-unit commit obligation (aligns with `core-git-workflow.md`); the loop is trustworthy only from an accumulated dirty state. Autonomous mode (user absent): orchestrator auto-commit + per-file diff record · interactive sessions prefer manual user commit.

## Precondition Loud-Fail Principle [DEV+ORCHESTRATOR]

- Pipeline stage entry conditions (git repo exists / TCC permission / launchd active / API endpoint reachability, etc.) → silent-fail absorption patterns (`2>/dev/null` / `|| true` / `|| return 0`) FORBIDDEN
- When a precondition is unmet → named exit code (e.g., daemon-apply.sh exit 5 = "apply-lock lib missing", exit 4 = "another apply in progress") + explicit stderr message + automatic log-aggregator surface
- Exit codes are PER-SCRIPT, never a shared table — autoagents-eval.sh exit 5 = "git status failed on the default-mode scan" (its exit 4 = "claude binary not found"), which is unrelated to daemon-apply.sh's 4/5 above; read each script's own header Modes block before reusing a number
- Exit-code semantics spec required — the wrapper script can branch on it + automatically triggers monitor dashboard alerting
- Cascade cost: on the launchd 1-day unattended cycle, a lost first-failure visibility fossilizes into a multi-day `status=pending` backlog amplified across days × N-agents — the loud-fail cost-benefit asymmetry

### Absorption Taxonomy & Annotation Convention [DEV+ORCHESTRATOR]

A grep count of the absorption idioms is a POPULATION, not a defect set: the large majority of occurrences are load-bearing shell idioms or explicitly-handled failure paths, and driving the count down is the failure mode, not the fix. Classify before judging, and classify BLOCK-scoped — never line-local.

- **Category 1 — benign idiom** (the non-zero status is a normal outcome; removing the suppression breaks the script under `set -Eeuo pipefail`): a NUL-delimited heredoc read reaching EOF without a NUL terminator (the critical hook loads its own classifier source this way); a pattern search exiting 1 because nothing matched (`grep`/`find` — zero hits is data); trap or teardown cleanup of a file that may already be gone. Anchor these by SHAPE and by function-relative description, never by a raw line number.
- **Category 2 — explicitly handled** (the opposite of silent): the suppression covers the stderr stream only, or a redundant channel only, while the status is captured, branched on, or defaulted. Worked shapes: the critical hook's classifier invocation whose captured status routes a failure to a named fail-closed block (the PR #88 contract — untouchable); the wiki-compile FATAL-echo whose suppressed log append is redundant because the very next line emits the same notice unsuppressed to stderr, a status row records the error, and the block ends in a non-zero exit. Judging that line without reading its block gets it wrong.
- **Category 3 — genuine silent absorption** (no branch, no captured status, no loud channel anywhere in the block): the only category the principle above forbids. It is CONVERTED, never annotated — the located family is the daemon-run reporting channel, which absorbed the third leg of the very remedy triad this rule mandates.

**Enforced surface (unattended execution).** The principle's cascade-cost rationale is about failures nobody is watching, so the enforced scope is the autoagent pipeline (its declared scope, kept) plus the launchd-driven `scripts/*.sh` plus the `scripts/lib/*.sh` libraries those depend on — the 17-file list carried by the auditor. The hooks directory and the non-daemon scripts are EXPLICITLY DEFERRED, not forgotten: a synchronous pre-tool hook fails in front of an operator within seconds, which is the opposite profile. Coverage extends to them by the promotion path below (advisory coverage first, then promote), never by re-litigating the scope decision.

**Annotation convention.** Every sanctioned suppression in the enforced scope carries an adjacent annotation:

- `# GA-ABSORB[benign]: <reason>` — category 1 · `# GA-ABSORB[handled@<where>]: <reason>` — category 2, where `<where>` NAMES the handling (function, sentinel, or relative location) and is never a bare line number, because line numbers drift on the next edit.
- The vocabulary is CLOSED at two labels. No third label exists: a category-3 site is converted, and a converted site carries `# GA-CONVERTED: <note>` instead.
- Placement is an end-of-line trailing comment on the same physical line as the idiom (canonical, zero drift). Own-line-immediately-above is permitted ONLY when the trailing form is forced out — the line would exceed 120 columns, the site sits on a `\`-continued line, or a trailing comment is illegal inside a multi-line pipeline segment. When the site and its predecessor are both `\`-continued, the token sits on the first physical line of the continued statement.
- The reason is non-empty one-line English prose. Presence and grammar are mechanical; truthfulness is the annotator's — the same trust model the orchestration attestation tokens use.

**Auditor.** `scripts/audit-absorption.sh` — presence-only, ADVISORY: it reports unannotated sites and grammar rejects on stdout and still exits 0 (exit 2 = usage error, exit 3 = a scope-listed file missing or unreadable). It never adjudicates a category, because the disambiguating evidence is block-scoped and a tool confident enough to classify mislabels exactly the category-2 sites that matter most. Annotation and conversion counts are reported as DISTINCT fields, so an annotation-only outcome is visibly incomplete. Promotion to blocking requires, verbatim: *"coverage complete, auditor false-positive rate zero across the scope, and the conversion set landed."*

## Prose-Only-Add Patch Classification (DETECTION, not reject) [DEV+ORCHESTRATOR]

- A self-improvement patch is classified `prose-only-add` when `added > 0 AND removed == 0 AND no hook file touched` → emit a WARNING into the signal store; do NOT fail-closed-reject (false-blocking the learning loop is the worse failure). A conversion/subtraction patch (removes prose OR touches a hook) does NOT warn. Detector lives in `daemon_cycle.py` (DEV-owned); this record is the criteria SoT.

## Apply-Side Rollback Contract [DEV]

- `backup_capture_failed` path (`GIT_TXN_BACKUP_CAPTURE_FAIL`) → hard PRE-apply abort + emit_log — nothing was applied, so there is nothing to restore
- Verification failure after apply (`GIT_TXN_VERIFY_FAIL`) → atomic restore of the target from the `agents-bak` before-image (sibling temp + `mv -f` rename, same-FS) → keeps a user-retryable state
- In-place `cp` restore FORBIDDEN — a crash mid-copy truncates the target; only the atomic temp+rename swap is permitted
- Bats test coverage required for the apply / atomic-restore / lock-reclaim branches (`autoagent/test/git-txn-gitfree.bats` — bundled into the live install per the release manifest)

## Harness Git Track Status

- `~/.glass-atrium/autoagent/`, `~/.glass-atrium/rules/`, `~/.glass-atrium/agents/`, `~/.glass-atrium/monitor/` are DESIGNED to each be an independent git repository, initialized by the audit/install operation; the three test corpora — `~/.glass-atrium/test/`, `~/.glass-atrium/hooks/test/`, `~/.glass-atrium/scripts/test/` — are likewise independent per-dir git repositories, initialized by `scripts/init-test-repos.sh` (idempotent) → once initialized, change history of self-improvement core code (daemon-apply.sh / daemon_cycle.py / daemon-cycle.sh) AND of every rule file under `~/.glass-atrium/rules/` (including this document) is git-preserved — prior-version recovery via `git log` / `git restore`
- Where a dir HAS been git-initialized, git history is its recovery mechanism → pre-change local-backup duplication is redundant. Where a `.git` is ABSENT (not yet initialized on this machine), git recovery does NOT exist → a pre-change backup is REQUIRED and MUST NOT be skipped on the strength of this doc
- Remaining untracked surface — `~/.glass-atrium/skills/`, `~/.glass-atrium/hooks/`, `~/.glass-atrium/scripts/` (each excluding its `test/` corpus repo above), and the `~/.glass-atrium/` root itself (excluding `test/`) are NOT git repos → no recovery for changes confined to those paths. Rule-change recovery is covered by the rules repo where initialized; this residual surface is lower-stakes (no self-improvement core code, no rule SoT)

## Cross-References

- `core-git-workflow.md` — commit message rules · `--no-verify` / `--no-gpg-sign` prohibition · dangerous commands procedure
- `orchestrator-role.md` — Self-Improvement User-Approval Trigger (safety-only) · Harness Path Protection
- `core-learning-log.md` — Instruction Improvement Approval Tier (Tier 1 Auto + Tier 2 Safety) · CTM/EPM bucket
- `core-security.md` — LLM06 Agent Tool Authorization · reuses the High-impact actions definition
- monitor `/api/improvement` — SoT routes (routes/improvement.ts + types/improvement.ts + screens/improvement.jsx)
