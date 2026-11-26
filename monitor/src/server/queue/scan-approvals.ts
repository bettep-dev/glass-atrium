// Scan-approval store: the SEC-013 lines a secret-scan refusal captured, held in this process's memory only until the
// owner approves one write of them, declines, or they expire. No route, no persistence: never on disk, in the
// database, in a log or in an item; a monitor restart empties it.

import { createHash, randomUUID } from "node:crypto";

import { INVISIBLE_CHARACTER } from "./envelope.js";
import { QueueRequestError } from "./errors.js";

/** Per-request, per-session and per-machine bounds; past any of them the hook refuses as it does without the store. */
export const SECRET_REQUEST_LIMIT = {
  REQUEST_LINES: 16,
  REQUEST_BYTES: 4096,
  SESSION_REQUESTS: 8,
  MACHINE_REQUESTS: 64,
  PENDING_MS: 24 * 60 * 60_000,
  APPROVED_MS: 10 * 60_000,
  // UTF-16 code units, as Zod's string max counts → the register schema takes these caps
  FIELD_LENGTH: { SESSION_ID: 36, PATH: 4096, AGENT_ID: 64, AGENT_TYPE: 128 },
} as const;

// the generic credential-assignment rule only → token, key and connection-string shapes stay unapprovable
const APPROVABLE_RULE = "SEC-013";

/** The requesting agent — shown to the owner, never part of what an approval binds. */
export interface SecretRequestAgent {
  readonly id: string;
  readonly type: string;
}

export interface SecretRequestInput {
  readonly sessionId: string;
  readonly agent: SecretRequestAgent;
  /** Realpath of the write target (a new file: its parent's realpath plus the basename). */
  readonly path: string;
  readonly rule: string;
  /** Every SEC-013 line of the write, each with its hash by `getLineHash`. */
  readonly lines: ReadonlyArray<{ readonly text: string; readonly hash: string }>;
}

/** What a retried write carries: the hook's tuple and the hash of every SEC-013 line in it. */
export interface SecretWrite {
  readonly sessionId: string;
  readonly path: string;
  readonly rule: string;
  readonly hashes: readonly string[];
}

/** A request's facts — everything but its lines; `expiresAt` is 24 h after register, then 10 min after the yes. */
export interface SecretRequestFacts {
  readonly id: string;
  readonly state: "pending" | "approved";
  readonly sessionId: string;
  readonly agent: SecretRequestAgent;
  readonly path: string;
  readonly rule: string;
  readonly hashes: readonly string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** One run of ordinary text, or one invisible or look-alike code point as `U+XXXX`. */
export type DisplaySegment = { readonly text: string } | { readonly mark: string };

export type ValueCue = "literal" | "identifier" | "member" | "environment";

export type ValueClass = "lower" | "upper" | "digit" | "space" | "symbol" | "non-ascii";

/** A non-ASCII script found in the line outside the value; a script with no own entry is `other`. */
export type KeyScript = (typeof KEY_SCRIPTS)[number][0] | "other";

export type LineClass = ValueClass | `key: ${KeyScript}`;

export interface LineValue {
  readonly cue: ValueCue;
  /** Code points, not UTF-16 units. */
  readonly length: number;
  /** The value's classes in `VALUE_CLASS_ORDER`, then one `key: <script>` per non-ASCII script outside the value. */
  readonly classes: readonly LineClass[];
}

export interface LineDisplay {
  readonly segments: readonly DisplaySegment[];
  readonly value: LineValue;
}

export interface SecretLineView extends LineDisplay {
  readonly hash: string;
}

interface StoredRequest extends SecretRequestFacts {
  // null once approved → only the hashes outlive the owner's yes
  readonly lines: SecretRequestInput["lines"] | null;
}

/** In-memory store of scan-approval requests; every access first removes the expired ones from the store. */
export class SecretRequestRepository {
  private readonly requests = new Map<string, StoredRequest>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Registers a refused write's SEC-013 lines → its request id, pending for 24 h.
   * A repeat of a pending request's session, path, rule and line set returns that request's id, even at a cap.
   * @throws QueueRequestError — a rule other than SEC-013, a size past the caps, a malformed line, a hash that is not
   * its line's, or a session or machine at its request cap; no message carries line text
   */
  create(input: SecretRequestInput): string {
    assertRequestInput(input);
    this.deleteExpired();
    const repeat = this.findRepeat(input);
    if (repeat !== null) return repeat;
    this.assertCapacity(input.sessionId);
    const id = randomUUID();
    const createdAt = this.now();
    this.requests.set(id, {
      id,
      state: "pending",
      sessionId: input.sessionId,
      agent: { id: input.agent.id, type: input.agent.type },
      path: input.path,
      rule: input.rule,
      hashes: input.lines.map((line) => line.hash),
      lines: input.lines.map((line) => ({ text: line.text, hash: line.hash })),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SECRET_REQUEST_LIMIT.PENDING_MS),
    });
    return id;
  }

  /**
   * The owner's yes: the request turns approved for 10 minutes and its lines are removed from the store (hashes kept).
   * Lines are immutable after register and the id is a fresh UUID → the approved hashes are the ones the owner was shown.
   * @param approvedAt - the time of the yes → the 10 minutes run from it, however late the request turns approved;
   * a time later than the store's clock counts as the store's now
   * @throws QueueRequestError 409 — `secret_request_gone` (unknown, declined or expired) · `secret_request_not_pending`
   */
  approve(id: string, approvedAt: Date = this.now()): void {
    const request = this.getPendingOrThrow(id);
    const startMs = Math.min(approvedAt.getTime(), this.now().getTime());
    const expiresAt = new Date(startMs + SECRET_REQUEST_LIMIT.APPROVED_MS);
    this.requests.set(id, { ...request, state: "approved", lines: null, expiresAt });
  }

  /** The check `approve` makes, without approving → the request stays pending and unconsumable. */
  assertPending(id: string): void {
    this.getPendingOrThrow(id);
  }

  /** Decline or withdraw: removes the request from the store; false when it was already gone. */
  delete(id: string): boolean {
    this.deleteExpired();
    return this.requests.delete(id);
  }

  /**
   * A retried write → the id of the approval it uses, or null.
   * - passes only on an unexpired approval of the same session, path and rule whose hash set EQUALS the write's
   * - the approval is removed from the store in the same synchronous step → of two concurrent consumes one passes
   */
  consume(write: SecretWrite): string | null {
    this.deleteExpired();
    for (const request of this.requests.values()) {
      if (!isApprovedFor(request, write)) continue;
      this.requests.delete(request.id);
      return request.id;
    }
    return null;
  }

  find(id: string): SecretRequestFacts | null {
    this.deleteExpired();
    const request = this.requests.get(id);
    if (request === undefined) return null;
    return {
      id: request.id,
      state: request.state,
      sessionId: request.sessionId,
      agent: { ...request.agent },
      path: request.path,
      rule: request.rule,
      hashes: [...request.hashes],
      createdAt: new Date(request.createdAt),
      expiresAt: new Date(request.expiresAt),
    };
  }

  /** The owner's read of a pending request's lines → null once approved, declined or expired. */
  findLines(id: string): SecretLineView[] | null {
    this.deleteExpired();
    const request = this.requests.get(id);
    if (request === undefined || request.lines === null) return null;
    return request.lines.map((line) => ({ hash: line.hash, ...getLineDisplay(line.text) }));
  }

  /** Removes every request expired at `now` from the store → how many; the queue scheduler's sweep passes its own clock. */
  deleteExpired(now: Date = this.now()): number {
    let removed = 0;
    for (const [id, request] of this.requests) {
      if (request.expiresAt.getTime() > now.getTime()) continue;
      this.requests.delete(id);
      removed += 1;
    }
    return removed;
  }

  private getPendingOrThrow(id: string): StoredRequest {
    this.deleteExpired();
    const request = this.requests.get(id);
    if (request === undefined) throw new QueueRequestError(409, "secret_request_gone", "scan approval request is gone: declined, expired or never registered");
    if (request.state !== "pending") throw new QueueRequestError(409, "secret_request_not_pending", "scan approval request is already approved");
    return request;
  }

  // the agent is no part of the match → a second agent's same tuple returns the first agent's request
  private findRepeat(input: SecretRequestInput): string | null {
    const hashes = input.lines.map((line) => line.hash);
    for (const request of this.requests.values()) {
      const isRepeat = request.state === "pending" && request.sessionId === input.sessionId && request.path === input.path && request.rule === input.rule;
      if (isRepeat && isSameSet(request.hashes, hashes)) return request.id;
    }
    return null;
  }

  private assertCapacity(sessionId: string): void {
    const sessionCount = [...this.requests.values()].filter((request) => request.sessionId === sessionId).length;
    if (sessionCount >= SECRET_REQUEST_LIMIT.SESSION_REQUESTS || this.requests.size >= SECRET_REQUEST_LIMIT.MACHINE_REQUESTS) {
      throw new QueueRequestError(429, "secret_request_cap", "scan approval requests are at their session or machine cap");
    }
  }
}

/** The monitor process's one store → every route, the answer write and the sweep share it. */
export const secretRequests = new SecretRequestRepository();

/**
 * The one canonical line hash; the hook implements the same spec, both pinned by test/fixtures/scan-approval-vectors.json.
 * - a line: the raw bytes between LF separators of the field the hook scans (content for Write, new_string for Edit)
 * - a CR stays part of its line · no trailing newline added · no Unicode normalization
 * - SHA-256 over the line's UTF-8 bytes → lowercase hex
 */
export function getLineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

/**
 * The owner's view of one captured line, computed once here so the Mac and the phone show the same thing.
 * - segments: the whole line, never truncated; invisible and look-alike code points and trailing spaces as marks
 * - value: the assigned value's cue (literal first when any literal is present), code-point length and classes
 */
export function getLineDisplay(line: string): LineDisplay {
  return { segments: getSegments(line), value: getLineValue(line) };
}

// controls, lone surrogates, separators, every space but U+0020, combining marks, private-use, unassigned, the blank
// glyphs braille blank + musical null notehead, + the format and default-ignorable set
const MARKED = new RegExp(
  String.raw`[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Mn}\p{Me}\p{Co}\p{Cn}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u2800\u{1D159}]|${INVISIBLE_CHARACTER.source}`,
  "u",
);
const LONE_SURROGATE = /\p{Cs}/u;
const QUOTES = new Set(["\"", "'", "`"]);
const CUE_ORDER: readonly ValueCue[] = ["literal", "identifier", "member", "environment"];
const VALUE_CLASS_ORDER: readonly ValueClass[] = ["lower", "upper", "digit", "space", "symbol", "non-ascii"];
// look-alike-prone and widely written scripts, in class order; Common = shared symbols, Inherited = combining marks
const KEY_SCRIPTS = [
  ["latin", /\p{Script=Latin}/u], ["greek", /\p{Script=Greek}/u], ["cyrillic", /\p{Script=Cyrillic}/u],
  ["armenian", /\p{Script=Armenian}/u], ["georgian", /\p{Script=Georgian}/u], ["cherokee", /\p{Script=Cherokee}/u],
  ["coptic", /\p{Script=Coptic}/u], ["hebrew", /\p{Script=Hebrew}/u], ["arabic", /\p{Script=Arabic}/u],
  ["devanagari", /\p{Script=Devanagari}/u], ["thai", /\p{Script=Thai}/u], ["hangul", /\p{Script=Hangul}/u],
  ["han", /\p{Script=Han}/u], ["hiragana", /\p{Script=Hiragana}/u], ["katakana", /\p{Script=Katakana}/u],
  ["common", /\p{Script=Common}/u], ["inherited", /\p{Script=Inherited}/u],
] as const;
const KEY_SCRIPT_ORDER: readonly KeyScript[] = [...KEY_SCRIPTS.map(([name]) => name), "other"];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MEMBER = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/u;
const SHELL_VARIABLE = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/u;
const ENVIRONMENT_REFERENCES = [
  SHELL_VARIABLE,
  /^(["'`])\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})\1$/u,
  /^(?:process\.env|import\.meta\.env)(?:\.[A-Za-z_$][\w$]*|\[\s*(["'`])[A-Za-z_]\w*\1\s*\])$/u,
  /^(?:os\.environ|ENV)\[\s*(["'])[A-Za-z_]\w*\1\s*\]$/u,
  /^(?:os\.getenv|os\.environ\.get|System\.getenv|Deno\.env\.get)\(\s*(["'])[A-Za-z_]\w*\1\s*\)$/u,
];
// a quoted name right after one of these openers is an environment key, not a literal
const ENVIRONMENT_KEY_OPENER = /(?:\benviron|\benv|\bENV)\s*\[\s*$|(?:\bgetenv|\benviron\.get|\benv\.get)\s*\(\s*$/u;

function assertRequestInput(input: SecretRequestInput): void {
  if (input.rule !== APPROVABLE_RULE) throw new QueueRequestError(400, "secret_rule_not_approvable", `only ${APPROVABLE_RULE} refusals can be approved`);
  assertFieldLengths(input);
  const bytes = input.lines.reduce((sum, line) => sum + Buffer.byteLength(line.text, "utf8"), 0);
  const { REQUEST_LINES, REQUEST_BYTES } = SECRET_REQUEST_LIMIT;
  if (input.lines.length === 0 || input.lines.length > REQUEST_LINES || bytes > REQUEST_BYTES) {
    throw new QueueRequestError(422, "secret_request_size", `a scan approval request holds 1 to ${REQUEST_LINES} lines and at most ${REQUEST_BYTES} bytes`);
  }
  for (const line of input.lines) {
    if (line.text.includes("\n") || LONE_SURROGATE.test(line.text)) throw new QueueRequestError(400, "secret_line_malformed", "a captured line holds an LF or a lone surrogate");
    if (getLineHash(line.text) !== line.hash) throw new QueueRequestError(400, "secret_line_hash_mismatch", "a captured line does not hash to the hash sent with it");
  }
}

function assertFieldLengths(input: SecretRequestInput): void {
  const { FIELD_LENGTH } = SECRET_REQUEST_LIMIT;
  const fields = [
    [input.sessionId, FIELD_LENGTH.SESSION_ID],
    [input.path, FIELD_LENGTH.PATH],
    [input.agent.id, FIELD_LENGTH.AGENT_ID],
    [input.agent.type, FIELD_LENGTH.AGENT_TYPE],
  ] as const;
  if (fields.some(([value, max]) => value.length > max)) {
    throw new QueueRequestError(400, "secret_request_field_length", "a session id, path, agent id or agent type is past its length cap");
  }
}

function isApprovedFor(request: StoredRequest, write: SecretWrite): boolean {
  const isSameTuple = request.sessionId === write.sessionId && request.path === write.path && request.rule === write.rule;
  return request.state === "approved" && isSameTuple && isSameSet(request.hashes, write.hashes);
}

function isSameSet(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return leftSet.size === rightSet.size && [...leftSet].every((hash) => rightSet.has(hash));
}

function getSegments(line: string): DisplaySegment[] {
  const trailingStart = line.replace(/ +$/u, "").length;
  const segments: DisplaySegment[] = [];
  let text = "";
  let offset = 0;
  for (const char of line) {
    const isMarked = offset >= trailingStart || MARKED.test(char);
    offset += char.length;
    if (!isMarked) {
      text += char;
      continue;
    }
    if (text !== "") segments.push({ text });
    text = "";
    segments.push({ mark: getMark(char) });
  }
  if (text !== "") segments.push({ text });
  return segments;
}

function getMark(char: string): string {
  // char comes from string iteration → never empty
  const codePoint = char.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function getLineValue(line: string): LineValue {
  const { cue, text } = getCuedValue(line);
  const found = new Set([...text].map(getValueClass));
  const classes: LineClass[] = VALUE_CLASS_ORDER.filter((name) => found.has(name));
  return { cue, length: [...text].length, classes: [...classes, ...getKeyClasses(line, text)] };
}

function getCuedValue(line: string): { cue: ValueCue; text: string } {
  const assigned = getAssignedText(line);
  if (assigned === null) return { cue: "literal", text: line.trim() };
  const literal = findQuotedLiteral(assigned);
  if (literal !== null) return { cue: "literal", text: literal };
  // a bare word is a literal in dotenv, YAML and INI → a reference cue needs a code terminator or declaration
  const hasCodeEvidence = /[;,]\s*$/u.test(line) || /^\s*(?:const|let|var|val)\s/u.test(line);
  const values = getAssignedValues(assigned).map((value) => ({ value, cue: getReferenceCue(value, hasCodeEvidence) }));
  const first = values.sort((left, right) => CUE_ORDER.indexOf(left.cue) - CUE_ORDER.indexOf(right.cue))[0];
  return first === undefined ? { cue: "literal", text: assigned.trim() } : { cue: first.cue, text: first.value };
}

// the value is a substring of the line → removing any occurrence of it leaves the same characters
function getKeyClasses(line: string, value: string): LineClass[] {
  const found = new Set([...line.replace(value, "")].filter((char) => char.charCodeAt(0) > 0x7f).map(getKeyScript));
  return KEY_SCRIPT_ORDER.filter((name) => found.has(name)).map((name) => `key: ${name}` as const);
}

function getKeyScript(char: string): KeyScript {
  return KEY_SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0] ?? "other";
}

// text after the first `=` or `:` outside quotes; comparison, arrow and scope operators are skipped
function getAssignedText(line: string): string | null {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (QUOTES.has(char)) {
      quote = char;
    } else if (isAssignmentAt(line, index)) {
      return line.slice(line[index + 1] === "=" ? index + 2 : index + 1);
    }
  }
  return null;
}

function isAssignmentAt(line: string, index: number): boolean {
  const [previous, char, next] = [line[index - 1], line[index], line[index + 1]];
  if (char === ":") return previous !== ":" && next !== ":";
  return char === "=" && next !== "=" && next !== ">" && previous !== "=" && previous !== "!" && previous !== "<" && previous !== ">";
}

function findQuotedLiteral(text: string): string | null {
  for (const quoted of getQuotedStrings(text)) {
    const isEnvironmentKey = ENVIRONMENT_KEY_OPENER.test(text.slice(0, quoted.start)) && IDENTIFIER.test(quoted.content);
    if (!isEnvironmentKey && !SHELL_VARIABLE.test(quoted.content)) return quoted.content;
  }
  return null;
}

// each quoted run with its opening offset; escapes stay raw, an unterminated quote runs to the end
function getQuotedStrings(text: string): Array<{ start: number; content: string }> {
  const found: Array<{ start: number; content: string }> = [];
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (QUOTES.has(char)) start = index;
    } else if (char === "\\") {
      index += 1;
    } else if (char === text[start]) {
      found.push({ start, content: text.slice(start + 1, index) });
      start = -1;
    }
  }
  if (start >= 0) found.push({ start, content: text.slice(start + 1) });
  return found;
}

// one value, or each value of a one-level object (`{ a: x, b: y }`)
function getAssignedValues(text: string): string[] {
  const body = text.trim().replace(/[;,]+$/u, "").trim();
  const inner = body.startsWith("{") && body.endsWith("}") ? body.slice(1, -1) : body;
  return inner
    .split(",")
    .map((part) => part.slice(part.indexOf(":") + 1).trim())
    .filter((part) => part !== "");
}

function getReferenceCue(value: string, hasCodeEvidence: boolean): ValueCue {
  if (ENVIRONMENT_REFERENCES.some((pattern) => pattern.test(value))) return "environment";
  if (!hasCodeEvidence) return "literal";
  if (IDENTIFIER.test(value)) return "identifier";
  return MEMBER.test(value) ? "member" : "literal";
}

function getValueClass(char: string): ValueClass {
  if (/[a-z]/u.test(char)) return "lower";
  if (/[A-Z]/u.test(char)) return "upper";
  if (/[0-9]/u.test(char)) return "digit";
  if (/[\t\n\v\f\r ]/u.test(char)) return "space";
  return char.charCodeAt(0) <= 0x7f ? "symbol" : "non-ascii";
}
