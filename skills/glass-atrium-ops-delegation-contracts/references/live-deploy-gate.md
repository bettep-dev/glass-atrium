# Live deploy + empirical verification (PRE-MERGE delivery gate — live-install bundle members only)

- **Pointer site**: `skills/glass-atrium-ops-orchestrator-role.md` → `## Document-Driven Workflow` step 6.

## Per-cycle order

`implementation → simplify → review of the modified files → local deploy of the combined unmerged tree → empirical verification on the live install → PR → CI → merge → sha-parity + recovery-snapshot reconcile`

- A prompt-file cycle inserts steps into this order: the pointer site, step 6's **Prompt-file tail**.
- Why pre-merge: a defect found before the merge is fixed on its branch, while one found after is already in `main`; and a fix delivered to the repo alone leaves live agents running the defect it fixes until a post-merge deploy or release delivers it.

## Steps of the order

- **Deploy the combined tree** — all of the cycle's branches composed over current `main`, never one branch at a time.
  - Why: a cycle's branches routinely share files, and only the combined tree matches what the merge produces.
  - Route: the sanctioned updater's local-source seam (`ATRIUM_UPDATE_SRC_DIR` + `ATRIUM_UPDATE_SRC_MANIFEST`).
  - Copy-step idiom: `skills/glass-atrium-ops-delegation-contracts/references/deploy-safety-idiom.md`.
- **Verify empirically on that live install** — rule and behavior probes, live test execution, doctor and monitor state.
  - A probe run against the repo tree does not satisfy this gate.
  - **Why the live suite is the threshold** (the threshold itself: the pointer site):
    - The daemon's green-suite gate invokes the same runner and re-entry sentinel (`autoagent/daemon-apply.sh` → `verify_green_suite`, which aborts the cycle after one retry on a non-zero status), so a red run here is a red daemon cycle there.
    - The runner recurses the four on-disk test roots, so a stale on-disk `.bats` the repo no longer ships fails only on the live install.
- **Only on green, open and merge the PRs.**
  - A defect the probes surface is fixed on its branch, and deploy + verify repeats before the PR is opened.
  - Merging still needs the explicit per-cycle approval: `rules/glass-atrium/core-git-workflow.md` → `## Pull Requests` → **Merge authorization**.
- **After merge, reconcile sha parity** — merged `main` and the deployed tree must be content-identical.
  - A divergence means something landed that was never on the verified tree, or the deploy drifted; a follow-up deploy from merged `main` closes it.
  - The recovery-repo snapshot reconcile runs here too: `scripts/snapshot-live-repos.sh` records the deployed tree in the live per-directory repos, so a restore rolls forward, not back.

## Scope and backing

- **Live-install bundle members**: the files `manifest.json` lists — `hooks/`, `scripts/`, `rules/`, `scoped/`, `skills/`, `agents/`, `autoagent/`, `lib/`, `monitor/` among them.
- **Post-merge deploy — narrow cases, never the default**:
  - the release flow, which re-publishes from merged `main` — this gate does not say when a release is cut;
  - a cycle where no pre-merge deploy was possible — deploy from merged `main` and run the same empirical verification, late rather than never.
- **Boundary**: the deploy is delegated, never self-executed (`skills/glass-atrium-ops-orchestrator-role.md` → `## Orchestrator Identity`).
  - This gate's live write goes through the sanctioned updater alone; a manual write into the live install is forbidden.
- **Honest framing — honor-system, not mechanically enforced**: nothing blocks a PR opened ahead of the verification.
