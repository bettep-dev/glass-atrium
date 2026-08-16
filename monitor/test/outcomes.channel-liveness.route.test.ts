// Regression tests for the /channel-liveness recording-channel watchdog.
// Runner: npx tsx --test test/outcomes.channel-liveness.route.test.ts
//
// The incident: a channel carrying hundreds of rows a day fell to zero and stayed
// there past a full day with nothing watching. SILENT_CHANNEL below reproduces
// exactly that shape.
//
// Pinned invariants:
//   (a) an eligible channel silent past the threshold is NAMED in `alerting`;
//   (b) a channel under the eligibility floor is ABSENT from it however long its
//       silence — a quiet low-traffic channel is not news;
//   (c) eligibility alone does not alert — a high-volume channel with a fresh row
//       stays absent;
//   (d) the doctor's second surface reads its verdict from this response instead of
//       restating either threshold — asserted against the doctor source itself;
//   (e) an ordinary idle gap does NOT alert — the false-positive side of the bound,
//       which (a)-(c) never exercised: (b) tests the eligibility floor and (c) tests
//       a channel that is not silent at all, so nothing failed when the bound sat
//       below this machine's routine overnight quiet;
//   (f) a channel whose qualifying volume has gone stale does NOT alert — silence is
//       only news while the channel is current, and a burst that ended days ago is a
//       channel that wound down, not one that broke;
//   (g) the recency window outlasts the silence bound, so a long outage cannot
//       disqualify itself from the eligibility it needs in order to alert.
//
// Membership and absence only, both keyed on seeded channel names, so the live
// channels sharing the window neither satisfy nor break an assertion.
//
// Seeds use attribution_source values with ZERO rows in the live table
// (verified against core.outcomes), so a real recording cannot perturb a verdict.
// DB: real Postgres — cleanup is by cid LIKE.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type { ChannelLivenessResponse } from "../src/server/types/outcomes.js";

const SUITE_MARKER = `channel-liveness-test-${randomUUID()}`;
const WINDOW_DAYS = 7;

// The incident shape: one high-volume day, then nothing for over a day.
const SILENT_CHANNEL = "cron-derived";
// Below the eligibility floor, silent for the same span — the news/not-news control.
const QUIET_CHANNEL = "conversation-only";
// Above the floor with a fresh row — pins that eligibility alone does not alert.
const LIVE_CHANNEL = "agent-id-missing";
// Above the floor, currently busy, silent only for an ordinary idle stretch — the
// false-positive control for the silence bound itself.
const IDLE_CHANNEL = "completion-missing";
// Above the floor on a day that has since fallen out of the recency window — a
// channel that wound down rather than broke.
const STALE_CHANNEL = "truncated_completion";

interface ChannelSeed {
  source: string;
  // Rows written into a single day bucket — the peak the eligibility floor reads.
  rows: number;
  // Age of that day bucket, in hours before now.
  agedHours: number;
}

const SEEDS: readonly ChannelSeed[] = [
  { source: SILENT_CHANNEL, rows: 150, agedHours: 30 },
  { source: QUIET_CHANNEL, rows: 5, agedHours: 30 },
  { source: LIVE_CHANNEL, rows: 150, agedHours: 30 },
  // Recent enough to stay eligible, quiet for less than the bound.
  { source: IDLE_CHANNEL, rows: 150, agedHours: 12 },
  // Qualifying volume, but on a day now outside the recency window.
  { source: STALE_CHANNEL, rows: 150, agedHours: 96 },
] as const;
// The live channel gets one extra recent row on top of its aged burst.
const LIVE_CHANNEL_FRESH_MINUTES = 1;

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();
  await seedChannels();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[channel-liveness cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

// One INSERT … SELECT per channel: generate_series spaces record_ts by seconds so
// the (record_ts, agent, task_type) dedup index admits every row, and the whole
// burst lands inside one UTC day bucket.
async function seedChannels(): Promise<void> {
  const prisma = getPrisma();
  for (const seed of SEEDS) {
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, attribution_source, cid)
      SELECT
        NOW() - (${seed.agedHours}::int * INTERVAL '1 hour') - (g * INTERVAL '1 second'),
        ${`channel-liveness-agent-${seed.source}`},
        'feature'::core."TaskType",
        'done'::core."OutcomeResult",
        ${`channel-liveness seed ${seed.source} ${SUITE_MARKER}`},
        ${seed.source},
        ${`${SUITE_MARKER}-${seed.source}-`} || g
      FROM generate_series(1, ${seed.rows}::int) AS g
    `;
  }
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, cid)
    VALUES
      (NOW() - (${LIVE_CHANNEL_FRESH_MINUTES}::int * INTERVAL '1 minute'),
       ${`channel-liveness-agent-${LIVE_CHANNEL}-fresh`},
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       ${`channel-liveness seed ${LIVE_CHANNEL} fresh ${SUITE_MARKER}`},
       ${LIVE_CHANNEL},
       ${`${SUITE_MARKER}-${LIVE_CHANNEL}-fresh`})
  `;
}

async function fetchLiveness(): Promise<ChannelLivenessResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/channel-liveness?days=${WINDOW_DAYS}`,
  });
  assert.strictEqual(res.statusCode, 200, "/channel-liveness must be 200");
  return res.json() as ChannelLivenessResponse;
}

// (a) the incident — a high-volume channel gone quiet past the bound.

test("/channel-liveness names a high-volume channel that fell silent past the threshold", async () => {
  const body = await fetchLiveness();
  const seed = SEEDS.find((s) => s.source === SILENT_CHANNEL);
  assert.ok(seed, "the silent-channel seed is present");

  assert.ok(
    seed.rows > body.thresholds.eligibility_daily_floor,
    "the seed reproduces a channel above the eligibility floor",
  );
  assert.ok(
    seed.agedHours > body.thresholds.silence_hours,
    "the seed reproduces silence past the alerting bound",
  );
  assert.ok(
    body.alerting.includes(SILENT_CHANNEL),
    `${SILENT_CHANNEL} is named in the alerting set`,
  );
});

// (b) not news — silence below the eligibility floor.

test("/channel-liveness omits a channel that never cleared the eligibility floor", async () => {
  const body = await fetchLiveness();
  const seed = SEEDS.find((s) => s.source === QUIET_CHANNEL);
  assert.ok(seed, "the quiet-channel seed is present");

  assert.ok(
    seed.rows <= body.thresholds.eligibility_daily_floor,
    "the seed stays under the eligibility floor",
  );
  assert.ok(
    seed.agedHours > body.thresholds.silence_hours,
    "the seed is silent for the same span as the alerting one",
  );
  assert.ok(
    !body.alerting.includes(QUIET_CHANNEL),
    `${QUIET_CHANNEL} is absent from the alerting set despite the silence`,
  );
});

// (c) eligibility alone is not the verdict.

test("/channel-liveness omits an eligible channel that is still recording", async () => {
  const body = await fetchLiveness();
  const live = body.channels.find((c) => c.attribution_source === LIVE_CHANNEL);
  assert.ok(live, `${LIVE_CHANNEL} is present in the window`);

  assert.ok(live.eligible, "the seed clears the eligibility floor");
  assert.ok(
    !body.alerting.includes(LIVE_CHANNEL),
    `${LIVE_CHANNEL} is absent from the alerting set — a fresh row is not an outage`,
  );
});

// (e) the false-positive side of the bound — an ordinary idle gap is not an outage.
//
// This is the control the first three lacked. (b) exercises the eligibility floor and
// (c) exercises a channel that is not silent at all, so a bound set below this
// machine's routine overnight quiet satisfied every one of them while firing on 20 of
// 21 threshold-crossing gaps in live data.

test("/channel-liveness omits an eligible channel whose silence is an ordinary idle gap", async () => {
  const body = await fetchLiveness();
  const seed = SEEDS.find((s) => s.source === IDLE_CHANNEL);
  assert.ok(seed, "the idle-channel seed is present");
  const channel = body.channels.find((c) => c.attribution_source === IDLE_CHANNEL);
  assert.ok(channel, `${IDLE_CHANNEL} is present in the window`);

  assert.ok(
    channel.peak_daily_count > body.thresholds.eligibility_daily_floor,
    "the seed clears the eligibility floor, so only the bound can keep it quiet",
  );
  assert.ok(
    seed.agedHours < body.thresholds.silence_hours,
    "the bound sits above an ordinary idle stretch — a routine quiet night is not an outage",
  );
  assert.ok(
    !body.alerting.includes(IDLE_CHANNEL),
    `${IDLE_CHANNEL} is absent from the alerting set — routine idleness must not fire`,
  );
});

// (f) staleness — silence is only news while the channel is current.

test("/channel-liveness omits a channel whose qualifying volume has gone stale", async () => {
  const body = await fetchLiveness();
  const seed = SEEDS.find((s) => s.source === STALE_CHANNEL);
  assert.ok(seed, "the stale-channel seed is present");
  const channel = body.channels.find((c) => c.attribution_source === STALE_CHANNEL);
  assert.ok(channel, `${STALE_CHANNEL} is present in the window`);

  assert.ok(
    channel.peak_daily_count > body.thresholds.eligibility_daily_floor,
    "the burst cleared the floor, so peak-over-the-window alone would qualify it",
  );
  assert.ok(
    seed.agedHours > body.thresholds.silence_hours,
    "and it has been silent well past the bound",
  );
  assert.ok(
    seed.agedHours > body.thresholds.eligibility_recency_days * 24,
    "but its qualifying day has fallen out of the recency window",
  );
  assert.ok(
    !body.alerting.includes(STALE_CHANNEL),
    `${STALE_CHANNEL} is absent from the alerting set — a channel that wound down is not one that broke`,
  );
});

// (g) the two thresholds are coupled: recency must outlast the bound.

test("the eligibility recency window outlasts the silence bound", async () => {
  const body = await fetchLiveness();

  // An outage suppresses the very rows that keep its channel eligible. If the recency
  // window closed first, the alert would switch itself off partway through the outage
  // it exists to report — the same self-muting failure as a threshold derived from the
  // channel's own recent maximum gap.
  assert.ok(
    body.thresholds.eligibility_recency_days * 24 > body.thresholds.silence_hours,
    "the recency window strictly outlasts the silence bound, so an outage cannot mute its own alert",
  );
});

// (d) one threshold definition, not two agreeing literals.

test("the doctor surface reads the route's verdict instead of restating its thresholds", async () => {
  const body = await fetchLiveness();
  const doctorSource = await readFile(
    path.join(import.meta.dirname, "..", "..", "lib", "ga-doctor.sh"),
    "utf8",
  );

  // §16 spans its heading to the run_doctor verdict rollup that closes it.
  const sectionStart = doctorSource.indexOf("# 16.");
  const sectionEnd = doctorSource.indexOf('if [[ "${fail}" -eq 0 ]]; then', sectionStart);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, "doctor §16 is delimited");
  const section = doctorSource.slice(sectionStart, sectionEnd);

  assert.match(section, /channel-liveness/, "the doctor reads the channel-liveness route");

  // Scan what the doctor SAYS, not the whole section: a restated threshold can only
  // reach an operator through a log message or the jq program that builds one, while
  // the section's other numbers are shell noise (`--connect-timeout 2`, `2>/dev/null`)
  // that a bare section-wide scan cannot tell apart from a single-digit threshold.
  const logLines = section.split("\n").filter((line) => /^\s*log\s/.test(line)).join("\n");
  const jqPrograms = [...section.matchAll(/jq -[a-z]*r '([\s\S]*?)'/g)].map((m) => m[1]).join("\n");
  const operatorFacing = `${logLines}\n${jqPrograms}`;

  for (const literal of [
    String(body.thresholds.eligibility_daily_floor),
    String(body.thresholds.silence_hours),
    String(body.thresholds.eligibility_recency_days),
  ]) {
    assert.ok(
      !new RegExp(`\\b${literal}\\b`).test(operatorFacing),
      `the doctor states no ${literal} literal — the threshold has one definition`,
    );
  }
  assert.match(
    section,
    /\.alerting/,
    "the doctor's verdict comes from the response's alerting membership",
  );
});
