# Deploy-Safety Idiom — sanctioned flows and the copy step

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Deploy-Safety Idiom (drift-preserving live-copy + verify) [ORCHESTRATOR]` — what it binds, its advisory status, and when in the cycle the deploy runs.

## Reach the destination through a sanctioned flow FIRST

A direct write into the live harness surface — `~/.glass-atrium/{hooks,agents,autoagent,scripts,skills}/`, `~/.claude/{hooks,agents}/`, `settings.json`, the `com.*.plist` files — is BLOCKED agent_id-independently by `enforce-harness-critical.sh`, so a delegation that just `cp`s there fails at the gate, not at review.

Pick one of these flows:

- **Updater local-source seam** — stage the tree, then let `scripts/update.sh` deploy it (`ATRIUM_UPDATE_SRC_DIR` + `ATRIUM_UPDATE_SRC_MANIFEST`).
  - The sanctioned default: the manifest gate, the agent EDITABLE-region merge and the backup/rollback transaction all still run.
  - The apply is unattended — no prompt stands between the staged tree and the live install.
- **Launch-env grant** — `HARNESS_PROTECTION_APPROVE=1` must be in the environment Claude Code was LAUNCHED with.
  - An in-session `export` via the Bash tool NEVER reaches the hook (hooks inherit the launch environment), so this is a session-start decision a delegation cannot arrange for itself.
- **Worktree-then-deploy** — do the work in a git worktree (unprotected), land it through review, and let the installer / `update.sh` / the `agent_lifecycle` CLI perform the live write.

## The copy step — three anti-patterns, then the sanctioned idiom

The idiom is deploy-mechanism-agnostic: it applies to the copy step of whichever flow is chosen, with `DST` a staging tree rather than the live surface.

- **cp-silent-fail** — a bare `cp` can partially or silently fail to update a target, so trusting its exit code alone hides drift.
  - → Verify EACH copied file with `cmp -s` (byte-equality) AFTER the copy; a `cmp` mismatch is the deploy-failure signal (loud-fail, never `|| true` it).
- **IFS-word-split** — `for f in ${LIST}` mis-splits the file list under a strict `IFS=$'\n\t'` (a path with an IFS char breaks iteration).
  - → Iterate with `while IFS= read -r f; do … done <<<"${LIST}"` so each line is exactly one path, unsplit.
- **lookbehind blind-spot** — a grep negative-lookbehind authored to exclude one shape can silently exclude the `/path/` form too, skipping real matches.
  - → Use a blind-spot-free POSITIVE match or an explicit allowlist instead.

Sanctioned idiom (bash 3.2-safe):

```bash
# drift-preserving staged copy + per-file cmp verify — loud-fail on any mismatch.
# DST = the staging tree the sanctioned flow deploys FROM (e.g. ATRIUM_UPDATE_SRC_DIR),
# never the live ~/.glass-atrium / ~/.claude surface.
while IFS= read -r rel; do
  [[ -z "${rel}" ]] && continue
  cp -- "${SRC}/${rel}" "${DST}/${rel}"
  cmp -s "${SRC}/${rel}" "${DST}/${rel}" || { printf 'DEPLOY DRIFT: %s\n' "${rel}" >&2; exit 1; }
done <<<"${FILE_LIST}"
```
