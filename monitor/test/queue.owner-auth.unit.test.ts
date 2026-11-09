// Owner auth primitives of the queue: the in-memory owner session store, the login limiter, the passphrase verifier.
// Runner: npx tsx --test test/queue.owner-auth.unit.test.ts (no DB; the passphrase file lives in a mktemp dir).

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { LOGIN_LIMIT, LoginLimiter } from "../src/server/queue/login-limiter.js";
import { OWNER_COOKIE, OwnerSessionStore } from "../src/server/queue/owner-session.js";
import { PASSPHRASE, createPassphraseVerifier } from "../src/server/queue/passphrase.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const SESSION_TTL_MS = OWNER_COOKIE.MAX_AGE_SECONDS * 1000;
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "queue-owner-auth-"));

after(() => deleteDirectory(fixtureRoot));

function createClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keyLength: 32 };

function writePassphraseFile(dir: string, passphrase: string, overrides: object = {}, params = SCRYPT_PARAMS): void {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, params.keyLength, { N: params.N, r: params.r, p: params.p });
  const record = { algorithm: "scrypt", ...params, salt: salt.toString("base64"), hash: hash.toString("base64"), ...overrides };
  writeFileSync(path.join(dir, PASSPHRASE.FILE), JSON.stringify(record), { mode: 0o600 });
}

function makeSecretsDir(name: string): string {
  const dir = path.join(fixtureRoot, name);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

describe("owner session store", () => {
  test("a created session is valid until its sliding expiry, and each renewal pushes the expiry out", () => {
    const clock = createClock();
    const store = new OwnerSessionStore(clock.now);
    const id = store.create();
    clock.advance(SESSION_TTL_MS - 1);
    assert.equal(store.renew(id), true, "valid one ms before expiry");
    clock.advance(SESSION_TTL_MS - 1);
    assert.equal(store.renew(id), true, "the renewal above moved the expiry");
    clock.advance(SESSION_TTL_MS);
    assert.equal(store.renew(id), false, "expired after a full idle TTL");
    assert.equal(store.renew(id), false, "an expired id stays invalid");
  });

  test("an unknown or deleted id is never valid", () => {
    const store = new OwnerSessionStore(createClock().now);
    const id = store.create();
    store.delete(id);
    assert.equal(store.renew(id), false, "deleted");
    assert.equal(store.renew(randomBytes(32).toString("base64url")), false, "never issued");
  });

  test("ids are 256-bit random and distinct", () => {
    const store = new OwnerSessionStore(createClock().now);
    const ids = new Set(Array.from({ length: 50 }, () => store.create()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.equal(Buffer.from(id, "base64url").length, 32, id);
  });

  test("the store keeps at most its cap of sessions, evicting the oldest", () => {
    const store = new OwnerSessionStore(createClock().now);
    const ids = Array.from({ length: OWNER_COOKIE.MAX_SESSIONS + 1 }, () => store.create());
    assert.equal(store.renew(ids[0] ?? ""), false, "oldest evicted");
    assert.equal(store.renew(ids[ids.length - 1] ?? ""), true, "newest kept");
  });
});

describe("login limiter", () => {
  test("the free failures pass with no wait, then the wait doubles per failure up to its ceiling", () => {
    const clock = createClock();
    const limiter = new LoginLimiter(clock.now);
    const waits: number[] = [];
    for (let failure = 1; failure < LOGIN_LIMIT.LOCKOUT.FAILURES; failure += 1) {
      limiter.setPending();
      limiter.setResult(false);
      waits.push(limiter.getWaitMs());
      clock.advance(limiter.getWaitMs());
    }
    const expected = Array.from({ length: LOGIN_LIMIT.LOCKOUT.FAILURES - 1 }, (_, index) => {
      const failure = index + 1;
      if (failure <= LOGIN_LIMIT.FREE_FAILURES) return 0;
      return Math.min(LOGIN_LIMIT.DELAY_MS.BASE * 2 ** (failure - LOGIN_LIMIT.FREE_FAILURES - 1), LOGIN_LIMIT.DELAY_MS.MAX);
    });
    assert.deepEqual(waits, expected);
  });

  test("repeated failures lock the login for the lockout period", () => {
    const clock = createClock();
    const limiter = new LoginLimiter(clock.now);
    for (let failure = 1; failure <= LOGIN_LIMIT.LOCKOUT.FAILURES; failure += 1) {
      clock.advance(limiter.getWaitMs());
      limiter.setPending();
      limiter.setResult(false);
    }
    assert.equal(limiter.getWaitMs(), LOGIN_LIMIT.LOCKOUT.MS, "locked right after the last failure");
    clock.advance(LOGIN_LIMIT.LOCKOUT.MS - 1);
    assert.equal(limiter.getWaitMs(), 1, "still locked one ms before the end");
    clock.advance(1);
    assert.equal(limiter.getWaitMs(), 0, "open once the lockout passed");
  });

  test("a success clears the failure count", () => {
    const clock = createClock();
    const limiter = new LoginLimiter(clock.now);
    for (let failure = 1; failure <= LOGIN_LIMIT.FREE_FAILURES + 2; failure += 1) {
      clock.advance(limiter.getWaitMs());
      limiter.setPending();
      limiter.setResult(false);
    }
    clock.advance(limiter.getWaitMs());
    limiter.setPending();
    limiter.setResult(true);
    limiter.setPending();
    limiter.setResult(false);
    assert.equal(limiter.getWaitMs(), 0, "the first failure after a success is free again");
  });

  test("a verification in flight makes every other attempt wait", () => {
    const limiter = new LoginLimiter(createClock().now);
    limiter.setPending();
    assert.ok(limiter.getWaitMs() > 0, "second attempt waits while the first is verified");
    limiter.setResult(true);
    assert.equal(limiter.getWaitMs(), 0);
  });
});

describe("passphrase verifier", () => {
  test("the stored scrypt hash matches its passphrase only", async () => {
    const dir = makeSecretsDir("match");
    writePassphraseFile(dir, "correct horse battery staple");
    const verifier = createPassphraseVerifier(dir);
    assert.equal(await verifier.verify("correct horse battery staple"), "match");
    assert.equal(await verifier.verify("correct horse battery stapler"), "mismatch");
    assert.equal(await verifier.verify(""), "mismatch");
  });

  test("a missing file is not provisioned, and a file written later is picked up with no restart", async () => {
    const dir = makeSecretsDir("late");
    const verifier = createPassphraseVerifier(dir);
    assert.equal(await verifier.verify("late passphrase"), "not_provisioned");
    assert.equal(await verifier.isProvisioned(), false);
    writePassphraseFile(dir, "late passphrase");
    assert.equal(await verifier.isProvisioned(), true);
    assert.equal(await verifier.verify("late passphrase"), "match");
  });

  test("a malformed or out-of-bounds record is refused as an environment failure, never as a match", async () => {
    const rows = [
      { name: "not JSON", content: "scrypt$abc" },
      { name: "unknown algorithm", overrides: { algorithm: "pbkdf2" } },
      { name: "N not a power of two", overrides: { N: 20_000 } },
      { name: "N one step above the memory ceiling", overrides: { N: 2 ** 21 } },
      { name: "r above the memory ceiling", overrides: { r: 9 } },
      { name: "p above its cap", overrides: { p: 5 } },
      { name: "salt shorter than 16 bytes", overrides: { salt: randomBytes(8).toString("base64") } },
      { name: "hash length differs from keyLength", overrides: { keyLength: 64 } },
      { name: "unknown key", overrides: { pepper: "x" } },
    ];
    for (const row of rows) {
      const dir = makeSecretsDir(`bad-${row.name.replaceAll(" ", "-")}`);
      if (row.content === undefined) writePassphraseFile(dir, "pw", row.overrides);
      else writeFileSync(path.join(dir, PASSPHRASE.FILE), row.content, { mode: 0o600 });
      await assert.rejects(createPassphraseVerifier(dir).verify("pw"), { name: "QueueEnvironmentError" }, row.name);
    }
  });

  test("a record at the r and p caps still verifies", async () => {
    const dir = makeSecretsDir("at-caps");
    writePassphraseFile(dir, "capped passphrase", {}, { ...SCRYPT_PARAMS, r: 8, p: 4 });
    assert.equal(await createPassphraseVerifier(dir).verify("capped passphrase"), "match");
  });

  // A logged error carries its message, stack and every cause → none of them may quote the record
  test("a refused record's error chain carries none of the file's text", async () => {
    const secretText = "zq7-secret-material";
    const rows = [
      { name: "not JSON", content: `${secretText} is not JSON` },
      { name: "malformed", content: JSON.stringify({ algorithm: "scrypt", N: secretText }) },
    ];
    for (const row of rows) {
      const dir = makeSecretsDir(`chain-${row.name.replaceAll(" ", "-")}`);
      writeFileSync(path.join(dir, PASSPHRASE.FILE), row.content, { mode: 0o600 });
      const error = await createPassphraseVerifier(dir).verify("pw").then(
        () => assert.fail(`${row.name}: resolved`),
        (rejection: unknown) => rejection,
      );
      assert.equal(getErrorChainText(error).includes(secretText.slice(0, 6)), false, row.name);
    }
  });
});

function getErrorChainText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.message}\n${error.stack ?? ""}\n${error.cause === undefined ? "" : getErrorChainText(error.cause)}`;
}
