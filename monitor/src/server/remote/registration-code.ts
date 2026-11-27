// One-time registration code for adding a remote device: opened on the Mac's loopback page, entered once on the device.
// Memory only → a monitor restart closes any open registration.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const REGISTRATION_CODE = {
  // 2-9 + A-Z without I and O → 32 symbols, no 0/O or 1/I confusion
  ALPHABET: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",
  // 8 symbols × 5 bits = 40 bits
  LENGTH: 8,
  WINDOW_MS: 5 * 60_000,
  // counted per code, not per address → spreading guesses over addresses buys nothing
  MAX_FAILURES: 5,
} as const;

/** One opaque outcome for wrong, expired, burned and "none open" → a caller learns nothing from a refusal. */
export type CodeOutcome = "accepted" | "refused";

interface OpenCode {
  readonly digest: Buffer;
  readonly expiresAt: number;
  failures: number;
}

export interface RegistrationCodesOptions {
  readonly now: () => number;
}

export class RegistrationCodes {
  readonly #now: () => number;
  #open: OpenCode | null = null;

  constructor(options: RegistrationCodesOptions = { now: Date.now }) {
    this.#now = options.now;
  }

  /** Opens a registration, replacing any open one. @returns the code, for the Mac's page only — never log or store it */
  open(): string {
    let code = "";
    for (let index = 0; index < REGISTRATION_CODE.LENGTH; index += 1) {
      code += REGISTRATION_CODE.ALPHABET[randomInt(REGISTRATION_CODE.ALPHABET.length)];
    }
    this.#open = { digest: getDigest(code), expiresAt: this.#now() + REGISTRATION_CODE.WINDOW_MS, failures: 0 };
    return code;
  }

  /** Spends one entry: the right code closes the registration (single use), a wrong one counts toward burning it. */
  consume(entry: string): CodeOutcome {
    const open = this.#open;
    if (open === null) return "refused";
    if (this.#now() >= open.expiresAt) {
      this.#open = null;
      return "refused";
    }
    // equal-length digests → timingSafeEqual never throws and the compare time is independent of the entry
    if (timingSafeEqual(getDigest(entry.trim().toUpperCase()), open.digest)) {
      this.#open = null;
      return "accepted";
    }
    open.failures += 1;
    if (open.failures >= REGISTRATION_CODE.MAX_FAILURES) this.#open = null;
    return "refused";
  }
}

function getDigest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}
