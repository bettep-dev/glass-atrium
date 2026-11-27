# Deploy-Safety Idiom — sanctioned flows and the copy step

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `#### Deploy-Safety Idiom (drift-preserving live-copy + verify) [ORCHESTRATOR]` — what it binds, its advisory status, and when in the cycle the deploy runs.

## Reach the destination through a sanctioned flow FIRST

- No hook blocks a direct write into the live harness surface, so a delegation that just `cp`s there lands.
  - Live harness surface: `~/.glass-atrium/{hooks,agents,autoagent,scripts,skills}/`, `~/.claude/{hooks,agents}/`, `settings.json`, the `com.*.plist` files.
  - Reported afterwards only where the integrity comparison looks: `rules/glass-atrium/core-security.md` → `### Enforcement boundary` → **Harness integrity**.
    - A deployed `com.*.plist` is outside it: the doctor's launchd deploy-drift check (`lib/ga-doctor.sh` → `launchd_deploy_drift`) compares those.
    - Any other path in the surface is compared by neither, so a stray copy there goes unreported.

Pick one of these flows:

- **Updater local-source seam** — stage the tree, then let `scripts/update.sh` deploy it (`ATRIUM_UPDATE_SRC_DIR` + `ATRIUM_UPDATE_SRC_MANIFEST`).
  - The sanctioned default: the manifest gate, the agent EDITABLE-region merge and the backup/rollback transaction all still run.
  - The apply is unattended — no prompt stands between the staged tree and the live install.
- **Worktree-then-deploy** — do the work in a git worktree, land it through review, and let the installer / `update.sh` / the `agent_lifecycle` CLI perform the live write.

## The copy step — three anti-patterns, then the sanctioned idiom

- The idiom applies to the copy step of whichever flow is chosen.
- **cp-silent-fail** — a bare `cp` can partially or silently fail to update a target, so trusting its exit code alone hides drift.
  - → Verify each copied file with `cmp -s` after the copy; a `cmp` mismatch is the deploy-failure signal (loud-fail, never `|| true` it).
- **IFS-word-split** — `for f in ${LIST}` mis-splits the file list under a strict `IFS=$'\n\t'` (a path with an IFS char breaks iteration).
  - → Iterate with `while IFS= read -r f; do … done <<<"${LIST}"` so each line is one path.
- **lookbehind blind-spot** — a grep negative-lookbehind authored to exclude one shape can silently exclude the `/path/` form too, skipping real matches.
  - → Use a positive match or an explicit allowlist instead.

Sanctioned idiom (bash 3.2-safe):

```bash
# DST = the staging tree the sanctioned flow deploys from (e.g. ATRIUM_UPDATE_SRC_DIR).
while IFS= read -r rel; do
  [[ -z "${rel}" ]] && continue
  cp -- "${SRC}/${rel}" "${DST}/${rel}"
  cmp -s "${SRC}/${rel}" "${DST}/${rel}" || { printf 'DEPLOY DRIFT: %s\n' "${rel}" >&2; exit 1; }
done <<<"${FILE_LIST}"
```
