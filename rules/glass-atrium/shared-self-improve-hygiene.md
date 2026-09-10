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

- **Silent-fail absorption of a pipeline stage entry condition is FORBIDDEN.** Entry conditions are things like git repo exists / TCC permission / launchd active / API endpoint reachability.
- **Absorption idioms — the auditor's regex set is the SoT, not a prose list.** `scripts/audit-absorption.sh` carries it; read it there.
  - Illustrative and non-exhaustive: `|| true` · `|| :` · `|| return 0` · stderr-only suppression (`2>/dev/null`).
  - `|| exit 0` counts only inside a sourced `lib/*.sh`, where a success-exit terminates the SOURCING script; in an executed script the same shape is frequently the correct no-op-and-succeed contract.
- **An unmet precondition gets the remedy triad — all three legs, not a choice**: a named exit code · an explicit stderr message · an automatic log-aggregator surface. ("Remedy triad" elsewhere in this file means exactly these three.)
  - **The leg ORDER is a reserved anchor**: pipeline code comments cite a leg by ordinal (`Precondition Loud-Fail's third leg` = the log-aggregator surface), so the three may be reworded but never reordered.
- **Rule scope vs. audited scope**: the principle binds every pipeline stage entry condition. What an auditor mechanically checks is narrower — see `#### Enforced surface (unattended execution)`.
- **Cascade cost (the loud-fail cost-benefit asymmetry)**: on the launchd 1-day unattended cycle, a lost first-failure visibility fossilizes into a multi-day `status=pending` backlog amplified across days × N-agents.

### Exit-code discipline [DEV+ORCHESTRATOR]

- **An exit-code semantics spec is required** — the launchd wrapper (`autoagent/daemon-cycle.sh`) branches on the code, and a named non-zero automatically triggers monitor dashboard alerting.
- **Exit codes are PER-SCRIPT, never a shared table** — the same number carries unrelated meanings in different scripts, so read the script's own header `Exit codes:` block before reusing a number. The collision is live today:

  | Script | exit 4 | exit 5 |
  |---|---|---|
  | `autoagent/daemon-apply.sh` | lock contention (another apply already running) | apply-lock lib missing / source failed |
  | `autoagent/autoagents-eval.sh` | claude binary not found | git status failed on the default-mode scan |

### Absorption Taxonomy & Annotation Convention [DEV+ORCHESTRATOR]

- **Never drive the site count down as a goal.** A grep count of the absorption idioms is a population, not a defect set — the large majority of occurrences are load-bearing shell idioms or explicitly-handled failure paths, so a falling count is as likely to mean a broken script as a fixed one.
- **Classify before judging, and classify BLOCK-scoped — never line-local.** The evidence separating the three categories lives in the surrounding block, not on the matched line.
- **Category 1 — benign idiom**: the non-zero status is a normal outcome, and removing the suppression breaks the script under `set -Eeuo pipefail`. Worked shapes, each anchored by SHAPE and by function-relative description rather than by a raw line number:
  - a NUL-delimited heredoc read reaching EOF without a NUL terminator (`hooks/enforce-harness-critical.sh` loads its own classifier source this way);
  - a pattern search exiting 1 because nothing matched (`grep`/`find` — zero hits is data);
  - trap or teardown cleanup of a file that may already be gone.
- **Category 2 — explicitly handled** (the opposite of silent): the suppression covers the stderr stream only, or a redundant channel only, while the status is captured, branched on, or defaulted. Worked shapes:
  - `hooks/enforce-harness-critical.sh`'s classifier invocation, whose captured status routes a failure to the named `classifier-failure` fail-closed branch — untouchable;
  - `scripts/wiki-daily-compile.sh`'s FATAL-echo, whose suppressed log append is redundant: the next line emits the same notice unsuppressed to stderr, a status row records the error, and the block ends in a non-zero exit. Judging that line without reading its block gets it wrong.
- **Category 3 — genuine silent absorption**: no branch, no captured status, no loud channel anywhere in the block. This is the only category the principle above forbids, and it is CONVERTED, never annotated.
  - Worked shape: a reporting channel that swallows its own failure, leaving the remedy triad's third leg unfilled.

#### Enforced surface (unattended execution)

The principle's cascade-cost rationale is about failures nobody is watching, so the enforced scope is the unattended surface.

- **The scope SoT is the `SCOPE_FILES` list carried by `scripts/audit-absorption.sh`** — the enforced scope is exactly that list. Read the list itself, never a count quoted in prose.
- **In scope**: the autoagent pipeline (its declared scope, kept) · the launchd-driven `scripts/*.sh` · the `scripts/lib/*.sh` libraries those depend on.
- **EXPLICITLY DEFERRED, not forgotten** — the hooks directory and the non-daemon scripts: a synchronous pre-tool hook fails in front of an operator within seconds, which is the opposite profile.
- **Coverage extends to a deferred surface through the promotion path below** (advisory coverage first, then promote), never by re-litigating the scope decision.

#### Annotation convention

Every sanctioned suppression in the enforced scope carries an adjacent annotation.

- **Do not collapse these into one rule about line numbers**: the label, the `<where>` field, the physical placement, the reason text and the worked-shape anchoring rule above govern different objects.
- **Labels — the vocabulary is CLOSED**: `# GA-ABSORB[benign]: <reason>` — category 1 · `# GA-ABSORB[handled@<where>]: <reason>` — category 2. No third label exists: a category-3 site is converted, and a converted site carries `# GA-CONVERTED: <note>` instead.
- **`<where>` field content**: it NAMES the handling (function, sentinel, or relative location) and is never a bare line number, because line numbers drift on the next edit.
- **Placement**: an end-of-line trailing comment on the same physical line as the idiom (canonical, zero drift). Own-line-immediately-above is permitted ONLY where the trailing form is impossible:
  - the line would exceed 120 columns;
  - the site sits on a `\`-continued line;
  - a trailing comment is illegal inside a multi-line pipeline segment.
- **Placement inside a `\`-continued statement** — a rule fixing where the token goes, never a further trigger for the exception above: when the site and its predecessor are both `\`-continued, the token sits on the first physical line of the continued statement.
- **Reason text**: non-empty one-line English prose. Presence and grammar are mechanical; truthfulness is the annotator's — the same trust model the orchestration attestation tokens use.

#### Auditor

- `scripts/audit-absorption.sh` is **presence-only**: it reports unannotated sites and grammar rejects on stdout.
- **It never adjudicates a category**, because the disambiguating evidence is block-scoped and a tool confident enough to classify mislabels exactly the category-2 sites that matter most.
- **The summary carries four distinct counts** — `annotated` · `converted` · `unannotated` · `quality_reject` — so an annotation-only outcome is visibly incomplete.
- **Acceptance criteria**: `unannotated=0 quality_reject=0` on a scope run. Those two fields are the ONLY standing criteria — the `annotated=` / `converted=` totals are not criteria and are not quoted in prose (census rule below).
- **Exit contract**:

  | Code | Meaning |
  |---|---|
  | 0 | no blocking findings, or an advisory-surface run |
  | 1 | a blocking run reporting findings — an unannotated site or a grammar reject |
  | 2 | usage error, including `--advisory` and `--strict` passed together |
  | 3 | a scope-listed or `--path` file is missing or unreadable |

- **Surface split**: only the default scope-list run blocks. The DEFERRED hooks surface and any ad-hoc `--path` probe stay advisory, so the deferred path cannot red the build by accident; `--strict` extends blocking to a `--path` run, and `--advisory` reports without failing anywhere.
- **Promotion to blocking requires, verbatim**: *"coverage complete, auditor false-positive rate zero across the scope, and the conversion set landed."*

#### Promotion record

- **Promotion HAS executed for the `SCOPE_FILES`-listed enforced scope**: the verbatim condition above was met, so a scope run BLOCKS today — the exit contract and surface split under `#### Auditor` are in force, not aspirational.
- **Census rule**: the `annotated=` / `converted=` totals are deliberately NOT quoted in prose. They track whatever the scope currently holds and move with any later dedup or scope addition, so read them from an actual `scripts/audit-absorption.sh` run — a hand-copied census re-drifts on the next edit exactly as a hand-copied file count does.
- **CI**: a blocking auditor step runs on the `scripts/test` leg of the `test-bash` matrix, ordered BEFORE the bats step — a step-level `if:` defaults to `success()`, so an appended step would skip exactly when the leg is already red.
  - RESIDUAL, stated not overstated: `test-bash` is gated on the `detect-changes` bash filter, so a PR touching no shell file skips the auditor. The scope is shell-only, so no non-shell change can introduce a site, but the gate is change-conditional rather than unconditional.
- **Rollback**: the promotion is a revertable meaning-unit set (exit semantics + usage line + CI step + this record). Reverting it — or passing `--advisory` in CI — restores advisory mode with the verbatim condition text above intact.

## Prose-Only-Add Patch Classification (DETECTION, not reject) [DEV+ORCHESTRATOR]

| Patch shape | Verdict |
|---|---|
| `added > 0` AND `removed == 0` AND no hook file touched | `prose-only-add` → emit a WARNING into the signal store |
| removes prose OR touches a hook (a conversion/subtraction patch) | no warning |

- **Never fail-closed-reject on a match** — false-blocking the learning loop is the worse failure.
- **Ownership**: the detector lives in `daemon_cycle.py` (DEV-owned); this record is the criteria SoT.

## Apply-Side Rollback Contract [DEV]

| Failure point | Contract |
|---|---|
| `backup_capture_failed` (`GIT_TXN_BACKUP_CAPTURE_FAIL`) | hard PRE-apply abort + emit_log — nothing was applied, so there is nothing to restore |
| verification failure after apply (`GIT_TXN_VERIFY_FAIL`) | atomic restore of the target from the `agents-bak` before-image (sibling temp + `mv -f` rename, same-FS) → keeps a user-retryable state |

- **In-place `cp` restore FORBIDDEN** — a crash mid-copy truncates the target; only the atomic temp+rename swap is permitted.
- **Bats coverage required** for the apply / atomic-restore / lock-reclaim branches (`autoagent/test/git-txn-gitfree.bats` — bundled into the live install per the release manifest).

## Harness Git Track Status

Each path below is designed to be its own independent git repository — one repository per path, not one repository covering the group:

| Independent repository, one per path | Initialized by |
|---|---|
| `~/.glass-atrium/autoagent/` · `~/.glass-atrium/rules/` · `~/.glass-atrium/agents/` · `~/.glass-atrium/monitor/` | the audit/install operation |
| the test corpora — `~/.glass-atrium/test/` · `~/.glass-atrium/hooks/test/` · `~/.glass-atrium/scripts/test/` | `scripts/init-test-repos.sh` (idempotent) |

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
