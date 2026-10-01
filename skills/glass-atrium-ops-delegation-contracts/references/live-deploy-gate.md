# Live deploy + empirical verification (PRE-MERGE delivery gate — live-install bundle members only)

- **Pointer site**: `rules/glass-atrium/orchestrator-role.md` → `## Document-Driven Workflow` step 6.

## Per-cycle order

`implementation → simplify → review of the modified files → LOCAL DEPLOY (combined unmerged tree) → EMPIRICAL VERIFICATION on the live install → PR → CI → merge → sha-parity + recovery-snapshot reconcile`

- Prompt-file cycles insert steps into this order: the pointer site, step 6's **Prompt-file tail**.

## Steps of the order

- **Deploy the COMBINED tree** — all of the cycle's branches composed over current `main`, deployed to the live install through the sanctioned updater's local-source seam (`ATRIUM_UPDATE_SRC_DIR` + `ATRIUM_UPDATE_SRC_MANIFEST`; copy-step idiom: `skills/glass-atrium-ops-orchestrator.md` → Deploy-Safety Idiom).
  - Not per-branch: a cycle's branches routinely share files, and only the combined tree matches what the merge produces.
- **Verify empirically ON that live install** — rule/behavior probes, live test execution, doctor/monitor state. A probe run against the repo tree does not satisfy this gate.
  - **Live-suite instrument — why it is the threshold** (the threshold itself: the pointer site):
    - It is the runner and re-entry sentinel the daemon's green-suite gate invokes (`autoagent/daemon-apply.sh` → `verify_test_harness`, which aborts the cycle after one retry on a non-zero status), so a red run here is a red daemon cycle there.
    - A repo-tree run cannot substitute: the runner recurses the four on-disk test roots, so a stale on-disk `.bats` the repo no longer ships fails only on the live install.
- **Only on green, open and merge the PRs.** A defect the probes surface is fixed on its branch, and deploy+verify repeats before the PR is opened. Merging still needs the explicit per-cycle approval at `core-git-workflow.md` → Pull Requests.
- **After merge, reconcile sha parity** — merged `main` and the deployed tree MUST be content-identical.
  - A divergence means something landed that was never on the verified tree, or the deploy drifted; a follow-up deploy from merged `main` closes it.
  - The recovery-repo snapshot reconcile runs here too.

## Scope and backing

- **Live-install bundle members**: manifest-member files: `hooks/`, `scripts/`, `rules/`, `agents/`, `autoagent/`, `lib/`, `monitor/`, ….
- **Rationale**: a defect found before the merge is fixed on its branch; found after, it is already in `main` — and repo-only delivery leaves live agents running the defect until the fix merges.
- **Post-merge deploy — NARROW retained cases, never the default**:
  - (a) the RELEASE flow, which re-publishes from merged `main` via the release path — this gate says nothing about when a release is cut;
  - (b) a cycle where no pre-merge deploy was possible — deploy from merged `main` and run the SAME empirical verification, late rather than never.
- **Boundary**: deploy is DELEGATED, never self-executed (`rules/glass-atrium/orchestrator-role.md` → `## Orchestrator Identity`), and the sanctioned updater is the ONLY live write path — manual writes into the live install stay FORBIDDEN.
- **Honest framing — HONOR-SYSTEM, NOT mechanically enforced**: nothing blocks a PR opened ahead of the verification.
