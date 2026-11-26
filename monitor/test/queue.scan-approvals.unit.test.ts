// Secret-scan approval store: the canonical line hash against the shared vectors, register / approve / delete /
// consume / expiry, and the owner's display form with its value cue.
// Runner: npx tsx --test test/queue.scan-approvals.unit.test.ts (no database)

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { QueueRequestError } from "../src/server/queue/errors.js";
import {
  type DisplaySegment,
  type SecretRequestInput,
  SECRET_REQUEST_LIMIT,
  SecretRequestRepository,
  getLineDisplay,
  getLineHash,
} from "../src/server/queue/scan-approvals.js";

const FIELD_LENGTH = SECRET_REQUEST_LIMIT.FIELD_LENGTH;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const VECTORS: { lines: Array<{ name: string; text: string; sha256: string }> } = JSON.parse(
  readFileSync(new URL("../../hooks/test/fixtures/scan-approval-vectors.json", import.meta.url), "utf8"),
);
const CONFIG_PATH = "/Users/dev/projects/shop/src/config/database.ts";
const LINE = {
  host: `export const dbHost = "db.internal.example";`,
  port: `export const dbPort = 5432;`,
};

// node:crypto directly, not the module's hash → a create fixture does not lean on the code under test
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function createStore() {
  const clock = { at: new Date("2026-11-25T05:56:12.345Z") };
  const store = new SecretRequestRepository(() => clock.at);
  const advance = (ms: number) => {
    clock.at = new Date(clock.at.getTime() + ms);
  };
  return { store, clock, advance };
}

function buildInput(lines: string[], overrides: Partial<SecretRequestInput> = {}): SecretRequestInput {
  return {
    sessionId: "8f3c2a71-5d4e-4b9a-a1c6-0e7f9b2d4c13",
    agent: { id: "a1b2c3d4e5f6", type: "glass-atrium-dev-node" },
    path: CONFIG_PATH,
    rule: "SEC-013",
    lines: lines.map((text) => ({ text, hash: sha256(text) })),
    ...overrides,
  };
}

function buildWrite(input: SecretRequestInput) {
  return { sessionId: input.sessionId, path: input.path, rule: input.rule, hashes: input.lines.map((line) => line.hash) };
}

function getRefusalCode(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    assert.ok(error instanceof QueueRequestError, `expected a QueueRequestError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected the call to be refused");
}

const reconstruct = (segments: DisplaySegment[]): string =>
  segments.map((segment) => ("text" in segment ? segment.text : String.fromCodePoint(Number.parseInt(segment.mark.slice(2), 16)))).join("");

describe("canonical line hash", () => {
  for (const vector of VECTORS.lines) {
    test(`${vector.name}: hashes to the shared vector`, () => {
      assert.equal(getLineHash(vector.text), vector.sha256);
    });
  }
});

describe("register", () => {
  test("a request whose hashes match its lines is held pending for 24 hours under the write's tuple", () => {
    const { store, clock } = createStore();
    const input = buildInput([LINE.host]);

    const id = store.create(input);

    assert.deepEqual(store.find(id), {
      id,
      state: "pending",
      sessionId: input.sessionId,
      agent: input.agent,
      path: CONFIG_PATH,
      rule: "SEC-013",
      hashes: [sha256(LINE.host)],
      createdAt: clock.at,
      expiresAt: new Date(clock.at.getTime() + 24 * HOUR_MS),
    });
  });

  const tooLong = "x".repeat(SECRET_REQUEST_LIMIT.REQUEST_BYTES + 1);
  const refusals: Array<{ name: string; input: SecretRequestInput; code: string }> = [
    { name: "a hash that is not the line's", input: { ...buildInput([LINE.host]), lines: [{ text: LINE.host, hash: sha256(LINE.port) }] }, code: "secret_line_hash_mismatch" },
    { name: "a rule other than SEC-013", input: buildInput([LINE.host], { rule: "SEC-014" }), code: "secret_rule_not_approvable" },
    { name: "no lines", input: buildInput([]), code: "secret_request_size" },
    { name: "one line past the line cap", input: buildInput(Array.from({ length: SECRET_REQUEST_LIMIT.REQUEST_LINES + 1 }, (_, i) => `retries${i} = ${i}`)), code: "secret_request_size" },
    { name: "one byte past the byte cap", input: buildInput([tooLong]), code: "secret_request_size" },
    { name: "a line holding an LF", input: buildInput([`${LINE.host}\n${LINE.port}`]), code: "secret_line_malformed" },
    { name: "a line holding a lone surrogate", input: buildInput([`label = "\uD83D"`]), code: "secret_line_malformed" },
    { name: "a session id past its length cap", input: buildInput([LINE.host], { sessionId: "8".repeat(FIELD_LENGTH.SESSION_ID + 1) }), code: "secret_request_field_length" },
    { name: "a path past its length cap", input: buildInput([LINE.host], { path: `/${"p".repeat(FIELD_LENGTH.PATH)}` }), code: "secret_request_field_length" },
    { name: "an agent id past its length cap", input: buildInput([LINE.host], { agent: { id: "a".repeat(FIELD_LENGTH.AGENT_ID + 1), type: "glass-atrium-dev-node" } }), code: "secret_request_field_length" },
    { name: "an agent type past its length cap", input: buildInput([LINE.host], { agent: { id: "a1b2c3d4e5f6", type: "t".repeat(FIELD_LENGTH.AGENT_TYPE + 1) } }), code: "secret_request_field_length" },
  ];
  for (const row of refusals) {
    test(`${row.name} is refused`, () => {
      const { store } = createStore();

      assert.equal(getRefusalCode(() => store.create(row.input)), row.code);
    });
  }

  test("a session id, path, agent id and agent type each at its length cap are accepted", () => {
    const { store } = createStore();
    const input = buildInput([LINE.host], {
      sessionId: "8".repeat(FIELD_LENGTH.SESSION_ID),
      path: `/${"p".repeat(FIELD_LENGTH.PATH - 1)}`,
      agent: { id: "a".repeat(FIELD_LENGTH.AGENT_ID), type: "t".repeat(FIELD_LENGTH.AGENT_TYPE) },
    });

    assert.equal(store.find(store.create(input))?.state, "pending");
  });

  test("a refusal's message names no line text", () => {
    const { store } = createStore();
    const input = { ...buildInput([LINE.host]), lines: [{ text: LINE.host, hash: sha256(LINE.port) }] };

    let message = "";
    try {
      store.create(input);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    assert.notEqual(message, "");
    assert.equal(message.includes("db.internal.example"), false);
  });

  test("a repeat of the same session, path, rule and line set returns the pending request's id", () => {
    const { store } = createStore();
    const id = store.create(buildInput([LINE.host, LINE.port]));

    const repeat = store.create(buildInput([LINE.port, LINE.host]));

    assert.equal(repeat, id);
  });

  const changes: Array<{ name: string; input: SecretRequestInput }> = [
    { name: "another session", input: buildInput([LINE.host], { sessionId: randomUUID() }) },
    { name: "another path", input: buildInput([LINE.host], { path: "/Users/dev/projects/shop/src/config/cache.ts" }) },
    { name: "another line set", input: buildInput([LINE.host, LINE.port]) },
  ];
  for (const row of changes) {
    test(`${row.name} makes a new request`, () => {
      const { store } = createStore();
      const id = store.create(buildInput([LINE.host]));

      const other = store.create(row.input);

      assert.notEqual(other, id);
    });
  }
});

describe("register caps", () => {
  test("a session at its request cap is refused while another session is still accepted", () => {
    const { store } = createStore();
    const sessionId = randomUUID();
    for (let i = 0; i < SECRET_REQUEST_LIMIT.SESSION_REQUESTS; i += 1) store.create(buildInput([`retries = ${i}`], { sessionId }));

    const code = getRefusalCode(() => store.create(buildInput([LINE.host], { sessionId })));

    assert.equal(code, "secret_request_cap");
    assert.equal(typeof store.create(buildInput([LINE.host], { sessionId: randomUUID() })), "string");
  });

  test("the machine at its request cap refuses a new session's request", () => {
    const { store } = createStore();
    for (let i = 0; i < SECRET_REQUEST_LIMIT.MACHINE_REQUESTS; i += 1) store.create(buildInput([`retries = ${i}`], { sessionId: randomUUID() }));

    const code = getRefusalCode(() => store.create(buildInput([LINE.host], { sessionId: randomUUID() })));

    assert.equal(code, "secret_request_cap");
  });

  test("a repeat at the session cap still returns its pending request's id", () => {
    const { store } = createStore();
    const sessionId = randomUUID();
    const ids = Array.from({ length: SECRET_REQUEST_LIMIT.SESSION_REQUESTS }, (_, i) => store.create(buildInput([`retries = ${i}`], { sessionId })));

    const repeat = store.create(buildInput(["retries = 0"], { sessionId }));

    assert.equal(repeat, ids[0]);
  });
});

describe("approve", () => {
  test("approval keeps the hashes, removes the lines from the store and lives 10 minutes from the yes", () => {
    const { store, clock, advance } = createStore();
    const id = store.create(buildInput([LINE.host]));
    advance(3 * HOUR_MS);

    store.approve(id);

    const facts = store.find(id);
    assert.deepEqual(
      { state: facts?.state, hashes: facts?.hashes, expiresAt: facts?.expiresAt, lines: store.findLines(id) },
      { state: "approved", hashes: [sha256(LINE.host)], expiresAt: new Date(clock.at.getTime() + 10 * MINUTE_MS), lines: null },
    );
  });

  test("an approval given the time of the yes lives 10 minutes from that time, however late it turns approved", () => {
    const { store, clock, advance } = createStore();
    const id = store.create(buildInput([LINE.host]));
    const yesAt = clock.at;
    advance(4 * MINUTE_MS);

    store.approve(id, yesAt);

    assert.deepEqual(store.find(id)?.expiresAt, new Date(yesAt.getTime() + 10 * MINUTE_MS));
  });

  test("a caller time later than the store's clock never extends the approval past 10 minutes", () => {
    const { store, clock, advance } = createStore();
    const input = buildInput([LINE.host]);
    const id = store.create(input);
    store.approve(id, new Date(clock.at.getTime() + HOUR_MS));
    advance(11 * MINUTE_MS);

    assert.equal(store.consume(buildWrite(input)), null);
  });

  test("a request checked pending stays pending: its lines kept, no write consumes it", () => {
    const { store } = createStore();
    const input = buildInput([LINE.host]);
    const id = store.create(input);

    store.assertPending(id);

    assert.deepEqual({ state: store.find(id)?.state, lines: store.findLines(id)?.length, passed: store.consume(buildWrite(input)) }, { state: "pending", lines: 1, passed: null });
  });

  const refusals: Array<{ name: string; arrange: (fixture: ReturnType<typeof createStore>) => string; code: string }> = [
    { name: "an unknown request", arrange: () => randomUUID(), code: "secret_request_gone" },
    { name: "a declined request", arrange: ({ store }) => { const id = store.create(buildInput([LINE.host])); store.delete(id); return id; }, code: "secret_request_gone" },
    { name: "a pending request past 24 hours", arrange: ({ store, advance }) => { const id = store.create(buildInput([LINE.host])); advance(24 * HOUR_MS); return id; }, code: "secret_request_gone" },
    { name: "an already approved request", arrange: ({ store }) => { const id = store.create(buildInput([LINE.host])); store.approve(id); return id; }, code: "secret_request_not_pending" },
  ];
  const operations: Array<{ name: string; run: (store: SecretRequestRepository, id: string) => void }> = [
    { name: "approving", run: (store, id) => store.approve(id) },
    { name: "checking pending", run: (store, id) => store.assertPending(id) },
  ];
  for (const operation of operations) {
    for (const row of refusals) {
      test(`${operation.name} ${row.name} is a conflict`, () => {
        const fixture = createStore();
        const id = row.arrange(fixture);

        const code = getRefusalCode(() => operation.run(fixture.store, id));

        assert.equal(code, row.code);
      });
    }
  }
});

describe("decline and withdraw", () => {
  test("delete removes the request from the store", () => {
    const { store } = createStore();
    const id = store.create(buildInput([LINE.host]));

    const isDeleted = store.delete(id);

    assert.deepEqual({ isDeleted, facts: store.find(id), lines: store.findLines(id) }, { isDeleted: true, facts: null, lines: null });
  });

  test("delete of an unknown request reports nothing deleted", () => {
    const { store } = createStore();

    assert.equal(store.delete(randomUUID()), false);
  });
});

describe("consume", () => {
  const approve = (lines: string[]) => {
    const fixture = createStore();
    const input = buildInput(lines);
    const id = fixture.store.create(input);
    fixture.store.approve(id);
    return { ...fixture, id, write: buildWrite(input) };
  };

  test("the exact write passes once: the approval is removed from the store in the same step", () => {
    const { store, id, write } = approve([LINE.host, LINE.port]);

    const passed = store.consume({ ...write, hashes: [...write.hashes].reverse() });

    assert.deepEqual({ passed, facts: store.find(id), repeat: store.consume(write) }, { passed: id, facts: null, repeat: null });
  });

  test("a write repeating an approved line passes: hashes compare as a set", () => {
    const { store, id, write } = approve([LINE.host]);

    assert.equal(store.consume({ ...write, hashes: [...write.hashes, ...write.hashes] }), id);
  });

  const host = sha256(LINE.host);
  const port = sha256(LINE.port);
  const refusals: Array<{ name: string; change: (write: ReturnType<typeof buildWrite>) => ReturnType<typeof buildWrite> }> = [
    { name: "a subset of the approved lines", change: (write) => ({ ...write, hashes: [host] }) },
    { name: "a superset of the approved lines", change: (write) => ({ ...write, hashes: [host, port, sha256("retries = 3")] }) },
    { name: "another line set of the same size", change: (write) => ({ ...write, hashes: [host, sha256("retries = 3")] }) },
    { name: "another path", change: (write) => ({ ...write, path: `${CONFIG_PATH}.bak` }) },
    { name: "another session", change: (write) => ({ ...write, sessionId: randomUUID() }) },
    { name: "another rule", change: (write) => ({ ...write, rule: "SEC-014" }) },
  ];
  for (const row of refusals) {
    test(`${row.name} is refused`, () => {
      const { store, write } = approve([LINE.host, LINE.port]);

      assert.equal(store.consume(row.change(write)), null);
    });
  }

  test("a refused write leaves the approval for the exact write", () => {
    const { store, id, write } = approve([LINE.host, LINE.port]);
    store.consume({ ...write, hashes: [host] });

    assert.equal(store.consume(write), id);
  });

  test("a pending request is never consumed", () => {
    const { store } = createStore();
    const input = buildInput([LINE.host]);
    store.create(input);

    assert.equal(store.consume(buildWrite(input)), null);
  });

  const ages = [
    { name: "10 minutes less 1 ms after the yes passes", ageMs: 10 * MINUTE_MS - 1, isPassed: true },
    { name: "exactly 10 minutes after the yes is refused", ageMs: 10 * MINUTE_MS, isPassed: false },
    { name: "10 minutes and 1 s after the yes is refused", ageMs: 10 * MINUTE_MS + 1_000, isPassed: false },
  ];
  for (const row of ages) {
    test(`an approval used ${row.name}`, () => {
      const { store, advance, write } = approve([LINE.host]);
      advance(row.ageMs);

      assert.equal(store.consume(write) !== null, row.isPassed);
    });
  }
});

describe("expiry on every access", () => {
  const accessors: Array<{ name: string; read: (store: SecretRequestRepository, id: string) => unknown; gone: unknown }> = [
    { name: "find", read: (store, id) => store.find(id), gone: null },
    { name: "findLines", read: (store, id) => store.findLines(id), gone: null },
    { name: "delete", read: (store, id) => store.delete(id), gone: false },
  ];
  for (const row of accessors) {
    test(`${row.name} treats a pending request at 24 hours as gone`, () => {
      const { store, advance } = createStore();
      const id = store.create(buildInput([LINE.host]));
      advance(24 * HOUR_MS);

      assert.deepEqual(row.read(store, id), row.gone);
    });
  }

  test("an expired request no longer counts toward its session's cap", () => {
    const { store, advance } = createStore();
    const sessionId = randomUUID();
    for (let i = 0; i < SECRET_REQUEST_LIMIT.SESSION_REQUESTS; i += 1) store.create(buildInput([`retries = ${i}`], { sessionId }));
    advance(24 * HOUR_MS);

    assert.equal(typeof store.create(buildInput([LINE.host], { sessionId })), "string");
  });

  test("the sweep removes expired requests and keeps live ones", () => {
    const { store, advance } = createStore();
    const old = store.create(buildInput([LINE.host]));
    advance(23 * HOUR_MS);
    const fresh = store.create(buildInput([LINE.port]));
    advance(HOUR_MS);

    const removed = store.deleteExpired();

    assert.deepEqual({ removed, old: store.find(old), fresh: store.find(fresh)?.state }, { removed: 1, old: null, fresh: "pending" });
  });
});

describe("owner display", () => {
  test("the owner's read carries each captured line with its hash, display and value facts", () => {
    const { store } = createStore();
    const id = store.create(buildInput([LINE.host]));

    assert.deepEqual(store.findLines(id), [{ hash: sha256(LINE.host), ...getLineDisplay(LINE.host) }]);
  });

  const longLine = `export const dbHost = "${"h".repeat(SECRET_REQUEST_LIMIT.REQUEST_BYTES - 40)}";`;
  const lines = [...VECTORS.lines.map((vector) => ({ name: vector.name, text: vector.text })), { name: "a line at the byte cap", text: longLine }];
  for (const row of lines) {
    test(`${row.name}: the display restores the whole line, never truncated`, () => {
      assert.equal(reconstruct(getLineDisplay(row.text).segments), row.text);
    });
  }

  const toMark = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  const isShownAsMark = (codePoint: number): boolean =>
    isDeepStrictEqual(getLineDisplay(`a${String.fromCodePoint(codePoint)}b`).segments, [{ text: "a" }, { mark: toMark(codePoint) }, { text: "b" }]);
  const expandRanges = (ranges: ReadonlyArray<readonly [number, number]>): number[] =>
    ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => first + index));

  // non-ASCII spaces, Hangul fillers, Khmer inherent vowels, grapheme joiner, Mongolian and Unicode variation selectors,
  // braille blank, musical null notehead
  const namedMarkRanges = [
    [0x00a0, 0x00a0], [0x1680, 0x1680], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
    [0x115f, 0x1160], [0x3164, 0x3164], [0xffa0, 0xffa0], [0x17b4, 0x17b5], [0x034f, 0x034f], [0x180b, 0x180f],
    [0xfe00, 0xfe0f], [0xe0100, 0xe01ef], [0x2800, 0x2800], [0x1d159, 0x1d159],
  ] as const;

  test("every control, format, surrogate, separator, combining mark, private-use, unassigned and named invisible or look-alike code point is shown as a mark", () => {
    const markedCategory = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Mn}\p{Me}\p{Co}\p{Cn}]/u;
    const categoryMembers = expandRanges([[0, 0x10ffff]]).filter((codePoint) => markedCategory.test(String.fromCodePoint(codePoint)));
    const members = [...categoryMembers, ...expandRanges(namedMarkRanges)];

    assert.deepEqual(members.filter((codePoint) => !isShownAsMark(codePoint)).map(toMark), []);
  });

  // one row per listed invisible or look-alike code point, then each C0/C1, zero-width and bidi range at its ends
  const marked = [
    0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x2028, 0x2029, 0xfeff, 0xfff9, 0xfffa, 0xfffb,
    0x0000, 0x0009, 0x000d, 0x001f, 0x007f, 0x0080, 0x009f, 0x200b, 0x200c, 0x200d, 0x2060, 0x2064,
    0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069,
  ];
  for (const codePoint of marked) {
    const mark = toMark(codePoint);
    test(`${mark} inside a line is shown as a visible mark`, () => {
      const display = getLineDisplay(`dbHost = "a${String.fromCodePoint(codePoint)}b"`);

      assert.deepEqual(display.segments, [{ text: `dbHost = "a` }, { mark }, { text: `b"` }]);
    });
  }

  test("trailing spaces are marks, inner spaces stay text", () => {
    assert.deepEqual(getLineDisplay("dbHost = local  ").segments, [{ text: "dbHost = local" }, { mark: "U+0020" }, { mark: "U+0020" }]);
  });

  test("ordinary text in any script is one text segment", () => {
    const text = `라벨 = "카페 café 🔑"`;

    assert.deepEqual(getLineDisplay(text).segments, [{ text }]);
  });

  const cues = [
    { name: "a double-quoted value", text: `dbPass = "Xy9#kLm2pQ";`, cue: "literal" },
    { name: "a single-quoted value inside an object", text: `const db = { pass: 'Xy9#kLm2pQ' };`, cue: "literal" },
    { name: "a bare value with symbols", text: `DB_PASS=Xy9#kLm2/pQ`, cue: "literal" },
    { name: "a call", text: `dbPass = vault.read("db/pass");`, cue: "literal" },
    { name: "a line with no assignment", text: `connect(dbPass)`, cue: "literal" },
    { name: "a literal beside a reference", text: `const db = { user: process.env.DB_USER, pass: "Xy9#kLm2pQ" };`, cue: "literal" },
    { name: "a bare identifier", text: `dbPass = loadedPass;`, cue: "identifier" },
    { name: "a member path", text: `dbPass: settings.database.pass,`, cue: "member" },
    { name: "process.env", text: `const dbPass = process.env.DB_PASS;`, cue: "environment" },
    { name: "a shell variable", text: `DB_PASS=$DB_PASS_FROM_VAULT`, cue: "environment" },
    { name: "a quoted interpolation", text: `pass: "\${DB_PASS}"`, cue: "environment" },
    { name: "os.environ", text: `db_pass = os.environ["DB_PASS"]`, cue: "environment" },
    { name: "an object of environment references", text: `const db = { pass: process.env.DB_PASS };`, cue: "environment" },
  ];
  for (const row of cues) {
    test(`${row.name} reads as ${row.cue}`, () => {
      assert.equal(getLineDisplay(row.text).value.cue, row.cue);
    });
  }

  test("the value's length counts code points and its classes are listed in a fixed order", () => {
    const { value } = getLineDisplay(`dbPass = "가b1-Z";`);

    assert.deepEqual(value, { cue: "literal", length: 5, classes: ["lower", "upper", "digit", "symbol", "non-ascii"] });
  });

  const keyScripts = [
    { name: "a Cyrillic letter in the key", text: `dbP\u0430ss = "Xy9";`, classes: ["lower", "upper", "digit", "key: cyrillic"] },
    { name: "a Greek letter in the prefix", text: `exp\u03bfrt const dbPass = "Xy9";`, classes: ["lower", "upper", "digit", "key: greek"] },
    { name: "a fullwidth Latin letter in the key", text: `\uff44bPass = "Xy9";`, classes: ["lower", "upper", "digit", "key: latin"] },
    { name: "a Hangul key and a Cyrillic comment", text: `\uc554\ud638 = "Xy9"; // \u043f\u0430\u0440\u043e\u043b\u044c`, classes: ["lower", "upper", "digit", "key: cyrillic", "key: hangul"] },
    { name: "a letter of a script with no own entry", text: `\u1200dbPass = "Xy9";`, classes: ["lower", "upper", "digit", "key: other"] },
    { name: "a non-ASCII value beside an ASCII key", text: `dbPass = "\u0425y9";`, classes: ["lower", "digit", "non-ascii"] },
  ];
  for (const row of keyScripts) {
    test(`${row.name}: the classes carry one key entry per non-ASCII script outside the value`, () => {
      assert.deepEqual(getLineDisplay(row.text).value.classes, row.classes);
    });
  }

  test("a quoted value's space is its own class", () => {
    assert.deepEqual(getLineDisplay(`dbPass = "ab cd";`).value.classes, ["lower", "space"]);
  });
});
