# Destructive-Path Suite Safety Rules (Conditional Cross-Cutting Concern)

## Destructive-Path Suite Safety (live-postgres reach)

**Condition — this section binds only when you are about to RUN a suite file that executes one of two install-side shell functions**: `clear_unmanaged_pg_orphan` (`lib/ga-daemons.sh`) and its only caller `preflight_pg_utc_guard` (`lib/ga-tui-preflight.sh`) are the functions that can reach a live postgres. Clear the procedure below first: the steps build on each other, and a step you cannot complete is a FAIL rather than a judgement call.

### Before you start: shadowing is not a safety condition

- **Shadowing `kill`, `rm` and `lsof` does not make a suite safe** — the Step 4 questions decide safety.
  - A shell-function shadow binds only in the shell that defines it, so a suite driving the function through a child shell can shadow all three while the real command runs.

### Step 1 — Enumerate the occurrences

List every occurrence and classify by READING it; a command-word pattern is FORBIDDEN as the enumeration step.

- `grep -rn "clear_unmanaged_pg_orphan\|preflight_pg_utc_guard" test hooks/test scripts/test autoagent/test`
- Read every line it returns, unfiltered: a missed executing site is indistinguishable from a pass.
- Why: a first-command-word regex over `test/poll-wallclock-ceiling.bats` returns the `@test` title and misses the real call at the end of a `run_bounded` child-shell command string, after a `;`.
- Derive the site list from the run; never carry a remembered count forward.

### Step 2 — Classify each occurrence

Classify each occurrence executing, naming, or neutralized — only executing sites continue.

- Executing: the name is a command word — bare at the start of a statement, after `run`, or after ANY command separator (`;`, `&&`, `||`, `|`, newline) INCLUDING inside a child-shell command string.
- Naming: it sits inside `grep`, `awk`, `declare -f`, a `[[ ]]` comparison, a `@test` title, a comment, a string literal in a non-shell file, or an argument to a helper (`extract_launcher_fn <name>`); or it is the definition itself.
- Neutralized: a shadow definition (`<fn>() { return N; }`) that both precedes EVERY call it covers and sits in the SAME shell as that call — then those calls run the shadow, not the real function. Either half unproven → treat the calls as executing.
  - **In a bats file, "the SAME shell" is the SAME test body, and this is the rule, not a nuance**: each test body runs in its own shell, so a shadow defined in one body does NOT reach a call in any later body.
  - Therefore a call with no shadow inside its OWN body is EXECUTING even when a shadow of that name appears earlier in the file.
  - Mirror: whatever `setup` defines DOES reach every body, because it runs inside each one — a shadow or a PATH stub installed there covers the whole file, a body-local one only its own body.

### Step 3 — Read the reached function body

Read the reached function body BEFORE answering — the pid question is not answerable from the test file alone. Open `clear_unmanaged_pg_orphan` in `lib/ga-daemons.sh` and read ONLY these:

- Every lookup that feeds the signal, and how each is reached: a socket-scoped lookup, plus a socket-blind port fallback that runs only when the first returns nothing.
  - COUNT them rather than assuming one — a substitute must cover every one, which a stub ignoring its arguments does in a single file.
- Which layer consumes each answer: the pid feeds the signal, and the resolved socket path feeds the removal.
- Then resolve the SITE's own controls the same way: a test file usually installs its stub through a helper defined elsewhere in that file, so follow the helper's definition — the call site shows only its name.
- The READ relaxes no criterion below.

### Step 4 — Answer the questions at every executing site

Answer every question below at every executing site, all of them resolving.

- **Pid control** — can every `lsof` the function reaches return a live postgres pid? It MUST NOT. No environment seam substitutes for this.
  - It is the load-bearing half: the socket-BLIND `lsof -ti tcp:5432` fallback finds the live server wherever the socket path points.
  - Two substitute shapes resolve it: one reporting NO owner, and one reporting a pid that provably cannot name a live process (a literal above the platform pid ceiling — macOS wraps pids below 100000). A real `lsof` on PATH resolves neither, whatever the socket redirect says.
  - The fake-pid shape leaves `kill -INT <pid>` running the REAL `kill`; it is safe only because the pid cannot exist. A fake pid inside the live range fails this question.
- **Path control** — does `${PG_SOCKET}/.s.PGSQL.5432` resolve to a path OTHER than the live server's socket?
  - The object is that ONE path, not the tree containing it.
  - A unique per-run `mktemp -d` directory PASSES even when it sits under `/tmp`, and the AF_UNIX `sun_path` cap (~104 bytes on macOS) forces `test/uninstall-detached-daemons.bats` there.
  - What FAILS is `PG_SOCKET` resolving to the live socket's OWN directory — unset (defaults to `/tmp`), or an explicit `/tmp`.
  - Which seam sets it depends on how the file loads the code:
    - `GA_PG_SOCKET`, read ONLY by `ga_init_env` (`lib/ga-env.sh`), where `readonly PG_SOCKET="${GA_PG_SOCKET:-/tmp}"` sits. The freeze fires when `ga_init_env` is CALLED — as the launcher source does — NOT when `lib/ga-env.sh` is sourced.
    - a plain `PG_SOCKET=` assignment, which WORKS in a file that sources a domain lib directly and so never calls `ga_init_env`: nothing made the name readonly there, and exporting `GA_PG_SOCKET` in such a file is inert.
- **Mechanism binding** — which shell actually runs the function?
  - A same-shell `run <fn>` is bound by shell functions AND by PATH stubs; a child-shell driver is bound ONLY by PATH stubs and EXPORTED environment.

### Step 5 — Decide, and verify the decision after the run

- **Pass** requires pid control AND path control, each by a mechanism that binds under Mechanism binding. Shadowing the signal or the removal command is neither necessary nor sufficient.
- **Ambiguous means fail** — an ambiguous site is never argued into a pass.
  - The one escape: prepend a scratch dir of record-only stubs to the PATH of the WHOLE invocation (a PATH stub binds in every child) and run that one file under it; unavailable → stop and report.
    - Known collisions of that whole-invocation run — a not-ok row one causes is an artifact, not a regression:
      - an exported off-/tmp `GA_PG_SOCKET` trips the fail-closed seam guard `lib/ga-db.sh` → `_require_db_setup_ready` in a suite driving DB setup through `ga_init_env`;
        - such a suite strips the name from its driver's environment, as `test/run-step-fail-return.bats` → `drive_db` does — never relying on `GA_DB_NAME`, which the guard ignores;
      - a record-only `psql` stub prints nothing, so `hooks/test/ephemeral-pg-locale.bats` fails its rows asserting on its ephemeral cluster's `psql` output.
    - A colliding suite that executes neither function runs without the escape; one that executes either stays under this procedure.
- **Post-condition, independent of all the reading**: record the live server's pid and its socket inode before the run and compare both after. A change in either means something reached it, whatever the file said.

### What this procedure does NOT cover

These shapes still let a live pid or path reach a real signal or removal:

- a stub dir prepended inside a child command string while an earlier statement in that same child already ran the real tool;
- `GA_PG_SOCKET` set but never exported, so a child that calls `ga_init_env` itself freezes `PG_SOCKET` to the live default;
- a same-shell shadow definition that a child-shell driver in the same file does not inherit, so the child runs the real function while the parent reads as neutralized;
- path control alone, which leaves the port-lookup fallback free to find and signal the live pid;
- an executing site the enumeration misses because the function name is assembled from string fragments.
