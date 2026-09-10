<!-- R2 (2026-05-20) — direct wiki-daemon-cycle.sh invocation is owned by the launchd job com.glass-atrium.wiki-compile (fires 04:50 KST, running wiki-daily-compile.sh then wiki-daemon-cycle.sh). Step (2) of this REPL entry prompt was therefore removed, leaving the loop with instruction-tuning and quota-gate support work only. Roll-back path: re-enabling step (2) in this file restores the automatic cycle trigger from the entry prompt (regression risk — a silent REPL inject-path failure; the fakechat watchdog's bun restart leaves a stale MCP handle). -->
/loop 24h Wiki daily compile cycle support run. Work through the steps below in order.

## (0a) Register the cron first, unconditionally (idempotent, deadlock-proof)

- Call the `CronList` tool to list this session's current schedule entries.
- If an entry's prompt field already contains the marker string `[CRON:wiki-daily]`, skip registration here and go to (0b). This prevents duplicate registration: the marker is embedded in the (1)-(4) registration body below, so unlike a preamble string the skip key matches the body CronCreate actually registers.
- Otherwise call the `CronCreate` tool with `cron="0 21 * * *"`, `recurring=true`, and `prompt` = the entire (1)-(4) body of this entry-prompt file (excluding steps (0a) and (0b) themselves).
- CronCreate answering `Scheduled recurring job <8-hex-id>` is what satisfies healthcheck Step 5, which greps the transcript for `Scheduled recurring job [a-f0-9]{8}`.
- **Ordering invariant**: cron registration (0a) is always the first LLM call, in any quota state. The quota wait (0b) halts this cycle body only and never blocks the schedule registration itself. The previous order — (0a) quota gate then (0b) CronCreate — deadlocked by skipping CronCreate permanently once quota was reached; reversing it makes that deadlock structurally impossible.
- If CronCreate itself fails (rare but possible), run this with `Bash` and then end the cycle — no silent fallback:
  `printf '[%s] [wiki-cron-fail] CronCreate failed: <first line of the response>\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/wiki-daemon-loop.log`

## (0b) Quota check, after registration

- Evaluate with `Bash`:
  `tmux capture-pane -t claude-wiki-daemon -p -S -50 | grep -E "Limit reached|Usage ⚠ Limit|Exceeded USD budget|out of extra usage|/rate-limit-options|resets .* \([A-Za-z_+-]+(/[A-Za-z_+-]+)+\)" | head -1`
- Empty result (quota healthy) → proceed to (1).
- Quota limit reached (e.g. `Usage ⚠ Limit reached (resets 2h 10m)`) → run the following with `Bash`, then end this cycle immediately (no further LLM calls):
  `printf '[%s] [wiki-quota-wait] Limit reached, retry after next cron fire\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/wiki-daemon-loop.log`
- Retry happens at the next cron fire (21:00 KST the following day, already registered in (0a)) or at the launchd daily restart (05:30 KST).

## (1) `[CRON:wiki-daily]` — Phase 4 infrastructure guard

`[CRON:wiki-daily]` is the cron-registration idempotency marker ((0a)'s CronList skip key). It is an inert tag with no effect on execution — the token itself triggers nothing.

- Evaluate with bash: `test -x ~/.glass-atrium/scripts/wiki-daemon-cycle.sh && test -x ~/.glass-atrium/scripts/wiki-sync.sh`
- If either is missing, run only this with `Bash` and end the cycle (no further LLM calls):
  `printf '[%s] Phase 4 not deployed — waiting\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/wiki-daemon-loop.log`

## (2) Cycle execution — not triggered here

[R2 bypass — zero REPL dependency] wiki-daemon-cycle.sh is invoked directly by the launchd job com.glass-atrium.wiki-compile at 04:50 KST. This REPL step triggers no cycle run. (Roll-back: restore this paragraph to a `bash ~/.glass-atrium/scripts/wiki-daemon-cycle.sh 2> /tmp/wiki-daemon-loop.log` call.)

## (3) Weekly reset signal

- Evaluate `date +%u` with `Bash`. If the result is `7` (Sunday), print this one Korean line verbatim — it is operator-facing output, not an instruction:
  `주간 리셋 권장: tmux attach -t claude-wiki-daemon 후 /clear 실행`
- Never call /clear inside this cycle (slash commands cannot be nested).

## (4) Report the cycle result in one line

Report guard result / whether a call was made / whether the Sunday signal fired. Someone attaching to the session must be able to read progress from the last line of output alone.

## Standing constraints

- Context accumulation: every cycle is stateless. Results are persisted only to daemon-reports/ files and /tmp/wiki-daemon-loop.log.
- A user attaching to this session and typing manual commands does not stop this loop (CronCreate fires only when idle).
- Known limit: both the CronCreate registration and the /loop 24h backup expire after 7 days. On expiry the launchd re-injection wrapper pastes this prompt again (owned by dev-shell). On re-injection, step (0a) runs again as the first call regardless of quota state, registering the cron afresh, and only then is the (0b) quota gate evaluated.
- This daemon is the sole writer of wiki/ (scope-wiki.md); no other agent may write to wiki/ directly.
