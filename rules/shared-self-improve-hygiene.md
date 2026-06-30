# Self-Improvement Pipeline Hygiene Rules (Cross-Cutting Concern)

Applies to ORCHESTRATOR scope (main session / global coordinator) + DEV agents that touch the autoagent self-improvement pipeline (`~/.claude/autoagent/daemon-apply.sh`, `daemon_cycle.py`, `daemon-cycle.sh`, related launchd plists). Loaded automatically for ORCHESTRATOR; loaded for DEV when the change scope includes any path under `~/.claude/autoagent/` or the loop's launchd configuration.

## Working Tree Hygiene Contract [ORCHESTRATOR+DEV]

- On a dirty `~/.claude/agents/` tree, `daemon-apply.sh`'s stash-and-restore wrap auto-does stash → apply → restore → 100% user-edit preservation. Assumes a serial daemon (no BlockingScheduler / asyncio / parallel-for) → a single stash slot is safe.
- On stash-pop failure, preserve the stash entry for user inspection — automatic resolution FORBIDDEN · manual `git stash list` check + drop required
- On a multi-file cascade → meaning-unit commit obligation (aligns with `core-git-workflow.md`); the loop is trustworthy only from an accumulated dirty state. Autonomous mode (user absent): orchestrator auto-commit + per-file diff record · interactive sessions prefer manual user commit.

## Precondition Loud-Fail Principle [DEV+ORCHESTRATOR]

- Pipeline stage entry conditions (git repo exists / TCC permission / launchd active / API endpoint reachability, etc.) → silent-fail absorption patterns (`2>/dev/null` / `|| true` / `|| return 0`) FORBIDDEN
- When a precondition is unmet → named exit code (e.g., daemon-apply.sh exit 5 = "not a git repo") + explicit stderr message + automatic log-aggregator surface
- Exit-code semantics spec required — the wrapper script can branch on it + automatically triggers monitor dashboard alerting
- Cascade cost: on the launchd 1-day unattended cycle, a lost first-failure visibility fossilizes into a multi-day `status=pending` backlog amplified across days × N-agents — the loud-fail cost-benefit asymmetry

## Prose-Only-Add Patch Classification (DETECTION, not reject) [DEV+ORCHESTRATOR]

- A self-improvement patch is classified `prose-only-add` when `added > 0 AND removed == 0 AND no hook file touched` → emit a WARNING into the signal store; do NOT fail-closed-reject (false-blocking the learning loop is the worse failure). A conversion/subtraction patch (removes prose OR touches a hook) does NOT warn. Detector lives in `daemon_cycle.py` (DEV-owned); this record is the criteria SoT.

## Apply-Side Rollback Contract [DEV]

- `apply_commit_failed` path → run `git reset --soft HEAD~1` first, then emit_log → prevents orphan WIP commits
- Verification failure after commit → soft reset restores the staged state + preserves the working tree → keeps a user-retryable state
- hard reset FORBIDDEN — risk of losing unsaved user work (aligns with `core-git-workflow.md` dangerous commands)
- Bats test coverage required for the apply / rollback / stash-pop-conflict branches

## Harness Git Track Status

- `~/.claude/autoagent/`, `~/.claude/rules/`, `~/.claude/agents/`, `~/.claude/monitor/` are EACH an independent git repository → change history of self-improvement core code (daemon-apply.sh / daemon_cycle.py / daemon-cycle.sh) AND of every rule file under `~/.claude/rules/` (including this document) is git-preserved — prior-version recovery via `git log` / `git restore`
- Git history is the recovery mechanism for these tracked dirs → pre-change local-backup duplication is redundant
- Remaining untracked surface — `~/.claude/skills/`, `~/.claude/hooks/`, `~/.claude/scripts/`, and the `~/.claude/` root itself are NOT git repos → no recovery for changes confined to those paths. Rule-change recovery is already covered by the rules repo; this residual surface is lower-stakes (no self-improvement core code, no rule SoT)

## Cross-References

- `core-git-workflow.md` — commit message rules · `--no-verify` / `--no-gpg-sign` prohibition · dangerous commands procedure
- `orchestrator-role.md` — Self-Improvement User-Approval Trigger (safety-only) · Harness Path Protection
- `core-learning-log.md` — Instruction Improvement Approval Tier (Tier 1 Auto + Tier 2 Safety) · CTM/EPM bucket
- `core-security.md` — LLM06 Agent Tool Authorization · reuses the High-impact actions definition
- monitor `/api/improvement` — SoT routes (routes/improvement.ts + types/improvement.ts + screens/improvement.jsx)
