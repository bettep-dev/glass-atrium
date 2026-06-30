---
name: glass-atrium-update
description: Apply the latest Glass Atrium release to this install. Downloads the GitHub Release asset for config [release].repo (manifest.json + the hashed bundle), pauses the autoagent daemon, verifies every changed file's SHA-256 against the manifest, shows a per-file diff for explicit confirmation, then deterministically syncs the non-agent files via the apply-spine, three-anchor-merges each changed agent's EDITABLE regions (preserving locally-learned content) through git_txn behind the same confirm gate, and captures the base@install baseline. Use when the user asks to update / upgrade Glass Atrium, runs `glass-atrium update`, or the dashboard update badge says a new version is available. This skill is an ADAPTER over the E3 spine + the E4 merge module — it implements NO merge logic of its own (it reuses autoagent/lib/editable_merge.py) and NEVER writes core.autoagent_proposals. Do NOT use for the autoagent self-improvement loop (daemon-apply.sh) or publishing a release (scripts/publish-release.sh).
disable-model-invocation: true
---

# Glass Atrium Update

User-triggered updater for a Glass Atrium install. The binary subcommand
`glass-atrium update` (T08) dispatches to `update.sh` in this skill directory.

This skill is the **adapter** that orchestrates the already-built E3 spine
libraries (`scripts/lib/apply-spine.sh`, `apply-gate.sh`, `update-pause-flag.sh`,
`sensitive-refusal.sh`, `atrium-config.sh`). It introduces **no new merge logic**
and **never writes `core.autoagent_proposals`** — that surface belongs to the
autoagent self-improvement loop, a separate system.

## When to Use

- User asks to "update" / "upgrade" Glass Atrium to the latest release
- User runs `glass-atrium update`
- The dashboard update badge reports a new version is available (its command SoT is `UPDATE_SKILL_COMMAND` = `glass-atrium update`)
- **Exclusions**: the autoagent self-improvement loop (`autoagent/daemon-apply.sh`), publishing a release (`scripts/publish-release.sh`), hand-editing `manifest.json` (agent EDITABLE-region three-anchor merges are NO LONGER an exclusion — as of T19 this skill performs them, reusing `autoagent/lib/editable_merge.py`)

## Adapter Contract (what it orchestrates, in order)

1. **Writer-serialization (T10 / gate G1)** — create the cooperative pause flag (`${GA_ROOT}/.update-state/autoagent-pause.flag`, fixed canonical path) so the launchd-live autoagent daemon and the `daemon-daily-restart`-spawned instance both SUSPEND at their entry gates; acquire the daemon `.apply-lock` (`mkdir`-atomic, the same lock `daemon-apply.sh` uses); refuse to start when HEAD is a mid-apply `[WIP-AUTO]` commit. Lock contention loud-fails (no silent absorption).
2. **Download + stage** — fetch the latest GitHub Release assets (`manifest.json` + `glass-atrium-bundle-<version>.tar.gz`) for `config.toml` `[release].repo` (or `ATRIUM_RELEASE_REPO`) via `gh release download`, and extract the bundle into a staged new-release tree.
3. **Verify** — per-file SHA-256 of every changed file equals `manifest.hashes[path]` (`spine_stage_and_verify`); a corrupt download loud-fails and leaves the install untouched.
3.5. **Roster-migration gate (T20 / gate G8)** — gate only on a **vendor-driven** roster change, scoped by provenance so a customized install is never false-blocked. An **add** = an agent in the incoming release roster (its `agents/<name>.md` file set ∪ `agent-registry.json` `.agents` keys) absent locally. A **remove** = an agent present in the **prior-vendor base@install baseline** (`spine_get_baseline`) that the new release drops — NOT merely an agent present locally but absent from the release. A user-added agent (created via `agent_lifecycle`, present locally but in no vendor release) is therefore NOT a removal and does NOT gate; a pure CONTENT edit to an already-present agent likewise passes through to the E4 merge path. A genuine vendor add/remove is refused/deferred BEFORE any staging and routed to the `agent_lifecycle` human-pause ceremony — never the silent deterministic sync (`agent-registry.json` would otherwise auto-swap an agent into / out of the roster). A missing baseline yields no prior-vendor roster → no removes flagged (degrade-safe). Override for an explicit, non-silent apply: `ATRIUM_UPDATE_ALLOW_ROSTER=1`.
4. **Foreground confirm (T12 / gate G3)** — render a per-file unified-diff preview, then a single explicit `[y/N]` confirmation on the controlling TTY. Declining writes **zero** files (structural, via `gate_apply_confirmed`).
5. **Deterministic non-agent sync (T13)** — snapshot + swap + rollback via `spine_commit_staged`. The spine **excludes** `agents/**/*.md`, `*.local.md`, and `config.toml`.
5.5. **Agent EDITABLE-region merge (E4 / T17-T19)** — for each changed top-level `agents/<name>.md` (a content edit; a roster add/remove was already gated at 3.5), the three-anchor resolver (`autoagent/lib/editable_merge.py` `plan`) produces a candidate that KEEPS locally-learned EDITABLE-region content while taking the new vendor structure. Each candidate passes the SAME T12 foreground confirm gate, then commits through the daemon's hardened `git_txn_apply` transaction (WIP-snapshot → apply → verify → commit|rollback). Per-file routing: a sensitive path/diff is REFUSED (never written); a STRUCTURAL region-count mismatch is routed to the `agent_lifecycle` ceremony (not auto-applied); a keep-local/no-op resolution writes nothing; an LLM-required (both-changed) region is gated by the daemon's Haiku improvement-verify in the transaction's verify step. The merge is git-sandboxed — a non-git install LOUD-SKIPS it (the transaction requires git). Best-effort + non-fatal to the already-applied non-agent sync.
6. **Baseline + base-content capture (T14 / T24)** — capture the applied manifest as the hash-only `base@install` anchor (`spine_set_baseline`), THEN persist the new-release `agents/<name>.md` bodies (basename-keyed) into the base-content store at `<state-dir>/base-agents/` — the layout `editable_merge.load_base_text` reads. The hash anchor proves "changed since base"; the body store supplies the actual base region TEXT, so the NEXT update's E4 resolver does a true 3-way diff3 instead of degrading to the gated 2-way present-both fallback.
7. **Cleanup** — a trap removes the pause flag and releases the lock on every exit path (success, decline, failure, SIGINT/SIGTERM).

## Boundaries (what it is NOT)

- **Implements no merge logic of its own.** Agent EDITABLE-region merges are EXCLUDED from the deterministic non-agent sync and routed (as of T19) through `update_merge_agent_editable_regions`, which REUSES the separate E4 three-anchor resolver (`autoagent/lib/editable_merge.py`) + the daemon's `git_txn_apply` transaction — gated by the SAME foreground confirm. The skill is the wiring; it re-implements neither the diff3 nor the transaction.
- **Never auto-applies a roster migration (T20 / gate G8).** Adding or removing an agent is refused/deferred to the `agent_lifecycle` human-pause ceremony, not the silent sync. Only content edits to existing agents flow onward (to the E4 merge). A STRUCTURAL EDITABLE region-count mismatch within an existing agent is likewise routed to the ceremony, never auto-merged.
- **Never writes `core.autoagent_proposals`.** It reads release assets and swaps files; it touches no proposal/DB surface.
- **Never auto-syncs a sensitive harness file (T15 / gate G7).** GLOBAL_RULES, security scope rules, credential files, and launchd plists are partitioned out via the shared python helper (`autoagent/lib/sensitive_patterns.py`, the SINGLE refusal source — the shell never re-implements the regex) and reported for manual review. The partition is fail-closed: a path the helper cannot conclusively clear is treated as sensitive and skipped.

## Sensitive-Path Refusal

The refusal set is owned by `autoagent/daemon_cycle.py` (compiled tuples) and exposed through `autoagent/lib/sensitive_patterns.py`. This skill consults it ONLY through `scripts/lib/sensitive-refusal.sh::sensitive_path_ok`, which shells out to that helper. A divergent shell-regex dialect is deliberately avoided so the daemon and the updater refuse the SAME set.

## Manifest-Farm Integration

This skill directory and the `glass-atrium` binary deploy through the manifest symlink farm. Adding these files requires a `scripts/generate-manifest.sh` regeneration so the new file hashes land in `manifest.json` (else `doctor` §8 manifest-drift trips). When T08 changes the binary content, the binary's sha256 and the new skill-file hashes must be regenerated in the SAME change.

## Test Seams (non-production)

- `ATRIUM_UPDATE_SRC_DIR` + `ATRIUM_UPDATE_SRC_MANIFEST` — when both set, bypass the `gh` download/extract; the supplied new-release tree + manifest are used verbatim so the apply pipeline is exercisable hermetically.
- `ATRIUM_UPDATE_CONFIRM_ANSWER` — the apply-gate's own confirm-injection seam (used verbatim instead of reading `/dev/tty`).
- `ATRIUM_UPDATE_ALLOW_ROSTER` — explicit, non-silent opt-in that downgrades the roster-migration gate (G8) refusal to a warning and proceeds (a roster add stays excluded from the in-band content merge regardless — it belongs to the ceremony).
- `ATRIUM_UPDATE_MERGE_LIB_DIR` — override the `autoagent/lib` dir holding `editable_merge.py` + `git-txn.sh` (default: resolved beside the running updater); lets the E4 merge libs be sourced from a non-standard layout.
- `GA_ROOT`, `AUTOAGENT_REPORTS_DIR`, `ATRIUM_PAUSE_STATE_DIR`, `ATRIUM_UPDATE_STATE_DIR` — redirect the install root / lock / pause-flag / baseline paths into a sandbox.

## Files

- `update.sh` — the orchestrating entry point (sourced libs + the 7-step flow).
- `SKILL.md` — this contract.
