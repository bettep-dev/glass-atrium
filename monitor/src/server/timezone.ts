// Day-bucket timezone SoT — config.toml [meta].timezone, rendered to ATRIUM_TIMEZONE in monitor/.env
// (render-monitor-env.sh). Routes bind it into SQL (AT TIME ZONE $n) and echo it in response timezone fields.
//
// Resolution priority: explicit (non-'auto') IANA > host detection > Asia/Seoul. In PRODUCTION the concrete
// host name is resolved at BUILD time by render-monitor-env.sh (via the TZ-immune /etc/localtime symlink),
// so this module normally receives an already-concrete name. The runtime host-detection branch below is
// DEV-ONLY: the launchd job pins TZ=UTC, so runtime `Intl` returns 'UTC' in prod (the TZ shadow) and MUST NOT be trusted as the real host.

const LAST_RESORT_TIMEZONE = "Asia/Seoul";
const AUTO_SENTINEL = "auto";

// Injectable host-tz source seam — defaults to the runtime `Intl` resolver.
// A unit test passes a fake resolver so the auto/host branch runs independent of the runner's ambient tz ('UTC' under the launchd TZ shadow → otherwise flaky).
export type HostTimezoneResolver = () => string | undefined;

const defaultHostResolver: HostTimezoneResolver = () => {
  // DEV-ONLY runtime detection (see module header — shadowed to 'UTC' in prod).
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

// Validate against the runtime IANA database via the Intl constructor (throws on unknown); alias-tolerant.
function isValidIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// supportedValuesOf gate (canonical IANA set) + Intl-constructor fallback.
// A historical alias outside the canonical set still validates, and an older runtime without supportedValuesOf still works.
function isKnownTimezone(tz: string): boolean {
  try {
    if (Intl.supportedValuesOf("timeZone").includes(tz)) {
      return true;
    }
  } catch {
    // supportedValuesOf unavailable on this runtime — fall through to the ctor check.
  }
  return isValidIana(tz);
}

// auto/host path: resolved-host tz, null-guarded + IANA-validated → Asia/Seoul last-resort.
// Never throws — an unresolvable host degrades to last-resort, not a boot abort (only an EXPLICIT invalid config is a loud boot failure).
function detectHostTimezone(resolver: HostTimezoneResolver): string {
  const detected = resolver();
  // Null-guard: older macOS Node returned undefined here (fixed ≥18.19/20/22/24).
  if (detected === undefined || detected === "") {
    return LAST_RESORT_TIMEZONE;
  }
  return isKnownTimezone(detected) ? detected : LAST_RESORT_TIMEZONE;
}

// When an EXPLICIT (non-'auto') tz diverges from the detected host, emit a one-line stderr boot warning (boot proceeds with the explicit value).
// Skipped when host detection is untrustworthy — resolver yields nothing or 'UTC' (the launchd TZ-shadow sentinel; a real UTC-host divergence is caught by the build-time render warning instead).
// Keeps the DEV signal meaningful without flooding every prod boot under the TZ shadow.
function warnOnHostDivergence(explicitTz: string, resolver: HostTimezoneResolver): void {
  const host = resolver();
  if (host === undefined || host === "" || host === "UTC") {
    return;
  }
  if (host !== explicitTz) {
    process.stderr.write(
      `[timezone] WARNING: explicit ATRIUM_TIMEZONE '${explicitTz}' differs from ` +
        `detected host '${host}' — daemon schedule display may diverge from actual ` +
        `launchd fire (set [meta].timezone='auto' to follow the host).\n`,
    );
  }
}

// auto/empty/undefined → host detection (never throws); explicit IANA → validate + boot-throw on invalid, warn on host divergence.
export function resolveDayBucketTimezone(
  raw: string | undefined,
  hostResolver: HostTimezoneResolver = defaultHostResolver,
): string {
  if (raw === undefined || raw === "" || raw === AUTO_SENTINEL) {
    return detectHostTimezone(hostResolver);
  }
  // An invalid EXPLICIT value must fail at boot, never at first query (PG would
  // reject it per-request). Module-load throw aborts ESM evaluation before listen().
  if (!isValidIana(raw)) {
    throw new Error(
      `invalid ATRIUM_TIMEZONE '${raw}' — must be an IANA timezone name ` +
        `(e.g. ${LAST_RESORT_TIMEZONE}) or '${AUTO_SENTINEL}'`,
    );
  }
  warnOnHostDivergence(raw, hostResolver);
  return raw;
}

// Module-load resolution — the single SoT. Invalid explicit value → loud boot failure in the launchd log, not a silent wrong bucket.
export const DAY_BUCKET_TIMEZONE: string = resolveDayBucketTimezone(process.env.ATRIUM_TIMEZONE);
