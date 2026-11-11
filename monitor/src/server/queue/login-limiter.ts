// In-process owner login limiter: one global counter (single-client loopback page), exponential backoff after
// the free failures, a lockout after repeated ones, and one verification at a time so parallel guesses cannot
// all run before the first failure is counted.

export const LOGIN_LIMIT = {
  FREE_FAILURES: 3,
  DELAY_MS: { BASE: 1_000, MAX: 60_000 },
  LOCKOUT: { FAILURES: 10, MS: 15 * 60_000 },
  /** Wait reported while another verification runs (scrypt takes well under this) */
  PENDING_WAIT_MS: 1_000,
} as const;

export class LoginLimiter {
  private failures = 0;
  private blockedUntil = 0;
  private isPending = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** @returns ms until the next attempt may run; 0 = now */
  getWaitMs(): number {
    if (this.isPending) return LOGIN_LIMIT.PENDING_WAIT_MS;
    return Math.max(0, this.blockedUntil - this.now());
  }

  setPending(): void {
    this.isPending = true;
  }

  /** Ends a verification that reached no verdict (not provisioned, read failure) without counting it. */
  deletePending(): void {
    this.isPending = false;
  }

  // Count kept past a lockout until a success → every later failure locks again (stricter, safer reading)
  setResult(isMatch: boolean): void {
    this.isPending = false;
    if (isMatch) {
      this.failures = 0;
      this.blockedUntil = 0;
      return;
    }
    this.failures += 1;
    this.blockedUntil = this.now() + getDelayMs(this.failures);
  }
}

function getDelayMs(failures: number): number {
  if (failures >= LOGIN_LIMIT.LOCKOUT.FAILURES) return LOGIN_LIMIT.LOCKOUT.MS;
  if (failures <= LOGIN_LIMIT.FREE_FAILURES) return 0;
  return Math.min(LOGIN_LIMIT.DELAY_MS.BASE * 2 ** (failures - LOGIN_LIMIT.FREE_FAILURES - 1), LOGIN_LIMIT.DELAY_MS.MAX);
}
