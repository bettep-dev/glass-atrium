// Shared daemon next-fire computation — the single DST-correct source consumed by dashboard.ts +
// health-detail.ts (replaces the two duplicated fixed-9h computeNextFire copies). The next launchd
// fire is the next wall-clock occurrence of hour:minute in the resolved day-bucket timezone.
//
// DST primitive: a vanilla `Intl` two-pass offset-at-candidate-instant, ZERO dependency (no luxon /
// @js-temporal / date-fns). A fixed numeric offset is FORBIDDEN — it breaks every DST/non-JST zone.
// The offset is recomputed AT each candidate instant, so a spring-forward / fall-back day is handled correctly.
//
// `Intl.DateTimeFormat#formatToParts` is a NEW server-side primitive (the only prior use is the frontend
// ui.jsx display formatter) — this does NOT claim the pattern "matches existing style".

// Cron rule shape — daily-at + weekly-at. `hour`/`minute` are wall-clock fields in the resolved timezone.
// `dayOfWeek` (0=Sunday … 6=Saturday, matching launchd Weekday + JS Date#getUTCDay) is retained for weekly-at but currently dormant.
export type CronRule =
  | { type: "daily-at"; hour: number; minute: number }
  | { type: "weekly-at"; dayOfWeek: number; hour: number; minute: number };

// Raw daemon schedule source — the three config-derived "HH:MM" strings rendered into monitor/.env
// (ATRIUM_SCHEDULE_*) by render-monitor-env.sh. Each may be undefined (env unset). Injectable seam:
// module-load default reads process.env, unit tests pass a fixed object (mirrors timezone.ts HostTimezoneResolver seam).
// Config.toml stays the upper SoT — the backend consumes rendered env, never grows a second config.toml parser.
export interface RawDaemonSchedule {
  autoagent?: string;
  wiki?: string;
  "daily-restart"?: string;
}

// The three logical schedule keys + .env var names (fixed order autoagent/wiki/daily-restart).
// daily-restart fans out to TWO role-qualified rows (one launchd job → two monitor rows); the other two are 1:1.
const SCHEDULE_KEYS = ["autoagent", "wiki", "daily-restart"] as const;
type ScheduleKey = (typeof SCHEDULE_KEYS)[number];

const ENV_NAME: Record<ScheduleKey, string> = {
  autoagent: "ATRIUM_SCHEDULE_AUTOAGENT",
  wiki: "ATRIUM_SCHEDULE_WIKI",
  "daily-restart": "ATRIUM_SCHEDULE_DAILY_RESTART",
};

// Dev fallback = current config truth (incl. wiki 04:50), fired only on a totally-absent injected source.
// Setting it to config truth means the fallback itself cannot re-introduce wiki drift (analogue of timezone.ts LAST_RESORT_TIMEZONE).
const DEV_FALLBACK_SCHEDULE: Record<ScheduleKey, string> = {
  autoagent: "04:30",
  wiki: "04:50",
  "daily-restart": "05:30",
};

// Build the 4-row schedule map from an injectable raw source, applying the daily-restart fan-out.
// Loud-fail (mirrors timezone.ts): a present-but-malformed value throws at module load with the env-var name.
// Partial-presence throws (never mix rendered + fallback); only a TOTALLY-absent source degrades to the dev fallback + one stderr warning.
export function buildDaemonCronSchedule(source: RawDaemonSchedule): Record<string, CronRule> {
  const presentKeys = SCHEDULE_KEYS.filter((key) => isPresent(source[key]));

  if (presentKeys.length === 0) {
    // Dev path: tsx watch with no rendered .env. Visible, one-shot warning — never silent.
    process.stderr.write(
      "[schedule] WARNING: no ATRIUM_SCHEDULE_* env present — using dev-fallback " +
        "{autoagent 04:30, wiki 04:50, daily-restart 05:30}. Run render-monitor-env.sh " +
        "to render concrete schedule values from config.toml.\n",
    );
    return assembleSchedule(DEV_FALLBACK_SCHEDULE);
  }

  if (presentKeys.length < SCHEDULE_KEYS.length) {
    const missing = SCHEDULE_KEYS.filter((key) => !isPresent(source[key]))
      .map((key) => ENV_NAME[key])
      .join(", ");
    throw new Error(
      `partial daemon schedule env — ${missing} absent while others are set; render all ` +
        "three ATRIUM_SCHEDULE_* together (never mix a rendered value with a fallback)",
    );
  }

  return assembleSchedule({
    autoagent: source.autoagent as string,
    wiki: source.wiki as string,
    "daily-restart": source["daily-restart"] as string,
  });
}

// Daemon schedule → next-fire SoT, imported by dashboard.ts + health-detail.ts.
// Built from the rendered ATRIUM_SCHEDULE_* env at module load behind the buildDaemonCronSchedule seam.
export const DAEMON_CRON_SCHEDULE: Record<string, CronRule> = buildDaemonCronSchedule({
  autoagent: process.env.ATRIUM_SCHEDULE_AUTOAGENT,
  wiki: process.env.ATRIUM_SCHEDULE_WIKI,
  "daily-restart": process.env.ATRIUM_SCHEDULE_DAILY_RESTART,
});

// Assemble the 4 CronRule rows from validated HH:MM strings (daily-restart fans out to two identical-time rows).
function assembleSchedule(raw: Record<ScheduleKey, string>): Record<string, CronRule> {
  const autoagent = parseHhMm(raw.autoagent, ENV_NAME.autoagent);
  const wiki = parseHhMm(raw.wiki, ENV_NAME.wiki);
  const dailyRestart = parseHhMm(raw["daily-restart"], ENV_NAME["daily-restart"]);
  return {
    autoagent: { type: "daily-at", hour: autoagent.hour, minute: autoagent.minute },
    wiki: { type: "daily-at", hour: wiki.hour, minute: wiki.minute },
    "daily-restart-autoagent": {
      type: "daily-at",
      hour: dailyRestart.hour,
      minute: dailyRestart.minute,
    },
    "daily-restart-wiki": {
      type: "daily-at",
      hour: dailyRestart.hour,
      minute: dailyRestart.minute,
    },
  };
}

// Split a "HH:MM" wall-clock string into {hour, minute}, throwing with the env-var name on malformed/out-of-range input.
// Validation mirrors render-launchd-plists.sh lifecycle_xml (regex ^([0-9]{1,2}):([0-9]{2})$ + hour<=23, minute<=59) — one cross-file validation contract.
function parseHhMm(value: string, envVar: string): { hour: number; minute: number } {
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim());
  if (match === null) {
    throw new Error(
      `invalid ${envVar} '${value}' — must be a 24h wall-clock time 'HH:MM' (e.g. 04:30)`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(
      `invalid ${envVar} '${value}' — hour must be 0-23 and minute 0-59`,
    );
  }
  return { hour, minute };
}

// Present = defined and non-blank. A whitespace-only/empty env value counts as absent —
// it feeds the partial-presence loud-fail rather than a malformed-time throw.
function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

// Per-tz formatter cache: nextOccurrenceUtc calls getWallClockParts 3-5x per tz, and a fresh Intl.DateTimeFormat is the dominant per-call cost.
// The formatter is config-immutable for a given tz, so reuse is result-identical.
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

// Format a UTC instant into its wall-clock calendar parts in `tz`. `hourCycle:
// "h23"` pins the hour to 0-23 (avoids the ICU '24:00'-at-midnight quirk).
function getWallClockParts(instant: Date, tz: string): WallClockParts {
  const parts = getFormatter(tz).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const hour = lookup("hour");
  return {
    year: lookup("year"),
    month: lookup("month"),
    day: lookup("day"),
    // Defensive: h23 yields 0-23, but still map a stray '24' → 0 (without shifting
    // the date) in case an older ICU emits it.
    hour: hour === 24 ? 0 : hour,
    minute: lookup("minute"),
    second: lookup("second"),
  };
}

// Offset (ms) of `tz` AT the given UTC instant = (wall-clock reading as UTC) − (actual UTC); positive east (Asia/Seoul → +9h).
// Recomputed per instant, so it reflects the zone's DST state at that exact moment.
function getOffsetMsAt(utcMs: number, tz: string): number {
  const wall = getWallClockParts(new Date(utcMs), tz);
  const wallAsUtcMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallAsUtcMs - utcMs;
}

// Convert wall-clock components in `tz` to the UTC instant via a two-pass offset-at-candidate.
// Pass 1 estimates the offset at the naive guess; pass 2 re-evaluates at the corrected instant (catches a guess on the far side of a DST transition).
// `Date.UTC` normalizes day overflow (day 32 → next month), which makes the wall-clock day rollover in nextOccurrenceUtc safe.
function wallClockToUtcMs(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset1 = getOffsetMsAt(guessUtcMs, tz);
  const utc1 = guessUtcMs - offset1;
  const offset2 = getOffsetMsAt(utc1, tz);
  return guessUtcMs - offset2;
}

// Next UTC instant (ISO string) at which `rule` fires in zone `tz`, relative to
// `now`. Computes the next wall-clock occurrence directly in `tz`, DST-correct.
export function nextOccurrenceUtc(rule: CronRule, tz: string, now: Date): string {
  const nowWall = getWallClockParts(now, tz);
  let targetDay = nowWall.day;

  if (rule.type === "weekly-at") {
    // Weekday of today's wall-clock calendar date — tz-independent for a fixed
    // Y-M-D, and matches launchd Weekday / the legacy getUTCDay convention.
    const todayDow = new Date(
      Date.UTC(nowWall.year, nowWall.month - 1, nowWall.day),
    ).getUTCDay();
    const dayDelta = (rule.dayOfWeek - todayDow + 7) % 7;
    targetDay = nowWall.day + dayDelta;
  }

  // First candidate: the target wall time on the anchored date, in `tz`.
  let candidateUtcMs = wallClockToUtcMs(
    nowWall.year,
    nowWall.month,
    targetDay,
    rule.hour,
    rule.minute,
    tz,
  );

  if (candidateUtcMs <= now.getTime()) {
    // Already passed → roll the CALENDAR day forward in WALL-CLOCK space (daily +1, weekly +7) and re-run the two-pass.
    // NEVER add 86_400_000 / 7×86_400_000 ms to the UTC instant — a fixed-ms add re-introduces the ±1h DST bug across a transition day.
    const rollDays = rule.type === "weekly-at" ? 7 : 1;
    candidateUtcMs = wallClockToUtcMs(
      nowWall.year,
      nowWall.month,
      targetDay + rollDays,
      rule.hour,
      rule.minute,
      tz,
    );
  }

  return new Date(candidateUtcMs).toISOString();
}
