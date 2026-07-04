---
name: glass-atrium-ops-verify-arch
description: On-demand audit-and-fix for the Atrium architecture diagrams (diagrams-source.ts) against the live filesystem. Runs the deterministic computeArchDrift() count, adds LLM semantic-completeness checks the machine cannot do (orphan nodes, prose-vs-behavior mismatch, new agent missing from the team graph, broken cross-refs), and emits an actionable fix report; then, on a deliberate human invocation, immediately APPLIES the fixes via a foreground glass-atrium-dev-node delegation (count writes to arch-invariants.ts, semantic edits to diagrams-source.ts, build-gated launchctl restart, re-verify). Use this before a release, when the monitor's "최신화 필요" drift badge appears, or after adding/removing an agent/hook/rule/launchd job/skill. Pass --dry-run to report only, applying nothing. Excludes runtime daemon-health checks; apply happens only on human invocation, only via foreground glass-atrium-dev-node delegation, never silently or from a daemon.
---

## Overview

The Atrium system diagrams live in a single source of truth — `~/.glass-atrium/monitor/src/server/architecture/diagrams-source.ts` (7 v2 Mermaid diagrams). Their quantitative invariants (agent count, per-event hook wiring, launchd jobs, rule/scoped/skill counts) are extracted into `arch-invariants.ts` (`ARCH_INVARIANTS`). This skill audits the diagrams against reality in two complementary layers:

- **Machine layer** — calls `computeArchDrift()` for a deterministic count diff. Catches count-movement drift only.
- **Semantic layer** — LLM checks the machine cannot do: orphan nodes, diagram-prose vs actual-behavior mismatch, a new agent missing from the team-orchestration graph, broken cross-references, and a per-node "does this have a real counterpart?" pass. Catches count-invariant drift (e.g. an agent's role changed but the count stayed 23).

These two layers are complementary, not redundant — the machine layer is the L1 badge's logic; this skill is the L2 deep on-demand action. The audit output is a single actionable fix report. On a deliberate human invocation (no `--dry-run`), the skill then runs **Stage 4 — Apply**: it delegates the count/semantic edits, a gated build, and a restart to a foreground `glass-atrium-dev-node` agent, then re-verifies that the drift cleared. Apply is the default on invocation; `--dry-run` keeps the legacy report-only behavior. The human invocation itself is the approval gate — apply never runs from a daemon and the main session never edits the files directly.

## Scope — Atrium system only (binding invariant)

Every count and every node in this audit refers to **Atrium-system assets defined under `~/.glass-atrium/`** — never `~/.claude/` user pollution.

- `~/.claude/` is the runtime harness. It hosts Atrium assets but also hosts user pollution: enabled third-party plugins, user MCP (`~/.mcp.json`), and plugin-provided MCP servers. **None of these are Atrium assets — never count them.**
- Reading a `~/.claude/` file (e.g. hook wiring merges into `~/.claude/settings.json`) is NOT a license to count the pollution inside it. `computeArchDrift()` already applies the Atrium-ownership filter; the semantic layer MUST apply the same boundary.
- **MCP is out of scope.** Atrium defines zero MCP servers; every configured MCP server is user pollution. Do not flag a "missing MCP node" — there is no Atrium MCP to diagram.
- **Skills** = `~/.glass-atrium/skills/*/` directories only. Plugin skill namespaces (`vercel:*`, `figma:*`, `telegram:*`, `commit-commands:*`, etc.) belong to plugin directories — exclude them.

## When to Use

- Before a release (the "한 번 철저히" pre-release deep gate).
- When the monitor architecture screen shows the `최신화 필요` drift badge or the top alert banner.
- After adding or removing an agent, hook, rule, scoped file, launchd job, or skill.
- After editing diagram prose so node labels may no longer match actual behavior.

**Exclusions**: runtime daemon-health staleness (the `LiveStrip` daemon-down signal is a separate runtime concern, not diagram drift) · MCP inventory · the path-A daemon auto-proposal flow (this skill is path-B human invocation only — a daemon NEVER triggers an apply).

**Apply boundary**: the main session is Write/Edit-blocked on `~/.glass-atrium/` (enforce-delegation + Harness Path Protection), so Stage 4 never edits in-session — it delegates every edit, the build, and the restart to a **foreground** `glass-atrium-dev-node` agent. The one-command UX is preserved; the edit is internal to the delegation.

## Core Process

Run the stages in order — each builds on the previous. Do not skip the machine stage; the semantic stage assumes the count diff is already known. Stages 1–3 are the audit (always run); **Stage 4 — Apply** runs only on a human invocation without `--dry-run`.

> **Mode**: default (no `--dry-run`) = audit **then apply**. `--dry-run` (or `report-only`) = audit only, emit the Stage 3 report and exit, touching no file. The mode branch is the very first thing Stage 4 evaluates (see Stage 4 step 1).

### Stage 1 — Machine count (deterministic)

Call the shared core `computeArchDrift(log)` from `~/.glass-atrium/monitor/src/server/architecture/compute-arch-drift.ts`. This is the single SoT for drift counting — never re-implement the count logic in this skill.

The path of least friction is the already-wired live route, which calls `computeArchDrift()` and returns its result in the response:

```bash
curl -sf http://127.0.0.1:7842/api/architecture/live | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps({'stale': d.get('stale'), 'diffs': d.get('diffs', [])}, ensure_ascii=False, indent=2))"
```

If the monitor is not running, invoke the function directly via the monitor's tsx runtime (the same module the route imports) rather than counting files by hand — hand-counting risks diverging from the Atrium-ownership filter.

The result shape is `ArchDriftResult`:

```ts
{ stale: boolean, diffs: ArchDiff[] }            // ArchDiff = { key: string, claimed: number, actual: number }
```

- `key` is a dot-notation invariant key: `agents`, `launchd`, `rules`, `scoped`, `scopedScope`, `scopedShared`, `skills`, `uniqueHookBasename`, or `hooks.<Event>` (e.g. `hooks.PreToolUse`).
- `claimed` = the value `ARCH_INVARIANTS` asserts (what the diagram says). `actual` = the live Atrium-scoped filesystem count.
- `stale === true` means at least one count drifted. Each `diff` is one drifted invariant.

**Hook-count semantics (do not re-derive)**: the hook count is "Atrium-owned hook-COMMAND per settings.json event" — flattened command count, not matcher-entry count, filtered to commands whose resolved path is under `~/.glass-atrium/hooks/` or its per-file symlink mirror `~/.claude/hooks/`. This is the SoT defined in `arch-invariants.ts`; report `hooks.*` diffs verbatim from `computeArchDrift()`.

### Stage 2 — Semantic completeness (LLM, count-invariant drift)

The machine stage cannot see meaning. Read `diagrams-source.ts` (7 diagrams — slugs `v2-overview-entry`, `v2-overview-data`, `v2-hooks`, `v2-loops-learn`, `v2-loops-autoagent`, `v2-team-orchestration`, `v2-team-docs`) and run these checks. Apply the Atrium-scope boundary above to every check.

- **Orphan nodes** — a diagram node (agent, hook, loop, file) with no real Atrium counterpart on disk. Cross-check each labeled node against `~/.glass-atrium/{agents,hooks,rules,scoped,skills}/` and `~/Library/LaunchAgents/com.glass-atrium.*`. A node naming a since-removed asset is an orphan.
- **Prose ↔ behavior mismatch** — a node label or `description` sentence that describes behavior the system no longer performs (e.g. "summarize every 3 tool calls" scaffolding the model self-updates instead, a renamed route, a relocated gate). Flag the specific diagram slug + the stale sentence.
- **New agent missing from the team graph** — for each `~/.glass-atrium/agents/*.md` (excluding `GLASS_ATRIUM_GLOBAL_RULES.md`), confirm it appears in the team-pipeline diagrams (`v2-team-orchestration` / `v2-team-docs`) where a delegatable role belongs. A new agent absent from the team graph is a count-invariant miss the badge cannot catch when the total is unchanged.
- **Broken cross-refs** — a diagram referencing a file path, route, rule name, or skill that no longer resolves. Verify each referenced path/route exists.
- **Per-node real-counterpart pass** — walk every node of all 7 diagrams once and answer "does this have a real counterpart in the current Atrium system?" Record each node verdict so the report is auditable.

### Stage 3 — Missing-list fix report

Emit one actionable report combining both layers. Format:

```
ARCH-VERIFY: [SYNCED | DRIFTED]

Machine (computeArchDrift):
  stale: <true|false>
  <key>: claimed <N> -> actual <M>          # one line per diff; "(no count drift)" if diffs empty

Semantic:
  [orphan]      <diagram-slug> :: <node> — no Atrium counterpart
  [prose↔behav] <diagram-slug> :: "<stale sentence>" — actual: <what the system does now>
  [missing]     <agent-name> — not in team graph (expected in v2-team-orchestration)
  [xref]        <diagram-slug> :: <broken path/route/rule>
  # "(no semantic drift)" if none

Fix list (actionable):
  - <file:invariant or diagram slug> — <exact change to make>   # e.g. arch-invariants.ts agents: 23 -> 24
```

- Every machine diff maps to a concrete `arch-invariants.ts` update (`claimed -> actual`).
- Every semantic finding maps to a concrete `diagrams-source.ts` node/prose edit, naming the diagram slug.
- In `--dry-run` mode the report is the final output — no edit follows. In default mode the report is the input spec for Stage 4.

### Stage 4 — Apply (default on human invocation; skipped under `--dry-run`)

Stage 4 turns the Stage 3 report into edits, a build, and a restart, then re-verifies. The main session cannot write under `~/.glass-atrium/` (enforce-delegation + Harness Path Protection), so all edits/build/restart are delegated to a **foreground** `glass-atrium-dev-node` agent — never edited in-session, never backgrounded, never daemon-triggered. Run the steps in this fixed order:

**1. Mode branch (R6 — `--dry-run` short-circuits first).** Before anything else, including the no-op guard in step 2: if the invocation carries `--dry-run` (or `report-only`), emit the Stage 3 report and **exit immediately** — zero edit, zero build, zero kickstart. This ordering is fixed so that even in a future `stale:false` state, `--dry-run` is deterministically report-only.

**2. Nothing-to-apply guard.** (Reached only when NOT `--dry-run`.) If `stale:false` AND semantic findings are empty → print "already SYNCED, nothing to apply" and exit.

**3. Pre-apply dirty-check (R3).** Before delegating any edit, check whether the two target SoT files already carry uncommitted changes:

```bash
git -C ~/.glass-atrium status --porcelain monitor/src/server/architecture/arch-invariants.ts monitor/src/server/architecture/diagrams-source.ts
```

If either file is already dirty, snapshot its PRE-RUN state (so rollback restores the pre-run state, not HEAD) and warn the user — user edits are preserved 100%. The unrelated `manifest.json` dirty case needs no snapshot here; the path-scoped rollback in step 6 already protects it.

**4. Assemble the glass-atrium-dev-node delegation package.** The main session composes (does not execute) the edit spec:
- **COUNT spec** — for each `computeArchDrift()` diff, set `ARCH_INVARIANTS[<key>] = <actual>` in `arch-invariants.ts`. A `hooks.<Event>` dot-notation key targets the nested object field (`ARCH_INVARIANTS.hooks.<Event>`). The diffs ARE the fix spec — mechanical, exact.
- **CONTENT spec** — translate each Stage-2 semantic finding into a diagram slug + the stale sentence/label + the replacement text, at the anchored locations from the fix report. This is an LLM-judgment edit.
- **stale-gating boundary (R5)** — `compute-arch-drift.ts` does NOT import `diagrams-source.ts`, so CONTENT (prose / node-label / xref) edits do NOT affect the `stale` flag. `stale:false` is gated **solely on the COUNT fix to `arch-invariants.ts`**; the CONTENT replacements are verified independently by grep, not by re-running drift.
- **Constraints to pass through** — Changelog ban (no Wave/CID/date comment added to either file) · current-state-only invariants. Carry these verbatim into the delegation.

**5. Foreground delegation → `glass-atrium-dev-node`** (`~/.glass-atrium/` is harness-adjacent → background FORBIDDEN). The agent performs, in order:
- a. apply the COUNT assignments in `arch-invariants.ts`
- b. apply the CONTENT edits in `diagrams-source.ts`
- c. build — `cd ~/.glass-atrium/monitor && npm run build` (chain = `tsc && build:assets && build:client`)
- d. **build gate (R7)** — run `launchctl kickstart -k gui/$(id -u)/com.glass-atrium.monitor` **only if `npm run build` exited 0** (explicit `&&` or `$?` check). If any chain stage is non-zero, abort BEFORE kickstart and branch to step 6 rollback.

**6. Rollback branch (R1 + R2 — on build failure).** When `npm run build` fails:
- Path-scoped restore from the parent repo (`~/.glass-atrium/monitor/` is NOT a sub-repo — the parent repo tracks both `.ts` files; `dist/` is gitignored):

  ```bash
  git -C ~/.glass-atrium restore monitor/src/server/architecture/arch-invariants.ts monitor/src/server/architecture/diagrams-source.ts
  ```

  Unscoped `git restore .` / `git checkout .` is FORBIDDEN — it would clobber the unrelated dirty `manifest.json`.
- If step 3 found a PRE-RUN dirty file, restore it to the **snapshot** state, not HEAD.
- **kickstart never fired** — the failed-build path does not reach step 5d, so the daemon keeps serving the pre-edit counts.
- **R1 success oracle (state it so the bug is not re-introduced)**: do NOT assert "dist mtime unchanged". With `noEmitOnError` unset, `tsc` partially writes `dist/*.js` even on a type error, so an mtime-invariant oracle false-fails. Rollback success = **(a)** the two src `.ts` files' `git -C ~/.glass-atrium diff` == 0 (or matches the step-3 snapshot) **AND (b)** `launchctl kickstart` never fired on the failed build. The dist partial write is harmless (gitignored; the next clean build overwrites it).
- Report "build failed, apply rolled back".

**7. Re-verify readiness poll (R4).** After kickstart the monitor restarts via SIGKILL (Fastify must re-bind `:7842`). Do NOT issue a single immediate curl — a connection-refused during the boot race would be mis-read as false-stale. Instead **poll/retry** `/api/architecture/live` until HTTP 200 + a fresh value (≤~10s, short interval). Success oracle = `stale:false`.

**8. Post-apply summary (MANDATORY).** Show the user: the files changed, the applied value per diff, the semantic-edit slugs (CONTENT is an LLM edit — surface all of it for human confirmation), and the re-verify result.

**9. Partial-residue report.** If re-verify still returns `stale:true`, name which diff is unresolved (e.g. `actual` still ≠ `claimed` after apply) rather than reporting a clean success.

## Changelog ban (binding — applies to any follow-up edit)

`diagrams-source.ts` and `arch-invariants.ts` forbid in-file changelogs — current-state invariants only. The Stage 4 apply (and any other follow-up edit) MUST NOT add Wave/CID/date history to either file (the file header states this); pass this constraint verbatim into the glass-atrium-dev-node delegation package. The fix report records "what to change"; the "why" goes in the git commit message, the history is `git log`. Never instruct an editor to append a changelog comment to these files.

## Prohibitions

- **Edits only in Stage 4, only on deliberate human invocation, only via foreground glass-atrium-dev-node** — the main session never edits `diagrams-source.ts` / `arch-invariants.ts` in-session (Write/Edit blocked by enforce-delegation + Harness Path Protection). An edit happens ONLY in Stage 4, ONLY when a human ran `/glass-atrium-ops-verify-arch` without `--dry-run`, ONLY through a foreground `glass-atrium-dev-node` delegation. NEVER silently, NEVER from a daemon, NEVER backgrounded. Under `--dry-run` no edit occurs at all.
- **No count re-implementation** — always call `computeArchDrift()`; never hand-roll the count or the Atrium-ownership filter in this skill.
- **No pollution counting** — never count `~/.claude/` plugins, user MCP, or plugin skill namespaces as Atrium assets.
- **No cached drift** — read the count live each run; a stale last-audit value defeats the audit's purpose.
- **No kickstart on a failed build (R7)** — `launchctl kickstart` runs only after `npm run build` exits 0; a non-zero build aborts to rollback before any restart.
- **No unscoped rollback (R2)** — build-fail rollback restores only the two SoT file paths; `git restore .` / `git checkout .` is forbidden (would clobber unrelated dirty files).

## Red Flags

- A reported count that includes a plugin, user MCP, or plugin skill namespace → Atrium-scope boundary violated.
- Hook count reported as matcher-entry count instead of flattened Atrium-owned hook-command count.
- A "missing MCP node" finding → MCP is out of scope (Atrium defines zero).
- The main session edited a SoT file in-session → Stage 4 edits MUST go through a foreground `glass-atrium-dev-node` delegation.
- An apply ran under `--dry-run`, from a daemon, or backgrounded → all three are forbidden; apply is human-invocation + foreground-delegation only.
- `launchctl kickstart` fired after a non-zero `npm run build` → R7 build gate violated.
- Rollback used `git restore .` / `git checkout .` instead of the two scoped paths → R2 violated (clobber risk).
- Re-verify read as a single immediate curl instead of a poll/retry → R4 boot-race false-stale risk.
- A fix instruction that appends a changelog line to `diagrams-source.ts` / `arch-invariants.ts`.
- Semantic findings emitted without first running the machine stage (the report must carry both layers).

## Verification

- [ ] **Machine stage ran**: `computeArchDrift()` result (`stale` + `diffs`) is present in the report, not hand-counted.
- [ ] **Atrium scope honored**: every count and node refers to `~/.glass-atrium/` assets; no `~/.claude/` pollution, no MCP node.
- [ ] **All 7 diagrams walked**: the per-node real-counterpart pass covers every node of all 7 v2 diagrams.
- [ ] **Both layers reported**: machine diffs and semantic findings both appear (or each explicitly marked "none").
- [ ] **Actionable fix list**: each finding maps to a named file + exact change (invariant value or diagram slug edit).
- [ ] **Mode honored**: `--dry-run` produced a report only (zero edit/build/kickstart, two SoT files unchanged); default mode proceeded to Stage 4.
- [ ] **Foreground delegation**: Stage 4 edits/build/restart ran via a foreground `glass-atrium-dev-node` agent — never edited in-session, never backgrounded, never daemon-triggered.
- [ ] **Apply correctness**: COUNT diffs written to `arch-invariants.ts` (`hooks.<Event>` → nested field); CONTENT findings written to `diagrams-source.ts` at the anchored locations and grep-verified.
- [ ] **Build gate (R7)**: `launchctl kickstart` fired only after `npm run build` exit 0; a non-zero build aborted to rollback before any restart.
- [ ] **Rollback safety (R1/R2)**: on build failure, only the two SoT paths were `git restore`d (no unscoped restore); success oracle = two `.ts` diffs == 0 (or step-3 snapshot) AND kickstart never fired — NOT a dist-mtime check.
- [ ] **Re-verify poll (R4)**: `/api/architecture/live` polled/retried to HTTP 200 + fresh value (≤~10s); success oracle `stale:false` confirmed (COUNT-gated).
- [ ] **Changelog ban respected**: no applied edit (or fix instruction) adds Wave/CID/date history to the SoT files.
