# Self-Improvement Pipeline Hygiene Rules (Cross-Cutting Concern)

Applies to ORCHESTRATOR scope (main session / global coordinator) + DEV agents that touch the autoagent self-improvement pipeline (`~/.glass-atrium/autoagent/daemon-apply.sh`, `daemon_cycle.py`, `daemon-cycle.sh`, related launchd plists). Loaded automatically for ORCHESTRATOR; loaded for DEV when the change scope includes any path under `~/.glass-atrium/autoagent/` or the loop's launchd configuration.

## Working Tree Hygiene Contract [ORCHESTRATOR+DEV]

- Each apply runs as a git-FREE file-copy transaction (`autoagent/lib/git-txn.sh`): a before-image copy of the single target is captured into a per-proposal `agents-bak` subdir BEFORE apply → verify failure atomically restores the target from it → 100% user-edit preservation on the target. The serial-writer assumption is enforced by the shared `.apply-lock` — both writers (daemon-apply.sh + update.sh) acquire via `scripts/lib/apply-lock.sh` (pid liveness + TTL stale-reclaim; a live holder always blocks).
- On a restore-stage failure, the before-image is preserved in `agents-bak` for user inspection — automatic resolution FORBIDDEN · manual recovery from the per-proposal before-image required. Retention prune (default 14 days, `AUTOAGENT_BACKUP_TTL_DAYS`) never removes the newest cycle subdir.
- On a multi-file cascade → meaning-unit commit obligation (aligns with `core-git-workflow.md`); the loop is trustworthy only from an accumulated dirty state. Autonomous mode (user absent): orchestrator auto-commit + per-file diff record · interactive sessions prefer manual user commit.

## Precondition Loud-Fail Principle [DEV+ORCHESTRATOR]

- Pipeline stage entry conditions (git repo exists / TCC permission / launchd active / API endpoint reachability, etc.) → silent-fail absorption patterns (`2>/dev/null` / `|| true` / `|| return 0`) FORBIDDEN
- When a precondition is unmet → named exit code (e.g., daemon-apply.sh exit 5 = "apply-lock lib missing", exit 4 = "another apply in progress") + explicit stderr message + automatic log-aggregator surface
- Exit-code semantics spec required — the wrapper script can branch on it + automatically triggers monitor dashboard alerting
- Cascade cost: on the launchd 1-day unattended cycle, a lost first-failure visibility fossilizes into a multi-day `status=pending` backlog amplified across days × N-agents — the loud-fail cost-benefit asymmetry

## Prose-Only-Add Patch Classification (DETECTION, not reject) [DEV+ORCHESTRATOR]

- A self-improvement patch is classified `prose-only-add` when `added > 0 AND removed == 0 AND no hook file touched` → emit a WARNING into the signal store; do NOT fail-closed-reject (false-blocking the learning loop is the worse failure). A conversion/subtraction patch (removes prose OR touches a hook) does NOT warn. Detector lives in `daemon_cycle.py` (DEV-owned); this record is the criteria SoT.

## Apply-Side Rollback Contract [DEV]

- `backup_capture_failed` path (`GIT_TXN_BACKUP_CAPTURE_FAIL`) → hard PRE-apply abort + emit_log — nothing was applied, so there is nothing to restore
- Verification failure after apply (`GIT_TXN_VERIFY_FAIL`) → atomic restore of the target from the `agents-bak` before-image (sibling temp + `mv -f` rename, same-FS) → keeps a user-retryable state
- In-place `cp` restore FORBIDDEN — a crash mid-copy truncates the target; only the atomic temp+rename swap is permitted
- Bats test coverage required for the apply / atomic-restore / lock-reclaim branches (`autoagent/test/git-txn-gitfree.bats`)

## Harness Git Track Status

- `~/.glass-atrium/autoagent/`, `~/.glass-atrium/rules/`, `~/.glass-atrium/agents/`, `~/.glass-atrium/monitor/` are EACH an independent git repository → change history of self-improvement core code (daemon-apply.sh / daemon_cycle.py / daemon-cycle.sh) AND of every rule file under `~/.glass-atrium/rules/` (including this document) is git-preserved — prior-version recovery via `git log` / `git restore`
- Git history is the recovery mechanism for these tracked dirs → pre-change local-backup duplication is redundant
- Remaining untracked surface — `~/.glass-atrium/skills/`, `~/.glass-atrium/hooks/`, `~/.glass-atrium/scripts/`, and the `~/.glass-atrium/` root itself are NOT git repos → no recovery for changes confined to those paths. Rule-change recovery is already covered by the rules repo; this residual surface is lower-stakes (no self-improvement core code, no rule SoT)

## Cross-References

- `core-git-workflow.md` — commit message rules · `--no-verify` / `--no-gpg-sign` prohibition · dangerous commands procedure
- `orchestrator-role.md` — Self-Improvement User-Approval Trigger (safety-only) · Harness Path Protection
- `core-learning-log.md` — Instruction Improvement Approval Tier (Tier 1 Auto + Tier 2 Safety) · CTM/EPM bucket
- `core-security.md` — LLM06 Agent Tool Authorization · reuses the High-impact actions definition
- monitor `/api/improvement` — SoT routes (routes/improvement.ts + types/improvement.ts + screens/improvement.jsx)
