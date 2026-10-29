---
paths:
  - "**/autoagent/**/*"
  - "**/scripts/*.sh"
  - "**/scripts/lib/*.sh"
  - "**/com.glass-atrium.*.plist"
  - "**/.glass-atrium/**/*"
  - "**/scripts/agent_lifecycle/**/*.py"
  - "**/hooks/validate-compliance-matrix.sh"
  - "**/lib/ga-launchd.sh"
---
<!-- MAINTAINER: code comments cite this file's headings, its remedy-triad leg order and its annotation literals;
     read scoped/maintainers/shared-self-improve-hygiene.md before renaming or reordering any of them. -->
# Self-Improvement Pipeline Hygiene Rules (Cross-Cutting Concern)

Applies to two audiences, both loaded on a Read whose path matches the `paths:` globs above — glob base and honest backing: `rules/glass-atrium/core-compliance-matrix.md` → `### Membership vs. Delivery (per tier)` → **Path-scoped delivery**.

- **ORCHESTRATOR scope** (main session / global coordinator).
- **DEV agents whose change scope includes** `autoagent/` paths, the self-improvement launchd configuration, the agent-lifecycle Python package (`scripts/agent_lifecycle/`), the compliance-matrix validator hook (`hooks/validate-compliance-matrix.sh`) or the launchd library (`lib/ga-launchd.sh`).

## Working Tree Hygiene Contract [ORCHESTRATOR+DEV]

- **Each apply runs as a git-FREE file-copy transaction** (`autoagent/lib/git-txn.sh`): a before-image of the single target is captured into a per-proposal `agents-bak` subdir before apply, so a failed apply never loses a user edit to the target.
  - Failure handling: `## Apply-Side Rollback Contract`.
- **The serial-writer assumption is enforced by the shared `.apply-lock`** — both writers (daemon-apply.sh + update.sh) acquire it via `scripts/lib/apply-lock.sh` (pid liveness + TTL stale-reclaim; a live holder always blocks).
- **On a restore-stage failure**, the before-image stays in `agents-bak`: recover by hand from it — automatic resolution FORBIDDEN.
- **Backup retention**: the retention prune (default 14 days, `AUTOAGENT_BACKUP_TTL_DAYS`) never removes the newest cycle subdir.
- **On a multi-file cascade** → one commit per meaning unit, so no dirty state accumulates under the loop.
  - Who authors it: `core-git-workflow.md` → `### Worktree occupancy` → **Who commits**; in an interactive session, prefer a manual user commit.

## Precondition Loud-Fail Principle [DEV+ORCHESTRATOR]

- **Silent-fail absorption of a pipeline stage entry condition is FORBIDDEN** — entry conditions such as git repo exists, TCC permission, launchd active, API endpoint reachable.
  - **Cascade cost** (why): on the launchd 1-day unattended cycle, a lost first failure fossilizes into a multi-day `status=pending` backlog, multiplied across agents.
- **Absorption idioms — the auditor's regex set is the SoT, not a prose list.** `scripts/audit-absorption.sh` carries it; read it there.
  - Illustrative and non-exhaustive: `|| true` · `|| :` · `|| return 0` · stderr-only suppression (`2>/dev/null`).
  - `|| exit 0` counts only inside a sourced `lib/*.sh`, where a success-exit terminates the sourcing script; in an executed script the same shape is often the correct no-op-and-succeed contract.
- **An unmet precondition gets the remedy triad — all three legs, not a choice**: a named exit code · an explicit stderr message · an automatic log-aggregator surface.
  - **The leg order is a reserved anchor**: pipeline code comments cite a leg by ordinal (`Precondition Loud-Fail's third leg` = the log-aggregator surface), so the three may be reworded but never reordered.
- **Rule scope vs. audited scope**: the principle binds every pipeline stage entry condition; the auditor checks only `### Enforced surface (unattended execution)`.

### Exit-code discipline [DEV+ORCHESTRATOR]

- **An exit-code semantics spec is required** — the launchd wrapper (`autoagent/daemon-cycle.sh`) branches on the code, and a named non-zero triggers monitor dashboard alerting.
- **Exit codes are per-script, never a shared table**: read the script's own header `Exit codes:` block before reusing a number — the same number already carries unrelated meanings:

  | Script | exit 4 | exit 5 |
  |---|---|---|
  | `autoagent/daemon-apply.sh` | lock contention (another apply already running) | apply-lock lib missing / source failed |
  | `autoagent/autoagents-eval.sh` | claude binary not found | git status failed on the default-mode scan |

### Absorption Taxonomy & Annotation Convention [DEV+ORCHESTRATOR]

- **Never drive the site count down as a goal**: a grep count of the absorption idioms is a population, not a defect set — most hits are load-bearing idioms or handled failure paths, so a falling count can mean a broken script as easily as a fixed one.
- **Classify before judging, and classify block-scoped — never line-local**: the evidence separating the three categories lives in the surrounding block, not on the matched line.
- **Category 1 — benign idiom**: the non-zero status is a normal outcome, and removing the suppression breaks the script under `set -Eeuo pipefail`. Worked shapes:
  - a NUL-delimited heredoc read reaching EOF without a NUL terminator (`hooks/enforce-harness-critical.sh` loads its own classifier source this way);
  - a pattern search exiting 1 because nothing matched (`grep`/`find` — zero hits is data);
  - trap or teardown cleanup of a file that may already be gone.
- **Category 2 — explicitly handled**: the suppression covers only the stderr stream or a redundant channel, while the status is captured, branched on, or defaulted. Worked shapes:
  - `hooks/enforce-harness-critical.sh`'s classifier invocation, whose captured status routes a failure to the named `classifier-failure` fail-closed branch — untouchable;
  - `scripts/wiki-daily-compile.sh`'s FATAL-echo: its suppressed log append is redundant, because the next line emits the same notice unsuppressed to stderr, a status row records the error, and the block ends in a non-zero exit.
- **Category 3 — genuine silent absorption**: no branch, no captured status, no loud channel anywhere in the block — the only category the principle forbids, and it is converted, never annotated.
  - Worked shape: a reporting channel that swallows its own failure, leaving the remedy triad's third leg unfilled.

### Enforced surface (unattended execution)

- **The scope SoT is the `SCOPE_FILES` list carried by `scripts/audit-absorption.sh`**: the enforced scope is exactly that list — read the list itself, never a count quoted in prose.
  - Why the unattended surface: the cascade cost falls on failures nobody is watching.
- **In scope**: the autoagent pipeline · the launchd-driven `scripts/*.sh` · the `scripts/lib/*.sh` libraries those depend on.
- **Explicitly deferred, not forgotten** — the hooks directory and the non-daemon scripts: a synchronous pre-tool hook fails in front of an operator within seconds, the opposite profile.
- **Coverage extends to a deferred surface only through the promotion condition** (`### Auditor`): advisory coverage first, then promote — never by re-litigating the scope decision.

### Annotation convention

Every sanctioned suppression in the enforced scope carries an adjacent annotation.

- **Labels — the vocabulary is closed**: `# GA-ABSORB[benign]: <reason>` — category 1 · `# GA-ABSORB[handled@<where>]: <reason>` — category 2.
  - No third label exists: a category-3 site is converted, and a converted site carries `# GA-CONVERTED: <note>` instead.
- **`<where>` field content**: it names the handling (function, sentinel, or relative location), never a bare line number — line numbers drift on the next edit.
- **Placement**: an end-of-line trailing comment on the same physical line as the idiom (canonical, zero drift). Own-line-immediately-above is permitted only where the trailing form is impossible:
  - the line would exceed 120 columns;
  - the site sits on a `\`-continued line;
  - a trailing comment is illegal inside a multi-line pipeline segment.
- **Placement inside a `\`-continued statement** — where the token goes, never a further trigger for the exception above: when the site and its predecessor are both `\`-continued, the token sits on the first physical line of the continued statement.
- **Reason text**: non-empty one-line English prose; the auditor checks presence and grammar, and truthfulness is the annotator's.

### Auditor

- `scripts/audit-absorption.sh` is **presence-only**: it reports unannotated sites and grammar rejects on stdout.
- **It never adjudicates a category**: the disambiguating evidence is block-scoped, and a tool confident enough to classify mislabels exactly the category-2 sites that matter most.
- **The summary carries four distinct counts** — `annotated` · `converted` · `unannotated` · `quality_reject` — so an annotation-only outcome is visibly incomplete.
- **Acceptance criteria**: `unannotated=0 quality_reject=0` on a scope run — the only standing criteria.
- **Census rule**: never quote the `annotated=` / `converted=` totals in prose — they move with every dedup or scope addition, so read them from an actual run; a hand-copied census re-drifts on the next edit.
- **Surface split**: the default scope-list run blocks, its promotion condition below having been met; the deferred hooks surface and any ad-hoc `--path` probe stay advisory, so the deferred path cannot red the build by accident.
  - `--strict` extends blocking to a `--path` run; `--advisory` reports without failing anywhere.
- **Promotion to blocking requires, verbatim**: *"coverage complete, auditor false-positive rate zero across the scope, and the conversion set landed."*

## Prose-Only-Add Patch Classification (DETECTION, not reject) [DEV+ORCHESTRATOR]

| Patch shape | Verdict |
|---|---|
| `added > 0` AND `removed == 0` AND no hook file touched | `prose-only-add` → emit a WARNING into the signal store |
| removes prose OR touches a hook (a conversion/subtraction patch) | no warning |

- **Never fail-closed-reject on a match** — false-blocking the learning loop is the worse failure.
- **Ownership**: the detector lives in `daemon_cycle.py` (DEV-owned); this table is the criteria SoT.

## Apply-Side Rollback Contract [DEV]

| Failure point | Contract |
|---|---|
| `backup_capture_failed` (`GIT_TXN_BACKUP_CAPTURE_FAIL`) | hard pre-apply abort + emit_log — nothing was applied, so there is nothing to restore |
| verification failure after apply (`GIT_TXN_VERIFY_FAIL`) | atomic restore from the `agents-bak` before-image (sibling temp + `mv -f` rename, same-FS) → a user-retryable state |

- **In-place `cp` restore FORBIDDEN** — a crash mid-copy truncates the target; only the atomic temp+rename swap is permitted.
- **Bats coverage required** for the apply / atomic-restore / lock-reclaim branches (`autoagent/test/git-txn-gitfree.bats`).

## Harness Git Track Status

| Independent repository, one per path | Initialized by |
|---|---|
| `~/.glass-atrium/autoagent/` · `~/.glass-atrium/rules/` · `~/.glass-atrium/agents/` · `~/.glass-atrium/monitor/` | the audit/install operation |
| the test corpora — `~/.glass-atrium/test/` · `~/.glass-atrium/hooks/test/` · `~/.glass-atrium/scripts/test/` | `scripts/init-test-repos.sh` (idempotent) |

| Path state | Recovery | Pre-change backup |
|---|---|---|
| git-initialized | `git log` / `git restore` | redundant |
| `.git` absent on this machine | none | REQUIRED; MUST NOT be skipped on the strength of this doc |
| untracked: `~/.glass-atrium/skills/`, `hooks/` and `scripts/` (minus their `test/` repos), the root's own files | none | not prescribed — lower stakes |

- Git-initialized coverage: the self-improvement core code (daemon-apply.sh / daemon_cycle.py / daemon-cycle.sh) and every rule file under `~/.glass-atrium/rules/`, this one included.
- Why the untracked surface is lower-stakes: it holds no self-improvement core code and no rule SoT.

## Cross-References

- Monitor surface for the loop's records: `/api/improvement` — `monitor/src/server/routes/improvement.ts` · `monitor/src/server/types/improvement.ts` · `monitor/public/src/screens/improvement.jsx`.
